import type { AgentRunner, RawAgentResponse } from "./runtime.ts";

/**
 * A runner that answers plausibly without calling a model.
 *
 * The smoke run exists to catch integration bugs, and none of the ones it was
 * built for lived in an agent's judgement. Warm-up walking every route, a
 * progress scale the run could not reach the end of, tokens computed and
 * discarded, a server and a page disagreeing about their contract - every one
 * of those is plumbing, and plumbing is exercised identically whether the
 * spec was written by Opus or handed over ready-made.
 *
 * So the default smoke run stubs the agents. That turns a ten-minute,
 * token-spending check into a seconds-long free one, which is the difference
 * between a check that gets run before every report and one that does not.
 *
 * Two rules keep it honest.
 *
 * It never returns something the real pipeline would reject. The spec below is
 * a real spec: it passes the gate, drives a real browser, and asserts things
 * that are actually true of the demo app. A stub that returned a spec the gate
 * refuses would make the smoke run green by never reaching the interesting
 * part.
 *
 * And it is only ever reached deliberately. `CLARVIS_STUB_AGENTS` is read at
 * the one place a runner is constructed, it is never a fallback for a failed
 * agent, and a live run cannot silently become a stubbed one - because a smoke
 * run that quietly stopped testing the real thing would be the exact failure
 * this product is built to prevent, committed by the tool meant to catch it.
 */

/**
 * A spec that genuinely runs against the demo app.
 *
 * Deliberately not about the seeded bugs. The smoke run checks that the
 * pipeline works, not that the fleet is good at finding things - that is what
 * `clarvis benchmark` measures, with an answer key. Mixing the two would make
 * a plumbing check fail whenever a prompt changed.
 */
const SPEC = `import { test, expect } from "@playwright/test";

// r-smoke: the application serves its own front page.
test("the front page renders something a person could use", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  const controls = page.locator("a, button, input");
  expect(await controls.count()).toBeGreaterThan(0);
});

// r-smoke: health is the one endpoint that must always answer.
test("health answers", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.status()).toBe(200);
});
`;

/** What each role must return for the run to proceed. */
const REPLIES: Record<string, unknown> = {
  "scout-boot": {
    cmd: "node server.mjs",
    url: "http://localhost:4600",
    readyCheck: "http://localhost:4600/health",
    blockers: [],
  },
  "scout-auth": { mode: "cookie-session", loginUrl: "/login", roles: [], protectedRoutes: [] },
  "scout-safety": { forbiddenHosts: [], disposable: false, notes: "stubbed" },
  "scout-taxonomy": { axes: [], irrelevantStandardAxes: [], notes: ["stubbed"] },

  "archive-extract": { requirements: [], unknowns: [] },
  "archive-entail": { entailed: false, why: "stubbed" },
  "archive-synthesis": { summary: "stubbed", requirements: [], unknowns: [] },

  "foreman-plan": {
    rationale: "Stubbed plan: both requested axes, in the order given.",
    axes: [
      { axis: "rbac-scope", rank: 1, why: "Requested.", routes: ["/admin"], roles: ["viewer"] },
      { axis: "responsive-a11y", rank: 2, why: "Requested.", routes: ["/"], roles: [] },
    ],
    deferred: [],
  },

  "prover-author": { source: SPEC, covers: [], untested: [{ reason: "Stubbed author: only smoke assertions were written." }] },

  "prover-triage": {
    reproduced: true,
    runs: 3,
    failures: 3,
    fault: "unclear",
    why: "Stubbed triage: no judgement was made.",
  },

  "scribe-draft": { title: "Stubbed draft", body: "Stubbed.", labels: [] },
  "judge-notes": { summary: "Stubbed verdict.", limits: ["Agents were stubbed."], releaseNotes: [] },
};

/** True only when explicitly asked for. Never a fallback. */
export function stubAgentsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLARVIS_STUB_AGENTS === "1";
}

export class StubRunner implements AgentRunner {
  /** Roles this was asked for, in order. Read by the smoke check. */
  readonly calls: string[] = [];

  async invoke({
    definition,
  }: {
    definition: { role: string; model: string };
    prompt: string;
  }): Promise<RawAgentResponse> {
    this.calls.push(definition.role);

    const reply = REPLIES[definition.role];
    if (reply === undefined) {
      // Loudly, rather than returning something shaped like success. A role
      // with no stub means the pipeline grew a step this cannot speak for, and
      // a smoke run that skipped it would report a coverage it does not have.
      throw new Error(
        `No stubbed reply for agent role "${definition.role}". Add one to stubRunner.ts, ` +
          `or the smoke run is silently not exercising that step.`,
      );
    }

    return {
      text: JSON.stringify(reply),
      model: definition.model,
      // Non-zero, so the invariant that every successful agent run records
      // tokens is exercised rather than vacuously satisfied.
      usage: { inputTokens: 1200, outputTokens: 300 },
      usdReported: 0,
    };
  }
}
