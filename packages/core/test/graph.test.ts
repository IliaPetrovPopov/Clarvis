import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GraphConnector,
  blastRadius,
  parseAffected,
  type GraphExec,
} from "../src/connectors/graph.ts";

/**
 * The code graph is optional infrastructure. The behaviour that matters most is
 * what happens when it is absent or broken: a run without it has less ranking
 * signal, and must never be a failed run.
 */

const REAL_AFFECTED = `Affected nodes for auth-service/models/User.ts
Relations: calls, indirect_call, references, imports
Depth: 1
- authentication.ts [imports_from] services/auth-service/controllers/authentication.ts:L1
- auth-service/controllers/user.ts [imports_from] services/auth-service/controllers/user.ts:L1
- Request [references] services/auth-service/env.d.ts:L26
`;

function fakeExec(handler: (args: string[]) => Partial<{ ok: boolean; stdout: string; stderr: string }>) {
  const calls: string[][] = [];
  const exec: GraphExec = async (args) => {
    calls.push(args);
    const r = handler(args);
    return { ok: r.ok ?? true, stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.ok === false ? 1 : 0 };
  };
  return { exec, calls };
}

async function projectWithGraph(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-graph-"));
  await mkdir(path.join(root, "graphify-out"), { recursive: true });
  await writeFile(path.join(root, "graphify-out", "graph.json"), "{}", "utf8");
  return root;
}

/* ------------------------------------------------------------------ parsing */

test("affected output is parsed from the real shape graphify emits", () => {
  const nodes = parseAffected(REAL_AFFECTED);
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes[0], {
    label: "authentication.ts",
    relation: "imports_from",
    ref: "services/auth-service/controllers/authentication.ts:L1",
  });
  // The header lines are not nodes.
  assert.equal(nodes.some((n) => n.label.startsWith("Affected")), false);
  assert.equal(nodes.some((n) => n.label.startsWith("Relations")), false);
});

test("a line that does not match the expected shape is skipped, not guessed at", () => {
  assert.deepEqual(parseAffected("- broken line with no relation\nrandom text\n"), []);
});

/* --------------------------------------------------------------- absence */

test("a missing binary is a stated absence, not a thrown error", async () => {
  const root = await projectWithGraph();
  const { exec } = fakeExec(() => ({ ok: false, stderr: "spawn graphify ENOENT" }));

  const result = await new GraphConnector({ projectRoot: root, exec }).build();
  assert.equal(result.status, "not-installed");
  assert.equal(result.data.built, false);
  // The note has to be safe to show a human, because it will be.
  assert.match(result.note!, /not installed/);
});

test("no graph file means no hotspots, and it says so", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-nograph-"));
  const { exec, calls } = fakeExec(() => ({ ok: true, stdout: "[]" }));

  const result = await new GraphConnector({ projectRoot: root, exec }).hotspots();
  assert.equal(result.status, "no-graph");
  assert.deepEqual(result.data, []);
  // It must not shell out at all when there is nothing to read.
  assert.equal(calls.length, 0);
});

test("malformed output is a failure, never an empty success", async () => {
  // An empty list would read as "this project has no hubs", which is a claim.
  const root = await projectWithGraph();
  const { exec } = fakeExec((args) =>
    args[0] === "god-nodes" ? { ok: true, stdout: "not json at all" } : { ok: true, stdout: "Usage: graphify" },
  );

  const result = await new GraphConnector({ projectRoot: root, exec }).hotspots();
  assert.equal(result.status, "failed");
});

/* ------------------------------------------------------------------- build */

test("building never invokes an operation that costs money", async () => {
  const root = await projectWithGraph();
  const { exec, calls } = fakeExec(() => ({ ok: true, stdout: "Usage: graphify" }));

  await new GraphConnector({ projectRoot: root, exec }).build();

  const flat = calls.flat().join(" ");
  // `update` is local AST parsing. `label`, `cluster-only` and any --backend
  // call a model, and a setup step must not quietly spend a plan allowance.
  assert.ok(flat.includes("update"));
  assert.equal(/\blabel\b|cluster-only|--backend/.test(flat), false);
});

/* ------------------------------------------------------------ blast radius */

test("blast radius ranks by how many changed files reach a node", async () => {
  // Something pulled in by three separate edits is a better test candidate than
  // something pulled in by one, whatever either file's importance in isolation.
  const root = await projectWithGraph();
  const { exec } = fakeExec((args) => {
    if (args[0] !== "affected") return { ok: true, stdout: "Usage: graphify" };
    const file = args[1];
    if (file === "a.ts") return { ok: true, stdout: "- shared [imports_from] shared.ts:L1\n- onlyA [calls] a2.ts:L4\n" };
    if (file === "b.ts") return { ok: true, stdout: "- shared [imports_from] shared.ts:L1\n" };
    return { ok: true, stdout: "" };
  });

  const graph = new GraphConnector({ projectRoot: root, exec });
  const result = await blastRadius(graph, ["a.ts", "b.ts"], { depth: 1 });

  assert.equal(result.status, "ok");
  assert.equal(result.data[0].label, "shared");
  assert.equal(result.data[0].reachedBy, 2);
  assert.equal(result.data[1].reachedBy, 1);
});

test("a file the graph does not know does not abort the sweep", async () => {
  // New files and unparsed languages are normal, not exceptional.
  const root = await projectWithGraph();
  const { exec } = fakeExec((args) => {
    if (args[0] !== "affected") return { ok: true, stdout: "Usage: graphify" };
    return args[1] === "known.ts"
      ? { ok: true, stdout: "- dep [calls] dep.ts:L2\n" }
      : { ok: false, stderr: "node not found" };
  });

  const result = await blastRadius(new GraphConnector({ projectRoot: root, exec }), [
    "unknown.ts",
    "known.ts",
  ]);

  assert.equal(result.status, "ok");
  assert.deepEqual(result.data.map((d) => d.label), ["dep"]);
});

test("no graph at all yields an empty radius rather than a thrown error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-nograph-"));
  const { exec } = fakeExec(() => ({ ok: true, stdout: "" }));
  const result = await blastRadius(new GraphConnector({ projectRoot: root, exec }), ["a.ts"]);
  assert.equal(result.status, "no-graph");
  assert.deepEqual(result.data, []);
});
