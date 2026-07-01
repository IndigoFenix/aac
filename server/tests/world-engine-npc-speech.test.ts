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
import { pickVoice } from "@shared/world-engine/npc-voice.js";

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
});
