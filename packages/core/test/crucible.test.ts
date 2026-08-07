import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { authorSpecs, planAxes } from "../src/agents/crucible.ts";
import { Budget } from "../src/agents/budget.ts";
import type { AgentRunner } from "../src/agents/runtime.ts";
import type { Profile } from "../src/types.ts";

const PROFILE: Profile = {
  schemaVersion: 1,
  project: { name: "demo", root: "/tmp/demo" },
  boot: { url: "http://localhost:4600", verified: true },
  auth: {
    mode: "cookie-session",
    loginUrl: "/login",
    roles: [
      { key: "admin", username: "a@d.test", password: "pw1" },
      { key: "viewer", username: "v@d.test", password: "pw2", expectedDenied: ["/admin"] },
    ],
  },
  data: { disposable: true, safeTargets: ["localhost:4600"], forbiddenHosts: ["db.prod.example"] },
};

const GOOD = `import { test, expect } from "@playwright/test";
test("viewer is refused at /admin", async ({ request }) => {
  const r = await request.get("/admin", { maxRedirects: 0 });
  expect(r.status()).toBe(403);
});`;

/** Replies in sequence, so a retry can be given a different answer. */
function replying(...replies: unknown[]): AgentRunner & { calls: number } {
  let i = 0;
  const runner = {
    calls: 0,
    async invoke({ definition }: { definition: { model: string } }) {
      const reply = replies[Math.min(i++, replies.length - 1)];
      runner.calls++;
      return {
        text: JSON.stringify(reply),
        model: definition.model,
        usage: { inputTokens: 10, outputTokens: 10 },
        usdReported: 0.05,
      };
    },
  };
  return runner as AgentRunner & { calls: number };
}

const scratch = () => mkdtemp(path.join(tmpdir(), "clarvis-crucible-"));

/* ------------------------------------------------------------------ planning */

test("rbac exercises every role; other axes need only one", () => {
  const plans = planAxes({ axes: ["rbac-scope", "happy-path"], profile: PROFILE });
  assert.deepEqual(plans[0].roles, ["admin", "viewer"]);
  assert.deepEqual(plans[1].roles, ["admin"]);
});

test("an axis with no requirements still runs, and says its findings will cite nothing", () => {
  // Reporting it as unrunnable would hide the axis; reporting it as specified
  // would overstate the oracle. It is neither.
  const [plan] = planAxes({ axes: ["happy-path"], profile: PROFILE });
  assert.ok(plan.notes.some((n) => /No verified requirements/.test(n)));
});

/* ----------------------------------------------------------------- authoring */

test("a gated spec is written; nothing else is", async () => {
  const dir = await scratch();
  const report = await authorSpecs({
    axes: ["rbac-scope"],
    profile: PROFILE,
    runner: replying({ source: GOOD, covers: [], untested: [] }),
    budget: new Budget({ maxUsd: 5 }),
    scratchDir: dir,
  });

  assert.equal(report.authored.length, 1);
  assert.deepEqual(await readdir(dir), ["rbac-scope-1.spec.ts"]);
  assert.equal(await readFile(path.join(dir, "rbac-scope-1.spec.ts"), "utf8"), GOOD);
});

test("a spec that fails the gate is never written, and the axis is reported as not run", async () => {
  const dir = await scratch();
  const vacuous = `import { test, expect } from "@playwright/test";
test("it works", async () => { expect(true).toBe(true); });`;

  const report = await authorSpecs({
    axes: ["rbac-scope"],
    profile: PROFILE,
    runner: replying({ source: vacuous }),
    budget: new Budget({ maxUsd: 5 }),
    scratchDir: dir,
    maxAttempts: 2,
  });

  // An ungated spec that runs is the false-green the gate exists to prevent.
  assert.deepEqual(await readdir(dir), []);
  assert.equal(report.authored.length, 0);
  assert.equal(report.rejected[0].axis, "rbac-scope");
  assert.ok(report.warnings.some((w) => /NOT a pass/.test(w)));
});

test("the gate's complaint is fed back, and a corrected spec is accepted", async () => {
  const dir = await scratch();
  const bad = `import { test, expect } from "@playwright/test";
test("it works", async () => { expect(true).toBe(true); });`;

  const report = await authorSpecs({
    axes: ["rbac-scope"],
    profile: PROFILE,
    runner: replying({ source: bad }, { source: GOOD }),
    budget: new Budget({ maxUsd: 5 }),
    scratchDir: dir,
  });

  assert.equal(report.authored.length, 1);
  assert.equal(report.authored[0].attempts, 2);
});

test("a spec naming a denied host is refused even when everything else is fine", async () => {
  const dir = await scratch();
  const leaky = `import { test, expect } from "@playwright/test";
test("checks the shared db", async ({ request }) => {
  const r = await request.get("http://db.prod.example/status");
  expect(r.status()).toBe(200);
});`;

  const report = await authorSpecs({
    axes: ["adversarial"],
    profile: PROFILE,
    runner: replying({ source: leaky }),
    budget: new Budget({ maxUsd: 5 }),
    scratchDir: dir,
    maxAttempts: 1,
  });

  assert.equal(report.authored.length, 0);
  assert.deepEqual(await readdir(dir), []);
});

test("axes are authored concurrently without breaching the budget", async () => {
  const dir = await scratch();
  const budget = new Budget({ maxUsd: 5 });

  const report = await authorSpecs({
    axes: ["rbac-scope", "adversarial", "happy-path", "i18n-rtl"],
    profile: PROFILE,
    runner: replying({ source: GOOD }),
    budget,
    scratchDir: dir,
  });

  assert.equal(report.authored.length, 4);
  assert.ok(budget.spentUsd <= 5);

  // Order follows the requested axes, not completion order, so a report reads
  // the same way twice.
  assert.deepEqual(report.authored.map((a) => a.axis), [
    "rbac-scope",
    "adversarial",
    "happy-path",
    "i18n-rtl",
  ]);
});

test("a run that cannot afford every axis authors what it can and says so", async () => {
  const dir = await scratch();
  const report = await authorSpecs({
    axes: ["rbac-scope", "adversarial", "happy-path"],
    profile: PROFILE,
    // Enough for one axis at the definition's per-attempt estimate.
    budget: new Budget({ maxUsd: 0.45 }),
    runner: replying({ source: GOOD }),
    scratchDir: dir,
    maxAttempts: 1,
  });

  assert.ok(report.authored.length < 3, "not every axis should fit");
  assert.ok(report.rejected.length > 0);
  // Nothing may silently vanish: an axis that could not be afforded is reported.
  assert.equal(report.authored.length + report.rejected.length, 3);
});

test("running out of turns changes the instruction, not just the attempt", async () => {
  // Three identical retries hit the same wall. Only telling it to stop
  // exploring changes the outcome.
  const dir = await scratch();
  const prompts: string[] = [];

  let call = 0;
  const runner: AgentRunner = {
    async invoke({ definition, prompt }) {
      prompts.push(prompt);
      if (call++ === 0) {
        throw new Error("claude ran out of turns (60) before returning a result.");
      }
      return {
        text: JSON.stringify({ source: GOOD, covers: [], untested: [] }),
        model: definition.model,
        usage: { inputTokens: 10, outputTokens: 10 },
        usdReported: 0.01,
      };
    },
  };

  const report = await authorSpecs({
    axes: ["rbac-scope"],
    profile: PROFILE,
    runner,
    budget: new Budget({ maxUsd: 5 }),
    scratchDir: dir,
  });

  assert.equal(report.authored.length, 1);
  assert.match(prompts[1], /Stop exploring and write the spec now/);
  assert.match(prompts[1], /shorter spec that runs beats a thorough one that never arrives/);
});

test("the author is told which routes exist and which need a session", async () => {
  // A spec navigated anonymously to /explore, a protected route, saw the login
  // page, and reported the real page as broken. The brief had never listed any
  // routes at all.
  const dir = await scratch();
  const prompts: string[] = [];

  const runner: AgentRunner = {
    async invoke({ definition, prompt }) {
      prompts.push(prompt);
      return {
        text: JSON.stringify({ source: GOOD, covers: [], untested: [] }),
        model: definition.model,
        usage: { inputTokens: 10, outputTokens: 10 },
        usdReported: 0.01,
      };
    },
  };

  await authorSpecs({
    axes: ["rbac-scope"],
    profile: {
      ...PROFILE,
      surface: {
        routes: [
          { path: "/login" },
          { path: "/explore", requiresAuth: true },
          { path: "/users/[id]", dynamic: true },
        ],
      },
    },
    runner,
    budget: new Budget({ maxUsd: 5 }),
    scratchDir: dir,
  });

  assert.match(prompts[0], /KNOWN ROUTES/);
  assert.match(prompts[0], /\/explore\s+\(needs a session\)/);
  assert.match(prompts[0], /\/users\/\[id\]\s+\(dynamic - needs a real id/);
  assert.match(prompts[0], /Do not navigate anywhere that is not on this list/);
});

test("the author is handed the real page rather than left to infer it", async () => {
  // Source says what a component is written as; a selector matches what the
  // browser built. An author reading JSX cannot tell whether <Button> renders a
  // button, an anchor or a div, and a spec built on the wrong guess fails
  // against a working application.
  const dir = await scratch();
  const prompts: string[] = [];

  const runner: AgentRunner = {
    async invoke({ definition, prompt }) {
      prompts.push(prompt);
      return {
        text: JSON.stringify({ source: GOOD, covers: [], untested: [] }),
        model: definition.model,
        usage: { inputTokens: 10, outputTokens: 10 },
        usdReported: 0.01,
      };
    },
  };

  await authorSpecs({
    axes: ["happy-path"],
    profile: {
      ...PROFILE,
      surface: {
        routes: [
          {
            path: "/dashboard",
            title: "Dashboard",
            ariaSnapshot: '- heading "Today" [level=1]\n- button "New report"',
          },
        ],
      },
    },
    runner,
    budget: new Budget({ maxUsd: 5 }),
    scratchDir: dir,
  });

  assert.match(prompts[0], /accessibility snapshots taken from the running/);
  assert.match(prompts[0], /button "New report"/);
  assert.match(prompts[0], /if a control is not here, it is not on the page/i);
});

test("an established session replaces the credentials the author used to be given", async () => {
  // Credentials in the brief meant every axis wrote its own login flow - the
  // most repeated and least verified code in the system, whose failures were
  // reported as defects in the page under test. They are now absent by design.
  const dir = await scratch();
  const prompts: string[] = [];

  const runner: AgentRunner = {
    async invoke({ definition, prompt }) {
      prompts.push(prompt);
      return {
        text: JSON.stringify({ source: GOOD, covers: [], untested: [] }),
        model: definition.model,
        usage: { inputTokens: 10, outputTokens: 10 },
        usdReported: 0.01,
      };
    },
  };

  await authorSpecs({
    axes: ["rbac-scope"],
    profile: PROFILE,
    runner,
    budget: new Budget({ maxUsd: 5 }),
    scratchDir: dir,
    sessions: { admin: "/state/admin.json", viewer: "/state/viewer.json" },
  });

  assert.match(prompts[0], /already logged in as "admin"/i);
  assert.match(prompts[0], /Do not write a login flow/i);
  assert.match(prompts[0], /storageState: "\/state\/viewer\.json"/);

  for (const role of PROFILE.auth.roles) {
    assert.ok(
      !prompts[0].includes(role.password),
      `the brief must never contain ${role.key}'s password`,
    );
  }
});

test("with no mapped routes the author is told to check auth itself", async () => {
  const dir = await scratch();
  const prompts: string[] = [];

  const runner: AgentRunner = {
    async invoke({ definition, prompt }) {
      prompts.push(prompt);
      return {
        text: JSON.stringify({ source: GOOD, covers: [], untested: [] }),
        model: definition.model,
        usage: { inputTokens: 10, outputTokens: 10 },
        usdReported: 0.01,
      };
    },
  };

  await authorSpecs({
    axes: ["rbac-scope"],
    profile: PROFILE,
    runner,
    budget: new Budget({ maxUsd: 5 }),
    scratchDir: dir,
  });

  assert.match(prompts[0], /none were mapped/);
  assert.match(prompts[0], /check whether each one is behind auth/);
});
