import type { Run } from "@clarvis/core/types";
import { API_CONTRACT } from "@clarvis/core/pipeline";

/**
 * The UI never imports run data - it always fetches. That keeps this component
 * tree identical whether it is served by `clarvis ui` (real projects) or by
 * `vite dev` (the checked-in fixture), and means the desktop app needs no
 * special case.
 */

export interface Project {
  id: string;
  name: string;
  path: string;
  /** Which teams run for this project. Chosen when it is added. */
  fleets?: string[];
  runCount?: number;
  lastRunId?: string;
  missing?: boolean;
}

export interface FleetInfo {
  key: string;
  codename: string;
  title: string;
  purpose: string;
  mandatory: boolean;
  requires: string[];
  writesExternally: boolean;
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * What the UI needs the server to be.
 *
 * Imported rather than re-declared: this and the server's number drifted once
 * already, and a page that needs one version while the process serving it
 * announces another fails one fetch at a time with nothing said.
 */
export const NEEDS_API = API_CONTRACT;

/**
 * Whether the server behind this page is old enough to break it.
 *
 * `clarvis ui` holds its code in memory and serves the bundle from disk, so a
 * server left running for a day can pair a stale API with a page built
 * minutes ago. The failure that produces is a 404 on an endpoint the page
 * knows exists - invisible unless someone opens a console. Asking directly
 * turns that into something the page can say out loud.
 */
export async function checkServer(): Promise<{
  stale: boolean;
  serverApi?: number;
  /** True only when an API key is set. Otherwise nothing is billed to a card. */
  billed: boolean;
}> {
  const health = await fetchJson<{ api?: number; billed?: boolean }>("/api/health");
  // No health endpoint at all means a server older than the endpoint itself,
  // which is by definition stale. Except in the dev server, where there is no
  // API to be old - and `loadProjects` already tells those apart.
  if (!health) return { stale: false, billed: false };
  return {
    stale: (health.api ?? 0) < NEEDS_API,
    serverApi: health.api,
    billed: Boolean(health.billed),
  };
}

/**
 * Effort, in the unit that actually applies.
 *
 * A dollar figure is a conversion nobody asked for when the work runs through
 * a Claude plan: there is no card, nothing is billed, and the plan counts
 * tokens. Showing a price anyway invites the reader to budget against a number
 * that will never appear on a statement. Where an API key IS set the money is
 * real, and then it is the right thing to show.
 */
export function effortLabel(
  agents: Array<{ tokens?: { input: number; output: number }; usdEstimate?: number }>,
  billed: boolean,
): string {
  if (billed) {
    const usd = agents.reduce((sum, a) => sum + (a.usdEstimate ?? 0), 0);
    return usd > 0 ? `$${usd.toFixed(2)}` : "--";
  }

  const total = agents.reduce((sum, a) => sum + (a.tokens?.input ?? 0) + (a.tokens?.output ?? 0), 0);
  if (!total) return "--";
  return total >= 1_000_000
    ? `${(total / 1_000_000).toFixed(1)}M`
    : total >= 1000
      ? `${Math.round(total / 1000)}k`
      : String(total);
}

export async function loadProjects(): Promise<Project[]> {
  return (await fetchJson<Project[]>("/api/projects")) ?? [];
}

/** The team list comes from the engine, so the UI never hardcodes it. */
export async function loadFleets(): Promise<FleetInfo[]> {
  return (await fetchJson<FleetInfo[]>("/api/fleets")) ?? [];
}

export interface LoadedRuns {
  latest?: Run;
  /** The run before it, when one exists. Used for new-versus-resolved deltas. */
  previous?: Run;
  source: "live" | "fixture" | "empty";
}

export async function loadRunsFor(projectId: string): Promise<LoadedRuns> {
  const ids = await fetchJson<string[]>(`/api/projects/${encodeURIComponent(projectId)}/runs`);

  if (ids?.length) {
    const at = (i: number) =>
      fetchJson<Run>(`/api/projects/${encodeURIComponent(projectId)}/run/${encodeURIComponent(ids[i])}`);

    const latest = await at(ids.length - 1);
    if (latest) {
      // Run ids sort chronologically by construction, so the one before is
      // simply the previous element - no separate index to keep in sync.
      const previous = ids.length > 1 ? await at(ids.length - 2) : undefined;
      return { latest, previous, source: "live" };
    }
  }

  // A project with no runs is a real state, not an error. Only fall back to the
  // bundled example when there is no server at all - during `vite dev`.
  return { source: "empty" };
}

/** Dev-server path: no API, so show the checked-in example. */
export async function loadFixture(): Promise<LoadedRuns> {
  const fixture = await fetchJson<Run>("./fixtures/run-example.json");
  return fixture ? { latest: fixture, source: "fixture" } : { source: "empty" };
}

/* ------------------------------------------------------------- artifacts */

/**
 * Everything a run produces that is not run.json.
 *
 * Four of the six teams wrote their output to a file nothing served, so the
 * tickets SCRIBE drafted and the verdict JUDGE reached could be read
 * only in the terminal. The rest is what a reader needs to judge a result at
 * all: the requirements a finding cites, the plan that says what was
 * deliberately not tested, and the route map that says how much of the
 * application was ever looked at.
 */

/** A route as the surface map recorded it, with what was seen there. */
export interface MappedRoute {
  path: string;
  /** What was actually requested, once known parameters were filled in. */
  visitPath?: string;
  title?: string;
  requiresAuth?: boolean;
  dynamic?: boolean;
  landedOn?: string;
  status?: number;
  ariaSnapshot?: string;
  source?: string;
  note?: string;
}

export interface ProfileLike {
  project?: { name?: string; root?: string; reconAt?: string };
  boot?: { url?: string; cmd?: string; verified?: boolean };
  auth?: { mode?: string; loginUrl?: string; roles?: Array<{ key: string; label?: string; expectedDenied?: string[] }> };
  stack?: { framework?: string; rendering?: string; hydrationMs?: number; locales?: string[] };
  data?: { disposable?: boolean; safeTargets?: string[]; forbiddenHosts?: string[]; fixturePrefix?: string };
  surface?: { routes?: MappedRoute[]; discoveredBy?: string[]; mappedAt?: string };
  risk?: { hotspots?: Array<{ area: string; reason: string; score?: number }> };
}

export interface RequirementLike {
  id: string;
  statement: string;
  quote: string;
  confidence?: string;
  sourceIds?: string[];
  axisHints?: string[];
}

export interface ContextLike {
  feature?: { title?: string; summary?: string };
  gatheredAt?: string;
  sources?: Array<{ id: string; ref?: string; kind?: string }>;
  requirements?: RequirementLike[];
  unknowns?: Array<{ question?: string; guess?: string; why?: string }>;
}

export interface PlanLike {
  rationale?: string;
  axes?: Array<{ axis: string; rank: number; why: string; routes?: string[]; roles?: string[] }>;
  deferred?: Array<{ axis: string; why: string; cost: string }>;
}

export interface VerdictLike {
  verdict?: { decision?: string; reason?: string };
  summary?: string;
  limits?: string[];
  releaseNotes?: string[];
}

export interface DraftsLike {
  drafts?: Array<{
    findingId?: string;
    title?: string;
    body?: string;
    labels?: string[];
    published?: boolean;
    refusedBecause?: string;
  }>;
}

/** Absent is a real state, not an error - so it resolves rather than throws. */
async function artifact<T>(projectId: string, name: string): Promise<T | undefined> {
  return fetchJson<T>(`/api/projects/${encodeURIComponent(projectId)}/artifact/${encodeURIComponent(name)}`);
}

export const loadProfile = (id: string) => artifact<ProfileLike>(id, "profile.json");
export const loadContext = (id: string) => artifact<ContextLike>(id, "context.json");
export const loadPlan = (id: string) => artifact<PlanLike>(id, "plan.json");

async function runArtifact<T>(projectId: string, runId: string, name: string): Promise<T | undefined> {
  return fetchJson<T>(
    `/api/projects/${encodeURIComponent(projectId)}/run/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(name)}`,
  );
}

export const loadVerdict = (id: string, runId: string) => runArtifact<VerdictLike>(id, runId, "verdict.json");
export const loadDrafts = (id: string, runId: string) => runArtifact<DraftsLike>(id, runId, "drafts.json");

/** The authored spec source, so a cited spec can be read without a terminal. */
export async function loadSpec(projectId: string, file: string) {
  return fetchJson<{ file: string; source: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/spec/${encodeURIComponent(file)}`,
  );
}
