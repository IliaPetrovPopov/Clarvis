import { spawn } from "node:child_process";
import { readFile, readdir, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { LOCAL_HOSTS, hostFromConnectionString } from "./fixtures.ts";
import type { Profile } from "./types.ts";

/**
 * Make a database that is disposable because we made it.
 *
 * Mutating axes - the ones that fill a form, create a record, check that a role
 * cannot write - were unreachable in practice. They require `data.disposable`,
 * a human sets that flag, and until someone does the fleet runs read-only. The
 * flag exists for a good reason: pointed at an unknown project, writing is how
 * you destroy someone's data. But it made the most valuable half of the system
 * depend on setup work that nobody does, so those axes had never once run.
 *
 * The flag answers the wrong question. It asks a human to vouch for a database
 * we were handed. The better move is not to be handed one: if Clarvis creates
 * the database, nothing else is using it, its contents came from a seed script
 * minutes ago, and its destruction costs nobody anything. Provenance replaces
 * permission - and unlike a flag, provenance cannot be set optimistically by
 * someone who did not check.
 *
 * Four ways to get one, best first:
 *
 *   1. The project's own compose file, starting only its database service. This
 *      is the team's definition of their database - right version, right
 *      extensions, right init scripts - so anything that works against it works
 *      against theirs.
 *   2. A fresh database on a server that is already running locally. Every
 *      engine here holds many databases at once, so this costs one CREATE and
 *      needs nothing installed that is not already there.
 *   3. A container for the engine the project's connection string names.
 *   4. Refuse, and say exactly what was missing.
 *
 * Whichever rung succeeds, the result is the same: a database this process
 * created, holding nothing but seed data, that is dropped when the run ends.
 *
 * Two rules that must not be relaxed:
 *
 *   The project's own database is never touched. A sandbox always has a name
 *   this module generated, and teardown refuses to drop anything whose name
 *   does not carry the marker - so a bug in name derivation destroys nothing.
 *
 *   Teardown survives a crash. A journal is written before anything is created
 *   and cleared only after removal, because `finally` does not run when a
 *   process is killed, and a leaked container holding a port is a failure that
 *   outlives the run that caused it.
 */

export type Engine = "mongodb" | "postgres" | "mysql";

/** Marks a database as ours. Teardown will not drop a name without it. */
export const SANDBOX_MARKER = "clarvis_sbx";

export interface Sandbox {
  engine: Engine;
  /** How it was obtained. This is what makes it disposable. */
  provisionedBy: "compose" | "fresh-database" | "container" | "in-process";
  /** Connection string the application must use. */
  uri: string;
  /** Environment the boot command needs so the app connects here. */
  env: Record<string, string>;
  /** Which variables were overridden, for the run record. */
  variables: string[];
  /** Plain-language account of what was created. */
  evidence: string;
  teardown: () => Promise<void>;
}

export interface ProvisionResult {
  sandbox?: Sandbox;
  /** Every rung tried and why it did not work. Always reported. */
  attempts: Array<{ approach: string; outcome: string }>;
  /** Set when no rung succeeded: what a human could do about it. */
  remedy?: string;
}

/* ------------------------------------------------------------------ shell */

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });

    let out = "";
    const collect = (b: Buffer) => {
      out += b.toString();
      if (out.length > 20_000) out = out.slice(-20_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out: out.slice(-4000) });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: e.message });
    });
  });
}

const available = async (bin: string): Promise<boolean> =>
  (await run(bin, ["--version"], { timeoutMs: 10_000 })).code === 0;

/**
 * Docker installed AND its daemon answering.
 *
 * `docker --version` succeeds with the daemon stopped, which is the most common
 * state on a developer machine, so checking only for the binary produces a
 * confident attempt that fails on a raw socket error. Asking the daemon a
 * question it can only answer when running turns that into something a person
 * can act on.
 */
async function dockerReady(): Promise<{ ok: boolean; reason?: string }> {
  if (!(await available("docker"))) return { ok: false, reason: "docker is not installed" };

  const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
  if (info.code === 0) return { ok: true };

  return {
    ok: false,
    reason: "docker is installed but its daemon is not running - start Docker Desktop",
  };
}

/* -------------------------------------------------------------- the uri */

export function engineOf(uri: string): Engine | undefined {
  if (/^mongodb(\+srv)?:/i.test(uri)) return "mongodb";
  if (/^postgres(ql)?:/i.test(uri)) return "postgres";
  if (/^mysql:/i.test(uri)) return "mysql";
  return undefined;
}

/**
 * Rewrite a connection string to name a different database.
 *
 * The database is the path segment for every engine handled here, so this is
 * one substitution rather than three. Query parameters are preserved: an
 * authSource or an sslmode dropped here would turn a working connection into a
 * failure attributed to the sandbox.
 */
export function withDatabase(uri: string, database: string): string {
  const [head, query] = uri.split("?", 2);
  const marker = head.indexOf("://");
  if (marker === -1) return uri;

  const afterScheme = head.slice(marker + 3);
  const slash = afterScheme.indexOf("/");
  const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);

  return `${head.slice(0, marker + 3)}${authority}/${database}${query ? `?${query}` : ""}`;
}

export function databaseOf(uri: string): string | undefined {
  const head = uri.split("?", 1)[0];
  const marker = head.indexOf("://");
  if (marker === -1) return undefined;
  const afterScheme = head.slice(marker + 3);
  const slash = afterScheme.indexOf("/");
  const name = slash === -1 ? "" : afterScheme.slice(slash + 1);
  return name || undefined;
}

/** A name that is unmistakably ours, and short enough for every engine. */
export function sandboxName(original: string | undefined, runId: string): string {
  const stem = (original ?? "app").replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) || "app";
  const suffix = runId.replace(/[^A-Za-z0-9]/g, "").slice(-8).toLowerCase() || "run";
  return `${stem}_${SANDBOX_MARKER}_${suffix}`;
}

/** Every connection variable the project defines, with its value. */
const CONNECTION_VARS = [
  "DATABASE_URL",
  "DATABASE_URI",
  "MONGO_URI",
  "MONGODB_URI",
  "POSTGRES_URL",
  "POSTGRESQL_URL",
  "MYSQL_URL",
  "DB_URL",
];

async function projectConnections(projectRoot: string): Promise<Array<{ variable: string; uri: string }>> {
  const names = [".env", ".env.local", ".env.development", ".env.development.local", ".env.test"];

  // One level down too: a service architecture keeps these in services/x/.env,
  // and reading only the root meant a monorepo looked like it used no database.
  const files = [...names];
  for (const dir of ["services", "apps", "packages"]) {
    const entries = await readdir(path.join(projectRoot, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const name of names) files.push(path.join(dir, entry.name, name));
    }
  }

  const found = new Map<string, string>();

  for (const file of files) {
    const text = await readFile(path.join(projectRoot, file), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
      if (!match || !CONNECTION_VARS.includes(match[1])) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (value) found.set(match[1], value);
    }
  }

  for (const variable of CONNECTION_VARS) {
    const value = process.env[variable]?.trim();
    if (value && !found.has(variable)) found.set(variable, value);
  }

  return [...found].map(([variable, uri]) => ({ variable, uri }));
}

/* --------------------------------------------------------------- journal */

interface JournalEntry {
  kind: "container" | "database";
  engine: Engine;
  /** Container name, or the database name to drop. */
  name: string;
  /** For a database, the admin connection string used to drop it. */
  adminUri?: string;
  createdAt: string;
}

/**
 * Written before anything is created, cleared only after it is removed.
 *
 * `finally` does not run when a process is killed, and this has already cost a
 * mutated file left on disk once. A container holding a port is worse: it
 * outlives the run and breaks the next one for a reason nobody will connect
 * back to here.
 */
async function journalPath(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  return path.join(stateDir, "sandbox-journal.json");
}

async function writeJournal(stateDir: string, entry: JournalEntry): Promise<void> {
  await writeFile(await journalPath(stateDir), JSON.stringify(entry, null, 2), "utf8");
}

async function clearJournal(stateDir: string): Promise<void> {
  await rm(await journalPath(stateDir), { force: true }).catch(() => {});
}

/**
 * Remove anything a previous run created and did not clean up.
 *
 * Called before provisioning rather than only after a crash, because the run
 * that leaked is by definition the one that could not run its own cleanup.
 */
export async function reclaimLeaked(
  stateDir: string,
  log: (line: string) => void = () => {},
): Promise<string[]> {
  const file = await journalPath(stateDir);
  const raw = await readFile(file, "utf8").catch(() => "");
  if (!raw) return [];

  let entry: JournalEntry;
  try {
    entry = JSON.parse(raw) as JournalEntry;
  } catch {
    await rm(file, { force: true }).catch(() => {});
    return [];
  }

  // The marker check is what makes a bug here harmless. A name we did not
  // generate is never dropped, whatever the journal says.
  if (!entry.name.includes(SANDBOX_MARKER)) {
    log(`refusing to remove "${entry.name}" - it does not carry the sandbox marker`);
    await rm(file, { force: true }).catch(() => {});
    return [];
  }

  log(`a previous run left ${entry.kind} "${entry.name}" behind; removing it`);
  await destroy(entry).catch(() => {});
  await rm(file, { force: true }).catch(() => {});
  return [entry.name];
}

async function destroy(entry: JournalEntry): Promise<void> {
  if (!entry.name.includes(SANDBOX_MARKER)) return;

  if (entry.kind === "container") {
    await run("docker", ["rm", "-f", entry.name], { timeoutMs: 60_000 });
    return;
  }

  if (!entry.adminUri) return;
  switch (entry.engine) {
    case "mongodb":
      await run("mongosh", [entry.adminUri, "--quiet", "--eval", "db.dropDatabase()"], {
        timeoutMs: 60_000,
      });
      return;
    case "postgres":
      await run("psql", [entry.adminUri, "-c", `DROP DATABASE IF EXISTS "${entry.name}"`], {
        timeoutMs: 60_000,
      });
      return;
    case "mysql":
      await run("mysql", [entry.adminUri, "-e", `DROP DATABASE IF EXISTS \`${entry.name}\``], {
        timeoutMs: 60_000,
      });
      return;
  }
}

/* ------------------------------------------------------- rung 2: fresh db */

/** Is a server answering on this host and port? */
async function reachable(host: string, port: number): Promise<boolean> {
  const { createConnection } = await import("node:net");
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const DEFAULT_PORT: Record<Engine, number> = { mongodb: 27017, postgres: 5432, mysql: 3306 };

function portOf(uri: string, engine: Engine): number {
  const match = /:(\d+)(?:[/?]|$)/.exec(uri.replace(/^[a-z+]+:\/\//i, ""));
  return match ? Number(match[1]) : DEFAULT_PORT[engine];
}

/**
 * A new database on a server that is already running here.
 *
 * The cheapest rung by a wide margin: every engine handled here holds many
 * databases at once, so this needs nothing installed that is not already
 * running and leaves the project's own database untouched beside it.
 *
 * MongoDB creates a database on first write, so nothing has to be run at all.
 * The others need one statement, which needs their client - and where that is
 * missing this rung is skipped rather than half-completed.
 */
async function freshDatabase(opts: {
  engine: Engine;
  uri: string;
  name: string;
  stateDir: string;
  forbiddenHosts?: string[];
  log: (line: string) => void;
}): Promise<{ uri: string; evidence: string } | { failed: string }> {
  const host = hostFromConnectionString(opts.uri);
  if (!host) return { failed: "the connection string names no host" };

  /*
    The server must be this machine. Checked here, before anything is even
    connected to.

    This rung creates a database beside the project's own, on the same server
    the project's connection string names - which is only safe when that server
    is local. Nothing checked, so a project whose services point at a shared
    remote database would have had a database created ON that server and handed
    back as a sandbox. Provenance would then have granted mutating mode against
    it, on the grounds that Clarvis made it.

    That is worse than having no sandbox at all: the guard's whole purpose is
    to keep writes off shared infrastructure, and this would have routed them
    there while reporting that it had contained them. A remote host means this
    rung does not apply, and a container - which is local by construction - is
    the fallback.
  */
  const forbidden = opts.forbiddenHosts?.find((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`, "i").test(host);
  });
  if (forbidden) {
    return { failed: `${host} matches forbidden host pattern "${forbidden}"` };
  }

  if (!LOCAL_HOSTS.test(host)) {
    return {
      failed:
        `${host} is not this machine. A database created there would be on shared infrastructure, ` +
        `however disposable its name looked`,
    };
  }

  const port = portOf(opts.uri, opts.engine);
  if (!(await reachable(host, port))) {
    return { failed: `nothing is listening on ${host}:${port}` };
  }

  const sandboxUri = withDatabase(opts.uri, opts.name);
  const adminUri = withDatabase(opts.uri, opts.engine === "postgres" ? "postgres" : "");

  await writeJournal(opts.stateDir, {
    kind: "database",
    engine: opts.engine,
    name: opts.name,
    adminUri: opts.engine === "mongodb" ? sandboxUri : adminUri,
    createdAt: new Date().toISOString(),
  });

  if (opts.engine === "mongodb") {
    // Created on first write. Nothing to run, and nothing that can fail here.
    return {
      uri: sandboxUri,
      evidence: `database "${opts.name}" on the MongoDB server already running at ${host}:${port}`,
    };
  }

  const client = opts.engine === "postgres" ? "psql" : "mysql";
  if (!(await available(client))) {
    await clearJournal(opts.stateDir);
    return { failed: `${client} is not installed, so a database cannot be created` };
  }

  const create =
    opts.engine === "postgres"
      ? await run(client, [adminUri, "-c", `CREATE DATABASE "${opts.name}"`], { timeoutMs: 60_000 })
      : await run(client, [adminUri, "-e", `CREATE DATABASE \`${opts.name}\``], { timeoutMs: 60_000 });

  if (create.code !== 0) {
    await clearJournal(opts.stateDir);
    return { failed: `${client} could not create the database: ${create.out.split("\n").slice(-2).join(" ")}` };
  }

  return {
    uri: sandboxUri,
    evidence: `database "${opts.name}" created on the ${opts.engine} server at ${host}:${port}`,
  };
}

/* ----------------------------------------------- rung 0: in-process server */

/**
 * A real database server, started by this process, needing nothing installed.
 *
 * The other rungs all depend on something being there already: a running
 * server, a Docker daemon, a compose file. On a machine with none of them -
 * which is the common case, and was the case here - mutating axes simply never
 * ran, and the whole authenticated half of every application stayed untested.
 *
 * This starts a genuine mongod on a port the OS picks. Not an emulator: the
 * binary is the same one the project would run, so behaviour that depends on
 * real indexes, real aggregation or real write concerns behaves the same way.
 * It costs a one-off download and then a few hundred milliseconds per run.
 *
 * Nothing is installed on the machine in the sense that matters - there is no
 * daemon to manage, no service to remember to stop, and removing the package
 * removes it entirely. The data lives in a temp directory that goes when the
 * process does.
 */
async function inProcessServer(opts: {
  engine: Engine;
  name: string;
  stateDir: string;
  log: (line: string) => void;
}): Promise<{ uri: string; evidence: string; stop: () => Promise<void> } | { failed: string }> {
  // Only MongoDB for now: the equivalent for Postgres exists but is a separate
  // dependency, and claiming support for an engine nothing was tested against
  // would be worse than saying it is not handled.
  if (opts.engine !== "mongodb") {
    return { failed: `no in-process server is wired up for ${opts.engine}` };
  }

  try {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const server = await MongoMemoryServer.create();
    const uri = server.getUri();

    await writeJournal(opts.stateDir, {
      kind: "database",
      engine: opts.engine,
      name: opts.name,
      createdAt: new Date().toISOString(),
    });

    opts.log(`started a real mongod in-process at ${uri.replace(/\/\/[^@]*@/, "//")}`);

    return {
      uri: withDatabase(uri, opts.name),
      evidence: "a mongod started by this run, in a temp directory, stopped when it ends",
      stop: async () => {
        await server.stop().catch(() => {});
      },
    };
  } catch (e) {
    return {
      failed: `could not start an in-process mongod: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/* -------------------------------------------------------- rung 1: compose */

/** Service names in a compose file that look like the database. */
const DB_SERVICE = /^(db|database|mongo|mongodb|postgres|postgresql|pg|mysql|mariadb)$/i;

async function composeDatabaseService(projectRoot: string): Promise<{ file: string; service: string } | undefined> {
  for (const file of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const text = await readFile(path.join(projectRoot, file), "utf8").catch(() => "");
    if (!text) continue;

    // Deliberately not a YAML parser: the only thing needed is the top-level
    // service names, which are the two-space keys under `services:`. A wrong
    // guess here costs one failed `docker compose up` and falls through.
    const services = text.split(/^services:\s*$/m)[1];
    if (!services) continue;

    for (const match of services.matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)) {
      if (DB_SERVICE.test(match[1])) return { file, service: match[1] };
    }
  }
  return undefined;
}

/* ---------------------------------------------------------------- entry */

export interface ProvisionOptions {
  profile: Profile;
  runId: string;
  /** Where the journal lives. Outside the project, like all other state. */
  stateDir: string;
  log?: (line: string) => void;
}

/**
 * Get a disposable database, or explain precisely why not.
 *
 * Never touches the project's own database: every rung either creates something
 * new beside it or starts something separate. The name always carries the
 * marker, so teardown cannot remove anything else even if this function is
 * wrong about what it made.
 */
export async function provisionSandbox(opts: ProvisionOptions): Promise<ProvisionResult> {
  const log = opts.log ?? (() => {});
  const attempts: ProvisionResult["attempts"] = [];

  await reclaimLeaked(opts.stateDir, log);

  const connections = await projectConnections(opts.profile.project.root);
  if (!connections.length) {
    return {
      attempts,
      remedy:
        "This project names no database in its env files, so there is nothing to stand up a " +
        "copy of. If it does use one, set DATABASE_URL (or MONGODB_URI, POSTGRES_URL) in its " +
        ".env so the engine and port can be read.",
    };
  }

  const primary = connections.find((c) => engineOf(c.uri)) ?? connections[0];
  const engine = engineOf(primary.uri);
  if (!engine) {
    return {
      attempts,
      remedy: `${primary.variable} names an engine this does not handle yet (${primary.uri.split("://")[0]}://). Handled: mongodb, postgres, mysql.`,
    };
  }

  const original = databaseOf(primary.uri);
  const name = sandboxName(original, opts.runId);

  // Refusing to proceed if the derived name somehow matches the project's own
  // is belt and braces over the marker, and costs nothing.
  if (original && name === original) {
    return { attempts, remedy: "The sandbox name collided with the project's own database. Refusing." };
  }

  /* --- rung 0: a server we start ourselves -------------------------------- */

  // First, because it is the only rung with no prerequisite at all. A project
  // that has a compose file or a running server still gets a database of our
  // own rather than one beside theirs, which is the safer default.
  const inProcess = await inProcessServer({ engine, name, stateDir: opts.stateDir, log });
  if ("uri" in inProcess) {
    return {
      attempts,
      sandbox: {
        engine,
        provisionedBy: "in-process",
        uri: inProcess.uri,
        env: Object.fromEntries(connections.map((c) => [c.variable, inProcess.uri])),
        variables: connections.map((c) => c.variable),
        evidence: inProcess.evidence,
        teardown: async () => {
          await inProcess.stop();
          await clearJournal(opts.stateDir);
          log("stopped the in-process mongod");
        },
      },
    };
  }
  attempts.push({ approach: "an in-process mongod", outcome: inProcess.failed });

  /* --- rung 1: the project's own compose definition ---------------------- */

  const compose = await composeDatabaseService(opts.profile.project.root);
  if (compose) {
    const docker = await dockerReady();
    if (!docker.ok) {
      attempts.push({
        approach: `compose service "${compose.service}"`,
        outcome: docker.reason!,
      });
    } else {
      const up = await run(
        "docker",
        ["compose", "-f", compose.file, "up", "-d", compose.service],
        { cwd: opts.profile.project.root, timeoutMs: 180_000 },
      );

      if (up.code !== 0) {
        attempts.push({
          approach: `compose service "${compose.service}"`,
          outcome: up.out.split("\n").filter(Boolean).slice(-1)[0] ?? `exited ${up.code}`,
        });
      } else {
        log(`started "${compose.service}" from ${compose.file}`);
        // The server is the project's own; the DATABASE on it is still ours.
        const fresh = await freshDatabase({
          engine,
          uri: primary.uri,
          name,
          stateDir: opts.stateDir,
          forbiddenHosts: opts.profile.data.forbiddenHosts,
          log,
        });
        if ("uri" in fresh) {
          return {
            attempts,
            sandbox: makeSandbox({
              engine,
              provisionedBy: "compose",
              uri: fresh.uri,
              variables: connections.map((c) => c.variable),
              evidence: `${fresh.evidence}, on the server from ${compose.file}`,
              name,
              stateDir: opts.stateDir,
              log,
            }),
          };
        }
        attempts.push({ approach: `compose service "${compose.service}"`, outcome: fresh.failed });
      }
    }
  }

  /* --- rung 2: a server already running here ----------------------------- */

  const fresh = await freshDatabase({
    engine,
    uri: primary.uri,
    name,
    stateDir: opts.stateDir,
    forbiddenHosts: opts.profile.data.forbiddenHosts,
    log,
  });
  if ("uri" in fresh) {
    return {
      attempts,
      sandbox: makeSandbox({
        engine,
        provisionedBy: "fresh-database",
        uri: fresh.uri,
        variables: connections.map((c) => c.variable),
        evidence: fresh.evidence,
        name,
        stateDir: opts.stateDir,
        log,
      }),
    };
  }
  attempts.push({ approach: "a fresh database on the local server", outcome: fresh.failed });

  /* --- rung 3: a container for the engine -------------------------------- */

  const docker = await dockerReady();
  if (!docker.ok) {
    attempts.push({ approach: `a ${engine} container`, outcome: docker.reason! });
  } else {
    const container = await startContainer({ engine, name, stateDir: opts.stateDir, log });
    if ("uri" in container) {
      return {
        attempts,
        sandbox: makeSandbox({
          engine,
          provisionedBy: "container",
          uri: withDatabase(container.uri, name),
          variables: connections.map((c) => c.variable),
          evidence: container.evidence,
          name,
          stateDir: opts.stateDir,
          log,
          container: name,
        }),
      };
    }
    attempts.push({ approach: `a ${engine} container`, outcome: container.failed });
  }

  return {
    attempts,
    remedy:
      `No disposable ${engine} could be created. Any one of these would fix it: start the ` +
      `${engine} server this project already expects, start Docker Desktop, or install the ` +
      `${engine === "postgres" ? "psql" : engine === "mysql" ? "mysql" : "mongosh"} client.`,
  };
}

function makeSandbox(opts: {
  engine: Engine;
  provisionedBy: Sandbox["provisionedBy"];
  uri: string;
  variables: string[];
  evidence: string;
  name: string;
  stateDir: string;
  log: (line: string) => void;
  container?: string;
}): Sandbox {
  // Every connection variable the project defines is overridden, not just the
  // one that was read. A project naming its database twice under two spellings
  // would otherwise have half its code writing to the sandbox and half to the
  // real thing, which is worse than either.
  const env = Object.fromEntries(opts.variables.map((variable) => [variable, opts.uri]));

  return {
    engine: opts.engine,
    provisionedBy: opts.provisionedBy,
    uri: opts.uri,
    env,
    variables: opts.variables,
    evidence: opts.evidence,
    teardown: async () => {
      await destroy({
        kind: opts.container ? "container" : "database",
        engine: opts.engine,
        name: opts.container ?? opts.name,
        adminUri: opts.container ? undefined : adminFor(opts.engine, opts.uri),
        createdAt: new Date().toISOString(),
      });
      await clearJournal(opts.stateDir);
      opts.log(`removed ${opts.container ? "container" : "database"} "${opts.container ?? opts.name}"`);
    },
  };
}

function adminFor(engine: Engine, uri: string): string {
  // MongoDB drops the database it is connected to; the others need a
  // connection to something that is not the database being dropped.
  return engine === "mongodb" ? uri : withDatabase(uri, engine === "postgres" ? "postgres" : "");
}

const IMAGE: Record<Engine, { image: string; port: number; env: Record<string, string> }> = {
  mongodb: { image: "mongo:7", port: 27017, env: {} },
  postgres: {
    image: "postgres:16-alpine",
    port: 5432,
    env: { POSTGRES_PASSWORD: "clarvis", POSTGRES_USER: "clarvis" },
  },
  mysql: {
    image: "mysql:8",
    port: 3306,
    env: { MYSQL_ROOT_PASSWORD: "clarvis", MYSQL_DATABASE: "clarvis" },
  },
};

/**
 * A container running the engine, on a port the operating system picked.
 *
 * `-P` rather than a chosen port: a hardcoded one collides with whatever else
 * is running, and asking the OS for a free one is the same reasoning that keeps
 * the port shim from moving a port that was already zero.
 */
async function startContainer(opts: {
  engine: Engine;
  name: string;
  stateDir: string;
  log: (line: string) => void;
}): Promise<{ uri: string; evidence: string } | { failed: string }> {
  const spec = IMAGE[opts.engine];

  await writeJournal(opts.stateDir, {
    kind: "container",
    engine: opts.engine,
    name: opts.name,
    createdAt: new Date().toISOString(),
  });

  const envArgs = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const started = await run(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      opts.name,
      // Labelled as well as named, so a human sweeping up by hand can find
      // every one of these with a single filter.
      "--label",
      `${SANDBOX_MARKER}=1`,
      "-P",
      ...envArgs,
      spec.image,
    ],
    { timeoutMs: 240_000 },
  );

  if (started.code !== 0) {
    await clearJournal(opts.stateDir);
    return { failed: started.out.split("\n").filter(Boolean).slice(-1)[0] ?? `docker run exited ${started.code}` };
  }

  const mapped = await run("docker", ["port", opts.name, String(spec.port)], { timeoutMs: 30_000 });
  const port = /:(\d+)\s*$/.exec(mapped.out.trim())?.[1];
  if (!port) {
    await destroy({ kind: "container", engine: opts.engine, name: opts.name, createdAt: "" });
    await clearJournal(opts.stateDir);
    return { failed: "the container started but its port could not be read" };
  }

  // Wait for the engine to accept connections. A container that is "running" is
  // not yet a database that answers, and seeding into one that is still
  // starting fails in a way that looks like a broken seed script.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await reachable("127.0.0.1", Number(port))) {
      const credentials =
        opts.engine === "postgres"
          ? "clarvis:clarvis@"
          : opts.engine === "mysql"
            ? "root:clarvis@"
            : "";
      const scheme = opts.engine === "postgres" ? "postgresql" : opts.engine;
      opts.log(`${opts.engine} container "${opts.name}" is answering on ${port}`);
      return {
        uri: `${scheme}://${credentials}127.0.0.1:${port}/`,
        evidence: `a ${spec.image} container on port ${port}, removed when the run ends`,
      };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  await destroy({ kind: "container", engine: opts.engine, name: opts.name, createdAt: "" });
  await clearJournal(opts.stateDir);
  return { failed: "the container started but never accepted a connection within 90s" };
}
