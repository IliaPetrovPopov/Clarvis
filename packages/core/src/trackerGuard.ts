/**
 * Write gate for issue trackers and wikis.
 *
 * The target guard stops Clarvis corrupting a database. This one stops it
 * corrupting a team's backlog, which is the failure that actually gets a tool
 * banned: half a dozen wrong or duplicate tickets and nobody reads its output
 * again. Socially, that is harder to undo than a bad database write.
 *
 * Same posture as the target guard - plain deterministic code, no agent in the
 * loop, fails closed at every branch:
 *
 *   1. Read-only unless a human explicitly enabled writes.
 *   2. Nothing is created without recorded human approval, per ticket.
 *   3. A finding that is not CONFIRMED can never be published.
 *   4. A suspected duplicate is never published, only surfaced.
 *   5. Everything published is capped per run, so a loop cannot flood a board.
 */

import type { Finding } from "./types.ts";

export type TrackerSystem = "jira" | "confluence" | "linear" | "github";

export interface TrackerConfig {
  system: TrackerSystem;
  /** Defaults to false. Silence means read-only. */
  writeEnabled?: boolean;
  /** Who turned writes on, and when. Recorded in the run for audit. */
  writeEnabledBy?: string;
  /** Project/space the fleet may write to. Anything else is refused. */
  allowedProjects?: string[];
  /** Hard ceiling on creations per run. */
  maxCreatesPerRun?: number;
  /** Label stamped on everything created, so a bad batch can be found and bulk-closed. */
  agentLabel?: string;
}

export type PublishRefusal =
  | "writes-disabled"
  | "not-confirmed"
  | "no-approval"
  | "duplicate-suspected"
  | "project-not-allowed"
  | "run-cap-reached";

export interface PublishDecision {
  allowed: boolean;
  reason: string;
  refusal?: PublishRefusal;
}

export interface PublishRequest {
  finding: Finding;
  project: string;
  /** Set only by a human action in the UI or CLI. Agents cannot set this. */
  approvedBy?: string;
  /** Populated by report-dedupe. A non-empty list blocks publication. */
  possibleDuplicates?: string[];
}

export const DEFAULT_MAX_CREATES = 10;

export function decidePublish(
  config: TrackerConfig,
  request: PublishRequest,
  createdSoFar: number,
): PublishDecision {
  const deny = (refusal: PublishRefusal, reason: string): PublishDecision => ({
    allowed: false,
    refusal,
    reason,
  });

  if (config.writeEnabled !== true) {
    return deny(
      "writes-disabled",
      `Writes to ${config.system} are not enabled. Drafts are available for review; nothing will be created.`,
    );
  }

  // Only findings that survived the full verification chain may become tickets.
  // Publishing a PLAUSIBLE finding would put an unverified claim in front of a
  // whole team under Clarvis's name.
  if (request.finding.tier !== "CONFIRMED") {
    return deny(
      "not-confirmed",
      `Finding "${request.finding.title}" is ${request.finding.tier}, not CONFIRMED. Only confirmed findings can be published.`,
    );
  }

  if (!request.approvedBy) {
    return deny(
      "no-approval",
      `Finding "${request.finding.title}" has no recorded human approval. Every ticket is draft first, created second.`,
    );
  }

  if (request.possibleDuplicates?.length) {
    return deny(
      "duplicate-suspected",
      `Possible duplicate of ${request.possibleDuplicates.join(", ")}. Surfaced for a human rather than filed again.`,
    );
  }

  const allowed = config.allowedProjects ?? [];
  if (!allowed.includes(request.project)) {
    return deny(
      "project-not-allowed",
      `Project "${request.project}" is not in the allow-list (${allowed.join(", ") || "none configured"}).`,
    );
  }

  const cap = config.maxCreatesPerRun ?? DEFAULT_MAX_CREATES;
  if (createdSoFar >= cap) {
    return deny(
      "run-cap-reached",
      `Reached the per-run cap of ${cap} created items. Remaining findings stay as drafts.`,
    );
  }

  return {
    allowed: true,
    reason: `Confirmed, approved by ${request.approvedBy}, no duplicates, project allowed, ${createdSoFar + 1}/${cap} for this run.`,
  };
}

/**
 * Requirements sourced by the research fleet must trace to something a human
 * wrote. This rejects the laundering case: an agent inventing a requirement,
 * the QA fleet being graded against it, and the system confirming its own
 * fiction with full ceremony.
 */
export function isValidOracleSource(req: {
  quote?: string;
  sourceIds?: string[];
}): { valid: boolean; reason: string } {
  if (!req.sourceIds?.length) {
    return { valid: false, reason: "No source cited. Move it to `unknowns`." };
  }
  if (!req.quote?.trim()) {
    return {
      valid: false,
      reason: "No verbatim quote. A paraphrase is the agent's words, not the author's.",
    };
  }
  return { valid: true, reason: "Traces to a quoted, human-authored source." };
}
