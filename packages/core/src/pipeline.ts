import type { Run } from "./types.ts";

/**
 * The shape of a run, declared once.
 *
 * Two of this session's bugs were the same bug: a list written down in two
 * places that drifted. The dashboard's progress ring expected nine stages and
 * the run emitted eight, so a run in flight could never reach the end of its
 * own scale. The server declared an API version and the page declared what it
 * needed, and a server left running for a day paired a stale API with a newer
 * page and failed one fetch at a time.
 *
 * Neither was findable by a unit test, because each half was individually
 * correct. So they are declared here, once, and both halves import it. That
 * does not detect the drift - it removes the possibility of it.
 *
 * The invariants below are the other half of the same idea. They are the
 * things about a finished run that must be true and that no unit test checks,
 * because each is a property of the whole pipeline rather than of any part.
 */

/**
 * Every stage a full run moves through, in order.
 *
 * The CLI stamps these as it goes and the dashboard draws them as a scale.
 * Adding a stage means adding it here and emitting it; a stage listed and
 * never emitted makes the scale unreachable, which is what the invariants
 * below exist to catch on the next run rather than the next month.
 */
export const STAGES = [
  /**
   * Conditional: only when a mutating axis was asked for and the guard would
   * otherwise refuse. A run that never needed a database did not skip a step,
   * so its absence is not a defect - which is a distinction the invariant has
   * to make, or every read-only run reports a false violation.
   */
  { key: "sandbox", label: "preparing a disposable database", conditional: true },
  { key: "context", label: "reading requirements" },
  { key: "boot", label: "starting the application" },
  { key: "surface", label: "logging in and mapping the pages" },
  { key: "author", label: "writing the specs" },
  { key: "execute", label: "running the tests" },
  { key: "triage", label: "trying to reproduce each failure" },
  { key: "deliver", label: "drafting tickets and judging the release" },
  { key: "done", label: "finished" },
] as const;

/** Stages that must fire on every run that gets that far. */
const MANDATORY = new Set<string>(
  STAGES.filter((s) => !("conditional" in s && s.conditional)).map((s) => s.key),
);

export type StageKey = (typeof STAGES)[number]["key"];

export const STAGE_KEYS: readonly string[] = STAGES.map((s) => s.key);

/**
 * How long a stage may take before something is wrong.
 *
 * Not a timeout - nothing is killed on these - but the threshold at which a
 * run is reported as having hung rather than having been slow. Warm-up sat at
 * twenty-three minutes because nothing anywhere had an opinion about how long
 * it should take, and the log's last line was "already up".
 */
export const STAGE_BUDGET_MS: Record<string, number> = {
  sandbox: 5 * 60_000,
  context: 2 * 60_000,
  boot: 4 * 60_000,
  surface: 8 * 60_000,
  author: 6 * 60_000,
  execute: 15 * 60_000,
  triage: 15 * 60_000,
  deliver: 3 * 60_000,
};

/**
 * The API version the dashboard and the server must agree on.
 *
 * Raise it whenever an endpoint the UI depends on is added or changed. The
 * server reports it; the page compares and says so out loud when it is newer
 * than the process serving it.
 */
export const API_CONTRACT = 3;

/* ------------------------------------------------------------- invariants */

export interface Violation {
  /** Short, stable, greppable. */
  code: string;
  detail: string;
  /** What this being wrong actually costs a reader. */
  cost: string;
}

/**
 * What must be true of a finished run.
 *
 * Every rule here corresponds to a bug that shipped. They are properties of
 * the pipeline as a whole - none is checkable from inside the unit that
 * produces it, which is exactly why each survived a green test suite.
 */
export function checkRun(run: Run, opts: { live?: boolean } = {}): Violation[] {
  const out: Violation[] = [];

  /* --- the stage scale ---------------------------------------------------- */

  const emitted = new Set<string>([
    ...(run.stage?.done ?? []).map((d) => d.key),
    ...(run.stage ? [run.stage.key] : []),
  ]);

  for (const key of emitted) {
    if (!STAGE_KEYS.includes(key)) {
      out.push({
        code: "unknown-stage",
        detail: `The run emitted a stage "${key}" that STAGES does not declare.`,
        cost: "The dashboard draws a scale from STAGES, so this stage is invisible on it.",
      });
    }
  }

  if (run.status !== "blocked" && emitted.size) {
    // Every stage before the last one reached should have fired. A gap means a
    // step ran without stamping itself, and the ring stalls short of its end.
    const lastIndex = Math.max(...[...emitted].map((k) => STAGE_KEYS.indexOf(k)));
    const missing = STAGE_KEYS.slice(0, lastIndex).filter((k) => !emitted.has(k) && MANDATORY.has(k));
    if (missing.length) {
      out.push({
        code: "stage-never-emitted",
        detail: `Stages declared but never stamped: ${missing.join(", ")}.`,
        cost:
          "A run in flight can never reach the end of its own progress scale, so a live run " +
          "looks stuck at the exact moment someone is watching it.",
      });
    }
  }

  /* --- hangs -------------------------------------------------------------- */

  for (const done of run.stage?.done ?? []) {
    const budget = STAGE_BUDGET_MS[done.key];
    if (budget && done.ms > budget) {
      out.push({
        code: "stage-over-budget",
        detail: `Stage "${done.key}" took ${Math.round(done.ms / 1000)}s, over its ${Math.round(budget / 1000)}s budget.`,
        cost: "A step this slow reads as a hang, and the log's last line is from before it started.",
      });
    }
  }

  /* --- things computed and then dropped ----------------------------------- */

  const agents = run.agentRuns ?? [];
  const ok = agents.filter((a) => a.status === "ok");
  if (opts.live && ok.length) {
    const withoutTokens = ok.filter((a) => !a.tokens || a.tokens.input + a.tokens.output === 0);
    if (withoutTokens.length) {
      out.push({
        code: "tokens-not-recorded",
        detail: `${withoutTokens.length} of ${ok.length} successful agent run(s) recorded no tokens.`,
        cost:
          "Tokens are the only honest measure of effort on a Claude plan. Without them the " +
          "dashboard has nothing to show but a price that nobody is charged.",
      });
    }

    const withoutFleet = agents.filter((a) => !a.fleet);
    if (withoutFleet.length) {
      out.push({
        code: "fleet-not-recorded",
        detail: `${withoutFleet.length} agent run(s) have no team.`,
        cost: "The dashboard groups by team, so these appear under a heading of their own.",
      });
    }
  }

  /* --- findings that cannot be acted on ------------------------------------ */

  for (const f of run.findings ?? []) {
    if (!f.oracle) {
      out.push({
        code: "finding-without-oracle",
        detail: `Finding ${f.id} has no oracle.`,
        cost: "Nothing says how we know it is wrong, so a reader cannot judge whether to act.",
      });
    }
    if (!f.evidence?.specFile) {
      out.push({
        code: "finding-without-evidence",
        detail: `Finding ${f.id} names no spec file.`,
        cost: "The claim cannot be checked against the test that produced it.",
      });
    }
  }

  /* --- a clean result that means nothing ----------------------------------- */

  const executed = (run.axes ?? []).filter((a) => a.status === "done");
  if (opts.live && !executed.length && run.status !== "blocked") {
    out.push({
      code: "no-axis-executed",
      detail: "The run finished without executing a single axis.",
      cost: "A run that tested nothing reports the same empty findings list as one that tested everything.",
    });
  }

  if (run.status !== "blocked" && !(run.truncation ?? []).length && executed.length) {
    out.push({
      code: "no-limits-stated",
      detail: "A run that executed something recorded nothing it did not cover.",
      cost:
        "Every run misses something. A run claiming otherwise is the false-green this whole " +
        "product exists to prevent.",
    });
  }

  return out;
}

/** One line per violation, for a terminal. */
export function describePipelineViolations(violations: Violation[]): string[] {
  return violations.flatMap((v) => [`${v.code}: ${v.detail}`, `    ${v.cost}`]);
}
