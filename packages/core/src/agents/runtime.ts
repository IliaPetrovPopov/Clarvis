import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Budget, estimateUsd, type Usage } from "./budget.ts";
import { assertToolPolicy, type AgentDefinition } from "./definitions.ts";
import { normaliseAgentText } from "../text.ts";

/**
 * Agent invocation runtime.
 *
 * Everything that is not reasoning happens here, in plain code: budget
 * enforcement, output validation, retries, transcripts, redaction. The model is
 * reached through an `AgentRunner` interface so the whole runtime is testable
 * without a network call, which matters because these are exactly the paths
 * that must not be verified by hand.
 *
 * The governing rule is the same one that runs through the rest of the product:
 * a failure must never be representable as an empty success. Every terminal
 * state below is explicit, and none of them return data.
 */

export interface RawAgentResponse {
  text: string;
  usage: Usage;
  model: string;
  stopReason?: string;
  /**
   * Actual cost, when the transport reports one. Preferred over the local
   * estimate: a runner that knows the real figure - including cache overhead a
   * static price table cannot see - should not be second-guessed.
   */
  usdReported?: number;
}

export interface AgentRunner {
  invoke(request: {
    definition: AgentDefinition;
    prompt: string;
    /** Set on a retry: the reason the previous attempt was rejected. */
    previousError?: string;
    attempt: number;
  }): Promise<RawAgentResponse>;
}

export type AgentStatus =
  | "ok"
  | "invalid-output"
  | "budget-exceeded"
  | "runner-error"
  | "empty-output";

export interface AgentResult<T> {
  status: AgentStatus;
  /** Present only when status is "ok". A failed agent never yields data. */
  data?: T;
  agentId: string;
  role: string;
  fleet: string;
  model: string;
  attempts: number;
  usage: Usage;
  usdEstimate: number;
  transcriptPath?: string;
  error?: string;
}

export type Validator<T> = (parsed: unknown) => { ok: true; value: T } | { ok: false; error: string };

export interface RunAgentOptions<T> {
  runner: AgentRunner;
  definition: AgentDefinition;
  /** Task payload. Serialised into the prompt. */
  prompt: string;
  validate: Validator<T>;
  budget: Budget;
  /** Distinguishes concurrent invocations of the same role. */
  agentId?: string;
  maxAttempts?: number;
  /** Directory for the JSONL transcript. Omit to skip writing one. */
  transcriptDir?: string;
  /**
   * Applied to everything before it is written to disk. Transcripts are where
   * secrets leak: an agent's input may legitimately contain retrieved text that
   * happens to include a token.
   */
  redact?: (text: string) => string;
  /** Rough cost of one attempt, used to refuse before spending. */
  estimatedUsdPerAttempt?: number;
}

/**
 * Models wrap JSON in prose or fences more often than not, so this tries
 * progressively looser strategies rather than demanding a clean response.
 * Parsing is not the interesting failure - validation is.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Response was empty." };

  const attempt = (candidate: string) => {
    try {
      return { ok: true as const, value: JSON.parse(candidate) as unknown };
    } catch {
      return undefined;
    }
  };

  const direct = attempt(trimmed);
  if (direct) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    const parsed = attempt(fenced[1].trim());
    if (parsed) return parsed;
  }

  // Last resort: the first balanced object or array in the text. Scans with a
  // depth counter and skips string literals so braces inside strings do not
  // terminate the span early.
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    if (start === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const parsed = attempt(trimmed.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  return { ok: false, error: "No parseable JSON found in the response." };
}

async function writeTranscript(
  dir: string,
  agentId: string,
  entry: Record<string, unknown>,
  redact: (text: string) => string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${agentId}.jsonl`);
  // Redact the serialised form: a token can appear in any field, including one
  // added later by a caller who did not think about it.
  await appendFile(file, `${redact(JSON.stringify(entry))}\n`, "utf8");
  return file;
}

export async function runAgent<T>(opts: RunAgentOptions<T>): Promise<AgentResult<T>> {
  const { definition, budget, runner } = opts;

  // Refuse a misconfigured agent before it can run, not after.
  assertToolPolicy(definition);

  const agentId = opts.agentId ?? `${definition.role}-1`;
  const maxAttempts = opts.maxAttempts ?? 3;
  const redact = opts.redact ?? ((t: string) => t);
  const estimate = opts.estimatedUsdPerAttempt ?? definition.maxUsd / maxAttempts;

  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let usd = 0;
  let attempts = 0;
  let transcriptPath: string | undefined;
  let lastError = "";

  const note = async (entry: Record<string, unknown>) => {
    if (!opts.transcriptDir) return;
    transcriptPath = await writeTranscript(
      opts.transcriptDir,
      agentId,
      { at: new Date().toISOString(), agentId, role: definition.role, ...entry },
      redact,
    );
  };

  const finish = (status: AgentStatus, error?: string, data?: T): AgentResult<T> => ({
    status,
    data,
    agentId,
    role: definition.role,
    fleet: definition.fleet,
    model: definition.model,
    attempts,
    usage,
    usdEstimate: usd,
    transcriptPath,
    error,
  });

  await note({ event: "start", model: definition.model, tools: definition.tools, prompt: opts.prompt });

  while (attempts < maxAttempts) {
    // Reserved BEFORE spending, so a run stops at its ceiling rather than
    // discovering afterwards that it went past - and so concurrent agents
    // cannot each pass the same check against an untouched balance.
    const reservation = budget.reserve({
      fleet: definition.fleet,
      agentId,
      estimatedUsd: estimate,
    });

    if (!reservation.allowed) {
      await note({ event: "budget-refused", reason: reservation.reason, attempts });
      return finish("budget-exceeded", reservation.reason);
    }

    attempts++;

    let response: RawAgentResponse;
    try {
      response = await runner.invoke({
        definition,
        prompt: opts.prompt,
        previousError: lastError || undefined,
        attempt: attempts,
      });
    } catch (e) {
      // A failed call can still have spent money - an agent that ran out of
      // turns burned a full loop. Charge what it reported, and clear the rest of
      // the reservation so a run does not leak budget on every error.
      const spent = (e as { usdReported?: number }).usdReported ?? 0;
      const spentUsage = (e as { usage?: Usage }).usage;
      reservation.settle(spent);
      usd += spent;
      if (spentUsage) {
        usage.inputTokens += spentUsage.inputTokens;
        usage.outputTokens += spentUsage.outputTokens;
      }

      const message = redact(e instanceof Error ? e.message : String(e));
      await note({ event: "runner-error", attempt: attempts, error: message, usd: spent });
      return finish("runner-error", message);
    }

    // Charge every attempt, including ones that produce nothing usable. A retry
    // loop is exactly where unbilled spend would hide.
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    const attemptUsd = response.usdReported ?? estimateUsd(response.model, response.usage);
    usd += attemptUsd;
    reservation.settle(attemptUsd);

    await note({
      event: "response",
      attempt: attempts,
      stopReason: response.stopReason,
      usage: response.usage,
      usd: attemptUsd,
      text: response.text,
    });

    if (!response.text?.trim()) {
      lastError = "The response was empty.";
      continue;
    }

    // House style is applied here, before parsing, so every agent-authored
    // string downstream is already normalised - including ones added later by
    // a caller who never thought about it.
    const parsed = extractJson(normaliseAgentText(response.text));
    if (!parsed.ok) {
      lastError = parsed.error;
      await note({ event: "rejected", attempt: attempts, reason: parsed.error });
      continue;
    }

    const validated = opts.validate(parsed.value);
    if (!validated.ok) {
      lastError = validated.error;
      await note({ event: "rejected", attempt: attempts, reason: validated.error });
      continue;
    }

    await note({ event: "accepted", attempt: attempts, usd });
    return finish("ok", undefined, validated.value);
  }

  const reason = `Failed to produce valid output after ${attempts} attempt(s). Last problem: ${lastError}`;
  await note({ event: "exhausted", attempts, reason });
  return finish(lastError === "The response was empty." ? "empty-output" : "invalid-output", reason);
}
