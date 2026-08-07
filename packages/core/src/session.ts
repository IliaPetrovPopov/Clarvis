import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { decideGuard } from "./guard.ts";
import type { AuthRole, Profile } from "./types.ts";

/**
 * Log in once, in code, and prove it worked.
 *
 * Before this, every spec logged itself in. That meant the single most
 * repeated, least verified piece of code in the whole system was written fresh
 * by a model for each axis, against selectors it had inferred from source it
 * had read. When it was wrong - a renamed field, a submit button that is a div,
 * a redirect that lands somewhere unexpected - the spec did not report "I could
 * not log in". It reported that the page under test was broken, because from
 * inside the test that is indistinguishable: the assertion failed.
 *
 * So login moves here. It happens once per role, it is verified against
 * evidence rather than assumed, and its result is a Playwright storageState
 * that every later spec starts from. A spec that begins already authenticated
 * cannot fail at logging in, and an author that never writes a login flow
 * cannot write a wrong one.
 *
 * When login fails it fails loudly, with what the page actually said. A role
 * that cannot be authenticated is reported as unusable and its axes are
 * skipped - never quietly downgraded to an anonymous run that passes while
 * testing nothing.
 *
 * Nothing here writes to the application beyond the login request itself. That
 * request is what authentication is; the guard is still consulted first, so a
 * forbidden host is never even contacted.
 */

export interface SessionResult {
  role: string;
  ok: boolean;
  /** Path to the Playwright storageState file. Present only when ok. */
  storageState?: string;
  /** What proved the session real. Present only when ok. */
  evidence?: string;
  /** Why it failed, in terms a human can act on. */
  reason?: string;
  /** What the page said when login was refused, if it said anything. */
  pageMessage?: string;
  /** Cookies and origins captured, for a quick sanity read. */
  captured?: { cookies: number; origins: number };
  durationMs: number;
}

/** Fields we can identify without knowing anything about the application. */
const PASSWORD = 'input[type="password"]';

/**
 * Candidate identity fields, strongest signal first.
 *
 * Type and autocomplete are declared intent and are checked before name
 * guessing, which is where a field called "user_id" that holds something else
 * would otherwise be picked up.
 */
export const IDENTITY_SELECTORS = [
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[type="email"]',
  'input[name*="email" i]',
  'input[name*="user" i]',
  'input[name*="login" i]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  'input[type="text"]',
  /*
    An input with no type attribute at all.

    `type` defaults to text, but `[type="text"]` is an attribute selector and
    matches nothing when the attribute is absent - so a perfectly ordinary
    `<input name="username">` fell through every rule above it and the form
    looked like it had no identity field. Common enough in hand-written HTML
    to be worth the last line.
  */
  "input:not([type])",
];

/** The password field, exported so enrolment matches on exactly the same rule. */
export const PASSWORD_SELECTOR = PASSWORD;

/** Text that means "this attempt was refused", so we stop waiting early. */
const REFUSAL = /invalid|incorrect|failed|wrong|not found|unauthor|denied|try again|does not match/i;

async function firstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

/**
 * Anything on the page that reads like an error.
 *
 * Used only to explain a failure. A login that worked is never judged by this,
 * because an application may legitimately show a warning on a page that also
 * logged you in.
 */
async function readRefusal(page: Page): Promise<string | undefined> {
  const candidates = ['[role="alert"]', ".error", '[class*="error" i]', '[data-testid*="error" i]'];
  for (const selector of candidates) {
    const text = await page
      .locator(selector)
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => "");
    if (text?.trim()) return text.trim().slice(0, 300);
  }

  // Nothing marked as an error, so fall back to any visible refusal wording.
  const body = await page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && REFUSAL.test(l));
  return line?.slice(0, 300);
}

/**
 * Substitute the role's credential into a body template recon recorded.
 *
 * Recognises `{{username}}` and `{{password}}` anywhere in a string value, so a
 * template can nest them - `{ user: { email: "{{username}}" } }` - which real
 * login endpoints do.
 */
export function fillTemplate(template: Record<string, unknown>, role: AuthRole): Record<string, unknown> {
  const swap = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value
        .replace(/\{\{\s*(username|email|user)\s*\}\}/gi, role.username)
        .replace(/\{\{\s*password\s*\}\}/gi, role.password);
    }
    if (Array.isArray(value)) return value.map(swap);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
    }
    return value;
  };
  return swap(template) as Record<string, unknown>;
}

function loginPath(profile: Profile): string {
  const raw = profile.auth.loginUrl?.trim() || "/login";
  return raw.startsWith("http") ? new URL(raw).pathname : raw.startsWith("/") ? raw : `/${raw}`;
}

/**
 * Drive the login form for one role and verify the result.
 *
 * Verification is the whole point, so it is deliberately strict: the password
 * field must be gone AND we must no longer be on the login route. Either alone
 * is a false positive waiting to happen - an application can clear its form
 * while refusing you, and it can leave you on /login with a session already set.
 */
async function loginViaForm(
  page: Page,
  profile: Profile,
  role: AuthRole,
): Promise<{ ok: boolean; evidence?: string; reason?: string; pageMessage?: string }> {
  const base = profile.boot.url.replace(/\/$/, "");
  const loginRoute = loginPath(profile);

  await page.goto(`${base}${loginRoute}`, { waitUntil: "domcontentloaded" });

  // `waitFor`, not `isVisible`. The latter answers about the page as it is at
  // that instant and never waits, however generous a timeout it is passed - so
  // against a client-rendered application it is asked before the form exists
  // and reports a working login page as having no password field.
  const password = page.locator(PASSWORD).first();
  const appeared = await password
    .waitFor({ state: "visible", timeout: 45_000 })
    .then(() => true)
    .catch(() => false);

  if (!appeared) {
    return {
      ok: false,
      reason:
        `No password field appeared at ${loginRoute} within 45s. Either that is not the login ` +
        `page, or it did not render. Check profile.auth.loginUrl.`,
      pageMessage: await readRefusal(page),
    };
  }

  const identity = await firstVisible(page, IDENTITY_SELECTORS);
  if (!identity) {
    return {
      ok: false,
      reason: `Found a password field at ${loginRoute} but no username or email field beside it.`,
    };
  }

  await identity.fill(role.username ?? "");
  await password.fill(role.password ?? "");

  // Prefer the form's own submit control; fall back to Enter, which a real form
  // handles natively and which works when the button is a styled div.
  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Continue")',
  ]);

  if (submit) await submit.click();
  else await password.press("Enter");

  // Wait for the form to go away, but stop early if the page says no. Racing
  // the two means a refused login costs a second rather than the full timeout.
  const settled = await Promise.race([
    page
      .locator(PASSWORD)
      .first()
      .waitFor({ state: "hidden", timeout: 45_000 })
      .then(() => "form-gone" as const)
      .catch(() => "timeout" as const),
    page
      .locator(`text=${REFUSAL.source}`)
      .first()
      .waitFor({ state: "visible", timeout: 45_000 })
      .then(() => "refused" as const)
      .catch(() => "timeout" as const),
  ]);

  const landedOn = new URL(page.url()).pathname;
  const stillOnLogin = landedOn.replace(/\/$/, "") === loginRoute.replace(/\/$/, "");
  const passwordGone = !(await page
    .locator(PASSWORD)
    .first()
    .isVisible()
    .catch(() => false));

  if (settled === "refused" || stillOnLogin || !passwordGone) {
    return {
      ok: false,
      reason: stillOnLogin
        ? `Still on ${loginRoute} after submitting. The credentials were not accepted.`
        : `The password field is still on screen after submitting, so the form was not accepted.`,
      pageMessage: await readRefusal(page),
    };
  }

  return { ok: true, evidence: `submitted ${loginRoute} and landed on ${landedOn}` };
}

/**
 * Log in through an API endpoint when recon found one.
 *
 * Preferred where available: it does not depend on any selector, so it cannot
 * break when the form is restyled. The response must actually set a cookie -
 * a 200 that sets nothing is a refusal that happens to be polite.
 */
async function loginViaApi(
  page: Page,
  profile: Profile,
  role: AuthRole,
): Promise<{ ok: boolean; evidence?: string; reason?: string; pageMessage?: string } | null> {
  const api = profile.auth.apiLogin;
  const endpoint = api?.url?.trim();
  if (!endpoint) return null;

  const base = profile.boot.url.replace(/\/$/, "");
  const url = endpoint.startsWith("http") ? endpoint : `${base}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;

  // Recon reports the real field names when it found them. Without a template
  // we send the three common spellings, which an API that ignores unknown keys
  // accepts and a strict one rejects clearly - either way the outcome is
  // checked below rather than assumed.
  const data = api?.bodyTemplate
    ? fillTemplate(api.bodyTemplate, role)
    : { username: role.username, email: role.username, password: role.password };

  // Sent from the page's own context so cookies land in the same jar the
  // storageState is captured from.
  const response = await page.request
    .fetch(url, {
      method: api?.method ?? "POST",
      data,
      failOnStatusCode: false,
    })
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }) as const);

  if ("error" in response) {
    return { ok: false, reason: `API login to ${endpoint} threw: ${response.error}` };
  }

  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `API login to ${endpoint} returned ${response.status()}.`,
      pageMessage: body.slice(0, 300) || undefined,
    };
  }

  const cookies = await page.context().cookies();
  if (!cookies.length) {
    return {
      ok: false,
      reason: `API login to ${endpoint} returned ${response.status()} but set no cookie, so no session exists.`,
    };
  }

  return { ok: true, evidence: `POST ${endpoint} -> ${response.status()}, ${cookies.length} cookie(s)` };
}

export interface EstablishOptions {
  profile: Profile;
  /** Where storageState files are written. Outside the project under test. */
  sessionDir: string;
  /** Restrict to these role keys. Default: every role with a credential. */
  roles?: string[];
  browser?: Browser;
  log?: (line: string) => void;
}

/**
 * Establish and save a session for each role that has a credential.
 *
 * Roles without one are skipped rather than attempted: recon reports them when
 * it could not find a credential, and a login attempt with an empty password is
 * a failed login that looks like a broken application.
 */
export async function establishSessions(opts: EstablishOptions): Promise<SessionResult[]> {
  const log = opts.log ?? (() => {});
  const { profile } = opts;

  // Never contact a host the guard would refuse. Checked here as well as at the
  // run boundary because this module opens a connection of its own.
  const decision = decideGuard(profile);
  if (decision.mode === "aborted") {
    return (profile.auth.roles ?? []).map((role) => ({
      role: role.key,
      ok: false,
      reason: decision.reason,
      durationMs: 0,
    }));
  }

  const wanted = (profile.auth.roles ?? []).filter(
    (role) => !opts.roles?.length || opts.roles.includes(role.key),
  );

  const usable = wanted.filter((role) => role.username && role.password);
  for (const role of wanted) {
    if (!usable.includes(role)) {
      log(`${role.key}: no credential in the profile, so no session can be established`);
    }
  }
  if (!usable.length) return [];

  await mkdir(opts.sessionDir, { recursive: true });

  const browser = opts.browser ?? (await chromium.launch());
  const ownsBrowser = !opts.browser;
  const results: SessionResult[] = [];

  try {
    for (const role of usable) {
      const startedAt = Date.now();
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();

      try {
        const outcome = (await loginViaApi(page, profile, role)) ?? (await loginViaForm(page, profile, role));

        if (!outcome.ok) {
          log(`${role.key}: login failed - ${outcome.reason}`);
          if (outcome.pageMessage) log(`${role.key}: the page said "${outcome.pageMessage}"`);
          results.push({
            role: role.key,
            ok: false,
            reason: outcome.reason,
            pageMessage: outcome.pageMessage,
            durationMs: Date.now() - startedAt,
          });
          continue;
        }

        const statePath = path.join(opts.sessionDir, `${role.key}.json`);
        const state = await context.storageState();
        await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

        const captured = {
          cookies: state.cookies.length,
          origins: state.origins.length,
        };

        // A session that captured nothing is not a session. Saving it would
        // hand every later spec an empty jar that behaves exactly like an
        // anonymous run, and those specs would report the login wall as a bug.
        if (!captured.cookies && !captured.origins) {
          log(`${role.key}: login appeared to work but stored no cookie and no origin state`);
          results.push({
            role: role.key,
            ok: false,
            reason:
              "Login appeared to succeed but nothing was stored, so the session would be " +
              "indistinguishable from an anonymous one.",
            durationMs: Date.now() - startedAt,
          });
          continue;
        }

        log(`${role.key}: ${outcome.evidence} (${captured.cookies} cookie(s))`);
        results.push({
          role: role.key,
          ok: true,
          storageState: statePath,
          evidence: outcome.evidence,
          captured,
          durationMs: Date.now() - startedAt,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`${role.key}: login threw - ${message}`);
        results.push({
          role: role.key,
          ok: false,
          reason: message,
          durationMs: Date.now() - startedAt,
        });
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    if (ownsBrowser) await browser.close().catch(() => {});
  }

  return results;
}

/** Index the successful sessions by role, for handing to the runner. */
export function sessionsByRole(results: SessionResult[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of results) if (r.ok && r.storageState) out[r.role] = r.storageState;
  return out;
}
