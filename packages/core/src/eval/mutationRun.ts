import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootAndVerify } from "../boot.ts";
import { GitConnector } from "../connectors/git.ts";
import { parsePlaywrightReport, runAxisSpecs } from "../runner.ts";
import type { Profile } from "../types.ts";
import {
  applyMutant,
  generateMutants,
  sampleMutants,
  type Mutant,
  type MutantResult,
  type MutationScore,
} from "./mutation.ts";

/**
 * Executing mutants against a live suite.
 *
 * Split from `mutation.ts` on purpose: everything there is pure and testable
 * without touching a disk, and everything here writes to the user's source
 * files. Keeping the dangerous half small and separate is most of what makes it
 * reviewable.
 *
 * The invariant this file exists to hold: THE PROJECT IS BYTE-IDENTICAL WHEN
 * THIS RETURNS, on every path including a crash. A mutation tester that leaves
 * corrupted source behind has done more damage than any bug it could find.
 */

export interface MutationRunOptions {
  projectRoot: string;
  /** Source files to mutate. Relative to projectRoot or absolute. */
  files: string[];
  /** Directory holding the authored specs. */
  specDir: string;
  profile: Profile;
  /** Which axis' specs to run against each mutant. */
  axisKey: string;
  outputDir: string;
  /** Ceiling on mutants. Each one is a full spec run, so this is the time knob. */
  maxMutants?: number;
  /** Abort a single mutant's spec run after this long. */
  timeoutMs?: number;
  /**
   * Restart the application between mutants.
   *
   * Required for anything that loads its source once - which is every server.
   * Without it a mutant is written to disk while the running process still
   * holds the original in memory, so nothing changes and every mutant
   * "survives". A first live run scored 0/6 that way, including a mutant a spec
   * asserted against directly.
   *
   * Off only for targets that read their source per request, or where the
   * caller manages the lifecycle itself.
   */
  restartApp?: boolean;
  log?: (line: string) => void;
  git?: GitConnector;
}

/**
 * Files this must never mutate, whatever it was handed.
 *
 * Mutating a spec makes the suite fail against itself and scores a kill that
 * measures nothing. Mutating config or generated output produces noise.
 */
export function isMutableSource(file: string): boolean {
  const rel = file.replace(/\\/g, "/");
  if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(rel)) return false;
  if (/(^|\/)(node_modules|dist|build|coverage|\.clarvis|graphify-out)\//.test(rel)) return false;
  if (/\.(json|md|lock|snap|css|scss|svg|png|jpe?g)$/.test(rel)) return false;
  return /\.[cm]?[jt]sx?$/.test(rel);
}

/**
 * Restore a file and prove it. A silent restore failure is the one outcome that
 * cannot be allowed, so this reads the file back rather than trusting the write.
 */
async function restoreVerified(absolute: string, original: string): Promise<void> {
  await writeFile(absolute, original, "utf8");
  const readBack = await readFile(absolute, "utf8");

  if (readBack !== original) {
    throw new Error(
      `FAILED TO RESTORE ${absolute}. The file is not what it was before mutation. ` +
        `Restore it from git before doing anything else.`,
    );
  }
}

/**
 * Does this content parse?
 *
 * `node --check` rather than `vm.Script`, because a Script cannot compile ESM -
 * an `import` statement is a syntax error there, so the first attempt at this
 * rejected every module in the project and reported six errors where there were
 * none. `--check` respects the file extension and handles both module systems.
 *
 * A mutant that does not parse would be killed by every suite for the wrong
 * reason, which inflates the score in the flattering direction. Excluding it is
 * the honest treatment.
 */
export async function parses(content: string, filename: string): Promise<boolean> {
  const probe = path.join(
    await mkdtemp(path.join(tmpdir(), "clarvis-parse-")),
    path.basename(filename),
  );

  try {
    await writeFile(probe, content, "utf8");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--check", probe], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("syntax"))));
    });
    return true;
  } catch {
    return false;
  } finally {
    await rm(path.dirname(probe), { recursive: true, force: true });
  }
}

/**
 * Where an in-flight mutation is recorded, so a killed process can be undone.
 *
 * A `finally` handles exceptions; it does not survive SIGKILL, a closed
 * terminal, or a machine losing power. That was not theoretical - a run killed
 * at a timeout left a mutated `server.mjs` on disk, which is precisely the
 * outcome the `finally` was supposed to make impossible. The journal is what
 * makes the guarantee structural rather than merely careful.
 */
export function journalPath(projectRoot: string): string {
  return path.join(projectRoot, ".clarvis", "mutation-journal.json");
}

interface Journal {
  file: string;
  original: string;
  mutantId: string;
  startedAt: string;
}

/**
 * Undo a mutation stranded by a previous run.
 *
 * Called before anything else, every time. A stranded mutation is silently
 * wrong code in someone's repository, and the longer it sits the likelier it is
 * to be committed by accident.
 */
export async function recoverStrandedMutation(
  projectRoot: string,
): Promise<{ recovered: boolean; file?: string; note?: string }> {
  const file = journalPath(projectRoot);

  let journal: Journal;
  try {
    journal = JSON.parse(await readFile(file, "utf8")) as Journal;
  } catch {
    return { recovered: false };
  }

  const absolute = path.join(projectRoot, journal.file);
  try {
    const current = await readFile(absolute, "utf8");

    if (current === journal.original) {
      // Already correct: the finally block did run, only the journal outlived it.
      await rm(file, { force: true });
      return { recovered: false, file: journal.file, note: "Journal was stale; the file was already correct." };
    }

    await writeFile(absolute, journal.original, "utf8");
    if ((await readFile(absolute, "utf8")) !== journal.original) throw new Error("the write did not take");

    await rm(file, { force: true });
    return {
      recovered: true,
      file: journal.file,
      note: `Restored ${journal.file}, left mutated by a run that did not finish (${journal.mutantId}).`,
    };
  } catch (e) {
    return {
      recovered: false,
      file: journal.file,
      note:
        `COULD NOT RESTORE ${journal.file} from the mutation journal at ${file}: ` +
        `${e instanceof Error ? e.message : String(e)}. Restore it from git before continuing.`,
    };
  }
}

export async function runMutationTesting(opts: MutationRunOptions): Promise<MutationScore> {
  const log = opts.log ?? (() => {});
  const git = opts.git ?? new GitConnector(opts.projectRoot);
  const skipped: MutationScore["skipped"] = [];
  const results: MutantResult[] = [];

  // Anything a previous run stranded comes back first, before this one adds to it.
  const recovered = await recoverStrandedMutation(opts.projectRoot);
  if (recovered.note) log(recovered.note);
  if (recovered.file && !recovered.recovered && /COULD NOT RESTORE/.test(recovered.note ?? "")) {
    throw new Error(recovered.note);
  }

  // Without git there is no independent way to prove a file came back, and
  // "trust me, the finally block ran" is not a safety property.
  if (!(await git.isRepo())) {
    throw new Error(
      "Mutation testing requires a git repository: it edits source files, and git is how a " +
        "restore is verified. Refusing to run.",
    );
  }

  const dirty = new Set((await git.uncommittedFiles()).map((f) => f.replace(/\\/g, "/")));

  const candidates: string[] = [];
  for (const file of opts.files) {
    const rel = path.isAbsolute(file) ? path.relative(opts.projectRoot, file) : file;
    const normalised = rel.replace(/\\/g, "/");

    if (!isMutableSource(normalised)) {
      skipped.push({ file: normalised, why: "Not a mutable source file (spec, config, or generated)." });
      continue;
    }
    if (dirty.has(normalised)) {
      // A mutation and someone's unsaved work are indistinguishable once
      // written, and the wrong one could be reverted.
      skipped.push({ file: normalised, why: "Has uncommitted changes. Commit or stash before mutating it." });
      continue;
    }
    candidates.push(normalised);
  }

  /* --- generate ---------------------------------------------------------- */

  const all: Mutant[] = [];
  const sources = new Map<string, string>();

  for (const rel of candidates) {
    const absolute = path.join(opts.projectRoot, rel);
    const source = await readFile(absolute, "utf8").catch(() => undefined);
    if (source === undefined) {
      skipped.push({ file: rel, why: "Could not be read." });
      continue;
    }
    sources.set(rel, source);
    all.push(...generateMutants(source, rel));
  }

  const limit = opts.maxMutants ?? 30;
  const chosen = sampleMutants(all, limit);

  if (all.length > chosen.length) {
    // A cap that is not reported reads as "this is the whole picture".
    skipped.push({
      file: "(sampling)",
      why: `${all.length} mutants possible, ${chosen.length} run. The kill rate is an estimate from a spread sample.`,
    });
  }

  log(`${chosen.length} mutant(s) from ${candidates.length} file(s)`);

  /* --- run, one at a time ------------------------------------------------ */

  // A signal handler restores what `finally` would have. SIGKILL cannot be
  // caught at all, which is why the journal exists as well - between the two,
  // every way a process can die is covered.
  let live: { absolute: string; original: string } | undefined;
  const onSignal = () => {
    if (live) {
      try {
        // Synchronous on purpose: an async write does not complete during exit.
        writeFileSync(live.absolute, live.original, "utf8");
      } catch {
        /* the journal is the remaining line of defence */
      }
    }
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  try {
  for (const [i, mutant] of chosen.entries()) {
    const absolute = path.join(opts.projectRoot, mutant.file);
    const original = sources.get(mutant.file)!;

    let mutated: string;
    try {
      mutated = applyMutant(original, mutant);
    } catch (e) {
      results.push({
        mutant,
        outcome: "error",
        note: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    // A mutant that does not parse would be killed by every suite for the wrong
    // reason, inflating the score in the flattering direction.
    if (!(await parses(mutated, mutant.file))) {
      results.push({ mutant, outcome: "error", note: "The mutant does not parse. Excluded." });
      continue;
    }

    let stopApp: (() => Promise<void>) | undefined;

    try {
      // Journal first, then mutate. The other order leaves a window where a
      // kill strands a file with nothing recording that it happened.
      await mkdir(path.dirname(journalPath(opts.projectRoot)), { recursive: true });
      await writeFile(
        journalPath(opts.projectRoot),
        JSON.stringify(
          { file: mutant.file, original, mutantId: mutant.id, startedAt: new Date().toISOString() },
          null,
          2,
        ),
        "utf8",
      );
      live = { absolute, original };

      await writeFile(absolute, mutated, "utf8");

      if (opts.restartApp) {
        // The app must be brought up AFTER the mutation, or it loads the
        // original source and the mutant has no effect at all.
        const boot = await bootAndVerify(opts.profile);
        stopApp = boot.stop;

        if (!boot.verified) {
          // A mutant that stops the app from booting is a killed mutant: the
          // change was detected, just by the process rather than by an
          // assertion.
          results.push({
            mutant,
            outcome: "killed",
            killedBy: "boot",
            note: `The application did not start with this change: ${boot.blockers[0] ?? "no detail"}`,
          });
          continue;
        }
      }

      const outcome = await runAxisSpecs({
        axisKey: opts.axisKey,
        profile: opts.profile,
        specDir: opts.specDir,
        outputDir: path.join(opts.outputDir, "mutants", mutant.id.replace(/[^\w.-]/g, "_")),
        baseURL: opts.profile.boot.url,
        timeoutMs: opts.timeoutMs ?? 120_000,
      });

      const report = await readFile(outcome.reportPath, "utf8")
        .then((raw) => parsePlaywrightReport(JSON.parse(raw) as unknown))
        .catch(() => undefined);

      const executed = report
        ? (report.passed ?? 0) + (report.failed ?? 0) + (report.flaky ?? 0)
        : 0;

      if (!report || executed === 0) {
        // No tests ran, so this mutant was never actually challenged. Counting
        // it as survived would blame the suite for an infrastructure problem.
        results.push({
          mutant,
          outcome: "not-run",
          note: `No tests executed (exit ${outcome.exitCode}). ${outcome.stderr.slice(-160)}`,
        });
      } else if ((report.failed ?? 0) > 0 || (report.flaky ?? 0) > 0) {
        results.push({ mutant, outcome: "killed", killedBy: opts.axisKey });
      } else {
        results.push({ mutant, outcome: "survived" });
      }
    } catch (e) {
      results.push({ mutant, outcome: "error", note: e instanceof Error ? e.message : String(e) });
    } finally {
      // The app comes down before the file goes back, so the next boot cannot
      // race a half-restored source.
      await stopApp?.().catch(() => {});
      // Always, on every path. The whole file exists for this line.
      await restoreVerified(absolute, original);
      live = undefined;
      await rm(journalPath(opts.projectRoot), { force: true });
    }

    const last = results.at(-1)!;
    log(
      `[${i + 1}/${chosen.length}] ${last.outcome.padEnd(9)} ${mutant.file}:${mutant.line} ` +
        `${mutant.before} -> ${mutant.after}`,
    );
  }

  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  }

  const killed = results.filter((r) => r.outcome === "killed").length;
  const survived = results.filter((r) => r.outcome === "survived").length;
  const judged = killed + survived;

  return {
    total: results.length,
    killed,
    survived,
    notRun: results.filter((r) => r.outcome === "not-run").length,
    errored: results.filter((r) => r.outcome === "error").length,
    // Only mutants that actually faced the suite count. Anything else would
    // flatter or punish the specs for something they never saw.
    killRate: judged > 0 ? killed / judged : undefined,
    results,
    skipped,
  };
}

/** Survivors first: they are the specific gaps worth acting on. */
export function describeMutationScore(score: MutationScore): string[] {
  const lines: string[] = [];

  lines.push(
    score.killRate === undefined
      ? `No mutant was judged, so there is no kill rate. ${score.notRun} did not run.`
      : `${score.killed}/${score.killed + score.survived} mutants killed (${Math.round(score.killRate * 100)}%)`,
  );

  const survivors = score.results.filter((r) => r.outcome === "survived");
  if (survivors.length) {
    lines.push("");
    lines.push("Survived - the suite did not notice these changes:");
    for (const r of survivors.slice(0, 15)) {
      lines.push(`  ${r.mutant.file}:${r.mutant.line}  ${r.mutant.before} -> ${r.mutant.after}`);
      lines.push(`      ${r.mutant.preview}`);
    }
    if (survivors.length > 15) lines.push(`  ... and ${survivors.length - 15} more`);
  }

  if (score.notRun || score.errored) {
    lines.push("");
    lines.push(`${score.notRun} mutant(s) never ran, ${score.errored} errored. Excluded from the rate.`);
  }

  for (const s of score.skipped) {
    lines.push(`  skipped  ${s.file}: ${s.why}`);
  }

  return lines;
}
