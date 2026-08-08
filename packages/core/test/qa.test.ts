import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gateSpec } from "../src/agents/specGate.ts";
import { fillTemplate } from "../src/session.ts";
import { discoverFileRoutes, discoverConfigRoutes, resolveRoutePath, paramsIn } from "../src/surface.ts";
import { checkDataTarget, discoverDataCommands, hostFromConnectionString } from "../src/fixtures.ts";
import { decideGuard } from "../src/guard.ts";
import {
  SANDBOX_MARKER,
  databaseOf,
  engineOf,
  reclaimLeaked,
  sandboxName,
  withDatabase,
} from "../src/sandbox.ts";
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

/* ---------------------------------------------------------------- sandbox */

test("a sandbox name is never the project's own database", () => {
  const name = sandboxName("lumira", "20260807T1200-a32548");
  assert.notEqual(name, "lumira");
  assert.ok(name.includes(SANDBOX_MARKER), "the marker is what makes teardown safe");
  assert.match(name, /^lumira_/, "the original is kept so a human can tell what it belongs to");

  // A name with characters an engine would reject, and no name at all.
  assert.ok(!/[^A-Za-z0-9_]/.test(sandboxName("my-app.db", "r1")));
  assert.ok(sandboxName(undefined, "r1").includes(SANDBOX_MARKER));
});

test("the database in a connection string is swapped without losing its options", () => {
  assert.equal(
    withDatabase("mongodb://127.0.0.1:27017/lumira", "lumira_clarvis_sbx_1"),
    "mongodb://127.0.0.1:27017/lumira_clarvis_sbx_1",
  );
  // An authSource or an sslmode dropped here turns a working connection into a
  // failure that would be attributed to the sandbox.
  assert.equal(
    withDatabase("postgres://u:p@localhost:5432/app?sslmode=require", "app_sbx"),
    "postgres://u:p@localhost:5432/app_sbx?sslmode=require",
  );
  assert.equal(
    withDatabase("mongodb://root:pw@localhost:27017/db?authSource=admin", "db_sbx"),
    "mongodb://root:pw@localhost:27017/db_sbx?authSource=admin",
  );
  // No database named at all.
  assert.equal(withDatabase("mongodb://localhost:27017", "x"), "mongodb://localhost:27017/x");
});

test("the database name is read back out of a connection string", () => {
  assert.equal(databaseOf("mongodb://127.0.0.1:27017/lumira"), "lumira");
  assert.equal(databaseOf("postgres://u:p@h:5432/app?sslmode=require"), "app");
  assert.equal(databaseOf("mongodb://localhost:27017"), undefined);
});

test("the engine is read from the scheme", () => {
  assert.equal(engineOf("mongodb+srv://a/b"), "mongodb");
  assert.equal(engineOf("postgresql://a/b"), "postgres");
  assert.equal(engineOf("mysql://a/b"), "mysql");
  assert.equal(engineOf("redis://a"), undefined);
});

test("a leaked resource without the marker is never removed", async () => {
  const dir = await scratch();
  try {
    // A bug in name derivation must destroy nothing. The marker check is what
    // makes that true, so it is asserted rather than trusted.
    await writeFile(
      path.join(dir, "sandbox-journal.json"),
      JSON.stringify({ kind: "database", engine: "mongodb", name: "production", createdAt: "" }),
      "utf8",
    );

    const lines: string[] = [];
    const removed = await reclaimLeaked(dir, (l) => lines.push(l));

    assert.deepEqual(removed, [], "nothing without the marker may be removed");
    assert.match(lines.join(" "), /refusing to remove "production"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ guard path */

test("a provisioned sandbox makes a run mutating without any human flag", () => {
  // The flag made the mutating axes depend on setup nobody does, so they had
  // never run. Provenance answers the same question with better evidence.
  const profile = profileWith({ data: { disposable: false, safeTargets: [] } });

  assert.equal(decideGuard(profile).mode, "read-only", "no sandbox, no flag: read-only");

  const withSandbox = decideGuard(profile, undefined, {
    provisionedBy: "fresh-database",
    uri: "mongodb://127.0.0.1:27017/app_clarvis_sbx_1",
    evidence: "a database created for this run",
  });

  assert.equal(withSandbox.mode, "mutating");
  assert.match(withSandbox.reason, /dropped afterwards/);
});

test("a forbidden host still beats a sandbox", () => {
  const profile = profileWith({
    boot: { url: "http://prod.example.com", verified: true },
    data: { disposable: true, safeTargets: ["*"], forbiddenHosts: ["prod.example.com"] },
  });

  const decided = decideGuard(profile, undefined, {
    provisionedBy: "container",
    uri: "mongodb://127.0.0.1:27017/x_clarvis_sbx_1",
    evidence: "a container",
  });

  assert.equal(decided.mode, "aborted", "rule 1 is not weakened by rule 2");
});

test("a sandbox does not license writing to a remote service", () => {
  // A disposable database says nothing about a spec that can reach a real
  // service alongside it.
  const profile = profileWith({
    services: [{ key: "billing", url: "https://api.stripe.com" }],
  });

  const decided = decideGuard(profile, undefined, {
    provisionedBy: "fresh-database",
    uri: "mongodb://127.0.0.1:27017/x_clarvis_sbx_1",
    evidence: "a database created for this run",
  });

  assert.equal(decided.mode, "read-only");
  assert.match(decided.reason, /not on this machine/);
});

test("data commands run against the sandbox, not the project's own database", async () => {
  const dir = await scratch();
  try {
    // The project's file points somewhere that would normally be refused. The
    // override is what the command will actually see, so that is what is checked.
    await writeFile(path.join(dir, ".env"), "DATABASE_URL=postgres://10.0.0.5:5432/shared\n", "utf8");

    const profile = profileWith({ project: { name: "t", root: dir } });

    assert.equal((await checkDataTarget(profile)).ok, false, "without an override, refused");

    const overridden = await checkDataTarget(profile, {
      DATABASE_URL: "postgres://127.0.0.1:5432/shared_clarvis_sbx_1",
    });
    assert.equal(overridden.ok, true);
    assert.match(overridden.reason, /created for this run/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- enrolment */

test("an input with no type attribute is still an identity field", async () => {
  /*
    `type` defaults to text, but `[type="text"]` is an attribute selector and
    matches nothing when the attribute is absent. A plain
    `<input name="username">` therefore fell through every rule, and enrolment
    created a real account and then reported it could not log in - the field
    was found by one copy of the rules and missed by another.
  */
  const { IDENTITY_SELECTORS } = await import("../src/session.ts");
  assert.ok(
    IDENTITY_SELECTORS.includes("input:not([type])"),
    "a typeless input must be matchable",
  );
});

test("a created identity is disposable, unique, and obviously ours", async () => {
  const { generateIdentity } = await import("../src/enrol.ts");
  const profile = profileWith({ data: { disposable: true, safeTargets: [], fixturePrefix: "clarvis-" } });

  const a = generateIdentity(profile, 0.1);
  const b = generateIdentity(profile, 0.9);

  assert.match(a.username, /^clarvis-/, "the fixture prefix makes it sweepable");
  assert.match(a.username, /@example\.invalid$/, "a reserved domain that can never receive mail");
  assert.notEqual(a.username, b.username, "two runs must not collide on a surviving database");
  assert.ok(a.password.length >= 12, "short passwords are refused by real policies");
  assert.match(a.password, /[A-Z]/, "mixed case, for the same reason");
  assert.match(a.password, /[^A-Za-z0-9]/, "and a symbol");
});

test("creating an account is a write, so the guard decides", async () => {
  // Registering is not a read. Whatever the reason for wanting an account, a
  // project nobody vouched for does not get one made in it.
  const { enrolRole } = await import("../src/enrol.ts");

  const result = await enrolRole({
    profile: profileWith({ data: { disposable: false, safeTargets: [] } }),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /read-only/);
  assert.match(result.reason ?? "", /behind a login stays untested/);
});

test("being allowed to write somewhere is not a reason to write there", async () => {
  /*
    A project marked `disposable: true` used to skip provisioning entirely,
    because a sandbox was only attempted when the guard was about to refuse.
    So every account and record the fleet created went into somebody's real
    development database and stayed there.

    Consent to run mutating tests against seeded data is not consent to be left
    with permanent test accounts. This pins the ordering: a database of our own
    is the first choice, and a vouched-for one is the fallback.
  */
  const source = await readFile(new URL("../../cli/src/main.ts", import.meta.url), "utf8");

  assert.ok(
    /if \(wantsMutating && opts\.sandbox !== false\)/.test(source),
    "provisioning must not be conditional on the guard being about to refuse",
  );
  assert.ok(
    !/wantsMutating && preflight\.mode === "read-only"/.test(source),
    "the old condition skipped the sandbox for exactly the projects that had a real database",
  );
  assert.match(
    source,
    /WRITING TO A REAL DATABASE/,
    "falling back to a real database must be impossible to miss in the report",
  );
});

test("what a run creates is recorded by name, and where it went", async () => {
  // Residue nobody can name is residue nobody removes.
  const source = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
  assert.match(source, /fixtures\?: \{/);
  assert.match(source, /wroteTo: "sandbox" \| "real-database" \| "none"/);
});

test("an account is closed the way it was opened", async () => {
  // Through the application, not a DELETE against a table: the app knows what
  // deleting a user entails - sessions to invalidate, owned records to cascade.
  const source = await readFile(new URL("../src/enrol.ts", import.meta.url), "utf8");

  assert.match(source, /export async function withdrawRole/);
  // Proven by outcome. An account reported as removed and still present is
  // worse than one reported as left behind, because only the second is cleaned.
  assert.match(source, /const stillWorks = await canLogIn/);
});

/* ------------------------------------------------- shared infrastructure */

test("a remote connection string never yields a remote sandbox", async () => {
  /*
    The provisioning path had no host check at all: it created a database
    beside the project's own, on whatever server that string named. For a
    service architecture pointing at a shared remote database that meant
    creating one ON the shared server, then handing it back as a sandbox - at
    which point provenance granted mutating mode on the grounds that Clarvis
    had made it. Worse than no sandbox: the guard exists to keep writes off
    shared infrastructure, and that routed them there while reporting
    containment.

    Two things now prevent it. The rung that reads the project's connection
    string refuses a host that is not this machine, and the rung tried before
    it does not read that string at all - it starts a server of its own. So the
    remote host is never even contacted.

    Spawns a real mongod, so it is skipped when the binary is not already
    cached rather than downloading 76MB inside a unit suite.
  */
  const { existsSync } = await import("node:fs");
  const cached = existsSync(new URL("../../../node_modules/.cache/mongodb-memory-server", import.meta.url));
  if (!cached) {
    console.log("    (skipped: the mongod binary is not cached, and a unit suite must work offline)");
    return;
  }

  const { provisionSandbox } = await import("../src/sandbox.ts");
  const { decideGuard } = await import("../src/guard.ts");
  const dir = await scratch();
  let sandbox: Awaited<ReturnType<typeof provisionSandbox>>["sandbox"];

  try {
    await writeFile(
      path.join(dir, ".env"),
      "MONGO_URI=mongodb://user:pw@203.0.113.10:27017/app?authSource=admin\n",
      "utf8",
    );

    const profile = profileWith({
      project: { name: "svc", root: dir },
      // The worst case: a human has vouched for the target as well.
      data: { disposable: true, safeTargets: ["*"] },
    });

    const result = await provisionSandbox({ profile, runId: "t1", stateDir: dir });
    sandbox = result.sandbox;

    assert.ok(sandbox, `nothing was provisioned: ${JSON.stringify(result.attempts)}`);
    assert.match(
      sandbox!.uri,
      /127\.0\.0\.1|localhost/,
      "the sandbox must be on this machine whatever the project's own string says",
    );
    assert.ok(!sandbox!.uri.includes("203.0.113.10"), "the remote host must never appear in it");
    assert.equal(decideGuard(profile, undefined, sandbox).mode, "mutating");
  } finally {
    // In `finally`: a failed assertion above used to leave a mongod running,
    // which hung the whole suite rather than failing one test.
    await sandbox?.teardown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("connection strings are found in a service architecture, not just the root", async () => {
  /*
    Examate keeps its connection strings in services/<name>/.env. Reading only
    the root found none, and the check then refused for the wrong reason - "I
    could not find a database" rather than "that database is shared". The
    difference is not cosmetic: a root .env naming localhost while eight
    services pointed at a remote host would have read as safe.
  */
  const { checkDataTarget } = await import("../src/fixtures.ts");
  const dir = await scratch();

  try {
    await mkdir(path.join(dir, "services", "auth"), { recursive: true });
    await writeFile(path.join(dir, ".env"), "DATABASE_URL=postgres://localhost:5432/local\n", "utf8");
    await writeFile(
      path.join(dir, "services", "auth", ".env"),
      "MONGO_URI=mongodb://u:p@203.0.113.10:27017/shared?authSource=admin\n",
      "utf8",
    );

    const check = await checkDataTarget(profileWith({ project: { name: "svc", root: dir } }));

    assert.equal(check.ok, false, "a remote service database must be seen");
    assert.equal(check.host, "203.0.113.10", "and named, so the refusal is about the right thing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------ a database of our own */

test("the rung that needs nothing installed is tried first", async () => {
  /*
    Every other rung depends on something already being there: a running
    server, a Docker daemon, a compose file. On a machine with none of them -
    the common case - mutating axes never ran at all, so the entire
    authenticated half of every application went untested.

    Asserted on the source rather than by provisioning one: starting a real
    mongod takes a few hundred milliseconds and a 76MB binary on a fresh
    machine, which does not belong in a suite that runs in two seconds and must
    work offline. The smoke run provisions one for real.
  */
  const source = await readFile(new URL("../src/sandbox.ts", import.meta.url), "utf8");

  const inProcess = source.indexOf("rung 0: a server we start ourselves");
  const compose = source.indexOf("rung 1: the project's own compose definition");

  assert.ok(inProcess > 0, "an in-process rung must exist");
  assert.ok(inProcess < compose, "and be attempted before the rungs with prerequisites");
  assert.match(source, /provisionedBy: "in-process"/);
});

test("a seed script in a service is found, and run from its own directory", async () => {
  /*
    A service architecture puts its seed script in services/<name>/package.json
    - Examate's is exactly there - and reading only the root found none, so the
    project looked as though it had no way to make data. Worse than the env
    blind spot: a sandbox with no seed is an empty database, which tests less
    than no sandbox at all.
  */
  const { discoverDataCommands } = await import("../src/fixtures.ts");
  const dir = await scratch();

  try {
    await mkdir(path.join(dir, "services", "auth"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }), "utf8");
    await writeFile(
      path.join(dir, "services", "auth", "package.json"),
      JSON.stringify({ scripts: { seed: "node seedUsers.js" } }),
      "utf8",
    );

    const commands = await discoverDataCommands(dir);
    const seed = commands.find((c) => c.kind === "seed");

    assert.ok(seed, "a service's seed script must be found");
    assert.equal(
      seed!.cwd,
      path.join("services", "auth"),
      "and run from its own directory - it resolves its own dependencies and dist output",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
