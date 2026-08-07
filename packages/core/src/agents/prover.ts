import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureContext, Requirement } from "../context.ts";
import type { Axis, Finding, OracleType, Profile, Severity } from "../types.ts";
import type { Budget } from "./budget.ts";
import { getAgent } from "./definitions.ts";
import { runAgent, type AgentResult, type AgentRunner } from "./runtime.ts";
import { describeViolations, gateSpec, type GateResult } from "./specGate.ts";

/**
 * PROVER: author the specs, gate them, run them, and turn what failed into
 * findings that cite something.
 *
 * The agent returns spec SOURCE and this module writes the file. It is not given
 * a write tool, and that is a deliberate reversal of the obvious design: Claude
 * Code grants read and write together per directory, so an author agent able to
 * write its spec into the project could also edit the application it is testing.
 * A tester that can modify the system under test invalidates every result it
 * produces, and no amount of prompting makes that safe. Returning text keeps the
 * only writer in code.
 *
 * The other rule here is that no count comes from an agent. Pass and fail totals
 * come from the Playwright JSON reporter; an agent's description of its own run
 * is never the record.
 */

export interface AxisPlan {
  axis: Axis;
  /** Requirements this axis should assert against, strongest oracle first. */
  requirements: Requirement[];
  /** Roles to exercise. Empty means anonymous only. */
  roles: string[];
  notes: string[];
}

export interface AuthoredSpec {
  axis: Axis;
  file: string;
  source: string;
  gate: GateResult;
  attempts: number;
  /** Requirement ids the author claims to have covered. */
  covers: string[];
  /** What the author could not test, and why. Surfaced, never dropped. */
  untested: Array<{ requirementId?: string; reason: string }>;
}

export interface CrucibleReport {
  authored: AuthoredSpec[];
  rejected: Array<{ axis: Axis; attempts: number; violations: string[] }>;
  agentRuns: Array<AgentResult<unknown>>;
  usdEstimate: number;
  warnings: string[];
}

interface AuthorOutput {
  source: string;
  covers?: string[];
  untested?: Array<{ requirementId?: string; reason: string }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function validateAuthor(parsed: unknown): { ok: true; value: AuthorOutput } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (typeof parsed.source !== "string" || !parsed.source.trim()) {
    return { ok: false, error: "'source' must be the complete spec file as a string." };
  }
  return { ok: true, value: parsed as unknown as AuthorOutput };
}

/**
 * What each axis is for, in the terms an author needs.
 *
 * Kept here rather than in the agent definitions because it is per-axis task
 * detail, not per-role behaviour - one author role covers every axis, and the
 * shared system prompt is what keeps the prompt cache warm across all of them.
 */
const AXIS_BRIEFS: Record<Axis, string> = {
  "happy-path":
    "The primary flows a user is expected to complete. Assert the outcome, not that a click " +
    "happened: a form submission that appears to work but stores nothing must fail this axis.",
  "rbac-scope":
    "What each role may and may not reach. For a denied route, assert on the RESPONSE, not only " +
    "on what is visible: an app that returns 200 with the contents hidden has not denied anything, " +
    "and a test that only checks visibility reports it as correct.",
  "i18n-rtl":
    "Every configured locale renders in the right direction with no untranslated strings left in " +
    "the page. Assert on dir/lang attributes and on the absence of source-language text.",
  adversarial:
    "Inputs and states the app did not plan for: script payloads in text fields, cookies without " +
    "the flags they need, direct navigation past a step, oversized and empty input.",
  "responsive-a11y":
    "The interface stays usable at the configured viewports and is reachable by keyboard and by " +
    "an accessible name. Assert that controls remain within the viewport and remain clickable.",
  resilience:
    "The app under a failing dependency: a slow or erroring route, a dropped connection, a " +
    "double submit. Assert that it degrades visibly rather than silently.",
  visual:
    "Layout and rendering that other axes do not assert on. Prefer structural assertions over " +
    "screenshot comparison unless a baseline already exists.",
};

/**
 * Turn the context into a per-axis plan. Deterministic: which requirements an
 * axis should assert against follows from the axis hints already recorded on
 * them, so a model is not asked to re-decide it every run.
 */
export function planAxes(opts: {
  axes: Axis[];
  context?: FeatureContext;
  profile: Profile;
}): AxisPlan[] {
  const requirements = opts.context?.requirements ?? [];

  return opts.axes.map((axis) => {
    const hinted = requirements.filter((r) => r.axisHints?.includes(axis));
    // An axis with no hinted requirement still runs, against the general brief.
    // Reporting it as unrunnable would hide the axis entirely; reporting it as
    // fully specified would overstate the oracle. It is neither.
    const notes: string[] = [];
    if (!hinted.length && requirements.length) {
      notes.push(
        `No requirement is tagged for ${axis}. Tests on this axis can only assert code intent, ` +
          `so their findings cap below CONFIRMED.`,
      );
    }
    if (!requirements.length) {
      notes.push(
        `No verified requirements exist at all. Run \`clarvis research\` first, or every finding ` +
          `on this axis will cite nothing.`,
      );
    }

    const roles =
      axis === "rbac-scope"
        ? opts.profile.auth.roles.map((r) => r.key)
        : opts.profile.auth.roles.slice(0, 1).map((r) => r.key);

    return { axis, requirements: hinted.length ? hinted : requirements.slice(0, 6), roles, notes };
  });
}

/**
 * The part of the brief that describes the real page.
 *
 * An accessibility snapshot is what `getByRole` matches against, so handing one
 * over turns selector-writing from inference into transcription. Without it the
 * author reads JSX and guesses what the browser built from it - and a component
 * library, a portal or a wrapper that forwards to a different element all make
 * that guess wrong in ways no amount of care in the prompt can fix.
 */
function renderSurface(profile: Profile): string {
  const routes = profile.surface?.routes ?? [];
  if (!routes.length) return "";

  const snapshots = routes.filter((r) => r.ariaSnapshot);
  if (!snapshots.length) return "";

  return [
    "",
    "THE ACTUAL PAGES. These are accessibility snapshots taken from the running",
    "application, which is what getByRole matches against. Write selectors from",
    "these, not from the source - if a control is not here, it is not on the page.",
    ...snapshots.map((r) =>
      [
        "",
        `--- ${r.path}${r.title ? `   "${r.title}"` : ""}${r.requiresAuth ? "   (needs a session)" : ""}`,
        r.ariaSnapshot,
      ].join("\n"),
    ),
  ].join("\n");
}

/**
 * How this spec gets its session.
 *
 * The single most repeated and least verified thing an author used to write.
 * It is now established in code and verified before any spec runs, so the
 * instruction is to not write one - a login flow an author cannot write is a
 * login flow it cannot get wrong.
 */
function renderSessions(plan: AxisPlan, profile: Profile, sessions?: Record<string, string>): string {
  const available = Object.entries(sessions ?? {}).filter(([key]) => plan.roles.includes(key));
  if (!available.length) {
    return profile.auth.roles.length
      ? "SESSION: none could be established, so every test here runs anonymously. Do not " +
          "attempt to log in - it was already tried in code and it failed. Assert only what an " +
          "anonymous visitor can reach, and put everything else in 'untested'."
      : "SESSION: this application has no authentication configured. Test anonymously.";
  }

  const [primaryRole, primaryState] = available[0];

  return [
    `SESSION: you are ALREADY LOGGED IN as "${primaryRole}". Do not write a login flow,`,
    "do not navigate to the login page, and do not fill a password field. It is done",
    "before your spec runs and it has been verified. Writing one again is the single",
    "most common way a spec fails against a working application.",
    available.length > 1
      ? [
          "",
          "To test as a different role, set its storage state on a describe block:",
          "",
          ...available.map(
            ([key, state]) =>
              `  test.describe("as ${key}", () => {\n    test.use({ storageState: ${JSON.stringify(state)} });\n    // ...\n  });`,
          ),
          "",
          "To test as an anonymous visitor, use: test.use({ storageState: { cookies: [], origins: [] } });",
        ].join("\n")
      : `  (storage state: ${primaryState})`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** What the author may assume exists in the database. */
function renderData(profile: Profile, data?: { seeded: boolean; note?: string }): string {
  const prefix = profile.data.fixturePrefix ?? "clarvis-";

  if (!data) {
    return `FIXTURE PREFIX: ${prefix} - every record you create must use it, and be cleaned up.`;
  }

  return [
    data.seeded
      ? "DATA: the project's own seed command ran before this spec, so the application holds " +
        "its normal starting data. Prefer asserting against what seeding created over creating " +
        "your own - the team's seed script is a more faithful model of their data than anything " +
        "you would construct."
      : "DATA: nothing was seeded, so the application holds whatever was already there - possibly " +
        "nothing. An assertion that a list has rows may be asserting on leftovers, or may fail on " +
        "an empty database while the application is perfectly correct. Create what you need.",
    data.note ? `  ${data.note}` : "",
    `FIXTURE PREFIX: ${prefix} - every record you create must use it, and be cleaned up.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderPlan(
  plan: AxisPlan,
  profile: Profile,
  extra?: {
    sessions?: Record<string, string>;
    data?: { seeded: boolean; note?: string };
    lessons?: string;
  },
): string {
  const roles = profile.auth.roles.filter((r) => plan.roles.includes(r.key));

  return [
    `AXIS: ${plan.axis}`,
    AXIS_BRIEFS[plan.axis],
    "",
    `BASE URL: ${profile.boot.url} (use RELATIVE paths - baseURL is configured for you)`,
    profile.stack?.rendering === "client-rendered"
      ? `RENDERING: client-rendered. The server returns a shell and the content appears ` +
        `${profile.stack.hydrationMs ? `about ${Math.round(profile.stack.hydrationMs / 100) / 10}s ` : ""}` +
        `later, after hydration.\n` +
        `  - Never assert on the response body: it does not contain the page.\n` +
        `  - After navigating, wait for something real before asserting anything else.\n` +
        `  - Prefer web-first assertions (expect(locator).toBeVisible()) which retry, over\n` +
        `    reading textContent or counting elements, which do not.`
      : profile.stack?.rendering === "server-rendered"
        ? `RENDERING: server-rendered. The first response contains the page, so asserting on the ` +
          `response body is valid.`
        : "",
    renderSessions(plan, profile, extra?.sessions),
    // The brief never listed routes at all, which is why a spec invented one
    // and navigated anonymously to a protected page - it saw a login screen and
    // reported the real page as broken.
    (profile.surface?.routes ?? []).length
      ? `KNOWN ROUTES. Do not navigate anywhere that is not on this list:\n${(profile.surface?.routes ?? [])
          .map((r) => {
            const flags = [
              r.requiresAuth ? "needs a session" : "",
              r.landedOn ? `redirects to ${r.landedOn}` : "",
              r.dynamic ? "dynamic - needs a real id, do not visit as written" : "",
              r.status && r.status >= 400 ? `returned ${r.status}` : "",
            ].filter(Boolean);
            return `  ${r.path}${flags.length ? `   (${flags.join("; ")})` : ""}`;
          })
          .join("\n")}`
      : "KNOWN ROUTES: none were mapped. Use only routes you have read in the source, and " +
        "check whether each one is behind auth before visiting it anonymously.",
    // Credentials are deliberately absent: sessions are established in code, so
    // an author has no reason to hold a password and no way to leak one into a
    // spec file that gets committed.
    roles.length
      ? `ROLES in scope for this axis:\n${roles
          .map(
            (r) =>
              `  ${r.key}${r.label ? ` (${r.label})` : ""}` +
              (r.expectedDenied?.length ? `   MUST NOT reach: ${r.expectedDenied.join(", ")}` : ""),
          )
          .join("\n")}`
      : "ROLES: none configured - test anonymously.",
    renderSurface(profile),
    "",
    plan.requirements.length
      ? `REQUIREMENTS to assert against. Cite the id in a comment above each assertion:\n${plan.requirements
          .map((r) => `  [${r.id}] ${r.statement}\n      source: ${r.quote.slice(0, 160)}`)
          .join("\n")}`
      : "REQUIREMENTS: none verified. Assert only what the application itself makes observable, " +
        "and list everything you could not judge in 'untested'.",
    plan.notes.length ? `\nNOTES:\n${plan.notes.map((n) => `  - ${n}`).join("\n")}` : "",
    extra?.lessons ?? "",
    "",
    renderData(profile, extra?.data),
    "",
    "Return JSON: { source, covers[], untested[] }. 'source' is the COMPLETE spec file.",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface AuthorOptions {
  axes: Axis[];
  /**
   * What this project's author has previously got wrong.
   *
   * Rendered into the brief so a mistake the gate or triage has already caught
   * is not made again. Comes from `lessons.json`, which only ever holds
   * sentences that survived a code-side vet.
   */
  lessons?: string;
  profile: Profile;
  context?: FeatureContext;
  runner: AgentRunner;
  budget: Budget;
  scratchDir: string;
  transcriptDir?: string;
  redact?: (text: string) => string;
  maxAttempts?: number;
  /** storageState path per role, from `establishSessions`. */
  sessions?: Record<string, string>;
  /** What `prepareData` left in the database. */
  data?: { seeded: boolean; note?: string };
}

/**
 * Author one spec file per axis, gating each before it is written.
 *
 * A spec that fails the gate is retried with the violations quoted back. A spec
 * that still fails is NOT written: an ungated spec that runs is exactly the
 * false-green this whole module exists to prevent, and an axis with no file is
 * reported as skipped, which is honest.
 */
export async function authorSpecs(opts: AuthorOptions): Promise<CrucibleReport> {
  const authored: AuthoredSpec[] = [];
  const rejected: CrucibleReport["rejected"] = [];
  const agentRuns: Array<AgentResult<unknown>> = [];
  const warnings: string[] = [];

  await mkdir(opts.scratchDir, { recursive: true });
  const plans = planAxes({ axes: opts.axes, context: opts.context, profile: opts.profile });

  // Axes are authored concurrently. Safe because `Budget.reserve` debits before
  // any await, so the ceiling holds however many run at once - and seven axes
  // authored one at a time is over half an hour of waiting.
  const authoredPerAxis = await Promise.all(plans.map((plan) => authorOne(plan)));

  for (const outcome of authoredPerAxis) {
    warnings.push(...outcome.warnings);
    if (outcome.spec) authored.push(outcome.spec);
    if (outcome.rejected) rejected.push(outcome.rejected);
  }

  async function authorOne(plan: AxisPlan): Promise<{
    spec?: AuthoredSpec;
    rejected?: CrucibleReport["rejected"][number];
    warnings: string[];
  }> {
    const warnings: string[] = [];
    for (const note of plan.notes) warnings.push(`${plan.axis}: ${note}`);

    const maxAttempts = opts.maxAttempts ?? 3;
    let lastViolations: string[] = [];

    // Rendered once: it is the largest part of the prompt and identical across
    // attempts, so building it per attempt would only cost tokens.
    const brief = renderPlan(plan, opts.profile, {
      sessions: opts.sessions,
      data: opts.data,
      lessons: opts.lessons,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await runAgent<AuthorOutput>({
        runner: opts.runner,
        definition: getAgent("prover-author"),
        prompt:
          lastViolations.length
            ? `${brief}\n\nYour previous spec was REJECTED before it ran:\n${lastViolations.join("\n")}`
            : brief,
        validate: validateAuthor,
        budget: opts.budget,
        agentId: `prover-author-${plan.axis}-${attempt}`,
        maxAttempts: 1,
        transcriptDir: opts.transcriptDir,
        redact: opts.redact,
      });
      agentRuns.push(result as AgentResult<unknown>);

      if (result.status !== "ok" || !result.data) {
        // Running out of turns is not the same as writing a bad spec, and
        // retrying with the same instruction just hits the same wall. Telling it
        // to stop exploring is the only thing that changes the outcome.
        const ranOut = /ran out of turns/i.test(result.error ?? "");
        lastViolations = ranOut
          ? [
              "You ran out of turns before returning anything, so nothing was written.",
              "Stop exploring and write the spec now from what you already know.",
              "Read at most two more files. A shorter spec that runs beats a thorough one that never arrives.",
            ]
          : [`The author did not return a usable spec (${result.status}).`];
        continue;
      }

      const source = result.data.source;
      const untested = (result.data.untested ?? []).filter(
        (u) => isRecord(u) && typeof u.reason === "string",
      );

      const gate = gateSpec(source, {
        forbiddenHosts: opts.profile.data.forbiddenHosts,
        axis: plan.axis,
        reportedUntested: untested.length,
        sessionsEstablished: Boolean(Object.keys(opts.sessions ?? {}).length),
      });

      if (!gate.ok) {
        lastViolations = [describeViolations(gate.violations)];
        continue;
      }

      const file = path.join(opts.scratchDir, `${plan.axis}-1.spec.ts`);
      await writeFile(file, source, "utf8");

      // Every requirement given to this axis must be either covered or declared
      // untested. One that is neither has silently vanished, and the run would
      // read as though it had been checked.
      const accounted = new Set([
        ...(result.data.covers ?? []),
        ...untested.map((u) => u.requirementId),
      ]);
      const unaccounted = plan.requirements.filter((r) => !accounted.has(r.id));
      for (const r of unaccounted) {
        warnings.push(
          `${plan.axis}: requirement ${r.id} was neither covered nor declared untested - ` +
            `"${r.statement.slice(0, 80)}". Treat this axis as not covering it.`,
        );
      }

      return {
        warnings,
        spec: {
          axis: plan.axis,
          file,
          source,
          gate,
          attempts: attempt,
          covers: (result.data.covers ?? []).filter((c): c is string => typeof c === "string"),
          untested,
        },
      };
    }

    warnings.push(
      `${plan.axis}: no spec passed the gate after ${maxAttempts} attempt(s), so this axis did not run. ` +
        `It is NOT a pass.`,
    );
    return {
      warnings,
      rejected: { axis: plan.axis, attempts: maxAttempts, violations: lastViolations },
    };
  }

  return {
    authored,
    rejected,
    agentRuns,
    usdEstimate: agentRuns.reduce((sum, r) => sum + r.usdEstimate, 0),
    warnings,
  };
}

/* ------------------------------------------------------------------ findings */

interface ReportTest {
  title: string;
  status?: string;
  error?: string;
  file?: string;
  line?: number;
  attachments?: Array<{ name?: string; path?: string }>;
}

/** Walk the Playwright JSON report and pull out what actually failed. */
export function failedTests(report: unknown): ReportTest[] {
  const out: ReportTest[] = [];

  const walk = (node: unknown, file?: string): void => {
    const n = node as {
      title?: string;
      file?: string;
      suites?: unknown[];
      specs?: Array<{
        title?: string;
        ok?: boolean;
        file?: string;
        line?: number;
        tests?: Array<{
          status?: string;
          results?: Array<{
            status?: string;
            error?: { message?: string };
            attachments?: Array<{ name?: string; path?: string }>;
          }>;
        }>;
      }>;
    };

    const here = n?.file ?? file;

    for (const spec of n?.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.status !== "unexpected" && t.status !== "flaky") continue;
        const last = (t.results ?? []).at(-1);
        out.push({
          title: spec.title ?? "(untitled)",
          status: t.status,
          error: last?.error?.message,
          file: spec.file ?? here,
          line: spec.line,
          attachments: last?.attachments,
        });
      }
    }
    for (const child of n?.suites ?? []) walk(child, here);
  };

  walk(report);
  return out;
}

/**
 * Pick the oracle a finding is entitled to cite.
 *
 * The ceiling matters more than the label: a finding whose only basis is that
 * the code looked wrong must not be presented alongside one that contradicts a
 * written requirement. Matching is by explicit citation - the author is asked to
 * name a requirement id in a comment, and an unnamed one gets "code-intent"
 * rather than a guess.
 */
/**
 * Does this text cite this requirement id?
 *
 * Word-bounded, because ids are short. A plain `includes("r1")` matches inside
 * "r10", inside "for1", and inside any prose that happens to contain those two
 * characters - and since the scan returns the first match, a live run attributed
 * almost every finding to r1 regardless of what it was actually about.
 */
export function citesRequirement(text: string, id: string): boolean {
  if (!text || !id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text);
}

/**
 * The slice of a spec file belonging to one test.
 *
 * Scanning the whole file for requirement ids attributes every finding in it to
 * every requirement it mentions. A live run produced nine confirmed findings of
 * which eight cited r2 - the /admin rule - including the empty-title bug, the
 * HttpOnly bug and the Arabic locale bug. The author had cited the right id
 * above each assertion; the matcher just could not see which test it was in.
 */
export function testRegion(source: string, title: string): string {
  if (!source || !title) return "";

  // Split at test boundaries rather than parsing: a test body is everything
  // from its own `test(` up to the next one.
  const starts: number[] = [];
  const re = /\btest\s*(?:\.\s*\w+\s*)?\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) starts.push(m.index);
  if (!starts.length) return "";

  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1] ?? source.length;
    const chunk = source.slice(start, end);
    if (chunk.includes(title)) return chunk;
  }
  return "";
}

export function oracleFor(
  test: ReportTest,
  spec: AuthoredSpec | undefined,
  context?: FeatureContext,
): Finding["oracle"] {
  // Deliberately NOT the file-level `covers` list: that names every requirement
  // the file touches, which is exactly the over-attribution being avoided here.
  const region = testRegion(spec?.source ?? "", test.title);

  const cited = (context?.requirements ?? []).filter(
    (req) => citesRequirement(test.title, req.id) || citesRequirement(region, req.id),
  );

  // A contested requirement is one that other requirements contradict. Citing
  // it as the basis for a finding would present a disagreement as a standard,
  // so it is not used as an oracle at all.
  const usable = cited.filter((req) => req.confidence !== "contested");

  // Prefer an explicitly stated requirement over an implied one: both are
  // human-authored and quote-verified, but the explicit one needs no inference.
  const best = usable.find((req) => req.confidence === "explicit") ?? usable[0];

  if (!best) {
    return { type: "code-intent" };
  }

  const source = context?.sources.find((src) => best.sourceIds.includes(src.id));

  return {
    // The citation and the type always agree: if a requirement is named here,
    // it is one strong enough to have been the basis for the finding.
    type: "acceptance-criteria" as OracleType,
    citation: `${best.id} (${source?.ref ?? "source"})`,
    quote: best.quote,
  };
}

/** Severity from the axis, not from an agent's opinion of its own finding. */
const AXIS_SEVERITY: Record<Axis, Severity> = {
  "rbac-scope": "critical",
  adversarial: "high",
  "happy-path": "high",
  resilience: "medium",
  "i18n-rtl": "medium",
  "responsive-a11y": "medium",
  visual: "low",
};

export function findingsFromReport(opts: {
  axis: Axis;
  report: unknown;
  spec?: AuthoredSpec;
  context?: FeatureContext;
  artifactsDir?: string;
  runId: string;
}): Finding[] {
  return failedTests(opts.report).map((t, i) => {
    const oracle = oracleFor(t, opts.spec, opts.context);
    const screenshots = (t.attachments ?? [])
      .filter((a) => a.name === "screenshot" && a.path)
      .map((a) => a.path!);
    const trace = (t.attachments ?? []).find((a) => a.name === "trace")?.path;

    return {
      id: `${opts.runId}-${opts.axis}-${i + 1}`,
      axis: opts.axis,
      title: t.title,
      severity: AXIS_SEVERITY[opts.axis],
      // A failure is PLAUSIBLE until triage reproduces it. Nothing reaches
      // CONFIRMED on the strength of one red test.
      tier: "PLAUSIBLE",
      tierReason:
        t.status === "flaky"
          ? "Passed on retry, so it is intermittent. Not confirmed."
          : "Failed once. Triage has not reproduced it yet.",
      oracle,
      expected: oracle.quote ?? "See the assertion in the spec.",
      actual: (t.error ?? "The assertion failed.").slice(0, 1200),
      evidence: {
        specFile: opts.spec?.file ?? t.file ?? "(unknown)",
        tracePath: trace,
        screenshots: screenshots.length ? screenshots : undefined,
      },
      determinism:
        t.status === "flaky" ? { verdict: "flaky" } : undefined,
      foundBy: `prover-author-${opts.axis}`,
      createdAt: new Date().toISOString(),
      tracker: { status: "none" },
    } satisfies Finding;
  });
}
