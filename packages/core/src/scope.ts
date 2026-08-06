import path from "node:path";
import type { Profile } from "./types.ts";
import type { GitConnector } from "./connectors/git.ts";

/**
 * Feature scoping.
 *
 * Clarvis is a general team that gets pointed at a project, so scoping must
 * learn what a feature is FROM the repository rather than from anything baked
 * into the agents. Three rules follow:
 *
 *   1. All modes produce the same `FeatureScope`. Nothing downstream ever
 *      learns whether the scope came from a diff, a name, or a ticket.
 *   2. Keywords are derived from the project's own artifacts - filenames,
 *      directories, commit subjects. There is no built-in vocabulary, because a
 *      built-in vocabulary is a guess about somebody else's codebase.
 *   3. Conventions are detected or configured, never assumed. The default
 *      branch is discovered; the tracker key format is a pattern with a
 *      sensible default that a project can override.
 */

export type ScopeOrigin = "diff" | "named" | "ticket" | "uncommitted";

export interface FeatureScope {
  key: string;
  title: string;
  origin: ScopeOrigin;
  /** Files considered part of this feature, noise already removed. */
  paths: string[];
  /** Search terms, ranked. Derived from the repo, never from a fixed list. */
  keywords: string[];
  /** Tracker keys found in commit messages, or supplied directly. */
  trackerKeys: string[];
  /** Routes these paths map to, via the profile recon wrote for this project. */
  routes: string[];
  /**
   * How much to trust this scope. A three-file change is a feature; a
   * four-hundred-file change is a refactor or a merge, and calling it one
   * feature would send every downstream fleet chasing noise.
   */
  confidence: "high" | "medium" | "low";
  /** Why these paths and keywords, so a human can correct a bad scope. */
  evidence: string[];
  /** What scoping deliberately dropped. */
  truncation: string[];
}

export interface ScopeConfig {
  /** Extra glob-ish fragments to treat as noise, on top of the defaults. */
  ignorePaths?: string[];
  /** Tracker key shape. Defaults to the ABC-123 convention Jira and Linear share. */
  trackerKeyPattern?: string;
  /** Above this many changed files, the scope is treated as low confidence. */
  maxFiles?: number;
  /** Extra tokens too generic to be useful as search terms in this project. */
  extraStopwords?: string[];
}

/**
 * Generated, vendored and lock artifacts. These appear in almost every diff and
 * describe nothing about intent, so they are removed before anything counts
 * files or derives keywords from them.
 */
const DEFAULT_NOISE = [
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  "coverage/",
  "target/",
  "__snapshots__/",
  ".min.",
  ".map",
  ".lock",
  "lock.json",
  "lock.yaml",
  "go.sum",
  ".generated.",
  ".gen.",
];

/**
 * Tokens that appear in nearly every codebase and would match everything if
 * used as search terms. Filtered for keyword purposes only - a file called
 * `api.ts` is still in scope, its name just makes a useless query.
 */
const DEFAULT_STOPWORDS = new Set([
  "index", "main", "app", "src", "lib", "libs", "util", "utils", "helper", "helpers",
  "type", "types", "test", "tests", "spec", "specs", "e2e", "mock", "mocks", "fixture",
  "fixtures", "api", "service", "services", "component", "components", "page", "pages",
  "controller", "controllers", "model", "models", "route", "routes", "config", "configs",
  "constant", "constants", "style", "styles", "css", "scss", "common", "shared", "core",
  "base", "new", "old", "tmp", "temp", "data", "value", "values", "item", "items", "list",
  "get", "set", "use", "handler", "handlers", "provider", "providers", "context", "hook",
  "hooks", "packages", "apps", "server", "client", "js", "ts", "tsx", "jsx", "json", "md",
  // English function words. A commit subject is prose, so these arrive with it.
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were", "not", "but",
  "all", "any", "can", "its", "into", "over", "under", "when", "what", "which", "while",
  "add", "adds", "added", "update", "updates", "updated", "remove", "removes", "removed",
  "make", "makes", "made", "used", "using", "via", "per", "more", "less", "only", "also",
  "just", "now", "then", "out", "off", "one", "two", "let", "has", "have", "had", "them",
  "their", "there", "some", "such", "than", "who", "why", "how", "does", "did", "done",
  // Manifests and metadata: real files, useless as search terms.
  "package", "lock", "readme", "changelog", "license", "manifest", "dockerfile",
  "env", "yml", "yaml", "toml", "lockfile", "tsconfig", "eslintrc", "gitignore",
]);

/**
 * Release and version-bump commits. They are real commits but describe no
 * feature, so they must never become a feature's title.
 */
const RELEASE_COMMIT =
  /^(chore|build|ci|docs)?\(?release\)?:?\s|^release\b|^v?\d+\.\d+\.\d+\s*$|^bump\b|^merge\b/i;

export function isReleaseCommit(subject: string): boolean {
  return RELEASE_COMMIT.test(subject.trim());
}

/** Conventional-commit prefixes carry no feature meaning. */
const CONVENTIONAL_PREFIX = /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]*\))?!?:\s*/i;

export function isNoisePath(file: string, config: ScopeConfig = {}): boolean {
  const noise = [...DEFAULT_NOISE, ...(config.ignorePaths ?? [])];
  const normalised = file.replace(/\\/g, "/");
  return noise.some((n) => normalised.includes(n));
}

/** camelCase, PascalCase, kebab-case, snake_case and dots all split into words. */
export function tokenize(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 2 && !/^\d+$/.test(t));
}

/**
 * Rank keywords by how often the project itself uses them, weighting words a
 * human typed in a commit subject above words that merely appear in a path.
 */
export function deriveKeywords(
  paths: string[],
  commitSubjects: string[],
  config: ScopeConfig = {},
  limit = 8,
): string[] {
  const stop = new Set([...DEFAULT_STOPWORDS, ...(config.extraStopwords ?? [])]);

  // Counts are per DISTINCT file, never accumulated per occurrence. Three
  // package.json files in a diff are one fact about the change, not three votes
  // for the word "package".
  const inBasename = new Map<string, number>();
  const inDir = new Map<string, number>();
  const inAnyPath = new Map<string, number>();

  const bump = (map: Map<string, number>, token: string) =>
    map.set(token, (map.get(token) ?? 0) + 1);

  for (const file of paths) {
    const normalised = file.replace(/\\/g, "/");
    const parsed = path.parse(normalised);

    for (const t of new Set(tokenize(parsed.name))) bump(inBasename, t);
    for (const t of new Set(tokenize(parsed.dir))) bump(inDir, t);
    for (const t of new Set(tokenize(normalised))) bump(inAnyPath, t);
  }

  const subjectCount = new Map<string, number>();
  for (const subject of commitSubjects) {
    if (isReleaseCommit(subject)) continue;
    const cleaned = subject.replace(CONVENTIONAL_PREFIX, "");
    for (const t of tokenize(cleaned)) bump(subjectCount, t);
  }

  /*
   * Inverse document frequency, in plain terms: a token appearing in most of
   * the changed files describes the project, not the change. A repo name, a
   * workspace directory or a shared suffix will always be ubiquitous, and
   * searching for it returns everything. This is what lets keyword derivation
   * work on a codebase nobody configured it for.
   */
  const ubiquitous = (token: string): boolean =>
    paths.length >= 4 && (inAnyPath.get(token) ?? 0) / paths.length > 0.5;

  const score = new Map<string, number>();
  const candidates = new Set([...inBasename.keys(), ...inDir.keys(), ...subjectCount.keys()]);

  for (const token of candidates) {
    if (stop.has(token)) continue;

    // A word a human typed in a commit subject always survives: they were
    // describing this change on purpose.
    const fromSubject = (subjectCount.get(token) ?? 0) * 4;
    if (!fromSubject && ubiquitous(token)) continue;

    // Path evidence is capped: breadth past a few files adds no information.
    const fromBasename = Math.min(inBasename.get(token) ?? 0, 3) * 3;
    const fromDir = Math.min(inDir.get(token) ?? 0, 3) * 1;

    const total = fromSubject + fromBasename + fromDir;
    if (total > 0) score.set(token, total);
  }

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

export function extractTrackerKeys(texts: string[], config: ScopeConfig = {}): string[] {
  const pattern = new RegExp(config.trackerKeyPattern ?? "\\b([A-Z][A-Z0-9]+-\\d+)\\b", "g");
  const keys = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(pattern)) keys.add(m[1]);
  }
  return [...keys].sort();
}

/**
 * Map changed files onto routes using the profile recon wrote. This is the
 * mechanism by which a general team adapts: the mapping is project data, not
 * agent knowledge.
 */
export function routesForPaths(paths: string[], profile?: Profile): string[] {
  const routes = profile?.surface?.routes ?? [];
  if (!routes.length) return [];

  const changed = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  const matched = new Set<string>();

  for (const route of routes) {
    const source = route.source?.split(":")[0]?.replace(/\\/g, "/");
    if (!source) continue;
    for (const file of changed) {
      if (file === source || file.endsWith(source) || source.endsWith(file)) {
        matched.add(route.path);
      }
    }
  }

  return [...matched].sort();
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "feature"
  );
}

/* ------------------------------------------------------------- resolvers */

export interface ScopeRequest {
  /** Diff-driven: compare against this ref. Omit to auto-detect the base. */
  base?: string;
  head?: string;
  /** Include uncommitted work. Useful before anything is committed. */
  includeUncommitted?: boolean;
  /** Named mode. */
  name?: string;
  keywords?: string[];
  paths?: string[];
  /** Ticket mode. */
  trackerKeys?: string[];
}

export interface ScopeDeps {
  git?: GitConnector;
  profile?: Profile;
  config?: ScopeConfig;
}

/**
 * Dispatches to whichever mode the request implies, most specific first, and
 * always returns the same shape. Diff is the primary path because "I just
 * changed this, check it" is the common case; named and ticket exist for when
 * there is no diff to reason about.
 */
export async function resolveScope(
  request: ScopeRequest,
  deps: ScopeDeps = {},
): Promise<FeatureScope> {
  const config = deps.config ?? {};
  const evidence: string[] = [];
  const truncation: string[] = [];

  let origin: ScopeOrigin = "named";
  let files: string[] = request.paths ?? [];
  let subjects: string[] = [];
  let trackerKeys = request.trackerKeys ?? [];

  const wantsDiff = Boolean(request.base || request.head || request.includeUncommitted) || !request.name;

  if (deps.git && wantsDiff && (await deps.git.isRepo())) {
    const head = request.head ?? "HEAD";
    let base = request.base;

    if (!base) {
      const detected = await deps.git.defaultBaseRef();
      base = detected.ref;
      evidence.push(
        detected.ref
          ? `Base ref ${detected.ref} detected via ${detected.how}.`
          : `No base ref could be detected (${detected.how}).`,
      );
    }

    if (base) {
      const diff = await deps.git.changedFiles(base, head);
      if (diff.ok && diff.data.files.length) {
        origin = "diff";
        files = [...files, ...diff.data.files];
        subjects = (await deps.git.commitsBetween(base, head)).map((c) => c.subject);
        evidence.push(`${diff.data.files.length} file(s) changed between ${base} and ${head}.`);
      }
    }

    if (request.includeUncommitted) {
      const dirty = await deps.git.uncommittedFiles();
      if (dirty.length) {
        if (origin !== "diff") origin = "uncommitted";
        files = [...files, ...dirty];
        evidence.push(`${dirty.length} uncommitted file(s) included.`);
      }
    }
  }

  if (origin === "named" && request.trackerKeys?.length) origin = "ticket";

  // Drop generated and vendored files before anything derives meaning from them.
  const beforeNoise = files.length;
  files = [...new Set(files.map((f) => f.replace(/\\/g, "/")))].filter((f) => !isNoisePath(f, config));
  if (beforeNoise > files.length) {
    truncation.push(`${beforeNoise - files.length} generated or vendored file(s) excluded from scope.`);
  }

  // A very large change is not one feature. Say so rather than pretending.
  const maxFiles = config.maxFiles ?? 60;
  let confidence: FeatureScope["confidence"] = "high";
  if (files.length > maxFiles) {
    confidence = "low";
    truncation.push(
      `${files.length} files in scope, above the ${maxFiles} threshold. This looks like a refactor or a merge rather than one feature; scope it manually with --paths or --feature for a useful result.`,
    );
  } else if (files.length > maxFiles / 3) {
    confidence = "medium";
  }

  if (!files.length && !request.name && !trackerKeys.length) {
    confidence = "low";
    evidence.push("Nothing to scope: no diff, no name, no ticket.");
  }

  // The feature name is human-typed intent, the same class of evidence as a
  // commit subject, so it feeds keyword derivation rather than being decorative.
  // Without this, `--feature "proctor permissions"` yields no search terms at all.
  const humanText = [...subjects, ...(request.name ? [request.name] : [])];
  const derived = deriveKeywords(files, humanText, config);
  const keywords = [...new Set([...(request.keywords ?? []), ...derived])];

  trackerKeys = [...new Set([...trackerKeys, ...extractTrackerKeys(subjects, config)])];

  const routes = routesForPaths(files, deps.profile);
  if (routes.length) evidence.push(`Mapped to ${routes.length} route(s) via the project profile.`);
  else if (files.length && deps.profile?.surface?.routes?.length) {
    evidence.push("No routes matched these files; the profile's route sources may not cover them.");
  }

  const meaningfulSubject = subjects.find((sub) => !isReleaseCommit(sub));
  const title =
    request.name ??
    (meaningfulSubject?.replace(CONVENTIONAL_PREFIX, "") ||
      keywords.slice(0, 3).join(" ") ||
      "unscoped change");

  return {
    key: slugify(request.name ?? title),
    title,
    origin,
    paths: files.sort(),
    keywords,
    trackerKeys,
    routes,
    confidence,
    evidence,
    truncation,
  };
}
