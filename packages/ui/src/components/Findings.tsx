import { useState } from "react";
import type { Finding, Run } from "@clarvis/core/types";
import { Label, Mono, SeverityChip, TierMark, TIER_PROMINENCE, settle } from "./primitives";

/**
 * What is wrong, ranked so the first row is the one to read.
 *
 * The ordering is confidence first, then impact. A confirmed medium outranks a
 * plausible critical, because acting on the second means spending an engineer
 * on something that may not exist - and a tool that cries wolf twice is not
 * consulted a third time.
 *
 * A row is closed by default and opens to the evidence. Only the first
 * confirmed critical starts open: it is the single thing most likely to be
 * why the page was opened at all.
 */

const TIER_ORDER = ["CONFIRMED", "PLAUSIBLE", "QUESTION", "DISCARDED"];
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function rank(f: Finding): number {
  return TIER_ORDER.indexOf(f.tier) * 10 + SEVERITY_ORDER.indexOf(f.severity);
}

/** A pointer to something on disk. Selectable, because it gets pasted. */
function Artifact({ label, path }: { label: string; path?: string }) {
  if (!path) return null;
  const name = path.split("/").slice(-1)[0];
  return (
    <span
      className="surface-sunken inline-flex items-baseline gap-2 px-2 py-1"
      title={path}
      style={{ borderRadius: "var(--radius-sm)" }}
    >
      <Label>{label}</Label>
      <Mono tone="var(--color-muted)">{name}</Mono>
    </span>
  );
}

function Row({ finding, index }: { finding: Finding; index: number }) {
  const prominence = TIER_PROMINENCE[finding.tier];
  const [open, setOpen] = useState(
    finding.tier === "CONFIRMED" && finding.severity === "critical" && index === 0,
  );

  const accent =
    finding.tier === "CONFIRMED"
      ? `color-mix(in srgb, ${
          finding.severity === "critical" ? "var(--color-sev-critical)" : "var(--color-attend)"
        } 55%, transparent)`
      : "transparent";

  return (
    <li className="settle" style={settle(index)}>
      <div
        className={open ? "surface-raised" : "surface"}
        style={{ opacity: prominence.dim, borderLeft: `2px solid ${accent}` }}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="focusable flex w-full items-start gap-3 px-4 py-3 text-left"
        >
          <span className="mt-[3px] shrink-0">
            <SeverityChip severity={finding.severity} dimmed={finding.tier === "DISCARDED"} />
          </span>

          <span className="min-w-0 flex-1">
            <span
              className="block text-[13.5px] leading-snug"
              style={{ color: "var(--color-bright)", fontWeight: prominence.weight }}
            >
              {finding.title}
            </span>

            {/* Where it happened, in the terms a person would repeat it in. */}
            <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {[
                finding.axis,
                finding.route,
                finding.role && `as ${finding.role}`,
                finding.locale,
                finding.viewport,
              ]
                .filter(Boolean)
                .map((bit, i) => (
                  <Mono key={i} tone="var(--color-dim)">
                    {bit}
                  </Mono>
                ))}
              {finding.determinism?.verdict && (
                <Label
                  tone={
                    finding.determinism.verdict === "deterministic"
                      ? "var(--color-good)"
                      : "var(--color-attend)"
                  }
                >
                  {finding.determinism.runs
                    ? `${finding.determinism.failures ?? 0}/${finding.determinism.runs} `
                    : ""}
                  {finding.determinism.verdict}
                </Label>
              )}
            </span>
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-3">
            {finding.tracker?.status && finding.tracker.status !== "none" && (
              <Label tone="var(--color-dim)">{finding.tracker.status}</Label>
            )}
            <TierMark tier={finding.tier} />
            <span
              className="text-[11px] transition-transform"
              style={{
                color: "var(--color-dim)",
                transform: open ? "rotate(90deg)" : "none",
              }}
              aria-hidden
            >
              ›
            </span>
          </span>
        </button>

        {open && (
          <div className="px-4 pb-4">
            {/*
              The oracle comes first. It answers "how do you know this is
              wrong?", and a finding whose answer is weak should be read
              differently from one quoting a written requirement - so the
              answer is placed before the claim rather than after it.
            */}
            <div
              className="surface-sunken px-3 py-2.5"
              style={{
                borderLeft: `2px solid ${
                  finding.oracle.type === "none" ? "var(--color-ink-400)" : "var(--color-signal)"
                }`,
              }}
            >
              <Label tone={finding.oracle.type === "none" ? undefined : "var(--color-signal)"}>
                {finding.oracle.type === "none" ? "nothing cited" : finding.oracle.type}
              </Label>
              {finding.oracle.quote ? (
                <p className="prose mt-1.5 text-[12px]" style={{ color: "var(--color-body)" }}>
                  &ldquo;{finding.oracle.quote}&rdquo;
                </p>
              ) : (
                <p className="prose mt-1.5 text-[12px]" style={{ color: "var(--color-dim)" }}>
                  Nothing written was contradicted. This rests on what the code appears to intend,
                  which is the weakest evidence the tier system accepts.
                </p>
              )}
              {finding.oracle.citation && (
                <div className="mt-1.5">
                  <Mono tone="var(--color-dim)">{finding.oracle.citation}</Mono>
                </div>
              )}
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <div>
                <Label>expected</Label>
                <p className="prose mt-1 text-[12px]" style={{ color: "var(--color-good)" }}>
                  {finding.expected}
                </p>
              </div>
              <div>
                <Label>actual</Label>
                <p
                  className="prose mt-1 whitespace-pre-wrap text-[12px]"
                  style={{ color: "var(--color-sev-high)" }}
                >
                  {finding.actual}
                </p>
              </div>
            </div>

            {finding.steps?.length ? (
              <div className="mt-3">
                <Label>to reproduce</Label>
                <ol className="mt-1.5 space-y-1">
                  {finding.steps.map((s, i) => (
                    <li key={i} className="flex gap-2.5 text-[12px]">
                      <span className="readout shrink-0" style={{ color: "var(--color-ink-500)" }}>
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="prose" style={{ color: "var(--color-body)" }}>
                        {s}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <Artifact label="spec" path={finding.evidence.specFile} />
              <Artifact label="trace" path={finding.evidence.tracePath} />
              {finding.evidence.screenshots?.map((s, i) => (
                <Artifact key={i} label="shot" path={s} />
              ))}
              <Artifact label="network" path={finding.evidence.networkLogPath} />
            </div>

            {(finding.tierReason || finding.negativeControl || finding.locator) && (
              <div className="mt-3 space-y-1 border-t pt-3" style={{ borderColor: "var(--color-hair)" }}>
                {finding.tierReason && (
                  <p className="prose text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    {finding.tierReason}
                  </p>
                )}
                {finding.negativeControl?.ran && (
                  <p className="prose text-[11.5px]" style={{ color: "var(--color-attend)" }}>
                    {finding.negativeControl.alsoFailed
                      ? `Also fails on ${finding.negativeControl.ref ?? "the base"} - pre-existing, not introduced here.`
                      : `Passes on ${finding.negativeControl.ref ?? "the base"}, so this change introduced it.`}
                  </p>
                )}
                {finding.locator && (
                  <div>
                    <Mono tone="var(--color-dim)">{finding.locator}</Mono>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * One line of what a run did not cover.
 *
 * Most are a sentence. A few are triage explaining, at length and correctly,
 * why a failure was its own spec's fault - four hundred words of reasoning
 * that belongs on the record but not in a bulleted list, where it buries the
 * twelve short entries around it under one long one.
 *
 * Clamped rather than cut: the reasoning is the evidence for a finding being
 * discarded, and a summary of it would be a summary of exactly the thing a
 * sceptical reader wants to check.
 */
function Gap({ text }: { text: string }) {
  const long = text.length > 240;
  const [open, setOpen] = useState(false);

  return (
    <li className="prose flex gap-2.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
      <span style={{ color: "var(--color-attend)" }}>·</span>
      <span className="min-w-0">
        {long && !open ? `${text.slice(0, 240).trimEnd()}...` : text}
        {long && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="focusable lbl ml-2 align-baseline"
            style={{ color: "var(--color-attend)" }}
          >
            {open ? "less" : "more"}
          </button>
        )}
      </span>
    </li>
  );
}

export function Findings({ run }: { run: Run }) {
  const [showDiscarded, setShowDiscarded] = useState(false);
  const all = [...(run.findings ?? [])].sort((a, b) => rank(a) - rank(b));
  const discarded = all.filter((f) => f.tier === "DISCARDED");
  const shown = showDiscarded ? all : all.filter((f) => f.tier !== "DISCARDED");

  return (
    <section className="px-5 py-6 lg:px-8">
      <header className="flex items-baseline gap-3 pb-3">
        <Label>findings</Label>
        <span className="text-[11px]" style={{ color: "var(--color-dim)" }}>
          confidence first, then impact
        </span>
        {discarded.length > 0 && (
          <button
            onClick={() => setShowDiscarded((v) => !v)}
            className="focusable lbl ml-auto px-2 py-1"
            style={{
              color: "var(--color-dim)",
              border: "1px solid var(--color-hair-lit)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {showDiscarded ? "hide" : "show"} {discarded.length} discarded
          </button>
        )}
      </header>

      {shown.length ? (
        <ul className="space-y-2">
          {shown.map((f, i) => (
            <Row key={f.id} finding={f} index={i} />
          ))}
        </ul>
      ) : (
        <div className="surface px-4 py-5">
          <p className="prose text-[12.5px]" style={{ color: "var(--color-muted)" }}>
            Nothing was found. Read that next to what was actually reached, above - an empty list
            from a narrow run and an empty list from a thorough one look exactly the same here.
          </p>
        </div>
      )}

      {/*
        Never collapsed, and never below the fold of the findings list: a
        bounded run must not read as full coverage, and this is the only thing
        on the page that says where the boundary was.
      */}
      {run.truncation && run.truncation.length > 0 && (
        <div
          className="settle mt-5 px-4 py-3.5"
          style={{
            border: "1px dashed color-mix(in srgb, var(--color-attend) 38%, transparent)",
            background: "color-mix(in srgb, var(--color-attend) 4%, transparent)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <Label tone="var(--color-attend)">not covered by this run</Label>
          <ul className="mt-2 space-y-1.5">
            {run.truncation.map((t, i) => (
              <Gap key={i} text={t} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
