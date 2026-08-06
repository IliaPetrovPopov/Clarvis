import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding, Run } from "./types.ts";

/**
 * Keeping the specs that earned their place.
 *
 * CRUCIBLE authors specs into a scratch directory, runs them, and the next run
 * overwrites them. That throws away the single most valuable artifact the whole
 * system produces: a spec that caught a real bug is a regression test, and a
 * regression test is the thing that stops the bug coming back.
 *
 * Promotion is what makes the tool compound. After twenty runs you either have
 * twenty deleted scratch files, or twenty real tests in the repository. The
 * difference is this module.
 *
 * Two rules:
 *
 *   1. ONLY SPECS THAT PROVED SOMETHING. A spec is promoted when it produced a
 *      finding that survived triage. An authored spec that found nothing may
 *      still be wrong, and filling someone's suite with unproven generated
 *      tests is how a team learns to ignore the directory.
 *
 *   2. NEVER OVERWRITE A HUMAN'S FILE. Promotion writes to a dedicated
 *      directory with a stable name per finding, and refuses if the target
 *      exists with different content unless told to replace it.
 */

export interface PromotionCandidate {
  finding: Finding;
  specFile: string;
  /** Where it would be written, relative to the project root. */
  target: string;
  /** Why it is worth keeping. */
  reason: string;
}

export interface PromotionResult {
  written: Array<{ target: string; finding: string }>;
  skipped: Array<{ target: string; why: string }>;
  notes: string[];
}

export interface PromoteOptions {
  projectRoot: string;
  run: Run;
  specDir: string;
  /** Where promoted specs live. Relative to the project root. */
  targetDir?: string;
  /** Overwrite an existing promoted file whose content differs. */
  replace?: boolean;
  /** Promote findings at this tier or better. */
  minTier?: Finding["tier"];
  now?: Date;
}

const TIER_RANK = { CONFIRMED: 3, PLAUSIBLE: 2, QUESTION: 1, DISCARDED: 0 } as const;

/** A stable, readable filename for a finding's spec. */
export function promotedName(finding: Finding): string {
  const slug = finding.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${finding.axis}-${slug || "finding"}.spec.ts`;
}

/**
 * Which of this run's specs are worth keeping.
 *
 * Deliberately per-finding rather than per-spec-file: a file may contain ten
 * tests of which one caught something, and promoting the whole file would bring
 * nine unproven tests with it.
 */
export function candidates(
  run: Run,
  specDir: string,
  minTier: Finding["tier"] = "CONFIRMED",
): PromotionCandidate[] {
  const floor = TIER_RANK[minTier];
  const seen = new Set<string>();
  const out: PromotionCandidate[] = [];

  for (const finding of run.findings) {
    if (TIER_RANK[finding.tier] < floor) continue;

    const specFile = finding.evidence.specFile;
    if (!specFile) continue;

    const target = promotedName(finding);
    // Two findings from the same spec would otherwise write the same file twice.
    if (seen.has(target)) continue;
    seen.add(target);

    out.push({
      finding,
      specFile: path.isAbsolute(specFile) ? specFile : path.join(specDir, specFile),
      target,
      reason:
        finding.tier === "CONFIRMED"
          ? `Confirmed ${finding.severity} finding: reproduced ${finding.determinism?.failures ?? "?"}/${finding.determinism?.runs ?? "?"} times.`
          : `${finding.tier} ${finding.severity} finding. Kept as a regression test, unverified.`,
    });
  }

  return out;
}

/**
 * The header written above a promoted spec.
 *
 * It exists so that whoever finds this file in six months knows what it is,
 * what it caught, and what it is entitled to claim - including when the answer
 * is "nothing written down said this was wrong".
 */
export function promotionHeader(finding: Finding, runId: string, now: Date): string {
  const lines = [
    "/**",
    ` * Regression test, promoted from a Clarvis run.`,
    " *",
    ` * Caught: ${finding.title}`,
    ` * Axis:   ${finding.axis}   Severity: ${finding.severity}   Tier: ${finding.tier}`,
    ` * Run:    ${runId} on ${now.toISOString().slice(0, 10)}`,
    " *",
  ];

  if (finding.oracle.quote) {
    lines.push(` * Basis (${finding.oracle.type}${finding.oracle.citation ? `, ${finding.oracle.citation}` : ""}):`);
    for (const line of finding.oracle.quote.split("\n").slice(0, 4)) {
      lines.push(` *   ${line.slice(0, 92)}`);
    }
  } else {
    lines.push(
      ` * Basis: ${finding.oracle.type}. Nothing written down states this behaviour,`,
      " * so this test encodes an observation rather than a requirement.",
    );
  }

  lines.push(
    " *",
    " * This file is now yours. It is not regenerated and not overwritten - edit it,",
    " * rename it, or delete it as you would any other test.",
    " */",
    "",
  );

  return lines.join("\n");
}

export async function promote(opts: PromoteOptions): Promise<PromotionResult> {
  const now = opts.now ?? new Date();
  const targetDir = opts.targetDir ?? path.join("tests", "clarvis");
  const absoluteTargetDir = path.join(opts.projectRoot, targetDir);

  const written: PromotionResult["written"] = [];
  const skipped: PromotionResult["skipped"] = [];
  const notes: string[] = [];

  const picks = candidates(opts.run, opts.specDir, opts.minTier ?? "CONFIRMED");

  if (!picks.length) {
    notes.push(
      opts.run.findings.length
        ? `No finding reached ${opts.minTier ?? "CONFIRMED"}, so no spec was promoted. An unproven generated ` +
          `test is not worth adding to a suite.`
        : "The run produced no findings, so there is nothing to promote.",
    );
    return { written, skipped, notes };
  }

  await mkdir(absoluteTargetDir, { recursive: true });

  for (const pick of picks) {
    const source = await readFile(pick.specFile, "utf8").catch(() => undefined);
    if (source === undefined) {
      skipped.push({ target: pick.target, why: `Its spec file is gone (${pick.specFile}).` });
      continue;
    }

    const body = promotionHeader(pick.finding, opts.run.runId, now) + source;
    const absolute = path.join(absoluteTargetDir, pick.target);

    const existing = await readFile(absolute, "utf8").catch(() => undefined);
    if (existing !== undefined) {
      if (existing === body) {
        skipped.push({ target: pick.target, why: "Already promoted, unchanged." });
        continue;
      }
      if (!opts.replace) {
        // The file may have been edited by hand since. Overwriting it silently
        // would delete someone's work.
        skipped.push({
          target: pick.target,
          why: "Already exists with different content. It may have been edited; pass --replace to overwrite.",
        });
        continue;
      }
    }

    await writeFile(absolute, body, "utf8");
    written.push({ target: path.join(targetDir, pick.target), finding: pick.finding.title });
  }

  if (written.length) {
    notes.push(
      `${written.length} spec(s) promoted to ${targetDir}. They are ordinary Playwright tests now - ` +
        `commit them, edit them, or delete them.`,
    );
  }

  return { written, skipped, notes };
}

/** What is already promoted, so a run can say what it is adding to. */
export async function listPromoted(projectRoot: string, targetDir = path.join("tests", "clarvis")): Promise<string[]> {
  try {
    const entries = await readdir(path.join(projectRoot, targetDir));
    return entries.filter((f) => f.endsWith(".spec.ts")).sort();
  } catch {
    return [];
  }
}
