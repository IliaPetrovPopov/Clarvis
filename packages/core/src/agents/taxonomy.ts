import { AXES, type Axis } from "../types.ts";
import type { BugFix } from "../eval/history.ts";
import type { Budget } from "./budget.ts";
import { getAgent } from "./definitions.ts";
import { runAgent, type AgentResult, type AgentRunner } from "./runtime.ts";

/**
 * What can go wrong in THIS project.
 *
 * The seven axes are a fixed ontology, identical for every codebase. They are
 * also the system's entire model of what can go wrong - so anything outside
 * them is not merely deprioritised, it is never looked for at all.
 *
 * Every codebase has failure modes the seven cannot express. A multi-tenant
 * system breaks along scoping boundaries, a payments system along rounding and
 * idempotency, a scheduler along timezones and clock skew. Recon learns a
 * project's boot command and its roles while learning nothing about how it
 * actually breaks.
 *
 * The evidence for a better answer is already in the repository: hundreds of
 * commits of things that did break, described by the people who fixed them.
 * This derives a taxonomy from those, and the seven become defaults rather than
 * the ontology.
 *
 * The bracketing rule holds as everywhere else. An agent may name and group the
 * themes it sees in real commit messages; it may not invent a failure mode the
 * history does not show, and every theme it proposes carries the commits it was
 * drawn from so a human can check.
 */

export const TAXONOMY_SCHEMA_VERSION = 1 as const;

export interface DerivedAxis {
  /** Stable key. Slug form, so it can name a spec file. */
  key: string;
  title: string;
  /** What a tester should look for. Written to be handed to a spec author. */
  brief: string;
  /** Commits this theme was drawn from. The evidence, not a flourish. */
  evidence: Array<{ shortSha: string; subject: string }>;
  /** How many past fixes fall under it. */
  observed: number;
  /** The built-in axis this extends or refines, when there is one. */
  refines?: Axis;
  /** Whether mutating tests would be needed to exercise it. */
  mutating: boolean;
}

export interface Taxonomy {
  schemaVersion: typeof TAXONOMY_SCHEMA_VERSION;
  derivedAt: string;
  /** Built-in axes still considered relevant here. */
  standard: Axis[];
  /** Project-specific axes, ordered by how often they have bitten. */
  derived: DerivedAxis[];
  /** Themes seen but too thin to act on. Kept so nothing vanishes silently. */
  discarded: Array<{ title: string; why: string }>;
  notes: string[];
}

interface TaxonomyProposal {
  axes?: Array<{
    key?: string;
    title?: string;
    brief?: string;
    commits?: string[];
    refines?: string;
    mutating?: boolean;
  }>;
  irrelevantStandardAxes?: string[];
  notes?: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const s = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
};

function validate(parsed: unknown): { ok: true; value: TaxonomyProposal } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (!Array.isArray(parsed.axes)) return { ok: false, error: "'axes' must be an array." };
  return { ok: true, value: parsed as TaxonomyProposal };
}

export function slugKey(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "theme"
  );
}

/** Minimum past fixes before a theme is worth a testing axis of its own. */
export const MIN_OBSERVATIONS = 2;

export interface DeriveOptions {
  fixes: BugFix[];
  runner: AgentRunner;
  budget: Budget;
  /** Existing taxonomy, so keys stay stable between derivations. */
  existing?: Taxonomy;
  transcriptDir?: string;
  redact?: (text: string) => string;
  now?: Date;
  maxFixes?: number;
}

export async function deriveTaxonomy(opts: DeriveOptions): Promise<{
  taxonomy: Taxonomy;
  agentRuns: Array<AgentResult<unknown>>;
  usdEstimate: number;
}> {
  const now = opts.now ?? new Date();
  const agentRuns: Array<AgentResult<unknown>> = [];
  const notes: string[] = [];
  const discarded: Taxonomy["discarded"] = [];

  const fixes = opts.fixes.slice(0, opts.maxFixes ?? 60);

  if (fixes.length < MIN_OBSERVATIONS * 2) {
    notes.push(
      `Only ${fixes.length} past fix(es) found. That is too little history to derive a taxonomy from, ` +
        `so the standard axes are used unchanged.`,
    );
    return {
      taxonomy: {
        schemaVersion: TAXONOMY_SCHEMA_VERSION,
        derivedAt: now.toISOString(),
        standard: [...AXES],
        derived: [],
        discarded,
        notes,
      },
      agentRuns,
      usdEstimate: 0,
    };
  }

  const byShortSha = new Map(fixes.map((f) => [f.shortSha, f]));

  const prompt = [
    "These are real bug fixes from one project's history, written by the people",
    "who made them. Group them into the kinds of thing that actually go wrong here.",
    "",
    "PAST FIXES:",
    ...fixes.map((f) => `  ${f.shortSha}  ${f.subject}${f.body ? `\n      ${f.body.split("\n")[0].slice(0, 150)}` : ""}`),
    "",
    `THE STANDARD AXES, which already exist: ${AXES.join(", ")}`,
    "",
    "Propose axes specific to this project. For each: a key, a title, a brief a",
    "test author could work from, and the shortShas it is drawn from.",
    "",
    "Return JSON: { axes[], irrelevantStandardAxes[], notes[] }.",
  ].join("\n");

  const result = await runAgent<TaxonomyProposal>({
    runner: opts.runner,
    definition: getAgent("pathfinder-taxonomy"),
    prompt,
    validate,
    budget: opts.budget,
    transcriptDir: opts.transcriptDir,
    redact: opts.redact,
  });
  agentRuns.push(result as AgentResult<unknown>);

  if (result.status !== "ok" || !result.data) {
    notes.push(
      `Deriving a taxonomy did not complete (${result.status}). The standard axes are used unchanged, ` +
        `so anything specific to this project is not being looked for.`,
    );
    return {
      taxonomy: {
        schemaVersion: TAXONOMY_SCHEMA_VERSION,
        derivedAt: now.toISOString(),
        standard: [...AXES],
        derived: [],
        discarded,
        notes,
      },
      agentRuns,
      usdEstimate: result.usdEstimate,
    };
  }

  /* --- bound it (code) ---------------------------------------------------- */

  const derived: DerivedAxis[] = [];
  const usedKeys = new Set<string>();

  for (const raw of result.data.axes ?? []) {
    const title = s(raw.title);
    const brief = s(raw.brief);
    if (!title || !brief) continue;

    // Every commit cited must be one that was actually supplied. A theme
    // supported by invented evidence is a theme supported by nothing.
    const evidence = (raw.commits ?? [])
      .map((c) => s(c))
      .filter((c): c is string => Boolean(c))
      .map((sha) => byShortSha.get(sha))
      .filter((f): f is BugFix => Boolean(f))
      .map((f) => ({ shortSha: f.shortSha, subject: f.subject }));

    if (evidence.length < MIN_OBSERVATIONS) {
      // One occurrence is an incident; two is a pattern. Building a whole
      // testing axis on a single commit would spend every run chasing it.
      discarded.push({
        title,
        why:
          evidence.length === 0
            ? "No supplied commit supports it. Not derived from this history."
            : `Only ${evidence.length} supporting commit(s); ${MIN_OBSERVATIONS} needed to call it a pattern.`,
      });
      continue;
    }

    const key = slugKey(s(raw.key) ?? title);
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);

    const refines = (AXES as readonly string[]).includes(s(raw.refines) ?? "")
      ? (s(raw.refines) as Axis)
      : undefined;

    derived.push({
      key,
      title,
      brief,
      evidence,
      observed: evidence.length,
      refines,
      mutating: raw.mutating === true,
    });
  }

  derived.sort((a, b) => b.observed - a.observed || a.key.localeCompare(b.key));

  // A standard axis is only dropped when the agent says it is irrelevant AND
  // nothing derived refines it. Removing an axis silently narrows every future
  // run.
  const refined = new Set(derived.map((d) => d.refines).filter(Boolean));
  const claimedIrrelevant = new Set(
    (result.data.irrelevantStandardAxes ?? [])
      .map((a) => s(a))
      .filter((a): a is Axis => (AXES as readonly string[]).includes(a ?? "")),
  );

  const standard = AXES.filter((axis) => {
    if (!claimedIrrelevant.has(axis)) return true;
    if (refined.has(axis)) return true;
    notes.push(`${axis} dropped: nothing in this project's history suggests it applies here.`);
    return false;
  });

  if (!standard.length) {
    notes.push("Every standard axis was dropped, which is almost certainly wrong. Keeping them all.");
    return {
      taxonomy: {
        schemaVersion: TAXONOMY_SCHEMA_VERSION,
        derivedAt: now.toISOString(),
        standard: [...AXES],
        derived,
        discarded,
        notes,
      },
      agentRuns,
      usdEstimate: result.usdEstimate,
    };
  }

  for (const n of result.data.notes ?? []) {
    const note = s(n);
    if (note) notes.push(note);
  }

  if (derived.length) {
    notes.push(
      `${derived.length} project-specific axis/axes derived from ${fixes.length} past fixes. ` +
        `Each is backed by at least ${MIN_OBSERVATIONS} real commits.`,
    );
  }

  return {
    taxonomy: {
      schemaVersion: TAXONOMY_SCHEMA_VERSION,
      derivedAt: now.toISOString(),
      standard,
      derived,
      discarded,
      notes,
    },
    agentRuns,
    usdEstimate: result.usdEstimate,
  };
}

export function describeTaxonomy(taxonomy: Taxonomy): string[] {
  const lines: string[] = [];

  lines.push(`standard   ${taxonomy.standard.join(", ")}`);

  if (taxonomy.derived.length) {
    lines.push("");
    lines.push("derived from this project's own history:");
    for (const d of taxonomy.derived) {
      lines.push(`  ${d.key.padEnd(28)} ${d.observed} past fix(es)${d.refines ? `  refines ${d.refines}` : ""}`);
      lines.push(`  ${" ".repeat(28)} ${d.brief.slice(0, 88)}`);
      for (const e of d.evidence.slice(0, 2)) {
        lines.push(`  ${" ".repeat(28)} ${e.shortSha} ${e.subject.slice(0, 70)}`);
      }
    }
  }

  for (const d of taxonomy.discarded) lines.push(`  discarded  ${d.title.slice(0, 40)}: ${d.why}`);
  for (const n of taxonomy.notes) lines.push(`  note       ${n}`);

  return lines;
}
