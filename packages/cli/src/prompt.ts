import readline from "node:readline";
import { createInterface } from "node:readline/promises";

/**
 * A checkbox prompt, written against the terminal directly.
 *
 * No dependency: this is one screenful of escape codes, and a prompt library is
 * a supply-chain surface for something that runs on every project setup.
 *
 * The part that matters is the fallback. A prompt that blocks forever when
 * stdin is not a terminal turns a CI run or a piped command into a hang with no
 * output, which is the worst failure mode a setup step can have. When there is
 * no TTY, this returns the defaults and says so.
 */

const ESC = "[";
const HIDE = `${ESC}?25l`;
const SHOW = `${ESC}?25h`;

export interface Choice {
  value: string;
  label: string;
  hint?: string;
  /** Cannot be turned off. Shown as locked on. */
  locked?: boolean;
  /** Values this one pulls in when selected. */
  requires?: string[];
  /** Rendered in the warning colour, for anything with reach outside the repo. */
  caution?: string;
}

export interface CheckboxResult {
  values: string[];
  /** True when there was no terminal and the defaults were taken. */
  usedDefaults: boolean;
}

const c = {
  dim: (t: string) => `[2m${t}[0m`,
  cyan: (t: string) => `[36m${t}[0m`,
  bright: (t: string) => `[1m${t}[0m`,
  amber: (t: string) => `[33m${t}[0m`,
  grey: (t: string) => `[90m${t}[0m`,
};

export function isInteractive(stream: NodeJS.ReadStream = process.stdin): boolean {
  return Boolean(stream.isTTY && process.stdout.isTTY);
}

/**
 * Toggling one choice, with dependencies applied in both directions.
 *
 * Pure and exported so the rules can be tested without a terminal - the raw
 * keypress loop around it cannot be, and the rules are the part with the
 * behaviour worth checking.
 *
 * Both directions matter. Turning something on pulls in what it reads from;
 * turning that off again drops whatever depended on it, rather than leaving a
 * selection the engine would silently correct later, which reads as the tool
 * ignoring what you clicked.
 */
export function toggleChoice(
  choices: readonly Choice[],
  selected: ReadonlySet<string>,
  value: string,
): Set<string> {
  const choice = choices.find((c) => c.value === value);
  const next = new Set(selected);
  if (!choice || choice.locked) return next;

  if (next.has(value)) {
    next.delete(value);
    for (const other of choices) {
      if (other.requires?.includes(value)) next.delete(other.value);
    }
    return next;
  }

  next.add(value);
  for (const need of choice.requires ?? []) next.add(need);
  return next;
}

export async function checkbox(opts: {
  title: string;
  hint?: string;
  choices: Choice[];
  /** Pre-selected values. Locked choices are always added. */
  selected?: string[];
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<CheckboxResult> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  const locked = opts.choices.filter((ch) => ch.locked).map((ch) => ch.value);
  const initial = new Set([...(opts.selected ?? []), ...locked]);

  if (!isInteractive(input)) {
    return { values: [...new Set(initial)], usedDefaults: true };
  }

  const selected = new Set(initial);
  let cursor = 0;
  let rendered = 0;

  const lines = (): string[] => {
    const out: string[] = [];
    out.push("");
    out.push(`  ${c.bright(opts.title)}`);
    if (opts.hint) out.push(`  ${c.dim(opts.hint)}`);
    out.push("");

    for (const [i, ch] of opts.choices.entries()) {
      const on = ch.locked || selected.has(ch.value);
      const pointer = i === cursor ? c.cyan(">") : " ";
      const box = ch.locked ? c.grey("[*]") : on ? c.cyan("[x]") : "[ ]";
      const label = on ? c.bright(ch.label) : ch.label;

      const tags = [
        ch.locked ? c.grey("always runs") : "",
        ch.caution ? c.amber(ch.caution) : "",
      ]
        .filter(Boolean)
        .join(" ");

      out.push(`  ${pointer} ${box} ${label}${tags ? ` ${tags}` : ""}`);
      if (ch.hint) out.push(`        ${c.dim(ch.hint)}`);
    }

    out.push("");
    out.push(`  ${c.dim("space toggle · up/down move · a all · enter confirm · ctrl-c cancel")}`);
    return out;
  };

  const draw = () => {
    // Redraw in place rather than scrolling: a list that reprints on every
    // keypress is unreadable.
    if (rendered) output.write(`${ESC}${rendered}A${ESC}0J`);
    const text = lines();
    rendered = text.length;
    output.write(`${text.join("\n")}\n`);
  };

  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw ?? false;
  input.setRawMode(true);
  output.write(HIDE);
  draw();

  return new Promise<CheckboxResult>((resolve, reject) => {
    const apply = (next: Set<string>) => {
      selected.clear();
      for (const v of next) selected.add(v);
    };

    const cleanup = () => {
      input.off("keypress", onKey);
      input.setRawMode(wasRaw);
      input.pause();
      output.write(SHOW);
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        // Restore the cursor before dying, or the user's shell is left without
        // one for the rest of the session.
        output.write("\n");
        reject(new Error("Cancelled."));
        return;
      }

      switch (key.name) {
        case "up":
        case "k":
          cursor = (cursor - 1 + opts.choices.length) % opts.choices.length;
          break;
        case "down":
        case "j":
          cursor = (cursor + 1) % opts.choices.length;
          break;
        case "a":
          for (const ch of opts.choices) selected.add(ch.value);
          break;
        case "space":
          apply(toggleChoice(opts.choices, selected, opts.choices[cursor].value));
          break;
        case "return":
        case "enter":
          cleanup();
          // Deduped: locked values are already in `selected`, and returning
          // them twice made the caller store a list with repeats in it.
          resolve({ values: [...new Set([...selected, ...locked])], usedDefaults: false });
          return;
        default:
          // Some terminals report space only as a sequence.
          if (key.sequence === " ") {
            apply(toggleChoice(opts.choices, selected, opts.choices[cursor].value));
          }
      }
      draw();
    };

    input.on("keypress", onKey);
    input.resume();
  });
}

/** Yes or no, defaulting to no. Same non-TTY behaviour: take the default. */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  if (!isInteractive()) return fallback;

  // The promise-based interface: the callback `question` returns void.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${question} ${c.dim(fallback ? "[Y/n]" : "[y/N]")} `);
    const trimmed = answer.trim().toLowerCase();
    if (!trimmed) return fallback;
    return trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}
