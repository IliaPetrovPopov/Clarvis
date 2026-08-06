import { readFile } from "node:fs/promises";
import type { Axis, Finding, Run } from "./types.ts";

/**
 * Scoring a run against a known set of seeded bugs.
 *
 * This exists so no detection-rate claim can be made without one. "Finds real
 * bugs" is the easiest sentence in the world to write and the hardest to earn,
 * and a fleet that reports six findings against an app with six seeded bugs has
 * proved nothing at all unless they are the same six.
 *
 * Two properties matter more than the number it produces:
 *
 *   1. A finding that matches no seeded bug is reported as UNMATCHED, never as
 *      a false positive. The target may have bugs nobody seeded - the demo app
 *      does - and calling those false positives would train the whole system
 *      toward reporting less.
 *
 *   2. Matching is by declared signal strings, which is crude and is stated as
 *      crude. A benchmark that quietly used a model to decide whether a finding
 *      "counts" would be measuring that model, not the fleet.
 */

export interface SeededBug {
  id: string;
  axis: Axis;
  title: string;
  where?: string;
  /** Lowercase substrings; any one appearing in a finding is a match. */
  signals: string[];
  severity?: string;
  note?: string;
}

export interface AnswerKey {
  target: string;
  bugs: SeededBug[];
}

export interface BenchmarkResult {
  target: string;
  detected: Array<{ bug: SeededBug; finding: Finding; matchedOn: string }>;
  missed: SeededBug[];
  /** Findings that match no seeded bug. Needs a human, not a verdict. */
  unmatched: Finding[];
  /** Bugs whose axis never ran. Not a miss - the fleet was never asked. */
  notExercised: SeededBug[];
  detectionRate: number;
  /** How the number was arrived at, so it cannot be quoted without its caveats. */
  caveats: string[];
}

export async function loadAnswerKey(file: string): Promise<AnswerKey> {
  const raw = JSON.parse(await readFile(file, "utf8")) as AnswerKey;
  if (!Array.isArray(raw.bugs) || !raw.bugs.length) {
    throw new Error(`${file} has no bugs[] array. An empty answer key scores everything as perfect.`);
  }
  for (const bug of raw.bugs) {
    if (!bug.signals?.length) {
      throw new Error(`Bug ${bug.id} declares no signals, so it can never be matched.`);
    }
  }
  return raw;
}

/** Everything about a finding a signal could reasonably appear in. */
function haystack(finding: Finding): string {
  return [
    finding.title,
    finding.actual,
    finding.expected,
    finding.steps?.join(" "),
    finding.locator,
    finding.route,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function scoreRun(run: Run, key: AnswerKey): BenchmarkResult {
  const detected: BenchmarkResult["detected"] = [];
  const missed: SeededBug[] = [];
  const notExercised: SeededBug[] = [];
  const claimed = new Set<string>();

  // An axis counts as exercised only if it actually ran. Skipped and errored
  // axes are not misses: the fleet was never given the chance.
  const ranAxes = new Set(
    run.axes.filter((a) => a.status === "done").map((a) => a.key),
  );

  for (const bug of key.bugs) {
    if (!ranAxes.has(bug.axis)) {
      notExercised.push(bug);
      continue;
    }

    const hit = run.findings.find((f) => {
      if (claimed.has(f.id)) return false;
      const text = haystack(f);
      return bug.signals.some((s) => text.includes(s.toLowerCase()));
    });

    if (hit) {
      const matchedOn = bug.signals.find((s) => haystack(hit).includes(s.toLowerCase()))!;
      claimed.add(hit.id);
      detected.push({ bug, finding: hit, matchedOn });
    } else {
      missed.push(bug);
    }
  }

  const unmatched = run.findings.filter((f) => !claimed.has(f.id));
  const exercised = detected.length + missed.length;

  const caveats = [
    "Matching is by declared signal substrings, not by meaning. A finding that describes the right bug in unexpected words counts as a miss.",
    "Unmatched findings are NOT counted as false positives - the target may hold bugs nobody seeded.",
  ];
  if (notExercised.length) {
    caveats.push(
      `${notExercised.length} seeded bug(s) sit on axes that did not run (${[...new Set(notExercised.map((b) => b.axis))].join(", ")}). They are excluded from the rate.`,
    );
  }
  if (!exercised) {
    caveats.push("No seeded bug was on an axis that ran, so the rate is meaningless.");
  }

  return {
    target: key.target,
    detected,
    missed,
    unmatched,
    notExercised,
    detectionRate: exercised ? detected.length / exercised : 0,
    caveats,
  };
}

/** Plain-text report. Deliberately leads with what was missed. */
export function describeBenchmark(result: BenchmarkResult): string[] {
  const lines: string[] = [];
  const pct = Math.round(result.detectionRate * 100);

  lines.push(
    `${result.detected.length}/${result.detected.length + result.missed.length} seeded bugs detected (${pct}%) on ${result.target}`,
  );

  for (const bug of result.missed) {
    lines.push(`  MISSED     [${bug.id}] ${bug.axis} - ${bug.title}`);
    if (bug.note) lines.push(`             ${bug.note}`);
  }
  for (const bug of result.notExercised) {
    lines.push(`  not run    [${bug.id}] ${bug.axis} - ${bug.title}`);
  }
  for (const d of result.detected) {
    lines.push(`  found      [${d.bug.id}] ${d.bug.axis} - matched on "${d.matchedOn}"`);
  }
  for (const f of result.unmatched) {
    lines.push(`  unmatched  ${f.axis} - ${f.title.slice(0, 76)}`);
  }

  lines.push("");
  for (const c of result.caveats) lines.push(`  caveat     ${c}`);

  return lines;
}
