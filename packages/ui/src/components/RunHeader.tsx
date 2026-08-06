import type { Run } from "@clarvis/core/types";
import { runTitle, verdictLine } from "@clarvis/core/briefing";
import { Hud, RingGauge, Stat, stagger } from "./primitives";

function GuardBadge({ guard }: { guard: Run["guard"] }) {
  const style = {
    mutating: { color: "var(--color-green)", text: "MUTATING" },
    "read-only": { color: "var(--color-amber)", text: "READ-ONLY" },
    aborted: { color: "var(--color-sev-critical)", text: "ABORTED" },
  }[guard.mode];

  return (
    <Hud tone={`color-mix(in srgb, ${style.color} 50%, transparent)`} small>
      <div className="flex items-start gap-3 px-4 py-2.5" title={guard.reason}>
        <svg viewBox="0 0 16 18" className="mt-0.5 size-4 shrink-0" fill="none" aria-hidden>
          <path
            d="M8 1 1.5 3.6v5.2c0 4 2.7 6.9 6.5 8.2 3.8-1.3 6.5-4.2 6.5-8.2V3.6L8 1Z"
            stroke={style.color}
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
        <div className="min-w-0">
          <div className="label glow" style={{ color: style.color }}>
            GUARD / {style.text}
          </div>
          <div className="mt-0.5 text-[11px]" style={{ color: "var(--color-muted)" }}>
            {guard.target}
            {guard.matchedSafeTarget && (
              <span style={{ color: "var(--color-dim)" }}> · {guard.matchedSafeTarget}</span>
            )}
          </div>
          {guard.skippedAxes && guard.skippedAxes.length > 0 && (
            <div className="mt-1 text-[11px]" style={{ color: "var(--color-amber)" }}>
              {guard.skippedAxes.length} mutating {guard.skippedAxes.length === 1 ? "axis" : "axes"} refused
            </div>
          )}
        </div>
      </div>
    </Hud>
  );
}

/** Tone per verdict tier. The wording itself is computed in core. */
const VERDICT_TONE: Record<string, string> = {
  clear: "var(--color-green)",
  confirmed: "var(--color-amber)",
  unconfirmed: "var(--color-amber)",
  unrecorded: "var(--color-sev-critical)",
  blocked: "var(--color-sev-critical)",
  pending: "var(--color-cyan)",
};

export function RunHeader({ run, source }: { run: Run; source: "live" | "fixture" }) {
  const confirmed = run.findings.filter((f) => f.tier === "CONFIRMED");
  const critical = confirmed.filter((f) => f.severity === "critical").length;
  const discarded = run.findings.filter((f) => f.tier === "DISCARDED").length;

  const totals = run.axes.reduce(
    (acc, a) => ({
      passed: acc.passed + (a.results?.passed ?? 0),
      failed: acc.failed + (a.results?.failed ?? 0),
      skipped: acc.skipped + (a.results?.skipped ?? 0),
    }),
    { passed: 0, failed: 0, skipped: 0 },
  );

  const cost = (run.agentRuns ?? []).reduce((sum, a) => sum + (a.usdEstimate ?? 0), 0);
  const cov = run.coverage;
  const verdict = verdictLine(run);
  const status = { text: verdict.text, color: VERDICT_TONE[verdict.tone] ?? "var(--color-cyan)" };

  return (
    <header className="px-8 pt-6 pb-5">
      {/* Status strip - the verdict, alone on its line. */}
      <div className="rise flex items-center gap-3" style={stagger(0)}>
        <span
          className="hud-type glow text-[13px]"
          style={{ color: status.color, letterSpacing: "0.3em" }}
        >
          {status.text}
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-edge)" }} />
        <span className="label">{run.runId}</span>
        {source === "fixture" && (
          <span
            className="hud-clip-sm label px-2 py-0.5"
            style={{
              color: "var(--color-amber)",
              border: "1px solid color-mix(in srgb, var(--color-amber) 45%, transparent)",
              fontSize: "10px",
            }}
            title="No engine attached - rendering the checked-in fixture."
          >
            FIXTURE
          </span>
        )}
      </div>

      <div className="rise mt-5 flex flex-wrap items-start justify-between gap-8" style={stagger(1)}>
        <div className="min-w-0 flex-1">
          <h1
            className="hud-type text-[42px] leading-[1.05] uppercase"
            style={{ color: "var(--color-bright)" }}
          >
            {runTitle(run)}
          </h1>

          {run.request?.brief && (
            <p
              className="mt-3 max-w-[64ch] border-l pl-4 text-[12px] leading-relaxed"
              style={{ color: "var(--color-muted)", borderColor: "var(--color-edge-bright)" }}
            >
              {run.request.brief}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-start gap-6">
          {/*
            Coverage sits beside the verdict at equal visual weight. A result is
            not interpretable without it, so the layout refuses to separate them.
          */}
          <RingGauge
            value={cov?.routesVisited ?? 0}
            max={cov?.routesKnown ?? 0}
            label="ROUTES"
            sublabel={`${cov?.routesVisited ?? 0} / ${cov?.routesKnown ?? 0}`}
          />
          <GuardBadge guard={run.guard} />
        </div>
      </div>

      <div
        className="rise mt-7 grid grid-cols-2 gap-x-8 gap-y-6 border-t pt-6 sm:grid-cols-3 lg:grid-cols-6"
        style={{ ...stagger(2), borderColor: "var(--color-edge)" }}
      >
        <Stat
          label="confirmed"
          value={String(confirmed.length).padStart(2, "0")}
          tone={confirmed.length > 0 ? "amber" : "green"}
          hint="Reproduced 3/3 cold by a second agent, with an oracle cited."
        />
        <Stat
          label="critical"
          value={String(critical).padStart(2, "0")}
          tone={critical > 0 ? "amber" : "dim"}
        />
        <Stat
          label="discarded"
          value={String(discarded).padStart(2, "0")}
          tone="dim"
          hint="Claims that failed verification. Never shown to you as bugs."
        />
        <Stat
          label="spec p/f/s"
          value={
            <span className="text-[22px]">
              {totals.passed}
              <span style={{ color: "var(--color-dim)" }}>/</span>
              <span style={{ color: totals.failed ? "var(--color-sev-high)" : undefined }}>
                {totals.failed}
              </span>
              <span style={{ color: "var(--color-dim)" }}>/</span>
              <span style={{ color: totals.skipped ? "var(--color-amber)" : undefined }}>
                {totals.skipped}
              </span>
            </span>
          }
          hint="From the Playwright JSON reporter, not from any agent. skipped > 0 is an alarm, not a pass."
        />
        <Stat
          label="js coverage"
          value={
            cov?.jsCoveragePct != null ? (
              <>
                {cov.jsCoveragePct.toFixed(0)}
                <span className="text-[16px]" style={{ color: "var(--color-dim)" }}>
                  %
                </span>
              </>
            ) : (
              "--"
            )
          }
        />
        {/* "usage", not "cost": with a Claude plan login there is no invoice.
            The figure is what the same tokens would cost at API rates. */}
        <Stat
          label="usage"
          value={`$${cost.toFixed(2)}`}
          tone="dim"
          hint="API-equivalent. With a Claude plan login this is usage, not a charge."
        />
      </div>

      {/* A clean verdict with nothing behind it is the failure mode to guard against. */}
      {run.status === "passed" && (cov?.routesVisited ?? 0) === 0 && (
        <div className="mt-4 text-[11px]" style={{ color: "var(--color-amber)" }}>
          No routes were visited. "All clear" here means nothing was checked.
        </div>
      )}
    </header>
  );
}
