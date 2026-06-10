// World ↔ screen transform. Small worlds fit the viewport (static camera);
// large worlds get a readable minimum scale and the camera follows the
// player, clamped to the world bounds.

import type { Layout2D, Rect, Vec2 } from "@shared/goal-tree/layout2d";

export interface Camera {
  scale: number; // CSS px per world unit
  offsetX: number; // world point (offsetX, offsetY) maps to screen (0, 0)
  offsetY: number;
}

/** Smallest readable zoom — below this the camera follows instead. */
const MIN_UNIT_PX = 36;
const WORLD_PADDING = 0.75;

export function worldBounds(layout: Layout2D): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const zone of layout.zones) {
    minX = Math.min(minX, zone.rect.x);
    minY = Math.min(minY, zone.rect.y);
    maxX = Math.max(maxX, zone.rect.x + zone.rect.w);
    maxY = Math.max(maxY, zone.rect.y + zone.rect.h);
  }
  return {
    x: minX - WORLD_PADDING,
    y: minY - WORLD_PADDING,
    w: maxX - minX + WORLD_PADDING * 2,
    h: maxY - minY + WORLD_PADDING * 2,
  };
}

export function computeCamera(
  cssWidth: number,
  cssHeight: number,
  layout: Layout2D,
  playerPos: Vec2,
): Camera {
  const bounds = worldBounds(layout);
  const fitScale = Math.min(cssWidth / bounds.w, cssHeight / bounds.h);

  if (fitScale >= MIN_UNIT_PX) {
    // Static fit, centered.
    return {
      scale: fitScale,
      offsetX: bounds.x - (cssWidth / fitScale - bounds.w) / 2,
      offsetY: bounds.y - (cssHeight / fitScale - bounds.h) / 2,
    };
  }

  // Follow the player at minimum readable scale, clamped to bounds.
  const scale = MIN_UNIT_PX;
  const viewW = cssWidth / scale;
  const viewH = cssHeight / scale;
  const clamp = (v: number, lo: number, hi: number) =>
    hi <= lo ? lo + (hi - lo) / 2 : Math.min(hi, Math.max(lo, v));
  return {
    scale,
    offsetX: clamp(playerPos.x - viewW / 2, bounds.x, bounds.x + bounds.w - viewW),
    offsetY: clamp(playerPos.y - viewH / 2, bounds.y, bounds.y + bounds.h - viewH),
  };
}

export function worldToScreen(cam: Camera, p: Vec2): Vec2 {
  return { x: (p.x - cam.offsetX) * cam.scale, y: (p.y - cam.offsetY) * cam.scale };
}

export function screenToWorld(cam: Camera, p: Vec2): Vec2 {
  return { x: p.x / cam.scale + cam.offsetX, y: p.y / cam.scale + cam.offsetY };
}
