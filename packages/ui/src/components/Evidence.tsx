import { useState } from "react";
import type { ContextLike, PlanLike, RequirementLike } from "../data";
import { Label, Mono, Readout, settle } from "./primitives";

/**
 * What the run judged against, and what it chose to spend itself on.
 *
 * These two files decide whether a finding means anything. A requirement is
 * the only thing that lets a finding say "this contradicts what was written"
 * rather than "this looked wrong to a model", and the plan is the record of
 * what was deliberately left untested - which is the part a reader is most
 * likely to be surprised by later.
 *
 * Both existed on disk and neither had ever been shown.
 */

const CONFIDENCE_TONE: Record<string, string> = {
  explicit: "var(--color-good)",
  implied: "var(--color-attend)",
  contested: "var(--color-sev-critical)",
};

function Requirement({ req, index }: { req: RequirementLike; index: number }) {
  const [open, setOpen] = useState(false);
  const tone = CONFIDENCE_TONE[req.confidence ?? ""] ?? "var(--color-muted)";

  return (
    <li className="settle" style={settle(index)}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focusable flex w-full items-start gap-3 px-4 py-2.5 text-left"
      >
        <Mono tone="var(--color-signal)">{req.id}</Mono>
        <span className="prose min-w-0 flex-1 text-[12.5px]" style={{ color: "var(--color-body)" }}>
          {req.statement}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {req.confidence && <Label tone={tone}>{req.confidence}</Label>}
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
        <div className="px-4 pb-3 pl-[54px]">
          {/*
            The quote, verbatim. It is checked character for character against
            the source before a requirement is accepted, so showing it is what
            lets a reader confirm the chain themselves rather than trust it.
          */}
          <div
            className="surface-sunken px-3 py-2.5"
            style={{ borderLeft: "2px solid var(--color-signal-deep)" }}
          >
            <Label>quoted from the source</Label>
            <p className="prose mt-1.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
              &ldquo;{req.quote}&rdquo;
            </p>
            {req.sourceIds?.length ? (
              <div className="mt-2">
                <Mono tone="var(--color-dim)">{req.sourceIds.join(", ")}</Mono>
              </div>
            ) : null}
          </div>
          {req.axisHints?.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {req.axisHints.map((a) => (
                <Mono key={a} tone="var(--color-dim)">
                  {a}
                </Mono>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </li>
  );
}

export function Evidence({ context, plan }: { context?: ContextLike; plan?: PlanLike }) {
  const requirements = context?.requirements ?? [];
  const unknowns = context?.unknowns ?? [];

  if (!context && !plan) {
    return (
      <div className="px-5 py-6 lg:px-8">
        <div className="surface px-4 py-5">
          <p className="prose text-[12.5px]" style={{ color: "var(--color-dim)" }}>
            Nothing gathered yet. Run <Mono tone="var(--color-signal)">clarvis research</Mono> to
            collect requirements, and every finding afterwards can cite one instead of resting on
            what the code appears to intend.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-5 py-6 lg:px-8">
      {context && (
        <section className="surface">
          <header className="flex items-baseline gap-3 px-4 pt-4 pb-3">
            <Label>what we judge against</Label>
            {context.gatheredAt && (
              <span className="readout ml-auto text-[11px]" style={{ color: "var(--color-dim)" }}>
                {new Date(context.gatheredAt).toLocaleDateString()}
              </span>
            )}
          </header>

          <div className="grid grid-cols-3 gap-6 px-4 pb-4">
            <Readout value={requirements.length} label="requirements" />
            <Readout
              value={requirements.filter((r) => r.confidence === "explicit").length}
              label="stated outright"
              tone="var(--color-good)"
            />
            <Readout
              value={unknowns.length}
              label="open questions"
              tone={unknowns.length ? "var(--color-attend)" : "var(--color-dim)"}
            />
          </div>

          {requirements.length ? (
            <ul className="divide-y border-t" style={{ borderColor: "var(--color-hair)" }}>
              {requirements.map((r, i) => (
                <Requirement key={r.id} req={r} index={i} />
              ))}
            </ul>
          ) : (
            <p className="prose px-4 pb-4 text-[12px]" style={{ color: "var(--color-dim)" }}>
              No requirement survived verification, so every finding falls back to code intent.
            </p>
          )}

          {/*
            Unknowns are a deliverable, not an admission. They say exactly
            where the testing was blind, which is information a clean report
            otherwise hides.
          */}
          {unknowns.length > 0 && (
            <div className="border-t px-4 py-3.5" style={{ borderColor: "var(--color-hair)" }}>
              <Label tone="var(--color-attend)">nobody could answer these</Label>
              <ul className="mt-2 space-y-2">
                {unknowns.map((u, i) => (
                  <li key={i}>
                    <p className="prose text-[12px]" style={{ color: "var(--color-body)" }}>
                      {u.question}
                    </p>
                    {u.guess && (
                      <p className="prose mt-0.5 text-[11.5px]" style={{ color: "var(--color-dim)" }}>
                        Best guess, not treated as a requirement: {u.guess}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {plan && (
        <section className="surface">
          <header className="px-4 pt-4 pb-2">
            <Label>what this run chose to do</Label>
          </header>

          {plan.rationale && (
            <p className="prose px-4 pb-3 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
              {plan.rationale}
            </p>
          )}

          {plan.axes?.length ? (
            <ol className="divide-y border-t" style={{ borderColor: "var(--color-hair)" }}>
              {plan.axes.map((a, i) => (
                <li key={a.axis} className="settle flex items-start gap-3 px-4 py-2.5" style={settle(i)}>
                  <span className="readout shrink-0" style={{ color: "var(--color-ink-500)" }}>
                    {String(a.rank).padStart(2, "0")}
                  </span>
                  <div className="min-w-0">
                    <span className="text-[12.5px]" style={{ color: "var(--color-body)", fontWeight: 500 }}>
                      {a.axis}
                    </span>
                    <p className="prose mt-0.5 text-[11.5px]" style={{ color: "var(--color-dim)" }}>
                      {a.why}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}

          {/*
            Deferred is not a leftovers list. Each entry carries what a human
            loses by it not running, which is the only honest way to present a
            partial run.
          */}
          {plan.deferred?.length ? (
            <div className="border-t px-4 py-3.5" style={{ borderColor: "var(--color-hair)" }}>
              <Label tone="var(--color-attend)">deliberately not tested</Label>
              <ul className="mt-2 space-y-2">
                {plan.deferred.map((d, i) => (
                  <li key={i}>
                    <div className="flex items-baseline gap-2.5">
                      <Mono tone="var(--color-attend)">{d.axis}</Mono>
                      <span className="prose text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                        {d.why}
                      </span>
                    </div>
                    <p className="prose mt-0.5 text-[11.5px]" style={{ color: "var(--color-dim)" }}>
                      Cost: {d.cost}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
