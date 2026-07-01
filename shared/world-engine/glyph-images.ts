// shared/world-engine/glyph-images.ts
//
// The MAIN-THREAD glyph→image mechanism for in-world speech bubbles, baked into
// the world-engine so every world-engine game (goal-tree player, social-world)
// shares ONE implementation. The bubble renderer (speech-bubble.ts / render3d /
// render2d) is worker-safe and draws a single PRE-COMPOSED glyph image via
// `drawImage`; this module produces that image by rendering the shared
// `GlyphCompositor` to a self-contained SVG and decoding it into an
// `HTMLImageElement` the renderer can draw.
//
// ⚠️ DOM/React-bound (renderToStaticMarkup + GlyphCompositor + Image/document) —
// MAIN THREAD ONLY. Deliberately NOT re-exported from world-engine/index.ts, so
// the engine/worker core never pulls React in. Games import it directly:
//   import { createGlyphImageSource } from "@shared/world-engine/glyph-images";
//
// The symbol→artwork resolver is INJECTED (`ImageResolver`) because each app
// bundles its own icon assets; omit it to fall back to the compositor's emoji
// rendering (which still composes head + modifiers/RTL correctly).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlyphCompositor } from "../glyph-compositor.tsx";
import type { ImageResolver } from "../glyph-compositor.js";
import type { GlyphImage } from "./speech-bubble.js";

/** Supersample height (px) the SVG rasterizes at — the bubble downsamples it. */
const RASTER_HEIGHT = 200;

const nullResolver: ImageResolver = () => null;

// asset URL → data URL, cached (an SVG loaded as an <img> can't fetch external
// hrefs, so every <image> must be inlined as a data URL). null = failed fetch.
const urlToDataUrl = new Map<string, string | null>();
// Final composed-glyph SVG data URL, cached per `glyph|rtl`.
const urlCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

async function fetchAsDataUrl(url: string): Promise<string | null> {
  if (urlToDataUrl.has(url)) return urlToDataUrl.get(url)!;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    urlToDataUrl.set(url, dataUrl);
    return dataUrl;
  } catch {
    urlToDataUrl.set(url, null);
    return null;
  }
}

/** Pull the `<svg>…</svg>` out of the compositor's wrapper-div markup. */
function extractSvg(markup: string): string | null {
  const start = markup.indexOf("<svg");
  const end = markup.lastIndexOf("</svg>");
  if (start === -1 || end === -1) return null;
  return markup.slice(start, end + "</svg>".length);
}

/** Make a standalone, fixed-size SVG: drop the compositor's flex-fill `style`,
 *  add xmlns + explicit px width/height (inline width/height override the
 *  presentation attrs, so without this `naturalWidth` decodes to 0). */
function makeStandalone(svg: string, heightPx: number): string {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const vbW = vb ? parseFloat(vb[1]!) : 1;
  const vbH = vb ? parseFloat(vb[2]!) : 1;
  const width = Math.max(1, Math.round((heightPx * vbW) / vbH));
  const height = Math.max(1, Math.round(heightPx));
  const openEnd = svg.indexOf(">");
  const openTag = svg.slice(0, openEnd).replace(/\sstyle="[^"]*"/, "");
  const rebuilt = openTag.replace(
    /^<svg/,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
  );
  return rebuilt + svg.slice(openEnd);
}

async function glyphToStandaloneSvg(glyph: string, resolveImage: ImageResolver, rtl: boolean): Promise<string | null> {
  // Pass 1 — collect the external (non-data) URLs this glyph needs.
  const needed = new Set<string>();
  const collect: ImageResolver = (input) => {
    const u = resolveImage(input);
    if (u && !u.startsWith("data:")) needed.add(u);
    return u;
  };
  renderToStaticMarkup(createElement(GlyphCompositor, { glyph, rtl, resolveImage: collect, fillSlot: true }));
  await Promise.all(Array.from(needed, (u) => fetchAsDataUrl(u)));

  // Pass 2 — render for real, swapping each external URL for its inlined data URL.
  const inline: ImageResolver = (input) => {
    const u = resolveImage(input);
    if (!u) return null;
    if (u.startsWith("data:")) return u;
    return urlToDataUrl.get(u) ?? null;
  };
  const markup = renderToStaticMarkup(createElement(GlyphCompositor, { glyph, rtl, resolveImage: inline, fillSlot: true }));
  const svg = extractSvg(markup);
  return svg ? makeStandalone(svg, RASTER_HEIGHT) : null;
}

/**
 * Rasterize a whole composed glyph to a self-contained SVG data URL (the bubble
 * draws it at its natural aspect). Cached per `glyph|rtl`. `resolveImage` maps
 * each symbol to its artwork URL (app-specific bundled assets); omit it to fall
 * back to the compositor's emoji rendering. Returns null for an empty glyph.
 */
export async function rasterizeGlyphToUrl(
  glyph: string,
  opts: { resolveImage?: ImageResolver; rtl?: boolean } = {},
): Promise<string | null> {
  if (!glyph || !glyph.trim()) return null;
  const resolveImage = opts.resolveImage ?? nullResolver;
  const rtl = opts.rtl ?? false;
  const key = `${glyph}|${rtl ? "r" : ""}`;
  if (urlCache.has(key)) return urlCache.get(key)!;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const svg = await glyphToStandaloneSvg(glyph, resolveImage, rtl);
        const url = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
        urlCache.set(key, url);
        return url;
      } catch {
        urlCache.set(key, null);
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
  }
  return p;
}

/**
 * A `glyphFor` source for the world view: given a composed glyph string, returns
 * the decoded image(s) the bubble draws (`[img]` once ready, `null` while it
 * rasterizes/decodes — the bubble shows text-only until then). Plug into
 * `createWorld3DView({ ..., glyphFor })`.
 */
export interface GlyphImageSource {
  glyphFor: (glyph: string) => GlyphImage[] | null;
  clear: () => void;
}

export function createGlyphImageSource(opts: { resolveImage?: ImageResolver; rtl?: () => boolean } = {}): GlyphImageSource {
  const resolveImage = opts.resolveImage ?? nullResolver;
  const rtlFn = opts.rtl ?? (() => typeof document !== "undefined" && document.documentElement.dir === "rtl");
  // null = pending or permanently failed; an HTMLImageElement = ready.
  const cache = new Map<string, HTMLImageElement | null>();
  const started = new Set<string>();

  const glyphFor = (glyph: string): GlyphImage[] | null => {
    if (!glyph || !glyph.trim()) return null;
    const key = `${glyph}|${rtlFn() ? "r" : ""}`;
    const have = cache.get(key);
    if (have) return [have];
    if (started.has(key)) return null; // pending or failed
    started.add(key);
    rasterizeGlyphToUrl(glyph, { resolveImage, rtl: rtlFn() })
      .then((url) => {
        if (!url) return;
        const img = new Image();
        img.onload = () => cache.set(key, img);
        img.onerror = () => cache.set(key, null);
        img.src = url;
      })
      .catch(() => {});
    return null;
  };

  return { glyphFor, clear: () => { cache.clear(); started.clear(); } };
}
