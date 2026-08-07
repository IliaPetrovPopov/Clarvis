import { useEffect, useMemo, useRef, useState } from "react";
import type { Run } from "@clarvis/core/types";
import {
  answerIntent,
  buildBriefing,
  parseIntent,
  type Address,
  type BriefingSegment,
} from "@clarvis/core/briefing";
import { useVoice } from "../useVoice";
import { Dot, Label, SeverityChip, settle } from "./primitives";

/**
 * The morning view. What state are we in, and does anything need me.
 *
 * The briefing is computed in core from run data - nothing here calls a model,
 * so it is instant, free, offline, and cannot invent a status. This component
 * presents it and speaks it.
 *
 * It previously did so twice. The spoken paragraph and the segment cards below
 * it are the same sentences: the paragraph is the segments joined together, so
 * a reader saw "the last run finished 9 hours ago" in a panel and then again
 * in a card underneath. The segments are the better form - labelled, tonal,
 * scannable - so the paragraph is now what gets spoken and what a screen reader
 * announces, and the page shows the segments.
 *
 * The greeting was also set as the largest thing on the page, in caps, above a
 * headline that repeated it. It is a greeting. It reads at body size next to
 * the state, which is the part that matters.
 *
 * Every voice affordance has a button beside it. Recognition is unavailable in
 * some browsers, unreliable in a noisy room, and unusable for anyone who cannot
 * speak clearly, so it accelerates the interface rather than being the way in.
 */

const TONE: Record<BriefingSegment["tone"], string> = {
  neutral: "var(--color-muted)",
  good: "var(--color-good)",
  warn: "var(--color-attend)",
  bad: "var(--color-sev-critical)",
};

const STATUS_TONE = {
  "no-data": "var(--color-dim)",
  clear: "var(--color-good)",
  attention: "var(--color-attend)",
  blocked: "var(--color-sev-critical)",
} as const;

const COMMANDS = [
  { intent: "briefing" as const, label: "How are we doing" },
  { intent: "criticals" as const, label: "What's critical" },
  { intent: "skipped" as const, label: "What was skipped" },
  { intent: "coverage" as const, label: "Coverage" },
  { intent: "blocked" as const, label: "Anything blocked" },
];

/** A quiet control. The page has one accent and this is not it. */
function Chip({
  children,
  onClick,
  active = false,
  tone = "var(--color-muted)",
  disabled = false,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className="focusable lbl px-2.5 py-1.5 transition-colors disabled:opacity-35"
      style={{
        color: active ? "var(--color-ink-000)" : tone,
        background: active ? tone : "transparent",
        border: `1px solid ${active ? tone : "var(--color-hair-lit)"}`,
        borderRadius: "var(--radius-sm)",
      }}
    >
      {children}
    </button>
  );
}

export function Briefing({
  latest,
  previous,
  onOpenRun,
}: {
  latest?: Run;
  previous?: Run;
  onOpenRun: () => void;
}) {
  const [spokenText, setSpokenText] = useState<string>("");
  const [heard, setHeard] = useState<string>("");

  // Preferences persist locally; there is no account and nothing to sync.
  const [address, setAddress] = useState<Address>(
    () => (localStorage.getItem("clarvis:address") as Address) ?? "formal",
  );

  useEffect(() => {
    localStorage.setItem("clarvis:address", address);
  }, [address]);

  const briefing = useMemo(
    () => buildBriefing({ latest, previous, now: new Date(), address }),
    [latest, previous, address],
  );

  const voice = useVoice((utterance) => {
    setHeard(utterance);
    const answer = answerIntent(parseIntent(utterance), briefing);
    setSpokenText(answer);
    voiceRef.current?.speak(answer);
  });

  // The callback above is created before `voice` exists, so it reaches the
  // speak function through a ref rather than closing over a stale value.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const say = (text: string) => {
    setSpokenText(text);
    voice.speak(text);
  };

  const statusTone = STATUS_TONE[briefing.status];

  // An answer to a question is worth showing; the default briefing is not,
  // because the segments below already say it. Autoplaying audio is hostile
  // and most browsers block it before a gesture, so nothing is spoken on load.
  const answer = spokenText && spokenText !== briefing.spoken ? spokenText : "";

  return (
    <section className="px-5 pt-6 pb-10 lg:px-8">
      <div className="settle" style={settle(0)}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Dot color={statusTone} live={briefing.status === "blocked"} />
          <Label tone={statusTone}>{briefing.status.replace("-", " ")}</Label>
          {briefing.runId && (
            <span className="readout text-[11px]" style={{ color: "var(--color-dim)" }}>
              {briefing.runId}
            </span>
          )}
        </div>

        {/* The state, large. The greeting sits beside it at conversational
            size, because it is a courtesy rather than the information. */}
        <h1
          className="mt-2.5 max-w-[46ch] text-[27px] leading-tight"
          style={{ color: statusTone, fontWeight: 500, letterSpacing: "-0.015em" }}
        >
          {briefing.headline}
        </h1>
        <p className="prose mt-1 text-[13px]" style={{ color: "var(--color-dim)" }}>
          {briefing.greeting}
        </p>
      </div>

      <div className="settle mt-5 flex flex-wrap items-center gap-2" style={settle(1)}>
        <Chip
          onClick={() => (voice.speaking ? voice.stopSpeaking() : say(briefing.spoken))}
          disabled={!voice.canSpeak}
          active={voice.speaking}
          tone="var(--color-signal)"
        >
          {voice.speaking ? "Stop" : "Brief me"}
        </Chip>

        <Chip
          onClick={() => (voice.listening ? voice.stopListening() : voice.listen())}
          disabled={!voice.canListen}
          active={voice.listening}
          tone="var(--color-attend)"
          title={voice.canListen ? "Ask a question out loud" : "This browser cannot do speech recognition"}
        >
          {voice.listening ? "Listening" : "Ask"}
        </Chip>

        <Chip onClick={onOpenRun}>Full run</Chip>

        <span className="mx-1 hidden h-4 w-px sm:block" style={{ background: "var(--color-hair-lit)" }} />

        {/* Every spoken command is also a button. */}
        {COMMANDS.map((c) => (
          <Chip key={c.intent} onClick={() => say(answerIntent(c.intent, briefing))} tone="var(--color-dim)">
            {c.label}
          </Chip>
        ))}
      </div>

      {/* What was heard and what was said, always visible as text. */}
      {(answer || heard || voice.transcript || voice.error) && (
        <div className="settle surface mt-4 px-4 py-3" style={settle(2)}>
          {(voice.transcript || heard) && (
            <p className="prose text-[12px]" style={{ color: "var(--color-attend)" }}>
              <Label tone="var(--color-attend)">heard</Label>{" "}
              &ldquo;{voice.transcript || heard}&rdquo;
            </p>
          )}
          {answer && (
            <p
              className="prose mt-1.5 text-[13px]"
              style={{ color: "var(--color-body)" }}
              aria-live="polite"
            >
              {answer}
            </p>
          )}
          {voice.error && (
            <p className="prose mt-1 text-[12px]" style={{ color: "var(--color-sev-critical)" }}>
              {voice.error}
            </p>
          )}
        </div>
      )}

      {/* The state of things, one line each. This is the briefing - the spoken
          version is these sentences joined, which is why it is not also
          printed above. */}
      <ul className="mt-6 grid gap-2 lg:grid-cols-2">
        {briefing.segments.map((segment, i) => (
          <li key={segment.label} className="settle surface px-4 py-3" style={settle(i + 3)}>
            <div className="flex items-baseline gap-2.5">
              <Dot color={TONE[segment.tone]} />
              <Label tone={TONE[segment.tone]}>{segment.label}</Label>
            </div>
            <p className="prose mt-1.5 pl-[17px] text-[12.5px]" style={{ color: "var(--color-muted)" }}>
              {segment.text}
            </p>
          </li>
        ))}
      </ul>

      {briefing.needsAttention.length > 0 && (
        <div className="settle mt-6" style={settle(9)}>
          <div className="flex items-baseline gap-3 pb-2.5">
            <Label tone="var(--color-attend)">needs you</Label>
            <button
              onClick={onOpenRun}
              className="focusable lbl ml-auto"
              style={{ color: "var(--color-dim)" }}
            >
              open the run &rsaquo;
            </button>
          </div>
          <ul className="space-y-1.5">
            {briefing.needsAttention.map((f, i) => (
              <li
                key={f.id}
                className="settle surface flex items-start gap-3 px-4 py-2.5"
                style={settle(i + 10)}
              >
                <span className="mt-[2px] shrink-0">
                  <SeverityChip severity={f.severity} />
                </span>
                <span className="text-[12.5px]" style={{ color: "var(--color-body)" }}>
                  {f.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
        Voice settings, last and quiet. No picker: one voice is chosen
        automatically - British RP, male, local - because the register is what
        matters and a dropdown of forty system voices is a settings screen, not
        a briefing. The name is shown so it is never a mystery which one spoke.
      */}
      <div className="mt-8 flex flex-wrap items-center gap-2.5">
        <Chip
          onClick={() => setAddress(address === "formal" ? "plain" : "formal")}
          active={address === "formal"}
          tone="var(--color-signal-deep)"
        >
          formal address
        </Chip>
        {voice.activeVoice && (
          <span className="lbl" style={{ color: "var(--color-dim)" }}>
            voice · {voice.activeVoice.name}
          </span>
        )}
      </div>
    </section>
  );
}
