import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePublish, isValidOracleSource, type TrackerConfig } from "../src/trackerGuard.ts";
import type { Finding, Tier } from "../src/types.ts";

function finding(tier: Tier = "CONFIRMED"): Finding {
  return {
    id: "f1",
    axis: "rbac-scope",
    title: "Proctor can read a System Admin",
    severity: "critical",
    tier,
    oracle: { type: "acceptance-criteria", citation: "EXM-412", quote: "Proctors cannot view users." },
    expected: "403",
    actual: "200",
    evidence: { specFile: "a.spec.ts" },
  };
}

const config: TrackerConfig = {
  system: "jira",
  writeEnabled: true,
  allowedProjects: ["EXM"],
  maxCreatesPerRun: 3,
};

test("publishes a confirmed, approved, non-duplicate finding", () => {
  const d = decidePublish(config, { finding: finding(), project: "EXM", approvedBy: "ilia" }, 0);
  assert.equal(d.allowed, true);
});

test("refuses every write unless writes are explicitly enabled", () => {
  for (const value of [false, undefined, null, "true", 1] as unknown[]) {
    const c = { ...config, writeEnabled: value as boolean };
    const d = decidePublish(c, { finding: finding(), project: "EXM", approvedBy: "ilia" }, 0);
    assert.equal(d.allowed, false, `writeEnabled=${JSON.stringify(value)} must not publish`);
    assert.equal(d.refusal, "writes-disabled");
  }
});

test("refuses anything below CONFIRMED", () => {
  for (const tier of ["PLAUSIBLE", "QUESTION", "DISCARDED"] as Tier[]) {
    const d = decidePublish(config, { finding: finding(tier), project: "EXM", approvedBy: "ilia" }, 0);
    assert.equal(d.allowed, false, `${tier} must not reach a real backlog`);
    assert.equal(d.refusal, "not-confirmed");
  }
});

test("refuses without recorded human approval", () => {
  const d = decidePublish(config, { finding: finding(), project: "EXM" }, 0);
  assert.equal(d.refusal, "no-approval");
});

test("refuses when a duplicate is suspected", () => {
  const d = decidePublish(
    config,
    { finding: finding(), project: "EXM", approvedBy: "ilia", possibleDuplicates: ["EXM-91"] },
    0,
  );
  assert.equal(d.refusal, "duplicate-suspected");
  assert.match(d.reason, /EXM-91/);
});

test("refuses a project outside the allow-list", () => {
  const d = decidePublish(config, { finding: finding(), project: "OTHER", approvedBy: "ilia" }, 0);
  assert.equal(d.refusal, "project-not-allowed");
});

test("caps creations per run so a loop cannot flood a board", () => {
  const d = decidePublish(config, { finding: finding(), project: "EXM", approvedBy: "ilia" }, 3);
  assert.equal(d.refusal, "run-cap-reached");
});

test("an oracle must trace to a quoted human-authored source", () => {
  assert.equal(isValidOracleSource({ quote: "Proctors cannot view users.", sourceIds: ["s1"] }).valid, true);
  // The laundering cases: an agent's own words dressed up as a requirement.
  assert.equal(isValidOracleSource({ quote: "Proctors cannot view users." }).valid, false);
  assert.equal(isValidOracleSource({ sourceIds: ["s1"] }).valid, false);
  assert.equal(isValidOracleSource({ quote: "   ", sourceIds: ["s1"] }).valid, false);
});
