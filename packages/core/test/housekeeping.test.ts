// Must come first: it points the store at a temp directory before any
// module under test resolves a path from it.
import "./isolate.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addToGitignore,
  checkIgnored,
  formatBytes,
  pruneRuns,
} from "../src/housekeeping.ts";
import { clarvisPaths, writeRun } from "../src/store.ts";
import type { Run } from "../src/types.ts";

/**
 * Everything Clarvis produces lands inside the project being tested. That is
 * correct - a run belongs with the code it describes - but it means Clarvis is
 * writing untracked build output into someone else's working tree, and both
 * consequences have to be handled rather than discovered.
 */

const run = (runId: string): Run => ({
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  status: "passed",
  guard: { mode: "read-only", target: "localhost:3000" },
  axes: [],
  findings: [],
});

async function repo(gitignore?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-hk-"));
  await mkdir(path.join(root, ".git"), { recursive: true });
  if (gitignore !== undefined) await writeFile(path.join(root, ".gitignore"), gitignore, "utf8");
  return root;
}

/* ------------------------------------------------------------- gitignore */

test("a project that never ignored .clarvis is reported as needing it", async () => {
  const root = await repo("node_modules/\ndist/\n");
  const state = await checkIgnored(root);
  assert.equal(state.isRepo, true);
  assert.equal(state.ignored, false);
});

test("an existing entry is recognised in any of the forms people write it", async () => {
  for (const line of [".clarvis/", ".clarvis", "/.clarvis/"]) {
    const root = await repo(`node_modules/\n${line}\n`);
    assert.equal((await checkIgnored(root)).ignored, true, `"${line}" should count`);
  }
});

test("a directory that is not a git repository needs nothing", async () => {
  // Nothing to make noisy, so nothing to offer.
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-nogit-"));
  const state = await checkIgnored(root);
  assert.equal(state.isRepo, false);
  assert.equal(state.ignored, true);
});

test("adding the entry preserves what was already there", async () => {
  const root = await repo("node_modules/\ndist/");
  const result = await addToGitignore(root);

  assert.equal(result.added, true);
  const content = await readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(content, /node_modules\//);
  assert.match(content, /dist\//);
  assert.match(content, /^\.clarvis\/$/m);
  // A missing trailing newline in the original must not join two entries.
  assert.equal(content.includes("dist/\n"), true);
  assert.equal(/dist\/\.clarvis/.test(content), false);
});

test("adding twice does not duplicate the entry", async () => {
  const root = await repo("node_modules/\n");
  await addToGitignore(root);
  const second = await addToGitignore(root);

  assert.equal(second.added, false);
  const content = await readFile(path.join(root, ".gitignore"), "utf8");
  assert.equal(content.match(/^\.clarvis\/$/gm)?.length, 1);
});

test("a non-repository is never written to", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-nogit-"));
  const result = await addToGitignore(root);
  assert.equal(result.added, false);
  await assert.rejects(() => stat(path.join(root, ".gitignore")));
});

/* ----------------------------------------------------------------- prune */

test("the most recent runs are kept and the rest deleted whole", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-prune-"));
  for (const id of ["20260801T0900-aaa", "20260802T0900-bbb", "20260803T0900-ccc", "20260804T0900-ddd"]) {
    await writeRun(root, run(id));
  }

  const result = await pruneRuns(root, 2);
  assert.deepEqual(result.kept, ["20260803T0900-ccc", "20260804T0900-ddd"]);
  assert.deepEqual(result.removed, ["20260801T0900-aaa", "20260802T0900-bbb"]);

  // Whole directories: a run.json left behind without its artifacts would look
  // like a run whose evidence had vanished.
  await assert.rejects(() => stat(path.join(clarvisPaths(root).runs, "20260801T0900-aaa")));
  await stat(path.join(clarvisPaths(root).runs, "20260804T0900-ddd", "run.json"));
});

test("nothing is deleted when the count is already under the limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-prune-"));
  await writeRun(root, run("20260801T0900-aaa"));

  const result = await pruneRuns(root, 10);
  assert.deepEqual(result.removed, []);
  assert.equal(result.freedBytes, 0);
});

test("freed space is measured, including artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-prune-"));
  await writeRun(root, run("20260801T0900-aaa"));
  await writeRun(root, run("20260802T0900-bbb"));

  // Traces are what actually fills the directory, not run.json.
  const traceDir = path.join(clarvisPaths(root).runs, "20260801T0900-aaa", "triage");
  await mkdir(traceDir, { recursive: true });
  await writeFile(path.join(traceDir, "trace.zip"), Buffer.alloc(50_000), "utf8");

  const result = await pruneRuns(root, 1);
  assert.ok(result.freedBytes > 50_000, "the trace must be counted, not just the json");
});

test("byte sizes are readable at every scale", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(14 * 1024 ** 2), "14.0 MB");
});
