import { stripEmDashes } from "../text.ts";
import { decidePublish, type PublishDecision, type TrackerConfig } from "../trackerGuard.ts";
import type { Finding, Run } from "../types.ts";
import type { Budget } from "./budget.ts";
import { getAgent } from "./definitions.ts";
import { runAgent, type AgentResult, type AgentRunner } from "./runtime.ts";

/**
 * SCRIBE: turn confirmed findings into tickets a human would have written.
 *
 * Drafting and filing are deliberately separate steps, and nothing here files
 * anything. A wrong ticket on someone's board is worse than no ticket: it costs
 * a person a triage cycle, it survives long after the run that produced it, and
 * a handful of them is all it takes for a team to start ignoring the tool.
 *
 * So the shape is: an agent writes the prose, code decides whether it may ever
 * leave the machine. `decidePublish` is the gate, and it refuses unless writes
 * are explicitly enabled, the finding is CONFIRMED, a human approved that
 * specific ticket, no duplicate is suspected, the project is allow-listed and
 * the per-run cap has room.
 *
 * A draft that the gate refuses is still written to disk. Someone can read it,
 * fix it, and file it by hand - which is the normal path, not a failure.
 */

export const DRAFT_SCHEMA_VERSION = 1 as const;

export interface TicketDraft {
  findingId: string;
  /** Short, specific, and free of tool branding. */
  title: string;
  /** Markdown. What a competent engineer would need to act on it. */
  body: string;
  /** Steps as a human would retype them, not as the spec expressed them. */
  steps: string[];
  expected: string;
  actual: string;
  severity: Finding["severity"];
  labels: string[];
  /** Where the claim comes from. Copied from the finding, never authored. */
  oracle: Finding["oracle"];
  evidence: { specFile: string; tracePath?: string; screenshots?: string[] };
  /** The gate's answer for this specific draft. */
  publish: PublishDecision;
}

export interface DraftBundle {
  schemaVersion: typeof DRAFT_SCHEMA_VERSION;
  runId: string;
  draftedAt: string;
  drafts: TicketDraft[];
  /** Findings deliberately not drafted, and why. */
  skipped: Array<{ findingId: string; title: string; why: string }>;
  notes: string[];
}

interface DraftProposal {
  title?: string;
  body?: string;
  steps?: string[];
  labels?: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const s = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
};

function validateDraft(parsed: unknown): { ok: true; value: DraftProposal } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (!s(parsed.title)) return { ok: false, error: "'title' must be a short, specific summary." };
  if (!s(parsed.body)) return { ok: false, error: "'body' must be the ticket description." };
  if (!Array.isArray(parsed.steps) || !parsed.steps.length) {
    return {
      ok: false,
      error: "'steps' must list reproduction steps. A ticket nobody can reproduce will be closed unread.",
    };
  }
  return { ok: true, value: parsed as DraftProposal };
}

/**
 * Reject a title that reads like a test name rather than a bug report.
 *
 * The spec titles this reads from are written as assertions - "viewer must not
 * reach /admin" - and pasted straight into a tracker they describe the intended
 * behaviour rather than the defect, which is exactly backwards on a board where
 * everything is a problem to be fixed.
 */
export function titleReadsLikeAssertion(title: string): boolean {
  return /\b(must not|must|should not|should|stays?|remains?)\b/i.test(title);
}

export interface DispatchOptions {
  run: Run;
  runner: AgentRunner;
  budget: Budget;
  tracker: TrackerConfig;
  /** Project or space key the drafts target. */
  project: string;
  /** Per-finding human approvals. Agents cannot populate this. */
  approvals?: Record<string, string>;
  /** Findings already on the tracker, by finding id. Blocks publication. */
  knownDuplicates?: Record<string, string[]>;
  transcriptDir?: string;
  redact?: (text: string) => string;
  now?: Date;
}

export interface DispatchReport {
  agentRuns: Array<AgentResult<unknown>>;
  usdEstimate: number;
  /** Drafts the gate would let through right now. */
  publishable: number;
  warnings: string[];
}

export async function draftTickets(
  opts: DispatchOptions,
): Promise<{ bundle: DraftBundle; report: DispatchReport }> {
  const agentRuns: Array<AgentResult<unknown>> = [];
  const warnings: string[] = [];
  const drafts: TicketDraft[] = [];
  const skipped: DraftBundle["skipped"] = [];
  const notes: string[] = [];
  const now = opts.now ?? new Date();

  // Only CONFIRMED findings are drafted at all. Anything weaker would be a
  // ticket whose first question - "how do you know this is wrong?" - has no
  // answer, and drafting it wastes the reviewer's time either way.
  for (const finding of opts.run.findings) {
    if (finding.tier !== "CONFIRMED") {
      skipped.push({
        findingId: finding.id,
        title: finding.title,
        why: `Tier is ${finding.tier}, not CONFIRMED. Only confirmed findings are drafted.`,
      });
    }
  }

  const candidates = opts.run.findings.filter((f) => f.tier === "CONFIRMED");

  if (!candidates.length) {
    notes.push(
      opts.run.findings.length
        ? `No finding reached CONFIRMED, so nothing was drafted. ${opts.run.findings.length} finding(s) are ` +
          `waiting on a stronger oracle - run research so they can cite something human-authored.`
        : "The run produced no findings, so there is nothing to draft.",
    );
  }

  for (const finding of candidates) {
    const result = await runAgent<DraftProposal>({
      runner: opts.runner,
      definition: getAgent("scribe-draft"),
      prompt: [
        `SEVERITY: ${finding.severity}`,
        `AXIS: ${finding.axis}`,
        finding.route ? `ROUTE: ${finding.route}` : "",
        finding.role ? `ROLE: ${finding.role}` : "",
        "",
        `WHAT WAS EXPECTED: ${finding.expected}`,
        `WHAT HAPPENED: ${finding.actual}`,
        "",
        finding.oracle.quote
          ? `THE SOURCE THAT SAYS THIS IS WRONG (${finding.oracle.citation ?? "cited"}):\n${finding.oracle.quote}`
          : "NO CITED SOURCE. Do not assert that this violates a requirement.",
        "",
        finding.steps?.length ? `STEPS RECORDED BY THE SPEC:\n${finding.steps.join("\n")}` : "",
        `REPRODUCED: ${finding.determinism?.failures ?? "?"} of ${finding.determinism?.runs ?? "?"} isolated re-runs.`,
        "",
        "Return JSON: { title, body, steps[], labels[] }.",
      ]
        .filter(Boolean)
        .join("\n"),
      validate: validateDraft,
      budget: opts.budget,
      agentId: `scribe-draft-${finding.id}`,
      transcriptDir: opts.transcriptDir,
      redact: opts.redact,
    });
    agentRuns.push(result as AgentResult<unknown>);

    if (result.status !== "ok" || !result.data) {
      skipped.push({
        findingId: finding.id,
        title: finding.title,
        why: `Drafting did not complete (${result.status}).`,
      });
      continue;
    }

    // House style is applied to anything that leaves the machine, and a ticket
    // is the most public thing this product produces.
    const title = stripEmDashes(s(result.data.title)!);
    if (titleReadsLikeAssertion(title)) {
      warnings.push(
        `Draft for ${finding.id} is titled like a test assertion ("${title.slice(0, 60)}"). ` +
          `On a board, that reads as the intended behaviour rather than the defect.`,
      );
    }

    const decision = decidePublish(
      opts.tracker,
      {
        finding,
        project: opts.project,
        approvedBy: opts.approvals?.[finding.id],
        possibleDuplicates: opts.knownDuplicates?.[finding.id],
      },
      drafts.filter((d) => d.publish.allowed).length,
    );

    drafts.push({
      findingId: finding.id,
      title,
      body: stripEmDashes(s(result.data.body)!),
      steps: (result.data.steps ?? [])
        .map((x) => s(x))
        .filter((x): x is string => Boolean(x))
        .map(stripEmDashes),
      expected: finding.expected,
      actual: finding.actual,
      severity: finding.severity,
      labels: [
        ...new Set([
          ...(result.data.labels ?? []).map((l) => s(l)).filter((l): l is string => Boolean(l)),
          opts.tracker.agentLabel ?? "clarvis",
        ]),
      ],
      // Copied, never authored: the oracle is the finding's evidence and an
      // agent restating it would be laundering it.
      oracle: finding.oracle,
      evidence: {
        specFile: finding.evidence.specFile,
        tracePath: finding.evidence.tracePath,
        screenshots: finding.evidence.screenshots,
      },
      publish: decision,
    });
  }

  const publishable = drafts.filter((d) => d.publish.allowed).length;

  if (drafts.length && !publishable) {
    const reasons = [...new Set(drafts.map((d) => d.publish.refusal).filter(Boolean))];
    notes.push(
      `${drafts.length} draft(s) written, none publishable (${reasons.join(", ")}). ` +
        `They are on disk for a human to read and file by hand.`,
    );
  }

  return {
    bundle: {
      schemaVersion: DRAFT_SCHEMA_VERSION,
      runId: opts.run.runId,
      draftedAt: now.toISOString(),
      drafts,
      skipped,
      notes,
    },
    report: {
      agentRuns,
      usdEstimate: agentRuns.reduce((sum, r) => sum + r.usdEstimate, 0),
      publishable,
      warnings,
    },
  };
}

/** Markdown for a human to paste, when the gate refuses and they file it by hand. */
export function renderDraft(draft: TicketDraft): string {
  return [
    `# ${draft.title}`,
    "",
    draft.body,
    "",
    "## Steps to reproduce",
    ...draft.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Expected",
    draft.expected,
    "",
    "## Actual",
    draft.actual,
    "",
    "## How we know this is wrong",
    draft.oracle.quote
      ? `> ${draft.oracle.quote}\n\n${draft.oracle.citation ?? ""} (${draft.oracle.type})`
      : `No human-authored source. Basis: ${draft.oracle.type}.`,
    "",
    "## Evidence",
    `- spec: \`${draft.evidence.specFile}\``,
    draft.evidence.tracePath ? `- trace: \`${draft.evidence.tracePath}\`` : "",
    ...(draft.evidence.screenshots ?? []).map((s) => `- screenshot: \`${s}\``),
  ]
    .filter(Boolean)
    .join("\n");
}
