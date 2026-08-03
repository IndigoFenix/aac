/**
 * The lab's LANGUAGE picker (the 🌍 bar's "Language" select).
 *
 * Pins the two rules that make it safe to hang off every preset:
 *  - it only offers locales the engine has a real glyph ruleset for (anything
 *    else silently renders English, which would make the picker a lie);
 *  - it stamps `game.world.locale` on the lowered document ONLY where that
 *    field exists — the town scope declares it (town-play-game.ts), and adding
 *    an unknown key to another scope's world params would fail validation
 *    in loadWorldManifest instead of just being ignored.
 */

import { describe, it, expect } from "vitest";
import { LAB_LOCALES, applyLabLocale, normalizeLabLocale } from "../lab-locale";
import { languageFor } from "@shared/world-engine/interaction/lang/index";

describe("LAB_LOCALES", () => {
  it("offers only locales the engine can actually translate into", () => {
    // languageFor falls back to `en` for every unshipped locale — so a code
    // whose ruleset IS the English one has no business in the picker.
    for (const { code } of LAB_LOCALES) {
      if (code === "en") continue;
      expect(languageFor(code)).not.toBe(languageFor("en"));
    }
    expect(LAB_LOCALES.map((l) => l.code)).toContain("en");
  });

  it("normalizes anything unknown (or absent storage) back to English", () => {
    expect(normalizeLabLocale("he")).toBe("he");
    expect(normalizeLabLocale(null)).toBe("en");
    expect(normalizeLabLocale(undefined)).toBe("en");
    expect(normalizeLabLocale("")).toBe("en");
    expect(normalizeLabLocale("klingon")).toBe("en");
    // A locale the AAC supports but the engine defers (fr/de/ru/ar/…) is not
    // offered — the world would come out English and look like a bug.
    expect(normalizeLabLocale("fr")).toBe("en");
  });
});

describe("applyLabLocale", () => {
  it("overrides the town document's own locale field", () => {
    const doc = { game: { scope: "town", world: { seed: 12, locale: "en" } } };
    applyLabLocale(doc, "he");
    expect(doc.game.world.locale).toBe("he");
  });

  it("adds the locale to a town that never declared one", () => {
    const doc: any = { game: { scope: "town", world: { seed: 7 } } };
    applyLabLocale(doc, "es");
    expect(doc.game.world).toEqual({ seed: 7, locale: "es" });
  });

  it("leaves a non-town scope's world params alone (unknown key = validation failure)", () => {
    const doc: any = { game: { scope: "planet", world: { seed: 3 } } };
    applyLabLocale(doc, "pt");
    expect(doc.game.world).toEqual({ seed: 3 });
  });

  it("still writes through on any scope whose document already carries a locale", () => {
    const doc: any = { game: { scope: "structure", world: { locale: "en" } } };
    applyLabLocale(doc, "pt");
    expect(doc.game.world.locale).toBe("pt");
  });

  it("is a no-op on a document with no game settings at all", () => {
    for (const doc of [null, undefined, {}, { game: null }, { game: {} }, { game: { world: "nope" } }]) {
      expect(() => applyLabLocale(doc, "he")).not.toThrow();
    }
  });
});
