import path from "node:path";
import { findLiteral, surveyProject, type Survey, type SurveyedFile } from "../connectors/survey.ts";
import type { GraphConnector } from "../connectors/graph.ts";
import { normalizeTarget } from "../guard.ts";
import { slugify } from "../scope.ts";
import type { AuthMode, AuthRole, Profile } from "../types.ts";
import type { Budget } from "./budget.ts";
import { getAgent } from "./definitions.ts";
import { runAgent, type AgentResult, type AgentRunner } from "./runtime.ts";

/**
 * PATHFINDER: work out what this project is, before anything touches it.
 *
 * Same shape as DOSSIER, for the same reason - the model is bracketed by code:
 *
 *   survey (code) -> propose (agents) -> validate (code) -> assemble (code)
 *
 * The asymmetry that governs this whole file: recon runs against a project
 * nobody has vetted, and its output decides what later fleets are allowed to do.
 * So every validation below is one-directional. An agent can NARROW what the
 * fleet may do - add a forbidden host, report a blocker, refuse to guess a boot
 * command - and it can never widen it. In particular:
 *
 *   - `data.disposable` is never set true here. Not by an agent, not by
 *     inference from a localhost URL. A human sets it or mutating tests do not
 *     run. That is the entire contract `decideGuard` depends on.
 *   - Forbidden hosts are the UNION of what the agent found and what the survey
 *     found in code. If the safety agent fails outright, the code-derived hosts
 *     are still written to the profile.
 *   - A credential that does not appear verbatim somewhere in the project is
 *     dropped. A fabricated login produces a run that silently tested nothing.
 */

export interface ReconReport {
  filesSurveyed: number;
  hostsDiscovered: number;
  agentRuns: Array<AgentResult<unknown>>;
  usdEstimate: number;
  /** Credentials the auth agent proposed that do not appear in any file. */
  rejectedCredentials: Array<{ role: string; reason: string }>;
  /** Hosts added by code, not by the agent. */
  hostsFromCode: string[];
  blockers: string[];
  warnings: string[];
  truncation: string[];
}

interface BootProposal {
  cmd?: string;
  cwd?: string;
  url?: string;
  readyCheck?: string;
  readyTimeoutMs?: number;
  evidence?: string;
  blockers?: string[];
}

interface AuthProposal {
  mode?: string;
  loginUrl?: string;
  apiLogin?: { url?: string; method?: string; bodyTemplate?: Record<string, unknown> };
  roles?: Array<{
    key?: string;
    label?: string;
    username?: string;
    password?: string;
    /** Where the credential was read from. Checked, not trusted. */
    sourceFile?: string;
    expectedDenied?: string[];
  }>;
  notes?: string;
}

interface SafetyProposal {
  forbiddenHosts?: string[];
  /** The agent's view. Recorded as a recommendation, never applied. */
  disposableRecommendation?: boolean;
  reasoning?: string;
  findings?: Array<{ host?: string; classification?: string; why?: string }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A trimmed string, or nothing.
 *
 * Every field below comes out of model-authored JSON, where a declared type is a
 * hope rather than a guarantee: `readyCheck` arrived once as an object and threw
 * on `.trim()`, taking the whole recon with it. Nothing here may assume a shape
 * the validator did not enforce.
 */
const s = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed || undefined;
};

/**
 * Host patterns that are never disposable, whatever anything claims.
 *
 * This list is short on purpose. It is a backstop for the obvious cases, not a
 * substitute for the deny-list built from the project's own files - a shared
 * database at a bare IP address looks like nothing in particular, which is
 * exactly why the survey extracts hosts mechanically.
 */
export const ALWAYS_FORBIDDEN = [
  "*prod*",
  "*production*",
  "*staging*",
  "*.live.*",
  "*live.*",
];

/** Loopback and the RFC1918 ranges. Not "safe" - just not obviously remote. */
function isLocalHost(host: string): boolean {
  const name = host.split(":")[0];
  if (name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "0.0.0.0") return true;
  if (name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".test")) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(name);
}

function validateBoot(parsed: unknown): { ok: true; value: BootProposal } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (parsed.url !== undefined && typeof parsed.url !== "string") {
    return { ok: false, error: "'url' must be a string when present." };
  }
  if (!parsed.url && !Array.isArray(parsed.blockers)) {
    return {
      ok: false,
      error: "Give either a 'url' or a 'blockers' array saying what a human must supply.",
    };
  }
  return { ok: true, value: parsed as BootProposal };
}

function validateAuth(parsed: unknown): { ok: true; value: AuthProposal } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (typeof parsed.mode !== "string") return { ok: false, error: "'mode' must be a string." };
  if (parsed.roles !== undefined && !Array.isArray(parsed.roles)) {
    return { ok: false, error: "'roles' must be an array when present." };
  }
  return { ok: true, value: parsed as AuthProposal };
}

function validateSafety(parsed: unknown): { ok: true; value: SafetyProposal } | { ok: false; error: string } {
  if (!isRecord(parsed)) return { ok: false, error: "Expected a JSON object." };
  if (!Array.isArray(parsed.forbiddenHosts)) {
    return { ok: false, error: "'forbiddenHosts' must be an array (empty is allowed)." };
  }
  return { ok: true, value: parsed as SafetyProposal };
}

const AUTH_MODES: AuthMode[] = [
  "none",
  "cookie-session",
  "cookie-jwt",
  "bearer-localstorage",
  "basic",
  "custom",
];

function renderFiles(files: SurveyedFile[], limit: number): { text: string; included: number } {
  const parts: string[] = [];
  let budget = limit;
  let included = 0;

  for (const f of files) {
    const block = `--- FILE ${f.path} (${f.kind})\n${f.content}\n`;
    if (block.length > budget) continue;
    budget -= block.length;
    included++;
    parts.push(block);
  }

  return { text: parts.join("\n"), included };
}

/**
 * Does a proposed boot command correspond to something that exists?
 *
 * Only the `<runner> run <script>` shape can be checked this way, and that is
 * the shape agents propose almost every time. An unrecognised command is not
 * rejected - it is passed through, because `bootAndVerify` will find out for
 * real. The point here is to catch the specific failure of an invented script
 * name, which fails late and confusingly.
 */
export function bootCommandExists(cmd: string, scripts: Record<string, string>): boolean | undefined {
  const match = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(cmd.trim());
  if (!match) return undefined;
  const script = match[1];
  if (["install", "i", "ci", "exec", "dlx", "x"].includes(script)) return undefined;
  return Object.hasOwn(scripts, script);
}

export interface ReconOptions {
  projectRoot: string;
  runner: AgentRunner;
  budget: Budget;
  projectName?: string;
  /** Existing profile. Human-confirmed data settings are preserved from it. */
  existing?: Profile;
  transcriptDir?: string;
  redact?: (text: string) => string;
  /** Commit recon ran against, for staleness checks later. */
  commit?: string;
  survey?: Survey;
  /**
   * Optional code graph. When present its hubs become risk hotspots - the
   * places where a change reaches furthest, which is a fact about the code
   * rather than an opinion about it.
   */
  graph?: GraphConnector;
}

export async function runRecon(opts: ReconOptions): Promise<{ profile: Profile; report: ReconReport }> {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const agentRuns: Array<AgentResult<unknown>> = [];
  const rejectedCredentials: ReconReport["rejectedCredentials"] = [];

  const survey = opts.survey ?? (await surveyProject({ projectRoot: opts.projectRoot }));

  if (!survey.files.length) {
    blockers.push(
      `No manifests, compose files or setup docs were found under ${opts.projectRoot}. ` +
        `There is nothing to work out how to start this project from.`,
    );
  }

  /* --- propose (agents) --------------------------------------------------- */

  const rendered = renderFiles(survey.files, 90_000);
  const truncation = [...survey.truncation];
  if (rendered.included < survey.files.length) {
    truncation.push(
      `${survey.files.length - rendered.included} surveyed file(s) did not fit the recon prompt.`,
    );
  }

  const header = [
    `PROJECT ROOT: ${opts.projectRoot}`,
    survey.packageManager ? `PACKAGE MANAGER: ${survey.packageManager}` : "",
    Object.keys(survey.scripts).length
      ? `PACKAGE SCRIPTS: ${Object.keys(survey.scripts).join(", ")}`
      : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const ask = async <T>(role: string, task: string, validate: (p: unknown) => { ok: true; value: T } | { ok: false; error: string }) => {
    const result = await runAgent<T>({
      runner: opts.runner,
      definition: getAgent(role),
      prompt: `${header}${task}\n\n${rendered.text}`,
      validate,
      budget: opts.budget,
      transcriptDir: opts.transcriptDir,
      redact: opts.redact,
    });
    agentRuns.push(result as AgentResult<unknown>);
    return result;
  };

  // Sequential rather than parallel: these share one budget, and a budget
  // checked concurrently can be overspent by whichever calls land together.
  const bootResult = await ask<BootProposal>(
    "pathfinder-boot",
    "Work out how to start this project and what URL it serves. Return JSON with " +
      "cmd, cwd, url, readyCheck, evidence, and blockers[] for anything you cannot determine.",
    validateBoot,
  );

  const authResult = await ask<AuthProposal>(
    "pathfinder-auth",
    "Identify how this application authenticates. Return JSON with mode, loginUrl, apiLogin, " +
      "roles[] and notes. For every credential, set sourceFile to the file it appears in - " +
      "credentials are checked against that file and dropped if they are not there.",
    validateAuth,
  );

  const safetyResult = await ask<SafetyProposal>(
    "pathfinder-safety",
    `Classify every host this project can reach. Hosts found in the files by static scan:\n` +
      survey.hosts.map((h) => `  ${h.host}  (${h.ref})`).join("\n") +
      `\n\nReturn JSON with forbiddenHosts[] (glob patterns), findings[] and reasoning.`,
    validateSafety,
  );

  /* --- validate (code) ----------------------------------------------------- */

  const boot = bootResult.data ?? {};
  if (bootResult.status !== "ok") {
    blockers.push(`Boot analysis did not complete (${bootResult.status}): ${bootResult.error ?? "no detail"}.`);
  }

  const bootCmd = s(boot.cmd);
  if (bootCmd) {
    const exists = bootCommandExists(bootCmd, survey.scripts);
    if (exists === false) {
      // The script does not exist, so the command cannot work. Keep it in the
      // profile as a starting point for a human, but never claim it is right.
      blockers.push(
        `Proposed boot command "${bootCmd}" refers to a script that is not in any package.json ` +
          `(known: ${Object.keys(survey.scripts).slice(0, 12).join(", ") || "none"}).`,
      );
    }
  }

  let url = s(boot.url);
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (url) {
    try {
      new URL(url);
    } catch {
      blockers.push(`Proposed boot URL "${url}" is not a valid URL.`);
      url = undefined;
    }
  }
  if (!url) {
    blockers.push("No boot URL could be determined. Set boot.url in the profile before running.");
  }

  // `readyCheck` is fetched verbatim by bootAndVerify, so it has to be a URL.
  // Agents describe it in prose ("GET /health -> 200") about as often as they
  // give one, and prose here means every boot probe fails for a reason nobody
  // would look for in this field.
  let readyCheck = s(boot.readyCheck);
  if (readyCheck) {
    const relative = /^\/\S*$/.test(readyCheck);
    if (relative && url) {
      readyCheck = new URL(readyCheck, url).toString();
    } else if (!/^https?:\/\/\S+$/i.test(readyCheck)) {
      warnings.push(
        `Ignoring boot.readyCheck "${readyCheck.slice(0, 60)}": it must be a URL or an absolute path, ` +
          `and it is fetched verbatim. Falling back to boot.url.`,
      );
      readyCheck = undefined;
    }
  }

  // Agents treat "blockers" as a notes field however the prompt is worded, and
  // a note filed as a blocker stops a run that would have worked. A blocker is
  // only a blocker if it coexists with a missing boot proposal; otherwise the
  // agent named a command and a URL, which is the definition of not blocked.
  const bootBlocked = !url || !bootCmd;
  for (const raw of boot.blockers ?? []) {
    const b = s(raw);
    if (!b) continue;
    if (bootBlocked) blockers.push(b);
    else warnings.push(`Boot analyst noted: ${b}`);
  }

  /* auth: every credential must exist in a file we actually read -------------- */

  const auth = authResult.data ?? {};
  if (authResult.status !== "ok") {
    warnings.push(
      `Auth analysis did not complete (${authResult.status}). No roles were recorded, so role-scoped ` +
        `axes will have nothing to log in as.`,
    );
  }

  const roles: AuthRole[] = [];

  for (const [i, raw] of (auth.roles ?? []).entries()) {
    // A key names the role in every later report and spec. "role-2" names
    // nothing, so fall back through the fields that carry meaning before
    // resorting to a position.
    const username = s(raw.username);
    const password = s(raw.password);
    const key = slugify(
      s(raw.key) ?? s(raw.label) ?? username?.split("@")[0] ?? `role-${i + 1}`,
    );

    if (!username || !password) {
      rejectedCredentials.push({ role: key, reason: "No username or password was reported." });
      continue;
    }

    // Same principle as quote verification in DOSSIER: asking an agent for a
    // source only gets a source-shaped string back, and checking it is what
    // makes fabrication detectable. The search covers the whole project because
    // that is what the agent could read - verifying against the narrower survey
    // would reject real credentials that live in a seed script.
    const [userHit, passHit] = await Promise.all([
      findLiteral(opts.projectRoot, username),
      findLiteral(opts.projectRoot, password),
    ]);

    if (!userHit.found || !passHit.found) {
      rejectedCredentials.push({
        role: key,
        reason: !userHit.found
          ? `Username "${username}" does not appear anywhere in the project.`
          : `The password for "${key}" does not appear anywhere in the project.`,
      });
      continue;
    }

    roles.push({
      key,
      label: s(raw.label),
      username,
      password,
      expectedDenied: Array.isArray(raw.expectedDenied)
        ? raw.expectedDenied.filter((r): r is string => typeof r === "string")
        : undefined,
    });
  }

  if (rejectedCredentials.length) {
    warnings.push(
      `${rejectedCredentials.length} proposed credential(s) were dropped because they do not appear ` +
        `in any file that was read. Treat this run's auth analysis with suspicion.`,
    );
  }

  const mode = AUTH_MODES.includes(auth.mode as AuthMode) ? (auth.mode as AuthMode) : "custom";

  /* safety: union, never intersection ---------------------------------------- */

  const safety = safetyResult.data ?? {};
  if (safetyResult.status !== "ok") {
    warnings.push(
      `Safety analysis did not complete (${safetyResult.status}). The deny-list below was built by ` +
        `static scan alone.`,
    );
  }

  const forbidden = new Set<string>(ALWAYS_FORBIDDEN);
  for (const h of safety.forbiddenHosts ?? []) {
    const pattern = s(h);
    if (pattern) forbidden.add(pattern.toLowerCase());
  }

  // Every non-local host the survey found goes on the deny-list regardless of
  // what the agent concluded. A remote host that later turns out to be a scratch
  // environment costs one read-only run; the reverse costs someone's data.
  const hostsFromCode: string[] = [];
  for (const h of survey.hosts) {
    if (isLocalHost(h.host)) continue;
    const bare = h.host.split(":")[0];
    if (!forbidden.has(bare)) {
      forbidden.add(bare);
      hostsFromCode.push(bare);
    }
  }

  if (hostsFromCode.length) {
    warnings.push(
      `${hostsFromCode.length} remote host(s) found in project files were added to forbiddenHosts ` +
        `automatically: ${hostsFromCode.slice(0, 6).join(", ")}${hostsFromCode.length > 6 ? " ..." : ""}.`,
    );
  }

  /* --- assemble (code) ------------------------------------------------------ */

  /* --- risk hotspots, from the code graph if there is one ----------------- */

  let hotspots: NonNullable<Profile["risk"]>["hotspots"];
  if (opts.graph) {
    const hubs = await opts.graph.hotspots(12);
    if (hubs.status === "ok" && hubs.data.length) {
      hotspots = hubs.data.map((h) => ({
        area: h.label,
        reason: `${h.degree} incoming or outgoing edges. A change here reaches unusually far.`,
        score: h.degree,
      }));
    } else if (hubs.note) {
      warnings.push(`No code-graph hotspots: ${hubs.note}`);
    }
  }

  const existing = opts.existing;

  // The one field recon must never decide. Preserved when a human already set
  // it, false otherwise - which makes an unvetted project read-only by default.
  const disposable = existing?.data?.disposable === true;

  if (safety.disposableRecommendation === true && !disposable) {
    warnings.push(
      "The safety analyst considers this target disposable. That is recorded as a recommendation only - " +
        "set data.disposable=true by hand to enable mutating tests.",
    );
  }

  const profile: Profile = {
    schemaVersion: 1,
    project: {
      name: opts.projectName ?? existing?.project?.name ?? path.basename(opts.projectRoot),
      root: opts.projectRoot,
      reconAt: new Date().toISOString(),
      reconCommit: opts.commit,
    },
    boot: {
      cmd: bootCmd ?? existing?.boot?.cmd,
      cwd: s(boot.cwd) ?? existing?.boot?.cwd,
      url: url ?? existing?.boot?.url ?? "",
      readyCheck: readyCheck ?? existing?.boot?.readyCheck,
      readyTimeoutMs: typeof boot.readyTimeoutMs === "number" ? boot.readyTimeoutMs : existing?.boot?.readyTimeoutMs,
      // Recon proposes; only bootAndVerify can set this true.
      verified: false,
      blockers: blockers.length ? blockers : undefined,
    },
    auth: {
      mode,
      loginUrl: s(auth.loginUrl) ?? existing?.auth?.loginUrl,
      apiLogin:
        isRecord(auth.apiLogin) && s(auth.apiLogin.url)
          ? {
              url: s(auth.apiLogin.url)!,
              method: auth.apiLogin.method === "GET" ? "GET" : "POST",
              bodyTemplate: isRecord(auth.apiLogin.bodyTemplate) ? auth.apiLogin.bodyTemplate : undefined,
            }
          : existing?.auth?.apiLogin,
      // A human-curated role list is worth more than a rediscovered one.
      roles: existing?.auth?.roles?.length ? existing.auth.roles : roles,
      notes: s(auth.notes),
    },
    data: {
      disposable,
      safeTargets: existing?.data?.safeTargets ?? [],
      confirmedBy: existing?.data?.confirmedBy,
      fixturePrefix: existing?.data?.fixturePrefix ?? "clarvis-",
      teardownCmd: existing?.data?.teardownCmd,
      forbiddenHosts: [...forbidden].sort(),
    },
    stack: {
      ...existing?.stack,
      packageManager: survey.packageManager ?? existing?.stack?.packageManager,
    },
    surface: existing?.surface,
    risk: hotspots?.length ? { ...existing?.risk, hotspots } : existing?.risk,
    viewports: existing?.viewports,
  };

  if (existing?.auth?.roles?.length && roles.length) {
    warnings.push(
      `${roles.length} role(s) were discovered but the existing profile's roles were kept. ` +
        `Delete auth.roles from the profile to adopt the discovered ones.`,
    );
  }

  const usd = agentRuns.reduce((sum, r) => sum + r.usdEstimate, 0);

  return {
    profile,
    report: {
      filesSurveyed: survey.files.length,
      hostsDiscovered: survey.hosts.length,
      agentRuns,
      usdEstimate: usd,
      rejectedCredentials,
      hostsFromCode,
      blockers,
      warnings,
      truncation,
    },
  };
}

/**
 * Whether a profile is good enough to run against. Separate from writing it:
 * a profile with blockers is still worth saving, because a human editing three
 * fields is a far better outcome than starting recon again.
 */
export function profileIsRunnable(profile: Profile): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!profile.boot.url) reasons.push("boot.url is empty.");
  if (profile.boot.blockers?.length) reasons.push(...profile.boot.blockers);

  if (profile.boot.url) {
    const target = normalizeTarget(profile.boot.url);
    const bare = target.split(":")[0];
    if ((profile.data.forbiddenHosts ?? []).some((h) => h.toLowerCase() === bare)) {
      reasons.push(`boot.url points at ${bare}, which is on the deny-list. The guard will abort.`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
