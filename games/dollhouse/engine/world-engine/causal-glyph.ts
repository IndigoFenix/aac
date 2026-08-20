// shared/world-engine/causal-glyph.ts
//
// PURE layout logic for two-clause CAUSAL lines (planning-docs/symbol-learning-
// game/causation-and-elements.md §4; language-structure-tiers.md Causation tier).
//
// A causal line is a flat glyph SENTENCE with a connective TOKEN joining an
// EFFECT clause and a CAUSE clause, e.g. "i_me + sad + because + i_me +
// have.not + ball". The single-glyph compositor caps at 3 content slots, so
// such a line would TRUNCATE — instead the bubble raster (glyph-images.ts)
// renders each clause on its own and composes them, laid out by SIZE:
//
//   • side by side (row) when the two clauses total ≤ 3 symbols, and
//   • stacked (effect over cause, an arrow between) when they total more —
//
// exactly the language doc's "above the other with an arrow ... or side by side
// if they are small enough". This module owns the split + the orientation
// decision + the pure parent-SVG builder; it has NO DOM/React dependency so it
// is unit-testable on its own. The DOM-bound per-clause raster lives in
// glyph-images.ts, which calls buildCausalSvg with the composed clause images.

/** The connective tokens that separate two clauses (mirrors the symbol-game
 *  `Connective` union — kept local so this render layer owns no game import). */
export const CAUSAL_CONNECTIVES: ReadonlySet<string> = new Set([
  "because",
  // `so`, not `therefore`: they were duplicate LEXICON entries for one
  // connective and `therefore` was deleted (2026-08-20, NO SYNONYMS). A stale
  // spelling here would not throw — the clause simply would not split, and the
  // causal glyph would render as one run-on picture.
  "so",
  "in_order_to",
  "when",
  "until",
]);

/** Forward-binding joins that don't count as content symbols (mirrors the
 *  compositor's JOINS — a "+ to +"/"+ in +" doesn't consume a slot). */
const JOIN_TOKENS: ReadonlySet<string> = new Set([
  "to", "from", "in", "out", "on", "under", "over", "through", "and", "or", "but", "if",
]);

/** Strip an operator tag ("ok#question" → "ok") and lowercase for matching. */
function bareToken(token: string): string {
  return (token.split("#")[0] ?? token).trim().toLowerCase();
}

/** Content symbols in a clause (joins excluded), for the size decision. */
export function contentSlotCount(clause: string): number {
  return clause
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t) => !JOIN_TOKENS.has(bareToken(t)))
    .length;
}

export interface CausalSplit {
  /** Clause one (the effect) as its own glyph string. */
  effect: string;
  /** The connective, bare ("because", "in_order_to", …). */
  connective: string;
  /** Clause two (the cause / goal) as its own glyph string. */
  cause: string;
  /** row = clauses total ≤ 3 symbols; stack = more (the language-doc rule). */
  layout: "row" | "stack";
}

/**
 * Split a flat causal glyph line into its two clauses + orientation, or null if
 * it isn't a two-clause causal line (no connective, or the connective sits at an
 * edge so one clause would be empty — e.g. the level-b form "because + …", which
 * renders fine through the ordinary single-glyph path). Splits on the FIRST
 * connective only (v1 carries one fact; chains come later).
 */
export function splitCausalGlyph(glyph: string): CausalSplit | null {
  if (!glyph) return null;
  const tokens = glyph.split("+").map((s) => s.trim()).filter(Boolean);
  const idx = tokens.findIndex((t) => CAUSAL_CONNECTIVES.has(bareToken(t)));
  // Need a non-empty clause on BOTH sides (idx in 1..len-2).
  if (idx <= 0 || idx >= tokens.length - 1) return null;
  const effect = tokens.slice(0, idx).join(" + ");
  const cause = tokens.slice(idx + 1).join(" + ");
  const total = contentSlotCount(effect) + contentSlotCount(cause);
  return {
    effect,
    connective: bareToken(tokens[idx]!),
    cause,
    layout: total > 3 ? "stack" : "row",
  };
}

/** Human-legible connective label until the connective GLYPHS ship (worklist). */
function connectiveLabel(connective: string): string {
  return connective === "in_order_to" ? "in order to" : connective;
}

/** Width/height a standalone clause SVG declares (makeStandalone set them). */
export function svgDims(svg: string): { w: number; h: number } {
  const w = svg.match(/\bwidth="([\d.]+)"/);
  const h = svg.match(/\bheight="([\d.]+)"/);
  return { w: w ? parseFloat(w[1]!) : 1, h: h ? parseFloat(h[1]!) : 1 };
}

/** Nest a standalone clause SVG at (x,y) in a (w,h) box — its own viewBox maps
 *  the content in, so aspect is preserved. Overrides any existing width/height. */
function placeSvg(svg: string, x: number, y: number, w: number, h: number): string {
  const openEnd = svg.indexOf(">");
  let open = svg.slice(0, openEnd).replace(/\swidth="[^"]*"/, "").replace(/\sheight="[^"]*"/, "");
  open = open.replace(
    /^<svg/,
    `<svg x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}"`,
  );
  return open + svg.slice(openEnd);
}

const round = (n: number): number => Math.round(n * 100) / 100;
const CONNECTOR_COLOR = "#475569";

/**
 * Compose two rendered clause SVGs into ONE standalone parent SVG, laid out per
 * `layout`, with a connective arrow + label between them. Pure string work — the
 * caller supplies each clause already rasterized (glyph-images.ts).
 */
export function buildCausalSvg(
  effect: { svg: string; w: number; h: number },
  cause: { svg: string; w: number; h: number },
  connective: string,
  layout: "row" | "stack",
  rtl: boolean,
): string {
  const label = connectiveLabel(connective);
  const svgOpen = (w: number, h: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(w)}" height="${round(h)}" viewBox="0 0 ${round(w)} ${round(h)}">`;
  const text = (x: number, y: number, fs: number) =>
    `<text x="${round(x)}" y="${round(y)}" font-family="system-ui, -apple-system, sans-serif" ` +
    `font-size="${round(fs)}" font-weight="600" fill="${CONNECTOR_COLOR}" ` +
    `text-anchor="middle" dominant-baseline="middle">${label}</text>`;

  if (layout === "stack") {
    const connH = Math.min(effect.h, cause.h) * 0.5;
    const fs = connH * 0.42;
    const labelW = label.length * fs * 0.6;
    const W = Math.max(effect.w, cause.w, labelW + 16);
    const H = effect.h + connH + cause.h;
    const cx = W / 2;
    const top = placeSvg(effect.svg, (W - effect.w) / 2, 0, effect.w, effect.h);
    const bot = placeSvg(cause.svg, (W - cause.w) / 2, effect.h + connH, cause.w, cause.h);
    const y0 = effect.h + connH * 0.1;
    const y1 = effect.h + connH * 0.5;
    const arrow =
      `<line x1="${round(cx)}" y1="${round(y0)}" x2="${round(cx)}" y2="${round(y1)}" ` +
      `stroke="${CONNECTOR_COLOR}" stroke-width="6"/>` +
      `<path d="M ${round(cx)} ${round(y1 + 8)} l -9 -14 l 18 0 z" fill="${CONNECTOR_COLOR}"/>`;
    return svgOpen(W, H) + top + arrow + text(cx, effect.h + connH * 0.78, fs) + bot + "</svg>";
  }

  // row — clauses side by side, an arrow + label between (RTL flips the order).
  const H = Math.max(effect.h, cause.h);
  const fs = H * 0.15;
  const labelW = label.length * fs * 0.6;
  const connW = Math.max(labelW + 16, H * 0.5);
  const first = rtl ? cause : effect;
  const second = rtl ? effect : cause;
  const W = first.w + connW + second.w;
  const midX = first.w + connW / 2;
  const firstSvg = placeSvg(first.svg, 0, (H - first.h) / 2, first.w, first.h);
  const secondSvg = placeSvg(second.svg, first.w + connW, (H - second.h) / 2, second.w, second.h);
  const ax0 = first.w + connW * 0.15;
  const ax1 = first.w + connW * 0.85;
  const ay = H * 0.62;
  const arrow = rtl
    ? `<line x1="${round(ax1)}" y1="${round(ay)}" x2="${round(ax0)}" y2="${round(ay)}" stroke="${CONNECTOR_COLOR}" stroke-width="6"/>` +
      `<path d="M ${round(ax0 - 4)} ${round(ay)} l 14 -8 l 0 16 z" fill="${CONNECTOR_COLOR}"/>`
    : `<line x1="${round(ax0)}" y1="${round(ay)}" x2="${round(ax1)}" y2="${round(ay)}" stroke="${CONNECTOR_COLOR}" stroke-width="6"/>` +
      `<path d="M ${round(ax1 + 4)} ${round(ay)} l -14 -8 l 0 16 z" fill="${CONNECTOR_COLOR}"/>`;
  return svgOpen(W, H) + firstSvg + secondSvg + arrow + text(midX, H * 0.32, fs) + "</svg>";
}
