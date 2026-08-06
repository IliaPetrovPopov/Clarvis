import { test } from "node:test";
import assert from "node:assert/strict";
import { MessagesRunner, DOSSIER_SCHEMAS } from "../src/agents/messagesRunner.ts";
import { getAgent } from "../src/agents/definitions.ts";

type CreateParams = Record<string, unknown>;

function fakeClient(reply: Record<string, unknown>) {
  const calls: CreateParams[] = [];
  const client = {
    messages: {
      async create(params: CreateParams) {
        calls.push(params);
        return {
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "{}" }],
          usage: { input_tokens: 100, output_tokens: 20 },
          ...reply,
        };
      },
    },
  };
  return { client: client as never, calls };
}

test("a tool-using agent is refused rather than run without its tools", async () => {
  const { client, calls } = fakeClient({});
  const runner = new MessagesRunner({ client });

  assert.equal(runner.supports(getAgent("dossier-extract")), true);
  assert.equal(runner.supports(getAgent("pathfinder-boot")), false);

  await assert.rejects(
    () => runner.invoke({ definition: getAgent("pathfinder-boot"), prompt: "go", attempt: 1 }),
    /requires tools/,
  );
  assert.equal(calls.length, 0, "a runner that cannot honour the tools must not call the model at all");
});

test("the request carries the system prompt, adaptive thinking and the schema", async () => {
  const { client, calls } = fakeClient({
    content: [{ type: "text", text: '{"requirements":[],"unknowns":[]}' }],
  });
  const runner = new MessagesRunner({ client, schemas: DOSSIER_SCHEMAS });

  await runner.invoke({ definition: getAgent("dossier-extract"), prompt: "sources here", attempt: 1 });

  const params = calls[0] as {
    system: string;
    thinking: { type: string };
    output_config: { format?: { type: string; schema: unknown } };
    messages: Array<{ content: string }>;
    model: string;
  };

  assert.match(params.system, /extract testable requirements/i);
  assert.equal(params.thinking.type, "adaptive");
  assert.equal(params.output_config.format?.type, "json_schema");
  assert.ok(params.output_config.format?.schema, "structured output removes malformed JSON as a failure mode");
  assert.match(params.messages[0].content, /sources here/);
  assert.equal(params.model, "claude-sonnet-5");
});

test("a retry states the previous rejection before the task", async () => {
  const { client, calls } = fakeClient({ content: [{ type: "text", text: "{}" }] });
  const runner = new MessagesRunner({ client });

  await runner.invoke({
    definition: getAgent("dossier-extract"),
    prompt: "the task",
    previousError: "quote does not appear in s1",
    attempt: 2,
  });

  const content = (calls[0] as { messages: Array<{ content: string }> }).messages[0].content;
  assert.match(content, /previous response was rejected/i);
  assert.match(content, /quote does not appear in s1/);
  // Reason first, task second: burying it tends to reproduce the same mistake.
  assert.ok(content.indexOf("rejected") < content.indexOf("the task"));
});

test("a safety refusal is an error, never an empty answer", async () => {
  const { client } = fakeClient({
    stop_reason: "refusal",
    stop_details: { category: "cyber" },
    content: [],
  });
  const runner = new MessagesRunner({ client });

  await assert.rejects(
    () => runner.invoke({ definition: getAgent("dossier-extract"), prompt: "go", attempt: 1 }),
    /declined this request \(cyber\)/,
  );
});

test("cache tokens are carried through so cost is not understated", async () => {
  const { client } = fakeClient({
    content: [{ type: "text", text: '{"ok":true}' }],
    usage: {
      input_tokens: 500,
      output_tokens: 80,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 1000,
    },
  });

  const res = await new MessagesRunner({ client }).invoke({
    definition: getAgent("dossier-extract"),
    prompt: "go",
    attempt: 1,
  });

  assert.equal(res.usage.inputTokens, 500);
  assert.equal(res.usage.cacheReadTokens, 4000);
  assert.equal(res.usage.cacheWriteTokens, 1000);
  assert.equal(res.text, '{"ok":true}');
});

test("only text blocks are collected, so thinking never pollutes the payload", async () => {
  const { client } = fakeClient({
    content: [
      { type: "thinking", thinking: "considering..." },
      { type: "text", text: '{"a":' },
      { type: "text", text: "1}" },
    ],
  });

  const res = await new MessagesRunner({ client }).invoke({
    definition: getAgent("dossier-extract"),
    prompt: "go",
    attempt: 1,
  });
  assert.equal(res.text, '{"a":1}');
});

test("every tool-less role has a structured-output schema", () => {
  for (const role of ["dossier-extract", "dossier-entail", "dossier-synthesis"]) {
    const schema = DOSSIER_SCHEMAS[role];
    assert.ok(schema, `${role} needs a schema`);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false, "extra fields must be rejected, not ignored");
    assert.ok(Array.isArray(schema.required) && (schema.required as string[]).length > 0);
  }
});

test("the entailment schema cannot express an opinion beyond the verdict", () => {
  const schema = DOSSIER_SCHEMAS["dossier-entail"];
  assert.deepEqual((schema.required as string[]).sort(), ["confidence", "entailed", "reason"]);
  // No field through which the verifier could rewrite the statement it is judging.
  assert.deepEqual(Object.keys(schema.properties as object).sort(), ["confidence", "entailed", "reason"]);
});
