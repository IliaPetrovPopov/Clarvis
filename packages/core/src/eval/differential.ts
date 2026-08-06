import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootAndVerify } from "../boot.ts";
import { runAxisSpecs } from "../runner.ts";
import type { Axis, Finding, Profile } from "../types.ts";

/**
 * Differential testing: using the previous version as the oracle.
 *
 * Everything else in this product hinges on finding a human-written requirement
 * to cite. That is why research is load-bearing, why a contested requirement
 * kills a finding, and why most things stop at PLAUSIBLE.
 *
 * For regressions, none of that is necessary. Run the same spec against the
 * base ref and against the branch: if it passes on base and fails on head, the
 * behaviour changed, and the old version is the oracle. No requirement, no
 * entailment check, no ceiling.
 *
 * That also fixes the failure the tier system otherwise has no answer for -
 * a real regression in code nobody ever wrote a requirement for.
 *
 * The classification is the whole value, and it is deterministic:
 *
 *   base pass, head fail  -> REGRESSION. Caused by this change.
 *   base fail, head fail  -> pre-existing. Real, but not this branch's doing.
 *   base fail, head pass  -> fixed by this change.
 *   base pass, head pass  -> nothing.
 *
 * A pre-existing failure being reported as a regression is the mistake that
 * matters here: it sends someone hunting through a diff that never touched it.
 */

export type Verdict = "regression" | "pre-existing" | "fixed" | "unchanged" | "inconclusive";

export interface TestOutcome {
  title: string;
  passed: boolean;
  error?: string;
}

export interface DifferentialResult {
  title: string;
  verdict: Verdict;
  base: TestOutcome | undefined;
  head: TestOutcome | undefined;
  note?: string;
}

export interface DifferentialReport {
  baseRef: string;
  results: DifferentialResult[];
  regressions: DifferentialResult[];
  preExisting: DifferentialResult[];
  fixed: DifferentialResult[];
  /** Why the comparison could not be made, when it could not. */
  blockers: string[];
  notes: string[];
}

/* --------------------------------------------------------------- worktree */

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

export interface Worktree {
  dir: string;
  ref: string;
  remove: () => Promise<void>;
}

/**
 * A checkout of the base ref, beside the working tree rather than in it.
 *
 * `git worktree` instead of stashing or checking out: the working tree is never
 * touched, so nothing can be lost and the branch under test stays exactly as it
 * is. A tool that moves someone's HEAD to compare something is not one anybody
 * should run twice.
 */
export async function createWorktree(projectRoot: string, ref: string): Promise<Worktree> {
  const isRepo = await git(["rev-parse", "--git-dir"], projectRoot);
  if (!isRepo.ok) throw new Error(`${projectRoot} is not a git repository, so there is nothing to compare against.`);

  const resolved = await git(["rev-parse", "--verify", `${ref}^{commit}`], projectRoot);
  if (!resolved.ok) throw new Error(`Cannot resolve "${ref}": ${resolved.stderr.trim().slice(0, 200)}`);

  const dir = await mkdtemp(path.join(tmpdir(), "clarvis-base-"));
  const added = await git(["worktree", "add", "--detach", dir, ref], projectRoot);

  if (!added.ok) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`Could not create a worktree for "${ref}": ${added.stderr.trim().slice(0, 240)}`);
  }

  return {
    dir,
    ref: resolved.stdout.trim(),
    remove: async () => {
      // Prune through git as well as deleting: a stale worktree registration
      // makes every later attempt on the same ref fail.
      await git(["worktree", "remove", "--force", dir], projectRoot);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await git(["worktree", "prune"], projectRoot);
    },
  };
}

/* ------------------------------------------------------------- comparison */

/** Pull per-test pass/fail out of a Playwright report. */
export function outcomesFromReport(report: unknown): TestOutcome[] {
  const out: TestOutcome[] = [];

  const walk = (node: unknown): void => {
    const n = node as {
      suites?: unknown[];
      specs?: Array<{
        title?: string;
        tests?: Array<{ status?: string; results?: Array<{ error?: { message?: string } }> }>;
      }>;
    };

    for (const spec of n?.specs ?? []) {
      for (const t of spec.tests ?? []) {
        out.push({
          title: spec.title ?? "(untitled)",
          passed: t.status === "expected",
          error: t.results?.at(-1)?.error?.message,
        });
      }
    }
    for (const child of n?.suites ?? []) walk(child);
  };

  walk(report);
  return out;
}

export function classify(base: TestOutcome | undefined, head: TestOutcome | undefined): {
  verdict: Verdict;
  note?: string;
} {
  // A test that only exists on one side cannot be compared. Calling that a
  // regression would blame a diff for a test that never ran against it.
  if (!base && !head) return { verdict: "inconclusive", note: "Ran on neither side." };
  if (!base) {
    return { verdict: "inconclusive", note: "Did not run against the base, so nothing can be concluded." };
  }
  if (!head) {
    return { verdict: "inconclusive", note: "Did not run against the branch, so nothing can be concluded." };
  }

  if (base.passed && !head.passed) return { verdict: "regression" };
  if (!base.passed && !head.passed) {
    return { verdict: "pre-existing", note: "Also failed before this change. Real, but not caused by it." };
  }
  if (!base.passed && head.passed) return { verdict: "fixed" };
  return { verdict: "unchanged" };
}

export interface DifferentialOptions {
  projectRoot: string;
  baseRef: string;
  profile: Profile;
  specDir: string;
  axisKey: Axis;
  outputDir: string;
  /** Port for the base instance. Must differ from the branch's. */
  basePort?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Run one axis' specs against both versions and compare.
 *
 * The specs are the branch's, run unchanged against both. Re-authoring them for
 * the base would compare two different tests and prove nothing.
 */
export async function runDifferential(opts: DifferentialOptions): Promise<DifferentialReport> {
  const log = opts.log ?? (() => {});
  const blockers: string[] = [];
  const notes: string[] = [];

  const readOutcomes = async (reportPath: string): Promise<TestOutcome[]> => {
    try {
      return outcomesFromReport(JSON.parse(await readFile(reportPath, "utf8")) as unknown);
    } catch {
      return [];
    }
  };

  /* --- the branch, as it is ------------------------------------------------ */

  log("running against the branch");
  const headRun = await runAxisSpecs({
    axisKey: opts.axisKey,
    profile: opts.profile,
    specDir: opts.specDir,
    outputDir: path.join(opts.outputDir, "head"),
    baseURL: opts.profile.boot.url,
    timeoutMs: opts.timeoutMs,
  });
  const headOutcomes = await readOutcomes(headRun.reportPath);

  if (!headOutcomes.length) {
    blockers.push(`No tests ran against the branch (exit ${headRun.exitCode}). Nothing can be compared.`);
    return { baseRef: opts.baseRef, results: [], regressions: [], preExisting: [], fixed: [], blockers, notes };
  }

  /* --- the base, in a worktree -------------------------------------------- */

  let worktree: Worktree | undefined;
  let baseOutcomes: TestOutcome[] = [];

  try {
    worktree = await createWorktree(opts.projectRoot, opts.baseRef);
    log(`base ${opts.baseRef} checked out at ${worktree.dir}`);

    const basePort = opts.basePort ?? pickBasePort(opts.profile.boot.url);
    const baseUrl = withPort(opts.profile.boot.url, basePort);

    // The base runs from the worktree, on its own port, so both versions can be
    // up at once and neither can be mistaken for the other.
    const baseProfile: Profile = {
      ...opts.profile,
      project: { ...opts.profile.project, root: worktree.dir },
      boot: {
        ...opts.profile.boot,
        cwd: worktree.dir,
        url: baseUrl,
        readyCheck: undefined,
        env: { ...opts.profile.boot.env, PORT: String(basePort) },
      },
    };

    const boot = await bootAndVerify(baseProfile, { log: (l) => log(`base: ${l}`) });

    if (!boot.verified) {
      blockers.push(
        `The base version would not start: ${boot.blockers[0] ?? "no detail"}. ` +
          `Without it there is nothing to compare against, so no failure can be called a regression.`,
      );
    } else {
      try {
        const baseRun = await runAxisSpecs({
          axisKey: opts.axisKey,
          profile: baseProfile,
          specDir: opts.specDir,
          outputDir: path.join(opts.outputDir, "base"),
          baseURL: baseUrl,
          timeoutMs: opts.timeoutMs,
        });
        baseOutcomes = await readOutcomes(baseRun.reportPath);

        if (!baseOutcomes.length) {
          blockers.push(`No tests ran against the base (exit ${baseRun.exitCode}).`);
        }
      } finally {
        await boot.stop();
      }
    }
  } catch (e) {
    blockers.push(e instanceof Error ? e.message : String(e));
  } finally {
    await worktree?.remove().catch(() => {});
  }

  /* --- compare ------------------------------------------------------------ */

  const baseByTitle = new Map(baseOutcomes.map((o) => [o.title, o]));
  const headByTitle = new Map(headOutcomes.map((o) => [o.title, o]));

  const results: DifferentialResult[] = [...new Set([...baseByTitle.keys(), ...headByTitle.keys()])].map(
    (title) => {
      const base = baseByTitle.get(title);
      const head = headByTitle.get(title);
      const { verdict, note } = classify(base, head);
      return { title, verdict, base, head, note };
    },
  );

  const regressions = results.filter((r) => r.verdict === "regression");
  const preExisting = results.filter((r) => r.verdict === "pre-existing");
  const fixed = results.filter((r) => r.verdict === "fixed");

  if (blockers.length && headOutcomes.length) {
    notes.push(
      "The base could not be compared, so every failure below is unclassified: it may or may not be " +
        "caused by this change.",
    );
  }
  if (preExisting.length) {
    notes.push(`${preExisting.length} failure(s) also fail on ${opts.baseRef}. Not caused by this change.`);
  }
  if (fixed.length) {
    notes.push(`${fixed.length} test(s) fail on ${opts.baseRef} and pass here. This change fixed them.`);
  }

  return { baseRef: opts.baseRef, results, regressions, preExisting, fixed, blockers, notes };
}

/** A port that will not collide with the branch's instance. */
export function pickBasePort(url: string): number {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    // Deterministic and far enough away that a neighbouring service is unlikely.
    return port + 1000 > 65_535 ? port - 1000 : port + 1000;
  } catch {
    return 4599;
  }
}

export function withPort(url: string, port: number): string {
  try {
    const parsed = new URL(url);
    parsed.port = String(port);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return `http://localhost:${port}`;
  }
}

/**
 * Turn regressions into findings.
 *
 * These carry `prior-run` as their oracle - a type the schema has always had
 * and nothing has ever used. It is a real oracle: the previous version of the
 * software, which is often the only thing anyone ever wrote down about what the
 * behaviour should be.
 */
export function findingsFromDifferential(
  report: DifferentialReport,
  opts: { axis: Axis; runId: string; specFile: string },
): Finding[] {
  return report.regressions.map((r, i) => ({
    id: `${opts.runId}-${opts.axis}-diff-${i + 1}`,
    axis: opts.axis,
    title: r.title,
    severity: "high",
    // A behaviour change proven against the previous version, twice observed.
    // Triage still has to reproduce it before it is confirmed.
    tier: "PLAUSIBLE",
    tierReason: `Passed on ${report.baseRef} and fails here. Triage has not reproduced it yet.`,
    oracle: {
      type: "prior-run",
      citation: `${report.baseRef} (this test passed there)`,
    },
    expected: `The behaviour at ${report.baseRef}, where this test passed.`,
    actual: (r.head?.error ?? "Failed on this branch.").slice(0, 1200),
    evidence: { specFile: opts.specFile },
    foundBy: "differential",
    createdAt: new Date().toISOString(),
    tracker: { status: "none" },
  }));
}

export function describeDifferential(report: DifferentialReport): string[] {
  const lines: string[] = [];

  lines.push(
    `${report.regressions.length} regression(s) against ${report.baseRef}` +
      `, ${report.preExisting.length} pre-existing, ${report.fixed.length} fixed`,
  );

  for (const r of report.regressions) {
    lines.push(`  REGRESSION  ${r.title.slice(0, 76)}`);
    if (r.head?.error) lines.push(`              ${r.head.error.split("\n")[0].slice(0, 84)}`);
  }
  for (const r of report.preExisting) {
    lines.push(`  pre-existing ${r.title.slice(0, 74)}`);
  }
  for (const b of report.blockers) lines.push(`  BLOCKED     ${b}`);
  for (const n of report.notes) lines.push(`  note        ${n}`);

  return lines;
}
