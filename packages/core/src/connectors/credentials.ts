import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Credential loading for tracker connectors.
 *
 * Two rules, both about the same failure: a token ending up in a git repo.
 *
 *   1. Credentials live OUTSIDE any project. Environment first, then
 *      ~/.clarvis/credentials.json. A credentials file found inside the project
 *      being tested is refused outright rather than read, because the next
 *      `git add -A` would publish it.
 *   2. Read-only unless the credential itself declares write scope. Nothing
 *      infers write access from the presence of a token.
 */

export type CredentialScope = "read-only" | "read-write";

export interface JiraCredential {
  kind: "jira";
  /** e.g. "https://acme.atlassian.net" */
  baseUrl: string;
  email: string;
  apiToken: string;
  scope: CredentialScope;
}

export interface CredentialLoadResult {
  credential?: JiraCredential;
  source: "env" | "file" | "none";
  /** Non-fatal problems worth showing the human rather than silently ignoring. */
  warnings: string[];
}

export const CREDENTIALS_FILENAME = "credentials.json";

export function defaultCredentialsPath(): string {
  return path.join(homedir(), ".clarvis", CREDENTIALS_FILENAME);
}

/**
 * A credentials file inside the project is a leak waiting to happen. Detected
 * by path containment rather than by name, so `.clarvis/credentials.json` in a
 * repo is caught even though that is exactly where someone would put it.
 */
export function isInsideProject(credentialsPath: string, projectRoot: string): boolean {
  const rel = path.relative(path.resolve(projectRoot), path.resolve(credentialsPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function fromEnv(): { credential?: JiraCredential; warnings: string[] } {
  const warnings: string[] = [];
  const baseUrl = process.env.CLARVIS_JIRA_URL;
  const email = process.env.CLARVIS_JIRA_EMAIL;
  const apiToken = process.env.CLARVIS_JIRA_TOKEN;

  if (!baseUrl && !email && !apiToken) return { warnings };

  if (!baseUrl || !email || !apiToken) {
    warnings.push(
      "Partial Jira environment configuration. CLARVIS_JIRA_URL, CLARVIS_JIRA_EMAIL and CLARVIS_JIRA_TOKEN are all required.",
    );
    return { warnings };
  }

  // Write access is opt-in and explicit. An unset value is read-only, never
  // "probably fine".
  const scope: CredentialScope =
    process.env.CLARVIS_JIRA_SCOPE === "read-write" ? "read-write" : "read-only";

  if (process.env.CLARVIS_JIRA_SCOPE && process.env.CLARVIS_JIRA_SCOPE !== scope) {
    warnings.push(
      `CLARVIS_JIRA_SCOPE="${process.env.CLARVIS_JIRA_SCOPE}" is not recognised. Falling back to read-only.`,
    );
  }

  return { credential: { kind: "jira", baseUrl, email, apiToken, scope }, warnings };
}

export async function loadJiraCredential(opts: {
  projectRoot: string;
  credentialsPath?: string;
}): Promise<CredentialLoadResult> {
  const warnings: string[] = [];

  const env = fromEnv();
  warnings.push(...env.warnings);
  if (env.credential) return { credential: env.credential, source: "env", warnings };

  const file = opts.credentialsPath ?? defaultCredentialsPath();

  if (isInsideProject(file, opts.projectRoot)) {
    warnings.push(
      `Refusing to read credentials from ${file}: it is inside the project being tested and would be one \`git add\` away from being committed. Move it to ${defaultCredentialsPath()}.`,
    );
    return { source: "none", warnings };
  }

  try {
    await stat(file);
  } catch {
    return { source: "none", warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    warnings.push(`Could not parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return { source: "none", warnings };
  }

  const jira = (parsed as { jira?: Partial<JiraCredential> })?.jira;
  if (!jira?.baseUrl || !jira.email || !jira.apiToken) {
    warnings.push(`${file} has no complete "jira" entry (needs baseUrl, email, apiToken).`);
    return { source: "none", warnings };
  }

  const scope: CredentialScope = jira.scope === "read-write" ? "read-write" : "read-only";

  return {
    credential: {
      kind: "jira",
      baseUrl: jira.baseUrl,
      email: jira.email,
      apiToken: jira.apiToken,
      scope,
    },
    source: "file",
    warnings,
  };
}

/** Basic auth header for Atlassian Cloud REST. */
export function jiraAuthHeader(credential: JiraCredential): string {
  return `Basic ${Buffer.from(`${credential.email}:${credential.apiToken}`).toString("base64")}`;
}

/**
 * Anything a token could appear in - logs, run.json, an error surfaced to the
 * UI - goes through here first. Tokens leak through diagnostics far more often
 * than through code.
 */
export function redact(text: string, credential?: JiraCredential): string {
  if (!credential) return text;
  return text
    .split(credential.apiToken)
    .join("[redacted]")
    .split(jiraAuthHeader(credential))
    .join("[redacted]");
}
