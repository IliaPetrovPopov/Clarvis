import { useState } from "react";
import type { Finding, Run, Tier } from "@clarvis/core/types";
import { Hud, KeyValue, Label, SeverityChip, TierMark, TIER_PROMINENCE, stagger } from "./primitives";

const TIER_ORDER: Tier[] = ["CONFIRMED", "PLAUSIBLE", "QUESTION", "DISCARDED"];
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function rank(f: Finding) {
  return TIER_ORDER.indexOf(f.tier) * 10 + SEVERITY_ORDER.indexOf(f.severity);
}

function Artifact({ label, path }: { label: string; path?: string }) {
  if (!path) return null;
  const name = path.split("/").pop();
  return (
    <div
      className="hud-clip-sm flex items-center gap-2 px-2.5 py-1.5"
      style={{ border: "1px solid var(--color-edge)", background: "var(--color-deep)" }}
      title={path}
    >
      <span className="label shrink-0" style={{ fontSize: "9px" }}>
        {label}
      </span>
      <span className="truncate text-[11px]" style={{ color: "var(--color-muted)" }}>
        {name}
      </span>
    </div>
  );
}

function Determinism({ finding }: { finding: Finding }) {
  const d = finding.determinism;
  if (!d?.runs) return null;

  const color =
    d.verdict === "deterministic"
      ? "var(--color-green)"
      : d.verdict === "flaky"
        ? "var(--color-amber)"
        : "var(--color-dim)";

  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex gap-1">
        {Array.from({ length: d.runs }, (_, i) => (
          <span
            key={i}
            className="block size-[5px] rotate-45"
            style={{
              background: i < (d.failures ?? 0) ? color : "var(--color-edge-bright)",
              boxShadow: i < (d.failures ?? 0) ? `0 0 6px ${color}` : undefined,
            }}
          />
        ))}
      </span>
      <span style={{ color }}>
        {d.failures}/{d.runs} cold {d.verdict && `· ${d.verdict}`}
      </span>
    </span>
  );
}

function FindingCard({ finding, index }: { finding: Finding; index: number }) {
  const [open, setOpen] = useState(finding.tier === "CONFIRMED" && finding.severity === "critical");
  const prom = TIER_PROMINENCE[finding.tier];
  const discarded = finding.tier === "DISCARDED";

  return (
    <li className="rise" style={stagger(index + 2)}>
      <Hud tone={prom.edge} style={{ opacity: prom.opacity }}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-start gap-4 px-4 py-3.5 text-left transition-colors hover:bg-[var(--color-raised)]"
          aria-expanded={open}
        >
          <div className="mt-[3px] shrink-0">
            <SeverityChip severity={finding.severity} dimmed={discarded} />
          </div>

          <div className="min-w-0 flex-1">
            <h3
              className={`hud-type text-[15px] leading-snug ${prom.glow ? "" : ""}`}
              style={{
                color: prom.text,
                textDecoration: discarded ? "line-through" : undefined,
                textDecorationColor: "var(--color-dim)",
              }}
            >
              {finding.title}
            </h3>

            <div
              className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]"
              style={{ color: "var(--color-dim)" }}
            >
              <span>{finding.axis}</span>
              {finding.route && <span>· {finding.route}</span>}
              {finding.role && <span>· as {finding.role}</span>}
              {finding.locale && <span>· {finding.locale}</span>}
              {finding.viewport && <span>· {finding.viewport}</span>}
              <Determinism finding={finding} />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {finding.tracker?.status === "drafted" && (
              <span className="label" style={{ color: "var(--color-amber)", fontSize: "9.5px" }}>
                draft ready
              </span>
            )}
            <TierMark tier={finding.tier} />
            <svg
              viewBox="0 0 10 6"
              className="size-2.5 transition-transform"
              style={{ transform: open ? "rotate(180deg)" : undefined }}
              fill="none"
              aria-hidden
            >
              <path d="M1 1l4 4 4-4" stroke="var(--color-cyan)" strokeWidth="1.3" />
            </svg>
          </div>
        </button>

        {open && (
          <div
            className="border-t px-4 pt-4 pb-4"
            style={{ borderColor: "var(--color-edge)", background: "var(--color-deep)" }}
          >
            {/*
              The oracle comes first. It answers "how do you know this is wrong?"
              Without it a finding is only an opinion, so it leads the panel.
            */}
            <div
              className="px-4 py-3"
              style={{
                borderLeft: `2px solid ${
                  finding.oracle.type === "none" ? "var(--color-dim)" : "var(--color-cyan)"
                }`,
                background: "color-mix(in srgb, var(--color-panel) 80%, transparent)",
              }}
            >
              <Label style={{ color: finding.oracle.type === "none" ? undefined : "var(--color-cyan)" }}>
                oracle / {finding.oracle.type === "none" ? "NONE CITED" : finding.oracle.type}
              </Label>
              {finding.oracle.quote ? (
                <p className="mt-2 text-[13px] leading-snug" style={{ color: "var(--color-body)" }}>
                  "{finding.oracle.quote}"
                </p>
              ) : (
                <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-dim)" }}>
                  No source of truth cited - severity is capped and this cannot be CONFIRMED.
                </p>
              )}
              {finding.oracle.citation && (
                <div className="mt-1.5 text-[11px]" style={{ color: "var(--color-dim)" }}>
                  {finding.oracle.citation}
                </div>
              )}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <Label>expected</Label>
                <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--color-green)" }}>
                  {finding.expected}
                </p>
              </div>
              <div>
                <Label>actual</Label>
                <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--color-sev-high)" }}>
                  {finding.actual}
                </p>
              </div>
            </div>

            {finding.steps && finding.steps.length > 0 && (
              <div className="mt-4">
                <Label>reproduction</Label>
                <ol className="mt-2 space-y-1">
                  {finding.steps.map((step, i) => (
                    <li key={i} className="flex gap-2.5 text-[12px]">
                      <span className="shrink-0 tabular-nums" style={{ color: "var(--color-cyan-dim)" }}>
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span style={{ color: "var(--color-body)" }}>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <div className="mt-4">
              <Label>evidence</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                <Artifact label="spec" path={finding.evidence.specFile} />
                <Artifact label="trace" path={finding.evidence.tracePath} />
                <Artifact label="network" path={finding.evidence.networkLogPath} />
                <Artifact label="console" path={finding.evidence.consoleLogPath} />
                {finding.evidence.screenshots?.map((s) => (
                  <Artifact key={s} label="shot" path={s} />
                ))}
              </div>
            </div>

            <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-edge)" }}>
              {finding.tierReason && <KeyValue k="triage" v={finding.tierReason} />}
              {finding.negativeControl?.ran && (
                <KeyValue
                  k="neg. control"
                  v={
                    finding.negativeControl.alsoFailed ? (
                      <span style={{ color: "var(--color-amber)" }}>
                        Also fails on {finding.negativeControl.ref} - pre-existing, not introduced here.
                      </span>
                    ) : (
                      <span style={{ color: "var(--color-green)" }}>
                        Passes on {finding.negativeControl.ref} - introduced by the current working tree.
                      </span>
                    )
                  }
                />
              )}
              <KeyValue
                k="chain"
                v={
                  <span style={{ color: "var(--color-muted)" }}>
                    found by {finding.foundBy ?? "--"} · verified cold by{" "}
                    {finding.verifiedBy ?? <span style={{ color: "var(--color-amber)" }}>nobody</span>}
                  </span>
                }
              />
              {finding.locator && <KeyValue k="locator" v={<code>{finding.locator}</code>} />}
            </div>
          </div>
        )}
      </Hud>
    </li>
  );
}

export function Findings({ run }: { run: Run }) {
  const [showDiscarded, setShowDiscarded] = useState(false);

  const sorted = [...run.findings].sort((a, b) => rank(a) - rank(b));
  const discardedCount = sorted.filter((f) => f.tier === "DISCARDED").length;
  const visible = showDiscarded ? sorted : sorted.filter((f) => f.tier !== "DISCARDED");

  return (
    <section className="px-8 pb-10">
      <div className="rise flex items-center justify-between gap-4" style={stagger(1)}>
        <Label>findings / ranked by confidence, then impact</Label>
        {discardedCount > 0 && (
          <button
            onClick={() => setShowDiscarded((v) => !v)}
            className="label transition-colors hover:text-[var(--color-cyan)]"
            style={{ color: showDiscarded ? "var(--color-muted)" : "var(--color-dim)" }}
          >
            {showDiscarded ? "hide" : "show"} {discardedCount} discarded
          </button>
        )}
      </div>

      <ul className="mt-3 space-y-2">
        {visible.map((f, i) => (
          <FindingCard key={f.id} finding={f} index={i} />
        ))}
      </ul>

      {run.findings.length === 0 && (
        <p className="mt-4 text-[12px]" style={{ color: "var(--color-dim)" }}>
          No findings recorded for this run. Check coverage above before reading that as good news.
        </p>
      )}

      {/*
        Explicitly rendered, never collapsed: a bounded run must not read as full
        coverage. "Found nothing" is only meaningful next to "looked here".
      */}
      {run.truncation && run.truncation.length > 0 && (
        <div
          className="rise hud-clip mt-8 px-4 py-3.5"
          style={{
            border: "1px dashed color-mix(in srgb, var(--color-amber) 45%, transparent)",
            background: "color-mix(in srgb, var(--color-amber) 5%, transparent)",
          }}
        >
          <Label style={{ color: "var(--color-amber)" }}>not covered by this run</Label>
          <ul className="mt-2 space-y-1">
            {run.truncation.map((t, i) => (
              <li key={i} className="flex gap-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                <span style={{ color: "var(--color-amber)" }}>·</span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
