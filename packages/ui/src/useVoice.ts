import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice input and output, built on the browser's own Web Speech API.
 *
 * No service, no key, no audio leaving the machine for synthesis. Speech
 * recognition in Chrome does reach Google's servers, which is why the mic is
 * strictly opt-in per use and never listens on its own.
 *
 * Everything voice can do is also a button. Recognition is unreliable in noisy
 * rooms, absent in Firefox, and unusable for anyone who cannot speak clearly -
 * so it is an accelerator on top of a working interface, never the way in.
 */

/* The Web Speech API is not in the DOM lib, so the surface used is declared. */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export interface VoiceState {
  speaking: boolean;
  listening: boolean;
  transcript: string;
  /** Set when the mic fails, so the UI can explain rather than just go quiet. */
  error?: string;
  canSpeak: boolean;
  canListen: boolean;
}

export interface UseVoice extends VoiceState {
  /** The one voice that will be used. Chosen automatically. */
  activeVoice?: SpeechSynthesisVoice;
  /**
   * How good that voice is.
   *
   * Surfaced because the honest answer to "it sounds robotic" is often that
   * the machine has nothing better installed, and no amount of picking can
   * fix that from here. Saying so lets a person go and install one.
   */
  voiceTier?: VoiceTier;
  speak: (text: string) => void;
  stopSpeaking: () => void;
  listen: () => void;
  stopListening: () => void;
}

/**
 * Voice selection: one voice, chosen automatically, no picker.
 *
 * This used to name `Daniel` first and take it wherever it existed. Daniel is
 * the classic macOS en-GB male, and "classic" is the problem: it is a
 * concatenative voice from around 2009, and no amount of rate and pitch
 * adjustment makes that sound like a person. Picking by name meant the oldest
 * voice on the system beat every better one installed beside it.
 *
 * So the choice is made on QUALITY first and register second. Synthesis has
 * had a generational change - neural voices are not a refinement of the old
 * ones, they are a different technology - and a modern voice in the wrong
 * accent sounds far more human than a legacy voice in the right one.
 *
 * The register is still the goal where quality allows it: unhurried, level,
 * British-leaning. That is what makes a spoken assistant read as composed
 * rather than chirpy, and it is as close to the reference as one gets without
 * imitating a particular performer.
 */

/** Quality tiers, best first. Higher wins regardless of accent. */
const TIERS = [
  {
    key: "premium",
    /** macOS Premium voices. The best available anywhere on this API. */
    test: (v: SpeechSynthesisVoice) => /premium/i.test(v.name) || /premium/i.test(v.voiceURI),
  },
  {
    key: "enhanced",
    /** macOS Enhanced. A large step up from compact; needs a download. */
    test: (v: SpeechSynthesisVoice) => /enhanced/i.test(v.name) || /enhanced/i.test(v.voiceURI),
  },
  {
    key: "neural",
    /**
     * Cloud neural voices. Chrome ships Google's; Edge ships Microsoft's.
     * Not local, so synthesis text leaves the machine - acceptable here
     * because a briefing is generated from the operator's own run data and is
     * about to be read aloud in the room anyway.
     */
    test: (v: SpeechSynthesisVoice) =>
      /^(Google|Microsoft)\b/i.test(v.name) || /natural|neural/i.test(v.name),
  },
  {
    key: "modern",
    /**
     * Apple's current-generation local voices, shipped by default since
     * macOS 13. Markedly more natural than the compact set they sit beside,
     * and present without any download - which on a machine with nothing
     * installed is the difference between a robot and a person.
     */
    test: (v: SpeechSynthesisVoice) =>
      /^(Eddy|Flo|Reed|Rocko|Sandy|Shelley|Grandma|Grandpa|Nicky|Aaron)\b/i.test(v.name),
  },
  {
    key: "legacy",
    /** Everything else that is a real voice: Daniel, Alex, Samantha, Karen. */
    test: () => true,
  },
] as const;

export type VoiceTier = (typeof TIERS)[number]["key"];

/**
 * Voices that are jokes, instruments or sound effects.
 *
 * macOS ships a couple of dozen of these and they are indistinguishable from
 * real voices in the API - same language, same localService flag. Any
 * fallback that ends in "the first English voice" can therefore land on
 * Bubbles or Trinoids, which is a genuinely possible outcome rather than a
 * theoretical one.
 */
const NOVELTY =
  /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Junior|Kathy|Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox|Deranged|Hysterical|Princess|Bruce|Agnes|Vicki|Victoria|Fred)\b/i;

/** Preferred accent order, applied only within a tier. */
const ACCENTS = ["en-GB", "en-AU", "en-IE", "en-US"];

/**
 * Names to favour inside a tier, most suitable first.
 *
 * An ordered list rather than one alternation, because a regex only answers
 * "does this match" - so the winner was whichever voice the system happened to
 * list first, and Eddy beat Reed for no reason anyone chose. The register
 * wanted here is level and unhurried; Apple's modern set includes voices that
 * are deliberately characterful, and a briefing read by an excitable one is
 * worse than a dull one read plainly.
 */
const FAVOURED = [
  "Serena",   // en-GB female, premium, composed
  "Malcolm",  // en-GB male, premium
  "Jamie",    // en-GB male, premium
  "Reed",     // modern, level - the calmest of the current local set
  "Oliver",
  "Arthur",
  "Sandy",
  "Daniel",   // legacy, but the right register when nothing better exists
  "Eddy",
];

/** The first voice matching the earliest favoured name, so order is intent. */
function preferred(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  for (const name of FAVOURED) {
    const match = voices.find((v) => new RegExp(`^${name}\\b`, "i").test(v.name));
    if (match) return match;
  }
  return undefined;
}

export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const usable = voices.filter((v) => v.lang?.startsWith("en") && !NOVELTY.test(v.name));
  if (!usable.length) return voices.find((v) => !NOVELTY.test(v.name)) ?? voices[0];

  for (const tier of TIERS) {
    // Assigned to the FIRST tier it matches, so an enhanced voice is never
    // also counted as legacy by the catch-all below it.
    const inTier = usable.filter(
      (v) => TIERS.find((t) => t.test(v))?.key === tier.key,
    );
    if (!inTier.length) continue;

    for (const accent of ACCENTS) {
      const sameAccent = inTier.filter((v) => v.lang === accent);
      if (!sameAccent.length) continue;
      return preferred(sameAccent) ?? sameAccent[0];
    }
    return preferred(inTier) ?? inTier[0];
  }

  return usable[0];
}

/** Which tier a voice belongs to, so the UI can say when it is stuck on a poor one. */
export function tierOf(voice?: SpeechSynthesisVoice): VoiceTier | undefined {
  if (!voice) return undefined;
  return TIERS.find((t) => t.test(voice))?.key;
}

export interface VoiceOptions {
  /** Slightly under 1 reads as measured rather than hurried. */
  rate?: number;
  pitch?: number;
}

export function useVoice(
  onUtterance?: (text: string) => void,
  options: VoiceOptions = {},
): UseVoice {
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  const canListen = typeof window !== "undefined" && Boolean(recognitionCtor());

  // Voices load asynchronously, and on first paint the list is usually empty.
  useEffect(() => {
    if (!canSpeak) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [canSpeak]);

  const stopSpeaking = useCallback(() => {
    if (!canSpeak) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [canSpeak]);

  const speak = useCallback(
    (text: string) => {
      if (!canSpeak || !text.trim()) return;
      // Never queue: a second request replaces the first, rather than making
      // someone wait through a stale briefing to hear the new one.
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickVoice(voices);
      if (voice) utterance.voice = voice;

      /*
        Barely under natural, and only barely.

        These were 0.94 and 0.95, which were chosen while the voice was always
        Daniel: slowing a concatenative voice down and dropping its pitch hides
        some of its seams. On a neural voice the same settings do the opposite,
        because the prosody was modelled at natural speed and stretching it is
        exactly what makes a good voice sound synthetic. So the correction is
        applied only where it still helps.
      */
      const legacy = tierOf(voice) === "legacy";
      utterance.rate = options.rate ?? (legacy ? 0.94 : 1);
      utterance.pitch = options.pitch ?? (legacy ? 0.95 : 1);

      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);

      window.speechSynthesis.speak(utterance);
    },
    [canSpeak, voices, options.rate, options.pitch],
  );

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const listen = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError("This browser cannot do speech recognition. Chrome or Edge can.");
      return;
    }

    // Listening while speaking makes the app transcribe itself.
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    setError(undefined);
    setTranscript("");

    const recognition = new Ctor();
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setListening(true);

    recognition.onresult = (event) => {
      let text = "";
      let final = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
        if (event.results[i].isFinal) final = true;
      }
      setTranscript(text);
      if (final) onUtteranceRef.current?.(text.trim());
    };

    recognition.onerror = (e) => {
      setListening(false);
      setError(
        e.error === "not-allowed"
          ? "Microphone access was denied. Allow it in the browser, or use the buttons."
          : e.error === "no-speech"
            ? "I did not catch that."
            : `Speech recognition failed: ${e.error}`,
      );
    };

    recognition.onend = () => setListening(false);

    try {
      recognition.start();
    } catch {
      setListening(false);
      setError("Could not start listening.");
    }
  }, []);

  // Leaving the page mid-sentence should not keep talking to an empty room.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  return {
    speaking,
    listening,
    transcript,
    error,
    canSpeak,
    canListen,
    activeVoice: pickVoice(voices),
    voiceTier: tierOf(pickVoice(voices)),
    speak,
    stopSpeaking,
    listen,
    stopListening,
  };
}
