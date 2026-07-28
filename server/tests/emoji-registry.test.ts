/**
 * Tests for the emoji registry — focused on `isNonReversibleEmoji`, which
 * governs whether an emoji is horizontally mirrored in RTL. Text-like emoji
 * (digits/letters/words/punctuation) must NOT flip; ordinary pictographs must.
 */

import { describe, it, expect } from "@jest/globals";
import {
  isNonReversibleEmoji,
  isNonReversibleItem,
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
