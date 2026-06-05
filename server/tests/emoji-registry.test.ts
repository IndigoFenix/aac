/**
 * Tests for the emoji registry — focused on `isNonReversibleEmoji`, which
 * governs whether an emoji is horizontally mirrored in RTL. Text-like emoji
 * (digits/letters/words/punctuation) must NOT flip; ordinary pictographs must.
 */

import { describe, it, expect } from "@jest/globals";
import { isNonReversibleEmoji, resolveEmoji } from "../../shared/emoji-registry.js";

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
