// client/src/lib/glyphRaster.ts
//
// Rasterize a glyph SENTENCE to an ImageBitmap for the Video Caption export.
//
// We can't draw a React component onto a canvas directly, so we render the
// shared `GlyphCompositor` to a static SVG string (reusing ALL its layout /
// badge / RTL / modifier logic) and turn that into an ImageBitmap via
// `createImageBitmap(svgBlob)`.
//
// The one wrinkle: an SVG loaded as an image runs in "secure static mode" and
// will NOT fetch external resources — even same-origin ones. So every
// `<image href>` must be a self-contained data URL. Emoji slots already
// rasterize themselves to data URLs inside the compositor (emojiToDataUrl);
// bundled-icon slots resolve to hashed asset URLs, which we must pre-fetch and
// inline here before serializing.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GlyphCompositor } from '@shared/glyph-compositor.tsx';
import type { ImageResolver } from '@shared/glyph-compositor';
import { defaultImageResolver } from '@/lib/glyph-images';

// Cache fetched asset URL → data URL across the whole session. A failed fetch
// (e.g. a cross-origin custom symbol) is remembered as `null` so we don't retry
// it and the slot falls back to its emoji.
const urlToDataUrl = new Map<string, string | null>();

// Cache the final ImageBitmap per (glyph, height, rtl) — a 30 fps export reuses
// the same handful of glyphs thousands of times.
const bitmapCache = new Map<string, ImageBitmap>();

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
  const start = markup.indexOf('<svg');
  const end = markup.lastIndexOf('</svg>');
  if (start === -1 || end === -1) return null;
  return markup.slice(start, end + '</svg>'.length);
}

/** Make a standalone, fixed-size SVG: add xmlns + explicit width/height (px). */
function makeStandalone(svg: string, heightPx: number): { svg: string; width: number; height: number } {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const vbW = vb ? parseFloat(vb[1]) : 1;
  const vbH = vb ? parseFloat(vb[2]) : 1;
  const width = Math.max(1, Math.round((heightPx * vbW) / vbH));
  const height = Math.max(1, Math.round(heightPx));
  // Inject namespace + intrinsic size so createImageBitmap rasterizes at the
  // size we want (the compositor's own width/height are 100% for flex layout).
  const withAttrs = svg.replace(
    /^<svg /,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `,
  );
  return { svg: withAttrs, width, height };
}

/**
 * Render a glyph to a self-contained SVG string (all images inlined as data
 * URLs). Exposed separately so the export can be tested / debugged without a
 * canvas, and so callers that want SVG (not a bitmap) can use it.
 */
export async function glyphToStandaloneSvg(
  glyph: string,
  heightPx: number,
  rtl = false,
): Promise<{ svg: string; width: number; height: number } | null> {
  // Pass 1 — collect the external (non-data) URLs this glyph needs.
  const needed = new Set<string>();
  const collectResolver: ImageResolver = (input) => {
    const u = defaultImageResolver(input);
    if (u && !u.startsWith('data:')) needed.add(u);
    return u;
  };
  renderToStaticMarkup(
    createElement(GlyphCompositor, { glyph, rtl, resolveImage: collectResolver, fillSlot: true }),
  );

  // Pre-fetch + inline them.
  await Promise.all(Array.from(needed, (u) => fetchAsDataUrl(u)));

  // Pass 2 — render for real, swapping each external URL for its data URL.
  // A URL that failed to fetch resolves to null → emoji/text fallback.
  const inlineResolver: ImageResolver = (input) => {
    const u = defaultImageResolver(input);
    if (!u) return null;
    if (u.startsWith('data:')) return u;
    return urlToDataUrl.get(u) ?? null;
  };
  const markup = renderToStaticMarkup(
    createElement(GlyphCompositor, { glyph, rtl, resolveImage: inlineResolver, fillSlot: true }),
  );

  const svg = extractSvg(markup);
  if (!svg) return null;
  return makeStandalone(svg, heightPx);
}

/**
 * Rasterize a glyph SENTENCE to an ImageBitmap of the given pixel height
 * (width follows the glyph's aspect ratio). Cached per (glyph, height, rtl).
 * Returns null if the glyph can't be rendered (empty string, no SVG, etc.).
 */
export async function rasterizeGlyph(
  glyph: string,
  heightPx: number,
  rtl = false,
): Promise<ImageBitmap | null> {
  if (!glyph || !glyph.trim()) return null;
  const key = `${glyph}|${Math.round(heightPx)}|${rtl ? 'r' : ''}`;
  const cached = bitmapCache.get(key);
  if (cached) return cached;

  const standalone = await glyphToStandaloneSvg(glyph, heightPx, rtl);
  if (!standalone) return null;

  // Rasterize via an <img> + canvas rather than createImageBitmap(svgBlob):
  // the latter throws "The source image could not be decoded" in Chrome for
  // SVGs that embed images (our inlined icons/flags). An <img> decodes SVG
  // reliably (data-URI sub-images included), and createImageBitmap(canvas) on
  // the drawn result always succeeds.
  const blob = new Blob([standalone.svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(standalone.width, standalone.height);
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const canvas = new OffscreenCanvas(standalone.width, standalone.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, standalone.width, standalone.height);
    const bitmap = await createImageBitmap(canvas);
    bitmapCache.set(key, bitmap);
    return bitmap;
  } catch (err) {
    // A single bad glyph shouldn't abort the whole export — log and skip it.
    console.warn('[glyphRaster] failed to rasterize glyph:', glyph, err);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Drop cached bitmaps (e.g. on unmount) to free GPU/CPU memory. */
export function clearGlyphRasterCache(): void {
  for (const bmp of bitmapCache.values()) bmp.close?.();
  bitmapCache.clear();
}
