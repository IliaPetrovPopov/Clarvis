// Must come first: it points the store at a temp directory before any
// module under test resolves a path from it.
import "./isolate.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ageLessons,
  mistakesFrom,
  renderLessons,
  vetLesson,
  RETIRE_AFTER_QUIET_RUNS,
  type Lesson,
  type Lessons,
} from "../src/lessons.ts";
import type { Run } from "../src/types.ts";

/**
 * The vet is the whole safety story here.
 *
 * An agent proposing its own instructions is one bad sentence away from
 * teaching the fleet to be easier on itself, and nothing downstream would
 * notice - a spec author told "prefer visibility checks" produces green runs
 * for exactly as long as anyone keeps trusting them. So the rules are code,
 * and these are the tests that keep them there.
 */

const lesson = (text: string, over: Partial<Lesson> = {}): Lesson => ({
  id: "r1-l1",
  text,
  evidence: { runId: "r1", from: "gate", detail: "d" },
  learnedAt: new Date().toISOString(),
  recurrences: 0,
  quietRuns: 0,
  ...over,
});

test("a lesson that makes the author's job easier is refused", () => {
  // Every one of these would raise the pass rate and lower the value of a
  // pass to nothing. They are the proposals most likely to be made, because
  // each genuinely would have prevented the failure that prompted it.
  const refusable = [
    "If a test is flaky, skip it rather than letting it fail the run.",
    "Use test.skip for assertions that cannot be made reliable.",
    "Prefer toBeVisible instead of asserting on the response status.",
    "When a route is hard to reach, log in manually in the spec.",
    "Wrap the assertion in a catch and ignore the error when the page is slow.",
    "Relax the gate rule about vacuous assertions for a11y specs.",
    "Add the host to forbiddenHosts so the spec can reach it.",
  ];

  for (const text of refusable) {
    const verdict = vetLesson(text);
    assert.equal(verdict.ok, false, `should have been refused: "${text}"`);
  }
});

test("a lesson that says what to do instead is kept", () => {
  const verdict = vetLesson(
    "Before asserting focus order, read the DOM order: a control rendered inside a label row precedes the input it labels.",
  );
  assert.equal(verdict.ok, true);
});

test("a lesson too long to read, or too short to act on, is refused", () => {
  assert.equal(vetLesson("Be careful.").ok, false);
  assert.equal(vetLesson(`Do the thing. ${"and again ".repeat(40)}`).ok, false);
});

test("a near-duplicate is refused rather than crowding the brief", () => {
  const existing = [
    lesson("Before asserting focus order, read the DOM order of the controls involved."),
  ];
  const verdict = vetLesson(
    "Read the DOM order of the involved controls before asserting anything about focus order.",
    existing,
  );
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.why, /almost the same/);
});

/* ------------------------------------------------------------- gathering */

test("only the author's own mistakes become lessons", () => {
  const run = {
    runId: "r1",
    findings: [
      {
        id: "f1",
        axis: "responsive-a11y",
        title: "tab order",
        tier: "DISCARDED",
        tierReason: "The fault is in the test, not the product. It encodes an adjacency the markup never had.",
      },
      {
        id: "f2",
        axis: "rbac-scope",
        title: "viewer reaches /admin",
        tier: "CONFIRMED",
        tierReason: "Reproduced 3/3. The application returns 200.",
      },
    ],
  } as unknown as Run;

  const mistakes = mistakesFrom(run, [{ axis: "adversarial", violations: ["vacuous-assertion: asserts on a literal"] }]);

  // The gate refusal and the test-fault finding, and NOT the confirmed one -
  // a real defect found is the system working, not something to learn from.
  assert.equal(mistakes.length, 2);
  assert.ok(mistakes.some((m) => m.from === "gate"));
  assert.ok(mistakes.some((m) => m.from === "triage" && m.detail.includes("tab order")));
  assert.ok(!mistakes.some((m) => m.detail.includes("viewer reaches")));
});

/* ----------------------------------------------------------------- ageing */

test("a lesson whose mistake stops happening retires", () => {
  let store: Lessons = {
    schemaVersion: 1,
    updatedAt: "",
    lessons: [lesson("Read the DOM order before asserting focus order between controls.")],
    retired: [],
  };

  for (let i = 0; i < RETIRE_AFTER_QUIET_RUNS; i++) {
    store = ageLessons(store, [{ from: "gate", detail: "something entirely unrelated" }]);
  }

  assert.equal(store.lessons.length, 0, "a lesson nobody needs should not keep costing attention");
  assert.equal(store.retired.length, 1);
  assert.match(store.retired[0].why, /No sign of this mistake/);
});

test("a lesson whose mistake recurs is reinforced, not retired", () => {
  const store = ageLessons(
    {
      schemaVersion: 1,
      updatedAt: "",
      lessons: [lesson("Read the DOM order before asserting focus order between controls.")],
      retired: [],
    },
    [{ from: "triage", detail: "the spec asserted focus order without reading the DOM order first" }],
  );

  assert.equal(store.lessons.length, 1);
  assert.equal(store.lessons[0].recurrences, 1);
  assert.equal(store.lessons[0].quietRuns, 0);
});

/* --------------------------------------------------------------- rendering */

test("the brief leads with the mistake made most often", () => {
  const rendered = renderLessons({
    schemaVersion: 1,
    updatedAt: "",
    lessons: [
      lesson("Once-made mistake about selectors and page structure."),
      lesson("Repeated mistake about focus order and DOM order.", { recurrences: 3 }),
    ],
    retired: [],
  });

  const first = rendered.indexOf("Repeated mistake");
  const second = rendered.indexOf("Once-made mistake");
  assert.ok(first > 0 && first < second, "the most frequent mistake should be read first");
  assert.match(rendered, /made this mistake 4 times/);
});

test("nothing learned renders nothing at all", () => {
  assert.equal(renderLessons({ schemaVersion: 1, updatedAt: "", lessons: [], retired: [] }), "");
});
