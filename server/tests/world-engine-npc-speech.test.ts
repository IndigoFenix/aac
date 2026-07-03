// NPC speech selection: canned, language-keyed dialogue (npc-dialogue) + voice
// matching (npc-voice's pure pickVoice). Pure logic, no DOM / no audio — safe in
// the default `npm test`. (The speechSynthesis playback itself is browser-only
// and not unit-tested here.)

import { describe, it, expect } from "@jest/globals";
import {
  lineText,
  pickLine,
  resolveLine,
  SAMPLE_NPC_DIALOGUE,
  type NpcDialogue,
} from "@shared/world-engine/npc-dialogue.js";
import {
  createSpeechQueue,
  pickVoice,
  pickVoiceVariant,
  speechEstimateMs,
} from "@shared/world-engine/npc-voice.js";

const DIALOGUE: NpcDialogue = {
  celebrate: [{ text: { en: "Yay!", he: "יש!" }, glyph: "happy" }],
  only_es: [{ text: { es: "Hola" } }],
};

describe("npc-dialogue (canned, language-keyed)", () => {
  it("resolves text by language with fallback (tag → base → first)", () => {
    const line = DIALOGUE.celebrate[0];
    expect(lineText(line, "en")).toBe("Yay!");
    expect(lineText(line, "en-US")).toBe("Yay!"); // base-language fallback
    expect(lineText(line, "he")).toBe("יש!");
    expect(lineText(line, "fr")).toBe("Yay!"); // first available
    expect(lineText(DIALOGUE.only_es[0], "en")).toBe("Hola"); // first available
  });

  it("picks a line deterministically with a seeded rng; null for unknown intent", () => {
    expect(pickLine(DIALOGUE, "celebrate", () => 0)).toBe(DIALOGUE.celebrate[0]);
    expect(pickLine(DIALOGUE, "nope", () => 0)).toBeNull();
  });

  it("resolveLine returns ready text + glyph, or null", () => {
    expect(resolveLine(DIALOGUE, "celebrate", "he", () => 0)).toEqual({ text: "יש!", glyph: "happy" });
    expect(resolveLine(DIALOGUE, "missing", "en")).toBeNull();
  });

  it("the sample companion dialogue speaks every intent in en/es/he", () => {
    for (const intent of ["greet", "celebrate", "encourage"]) {
      for (const lang of ["en", "es", "he"]) {
        const r = resolveLine(SAMPLE_NPC_DIALOGUE, intent, lang, () => 0);
        expect(r?.text && r.text.length > 0).toBe(true);
      }
    }
  });
});

describe("npc-voice pickVoice (pure)", () => {
  const voices = [
    { lang: "en-US", default: true },
    { lang: "en-GB" },
    { lang: "he-IL" },
    { lang: "es-ES" },
  ];

  it("prefers an exact tag, then base language, then default, then first", () => {
    expect(pickVoice(voices, "en-GB")?.lang).toBe("en-GB"); // exact
    expect(pickVoice(voices, "he")?.lang).toBe("he-IL"); // base-language prefix
    expect(pickVoice(voices, "fr")?.lang).toBe("en-US"); // no match → default
    expect(pickVoice(voices, undefined)?.lang).toBe("en-US"); // no lang → default
    expect(pickVoice([{ lang: "es-ES" }], "fr")?.lang).toBe("es-ES"); // no default → first
    expect(pickVoice([], "en")).toBeNull();
  });

  it("pickVoiceVariant gives distinct speakers distinct voices (wrapping)", () => {
    const many = [
      { lang: "en-US", default: true, voiceURI: "a" },
      { lang: "en-GB", voiceURI: "b" },
      { lang: "he-IL", voiceURI: "c" },
    ];
    expect(pickVoiceVariant(many, "en", 0)?.voiceURI).toBe("a");
    expect(pickVoiceVariant(many, "en", 1)?.voiceURI).toBe("b");
    expect(pickVoiceVariant(many, "en", 2)?.voiceURI).toBe("a"); // wraps
    expect(pickVoiceVariant(many, "he", 5)?.voiceURI).toBe("c"); // single voice: always it
    expect(pickVoiceVariant(many, "fr", 1)?.lang).toBe("en-US"); // no match → pickVoice default
    expect(pickVoiceVariant(many, "en", undefined)?.lang).toBe("en-US"); // no index → pickVoice
  });
});

describe("npc-voice speech queue (wait-your-turn sequencing)", () => {
  /** A hand-cranked engine + timers: the test decides when each utterance and
   *  pause finishes, so ordering is asserted deterministically. */
  function rig() {
    const spoken: string[] = [];
    const pending: (() => void)[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    let cancelled = 0;
    const queue = createSpeechQueue(
      {
        speak: (text, _opts, done) => {
          spoken.push(text);
          pending.push(done);
        },
        cancel: () => {
          cancelled += 1;
        },
      },
      {
        set: (fn, ms) => {
          const t = { fn, ms };
          timers.push(t);
          return t;
        },
        clear: (t) => {
          const i = timers.indexOf(t as { fn: () => void; ms: number });
          if (i >= 0) timers.splice(i, 1);
        },
      },
    );
    const finishUtterance = () => {
      const done = pending.shift();
      if (!done) return false;
      done();
      return true;
    };
    const firePause = () => timers.shift()?.fn();
    return { queue, spoken, timers, finishUtterance, firePause, cancelledCount: () => cancelled };
  }

  it("plays utterances one at a time, in order", () => {
    const r = rig();
    r.queue.speak("statement");
    r.queue.speak("response");
    expect(r.spoken).toEqual(["statement"]); // response WAITS
    r.finishUtterance();
    expect(r.spoken).toEqual(["statement", "response"]);
  });

  it("a pause holds the response back (cross-frame statement audio)", () => {
    const r = rig();
    r.queue.pause(1500);
    r.queue.speak("response");
    expect(r.spoken).toEqual([]); // still inside the student's statement
    expect(r.timers[0]?.ms).toBe(1500);
    r.firePause();
    expect(r.spoken).toEqual(["response"]);
  });

  it("cancel drops the queue and stops the engine; stale callbacks are inert", () => {
    const r = rig();
    r.queue.speak("old line");
    r.queue.speak("queued reply");
    r.queue.cancel();
    expect(r.cancelledCount()).toBe(1);
    r.finishUtterance(); // the cancelled utterance's onend arrives late
    expect(r.spoken).toEqual(["old line"]); // nothing new started
    r.queue.speak("fresh line");
    expect(r.spoken).toEqual(["old line", "fresh line"]);
  });

  it("caps the backlog by dropping the OLDEST waiting line", () => {
    const r = rig();
    r.queue.speak("playing");
    for (let i = 0; i < 6; i++) r.queue.speak(`waiting ${i}`);
    expect(r.queue.pending()).toBe(4); // capped
    while (r.finishUtterance()) {
      /* drain */
    }
    expect(r.spoken).toEqual(["playing", "waiting 2", "waiting 3", "waiting 4", "waiting 5"]);
  });

  it("estimates statement audio length within sane bounds", () => {
    expect(speechEstimateMs("")).toBe(800); // floor
    expect(speechEstimateMs("Give me the apple.")).toBeGreaterThan(1500);
    expect(speechEstimateMs("x".repeat(500))).toBe(6000); // ceiling
  });
});
