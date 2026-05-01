import express, { type Express } from "express";
import fs from "fs";
import path from "path";

// Locale codes that have prerendered landing HTML at dist/public/{code}/index.html.
// Mirror of client/src/i18n/index.ts SUPPORTED_LANGUAGES; kept inline so the server
// build (esbuild bundle) doesn't need to reach into the client tree.
const PRERENDERED_LOCALES = new Set([
  "he",
  "es",
  "pt",
  "fr",
  "ru",
  "de",
  "ar",
  "zh",
  "yue",
  "ko",
]);

/**
 * Serve the built SPA from `distPath`, with two SEO-specific behaviors:
 *
 *  - GET /{locale} or /{locale}/ serves the prerendered landing HTML for that
 *    locale (when it exists). Everything else falls through to the SPA.
 *  - Static assets (JS/CSS/images, sitemap.xml, robots.txt) are served as
 *    normal files via express.static.
 *  - All other paths fall through to the SPA's root index.html for client-side
 *    routing.
 */
export function serveStaticWithLocaleLanding(app: Express, distPath: string): void {
  app.get(/^\/([a-z]{2,3})\/?$/, (req, res, next) => {
    const code = req.params[0];
    if (!PRERENDERED_LOCALES.has(code)) return next();
    const file = path.join(distPath, code, "index.html");
    if (!fs.existsSync(file)) return next();
    res.sendFile(file);
  });

  app.use(express.static(distPath));

  app.use("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}
