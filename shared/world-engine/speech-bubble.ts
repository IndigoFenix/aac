// shared/world-engine/speech-bubble.ts
//
// A self-contained speech-bubble drawer shared by BOTH world renderers:
//   • render2d.ts paints it in screen space, just above an avatar's circle;
//   • render3d.ts paints it onto an OffscreenCanvas that becomes a billboarded
//     sprite texture floating over the avatar's head.
//
// Both draw into a 2D canvas context (HTMLCanvas or OffscreenCanvas — the APIs
// used here are common to both, matching render2d.ts's duck-typed approach). The
// content is laid out ONCE (wrapped text rows + one optional composed-glyph image)
// and painted with its top-left at the current origin, so each caller positions
// it with a translate. Pure drawing — no DOM, no engine state.
//
// The glyph row is a SINGLE image of the whole composed glyph (rendered upstream
// through the shared GlyphCompositor — all slots, RTL, modifiers, emoji), drawn at
// its natural aspect ratio. The caller passes that aspect (width/height) so layout
// reserves the right box; `imageAspect` derives it from a decoded image.

/** A drawable composed-glyph image (decoded image / ImageBitmap). */
export type GlyphImage = CanvasImageSource;

/** Aspect ratio (width/height) of a decoded image, or 0 if not measurable. */
export function imageAspect(img: GlyphImage): number {
  const anyImg = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  const w = anyImg.naturalWidth || anyImg.width || 0;
  const h = anyImg.naturalHeight || anyImg.height || 0;
  return w > 0 && h > 0 ? w / h : 0;
}

export interface BubbleStyle {
  /** Text font size in px (the whole bubble scales off this). Default 24. */
  fontSize: number;
  /** Inner padding (px). Default 12. */
  padding: number;
  /** Max content width (px) before the text wraps. Default 340. */
  maxWidth: number;
  /** Target HEIGHT (px) of the composed-glyph image; width follows its aspect. Default 80. */
  glyphSize: number;
}

export const DEFAULT_BUBBLE_STYLE: BubbleStyle = {
  fontSize: 24,
  padding: 12,
  maxWidth: 340,
  glyphSize: 80,
};

export interface BubbleLayout {
  lines: string[];
  /** Total bubble size INCLUDING padding (px). */
  width: number;
  height: number;
  /** Resolved style (defaults merged) so paint matches layout exactly. */
  style: BubbleStyle;
  /** Drawn size of the composed-glyph image (0 when none) — aspect-preserved. */
  glyphDrawWidth: number;
  glyphDrawHeight: number;
  /** Height of the glyph row including its bottom gap (0 when none). */
  glyphRowHeight: number;
}

const FONT = (px: number) => `600 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
const LINE_GAP = 1.3; // line height multiplier

/** Greedy word-wrap `text` to `maxWidth`, measuring with the given context. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${line} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = words[i];
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Measure a bubble for `text` (+ optional glyph strip). Sets ctx.font as a side
 * effect (the caller's paint relies on the same font). Caps very long text to a
 * few lines so a bubble never swallows the screen.
 */
export function layoutBubble(
  ctx: CanvasRenderingContext2D,
  text: string,
  glyphAspect = 0,
  style: Partial<BubbleStyle> = {},
): BubbleLayout {
  const s: BubbleStyle = { ...DEFAULT_BUBBLE_STYLE, ...style };
  ctx.font = FONT(s.fontSize);
  const maxTextWidth = s.maxWidth - s.padding * 2;

  let lines = wrapText(ctx, text, maxTextWidth);
  const MAX_LINES = 4;
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    lines[MAX_LINES - 1] = `${lines[MAX_LINES - 1].replace(/\s+\S*$/, "")}…`;
  }

  const textWidth = lines.reduce((w, l) => Math.max(w, ctx.measureText(l).width), 0);

  // Composed-glyph image: one picture of the WHOLE glyph, drawn at glyphSize tall
  // with its width following the image's aspect — so it never stretches. A long
  // multi-slot glyph can be wider than the text, so it may grow the bubble (up to
  // a generous cap); when it would exceed the cap, both dims scale down together.
  let glyphDrawHeight = 0;
  let glyphDrawWidth = 0;
  if (glyphAspect > 0) {
    glyphDrawHeight = s.glyphSize;
    glyphDrawWidth = glyphDrawHeight * glyphAspect;
    const maxGlyphWidth = s.maxWidth * 1.5;
    if (glyphDrawWidth > maxGlyphWidth) {
      glyphDrawHeight *= maxGlyphWidth / glyphDrawWidth;
      glyphDrawWidth = maxGlyphWidth;
    }
  }
  const glyphRowHeight = glyphDrawHeight > 0 ? glyphDrawHeight + s.padding : 0;

  const contentWidth = Math.max(textWidth, glyphDrawWidth, 1);
  const lineHeight = s.fontSize * LINE_GAP;
  const textHeight = lines.length * lineHeight;

  return {
    lines,
    style: s,
    glyphDrawWidth,
    glyphDrawHeight,
    glyphRowHeight,
    width: Math.ceil(contentWidth + s.padding * 2),
    height: Math.ceil(textHeight + glyphRowHeight + s.padding * 2),
  };
}

/** Rounded-rect path (ctx.roundRect isn't on every OffscreenCanvas engine). */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/**
 * Paint a laid-out bubble with its top-left at the current origin (0,0). `alpha`
 * fades the whole thing (the renderer eases it near the TTL). Draws the glyph
 * strip (if any) on top, then the wrapped text below it. Leaves ctx state as it
 * found it bar transient style — callers wrap with save/restore + translate.
 */
export function paintBubble(
  ctx: CanvasRenderingContext2D,
  layout: BubbleLayout,
  glyphImages: GlyphImage[],
  alpha = 1,
  variant: "speech" | "thought" = "speech",
): void {
  const { style: s, lines, width, height, glyphDrawWidth, glyphDrawHeight, glyphRowHeight } = layout;
  ctx.globalAlpha = alpha;
  const thought = variant === "thought";
  const stroke = thought ? "rgba(99,102,241,0.55)" : "rgba(15,23,42,0.18)";

  // Bubble body — thought bubbles get a rounder, dashed, indigo outline.
  roundRectPath(ctx, 0, 0, width, height, thought ? 18 : 10);
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fill();
  ctx.lineWidth = thought ? 2 : 1.5;
  if (thought) ctx.setLineDash([7, 6]);
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.setLineDash([]);

  const cx = width / 2;
  if (thought) {
    // Thought tail: two shrinking circles toward the head (fits within the
    // renderers' tail allowance of ~12px below the body).
    for (const [r, dy] of [
      [3.5, 4.5],
      [2, 9.5],
    ] as const) {
      ctx.beginPath();
      ctx.arc(cx, height + dy, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  } else {
    // Little downward tail at the bottom centre, pointing to the head.
    const tailW = 12;
    ctx.beginPath();
    ctx.moveTo(cx - tailW / 2, height - 0.5);
    ctx.lineTo(cx, height + tailW * 0.8);
    ctx.lineTo(cx + tailW / 2, height - 0.5);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.fill();
  }

  let y = s.padding;

  // Composed-glyph image (centred), drawn at its aspect-preserved size.
  if (glyphDrawWidth > 0 && glyphImages[0]) {
    const gx = (width - glyphDrawWidth) / 2;
    try { ctx.drawImage(glyphImages[0], gx, y, glyphDrawWidth, glyphDrawHeight); } catch { /* ignore */ }
    y += glyphRowHeight;
  }

  // Text.
  ctx.font = FONT(s.fontSize);
  ctx.fillStyle = "#0f172a";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const lineHeight = s.fontSize * LINE_GAP;
  for (const line of lines) {
    ctx.fillText(line, width / 2, y);
    y += lineHeight;
  }

  ctx.globalAlpha = 1;
}

/** Default time a bubble stays up (sim-seconds) and how long it fades at the end. */
export const BUBBLE_TTL_SECONDS = 6;
export const BUBBLE_FADE_SECONDS = 1;

/** Opacity 0..1 for a bubble said at `at` given the current sim time, or 0 once
 *  expired. Full opacity until the last BUBBLE_FADE_SECONDS, then eases out. `ttl`
 *  (sim-seconds) is the total visible duration — caller-chosen per bubble. */
export function bubbleAlpha(sayAt: number, now: number, ttl: number = BUBBLE_TTL_SECONDS): number {
  const age = now - sayAt;
  if (age < 0) return 1;
  if (age >= ttl) return 0;
  const fadeStart = ttl - Math.min(BUBBLE_FADE_SECONDS, ttl);
  if (age <= fadeStart) return 1;
  return 1 - (age - fadeStart) / Math.min(BUBBLE_FADE_SECONDS, ttl);
}
