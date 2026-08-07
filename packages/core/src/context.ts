/**
 * Feature context: what a feature is SUPPOSED to do.
 *
 * Mirrors `schema/context.schema.json`. The rules that matter are enforced here
 * in code rather than trusted to prompt discipline:
 *
 *   1. A requirement must cite at least one source.
 *   2. It must carry a verbatim quote.
 *   3. THE QUOTE MUST ACTUALLY APPEAR IN THAT SOURCE.
 *
 * The third is the one with teeth. Requiring "a quote" only asks an agent to
 * produce a quote-shaped string, which a model will happily invent. Checking it
 * against the retrieved text makes fabrication detectable instead of merely
 * discouraged, and it is a plain substring comparison - no judgement involved.
 *
 * Whether a real quote actually *entails* the requirement is a separate
 * question that needs reasoning, and is handled by an independent verifier
 * (see `EntailmentVerifier`) rather than by the agent that wrote the claim.
 */

export const CONTEXT_SCHEMA_VERSION = 1 as const;

export type SourceType =
  | "jira-issue"
  | "jira-comment"
  | "confluence-page"
  | "linear-issue"
  | "github-issue"
  | "pull-request"
  | "commit-message"
  | "adr"
  | "readme"
  | "code-comment"
  | "i18n-string"
  | "incident-report"
  | "design-doc";

export interface ContextSource {
  id: string;
  type: SourceType;
  /** Issue key, URL, or file:line. Must be openable by a human. */
  ref: string;
  title?: string;
  author?: string;
  updatedAt?: string;
  retrievedAt?: string;
  /** The retrieved text. Quotes are checked against this and it is not serialised. */
  content?: string;
}

export type Confidence = "explicit" | "implied" | "contested";

export interface Requirement {
  id: string;
  statement: string;
  quote: string;
  sourceIds: string[];
  confidence: Confidence;
  conflictsWith?: string[];
  appliesTo?: { routes?: string[]; roles?: string[]; locales?: string[] };
  axisHints?: string[];
}

export interface Unknown {
  question: string;
  why?: string;
  /** An agent's inference. Parked here precisely so it cannot become an oracle. */
  guess?: string;
  blocksAxes?: string[];
}

export interface FeatureContext {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  feature: { key: string; title: string; summary?: string; trackerKeys?: string[] };
  gatheredAt: string;
  staleAfter?: string;
  sources: Array<Omit<ContextSource, "content">>;
  requirements: Requirement[];
  unknowns: Unknown[];
  knownIssues?: Array<{ ref: string; summary: string; status?: string }>;
  regressionHistory?: Array<{ ref: string; summary: string; fixedAt?: string; files?: string[] }>;
  provenance?: {
    agents?: string[];
    connectors?: Array<{ name: string; status: string; scope?: string; note?: string }>;
    coverage?: {
      sourcesFound: number;
      requirementsExplicit: number;
      requirementsImplied: number;
      unknownCount: number;
    };
  };
}

/* ---------------------------------------------------------- verification */

export type RejectionCode =
  | "no-source"
  | "unknown-source"
  | "no-quote"
  | "quote-not-found"
  | "empty-statement";

export interface RequirementRejection {
  requirementId: string;
  code: RejectionCode;
  detail: string;
  /** What the agent should do instead. Usually: move it to `unknowns`. */
  remedy: string;
}

/**
 * Normalise before comparing. Retrieved text arrives with different wrapping,
 * smart quotes and non-breaking spaces depending on the connector, and none of
 * those differences mean the quote is fake.
 */
export function normaliseForQuote(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function quoteAppearsIn(quote: string, sourceContent: string): boolean {
  const q = normaliseForQuote(quote);
  if (q.length < 8) return false; // too short to be evidence of anything
  return normaliseForQuote(sourceContent).includes(q);
}

/**
 * Validate requirements against the sources they cite. Anything that fails is
 * rejected with a reason and a remedy, never silently dropped - a requirement
 * disappearing without explanation is how a context quietly gets thinner than
 * it looks.
 */
export function verifyRequirements(
  requirements: Requirement[],
  sources: ContextSource[],
): { accepted: Requirement[]; rejected: RequirementRejection[] } {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const accepted: Requirement[] = [];
  const rejected: RequirementRejection[] = [];

  for (const req of requirements) {
    const reject = (code: RejectionCode, detail: string, remedy: string) =>
      rejected.push({ requirementId: req.id, code, detail, remedy });

    if (!req.statement?.trim()) {
      reject("empty-statement", "Requirement has no statement.", "Drop it.");
      continue;
    }

    if (!req.sourceIds?.length) {
      reject(
        "no-source",
        `"${req.statement}" cites no source.`,
        "Move it to unknowns as a guess. An uncited requirement is the agent's own opinion.",
      );
      continue;
    }

    const missing = req.sourceIds.filter((id) => !byId.has(id));
    if (missing.length) {
      reject(
        "unknown-source",
        `Cites source id(s) that were never gathered: ${missing.join(", ")}.`,
        "Cite a source that exists, or move it to unknowns.",
      );
      continue;
    }

    if (!req.quote?.trim()) {
      reject(
        "no-quote",
        `"${req.statement}" has no verbatim quote.`,
        "Quote the source text. A paraphrase is the agent's words, not the author's.",
      );
      continue;
    }

    const cited = req.sourceIds.map((id) => byId.get(id)!);
    const found = cited.some((s) => s.content && quoteAppearsIn(req.quote, s.content));

    if (!found) {
      reject(
        "quote-not-found",
        `The quote does not appear in ${req.sourceIds.join(", ")}. Either it was reworded or it was invented.`,
        "Copy the text exactly as it appears in the source, or move the claim to unknowns.",
      );
      continue;
    }

    accepted.push(req);
  }

  return { accepted, rejected };
}

/**
 * Judges whether a real quote actually supports the statement drawn from it.
 * Implemented by an agent that sees ONLY the quote and the statement - never
 * the feature, the code, or who wrote the claim - so it cannot be talked into
 * agreeing by surrounding context.
 */
export interface EntailmentVerifier {
  check(input: {
    quote: string;
    statement: string;
  }): Promise<{ entailed: boolean; confidence: Confidence; reason: string }>;
}

export async function applyEntailment(
  requirements: Requirement[],
  verifier: EntailmentVerifier,
): Promise<{ accepted: Requirement[]; demoted: Array<{ requirement: Requirement; reason: string }> }> {
  const accepted: Requirement[] = [];
  const demoted: Array<{ requirement: Requirement; reason: string }> = [];

  for (const req of requirements) {
    const verdict = await verifier.check({ quote: req.quote, statement: req.statement });
    if (verdict.entailed) {
      accepted.push({ ...req, confidence: verdict.confidence });
    } else {
      demoted.push({ requirement: req, reason: verdict.reason });
    }
  }

  return { accepted, demoted };
}

/**
 * Requirements that contradict each other are marked, never resolved. Picking a
 * winner would be the agent authoring intent, which is the thing the whole
 * design forbids. A contested requirement is surfaced to the human and is not
 * usable as a blocking oracle.
 */
export function markConflicts(requirements: Requirement[]): Requirement[] {
  const NEGATION = /\b(not|never|cannot|can not|must not|no longer|without)\b/i;

  const words = (statement: string) =>
    statement
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3);

  return requirements.map((req) => {
    const subject = new Set(words(req.statement));

    const conflicts = requirements
      .filter((other) => other.id !== req.id)
      .filter((other) => {
        const otherWords = words(other.statement);
        if (!otherWords.length || !subject.size) return false;

        const shared = otherWords.filter((w) => subject.has(w)).length;

        /*
          Near-identical wording, not merely the same topic.

          This asked for three shared words of four letters or more, which any
          two requirements about one feature satisfy - "bulk", "action",
          "selection", "rows". Paired with a negation test, that made every
          statement containing "not" contradict every statement that did not.
          On the first real run it marked five of six requirements contested,
          and a contested requirement is deliberately never used as an oracle,
          so a word-frequency coincidence quietly destroyed almost everything
          the team had gathered.

          A shared vocabulary is not a shared claim. Two statements contradict
          only if they assert opposite things about the same predicate, and the
          only form of that a text heuristic can honestly recognise is the same
          sentence said twice with opposite polarity. Anything subtler is a
          judgement about meaning - which is the entailment agent's job, and
          not something this should pretend to do.
        */
        const overlap = shared / Math.min(subject.size, otherWords.length);
        const lengthRatio =
          Math.min(subject.size, otherWords.length) / Math.max(subject.size, otherWords.length);

        const nearlyTheSameSentence = overlap >= 0.75 && lengthRatio >= 0.6;
        const opposite = NEGATION.test(req.statement) !== NEGATION.test(other.statement);

        return nearlyTheSameSentence && opposite;
      })
      .map((o) => o.id);

    return conflicts.length
      ? { ...req, confidence: "contested" as Confidence, conflictsWith: conflicts }
      : req;
  });
}

/** Assemble the final artifact. Source `content` is dropped: it is evidence for verification, not payload. */
export function buildContext(input: {
  feature: { key: string; title: string; summary?: string; trackerKeys?: string[] };
  sources: ContextSource[];
  requirements: Requirement[];
  unknowns: Unknown[];
  knownIssues?: FeatureContext["knownIssues"];
  regressionHistory?: FeatureContext["regressionHistory"];
  agents?: string[];
  connectors?: Array<{ name: string; status: string; scope?: string; note?: string }>;
  gatheredAt?: string;
  staleAfterDays?: number;
}): FeatureContext {
  const gatheredAt = input.gatheredAt ?? new Date().toISOString();
  const staleAfter = input.staleAfterDays
    ? new Date(Date.parse(gatheredAt) + input.staleAfterDays * 86_400_000).toISOString()
    : undefined;

  const requirements = markConflicts(input.requirements);

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    feature: input.feature,
    gatheredAt,
    staleAfter,
    sources: input.sources.map(({ content: _content, ...rest }) => rest),
    requirements,
    unknowns: input.unknowns,
    knownIssues: input.knownIssues,
    regressionHistory: input.regressionHistory,
    provenance: {
      agents: input.agents,
      connectors: input.connectors,
      coverage: {
        sourcesFound: input.sources.length,
        requirementsExplicit: requirements.filter((r) => r.confidence === "explicit").length,
        requirementsImplied: requirements.filter((r) => r.confidence === "implied").length,
        unknownCount: input.unknowns.length,
      },
    },
  };
}

/**
 * The oracle strength a context can support. PROVER reads this to know
 * whether a clean result means anything: a context with no explicit
 * requirements cannot produce a CONFIRMED finding against acceptance criteria,
 * however green the run looks.
 */
export function oracleCeiling(context: FeatureContext): {
  ceiling: "acceptance-criteria" | "code-intent" | "none";
  reason: string;
} {
  const explicit = context.requirements.filter((r) => r.confidence === "explicit").length;
  const usable = context.requirements.filter((r) => r.confidence !== "contested").length;

  if (explicit > 0) {
    return {
      ceiling: "acceptance-criteria",
      reason: `${explicit} explicit requirement(s) traced to quoted sources.`,
    };
  }
  if (usable > 0) {
    return {
      ceiling: "code-intent",
      reason: "Only implied requirements were found; nothing states the behaviour outright.",
    };
  }
  return {
    ceiling: "none",
    reason: `No usable requirements. ${context.unknowns.length} unknown(s) recorded instead: the fleet is testing blind.`,
  };
}
