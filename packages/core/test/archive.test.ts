import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDossier, gatherSources } from "../src/agents/archive.ts";
import { Budget } from "../src/agents/budget.ts";
import { oracleCeiling } from "../src/context.ts";
import type { AgentRunner, RawAgentResponse } from "../src/agents/runtime.ts";
import type { FeatureScope } from "../src/scope.ts";

const DOC = `# Permissions

## Proctor restrictions

Proctors must not be able to view or edit users. A Client Admin cannot manage
System Admins.
`;

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "clarvis-dossier-"));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "permissions.md"), DOC, "utf8");
  return dir;
}

const scope: FeatureScope = {
  key: "proctor-permissions",
  title: "Proctor permissions",
  origin: "named",
  paths: [],
  keywords: ["proctor", "permissions", "users"],
  trackerKeys: [],
  routes: [],
  confidence: "high",
  evidence: [],
  truncation: [],
};

/** Replies keyed by agent role, so extract and entail can behave differently. */
function roleRunner(byRole: Record<string, string | string[]>): AgentRunner & { seen: string[] } {
  const counters: Record<string, number> = {};
  return {
    seen: [],
    async invoke(req): Promise<RawAgentResponse> {
      const role = req.definition.role;
      this.seen.push(role);
      const configured = byRole[role] ?? "{}";
      const list = Array.isArray(configured) ? configured : [configured];
      const i = (counters[role] = (counters[role] ?? 0) + 1) - 1;
      return {
        text: list[Math.min(i, list.length - 1)],
        model: req.definition.model,
        usage: { inputTokens: 800, outputTokens: 150 },
      };
    },
  };
}

const REAL_QUOTE = "Proctors must not be able to view or edit users.";

test("gathering finds docs and cites file:line", async () => {
  const dir = await project();
  try {
    const { sources, connectors } = await gatherSources({ projectRoot: dir, scope });
    assert.ok(sources.length > 0);
    assert.match(sources[0].ref, /docs\/permissions\.md:\d+/);
    assert.ok(connectors.some((c) => c.name === "filesystem" && c.status === "ok"));
    // No git repo in a temp dir: reported, not silently omitted.
    assert.ok(connectors.some((c) => c.name === "git" && c.status === "not-configured"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a sourced, entailed requirement becomes a usable oracle", async () => {
  const dir = await project();
  try {
    const runner = roleRunner({
      "archive-extract": JSON.stringify({
        requirements: [
          {
            id: "r1",
            statement: "A Proctor cannot view users.",
            quote: REAL_QUOTE,
            sourceIds: ["s1"],
            confidence: "explicit",
          },
        ],
        unknowns: [],
      }),
      "archive-entail": JSON.stringify({ entailed: true, confidence: "explicit", reason: "stated outright" }),
    });

    const { context, report } = await runDossier({
      projectRoot: dir,
      scope,
      runner,
      budget: new Budget({ maxUsd: 10 }),
    });

    assert.equal(report.accepted, 1);
    assert.equal(context.requirements.length, 1);
    assert.equal(oracleCeiling(context).ceiling, "acceptance-criteria");
    assert.deepEqual(report.rejectedQuotes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fabricated quote never reaches the context, and is recorded as a gap", async () => {
  const dir = await project();
  try {
    const runner = roleRunner({
      "archive-extract": JSON.stringify({
        requirements: [
          {
            id: "r1",
            statement: "Proctors have full administrative access.",
            quote: "Proctors are granted unrestricted administrative privileges.",
            sourceIds: ["s1"],
            confidence: "explicit",
          },
        ],
        unknowns: [],
      }),
      "archive-entail": JSON.stringify({ entailed: true, confidence: "explicit", reason: "n/a" }),
    });

    const { context, report } = await runDossier({
      projectRoot: dir,
      scope,
      runner,
      budget: new Budget({ maxUsd: 10 }),
    });

    assert.equal(context.requirements.length, 0, "an invented quote must not become an oracle");
    assert.equal(report.rejectedQuotes[0].code, "quote-not-found");
    // The over-reach is preserved as an unknown rather than vanishing.
    assert.ok(context.unknowns.some((u) => /full administrative access/i.test(u.question)));
    assert.match(report.warnings.join(" "), /does not appear in the source/);
    assert.equal(oracleCeiling(context).ceiling, "none");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real quote that does not entail the claim is demoted, not accepted", async () => {
  const dir = await project();
  try {
    const runner = roleRunner({
      "archive-extract": JSON.stringify({
        requirements: [
          {
            id: "r1",
            // Real quote, but it says nothing about status codes.
            statement: "The API returns HTTP 403 to a Proctor.",
            quote: REAL_QUOTE,
            sourceIds: ["s1"],
            confidence: "explicit",
          },
        ],
        unknowns: [],
      }),
      "archive-entail": JSON.stringify({
        entailed: false,
        confidence: "implied",
        reason: "the quote says nothing about status codes",
      }),
    });

    const { context, report } = await runDossier({
      projectRoot: dir,
      scope,
      runner,
      budget: new Budget({ maxUsd: 10 }),
    });

    assert.equal(context.requirements.length, 0);
    assert.equal(report.demotedEntailment.length, 1);
    assert.match(report.demotedEntailment[0].reason, /status codes/);
    assert.ok(context.unknowns.some((u) => /HTTP 403/.test(u.question)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the entailment verifier is shown only the quote and the statement", async () => {
  const dir = await project();
  const prompts: string[] = [];
  try {
    const runner: AgentRunner = {
      async invoke(req) {
        if (req.definition.role === "archive-entail") prompts.push(req.prompt);
        const text =
          req.definition.role === "archive-extract"
            ? JSON.stringify({
                requirements: [
                  { id: "r1", statement: "A Proctor cannot view users.", quote: REAL_QUOTE, sourceIds: ["s1"], confidence: "explicit" },
                ],
                unknowns: [],
              })
            : JSON.stringify({ entailed: true, confidence: "explicit", reason: "ok" });
        return { text, model: req.definition.model, usage: { inputTokens: 500, outputTokens: 100 } };
      },
    };

    await runDossier({ projectRoot: dir, scope, runner, budget: new Budget({ maxUsd: 10 }) });

    assert.equal(prompts.length, 1);
    // Nothing that could bias the judgement toward agreeing.
    assert.equal(/proctor permissions/i.test(prompts[0]), false, "the feature title must not leak in");
    assert.equal(prompts[0].includes("docs/permissions.md"), false, "the provenance must not leak in");
    assert.match(prompts[0], /^QUOTE:/);
    assert.match(prompts[0], /STATEMENT:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed extraction produces no requirements and says so loudly", async () => {
  const dir = await project();
  try {
    const runner = roleRunner({ "archive-extract": "not json at all" });
    const { context, report } = await runDossier({
      projectRoot: dir,
      scope,
      runner,
      budget: new Budget({ maxUsd: 10 }),
    });

    assert.equal(context.requirements.length, 0);
    assert.match(report.warnings.join(" "), /did not complete/);
    assert.ok(context.unknowns.length > 0, "a failure must leave a recorded question, not silence");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unverifiable entailment fails closed", async () => {
  const dir = await project();
  try {
    const runner = roleRunner({
      "archive-extract": JSON.stringify({
        requirements: [
          { id: "r1", statement: "A Proctor cannot view users.", quote: REAL_QUOTE, sourceIds: ["s1"], confidence: "explicit" },
        ],
        unknowns: [],
      }),
      // The verifier itself breaks.
      "archive-entail": "garbage",
    });

    const { context, report } = await runDossier({
      projectRoot: dir,
      scope,
      runner,
      budget: new Budget({ maxUsd: 10 }),
    });

    assert.equal(context.requirements.length, 0, "unverified must not mean accepted");
    assert.match(report.demotedEntailment[0].reason, /could not be verified/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no sources means an explicit unknown, never a confident empty context", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "clarvis-empty-"));
  try {
    const runner = roleRunner({});
    const { context, report } = await runDossier({
      projectRoot: dir,
      scope,
      runner,
      budget: new Budget({ maxUsd: 10 }),
    });

    assert.equal(report.sourcesGathered, 0);
    assert.equal(runner.seen.length, 0, "with nothing to reason about, no model call should be made");
    assert.match(context.unknowns[0].question, /supposed to do/);
    assert.equal(oracleCeiling(context).ceiling, "none");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an exhausted budget stops the pipeline without inventing a result", async () => {
  const dir = await project();
  try {
    const runner = roleRunner({ "archive-extract": "{}" });
    const { context, report } = await runDossier({
      projectRoot: dir,
      scope,
      runner,
      budget: new Budget({ maxUsd: 0.000001 }),
    });

    assert.equal(context.requirements.length, 0);
    assert.equal(report.agentRuns[0].status, "budget-exceeded");
    assert.match(report.warnings.join(" "), /did not complete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
