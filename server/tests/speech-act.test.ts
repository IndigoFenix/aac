/**
 * Tests for shared/aac/speech-act.ts — the pragmatic classification that drives
 * the prosody MARK on a glyph.
 *
 * Narrowed 2026-08-24: the act no longer paints anything. It was briefly wired
 * to button colour (social→pink, repair→violet, a widened affirm/reject green
 * and red) and that was pulled — `ToneFamily` classifies WORDS, not utterances,
 * so `tone: "social"` (which holds twelve people nouns) painted "I want to talk
 * to mom" pink. Colour now comes from the yes/no SYMBOL and from `role`; the
 * cases below pin that separation so the paint cannot creep back in here.
 */

import { describe, it, expect } from "@jest/globals";
import {
  SPEECH_ACTS,
  asSpeechAct,
  detectYesNoAct,
  deriveSpeechAct,
  speechActToneTag,
  applySpeechActMark,
  type SpeechAct,
} from "../../shared/aac/speech-act.js";
import {
  resolveButtonColorToken,
  detectYesNoDefaultColor,
  COLOR_MAP,
} from "../../shared/button-color.js";
import { parseGlyph } from "../../shared/glyph-compositor.js";

describe("asSpeechAct", () => {
  it("accepts every member of the closed set", () => {
    for (const act of SPEECH_ACTS) expect(asSpeechAct(act)).toBe(act);
  });

  it("rejects anything outside it", () => {
    for (const v of ["", "AFFIRM", "question", "yes", null, undefined, 3, {}]) {
      expect(asSpeechAct(v)).toBeUndefined();
    }
  });
});

describe("detectYesNoAct", () => {
  it("finds a bare yes/no symbol anywhere in the glyph", () => {
    expect(detectYesNoAct("yes")).toBe("affirm");
    expect(detectYesNoAct("no")).toBe("reject");
    expect(detectYesNoAct("i_me+yes")).toBe("affirm");
    expect(detectYesNoAct("no#exclamation")).toBe("reject");
    expect(detectYesNoAct("want(no)")).toBe("reject");
  });

  it("never matches inside a longer key or an emoji", () => {
    // The bug this guards: a substring scan would paint `nose`, `noise`,
    // `yesterday` and `know` — all real registry-shaped keys.
    for (const g of ["nose", "noise", "yesterday", "know", "🚫", "snow"]) {
      expect(detectYesNoAct(g)).toBeUndefined();
    }
  });

  it("treats both-present as ambiguous", () => {
    expect(detectYesNoAct("yes+no")).toBeUndefined();
  });

  it("is undefined for empty input", () => {
    expect(detectYesNoAct(undefined)).toBeUndefined();
    expect(detectYesNoAct("")).toBeUndefined();
  });
});

describe("deriveSpeechAct — glyph only", () => {
  it("a yes/no symbol wins outright", () => {
    expect(deriveSpeechAct({ glyph: "yes" })).toBe("affirm");
    expect(deriveSpeechAct({ glyph: "no" })).toBe("reject");
  });

  it("reads the registry tone family through the glyph's dominant slot", () => {
    // `want` carries tone:"request", so the verb decides — not the noun.
    expect(deriveSpeechAct({ glyph: "i_me+want+water" })).toBe("request");
    expect(deriveSpeechAct({ glyph: "water#question" })).toBe("ask");
  });

  it("is undefined for a neutral glyph or none at all", () => {
    expect(deriveSpeechAct({})).toBeUndefined();
    expect(deriveSpeechAct({ glyph: "water" })).toBeUndefined();
  });

  it("takes NO input from the model — the tool field is gone", () => {
    // Guards the regression directly: a stray authored value on the input
    // object must not reach the result. If someone re-adds a model-supplied
    // act, this fails and they have to think about the colour question again.
    expect(deriveSpeechAct({ glyph: "water", authored: "reject" } as never)).toBeUndefined();
    expect(deriveSpeechAct({ glyph: "water", speechAct: "social" } as never)).toBeUndefined();
  });
});

describe("the act paints NOTHING — colour is yes/no + role", () => {
  it("no speech act reaches the colour resolver at all", () => {
    // Passing an act through the (now role-shaped) input must be inert.
    for (const act of SPEECH_ACTS) {
      expect(resolveButtonColorToken({ speechAct: act } as never)).toBe("white");
    }
  });

  it("social and repair are UNPAINTED — the bug that pulled the palette", () => {
    // "I want to talk to mom" derives `request` off `talk`/`mom`, both of which
    // the registry tags social. It must be plain white, not pink.
    expect(deriveSpeechAct({ glyph: "i_me+talk+mom" })).toBeDefined();
    expect(resolveButtonColorToken({ glyph: "i_me+talk+mom" })).toBe("white");
    expect(resolveButtonColorToken({ glyph: "hi" })).toBe("white");
  });

  it("yes/no still paint, from the SYMBOL, exactly as before", () => {
    expect(resolveButtonColorToken({ glyph: "yes" })).toBe("green");
    expect(resolveButtonColorToken({ glyph: "no" })).toBe("red");
    expect(resolveButtonColorToken({ glyph: "yes+no" })).toBe("white"); // ambiguous
  });

  it("a bid earns the third and last fill", () => {
    expect(resolveButtonColorToken({ role: "bid" })).toBe("orange");
    expect(resolveButtonColorToken({ role: "reply" })).toBe("white");
    expect(resolveButtonColorToken({})).toBe("white");
  });

  it("the learned yes/no colour outranks a bid", () => {
    expect(resolveButtonColorToken({ glyph: "yes", role: "bid" })).toBe("green");
    expect(resolveButtonColorToken({ glyph: "no", role: "bid" })).toBe("red");
  });

  it("an explicit clinician colour and the meta buttons still win", () => {
    expect(resolveButtonColorToken({ color: "blue", role: "bid" })).toBe("blue");
    expect(resolveButtonColorToken({ buttonType: "wordfinder", role: "bid" }))
      .toBe(resolveButtonColorToken({ buttonType: "wordfinder" }));
    expect(resolveButtonColorToken({ buttonType: "more", role: "bid" }))
      .toBe(resolveButtonColorToken({ buttonType: "more" }));
  });

  it("every token the resolver can name is one the palette can resolve", () => {
    for (const input of [{ glyph: "yes" }, { glyph: "no" }, { role: "bid" }, {}]) {
      const token = resolveButtonColorToken(input);
      expect(COLOR_MAP).toHaveProperty(token);
    }
  });
});

describe("the mark and the colour agree about what a yes is", () => {
  // Two independent scans live in two modules; if they ever disagree, a button
  // could be green while its act says something else.
  it("detectYesNoAct and detectYesNoDefaultColor match on every case", () => {
    for (const g of ["yes", "no", "i_me+yes", "no#exclamation", "want(no)",
                     "yes+no", "nose", "yesterday", "water", ""]) {
      const act = detectYesNoAct(g);
      const color = detectYesNoDefaultColor(g);
      expect(act === "affirm" ? "green" : act === "reject" ? "red" : undefined).toBe(color);
    }
  });
});

describe("speechActToneTag / applySpeechActMark", () => {
  it("gives request and direct the shared arc, and ask the existing ?", () => {
    expect(speechActToneTag("request")).toBe("request");
    expect(speechActToneTag("direct")).toBe("request");
    expect(speechActToneTag("ask")).toBe("question");
  });

  it("gives no mark to the acts that carry no directive force", () => {
    for (const act of ["affirm", "reject", "social", "repair", "comment"] as SpeechAct[]) {
      expect(speechActToneTag(act)).toBeUndefined();
    }
  });

  it("appends a tag the compositor can parse back out", () => {
    const marked = applySpeechActMark("i_me+want+water", "request");
    expect(marked).toBe("i_me+want+water#request");
    expect(parseGlyph(marked!).toneTags).toContain("request");
    // The slots must survive the append — an earlier bug in this parser
    // discarded every slot after the first `#`.
    expect(parseGlyph(marked!).slots.map((s) => s.key)).toEqual(["i_me", "want", "water"]);
  });

  it("coexists with a tense tag on the opposite corner", () => {
    const marked = applySpeechActMark("i_me+want+water#past", "request");
    const tags = parseGlyph(marked!).toneTags;
    expect(tags).toContain("past");
    expect(tags).toContain("request");
  });

  it("never overwrites a prosody tag the author already set", () => {
    for (const existing of ["#question", "#exclamation", "#request"]) {
      const g = `water${existing}`;
      expect(applySpeechActMark(g, "request")).toBe(g);
    }
  });

  it("leaves a glyph alone when the act earns no mark", () => {
    expect(applySpeechActMark("yes", "affirm")).toBe("yes");
    expect(applySpeechActMark("water", undefined)).toBe("water");
    expect(applySpeechActMark(undefined, "request")).toBeUndefined();
  });
});
