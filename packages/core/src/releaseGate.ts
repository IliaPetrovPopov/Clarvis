import type { Finding, Run } from "./types.ts";
import type { Degradation } from "./fleets.ts";

/**
 * Ship-readiness verdict.
 *
 * Deliberately plain deterministic code rather than an agent judgement. A
 * go/no-go call is the highest-stakes output the product has, and "an agent
 * read the results and felt good about it" is not a basis for shipping. Every
 * reason below traces to a counted fact from the run.
 *
 * It recommends. It does not deploy: a tool whose whole claim is that it
 * refuses to touch what it was not told is disposable should not also own a
 * button that pushes to production.
 */

export type ReleaseDecision = "ship" | "hold" | "blocked";

export interface ReleaseReason {
  code: string;
  detail: string;
  severity: "blocking" | "warning" | "info";
}

export interface ReleaseVerdict {
  decision: ReleaseDecision;
  reasons: ReleaseReason[];
  /** What this verdict is NOT based on. Always populated, never empty in practice. */
  notChecked: string[];
  counts: {
    confirmedCritical: number;
    confirmedHigh: number;
    confirmedTotal: number;
    unverified: number;
    specsFailed: number;
    specsSkipped: number;
  };
}

export interface ReleaseOptions {
  /** Confirmed findings at or above this severity block a release. */
  blockAtSeverity?: "critical" | "high" | "medium";
  /** Minimum share of known routes that must have been visited, 0 to 1. */
  minRouteCoverage?: number;
  /** Degradations from the fleet resolver, so a thin run cannot read as a clean one. */
  degradations?: Degradation[];
}

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 } as const;

function confirmed(run: Run): Finding[] {
  return run.findings.filter((f) => f.tier === "CONFIRMED");
}

export function decideRelease(run: Run, opts: ReleaseOptions = {}): ReleaseVerdict {
  const blockAt = opts.blockAtSeverity ?? "high";
  const minCoverage = opts.minRouteCoverage ?? 0.5;

  const conf = confirmed(run);
  const reasons: ReleaseReason[] = [];
  const notChecked: string[] = [];

  const counts = {
    confirmedCritical: conf.filter((f) => f.severity === "critical").length,
    confirmedHigh: conf.filter((f) => f.severity === "high").length,
    confirmedTotal: conf.length,
    unverified: run.findings.filter((f) => f.tier === "PLAUSIBLE" || f.tier === "QUESTION").length,
    specsFailed: run.axes.reduce((n, a) => n + (a.results?.failed ?? 0), 0),
    specsSkipped: run.axes.reduce((n, a) => n + (a.results?.skipped ?? 0), 0),
  };

  let decision: ReleaseDecision = "ship";
  const block = (code: string, detail: string) => {
    decision = "blocked";
    reasons.push({ code, detail, severity: "blocking" });
  };
  const hold = (code: string, detail: string) => {
    if (decision !== "blocked") decision = "hold";
    reasons.push({ code, detail, severity: "warning" });
  };

  /* --- things that mean the run itself cannot support any verdict --------- */

  if (run.boot?.verified === false) {
    block("boot-unverified", "The app could not be proved to start, so nothing was actually tested.");
  }

  if (run.status === "blocked") {
    block("run-blocked", "The run was blocked before completing. There is no result to judge.");
  }

  const ranAnything = run.axes.some((a) => a.status === "done");
  if (!ranAnything) {
    block("nothing-ran", "No axis completed. An empty run is not a passing run.");
  }

  if (run.guard.mode === "aborted") {
    block("guard-aborted", `The safety guard aborted this run: ${run.guard.reason}`);
  }

  /* --- findings ----------------------------------------------------------- */

  for (const f of conf) {
    if (SEVERITY_RANK[f.severity] >= SEVERITY_RANK[blockAt]) {
      block("confirmed-finding", `${f.severity.toUpperCase()}: ${f.title}`);
    }
  }

  /* --- signals that the result is thinner than it looks ------------------- */

  if (counts.specsSkipped > 0) {
    hold(
      "specs-skipped",
      `${counts.specsSkipped} spec(s) were skipped. A skipped spec is an unanswered question, not a pass.`,
    );
  }

  const errored = run.axes.filter((a) => a.status === "error");
  if (errored.length) {
    hold("axis-errored", `${errored.map((a) => a.key).join(", ")} errored and produced no result.`);
  }

  const skippedAxes = run.axes.filter((a) => a.status === "skipped");
  for (const a of skippedAxes) {
    notChecked.push(`${a.key}: ${a.skipReason ?? "skipped"}`);
  }

  const visited = run.coverage?.routesVisited ?? 0;
  const known = run.coverage?.routesKnown ?? 0;
  if (known > 0) {
    const ratio = visited / known;
    if (ratio < minCoverage) {
      hold(
        "low-coverage",
        `Only ${visited} of ${known} known routes were visited (${Math.round(ratio * 100)}%, threshold ${Math.round(minCoverage * 100)}%).`,
      );
    }
  } else {
    hold("coverage-unknown", "Route coverage is unknown, so a clean result cannot be interpreted.");
  }

  if (counts.unverified > 0) {
    reasons.push({
      code: "unverified-findings",
      detail: `${counts.unverified} finding(s) could not be confirmed either way. They are neither proven bugs nor proven non-bugs.`,
      severity: "info",
    });
  }

  // A run missing its supporting fleets can still be perfectly green while
  // having checked almost nothing meaningful. That must reach the verdict.
  for (const d of opts.degradations ?? []) {
    if (d.severity === "high") {
      hold("degraded-run", `${d.fleet} ran without ${d.missing}. ${d.effect}`);
    } else {
      notChecked.push(`${d.fleet} ran without ${d.missing}: ${d.effect}`);
    }
  }

  for (const t of run.truncation ?? []) notChecked.push(t);

  if (decision === "ship") {
    reasons.push({
      code: "clear",
      detail: `No confirmed findings at or above ${blockAt}, every axis completed, nothing skipped.`,
      severity: "info",
    });
  }

  return { decision, reasons, notChecked, counts };
}

/** Exit code for CI. 0 ship, 1 hold, 2 blocked. */
export function releaseExitCode(verdict: ReleaseVerdict): number {
  return verdict.decision === "ship" ? 0 : verdict.decision === "hold" ? 1 : 2;
}
