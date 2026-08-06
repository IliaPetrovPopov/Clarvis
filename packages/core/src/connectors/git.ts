import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Local git history connector. No credentials, no network.
 *
 * History is the cheapest high-value oracle source available: commit messages
 * and revert chains are human-authored, they are already in the repo, and past
 * regressions are the single best predictor of where a feature breaks next.
 *
 * Every git invocation goes through `execFile` with an argument array. Feature
 * keywords come from user input and would be a shell-injection hole the moment
 * they were interpolated into a command string.
 */

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  files: string[];
}

export interface GitConnectorResult<T> {
  ok: boolean;
  data: T;
  status: "ok" | "not-a-repo" | "unreachable" | "empty";
  error?: string;
}

/** Commit-message conventions that mark a fix for something that was broken. */
const REGRESSION_PATTERN =
  /\b(fix|fixes|fixed|bug|bugfix|hotfix|revert|reverts|regression|broke|broken|patch)\b/i;

/** Conventional-commit and tracker-key shapes, for linking history to tickets. */
const TRACKER_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

export class GitConnector {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private async git(args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
    try {
      const { stdout } = await run("git", args, {
        cwd: this.cwd,
        maxBuffer: 12 * 1024 * 1024,
        timeout: 20_000,
      });
      return { ok: true, stdout };
    } catch (e) {
      return { ok: false, stdout: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  async isRepo(): Promise<boolean> {
    const r = await this.git(["rev-parse", "--is-inside-work-tree"]);
    return r.ok && r.stdout.trim() === "true";
  }

  /**
   * Commits matching a feature, found two ways: by the files it touches, and by
   * keyword in the message. Both are needed - a feature's commits do not always
   * mention it, and messages that mention it do not always touch its files.
   */
  async findCommits(opts: {
    keywords?: string[];
    paths?: string[];
    limit?: number;
    since?: string;
  }): Promise<GitConnectorResult<GitCommit[]>> {
    if (!(await this.isRepo())) {
      return { ok: false, data: [], status: "not-a-repo", error: `${this.cwd} is not a git repository.` };
    }

    const limit = String(opts.limit ?? 60);
    const SEP = "\x00";
    const format = ["%H", "%h", "%s", "%b", "%an", "%aI"].join("%x00");

    const collect = async (extra: string[]): Promise<GitCommit[]> => {
      const args = ["log", `--max-count=${limit}`, `--pretty=format:${format}%x01`, "--name-only"];
      if (opts.since) args.push(`--since=${opts.since}`);
      args.push(...extra);
      const r = await this.git(args);
      if (!r.ok) return [];
      return parseLog(r.stdout, SEP);
    };

    const byKeyword: GitCommit[][] = [];
    for (const kw of opts.keywords ?? []) {
      // --grep is passed as its own argument; never concatenated into a string.
      byKeyword.push(await collect(["-i", `--grep=${kw}`]));
    }

    const byPath = opts.paths?.length ? await collect(["--", ...opts.paths]) : [];

    const seen = new Set<string>();
    const merged: GitCommit[] = [];
    for (const c of [...byKeyword.flat(), ...byPath]) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      merged.push(c);
    }

    merged.sort((a, b) => (a.date < b.date ? 1 : -1));
    return { ok: true, data: merged, status: merged.length ? "ok" : "empty" };
  }

  /**
   * Plain recent history, unfiltered.
   *
   * `findCommits` searches for a feature and needs keywords or paths to search
   * with - given neither it correctly returns nothing. History mining wants the
   * opposite: every recent commit, so each can be classified on its own merits.
   * Passing a keyword there would pre-select for the vocabulary being tested for.
   */
  async recentCommits(opts: { limit?: number; paths?: string[]; since?: string } = {}): Promise<
    GitConnectorResult<GitCommit[]>
  > {
    if (!(await this.isRepo())) {
      return { ok: false, data: [], status: "not-a-repo", error: `${this.cwd} is not a git repository.` };
    }

    const SEP = "\x00";
    const format = ["%H", "%h", "%s", "%b", "%an", "%aI"].join("%x00");
    const args = [
      "log",
      `--max-count=${opts.limit ?? 200}`,
      `--pretty=format:${format}%x01`,
      "--name-only",
      // Merges carry no diff of their own, so they can never localise a defect.
      "--no-merges",
    ];
    if (opts.since) args.push(`--since=${opts.since}`);
    if (opts.paths?.length) args.push("--", ...opts.paths);

    const r = await this.git(args);
    if (!r.ok) return { ok: false, data: [], status: "unreachable", error: r.error };

    const data = parseLog(r.stdout, SEP);
    return { ok: true, data, status: data.length ? "ok" : "empty" };
  }

  /**
   * Past regressions in this feature. These do not become requirements - they
   * are prior art telling the fleet where to look hardest.
   */
  async findRegressions(opts: {
    keywords?: string[];
    paths?: string[];
    limit?: number;
  }): Promise<GitConnectorResult<Array<{ ref: string; summary: string; fixedAt: string; files: string[] }>>> {
    const commits = await this.findCommits({ ...opts, limit: opts.limit ?? 120 });
    if (!commits.ok) return { ok: false, data: [], status: commits.status, error: commits.error };

    const regressions = commits.data
      .filter((c) => REGRESSION_PATTERN.test(c.subject))
      .map((c) => ({
        ref: c.shortSha,
        summary: c.subject,
        fixedAt: c.date,
        files: c.files,
      }));

    return { ok: true, data: regressions, status: regressions.length ? "ok" : "empty" };
  }

  /** Tracker keys mentioned anywhere in the matched history, for cross-referencing. */
  async findTrackerKeys(opts: { keywords?: string[]; paths?: string[] }): Promise<string[]> {
    const commits = await this.findCommits({ ...opts, limit: 120 });
    if (!commits.ok) return [];
    const keys = new Set<string>();
    for (const c of commits.data) {
      for (const m of `${c.subject}\n${c.body}`.matchAll(TRACKER_KEY_PATTERN)) keys.add(m[1]);
    }
    return [...keys].sort();
  }

  async currentRev(): Promise<string | undefined> {
    const r = await this.git(["rev-parse", "--short", "HEAD"]);
    return r.ok ? r.stdout.trim() || undefined : undefined;
  }

  /**
   * Work out what to diff against, without assuming a project's conventions.
   *
   * A general-purpose team cannot hardcode `main`: plenty of repos use master,
   * develop, trunk, or something else entirely. Strategies run in descending
   * order of authority, and the one that succeeded is reported so the choice is
   * visible rather than magic.
   */
  async defaultBaseRef(): Promise<{ ref?: string; how: string }> {
    // 1. What the remote itself says its default branch is.
    const originHead = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (originHead.ok && originHead.stdout.trim()) {
      return { ref: originHead.stdout.trim(), how: "origin/HEAD" };
    }

    // 2. The upstream this branch actually tracks.
    const upstream = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (upstream.ok && upstream.stdout.trim()) {
      return { ref: upstream.stdout.trim(), how: "tracking branch" };
    }

    // 3. Common names, checked for existence rather than assumed.
    for (const candidate of ["origin/main", "origin/master", "main", "master", "develop", "trunk"]) {
      const exists = await this.git(["rev-parse", "--verify", "--quiet", candidate]);
      if (exists.ok && exists.stdout.trim()) return { ref: candidate, how: `existing ref ${candidate}` };
    }

    return { how: "no base ref could be determined" };
  }

  /**
   * Files changed between two refs. Uses the merge base so a long-lived branch
   * is compared against where it diverged, not against whatever has landed on
   * the base since - otherwise unrelated work shows up as part of the feature.
   */
  async changedFiles(
    base: string,
    head = "HEAD",
  ): Promise<GitConnectorResult<{ files: string[]; mergeBase?: string }>> {
    if (!(await this.isRepo())) {
      return { ok: false, data: { files: [] }, status: "not-a-repo", error: `${this.cwd} is not a git repository.` };
    }

    const mb = await this.git(["merge-base", base, head]);
    const mergeBase = mb.ok ? mb.stdout.trim() || undefined : undefined;

    const r = await this.git(["diff", "--name-only", `${mergeBase ?? base}..${head}`]);
    if (!r.ok) {
      return { ok: false, data: { files: [] }, status: "unreachable", error: r.error };
    }

    const files = r.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
    return { ok: true, data: { files, mergeBase }, status: files.length ? "ok" : "empty" };
  }

  /** Uncommitted work, so a feature can be scoped before anything is committed. */
  async uncommittedFiles(): Promise<string[]> {
    const tracked = await this.git(["diff", "--name-only", "HEAD"]);
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard"]);
    const all = [
      ...(tracked.ok ? tracked.stdout.split("\n") : []),
      ...(untracked.ok ? untracked.stdout.split("\n") : []),
    ];
    return [...new Set(all.map((f) => f.trim()).filter(Boolean))];
  }

  async commitsBetween(base: string, head = "HEAD", limit = 100): Promise<GitCommit[]> {
    const SEP = "\x00";
    const format = ["%H", "%h", "%s", "%b", "%an", "%aI"].join("%x00");
    const r = await this.git([
      "log",
      `--max-count=${limit}`,
      `--pretty=format:${format}%x01`,
      "--name-only",
      `${base}..${head}`,
    ]);
    return r.ok ? parseLog(r.stdout, SEP) : [];
  }
}

/**
 * `--name-only` output interleaves a header with a file list. Records are split
 * on \x01 and fields on NUL, because commit bodies routinely contain newlines
 * and any line-based parse eventually mangles them.
 */
/**
 * Parse `git log --pretty=format:<fields>%x01 --name-only`.
 *
 * The shape is easy to get subtly wrong, and was:
 *
 *     <sha>\0<short>\0<subject>\0<body>\0<author>\0<date>\x01
 *     path/one.ts
 *     path/two.ts
 *
 *     <sha>\0...
 *
 * `--name-only` emits the file list AFTER the record separator, so the paths
 * belonging to commit N arrive at the head of record N+1. Reading them out of
 * the last field instead left `files` empty on every commit - a latent bug that
 * went unnoticed because nothing consumed the field until history mining
 * needed it to decide whether a fix touched testable source.
 */
export function parseLog(stdout: string, sep: string): GitCommit[] {
  const commits: GitCommit[] = [];
  const records = stdout.split("\x01");

  for (const [i, record] of records.entries()) {
    if (!record.trim()) continue;

    // Anything before the first field of this record is the previous commit's
    // file list, so strip it off before splitting.
    const start = record.indexOf(sep);
    if (start === -1) continue;

    const firstFieldStart = record.lastIndexOf("\n", start) + 1;
    const fields = record.slice(firstFieldStart).split(sep);
    if (fields.length < 6) continue;

    const [sha, shortSha, subject, body, author, date] = fields;

    // This commit's files sit at the head of the NEXT record, up to the blank
    // line that precedes the next commit's sha.
    const files: string[] = [];
    const next = records[i + 1];
    if (next) {
      for (const line of next.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // The next commit's sha line ends the file list.
        if (trimmed.includes(sep)) break;
        files.push(trimmed);
      }
    }

    commits.push({
      sha: sha.replace(/^\n+/, "").trim(),
      shortSha: shortSha.trim(),
      subject: subject.trim(),
      body: body.trim(),
      author: author.trim(),
      date: date.trim(),
      files,
    });
  }

  return commits;
}
