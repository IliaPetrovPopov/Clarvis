import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_CONTRACT,
  STAGE_KEYS,
  checkRun,
  clarvisPaths,
  describePipelineViolations,
  type Run,
  type Violation,
} from "@clarvis/core";
import { isPortInUse } from "./ui.ts";

/**
 * Run the whole pipeline against a known target and check what came out.
 *
 * This exists because of a pattern rather than a bug. Work was being reported
 * as finished on the strength of a passing unit suite and a clean typecheck,
 * and then integration bugs were found later - by a person asking whether it
 * worked. Every one of them was invisible to the tests and obvious within one
 * real run: warm-up walking forty-seven routes serially, a progress scale the
 * run could never reach the end of, tokens computed and discarded, a server
 * and a page disagreeing about their own contract.
 *
 * None of those is checkable from inside the unit that produces it. They are
 * properties of the pipeline as a whole, so the only thing that finds them is
 * running the pipeline as a whole. That is what this does, and it is meant to
 * be run before saying anything is done - not after being asked.
 *
 * Two modes, because the expensive part is not the part that breaks.
 *
 *   DEFAULT   every stage except the agents, which are stubbed. Seconds, no
 *             tokens, and it still exercises boot, the surface map, the gate,
 *             the runner, triage's plumbing and every invariant below. This is
 *             the one to run habitually.
 *
 *   --live    the real thing, agents included. Minutes and real usage. Run it
 *             when the change touches what an agent is asked to do, because
 *             that is the only part the stub cannot speak for.
 */

export interface SmokeResult {
  ok: boolean;
  mode: "stubbed" | "live";
  durationMs: number;
  runId?: string;
  violations: Violation[];
  /** Things that went wrong outside the run itself. */
  blockers: string[];
  stages: string[];
}

function demoAppDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../examples/demo-app");
}

function clarvisBin(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../bin/clarvis.mjs");
}

function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; log?: (l: string) => void },
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });

    let out = "";
    const collect = (b: Buffer) => {
      const text = b.toString();
      out += text;
      if (out.length > 200_000) out = out.slice(-200_000);
      for (const line of text.split("\n")) if (line.trim()) opts.log?.(line);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 20 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: `${out}\n${e.message}` });
    });
  });
}

export interface SmokeOptions {
  live?: boolean;
  /** Kept out of the way of a real dashboard and a real dev server. */
  port?: number;
  log?: (line: string) => void;
}

export async function smoke(opts: SmokeOptions = {}): Promise<SmokeResult> {
  const log = opts.log ?? (() => {});
  const startedAt = Date.now();
  const port = opts.port ?? 4600;
  const blockers: string[] = [];

  // The whole thing runs in a throwaway store. A smoke run must not add a
  // project to the registry, prune someone's real runs, or leave a profile
  // behind - it is a check, and a check that mutates what it checks is not one.
  const home = await mkdtemp(path.join(tmpdir(), "clarvis-smoke-home-"));

  // Not started here: the profile carries a boot command, so letting the
  // pipeline start it exercises bootAndVerify as well. All that is needed is
  // that the port is ours - a run against whatever else is listening would
  // pass or fail for reasons unrelated to this codebase.
  if (await isPortInUse(port)) {
    await rm(home, { recursive: true, force: true });
    return {
      ok: false,
      mode: opts.live ? "live" : "stubbed",
      durationMs: Date.now() - startedAt,
      violations: [],
      blockers: [
        `Something is already listening on ${port}, which is the demo app's port. ` +
          `Testing whatever else is there would measure nothing.`,
      ],
      stages: [],
    };
  }

  try {
    /*
      Seed the throwaway store from the demo app's checked-in fixtures.

      They exist for exactly this: a known profile, context and plan so a
      check starts from a fixed point. The alternative is running recon, which
      needs agents, takes minutes and gives a slightly different answer every
      time - none of which belongs in a check meant to be run habitually.
    */
    const paths = clarvisPaths(demoAppDir(), { CLARVIS_HOME: home } as NodeJS.ProcessEnv);
    const { mkdir, cp } = await import("node:fs/promises");
    await mkdir(paths.root, { recursive: true });

    /*
      Only the inputs. Not scratch.

      The demo app also ships previously authored specs, and copying those in
      made the first smoke run green while authoring had in fact failed: the
      runner found the stale files and ran them. A check that reports a pass
      for work it never did is the precise failure this product exists to
      prevent, so it must not be the first thing the checker does.
    */
    for (const fixture of ["profile.json", "context.json", "plan.json"]) {
      await cp(path.join(demoAppDir(), ".clarvis", fixture), path.join(paths.root, fixture)).catch(
        () => blockers.push(`The demo app is missing its ${fixture} fixture.`),
      );
    }

    const env: Record<string, string> = {
      CLARVIS_HOME: home,
    };
    // Stubbed by default: the agents are the slow, expensive part and the
    // least likely to be what a plumbing change broke.
    if (!opts.live) env.CLARVIS_STUB_AGENTS = "1";

    log(`running the pipeline against the demo app on ${port}${opts.live ? " (live agents)" : ""}`);

    const result = await run(
      process.execPath,
      [
        clarvisBin(),
        "run",
        "--project",
        demoAppDir(),
        "--axis",
        "rbac-scope",
        "--axis",
        "responsive-a11y",
        // A stubbed agent spends nothing, but the budget reserves against the
        // definition's estimate before the call - so a tight ceiling starves
        // the author and the run quietly proceeds with no specs at all.
        "--max-usd",
        opts.live ? "3" : "10",
        "--keep-runs",
        "2",
        "--no-sandbox",
      ],
      { env, timeoutMs: opts.live ? 20 * 60_000 : 6 * 60_000, log: (l) => log(l.trim()) },
    );

    // A non-zero exit is expected: the demo app has seeded bugs, so findings
    // are the correct outcome. Only a crash matters, and that is what an
    // unreadable run record tells us.
    let record: Run | undefined;
    try {
      const runsDir = path.join(paths.root, "runs");
      const { readdir } = await import("node:fs/promises");
      const ids = (await readdir(runsDir)).sort();
      const latest = ids[ids.length - 1];
      record = JSON.parse(await readFile(path.join(runsDir, latest, "run.json"), "utf8")) as Run;
    } catch {
      blockers.push(
        `The run left no readable record. Exit code ${result.code}. ` +
          `Last output: ${result.out.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 300)}`,
      );
    }

    if (!record) {
      return {
        ok: false,
        mode: opts.live ? "live" : "stubbed",
        durationMs: Date.now() - startedAt,
        violations: [],
        blockers,
        stages: [],
      };
    }

    const violations = checkRun(record, { live: opts.live });

    // Authoring is the step most worth proving, and the one that failed
    // invisibly the first time this ran.
    const authored = (record.axes ?? []).filter((a) => a.status === "done");
    if (!authored.length) {
      violations.push({
        code: "nothing-authored",
        detail: "No axis produced a spec that passed the gate, so nothing was actually tested.",
        cost: "The check reports on a pipeline that did not run, which is worse than not checking.",
      });
    }
    const stages = [...(record.stage?.done ?? []).map((d) => d.key), record.stage?.key].filter(
      (k): k is string => Boolean(k),
    );

    return {
      ok: violations.length === 0 && blockers.length === 0,
      mode: opts.live ? "live" : "stubbed",
      durationMs: Date.now() - startedAt,
      runId: record.runId,
      violations,
      blockers,
      stages,
    };
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

/** The report, for a terminal. */
export function describeSmoke(result: SmokeResult): string[] {
  const lines: string[] = [];
  const seconds = Math.round(result.durationMs / 1000);

  lines.push(`mode       ${result.mode}${result.mode === "stubbed" ? " (agents not called)" : ""}`);
  lines.push(`took       ${seconds}s`);
  if (result.runId) lines.push(`run        ${result.runId}`);
  lines.push(`api        contract ${API_CONTRACT}`);

  // The stage list, so a missing one is visible rather than merely counted.
  const reached = new Set(result.stages);
  lines.push(
    `stages     ${STAGE_KEYS.map((k) => (reached.has(k) ? k : `(${k})`)).join(" ")}`,
  );

  for (const b of result.blockers) lines.push(`BLOCKED    ${b}`);
  for (const line of describePipelineViolations(result.violations)) lines.push(`FAIL       ${line}`);

  if (result.ok) {
    lines.push("");
    lines.push("Every stage fired, within budget, and the record holds what the dashboard reads.");
  }

  return lines;
}
