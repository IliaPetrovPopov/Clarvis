import { spawn, type ChildProcess } from "node:child_process";
import { CLARVIS_DIR } from "./store.ts";
import type { Profile } from "./types.ts";

export interface BootResult {
  verified: boolean;
  durationMs: number;
  blockers: string[];
  /** Kills the process this boot started, if any. No-op when the app was already up. */
  stop: () => Promise<void>;
}

/**
 * Does this response look like an application, or like a shell waiting for JS?
 *
 * A development server answers 200 the moment it is listening and then compiles
 * the route on first request. Next.js served a "Loading" shell for five seconds
 * while doing so - which is a perfectly good 200, and completely useless to a
 * test. Every spec in the first real run asserted against that shell and timed
 * out, producing nine findings that were all false.
 *
 * So readiness is two questions, not one: is something listening, and has it
 * actually rendered anything.
 */
export function looksRendered(html: string): boolean {
  // The head is not content. Counting it made a shell whose only text was the
  // <title> - 51 characters, over the length threshold - read as a fully
  // rendered page, and the whole point of this check is to tell those apart.
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const body = bodyMatch?.[1] ?? html.replace(/<head[\s\S]*?<\/head>/i, "");

  const stripped = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const text = stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  // Interactive elements are the real signal. A test drives controls, so a page
  // with prose but no controls is not a page a spec can work against - and a
  // marketing shell is exactly that.
  const controls = (stripped.match(/<(button|input|select|textarea|a\s[^>]*href)/gi) ?? []).length;

  if (controls >= 2) return true;
  if (!text || text.length < 40) return false;
  if (/^(loading|please wait)\b/i.test(text) && text.length < 120) return false;

  // Text but no controls: a static page can legitimately look like this, so it
  // counts only when there is a substantial amount of it.
  return text.length >= 200;
}

async function probe(url: string, timeoutMs = 4000): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "manual" });
    // Anything that answers is "up" - a 401 from a protected root still proves
    // the server is listening, which is all boot verification claims.
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Boot the target app and prove it answers.
 *
 * This is the single highest-frequency failure in the whole product: pointing a
 * tester at a project that will not start. So it never guesses. Either the URL
 * responds - `verified: true` - or we return concrete blockers for a human,
 * and the caller refuses to run tests against an app that may not be there.
 */
/**
 * Fetch a URL until it renders, not merely until it answers.
 *
 * The first request to a dev-mode route pays for its compilation, so this is
 * also a warm-up: by the time it returns, the route is built and the next
 * request is fast. Running specs without it means every first assertion races
 * a compiler.
 */
export async function warmUp(
  url: string,
  opts: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<{ rendered: boolean; ms: number; note?: string }> {
  const started = Date.now();
  const deadline = started + (opts.timeoutMs ?? 60_000);
  const log = opts.log ?? (() => {});

  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      lastStatus = res.status;
      const html = await res.text();

      if (looksRendered(html)) {
        const ms = Date.now() - started;
        log(`rendered in ${Math.round(ms / 1000)}s`);
        return { rendered: true, ms };
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return {
    rendered: false,
    ms: Date.now() - started,
    // Stated rather than silently continuing: specs that run against a shell
    // produce failures that look like findings and are not.
    note:
      `${url} answered ${lastStatus || "nothing"} but never rendered content within ` +
      `${Math.round((opts.timeoutMs ?? 60_000) / 1000)}s. Specs run now would assert against a loading ` +
      `shell, and every failure would be false.`,
  };
}

export async function bootAndVerify(
  profile: Profile,
  opts: { log?: (line: string) => void } = {},
): Promise<BootResult> {
  const startedAt = Date.now();
  const log = opts.log ?? (() => {});
  /**
   * A readyCheck on a different origin from boot.url is always a mistake.
   *
   * It happened here: an earlier recon left `readyCheck` pointing at port 3000
   * while `boot.url` was corrected to 3100. Boot verified one server and every
   * spec drove another - both were running, so nothing failed loudly, and the
   * run tested a different application than the one it claimed to.
   *
   * The check is meant to be a cheaper endpoint on the SAME app, so a different
   * host or port means the profile is inconsistent and the url wins.
   */
  const readyUrl = (() => {
    const configured = profile.boot.readyCheck;
    if (!configured) return profile.boot.url;

    try {
      const check = new URL(configured);
      const target = new URL(profile.boot.url);
      if (check.host !== target.host) {
        log(
          `ignoring readyCheck ${configured}: it is a different origin from boot.url ` +
            `(${target.origin}). Verifying one server while driving another would test the wrong app.`,
        );
        return profile.boot.url;
      }
      return configured;
    } catch {
      return profile.boot.url;
    }
  })();
  const timeoutMs = profile.boot.readyTimeoutMs ?? 120_000;
  const blockers: string[] = [];

  if (await probe(readyUrl)) {
    log(`already up at ${readyUrl}`);
    return { verified: true, durationMs: Date.now() - startedAt, blockers: [], stop: async () => {} };
  }

  if (!profile.boot.cmd) {
    return {
      verified: false,
      durationMs: Date.now() - startedAt,
      blockers: [
        `Nothing is listening at ${readyUrl} and the profile has no boot.cmd.`,
        `Start the app yourself, or set boot.cmd in ${CLARVIS_DIR}/profile.json.`,
      ],
      stop: async () => {},
    };
  }

  log(`booting: ${profile.boot.cmd}`);
  let child: ChildProcess;
  try {
    child = spawn(profile.boot.cmd, {
      shell: true,
      cwd: profile.boot.cwd ?? profile.project.root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      // Merged over the inherited environment, so a second instance can be
      // told which port to take without editing the boot command.
      env: { ...process.env, ...profile.boot.env },
    });
  } catch (e) {
    return {
      verified: false,
      durationMs: Date.now() - startedAt,
      blockers: [`Could not spawn boot.cmd: ${e instanceof Error ? e.message : String(e)}`],
      stop: async () => {},
    };
  }

  const tail: string[] = [];
  const capture = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 40) tail.shift();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? 0;
  });

  const stop = async () => {
    if (child.exitCode == null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode == null) child.kill("SIGKILL");
    }
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(readyUrl)) {
      log(`up at ${readyUrl} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
      return { verified: true, durationMs: Date.now() - startedAt, blockers: [], stop };
    }
    // A boot command that exits non-zero will never come up. Fail immediately
    // rather than burning the full timeout.
    if (exited !== null && exited !== 0) {
      blockers.push(`boot.cmd exited with code ${exited} before ${readyUrl} answered.`);
      // Fifteen lines rather than five: a stack trace pushes the actual error
      // off the end, and the error is the only part worth having.
      if (tail.length) blockers.push(...tail.slice(-15).map((l) => l.trim()).filter(Boolean));
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!blockers.length) {
    blockers.push(
      `${readyUrl} did not answer within ${Math.round(timeoutMs / 1000)}s of running boot.cmd.`,
    );
    if (tail.length) blockers.push(...tail.slice(-15).map((l) => l.trim()).filter(Boolean));
  }

  await stop();
  return { verified: false, durationMs: Date.now() - startedAt, blockers, stop: async () => {} };
}

/**
 * Warm every route a run will actually touch.
 *
 * Warming only the base URL is not enough, and the first two runs proved it
 * twice: the specs navigate to `/login`, which in a dev server compiles on ITS
 * first request, so the assertions raced a compiler exactly as before. The base
 * URL was warm and the page under test was not.
 *
 * Routes come from the profile's mapped surface and its login URL - everything
 * known to be reachable. A route that fails to render is reported rather than
 * fatal: it may simply require auth, and the axes that need it will say so.
 */
export async function warmRoutes(
  profile: Profile,
  extraRoutes: string[] = [],
  opts: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<{ warmed: string[]; cold: Array<{ route: string; note: string }> }> {
  const log = opts.log ?? (() => {});
  const base = profile.boot.url.replace(/\/$/, "");

  const routes = [
    ...new Set(
      [
        "/",
        profile.auth.loginUrl ?? "",
        ...(profile.surface?.routes ?? []).map((r) => r.path),
        ...extraRoutes,
      ]
        .map((r) => (r ?? "").trim())
        .filter((r) => r.startsWith("/")),
    ),
  ];

  const warmed: string[] = [];
  const cold: Array<{ route: string; note: string }> = [];

  for (const route of routes) {
    const result = await warmUp(`${base}${route}`, {
      timeoutMs: opts.timeoutMs ?? 45_000,
      log: (l) => log(`${route} ${l}`),
    });
    if (result.rendered) warmed.push(route);
    else cold.push({ route, note: result.note ?? "did not render" });
  }

  return { warmed, cold };
}

/**
 * How long this application takes to put content on the page.
 *
 * Distinguishes a server-rendered app, where the first response is the page,
 * from a client-rendered one, where it is a shell. That difference decides how
 * long an assertion must be willing to wait, and getting it wrong is what
 * turned a working login page into thirteen false findings.
 *
 * Deliberately measured rather than inferred from a framework name: a Next.js
 * app may be either, and often is both on different routes.
 */
export async function measureRendering(url: string): Promise<{
  rendering: "server-rendered" | "client-rendered" | "unknown";
  hydrationMs?: number;
  note: string;
}> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const html = await res.text();

    if (looksRendered(html)) {
      return {
        rendering: "server-rendered",
        hydrationMs: 0,
        note: "The first response already contains the page.",
      };
    }

    // A shell, and `fetch` runs no JavaScript - so the content either does not
    // exist or exists only in a browser. Both mean the same thing to a spec:
    // nothing may be asserted against the response body, and every assertion
    // must be willing to wait. Distinguishing "client-rendered" from "broken"
    // needs a browser, which lives in the runner rather than here.
    return {
      rendering: "client-rendered",
      note:
        "The server returns a shell with no interactive content. The page is built in the browser, " +
        "so assertions must wait for it and the response body proves nothing.",
    };
  } catch (e) {
    return { rendering: "unknown", note: e instanceof Error ? e.message : String(e) };
  }
}
