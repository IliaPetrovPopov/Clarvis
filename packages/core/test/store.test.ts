import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listRunIds, newRunId, readRun, writeRun, clarvisPaths } from "../src/store.ts";
import type { Run } from "../src/types.ts";

const run = (runId: string): Run => ({
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  status: "passed",
  guard: { mode: "read-only", target: "localhost:3000" },
  axes: [],
  findings: [],
});

test("a run in progress does not break the list of finished ones", async () => {
  // The directory is created at the start and run.json only lands at the end.
  // Listing the empty one made the dashboard request a run that 404s, and the
  // failure took the whole list with it.
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-store-"));
  await writeRun(root, run("20260805T1000-aaaaaa"));
  await writeRun(root, run("20260805T1100-bbbbbb"));
  await mkdir(path.join(clarvisPaths(root).runs, "20260805T1200-inprog"), { recursive: true });

  assert.deepEqual(await listRunIds(root), ["20260805T1000-aaaaaa", "20260805T1100-bbbbbb"]);

  // And "latest" is the newest FINISHED run, not the one still going.
  assert.equal((await readRun(root, "latest")).runId, "20260805T1100-bbbbbb");
});

test("an unreadable run directory is skipped, not fatal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-store-"));
  await writeRun(root, run("20260805T1000-aaaaaa"));
  const bad = path.join(clarvisPaths(root).runs, "20260805T1300-broken");
  await mkdir(bad, { recursive: true });
  await writeFile(path.join(bad, "notes.txt"), "not a run", "utf8");

  assert.deepEqual(await listRunIds(root), ["20260805T1000-aaaaaa"]);
});

test("run ids sort chronologically as plain strings", () => {
  // "latest" is the last entry of a plain sort, so the format has to make that
  // true rather than needing a date parse.
  const a = newRunId(new Date("2026-08-05T09:00:00Z"));
  const b = newRunId(new Date("2026-08-05T11:00:00Z"));
  const c = newRunId(new Date("2026-08-06T01:00:00Z"));
  assert.deepEqual([c, a, b].sort(), [a, b, c]);
});

test("no runs at all is an empty list, not a throw", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-store-"));
  assert.deepEqual(await listRunIds(root), []);
  await assert.rejects(() => readRun(root, "latest"), /No runs found/);
});

test("the boot blocker names the directory that actually exists", async () => {
  // It said ".qa/profile.json" for a while after the rename - a path nobody
  // could act on, in the message whose only job is telling someone what to do.
  const { bootAndVerify } = await import("../src/boot.ts");
  const boot = await bootAndVerify({
    schemaVersion: 1,
    project: { name: "x", root: "/tmp" },
    boot: { url: "http://localhost:59999", verified: false },
    auth: { mode: "none", roles: [] },
    data: { disposable: false, safeTargets: [] },
  });

  assert.equal(boot.verified, false);
  assert.ok(boot.blockers.some((b) => b.includes(".clarvis/profile.json")));
  assert.equal(boot.blockers.some((b) => b.includes(".qa/")), false);
});
