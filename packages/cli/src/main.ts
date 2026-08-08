import { parseArgs } from "node:util";
import path from "node:path";
import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  AXES,
  bootAndVerify,
  warmUp,
  warmRoutes,
  measureRendering,
  decideGuard,
  applyGuardToAxes,
  provisionSandbox,
  sweepFixtures,
  enrolRole,
  withdrawRole,
  loadLessons,
  saveLessons,
  learnFromRun,
  mistakesFrom,
  renderLessons,
  AGENTS,
  STAGES,
  StubRunner,
  stubAgentsRequested,
  type StageKey,
  MUTATING_AXES,
  establishSessions,
  sessionsByRole,
  mapSurface,
  prepareData,
  loadProfile,
  newRunId,
  runAxisSpecs,
  runDir,
  writeRun,
  clarvisPaths,
  FLEETS,
  FLEET_KEYS,
  resolveFleets,
  describeResolution,
  resolveScope,
  GitConnector,
  gatherSources,
  runDossier,
  Budget,
  MessagesRunner,
  ARCHIVE_SCHEMAS,
  AGENT_SCHEMAS,
  oracleCeiling,
  addProject,
  removeProject,
  GraphConnector,
  legacyStateDir,
  pruneRuns,
  formatBytes,
  runMutationTesting,
  describeMutationScore,
  mineBugFixes,
  toCases,
  measureVariance,
  describeVariance,
  compareAblations,
  describeAblation,
  measureCalibration,
  listRunIds,
  loadLedger,
  saveLedger,
  applyLedger,
  recordRun,
  describeLedger,
  dismiss,
  reopen,
  promote,
  runDifferential,
  describeDifferential,
  findingsFromDifferential,
  deriveTaxonomy,
  describeTaxonomy,
  resolveProject,
  DEFAULT_FLEETS,
  describeProjects,
  surveyProject,
  runRecon,
  profileIsRunnable,
  ClaudeCodeRunner,
  hasApiKey,
  spendLabel,
  spendNote,

  authorSpecs,
  findingsFromReport,
  triageFindings,
  describeClusters,
  planRun,
  plannedAxisOrder,
  draftTickets,
  decideAndDescribe,
  describeVerdict,
  releaseExitCode,
  type TestPlan,
  loadAnswerKey,
  scoreRun,
  describeBenchmark,
  readRun,
  type AuthoredSpec,
  type FeatureContext,
  type AgentResult,
  type Axis,
  type AxisRun,
  type Profile,
  type Run,
  type Sandbox,
  type AuthRole,
} from "@clarvis/core";
import { serveUi } from "./ui.ts";
import { describeSmoke, smoke } from "./smoke.ts";
import { checkbox, confirm } from "./prompt.ts";

const HELP = `
  clarvis - a team of AI QA agents that inspect a project, then test it in a real browser

  clarvis init [--project <dir>] [--name <name>] [--fleet <key>]... [--graph]
      Set this project up: pick which teams run on it, optionally build a
      graphify code graph, then optionally run recon. Interactive unless
      --fleet is passed.

  clarvis recon [--project <dir>] [--name <name>] [--max-usd <n>] [--dry-run]
      SCOUT: survey the project, work out how to boot it, how it logs in,
      and what must never be written to. Writes .clarvis/profile.json.

  clarvis guard [--project <dir>] [--profile <file>] [--url <url>]
      Print the safety decision for a target without running anything.

  clarvis scope [--project <dir>] [--base <ref>] [--head <ref>] [--dirty]
                [--feature <name>] [--paths <glob>]...
      Work out what a feature is, from a diff, a name, or a ticket.

  clarvis research [--project <dir>] [--base <ref>] [--feature <name>] [--dirty]
                   [--max-usd <n>] [--dry-run]
      ARCHIVE: gather sources, extract requirements, verify every quote,
      and write .clarvis/context.json.

  clarvis project add <dir> [--name <name>] [--fleet <key>]... | list | remove <dir|id>
      Manage projects and which teams each one runs. SCOUT is always in.
      Re-running add on an existing project updates its team selection.

  clarvis benchmark [--project <dir>] [--key <bugs.json>] [--run <id>]
      Score a run against a known set of seeded bugs.

  clarvis mutate [--project <dir>] [--axis <key>] [--paths <glob>]... [--max-mutants <n>]
      Break the code in small ways and see whether the specs notice. Measures
      the tests directly - no seeded bugs, no answer key. Needs a clean git
      tree: it edits source files and restores them.

  clarvis history [--project <dir>] [--limit <n>] [--min-confidence <0-1>]
      Mine real bug-fix commits out of this project's own history. Each one is
      a benchmark case nobody designed the axes around.

  clarvis measure variance|ablation|calibration [--project <dir>] [--runs <n>]
      What a single run's number is worth. variance repeats the same input;
      ablation compares arms with a fleet removed; calibration scores triage
      against labels in .clarvis/labels.json.

  clarvis diff [--project <dir>] [--base <ref>] [--axis <key>]
      Run the same specs against this branch and against the base. A test that
      passed there and fails here is a regression - no requirement needed.

  clarvis ledger [list] | dismiss <fingerprint> --note "why" | reopen <fingerprint>
      What is already known. A dismissed finding is still found and no longer
      reported.

  clarvis taxonomy [--project <dir>] [--limit <n>]
      Derive what actually goes wrong in this project, from its own history of
      fixes. The seven standard axes become defaults rather than the ontology.

  clarvis fleets
      List the teams, what each produces, and which are optional.

  clarvis run [--project <dir>] [--fleet <name>]... [--axis <key>]...
              [--feature <name>] [--brief <text>] [--force] [--no-author]
      PROVER: author a spec per axis, gate it, boot, apply the guard, run,
      re-run each failure in isolation to grade it, and write a run.
      --no-author reuses the specs already in .clarvis/scratch; --no-triage
      leaves every finding at PLAUSIBLE. --fleet takes a key or a codename;
      SCOUT always runs. Old runs are pruned to --keep-runs (default 10).

  clarvis ui [--project <dir>] [--port <n>] [--open]
      Serve the dashboard and the run API. --open launches a browser.

  --max-usd is a usage ceiling measured at API-equivalent rates. With no
  ANTHROPIC_API_KEY set, runs go through your Claude Code login and consume
  your plan's usage rather than being billed to a card.

  Axes:   ${AXES.join(", ")}
  Fleets: ${FLEET_KEYS.map((k) => `${FLEETS[k].codename.toLowerCase()}/${k}`).join(", ")}
`;

function fmtGuard(reason: string): string {
  return reason.replace(/\s+/g, " ").trim();
}

/**
 * `parseArgs` in non-strict mode types every value as `string | boolean`,
 * because a bare `--flag` yields `true`. Everything here expects a string, so a
 * valueless flag is treated as absent rather than as the string "true".
 */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The first value of a repeatable flag.
 *
 * `--axis` is declared `multiple: true`, so parseArgs always yields an array -
 * and `str()` returns undefined for an array. Two commands read it with `str()`
 * and silently fell back to happy-path whatever was passed, which meant `diff
 * --axis responsive-a11y` compared an axis that had no specs and reported
 * "nothing can be compared".
 *
 * A flag that is ignored without complaint is worse than one that errors.
 */
export function firstOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  return value.find((v): v is string => typeof v === "string" && Boolean(v.trim()));
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string");
  return items.length ? items : undefined;
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    console.log(HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      project: { type: "string" },
      profile: { type: "string" },
      url: { type: "string" },
      axis: { type: "string", multiple: true },
      feature: { type: "string" },
      brief: { type: "string" },
      port: { type: "string" },
      fleet: { type: "string", multiple: true },
      base: { type: "string" },
      head: { type: "string" },
      dirty: { type: "boolean" },
      paths: { type: "string", multiple: true },
      "max-usd": { type: "string" },
      "dry-run": { type: "boolean" },
      open: { type: "boolean" },
      name: { type: "string" },
      force: { type: "boolean" },
      graph: { type: "boolean" },
      "no-graph": { type: "boolean" },
      key: { type: "string" },
      run: { type: "string" },
      author: { type: "boolean" },
      "no-author": { type: "boolean" },
      "no-triage": { type: "boolean" },
      "allow-destructive": { type: "boolean" },
      "no-sandbox": { type: "boolean" },
      live: { type: "boolean" },
      verbose: { type: "boolean" },
      "keep-runs": { type: "string" },
      "max-mutants": { type: "string" },
      "no-restart": { type: "boolean" },
      promote: { type: "boolean" },
      replace: { type: "boolean" },
      note: { type: "string" },
      by: { type: "string" },
      "min-confidence": { type: "string" },
      limit: { type: "string" },
      since: { type: "string" },
      runs: { type: "string" },
      labels: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const projectRoot = path.resolve(str(values.project) ?? process.cwd());

  switch (command) {
    case "init": {
      const preset = strList(values.fleet);
      const existing = await resolveProject(projectRoot).catch(() => undefined);

      console.log("");
      console.log(`  project    ${str(values.name) ?? existing?.name ?? path.basename(projectRoot)}`);
      console.log(`  directory  ${projectRoot}`);

      let chosen: string[];

      if (preset?.length) {
        // An explicit list skips the prompt entirely, so this is scriptable.
        chosen = preset;
      } else {
        const result = await checkbox({
          title: "Which teams run on this project?",
          hint: "Every run says what it lost by leaving one out.",
          selected: existing?.fleets ?? DEFAULT_FLEETS,
          choices: FLEET_KEYS.map((key) => ({
            value: key,
            label: `${FLEETS[key].codename.padEnd(11)} ${FLEETS[key].title}`,
            hint: FLEETS[key].purpose,
            locked: FLEETS[key].mandatory,
            requires: FLEETS[key].requires,
            caution: FLEETS[key].writesExternally ? "can write outside the project" : undefined,
          })),
        });

        chosen = result.values;
        if (result.usedDefaults) {
          console.log(`\n  note       not a terminal, so the defaults were taken.`);
        }
      }

      // A code graph is not a team, so it is a separate question. It feeds
      // SCOUT's risk hotspots and FOREMAN's blast radius, and it is off
      // unless asked for: graphify is a second tool that may not be installed.
      const graph = new GraphConnector({ projectRoot });
      const graphAvailable = await graph.isAvailable();

      let useGraph = values.graph === true;
      if (!preset?.length && graphAvailable && values.graph === undefined) {
        console.log("");
        console.log(`  A code graph tells FOREMAN what a change actually reaches, and gives`);
        console.log(`  SCOUT its risk hotspots. Local AST parsing - no model, no usage.`);
        useGraph = await confirm("Build a code graph for this project?", true);
      } else if (useGraph && !graphAvailable) {
        console.log(`\n  note       graphify is not installed, so no code graph will be built.`);
        useGraph = false;
      }

      const { project, created } = await addProject(
        projectRoot,
        str(values.name),
        chosen,
        useGraph,
      );

      if (useGraph) {
        console.log(`\n  graph      building (local, no model call)...`);
        const built = await graph.build();
        console.log(
          built.status === "ok"
            ? `  graph      ready`
            : `  graph      ${built.status}: ${built.note ?? "unavailable"}`,
        );
      }
      const picked = project.fleets ?? [];

      console.log("");
      console.log(`  ${created ? "added" : "updated"}      ${project.name}`);
      console.log(`  teams      ${picked.map((k) => FLEETS[k].codename).join(", ")}`);
      console.log(`  graph      ${project.useGraph ? "on" : "off"}`);

      // What was left out, and what it costs. Stated at setup rather than only
      // at run time, because this is the moment the choice is being made.
      const off = FLEET_KEYS.filter((k) => !picked.includes(k));
      for (const key of off) {
        console.log(`  without    ${FLEETS[key].codename}: ${FLEETS[key].purpose}`);
      }

      const resolution = resolveFleets({ requested: picked, force: true });
      for (const d of resolution.degradations) {
        console.log(`  DEGRADED   ${FLEETS[d.fleet].codename} without ${FLEETS[d.missing].codename}: ${d.effect}`);
      }

      // Nothing is written inside the project, so there is nothing to ignore.
      // An older run may have left one behind, and that is worth saying once.
      const legacy = await legacyStateDir(projectRoot);
      if (legacy) {
        console.log("");
        console.log(`  note       an old in-project state directory is at ${legacy}`);
        console.log(`             state now lives in ${clarvisPaths(projectRoot).root}`);
        console.log(`             the old one is unused and safe to delete`);
      }

      const hasProfile = await loadProfile(projectRoot)
        .then(() => true)
        .catch(() => false);

      if (!hasProfile) {
        console.log("");
        console.log(`  SCOUT has not walked this project yet. Nothing can run without a profile.`);

        // `--fleet` means this was scripted, and the help says so. A prompt
        // here blocks forever with no terminal attached, which is how
        // registering four projects in a loop hung on the fourth.
        if (preset?.length) {
          console.log(`\n  next       clarvis recon --project ${projectRoot}\n`);
          return;
        }

        const now = await confirm("Run recon now?", true);
        if (now) {
          console.log("");
          await main(["recon", "--project", projectRoot]);
          return;
        }
        console.log(`\n  next       clarvis recon --project ${projectRoot}\n`);
        return;
      }

      console.log(`\n  next       clarvis run --project ${projectRoot}\n`);
      return;
    }

    case "recon": {
      const survey = await surveyProject({ projectRoot });

      console.log("");
      console.log(
        `  project    ${str(values.name) ?? path.basename(projectRoot)}`,
      );
      console.log(
        `  surveyed   ${survey.files.length} file(s)${survey.packageManager ? ` · ${survey.packageManager}` : ""}`,
      );
      console.log(`  hosts      ${survey.hosts.length} found by static scan`);
      for (const h of survey.hosts.slice(0, 8))
        console.log(`             ${h.host.padEnd(30)} ${h.ref}`);
      if (survey.hosts.length > 8)
        console.log(`             ... and ${survey.hosts.length - 8} more`);

      if (values["dry-run"] === true) {
        console.log("");
        for (const f of survey.files.slice(0, 20)) {
          console.log(
            `  file       ${f.kind.padEnd(9)} ${f.path}${f.truncated ? "  (truncated)" : ""}`,
          );
        }
        console.log(
          `\n  dry run - no model was called, nothing was written.\n`,
        );
        return;
      }

      const git = new GitConnector(projectRoot);
      const paths = clarvisPaths(projectRoot);
      const existing = await loadProfile(projectRoot).catch(() => undefined);

      // Recon reads real files, so it needs the tool-capable runner. The read
      // roots are the project itself - nothing outside it is reachable.
      const runner = agentRunner(projectRoot);

      const registered = await resolveProject(projectRoot).catch(() => undefined);
      const graph = registered?.useGraph ? new GraphConnector({ projectRoot }) : undefined;

      // Measured against a running instance when there is one. A profile that
      // records how the app renders is what stops the spec author writing
      // assertions the framework cannot satisfy.
      const probeUrl = str(values.url) ?? existing?.boot?.url;
      const rendering = probeUrl ? await measureRendering(probeUrl).catch(() => undefined) : undefined;
      if (rendering) console.log(`  rendering  ${rendering.rendering} - ${rendering.note}`);

      const { profile, report } = await runRecon({
        projectRoot,
        projectName: str(values.name),
        rendering,
        graph,
        runner,
        budget: new Budget({ maxUsd: Number(str(values["max-usd"]) ?? 2) }),
        existing,
        commit: await git.currentRev().catch(() => undefined),
        survey,
        transcriptDir: path.join(paths.root, "transcripts"),
      });

      console.log("");
      console.log(`  boot       ${profile.boot.cmd ?? "(none)"}`);
      console.log(`  url        ${profile.boot.url || "(unknown)"}`);
      console.log(
        `  auth       ${profile.auth.mode}${profile.auth.loginUrl ? ` at ${profile.auth.loginUrl}` : ""}`,
      );
      console.log(
        `  roles      ${profile.auth.roles.map((r) => r.key).join(", ") || "none discovered"}`,
      );
      console.log(
        `  denied     ${(profile.data.forbiddenHosts ?? []).length} host pattern(s)`,
      );
      console.log(
        `  disposable ${profile.data.disposable} (only a human can set this true)`,
      );
      console.log(`  usage      ${spendLabel(report.usdEstimate, undefined, tokensOfAgents(report.agentRuns))}`);

      for (const r of report.rejectedCredentials)
        console.log(`  DROPPED    ${r.role}: ${r.reason}`);
      for (const w of report.warnings) console.log(`  WARNING    ${w}`);
      for (const b of report.blockers) console.log(`  BLOCKER    ${b}`);
      for (const t of report.truncation) console.log(`  dropped    ${t}`);

      await mkdir(paths.root, { recursive: true });
      await writeFile(paths.profile, JSON.stringify(profile, null, 2), "utf8");
      console.log(`\n  written    ${paths.profile}`);

      const runnable = profileIsRunnable(profile);
      if (!runnable.ok) {
        console.log(`\n  NOT READY - fix these in the profile before running:`);
        for (const r of runnable.reasons) console.log(`    · ${r}`);
        console.log("");
        process.exitCode = 1;
        return;
      }

      console.log(
        `\n  ready      read-only axes can run now. For mutating axes, set data.disposable=true\n` +
          `             and add a safeTargets pattern by hand.\n`,
      );
      return;
    }

    case "guard": {
      const profile = await loadProfile(projectRoot, str(values.profile));
      const decision = decideGuard(profile, str(values.url));
      console.log(`\n  target   ${decision.target}`);
      console.log(`  mode     ${decision.mode.toUpperCase()}`);
      console.log(`  reason   ${fmtGuard(decision.reason)}`);
      if (decision.skippedAxes.length) {
        console.log(`  refused  ${decision.skippedAxes.join(", ")}`);
      }
      console.log("");
      // Non-zero on abort so CI can gate on it.
      if (decision.mode === "aborted") process.exitCode = 2;
      return;
    }

    case "scope": {
      const profile = await loadProfile(projectRoot).catch(() => undefined);
      const scope = await resolveScope(
        {
          base: str(values.base),
          head: str(values.head),
          includeUncommitted: values.dirty === true,
          name: str(values.feature),
          paths: strList(values.paths),
        },
        { git: new GitConnector(projectRoot), profile },
      );

      console.log("");
      console.log(`  feature    ${scope.title}`);
      console.log(`  key        ${scope.key}`);
      console.log(
        `  origin     ${scope.origin}  (confidence: ${scope.confidence})`,
      );
      console.log(`  keywords   ${scope.keywords.join(", ") || "-"}`);
      if (scope.trackerKeys.length)
        console.log(`  tickets    ${scope.trackerKeys.join(", ")}`);
      if (scope.routes.length)
        console.log(`  routes     ${scope.routes.join(", ")}`);
      console.log(`  files      ${scope.paths.length}`);
      for (const f of scope.paths.slice(0, 12))
        console.log(`             ${f}`);
      if (scope.paths.length > 12)
        console.log(`             ... and ${scope.paths.length - 12} more`);
      console.log("");
      for (const e of scope.evidence) console.log(`  why        ${e}`);
      for (const t of scope.truncation) console.log(`  dropped    ${t}`);
      console.log("");
      return;
    }

    case "research": {
      const profile = await loadProfile(projectRoot).catch(() => undefined);
      const git = new GitConnector(projectRoot);

      const scope = await resolveScope(
        {
          base: str(values.base),
          head: str(values.head),
          includeUncommitted: values.dirty === true,
          name: str(values.feature),
          paths: strList(values.paths),
        },
        { git, profile },
      );

      console.log("");
      console.log(`  feature    ${scope.title}`);
      console.log(
        `  scope      ${scope.origin} · ${scope.paths.length} file(s) · confidence ${scope.confidence}`,
      );
      console.log(`  keywords   ${scope.keywords.join(", ") || "-"}`);

      if (values["dry-run"] === true) {
        // Shows exactly what would be sent to a model, and costs nothing.
        const gathered = await gatherSources({ projectRoot, scope, git });
        console.log("");
        for (const c of gathered.connectors) {
          console.log(
            `  connector  ${c.name.padEnd(11)} ${c.status.padEnd(15)} ${c.note ?? ""}`,
          );
        }
        console.log(`\n  sources    ${gathered.sources.length}`);
        for (const s2 of gathered.sources.slice(0, 10)) {
          console.log(
            `             ${s2.ref}  ${(s2.title ?? "").slice(0, 58)}`,
          );
        }
        if (gathered.sources.length > 10) {
          console.log(
            `             ... and ${gathered.sources.length - 10} more`,
          );
        }
        console.log(
          `\n  dry run - no model was called, nothing was written.\n`,
        );
        return;
      }

      const budget = new Budget({
        maxUsd: Number(str(values["max-usd"]) ?? 2),
      });
      // The plain messages call is cheaper and needs no agent loop, but it needs
      // an API key. Without one, fall back to the local claude binary rather
      // than failing several steps into the run with an auth error.
      const runner = hasApiKey()
        ? new MessagesRunner({ schemas: ARCHIVE_SCHEMAS })
        : new ClaudeCodeRunner({ addDirs: [projectRoot], schemas: AGENT_SCHEMAS });
      if (!hasApiKey()) {
        console.log(`  runner     claude code (no ANTHROPIC_API_KEY set)`);
      }

      const paths = clarvisPaths(projectRoot);

      const { context, report } = await runDossier({
        projectRoot,
        scope,
        runner,
        budget,
        git,
        transcriptDir: path.join(paths.root, "transcripts"),
      });

      console.log("");
      for (const c of report.connectors) {
        console.log(
          `  connector  ${c.name.padEnd(11)} ${c.status.padEnd(15)} ${c.note ?? ""}`,
        );
      }
      console.log("");
      console.log(`  sources    ${report.sourcesGathered}`);
      console.log(`  proposed   ${report.proposed}`);
      console.log(
        `  rejected   ${report.rejectedQuotes.length} (unquotable or unsourced)`,
      );
      for (const r of report.rejectedQuotes.slice(0, 5)) {
        console.log(`             [${r.code}] ${r.detail.slice(0, 84)}`);
      }
      console.log(
        // Split, because they are different facts. One says the requirement
        // overreached; the other says the run could not afford to look, which
        // is the only one a bigger budget fixes.
        `  demoted    ${report.demotedEntailment.filter((d) => d.kind !== "unchecked").length} (quote did not entail the claim)` +
          (report.demotedEntailment.some((d) => d.kind === "unchecked")
            ? `, ${report.demotedEntailment.filter((d) => d.kind === "unchecked").length} never checked (raise --max-usd)`
            : ""),
      );
      for (const d of report.demotedEntailment.slice(0, 5)) {
        console.log(
          `             ${d.statement.slice(0, 60)} - ${d.reason.slice(0, 40)}`,
        );
      }
      console.log(`  accepted   ${report.accepted}`);
      console.log(`  unknowns   ${context.unknowns.length}`);
      console.log(`  usage      ${spendLabel(report.usdEstimate, undefined, tokensOfAgents(report.agentRuns))}`);
      console.log(`             ${spendNote()}`);

      const ceiling = oracleCeiling(context);
      console.log(
        `\n  oracle     ${ceiling.ceiling.toUpperCase()} - ${ceiling.reason}`,
      );
      for (const w of report.warnings) console.log(`  WARNING    ${w}`);

      await mkdir(paths.root, { recursive: true });
      const file = path.join(paths.root, "context.json");
      await writeFile(file, JSON.stringify(context, null, 2), "utf8");
      console.log(`\n  written    ${file}\n`);
      return;
    }

    case "project": {
      const sub = String(positionals[0] ?? "list");
      const target = String(positionals[1] ?? "");

      if (sub === "list") {
        const projects = await describeProjects();
        console.log("");
        if (!projects.length)
          console.log(
            "  no projects yet - add one with: clarvis project add <dir>",
          );
        for (const p of projects) {
          console.log(
            `  ${p.name.padEnd(24)} ${String(p.runCount ?? 0).padStart(3)} run(s)  ${p.missing ? "MISSING  " : ""}${p.path}`,
          );
          console.log(
            `  ${" ".repeat(24)} ${(p.fleets ?? []).map((k) => FLEETS[k].codename).join(", ")}`,
          );
        }
        console.log("");
        return;
      }

      if (sub === "add") {
        if (!target)
          throw new Error("Usage: clarvis project add <dir> [--name <name>]");
        const { project, created } = await addProject(target, str(values.name));
        console.log(
          `\n  ${created ? "added" : "already present"}   ${project.name}  ${project.path}\n`,
        );
        return;
      }

      if (sub === "remove") {
        if (!target) throw new Error("Usage: clarvis project remove <dir|id>");
        const removed = await removeProject(target);
        console.log(`\n  ${removed ? "removed" : "not found"}   ${target}\n`);
        return;
      }

      throw new Error(`Unknown subcommand "${sub}". Use add, list or remove.`);
    }

    case "smoke": {
      /*
        The check to run before saying anything is finished.

        Stubbed by default - seconds, no tokens - because the bugs it exists
        for were all plumbing. `--live` calls the real agents, for a change
        that alters what one is asked to do.
      */
      const result = await smoke({
        live: values.live === true,
        port: values.port ? Number(str(values.port)) : undefined,
        log: values.verbose === true ? (l) => console.log(`  ${l}`) : undefined,
      });

      console.log("");
      for (const line of describeSmoke(result)) console.log(`  ${line}`);
      console.log("");

      // Non-zero so this can gate a commit.
      if (!result.ok) process.exitCode = 1;
      return;
    }

    case "benchmark": {
      const keyFile = str(values.key) ?? path.join(projectRoot, "bugs.json");
      const key = await loadAnswerKey(keyFile);
      const run = await readRun(projectRoot, str(values.run) ?? "latest");
      const result = scoreRun(run, key);

      console.log(`\n  run        ${run.runId}`);
      for (const line of describeBenchmark(result)) console.log(`  ${line}`);
      console.log("");

      // Non-zero when a seeded bug on an axis that ran was not found, so this
      // can gate a change to the fleet itself.
      if (result.missed.length) process.exitCode = 1;
      return;
    }

    case "mutate": {
      const profile = await loadProfile(projectRoot);
      const paths = clarvisPaths(projectRoot);
      const git = new GitConnector(projectRoot);

      // Default to what the current scope touches. Mutating the whole codebase
      // would take days and measure areas no spec was ever written for.
      const scope = await resolveScope(
        {
          name: str(values.feature),
          paths: strList(values.paths),
          includeUncommitted: false,
        },
        { git, profile },
      );

      const files = strList(values.paths) ?? scope.paths;
      if (!files.length) {
        throw new Error(
          "Nothing to mutate. Pass --paths, or --feature so the scope resolver can find changed files.",
        );
      }

      const axis = firstOf(values.axis) ?? "happy-path";
      const dir = await runDir(projectRoot, newRunId());

      console.log("");
      console.log(`  target     ${files.length} file(s), axis ${axis}`);
      console.log(`  WARNING    this edits source files in place and restores them.`);
      console.log(`             it refuses on a dirty tree, and verifies every restore.`);
      console.log("");

      const score = await runMutationTesting({
        projectRoot,
        files,
        specDir: paths.scratch,
        profile,
        axisKey: axis,
        outputDir: dir,
        maxMutants: Number(str(values["max-mutants"]) ?? 30),
        // Servers load their source once, so the app is restarted per mutant
        // unless the caller says it manages that itself.
        restartApp: values["no-restart"] !== true,
        git,
        log: (l) => console.log(`  ${l}`),
      });

      await writeFile(path.join(dir, "mutation.json"), JSON.stringify(score, null, 2), "utf8");

      console.log("");
      for (const line of describeMutationScore(score)) console.log(`  ${line}`);
      console.log(`\n  written    ${path.join(dir, "mutation.json")}\n`);

      // A suite that kills nothing is not a suite.
      if (score.killRate !== undefined && score.killRate < 0.5) process.exitCode = 1;
      return;
    }

    case "history": {
      const result = await mineBugFixes({
        git: new GitConnector(projectRoot),
        limit: Number(str(values.limit) ?? 400),
        paths: strList(values.paths),
        since: str(values.since),
        minConfidence: Number(str(values["min-confidence"]) ?? 0.4),
      });

      console.log("");
      console.log(`  scanned    ${result.scanned} commit(s)`);
      console.log(`  candidates ${result.candidates.length}`);
      console.log("");

      for (const c of result.candidates.slice(0, 25)) {
        console.log(`  ${c.shortSha}  ${c.confidence.toFixed(2)}  ${c.subject.slice(0, 68)}`);
        console.log(`            ${c.signals.join(" · ")}`);
        console.log(`            test at ${c.parentSha}, files: ${c.files.slice(0, 3).join(", ")}`);
      }

      const paths2 = clarvisPaths(projectRoot);
      await mkdir(paths2.root, { recursive: true });
      const file = path.join(paths2.root, "history-cases.json");
      await writeFile(file, JSON.stringify(toCases(result), null, 2), "utf8");

      console.log("");
      for (const n of result.notes) console.log(`  note       ${n}`);
      console.log(`\n  written    ${file}\n`);
      return;
    }

    case "measure": {
      const mode = String(positionals[0] ?? "variance");
      const ids = await listRunIds(projectRoot);
      const take = Number(str(values.runs) ?? 5);

      if (!ids.length) throw new Error("No runs to measure. Run `clarvis run` first.");

      const runs = await Promise.all(
        ids.slice(-take).map((id) => readRun(projectRoot, id)),
      );

      console.log("");

      if (mode === "variance") {
        for (const line of describeVariance(measureVariance(runs))) console.log(`  ${line}`);
      } else if (mode === "ablation") {
        // Arms are grouped by which fleets each run actually used, so this
        // reads whatever arms happen to be on disk rather than requiring a
        // particular experiment to have been set up.
        const arms = new Map<string, Run[]>();
        for (const run of runs) {
          const used = (run.truncation ?? [])
            .filter((t) => /ran without/.test(t))
            .map((t) => t.split(" ")[3])
            .sort()
            .join(",");
          const key = used || "full";
          arms.set(key, [...(arms.get(key) ?? []), run]);
        }

        const result = compareAblations(
          [...arms.entries()].map(([key, group]) => ({
            label: key === "full" ? "full" : `without ${key}`,
            removed: key === "full" ? undefined : (key.split(",")[0] as never),
            runs: group,
          })),
        );
        for (const line of describeAblation(result)) console.log(`  ${line}`);
      } else if (mode === "calibration") {
        const labelFile = str(values.labels) ?? path.join(clarvisPaths(projectRoot).root, "labels.json");
        const labels = JSON.parse(await readFile(labelFile, "utf8")) as Array<{
          findingId: string;
          truth: "application" | "spec" | "environment" | "unclear";
        }>;

        const report = measureCalibration(runs, labels);
        console.log(`  agreement  ${report.agreed}/${report.labelled} (${Math.round(report.agreement * 100)}%)`);
        for (const d of report.falseDismissals) {
          console.log(`  DROPPED    a real bug was called a test fault: ${d.title.slice(0, 66)}`);
        }
        for (const f of report.falseReports) {
          console.log(`  MISFILED   a test fault was reported as a bug: ${f.title.slice(0, 66)}`);
        }
        for (const n of report.notes) console.log(`  note       ${n}`);
      } else {
        throw new Error(`Unknown mode "${mode}". Use variance, ablation or calibration.`);
      }

      console.log("");
      return;
    }

    case "ledger": {
      const sub = String(positionals[0] ?? "list");
      const ledger = await loadLedger(projectRoot);

      if (sub === "list") {
        console.log("");
        for (const line of describeLedger(ledger)) console.log(`  ${line}`);
        console.log("");
        return;
      }

      const target = String(positionals[1] ?? "");
      if (!target) throw new Error(`Usage: clarvis ledger ${sub} <fingerprint>`);

      if (sub === "dismiss") {
        const note = str(values.note);
        if (!note) {
          throw new Error(
            "A dismissal needs --note. Without a stated reason nobody can tell it from a mistake later.",
          );
        }

        const result = dismiss(ledger, target, { note, by: str(values.by) ?? "you" });
        if (result.error) throw new Error(result.error);

        await saveLedger(projectRoot, result.ledger);
        console.log(`\n  dismissed  ${result.entry!.fingerprint}  ${result.entry!.title.slice(0, 60)}`);
        console.log(`  reason     ${note}`);
        console.log(`\n  It will still be found. It will not be reported again.\n`);
        return;
      }

      if (sub === "reopen") {
        const result = reopen(ledger, target);
        if (result.error) throw new Error(result.error);
        await saveLedger(projectRoot, result.ledger);
        console.log(`\n  reopened   ${target}\n`);
        return;
      }

      throw new Error(`Unknown subcommand "${sub}". Use list, dismiss or reopen.`);
    }

    case "diff": {
      const profile = await loadProfile(projectRoot);
      const paths = clarvisPaths(projectRoot);
      const git = new GitConnector(projectRoot);

      const base = str(values.base) ?? (await git.defaultBaseRef()).ref;
      if (!base) {
        throw new Error("No base ref. Pass --base <ref> - there is nothing to compare against without one.");
      }

      const axis = (firstOf(values.axis) ?? "happy-path") as Axis;
      const runId = newRunId();
      const dir = await runDir(projectRoot, runId);

      // Without specs there is nothing to compare, and the failure otherwise
      // surfaces as "no tests ran" three minutes later, after a worktree has
      // been created and the base has been booted for nothing.
      const specs = await readdir(paths.scratch)
        .then((f) => f.filter((n) => n.startsWith(`${axis}-`) && n.endsWith(".spec.ts")))
        .catch(() => [] as string[]);

      if (!specs.length) {
        const available = await readdir(paths.scratch)
          .then((f) => [...new Set(f.filter((n) => n.endsWith(".spec.ts")).map((n) => n.replace(/-\d+\.spec\.ts$/, "")))])
          .catch(() => [] as string[]);

        throw new Error(
          `No specs for the "${axis}" axis in ${paths.scratch}.\n` +
            (available.length
              ? `  Available: ${available.join(", ")}. Pass --axis <one of those>, or run \`clarvis run\` to author more.`
              : `  Run \`clarvis run\` first: differential testing compares existing specs, it does not write them.`),
        );
      }

      console.log("");
      console.log(`  comparing  this branch against ${base}`);
      console.log(`  axis       ${axis} (${specs.length} spec file(s))`);

      const report = await runDifferential({
        projectRoot,
        baseRef: base,
        profile,
        specDir: paths.scratch,
        axisKey: axis,
        outputDir: dir,
        log: (l) => console.log(`  ${l}`),
      });

      await writeFile(path.join(dir, "differential.json"), JSON.stringify(report, null, 2), "utf8");

      console.log("");
      for (const line of describeDifferential(report)) console.log(`  ${line}`);

      const findings = findingsFromDifferential(report, {
        axis,
        runId,
        specFile: path.join(paths.scratch, `${axis}-1.spec.ts`),
      });

      if (findings.length) {
        const run: Run = {
          schemaVersion: 1,
          runId,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: "findings",
          request: { axes: [axis] },
          guard: { mode: "read-only", target: profile.boot.url },
          axes: [{ key: axis, status: "done" }],
          findings,
          truncation: report.notes,
        };
        // Recorded like any other run, so a regression can be dismissed once
        // rather than reported every time the branch is tested.
        const before = await loadLedger(projectRoot);
        const applied = applyLedger(run.findings, before);
        run.findings = applied.reported;
        run.truncation!.push(...applied.notes);
        await saveLedger(projectRoot, recordRun(before, run));

        for (const sup of applied.suppressed) {
          console.log(`  known      ${sup.entry.fingerprint}  ${sup.finding.title.slice(0, 58)}`);
        }
        console.log(`\n  written    ${await writeRun(projectRoot, run)}`);
      }

      console.log("");
      if (report.regressions.length) process.exitCode = 1;
      return;
    }

    case "taxonomy": {
      const paths = clarvisPaths(projectRoot);
      const mined = await mineBugFixes({
        git: new GitConnector(projectRoot),
        limit: Number(str(values.limit) ?? 400),
      });

      console.log("");
      console.log(`  history    ${mined.scanned} commit(s), ${mined.candidates.length} past fix(es)`);

      const existing = await readFile(path.join(paths.root, "taxonomy.json"), "utf8")
        .then((raw) => JSON.parse(raw) as never)
        .catch(() => undefined);

      const { taxonomy, usdEstimate } = await deriveTaxonomy({
        fixes: mined.candidates,
        runner: agentRunner(projectRoot),
        budget: new Budget({ maxUsd: Number(str(values["max-usd"]) ?? 2) }),
        existing,
        transcriptDir: path.join(paths.root, "transcripts"),
      });

      console.log("");
      for (const line of describeTaxonomy(taxonomy)) console.log(`  ${line}`);

      await mkdir(paths.root, { recursive: true });
      const file = path.join(paths.root, "taxonomy.json");
      await writeFile(file, JSON.stringify(taxonomy, null, 2), "utf8");

      console.log(`\n  usage      ${spendLabel(usdEstimate)}`);
      console.log(`  written    ${file}\n`);
      return;
    }

    case "fleets": {
      console.log("");
      for (const key of FLEET_KEYS) {
        const f = FLEETS[key];
        const tag = f.mandatory ? "MANDATORY" : "optional";
        console.log(`  ${f.codename.padEnd(12)} ${key.padEnd(9)} ${tag}`);
        console.log(`  ${" ".repeat(12)} ${f.purpose}`);
        console.log(
          `  ${" ".repeat(12)} produces ${f.produces}` +
            (f.requires.length ? ` · needs ${f.requires.join(", ")}` : "") +
            (f.writesExternally
              ? " · can write outside the project (guarded)"
              : ""),
        );
        console.log("");
      }
      return;
    }

    case "ui": {
      await serveUi(projectRoot, Number(str(values.port) ?? 4477), {
        open: values.open === true,
      });
      return;
    }

    case "run": {
      await runCommand({
        projectRoot,
        profilePath: str(values.profile),
        url: str(values.url),
        axes: strList(values.axis) ?? [...AXES],
        feature: str(values.feature),
        brief: str(values.brief),
        fleets: strList(values.fleet),
        force: values.force === true,
        author: values["no-author"] !== true,
        triage: values["no-triage"] !== true,
        keepRuns: Number(str(values["keep-runs"]) ?? 10),
        promote: values.promote === true,
        replacePromoted: values.replace === true,
        baseRef: str(values.base),
        allowDestructive: values["allow-destructive"] === true,
        sandbox: values["no-sandbox"] !== true,
        maxUsd: Number(str(values["max-usd"]) ?? 6),
      });
      return;
    }

    default:
      throw new Error(`Unknown command "${command}". Try \`clarvis help\`.`);
  }
}

async function specsFor(scratchDir: string, axis: string): Promise<string[]> {
  try {
    const entries = await readdir(scratchDir);
    return entries.filter(
      (f) => f.startsWith(`${axis}-`) && f.endsWith(".spec.ts"),
    );
  } catch {
    return [];
  }
}

/**
 * Re-run each finding in isolation and let triage grade it.
 *
 * A triage failure degrades grading; it never destroys the run. The findings
 * are already real - they simply stay PLAUSIBLE, and the run says so.
 */
/**
 * Copy what each agent cost onto the run.
 *
 * Without this the console printed the real figures while `run.agentRuns` stayed
 * empty, so the saved record - and the dashboard's COST stat, which reads it -
 * said $0.00 for a run that spent several dollars.
 */
/** The same, for a command that has agent results rather than a run record. */
function tokensOfAgents(results: Array<AgentResult<unknown>> = []): { input: number; output: number } {
  return results.reduce(
    (acc, r) => ({
      input: acc.input + (r.usage?.inputTokens ?? 0),
      output: acc.output + (r.usage?.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );
}

/** Everything the run has consumed so far, summed from its own record. */
function tokensOf(run: Run): { input: number; output: number } {
  return (run.agentRuns ?? []).reduce(
    (acc, a) => ({
      input: acc.input + (a.tokens?.input ?? 0),
      output: acc.output + (a.tokens?.output ?? 0),
    }),
    { input: 0, output: 0 },
  );
}

/**
 * The runner every command uses.
 *
 * One place, so the stub cannot be reached by accident and cannot become a
 * fallback for a failed agent. A smoke run that quietly stopped calling the
 * real thing would be the exact silent-green this product exists to prevent,
 * committed by the tool built to catch it - so it is opt-in, explicit, and
 * announced.
 */
function agentRunner(projectRoot: string): ClaudeCodeRunner | StubRunner {
  if (stubAgentsRequested()) {
    console.log("  runner   STUBBED - agents are not being called");
    return new StubRunner();
  }
  return new ClaudeCodeRunner({ addDirs: [projectRoot], schemas: AGENT_SCHEMAS });
}

function recordAgentRuns(run: Run, results: Array<AgentResult<unknown>>): void {
  run.agentRuns ??= [];
  run.agentRuns.push(
    ...results.map((r) => ({
      id: r.agentId,
      role: r.role,
      fleet: AGENTS[r.role]?.fleet,
      model: r.model,
      tokens: r.usage ? { input: r.usage.inputTokens, output: r.usage.outputTokens } : undefined,
      status: (r.status === "ok" ? "ok" : "error") as "ok" | "error",
      usdEstimate: r.usdEstimate,
      transcriptPath: r.transcriptPath,
    })),
  );
}

async function gradeFindings(opts: {
  run: Run;
  profile: Profile;
  projectRoot: string;
  paths: ReturnType<typeof clarvisPaths>;
  dir: string;
  context?: FeatureContext;
  maxUsd?: number;
}): Promise<void> {
  const { run } = opts;

  try {
    const triage = await triageFindings({
      findings: run.findings,
      profile: opts.profile,
      specDir: opts.paths.scratch,
      outputDir: opts.dir,
      runner: agentRunner(opts.projectRoot),
      budget: new Budget({ maxUsd: opts.maxUsd ?? 6 }),
      context: opts.context,
      transcriptDir: path.join(opts.paths.root, "transcripts"),
      log: (l) => console.log(`  ${l}`),
    });

    for (const line of describeClusters(triage.clusters)) console.log(`  ${line}`);

    // An environmental cluster means the run itself is suspect, so it goes on
    // the record rather than being printed once and lost.
    if (triage.clusters.environmental) {
      run.truncation!.push(triage.clusters.environmental.note);
    }

    for (const o of triage.outcomes) {
      if (o.tierAfter !== o.tierBefore) {
        console.log(`  triage   ${o.finding.id}: ${o.tierBefore} -> ${o.tierAfter}`);
      }
    }
    recordAgentRuns(run, triage.agentRuns);
    console.log(`  triage   ${spendLabel(triage.usdEstimate, undefined, tokensOf(run))}`);

    // A discarded finding leaves the report but not the record: one that
    // vanished without explanation is indistinguishable from one nobody found.
    for (const f of run.findings.filter((f) => f.tier === "DISCARDED")) {
      run.truncation!.push(`Discarded by triage: ${f.title} - ${f.tierReason}`);
    }
    run.findings = run.findings.filter((f) => f.tier !== "DISCARDED");
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.log(`  triage   FAILED - ${why.slice(0, 160)}`);
    run.truncation!.push(
      `Triage did not run (${why.slice(0, 200)}), so no finding was reproduced or graded. ` +
        `Every finding below remains PLAUSIBLE.`,
    );
  }
}

/**
 * Stamp where the run has got to, and persist it.
 *
 * Written to disk on every transition rather than only at the end, because the
 * dashboard reads the same file a finished run leaves behind - so a run in
 * flight becomes visible without a second channel to keep working. Best effort:
 * a failed status write must never take down the run it was describing.
 */
async function markStage(
  projectRoot: string,
  run: Run,
  key: StageKey,
  /** Optional override. Defaults to the label STAGES declares for this key. */
  label = STAGES.find((s) => s.key === key)!.label,
): Promise<void> {
  const now = Date.now();
  const previous = run.stage;

  run.stage = {
    key,
    label,
    startedAt: new Date(now).toISOString(),
    done: [
      ...(previous?.done ?? []),
      ...(previous
        ? [
            {
              key: previous.key,
              label: previous.label,
              ms: now - new Date(previous.startedAt).getTime(),
            },
          ]
        : []),
    ],
  };

  await writeRun(projectRoot, run).catch(() => {});
}

async function runCommand(opts: {
  projectRoot: string;
  profilePath?: string;
  url?: string;
  axes: string[];
  feature?: string;
  brief?: string;
  fleets?: string[];
  force?: boolean;
  author?: boolean;
  triage?: boolean;
  maxUsd?: number;
  keepRuns?: number;
  promote?: boolean;
  replacePromoted?: boolean;
  baseRef?: string;
  /**
   * Permission to run a data command that destroys before it recreates.
   *
   * Separate from `data.disposable` on purpose: being willing to have records
   * created is not the same as being willing to have the schema dropped, and
   * one flag covering both would make the safer intent unexpressible.
   */
  allowDestructive?: boolean;
  /** Set false to refuse to provision a database, whatever the guard says. */
  sandbox?: boolean;
}): Promise<void> {
  const { projectRoot } = opts;
  const profile = await loadProfile(projectRoot, opts.profilePath);
  const paths = clarvisPaths(projectRoot);
  const runId = newRunId();
  const startedAt = new Date().toISOString();

  const requested = opts.axes.filter((a): a is Axis =>
    (AXES as readonly string[]).includes(a),
  );
  if (requested.length !== opts.axes.length) {
    const bad = opts.axes.filter(
      (a) => !(AXES as readonly string[]).includes(a),
    );
    throw new Error(
      `Unknown axis: ${bad.join(", ")}. Known axes: ${AXES.join(", ")}`,
    );
  }

  /* --- 0. Which teams are running, and what we lose by the rest ----------- */

  // Recon is added whatever was asked for, and everything skipped is announced.
  // A degraded run that looks identical to a thorough one is the exact failure
  // this product exists to avoid.
  // Precedence: what was typed, then what the project was configured with, then
  // the default. A project is set up once and every later run inherits it.
  const registered = await resolveProject(projectRoot).catch(() => undefined);
  const requestedFleets = opts.fleets?.length
    ? opts.fleets
    : (registered?.fleets?.length ? registered.fleets : DEFAULT_FLEETS);

  const fleets = resolveFleets({
    requested: requestedFleets,
    freshArtifacts: ["recon"],
    force: opts.force,
  });

  if (fleets.errors.length) throw new Error(fleets.errors.join("\n"));

  console.log("");
  for (const line of describeResolution(fleets)) console.log(`  ${line}`);

  const enabled = new Set(fleets.order);

  /* --- 0. A database to write to, made for this run ------------------------ */

  // Before the guard, so everything downstream sees one settled mode. Doing it
  // afterwards meant the plan was drawn up under read-only rules and then
  // handed mutating axes it had never considered.
  //
  // Only when a mutating axis was actually requested: standing up a database
  // for a run that will never write to it is cost with no return. And only
  // when the guard would otherwise refuse - a project a human has already
  // vouched for needs nothing from this.
  const preflight = decideGuard(profile, opts.url);
  const wantsMutating = requested.some((axis) => MUTATING_AXES.includes(axis));

  /*
    The run record is opened here, before anything slow happens.

    It used to be created after the guard and written only at the first stage
    transition, which is well past provisioning a database - the one step that
    can take minutes while it pulls an image. For all of that time the
    dashboard showed the PREVIOUS run, so the moment a person most wants to see
    something happening was the moment nothing was recorded. The guard fields
    are seeded from the preflight decision and corrected below once the real
    one is taken.
  */
  const run: Run = {
    schemaVersion: 1,
    runId,
    startedAt,
    status: "running",
    request: {
      fleets: fleets.order,
      feature: opts.feature,
      brief: opts.brief,
      axes: requested,
      profilePath: opts.profilePath ?? paths.profile,
    },
    guard: {
      mode: preflight.mode,
      target: preflight.target,
      matchedSafeTarget: preflight.matchedSafeTarget,
      reason: preflight.reason,
      skippedAxes: [],
    },
    axes: [],
    findings: [],
    truncation: [
      ...fleets.degradations.map(
        (d) => `${FLEETS[d.fleet].codename} ran without ${FLEETS[d.missing].codename}: ${d.effect}`,
      ),
    ],
  };

  let sandbox: Sandbox | undefined;
  // Recorded whether it worked or not: a reader cannot otherwise tell a stage
  // that succeeded from one that never ran.
  let sandboxRecord: NonNullable<Run["preparation"]>["sandbox"];
  /** Every record this run created, by the identifier a human could search for. */
  const createdFixtures: string[] = [];
  /** The account this run registered, if any, so it can be closed afterwards. */
  let enrolledRole: AuthRole | undefined;

  /*
    A sandbox is preferred even when the guard would already allow writes.

    This used to provision only when the guard was about to refuse, which had
    it exactly backwards: a project someone had marked `disposable: true` never
    got a sandbox, so every account and record the fleet created went into
    their real development database and stayed there. Being allowed to write
    somewhere is not a reason to write there.

    Consent to run mutating tests against seeded data is not consent to be left
    with permanent test accounts. So a database of our own is always the first
    choice, and the vouched-for one is the fallback - used only when no sandbox
    can be made, and said loudly when it is.
  */
  if (wantsMutating && opts.sandbox !== false) {
    await markStage(projectRoot, run, "sandbox");

    const provisioned = await provisionSandbox({
      profile,
      runId,
      stateDir: paths.root,
      log: (l) => console.log(`  sandbox  ${l}`),
    });

    sandbox = provisioned.sandbox;

    sandboxRecord = sandbox
      ? {
          provisioned: true,
          engine: sandbox.engine,
          provisionedBy: sandbox.provisionedBy,
          evidence: sandbox.evidence,
        }
      : {
          provisioned: false,
          attempts: provisioned.attempts,
          remedy: provisioned.remedy,
        };

    if (sandbox) {
      console.log(`  sandbox  ${sandbox.evidence}`);
      // The application must boot already pointed at it. Without this the app
      // writes to the project's own database while the seed script writes to
      // ours, and every assertion runs against data that is not there.
      profile.boot = { ...profile.boot, env: { ...profile.boot.env, ...sandbox.env } };
    } else {
      for (const a of provisioned.attempts) console.log(`  sandbox  ${a.approach}: ${a.outcome}`);
      if (provisioned.remedy) console.log(`  sandbox  ${provisioned.remedy}`);

      // No sandbox, but the guard may still permit writes because a human
      // vouched for this target. That is a materially different situation and
      // must not read the same in the report.
      if (preflight.mode === "mutating") {
        const warning =
          `No disposable database could be created, so anything this run creates goes into ` +
          `${preflight.target} - a real database somebody marked writable - and survives the run ` +
          `unless its teardown command removes it.`;
        console.log(`  sandbox  WRITING TO A REAL DATABASE`);
        console.log(`           ${warning}`);
        run.truncation!.push(warning);
      }
    }
  }

  // Idempotent, because it is called from every exit path and some of them
  // overlap. A container left holding a port outlives this run and breaks the
  // next one for a reason nobody will trace back to here.
  let released = false;
  const releaseSandbox = async (): Promise<void> => {
    if (!sandbox || released) return;
    released = true;
    await sandbox.teardown().catch((e: unknown) => {
      console.log(`  sandbox  could not be removed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  if (sandbox) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void releaseSandbox().then(() => process.exit(130));
      });
    }
  }

  /* --- 1. Guard, before anything is touched -------------------------------- */

  const decision = decideGuard(profile, opts.url, sandbox);
  const { allowed, skipped } = applyGuardToAxes(decision, requested);

  console.log(`\n  run      ${runId}`);
  console.log(`  target   ${decision.target}`);
  console.log(
    `  guard    ${decision.mode.toUpperCase()} - ${fmtGuard(decision.reason)}`,
  );

  // Corrected, not recreated: the record was opened before provisioning so a
  // run in flight is visible from the first second, and the guard it was
  // seeded with was the preflight one.
  run.guard = {
    mode: decision.mode,
    target: decision.target,
    matchedSafeTarget: decision.matchedSafeTarget,
    reason: decision.reason,
    skippedAxes: skipped.map((s) => s.axis),
  };

  if (decision.mode === "aborted") {
    run.status = "blocked";
    run.finishedAt = new Date().toISOString();
    run.truncation!.push(
      "Run aborted by the safety guard. Nothing was executed.",
    );
    await releaseSandbox();
    await writeRun(projectRoot, run);
    console.log(`\n  ABORTED - nothing ran.\n`);
    process.exitCode = 2;
    return;
  }

  await markStage(projectRoot, run, "context");

  /* --- 2. Gather the context the plan and the specs are written from ------- */

  let context: FeatureContext | undefined;
  try {
    context = JSON.parse(
      await readFile(path.join(paths.root, "context.json"), "utf8"),
    ) as FeatureContext;
  } catch {
    run.truncation!.push(
      "No context.json, so no finding can cite a requirement. Run `clarvis research` first.",
    );
  }

  /* --- FOREMAN: decide what is worth testing -------------------------------- */

  let plan: TestPlan | undefined;
  let axesToRun = allowed;

  if (enabled.has("lead") && allowed.length) {
    const scope = await resolveScope(
      { name: opts.feature, includeUncommitted: true },
      { git: new GitConnector(projectRoot), profile },
    ).catch(() => undefined);

    if (scope) {
      const planned = await planRun({
        scope,
        profile,
        context,
        graph: registered?.useGraph ? new GraphConnector({ projectRoot }) : undefined,
        runner: agentRunner(projectRoot),
        budget: new Budget({ maxUsd: opts.maxUsd ?? 6 }),
        candidateAxes: allowed,
        guardSkipped: skipped.map((sk) => sk.axis),
        transcriptDir: path.join(paths.root, "transcripts"),
      });

      plan = planned.plan;
      recordAgentRuns(run, planned.report.agentRuns);
      await writeFile(
        path.join(paths.root, "plan.json"),
        JSON.stringify(plan, null, 2),
        "utf8",
      );

      console.log(`\n  plan     ${plan.rationale.slice(0, 100)}`);
      for (const a of plan.axes) {
        console.log(`  plan     ${String(a.rank).padStart(2)}. ${a.axis.padEnd(18)} ${a.why.slice(0, 70)}`);
      }
      for (const d of plan.deferred) {
        // A deferred axis is untested. It goes on the run so a clean result can
        // never be read as full coverage.
        run.truncation!.push(`${d.axis} was not tested: ${d.why} Cost: ${d.cost}`);
      }
      for (const c of planned.report.corrections) run.truncation!.push(`Plan corrected: ${c}`);

      axesToRun = plannedAxisOrder(plan);
      if (!axesToRun.length) axesToRun = allowed;
    }
  }

  const specsByAxis = new Map<Axis, AuthoredSpec>();
  /** Gate refusals, kept so the author can be taught from them at the end. */
  const rejectedSpecs: Array<{ axis: string; violations: string[] }> = [];

  await markStage(projectRoot, run, "boot");

  /* --- 3. Boot, and refuse to test an app we cannot prove is up ------------ */

  const boot = await bootAndVerify(profile, {
    log: (l) => console.log(`  boot     ${l}`),
  });
  run.boot = {
    verified: boot.verified,
    durationMs: boot.durationMs,
    blockers: boot.blockers,
  };

  if (!boot.verified) {
    run.status = "blocked";
    run.finishedAt = new Date().toISOString();
    run.truncation!.push(
      "Boot could not be verified, so no axis was executed.",
    );
    await releaseSandbox();
    await writeRun(projectRoot, run);
    console.log(`\n  BLOCKED - could not verify the app is running:`);
    for (const b of boot.blockers) console.log(`    · ${b}`);
    console.log("");
    process.exitCode = 1;
    return;
  }

  /* --- 3b. Warm up, so no spec races a compiler ---------------------------- */

  // A dev server answers 200 while still building the route. The first real run
  // asserted against a loading shell and produced nine findings, all false.
  // Every route the specs will visit, not just the base URL: each one compiles
  // on its own first request, and warming only `/` left `/login` racing a
  // compiler exactly as before.
  // Re-measured every run: a profile can be stale, and the cost of being wrong
  // here is a report full of findings about the harness.
  const measured = await measureRendering(profile.boot.url).catch(() => undefined);
  if (measured && measured.rendering !== profile.stack?.rendering) {
    console.log(`  rendering ${measured.rendering} - ${measured.note}`);
    profile.stack = { ...profile.stack, rendering: measured.rendering, hydrationMs: measured.hydrationMs };
  }

  const routeWarm = await warmRoutes(
    profile,
    plan?.axes.flatMap((a) => a.routes) ?? [],
    { log: (l) => console.log(`  warmup   ${l}`) },
  );
  // For a client-rendered app a cold route means only that the route was
  // requested (which compiles it), not that anything is wrong. Reported as a
  // note rather than a warning, because the alternative is a warning on every
  // route of every SPA.
  const clientRendered = profile.stack?.rendering === "client-rendered";
  for (const c of routeWarm.cold) {
    if (clientRendered) continue;
    run.truncation!.push(`${c.route} never rendered during warm-up: ${c.note}`);
    console.log(`  warmup   ${c.route} did not render - assertions against it may fail spuriously`);
  }
  if (clientRendered && routeWarm.cold.length) {
    console.log(`  warmup   ${routeWarm.cold.length} route(s) requested (client-rendered, so compiled not verified)`);
  }

  // A client-rendered app can never satisfy a fetch-based check: the page only
  // exists once a browser has run its JavaScript. Blocking on that would refuse
  // to test every SPA, so the gate applies only where the server claims to send
  // a page and then does not.
  const warm =
    profile.stack?.rendering === "client-rendered"
      ? { rendered: true, ms: 0 }
      : await warmUp(profile.boot.url, { log: (l) => console.log(`  warmup   ${l}`) });

  if (!warm.rendered) {
    run.status = "blocked";
    run.finishedAt = new Date().toISOString();
    run.truncation!.push(warm.note ?? "The application never rendered.");
    await boot.stop();
    await releaseSandbox();
    await writeRun(projectRoot, run);
    console.log(`\n  BLOCKED - ${warm.note}\n`);
    process.exitCode = 1;
    return;
  }

  await markStage(projectRoot, run, "surface");

  /* --- 3c. Log in, and look at the real pages ------------------------------ */

  // Everything below needs the application up, which is why authoring moved
  // after boot. A spec author working from source alone guesses what the
  // browser built from it; one holding an accessibility snapshot transcribes it.
  // That difference is the largest single source of findings about the harness
  // rather than about the software.

  /*
    No usable credential means no authenticated route can be tested at all, and
    a provisioned database makes that worse rather than better - it is empty,
    so even the seed data a project ships is gone. Registering through the
    application's own signup form is the one way in that needs no knowledge of
    the stack, and it is still a write, so the guard decides.
  */
  if (!profile.auth.roles.some((r) => r.username && r.password)) {
    const enrolled = await enrolRole({
      profile,
      sandbox,
      log: (l) => console.log(`  enrol    ${l}`),
    });

    if (enrolled.ok && enrolled.role) {
      profile.auth = { ...profile.auth, roles: [...profile.auth.roles, enrolled.role] };
      createdFixtures.push(enrolled.role.username);
      enrolledRole = enrolled.role;
      run.truncation!.push(
        `No credential was found, so an account was created at ${enrolled.via}. It has whatever ` +
          `role signup grants - any role above that is still untested.`,
      );
      console.log(`  enrol    testing as a newly registered account, not an existing one`);
    } else {
      console.log(`  enrol    ${enrolled.reason}`);
      run.truncation!.push(`No account could be created: ${enrolled.reason}`);
    }
  }

  const sessionResults = await establishSessions({
    profile,
    sessionDir: path.join(paths.root, "sessions"),
    log: (l) => console.log(`  session  ${l}`),
  });

  for (const s of sessionResults) {
    if (s.ok) continue;
    // A role that cannot log in makes every test needing it meaningless, so it
    // goes on the run. Silently continuing anonymously produces a green run
    // that tested the login wall.
    run.truncation!.push(
      `Could not log in as "${s.role}": ${s.reason}` +
        (s.pageMessage ? ` The page said: "${s.pageMessage}"` : "") +
        ` Any test needing that role tested nothing.`,
    );
    console.log(`  session  ${s.role} FAILED - ${s.reason}`);
  }

  run.preparation = {
    ...run.preparation,
    sandbox: sandboxRecord,
    sessions: sessionResults.map((s) => ({
      role: s.role,
      ok: s.ok,
      detail: s.ok ? s.evidence : [s.reason, s.pageMessage && `The page said: "${s.pageMessage}"`].filter(Boolean).join(" "),
    })),
  };

  const sessions = sessionsByRole(sessionResults);
  const primarySession = Object.values(sessions)[0];

  const surface = await mapSurface({
    profile,
    storageState: primarySession,
    probedAs: Object.keys(sessions)[0],
    // Bounded, and reported when it bites. A full crawl of a large
    // application is minutes of browser time on every run, and the map is
    // persisted - so each run extends coverage rather than repeating it.
    maxRoutes: 20,
    log: (l) => console.log(`  surface  ${l}`),
  });

  if (surface.routes.length) {
    const withSnapshot = surface.routes.filter((r) => r.ariaSnapshot).length;
    const gated = surface.routes.filter((r) => r.requiresAuth).length;
    console.log(
      `  surface  ${surface.routes.length} route(s), ${withSnapshot} snapshotted, ${gated} behind auth`,
    );
    run.preparation = {
      ...run.preparation,
      surface: {
        routesDeclared: surface.routes.length,
        routesProbed: surface.routes.filter((r) => r.status !== undefined).length,
        routesSnapshotted: withSnapshot,
        routesBehindAuth: gated,
        discoveredBy: surface.discoveredBy,
      },
    };

    profile.surface = {
      ...profile.surface,
      routes: surface.routes,
      discoveredBy: surface.discoveredBy,
      mappedAt: new Date().toISOString(),
    };

    // The header asks "how much was reached" and had nothing to answer with,
    // so it showed "--" on a run that had just visited twenty routes.
    run.coverage = {
      ...run.coverage,
      routesKnown: surface.routes.length,
      routesVisited: withSnapshot,
      rolesExercised: Object.keys(sessions),
    };

    // Persisted, not just held for this run. Mapping costs a browser and a
    // visit per route, and throwing the result away meant paying for it every
    // time while the dashboard - which reads the profile, not the run - showed
    // a project with no routes at all.
    await writeFile(paths.profile, JSON.stringify(profile, null, 2), "utf8").catch(() => {});
  }
  for (const w of surface.warnings) {
    run.truncation!.push(w);
    console.log(`  surface  ${w.split(".")[0]}`);
  }

  /* --- 3d. Data, only where the guard and the database both allow it ------- */

  let dataState: { seeded: boolean; note?: string } | undefined;

  if (decision.mode === "mutating") {
    const prepared = await prepareData({
      profile,
      sandboxEnv: sandbox?.env,
      allowDestructive: opts.allowDestructive,
      log: (l) => console.log(`  data     ${l}`),
    });
    dataState = {
      seeded: prepared.seeded,
      note: prepared.ran.map((r) => r.command.script).join(", ") || undefined,
    };
    run.preparation = {
      ...run.preparation,
      data: {
        seeded: prepared.seeded,
        commandsRun: prepared.ran.map((r) => r.command.script),
        commandsSkipped: prepared.skipped.map((s) => ({ script: s.command.script, reason: s.reason })),
        targetCheck: prepared.targetCheck.reason,
      },
    };

    for (const w of prepared.warnings) run.truncation!.push(w);
    for (const s of prepared.skipped) console.log(`  data     skipped ${s.command.script}: ${s.reason}`);
    if (!prepared.targetCheck.ok) console.log(`  data     ${prepared.targetCheck.reason}`);
  }

  await markStage(projectRoot, run, "author");

  /* --- 3e. Author, now against an application that is actually running ----- */

  if (opts.author !== false && axesToRun.length) {
    await mkdir(paths.scratch, { recursive: true });

    // What this project's author has already been corrected on.
    const learned = await loadLessons(projectRoot);
    if (learned.lessons.length) {
      console.log(`  author   ${learned.lessons.length} lesson(s) from earlier runs are in the brief`);
    }

    const crucible = await authorSpecs({
      axes: axesToRun,
      profile,
      context,
      runner: agentRunner(projectRoot),
      budget: new Budget({ maxUsd: opts.maxUsd ?? 6 }),
      scratchDir: paths.scratch,
      transcriptDir: path.join(paths.root, "transcripts"),
      sessions,
      data: dataState,
      lessons: renderLessons(learned),
    });

    for (const spec of crucible.authored) {
      specsByAxis.set(spec.axis, spec);
      console.log(
        `  author   ${spec.axis.padEnd(18)} ${spec.gate.stats.tests} test(s), ` +
          `${spec.gate.stats.assertions} assertion(s)` +
          (spec.attempts > 1 ? `  (${spec.attempts} attempts)` : ""),
      );
      for (const w of spec.gate.warnings)
        console.log(`           ${w.code}: ${w.detail}`);
      for (const u of spec.untested) {
        run.truncation!.push(`${spec.axis}: not tested - ${u.reason}`);
      }
    }

    for (const r of crucible.rejected) {
      rejectedSpecs.push({ axis: r.axis, violations: r.violations });
      console.log(
        `  author   ${r.axis.padEnd(18)} REJECTED by the gate after ${r.attempts} attempt(s)`,
      );
      for (const v of r.violations)
        console.log(`           ${v.split("\n")[0]}`);
    }

    for (const w of crucible.warnings) run.truncation!.push(w);
    recordAgentRuns(run, crucible.agentRuns);
    console.log(`  author   ${spendLabel(crucible.usdEstimate, undefined, tokensOf(run))}`);
  }

  await markStage(projectRoot, run, "execute");

  /* --- 4. Axes, each in its own browser process ---------------------------- */

  const dir = await runDir(projectRoot, runId);

  try {
    await mkdir(paths.scratch, { recursive: true });

    for (const { axis, reason } of skipped) {
      run.axes.push({ key: axis, status: "skipped", skipReason: reason });
      console.log(`  axis     ${axis} SKIPPED (guard)`);
    }

    const started = axesToRun.map(async (axis): Promise<AxisRun> => {
      const specs = await specsFor(paths.scratch, axis);
      if (specs.length === 0) {
        // An axis with no specs did not pass - it did not run. Recorded as such
        // so an empty fleet never reads as a clean bill of health.
        return {
          key: axis,
          status: "skipped",
          skipReason: `No specs found in ${paths.scratch} matching ${axis}-*.spec.ts.`,
        };
      }

      const axisOut = path.join(dir, axis);
      const t0 = new Date().toISOString();
      const outcome = await runAxisSpecs({
        axisKey: axis,
        profile,
        specDir: paths.scratch,
        specFiles: specs,
        outputDir: axisOut,
        baseURL: profile.boot.url,
        // Every spec starts authenticated. A spec that needs a different role
        // overrides this per describe block with the storageState it was given;
        // one that needs anonymity clears it the same way. Both are cheaper and
        // far more reliable than logging in from inside the test.
        storageState: primarySession,
        log: (l) => console.log(`  ${l}`),
      });

      const r = outcome.results;
      const executed =
        (r.passed ?? 0) + (r.failed ?? 0) + (r.skipped ?? 0) + (r.flaky ?? 0);

      // Findings come from the reporter, same as the counts. An agent's account
      // of what it found is never the record.
      if ((r.failed ?? 0) > 0 || (r.flaky ?? 0) > 0) {
        try {
          const report = JSON.parse(
            await readFile(outcome.reportPath, "utf8"),
          ) as unknown;
          run.findings.push(
            ...findingsFromReport({
              axis,
              report,
              spec: specsByAxis.get(axis),
              context,
              artifactsDir: axisOut,
              runId,
            }),
          );
        } catch {
          run.truncation!.push(
            `${axis}: ${r.failed} test(s) failed but the report could not be read, so no finding was recorded.`,
          );
        }
      }

      // An axis that had specs on disk but executed nothing is an ERROR, never a
      // pass. Silent zero-test runs are the purest form of the false negative
      // this tool exists to prevent: the report looks clean because nothing
      // was ever checked.
      const broken = outcome.exitCode === 127 || executed === 0;

      return {
        key: axis,
        status: broken ? "error" : "done",
        startedAt: t0,
        finishedAt: new Date().toISOString(),
        specFiles: specs.map((s) => path.join(paths.scratch, s)),
        results: r,
        artifactsDir: axisOut,
        skipReason: broken
          ? executed === 0 && outcome.exitCode !== 127
            ? `Playwright executed 0 tests from ${specs.length} spec file(s) in ${paths.scratch}. ` +
              `Exit code ${outcome.exitCode}. ${outcome.stderr.slice(-300)}`
            : outcome.stderr.slice(-400)
          : undefined,
      };
    });

    run.axes.push(...(await Promise.all(started)));
  } catch (e) {
    await boot.stop();
    await releaseSandbox();
    throw e;
  }

  await markStage(projectRoot, run, "triage");

  /* --- 5. Triage: try to make each finding go away ------------------------- */

  // Runs before teardown: reproducing a failure needs the app up. Whatever
  // happens here, the finally below brings it down - a leaked server holds the
  // port and every later run silently tests the stale build.
  try {
    if (run.findings.length && opts.triage !== false) {
      await gradeFindings({
        run,
        profile,
        projectRoot,
        paths,
        dir,
        context,
        maxUsd: opts.maxUsd,
      });
    }
  } finally {
    await boot.stop();
    await releaseSandbox();
  }

  /* --- 6. Verdict from the reporter, not from prose ------------------------ */

  const totals = run.axes.reduce(
    (acc, a) => ({
      passed: acc.passed + (a.results?.passed ?? 0),
      failed: acc.failed + (a.results?.failed ?? 0),
      skipped: acc.skipped + (a.results?.skipped ?? 0),
    }),
    { passed: 0, failed: 0, skipped: 0 },
  );

  const ranAny = run.axes.some((a) => a.status === "done");
  const anyErrored = run.axes.some((a) => a.status === "error");
  const executed = totals.passed + totals.failed + totals.skipped;

  // "passed" requires that something actually ran and nothing broke. Anything
  // else is blocked or findings, never a clean bill of health by default.
  run.status =
    !ranAny || executed === 0
      ? "blocked"
      : totals.failed > 0
        ? "findings"
        : anyErrored
          ? "blocked"
          : "passed";
  run.finishedAt = new Date().toISOString();

  for (const a of run.axes) {
    if (a.status === "skipped")
      run.truncation!.push(`${a.key}: ${a.skipReason}`);
  }

  await markStage(projectRoot, run, "deliver");

  /* --- SCRIBE and JUDGE: what happens to what we found --------------- */

  if (enabled.has("delivery")) {
    const dispatch = await draftTickets({
      run,
      runner: agentRunner(projectRoot),
      budget: new Budget({ maxUsd: opts.maxUsd ?? 6 }),
      // Writes stay off unless a human turned them on in the profile. Drafting
      // is always safe; filing is not, and the two are separate steps.
      tracker: { system: "jira", agentLabel: "clarvis" },
      project: opts.feature ?? profile.project.name,
      transcriptDir: path.join(paths.root, "transcripts"),
    });

    recordAgentRuns(run, dispatch.report.agentRuns);
    await writeFile(path.join(dir, "drafts.json"), JSON.stringify(dispatch.bundle, null, 2), "utf8");

    console.log("");
    for (const d of dispatch.bundle.drafts) {
      console.log(`  draft    ${d.publish.allowed ? "READY " : "held  "} ${d.title.slice(0, 78)}`);
      if (!d.publish.allowed) console.log(`           ${d.publish.reason.slice(0, 96)}`);
    }
    for (const n of dispatch.bundle.notes) console.log(`  draft    ${n}`);
    for (const w of dispatch.report.warnings) run.truncation!.push(w);
    if (dispatch.bundle.drafts.length) {
      console.log(`  draft    written ${path.join(dir, "drafts.json")}`);
    }
  }

  if (enabled.has("release")) {
    const clearance = await decideAndDescribe({
      run,
      runner: agentRunner(projectRoot),
      budget: new Budget({ maxUsd: opts.maxUsd ?? 6 }),
      release: { degradations: fleets.degradations },
      transcriptDir: path.join(paths.root, "transcripts"),
    });

    recordAgentRuns(run, clearance.agentRuns);
    await writeFile(path.join(dir, "verdict.json"), JSON.stringify(clearance.report, null, 2), "utf8");

    console.log("");
    for (const line of describeVerdict(clearance.report)) console.log(`  ${line}`);

    // Non-zero when holding, so this can gate a deploy.
    if (clearance.report.verdict.decision !== "ship") {
      process.exitCode = releaseExitCode(clearance.report.verdict);
    }
  }

  /* --- what we already knew ------------------------------------------------ */

  const ledgerBefore = await loadLedger(projectRoot);
  const applied = applyLedger(run.findings, ledgerBefore);

  if (applied.suppressed.length) {
    for (const s2 of applied.suppressed) {
      console.log(`  known    ${s2.entry.fingerprint}  ${s2.finding.title.slice(0, 62)}`);
      console.log(`           dismissed by ${s2.entry.dismissedBy}: ${(s2.entry.note ?? "").slice(0, 70)}`);
    }
    // Never silent: a quieter report is the failure this product exists against.
    run.truncation!.push(...applied.notes);
  }

  run.findings = applied.reported;
  await saveLedger(projectRoot, recordRun(ledgerBefore, run));

  /* --- account for anything this run created ------------------------------- */

  if (createdFixtures.length) {
    // A sandbox is dropped whole when the run ends, so nothing inside it needs
    // removing individually. A real database is not, and then the only honest
    // options are the project's own teardown or telling someone exactly what
    // is still there.
    const droppedWithSandbox = Boolean(sandbox);

    let swept = droppedWithSandbox
      ? { created: createdFixtures, leaked: [] as string[], teardownRan: false, warnings: [] as string[], prefix: "" }
      : await sweepFixtures({
          profile,
          created: createdFixtures,
          log: (l) => console.log(`  sweep    ${l}`),
        });

    /*
      An account made through the application is closed through it too.

      Only where it would otherwise persist. Inside a sandbox the whole
      database goes, so closing one account first is work for nothing; against
      a real database it is the difference between leaving residue and not.
    */
    if (!droppedWithSandbox && enrolledRole && swept.leaked.includes(enrolledRole.username)) {
      const withdrawn = await withdrawRole({
        profile,
        role: enrolledRole,
        storageState: sessions[enrolledRole.key],
        log: (l) => console.log(`  sweep    ${l}`),
      });

      if (withdrawn.ok) {
        swept = { ...swept, leaked: swept.leaked.filter((l) => l !== enrolledRole!.username) };
      } else {
        console.log(`  sweep    ${withdrawn.reason}`);
      }
    }

    run.preparation = {
      ...run.preparation,
      fixtures: {
        created: createdFixtures,
        removed: droppedWithSandbox ? createdFixtures : createdFixtures.filter((c) => !swept.leaked.includes(c)),
        wroteTo: droppedWithSandbox ? "sandbox" : "real-database",
        note: droppedWithSandbox
          ? "Created inside a database made for this run, which is dropped with it."
          : swept.teardownRan
            ? "Removed by the project's own teardown command."
            : `Still present in ${decision.target}. Every identifier carries the fixture prefix.`,
      },
    };

    for (const w of swept.warnings) run.truncation!.push(w);

    if (!droppedWithSandbox && swept.leaked.length) {
      const left =
        `${swept.leaked.length} record(s) created by this run remain in ${decision.target}: ` +
        `${swept.leaked.join(", ")}`;
      console.log(`  sweep    ${left}`);
      run.truncation!.push(left);
    }
  }

  /* --- what the author got wrong, kept for next time ----------------------- */

  const mistakes = mistakesFrom(run, rejectedSpecs);
  if (mistakes.length && opts.author !== false) {
    const before = await loadLessons(projectRoot);
    const learnt = await learnFromRun({
      run,
      mistakes,
      existing: before,
      runner: agentRunner(projectRoot),
      budget: new Budget({ maxUsd: 0.5 }),
      transcriptDir: path.join(paths.root, "transcripts"),
    });

    await saveLessons(projectRoot, learnt.lessons);
    recordAgentRuns(run, learnt.agentRuns);

    for (const l of learnt.added) console.log(`  learned  ${l.text}`);
    for (const r of learnt.refused) console.log(`  refused  ${r.why}: "${r.text}"`);
  }

  // Close the last stage out, so a finished run does not read as one still
  // sitting in whatever step it happened to end on.
  await markStage(projectRoot, run, "done");

  const file = await writeRun(projectRoot, run);

  // Old runs are deleted whole, artifacts included. Triage keeps a Playwright
  // trace per re-run, so this grows faster than it looks.
  const pruned = await pruneRuns(projectRoot, opts.keepRuns ?? 10);
  if (pruned.removed.length) {
    console.log(
      `  pruned   ${pruned.removed.length} old run(s), freed ${formatBytes(pruned.freedBytes)}`,
    );
  }

  console.log("");
  for (const a of run.axes) {
    const r = a.results;
    console.log(
      `  ${a.key.padEnd(18)} ${a.status.toUpperCase().padEnd(8)}` +
        (r ? ` ${r.passed} pass  ${r.failed} fail  ${r.skipped} skip` : ""),
    );
  }
  const isNew = new Set(applied.newFindings.map((f) => f.id));

  for (const f of run.findings) {
    console.log(
      `\n  ${f.severity.toUpperCase()}${isNew.has(f.id) ? " NEW" : ""}  ${f.title}` +
        `\n           oracle ${f.oracle.type}${f.oracle.citation ? ` (${f.oracle.citation})` : ""} · tier ${f.tier}` +
        `\n           ${f.actual.split("\n")[0].slice(0, 110)}`,
    );
  }

  const spent = (run.agentRuns ?? []).reduce((sum, a) => sum + (a.usdEstimate ?? 0), 0);

  console.log(
    `\n  ${run.status.toUpperCase()} - ${totals.passed} pass / ${totals.failed} fail / ${totals.skipped} skip`,
  );
  if (spent > 0) {
    console.log(`  usage    ${spendLabel(spent, undefined, tokensOf(run))}`);
    console.log(`           ${spendNote()}`);
  }
  if (totals.skipped > 0)
    console.log(`  note: ${totals.skipped} skipped spec(s) - not a pass.`);
  console.log(`  written  ${file}\n`);

  // A spec that caught something is a regression test. Keeping it is what makes
  // the tool compound rather than start from nothing every run.
  // Opt-in, because it is the only thing that writes inside the project.
  if (opts.promote === true && run.findings.some((f) => f.tier === "CONFIRMED")) {
    const promoted = await promote({
      projectRoot,
      run,
      specDir: paths.scratch,
      replace: opts.replacePromoted,
    });
    for (const w of promoted.written) console.log(`  promoted ${w.target}`);
    for (const sk of promoted.skipped) console.log(`  kept     ${sk.target}: ${sk.why}`);
    for (const n of promoted.notes) console.log(`  note     ${n}`);
  }

  if (run.status === "findings") process.exitCode = 1;
}
