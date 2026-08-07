import type { CSSProperties, ReactNode } from "react";
import type { Severity, Tier } from "@clarvis/core/types";

/**
 * The vocabulary. Everything else is assembled from these.
 *
 * Two encodings, kept apart so they never argue:
 *   SEVERITY -> hue.       How much it matters.
 *   TIER     -> luminance. How sure we are.
 * A discarded critical dims to almost nothing while a confirmed low still
 * reads clearly, which is the correct relative weight for a reader deciding
 * what to look at next.
 */

/* ------------------------------------------------------------------ type */

export function Label({
  children,
  tone,
  className = "",
  style,
}: {
  children: ReactNode;
  tone?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={`lbl ${className}`} style={{ color: tone, ...style }}>
      {children}
    </span>
  );
}

/** Staggered entry. Capped, so a long list does not take a second to arrive. */
export function settle(i: number): CSSProperties {
  return { animationDelay: `${Math.min(i, 12) * 28}ms` };
}

/* -------------------------------------------------------------- severity */

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--color-sev-critical)",
  high: "var(--color-sev-high)",
  medium: "var(--color-sev-medium)",
  low: "var(--color-sev-low)",
};

export function severityColor(s: Severity): string {
  return SEVERITY_COLOR[s];
}

/**
 * Confidence as luminance.
 *
 * `dim` is applied to the whole row, so a discarded finding recedes without
 * being hidden - it is still there to be read, it just stops competing.
 */
export const TIER_PROMINENCE: Record<Tier, { dim: number; weight: number }> = {
  CONFIRMED: { dim: 1, weight: 600 },
  PLAUSIBLE: { dim: 0.82, weight: 500 },
  QUESTION: { dim: 0.6, weight: 400 },
  DISCARDED: { dim: 0.34, weight: 400 },
};

export function SeverityChip({ severity, dimmed = false }: { severity: Severity; dimmed?: boolean }) {
  const color = severityColor(severity);
  return (
    <span
      className="lbl inline-flex items-center gap-1.5 px-1.5 py-0.5"
      style={{
        color,
        opacity: dimmed ? 0.55 : 1,
        background: `color-mix(in srgb, ${color} 11%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 26%, transparent)`,
        borderRadius: "var(--radius-sm)",
      }}
    >
      {severity}
    </span>
  );
}

const TIER_LOOK: Record<Tier, { color: string; fill: number }> = {
  CONFIRMED: { color: "var(--color-signal)", fill: 1 },
  PLAUSIBLE: { color: "var(--color-attend)", fill: 0.55 },
  QUESTION: { color: "var(--color-muted)", fill: 0.3 },
  DISCARDED: { color: "var(--color-dim)", fill: 0 },
};

/**
 * Confidence as a filled bar rather than a word.
 *
 * Four states read at a glance from how full it is, which is faster than
 * reading four labels that all begin differently.
 */
export function TierMark({ tier }: { tier: Tier }) {
  const { color, fill } = TIER_LOOK[tier];
  return (
    <span className="inline-flex items-center gap-2" title={tier}>
      <span className="flex gap-[2px]">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="block h-[9px] w-[3px]"
            style={{
              background: i < Math.round(fill * 4) ? color : "var(--color-ink-400)",
              borderRadius: "1px",
            }}
          />
        ))}
      </span>
      <span className="lbl" style={{ color }}>
        {tier}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------- structure */

export function Panel({
  children,
  label,
  aside,
  raised = false,
  className = "",
  style,
}: {
  children: ReactNode;
  label?: ReactNode;
  /** Right-aligned in the header. A count, a total, a status. */
  aside?: ReactNode;
  raised?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={`${raised ? "surface-raised" : "surface"} ${className}`} style={style}>
      {(label || aside) && (
        <header className="flex items-baseline gap-3 px-4 pt-3.5 pb-2.5">
          {label && <Label>{label}</Label>}
          {aside && <div className="ml-auto">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Dot({ color, live = false }: { color: string; live?: boolean }) {
  return (
    <span
      className={`inline-block size-[5px] shrink-0 rounded-full ${live ? "live" : ""}`}
      style={{ background: color, boxShadow: `0 0 8px -1px ${color}` }}
    />
  );
}

/**
 * A number that matters, with its name underneath.
 *
 * The figure is set large in mono with tabular numerals so a row of these
 * lines up on the decimal, which is most of what makes a panel of readings
 * look measured rather than typeset.
 */
export function Readout({
  value,
  label,
  tone = "var(--color-bright)",
  sub,
  emphasis = false,
}: {
  value: ReactNode;
  label: string;
  tone?: string;
  sub?: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div
        className="readout leading-none"
        style={{
          color: tone,
          fontSize: emphasis ? 30 : 22,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          textShadow: emphasis ? `0 0 26px color-mix(in srgb, ${tone} 45%, transparent)` : undefined,
        }}
      >
        {value}
      </div>
      <div className="mt-1.5 truncate">
        <Label>{label}</Label>
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-[var(--color-dim)]">{sub}</div>}
    </div>
  );
}

/** A labelled pair. Used where a form would be overkill. */
export function Field({ k, v, mono = true }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <Label className="w-[104px] shrink-0">{k}</Label>
      <div className={`min-w-0 flex-1 text-[12px] ${mono ? "readout" : "prose"}`} style={{ color: "var(--color-body)" }}>
        {v}
      </div>
    </div>
  );
}

/**
 * A proportion, drawn.
 *
 * Deliberately not a percentage in text: the point of a coverage figure is
 * how much is missing, and a bar shows that without arithmetic.
 */
export function Bar({
  parts,
  height = 4,
}: {
  parts: Array<{ value: number; color: string; title?: string }>;
  height?: number;
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0) || 1;
  return (
    <div
      className="surface-sunken flex w-full overflow-hidden"
      style={{ height, borderRadius: 99, padding: 0 }}
    >
      {parts.map((p, i) =>
        p.value > 0 ? (
          <div
            key={i}
            title={p.title}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
          />
        ) : null,
      )}
    </div>
  );
}

/** Monospaced, selectable, and clipped rather than wrapped. */
export function Mono({ children, tone = "var(--color-muted)" }: { children: ReactNode; tone?: string }) {
  return (
    <code className="readout text-[11.5px]" style={{ color: tone }}>
      {children}
    </code>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="prose px-4 pb-4 text-[12px]" style={{ color: "var(--color-dim)" }}>
      {children}
    </p>
  );
}
