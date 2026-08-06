import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerIntent,
  buildBriefing,
  newSince,
  parseIntent,
  relativeTime,
  resolvedSince,
  runTitle,
  verdictLine,
} from "../src/briefing.ts";
import type { Finding, Run, Severity, Tier } from "../src/types.ts";

const NOW = new Date("2026-08-06T09:00:00.000Z");

function f(id: string, severity: Severity = "critical", tier: Tier = "CONFIRMED"): Finding {
  return {
    id,
    axis: "rbac-scope",
    title: `${severity} problem ${id}`,
    severity,
    tier,
    oracle: { type: "spec" },
    expected: "a",
    actual: "b",
    evidence: { specFile: "s.spec.ts" },
  };
}

function run(over: Partial<Run> = {}): Run {
  return {
    schemaVersion: 1,
    runId: "r1",
    startedAt: "2026-08-06T07:00:00.000Z",
    status: "passed",
    request: { feature: "org scoping" },
    guard: { mode: "mutating", target: "localhost:8100" },
    boot: { verified: true },
    axes: [{ key: "rbac-scope", status: "done", results: { passed: 10, failed: 0, skipped: 0 } }],
    findings: [],
    coverage: { routesVisited: 8, routesKnown: 10 },
    ...over,
  };
}

/* ------------------------------------------------------------------ time */

test("times are spoken naturally, not as timestamps", () => {
  assert.equal(relativeTime("2026-08-06T08:59:30.000Z", NOW), "just now");
  assert.equal(relativeTime("2026-08-06T08:30:00.000Z", NOW), "30 minutes ago");
  assert.equal(relativeTime("2026-08-06T08:00:00.000Z", NOW), "an hour ago");
  assert.equal(relativeTime("2026-08-06T04:00:00.000Z", NOW), "5 hours ago");
  assert.equal(relativeTime("2026-08-05T09:00:00.000Z", NOW), "yesterday");
  assert.equal(relativeTime("2026-08-01T09:00:00.000Z", NOW), "5 days ago");
  // A clock skew must not produce "in -3 minutes".
  assert.equal(relativeTime("2026-08-06T09:30:00.000Z", NOW), "just now");
});

test("the greeting follows the local hour", () => {
  const at = (h: number) => buildBriefing({ now: new Date(2026, 7, 6, h, 0, 0) }).greeting;
  assert.equal(at(9), "Good morning");
  assert.equal(at(14), "Good afternoon");
  assert.equal(at(20), "Good evening");
  assert.equal(at(2), "Working late");
});

test("a name is used when given and never invented", () => {
  assert.equal(buildBriefing({ now: new Date(2026, 7, 6, 9), name: "Ilia" }).greeting, "Good morning, Ilia");
  assert.equal(buildBriefing({ now: new Date(2026, 7, 6, 9) }).greeting, "Good morning");
});

/* -------------------------------------------------------------- no data */

test("with no runs it says so rather than implying everything is fine", () => {
  const b = buildBriefing({ now: NOW });
  assert.equal(b.status, "no-data");
  assert.match(b.spoken, /no runs recorded/i);
  assert.equal(b.needsAttention.length, 0);
});

/* ------------------------------------------------------------- priority */

test("blocked outranks everything, and says nothing was tested", () => {
  const b = buildBriefing({
    now: NOW,
    latest: run({ status: "blocked", boot: { verified: false }, findings: [f("a")] }),
  });
  assert.equal(b.status, "blocked");
  assert.match(b.spoken, /could not be proved to start/);
  assert.match(b.spoken, /Nothing was actually tested/);
});

test("a guard abort is reported as the reason", () => {
  const b = buildBriefing({
    now: NOW,
    latest: run({ guard: { mode: "aborted", target: "prod", reason: "denied" } }),
  });
  assert.equal(b.status, "blocked");
  assert.match(b.spoken, /safety guard refused/);
});

test("criticals are named, and lead", () => {
  const b = buildBriefing({ now: NOW, latest: run({ findings: [f("a"), f("b", "high")] }) });
  assert.equal(b.status, "attention");
  assert.match(b.headline, /1 critical finding/);
  assert.equal(b.needsAttention.length, 2);

  const critical = b.segments.findIndex((s) => s.label === "Critical");
  const high = b.segments.findIndex((s) => s.label === "High");
  assert.ok(critical < high, "the thing needing a decision is said first");
});

/* ---------------------------------------------------------------- delta */

test("new and resolved findings are computed against the previous run", () => {
  const previous = run({ runId: "r0", findings: [f("a"), f("b")] });
  const latest = run({ runId: "r1", findings: [f("b"), f("c")] });

  assert.deepEqual(newSince(latest, previous).map((x) => x.id), ["c"]);
  assert.deepEqual(resolvedSince(latest, previous).map((x) => x.id), ["a"]);

  const b = buildBriefing({ now: NOW, latest, previous });
  assert.match(b.spoken, /1 finding is new/);
  assert.match(b.spoken, /1 finding from the previous run is gone/);
});

test("unconfirmed findings are not counted as new", () => {
  const latest = run({ findings: [f("x", "critical", "PLAUSIBLE")] });
  assert.deepEqual(newSince(latest, run({ findings: [] })), []);
});

/* -------------------------------------------------------------- honesty */

test("a clean run with thin coverage is not reported as fine", () => {
  const b = buildBriefing({ now: NOW, latest: run({ coverage: { routesVisited: 1, routesKnown: 10 } }) });
  const clear = b.segments.find((s) => s.label === "Clear");
  assert.match(clear?.text ?? "", /not the same as being fine/);
  assert.equal(clear?.tone, "warn");
});

test("a clean run with real coverage is allowed to sound clean", () => {
  const b = buildBriefing({ now: NOW, latest: run() });
  assert.equal(b.status, "clear");
  assert.equal(b.segments.find((s) => s.label === "Clear")?.tone, "good");
});

test("skipped specs are called an open question, not a pass", () => {
  const b = buildBriefing({
    now: NOW,
    latest: run({ axes: [{ key: "qa", status: "done", results: { passed: 5, failed: 0, skipped: 3 } }] }),
  });
  assert.equal(b.status, "attention");
  assert.match(b.spoken, /open question, not a pass/);
});

test("drafts waiting on approval are surfaced, with the guarantee restated", () => {
  const drafted = { ...f("d"), tracker: { status: "drafted" as const } };
  const b = buildBriefing({ now: NOW, latest: run({ findings: [drafted] }) });
  assert.match(b.spoken, /waiting for your approval/);
  assert.match(b.spoken, /Nothing is filed until you say so/);
});

test("the spoken form and the visible segments can never diverge", () => {
  const b = buildBriefing({ now: NOW, latest: run({ findings: [f("a")] }) });
  for (const segment of b.segments) {
    assert.ok(b.spoken.includes(segment.text), `spoken output is missing: ${segment.label}`);
  }
});

/* -------------------------------------------------------------- intents */

test("spoken questions map to intents without a model call", () => {
  assert.equal(parseIntent("how are we doing this morning"), "briefing");
  assert.equal(parseIntent("give me a status update"), "briefing");
  assert.equal(parseIntent("what is critical"), "criticals");
  assert.equal(parseIntent("anything urgent?"), "criticals");
  assert.equal(parseIntent("why was it blocked"), "blocked");
  assert.equal(parseIntent("what did you skip"), "skipped");
  assert.equal(parseIntent("how much coverage did we get"), "coverage");
  assert.equal(parseIntent("make me a sandwich"), "unknown");
});

test("an unrecognised request lists what can actually be asked", () => {
  const b = buildBriefing({ now: NOW, latest: run() });
  const answer = answerIntent("unknown", b);
  assert.match(answer, /how we are doing/);
  assert.match(answer, /critical/);
});

test("intent answers are drawn from the same briefing, so they cannot disagree", () => {
  const b = buildBriefing({ now: NOW, latest: run({ findings: [f("a")] }) });
  const spokenCriticals = answerIntent("criticals", b);
  assert.ok(b.spoken.includes(spokenCriticals), "an answer must be a slice of the briefing, not a new claim");
});

test("asking about criticals when there are none gets a plain no", () => {
  const b = buildBriefing({ now: NOW, latest: run() });
  assert.match(answerIntent("criticals", b), /no confirmed critical findings/i);
});

test("unknown coverage is never reported as clear", () => {
  // "Nothing was found" and "nothing was looked at" render identically, and
  // only one of them is good news.
  const b = buildBriefing({ now: NOW, latest: run({ coverage: undefined }) });
  assert.notEqual(b.status, "clear");
  assert.equal(b.status, "attention");
  assert.match(b.spoken, /cannot really be interpreted/);
});

test("formal address changes register but never a fact", () => {
  // Constructed in LOCAL time: deriving a greeting from a UTC instant makes the
  // assertion depend on the machine's offset.
  const morning = new Date(2026, 7, 6, 9, 0, 0);
  const latest = run({ findings: [f("a")] });
  const plain = buildBriefing({ now: morning, latest });
  const formal = buildBriefing({ now: morning, latest, address: "formal" });

  assert.equal(formal.greeting, "Good morning, sir");
  assert.match(formal.spoken, /Standing by/);
  // The phrasing layer must not be able to soften or drop a finding.
  assert.equal(formal.headline, plain.headline);
  assert.equal(formal.status, plain.status);
  assert.equal(formal.needsAttention.length, plain.needsAttention.length);
  for (const s of plain.segments) {
    assert.ok(formal.spoken.includes(s.text), `formal briefing dropped: ${s.label}`);
  }
});

test("an explicit name still wins over the formal honorific", () => {
  const b = buildBriefing({ now: new Date(2026, 7, 6, 9, 0, 0), name: "Ilia", address: "formal" });
  assert.equal(b.greeting, "Good morning, Ilia");
});

/* ------------------------------------------------------------- verdict line */

const runWith = (over: Partial<Run>): Run => ({
  schemaVersion: 1,
  runId: "r1",
  startedAt: new Date().toISOString(),
  status: "findings",
  guard: { mode: "mutating", target: "localhost:4600" },
  axes: [],
  findings: [],
  ...over,
});

const finding = (tier: Run["findings"][number]["tier"]): Run["findings"][number] => ({
  id: `f-${tier}`,
  axis: "rbac-scope",
  title: "x",
  severity: "high",
  tier,
  oracle: { type: "code-intent" },
  expected: "",
  actual: "",
  evidence: { specFile: "x.spec.ts" },
});

test("the headline never claims more confidence than the findings carry", () => {
  // "DETECTIONS CONFIRMED" was hardcoded for any run with findings. After triage
  // started grading, that headline could sit above zero confirmed.
  assert.deepEqual(verdictLine(runWith({ findings: [finding("CONFIRMED")] })), {
    tone: "confirmed",
    text: "1 CONFIRMED",
  });

  assert.deepEqual(
    verdictLine(runWith({ findings: [finding("PLAUSIBLE"), finding("QUESTION")] })),
    { tone: "unconfirmed", text: "2 UNCONFIRMED" },
  );
});

test("red tests with no recorded finding read as a failure, not a clean run", () => {
  // A gap in the run. Colouring it like a normal findings run would make the
  // most suspicious state look ordinary.
  const v = verdictLine(
    runWith({ axes: [{ key: "happy-path", status: "done", results: { failed: 1 } }] }),
  );
  assert.equal(v.tone, "unrecorded");
  assert.equal(v.text, "FAILURES UNRECORDED");
});

test("a passed run says so, and a blocked one is never softened", () => {
  assert.equal(verdictLine(runWith({ status: "passed" })).text, "ALL CLEAR");
  assert.equal(verdictLine(runWith({ status: "blocked" })).tone, "blocked");
});

test("a run nobody named is described by what it actually ran", () => {
  // "Untitled run" tells a reader nothing, and most runs are launched with no
  // --feature.
  assert.equal(runTitle(runWith({ request: { feature: "org scoping" } })), "org scoping");

  assert.equal(
    runTitle(runWith({ axes: [{ key: "rbac-scope", status: "done" }] })),
    "rbac-scope",
  );
  assert.equal(
    runTitle(
      runWith({
        axes: [
          { key: "rbac-scope", status: "done" },
          { key: "adversarial", status: "done" },
        ],
      }),
    ),
    "rbac-scope + adversarial",
  );

  // Nothing ran: say which axes were asked for, never imply a full run.
  assert.equal(
    runTitle(
      runWith({
        status: "blocked",
        request: { axes: ["responsive-a11y"] },
        axes: [{ key: "responsive-a11y", status: "skipped" }],
      }),
    ),
    "responsive-a11y (did not run)",
  );
});
