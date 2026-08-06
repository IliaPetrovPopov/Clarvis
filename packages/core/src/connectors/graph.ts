import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Code-graph connector, built on the local `graphify` binary.
 *
 * This answers a question nothing else in Clarvis can: what else does a change
 * reach? VECTOR ranks axes from filenames and keywords, which tells it what was
 * edited but not what depends on it - and "this file is imported by the auth
 * middleware" is exactly the signal that should move rbac to the top.
 *
 * Three rules shape this file:
 *
 *   1. OPTIONAL, ALWAYS. graphify is a separate tool that may not be installed.
 *      Every function here returns a stated absence rather than throwing, and a
 *      run without a graph is a run with less ranking signal, not a failed one.
 *
 *   2. FREE OPERATIONS ONLY, by default. `graphify update` is pure local AST
 *      parsing and costs nothing. `label` and semantic extraction call a model
 *      and are never invoked from here - a setup step that quietly spends the
 *      user's plan allowance is not a setup step.
 *
 *   3. IT IS A CONNECTOR, NOT A TOOL. No agent can reach it. Agents have no
 *      shell, and that rule does not get an exception because this particular
 *      command happens to be useful.
 */

export interface GraphHotspot {
  id: string;
  label: string;
  /** Edge count. High means many things depend on it. */
  degree: number;
}

export interface AffectedNode {
  label: string;
  relation: string;
  /** file:line, when graphify reported one. */
  ref?: string;
}

export type GraphStatus = "ok" | "not-installed" | "no-graph" | "failed";

export interface GraphResult<T> {
  status: GraphStatus;
  data: T;
  /** Why the data is empty, when it is. Always safe to show a human. */
  note?: string;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export type GraphExec = (args: string[], cwd: string, timeoutMs: number) => Promise<RunResult>;

const defaultExec: GraphExec = (args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn("graphify", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const done = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, stdout, stderr: `${stderr}\ntimed out`, code: null });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 256 * 1024) stderr += d.toString();
    });

    // A missing binary is an ordinary outcome here, not an error to propagate.
    child.on("error", (e) => done({ ok: false, stdout, stderr: e.message, code: null }));
    child.on("close", (code) => done({ ok: code === 0, stdout, stderr, code }));
  });

export interface GraphConnectorOptions {
  projectRoot: string;
  exec?: GraphExec;
  /** Building a graph on a large repo takes a while. */
  buildTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export class GraphConnector {
  private readonly projectRoot: string;
  private readonly exec: GraphExec;
  private readonly buildTimeoutMs: number;
  private readonly queryTimeoutMs: number;

  constructor(options: GraphConnectorOptions) {
    this.projectRoot = options.projectRoot;
    this.exec = options.exec ?? defaultExec;
    this.buildTimeoutMs = options.buildTimeoutMs ?? 300_000;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 30_000;
  }

  /** Whether the binary is on the path at all. */
  async isAvailable(): Promise<boolean> {
    const result = await this.exec(["--help"], this.projectRoot, 10_000);
    return result.ok || /Usage: graphify/.test(result.stdout + result.stderr);
  }

  private graphFile(): string {
    return path.join(this.projectRoot, "graphify-out", "graph.json");
  }

  async hasGraph(): Promise<boolean> {
    return stat(this.graphFile())
      .then((s) => s.isFile())
      .catch(() => false);
  }

  /**
   * Build or refresh the graph.
   *
   * `graphify update` is local AST parsing with no model call, which is why it
   * is safe to offer as part of setup. Nothing here runs `label` or semantic
   * extraction: those cost, and a setup step that silently spends someone's
   * plan allowance is not one.
   */
  async build(): Promise<GraphResult<{ built: boolean }>> {
    if (!(await this.isAvailable())) {
      return {
        status: "not-installed",
        data: { built: false },
        note: "graphify is not installed, so no code graph was built. Ranking falls back to filenames and keywords.",
      };
    }

    const result = await this.exec(
      // No clustering visualisation: it is slow, it is not read by anything
      // here, and it is skipped silently above a node cap anyway.
      ["update", ".", "--no-cluster"],
      this.projectRoot,
      this.buildTimeoutMs,
    );

    if (!result.ok) {
      return {
        status: "failed",
        data: { built: false },
        note: `graphify update failed: ${(result.stderr || result.stdout).trim().slice(-300)}`,
      };
    }

    return { status: "ok", data: { built: true } };
  }

  /**
   * The most connected nodes: the places where a change reaches furthest.
   *
   * These become `profile.risk.hotspots`, a field the schema has always had and
   * nothing has ever filled.
   */
  async hotspots(top = 12): Promise<GraphResult<GraphHotspot[]>> {
    if (!(await this.hasGraph())) {
      return { status: "no-graph", data: [], note: "No graphify-out/graph.json in this project." };
    }

    const result = await this.exec(
      ["god-nodes", "--json", "--top", String(top)],
      this.projectRoot,
      this.queryTimeoutMs,
    );
    if (!result.ok) {
      return { status: "failed", data: [], note: result.stderr.trim().slice(-200) };
    }

    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed)) return { status: "failed", data: [], note: "Unexpected output shape." };

      return {
        status: "ok",
        data: parsed
          .filter((n): n is GraphHotspot => typeof (n as GraphHotspot)?.label === "string")
          .map((n) => ({ id: String(n.id ?? ""), label: n.label, degree: Number(n.degree ?? 0) })),
      };
    } catch {
      return { status: "failed", data: [], note: "god-nodes did not return JSON." };
    }
  }

  /**
   * What depends on a file. The blast radius of changing it.
   *
   * Parsed from the text output because there is no JSON mode for this command;
   * a line that does not match the expected shape is skipped rather than
   * guessed at.
   */
  async affected(node: string, depth = 2): Promise<GraphResult<AffectedNode[]>> {
    if (!(await this.hasGraph())) {
      return { status: "no-graph", data: [], note: "No graphify-out/graph.json in this project." };
    }

    const result = await this.exec(
      ["affected", node, "--depth", String(depth)],
      this.projectRoot,
      this.queryTimeoutMs,
    );
    if (!result.ok) {
      return { status: "failed", data: [], note: result.stderr.trim().slice(-200) };
    }

    return { status: "ok", data: parseAffected(result.stdout) };
  }
}

/** `- label [relation] path:Lnn` */
export function parseAffected(stdout: string): AffectedNode[] {
  const out: AffectedNode[] = [];

  for (const line of stdout.split("\n")) {
    const match = /^-\s+(.+?)\s+\[([^\]]+)\](?:\s+(\S+))?\s*$/.exec(line.trim());
    if (!match) continue;
    out.push({ label: match[1].trim(), relation: match[2].trim(), ref: match[3] });
  }

  return out;
}

/**
 * Blast radius for a set of changed files, deduplicated and ranked.
 *
 * Ranked by how many changed files reach a node: something pulled in by three
 * separate edits is a better candidate for testing than something pulled in by
 * one, regardless of either file's importance in isolation.
 */
export async function blastRadius(
  graph: GraphConnector,
  files: readonly string[],
  opts: { depth?: number; maxFiles?: number; maxNodes?: number } = {},
): Promise<GraphResult<Array<{ label: string; reachedBy: number; relation: string; ref?: string }>>> {
  const counts = new Map<string, { label: string; reachedBy: number; relation: string; ref?: string }>();
  let anyOk = false;
  let note: string | undefined;
  // Kept apart deliberately: "there is no graph" and "the graph is there but
  // the query broke" call for different responses, and collapsing them into one
  // failure hides which it was.
  let reason: GraphStatus | undefined;

  for (const file of files.slice(0, opts.maxFiles ?? 25)) {
    const result = await graph.affected(file, opts.depth ?? 2);
    if (result.status !== "ok") {
      note ??= result.note;
      reason ??= result.status;
      // A file the graph does not know is normal - a new file, or a language
      // the extractor does not parse. Not worth aborting the whole sweep.
      continue;
    }
    anyOk = true;

    for (const node of result.data) {
      const existing = counts.get(node.label);
      if (existing) existing.reachedBy++;
      else counts.set(node.label, { label: node.label, reachedBy: 1, relation: node.relation, ref: node.ref });
    }
  }

  const ranked = [...counts.values()]
    .sort((a, b) => b.reachedBy - a.reachedBy || a.label.localeCompare(b.label))
    .slice(0, opts.maxNodes ?? 40);

  return {
    status: anyOk ? "ok" : (reason ?? "no-graph"),
    data: ranked,
    note: anyOk ? undefined : note,
  };
}
