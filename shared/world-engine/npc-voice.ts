// shared/world-engine/npc-voice.ts
//
// FREE, client-side NPC text-to-speech via the Web Speech API (window.speechSynthesis).
// Electron's renderer is Chromium, so this works in the packaged app with NO
// server TTS cost — the goal for a single-player game that "runs completely for
// free". DOM-typed (like render3d.ts): NOT re-exported from index.js, so the
// headless server never pulls it in.
//
// Voices are OS-provided (Windows SAPI, macOS, Linux espeak/speech-dispatcher),
// load ASYNC on some platforms (`voiceschanged`), and language coverage varies —
// so everything degrades gracefully: speak() returns false and stays silent when
// no engine/voice is available, and the caller still shows the speech BUBBLE, so
// the world never goes mute-and-blank. Pair with npc-dialogue.ts (what to say) +
// showWorldBubble (the bubble).

import { lineText, type DialogueLine } from "./npc-dialogue.js";

/** The minimal voice shape pickVoice needs — SpeechSynthesisVoice satisfies it,
 *  and tests can pass plain objects (no DOM lib required). */
export interface VoiceLike {
  lang: string;
  default?: boolean;
  voiceURI?: string;
}

/**
 * Choose the best available voice for `lang`: exact tag → base-language prefix →
 * the platform default → the first voice. Null when the list is empty (caller
 * then speaks with the utterance's `lang` and lets the engine choose, or stays
 * silent). Pure — unit-tested headless.
 */
export function pickVoice<V extends VoiceLike>(voices: V[], lang?: string): V | null {
  if (voices.length === 0) return null;
  if (!lang) return voices.find((v) => v.default) ?? voices[0];
  const want = lang.toLowerCase();
  const base = want.split("-")[0];
  return (
    voices.find((v) => v.lang.toLowerCase() === want) ??
    voices.find((v) => v.lang.toLowerCase().split("-")[0] === base) ??
    voices.find((v) => v.default) ??
    voices[0]
  );
}

export interface SpeakOptions {
  /** BCP-47 language tag; selects a matching system voice. */
  lang?: string;
  /** 0..2 (1 = normal). */
  pitch?: number;
  /** 0.1..10 (1 = normal). */
  rate?: number;
}

export interface NpcVoice {
  /** Speak `text`. Cancels any in-progress utterance first. Returns false (and
   *  stays silent) when speechSynthesis is unavailable or `text` is blank — the
   *  caller should still show the bubble. */
  speak(text: string, opts?: SpeakOptions): boolean;
  /** Convenience: speak a canned line in a language (no-op for a null/empty line). */
  speakLine(line: DialogueLine | null, lang: string, opts?: Omit<SpeakOptions, "lang">): boolean;
  /** Stop any in-progress speech. */
  cancel(): void;
  /** True once at least one system voice is known (they can load asynchronously). */
  available(): boolean;
}

/** A no-op voice (no speechSynthesis, e.g. SSR / a headless context). */
const SILENT_VOICE: NpcVoice = {
  speak: () => false,
  speakLine: () => false,
  cancel: () => {},
  available: () => false,
};

/**
 * Build an NpcVoice over the browser's speechSynthesis. Returns a silent no-op
 * when the API is absent, so callers never need to feature-detect.
 */
export function createNpcVoice(): NpcVoice {
  const synth: SpeechSynthesis | undefined =
    typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return SILENT_VOICE;

  let voices: SpeechSynthesisVoice[] = [];
  const refresh = (): void => {
    try {
      voices = synth.getVoices();
    } catch {
      voices = [];
    }
  };
  refresh();
  // Some platforms populate voices asynchronously.
  try {
    synth.addEventListener("voiceschanged", refresh);
  } catch {
    /* older engines: getVoices() is already populated */
  }

  const speak = (text: string, opts?: SpeakOptions): boolean => {
    const line = text.trim();
    if (!line) return false;
    refresh();
    try {
      const u = new SpeechSynthesisUtterance(line);
      const voice = pickVoice(voices, opts?.lang);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else if (opts?.lang) {
        u.lang = opts.lang;
      }
      if (opts?.pitch != null) u.pitch = opts.pitch;
      if (opts?.rate != null) u.rate = opts.rate;
      synth.cancel(); // one NPC line at a time
      synth.speak(u);
      return true;
    } catch {
      return false;
    }
  };

  return {
    speak,
    speakLine(line, lang, opts) {
      if (!line) return false;
      const text = lineText(line, lang);
      return text ? speak(text, { ...opts, lang }) : false;
    },
    cancel() {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
    },
    available() {
      refresh();
      return voices.length > 0;
    },
  };
}
