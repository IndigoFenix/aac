// shared/world-engine/render2d.ts
//
// Canvas Render2D for the world engine — the top-down view. Deliberately NOT
// part of the index.js barrel: the server consumes the headless engine/net and
// should never pull a DOM-typed module. Clients import this directly.
//
// Split into pure camera math (unit-tested) and the draw call (DOM). The same
// camera maps pointer/gaze input to world coordinates, so steering and
// rendering share one transform. A future Render3D consumes the SAME WorldState
// behind a different draw call — this file is the only 2D-specific piece.

import { WORLD_ENGINE_DEFAULTS, type WorldState } from "./engine.js";
import { bubbleAlpha, imageAspect, layoutBubble, paintBubble } from "./speech-bubble.js";

// ---------------------------------------------------------------------------
// Camera (pure — world units ↔ screen pixels)
// ---------------------------------------------------------------------------

export interface WorldCamera {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Fit the whole manifold into the view, centered, preserving aspect. */
export function fitCamera(
  viewWidth: number,
  viewHeight: number,
  world: { width: number; height: number },
  padding = 16,
): WorldCamera {
  const usableW = Math.max(1, viewWidth - 2 * padding);
  const usableH = Math.max(1, viewHeight - 2 * padding);
  const scale = Math.min(usableW / world.width, usableH / world.height);
  return {
    scale,
    offsetX: (viewWidth - world.width * scale) / 2,
    offsetY: (viewHeight - world.height * scale) / 2,
  };
}

/**
 * Follow camera: centers on `center` at a fixed zoom (fits `worldSpan` world
 * units across the SMALLER viewport dimension, so the zoom is consistent across
 * aspect ratios). Used to track the local avatar through a field larger than the
 * screen. No edge-clamp — near a wall the backdrop shows beyond it, which keeps
 * the "avatar is always at screen centre" control mapping exact.
 */
export function followCamera(
  viewWidth: number,
  viewHeight: number,
  center: { x: number; y: number },
  worldSpan: number,
): WorldCamera {
  const scale = Math.min(viewWidth, viewHeight) / Math.max(1, worldSpan);
  return {
    scale,
    offsetX: viewWidth / 2 - center.x * scale,
    offsetY: viewHeight / 2 - center.y * scale,
  };
}

export function worldToScreen(cam: WorldCamera, x: number, y: number): { sx: number; sy: number } {
  return { sx: cam.offsetX + x * cam.scale, sy: cam.offsetY + y * cam.scale };
}

export function screenToWorld(cam: WorldCamera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.offsetX) / cam.scale, y: (sy - cam.offsetY) / cam.scale };
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** The local participant's id — drawn highlighted. */
  localId: string;
  viewWidth: number;
  viewHeight: number;
  /** Backdrop outside the field. */
  backdrop?: string;
  /** A drawable face (loaded photo / video frame) for a participant, clipped into
   *  their avatar circle. Return null to fall back to a coloured disc + initial. */
  faceFor?: (id: string) => CanvasImageSource | null;
  /** Display name for a participant — its initial is the coloured-disc fallback. */
  labelFor?: (id: string) => string;
  /** Symbol images for a participant's last-said composed glyph (bubble strip). */
  glyphFor?: (glyph: string) => CanvasImageSource[] | null;
}

const AVATAR_R = WORLD_ENGINE_DEFAULTS.avatarRadius;

/** Natural pixel size of any CanvasImageSource (image or video). */
function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  const s = src as unknown as { videoWidth?: number; naturalWidth?: number; width?: number; videoHeight?: number; naturalHeight?: number; height?: number };
  return {
    w: s.videoWidth ?? s.naturalWidth ?? s.width ?? 0,
    h: s.videoHeight ?? s.naturalHeight ?? s.height ?? 0,
  };
}

/** Draw `src` to cover the dw×dh box (object-fit: cover), centered. */
function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
  const { w: iw, h: ih } = sourceSize(src);
  if (!iw || !ih) return;
  const scale = Math.max(dw / iw, dh / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(src, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

/** A small filled arrowhead pointing along (dx,dy), just outside the circle. */
function drawDirectionArrow(ctx: CanvasRenderingContext2D, sx: number, sy: number, dx: number, dy: number, r: number): void {
  const tip = r * 1.85;   // arrow point, beyond the circle
  const base = r * 1.0;   // arrow base, at the circle edge
  const half = r * 0.55;  // half-width of the base
  const px = -dy;
  const py = dx;
  ctx.beginPath();
  ctx.moveTo(sx + dx * tip, sy + dy * tip);
  ctx.lineTo(sx + dx * base + px * half, sy + dy * base + py * half);
  ctx.lineTo(sx + dx * base - px * half, sy + dy * base - py * half);
  ctx.closePath();
  ctx.fillStyle = "rgba(15,23,42,0.7)";
  ctx.fill();
}

export function renderWorld2D(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  cam: WorldCamera,
  opts: RenderOptions,
): void {
  const { width, height } = state.spec.manifold;

  // Backdrop + field.
  ctx.fillStyle = opts.backdrop ?? "#1b2430";
  ctx.fillRect(0, 0, opts.viewWidth, opts.viewHeight);

  const origin = worldToScreen(cam, 0, 0);
  const fieldW = width * cam.scale;
  const fieldH = height * cam.scale;
  ctx.fillStyle = state.spec.terrain.groundColor ?? "#6db36b";
  ctx.fillRect(origin.sx, origin.sy, fieldW, fieldH);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(origin.sx, origin.sy, fieldW, fieldH);

  // Toys.
  for (const toy of Object.values(state.toys)) {
    const spec = state.spec.toys.find((t) => t.id === toy.id);
    const r = (spec?.radius ?? 0.5) * cam.scale;
    const { sx, sy } = worldToScreen(cam, toy.x, toy.y);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fafafa";
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.25);
    ctx.strokeStyle = toy.possessedBy ? colorForId(toy.possessedBy) : "#222";
    ctx.stroke();
  }

  // Avatars (local last so it sits on top). Each is a circle bearing the user's
  // face (when available), with a small arrow showing their direction of motion.
  const ids = Object.keys(state.avatars).sort((a) =>
    a === opts.localId ? 1 : -1,
  );
  for (const id of ids) {
    const a = state.avatars[id];
    const r = AVATAR_R * cam.scale;
    const { sx, sy } = worldToScreen(cam, a.x, a.y);
    const isLocal = id === opts.localId;

    // Motion arrow first (behind the body) — only while actually moving.
    const speed = Math.hypot(a.vx, a.vy);
    if (speed > 0.25) {
      drawDirectionArrow(ctx, sx, sy, a.vx / speed, a.vy / speed, r);
    }

    // Body: the user's face clipped into the circle, else a coloured disc + initial.
    const face = opts.faceFor?.(id) ?? null;
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.closePath();
    if (face) {
      ctx.clip();
      drawCover(ctx, face, sx - r, sy - r, r * 2, r * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = isLocal ? "#2f6fed" : colorForId(id);
      ctx.fill();
      ctx.restore();
      const label = (opts.labelFor?.(id) ?? "").trim().charAt(0).toUpperCase();
      if (label) {
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.round(r * 1.05)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, sx, sy + r * 0.04);
      }
    }

    // Ring. "You" gets a bold bright border (so your own face stands out among
    // everyone else's); others get a thin dark outline.
    if (isLocal) {
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(3, r * 0.24);
      ctx.strokeStyle = "#38bdf8";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, r * 0.07);
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.strokeStyle = "rgba(15,23,42,0.55)";
      ctx.stroke();
    }
  }

  // Speech bubbles — a second pass so they sit above every body. Constant SCREEN
  // size (UI-like), positioned just above each speaker's circle; fades out at TTL.
  for (const id of ids) {
    const a = state.avatars[id];
    if (!a.say) continue;
    const alpha = bubbleAlpha(a.say.at, state.time);
    if (alpha <= 0) continue;
    const glyphs = a.say.glyph ? opts.glyphFor?.(a.say.glyph) ?? [] : [];
    const aspect = glyphs[0] ? imageAspect(glyphs[0]) : 0;
    const layout = layoutBubble(ctx, a.say.text, aspect);
    const { sx, sy } = worldToScreen(cam, a.x, a.y);
    const r = AVATAR_R * cam.scale;
    ctx.save();
    // Top-left so the bubble is centred over the head, sitting above the circle.
    ctx.translate(sx - layout.width / 2, sy - r - 12 - layout.height);
    paintBubble(ctx, layout, glyphs, alpha);
    ctx.restore();
  }
}

/** Stable, readable color from a participant id (FNV-1a → hue). */
function colorForId(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `hsl(${h % 360}, 65%, 55%)`;
}
