import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureContext } from "../context.ts";
import { runAxisSpecs, parsePlaywrightReport } from "../runner.ts";
import type { Finding, Profile, Tier } from "../types.ts";
import type { Budget } from "./budget.ts";
import { getAgent } from "./definitions.ts";
import { runAgent, type AgentResult, type AgentRunner } from "./runtime.ts";

/**
 * Triage: try to make each finding go away.
 *
 * A single red test is evidence, not a verdict. Two things stand between one and
 * a CONFIRMED finding, and only one of them involves a model:
 *
 *   1. Re-run the failing test on its own, several times, in fresh processes.
 *      This is code. It answers "is it deterministic" with a count, which is
 *      the only honest way to answer it.
 *   2. Ask whether the fault is in the application or in the spec that tested
 *      it. This needs judgement, so it is an agent - one that did not write the
 *      spec and has no stake in the finding being real.
 *
 * A wrong selector is a bug in the test. Filing it as a product bug is the
 * fastest way to make a team stop reading the reports, so the second check
 * matters as much as the first.
 */

export interface TriageOutcome {
  finding: Finding;
  runs: number;
  failures: number;
  verdict: "deterministic" | "flaky" | "not-reproduced";
  /** Where the fault lies, per the triage agent. */
  fault?: "application" | "spec" | "environment" | "unclear";
  reason?: string;
  /** Artifacts triage opened beyond the spec itself. */
  inspected?: string[];
  tierBefore: Tier;
  tierAfter: Tier;
}

interface TriageJudgement {
  fault?: string;
  reason?: string;
  confidence?: string;
  /** Files triage says it opened. Its own claim, and checked as such. */
  inspected?: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function validateTriage(parsed: unknown): { ok: true; value: TriageJudgement } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (typeof parsed.fault !== "string") {
    return { ok: false, error: "'fault' must be one of: application, spec, environment, unclear." };
  }
  if (typeof parsed.reason !== "string" || !parsed.reason.trim()) {
    return { ok: false, error: "'reason' must explain the judgement." };
  }
  return { ok: true, value: parsed as TriageJudgement };
}

const FAULTS = new Set(["application", "spec", "environment", "unclear"]);

/**
 * Promotion is deterministic and deliberately hard.
 *
 * CONFIRMED means: it happens every time, the fault is in the product, and
 * something written by a human says it should not. Miss any one of those and it
 * stays PLAUSIBLE - a tier that still gets read, but cannot be auto-published
 * to a tracker.
 */
export function decideTier(input: {
  verdict: TriageOutcome["verdict"];
  fault?: TriageOutcome["fault"];
  oracleType: Finding["oracle"]["type"];
  /** Whether triage had artifacts to inspect. False blocks a DISCARD. */
  evidenceAvailable?: boolean;
}): { tier: Tier; reason: string } {
  if (input.verdict === "not-reproduced") {
    return {
      tier: "DISCARDED",
      reason: "Did not reproduce on any re-run. Kept for the record, not reported as a defect.",
    };
  }

  if (input.fault === "spec") {
    // Discarding is the only irreversible verdict here, so it requires that
    // triage actually had something to look at. A live run discarded a real
    // responsive bug on reasoning that ended "no trace, no logs, no screenshot,
    // and no application markup were provided" - the judgement was careful and
    // the conclusion was wrong, because it was made blind. A blind call becomes
    // a QUESTION, which keeps the finding visible and puts a human on it.
    if (input.evidenceAvailable === false) {
      return {
        tier: "QUESTION",
        reason:
          "Triage believes the fault is in the test, but had no trace, screenshot or artifacts to " +
          "check that against. Not discarded on a blind judgement - a human should look.",
      };
    }
    return {
      tier: "DISCARDED",
      reason: "The fault is in the test, not the product. Filing it as a bug would be a false report.",
    };
  }

  if (input.fault === "environment") {
    return {
      tier: "QUESTION",
      reason: "Attributed to the environment rather than the product. Needs a human to say which.",
    };
  }

  if (input.verdict === "flaky") {
    return {
      tier: "PLAUSIBLE",
      reason: "Intermittent. Real often enough to report, not consistent enough to confirm.",
    };
  }

  const strongOracle =
    input.oracleType === "spec" ||
    input.oracleType === "acceptance-criteria" ||
    input.oracleType === "visible-label" ||
    input.oracleType === "i18n-key";

  if (!strongOracle) {
    return {
      tier: "PLAUSIBLE",
      reason:
        `Reproduces every time, but its only oracle is ${input.oracleType} - nothing written by a ` +
        `human says this is wrong. Run DOSSIER to raise the ceiling.`,
    };
  }

  if (input.fault === "unclear") {
    return {
      tier: "PLAUSIBLE",
      reason: "Reproduces every time, but triage could not place the fault.",
    };
  }

  return {
    tier: "CONFIRMED",
    reason: "Reproduces on every re-run, the fault is in the application, and a cited source says it should not.",
  };
}

export interface TriageOptions {
  findings: Finding[];
  profile: Profile;
  specDir: string;
  outputDir: string;
  runner: AgentRunner;
  budget: Budget;
  context?: FeatureContext;
  /** Re-runs per finding. Odd numbers avoid ties. */
  attempts?: number;
  /**
   * Findings triaged at once.
   *
   * Triage dominates a run's wall-clock and its plan usage: every finding gets
   * three fresh Playwright processes. Running them serially was never a
   * requirement - it predates `Budget.reserve`, which debits before any await
   * and so holds the ceiling however many run together.
   *
   * Bounded rather than unlimited: each slot is a browser, and enough of them
   * at once will starve the very application being tested and turn real
   * failures into timeouts.
   */
  concurrency?: number;
  transcriptDir?: string;
  redact?: (text: string) => string;
  log?: (line: string) => void;
}

export async function triageFindings(opts: TriageOptions): Promise<{
  outcomes: TriageOutcome[];
  agentRuns: Array<AgentResult<unknown>>;
  usdEstimate: number;
}> {
  const attempts = opts.attempts ?? 3;
  const outcomes: TriageOutcome[] = [];
  const agentRuns: Array<AgentResult<unknown>> = [];
  const log = opts.log ?? (() => {});

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, opts.findings.length || 1));

  // Findings are independent: each re-runs one test in its own process against
  // an app that is already up. Results are collected by index so the report
  // reads in the same order however they finish.
  const ordered: Array<TriageOutcome | undefined> = new Array(opts.findings.length).fill(undefined);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= opts.findings.length) return;
      ordered[i] = await triageOne(opts.findings[i], i);
    }
  };

  const triageOne = async (finding: Finding, i: number): Promise<TriageOutcome> => {
    let failures = 0;

    // Fresh process each time. Re-running in the same process would share
    // browser state, which is the most common cause of a failure that only
    // happens once.
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const outDir = path.join(opts.outputDir, "triage", `${finding.id}-${attempt}`);
      const outcome = await runAxisSpecs({
        axisKey: finding.axis,
        profile: opts.profile,
        specDir: opts.specDir,
        specFiles: [path.basename(finding.evidence.specFile)],
        outputDir: outDir,
        baseURL: opts.profile.boot.url,
        grep: finding.title,
      });

      let ran = 0;
      try {
        const results = parsePlaywrightReport(
          JSON.parse(await readFile(outcome.reportPath, "utf8")) as unknown,
        );
        ran = (results.passed ?? 0) + (results.failed ?? 0) + (results.flaky ?? 0);
        if ((results.failed ?? 0) > 0 || (results.flaky ?? 0) > 0) failures++;
      } catch {
        /* an unreadable report is not a reproduction */
      }

      // Matching nothing is not the same as passing. Without this, an escaped
      // title that fails to match reads as "did not reproduce" and quietly
      // discards a real finding.
      if (ran === 0) {
        log(`triage ${finding.id}: re-run ${attempt} executed 0 tests - treating as inconclusive`);
        failures = -1;
        break;
      }
    }

    if (failures === -1) {
      return {
        finding,
        runs: attempts,
        failures: 0,
        verdict: "flaky",
        fault: "unclear",
        reason: "Could not re-run the failing test in isolation, so it was neither confirmed nor cleared.",
        tierBefore: finding.tier,
        tierAfter: "PLAUSIBLE",
      };
    }

    const verdict: TriageOutcome["verdict"] =
      failures === 0 ? "not-reproduced" : failures === attempts ? "deterministic" : "flaky";

    log(`triage ${finding.id}: ${failures}/${attempts} - ${verdict}`);

    // A failure that never came back needs no judgement about where it lives.
    let fault: TriageOutcome["fault"] | undefined;
    let reason: string | undefined;
    let inspected: string[] = [];

    if (verdict !== "not-reproduced") {
      const spec = await readFile(finding.evidence.specFile, "utf8").catch(() => "");

      // Artifacts are what separate a judgement from a guess. Paths are given
      // rather than contents: a trace is a zip and a screenshot is a PNG, and
      // triage has Read and Glob to open what it decides it needs.
      const artifacts = [
        finding.evidence.tracePath && `  trace:      ${finding.evidence.tracePath}`,
        ...(finding.evidence.screenshots ?? []).map((s) => `  screenshot: ${s}`),
        finding.evidence.consoleLogPath && `  console:    ${finding.evidence.consoleLogPath}`,
        `  artifacts:  ${path.join(opts.outputDir, finding.axis)}`,
        `  the app:    ${opts.profile.project.root}`,
      ].filter(Boolean) as string[];

      const judgement = await runAgent<TriageJudgement>({
        runner: opts.runner,
        definition: getAgent("crucible-triage"),
        prompt: [
          `FINDING: ${finding.title}`,
          `AXIS: ${finding.axis}`,
          `EXPECTED: ${finding.expected}`,
          `ACTUAL: ${finding.actual}`,
          `REPRODUCED: ${failures} of ${attempts} isolated re-runs.`,
          finding.oracle.quote ? `CITED SOURCE: ${finding.oracle.quote}` : "CITED SOURCE: none.",
          "",
          "ARTIFACTS AND SOURCES you can open with Read and Glob:",
          ...artifacts,
          "",
          "Read the application's own markup, CSS or handlers before deciding the",
          "fault is in the test. The behaviour is what settles it, not the assertion.",
          "",
          "THE SPEC THAT PRODUCED IT:",
          spec.slice(0, 20_000),
          "",
          `Return JSON: { fault, reason, confidence, inspected[] }. fault is one of: application, spec, environment, unclear. 'inspected' lists the files you actually opened.`,
        ].join("\n"),
        validate: validateTriage,
        budget: opts.budget,
        agentId: `crucible-triage-${i + 1}`,
        transcriptDir: opts.transcriptDir,
        redact: opts.redact,
      });
      agentRuns.push(judgement as AgentResult<unknown>);

      if (judgement.status === "ok" && judgement.data) {
        const claimed = String(judgement.data.fault).toLowerCase();
        fault = (FAULTS.has(claimed) ? claimed : "unclear") as TriageOutcome["fault"];
        reason = judgement.data.reason;
        // Anything beyond the spec file counts as evidence. Opening only the
        // spec is exactly the blind judgement that must not discard.
        inspected = (judgement.data.inspected ?? []).filter(
          (f): f is string => typeof f === "string" && !f.endsWith(path.basename(finding.evidence.specFile)),
        );
      } else {
        // Triage failing does not get to promote or discard anything.
        fault = "unclear";
        reason = `Triage did not complete (${judgement.status}).`;
      }
    }

    const decided = decideTier({
      verdict,
      fault,
      oracleType: finding.oracle.type,
      evidenceAvailable: inspected.length > 0,
    });

    // Captured before the mutation below, or every outcome would report the
    // tier as unchanged.
    const tierBefore = finding.tier;

    // The finding object carries the outcome, so a run written to disk records
    // what triage decided and why.
    finding.tier = decided.tier;
    finding.tierReason = reason ? `${decided.reason} ${reason}` : decided.reason;
    finding.determinism = { runs: attempts, failures, verdict };
    finding.verifiedBy = `crucible-triage-${i + 1}`;

    return {
      finding,
      runs: attempts,
      failures,
      verdict,
      fault,
      reason,
      inspected,
      tierBefore,
      tierAfter: decided.tier,
    };
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  outcomes.push(...ordered.filter((o): o is TriageOutcome => Boolean(o)));

  return {
    outcomes,
    agentRuns,
    usdEstimate: agentRuns.reduce((sum, r) => sum + r.usdEstimate, 0),
  };
}
