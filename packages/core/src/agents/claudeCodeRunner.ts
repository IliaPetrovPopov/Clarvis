import { spawn } from "node:child_process";
import type { AgentDefinition, AgentTool } from "./definitions.ts";
import type { AgentRunner, RawAgentResponse } from "./runtime.ts";

export interface ExecOptions {
  /** Written to the child's stdin, which is then closed. */
  input: string;
  timeoutMs: number;
  cwd?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type ExecFn = (file: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

/**
 * A failed agent call that still spent money.
 *
 * `error_max_turns` burns a full agent loop and returns nothing usable. Throwing
 * a bare Error made those attempts report $0.00, so a run could exhaust its
 * retries and claim it had spent nothing - the one direction budget accounting
 * must never be wrong in.
 */
export class RunnerError extends Error {
  // Declared explicitly: Node's strip-only TypeScript mode rejects constructor
  // parameter properties, and this package has no build step.
  readonly usdReported?: number;
  readonly usage?: RawAgentResponse["usage"];

  constructor(message: string, usdReported?: number, usage?: RawAgentResponse["usage"]) {
    super(message);
    this.name = "RunnerError";
    this.usdReported = usdReported;
    this.usage = usage;
  }
}

/**
 * Spawn, not `execFile`.
 *
 * `promisify(execFile)` accepts an `input` option without error and then
 * ignores it - only the *Sync* variants read it. Using it here delivered an
 * empty prompt to every agent, and because a fake exec in the tests recorded
 * the option happily, the tests agreed with the intent rather than the API.
 * Writing to stdin explicitly is the only form that cannot drift like that.
 */
const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // Bounded so a runaway child cannot exhaust memory here.
    const cap = 32 * 1024 * 1024;
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    // A prompt is routinely tens of kilobytes, which is past the argument-length
    // limit, so it goes here rather than in argv.
    child.stdin.on("error", () => {
      /* the child may exit before the write lands; `close` reports the real cause */
    });
    child.stdin.end(opts.input);
  });

/**
 * Runner for agents that need tools, built on the local `claude` binary.
 *
 * `MessagesRunner` covers the tool-less roles with a single API call. Roles that
 * must read a repository need a real agent loop, and shelling out to the
 * installed Claude Code gives that without a second SDK dependency or a second
 * auth path to keep working.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It never grants Bash, WebFetch or WebSearch. The tool allow-list is built
 *     from the agent definition and passed explicitly, so a role cannot acquire
 *     a capability by being edited carelessly somewhere else.
 *   - It never grants Write or Edit. `--add-dir` grants read and write together,
 *     so an agent able to write its output into the project could also edit the
 *     application under test. Spec source comes back as text and code writes it.
 *
 * Auth is whatever the local `claude` is already logged in as. For a personal
 * tool that is the point; for anything distributed, Anthropic requires API-key
 * auth instead, so this runner is not the one a shipped product should use.
 */

export interface ClaudeCodeRunnerOptions {
  /** Path to the binary. Resolved from PATH by default. */
  binary?: string;
  /** Directories the agent may read. The project root, normally. */
  addDirs?: string[];
  /** Milliseconds before the agent is killed. */
  timeoutMs?: number;
  /** Working directory for the child. Defaults to the first read directory. */
  cwd?: string;
  /**
   * Output schema per role, same map MessagesRunner uses.
   *
   * The Messages API enforces these; the CLI has no equivalent, so the schema
   * is stated in the prompt instead. Without it a tool-less role answers in
   * prose and burns its retries converging on the shape - which is exactly what
   * happened to the entailment check, the strictest gate in the product.
   */
  schemas?: Record<string, Record<string, unknown>>;
  /** Injected for tests. */
  exec?: ExecFn;
}

/** Maps the internal capability names onto Claude Code's tool names. */
const TOOL_NAMES: Record<AgentTool, string> = {
  read: "Read",
  grep: "Grep",
  glob: "Glob",
};

/**
 * The envelope `claude -p --output-format json` produces. Only the fields that
 * are actually consumed are modelled; the shape carries far more.
 */
interface ClaudeEnvelope {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  stop_reason?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, { canonicalModel?: string }>;
  permission_denials?: unknown[];
}

export class ClaudeCodeRunner implements AgentRunner {
  private readonly binary: string;
  private readonly addDirs: string[];
  private readonly timeoutMs: number;
  private readonly cwd?: string;
  private readonly schemas: Record<string, Record<string, unknown>>;
  private readonly exec: ExecFn;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.binary = options.binary ?? "claude";
    this.addDirs = options.addDirs ?? [];
    this.timeoutMs = options.timeoutMs ?? 240_000;
    // Running inside the project is what makes relative paths in an agent's
    // reasoning line up with the paths a human would use.
    this.cwd = options.cwd ?? options.addDirs?.[0];
    this.schemas = options.schemas ?? {};
    this.exec = options.exec ?? defaultExec;
  }

  supports(definition: AgentDefinition): boolean {
    return definition.tools.length > 0;
  }

  /**
   * Built from the agent definition every time rather than stored, so a role
   * cannot end up with a capability its definition does not declare.
   */
  allowedTools(definition: AgentDefinition): string[] {
    return definition.tools.map((t) => TOOL_NAMES[t]).filter(Boolean);
  }

  async invoke(request: {
    definition: AgentDefinition;
    prompt: string;
    previousError?: string;
    attempt: number;
  }): Promise<RawAgentResponse> {
    const { definition } = request;

    // A tool-less role runs here too, with nothing granted.
    //
    // This used to be refused, on the grounds that MessagesRunner is cheaper.
    // That was a cost argument dressed as a rule, and it had a real cost of its
    // own: MessagesRunner needs an API key, so without one the research fleet
    // could not run at all - and research is what lets any finding reach
    // CONFIRMED. A more expensive path that works beats a cheaper one that is
    // unavailable.
    const allowed = this.allowedTools(definition);

    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      definition.model,
      // Appended rather than replacing: the base prompt is what makes the tool
      // loop work, and a stable prefix is also what keeps the cache warm across
      // every agent in a run.
      "--append-system-prompt",
      definition.systemPrompt,
      ...(allowed.length ? ["--allowed-tools", ...allowed] : []),
      // Everything not explicitly allowed is refused, so a future tool added
      // upstream cannot silently become available to an agent.
      "--disallowed-tools",
      "Bash",
      "Write",
      "Edit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
      "--max-turns",
      String(definition.maxTurns),
      "--no-session-persistence",
      "--strict-mcp-config",
    ];

    for (const dir of this.addDirs) args.push("--add-dir", dir);

    const schema = this.schemas[definition.role];
    const contract = schema
      ? [
          "",
          "Return ONLY a JSON object matching this schema. No prose, no fences,",
          "no explanation outside the JSON. Every required field must be present.",
          "",
          JSON.stringify(schema, null, 2),
        ].join("\n")
      : "";

    const prompt = request.previousError
      ? [
          "Your previous response was rejected.",
          `Reason: ${request.previousError}`,
          "",
          "Return only valid JSON matching the required shape. Do not explain.",
          "",
          request.prompt,
          contract,
        ].join("\n")
      : request.prompt + contract;

    let result: ExecResult;
    try {
      result = await this.exec(this.binary, args, {
        input: prompt,
        timeoutMs: this.timeoutMs,
        cwd: this.cwd,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/ENOENT/.test(message)) {
        throw new Error(
          `Could not find the "${this.binary}" binary. Install Claude Code, or use MessagesRunner with an API key.`,
        );
      }
      throw new Error(`claude failed: ${message.slice(0, 400)}`);
    }

    const stdout = String(result.stdout ?? "");

    let envelope: ClaudeEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeEnvelope;
    } catch {
      // The exit code and stderr are what actually explain a failure here, and
      // omitting them turns every CLI problem into an unreadable parse error.
      const detail = [
        result.code !== 0 && result.code !== null ? `exit ${result.code}` : "",
        String(result.stderr ?? "").trim().slice(-400),
        stdout.trim().slice(0, 300),
      ]
        .filter(Boolean)
        .join(" | ");
      throw new Error(`claude returned output that is not JSON: ${detail || "(no output)"}`);
    }

    const usage = {
      inputTokens: envelope.usage?.input_tokens ?? 0,
      outputTokens: envelope.usage?.output_tokens ?? 0,
      cacheReadTokens: envelope.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: envelope.usage?.cache_creation_input_tokens ?? 0,
    };

    if (envelope.is_error) {
      const subtype = envelope.subtype ?? "unknown";
      throw new RunnerError(
        subtype === "error_max_turns"
          ? `claude ran out of turns (${definition.maxTurns}) before returning a result. ` +
            `The task needs more turns, or less exploration before answering.`
          : `claude reported an error (${subtype}).`,
        envelope.total_cost_usd,
        usage,
      );
    }

    // A denied permission means the agent tried to do something outside its
    // allow-list. That is a configuration fault worth surfacing, not a quiet
    // degradation of what the agent managed to see.
    if (envelope.permission_denials?.length) {
      throw new Error(
        `The agent attempted ${envelope.permission_denials.length} action(s) outside its allowed tools. ` +
          `Check the tool policy for "${definition.role}".`,
      );
    }

    const model =
      Object.values(envelope.modelUsage ?? {})[0]?.canonicalModel ?? definition.model;

    return {
      text: envelope.result ?? "",
      model,
      stopReason: envelope.stop_reason,
      usage,
      // The CLI reports what the turn actually cost. Preferring it over the
      // local estimate keeps budget accounting honest, including the cache
      // overhead a local table cannot know about.
      usdReported: envelope.total_cost_usd,
    };
  }
}

/**
 * Chooses the cheapest runner that can honour a role: no tools means no agent
 * loop is needed, and paying for one would be waste with extra failure modes.
 */
export function selectRunner(
  definition: AgentDefinition,
  runners: { messages?: AgentRunner; tools?: AgentRunner },
): AgentRunner {
  // A tool-less role prefers the plain messages call - one request, no agent
  // loop, no filesystem surface - but falls back to the tool runner when no
  // API key is configured. A role that needs tools has only one option.
  const runner =
    definition.tools.length === 0 ? (runners.messages ?? runners.tools) : runners.tools;

  if (!runner) {
    throw new Error(
      `No runner available for "${definition.role}" (${definition.tools.length} tool(s) required).`,
    );
  }
  return runner;
}

/**
 * The runners available on this machine.
 *
 * `MessagesRunner` is only offered when a key is actually configured. Building
 * it regardless produces a runner that fails on first use, which surfaces as a
 * confusing auth error several steps into a run rather than as a clear absence
 * here.
 */
export function hasApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}
