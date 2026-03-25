// server/services/spotify/spotify-search.ts
// Spotify Web API search with client credentials flow

export interface SpotifySearchResult {
  trackId: string;
  trackUri: string;
  title: string;
  artist: string;
  albumArt: string;
  durationMs: number;
}

// Cached access token
let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Get an access token using the Client Credentials flow.
 */
async function getAccessToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn("[SpotifySearch] No SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET set, skipping");
    return null;
  }

  try {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[SpotifySearch] Token error ${response.status}:`, errorText.substring(0, 200));
      return null;
    }

    const data = await response.json();
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return cachedToken.token;
  } catch (error: any) {
    console.error("[SpotifySearch] Token fetch error:", error?.message || error);
    return null;
  }
}

/**
 * Search Spotify for a child-friendly track matching the query.
 * Returns the first result or null on error / no results / missing credentials.
 */
export async function searchSpotify(query: string): Promise<SpotifySearchResult | null> {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const searchQuery = `${query} kids`;
    const params = new URLSearchParams({
      q: searchQuery,
      type: "track",
      limit: "5",
    });

    const url = `https://api.spotify.com/v1/search?${params}`;
    console.log(`[SpotifySearch] Searching: "${searchQuery}"`);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[SpotifySearch] API error ${response.status}:`, errorText.substring(0, 200));
      return null;
    }

    const data = await response.json();
    const tracks = data.tracks?.items;
    if (!tracks || tracks.length === 0) {
      console.log("[SpotifySearch] No results found");
      return null;
    }

    const track = tracks[0];
    const result: SpotifySearchResult = {
      trackId: track.id,
      trackUri: track.uri,
      title: track.name || "Track",
      artist: track.artists?.map((a: any) => a.name).join(", ") || "",
      albumArt: track.album?.images?.[0]?.url || "",
      durationMs: track.duration_ms || 0,
    };

    console.log(`[SpotifySearch] Found: "${result.title}" by ${result.artist} (${result.trackId})`);
    return result;
  } catch (error: any) {
    console.error("[SpotifySearch] Error:", error?.message || error);
    return null;
  }
}
