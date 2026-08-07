/**
 * Types mirroring schema/*.json. The JSON Schemas are the contract of record -  * these exist so the UI and engine share one shape at compile time.
 * Change a schema, change this file in the same commit.
 */

export const SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------ profile */

export type AuthMode =
  | "none"
  | "cookie-session"
  | "cookie-jwt"
  | "bearer-localstorage"
  | "basic"
  | "custom";

export interface AuthRole {
  key: string;
  label?: string;
  username: string;
  password: string;
  storageState?: string;
  /** Routes this role must NOT reach. Feeds the rbac axis directly. */
  expectedDenied?: string[];
}

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

/**
 * One reachable piece of the system.
 *
 * A single `boot.url` is the right shape for one app and the wrong shape for a
 * platform. The bugs that matter in a service architecture live in the
 * interactions - an auth change breaking exam scoping - and none of that is
 * reachable while there is only ever one target.
 *
 * The primary target stays `boot.url`, so everything that already exists keeps
 * working; these are the others.
 */
export interface ServiceTarget {
  /** Short name used in specs and findings: "auth", "exam-api". */
  key: string;
  url: string;
  /** What it is, in one line. Given to spec authors. */
  role?: string;
  /** Started with the primary, when it is not already up. */
  cmd?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Fetched to prove it is up. Defaults to `url`. */
  readyCheck?: string;
}

export interface Profile {
  schemaVersion: typeof SCHEMA_VERSION;
  project: {
    name: string;
    root: string;
    reconAt?: string;
    reconCommit?: string;
  };
  boot: {
    cmd?: string;
    cwd?: string;
    url: string;
    /**
     * Extra environment for the boot command. Used to run a second instance of
     * the same app on a different port, which is what differential testing
     * needs to have both versions up at once.
     */
    env?: Record<string, string>;
    readyTimeoutMs?: number;
    readyCheck?: string;
    teardownCmd?: string;
    /** True only if recon actually booted it and got a live response. */
    verified: boolean;
    verifiedAt?: string;
    blockers?: string[];
  };
  auth: {
    mode: AuthMode;
    loginUrl?: string;
    apiLogin?: {
      url: string;
      method?: "POST" | "GET";
      bodyTemplate?: Record<string, unknown>;
    };
    roles: AuthRole[];
    notes?: string;
  };
  data: {
    /** Defaults false. Unknown projects are read-only until a human says otherwise. */
    disposable: boolean;
    safeTargets: string[];
    confirmedBy?: string;
    fixturePrefix?: string;
    teardownCmd?: string;
    /** Hard deny-list. Beats safeTargets. */
    forbiddenHosts?: string[];
  };
  /**
   * Additional services beyond `boot.url`. Optional: a single-app project has
   * none, and nothing behaves differently for it.
   */
  services?: ServiceTarget[];
  surface?: {
    routes?: Array<{
      path: string;
      title?: string;
      /** Observed by visiting anonymously, not inferred from middleware. */
      requiresAuth?: boolean;
      roles?: string[];
      source?: string;
      /** Contains a parameter, so it cannot be visited as written. */
      dynamic?: boolean;
      /** What was actually requested, once known parameters were filled in. */
      visitPath?: string;
      /** Where the browser ended up, when it differed from `path`. */
      landedOn?: string;
      status?: number;
      /**
       * The accessibility tree as Playwright renders it.
       *
       * The one description of a page that a selector can be written from
       * without guessing: it is exactly what `getByRole` matches against.
       * Source says what a component is written as; this says what the browser
       * built from it, and between the two sit a component library, a portal
       * and any wrapper that forwards to a different element.
       */
      ariaSnapshot?: string;
      /** Why no snapshot was taken, when none was. */
      note?: string;
    }>;
    entryPoints?: Array<{ name: string; startRoute: string; notes?: string }>;
    /** How the routes were found, e.g. "next-app-router (app, 12 route(s))". */
    discoveredBy?: string[];
    mappedAt?: string;
  };
  stack?: {
    framework?: string;
    /**
     * How the page arrives.
     *
     * Measured, not guessed: `client-rendered` means the server returns a shell
     * and the content appears only after hydration. Measured at 5.3 seconds on
     * a real application, during which specs written as though the HTML were
     * complete failed on every assertion - producing findings about the harness
     * rather than about the software under test.
     */
    rendering?: "server-rendered" | "client-rendered" | "unknown";
    /** Milliseconds from navigation to content, when it was measured. */
    hydrationMs?: number;
    css?: string;
    ui?: string;
    i18n?: string;
    locales?: string[];
    rtlLocales?: string[];
    testRunner?: string;
    packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  };
  risk?: {
    hotspots?: Array<{
      area: string;
      reason: string;
      score?: number;
      files?: string[];
    }>;
  };
  viewports?: Viewport[];
}

/* ------------------------------------------------------------------ finding */

export const AXES = [
  "happy-path",
  "rbac-scope",
  "i18n-rtl",
  "adversarial",
  "responsive-a11y",
  "resilience",
  "visual",
] as const;
export type Axis = (typeof AXES)[number];

/** Axes that create or modify records. Blocked unless the guard says mutating. */
export const MUTATING_AXES: readonly Axis[] = [
  "happy-path",
  "rbac-scope",
  "adversarial",
  "resilience",
];

/** Safe anywhere - they only look. */
export const READ_ONLY_AXES: readonly Axis[] = ["i18n-rtl", "responsive-a11y", "visual"];

export type Severity = "critical" | "high" | "medium" | "low";
export type Tier = "CONFIRMED" | "PLAUSIBLE" | "QUESTION" | "DISCARDED";

/** Ranked most to least authoritative. */
export type OracleType =
  | "spec"
  | "acceptance-criteria"
  | "visible-label"
  | "i18n-key"
  | "code-intent"
  | "prior-run"
  | "none";

export interface Finding {
  id: string;
  axis: Axis;
  title: string;
  severity: Severity;
  tier: Tier;
  tierReason?: string;
  oracle: { type: OracleType; citation?: string; quote?: string };
  route?: string;
  role?: string;
  viewport?: string;
  locale?: string;
  locator?: string;
  steps?: string[];
  expected: string;
  actual: string;
  evidence: {
    specFile: string;
    tracePath?: string;
    screenshots?: string[];
    consoleLogPath?: string;
    networkLogPath?: string;
    exitCode?: number;
    stderrExcerpt?: string;
  };
  determinism?: {
    runs?: number;
    failures?: number;
    verdict?: "deterministic" | "flaky" | "not-reproduced";
  };
  negativeControl?: { ran?: boolean; ref?: string; alsoFailed?: boolean };
  verifiedBy?: string;
  foundBy?: string;
  createdAt?: string;
  tracker?: {
    status: "none" | "drafted" | "approved" | "created";
    system?: "jira" | "linear" | "github";
    key?: string;
    url?: string;
  };
}

/* ---------------------------------------------------------------------- run */

export type RunStatus =
  | "running"
  | "passed"
  | "findings"
  | "blocked"
  | "error"
  | "cancelled";

export type GuardMode = "mutating" | "read-only" | "aborted";

export interface AxisResults {
  passed?: number;
  failed?: number;
  skipped?: number;
  flaky?: number;
  durationMs?: number;
}

export interface AxisRun {
  key: string;
  status: "pending" | "running" | "done" | "skipped" | "error";
  skipReason?: string;
  agentId?: string;
  startedAt?: string;
  finishedAt?: string;
  specFiles?: string[];
  /** Parsed from the Playwright JSON reporter - never from agent prose. */
  results?: AxisResults;
  artifactsDir?: string;
}

export interface Run {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  request?: {
    /**
     * Teams enabled for this run.
     *
     * Recorded so the dashboard can show a team that produced nothing as
     * "did not run" rather than omitting it. An absent row and a silent row
     * look identical, and that equivalence is the failure this whole product
     * exists to prevent - it should not appear in its own reporting.
     */
    fleets?: string[];
    feature?: string;
    brief?: string;
    axes?: string[];
    profilePath?: string;
  };
  guard: {
    mode: GuardMode;
    target: string;
    matchedSafeTarget?: string;
    reason?: string;
    skippedAxes?: string[];
  };
  boot?: { verified?: boolean; durationMs?: number; blockers?: string[] };
  axes: AxisRun[];
  findings: Finding[];
  coverage?: {
    routesVisited?: number;
    routesKnown?: number;
    rolesExercised?: string[];
    localesExercised?: string[];
    jsCoveragePct?: number;
  };
  agentRuns?: Array<{
    id: string;
    role: string;
    /**
     * Which team this agent belongs to.
     *
     * Written here rather than derived in the reader, so the dashboard can group
     * by team without carrying its own copy of the role-to-fleet mapping - a
     * copy that would drift the first time a role moved.
     */
    fleet?: string;
    model?: string;
    startedAt?: string;
    finishedAt?: string;
    status?: "ok" | "error" | "timeout";
    /**
     * What the invocation actually consumed.
     *
     * Persisted because it is the only honest unit of effort when Clarvis runs
     * on a Claude plan, which is the normal case: there is no dollar charge to
     * report, and a plan's usage is counted in tokens. The runtime layer had
     * these all along and dropped them on the way to the record, leaving a
     * price as the only thing anyone could be shown.
     */
    tokens?: { input: number; output: number };
    /** Only meaningful when an API key is set. Otherwise nothing is billed. */
    usdEstimate?: number;
    transcriptPath?: string;
  }>;
  /** What the run deliberately did not cover. Shown, never silent. */
  /**
   * Where the run has got to, written as it goes.
   *
   * A run takes minutes and used to record nothing until it finished, so a
   * dashboard watching one could say only "running" - which is the same thing
   * it says for a run that has hung. Each stage is stamped when it starts and
   * the finished ones keep their duration, so a reader can see both what is
   * happening now and what it cost to get there.
   */
  stage?: {
    key: string;
    label: string;
    startedAt: string;
    done?: Array<{ key: string; label: string; ms: number }>;
  };

  /**
   * What each preparation stage actually did.
   *
   * These used to leave a trace only when they failed, as prose in
   * `truncation`. That is the wrong way round: a reader cannot tell the
   * difference between a stage that succeeded and one that never ran, and
   * "40 routes mapped, 10 snapshotted" is exactly the context that says how far
   * to trust a clean result. Recorded as structure rather than sentences so the
   * dashboard can show it without parsing English.
   */
  preparation?: {
    sandbox?: {
      provisioned: boolean;
      engine?: string;
      provisionedBy?: string;
      evidence?: string;
      /** Every rung tried and why it did not work. */
      attempts?: Array<{ approach: string; outcome: string }>;
      remedy?: string;
    };
    sessions?: Array<{
      role: string;
      ok: boolean;
      /** What proved it real, or why it failed. */
      detail?: string;
    }>;
    surface?: {
      routesDeclared: number;
      routesProbed: number;
      routesSnapshotted: number;
      routesBehindAuth: number;
      discoveredBy?: string[];
    };
    data?: {
      seeded: boolean;
      commandsRun?: string[];
      commandsSkipped?: Array<{ script: string; reason: string }>;
      targetCheck?: string;
    };
  };

  truncation?: string[];
}
