import { describe, it, expect } from "@jest/globals";
import {
  isValidYoutubeVideoId,
  renderYoutubeEmbedPage,
} from "../services/youtube/youtube-embed-page";

describe("isValidYoutubeVideoId", () => {
  it("accepts a real 11-char id", () => {
    expect(isValidYoutubeVideoId("Xf-uUy5pdUI")).toBe(true);
    expect(isValidYoutubeVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isValidYoutubeVideoId("_-aBc123XYZ")).toBe(true);
  });

  it("rejects wrong length, wrong charset, and non-strings", () => {
    expect(isValidYoutubeVideoId("tooShort")).toBe(false);
    expect(isValidYoutubeVideoId("waytoolongvideoid")).toBe(false);
    expect(isValidYoutubeVideoId("bad chars!!")).toBe(false);
    expect(isValidYoutubeVideoId('"><script>x')).toBe(false); // 11 chars but illegal
    expect(isValidYoutubeVideoId(undefined)).toBe(false);
    expect(isValidYoutubeVideoId(123 as unknown)).toBe(false);
  });
});

describe("renderYoutubeEmbedPage", () => {
  it("embeds the exact validated id and loads the IFrame API", () => {
    const html = renderYoutubeEmbedPage("Xf-uUy5pdUI");
    expect(html).toContain('var VIDEO_ID = "Xf-uUy5pdUI";');
    expect(html).toContain("https://www.youtube.com/iframe_api");
    // Player relays state/errors back to the shell.
    expect(html).toContain('type: "yt-ready"');
    expect(html).toContain('type: "yt-error"');
  });

  it("only accepts commands from the packaged-shell / dev origins", () => {
    const html = renderYoutubeEmbedPage("dQw4w9WgXcQ");
    expect(html).toContain('"app://aac"');
    expect(html).toContain('"capacitor://localhost"');
    // Guards inbound commands by origin (the allow-check helper is present).
    expect(html).toContain("parentAllowed");
  });
});
