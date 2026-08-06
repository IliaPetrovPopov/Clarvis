/**
 * The safety gate.
 *
 * A universal tester pointed at an unknown project can write junk into someone's
 * production database. This module is the only thing standing between the fleet
 * and that outcome, so it is plain deterministic code with no agent involved,
 * and it fails closed at every branch.
 *
 * Rules, in order:
 *   1. A `forbiddenHosts` match aborts the run outright - it beats everything.
 *   2. `disposable !== true` means read-only. The default is false, so a project
 *      nobody has vetted is read-only automatically.
 *   3. No `safeTargets` match means read-only.
 *   4. Only when the target is explicitly disposable AND matches a safe target
 *      do mutating axes run.
 */

import { MUTATING_AXES, READ_ONLY_AXES, type Axis, type GuardMode, type Profile } from "./types.ts";

export interface GuardDecision {
  mode: GuardMode;
  /** Resolved "host:port" actually driven. */
  target: string;
  matchedSafeTarget?: string;
  reason: string;
  /** Axes that must not run under this decision. */
  skippedAxes: Axis[];
  allowedAxes: Axis[];
}

/**
 * Glob with a single wildcard char `*` matching any run of non-`/` characters.
 * Deliberately not a full glob library: the patterns are host:port, and a
 * permissive matcher here is a security bug.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

/** "http://localhost:8100/admin" -> "localhost:8100". Port is defaulted per scheme. */
export function normalizeTarget(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not a URL - treat the raw string as an authority so it can still be
    // matched against forbiddenHosts rather than silently passing.
    return rawUrl.trim().toLowerCase();
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.toLowerCase()}:${port}`;
}

function matchesAny(target: string, patterns: readonly string[] | undefined): string | undefined {
  if (!patterns?.length) return undefined;
  for (const pattern of patterns) {
    // Match the full authority, and also the bare hostname so a deny-list entry
    // like "prod.example.com" catches every port on that host.
    const re = globToRegExp(pattern.trim().toLowerCase());
    const hostOnly = target.split(":")[0];
    if (re.test(target) || re.test(hostOnly)) return pattern;
  }
  return undefined;
}

export function decideGuard(profile: Profile, requestedUrl?: string): GuardDecision {
  const target = normalizeTarget(requestedUrl ?? profile.boot.url);

  const forbidden = matchesAny(target, profile.data.forbiddenHosts);
  if (forbidden) {
    return {
      mode: "aborted",
      target,
      reason: `Target ${target} matches forbidden host pattern "${forbidden}". Refusing to run at all.`,
      skippedAxes: [...MUTATING_AXES, ...READ_ONLY_AXES],
      allowedAxes: [],
    };
  }

  // Every declared service is checked, not just the one being driven. A run
  // that only vets its primary target while a spec can reach a forbidden
  // service alongside it has vetted nothing.
  for (const service of profile.services ?? []) {
    const serviceTarget = normalizeTarget(service.url);
    const denied = matchesAny(serviceTarget, profile.data.forbiddenHosts);
    if (denied) {
      return {
        mode: "aborted",
        target: serviceTarget,
        reason:
          `Service "${service.key}" points at ${serviceTarget}, which matches forbidden host pattern ` +
          `"${denied}". Refusing to run at all.`,
        skippedAxes: [...MUTATING_AXES, ...READ_ONLY_AXES],
        allowedAxes: [],
      };
    }
  }

  const readOnly = (reason: string): GuardDecision => ({
    mode: "read-only",
    target,
    reason,
    skippedAxes: [...MUTATING_AXES],
    allowedAxes: [...READ_ONLY_AXES],
  });

  if (profile.data.disposable !== true) {
    return readOnly(
      `Target ${target} is not marked disposable. Running read-only axes only ` +
        `(${READ_ONLY_AXES.join(", ")}). A human must set data.disposable=true to enable mutating tests.`,
    );
  }

  // Mutating tests require that EVERY reachable service is vouched for, not
  // just the front door: a spec driving the UI can still write through a
  // service nobody confirmed was disposable.
  for (const service of profile.services ?? []) {
    const serviceTarget = normalizeTarget(service.url);
    if (!matchesAny(serviceTarget, profile.data.safeTargets)) {
      return readOnly(
        `Service "${service.key}" at ${serviceTarget} is not in safeTargets, so mutating axes are refused ` +
          `even though ${target} is. Every reachable service must be vouched for.`,
      );
    }
  }

  const matchedSafeTarget = matchesAny(target, profile.data.safeTargets);
  if (!matchedSafeTarget) {
    return readOnly(
      `Target ${target} does not match any safeTargets pattern ` +
        `(${(profile.data.safeTargets ?? []).join(", ") || "none configured"}). Running read-only axes only.`,
    );
  }

  return {
    mode: "mutating",
    target,
    matchedSafeTarget,
    reason: `Target ${target} is a confirmed disposable backend (matched "${matchedSafeTarget}").`,
    skippedAxes: [],
    allowedAxes: [...MUTATING_AXES, ...READ_ONLY_AXES],
  };
}

/**
 * Filter a requested axis list down to what the decision permits.
 * Returns the dropped axes too - callers must record them in the run so a
 * partial pass is never presented as full coverage.
 */
export function applyGuardToAxes(
  decision: GuardDecision,
  requested: Axis[],
): { allowed: Axis[]; skipped: Array<{ axis: Axis; reason: string }> } {
  const allowedSet = new Set(decision.allowedAxes);
  const allowed: Axis[] = [];
  const skipped: Array<{ axis: Axis; reason: string }> = [];

  for (const axis of requested) {
    if (allowedSet.has(axis)) allowed.push(axis);
    else skipped.push({ axis, reason: decision.reason });
  }
  return { allowed, skipped };
}
