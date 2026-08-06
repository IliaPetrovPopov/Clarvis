import { FLEETS, type FleetKey } from "../fleets.ts";
import type { Finding, Run } from "../types.ts";

/**
 * Measuring the system rather than the code.
 *
 * Three questions I had been answering by assertion:
 *
 *   - Does each fleet earn its cost? (ablation)
 *   - Is a single run's number stable enough to quote? (variance)
 *   - Does CONFIRMED mean anything? (calibration)
 *
 * All three take runs as input and are pure. Nothing here executes anything:
 * the orchestration lives in the CLI, so these can be tested and re-analysed
 * without spending a plan allowance on every change.
 */

/* --------------------------------------------------------------- ablation */

export interface AblationArm {
  /** The fleet that was removed, or undefined for the full configuration. */
  removed?: FleetKey;
  label: string;
  runs: Run[];
}

export interface AblationRow {
  label: string;
  removed?: FleetKey;
  runsObserved: number;
  meanFindings: number;
  meanConfirmed: number;
  meanUsd: number;
  /** Findings lost against the full configuration. Negative means more found. */
  deltaFindings?: number;
  deltaConfirmed?: number;
  deltaUsd?: number;
  /** Stated when the arm is too small to conclude from. */
  caveat?: string;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const usdOf = (run: Run): number =>
  (run.agentRuns ?? []).reduce((sum, a) => sum + (a.usdEstimate ?? 0), 0);

const confirmedOf = (run: Run): number => run.findings.filter((f) => f.tier === "CONFIRMED").length;

/**
 * What each fleet contributes, measured by removing it.
 *
 * The comparison is against the full configuration, so a fleet that changes
 * nothing shows a delta of zero - which is the answer, and worth knowing.
 */
export function compareAblations(arms: AblationArm[]): {
  rows: AblationRow[];
  notes: string[];
} {
  const notes: string[] = [];
  const full = arms.find((a) => !a.removed);

  if (!full) {
    notes.push("No full-configuration arm, so every delta is missing: there is nothing to compare against.");
  }

  const baseline = full
    ? {
        findings: mean(full.runs.map((r) => r.findings.length)),
        confirmed: mean(full.runs.map(confirmedOf)),
        usd: mean(full.runs.map(usdOf)),
      }
    : undefined;

  const rows = arms.map((arm): AblationRow => {
    const meanFindings = mean(arm.runs.map((r) => r.findings.length));
    const meanConfirmed = mean(arm.runs.map(confirmedOf));
    const meanUsd = mean(arm.runs.map(usdOf));

    return {
      label: arm.label,
      removed: arm.removed,
      runsObserved: arm.runs.length,
      meanFindings,
      meanConfirmed,
      meanUsd,
      deltaFindings: baseline ? baseline.findings - meanFindings : undefined,
      deltaConfirmed: baseline ? baseline.confirmed - meanConfirmed : undefined,
      deltaUsd: baseline ? baseline.usd - meanUsd : undefined,
      // One run per arm cannot separate a fleet's contribution from ordinary
      // run-to-run noise, and the variance report exists to show how large that
      // noise is.
      caveat: arm.runs.length < 3 ? `Only ${arm.runs.length} run(s). Not separable from noise.` : undefined,
    };
  });

  if (rows.some((r) => r.caveat)) {
    notes.push("Arms with fewer than 3 runs cannot be distinguished from variance. Treat their deltas as anecdotes.");
  }

  return { rows, notes };
}

/* --------------------------------------------------------------- variance */

export interface Spread {
  mean: number;
  min: number;
  max: number;
  /** Population standard deviation. */
  sd: number;
}

export function spread(values: number[]): Spread {
  if (!values.length) return { mean: 0, min: 0, max: 0, sd: 0 };
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return { mean: m, min: Math.min(...values), max: Math.max(...values), sd: Math.sqrt(variance) };
}

export interface VarianceReport {
  runs: number;
  findings: Spread;
  confirmed: Spread;
  usd: Spread;
  /** How often each axis was actually executed. */
  axisFrequency: Array<{ axis: string; ranIn: number; of: number }>;
  /** Findings seen in some runs but not others, by title. */
  unstableFindings: Array<{ title: string; seenIn: number; of: number }>;
  notes: string[];
}

/**
 * How much a single run's number can be trusted.
 *
 * This exists because the planner deferred an axis in one run and planned it in
 * the next on identical input. Coverage is therefore a random variable, and
 * every detection number inherits its spread. Quoting one run as though it were
 * a constant is the error this makes visible.
 */
export function measureVariance(runs: Run[]): VarianceReport {
  const notes: string[] = [];

  if (runs.length < 2) {
    notes.push("Fewer than two runs: no spread can be estimated. A single run is an anecdote.");
  }

  const axisCounts = new Map<string, number>();
  for (const run of runs) {
    for (const axis of run.axes) {
      if (axis.status !== "done") continue;
      axisCounts.set(axis.key, (axisCounts.get(axis.key) ?? 0) + 1);
    }
  }

  const titleCounts = new Map<string, number>();
  for (const run of runs) {
    // Deduped per run: the same title twice in one run is one observation.
    for (const title of new Set(run.findings.map((f) => f.title))) {
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }
  }

  const unstable = [...titleCounts.entries()]
    .filter(([, seen]) => seen < runs.length)
    .map(([title, seen]) => ({ title, seenIn: seen, of: runs.length }))
    .sort((a, b) => a.seenIn - b.seenIn || a.title.localeCompare(b.title));

  const partialAxes = [...axisCounts.entries()].filter(([, n]) => n < runs.length);
  if (partialAxes.length) {
    notes.push(
      `${partialAxes.length} axis/axes ran in some runs but not others (${partialAxes
        .map(([a, n]) => `${a} ${n}/${runs.length}`)
        .join(", ")}). Coverage is not constant between runs.`,
    );
  }

  if (unstable.length) {
    notes.push(
      `${unstable.length} finding(s) appeared in some runs and not others. A single run under-reports by that much.`,
    );
  }

  return {
    runs: runs.length,
    findings: spread(runs.map((r) => r.findings.length)),
    confirmed: spread(runs.map(confirmedOf)),
    usd: spread(runs.map(usdOf)),
    axisFrequency: [...axisCounts.entries()]
      .map(([axis, ranIn]) => ({ axis, ranIn, of: runs.length }))
      .sort((a, b) => a.axis.localeCompare(b.axis)),
    unstableFindings: unstable,
    notes,
  };
}

/* ------------------------------------------------------------ calibration */

export type FaultLabel = "application" | "spec" | "environment" | "unclear";

export interface LabelledFinding {
  findingId: string;
  /** What a human decided, having looked. */
  truth: FaultLabel;
}

export interface CalibrationReport {
  labelled: number;
  agreed: number;
  agreement: number;
  /** truth -> what triage said -> count. */
  confusion: Record<string, Record<string, number>>;
  /**
   * The expensive mistake: triage said the test was at fault when the
   * application was. That deletes a real bug, silently.
   */
  falseDismissals: Array<{ findingId: string; title: string; triageSaid: string }>;
  /** Triage blamed the application when the test was wrong: a false report. */
  falseReports: Array<{ findingId: string; title: string }>;
  notes: string[];
}

/**
 * Does triage's judgement match a human's?
 *
 * Agreement alone is not the useful number, because the two mistakes are not
 * equally bad. Calling a real bug a spec fault deletes it and nobody ever hears
 * about it. Calling a spec fault a real bug wastes a reviewer's time and gets
 * caught. Both are counted separately for that reason.
 */
export function measureCalibration(runs: Run[], labels: LabelledFinding[]): CalibrationReport {
  const byId = new Map<string, Finding>();
  for (const run of runs) for (const f of run.findings) byId.set(f.id, f);

  const confusion: Record<string, Record<string, number>> = {};
  const falseDismissals: CalibrationReport["falseDismissals"] = [];
  const falseReports: CalibrationReport["falseReports"] = [];
  const notes: string[] = [];

  let agreed = 0;
  let labelled = 0;

  for (const label of labels) {
    const finding = byId.get(label.findingId);
    if (!finding) {
      notes.push(`No finding "${label.findingId}" in the supplied runs. Ignored.`);
      continue;
    }

    // Triage records its call in the tier reason; a DISCARDED spec-fault is the
    // one that matters most and is identifiable.
    const said: FaultLabel =
      finding.tier === "DISCARDED" && /fault is in the test/i.test(finding.tierReason ?? "")
        ? "spec"
        : finding.tier === "QUESTION"
          ? "environment"
          : finding.tier === "CONFIRMED"
            ? "application"
            : "unclear";

    labelled++;
    confusion[label.truth] ??= {};
    confusion[label.truth][said] = (confusion[label.truth][said] ?? 0) + 1;

    if (said === label.truth) agreed++;
    if (label.truth === "application" && said === "spec") {
      falseDismissals.push({ findingId: finding.id, title: finding.title, triageSaid: said });
    }
    if (label.truth === "spec" && said === "application") {
      falseReports.push({ findingId: finding.id, title: finding.title });
    }
  }

  if (labelled < 20) {
    notes.push(`Only ${labelled} labelled finding(s). Agreement on this few is not an estimate of anything.`);
  }
  if (falseDismissals.length) {
    notes.push(
      `${falseDismissals.length} real bug(s) were attributed to the test and dropped. This is the expensive mistake: ` +
        `nobody ever hears about a finding triage discards.`,
    );
  }

  return {
    labelled,
    agreed,
    agreement: labelled ? agreed / labelled : 0,
    confusion,
    falseDismissals,
    falseReports,
    notes,
  };
}

/* ------------------------------------------------------------------ output */

export function describeAblation(result: ReturnType<typeof compareAblations>): string[] {
  const lines: string[] = [];
  lines.push("arm".padEnd(22) + "runs  findings  confirmed  usage    delta findings");

  for (const row of result.rows) {
    lines.push(
      row.label.padEnd(22) +
        String(row.runsObserved).padStart(4) +
        row.meanFindings.toFixed(1).padStart(10) +
        row.meanConfirmed.toFixed(1).padStart(11) +
        `$${row.meanUsd.toFixed(2)}`.padStart(9) +
        (row.deltaFindings === undefined
          ? ""
          : `    ${row.deltaFindings > 0 ? "-" : "+"}${Math.abs(row.deltaFindings).toFixed(1)}`),
    );
    if (row.caveat) lines.push(`  ${" ".repeat(20)}${row.caveat}`);
  }

  for (const n of result.notes) lines.push(`  note  ${n}`);
  return lines;
}

export function describeVariance(report: VarianceReport): string[] {
  const lines: string[] = [];
  const fmt = (s: Spread) => `${s.mean.toFixed(1)} (${s.min}-${s.max}, sd ${s.sd.toFixed(2)})`;

  lines.push(`${report.runs} run(s) of the same input`);
  lines.push(`  findings   ${fmt(report.findings)}`);
  lines.push(`  confirmed  ${fmt(report.confirmed)}`);
  lines.push(`  usage      $${report.usd.mean.toFixed(2)} ($${report.usd.min.toFixed(2)}-$${report.usd.max.toFixed(2)})`);

  if (report.axisFrequency.length) {
    lines.push("  axes ran in:");
    for (const a of report.axisFrequency) lines.push(`    ${a.axis.padEnd(18)} ${a.ranIn}/${a.of}`);
  }

  if (report.unstableFindings.length) {
    lines.push("  findings not seen every time:");
    for (const f of report.unstableFindings.slice(0, 10)) {
      lines.push(`    ${String(f.seenIn).padStart(2)}/${f.of}  ${f.title.slice(0, 66)}`);
    }
  }

  for (const n of report.notes) lines.push(`  note  ${n}`);
  return lines;
}

export function fleetLabelFor(key?: FleetKey): string {
  return key ? `without ${FLEETS[key].codename}` : "full";
}
