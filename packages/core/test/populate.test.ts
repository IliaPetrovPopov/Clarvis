// Must come first: it points the store at a temp directory before any
// module under test resolves a path from it.
import "./isolate.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  controlsFrom,
  detectDrift,
  fingerprintForm,
  markAsFixture,
  vetRecipe,
  MAX_PER_RECIPE,
  type Recipe,
} from "../src/populate.ts";
import type { SandboxEvidence } from "../src/guard.ts";

/**
 * An agent choosing what to type into a live application is the most dangerous
 * thing in this product. These are the refusals, and every one of them is a
 * thing that actually appears on real pages - the first form found on a real
 * application while designing this was "Forgot Password", whose submit button
 * is "Send Reset Link".
 */

const SANDBOX: SandboxEvidence = {
  provisionedBy: "in-process",
  uri: "mongodb://127.0.0.1:51000/app_clarvis_sbx_1",
  evidence: "a mongod started by this run",
};

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  id: "r1",
  makes: "a note",
  route: "/notes/new",
  submit: "Create note",
  fields: [{ label: "Title", kind: "text", value: "Quarterly review" }],
  fingerprint: "abc123",
  count: 3,
  ...over,
});

test("a form that would reach a real person is refused", () => {
  // The one that matters most. You cannot un-send an email, and the recipient
  // is not part of anybody's test.
  for (const submit of [
    "Send Reset Link",
    "Email invite",
    "Invite teammate",
    "Notify subscribers",
    "Share with team",
    "Resend confirmation",
    "Verify email",
  ]) {
    const verdict = vetRecipe(recipe({ submit }), { sandbox: SANDBOX });
    assert.equal(verdict.ok, false, `should have refused: "${submit}"`);
    if (!verdict.ok) assert.match(verdict.why, /real person/);
  }
});

test("a form that removes something is refused", () => {
  // The application is ours to write to. That is not the same as ours to empty.
  for (const submit of [
    "Delete account",
    "Remove member",
    "Reset workspace",
    "Deactivate",
    "Clear all",
    "Cancel subscription",
    "Revoke access",
  ]) {
    const verdict = vetRecipe(recipe({ submit }), { sandbox: SANDBOX });
    assert.equal(verdict.ok, false, `should have refused: "${submit}"`);
  }
});

test("a form that spends money is refused", () => {
  for (const submit of ["Pay now", "Complete purchase", "Subscribe", "Upgrade plan", "Checkout"]) {
    const verdict = vetRecipe(recipe({ submit }), { sandbox: SANDBOX });
    assert.equal(verdict.ok, false, `should have refused: "${submit}"`);
  }
});

test("a form that hands off to somebody else is refused", () => {
  for (const submit of ["Continue with Google", "Sign in with GitHub", "Connect Stripe", "Authorize"]) {
    const verdict = vetRecipe(recipe({ submit }), { sandbox: SANDBOX });
    assert.equal(verdict.ok, false, `should have refused: "${submit}"`);
  }
});

test("a sensitive field refuses the whole form, not just the field", () => {
  /*
    Skipping the field and submitting anyway is worse than not submitting: a
    payment form missing its card number still tells the application that a
    purchase was attempted.
  */
  for (const label of ["Card number", "CVV", "IBAN", "Social security number", "Upload avatar", "One-time code"]) {
    const verdict = vetRecipe(
      recipe({ fields: [{ label, kind: "text", value: "x" }] }),
      { sandbox: SANDBOX },
    );
    assert.equal(verdict.ok, false, `should have refused a form containing "${label}"`);
  }
});

test("an agent that mislabels its own proposal is still caught", () => {
  // A recipe described as deleting something, with an innocuous button name.
  const verdict = vetRecipe(recipe({ makes: "delete a note", submit: "Confirm" }), { sandbox: SANDBOX });
  assert.equal(verdict.ok, false);
});

test("nothing is created without a database of our own", () => {
  /*
    Not "the guard permits writes". That can be true because somebody marked
    their development database disposable, and being allowed to write there is
    not a reason to fill it with generated records.
  */
  const verdict = vetRecipe(recipe(), {});
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.why, /disposable database/);
});

test("a route on another origin is not this application", () => {
  const verdict = vetRecipe(recipe({ route: "https://accounts.google.com/signup" }), {
    sandbox: SANDBOX,
    origin: "http://localhost:3000",
  });
  assert.equal(verdict.ok, false);
});

test("volume is bounded well below anything resembling load", () => {
  assert.equal(vetRecipe(recipe({ count: MAX_PER_RECIPE + 1 }), { sandbox: SANDBOX }).ok, false);
  assert.equal(vetRecipe(recipe({ count: 0 }), { sandbox: SANDBOX }).ok, false);
  assert.equal(vetRecipe(recipe({ count: MAX_PER_RECIPE }), { sandbox: SANDBOX }).ok, true);
});

test("an ordinary create form is allowed", () => {
  // The refusals must not be so broad that nothing survives them.
  const verdict = vetRecipe(
    recipe({
      makes: "a note",
      submit: "Create note",
      fields: [
        { label: "Title", kind: "text", value: "Quarterly review" },
        { label: "Body", kind: "textarea", value: "Some content" },
      ],
    }),
    { sandbox: SANDBOX, origin: "http://localhost:3000" },
  );
  assert.equal(verdict.ok, true);
});

test("every free-text value carries the fixture prefix", () => {
  // So anything left behind is findable by one search, and a person looking at
  // the application can tell generated data from their own at a glance.
  const marked = markAsFixture(
    recipe({
      fields: [
        { label: "Title", kind: "text", value: "Quarterly review" },
        { label: "Count", kind: "number", value: "7" },
      ],
    }),
    "clarvis-",
  );

  assert.equal(marked.fields[0].value, "clarvis-Quarterly review");
  assert.equal(marked.fields[1].value, "7", "a number must stay a number");
});

/* ------------------------------------------------------------------ drift */

test("the shape is the fields, not their order", () => {
  const a = fingerprintForm([
    { role: "textbox", name: "Title" },
    { role: "textbox", name: "Body" },
  ]);
  const b = fingerprintForm([
    { role: "textbox", name: "Body" },
    { role: "textbox", name: "Title" },
  ]);
  assert.equal(a, b, "reordering a form does not change what a recipe must fill");

  const withExtra = fingerprintForm([
    { role: "textbox", name: "Title" },
    { role: "textbox", name: "Body" },
    { role: "combobox", name: "Category" },
  ]);
  assert.notEqual(a, withExtra, "a new field does change it");
});

test("buttons and headings are not part of the shape", () => {
  // Renaming a submit button does not change what the form asks for.
  const a = fingerprintForm([
    { role: "textbox", name: "Title" },
    { role: "button", name: "Create" },
  ]);
  const b = fingerprintForm([
    { role: "textbox", name: "Title" },
    { role: "button", name: "Save" },
    { role: "heading", name: "New note" },
  ]);
  assert.equal(a, b);
});

test("a changed form is reported before anything is generated against it", () => {
  /*
    Answered before generating, so a stale recipe reads as stale rather than
    failing halfway through and looking like a broken application.
  */
  const recipes = [recipe({ route: "/notes/new", fingerprint: "old" })];

  const drifted = detectDrift(recipes, new Map([["/notes/new", "new"]]));
  assert.equal(drifted.changed, true);
  assert.equal(drifted.stale[0].makes, "a note");

  const unchanged = detectDrift(recipes, new Map([["/notes/new", "old"]]));
  assert.equal(unchanged.changed, false);
});

test("a page that could not be observed is not evidence of change", () => {
  // Otherwise a slow page cries wolf on every run.
  const drifted = detectDrift([recipe({ fingerprint: "old" })], new Map());
  assert.equal(drifted.changed, false);
});

/* --------------------------------------------------------------- parsing */

test("controls are read out of a real accessibility snapshot", () => {
  // The shape Playwright actually emits, taken from a live application.
  const snapshot = `- banner:
  - link "Lumira":
    - img "Lumira"
  - heading "Forgot Password" [level=1]
  - textbox "Email":
  - button "Send Reset Link"`;

  const controls = controlsFrom(snapshot);
  assert.deepEqual(
    controls.filter((c) => c.role === "textbox"),
    [{ role: "textbox", name: "Email" }],
  );
  assert.ok(controls.some((c) => c.role === "button" && c.name === "Send Reset Link"));
});

test("a quote inside an accessible name does not swallow the line", () => {
  const controls = controlsFrom('- textbox "The \\"big\\" one":\n- button "Save"');
  assert.equal(controls[0].name, 'The "big" one');
  assert.equal(controls[1].name, "Save");
});
