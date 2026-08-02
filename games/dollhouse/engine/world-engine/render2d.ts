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
import { colorHexForId } from "./peer-colors.js";
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

  // Building footprints (top-down can't show storeys — just outline the shell;
  // its perimeter walls/doors render via the expanded structures below).
  for (const b of state.spec.buildings ?? []) {
    const o = worldToScreen(cam, b.footprint.x, b.footprint.y);
    ctx.fillStyle = "rgba(148,163,184,0.12)";
    ctx.fillRect(o.sx, o.sy, b.footprint.w * cam.scale, b.footprint.h * cam.scale);
  }

  // Structures (walls + doors) — under objects/avatars. A wall is a thick capped
  // line; a door is a leaf hinged at one end, swung open by its live `open`.
  for (const s of state.spec.structures ?? []) {
    if (s.kind === "stairs") {
      // Footprint rect with hatch lines; top-down can't show the rise.
      const o = worldToScreen(cam, s.rect.x, s.rect.y);
      const w = s.rect.w * cam.scale;
      const h = s.rect.h * cam.scale;
      ctx.fillStyle = "rgba(100,116,139,0.5)";
      ctx.fillRect(o.sx, o.sy, w, h);
      ctx.strokeStyle = "rgba(226,232,240,0.7)";
      ctx.lineWidth = 1;
      const along = s.axis === "+y" || s.axis === "-y";
      const steps = 5;
      ctx.beginPath();
      for (let i = 1; i < steps; i++) {
        if (along) { const yy = o.sy + (h * i) / steps; ctx.moveTo(o.sx, yy); ctx.lineTo(o.sx + w, yy); }
        else { const xx = o.sx + (w * i) / steps; ctx.moveTo(xx, o.sy); ctx.lineTo(xx, o.sy + h); }
      }
      ctx.stroke();
      continue;
    }
    const a = worldToScreen(cam, s.a.x, s.a.y);
    const b = worldToScreen(cam, s.b.x, s.b.y);
    const lw = Math.max(2, s.thickness * cam.scale);
    ctx.lineCap = "round";
    if (s.kind === "wall") {
      ctx.strokeStyle = "#9ca3af";
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    } else {
      // Frame slot (where the closed leaf would sit) in faint grey.
      ctx.strokeStyle = "rgba(156,163,175,0.4)";
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
      // A LEAFLESS doorway (phase 5) is the frame and nothing else — the 2D
      // twin of render3d's lintel-only build. Drawing the leaf here would be
      // worse than merely wrong: `tickDoors` pins a hole's `open` at 1, so the
      // slab would swing wide open and read as a door that IS there.
      if (s.leaf === false) continue;
      // The leaf.
      const open = state.doors[s.id]?.open ?? 0;
      const locked = state.doors[s.id]?.locked ?? false;
      const hinge = s.hinge === "b" ? b : a;
      const other = s.hinge === "b" ? a : b;
      const len = Math.hypot(other.sx - hinge.sx, other.sy - hinge.sy);
      const ang = Math.atan2(other.sy - hinge.sy, other.sx - hinge.sx) + open * (Math.PI * 0.55);
      ctx.strokeStyle = locked ? "#7c2d12" : "#b45309";
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(hinge.sx, hinge.sy);
      ctx.lineTo(hinge.sx + Math.cos(ang) * len, hinge.sy + Math.sin(ang) * len);
      ctx.stroke();
    }
  }
  ctx.lineCap = "butt";

  // Objects — drawn by shape (sphere → circle, box → square).
  for (const obj of Object.values(state.objects)) {
    const spec = state.spec.objects.find((o) => o.id === obj.id);
    const r = (spec?.radius ?? 0.5) * cam.scale;
    const { sx, sy } = worldToScreen(cam, obj.x, obj.y);
    ctx.fillStyle = "#fafafa";
    ctx.lineWidth = Math.max(2, r * 0.25);
    ctx.strokeStyle = obj.possessedBy ? colorForId(obj.possessedBy) : "#222";
    if (obj.shape === "box") {
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
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
  // size (UI-like), floated over each bubble's anchor; fades out at its TTL. One
  // path for networked utterances and in-game character/caption speech alike.
  for (const b of Object.values(state.bubbles)) {
    const pos = b.anchor.kind === "avatar" ? state.avatars[b.anchor.id] : b.anchor;
    if (!pos) continue;
    const alpha = bubbleAlpha(b.at, state.time, b.ttl);
    if (alpha <= 0) continue;
    const glyphs = b.glyph ? opts.glyphFor?.(b.glyph) ?? [] : [];
    const aspect = glyphs[0] ? imageAspect(glyphs[0]) : 0;
    const layout = layoutBubble(ctx, b.text, aspect);
    const { sx, sy } = worldToScreen(cam, pos.x, pos.y);
    const r = AVATAR_R * cam.scale;
    ctx.save();
    // Top-left so the bubble is centred over the head, sitting above the circle.
    ctx.translate(sx - layout.width / 2, sy - r - 12 - layout.height);
    paintBubble(ctx, layout, glyphs, alpha, b.style ?? "speech");
    ctx.restore();
  }
}

/** Stable, readable color from a participant id — the shared peer palette
 *  (peer-colors.ts), so a participant is the same colour in every view. */
function colorForId(id: string): string {
  return colorHexForId(id);
}
