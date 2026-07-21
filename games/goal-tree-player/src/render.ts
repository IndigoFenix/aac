// Canvas renderer for the goal-tree player. Pure draw — all state lives in
// the shared sim/runtime; this file just paints it.

import type { GoalTreeGame } from "@shared/world-engine/solver/types";
import type { LogicalWorld, ZoneKind } from "@shared/world-engine/solver/logical-world";
import type { Layout2D, Vec2 } from "@shared/world-engine/solver/layout2d";
import { rectCenter } from "@shared/world-engine/solver/layout2d";
import type { Space2DState } from "@shared/world-engine/solver/space2d";
import type { ObjectiveSummary } from "@shared/world-engine/solver/space";
import { type Camera, worldToScreen } from "./camera";

export interface FrameView {
  game: GoalTreeGame;
  world: LogicalWorld;
  layout: Layout2D;
  sState: Space2DState;
  completed: Record<string, true>;
  objectives: ObjectiveSummary[];
  /** Gaze in CSS px, when fresh. */
  gaze: Vec2 | null;
  /** 0..1 dwell ring at the gaze point (walk mode). */
  dwellProgress: number;
  timeMs: number;
  won: boolean;
}

const ZONE_FILL: Record<ZoneKind, string> = {
  start: "#3d7a46",
  reach: "#3f6f8f",
  collect: "#4c7a38",
  pocket: "#8a6d3b",
};
const ZONE_EDGE = "rgba(255, 255, 255, 0.18)";
const BACKGROUND = "#16222e";

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  cam: Camera,
  view: FrameView,
): void {
  const { layout, world, sState, timeMs } = view;
  const icon = entityIconLookup(view.game);
  const unit = cam.scale;

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // Zones
  const kindByZone = new Map(world.zones.map((z) => [z.id, z.kind]));
  for (const zone of layout.zones) {
    const tl = worldToScreen(cam, zone.rect);
    const fill = ZONE_FILL[kindByZone.get(zone.zoneId) ?? "start"];
    roundRect(ctx, tl.x, tl.y, zone.rect.w * unit, zone.rect.h * unit, unit * 0.4);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = ZONE_EDGE;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Doors (locked: guard icon + lock; unlocked: light walkway)
  const guardsByPassage = new Map(world.passages.map((p) => [p.id, p.guards]));
  for (const door of layout.doors) {
    const tl = worldToScreen(cam, door.rect);
    const w = door.rect.w * unit;
    const h = door.rect.h * unit;
    const unlockedDoor = !!sState.unlocked[door.passageId];
    ctx.fillStyle = unlockedDoor ? "#d4c290" : "#6b4a2c";
    roundRect(ctx, tl.x, tl.y, w, h, Math.min(w, h) * 0.3);
    ctx.fill();

    const center = worldToScreen(cam, rectCenter(door.rect));
    const guards = guardsByPassage.get(door.passageId) ?? [];
    const guardIcon = guards.length ? icon(guards[0].obstacleEntityId) : null;
    if (!unlockedDoor && guardIcon) {
      drawEmoji(ctx, guardIcon, center, unit * 1.3);
      drawEmoji(ctx, "🔒", { x: center.x, y: center.y + unit * 0.75 }, unit * 0.6);
    }
  }

  // Items (gentle bob; skip collected)
  for (const item of layout.items) {
    if (sState.removed[item.instanceId]) continue;
    const p = worldToScreen(cam, item.pos);
    const bob = Math.sin(timeMs / 600 + item.pos.x * 1.7) * unit * 0.06;
    drawEmoji(ctx, icon(item.entityId) ?? "❔", { x: p.x, y: p.y + bob }, unit * 0.9);
  }

  // Figures (halo when they are an active, unlocked objective)
  const activeNodes = new Set(
    view.objectives.filter((o) => !o.locked).map((o) => o.nodeId),
  );
  for (const figure of layout.figures) {
    const p = worldToScreen(cam, figure.pos);
    if (activeNodes.has(figure.nodeId) && !view.completed[figure.nodeId]) {
      const pulse = 0.5 + 0.5 * Math.sin(timeMs / 350);
      ctx.beginPath();
      ctx.arc(p.x, p.y, unit * (0.9 + pulse * 0.18), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 235, 130, ${0.35 + pulse * 0.35})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    drawEmoji(ctx, icon(figure.entityId) ?? "❔", p, unit * 1.25);
  }

  // Walk target marker
  if (sState.target) {
    const p = worldToScreen(cam, sState.target.point);
    const pulse = 0.5 + 0.5 * Math.sin(timeMs / 200);
    ctx.beginPath();
    ctx.arc(p.x, p.y, unit * (0.25 + pulse * 0.12), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Player
  const player = worldToScreen(cam, sState.pos);
  ctx.beginPath();
  ctx.arc(player.x, player.y + unit * 0.08, unit * 0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.fill();
  drawEmoji(ctx, "🐥", player, unit * 1.1);

  // Dwell ring at the gaze point
  if (view.gaze && view.dwellProgress > 0.02) {
    ctx.beginPath();
    ctx.arc(
      view.gaze.x,
      view.gaze.y,
      unit * 0.55,
      -Math.PI / 2,
      -Math.PI / 2 + view.dwellProgress * Math.PI * 2,
    );
    ctx.strokeStyle = "rgba(56, 189, 248, 0.95)";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.stroke();
  }
}

function entityIconLookup(game: GoalTreeGame): (id: string) => string | null {
  const byId = new Map(game.entities.map((e) => [e.id, e.iconRef ?? null]));
  return (id) => byId.get(id) ?? null;
}

function drawEmoji(
  ctx: CanvasRenderingContext2D,
  emoji: string,
  at: Vec2,
  sizePx: number,
): void {
  ctx.font = `${Math.round(sizePx)}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, at.x, at.y);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
