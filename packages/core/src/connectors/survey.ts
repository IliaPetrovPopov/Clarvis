import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isNoisePath, type ScopeConfig } from "../scope.ts";

/**
 * Project survey: the raw material recon reasons over.
 *
 * Deliberately code, not an agent. What a project *is* - its manifests, its
 * compose file, its env template - is a matter of fact, and facts should be
 * gathered by something that cannot embellish. The agents downstream get this
 * text and nothing else, so anything they claim about the project can be traced
 * back to a file and a line.
 *
 * The host extraction below matters more than it looks: it is the only part of
 * recon that finds dangerous targets without asking a model. If the safety agent
 * fails, times out, or is talked into silence, these hosts are still added to
 * the deny-list.
 */

export interface SurveyedFile {
  /** Repo-relative, forward slashes. */
  path: string;
  kind: SurveyKind;
  content: string;
  /** True when the file was cut short for size. */
  truncated: boolean;
}

export type SurveyKind =
  | "manifest"
  | "compose"
  | "ci"
  | "env"
  | "config"
  | "docs"
  | "script";

export interface DiscoveredHost {
  host: string;
  /** Where it was found: "docker-compose.yml:14". */
  ref: string;
  /** The line it came from, trimmed. Lets a human judge without opening the file. */
  line: string;
}

export interface Survey {
  projectRoot: string;
  files: SurveyedFile[];
  hosts: DiscoveredHost[];
  /** Scripts from package.json, which is where boot commands nearly always live. */
  scripts: Record<string, string>;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  filesScanned: number;
  truncation: string[];
}

/**
 * Files that state how a project runs. Matched on basename, so nested services
 * in a monorepo are picked up too.
 */
const INTERESTING: Array<{ test: RegExp; kind: SurveyKind }> = [
  { test: /^package\.json$/i, kind: "manifest" },
  { test: /^(pyproject\.toml|requirements\.txt|Gemfile|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|composer\.json)$/i, kind: "manifest" },
  { test: /^docker-compose(\.[\w.-]+)?\.ya?ml$/i, kind: "compose" },
  { test: /^Dockerfile(\.[\w.-]+)?$/i, kind: "compose" },
  { test: /^\.env(\.[\w.-]+)?$/i, kind: "env" },
  { test: /^(Makefile|Justfile|Taskfile\.ya?ml|Procfile)$/i, kind: "script" },
  { test: /^(vite|next|nuxt|webpack|playwright|jest|vitest)\.config\.[cm]?[jt]s$/i, kind: "config" },
  { test: /^(README|CONTRIBUTING|SETUP|DEVELOPMENT|CLAUDE|AGENTS)\.(md|markdown|txt|rst)$/i, kind: "docs" },
];

const CI_DIR = /(^|\/)\.(github\/workflows|gitlab-ci|circleci)(\/|$)/;

/**
 * A real secret in a `.env` must never reach a model. `.env.example` and friends
 * are templates and are safe, but the live file is not, and recon has no reason
 * to read it: the template states the same variable names.
 */
export function isLiveEnvFile(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  if (!base.startsWith(".env")) return false;
  return !/\.(example|sample|template|dist|defaults?)$/.test(base);
}

/**
 * Hosts, from any text. Catches URLs, bare host:port authorities, and the
 * `mongodb://user:pass@host` shape that is the single most dangerous string a
 * QA tool can be pointed at.
 *
 * Credentials inside a matched URL are dropped: the host is what the guard
 * needs, and carrying the password into a profile would put it on disk.
 */
const HOST_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@"']*@)?([a-z0-9._-]+(?::\d{2,5})?)/gi,
  /\b((?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?)\b/g,
  /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|dev|app|co|cloud|local|internal)(?::\d{2,5})?)\b/gi,
];

const IGNORED_HOSTS = new Set([
  "registry.npmjs.org",
  "npmjs.org",
  "github.com",
  "gitlab.com",
  "schema.org",
  "www.w3.org",
  "json-schema.org",
  "example.com",
  "0.0.0.0",
  "127.0.0.1",
]);

export function extractHosts(text: string, ref: string): DiscoveredHost[] {
  const found = new Map<string, DiscoveredHost>();
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue;

    for (const pattern of HOST_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const host = match[1]?.toLowerCase();
        if (!host) continue;
        const bare = host.split(":")[0];
        if (IGNORED_HOSTS.has(bare)) continue;
        // Version strings like "1.2.3" match the IPv4 shape closely enough to be
        // worth excluding by octet range. Only the address is range-checked - a
        // port is legitimately far above 255, and checking it here once silently
        // discarded every `ip:port` connection string in a compose file.
        if (/^\d/.test(bare) && bare.split(".").some((p) => Number(p) > 255)) continue;
        if (found.has(host)) continue;

        found.set(host, {
          host,
          ref: `${ref}:${i + 1}`,
          // Anything after "=" or ":" may be a secret, so only the key side of
          // an assignment is kept alongside the host itself.
          line: line.trim().slice(0, 160).replace(/(:\/\/)[^\s/@"']*@/, "$1"),
        });
      }
    }
  }

  return [...found.values()];
}

function classify(rel: string): SurveyKind | undefined {
  if (CI_DIR.test(rel)) return "ci";
  const base = path.basename(rel);
  for (const entry of INTERESTING) {
    if (entry.test.test(base)) return entry.kind;
  }
  return undefined;
}

async function walk(
  root: string,
  projectRoot: string,
  config: ScopeConfig,
  out: Array<{ full: string; rel: string; kind: SurveyKind }>,
  budget: { files: number },
  depth = 0,
): Promise<void> {
  if (depth > 5 || budget.files <= 0) return;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (budget.files <= 0) return;
    const full = path.join(root, entry.name);
    const rel = path.relative(projectRoot, full).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      // `.github` holds CI, which states how the project is built and started.
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (isNoisePath(full, config)) continue;
      await walk(full, projectRoot, config, out, budget, depth + 1);
      continue;
    }

    const kind = classify(rel);
    if (!kind) continue;
    if (isLiveEnvFile(rel)) continue;

    budget.files--;
    out.push({ full, rel, kind });
  }
}

/** Binary and generated files, which cannot hold a human-authored credential. */
const UNSEARCHABLE = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mp3|wasm|lock|map)$/i;

/**
 * Does this literal string actually exist somewhere in the project?
 *
 * Recon's agents can read any file, so verifying what they report has to reach
 * just as far - checking only the surveyed files would reject every real
 * credential that lives in a seed script, and that failure looks exactly like
 * the fabrication this check exists to catch.
 *
 * Case-insensitive and whitespace-tolerant, because a credential quoted out of
 * a table or a fenced block picks up formatting that does not change what it is.
 */
export async function findLiteral(
  projectRoot: string,
  literal: string,
  opts: { config?: ScopeConfig; maxFiles?: number; maxBytes?: number } = {},
): Promise<{ found: boolean; ref?: string; filesSearched: number }> {
  const needle = literal.trim().toLowerCase();
  if (needle.length < 3) return { found: false, filesSearched: 0 };

  const budget = { files: opts.maxFiles ?? 4000, bytes: opts.maxBytes ?? 40_000_000 };
  const config = opts.config ?? {};

  const search = async (dir: string, depth: number): Promise<string | undefined> => {
    if (depth > 8 || budget.files <= 0 || budget.bytes <= 0) return undefined;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (budget.files <= 0 || budget.bytes <= 0) return undefined;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        if (isNoisePath(full, config)) continue;
        const hit = await search(full, depth + 1);
        if (hit) return hit;
        continue;
      }

      if (UNSEARCHABLE.test(entry.name)) continue;
      // A live .env is excluded here for the same reason it is excluded from the
      // survey: nothing in recon should read real secrets.
      const rel = path.relative(projectRoot, full).replace(/\\/g, "/");
      if (isLiveEnvFile(rel)) continue;

      budget.files--;
      let content: string;
      try {
        const info = await stat(full);
        if (info.size > 2_000_000) continue;
        budget.bytes -= info.size;
        content = await readFile(full, "utf8");
      } catch {
        continue;
      }

      const lower = content.toLowerCase();
      const at = lower.indexOf(needle);
      if (at !== -1) {
        const line = content.slice(0, at).split("\n").length;
        return `${rel}:${line}`;
      }
    }
    return undefined;
  };

  const ref = await search(projectRoot, 0);
  return { found: Boolean(ref), ref, filesSearched: (opts.maxFiles ?? 4000) - budget.files };
}

export interface SurveyOptions {
  projectRoot: string;
  config?: ScopeConfig;
  /** Cap on files read. Generous: these are small and this runs once. */
  maxFiles?: number;
  /** Per-file character cap. */
  maxChars?: number;
}

export async function surveyProject(opts: SurveyOptions): Promise<Survey> {
  const { projectRoot } = opts;
  const maxChars = opts.maxChars ?? 12_000;
  const truncation: string[] = [];

  try {
    await stat(projectRoot);
  } catch {
    throw new Error(`Project root ${projectRoot} does not exist.`);
  }

  const candidates: Array<{ full: string; rel: string; kind: SurveyKind }> = [];
  const budget = { files: opts.maxFiles ?? 60 };
  await walk(projectRoot, projectRoot, opts.config ?? {}, candidates, budget);

  if (budget.files <= 0) {
    truncation.push(
      `Stopped after ${opts.maxFiles ?? 60} files. Deeply nested services may not have been surveyed.`,
    );
  }

  // Shallow first: a root package.json describes the project, one nested six
  // levels down describes a fragment of it.
  candidates.sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || a.rel.localeCompare(b.rel));

  const files: SurveyedFile[] = [];
  const hosts = new Map<string, DiscoveredHost>();
  let scripts: Record<string, string> = {};
  let packageManager: Survey["packageManager"];

  for (const c of candidates) {
    let content: string;
    try {
      content = await readFile(c.full, "utf8");
    } catch {
      continue;
    }

    const truncated = content.length > maxChars;
    files.push({
      path: c.rel,
      kind: c.kind,
      content: truncated ? `${content.slice(0, maxChars)}\n... [truncated]` : content,
      truncated,
    });

    // Host extraction reads the FULL file, not the truncated copy: a production
    // connection string on line 900 is exactly the one that matters.
    for (const h of extractHosts(content, c.rel)) {
      if (!hosts.has(h.host)) hosts.set(h.host, h);
    }

    if (c.kind === "manifest" && path.basename(c.rel) === "package.json") {
      try {
        const pkg = JSON.parse(content) as {
          scripts?: Record<string, string>;
          packageManager?: string;
        };
        // Root manifest wins; nested ones fill gaps.
        scripts = { ...(pkg.scripts ?? {}), ...scripts };
        if (!packageManager && typeof pkg.packageManager === "string") {
          const name = pkg.packageManager.split("@")[0];
          if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
            packageManager = name;
          }
        }
      } catch {
        truncation.push(`${c.rel} is not valid JSON and was not parsed for scripts.`);
      }
    }
  }

  if (!packageManager) {
    for (const [lock, name] of [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
      ["package-lock.json", "npm"],
    ] as const) {
      try {
        await stat(path.join(projectRoot, lock));
        packageManager = name;
        break;
      } catch {
        /* not this one */
      }
    }
  }

  return {
    projectRoot,
    files,
    hosts: [...hosts.values()],
    scripts,
    packageManager,
    filesScanned: files.length,
    truncation,
  };
}
