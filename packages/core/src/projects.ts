import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { FLEET_KEYS, FLEETS, type FleetKey } from "./fleets.ts";
import { listRunIds } from "./store.ts";

/**
 * The project registry.
 *
 * Clarvis is one team pointed at many codebases, so the dashboard has to keep
 * them genuinely separate: a finding from one project appearing under another
 * would be worse than not showing it at all.
 *
 * The registry lives in the user's home directory, never inside a project. A
 * per-project registry would mean each repo knew about the others, which is
 * both a privacy leak between clients and a merge conflict waiting to happen.
 */

export interface ProjectEntry {
  /** Stable across renames: derived from the path, not the name. */
  id: string;
  name: string;
  path: string;
  addedAt: string;
  /**
   * Which teams run for this project by default.
   *
   * Per-project rather than global: a repo with no tracker has no use for
   * DISPATCH, and a repo with no written specs gets nothing from DOSSIER but
   * the cost. Absent means the legacy default, so existing entries keep
   * behaving as they did.
   */
  fleets?: FleetKey[];
  /**
   * Whether to build and use a graphify code graph for this project.
   *
   * Separate from the fleet list because it is not a team - it is a source of
   * facts two of them read. Off unless asked for: it is a second tool that may
   * not be installed, and a setup step should not quietly depend on one.
   */
  useGraph?: boolean;
  /** Filled in by the server; not persisted. */
  runCount?: number;
  lastRunId?: string;
  missing?: boolean;
}

export function projectsFile(): string {
  return path.join(homedir(), ".clarvis", "projects.json");
}

/**
 * Derived from the absolute path so that renaming a project keeps its identity,
 * and two projects with the same folder name never collide.
 */
export function projectId(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  const base = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base || "project"}-${hash}`;
}

export async function loadProjects(): Promise<ProjectEntry[]> {
  try {
    const raw = await readFile(projectsFile(), "utf8");
    const parsed = JSON.parse(raw) as { projects?: ProjectEntry[] };
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    // A missing or unreadable registry is an empty one, not an error: the first
    // run of the app should not fail because nothing has been added yet.
    return [];
  }
}

export async function saveProjects(projects: ProjectEntry[]): Promise<string> {
  const file = projectsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ projects }, null, 2), "utf8");
  return file;
}

/**
 * The teams a project gets when nobody chose.
 *
 * Recon plus QA: enough to produce findings, cheap enough to not surprise
 * anyone. Everything else is opt-in, and the run prints what each omission
 * costs.
 */
export const DEFAULT_FLEETS: FleetKey[] = ["recon", "qa"];

/**
 * Keep only real fleet keys, always include the mandatory ones, and return them
 * in registry order so two projects with the same selection look the same.
 */
export function normaliseFleets(requested?: readonly string[]): FleetKey[] {
  const wanted = new Set(
    (requested?.length ? requested : DEFAULT_FLEETS).filter((k): k is FleetKey =>
      (FLEET_KEYS as readonly string[]).includes(k),
    ),
  );

  for (const key of FLEET_KEYS) {
    if (FLEETS[key].mandatory) wanted.add(key);
  }

  return FLEET_KEYS.filter((k) => wanted.has(k));
}

export async function addProject(
  projectPath: string,
  name?: string,
  fleets?: readonly string[],
  useGraph?: boolean,
): Promise<{ project: ProjectEntry; created: boolean }> {
  const resolved = path.resolve(projectPath);

  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`${resolved} is not a directory.`);
  }

  const projects = await loadProjects();
  const id = projectId(resolved);

  const existing = projects.find((p) => p.id === id);
  if (existing) {
    // Adding twice is a no-op rather than a duplicate row, but it is also how
    // the selection gets changed, so an explicit list is applied.
    let changed = false;
    if (name && name !== existing.name) {
      existing.name = name;
      changed = true;
    }
    if (fleets?.length) {
      existing.fleets = normaliseFleets(fleets);
      changed = true;
    }
    if (useGraph !== undefined && useGraph !== existing.useGraph) {
      existing.useGraph = useGraph;
      changed = true;
    }
    if (changed) await saveProjects(projects);
    return { project: existing, created: false };
  }

  const project: ProjectEntry = {
    id,
    name: name ?? path.basename(resolved),
    path: resolved,
    addedAt: new Date().toISOString(),
    fleets: normaliseFleets(fleets),
    useGraph: useGraph ?? false,
  };

  projects.push(project);
  await saveProjects(projects);
  return { project, created: true };
}

export async function removeProject(idOrPath: string): Promise<boolean> {
  const projects = await loadProjects();
  const id = projects.some((p) => p.id === idOrPath) ? idOrPath : projectId(idOrPath);
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) return false;
  await saveProjects(next);
  return true;
}

/**
 * Adds run counts and flags projects whose directory has gone. A moved or
 * deleted repo should show as missing rather than silently reporting no runs,
 * which looks identical to a project that is simply clean.
 */
export async function describeProjects(): Promise<ProjectEntry[]> {
  const projects = await loadProjects();

  return Promise.all(
    projects.map(async (project) => {
      const exists = await stat(project.path)
        .then((s) => s.isDirectory())
        .catch(() => false);

      if (!exists) return { ...project, missing: true, runCount: 0 };

      const ids = await listRunIds(project.path);
      return {
        ...project,
        // Older entries predate per-project selection. Filling the default in
        // here means the UI never has to special-case a missing field.
        fleets: normaliseFleets(project.fleets),
        missing: false,
        runCount: ids.length,
        lastRunId: ids.at(-1),
      };
    }),
  );
}

export async function resolveProject(idOrPath?: string): Promise<ProjectEntry | undefined> {
  const projects = await loadProjects();
  if (!idOrPath) return projects[0];
  return (
    projects.find((p) => p.id === idOrPath) ??
    projects.find((p) => path.resolve(p.path) === path.resolve(idOrPath))
  );
}
