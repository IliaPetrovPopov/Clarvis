import type { Run } from "@clarvis/core/types";
import { Reticle } from "./Reticle";
import { Bar, Dot, Label, Readout } from "./primitives";

/**
 * The top of the run view: what this is, where it is, and whether it is safe.
 *
 * Three things earn the space at the top of a page, and the old header spent
 * it on a feature title and a percentage. What a person actually needs here is
 * the state of the run, the guard decision, and enough numbers to decide
 * whether to keep reading.
 */

function StageTrack({ run }: { run: Run }) {
  const stage = run.stage;
  if (!stage || run.status !== "running") return null;

  const elapsed = Date.now() - new Date(stage.startedAt).getTime();

  return (
    <div className="flex items-center gap-3">
      <Dot color="var(--color-signal)" live />
      <span className="text-[12.5px]" style={{ color: "var(--color-bright)" }}>
        {stage.label}
      </span>
      <span className="readout text-[11px]" style={{ color: "var(--color-dim)" }}>
        {Math.round(elapsed / 1000)}s
      </span>
      {(stage.done ?? []).length > 0 && (
        <span className="readout text-[11px]" style={{ color: "var(--color-dim)" }}>
          · {stage.done!.length} done
        </span>
      )}
    </div>
  );
}

const GUARD_LOOK: Record<string, { tone: string; text: string }> = {
  mutating: { tone: "var(--color-attend)", text: "may write" },
  "read-only": { tone: "var(--color-signal)", text: "read only" },
  aborted: { tone: "var(--color-sev-critical)", text: "refused" },
};

/**
 * The guard decision, inline.
 *
 * It was a full-width panel holding two short strings, which gave a
 * three-word fact the visual weight of a section. It is a status, so it is
 * sized like one and sits on the same line as everything else about the run.
 */
function Guard({ run }: { run: Run }) {
  const look = GUARD_LOOK[run.guard.mode] ?? {
    tone: "var(--color-muted)",
    text: run.guard.mode,
  };

  return (
    <span
      className="inline-flex items-center gap-2 px-2 py-1"
      title={run.guard.reason}
      style={{
        border: `1px solid color-mix(in srgb, ${look.tone} 26%, transparent)`,
        background: `color-mix(in srgb, ${look.tone} 7%, transparent)`,
        borderRadius: "var(--radius-sm)",
      }}
    >
      <Dot color={look.tone} />
      <Label tone={look.tone}>{look.text}</Label>
      <span className="readout text-[11px]" style={{ color: "var(--color-muted)" }}>
        {run.guard.target}
      </span>
      {(run.guard.skippedAxes?.length ?? 0) > 0 && (
        <span
          className="lbl"
          style={{ color: "var(--color-attend)" }}
          title={`Refused: ${run.guard.skippedAxes!.join(", ")}`}
        >
          · {run.guard.skippedAxes!.length} refused
        </span>
      )}
    </span>
  );
}

export function RunHeader({ run, source }: { run: Run; source: "live" | "fixture" }) {
  const findings = run.findings ?? [];
  const confirmed = findings.filter((f) => f.tier === "CONFIRMED");
  const critical = confirmed.filter((f) => f.severity === "critical");

  const totals = (run.axes ?? []).reduce(
    (acc, a) => ({
      passed: acc.passed + (a.results?.passed ?? 0),
      failed: acc.failed + (a.results?.failed ?? 0),
      skipped: acc.skipped + (a.results?.skipped ?? 0),
    }),
    { passed: 0, failed: 0, skipped: 0 },
  );

  const spend = (run.agentRuns ?? []).reduce((sum, a) => sum + (a.usdEstimate ?? 0), 0);

  return (
    <header className="settle px-5 pt-5 lg:px-8">
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Label
              tone={
                critical.length
                  ? "var(--color-sev-critical)"
                  : confirmed.length
                    ? "var(--color-attend)"
                    : "var(--color-good)"
              }
            >
              {critical.length
                ? `${critical.length} critical`
                : confirmed.length
                  ? `${confirmed.length} confirmed`
                  : "nothing confirmed"}
            </Label>
            <span className="readout text-[11px]" style={{ color: "var(--color-dim)" }}>
              {run.runId}
            </span>
            {source === "fixture" && (
              <span
                className="lbl px-1.5 py-0.5"
                style={{
                  color: "var(--color-dim)",
                  border: "1px solid var(--color-hair-lit)",
                  borderRadius: "var(--radius-sm)",
                }}
                title="No engine attached - this is the checked-in example."
              >
                example
              </span>
            )}
          </div>

          {/* The feature under test. A sentence someone wrote, so it is set
              as one rather than as a display headline. */}
          {run.request?.feature && (
            <h1
              className="mt-2 max-w-[62ch] text-[21px] leading-tight"
              style={{ color: "var(--color-bright)", fontWeight: 500, letterSpacing: "-0.01em" }}
            >
              {run.request.feature}
            </h1>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Guard run={run} />
            <StageTrack run={run} />
          </div>
        </div>

        <Reticle run={run} />
      </div>

      {/* Readings. One row, tabular, so the eye scans across rather than down. */}
      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        <Readout
          value={String(confirmed.length).padStart(2, "0")}
          label="confirmed"
          emphasis
          tone={confirmed.length ? "var(--color-attend)" : "var(--color-good)"}
        />
        <Readout
          value={String(critical.length).padStart(2, "0")}
          label="critical"
          emphasis
          tone={critical.length ? "var(--color-sev-critical)" : "var(--color-dim)"}
        />
        <div className="min-w-0">
          <div className="readout leading-none" style={{ fontSize: 22, fontWeight: 500 }}>
            <span style={{ color: "var(--color-good)" }}>{totals.passed}</span>
            <span style={{ color: "var(--color-ink-500)" }}>/</span>
            <span style={{ color: totals.failed ? "var(--color-attend)" : "var(--color-dim)" }}>
              {totals.failed}
            </span>
          </div>
          <div className="mt-1.5">
            <Label>tests pass / fail</Label>
          </div>
          <div className="mt-2 max-w-[150px]">
            <Bar
              parts={[
                { value: totals.passed, color: "var(--color-good)", title: `${totals.passed} passed` },
                { value: totals.failed, color: "var(--color-attend)", title: `${totals.failed} failed` },
                { value: totals.skipped, color: "var(--color-ink-400)", title: `${totals.skipped} skipped` },
              ]}
            />
          </div>
        </div>
        <Readout
          value={run.coverage?.routesKnown ? `${run.coverage.routesVisited ?? 0}/${run.coverage.routesKnown}` : "--"}
          label="routes reached"
          sub={run.coverage?.rolesExercised?.length ? `${run.coverage.rolesExercised.length} role(s)` : undefined}
        />
        <Readout
          value={spend > 0 ? `$${spend.toFixed(2)}` : "--"}
          label="usage equivalent"
          sub={`${(run.agentRuns ?? []).length} agent(s)`}
        />
      </div>

      <div className="rule mt-6" />
    </header>
  );
}
