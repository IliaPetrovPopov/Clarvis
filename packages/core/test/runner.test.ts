import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaywrightReport, renderPlaywrightConfig } from "../src/runner.ts";
import { failedTests, findingsFromReport } from "../src/agents/prover.ts";

/**
 * These counts are the product's only source of truth about what happened. The
 * UI shows them, the release gate decides on them, and the briefing speaks them.
 * Nothing here may round in the optimistic direction.
 */

/* -------------------------------------------------------------- reporting */

test("counts come from the reporter's own stats block", () => {
  const results = parsePlaywrightReport({
    stats: { expected: 12, unexpected: 3, flaky: 1, skipped: 2, duration: 4210.7 },
  });
  assert.deepEqual(results, { passed: 12, failed: 3, skipped: 2, flaky: 1, durationMs: 4211 });
});

test("a report with no stats block is walked rather than reported as zeros", () => {
  // Zeros here would read as "nothing failed", which is the one answer this
  // function must never give when it does not know.
  const results = parsePlaywrightReport({
    suites: [
      {
        specs: [
          { tests: [{ status: "expected", results: [{ duration: 100 }] }] },
          { tests: [{ status: "unexpected", results: [{ duration: 200 }] }] },
        ],
        suites: [
          {
            specs: [
              { tests: [{ status: "skipped", results: [] }] },
              { tests: [{ status: "flaky", results: [{ duration: 50 }] }] },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(results, { passed: 1, failed: 1, skipped: 1, flaky: 1, durationMs: 350 });
});

test("an unrecognisable report yields zeros, which the caller treats as an error", () => {
  assert.deepEqual(parsePlaywrightReport(null), {
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs: 0,
  });
});

/* ------------------------------------------------------------------ config */

test("each axis only runs its own specs", () => {
  // Every axis shares one scratch directory. Without testMatch, each axis runs
  // every other axis' specs: the counts multiply and each finding is filed once
  // per axis, attributed to whichever axis happened to execute it.
  const config = renderPlaywrightConfig({
    baseURL: "http://localhost:4600",
    testDir: "/tmp/scratch",
    outputDir: "/tmp/out",
    testMatch: ["rbac-scope-1.spec.ts"],
  });

  assert.match(config, /testMatch: \["rbac-scope-1\.spec\.ts"\]/);
  assert.equal(config.includes("adversarial"), false);
});

test("the generated config never enables retries or forbidOnly by accident", () => {
  const config = renderPlaywrightConfig({
    baseURL: "http://localhost:4600",
    testDir: "/tmp/scratch",
    outputDir: "/tmp/out",
  });
  // Retries turn a real intermittent failure into a pass, which is a finding
  // deleted rather than a finding graded.
  assert.match(config, /retries: 0/);
  assert.match(config, /forbidOnly: true/);
  assert.match(config, /trace: "retain-on-failure"/);
});

/* ---------------------------------------------------------------- findings */

const REPORT = {
  suites: [
    {
      file: "rbac-scope-1.spec.ts",
      specs: [
        {
          title: "viewer must not reach /admin",
          file: "rbac-scope-1.spec.ts",
          line: 12,
          tests: [
            {
              status: "unexpected",
              results: [
                {
                  status: "failed",
                  error: { message: "Expected 403, received 200" },
                  attachments: [
                    { name: "trace", path: "/tmp/out/trace.zip" },
                    { name: "screenshot", path: "/tmp/out/shot.png" },
                  ],
                },
              ],
            },
          ],
        },
        { title: "admin can reach /admin", tests: [{ status: "expected", results: [] }] },
      ],
    },
  ],
};

test("only failures become findings, and they carry their evidence", () => {
  const failures = failedTests(REPORT);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].title, "viewer must not reach /admin");

  const findings = findingsFromReport({ axis: "rbac-scope", report: REPORT, runId: "r1" });
  assert.equal(findings.length, 1);

  const f = findings[0];
  assert.equal(f.severity, "critical");
  assert.equal(f.evidence.tracePath, "/tmp/out/trace.zip");
  assert.deepEqual(f.evidence.screenshots, ["/tmp/out/shot.png"]);
  assert.match(f.actual, /Expected 403, received 200/);
});

test("one red test is PLAUSIBLE, never CONFIRMED", () => {
  // Confirmation requires an independent reproduction. A single failing
  // assertion is evidence, not a verdict.
  const [f] = findingsFromReport({ axis: "rbac-scope", report: REPORT, runId: "r1" });
  assert.equal(f.tier, "PLAUSIBLE");
  assert.match(f.tierReason!, /not reproduced it yet/i);
});

test("with no context, the oracle is code-intent and does not pretend otherwise", () => {
  const [f] = findingsFromReport({ axis: "adversarial", report: REPORT, runId: "r1" });
  assert.equal(f.oracle.type, "code-intent");
  assert.equal(f.oracle.quote, undefined);
});

test("a cited requirement raises the oracle and carries its quote", () => {
  const context = {
    schemaVersion: 1 as const,
    feature: { key: "rbac", title: "RBAC" },
    sources: [{ id: "s1", type: "readme" as const, ref: "README.md:14", content: "" }],
    requirements: [
      {
        id: "R1",
        statement: "A viewer must not be able to reach /admin.",
        quote: "A viewer must not be able to reach `/admin`.",
        sourceIds: ["s1"],
        confidence: "explicit" as const,
      },
    ],
    unknowns: [],
    generatedAt: new Date().toISOString(),
  };

  const [f] = findingsFromReport({
    axis: "rbac-scope",
    report: REPORT,
    runId: "r1",
    context: context as never,
    spec: {
      covers: ["R1"],
      // Realistic: the id is cited inside the test it belongs to, which is the
      // only place the matcher looks.
      source: `test("viewer must not reach /admin", async () => {\n  // R1: the route must refuse\n  expect(s).toBe(403);\n});`,
      axis: "rbac-scope",
      file: "x",
      attempts: 1,
      untested: [],
    } as never,
  });

  assert.equal(f.oracle.type, "acceptance-criteria");
  assert.match(f.oracle.citation!, /R1/);
  assert.match(f.oracle.citation!, /README\.md:14/);
  assert.equal(f.expected, "A viewer must not be able to reach `/admin`.");
});

test("a flaky test is recorded as flaky, not quietly as a pass", () => {
  const flaky = {
    suites: [
      {
        specs: [
          {
            title: "creates a note",
            tests: [{ status: "flaky", results: [{ error: { message: "timeout" } }] }],
          },
        ],
      },
    ],
  };

  const [f] = findingsFromReport({ axis: "happy-path", report: flaky, runId: "r1" });
  assert.equal(f.determinism?.verdict, "flaky");
  assert.match(f.tierReason!, /intermittent/i);
});

/* ------------------------------------------------------------ oracle match */

const CTX = {
  schemaVersion: 1 as const,
  feature: { key: "f", title: "F" },
  sources: [{ id: "s1", type: "readme" as const, ref: "README.md:25", content: "" }],
  requirements: [
    { id: "r1", statement: "Signed-out visitors go to /login.", quote: "A signed-out visitor must be redirected to /login.", sourceIds: ["s1"], confidence: "contested" as const },
    { id: "r2", statement: "A viewer must not reach /admin.", quote: "A viewer must not be able to reach /admin.", sourceIds: ["s1"], confidence: "explicit" as const },
    { id: "r10", statement: "Titles are escaped.", quote: "Note titles must be escaped before display.", sourceIds: ["s1"], confidence: "explicit" as const },
  ],
  unknowns: [],
  generatedAt: new Date().toISOString(),
};

const specWith = (source: string, covers: string[] = []) =>
  ({ axis: "rbac-scope", file: "x.spec.ts", source, covers, attempts: 1, untested: [] }) as never;

test("a requirement id is matched on a word boundary, not as a substring", async () => {
  const { citesRequirement, oracleFor } = await import("../src/agents/prover.ts");

  // The bug this exists for: `includes("r1")` matches inside "r10", and since
  // the scan returned the first match, a live run attributed nearly every
  // finding to r1 regardless of what it was about.
  assert.equal(citesRequirement("// covers r10", "r1"), false);
  assert.equal(citesRequirement("// covers r10", "r10"), true);
  assert.equal(citesRequirement("// covers r1: the redirect", "r1"), true);
  assert.equal(citesRequirement("for1 and bar1", "r1"), false);

  const oracle = oracleFor(
    { title: "titles are escaped" },
    specWith(`test("titles are escaped", async () => {\n  // r10 - titles must be escaped\n  expect(x).toBe(y);\n});`),
    CTX as never,
  );
  assert.match(oracle.citation!, /^r10 /);
});

test("a contested requirement is never used as an oracle", async () => {
  const { oracleFor } = await import("../src/agents/prover.ts");
  // Citing a requirement that other requirements contradict would present a
  // disagreement as a standard.
  const oracle = oracleFor(
    { title: "redirects" },
    specWith(`test("redirects", async () => {\n  // r1 only\n  expect(a).toBe(b);\n});`),
    CTX as never,
  );
  assert.equal(oracle.type, "code-intent");
  assert.equal(oracle.citation, undefined);
});

test("the citation and the oracle type never disagree", async () => {
  const { oracleFor } = await import("../src/agents/prover.ts");
  // A live run printed "oracle code-intent (r1 (README.md:25))" - a weak label
  // beside a cited source, which is two different claims about the same finding.
  for (const cite of ["r1 and r2", "r2", "r10"]) {
    const source = `test("t", async () => {\n  // ${cite}\n  expect(a).toBe(b);\n});`;
    const oracle = oracleFor({ title: "t" }, specWith(source), CTX as never);
    if (oracle.citation) assert.equal(oracle.type, "acceptance-criteria");
    if (oracle.type === "code-intent") assert.equal(oracle.citation, undefined);
  }
});

test("an explicit requirement wins over an implied one cited in the same spec", async () => {
  const { oracleFor } = await import("../src/agents/prover.ts");
  const ctx = {
    ...CTX,
    requirements: [
      { id: "r5", statement: "implied thing", quote: "q5", sourceIds: ["s1"], confidence: "implied" as const },
      { id: "r6", statement: "explicit thing", quote: "q6", sourceIds: ["s1"], confidence: "explicit" as const },
    ],
  };
  const source = `test("t", async () => {\n  // r5 and r6\n  expect(a).toBe(b);\n});`;
  const oracle = oracleFor({ title: "t" }, specWith(source), ctx as never);
  assert.match(oracle.citation!, /^r6 /);
});

test("a finding is attributed to the requirement cited in its own test, not the file's", async () => {
  // A live run produced nine confirmed findings of which eight cited r2 - the
  // /admin rule - including the empty-title, HttpOnly and Arabic locale bugs.
  // The author had cited the right id above each assertion; the matcher was
  // scanning the whole file and taking the first explicit match.
  const { oracleFor, testRegion } = await import("../src/agents/prover.ts");

  const source = `import { test, expect } from "@playwright/test";

test("viewer is refused at /admin", async ({ request }) => {
  // r2: the route itself must refuse a viewer
  expect((await request.get("/admin")).status()).toBe(403);
});

test("empty note title is rejected", async ({ request }) => {
  // r3: an empty title submission must be rejected
  expect(await count()).toBe(before);
});`;

  assert.match(testRegion(source, "empty note title is rejected"), /r3/);
  assert.equal(testRegion(source, "empty note title is rejected").includes("r2"), false);

  const ctx = {
    ...CTX,
    requirements: [
      { id: "r2", statement: "no admin", quote: "q2", sourceIds: ["s1"], confidence: "explicit" as const },
      { id: "r3", statement: "no empty title", quote: "q3", sourceIds: ["s1"], confidence: "explicit" as const },
    ],
  };

  assert.match(
    oracleFor({ title: "empty note title is rejected" }, specWith(source), ctx as never).citation!,
    /^r3 /,
  );
  assert.match(
    oracleFor({ title: "viewer is refused at /admin" }, specWith(source), ctx as never).citation!,
    /^r2 /,
  );
});

test("a test that cites nothing gets code-intent, not the file's first requirement", async () => {
  const { oracleFor } = await import("../src/agents/prover.ts");
  const source = `import { test, expect } from "@playwright/test";

test("something incidental", async () => {
  expect(1).toBe(2);
});`;
  // The author is told to cite the id above each assertion. Falling back to the
  // file's covers list would restore the over-attribution this fixes.
  const oracle = oracleFor({ title: "something incidental" }, specWith(source, ["r2"]), CTX as never);
  assert.equal(oracle.type, "code-intent");
  assert.equal(oracle.citation, undefined);
});
