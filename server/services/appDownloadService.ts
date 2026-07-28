// server/services/appDownloadService.ts
//
// Resolves what the AAC app's release feeds currently offer, so the clinician
// client can show a Downloads panel that never goes stale.
//
// Why the server does this instead of the client linking straight to the CDN:
// the published payloads are VERSIONED ("Aivota AAC Setup 1.0.16.exe"), so the
// only version-independent object is the manifest. Reading the manifest in the
// browser would need CORS on the CloudFront distribution (not configured, and
// not something we want to open up); doing it here also lets us surface the
// version/size in the UI and keeps the feed URL a server-side concern.

import type {
  AppDownloadInfo,
  AppDownloadPlatform,
  AppDownloadsResponse,
} from "@shared/app-downloads";

/** Base of the update feed — same distribution the desktop auto-updater polls.
 *  Overridable so staging/dev can point at their own prefix. */
const FEED_BASE = (process.env.AAC_DOWNLOAD_FEED_BASE ?? "https://updates.aivota.ai/aac")
  .replace(/\/+$/, "");

const WINDOWS_MANIFEST_URL = `${FEED_BASE}/win/latest.yml`;
const IOS_MANIFEST_URL = `${FEED_BASE}/ios/latest.json`;

/** How long a resolved manifest is trusted. Releases are rare; a few minutes of
 *  staleness is invisible to a clinician and spares the CDN a request per page
 *  view. Failures are cached far more briefly so an outage self-heals. */
const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;

/** Don't let a hung CDN hold an API request open. */
const FETCH_TIMEOUT_MS = 8_000;

/** What a manifest tells us about one build, before URLs are attached. */
export interface ManifestBuild {
  version: string;
  fileName: string;
  sizeBytes: number | null;
  releaseDate: string | null;
}

// ─── Manifest parsing ───────────────────────────────────────────────────────

/**
 * Read an electron-builder `latest.yml`.
 *
 * Deliberately NOT a general YAML parser — the repo has no YAML dependency and
 * this manifest's shape is fixed by electron-builder:
 *
 *   version: 1.0.16
 *   files:
 *     - url: Aivota AAC Setup 1.0.16.exe
 *       sha512: ...
 *       size: 209333599
 *   path: Aivota AAC Setup 1.0.16.exe
 *   releaseDate: '2026-07-26T17:50:20.433Z'
 *
 * `path` is the authoritative payload name (scripts/publish-aac-release.mjs
 * uploads exactly the file `path` names), so we key off it and only consult
 * `files[]` for the size.
 */
export function parseWindowsManifest(text: string): ManifestBuild | null {
  const version = text.match(/^version:\s*(\S+)\s*$/m)?.[1];
  const path = text.match(/^path:\s*(.+?)\s*$/m)?.[1];
  if (!version || !path) return null;

  const fileName = stripQuotes(path);
  // The `size:` belonging to this payload — the files[] entry whose url matches.
  const sizeMatch = text.match(
    new RegExp(`^\\s*-\\s*url:\\s*${escapeRegExp(fileName)}\\s*$[\\s\\S]*?^\\s*size:\\s*(\\d+)\\s*$`, "m"),
  );
  const releaseDate = text.match(/^releaseDate:\s*(.+?)\s*$/m)?.[1];

  return {
    version: stripQuotes(version),
    fileName,
    sizeBytes: sizeMatch ? Number(sizeMatch[1]) : null,
    releaseDate: releaseDate ? stripQuotes(releaseDate) : null,
  };
}

/**
 * Read the iOS `latest.json` written by scripts/publish-aac-ios.mjs:
 *
 *   { "version": "1.0.16", "build": "142", "path": "aivota-aac-ipad-unsigned-v1.0.16-build142.ipa",
 *     "size": 48123904, "releaseDate": "2026-07-26T17:50:20.433Z", "signed": false }
 */
export function parseIosManifest(text: string): ManifestBuild | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const version = typeof m.version === "string" ? m.version : null;
  const fileName = typeof m.path === "string" ? m.path : null;
  if (!version || !fileName) return null;

  return {
    version,
    fileName,
    sizeBytes: typeof m.size === "number" && Number.isFinite(m.size) ? m.size : null,
    releaseDate: typeof m.releaseDate === "string" ? m.releaseDate : null,
  };
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Feed resolution ────────────────────────────────────────────────────────

/** Where a platform's manifest lives and how to read it. */
const FEEDS: Record<
  AppDownloadPlatform,
  { manifestUrl: string; dir: string; parse: (text: string) => ManifestBuild | null }
> = {
  windows: { manifestUrl: WINDOWS_MANIFEST_URL, dir: `${FEED_BASE}/win/`, parse: parseWindowsManifest },
  ios: { manifestUrl: IOS_MANIFEST_URL, dir: `${FEED_BASE}/ios/`, parse: parseIosManifest },
};

interface CacheEntry {
  build: ManifestBuild | null;
  expiresAt: number;
}

const cache = new Map<AppDownloadPlatform, CacheEntry>();

/** Drop the memo — for tests, and for an admin-triggered refresh later. */
export function clearAppDownloadCache(): void {
  cache.clear();
}

async function fetchManifest(platform: AppDownloadPlatform): Promise<ManifestBuild | null> {
  const cached = cache.get(platform);
  if (cached && cached.expiresAt > Date.now()) return cached.build;

  const feed = FEEDS[platform];
  let build: ManifestBuild | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(feed.manifestUrl, {
        signal: controller.signal,
        // The manifest itself is served with caching disabled at the edge; ask
        // undici not to reuse anything either.
        headers: { "cache-control": "no-cache" },
      });
      if (res.ok) {
        build = feed.parse(await res.text());
      } else if (res.status !== 403 && res.status !== 404) {
        // 403/404 just means "nothing published for this platform yet" — the
        // bucket returns 403 for a missing key behind OAC. Anything else is a
        // real fault worth seeing in the logs.
        console.warn(`[app-downloads] ${platform} manifest returned ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn(`[app-downloads] ${platform} manifest fetch failed:`, (err as Error)?.message);
  }

  cache.set(platform, {
    build,
    expiresAt: Date.now() + (build ? OK_TTL_MS : FAIL_TTL_MS),
  });
  return build;
}

/** The absolute CDN URL of a platform's current payload, or null. */
function cdnUrl(platform: AppDownloadPlatform, build: ManifestBuild): string {
  return FEEDS[platform].dir + encodeURIComponent(build.fileName);
}

/** The absolute CDN URL of a platform's current payload, or null. */
export async function resolveDownloadTarget(platform: AppDownloadPlatform): Promise<string | null> {
  const build = await fetchManifest(platform);
  return build ? cdnUrl(platform, build) : null;
}

function toInfo(platform: AppDownloadPlatform, build: ManifestBuild | null): AppDownloadInfo {
  return {
    platform,
    available: !!build,
    version: build?.version ?? null,
    sizeBytes: build?.sizeBytes ?? null,
    releaseDate: build?.releaseDate ?? null,
    fileName: build?.fileName ?? null,
    // Link the button straight at the CDN: the installer is ~200 MB and the
    // objects are public, so there's no reason to route the bytes (or an
    // authenticated redirect) through the app server.
    downloadUrl: build ? cdnUrl(platform, build) : null,
    // Stable regardless of version — the server resolves the manifest for you.
    stableUrl: `/api/app-downloads/${platform}`,
  };
}

/** Both platforms' current state, for the Downloads panel. */
export async function getAppDownloads(): Promise<AppDownloadsResponse> {
  const [windows, ios] = await Promise.all([fetchManifest("windows"), fetchManifest("ios")]);
  return {
    windows: toInfo("windows", windows),
    ios: toInfo("ios", ios),
  };
}
