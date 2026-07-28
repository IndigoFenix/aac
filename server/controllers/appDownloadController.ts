// server/controllers/appDownloadController.ts
// Serves the clinician client's Downloads panel: what AAC app builds are
// currently published, and a stable URL that redirects to each one.

import type { Request, Response } from "express";
import type { AppDownloadPlatform } from "@shared/app-downloads";
import { getAppDownloads, resolveDownloadTarget } from "../services/appDownloadService";

const PLATFORMS: readonly AppDownloadPlatform[] = ["windows", "ios"];

function asPlatform(value: unknown): AppDownloadPlatform | null {
  return PLATFORMS.includes(value as AppDownloadPlatform) ? (value as AppDownloadPlatform) : null;
}

export class AppDownloadController {
  /** GET /api/app-downloads — version/size/availability for every platform. */
  async list(_req: Request, res: Response): Promise<void> {
    try {
      const downloads = await getAppDownloads();
      // Short client cache: the panel is re-opened often, releases are rare.
      res.set("Cache-Control", "private, max-age=60");
      res.json(downloads);
    } catch (error) {
      console.error("[app-downloads] failed to list downloads:", error);
      res.status(500).json({ message: "Failed to load app downloads" });
    }
  }

  /**
   * GET /api/app-downloads/:platform — 302 to the versioned CDN object.
   *
   * A redirect rather than a proxy: the installer is ~200 MB, and CloudFront
   * should serve those bytes, not the app server (which on Lambda would be
   * both slow and expensive).
   */
  async download(req: Request, res: Response): Promise<void> {
    const platform = asPlatform(req.params.platform);
    if (!platform) {
      res.status(400).json({ message: "Unknown platform" });
      return;
    }

    try {
      const target = await resolveDownloadTarget(platform);
      if (!target) {
        res.status(404).json({ message: "No build published for this platform yet" });
        return;
      }
      // 302, not 301 — the target changes with every release.
      res.redirect(302, target);
    } catch (error) {
      console.error(`[app-downloads] failed to resolve ${platform} download:`, error);
      res.status(500).json({ message: "Failed to resolve download" });
    }
  }
}

export const appDownloadController = new AppDownloadController();
