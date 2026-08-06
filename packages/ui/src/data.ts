import type { Run } from "@clarvis/core/types";

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
