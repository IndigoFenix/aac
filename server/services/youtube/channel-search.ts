// server/services/youtube/channel-search.ts
//
// YouTube channel utilities for the permitted-channels feature.
// - RSS-based listing (no API key) for each permitted channel's recent uploads
// - Optional YouTube Data API search when YOUTUBE_API_KEY is present
// - URL → channelId resolver (scrapes HTML meta, one-time per channel)
//
// RSS feed format: https://www.youtube.com/feeds/videos.xml?channel_id=UCxxx
// Returns the channel's 15 most-recent uploads, no auth, no quota.

import type { PermittedYoutubeChannel } from "@shared/schema";
import type { YouTubeSearchResult } from "./youtube-search";

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

/**
 * Search for a video within the permitted channels.
 * - If YOUTUBE_API_KEY is set: use Data API v3 search.list with channelId filter
 *   (one request per channel, pick the best match). Provides deep search.
 * - Otherwise: fetch each channel's RSS feed and pick the best title match to
 *   the query (falls back to most-recent upload when query is empty).
 *
 * Returns null if no permitted channels or no videos found.
 */
export async function searchWithinPermittedChannels(
  query: string,
  channels: PermittedYoutubeChannel[],
): Promise<YouTubeSearchResult | null> {
  if (!channels.length) return null;

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) {
    const apiResult = await searchChannelsViaApi(query, channels, apiKey);
    if (apiResult) return apiResult;
    // Fall through to RSS if API returned nothing (rare — covers quota-exceeded)
  }

  return searchChannelsViaRss(query, channels);
}

async function searchChannelsViaApi(
  query: string,
  channels: PermittedYoutubeChannel[],
  apiKey: string,
): Promise<YouTubeSearchResult | null> {
  // Fire per-channel searches in parallel; pick the first returned video that
  // matches the query reasonably well. If query is empty, use "popular" sort
  // by omitting q.
  const searches = channels.map(async (ch) => {
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
      if (!res.ok) return null;
      const data = await res.json();
      const first = data?.items?.[0];
      if (!first?.id?.videoId) return null;
      return {
        videoId: first.id.videoId,
        title: first.snippet?.title || "Video",
        channelTitle: first.snippet?.channelTitle || ch.label,
        thumbnailUrl:
          first.snippet?.thumbnails?.medium?.url ||
          first.snippet?.thumbnails?.default?.url ||
          "",
      } as YouTubeSearchResult;
    } catch {
      return null;
    }
  });
  const results = await Promise.all(searches);
  const hits = results.filter((r): r is YouTubeSearchResult => !!r);
  if (hits.length === 0) return null;
  // Prefer the result whose title best matches the query (token overlap).
  return pickBestMatch(query, hits.map((h) => ({ video: h, title: h.title })))
    ?.video ?? hits[0];
}

async function searchChannelsViaRss(
  query: string,
  channels: PermittedYoutubeChannel[],
): Promise<YouTubeSearchResult | null> {
  // Fetch all channels' feeds in parallel.
  const feeds = await Promise.all(
    channels.map(async (ch) => ({
      channel: ch,
      videos: await fetchChannelRssVideos(ch.channelId),
    })),
  );

  // Collect all candidate videos (each tagged with its channel label fallback).
  const candidates: Array<{ video: RssVideo; fallbackChannelLabel: string }> = [];
  for (const { channel, videos } of feeds) {
    for (const v of videos) {
      candidates.push({ video: v, fallbackChannelLabel: channel.label });
    }
  }
  if (candidates.length === 0) return null;

  // If no query, return the most recent upload across all channels.
  if (!query.trim()) {
    const sorted = [...candidates].sort((a, b) =>
      (b.video.published || "").localeCompare(a.video.published || ""),
    );
    const pick = sorted[0];
    return rssToResult(pick.video, pick.fallbackChannelLabel);
  }

  // Pick best title match.
  const best = pickBestMatch(
    query,
    candidates.map((c) => ({ video: c, title: c.video.title })),
  );
  if (!best) return null;
  return rssToResult(best.video.video, best.video.fallbackChannelLabel);
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
