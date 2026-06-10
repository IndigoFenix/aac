// server/services/youtube/channel-search.ts
//
// YouTube channel utilities for the permitted-channels feature.
// - RSS-based listing (no API key) for each permitted channel's recent uploads
// - Optional YouTube Data API search when YOUTUBE_API_KEY is present
// - URL → channelId resolver (scrapes HTML meta, one-time per channel)
//
// RSS feed format: https://www.youtube.com/feeds/videos.xml?channel_id=UCxxx
// Returns the channel's 15 most-recent uploads, no auth, no quota.

import type { PermittedYoutubeChannel, PermittedYoutubeItem } from "@shared/schema";
import type { YouTubeSearchResult } from "./youtube-search";

/** Hosts the URL resolver is permitted to fetch (SSRF allowlist). */
const ALLOWED_YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/** True only for a well-formed http(s) URL whose host is a YouTube property. */
function isAllowedYoutubeUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return ALLOWED_YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase());
}

/** Cached RSS entries per channel. */
interface ChannelFeedCache {
  videos: RssVideo[];
  fetchedAt: number;
}

export interface RssVideo {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  published: string; // ISO-ish
  thumbnailUrl: string;
}

const RSS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const rssCache = new Map<string, ChannelFeedCache>();

/**
 * Fetch the RSS feed for a channel and return its recent uploads.
 * Cached for RSS_CACHE_TTL_MS. Returns [] on any error.
 */
export async function fetchChannelRssVideos(channelId: string): Promise<RssVideo[]> {
  const cached = rssCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < RSS_CACHE_TTL_MS) {
    return cached.videos;
  }

  try {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 CliniAACian/1.0" } });
    if (!res.ok) {
      console.warn(`[YouTubeChannel] RSS fetch failed for ${channelId}: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const videos = parseRssFeed(xml);
    rssCache.set(channelId, { videos, fetchedAt: Date.now() });
    return videos;
  } catch (err: any) {
    console.warn(`[YouTubeChannel] RSS fetch error for ${channelId}:`, err?.message || err);
    return [];
  }
}

/** Parse the YouTube channel RSS feed into RssVideo[]. Tolerant of whitespace. */
function parseRssFeed(xml: string): RssVideo[] {
  const out: RssVideo[] = [];
  // Each <entry>…</entry> block is one video. Use a non-greedy match.
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1];
    const videoId = firstCapture(entry, /<yt:videoId>([^<]+)<\/yt:videoId>/);
    const title = firstCapture(entry, /<title>([^<]+)<\/title>/);
    const channelId = firstCapture(entry, /<yt:channelId>([^<]+)<\/yt:channelId>/);
    const channelTitle = firstCapture(entry, /<author>[\s\S]*?<name>([^<]+)<\/name>/);
    const published = firstCapture(entry, /<published>([^<]+)<\/published>/);
    if (videoId && title) {
      out.push({
        videoId,
        title: decodeXmlEntities(title),
        channelId: channelId || "",
        channelTitle: decodeXmlEntities(channelTitle || ""),
        published: published || "",
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      });
    }
  }
  return out;
}

/**
 * Fetch the RSS feed for a playlist and return its videos. Same feed format as
 * channels, keyed by `playlist_id` instead of `channel_id`. Returns the
 * playlist's most-recent ~15 entries, no auth, no quota. Cached + []-on-error,
 * exactly like {@link fetchChannelRssVideos}.
 *
 * Note: RD... "mix"/radio playlists are generated on the fly and have no RSS
 * feed — those return [].
 */
export async function fetchPlaylistRssVideos(playlistId: string): Promise<RssVideo[]> {
  const cacheKey = `pl:${playlistId}`;
  const cached = rssCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < RSS_CACHE_TTL_MS) {
    return cached.videos;
  }

  try {
    const url = `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(playlistId)}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 CliniAACian/1.0" } });
    if (!res.ok) {
      console.warn(`[YouTubeChannel] Playlist RSS fetch failed for ${playlistId}: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const videos = parseRssFeed(xml);
    rssCache.set(cacheKey, { videos, fetchedAt: Date.now() });
    return videos;
  } catch (err: any) {
    console.warn(`[YouTubeChannel] Playlist RSS fetch error for ${playlistId}:`, err?.message || err);
    return [];
  }
}

function firstCapture(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m ? m[1] : null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------------------
// Search within permitted channels
// ---------------------------------------------------------------------------

/** A search candidate: a resolved playable video plus the title used for matching. */
type SearchCandidate = { video: YouTubeSearchResult; title: string; published?: string };

/**
 * Search for a video within the permitted sources (channels + playlists).
 * - Channels: Data API v3 search.list with a channelId filter when
 *   YOUTUBE_API_KEY is set (deep search), otherwise the channel's RSS feed.
 * - Playlists: RSS feed (`playlist_id=`) — no API key needed, covers every
 *   real playlist.
 *
 * All candidate videos are pooled and the best title match to the query wins.
 * With an empty query, the most-recent video across all sources is returned.
 * Returns null if no sources or no videos found.
 */
export async function searchWithinPermittedSources(
  query: string,
  channels: PermittedYoutubeChannel[],
  playlists: PermittedYoutubeItem[] = [],
): Promise<YouTubeSearchResult | null> {
  if (!channels.length && !playlists.length) return null;

  const candidates: SearchCandidate[] = [];

  if (channels.length) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    let channelCandidates: SearchCandidate[] = [];
    if (apiKey) {
      channelCandidates = await gatherChannelApiCandidates(query, channels, apiKey);
    }
    // Fall back to RSS if the API path is unavailable or returned nothing
    // (covers no-key and quota-exceeded).
    if (!channelCandidates.length) {
      channelCandidates = await gatherChannelRssCandidates(channels);
    }
    candidates.push(...channelCandidates);
  }

  if (playlists.length) {
    candidates.push(...(await gatherPlaylistRssCandidates(playlists)));
  }

  if (candidates.length === 0) return null;

  // No query → most-recent across all sources. API hits without a published
  // date sort last.
  if (!query.trim()) {
    const sorted = [...candidates].sort((a, b) =>
      (b.published || "").localeCompare(a.published || ""),
    );
    return sorted[0].video;
  }

  const best = pickBestMatch(query, candidates);
  return best?.video ?? null;
}

/**
 * @deprecated Prefer {@link searchWithinPermittedSources}. Thin wrapper kept for
 * callers that only have channels (no playlists).
 */
export async function searchWithinPermittedChannels(
  query: string,
  channels: PermittedYoutubeChannel[],
): Promise<YouTubeSearchResult | null> {
  return searchWithinPermittedSources(query, channels, []);
}

/** Gather candidates from each channel via the Data API (up to 5 per channel). */
async function gatherChannelApiCandidates(
  query: string,
  channels: PermittedYoutubeChannel[],
  apiKey: string,
): Promise<SearchCandidate[]> {
  const searches = channels.map(async (ch): Promise<SearchCandidate[]> => {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      safeSearch: "strict",
      videoEmbeddable: "true",
      maxResults: "5",
      channelId: ch.channelId,
      key: apiKey,
    });
    if (query.trim()) params.set("q", query.trim());
    const url = `https://www.googleapis.com/youtube/v3/search?${params}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      return items
        .filter((it: any) => it?.id?.videoId)
        .map((it: any) => ({
          video: {
            videoId: it.id.videoId,
            title: it.snippet?.title || "Video",
            channelTitle: it.snippet?.channelTitle || ch.label,
            thumbnailUrl:
              it.snippet?.thumbnails?.medium?.url ||
              it.snippet?.thumbnails?.default?.url ||
              "",
          } as YouTubeSearchResult,
          title: it.snippet?.title || "",
        }));
    } catch {
      return [];
    }
  });
  return (await Promise.all(searches)).flat();
}

/** Gather candidates from each channel's RSS feed. */
async function gatherChannelRssCandidates(
  channels: PermittedYoutubeChannel[],
): Promise<SearchCandidate[]> {
  const feeds = await Promise.all(
    channels.map(async (ch) => ({ ch, videos: await fetchChannelRssVideos(ch.channelId) })),
  );
  const out: SearchCandidate[] = [];
  for (const { ch, videos } of feeds) {
    for (const v of videos) {
      out.push({ video: rssToResult(v, ch.label), title: v.title, published: v.published });
    }
  }
  return out;
}

/** Gather candidates from each playlist's RSS feed. */
async function gatherPlaylistRssCandidates(
  playlists: PermittedYoutubeItem[],
): Promise<SearchCandidate[]> {
  const feeds = await Promise.all(
    playlists.map(async (pl) => ({ pl, videos: await fetchPlaylistRssVideos(pl.id) })),
  );
  const out: SearchCandidate[] = [];
  for (const { pl, videos } of feeds) {
    for (const v of videos) {
      out.push({ video: rssToResult(v, pl.label), title: v.title, published: v.published });
    }
  }
  return out;
}

function rssToResult(v: RssVideo, fallbackChannelLabel: string): YouTubeSearchResult {
  return {
    videoId: v.videoId,
    title: v.title,
    channelTitle: v.channelTitle || fallbackChannelLabel,
    thumbnailUrl: v.thumbnailUrl,
  };
}

/**
 * Token-overlap scoring; returns the highest-scoring candidate.
 *
 * With a non-empty query, requires at least one token overlap — otherwise
 * returns null. Picking a zero-overlap title would play something unrelated
 * to what the AI asked for; letting the caller fall back to browse mode is
 * much less confusing for the student.
 *
 * With an empty query, returns the first candidate (caller has already
 * sorted by recency).
 */
function pickBestMatch<T>(
  query: string,
  candidates: Array<{ video: T; title: string }>,
): { video: T; title: string } | null {
  if (candidates.length === 0) return null;
  const qTokens = tokenize(query);
  if (qTokens.size === 0) return candidates[0];

  let best: { video: T; title: string } | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const tTokens = tokenize(c.title);
    let overlap = 0;
    for (const q of qTokens) {
      if (tTokens.has(q)) overlap++;
    }
    if (overlap > bestScore) {
      bestScore = overlap;
      best = c;
    }
  }
  return best; // null if no candidate scored > 0
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

// ---------------------------------------------------------------------------
// URL → channelId resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a YouTube URL (channel page, @handle, custom URL, or watch URL) to a
 * UC... channel ID. Scrapes the HTML for the `<meta itemprop="channelId">` tag
 * or the `"externalId":"UC..."` pattern in embedded JSON. No API key needed.
 *
 * Returns null if the URL can't be resolved.
 */
export async function resolveChannelIdFromUrl(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Direct channel ID pass-through.
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;

  // Normalize to a full URL.
  let url: string;
  if (/^https?:\/\//i.test(trimmed)) {
    url = trimmed;
  } else if (trimmed.startsWith("@")) {
    url = `https://www.youtube.com/${trimmed}`;
  } else if (trimmed.startsWith("youtube.com") || trimmed.startsWith("www.youtube.com")) {
    url = `https://${trimmed}`;
  } else {
    // Treat anything else as a handle.
    url = `https://www.youtube.com/@${trimmed.replace(/^\/+/, "")}`;
  }

  // SSRF guard: `input` may be an arbitrary http(s) URL. Only ever fetch YouTube
  // hosts — otherwise this resolver lets a caller make the server issue requests
  // to internal hosts / the cloud metadata endpoint.
  if (!isAllowedYoutubeUrl(url)) {
    return null;
  }

  try {
    const res = await fetch(url, {
      headers: {
        // YouTube serves the lightweight page to this UA string; avoids some
        // A/B-tested variants that omit the meta tag.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Method 1: meta tag (most reliable when present).
    const metaMatch = /<meta itemprop=["']?(?:channelId|identifier)["']? content=["'](UC[A-Za-z0-9_-]{20,})["']/.exec(html);
    if (metaMatch) return metaMatch[1];

    // Method 2: JSON payload embedded in the page.
    const jsonMatch = /"(?:externalId|channelId|browseId)"\s*:\s*"(UC[A-Za-z0-9_-]{20,})"/.exec(html);
    if (jsonMatch) return jsonMatch[1];

    // Method 3: canonical /channel/ link.
    const canonMatch = /\/channel\/(UC[A-Za-z0-9_-]{20,})/.exec(html);
    if (canonMatch) return canonMatch[1];

    return null;
  } catch (err: any) {
    console.warn("[YouTubeChannel] resolveChannelIdFromUrl failed:", err?.message || err);
    return null;
  }
}

export interface ChannelMetadata {
  title: string | null;
  description: string | null;
}

/**
 * Fetch recent videos for every permitted channel in parallel (RSS-backed,
 * cached). Used to enrich the interactive agent prompt so the AI can suggest
 * real available content instead of guessing.
 *
 * `maxPerChannel` caps videos per channel in the output (default 6) to keep
 * the prompt bounded.
 */
export async function fetchRecentVideosForChannels(
  channels: PermittedYoutubeChannel[],
  maxPerChannel = 6,
): Promise<Array<{ channel: PermittedYoutubeChannel; videos: RssVideo[] }>> {
  const results = await Promise.all(
    channels.map(async (channel) => ({
      channel,
      videos: (await fetchChannelRssVideos(channel.channelId)).slice(0, maxPerChannel),
    })),
  );
  return results;
}

/**
 * Recent videos per permitted playlist (RSS-backed, cached). Mirrors
 * {@link fetchRecentVideosForChannels} for the prompt enrichment so the AI can
 * suggest real playlist content instead of guessing.
 */
export async function fetchRecentVideosForPlaylists(
  playlists: PermittedYoutubeItem[],
  maxPerPlaylist = 6,
): Promise<Array<{ playlist: PermittedYoutubeItem; videos: RssVideo[] }>> {
  const results = await Promise.all(
    playlists.map(async (playlist) => ({
      playlist,
      videos: (await fetchPlaylistRssVideos(playlist.id)).slice(0, maxPerPlaylist),
    })),
  );
  return results;
}

const metadataCache = new Map<string, { data: ChannelMetadata; fetchedAt: number }>();
const METADATA_TTL_MS = 24 * 60 * 60 * 1000; // 24h — channel names rarely change

/**
 * Fetch display title + description for a channel by scraping the channel page.
 * Uses Open Graph meta tags (`og:title`, `og:description`) as the source.
 * Returns { title: null, description: null } on any failure — callers should
 * treat this as soft-missing and fall back to the clinician's input.
 */
export async function fetchChannelMetadata(channelId: string): Promise<ChannelMetadata> {
  const cached = metadataCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < METADATA_TTL_MS) {
    return cached.data;
  }

  const url = `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      const miss: ChannelMetadata = { title: null, description: null };
      metadataCache.set(channelId, { data: miss, fetchedAt: Date.now() });
      return miss;
    }
    const html = await res.text();

    const title = extractMeta(html, "og:title") || extractMeta(html, "twitter:title");
    const description =
      extractMeta(html, "og:description") || extractMeta(html, "description");

    const data: ChannelMetadata = {
      title: title ? decodeHtmlEntities(title).trim() : null,
      description: description ? decodeHtmlEntities(description).trim() : null,
    };
    metadataCache.set(channelId, { data, fetchedAt: Date.now() });
    return data;
  } catch (err: any) {
    console.warn("[YouTubeChannel] fetchChannelMetadata failed:", err?.message || err);
    return { title: null, description: null };
  }
}

// ---------------------------------------------------------------------------
// Video URL → videoId resolver + metadata fetch (for the pinned-videos feature)
// ---------------------------------------------------------------------------

/** YouTube video IDs are always 11 chars of [A-Za-z0-9_-]. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Resolve a YouTube video URL (watch, youtu.be, shorts, embed) or raw videoId
 * to an 11-character videoId. Returns null when nothing matches — callers
 * should treat that as "couldn't parse" and surface a friendly error.
 */
export function resolveVideoIdFromUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  // watch?v= — works whether the URL has a scheme or not.
  const vParam = /[?&]v=([A-Za-z0-9_-]{11})/.exec(trimmed);
  if (vParam) return vParam[1];

  // youtu.be/<id>, /embed/<id>, /shorts/<id>, /live/<id>
  const pathMatch = /(?:youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/.exec(trimmed);
  if (pathMatch) return pathMatch[1];

  return null;
}

export interface VideoMetadata {
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
}

const videoMetadataCache = new Map<string, { data: VideoMetadata; fetchedAt: number }>();
const VIDEO_METADATA_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch title + description + thumbnail for a video by scraping the watch
 * page. Soft-fails to nulls on any error — callers fall back to the clinician's
 * input. No API key needed.
 */
export async function fetchVideoMetadata(videoId: string): Promise<VideoMetadata> {
  const cached = videoMetadataCache.get(videoId);
  if (cached && Date.now() - cached.fetchedAt < VIDEO_METADATA_TTL_MS) {
    return cached.data;
  }
  const fallbackThumb = `https://img.youtube.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      const miss: VideoMetadata = { title: null, description: null, thumbnailUrl: fallbackThumb };
      videoMetadataCache.set(videoId, { data: miss, fetchedAt: Date.now() });
      return miss;
    }
    const html = await res.text();
    const title = extractMeta(html, "og:title") || extractMeta(html, "twitter:title");
    const description = extractMeta(html, "og:description") || extractMeta(html, "description");
    const thumb = extractMeta(html, "og:image") || extractMeta(html, "twitter:image");
    const data: VideoMetadata = {
      title: title ? decodeHtmlEntities(title).trim() : null,
      description: description ? decodeHtmlEntities(description).trim() : null,
      thumbnailUrl: thumb || fallbackThumb,
    };
    videoMetadataCache.set(videoId, { data, fetchedAt: Date.now() });
    return data;
  } catch (err: any) {
    console.warn("[YouTubeChannel] fetchVideoMetadata failed:", err?.message || err);
    return { title: null, description: null, thumbnailUrl: fallbackThumb };
  }
}

// ---------------------------------------------------------------------------
// Playlist URL → playlistId resolver + metadata + unified item resolver
// ---------------------------------------------------------------------------

/** Persistent playlist IDs start with one of these prefixes (RD... mixes excluded — no RSS). */
const PLAYLIST_ID_RE = /^(PL|UU|OL|LL|FL)[A-Za-z0-9_-]{10,}$/;

/**
 * Resolve a YouTube playlist URL or raw playlist ID to a canonical playlistId.
 * Accepts a `?list=...` param on any URL, a bare playlist ID, or a /playlist
 * page. Returns null when nothing matches.
 */
export function resolvePlaylistIdFromUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (PLAYLIST_ID_RE.test(trimmed)) return trimmed;
  const listMatch = /[?&]list=([A-Za-z0-9_-]+)/.exec(trimmed);
  if (listMatch && PLAYLIST_ID_RE.test(listMatch[1])) return listMatch[1];
  return null;
}

export interface PlaylistMetadata {
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
}

const playlistMetadataCache = new Map<string, { data: PlaylistMetadata; fetchedAt: number }>();

/**
 * Fetch title + description + thumbnail for a playlist by scraping the
 * /playlist page (Open Graph tags). Soft-fails to nulls — callers fall back to
 * the clinician's pasted input. No API key needed.
 */
export async function fetchPlaylistMetadata(playlistId: string): Promise<PlaylistMetadata> {
  const cached = playlistMetadataCache.get(playlistId);
  if (cached && Date.now() - cached.fetchedAt < METADATA_TTL_MS) {
    return cached.data;
  }
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      const miss: PlaylistMetadata = { title: null, description: null, thumbnailUrl: null };
      playlistMetadataCache.set(playlistId, { data: miss, fetchedAt: Date.now() });
      return miss;
    }
    const html = await res.text();
    const title = extractMeta(html, "og:title") || extractMeta(html, "twitter:title");
    const description = extractMeta(html, "og:description") || extractMeta(html, "description");
    const thumb = extractMeta(html, "og:image") || extractMeta(html, "twitter:image");
    const data: PlaylistMetadata = {
      title: title ? decodeHtmlEntities(title).trim() : null,
      description: description ? decodeHtmlEntities(description).trim() : null,
      thumbnailUrl: thumb || null,
    };
    playlistMetadataCache.set(playlistId, { data, fetchedAt: Date.now() });
    return data;
  } catch (err: any) {
    console.warn("[YouTubeChannel] fetchPlaylistMetadata failed:", err?.message || err);
    return { title: null, description: null, thumbnailUrl: null };
  }
}

/**
 * Detect what kind of YouTube resource a pasted string points at and resolve
 * its canonical id. Tries, in order: raw id → that kind; explicit playlist
 * page or a `list=` with no specific video → playlist; watch / youtu.be /
 * shorts / embed / live → video; otherwise a channel (handle / custom URL /
 * UC id, scraped).
 *
 * A watch URL that ALSO carries a `list=` param resolves to the video (the most
 * specific single thing) — to add a playlist, paste the playlist URL itself.
 */
export async function resolveYoutubeItemFromUrl(
  input: string,
): Promise<{ type: "channel" | "playlist" | "video"; id: string } | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Raw ids first (unambiguous).
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(trimmed)) return { type: "channel", id: trimmed };
  if (PLAYLIST_ID_RE.test(trimmed)) return { type: "playlist", id: trimmed };
  if (VIDEO_ID_RE.test(trimmed)) return { type: "video", id: trimmed };

  const listMatch = /[?&]list=([A-Za-z0-9_-]+)/.exec(trimmed);
  const hasVideoParam =
    /[?&]v=[A-Za-z0-9_-]{11}/.test(trimmed) ||
    /(?:youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)[A-Za-z0-9_-]{11}/.test(trimmed);
  const isPlaylistPage = /\/playlist\b/i.test(trimmed);

  // Explicit playlist page, or a list= with no specific video → playlist.
  if ((isPlaylistPage || !hasVideoParam) && listMatch && PLAYLIST_ID_RE.test(listMatch[1])) {
    return { type: "playlist", id: listMatch[1] };
  }

  // Video URL forms.
  const videoId = resolveVideoIdFromUrl(trimmed);
  if (videoId) return { type: "video", id: videoId };

  // Anything else: treat as a channel (handle / custom URL / channel page).
  const channelId = await resolveChannelIdFromUrl(trimmed);
  if (channelId) return { type: "channel", id: channelId };

  return null;
}

function extractMeta(html: string, name: string): string | null {
  // Match <meta property="og:title" content="..."> and <meta name="description" content="...">
  const re = new RegExp(
    `<meta\\s+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}["']\\s+content=["']([^"']*)["']`,
    "i",
  );
  const m = re.exec(html);
  return m ? m[1] : null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}
