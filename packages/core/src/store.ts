import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { Profile, Run } from "./types.ts";

/**
 * Where a project's Clarvis state lives.
 *
 * OUTSIDE the project, always. Each project gets an isolated directory under
 * the user's home, keyed by a hash of its absolute path.
 *
 * This used to be a `.clarvis/` folder inside the repository being tested, and
 * that was wrong in several ways at once. It put megabytes of Playwright traces
 * into someone's working tree, made `git status` noisy in a repo that was
 * clean, required a `.gitignore` edit to be tolerable, and risked committing
 * agent transcripts - which contain retrieved text from the project itself.
 *
 * A testing tool should be able to run against a repository without leaving a
 * mark on it. Nothing here writes inside the project. The only exception is
 * spec promotion, which is opt-in precisely because it does.
 */

/** Legacy in-project directory. Detected so it can be reported, never written. */
export const CLARVIS_DIR = ".clarvis";

/**
 * Root of all Clarvis state, outside every project.
 *
 * `CLARVIS_HOME` overrides it. That exists for the test suite above all: without
 * it, running the tests writes into the user's real state directory and every
 * run leaves debris in a place nobody thinks to look. It is also the honest way
 * to keep two checkouts, or a scratch profile, from sharing one store.
 */
export function clarvisHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLARVIS_HOME?.trim();
  return override ? path.resolve(override) : path.join(homedir(), ".clarvis");
}

/**
 * A stable directory name for a project.
 *
 * Derived from the resolved absolute path, so renaming the folder keeps the
 * identity and two projects sharing a basename never collide. Matches
 * `projectId()` in projects.ts deliberately: the registry and the state
 * directory must agree, or the dashboard and the engine end up looking at
 * different things.
 */
export function projectSlug(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  const base = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base || "project"}-${hash}`;
}

export function clarvisPaths(projectRoot: string, env: NodeJS.ProcessEnv = process.env) {
  // The env is a parameter so a process can read a store other than its own -
  // the smoke run drives a child under a throwaway CLARVIS_HOME and then has
  // to read back what that child wrote.
  const root = path.join(clarvisHome(env), "projects", projectSlug(projectRoot));
  return {
    root,
    profile: path.join(root, "profile.json"),
    runs: path.join(root, "runs"),
    scratch: path.join(root, "scratch"),
    auth: path.join(root, ".auth"),
  };
}

/**
 * An old in-project state directory, if one is there.
 *
 * Reported rather than migrated: moving someone's files without asking is not
 * this tool's business, and the old directory is harmless where it sits.
 */
export async function legacyStateDir(projectRoot: string): Promise<string | undefined> {
  const legacy = path.join(projectRoot, CLARVIS_DIR);
  try {
    const info = await stat(legacy);
    return info.isDirectory() ? legacy : undefined;
  } catch {
    return undefined;
  }
}

/** Sortable by name, so "latest" is just the last entry. */
export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "T");
  return `${stamp.slice(0, 13)}-${randomBytes(3).toString("hex")}`;
}

export async function loadProfile(projectRoot: string, explicitPath?: string): Promise<Profile> {
  const file = explicitPath ?? clarvisPaths(projectRoot).profile;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      `No profile at ${file}. Run \`clarvis recon\` first - the testers cannot run without one.`,
    );
  }
  const profile = JSON.parse(raw) as Profile;
  if (profile.schemaVersion !== 1) {
    throw new Error(`Profile schemaVersion ${profile.schemaVersion} is not supported (expected 1).`);
  }
  if (!profile.boot?.url) throw new Error(`Profile at ${file} has no boot.url.`);
  return profile;
}

export async function runDir(projectRoot: string, runId: string): Promise<string> {
  const dir = path.join(clarvisPaths(projectRoot).runs, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeRun(projectRoot: string, run: Run): Promise<string> {
  const dir = await runDir(projectRoot, run.runId);
  const file = path.join(dir, "run.json");
  await writeFile(file, JSON.stringify(run, null, 2), "utf8");
  return file;
}

/**
 * Runs that have actually been written.
 *
 * The directory is created when a run starts and `run.json` only lands when it
 * finishes, so a run in progress leaves a directory with nothing in it. Listing
 * those made the dashboard ask for a run that 404s, and the failure took the
 * whole list with it: the sidebar said "4 runs" beside a panel reading "no runs
 * in this project".
 */
export async function listRunIds(projectRoot: string): Promise<string[]> {
  const runsDir = clarvisPaths(projectRoot).runs;
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const written = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        try {
          await stat(path.join(runsDir, e.name, "run.json"));
          return e.name;
        } catch {
          return undefined;
        }
      }),
  );

  return written.filter((n): n is string => Boolean(n)).sort();
}

export async function readRun(projectRoot: string, runId: string): Promise<Run> {
  const id = runId === "latest" ? (await listRunIds(projectRoot)).at(-1) : runId;
  if (!id) throw new Error("No runs found. Run `clarvis run` first.");
  const file = path.join(clarvisPaths(projectRoot).runs, id, "run.json");
  return JSON.parse(await readFile(file, "utf8")) as Run;
}
