import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveKeywords,
  extractTrackerKeys,
  isNoisePath,
  resolveScope,
  routesForPaths,
  slugify,
  tokenize,
} from "../src/scope.ts";
import { parseLog } from "../src/connectors/git.ts";
import type { Profile } from "../src/types.ts";

/* ------------------------------------------------------------- tokenizing */

test("tokenizes every casing convention a project might use", () => {
  assert.deepEqual(tokenize("organizationScoping"), ["organization", "scoping"]);
  assert.deepEqual(tokenize("OrganizationScoping"), ["organization", "scoping"]);
  assert.deepEqual(tokenize("organization-scoping"), ["organization", "scoping"]);
  assert.deepEqual(tokenize("organization_scoping"), ["organization", "scoping"]);
  // Single letters and bare digits are noise, not terms.
  assert.deepEqual(tokenize("a1.b2"), []);
});

test("noise paths are excluded regardless of platform separators", () => {
  assert.equal(isNoisePath("node_modules/react/index.js"), true);
  assert.equal(isNoisePath("services\\frontend\\dist\\app.js"), true);
  assert.equal(isNoisePath("pnpm-lock.yaml"), true);
  assert.equal(isNoisePath("app.min.js"), true);
  assert.equal(isNoisePath("services/frontend/src/OrgPicker.tsx"), false);
});

test("project-specific noise can be added without touching the defaults", () => {
  assert.equal(isNoisePath("generated/schema.ts"), false);
  assert.equal(isNoisePath("generated/schema.ts", { ignorePaths: ["generated/"] }), true);
});

/* -------------------------------------------------------------- keywords */

test("keywords come from the repo, and generic tokens are dropped", () => {
  const kws = deriveKeywords(
    [
      "services/user-service/controllers/organization.ts",
      "services/frontend/src/components/OrgClientPicker.tsx",
      "services/frontend/src/utils/api.ts",
    ],
    [],
  );
  assert.ok(kws.includes("organization"), "the distinguishing term must survive");
  // These appear in nearly every codebase and would match everything.
  for (const generic of ["utils", "api", "components", "src", "services"]) {
    assert.equal(kws.includes(generic), false, `"${generic}" is too generic to be a search term`);
  }
});

test("words a human typed in a commit outrank words from a path", () => {
  const kws = deriveKeywords(
    ["services/frontend/src/components/Widget.tsx"],
    ["feat(scoping): restrict clients by organization"],
  );
  assert.ok(kws.indexOf("scoping") < kws.indexOf("widget"), "commit subjects are stronger evidence");
});

test("conventional-commit prefixes are stripped before deriving meaning", () => {
  const kws = deriveKeywords([], ["fix(auth): proctor role leaks admin"]);
  assert.equal(kws.includes("fix"), false);
  assert.ok(kws.includes("proctor"));
});

/* -------------------------------------------------------- tracker + routes */

test("tracker keys are found by a configurable pattern", () => {
  assert.deepEqual(extractTrackerKeys(["fix EXM-412 and CLAR-9", "nothing here"]), ["CLAR-9", "EXM-412"]);
  // A project using a different convention configures it rather than forking us.
  assert.deepEqual(
    extractTrackerKeys(["see #4412"], { trackerKeyPattern: "#(\\d+)" }),
    ["4412"],
  );
});

test("routes come from the project profile, not from built-in knowledge", () => {
  const profile = {
    surface: {
      routes: [
        { path: "/users", source: "services/frontend/src/pages/UsersPage.tsx:12" },
        { path: "/exams", source: "services/frontend/src/pages/ExamsPage.tsx:8" },
      ],
    },
  } as unknown as Profile;

  assert.deepEqual(routesForPaths(["services/frontend/src/pages/UsersPage.tsx"], profile), ["/users"]);
  assert.deepEqual(routesForPaths(["something/unrelated.ts"], profile), []);
  // No profile means no guessing.
  assert.deepEqual(routesForPaths(["services/frontend/src/pages/UsersPage.tsx"]), []);
});

test("slugs are stable and bounded", () => {
  assert.equal(slugify("Org/Client Scoping + RBAC"), "org-client-scoping-rbac");
  assert.equal(slugify("!!!"), "feature");
});

/* -------------------------------------------------------------- resolver */

test("named mode works with no git at all", async () => {
  const scope = await resolveScope({
    name: "Org client scoping",
    keywords: ["organization"],
    paths: ["services/user-service/controllers/organization.ts"],
  });
  assert.equal(scope.origin, "named");
  assert.equal(scope.key, "org-client-scoping");
  assert.ok(scope.keywords.includes("organization"));
});

test("ticket mode is recognised when keys are supplied without a diff", async () => {
  const scope = await resolveScope({ name: "Scoping", trackerKeys: ["EXM-412"] });
  assert.equal(scope.origin, "ticket");
  assert.deepEqual(scope.trackerKeys, ["EXM-412"]);
});

test("diff mode derives scope from changed files and commit subjects", async () => {
  const fakeGit = {
    isRepo: async () => true,
    defaultBaseRef: async () => ({ ref: "origin/main", how: "origin/HEAD" }),
    changedFiles: async () => ({
      ok: true,
      status: "ok" as const,
      data: {
        files: [
          "services/user-service/controllers/organization.ts",
          "pnpm-lock.yaml",
          "services/frontend/src/pages/UsersPage.tsx",
        ],
      },
    }),
    commitsBetween: async () => [{ subject: "feat(scoping): restrict clients by organization EXM-412" }],
    uncommittedFiles: async () => [],
  };

  const profile = {
    surface: { routes: [{ path: "/users", source: "services/frontend/src/pages/UsersPage.tsx:12" }] },
  } as unknown as Profile;

  const scope = await resolveScope({}, { git: fakeGit as never, profile });

  assert.equal(scope.origin, "diff");
  assert.equal(scope.paths.includes("pnpm-lock.yaml"), false, "lockfiles must never shape a feature");
  assert.match(scope.truncation.join(" "), /generated or vendored/);
  assert.deepEqual(scope.trackerKeys, ["EXM-412"]);
  assert.deepEqual(scope.routes, ["/users"]);
  assert.ok(scope.keywords.includes("organization"));
  assert.match(scope.evidence.join(" "), /origin\/main/);
});

test("a huge diff is reported as low confidence rather than treated as one feature", async () => {
  const many = Array.from({ length: 200 }, (_, i) => `src/module${i}/thing.ts`);
  const fakeGit = {
    isRepo: async () => true,
    defaultBaseRef: async () => ({ ref: "main", how: "existing ref main" }),
    changedFiles: async () => ({ ok: true, status: "ok" as const, data: { files: many } }),
    commitsBetween: async () => [],
    uncommittedFiles: async () => [],
  };

  const scope = await resolveScope({}, { git: fakeGit as never });
  assert.equal(scope.confidence, "low");
  assert.match(scope.truncation.join(" "), /refactor or a merge/);
});

test("an undetectable base ref is recorded, not silently ignored", async () => {
  const fakeGit = {
    isRepo: async () => true,
    defaultBaseRef: async () => ({ how: "no base ref could be determined" }),
    changedFiles: async () => ({ ok: true, status: "empty" as const, data: { files: [] } }),
    commitsBetween: async () => [],
    uncommittedFiles: async () => [],
  };
  const scope = await resolveScope({}, { git: fakeGit as never });
  assert.match(scope.evidence.join(" "), /No base ref could be detected/);
  assert.equal(scope.confidence, "low");
});

test("uncommitted work can be scoped before anything is committed", async () => {
  const fakeGit = {
    isRepo: async () => true,
    defaultBaseRef: async () => ({ how: "none" }),
    changedFiles: async () => ({ ok: true, status: "empty" as const, data: { files: [] } }),
    commitsBetween: async () => [],
    uncommittedFiles: async () => ["services/frontend/src/OrgPicker.tsx"],
  };
  const scope = await resolveScope({ includeUncommitted: true }, { git: fakeGit as never });
  assert.equal(scope.origin, "uncommitted");
  assert.deepEqual(scope.paths, ["services/frontend/src/OrgPicker.tsx"]);
});

/* ------------------------------------------------------------ git parsing */

test("commit bodies containing newlines do not corrupt the parse", () => {
  // The shape here is what `git log --pretty=format:...%x01 --name-only`
  // actually emits, verified against real output: the file list follows the
  // %x01 separator, so it lands at the head of the NEXT record. This test
  // previously encoded files inside the date field, a format git never
  // produces, and passed while `files` was empty on every real commit.
  const SEP = "\x00";
  const record = [
    "abc123def",
    "abc123d",
    "fix(scope): restrict clients",
    "Multi-line body.\nSecond line of body.",
    "Ilia",
    "2026-08-05T10:00:00+02:00",
  ].join(SEP);

  const commits = parseLog(`${record}\x01\nservices/a.ts\nservices/b.ts\n`, SEP);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].subject, "fix(scope): restrict clients");
  assert.match(commits[0].body, /Second line of body/);
  assert.deepEqual(commits[0].files, ["services/a.ts", "services/b.ts"]);
  assert.equal(commits[0].date, "2026-08-05T10:00:00+02:00");
});

test("a named feature contributes its own words as keywords", async () => {
  // Without this, `--feature "proctor permissions"` searched for nothing at all.
  const scope = await resolveScope({ name: "proctor permissions and role scoping" });
  assert.ok(scope.keywords.includes("proctor"), "the feature name is human-typed intent");
  assert.ok(scope.keywords.includes("permissions"));
  assert.ok(scope.keywords.includes("scoping"));
  assert.equal(scope.keywords.includes("and"), false, "function words are still filtered");
});
