// Must come first: it points the store at a temp directory before any
// module under test resolves a path from it.
import "./isolate.ts";
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

test("the routes the specs will visit are warmed, and nothing else", async () => {
  /*
    Two constraints that pull against each other, and both have cost a run.

    Warming only the base URL was the first failure: `/login` is where every
    spec navigates, and it compiled on its own first request, so the assertions
    raced a compiler exactly as before.

    Warming the whole mapped surface was the second. Harmless while nothing
    persisted the map and the list was two entries long; once it was saved, the
    same line walked all forty-seven routes of a real application serially, and
    a run sat in warm-up for twenty-three minutes. Warming is not a crawl - the
    caller knows which routes are about to be asserted against, and those are
    the only ones that need it.
  */
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
    assert.ok(asked.some((u) => u.endsWith("/pricing")), "routes the caller named must be warmed");
    assert.ok(asked.some((u) => u.endsWith("3100/")), "the base URL must be warmed");
    assert.ok(
      !asked.some((u) => u.endsWith("/signup")),
      "the mapped surface must NOT be walked - that is a crawl, and it hung a run for 23 minutes",
    );
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

test("warming is bounded and concurrent", async () => {
  // Serial visits make the wait the sum of the slowest case rather than close
  // to it, and an unbounded list makes it unbounded. Both are how the
  // twenty-three minute hang happened.
  const { warmRoutes } = await import("../src/boot.ts");

  let inFlight = 0;
  let peak = 0;
  const asked: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL) => {
    asked.push(String(url));
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 12));
    inFlight--;
    return new Response(
      "<html><body><h1>Welcome</h1><form><input name='e'><button>Go</button></form></body></html>",
    );
  }) as typeof fetch;

  try {
    const many = Array.from({ length: 40 }, (_, i) => `/r${i}`);
    await warmRoutes(
      {
        schemaVersion: 1,
        project: { name: "p", root: "/tmp/p" },
        boot: { url: "http://localhost:3100", verified: true },
        auth: { mode: "none", roles: [] },
        data: { disposable: false, safeTargets: [] },
      } as never,
      many,
      { maxRoutes: 8 },
    );

    assert.ok(asked.length <= 8, `warmed ${asked.length} routes, expected the cap to hold`);
    assert.ok(peak > 1, "routes must be warmed concurrently, not one at a time");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
