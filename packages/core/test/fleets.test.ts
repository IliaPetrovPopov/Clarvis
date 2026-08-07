import { test } from "node:test";
import assert from "node:assert/strict";
import { FLEETS, resolveFleets, toFleetKey, describeResolution } from "../src/fleets.ts";
import { decideRelease, releaseExitCode } from "../src/releaseGate.ts";
import type { Run, Finding, Severity, Tier } from "../src/types.ts";

/* ------------------------------------------------------------- selection */

test("recon is always included, even when not asked for", () => {
  const r = resolveFleets({ requested: ["qa"] });
  assert.ok(r.order.includes("recon"));
  assert.equal(r.order[0], "recon", "recon must run before anything that reads its profile");
  assert.match(r.autoIncluded.map((a) => a.because).join(" "), /mandatory/i);
});

test("recon alone is a valid run", () => {
  const r = resolveFleets({ requested: [] });
  assert.deepEqual(r.order, ["recon"]);
  assert.deepEqual(r.errors, []);
});

test("dependencies are pulled in transitively", () => {
  // delivery needs qa, qa needs recon.
  const r = resolveFleets({ requested: ["delivery"] });
  assert.deepEqual(r.order, ["recon", "qa", "delivery"]);
});

test("every optional fleet can actually be turned off", () => {
  const r = resolveFleets({ requested: ["recon"] });
  for (const key of ["research", "lead", "qa", "delivery", "release"] as const) {
    assert.equal(r.order.includes(key), false, `${key} should be optional`);
    assert.equal(FLEETS[key].mandatory, false);
  }
});

test("codenames and keys both resolve", () => {
  assert.equal(toFleetKey("PROVER"), "qa");
  assert.equal(toFleetKey("prover"), "qa");
  assert.equal(toFleetKey("qa"), "qa");
  assert.equal(toFleetKey("Scout"), "recon");
  assert.equal(toFleetKey("nonsense"), undefined);

  const r = resolveFleets({ requested: ["judge"] });
  assert.deepEqual(r.order, ["recon", "qa", "release"]);
});

test("a retired codename is not quietly still accepted", () => {
  // The teams were renamed because six names that all sounded like movement
  // were impossible to keep straight. Leaving the old ones working would mean
  // two names per team, which is the same problem with an extra step - and a
  // script using one would keep printing a word the dashboard no longer shows.
  for (const retired of ["crucible", "pathfinder", "dossier", "vector", "dispatch", "clearance"]) {
    assert.equal(toFleetKey(retired), undefined, `${retired} should no longer resolve`);
  }
});

test("an unknown fleet is an error, not a silent drop", () => {
  const r = resolveFleets({ requested: ["qa", "marketing"] });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /marketing/);
});

test("a fresh cached artifact satisfies a fleet without re-running it", () => {
  const r = resolveFleets({ requested: ["qa"], freshArtifacts: ["recon"] });
  assert.deepEqual(r.satisfiedByCache, ["recon"]);
  const forced = resolveFleets({ requested: ["qa"], freshArtifacts: ["recon"], force: true });
  assert.deepEqual(forced.satisfiedByCache, []);
});

test("non-cacheable fleets are never satisfied by cache", () => {
  const r = resolveFleets({ requested: ["qa"], freshArtifacts: ["qa", "recon"] });
  assert.equal(r.satisfiedByCache.includes("qa"), false);
});

/* ----------------------------------------------------------- degradation */

test("running QA without research is reported as a high degradation", () => {
  const r = resolveFleets({ requested: ["qa"] });
  const d = r.degradations.find((x) => x.fleet === "qa" && x.missing === "research");
  assert.ok(d, "skipping research must not be silent");
  assert.equal(d.severity, "high");
  assert.match(d.effect, /acceptance criteria/i);
});

test("a full run has no degradations", () => {
  const r = resolveFleets({ requested: "all" });
  assert.deepEqual(r.degradations, []);
});

test("the summary names fleets by codename and shouts about degradation", () => {
  const lines = describeResolution(resolveFleets({ requested: ["qa"] })).join("\n");
  assert.match(lines, /SCOUT -> PROVER/);
  assert.match(lines, /DEGRADED PROVER without ARCHIVE/);
});

/* -------------------------------------------------------------- release */

function run(over: Partial<Run> = {}): Run {
  return {
    schemaVersion: 1,
    runId: "r1",
    startedAt: "2026-08-05T00:00:00.000Z",
    status: "passed",
    guard: { mode: "mutating", target: "localhost:8100" },
    boot: { verified: true },
    axes: [{ key: "qa", status: "done", results: { passed: 10, failed: 0, skipped: 0 } }],
    findings: [],
    coverage: { routesVisited: 8, routesKnown: 10 },
    ...over,
  };
}

function f(severity: Severity, tier: Tier = "CONFIRMED"): Finding {
  return {
    id: `x-${severity}-${tier}`,
    axis: "qa" as never,
    title: `${severity} thing`,
    severity,
    tier,
    oracle: { type: "spec" },
    expected: "a",
    actual: "b",
    evidence: { specFile: "s.spec.ts" },
  };
}

test("a clean, well-covered run ships", () => {
  const v = decideRelease(run());
  assert.equal(v.decision, "ship");
  assert.equal(releaseExitCode(v), 0);
});

test("a confirmed critical blocks", () => {
  const v = decideRelease(run({ findings: [f("critical")] }));
  assert.equal(v.decision, "blocked");
  assert.equal(releaseExitCode(v), 2);
});

test("an unconfirmed critical does not block, but is reported", () => {
  const v = decideRelease(run({ findings: [f("critical", "PLAUSIBLE")] }));
  assert.notEqual(v.decision, "blocked");
  assert.equal(v.counts.unverified, 1);
  assert.ok(v.reasons.some((r) => r.code === "unverified-findings"));
});

test("skipped specs hold the release", () => {
  const v = decideRelease(
    run({ axes: [{ key: "qa", status: "done", results: { passed: 5, failed: 0, skipped: 2 } }] }),
  );
  assert.equal(v.decision, "hold");
  assert.match(v.reasons.map((r) => r.detail).join(" "), /unanswered question/i);
});

test("a run where nothing executed is blocked, never shipped", () => {
  const v = decideRelease(run({ axes: [{ key: "qa", status: "skipped" }] }));
  assert.equal(v.decision, "blocked");
  assert.ok(v.reasons.some((r) => r.code === "nothing-ran"));
});

test("an unverified boot blocks", () => {
  const v = decideRelease(run({ boot: { verified: false } }));
  assert.equal(v.decision, "blocked");
});

test("a guard-aborted run blocks", () => {
  const v = decideRelease(run({ guard: { mode: "aborted", target: "prod", reason: "denied" } }));
  assert.equal(v.decision, "blocked");
});

test("thin route coverage holds the release", () => {
  const v = decideRelease(run({ coverage: { routesVisited: 1, routesKnown: 10 } }));
  assert.equal(v.decision, "hold");
  assert.ok(v.reasons.some((r) => r.code === "low-coverage"));
});

test("a high-severity degradation reaches the verdict", () => {
  const v = decideRelease(run(), {
    degradations: [
      {
        fleet: "qa",
        missing: "research",
        severity: "high",
        effect: "No acceptance criteria.",
        mitigation: "Enable research.",
      },
    ],
  });
  assert.equal(v.decision, "hold", "a green run built on nothing must not read as shippable");
  assert.ok(v.reasons.some((r) => r.code === "degraded-run"));
});

test("what was not checked is always carried on the verdict", () => {
  const v = decideRelease(
    run({
      axes: [
        { key: "qa", status: "done", results: { passed: 3, failed: 0, skipped: 0 } },
        { key: "i18n-rtl", status: "skipped", skipReason: "no locales seeded" },
      ],
      truncation: ["Only the first 25 users were inspected."],
    }),
  );
  assert.ok(v.notChecked.some((n) => /no locales seeded/.test(n)));
  assert.ok(v.notChecked.some((n) => /first 25 users/.test(n)));
});
