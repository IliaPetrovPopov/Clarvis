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
import { Hud, Label, SeverityChip, stagger } from "./primitives";

/**
 * The morning view.
 *
 * The briefing itself is computed in core from run data - nothing here calls a
 * model, so it is instant, free, offline, and cannot invent a status. This
 * component only presents it and speaks it.
 *
 * Every voice affordance has a button beside it. Recognition is unavailable in
 * some browsers, unreliable in a noisy room, and unusable for anyone who cannot
 * speak clearly, so it accelerates the interface rather than being the way in.
 */

const TONE: Record<BriefingSegment["tone"], string> = {
  neutral: "var(--color-muted)",
  good: "var(--color-green)",
  warn: "var(--color-amber)",
  bad: "var(--color-sev-critical)",
};

const COMMANDS = [
  { intent: "briefing" as const, label: "How are we doing" },
  { intent: "criticals" as const, label: "What's critical" },
  { intent: "skipped" as const, label: "What was skipped" },
  { intent: "coverage" as const, label: "Coverage" },
  { intent: "blocked" as const, label: "Anything blocked" },
];

/** Concentric rings that react to speaking or listening. Purely decorative. */
function Reactor({ active, listening }: { active: boolean; listening: boolean }) {
  const color = listening ? "var(--color-amber)" : "var(--color-cyan)";
  return (
    <div className="relative size-[112px] shrink-0" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="absolute inset-0 rotate-45 border"
          style={{
            borderColor: color,
            opacity: active ? 0.55 - i * 0.15 : 0.16,
            transform: `rotate(45deg) scale(${1 - i * 0.18})`,
            transition: "opacity .35s ease",
            animation: active ? `reactor-pulse ${1.6 + i * 0.35}s ease-in-out infinite` : undefined,
            animationDelay: `${i * 0.18}s`,
          }}
        />
      ))}
      <span
        className="absolute inset-[38%] rotate-45"
        style={{
          background: color,
          boxShadow: `0 0 ${active ? 34 : 14}px ${color}`,
          transition: "box-shadow .35s ease",
        }}
      />
    </div>
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
  const greeted = useRef(false);

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
    const intent = parseIntent(utterance);
    const answer = answerIntent(intent, briefing);
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

  // Show the full briefing as the default transcript without speaking it.
  // Autoplaying audio is hostile, and most browsers block it before a gesture.
  useEffect(() => {
    if (greeted.current) return;
    greeted.current = true;
    setSpokenText(briefing.spoken);
  }, [briefing.spoken]);

  const statusColor = {
    "no-data": "var(--color-dim)",
    clear: "var(--color-green)",
    attention: "var(--color-amber)",
    blocked: "var(--color-sev-critical)",
  }[briefing.status];

  return (
    <section className="px-8 pt-8 pb-10">
      <div className="rise flex flex-wrap items-start gap-8" style={stagger(0)}>
        <Reactor active={voice.speaking || voice.listening} listening={voice.listening} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="hud-type glow text-[13px]" style={{ color: statusColor, letterSpacing: "0.3em" }}>
              {briefing.status.toUpperCase().replace("-", " ")}
            </span>
            {/* The rule only earns its space when there is room for it. */}
            <span className="hidden h-px flex-1 sm:block" style={{ background: "var(--color-edge)" }} />
            {briefing.runId && (
              <span className="label max-w-full truncate" title={briefing.runId}>
                {briefing.runId}
              </span>
            )}
          </div>

          <h1
            className="hud-type mt-3 text-[38px] leading-[1.05] uppercase"
            style={{ color: "var(--color-bright)" }}
          >
            {briefing.greeting}
          </h1>
          <p className="hud-type mt-1 text-[19px] uppercase" style={{ color: statusColor }}>
            {briefing.headline}
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={() => (voice.speaking ? voice.stopSpeaking() : say(briefing.spoken))}
              disabled={!voice.canSpeak}
              className="hud-clip-sm label px-4 py-2 transition-colors disabled:opacity-40"
              style={{
                color: voice.speaking ? "var(--color-void)" : "var(--color-cyan)",
                background: voice.speaking ? "var(--color-cyan)" : "transparent",
                border: "1px solid var(--color-cyan)",
              }}
            >
              {voice.speaking ? "Stop" : "Brief me"}
            </button>

            <button
              onClick={() => (voice.listening ? voice.stopListening() : voice.listen())}
              disabled={!voice.canListen}
              className="hud-clip-sm label flex items-center gap-2 px-4 py-2 transition-colors disabled:opacity-40"
              style={{
                color: voice.listening ? "var(--color-void)" : "var(--color-amber)",
                background: voice.listening ? "var(--color-amber)" : "transparent",
                border: "1px solid var(--color-amber)",
              }}
              title={voice.canListen ? "Ask a question out loud" : "This browser cannot do speech recognition"}
            >
              <span
                className={voice.listening ? "pulse" : ""}
                style={{ display: "block", width: 6, height: 6, background: "currentColor" }}
                aria-hidden
              />
              {voice.listening ? "Listening" : "Ask"}
            </button>

            <button onClick={onOpenRun} className="hud-clip-sm label px-4 py-2" style={{ border: "1px solid var(--color-edge-hi)" }}>
              Full run
            </button>
          </div>

          {/* Every spoken command is also a button. */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {COMMANDS.map((c) => (
              <button
                key={c.intent}
                onClick={() => say(answerIntent(c.intent, briefing))}
                className="label px-2.5 py-1 transition-colors hover:text-[var(--color-cyan)]"
                style={{ border: "1px solid var(--color-edge)", color: "var(--color-dim)", fontSize: "9.5px" }}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {/*
              No voice picker. One voice is chosen automatically - British RP,
              male, local - because the register is the thing that matters and a
              dropdown of forty system voices is a settings screen, not a
              briefing. The name is shown so it is never a mystery which one
              spoke.
            */}
            {voice.activeVoice && (
              <span className="label" style={{ fontSize: "9.5px", color: "var(--color-dim)" }}>
                voice · {voice.activeVoice.name}
              </span>
            )}

            <button
              onClick={() => setAddress(address === "formal" ? "plain" : "formal")}
              aria-pressed={address === "formal"}
              className="label px-2.5 py-1 transition-colors"
              style={{
                border: `1px solid ${address === "formal" ? "var(--color-cyan)" : "var(--color-edge)"}`,
                color: address === "formal" ? "var(--color-cyan)" : "var(--color-dim)",
                fontSize: "9.5px",
              }}
            >
              formal address
            </button>
          </div>
        </div>
      </div>

      {/* What was heard and what was said, always visible as text. */}
      {(heard || voice.transcript || voice.error) && (
        <div className="rise mt-6" style={stagger(1)}>
          {(voice.transcript || heard) && (
            <p className="text-[12px]" style={{ color: "var(--color-amber)" }}>
              <span className="label" style={{ display: "inline", marginRight: 8 }}>
                heard
              </span>
              "{voice.transcript || heard}"
            </p>
          )}
          {voice.error && (
            <p className="mt-1 text-[12px]" style={{ color: "var(--color-sev-critical)" }}>
              {voice.error}
            </p>
          )}
        </div>
      )}

      <Hud className="rise mt-6" tone="var(--color-edge)" style={stagger(2)}>
        <div className="px-5 py-4">
          <Label>briefing</Label>
          {/* aria-live so a screen reader announces answers as they change. */}
          <p
            className="mt-2 text-[13px] leading-relaxed"
            style={{ color: "var(--color-body)" }}
            aria-live="polite"
          >
            {spokenText || briefing.spoken}
          </p>
        </div>
      </Hud>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {briefing.segments.map((segment, i) => (
          <li
            key={segment.label}
            className="rise flex gap-3 px-4 py-3"
            style={{ ...stagger(i + 3), border: "1px solid var(--color-edge)", background: "var(--color-panel)" }}
          >
            <span
              className="mt-[6px] block size-2 shrink-0 rotate-45"
              style={{ background: TONE[segment.tone], boxShadow: `0 0 8px ${TONE[segment.tone]}` }}
              aria-hidden
            />
            <div className="min-w-0">
              <Label style={{ color: TONE[segment.tone] }}>{segment.label}</Label>
              <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
                {segment.text}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {briefing.needsAttention.length > 0 && (
        <div className="rise mt-6" style={stagger(9)}>
          <Label style={{ color: "var(--color-amber)" }}>needs you</Label>
          <ul className="mt-2 space-y-1.5">
            {briefing.needsAttention.map((f) => (
              <li
                key={f.id}
                className="flex items-start gap-3 px-4 py-2.5"
                style={{ border: "1px solid var(--color-edge)", background: "var(--color-panel)" }}
              >
                <span className="mt-[3px]">
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
    </section>
  );
}
