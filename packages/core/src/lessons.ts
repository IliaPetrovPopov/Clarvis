import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { clarvisPaths } from "./store.ts";
import type { Finding, Run } from "./types.ts";
import type { Budget } from "./agents/budget.ts";
import { getAgent } from "./agents/definitions.ts";
import { runAgent, type AgentResult, type AgentRunner } from "./agents/runtime.ts";

/**
 * The fleet learning from its own mistakes.
 *
 * Two labelled signals already existed and were both thrown away at the end of
 * every run. The gate rejects a spec and says exactly what was wrong with it.
 * Triage examines a failure and rules `fault: "spec"` - the test was wrong, not
 * the product - and writes a paragraph explaining precisely how. Both are the
 * author being told it made a mistake, in detail, by something that is not the
 * author. That is as clean a training signal as this system will ever get, and
 * it was being deleted with the run.
 *
 * So it is kept, generalised into a short lesson, and put in front of the
 * author next time.
 *
 * WHAT THIS DELIBERATELY IS NOT
 *
 * Agents do not edit their own prompts, their own code, or their own rules. An
 * agent that could rewrite the standard it is judged against would drift
 * towards whatever made its own output look good, and nothing downstream would
 * notice - which is the silent-green failure this entire product is built to
 * prevent. Letting the tester tune the test is the same mistake as letting it
 * modify the application.
 *
 * What an agent may do is propose a sentence, from evidence, that code then
 * validates and stores. The bracketing rule is unchanged:
 *
 *   code (collect the failures) -> agent (name the pattern) -> code (check it)
 *
 * A lesson must cite the run and the specific failure it came from. It must be
 * short enough to read. It may not contradict a safety rule - those are
 * enforced by the gate and the guard, and a lesson that argued with one would
 * be an agent legislating for itself. And it earns its place: a lesson whose
 * mistake stops recurring is retired, so the brief does not accumulate advice
 * about problems nobody has any more.
 */

export const LESSONS_SCHEMA_VERSION = 1 as const;

export interface Lesson {
  id: string;
  /** The instruction, as it will be given to the author. One or two sentences. */
  text: string;
  /** What went wrong that produced it. Never a summary - the actual failure. */
  evidence: {
    runId: string;
    /** "gate" when the spec was rejected, "triage" when the test was at fault. */
    from: "gate" | "triage";
    detail: string;
  };
  learnedAt: string;
  /** Runs since it was added in which the same mistake recurred. */
  recurrences: number;
  /** Consecutive runs with no recurrence. A lesson that stops earning retires. */
  quietRuns: number;
}

export interface Lessons {
  schemaVersion: typeof LESSONS_SCHEMA_VERSION;
  updatedAt: string;
  lessons: Lesson[];
  /** Retired, kept so a returning problem is recognised rather than relearned. */
  retired: Array<{ text: string; why: string }>;
}

const EMPTY: Lessons = {
  schemaVersion: LESSONS_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
  lessons: [],
  retired: [],
};

/**
 * A lesson may never argue with a rule that exists to keep a run honest.
 *
 * These are the things the gate and the guard enforce. An agent proposing that
 * the author should assert on visibility instead of a response, or skip a
 * flaky test, or log in by hand, is proposing to make its own life easier at
 * the cost of the result being worth anything. Code refuses; the agent does
 * not get a vote.
 */
const FORBIDDEN = [
  /*
    Either order, and a pronoun counts as the object.

    The first version required the noun to follow the verb, so "if a test is
    flaky, skip it" passed - which is both the most tempting proposal an
    author could make and the most corrosive, because a suite that skips what
    it cannot make pass reports green forever while testing less every week.
  */
  {
    re: /\b(skip|disable|remove|ignore|drop)\b[^.]{0,40}\b(it|them|that|this|test|tests|assertion|check|axis|case)\b/i,
    why: "proposes skipping a check",
  },
  {
    re: /\b(test|assertion|check|axis|case)\b[^.]{0,40}\b(skip|disable|remove|ignore|drop)\b/i,
    why: "proposes skipping a check",
  },
  { re: /\bflaky\b[^.]{0,40}\b(skip|ignore|remove|disable|tolerate|accept)\b/i, why: "proposes tolerating flakiness rather than fixing it" },
  { re: /\btest\.(skip|only|fixme)\b/i, why: "proposes a disabled or focused test" },
  { re: /\b(toBeVisible|visibility)\b.{0,40}\binstead of\b/i, why: "proposes a visibility check in place of a real assertion" },
  { re: /\b(log|sign)\s?in\b.{0,40}\b(manually|yourself|in the spec)\b/i, why: "proposes writing a login flow" },
  { re: /\b(catch|swallow|ignore)\b.{0,30}\berror\b/i, why: "proposes swallowing a failure" },
  { re: /\b(loosen|relax|widen)\b.{0,30}\b(gate|guard|rule|assertion)\b/i, why: "proposes weakening a safety rule" },
  { re: /\bforbiddenHosts?\b|\bdisposable\b|\bsafeTargets?\b/i, why: "touches the safety guard" },
];

/** The longest a lesson may be. Advice nobody reads changes nothing. */
const MAX_LENGTH = 240;

export interface Rejection {
  text: string;
  why: string;
}

/**
 * Decide whether a proposed lesson may be kept.
 *
 * Deliberately strict and entirely code. This is the check that stops the
 * fleet from teaching itself to be easier on itself.
 */
export function vetLesson(
  text: string,
  existing: Lesson[] = [],
): { ok: true; text: string } | { ok: false; why: string } {
  const trimmed = text.trim().replace(/\s+/g, " ");

  if (trimmed.length < 20) return { ok: false, why: "too short to be an instruction" };
  if (trimmed.length > MAX_LENGTH) {
    return { ok: false, why: `longer than ${MAX_LENGTH} characters, so it will not be read` };
  }

  for (const { re, why } of FORBIDDEN) {
    if (re.test(trimmed)) return { ok: false, why };
  }

  // Near-duplicates are worse than useless: they crowd the brief and make the
  // author weigh the same point twice.
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const incoming = words(trimmed);
  for (const lesson of existing) {
    const other = words(lesson.text);
    const shared = [...incoming].filter((w) => other.has(w)).length;
    const overlap = shared / Math.max(1, Math.min(incoming.size, other.size));
    if (overlap > 0.7) return { ok: false, why: `almost the same as an existing lesson: "${lesson.text}"` };
  }

  return { ok: true, text: trimmed };
}

/* ---------------------------------------------------------------- gather */

export interface MistakeEvidence {
  from: "gate" | "triage";
  detail: string;
}

/**
 * The mistakes a run made, as opposed to the ones it found.
 *
 * Only failures attributable to the author. A finding triage ruled to be the
 * application's fault is the system working, not a lesson.
 */
export function mistakesFrom(
  run: Run,
  rejected: Array<{ axis: string; violations: string[] }> = [],
): MistakeEvidence[] {
  const out: MistakeEvidence[] = [];

  for (const r of rejected) {
    for (const v of r.violations) {
      out.push({ from: "gate", detail: `[${r.axis}] the gate refused the spec: ${v.split("\n")[0]}` });
    }
  }

  for (const f of run.findings ?? []) {
    // `spec` is triage saying the test was wrong. That is the author being
    // corrected by something with no stake in its output.
    const fault = (f as Finding & { fault?: string }).fault;
    const discardedAsTestFault =
      f.tier === "DISCARDED" && /fault is in the test|not the product|test-authoring/i.test(f.tierReason ?? "");

    if (fault === "spec" || discardedAsTestFault) {
      out.push({
        from: "triage",
        detail: `[${f.axis}] "${f.title}" - ${(f.tierReason ?? "").slice(0, 400)}`,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ store */

export async function loadLessons(projectRoot: string): Promise<Lessons> {
  const file = path.join(clarvisPaths(projectRoot).root, "lessons.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as Lessons;
  } catch {
    return { ...EMPTY, lessons: [], retired: [] };
  }
}

export async function saveLessons(projectRoot: string, lessons: Lessons): Promise<string> {
  const paths = clarvisPaths(projectRoot);
  await mkdir(paths.root, { recursive: true });
  const file = path.join(paths.root, "lessons.json");
  await writeFile(file, JSON.stringify(lessons, null, 2), "utf8");
  return file;
}

/**
 * How many quiet runs before a lesson is retired.
 *
 * Long enough that a rare mistake is not forgotten between sightings, short
 * enough that the brief does not fill with advice about problems the author
 * has not made in months - every line in the brief costs attention that the
 * remaining lines need.
 */
export const RETIRE_AFTER_QUIET_RUNS = 12;

/**
 * Age the ledger against a run that just happened.
 *
 * A lesson whose mistake recurred is reinforced; one that has been quiet long
 * enough is retired with its reason kept, so the same problem returning is
 * recognised rather than learned from scratch.
 */
export function ageLessons(lessons: Lessons, mistakes: MistakeEvidence[], now = new Date()): Lessons {
  const seen = mistakes.map((m) => m.detail.toLowerCase()).join(" ");
  const kept: Lesson[] = [];
  const retired = [...lessons.retired];

  for (const lesson of lessons.lessons) {
    // Crude but honest: did anything this run resemble what this lesson is
    // about? A false negative retires a lesson early, which costs one repeat.
    const key = (lesson.text.toLowerCase().match(/[a-z]{5,}/g) ?? []).slice(0, 6);
    const recurred = key.length > 0 && key.filter((w) => seen.includes(w)).length >= Math.ceil(key.length / 2);

    const next: Lesson = recurred
      ? { ...lesson, recurrences: lesson.recurrences + 1, quietRuns: 0 }
      : { ...lesson, quietRuns: lesson.quietRuns + 1 };

    if (next.quietRuns >= RETIRE_AFTER_QUIET_RUNS) {
      retired.push({
        text: next.text,
        why: `No sign of this mistake in ${RETIRE_AFTER_QUIET_RUNS} runs.`,
      });
    } else {
      kept.push(next);
    }
  }

  return { ...lessons, updatedAt: now.toISOString(), lessons: kept, retired };
}

/* ------------------------------------------------------------------ learn */

interface Proposal {
  lessons?: Array<{ text?: string; evidenceIndex?: number }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function validate(parsed: unknown): { ok: true; value: Proposal } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (!Array.isArray(parsed.lessons)) return { ok: false, error: "'lessons' must be an array." };
  return { ok: true, value: parsed as Proposal };
}

export interface LearnOptions {
  run: Run;
  mistakes: MistakeEvidence[];
  existing: Lessons;
  runner: AgentRunner;
  budget: Budget;
  transcriptDir?: string;
  redact?: (text: string) => string;
  now?: Date;
}

export interface LearnResult {
  lessons: Lessons;
  added: Lesson[];
  refused: Rejection[];
  agentRuns: Array<AgentResult<unknown>>;
  usdEstimate: number;
}

/**
 * Turn this run's mistakes into instructions for the next one.
 *
 * The agent's only job is to name the pattern behind a concrete failure. It
 * cannot decide what a lesson is allowed to say - `vetLesson` does, in code,
 * and refuses anything that would make the author's job easier at the cost of
 * the result meaning anything.
 */
export async function learnFromRun(opts: LearnOptions): Promise<LearnResult> {
  const now = opts.now ?? new Date();
  const agentRuns: Array<AgentResult<unknown>> = [];
  const refused: Rejection[] = [];
  const added: Lesson[] = [];

  // Aged first, so a lesson learned this run is not immediately marked quiet.
  const aged = ageLessons(opts.existing, opts.mistakes, now);

  if (!opts.mistakes.length) {
    return { lessons: aged, added, refused, agentRuns, usdEstimate: 0 };
  }

  const prompt = [
    "These are mistakes made by the spec author on one run, as judged by",
    "something other than the author: the static gate that refused a spec, and",
    "triage, which decided a failure was the test's fault rather than the",
    "application's.",
    "",
    "MISTAKES:",
    ...opts.mistakes.map((m, i) => `  [${i}] (${m.from}) ${m.detail}`),
    "",
    opts.existing.lessons.length
      ? `ALREADY KNOWN, do not repeat these:\n${opts.existing.lessons.map((l) => `  - ${l.text}`).join("\n")}`
      : "Nothing has been learned here before.",
    "",
    "Write at most three instructions that would have prevented these specific",
    "mistakes. Each must be general enough to apply next time and concrete",
    "enough to act on. Cite which mistake it came from by index.",
    "",
    "Do not propose skipping a test, weakening an assertion, or relaxing any",
    "rule - those are refused in code, and a proposal like that is a wasted",
    "slot. Write what the author should DO instead.",
    "",
    "Return JSON: { lessons: [{ text, evidenceIndex }] }.",
  ].join("\n");

  const result = await runAgent<Proposal>({
    runner: opts.runner,
    definition: getAgent("prover-learn"),
    prompt,
    validate,
    budget: opts.budget,
    transcriptDir: opts.transcriptDir,
    redact: opts.redact,
  });
  agentRuns.push(result as AgentResult<unknown>);

  if (result.status !== "ok" || !result.data) {
    return { lessons: aged, added, refused, agentRuns, usdEstimate: result.usdEstimate };
  }

  const pool = [...aged.lessons];

  for (const [i, proposed] of (result.data.lessons ?? []).entries()) {
    const text = typeof proposed?.text === "string" ? proposed.text : "";
    const verdict = vetLesson(text, pool);

    if (!verdict.ok) {
      refused.push({ text: text.slice(0, 120), why: verdict.why });
      continue;
    }

    // Every lesson carries the failure it came from, so a human can check that
    // the pattern is real rather than a plausible-sounding generalisation.
    const evidence = opts.mistakes[proposed?.evidenceIndex ?? -1] ?? opts.mistakes[0];

    const lesson: Lesson = {
      id: `${opts.run.runId}-l${i + 1}`,
      text: verdict.text,
      evidence: { runId: opts.run.runId, from: evidence.from, detail: evidence.detail.slice(0, 500) },
      learnedAt: now.toISOString(),
      recurrences: 0,
      quietRuns: 0,
    };

    pool.push(lesson);
    added.push(lesson);
  }

  return {
    lessons: { ...aged, updatedAt: now.toISOString(), lessons: pool },
    added,
    refused,
    agentRuns,
    usdEstimate: result.usdEstimate,
  };
}

/** The lessons, as they are handed to the spec author. */
export function renderLessons(lessons: Lessons): string {
  if (!lessons.lessons.length) return "";

  // Most-recurred first: a mistake made four times deserves to be read before
  // one made once.
  const ordered = [...lessons.lessons].sort((a, b) => b.recurrences - a.recurrences);

  return [
    "",
    "LEARNED HERE BEFORE. These come from specs this project's author actually",
    "got wrong, as judged by the gate or by triage. They are not style notes.",
    ...ordered.map(
      (l) => `  - ${l.text}${l.recurrences ? `   (made this mistake ${l.recurrences + 1} times)` : ""}`,
    ),
  ].join("\n");
}
