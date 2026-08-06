import { test } from "node:test";
import assert from "node:assert/strict";
import { planRun, plannedAxisOrder } from "../src/agents/vector.ts";
import { draftTickets, titleReadsLikeAssertion, renderDraft } from "../src/agents/dispatch.ts";
import { decideAndDescribe } from "../src/agents/clearance.ts";
import { Budget } from "../src/agents/budget.ts";
import { AXES, type Finding, type Profile, type Run } from "../src/types.ts";
import type { AgentRunner } from "../src/agents/runtime.ts";
import type { FeatureScope } from "../src/scope.ts";

function replying(reply: unknown, opts: { fail?: boolean } = {}): AgentRunner {
  return {
    async invoke({ definition }) {
      if (opts.fail) throw new Error("upstream 529");
      return {
        text: JSON.stringify(reply),
        model: definition.model,
        usage: { inputTokens: 10, outputTokens: 10 },
        usdReported: 0.01,
      };
    },
  };
}

const PROFILE: Profile = {
  schemaVersion: 1,
  project: { name: "demo", root: "/tmp/demo" },
  boot: { url: "http://localhost:4600", verified: true },
  auth: {
    mode: "cookie-session",
    roles: [
      { key: "admin", username: "a@d.test", password: "p1" },
      { key: "viewer", username: "v@d.test", password: "p2" },
    ],
  },
  data: { disposable: true, safeTargets: ["localhost:4600"] },
  surface: { routes: [{ path: "/notes" }, { path: "/admin" }] },
};

const SCOPE: FeatureScope = {
  key: "rbac",
  title: "org scoping",
  origin: "diff",
  confidence: "high",
  keywords: ["scope", "admin"],
  paths: ["src/admin.ts"],
  routes: [],
  trackerKeys: [],
  evidence: [],
  truncation: [],
};

/* ------------------------------------------------------------------ VECTOR */

test("the plan and the deferred list together account for every axis", async () => {
  // An axis in neither list is an axis nobody decided about, and a bug it would
  // have caught is indistinguishable from no bug at all.
  const { plan } = await planRun({
    scope: SCOPE,
    profile: PROFILE,
    runner: replying({
      axes: [{ axis: "rbac-scope", why: "permissions changed", routes: ["/admin"], roles: ["viewer"] }],
      deferred: [{ axis: "visual", why: "no styling changed", cost: "layout regressions ship unseen" }],
      rationale: "Scoping change, so role boundaries first.",
    }),
    budget: new Budget({ maxUsd: 2 }),
  });

  const accounted = new Set([...plan.axes.map((a) => a.axis), ...plan.deferred.map((d) => d.axis)]);
  assert.deepEqual([...accounted].sort(), [...AXES].sort());

  // The five the agent never mentioned are deferred, and marked as accidental.
  const forgotten = plan.deferred.filter((d) => /did not mention/.test(d.why));
  assert.equal(forgotten.length, 5);
  assert.ok(plan.notes.some((n) => /missing from the plan entirely/.test(n)));
});

test("VECTOR cannot resurrect an axis the guard refused", async () => {
  const { plan, report } = await planRun({
    scope: SCOPE,
    profile: PROFILE,
    guardSkipped: ["happy-path"],
    runner: replying({
      axes: [{ axis: "happy-path", why: "core flow" }, { axis: "visual", why: "worth a look" }],
      deferred: [],
      rationale: "x",
    }),
    budget: new Budget({ maxUsd: 2 }),
  });

  assert.equal(plan.axes.some((a) => a.axis === "happy-path"), false);
  assert.ok(report.corrections.some((c) => /guard already skipped/.test(c)));
  // It is still visible, as a deferred axis with the guard as the reason.
  assert.ok(plan.deferred.some((d) => d.axis === "happy-path" && /guard/i.test(d.why)));
});

test("invented routes, roles and requirements are dropped", async () => {
  // A spec built on a route recon never mapped fails for the wrong reason and
  // wastes the run the plan was trying to prioritise.
  const { plan, report } = await planRun({
    scope: SCOPE,
    profile: PROFILE,
    runner: replying({
      axes: [
        {
          axis: "rbac-scope",
          why: "x",
          routes: ["/admin", "/settings/billing"],
          roles: ["viewer", "superuser"],
          requirementIds: ["R9"],
        },
      ],
      deferred: [],
      rationale: "x",
    }),
    budget: new Budget({ maxUsd: 2 }),
  });

  assert.deepEqual(plan.axes[0].routes, ["/admin"]);
  assert.deepEqual(plan.axes[0].roles, ["viewer"]);
  assert.deepEqual(plan.axes[0].requirementIds, []);
  assert.equal(report.corrections.length, 3);
});

test("a failed plan runs everything rather than nothing", async () => {
  // Falling back to nothing would be a silent run; falling back to everything is
  // merely unprioritised, which is what a plan was going to fix anyway.
  const { plan } = await planRun({
    scope: SCOPE,
    profile: PROFILE,
    runner: replying(null, { fail: true }),
    budget: new Budget({ maxUsd: 2 }),
  });

  assert.equal(plan.axes.length, AXES.length);
  assert.ok(plan.notes[0].includes("Planning did not complete"));
  assert.deepEqual(plannedAxisOrder(plan), [...AXES]);
});

/* ---------------------------------------------------------------- DISPATCH */

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  axis: "rbac-scope",
  title: "viewer must not reach /admin",
  severity: "critical",
  tier: "CONFIRMED",
  oracle: { type: "acceptance-criteria", citation: "README.md:14", quote: "A viewer must not reach /admin." },
  expected: "A viewer must not reach /admin.",
  actual: "Received 200.",
  evidence: { specFile: "rbac-scope-1.spec.ts" },
  determinism: { runs: 3, failures: 3, verdict: "deterministic" },
  ...over,
});

const runWith = (findings: Finding[]): Run => ({
  schemaVersion: 1,
  runId: "r1",
  startedAt: new Date().toISOString(),
  status: "findings",
  guard: { mode: "mutating", target: "localhost:4600" },
  axes: [{ key: "rbac-scope", status: "done", results: { passed: 1, failed: 1 } }],
  findings,
});

const DRAFT = {
  title: "Viewers can read every client's notes at /admin",
  body: "The admin route answers 200 to a viewer.",
  steps: ["Sign in as a viewer", "Open /admin"],
  labels: ["security"],
};

test("only CONFIRMED findings are drafted, and the rest say why not", async () => {
  const { bundle } = await draftTickets({
    run: runWith([finding(), finding({ id: "f2", tier: "PLAUSIBLE" })]),
    runner: replying(DRAFT),
    budget: new Budget({ maxUsd: 2 }),
    tracker: { system: "jira" },
    project: "QA",
  });

  assert.deepEqual(bundle.drafts.map((d) => d.findingId), ["f1"]);
  assert.equal(bundle.skipped[0].findingId, "f2");
  assert.match(bundle.skipped[0].why, /not CONFIRMED/);
});

test("a draft is written even when the gate refuses to publish it", async () => {
  // Refused is the normal path, not a failure: someone reads it and files it by
  // hand. Discarding it would throw away the work that was already paid for.
  const { bundle, report } = await draftTickets({
    run: runWith([finding()]),
    runner: replying(DRAFT),
    budget: new Budget({ maxUsd: 2 }),
    tracker: { system: "jira" }, // writeEnabled not set
    project: "QA",
  });

  assert.equal(bundle.drafts.length, 1);
  assert.equal(bundle.drafts[0].publish.allowed, false);
  assert.equal(bundle.drafts[0].publish.refusal, "writes-disabled");
  assert.equal(report.publishable, 0);
  assert.ok(bundle.notes.some((n) => /file by hand/.test(n)));
});

test("publishing needs writes enabled, an allow-listed project and a named approver", async () => {
  const base = {
    run: runWith([finding()]),
    runner: replying(DRAFT),
    budget: new Budget({ maxUsd: 2 }),
    project: "QA",
  };

  const enabled = await draftTickets({
    ...base,
    tracker: { system: "jira", writeEnabled: true, allowedProjects: ["QA"] },
    approvals: { f1: "reviewer" },
  });
  assert.equal(enabled.bundle.drafts[0].publish.allowed, true);

  // Same everything, no human approval.
  const unapproved = await draftTickets({
    ...base,
    tracker: { system: "jira", writeEnabled: true, allowedProjects: ["QA"] },
  });
  assert.equal(unapproved.bundle.drafts[0].publish.allowed, false);
  assert.equal(unapproved.bundle.drafts[0].publish.refusal, "no-approval");
});

test("a suspected duplicate is never publishable", async () => {
  const { bundle } = await draftTickets({
    run: runWith([finding()]),
    runner: replying(DRAFT),
    budget: new Budget({ maxUsd: 2 }),
    tracker: { system: "jira", writeEnabled: true, allowedProjects: ["QA"] },
    project: "QA",
    approvals: { f1: "reviewer" },
    knownDuplicates: { f1: ["QA-114"] },
  });
  assert.equal(bundle.drafts[0].publish.refusal, "duplicate-suspected");
});

test("a title written like a test assertion is flagged", () => {
  // On a board it reads as the intended behaviour rather than the defect.
  assert.equal(titleReadsLikeAssertion("viewer must not reach /admin"), true);
  assert.equal(titleReadsLikeAssertion("nav links stay within the viewport"), true);
  assert.equal(titleReadsLikeAssertion("Viewers can read every client's notes at /admin"), false);
});

test("the rendered draft carries its oracle and its evidence", () => {
  const md = renderDraft({
    findingId: "f1",
    title: "T",
    body: "B",
    steps: ["one"],
    expected: "E",
    actual: "A",
    severity: "critical",
    labels: [],
    oracle: { type: "acceptance-criteria", citation: "README.md:14", quote: "A viewer must not reach /admin." },
    evidence: { specFile: "x.spec.ts", tracePath: "/t/trace.zip" },
    publish: { allowed: false, reason: "x" },
  });

  assert.match(md, /How we know this is wrong/);
  assert.match(md, /A viewer must not reach \/admin\./);
  assert.match(md, /README\.md:14/);
  assert.match(md, /trace\.zip/);
});

test("nothing confirmed means nothing drafted, and it says what would fix that", async () => {
  const { bundle } = await draftTickets({
    run: runWith([finding({ tier: "PLAUSIBLE" })]),
    runner: replying(DRAFT),
    budget: new Budget({ maxUsd: 2 }),
    tracker: { system: "jira" },
    project: "QA",
  });
  assert.equal(bundle.drafts.length, 0);
  assert.ok(bundle.notes.some((n) => /run research/i.test(n)));
});

/* --------------------------------------------------------------- CLEARANCE */

const NOTES = {
  summary: "Holding: one confirmed critical.",
  notes: "",
  limits: ["Only two of nine routes were visited."],
};

test("the verdict comes from code, and the agent cannot move it", async () => {
  const { report } = await decideAndDescribe({
    run: runWith([finding()]),
    runner: replying({ ...NOTES, summary: "Everything looks great, ship it." }),
    budget: new Budget({ maxUsd: 2 }),
  });

  // A confirmed critical blocks, whatever the prose says.
  assert.notEqual(report.verdict.decision, "ship");
  assert.equal(report.verdict.counts.confirmedCritical, 1);
});

test("release notes are only written when actually shipping", async () => {
  const holding = await decideAndDescribe({
    run: runWith([finding()]),
    runner: replying({ ...NOTES, notes: "## What's new\nLots!" }),
    budget: new Budget({ maxUsd: 2 }),
  });
  // Notes for a release that is not happening describe something that does not
  // exist.
  assert.equal(holding.report.notes, "");
});

test("a failed notes agent cannot hide the verdict or its limits", async () => {
  const { report } = await decideAndDescribe({
    run: runWith([finding()]),
    runner: replying(null, { fail: true }),
    budget: new Budget({ maxUsd: 2 }),
  });

  assert.notEqual(report.verdict.decision, "ship");
  assert.match(report.summary, /Notes could not be written/);
  // Falls back to the deterministic list rather than to nothing.
  assert.deepEqual(report.limits, report.verdict.notChecked);
});

test("limits are never empty, because every run misses something", async () => {
  const { report } = await decideAndDescribe({
    run: runWith([]),
    runner: replying(NOTES),
    budget: new Budget({ maxUsd: 2 }),
  });
  assert.ok(report.limits.length > 0);
});
