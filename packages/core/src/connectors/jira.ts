import {
  jiraAuthHeader,
  redact,
  type JiraCredential,
} from "./credentials.ts";

/**
 * Jira Cloud REST connector. Read paths only.
 *
 * Writing is deliberately not implemented here. The publish path goes through
 * `trackerGuard.decidePublish` first, and adding a `createIssue` next to these
 * read methods would make it far too easy for a future caller to skip that
 * gate. Reads and writes stay in separate modules so the guard cannot be
 * bypassed by accident.
 */

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  type: string;
  labels: string[];
  author?: string;
  updatedAt?: string;
  url: string;
  /** Acceptance criteria are the single most valuable oracle Jira can provide. */
  acceptanceCriteria?: string;
  comments: Array<{ author?: string; body: string; createdAt?: string }>;
}

export interface JiraFetchResult<T> {
  ok: boolean;
  data: T;
  status: "ok" | "unauthorized" | "unreachable" | "not-configured" | "empty";
  error?: string;
}

/**
 * Atlassian Document Format comes back as a nested node tree. Only the text is
 * wanted, and a quote must match what a human sees, so this walks the tree
 * rather than stringifying it.
 */
export function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;

  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.text) return n.text;

  const inner = (n.content ?? []).map(adfToText).join("");
  // Paragraphs and headings get a blank line after them. A single newline would
  // run them together, and a quote has to match what the author actually sees
  // rendered or it is not verifiable.
  if (n.type === "paragraph" || n.type === "heading") return `${inner}\n\n`;
  if (n.type === "listItem") return `${inner}\n`;
  if (n.type === "hardBreak") return "\n";
  return inner;
}

/**
 * Teams put acceptance criteria in wildly different places. Checked in order of
 * how reliable each is; a custom field beats a heading in prose.
 */
export function extractAcceptanceCriteria(
  fields: Record<string, unknown>,
  description: string,
): string | undefined {
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith("customfield_") || value == null) continue;
    const text = typeof value === "string" ? value : adfToText(value);
    if (text.trim().length > 12 && /given|when|then|must|should/i.test(text)) return text.trim();
  }

  const match = description.match(
    /(?:^|\n)\s*(?:#+\s*)?(?:acceptance criteria|ac|definition of done)\s*:?\s*\n([\s\S]*?)(?=\n\s*#{1,6}\s|\n\s*$|$)/i,
  );
  return match?.[1]?.trim() || undefined;
}

export class JiraConnector {
  // Declared explicitly rather than as constructor parameter properties: Node's
  // type-stripping runtime rejects that syntax, and this package runs from
  // source with no build step.
  readonly credential: JiraCredential;
  private readonly fetchImpl: typeof fetch;

  constructor(credential: JiraCredential, fetchImpl: typeof fetch = fetch) {
    this.credential = credential;
    this.fetchImpl = fetchImpl;
  }

  private async get<T>(pathname: string, params: Record<string, string> = {}): Promise<JiraFetchResult<T | null>> {
    const url = new URL(pathname, this.credential.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    try {
      const res = await this.fetchImpl(url.toString(), {
        headers: {
          authorization: jiraAuthHeader(this.credential),
          accept: "application/json",
        },
      });

      if (res.status === 401 || res.status === 403) {
        return { ok: false, data: null, status: "unauthorized", error: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { ok: false, data: null, status: "unreachable", error: `HTTP ${res.status}` };
      }
      return { ok: true, data: (await res.json()) as T, status: "ok" };
    } catch (e) {
      // Redacted: a failed request can echo the Authorization header back, and
      // this string may end up in run.json or on screen.
      const msg = redact(e instanceof Error ? e.message : String(e), this.credential);
      return { ok: false, data: null, status: "unreachable", error: msg };
    }
  }

  async searchIssues(jql: string, limit = 25): Promise<JiraFetchResult<JiraIssue[]>> {
    const res = await this.get<{ issues?: unknown[] }>("/rest/api/3/search", {
      jql,
      maxResults: String(Math.min(limit, 100)),
      fields: "summary,description,status,issuetype,labels,updated,creator,comment",
    });

    if (!res.ok) return { ok: false, data: [], status: res.status, error: res.error };

    const issues = (res.data?.issues ?? []).map((raw) => this.toIssue(raw));
    return { ok: true, data: issues, status: issues.length ? "ok" : "empty" };
  }

  async getIssue(key: string): Promise<JiraFetchResult<JiraIssue | null>> {
    const res = await this.get<unknown>(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      fields: "summary,description,status,issuetype,labels,updated,creator,comment",
    });
    if (!res.ok || !res.data) return { ok: false, data: null, status: res.status, error: res.error };
    return { ok: true, data: this.toIssue(res.data), status: "ok" };
  }

  private toIssue(raw: unknown): JiraIssue {
    const r = raw as { key?: string; fields?: Record<string, unknown> };
    const f = r.fields ?? {};
    const description = adfToText(f.description);

    const commentContainer = f.comment as { comments?: unknown[] } | undefined;
    const comments = (commentContainer?.comments ?? []).map((c) => {
      const cc = c as { author?: { displayName?: string }; body?: unknown; created?: string };
      return {
        author: cc.author?.displayName,
        body: adfToText(cc.body).trim(),
        createdAt: cc.created,
      };
    });

    return {
      key: r.key ?? "",
      summary: String((f.summary as string) ?? ""),
      description,
      status: String((f.status as { name?: string })?.name ?? ""),
      type: String((f.issuetype as { name?: string })?.name ?? ""),
      labels: (f.labels as string[]) ?? [],
      author: (f.creator as { displayName?: string })?.displayName,
      updatedAt: f.updated as string | undefined,
      url: new URL(`/browse/${r.key ?? ""}`, this.credential.baseUrl).toString(),
      acceptanceCriteria: extractAcceptanceCriteria(f, description),
      comments,
    };
  }
}
