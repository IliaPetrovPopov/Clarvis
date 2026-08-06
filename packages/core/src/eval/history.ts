import type { GitCommit, GitConnector } from "../connectors/git.ts";
import { isMutableSource } from "./mutationRun.ts";

/**
 * Mining real bugs out of a project's own history.
 *
 * The seeded-bug benchmark has a problem no amount of care fixes: I wrote both
 * the bugs and the axes that look for them. Scoring well on it mostly proves
 * the two agree.
 *
 * A bug-fix commit is evidence nobody arranged. Someone hit a real defect,
 * wrote a real fix, and described it in their own words - years before this
 * tool existed. Checking out the commit BEFORE the fix gives a codebase with a
 * known defect at a known location, and the fix message is the ground truth.
 *
 * This is roughly the SZZ setup, minus the blame step: SZZ traces a fix back to
 * the commit that introduced it, which needs line-level blame and is wrong
 * often enough to be its own research problem. The parent of the fix is enough
 * here, because the question is only "does the tester find what this fix
 * repaired", not "who broke it".
 *
 * Everything below is heuristic and says so. A candidate list is a starting
 * point for a human, not a labelled dataset.
 */

export interface BugFix {
  /** The commit that repaired it. */
  sha: string;
  shortSha: string;
  /** The state to test: the commit immediately before the fix. */
  parentSha?: string;
  subject: string;
  body: string;
  date: string;
  /** Files the fix touched. Where the defect was. */
  files: string[];
  /** Why this looked like a bug fix. Shown, so the judgement can be checked. */
  signals: string[];
  /** 0 to 1. Heuristic confidence, never a certainty. */
  confidence: number;
}

export interface HistoryMineResult {
  candidates: BugFix[];
  scanned: number;
  /** What was excluded and why. A quiet filter is an invisible bias. */
  rejected: Array<{ shortSha: string; subject: string; why: string }>;
  notes: string[];
}

/**
 * Phrases that indicate a repair rather than a feature.
 *
 * Conventional-commit `fix:` is the strongest single signal and is checked
 * separately; the rest catch repositories that never adopted it.
 */
const FIX_PHRASES = [
  "fix",
  "bug",
  "regression",
  "broken",
  "incorrect",
  "wrong",
  "crash",
  "fails",
  "failing",
  "error",
  "issue",
  "defect",
  "patch",
  "resolve",
  "correct",
  "prevent",
  "guard against",
];

/**
 * Commits that mention a fix but are not one, or are one nobody could test.
 *
 * Reverts and merges are excluded because the defect is not where the diff is;
 * releases and dependency bumps because there is no behaviour to test.
 */
const NOT_A_BUGFIX: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^revert\b/i, why: "A revert. The defect is not in this diff." },
  { pattern: /^merge\b/i, why: "A merge commit. It contains no fix of its own." },
  { pattern: /^(chore\(release\)|release|bump|v?\d+\.\d+\.\d+$)/i, why: "A release commit." },
  { pattern: /^(chore|docs|style|ci|build|test)(\(|:)/i, why: "Not a behaviour change." },
  { pattern: /\b(typo|lint|format|prettier|whitespace|rename)\b/i, why: "Cosmetic." },
  { pattern: /\b(bump|upgrade|update) (dep|dependenc|package|version)/i, why: "A dependency change." },
];

export function classifyCommit(commit: Pick<GitCommit, "subject" | "body" | "files">): {
  isBugFix: boolean;
  signals: string[];
  confidence: number;
  why?: string;
} {
  const subject = commit.subject.trim();
  const haystack = `${subject}\n${commit.body}`.toLowerCase();

  for (const { pattern, why } of NOT_A_BUGFIX) {
    if (pattern.test(subject)) return { isBugFix: false, signals: [], confidence: 0, why };
  }

  const signals: string[] = [];
  let confidence = 0;

  // A conventional `fix:` prefix is an explicit statement by the author.
  if (/^fix(\([^)]*\))?!?:/i.test(subject)) {
    signals.push("conventional fix: prefix");
    confidence += 0.5;
  }

  const matched = FIX_PHRASES.filter((p) => haystack.includes(p));
  if (matched.length) {
    signals.push(`mentions ${matched.slice(0, 3).join(", ")}`);
    confidence += Math.min(0.25, matched.length * 0.08);
  }

  // An issue reference means someone reported it, which is the best evidence a
  // commit message can carry that a real defect existed.
  if (/#\d+|\b[A-Z]{2,10}-\d+\b/.test(`${subject} ${commit.body}`)) {
    signals.push("references an issue");
    confidence += 0.2;
  }

  const source = commit.files.filter(isMutableSource);
  if (!source.length) {
    return { isBugFix: false, signals, confidence: 0, why: "Touches no testable source file." };
  }

  // A sprawling diff is a refactor with a fix inside it at best; the defect
  // cannot be localised, so it makes a poor benchmark case.
  if (commit.files.length > 20) {
    return {
      isBugFix: false,
      signals,
      confidence: 0,
      why: `Touches ${commit.files.length} files. Too broad to localise a defect.`,
    };
  }

  // A tight diff is a strong signal on its own: someone changed a few lines on
  // purpose.
  if (commit.files.length <= 3) {
    signals.push(`narrow diff (${commit.files.length} file(s))`);
    confidence += 0.15;
  }

  // An explaining body usually means the author thought it worth explaining.
  if (commit.body.trim().length > 80) {
    signals.push("explains itself");
    confidence += 0.1;
  }

  return { isBugFix: confidence >= 0.4, signals, confidence: Math.min(1, confidence) };
}

export interface MineOptions {
  git: GitConnector;
  /** How far back to look. */
  limit?: number;
  /** Only commits touching these paths. */
  paths?: string[];
  since?: string;
  /** Minimum heuristic confidence to keep. */
  minConfidence?: number;
  maxCandidates?: number;
}

export async function mineBugFixes(opts: MineOptions): Promise<HistoryMineResult> {
  const notes: string[] = [];
  const rejected: HistoryMineResult["rejected"] = [];

  if (!(await opts.git.isRepo())) {
    return {
      candidates: [],
      scanned: 0,
      rejected: [],
      notes: ["Not a git repository, so there is no history to mine."],
    };
  }

  // Deliberately the unfiltered log, not a keyword search: searching for "fix"
  // would pre-select for the exact vocabulary the classifier then scores.
  const found = await opts.git.recentCommits({
    limit: opts.limit ?? 400,
    paths: opts.paths,
    since: opts.since,
  });

  if (!found.ok) {
    return { candidates: [], scanned: 0, rejected: [], notes: [found.error ?? "Could not read history."] };
  }

  const minConfidence = opts.minConfidence ?? 0.4;
  const candidates: BugFix[] = [];

  for (const commit of found.data) {
    const verdict = classifyCommit(commit);

    if (!verdict.isBugFix || verdict.confidence < minConfidence) {
      rejected.push({
        shortSha: commit.shortSha,
        subject: commit.subject.slice(0, 70),
        why: verdict.why ?? `Confidence ${verdict.confidence.toFixed(2)} below ${minConfidence}.`,
      });
      continue;
    }

    candidates.push({
      sha: commit.sha,
      shortSha: commit.shortSha,
      parentSha: `${commit.sha}~1`,
      subject: commit.subject,
      body: commit.body,
      date: commit.date,
      files: commit.files.filter(isMutableSource),
      signals: verdict.signals,
      confidence: verdict.confidence,
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || b.date.localeCompare(a.date));
  const capped = candidates.slice(0, opts.maxCandidates ?? 40);

  if (candidates.length > capped.length) {
    notes.push(`${candidates.length} candidates found, ${capped.length} kept.`);
  }

  notes.push(
    "These are heuristic candidates, not a labelled dataset. Read the commit before " +
      "treating any of them as ground truth - a message that says 'fix' is a claim by its author, not a verified defect.",
  );

  return { candidates: capped, scanned: found.data.length, rejected, notes };
}

/**
 * A benchmark case: the state to check out, and what the fix claims to repair.
 *
 * `expected` is the author's own words rather than anything generated. The point
 * of using history is that the ground truth was written by someone who was not
 * thinking about this tool.
 */
export interface HistoryCase {
  id: string;
  checkout: string;
  fixedAt: string;
  expected: string;
  files: string[];
  confidence: number;
  signals: string[];
}

export function toCases(result: HistoryMineResult): HistoryCase[] {
  return result.candidates.map((c) => ({
    id: c.shortSha,
    checkout: c.parentSha ?? `${c.sha}~1`,
    fixedAt: c.sha,
    expected: [c.subject, c.body.trim()].filter(Boolean).join("\n").slice(0, 800),
    files: c.files,
    confidence: c.confidence,
    signals: c.signals,
  }));
}
