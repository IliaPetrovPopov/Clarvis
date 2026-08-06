import path from "node:path";

/**
 * Mutation testing: measuring whether the generated specs can actually catch
 * anything.
 *
 * Every other number this product reports is a bug count, and a bug count is a
 * proxy. It depends on which bugs happen to be present, which is not a property
 * of the tester. Mutation testing removes that dependency: break the code in a
 * small, specific way and see whether the suite notices. The kill rate is a
 * direct measurement of the specs, on any codebase, with no seeded bugs and no
 * answer key to write.
 *
 * That matters here more than usual, because the seeded-bug benchmark is
 * evidence I authored on both sides - I wrote the bugs and the axes that look
 * for them. This is the number that does not have that problem.
 *
 * SAFETY, which is the whole difficulty. This deliberately writes to the
 * project's own source files, so every guarantee is structural rather than
 * careful:
 *
 *   - It refuses outside a git repository. Without git there is no independent
 *     way to prove a file came back.
 *   - It refuses to touch a file with uncommitted changes, because a mutation
 *     and someone's unsaved work are indistinguishable once written.
 *   - It restores in a `finally`, then RE-READS and compares. A restore that
 *     silently failed would leave corrupted source behind, which is far worse
 *     than any bug this could ever find.
 *   - One file at a time. Never a second mutation while one is live.
 */

export interface Mutant {
  id: string;
  file: string;
  /** 1-indexed. */
  line: number;
  operator: MutationOperator;
  before: string;
  after: string;
  /** The line with the change applied, for the report. */
  preview: string;
}

export type MutationOperator =
  | "conditional-boundary"
  | "negate-condition"
  | "logical-operator"
  | "boolean-literal"
  | "arithmetic-operator"
  | "return-value";

export type MutantOutcome = "killed" | "survived" | "not-run" | "error";

export interface MutantResult {
  mutant: Mutant;
  outcome: MutantOutcome;
  /** Which spec noticed, when one did. */
  killedBy?: string;
  note?: string;
}

export interface MutationScore {
  total: number;
  killed: number;
  survived: number;
  notRun: number;
  errored: number;
  /** killed / (killed + survived). Undefined when nothing ran. */
  killRate?: number;
  results: MutantResult[];
  /** Files skipped and why. Never silent - a skipped file is unmeasured code. */
  skipped: Array<{ file: string; why: string }>;
}

/* ------------------------------------------------------------- operators */

interface Rule {
  operator: MutationOperator;
  /** Must be global. Capture group 1 is the token replaced. */
  pattern: RegExp;
  replace: (matched: string) => string | undefined;
}

/**
 * Classic operators, chosen because each produces a program that is still
 * syntactically valid and semantically different. An operator that breaks the
 * parse would be killed by every suite for the wrong reason and would inflate
 * the score.
 */
const RULES: Rule[] = [
  {
    operator: "conditional-boundary",
    // Never the `>` of an arrow function, a generic, or a JSX tag. Mutating
    // `(u) => x` into `(u) =>= x` produces a file that does not parse, and a
    // mutant that cannot compile is killed by everything for the wrong reason.
    pattern: /(?<![=!<>+\-*/%&|^~])(<=|>=|<|>)(?![=>])/g,
    replace: (m) => ({ "<": "<=", "<=": "<", ">": ">=", ">=": ">" })[m],
  },
  {
    operator: "negate-condition",
    pattern: /(===|!==|==|!=)/g,
    replace: (m) => ({ "===": "!==", "!==": "===", "==": "!=", "!=": "==" })[m],
  },
  {
    operator: "logical-operator",
    pattern: /(&&|\|\|)/g,
    replace: (m) => (m === "&&" ? "||" : "&&"),
  },
  {
    operator: "boolean-literal",
    pattern: /\b(true|false)\b/g,
    replace: (m) => (m === "true" ? "false" : "true"),
  },
  {
    operator: "arithmetic-operator",
    // Only between spaces: catches `a + b` while avoiding `++`, `+=` and unary.
    pattern: /(?<=\S )(\+|-)(?= \S)/g,
    replace: (m) => (m === "+" ? "-" : "+"),
  },
  {
    operator: "return-value",
    pattern: /\breturn (true|false|null|0)\b/g,
    replace: (m) => {
      const value = m.slice("return ".length);
      return `return ${{ true: "false", false: "true", null: "undefined", "0": "1" }[value]}`;
    },
  },
];

/**
 * Positions that are real code: not inside a string, template literal, regex or
 * comment.
 *
 * Mutating inside a string changes a message rather than a behaviour, so the
 * mutant is unkillable by design and drags the score down for no reason. This
 * is a scanner rather than a parser - it does not need to understand the code,
 * only to know where the code is not.
 */
type Frame = { kind: "template" } | { kind: "interp"; braces: number };

export function codeMask(source: string): boolean[] {
  const mask = new Array<boolean>(source.length).fill(true);

  const hide = (from: number, to: number) => {
    for (let j = from; j < to && j < mask.length; j++) mask[j] = false;
  };

  /**
   * Template literals nest, and the two states inside one are different: the
   * TEXT is a string, while a `${...}` INTERPOLATION is real code that may open
   * another template.
   *
   * An earlier version kept one stack entry for both, so an inner template's
   * closing backtick popped the outer frame and everything after it was scanned
   * as code. That is how `<nav>` inside a template got mutated to `<=nav>`.
   * Distinct frame kinds are what keep the two in step.
   */
  const stack: Frame[] = [];
  let i = 0;

  // Mask template text until the template closes or an interpolation opens.
  const scanTemplateText = (from: number): number => {
    let j = from;
    while (j < source.length) {
      if (source[j] === "\\") {
        hide(j, j + 2);
        j += 2;
        continue;
      }
      if (source[j] === "$" && source[j + 1] === "{") {
        hide(j, j + 2);
        stack.push({ kind: "interp", braces: 0 });
        return j + 2;
      }
      if (source[j] === "`") {
        hide(j, j + 1);
        stack.pop(); // the template frame
        return j + 1;
      }
      hide(j, j + 1);
      j++;
    }
    return j;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    const top = stack[stack.length - 1];

    // A `}` that closes an interpolation returns to the enclosing template text.
    if (top?.kind === "interp" && ch === "}" && top.braces === 0) {
      stack.pop();
      hide(i, i + 1);
      i = scanTemplateText(i + 1);
      continue;
    }

    // Braces inside an interpolation - an object literal, a block - must not be
    // mistaken for its closer.
    if (top?.kind === "interp") {
      if (ch === "{") top.braces++;
      else if (ch === "}") top.braces--;
    }

    if (ch === "/" && next === "/") {
      const stop = source.indexOf("\n", i);
      hide(i, stop === -1 ? source.length : stop);
      i = stop === -1 ? source.length : stop;
      continue;
    }

    if (ch === "/" && next === "*") {
      const stop = source.indexOf("*/", i + 2);
      hide(i, stop === -1 ? source.length : stop + 2);
      i = stop === -1 ? source.length : stop + 2;
      continue;
    }

    if (ch === "/" && isRegexStart(source, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
        j++;
      }
      hide(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === "`") {
      hide(i, i + 1);
      stack.push({ kind: "template" });
      i = scanTemplateText(i + 1);
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        // An unterminated quote means the scan lost sync; a newline ends it
        // rather than swallowing the rest of the file.
        if (source[j] === "\n") break;
        j++;
      }
      hide(i, j + 1);
      i = j + 1;
      continue;
    }

    i++;
  }

  return mask;
}

/**
 * Whether the `/` at `index` opens a regex literal rather than dividing.
 *
 * Division follows a value - an identifier, a number, or a closing bracket.
 * Anything else means the slash starts a pattern.
 */
export function isRegexStart(source: string, index: number): boolean {
  // A comment, not a regex.
  if (source[index + 1] === "/" || source[index + 1] === "*") return false;

  for (let j = index - 1; j >= 0; j--) {
    const c = source[j];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    // Division: the slash follows something that produced a value.
    if (/[\w$)\]]/.test(c)) {
      // ...unless that word is a keyword, where a regex can legitimately follow.
      const word = /[\w$]/.test(c) ? /[\w$]+$/.exec(source.slice(0, j + 1))?.[0] : undefined;
      return word ? ["return", "typeof", "case", "in", "of", "new", "delete", "void"].includes(word) : false;
    }
    return true;
  }
  return true;
}

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

/**
 * Every mutation this file can make, in source order.
 *
 * Deterministic: the same file always yields the same mutants in the same
 * order, so two runs are comparable. Sampling happens in the caller, where the
 * cap can be reported.
 */
export function generateMutants(source: string, file: string): Mutant[] {
  const mask = codeMask(source);
  const mutants: Mutant[] = [];
  const lines = source.split("\n");

  // In TypeScript, `<` and `>` are also generics and JSX, and no regex reliably
  // tells the three apart. Mutating one there produces a file that does not
  // parse - and an unparseable mutant is killed by every suite for the wrong
  // reason, which inflates the score in the one direction that flatters.
  // The operator is only applied where the token is unambiguous.
  const typescript = /\.[cm]?tsx?$/.test(file);

  for (const rule of RULES) {
    if (typescript && rule.operator === "conditional-boundary") continue;
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      const index = match.index ?? 0;
      if (!mask[index]) continue;

      const after = rule.replace(match[0]);
      if (!after || after === match[0]) continue;

      const line = lineOf(source, index);
      const mutated = `${source.slice(0, index)}${after}${source.slice(index + match[0].length)}`;

      mutants.push({
        id: `${path.basename(file)}:${line}:${rule.operator}:${index}`,
        file,
        line,
        operator: rule.operator,
        before: match[0],
        after,
        preview: (mutated.split("\n")[line - 1] ?? lines[line - 1] ?? "").trim().slice(0, 120),
      });
    }
  }

  return mutants.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

export function applyMutant(source: string, mutant: Mutant): string {
  const index = Number(mutant.id.split(":").at(-1));
  if (!Number.isFinite(index)) throw new Error(`Mutant ${mutant.id} has no position.`);

  const actual = source.slice(index, index + mutant.before.length);
  if (actual !== mutant.before) {
    // The file changed under us. Applying anyway would corrupt it.
    throw new Error(
      `Mutant ${mutant.id} no longer matches its file (expected "${mutant.before}", found "${actual}").`,
    );
  }

  return `${source.slice(0, index)}${mutant.after}${source.slice(index + mutant.before.length)}`;
}

/**
 * Spread the sample across files and operators.
 *
 * Taking the first N would test one file's `if` statements exhaustively and
 * nothing else, which is a worse measurement than a smaller spread sample.
 */
export function sampleMutants(mutants: Mutant[], limit: number): Mutant[] {
  if (mutants.length <= limit) return mutants;

  const buckets = new Map<string, Mutant[]>();
  for (const m of mutants) {
    const key = `${m.file}|${m.operator}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(m);
    else buckets.set(key, [m]);
  }

  const picked: Mutant[] = [];
  const keys = [...buckets.keys()].sort();
  let round = 0;

  while (picked.length < limit) {
    let addedThisRound = false;
    for (const key of keys) {
      if (picked.length >= limit) break;
      const bucket = buckets.get(key)!;
      if (round < bucket.length) {
        picked.push(bucket[round]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    round++;
  }

  return picked.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
