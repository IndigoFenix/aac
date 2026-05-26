// server/tests/youtube-items.test.ts
//
// Unit tests for the unified permitted-YouTube list helpers and the URL→item
// type detection. Pure logic — no DB or network (the resolver branches tested
// here all return before any HTTP fetch).

import {
  splitYoutubeItems,
  mergeLegacyYoutubeItems,
  resolvePermittedYoutubeItems,
} from "@shared/youtube-items";
import type { PermittedYoutubeItem } from "@shared/schema";
import {
  resolveVideoIdFromUrl,
  resolvePlaylistIdFromUrl,
  resolveYoutubeItemFromUrl,
} from "../services/youtube/channel-search";

const CHANNEL_ID = "UC1234567890abcdefghijkl"; // 24 chars, UC prefix
const PLAYLIST_ID = "PLabcdefghijklmnop";
const VIDEO_ID = "dQw4w9WgXcQ"; // 11 chars

describe("splitYoutubeItems", () => {
  it("splits a mixed list into legacy-shaped channels/videos plus playlists", () => {
    const items: PermittedYoutubeItem[] = [
      { type: "channel", id: CHANNEL_ID, label: "Songs", description: "kids" },
      { type: "playlist", id: PLAYLIST_ID, label: "Bedtime" },
      { type: "video", id: VIDEO_ID, label: "Counting" },
    ];
    const { channels, playlists, videos } = splitYoutubeItems(items);

    expect(channels).toEqual([
      { channelId: CHANNEL_ID, label: "Songs", description: "kids" },
    ]);
    expect(videos).toEqual([{ videoId: VIDEO_ID, label: "Counting", description: undefined }]);
    expect(playlists).toEqual([{ type: "playlist", id: PLAYLIST_ID, label: "Bedtime" }]);
  });

  it("skips entries with a missing/empty id and tolerates null input", () => {
    const items = [
      { type: "channel", id: "", label: "bad" },
      { type: "video", id: VIDEO_ID, label: "ok" },
    ] as PermittedYoutubeItem[];
    expect(splitYoutubeItems(items).channels).toHaveLength(0);
    expect(splitYoutubeItems(items).videos).toHaveLength(1);
    expect(splitYoutubeItems(null)).toEqual({ channels: [], playlists: [], videos: [] });
  });
});

describe("mergeLegacyYoutubeItems", () => {
  it("merges channels then videos into unified items", () => {
    const merged = mergeLegacyYoutubeItems(
      [{ channelId: CHANNEL_ID, label: "Songs" }],
      [{ videoId: VIDEO_ID, label: "Counting", description: "fun" }],
    );
    expect(merged).toEqual([
      { type: "channel", id: CHANNEL_ID, label: "Songs", description: undefined },
      { type: "video", id: VIDEO_ID, label: "Counting", description: "fun" },
    ]);
  });
});

describe("resolvePermittedYoutubeItems", () => {
  it("prefers the unified column when populated", () => {
    const items: PermittedYoutubeItem[] = [{ type: "playlist", id: PLAYLIST_ID, label: "P" }];
    const resolved = resolvePermittedYoutubeItems({
      permittedYoutubeItems: items,
      permittedYoutubeChannels: [{ channelId: CHANNEL_ID, label: "legacy" }],
    });
    expect(resolved).toEqual(items);
  });

  it("falls back to merging legacy arrays when the unified column is empty/absent", () => {
    const resolved = resolvePermittedYoutubeItems({
      permittedYoutubeItems: [],
      permittedYoutubeChannels: [{ channelId: CHANNEL_ID, label: "Songs" }],
      permittedYoutubeVideos: [{ videoId: VIDEO_ID, label: "Counting" }],
    });
    expect(resolved).toEqual([
      { type: "channel", id: CHANNEL_ID, label: "Songs", description: undefined },
      { type: "video", id: VIDEO_ID, label: "Counting", description: undefined },
    ]);
  });

  it("returns [] for null settings", () => {
    expect(resolvePermittedYoutubeItems(null)).toEqual([]);
  });
});

describe("resolveVideoIdFromUrl", () => {
  it("accepts raw ids and every common URL form", () => {
    expect(resolveVideoIdFromUrl(VIDEO_ID)).toBe(VIDEO_ID);
    expect(resolveVideoIdFromUrl(`https://www.youtube.com/watch?v=${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(resolveVideoIdFromUrl(`https://youtu.be/${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(resolveVideoIdFromUrl(`https://www.youtube.com/shorts/${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(resolveVideoIdFromUrl(`https://www.youtube.com/embed/${VIDEO_ID}`)).toBe(VIDEO_ID);
  });
  it("returns null when there is no video id", () => {
    expect(resolveVideoIdFromUrl("https://www.youtube.com/@SomeChannel")).toBeNull();
    expect(resolveVideoIdFromUrl("")).toBeNull();
  });
});

describe("resolvePlaylistIdFromUrl", () => {
  it("accepts a raw playlist id and a list= param", () => {
    expect(resolvePlaylistIdFromUrl(PLAYLIST_ID)).toBe(PLAYLIST_ID);
    expect(resolvePlaylistIdFromUrl(`https://www.youtube.com/playlist?list=${PLAYLIST_ID}`)).toBe(PLAYLIST_ID);
  });
  it("ignores a non-playlist list value and empty input", () => {
    expect(resolvePlaylistIdFromUrl("https://www.youtube.com/watch?v=" + VIDEO_ID)).toBeNull();
    expect(resolvePlaylistIdFromUrl("")).toBeNull();
  });
});

describe("resolveYoutubeItemFromUrl (non-network branches)", () => {
  it("detects raw ids by shape", async () => {
    expect(await resolveYoutubeItemFromUrl(CHANNEL_ID)).toEqual({ type: "channel", id: CHANNEL_ID });
    expect(await resolveYoutubeItemFromUrl(PLAYLIST_ID)).toEqual({ type: "playlist", id: PLAYLIST_ID });
    expect(await resolveYoutubeItemFromUrl(VIDEO_ID)).toEqual({ type: "video", id: VIDEO_ID });
  });

  it("detects a playlist page URL", async () => {
    expect(await resolveYoutubeItemFromUrl(`https://www.youtube.com/playlist?list=${PLAYLIST_ID}`))
      .toEqual({ type: "playlist", id: PLAYLIST_ID });
  });

  it("treats a watch URL that also carries list= as the video (most specific)", async () => {
    expect(await resolveYoutubeItemFromUrl(`https://www.youtube.com/watch?v=${VIDEO_ID}&list=${PLAYLIST_ID}`))
      .toEqual({ type: "video", id: VIDEO_ID });
  });

  it("detects a bare video URL", async () => {
    expect(await resolveYoutubeItemFromUrl(`https://youtu.be/${VIDEO_ID}`))
      .toEqual({ type: "video", id: VIDEO_ID });
  });

  it("returns null on empty input", async () => {
    expect(await resolveYoutubeItemFromUrl("")).toBeNull();
  });
});
