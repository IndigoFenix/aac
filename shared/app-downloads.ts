// shared/app-downloads.ts
//
// The contract behind the clinician client's Downloads panel: what the AAC
// app's release feeds say is currently available for each platform.
//
// Both platforms publish to the SAME CloudFront-fronted bucket the desktop
// auto-updater already polls (see terraform/aac-updates.tf):
//
//   https://updates.aivota.ai/aac/win/latest.yml   ← electron-builder writes it
//   https://updates.aivota.ai/aac/ios/latest.json  ← scripts/publish-aac-ios.mjs
//
// Neither manifest has a stable "latest" filename for the payload itself — the
// installer/.ipa is versioned — so the server resolves the manifest and hands
// the client a stable redirect URL instead of a hardcoded link.

/** The platforms the Downloads panel offers. */
export type AppDownloadPlatform = "windows" | "ios";

/** One platform's currently-published build, or why there isn't one. */
export interface AppDownloadInfo {
  platform: AppDownloadPlatform;
  /** False when the feed has no build yet (or is unreachable) — the UI then
   *  shows the install instructions without a download button. */
  available: boolean;
  /** Marketing version, e.g. "1.0.16". Null when unavailable. */
  version: string | null;
  /** Payload size in bytes, when the manifest reports one. */
  sizeBytes: number | null;
  /** ISO-8601 publish timestamp, when the manifest reports one. */
  releaseDate: string | null;
  /** The manifest's payload filename (versioned), for display. */
  fileName: string | null;
  /** Direct, public CDN URL of the payload. What the download button points at
   *  — the CDN serves the bytes, and no auth/CORS is involved. Null when
   *  nothing is published. */
  downloadUrl: string | null;
  /** Stable, version-independent alternative: the API 302s it to `downloadUrl`.
   *  Safe to paste into an email or a bookmark, since it survives releases. */
  stableUrl: string;
}

/** GET /api/app-downloads */
export interface AppDownloadsResponse {
  windows: AppDownloadInfo;
  ios: AppDownloadInfo;
}
