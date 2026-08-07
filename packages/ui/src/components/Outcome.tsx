import { useState } from "react";
import type { DraftsLike, VerdictLike } from "../data";
import { Label, Mono, settle } from "./primitives";

/**
 * What happens next: the release call, and the tickets.
 *
 * Both were written to disk by teams that ran, and neither had ever been
 * readable outside a terminal - so two of the six fleets did work nobody could
 * see. DISPATCH in particular refuses to file anything by default, which means
 * its drafts sit on disk waiting for a human, and a human who cannot read them
 * is a human who will not file them.
 */

const DECISION: Record<string, { tone: string; text: string }> = {
  ship: { tone: "var(--color-good)", text: "ship" },
  hold: { tone: "var(--color-sev-critical)", text: "hold" },
  "ship-with-risk": { tone: "var(--color-attend)", text: "ship, with risk" },
};

function Verdict({ verdict }: { verdict: VerdictLike }) {
  const decision = verdict.verdict?.decision ?? "unknown";
  const look = DECISION[decision] ?? { tone: "var(--color-muted)", text: decision };

  return (
    <section className="surface-raised" style={{ borderLeft: `2px solid ${look.tone}` }}>
      <div className="px-4 py-4">
        <Label tone={look.tone}>the call</Label>
        <div
          className="mt-1.5 text-[26px] leading-none"
          style={{ color: look.tone, fontWeight: 600, letterSpacing: "-0.01em" }}
        >
          {look.text}
        </div>

        {verdict.summary && (
          <p className="prose mt-3 max-w-[68ch] text-[12.5px]" style={{ color: "var(--color-body)" }}>
            {verdict.summary}
          </p>
        )}

        {verdict.verdict?.reason && (
          <p className="prose mt-2 max-w-[68ch] text-[11.5px]" style={{ color: "var(--color-dim)" }}>
            {verdict.verdict.reason}
          </p>
        )}
      </div>

      {/*
        The limits are the most important thing on this panel and the part
        everyone skips. A clean run over three routes and a clean run over a
        whole application produce an identical verdict; this is the only place
        that difference is written down.
      */}
      {verdict.limits?.length ? (
        <div className="border-t px-4 py-3.5" style={{ borderColor: "var(--color-hair)" }}>
          <Label tone="var(--color-attend)">what this verdict does not cover</Label>
          <ul className="mt-2 space-y-1.5">
            {verdict.limits.map((l, i) => (
              <li key={i} className="prose flex gap-2.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                <span style={{ color: "var(--color-attend)" }}>·</span>
                {l}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {verdict.releaseNotes?.length ? (
        <div className="border-t px-4 py-3.5" style={{ borderColor: "var(--color-hair)" }}>
          <Label>release notes</Label>
          <ul className="mt-2 space-y-1">
            {verdict.releaseNotes.map((n, i) => (
              <li key={i} className="prose text-[12px]" style={{ color: "var(--color-body)" }}>
                {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Ticket({
  draft,
  index,
}: {
  draft: NonNullable<DraftsLike["drafts"]>[number];
  index: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <li className="settle" style={settle(index)}>
      <div className="surface">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="focusable flex w-full items-start gap-3 px-4 py-3 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] leading-snug" style={{ color: "var(--color-bright)", fontWeight: 500 }}>
              {draft.title ?? "(untitled)"}
            </span>
            {draft.labels?.length ? (
              <span className="mt-1 flex flex-wrap gap-2">
                {draft.labels.map((l) => (
                  <Mono key={l} tone="var(--color-dim)">
                    {l}
                  </Mono>
                ))}
              </span>
            ) : null}
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-2.5">
            <Label tone={draft.published ? "var(--color-good)" : "var(--color-attend)"}>
              {draft.published ? "filed" : "not filed"}
            </Label>
            <span
              className="text-[11px] transition-transform"
              style={{ color: "var(--color-dim)", transform: open ? "rotate(90deg)" : "none" }}
              aria-hidden
            >
              ›
            </span>
          </span>
        </button>

        {open && (
          <div className="px-4 pb-4">
            {draft.refusedBecause && (
              <p
                className="prose mb-3 px-3 py-2 text-[11.5px]"
                style={{
                  color: "var(--color-attend)",
                  border: "1px dashed color-mix(in srgb, var(--color-attend) 34%, transparent)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                Not filed: {draft.refusedBecause}
              </p>
            )}
            {/* Whitespace preserved - this text gets pasted into a tracker. */}
            <pre
              className="prose whitespace-pre-wrap text-[12px]"
              style={{ color: "var(--color-body)", fontFamily: "var(--font-sans)" }}
            >
              {draft.body ?? "(no body)"}
            </pre>
          </div>
        )}
      </div>
    </li>
  );
}

export function Outcome({ verdict, drafts }: { verdict?: VerdictLike; drafts?: DraftsLike }) {
  const tickets = drafts?.drafts ?? [];

  if (!verdict && !tickets.length) {
    return (
      <div className="px-5 py-6 lg:px-8">
        <div className="surface px-4 py-5">
          <p className="prose text-[12.5px]" style={{ color: "var(--color-dim)" }}>
            No verdict and no tickets for this run. DISPATCH and CLEARANCE either were not enabled
            or had nothing confirmed to act on - a ticket is only drafted for a finding that
            survived triage.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-5 py-6 lg:px-8">
      {verdict && <Verdict verdict={verdict} />}

      {tickets.length > 0 && (
        <section>
          <header className="flex items-baseline gap-3 pb-3">
            <Label>tickets</Label>
            <span className="text-[11px]" style={{ color: "var(--color-dim)" }}>
              drafted for a human to file
            </span>
            <span className="readout ml-auto text-[11px]" style={{ color: "var(--color-dim)" }}>
              {tickets.filter((t) => t.published).length} of {tickets.length} filed
            </span>
          </header>
          <ul className="space-y-2">
            {tickets.map((d, i) => (
              <Ticket key={d.findingId ?? i} draft={d} index={i} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
