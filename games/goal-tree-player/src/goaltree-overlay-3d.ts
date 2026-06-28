// games/goal-tree-player/src/goaltree-overlay-3d.ts
//
// The goal-tree quest drawn as a SceneOverlay inside the world engine's 3D
// scene (Phase-0 merge spike). It shares the engine's camera, ground, and
// lighting; it only adds the quest's furniture:
//   • zone floors  — tinted slabs marking each room,
//   • doors        — posts on a passage, red while locked,
//   • figures      — billboard icons for markers / posers / obstacles,
//   • items        — billboard icons, hidden once collected.
//
// All positions are world-engine ground coords (the embedding.layout Space3D
// also reads), so content lines up with the avatar with no offset math. This is
// the goal-tree-SPECIFIC half of the merge; the world engine stays ignorant of
// it (it only sees the generic SceneOverlay contract). Visuals are deliberately
// plain — proving the seam, not polishing the art. // TODO(phase1): nicer
// rooms/props, walls, animated door open, entity images (not just emoji).

import * as THREE from "three";
import type { SceneOverlay } from "@shared/world-engine/render3d";
import type { Layout2D } from "@shared/goal-tree/layout2d";
import { rectCenter } from "@shared/goal-tree/layout2d";
import type { LogicalWorld, FigureRole } from "@shared/goal-tree/logical-world";
import type { EntityDef } from "@shared/goal-tree/types";

/** The live state the overlay reflects each frame — supplied by the player from
 *  its Space3D + runtime state (no game logic lives here). */
export interface GoalTreeOverlayView {
  /** Item instance ids the runtime has collected. */
  removed: Record<string, true>;
  /** Passage ids the runtime has opened. */
  unlocked: Record<string, true>;
  /** Goal node ids the runtime has completed. */
  completed: Record<string, true>;
}

export interface GoalTreeOverlayDeps {
  /** Layout in world-engine coords (WorldEmbedding.layout). */
  layout: Layout2D;
  world: LogicalWorld;
  entities: Map<string, EntityDef>;
  /** Pulled once per frame in update(). */
  getView: () => GoalTreeOverlayView;
}

const ZONE_TINT: Record<string, string> = {
  start: "#1e3a5f",
  reach: "#14532d",
  collect: "#4a3b16",
  pocket: "#3b1d4a",
};

const FIGURE_Y = 1.2; // float the icon above the floor
const ITEM_Y = 0.9;
const ICON_WORLD = 1.3; // sprite size in world units

export class GoalTreeOverlay3D implements SceneOverlay {
  private readonly deps: GoalTreeOverlayDeps;
  private readonly group = new THREE.Group();
  private readonly disposables: { dispose(): void }[] = [];

  /** instanceId → sprite, toggled by `removed`. */
  private readonly itemSprites = new Map<string, THREE.Sprite>();
  /** passageId → door post, recolored/hidden by `unlocked`. */
  private readonly doorMeshes = new Map<string, THREE.Mesh>();
  /** nodeId → { sprite, role }; obstacle figures hide once completed. */
  private readonly figureSprites = new Map<
    string,
    { sprite: THREE.Sprite; role: FigureRole }
  >();

  constructor(deps: GoalTreeOverlayDeps) {
    this.deps = deps;
  }

  mount(scene: THREE.Scene): void {
    this.buildZones();
    this.buildDoors();
    this.buildFigures();
    this.buildItems();
    scene.add(this.group);
  }

  /** Reflect runtime/space state: collected items vanish, opened doors clear,
   *  cleared obstacles disappear. Pure visibility — cheap to run every frame. */
  update(_dt: number): void {
    const view = this.deps.getView();
    for (const [instanceId, sprite] of this.itemSprites) {
      sprite.visible = !view.removed[instanceId];
    }
    for (const [passageId, mesh] of this.doorMeshes) {
      const open = !!view.unlocked[passageId];
      mesh.visible = !open;
    }
    for (const [nodeId, { sprite, role }] of this.figureSprites) {
      if (role === "obstacle") sprite.visible = !view.completed[nodeId];
    }
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.itemSprites.clear();
    this.doorMeshes.clear();
    this.figureSprites.clear();
  }

  // -- builders --------------------------------------------------------------

  private buildZones(): void {
    for (const zone of this.deps.layout.zones) {
      const kind = this.deps.world.zones.find((z) => z.id === zone.zoneId)?.kind;
      const color = ZONE_TINT[kind ?? "reach"] ?? "#243042";
      const geo = new THREE.PlaneGeometry(zone.rect.w, zone.rect.h);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: 0.55,
        roughness: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2; // lay flat on the ground (XZ)
      const c = rectCenter(zone.rect);
      mesh.position.set(c.x, 0.02, c.y);
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.disposables.push(geo, mat);
    }
  }

  private buildDoors(): void {
    for (const door of this.deps.layout.doors) {
      const geo = new THREE.BoxGeometry(
        Math.max(0.3, door.rect.w),
        1.6,
        Math.max(0.3, door.rect.h),
      );
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#b91c1c") });
      const mesh = new THREE.Mesh(geo, mat);
      const c = rectCenter(door.rect);
      mesh.position.set(c.x, 0.8, c.y);
      this.group.add(mesh);
      this.doorMeshes.set(door.passageId, mesh);
      this.disposables.push(geo, mat);
    }
  }

  private buildFigures(): void {
    const roleByNode = new Map<string, FigureRole>(
      this.deps.world.figures.map((f) => [f.forNodeId, f.role]),
    );
    for (const figure of this.deps.layout.figures) {
      const icon = this.deps.entities.get(figure.entityId)?.iconRef ?? "❔";
      const sprite = this.makeIconSprite(icon);
      sprite.position.set(figure.pos.x, FIGURE_Y, figure.pos.y);
      this.group.add(sprite);
      this.figureSprites.set(figure.nodeId, {
        sprite,
        role: roleByNode.get(figure.nodeId) ?? "marker",
      });
    }
  }

  private buildItems(): void {
    for (const item of this.deps.layout.items) {
      const icon = this.deps.entities.get(item.entityId)?.iconRef ?? "❔";
      const sprite = this.makeIconSprite(icon);
      sprite.position.set(item.pos.x, ITEM_Y, item.pos.y);
      this.group.add(sprite);
      this.itemSprites.set(item.instanceId, sprite);
    }
  }

  /** A billboarded sprite showing an emoji/icon, rasterized to a small canvas
   *  texture. Sprites always face the camera, so an icon reads from any angle. */
  private makeIconSprite(icon: string): THREE.Sprite {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font = `${Math.round(size * 0.72)}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(icon, size / 2, size / 2 + size * 0.04);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(ICON_WORLD, ICON_WORLD, 1);
    sprite.renderOrder = 10;
    this.disposables.push(tex, mat);
    return sprite;
  }
}
