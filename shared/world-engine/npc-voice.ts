// shared/world-engine/npc-voice.ts
//
// FREE, client-side NPC text-to-speech via the Web Speech API (window.speechSynthesis).
// Electron's renderer is Chromium, so this works in the packaged app with NO
// server TTS cost — the goal for a single-player game that "runs completely for
// free". DOM-typed (like render3d.ts): NOT re-exported from index.js, so the
// headless server never pulls it in.
//
// Speech is QUEUED, not cut off: in a conversation the response must wait for
// the statement before it to finish (player statement → NPC reply). `pause(ms)`
// inserts a silent gap into the queue — used when the statement's audio plays
// in ANOTHER frame (the AAC board voices the student's press in the parent
// window) and the game can only estimate when it ends. `cancel()` clears
// everything (e.g. walking off to a different conversation). A small queue cap
// drops the OLDEST waiting line when the conversation has moved on.
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
  /**
   * Deterministic pick among the language's voices, so distinct SPEAKERS get
   * distinct voices where the OS offers more than one (index wraps). Omit for
   * the default pickVoice choice.
   */
  voiceIndex?: number;
}

/** pickVoice, but selecting the index-th voice of the language (wrapping) —
 *  distinct speakers get distinct voices when the OS has them. Pure. */
export function pickVoiceVariant<V extends VoiceLike>(
  voices: V[],
  lang?: string,
  index?: number,
): V | null {
  if (index == null) return pickVoice(voices, lang);
  const base = lang?.toLowerCase().split("-")[0];
  const candidates = base
    ? voices.filter((v) => v.lang.toLowerCase().split("-")[0] === base)
    : voices;
  if (candidates.length === 0) return pickVoice(voices, lang);
  return candidates[index % candidates.length];
}

// ---------------------------------------------------------------------------
// The speech queue — pure sequencing logic over an injectable engine, so the
// wait-your-turn behavior is unit-testable headless (see createNpcVoice for
// the real speechSynthesis engine).
// ---------------------------------------------------------------------------

/** What the queue needs from a TTS engine: start an utterance and call `done`
 *  exactly once when it ends (or immediately on failure). */
export interface SpeechEngine {
  speak(text: string, opts: SpeakOptions | undefined, done: () => void): void;
  cancel(): void;
}

export interface SpeechQueue {
  /** Queue an utterance (plays when everything before it has finished). */
  speak(text: string, opts?: SpeakOptions): void;
  /** Queue a silent gap — room for audio playing outside this queue. */
  pause(ms: number): void;
  /** Drop the queue and stop the current utterance. */
  cancel(): void;
  /** Items waiting (not counting the one playing). */
  pending(): number;
}

/** Waiting lines beyond this are stale — drop the oldest, keep the newest. */
const QUEUE_CAP = 4;

export function createSpeechQueue(
  engine: SpeechEngine,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]),
  },
): SpeechQueue {
  type Item = { text: string; opts?: SpeakOptions } | { pauseMs: number };
  const queue: Item[] = [];
  let active = false;
  let generation = 0; // bumped by cancel() so in-flight callbacks go stale
  let pauseTimer: unknown = null;

  const next = (): void => {
    const item = queue.shift();
    if (!item) {
      active = false;
      return;
    }
    active = true;
    const gen = generation;
    const done = (): void => {
      if (gen !== generation) return; // cancelled meanwhile
      next();
    };
    if ("pauseMs" in item) {
      pauseTimer = timers.set(done, item.pauseMs);
    } else {
      engine.speak(item.text, item.opts, done);
    }
  };

  const push = (item: Item): void => {
    queue.push(item);
    while (queue.length > QUEUE_CAP) queue.shift(); // stale lines: oldest out
    if (!active) next();
  };

  return {
    speak(text, opts) {
      push({ text, opts });
    },
    pause(ms) {
      if (ms > 0) push({ pauseMs: ms });
    },
    cancel() {
      generation += 1;
      queue.length = 0;
      active = false;
      if (pauseTimer !== null) {
        timers.clear(pauseTimer);
        pauseTimer = null;
      }
      engine.cancel();
    },
    pending() {
      return queue.length;
    },
  };
}

/** Rough audio length of a TTS statement, for cross-frame pauses (the AAC
 *  board voices the student's press in the parent window; the game can only
 *  estimate when that finishes). ~13 chars/sec + startup, clamped. */
export function speechEstimateMs(text: string): number {
  return Math.min(6000, Math.max(800, 600 + text.trim().length * 75));
}

// ---------------------------------------------------------------------------
// The browser voice
// ---------------------------------------------------------------------------

export interface NpcVoice {
  /** QUEUE `text` — it plays after everything already queued has finished.
   *  Returns false (and stays silent) when speechSynthesis is unavailable or
   *  `text` is blank — the caller should still show the bubble. */
  speak(text: string, opts?: SpeakOptions): boolean;
  /** Queue a silent gap (audio playing outside this queue, e.g. the AAC board
   *  voicing the student's statement in the parent frame). */
  pause(ms: number): void;
  /** Convenience: speak a canned line in a language (no-op for a null/empty line). */
  speakLine(line: DialogueLine | null, lang: string, opts?: Omit<SpeakOptions, "lang">): boolean;
  /** Stop the current utterance and drop everything queued. */
  cancel(): void;
  /** True once at least one system voice is known (they can load asynchronously). */
  available(): boolean;
}

/** A no-op voice (no speechSynthesis, e.g. SSR / a headless context). */
const SILENT_VOICE: NpcVoice = {
  speak: () => false,
  pause: () => {},
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

  // Live utterances are pinned here until they end — Chromium GCs utterances
  // whose onend hasn't fired yet, which would silently wedge the queue.
  const live = new Set<SpeechSynthesisUtterance>();

  const engine: SpeechEngine = {
    speak(text, opts, done) {
      refresh();
      let finished = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const finish = (u?: SpeechSynthesisUtterance): void => {
        if (finished) return;
        finished = true;
        if (u) live.delete(u);
        if (watchdog) clearTimeout(watchdog);
        done();
      };
      try {
        const u = new SpeechSynthesisUtterance(text);
        const voice = pickVoiceVariant(voices, opts?.lang, opts?.voiceIndex);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        } else if (opts?.lang) {
          u.lang = opts.lang;
        }
        if (opts?.pitch != null) u.pitch = opts.pitch;
        if (opts?.rate != null) u.rate = opts.rate;
        u.onend = () => finish(u);
        u.onerror = () => finish(u);
        live.add(u);
        synth.speak(u);
        // Engines occasionally drop onend — never let the queue wedge.
        watchdog = setTimeout(() => finish(u), speechEstimateMs(text) * 3 + 4000);
      } catch {
        finish();
      }
    },
    cancel() {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
      live.clear();
    },
  };

  const queue = createSpeechQueue(engine);

  return {
    speak(text, opts) {
      const line = text.trim();
      if (!line) return false;
      queue.speak(line, opts);
      return true;
    },
    pause(ms) {
      queue.pause(ms);
    },
    speakLine(line, lang, opts) {
      if (!line) return false;
      const text = lineText(line, lang);
      if (!text) return false;
      queue.speak(text, { ...opts, lang });
      return true;
    },
    cancel() {
      queue.cancel();
    },
    available() {
      refresh();
      return voices.length > 0;
    },
  };
}
