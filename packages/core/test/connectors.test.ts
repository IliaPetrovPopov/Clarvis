import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import {
  isInsideProject,
  loadJiraCredential,
  redact,
  jiraAuthHeader,
  defaultCredentialsPath,
  type JiraCredential,
} from "../src/connectors/credentials.ts";
import { adfToText, extractAcceptanceCriteria, JiraConnector } from "../src/connectors/jira.ts";

const cred: JiraCredential = {
  kind: "jira",
  baseUrl: "https://acme.atlassian.net",
  email: "a@b.c",
  apiToken: "SUPER_SECRET_TOKEN",
  scope: "read-only",
};

/* ------------------------------------------------------------ credentials */

test("refuses a credentials file living inside the project", () => {
  const root = "/Users/x/project";
  assert.equal(isInsideProject(`${root}/.clarvis/credentials.json`, root), true);
  assert.equal(isInsideProject(`${root}/credentials.json`, root), true);
  assert.equal(isInsideProject(path.join(homedir(), ".clarvis/credentials.json"), root), false);
  // A sibling directory whose name merely starts the same must not count as inside.
  assert.equal(isInsideProject("/Users/x/project-other/creds.json", root), false);
});

test("the default credentials path is outside any project", () => {
  assert.equal(defaultCredentialsPath().startsWith(homedir()), true);
});

test("an in-project credentials path warns and loads nothing", async () => {
  const root = process.cwd();
  const res = await loadJiraCredential({
    projectRoot: root,
    credentialsPath: path.join(root, ".clarvis", "credentials.json"),
  });
  assert.equal(res.credential, undefined);
  assert.equal(res.source, "none");
  assert.match(res.warnings.join(" "), /inside the project/i);
});

test("a missing credentials file is not an error", async () => {
  const res = await loadJiraCredential({
    projectRoot: "/tmp/some-project",
    credentialsPath: "/tmp/definitely-not-here-clarvis.json",
  });
  assert.equal(res.source, "none");
  assert.deepEqual(res.warnings, []);
});

test("tokens are redacted from anything that could be logged", () => {
  const leak = `request failed: authorization=${jiraAuthHeader(cred)} token=${cred.apiToken}`;
  const safe = redact(leak, cred);
  assert.equal(safe.includes(cred.apiToken), false);
  assert.equal(safe.includes(jiraAuthHeader(cred)), false);
  assert.match(safe, /\[redacted\]/);
});

/* -------------------------------------------------------------------- adf */

test("ADF is flattened to the text a human would actually see", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Proctors cannot view users." }] },
      { type: "paragraph", content: [{ type: "text", text: "Second line." }] },
    ],
  };
  const text = adfToText(doc).trim();
  assert.equal(text, "Proctors cannot view users.\n\nSecond line.");
});

test("acceptance criteria are found under a heading in the description", () => {
  const desc = "Some context.\n\n## Acceptance Criteria\nGiven a Proctor, when they open /users, then 403.\n";
  const ac = extractAcceptanceCriteria({}, desc);
  assert.match(ac ?? "", /Given a Proctor/);
});

test("a custom field beats prose when it reads like criteria", () => {
  const ac = extractAcceptanceCriteria(
    { customfield_10001: "Given a Proctor, then the request must be rejected." },
    "no criteria heading here",
  );
  assert.match(ac ?? "", /must be rejected/);
});

/* -------------------------------------------------------------- connector */

test("unauthorized responses are reported, not thrown", async () => {
  const fake = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  const res = await new JiraConnector(cred, fake).searchIssues("project = EXM");
  assert.equal(res.ok, false);
  assert.equal(res.status, "unauthorized");
  assert.deepEqual(res.data, []);
});

test("a network failure never echoes the token back", async () => {
  const fake = (async () => {
    throw new Error(`connect failed with authorization ${jiraAuthHeader(cred)}`);
  }) as unknown as typeof fetch;
  const res = await new JiraConnector(cred, fake).searchIssues("project = EXM");
  assert.equal(res.status, "unreachable");
  assert.equal(res.error?.includes(cred.apiToken), false);
  assert.match(res.error ?? "", /\[redacted\]/);
});

test("issues are mapped with quote-ready text and a browse url", async () => {
  const payload = {
    issues: [
      {
        key: "EXM-412",
        fields: {
          summary: "Scope users by organization",
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Body." }] },
              { type: "paragraph", content: [{ type: "text", text: "Acceptance Criteria:" }] },
              { type: "paragraph", content: [{ type: "text", text: "Proctors must not view users." }] },
            ],
          },
          status: { name: "Done" },
          issuetype: { name: "Story" },
          labels: ["rbac"],
          updated: "2026-08-01T10:00:00.000Z",
          creator: { displayName: "Ilia" },
          comment: {
            comments: [
              {
                author: { displayName: "Reviewer" },
                body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Confirmed." }] }] },
                created: "2026-08-02T10:00:00.000Z",
              },
            ],
          },
        },
      },
    ],
  };
  const fake = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;

  const res = await new JiraConnector(cred, fake).searchIssues("project = EXM");
  assert.equal(res.ok, true);
  const issue = res.data[0];
  assert.equal(issue.key, "EXM-412");
  assert.equal(issue.author, "Ilia");
  assert.equal(issue.url, "https://acme.atlassian.net/browse/EXM-412");
  assert.match(issue.acceptanceCriteria ?? "", /Proctors must not view users/);
  assert.equal(issue.comments[0].body, "Confirmed.");
});

test("an empty result set is reported as empty, not as ok-with-data", async () => {
  const fake = (async () => new Response(JSON.stringify({ issues: [] }), { status: 200 })) as unknown as typeof fetch;
  const res = await new JiraConnector(cred, fake).searchIssues("project = NONE");
  assert.equal(res.status, "empty");
});
