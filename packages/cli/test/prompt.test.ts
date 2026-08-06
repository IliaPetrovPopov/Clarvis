import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { checkbox, toggleChoice, type Choice } from "../src/prompt.ts";

/**
 * The keypress loop cannot be tested without a terminal, but the rules can, and
 * the rules are where the behaviour is.
 */

const CHOICES: Choice[] = [
  { value: "recon", label: "PATHFINDER", locked: true },
  { value: "research", label: "DOSSIER" },
  { value: "qa", label: "CRUCIBLE", requires: ["recon"] },
  { value: "delivery", label: "DISPATCH", requires: ["qa"] },
  { value: "release", label: "CLEARANCE", requires: ["qa"] },
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
