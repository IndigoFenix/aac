// shared/world-engine/interaction/quest/build-overlay-3d.ts
//
// WHAT BUILDING LOOKS LIKE (⑦). Two jobs, one overlay, because they are two
// halves of one conversation with the ground:
//
//   • THE OFFER — while the player holds the build word, every plot a structure
//     could rise on and every building that could grow or come down wears a
//     faint wash. Settling on one opens its menu; the wash the player is
//     settling on brightens, so what is lit is what will answer.
//
//   • THE WORK — an ordered site is no longer an anonymous rectangle waiting
//     out a clock. It climbs a ladder anyone can read at a glance: marked
//     ground while its materials gather, a FLOOR the moment builders start,
//     PILLARS halfway, and then the real walls. A demolition runs the same
//     ladder backwards. Over every site hovers the GLYPH of what it will be —
//     a bedroom, a farm — so the town's plans are legible from across it.
//
// Everything here is static matte paint: no pulsing, no motion, nothing bright
// and specular sliding across a surface (the seizure rule). A stage change is a
// rebuild, not an animation, and stages change on the pace of banked labor.
//
// Render-only. The view is pulled through a getter each frame and the meshes
// rebuild only when its signature moves — the overlay decides nothing.

import * as THREE from "three";
import type { SceneOverlay } from "../../render3d.js";
import { imageAspect, type GlyphImage } from "../../speech-bubble.js";

/** A build SPOT the player may aim at (build mode only). */
export interface BuildSpotMark {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The spot the gaze is resting on right now — lit brighter. */
  focused?: boolean;
  /** What kind of answer this ground gives: `offer` = something could RISE
   *  here (a free plot, a room-shaped gap), `thing` = something already
   *  stands here (a room, a building, work under way). Two washes, so the
   *  player can tell "you may build there" from "you may change that"
   *  without reading a menu first. Default `offer`. */
  tone?: "offer" | "thing";
}

/** An ACTIVE construction site and how far along it is. */
export interface BuildSiteMark {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 marked ground, 1 floor laid, 2 pillars up (construction.ts BuildStage). */
  stage: 0 | 1 | 2;
  /** Composed glyph of what will stand here — the hovering icon. */
  glyph?: string;
  /** The finished building's wall tint. */
  color?: string;
}

/**
 * WHY A THING ISN'T THERE YET (phase 6) — the state a ghost is drawn in. Three
 * answers, because there are exactly three things a builder can be waiting on
 * and they want different reactions from the player:
 *
 *   claimed  the material for this piece EXISTS and is spoken for — it is in
 *            the site's pile, or reserved on a hauler walking toward it.
 *            Nothing to do; it is coming.
 *   pending  the material does not exist yet, but a chain is running that will
 *            make it (trees being felled, blocks being cut). Also nothing to
 *            do — but it will take longer, and it can still fail.
 *   blocked  nothing reachable can supply this, no chain can reach it, or the
 *            floor cannot take the piece at all. THIS is the one that wants
 *            the player.
 *
 * RE-EXPORTED, not redeclared: the kernel decides the state (build-ghosts.ts
 * `paintGhosts`) and this module decides its colour, but a second copy of the
 * union here would be free to drift from the one that is actually assigned.
 */
export type { GhostState } from "../../kernel/town/build-ghosts.js";
import type { GhostState } from "../../kernel/town/build-ghosts.js";

/**
 * ONE PIECE OF A BUILDING THAT ISN'T BUILT YET, drawn in place as a faint
 * outline so a site stops being an anonymous rectangle with a clock on it.
 *
 * The set of ghosts IS THE BILL OF MATERIALS, standing where the materials
 * will go: one ghost per BAY of floor, roof and wall (block-bill.ts — the same
 * bays the cost was computed from) plus one per piece of furniture the room
 * programs want. So counting the ghosts counts the blocks, and watching them
 * turn from yellow to blue IS watching the pile fill.
 */
export interface BuildGhostMark {
  id: string;
  /** Flat bays lie on the ground/at eaves height; `wall` stands upright along
   *  its run; `furniture` is a footprint box at a placement spot. */
  kind: "floor" | "roof" | "wall" | "furniture";
  /** Centre, world. */
  x: number;
  y: number;
  /** Extent along the piece's own axes: `w` across, `h` deep (a wall's `h` is
   *  its thickness). Furniture uses its footprint diameter for both. */
  w: number;
  h: number;
  /** Rotation about the vertical, radians — a wall's run direction. */
  facing?: number;
  state: GhostState;
}

export interface BuildOverlayView {
  spots: readonly BuildSpotMark[];
  sites: readonly BuildSiteMark[];
  /** Unbuilt pieces, drawn where they will stand. Absent/empty = none. */
  ghosts?: readonly BuildGhostMark[];
}

export interface BuildOverlayDeps {
  /** Pulled once per frame. Null = nothing to draw (no build mode, no work). */
  getView: () => BuildOverlayView | null;
  /** Terrain height at a world (x, y). Omit = flat ground (y = 0). */
  groundAt?: (x: number, y: number) => number;
  /** The game's composed-glyph resolver (glyphIconFor — bare, no tone plate).
   *  Returns null while a glyph rasterizes; the icon appears when it lands. */
  glyphIconFor?: (glyph: string) => CanvasImageSource[] | null;
}

/** Wash alpha of an offered spot, and of the one being settled on. A wash,
 *  never a highlight that competes with the world. */
const SPOT_ALPHA = 0.16;
const SPOT_FOCUS_ALPHA = 0.38;
/** Ground that could TAKE something (sky) vs ground something already stands
 *  on (sand). Both matte, both static — the difference is hue, never
 *  brightness in motion. */
const SPOT_COLOR = 0x7dd3fc;
const SPOT_THING_COLOR = 0xfcd34d;
/** Ground clearance for the washes — above road ribbons (0.02) and the zone
 *  overlay's own plane sits at 0.06, so build paint reads over both. */
const SPOT_LIFT = 0.08;
const FLOOR_LIFT = 0.05;
/** Inset of a site's floor slab from its stake line, metres. */
const FLOOR_INSET = 0.45;
/** Pillar dimensions, and the longest wall run allowed without a mid post. */
const PILLAR_W = 0.36;
const PILLAR_H = 2.6;
const PILLAR_SPAN = 7;
/** How high the kind icon floats over a site — clear of the pillars. */
const ICON_Y = 3.9;
const ICON_H = 1.7;

// ── GHOSTS (phase 6) ──────────────────────────────────────────────────────
/** The three answers, as colour. Blue = on its way, amber = being made, red =
 *  nothing is coming. Each is the flat hue only — see GHOST_ALPHA for why
 *  there is no brightness variation between them. */
const GHOST_COLOR: Readonly<Record<GhostState, number>> = {
  claimed: 0x60a5fa,
  pending: 0xfbbf24,
  blocked: 0xf87171,
};
/** Faint, and EQUALLY faint in all three states. A ghost is an annotation over
 *  a working site, not a thing competing with the world for attention, and
 *  varying the alpha by state would make a starved site the brightest object
 *  on screen — precisely backwards for a red that means "come and look". Hue
 *  carries the meaning; every ghost is the same weight. */
const GHOST_ALPHA = 0.22;
/** The outline drawn round each ghost, so a lattice of translucent boxes still
 *  reads as separate pieces where they abut. */
const GHOST_EDGE_ALPHA = 0.5;
/** Storey height a wall ghost stands to, and the thickness it is drawn at
 *  (the engine's own `wallThickness`, so a ghost occupies the wall's volume). */
const GHOST_WALL_H = 3;
/** Flat bays are drawn as thin slabs rather than planes: a floor and a roof at
 *  the same footprint must be tellable apart from a low camera. */
const GHOST_SLAB_H = 0.12;
/** Ground clearance for a floor ghost, and the height a roof ghost floats at. */
const GHOST_FLOOR_LIFT = 0.1;
const GHOST_ROOF_Y = GHOST_WALL_H;
/** A furniture ghost stands about knee height — enough to read as an object
 *  rather than a paint mark, without pretending to be the piece's real shape
 *  (it is a claim on floor, and that is exactly what it draws). */
const GHOST_FURN_H = 0.7;

/** One 64×64 texture reused by every spot plane: a soft fill with a rim, so a
 *  wash reads as a marked-out PLOT rather than a coloured puddle. Stretching it
 *  across rects of different sizes only changes how thick the rim looks. */
function spotTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const S = 64;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.fillStyle = "rgba(255,255,255,0.45)";
  g.fillRect(0, 0, S, S);
  g.strokeStyle = "rgba(255,255,255,1)";
  g.lineWidth = 4;
  g.strokeRect(2, 2, S - 4, S - 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface IconEntry {
  sprite: THREE.Sprite;
  tex: THREE.Texture;
  mat: THREE.SpriteMaterial;
  /** The glyph it shows — a site whose glyph changes re-resolves. */
  glyph: string;
}

export class BuildOverlay3D implements SceneOverlay {
  private readonly deps: BuildOverlayDeps;
  private readonly group = new THREE.Group();
  private readonly spotGroup = new THREE.Group();
  private readonly siteGroup = new THREE.Group();
  private readonly ghostGroup = new THREE.Group();
  private readonly siteJunk: Array<{ dispose(): void }> = [];
  /** ONE unit cube + one wireframe, and one material per state, shared by every
   *  ghost mesh. A busy site is a hundred-odd bays; allocating geometry per bay
   *  per rebuild would cost more than everything else this overlay does. */
  private ghostShared: {
    box: THREE.BoxGeometry;
    edges: THREE.EdgesGeometry;
    fill: Record<GhostState, THREE.Material>;
    line: Record<GhostState, THREE.LineBasicMaterial>;
  } | null = null;
  private ghostSig = "";
  /** Shared wash plane + its four materials (offer / thing × lit / settled-on). */
  private spotShared: { geo: THREE.PlaneGeometry; mats: THREE.Material[] } | null = null;
  /** Kind icons, kept ACROSS site rebuilds: a glyph rasterizes asynchronously,
   *  and rebuilding its sprite every stage change would restart that wait. */
  private readonly icons = new Map<string, IconEntry>();
  private spotTex: THREE.CanvasTexture | null = null;
  private spotSig = "";
  private siteSig = "";
  /** Sites whose glyph has not resolved yet — retried each update until it
   *  does (the compose lands a frame or two after the order). */
  private pendingIcons: BuildSiteMark[] = [];

  constructor(deps: BuildOverlayDeps) {
    this.deps = deps;
    this.group.add(this.spotGroup);
    this.group.add(this.siteGroup);
    this.group.add(this.ghostGroup);
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  update(): void {
    const view = this.deps.getView();
    const spots = view?.spots ?? [];
    const sites = view?.sites ?? [];
    const ghosts = view?.ghosts ?? [];
    const spotSig = spots.map((s) => `${s.id}${s.focused ? "*" : ""}`).join("|");
    if (spotSig !== this.spotSig) {
      this.spotSig = spotSig;
      this.buildSpots(spots);
    }
    const siteSig = sites.map((s) => `${s.id}@${s.stage}~${s.glyph ?? ""}`).join("|");
    if (siteSig !== this.siteSig) {
      this.siteSig = siteSig;
      this.buildSites(sites);
    }
    // Ghosts re-key on STATE, not just identity: a bay turning from amber to
    // blue is the whole point of drawing them, and it is the only thing about a
    // ghost that ever changes without the set itself changing.
    const ghostSig = ghosts.map((g) => `${g.id}:${g.state}`).join("|");
    if (ghostSig !== this.ghostSig) {
      this.ghostSig = ghostSig;
      this.buildGhosts(ghosts);
    }
    // Late-arriving glyph rasters: ask again for the ones still missing.
    if (this.pendingIcons.length) {
      this.pendingIcons = this.pendingIcons.filter((s) => !this.placeIcon(s));
    }
  }

  dispose(): void {
    this.clearSpots();
    this.clearSites();
    this.ghostGroup.clear();
    if (this.ghostShared) {
      this.ghostShared.box.dispose();
      this.ghostShared.edges.dispose();
      for (const m of Object.values(this.ghostShared.fill)) m.dispose();
      for (const m of Object.values(this.ghostShared.line)) m.dispose();
      this.ghostShared = null;
    }
    if (this.spotShared) {
      this.spotShared.geo.dispose();
      for (const m of this.spotShared.mats) m.dispose();
      this.spotShared = null;
    }
    this.spotTex?.dispose();
    this.spotTex = null;
    this.group.parent?.remove(this.group);
  }

  private groundAt(x: number, y: number): number {
    return this.deps.groundAt?.(x, y) ?? 0;
  }

  private clearSpots(): void {
    this.spotGroup.clear(); // geometry + materials are shared — nothing to free
  }

  private clearSites(): void {
    this.siteGroup.clear();
    for (const d of this.siteJunk) d.dispose();
    this.siteJunk.length = 0;
    for (const e of this.icons.values()) {
      e.tex.dispose();
      e.mat.dispose();
    }
    this.icons.clear();
    this.pendingIcons = [];
  }

  /** The washes share ONE unit plane and FOUR materials (two tones × lit /
   *  settled-on): the set rebuilds every time the gaze crosses from one plot
   *  to the next, and that must not allocate a material per spot each time. */
  private spotAssets(): { geo: THREE.PlaneGeometry; mats: THREE.Material[] } {
    if (!this.spotTex) this.spotTex = spotTexture();
    if (!this.spotShared) {
      const mat = (color: number, opacity: number): THREE.Material =>
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          depthWrite: false,
          side: THREE.DoubleSide,
          ...(this.spotTex ? { map: this.spotTex } : {}),
        });
      this.spotShared = {
        geo: new THREE.PlaneGeometry(1, 1),
        mats: [
          mat(SPOT_COLOR, SPOT_ALPHA),
          mat(SPOT_COLOR, SPOT_FOCUS_ALPHA),
          mat(SPOT_THING_COLOR, SPOT_ALPHA),
          mat(SPOT_THING_COLOR, SPOT_FOCUS_ALPHA),
        ],
      };
    }
    return this.spotShared;
  }

  private buildSpots(spots: readonly BuildSpotMark[]): void {
    this.clearSpots();
    if (!spots.length) return;
    const { geo, mats } = this.spotAssets();
    for (const s of spots) {
      const mesh = new THREE.Mesh(geo, mats[(s.tone === "thing" ? 2 : 0) + (s.focused ? 1 : 0)]!);
      mesh.rotation.x = -Math.PI / 2;
      mesh.scale.set(s.w, s.h, 1);
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      mesh.position.set(cx, this.groundAt(cx, cy) + SPOT_LIFT, cy);
      mesh.renderOrder = 2; // over ground paint, under everything solid
      this.spotGroup.add(mesh);
    }
  }

  private buildSites(sites: readonly BuildSiteMark[]): void {
    // Icons survive the rebuild; the geometry does not.
    const keptIcons = new Map(this.icons);
    this.siteGroup.clear();
    for (const d of this.siteJunk) d.dispose();
    this.siteJunk.length = 0;
    this.icons.clear();
    this.pendingIcons = [];
    const live = new Set(sites.map((s) => s.id));
    for (const [id, e] of keptIcons) {
      if (live.has(id)) continue;
      e.tex.dispose();
      e.mat.dispose();
      keptIcons.delete(id);
    }
    for (const s of sites) {
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const baseY = this.groundAt(cx, cy);
      const tint = new THREE.Color(s.color ?? "#a08a66");
      if (s.stage >= 1) {
        // THE FLOOR — laid the moment builders start, and the last thing left
        // standing when a room comes down.
        const fw = Math.max(0.5, s.w - FLOOR_INSET * 2);
        const fh = Math.max(0.5, s.h - FLOOR_INSET * 2);
        const geo = new THREE.PlaneGeometry(fw, fh);
        const mat = new THREE.MeshStandardMaterial({
          color: tint.clone().multiplyScalar(0.72),
          roughness: 1,
          metalness: 0,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(cx, baseY + FLOOR_LIFT, cy);
        mesh.renderOrder = 1;
        this.siteGroup.add(mesh);
        this.siteJunk.push(geo, mat);
      }
      if (s.stage >= 2) {
        // THE PILLARS — corner posts first, plus a mid post wherever a wall
        // run is long enough that four corners would read as a table.
        const geo = new THREE.BoxGeometry(PILLAR_W, PILLAR_H, PILLAR_W);
        const mat = new THREE.MeshStandardMaterial({
          color: tint.clone().multiplyScalar(0.85),
          roughness: 1,
          metalness: 0,
        });
        const inset = FLOOR_INSET + PILLAR_W / 2;
        const xs = [s.x + inset, s.x + s.w - inset];
        const ys = [s.y + inset, s.y + s.h - inset];
        const posts: Array<[number, number]> = [];
        for (const px of xs) for (const py of ys) posts.push([px, py]);
        if (s.w > PILLAR_SPAN) {
          for (const py of ys) posts.push([s.x + s.w / 2, py]);
        }
        if (s.h > PILLAR_SPAN) {
          for (const px of xs) posts.push([px, s.y + s.h / 2]);
        }
        for (const [px, py] of posts) {
          const post = new THREE.Mesh(geo, mat);
          post.position.set(px, this.groundAt(px, py) + PILLAR_H / 2, py);
          this.siteGroup.add(post);
        }
        this.siteJunk.push(geo, mat);
      }
      // THE KIND ICON — kept from the previous set when the glyph is the same,
      // so a stage change never restarts its raster.
      const kept = keptIcons.get(s.id);
      if (kept && kept.glyph === (s.glyph ?? "")) {
        kept.sprite.position.set(cx, baseY + ICON_Y, cy);
        this.siteGroup.add(kept.sprite);
        this.icons.set(s.id, kept);
        keptIcons.delete(s.id);
        continue;
      }
      if (kept) {
        kept.tex.dispose();
        kept.mat.dispose();
        keptIcons.delete(s.id);
      }
      if (s.glyph && !this.placeIcon(s)) this.pendingIcons.push(s);
    }
    for (const e of keptIcons.values()) {
      e.tex.dispose();
      e.mat.dispose();
    }
  }

  /** The shared unit cube, its wireframe, and one fill + one line material per
   *  state — allocated once, reused by every ghost for the overlay's life. */
  private ghostAssets(): NonNullable<BuildOverlay3D["ghostShared"]> {
    if (!this.ghostShared) {
      const byState = <T>(make: (state: GhostState) => T): Record<GhostState, T> => ({
        claimed: make("claimed"),
        pending: make("pending"),
        blocked: make("blocked"),
      });
      // The wireframe is derived from the SAME unit cube the fill uses — the
      // two must not drift, and building it from a throwaway box would orphan
      // that box's buffers for the overlay's life.
      const box = new THREE.BoxGeometry(1, 1, 1);
      this.ghostShared = {
        box,
        edges: new THREE.EdgesGeometry(box),
        fill: byState(
          (s) =>
            new THREE.MeshBasicMaterial({
              color: GHOST_COLOR[s],
              transparent: true,
              opacity: GHOST_ALPHA,
              // No depth write, and no back faces: overlapping ghosts must not
              // punch holes in each other, and a builder standing inside the
              // footprint must stay visible through the walls that aren't
              // there yet.
              depthWrite: false,
              side: THREE.DoubleSide,
            }),
        ),
        line: byState(
          (s) =>
            new THREE.LineBasicMaterial({
              color: GHOST_COLOR[s],
              transparent: true,
              opacity: GHOST_EDGE_ALPHA,
              depthWrite: false,
            }),
        ),
      };
    }
    return this.ghostShared;
  }

  /**
   * Draw the unbuilt pieces. Each ghost is a translucent box plus its own
   * wireframe, scaled out of one shared unit cube — a plan drawn in the air at
   * the size the real thing will be.
   *
   * Static paint, like everything else in this overlay: a ghost changes colour
   * when its material arrives and never animates, so nothing on a construction
   * site pulses, sweeps or glints (the seizure rule — and a site can easily
   * hold two hundred of these at once, which is exactly the population that
   * would make a shimmer unbearable).
   */
  private buildGhosts(ghosts: readonly BuildGhostMark[]): void {
    this.ghostGroup.clear();
    if (!ghosts.length) return;
    const { box, edges, fill, line } = this.ghostAssets();
    for (const g of ghosts) {
      const h =
        g.kind === "wall" ? GHOST_WALL_H : g.kind === "furniture" ? GHOST_FURN_H : GHOST_SLAB_H;
      const base = this.groundAt(g.x, g.y);
      // Flat bays sit at their surface's own height; anything standing rests
      // its BASE on the ground, so the box is lifted by half its height.
      const y =
        g.kind === "roof"
          ? base + GHOST_ROOF_Y
          : g.kind === "floor"
            ? base + GHOST_FLOOR_LIFT
            : base + h / 2;
      const mesh = new THREE.Mesh(box, fill[g.state]);
      mesh.scale.set(Math.max(0.05, g.w), h, Math.max(0.05, g.h));
      mesh.position.set(g.x, y, g.y);
      if (g.facing) mesh.rotation.y = -g.facing;
      mesh.renderOrder = 3; // over the site's floor slab, under the kind icon
      const wire = new THREE.LineSegments(edges, line[g.state]);
      wire.scale.copy(mesh.scale);
      wire.position.copy(mesh.position);
      wire.rotation.copy(mesh.rotation);
      wire.renderOrder = 4;
      this.ghostGroup.add(mesh);
      this.ghostGroup.add(wire);
    }
  }

  /** Stand this site's kind icon, if its glyph has rasterized. False = not
   *  ready (the caller retries next frame). */
  private placeIcon(s: BuildSiteMark): boolean {
    if (!s.glyph) return true;
    const img = this.deps.glyphIconFor?.(s.glyph)?.[0];
    if (!img) return false;
    const aspect = Math.min(Math.max(imageAspect(img as GlyphImage) || 1, 0.4), 2.5);
    const tex = new THREE.Texture(img as unknown as HTMLImageElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(ICON_H * aspect, ICON_H, 1);
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    sprite.position.set(cx, this.groundAt(cx, cy) + ICON_Y, cy);
    sprite.renderOrder = 10;
    this.siteGroup.add(sprite);
    this.icons.set(s.id, { sprite, tex, mat, glyph: s.glyph });
    return true;
  }
}
