// server/controllers/spotifyController.ts
// Handles Spotify OAuth flow for per-student Spotify account linking
//
// SECRETS: the refresh token lives ENCRYPTED in the `external_connections` vault
// (server/services/externalConnectionsService.ts), never in
// `aac_settings.app_config` — that jsonb blob is client-writable through the
// settings save path. Only non-secret display state (enabled / connected /
// accountEmail) still goes to appConfig, because the clinician panel reads it
// from there.
//
// Tokens stored under the old plaintext scheme are LAZY-migrated: getToken()
// falls back to `appConfig.spotify.refreshToken`, encrypts it into the vault, and
// strips ONLY that key back out of the blob. A SQL backfill is impossible (the
// ciphertext only exists app-side), so the code path is the migration.

import type { Request, Response } from "express";
import { aacSettingsRepository } from "../repositories";
import {
  chooseTokenSource,
  deleteConnection,
  getDecryptedTokens,
  stripLegacySecret,
  upsertConnection,
} from "../services/externalConnectionsService";

/** appConfig section + key that held the plaintext refresh token before the vault. */
const LEGACY_APP_KEY = "spotify";
const LEGACY_SECRET_KEY = "refreshToken";

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

      // No refresh token means nothing to store — never mark the panel connected
      // with no usable credential behind it.
      if (!refreshToken) {
        console.error("[Spotify] Token exchange returned no refresh token");
        return res.send(this.closePopupHtml("Failed to connect Spotify account."));
      }

      // The refresh token is a secret: it goes to the encrypted vault, never to
      // appConfig. Written first, so a failure here never leaves the panel
      // claiming "connected" with no usable credential.
      await upsertConnection(studentId as string, "spotify", {
        refreshToken,
        providerAccountId: accountEmail || null,
        metadata: { accountEmail },
      });

      // Update appConfig with NON-SECRET connection info only (what the clinician
      // panel displays), and drop any plaintext token left by the old scheme.
      const settings = await aacSettingsRepository.getByStudentId(studentId as string);
      const stripped = stripLegacySecret(
        settings?.appConfig as Record<string, any>,
        LEGACY_APP_KEY,
        LEGACY_SECRET_KEY,
      );
      const updatedAppConfig = {
        ...stripped.appConfig,
        spotify: {
          ...stripped.appConfig.spotify,
          enabled: true,
          connected: true,
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

      // Vault first; the plaintext appConfig token is a legacy fallback only.
      const vault = await getDecryptedTokens(studentId, "spotify");
      const settings = await aacSettingsRepository.getByStudentId(studentId);
      const appConfig = (settings?.appConfig as Record<string, any>) || {};
      const decision = chooseTokenSource(vault?.refreshToken, appConfig.spotify?.refreshToken);
      const refreshToken = decision.token;

      if (!refreshToken) {
        return res.status(404).json({ error: "No Spotify account connected" });
      }

      // LAZY MIGRATION: encrypt the legacy plaintext token into the vault when
      // that is where it came from, then strip it out of the blob either way —
      // ONLY the refreshToken key; every other appConfig key survives. Stripping
      // unconditionally makes the migration self-healing if a previous attempt
      // wrote the vault but failed before clearing the blob.
      if (decision.needsMigration) {
        await upsertConnection(studentId, "spotify", { refreshToken });
      }
      const stripped = stripLegacySecret(appConfig, LEGACY_APP_KEY, LEGACY_SECRET_KEY);
      if (stripped.changed) {
        await aacSettingsRepository.upsert(studentId, { appConfig: stripped.appConfig });
        console.log(
          `[Spotify] Plaintext refresh token moved out of appConfig for student ${studentId} (source=${decision.source})`,
        );
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

      // If Spotify issued a new refresh token, store it — vault only.
      if (data.refresh_token && data.refresh_token !== refreshToken) {
        await upsertConnection(studentId, "spotify", { refreshToken: data.refresh_token });
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

      // Drop the vault row, then clear the display state and any plaintext
      // remnant a pre-vault connection left behind.
      await deleteConnection(studentId, "spotify");

      const settings = await aacSettingsRepository.getByStudentId(studentId);
      const stripped = stripLegacySecret(
        settings?.appConfig as Record<string, any>,
        LEGACY_APP_KEY,
        LEGACY_SECRET_KEY,
      );
      const updatedAppConfig = {
        ...stripped.appConfig,
        spotify: {
          ...stripped.appConfig.spotify,
          connected: false,
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
