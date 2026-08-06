import type { CSSProperties, ReactNode } from "react";
import type { Severity, Tier } from "@clarvis/core/types";

export function Label({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`label ${className}`} style={style}>
      {children}
    </div>
  );
}

/** Typed helper for the stagger index consumed by `.rise`. */
export function stagger(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

/* ----------------------------------------------------------------- frames */

/**
 * Angular HUD frame. Two nested clipped layers: the outer is the lit 1px edge,
 * the inner is inset and carries the fill, so the cut corners stay crisp where
 * a plain CSS border would square them off.
 */
export function Hud({
  children,
  tone = "var(--color-edge)",
  fill = "color-mix(in srgb, var(--color-panel) 88%, transparent)",
  className = "",
  style,
  small = false,
}: {
  children: ReactNode;
  tone?: string;
  fill?: string;
  className?: string;
  style?: CSSProperties;
  small?: boolean;
}) {
  const clip = small ? "hud-clip-sm" : "hud-clip";
  return (
    <div
      className={`${clip} ${className}`}
      style={{ background: tone, boxShadow: `0 0 22px -8px ${tone}`, ...style }}
    >
      <div className={clip} style={{ background: fill, margin: 1 }}>
        {children}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- severity */

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--color-sev-critical)",
  high: "var(--color-sev-high)",
  medium: "var(--color-sev-medium)",
  low: "var(--color-sev-low)",
};

export function severityColor(s: Severity): string {
  return SEVERITY_COLOR[s];
}

/** Severity is the only thing in the system that changes hue. */
export function SeverityChip({ severity, dimmed = false }: { severity: Severity; dimmed?: boolean }) {
  const color = SEVERITY_COLOR[severity];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span
        aria-hidden
        className="block size-2 shrink-0 rotate-45"
        style={{ background: color, boxShadow: dimmed ? "none" : `0 0 10px ${color}` }}
      />
      <span className="label" style={{ color, letterSpacing: "0.18em" }}>
        {severity}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------- tier */

/**
 * Tier drives luminance, not hue. CONFIRMED burns at full brightness; each step
 * down dims, so confidence is legible before a single word is read.
 */
export const TIER_PROMINENCE: Record<
  Tier,
  { opacity: number; edge: string; text: string; glow: boolean }
> = {
  CONFIRMED: { opacity: 1, edge: "var(--color-cyan-dim)", text: "var(--color-bright)", glow: true },
  PLAUSIBLE: { opacity: 0.85, edge: "var(--color-edge-bright)", text: "var(--color-body)", glow: false },
  QUESTION: { opacity: 0.6, edge: "var(--color-edge)", text: "var(--color-muted)", glow: false },
  DISCARDED: { opacity: 0.33, edge: "var(--color-edge)", text: "var(--color-dim)", glow: false },
};

export function TierMark({ tier }: { tier: Tier }) {
  const confirmed = tier === "CONFIRMED";
  return (
    <span
      className="hud-clip-sm label px-2 py-0.5"
      style={{
        color: confirmed ? "var(--color-void)" : "var(--color-muted)",
        background: confirmed ? "var(--color-cyan)" : "transparent",
        border: `1px solid ${confirmed ? "var(--color-cyan)" : "var(--color-edge)"}`,
        boxShadow: confirmed ? "0 0 16px -2px var(--color-cyan)" : undefined,
        fontSize: "10px",
      }}
    >
      {tier}
    </span>
  );
}

/* ------------------------------------------------------------------- stats */

export function Stat({
  label,
  value,
  tone = "body",
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "body" | "cyan" | "amber" | "green" | "dim";
  hint?: string;
}) {
  const color = {
    body: "var(--color-bright)",
    cyan: "var(--color-cyan)",
    amber: "var(--color-amber)",
    green: "var(--color-green)",
    dim: "var(--color-dim)",
  }[tone];

  const lit = tone === "cyan" || tone === "amber" || tone === "green";

  return (
    <div title={hint}>
      <Label>{label}</Label>
      <div
        className={`hud-type mt-1 text-[30px] leading-none ${lit ? "glow" : ""}`}
        style={{ color }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Circular readout, reserved for coverage - the number that qualifies every
 * verdict. Giving it the most instrument-like form in the system is the point:
 * a result is not readable without it.
 */
export function RingGauge({
  value,
  max,
  size = 116,
  label,
  sublabel,
}: {
  value: number;
  max: number;
  size?: number;
  label: string;
  sublabel?: string;
}) {
  const pct = max > 0 ? Math.min(value / max, 1) : 0;
  const stroke = 3;
  const r = (size - stroke * 2) / 2 - 8;
  const circumference = 2 * Math.PI * r;
  const center = size / 2;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={center} cy={center} r={r} fill="none" stroke="var(--color-edge)" strokeWidth={stroke} />
        <circle
          className="ring-draw"
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke="var(--color-cyan)"
          strokeWidth={stroke}
          strokeDasharray={`${circumference * pct} ${circumference}`}
          style={{
            ["--circumference" as string]: `${circumference * pct}`,
            filter: "drop-shadow(0 0 6px var(--color-cyan))",
          }}
        />
        <g opacity="0.55">
          {Array.from({ length: 24 }, (_, i) => {
            const a = (i / 24) * Math.PI * 2;
            const r1 = r + 5;
            const r2 = r + 9;
            return (
              <line
                key={i}
                x1={center + Math.cos(a) * r1}
                y1={center + Math.sin(a) * r1}
                x2={center + Math.cos(a) * r2}
                y2={center + Math.sin(a) * r2}
                stroke={i / 24 <= pct ? "var(--color-cyan)" : "var(--color-edge)"}
                strokeWidth="1"
              />
            );
          })}
        </g>
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="hud-type glow text-[27px] leading-none" style={{ color: "var(--color-cyan)" }}>
            {Math.round(pct * 100)}
            <span className="text-[13px]">%</span>
          </div>
          <div className="label mt-1" style={{ fontSize: "9px", letterSpacing: "0.16em" }}>
            {label}
          </div>
          {sublabel && (
            <div className="mt-0.5 text-[9px]" style={{ color: "var(--color-dim)" }}>
              {sublabel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Hairline segmented bar. Used for per-axis result composition. */
export function Meter({
  segments,
  height = 3,
}: {
  segments: Array<{ value: number; color: string; title?: string }>;
  height?: number;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;
  return (
    <div
      className="flex w-full gap-px overflow-hidden"
      style={{ height, background: "var(--color-edge)" }}
    >
      {segments.map((s, i) =>
        s.value <= 0 ? null : (
          <div
            key={i}
            title={s.title}
            style={{
              width: `${(s.value / total) * 100}%`,
              background: s.color,
              boxShadow: `0 0 8px -1px ${s.color}`,
            }}
          />
        ),
      )}
    </div>
  );
}

export function Dot({ color, pulsing = false }: { color: string; pulsing?: boolean }) {
  return (
    <span
      aria-hidden
      className={`block size-[6px] shrink-0 rotate-45 ${pulsing ? "pulse" : ""}`}
      style={{ background: color, boxShadow: `0 0 8px ${color}` }}
    />
  );
}

export function KeyValue({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex gap-3 py-1">
      <div className="label w-[112px] shrink-0 pt-[2px]" style={{ fontSize: "10px" }}>
        {k}
      </div>
      <div className="min-w-0 flex-1 text-[12px]" style={{ color: "var(--color-body)" }}>
        {v}
      </div>
    </div>
  );
}
