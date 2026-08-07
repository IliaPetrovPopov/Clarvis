import { chromium, type Browser, type Page } from "@playwright/test";
import { decideGuard, type SandboxEvidence } from "./guard.ts";
import { IDENTITY_SELECTORS } from "./session.ts";
import type { AuthRole, Profile } from "./types.ts";

/**
 * Make an account, when the project did not leave one lying around.
 *
 * Recon looks for credentials in seed files and fixtures, which is the right
 * first move and often works. When it does not - and on a real application it
 * frequently does not - every route behind a login is untestable, and the run
 * reports honestly that it only ever saw the anonymous half of the product.
 * Provisioning a database made that worse rather than better: a fresh database
 * is empty, so the sandbox that was supposed to unlock the mutating axes
 * handed the fleet an application with no users at all.
 *
 * So: register one, the way a person would.
 *
 * NOT BY WRITING TO THE DATABASE
 *
 * The obvious approach is to read the models - they are right there in the
 * source - and insert a row. It is the wrong one, for the same reason seeding
 * through the application beats seeding through a driver: a user is not a row.
 * It is a row plus a hash with the right cost factor, plus a tenant key, plus
 * whatever the application does on creation - a default workspace, a welcome
 * record, a search index entry. Reproducing that by reading a schema means
 * reproducing every invariant by hand, and getting one wrong produces an
 * account that exists but cannot do anything, which then fails tests in ways
 * that look like product defects.
 *
 * The signup form already knows all of it. It is also the one path that works
 * without knowing anything about the stack.
 *
 * WHAT THIS CANNOT DO
 *
 * Signup grants whatever role signup grants, which is the lowest one. An admin
 * cannot be made this way, and the honest thing is to say so rather than to
 * guess at an elevation route and quietly test the wrong thing. A run that
 * enrolled a plain member says exactly that, and every role above it stays
 * reported as untested.
 */

export interface EnrolResult {
  ok: boolean;
  role?: AuthRole;
  /** Where the account was made, for the record. */
  via?: string;
  reason?: string;
  /** What the page said when it refused. */
  pageMessage?: string;
}

/** Routes that are plausibly a signup, most likely first. */
const SIGNUP_PATHS = ["/register", "/signup", "/sign-up", "/join", "/get-started", "/create-account"];

const PASSWORD = 'input[type="password"]';

const EMAIL_SELECTORS = [
  'input[autocomplete="email"]',
  'input[type="email"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
];

const NAME_SELECTORS = [
  'input[autocomplete="name"]',
  'input[autocomplete="given-name"]',
  'input[name*="name" i]:not([name*="user" i])',
  'input[id*="name" i]',
];

const SUBMITS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Sign up")',
  'button:has-text("Create account")',
  'button:has-text("Register")',
  'button:has-text("Get started")',
  'button:has-text("Continue")',
];

const REFUSAL = /invalid|incorrect|already|taken|exists|failed|required|must be|too short|does not match/i;

async function firstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function readRefusal(page: Page): Promise<string | undefined> {
  for (const selector of ['[role="alert"]', ".error", '[class*="error" i]']) {
    const text = await page.locator(selector).first().innerText({ timeout: 800 }).catch(() => "");
    if (text?.trim()) return text.trim().slice(0, 240);
  }
  const body = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
  return body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && REFUSAL.test(l))
    ?.slice(0, 240);
}

/**
 * An identity that is obviously ours and obviously disposable.
 *
 * The fixture prefix so a sweep can find it, and a random tail so a second run
 * against a database that survived the first does not collide with an account
 * it made earlier - which would look like a broken signup form rather than the
 * duplicate it is.
 */
export function generateIdentity(profile: Profile, seed = Math.random()): AuthRole {
  const prefix = (profile.data.fixturePrefix ?? "clarvis-").replace(/[^a-z0-9-]/gi, "");
  const tail = Math.floor(seed * 1e9).toString(36);
  return {
    key: "enrolled",
    label: "created by Clarvis at run time",
    username: `${prefix}${tail}@example.invalid`,
    // Long, mixed, and with a symbol: password policies vary and a rejection
    // for weakness reads as a broken form.
    password: `Clarvis-${tail}-Aa1!`,
  };
}

/** Candidate signup routes, the mapped surface first. */
function signupCandidates(profile: Profile): string[] {
  const mapped = (profile.surface?.routes ?? [])
    .map((r) => r.visitPath ?? r.path)
    .filter((p): p is string => Boolean(p))
    .filter((p) => SIGNUP_PATHS.some((s) => p.toLowerCase().endsWith(s)));

  return [...new Set([...mapped, ...SIGNUP_PATHS])];
}

export interface EnrolOptions {
  profile: Profile;
  /** Present when a database was provisioned for this run. */
  sandbox?: SandboxEvidence;
  browser?: Browser;
  log?: (line: string) => void;
  /** Deterministic identity, for tests. */
  seed?: number;
}

/**
 * Create an account and prove it can log in.
 *
 * Verified by logging in with it afterwards rather than by the form appearing
 * to submit. A signup that returns you to a dashboard but leaves the account
 * unconfirmed produces a credential that works once and never again, and a
 * session built on it fails later in a way that looks like the application
 * logging people out.
 */
export async function enrolRole(opts: EnrolOptions): Promise<EnrolResult> {
  const log = opts.log ?? (() => {});
  const { profile } = opts;

  // Creating an account is a write. Whatever the reason for wanting one, the
  // guard decides whether this application may be written to at all.
  const decision = decideGuard(profile, undefined, opts.sandbox);
  if (decision.mode !== "mutating") {
    return {
      ok: false,
      reason:
        `Cannot create an account: the guard is in ${decision.mode} mode. ${decision.reason} ` +
        `Every route behind a login stays untested.`,
    };
  }

  const identity = generateIdentity(profile, opts.seed);
  const base = profile.boot.url.replace(/\/$/, "");
  const browser = opts.browser ?? (await chromium.launch());
  const ownsBrowser = !opts.browser;

  try {
    for (const route of signupCandidates(profile)) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();

      try {
        const response = await page.goto(`${base}${route}`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        if (response && response.status() >= 400) continue;

        // A signup form is a password field plus an email field. Waited for,
        // not asked about: on a client-rendered page the form does not exist
        // at domcontentloaded, and `isVisible` never waits.
        const appeared = await page
          .locator(PASSWORD)
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        if (!appeared) continue;

        const email = await firstVisible(page, EMAIL_SELECTORS);
        if (!email) continue;

        log(`registering at ${route}`);
        await email.fill(identity.username);

        const name = await firstVisible(page, NAME_SELECTORS);
        if (name) await name.fill("Clarvis Tester");

        // Every password field, so a confirmation gets the same value. A form
        // that disagrees with itself refuses for a reason nobody can see.
        const passwords = page.locator(PASSWORD);
        const count = await passwords.count();
        for (let i = 0; i < count; i++) await passwords.nth(i).fill(identity.password);

        // Terms checkboxes are the usual silent blocker.
        const boxes = page.locator('input[type="checkbox"]');
        for (let i = 0; i < (await boxes.count()); i++) {
          await boxes.nth(i).check().catch(() => {});
        }

        const submit = await firstVisible(page, SUBMITS);
        if (submit) await submit.click();
        else await passwords.first().press("Enter");

        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

        const refusal = await readRefusal(page);
        await context.close().catch(() => {});

        /*
          Proven by logging in, not by the form going away.

          A signup can land on a dashboard while leaving the account
          unverified, which yields a credential that works for one session and
          never again - and a run built on it fails later in a way that looks
          like the application logging people out.
        */
        const works = await canLogIn(browser, profile, identity);
        if (works) {
          log(`created ${identity.username} and confirmed it can log in`);
          return { ok: true, role: identity, via: route };
        }

        return {
          ok: false,
          reason:
            `Registered at ${route} but the new account could not log in. It may need email ` +
            `confirmation, which nothing here can complete.`,
          pageMessage: refusal,
        };
      } catch {
        await context.close().catch(() => {});
      }
    }

    return {
      ok: false,
      reason:
        `No signup form was found. Tried ${signupCandidates(profile).slice(0, 4).join(", ")}. ` +
        `Without a credential every route behind a login stays untested.`,
    };
  } finally {
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}

/** Log in with a credential and confirm a session actually results. */
async function canLogIn(browser: Browser, profile: Profile, role: AuthRole): Promise<boolean> {
  const loginPath = profile.auth.loginUrl?.trim() || "/login";
  const base = profile.boot.url.replace(/\/$/, "");
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  try {
    const page = await context.newPage();
    await page.goto(`${base}${loginPath}`, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const password = page.locator(PASSWORD).first();
    const there = await password
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!there) return false;

    // The same rule the session layer logs in by, imported rather than
    // restated. A shorter list here meant enrolment created a real account and
    // then reported it could not log in - the field was found by one copy of
    // the rules and missed by the other.
    const email = await firstVisible(page, IDENTITY_SELECTORS);
    if (!email) return false;

    await email.fill(role.username);
    await password.fill(role.password);

    const submit = await firstVisible(page, SUBMITS);
    if (submit) await submit.click();
    else await password.press("Enter");

    await page
      .locator(PASSWORD)
      .first()
      .waitFor({ state: "hidden", timeout: 30_000 })
      .catch(() => {});

    const landed = new URL(page.url()).pathname.replace(/\/$/, "");
    const stillOnLogin = landed === loginPath.replace(/\/$/, "");
    const cookies = await context.cookies();

    // A session, not merely a redirect: some applications bounce you off the
    // login page without having authenticated anything.
    return !stillOnLogin && cookies.length > 0;
  } catch {
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}
