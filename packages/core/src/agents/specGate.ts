/**
 * The gate every authored spec passes before it is allowed to run.
 *
 * This is the counterpart to the guard: the guard stops a run touching the wrong
 * target, and this stops a run producing a meaningless green. Both are plain
 * deterministic code for the same reason - they are the checks that must hold
 * even when everything upstream is wrong.
 *
 * The failure it exists for is specific and quiet. An agent asked to test a
 * feature it cannot reach will still produce a file full of `test(...)` blocks,
 * they will all pass, and the report will say the feature works. That reads
 * identically to a thorough run. Every rule below is a shape of test that cannot
 * fail, and a test that cannot fail is worse than no test, because it is
 * counted.
 */

export type GateCode =
  | "no-import"
  | "no-tests"
  | "no-assertions"
  | "vacuous-assertion"
  | "disabled-test"
  | "focused-test"
  | "swallowed-failure"
  | "forbidden-host"
  | "unreported-gap"
  | "reimplemented-actionability"
  | "conditional-assertion";

export interface GateViolation {
  code: GateCode;
  detail: string;
  /** 1-indexed, when the rule is anchored to a line. */
  line?: number;
  /** What the author must do instead. Fed back verbatim on the retry. */
  remedy: string;
}

export interface GateResult {
  ok: boolean;
  violations: GateViolation[];
  /** Non-fatal observations. Recorded on the run, never blocking. */
  warnings: GateViolation[];
  stats: { tests: number; assertions: number };
}

/** Strip strings and comments so a rule cannot fire on prose about itself. */
function decommented(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/**
 * Assertions whose outcome does not depend on the application.
 *
 * Matching is on the argument shape rather than on a blocklist of phrasings,
 * because the failure mode is an agent reaching for *any* self-satisfying
 * assertion when it cannot work out how to test the real thing.
 */
const VACUOUS = [
  { re: /expect\s*\(\s*(true|false|1|0|null|undefined)\s*\)/g, why: "asserts on a literal" },
  { re: /expect\s*\(\s*\)/g, why: "asserts on nothing" },
  { re: /expect\s*\(\s*(['"`])[^'"`]*\1\s*\)\s*\.\s*toBe(Truthy|Defined)\s*\(/g, why: "asserts a literal string is truthy" },
  {
    re: /expect\s*\([^;]{0,200}?\)\s*\.\s*toBeDefined\s*\(\s*\)/g,
    why: "toBeDefined alone passes for almost any value, including the wrong one",
  },
  { re: /expect\s*\(\s*(\d+)\s*\)\s*\.\s*toBe\s*\(\s*\1\s*\)/g, why: "compares a number to itself" },
];

const DISABLED = /\btest\s*\.\s*(skip|fixme)\s*\(/g;
const FOCUSED = /\b(test|describe)\s*\.\s*only\s*\(/g;
const TEST_BLOCK = /\btest\s*\(\s*['"`]/g;
const ASSERTION = /\bexpect\s*\(/g;

/** `catch { }` or a catch whose body contains no assertion and no rethrow. */
const SWALLOWED = /catch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g;

/**
 * An assertion reached only when a condition holds is an assertion that can be
 * skipped at runtime, which makes the test unfalsifiable in exactly the cases
 * that matter. Flagged rather than rejected: guarding on a legitimately optional
 * element is sometimes correct, and a warning keeps that judgement with a human.
 */
// The condition itself routinely contains parentheses (`if (await x.isVisible())`),
// so the span is bounded by length rather than by a naive "no closing paren".
const CONDITIONAL = /\bif\s*\([\s\S]{0,200}?\)\s*\{[\s\S]{0,300}?\bexpect\s*\(/g;

/**
 * Prose in the file admitting something was left out.
 *
 * A live run produced an adversarial spec whose header explained, correctly and
 * at length, why the stored-XSS case could not be tested - and left the
 * "untested" field empty. The run therefore reported that axis as fully covered.
 * A gap that exists only in a comment is invisible to everything downstream,
 * which makes it worse than no gap at all.
 */
const ADMITS_GAP =
  /\b(see\s+`?untested`?|left\s+out|not\s+tested|could\s+not\s+test|cannot\s+be\s+tested|omitted|out\s+of\s+scope)\b/i;

/**
 * A hand-rolled version of something Playwright already does.
 *
 * `elementFromPoint` against a `boundingBox()` is the specific one that cost a
 * run: box coordinates are page-relative, `elementFromPoint` takes
 * viewport-relative, the check runs once against a page that may still be
 * settling, and it reported a working login form as covered on a page where
 * `click({ trial: true })` succeeded. Six failures, all about the test.
 *
 * A prompt asking for restraint is not enough here, because the reimplementation
 * looks more rigorous than the built-in and an author reaches for it precisely
 * when being careful.
 */
const REIMPLEMENTED = [
  {
    re: /elementFromPoint\s*\(/,
    what: "elementFromPoint",
    instead: "expect(locator).toBeVisible() and click({ trial: true }) - both handle overlap already",
  },
  {
    re: /\.offsetParent\s*[=!]==?\s*null/,
    what: "an offsetParent null check",
    instead: "expect(locator).toBeVisible(), which knows about every way an element can be hidden",
  },
  {
    re: /getComputedStyle\([^)]*\)\s*\.\s*(visibility|display|opacity|pointerEvents)/,
    what: "a computed-style visibility check",
    instead: "expect(locator).toBeVisible()",
  },
  {
    re: /\bz-?index\b[\s\S]{0,40}(>|<|compare)/i,
    what: "a z-index comparison",
    instead: "click({ trial: true }), which fails if anything intercepts the pointer",
  },
];

export function gateSpec(
  source: string,
  opts: { forbiddenHosts?: string[]; axis?: string; reportedUntested?: number } = {},
): GateResult {
  const violations: GateViolation[] = [];
  const warnings: GateViolation[] = [];
  const code = decommented(source);

  const tests = [...code.matchAll(TEST_BLOCK)];
  const assertions = [...code.matchAll(ASSERTION)];

  if (!/from\s+['"]@playwright\/test['"]/.test(code)) {
    violations.push({
      code: "no-import",
      detail: "The spec does not import from @playwright/test.",
      remedy: `Start with: import { test, expect } from "@playwright/test";`,
    });
  }

  if (tests.length === 0) {
    violations.push({
      code: "no-tests",
      detail: "The file contains no test() blocks.",
      remedy: "Return a file with at least one test(name, async ({ page }) => { ... }) block.",
    });
  }

  if (assertions.length === 0) {
    violations.push({
      code: "no-assertions",
      detail: "The file contains no expect() calls, so nothing can fail.",
      remedy:
        "Assert on what the requirement actually says. A test with no assertion is counted as a pass " +
        "and reports the feature as working.",
    });
  }

  for (const { re, why } of VACUOUS) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      violations.push({
        code: "vacuous-assertion",
        detail: `Assertion ${why}: ${m[0].trim().slice(0, 60)}`,
        line: lineOf(code, m.index ?? 0),
        remedy:
          "Assert against the application's actual state - a response status, visible text, a URL, " +
          "an attribute. If you cannot reach the behaviour, say so instead of writing an assertion " +
          "that always holds.",
      });
    }
  }

  for (const m of code.matchAll(DISABLED)) {
    violations.push({
      code: "disabled-test",
      detail: `Disabled test: ${m[0].trim()}`,
      line: lineOf(code, m.index ?? 0),
      remedy:
        "Do not ship a skipped test. It is reported as skipped, not as a pass, but it wastes the " +
        "slot. Report what blocked you instead.",
    });
  }

  for (const m of code.matchAll(FOCUSED)) {
    violations.push({
      code: "focused-test",
      detail: `Focused test: ${m[0].trim()}`,
      line: lineOf(code, m.index ?? 0),
      remedy: "Remove .only - it silently drops every other test in the file from the run.",
    });
  }

  for (const m of code.matchAll(SWALLOWED)) {
    const body = m[1] ?? "";
    if (/\b(expect|throw|reject)\b/.test(body)) continue;
    violations.push({
      code: "swallowed-failure",
      detail: "A catch block discards the error without asserting or rethrowing.",
      line: lineOf(code, m.index ?? 0),
      remedy:
        "Let the failure surface, or assert on it. A swallowed error turns a broken app into a " +
        "passing test.",
    });
  }

  for (const m of code.matchAll(CONDITIONAL)) {
    warnings.push({
      code: "conditional-assertion",
      detail: "An assertion is inside an if block, so it may never execute.",
      line: lineOf(code, m.index ?? 0),
      remedy:
        "Prefer asserting the condition itself. If the element is genuinely optional, say so in the " +
        "test name so a human reading the report knows what was and was not checked.",
    });
  }

  // The guard already refuses a forbidden target, but a spec can name a host
  // directly and bypass the configured baseURL entirely.
  for (const host of opts.forbiddenHosts ?? []) {
    const bare = host.replace(/\*/g, "").toLowerCase();
    if (bare.length < 4) continue;
    const at = code.toLowerCase().indexOf(bare);
    if (at === -1) continue;
    violations.push({
      code: "forbidden-host",
      detail: `The spec references "${bare}", which is on the deny-list.`,
      line: lineOf(code, at),
      remedy:
        "Use relative paths so requests go to the configured baseURL. Never name a host in a spec.",
    });
  }

  for (const { re, what, instead } of REIMPLEMENTED) {
    const match = re.exec(code);
    if (!match) continue;
    violations.push({
      code: "reimplemented-actionability",
      detail: `Uses ${what} to decide whether a control is usable.`,
      line: lineOf(code, match.index),
      remedy:
        `Playwright already answers this, correctly and with retries. Use ${instead}. ` +
        `A hand-written check runs once, against a page that may still be settling, and reports ` +
        `a working control as broken.`,
    });
  }

  // Deliberately checked against the RAW source: the admission is usually in a
  // comment, which is exactly the place it does not count.
  if (opts.reportedUntested === 0 && ADMITS_GAP.test(source)) {
    violations.push({
      code: "unreported-gap",
      detail:
        "The file says something was left untested, but the 'untested' field is empty, so the run " +
        "will report this axis as fully covered.",
      remedy:
        "Put every gap in the 'untested' array with its reason. A comment is not read by anything " +
        "downstream - the report, the release gate and the briefing all read that field. Reporting " +
        "the gap costs you nothing; hiding it makes the whole run untrustworthy.",
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    stats: { tests: tests.length, assertions: assertions.length },
  };
}

/** The gate's complaints, phrased for the author agent's retry. */
export function describeViolations(violations: GateViolation[]): string {
  return violations
    .map((v, i) => `${i + 1}. [${v.code}]${v.line ? ` line ${v.line}:` : ""} ${v.detail}\n   ${v.remedy}`)
    .join("\n");
}
