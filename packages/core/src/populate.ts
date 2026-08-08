import { createHash } from "node:crypto";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { SandboxEvidence } from "./guard.ts";
import type { Profile } from "./types.ts";

/**
 * Filling an empty application with data, through its own interface.
 *
 * A provisioned database is empty. That is the point - it is ours, it holds
 * nothing of anybody's - but an empty application tests almost nothing: lists
 * render their empty state, permissions have nothing to be scoped over, and a
 * workflow that edits a record has no record to edit. So the data has to come
 * from somewhere, and every obvious source is wrong.
 *
 * Not the project's seed script: most projects do not have one, and the ones
 * that do put it behind a build step and a set of assumptions about where it is
 * running. Not a database driver: a record is not a row, and writing one by
 * reading a schema means reproducing every invariant the application enforces
 * and getting one of them wrong. Not the project's own database, ever.
 *
 * So it is made the way a person would make it - by filling in the forms. The
 * application validates it, hashes what needs hashing, sets the tenant key,
 * fires whatever it fires on creation. The data is correct by construction
 * because the only thing that wrote it was the thing that owns the schema.
 *
 * ON WATCHING THIS CLOSELY
 *
 * An agent choosing what to type into a live application is the most dangerous
 * thing in this product, and the danger is not exotic. The first form found on
 * a real page during design was "Forgot Password", whose submit button is
 * "Send Reset Link" - filling that in emails a human being. A "Delete account"
 * button is one accessible name away from a "Create account" one. A payment
 * form takes a card number.
 *
 * So the agent does not get to decide what is safe. It proposes; this module
 * refuses. Every rule below exists because the alternative is a tester that
 * emails somebody's users, empties somebody's list, or types a fixture string
 * into a payment field. The rules are deliberately blunt: a false refusal
 * costs one unpopulated form, and a false acceptance costs something that
 * cannot be taken back.
 */

export const POPULATE_SCHEMA_VERSION = 1 as const;

export interface RecipeField {
  /** The control's accessible name, as the snapshot reported it. */
  label: string;
  kind: "text" | "email" | "number" | "date" | "select" | "checkbox" | "textarea";
  /** What to type. Every text value carries the fixture prefix. */
  value: string;
}

export interface Recipe {
  id: string;
  /** What this makes, in a person's words: "a note", "an exam type". */
  makes: string;
  route: string;
  /** The submit control's accessible name. */
  submit: string;
  fields: RecipeField[];
  /**
   * The form's shape when this recipe was derived.
   *
   * Compared on every later run. A form that has gained a required field, lost
   * one, or renamed one will not accept a recipe written against the old
   * shape - and the failure would look like a broken application rather than a
   * stale recipe. See `fingerprintForm`.
   */
  fingerprint: string;
  /** How many to make. Bounded well below anything that could be mistaken for load. */
  count: number;
}

export interface Refusal {
  makes: string;
  why: string;
}

/* ----------------------------------------------------------- what is refused */

/**
 * Submit controls that must never be pressed.
 *
 * Matched on the accessible name of the button the recipe would click, which
 * is the thing that actually determines what happens. Grouped by what goes
 * wrong, because the groups have genuinely different consequences and a future
 * reader deserves to know which one they are relaxing.
 */
const FORBIDDEN_SUBMITS: Array<{ re: RegExp; why: string }> = [
  {
    // Reaches a real person. Unrecoverable in the only sense that matters:
    // you cannot un-send it, and the recipient is not part of any test.
    re: /\b(send|email|invite|notify|share|resend|reset link|forgot|recover|verify)\b/i,
    why: "would send a message to a real person",
  },
  {
    // Removes something. The application is ours to write to; that is not the
    // same as ours to empty.
    re: /\b(delete|remove|destroy|erase|wipe|clear all|reset|revoke|deactivate|disable|archive|cancel|close account|unsubscribe)\b/i,
    why: "would remove or disable something rather than create it",
  },
  {
    // Money. A fixture string in a payment field is a failed charge at best.
    re: /\b(pay|purchase|buy|checkout|subscribe|upgrade|billing|charge|donate|order)\b/i,
    why: "would attempt a payment",
  },
  {
    // Leaves the application entirely, usually to a third party we have no
    // business driving.
    re: /\b(continue with|sign in with|connect|authorize|oauth|google|github|facebook|apple|stripe)\b/i,
    why: "would hand off to a third party",
  },
  {
    re: /\b(publish|deploy|release|submit for review|go live|approve)\b/i,
    why: "would move something into a state a person is supposed to authorise",
  },
];

/**
 * Fields that must never be filled, whatever the button says.
 *
 * A form is refused entirely if it contains one. Skipping the field and
 * submitting anyway is worse than not submitting: a payment form missing its
 * card number still tells the application a purchase was attempted.
 */
const FORBIDDEN_FIELDS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(card|cvv|cvc|iban|sort code|account number|routing|paypal)\b/i, why: "takes payment details" },
  { re: /\b(ssn|social security|passport|national insurance|tax id)\b/i, why: "takes government identifiers" },
  { re: /\b(upload|attach|file|photo|avatar|document)\b/i, why: "takes a file, which nothing here can supply honestly" },
  {
    /*
      An authentication code, not a code in general.

      "One-time code" slipped through a list that named only otp, 2fa and
      verification code. Broadened to the way these are actually labelled -
      but deliberately not to every field containing "code", because postal,
      country, discount and promo codes are ordinary things a create form asks
      for and refusing them would gut the feature to close a gap they are not
      part of.
    */
    re: /\b(otp|mfa|2fa|two[\s-]?factor|multi[\s-]?factor|authenticator)\b|\b(one[\s-]?time|single[\s-]?use|verification|security|confirmation|sms|auth)[\s-]?code\b/i,
    why: "takes a code only a real second factor can produce",
  },
];

/** Nothing may be created in volumes that could be mistaken for a load test. */
export const MAX_PER_RECIPE = 12;
export const MAX_TOTAL_RECORDS = 60;

/**
 * Decide whether a proposed recipe may run.
 *
 * Entirely code, and deliberately blunt. A false refusal costs one unpopulated
 * form; a false acceptance costs something that cannot be undone.
 */
export function vetRecipe(
  recipe: Recipe,
  opts: { sandbox?: SandboxEvidence; origin?: string } = {},
): { ok: true; recipe: Recipe } | { ok: false; why: string } {
  /*
    A sandbox, always. Not "the guard permits writes" - that can be true
    because somebody marked their development database disposable, and being
    allowed to write there is not a reason to fill it with generated records.
    This only ever runs against a database this process made and will drop.
  */
  if (!opts.sandbox) {
    return {
      ok: false,
      why: "no disposable database was provisioned, and generated data never goes anywhere else",
    };
  }

  for (const { re, why } of FORBIDDEN_SUBMITS) {
    if (re.test(recipe.submit)) return { ok: false, why: `the submit control "${recipe.submit}" ${why}` };
    // The description too: an agent that labels a recipe "delete a note" while
    // naming a harmless-looking button has misunderstood its own proposal.
    if (re.test(recipe.makes)) return { ok: false, why: `"${recipe.makes}" ${why}` };
  }

  for (const field of recipe.fields) {
    for (const { re, why } of FORBIDDEN_FIELDS) {
      if (re.test(field.label)) return { ok: false, why: `the field "${field.label}" ${why}` };
    }
  }

  if (!recipe.fields.length) {
    return { ok: false, why: "a form with no fields to fill is not a create form" };
  }

  // A route on another origin is not this application.
  if (opts.origin && /^https?:\/\//i.test(recipe.route)) {
    try {
      if (new URL(recipe.route).origin !== opts.origin) {
        return { ok: false, why: `${recipe.route} is not on this application's origin` };
      }
    } catch {
      return { ok: false, why: `${recipe.route} is not a usable route` };
    }
  }

  if (recipe.count < 1 || recipe.count > MAX_PER_RECIPE) {
    return { ok: false, why: `count ${recipe.count} is outside 1..${MAX_PER_RECIPE}` };
  }

  /*
    Every text value carries the fixture prefix.

    So that anything left behind can be found by searching for one string, and
    so that a human looking at the application can tell generated data from
    their own at a glance. A value that does not carry it is corrected rather
    than refused - the recipe is otherwise fine and the prefix is not the
    agent's to decide.
  */
  return { ok: true, recipe };
}

/** Apply the fixture prefix to every free-text value. */
export function markAsFixture(recipe: Recipe, prefix: string): Recipe {
  const taggable = new Set(["text", "textarea"]);
  return {
    ...recipe,
    fields: recipe.fields.map((f) =>
      taggable.has(f.kind) && !f.value.startsWith(prefix) ? { ...f, value: `${prefix}${f.value}` } : f,
    ),
  };
}

/* --------------------------------------------------------------- the shape */

/**
 * A stable description of the form a recipe was written against.
 *
 * The requirement it serves: a run some weeks later should regenerate its data
 * and notice if the shape it was generating against has moved. Fingerprinting
 * the FORM rather than the source model is deliberate - the form is what the
 * recipe actually drives, it is observable through the browser exactly as
 * everything else here is, and it needs no parser for whatever ORM the project
 * happens to use.
 *
 * Names and roles only, sorted. Order in the DOM is not part of the shape; a
 * field appearing, vanishing or being renamed is.
 */
export function fingerprintForm(controls: Array<{ role: string; name: string }>): string {
  const shape = controls
    .filter((c) => /textbox|combobox|checkbox|radio|spinbutton|slider|listbox/.test(c.role))
    .map((c) => `${c.role}:${c.name.trim().toLowerCase()}`)
    .sort()
    .join("|");

  return createHash("sha256").update(shape).digest("hex").slice(0, 16);
}

/**
 * Pull the controls out of an accessibility snapshot.
 *
 * Playwright's snapshot is YAML-ish: `- textbox "Email":`. Parsed rather than
 * regex-matched across the whole document so a name containing a quote does
 * not swallow the rest of the line.
 */
export function controlsFrom(snapshot: string): Array<{ role: string; name: string }> {
  const out: Array<{ role: string; name: string }> = [];

  for (const line of snapshot.split("\n")) {
    const match = /^\s*-\s+([a-z]+)\s+"((?:[^"\\]|\\.)*)"/.exec(line);
    if (!match) continue;
    out.push({ role: match[1], name: match[2].replace(/\\"/g, '"') });
  }

  return out;
}

export interface DriftReport {
  changed: boolean;
  /** Recipes whose form no longer looks the way it did. */
  stale: Array<{ makes: string; route: string; was: string; now: string }>;
}

/**
 * Has anything this data was generated against moved?
 *
 * Answered before generating, so a stale recipe is reported as stale rather
 * than failing halfway through and looking like a broken application.
 */
export function detectDrift(
  recipes: Recipe[],
  observed: Map<string, string>,
): DriftReport {
  const stale: DriftReport["stale"] = [];

  for (const recipe of recipes) {
    const now = observed.get(recipe.route);

    // A route that could not be observed is not evidence of change. Reporting
    // it as drift would cry wolf every time a page happened to be slow.
    if (!now) continue;

    /*
      A recipe with no fingerprint has never been run, not drifted.

      It is stamped with what is observed now and used. Treating "unknown" as
      "changed" meant every freshly derived recipe was discarded before it ever
      ran once, so the first run against any project populated nothing - which
      is the opposite of the intent and would have looked like the feature
      simply not working.
    */
    if (!recipe.fingerprint) continue;

    if (now === recipe.fingerprint) continue;
    stale.push({ makes: recipe.makes, route: recipe.route, was: recipe.fingerprint, now });
  }

  return { changed: stale.length > 0, stale };
}

/* ------------------------------------------------------------- execution */

export interface PopulateResult {
  /**
   * The recipes as they now stand, with fingerprints filled in.
   *
   * Returned rather than mutated in place: vetting copies each recipe, so a
   * fingerprint stamped inside was written to a copy the caller never saw.
   * Persisting these is what makes drift detectable on the next run at all -
   * without it every run looks like a first run and nothing is ever compared.
   */
  recipes: Recipe[];
  /** Records actually created, by what they were called. */
  created: Array<{ makes: string; route: string; identifier: string }>;
  refused: Refusal[];
  /** Recipes whose form no longer matches what they were written against. */
  drift: DriftReport;
  failed: Array<{ makes: string; why: string }>;
}

/** Observe a page's form shape, for drift and for filling. */
async function observeForm(page: Page): Promise<Array<{ role: string; name: string }>> {
  const snapshot = await page
    .locator("body")
    .ariaSnapshot({ timeout: 10_000 })
    .catch(() => "");
  return controlsFrom(snapshot);
}

/**
 * Fill one form and confirm something came of it.
 *
 * Verified by outcome, like everything else here: a form that clears itself
 * while rejecting the input looks identical to one that saved, and counting
 * the second as a record created would report data that is not there - which
 * then fails a later assertion as though the application had lost it.
 */
async function createOne(
  page: Page,
  recipe: Recipe,
  base: string,
): Promise<{ ok: boolean; why?: string }> {
  await page.goto(`${base}${recipe.route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  for (const field of recipe.fields) {
    const control =
      field.kind === "select"
        ? page.getByRole("combobox", { name: field.label })
        : field.kind === "checkbox"
          ? page.getByRole("checkbox", { name: field.label })
          : page.getByRole("textbox", { name: field.label });

    const there = await control
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (!there) return { ok: false, why: `no control named "${field.label}" on ${recipe.route}` };

    if (field.kind === "checkbox") await control.first().check().catch(() => {});
    else if (field.kind === "select") await control.first().selectOption({ label: field.value }).catch(() => {});
    else await control.first().fill(field.value);
  }

  const submit = page.getByRole("button", { name: recipe.submit });
  if (!(await submit.first().isVisible().catch(() => false))) {
    return { ok: false, why: `no submit control named "${recipe.submit}"` };
  }

  const before = page.url();
  await submit.first().click();
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  /*
    Two signals, either of which is evidence something happened: the page moved
    on, or the value appears somewhere it did not before. Neither alone is
    conclusive and both together are what an application does when it has
    accepted a record.
  */
  const moved = page.url() !== before;
  const identifier = recipe.fields.find((f) => f.kind === "text" || f.kind === "textarea")?.value;
  const shown = identifier
    ? await page.getByText(identifier, { exact: false }).first().isVisible().catch(() => false)
    : false;

  if (!moved && !shown) {
    return { ok: false, why: `submitted on ${recipe.route} but nothing changed and the value never appeared` };
  }

  return { ok: true };
}

export interface PopulateOptions {
  profile: Profile;
  recipes: Recipe[];
  /** Required. Generated data never goes anywhere else. */
  sandbox?: SandboxEvidence;
  /** Session to work in, so forms behind a login are reachable. */
  storageState?: string;
  browser?: Browser;
  log?: (line: string) => void;
}

/**
 * Fill the application with data, through its own forms.
 *
 * Every recipe is vetted before it is driven, the form is re-observed before
 * anything is typed into it, and each record is confirmed. Nothing here writes
 * to a database directly, and nothing runs at all without a sandbox.
 */
export async function populate(opts: PopulateOptions): Promise<PopulateResult> {
  const log = opts.log ?? (() => {});
  const base = opts.profile.boot.url.replace(/\/$/, "");
  const origin = (() => {
    try {
      return new URL(base).origin;
    } catch {
      return undefined;
    }
  })();

  const created: PopulateResult["created"] = [];
  const refused: Refusal[] = [];
  const failed: PopulateResult["failed"] = [];
  const prefix = opts.profile.data.fixturePrefix ?? "clarvis-";

  const allowed: Recipe[] = [];
  for (const proposal of opts.recipes) {
    const verdict = vetRecipe(proposal, { sandbox: opts.sandbox, origin });
    if (!verdict.ok) {
      refused.push({ makes: proposal.makes, why: verdict.why });
      log(`refused "${proposal.makes}": ${verdict.why}`);
      continue;
    }
    allowed.push(markAsFixture(verdict.recipe, prefix));
  }

  if (!allowed.length) {
    return { recipes: allowed, created, refused, failed, drift: { changed: false, stale: [] } };
  }

  const browser = opts.browser ?? (await chromium.launch());
  const ownsBrowser = !opts.browser;

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    const page = await context.newPage();

    // Observe every form first, so drift is reported before anything is typed
    // rather than discovered halfway through as a failure.
    const observed = new Map<string, string>();
    for (const route of new Set(allowed.map((r) => r.route))) {
      await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      observed.set(route, fingerprintForm(await observeForm(page)));
    }

    const drift = detectDrift(allowed, observed);

    // Stamp the ones that had never been run, so the next run has something to
    // compare against. This is what makes drift detectable at all.
    for (const recipe of allowed) {
      if (!recipe.fingerprint) recipe.fingerprint = observed.get(recipe.route) ?? "";
    }
    for (const stale of drift.stale) {
      log(`the form for "${stale.makes}" at ${stale.route} has changed since this recipe was written`);
    }

    let total = 0;
    for (const recipe of allowed) {
      // A recipe whose form has moved is not driven: filling a changed form
      // with an old recipe produces failures that read as product defects.
      if (drift.stale.some((s) => s.route === recipe.route)) {
        failed.push({ makes: recipe.makes, why: "the form changed since this recipe was written" });
        continue;
      }

      for (let i = 0; i < recipe.count && total < MAX_TOTAL_RECORDS; i++) {
        // Distinct per record, so a unique constraint does not read as a
        // broken form on the second attempt.
        const numbered: Recipe = {
          ...recipe,
          fields: recipe.fields.map((f) =>
            f.kind === "text" || f.kind === "textarea" ? { ...f, value: `${f.value} ${i + 1}` } : f,
          ),
        };

        const outcome = await createOne(page, numbered, base);
        if (outcome.ok) {
          const identifier =
            numbered.fields.find((f) => f.kind === "text" || f.kind === "textarea")?.value ?? recipe.makes;
          created.push({ makes: recipe.makes, route: recipe.route, identifier });
          total++;
        } else {
          failed.push({ makes: recipe.makes, why: outcome.why ?? "unknown" });
          // One failure is a bad recipe, not a transient - stop repeating it.
          break;
        }
      }

      log(`${created.filter((c) => c.makes === recipe.makes).length} x ${recipe.makes}`);
    }

    await context.close().catch(() => {});
    return { recipes: allowed, created, refused, failed, drift };
  } finally {
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}
