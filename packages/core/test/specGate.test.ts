import { test } from "node:test";
import assert from "node:assert/strict";
import { gateSpec, describeViolations } from "../src/agents/specGate.ts";

const HEAD = `import { test, expect } from "@playwright/test";\n`;

const codes = (source: string, opts = {}) => gateSpec(source, opts).violations.map((v) => v.code);

/* --------------------------------------------------------------- accepts */

test("a real spec passes the gate", () => {
  const result = gateSpec(`${HEAD}
test("a viewer cannot reach the admin page", async ({ page }) => {
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(403);
  await expect(page.getByTestId("admin-notes")).toHaveCount(0);
});
`);

  assert.equal(result.ok, true);
  assert.deepEqual(result.stats, { tests: 1, assertions: 2 });
});

test("a rule never fires on a comment describing it", () => {
  // Agents explain themselves in comments constantly, and a gate that reads its
  // own vocabulary back out of prose rejects perfectly good specs.
  const result = gateSpec(`${HEAD}
// Deliberately not using expect(true) here - we assert the real status instead.
/* test.skip is not appropriate: the route exists. */
test("status is 403", async ({ page }) => {
  const r = await page.goto("/admin");
  expect(r?.status()).toBe(403);
});
`);
  assert.equal(result.ok, true);
});

/* --------------------------------------------------------------- rejects */

test("a test with no assertion is refused", () => {
  const result = gateSpec(`${HEAD}
test("loads the page", async ({ page }) => {
  await page.goto("/notes");
});
`);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => v.code), ["no-assertions"]);
});

test("assertions that cannot fail are refused", () => {
  assert.ok(codes(`${HEAD}test("x", async () => { expect(true).toBe(true); });`).includes("vacuous-assertion"));
  assert.ok(codes(`${HEAD}test("x", async () => { expect(1).toBe(1); });`).includes("vacuous-assertion"));
  assert.ok(
    codes(`${HEAD}test("x", async ({ page }) => { const t = await page.title(); expect(t).toBeDefined(); });`).includes(
      "vacuous-assertion",
    ),
  );
});

test("a swallowed failure is refused, an inspected one is not", () => {
  const swallowed = `${HEAD}
test("creates a note", async ({ page }) => {
  try {
    await page.getByTestId("note-submit").click();
    expect(await page.getByTestId("note").count()).toBeGreaterThan(0);
  } catch (e) {}
});`;
  assert.ok(codes(swallowed).includes("swallowed-failure"));

  const inspected = `${HEAD}
test("rejects an empty title", async ({ page }) => {
  try {
    await page.getByTestId("note-submit").click();
  } catch (e) {
    expect(String(e)).toContain("required");
  }
});`;
  assert.equal(codes(inspected).includes("swallowed-failure"), false);
});

test("disabled and focused tests are refused", () => {
  assert.ok(codes(`${HEAD}test.skip("later", async () => { expect(1).toBe(2); });`).includes("disabled-test"));
  assert.ok(codes(`${HEAD}test.only("this one", async () => { expect(1).toBe(2); });`).includes("focused-test"));
});

test("a spec naming a denied host is refused even though the guard passed", () => {
  // The guard checks the target the run was pointed at. A spec can address a
  // different host directly and go straight past it.
  const result = gateSpec(
    `${HEAD}
test("checks the shared database dashboard", async ({ page }) => {
  await page.goto("http://db.demo-prod.example:5432/status");
  await expect(page.getByText("ok")).toBeVisible();
});`,
    { forbiddenHosts: ["db.demo-prod.example", "*prod*"] },
  );

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.code === "forbidden-host"));
});

test("a missing playwright import is refused", () => {
  assert.ok(codes(`test("x", async () => { expect(2).toBe(3); });`).includes("no-import"));
});

/* -------------------------------------------------------------- warnings */

test("a conditional assertion warns without blocking", () => {
  const result = gateSpec(`${HEAD}
test("shows the banner when present", async ({ page }) => {
  await page.goto("/notes");
  if (await page.getByTestId("banner").isVisible()) {
    expect(await page.getByTestId("banner").textContent()).toContain("Welcome");
  }
});`);

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.code === "conditional-assertion"));
});

/* ------------------------------------------------------------ retry text */

test("violations are phrased so the author can act on them", () => {
  const result = gateSpec(`${HEAD}test("x", async () => { expect(true).toBe(true); });`);
  const text = describeViolations(result.violations);
  assert.match(text, /vacuous-assertion/);
  assert.match(text, /line \d+/);
  // The remedy is what actually changes the next attempt.
  assert.match(text, /Assert against the application's actual state/);
});

test("a gap admitted in a comment but not in the untested field is refused", () => {
  // A live run produced exactly this: a careful header explaining why the
  // stored-XSS case could not be tested, and an empty untested array. The run
  // then reported that axis as fully covered.
  const source = `${HEAD}
/*
 * The note-title script payload case is left out - this server exposes no
 * reset route, so a created note could never be cleaned up.
 */
test("rejects a forged session", async ({ request }) => {
  const r = await request.get("/notes", { headers: { cookie: "sid=nope" }, maxRedirects: 0 });
  expect(r.status()).toBe(302);
});`;

  assert.ok(gateSpec(source, { reportedUntested: 0 }).violations.some((v) => v.code === "unreported-gap"));

  // Reported honestly, the same file is fine. The gap is not the problem.
  assert.equal(gateSpec(source, { reportedUntested: 1 }).ok, true);
});

test("a hand-rolled actionability check is refused, with the built-in named", () => {
  // The exact spec that failed six times on a working page: boundingBox gives
  // page coordinates, elementFromPoint takes viewport coordinates, and the
  // check runs once against a page that may still be settling.
  const source = `${HEAD}
test("controls stay clickable", async ({ page }) => {
  const box = await page.getByLabel("Email").boundingBox();
  const onTop = await page.getByLabel("Email").evaluate((el, b) => {
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return !!top && el.contains(top);
  }, box);
  expect(onTop, "nothing else may cover the control").toBe(true);
});`;

  const result = gateSpec(source);
  const violation = result.violations.find((v) => v.code === "reimplemented-actionability");

  assert.ok(violation, "the reimplementation must be caught before it runs");
  assert.match(violation!.detail, /elementFromPoint/);
  // The remedy has to name what to use instead, or the retry repeats the mistake.
  assert.match(violation!.remedy, /click\(\{ trial: true \}\)/);
});

test("other reimplementations of visibility are caught too", () => {
  const cases: Array<[string, RegExp]> = [
    ["const hidden = el.offsetParent === null; expect(hidden).toBe(false);", /offsetParent/],
    ['const s = getComputedStyle(el).visibility; expect(s).toBe("visible");', /computed-style/],
  ];

  for (const [line, expected] of cases) {
    const result = gateSpec(`${HEAD}test("x", async ({ page }) => { ${line} });`);
    const violation = result.violations.find((v) => v.code === "reimplemented-actionability");
    assert.ok(violation, `should catch: ${line}`);
    assert.match(violation!.detail, expected);
  }
});

test("using Playwright's own checks passes cleanly", () => {
  // The whole point: the correct spelling must not be caught by the rule that
  // exists to encourage it.
  const result = gateSpec(`${HEAD}
test("controls stay clickable at every viewport", async ({ page }) => {
  await page.goto("/login");
  const email = page.getByLabel("Email");
  await expect(email).toBeVisible();
  await expect(email).toBeEnabled();
  await email.click({ trial: true });
});`);

  assert.equal(result.ok, true);
});
