import type { AxisRun, Run } from "@clarvis/core/types";
import { Bar, Dot, Label, Mono, settle } from "./primitives";

/**
 * One row per axis, because an axis is the unit a person reasons in.
 *
 * The old version was three cards in a row that showed a title, a status word
 * and three counts. The counts were the useful part and they were the smallest
 * thing on it. Here the numbers lead, the proportion is drawn, and a skipped
 * axis carries the reason it was skipped on the same line - previously that
 * reason existed only in a list at the bottom of the page, which is a long way
 * from the thing it explains.
 */

const STATUS: Record<AxisRun["status"], { tone: string; text: string }> = {
  done: { tone: "var(--color-good)", text: "ran" },
  running: { tone: "var(--color-signal)", text: "running" },
  pending: { tone: "var(--color-dim)", text: "queued" },
  skipped: { tone: "var(--color-ink-500)", text: "not run" },
  error: { tone: "var(--color-sev-critical)", text: "errored" },
};

function AxisRow({ axis, index }: { axis: AxisRun; index: number }) {
  const r = axis.results;
  const status = STATUS[axis.status] ?? STATUS.pending;
  const failed = r?.failed ?? 0;
  const skippedAxis = axis.status === "skipped";

  const executed = (r?.passed ?? 0) + (r?.failed ?? 0) + (r?.skipped ?? 0);

  return (
    <li className="settle px-4 py-2.5" style={settle(index)}>
      {/*
        Fixed columns, left-packed rather than stretched edge to edge.

        Name at one end and figure at the other makes an eye cross the panel to
        pair two things that belong together, and a meter that spans the full
        width stops reading as a meter and starts reading as a rule. A compact
        cluster with whitespace after it is how an instrument is laid out, and
        fixed columns line the numbers up down the list - which is the whole
        reason to set them in a tabular face.
      */}
      <div className="grid grid-cols-[10px_164px_180px_auto_54px] items-center gap-x-5">
        <Dot color={failed ? "var(--color-attend)" : status.tone} live={axis.status === "running"} />

        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className="truncate text-[13px]"
            style={{
              color: skippedAxis ? "var(--color-dim)" : "var(--color-body)",
              fontWeight: 500,
            }}
          >
            {axis.key}
          </span>
          {axis.status !== "done" && <Label tone={status.tone}>{status.text}</Label>}
        </div>

        <div>
          {executed > 0 && (
            <Bar
              height={3}
              parts={[
                { value: r?.passed ?? 0, color: "var(--color-good)", title: `${r?.passed} passed` },
                { value: r?.failed ?? 0, color: "var(--color-attend)", title: `${r?.failed} failed` },
                { value: r?.skipped ?? 0, color: "var(--color-ink-400)", title: `${r?.skipped} skipped` },
              ]}
            />
          )}
        </div>

        <div className="readout text-right text-[14px]" style={{ fontWeight: 500 }}>
          {r ? (
            <>
              <span style={{ color: "var(--color-good)" }}>{r.passed ?? 0}</span>
              <span style={{ color: "var(--color-ink-500)" }}> / </span>
              <span style={{ color: failed ? "var(--color-attend)" : "var(--color-dim)" }}>{failed}</span>
            </>
          ) : (
            <span style={{ color: "var(--color-ink-500)" }}>--</span>
          )}
        </div>

        <div className="text-right">
          {r?.durationMs ? <Mono tone="var(--color-dim)">{(r.durationMs / 1000).toFixed(0)}s</Mono> : null}
        </div>
      </div>

      {/* The reason lives with the thing it explains, not in a footnote at the
          bottom of the page. */}
      {skippedAxis && axis.skipReason && (
        <p className="prose mt-1 pl-[26px] text-[11.5px]" style={{ color: "var(--color-dim)" }}>
          {axis.skipReason}
        </p>
      )}
    </li>
  );
}

export function AxisStrip({ run }: { run: Run }) {
  const axes = run.axes ?? [];
  if (!axes.length) return null;

  const ran = axes.filter((a) => a.status === "done").length;

  return (
    <div className="px-5 pt-6 lg:px-8">
      <section className="surface">
        <header className="flex items-baseline gap-3 px-4 pt-3.5 pb-1">
          <Label>axes</Label>
          <span className="ml-auto readout text-[11px]" style={{ color: "var(--color-dim)" }}>
            {ran} of {axes.length} ran
          </span>
        </header>
        <ul className="divide-y" style={{ borderColor: "var(--color-hair)" }}>
          {axes.map((a, i) => (
            <AxisRow key={a.key} axis={a} index={i} />
          ))}
        </ul>
      </section>
    </div>
  );
}
