import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { clarvisPaths } from "./store.ts";
import type { Finding, Run } from "./types.ts";

/**
 * Memory across runs.
 *
 * Every run currently starts cold. It cannot know that it reported this exact
 * finding three runs ago, that a human dismissed it as won't-fix, or that the
 * spec producing it is flaky. A tester that re-reports a dismissed finding
 * every morning gets ignored inside a fortnight, and being ignored is the only
 * failure mode from which a tool never recovers.
 *
 * Two rules govern everything here:
 *
 *   1. A SUPPRESSED FINDING IS NEVER SILENT. Dismissed findings are removed
 *      from the report and counted in plain sight. Anything else and the run is
 *      quietly showing less than it found, which is the failure this whole
 *      product is built against.
 *
 *   2. ONLY A HUMAN DISMISSES. Agents cannot write to this file. A dismissal is
 *      a judgement about acceptable risk, and nothing here is entitled to make
 *      it.
 */

export const LEDGER_SCHEMA_VERSION = 1 as const;

export type LedgerStatus =
  /** Seen, not judged. */
  | "open"
  /** A human decided this is acceptable or wrong. Suppressed from reports. */
  | "dismissed"
  /** Was open, then stopped appearing while its axis kept running. */
  | "fixed"
  /** Appears in some runs and not others. */
  | "flaky";

export interface LedgerEntry {
  fingerprint: string;
  title: string;
  axis: string;
  status: LedgerStatus;
  /** Why a human dismissed it. Required to dismiss. */
  note?: string;
  dismissedBy?: string;
  dismissedAt?: string;
  firstSeen: string;
  lastSeen: string;
  /** Run ids this appeared in, most recent last. Capped. */
  seenIn: string[];
  /** Runs where the axis ran and this did NOT appear. */
  absentIn: number;
  /** Highest severity ever recorded for it. */
  severity: Finding["severity"];
  /** Best tier ever reached. */
  bestTier: Finding["tier"];
}

export interface Ledger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  updatedAt: string;
  entries: Record<string, LedgerEntry>;
}

const MAX_SEEN = 30;

/**
 * Words that carry no identity.
 *
 * Deliberately small. Over-stripping merges genuinely distinct findings, and a
 * merged finding is one that gets suppressed by someone else's dismissal.
 */
const STOPWORDS = new Set([
  "must",
  "should",
  "does",
  "when",
  "with",
  "that",
  "this",
  "then",
  "than",
  "from",
  "into",
  "their",
  "there",
  "which",
  "while",
  "even",
  "just",
  "only",
  "also",
  "been",
  "being",
  "have",
  "has",
  "not",
  "the",
  "are",
  "were",
]);

/**
 * A stable identity for a finding across runs.
 *
 * The hard part is that titles are model-authored and drift: "viewer must not
 * reach /admin" one run, "the /admin route must not be reachable by a viewer"
 * the next. Hashing the title in any form fails - stemming gets "reach" and
 * "reachable" together but not the extra "route", and a bag of words is one
 * synonym away from reporting a known issue as new every morning.
 *
 * So identity keys on what is actually stable: the axis, the route, the role
 * and the locator. Two findings on the same axis about the same route are
 * treated as the same finding, and the title is carried along as a label rather
 * than as part of the key.
 *
 * The cost is real and worth stating: two genuinely different problems on the
 * same route and axis collapse into one entry, so the second is suppressed if
 * the first was dismissed. Title words are mixed in only when there is no
 * structural signal at all, which is the case where merging would be worst.
 */
export function fingerprint(
  finding: Pick<Finding, "axis" | "title" | "route" | "role" | "locator">,
): string {
  const structural = [finding.route ?? "", finding.role ?? "", finding.locator ?? ""]
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  const key = structural.length
    ? [finding.axis, ...structural].join("|")
    : // Nothing structural to key on, so fall back to the title's distinctive
      // words, stemmed so ordinary inflections do not split an identity.
      [finding.axis, titleTokens(finding.title).join(" ")].join("|");

  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Distinctive, crudely stemmed words from a title. */
export function titleTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9/\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
        .map(stem),
    ),
  ]
    .sort()
    .slice(0, 6);
}

/** Enough to join ordinary inflections. Not a real stemmer, and not pretending to be. */
function stem(word: string): string {
  return word
    .replace(/(able|ible|ment|ness|ing|ed|es|s)$/, "")
    .replace(/(.)\1$/, "$1");
}

export function emptyLedger(): Ledger {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, updatedAt: new Date().toISOString(), entries: {} };
}

export function ledgerPath(projectRoot: string): string {
  return path.join(clarvisPaths(projectRoot).root, "ledger.json");
}

export async function loadLedger(projectRoot: string): Promise<Ledger> {
  try {
    const raw = JSON.parse(await readFile(ledgerPath(projectRoot), "utf8")) as Ledger;
    if (raw.schemaVersion !== LEDGER_SCHEMA_VERSION || typeof raw.entries !== "object") {
      return emptyLedger();
    }
    return raw;
  } catch {
    return emptyLedger();
  }
}

export async function saveLedger(projectRoot: string, ledger: Ledger): Promise<string> {
  const file = ledgerPath(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  return file;
}

export interface LedgerApplication {
  /** Findings to report: everything not dismissed. */
  reported: Finding[];
  /** Removed because a human dismissed them. Counted, never hidden. */
  suppressed: Array<{ finding: Finding; entry: LedgerEntry }>;
  /** First time seen. Worth a human's attention over a repeat. */
  newFindings: Finding[];
  /** Seen before and still here. */
  recurring: Array<{ finding: Finding; seenIn: number }>;
  notes: string[];
}

/**
 * Apply what is already known to this run's findings.
 *
 * Deliberately does not mutate the ledger: reading and writing are separate so
 * a report can be produced without recording anything, which is what a dry run
 * and the dashboard both need.
 */
export function applyLedger(findings: Finding[], ledger: Ledger): LedgerApplication {
  const reported: Finding[] = [];
  const suppressed: LedgerApplication["suppressed"] = [];
  const newFindings: Finding[] = [];
  const recurring: LedgerApplication["recurring"] = [];
  const notes: string[] = [];

  for (const finding of findings) {
    const fp = fingerprint(finding);
    const entry = ledger.entries[fp];

    if (entry?.status === "dismissed") {
      suppressed.push({ finding, entry });
      continue;
    }

    reported.push(finding);

    if (!entry) newFindings.push(finding);
    else recurring.push({ finding, seenIn: entry.seenIn.length });
  }

  if (suppressed.length) {
    notes.push(
      `${suppressed.length} finding(s) suppressed by earlier dismissals. They are still being found; ` +
        `a human decided they are acceptable. Run \`clarvis ledger\` to see them.`,
    );
  }

  return { reported, suppressed, newFindings, recurring, notes };
}

/**
 * Record what this run saw.
 *
 * The interesting judgement is absence. A finding that stops appearing has
 * either been fixed or was never checked again, and those are not the same
 * thing - so absence only counts when the axis that would have found it
 * actually ran.
 */
export function recordRun(ledger: Ledger, run: Run): Ledger {
  const entries = { ...ledger.entries };
  const now = new Date().toISOString();

  const axesThatRan = new Set(run.axes.filter((a) => a.status === "done").map((a) => a.key));
  const seenNow = new Set<string>();

  for (const finding of run.findings) {
    const fp = fingerprint(finding);
    seenNow.add(fp);

    const existing = entries[fp];
    if (!existing) {
      entries[fp] = {
        fingerprint: fp,
        title: finding.title,
        axis: finding.axis,
        status: "open",
        firstSeen: now,
        lastSeen: now,
        seenIn: [run.runId],
        absentIn: 0,
        severity: finding.severity,
        bestTier: finding.tier,
      };
      continue;
    }

    entries[fp] = {
      ...existing,
      // A dismissal is not undone by the finding reappearing - that is the
      // whole point of dismissing it.
      status: existing.status === "dismissed" ? "dismissed" : existing.absentIn > 0 ? "flaky" : "open",
      title: finding.title,
      lastSeen: now,
      seenIn: [...existing.seenIn, run.runId].slice(-MAX_SEEN),
      severity: rank(finding.severity) > rank(existing.severity) ? finding.severity : existing.severity,
      bestTier: betterTier(existing.bestTier, finding.tier),
    };
  }

  for (const [fp, entry] of Object.entries(entries)) {
    if (seenNow.has(fp)) continue;
    if (entry.status === "dismissed") continue;

    // Absent, but only meaningful if we looked. An axis that did not run tells
    // us nothing, and counting it as fixed would be an invented result.
    if (!axesThatRan.has(entry.axis)) continue;

    const absentIn = entry.absentIn + 1;
    entries[fp] = {
      ...entry,
      absentIn,
      // One absence is noise; two in a row is a fix worth claiming.
      status: absentIn >= 2 ? "fixed" : entry.status === "open" ? "flaky" : entry.status,
    };
  }

  return { ...ledger, entries, updatedAt: now };
}

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 } as const;
const rank = (s: Finding["severity"]) => SEVERITY_RANK[s];

const TIER_RANK = { CONFIRMED: 3, PLAUSIBLE: 2, QUESTION: 1, DISCARDED: 0 } as const;
const betterTier = (a: Finding["tier"], b: Finding["tier"]) => (TIER_RANK[b] > TIER_RANK[a] ? b : a);

/**
 * Dismiss a finding. Only ever called from an explicit human action, and the
 * reason is mandatory: a dismissal with no stated reason is indistinguishable
 * from a mistake six months later.
 */
export function dismiss(
  ledger: Ledger,
  fingerprintOrPrefix: string,
  opts: { note: string; by: string },
): { ledger: Ledger; entry?: LedgerEntry; error?: string } {
  if (!opts.note.trim()) {
    return { ledger, error: "A dismissal needs a reason. Without one nobody can tell it from a mistake later." };
  }

  const matches = Object.keys(ledger.entries).filter((fp) => fp.startsWith(fingerprintOrPrefix));

  if (!matches.length) return { ledger, error: `No finding matching "${fingerprintOrPrefix}".` };
  if (matches.length > 1) {
    return { ledger, error: `"${fingerprintOrPrefix}" matches ${matches.length} findings. Use more characters.` };
  }

  const fp = matches[0];
  const entry: LedgerEntry = {
    ...ledger.entries[fp],
    status: "dismissed",
    note: opts.note.trim(),
    dismissedBy: opts.by,
    dismissedAt: new Date().toISOString(),
  };

  return { ledger: { ...ledger, entries: { ...ledger.entries, [fp]: entry } }, entry };
}

/** Undo a dismissal. */
export function reopen(ledger: Ledger, fingerprintOrPrefix: string): { ledger: Ledger; error?: string } {
  const matches = Object.keys(ledger.entries).filter((fp) => fp.startsWith(fingerprintOrPrefix));
  if (matches.length !== 1) {
    return { ledger, error: `"${fingerprintOrPrefix}" matches ${matches.length} findings.` };
  }

  const fp = matches[0];
  const { note, dismissedBy, dismissedAt, ...rest } = ledger.entries[fp];
  void note;
  void dismissedBy;
  void dismissedAt;

  return { ledger: { ...ledger, entries: { ...ledger.entries, [fp]: { ...rest, status: "open" } } } };
}

export function describeLedger(ledger: Ledger): string[] {
  const entries = Object.values(ledger.entries).sort(
    (a, b) => rank(b.severity) - rank(a.severity) || b.lastSeen.localeCompare(a.lastSeen),
  );

  if (!entries.length) return ["Nothing recorded yet."];

  const lines: string[] = [];
  const byStatus = (status: LedgerStatus) => entries.filter((e) => e.status === status);

  for (const status of ["open", "flaky", "dismissed", "fixed"] as const) {
    const group = byStatus(status);
    if (!group.length) continue;

    lines.push("");
    lines.push(`${status.toUpperCase()} (${group.length})`);
    for (const e of group) {
      lines.push(
        `  ${e.fingerprint}  ${e.severity.padEnd(8)} ${e.axis.padEnd(16)} seen ${String(e.seenIn.length).padStart(2)}x  ${e.title.slice(0, 58)}`,
      );
      if (e.note) lines.push(`               ${e.dismissedBy ?? "someone"}: ${e.note.slice(0, 88)}`);
    }
  }

  return lines;
}
