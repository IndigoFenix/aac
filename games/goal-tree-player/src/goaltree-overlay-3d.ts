// games/goal-tree-player/src/goaltree-overlay-3d.ts
//
// The goal-tree quest drawn as a SceneOverlay inside the world engine's 3D
// scene. It shares the engine's camera, ground, and lighting; it adds the
// quest's furniture (zone floors, doors, figure/item billboards) AND runs the
// symbol-learning DEMONSTRATIONS — the renderer-side half of the `observe` beat.
//
// When the runtime emits a `demonstrate` command, playDemonstration() stages the
// cue props near the observe figure and animates the cues (scale/move/spawn/
// emote/glow) in sequence, with the taught glyph floating above. The cues are a
// closed, clamped set authored in the goal-tree content (shared/goal-tree/types
// DemoCue); this file is purely how they LOOK. Everything a demonstration
// creates is transient — disposed when it finishes.
//
// All positions are world-engine ground coords (the embedding.layout Space3D
// reads), so content lines up with the avatar with no offset math.

import * as THREE from "three";
import type { SceneOverlay } from "@shared/world-engine/render3d";
import type { Layout2D } from "@shared/world-engine/solver/layout2d";
import { rectCenter } from "@shared/world-engine/solver/layout2d";
import type { LogicalWorld, FigureRole } from "@shared/world-engine/solver/logical-world";
import type { DemoCue, EntityDef } from "@shared/world-engine/solver/types";

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
  /**
   * Node ids whose poser is EMBODIED as a real world-engine NPC (capsule body +
   * icon head) — the overlay skips their floating figure sprite so the
   * character isn't drawn twice.
   */
  embodiedNodeIds?: Set<string>;
  /**
   * Item instance ids materialized as REAL world carry objects (converse props)
   * — the overlay skips their floating sprite so the item isn't drawn twice.
   */
  skipInstanceIds?: Set<string>;
  /**
   * How a LOCKED passage is marked. "box" (default) draws the classic red slab
   * across the doorway. "badge" floats a padlock sprite instead — used when the
   * world has real building doors (the engine renders the physical leaf; the
   * slab would z-fight it).
   */
  doorStyle?: "box" | "badge";
}

/** The fields of a runtime `demonstrate` command the runner needs. */
export interface DemonstrateCommand {
  nodeId: string;
  targetGlyph: string;
  contrastGlyph?: string;
  cues: DemoCue[];
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

// Demonstration tuning.
const CUE_SECONDS = 1.3; // default per-cue duration
const DEMO_LINGER = 1.6; // hold the final state + glyph before clearing
const PROP_Y = 1.35; // height of demonstration props
const PROP_GAP = 1.9; // spacing between distinct props

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

interface AnimProp {
  base: THREE.Vector3;
  baseScale: number;
  primary: THREE.Sprite;
}

interface DemoStep {
  cue: DemoCue;
  start: number;
  duration: number;
  prop: AnimProp;
  /** Cue-specific transient sprites (spawn copies / emote badge / glow halo). */
  extras: THREE.Sprite[];
}

interface DemoRun {
  elapsed: number;
  total: number;
  steps: DemoStep[];
  objects: THREE.Object3D[];
  disposables: { dispose(): void }[];
}

export class GoalTreeOverlay3D implements SceneOverlay {
  private readonly deps: GoalTreeOverlayDeps;
  private readonly group = new THREE.Group();
  private readonly disposables: { dispose(): void }[] = [];

  private readonly itemSprites = new Map<string, THREE.Sprite>();
  private readonly doorMeshes = new Map<string, THREE.Object3D>();
  private readonly figureSprites = new Map<
    string,
    { sprite: THREE.Sprite; role: FigureRole }
  >();

  /** Active demonstrations, advanced in update(). */
  private readonly runs: DemoRun[] = [];

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

  update(dt: number): void {
    const view = this.deps.getView();
    for (const [instanceId, sprite] of this.itemSprites) {
      sprite.visible = !view.removed[instanceId];
    }
    for (const [passageId, mesh] of this.doorMeshes) {
      mesh.visible = !view.unlocked[passageId];
    }
    for (const [nodeId, { sprite, role }] of this.figureSprites) {
      if (role === "obstacle") sprite.visible = !view.completed[nodeId];
    }
    this.advanceRuns(dt);
  }

  dispose(): void {
    for (const run of this.runs) this.disposeRun(run);
    this.runs.length = 0;
    this.group.parent?.remove(this.group);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.itemSprites.clear();
    this.doorMeshes.clear();
    this.figureSprites.clear();
  }

  // -- demonstration runner ---------------------------------------------------

  /** Stage and play an observe beat's demonstration near its figure. */
  playDemonstration(cmd: DemonstrateCommand): void {
    const stage = this.deps.layout.figures.find((f) => f.nodeId === cmd.nodeId);
    if (!stage) return;
    const center = new THREE.Vector3(stage.pos.x, PROP_Y, stage.pos.y);

    const objects: THREE.Object3D[] = [];
    const disposables: { dispose(): void }[] = [];

    // One prop per distinct cue entity, laid out in a row over the stage.
    const propIds = [...new Set(cmd.cues.map((c) => c.entityId))];
    const props = new Map<string, AnimProp>();
    propIds.forEach((entityId, i) => {
      const icon = this.deps.entities.get(entityId)?.iconRef ?? "❔";
      const sprite = this.makeIconSpriteInto(icon, disposables);
      const base = new THREE.Vector3(
        center.x + (i - (propIds.length - 1) / 2) * PROP_GAP,
        center.y,
        center.z,
      );
      sprite.position.copy(base);
      this.group.add(sprite);
      objects.push(sprite);
      props.set(entityId, { base, baseScale: ICON_WORLD, primary: sprite });
    });

    // Sequence the cues; each carries its own transient sprites.
    const steps: DemoStep[] = [];
    let cursor = 0;
    for (const cue of cmd.cues) {
      const prop = props.get(cue.entityId)!;
      const duration =
        (cue.kind === "scale" || cue.kind === "move") && cue.seconds
          ? cue.seconds
          : CUE_SECONDS;
      const extras = this.buildCueExtras(cue, prop, disposables);
      for (const e of extras) {
        this.group.add(e);
        objects.push(e);
      }
      steps.push({ cue, start: cursor, duration, prop, extras });
      cursor += duration;
    }

    // The glyph CAPTION is drawn by the engine's unified world bubble (the player
    // calls showWorldBubble over the stage) — not here — so it uses the same path
    // as character/remote speech. The overlay only animates the cue props.
    this.runs.push({ elapsed: 0, total: cursor, steps, objects, disposables });
  }

  /** Pre-create a cue's transient sprites (revealed by opacity in advanceRuns). */
  private buildCueExtras(
    cue: DemoCue,
    prop: AnimProp,
    sink: { dispose(): void }[],
  ): THREE.Sprite[] {
    switch (cue.kind) {
      case "spawn": {
        const out: THREE.Sprite[] = [];
        const icon = this.deps.entities.get(cue.entityId)?.iconRef ?? "❔";
        for (let i = 1; i < cue.count; i++) {
          const s = this.makeIconSpriteInto(icon, sink);
          const ang = (i / cue.count) * Math.PI * 2;
          s.position.set(
            prop.base.x + Math.cos(ang) * 1.1,
            prop.base.y,
            prop.base.z + Math.sin(ang) * 1.1,
          );
          s.scale.setScalar(prop.baseScale);
          (s.material as THREE.SpriteMaterial).opacity = 0;
          out.push(s);
        }
        return out;
      }
      case "emote": {
        const badge = this.makeIconSpriteInto(cue.emotion === "happy" ? "😊" : "😢", sink);
        badge.position.set(prop.base.x + 0.5, prop.base.y + 0.9, prop.base.z);
        badge.scale.setScalar(0.8);
        (badge.material as THREE.SpriteMaterial).opacity = 0;
        return [badge];
      }
      case "glow": {
        const halo = this.makeHaloSpriteInto(cue.tone, sink);
        halo.position.copy(prop.base);
        (halo.material as THREE.SpriteMaterial).opacity = 0;
        return [halo];
      }
      default:
        return [];
    }
  }

  private advanceRuns(dt: number): void {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const run = this.runs[i];
      run.elapsed += dt;

      // Every step every frame, with a clamped local progress: finished steps
      // hold their final state, pending ones hold their initial state.
      for (const step of run.steps) {
        const t = smooth((run.elapsed - step.start) / step.duration);
        this.applyStep(step, t);
      }

      if (run.elapsed >= run.total + DEMO_LINGER) {
        this.disposeRun(run);
        this.runs.splice(i, 1);
      }
    }
  }

  private applyStep(step: DemoStep, t: number): void {
    const { cue, prop } = step;
    switch (cue.kind) {
      case "scale": {
        const s = prop.baseScale * (1 + (cue.to - 1) * t);
        prop.primary.scale.set(s, s, 1);
        break;
      }
      case "move":
        prop.primary.position.set(
          prop.base.x + cue.dx * t,
          prop.base.y,
          prop.base.z + cue.dy * t,
        );
        break;
      case "spawn":
        step.extras.forEach((s, idx) => {
          (s.material as THREE.SpriteMaterial).opacity = Math.min(1, Math.max(0, t * cue.count - (idx + 1)));
        });
        break;
      case "emote":
      case "glow":
        if (step.extras[0]) (step.extras[0].material as THREE.SpriteMaterial).opacity = t;
        break;
    }
  }

  private disposeRun(run: DemoRun): void {
    for (const o of run.objects) this.group.remove(o);
    for (const d of run.disposables) d.dispose();
  }

  // -- static builders --------------------------------------------------------

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
      const c = rectCenter(door.rect);
      if (this.deps.doorStyle === "badge") {
        // Real building doors exist — just float a padlock over a locked one,
        // above the roofline (3 m walls + lintel would occlude it lower down).
        const badge = this.makeIconSprite("🔒");
        badge.scale.set(0.9, 0.9, 1);
        badge.position.set(c.x, 3.6, c.y);
        this.group.add(badge);
        this.doorMeshes.set(door.passageId, badge);
        continue;
      }
      const geo = new THREE.BoxGeometry(
        Math.max(0.3, door.rect.w),
        1.6,
        Math.max(0.3, door.rect.h),
      );
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color("#b91c1c") });
      const mesh = new THREE.Mesh(geo, mat);
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
      if (this.deps.embodiedNodeIds?.has(figure.nodeId)) continue;
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
      if (this.deps.skipInstanceIds?.has(item.instanceId)) continue;
      const icon = this.deps.entities.get(item.entityId)?.iconRef ?? "❔";
      const sprite = this.makeIconSprite(icon);
      sprite.position.set(item.pos.x, ITEM_Y, item.pos.y);
      this.group.add(sprite);
      this.itemSprites.set(item.instanceId, sprite);
    }
  }

  // -- sprite factories -------------------------------------------------------

  private makeIconSprite(icon: string): THREE.Sprite {
    return this.makeIconSpriteInto(icon, this.disposables);
  }

  /** A billboarded sprite showing an emoji/icon, rasterized to a canvas texture.
   *  `sink` owns the GPU resources (the overlay's, or a transient run's). */
  private makeIconSpriteInto(icon: string, sink: { dispose(): void }[]): THREE.Sprite {
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
    sink.push(tex, mat);
    return sprite;
  }

  /** A soft warm/cool radial halo (hot/cold). */
  private makeHaloSpriteInto(
    tone: "warm" | "cool",
    sink: { dispose(): void }[],
  ): THREE.Sprite {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const rgb = tone === "warm" ? "255,170,60" : "120,180,255";
      const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
      grad.addColorStop(0, `rgba(${rgb},0.9)`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.6, 2.6, 1);
    sprite.renderOrder = 9; // behind the prop
    sink.push(tex, mat);
    return sprite;
  }
}
