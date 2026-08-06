import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isNoisePath, tokenize, type ScopeConfig } from "../scope.ts";

/**
 * Local documentation connector. No credentials, no network.
 *
 * Docs are the second-best oracle source after tickets, and unlike tickets they
 * are already in the repo. The unit returned is a SECTION with a file and line
 * number, because a requirement has to cite something a human can open. A quote
 * without a location is unverifiable, and unverifiable is the one thing this
 * product cannot ship.
 */

export interface DocSection {
  file: string;
  /** 1-indexed line of the heading, or of the first line for preamble. */
  line: number;
  heading: string;
  /** Heading depth, 1-6. 0 for text before any heading. */
  depth: number;
  text: string;
  /** Scope keywords found in this section, strongest first. */
  matched: string[];
  score: number;
}

export interface DocsResult {
  sections: DocSection[];
  filesScanned: number;
  status: "ok" | "empty" | "unreachable";
  error?: string;
}

/**
 * Filenames that carry stated intent. Deliberately includes agent instruction
 * files: teams increasingly write real, binding rules in them, and they are as
 * human-authored as any other doc.
 */
const DOC_FILENAMES = [
  "readme",
  "changelog",
  "contributing",
  "architecture",
  "design",
  "spec",
  "requirements",
  "decisions",
  "adr",
  "rfc",
  "claude",
  "agents",
  "notes",
];

const DOC_DIRS = ["docs", "doc", "adr", "adrs", "rfc", "rfcs", "decisions", "specs", "documentation"];

const DOC_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt", ".rst"]);

function looksLikeDoc(filePath: string): boolean {
  const rel = filePath.replace(/\\/g, "/");
  const ext = path.extname(rel).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) return false;

  const base = path.basename(rel, ext).toLowerCase();
  if (DOC_FILENAMES.some((n) => base === n || base.startsWith(`${n}-`) || base.startsWith(`${n}.`))) {
    return true;
  }

  const dirs = path.dirname(rel).toLowerCase().split("/");
  return dirs.some((d) => DOC_DIRS.includes(d));
}

async function walk(
  root: string,
  config: ScopeConfig,
  maxFiles: number,
  depth = 0,
): Promise<string[]> {
  // Deep trees are almost always vendored code, not documentation.
  if (depth > 6) return [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (found.length >= maxFiles) break;
    if (entry.name.startsWith(".") && entry.name !== ".clarvis") continue;

    const full = path.join(root, entry.name);
    if (isNoisePath(full, config)) continue;

    if (entry.isDirectory()) {
      found.push(...(await walk(full, config, maxFiles - found.length, depth + 1)));
    } else if (looksLikeDoc(full)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Split markdown into sections at headings, tracking line numbers so every
 * quote can cite `file:line`.
 */
export function splitSections(content: string, file: string): DocSection[] {
  const lines = content.split("\n");
  const sections: DocSection[] = [];

  let heading = "";
  let depth = 0;
  let startLine = 1;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text || heading) {
      sections.push({ file, line: startLine, heading, depth, text, matched: [], score: 0 });
    }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (match) {
      flush();
      depth = match[1].length;
      heading = match[2].trim();
      startLine = i + 1;
    } else {
      buffer.push(lines[i]);
    }
  }
  flush();

  return sections;
}

/**
 * Find documentation relevant to a scope.
 *
 * Matching is keyword-based rather than semantic on purpose: this stage only
 * needs to *find candidate text*. Judging whether a passage actually states a
 * requirement is a separate step, done by an agent whose reasoning is then
 * checked against the quote.
 */
export async function findDocs(opts: {
  projectRoot: string;
  keywords: string[];
  paths?: string[];
  config?: ScopeConfig;
  maxFiles?: number;
  maxSections?: number;
}): Promise<DocsResult> {
  const config = opts.config ?? {};
  const maxFiles = opts.maxFiles ?? 120;

  let files: string[];
  try {
    await stat(opts.projectRoot);
    files = await walk(opts.projectRoot, config, maxFiles);
  } catch (e) {
    return {
      sections: [],
      filesScanned: 0,
      status: "unreachable",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const keywords = opts.keywords.map((k) => k.toLowerCase()).filter(Boolean);
  // Basenames of changed files are strong signals: docs often name the module.
  const pathTokens = new Set((opts.paths ?? []).flatMap((p) => tokenize(path.basename(p))));

  const sections: DocSection[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    // Skip enormous generated documents.
    if (content.length > 400_000) continue;

    const rel = path.relative(opts.projectRoot, file).replace(/\\/g, "/");

    for (const section of splitSections(content, rel)) {
      const haystack = `${section.heading}\n${section.text}`.toLowerCase();
      if (!haystack.trim()) continue;

      const matched: string[] = [];
      let score = 0;

      for (const kw of keywords) {
        if (!haystack.includes(kw)) continue;
        matched.push(kw);
        // A keyword in the heading is far stronger evidence than one in prose.
        score += section.heading.toLowerCase().includes(kw) ? 5 : 1;
      }

      for (const token of pathTokens) {
        if (haystack.includes(token)) score += 1;
      }

      if (score > 0) sections.push({ ...section, matched, score });
    }
  }

  sections.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const limited = sections.slice(0, opts.maxSections ?? 40);

  return {
    sections: limited,
    filesScanned: files.length,
    status: limited.length ? "ok" : "empty",
  };
}

/**
 * Passages that read like stated rules rather than description. Used to rank
 * candidates, never to decide - "must" in a sentence does not make it a
 * requirement, it makes it worth an agent's attention.
 */
const NORMATIVE = /\b(must|must not|shall|should|cannot|can not|never|always|required|forbidden|only)\b/i;

export function looksNormative(text: string): boolean {
  return NORMATIVE.test(text);
}
