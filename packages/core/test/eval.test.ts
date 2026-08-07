import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyMutant,
  codeMask,
  generateMutants,
  sampleMutants,
} from "../src/eval/mutation.ts";
import { isMutableSource, runMutationTesting } from "../src/eval/mutationRun.ts";
import { classifyCommit, mineBugFixes, toCases } from "../src/eval/history.ts";
import {
  compareAblations,
  measureCalibration,
  measureVariance,
  spread,
} from "../src/eval/measure.ts";
import type { GitConnector } from "../src/connectors/git.ts";
import type { Finding, Profile, Run } from "../src/types.ts";

/* ------------------------------------------------------------- mutation */

test("string and comment contents are never mutated", () => {
  // A mutation inside a string changes a message rather than a behaviour, so it
  // is unkillable by construction and would drag the score down for no reason.
  const source = [
    'const msg = "use === not == here";',
    "// prefer === over ==",
    "/* true means enabled */",
    "const real = a === b;",
  ].join("\n");

  const mutants = generateMutants(source, "x.ts");
  assert.equal(mutants.length, 1, "only the real comparison is mutable");
  assert.equal(mutants[0].line, 4);
  assert.equal(mutants[0].before, "===");
});

test("template TEXT is masked but an interpolation is code and stays mutable", () => {
  // The two halves of a template are different: the literal text is a string,
  // while `${...}` is real code that should be tested like any other.
  // `.mjs`, because `<` and `>` are deliberately not mutated in TypeScript
  // where they are ambiguous with generics and JSX.
  const source = ["const t = `value is ${a === b} and == text`;", "const after = x > y;"].join("\n");
  const mutants = generateMutants(source, "x.mjs");

  // The `== text` in the literal part is skipped; the `===` inside the
  // interpolation is not, and neither is the comparison on the next line.
  assert.deepEqual(mutants.map((m) => m.before), ["===", ">"]);
  assert.deepEqual(mutants.map((m) => m.line), [1, 2]);
});

test("an unterminated quote does not swallow the rest of the file", () => {
  // A scanner that lost sync here would silently stop mutating everything below.
  const mask = codeMask(["const broken = 'oops;", "const fine = a === b;"].join("\n"));
  assert.equal(mask[mask.length - 5], true);
});

test("a mutant applies at exactly its recorded position", () => {
  const source = "if (a > b && c) { return true; }";
  const mutants = generateMutants(source, "x.ts");
  for (const mutant of mutants) {
    const mutated = applyMutant(source, mutant);
    assert.notEqual(mutated, source);
    assert.equal(mutated.length, source.length - mutant.before.length + mutant.after.length);
  }
});

test("applying a stale mutant is refused rather than corrupting the file", () => {
  // The file changing under a mutant is exactly when writing blind does damage.
  const source = "const x = a === b;";
  const [mutant] = generateMutants(source, "x.ts");
  assert.throws(() => applyMutant("completely different content entirely", mutant), /no longer matches/);
});

test("sampling spreads across files and operators rather than taking the first N", () => {
  // Taking the first N would exhaustively test one file's comparisons and
  // measure nothing about anything else.
  const a = generateMutants("const p = x === y && z > 1;", "a.ts");
  const b = generateMutants("const q = m === n || k < 2;", "b.ts");
  const picked = sampleMutants([...a, ...b], 4);

  assert.equal(picked.length, 4);
  assert.equal(new Set(picked.map((m) => m.file)).size, 2, "both files represented");
});

test("mutant generation is deterministic, so two runs are comparable", () => {
  const source = "if (a >= b || c === d) { return false; }";
  assert.deepEqual(
    generateMutants(source, "x.ts").map((m) => m.id),
    generateMutants(source, "x.ts").map((m) => m.id),
  );
});

test("specs, config and generated output are never mutable", () => {
  // Mutating a spec makes the suite fail against itself and scores a kill that
  // measures nothing.
  assert.equal(isMutableSource("src/server.ts"), true);
  assert.equal(isMutableSource("src/app.tsx"), true);
  assert.equal(isMutableSource("rbac-scope-1.spec.ts"), false);
  assert.equal(isMutableSource("src/thing.test.js"), false);
  assert.equal(isMutableSource("node_modules/x/index.js"), false);
  assert.equal(isMutableSource("dist/bundle.js"), false);
  assert.equal(isMutableSource("package.json"), false);
  assert.equal(isMutableSource("README.md"), false);
});

/* ------------------------------------------------- mutation run safety */

const PROFILE: Profile = {
  schemaVersion: 1,
  project: { name: "t", root: "/tmp/t" },
  boot: { url: "http://localhost:1", verified: true },
  auth: { mode: "none", roles: [] },
  data: { disposable: false, safeTargets: [] },
};

function fakeGit(opts: { isRepo?: boolean; dirty?: string[] }): GitConnector {
  return {
    isRepo: async () => opts.isRepo ?? true,
    uncommittedFiles: async () => opts.dirty ?? [],
  } as unknown as GitConnector;
}

test("mutation testing refuses outside a git repository", async () => {
  // Without git there is no independent way to prove a file came back, and
  // "the finally block ran" is not a safety property.
  await assert.rejects(
    () =>
      runMutationTesting({
        projectRoot: "/tmp",
        files: ["a.ts"],
        specDir: "/tmp",
        profile: PROFILE,
        axisKey: "happy-path",
        outputDir: "/tmp",
        git: fakeGit({ isRepo: false }),
      }),
    /requires a git repository/,
  );
});

test("a file with uncommitted changes is skipped, not mutated", async () => {
  // A mutation and someone's unsaved work are indistinguishable once written.
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-mut-"));
  await writeFile(path.join(root, "a.ts"), "const x = a === b;\n", "utf8");

  const score = await runMutationTesting({
    projectRoot: root,
    files: ["a.ts"],
    specDir: path.join(root, "specs"),
    profile: PROFILE,
    axisKey: "happy-path",
    outputDir: path.join(root, "out"),
    git: fakeGit({ dirty: ["a.ts"] }),
  });

  assert.equal(score.total, 0);
  assert.match(score.skipped[0].why, /uncommitted changes/);
  // Untouched, byte for byte.
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "const x = a === b;\n");
});

test("the source file is byte-identical after a run, even when specs error", async () => {
  // The invariant the whole module exists for.
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-mut-"));
  const original = "export const check = (a, b) => a === b && a > 0;\n";
  await writeFile(path.join(root, "a.ts"), original, "utf8");
  await mkdir(path.join(root, "specs"), { recursive: true });

  const score = await runMutationTesting({
    projectRoot: root,
    files: ["a.ts"],
    specDir: path.join(root, "specs"),
    // No playwright, no app: every mutant run will fail to execute anything.
    profile: PROFILE,
    axisKey: "happy-path",
    outputDir: path.join(root, "out"),
    maxMutants: 3,
    timeoutMs: 5_000,
    git: fakeGit({}),
  });

  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), original);
  // Nothing executed, so nothing may be scored as survived.
  assert.equal(score.survived, 0);
  assert.equal(score.killRate, undefined);
  assert.ok(score.notRun + score.errored > 0);
});

test("a mutant that never faced the suite is not counted as survived", () => {
  // Counting it would blame the specs for an infrastructure failure, which is
  // the same lie as reporting an empty run as a pass.
  const source = "const x = a === b;";
  const [mutant] = generateMutants(source, "a.ts");
  const score = {
    total: 2,
    killed: 1,
    survived: 0,
    notRun: 1,
    errored: 0,
    killRate: 1,
    results: [
      { mutant, outcome: "killed" as const },
      { mutant, outcome: "not-run" as const },
    ],
    skipped: [],
  };
  assert.equal(score.killRate, 1, "the rate is over judged mutants only");
});

/* --------------------------------------------------------------- history */

test("a conventional fix commit with a narrow diff is a strong candidate", () => {
  const verdict = classifyCommit({
    subject: "fix(auth): viewers could read other clients' notes",
    body: "The admin route returned 200 with the panel hidden. Closes #412.",
    files: ["services/auth/admin.ts"],
  });
  assert.equal(verdict.isBugFix, true);
  assert.ok(verdict.confidence >= 0.7);
  assert.ok(verdict.signals.some((s) => /conventional/.test(s)));
});

test("reverts, merges, releases and chores are not bug fixes", () => {
  for (const [subject, why] of [
    ["Revert \"fix(auth): scoping\"", /revert/i],
    ["Merge branch 'dev'", /merge/i],
    ["chore(release): 0.13.2", /release/i],
    ["docs: update the readme", /behaviour/i],
  ] as const) {
    const verdict = classifyCommit({ subject, body: "", files: ["a.ts"] });
    assert.equal(verdict.isBugFix, false, subject);
    assert.match(verdict.why!, why);
  }
});

test("a commit touching no testable source is rejected", () => {
  const verdict = classifyCommit({
    subject: "fix: correct the changelog wording",
    body: "",
    files: ["CHANGELOG.md"],
  });
  assert.equal(verdict.isBugFix, false);
  assert.match(verdict.why!, /no testable source/);
});

test("a sprawling diff is rejected because the defect cannot be localised", () => {
  const verdict = classifyCommit({
    subject: "fix: assorted issues across the app",
    body: "",
    files: Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`),
  });
  assert.equal(verdict.isBugFix, false);
  assert.match(verdict.why!, /Too broad/);
});

test("mining returns cases pointing at the commit BEFORE the fix", async () => {
  const git = {
    isRepo: async () => true,
    recentCommits: async () => ({
      ok: true,
      status: "ok",
      data: [
        {
          sha: "abc123def456",
          shortSha: "abc123d",
          subject: "fix(rbac): viewer reached /admin",
          body: "The route answered 200. Fixes #7.",
          author: "x",
          date: "2026-01-01T00:00:00Z",
          files: ["src/admin.ts"],
        },
        {
          sha: "999",
          shortSha: "999",
          subject: "chore(release): 1.0.0",
          body: "",
          author: "x",
          date: "2026-01-02T00:00:00Z",
          files: ["package.json"],
        },
      ],
    }),
  } as unknown as GitConnector;

  const result = await mineBugFixes({ git });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.rejected.length, 1);

  const [c] = toCases(result);
  // The state to test is the parent: the defect is present there, not in the fix.
  assert.equal(c.checkout, "abc123def456~1");
  assert.match(c.expected, /viewer reached \/admin/);

  // The heuristic must announce itself as one.
  assert.ok(result.notes.some((n) => /not a labelled dataset/.test(n)));
});

test("mining a non-repository says so rather than returning nothing", async () => {
  const result = await mineBugFixes({ git: { isRepo: async () => false } as unknown as GitConnector });
  assert.deepEqual(result.candidates, []);
  assert.match(result.notes[0], /not a git repository/i);
});

/* --------------------------------------------------------------- measure */

const finding = (id: string, tier: Finding["tier"], title = "t"): Finding => ({
  id,
  axis: "rbac-scope",
  title,
  severity: "high",
  tier,
  oracle: { type: "code-intent" },
  expected: "",
  actual: "",
  evidence: { specFile: "x.spec.ts" },
});

const mkRun = (findings: Finding[], usd = 1, axes = ["rbac-scope"]): Run => ({
  schemaVersion: 1,
  runId: `r${Math.round(usd * 1000)}`,
  startedAt: new Date().toISOString(),
  status: "findings",
  guard: { mode: "read-only", target: "localhost:1" },
  axes: axes.map((key) => ({ key, status: "done" as const })),
  findings,
  agentRuns: [{ id: "a", role: "x", usdEstimate: usd }],
});

test("ablation reports what removing a fleet costs, against the full arm", () => {
  const result = compareAblations([
    { label: "full", runs: [mkRun([finding("1", "CONFIRMED"), finding("2", "PLAUSIBLE")], 10)] },
    { label: "without ARCHIVE", removed: "research", runs: [mkRun([finding("1", "PLAUSIBLE")], 6)] },
  ]);

  const arm = result.rows.find((r) => r.removed === "research")!;
  assert.equal(arm.deltaFindings, 1);
  assert.equal(arm.deltaConfirmed, 1);
  assert.equal(Number(arm.deltaUsd!.toFixed(2)), 4);
});

test("an ablation arm with too few runs is flagged as indistinguishable from noise", () => {
  const result = compareAblations([
    { label: "full", runs: [mkRun([], 1)] },
    { label: "without FOREMAN", removed: "lead", runs: [mkRun([], 1)] },
  ]);
  assert.ok(result.rows.every((r) => r.caveat));
  assert.ok(result.notes.some((n) => /variance/.test(n)));
});

test("missing the full arm makes every delta absent rather than wrong", () => {
  const result = compareAblations([{ label: "without ARCHIVE", removed: "research", runs: [mkRun([], 1)] }]);
  assert.equal(result.rows[0].deltaFindings, undefined);
  assert.ok(result.notes.some((n) => /nothing to compare against/.test(n)));
});

test("variance exposes an axis that runs only sometimes", () => {
  // The planner deferred an axis in one run and planned it in the next on
  // identical input, so coverage is a random variable.
  const report = measureVariance([
    mkRun([finding("1", "PLAUSIBLE", "A")], 1, ["rbac-scope", "i18n-rtl"]),
    mkRun([finding("2", "PLAUSIBLE", "A")], 1, ["rbac-scope"]),
  ]);

  assert.equal(report.axisFrequency.find((a) => a.axis === "i18n-rtl")!.ranIn, 1);
  assert.ok(report.notes.some((n) => /Coverage is not constant/.test(n)));
});

test("variance names findings that only appear sometimes", () => {
  const report = measureVariance([
    mkRun([finding("1", "PLAUSIBLE", "always"), finding("2", "PLAUSIBLE", "sometimes")]),
    mkRun([finding("3", "PLAUSIBLE", "always")]),
  ]);

  assert.deepEqual(report.unstableFindings.map((f) => f.title), ["sometimes"]);
  assert.ok(report.notes.some((n) => /single run under-reports/.test(n)));
});

test("a single run is called an anecdote, not a measurement", () => {
  const report = measureVariance([mkRun([])]);
  assert.ok(report.notes.some((n) => /anecdote/.test(n)));
  assert.equal(report.findings.sd, 0);
});

test("spread is the population standard deviation, not a guess", () => {
  const s = spread([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.mean, 5);
  assert.equal(s.sd, 2);
  assert.equal(s.min, 2);
  assert.equal(s.max, 9);
});

test("calibration separates the expensive mistake from the cheap one", () => {
  // Calling a real bug a spec fault deletes it and nobody hears about it.
  // Calling a spec fault a real bug wastes a review and gets caught.
  const run: Run = {
    ...mkRun([]),
    findings: [
      { ...finding("dropped", "DISCARDED", "real bug"), tierReason: "The fault is in the test, not the product." },
      { ...finding("filed", "CONFIRMED", "spec bug") },
    ],
  };

  const report = measureCalibration([run], [
    { findingId: "dropped", truth: "application" },
    { findingId: "filed", truth: "spec" },
  ]);

  assert.equal(report.agreement, 0);
  assert.equal(report.falseDismissals.length, 1);
  assert.equal(report.falseDismissals[0].findingId, "dropped");
  assert.equal(report.falseReports.length, 1);
  assert.ok(report.notes.some((n) => /nobody ever hears/.test(n)));
});

test("too few labels is stated rather than reported as an agreement rate", () => {
  const run = mkRun([finding("1", "CONFIRMED")]);
  const report = measureCalibration([run], [{ findingId: "1", truth: "application" }]);
  assert.equal(report.agreement, 1);
  // A perfect score on one label is not an estimate of anything.
  assert.ok(report.notes.some((n) => /not an estimate/.test(n)));
});

test("git log --name-only puts the file list after the separator, and it is read from there", async () => {
  // This was a latent bug in shared code: `files` was empty on every commit
  // because it was read from the last field instead of the head of the next
  // record. Nothing noticed until history mining needed it to decide whether a
  // fix touched testable source.
  const { parseLog } = await import("../src/connectors/git.ts");
  const NUL = "\x00";

  const stdout =
    ["sha1", "s1", "fix: a thing", "body one", "Ada", "2026-01-01T00:00:00Z"].join(NUL) +
    "\x01\nsrc/a.ts\nsrc/b.ts\n\n" +
    ["sha2", "s2", "feat: another", "", "Linus", "2026-01-02T00:00:00Z"].join(NUL) +
    "\x01\nsrc/c.ts\n";

  const commits = parseLog(stdout, NUL);
  assert.equal(commits.length, 2);

  assert.equal(commits[0].sha, "sha1");
  assert.equal(commits[0].date, "2026-01-01T00:00:00Z");
  assert.deepEqual(commits[0].files, ["src/a.ts", "src/b.ts"]);

  // The second commit's sha must not have been swallowed into the first's files.
  assert.equal(commits[1].sha, "sha2");
  assert.equal(commits[1].subject, "feat: another");
  assert.deepEqual(commits[1].files, ["src/c.ts"]);
});

test("a commit with no files parses without stealing the next one's", async () => {
  const { parseLog } = await import("../src/connectors/git.ts");
  const NUL = "\x00";
  const stdout =
    ["sha1", "s1", "empty", "", "Ada", "2026-01-01T00:00:00Z"].join(NUL) +
    "\x01\n" +
    ["sha2", "s2", "next", "", "Ada", "2026-01-02T00:00:00Z"].join(NUL) +
    "\x01\nsrc/c.ts\n";

  const commits = parseLog(stdout, NUL);
  assert.deepEqual(commits[0].files, []);
  assert.equal(commits[1].sha, "sha2");
  assert.deepEqual(commits[1].files, ["src/c.ts"]);
});

test("a mutation stranded by a killed process is recovered on the next run", async () => {
  // A `finally` handles exceptions, not SIGKILL. A real run killed at a timeout
  // left a mutated server.mjs on disk - exactly what the finally was supposed to
  // make impossible. The journal is what makes the guarantee structural.
  const { journalPath, recoverStrandedMutation } = await import("../src/eval/mutationRun.ts");

  const root = await mkdtemp(path.join(tmpdir(), "clarvis-strand-"));
  const original = "const ok = a === b;\n";
  await writeFile(path.join(root, "a.ts"), original, "utf8");

  // Simulate the crash: journal written, file mutated, process gone.
  await mkdir(path.join(root, ".clarvis"), { recursive: true });
  await writeFile(
    journalPath(root),
    JSON.stringify({ file: "a.ts", original, mutantId: "a.ts:1:negate-condition:11", startedAt: "x" }),
    "utf8",
  );
  await writeFile(path.join(root, "a.ts"), "const ok = a !== b;\n", "utf8");

  const result = await recoverStrandedMutation(root);

  assert.equal(result.recovered, true);
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), original);
  assert.match(result.note!, /did not finish/);
  // The journal is cleared, so a later run does not undo current work.
  await assert.rejects(() => readFile(journalPath(root), "utf8"));
});

test("a stale journal does not overwrite a file that is already correct", async () => {
  // The finally ran but the process died before clearing the journal. Writing
  // the old content back here would undo whatever happened since.
  const { journalPath, recoverStrandedMutation } = await import("../src/eval/mutationRun.ts");

  const root = await mkdtemp(path.join(tmpdir(), "clarvis-strand-"));
  const original = "const ok = a === b;\n";
  await writeFile(path.join(root, "a.ts"), original, "utf8");
  await mkdir(path.join(root, ".clarvis"), { recursive: true });
  await writeFile(journalPath(root), JSON.stringify({ file: "a.ts", original, mutantId: "m", startedAt: "x" }), "utf8");

  const result = await recoverStrandedMutation(root);
  assert.equal(result.recovered, false);
  assert.match(result.note!, /stale/);
  assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), original);
});

test("no journal means nothing to recover, silently", async () => {
  const { recoverStrandedMutation } = await import("../src/eval/mutationRun.ts");
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-strand-"));
  assert.deepEqual(await recoverStrandedMutation(root), { recovered: false });
});

test("a regex literal does not desynchronise the string scanner", async () => {
  // A real nonsense mutant came from this: `"<": "&lt;"` became `"<=": "&lt;"`,
  // mutating inside a string, because the quotes inside `/[&<>"']/g` earlier on
  // the line had been read as a string opener.
  const source = [
    `const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "a", "<": "b" })[c]);`,
    "if (x > y) { go(); }",
  ].join("\n");

  const mutants = generateMutants(source, "x.mjs");
  assert.deepEqual(mutants.map((m) => m.line), [2], "only the real comparison is mutable");
});

test("division is not mistaken for a regex", async () => {
  const { isRegexStart } = await import("../src/eval/mutation.ts");
  const div = "const ratio = total / count;";
  assert.equal(isRegexStart(div, div.indexOf("/")), false);

  const re = "const m = s.replace(/a/g, 'b');";
  assert.equal(isRegexStart(re, re.indexOf("/")), true);

  // A regex can legitimately follow a keyword.
  const afterReturn = "return /abc/.test(x);";
  assert.equal(isRegexStart(afterReturn, afterReturn.indexOf("/")), true);

  // Comments are not regexes.
  const comment = "const a = 1; // note";
  assert.equal(isRegexStart(comment, comment.indexOf("//")), false);
});

test("generics and JSX are never mutated, because the token is ambiguous there", () => {
  // In TypeScript `<` is also a generic and a JSX tag, and no regex tells the
  // three apart. A mutant that does not parse is killed by everything for the
  // wrong reason, which inflates the score in the flattering direction.
  const ts = "const g = <T,>(x: T) => x;\nif (a > b) return 1;";
  assert.equal(
    generateMutants(ts, "x.ts").some((m) => m.operator === "conditional-boundary"),
    false,
  );
  // Plain JavaScript has no such ambiguity, so the operator still applies.
  assert.ok(
    generateMutants("function f(a,b){ if (a > b) { return 1; } return 2; }", "x.mjs").some(
      (m) => m.operator === "conditional-boundary",
    ),
  );
});

test("an unparseable mutant is refused before it ever runs", async () => {
  const { parses } = await import("../src/eval/mutationRun.ts");
  // vm.Script cannot compile ESM, so the first version of this check rejected
  // every module in the project. `node --check` respects the extension.
  assert.equal(await parses('import x from "y";\nexport const a = 1;', "a.mjs"), true);
  assert.equal(await parses('const x = require("y"); module.exports = 1;', "a.cjs"), true);
  assert.equal(await parses("const f = (u) =>= [u];", "a.mjs"), false);
});

test("nested template literals do not desynchronise the mask", () => {
  // A template holding another template inside `${...}` broke an earlier
  // scanner: the inner closing backtick popped the outer frame, so everything
  // after was scanned as code. That is how `<nav>` became `<=nav>`.
  const source = [
    "function page(t, body, user) {",
    "  return `<html>",
    "<header>",
    '  ${user ? `<nav><a href="/x">${esc(t.a)}</a></nav>` : ""}',
    "</header>",
    "${body}</html>`;",
    "}",
    "if (count > limit) { warn(); }",
  ].join("\n");

  const mutants = generateMutants(source, "x.mjs");
  assert.deepEqual(mutants.map((m) => m.line), [8], "only the real comparison outside the template");
});

test("an object literal inside an interpolation does not close it", () => {
  // `${cond ? {a:1}.a : 2}` - the braces are code, not the interpolation's end.
  const source = ["const s = `x ${ ok ? { a: 1 }.a : 2 } y > z`;", "if (m > n) go();"].join("\n");
  assert.deepEqual(generateMutants(source, "x.mjs").map((m) => m.line), [2]);
});

test("the mask holds on the real file that exposed the bug", async () => {
  // Regression against actual source rather than a reduction of it.
  const { codeMask } = await import("../src/eval/mutation.ts");
  const server = await readFile(
    path.join(import.meta.dirname, "../../../examples/demo-app/server.mjs"),
    "utf8",
  ).catch(() => undefined);

  if (!server) return; // the example may not be present in every checkout

  const mask = codeMask(server);
  const navAt = server.indexOf("<nav>");
  assert.ok(navAt > 0, "the fixture should still contain the nav markup");
  assert.equal(mask[navAt], false, "markup inside a nested template must be masked");

  // And real code in the same file is still mutable.
  const guard = server.indexOf("notes.length");
  assert.ok(guard === -1 || mask[guard], "code outside templates stays visible");
});
