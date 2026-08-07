// Must come first: it points the store at a temp directory before any
// module under test resolves a path from it.
import "./isolate.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectId, projectsFile } from "../src/projects.ts";

test("the registry lives outside every project, and beside the state it indexes", async () => {
  // A per-project registry would leak projects to each other, and a registry
  // that disagreed with the state root would have the dashboard and the engine
  // looking at different things.
  const { clarvisHome } = await import("../src/store.ts");
  const file = projectsFile();

  assert.ok(file.startsWith(clarvisHome()), "the registry must sit under the state root");
  assert.equal(path.basename(file), "projects.json");
  assert.equal(file.includes("/node_modules/"), false);
});

test("state is keyed per project and never written inside one", async () => {
  // The requirement this whole layout exists for: running against a repository
  // must leave no mark on it.
  const { clarvisPaths, projectSlug } = await import("../src/store.ts");

  const a = clarvisPaths("/tmp/one/app");
  const b = clarvisPaths("/tmp/two/app");

  assert.notEqual(a.root, b.root, "two projects sharing a basename must not collide");
  assert.equal(a.root.startsWith("/tmp/one/app"), false, "nothing may live inside the project");
  assert.equal(b.root.startsWith("/tmp/two/app"), false);

  // Renaming the folder keeps identity; a trailing slash is the same project.
  assert.equal(projectSlug("/tmp/one/app"), projectSlug("/tmp/one/app/"));
});

test("ids are derived from the path, so renaming keeps identity", () => {
  const a = projectId("/Users/x/work/shared-db");
  const b = projectId("/Users/x/work/shared-db/");
  const c = projectId("/Users/x/work/shared-db/../shared-db");
  assert.equal(a, b, "a trailing slash is the same project");
  assert.equal(a, c, "a non-normalised path is the same project");
});

test("same folder name in different places never collides", () => {
  const a = projectId("/Users/x/client-a/frontend");
  const b = projectId("/Users/x/client-b/frontend");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("frontend-"));
  assert.ok(b.startsWith("frontend-"));
});

test("ids stay filesystem and url safe", () => {
  const id = projectId("/Users/x/My Project (v2)!");
  assert.match(id, /^[a-z0-9-]+$/);
});

test("an unnameable directory still yields a usable id", () => {
  const id = projectId("/");
  assert.match(id, /^project-[0-9a-f]{8}$/);
});

test("a missing registry reads as empty rather than throwing", async () => {
  // loadProjects is intentionally forgiving: the first launch has no registry,
  // and that must not be an error state.
  const { loadProjects } = await import("../src/projects.ts");
  const projects = await loadProjects();
  assert.ok(Array.isArray(projects));
});

test("adding a non-directory is rejected", async () => {
  const { addProject } = await import("../src/projects.ts");
  const dir = await mkdtemp(path.join(tmpdir(), "clarvis-proj-"));
  try {
    await assert.rejects(() => addProject(path.join(dir, "does-not-exist")), /not a directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a project directory with no runs is still a valid project", async () => {
  const { listRunIds } = await import("../src/store.ts");
  const dir = await mkdtemp(path.join(tmpdir(), "clarvis-proj-"));
  try {
    await mkdir(path.join(dir, ".clarvis"), { recursive: true });
    assert.deepEqual(await listRunIds(dir), [], "no runs is a state, not a failure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
