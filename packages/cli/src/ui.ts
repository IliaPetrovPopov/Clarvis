import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLEETS,
  FLEET_KEYS,
  addProject,
  describeProjects,
  listRunIds,
  readRun,
  resolveProject,
  type ProjectEntry,
} from "@clarvis/core";

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
