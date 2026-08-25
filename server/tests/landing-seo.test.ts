// Guards the landing page's per-locale endpoints.
//
// Each supported language is served as its own indexable URL (/he, /es, ...)
// carrying its own <title>, description, canonical and hreflang set, built by
// `npm run prerender:landing`. Three separate places have to agree on the list
// of those locales, and NONE of them can see the other two:
//
//   • client/src/i18n/index.ts  — SUPPORTED_LANGUAGES, the source of truth
//   • server/landing-static.ts  — the self-contained image's express routes
//   • terraform/frontend.tf     — the CloudFront function, which is what
//                                 actually answers on aivota.ai
//
// A locale added to the first and forgotten in the other two fails silently in
// the worst possible way: the prerender writes dist/public/xx/index.html, the
// deploy uploads it, and every request for /xx gets 302'd to the app subdomain
// (CloudFront) or handed the English SPA shell (express). The page exists, is
// linked from the sitemap and from the hreflang set, and never serves. So the
// lists are compared here rather than trusted to a "keep this in sync" comment.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serveStaticWithLocaleLanding } from "../landing-static.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Locale codes declared by SUPPORTED_LANGUAGES, read from the source of truth. */
function supportedLocaleCodes(): string[] {
  const src = fs.readFileSync(path.join(repoRoot, "client", "src", "i18n", "index.ts"), "utf-8");
  const block = src.match(/SUPPORTED_LANGUAGES[^=]*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error("Could not find SUPPORTED_LANGUAGES in client/src/i18n/index.ts");
  return [...block[1].matchAll(/code:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** The string-literal array assigned to `name` in a source file. */
function literalArray(source: string, name: string): string[] {
  const block = source.match(new RegExp(`${name}[^=]*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`));
  if (!block) throw new Error(`Could not find ${name}`);
  return [...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("per-locale landing endpoints", () => {
  const supported = supportedLocaleCodes();
  // English is served at "/" — it deliberately has no /en page of its own.
  const nonEnglish = supported.filter((c) => c !== "en");

  it("declares more than one language (guards the extraction above)", () => {
    expect(supported).toContain("en");
    expect(nonEnglish.length).toBeGreaterThan(1);
  });

  it("the express server serves exactly the prerendered locales", () => {
    const src = fs.readFileSync(path.join(repoRoot, "server", "landing-static.ts"), "utf-8");
    expect(literalArray(src, "PRERENDERED_LOCALES").sort()).toEqual([...nonEnglish].sort());
  });

  it("the CloudFront function routes exactly the prerendered locales", () => {
    const tf = fs.readFileSync(path.join(repoRoot, "terraform", "frontend.tf"), "utf-8");
    expect(literalArray(tf, "var locales").sort()).toEqual([...nonEnglish].sort());
  });

  it("the CloudFront function folds /en into /", () => {
    const tf = fs.readFileSync(path.join(repoRoot, "terraform", "frontend.tf"), "utf-8");
    // Two indexable URLs for the same English page is duplicate content; the
    // redirect has to be permanent so the signal consolidates on "/".
    expect(tf).toMatch(/uri === '\/en'/);
    expect(tf).toMatch(/statusCode: 301/);
  });
});

describe("serveStaticWithLocaleLanding", () => {
  let baseUrl: string;
  let server: http.Server;
  let dist: string;

  beforeAll(async () => {
    // A stand-in for dist/public: one prerendered locale, plus the SPA shell.
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "aivota-landing-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<html>root-spa</html>");
    fs.mkdirSync(path.join(dist, "he"));
    fs.writeFileSync(path.join(dist, "he", "index.html"), "<html>hebrew-landing</html>");

    const app = express();
    serveStaticWithLocaleLanding(app, dist);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server did not bind a port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("serves the prerendered HTML for a locale path", async () => {
    for (const url of [`${baseUrl}/he`, `${baseUrl}/he/`]) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("hebrew-landing");
    }
  });

  it("301s /en to the English root instead of serving it twice", async () => {
    for (const url of [`${baseUrl}/en`, `${baseUrl}/en/`]) {
      const res = await fetch(url, { redirect: "manual" });
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  it("falls through to the SPA for a locale with no prerendered file", async () => {
    // 'es' is supported but absent from this fixture — it must not 404.
    const res = await fetch(`${baseUrl}/es`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("root-spa");
  });

  it("falls through to the SPA for app routes", async () => {
    const res = await fetch(`${baseUrl}/login`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("root-spa");
  });
});

describe("social share card", () => {
  const indexHtml = fs.readFileSync(path.join(repoRoot, "client", "index.html"), "utf-8");

  it("ships a committed og-image at the size the platforms expect", () => {
    const file = path.join(repoRoot, "client", "public", "og-image.png");
    expect(fs.existsSync(file)).toBe(true);
    // PNG IHDR: width and height are the two big-endian uint32s at byte 16.
    const buf = fs.readFileSync(file);
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it("references the card by absolute URL", () => {
    // Relative og:image paths are ignored by most unfurlers, so a link posted
    // to Slack/LinkedIn/X would render with no picture at all.
    const og = indexHtml.match(/<meta property="og:image" content="([^"]+)"/);
    expect(og?.[1]).toMatch(/^https:\/\//);
    const twitter = indexHtml.match(/<meta name="twitter:image" content="([^"]+)"/);
    expect(twitter?.[1]).toBe(og?.[1]);
  });
});
