// server/services/youtube/youtube-search.ts
// YouTube Data API v3 search with child-safety filters

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
}

/**
 * Search YouTube for a child-safe video matching the query.
 * Returns the first result or null on error / no results / missing API key.
 */
export async function searchYouTube(query: string): Promise<YouTubeSearchResult | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.warn("[YouTubeSearch] No YOUTUBE_API_KEY set, skipping search");
    return null;
  }

  try {
    const searchQuery = `${query} for kids`;
    const params = new URLSearchParams({
      part: "snippet",
      q: searchQuery,
      type: "video",
      safeSearch: "strict",
      videoEmbeddable: "true",
      maxResults: "5",
      key: apiKey,
    });

    const url = `https://www.googleapis.com/youtube/v3/search?${params}`;
    console.log(`[YouTubeSearch] Searching: "${searchQuery}"`);

    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[YouTubeSearch] API error ${response.status}:`, errorText.substring(0, 200));
      return null;
    }

    const data = await response.json();
    const items = data.items;
    if (!items || items.length === 0) {
      console.log("[YouTubeSearch] No results found");
      return null;
    }

    const first = items[0];
    const result: YouTubeSearchResult = {
      videoId: first.id?.videoId,
      title: first.snippet?.title || "Video",
      channelTitle: first.snippet?.channelTitle || "",
      thumbnailUrl: first.snippet?.thumbnails?.medium?.url || first.snippet?.thumbnails?.default?.url || "",
    };

    console.log(`[YouTubeSearch] Found: "${result.title}" (${result.videoId}) by ${result.channelTitle}`);
    return result;
  } catch (error: any) {
    console.error("[YouTubeSearch] Error:", error?.message || error);
    return null;
  }
}
