import Anthropic from "@anthropic-ai/sdk";
import type { AgentDefinition } from "./definitions.ts";
import type { AgentRunner, RawAgentResponse } from "./runtime.ts";

/**
 * Concrete runner for agents that need no tools.
 *
 * Every DOSSIER agent reasons purely over text a connector already retrieved,
 * so the agentic loop buys nothing: a single Messages call is simpler, cheaper,
 * and has no surface through which an agent could reach anything. Tool-using
 * roles (PATHFINDER, CRUCIBLE) will need a separate runner built on the Agent
 * SDK; this one deliberately refuses them rather than silently dropping their
 * tools and producing a confidently useless answer.
 *
 * Auth is left to the SDK's own resolution order - `ANTHROPIC_API_KEY`, then
 * `ANTHROPIC_AUTH_TOKEN`, then an `ant auth login` profile. That last path is
 * what lets a user pay with the Claude plan they already have, which is the
 * whole reason Clarvis has no inference bill of its own.
 */

export interface MessagesRunnerOptions {
  client?: Anthropic;
  /** Structured output schema, keyed by agent role. Guarantees parseable JSON. */
  schemas?: Record<string, Record<string, unknown>>;
  /** Non-streaming ceiling. Kept under the SDK's HTTP timeout comfort zone. */
  maxTokens?: number;
  /** Effort per role. Judgement roles deserve more; extraction rarely does. */
  effort?: Record<string, "low" | "medium" | "high" | "xhigh" | "max">;
}

export class MessagesRunner implements AgentRunner {
  private readonly client: Anthropic;
  private readonly schemas: Record<string, Record<string, unknown>>;
  private readonly maxTokens: number;
  private readonly effort: Record<string, "low" | "medium" | "high" | "xhigh" | "max">;

  constructor(options: MessagesRunnerOptions = {}) {
    // A bare constructor picks up whichever credential source is configured.
    this.client = options.client ?? new Anthropic();
    this.schemas = options.schemas ?? {};
    this.maxTokens = options.maxTokens ?? 16_000;
    this.effort = options.effort ?? {};
  }

  supports(definition: AgentDefinition): boolean {
    return definition.tools.length === 0;
  }

  async invoke(request: {
    definition: AgentDefinition;
    prompt: string;
    previousError?: string;
    attempt: number;
  }): Promise<RawAgentResponse> {
    const { definition } = request;

    if (!this.supports(definition)) {
      throw new Error(
        `MessagesRunner cannot run "${definition.role}": it requires tools (${definition.tools.join(", ")}). ` +
          `Use a tool-capable runner rather than running it without them.`,
      );
    }

    // On a retry, the previous rejection is stated plainly as the first thing
    // the model sees. Burying it below the task tends to produce the same
    // mistake a second time.
    const userContent = request.previousError
      ? [
          "Your previous response was rejected.",
          `Reason: ${request.previousError}`,
          "",
          "Return only valid JSON matching the required shape. Do not explain.",
          "",
          request.prompt,
        ].join("\n")
      : request.prompt;

    const schema = this.schemas[definition.role];

    const response = await this.client.messages.create({
      model: definition.model,
      max_tokens: this.maxTokens,
      system: definition.systemPrompt,
      messages: [{ role: "user", content: userContent }],
      // Adaptive thinking: these are judgement tasks, and the model decides how
      // much deliberation each one needs.
      thinking: { type: "adaptive" },
      output_config: {
        ...(this.effort[definition.role] ? { effort: this.effort[definition.role] } : {}),
        // Structured output constrains the response to the schema, so malformed
        // JSON stops being a failure mode the retry loop has to absorb.
        ...(schema ? { format: { type: "json_schema" as const, schema } } : {}),
      },
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // A refusal is a real outcome with a real cause, and must not be reported
    // as an empty answer.
    if (response.stop_reason === "refusal") {
      throw new Error(
        `The model declined this request (${response.stop_details?.category ?? "unspecified"}). ` +
          `This is a safety refusal, not an empty result.`,
      );
    }

    return {
      text,
      model: response.model,
      stopReason: response.stop_reason ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/**
 * Schemas for the tool-less roles. Kept beside the runner rather than in the
 * agent definitions because they describe the wire contract, not the agent's
 * job, and because structured output is a property of how it is invoked.
 */
export const DOSSIER_SCHEMAS: Record<string, Record<string, unknown>> = {
  "dossier-extract": {
    type: "object",
    additionalProperties: false,
    required: ["requirements", "unknowns"],
    properties: {
      requirements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "statement", "quote", "sourceIds", "confidence"],
          properties: {
            id: { type: "string" },
            statement: { type: "string" },
            quote: { type: "string" },
            sourceIds: { type: "array", items: { type: "string" } },
            confidence: { type: "string", enum: ["explicit", "implied"] },
            axisHints: { type: "array", items: { type: "string" } },
          },
        },
      },
      unknowns: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question"],
          properties: {
            question: { type: "string" },
            why: { type: "string" },
            guess: { type: "string" },
            blocksAxes: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },

  "dossier-entail": {
    type: "object",
    additionalProperties: false,
    required: ["entailed", "confidence", "reason"],
    properties: {
      entailed: { type: "boolean" },
      confidence: { type: "string", enum: ["explicit", "implied", "contested"] },
      reason: { type: "string" },
    },
  },

  "dossier-synthesis": {
    type: "object",
    additionalProperties: false,
    required: ["summary", "unknowns"],
    properties: {
      summary: { type: "string" },
      unknowns: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question"],
          properties: {
            question: { type: "string" },
            why: { type: "string" },
            guess: { type: "string" },
          },
        },
      },
    },
  },
};

/**
 * Output shapes for every role, including the tool-using ones.
 *
 * The Messages API enforces these directly. `ClaudeCodeRunner` has no such
 * mechanism, so it states them in the prompt instead - which is why they are
 * defined for tool-using roles too, even though those never reach the Messages
 * API. A role with no schema answers in whatever shape it likes and burns its
 * retries converging on the right one.
 */
export const AGENT_SCHEMAS: Record<string, Record<string, unknown>> = {
  ...DOSSIER_SCHEMAS,

  "pathfinder-boot": {
    type: "object",
    required: ["url"],
    properties: {
      cmd: { type: "string", description: "Command that starts the app." },
      cwd: { type: "string" },
      url: { type: "string", description: "Absolute URL the app serves, e.g. http://localhost:3000" },
      readyCheck: { type: "string", description: "A URL or absolute path. Fetched verbatim. Never prose." },
      readyTimeoutMs: { type: "number" },
      evidence: { type: "string" },
      blockers: {
        type: "array",
        items: { type: "string" },
        description: "Only things that stop you naming a command or URL. Empty if you named both.",
      },
    },
  },

  "pathfinder-auth": {
    type: "object",
    required: ["mode", "roles"],
    properties: {
      mode: {
        type: "string",
        enum: ["none", "cookie-session", "cookie-jwt", "bearer-localstorage", "basic", "custom"],
      },
      loginUrl: { type: "string" },
      apiLogin: {
        type: "object",
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["POST", "GET"] },
          bodyTemplate: { type: "object" },
        },
      },
      roles: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "username", "password", "sourceFile"],
          properties: {
            key: { type: "string", description: 'Short name a human recognises: "admin", "viewer".' },
            label: { type: "string" },
            username: { type: "string" },
            password: { type: "string" },
            sourceFile: { type: "string" },
            expectedDenied: { type: "array", items: { type: "string" } },
          },
        },
      },
      notes: { type: "string" },
    },
  },

  "pathfinder-safety": {
    type: "object",
    required: ["forbiddenHosts"],
    properties: {
      forbiddenHosts: { type: "array", items: { type: "string" } },
      disposableRecommendation: { type: "boolean" },
      reasoning: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            host: { type: "string" },
            classification: { type: "string" },
            why: { type: "string" },
          },
        },
      },
    },
  },

  "pathfinder-taxonomy": {
    type: "object",
    required: ["axes"],
    properties: {
      axes: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "title", "brief", "commits"],
          properties: {
            key: { type: "string" },
            title: { type: "string" },
            brief: { type: "string", description: "Handed to whoever writes the tests." },
            commits: {
              type: "array",
              items: { type: "string" },
              description: "shortShas you were actually shown. At least two.",
            },
            refines: { type: "string", description: "A standard axis this extends, if any." },
            mutating: { type: "boolean" },
          },
        },
      },
      irrelevantStandardAxes: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } },
    },
  },

  "vector-plan": {
    type: "object",
    required: ["axes", "deferred", "rationale"],
    properties: {
      axes: {
        type: "array",
        items: {
          type: "object",
          required: ["axis", "why"],
          properties: {
            axis: { type: "string" },
            why: { type: "string" },
            routes: { type: "array", items: { type: "string" } },
            roles: { type: "array", items: { type: "string" } },
            requirementIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      deferred: {
        type: "array",
        items: {
          type: "object",
          required: ["axis", "why", "cost"],
          properties: {
            axis: { type: "string" },
            why: { type: "string" },
            cost: { type: "string", description: "What a human loses by this axis not running." },
          },
        },
      },
      rationale: { type: "string" },
    },
  },

  "crucible-author": {
    type: "object",
    required: ["source", "covers", "untested"],
    properties: {
      source: { type: "string", description: "The complete spec file." },
      covers: { type: "array", items: { type: "string" } },
      untested: {
        type: "array",
        items: {
          type: "object",
          required: ["reason"],
          properties: { requirementId: { type: "string" }, reason: { type: "string" } },
        },
      },
    },
  },

  "crucible-triage": {
    type: "object",
    required: ["fault", "reason"],
    properties: {
      fault: { type: "string", enum: ["application", "spec", "environment", "unclear"] },
      reason: { type: "string" },
      confidence: { type: "string" },
      inspected: { type: "array", items: { type: "string" }, description: "Files you actually opened." },
    },
  },

  "dispatch-draft": {
    type: "object",
    required: ["title", "body", "steps"],
    properties: {
      title: { type: "string", description: "Names the defect, not the rule." },
      body: { type: "string" },
      steps: { type: "array", items: { type: "string" } },
      labels: { type: "array", items: { type: "string" } },
    },
  },

  "clearance-notes": {
    type: "object",
    required: ["summary", "limits"],
    properties: {
      summary: { type: "string" },
      notes: { type: "string", description: "Markdown. Empty unless the verdict is ship." },
      limits: { type: "array", items: { type: "string" }, description: "Never empty." },
    },
  },
};
