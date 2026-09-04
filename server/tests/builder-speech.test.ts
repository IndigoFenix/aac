// THE SENTENCE THE DEVICE MAY SAY WITHOUT ASKING A MODEL.
//
// The builder's Play button used to be a model call every single time. This
// gate lets the glyph language answer instead — instantly, offline, free — and
// each test below is one of the ways that shortcut could put a sentence the
// child did not compose (or one in the wrong language) into their mouth.

import { describe, it, expect } from "@jest/globals";
import { renderComposedSentence, studentGender } from "@shared/aac/builder-speech";
import { speakOnDeviceNow } from "@shared/aac/device-voice";

describe("renderComposedSentence — the device says it itself", () => {
  it("renders an ordinary want in English", () => {
    expect(renderComposedSentence("i_me + want + apple", { locale: "en" }))
      .toBe("I want an apple.");
  });

  it("renders the same sentence in Hebrew, not in English", () => {
    const said = renderComposedSentence("i_me + want + apple", { locale: "he" });
    expect(said).toBeTruthy();
    expect(said).toMatch(/[֐-׿]/);
    expect(said).not.toMatch(/[A-Za-z]/);
  });

  it("agrees with the student's gender where the language does", () => {
    // "I'm going home" conjugates in Hebrew; a girl saying הולך is the bug.
    const boy = renderComposedSentence("i_me + go + home", { locale: "he", gender: "m" });
    const girl = renderComposedSentence("i_me + go + home", { locale: "he", gender: "f" });
    expect(boy).toBeTruthy();
    expect(girl).toBeTruthy();
    expect(girl).not.toBe(boy);
  });

  it("reads a subject-less sentence as the STUDENT speaking, not as an order", () => {
    // firstPerson: "give + ball" is the child offering, not commanding.
    const said = renderComposedSentence("give + ball", { locale: "en" });
    expect(said).toBeTruthy();
    expect(said!.toLowerCase()).toContain("i");
    expect(said!.toLowerCase()).not.toMatch(/^give /);
  });

  it("keeps a question a question", () => {
    const said = renderComposedSentence("you + want + apple#question", { locale: "en" });
    expect(said).toBeTruthy();
    expect(said).toContain("?");
  });

  // ---- the refusals: each one hands the sentence back to the model ----

  it("REFUSES a locale with no ruleset rather than saying it in English", () => {
    // ru/ar/fr/de/ko/zh/yue fall back to the English ruleset by design. A
    // fluent English sentence on a Russian child's board is the failure this
    // gate exists to prevent — the model speaks Russian, so it takes the turn.
    for (const locale of ["ru", "ar", "fr", "de", "ko", "zh", "yue"]) {
      expect(renderComposedSentence("i_me + want + apple", { locale })).toBeNull();
    }
  });

  it("REFUSES a word the ruleset's lexicon does not have", () => {
    // `baseWord` falls back to the raw glyph head, and a head IS an English
    // word — so without this check a missing lexeme does not fail, it says
    // "quernbit" (or "apple") in the middle of a Hebrew sentence.
    expect(renderComposedSentence("i_me + want + quernbit", { locale: "he" })).toBeNull();
  });

  it("REFUSES a photo-identified person — a face key is not a word", () => {
    expect(renderComposedSentence("i_me + want + face:abc123", { locale: "en" })).toBeNull();
  });

  it("REFUSES word salad the parser recognizes no frame for", () => {
    // A gloss is the tokens in glyph order. The model writes a sentence; this
    // would recite a list, so the list never gets voiced as the child's words.
    expect(renderComposedSentence("apple + ball + chair", { locale: "en" })).toBeNull();
  });

  it("REFUSES an empty or blank glyph", () => {
    expect(renderComposedSentence("", { locale: "en" })).toBeNull();
    expect(renderComposedSentence("   ", { locale: "en" })).toBeNull();
  });
});

describe("studentGender", () => {
  it("reads the students table's own spelling", () => {
    expect(studentGender("female")).toBe("f");
    expect(studentGender("male")).toBe("m");
  });

  it("defaults to masculine when unset, like every other path", () => {
    expect(studentGender(undefined)).toBe("m");
    expect(studentGender(null)).toBe("m");
    expect(studentGender("")).toBe("m");
  });
});

// ---------------------------------------------------------------------------
// The other half of the same promise: WHEN the device speaks at the tap.
// ---------------------------------------------------------------------------

describe("speakOnDeviceNow — the press is voiced before the socket write", () => {
  const on = { deviceVoice: true, audioEnabled: true };

  it("speaks a press when device-voice mode is on", () => {
    expect(speakOnDeviceNow(on, "I want pizza", "pizza")).toBe(true);
  });

  it("stays silent when the student's voice comes from a provider", () => {
    // The server voices it and streams the audio; speaking here would double it.
    expect(speakOnDeviceNow({ deviceVoice: false, audioEnabled: true }, "I want pizza")).toBe(false);
  });

  it("honours the audio-output mute, which silences everything this window makes", () => {
    expect(speakOnDeviceNow({ deviceVoice: true, audioEnabled: false }, "I want pizza")).toBe(false);
  });

  it("never speaks [MORE] — it asks for options, it is not an utterance", () => {
    // The server short-circuits this label before any TTS; so does this.
    expect(speakOnDeviceNow(on, "[MORE]", "[MORE]")).toBe(false);
  });

  it("has nothing to say for an empty or blank sentence", () => {
    expect(speakOnDeviceNow(on, "")).toBe(false);
    expect(speakOnDeviceNow(on, "   ")).toBe(false);
    expect(speakOnDeviceNow(on, undefined)).toBe(false);
  });
});
