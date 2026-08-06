import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClaudeCodeRunner,
  selectRunner,
  hasApiKey,
  type ExecFn,
  type ExecOptions,
} from "../src/agents/claudeCodeRunner.ts";
import { getAgent } from "../src/agents/definitions.ts";
import type { AgentRunner } from "../src/agents/runtime.ts";

type ExecCall = { file: string; args: string[]; opts: ExecOptions };

function fakeExec(envelope: Record<string, unknown> | Error) {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (envelope instanceof Error) throw envelope;
    return { stdout: JSON.stringify(envelope), stderr: "", code: 0 };
  };
  return { exec, calls };
}

const OK = {
  result: '{"ok":true}',
  is_error: false,
  total_cost_usd: 0.0421,
  usage: {
    input_tokens: 120,
    output_tokens: 40,
    cache_read_input_tokens: 15_000,
    cache_creation_input_tokens: 16_000,
  },
  modelUsage: { "claude-sonnet-5[1m]": { canonicalModel: "claude-sonnet-5" } },
  permission_denials: [],
};

/* --------------------------------------------------------- tool policy */

test("the allow-list is built from the definition, never from anywhere else", () => {
  const runner = new ClaudeCodeRunner();
  assert.deepEqual(runner.allowedTools(getAgent("pathfinder-boot")), ["Read", "Grep", "Glob"]);
  assert.deepEqual(runner.allowedTools(getAgent("crucible-author")), ["Read", "Grep", "Glob"]);
});

test("bash, web access and subagents are explicitly denied on every invocation", async () => {
  const { exec, calls } = fakeExec(OK);
  await new ClaudeCodeRunner({ exec }).invoke({
    definition: getAgent("pathfinder-boot"),
    prompt: "find the boot command",
    attempt: 1,
  });

  const args = calls[0].args;

  // Values for a flag run until the next flag; slicing to the end would spill
  // into the neighbouring list and make this assertion meaningless.
  const valuesFor = (flag: string) => {
    const start = args.indexOf(flag);
    if (start === -1) return [];
    const out: string[] = [];
    for (let i = start + 1; i < args.length && !args[i].startsWith("--"); i++) out.push(args[i]);
    return out;
  };

  const denied = valuesFor("--disallowed-tools");
  for (const tool of ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task"]) {
    assert.ok(denied.includes(tool), `${tool} must be denied explicitly`);
  }
  // An agent that could run a shell would make every other guarantee moot.
  assert.deepEqual(valuesFor("--allowed-tools"), ["Read", "Grep", "Glob"]);
});

test("a tool-less role runs here with nothing granted", async () => {
  // Refusing these used to be the rule, on cost grounds. But MessagesRunner
  // needs an API key, and without one the research fleet could not run at all -
  // which is what lets any finding reach CONFIRMED.
  const { exec, calls } = fakeExec(OK);
  await new ClaudeCodeRunner({ exec }).invoke({
    definition: getAgent("dossier-extract"),
    prompt: "x",
    attempt: 1,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes("--allowed-tools"), false);
  // Still denied everything.
  assert.ok(calls[0].args.includes("--disallowed-tools"));
});

test("selectRunner sends each role to the cheapest runner that can honour it", () => {
  const messages = { invoke: async () => ({}) } as unknown as AgentRunner;
  const tools = { invoke: async () => ({}) } as unknown as AgentRunner;

  assert.equal(selectRunner(getAgent("dossier-extract"), { messages, tools }), messages);
  assert.equal(selectRunner(getAgent("pathfinder-boot"), { messages, tools }), tools);

  // With no API key there is no messages runner, and a tool-less role still has
  // to run - so it falls back rather than failing.
  assert.equal(selectRunner(getAgent("dossier-extract"), { tools }), tools);

  // A role that needs tools has no fallback.
  assert.throws(() => selectRunner(getAgent("pathfinder-boot"), { messages }), /No runner available/);
});

/* ------------------------------------------------------------ invocation */

test("the prompt is written to the child's stdin for real, not merely passed as an option", async () => {
  // The original runner used promisify(execFile), which accepts an `input`
  // option and silently ignores it - every agent got an empty prompt, and a
  // fake exec that just recorded the option agreed that it was fine. This test
  // drives a real process so the assertion cannot pass on intent alone.
  // Echoes stdin back inside a valid envelope, so a lost prompt shows up as an
  // empty `result` rather than as a crash.
  const echo: ExecFn = async (file, _args, opts) => {
    const { spawn } = await import("node:child_process");
    const child = spawn(file, ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({result:s,is_error:false})))"]);
    child.stdin.end(opts.input);
    let out = "";
    for await (const chunk of child.stdout) out += String(chunk);
    return { stdout: out, stderr: "", code: 0 };
  };

  const res = await new ClaudeCodeRunner({ binary: process.execPath, exec: echo }).invoke({
    definition: getAgent("pathfinder-boot"),
    prompt: "the actual task text",
    attempt: 1,
  });

  assert.equal(res.text, "the actual task text");
});

test("the prompt goes on stdin, never into argv", async () => {
  const { exec, calls } = fakeExec(OK);
  const big = "x".repeat(200_000);

  await new ClaudeCodeRunner({ exec }).invoke({
    definition: getAgent("pathfinder-boot"),
    prompt: big,
    attempt: 1,
  });

  // A prompt of this size in argv would exceed the argument-length limit.
  assert.equal(calls[0].opts.input, big);
  assert.equal(calls[0].args.some((a) => a.includes(big)), false);
});

test("read directories are passed through so the agent can see the project", async () => {
  const { exec, calls } = fakeExec(OK);
  await new ClaudeCodeRunner({ exec, addDirs: ["/tmp/project"] }).invoke({
    definition: getAgent("pathfinder-boot"),
    prompt: "go",
    attempt: 1,
  });
  const args = calls[0].args;
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/project");
});

test("a retry states the rejection before the task", async () => {
  const { exec, calls } = fakeExec(OK);
  await new ClaudeCodeRunner({ exec }).invoke({
    definition: getAgent("pathfinder-boot"),
    prompt: "the task",
    previousError: "boot.url was missing",
    attempt: 2,
  });
  const input = String(calls[0].opts.input);
  assert.match(input, /previous response was rejected/i);
  assert.ok(input.indexOf("boot.url was missing") < input.indexOf("the task"));
});

/* ---------------------------------------------------------------- result */

test("reported cost is carried through rather than re-estimated", async () => {
  const { exec } = fakeExec(OK);
  const res = await new ClaudeCodeRunner({ exec }).invoke({
    definition: getAgent("pathfinder-boot"),
    prompt: "go",
    attempt: 1,
  });

  // The CLI knows the real figure, including cache overhead a local price table
  // cannot see.
  assert.equal(res.usdReported, 0.0421);
  assert.equal(res.usage.cacheReadTokens, 15_000);
  assert.equal(res.usage.cacheWriteTokens, 16_000);
  assert.equal(res.model, "claude-sonnet-5");
  assert.equal(res.text, '{"ok":true}');
});

test("a denied permission is surfaced, not treated as a thinner answer", async () => {
  const { exec } = fakeExec({ ...OK, permission_denials: [{ tool: "Bash" }] });
  await assert.rejects(
    () =>
      new ClaudeCodeRunner({ exec }).invoke({
        definition: getAgent("pathfinder-boot"),
        prompt: "go",
        attempt: 1,
      }),
    /outside its allowed tools/,
  );
});

test("an error envelope is an error, not an empty result", async () => {
  const { exec } = fakeExec({ is_error: true, subtype: "max_turns", result: "" });
  await assert.rejects(
    () => new ClaudeCodeRunner({ exec }).invoke({ definition: getAgent("pathfinder-boot"), prompt: "go", attempt: 1 }),
    /claude reported an error \(max_turns\)/,
  );
});

test("non-json output is reported with the exit code and stderr that explain it", async () => {
  const exec: ExecFn = async () => ({ stdout: "", stderr: "Invalid option: --nope", code: 2 });
  await assert.rejects(
    () => new ClaudeCodeRunner({ exec }).invoke({ definition: getAgent("pathfinder-boot"), prompt: "go", attempt: 1 }),
    // Without these the caller sees a parse error and no cause, which is what
    // made the first live recon failure unreadable.
    /exit 2 \| Invalid option: --nope/,
  );
});

test("a silent empty result is still an error, not an empty success", async () => {
  const exec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0 });
  await assert.rejects(
    () => new ClaudeCodeRunner({ exec }).invoke({ definition: getAgent("pathfinder-boot"), prompt: "go", attempt: 1 }),
    /no output/,
  );
});

test("a missing binary explains the alternative", async () => {
  const { exec } = fakeExec(new Error("spawn claude ENOENT"));
  await assert.rejects(
    () => new ClaudeCodeRunner({ exec }).invoke({ definition: getAgent("pathfinder-boot"), prompt: "go", attempt: 1 }),
    /Install Claude Code, or use MessagesRunner/,
  );
});

test("running out of turns reports what it cost, not zero", async () => {
  // error_max_turns burns a whole agent loop and returns nothing usable. A bare
  // Error made those attempts report $0.00, so a run could exhaust its retries
  // and claim it had spent nothing.
  const { exec } = fakeExec({
    is_error: true,
    subtype: "error_max_turns",
    total_cost_usd: 0.31,
    usage: { input_tokens: 900, output_tokens: 120 },
  });

  await assert.rejects(
    () =>
      new ClaudeCodeRunner({ exec }).invoke({
        definition: getAgent("pathfinder-boot"),
        prompt: "go",
        attempt: 1,
      }),
    (e: Error & { usdReported?: number }) => {
      assert.match(e.message, /ran out of turns/);
      assert.equal(e.usdReported, 0.31);
      return true;
    },
  );
});

test("hasApiKey only reports a key that is actually usable", () => {
  // Building MessagesRunner regardless produces a runner that fails on first
  // use, which surfaces as a confusing auth error several steps into a run
  // rather than as a clear absence up front.
  assert.equal(hasApiKey({ ANTHROPIC_API_KEY: "sk-ant-xyz" }), true);
  assert.equal(hasApiKey({ ANTHROPIC_AUTH_TOKEN: "tok" }), true);
  assert.equal(hasApiKey({ ANTHROPIC_API_KEY: "   " }), false);
  assert.equal(hasApiKey({}), false);
});

test("a role with a schema is given it in the prompt", async () => {
  // The Messages API enforces these shapes; the CLI has no equivalent, so
  // without this a tool-less role answers in prose and burns its retries
  // converging on the shape - which is what broke the entailment check.
  const { exec, calls } = fakeExec(OK);
  await new ClaudeCodeRunner({
    exec,
    schemas: { "pathfinder-boot": { type: "object", required: ["url"] } },
  }).invoke({ definition: getAgent("pathfinder-boot"), prompt: "go", attempt: 1 });

  const input = String(calls[0].opts.input);
  assert.match(input, /Return ONLY a JSON object matching this schema/);
  assert.match(input, /"required": \[\s*"url"\s*\]/);
});

test("every agent role has an output schema", async () => {
  // A role without one is a role that guesses its shape.
  const { AGENT_SCHEMAS } = await import("../src/agents/messagesRunner.ts");
  const { AGENTS } = await import("../src/agents/definitions.ts");
  for (const role of Object.keys(AGENTS)) {
    assert.ok(AGENT_SCHEMAS[role], `${role} has no output schema`);
  }
});
