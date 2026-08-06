import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEntailment,
  buildContext,
  markConflicts,
  normaliseForQuote,
  oracleCeiling,
  quoteAppearsIn,
  verifyRequirements,
  type ContextSource,
  type Requirement,
} from "../src/context.ts";
import { splitSections, looksNormative } from "../src/connectors/docs.ts";

const SOURCE_TEXT =
  "Acceptance Criteria\n\nProctors must not be able to view or edit users. A Client Admin cannot manage System Admins.";

const sources: ContextSource[] = [
  {
    id: "s1",
    type: "jira-issue",
    ref: "EXM-412",
    author: "Ilia",
    content: SOURCE_TEXT,
  },
];

function req(over: Partial<Requirement> = {}): Requirement {
  return {
    id: "r1",
    statement: "A Proctor receives 403 on /api/users.",
    quote: "Proctors must not be able to view or edit users.",
    sourceIds: ["s1"],
    confidence: "explicit",
    ...over,
  };
}

/* ------------------------------------------------------- quote integrity */

test("a real quote is accepted", () => {
  const { accepted, rejected } = verifyRequirements([req()], sources);
  assert.equal(accepted.length, 1);
  assert.deepEqual(rejected, []);
});

test("a fabricated quote is rejected, which is the whole point", () => {
  const { accepted, rejected } = verifyRequirements(
    [req({ quote: "Proctors must be granted full administrative access." })],
    sources,
  );
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].code, "quote-not-found");
  assert.match(rejected[0].detail, /reworded or it was invented/);
});

test("a requirement with no source cannot become an oracle", () => {
  const { rejected } = verifyRequirements([req({ sourceIds: [] })], sources);
  assert.equal(rejected[0].code, "no-source");
  assert.match(rejected[0].remedy, /unknowns/);
});

test("citing a source that was never gathered is rejected", () => {
  const { rejected } = verifyRequirements([req({ sourceIds: ["s99"] })], sources);
  assert.equal(rejected[0].code, "unknown-source");
});

test("a paraphrase with no quote is rejected", () => {
  const { rejected } = verifyRequirements([req({ quote: "" })], sources);
  assert.equal(rejected[0].code, "no-quote");
});

test("cosmetic differences do not count as fabrication", () => {
  // Smart quotes, non-breaking spaces and rewrapped lines all arrive from real
  // connectors and none of them mean the quote is fake.
  assert.equal(
    quoteAppearsIn("Proctors  must not be able\nto view or edit users.", SOURCE_TEXT),
    true,
  );
  assert.equal(normaliseForQuote("“a — b”"), '"a - b"');
});

test("a quote too short to be evidence is not accepted", () => {
  assert.equal(quoteAppearsIn("users", SOURCE_TEXT), false);
});

/* ------------------------------------------------------------ entailment */

test("entailment is judged by a separate verifier that sees only quote and statement", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const verifier = {
    async check(input: { quote: string; statement: string }) {
      seen.push(input);
      // Refuse the leap from "cannot view users" to "audit logging exists".
      const entailed = !/audit/i.test(input.statement);
      return {
        entailed,
        confidence: "explicit" as const,
        reason: entailed ? "follows from the quote" : "the quote says nothing about auditing",
      };
    },
  };

  const { accepted, demoted } = await applyEntailment(
    [req(), req({ id: "r2", statement: "Every denied request is written to an audit log." })],
    verifier,
  );

  assert.equal(accepted.length, 1);
  assert.equal(demoted.length, 1);
  assert.equal(demoted[0].requirement.id, "r2");
  // The verifier must not be handed anything that could bias it.
  assert.deepEqual(Object.keys(seen[0]).sort(), ["quote", "statement"]);
});

/* -------------------------------------------------------------- conflicts */

test("contradicting requirements are marked contested, never resolved", () => {
  const marked = markConflicts([
    req({ id: "a", statement: "Client Admin can manage System Admin accounts" }),
    req({ id: "b", statement: "Client Admin cannot manage System Admin accounts" }),
  ]);

  for (const r of marked) {
    assert.equal(r.confidence, "contested", "neither side may be silently declared the winner");
    assert.ok(r.conflictsWith?.length);
  }
});

test("unrelated requirements are not falsely marked as conflicting", () => {
  const marked = markConflicts([
    req({ id: "a", statement: "Client Admin can manage organization membership" }),
    req({ id: "b", statement: "Exam sessions expire after eight hours" }),
  ]);
  assert.equal(marked.every((r) => r.confidence !== "contested"), true);
});

/* ------------------------------------------------------------ assembling */

test("built context drops source bodies but keeps the citation", () => {
  const ctx = buildContext({
    feature: { key: "scoping", title: "Org scoping" },
    sources,
    requirements: [req()],
    unknowns: [],
  });

  assert.equal("content" in ctx.sources[0], false, "retrieved text is evidence, not payload");
  assert.equal(ctx.sources[0].ref, "EXM-412");
  assert.equal(ctx.provenance?.coverage?.sourcesFound, 1);
  assert.equal(ctx.provenance?.coverage?.requirementsExplicit, 1);
});

test("staleAfter is set when a lifetime is given", () => {
  const ctx = buildContext({
    feature: { key: "k", title: "t" },
    sources,
    requirements: [],
    unknowns: [],
    gatheredAt: "2026-08-05T00:00:00.000Z",
    staleAfterDays: 14,
  });
  assert.equal(ctx.staleAfter, "2026-08-19T00:00:00.000Z");
});

/* --------------------------------------------------------- oracle ceiling */

test("an explicit requirement raises the ceiling to acceptance criteria", () => {
  const ctx = buildContext({
    feature: { key: "k", title: "t" },
    sources,
    requirements: [req()],
    unknowns: [],
  });
  assert.equal(oracleCeiling(ctx).ceiling, "acceptance-criteria");
});

test("with no usable requirements the fleet is told it is testing blind", () => {
  const ctx = buildContext({
    feature: { key: "k", title: "t" },
    sources,
    requirements: [],
    unknowns: [{ question: "What should a Proctor see?" }],
  });
  const ceiling = oracleCeiling(ctx);
  assert.equal(ceiling.ceiling, "none");
  assert.match(ceiling.reason, /testing blind/);
});

test("contested requirements do not raise the ceiling", () => {
  const ctx = buildContext({
    feature: { key: "k", title: "t" },
    sources,
    requirements: [
      req({ id: "a", statement: "Client Admin can manage System Admin accounts" }),
      req({ id: "b", statement: "Client Admin cannot manage System Admin accounts" }),
    ],
    unknowns: [],
  });
  assert.equal(oracleCeiling(ctx).ceiling, "none");
});

/* ------------------------------------------------------------------ docs */

test("markdown splits into sections that carry their own line numbers", () => {
  const md = ["# Title", "intro text", "", "## Rules", "Proctors must not view users.", ""].join("\n");
  const sections = splitSections(md, "docs/rbac.md");

  const rules = sections.find((s) => s.heading === "Rules");
  assert.ok(rules);
  assert.equal(rules.file, "docs/rbac.md");
  assert.equal(rules.line, 4, "line number must point at the heading so a human can open it");
  assert.match(rules.text, /Proctors must not view users/);
});

test("normative language is detected as a ranking hint", () => {
  assert.equal(looksNormative("Proctors must not view users."), true);
  assert.equal(looksNormative("This page describes the layout."), false);
});
