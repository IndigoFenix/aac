/**
 * The symbol game in the lab, played through the shared quest host
 * (shared/symbol-game/quest-host). Two entry points share one stage scaffold:
 *   • bootLivingTown — the town scope: a real createTownWorld economy whose
 *     residents are the quest-givers and stream around a WALKING avatar.
 *   • bootStructure  — the structure scope: a freestanding creature-quest
 *     puzzle (buildCreatureQuestWorld). With avatar "spirit" it plays as the
 *     stationary, formless puzzle mode — dwell on things to pick/place/talk, no
 *     walking.
 *
 * Unlike every map scope (rendered into the lab's own orbit scene), the quest
 * host hands its own canvas to the world engine and answers conversations on the
 * REAL response board — the shared `BoardButtonVisual`, mounted as a small React
 * island (board-island.tsx), pixel-identical to the student's board.
 */
import { avatarKind, type LoadedWorld } from "@shared/world-engine/kernel/manifest";
import {
  DOLLHOUSE_SCALE, resolveWorldScale, type WorldScale, type WorldScaleSpec,
} from "@shared/world-engine/scale";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import { createWalkChart } from "@shared/world-engine/planet/walk-chart";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play";
import { clusterStages, widenSpecWindow } from "@shared/world-engine/interaction/town/town-cluster";
import { buildTownScope } from "@shared/world-engine/interaction/town/town-play-game";
import type { TownPlay } from "@shared/world-engine/interaction/town/town-play";
import {
  buildCreatureQuestWorld,
  certifyCreatureQuestWorld,
  type CreatureWorldParams,
} from "@shared/world-engine/interaction/quest/creature-quests";
import * as THREE from "three";
import {
  createQuestHost3D,
  type QuestBoardView,
  type QuestHost3D,
  type QuestSession,
} from "@shared/world-engine/interaction/quest/quest-host";
import type { WildernessParams } from "@shared/world-engine/interaction/quest/wilderness";
import { PLAYER_ID } from "@shared/world-engine/solver/space3d";
import type { RenderHost } from "@shared/world-engine/render3d";
import {
  createSpiritLadder, type SpiritLadder, type SpiritLadderOpts,
} from "@shared/world-engine/spirit/ladder";
import {
  createFlatSpiritProvider, FLAT_TOWN_REF,
} from "@shared/world-engine/spirit/flat-provider";
import type { SpiritLevel } from "@shared/world-engine/spirit/frame-provider";
import type { GoalTreeGame } from "@shared/world-engine/solver/types";
import type { ObjectiveSummary } from "@shared/world-engine/solver/space";
import type { GoalNode } from "@shared/world-engine/solver/types";
import { labImageResolver } from "./glyph-resolver";
import { mulberry, WILD_SIDE, type WildFauna } from "./wilderness-boot";
import type { BoardIsland } from "./board-island";

export interface QuestBoot {
  dispose(): void;
}

/** The session scale a lab ground world runs: its document's `game.scale`
 *  declaration, else the street-clock DOLLHOUSE profile — the town/structure
 *  machinery (goods.ts street schedules) is paced to that 240 s day, so the
 *  lab's ground worlds keep it unless a document says otherwise. The ENGINE
 *  default stays realism (space-time-compression.md §1). */
function labSessionScale(spec: WorldScaleSpec | null | undefined): WorldScale {
  return spec ? resolveWorldScale(spec) : DOLLHOUSE_SCALE;
}

/** The lab's ONE button board — the AAC's own chrome, a top-level sibling of
 *  the viewscreen, mounted ONCE at startup and ALWAYS visible (blank when the
 *  current scope offers nothing to press). Game boots never mount or tear it
 *  down; they CLAIM it (routing its taps to themselves) and release on dispose.
 *  Mirrors the real AAC: the game loads in the game window, the board stays in
 *  the sidebar/footer regardless. */
export interface SharedBoard {
  island: BoardIsland;
  /** Route the board's user actions to this host; returns a release fn that
   *  also blanks the board (only if this claim is still the active one). */
  claim(handlers: BoardHandlers): () => void;
}

export interface BoardHandlers {
  select(id: string): void;
  speak(sentence: string): void;
  selectPocket(entityId: string): void;
  selectFamilyMember(memberId: string): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
};

/** The objective chip's face — a compact port of the player's ObjectivesBar. */
function objectiveEmoji(node: GoalNode | undefined, icon: (id: string) => string): string {
  switch (node?.type) {
    case "reach": return icon(node.markerEntityId);
    case "collect": return icon(node.itemEntityIds[0]!);
    case "choose": return `${icon(node.posedByEntityId)}❓`;
    case "overcome": return icon(node.obstacleEntityId);
    case "observe": return `${icon(node.stageEntityId)}👁`;
    case "transport": return `${icon(node.objectEntityId)}📦`;
    case "converse": return `${icon(node.npcEntityId)}💬`;
    case "fulfill":
      return `${icon(node.npcEntityId)}${node.needItemEntityId ? icon(node.needItemEntityId) : "💬"}`;
    default: return "❔";
  }
}

interface QuestStartOpts {
  /** A living-town session (its residents stream in), or null for a
   *  freestanding structure puzzle. */
  town?: TownPlay | null;
  /** SPIRIT avatar — stationary, formless, gaze-only interaction. */
  spirit?: boolean;
  /** DOLLHOUSE — the focused house index (`initial_focus` resolved): Sims-mode
   *  motives for its members, direct obedience. Undefined = the village square. */
  dollhouse?: number;
  /** IRREGULAR GROUND — terrain sampler the session is placed on. */
  groundAt?: (x: number, y: number) => number;
  /** WATER — impassable to walkers/NPCs (the engine's terrain gate). */
  waterAt?: (x: number, y: number) => boolean;
  /** WILDERNESS (founding flow): scatter resource features + possessable
   *  creatures over open ground (quest-host seedWilderness). */
  wilderness?: WildernessParams;
  /** SPACE-TIME COMPRESSION for the session (space-time-compression.md).
   *  Omitted = the engine's realism default. */
  scale?: WorldScale;
  /** CULTURAL LAW (`game.culture` — nations P2): the world's universal
   *  absolute taboos found the session's law ring. */
  culture?: import("@shared/world-engine/culture").WorldCultureSpec | null;
  /** Status-line detail (build stats). */
  detail: string;
  /** THE SPIRIT LADDER over this standalone world (the unified spirit —
   *  town orbit / ground glide / structure dollhouse — replacing the host's
   *  stationary camera; the host keeps sim + interaction, the ladder owns
   *  the camera via setExternalCamera). */
  ladder?: {
    scopeLevel: "town" | "structure";
    /** Town metrics (town scope); omitted = derived from the world spec. */
    townMetrics?: { centre: { x: number; z: number }; radius: () => number };
    /** Start focused on this building frame (SIM coords) — the standalone
     *  dollhouse; the initial ceiling is then "structure". */
    focusFrame?: { x: number; y: number; w: number; h: number } | null;
  };
}

/** Mount the quest host + the real response board in the lab and start `game`.
 *  Shared by the living-town and structure boots. */
function bootQuestGame(
  container: HTMLElement,
  game: GoalTreeGame,
  setStatus: (text: string) => void,
  opts: QuestStartOpts,
  sharedBoard: SharedBoard,
): QuestBoot {
  // ── DOM scaffold: the stage (canvas + overlays). The button board is NOT
  //    part of this scaffold — it is the lab's persistent top-level chrome
  //    (SharedBoard); this boot just claims it. ──────────────────────────────
  const root = el("div", "quest-root", container);
  const stage = el("div", "quest-stage", root);
  const canvas = el("canvas", "quest-canvas", stage);
  const objectivesEl = el("div", "quest-objectives", stage);
  const satchelEl = el("div", "quest-satchel", stage);
  const toastEl = el("div", "quest-toast", stage);
  const winEl = el("div", "quest-win", stage);
  toastEl.hidden = true;
  winEl.hidden = true;

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let session: QuestSession | null = null;
  let host: QuestHost3D | null = null;

  // The REAL board (shared BoardButtonVisual) + footer (Yes/No/More/Speak). Board
  // taps drive the host; the footer + Speak menu send composed sentences to the host,
  // which parses them and drives the target creature (rule/command).
  const board: BoardIsland = sharedBoard.island;
  const releaseBoard = sharedBoard.claim({
    select: (id) => host?.select(id),
    speak: (sentence) => host?.speak(sentence),
    selectPocket: (entityId) => host?.selectPocket(entityId),
    selectFamilyMember: (memberId) => host?.selectFamilyMember(memberId),
  });
  const iconOf = (id: string) => session?.entities.get(id)?.iconRef ?? "❔";

  const presenter = {
    sessionStarted(s: QuestSession) {
      session = s;
      board.set(null);
      board.setNouns([]);
      winEl.hidden = true;
      objectivesEl.textContent = "";
      satchelEl.textContent = "";
      board.setPocket([]);
      board.setFamily([]);
      board.setCity([]);
    },
    board(view: QuestBoardView) { board.set(view); },
    nouns(list: { symbol: string; label: string }[]) { board.setNouns(list); },
    pocket(items: Parameters<BoardIsland["setPocket"]>[0]) { board.setPocket(items); },
    family(members: Parameters<BoardIsland["setFamily"]>[0]) { board.setFamily(members); },
    city(chips: Parameters<BoardIsland["setCity"]>[0]) { board.setCity(chips); },
    clearBoard() { board.set(null); },
    toast(text: string) {
      toastEl.textContent = text;
      toastEl.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
    },
    objectives(objectives: ObjectiveSummary[]) {
      objectivesEl.textContent = "";
      for (const o of objectives) {
        const chip = el("span", `quest-chip${o.locked ? " locked" : ""}`, objectivesEl);
        const node = session?.ctx.nodeById.get(o.nodeId);
        chip.textContent = `${objectiveEmoji(node, iconOf)}${o.locked ? "🔒" : ""}`;
      }
    },
    collect() { /* the objectives strip is enough for the lab */ },
    satchel(inventory: Record<string, number>) {
      const held = Object.entries(inventory).filter(([, n]) => n > 0);
      satchelEl.textContent = held.length
        ? `🎒 ${held.map(([id, n]) => `${iconOf(id)}${n > 1 ? `×${n}` : ""}`).join(" ")}`
        : "";
    },
    won() {
      winEl.textContent = "";
      winEl.hidden = false;
      const burst = el("div", "quest-win-burst", winEl);
      burst.textContent = "🎉";
      const title = el("div", "quest-win-title", winEl);
      title.textContent = session?.game.root.outro ?? session?.game.meta.title ?? "You did it!";
      const replay = el("button", "quest-replay", winEl);
      replay.textContent = "🔁 Play again";
      replay.addEventListener("click", () => host?.replay());
    },
  };

  let ladder: SpiritLadder | null = null;
  const ladderPtr = { x: 0, y: 0, clientX: 0, clientY: 0, inside: false };
  // POSSESSION: while the spirit rides a creature, the HOST owns camera +
  // pointer (an ordinary walker); the ladder idles until dismissal drops it
  // back to the ground rung over the avatar.
  let possessedNow = false;
  const _focus = new THREE.Vector3();

  host = createQuestHost3D({
    canvas, presenter, resolveImage: labImageResolver,
    ...(opts.groundAt ? { groundAt: opts.groundAt } : {}),
    ...(opts.waterAt ? { waterAt: opts.waterAt } : {}),
    // The spirit ladder is a GUEST of the host's own frame: sim ticks, then
    // the ladder poses the camera (setExternalCamera), then the view draws.
    onFrame: (dt) => {
      if (!ladder) return;
      if (possessedNow) {
        setStatus(`AVATAR — you are ${host?.possessed ?? "?"} · walk with the mouse · Speak "stop" to let go · "build" to found`);
        return;
      }
      const res = ladder.step(ladderPtr.inside ? ladderPtr : null, dt, performance.now());
      // GROUND rung: the glide is a live interlocutor — forward the pointer to
      // the host so gaze-hover conversation/containers work mid-glide (the
      // structure rung forwards from inside the ladder; town/flight keep the
      // host pointer clear so an orbit dwell never doubles as an interaction).
      if (ladder.level === "ground") {
        if (ladderPtr.inside) host?.setPointer(ladderPtr.clientX, ladderPtr.clientY);
        else host?.clearPointer();
      } else if (ladder.level === "town" || ladder.level === "flight") {
        host?.clearPointer();
      }
      // Feed the spirit's hover position to the host (distance rules — e.g.
      // abandoning an empty site — see the SPIRIT, not the parked walker).
      if (ladder.focusWorld(_focus)) host?.setSpiritPosition(_focus.x, _focus.z);
      // DIAGNOSTIC readout at the ground/structure rungs (compare against
      // the planet path's identical line while diagnosing the dollhouse).
      setStatus(
        ladder.level === "ground" || ladder.level === "structure"
          ? `${res.status} ‖ ${host?.debugProbe() ?? ""}`
          : res.status,
      );
    },
    onPossession: (cid) => {
      possessedNow = cid !== null;
      if (cid !== null) {
        // The host's chase rig takes the camera; its pointer is the walker's gaze.
        host?.setExternalCamera(false);
      } else {
        host?.setExternalCamera(true);
        // Resume the spirit at the GROUND rung over the dismissed avatar —
        // WITH the flat town ref, so the glide can still enter buildings
        // (footprint possession) and the bottom dwell ascends to the
        // district orbit instead of a ceiling-blocked "flight".
        const p = host?.world?.state.avatars[PLAYER_ID];
        if (ladder && p) {
          const gy = opts.groundAt?.(p.x, p.y) ?? 0;
          ladder.dropToGround(_focus.set(p.x, gy, p.y), FLAT_TOWN_REF);
        }
      }
    },
    onSiteFounded: (site) => {
      // Re-centre the spirit view on the new site: a fresh town-rung ladder
      // whose orbit frames the founding point.
      if (!opts.ladder || !host) return;
      possessedNow = false;
      host.setExternalCamera(true);
      ladder?.dispose();
      ladder = mountLadder(
        { x: site.at.x, z: site.at.y },
        () => 80,
        { level: "town", town: FLAT_TOWN_REF },
        "town",
      );
      presenter.toast(`⛺ ${site.key} founded — the spirit centres on it`);
    },
    onSiteAbandoned: () => {
      // Nothing to re-centre — the ladder already hovers wherever the player
      // wandered; the site record + crate are gone (materials spilled).
    },
  });
  host.start(game, opts.town ?? null, {
    spirit: opts.spirit,
    ...(opts.dollhouse !== undefined ? { dollhouse: opts.dollhouse } : {}),
    ...(opts.wilderness ? { wilderness: opts.wilderness } : {}),
    ...(opts.scale ? { scale: opts.scale } : {}),
    ...(opts.culture ? { culture: opts.culture } : {}),
  });
  (window as unknown as Record<string, unknown>).__questLab = host;

  // Pointer-as-gaze: the mouse is the gaze. A walker steers toward it; a spirit
  // just looks (the host ignores steering in stationary mode). Under the
  // LADDER, the raw pointer feeds the ladder instead — it forwards to the
  // host itself only at the structure rung (interaction) and the ground glide,
  // so an orbit dwell never doubles as a host interaction dwell. A POSSESSED
  // avatar is an ordinary walker: the pointer goes straight to the host.
  const onMove = (e: PointerEvent) => {
    if (opts.ladder && !possessedNow) {
      const r = canvas.getBoundingClientRect();
      ladderPtr.x = e.clientX - r.left;
      ladderPtr.y = e.clientY - r.top;
      ladderPtr.clientX = e.clientX;
      ladderPtr.clientY = e.clientY;
      ladderPtr.inside = true;
    } else host?.setPointer(e.clientX, e.clientY);
  };
  const onLeave = () => {
    if (opts.ladder && !possessedNow) ladderPtr.inside = false;
    else host?.clearPointer();
  };
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerleave", onLeave);

  /** Create a flat-provider spirit ladder over this host (the initial mount,
   *  and the FOUNDING re-mount centred on a new site). */
  function mountLadder(
    centre: { x: number; z: number },
    radius: () => number,
    start: SpiritLadderOpts["start"],
    ceiling: SpiritLevel,
  ): SpiritLadder {
    const h = host!;
    const lots = (): readonly { x: number; y: number; w: number; h: number }[] =>
      (h.world?.state.spec.buildings ?? []).map((b) => b.footprint);
    const provider = createFlatSpiritProvider({
      scopeLevel: opts.ladder!.scopeLevel,
      label: game.meta.title,
      host: h,
      placeGazeAvatar: (x, y) => {
        const p = h.world?.state.avatars[PLAYER_ID];
        if (p) { p.x = x; p.y = y; p.vx = 0; p.vy = 0; }
      },
      viewSize: () => ({ w: canvas.clientWidth || 1, h: canvas.clientHeight || 1 }),
      centre,
      radius,
      ...(opts.groundAt ? { ground: opts.groundAt } : {}),
      lots,
    });
    const l = createSpiritLadder({ provider, ceiling, start });
    (window as unknown as Record<string, unknown>).__spiritLadder = l;
    return l;
  }

  if (opts.ladder) {
    const h = host;
    h.setExternalCamera(true); // the ladder owns the camera from here on
    const spec = h.world?.state.spec;
    const centre = opts.ladder.townMetrics?.centre
      ?? { x: (spec?.manifold.width ?? 100) / 2, z: (spec?.manifold.height ?? 100) / 2 };
    const radius = opts.ladder.townMetrics?.radius
      ?? ((): number => Math.max(spec?.manifold.width ?? 100, spec?.manifold.height ?? 100) / 2);
    const lots = (): readonly { x: number; y: number; w: number; h: number }[] =>
      (h.world?.state.spec.buildings ?? []).map((b) => b.footprint);
    let start: SpiritLadderOpts["start"];
    let ceiling: SpiritLevel;
    const clampR = (v: number): number => Math.max(6, Math.min(60, v));
    if (opts.ladder.focusFrame) {
      const f = opts.ladder.focusFrame;
      start = {
        level: "structure", town: FLAT_TOWN_REF,
        target: {
          kind: "building",
          x: f.x + f.w / 2 - centre.x,
          z: f.y + f.h / 2 - centre.z,
          radius: clampR((Math.max(f.w, f.h) / 2) * 1.8),
          frame: f,
        },
      };
      ceiling = "structure";
    } else if (opts.ladder.scopeLevel === "structure") {
      // The whole-structure dollhouse: frame the bounds of every building.
      const ls = lots();
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const l of ls) {
        minX = Math.min(minX, l.x); minZ = Math.min(minZ, l.y);
        maxX = Math.max(maxX, l.x + l.w); maxZ = Math.max(maxZ, l.y + l.h);
      }
      const frame = Number.isFinite(minX)
        ? { x: minX, y: minZ, w: maxX - minX, h: maxZ - minZ }
        : { x: centre.x - 10, y: centre.z - 10, w: 20, h: 20 };
      start = {
        level: "structure", town: FLAT_TOWN_REF,
        target: {
          kind: "building",
          x: frame.x + frame.w / 2 - centre.x,
          z: frame.y + frame.h / 2 - centre.z,
          radius: clampR(Math.max(frame.w, frame.h) / 2 * 1.2),
          frame,
        },
      };
      ceiling = "structure";
    } else {
      start = { level: "town", town: FLAT_TOWN_REF };
      ceiling = "town";
    }
    ladder = mountLadder(centre, radius, start, ceiling);
  }

  const ro = new ResizeObserver(() => {
    host?.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
  });
  ro.observe(canvas);

  const hint =
    opts.spirit && opts.wilderness
      ? 'WILDERNESS SPIRIT — glide to a creature, dwell to talk, Speak "you follow i_me" to become it; gather wood/stone from trees/rocks; Speak "build" to found a site'
      : opts.spirit && opts.dollhouse !== undefined
        ? "SPIRIT DOLLHOUSE — watch the family's chips, dwell to talk/gift, chip + Speak to command"
        : opts.spirit
          ? "SPIRIT — no walking: look at an item to pick it up / put it down, look at someone to talk"
          : opts.dollhouse
            ? "DOLLHOUSE — you're home with the family: watch them live, talk, gift, command (they obey)"
            : "walk with the mouse, dwell on a resident to talk";
  setStatus(`${game.meta.title} · ${opts.detail} · ${hint}`);

  return {
    dispose() {
      ro.disconnect();
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
      ladder?.dispose();
      ladder = null;
      host?.stop();
      host = null;
      releaseBoard(); // blank + un-route the persistent board (never unmount it)
      delete (window as unknown as Record<string, unknown>).__questLab;
      delete (window as unknown as Record<string, unknown>).__spiritLadder;
      root.remove();
    },
  };
}

/** The TOWN scope: a living town whose residents are the quest-givers. An
 *  `initial_focus` naming a HOUSE ("house:<index>" or { type: "house" }) plays
 *  as the DOLLHOUSE — the game opens inside that household (Sims-mode motives,
 *  direct obedience) while the whole town keeps living around it. */
export function bootLivingTown(
  container: HTMLElement,
  loaded: LoadedWorld,
  setStatus: (text: string) => void,
  board: SharedBoard,
): QuestBoot {
  const t0 = performance.now();
  const built = buildTownScope(loaded.game!);
  // ── THE WALKING WINDOW ──────────────────────────────────────────────────
  // `cluster: N` streams N neighbor hamlets into the SAME session (the
  // window on the chart goes beyond one town): each neighbor is a full
  // living town at a walkable offset, its stage translated + merged with
  // the primary's (town-cluster.ts). The primary keeps quests/cast/goods.
  let play = built.play;
  let windowShift = { x: 0, y: 0 }; // primary-town coords → window coords
  const clusterN = Math.max(0, Math.min(4, Math.floor(built.spec.config.cluster ?? 0)));
  if (clusterN > 0) {
    const WINDOW = 4000; // metres — a comfortable walking window
    const primaryAt = { x: WINDOW * 0.35, y: WINDOW * 0.35 };
    windowShift = {
      x: primaryAt.x - built.play.stage.center.x,
      y: primaryAt.y - built.play.stage.center.y,
    };
    // Deterministic hamlet ring, ~1.1-1.7 km out — demo-walkable (REAL
    // region spacing is a day's walk; the window is the mechanism, the
    // distances are content).
    const neighbors = [];
    for (let i = 0; i < clusterN; i++) {
      const nPlay = buildTownPlay({
        seed: built.spec.config.seed + 101 + i * 37,
        key: `hamlet-${i + 1}`,
        startPop: 60,
        days: 160,
        questCount: 0,
      });
      const ang = (i / clusterN) * Math.PI * 1.4 + 0.4;
      const r = 1100 + 300 * i;
      neighbors.push({
        stage: nPlay.stage,
        at: { x: primaryAt.x + Math.cos(ang) * r, y: primaryAt.y + Math.sin(ang) * r },
        tag: `n${i + 1}`,
        // Reserved house range → neighbor residents keep the resident id
        // PROTOCOL, so the host's dialogue layer gives them real minds.
        houseBase: 1000 * (i + 1),
        // Its live context — the composite stage resolves a neighbor
        // resident's OWN books/geometry through it (TownStage.cluster).
        play: nPlay,
      });
    }
    const windowSpec = widenSpecWindow(
      built.play.stage.spec, built.play.stage.center, primaryAt, WINDOW, WINDOW,
    );
    const composite = clusterStages(
      windowSpec,
      { stage: built.play.stage, at: primaryAt, tag: "t0" },
      neighbors,
    );
    // TRAVEL COST becomes REAL: bind the caravan line to the NEAREST hamlet —
    // the gate re-aims toward it and the rare import scales by true distance.
    // Coordinates: the trade geometry lives in the PRIMARY's own frame (its
    // caravan streams through the primary's offset frame), so the partner
    // binds in that frame; only the DEPOT anchor — which the host reads
    // directly for the crates — is lifted into window coordinates.
    const tr = composite.trade;
    if (tr && neighbors.length) {
      const nearest = neighbors.reduce((a, b) =>
        Math.hypot(a.at.x - primaryAt.x, a.at.y - primaryAt.y) <=
        Math.hypot(b.at.x - primaryAt.x, b.at.y - primaryAt.y)
          ? a
          : b,
      );
      tr.bindPartner({
        key: nearest.play?.config.key ?? nearest.tag,
        at: { x: nearest.at.x - windowShift.x, y: nearest.at.y - windowShift.y },
      });
      composite.trade = {
        ...tr,
        depot: { x: tr.depot.x + windowShift.x, y: tr.depot.y + windowShift.y },
      };
    }
    play = { ...built.play, stage: composite };
  }

  // The session's ground: "hills" = deterministic rolling relief;
  // "planet" = REAL terrain — the earthlike world is baked, its best site
  // charted (walk-chart), and the town stands on that exact hillside.
  // (The sim stays plan-view 2D either way — the engine's ground seam.)
  // Window coords shift back to primary-town coords before sampling, so the
  // chart anchor stays the primary plaza.
  const rawGround = built.spec.config.terrain === "hills"
    ? { groundAt: rollingHills(built.spec.config.seed), waterAt: undefined }
    : built.spec.config.terrain === "planet"
      ? planetSiteGround(built.spec.config.seed)
      : undefined;
  const groundAt = rawGround
    ? (x: number, y: number) => rawGround.groundAt(x - windowShift.x, y - windowShift.y)
    : undefined;
  const waterAt = rawGround?.waterAt
    ? (x: number, y: number) => rawGround.waterAt!(x - windowShift.x, y - windowShift.y)
    : undefined;
  const detail =
    `${built.focus ? `dollhouse (house ${built.focus.house}) · ` : ""}town · seed ${built.spec.config.seed} · day ${built.play.town.day} · ` +
    `pop ${Math.round(built.play.town.scalar("population"))} · ${built.play.bundle.cast.length} residents · ` +
    `${clusterN ? `${clusterN} neighbor hamlets · ` : ""}${groundAt ? "hillside · " : ""}certified · ${Math.round(performance.now() - t0)}ms`;
  const isSpirit = avatarKind(loaded.game) === "spirit";
  // The UNIFIED SPIRIT: a spirit town rides the same ladder as a planet's
  // town (orbit → dwell → dollhouse, ground glide) over the flat provider;
  // an initial_focus house starts (and initially caps) at the dollhouse.
  const focusLot = built.focus
    ? built.play.plan.houses.find((ho) => ho.index === built.focus!.house) ?? null
    : null;
  const stageCentre = { x: play.stage.center.x, z: play.stage.center.y };
  return bootQuestGame(container, built.play.bundle.game, setStatus, {
    town: play,
    scale: labSessionScale(loaded.game!.scale),
    culture: loaded.game!.culture,
    // The host keeps its SPIRIT interaction semantics (gaze-only, dwell to
    // pick/talk at any distance); the LADDER owns the camera.
    spirit: isSpirit,
    ...(built.focus ? { dollhouse: built.focus.house } : {}),
    ...(groundAt ? { groundAt } : {}),
    ...(waterAt ? { waterAt } : {}),
    detail,
    ...(isSpirit ? {
      ladder: {
        scopeLevel: "town" as const,
        townMetrics: {
          centre: stageCentre,
          radius: () => Math.max(200, built.play.plan.radius),
        },
        focusFrame: focusLot
          ? {
              x: focusLot.dx + play.stage.center.x,
              y: focusLot.dy + play.stage.center.y,
              w: focusLot.w,
              h: focusLot.h,
            }
          : null,
      },
    } : {}),
  }, board);
}

/** REAL planet ground for a `terrain: "planet"` town: bake the earthlike
 *  world at REAL radius, chart its most fertile founding site (walk-chart's
 *  tangent frame), and stand the town on it — sim (x, y) is the chart, the
 *  height is the planet's own render sampler. Deterministic in the seed.
 *  The town plaza sits at the chart anchor (the site cell), so spawn = the
 *  real site. */
function planetSiteGround(seed: number): {
  groundAt: (x: number, y: number) => number;
  waterAt: (x: number, y: number) => boolean;
} {
  const built = buildPlanetWorld({
    scope: "planet",
    world: {
      topology: { kind: "cube-sphere", faceN: 24 },
      geology: { seed, epochs: 350, continentR: 0.38 },
      settle: true,
      radius: 6_371_000,
    },
    initialFocus: null,
    avatar: false,
    avatarSpecies: "human",
    canFly: false,
    creativeMode: false,
    entities: null,
    scale: null, // realism — the bake stands on a real-radius earthlike
    culture: null,
  });
  const site = built.sites[0];
  const chart = createWalkChart(built.surface, built.spec.radius, built.topo.pos3!(site.cell));
  // The stage's town coords are centred at stage.center (~side/2, side/2);
  // shift so the CHART anchor is the town centre, not the manifold corner.
  return {
    groundAt: (x, y) => chart.groundAt(x - PLANET_TOWN_CENTER, y - PLANET_TOWN_CENTER),
    // SEA is where the RAW surface dips below the waterline (the chart's
    // groundAt clamps to ≥0 relative land — water needs the unclamped read).
    waterAt: (x, y) =>
      built.surface.heightAt(chart.dirAt(x - PLANET_TOWN_CENTER, y - PLANET_TOWN_CENTER)) < 0,
  };
}
// A town manifold is ~1 km; its centre in stage coords. Kept as a constant
// mirror of town-stage's side/2 (probed; a mismatch only shifts which patch
// of hillside the town stands on — still real ground).
const PLANET_TOWN_CENTER = 500;

/** Deterministic rolling relief for a `terrain: "hills"` town — a few
 *  metres of rise over street-scale wavelengths. */
function rollingHills(seed: number): (x: number, y: number) => number {
  const p1 = (seed % 7) * 0.7;
  const p2 = (seed % 13) * 0.31;
  return (x, y) =>
    3.2 * Math.sin(x / 61 + p1) * Math.cos(y / 47 - p2) +
    1.4 * Math.sin((x + y) / 23 + p2) +
    0.6 * Math.sin(x / 9 - y / 11);
}

/** A living town EMBEDDED in the space-flight scene (seamless walk↔fly).
 *  Unlike the town-scope boot — which owns its own canvas — this renders the
 *  town INTO the flight scene under `renderHost.anchor` (the city on the planet), shares the
 *  flight camera, and is driven ONE frame at a time by the flight loop
 *  (`host.step`). Only the response board + toast/win overlay mount as DOM over
 *  the flight canvas; the 3D is the flight canvas itself. The coordinator hands
 *  the camera between walking (this host) and flying (flight-sim).
 *
 *  TODO(histfig): the manifold is unbounded now (`TownStageOpts.onPlanet`),
 *  so a resident can follow the player OUT of town — but this host still owns
 *  its body, and dispose() takes it down with the town. The agreed rule
 *  (COORDINATE_MODES_PLAN.md "Still OPEN"): on leaving, remove the creature
 *  from the town's population and promote it to a HISTORICAL FIGURE in the
 *  session's mutation layer; released histfigs path toward the nearest town
 *  and merge back (resume schedule ⇒ delete mutation+histfig; else retain).
 *  Keep v1 simple: persist the follower across dispose before modeling the
 *  full lifecycle. */
export interface EmbeddedTown {
  host: QuestHost3D;
  /** The local walker's town-sim (stage) position + facing, or null. */
  playerPose(): { x: number; y: number; fx: number; fy: number } | null;
  /** Teleport the local walker in town-sim (stage) coords — the landing
   *  handoff. Optional (fx, fy) sets its facing (the landing heading), so the
   *  body and the freshly-seeded chase camera look the way the flight was
   *  moving. Velocity zeroes (it just touched down). */
  placePlayer(x: number, y: number, fx?: number, fy?: number): void;
  /** Re-route the shared board to this host. The lab board's claim is
   *  last-wins, so whichever ground layer GAINS the walker re-claims at the
   *  transition (the coordinator calls this; boots claim once at boot). */
  claimBoard(): void;
  dispose(): void;
}

export function bootTownEmbedded(
  overlayParent: HTMLElement,
  hostCanvas: HTMLCanvasElement,
  renderHost: RenderHost,
  play: TownPlay,
  setStatus: (text: string) => void,
  sharedBoard: SharedBoard,
  groundAt: (x: number, y: number) => number,
  waterAt?: (x: number, y: number) => boolean,
  /** SPIRIT session (the spirit-ladder scope): the town runs the same
   *  stationary-spirit semantics as a standalone spirit world — the local
   *  avatar is formless and never pointer-steered, and every dwell-at-range
   *  affordance (talk, containers, carry) is live. A walker scope (walk↔fly)
   *  omits it: the walker session steers by proximity.
   *  `tradePartners` (nations P0): the nearby settlements the BOOT knows
   *  about — planet cities beyond what the session's own stage carries —
   *  in the town's sim coordinates (quest-host deps.tradePartners). */
  opts?: {
    spirit?: boolean;
    scale?: WorldScale;
    tradePartners?: () => Array<{ key: string; at: { x: number; y: number } }>;
  },
): EmbeddedTown {
  // ── Overlay DOM: ONLY the in-world HUD (toast/win) floats over the flight
  //    canvas (the 3D is the flight canvas itself; there is no quest-canvas).
  //    The button board is the lab's persistent TOP-LEVEL chrome (SharedBoard),
  //    already mounted beside the viewscreen — this boot just claims it. ──────
  const root = el("div", "quest-embed", overlayParent);
  const toastEl = el("div", "quest-toast", root);
  const winEl = el("div", "quest-win", root);
  toastEl.hidden = true;
  winEl.hidden = true;

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let session: QuestSession | null = null;
  let host: QuestHost3D | null = null;

  const board: BoardIsland = sharedBoard.island;
  const boardHandlers: BoardHandlers = {
    select: (id) => host?.select(id),
    speak: (sentence) => host?.speak(sentence),
    selectPocket: (entityId) => host?.selectPocket(entityId),
    selectFamilyMember: (memberId) => host?.selectFamilyMember(memberId),
  };
  let releaseBoard = sharedBoard.claim(boardHandlers);

  const presenter = {
    sessionStarted(s: QuestSession) {
      session = s;
      board.set(null);
      board.setNouns([]);
      board.setPocket([]);
      board.setFamily([]);
      board.setCity([]);
      winEl.hidden = true;
    },
    board(view: QuestBoardView) { board.set(view); },
    nouns(list: { symbol: string; label: string }[]) { board.setNouns(list); },
    pocket(items: Parameters<BoardIsland["setPocket"]>[0]) { board.setPocket(items); },
    family(members: Parameters<BoardIsland["setFamily"]>[0]) { board.setFamily(members); },
    city(chips: Parameters<BoardIsland["setCity"]>[0]) { board.setCity(chips); },
    clearBoard() { board.set(null); },
    toast(text: string) {
      toastEl.textContent = text;
      toastEl.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
    },
    objectives() { /* the flight status line carries the beat; no HUD strip here */ },
    collect() { /* no-op in the embedded view */ },
    satchel() { /* no-op in the embedded view */ },
    won() {
      winEl.textContent = "";
      winEl.hidden = false;
      const title = el("div", "quest-win-title", winEl);
      title.textContent = session?.game.root.outro ?? session?.game.meta.title ?? "You did it!";
      const replay = el("button", "quest-replay", winEl);
      replay.textContent = "🔁 Play again";
      replay.addEventListener("click", () => host?.replay());
    },
  };

  host = createQuestHost3D({
    canvas: hostCanvas,
    presenter,
    resolveImage: labImageResolver,
    host: renderHost,
    groundAt,
    ...(waterAt ? { waterAt } : {}),
    ...(opts?.tradePartners ? { tradePartners: opts.tradePartners } : {}),
  });
  host.start(play.bundle.game, play, {
    ...(opts?.spirit ? { spirit: true } : {}),
    scale: opts?.scale ?? DOLLHOUSE_SCALE,
  });
  (window as unknown as Record<string, unknown>).__questEmbed = host;
  setStatus(
    `${play.bundle.game.meta.title} · day ${play.town.day} · walk with the mouse · aim to the top of the screen to fly`,
  );

  const player = () => host?.world?.state.avatars[PLAYER_ID] ?? null;

  return {
    host,
    playerPose() {
      const p = player();
      return p ? { x: p.x, y: p.y, fx: p.fx, fy: p.fy } : null;
    },
    placePlayer(x, y, fx, fy) {
      const p = player();
      if (!p) return;
      p.x = x;
      p.y = y;
      p.vx = 0;
      p.vy = 0;
      if (fx !== undefined && fy !== undefined) {
        const l = Math.hypot(fx, fy);
        if (l > 1e-6) { p.fx = fx / l; p.fy = fy / l; }
      }
    },
    claimBoard() {
      releaseBoard = sharedBoard.claim(boardHandlers);
    },
    dispose() {
      host?.stop();
      host = null;
      releaseBoard(); // blank + un-route the persistent board (never unmount it)
      if (toastTimer) clearTimeout(toastTimer);
      delete (window as unknown as Record<string, unknown>).__questEmbed;
      root.remove();
    },
  };
}

/** OPEN COUNTRY as a REAL quest session (single-ground-host slice 1): the
 *  wilderness side of the planet's walk↔fly path boots the SAME QuestHost3D a
 *  town does — the deterministic scatter's minded, talkable, possessable
 *  creatures and resource features (quest-host seedWilderness) instead of the
 *  bare sandbox WorldHost — so both sides of a town border are one host class.
 *  The handle is a superset of wilderness-boot's WildernessGround shape, so
 *  main.ts's coordinator drives either boot through one surface. */
export interface EmbeddedWildQuest {
  host: QuestHost3D;
  /** The full quest surface (pocket handoff etc.) — the same object as `host`,
   *  named so coordinator sites that need quest-only members read as such (the
   *  legacy sandbox boot has no equivalent). */
  quest: QuestHost3D;
  /** The local walker's chunk-sim position + facing, or null. */
  playerPose(): { x: number; y: number; fx: number; fy: number } | null;
  /** Teleport the local walker in chunk-sim coords (the landing handoff);
   *  optional (fx, fy) sets its facing. Velocity zeroes. */
  placePlayer(x: number, y: number, fx?: number, fy?: number): void;
  /** FLOATING-ORIGIN RE-ANCHOR (see WildernessGround.rebase): re-express the
   *  live sim (WorldHost.rebase) and the view's eased local caches
   *  (QuestHost3D.rebaseLocal) in the moved chart. */
  rebase(
    delta: THREE.Matrix4,
    mapPoint: (p: { x: number; y: number }) => { x: number; y: number },
    mapVec: (v: { x: number; y: number }) => { x: number; y: number },
  ): void;
  /** After a re-anchor: retire herds the chart left far behind, scatter
   *  replacements around the new centre. Never retires the driven body. */
  refreshFauna(): void;
  /** Re-route the shared board to this host (last-wins claim — the layer
   *  GAINING the walker re-claims at each ownership transition). */
  claimBoard(): void;
  dispose(): void;
}

export function bootWildernessQuest(
  overlayParent: HTMLElement,
  hostCanvas: HTMLCanvasElement,
  renderHost: RenderHost,
  setStatus: (text: string) => void,
  sharedBoard: SharedBoard,
  groundAt: (x: number, y: number) => number,
  waterAt: (x: number, y: number) => boolean,
  opts: {
    seed: number;
    fauna: WildFauna;
    spirit?: boolean;
    scale?: WorldScale;
    /** Nearby settlements (planet cities) a FOUNDED SITE here can trade
     *  with, in the wilderness chart's sim coordinates (nations P0 —
     *  quest-host deps.tradePartners). Late-bound: re-read every sweep so
     *  a floating-origin re-anchor keeps the bearings true. */
    tradePartners?: () => Array<{ key: string; at: { x: number; y: number } }>;
    /** PLANET-SCALE FOUNDING (nations P0): the boot registers a spoken
     *  "build"'s new site with the planet (beacon + town-loader override)
     *  and drops it again on abandonment. Sim coords are chunk-local. */
    onSiteFounded?: (site: {
      key: string; seed: number; at: { x: number; y: number }; stock: Record<string, number>;
    }) => void;
    onSiteAbandoned?: (key: string) => void;
  },
): EmbeddedWildQuest {
  // The questless bundle the standalone wilderness scope already plays
  // (bootStructure with `world.wilderness: true`): a certified creature world
  // with zero quests — content and minds come from the session's wilderness
  // scatter, not the goal tree.
  const game = buildCreatureQuestWorld({ seed: opts.seed, questCount: 0 });
  const cert = certifyCreatureQuestWorld(game);
  if (!cert.ok) {
    throw new Error(`wilderness world failed ${cert.stage} certification: ${cert.errors.join("; ")}`);
  }

  // Overlay DOM: ONLY the in-world HUD (toast/win) — the 3D is the flight
  // canvas itself; the button board is the lab's persistent top-level chrome.
  const root = el("div", "quest-embed", overlayParent);
  const toastEl = el("div", "quest-toast", root);
  const winEl = el("div", "quest-win", root);
  toastEl.hidden = true;
  winEl.hidden = true;

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let session: QuestSession | null = null;
  let host: QuestHost3D | null = null;

  const board: BoardIsland = sharedBoard.island;
  const boardHandlers: BoardHandlers = {
    select: (id) => host?.select(id),
    speak: (sentence) => host?.speak(sentence),
    selectPocket: (entityId) => host?.selectPocket(entityId),
    selectFamilyMember: (memberId) => host?.selectFamilyMember(memberId),
  };
  // Claimed at boot: unlike a town (mounted by proximity while the walker may
  // be elsewhere), this boot only ever runs when the walker lands HERE.
  let releaseBoard = sharedBoard.claim(boardHandlers);

  const presenter = {
    sessionStarted(s: QuestSession) {
      session = s;
      board.set(null);
      board.setNouns([]);
      board.setPocket([]);
      board.setFamily([]);
      board.setCity([]);
      winEl.hidden = true;
    },
    board(view: QuestBoardView) { board.set(view); },
    nouns(list: { symbol: string; label: string }[]) { board.setNouns(list); },
    pocket(items: Parameters<BoardIsland["setPocket"]>[0]) { board.setPocket(items); },
    family(members: Parameters<BoardIsland["setFamily"]>[0]) { board.setFamily(members); },
    city(chips: Parameters<BoardIsland["setCity"]>[0]) { board.setCity(chips); },
    clearBoard() { board.set(null); },
    toast(text: string) {
      toastEl.textContent = text;
      toastEl.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
    },
    objectives() { /* the flight status line carries the beat; no HUD strip here */ },
    collect() { /* no-op in the embedded view */ },
    satchel() { /* no-op in the embedded view */ },
    won() {
      winEl.textContent = "";
      winEl.hidden = false;
      const title = el("div", "quest-win-title", winEl);
      title.textContent = session?.game.root.outro ?? session?.game.meta.title ?? "You did it!";
      const replay = el("button", "quest-replay", winEl);
      replay.textContent = "🔁 Play again";
      replay.addEventListener("click", () => host?.replay());
    },
  };

  host = createQuestHost3D({
    canvas: hostCanvas,
    presenter,
    resolveImage: labImageResolver,
    host: renderHost,
    groundAt,
    waterAt,
    ...(opts.tradePartners ? { tradePartners: opts.tradePartners } : {}),
    ...(opts.onSiteFounded ? { onSiteFounded: opts.onSiteFounded } : {}),
    ...(opts.onSiteAbandoned ? { onSiteAbandoned: opts.onSiteAbandoned } : {}),
  });
  host.start(game, null, {
    // The chunk stands on a real planet: side matches the coordinator's
    // WILD_SIDE math and the rect is content extent, never a wall.
    wilderness: { seed: opts.seed, side: WILD_SIDE, bounded: false },
    ...(opts.spirit ? { spirit: true } : {}),
    scale: opts.scale ?? DOLLHOUSE_SCALE,
  });
  (window as unknown as Record<string, unknown>).__questWild = host;
  setStatus("wilderness — walk with the mouse · dwell on a creature to talk");

  // ── The biome's HERDS on top of the scatter: plain wander bodies, exactly
  // wilderness-boot's fauna (its stream decorrelated from the scatter's, which
  // consumed the same seed inside buildWilderness). ──────────────────────────
  const rng = mulberry(opts.seed ^ 0x9e3779b9);
  const place = (): { x: number; y: number } | null => {
    for (let tries = 0; tries < 8; tries++) {
      const x = 12 + rng() * (WILD_SIDE - 24);
      const y = 12 + rng() * (WILD_SIDE - 24);
      const dc = Math.hypot(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
      if (dc < 8) continue; // keep the touchdown clear
      if (waterAt(x, y)) continue;
      return { x, y };
    }
    return null;
  };
  let horseSeq = 0;
  const spawnHorse = (): void => {
    const p = place();
    if (!p || !host) return;
    const id = `horse_${horseSeq++}`;
    host.session.npcIcons.set(id, "🐴"); // → ungulate body (ANIMAL_SPECIES_BY_ICON)
    host.world?.addNpc({
      id,
      x: p.x,
      y: p.y,
      behavior: { movement: "wander", wanderRadius: 30, home: { x: p.x, y: p.y }, speed: 1.4, conversationRadius: 3 },
    });
  };
  for (let i = 0; i < opts.fauna.horses; i++) spawnHorse();

  const player = () => host?.world?.state.avatars[PLAYER_ID] ?? null;

  return {
    host,
    quest: host,
    playerPose() {
      const p = player();
      return p ? { x: p.x, y: p.y, fx: p.fx, fy: p.fy } : null;
    },
    placePlayer(x, y, fx, fy) {
      const p = player();
      if (!p) return;
      p.x = x;
      p.y = y;
      p.vx = 0;
      p.vy = 0;
      if (fx !== undefined && fy !== undefined) {
        const l = Math.hypot(fx, fy);
        if (l > 1e-6) { p.fx = fx / l; p.fy = fy / l; }
      }
    },
    rebase(delta, mapPoint, mapVec) {
      host?.world?.rebase(mapPoint, mapVec);
      host?.rebaseLocal(delta);
    },
    refreshFauna() {
      // A rebased herd whose mapped position fell far outside the fresh chunk
      // is out of the walker's world — retire it and let a new one graze here.
      // (A CLAIMED body is never retired: the spark may be riding it.)
      const w = host?.world;
      if (!w) return;
      const cx = WILD_SIDE / 2;
      let alive = 0;
      for (const a of Object.values(w.state.avatars)) {
        if (!a.id.startsWith("horse_")) continue;
        if (a.id === w.state.drivenId) { alive++; continue; }
        if (Math.hypot(a.x - cx, a.y - cx) > WILD_SIDE) w.removeNpc(a.id);
        else alive++;
      }
      for (let i = alive; i < opts.fauna.horses; i++) spawnHorse();
    },
    claimBoard() {
      releaseBoard = sharedBoard.claim(boardHandlers);
    },
    dispose() {
      host?.stop();
      host = null;
      releaseBoard(); // blank + un-route the persistent board (never unmount it)
      if (toastTimer) clearTimeout(toastTimer);
      delete (window as unknown as Record<string, unknown>).__questWild;
      root.remove();
    },
  };
}

/** The STRUCTURE scope: a freestanding creature-quest puzzle. With avatar
 *  "spirit" it plays as the stationary, formless puzzle (talk + move items). */
export function bootStructure(
  container: HTMLElement,
  loaded: LoadedWorld,
  setStatus: (text: string) => void,
  board: SharedBoard,
): QuestBoot {
  const t0 = performance.now();
  const w = (loaded.game!.world ?? {}) as Record<string, unknown>;
  const numOf = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const params: CreatureWorldParams = {
    seed: numOf(w.seed, 1),
    questCount: numOf(w.questCount, 0),
    ...(w.layout === "house" || w.layout === "village" ? { layout: w.layout } : {}),
  };
  const game = buildCreatureQuestWorld(params);
  const cert = certifyCreatureQuestWorld(game);
  if (!cert.ok) {
    throw new Error(`structure world failed ${cert.stage} certification: ${cert.errors.join("; ")}`);
  }
  const spirit = avatarKind(loaded.game) === "spirit";
  // WILDERNESS (`world.wilderness: true`, founding flow): the questless world
  // becomes open country — resource trees/rocks + possessable creatures, the
  // spirit ladder at the TOWN scope level so the GROUND glide (and the
  // town-rung orbit over a founded site) is reachable.
  const wilderness = w.wilderness === true
    ? { seed: numOf(w.seed, 1), side: numOf(w.side, 240) }
    : undefined;
  const detail = wilderness
    ? `wilderness · seed ${params.seed} · ${Math.round(performance.now() - t0)}ms`
    : `structure · seed ${params.seed} · ${game.entities.length} entities · certified · ${Math.round(performance.now() - t0)}ms`;
  return bootQuestGame(container, game, setStatus, {
    spirit, detail,
    scale: labSessionScale(loaded.game!.scale),
    culture: loaded.game!.culture,
    ...(wilderness ? { wilderness } : {}),
    // The UNIFIED SPIRIT: a spirit structure is the same dollhouse rung the
    // planet ladder descends to — one code path, standalone or nested. A
    // wilderness spans the whole ladder below town instead.
    ...(spirit
      ? { ladder: { scopeLevel: wilderness ? ("town" as const) : ("structure" as const) } }
      : {}),
  }, board);
}
