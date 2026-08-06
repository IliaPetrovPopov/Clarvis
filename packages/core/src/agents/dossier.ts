import {
  applyEntailment,
  buildContext,
  verifyRequirements,
  type ContextSource,
  type FeatureContext,
  type Requirement,
  type Unknown,
} from "../context.ts";
import { findDocs, looksNormative } from "../connectors/docs.ts";
import type { GitConnector } from "../connectors/git.ts";
import type { FeatureScope, ScopeConfig } from "../scope.ts";
import type { Budget } from "./budget.ts";
import { getAgent } from "./definitions.ts";
import { runAgent, type AgentResult, type AgentRunner } from "./runtime.ts";

/**
 * DOSSIER: assemble what a feature is supposed to do.
 *
 * The pipeline is deliberately shaped so that the model's contribution is
 * bracketed on both sides by deterministic code:
 *
 *   gather (code) -> propose (agent) -> verify quotes (code)
 *                 -> judge entailment (a DIFFERENT agent) -> assemble (code)
 *
 * An agent can therefore phrase a requirement, but it cannot introduce one. The
 * quote check is mechanical, and the entailment check is made by a verifier
 * that never sees the feature, the code, or who made the claim - so agreeing is
 * not the path of least resistance.
 *
 * Everything discarded is reported. A context that quietly got thinner is
 * indistinguishable from a thorough one, and that is the failure this whole
 * product exists to prevent.
 */

export interface DossierReport {
  sourcesGathered: number;
  connectors: Array<{ name: string; status: string; note?: string }>;
  proposed: number;
  rejectedQuotes: Array<{ id: string; code: string; detail: string }>;
  demotedEntailment: Array<{ id: string; statement: string; reason: string }>;
  accepted: number;
  agentRuns: Array<AgentResult<unknown>>;
  usdEstimate: number;
  warnings: string[];
}

interface ExtractOutput {
  requirements: Array<Omit<Requirement, "conflictsWith">>;
  unknowns: Unknown[];
}

/** Documentation states intent; commits mostly record activity. Keep the ratio sane. */
const MAX_COMMIT_SOURCES = 12;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function validateExtract(parsed: unknown): { ok: true; value: ExtractOutput } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (!Array.isArray(parsed.requirements)) return { ok: false, error: "Missing array field 'requirements'." };
  if (!Array.isArray(parsed.unknowns)) return { ok: false, error: "Missing array field 'unknowns'." };

  for (const [i, raw] of parsed.requirements.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `requirements[${i}] is not an object.` };
    for (const field of ["id", "statement", "quote"]) {
      if (typeof raw[field] !== "string" || !(raw[field] as string).trim()) {
        return { ok: false, error: `requirements[${i}].${field} must be a non-empty string.` };
      }
    }
    if (!Array.isArray(raw.sourceIds) || raw.sourceIds.length === 0) {
      return {
        ok: false,
        error: `requirements[${i}].sourceIds must list at least one source id. If nothing states it, put it in 'unknowns' instead.`,
      };
    }
  }

  return { ok: true, value: parsed as unknown as ExtractOutput };
}

function validateEntail(
  parsed: unknown,
): { ok: true; value: { entailed: boolean; confidence: "explicit" | "implied" | "contested"; reason: string } } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (typeof parsed.entailed !== "boolean") return { ok: false, error: "'entailed' must be a boolean." };
  if (typeof parsed.reason !== "string") return { ok: false, error: "'reason' must be a string." };
  const confidence = parsed.confidence === "implied" ? "implied" : "explicit";
  return { ok: true, value: { entailed: parsed.entailed, confidence, reason: parsed.reason } };
}

/** Sources, gathered by code. No agent reaches any of these. */
export async function gatherSources(opts: {
  projectRoot: string;
  scope: FeatureScope;
  git?: GitConnector;
  config?: ScopeConfig;
  maxDocSections?: number;
}): Promise<{
  sources: ContextSource[];
  connectors: DossierReport["connectors"];
  regressions: NonNullable<FeatureContext["regressionHistory"]>;
}> {
  const sources: ContextSource[] = [];
  const connectors: DossierReport["connectors"] = [];
  const regressions: NonNullable<FeatureContext["regressionHistory"]> = [];
  let n = 0;

  const docs = await findDocs({
    projectRoot: opts.projectRoot,
    keywords: opts.scope.keywords,
    paths: opts.scope.paths,
    config: opts.config,
    maxSections: opts.maxDocSections ?? 24,
  });

  connectors.push({
    name: "filesystem",
    status: docs.status,
    note: `${docs.filesScanned} document(s) scanned, ${docs.sections.length} relevant section(s).`,
  });

  for (const section of docs.sections) {
    sources.push({
      id: `s${++n}`,
      type: "readme",
      // file:line, so a human can open the exact place the quote came from.
      ref: `${section.file}:${section.line}`,
      title: section.heading || section.file,
      content: section.text,
    });
  }

  if (opts.git && (await opts.git.isRepo())) {
    const commits = await opts.git.findCommits({
      keywords: opts.scope.keywords.slice(0, 4),
      paths: opts.scope.paths.slice(0, 20),
      limit: 40,
    });

    const eligible = commits.data.length;

    let kept = 0;
    for (const commit of commits.data) {
      const body = `${commit.subject}\n${commit.body}`.trim();

      // A commit is only a requirement source if it states a rule or explains
      // itself at length. Accepting every commit that merely has a body floods
      // the prompt with routine history and crowds out the documentation that
      // actually specifies behaviour.
      const substantial = commit.body.trim().length > 120;
      if (!looksNormative(body) && !substantial) continue;
      if (kept >= MAX_COMMIT_SOURCES) {
        break;
      }
      kept++;

      sources.push({
        id: `s${++n}`,
        type: "commit-message",
        ref: commit.shortSha,
        title: commit.subject,
        author: commit.author,
        updatedAt: commit.date,
        content: body,
      });
    }

    connectors.push({
      name: "git",
      status: commits.status,
      note:
        `${eligible} related commit(s), ${kept} kept as sources` +
        (eligible > kept ? ` (${eligible - kept} were routine history).` : "."),
    });

    const regressed = await opts.git.findRegressions({
      keywords: opts.scope.keywords.slice(0, 4),
      paths: opts.scope.paths.slice(0, 20),
    });
    regressions.push(...regressed.data.slice(0, 15));
  } else {
    connectors.push({ name: "git", status: "not-configured", note: "Not a git repository." });
  }

  return { sources, connectors, regressions };
}

function renderSources(
  sources: ContextSource[],
  limit = 60_000,
): { text: string; included: number } {
  const parts: string[] = [];
  let budget = limit;
  let included = 0;

  for (const s of sources) {
    const body = (s.content ?? "").slice(0, 4000);
    const block = `--- SOURCE ${s.id} (${s.type}) ref=${s.ref}${s.title ? ` title=${s.title}` : ""}\n${body}\n`;
    if (block.length > budget) break;
    budget -= block.length;
    included++;
    parts.push(block);
  }

  return { text: parts.join("\n"), included };
}

export async function runDossier(opts: {
  projectRoot: string;
  scope: FeatureScope;
  runner: AgentRunner;
  budget: Budget;
  git?: GitConnector;
  config?: ScopeConfig;
  transcriptDir?: string;
  redact?: (text: string) => string;
  staleAfterDays?: number;
}): Promise<{ context: FeatureContext; report: DossierReport }> {
  const warnings: string[] = [];
  const agentRuns: Array<AgentResult<unknown>> = [];

  const { sources, connectors, regressions } = await gatherSources({
    projectRoot: opts.projectRoot,
    scope: opts.scope,
    git: opts.git,
    config: opts.config,
  });

  const emptyContext = (extraUnknowns: Unknown[] = []) =>
    buildContext({
      feature: {
        key: opts.scope.key,
        title: opts.scope.title,
        trackerKeys: opts.scope.trackerKeys,
      },
      sources,
      requirements: [],
      unknowns: extraUnknowns,
      regressionHistory: regressions,
      connectors,
      agents: agentRuns.map((r) => r.agentId),
      staleAfterDays: opts.staleAfterDays,
    });

  if (!sources.length) {
    warnings.push(
      "No sources were found for this feature. Nothing states what it should do, so no oracle can be produced.",
    );
    return {
      context: emptyContext([
        {
          question: `What is "${opts.scope.title}" supposed to do?`,
          why: "No ticket, document or commit message describing it was found.",
          blocksAxes: ["happy-path", "rbac-scope"],
        },
      ]),
      report: {
        sourcesGathered: 0,
        connectors,
        proposed: 0,
        rejectedQuotes: [],
        demotedEntailment: [],
        accepted: 0,
        agentRuns,
        usdEstimate: 0,
        warnings,
      },
    };
  }

  /* --- propose (agent) -------------------------------------------------- */

  const rendered = renderSources(sources);
  if (rendered.included < sources.length) {
    // Sources dropped for prompt size are a real limit on the oracle, so the
    // context must say so rather than appearing to have read everything.
    warnings.push(
      `Only ${rendered.included} of ${sources.length} sources fitted in the extraction prompt. ` +
        `Narrow the scope for a more thorough context.`,
    );
  }

  const extractPrompt = [
    `FEATURE: ${opts.scope.title}`,
    opts.scope.keywords.length ? `KEYWORDS: ${opts.scope.keywords.join(", ")}` : "",
    opts.scope.routes.length ? `ROUTES: ${opts.scope.routes.join(", ")}` : "",
    "",
    "Below are sources retrieved from this project. Propose requirements that",
    "are stated by these sources, each with a quote copied exactly from one of",
    "them. Anything not stated goes in 'unknowns'.",
    "",
    rendered.text,
  ]
    .filter(Boolean)
    .join("\n");

  const extract = await runAgent<ExtractOutput>({
    runner: opts.runner,
    definition: getAgent("dossier-extract"),
    prompt: extractPrompt,
    validate: validateExtract,
    budget: opts.budget,
    transcriptDir: opts.transcriptDir,
    redact: opts.redact,
  });
  agentRuns.push(extract as AgentResult<unknown>);

  if (extract.status !== "ok" || !extract.data) {
    warnings.push(
      `Requirement extraction did not complete (${extract.status}): ${extract.error ?? "no detail"}. ` +
        `No requirements were produced, so the fleet has no oracle for this feature.`,
    );
    return {
      context: emptyContext([
        {
          question: `What is "${opts.scope.title}" supposed to do?`,
          why: `Extraction failed: ${extract.status}.`,
        },
      ]),
      report: {
        sourcesGathered: sources.length,
        connectors,
        proposed: 0,
        rejectedQuotes: [],
        demotedEntailment: [],
        accepted: 0,
        agentRuns,
        usdEstimate: extract.usdEstimate,
        warnings,
      },
    };
  }

  const proposed = extract.data.requirements as Requirement[];
  const unknowns: Unknown[] = [...(extract.data.unknowns ?? [])];

  /* --- verify quotes (code) --------------------------------------------- */

  const { accepted: quoted, rejected } = verifyRequirements(proposed, sources);

  for (const r of rejected) {
    // A rejected requirement is not deleted: it becomes a recorded gap, so the
    // context shows where the agent over-reached rather than hiding it.
    const original = proposed.find((p) => p.id === r.requirementId);
    unknowns.push({
      question: original?.statement ?? `Rejected requirement ${r.requirementId}`,
      why: `Not usable as an oracle: ${r.detail}`,
      guess: original?.statement,
    });
  }

  if (rejected.some((r) => r.code === "quote-not-found")) {
    warnings.push(
      `${rejected.filter((r) => r.code === "quote-not-found").length} requirement(s) cited a quote that does not appear in the source. Treat this run's extraction with suspicion.`,
    );
  }

  /* --- judge entailment (a different agent) ------------------------------ */

  const demotedEntailment: DossierReport["demotedEntailment"] = [];

  const verifier = {
    async check(input: { quote: string; statement: string }) {
      const result = await runAgent({
        runner: opts.runner,
        definition: getAgent("dossier-entail"),
        // Only the two strings. No feature, no code, no provenance.
        prompt: `QUOTE:\n${input.quote}\n\nSTATEMENT:\n${input.statement}`,
        validate: validateEntail,
        budget: opts.budget,
        agentId: `dossier-entail-${demotedEntailment.length + agentRuns.length}`,
        transcriptDir: opts.transcriptDir,
        redact: opts.redact,
      });
      agentRuns.push(result as AgentResult<unknown>);

      if (result.status !== "ok" || !result.data) {
        // If entailment cannot be judged, the requirement does not get the
        // benefit of the doubt.
        return {
          entailed: false,
          confidence: "implied" as const,
          reason: `Entailment could not be verified (${result.status}).`,
        };
      }
      return result.data;
    },
  };

  const { accepted: entailed, demoted } = await applyEntailment(quoted, verifier);

  for (const d of demoted) {
    demotedEntailment.push({
      id: d.requirement.id,
      statement: d.requirement.statement,
      reason: d.reason,
    });
    unknowns.push({
      question: d.requirement.statement,
      why: `The quote does not support this: ${d.reason}`,
      guess: d.requirement.statement,
    });
  }

  /* --- assemble (code) --------------------------------------------------- */

  const context = buildContext({
    feature: {
      key: opts.scope.key,
      title: opts.scope.title,
      trackerKeys: opts.scope.trackerKeys,
    },
    sources,
    requirements: entailed,
    unknowns,
    regressionHistory: regressions,
    connectors,
    agents: agentRuns.map((r) => r.agentId),
    staleAfterDays: opts.staleAfterDays,
  });

  const usd = agentRuns.reduce((sum, r) => sum + r.usdEstimate, 0);

  if (!entailed.length) {
    warnings.push(
      "No requirement survived verification. The QA fleet will have no oracle and every finding will cap at code intent.",
    );
  }

  return {
    context,
    report: {
      sourcesGathered: sources.length,
      connectors,
      proposed: proposed.length,
      rejectedQuotes: rejected.map((r) => ({ id: r.requirementId, code: r.code, detail: r.detail })),
      demotedEntailment,
      accepted: entailed.length,
      agentRuns,
      usdEstimate: usd,
      warnings,
    },
  };
}
