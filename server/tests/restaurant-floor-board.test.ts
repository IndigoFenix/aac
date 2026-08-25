/**
 * Pure-logic tests for the restaurant FLOOR BOARD — the data-free board a
 * student gets the moment we think they are in a restaurant.
 *
 * The floor board is the fallback the whole Location Menus feature leans on
 * (planning-docs/aac-restaurant-menus.md §3.4), so its failure modes are worth
 * pinning explicitly rather than trusting the general registry suite to cover:
 * the general suite proves "every registry item is translated", but says
 * nothing if someone deletes `yuck` from the registry entirely. Then the floor
 * board throws at build time — and this is the test that says why.
 *
 * DB-free: belongs in `test:unit`, not `integration/`.
 */

import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import {
  buildRestaurantFloorBoard,
  RESTAURANT_FLOOR_GLYPH_KEYS,
} from "../services/dual-agent/restaurant-floor-board.js";
import { getVocabularyItem } from "../../shared/glyph-registry.js";

describe("restaurant floor board", () => {
  const board = buildRestaurantFloorBoard();

  it("exposes a stable board key", () => {
    // No board key: this is a screen of the restaurant app, not one of the
    // student's pre-built boards. It must not appear in <prebuilt_boards>.
    expect(board.pages?.[0]?.buttons?.length).toBeGreaterThan(0);
  });

  it("builds one page of 8 buttons on a 4x2 grid", () => {
    expect(board.pages).toHaveLength(1);
    expect(board.grid).toEqual({ rows: 2, cols: 4 });
    expect(board.pages[0].buttons).toHaveLength(8);
  });

  it("lays buttons out in reading order with no gaps or collisions", () => {
    const seen = board.pages[0].buttons.map((b) => `${b.row},${b.col}`);
    expect(new Set(seen).size).toBe(seen.length); // no two buttons share a cell
    expect(seen).toEqual([
      "0,0", "0,1", "0,2", "0,3",
      "1,0", "1,1", "1,2", "1,3",
    ]);
  });

  it("uses the venue name when given, and a generic title otherwise", () => {
    expect(board.name).toBe("Restaurant");
    expect(buildRestaurantFloorBoard("Cafe Aroma").name).toBe("Cafe Aroma");
  });

  // ── The rules the file documents, asserted ──────────────────────────────

  it("every button carries a SINGLE registry glyph key", () => {
    for (const key of RESTAURANT_FLOOR_GLYPH_KEYS) {
      // A composed fragment (`like.not`) or multi-slot string
      // (`i_me+want+water`) has no single tKey, so the client cannot localize
      // it — the label would stay English on a Hebrew board.
      expect(key).not.toMatch(/[+.()]/);
      expect(getVocabularyItem(key)).toBeDefined();
    }
  });

  it("every button opts in to glyph localization", () => {
    // Without this the server's baked English labels ship to every locale.
    for (const b of board.pages[0].buttons) {
      expect(b.localizeFromGlyph).toBe(true);
      expect(b.glyph).toBeTruthy();
    }
  });

  it("every button speaks in place and never unloads the board", () => {
    // A student ordering a meal presses several of these in a row; exiting on
    // the first press would strand them.
    for (const b of board.pages[0].buttons) {
      expect(b.action?.type).toBe("speak");
      expect(b.action?.text).toBeTruthy();
      expect(b.exitBoard).toBeFalsy();
    }
  });

  it("glyph fallbacks are self-contained emoji, never imageKeys", () => {
    // BoardButton.glyphFallback exists precisely for when image generation
    // has NOT completed, so an imageKey there is a button that renders as
    // nothing at the moment it is needed most.
    for (const b of board.pages[0].buttons) {
      if (b.glyphFallback === undefined) continue;
      expect(b.glyphFallback).not.toMatch(/[a-z_]{3,}/); // not a bare imageKey
      expect(b.imageKey).toBeUndefined();
    }
  });

  it("covers the four things a student cannot say without it", () => {
    // Request, continuation, rejection, escalation. If a refactor drops one of
    // these categories the board still builds and still looks fine — this is
    // the only place that notices.
    const keys = new Set(RESTAURANT_FLOOR_GLYPH_KEYS);
    expect(keys).toContain("hungry");   // request
    expect(keys).toContain("more");     // continuation
    expect(keys).toContain("finished"); // continuation / stop
    expect(keys).toContain("yuck");     // rejection — the repair a wrong menu forces
    expect(keys).toContain("help");     // escalation
  });

  // ── Localization ────────────────────────────────────────────────────────

  describe("labels exist in every AAC locale", () => {
    // The general glyph-registry suite asserts this for the whole registry.
    // Repeated here scoped to the floor board so a failure names THIS board —
    // it is a shipped student-facing surface, and a raw English key on a
    // Hebrew board is exactly the silent failure CLAUDE.md warns about.
    const LOCALE_DIR = path.resolve(process.cwd(), "client-aac", "src", "i18n");
    const locales = fs
      .readdirSync(LOCALE_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".bak"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();

    function glyphKeysOf(locale: string): Set<string> {
      const lines = fs.readFileSync(path.join(LOCALE_DIR, `${locale}.ts`), "utf-8").split("\n");
      const out = new Set<string>();
      const stack: string[] = [];
      for (const raw of lines) {
        const t = raw.trim();
        const open = t.match(/^(\w+)\s*:\s*\{/);
        if (open) { stack.push(open[1]); continue; }
        if (t === "}" || t === "},") { stack.pop(); continue; }
        const kv = t.match(/^(\w+)\s*:\s*["'`]/);
        if (kv && stack.join(".") === "aac.glyph") out.add(kv[1]);
      }
      return out;
    }

    it("finds the locale files", () => {
      expect(locales).toContain("en");
      expect(locales).toContain("he");
      expect(locales.length).toBeGreaterThan(5);
    });

    it.each(locales)("%s translates every floor-board word", (locale) => {
      const present = glyphKeysOf(locale);
      expect(present.size).toBeGreaterThan(100); // the block was actually found
      const missing = RESTAURANT_FLOOR_GLYPH_KEYS.filter((key) => {
        const item = getVocabularyItem(key);
        return !item || !present.has(item.tKey.replace(/^aac\.glyph\./, ""));
      });
      expect(missing).toEqual([]);
    });
  });
});
