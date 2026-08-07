import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Point the store at a throwaway directory, from inside the test.
 *
 * `pnpm test` already sets CLARVIS_HOME, and for a long time that was taken as
 * sufficient. It is not: the isolation belonged to the command rather than to
 * the tests, so running a file directly - `node --test test/store.test.ts`,
 * which is what an editor's run button does and what anyone debugging one test
 * types - wrote into the real `~/.clarvis`. Fifty-eight abandoned project
 * directories accumulated there before anyone noticed, because nothing about
 * the failure is visible: the tests pass either way.
 *
 * Setting it here makes isolation a property of the test rather than of how it
 * was launched. An existing value is respected, so the package script and CI
 * still choose the location.
 *
 * Import this FIRST in any test that touches the store, before the module
 * under test - `clarvisHome()` reads the environment when it is called, and a
 * module that resolves a path at import time would already have read it.
 */
if (!process.env.CLARVIS_HOME?.trim()) {
  process.env.CLARVIS_HOME = mkdtempSync(path.join(tmpdir(), "clarvis-test-home-"));
}

export const TEST_HOME = process.env.CLARVIS_HOME;
