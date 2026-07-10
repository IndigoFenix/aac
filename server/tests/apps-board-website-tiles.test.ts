// Unit tests for the Apps-board website-tile builder (client-aac). Pure logic,
// so it runs under the server jest config without a component harness.
//
// Regression context: a student's permitted website wasn't appearing in the AAC
// Apps grid. The fix moved delivery onto the session snapshot; these tests lock
// in the tile-building + defensive coercion so a malformed settings value can
// never blank the grid or crash the render.

import {
  buildWebsiteTiles,
  hostFromUrl,
  faviconUrl,
} from "../../client-aac/src/components/apps-board-tiles";

describe("buildWebsiteTiles", () => {
  it("builds a tile for a well-formed website entry", () => {
    const tiles = buildWebsiteTiles([
      { url: "https://book-reader-beta-weld.vercel.app/", label: "Book Reader", description: "Book Reader" },
    ]);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual({
      id: "web:https://book-reader-beta-weld.vercel.app/",
      name: "Book Reader",
      icon: null,
      imageUrl: "https://book-reader-beta-weld.vercel.app/favicon.ico",
      fallbackIcon: "🌐",
      appId: "browser",
      appData: { url: "https://book-reader-beta-weld.vercel.app/", label: "Book Reader" },
    });
  });

  it("falls back to the hostname when no label is set", () => {
    const [tile] = buildWebsiteTiles([{ url: "https://www.example.com/games", label: "" }]);
    // www. is stripped for a friendlier label.
    expect(tile.name).toBe("example.com");
    expect(tile.appData.label).toBe("example.com");
  });

  it("preserves multiple entries and their order", () => {
    const tiles = buildWebsiteTiles([
      { url: "https://a.com/", label: "A" },
      { url: "https://b.com/", label: "B" },
    ]);
    expect(tiles.map(t => t.name)).toEqual(["A", "B"]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { url: "https://x.com" }],
    ["a string", "https://x.com"],
    ["a number", 42],
  ])("returns [] for a non-array value (%s)", (_label, value) => {
    expect(buildWebsiteTiles(value as unknown)).toEqual([]);
  });

  it("drops entries with a missing, empty, or non-string url", () => {
    const tiles = buildWebsiteTiles([
      { label: "no url" },
      { url: "", label: "empty" },
      { url: "   ", label: "whitespace" },
      { url: 123, label: "numeric url" },
      null,
      undefined,
      { url: "https://ok.com/", label: "keep me" },
    ] as unknown);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].name).toBe("keep me");
  });

  it("still builds a tile for an unparseable url (no favicon, url as label)", () => {
    const [tile] = buildWebsiteTiles([{ url: "not a url", label: "" }]);
    expect(tile.name).toBe("not a url"); // hostFromUrl falls back to the raw string
    expect(tile.imageUrl).toBeNull(); // faviconUrl can't parse it
    expect(tile.appData.url).toBe("not a url");
  });
});

describe("hostFromUrl", () => {
  it("strips a leading www.", () => {
    expect(hostFromUrl("https://www.example.com/path")).toBe("example.com");
  });
  it("returns the raw input when unparseable", () => {
    expect(hostFromUrl("garbage")).toBe("garbage");
  });
});

describe("faviconUrl", () => {
  it("returns origin + /favicon.ico", () => {
    expect(faviconUrl("https://example.com/deep/page")).toBe("https://example.com/favicon.ico");
  });
  it("returns null when unparseable", () => {
    expect(faviconUrl("garbage")).toBeNull();
  });
});
