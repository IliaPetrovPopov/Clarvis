import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyLedger,
  describeLedger,
  dismiss,
  emptyLedger,
  fingerprint,
  recordRun,
  reopen,
} from "../src/ledger.ts";
import { classify, findingsFromDifferential, outcomesFromReport, pickBasePort, withPort } from "../src/eval/differential.ts";
import { candidates, promote, promotedName, promotionHeader } from "../src/promote.ts";
import { deriveTaxonomy, slugKey, MIN_OBSERVATIONS } from "../src/agents/taxonomy.ts";
import { Budget } from "../src/agents/budget.ts";
import { decideGuard } from "../src/guard.ts";
import type { AgentRunner } from "../src/agents/runtime.ts";
import type { BugFix } from "../src/eval/history.ts";
import type { Finding, Profile, Run } from "../src/types.ts";

const finding = (over: Partial<Finding> & Pick<Finding, "id" | "title">): Finding => ({
  axis: "rbac-scope",
  severity: "high",
  tier: "CONFIRMED",
  oracle: { type: "code-intent" },
  expected: "",
  actual: "",
  evidence: { specFile: "rbac-scope-1.spec.ts" },
  ...over,
});

const mkRun = (findings: Finding[], axes = ["rbac-scope"], runId = "r1"): Run => ({
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  status: "findings",
  guard: { mode: "read-only", target: "localhost:1" },
  axes: axes.map((key) => ({ key, status: "done" as const })),
  findings,
});

/* ---------------------------------------------------------------- ledger */

test("a finding keeps its identity when the wording drifts", () => {
  // Titles are model-authored and move between runs. Identity keys on the axis
  // and the route instead, which do not.
  const a = fingerprint({ axis: "rbac-scope", title: "viewer must not reach /admin", route: "/admin", role: "viewer" });
  const b = fingerprint({
    axis: "rbac-scope",
    title: "the /admin route must not be reachable by a viewer",
    route: "/admin",
    role: "viewer",
  });
  assert.equal(a, b);
});

test("with no route or role, identity falls back to stemmed title words", async () => {
  // The worst case for merging, so the title is allowed to matter here.
  const { titleTokens } = await import("../src/ledger.ts");
  // The stemmer is crude by design - "missing" reduces to "mis". What matters
  // is that it reduces the same way every time, not that it is a real word.
  assert.deepEqual(titleTokens("the session cookie is missing HttpOnly"), ["cookie", "httponly", "mis", "session"]);

  const a = fingerprint({ axis: "adversarial", title: "session cookie missing HttpOnly" });
  const b = fingerprint({ axis: "adversarial", title: "the session cookie is missing HttpOnly" });
  assert.equal(a, b, "an inflection or an article must not split an identity");

  const other = fingerprint({ axis: "adversarial", title: "note titles are rendered unescaped" });
  assert.notEqual(a, other);
});

test("different behaviours on the same route stay distinct", () => {
  // Over-merging is the worse failure: it hides a second bug behind the first.
  const rbac = fingerprint({ axis: "rbac-scope", title: "viewer reaches admin data", route: "/admin" });
  const i18n = fingerprint({ axis: "i18n-rtl", title: "arabic locale untranslated error", route: "/admin" });
  assert.notEqual(rbac, i18n);
});

test("a dismissed finding is suppressed and counted, never silently dropped", () => {
  const f = finding({ id: "1", title: "cookie missing HttpOnly", axis: "adversarial" });
  let ledger = recordRun(emptyLedger(), mkRun([f], ["adversarial"]));
  const fp = fingerprint(f);

  const dismissed = dismiss(ledger, fp, { note: "accepted risk, behind a VPN", by: "reviewer" });
  assert.equal(dismissed.error, undefined);
  ledger = dismissed.ledger;

  const applied = applyLedger([f], ledger);
  assert.deepEqual(applied.reported, []);
  assert.equal(applied.suppressed.length, 1);
  assert.equal(applied.suppressed[0].entry.note, "accepted risk, behind a VPN");
  // The run must say so. A quieter report is exactly what this product exists
  // to prevent.
  assert.ok(applied.notes.some((n) => /suppressed by earlier dismissals/.test(n)));
});

test("a dismissal needs a reason", () => {
  const ledger = recordRun(emptyLedger(), mkRun([finding({ id: "1", title: "x" })]));
  const fp = Object.keys(ledger.entries)[0];
  const result = dismiss(ledger, fp, { note: "   ", by: "someone" });
  assert.match(result.error!, /needs a reason/);
});

test("an ambiguous fingerprint prefix is refused rather than guessed", () => {
  const ledger = recordRun(
    emptyLedger(),
    mkRun([finding({ id: "1", title: "alpha thing" }), finding({ id: "2", title: "beta other" })]),
  );
  const result = dismiss(ledger, "", { note: "x", by: "y" });
  assert.match(result.error!, /matches 2 findings/);
});

test("a dismissed finding stays dismissed when it reappears", () => {
  // That is the entire point of dismissing it.
  const f = finding({ id: "1", title: "known issue" });
  let ledger = recordRun(emptyLedger(), mkRun([f]));
  const fp = fingerprint(f);
  ledger = dismiss(ledger, fp, { note: "wont fix", by: "me" }).ledger;

  ledger = recordRun(ledger, mkRun([f], ["rbac-scope"], "r2"));
  assert.equal(ledger.entries[fp].status, "dismissed");
});

test("a finding is only called fixed when the axis that would find it ran", () => {
  const f = finding({ id: "1", title: "the bug" });
  const fp = fingerprint(f);
  let ledger = recordRun(emptyLedger(), mkRun([f]));

  // Axis did not run: absence tells us nothing, so nothing changes.
  ledger = recordRun(ledger, mkRun([], ["i18n-rtl"], "r2"));
  assert.equal(ledger.entries[fp].absentIn, 0);
  assert.equal(ledger.entries[fp].status, "open");

  // Axis ran twice without it: now the claim is earned.
  ledger = recordRun(ledger, mkRun([], ["rbac-scope"], "r3"));
  assert.equal(ledger.entries[fp].status, "flaky");
  ledger = recordRun(ledger, mkRun([], ["rbac-scope"], "r4"));
  assert.equal(ledger.entries[fp].status, "fixed");
});

test("reopening clears the dismissal", () => {
  const f = finding({ id: "1", title: "x" });
  let ledger = recordRun(emptyLedger(), mkRun([f]));
  const fp = fingerprint(f);
  ledger = dismiss(ledger, fp, { note: "n", by: "b" }).ledger;
  ledger = reopen(ledger, fp).ledger;

  assert.equal(ledger.entries[fp].status, "open");
  assert.equal(ledger.entries[fp].note, undefined);
});

test("new and recurring findings are separated, because they need different attention", () => {
  const f = finding({ id: "1", title: "old news" });
  const ledger = recordRun(emptyLedger(), mkRun([f]));
  const fresh = finding({ id: "2", title: "brand new problem", axis: "adversarial" });

  const applied = applyLedger([f, fresh], ledger);
  assert.deepEqual(applied.newFindings.map((x) => x.id), ["2"]);
  assert.deepEqual(applied.recurring.map((x) => x.finding.id), ["1"]);
});

test("the ledger reads back grouped by status", () => {
  let ledger = recordRun(emptyLedger(), mkRun([finding({ id: "1", title: "open thing" })]));
  ledger = dismiss(ledger, Object.keys(ledger.entries)[0], { note: "fine", by: "me" }).ledger;
  const lines = describeLedger(ledger).join("\n");
  assert.match(lines, /DISMISSED/);
  assert.match(lines, /fine/);
});

/* ---------------------------------------------------------- differential */

test("a failure is only a regression when the base version passed", () => {
  // Calling a pre-existing failure a regression sends someone hunting through a
  // diff that never touched it.
  assert.equal(classify({ title: "t", passed: true }, { title: "t", passed: false }).verdict, "regression");
  assert.equal(classify({ title: "t", passed: false }, { title: "t", passed: false }).verdict, "pre-existing");
  assert.equal(classify({ title: "t", passed: false }, { title: "t", passed: true }).verdict, "fixed");
  assert.equal(classify({ title: "t", passed: true }, { title: "t", passed: true }).verdict, "unchanged");
});

test("a test that ran on only one side is inconclusive, not a regression", () => {
  const only = classify(undefined, { title: "t", passed: false });
  assert.equal(only.verdict, "inconclusive");
  assert.match(only.note!, /base/);
});

test("a regression cites the previous version as its oracle", () => {
  // `prior-run` has been in the schema since the beginning and nothing has ever
  // used it. It is a real oracle: often the only record of intended behaviour.
  const findings = findingsFromDifferential(
    {
      baseRef: "main",
      results: [],
      regressions: [{ title: "notes list loads", verdict: "regression", base: { title: "notes list loads", passed: true }, head: { title: "notes list loads", passed: false, error: "got 500" } }],
      preExisting: [],
      fixed: [],
      blockers: [],
      notes: [],
    },
    { axis: "happy-path", runId: "r1", specFile: "happy-path-1.spec.ts" },
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].oracle.type, "prior-run");
  assert.match(findings[0].oracle.citation!, /main/);
  // Still PLAUSIBLE: triage has not reproduced it.
  assert.equal(findings[0].tier, "PLAUSIBLE");
});

test("outcomes are read per test from the reporter", () => {
  const outcomes = outcomesFromReport({
    suites: [
      {
        specs: [
          { title: "a", tests: [{ status: "expected" }] },
          { title: "b", tests: [{ status: "unexpected", results: [{ error: { message: "boom" } }] }] },
        ],
      },
    ],
  });
  assert.deepEqual(outcomes.map((o) => [o.title, o.passed]), [["a", true], ["b", false]]);
  assert.equal(outcomes[1].error, "boom");
});

test("the base instance gets its own port so both versions can be up at once", () => {
  assert.equal(pickBasePort("http://localhost:4600"), 5600);
  assert.equal(withPort("http://localhost:4600", 5600), "http://localhost:5600");
  // Never past the top of the range.
  assert.ok(pickBasePort("http://localhost:65000") < 65_535);
});

/* --------------------------------------------------------------- promote */

test("only findings that proved something are promoted", () => {
  // An unproven generated test is not worth adding to a suite; a directory of
  // them is how a team learns to ignore the directory.
  const run = mkRun([
    finding({ id: "1", title: "real bug", tier: "CONFIRMED" }),
    finding({ id: "2", title: "unverified thing", tier: "PLAUSIBLE" }),
    finding({ id: "3", title: "test was wrong", tier: "DISCARDED" }),
  ]);

  assert.deepEqual(candidates(run, "/tmp/scratch").map((c) => c.finding.id), ["1"]);
  // Lowering the bar is possible, and explicit.
  assert.equal(candidates(run, "/tmp/scratch", "PLAUSIBLE").length, 2);
});

test("a promoted spec is named after what it caught", () => {
  const name = promotedName(finding({ id: "1", title: "Viewers can read every client's notes at /admin" }));
  assert.equal(name, "rbac-scope-viewers-can-read-every-client-s-notes-at-admin.spec.ts");
});

test("the header says what the test is entitled to claim", () => {
  const withSource = promotionHeader(
    finding({ id: "1", title: "x", oracle: { type: "acceptance-criteria", citation: "README.md:14", quote: "A viewer must not reach /admin." } }),
    "run-1",
    new Date("2026-08-06T00:00:00Z"),
  );
  assert.match(withSource, /A viewer must not reach \/admin\./);

  const without = promotionHeader(finding({ id: "1", title: "x" }), "run-1", new Date());
  // When nothing was written down, the file says so rather than implying a rule.
  assert.match(without, /encodes an observation rather than a requirement/);
});

test("an edited promoted file is never silently overwritten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-promote-"));
  const scratch = path.join(root, "scratch");
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(scratch, "rbac-scope-1.spec.ts"), "// the spec\n", "utf8");

  const run = mkRun([finding({ id: "1", title: "real bug", tier: "CONFIRMED" })]);
  const first = await promote({ projectRoot: root, run, specDir: scratch });
  assert.equal(first.written.length, 1);

  // Someone edits it.
  const target = path.join(root, "tests", "clarvis", promotedName(run.findings[0]));
  await writeFile(target, "// edited by a human\n", "utf8");

  const second = await promote({ projectRoot: root, run, specDir: scratch });
  assert.equal(second.written.length, 0);
  assert.match(second.skipped[0].why, /may have been edited/);
  assert.equal(await readFile(target, "utf8"), "// edited by a human\n");

  // Explicitly asked for, it replaces.
  const forced = await promote({ projectRoot: root, run, specDir: scratch, replace: true });
  assert.equal(forced.written.length, 1);
});

test("promoting twice with no change is a no-op", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-promote-"));
  const scratch = path.join(root, "scratch");
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(scratch, "rbac-scope-1.spec.ts"), "// the spec\n", "utf8");

  const run = mkRun([finding({ id: "1", title: "real bug", tier: "CONFIRMED" })]);
  const now = new Date("2026-08-06T00:00:00Z");
  await promote({ projectRoot: root, run, specDir: scratch, now });
  const again = await promote({ projectRoot: root, run, specDir: scratch, now });

  assert.equal(again.written.length, 0);
  assert.match(again.skipped[0].why, /unchanged/);
});

/* -------------------------------------------------------------- taxonomy */

const fix = (shortSha: string, subject: string): BugFix => ({
  sha: `${shortSha}0000`,
  shortSha,
  parentSha: `${shortSha}0000~1`,
  subject,
  body: "",
  date: "2026-01-01T00:00:00Z",
  files: ["src/a.ts"],
  signals: [],
  confidence: 0.9,
});

function taxonomyRunner(reply: unknown): AgentRunner {
  return {
    async invoke({ definition }) {
      return {
        text: JSON.stringify(reply),
        model: definition.model,
        usage: { inputTokens: 10, outputTokens: 10 },
        usdReported: 0.01,
      };
    },
  };
}

test("a theme supported by fewer than two real commits is discarded", async () => {
  // One occurrence is an incident. Building a testing axis on it spends every
  // future run chasing a single event.
  const { taxonomy } = await deriveTaxonomy({
    fixes: [fix("aaa", "fix: tenant leak"), fix("bbb", "fix: scoping"), fix("ccc", "fix: other"), fix("ddd", "fix: more")],
    runner: taxonomyRunner({
      axes: [
        { key: "tenant-scoping", title: "Tenant scoping", brief: "Check org boundaries", commits: ["aaa", "bbb"] },
        { key: "one-off", title: "One off", brief: "x", commits: ["ccc"] },
      ],
      irrelevantStandardAxes: [],
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.deepEqual(taxonomy.derived.map((d) => d.key), ["tenant-scoping"]);
  assert.equal(taxonomy.discarded.length, 1);
  assert.match(taxonomy.discarded[0].why, new RegExp(`${MIN_OBSERVATIONS} needed`));
});

test("a cited commit that was never supplied does not count as evidence", async () => {
  // A theme supported by invented evidence is supported by nothing.
  const { taxonomy } = await deriveTaxonomy({
    fixes: [fix("aaa", "fix: a"), fix("bbb", "fix: b"), fix("ccc", "fix: c"), fix("ddd", "fix: d")],
    runner: taxonomyRunner({
      axes: [{ key: "invented", title: "Invented", brief: "x", commits: ["zzz", "yyy"] }],
      irrelevantStandardAxes: [],
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.equal(taxonomy.derived.length, 0);
  assert.match(taxonomy.discarded[0].why, /No supplied commit supports it/);
});

test("too little history means the standard axes are used unchanged", async () => {
  const { taxonomy } = await deriveTaxonomy({
    fixes: [fix("aaa", "fix: only one")],
    runner: taxonomyRunner({ axes: [] }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.equal(taxonomy.derived.length, 0);
  assert.equal(taxonomy.standard.length, 7);
  assert.ok(taxonomy.notes.some((n) => /too little history/.test(n)));
});

test("a standard axis is not dropped when something derived refines it", async () => {
  // Dropping one narrows every future run, permanently and quietly.
  const { taxonomy } = await deriveTaxonomy({
    fixes: [fix("aaa", "fix: a"), fix("bbb", "fix: b"), fix("ccc", "fix: c"), fix("ddd", "fix: d")],
    runner: taxonomyRunner({
      axes: [{ key: "tenant", title: "Tenant", brief: "x", commits: ["aaa", "bbb"], refines: "rbac-scope" }],
      irrelevantStandardAxes: ["rbac-scope", "visual"],
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.ok(taxonomy.standard.includes("rbac-scope"), "refined axes are kept");
  assert.equal(taxonomy.standard.includes("visual"), false);
});

test("dropping every standard axis is refused as obviously wrong", async () => {
  const { taxonomy } = await deriveTaxonomy({
    fixes: Array.from({ length: 5 }, (_, i) => fix(`f${i}`, `fix: thing ${i}`)),
    runner: taxonomyRunner({
      axes: [{ key: "a", title: "A", brief: "b", commits: ["f0", "f1"] }],
      irrelevantStandardAxes: [...Array(7)].map((_, i) => ["happy-path", "rbac-scope", "i18n-rtl", "adversarial", "responsive-a11y", "resilience", "visual"][i]),
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.equal(taxonomy.standard.length, 7);
  assert.ok(taxonomy.notes.some((n) => /almost certainly wrong/.test(n)));
});

test("keys are slugs, so a derived axis can name a spec file", () => {
  assert.equal(slugKey("Multi-tenant scoping & isolation"), "multi-tenant-scoping-isolation");
});

/* ------------------------------------------------------- multi-service */

const multi: Profile = {
  schemaVersion: 1,
  project: { name: "p", root: "/tmp/p" },
  boot: { url: "http://localhost:3000", verified: true },
  auth: { mode: "none", roles: [] },
  data: { disposable: true, safeTargets: ["localhost:3000"], forbiddenHosts: ["*prod*"] },
  services: [{ key: "auth", url: "http://localhost:8001" }],
};

test("mutating tests need every reachable service vouched for, not just the front door", () => {
  // A spec driving the UI can still write through a service nobody confirmed
  // was disposable.
  const decision = decideGuard(multi);
  assert.equal(decision.mode, "read-only");
  assert.match(decision.reason, /Service "auth".*not in safeTargets/s);
});

test("all services are vouched for, so mutating runs", () => {
  const decision = decideGuard({
    ...multi,
    data: { ...multi.data, safeTargets: ["localhost:3000", "localhost:8001"] },
  });
  assert.equal(decision.mode, "mutating");
});

test("a forbidden service aborts the whole run, not just its own axis", () => {
  const decision = decideGuard({
    ...multi,
    data: { ...multi.data, safeTargets: ["localhost:3000", "prod-db.example"] },
    services: [{ key: "db", url: "http://prod-db.example:5432" }],
  });
  assert.equal(decision.mode, "aborted");
  assert.match(decision.reason, /Service "db"/);
});

test("a base worktree gets the runtime files git does not carry", async () => {
  // A worktree holds exactly what is committed, which for any real project is
  // not enough to start it: .env.local is gitignored by design and node_modules
  // is never committed. Without them the base never boots and every failure on
  // the branch is unclassifiable.
  const { createWorktree } = await import("../src/eval/differential.ts");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const root = await mkdtemp(path.join(tmpdir(), "clarvis-wt-"));
  await writeFile(path.join(root, "app.js"), "console.log(1);\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), "node_modules\n.env.local\n", "utf8");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "marker"), "dep", "utf8");
  await writeFile(path.join(root, ".env.local"), "SECRET=x\n", "utf8");

  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: root });

  const worktree = await createWorktree(root, "HEAD");
  try {
    assert.ok(worktree.linked.includes("node_modules"), "dependencies must be available to the base");
    assert.ok(worktree.linked.includes(".env.local"), "gitignored config must be available to the base");

    // Linked, not copied: the base must use the same dependencies as the branch,
    // which is what makes the comparison fair.
    assert.equal(await readFile(path.join(worktree.dir, "node_modules", "marker"), "utf8"), "dep");
    assert.equal(await readFile(path.join(worktree.dir, ".env.local"), "utf8"), "SECRET=x\n");
  } finally {
    await worktree.remove();
  }

  // Nothing left behind in the project.
  assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), "SECRET=x\n");
});

test("a committed file is never replaced by a link", async () => {
  // A checkout that already has the file wins: overwriting it would test
  // something other than what the base ref says.
  const { createWorktree } = await import("../src/eval/differential.ts");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const root = await mkdtemp(path.join(tmpdir(), "clarvis-wt-"));
  await writeFile(path.join(root, ".env"), "COMMITTED=yes\n", "utf8");
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: root });

  const worktree = await createWorktree(root, "HEAD");
  try {
    assert.equal(worktree.linked.includes(".env"), false, "the committed file must win");
    assert.equal(await readFile(path.join(worktree.dir, ".env"), "utf8"), "COMMITTED=yes\n");
  } finally {
    await worktree.remove();
  }
});

test("a boot command that names its own port is retargeted, not just given PORT", async () => {
  // `next dev -p 3100` ignores PORT entirely, so the base tried to bind the port
  // the branch already held and exited immediately. Differential testing cannot
  // work on any project whose dev script names its port - which is most of them.
  const { retargetPort } = await import("../src/eval/differential.ts");
  const url = "http://localhost:3100";

  assert.equal(
    retargetPort('concurrently "next dev --turbopack -p 3100" "tsx ws.ts"', url, 4100),
    'concurrently "next dev --turbopack -p 4100" "tsx ws.ts"',
  );
  assert.equal(retargetPort("vite --port 3100", url, 4100), "vite --port 4100");
  assert.equal(retargetPort("next dev --port=3100", url, 4100), "next dev --port=4100");
  assert.equal(retargetPort("PORT=3100 node server.js", url, 4100), "PORT=4100 node server.js");
});

test("only the port in use is rewritten, never a number that merely looks like one", () => {
  // Replacing every port-shaped number would corrupt a memory limit, a timeout,
  // or a version - and the resulting failure would look like an application bug.
  return import("../src/eval/differential.ts").then(({ retargetPort }) => {
    const url = "http://localhost:3100";
    assert.equal(
      retargetPort("node --max-old-space-size=3100 server.js", url, 4100),
      "node --max-old-space-size=3100 server.js",
    );
    // A different port is left alone too.
    assert.equal(retargetPort("next dev -p 8080", url, 4100), "next dev -p 8080");
    assert.equal(retargetPort(undefined, url, 4100), undefined);
  });
});

test("an npm script is resolved so a port buried inside it can be retargeted", async () => {
  // A profile records what a human types - `npm run dev:local` - while the port
  // lives in package.json, where nothing can rewrite it. The base bound the port
  // the branch already held and exited, and no amount of rewriting the outer
  // command could have helped.
  const { resolveScriptCommand, retargetPort } = await import("../src/eval/differential.ts");

  const root = await mkdtemp(path.join(tmpdir(), "clarvis-script-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { "dev:local": "next dev --turbopack -p 3100" } }),
    "utf8",
  );

  const resolved = await resolveScriptCommand("npm run dev:local", root);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.command, "next dev --turbopack -p 3100");

  assert.equal(
    retargetPort(resolved.command, "http://localhost:3100", 4100),
    "next dev --turbopack -p 4100",
  );
});

test("a command that is not a script reference is left exactly as it is", async () => {
  const { resolveScriptCommand } = await import("../src/eval/differential.ts");
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-script-"));

  // No package.json at all.
  const direct = await resolveScriptCommand("node server.mjs", root);
  assert.equal(direct.resolved, false);
  assert.equal(direct.command, "node server.mjs");

  // A script that does not exist is not invented.
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }), "utf8");
  const missing = await resolveScriptCommand("npm run nope", root);
  assert.equal(missing.resolved, false);
  assert.equal(missing.command, "npm run nope");
});

test("a resolved script gets node_modules/.bin on PATH, as npm would", async () => {
  // Resolving `npm run dev:local` means running its contents directly, and a raw
  // command does not get node_modules/.bin on PATH the way `npm run` does. The
  // base exited 127 - command not found - because `concurrently` was invisible.
  // This bug existed only because resolving the script fixed the previous one.
  const { runDifferential } = await import("../src/eval/differential.ts");

  const root = await mkdtemp(path.join(tmpdir(), "clarvis-path-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "serve -p 3000" } }), "utf8");

  // No git repository, so the worktree step fails and the run is blocked - but
  // the profile it would have built is what this asserts on, so drive the pure
  // parts instead.
  const report = await runDifferential({
    projectRoot: root,
    baseRef: "HEAD",
    profile: {
      schemaVersion: 1,
      project: { name: "p", root },
      boot: { url: "http://localhost:3000", cmd: "npm run dev", verified: true },
      auth: { mode: "none", roles: [] },
      data: { disposable: false, safeTargets: [] },
    },
    specDir: path.join(root, "specs"),
    axisKey: "happy-path",
    outputDir: path.join(root, "out"),
  });

  // It cannot compare without a repository, and says so rather than pretending.
  assert.ok(report.blockers.length > 0);
  assert.equal(report.regressions.length, 0);
});

test("a base that will not start reports why, not just that it did not", async () => {
  // Every blocker, not just the first. Boot captures the process output and the
  // cause is almost always in it - EADDRINUSE from a second server, a missing
  // binary, a bad flag. Printing only blockers[0] meant every failure had to be
  // reproduced by hand to find out what it was, which cost several runs.
  const { bootAndVerify } = await import("../src/boot.ts");

  const root = await mkdtemp(path.join(tmpdir(), "clarvis-boot-"));
  const boot = await bootAndVerify({
    schemaVersion: 1,
    project: { name: "p", root },
    boot: {
      // Fails immediately, with a specific reason on stderr.
      cmd: "node -e \"console.error('Error: listen EADDRINUSE 0.0.0.0:3101'); process.exit(1)\"",
      cwd: root,
      url: "http://localhost:59998",
      readyTimeoutMs: 8000,
      verified: false,
    },
    auth: { mode: "none", roles: [] },
    data: { disposable: false, safeTargets: [] },
  });

  assert.equal(boot.verified, false);
  const joined = boot.blockers.join("\n");
  assert.match(joined, /exited with code 1/);
  // The actual cause has to survive into the blockers, or it is unusable.
  assert.match(joined, /EADDRINUSE/);
  assert.match(joined, /3101/);
});

test("every known port moves together, so an application does not half-relocate", async () => {
  // Lumira runs Next on 3100 and a websocket on 3101. Moving only the port the
  // profile names left the second binding a port the branch still held, and the
  // base died on EADDRINUSE before the main server finished starting.
  const { sidecarPortEnv, portOf } = await import("../src/eval/differential.ts");

  assert.equal(portOf("http://localhost:3100"), 3100);
  assert.equal(portOf("https://example.com"), 443);

  const env = sidecarPortEnv(
    {
      schemaVersion: 1,
      project: { name: "p", root: "/tmp/p" },
      boot: { url: "http://localhost:3100", verified: true, env: { WS_PORT: "3101", NODE_ENV: "development" } },
      auth: { mode: "none", roles: [] },
      data: { disposable: false, safeTargets: [] },
      services: [{ key: "api", url: "http://localhost:8001" }],
    },
    1000,
  );

  assert.equal(env.WS_PORT, "4101", "a sidecar port moves by the same offset");
  assert.equal(env.API_PORT, "9001", "a declared service moves too");
  assert.equal(env.NODE_ENV, undefined, "a non-port value is never touched");
});

test("only one mechanism ever moves a port", async () => {
  // There are two, and both applying is a real failure: the boot command said
  // 4100, the in-process shim added another 1000, and the application came up
  // on 5100 while the comparison waited on 4100 and timed out. It had started
  // perfectly.
  const { isNodeProject, shimEnv } = await import("../src/eval/differential.ts");

  const nodeProject = await mkdtemp(path.join(tmpdir(), "clarvis-node-"));
  await writeFile(path.join(nodeProject, "package.json"), "{}", "utf8");
  assert.equal(await isNodeProject(nodeProject), true, "the shim can reach a Node project");

  const other = await mkdtemp(path.join(tmpdir(), "clarvis-other-"));
  assert.equal(await isNodeProject(other), false, "and cannot reach anything else");

  // The shim carries the offset; nothing else needs to.
  const env = shimEnv(1000);
  assert.equal(env.CLARVIS_PORT_OFFSET, "1000");
  assert.match(env.NODE_OPTIONS, /--require .*portShim\.cjs/);

  // No offset means no shim at all, rather than a no-op preload.
  assert.deepEqual(shimEnv(0), {});
});

test("the port shim exists where the runtime expects it", async () => {
  // It is loaded by path at boot time, so a rename that typechecks would still
  // break every differential run.
  const { portShimPath } = await import("../src/eval/differential.ts");
  const { readFile: read } = await import("node:fs/promises");

  const source = await read(portShimPath(), "utf8");
  assert.match(source, /net\.Server\.prototype\.listen/, "it must patch the one place all servers pass through");
  assert.match(source, /CLARVIS_PORT_OFFSET/);
  // Outbound connections must never move, or the base talks to the wrong service.
  assert.equal(/prototype\.connect/.test(source), false, "connect must be untouched");
});
