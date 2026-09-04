// games/nature-hike/src/quest-boot.ts
//
// THE HIKE: one planet, rendered space-to-ground, walked on foot.
//
// Three world-lab paths fold into this single boot, because on a planet they
// were never really three things:
//   • THE PLANET (world-lab main.ts bootPlanetScope) — buildPlanetWorld from
//     the document's own geology/radius/rain, createPlanetObject for the
//     quadtree terrain, a sun + sky fill, and per-frame LOD from the camera.
//   • THE CHUNK (world-lab main.ts mountWildChunk) — a surface anchor at a
//     deterministic spawn site whose LOCAL frame IS the SurfaceChart there, so
//     the flat 2D sim runs in metres of tangent plane while the body it stands
//     on stays a sphere. Strays toward the edge re-anchor the chart under the
//     walker (maybeRebaseWild) — a floating origin, never a wall.
//   • THE SESSION (world-lab quest-boot.ts bootWildernessQuest) — open country
//     as a REAL QuestHost3D: a certified zero-quest creature bundle whose
//     content and minds come from the session's wilderness scatter, so the
//     creatures out here are talkable and the resources gatherable.
//
// WALKER, not spirit: `avatar: true` (manifest.ts avatarKind) — the spec alone
// decides, and the engine answers it by CREATING a body for the player
// (attached-avatar mode). The player themselves stays the formless spark: the
// gaze is the spark, the created creature walks to it through the one creature
// behavior model, and the host's grounded chase rig rides the BODY (render3d
// setFollowBody), mapping its chart-local pose through the anchor onto the
// sphere (placeCamera).
//
// ⚖️ THE FLY-DOWN IS THE LOADER (user ruling 3b): nobody flies a ladder here.
// The boot itself starts the camera in the sky over the spawn site and brings
// it down while the planet's quadtree refines under it; the player receives
// control on the ground, avatar already standing. No input drives it, and no
// GUI is added for it — the descent IS the loading screen, and the status line
// (debug-only chrome) just narrates the altitude.
//
// This game OWNS its render loop (the lab's belonged to the flight composer):
// step the host, re-anchor the chart, feed the spark, LOD the planet from the
// camera, draw. Nothing here edits the engine; every seam used is one the lab
// already drives.

import type { LoadedWorld } from "@shared/world-engine/kernel/manifest";
import { parseWorldCommand, type WorldCommand } from "@shared/world-engine/net";
import {
  anchorControl, parseSessionControl,
  type SessionAnchor, type SessionControl,
} from "@shared/world-engine/interaction/quest/session-control";
import type { SessionAssignment } from "@shared/world-engine/interaction/quest/session-split";
import {
  DOLLHOUSE_SCALE, resolveWorldScale, type WorldScale, type WorldScaleSpec,
} from "@shared/world-engine/scale";
import { buildPlanetWorld, type BuiltPlanet } from "@shared/world-engine/planet/planet-game";
import { climateSampleAt } from "@shared/world-engine/planet/ecology";
import { createPlanetObject } from "@shared/world-engine/planet/three";
import type { PlanetSurface } from "@shared/world-engine/planet/surface";
import * as THREE from "three";
import {
  createQuestHost3D,
  type QuestBoardView,
  type QuestHost3D,
  type QuestSession,
} from "@shared/world-engine/interaction/quest/quest-host";
import type { RenderHost } from "@shared/world-engine/render3d";
import { PLAYER_ID } from "@shared/world-engine/solver/space3d";
import type { NpcVoice } from "@shared/world-engine/npc-voice";
import { gameImageResolver } from "./glyph-resolver";
import type { BoardIsland } from "./board-island";
import { faunaForBiome, mulberry, WILD_SIDE, wildMixForBiome } from "./wilderness";

// ── SESSION-HANDOVER VIEWS (stage N6c-g) ────────────────────────────────────
// The payload is the ENGINE'S contract (`SessionHandoverPayload`), and the
// engine is its ONE validator — this game never parses it, it hands it back
// whole. Two fields are read here all the same, and only these two:
//   • `refusals` — because a split that leaves something behind must SAY so
//     (the stage's own requirement: log what stayed with the donor), and
//   • `wild` — length only, as the donor's re-lay guard (below).
// They are declared STRUCTURALLY rather than imported: the payload type ships
// with the same engine version as the calls that produce it, and this game's
// vendored snapshot predates both. A structural view compiles on either
// snapshot and lines up exactly when the sync lands.

/** One named refusal from the wild half — what did NOT travel. */
export interface HandoverRefusalView {
  where?: string;
  key?: string;
  id?: string;
  note?: string;
  blockers?: string[];
}

/** One departing member as `sessionHandoverMembers()` reports it: planet-frame
 *  presence (the only frame two sessions share) plus what they carry. The
 *  RECEIVER owns the mapping back onto its own chart — the engine cannot place
 *  them, because the planet frame is the game's. */
export interface HandoverMemberView {
  id: string;
  loc?: { d: [number, number, number]; e: number };
  stacks?: Record<string, number>;
}

/** What a receive attempt did.
 *  - `applied`    — the payload was accepted and installed.
 *  - `declined`   — the engine refused it whole (foreign shape / version skew);
 *                   by contract NOTHING moved.
 *  - `late`       — it arrived after the player took control. The apply window
 *                   is bounded on purpose (see `applyStoredHandover`), so this
 *                   is logged and DROPPED, never queued.
 *  - `done`       — a payload was already applied to this world.
 *  - `none`       — nothing stored for this session (the plan's accepted v1
 *                   loss: the receiver plays on with its from-seed scatter).
 *  - `unavailable`— this vendored engine predates the handover surface. */
export type HandoverOutcome = "applied" | "declined" | "late" | "done" | "none" | "unavailable";

/** Debug-only readback (`__hikeSession()`), never a GUI. */
export interface HandoverStatus {
  /** Which datum this world's chart was stood on (⑧ below). */
  chart: "announced" | "centroid" | "carried" | "spawn";
  /** The last receive attempt's verdict. */
  received: HandoverOutcome;
  /** Members named by an applied payload, and how they were placed. */
  members: number;
  placed: number;
  /** Members whose planet loc fell OUTSIDE this chart — deliberately left on
   *  the engine's own spawn fan-out rather than clamped to an edge (a clamped
   *  position is a lie about where somebody stands). */
  offChart: number;
  /** Payloads assembled by this world as a donor, and whether the wild slice
   *  the assemble folded was re-laid here (donor stayed live). */
  donated: number;
  relaid: number;
  /** Everything that stayed behind, from either side. */
  refusals: HandoverRefusalView[];
  /** Payloads that arrived after play began (logged, dropped). */
  late: number;
}

export interface QuestBoot {
  /** Feed a FORWARDED aim point (iframe-local client px) into the same
   *  pipeline the mouse uses — the games-bridge gaze feed calls this. Dropped
   *  while a native pointer inside the stage owns the aim (sticky claim —
   *  see AIM ARBITRATION). */
  aim(clientX: number, clientY: number): void;
  /** The forwarded aim went away (gaze mode "off" / out-of-frame). Clears only
   *  an aim the forwarded stream itself set — never a native-owned one. */
  clearAim(): void;
  /** Pause/resume the sim (bridge `pause`/`resume`). The frame loop keeps
   *  drawing — a paused hike is a still picture, not a black screen. */
  setPaused(paused: boolean): void;
  /** MULTIPLAYER inbound (lossy mesh): bridge `world_data` payloads, handed
   *  raw to the host (it validates, tolerates unknown kinds, drops echoes).
   *  No-op when this boot is single-player. */
  applyNetInbound(msgs: unknown[]): void;
  /** MULTIPLAYER inbound (reliable relay): a peer's WorldCommand — validated
   *  via parseWorldCommand here; the host applies it OWNER-only (followers
   *  ignore it — they don't own the sim). */
  applyRemoteCommand(cmd: unknown): void;
  /** MULTIPLAYER inbound (reliable relay): ONE session-control envelope from
   *  the coordinator (session-control.ts — assign / anchor / handover). Handed
   *  raw to the engine, which validates it and STORES it (the engine never
   *  boots or tears worlds); this boot then re-reads the book at once and
   *  reports a changed membership up through `QuestMultiplayer.onSession`.
   *  Safe at any time, and inert on a snapshot that predates the surface. */
  applySessionControl(sc: unknown): void;
  /** SESSION HANDOVER — THE DONOR'S HALF (N6c-g). Assemble everything this
   *  session must hand to the authority taking `memberIds` over, and (when this
   *  world is NOT coming down) re-lay the wild slice the assemble folded in
   *  place. Returns the payload for main.ts to put on the wire, or null when
   *  there is nothing to hand over — no live session, or a vendored engine that
   *  predates the handover surface (feature-detected, silently inert).
   *
   *  `keepPlaying` is the DONOR'S OWN FATE, which main.ts alone knows: it holds
   *  the assignment comparison that says whether this peer's boot identity moved
   *  (see the fold hazard on the implementation). */
  donateHandover(
    memberIds: string[],
    opts: { keepPlaying: boolean },
  ): { payload: unknown; refusals: HandoverRefusalView[]; relaid: boolean } | null;
  /** SESSION HANDOVER — THE RECEIVER'S HALF (N6c-g), for a payload that lands
   *  AFTER the boot went up (the boot applies its own at start). Reads the
   *  host's own book (`sessionHandoverOf`) for the session this world was built
   *  for, applies it while the world is still un-played, and reports what
   *  happened. Bounded and non-blocking: see `HandoverOutcome`. */
  applyStoredHandover(): HandoverOutcome;
  /** Planet-frame presence as last stated to the engine (`setPlanetLoc`), or
   *  null before this world ever placed its walker. main.ts CARRIES it across
   *  the reboot a split forces, so a fresh authority's chart can stand where
   *  the player is standing instead of back at the seed spawn. */
  planetLoc(): SessionAnchor | null;
  /** Debug readback (no GUI — ruling 4): what this boot did with a handover,
   *  folded into main.ts's `__hikeSession()` handle. */
  handoverStatus(): HandoverStatus;
  /** The creature the LOCAL player is currently addressing — a FOLLOWER stamps
   *  this as `target` on the speak commands it relays (quest-host.ts). */
  localAddressee(): string | null;
  /** This boot's multiplayer role, or null when single-player. */
  multiplayerRole(): "owner" | "follower" | null;
  /** MULTIPLAYER roster (bridge `world_session.peers`) — the fellow
   *  participants sharing this session, id + optional display name. Forwarded
   *  straight to the host, which reconciles one CREATED avatar per member
   *  (owner-side) and names each from this roster; also kept in the boot's own
   *  closure, because main.ts re-forwards the standing roster after a reboot.
   *  Safe at any time: the host records the roster whether or not a session is
   *  running, the local member's own body is exempt from the diff, and only
   *  attached-avatar mode ever turns a roster into bodies. */
  setPeers(peers: Array<{ id: string; name?: string }>): void;
  dispose(): void;
}

/** OWNER-AUTHORITATIVE MULTIPLAYER identity for a boot (the platform's
 *  `world_session` + the games-bridge `world_data` transport) — passed through
 *  as QuestHostDeps.multiplayer. Absent ⇒ byte-identical single-player.
 *
 *  ⚠️ PHASE 2 accepts and threads this, but the platform does not yet send
 *  `world_session` to this game (registration is a later stage) and the
 *  wilderness session makes single-player assumptions the later phases must
 *  answer — see the note above `bootPlanetHike`. */
export interface QuestMultiplayer {
  /** This peer's stable network id (its personId on the wire). */
  localId: string;
  role: "owner" | "follower";
  /** Outbound transport: engine wire messages → bridge `world_data`. */
  net: { send(msgs: unknown[]): void };
  /** Outbound reliable COMMANDS → bridge `world_cmd`. A FOLLOWER's gaze
   *  instructions travel here for the owner to run; an owner sends none. */
  sendCommand?: (cmd: WorldCommand) => void;
  /** Outbound reliable SESSION CONTROL → the SAME bridge `world_cmd` pipe
   *  (three discriminants share that wire; each parser cleanly says "not
   *  mine"). TWO senders use it, and neither fires on a peer with nothing to
   *  say: the ENGINE's session coordinator (owner role only — and its absence
   *  is the coordinator's inertness switch, so a boot that omits it is
   *  provably silent) and this boot's own anchor announce below. */
  sendControl?: (sc: SessionControl) => void;
  /** May the ENGINE's session coordinator run on this peer? Set by main.ts for
   *  the PLATFORM's elected host and nobody else.
   *
   *  ⚖️ ONE COORDINATOR PER WORLD. The engine gates its coordinator on the host
   *  ROLE — and after a split every session's authority boots as an "owner",
   *  so wiring the announcement pipe straight into the engine on all of them
   *  would put two coordinators on the same planet, each clustering the same
   *  people, minting its own session ids and racing epochs (at equal epochs
   *  they would flip authority back and forth and reboot each other's worlds).
   *  The coordinator is meant to be the peer the platform already made host
   *  (it is the `platformOwner` its own election prefers), so THAT is the only
   *  peer whose host is handed `sendControl`. A split-off authority still uses
   *  its own `sendControl` for the ANCHOR announce below — the boot keeps the
   *  pipe, the engine simply isn't given it. */
  coordinates?: boolean;
  /** THE SESSION BOOK MOVED: called with the assignment in force whenever THIS
   *  peer's place in it changed — a different session, a different role inside
   *  it, a different authority, or a different set of session-mates. The
   *  embedder owns the reaction (main.ts: reboot on an identity change,
   *  re-filter the roster otherwise), because world construction is the game's
   *  and never the engine's. Never called with a roster that does not name us,
   *  and never called at all until a coordinator has spoken. */
  onSession?: (assignment: SessionAssignment) => void;
  /** THE SESSION THIS WORLD IS BEING BUILT FOR (N6c-g) — main.ts's own snapshot
   *  of its membership at build time. Null in solo play and before any
   *  coordinator has spoken. Three things need it BEFORE the first poll could
   *  answer: which session's anchor to stand the chart on, which session's
   *  handover to look for, and whose datum this peer may state. */
  session?: SessionMembership | null;
  /** SESSION-CONTROL ENVELOPES IN FORCE for that session (anchor / handover),
   *  replayed by main.ts because a reboot builds a brand-new host whose session
   *  book is EMPTY — the same replay law the assignment already rides.
   *
   *  ⚖️ FRESHNESS IS MAIN.TS'S. Only main.ts sees an envelope's SENDER (the
   *  bridge's `world_cmd.fromId`) and the roster it arrived against, so it —
   *  not this boot — decides whether a stored anchor is still this session's
   *  word. Whatever is handed here is taken as current. */
  replayControl?: unknown[];
  /** WHERE THIS PLAYER WAS STANDING when the previous world came down, in the
   *  planet frame (`QuestBoot.planetLoc`). Used only by a peer booting as its
   *  session's AUTHORITY and only when no stated anchor applies — see ⑧. */
  carriedLoc?: SessionAnchor | null;
}

/** THIS peer's place in the coordinator's roster, derived from the assignment
 *  the engine stores. */
export interface SessionMembership {
  /** The epoch this was read at (rides on the anchors this peer announces). */
  epoch: number;
  sessionId: string;
  /** The peer hosting this session's sim — always one of `members`. */
  authority: string;
  /** MY role INSIDE this session (`authority === selfId`). Deliberately
   *  distinct from the platform's own owner/follower word: the platform elects
   *  ONE host for the whole call, and a split hands each cluster its own
   *  authority — so the platform's follower is the OWNER of the world it
   *  walked away with. */
  role: "owner" | "follower";
  /** Everyone in my session, me included (sorted — the coordinator
   *  canonicalizes its output). */
  members: string[];
  /** THE COORDINATOR'S OWN ANCHOR for this session — the normalized centroid of
   *  its members' planet presences, computed by `clusterMembers` and carried in
   *  the same `assign` envelope every member receives.
   *
   *  ⚖️ WHY IT IS WORTH CARRYING (N6c-g ⑧): it is the one datum for "where this
   *  session is" that every member derives IDENTICALLY, without hearing from
   *  anybody. When no authority has stated its chart, this is what stops two
   *  peers of one session from booting onto two different charts. Deliberately
   *  NOT part of `sameMembership`: an anchor that drifts is not a change of
   *  identity, and never a reason to rebuild a world. */
  anchor: SessionAnchor;
}

/** Which session `selfId` belongs to, or null when the roster does not name it
 *  (no presence of ours had reached the coordinator yet). THE one derivation,
 *  shared by this boot (change detection, anchor announce) and by main.ts
 *  (boot identity, session-scoped filtering) so the two can never disagree
 *  about which session this peer is in. Pure. */
export function sessionMembershipOf(
  assignment: SessionAssignment | null,
  selfId: string,
): SessionMembership | null {
  if (!assignment) return null;
  for (const s of assignment.sessions) {
    if (!s.members.includes(selfId)) continue;
    return {
      epoch: assignment.epoch,
      sessionId: s.id,
      authority: s.authority,
      role: s.authority === selfId ? "owner" : "follower",
      members: [...s.members],
      anchor: { d: [s.anchor.d[0], s.anchor.d[1], s.anchor.d[2]], e: s.anchor.e },
    };
  }
  return null;
}

/** Same session, same role, same authority, same session-mates. The EPOCH is
 *  deliberately not part of it: it bumps whenever the topology moves anywhere
 *  on the planet, and a distant party splitting is not news about us. */
function sameMembership(a: SessionMembership | null, b: SessionMembership | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.sessionId === b.sessionId &&
    a.role === b.role &&
    a.authority === b.authority &&
    a.members.length === b.members.length &&
    a.members.every((m, i) => m === b.members[i])
  );
}

/** THE N6b-e HOST SURFACES, structurally — the live engine has them and this
 *  game's VENDORED snapshot does not yet (they arrive with the next
 *  `npm run sync:game-engine -- nature-hike`). Every call through this view is
 *  optional, so the game compiles and runs identically before and after that
 *  sync; before it, the whole session layer is silently inert. */
interface PendingSessionHost {
  setPlanetLoc?: (d: [number, number, number], e: number, radiusM?: number) => void;
  applySessionControl?: (sc: unknown) => void;
  sessionAssignment?: () => SessionAssignment | null;
  /** N6b-e, already vendored — the stored `anchor` / `handover` envelopes,
   *  per session id. Optional here for the same reason as the rest: this view
   *  is structural, and one optional call cannot break an older snapshot. */
  sessionAnchorOf?: (sessionId: string) => SessionAnchor | null;
  sessionHandoverOf?: (sessionId: string) => { from: string; to: string; payload: unknown } | null;
  /** N6c-e, NOT yet vendored — the handover surface itself. All three arrive
   *  together on the next `npm run sync:game-engine -- nature-hike`; until then
   *  every call below is absent and the handover layer is silently inert (a
   *  split still splits, it simply carries nothing — the plan's accepted v1
   *  worst case, which is also today's behavior). */
  assembleSessionHandover?: (memberIds: string[]) => unknown;
  applySessionHandover?: (payload: unknown) => boolean;
  sessionHandoverMembers?: () => HandoverMemberView[];
}

/** The game's ONE button board — the AAC's own chrome, a top-level sibling of
 *  the viewscreen, mounted ONCE at startup and ALWAYS visible (blank when the
 *  current scope offers nothing to press). Boots never mount or tear it down;
 *  they CLAIM it (routing its taps to themselves) and release on dispose. */
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

/** The session scale: the document's `game.scale` declaration, else the
 *  street-clock DOLLHOUSE profile — the wilderness machinery (needs, growth,
 *  the day) is paced to that 240 s day. */
function sessionScale(spec: WorldScaleSpec | null | undefined): WorldScale {
  return spec ? resolveWorldScale(spec) : DOLLHOUSE_SCALE;
}

// ── THE SURFACE FRAME ───────────────────────────────────────────────────────
// Ported from world-lab main.ts (attachSurfaceAnchor / makeSurfaceSamplers).
// The lab reads them off a live CelestialBody; a lone planet has no flight
// world, so the same math takes the two facts it actually needs — the surface
// and the radius — directly off the built planet.

const _UP_Y = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);

/** Anchor-local terrain samplers at a surface point: walk the tangent frame
 *  back onto the sphere and read the planet surface (curvature-corrected).
 *  `water` = the RAW surface below the waterline at the walked direction
 *  (ground clamps it to bank level, matching the sea-clamped render). */
function makeSurfaceSamplers(
  surface: PlanetSurface,
  R: number,
  dir: readonly [number, number, number],
  mesh: THREE.Group,
): { ground: (x: number, z: number) => number; water: (x: number, z: number) => boolean } {
  const dir0 = new THREE.Vector3(dir[0], dir[1], dir[2]);
  const east = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.quaternion);
  const north = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
  const h0 = Math.max(0, surface.heightAt(dir as [number, number, number]));
  const _g = new THREE.Vector3();
  const dirAt = (x: number, z: number): [number, number, number] => {
    _g.copy(dir0).multiplyScalar(R).addScaledVector(east, x).addScaledVector(north, z).normalize();
    return [_g.x, _g.y, _g.z];
  };
  return {
    ground: (x, z) => {
      const h = Math.max(0, surface.heightAt(dirAt(x, z)));
      return (h - h0) - (x * x + z * z) / (2 * R);
    },
    water: (x, z) => surface.heightAt(dirAt(x, z)) < 0,
  };
}

/** DRY-LAND MARGIN — how far above sea level a spawn cell must sit.
 *
 *  ⚠️ THIS REPLACES the old `>= 0` "on land" test, which was written before the
 *  river datum was unified and does NOT survive it: a cell centre a metre or
 *  two above the waterline renders as flat open ocean with no terrain in any
 *  direction. The number is EMPIRICAL, measured on this very planet (seed 11,
 *  r5000) by the world-lab twin of this pick: its 49 candidate sites fall into
 *  two bands with a real gap between them — a marginal/lowland band (0.5-4.9 m,
 *  where the flat-ocean render reproduces every time, site 266 — the old
 *  biome-1 pick — sitting at 1.9 m) and a highland band (5.0-19.3 m, clean);
 *  ten ocean sites sit below -19 m. 5 m is that gap's floor, not a round
 *  number. Same datum (`surface.heightAt`), no new sampler. */
const DRY_MARGIN_M = 5;

/** WHERE THE HIKE STARTS — deterministic in the world seed alone (no clock, no
 *  random, no peer-local state): the planet's own ranked founding sites are
 *  already the ice-filtered, fertile cells the civ layer would settle, so the
 *  walker starts where a settler would.
 *
 *  The scan is an explicit ORDERED WALK rather than a `.find`, because the rule
 *  is "take the next candidate site when this one is wet": sites are visited in
 *  `built.sites` order (stable for a given seed), each is kept only if it
 *  clears DRY_MARGIN_M, and among the survivors the first FOREST or STEPPE cell
 *  wins — a hike wants country with trees and grazing, and those biomes are
 *  what `wildMixForBiome`/`faunaForBiome` actually furnish. Every peer in a
 *  shared session runs this same walk over the same deterministic build, so
 *  they all land on the same cell.
 *
 *  Fallbacks, in order: the first dry site of any biome, then the lowest-index
 *  dry growing cell on the whole lattice, then any dry cell. `sites[0]` is NOT
 *  a fallback any more — a wet site is exactly what this margin exists to
 *  refuse. */
interface HikeSpawn {
  cell: number;
  dir: THREE.Vector3;
  biome: number;
  /** Metres above sea level at the cell centre (status line / diagnostics). */
  dryM: number;
}

function pickSpawn(built: BuiltPlanet): HikeSpawn {
  const topo = built.grid.topo;
  if (!topo.pos3) {
    throw new Error("nature-hike: this planet's lattice has no cell directions (flat topology) — a hike needs a curved body");
  }
  const pos3 = topo.pos3.bind(topo);
  const biomeField = built.grid.fields.biome;
  const biomeOf = (cell: number): number => (biomeField ? biomeField[cell] ?? 0 : 0);
  const dirOf = (cell: number): THREE.Vector3 => {
    const p = pos3(cell);
    return new THREE.Vector3(p[0], p[1], p[2]).normalize();
  };
  const heightOf = (d: THREE.Vector3): number => built.surface.heightAt([d.x, d.y, d.z]);
  const at = (cell: number): HikeSpawn => {
    const dir = dirOf(cell);
    return { cell, dir, biome: biomeOf(cell), dryM: heightOf(dir) };
  };

  // The ranked sites, wet ones dropped — "advance to the next candidate".
  const dry: HikeSpawn[] = [];
  for (const s of built.sites) {
    const cand = at(s.cell);
    if (cand.dryM >= DRY_MARGIN_M) dry.push(cand);
  }
  const site = dry.find((c) => c.biome === 1 || c.biome === 2) ?? dry[0];
  if (site) return site;

  // An unsettled planet grew no sites at all: walk the lattice itself, same
  // margin, same biome preference, same lowest-index determinism.
  let anyDry: HikeSpawn | null = null;
  for (let c = 0; c < topo.n; c++) {
    const cand = at(c);
    if (cand.dryM < DRY_MARGIN_M) continue;
    if (!anyDry) anyDry = cand;
    if (cand.biome === 1 || cand.biome === 2) return cand;
  }
  if (anyDry) return anyDry;
  throw new Error(
    `nature-hike: this planet has no land ${DRY_MARGIN_M} m above sea level to stand on`,
  );
}

/**
 * Boot the hike: build the planet, anchor a wilderness chunk at its dry spawn
 * site, fly the camera down onto it, and run the quest host as a WALKER inside
 * it.
 *
 * WHAT THIS BOOT NOW OWNS (stage N2R — the boot became the loader):
 *   • the AUTO-DESCENT (ruling 3b) — the camera is the boot's until touchdown,
 *     then handed to the host's chase rig (setDriveCamera). ⑤
 *   • the SPARK FEED — the gaze's ground point per frame as the created
 *     avatar's leader (setSpiritPosition). Without it the avatar stands still,
 *     because in attached-avatar mode the local body IS the parked spark. ⑥
 *   • the ROSTER forward — setPeers straight through to the host, which
 *     reconciles one created body per member (owner-side).
 *   • the SPECIES — `avatar_species` off the loaded manifest, lowered into
 *     `start` the same way `avatarKind` is lowered into `spirit`.
 *
 * ⚠️ WHAT IS STILL SINGLE-PLAYER HERE (Phase 4 owns these — listed so they are
 * not rediscovered):
 *   • REPLICATED ANCHOR, APPLIED AT BOOT (N6c-g): a peer that is its session's
 *     AUTHORITY announces each re-anchor as a session-control `anchor`
 *     envelope, and a peer BOOTING into that session now stands its chart on
 *     that stated datum instead of computing its own (⑧) — which is what puts
 *     both sides of a merge on ONE chart. Still open: a LIVE world does not
 *     rebase onto a later announcement (the chart re-anchors on the local
 *     walker alone, maybeRebaseWild), so same-session peers still drift apart
 *     between boots. Rebasing a live chart under a playing person is a
 *     motion-comfort question, not a plumbing one, and is deliberately left.
 *   • BIOME RE-SCATTER: the wild mix + fauna are chosen ONCE from the boot
 *     cell's biome. A re-anchor that crosses a biome band moves the chart but
 *     keeps forest content over steppe ground — the re-scatter rule is a
 *     genuine plan gap, not an oversight.
 *   • the fauna herd is minted and retired locally, and the board is CLAIMED at
 *     boot because this boot only ever runs when the walker is here.
 */
export function bootPlanetHike(
  container: HTMLElement,
  loaded: LoadedWorld,
  setStatus: (text: string, error?: boolean) => void,
  sharedBoard: SharedBoard,
  multiplayer?: QuestMultiplayer,
  /** In-game character voice. Omitted ⇒ the host builds the default
   *  speechSynthesis voice. main.ts passes one that ANNOUNCES its speech to
   *  the platform (games-bridge `game_speech`) so the AAC can gate its mic. */
  voice?: NpcVoice | null,
  /** The AAC platform's session locale (main.ts `initLocale`), lowered into
   *  the host's SessionMeta snapshot — the bundled spec cannot know it, and
   *  it must never be smuggled into `game.world` (see main.ts loadSpec).
   *  Omitted (standalone play / init never arrived) ⇒ the spec's own
   *  `game.meta.locale` stands. Snapshotted at boot: a locale that changes
   *  mid-session takes effect on the next reboot, not live. */
  locale?: string,
): QuestBoot {
  const t0 = performance.now();
  const settings = loaded.game!;

  // ── ① THE PLANET ──────────────────────────────────────────────────────────
  const built = buildPlanetWorld(settings);
  const radius = built.spec.radius;

  // ── DOM scaffold: the stage (canvas + HUD overlays). The button board is NOT
  //    part of this scaffold — it is the game's persistent top-level chrome
  //    (SharedBoard); this boot just claims it. ──────────────────────────────
  const root = el("div", "quest-root", container);
  const stage = el("div", "quest-stage", root);
  const canvas = el("canvas", "quest-canvas", stage);
  const toastEl = el("div", "quest-toast", stage);
  const winEl = el("div", "quest-win", stage);
  toastEl.hidden = true;
  winEl.hidden = true;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  // ⚖️ DAYLIGHT, NOT SPACE. The lab's vacuum planet is watched from orbit, so
  // it hangs against black; this game is only ever ON the ground, where a black
  // sky reads as broken rather than as "no atmosphere yet". A flat daylight
  // clear colour is the honest zero-cost stand-in until an atmosphere shell
  // exists (planet_day_night_atmosphere) — no engine change either way.
  scene.background = new THREE.Color(0x9fc4e8);

  // Ground-scale clip planes. The lab's planet camera uses SPACE planes
  // (near = radius·0.0002) because it starts in orbit; standing on the surface
  // that near plane would slice the walker out of its own chase shot, so the
  // near plane is a person's arm-length and the far plane still clears the
  // whole visible cap of a body this size (horizon ≈ √(2·R·h)).
  const camera = new THREE.PerspectiveCamera(55, 1, 0.2, radius * 4);

  const planetGroup = new THREE.Group();
  planetGroup.name = "planet-root";
  const planetObj = createPlanetObject(built.surface, {
    resolution: 33, maxDepth: 18, buildBudget: 1,
    ocean: { color: 0x1a4f7a },
  });
  planetGroup.add(planetObj.group);
  scene.add(planetGroup);

  // A lone planet has no star — its own sun + sky fill (bootPlanetScope's
  // rig). The quest renderer adds its OWN lights for the bodies it draws under
  // the anchor; both light the whole scene, exactly as in the lab.
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(1, 0.7, 0.6);
  const fill = new THREE.HemisphereLight(0xbcd4ff, 0x141a28, 0.5);
  scene.add(sun, fill);

  // ── ② THE CHUNK: a surface anchor at the spawn site ───────────────────────
  const spawn = pickSpawn(built);

  // ── ⑧ WHERE THIS CHART STANDS (stage N6c-g) ───────────────────────────────
  // `pickSpawn` is deterministic in the world seed ALONE, which is exactly what
  // a first boot wants: every peer computes the same cell and they all start on
  // one chart. After a split or a merge that is no longer the right answer —
  // the session has moved, and rebuilding at the seed site would teleport the
  // player back to the start of the hike (and land the two sides of a merge on
  // two different charts, which is the drift N2 recorded as a risk).
  //
  // So the datum is resolved in PRECEDENCE, most-stated first:
  //   1. THE SESSION'S STATED ANCHOR — an `anchor` envelope for the session
  //      this world is being built for, announced by its AUTHORITY and handed
  //      here by main.ts (which owns the freshness rule — see `replayControl`).
  //      It outranks everything else BECAUSE THE STREAM IS IN THAT CHART: the
  //      authority hosts the sim and its avatar packets are chart-local, so the
  //      authority's chart is the one a member has to stand on. This is what
  //      puts both sides of a merge on ONE chart — the joiner adopts the
  //      survivor's datum instead of computing its own. (An authority never
  //      adopts one: the only peer entitled to state this session's chart is
  //      itself, and it does not receive its own announcements.)
  //   2. THE COORDINATOR'S CENTROID for this session, off the assignment
  //      itself. No authority has stated a chart yet (nobody has re-anchored,
  //      or the announcement has not arrived) — and this is the one datum every
  //      member of the session derives IDENTICALLY from a word they all
  //      received, so peers that boot together still boot onto one chart.
  //   3. MY OWN LAST PRESENCE, when I boot as this session's AUTHORITY and even
  //      the centroid is unusable (degenerate direction, or over water). My
  //      chart is about to BE this session's chart, so where the player is
  //      standing is the honest datum; a follower has no such claim and falls
  //      through to the seed site instead.
  //   4. THE SEED SITE — solo play, first boot, and every case above declined.
  // A datum over water is refused at every level (the same shoreline hold ④
  // applies to a re-anchor) and falls through to the next.
  //
  // ⚠️ THE SCATTER SEED DOES NOT MOVE WITH IT. `wildSeed` stays the spawn
  // CELL's below, so peers of one session still grow the same country from the
  // same number. This is the SAME already-ledgered gap a floating-origin
  // re-anchor has (the chart crosses a biome band and keeps the boot cell's
  // mix) — not a new one, and re-scattering per-peer would guarantee the two
  // sides of a merge disagreed about what grows here.
  const bootSession = multiplayer?.session ?? null;
  const replayedControl: SessionControl[] = [];
  for (const raw of multiplayer?.replayControl ?? []) {
    const parsed = parseSessionControl(raw);
    if (parsed) replayedControl.push(parsed);
  }
  const chartDatum = ((): { dir: THREE.Vector3; from: HandoverStatus["chart"] } => {
    /** A planet-frame direction as a usable chart datum: unit, finite, dry. */
    const dryDir = (loc: SessionAnchor | null | undefined): THREE.Vector3 | null => {
      if (!loc) return null;
      const v = new THREE.Vector3(loc.d[0], loc.d[1], loc.d[2]);
      const len = v.length();
      if (!Number.isFinite(len) || len < 1e-6) return null;
      v.multiplyScalar(1 / len);
      return built.surface.heightAt([v.x, v.y, v.z]) >= 0 ? v : null;
    };
    if (bootSession) {
      // Latest wins: main.ts hands the anchors it still considers current, and
      // a session's own book is epoch-monotonic besides.
      let stated: SessionAnchor | null = null;
      for (const env of replayedControl) {
        if (env.sc === "anchor" && env.sessionId === bootSession.sessionId) stated = env.loc;
      }
      const adopted = dryDir(stated);
      if (adopted) return { dir: adopted, from: "announced" };
      const centroid = dryDir(bootSession.anchor);
      if (centroid) return { dir: centroid, from: "centroid" };
      if (bootSession.role === "owner") {
        const carried = dryDir(multiplayer?.carriedLoc);
        if (carried) return { dir: carried, from: "carried" };
      }
    }
    return { dir: spawn.dir.clone(), from: "spawn" };
  })();

  let wildDir = chartDatum.dir;
  let wildElev = Math.max(0, built.surface.heightAt([wildDir.x, wildDir.y, wildDir.z]));

  // The anchor's LOCAL frame IS the SurfaceChart at this point (+Y out), so
  // content authored in chart metres lands correctly wherever it mounts.
  const wildRoot = new THREE.Group();
  wildRoot.name = "wild-root";
  wildRoot.position.copy(wildDir).multiplyScalar(radius + wildElev);
  wildRoot.quaternion.setFromUnitVectors(_UP_Y, wildDir);
  planetGroup.add(wildRoot);
  // Sim coords run 0..WILD_SIDE with the anchor at the CENTER (the same child
  // registration a town uses).
  const wildAnchor = new THREE.Group();
  wildAnchor.name = "wild-anchor";
  wildAnchor.position.set(-WILD_SIDE / 2, 0, -WILD_SIDE / 2);
  wildRoot.add(wildAnchor);
  wildRoot.updateWorldMatrix(true, true);

  let samplers = makeSurfaceSamplers(
    built.surface, radius, [wildDir.x, wildDir.y, wildDir.z], wildRoot,
  );
  // WRAPPERS, not the closures themselves: a floating-origin re-anchor swaps
  // the chart's samplers in place under the live sim.
  let wildGround = (x: number, y: number): number => samplers.ground(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
  let wildWater = (x: number, y: number): boolean => samplers.water(x - WILD_SIDE / 2, y - WILD_SIDE / 2);

  // The scatter/fauna seed is the CELL — an address on the planet, not a
  // session — so the same spot always grows the same country.
  const wildSeed = (spawn.cell * 2654435761) >>> 0;
  const fauna = faunaForBiome(spawn.biome);

  // ── GAZE PICKS LAND ON THE PIXELS, not on the sampler that approximates
  // them: the chunk draws no ground of its own, so the cursor ray is cast
  // against the planet's own streamed LOD chunks. Cached ~1 s (streaming mounts
  // and unmounts meshes) and re-checked per cast, because three's raycaster
  // does NOT skip invisible objects and a superseded LOD chunk still in the
  // graph would bury the cursor under the visible ground.
  let castMeshes: THREE.Mesh[] = [];
  let castMeshesAt = -1;
  const _castRay = new THREE.Raycaster();
  const drawnChunks = (): THREE.Mesh[] => {
    const out: THREE.Mesh[] = [];
    planetObj.group.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh || !o.name.startsWith("chunk_")) return;
      let n: THREE.Object3D | null = o;
      while (n && n !== planetObj.group) {
        if (!n.visible) return;
        n = n.parent;
      }
      out.push(o as THREE.Mesh);
    });
    return out;
  };
  const liveVisible = (o: THREE.Object3D): boolean => {
    let n: THREE.Object3D | null = o;
    while (n && n !== planetObj.group) {
      if (!n.visible) return false;
      n = n.parent;
    }
    return n === planetObj.group;
  };
  const castGroundRay = (
    origin: THREE.Vector3, dir: THREE.Vector3, far: number,
  ): THREE.Vector3 | null => {
    const t = performance.now();
    if (t - castMeshesAt > 800) {
      castMeshes = drawnChunks();
      castMeshesAt = t;
    }
    if (!castMeshes.length) return null;
    // Picks precede render(): a rebase may have just moved the world, so the
    // target matrixWorld is a frame stale — refresh before casting.
    for (const m of castMeshes) m.updateWorldMatrix(true, false);
    _castRay.set(origin, dir);
    _castRay.near = 0;
    _castRay.far = far;
    _castRay.camera = camera;
    const hits = _castRay.intersectObjects(castMeshes, false);
    const hit = hits.find((h) => h.object.parent && liveVisible(h.object)) ?? null;
    // Every hit stale ⇒ the cached list has drifted from what is on screen;
    // rebuild next call rather than waiting out the TTL.
    if (hits.length && !hit) castMeshesAt = -1;
    return hit ? hit.point : null;
  };

  const renderHost: RenderHost = { scene, camera, anchor: wildAnchor, castGroundRay };

  // ── ③ THE SESSION: open country as a real quest host ──────────────────────
  // QUESTLESS (Shape B): no goal-tree shell at all — `host.start(null)` builds
  // the session directly from the wilderness opts below; content and minds come
  // from the scatter. The meta the old `buildCreatureQuestWorld({ questCount:
  // 0 })` shell carried rides as the boot's SessionMeta override instead (the
  // SEED especially — convo/chat RNG reads `session.meta.seed`).

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let session: QuestSession | null = null;
  let host: QuestHost3D | null = null;
  // MULTIPLAYER ROSTER, as last delivered by main.ts. The live consumer is the
  // HOST (setPeers forwards it on arrival); this copy is the boot's own record
  // of who is here, read by the `__hikePeers` debug handle below (which is how
  // a browser pass tells "the platform never sent a roster" apart from "the
  // roster arrived and the host ignored it").
  let peers: Array<{ id: string; name?: string }> = [];

  const board: BoardIsland = sharedBoard.island;
  const boardHandlers: BoardHandlers = {
    select: (id, opts) => host?.select(id, opts),
    speak: (sentence, opts) => host?.speak(sentence, opts),
    selectPocket: (entityId) => host?.selectPocket(entityId),
    selectFamilyMember: (memberId) => host?.selectFamilyMember(memberId),
  };
  // Claimed at boot: unlike a town (mounted by proximity while the walker may
  // be elsewhere), this boot only ever runs when the walker is HERE.
  const releaseBoard = sharedBoard.claim(boardHandlers);

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
    /** ⑫ — who is standing in the player's conversation, for the builder's
     *  addressee slot. Captured by the bridge in main.ts. */
    addressees(list: string[]) { board.setAddressees?.(list); },
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
    objectives() { /* zero-quest world — no objectives strip out here */ },
    collect() { /* no-op in the wild */ },
    satchel() { /* the pocket goes up as world_hud, not as a stage strip */ },
    won() {
      winEl.textContent = "";
      winEl.hidden = false;
      const title = el("div", "quest-win-title", winEl);
      title.textContent = session?.game?.root.outro ?? session?.meta.title ?? "You did it!";
      const replay = el("button", "quest-replay", winEl);
      replay.textContent = "🔁 Play again";
      replay.addEventListener("click", () => host?.replay());
    },
  };

  // WHAT THE ENGINE SEES of this boot's multiplayer seam: everything, EXCEPT
  // that the coordinator's announcement pipe is withheld from a peer the
  // platform did not make host (see `coordinates` — one coordinator per world;
  // the missing `sendControl` is the engine's own inertness switch, so this is
  // a supported way to say "don't coordinate here", not a workaround). This
  // boot keeps the real pipe either way, for the anchor announce.
  const hostMultiplayer = ((): QuestMultiplayer | undefined => {
    if (!multiplayer || multiplayer.coordinates) return multiplayer;
    const { sendControl: _coordinatorPipe, ...withoutControl } = multiplayer;
    return withoutControl;
  })();

  host = createQuestHost3D({
    canvas,
    presenter,
    resolveImage: gameImageResolver,
    host: renderHost,
    groundAt: (x, y) => wildGround(x, y),
    waterAt: (x, y) => wildWater(x, y),
    // OWNER-AUTHORITATIVE MULTIPLAYER (absent ⇒ single-player, byte-identical).
    ...(hostMultiplayer ? { multiplayer: hostMultiplayer } : {}),
    // Absent ⇒ the host builds its own voice (standalone play, unchanged).
    ...(voice !== undefined ? { voice } : {}),
  });
  // WHAT GROWS AT THE SPAWN CELL, not merely what its biome index permits
  // (2026-09-01 — the niche join): the biome says "growing country", the
  // cell's own climate sample says WHICH useful plants stand in it, so a hike
  // on cold ground no longer meets a banana. Guarded because `climateSampleAt`
  // THROWS on an unclimated substrate — a planet baked without climate fields
  // hands `undefined` and gets the legacy seed-only pick, byte-identical.
  //
  // HOISTED (suitability-as-yield): the scatter's pick and the SESSION's own
  // sample are one question about one cell, so it is sampled ONCE and handed
  // to both — never twice, which is how two answers about the same ground get
  // a chance to differ.
  const spawnClimate =
    built.grid.fields.rain && built.grid.fields.tempC && built.grid.fields.height
      ? climateSampleAt(built.grid, spawn.cell)
      : undefined;
  host.start(null, null, {
    // The chunk stands on a real planet: the side matches the re-anchor math
    // and the rect is CONTENT extent, never a wall.
    wilderness: {
      seed: wildSeed,
      side: WILD_SIDE,
      bounded: false,
      mix: wildMixForBiome(spawn.biome, wildSeed, spawnClimate),
    },
    // The ground this session stands on — what a site founded here is worth,
    // asked of the same sample the scatter read. Absent ⇒ suitability 1.
    ...(spawnClimate ? { climate: spawnClimate } : {}),
    // WALKER: no `spirit` flag — so the host's own spec-driven switch resolves
    // avatarMode "creature" and CREATES this player a body (quest-host start).
    scale: sessionScale(settings.scale),
    // THE BODY'S SPECIES: `game.avatar_species` never reaches the host on its
    // own (a GoalTreeGame carries no manifest settings), so the boot that read
    // the manifest lowers it here — the exact same lowering path that turns
    // `avatarKind` into the `spirit` boolean. Always a string (the manifest
    // defaults it to "human"), so the host's settler-chain fallback is
    // simply never reached from this game.
    avatarSpecies: settings.avatarSpecies,
    // THE SESSION'S META: what the old shell's game.meta carried (same seed,
    // same title — the seed drives convo/chat RNG), plus THE SESSION'S LOCALE:
    // the platform's, when it stated one (session.meta.locale).
    meta: { seed: wildSeed, title: "Creature Quest Village", ...(locale ? { locale } : {}) },
  });
  (window as unknown as Record<string, unknown>).__questHike = host;
  (window as unknown as Record<string, unknown>).__hikePeers = (): Array<{ id: string; name?: string }> => peers;

  // HOST-EMBED CAMERA, TAKEN BACK FOR THE DESCENT: `start` hands the shared
  // camera to the grounded chase rig for an embedded host, but the fly-down IS
  // the loader (⑤) — so the boot revokes the drive immediately and returns it
  // at touchdown. The rig keeps easing its own state meanwhile (render3d only
  // skips the camera WRITE), and re-granting it nulls the rig's follow centre,
  // which is precisely the "grab the shot fresh, from behind the body" path.
  host.setDriveCamera(false);
  host.resize(canvas.clientWidth || 1, canvas.clientHeight || 1, window.devicePixelRatio || 1);

  const player = (): { x: number; y: number; fx: number; fy: number; vx: number; vy: number } | null =>
    host?.world?.state.avatars[PLAYER_ID] ?? null;

  // THE CREATED BODY. In attached-avatar mode the host spawns one creature per
  // session member under a fixed id convention (`npc_avatar_<peer>`, the peer
  // being this device's network id or the solo stand-in "local"), and THAT is
  // the thing that walks — PLAYER_ID stays the parked, formless spark. Anything
  // in this boot that means "where the player physically is" (the camera shot,
  // the chart re-anchor) has to read this body, not the spark.
  const AVATAR_BODY_ID = `npc_avatar_${multiplayer?.localId ?? "local"}`;
  const avatarBody = (): { x: number; y: number; fx: number; fy: number } | null =>
    host?.world?.state.avatars[AVATAR_BODY_ID] ?? null;
  /** The body the chart is kept centred on: the created avatar, else (spirit
   *  specs, or before the spawn) the local walker/spark. */
  const walker = (): { x: number; y: number } | null => avatarBody() ?? player();

  // Start at the chunk centre (the anchor point), facing north.
  {
    const p = player();
    if (p) {
      p.x = WILD_SIDE / 2;
      p.y = WILD_SIDE / 2;
      p.vx = 0;
      p.vy = 0;
      p.fx = 0;
      p.fy = 1;
    }
    // …and face the CREATED body the same way, so the descent's final framing,
    // the chase rig's first heading (it seeds camForward from the followed
    // body's facing) and the body itself all agree on which way "forward" is.
    const a = avatarBody();
    if (a) {
      a.fx = 0;
      a.fy = 1;
    }
  }

  // ── THE BIOME'S HERDS on top of the scatter: plain wander bodies (their
  // stream decorrelated from the scatter's, which consumed the same seed
  // inside buildWilderness). ────────────────────────────────────────────────
  const rng = mulberry(wildSeed ^ 0x9e3779b9);
  const place = (): { x: number; y: number } | null => {
    for (let tries = 0; tries < 8; tries++) {
      const x = 12 + rng() * (WILD_SIDE - 24);
      const y = 12 + rng() * (WILD_SIDE - 24);
      const dc = Math.hypot(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
      if (dc < 8) continue; // keep the spawn clear
      if (wildWater(x, y)) continue;
      return { x, y };
    }
    return null;
  };
  let horseSeq = 0;
  const spawnHorse = (): void => {
    const p = place();
    if (!p || !host) return;
    const id = `horse_${horseSeq++}`;
    host.session.npcIcons.set(id, "🐴"); // → ungulate body (quest-host FIXED_SPECIES_BY_ICON)
    host.world?.addNpc({
      id,
      x: p.x,
      y: p.y,
      behavior: { movement: "wander", wanderRadius: 30, home: { x: p.x, y: p.y }, speed: 1.4, conversationRadius: 3 },
    });
  };
  for (let i = 0; i < fauna.horses; i++) spawnHorse();

  const refreshFauna = (): void => {
    // A rebased herd whose mapped position fell far outside the fresh chunk is
    // out of the walker's world — retire it and let a new one graze here.
    // (A CLAIMED body is never retired: the player may be riding it.)
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
    for (let i = alive; i < fauna.horses; i++) spawnHorse();
  };

  // ── LOADER + SPARK STATE (used by ④, ⑤ and ⑥ below) ──────────────────────
  /** Has the fly-down finished and control passed to the player? Until it has,
   *  the boot owns the camera, the pointer does not reach the host, and the
   *  avatar has no leader to walk to. */
  let landed = false;
  /** The last aim point (client px) either input source produced — the ray the
   *  spark feed casts each frame. Null = nothing is being aimed at. */
  let lastAimClient: { x: number; y: number } | null = null;
  /** The last spark position handed to the host, in CHART-LOCAL sim metres —
   *  kept so a re-anchor can re-express it (the host's `spiritPos` is chart
   *  coordinates, and a rebase moves the chart out from under it). */
  let spiritLocal: { x: number; y: number } | null = null;

  // ── SESSION PRESENCE + THE SPLIT REACTION (stage N6b-g) ───────────────────
  // Three wires, every one of them inert until a coordinator speaks (solo play
  // is byte-identical, because nothing here has anything to say):
  //   • PRESENCE — where on the PLANET this player is. The engine never derives
  //     it: THIS file owns the planet frame (the chart, the datum, the radius,
  //     the mapping back onto the sphere), so the presence has to arrive from
  //     the boot that owns that mapping rather than be guessed at from a flat
  //     manifold. It feeds the ~1 Hz `loc` beacon and the session coordinator.
  //   • REACTION — the engine's session book is STORE-ONLY by law (it never
  //     boots or tears worlds, because world construction is the game's), so
  //     this poll reads it back and reports a changed membership up to main.ts,
  //     which owns the reboot.
  //   • ANCHOR ANNOUNCE — a session's AUTHORITY tells its members where its
  //     chart just re-anchored, so the whole session can eventually rebase onto
  //     one datum instead of each peer drifting onto its own.
  const sessionHost = (): PendingSessionHost | null => host as unknown as PendingSessionHost | null;
  /** How often presence is fed and the book re-read (the engine beacons at the
   *  same 1 Hz; a finer poll would only ask the same question twice). */
  const SESSION_POLL_S = 1;
  let sessionPollT = 0;
  /** This peer's place in the roster, as last read back — SEEDED with the
   *  membership main.ts built this world for (N6c-g). Seeding is not a
   *  shortcut: without it the first poll would report the booted membership
   *  back up as if it were news, and the anchor announce (and the handover
   *  readback below) would have to wait out a second of play to learn which
   *  session they belong to. */
  let myMembership: SessionMembership | null =
    bootSession ? { ...bootSession, members: [...bootSession.members] } : null;
  /** The planet-frame presence this world last stated (see `feedPresence`). */
  let lastPresence: SessionAnchor | null = null;

  const _plP = new THREE.Vector3();
  const _plV = new THREE.Vector3();
  /** A CHART-LOCAL sim point as PLANET-FRAME presence: a body-local unit
   *  direction plus elevation in metres. Exactly the chain the re-anchor runs
   *  (chart-local → world → planet-local → normalize), which is the whole
   *  reason the engine is allowed to ask us for it. */
  const chartLoc = (x: number, y: number): { d: [number, number, number]; e: number } => {
    wildAnchor.updateWorldMatrix(true, false);
    const world = wildAnchor.localToWorld(_plP.set(x, wildGround(x, y), y));
    planetGroup.updateWorldMatrix(true, false);
    const local = planetGroup.worldToLocal(_plV.copy(world));
    const r = local.length();
    // Degenerate (the planet's own centre): the anchor's datum is the honest
    // answer, and it is the one the chart is standing on anyway.
    if (r < 1e-3) return { d: [wildDir.x, wildDir.y, wildDir.z], e: wildElev };
    local.multiplyScalar(1 / r);
    return { d: [local.x, local.y, local.z], e: r - radius };
  };

  /** Feed this player's presence (the radius rides WITH the datum — one fact,
   *  never a stale start constant).
   *
   *  ⚖️ THE WALKER, NOT THE ANCHOR. Two peers sharing one chart stand up to a
   *  chunk apart, and the split threshold is a FRACTION of that chunk — an
   *  anchor-quantized presence would report them at distance zero and no
   *  session could ever split. */
  const feedPresence = (): void => {
    if (!multiplayer) return; // solo: nothing in the engine consumes a presence
    const w = walker();
    if (!w) return;
    const at = chartLoc(w.x, w.y);
    // Kept as well as fed: main.ts carries the last one across the reboot a
    // split forces (⑧ precedence 2 — `QuestBoot.planetLoc`).
    lastPresence = { d: [at.d[0], at.d[1], at.d[2]], e: at.e };
    sessionHost()?.setPlanetLoc?.(at.d, at.e, radius);
  };

  /** Re-read the session book and report a CHANGED membership upward.
   *
   *  A null book is NO NEWS, never a change: a freshly built host starts with
   *  an empty one (main.ts replays the roster in force straight after boot),
   *  and the coordinator re-announces only when the epoch moves. */
  const pollSession = (): void => {
    const localId = multiplayer?.localId;
    const onSession = multiplayer?.onSession;
    if (!localId || !onSession) return;
    const assignment = sessionHost()?.sessionAssignment?.() ?? null;
    if (!assignment) return;
    const next = sessionMembershipOf(assignment, localId);
    if (!next) return; // a roster that doesn't name us says nothing about us
    const prev = myMembership;
    const changed = !sameMembership(next, myMembership);
    myMembership = next; // the epoch freshens every pass; only identity reports
    if (!changed) return;
    // THE ROSTER MOVED AND MY CHART DID NOT: same session, same role, same
    // authority — this world keeps playing exactly where it stands, and the
    // peers rebuilding around it are choosing a chart RIGHT NOW (⑧), so it says
    // where "here" is before the embedder even reacts. A membership change that
    // DOES move my boot identity says nothing yet: that world is about to be
    // rebuilt, possibly onto a different datum, and `landOnSite` states the one
    // it actually stood on.
    const sameBoot =
      !!prev &&
      prev.sessionId === next.sessionId &&
      prev.role === next.role &&
      prev.authority === next.authority;
    if (sameBoot) announceAnchor();
    onSession(assignment);
  };

  /** ANCHOR ANNOUNCE — the AUTHORITY half only: this peer hosts its session's
   *  sim, so it states its chart's datum for the session on the reliable pipe.
   *  Three moments say it: a floating-origin re-anchor (④), a topology change
   *  that left this authority playing where it was (`pollSession`), and a boot
   *  that stood its chart on something other than the seed site (`landOnSite`).
   *
   *  APPLIED, since N6c-g: a member BOOTING into this session stands its chart
   *  on this datum (⑧) instead of computing its own, which is what lands both
   *  sides of a merge on one chart. A LIVE world still does not rebase onto a
   *  later announcement — that is a motion-comfort question (the ground would
   *  slide under a walking person), deliberately left. */
  const announceAnchor = (): void => {
    const send = multiplayer?.sendControl;
    const m = myMembership;
    if (!send || !m || m.role !== "owner") return;
    send(anchorControl(m.sessionId, m.epoch, { d: [wildDir.x, wildDir.y, wildDir.z], e: wildElev }));
  };

  // ── ⑨ SESSION HANDOVER — THE GAME'S HALF (stage N6c-g) ────────────────────
  // The engine assembles and applies; the GAME decides WHEN, and owns the two
  // things the engine deliberately refuses to guess: the planet frame (a
  // member's `loc` is only meaningful to the chart that maps it) and world
  // construction (a payload may only be applied to a session that was just
  // built for it). Everything below is feature-detected — on the vendored
  // snapshot that predates `assembleSessionHandover` / `applySessionHandover` /
  // `sessionHandoverMembers`, every path here declines and the game behaves
  // exactly as it did at N6b-g.
  let received: HandoverOutcome = "none";
  let handoverMembers = 0;
  let handoverPlaced = 0;
  let handoverOffChart = 0;
  let handoverDonated = 0;
  let handoverRelaid = 0;
  let handoverLate = 0;
  const handoverRefusals: HandoverRefusalView[] = [];
  /** Members an accepted payload named, mapped into THIS chart, waiting for
   *  their body to exist (the owner spawns one per roster member on
   *  `setPeers`, which main.ts calls right after the boot returns). */
  const pendingPlacements = new Map<string, { x: number; y: number }>();

  /** The two payload fields this game reads — see the HANDOVER VIEWS note. */
  const refusalsOf = (payload: unknown): HandoverRefusalView[] => {
    const list = (payload as { refusals?: unknown } | null)?.refusals;
    return Array.isArray(list) ? (list as HandoverRefusalView[]) : [];
  };
  const wildCountOf = (payload: unknown): number => {
    const list = (payload as { wild?: unknown } | null)?.wild;
    return Array.isArray(list) ? list.length : 0;
  };
  /** Refusals are LOUD, never silent: a split that left something behind is
   *  exactly what a two-window pass needs to be able to see. No GUI (ruling 4)
   *  — the console and the `__hikeSession()` handle. */
  const noteRefusals = (what: string, list: HandoverRefusalView[]): void => {
    for (const r of list) {
      handoverRefusals.push(r);
      // eslint-disable-next-line no-console
      console.warn(`[handover] ${what} refused (${r.where ?? "?"} ${r.key ?? "?"}): ${r.note ?? ""}`);
    }
  };

  /** PLANET FRAME → THIS CHART: the exact inverse of `chartLoc` above, and the
   *  reason the engine hands members over as `{d, e}` at all — the planet frame
   *  is the only one two sessions share, and only the boot that owns the chart
   *  can map back out of it. Null when the direction is degenerate. */
  const _hoP = new THREE.Vector3();
  const chartOf = (loc: { d: [number, number, number]; e: number }): { x: number; y: number } | null => {
    const len = Math.hypot(loc.d[0], loc.d[1], loc.d[2]);
    if (!Number.isFinite(len) || len < 1e-6) return null;
    _hoP.set(loc.d[0], loc.d[1], loc.d[2]).multiplyScalar((radius + loc.e) / len);
    planetGroup.updateWorldMatrix(true, false);
    planetGroup.localToWorld(_hoP);
    wildAnchor.updateWorldMatrix(true, false);
    wildAnchor.worldToLocal(_hoP);
    return { x: _hoP.x, y: _hoP.z };
  };

  /** Put a handed-over member's body where the payload says they stand.
   *
   *  ⚖️ NEVER CLAMPED. A member whose mapped position falls outside this chart
   *  is left on the engine's own spawn fan-out and COUNTED (`offChart`): a
   *  clamped body is a lie about where somebody is standing, and the honest
   *  report is what tells the next stage the chart datum was wrong. */
  const placeHandoverBodies = (): void => {
    const w = host?.world;
    if (!w || pendingPlacements.size === 0) return;
    const self = multiplayer?.localId ?? "local";
    for (const [peerId, at] of [...pendingPlacements]) {
      const body = w.state.avatars[`npc_avatar_${peerId}`];
      if (!body) continue; // not spawned yet — the next setPeers brings it
      pendingPlacements.delete(peerId);
      body.x = at.x;
      body.y = at.y;
      body.vx = 0;
      body.vy = 0;
      handoverPlaced++;
      // MY OWN BODY drags the spark with it. The wilderness seeds `spiritPos`
      // at the chunk's spawn point, and in attached-avatar mode the body walks
      // to the spark — so a body placed away from the centre would immediately
      // set off for it. The spark stands where the body stands until the
      // player aims at something.
      if (peerId === self) {
        spiritLocal = { x: at.x, y: at.y };
        host?.setSpiritPosition(at.x, at.y);
      }
    }
  };

  /** RECEIVER HALF. Read the handover stored for the session this world was
   *  built for, and apply it before play proceeds.
   *
   *  ⚖️ THE WAIT IS BOUNDED AND IT NEVER POLLS. The engine's contract is "call
   *  it right after `start()`, before the session has been played", and this
   *  boot has a natural un-played window that costs nothing: THE DESCENT. The
   *  world is built and stepping, the player has no control at all (⑤), and at
   *  touchdown they get it. So a payload present at boot is applied at boot; a
   *  payload that lands mid-descent is applied then; a payload that lands after
   *  touchdown is LOGGED AND DROPPED, because applying one to a world somebody
   *  is already playing would replace the wild under their feet. A donor that
   *  crashed before donating, or a payload that never comes, simply leaves this
   *  peer on its from-seed scatter — the plan's accepted v1 loss, unchanged. */
  const applyStoredHandover = (): HandoverOutcome => {
    // ONE payload per world, and the verdict of the attempt that mattered is
    // never overwritten by a later "nothing to do".
    if (received === "applied") return "done";
    const m = myMembership;
    const h = sessionHost();
    if (!m || m.role !== "owner" || !h) return (received = "none");
    const stored = h.sessionHandoverOf?.(m.sessionId) ?? null;
    if (!stored) return (received = "none");
    if (!h.applySessionHandover) return (received = "unavailable");
    if (landed) {
      handoverLate++;
      // eslint-disable-next-line no-console
      console.warn(`[handover] payload for ${m.sessionId} from ${stored.from} arrived after play began — dropped`);
      return "late";
    }
    const ok = h.applySessionHandover(stored.payload) === true;
    noteRefusals(`incoming ${m.sessionId}`, refusalsOf(stored.payload));
    if (!ok) return (received = "declined");
    received = "applied";
    // WHERE THEY STAND is ours to work out: map every member's planet loc onto
    // this chart and hold it until the body exists.
    for (const member of h.sessionHandoverMembers?.() ?? []) {
      handoverMembers++;
      if (!member.loc) continue;
      const at = chartOf(member.loc);
      const inset = 2;
      if (!at || at.x < inset || at.y < inset || at.x > WILD_SIDE - inset || at.y > WILD_SIDE - inset) {
        handoverOffChart++;
        continue;
      }
      pendingPlacements.set(member.id, at);
    }
    placeHandoverBodies(); // the local body exists from `start`
    return "applied";
  };

  /** DONOR HALF. Assemble what the departing cluster takes with it — and mind
   *  the fold.
   *
   *  🚨 `assembleSessionHandover` CONDENSES THIS SESSION'S WILD SLICE IN PLACE.
   *  The engine's contract says so in as many words, and it is right to: the
   *  call is written for the departing authority's LAST ACT, where the world is
   *  coming down anyway. But a SPLIT does not always take the donor with it —
   *  when a cluster walks away from a session whose id, role and authority all
   *  stay put, the donor keeps playing, and an unguarded assemble would fold
   *  the forest out from under a player who never left. There is no public door
   *  back (`unfoldWildArea` is the engine's own), except the receiving half
   *  itself — so a donor that keeps playing RE-LAYS the very record it just
   *  sent, `applySessionHandover(payload)` on its own host.
   *
   *  What that costs, stated plainly: both authorities then hold the same
   *  evolved stand. That is not new duplication — every peer of this game
   *  already scatters its own copy of the wilderness from the shared seed, and
   *  each authority's own audit stays balanced (fold: live → record; re-lay:
   *  record → live). What it BUYS is that the state which travels is the state
   *  that was played, on both sides, instead of the donor being punished for
   *  donating.
   *
   *  The re-lay is skipped when the wild fold was REFUSED (F-④): then nothing
   *  was folded, the stands are still standing, and applying the payload would
   *  fold them for real. */
  const donateHandover = (
    memberIds: string[],
    opts: { keepPlaying: boolean },
  ): { payload: unknown; refusals: HandoverRefusalView[]; relaid: boolean } | null => {
    const h = sessionHost();
    if (!h?.assembleSessionHandover || !host?.world) return null;
    const payload = h.assembleSessionHandover(memberIds);
    if (!payload) return null; // no live session to hand over
    handoverDonated++;
    const refusals = refusalsOf(payload);
    noteRefusals(`outgoing ${myMembership?.sessionId ?? "?"}`, refusals);
    let relaid = false;
    if (opts.keepPlaying) {
      const wildRefused = refusals.some((r) => r.where === "wild");
      if (!wildRefused && wildCountOf(payload) > 0 && h.applySessionHandover) {
        relaid = h.applySessionHandover(payload) === true;
        if (relaid) handoverRelaid++;
        // eslint-disable-next-line no-console
        else console.warn("[handover] donor stayed live but the re-lay was declined — the wild slice is folded");
      }
    }
    return { payload, refusals, relaid };
  };

  // THE ENVELOPES IN FORCE, FILED INTO THIS FRESH HOST — the same replay law
  // main.ts applies to the assignment, for the same reason: a reboot builds a
  // brand-new host whose session book is EMPTY, and an anchor or a handover is
  // announced once. Handed RAW (the engine validates its own envelopes), and
  // then read back through the engine's own door — this game never treats its
  // copy as the truth, it re-files it and asks.
  for (const raw of multiplayer?.replayControl ?? []) sessionHost()?.applySessionControl?.(raw);
  // …and the receiver's half runs HERE: `start` has run, the world exists, and
  // the descent has not handed the player control yet.
  applyStoredHandover();

  // ── ④ FLOATING-ORIGIN RE-ANCHOR (no invisible walls, no remount): when the
  // walker strays toward the chunk's edge, MOVE the surface anchor to where
  // they stand and re-express the live sim in the new chart — same world, same
  // bodies, same camera; world poses are unchanged by construction. The PLANET
  // is the reference frame; the chart is just the 2D engine's window onto it.
  const MARGIN = 24;
  const _rbPrev = new THREE.Matrix4();
  const _rbDelta = new THREE.Matrix4();
  const _rbQ = new THREE.Quaternion();
  const _rbV = new THREE.Vector3();
  const _rbP = new THREE.Vector3();
  const _rbS = new THREE.Vector3();
  function maybeRebaseWild(): void {
    // ⚠️ THE AVATAR, NOT THE SPARK. In attached-avatar mode PLAYER_ID is
    // stationary by construction (the host refuses pointer steering of it —
    // that is the whole no-second-movement-door rule), so a chart that
    // re-anchors on the spark would never re-anchor at all, and the created
    // body would walk clean off the 320 m chunk into ever-worse curvature
    // correction. `walker()` reads the body that actually moves.
    const p = walker();
    if (!p) return;
    if (p.x > MARGIN && p.x < WILD_SIDE - MARGIN && p.y > MARGIN && p.y < WILD_SIDE - MARGIN) return;
    // The walker's WORLD position through the CURRENT chart names the new anchor.
    wildAnchor.updateWorldMatrix(true, false);
    const gOld = wildGround;
    const worldPos = wildAnchor.localToWorld(_rbP.set(p.x, gOld(p.x, p.y), p.y));
    planetGroup.updateWorldMatrix(true, false);
    const local = planetGroup.worldToLocal(_rbV.copy(worldPos));
    const r = local.length();
    if (r < 1e-3) return;
    const dir = local.multiplyScalar(1 / r).clone();
    const dirArr: [number, number, number] = [dir.x, dir.y, dir.z];
    if (built.surface.heightAt(dirArr) < 0) return; // at a shoreline: hold this chart, retry on land
    _rbPrev.copy(wildAnchor.matrixWorld);
    // Move the SAME anchor group (the render scene hangs under it and rides along).
    const h0 = Math.max(0, built.surface.heightAt(dirArr));
    wildDir = dir;
    wildElev = h0;
    wildRoot.position.copy(dir).multiplyScalar(radius + h0);
    wildRoot.quaternion.setFromUnitVectors(_UP_Y, dir);
    wildRoot.updateWorldMatrix(true, true);
    samplers = makeSurfaceSamplers(built.surface, radius, dirArr, wildRoot);
    wildGround = (x, y) => samplers.ground(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
    wildWater = (x, y) => samplers.water(x - WILD_SIDE / 2, y - WILD_SIDE / 2);
    // delta: new-anchor local ← old-anchor local; sim POINTS lift at the OLD
    // chart's ground height (they sit ON the surface — a y=0 lift would smear
    // them sideways by chart tilt × elevation), VECTORS take the rotation only.
    _rbDelta.copy(wildAnchor.matrixWorld).invert().multiply(_rbPrev);
    _rbQ.setFromRotationMatrix(_rbDelta);
    // THE SPARK RIDES ALONG. `session.spiritPos` is chart coordinates the host
    // owns but the WORLD rebase does not touch, so a held spark (the player is
    // looking away, or at the sky) would otherwise name a point in the chart
    // that just ceased to exist — the avatar would set off for the wrong place.
    // Same point mapping the sim rebase uses below, own scratch vector so the
    // closures cannot trip over it.
    if (spiritLocal) {
      _rbS
        .set(spiritLocal.x, gOld(spiritLocal.x, spiritLocal.y), spiritLocal.y)
        .applyMatrix4(_rbDelta);
      spiritLocal = { x: _rbS.x, y: _rbS.z };
      host?.setSpiritPosition(spiritLocal.x, spiritLocal.y);
    }
    host?.world?.rebase(
      (q) => {
        _rbV.set(q.x, gOld(q.x, q.y), q.y).applyMatrix4(_rbDelta);
        return { x: _rbV.x, y: _rbV.z };
      },
      (v) => {
        _rbV.set(v.x, 0, v.y).applyQuaternion(_rbQ);
        return { x: _rbV.x, y: _rbV.z };
      },
    );
    host?.rebaseLocal(_rbDelta);
    refreshFauna();
    // The cursor cast list is keyed to meshes, not to the chart, but the chart
    // moved under it — rebuild on the next pick rather than casting stale
    // world matrices.
    castMeshesAt = -1;
    // THE DATUM MOVED. Restate this player's presence at once rather than
    // waiting out the 1 Hz poll (the chart just jumped), and — if this peer is
    // its session's authority — tell the session where its chart now sits.
    feedPresence();
    announceAnchor();
  }

  // ── THE STATUS LINE (debug chrome — hidden when embedded; ruling 4 forbids
  // any NEW GUI, and this is the one that already exists). ──────────────────
  const biomeName = ["barren", "forest", "steppe", "grazing range"][spawn.biome] ?? "wild";
  const siteLine =
    `${built.spec.geology.seed} · planet r${radius} · ${built.sites.length} sites · ` +
    `spawn cell ${spawn.cell} (${biomeName}, ${spawn.dryM.toFixed(1)}m dry)`;
  // The BUILD cost, sampled here — not at touchdown, which would report the
  // descent's own four seconds as if the world had taken that long to make.
  const buildMs = Math.round(performance.now() - t0);
  const groundStatus = (): string =>
    `${siteLine} · built ${buildMs}ms · look to walk · dwell on a creature to talk`;

  // ── ⑤ THE DESCENT — THE LOADER ────────────────────────────────────────────
  // Space to spawn site, on rails, while the planet's quadtree refines under
  // the camera. Nothing the player does drives it (ruling 3b: "it's just how
  // the area gets loaded"), and at touchdown the camera goes to the host's
  // chase rig, which is already pointed at the created body (setFollowBody).
  //
  // ⚠️ COORDINATE SPACE — the trap the lab paid for and this does not:
  // the lab first reused the streaming galaxy's drone.place(camera), which
  // assumes a FLOATING-ORIGIN scene (world rebased so the ground point sits
  // near the origin). This planet never rebases — `planetGroup` sits at the
  // true origin for the whole boot — so that placement parked the camera ~200 m
  // from the origin, i.e. deep inside a 5 km-radius core, backface-culled to a
  // blank screen. THE POSE IS THEREFORE BUILT IN CHART-LOCAL METRES AND LIFTED
  // THROUGH `wildAnchor.matrixWorld` — the identical construction render3d's
  // own placeCamera uses for the grounded rig (and the identical frame the sim
  // runs in), so the descent lands in true world coordinates by the same
  // arithmetic the handoff target uses, every frame, with no assumption about
  // where the origin is.
  //
  // ⚠️ UP-VECTOR — the second trap: a lookAt whose up is parallel to its
  // forward has a degenerate basis (the lab's first attempt aimed straight down
  // with the radial direction as up and drew garbage). Here the shot holds a
  // near-CONSTANT depression by construction — the camera's lateral stand-off
  // is a fixed fraction of its altitude — so the radial up (the sphere tangent
  // frame's normal, taken off the live anchor matrix, exactly as placeCamera
  // takes it) never comes within 18° of the view axis: measured over the whole
  // fall on this planet, |up · forward| peaks at 0.948, against the 0.995 the
  // engine's OWN overhead rig pose already runs at happily. A guard swaps in
  // the frame's NORTH tangent if a future tuning ever aims it straight down.
  const DESCENT_MS = 4000;
  /** Sky height the fall starts from: high enough to read as "the planet",
   *  clamped so a tiny or a huge body both start somewhere sane. */
  const DESCENT_START_ALT_M = Math.max(1500, Math.min(radius, 12000));
  /** Touchdown pose, in the chase rig's own terms (world-tunables: overhead is
   *  24 m up / 2.5 m back, shoulder is 11 / 10.5) — deliberately between them,
   *  so the handoff pops by a couple of metres whichever pose the rig eases to. */
  const DESCENT_END_ALT_M = 18;
  const DESCENT_END_BACK_M = 6;
  const DESCENT_LOOK_AHEAD_M = 4;
  const DESCENT_LOOK_HEIGHT_M = 1.2;
  /** Stand-off per metre of altitude — constant, which is what keeps the view
   *  axis away from the up vector the whole way down. */
  const DESCENT_BACK_RATIO = DESCENT_END_BACK_M / DESCENT_END_ALT_M;

  const _dPos = new THREE.Vector3();
  const _dLook = new THREE.Vector3();
  const _dUp = new THREE.Vector3();
  const _dFwd = new THREE.Vector3();
  let descentMs = 0;
  let lastDescentStatus = -1;

  /** Where the shot is aimed, in CHART-LOCAL sim metres: the created body if it
   *  exists, else the chart centre (which is also the wilderness spawn). */
  const shotCentre = (): { x: number; y: number } => {
    const a = avatarBody() ?? player();
    return a ? { x: a.x, y: a.y } : { x: WILD_SIDE / 2, y: WILD_SIDE / 2 };
  };
  /** Which way the body faces, chart-local unit 2-vector (north when unset). */
  const shotForward = (): { x: number; y: number } => {
    const a = avatarBody();
    const l = a ? Math.hypot(a.fx, a.fy) : 0;
    return a && l > 1e-3 ? { x: a.fx / l, y: a.fy / l } : { x: 0, y: 1 };
  };

  /** Pose the camera for one frame of the fall, at `alt` metres above the site. */
  const placeDescentCamera = (alt: number): void => {
    const c = shotCentre();
    const f = shotForward();
    const back = alt * DESCENT_BACK_RATIO;
    wildAnchor.updateWorldMatrix(true, false);
    const m = wildAnchor.matrixWorld;
    // CHART-LOCAL (x, up, y) → WORLD, through the live anchor.
    _dPos.set(c.x - f.x * back, alt, c.y - f.y * back).applyMatrix4(m);
    _dLook
      .set(c.x + f.x * DESCENT_LOOK_AHEAD_M, DESCENT_LOOK_HEIGHT_M, c.y + f.y * DESCENT_LOOK_AHEAD_M)
      .applyMatrix4(m);
    _dUp.set(0, 1, 0).transformDirection(m);
    _dFwd.copy(_dLook).sub(_dPos).normalize();
    if (Math.abs(_dFwd.dot(_dUp)) > 0.995) _dUp.set(0, 0, 1).transformDirection(m);
    camera.up.copy(_dUp);
    camera.position.copy(_dPos);
    camera.lookAt(_dLook);
    // DEPTH RANGE: the ground near plane (0.2 m) against a 20 km far plane is
    // 1e5 of range — from 5 km up the planet's own skin z-fights itself. Scale
    // the near plane with altitude and let it settle back to arm's length.
    const near = Math.max(0.2, alt * 0.002);
    if (Math.abs(near - camera.near) > near * 0.05) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  };

  /** Touchdown: the player gets the world. */
  const landOnSite = (): void => {
    if (landed) return;
    landed = true;
    camera.near = 0.2;
    camera.updateProjectionMatrix();
    // The rig re-grabs its follow centre on this call and seeds its heading
    // from the followed body's facing — the shot ends up ON the avatar.
    host?.setDriveCamera(true);
    // Whatever the pointer/gaze was resting on during the fall now becomes a
    // live aim (it was withheld while the boot owned the camera).
    if (lastAimClient) host?.setPointer(lastAimClient.x, lastAimClient.y);
    setStatus(groundStatus());
    // The player is ON the planet now — state where, so the first beacon (and
    // any coordinator waiting on a second located member) doesn't wait a frame
    // longer than it has to.
    feedPresence();
    // A chart that was stood on something OTHER than the seed site (⑧) is a
    // fact the session does not know yet: this authority states it once, here,
    // so the next peer to boot into this session lands on the same chart
    // instead of waiting for the first floating-origin re-anchor to say so. A
    // plain seed-site boot stays silent — every peer computes that one.
    if (chartDatum.from !== "spawn") announceAnchor();
  };

  const stepDescent = (dt: number): void => {
    descentMs = Math.min(DESCENT_MS, descentMs + dt * 1000);
    const t = descentMs / DESCENT_MS;
    const s = t * t * (3 - 2 * t); // smoothstep: ease out of the sky, ease onto the ground
    // GEOMETRIC in altitude, not linear: halving the height takes the same time
    // at 4 km as at 40 m, which is what makes a fall from orbit read as steady
    // rather than as a plummet followed by a crawl.
    const alt = DESCENT_START_ALT_M * Math.pow(DESCENT_END_ALT_M / DESCENT_START_ALT_M, s);
    placeDescentCamera(alt);
    const pct = Math.round(t * 20) * 5;
    if (pct !== lastDescentStatus) {
      lastDescentStatus = pct;
      setStatus(`${siteLine} · descending ${Math.round(alt)} m`);
    }
    if (descentMs >= DESCENT_MS) landOnSite();
  };

  // ── ⑥ THE SPARK FEED (what makes the avatar walk) ─────────────────────────
  // ATTACHED-AVATAR mode: the created body follows `session.spiritPos` through
  // the ordinary party-follow loop, and NOTHING sets that unless the boot does.
  // The gaze ray is cast at the DRAWN planet chunks (castGroundRay — the same
  // hit the engine's own picker prefers, because the cursor must sit on the
  // pixels the player sees), and the hit is pulled back through the anchor into
  // CHART-LOCAL sim metres — the same space the wild session sims in, the same
  // conversion the lab's fixed feed does with `ladder.focusWorld →
  // wildAnchor.worldToLocal → setSpiritPosition`.
  //
  // Spaces, named: aim is CLIENT px → NDC of the canvas → a WORLD ray →
  // a WORLD hit → CHART-LOCAL (x, y) via wildAnchor.worldToLocal (z becomes y).
  const _fRayO = new THREE.Vector3();
  const _fRayD = new THREE.Vector3();
  const _fHit = new THREE.Vector3();
  const _fPlanePt = new THREE.Vector3();
  const _fPlaneN = new THREE.Vector3();
  const _fPlane = new THREE.Plane();
  const _fRay = new THREE.Ray();
  const feedSpark = (): void => {
    if (!landed || !host || !lastAimClient) return; // no aim ⇒ the spark HOLDS
    const r = canvas.getBoundingClientRect();
    const w = r.width || 1;
    const h = r.height || 1;
    const nx = ((lastAimClient.x - r.left) / w) * 2 - 1;
    const ny = -(((lastAimClient.y - r.top) / h) * 2 - 1);
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return; // aimed off the stage
    camera.updateMatrixWorld(true);
    _fRayO.setFromMatrixPosition(camera.matrixWorld);
    _fRayD.set(nx, ny, 0.5).unproject(camera).sub(_fRayO).normalize();
    const hit = castGroundRay(_fRayO, _fRayD, radius * 4);
    if (hit) {
      _fHit.copy(hit);
    } else {
      // No drawn chunk under the ray (the LOD list is mid-rebuild, or the gaze
      // is on the sky): fall back to the chart's own tangent plane, which is
      // the same fallback the engine's picker keeps behind its drawn-world
      // override. Still no intersection ⇒ hold the last spark.
      wildAnchor.updateWorldMatrix(true, false);
      _fPlanePt.set(WILD_SIDE / 2, 0, WILD_SIDE / 2).applyMatrix4(wildAnchor.matrixWorld);
      _fPlaneN.set(0, 1, 0).transformDirection(wildAnchor.matrixWorld);
      _fPlane.setFromNormalAndCoplanarPoint(_fPlaneN, _fPlanePt);
      _fRay.set(_fRayO, _fRayD);
      if (!_fRay.intersectPlane(_fPlane, _fHit)) return;
    }
    wildAnchor.updateWorldMatrix(true, false);
    wildAnchor.worldToLocal(_fHit);
    // CLAMPED TO THE CHART, not refused: a gaze at the horizon is a real
    // instruction to walk that way, and the chart re-anchors under the walker
    // long before the edge becomes a wall (④). Beyond the rect the samplers'
    // curvature correction is the thing that would start lying.
    const inset = 2;
    const cx = Math.min(WILD_SIDE - inset, Math.max(inset, _fHit.x));
    const cy = Math.min(WILD_SIDE - inset, Math.max(inset, _fHit.z));
    spiritLocal = { x: cx, y: cy };
    host.setSpiritPosition(cx, cy);
  };

  // ── ⑦ THE FRAME LOOP (this game owns it) ──────────────────────────────────
  const _lodPos = new THREE.Vector3();
  let paused = false;
  let raf = 0;
  let last = performance.now();
  let disposed = false;
  const frame = (): void => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    // The host's own setPaused freezes the sim at dt = 0; stepping regardless
    // keeps the view (and the gaze cursor) alive while paused. While the boot
    // is flying the camera down the host still steps — the world is alive under
    // the descent, it simply isn't being aimed at.
    host?.step(dt, now);
    if (!landed) {
      // A PAUSED loader still lands (a pause is not a reason to strand the
      // player in the sky); the sim underneath is frozen by the host either way.
      stepDescent(dt);
    } else if (!paused) {
      maybeRebaseWild();
      feedSpark();
    }
    if (landed && multiplayer) {
      // PRESENCE + REACTION, ~1 Hz, deliberately OUTSIDE the pause gate: a
      // paused player has not left the planet (their body simply isn't moving),
      // and the coordinator's word can arrive while this window is paused.
      // SOLO makes not one call of it: single-player play is byte-identical,
      // by the same rule the rest of this boot's multiplayer seam follows.
      sessionPollT += dt;
      if (sessionPollT >= SESSION_POLL_S) {
        sessionPollT = 0;
        feedPresence();
        pollSession();
      }
    }
    // LOD from the camera in PLANET-LOCAL coordinates.
    planetGroup.updateWorldMatrix(true, false);
    planetObj.update(planetGroup.worldToLocal(_lodPos.copy(camera.position)));
    renderer.render(scene, camera);
  };
  // POSE FRAME ZERO before the first rAF: the veil lifts on whatever is on the
  // canvas, and a camera still at the origin is the inside of the planet.
  placeDescentCamera(DESCENT_START_ALT_M);
  raf = requestAnimationFrame(frame);

  // ── Pointer-as-gaze: the aim point IS the gaze. A WALKER's pointer goes
  // straight to the host (there is no spirit ladder out here) AND is remembered
  // for the spark feed (⑥), which casts its own ray from it. `aimAt`/`aimClear`
  // are the ONE pipeline both the mouse and the bridge gaze feed drive.
  // WITHHELD DURING THE DESCENT: the boot owns the camera then, so an aim would
  // pick against a shot the player is not flying and set the avatar walking
  // before they have the world. ────────────────────────────────────────────
  const aimAt = (clientX: number, clientY: number): void => {
    lastAimClient = { x: clientX, y: clientY };
    if (landed) host?.setPointer(clientX, clientY);
  };
  const aimClear = (): void => {
    lastAimClient = null;
    host?.clearPointer();
  };

  // ── AIM ARBITRATION — embedded, TWO sources feed the one pipeline: the
  // iframe's own native pointermove AND the platform's forwarded ~30 Hz `gaze`
  // stream (which spams `mode:"off"` whenever it has no position). Feeding both
  // unarbitrated makes the aim flicker and drag laterally — and the grounded
  // camera, which turns toward the aim, spin continuously. ONE source of truth,
  // and ownership is STICKY, never a timer:
  //   • a NATIVE pointer event claims the aim, and the claim holds while the
  //     pointer stays INSIDE the stage — a RESTING cursor keeps its aim
  //     indefinitely (the hover IS the aim; dwell-to-select depends on it);
  //   • the ONLY things that end a native claim: pointerleave, or a forwarded
  //     POSITION arriving after the native pointer has been silent for
  //     NATIVE_IDLE_RELEASE_MS — a genuine input switch, far longer than any
  //     dwell;
  //   • a forwarded clear ("off" spam / out-of-frame) clears ONLY an aim the
  //     forwarded stream itself set — never a native one;
  //   • before any native claim (camera-based eyegaze: no native events), the
  //     forwarded stream flows freely.
  // `?aimdebug` on the iframe URL logs source decisions (throttled), off by
  // default.
  const AIM_DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("aimdebug");
  const NATIVE_IDLE_RELEASE_MS = 10_000;
  let nativeInside = false;
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

  const ro = new ResizeObserver(() => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(Math.min(2, dpr));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    host?.resize(w, h, dpr);
  });
  ro.observe(canvas);

  setStatus(`${siteLine} · descending ${DESCENT_START_ALT_M} m`);

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
    setPaused(p) {
      paused = p;
      host?.setPaused(p);
    },
    applyNetInbound(msgs) { host?.applyNetInbound(msgs); },
    applyRemoteCommand(cmd) {
      const parsed = parseWorldCommand(cmd);
      if (parsed) host?.applyRemoteCommand(parsed);
    },
    applySessionControl(sc) {
      // Handed RAW: the engine validates it itself (an envelope this snapshot
      // half-understands must be dropped by the thing that stores it, not
      // second-guessed here). Then re-read the book straight away — the
      // reaction to "you are in a different session now" should not wait out
      // the poll interval.
      sessionHost()?.applySessionControl?.(sc);
      pollSession();
    },
    donateHandover(memberIds, opts) { return donateHandover(memberIds, opts); },
    applyStoredHandover() {
      const outcome = applyStoredHandover();
      // A payload that landed mid-descent may name members whose bodies are
      // already standing (the roster was forwarded right after the boot).
      placeHandoverBodies();
      return outcome;
    },
    planetLoc() { return lastPresence; },
    handoverStatus() {
      return {
        chart: chartDatum.from,
        received,
        members: handoverMembers,
        placed: handoverPlaced,
        offChart: handoverOffChart,
        donated: handoverDonated,
        relaid: handoverRelaid,
        refusals: [...handoverRefusals],
        late: handoverLate,
      };
    },
    localAddressee() { return host?.localAddressee() ?? null; },
    multiplayerRole() { return host?.multiplayerRole() ?? null; },
    setPeers(next) {
      // The host's own roster seam (landed at N5b) reconciles one created body
      // per member against this list — owner-side, idempotent, order-
      // insensitive, and inert both before `start` and in solo play (an empty
      // roster spawns nothing, and the LOCAL peer's body is exempt from the
      // diff because start/stop own it). So it is forwarded UNCONDITIONALLY:
      // there is no state in which withholding it would be safer.
      peers = next; // still recorded locally: a reboot re-forwards from main.ts
      host?.setPeers(next);
      // A handed-over member's body is created BY this roster forward (the
      // owner reconciles one per member), so the position the payload gave it
      // is applied on the way out of the call that spawned it (⑨).
      placeHandoverBodies();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
      if (toastTimer) clearTimeout(toastTimer);
      host?.stop(); // detaches the world view from the anchor
      host = null;
      releaseBoard(); // blank + un-route the persistent board (never unmount it)
      wildRoot.parent?.remove(wildRoot);
      planetObj.dispose();
      planetGroup.parent?.remove(planetGroup);
      renderer.dispose();
      delete (window as unknown as Record<string, unknown>).__questHike;
      delete (window as unknown as Record<string, unknown>).__hikePeers;
      root.remove();
    },
  };
}
