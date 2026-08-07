import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gateSpec } from "../src/agents/specGate.ts";
import { fillTemplate } from "../src/session.ts";
import { discoverFileRoutes, discoverConfigRoutes, resolveRoutePath, paramsIn } from "../src/surface.ts";
import { checkDataTarget, discoverDataCommands, hostFromConnectionString } from "../src/fixtures.ts";
import type { AuthRole, Profile } from "../src/types.ts";

/**
 * The QA fleet's own tests.
 *
 * Weighted toward the branches where being wrong is expensive rather than
 * merely annoying: a data command pointed at a shared database, a spec that
 * logs itself in against an application that was already authenticated, a route
 * list that invents a page.
 */

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "clarvis-qa-"));
}

function profileWith(overrides: Partial<Profile> = {}): Profile {
  return {
    schemaVersion: 1,
    project: { name: "t", root: "/tmp/nope" },
    boot: { url: "http://localhost:3000", verified: true },
    auth: { mode: "none", roles: [] },
    data: { disposable: false, safeTargets: [] },
    ...overrides,
  } as Profile;
}

/* ------------------------------------------------------------ data safety */

test("a connection string's host is read whatever its scheme", () => {
  const cases: Array<[string, string | undefined]> = [
    ["postgres://user:pw@localhost:5432/db", "localhost"],
    ["mongodb://root:p%40ss@69.62.116.115:27017/examate", "69.62.116.115"],
    ["mongodb+srv://u:p@cluster0.abcde.mongodb.net/db", "cluster0.abcde.mongodb.net"],
    ["redis://127.0.0.1:6379", "127.0.0.1"],
    ["localhost", "localhost"],
    ["db.internal:5432", "db.internal"],
    ["", undefined],
  ];

  for (const [input, expected] of cases) {
    assert.equal(hostFromConnectionString(input), expected, input);
  }
});

test("a database on another machine is refused even when the app is local", async () => {
  const dir = await scratch();
  try {
    // The exact arrangement that makes the HTTP guard insufficient: the app is
    // on localhost and passes every existing check, while its database is a
    // shared remote server the guard has never seen.
    await writeFile(
      path.join(dir, ".env"),
      "DATABASE_URL=postgres://user:pw@10.0.0.42:5432/shared\n",
      "utf8",
    );

    const check = await checkDataTarget(
      profileWith({ project: { name: "t", root: dir } }),
    );

    assert.equal(check.ok, false);
    assert.match(check.reason, /not this machine/);
    assert.equal(check.host, "10.0.0.42");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a forbidden host in a connection string is refused by name", async () => {
  const dir = await scratch();
  try {
    await writeFile(path.join(dir, ".env"), "MONGO_URI=mongodb://prod.example.com:27017/live\n", "utf8");

    const check = await checkDataTarget(
      profileWith({
        project: { name: "t", root: dir },
        data: { disposable: true, safeTargets: ["*"], forbiddenHosts: ["prod.example.com"] },
      }),
    );

    assert.equal(check.ok, false);
    assert.match(check.reason, /forbidden host pattern/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no connection string at all is refused, not assumed local", async () => {
  const dir = await scratch();
  try {
    const check = await checkDataTarget(profileWith({ project: { name: "t", root: dir } }));
    assert.equal(check.ok, false);
    assert.match(check.reason, /Refusing rather than assuming/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every connection is checked, not only the first", async () => {
  const dir = await scratch();
  try {
    // A local Postgres beside a shared remote Mongo. Checking only the first
    // gives an answer that is confident and wrong.
    await writeFile(
      path.join(dir, ".env"),
      ["DATABASE_URL=postgres://localhost:5432/local", "MONGO_URI=mongodb://10.0.0.9:27017/shared"].join("\n"),
      "utf8",
    );

    const check = await checkDataTarget(profileWith({ project: { name: "t", root: dir } }));
    assert.equal(check.ok, false);
    assert.equal(check.host, "10.0.0.9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a seed script that drops first is classed destructive whatever it is called", async () => {
  const dir = await scratch();
  try {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          seed: "prisma migrate reset --force && node seed.js",
          "db:reset": "dropdb app && createdb app",
          "db:migrate": "prisma migrate deploy",
          build: "tsc",
        },
      }),
      "utf8",
    );

    const commands = await discoverDataCommands(dir);
    const byScript = Object.fromEntries(commands.map((c) => [c.script, c]));

    assert.equal(byScript.seed?.destructive, true, "a seed that resets first is destructive");
    assert.equal(byScript["db:reset"]?.destructive, true);
    assert.equal(byScript["db:migrate"]?.kind, "migrate");
    assert.equal(byScript.build, undefined, "an unrelated script is not a data command");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- spec gate */

const SPEC_HEAD = `import { test, expect } from "@playwright/test";\n`;

test("a hand-rolled login is rejected once a session exists", () => {
  const source = `${SPEC_HEAD}
test("admin sees the dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[type="password"]').fill("hunter2");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});`;

  const gated = gateSpec(source, { sessionsEstablished: true });
  assert.equal(gated.ok, false);
  assert.ok(gated.violations.some((v) => v.code === "hand-rolled-login"));
});

test("the same spec is allowed when no session could be established", () => {
  const source = `${SPEC_HEAD}
test("admin sees the dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[type="password"]').fill(process.env.PW ?? "");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});`;

  // Without a session there is nothing to reuse, and forbidding it would leave
  // the axis untestable rather than better tested.
  const gated = gateSpec(source, { sessionsEstablished: false });
  assert.ok(!gated.violations.some((v) => v.code === "hand-rolled-login"));
});

test("a password-change page is not mistaken for a login flow", () => {
  const source = `${SPEC_HEAD}
test("changing a password requires the current one", async ({ page }) => {
  await page.goto("/settings/security");
  await page.locator('input[name="newPassword"]').fill("a-new-one");
  await page.getByRole("button", { name: "Update" }).click();
  await expect(page.getByRole("alert")).toContainText("current password");
});`;

  const gated = gateSpec(source, { sessionsEstablished: true });
  assert.ok(
    !gated.violations.some((v) => v.code === "hand-rolled-login"),
    "a real password form is a thing to test, not a login flow",
  );
});

test("a credential written into a spec is rejected", () => {
  const source = `${SPEC_HEAD}
const password = "s3cret-value";
test("x", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading")).toBeVisible();
});`;

  const gated = gateSpec(source, { sessionsEstablished: true });
  assert.equal(gated.ok, false);
  assert.ok(gated.violations.some((v) => v.code === "hardcoded-credential"));
});

/* ------------------------------------------------------- route discovery */

test("routes come from the framework's own convention", async () => {
  const dir = await scratch();
  try {
    const app = path.join(dir, "app");
    await mkdir(path.join(app, "dashboard"), { recursive: true });
    await mkdir(path.join(app, "(marketing)", "pricing"), { recursive: true });
    await mkdir(path.join(app, "users", "[id]"), { recursive: true });
    await mkdir(path.join(app, "api", "health"), { recursive: true });

    await writeFile(path.join(app, "page.tsx"), "export default () => null;", "utf8");
    await writeFile(path.join(app, "dashboard", "page.tsx"), "export default () => null;", "utf8");
    await writeFile(path.join(app, "(marketing)", "pricing", "page.tsx"), "export default () => null;", "utf8");
    await writeFile(path.join(app, "users", "[id]", "page.tsx"), "export default () => null;", "utf8");
    // A route handler is not a page and must not appear as one.
    await writeFile(path.join(app, "api", "health", "route.ts"), "export const GET = () => null;", "utf8");

    const { routes, conventions } = await discoverFileRoutes(dir);
    const paths = routes.map((r) => r.path).sort();

    assert.deepEqual(paths, ["/", "/dashboard", "/pricing", "/users/[id]"]);
    assert.ok(conventions[0]?.startsWith("next-app-router"));

    const dynamic = routes.find((r) => r.path === "/users/[id]");
    assert.equal(dynamic?.dynamic, true, "a parameterised route cannot be visited as written");
    assert.equal(
      routes.find((r) => r.path === "/pricing")?.dynamic,
      false,
      "a route group is not a parameter",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a config-driven router is read only for literal paths", async () => {
  const dir = await scratch();
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "src", "routes.tsx"),
      [
        `<Route path="/" element={<Home />} />`,
        `<Route path="/settings" element={<Settings />} />`,
        "<Route path={dynamicPath} element={<X />} />",
        `<Route path="*" element={<NotFound />} />`,
      ].join("\n"),
      "utf8",
    );

    const routes = await discoverConfigRoutes(dir);
    const paths = routes.map((r) => r.path).sort();

    // A variable and a catch-all are both skipped: a route invented here sends
    // a spec somewhere that does not exist, and reports the 404 as a defect.
    assert.deepEqual(paths, ["/", "/settings"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- templates */

test("a credential is substituted wherever it appears in a body template", () => {
  const role: AuthRole = { key: "admin", username: "a@b.co", password: "pw" };

  const filled = fillTemplate(
    { user: { email: "{{username}}", password: "{{ password }}" }, scopes: ["read"] },
    role,
  );

  assert.deepEqual(filled, {
    user: { email: "a@b.co", password: "pw" },
    scopes: ["read"],
  });
});

test("a remote database in the project's .env is not masked by a local process env", async () => {
  const dir = await scratch();
  const before = process.env.DATABASE_URL;
  try {
    // The project's file names a shared server. A local shell variable of the
    // same name must not hide it: which one wins at runtime depends on the
    // project's own dotenv configuration, so both have to pass.
    await writeFile(path.join(dir, ".env"), "DATABASE_URL=postgres://10.0.0.7:5432/shared\n", "utf8");
    process.env.DATABASE_URL = "postgres://localhost:5432/local";

    const check = await checkDataTarget(profileWith({ project: { name: "t", root: dir } }));
    assert.equal(check.ok, false);
    assert.equal(check.host, "10.0.0.7");
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a known parameter is filled in; an unknown one is not", () => {
  // An internationalised application puts a locale in front of every route it
  // has. Treating that like a record id marks the entire surface unvisitable -
  // measured on a real application: 47 of 47 routes, nothing probed.
  const values = { locale: "en" };

  assert.deepEqual(resolveRoutePath("/[locale]/explore", values), {
    visitPath: "/en/explore",
    dynamic: false,
  });
  assert.deepEqual(resolveRoutePath("/[locale]/users/[id]", values), { dynamic: true });
  assert.deepEqual(resolveRoutePath("/settings", values), {
    visitPath: "/settings",
    dynamic: false,
  });
  assert.deepEqual(resolveRoutePath("/users/:id", values), { dynamic: true });
  assert.deepEqual(resolveRoutePath("/[locale]/blog/[...slug]", values), { dynamic: true });
});

test("parameter names are read from either notation", () => {
  assert.deepEqual(paramsIn("/[locale]/users/[id]"), ["locale", "id"]);
  assert.deepEqual(paramsIn("/users/:userId/posts/:postId"), ["userId", "postId"]);
  assert.deepEqual(paramsIn("/blog/[...slug]"), ["slug"]);
  assert.deepEqual(paramsIn("/static/path"), []);
});

test("the login form is waited for, not merely asked about", async () => {
  // `isVisible()` answers about the page as it is at that instant and never
  // waits, however generous a timeout it is passed. Against a client-rendered
  // application it is asked before the form exists, and a working login page is
  // reported as having no password field - which reads as a broken application.
  // Caught against a real one; this keeps it caught.
  const source = await readFile(new URL("../src/session.ts", import.meta.url), "utf8");

  const passwordWait = /password\s*\n?\s*\.waitFor\(\{ state: "visible"/.test(source);
  assert.ok(passwordWait, "the password field must be waited for with waitFor");

  assert.ok(
    !/\.isVisible\(\{\s*timeout/.test(source),
    "isVisible with a timeout looks like it waits and does not",
  );
});

test("a session that stored nothing is not treated as a session", async () => {
  // An empty jar behaves exactly like an anonymous run, so every spec using it
  // would meet the login wall and report it as a defect in the page.
  const source = await readFile(new URL("../src/session.ts", import.meta.url), "utf8");
  assert.match(source, /indistinguishable from an anonymous one/);
  assert.match(source, /!captured\.cookies && !captured\.origins/);
});
