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
import { buildCausalSvg, splitCausalGlyph, svgDims } from "./causal-glyph.js";
import {
  canBankSlotAsset,
  glyphRasterKey,
  readGlyphRaster,
  readSlotAsset,
  slotAssetKey,
  writeGlyphRaster,
  writeSlotAsset,
} from "./glyph-raster-cache.js";

/** Supersample height (px) the SVG rasterizes at — the bubble downsamples it. */
const RASTER_HEIGHT = 200;

const nullResolver: ImageResolver = () => null;

/**
 * Longest edge (px) a slot's artwork is INLINED at.
 *
 * THIS IS THE HOT NUMBER. The composed glyph rasters at RASTER_HEIGHT, and one
 * slot is at most that tall, so the bundled 500x500 source art carries ~6x more
 * pixels than can ever reach the screen — and it pays for them on EVERY bubble,
 * because a fresh SVG (with every slot base64'd into it) is built and decoded per
 * SENTENCE, and sentences rarely repeat. Shrinking here turns ~90-230 KB of
 * inlined base64 per icon into ~10-20 KB.
 *
 * Sized to the raster height rather than under it: the glyph is downsampled from
 * here, so anything smaller would show as softness in the bubble.
 */
const SLOT_MAX_EDGE = RASTER_HEIGHT;

// asset URL → inlined data URL (shrunk where worthwhile), cached (an SVG loaded
// as an <img> can't fetch external hrefs, so every <image> must be inlined as a
// data URL). null = failed fetch.
const urlToDataUrl = new Map<string, string | null>();
const slotInflight = new Map<string, Promise<string | null>>();
// Final composed-glyph SVG data URL, cached per `glyph|rtl`.
const urlCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * A data URL of `blob` scaled down to SLOT_MAX_EDGE, or null when shrinking is
 * not worth it or not possible — the caller then inlines the original bytes.
 *
 * Skips SVG entirely: it is resolution-independent and already tiny (the flag
 * icons), so rasterizing it would trade quality away for nothing.
 */
async function shrinkToDataUrl(blob: Blob): Promise<string | null> {
  if (typeof document === "undefined" || blob.type === "image/svg+xml") return null;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await decodeImage(objectUrl);
    const w = img?.naturalWidth ?? 0;
    const h = img?.naturalHeight ?? 0;
    if (!img || !w || !h) return null;
    const scale = SLOT_MAX_EDGE / Math.max(w, h);
    if (scale >= 1) return null; // already no bigger than we can show
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png"); // lossless — icon art is hard-edged
  } catch {
    return null; // tainted canvas or an undecodable blob: inline the original
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  if (urlToDataUrl.has(url)) return urlToDataUrl.get(url)!;
  // Two sentences composed at once must not each fetch-and-shrink the same icon.
  const pending = slotInflight.get(url);
  if (pending) return pending;

  const work = (async (): Promise<string | null> => {
    const bankable = canBankSlotAsset(url);
    const bankKey = slotAssetKey(url, SLOT_MAX_EDGE);
    if (bankable) {
      const banked = await readSlotAsset(bankKey);
      if (banked) {
        urlToDataUrl.set(url, banked);
        return banked;
      }
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const blob = await res.blob();
      const dataUrl = (await shrinkToDataUrl(blob)) ?? (await blobToDataUrl(blob));
      urlToDataUrl.set(url, dataUrl);
      if (bankable) void writeSlotAsset(bankKey, dataUrl);
      return dataUrl;
    } catch {
      urlToDataUrl.set(url, null);
      return null;
    }
  })().finally(() => slotInflight.delete(url));

  slotInflight.set(url, work);
  return work;
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

/**
 * Rasterize a glyph string to a standalone SVG. A two-clause CAUSAL line
 * (causation-and-elements.md §4) is split and each clause is composed via
 * buildCausalSvg (side-by-side or stacked by size); any other glyph goes
 * through the single-glyph compositor path.
 */
async function glyphToStandaloneSvg(
  glyph: string,
  resolveImage: ImageResolver,
  rtl: boolean,
  noBackground: boolean,
): Promise<string | null> {
  const causal = splitCausalGlyph(glyph);
  if (causal) {
    const [eff, cau] = await Promise.all([
      singleGlyphToStandaloneSvg(causal.effect, resolveImage, rtl, noBackground),
      singleGlyphToStandaloneSvg(causal.cause, resolveImage, rtl, noBackground),
    ]);
    // Degrade gracefully if a clause failed — render whichever we have.
    if (!eff || !cau) return eff ?? cau;
    const a = svgDims(eff);
    const b = svgDims(cau);
    return buildCausalSvg(
      { svg: eff, w: a.w, h: a.h },
      { svg: cau, w: b.w, h: b.h },
      causal.connective,
      causal.layout,
      rtl,
    );
  }
  return singleGlyphToStandaloneSvg(glyph, resolveImage, rtl, noBackground);
}

async function singleGlyphToStandaloneSvg(
  glyph: string,
  resolveImage: ImageResolver,
  rtl: boolean,
  noBackground: boolean,
): Promise<string | null> {
  // Pass 1 — collect the external (non-data) URLs this glyph needs.
  const needed = new Set<string>();
  const collect: ImageResolver = (input) => {
    const u = resolveImage(input);
    if (u && !u.startsWith("data:")) needed.add(u);
    return u;
  };
  renderToStaticMarkup(createElement(GlyphCompositor, { glyph, rtl, resolveImage: collect, fillSlot: true, noBackground }));
  await Promise.all(Array.from(needed, (u) => fetchAsDataUrl(u)));

  // Pass 2 — render for real, swapping each external URL for its inlined data URL.
  const inline: ImageResolver = (input) => {
    const u = resolveImage(input);
    if (!u) return null;
    if (u.startsWith("data:")) return u;
    return urlToDataUrl.get(u) ?? null;
  };
  const markup = renderToStaticMarkup(createElement(GlyphCompositor, { glyph, rtl, resolveImage: inline, fillSlot: true, noBackground }));
  const svg = extractSvg(markup);
  return svg ? makeStandalone(svg, RASTER_HEIGHT) : null;
}

/**
 * Rasterize a whole composed glyph to a self-contained SVG data URL (the bubble
 * draws it at its natural aspect). Cached per `glyph|rtl`. `resolveImage` maps
 * each symbol to its artwork URL (app-specific bundled assets); omit it to fall
 * back to the compositor's emoji rendering. Returns null for an empty glyph.
 * `noBackground` drops the compositor's tone plate so the artwork reads alone
 * against the world (a model-less object wears its bare glyph, no white square).
 */
export async function rasterizeGlyphToUrl(
  glyph: string,
  opts: { resolveImage?: ImageResolver; rtl?: boolean; noBackground?: boolean } = {},
): Promise<string | null> {
  if (!glyph || !glyph.trim()) return null;
  const resolveImage = opts.resolveImage ?? nullResolver;
  const rtl = opts.rtl ?? false;
  const noBackground = opts.noBackground ?? false;
  const key = `${glyph}|${rtl ? "r" : ""}|${noBackground ? "n" : ""}`;
  if (urlCache.has(key)) return urlCache.get(key)!;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const svg = await glyphToStandaloneSvg(glyph, resolveImage, rtl, noBackground);
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
  /** Same images WITHOUT the tone plate — for a glyph shown bare in the world
   *  (a model-less object), where a background square would read as a card
   *  floating in the scene rather than as the thing itself. */
  glyphIconFor: (glyph: string) => GlyphImage[] | null;
  /** Start decoding glyphs we KNOW will be asked for, before anything asks. The
   *  first bubble is text-only for exactly as long as its glyph takes to compose,
   *  so the fix for "the icon pops in a beat late" is to have composed it already.
   *  Spread across idle ticks — a cold entry runs React twice, and doing a whole
   *  vocabulary in one go would drop frames to save a frame. */
  prewarm: (glyphs: string[], opts?: { bare?: boolean }) => void;
  clear: () => void;
}

/** Cold glyphs started per idle tick during a prewarm. Two keeps the synchronous
 *  compositor renders well inside a frame; a warm (cached-raster) entry is only a
 *  store read plus a PNG decode, so the queue drains fast either way. */
const PREWARM_PER_TICK = 2;

function onIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(fn);
  else setTimeout(fn, 16);
}

/** Decode a URL to an image, resolving null on failure. `decode()` (where
 *  available) forces the bitmap ready NOW, so the bubble's first `drawImage`
 *  doesn't pay a synchronous decode mid-frame. */
function decodeImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const done = () => resolve(img);
      if (typeof img.decode === "function") img.decode().then(done, done);
      else done();
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** PNG bytes of a decoded glyph image at its natural size, or null if the canvas
 *  route is unavailable. `toBlob` THROWS on a tainted canvas — some WebViews
 *  taint on an SVG carrying `<foreignObject>` — and a failure here only means we
 *  compose from scratch again next launch, so it stays silent. */
async function toPngBytes(img: HTMLImageElement): Promise<ArrayBuffer | null> {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h || typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });
    return blob ? await blob.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/**
 * `resolveImage` maps each symbol to its artwork URL (app-specific bundled
 * assets). `rtl` decides which way composed glyphs read — PASS IT whenever the
 * caller knows the language, because the default sniffs `document.dir`, and a
 * game running in its own iframe has a document nobody ever set a direction on.
 */
export function createGlyphImageSource(opts: { resolveImage?: ImageResolver; rtl?: () => boolean } = {}): GlyphImageSource {
  const resolveImage = opts.resolveImage ?? nullResolver;
  const rtlFn = opts.rtl ?? (() => typeof document !== "undefined" && document.documentElement.dir === "rtl");
  // null = pending or permanently failed; an HTMLImageElement = ready.
  const cache = new Map<string, HTMLImageElement | null>();
  const started = new Set<string>();

  /** Get the glyph ready, cheapest route first: the banked bitmap from a previous
   *  launch, else the full compose — which we then bank so no later launch pays
   *  it again. */
  async function load(key: string, glyph: string, rtl: boolean, noBackground: boolean): Promise<void> {
    const bankKey = glyphRasterKey(glyph, rtl, noBackground);
    const png = await readGlyphRaster(bankKey);
    if (png) {
      const objectUrl = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      try {
        const img = await decodeImage(objectUrl);
        if (img) {
          cache.set(key, img);
          return;
        }
      } finally {
        URL.revokeObjectURL(objectUrl); // the decoded bitmap outlives the URL
      }
      // A corrupt record: fall through and recompose rather than show nothing.
    }

    const url = await rasterizeGlyphToUrl(glyph, { resolveImage, rtl, noBackground });
    if (!url) return; // `started` keeps it from being retried every frame
    const img = await decodeImage(url);
    if (!img) {
      cache.set(key, null);
      return;
    }
    cache.set(key, img);
    const bytes = await toPngBytes(img);
    if (bytes) void writeGlyphRaster(bankKey, bytes);
  }

  /** The decoded glyph if it is in hand, else null — starting the load once. The
   *  direction is read HERE and threaded down, so a language switch mid-session
   *  can never key the lookup one way and compose the other. */
  const begin = (glyph: string, noBackground: boolean): HTMLImageElement | null => {
    const rtl = rtlFn();
    const key = `${glyph}|${rtl ? "r" : ""}|${noBackground ? "n" : ""}`;
    const have = cache.get(key);
    if (have) return have;
    if (started.has(key)) return null; // pending or failed
    started.add(key);
    load(key, glyph, rtl, noBackground).catch(() => {});
    return null;
  };

  const makeResolver = (noBackground: boolean) => (glyph: string): GlyphImage[] | null => {
    if (!glyph || !glyph.trim()) return null;
    const img = begin(glyph, noBackground);
    return img ? [img] : null;
  };

  const prewarm = (glyphs: string[], o: { bare?: boolean } = {}): void => {
    const queue = Array.from(new Set(glyphs.filter((g) => g && g.trim())));
    let i = 0;
    const pump = (): void => {
      for (let n = 0; n < PREWARM_PER_TICK && i < queue.length; n++, i++) {
        begin(queue[i]!, o.bare ?? false);
      }
      if (i < queue.length) onIdle(pump);
    };
    if (queue.length) onIdle(pump);
  };

  return {
    glyphFor: makeResolver(false),
    glyphIconFor: makeResolver(true),
    prewarm,
    clear: () => { cache.clear(); started.clear(); },
  };
}
