import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyClusterVerdict,
  clusterFindings,
  describeClusters,
  locatorOf,
  normaliseError,
} from "../src/agents/cluster.ts";
import type { Finding } from "../src/types.ts";

/**
 * Nine specs failing because the application had not rendered is one problem,
 * not nine. The rule this file protects: clustering changes how many times we
 * INVESTIGATE, never how many findings we REPORT.
 */

const f = (over: Partial<Finding> & Pick<Finding, "id">): Finding => ({
  axis: "responsive-a11y",
  title: over.id,
  severity: "medium",
  tier: "PLAUSIBLE",
  oracle: { type: "code-intent" },
  expected: "",
  actual: "",
  evidence: { specFile: "responsive-a11y-1.spec.ts" },
  ...over,
});

test("incidental detail is stripped so the same failure compares equal", () => {
  // Two failures of one cause differ only in viewport, timing and ids.
  const a = normaliseError('Error: getByRole("textbox") not visible at 375x667 after 5000ms');
  const b = normaliseError('Error: getByRole("textbox") not visible at 1440x900 after 30000ms');
  assert.equal(a, b);

  // A genuinely different assertion must not collapse into it.
  assert.notEqual(a, normaliseError('Error: getByRole("button") has no accessible name'));
});

test("ANSI colour from the reporter does not defeat comparison", () => {
  const esc = "";
  const raw = `${esc}[2mexpect(${esc}[22m${esc}[31mlocator${esc}[39m).toBeVisible() failed`;
  assert.equal(normaliseError(raw), normaliseError("expect(locator).toBeVisible() failed"));
});

test("the element under test is read out of the failure when not recorded", () => {
  assert.equal(locatorOf(f({ id: "1", actual: 'getByLabel("Email") resolved to 0 elements' })), "email");
  assert.equal(locatorOf(f({ id: "2", locator: "#submit" })), "#submit");
  assert.equal(locatorOf(f({ id: "3", actual: "something else entirely" })), undefined);
});

test("one shared signal is a coincidence and does not merge", () => {
  // Two tests can fail "not visible" for entirely unrelated reasons. Merging on
  // that alone is how a second, real defect gets swallowed.
  const result = clusterFindings([
    f({ id: "a", actual: "expect(locator).toBeVisible() failed", evidence: { specFile: "one.spec.ts" } }),
    f({ id: "b", actual: "expect(locator).toBeVisible() failed", evidence: { specFile: "two.spec.ts" } }),
  ]);

  assert.equal(result.clusters.length, 0);
  assert.equal(result.singletons.length, 2);
});

test("two agreeing signals merge, and the failure itself must be one of them", () => {
  const result = clusterFindings([
    f({ id: "a", actual: 'getByLabel("Email") not visible at 375x667' }),
    f({ id: "b", actual: 'getByLabel("Email") not visible at 1440x900' }),
    f({ id: "c", actual: "button has no accessible name", evidence: { specFile: "other.spec.ts" } }),
  ]);

  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0].members.map((m) => m.id).sort(), ["a", "b"]);
  assert.deepEqual(result.singletons.map((m) => m.id), ["c"]);
  assert.match(result.clusters[0].evidence, /identical assertion failure/);
});

test("every member is still reported, and says which cluster decided it", () => {
  const a = f({ id: "a", actual: 'getByLabel("Email") not visible at 375x667', severity: "medium" });
  const b = f({ id: "b", actual: 'getByLabel("Email") not visible at 1440x900', severity: "high" });

  const result = clusterFindings([a, b]);
  const cluster = result.clusters[0];

  // The most severe member represents it: a cluster is never graded on its
  // mildest instance.
  assert.equal(cluster.representative.id, "b");

  cluster.representative.tier = "DISCARDED";
  cluster.representative.tierReason = "The fault is in the test.";
  cluster.representative.verifiedBy = "prover-triage-1";
  applyClusterVerdict(cluster, cluster.representative);

  assert.equal(a.tier, "DISCARDED");
  assert.match(a.tierReason!, /Same cause as/);
  assert.match(a.verifiedBy!, /via cluster-1/);
  // Not deleted, not hidden.
  assert.equal(cluster.members.length, 2);
});

test("most of a run failing one way is called an environment problem", () => {
  // The thing nine false findings needed someone to say out loud.
  const findings = Array.from({ length: 5 }, (_, i) =>
    f({ id: `f${i}`, actual: 'getByLabel("Email") not visible at 375x667' }),
  );
  findings.push(f({ id: "other", actual: "unrelated failure", evidence: { specFile: "z.spec.ts" } }));

  const result = clusterFindings(findings);
  assert.ok(result.environmental, "a dominant cluster must be flagged");
  assert.match(result.environmental!.note, /problem with the run rather than/);
  assert.match(result.environmental!.note, /unverified/);
});

test("a cluster spanning several axes is called out as such", () => {
  const findings = [
    f({ id: "a", axis: "i18n-rtl", actual: 'getByLabel("Email") not visible' }),
    f({ id: "b", axis: "visual", actual: 'getByLabel("Email") not visible' }),
    f({ id: "c", axis: "responsive-a11y", actual: 'getByLabel("Email") not visible' }),
  ];

  const result = clusterFindings(findings);
  assert.match(result.environmental!.note, /span 3 axes/);
  assert.match(result.environmental!.note, /the application/);
});

test("a handful of unrelated failures is not an environment problem", () => {
  const result = clusterFindings([
    f({ id: "a", actual: "first thing broke", evidence: { specFile: "a.spec.ts" } }),
    f({ id: "b", actual: "second thing broke", evidence: { specFile: "b.spec.ts" } }),
  ]);
  assert.equal(result.environmental, undefined);
});

test("the report names every member, marking the one investigated", () => {
  const result = clusterFindings([
    f({ id: "a", title: "at mobile", actual: 'getByLabel("Email") not visible at 375x667' }),
    f({ id: "b", title: "at desktop", actual: 'getByLabel("Email") not visible at 1440x900' }),
  ]);
  const text = describeClusters(result).join("\n");

  assert.match(text, /at mobile/);
  assert.match(text, /at desktop/);
  assert.match(text, /All 2 are still reported/);
});
