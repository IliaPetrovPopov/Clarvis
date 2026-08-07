import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTier } from "../src/agents/triage.ts";
import { escapeForGrep } from "../src/runner.ts";

/**
 * Promotion to CONFIRMED is the only thing that lets a finding be published to
 * a tracker, so these rules are the boundary between "a test went red" and
 * "someone gets a ticket". They are deliberately hard to satisfy.
 */

test("CONFIRMED needs all three: deterministic, product fault, and a cited source", () => {
  const confirmed = decideTier({
    verdict: "deterministic",
    fault: "application",
    oracleType: "acceptance-criteria",
  });
  assert.equal(confirmed.tier, "CONFIRMED");

  // Drop any one of the three and it stays PLAUSIBLE.
  assert.equal(
    decideTier({ verdict: "flaky", fault: "application", oracleType: "acceptance-criteria" }).tier,
    "PLAUSIBLE",
  );
  assert.equal(
    decideTier({ verdict: "deterministic", fault: "unclear", oracleType: "acceptance-criteria" }).tier,
    "PLAUSIBLE",
  );
  assert.equal(
    decideTier({ verdict: "deterministic", fault: "application", oracleType: "code-intent" }).tier,
    "PLAUSIBLE",
  );
});

test("a finding whose only basis is code intent can never be confirmed", () => {
  // This is what makes ARCHIVE load-bearing rather than optional: without a
  // human-authored source, nothing is ever publishable.
  const decided = decideTier({
    verdict: "deterministic",
    fault: "application",
    oracleType: "code-intent",
  });
  assert.equal(decided.tier, "PLAUSIBLE");
  assert.match(decided.reason, /nothing written by a human says this is wrong/);
});

test("a fault in the spec is discarded, not filed against the product", () => {
  // A wrong selector reported as a product bug is the fastest way to make a
  // team stop reading the reports.
  const decided = decideTier({ verdict: "deterministic", fault: "spec", oracleType: "spec" });
  assert.equal(decided.tier, "DISCARDED");
  assert.match(decided.reason, /fault is in the test/);
});

test("a failure that never came back is discarded", () => {
  assert.equal(
    decideTier({ verdict: "not-reproduced", fault: "application", oracleType: "spec" }).tier,
    "DISCARDED",
  );
});

test("an environment fault becomes a QUESTION, not a silent drop", () => {
  // It might be a real deployment problem. A human decides, and it stays visible
  // either way.
  const decided = decideTier({ verdict: "deterministic", fault: "environment", oracleType: "spec" });
  assert.equal(decided.tier, "QUESTION");
});

test("a test title is escaped before it becomes a grep pattern", () => {
  // An unescaped title with regex metacharacters matches nothing, and matching
  // nothing looks exactly like "did not reproduce" - silently discarding a real
  // finding.
  const title = "viewer must not reach /admin (200 is not a refusal)";
  const escaped = escapeForGrep(title);

  assert.ok(new RegExp(escaped).test(title), "the escaped pattern must match its own title");
  assert.ok(escaped.includes("\\("), "parentheses must be escaped");
});

test("a blind spec-fault judgement becomes a QUESTION, never a DISCARD", () => {
  // A live run discarded a real responsive bug on reasoning that ended "no
  // trace, no logs, no screenshot, and no application markup were provided".
  // The judgement was careful and the conclusion was wrong, because it was made
  // blind. Discarding is the only irreversible verdict here, so it has to be
  // earned by actually looking at something.
  const blind = decideTier({
    verdict: "deterministic",
    fault: "spec",
    oracleType: "code-intent",
    evidenceAvailable: false,
  });
  assert.equal(blind.tier, "QUESTION");
  assert.match(blind.reason, /blind judgement/);

  const informed = decideTier({
    verdict: "deterministic",
    fault: "spec",
    oracleType: "code-intent",
    evidenceAvailable: true,
  });
  assert.equal(informed.tier, "DISCARDED");
});

test("a failure that never reproduced is still discarded without artifacts", () => {
  // Nothing to look at is the point: the test passed on every re-run, which is
  // evidence in itself rather than an absence of it.
  assert.equal(
    decideTier({
      verdict: "not-reproduced",
      fault: "spec",
      oracleType: "code-intent",
      evidenceAvailable: false,
    }).tier,
    "DISCARDED",
  );
});
