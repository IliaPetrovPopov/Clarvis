import { decideRelease, type ReleaseOptions, type ReleaseVerdict } from "../releaseGate.ts";
import { stripEmDashes } from "../text.ts";
import type { Run } from "../types.ts";
import type { Budget } from "./budget.ts";
import { getAgent } from "./definitions.ts";
import { runAgent, type AgentResult, type AgentRunner } from "./runtime.ts";

/**
 * JUDGE: ship or hold, and the notes that go with it.
 *
 * The verdict itself is `decideRelease` - deterministic, already written, and
 * deliberately not a model's opinion. Nobody should be told "ship it" by
 * something that might be having an off day, and a rule you can read is a rule
 * you can argue with.
 *
 * The agent's job is narrower and genuinely useful: write the release notes,
 * and state the limits of the verdict in a sentence a human will actually read.
 * It is given the verdict and cannot change it, so the two can never disagree.
 *
 * The part that matters most is `notChecked`. A clean run over three routes and
 * a clean run over the whole app produce identical verdicts, and the difference
 * between them is the entire value of the signal.
 */

export const VERDICT_SCHEMA_VERSION = 1 as const;

export interface ReleaseReport {
  schemaVersion: typeof VERDICT_SCHEMA_VERSION;
  runId: string;
  decidedAt: string;
  verdict: ReleaseVerdict;
  /** One paragraph a human reads instead of the counts. */
  summary: string;
  /** Markdown, ready to paste into a release. Empty when holding. */
  notes: string;
  /** Restated plainly, because this is the part people skip. */
  limits: string[];
}

interface NotesProposal {
  summary?: string;
  notes?: string;
  limits?: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const s = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
};

function validateNotes(parsed: unknown): { ok: true; value: NotesProposal } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (!s(parsed.summary)) {
    return { ok: false, error: "'summary' must state the verdict and its main reason in a short paragraph." };
  }
  if (!Array.isArray(parsed.limits) || !parsed.limits.length) {
    return {
      ok: false,
      error:
        "'limits' must list what this verdict does NOT cover. It is never empty - a run always misses something, " +
        "and the reader needs to know what.",
    };
  }
  return { ok: true, value: parsed as NotesProposal };
}

export interface ClearanceOptions {
  run: Run;
  runner: AgentRunner;
  budget: Budget;
  release?: ReleaseOptions;
  transcriptDir?: string;
  redact?: (text: string) => string;
  now?: Date;
}

export async function decideAndDescribe(opts: ClearanceOptions): Promise<{
  report: ReleaseReport;
  agentRuns: Array<AgentResult<unknown>>;
  usdEstimate: number;
}> {
  const now = opts.now ?? new Date();
  const agentRuns: Array<AgentResult<unknown>> = [];

  // The verdict first, and from code. The agent is told what it is, never asked.
  const verdict = decideRelease(opts.run, opts.release);

  const confirmed = opts.run.findings.filter((f) => f.tier === "CONFIRMED");

  const result = await runAgent<NotesProposal>({
    runner: opts.runner,
    definition: getAgent("judge-notes"),
    prompt: [
      `THE VERDICT IS: ${verdict.decision.toUpperCase()}. This is decided and you cannot change it.`,
      "",
      "WHY:",
      ...verdict.reasons.map((r) => `  [${r.severity}] ${r.code}: ${r.detail}`),
      "",
      "COUNTS:",
      `  confirmed: ${verdict.counts.confirmedTotal} (${verdict.counts.confirmedCritical} critical, ${verdict.counts.confirmedHigh} high)`,
      `  unverified: ${verdict.counts.unverified}`,
      `  specs: ${verdict.counts.specsFailed} failed, ${verdict.counts.specsSkipped} skipped`,
      "",
      "WHAT THIS RUN DID NOT CHECK:",
      ...verdict.notChecked.map((n) => `  - ${n}`),
      "",
      confirmed.length
        ? `CONFIRMED FINDINGS:\n${confirmed.map((f) => `  [${f.severity}] ${f.title}`).join("\n")}`
        : "CONFIRMED FINDINGS: none.",
      "",
      ...(opts.run.truncation?.length
        ? ["RECORDED GAPS:", ...opts.run.truncation.slice(0, 15).map((t) => `  - ${t}`), ""]
        : []),
      "Write the summary a human reads instead of these counts, release notes if",
      "shipping, and the limits of this verdict.",
      "",
      "Return JSON: { summary, notes, limits[] }.",
    ]
      .filter(Boolean)
      .join("\n"),
    validate: validateNotes,
    budget: opts.budget,
    transcriptDir: opts.transcriptDir,
    redact: opts.redact,
  });
  agentRuns.push(result as AgentResult<unknown>);

  // A failed notes agent must not change the verdict or hide its limits, so the
  // fallback restates both from the deterministic parts.
  const summary =
    result.status === "ok" && result.data
      ? stripEmDashes(s(result.data.summary)!)
      : `${verdict.decision.toUpperCase()}: ${verdict.reasons[0]?.detail ?? "see the reasons below"}. ` +
        `(Notes could not be written: ${result.status}.)`;

  const limits =
    result.status === "ok" && result.data?.limits?.length
      ? result.data.limits.map((l) => s(l)).filter((l): l is string => Boolean(l)).map(stripEmDashes)
      : verdict.notChecked;

  return {
    report: {
      schemaVersion: VERDICT_SCHEMA_VERSION,
      runId: opts.run.runId,
      decidedAt: now.toISOString(),
      verdict,
      summary,
      // Notes are only meaningful when shipping. Writing them for a hold would
      // produce a document describing a release that is not happening.
      notes:
        verdict.decision === "ship" && result.status === "ok"
          ? stripEmDashes(s(result.data?.notes) ?? "")
          : "",
      limits,
    },
    agentRuns,
    usdEstimate: agentRuns.reduce((sum, r) => sum + r.usdEstimate, 0),
  };
}

/** The verdict as a human reads it in a terminal. */
export function describeVerdict(report: ReleaseReport): string[] {
  const lines: string[] = [];
  lines.push(`${report.verdict.decision.toUpperCase()} - ${report.summary}`);
  lines.push("");

  for (const r of report.verdict.reasons) {
    const mark = r.severity === "blocking" ? "BLOCKING" : r.severity === "warning" ? "warning " : "note    ";
    lines.push(`  ${mark} ${r.detail}`);
  }

  if (report.limits.length) {
    lines.push("");
    lines.push("  This verdict does NOT cover:");
    for (const l of report.limits) lines.push(`    - ${l}`);
  }

  return lines;
}
