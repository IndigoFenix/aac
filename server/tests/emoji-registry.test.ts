/**
 * Tests for the emoji registry — focused on `isNonReversibleEmoji`, which
 * governs whether an emoji is horizontally mirrored in RTL. Text-like emoji
 * (digits/letters/words/punctuation) must NOT flip; ordinary pictographs must.
 */

import { describe, it, expect } from "@jest/globals";
import {
  isNonReversibleEmoji,
  isNonReversibleItem,
  shouldMirror,
  rtlMirrorStyle,
  isFaceKey,
  resolveEmoji,
} from "../../shared/emoji-registry.js";
import { getVocabularyItem } from "../../shared/glyph-registry.js";

describe("isNonReversibleEmoji", () => {
  it("flags word/letter/number emoji that read wrong mirrored", () => {
    const nonReversible = [
      "🆕", // NEW
      "🆘", // SOS
      "💯", // 100
      "™️", // trademark
      "™", // trademark (no VS-16)
      "©", // copyright
      "®", // registered
      "🔟", // keycap ten
      "🔢", // input numbers
      "🔤", // input latin letters
      "🅰️", // blood type A
      "🆎", // blood type AB
      "ℹ️", // information
      "Ⓜ️", // circled M (metro)
      "🆔", // ID
      "🆒", // COOL
    ];
    for (const e of nonReversible) {
      expect(isNonReversibleEmoji(e)).toBe(true);
    }
  });

  it("flags keycap digit sequences", () => {
    for (const e of ["0️⃣", "1️⃣", "5️⃣", "9️⃣", "#️⃣", "*️⃣"]) {
      expect(isNonReversibleEmoji(e)).toBe(true);
    }
  });

  it("flags asymmetric punctuation marks", () => {
    for (const e of ["❓", "❔", "❗", "❕", "‼️", "⁉️", "?", "!"]) {
      expect(isNonReversibleEmoji(e)).toBe(true);
    }
  });

  it("flags bare letters and digits", () => {
    for (const e of ["A", "z", "7", "0"]) {
      expect(isNonReversibleEmoji(e)).toBe(true);
    }
  });

  it("flags regional-indicator flag letters", () => {
    expect(isNonReversibleEmoji("🇺🇸")).toBe(true);
    expect(isNonReversibleEmoji("🇮🇱")).toBe(true);
  });

  it("does NOT flag ordinary pictographs (they should still mirror)", () => {
    const reversible = [
      "🍎", // apple
      "🏃", // running person
      "🚶", // walking person
      "🐈", // cat
      "🚗", // car
      "👋", // wave
      "🧑‍⚕️", // ZWJ sequence (health worker)
      "👨‍👩‍👧", // family ZWJ sequence
      "🙏", // hands
      "😊", // smile
      "•", // bullet placeholder
    ];
    for (const e of reversible) {
      expect(isNonReversibleEmoji(e)).toBe(false);
    }
  });

  it("returns false for empty / undefined-ish input", () => {
    expect(isNonReversibleEmoji("")).toBe(false);
  });

  it("guards the concrete examples from the bug report", () => {
    // "new, sos, 100, tm" — by the emoji each concept resolves to.
    expect(isNonReversibleEmoji("🆕")).toBe(true);
    expect(isNonReversibleEmoji("🆘")).toBe(true);
    expect(isNonReversibleEmoji("💯")).toBe(true);
    expect(isNonReversibleEmoji("™️")).toBe(true);
    // The compositor's unknown-slot placeholder must stay upright.
    expect(isNonReversibleEmoji("❓")).toBe(true);
    expect(isNonReversibleEmoji(resolveEmoji("face:abc")!)).toBe(false); // 👤 is fine to mirror
  });
});

describe("isNonReversibleItem", () => {
  // The ITEM-level rule the compositor reads. It used to be a stub that always
  // returned false, so the one render path that consults it alone — the corner
  // badge stack — mirrored everything in RTL regardless.

  it("honours an explicit nonReversible flag even for mirrorable art", () => {
    // The forward hook: artwork containing a numeral or a word. Nothing bundled
    // needs it yet, so this is the only place the flag is exercised.
    expect(isNonReversibleItem({ nonReversible: true, emoji: "🚶" })).toBe(true);
  });

  it("infers it from a text-carrying emoji with no flag set", () => {
    for (const emoji of ["❓", "1️⃣", "🔢", "💯"]) {
      expect(isNonReversibleItem({ emoji })).toBe(true);
    }
  });

  it("leaves ordinary pictographs mirrorable", () => {
    for (const emoji of ["🚶", "🫴", "🐱", "🚪"]) {
      expect(isNonReversibleItem({ emoji })).toBe(false);
    }
  });

  it("treats an item with no emoji and no flag as mirrorable", () => {
    // Bundled-art-only items reach here with `emoji` undefined; defaulting to
    // "do not mirror" would silently freeze every icon in RTL.
    expect(isNonReversibleItem({})).toBe(false);
  });

  it("covers the registry entries whose own glyph is text", () => {
    // The WH-words all wear ❓ and the numeral modifiers wear keycaps, so each
    // is a badge whose mirror image reads backwards. Asserted through the real
    // registry so a future emoji change here can't quietly lose the protection.
    for (const key of ["what", "who", "where", "when", "why", "how", "if", "one", "two", "many"]) {
      const item = getVocabularyItem(key);
      expect(item).toBeDefined();
      expect(isNonReversibleItem(item!)).toBe(true);
    }
  });

  it("does not sweep up ordinary vocabulary", () => {
    for (const key of ["walk", "come", "my", "your", "do", "apple"]) {
      const item = getVocabularyItem(key);
      expect(item).toBeDefined();
      expect(isNonReversibleItem(item!)).toBe(false);
    }
  });
});

describe("shouldMirror — the one rule every surface asks", () => {
  // The glyph compositor, the board buttons and both sentence builders used to
  // each carry their own version of this test. They disagreed: the builder
  // chips mirrored any pictograph, while the compositor mirrored only concepts
  // that resolved to a registry item — so an AI-emitted emoji faced one way on
  // the chip and the other in the glyph it was pressed into.

  it("mirrors an ordinary pictograph in RTL and nothing in LTR", () => {
    expect(shouldMirror(true, { key: "walk", emoji: "🚶" })).toBe(true);
    expect(shouldMirror(false, { key: "walk", emoji: "🚶" })).toBe(false);
  });

  it("mirrors an emoji with no registry item behind it", () => {
    // The behaviour that used to differ per surface. Whether we happen to have
    // catalogued a giraffe says nothing about whether its picture can flip.
    expect(shouldMirror(true, { key: "🦒", emoji: "🦒" })).toBe(true);
    expect(shouldMirror(true, { emoji: "🦒" })).toBe(true);
  });

  it("keeps text-like emoji upright", () => {
    for (const emoji of ["❓", "1️⃣", "💯", "🔤"]) {
      expect(shouldMirror(true, { emoji })).toBe(false);
    }
  });

  it("keeps a contact's photo upright, in either key spelling", () => {
    // 👤 is an ordinary pictograph, so the emoji rule alone would flip a face.
    // A portrait has no direction relative to the sentence, and the face
    // gallery exists so a student RECOGNIZES someone.
    expect(shouldMirror(true, { key: "face:abc", emoji: "👤" })).toBe(false);
    expect(shouldMirror(true, { key: "__FACE__:abc", emoji: "👤" })).toBe(false);
    expect(isFaceKey("face:abc")).toBe(true);
    expect(isFaceKey("__FACE__:abc")).toBe(true);
    expect(isFaceKey("apple")).toBe(false);
  });

  it("honours an item's nonReversible flag over its emoji", () => {
    expect(shouldMirror(true, { emoji: "🚶", item: { nonReversible: true } })).toBe(false);
  });

  it("falls back to the item's emoji when the surface passes none", () => {
    expect(shouldMirror(true, { item: { emoji: "❓" } })).toBe(false);
    expect(shouldMirror(true, { item: { emoji: "🚶" } })).toBe(true);
  });

  it("mirrors bundled-art items that carry no emoji at all", () => {
    // Defaulting these to upright would freeze most of the artwork in Hebrew.
    expect(shouldMirror(true, { key: "some_drawn_thing" })).toBe(true);
  });
});

describe("rtlMirrorStyle — the DOM form of the same rule", () => {
  it("returns a scaleX(-1) style exactly when shouldMirror is true", () => {
    expect(rtlMirrorStyle(true, "🚶")).toEqual({ transform: "scaleX(-1)" });
    expect(rtlMirrorStyle(false, "🚶")).toBeUndefined();
    expect(rtlMirrorStyle(true, "❓")).toBeUndefined();
    expect(rtlMirrorStyle(true, { key: "face:abc", emoji: "👤" })).toBeUndefined();
  });

  it("accepts a bare emoji string as shorthand", () => {
    expect(rtlMirrorStyle(true, "🐱")).toEqual(rtlMirrorStyle(true, { emoji: "🐱" }));
  });

  it("returns one shared object so React sees a stable style prop", () => {
    expect(rtlMirrorStyle(true, "🐱")).toBe(rtlMirrorStyle(true, "🚶"));
  });

  it("tolerates an absent subject", () => {
    expect(rtlMirrorStyle(true, undefined)).toEqual({ transform: "scaleX(-1)" });
  });
});
