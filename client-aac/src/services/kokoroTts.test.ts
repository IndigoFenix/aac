// The local neural voice's REFUSAL contract.
//
// kokoroTts sits on the last rung of the TTS ladder — it runs only when every
// cloud provider has already failed. So the property that matters most is not
// "does it sound good", it's "does it ever swallow an utterance". Every path
// that can't produce audio must say so promptly and let the caller fall back to
// speechSynthesis; none may throw, and none may hang.
//
// Node test environment (no DOM), so these cover the pure gates and the
// not-ready refusal. Actual synthesis needs onnxruntime and a real AudioContext
// and is verified by running the app.

import {
  supportsLanguage, speak, isReady, recordSynthesisTiming,
  resetSpeedGate, speedGateReason, setVoiceAllowed,
} from "./kokoroTts";

beforeEach(() => {
  resetSpeedGate();
  // Most cases assert what happens for a student who HAS the voice enabled;
  // the per-student gate gets its own describe block below.
  setVoiceAllowed(true);
});

describe("supportsLanguage", () => {
  it("accepts English in the forms the server sends", () => {
    // sendClientLocalTts passes studentVoice.language, which is a bare code in
    // some configs and a locale in others.
    for (const lang of ["en", "en-US", "en-GB", "en-us", "EN"]) {
      expect(supportsLanguage(lang)).toBe(true);
    }
  });

  it("rejects Hebrew", () => {
    // Not an oversight to fix later: as of 2026-08-25 every open Hebrew
    // acoustic model at usable quality is CC-BY-NC and cannot ship. Hebrew
    // presses must keep reaching speechSynthesis, so this gate is load-bearing.
    for (const lang of ["he", "he-IL", "iw", "iw-IL"]) {
      expect(supportsLanguage(lang)).toBe(false);
    }
  });

  it("rejects every other app locale", () => {
    for (const lang of ["ar", "ru-RU", "es", "pt-BR", "fr", "de", "am"]) {
      expect(supportsLanguage(lang)).toBe(false);
    }
  });

  it("rejects a missing or empty language rather than assuming English", () => {
    expect(supportsLanguage(undefined)).toBe(false);
    expect(supportsLanguage("")).toBe(false);
  });
});

describe("speak", () => {
  it("declines when the model has not loaded, instead of waiting for it", async () => {
    // The model is never staged in the test environment, so the loader has
    // nothing ready. A press cannot block on a 92 MB download — the refusal
    // must come back immediately so the caller can use speechSynthesis.
    expect(isReady()).toBe(false);

    const verdict = await Promise.race([
      speak("hello", "en-US", "student"),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 1_000)),
    ]);

    expect(verdict).toBe(false);
  });

  it("declines a non-English utterance without touching the model", async () => {
    await expect(speak("שלום", "he-IL", "student")).resolves.toBe(false);
  });

  it("declines empty or whitespace-only text", async () => {
    await expect(speak("", "en-US", "ai")).resolves.toBe(false);
    await expect(speak("   ", "en-US", "ai")).resolves.toBe(false);
  });

  it("never throws — a failure here must degrade, not crash the press", async () => {
    await expect(speak("hello", "en-US", "ai")).resolves.toBe(false);
    await expect(speak("hello", "zz-ZZ", "student")).resolves.toBe(false);
  });

  it("never announces a start for an utterance it declined", async () => {
    // `onStart` is what closes the mic gate around this voice, and it must mean
    // "audio is leaving the speaker NOW" — nothing weaker. A refusal that fired
    // it would deafen the session for an utterance speechSynthesis is about to
    // speak instead, and the fallback raises its own hold.
    const starts: number[] = [];
    const onStart = () => starts.push(Date.now());
    await speak("hello", "en-US", "student", { onStart });   // model not staged
    await speak("שלום", "he-IL", "student", { onStart });     // wrong language
    await speak("   ", "en-US", "ai", { onStart });           // nothing to say
    setVoiceAllowed(false);
    await speak("hello", "en-US", "student", { onStart });   // not this student's
    expect(starts).toHaveLength(0);
  });
});

describe("speed gate", () => {
  // An AAC press is a conversational turn. A natural voice that arrives three
  // seconds late serves the child worse than a robotic one that arrives now, so
  // a device that can't keep up must hand the path back to speechSynthesis.

  it("tolerates synthesis at or under real time", () => {
    for (let i = 0; i < 10; i++) recordSynthesisTiming(700, 1.0); // RTF 0.7
    expect(isReady()).toBe(false);            // not ready, for want of a model...
    expect(speedGateReason()).toBeNull();     // ...but never because of speed
  });

  it("does not disable on a single slow utterance", () => {
    // One outlier is noise: a GC pause, a busy tab, another model loading.
    recordSynthesisTiming(3_000, 1.0); // RTF 3.0
    expect(speedGateReason() !== null).toBe(false);
  });

  it("disables after consecutive slow utterances", () => {
    recordSynthesisTiming(3_000, 1.0);
    recordSynthesisTiming(2_500, 1.0);
    expect(speedGateReason() !== null).toBe(true);
  });

  it("resets the streak when a fast utterance lands between slow ones", () => {
    recordSynthesisTiming(3_000, 1.0); // slow
    recordSynthesisTiming(500, 1.0);   // fast — device was just busy
    recordSynthesisTiming(3_000, 1.0); // slow again, but streak restarted
    expect(speedGateReason() !== null).toBe(false);
  });

  it("stays disabled once the verdict is in", async () => {
    recordSynthesisTiming(3_000, 1.0);
    recordSynthesisTiming(3_000, 1.0);
    // Sticky for the session: a device that is too slow now will still be too
    // slow in a minute, and re-testing costs the child another slow press.
    for (let i = 0; i < 5; i++) recordSynthesisTiming(100, 1.0);
    expect(speedGateReason() !== null).toBe(true);
    await expect(speak("hello", "en-US", "student")).resolves.toBe(false);
  });

  it("ignores a zero-length measurement rather than dividing by zero", () => {
    recordSynthesisTiming(5_000, 0);
    recordSynthesisTiming(5_000, 0);
    expect(speedGateReason() !== null).toBe(false);
  });
});

describe("per-student permission", () => {
  // The weights are cached per DEVICE but the setting is per STUDENT. On a
  // shared classroom tablet the model may already be in memory from another
  // child — it must not speak for a student whose clinician never chose it.

  it("declines when the student does not have the voice enabled", async () => {
    setVoiceAllowed(false);
    await expect(speak("hello", "en-US", "student")).resolves.toBe(false);
    expect(isReady()).toBe(false);
  });

  it("defaults to not allowed, so a student is opted in only by their setting", async () => {
    // Fresh module state grants nothing; ensureVoiceDownloaded / setVoiceAllowed
    // are the only ways in.
    setVoiceAllowed(false);
    expect(isReady()).toBe(false);
  });
});
