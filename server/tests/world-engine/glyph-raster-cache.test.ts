// The two halves of "bubble icons show up instantly, and the right way round":
// the on-device raster cache's KEY (what may share a stored bitmap with what),
// and the prewarm vocabulary that gets composed before anything asks for it.
//
// The store itself is IndexedDB — absent under `testEnvironment: 'node'` — so what
// is pinned here is the key algebra plus the headless contract: with no storage
// available every entry point must resolve to a miss, silently. That contract is
// the whole safety story for this cache, since a throw would take the bubble with
// it.

import { describe, it, expect } from "@jest/globals";
import {
  GLYPH_RASTER_EPOCH,
  clearGlyphRasterCache,
  glyphRasterKey,
  readGlyphRaster,
  canBankSlotAsset,
  readSlotAsset,
  slotAssetKey,
  writeGlyphRaster,
  writeSlotAsset,
} from "@shared/world-engine/glyph-raster-cache.js";
import { dwellBubble, dwellBubbleGlyphs, restDoneBubble } from "@shared/world-engine/interaction/quest/activity-bubble.js";
import { isRtlLocale } from "@shared/world-engine/interaction/lang/index.js";
import { getVocabularyItem } from "@shared/glyph-registry.js";

describe("glyph raster cache key", () => {
  it("separates the two text directions", () => {
    // A composed glyph lays its slots out in reading order, so the RTL bitmap is
    // a DIFFERENT picture — sharing one entry would serve Hebrew an English glyph.
    expect(glyphRasterKey("i_me + want + apple", true, false)).not.toBe(
      glyphRasterKey("i_me + want + apple", false, false),
    );
  });

  it("separates plated from bare", () => {
    // `noBackground` drops the tone plate for a glyph worn by a model-less object.
    expect(glyphRasterKey("apple", false, true)).not.toBe(glyphRasterKey("apple", false, false));
  });

  it("keeps distinct glyphs distinct", () => {
    expect(glyphRasterKey("apple", false, false)).not.toBe(glyphRasterKey("apple.cold", false, false));
  });

  it("is stable for the same glyph, direction and plate", () => {
    expect(glyphRasterKey("apple", true, true)).toBe(glyphRasterKey("apple", true, true));
  });

  it("carries the epoch, so a bump orphans every stored bitmap", () => {
    // The only way to retire a stale raster: nothing about a bitmap says which
    // generation of the art it was cut from. (Slot assets need no epoch — their
    // key is the content-hashed asset URL.)
    expect(glyphRasterKey("apple", false, false).split("|")).toContain(String(GLYPH_RASTER_EPOCH));
  });
});

describe("slot asset key", () => {
  it("never collides with a whole-glyph key", () => {
    // Eviction filters by prefix and only ever drops whole-glyph rasters; if the
    // namespaces could overlap, churning sentences would evict the shrunk icons
    // that are the entire point of the slot cache.
    const glyphKeys = ["apple", "s|200|/assets/apple.png", ""].map((g) => glyphRasterKey(g, false, false));
    const slotKeys = ["/assets/apple-a1b2.png", "g|1|l|p|apple"].map((u) => slotAssetKey(u, 200));
    for (const s of slotKeys) expect(glyphKeys).not.toContain(s);
    for (const g of glyphKeys) expect(slotKeys).not.toContain(g);
  });

  it("re-shrinks when the size cap changes rather than serving the old size", () => {
    expect(slotAssetKey("/assets/apple.png", 200)).not.toBe(slotAssetKey("/assets/apple.png", 320));
  });

  it("keeps distinct assets distinct", () => {
    expect(slotAssetKey("/assets/apple.png", 200)).not.toBe(slotAssetKey("/assets/pear.png", 200));
  });
});

describe("canBankSlotAsset", () => {
  it("banks bundled, content-hashed app assets", () => {
    expect(canBankSlotAsset("/assets/walk-a1b2c3.png")).toBe(true);
    expect(canBankSlotAsset("../../attached_assets/aac-icons/actions/body/come.png")).toBe(true);
  });

  it("refuses anything served under /api — the art can be REPLACED under a stable id", () => {
    // A re-uploaded custom symbol keeps its id, so a banked copy would show the
    // student last month's picture.
    expect(canBankSlotAsset("/api/custom-symbols/42/image")).toBe(false);
  });

  it("refuses a cross-origin symbol (generated art on a CDN)", () => {
    expect(canBankSlotAsset("https://cdn.example.com/symbols/42.png")).toBe(false);
  });

  it("refuses inline and object URLs, which are not addresses of anything durable", () => {
    expect(canBankSlotAsset("data:image/png;base64,AAAA")).toBe(false);
    expect(canBankSlotAsset("blob:http://x/1234")).toBe(false);
    expect(canBankSlotAsset("")).toBe(false);
  });
});

describe("glyph raster cache without storage", () => {
  it("reads as a miss rather than throwing", async () => {
    await expect(readGlyphRaster(glyphRasterKey("apple", false, false))).resolves.toBeNull();
  });

  it("swallows a write", async () => {
    await expect(
      writeGlyphRaster(glyphRasterKey("apple", false, false), new ArrayBuffer(8)),
    ).resolves.toBeUndefined();
  });

  it("swallows a clear", async () => {
    await expect(clearGlyphRasterCache()).resolves.toBeUndefined();
  });

  it("reads a slot asset as a miss and swallows its write", async () => {
    const key = slotAssetKey("/assets/apple-a1b2.png", 200);
    await expect(readSlotAsset(key)).resolves.toBeNull();
    await expect(writeSlotAsset(key, "data:image/png;base64,AAAA")).resolves.toBeUndefined();
  });
});

describe("dwell bubble prewarm vocabulary", () => {
  it("covers every glyph the dwell and rest bubbles can emit", () => {
    const warm = new Set(dwellBubbleGlyphs());
    const emitted = [
      ...(["sleep", "eat", "sit", "play"] as const).flatMap((p) =>
        ["toilet", "bath", undefined].map((s) => dwellBubble(s, p).glyph),
      ),
      ...["fun", "hygiene", "waste", "rest"].map((k) => restDoneBubble(k).glyph),
    ].filter((g): g is string => !!g);
    expect(emitted.length).toBeGreaterThan(0);
    for (const g of emitted) expect(warm.has(g)).toBe(true);
  });

  it("lists nothing twice — the same glyph must not be composed twice", () => {
    const list = dwellBubbleGlyphs();
    expect(list.length).toBe(new Set(list).size);
  });

  it("warms only glyphs, never the emoji fallbacks", () => {
    // A motive with no bundled art emits `{text: emoji}` and NO glyph; prewarming
    // an emoji string would compose a bitmap nothing ever asks for.
    for (const g of dwellBubbleGlyphs()) expect(g.trim()).toBe(g);
    expect(dwellBubbleGlyphs()).not.toContain("🚽");
    expect(dwellBubbleGlyphs()).not.toContain("🛋️");
  });
});

describe("newly wired bundled icons", () => {
  // The art landed under attached_assets first; these pin that each key actually
  // CLAIMS it, since a registry entry with no imagePath silently keeps its emoji
  // and the new artwork would never be seen.
  const WIRED: ReadonlyArray<readonly [string, string]> = [
    ["come", "actions/body/come"],
    ["follow", "actions/body/follow"],
    ["enter", "actions/body/enter"],
    ["exit", "actions/body/exit"],
    ["read", "actions/body/read"],
    ["learn", "actions/body/learn"],
    ["understand", "adjectives/feelings/understand"],
    ["confused", "adjectives/feelings/confused"],
    ["do", "actions/hands/do"],
    ["my", "adjectives/possession/my"],
    ["your", "adjectives/possession/your"],
  ];

  it.each(WIRED)("%s points at its bundled art", (key, imagePath) => {
    expect(getVocabularyItem(key)?.imagePath).toBe(imagePath);
  });

  it.each(WIRED)("%s is a registered, translatable entry", (key) => {
    const item = getVocabularyItem(key);
    expect(item).toBeDefined();
    expect(item!.tKey).toBe(`aac.glyph.${key}`);
  });

  it("marks the motion verbs directional so RTL flips them", () => {
    // The whole reason these upgrade from emoji to bundled art: an emoji can't
    // flip, so in Hebrew the figure would walk away from the reader.
    for (const key of ["come", "follow", "enter", "exit"]) {
      expect(getVocabularyItem(key)?.directional).toBe(true);
    }
  });

  it("does not make the mental/feeling verbs directional", () => {
    // Nothing in "read" or "confused" points anywhere; flipping them in RTL
    // would mirror artwork for no reason.
    for (const key of ["read", "learn", "understand", "confused"]) {
      expect(getVocabularyItem(key)?.directional).toBeUndefined();
    }
  });

  it("drops `directional` from my / your now that they have their own art", () => {
    // They inherited the flag from the take/give hands they used to borrow,
    // where the palm really does face left or right. The possession art states
    // the possessor in DEPTH — held to the chest vs offered outward — which a
    // mirror leaves intact, so the flag no longer describes anything true.
    for (const key of ["my", "your"]) {
      expect(getVocabularyItem(key)?.directional).toBeUndefined();
    }
  });

  it("keeps my / your as corner badges on opposite rows", () => {
    // The corner is how the two stay distinguishable at badge size, where the
    // figures read as little more than a silhouette.
    expect(getVocabularyItem("my")?.modifier?.corner).toBe("top-left");
    expect(getVocabularyItem("your")?.modifier?.corner).toBe("bottom-left");
  });

  it("points `receive` at the art that still exists", () => {
    // hands/receive.png was deleted when the icon was redrawn as hands/get.png.
    // A dangling path is invisible — the button just falls back to 🙌.
    expect(getVocabularyItem("receive")?.imagePath).toBe("actions/hands/get");
  });
});

describe("isRtlLocale", () => {
  it("reads Hebrew and Arabic right-to-left", () => {
    expect(isRtlLocale("he")).toBe(true);
    expect(isRtlLocale("ar")).toBe(true);
  });

  it("covers a script with no shipped glyph ruleset", () => {
    // Arabic text falls back to the English ruleset, but its SYMBOLS still read
    // right-to-left — direction belongs to the script, not to the translator.
    expect(isRtlLocale("ar-EG")).toBe(true);
  });

  it("reads the shipped LTR locales left-to-right", () => {
    for (const l of ["en", "es", "pt", "fr", "de", "ru", "zh", "yue", "ko"]) {
      expect(isRtlLocale(l)).toBe(false);
    }
  });

  it("resolves a BCP-47 region tag by its primary subtag", () => {
    expect(isRtlLocale("he-IL")).toBe(true);
    expect(isRtlLocale("pt-BR")).toBe(false);
  });

  it("is case- and separator-insensitive", () => {
    expect(isRtlLocale("HE")).toBe(true);
    expect(isRtlLocale("he_IL")).toBe(true);
  });

  it("defaults an absent or unknown locale to left-to-right", () => {
    expect(isRtlLocale(undefined)).toBe(false);
    expect(isRtlLocale("")).toBe(false);
    expect(isRtlLocale("zz")).toBe(false);
  });
});
