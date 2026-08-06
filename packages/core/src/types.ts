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
      requiresAuth?: boolean;
      roles?: string[];
      source?: string;
    }>;
    entryPoints?: Array<{ name: string; startRoute: string; notes?: string }>;
  };
  stack?: {
    framework?: string;
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
    model?: string;
    startedAt?: string;
    finishedAt?: string;
    status?: "ok" | "error" | "timeout";
    usdEstimate?: number;
    transcriptPath?: string;
  }>;
  /** What the run deliberately did not cover. Shown, never silent. */
  truncation?: string[];
}
