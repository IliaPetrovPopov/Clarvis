import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRun, describeBenchmark, type AnswerKey } from "../src/benchmark.ts";
import type { Finding, Run } from "../src/types.ts";

/**
 * The benchmark is what stops the product claiming a detection rate it has not
 * earned. Its own failure modes are therefore worth more attention than its
 * happy path: a scorer that flatters is worse than no scorer.
 */

const KEY: AnswerKey = {
  target: "demo-app",
  bugs: [
    { id: "B1", axis: "adversarial", title: "no HttpOnly", signals: ["httponly"] },
    { id: "B6", axis: "rbac-scope", title: "/admin answers 200", signals: ["admin", "200"] },
    { id: "B4", axis: "i18n-rtl", title: "untranslated Arabic", signals: ["untranslated"] },
  ],
};

const finding = (over: Partial<Finding> & Pick<Finding, "id" | "axis" | "title">): Finding => ({
  severity: "high",
  tier: "PLAUSIBLE",
  oracle: { type: "code-intent" },
  expected: "",
  actual: "",
  evidence: { specFile: "x.spec.ts" },
  ...over,
});

const run = (over: Partial<Run>): Run => ({
  schemaVersion: 1,
  runId: "r1",
  startedAt: new Date().toISOString(),
  status: "findings",
  guard: { mode: "mutating", target: "localhost:4600" },
  axes: [],
  findings: [],
  ...over,
});

test("a seeded bug on an axis that ran and was not found is a MISS", () => {
  const result = scoreRun(
    run({
      axes: [
        { key: "adversarial", status: "done" },
        { key: "rbac-scope", status: "done" },
      ],
      findings: [finding({ id: "f1", axis: "adversarial", title: "cookie missing HttpOnly" })],
    }),
    KEY,
  );

  assert.deepEqual(result.detected.map((d) => d.bug.id), ["B1"]);
  assert.deepEqual(result.missed.map((b) => b.id), ["B6"]);
  // i18n-rtl never ran, so B4 is neither found nor missed.
  assert.deepEqual(result.notExercised.map((b) => b.id), ["B4"]);
  assert.equal(result.detectionRate, 0.5);
});

test("an axis that did not run does not count against the rate", () => {
  // Counting un-run axes as misses would make the number depend on which axes
  // were requested, which is not a property of the fleet.
  const result = scoreRun(
    run({ axes: [{ key: "adversarial", status: "done" }], findings: [] }),
    KEY,
  );
  assert.equal(result.notExercised.length, 2);
  assert.equal(result.detected.length + result.missed.length, 1);
});

test("an errored or skipped axis is not treated as exercised", () => {
  // An axis that errored produced no evidence either way. Scoring it as a miss
  // would punish the fleet for an infrastructure failure.
  const result = scoreRun(
    run({
      axes: [
        { key: "adversarial", status: "error", skipReason: "playwright exited 127" },
        { key: "rbac-scope", status: "skipped", skipReason: "guard" },
      ],
      findings: [],
    }),
    KEY,
  );
  assert.equal(result.missed.length, 0);
  assert.equal(result.notExercised.length, 3);
  assert.ok(result.caveats.some((c) => /rate is meaningless/.test(c)));
});

test("an extra finding is UNMATCHED, never a false positive", () => {
  // The target may hold bugs nobody seeded. Scoring those against the fleet
  // would train it toward reporting less, which is the opposite of the point.
  const result = scoreRun(
    run({
      axes: [{ key: "adversarial", status: "done" }],
      findings: [
        finding({ id: "f1", axis: "adversarial", title: "cookie missing HttpOnly" }),
        finding({ id: "f2", axis: "adversarial", title: "oversized lang param is not rejected" }),
      ],
    }),
    KEY,
  );

  assert.equal(result.detected.length, 1);
  assert.deepEqual(result.unmatched.map((f) => f.id), ["f2"]);
  assert.equal(result.detectionRate, 1);
  assert.ok(result.caveats.some((c) => /NOT counted as false positives/.test(c)));
});

test("one finding cannot be claimed by two seeded bugs", () => {
  const greedy: AnswerKey = {
    target: "t",
    bugs: [
      { id: "X1", axis: "adversarial", title: "a", signals: ["cookie"] },
      { id: "X2", axis: "adversarial", title: "b", signals: ["cookie"] },
    ],
  };

  const result = scoreRun(
    run({
      axes: [{ key: "adversarial", status: "done" }],
      findings: [finding({ id: "f1", axis: "adversarial", title: "cookie problem" })],
    }),
    greedy,
  );

  assert.equal(result.detected.length, 1);
  assert.equal(result.missed.length, 1);
});

test("signals are matched across the finding's evidence, not only its title", () => {
  const result = scoreRun(
    run({
      axes: [{ key: "rbac-scope", status: "done" }],
      findings: [
        finding({
          id: "f1",
          axis: "rbac-scope",
          title: "role boundary not enforced",
          actual: "Expected a refusal at /admin, received 200",
        }),
      ],
    }),
    KEY,
  );
  assert.deepEqual(result.detected.map((d) => d.bug.id), ["B6"]);
});

test("the report leads with what was missed", () => {
  const lines = describeBenchmark(
    scoreRun(
      run({
        axes: [
          { key: "adversarial", status: "done" },
          { key: "rbac-scope", status: "done" },
        ],
        findings: [finding({ id: "f1", axis: "adversarial", title: "cookie missing HttpOnly" })],
      }),
      KEY,
    ),
  );

  const missedAt = lines.findIndex((l) => l.includes("MISSED"));
  const foundAt = lines.findIndex((l) => l.includes("found"));
  assert.ok(missedAt !== -1 && missedAt < foundAt, "a miss must be read before a success");
});
