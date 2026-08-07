import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLEETS,
  FLEET_KEYS,
  addProject,
  clarvisPaths,
  describeProjects,
  listRunIds,
  readRun,
  resolveProject,
  type ProjectEntry,
} from "@clarvis/core";

/**
 * Project-level artifacts the dashboard may read.
 *
 * An allow-list rather than a path parameter: this serves a name that arrived
 * over the wire, and the store also holds transcripts, which contain retrieved
 * text from the project under test and are nobody's business but the operator's.
 */
const ARTIFACTS = new Set(["profile.json", "context.json", "plan.json", "ledger.json"]);

/** The same, for output written per run. */
const RUN_ARTIFACTS = new Set(["drafts.json", "verdict.json", "differential.json"]);

/**
 * Bumped whenever the API gains or changes an endpoint the UI depends on.
 *
 * The bundle records the number it was built against; a page whose number is
 * higher than the server's is talking to a process that predates it and says
 * so, rather than failing one fetch at a time.
 */
export const API_CONTRACT = 2;

const STARTED_AT = new Date().toISOString();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function uiDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../ui/dist");
}

/** Opens the default browser. Best-effort: a failure here must not kill the server. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

/** True when something is already listening, so a second launch reuses it. */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.get({ host: "127.0.0.1", port, path: "/api/projects", timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
    probe.on("timeout", () => {
      probe.destroy();
      resolve(false);
    });
  });
}

export async function serveUi(
  projectRoot: string,
  port: number,
  opts: { open?: boolean } = {},
): Promise<void> {
  // Double-launching from a desktop icon is the normal case, not an error.
  if (await isPortInUse(port)) {
    const url = `http://localhost:${port}`;
    console.log(`\n  clarvis ui   already running at ${url}`);
    if (opts.open) openBrowser(url);
    console.log("");
    return;
  }

  const dist = uiDistDir();
  let haveDist = true;
  try {
    await stat(path.join(dist, "index.html"));
  } catch {
    haveDist = false;
  }

  // The directory the server was launched against is always available, even if
  // it was never added to the registry - otherwise a fresh install shows nothing.
  await addProject(projectRoot).catch(() => undefined);

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": MIME[".json"] });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const parts = url.pathname.split("/").filter(Boolean);

      /* ------------------------------------------------------------ api */

      if (parts[0] === "api") {
        // GET /api/fleets - the team list, so the UI never hardcodes it.
        if (parts[1] === "fleets" && parts.length === 2) {
          return json(
            res,
            200,
            FLEET_KEYS.map((key) => ({
              key,
              codename: FLEETS[key].codename,
              title: FLEETS[key].title,
              purpose: FLEETS[key].purpose,
              mandatory: FLEETS[key].mandatory,
              requires: FLEETS[key].requires,
              writesExternally: FLEETS[key].writesExternally,
            })),
          );
        }

        /*
          GET /api/health - what this server is, so the page can tell.

          Node loads server code into memory at start and serves the frontend
          from disk on every request, so a long-lived `clarvis ui` ends up
          pairing a months-old API with a bundle built minutes ago. The
          mismatch shows up as a 404 on an endpoint the page is certain
          exists, which is a silent failure of exactly the kind everything
          else here is built to prevent - so the page is given the means to
          notice and say so.
        */
        if (parts[1] === "health" && parts.length === 2) {
          return json(res, 200, {
            api: API_CONTRACT,
            startedAt: STARTED_AT,
          });
        }

        // GET /api/projects
        if (parts[1] === "projects" && parts.length === 2) {
          return json(res, 200, await describeProjects());
        }

        // GET /api/projects/:id/runs  |  /api/projects/:id/run/:runId
        if (parts[1] === "projects" && parts.length >= 3) {
          const project: ProjectEntry | undefined = await resolveProject(decodeURIComponent(parts[2]));
          if (!project) return json(res, 404, { error: `Unknown project "${parts[2]}".` });

          if (parts[3] === "runs" && parts.length === 4) {
            return json(res, 200, await listRunIds(project.path));
          }

          /*
            GET /api/projects/:id/artifact/:name

            Everything a run produces that is not run.json. Four of the six
            teams wrote their output to a file nothing served, so SCRIBE's
            tickets and JUDGE's verdict - two whole fleets - could not be
            read anywhere but the terminal. The others hold what a reader needs
            to judge a result at all: the requirements a finding cites, the plan
            that says what was deliberately not tested, and the route map that
            says how much of the application was ever looked at.
          */
          if (parts[3] === "artifact" && parts[4]) {
            const name = decodeURIComponent(parts[4]);
            if (!ARTIFACTS.has(name)) {
              return json(res, 404, { error: `Not an artifact: "${name}".` });
            }
            const paths = clarvisPaths(project.path);
            try {
              const raw = await readFile(path.join(paths.root, name), "utf8");
              return json(res, 200, JSON.parse(raw));
            } catch {
              // Absent is a real state - a project that never ran research has
              // no context - so it is reported as such rather than as an error.
              return json(res, 404, { error: `No ${name} in this project yet.`, absent: true });
            }
          }

          /* GET /api/projects/:id/run/:runId/artifact/:name - per-run output. */
          if (parts[3] === "run" && parts[4] && parts[5] === "artifact" && parts[6]) {
            const name = decodeURIComponent(parts[6]);
            if (!RUN_ARTIFACTS.has(name)) {
              return json(res, 404, { error: `Not a run artifact: "${name}".` });
            }
            const paths = clarvisPaths(project.path);
            const file = path.join(paths.root, "runs", decodeURIComponent(parts[4]), name);
            try {
              return json(res, 200, JSON.parse(await readFile(file, "utf8")));
            } catch {
              return json(res, 404, { error: `No ${name} for this run.`, absent: true });
            }
          }

          /*
            GET /api/projects/:id/spec/:file - the authored spec source.

            A finding cites a spec file and a reader had no way to see it
            without leaving for a terminal. Confined to the scratch directory
            and to one extension, because this serves a path that came in over
            the wire.
          */
          if (parts[3] === "spec" && parts[4]) {
            const paths = clarvisPaths(project.path);
            const wanted = path.basename(decodeURIComponent(parts[4]));
            if (!wanted.endsWith(".spec.ts")) {
              return json(res, 400, { error: "Only .spec.ts files are served." });
            }
            const file = path.join(paths.scratch, wanted);
            if (!file.startsWith(paths.scratch)) {
              return json(res, 400, { error: "Outside the scratch directory." });
            }
            try {
              return json(res, 200, { file: wanted, source: await readFile(file, "utf8") });
            } catch {
              return json(res, 404, { error: `No spec named ${wanted}.`, absent: true });
            }
          }

          if (parts[3] === "run" && parts[4]) {
            try {
              return json(res, 200, await readRun(project.path, decodeURIComponent(parts[4])));
            } catch (e) {
              return json(res, 404, { error: e instanceof Error ? e.message : String(e) });
            }
          }
        }

        return json(res, 404, { error: `No such endpoint: ${url.pathname}` });
      }

      /* --------------------------------------------------------- static */

      if (!haveDist) {
        res.writeHead(503, { "content-type": MIME[".html"] });
        res.end(
          `<pre style="font:14px ui-monospace;padding:2rem">Dashboard bundle not built.\n\n  pnpm --filter @clarvis/ui build\n\nThe API is live at /api/projects.</pre>`,
        );
        return;
      }

      // Path is normalised and confined to dist, so a crafted URL cannot walk
      // out of the bundle directory.
      const rel = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      let file = path.join(dist, rel);
      if (!file.startsWith(dist)) file = path.join(dist, "index.html");
      try {
        const s = await stat(file);
        if (s.isDirectory()) file = path.join(file, "index.html");
      } catch {
        file = path.join(dist, "index.html");
      }

      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  const url = `http://localhost:${port}`;
  if (opts.open) openBrowser(url);

  const projects = await describeProjects();
  console.log(`\n  clarvis ui   ${url}`);
  console.log(`  projects     ${projects.length}`);
  for (const p of projects) {
    console.log(`               ${p.name.padEnd(22)} ${p.runCount ?? 0} run(s)${p.missing ? "  MISSING" : ""}`);
  }
  if (!haveDist) console.log(`  note         bundle not built - run: pnpm --filter @clarvis/ui build`);
  console.log("");
}
