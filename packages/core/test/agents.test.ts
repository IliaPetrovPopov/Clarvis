import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Budget, estimateUsd, DEFAULT_PRICING, UNKNOWN_MODEL_PRICING } from "../src/agents/budget.ts";
import { AGENTS, assertToolPolicy, getAgent, type AgentDefinition } from "../src/agents/definitions.ts";
import { extractJson, runAgent, type AgentRunner, type RawAgentResponse } from "../src/agents/runtime.ts";

/* ------------------------------------------------------------- pricing */

test("cost is estimated per model, and an unknown model is never free", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.equal(estimateUsd("claude-sonnet-5", usage), 3 + 15);
  assert.equal(estimateUsd("claude-haiku-4-5", usage), 1 + 5);
  // An unrecognised model must not silently cost nothing.
  const unknown = estimateUsd("some-future-model", usage);
  assert.equal(unknown, UNKNOWN_MODEL_PRICING.inputPerMTok + UNKNOWN_MODEL_PRICING.outputPerMTok);
  assert.ok(unknown > 0);
});

test("pricing can be overridden, because published rates change", () => {
  const custom = { "claude-sonnet-5": { inputPerMTok: 1, outputPerMTok: 2 } };
  assert.equal(estimateUsd("claude-sonnet-5", { inputTokens: 1e6, outputTokens: 1e6 }, custom), 3);
  assert.ok(DEFAULT_PRICING["claude-opus-5"]);
});

/* -------------------------------------------------------------- budget */

test("budget refuses before spending, not after", () => {
  const b = new Budget({ maxUsd: 1 });
  b.record({ fleet: "research", agentId: "a-1", usd: 0.9 });

  const ok = b.canSpend({ fleet: "research", agentId: "a-1", estimatedUsd: 0.05 });
  assert.equal(ok.allowed, true);

  const refused = b.canSpend({ fleet: "research", agentId: "a-1", estimatedUsd: 0.5 });
  assert.equal(refused.allowed, false, "an attempt that would exceed the cap must be refused up front");
  assert.match(refused.reason, /Run budget/);
});

test("per-fleet and per-agent ceilings are enforced independently", () => {
  const b = new Budget({ maxUsd: 100, perFleetUsd: { qa: 2 }, maxUsdPerAgent: 0.5 });

  b.record({ fleet: "qa", agentId: "author-1", usd: 0.45 });
  assert.equal(b.canSpend({ fleet: "qa", agentId: "author-1", estimatedUsd: 0.2 }).allowed, false);
  // A different agent in the same fleet still has room.
  assert.equal(b.canSpend({ fleet: "qa", agentId: "author-2", estimatedUsd: 0.2 }).allowed, true);

  b.record({ fleet: "qa", agentId: "author-2", usd: 1.6 });
  assert.equal(b.canSpend({ fleet: "qa", agentId: "author-3", estimatedUsd: 0.2 }).allowed, false);
  assert.match(b.canSpend({ fleet: "qa", agentId: "author-3" }).reason, /Fleet budget/);
});

/* -------------------------------------------------------- tool policy */

test("no agent may reach the network or a shell", () => {
  for (const def of Object.values(AGENTS)) {
    assert.doesNotThrow(() => assertToolPolicy(def), `${def.role} must satisfy the tool policy`);
    for (const tool of def.tools) {
      assert.ok(
        ["read", "grep", "glob"].includes(tool),
        `${def.role} requests a forbidden tool: ${tool}`,
      );
    }
  }
});

test("no agent may write a file, and a stray tool is refused", () => {
  // Write access was once carved out for the spec author. It was removed:
  // Claude Code grants read and write together per directory, so an author able
  // to write its spec could also edit the app it is testing.
  for (const def of Object.values(AGENTS)) {
    assert.equal(def.tools.some((t) => /write|edit/i.test(t)), false, `${def.role} must not write`);
  }

  const bad: AgentDefinition = { ...getAgent("archive-extract"), tools: ["write_scratch" as never] };
  assert.throws(() => assertToolPolicy(bad), /may not write files/);

  const worse: AgentDefinition = { ...getAgent("archive-extract"), tools: ["bash" as never] };
  assert.throws(() => assertToolPolicy(worse), /may not write files, access the network, or run a shell/);
});

test("research agents get no tools at all - connectors retrieve, agents reason", () => {
  assert.deepEqual(getAgent("archive-extract").tools, []);
  assert.deepEqual(getAgent("archive-entail").tools, []);
});

/* ----------------------------------------------------- json extraction */

test("json is recovered from prose, fences and trailing commentary", () => {
  assert.deepEqual(extractJson('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
  assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps.'), { ok: true, value: { a: 1 } });
  assert.deepEqual(extractJson("[1,2]"), { ok: true, value: [1, 2] });
});

test("braces inside strings do not truncate the extracted object", () => {
  const r = extractJson('note: {"quote":"a } b","n":2} done');
  assert.deepEqual(r, { ok: true, value: { quote: "a } b", n: 2 } });
});

test("unparseable output is a failure, not an empty object", () => {
  assert.equal(extractJson("no json here").ok, false);
  assert.equal(extractJson("").ok, false);
});

/* -------------------------------------------------------------- runner */

function fakeRunner(responses: Array<Partial<RawAgentResponse> | Error>): AgentRunner & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async invoke(req) {
      this.calls++;
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return {
        text: next.text ?? "",
        model: next.model ?? req.definition.model,
        usage: next.usage ?? { inputTokens: 1000, outputTokens: 200 },
        stopReason: next.stopReason,
      };
    },
  };
}

const okValidator = (parsed: unknown) =>
  typeof (parsed as { name?: string })?.name === "string"
    ? ({ ok: true, value: parsed as { name: string } } as const)
    : ({ ok: false, error: "expected a string field 'name'" } as const);

test("a valid response is returned with usage and cost recorded", async () => {
  const budget = new Budget({ maxUsd: 5 });
  const result = await runAgent({
    runner: fakeRunner([{ text: '{"name":"ok"}' }]),
    definition: getAgent("archive-extract"),
    prompt: "go",
    validate: okValidator,
    budget,
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.data, { name: "ok" });
  assert.equal(result.attempts, 1);
  assert.ok(result.usdEstimate > 0);
  assert.ok(budget.spentUsd > 0);
});

test("invalid output is retried with the reason fed back, then fails loudly", async () => {
  const runner = fakeRunner([{ text: "garbage" }, { text: '{"wrong":true}' }, { text: "still garbage" }]);
  const result = await runAgent({
    runner,
    definition: getAgent("archive-extract"),
    prompt: "go",
    validate: okValidator,
    budget: new Budget({ maxUsd: 5 }),
  });

  assert.equal(result.status, "invalid-output");
  assert.equal(result.data, undefined, "a failed agent must never return data");
  assert.equal(result.attempts, 3);
  assert.match(result.error ?? "", /Last problem/);
});

test("a retry that succeeds is charged for both attempts", async () => {
  const budget = new Budget({ maxUsd: 5 });
  const result = await runAgent({
    runner: fakeRunner([{ text: "nope" }, { text: '{"name":"second try"}' }]),
    definition: getAgent("archive-extract"),
    prompt: "go",
    validate: okValidator,
    budget,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.attempts, 2);
  // Both attempts cost money; a retry loop is exactly where unbilled spend hides.
  const oneAttempt = estimateUsd("claude-sonnet-5", { inputTokens: 1000, outputTokens: 200 });
  assert.ok(Math.abs(result.usdEstimate - oneAttempt * 2) < 1e-9);
});

test("an exhausted budget stops the agent before it calls the model", async () => {
  const budget = new Budget({ maxUsd: 0.0001 });
  const runner = fakeRunner([{ text: '{"name":"never reached"}' }]);

  const result = await runAgent({
    runner,
    definition: getAgent("archive-extract"),
    prompt: "go",
    validate: okValidator,
    budget,
    estimatedUsdPerAttempt: 1,
  });

  assert.equal(result.status, "budget-exceeded");
  assert.equal(runner.calls, 0, "the model must not be called when the budget cannot cover it");
});

test("a runner exception is reported, never swallowed", async () => {
  const result = await runAgent({
    runner: fakeRunner([new Error("connection reset")]),
    definition: getAgent("archive-extract"),
    prompt: "go",
    validate: okValidator,
    budget: new Budget({ maxUsd: 5 }),
  });

  assert.equal(result.status, "runner-error");
  assert.equal(result.data, undefined);
  assert.match(result.error ?? "", /connection reset/);
});

test("an empty response is distinguished from invalid output", async () => {
  const result = await runAgent({
    runner: fakeRunner([{ text: "   " }]),
    definition: getAgent("archive-extract"),
    prompt: "go",
    validate: okValidator,
    budget: new Budget({ maxUsd: 5 }),
    maxAttempts: 1,
  });
  assert.equal(result.status, "empty-output");
});

/* --------------------------------------------------------- transcripts */

test("transcripts are written for failures too, with secrets redacted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "clarvis-transcript-"));
  try {
    const secret = "SUPER_SECRET_TOKEN";
    const result = await runAgent({
      runner: fakeRunner([{ text: `leaking ${secret} and no json` }]),
      definition: getAgent("archive-extract"),
      prompt: `context containing ${secret}`,
      validate: okValidator,
      budget: new Budget({ maxUsd: 5 }),
      maxAttempts: 1,
      transcriptDir: dir,
      redact: (t) => t.split(secret).join("[redacted]"),
    });

    assert.equal(result.status, "invalid-output");
    assert.ok(result.transcriptPath, "a failed run is exactly when the transcript matters most");

    const contents = await readFile(result.transcriptPath!, "utf8");
    assert.equal(contents.includes(secret), false, "the transcript must not contain the token");
    assert.match(contents, /\[redacted\]/);
    // Both the prompt and the response passed through redaction.
    assert.equal(contents.split("[redacted]").length - 1 >= 2, true);

    const events = contents.trim().split("\n").map((l) => JSON.parse(l).event);
    assert.deepEqual(events, ["start", "response", "rejected", "exhausted"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a misconfigured agent is refused before it can run", async () => {
  const runner = fakeRunner([{ text: '{"name":"x"}' }]);
  await assert.rejects(
    () =>
      runAgent({
        runner,
        definition: { ...getAgent("archive-extract"), tools: ["bash" as never] },
        prompt: "go",
        validate: okValidator,
        budget: new Budget({ maxUsd: 5 }),
      }),
    /may not write files, access the network, or run a shell/,
  );
  assert.equal(runner.calls, 0);
});

test("concurrent agents cannot each spend the last of the budget", async () => {
  // canSpend-then-record is check-then-act, and the gap spans an await: five
  // agents started together all passed the same check against an untouched
  // balance. This is the only reason authoring ran one axis at a time.
  const budget = new Budget({ maxUsd: 1 });

  const reservations = Array.from({ length: 5 }, (_, i) =>
    budget.reserve({ fleet: "qa", agentId: `a${i}`, estimatedUsd: 0.3 }),
  );

  const allowed = reservations.filter((r) => r.allowed);
  assert.equal(allowed.length, 3, "only three $0.30 reservations fit under a $1.00 ceiling");
  assert.ok(budget.spentUsd <= 1);

  // Settling to the real cost releases what was over-reserved.
  for (const r of allowed) r.settle(0.1);
  assert.equal(Number(budget.spentUsd.toFixed(4)), 0.3);

  // And a refused reservation charges nothing.
  assert.equal(budget.spentByAgent("a4"), 0);
});

test("settling twice does not double-charge", () => {
  const budget = new Budget({ maxUsd: 10 });
  const r = budget.reserve({ fleet: "qa", agentId: "a1", estimatedUsd: 1 });
  r.settle(0.4);
  r.settle(0.4);
  assert.equal(Number(budget.spentUsd.toFixed(4)), 0.4);
});

test("a failed attempt that spent money is still charged to the budget", async () => {
  const budget = new Budget({ maxUsd: 5 });
  const runner: AgentRunner = {
    async invoke() {
      const e = new Error("claude ran out of turns") as Error & { usdReported: number };
      e.usdReported = 0.42;
      throw e;
    },
  };

  const result = await runAgent({
    runner,
    definition: getAgent("scout-boot"),
    prompt: "go",
    validate: okValidator,
    budget,
  });

  assert.equal(result.status, "runner-error");
  // Unbilled retries are exactly where spend would hide.
  assert.equal(Number(budget.spentUsd.toFixed(4)), 0.42);
  assert.equal(Number(result.usdEstimate.toFixed(4)), 0.42);
});

test("spend is labelled as an equivalent when there is no API key to bill", async () => {
  // The CLI reports total_cost_usd whether or not a key is configured. With a
  // subscription login there is no invoice, and printing a bare "$2.61" states
  // a charge that is not happening.
  const { spendLabel, spendNote, isBilledInDollars } = await import("../src/agents/budget.ts");

  assert.equal(isBilledInDollars({ ANTHROPIC_API_KEY: "sk-ant-x" }), true);
  assert.equal(isBilledInDollars({ ANTHROPIC_API_KEY: "  " }), false);
  assert.equal(isBilledInDollars({}), false);

  assert.equal(spendLabel(2.6146, true), "$2.6146");
  assert.equal(spendLabel(2.6146, false), "$2.6146 equivalent");

  assert.match(spendNote(false), /not to a card/);
  assert.match(spendNote(true), /Billed to the configured API key/);
});
