// shared/youtube-items.ts
//
// Helpers for the unified permitted-YouTube list. The clinician curates a
// single `permittedYoutubeItems` array; channels, playlists, and pinned videos
// are distinguished by each item's `type`. These helpers convert between the
// unified shape and the legacy split arrays (`permittedYoutubeChannels` /
// `permittedYoutubeVideos`) so older rows keep working until they're saved
// again, and so internal code that wants one kind can filter cheaply.

import type {
  PermittedYoutubeChannel,
  PermittedYoutubeItem,
  PermittedYoutubeVideo,
} from "./schema";

/** The three kinds split out of a unified item list, in the shapes existing code expects. */
export interface SplitYoutubeItems {
  channels: PermittedYoutubeChannel[];
  playlists: PermittedYoutubeItem[];
  videos: PermittedYoutubeVideo[];
}

/**
 * Split a unified item list into channels / playlists / videos. Channels and
 * videos are returned in their legacy shapes (`channelId` / `videoId`) so the
 * existing RSS, search, and player code can consume them unchanged. Playlists
 * stay in the unified shape (there is no legacy playlist type).
 */
export function splitYoutubeItems(items: PermittedYoutubeItem[] | null | undefined): SplitYoutubeItems {
  const channels: PermittedYoutubeChannel[] = [];
  const playlists: PermittedYoutubeItem[] = [];
  const videos: PermittedYoutubeVideo[] = [];
  for (const item of items || []) {
    if (!item || typeof item.id !== "string" || !item.id) continue;
    if (item.type === "channel") {
      channels.push({ channelId: item.id, label: item.label, description: item.description });
    } else if (item.type === "playlist") {
      playlists.push(item);
    } else if (item.type === "video") {
      videos.push({ videoId: item.id, label: item.label, description: item.description });
    }
  }
  return { channels, playlists, videos };
}

/**
 * Build a unified item list from the legacy split arrays. Channels first, then
 * videos — playlists never existed in the legacy schema. Used as a read-time
 * fallback for rows that predate `permittedYoutubeItems`.
 */
export function mergeLegacyYoutubeItems(
  channels: PermittedYoutubeChannel[] | null | undefined,
  videos: PermittedYoutubeVideo[] | null | undefined,
): PermittedYoutubeItem[] {
  const out: PermittedYoutubeItem[] = [];
  for (const c of channels || []) {
    if (c && typeof c.channelId === "string" && c.channelId) {
      out.push({ type: "channel", id: c.channelId, label: c.label, description: c.description });
    }
  }
  for (const v of videos || []) {
    if (v && typeof v.videoId === "string" && v.videoId) {
      out.push({ type: "video", id: v.videoId, label: v.label, description: v.description });
    }
  }
  return out;
}

/**
 * Resolve the authoritative unified item list from an aacSettings-shaped object.
 * Prefers the new `permittedYoutubeItems` column; falls back to merging the
 * legacy channel/video arrays for rows saved before the migration backfill.
 */
export function resolvePermittedYoutubeItems(aac: {
  permittedYoutubeItems?: unknown;
  permittedYoutubeChannels?: unknown;
  permittedYoutubeVideos?: unknown;
} | null | undefined): PermittedYoutubeItem[] {
  if (Array.isArray(aac?.permittedYoutubeItems) && aac!.permittedYoutubeItems.length > 0) {
    return aac!.permittedYoutubeItems as PermittedYoutubeItem[];
  }
  const channels = Array.isArray(aac?.permittedYoutubeChannels)
    ? (aac!.permittedYoutubeChannels as PermittedYoutubeChannel[])
    : [];
  const videos = Array.isArray(aac?.permittedYoutubeVideos)
    ? (aac!.permittedYoutubeVideos as PermittedYoutubeVideo[])
    : [];
  return mergeLegacyYoutubeItems(channels, videos);
}
