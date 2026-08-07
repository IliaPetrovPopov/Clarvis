import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRecon, bootCommandExists, profileIsRunnable } from "../src/agents/scout.ts";
import { surveyProject, extractHosts, isLiveEnvFile } from "../src/connectors/survey.ts";
import { Budget } from "../src/agents/budget.ts";
import { decideGuard } from "../src/guard.ts";
import type { AgentRunner } from "../src/agents/runtime.ts";
import type { Profile } from "../src/types.ts";

/**
 * A runner that answers each role with a canned envelope. Recon's guarantees are
 * all about what happens to a model's output AFTER it arrives, so the model
 * itself is the least interesting part to exercise.
 */
function scriptedRunner(byRole: Record<string, unknown>): AgentRunner {
  return {
    async invoke({ definition }) {
      const reply = byRole[definition.role];
      if (reply === undefined) throw new Error(`no scripted reply for ${definition.role}`);
      return {
        text: JSON.stringify(reply),
        model: definition.model,
        usage: { inputTokens: 10, outputTokens: 10 },
        usdReported: 0.001,
      };
    },
  };
}

const BOOT_OK = { cmd: "npm run dev", url: "http://localhost:3000", evidence: "package.json scripts.dev" };
const AUTH_NONE = { mode: "none", roles: [] };
const SAFETY_NONE = { forbiddenHosts: [] };

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-recon-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

const PKG = JSON.stringify({ name: "demo", scripts: { dev: "vite", build: "vite build" } });

/* ----------------------------------------------------------------- survey */

test("the survey reads manifests and setup docs, and skips a live .env", async () => {
  const root = await makeProject({
    "package.json": PKG,
    ".env.example": "API_URL=http://localhost:3000\n",
    ".env": "API_URL=http://prod.internal\nSECRET=hunter2\n",
    "README.md": "# Demo\nRun `npm run dev`.\n",
    "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad" }),
  });

  const survey = await surveyProject({ projectRoot: root });
  const paths = survey.files.map((f) => f.path);

  assert.ok(paths.includes("package.json"));
  assert.ok(paths.includes(".env.example"));
  assert.ok(paths.includes("README.md"));

  // A real .env holds live secrets and would be sent verbatim to a model.
  assert.equal(paths.includes(".env"), false);
  assert.equal(survey.files.some((f) => f.content.includes("hunter2")), false);
  assert.equal(paths.some((p) => p.includes("node_modules")), false);

  assert.deepEqual(Object.keys(survey.scripts).sort(), ["build", "dev"]);
});

test("isLiveEnvFile separates a template from the real thing", () => {
  assert.equal(isLiveEnvFile(".env"), true);
  assert.equal(isLiveEnvFile("services/api/.env.local"), true);
  assert.equal(isLiveEnvFile(".env.example"), false);
  assert.equal(isLiveEnvFile(".env.sample"), false);
  assert.equal(isLiveEnvFile("package.json"), false);
});

test("hosts are extracted from any shape a connection string takes", () => {
  const found = extractHosts(
    [
      "MONGO_URI=mongodb://admin:secret@203.0.113.10:27017/shared-db",
      "API=https://api.acme.io/v1",
      "LOCAL=http://localhost:8001",
      '"version": "1.2.3"',
    ].join("\n"),
    "compose.yml",
  );

  const hosts = found.map((h) => h.host);
  assert.ok(hosts.includes("203.0.113.10:27017"));
  assert.ok(hosts.includes("api.acme.io"));
  assert.ok(hosts.includes("localhost:8001"));

  // A semver string has the shape of an IPv4 address and is not one.
  assert.equal(hosts.some((h) => h.startsWith("1.2.3")), false);

  // The password must not be carried into the recorded line.
  const mongo = found.find((h) => h.host.startsWith("203.0.113"))!;
  assert.equal(mongo.line.includes("secret"), false);
  assert.match(mongo.ref, /^compose\.yml:1$/);
});

/* ------------------------------------------------------------ fail-closed */

test("recon never marks a target disposable, whatever the safety agent says", async () => {
  const root = await makeProject({ "package.json": PKG });

  const { profile, report } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": BOOT_OK,
      "scout-auth": AUTH_NONE,
      "scout-safety": {
        forbiddenHosts: [],
        disposableRecommendation: true,
        reasoning: "Everything is local and clearly a scratch environment.",
      },
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  // The single most consequential field in the product. An agent may recommend;
  // only a human may set it.
  assert.equal(profile.data.disposable, false);
  assert.ok(report.warnings.some((w) => /recommendation only/i.test(w)));

  // And the guard, reading that profile, refuses mutating axes.
  assert.equal(decideGuard(profile).mode, "read-only");
});

test("a human's existing disposable setting survives a re-recon", async () => {
  const root = await makeProject({ "package.json": PKG });
  const existing = {
    schemaVersion: 1,
    project: { name: "demo", root },
    boot: { url: "http://localhost:3000", verified: true },
    auth: { mode: "none", roles: [] },
    data: { disposable: true, safeTargets: ["localhost:3000"], confirmedBy: "reviewer" },
  } as Profile;

  const { profile } = await runRecon({
    projectRoot: root,
    existing,
    runner: scriptedRunner({
      "scout-boot": BOOT_OK,
      "scout-auth": AUTH_NONE,
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.equal(profile.data.disposable, true);
  assert.deepEqual(profile.data.safeTargets, ["localhost:3000"]);
  assert.equal(profile.data.confirmedBy, "reviewer");
  // Re-running recon must not silently re-assert that the app is up.
  assert.equal(profile.boot.verified, false);
});

test("remote hosts found in files are denied even when the safety agent found nothing", async () => {
  const root = await makeProject({
    "package.json": PKG,
    "docker-compose.yml": "services:\n  api:\n    environment:\n      MONGO_URI: mongodb://203.0.113.10:27017/shared\n",
  });

  const { profile, report } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": BOOT_OK,
      "scout-auth": AUTH_NONE,
      // The agent says nothing is dangerous. Code disagrees, and code wins.
      "scout-safety": { forbiddenHosts: [] },
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.ok(profile.data.forbiddenHosts?.includes("203.0.113.10"));
  assert.ok(report.hostsFromCode.includes("203.0.113.10"));
});

test("the deny-list is still written when the safety agent fails outright", async () => {
  const root = await makeProject({
    "package.json": PKG,
    ".env.example": "DB=postgres://db.acme.cloud:5432/app\n",
  });

  const { profile, report } = await runRecon({
    projectRoot: root,
    runner: {
      async invoke({ definition }) {
        if (definition.role === "scout-safety") throw new Error("upstream 529");
        const reply = definition.role === "scout-boot" ? BOOT_OK : AUTH_NONE;
        return {
          text: JSON.stringify(reply),
          model: definition.model,
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    },
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.ok(profile.data.forbiddenHosts?.includes("db.acme.cloud"));
  assert.ok(profile.data.forbiddenHosts?.includes("*prod*"));
  assert.ok(report.warnings.some((w) => /Safety analysis did not complete/.test(w)));
});

/* -------------------------------------------------------- credential check */

test("a fabricated credential is dropped, a real one is kept", async () => {
  const root = await makeProject({
    "package.json": PKG,
    "seed.md": "# Seeds\nAdmin login: `admin@demo.test` / `s33d-p4ssw0rd`\n",
  });

  const { profile, report } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": BOOT_OK,
      "scout-auth": {
        mode: "cookie-session",
        loginUrl: "/login",
        roles: [
          { key: "admin", username: "admin@demo.test", password: "s33d-p4ssw0rd", sourceFile: "seed.md" },
          // Plausible, well-formed, and nowhere in the repository.
          { key: "editor", username: "editor@demo.test", password: "Editor123!", sourceFile: "seed.md" },
        ],
      },
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.deepEqual(profile.auth.roles.map((r) => r.key), ["admin"]);
  assert.equal(report.rejectedCredentials.length, 1);
  assert.equal(report.rejectedCredentials[0].role, "editor");
  assert.ok(report.warnings.some((w) => /do not appear/.test(w)));
});

test("an unknown auth mode falls back to custom rather than being written through", async () => {
  const root = await makeProject({ "package.json": PKG });
  const { profile } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": BOOT_OK,
      "scout-auth": { mode: "saml-magic-link", roles: [] },
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });
  assert.equal(profile.auth.mode, "custom");
});

/* ------------------------------------------------------------------- boot */

test("a boot command naming a script that does not exist becomes a blocker", async () => {
  const root = await makeProject({ "package.json": PKG });

  const { profile, report } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": { cmd: "npm run start:dev", url: "http://localhost:3000" },
      "scout-auth": AUTH_NONE,
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.ok(report.blockers.some((b) => /start:dev/.test(b)));
  assert.equal(profileIsRunnable(profile).ok, false);
});

test("bootCommandExists checks scripts, and abstains on commands it cannot know", () => {
  const scripts = { dev: "vite", "test:e2e": "playwright test" };
  assert.equal(bootCommandExists("npm run dev", scripts), true);
  assert.equal(bootCommandExists("pnpm test:e2e", scripts), true);
  assert.equal(bootCommandExists("npm run nope", scripts), false);
  // Not a script invocation - bootAndVerify will find out for real.
  assert.equal(bootCommandExists("docker compose up", scripts), undefined);
  assert.equal(bootCommandExists("npm install", scripts), undefined);
});

test("a missing boot url is a blocker, not a silently empty profile", async () => {
  const root = await makeProject({ "package.json": PKG });

  const { profile, report } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": { blockers: ["No dev server is configured in this repository."] },
      "scout-auth": AUTH_NONE,
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.equal(profile.boot.url, "");
  assert.ok(report.blockers.some((b) => /No boot URL/.test(b)));
  assert.ok(report.blockers.some((b) => /No dev server/.test(b)));

  const runnable = profileIsRunnable(profile);
  assert.equal(runnable.ok, false);
  assert.ok(runnable.reasons.some((r) => /boot\.url is empty/.test(r)));
});

test("a boot url that is itself on the deny-list is refused as unrunnable", () => {
  const profile = {
    schemaVersion: 1,
    project: { name: "x", root: "/tmp/x" },
    boot: { url: "http://prod.acme.io", verified: false },
    auth: { mode: "none", roles: [] },
    data: { disposable: false, safeTargets: [], forbiddenHosts: ["prod.acme.io"] },
  } as Profile;

  const runnable = profileIsRunnable(profile);
  assert.equal(runnable.ok, false);
  assert.ok(runnable.reasons.some((r) => /deny-list/.test(r)));
});

test("a bare host is normalised to a URL rather than dropped", async () => {
  const root = await makeProject({ "package.json": PKG });
  const { profile } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": { cmd: "npm run dev", url: "localhost:5173" },
      "scout-auth": AUTH_NONE,
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });
  assert.equal(profile.boot.url, "http://localhost:5173");
});

test("recon reports what it spent and which agents ran", async () => {
  const root = await makeProject({ "package.json": PKG });
  const { report } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": BOOT_OK,
      "scout-auth": AUTH_NONE,
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.equal(report.agentRuns.length, 3);
  assert.ok(report.usdEstimate > 0);
  assert.deepEqual(
    report.agentRuns.map((r) => r.role),
    ["scout-boot", "scout-auth", "scout-safety"],
  );
});

test("a note filed as a blocker does not stop a boot that was fully determined", async () => {
  const root = await makeProject({ "package.json": PKG });

  const { profile, report } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": {
        cmd: "npm run dev",
        url: "http://localhost:3000",
        // Agents use this field for observations however the prompt is worded.
        blockers: ["The .env.example references a shared analytics host."],
      },
      "scout-auth": AUTH_NONE,
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.deepEqual(report.blockers, []);
  assert.ok(report.warnings.some((w) => /Boot analyst noted/.test(w)));
  assert.equal(profileIsRunnable(profile).ok, true);
});

test("the same note IS a blocker when the boot proposal is incomplete", async () => {
  const root = await makeProject({ "package.json": PKG });

  const { report } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": { blockers: ["No dev server is configured."] },
      "scout-auth": AUTH_NONE,
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.ok(report.blockers.some((b) => /No dev server/.test(b)));
});

test("an em-dash written by an agent never reaches the profile", async () => {
  const root = await makeProject({ "package.json": PKG });

  const { profile } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": BOOT_OK,
      "scout-auth": { mode: "none", roles: [], notes: "Vite dev server — no auth at all." },
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.equal(profile.auth.notes, "Vite dev server - no auth at all.");
});

test("a readyCheck written as prose is refused, and a path is resolved against the url", async () => {
  const root = await makeProject({ "package.json": PKG });

  const prose = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      // bootAndVerify fetches this string verbatim.
      "scout-boot": { ...BOOT_OK, readyCheck: "GET /health -> 200" },
      "scout-auth": AUTH_NONE,
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });
  assert.equal(prose.profile.boot.readyCheck, undefined);
  assert.ok(prose.report.warnings.some((w) => /readyCheck/.test(w)));

  const relative = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": { ...BOOT_OK, readyCheck: "/health" },
      "scout-auth": AUTH_NONE,
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });
  assert.equal(relative.profile.boot.readyCheck, "http://localhost:3000/health");
});

test("a role with no key is named from something meaningful, not its position", async () => {
  const root = await makeProject({
    "package.json": PKG,
    "seed.md": "admin: `ada@demo.test` / `demo-admin-pass`\n",
  });

  const { profile } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": BOOT_OK,
      "scout-auth": {
        mode: "cookie-session",
        roles: [{ username: "ada@demo.test", password: "demo-admin-pass", label: "Site Admin" }],
      },
      "scout-safety": SAFETY_NONE,
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.deepEqual(profile.auth.roles.map((r) => r.key), ["site-admin"]);
});

test("fields that arrive with the wrong type are ignored, not crashed on", async () => {
  const root = await makeProject({ "package.json": PKG });

  // A live run returned readyCheck as an object and threw on .trim(), losing
  // the entire recon. A declared type in model-authored JSON is a hope.
  const { profile, report } = await runRecon({
    projectRoot: root,
    runner: scriptedRunner({
      "scout-boot": {
        cmd: "npm run dev",
        url: "http://localhost:3000",
        readyCheck: { url: "/health", expect: 200 },
        cwd: 42,
        blockers: [null, "", { note: "nope" }],
      },
      "scout-auth": {
        mode: "cookie-session",
        loginUrl: ["/login"],
        apiLogin: "POST /api/login",
        notes: { text: "hi" },
        roles: [{ key: 7, username: null, password: undefined }],
      },
      "scout-safety": { forbiddenHosts: [null, 12, "  ", "shared.example"] },
    }),
    budget: new Budget({ maxUsd: 1 }),
  });

  assert.equal(profile.boot.readyCheck, undefined);
  assert.equal(profile.boot.cwd, undefined);
  assert.equal(profile.auth.loginUrl, undefined);
  assert.equal(profile.auth.apiLogin, undefined);
  assert.equal(profile.auth.notes, undefined);
  assert.deepEqual(profile.auth.roles, []);
  assert.ok(profile.data.forbiddenHosts?.includes("shared.example"));
  assert.equal(profile.data.forbiddenHosts?.some((h) => !h.trim()), false);
  assert.equal(report.blockers.length, 0);
});
