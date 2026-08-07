import type { Run } from "@clarvis/core/types";
import { Label } from "./primitives";

/**
 * The run as a single instrument.
 *
 * The first attempt drew one arc per axis, coloured by outcome. It looked
 * precise and said almost nothing: three axes with any failure at all produced
 * three amber arcs, which is a ring of warning around a number and no more
 * informative than the number alone. A gauge has to answer a question of
 * degree, and "did this axis have a failure" is not one.
 *
 * So the outer track is now a true proportion - every test that ran, by
 * outcome. A mostly-green ring is a healthy run and reads as one across a
 * room, which is the entire job of an instrument.
 *
 *   OUTER  every test, by outcome. Degree, not category.
 *   INNER  the pipeline. Fills as stages finish; breathes while one is live.
 *   CENTRE the number that decides whether to keep reading.
 */

const TAU = Math.PI * 2;

/** Polar to cartesian, with zero at twelve o'clock rather than three. */
function point(cx: number, cy: number, r: number, t: number) {
  const a = t * TAU - TAU / 4;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** An arc between two fractions of a full turn. */
function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  // A full turn cannot be one arc: start and end coincide and nothing renders.
  if (to - from >= 0.999) {
    return `${arc(cx, cy, r, from, from + 0.5)} ${arc(cx, cy, r, from + 0.5, from + 0.999)}`;
  }
  const a = point(cx, cy, r, from);
  const b = point(cx, cy, r, to);
  const large = to - from > 0.5 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

const STAGE_ORDER = [
  "sandbox",
  "context",
  "boot",
  "surface",
  "author",
  "execute",
  "triage",
  "deliver",
  "done",
];

export function Reticle({ run, size = 148 }: { run: Run; size?: number }) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 7;
  const rInner = size / 2 - 20;

  const totals = (run.axes ?? []).reduce(
    (acc, a) => ({
      passed: acc.passed + (a.results?.passed ?? 0),
      failed: acc.failed + (a.results?.failed ?? 0),
      skipped: acc.skipped + (a.results?.skipped ?? 0),
    }),
    { passed: 0, failed: 0, skipped: 0 },
  );
  const executed = totals.passed + totals.failed + totals.skipped;

  const confirmed = (run.findings ?? []).filter((f) => f.tier === "CONFIRMED");
  const critical = confirmed.filter((f) => f.severity === "critical");
  const running = run.status === "running";

  const doneKeys = new Set((run.stage?.done ?? []).map((d) => d.key));
  const activeKey = run.stage?.key;
  // A finished run reads as complete whatever it last stamped: a stage list
  // describes getting there, not where it is.
  const reached = running
    ? STAGE_ORDER.filter((k) => doneKeys.has(k) || k === activeKey).length
    : STAGE_ORDER.length;

  const centreTone = critical.length
    ? "var(--color-sev-critical)"
    : confirmed.length
      ? "var(--color-attend)"
      : running
        ? "var(--color-signal)"
        : "var(--color-good)";

  // Segments of the outcome ring, in a fixed order so the eye learns where to
  // look: green from twelve o'clock, then failures, then what never ran.
  const segments = executed
    ? [
        { value: totals.passed, color: "var(--color-good)", title: `${totals.passed} passed` },
        { value: totals.failed, color: "var(--color-attend)", title: `${totals.failed} failed` },
        { value: totals.skipped, color: "var(--color-ink-400)", title: `${totals.skipped} skipped` },
      ]
    : [];

  let cursor = 0;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        {/* Empty tracks, so a run with nothing on it still reads as an
            instrument at rest rather than as a rendering failure. */}
        <circle cx={cx} cy={cy} r={rOuter} fill="none" stroke="var(--color-ink-300)" strokeWidth={6} />
        <circle cx={cx} cy={cy} r={rInner} fill="none" stroke="var(--color-ink-200)" strokeWidth={2} />

        {segments.map((seg, i) => {
          if (seg.value <= 0) return null;
          const from = cursor;
          const to = cursor + seg.value / executed;
          cursor = to;
          return (
            <path
              key={i}
              d={arc(cx, cy, rOuter, from, Math.min(to, 0.9995))}
              fill="none"
              stroke={seg.color}
              strokeWidth={6}
              strokeLinecap="butt"
            >
              <title>{seg.title}</title>
            </path>
          );
        })}

        {reached > 0 && (
          <path
            className={running ? "live" : undefined}
            d={arc(cx, cy, rInner, 0, Math.max(0.002, reached / STAGE_ORDER.length))}
            fill="none"
            stroke={running ? "var(--color-signal)" : "var(--color-signal-deep)"}
            strokeWidth={2}
            strokeLinecap="round"
          />
        )}

        {/* Graduations on the inner scale. A scale without them is a bar bent
            into a circle. */}
        {STAGE_ORDER.map((_, i) => {
          const p = point(cx, cy, rInner, i / STAGE_ORDER.length);
          return <circle key={i} cx={p.x} cy={p.y} r={1.1} fill="var(--color-ink-400)" />;
        })}
      </svg>

      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center leading-none">
          <div
            className="readout"
            style={{
              fontSize: 28,
              fontWeight: 500,
              color: centreTone,
              textShadow: `0 0 28px color-mix(in srgb, ${centreTone} 45%, transparent)`,
            }}
          >
            {running ? `${reached}/${STAGE_ORDER.length}` : String(confirmed.length).padStart(2, "0")}
          </div>
          <div className="mt-1.5">
            <Label style={{ fontSize: 9 }}>{running ? "stage" : "confirmed"}</Label>
          </div>
          {!running && executed > 0 && (
            <div className="readout mt-1 text-[10px]" style={{ color: "var(--color-dim)" }}>
              {Math.round((totals.passed / executed) * 100)}% green
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
