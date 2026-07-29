// games/dollhouse/src/quest-boot.ts
//
// The spirit-dollhouse boot, ported from world-lab's quest-boot.ts and trimmed
// to the ONE path this game ships: the TOWN scope played through the shared
// quest host (createQuestHost3D) with the SPIRIT LADDER over the flat provider
// — town orbit → ground glide → structure dollhouse — starting (and initially
// capped) at the dollhouse rung on the spec's `initial_focus` house.
//
// Dropped from the world-lab original (world-lab remains the full bench):
//   • bootStructure / bootTownEmbedded / bootWildernessQuest (other scopes)
//   • neighbor-hamlet clustering (`cluster: N`), terrain "hills"/"planet"
//     ground samplers (the planet-bake machinery), wilderness scatter
//   • the lab's perf/debug panels
// Added for the shipped game: an `aim`/`clearAim` surface so the games-bridge
// gaze feed drives the SAME pointer pipeline the mouse uses, and `setPaused`.

import { avatarKind, type LoadedWorld } from "@shared/world-engine/kernel/manifest";
import { parseWorldCommand } from "@shared/world-engine/net";
import { furnitureUsePoseDump, type UseDumpWorld } from "@shared/world-engine/furniture-use";
import {
  DOLLHOUSE_SCALE, resolveWorldScale, type WorldScale, type WorldScaleSpec,
} from "@shared/world-engine/scale";
import { buildTownScope } from "@shared/world-engine/interaction/town/town-play-game";
import type { TownPlay } from "@shared/world-engine/interaction/town/town-play";
import * as THREE from "three";
import {
  createQuestHost3D,
  type QuestBoardView,
  type QuestHost3D,
  type QuestSession,
} from "@shared/world-engine/interaction/quest/quest-host";
import { PLAYER_ID } from "@shared/world-engine/solver/space3d";
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
import { gameImageResolver } from "./glyph-resolver";
import type { BoardIsland } from "./board-island";

export interface QuestBoot {
  /** Feed a FORWARDED aim point (iframe-local client px) into the same
   *  pipeline the mouse uses — the games-bridge gaze feed calls this. Dropped
   *  while a native pointer inside the stage owns the aim (sticky claim —
   *  see AIM ARBITRATION). */
  aim(clientX: number, clientY: number): void;
  /** The forwarded aim went away (gaze mode "off" / out-of-frame). Clears only
   *  an aim the forwarded stream itself set — never a native-owned one. */
  clearAim(): void;
  /** Pause/resume the sim (bridge `pause`/`resume`). */
  setPaused(paused: boolean): void;
  /** MULTIPLAYER inbound (lossy mesh): bridge `world_data` payloads, handed
   *  raw to the host (it validates, tolerates unknown kinds, drops echoes).
   *  No-op when this boot is single-player. */
  applyNetInbound(msgs: unknown[]): void;
  /** MULTIPLAYER inbound (reliable relay): a peer's WorldCommand — validated
   *  via parseWorldCommand here; the host applies it OWNER-only (followers
   *  ignore it — they don't own the sim). */
  applyRemoteCommand(cmd: unknown): void;
  /** The creature the LOCAL player is currently addressing — a FOLLOWER stamps
   *  this as `target` on the speak commands it relays (quest-host.ts). */
  localAddressee(): string | null;
  /** This boot's multiplayer role, or null when single-player. */
  multiplayerRole(): "owner" | "follower" | null;
  dispose(): void;
}

/** OWNER-AUTHORITATIVE MULTIPLAYER identity for a boot (the platform's
 *  `world_session` + the games-bridge `world_data` transport) — passed through
 *  as QuestHostDeps.multiplayer. Absent ⇒ byte-identical single-player. */
export interface QuestMultiplayer {
  /** This peer's stable network id (its personId on the wire). */
  localId: string;
  role: "owner" | "follower";
  /** Outbound transport: engine wire messages → bridge `world_data`. */
  net: { send(msgs: unknown[]): void };
}

/** The session scale: the document's `game.scale` declaration, else the
 *  street-clock DOLLHOUSE profile — the town machinery (goods.ts street
 *  schedules) is paced to that 240 s day. */
function sessionScale(spec: WorldScaleSpec | null | undefined): WorldScale {
  return spec ? resolveWorldScale(spec) : DOLLHOUSE_SCALE;
}

/** The game's ONE button board — the AAC's own chrome, a top-level sibling of
 *  the viewscreen, mounted ONCE at startup and ALWAYS visible (blank when the
 *  current scope offers nothing to press). Boots never mount or tear it down;
 *  they CLAIM it (routing its taps to themselves) and release on dispose.
 *  Mirrors the real AAC: the game loads in the game window, the board stays in
 *  the sidebar/footer regardless. */
export interface SharedBoard {
  island: BoardIsland;
  /** Route the board's user actions to this host; returns a release fn that
   *  also blanks the board (only if this claim is still the active one). */
  claim(handlers: BoardHandlers): () => void;
}

export interface BoardHandlers {
  /** `spokenExternally` = another surface (the AAC board in its own frame)
   *  already voiced the player's statement — the host holds its voicing back. */
  select(id: string, opts?: { spokenExternally?: boolean }): void;
  speak(sentence: string, opts?: { spokenExternally?: boolean }): void;
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
  /** The living-town session (its residents stream in). */
  town: TownPlay;
  /** SPIRIT avatar — stationary, formless, gaze-only interaction. */
  spirit?: boolean;
  /** DOLLHOUSE — the focused house index (`initial_focus` resolved): Sims-mode
   *  motives for its members, direct obedience. Undefined = the village square. */
  dollhouse?: number;
  /** SPACE-TIME COMPRESSION for the session (space-time-compression.md). */
  scale?: WorldScale;
  /** CULTURAL LAW (`game.culture`). */
  culture?: import("@shared/world-engine/culture").WorldCultureSpec | null;
  /** MULTIPLAYER identity + transport (QuestHostDeps.multiplayer). */
  multiplayer?: QuestMultiplayer;
  /** Status-line detail (build stats). */
  detail: string;
  /** THE SPIRIT LADDER over this standalone world (the unified spirit —
   *  town orbit / ground glide / structure dollhouse — replacing the host's
   *  stationary camera; the host keeps sim + interaction, the ladder owns
   *  the camera via setExternalCamera). */
  ladder?: {
    scopeLevel: "town" | "structure";
    /** Town metrics; omitted = derived from the world spec. */
    townMetrics?: { centre: { x: number; z: number }; radius: () => number };
    /** Start focused on this building frame (SIM coords) — the standalone
     *  dollhouse; the initial ceiling is then "structure". */
    focusFrame?: { x: number; y: number; w: number; h: number } | null;
  };
}

/** Mount the quest host + the real response board and start `game`. */
function bootQuestGame(
  container: HTMLElement,
  game: GoalTreeGame,
  setStatus: (text: string) => void,
  opts: QuestStartOpts,
  sharedBoard: SharedBoard,
): QuestBoot {
  // ── DOM scaffold: the stage (canvas + overlays). The button board is NOT
  //    part of this scaffold — it is the game's persistent top-level chrome
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
    select: (id, opts) => host?.select(id, opts),
    speak: (sentence, opts) => host?.speak(sentence, opts),
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
    collect() { /* the objectives strip is enough */ },
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
    canvas, presenter, resolveImage: gameImageResolver,
    // OWNER-AUTHORITATIVE MULTIPLAYER (absent ⇒ single-player, byte-identical).
    ...(opts.multiplayer ? { multiplayer: opts.multiplayer } : {}),
    // The spirit ladder is a GUEST of the host's own frame: sim ticks, then
    // the ladder poses the camera (setExternalCamera), then the view draws.
    onFrame: (dt) => {
      if (!ladder) return;
      // INTERIORS FOLLOW WHETHER A REAL BODY IS IN THE HOUSE — never the rung
      // alone, and never the glide's parked stand-in. A formless spirit in the
      // street is not an occupant; CLAIM a creature and the interior opens as
      // for a walker; the dollhouse rung opens one regardless.
      host?.setInteriorReveal(possessedNow || ladder.level === "structure");
      if (possessedNow) {
        setStatus(`AVATAR — you are ${host?.possessed ?? "?"} · walk with the mouse · Speak "stop" to let go`);
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
      // Feed the spirit's hover position to the host (distance rules see the
      // SPIRIT, not the parked walker).
      if (ladder.focusWorld(_focus)) host?.setSpiritPosition(_focus.x, _focus.z);
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
        // WITH the flat town ref, so the glide can still enter buildings and
        // the bottom dwell ascends to the district orbit.
        const p = host?.world?.state.avatars[PLAYER_ID];
        if (ladder && p) {
          ladder.dropToGround(_focus.set(p.x, 0, p.y), FLAT_TOWN_REF);
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
      // wandered.
    },
  });
  host.start(game, opts.town, {
    spirit: opts.spirit,
    ...(opts.dollhouse !== undefined ? { dollhouse: opts.dollhouse } : {}),
    ...(opts.scale ? { scale: opts.scale } : {}),
    ...(opts.culture ? { culture: opts.culture } : {}),
  });
  (window as unknown as Record<string, unknown>).__questLab = host;
  // FURNITURE USE-POINT eyeball check (debug console): `__questLab_pose()`.
  (window as unknown as Record<string, unknown>).__questLab_pose = () => {
    const w = host?.world?.state as unknown as UseDumpWorld | undefined;
    const rows = w ? furnitureUsePoseDump(w) : [];
    // eslint-disable-next-line no-console
    console.table(
      rows.map((r) => ({
        id: r.id,
        fixture: r.fixture,
        contact: r.contactPart,
        on: r.onFixture,
        dPlanar: +r.planarDelta.toFixed(3),
        dYaw: +r.yawDelta.toFixed(3),
        useX: +r.usePoint.x.toFixed(2),
        useY: +r.usePoint.y.toFixed(2),
      })),
    );
    return rows;
  };

  // Pointer-as-gaze: the aim point IS the gaze. Under the LADDER, the raw
  // pointer feeds the ladder — it forwards to the host itself only at the
  // structure rung (interaction) and the ground glide, so an orbit dwell never
  // doubles as a host interaction dwell. A POSSESSED avatar is an ordinary
  // walker: the pointer goes straight to the host. `aimAt`/`aimClear` are the
  // ONE pipeline both the mouse and the bridge gaze feed drive.
  const aimAt = (clientX: number, clientY: number): void => {
    if (opts.ladder && !possessedNow) {
      const r = canvas.getBoundingClientRect();
      ladderPtr.x = clientX - r.left;
      ladderPtr.y = clientY - r.top;
      ladderPtr.clientX = clientX;
      ladderPtr.clientY = clientY;
      ladderPtr.inside = true;
    } else host?.setPointer(clientX, clientY);
  };
  const aimClear = (): void => {
    if (opts.ladder && !possessedNow) ladderPtr.inside = false;
    else host?.clearPointer();
  };

  // ── AIM ARBITRATION — embedded, TWO sources feed the one pipeline: the
  // iframe's own native pointermove AND the platform's forwarded ~30 Hz `gaze`
  // stream (which spams `mode:"off"` whenever it has no position). Feeding
  // both unarbitrated made the aim flicker and drag laterally — and the
  // ground/ladder camera, which turns toward the aim, span continuously.
  // ONE source of truth, and ownership is STICKY, never a timer:
  //   • a NATIVE pointer event claims the aim, and the claim holds while the
  //     pointer stays INSIDE the stage — a RESTING cursor keeps its aim
  //     indefinitely (the hover IS the aim; dwell-to-select depends on it).
  //     A short expiry window here (the first attempt) let the forwarded
  //     stream seize a resting cursor's aim after ~1 s and yank the spark
  //     to wherever its next estimate landed (the left-edge dart);
  //   • the ONLY things that end a native claim: pointerleave (clears the aim
  //     and releases ownership), or a forwarded POSITION arriving after the
  //     native pointer has been silent for NATIVE_IDLE_RELEASE_MS — a genuine
  //     input switch (mouse abandoned for camera eyegaze), where the new
  //     point REPLACES the aim; far longer than any dwell, so no dwell can
  //     be interrupted by it;
  //   • a forwarded clear ("off" spam / out-of-frame) clears ONLY an aim the
  //     forwarded stream itself set — never a native one;
  //   • before any native claim (camera-based eyegaze: no native events),
  //     the forwarded stream flows freely.
  // `?aimdebug` on the iframe URL logs source decisions (throttled), off by
  // default.
  const AIM_DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("aimdebug");
  const NATIVE_IDLE_RELEASE_MS = 10_000;
  let nativeInside = false; // a native pointer has claimed and not pointerleave'd
  let lastNativeMs = -Infinity;
  let forwardedOwns = false;
  const nativeOwns = (): boolean =>
    nativeInside && performance.now() - lastNativeMs < NATIVE_IDLE_RELEASE_MS;
  let lastAimLogMs = 0;
  const aimLog = (what: string): void => {
    if (!AIM_DEBUG) return;
    const now = performance.now();
    if (now - lastAimLogMs < 500) return;
    lastAimLogMs = now;
    // eslint-disable-next-line no-console
    console.log(`[aim] ${what}`);
  };
  const onMove = (e: PointerEvent): void => {
    nativeInside = true;
    lastNativeMs = performance.now();
    forwardedOwns = false;
    aimLog(`native ${Math.round(e.clientX)},${Math.round(e.clientY)}`);
    aimAt(e.clientX, e.clientY);
  };
  const onLeave = (): void => {
    nativeInside = false;
    lastNativeMs = -Infinity;
    aimLog("native leave — aim cleared, ownership released");
    aimClear();
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
    opts.spirit && opts.dollhouse !== undefined
      ? "SPIRIT DOLLHOUSE — watch the family's chips, dwell to talk/gift, chip + Speak to command"
      : opts.spirit
        ? "SPIRIT — no walking: look at an item to pick it up / put it down, look at someone to talk"
        : "walk with the mouse, dwell on a resident to talk";
  setStatus(`${game.meta.title} · ${opts.detail} · ${hint}`);

  return {
    // Forwarded (bridge `gaze`) entry points — arbitrated against the native
    // pointer (see AIM ARBITRATION above).
    aim(clientX, clientY) {
      if (nativeOwns()) { aimLog("gaze dropped (native pointer owns aim)"); return; }
      forwardedOwns = true;
      aimLog(`gaze ${Math.round(clientX)},${Math.round(clientY)}`);
      aimAt(clientX, clientY);
    },
    clearAim() {
      if (nativeOwns() || !forwardedOwns) return;
      forwardedOwns = false;
      aimLog("gaze clear");
      aimClear();
    },
    setPaused(p) { host?.setPaused(p); },
    applyNetInbound(msgs) { host?.applyNetInbound(msgs); },
    applyRemoteCommand(cmd) {
      const parsed = parseWorldCommand(cmd);
      if (parsed) host?.applyRemoteCommand(parsed);
    },
    localAddressee() { return host?.localAddressee() ?? null; },
    multiplayerRole() { return host?.multiplayerRole() ?? null; },
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
      delete (window as unknown as Record<string, unknown>).__questLab_pose;
      delete (window as unknown as Record<string, unknown>).__spiritLadder;
      root.remove();
    },
  };
}

/** The TOWN scope: a living town whose residents are the quest-givers. The
 *  `initial_focus` naming a HOUSE ("house:<index>" or { type: "house" }) plays
 *  as the DOLLHOUSE — the game opens inside that household (Sims-mode motives,
 *  direct obedience) while the whole town keeps living around it. */
export function bootLivingTown(
  container: HTMLElement,
  loaded: LoadedWorld,
  setStatus: (text: string) => void,
  board: SharedBoard,
  multiplayer?: QuestMultiplayer,
): QuestBoot {
  const t0 = performance.now();
  const built = buildTownScope(loaded.game!);
  const play = built.play;
  const detail =
    `${built.focus ? `dollhouse (house ${built.focus.house}) · ` : ""}town · seed ${built.spec.config.seed} · day ${built.play.town.day} · ` +
    `pop ${Math.round(built.play.town.scalar("population"))} · ${built.play.bundle.cast.length} residents · ` +
    `certified · ${Math.round(performance.now() - t0)}ms`;
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
    scale: sessionScale(loaded.game!.scale),
    culture: loaded.game!.culture,
    // The host keeps its SPIRIT interaction semantics (gaze-only, dwell to
    // pick/talk at any distance); the LADDER owns the camera.
    spirit: isSpirit,
    ...(built.focus ? { dollhouse: built.focus.house } : {}),
    ...(multiplayer ? { multiplayer } : {}),
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
