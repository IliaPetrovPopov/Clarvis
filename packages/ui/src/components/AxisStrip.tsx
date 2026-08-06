import type { Run } from "@clarvis/core/types";
import { Dot, Label, Meter, stagger } from "./primitives";

/**
 * Per-axis results for one run.
 *
 * This used to live in the navigation rail, which meant the rail's meaning
 * changed depending on which view was open. It belongs to a run, so it sits
 * with the run.
 */
const STATUS_COLOR: Record<string, string> = {
  pending: "var(--color-dim)",
  running: "var(--color-cyan)",
  done: "var(--color-green)",
  skipped: "var(--color-amber)",
  error: "var(--color-sev-critical)",
};

export function AxisStrip({ run }: { run: Run }) {
  if (!run.axes.length) return null;

  const cost = (run.agentRuns ?? []).reduce((sum, a) => sum + (a.usdEstimate ?? 0), 0);

  return (
    <section className="rise px-8 pb-2" style={stagger(3)}>
      <div className="flex items-baseline justify-between">
        <Label>axes</Label>
        {cost > 0 && (
          <span className="text-[10.5px]" style={{ color: "var(--color-dim)" }}>
            {(run.agentRuns ?? []).length} agents · ${cost.toFixed(2)}
          </span>
        )}
      </div>

      <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {run.axes.map((axis) => {
          const color = STATUS_COLOR[axis.status] ?? "var(--color-dim)";
          const r = axis.results;
          const attention = axis.status === "skipped" || axis.status === "error";

          return (
            <li
              key={axis.key}
              className="px-3 py-2.5"
              style={{
                border: `1px solid ${attention ? `color-mix(in srgb, ${color} 45%, transparent)` : "var(--color-edge)"}`,
                background: "var(--color-panel)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <Dot color={color} pulsing={axis.status === "running"} />
                  <span
                    className="hud-type truncate text-[12px] uppercase"
                    style={{ color: "var(--color-body)", letterSpacing: "0.06em" }}
                  >
                    {axis.key}
                  </span>
                </span>
                <span className="label shrink-0" style={{ color, fontSize: "9px" }}>
                  {axis.status}
                </span>
              </div>

              {r && (
                <>
                  <div className="mt-2">
                    <Meter
                      height={2}
                      segments={[
                        { value: r.passed ?? 0, color: "var(--color-cyan-dim)", title: `${r.passed} passed` },
                        { value: r.failed ?? 0, color: "var(--color-sev-high)", title: `${r.failed} failed` },
                        { value: r.skipped ?? 0, color: "var(--color-amber)", title: `${r.skipped} skipped` },
                      ]}
                    />
                  </div>
                  <div className="mt-1.5 flex gap-2.5 text-[10px]" style={{ color: "var(--color-dim)" }}>
                    <span>{r.passed ?? 0} pass</span>
                    <span style={{ color: r.failed ? "var(--color-sev-high)" : undefined }}>
                      {r.failed ?? 0} fail
                    </span>
                    {/* A skipped spec is an unanswered question, never a pass. */}
                    <span style={{ color: r.skipped ? "var(--color-amber)" : undefined }}>
                      {r.skipped ?? 0} skip
                    </span>
                  </div>
                </>
              )}

              {attention && axis.skipReason && (
                <p className="mt-1.5 text-[10px] leading-snug" style={{ color }}>
                  {axis.skipReason.length > 110 ? `${axis.skipReason.slice(0, 110)}...` : axis.skipReason}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
