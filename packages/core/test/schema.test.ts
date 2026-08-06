import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AXES, MUTATING_AXES, READ_ONLY_AXES } from "../src/types.ts";

/**
 * The schemas are the contract of record, and `types.ts` exists so the UI and
 * the engine share one shape at compile time. Nothing enforces that they agree.
 *
 * These tests do. The failure they prevent is quiet: a value the engine writes
 * that no consumer expects passes every typecheck, because the schema is a JSON
 * file nothing imports.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.resolve(here, "../../../schema");

const load = async (name: string) =>
  JSON.parse(await readFile(path.join(schemaDir, name), "utf8")) as {
    properties: Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[] }> }>;
  };

test("the axis list matches the schema exactly", async () => {
  const finding = await load("finding.schema.json");
  assert.deepEqual([...finding.properties.axis.enum!].sort(), [...AXES].sort());
});

test("every axis is classified as mutating or read-only, and never both", async () => {
  // An axis missing from both lists would be silently dropped by the guard -
  // never run, never reported as skipped.
  for (const axis of AXES) {
    const mutating = MUTATING_AXES.includes(axis);
    const readOnly = READ_ONLY_AXES.includes(axis);
    assert.ok(mutating || readOnly, `${axis} is in neither list, so the guard would drop it`);
    assert.ok(!(mutating && readOnly), `${axis} is in both lists`);
  }
  assert.equal(MUTATING_AXES.length + READ_ONLY_AXES.length, AXES.length);
});

test("the tiers the engine can write are all in the schema", async () => {
  const finding = await load("finding.schema.json");
  // Every tier `decideTier` can return, plus the initial one.
  for (const tier of ["CONFIRMED", "PLAUSIBLE", "QUESTION", "DISCARDED"]) {
    assert.ok(finding.properties.tier.enum!.includes(tier), `${tier} missing from the schema`);
  }
});

test("the oracle types the engine can write are all in the schema", async () => {
  const finding = await load("finding.schema.json");
  const allowed = finding.properties.oracle.properties!.type.enum!;
  // `oracleFor` emits these two; the rest are set by fleets not yet built.
  for (const type of ["acceptance-criteria", "code-intent"]) {
    assert.ok(allowed.includes(type), `${type} missing from the schema`);
  }
});

test("the run statuses the engine can write are all in the schema", async () => {
  const run = await load("run.schema.json");
  for (const status of ["running", "passed", "findings", "blocked", "error", "cancelled"]) {
    assert.ok(run.properties.status.enum!.includes(status), `${status} missing from the schema`);
  }
  for (const mode of ["mutating", "read-only", "aborted"]) {
    assert.ok(
      run.properties.guard.properties!.mode.enum!.includes(mode),
      `guard mode ${mode} missing from the schema`,
    );
  }
});

test("the determinism verdicts triage can write are all in the schema", async () => {
  const finding = await load("finding.schema.json");
  const allowed = finding.properties.determinism!.properties!.verdict.enum!;
  for (const verdict of ["deterministic", "flaky", "not-reproduced"]) {
    assert.ok(allowed.includes(verdict), `${verdict} missing from the schema`);
  }
});
