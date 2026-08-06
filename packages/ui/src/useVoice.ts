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
  speak: (text: string) => void;
  stopSpeaking: () => void;
  listen: () => void;
  stopListening: () => void;
}

/**
 * Voice selection: one voice, chosen automatically, no picker.
 *
 * British received pronunciation, male, unhurried. That register - not any
 * particular timbre - is most of what makes a spoken assistant read as composed
 * rather than chirpy, and it is the closest thing to the reference without
 * imitating a specific performer's identity.
 *
 * `Daniel` is the classic macOS en-GB male and is a local voice, so it works
 * offline and no audio leaves the machine. The rest of the list is the fallback
 * order for machines that do not have it, best match first.
 */
const PREFERRED_VOICES = [
  "Daniel",       // macOS en-GB male, local. The target.
  "Arthur",       // newer macOS en-GB male
  "Oliver",       // en-GB male
  "Google UK English Male",
  "Rishi",        // en-IN male, still RP-adjacent and calm
  "Alex",         // macOS en-US male, deep and level
];

export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const english = voices.filter((v) => v.lang.startsWith("en"));
  if (!english.length) return voices[0];

  for (const name of PREFERRED_VOICES) {
    const match = english.find((v) => v.name === name) ?? english.find((v) => v.name.includes(name));
    if (match) return match;
  }

  // Failing a named match, still lean British before anything else.
  return (
    english.find((v) => v.lang === "en-GB" && v.localService) ??
    english.find((v) => v.lang === "en-GB") ??
    english.find((v) => v.localService) ??
    english[0]
  );
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
      // Unhurried and level. Speeding up a status report makes it sound anxious.
      utterance.rate = options.rate ?? 0.94;
      utterance.pitch = options.pitch ?? 0.95;

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
    speak,
    stopSpeaking,
    listen,
    stopListening,
  };
}
