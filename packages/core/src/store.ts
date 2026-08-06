import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Profile, Run } from "./types.ts";

/** Per-project state lives here, inside the project being tested. */
export const CLARVIS_DIR = ".clarvis";

export function clarvisPaths(projectRoot: string) {
  const root = path.join(projectRoot, CLARVIS_DIR);
  return {
    root,
    profile: path.join(root, "profile.json"),
    runs: path.join(root, "runs"),
    scratch: path.join(root, "scratch"),
    auth: path.join(root, ".auth"),
  };
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
