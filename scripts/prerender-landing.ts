/**
 * Prerender the landing page into per-locale static HTML for SEO.
 *
 * For every supported locale, this script:
 *   1. Boots a tiny static server over dist/public
 *   2. Has puppeteer load the SPA at /?lang=xx and wait for hydration
 *   3. Captures the rendered HTML
 *   4. Injects per-locale <title>, <meta description>, OG tags, canonical,
 *      and the full <link rel="alternate" hreflang="..."> set
 *   5. Writes the result to dist/public/{locale}/index.html
 *
 * Also emits dist/public/sitemap.xml and dist/public/robots.txt.
 *
 * Runs *manually* via `npm run prerender:landing` — not part of the default
 * client build, so day-to-day dev iterations stay fast.
 *
 * Prereqs: `npm run build:client` must have run first so dist/public exists.
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { fileURLToPath } from "url";
import express from "express";
import puppeteer, { type Browser } from "puppeteer";

import { translations, SUPPORTED_LANGUAGES, type LanguageCode } from "../client/src/i18n/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist", "public");

// Public origin used for canonical/sitemap URLs. Override via PRERENDER_ORIGIN
// to match the deployed domain (e.g. https://aivota.ai).
const SITE_ORIGIN = process.env.PRERENDER_ORIGIN ?? "https://aivota.ai";

// Social-share card, committed at client/public/og-image.png so it keeps a
// stable URL — the hero screenshot the page imports gets a content hash at
// build time and so can never be named in a meta tag. Regenerate with
// `npm run og:image`.
const OG_IMAGE_PATH = "/og-image.png";

// Public, indexable pages that aren't the landing page. They're single-URL
// (no per-locale variants), so they get plain sitemap entries with no
// alternates.
const STANDALONE_PATHS = [
  "/terms-of-service",
  "/privacy-policy",
  "/cookie-policy",
  "/accessibility",
  "/ai-policy",
] as const;

function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  // Stub the API endpoints the SPA hits during initial render so the page can
  // settle into the unauthenticated landing state. Without these, ServerStatusGuard
  // blocks the entire tree on the "service unavailable" screen.
  app.get("/health", (_req, res) => res.json({ status: "healthy" }));
  app.get("/api/health", (_req, res) => res.json({ status: "healthy" }));
  app.get("/auth/user", (_req, res) => res.json({ success: false, user: null }));
  app.get("/api/auth/user", (_req, res) => res.json({ success: false, user: null }));
  // Catch-all for any other API call: return a benign 401 so React-Query treats
  // it as a normal "not signed in" rather than a network failure.
  app.use("/api", (_req, res) => res.status(401).json({ message: "unauthenticated" }));
  app.use(express.static(DIST));
  // SPA fallback so every locale path returns index.html during the snapshot pass.
  app.use((_req, res) => res.sendFile(path.join(DIST, "index.html")));
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Server bound to unexpected address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function tString(lang: LanguageCode, key: string): string {
  const segments = key.split(".");
  let node: unknown = translations[lang];
  for (const seg of segments) {
    if (node && typeof node === "object" && seg in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[seg];
    } else {
      node = undefined;
      break;
    }
  }
  if (typeof node === "string") return node;
  if (lang !== "en") return tString("en", key);
  return key;
}

function localePathSegment(code: LanguageCode): string {
  return code === "en" ? "" : `/${code}`;
}

function canonicalUrl(code: LanguageCode): string {
  return `${SITE_ORIGIN}${localePathSegment(code) || "/"}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHreflangLinks(): string {
  const links = SUPPORTED_LANGUAGES.map(
    (l) => `    <link rel="alternate" hreflang="${l.code}" href="${canonicalUrl(l.code)}" />`,
  );
  links.push(`    <link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/" />`);
  return links.join("\n");
}

/**
 * Structured data. The landing page describes two things a search engine models
 * separately — the organisation behind the product and the product itself — so
 * both are emitted and joined by `publisher`. This is what lets a result carry a
 * name and a logo instead of just a blue link.
 */
function buildJsonLd(code: LanguageCode): string {
  const description = tString(code, "landing.hero.subtitle");
  const canonical = canonicalUrl(code);
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_ORIGIN}/#organization`,
        name: "Aivota",
        url: SITE_ORIGIN,
        logo: `${SITE_ORIGIN}/favicon.png`,
        description,
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_ORIGIN}/#website`,
        url: SITE_ORIGIN,
        name: "Aivota",
        inLanguage: code,
        publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        name: "Aivota",
        applicationCategory: "HealthApplication",
        operatingSystem: "Web, Windows, iPadOS",
        url: canonical,
        inLanguage: code,
        description,
        publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      },
    ],
  };
  // A "</script>" inside any of these strings would close the block early.
  // Nothing in the translations should contain one, but escaping "<" is cheap.
  const json = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `    <script type="application/ld+json">${json}</script>`;
}

function buildSeoHead(code: LanguageCode): string {
  const title = tString(code, "landing.hero.title");
  const description = tString(code, "landing.hero.subtitle");
  const tagline = tString(code, "landing.hero.tagline");
  const ogTitle = `${tagline} — ${title}`;
  const canonical = canonicalUrl(code);
  const ogImage = `${SITE_ORIGIN}${OG_IMAGE_PATH}`;
  return [
    `    <title>${escapeHtml(title)}</title>`,
    `    <meta name="description" content="${escapeHtml(description)}" />`,
    `    <link rel="canonical" href="${canonical}" />`,
    `    <meta property="og:type" content="website" />`,
    `    <meta property="og:site_name" content="Aivota" />`,
    `    <meta property="og:title" content="${escapeHtml(ogTitle)}" />`,
    `    <meta property="og:description" content="${escapeHtml(description)}" />`,
    `    <meta property="og:url" content="${canonical}" />`,
    `    <meta property="og:locale" content="${code}" />`,
    // Absolute URL — relative og:image paths are ignored by most unfurlers.
    `    <meta property="og:image" content="${ogImage}" />`,
    `    <meta property="og:image:width" content="1200" />`,
    `    <meta property="og:image:height" content="630" />`,
    `    <meta property="og:image:alt" content="${escapeHtml(tString(code, "landing.hero.screenshotAlt"))}" />`,
    `    <meta name="twitter:card" content="summary_large_image" />`,
    `    <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />`,
    `    <meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `    <meta name="twitter:image" content="${ogImage}" />`,
    buildHreflangLinks(),
    buildJsonLd(code),
  ].join("\n");
}

/**
 * Replace the source <title>/<meta description> in the snapshot with our
 * per-locale set, and append the full SEO block. Runs on the HTML *string*
 * (not the live DOM) so we don't have to coordinate with React.
 */
function injectSeoTags(html: string, code: LanguageCode): string {
  let out = html;
  // Drop everything we're about to re-emit. The snapshot may have inherited
  // meta tags from a previously prerendered file (when one locale renders
  // through the static server's SPA fallback for /index.html).
  out = out.replace(/\s*<title>[\s\S]*?<\/title>/i, "");
  out = out.replace(/\s*<meta\s+name=["']description["'][^>]*>/i, "");
  out = out.replace(/\s*<meta\s+(?:name|property)=["'](?:og|twitter):[^"']+["'][^>]*>/gi, "");
  out = out.replace(/\s*<link\s+rel=["']canonical["'][^>]*>/gi, "");
  out = out.replace(/\s*<link\s+rel=["']alternate["'][^>]*hreflang=[^>]*>/gi, "");
  out = out.replace(
    /\s*<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
    "",
  );

  const seoHead = buildSeoHead(code);
  out = out.replace(/<\/head>/i, `\n${seoHead}\n  </head>`);
  return out;
}

async function snapshotLocale(
  browser: Browser,
  baseUrl: string,
  code: LanguageCode,
): Promise<string> {
  const page = await browser.newPage();
  // Stub backend calls regardless of the bundled API base URL. The Vite build
  // can bake VITE_API_URL=http://localhost:5000 into the bundle (the dev
  // setting), so even though our static server is on 127.0.0.1, the SPA tries
  // to call the prod-style host. Intercepting at the puppeteer level handles
  // both cases without requiring a special build.
  // The bundle's API base may be a cross-origin URL (VITE_API_URL=http://localhost:5000),
  // and apiRequest sends `credentials: include`, so the response must echo the
  // request origin (not "*") and set allow-credentials. We build CORS headers
  // per-request from the Origin header.
  const corsFor = (origin: string | undefined): Record<string, string> => ({
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const u = req.url();
    const origin = req.headers().origin;
    const headers = corsFor(origin);
    const stub = (status: number, body: unknown) => ({
      status,
      contentType: "application/json",
      headers,
      body: JSON.stringify(body),
    });
    if (req.method() === "OPTIONS" && /\/(api\/)?(health|auth\/|api\/)/.test(u)) {
      return req.respond({ status: 204, headers });
    }
    if (/\/(api\/)?health$/.test(u)) {
      return req.respond(stub(200, { status: "healthy" }));
    }
    if (/\/(api\/)?auth\/user$/.test(u)) {
      return req.respond(stub(200, { success: false, user: null }));
    }
    if (/\/api\//.test(u)) {
      return req.respond(stub(401, { message: "unauthenticated" }));
    }
    req.continue();
  });
  page.on("pageerror", (err) => console.error(`  [browser-error ${code}]`, err.message));
  // Console-error logging stays off by default — the stubbed 401s on /api fire
  // as console errors, which is just noise. Set PRERENDER_VERBOSE=1 to see them.
  if (process.env.PRERENDER_VERBOSE) {
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`  [browser-error ${code}]`, msg.text());
    });
  }
  try {
    // Cache-bust + signal the prerender state so the app can opt out of
    // anything wasteful (analytics, etc.) if it ever wants to.
    const url = `${baseUrl}${localePathSegment(code)}?prerender=1`;
    // `domcontentloaded`, not `networkidle0`: the page pulls a multi-megabyte
    // bundle plus two third-party stylesheets, so "500ms with no requests in
    // flight" is a race the slower locales lose — and a single navigation
    // timeout aborts the whole run (and, in CI, the deploy). The `.landing`
    // selector below is the real readiness signal anyway: it only appears once
    // React has replaced the splash with the rendered landing page, which is
    // exactly the DOM we are about to serialise.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Wait until React has replaced the splash with the real landing root.
    await page.waitForSelector(".landing", { timeout: 60_000 });
    const dir = SUPPORTED_LANGUAGES.find((l) => l.code === code)!.direction;
    await page.evaluate(
      ({ code, dir }) => {
        document.documentElement.setAttribute("lang", code);
        document.documentElement.setAttribute("dir", dir);
      },
      { code, dir },
    );
    const html = await page.content();
    return injectSeoTags(html, code);
  } finally {
    await page.close();
  }
}

function writeSitemap(): void {
  const today = new Date().toISOString().slice(0, 10);
  const urls = SUPPORTED_LANGUAGES.map((l) => {
    const altLinks = SUPPORTED_LANGUAGES.map(
      (alt) =>
        `    <xhtml:link rel="alternate" hreflang="${alt.code}" href="${canonicalUrl(alt.code)}" />`,
    ).join("\n");
    return [
      `  <url>`,
      `    <loc>${canonicalUrl(l.code)}</loc>`,
      `    <lastmod>${today}</lastmod>`,
      altLinks,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/" />`,
      `  </url>`,
    ].join("\n");
  }).join("\n");
  const standalone = STANDALONE_PATHS.map((p) =>
    [
      `  <url>`,
      `    <loc>${SITE_ORIGIN}${p}</loc>`,
      `    <lastmod>${today}</lastmod>`,
      `  </url>`,
    ].join("\n"),
  ).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
${standalone}
</urlset>
`;
  fs.writeFileSync(path.join(DIST, "sitemap.xml"), xml, "utf-8");
}

function writeRobots(): void {
  const robotsPath = path.join(DIST, "robots.txt");
  const sitemapLine = `Sitemap: ${SITE_ORIGIN}/sitemap.xml`;
  if (fs.existsSync(robotsPath)) {
    const existing = fs.readFileSync(robotsPath, "utf-8");
    if (existing.includes("Sitemap:")) return;
    fs.writeFileSync(robotsPath, `${existing.trimEnd()}\n${sitemapLine}\n`, "utf-8");
    return;
  }
  fs.writeFileSync(robotsPath, `User-agent: *\nAllow: /\n${sitemapLine}\n`, "utf-8");
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error(`No build at ${DIST}. Run \`npm run build:client\` first.`);
    process.exit(1);
  }

  console.log("Starting static server...");
  const server = await startStaticServer();
  console.log(`Static server: ${server.url}`);

  console.log("Launching headless browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    // Capture all snapshots first, then write to disk. If we wrote each one
    // immediately, the English snapshot would overwrite dist/public/index.html
    // and the static server's SPA fallback would serve it for every subsequent
    // locale — leaking English meta tags into every other locale's snapshot.
    const snapshots = new Map<string, { outFile: string; html: string }>();
    for (const lang of SUPPORTED_LANGUAGES) {
      const startedAt = Date.now();
      // One retry: a locale that loses a timing race would otherwise take the
      // whole run — and the deploy that calls it — down with it.
      let html: string;
      try {
        html = await snapshotLocale(browser, server.url, lang.code);
      } catch (err) {
        console.warn(`  ${lang.code} failed (${(err as Error).message}) — retrying once`);
        html = await snapshotLocale(browser, server.url, lang.code);
      }
      const outFile =
        lang.code === "en"
          ? path.join(DIST, "index.html")
          : path.join(DIST, lang.code, "index.html");
      snapshots.set(lang.code, { outFile, html });
      console.log(`  ${lang.code} captured  (${Date.now() - startedAt}ms)`);
    }

    for (const [code, { outFile, html }] of snapshots) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, html, "utf-8");
      console.log(`  ${code} → ${path.relative(ROOT, outFile)}`);
    }

    writeSitemap();
    console.log(`  sitemap.xml`);
    writeRobots();
    console.log(`  robots.txt`);
  } finally {
    await browser.close();
    await server.close();
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("Prerender failed:", err);
  process.exit(1);
});
