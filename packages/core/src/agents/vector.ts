import type { FeatureContext } from "../context.ts";
import type { FeatureScope } from "../scope.ts";
import { blastRadius, type GraphConnector } from "../connectors/graph.ts";
import { AXES, MUTATING_AXES, type Axis, type Profile } from "../types.ts";
import type { Budget } from "./budget.ts";
import { getAgent } from "./definitions.ts";
import { runAgent, type AgentResult, type AgentRunner } from "./runtime.ts";

/**
 * VECTOR: decide what is worth testing.
 *
 * This fleet only earns its cost when there is more work than budget. On a
 * small app "run every axis" is a fine plan and VECTOR is overhead; on a real
 * codebase you cannot test everything, and the choice of what to skip is the
 * single decision that most affects whether a run finds anything.
 *
 * The asymmetry that shapes this file: an axis VECTOR drops is an axis that
 * never runs, and a bug it would have caught is indistinguishable from no bug
 * at all. So the model here can REORDER and it can EXPLAIN, but the plan it
 * produces is always bounded by code:
 *
 *   - It cannot invent an axis, a route or a role. Everything it selects must
 *     already exist in the profile or the scope.
 *   - It cannot silently drop an axis. Every axis is either in the plan or in
 *     `deferred` with a reason, and the two together always account for all of
 *     them.
 *   - It cannot enable a mutating axis the guard would refuse anyway.
 *
 * What it is genuinely good at is the ranking: reading a diff and a set of
 * requirements and saying "the org-scoping change makes rbac the first thing
 * worth looking at, and visual regression is noise this week."
 */

export const PLAN_SCHEMA_VERSION = 1 as const;

export interface PlannedAxis {
  axis: Axis;
  /** 1 is tested first. */
  rank: number;
  why: string;
  /** Routes worth exercising on this axis. Subset of what recon found. */
  routes: string[];
  /** Role keys worth exercising. Subset of the profile's roles. */
  roles: string[];
  /** Requirement ids this axis should assert against. */
  requirementIds: string[];
}

export interface DeferredAxis {
  axis: Axis;
  why: string;
  /** What a human loses by this axis not running. Never left implicit. */
  cost: string;
}

export interface TestPlan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  feature: { key: string; title: string };
  plannedAt: string;
  axes: PlannedAxis[];
  deferred: DeferredAxis[];
  /** Where the plan disagrees with what was asked for, and why. */
  notes: string[];
  /** Ranking rationale, in one paragraph, for a human skimming the run. */
  rationale: string;
}

interface PlanProposal {
  axes?: Array<{
    axis?: string;
    rank?: number;
    why?: string;
    routes?: string[];
    roles?: string[];
    requirementIds?: string[];
  }>;
  deferred?: Array<{ axis?: string; why?: string; cost?: string }>;
  rationale?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const s = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => s(x)).filter((x): x is string => Boolean(x)) : [];

function validatePlan(parsed: unknown): { ok: true; value: PlanProposal } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (!Array.isArray(parsed.axes)) return { ok: false, error: "'axes' must be an array." };
  if (!Array.isArray(parsed.deferred)) {
    return {
      ok: false,
      error: "'deferred' must be an array. Every axis you are not planning goes there with a reason.",
    };
  }
  if (typeof parsed.rationale !== "string" || !parsed.rationale.trim()) {
    return { ok: false, error: "'rationale' must explain the ranking in a short paragraph." };
  }
  return { ok: true, value: parsed as PlanProposal };
}

export interface PlanOptions {
  scope: FeatureScope;
  profile: Profile;
  context?: FeatureContext;
  runner: AgentRunner;
  budget: Budget;
  /** Axes the caller is willing to run. Defaults to all of them. */
  candidateAxes?: Axis[];
  /** Axes the guard has already refused. VECTOR may not resurrect these. */
  guardSkipped?: Axis[];
  transcriptDir?: string;
  redact?: (text: string) => string;
  now?: Date;
  /**
   * Optional code graph.
   *
   * Filenames say what was edited; the graph says what depends on it. "This
   * file is imported by the auth middleware" is the signal that should move
   * rbac to the top, and nothing else in the brief carries it.
   */
  graph?: GraphConnector;
}

export interface PlanReport {
  agentRuns: Array<AgentResult<unknown>>;
  usdEstimate: number;
  /** Things the agent proposed that code refused. */
  corrections: string[];
}

function renderBrief(opts: PlanOptions, candidates: Axis[], reach: string[]): string {
  const { scope, profile, context } = opts;
  const routes = (profile.surface?.routes ?? []).map((r) => r.path);

  return [
    `FEATURE: ${scope.title}`,
    `ORIGIN: ${scope.origin} (confidence ${scope.confidence})`,
    scope.keywords.length ? `KEYWORDS: ${scope.keywords.join(", ")}` : "",
    scope.trackerKeys.length ? `TICKETS: ${scope.trackerKeys.join(", ")}` : "",
    "",
    `CHANGED FILES (${scope.paths.length}):`,
    ...scope.paths.slice(0, 40).map((f) => `  ${f}`),
    scope.paths.length > 40 ? `  ... and ${scope.paths.length - 40} more` : "",
    "",
    reach.length
      ? `WHAT THE CHANGED FILES REACH (from the code graph, most-reached first):\n${reach
          .map((r) => `  ${r}`)
          .join("\n")}`
      : "",
    "",
    routes.length ? `KNOWN ROUTES:\n${routes.map((r) => `  ${r}`).join("\n")}` : "KNOWN ROUTES: none mapped.",
    "",
    profile.auth.roles.length
      ? `ROLES:\n${profile.auth.roles
          .map((r) => `  ${r.key}${r.expectedDenied?.length ? ` (must not reach ${r.expectedDenied.join(", ")})` : ""}`)
          .join("\n")}`
      : "ROLES: none configured.",
    "",
    context?.requirements.length
      ? `VERIFIED REQUIREMENTS:\n${context.requirements
          .map((r) => `  [${r.id}] ${r.statement}`)
          .join("\n")}`
      : "VERIFIED REQUIREMENTS: none. Research has not run, so no axis can cite one.",
    "",
    context?.unknowns.length
      ? `KNOWN UNKNOWNS (testing is blind here):\n${context.unknowns
          .slice(0, 10)
          .map((u) => `  ${u.question}`)
          .join("\n")}`
      : "",
    "",
    `AXES YOU MAY PLAN: ${candidates.join(", ")}`,
    opts.guardSkipped?.length
      ? `AXES THE GUARD ALREADY REFUSED (do not plan these): ${opts.guardSkipped.join(", ")}`
      : "",
    "",
    "Rank the axes worth running, first to last. Put every axis you are NOT",
    "planning into 'deferred' with a reason AND what a human loses by it not",
    "running. The two lists together must account for every axis above.",
    "",
    "Return JSON: { axes[], deferred[], rationale }.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function planRun(opts: PlanOptions): Promise<{ plan: TestPlan; report: PlanReport }> {
  const corrections: string[] = [];
  const agentRuns: Array<AgentResult<unknown>> = [];
  const now = opts.now ?? new Date();

  const guardSkipped = new Set(opts.guardSkipped ?? []);
  const candidates = (opts.candidateAxes ?? [...AXES]).filter((a) => !guardSkipped.has(a));

  const knownRoutes = new Set((opts.profile.surface?.routes ?? []).map((r) => r.path));
  const knownRoles = new Set(opts.profile.auth.roles.map((r) => r.key));
  const knownRequirements = new Set((opts.context?.requirements ?? []).map((r) => r.id));

  const fallback = (why: string): TestPlan => ({
    schemaVersion: PLAN_SCHEMA_VERSION,
    feature: { key: opts.scope.key, title: opts.scope.title },
    plannedAt: now.toISOString(),
    // Falling back to everything, not to nothing: an unplanned run that tests
    // every axis is wasteful, one that tests none is silent.
    axes: candidates.map((axis, i) => ({
      axis,
      rank: i + 1,
      why: "Planning did not complete, so this axis runs unranked.",
      routes: [],
      roles: [],
      requirementIds: [],
    })),
    deferred: [],
    notes: [why],
    rationale: why,
  });

  if (!candidates.length) {
    return {
      plan: { ...fallback("The guard refused every requested axis, so there is nothing to plan."), axes: [] },
      report: { agentRuns, usdEstimate: 0, corrections },
    };
  }

  // Blast radius, when a graph exists. Best-effort: a plan without it is less
  // well aimed, not wrong.
  let reach: string[] = [];
  if (opts.graph && opts.scope.paths.length) {
    const radius = await blastRadius(opts.graph, opts.scope.paths, { depth: 2 });
    if (radius.status === "ok") {
      reach = radius.data
        .slice(0, 25)
        .map((n) => `${n.label} - reached by ${n.reachedBy} changed file(s) [${n.relation}]`);
    }
  }

  const result = await runAgent<PlanProposal>({
    runner: opts.runner,
    definition: getAgent("vector-plan"),
    prompt: renderBrief(opts, candidates, reach),
    validate: validatePlan,
    budget: opts.budget,
    transcriptDir: opts.transcriptDir,
    redact: opts.redact,
  });
  agentRuns.push(result as AgentResult<unknown>);

  if (result.status !== "ok" || !result.data) {
    return {
      plan: fallback(
        `Planning did not complete (${result.status}). Every allowed axis runs, unranked and unprioritised.`,
      ),
      report: { agentRuns, usdEstimate: result.usdEstimate, corrections },
    };
  }

  /* --- bound the plan (code) --------------------------------------------- */

  const seen = new Set<Axis>();
  const axes: PlannedAxis[] = [];

  for (const raw of result.data.axes ?? []) {
    const axis = s(raw.axis) as Axis | undefined;
    if (!axis || !(AXES as readonly string[]).includes(axis)) {
      corrections.push(`Dropped an unknown axis "${raw.axis}".`);
      continue;
    }
    if (guardSkipped.has(axis)) {
      // The guard's refusal is not negotiable, and a plan that appears to
      // include a refused axis reads as coverage that never happened.
      corrections.push(`Refused to plan ${axis}: the guard already skipped it.`);
      continue;
    }
    if (!candidates.includes(axis)) {
      corrections.push(`Refused to plan ${axis}: it was not among the candidates.`);
      continue;
    }
    if (seen.has(axis)) {
      corrections.push(`Ignored a duplicate entry for ${axis}.`);
      continue;
    }
    seen.add(axis);

    // Routes, roles and requirement ids must already exist. An invented route
    // becomes a spec that navigates nowhere and fails for the wrong reason.
    const routes = strings(raw.routes).filter((r) => {
      if (!knownRoutes.size || knownRoutes.has(r)) return true;
      corrections.push(`Dropped route "${r}" from ${axis}: recon never mapped it.`);
      return false;
    });

    const roles = strings(raw.roles).filter((r) => {
      if (knownRoles.has(r)) return true;
      corrections.push(`Dropped role "${r}" from ${axis}: no such role in the profile.`);
      return false;
    });

    const requirementIds = strings(raw.requirementIds).filter((id) => {
      if (knownRequirements.has(id)) return true;
      corrections.push(`Dropped requirement "${id}" from ${axis}: it is not in the context.`);
      return false;
    });

    axes.push({
      axis,
      rank: axes.length + 1,
      why: s(raw.why) ?? "No reason given.",
      routes,
      roles,
      requirementIds,
    });
  }

  const deferred: DeferredAxis[] = [];
  for (const raw of result.data.deferred ?? []) {
    const axis = s(raw.axis) as Axis | undefined;
    if (!axis || !(AXES as readonly string[]).includes(axis) || seen.has(axis)) continue;
    seen.add(axis);
    deferred.push({
      axis,
      why: s(raw.why) ?? "No reason given.",
      cost: s(raw.cost) ?? "Not stated. Treat this axis as untested.",
    });
  }

  // Anything the agent simply forgot is deferred explicitly, never dropped.
  // A plan that quietly omits an axis reads as a decision; this makes it one.
  const notes: string[] = [];
  for (const axis of candidates) {
    if (seen.has(axis)) continue;
    deferred.push({
      axis,
      why: "The plan did not mention this axis at all.",
      cost: "Untested, and not deliberately. Treat this area as uncovered.",
    });
    notes.push(`${axis} was missing from the plan entirely and has been deferred with that noted.`);
  }

  // The agent is told which axes the guard refused, so it lists them too. Adding
  // them again produced every refused axis twice in the plan.
  const alreadyDeferred = new Set(deferred.map((d) => d.axis));
  for (const axis of guardSkipped) {
    if (alreadyDeferred.has(axis)) continue;
    deferred.push({
      axis,
      why: "The safety guard refused this axis for this target.",
      cost: "Untested. Mark the target disposable to enable it, or accept the gap.",
    });
  }

  if (!axes.length) {
    notes.push("The plan selected no axis at all. Falling back to running every allowed axis.");
    return {
      plan: { ...fallback("The plan selected nothing runnable."), deferred, notes },
      report: { agentRuns, usdEstimate: result.usdEstimate, corrections },
    };
  }

  // A mutating axis that survived the guard is fine, but it is worth saying out
  // loud in the plan, because it is the part that changes someone's data.
  const mutating = axes.filter((a) => MUTATING_AXES.includes(a.axis)).map((a) => a.axis);
  if (mutating.length) {
    notes.push(`Plans to create or modify records via: ${mutating.join(", ")}.`);
  }

  return {
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      feature: { key: opts.scope.key, title: opts.scope.title },
      plannedAt: now.toISOString(),
      axes,
      deferred,
      notes,
      rationale: s(result.data.rationale) ?? "No rationale given.",
    },
    report: { agentRuns, usdEstimate: result.usdEstimate, corrections },
  };
}

/** The axes a plan wants run, in the order it wants them. */
export function plannedAxisOrder(plan: TestPlan): Axis[] {
  return [...plan.axes].sort((a, b) => a.rank - b.rank).map((a) => a.axis);
}
