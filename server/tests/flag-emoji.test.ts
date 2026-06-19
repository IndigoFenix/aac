// Tests for flagEmojiToIso — the country-flag emoji → ISO mapping used to
// render flags from bundled SVGs (Windows/Chrome lack flag glyphs).

import { flagEmojiToIso } from "../../shared/flag-emoji";

describe("flagEmojiToIso", () => {
  it("maps regional-indicator pairs to lowercase ISO codes", () => {
    expect(flagEmojiToIso("🇺🇸")).toBe("us");
    expect(flagEmojiToIso("🇬🇧")).toBe("gb");
    expect(flagEmojiToIso("🇮🇱")).toBe("il");
    expect(flagEmojiToIso("🇫🇷")).toBe("fr");
    expect(flagEmojiToIso("🇯🇵")).toBe("jp");
  });

  it("returns null for non-flag input", () => {
    expect(flagEmojiToIso("🍎")).toBeNull();      // ordinary emoji
    expect(flagEmojiToIso("US")).toBeNull();        // plain letters
    expect(flagEmojiToIso("🇺")).toBeNull();        // single regional indicator
    expect(flagEmojiToIso("🇺🇸🇸")).toBeNull();     // three indicators
    expect(flagEmojiToIso("")).toBeNull();
    expect(flagEmojiToIso("🏳️")).toBeNull();        // white flag (not a country)
  });
});
