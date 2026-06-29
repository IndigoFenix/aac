// Unit tests for the pure video-layout helpers (shared/call/video-layout.ts) —
// spotlight selection priority and tile arrangement per mode. No DOM/React.

import { describe, it, expect } from "@jest/globals";
import {
  pickSpotlightId,
  arrangeTiles,
  gridColumnsFor,
} from "@shared/call/video-layout.js";

describe("pickSpotlightId", () => {
  const tiles = ["a", "b", "c"];

  it("prefers a present manual pin above all else", () => {
    expect(pickSpotlightId(tiles, { manualPin: "b", activeSpeakerId: "c" })).toBe("b");
  });

  it("falls back to the active speaker when no (present) pin", () => {
    expect(pickSpotlightId(tiles, { activeSpeakerId: "c" })).toBe("c");
  });

  it("ignores a pin / speaker that is no longer present", () => {
    expect(pickSpotlightId(tiles, { manualPin: "gone", activeSpeakerId: "also-gone" })).toBe("a");
  });

  it("returns null for an empty roster", () => {
    expect(pickSpotlightId([], { activeSpeakerId: "x" })).toBeNull();
  });
});

describe("gridColumnsFor", () => {
  it("is 1 for 0 or 1 tiles and ~square otherwise", () => {
    expect(gridColumnsFor(0)).toBe(1);
    expect(gridColumnsFor(1)).toBe(1);
    expect(gridColumnsFor(2)).toBe(2);
    expect(gridColumnsFor(4)).toBe(2);
    expect(gridColumnsFor(5)).toBe(3);
    expect(gridColumnsFor(9)).toBe(3);
  });
});

describe("arrangeTiles", () => {
  const tiles = ["a", "b", "c"];

  it("spotlight: prominent tile excluded from the strip", () => {
    const out = arrangeTiles("spotlight", tiles, "b");
    expect(out.spotlightId).toBe("b");
    expect(out.strip).toEqual(["a", "c"]);
  });

  it("auto: behaves like spotlight using the supplied prominent id", () => {
    const out = arrangeTiles("auto", tiles, "c");
    expect(out.spotlightId).toBe("c");
    expect(out.strip).toEqual(["a", "b"]);
  });

  it("spotlight: defaults to the first tile when the requested id is absent", () => {
    const out = arrangeTiles("spotlight", tiles, "gone");
    expect(out.spotlightId).toBe("a");
    expect(out.strip).toEqual(["b", "c"]);
  });

  it("grid: no prominent tile, everyone in the strip", () => {
    const out = arrangeTiles("grid", tiles, "b");
    expect(out.spotlightId).toBeNull();
    expect(out.strip).toEqual(tiles);
    expect(out.gridColumns).toBe(2);
  });

  it("compact: no prominent tile, everyone in the strip", () => {
    const out = arrangeTiles("compact", tiles, null);
    expect(out.spotlightId).toBeNull();
    expect(out.strip).toEqual(tiles);
  });

  it("handles an empty roster", () => {
    const out = arrangeTiles("spotlight", [], null);
    expect(out.spotlightId).toBeNull();
    expect(out.strip).toEqual([]);
  });
});
