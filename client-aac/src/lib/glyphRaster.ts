// client-aac/src/lib/glyphRaster.ts
//
// Rasterize a whole composed glyph to a self-contained image for the in-world
// speech bubble. The bubble draws onto a canvas (the 2D/3D world renderer), so it
// can't mount a React component — instead we render the shared `GlyphCompositor`
// to a static SVG string (reusing ALL of its layout / slot-order / RTL flip /
// modifier / emoji logic) and hand the bubble a single image of the FULL glyph,
// drawn at its natural aspect ratio. This is the clinician `client/src/lib/
// glyphRaster.ts` pattern, wired to the AAC client's image resolver.
//
// The one wrinkle: an SVG loaded as an image runs in "secure static mode" and
// will NOT fetch external resources — even same-origin ones. So every
// `<image href>` must be a self-contained data URL. Emoji slots already
// rasterize themselves to data URLs inside the compositor (emojiToDataUrl);
// bundled-icon slots resolve to hashed asset URLs, which we pre-fetch and inline
// here before serializing.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlyphCompositor } from "@shared/glyph-compositor.tsx";
import type { ImageResolver } from "@shared/glyph-compositor";
import { defaultImageResolver } from "@/lib/glyph-images";

// Supersample height (px) the SVG rasterizes at — the bubble downsamples it, so
// rendering well above the on-screen size keeps symbols crisp in the 3D texture.
const RASTER_HEIGHT = 200;

// asset URL → data URL, cached for the session. A failed fetch (e.g. a
// cross-origin custom symbol) is remembered as `null` so we don't retry it and
// the slot falls back to its emoji.
const urlToDataUrl = new Map<string, string | null>();

// Final composed-glyph image data URL, cached per `glyph|rtl`. The same handful
// of glyphs recur constantly (button presses, NPC lines), so this stays tiny.
const bubbleUrlCache = new Map<string, string | null>();
const bubbleInflight = new Map<string, Promise<string | null>>();

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
 *  add xmlns + explicit width/height (px). The compositor renders the root <svg>
 *  with `style="width:100%;height:100%"` for in-page flex layout — but inline CSS
 *  width/height OVERRIDE the presentation attributes, so a standalone <img> of it
 *  has NO intrinsic size and `naturalWidth` comes back 0. Stripping that style is
 *  what lets the attributes below give the image a real decoded size. */
function makeStandalone(svg: string, heightPx: number): { svg: string; width: number; height: number } {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const vbW = vb ? parseFloat(vb[1]) : 1;
  const vbH = vb ? parseFloat(vb[2]) : 1;
  const width = Math.max(1, Math.round((heightPx * vbW) / vbH));
  const height = Math.max(1, Math.round(heightPx));
  // Rewrite the opening <svg …> tag: remove its inline style, then prepend the
  // namespace + intrinsic px size.
  const openEnd = svg.indexOf(">");
  const openTag = svg.slice(0, openEnd).replace(/\sstyle="[^"]*"/, "");
  const rebuilt = openTag.replace(
    /^<svg/,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
  );
  return { svg: rebuilt + svg.slice(openEnd), width, height };
}

/**
 * Render a glyph to a self-contained SVG string (all images inlined as data
 * URLs), reusing the full `GlyphCompositor`. `rtl` reverses slot order and flips
 * symbol artwork exactly as the on-button render does.
 */
async function glyphToStandaloneSvg(glyph: string, rtl: boolean): Promise<{ svg: string } | null> {
  // Pass 1 — collect the external (non-data) URLs this glyph needs.
  const needed = new Set<string>();
  const collectResolver: ImageResolver = (input) => {
    const u = defaultImageResolver(input);
    if (u && !u.startsWith("data:")) needed.add(u);
    return u;
  };
  renderToStaticMarkup(
    createElement(GlyphCompositor, { glyph, rtl, resolveImage: collectResolver, fillSlot: true }),
  );

  // Pre-fetch + inline them.
  await Promise.all(Array.from(needed, (u) => fetchAsDataUrl(u)));

  // Pass 2 — render for real, swapping each external URL for its data URL. A URL
  // that failed to fetch resolves to null → the slot's emoji/text fallback.
  const inlineResolver: ImageResolver = (input) => {
    const u = defaultImageResolver(input);
    if (!u) return null;
    if (u.startsWith("data:")) return u;
    return urlToDataUrl.get(u) ?? null;
  };
  const markup = renderToStaticMarkup(
    createElement(GlyphCompositor, { glyph, rtl, resolveImage: inlineResolver, fillSlot: true }),
  );

  const svg = extractSvg(markup);
  if (!svg) return null;
  const standalone = makeStandalone(svg, RASTER_HEIGHT);
  return { svg: standalone.svg };
}

/**
 * Resolve a composed glyph string to a single self-contained image (SVG data
 * URL) of the WHOLE glyph — the bubble draws it at its natural aspect ratio.
 * Cached per `glyph|rtl`; RTL is taken from the document direction so it matches
 * the student's UI language. Returns null for an empty/unrenderable glyph (the
 * bubble then shows text only).
 */
export async function glyphBubbleImageUrl(glyph: string): Promise<string | null> {
  if (!glyph || !glyph.trim()) return null;
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const key = `${glyph}|${rtl ? "r" : ""}`;
  if (bubbleUrlCache.has(key)) return bubbleUrlCache.get(key)!;
  let p = bubbleInflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const out = await glyphToStandaloneSvg(glyph, rtl);
        const url = out ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out.svg)}` : null;
        bubbleUrlCache.set(key, url);
        return url;
      } catch {
        bubbleUrlCache.set(key, null);
        return null;
      } finally {
        bubbleInflight.delete(key);
      }
    })();
    bubbleInflight.set(key, p);
  }
  return p;
}
