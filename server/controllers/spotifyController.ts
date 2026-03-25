// server/controllers/spotifyController.ts
// Handles Spotify OAuth flow for per-student Spotify account linking

import type { Request, Response } from "express";
import { aacSettingsRepository } from "../repositories";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SCOPES = "streaming user-read-email user-read-private";

function getClientCredentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  return { clientId, clientSecret };
}

function getRedirectUri() {
  const baseUrl = process.env.APP_URL || process.env.CLIENT_URL || "http://localhost:5000";
  return `${baseUrl}/api/aac/spotify/callback`;
}

class SpotifyController {
  /**
   * GET /api/aac/spotify/auth-url?studentId=X
   * Returns the Spotify authorization URL for the OAuth flow.
   */
  async getAuthUrl(req: Request, res: Response) {
    try {
      const studentId = req.query.studentId as string;
      if (!studentId) {
        return res.status(400).json({ error: "studentId required" });
      }

      const { clientId } = getClientCredentials();
      if (!clientId) {
        return res.status(500).json({ error: "Spotify not configured" });
      }

      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: getRedirectUri(),
        scope: SPOTIFY_SCOPES,
        state: studentId,
        show_dialog: "true",
      });

      res.json({ url: `${SPOTIFY_AUTH_URL}?${params}` });
    } catch (error: any) {
      console.error("[Spotify] Auth URL error:", error);
      res.status(500).json({ error: "Failed to generate auth URL" });
    }
  }

  /**
   * GET /api/aac/spotify/callback?code=X&state=studentId
   * Handles the OAuth callback, exchanges code for tokens, stores refresh token.
   */
  async callback(req: Request, res: Response) {
    try {
      const { code, state: studentId, error: authError } = req.query;

      if (authError || !code || !studentId) {
        return res.send(this.closePopupHtml("Spotify connection cancelled."));
      }

      const { clientId, clientSecret } = getClientCredentials();
      if (!clientId || !clientSecret) {
        return res.send(this.closePopupHtml("Spotify not configured on server."));
      }

      // Exchange code for tokens
      const tokenResponse = await fetch(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: getRedirectUri(),
        }),
      });

      if (!tokenResponse.ok) {
        const text = await tokenResponse.text().catch(() => "");
        console.error("[Spotify] Token exchange failed:", text.substring(0, 200));
        return res.send(this.closePopupHtml("Failed to connect Spotify account."));
      }

      const tokens = await tokenResponse.json();
      const refreshToken = tokens.refresh_token;
      const accessToken = tokens.access_token;

      // Fetch user profile for display email
      let accountEmail = "";
      try {
        const profileRes = await fetch("https://api.spotify.com/v1/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (profileRes.ok) {
          const profile = await profileRes.json();
          accountEmail = profile.email || profile.display_name || "";
        }
      } catch { /* ignore */ }

      // Update appConfig with connection info
      const settings = await aacSettingsRepository.getByStudentId(studentId as string);
      const currentAppConfig = (settings?.appConfig as Record<string, any>) || {};
      const updatedAppConfig = {
        ...currentAppConfig,
        spotify: {
          ...currentAppConfig.spotify,
          enabled: true,
          connected: true,
          refreshToken,
          accountEmail,
        },
      };

      await aacSettingsRepository.upsert(studentId as string, { appConfig: updatedAppConfig });

      res.send(this.closePopupHtml("Spotify connected successfully! You can close this window."));
    } catch (error: any) {
      console.error("[Spotify] Callback error:", error);
      res.send(this.closePopupHtml("An error occurred connecting Spotify."));
    }
  }

  /**
   * GET /api/aac/spotify/token?studentId=X
   * Returns a fresh access token for the Web Playback SDK.
   */
  async getToken(req: Request, res: Response) {
    try {
      const studentId = req.query.studentId as string;
      if (!studentId) {
        return res.status(400).json({ error: "studentId required" });
      }

      const settings = await aacSettingsRepository.getByStudentId(studentId);
      const appConfig = (settings?.appConfig as Record<string, any>) || {};
      const refreshToken = appConfig.spotify?.refreshToken;

      if (!refreshToken) {
        return res.status(404).json({ error: "No Spotify account connected" });
      }

      const { clientId, clientSecret } = getClientCredentials();
      if (!clientId || !clientSecret) {
        return res.status(500).json({ error: "Spotify not configured" });
      }

      const tokenResponse = await fetch(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!tokenResponse.ok) {
        console.error("[Spotify] Token refresh failed");
        return res.status(401).json({ error: "Failed to refresh Spotify token" });
      }

      const data = await tokenResponse.json();

      // If Spotify issued a new refresh token, store it
      if (data.refresh_token && data.refresh_token !== refreshToken) {
        const updatedAppConfig = {
          ...appConfig,
          spotify: { ...appConfig.spotify, refreshToken: data.refresh_token },
        };
        await aacSettingsRepository.upsert(studentId, { appConfig: updatedAppConfig });
      }

      res.json({ accessToken: data.access_token, expiresIn: data.expires_in });
    } catch (error: any) {
      console.error("[Spotify] Token refresh error:", error);
      res.status(500).json({ error: "Failed to get access token" });
    }
  }

  /**
   * DELETE /api/aac/spotify/disconnect?studentId=X
   * Removes Spotify connection from the student's settings.
   */
  async disconnect(req: Request, res: Response) {
    try {
      const studentId = req.query.studentId as string;
      if (!studentId) {
        return res.status(400).json({ error: "studentId required" });
      }

      const settings = await aacSettingsRepository.getByStudentId(studentId);
      const currentAppConfig = (settings?.appConfig as Record<string, any>) || {};
      const updatedAppConfig = {
        ...currentAppConfig,
        spotify: {
          ...currentAppConfig.spotify,
          connected: false,
          refreshToken: undefined,
          accountEmail: undefined,
        },
      };

      await aacSettingsRepository.upsert(studentId, { appConfig: updatedAppConfig });
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Spotify] Disconnect error:", error);
      res.status(500).json({ error: "Failed to disconnect" });
    }
  }

  /** Generate HTML that closes the popup window and notifies the opener */
  private closePopupHtml(message: string): string {
    return `<!DOCTYPE html>
<html><head><title>Spotify</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff">
  <div style="text-align:center">
    <p style="font-size:1.2em">${message}</p>
    <p style="color:#aaa;font-size:0.9em">This window will close automatically.</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'spotify-connected' }, '*');
    }
    setTimeout(() => window.close(), 2000);
  </script>
</body></html>`;
  }
}

export const spotifyController = new SpotifyController();
