import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listRunIds, newRunId, readRun, writeRun, clarvisPaths } from "../src/store.ts";
import type { Run } from "../src/types.ts";

const run = (runId: string): Run => ({
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  status: "passed",
  guard: { mode: "read-only", target: "localhost:3000" },
  axes: [],
  findings: [],
});

test("a run in progress does not break the list of finished ones", async () => {
  // The directory is created at the start and run.json only lands at the end.
  // Listing the empty one made the dashboard request a run that 404s, and the
  // failure took the whole list with it.
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-store-"));
  await writeRun(root, run("20260805T1000-aaaaaa"));
  await writeRun(root, run("20260805T1100-bbbbbb"));
  await mkdir(path.join(clarvisPaths(root).runs, "20260805T1200-inprog"), { recursive: true });

  assert.deepEqual(await listRunIds(root), ["20260805T1000-aaaaaa", "20260805T1100-bbbbbb"]);

  // And "latest" is the newest FINISHED run, not the one still going.
  assert.equal((await readRun(root, "latest")).runId, "20260805T1100-bbbbbb");
});

test("an unreadable run directory is skipped, not fatal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-store-"));
  await writeRun(root, run("20260805T1000-aaaaaa"));
  const bad = path.join(clarvisPaths(root).runs, "20260805T1300-broken");
  await mkdir(bad, { recursive: true });
  await writeFile(path.join(bad, "notes.txt"), "not a run", "utf8");

  assert.deepEqual(await listRunIds(root), ["20260805T1000-aaaaaa"]);
});

test("run ids sort chronologically as plain strings", () => {
  // "latest" is the last entry of a plain sort, so the format has to make that
  // true rather than needing a date parse.
  const a = newRunId(new Date("2026-08-05T09:00:00Z"));
  const b = newRunId(new Date("2026-08-05T11:00:00Z"));
  const c = newRunId(new Date("2026-08-06T01:00:00Z"));
  assert.deepEqual([c, a, b].sort(), [a, b, c]);
});

test("no runs at all is an empty list, not a throw", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-store-"));
  assert.deepEqual(await listRunIds(root), []);
  await assert.rejects(() => readRun(root, "latest"), /No runs found/);
});

test("the boot blocker names the directory that actually exists", async () => {
  // It said ".qa/profile.json" for a while after the rename - a path nobody
  // could act on, in the message whose only job is telling someone what to do.
  const { bootAndVerify } = await import("../src/boot.ts");
  const boot = await bootAndVerify({
    schemaVersion: 1,
    project: { name: "x", root: "/tmp" },
    boot: { url: "http://localhost:59999", verified: false },
    auth: { mode: "none", roles: [] },
    data: { disposable: false, safeTargets: [] },
  });

  assert.equal(boot.verified, false);
  assert.ok(boot.blockers.some((b) => b.includes(".clarvis/profile.json")));
  assert.equal(boot.blockers.some((b) => b.includes(".qa/")), false);
});

test("a loading shell is not a rendered application", async () => {
  // A dev server answers 200 the moment it listens, then compiles the route on
  // first request. Nine findings from the first real run were all false because
  // every spec asserted against the shell it served meanwhile.
  const { looksRendered } = await import("../src/boot.ts");

  assert.equal(looksRendered("<html><body><div>Loading</div></body></html>"), false);
  assert.equal(looksRendered("<html><body>loading...</body></html>"), false);
  assert.equal(looksRendered("<html><body></body></html>"), false);

  // Scripts do not count as content: a shell is mostly script.
  assert.equal(
    looksRendered('<html><body><div id="root"></div><script>lots and lots of javascript here</script></body></html>'),
    false,
  );

  // A real page carries substantially more than a shell does. This is the
  // actual login markup, trimmed.
  assert.equal(
    looksRendered(
      "<html><body><h1>Welcome Back</h1><p>Sign in to continue to Lumira</p>" +
        "<form><label>Email</label><input name='email'><label>Password</label>" +
        "<input name='password'><button>Login</button></form>" +
        "<p>Don't have an account? Sign up</p></body></html>",
    ),
    true,
  );
});

test("every route the specs will visit is warmed, not just the base URL", async () => {
  // Two runs failed the same way: the base URL was warm and `/login` - which is
  // where every spec actually navigates - compiled on its own first request,
  // so the assertions raced a compiler exactly as before.
  const { warmRoutes } = await import("../src/boot.ts");

  const asked: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    asked.push(String(url));
    return new Response(
      "<html><body><h1>Welcome Back</h1><p>Sign in to continue to the app</p>" +
        "<form><input name='email'><button>Login</button></form></body></html>",
    );
  }) as typeof fetch;

  try {
    const result = await warmRoutes(
      {
        schemaVersion: 1,
        project: { name: "p", root: "/tmp/p" },
        boot: { url: "http://localhost:3100", verified: true },
        auth: { mode: "cookie-jwt", loginUrl: "/login", roles: [] },
        data: { disposable: false, safeTargets: [] },
        surface: { routes: [{ path: "/signup" }] },
      },
      ["/pricing"],
    );

    assert.ok(asked.some((u) => u.endsWith("/login")), "the login route must be warmed");
    assert.ok(asked.some((u) => u.endsWith("/signup")), "mapped routes must be warmed");
    assert.ok(asked.some((u) => u.endsWith("/pricing")), "planned routes must be warmed");
    assert.deepEqual(result.cold, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a shell whose only text is its title is not a rendered page", async () => {
  // The tag stripper counted head content as body text, so a 51-character
  // <title> cleared the length threshold and a marketing shell read as fully
  // rendered - defeating the entire purpose of the check.
  const { looksRendered } = await import("../src/boot.ts");

  assert.equal(
    looksRendered(
      "<html><head><title>Lumira - Find and Book Professional Photographers</title></head>" +
        '<body><div id="root"></div></body></html>',
    ),
    false,
  );
});

test("interactive controls are what make a page testable", async () => {
  // A spec drives controls. Prose without them is not something a test can work
  // against, and a marketing shell is exactly that.
  const { looksRendered } = await import("../src/boot.ts");

  assert.equal(
    looksRendered("<html><body><form><input name='email'><button>Login</button></form></body></html>"),
    true,
  );

  // Long static prose is legitimate, and counts on length alone.
  assert.equal(looksRendered(`<html><body><article>${"word ".repeat(60)}</article></body></html>`), true);

  // Short prose with no controls is a shell.
  assert.equal(looksRendered("<html><body><p>Almost nothing here at all today</p></body></html>"), false);
});

test("a page built in the browser is called client-rendered, not unknown", async () => {
  // `fetch` runs no JavaScript, so an SPA can never satisfy a fetch-based
  // check. Calling that "unknown" would block every SPA from being tested.
  const { measureRendering } = await import("../src/boot.ts");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('<html><head><title>App</title></head><body><div id="root"></div></body></html>')) as typeof fetch;

  try {
    const result = await measureRendering("http://localhost:1/");
    assert.equal(result.rendering, "client-rendered");
    assert.match(result.note, /response body proves nothing/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a server-rendered page is recognised immediately", async () => {
  const { measureRendering } = await import("../src/boot.ts");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      "<html><body><h1>Welcome</h1><form><input name='email'><button>Go</button></form></body></html>",
    )) as typeof fetch;

  try {
    const result = await measureRendering("http://localhost:1/");
    assert.equal(result.rendering, "server-rendered");
    assert.equal(result.hydrationMs, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a readyCheck on a different origin is ignored, not obeyed", async () => {
  // An earlier recon left readyCheck on port 3000 while boot.url was corrected
  // to 3100. Both servers were up, so nothing failed loudly - boot verified one
  // application and every spec drove another.
  const { bootAndVerify } = await import("../src/boot.ts");

  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const logged: string[] = [];
  try {
    await bootAndVerify(
      {
        schemaVersion: 1,
        project: { name: "p", root: "/tmp/p" },
        boot: { url: "http://localhost:3100", readyCheck: "http://localhost:3000", verified: false },
        auth: { mode: "none", roles: [] },
        data: { disposable: false, safeTargets: [] },
      },
      { log: (l) => logged.push(l) },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(seen.every((u) => u.includes("3100")), "only the real target may be probed");
  assert.ok(logged.some((l) => /different origin/.test(l)), "the mismatch must be reported, not silent");
});

test("a readyCheck on the same origin is honoured", async () => {
  const { bootAndVerify } = await import("../src/boot.ts");

  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    await bootAndVerify({
      schemaVersion: 1,
      project: { name: "p", root: "/tmp/p" },
      boot: { url: "http://localhost:3100", readyCheck: "http://localhost:3100/health", verified: false },
      auth: { mode: "none", roles: [] },
      data: { disposable: false, safeTargets: [] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(seen[0].endsWith("/health"), "a cheaper endpoint on the same app is the point of it");
});
