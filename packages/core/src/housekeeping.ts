import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLARVIS_DIR, clarvisPaths, listRunIds } from "./store.ts";

/**
 * Keeping `.clarvis/` from becoming a problem in someone else's repository.
 *
 * Everything Clarvis produces is written INSIDE the project being tested, which
 * is right - a run belongs with the code it describes, and a shared cache keyed
 * by path would be worse in every way. But it has two consequences that have to
 * be handled rather than discovered:
 *
 *   1. It is untracked build output sitting in a working tree. Nine runs of a
 *      two-file demo came to 14MB, almost all of it Playwright traces from
 *      triage, which re-runs each failing test three times in fresh processes.
 *      On a real application that is not a rounding error.
 *
 *   2. Nobody's `.gitignore` knows about it, so the first run makes `git status`
 *      noisy in a repo that was clean.
 */

/** What a project's .gitignore needs for Clarvis to be invisible to git. */
export const IGNORE_ENTRY = `${CLARVIS_DIR}/`;

export interface IgnoreState {
  /** False when this is not a git repository at all. */
  isRepo: boolean;
  ignored: boolean;
  gitignorePath: string;
}

export async function checkIgnored(projectRoot: string): Promise<IgnoreState> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const isRepo = await stat(path.join(projectRoot, ".git"))
    .then(() => true)
    .catch(() => false);

  if (!isRepo) return { isRepo: false, ignored: true, gitignorePath };

  const content = await readFile(gitignorePath, "utf8").catch(() => "");
  const ignored = content
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === IGNORE_ENTRY || line === CLARVIS_DIR || line === `/${IGNORE_ENTRY}`);

  return { isRepo: true, ignored, gitignorePath };
}

/**
 * Append the entry, preserving whatever is already there.
 *
 * Only ever called after an explicit yes: editing a file in someone's
 * repository is exactly the kind of thing a tool should not do quietly, however
 * obviously correct it looks.
 */
export async function addToGitignore(projectRoot: string): Promise<{ added: boolean; path: string }> {
  const state = await checkIgnored(projectRoot);
  if (!state.isRepo || state.ignored) return { added: false, path: state.gitignorePath };

  const existing = await readFile(state.gitignorePath, "utf8").catch(() => "");
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";

  await writeFile(
    state.gitignorePath,
    `${existing}${separator}\n# Clarvis run artifacts (traces, screenshots, transcripts)\n${IGNORE_ENTRY}\n`,
    "utf8",
  );

  return { added: true, path: state.gitignorePath };
}

export interface PruneResult {
  kept: string[];
  removed: string[];
  freedBytes: number;
}

async function dirSize(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let total = 0;

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += await stat(full).then((s) => s.size).catch(() => 0);
    }
  };

  await walk(dir);
  return total;
}

/**
 * Keep the most recent runs, delete the rest.
 *
 * Run ids sort chronologically as plain strings, so "most recent" needs no date
 * parsing. Deletion is whole directories only - a run with its artifacts removed
 * but its `run.json` left behind would look like a run whose evidence had
 * vanished, which is indistinguishable from a bug.
 */
export async function pruneRuns(
  projectRoot: string,
  keep = 10,
): Promise<PruneResult> {
  const ids = await listRunIds(projectRoot);
  if (ids.length <= keep) return { kept: ids, removed: [], freedBytes: 0 };

  const runsDir = clarvisPaths(projectRoot).runs;
  const removed = ids.slice(0, ids.length - keep);
  let freedBytes = 0;

  for (const id of removed) {
    const dir = path.join(runsDir, id);
    freedBytes += await dirSize(dir);
    await rm(dir, { recursive: true, force: true });
  }

  return { kept: ids.slice(ids.length - keep), removed, freedBytes };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
