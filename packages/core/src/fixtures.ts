import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { decideGuard, normalizeTarget } from "./guard.ts";
import type { Profile } from "./types.ts";

/**
 * Test data, and the several ways getting it wrong destroys a database.
 *
 * An application with no data cannot be meaningfully tested. Empty lists render
 * empty states, permissions have nothing to be scoped over, and a workflow that
 * edits a record has no record to edit. So data has to come from somewhere.
 *
 * The wrong somewhere is a database driver of our own. Writing rows directly
 * means reproducing every invariant the application enforces - required
 * relations, derived fields, hashed credentials, tenant keys - and getting one
 * wrong produces a state the application would never have created. Tests then
 * pass or fail against a situation that cannot occur in production, which is
 * worse than not testing: it manufactures both false failures and false
 * confidence, and it needs a driver per database besides.
 *
 * The right somewhere is the project's own tooling. A team that wrote a seed
 * script encoded their model of their data in it, correctly, including every
 * invariant we would have had to guess. Running theirs is both the most
 * faithful option and the only one that generalises, because every stack has
 * one and none of them agree on anything else.
 *
 * That leaves the danger, which is real and specific. The guard vets an HTTP
 * target. A seed script does not connect over HTTP - it reads a connection
 * string from the environment and connects to whatever it names, which the
 * guard has never seen and cannot see. So a project whose local app runs on
 * localhost while its DATABASE_URL points at a shared remote server passes
 * every existing check, and then `db:reset` drops the shared database. This is
 * not hypothetical; that arrangement is ordinary in a service architecture,
 * where local processes routinely share one remote database.
 *
 * Hence the rule here: resolve the connection string first, check ITS host
 * against the same deny-list, and refuse when the target cannot be determined.
 * A command whose destination is unknown is treated as pointing at production,
 * because "I could not tell" and "it is safe" must never take the same branch.
 *
 * Destructive commands additionally require their own opt-in. Being willing to
 * have records created is not the same as being willing to have the schema
 * dropped, and one flag covering both would make the safer intent unexpressible.
 */

export type DataCommandKind = "seed" | "reset" | "migrate";

export interface DataCommand {
  kind: DataCommandKind;
  /** The npm script name, e.g. "db:seed". */
  script: string;
  /** What that script actually runs. */
  command: string;
  /** Directory to run it from, relative to the project root. */
  cwd: string;
  /** True when it drops, truncates or recreates rather than adding. */
  destructive: boolean;
}

export interface DataTargetCheck {
  ok: boolean;
  /** The connection string variable that decided it, e.g. "DATABASE_URL". */
  variable?: string;
  /** Host resolved from it, when one could be resolved. */
  host?: string;
  reason: string;
}

export interface PreparedData {
  ran: Array<{ command: DataCommand; exitCode: number; durationMs: number }>;
  skipped: Array<{ command: DataCommand; reason: string }>;
  /** What a spec author can rely on existing. Empty when nothing was seeded. */
  seeded: boolean;
  targetCheck: DataTargetCheck;
  warnings: string[];
}

/* --------------------------------------------------------------- discovery */

/** Script names that create data, in preference order. */
const SEED_NAMES = /^(db:)?(seed|seeds|fixtures?|db:populate|populate)$/i;
/** Script names that destroy before they create. */
const RESET_NAMES = /^(db:)?(reset|drop|nuke|recreate|fresh|refresh|truncate)$/i;
const MIGRATE_NAMES = /^(db:)?(migrate|migration|migrate:latest|schema:push)$/i;

/**
 * Words that make a command destructive whatever it is called.
 *
 * Checked against the command body, not only its name, because a script named
 * "seed" that begins by dropping the schema is destructive regardless of what
 * the author called it - and that naming is common.
 */
const DESTRUCTIVE_BODY = /\b(drop|truncate|--force-reset|reset|delete\s+from|db:wipe|prisma\s+migrate\s+reset)\b/i;

export async function discoverDataCommands(projectRoot: string): Promise<DataCommand[]> {
  /*
    The root manifest and one level down.

    A service architecture puts its seed script in `services/auth/package.json`
    - Examate's is exactly there - and reading only the root found none, so the
      project looked as though it had no way to make data. That is the same
      blind spot that made its connection strings invisible, and it mattered
      more: a sandbox with no seed script is an empty database, which is worse
      for testing than no sandbox at all.
  */
  const manifests: Array<{ cwd: string; text: string }> = [];

  const root = await readFile(path.join(projectRoot, "package.json"), "utf8").catch(() => "");
  if (root) manifests.push({ cwd: ".", text: root });

  for (const dir of ["services", "apps", "packages"]) {
    const entries = await readdir(path.join(projectRoot, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = path.join(dir, entry.name);
      const text = await readFile(path.join(projectRoot, rel, "package.json"), "utf8").catch(() => "");
      if (text) manifests.push({ cwd: rel, text });
    }
  }

  if (!manifests.length) return [];

  const out: DataCommand[] = [];

  for (const manifest of manifests) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(manifest.text) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      continue;
    }

    collect(scripts, manifest.cwd, out);
  }

  return out;
}

/** Pull the data commands out of one manifest's scripts. */
function collect(scripts: Record<string, string>, cwd: string, out: DataCommand[]): void {
  for (const [script, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;

    const kind: DataCommandKind | null = RESET_NAMES.test(script)
      ? "reset"
      : SEED_NAMES.test(script)
        ? "seed"
        : MIGRATE_NAMES.test(script)
          ? "migrate"
          : null;
    if (!kind) continue;

    out.push({
      kind,
      script,
      command,
      // Where it must be run from. A service's seed script resolves its own
      // dependencies and its own dist output, and fails from the root.
      cwd,
      destructive: kind === "reset" || DESTRUCTIVE_BODY.test(command),
    });
  }
}

/* ------------------------------------------------------------ target check */

/** Environment variables that name a database. */
const CONNECTION_VARS = [
  "DATABASE_URL",
  "DATABASE_URI",
  "MONGO_URI",
  "MONGODB_URI",
  "POSTGRES_URL",
  "POSTGRESQL_URL",
  "MYSQL_URL",
  "REDIS_URL",
  "DB_URL",
  "DB_HOST",
];

/**
 * Hosts that are unambiguously this machine.
 *
 * Exported so the sandbox uses the same list. It had none, so it would have
 * created a database on whatever server a project's connection string named -
 * including a shared remote one - and handed it back as disposable.
 */
export const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|host\.docker\.internal|db|database|mongo|postgres|mysql)$/i;

/** Pull the host out of a connection string, whatever its scheme. */
export function hostFromConnectionString(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    // A connection string with a scheme parses as a URL once the scheme is
    // something URL understands. Credentials often contain characters that
    // break parsing, so the userinfo is stripped first.
    const withoutCredentials = trimmed.replace(/^([a-z0-9+.-]+:\/\/)[^@/]*@/i, "$1");
    const url = new URL(withoutCredentials);
    if (url.hostname) return url.hostname.toLowerCase();
  } catch {
    /* fall through to the bare-host case */
  }

  // A bare host, as DB_HOST is usually written.
  if (/^[a-z0-9.-]+(:\d+)?$/i.test(trimmed)) return trimmed.split(":")[0].toLowerCase();
  return undefined;
}

/**
 * Read the environment a data command would actually run under.
 *
 * The project's own dotenv files, in the order tooling loads them, so what we
 * check is what the command will see. Values here are never logged: a
 * connection string carries credentials.
 */
async function readProjectEnv(projectRoot: string): Promise<Record<string, string>> {
  const names = [".env", ".env.local", ".env.development", ".env.development.local", ".env.test"];

  /*
    One level down as well as the root.

    A service architecture keeps its connection strings in `services/x/.env`,
    not at the top, and reading only the root found nothing at all. It then
    refused - the safe direction, but for the wrong reason: "I could not find a
    database" rather than "that database is on a shared server". The difference
    matters, because a root .env naming localhost while eight services point at
    a remote host would have read as safe.
  */
  const files = [...names];
  for (const dir of ["services", "apps", "packages"]) {
    const entries = await readdir(path.join(projectRoot, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const name of names) files.push(path.join(dir, entry.name, name));
    }
  }

  const env: Record<string, string> = {};

  for (const file of files) {
    const text = await readFile(path.join(projectRoot, file), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (value) env[match[1]] = value;
    }
  }
  return env;
}

/**
 * Decide whether a data command may touch what it is pointed at.
 *
 * Fails closed at every branch. No connection string found means refused, not
 * allowed: a project can name its variable anything, and the failure mode of
 * guessing wrong is dropping a database that was never checked.
 */
export async function checkDataTarget(
  profile: Profile,
  /**
   * Environment that overrides the project's own.
   *
   * When a sandbox is in play these are the connection strings the command will
   * actually use, and checking the project's env instead would refuse a run
   * that was never going to touch the project's database - or, worse, approve
   * one because the file looked local while the override did not.
   */
  overrides?: Record<string, string>,
): Promise<DataTargetCheck> {
  if (overrides && Object.keys(overrides).length) {
    for (const [variable, value] of Object.entries(overrides)) {
      if (!CONNECTION_VARS.includes(variable)) continue;
      const host = hostFromConnectionString(value);
      if (!host) {
        return { ok: false, variable, reason: `${variable} is overridden with a value that names no host.` };
      }
      if (!LOCAL_HOSTS.test(host)) {
        return {
          ok: false,
          variable,
          host,
          reason: `${variable} is overridden to point at ${host}, which is not this machine.`,
        };
      }
    }

    return {
      ok: true,
      variable: Object.keys(overrides)[0],
      reason:
        `Every connection string is overridden to a database created for this run, so the ` +
        `project's own is not reachable from these commands.`,
    };
  }

  const fromFiles = await readProjectEnv(profile.project.root);

  // BOTH sources, not one layered over the other. Which of them wins at runtime
  // depends on the project's own dotenv configuration, and picking either as
  // authoritative lets the other hide a remote database behind a local one.
  // Every value that could reach the command must pass.
  const found: Array<{ variable: string; value: string }> = [];
  for (const variable of CONNECTION_VARS) {
    for (const value of [fromFiles[variable], process.env[variable]]) {
      if (!value?.trim()) continue;
      if (found.some((f) => f.variable === variable && f.value === value)) continue;
      found.push({ variable, value });
    }
  }

  if (!found.length) {
    return {
      ok: false,
      reason:
        "No database connection string could be found, so where a data command would write is " +
        "unknown. Refusing rather than assuming it is local. Set one of " +
        `${CONNECTION_VARS.slice(0, 4).join(", ")} in the project's env, or run without data preparation.`,
    };
  }

  // EVERY connection found must pass. A project with a local Postgres and a
  // shared remote Mongo is exactly the case where checking only the first one
  // gives an answer that is both confident and wrong.
  for (const { variable, value } of found) {
    const host = hostFromConnectionString(value);

    if (!host) {
      return {
        ok: false,
        variable,
        reason: `${variable} is set but no host could be read from it, so its destination is unknown.`,
      };
    }

    const forbidden = profile.data.forbiddenHosts?.find((pattern) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
      return new RegExp(`^${escaped}$`, "i").test(host) || new RegExp(`^${escaped}$`, "i").test(normalizeTarget(host));
    });

    if (forbidden) {
      return {
        ok: false,
        variable,
        host,
        reason: `${variable} points at ${host}, which matches forbidden host pattern "${forbidden}".`,
      };
    }

    if (!LOCAL_HOSTS.test(host)) {
      return {
        ok: false,
        variable,
        host,
        reason:
          `${variable} points at ${host}, which is not this machine. A data command would write ` +
          `there, and the guard only vetted the HTTP target. Refusing.`,
      };
    }
  }

  return {
    ok: true,
    variable: found[0].variable,
    host: hostFromConnectionString(found[0].value),
    reason: `${found.length} connection string(s) checked, all pointing at this machine.`,
  };
}

/* ------------------------------------------------------------------ run it */

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  overrides?: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      // The overrides go LAST so a sandbox connection string wins over
      // anything already in the environment. A seed script that read the real
      // one because the ordering was the other way round would write the
      // project's own database, which is the whole thing this prevents.
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", ...overrides },
    });

    let output = "";
    const collect = (b: Buffer) => {
      output += b.toString();
      if (output.length > 20_000) output = output.slice(-20_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      output += `\nclarvis: timed out after ${timeoutMs}ms`;
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: output.slice(-4000) });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: `${output}\n${e.message}`.slice(-4000) });
    });
  });
}

export interface PrepareOptions {
  profile: Profile;
  /**
   * Connection strings pointing at a database created for this run.
   *
   * Passed to the commands and used for the safety check in place of the
   * project's own env, because these are what the command will actually see.
   */
  sandboxEnv?: Record<string, string>;
  /**
   * Permission to run a command that destroys before it creates. Separate from
   * `data.disposable` on purpose: being willing to have records created is not
   * being willing to have the schema dropped, and one flag for both would make
   * the safer intent impossible to express.
   */
  allowDestructive?: boolean;
  /** Run migrations before seeding. Off by default - schema changes are not testing. */
  allowMigrate?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Put the application into a known data state before mutating axes run.
 *
 * Refuses unless the guard has already reached "mutating" AND the database the
 * commands would write to passes its own check. Both, every time: they are
 * different questions about different destinations, and the HTTP one has no
 * bearing on where a seed script connects.
 */
export async function prepareData(opts: PrepareOptions): Promise<PreparedData> {
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];
  const ran: PreparedData["ran"] = [];
  const skipped: PreparedData["skipped"] = [];

  const decision = decideGuard(
    opts.profile,
    undefined,
    opts.sandboxEnv && Object.keys(opts.sandboxEnv).length
      ? { provisionedBy: "fresh-database", uri: Object.values(opts.sandboxEnv)[0], evidence: "provisioned for this run" }
      : undefined,
  );
  if (decision.mode !== "mutating") {
    return {
      ran: [],
      skipped: [],
      seeded: false,
      targetCheck: { ok: false, reason: decision.reason },
      warnings: [`No data was prepared: the guard is in ${decision.mode} mode. ${decision.reason}`],
    };
  }

  const targetCheck = await checkDataTarget(opts.profile, opts.sandboxEnv);
  if (!targetCheck.ok) {
    log(`data preparation refused: ${targetCheck.reason}`);
    return {
      ran: [],
      skipped: [],
      seeded: false,
      targetCheck,
      warnings: [
        `No data was prepared. ${targetCheck.reason}`,
        "Mutating axes will run against whatever data already exists, which may be none.",
      ],
    };
  }

  const commands = await discoverDataCommands(opts.profile.project.root);
  if (!commands.length) {
    return {
      ran: [],
      skipped: [],
      seeded: false,
      targetCheck,
      warnings: [
        "This project declares no seed script, so no data was prepared. Tests will run against " +
          "whatever is already there - and against an empty database, an empty list is a pass.",
      ],
    };
  }

  // Order is fixed: reset before migrate before seed. Any other order either
  // seeds into a schema that is then dropped, or migrates over data that the
  // reset is about to remove.
  const order: DataCommandKind[] = ["reset", "migrate", "seed"];
  const queue = order
    .flatMap((kind) => commands.filter((c) => c.kind === kind))
    // One per kind. Two seed scripts are alternatives, not a sequence, and
    // running both is as likely to conflict as to compose.
    .filter((c, i, all) => all.findIndex((o) => o.kind === c.kind) === i);

  let seeded = false;

  for (const command of queue) {
    if (command.destructive && !opts.allowDestructive) {
      skipped.push({
        command,
        reason:
          `"${command.script}" destroys data before recreating it, which needs its own opt-in ` +
          `beyond data.disposable. Pass allowDestructive to enable it.`,
      });
      continue;
    }
    if (command.kind === "migrate" && !opts.allowMigrate) {
      skipped.push({
        command,
        reason: `"${command.script}" changes the schema, which is not testing. Pass allowMigrate to enable it.`,
      });
      continue;
    }

    const startedAt = Date.now();
    log(`running ${command.script}: ${command.command}`);
    const { exitCode, output } = await runCommand(
      command.command,
      path.join(opts.profile.project.root, command.cwd),
      opts.timeoutMs ?? 180_000,
      opts.sandboxEnv,
    );
    const durationMs = Date.now() - startedAt;
    ran.push({ command, exitCode, durationMs });

    if (exitCode !== 0) {
      warnings.push(
        `"${command.script}" exited ${exitCode}, so the data state is not what was intended. ` +
          `Last output: ${output.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 300)}`,
      );
      log(`${command.script} failed with ${exitCode}`);
      // A failed reset leaves an unknown state, and seeding into an unknown
      // state produces data nobody can reason about. Stop.
      break;
    }

    log(`${command.script} finished in ${Math.round(durationMs / 1000)}s`);
    if (command.kind === "seed") seeded = true;
  }

  if (!seeded && !warnings.length) {
    warnings.push(
      "No seed command ran, so the application holds whatever data it already had. " +
        "An assertion that a list is populated may be testing leftovers.",
    );
  }

  return { ran, skipped, seeded, targetCheck, warnings };
}

/* -------------------------------------------------------------- accounting */

export interface FixtureSweep {
  prefix: string;
  /** Fixture-prefixed records the specs reported creating. */
  created: string[];
  /** Still present after the run. Reported, never silently accepted. */
  leaked: string[];
  teardownRan: boolean;
  warnings: string[];
}

/**
 * Account for what a run created.
 *
 * There is no generic way to delete another project's records - that would need
 * the database driver this module deliberately does not have. What there is, is
 * the project's own teardown command, and an honest report of anything the
 * specs said they made. A leak reported is a leak someone can clean up; a leak
 * assumed cleaned is one that accumulates until a run fails for a reason nobody
 * can trace.
 */
export async function sweepFixtures(opts: {
  profile: Profile;
  created?: string[];
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<FixtureSweep> {
  const log = opts.log ?? (() => {});
  const prefix = opts.profile.data.fixturePrefix ?? "clarvis-";
  const warnings: string[] = [];
  const created = opts.created ?? [];

  const teardown = opts.profile.data.teardownCmd?.trim();
  let teardownRan = false;

  if (teardown) {
    const decision = decideGuard(opts.profile);
    const targetCheck = await checkDataTarget(opts.profile);

    if (decision.mode !== "mutating") {
      warnings.push(`Teardown was not run: the guard is in ${decision.mode} mode.`);
    } else if (!targetCheck.ok) {
      warnings.push(`Teardown was not run: ${targetCheck.reason}`);
    } else {
      log(`running teardown: ${teardown}`);
      const { exitCode } = await runCommand(teardown, opts.profile.project.root, opts.timeoutMs ?? 120_000);
      teardownRan = exitCode === 0;
      if (!teardownRan) {
        warnings.push(`Teardown "${teardown}" exited ${exitCode}. Fixtures may remain.`);
      }
    }
  } else if (created.length) {
    warnings.push(
      `${created.length} fixture(s) were created and this project declares no teardown command, ` +
        `so they remain. They all carry the "${prefix}" prefix and can be removed by hand.`,
    );
  }

  return {
    prefix,
    created,
    leaked: teardownRan ? [] : created,
    teardownRan,
    warnings,
  };
}
