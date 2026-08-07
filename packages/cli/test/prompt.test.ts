import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { checkbox, toggleChoice, type Choice } from "../src/prompt.ts";

/**
 * The keypress loop cannot be tested without a terminal, but the rules can, and
 * the rules are where the behaviour is.
 */

const CHOICES: Choice[] = [
  { value: "recon", label: "SCOUT", locked: true },
  { value: "research", label: "ARCHIVE" },
  { value: "qa", label: "PROVER", requires: ["recon"] },
  { value: "delivery", label: "SCRIBE", requires: ["qa"] },
  { value: "release", label: "JUDGE", requires: ["qa"] },
];

const set = (...v: string[]) => new Set(v);

test("turning a team on pulls in what it reads from", () => {
  const next = toggleChoice(CHOICES, set("recon"), "delivery");
  assert.deepEqual([...next].sort(), ["delivery", "qa", "recon"]);
});

test("turning a team off drops whatever depended on it", () => {
  // Leaving delivery selected without qa would be a selection the engine
  // silently corrects later, which reads as the tool ignoring what you clicked.
  const next = toggleChoice(CHOICES, set("recon", "qa", "delivery", "release"), "qa");
  assert.deepEqual([...next].sort(), ["recon"]);
});

test("a locked team cannot be turned off", () => {
  assert.deepEqual([...toggleChoice(CHOICES, set("recon"), "recon")], ["recon"]);
});

test("an unknown value changes nothing", () => {
  assert.deepEqual([...toggleChoice(CHOICES, set("recon"), "nope")], ["recon"]);
});

test("with no terminal it returns the defaults instead of hanging", async () => {
  // A prompt that blocks on a pipe turns a scripted setup into a hang with no
  // output, which is the worst failure a setup step can have.
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;

  const result = await checkbox({
    title: "teams",
    choices: CHOICES,
    selected: ["qa"],
    input,
    output,
  });

  assert.equal(result.usedDefaults, true);
  assert.deepEqual([...result.values].sort(), ["qa", "recon"]);
});

test("locked values are not returned twice", async () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;

  const result = await checkbox({
    title: "teams",
    choices: CHOICES,
    // Already contains the locked one.
    selected: ["recon", "qa"],
    input,
    output,
  });

  assert.equal(result.values.length, new Set(result.values).size);
});

test("a repeatable flag is read as one, not silently ignored", async () => {
  // `--axis` is declared multiple:true so parseArgs always yields an array, and
  // the string accessor returns undefined for arrays. Two commands read it that
  // way and silently fell back to happy-path whatever was passed - so
  // `diff --axis responsive-a11y` compared an axis with no specs and reported
  // "nothing can be compared". A flag ignored without complaint is worse than
  // one that errors.
  const { firstOf } = await import("../src/main.ts");

  assert.equal(firstOf(["responsive-a11y"]), "responsive-a11y");
  assert.equal(firstOf(["visual", "i18n-rtl"]), "visual", "the first wins");
  assert.equal(firstOf("happy-path"), "happy-path", "a plain string still works");

  assert.equal(firstOf(undefined), undefined);
  assert.equal(firstOf([]), undefined);
  assert.equal(firstOf(["   "]), undefined, "whitespace is not a value");
  assert.equal(firstOf([true]), undefined, "a valueless flag is not a value");
});
