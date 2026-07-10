// shared/symbol-game/quest-host.ts
//
// The symbol-game's PLAYABLE SESSION, engine-side: everything between a
// certified GoalTreeGame and a live 3D world — session assembly (layout →
// world-engine embedding → village buildings → embodied NPCs), the goal-tree
// runtime driver, the creature-world physical layer (errands, hand-overs,
// stations, devices, placements, presence/stay/escort), the dwell-to-talk
// conversation machinery, and in-world speech. It drives the EXACT SAME
// per-frame loop as the social world — `runWorldHost` — so physics, camera,
// gaze, and dialogue bubbles are one implementation everywhere.
//
// Carved out of games/goal-tree-player/src/GoalTreePlayer3D.tsx (2026-07-09)
// so ANY host — the AAC goal-tree player, the world-lab test bench, a future
// engine game — can run the symbol-game. The host owns NO chrome: everything
// a UI must show (board options, toasts, objectives, satchel, the win screen)
// leaves through the injected `QuestPresenter`; everything a UI does comes
// back through the returned `QuestHost3D` methods. No React, no games-bridge.
//
// ⚠️ DOM + THREE bound (canvas renderer, speechSynthesis, glyph rasters) —
// MAIN THREAD ONLY, deliberately NOT re-exported from symbol-game/index.ts.
// Import directly:  import { createQuestHost3D } from "@shared/symbol-game/quest-host";

import * as THREE from "three";
import type { EntityDef, FulfillNode, GoalTreeGame } from "../goal-tree/types.js";
import { certifyGoalTreeGame } from "../goal-tree/index.js";
import { buildLogicalWorld, type LogicalWorld } from "../goal-tree/logical-world.js";
import { walkGoalTree } from "../goal-tree/walk.js";
import { projectGameLayout } from "../goal-tree/projector2d.js";
import { generateHouse } from "../place/house.js";
import { embedPuzzle, type PuzzleEmbedding } from "../place/embed.js";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeContext,
  type RuntimeResult,
  type RuntimeState,
} from "../goal-tree/runtime.js";
import type {
  ChoiceOptionView,
  NarrationKind,
  ObjectiveSummary,
  SpaceInput,
} from "../goal-tree/space.js";
import {
  applySpace3DCommand,
  buildConverseObjects,
  buildTransportObjects,
  createSpace3DState,
  detectSpace3D,
  embedLayoutInWorld,
  makeWallConstraint,
  PLAYER_ID,
  zoneAt,
  type ConverseWorldItem,
  type Space3DState,
  type TransportPlacement,
  type WorldEmbedding,
} from "../goal-tree/space3d.js";
import type { Layout2D } from "../goal-tree/layout2d.js";
import {
  createWorld3DView,
  defaultAvatarModelFactory,
  type AvatarModel,
  type AvatarModelFactory,
} from "../world-engine/render3d.js";
import {
  createCreatureAvatarFactory,
  getSpeciesAssets,
} from "../world-engine/creatures/creature-model.js";
import { createGlyphImageSource } from "../world-engine/glyph-images.js";
import type { ImageResolver } from "../glyph-compositor.js";
import { createDwellTracker } from "../world-engine/dwell.js";
import { runWorldHost, type WorldHost } from "../world-engine/world-host.js";
import type { NpcErrand } from "../world-engine/npc-controller.js";
import {
  carryObject,
  clearWorldBubble,
  dropObject,
  expandWorldBuildings,
  showWorldBubble,
  unlockDoor,
  visibleBuildings,
} from "../world-engine/engine.js";
import { createNpcVoice, speechEstimateMs, type NpcVoice } from "../world-engine/npc-voice.js";
import { resolveLine, SAMPLE_NPC_DIALOGUE } from "../world-engine/npc-dialogue.js";
import {
  claimItem,
  concludeTransfer,
  createCreatureWorld,
  creatureWorldFromGame,
  DEVICE_ANTONYM,
  noteArrival,
  notePlacement,
  openNeeds,
  pendingTransfers,
  PLAYER_CREATURE_ID,
  planVillageBuildings,
  projectDialogue,
  seeItem,
  selectAct,
  STATE_TAGS,
  STAY_DONE_LINE,
  toggleDevice,
  useStation,
  type VillagePlan,
  type ConversationMemo,
  type CreatureNeed,
  type CreatureWorld,
  type DerivedCreatures,
  type DialogueAct,
  type SyntaxLevel,
} from "./index.js";
import { speakDirections, speakerGender, translateGlyph } from "./lang/index.js";
import { creditDelivery } from "./town-quests.js";
import { buildTownPlay, type TownPlay } from "./town-play.js";
import { answerPlaceDirections, houseGlyphForColor, type PlaceFact } from "./town-directions.js";
import { STREET_NPCS } from "../engine/town/residents.js";
import { GoalTreeOverlay3D } from "./quest-overlay-3d.js";

// Conversation (dwell-to-talk) tuning.
const CONVO_RADIUS = 7;       // approach distance that raises an NPC's greeting bubble
const CONVO_FIG_RADIUS = 2.2; // gaze within this of a poser counts as "on" them
const CONVO_START_MS = 700;   // dwell ON an NPC to begin a conversation
const CONVO_CANCEL_MS = 1000; // dwell on empty ground (away from the NPC) to leave
const TAP_COOLDOWN_S = 1.0;   // after a device tap-toggle, ignore re-picks this long
// Motive batch (stay-with + escort) tuning.
const STAY_RADIUS = 5;  // "with" distance for the stay-with dwell
const STAY_SECONDS = 8; // company time until "I'm okay, thank you!"
const FOLLOW_GAP = 4;   // escort: follower re-paths when trailing farther than this

// Glyph SENTENCES are spoken as PROPER language via the shared translation
// rulesets (shared/symbol-game/lang): "i_me + want + apple" → "I want an
// apple." / "אני רוצה תפוח." — grammar (agreement, articles, constructions)
// lives per-locale there; meta.locale picks the ruleset (en fallback).

export interface QuestSession {
  game: GoalTreeGame;
  world: LogicalWorld;
  ctx: RuntimeContext;
  embedding: WorldEmbedding;
  entities: Map<string, EntityDef>;
  rState: RuntimeState;
  sState: Space3DState;
  /** "move A→B" puzzles: carry object + destination, watched for completion. */
  transports: TransportPlacement[];
  /** Poser nodes embodied as world NPCs (capsule body + icon head). */
  embodiedNodeIds: Set<string>;
  /** NPC avatar id → head icon, for the model factory. */
  npcIcons: Map<string, string>;
  /** Converse items living as REAL world carry objects, by object id. */
  convItems: Map<string, ConverseWorldItem>;
  /** Object ids already absorbed into the runtime satchel (no double-adds). */
  absorbed: Set<string>;
  /** Stock object ids the dialogue has granted (ownership released). */
  granted: Set<string>;
  /** The need-based creature world (fulfill-node games), or null. */
  creatures: DerivedCreatures | null;
  /** Per-creature staging: where it stands (home) and stows items (stockpile). */
  staging: Map<string, { home: { x: number; y: number }; stockpile: { x: number; y: number } }>;
  /** Per-NPC errand QUEUE — one task at a time (a creature carries one item). */
  npcTasks: Map<string, NpcErrand[]>;
  /** Wants the player has HEARD stated (drives the state-2 where-is acts). */
  heardWants: Set<string>;
  /** Placement-need containers, watched for the fulfilling drop (containedIn). */
  placeDests: { nodeId: string; entityId: string; objectId: string }[];
  /** Transformation stations, watched for drops ON them (state swap + eject). */
  stations: { nodeId: string; kind: string; objectId: string; applies: string; removes: string; powerDeviceId?: string }[];
  /** Per-device tap COOLDOWN (seconds) — a dwell-toggle debounce so a held gaze
   *  doesn't flip the device every frame. */
  tapCooldown: Map<string, number>;
  /** The village's buildings (houses raised on the zone rects), or null when
   *  the layout can't be walled — then the invisible wall constraint applies. */
  village: VillagePlan | null;
  /** STAY-WITH dwell (motive batch): creature id → seconds the player has been
   *  keeping it company. Resets when the player wanders off. */
  stayDwell: Map<string, number>;
  /** ESCORT followers (motive batch): creature ids currently trailing the
   *  player toward their destination (agreed via the dialogue). */
  escorting: Set<string>;
  /** TEMP: one-shot debug log keys (hand-over diagnostics). */
  dlogged: Set<string>;
  /** LIVING-TOWN session (town-play): the world and quests come from a
   *  town's live books; the stage streams its buildings and residents.
   *  Null = a classic generated quest world. */
  town: TownPlay | null;
  /** Town street-clock seconds (paces the stage's visible routines). */
  townClock: number;
  /** Wanter nodes whose delivery already credited the books (idempotent). */
  townCredited: Set<string>;
  /** The town's COMMON KNOWLEDGE of places — subject id → fact (a home, a place
   *  to buy a good). Every resident can point to all of these. Empty off a town
   *  session. Built once when the town session starts. */
  placeFacts: Map<string, PlaceFact>;
  /** Direction subjects the player has HEARD OF, MOST-RECENT FIRST — the only
   *  places they may ask the way to. Starts empty (no common knowledge). */
  knownSubjects: string[];
  /** Known subjects that are active QUEST needs — sorted to the top of the ask
   *  list ("Quest needs may be prioritized"). */
  questSubjects: Set<string>;
}

/** One pressable option on whatever surface the presenter renders. */
export interface QuestBoardOption {
  /** `select()` id: the entity id (a choose/converse option) or `act_<i>`
   *  (a creature-conversation act). */
  id: string;
  /** The player's TRANSLATED statement (button caption / board label). */
  label: string;
  /** The language-invariant composed glyph — board buttons render this image. */
  glyph?: string;
  /** What pressing it says aloud (the translated statement). */
  spokenText?: string;
  /** Emoji placeholder for surfaces without glyph rendering. */
  iconRef?: string;
}

/** What the player should be answering right now. */
export interface QuestBoardView {
  /** "choice" = a choose/converse question; "acts" = a creature conversation
   *  (re-projected after every press — expect repeated board() calls). */
  kind: "choice" | "acts";
  nodeId: string;
  posedByEntityId: string;
  /** The poser's line as a composed glyph sentence. */
  prompt: string;
  /** The line as proper translated language. */
  promptText: string;
  options: QuestBoardOption[];
}

/**
 * Everything the session needs SHOWN. The host calls these; the presenter
 * renders them however it likes (AAC board via games-bridge, React HUD, plain
 * DOM). All methods fire on the host's frame/dispatch path — keep them cheap.
 */
export interface QuestPresenter {
  /** A fresh session started (initial boot, load, or replay) — reset all HUD. */
  sessionStarted(session: QuestSession): void;
  board(view: QuestBoardView): void;
  clearBoard(): void;
  toast(text: string, kind: NarrationKind): void;
  objectives(objectives: ObjectiveSummary[]): void;
  /** A collect node's progress ticked. */
  collect(nodeId: string, have: number, need: number): void;
  /** The runtime satchel changed (entity id → count). */
  satchel(inventory: Record<string, number>): void;
  won(): void;
  /** Completed-goal count changed (the embedded player reports it as score). */
  score?(value: number): void;
  /** Gameplay beats a platform may want to relay (e.g. "demonstration_shown"). */
  action?(action: string, meta?: Record<string, unknown>): void;
}

export interface QuestHostDeps {
  canvas: HTMLCanvasElement;
  presenter: QuestPresenter;
  /** Symbol→artwork resolver for glyph rasters (each app bundles its own
   *  icons; omit for the compositor's emoji fallback). */
  resolveImage?: ImageResolver;
  /** In-game character voice. Omit to create the default speechSynthesis
   *  voice; pass null for a silent host (e.g. tests). */
  voice?: NpcVoice | null;
  /** Per-frame passthrough (HUD gaze refresh, host-side debug). */
  onFrame?(dt: number): void;
}

export interface QuestHost3D {
  /** (Re)build the whole session and world for a game. */
  start(game: GoalTreeGame, town?: TownPlay | null, opts?: { spirit?: boolean }): void;
  /** Rebuild the CURRENT session from scratch (deterministic). */
  replay(): void;
  /** Press a board option (a `QuestBoardOption.id`). `spokenExternally` =
   *  another surface already voiced the player's statement (the AAC board in
   *  its own frame) — the host holds responses back instead of speaking. */
  select(id: string, opts?: { spokenExternally?: boolean }): void;
  /** Close the active question/conversation without answering. */
  cancelChoice(): void;
  /** Feed the pointer/gaze in CLIENT px (the host maps to its canvas). A fed
   *  pointer PERSISTS — a still pointer keeps steering — until cleared. */
  setPointer(clientX: number, clientY: number): void;
  clearPointer(): void;
  setPaused(paused: boolean): void;
  resize(width: number, height: number, dpr: number): void;
  stop(): void;
  readonly session: QuestSession;
  readonly won: boolean;
  /** The underlying world host (live engine state) — debug/test-bench surface. */
  readonly world: WorldHost | null;
}

/**
 * LIVING TOWN: relocate the certified layout ONTO the town — each fulfill
 * node's zone re-centers at its cast anchor (the wanter's real doorstep,
 * the vendor's real counter), so the stock and prop staging that placed
 * items relative to figures lands them at the right counters untouched.
 * Doors and the star/victory geometry are DROPPED (open town, decided
 * 2026-07-09 — the locked door was a placeholder); the spawn is the
 * plaza; the world itself is the stage's certified spec.
 */
function townEmbedding(world: LogicalWorld, layout: Layout2D, town: TownPlay): WorldEmbedding {
  const anchors = town.stage.castSpawns;
  const zones: Layout2D["zones"] = [];
  const delta = new Map<string, { dx: number; dy: number }>();
  for (const z of layout.zones) {
    const owner = world.zones.find((w) => w.id === z.zoneId)?.ownerNodeId;
    const anchor = owner ? anchors.get(owner) : undefined;
    if (!anchor) continue; // start + star zones own no town geometry
    const dx = anchor.x - (z.rect.x + z.rect.w / 2);
    const dy = anchor.y - (z.rect.y + z.rect.h / 2);
    delta.set(z.zoneId, { dx, dy });
    zones.push({ ...z, rect: { ...z.rect, x: z.rect.x + dx, y: z.rect.y + dy } });
  }
  // Plaza CENTER — matches the stage's spawn (the open band between the
  // hall and the market hall; +8 used to land ON the market's north wall).
  const spawn = { x: town.stage.center.x, y: town.stage.center.y };
  const figures = layout.figures.flatMap((f) => {
    const anchor = anchors.get(f.nodeId);
    return anchor ? [{ ...f, pos: anchor }] : []; // the star marker drops
  });
  const items = layout.items.map((i, k) => {
    const home = layout.zones.find(
      (z) =>
        i.pos.x >= z.rect.x && i.pos.x <= z.rect.x + z.rect.w &&
        i.pos.y >= z.rect.y && i.pos.y <= z.rect.y + z.rect.h,
    );
    const d = home ? delta.get(home.zoneId) : undefined;
    return d
      ? { ...i, pos: { x: i.pos.x + d.dx, y: i.pos.y + d.dy } }
      : { ...i, pos: { x: spawn.x + 2 + k * 1.5, y: spawn.y + 2 } }; // orphans by the plaza
  });
  return { spec: town.stage.spec, layout: { zones, doors: [], figures, items, spawn } };
}

/**
 * Character posers (choose/converse) become REAL world-engine NPCs: a simple
 * body like the player's with the entity's emoji as the head. Marker posers
 * (signs, question stones) keep their floating overlay sprite.
 */
function planEmbodiedNpcs(
  game: GoalTreeGame,
  embedding: WorldEmbedding,
  entities: Map<string, EntityDef>,
): { embodiedNodeIds: Set<string>; npcIcons: Map<string, string> } {
  const nodeById = new Map([...walkGoalTree(game.root)].map((v) => [v.node.id, v.node]));
  const embodiedNodeIds = new Set<string>();
  const npcIcons = new Map<string, string>();
  for (const fig of embedding.layout.figures) {
    const node = nodeById.get(fig.nodeId);
    if (node?.type !== "choose" && node?.type !== "converse" && node?.type !== "fulfill") continue;
    const entity = entities.get(fig.entityId);
    if (entity?.kind !== "character") continue;
    const npcId = `npc_${fig.nodeId}`;
    embodiedNodeIds.add(fig.nodeId);
    npcIcons.set(npcId, entity.iconRef ?? "🙂");
    (embedding.spec.npcs ??= []).push({
      id: npcId,
      x: fig.pos.x,
      y: fig.pos.y,
      name: entity.label,
      // A quest-giver is a resident whose needs are FROZEN (a fixed puzzle ask)
      // — the flag that sets it apart from a regular townsperson; both are the
      // same kind of NPC (docs/TOWN_AND_NPCS.md).
      needsFrozen: true,
      // Stationary NPCs still TURN to face the nearest human — free presence.
      behavior: { movement: "stationary" },
    });
  }
  return { embodiedNodeIds, npcIcons };
}

/** The default capsule avatar with a billboarded emoji head floated over the face. */
function makeNpcModelFactory(npcIcons: Map<string, string>): AvatarModelFactory {
  return (id, isLocal) => {
    const base = defaultAvatarModelFactory(id, isLocal);
    const icon = npcIcons.get(id);
    if (icon) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const g = canvas.getContext("2d")!;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = "100px sans-serif";
      g.fillText(icon, 64, 70);
      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
      // The emoji head overlaps the capsule's top so the creature stays a
      // realistic ~1.9 m tall — floated higher/larger it read as a giant. It
      // anchors INSIDE the capsule silhouette, so each frame it's pushed out
      // toward the camera past the body surface (else the capsule hides it).
      const head = new THREE.Sprite(material);
      head.scale.set(1.0, 1.0, 1);
      head.position.set(0, 1.45, 0);
      head.renderOrder = 12;
      base.object.add(head);
      const headOut = new THREE.Vector3();
      const bodyWorld = new THREE.Vector3();
      const dispose = base.dispose.bind(base);
      return {
        object: base.object,
        update: (frame, dt) => {
          base.update(frame, dt);
          // Clearly PAST the base model's face disc (pushed bodyRadius+0.1 =
          // 0.55) — at the same depth the disc z-fights the emoji away.
          headOut
            .copy(frame.camera.position)
            .sub(base.object.getWorldPosition(bodyWorld))
            .normalize()
            .multiplyScalar(0.85);
          head.position.set(headOut.x, 1.45 + headOut.y, headOut.z);
        },
        dispose: () => {
          texture.dispose();
          material.dispose();
          dispose();
        },
      };
    }
    return base;
  };
}

/**
 * The town's people, rendered by the creature builder. Regular residents
 * (`resident_*` streamed townsfolk) and the player are HUMAN bodies (the
 * creature-builder's dynamic path for the player, cheap baked clips for the
 * crowd — one bake shared across the whole town). Puzzle characters
 * (`npc_<nodeId>` quest-givers — the bear who wants a banana, etc.) keep their
 * emoji-headed capsule so their identity still reads. See docs/TOWN_AND_NPCS.md:
 * a town is people, the puzzle is an overlay on them.
 */
/** A FORMLESS avatar — an empty node. The SPIRIT player has no body; the camera
 *  still follows this (stationary) point, and the gaze spark is the only cursor. */
function emptyAvatarModel(): AvatarModel {
  const object = new THREE.Group();
  return { object, update() {}, dispose() { object.removeFromParent(); } };
}

/** Which animal-person species stands in for a puzzle character's emoji face —
 *  the animal people REPLACE the animal character models. */
const ANIMAL_SPECIES_BY_ICON: Record<string, string> = {
  "🐻": "bear_person", "🧸": "bear_person",
  "🐸": "frog_person",
  "🐶": "dog_person", "🐕": "dog_person", "🐩": "dog_person", "🦮": "dog_person",
  "🐰": "rabbit_person", "🐇": "rabbit_person",
};
function animalSpeciesForIcon(icon: string | undefined): string | null {
  return icon ? ANIMAL_SPECIES_BY_ICON[icon] ?? null : null;
}

/** Puzzle characters (`npc_<nodeId>`): an animal-person CREATURE model when
 *  their emoji face maps to one, else the emoji-capsule fallback. */
function makePuzzleCharacterFactory(npcIcons: Map<string, string>): AvatarModelFactory {
  const emoji = makeNpcModelFactory(npcIcons);
  const animal = createCreatureAvatarFactory({
    speciesFor: (id) => animalSpeciesForIcon(npcIcons.get(id)) ?? "human_cute",
    heightM: 1.7,
  });
  return (id, isLocal) =>
    animalSpeciesForIcon(npcIcons.get(id)) ? animal(id, isLocal) : emoji(id, isLocal);
}

function makeTownModelFactory(npcIcons: Map<string, string>, species: string): AvatarModelFactory {
  // Warm the shared bake once so no hitch lands mid-play.
  getSpeciesAssets(species);
  const people = createCreatureAvatarFactory({ speciesFor: () => species, heightM: 1.7 });
  const puzzle = makePuzzleCharacterFactory(npcIcons);
  return (id, isLocal) => (id.startsWith("npc_") ? puzzle(id, isLocal) : people(id, isLocal));
}

export function makeQuestSession(game: GoalTreeGame, town: TownPlay | null = null): QuestSession {
  const certified = certifyGoalTreeGame(game);
  if (!certified.ok) {
    console.error("quest-host: game failed certification", certified.errors);
  }
  let world = certified.ok ? certified.world : buildLogicalWorld(game);
  let layout = certified.ok ? certified.layout : projectGameLayout(game, world);

  // HOUSE mode (docs/SPACE_EMBEDDING.md): map the certified star world onto a
  // procedurally-generated house — the circulation becomes free pass-through
  // zones, helpers land in role rooms, the prize sits behind a locked door. The
  // embedded world is completability-equivalent to the certified one (free
  // circulation changes nothing), so the certificate still holds. Falls back to
  // the village when the house can't fit the puzzle (embedPuzzle → null).
  let house: PuzzleEmbedding | null = null;
  if (!town && game.meta.layout === "house") {
    const seed = game.meta.seed ?? 0;
    const space = generateHouse(world.zones.length - 1, seed);
    house = embedPuzzle(game, world, space, seed);
    if (house) {
      world = house.world;
      layout = house.layout;
    }
  }

  const embedding = town ? townEmbedding(world, layout, town) : embedLayoutInWorld(layout);
  // Materialize any transport puzzles' carry object + container as real world
  // objects in the embedded spec, so the engine moves/renders them.
  const transport = buildTransportObjects(game, world, embedding.layout);
  const ctx = createRuntimeContext(game, world);
  // Converse items are REAL carry objects (props loose, stock behind counters).
  const converse = buildConverseObjects(game, ctx.instances, world, embedding.layout);
  embedding.spec.objects = [...transport.objects, ...converse.objects];
  // Raise the village's HOUSES: real world-engine buildings on the zone rects,
  // expanded into wall/door structures. Collision then comes from the engine
  // (locked quest doors are locked ENGINE doors) and the whole field is open
  // ground — the invisible-wall constraint is only kept when no buildings
  // could be raised (a layout whose doors don't sit on zone edges).
  // The HOUSE's contiguous rooms, else the VILLAGE's per-zone houses. The house
  // brings its own buildings from the embedding (one enclosed home); the village
  // walls each zone into a separate house on the plaza.
  const village = town || house ? null : planVillageBuildings(game, world, embedding.layout);
  if (house) {
    embedding.spec.buildings = house.buildings;
    embedding.spec = expandWorldBuildings(embedding.spec);
  } else if (village) {
    embedding.spec.buildings = village.buildings;
    embedding.spec = expandWorldBuildings(embedding.spec);
  }
  const entities = new Map(game.entities.map((e) => [e.id, e]));
  const { embodiedNodeIds, npcIcons } = planEmbodiedNpcs(game, embedding, entities);
  return {
    game,
    world,
    ctx,
    embedding,
    entities,
    rState: createRuntimeState(),
    sState: createSpace3DState(world),
    transports: transport.placements,
    embodiedNodeIds,
    npcIcons,
    convItems: new Map(converse.items.map((i) => [i.objectId, i])),
    absorbed: new Set(),
    granted: new Set(),
    creatures: (() => {
      const derived = creatureWorldFromGame(game);
      return derived.nodeByCreature.size ? derived : null;
    })(),
    staging: new Map(converse.staging.map((s) => [s.nodeId, { home: s.home, stockpile: s.stockpile }])),
    npcTasks: new Map(),
    heardWants: new Set(),
    placeDests: converse.dests,
    stations: converse.stations,
    tapCooldown: new Map(),
    village,
    stayDwell: new Map(),
    escorting: new Set(),
    dlogged: new Set(),
    town,
    townClock: 0,
    townCredited: new Set(),
    placeFacts: new Map(),
    knownSubjects: [],
    questSubjects: new Set(),
  };
}

/**
 * Build the town's COMMON KNOWLEDGE of places from its quest cast — every
 * resident inherits it. Two fact kinds the cast supports: a wanter's HOME (its
 * coloured house) and where to BUY the good a wanter needs (its vendor's
 * counter — the market that serves that trade). Deterministic; rebuilt on
 * replay. No-op off a town session.
 */
function buildTownPlaceFacts(session: QuestSession): void {
  session.placeFacts.clear();
  session.knownSubjects = [];
  session.questSubjects.clear();
  const town = session.town;
  if (!town || !session.creatures) return;
  const spawns = town.stage.castSpawns;
  const houses = town.plan.houses;
  const vendorByGood = new Map<string, string>(); // good → vendor node id
  for (const c of town.bundle.cast) if (c.role === "vendor") vendorByGood.set(c.good, c.nodeId);
  for (const c of town.bundle.cast) {
    if (c.role !== "wanter") continue;
    const home = spawns.get(c.nodeId);
    if (home && c.house != null && houses[c.house]) {
      session.placeFacts.set(`home:${c.nodeId}`, {
        id: `home:${c.nodeId}`,
        thingGlyph: houseGlyphForColor(houses[c.house]!.color),
        worldPos: home,
      });
    }
    // Where to buy the good this wanter needs → its vendor's counter.
    const creature = session.creatures.world.creatures[c.nodeId];
    const need = creature ? (openNeeds(creature)[0] ?? creature.needs[0]) : undefined;
    const vendorId = vendorByGood.get(c.good);
    const vendorAt = vendorId ? spawns.get(vendorId) : undefined;
    if (need && vendorAt) {
      session.placeFacts.set(`buy:${need.itemId}`, {
        id: `buy:${need.itemId}`,
        thingGlyph: session.entities.get(need.itemId)?.glyph ?? need.itemId,
        worldPos: vendorAt,
      });
    }
  }
}

/** Teach the player a direction subject (bump to MOST-RECENT). Only real facts
 *  are learnable; `quest` marks an active objective (sorted to the top). */
function learnSubject(session: QuestSession, subjectId: string, quest = false): void {
  if (!session.placeFacts.has(subjectId)) return;
  const i = session.knownSubjects.indexOf(subjectId);
  if (i >= 0) session.knownSubjects.splice(i, 1);
  session.knownSubjects.unshift(subjectId);
  if (quest) session.questSubjects.add(subjectId);
}

/** The player's askable direction subjects for the board: quest needs first,
 *  then the rest, MOST-RECENT within each. (Every resident has common knowledge
 *  of all facts, so the same list serves any creature.) */
function buildAskDirections(session: QuestSession): { id: string; glyph: string }[] {
  const quest: { id: string; glyph: string }[] = [];
  const other: { id: string; glyph: string }[] = [];
  for (const id of session.knownSubjects) {
    const fact = session.placeFacts.get(id);
    if (!fact) continue;
    (session.questSubjects.has(id) ? quest : other).push({ id, glyph: fact.thingGlyph });
  }
  return [...quest, ...other];
}

/** The item's CURRENT composed glyph: entity glyph minus its baked-in STATE
 *  tags, plus the creature-world's live states ("apple.cold" → "apple.hot"
 *  after the fire station). */
function liveItemGlyph(session: QuestSession, entityId: string): string {
  const base = session.entities.get(entityId)?.glyph ?? entityId;
  const parts = base.split(".");
  const kept = [parts[0]!, ...parts.slice(1).filter((m) => !STATE_TAGS.has(m))];
  const states = session.creatures?.world.items[entityId]?.states ?? [];
  return [...kept, ...states].join(".");
}

/** A need's WANTED composed glyph: the item's base composition plus the
 *  required state ("apple.hot" while the world only holds a cold one). */
function wantGlyphOf(session: QuestSession, need: CreatureNeed): string {
  const base = session.entities.get(need.itemId)?.glyph ?? need.itemId;
  const kept = base.split(".").filter((m: string, i: number) => i === 0 || !STATE_TAGS.has(m));
  return [...kept, ...(need.requiresState ? [need.requiresState] : [])].join(".");
}

export function createQuestHost3D(deps: QuestHostDeps): QuestHost3D {
  const { canvas, presenter } = deps;
  // Free client-side TTS for in-game characters. NPC dialogue is voiced even
  // under an AAC companion — the live AI never reads NPC lines, so there's no
  // double audio. `null` = a deliberately silent host.
  const voice: NpcVoice | null = deps.voice === undefined ? createNpcVoice() : deps.voice;

  let sess: QuestSession | null = null;
  let world: WorldHost | null = null;
  let overlay: GoalTreeOverlay3D | null = null;
  /** SPIRIT mode (AvatarKind "spirit"): the player is a stationary, formless
   *  first-person presence. No walking — dwell on anything in view to pick it
   *  up / put it down / talk. Set per-session by start({ spirit }). */
  let spirit = false;

  // The active question (a choose/converse `present-choice`, or one
  // SYNTHESIZED for a creature conversation — the camera/leave-dwell
  // machinery keys on it).
  let choice: { nodeId: string; posedByEntityId: string; prompt: string; options: ChoiceOptionView[] } | null = null;
  // A live need-based creature conversation (fulfill nodes) — dialogue is a
  // PROJECTION of creature state, re-computed after every act.
  let convo: { nodeId: string; level: SyntaxLevel; memo: ConversationMemo; acts: DialogueAct[] } | null = null;
  let isWon = false;
  let paused = false;

  // Pointer: the last CLIENT px (persistent — a still pointer keeps steering),
  // mapped onto the canvas for the world host, which owns the gaze-intent
  // interpreter + camera.
  let lastClient: { x: number; y: number } | null = null;
  // Lenient dwell trackers for the NPC conversation (start on the NPC / leave
  // on empty ground). Same eyegaze-tolerant timer as carry.
  const talkDwell = createDwellTracker({ dwellMs: CONVO_START_MS, tolerance: CONVO_FIG_RADIUS, graceMs: 450 });
  const leaveDwell = createDwellTracker({ dwellMs: CONVO_CANCEL_MS, tolerance: 2.0, graceMs: 450 });
  // Conversation dwell progress — fed to the gaze-spark bloom (the selection
  // indicator) via the host's `cursorProgress` dep.
  let convoProgress = 0;

  const steering = () => !paused && !isWon && choice === null;
  // The pointer/gaze stays LIVE during a choice (so dwell-to-cancel works); the
  // avatar is frozen separately by the host (carry / setConversation → aim null).
  const pointerLive = () => !paused && !isWon;

  /** Push the current pointer into the world host (or clear it when paused/won). */
  function feedPointer() {
    if (!world) return;
    if (lastClient && pointerLive()) {
      const r = canvas.getBoundingClientRect();
      world.setPointer(lastClient.x - r.left, lastClient.y - r.top);
    } else {
      world.clearPointer();
    }
  }

  /** Stable per-creature voice + pitch, so speakers sound DISTINCT: a
   *  different system voice where the OS has several for the language
   *  (voiceIndex ≥ 1 — index 0 is reserved for the player), plus a pitch
   *  offset that still differentiates when only one voice exists. */
  function speakerVoiceOpts(speakerSymbol?: string): { pitch?: number; voiceIndex?: number } {
    if (!speakerSymbol) return {};
    let h = 0;
    for (let i = 0; i < speakerSymbol.length; i++) h = (h * 31 + speakerSymbol.charCodeAt(i)) | 0;
    h = Math.abs(h);
    return { pitch: 0.8 + (h % 5) * 0.09, voiceIndex: 1 + (h % 6) };
  }

  /** Speak a character's line aloud (free browser TTS) in the game's language.
   *  Composed glyph sentences are translated into speakable text first;
   *  speakerSymbol → grammatical gender, so agreeing languages conjugate for
   *  the creature actually talking (a צפרדע says "נותנת", not "נותן"). */
  function speakNpc(text: string, speakerSymbol?: string) {
    if (!text) return;
    const locale = sess?.game.meta.locale;
    const spoken = translateGlyph(text, locale, { speaker: speakerGender(speakerSymbol, locale) });
    voice?.speak(spoken, { lang: locale, ...speakerVoiceOpts(speakerSymbol) });
  }

  /** Canned, already-localized lines skip glyph translation. */
  function speakRaw(text: string) {
    if (!text) return;
    voice?.speak(text, { lang: sess?.game.meta.locale });
  }

  /** The PLAYER's statement for a glyph — same translation, but subject-less
   *  frames read FIRST PERSON ("give + ball" = "I'll give you the ball.", not
   *  the NPC's "Give me the ball."). Student gender isn't wired yet. */
  function playerStatement(glyph: string): string {
    return translateGlyph(glyph, sess?.game.meta.locale, { firstPerson: true });
  }

  /** Voice the player's own statement (a board press on a host-owned surface):
   *  cut any NPC line mid-word — they were answered — and speak in the
   *  PLAYER's voice, distinct from every creature (index 0, raised pitch). */
  function speakPlayerStatement(said: string) {
    if (!said) return;
    voice?.cancel();
    voice?.speak(said, { lang: sess?.game.meta.locale, pitch: 1.35, voiceIndex: 0 });
  }

  /** The student's statement was voiced by ANOTHER surface (the AAC board in
   *  the parent frame — a separate speechSynthesis queue we can't sequence
   *  behind): hold our response back for the statement's estimated duration.
   *  Do NOT cancel here — the browser's TTS engine queue is shared across
   *  frames, so a cancel from this frame would kill that just-started
   *  statement (its own speak already cut our NPC line). */
  function yieldToStatement(spokenText: string) {
    voice?.pause(speechEstimateMs(spokenText));
  }

  /** An NPC's statement for a glyph — translation + the speaker's agreement. */
  function npcStatement(glyph: string, speakerSymbol?: string): string {
    const locale = sess?.game.meta.locale;
    return translateGlyph(glyph, locale, { speaker: speakerGender(speakerSymbol, locale) });
  }

  /** The glyph SYMBOL of a creature's embodied NPC (for speaker agreement). */
  function creatureGlyph(session: QuestSession, creatureId: string | undefined): string | undefined {
    if (!creatureId) return undefined;
    const npcEntityId = session.creatures?.nodeByCreature.get(creatureId)?.npcEntityId;
    return npcEntityId ? session.entities.get(npcEntityId)?.glyph : undefined;
  }

  // ── Need-based creature conversations (fulfill nodes) ──────────────────────

  /** TEMP: one-shot debug logger for the creature physical layer. */
  function dlogOnce(session: QuestSession, key: string, msg: string) {
    if (session.dlogged.has(key)) return;
    session.dlogged.add(key);
    console.log(msg);
  }

  /** Item id → glyph symbol, for the projection's utterance templates. */
  function symbolOf(itemId: string): string {
    return sess!.entities.get(itemId)?.glyph ?? itemId;
  }

  /** The BUILDING an item is in, as its composed house symbol ("home.color_blue")
   *  — held items resolve through their holder's house, loose ones through the
   *  live object position. Undefined off-village / in the plaza / on the player. */
  function placeOfItem(session: QuestSession, itemId: string): string | undefined {
    const village = session.village;
    if (!village || !session.creatures) return undefined;
    const item = session.creatures.world.items[itemId];
    if (!item || item.ownerId === PLAYER_CREATURE_ID) return undefined;
    if (item.ownerId) {
      // Creature ids ARE fulfill node ids — its room is where it lives.
      const zoneId = session.world.sites[item.ownerId];
      return zoneId ? village.houseSymbolByZone[zoneId] : undefined;
    }
    // Loose: the physical object's current spot (staged spot until it moved).
    const conv = [...session.convItems.values()].find((i) => i.entityId === itemId);
    const live = conv ? world?.state.objects[conv.objectId] : undefined;
    const pos = live ? { x: live.x, y: live.y } : conv?.pos;
    const zoneId = pos ? zoneAt(session.embedding.layout, pos) : null;
    return zoneId ? village.houseSymbolByZone[zoneId] : undefined;
  }

  /** The full projection options for a creature conversation. */
  function creatureProjectionOpts(session: QuestSession, announce?: "before" | "after" | "never") {
    return {
      symbolOf,
      announce,
      symbolOfCreature: (cid: string) => {
        const npcEntity = session.creatures?.nodeByCreature.get(cid)?.npcEntityId;
        return (npcEntity && session.entities.get(npcEntity)?.glyph) || "there";
      },
      askableWhere: [...session.heardWants],
      // The places the player has heard of that this townsperson can point to.
      askDirections: buildAskDirections(session),
      // Carry items are offered from the HAND, never from an abstract pack.
      offerFilter: (itemId: string) => playerCarries(session, itemId),
      // Building location clues: "the ball is in the blue house".
      placeOf: (itemId: string) => placeOfItem(session, itemId),
    };
  }

  /** Is this item entity physically IN the player's hands right now? */
  function playerCarries(session: QuestSession, entityId: string): boolean {
    if (!world) return false;
    return [...session.convItems.values()].some(
      (i) => i.entityId === entityId && world!.state.objects[i.objectId]?.carriedBy === PLAYER_ID,
    );
  }

  /** (Re)present the projection for the active creature conversation. When the
   *  creature just REACTED (a clue, a refusal, a thank-you), the reaction IS the
   *  spoken line for this turn — re-projecting must not clobber it. `present`
   *  suppresses the spoken line / bubble for a SILENT board refresh (the
   *  directions answer voices + bubbles itself, then refreshes the acts). */
  function presentCreatureTurn(lineOverride?: string, present: { speak?: boolean; bubble?: boolean } = {}) {
    const doSpeak = present.speak ?? true;
    const doBubble = present.bubble ?? true;
    const session = sess!;
    if (!convo || !session.creatures || !world) return;
    const node = session.creatures.nodeByCreature.get(convo.nodeId);
    if (!node) return;
    // Standing in front of a creature, EVERYTHING it holds is visible — sight
    // is knowledge, so every held item is requestable (it may refuse).
    for (const item of Object.values(session.creatures.world.items)) {
      if (item.ownerId === convo.nodeId) {
        seeItem(session.creatures.world, PLAYER_CREATURE_ID, item.id, {
          kind: "held",
          by: convo.nodeId,
        });
      }
    }
    const proj = projectDialogue(
      session.creatures.world,
      convo.nodeId,
      PLAYER_CREATURE_ID,
      convo.level,
      creatureProjectionOpts(session, node.announce),
      convo.memo,
    );
    // Hearing a want stated is knowledge — it feeds other creatures' where-is.
    // "Stated" = the line names the need item's glyph (covers want/give lines,
    // placement "{item} + in + {box}" and on-behalf "{item} + to + {who}";
    // a hidden-need greeting names nothing).
    const needItem = session.creatures.nodeByCreature.get(convo.nodeId)?.needItemEntityId;
    const needGlyph = needItem ? session.entities.get(needItem)?.glyph : undefined;
    if (needItem && needGlyph && proj.lineGlyph.includes(needGlyph)) {
      session.heardWants.add(needItem);
      // Hearing the want also teaches the DIRECTION subjects: where to buy it
      // (an active objective → prioritised) and the way back to this asker's
      // home. The player can now ask any townsperson the way.
      learnSubject(session, `buy:${needItem}`, true);
      learnSubject(session, `home:${convo.nodeId}`);
    }
    convo.acts = proj.acts;
    const line = lineOverride ?? proj.lineGlyph;
    // The camera/leave-dwell machinery keys on the active choice — synthesize one.
    choice = {
      nodeId: convo.nodeId,
      posedByEntityId: node.npcEntityId,
      prompt: line,
      options: [],
    };
    const npcSym = session.entities.get(node.npcEntityId)?.glyph;
    const at = poserPos(session, convo.nodeId);
    if (at && doBubble) {
      showWorldBubble(world.state, `char:${node.npcEntityId}`, {
        anchor: { kind: "point", x: at.x, y: at.y },
        // Written caption = the PROPER translation; the glyph image stays the
        // language-invariant symbol sentence.
        text: npcStatement(line, npcSym),
        glyph: line,
        ttl: 6,
      });
    }
    if (doSpeak) speakNpc(line, npcSym);
    presenter.board({
      kind: "acts",
      nodeId: convo.nodeId,
      posedByEntityId: node.npcEntityId,
      prompt: line,
      promptText: npcStatement(line, npcSym),
      // label + spokenText carry the translated statement (written caption
      // and the board's voice); `glyph` stays the invariant symbol string.
      options: convo.acts.map((a, i) => ({
        id: `act_${i}`,
        label: playerStatement(a.glyph),
        glyph: a.glyph,
        spokenText: playerStatement(a.glyph),
      })),
    });
  }

  /**
   * The player asked where a place is. Resolve the town geometry from where
   * they stand, VOICE the proximity phrase ("The blue house is far, to the
   * north."), swivel the camera to point in that direction (over-the-shoulder,
   * at max yaw speed) and raise the NPC's arm, then refresh the board silently —
   * the direction WAS this turn's utterance.
   */
  function answerDirections(session: QuestSession, subjectId: string) {
    if (!convo || !world) return;
    const fact = session.placeFacts.get(subjectId);
    const node = session.creatures?.nodeByCreature.get(convo.nodeId);
    const player = world.state.avatars[PLAYER_ID];
    if (!fact || !session.town || !player || !node) {
      presentCreatureTurn(); // subject vanished — fall back to a normal refresh
      return;
    }
    learnSubject(session, subjectId); // asking bumps it to most-recent
    const ans = answerPlaceDirections(
      session.town.plan.streets,
      session.town.stage.center,
      { x: player.x, y: player.y },
      fact,
    );
    const locale = session.game.meta.locale;
    const npcSym = session.entities.get(node.npcEntityId)?.glyph;
    const text = speakDirections(fact.thingGlyph, ans.proximity, ans.cardinal, locale, {
      speaker: speakerGender(npcSym, locale),
    });
    // Voice it (already localised — skip glyph translation) + bubble it.
    voice?.cancel();
    voice?.speak(text, { lang: locale, ...speakerVoiceOpts(npcSym) });
    const at = poserPos(session, convo.nodeId);
    if (at) {
      showWorldBubble(world.state, `char:${node.npcEntityId}`, {
        anchor: { kind: "point", x: at.x, y: at.y },
        text,
        glyph: fact.thingGlyph, // the symbol strip shows the thing, not the prose
        ttl: 6,
      });
    }
    // Point: swivel the camera toward the target (over-the-shoulder, max yaw)
    // and raise the NPC's arm. The camera reverts to facing the speaker after.
    world.pointAt({ x: ans.pointAtWorld.x, y: ans.pointAtWorld.y });
    pointNpcArm(convo.nodeId, ans.pointAtWorld);
    presentCreatureTurn(undefined, { speak: false, bubble: false });
  }

  let gestureSeq = 0;
  /** Raise the conversing NPC's limb toward a world point — the creature system
   *  picks the pointing limb by anatomy (arm / foreleg / …) and the renderer
   *  spins up a poseable body for the gesture. One-shot via a bumped id. A body
   *  with nothing to point with (an emoji capsule) simply doesn't move — the
   *  camera swivel still conveys the direction. */
  function pointNpcArm(nodeId: string, worldTarget: { x: number; y: number }) {
    if (!world) return;
    const av = world.state.avatars[`npc_${nodeId}`] ?? world.state.avatars[nodeId];
    if (!av) return;
    av.gesture = {
      kind: "point",
      targetX: worldTarget.x,
      targetY: worldTarget.y,
      holdS: 2.0,
      id: (gestureSeq += 1),
    };
  }

  function closeCreatureConvo() {
    convo = null;
    choice = null;
    presenter.clearBoard();
    world?.setConversation(null);
    talkDwell.reset();
    leaveDwell.reset();
    feedPointer();
  }

  /**
   * Lazily register a streamed town resident as a NEEDLESS creature so a
   * passer-by talks through the SAME dialogue system as a quest-giver — its
   * tree is just simpler (small talk: hello, requests, where-is, gifts). No
   * prewritten needs or debts yet (those come later). Idempotent; the creature
   * persists for the session. A resident's node id IS its body id, and its
   * synthetic fulfill node carries a generic face id absent from `entities`
   * (so the caption speaks no species symbol) and NO need — every needs-driven
   * onFrame loop skips it (openNeeds is empty).
   */
  function ensureResidentCreature(session: QuestSession, residentId: string) {
    let creatures = session.creatures;
    if (!creatures) {
      creatures = {
        world: createCreatureWorld([{ id: PLAYER_CREATURE_ID }], []),
        creatureByNode: new Map(),
        nodeByCreature: new Map(),
      };
      session.creatures = creatures;
    }
    if (creatures.world.creatures[residentId]) return;
    creatures.world.creatures[residentId] = createCreatureWorld([{ id: residentId }], [])
      .creatures[residentId]!;
    const node: FulfillNode = {
      id: residentId,
      type: "fulfill",
      npcEntityId: `resident_face:${residentId}`,
    };
    creatures.creatureByNode.set(residentId, residentId);
    creatures.nodeByCreature.set(residentId, node);
  }

  function openCreatureConvo(nodeId: string) {
    // A fresh conversation: whatever another creature was still saying is stale.
    voice?.cancel();
    // Syntax level comes from the game's meta (the sandbox/world knob) — it
    // was silently hardcoded to "b" before, which made every line 2 glyphs.
    convo = {
      nodeId,
      level: sess?.game.meta.syntax ?? "b",
      memo: {},
      acts: [],
    };
    presentCreatureTurn();
  }

  /** A board press answered the creature conversation. */
  function handleCreatureAct(index: number) {
    const session = sess!;
    if (!convo || !session.creatures || !world) return;
    const act = convo.acts[index];
    if (!act) return;
    const node = session.creatures.nodeByCreature.get(convo.nodeId);

    if (act.kind === "confused") {
      convo.level = convo.level === "c" ? "b" : "a";
      presentCreatureTurn();
      return;
    }
    const res = selectAct(
      session.creatures.world,
      convo.nodeId,
      PLAYER_CREATURE_ID,
      act,
      convo.level,
      creatureProjectionOpts(session, node?.announce),
      convo.memo,
    );
    convo.memo = res.memo;
    // ASKED FOR DIRECTIONS: voice the phrase, swivel the camera + point, then
    // refresh the board. The pure layer handed us just the subject.
    if (res.askedDirections) {
      answerDirections(session, res.askedDirections);
      return;
    }
    // ESCORT (motive batch): agreeing to "take me to {dest}" starts the follow —
    // the creature trails the player until it reaches the destination (onFrame).
    if (act.kind === "agree") {
      const creature = session.creatures.world.creatures[convo.nodeId];
      if (creature && openNeeds(creature).some((n) => n.escort && n.atPlace)) {
        session.escorting.add(convo.nodeId);
      }
    }
    for (const event of res.events) {
      if (event.type === "transfer-pending") {
        console.log(`[symbol-game] transfer-pending: ${event.from} → ${event.to}: ${event.itemId}`);
      }
      if (event.type === "item-transferred") {
        // In creature worlds, transfers TO the player only conclude by TAKING —
        // the hand-over behavior (onFrame) does the physical delivery.
        if (event.to === PLAYER_CREATURE_ID && !session.creatures) {
          deliverStock(session, convo.nodeId, event.itemId);
        } else if (event.from === PLAYER_CREATURE_ID) {
          handOverItem(session, convo.nodeId, event.itemId);
        }
      } else if (event.type === "need-fulfilled") {
        fulfillIfContent(event.creatureId);
      }
    }
    if (res.close) {
      // A parting reaction (sad / ok / thanks) stays on screen after closing.
      if (res.responseGlyph) {
        const npcSym = node ? session.entities.get(node.npcEntityId)?.glyph : undefined;
        const at = poserPos(session, convo.nodeId);
        if (at && node) {
          showWorldBubble(world.state, `char:${node.npcEntityId}`, {
            anchor: { kind: "point", x: at.x, y: at.y },
            text: npcStatement(res.responseGlyph, npcSym),
            glyph: res.responseGlyph,
            ttl: 4,
          });
        }
        speakNpc(res.responseGlyph, npcSym);
      }
      closeCreatureConvo();
    } else if (convo) {
      // Opening or paging the "where is…" list is silent navigation — refresh
      // the board without re-greeting. Otherwise the reaction (a clue, "yes", a
      // refusal) IS this turn's spoken line.
      const navSilent = act.kind === "directions-menu" || act.kind === "more";
      presentCreatureTurn(res.responseGlyph, navSilent ? { speak: false, bubble: false } : {});
      if (res.followUpGlyph && node) {
        // A second line (the building clue) follows the first: its audio just
        // QUEUES behind the response (the speech queue serializes); the bubble
        // swaps over when the response is estimated to have finished.
        const npcSym = session.entities.get(node.npcEntityId)?.glyph;
        const followUp = res.followUpGlyph;
        const nodeId = convo.nodeId;
        speakNpc(followUp, npcSym);
        const delay = speechEstimateMs(npcStatement(res.responseGlyph ?? "", npcSym));
        setTimeout(() => {
          if (!world || sess !== session) return;
          if (convo?.nodeId !== nodeId) return; // walked away
          const at = poserPos(session, nodeId);
          if (!at) return;
          showWorldBubble(world.state, `char:${node.npcEntityId}`, {
            anchor: { kind: "point", x: at.x, y: at.y },
            text: npcStatement(followUp, npcSym),
            glyph: followUp,
            ttl: 6,
          });
        }, delay);
      }
    }
  }

  /** The live position of a node's embodied NPC, else its layout figure spot.
   *  A resident's node id IS its streamed body id (`resident_*`), so fall back
   *  to a bare-id avatar when there's no `npc_`-prefixed poser. */
  function poserPos(session: QuestSession, nodeId: string): { x: number; y: number } | null {
    const live = world?.state.avatars[`npc_${nodeId}`] ?? world?.state.avatars[nodeId];
    if (live) return { x: live.x, y: live.y };
    const fig = session.embedding.layout.figures.find((f) => f.nodeId === nodeId);
    return fig ? { x: fig.pos.x, y: fig.pos.y } : null;
  }

  /**
   * Queue an errand for an NPC — ONE task at a time (a creature carries one
   * carry-item at a time, so a trade becomes a SEQUENCE: take the payment, stow
   * it, fetch the requested item, bring it over). Every errand ends by walking
   * home, so the creature is always back at its spot, interactable.
   */
  function enqueueNpcErrand(session: QuestSession, npcId: string, errand: NpcErrand) {
    if (!world) return;
    const host = world;
    const queue = session.npcTasks.get(npcId) ?? [];
    session.npcTasks.set(npcId, queue);
    const wrapped: NpcErrand = {
      ...errand,
      onDone: () => {
        console.log(`[symbol-game] errand done: ${npcId} (${queue.length - 1} queued)`);
        errand.onDone?.();
        queue.shift();
        const next = queue[0];
        if (next) host.setNpcErrand(npcId, next);
      },
    };
    queue.push(wrapped);
    if (queue.length === 1) host.setNpcErrand(npcId, wrapped);
  }

  /** Does this NPC's body currently hold an object? (One at a time.) */
  function npcCarrying(npcId: string): string | undefined {
    if (!world) return undefined;
    return Object.values(world.state.objects).find((o) => o.carriedBy === npcId)?.id;
  }

  /**
   * A dialogue `receive` was granted: the vendor walks to the stock item, picks
   * it up, carries it over, and puts it down within the player's reach — then
   * returns home. Ownership releases at grant time.
   */
  function deliverStock(session: QuestSession, nodeId: string, entityId: string) {
    const stock = [...session.convItems.values()].find(
      (i) => i.kind === "stock" && i.forNodeId === nodeId && i.entityId === entityId && !session.granted.has(i.objectId),
    );
    if (!world || !stock) return;
    const host = world;
    session.granted.add(stock.objectId);
    session.absorbed.add(stock.objectId);
    const npcId = `npc_${nodeId}`;
    const npc = host.state.avatars[npcId];
    const player = host.state.avatars[PLAYER_ID];
    const obj = host.state.objects[stock.objectId];
    if (!obj) return;
    const home = session.staging.get(nodeId)?.home ?? { x: obj.x, y: obj.y };
    if (npc && player) {
      const dx = player.x - npc.x;
      const dy = player.y - npc.y;
      const d = Math.hypot(dx, dy) || 1;
      const handover = { x: npc.x + (dx / d) * 2.2, y: npc.y + (dy / d) * 2.2 };
      enqueueNpcErrand(session, npcId, {
        points: [{ x: obj.x, y: obj.y }, handover, home],
        onArrive: (i) => {
          if (i === 0 && !npcCarrying(npcId)) carryObject(host.state, stock.objectId, npcId);
          if (i === 1 && host.state.objects[stock.objectId]?.carriedBy === npcId) {
            dropObject(host.state, stock.objectId, handover.x, handover.y);
          }
        },
      });
    } else if (player) {
      // No embodied NPC (marker poser) — just set it out in front of the player.
      dropObject(host.state, stock.objectId, player.x + 1.4, player.y);
    }
  }

  /**
   * A dialogue `give` happened: the item leaves the player's hands (set down),
   * and the NPC walks over, takes it, stows it in its STOCKPILE, and returns
   * home — creatures don't stand around holding what they were given.
   */
  function handOverItem(session: QuestSession, nodeId: string, entityId: string) {
    if (!world) return;
    const host = world;
    const candidates = [...session.convItems.values()].filter(
      (i) => i.entityId === entityId && session.absorbed.has(i.objectId),
    );
    const held =
      candidates.find((i) => host.state.objects[i.objectId]?.carriedBy === PLAYER_ID) ??
      candidates[0];
    if (!held) return;
    const npcId = `npc_${nodeId}`;
    const npc = host.state.avatars[npcId];
    const obj = host.state.objects[held.objectId];
    if (!obj) return;
    const player = host.state.avatars[PLAYER_ID];
    // The gift leaves the player's hands immediately.
    if (obj.carriedBy === PLAYER_ID && player) {
      dropObject(host.state, held.objectId, player.x + 0.9, player.y + 0.9);
    }
    const staging = session.staging.get(nodeId);
    if (npc && staging) {
      const takeAt = { x: host.state.objects[held.objectId]!.x, y: host.state.objects[held.objectId]!.y };
      enqueueNpcErrand(session, npcId, {
        points: [takeAt, staging.stockpile, staging.home],
        onArrive: (i) => {
          if (i === 0 && !npcCarrying(npcId)) carryObject(host.state, held.objectId, npcId);
          if (i === 1 && host.state.objects[held.objectId]?.carriedBy === npcId) {
            dropObject(host.state, held.objectId, staging.stockpile.x, staging.stockpile.y);
          }
        },
      });
    } else {
      const at = poserPos(session, nodeId);
      dropObject(host.state, held.objectId, at?.x ?? obj.x, at?.y ?? obj.y);
    }
  }

  function processResult(result: RuntimeResult) {
    const session = sess!;
    session.rState = result.state;

    for (const command of result.commands) {
      switch (command.type) {
        case "unlock-passage":
          applySpace3DCommand(session.sState, command);
          // The passage's physical ENGINE door(s) unlock too — the barred leaf
          // becomes an ordinary door that swings open on approach.
          for (const doorId of session.village?.doorIdsByPassage[command.passageId] ?? []) {
            if (world) unlockDoor(world.state, doorId);
          }
          break;
        case "collect-item":
          applySpace3DCommand(session.sState, command);
          break;
        case "present-choice": {
          choice = command;
          // The avatar is frozen + the camera faces the poser via setConversation
          // (set by the dwell-to-talk trigger in onFrame); the pointer stays live.
          // The poser asks its question aloud, in a bubble over the character.
          const poserSym = session.entities.get(command.posedByEntityId)?.glyph;
          const fig = session.embedding.layout.figures.find((f) => f.nodeId === command.nodeId);
          if (world && fig) {
            showWorldBubble(world.state, `char:${command.posedByEntityId}`, {
              anchor: { kind: "point", x: fig.pos.x, y: fig.pos.y },
              text: npcStatement(command.prompt, poserSym), // translated caption
              glyph: command.prompt, // render the composed glyph image too
              ttl: 6,
            });
          }
          speakNpc(command.prompt, poserSym);
          // The presenter answers on whatever surface it owns — the AAC's REAL
          // response board (teaches its use), or an in-app panel. The entity's
          // COMPOSED glyph rides along so board buttons render the real symbol
          // the student is learning (emoji fallback included).
          presenter.board({
            kind: "choice",
            nodeId: command.nodeId,
            posedByEntityId: command.posedByEntityId,
            prompt: command.prompt,
            promptText: npcStatement(command.prompt, poserSym),
            options: command.options.map((o) => {
              const e = session.entities.get(o.entityId);
              const said = e?.glyph ? playerStatement(e.glyph) : (e?.spokenLabel ?? e?.label);
              return {
                id: o.entityId,
                label: said ?? e?.label ?? o.entityId,
                glyph: e?.glyph ?? e?.iconRef,
                spokenText: said,
                iconRef: e?.iconRef,
              };
            }),
          });
          break;
        }
        case "dismiss-choice":
          choice = null;
          presenter.clearBoard();
          // Leave the conversation: release the camera + resume steering.
          world?.setConversation(null);
          talkDwell.reset();
          leaveDwell.reset();
          feedPointer();
          break;
        case "demonstrate": {
          // Animate the cue props in-world (overlay), and caption the moment with
          // the taught glyph as a real world speech bubble over the stage — the
          // SAME bubble path a character or a remote player would use.
          overlay?.playDemonstration(command);
          const stage = session.embedding.layout.figures.find((f) => f.nodeId === command.nodeId);
          if (world && stage) {
            const caption = command.contrastGlyph
              ? `${npcStatement(command.targetGlyph)}  ↔  ${npcStatement(command.contrastGlyph)}`
              : npcStatement(command.targetGlyph);
            showWorldBubble(world.state, "demo:caption", {
              anchor: { kind: "point", x: stage.pos.x, y: stage.pos.y },
              text: caption,
              glyph: command.targetGlyph,
              ttl: 5,
            });
          }
          // Say the taught word aloud — reinforces glyph ↔ word ↔ what was shown.
          speakNpc(command.targetGlyph);
          break;
        }
        case "clear-obstacle":
        case "celebrate":
          break;
      }
    }

    for (const event of result.events) {
      switch (event.type) {
        case "narrate":
          presenter.toast(event.text, event.kind);
          break;
        case "objectives-changed":
          presenter.objectives(event.objectives);
          break;
        case "item-collected":
          presenter.collect(event.nodeId, event.have, event.need);
          break;
        case "goal-completed":
          presenter.score?.(Object.keys(session.rState.completed).length);
          break;
        case "game-won": {
          isWon = true;
          presenter.won();
          feedPointer();
          presenter.action?.("game_won");
          // The companion celebrates with a canned, language-keyed line over the
          // player — the same bubble + voice path a character uses.
          const line = resolveLine(SAMPLE_NPC_DIALOGUE, "celebrate", session.game.meta.locale);
          if (world && line) {
            showWorldBubble(world.state, "companion", {
              anchor: { kind: "avatar", id: PLAYER_ID },
              text: line.text,
              glyph: line.glyph,
              ttl: 5,
            });
            speakRaw(line.text);
          }
          break;
        }
        case "distractor-picked": {
          const icon = session.entities.get(event.entityId)?.iconRef ?? "❔";
          presenter.toast(`${icon} …`, "feedback");
          break;
        }
        case "item-acquired": {
          // Into the satchel (a converse prop pickup or an NPC's grant) — the
          // presenter's strip mirrors the runtime inventory.
          presenter.satchel({ ...session.rState.inventory });
          deliverStock(session, event.nodeId, event.entityId);
          const icon = session.entities.get(event.entityId)?.iconRef ?? "❔";
          presenter.toast(`🎒 ${icon}`, "feedback");
          break;
        }
        case "item-given": {
          presenter.satchel({ ...session.rState.inventory });
          handOverItem(session, event.nodeId, event.entityId);
          const icon = session.entities.get(event.entityId)?.iconRef ?? "❔";
          presenter.toast(`${icon} ➜ 🤝`, "feedback");
          break;
        }
        case "wrong-choice":
          if (!event.feedback) presenter.toast("❌", "feedback");
          break;
        case "zone-entered":
          if (event.hint) presenter.toast(event.hint, "intro");
          break;
        case "demonstration-shown":
          presenter.action?.("demonstration_shown", {
            nodeId: event.nodeId,
            targetGlyph: event.targetGlyph,
          });
          break;
        case "obstacle-locked":
        case "guard-cleared":
          break;
      }
    }
  }

  function dispatchInput(input: SpaceInput) {
    const session = sess!;
    processResult(applyRuntimeInput(session.ctx, session.rState, input));
  }

  /** Complete a creature's fulfill node only when it is fully CONTENT — a
   *  multi-item need fulfills one instance at a time, and the quest gate must
   *  wait for the last one. */
  function fulfillIfContent(creatureId: string) {
    const session = sess;
    const creature = session?.creatures?.world.creatures[creatureId];
    if (creature && openNeeds(creature).length > 0) return;
    dispatchInput({ type: "fulfill-need", nodeId: creatureId });
    // LIVING TOWN: a wanter made content is a DELIVERY — credit the
    // town's books, once per wanter (the DELIVERY contract: retention
    // holds in-session; the aggregate share lands in the stockpile).
    const t = session?.town;
    if (t && session && creature && creature.needs.length > 0 && !session.townCredited.has(creatureId)) {
      const entry = t.bundle.cast.find((c) => c.nodeId === creatureId && c.role === "wanter");
      if (entry) {
        session.townCredited.add(creatureId);
        creditDelivery(t.town, t.eco, entry.good);
      }
    }
  }

  /** (Re)build the world host for a session: 3D view + quest overlay + the wall
   *  constraint + the per-frame quest detection. Same loop as the social world. */
  function buildHost(session: QuestSession) {
    world?.stop(); // also disposes the previous view
    overlay = new GoalTreeOverlay3D({
      layout: session.embedding.layout,
      world: session.world,
      entities: session.entities,
      embodiedNodeIds: session.embodiedNodeIds,
      skipInstanceIds: new Set(
        [...session.convItems.values()].filter((i) => i.kind === "prop").map((i) => i.objectId),
      ),
      // With real buildings, doorways have physical ENGINE doors — the overlay
      // marks a locked one with a padlock badge instead of the red slab.
      doorStyle: session.village ? "badge" : "box",
      getView: () => ({
        removed: session.sState.removed,
        unlocked: session.sState.unlocked,
        completed: session.rState.completed,
      }),
    });
    // Render composed glyphs in in-world speech bubbles EXACTLY as the response
    // board renders them — same GlyphCompositor + the injected icon resolver.
    const glyphSource = createGlyphImageSource(
      deps.resolveImage ? { resolveImage: deps.resolveImage } : {},
    );
    const view = createWorld3DView(
      {
        canvas,
        localId: PLAYER_ID,
        faceFor: () => null,
        labelFor: (id) => (id === PLAYER_ID ? "You" : ""),
        glyphFor: glyphSource.glyphFor,
      },
      session.embedding.spec,
      {
        overlay,
        // SPIRIT: a fixed angled-overhead camera framing the whole scene.
        spirit,
        // A living town renders its people as creature-builder humans (residents
        // + player), keeping puzzle-givers as emoji capsules. A freestanding
        // quest world (no town) keeps the emoji-capsule cast.
        // SPIRIT: the local player is FORMLESS (empty model); NPCs render as
        // usual. Otherwise a living town gives everyone human bodies; a
        // freestanding quest keeps the emoji-capsule cast.
        modelFactory: ((base: AvatarModelFactory): AvatarModelFactory =>
          spirit ? (id, isLocal) => (isLocal ? emptyAvatarModel() : base(id, isLocal)) : base)(
          session.town
            ? makeTownModelFactory(session.npcIcons, "human_cute")
            : makePuzzleCharacterFactory(session.npcIcons),
        ),
        // A living town paints its streets on the ground (render-only ribbons).
        ...(session.town ? { roads: session.town.stage.roads } : {}),
      },
    );
    const host = runWorldHost({
      view,
      spec: session.embedding.spec,
      localId: PLAYER_ID,
      spawnIndex: 0,
      hostNpcs: true,
      // SPIRIT: the avatar never moves; carry goes distance-free (pick/place by gaze).
      ...(spirit ? { stationary: true } : {}),
      // A living town streams pure steering BODIES (the 2D lab's shared
      // street budget) — the engine's small default cap is for voiced NPCs.
      ...(session.town ? { maxNpcs: STREET_NPCS } : {}),
      // Feed the conversation start/cancel dwell into the gaze-spark bloom (it is
      // the selection indicator now — the old dwell ring is gone).
      cursorProgress: () => convoProgress,
      // With buildings, the ENGINE's structure constraint owns collision (house
      // walls + locked doors seal rooms; the manifold clamp bounds the field) —
      // the whole village ground is walkable. Without them, fall back to the
      // layout's invisible walls.
      // A living town streams its REAL walls (stage → setStructures);
      // its ground is open — never wrap it in the invisible quest walls.
      ...(session.village || session.town
        ? {}
        : { constraint: makeWallConstraint(session.embedding.layout, session.sState) }),
      // Carry the "move A→B" puzzle objects + converse items: dwell to pick up;
      // dwell on a spot to put them down. Vendor STOCK is owned — a completed
      // pick-dwell on it is DENIED (❌ + the owner's "mine!" bubble) until the
      // dialogue grants it.
      carry: {
        canPick: (objectId) => {
          const item = session.convItems.get(objectId);
          if (!item) return true;
          // Whoever OWNS it now is the truth. In creature worlds that's the
          // live creature-world owner (so an item you GAVE is theirs — taking
          // it back is vetoed just like untouched stock); in converse worlds
          // it's the static stock/granted rule.
          let ownerNodeId: string | null = null;
          if (session.creatures) {
            const st = session.creatures.world.items[item.entityId];
            // The ONE exception to the veto: an item pending transfer TO you —
            // taking it is how the transfer concludes.
            if (st?.pendingTransferTo === PLAYER_CREATURE_ID) return true;
            ownerNodeId = st?.ownerId && st.ownerId !== PLAYER_CREATURE_ID ? st.ownerId : null;
          } else if (item.kind === "stock" && !session.granted.has(objectId)) {
            ownerNodeId = item.forNodeId;
          }
          if (!ownerNodeId) return true;
          // Denied only while the owner is around to object.
          const owner = world?.state.avatars[`npc_${ownerNodeId}`];
          const obj = world?.state.objects[objectId];
          return !!owner && !!obj ? Math.hypot(owner.x - obj.x, owner.y - obj.y) > 8 : true;
        },
        onPickDenied: (objectId) => {
          const item = session.convItems.get(objectId);
          if (!world || !item) return;
          const obj = world.state.objects[objectId];
          if (obj) {
            showWorldBubble(world.state, `denied:${objectId}`, {
              anchor: { kind: "point", x: obj.x, y: obj.y },
              text: "❌",
              ttl: 1.6,
            });
          }
          // The owner objects: "that's my {item}!" — the `my` possession
          // modifier on the item's glyph, over the CURRENT owner's head.
          const entity = session.entities.get(item.entityId);
          const glyph = entity?.glyph ? `${entity.glyph}.my` : undefined;
          const creatureOwner = session.creatures?.world.items[item.entityId]?.ownerId;
          const ownerNode =
            creatureOwner && creatureOwner !== PLAYER_CREATURE_ID ? creatureOwner : item.forNodeId;
          const npcId = `npc_${ownerNode}`;
          if (world.state.avatars[npcId]) {
            const ownerSym = creatureGlyph(session, ownerNode);
            showWorldBubble(world.state, `mine:${item.forNodeId}`, {
              anchor: { kind: "avatar", id: npcId },
              // "cookie.my" → "my cookie" / "העוגייה שלי" — caption + voice.
              text: glyph ? npcStatement(glyph, ownerSym) : (entity?.label ?? "mine"),
              ...(glyph ? { glyph } : {}),
              ttl: 2.5,
            });
            if (glyph) speakNpc(glyph, ownerSym);
            else speakRaw(entity?.label ?? "");
          }
        },
      },
      onFrame: (state, dt) => {
        // Host-side per-frame passthrough (HUD gaze refresh etc).
        deps.onFrame?.(dt);
        // LIVING TOWN: stream the stage around the player — walls of the
        // nearby houses, residents embodying mid-errand, fresh shopping
        // trips on the street clock. The stage is cheap when nothing moves.
        if (session.town) {
          session.townClock += dt;
          const meTown = state.avatars[PLAYER_ID];
          const townHost = world;
          if (meTown && townHost) {
            // Interior VISIBILITY — the same signal the renderer uses to see
            // inside — drives which houses embody their residents (not the raw
            // "player standing in this house" test). A house `h_<index>` is
            // visible when the player is inside it or an open door reveals it.
            const vis = visibleBuildings(state, { x: meTown.x, y: meTown.y });
            const f = session.town.stage.frame(
              { x: meTown.x, y: meTown.y },
              session.townClock,
              // The model's lock + candidacy read LIVE body positions.
              (id) => {
                const a = state.avatars[id];
                return a ? { x: a.x, y: a.y } : null;
              },
              // The camera's world reach — feeds only the pop-in rule
              // (spawn through buildings where the view could see thin
              // air). A view-specific input by design, never mechanics.
              120,
              (houseIndex) => vis.has(`h_${houseIndex}`),
            );
            if (f.buildings) townHost.setBuildings(f.buildings);
            for (const o of f.addObjects) townHost.addObject(o);
            for (const id of f.removeObjects) townHost.removeObject(id);
            for (const n of f.add) {
              session.npcIcons.set(n.id, "🙂");
              townHost.addNpc(n);
            }
            for (const id of f.remove) townHost.removeNpc(id);
            for (const e of f.errands) townHost.setNpcErrand(e.npcId, { points: e.points });
          }
        }
        // DEVICES (§5) are TAP-to-toggle, not carry: a completed pick-dwell flips
        // the device IN PLACE (drop it straight back). Powering is MANUAL — tap
        // the generator first; an unpowered toggle no-ops with a hint at the
        // source. The tap cooldown stops a held gaze from flipping every frame.
        if (session.creatures) {
          const cworld = session.creatures.world;
          for (const [k, v] of session.tapCooldown) session.tapCooldown.set(k, Math.max(0, v - dt));
          for (const [objId, item] of session.convItems) {
            const dev = cworld.items[item.entityId];
            if (!dev?.device) continue;
            const obj = state.objects[objId];
            if (obj?.carriedBy !== PLAYER_ID) continue;
            // Drop it back at its ORIGINAL spot (a carried object's live x/y has
            // already snapped to the player's hand) — a device stays put.
            const home = item.pos ?? { x: obj.x, y: obj.y };
            dropObject(state, objId, home.x, home.y);
            if ((session.tapCooldown.get(objId) ?? 0) > 0) continue;
            session.tapCooldown.set(objId, TAP_COOLDOWN_S);
            const cur = dev.states.find((s) => DEVICE_ANTONYM[s]) ?? "off";
            const target = DEVICE_ANTONYM[cur] ?? "on";
            const events = toggleDevice(cworld, PLAYER_CREATURE_ID, item.entityId, target);
            const toggled = events.some((e) => e.type === "item-transformed");
            const newGlyph = liveItemGlyph(session, item.entityId);
            const specObj = state.spec.objects.find((o) => o.id === objId);
            if (specObj) specObj.glyph = newGlyph; // render re-rasters the icon
            if (!toggled && dev.poweredBy) {
              // Blocked: no power. Point at the source to switch on first.
              const srcGlyph = liveItemGlyph(session, dev.poweredBy.deviceId);
              showWorldBubble(state, `nopower:${objId}`, {
                anchor: { kind: "point", x: home.x, y: home.y },
                text: "",
                glyph: srcGlyph,
                ttl: 2.5,
              });
              speakNpc(srcGlyph);
            } else if (toggled) {
              showWorldBubble(state, `device:${objId}`, {
                anchor: { kind: "point", x: home.x, y: home.y },
                text: "",
                glyph: newGlyph,
                ttl: 2,
              });
            }
            for (const ev of events) {
              if (ev.type !== "need-fulfilled") continue;
              const npcId = `npc_${ev.creatureId}`;
              if (state.avatars[npcId]) {
                showWorldBubble(state, `thanks:${ev.creatureId}`, {
                  anchor: { kind: "avatar", id: npcId },
                  text: "",
                  glyph: "thank_you",
                  ttl: 3,
                });
              }
              speakNpc("thank_you", creatureGlyph(session, ev.creatureId));
              fulfillIfContent(ev.creatureId);
            }
          }
        }
        // Converse items are PHYSICAL: picking one up registers it in the
        // runtime satchel exactly once — the object stays in hand (carrying it
        // IS having it). Stock was already granted by the dialogue.
        for (const [objId, item] of session.convItems) {
          if (session.absorbed.has(objId)) continue;
          // Devices tap-toggle (above) — they're never absorbed into the satchel.
          if (session.creatures?.world.items[item.entityId]?.device) continue;
          if (state.objects[objId]?.carriedBy !== PLAYER_ID) continue;
          session.absorbed.add(objId);
          if (session.creatures?.nodeByCreature.has(item.forNodeId)) {
            // Creature world: taking a PENDING item concludes its transfer
            // (ownership + debt); a loose item is CLAIMED (provenance rules).
            const st = session.creatures.world.items[item.entityId];
            const events =
              st?.pendingTransferTo === PLAYER_CREATURE_ID
                ? concludeTransfer(session.creatures.world, PLAYER_CREATURE_ID, item.entityId)
                : claimItem(session.creatures.world, PLAYER_CREATURE_ID, item.entityId, {
                    takerAcceptsAnything: true,
                  }).events;
            for (const ev of events) {
              if (ev.type === "need-fulfilled") fulfillIfContent(ev.creatureId);
            }
          } else if (item.kind === "prop") {
            dispatchInput({ type: "pick-item", instanceId: objId, entityId: item.entityId });
          }
        }
        // Transport puzzles complete when the TARGET lands on its destination.
        // A wrong carryable (selection beat) is gently DECLINED — ejected so it
        // can be carried again — never a fail state.
        for (const t of session.transports) {
          if (session.rState.completed[t.nodeId]) continue;
          // A selection beat: the recipient "asks" for the wanted item via a glyph
          // bubble over it (so it never has to wear the item's icon).
          if (t.wantGlyph) {
            const dn = state.objects[t.destId];
            if (dn) {
              showWorldBubble(state, `want:${t.nodeId}`, {
                anchor: { kind: "point", x: dn.x, y: dn.y },
                text: "",
                glyph: t.wantGlyph,
                ttl: 1.5,
              });
            }
          }
          const held = state.objects[t.objectId]?.containedIn;
          if (held?.objectId === t.destId && (!t.relation || held.relation === t.relation)) {
            dispatchInput({ type: "place-object", nodeId: t.nodeId });
            continue;
          }
          for (const did of t.distractorObjectIds) {
            if (state.objects[did]?.containedIn?.objectId === t.destId) {
              const dest = state.objects[t.destId];
              if (dest) dropObject(state, did, dest.x + 1.8, dest.y - 1.4);
              presenter.toast("Not that one — bring the matching one!", "feedback");
            }
          }
        }
        // Request-c THOUGHT scaffold: an inferring creature (announce "never")
        // wishes its want in a THOUGHT bubble — dashed, circle-tailed, clearly
        // not speech. The low-phase errorless aid; the phase layer will fade
        // it, leaving only the sad emote + the keepsake evidence.
        if (session.creatures) {
          for (const [cid, node] of session.creatures.nodeByCreature) {
            if (node.announce !== "never" || !node.thoughtScaffold) continue;
            const creature = session.creatures.world.creatures[cid];
            const need = creature ? openNeeds(creature)[0] : undefined;
            const npcId = `npc_${cid}`;
            if (!need || !state.avatars[npcId]) continue;
            showWorldBubble(state, `thought:${cid}`, {
              anchor: { kind: "avatar", id: npcId },
              text: "",
              glyph: wantGlyphOf(session, need),
              style: "thought",
              ttl: 1.5, // refreshed every frame while the need is open
            });
          }
        }
        // Transformation stations: an item dropped ON one gets its state
        // swapped (fire → hot, water → cold), is set back down beside the
        // station, and shows/speaks its new composed glyph. Reusable and
        // idempotent — a wrong-direction drop just comes back unchanged.
        if (session.creatures) {
          for (const st of session.stations) {
            for (const [objId, item] of session.convItems) {
              const obj = state.objects[objId];
              if (obj?.containedIn?.objectId !== st.objectId) continue;
              // POWER-GATED (§5): useStation no-ops unless the generator is ON.
              const events = useStation(
                session.creatures.world,
                item.entityId,
                st.applies,
                st.removes,
                st.powerDeviceId,
              );
              const stObj = state.objects[st.objectId];
              dropObject(state, objId, (stObj?.x ?? obj.x) + 1.6, (stObj?.y ?? obj.y) + 1.4);
              if (!events.length) {
                // Dead station? If it's power-gated and unpowered, hint at the
                // generator to switch on first.
                if (
                  st.powerDeviceId &&
                  !session.creatures.world.items[st.powerDeviceId]?.states.includes("on") &&
                  stObj
                ) {
                  const srcGlyph = liveItemGlyph(session, st.powerDeviceId);
                  showWorldBubble(state, `station-nopower:${st.objectId}`, {
                    anchor: { kind: "point", x: stObj.x, y: stObj.y },
                    text: "",
                    glyph: srcGlyph,
                    ttl: 2.5,
                  });
                  speakNpc(srcGlyph);
                }
                continue;
              }
              const newGlyph = liveItemGlyph(session, item.entityId);
              const specObj = state.spec.objects.find((o) => o.id === objId);
              if (specObj) specObj.glyph = newGlyph; // render3d re-rasters the icon
              if (stObj) {
                showWorldBubble(state, `station:${st.objectId}`, {
                  anchor: { kind: "point", x: stObj.x, y: stObj.y },
                  text: "",
                  glyph: newGlyph,
                  ttl: 3,
                });
              }
              speakNpc(newGlyph);
            }
          }
        }
        // Placement (state) needs: a drop INTO the creature's container is what
        // fulfills — the transport watch's shape, but the completion is a
        // creature-world event (notePlacement: bind + debt), not a node input.
        if (session.creatures) {
          for (const d of session.placeDests) {
            const cworld: CreatureWorld = session.creatures.world;
            const creature = cworld.creatures[d.nodeId];
            const open = creature?.needs.filter((n: CreatureNeed) => !n.fulfilled && n.placedAt === d.entityId) ?? [];
            for (const need of open) {
              const conv = [...session.convItems.values()].find((i) => i.entityId === need.itemId);
              if (!conv || state.objects[conv.objectId]?.containedIn?.objectId !== d.objectId) continue;
              const events = notePlacement(cworld, PLAYER_CREATURE_ID, need.itemId, d.entityId);
              for (const ev of events) {
                if (ev.type !== "need-fulfilled") continue;
                const npcId = `npc_${ev.creatureId}`;
                if (state.avatars[npcId]) {
                  showWorldBubble(state, `thanks:${ev.creatureId}`, {
                    anchor: { kind: "avatar", id: npcId },
                    text: "",
                    glyph: "thank_you",
                    ttl: 3,
                  });
                }
                speakNpc("thank_you", creatureGlyph(session, ev.creatureId));
                fulfillIfContent(ev.creatureId);
              }
            }
            // A drop that DIDN'T fulfill (wrong variant / untransformed) is
            // gently ejected, and the creature restates what it wants — never
            // a fail state, never an item stuck in a box.
            for (const [objId, item] of session.convItems) {
              const obj = state.objects[objId];
              if (obj?.containedIn?.objectId !== d.objectId) continue;
              const wst = cworld.items[item.entityId];
              if (wst?.ownerId === d.nodeId && wst.bound) continue; // the fulfilled scene
              const destObj = state.objects[d.objectId];
              dropObject(state, objId, (destObj?.x ?? obj.x) + 1.8, (destObj?.y ?? obj.y) - 1.4);
              const needed = creature?.needs.find((n: CreatureNeed) => !n.fulfilled && n.placedAt === d.entityId);
              const npcId = `npc_${d.nodeId}`;
              if (needed && state.avatars[npcId]) {
                const wantGlyph = wantGlyphOf(session, needed);
                showWorldBubble(state, `place-want:${d.nodeId}`, {
                  anchor: { kind: "avatar", id: npcId },
                  text: "",
                  glyph: wantGlyph,
                  ttl: 3,
                });
                speakNpc(wantGlyph, creatureGlyph(session, d.nodeId));
              }
            }
          }
        }
        // Presence (go-to) needs (§5): arriving in the DESTINATION creature's
        // zone fulfills them — no item, just BE there (noteArrival). STAY and
        // ESCORT flavors are excluded: stay needs a timed dwell, escort needs
        // the CREATURE (not the player) to arrive — each has its own loop below.
        if (session.creatures) {
          const cworld = session.creatures.world;
          const player = state.avatars[PLAYER_ID];
          const zone = player ? zoneAt(session.embedding.layout, { x: player.x, y: player.y }) : null;
          if (zone) {
            for (const cid of [...session.creatures.nodeByCreature.keys()].sort()) {
              const need = openNeeds(cworld.creatures[cid]!).find((n) => n.atPlace && !n.stay && !n.escort);
              if (!need?.atPlace || session.world.sites[need.atPlace] !== zone) continue;
              const events = noteArrival(cworld, PLAYER_CREATURE_ID, need.atPlace);
              for (const ev of events) {
                if (ev.type !== "need-fulfilled") continue;
                const npcId = `npc_${ev.creatureId}`;
                if (state.avatars[npcId]) {
                  showWorldBubble(state, `thanks:${ev.creatureId}`, {
                    anchor: { kind: "avatar", id: npcId },
                    text: "",
                    glyph: "thank_you",
                    ttl: 3,
                  });
                }
                speakNpc("thank_you", creatureGlyph(session, ev.creatureId));
                fulfillIfContent(ev.creatureId);
              }
            }
          }
        }
        // STAY-WITH needs (motive batch): keeping the lonely creature COMPANY
        // for a while is the remedy. Presence near its avatar accumulates; a
        // walk-away resets (staying means staying). Done → "I'm okay, thank
        // you!", the need fulfills, the condition clears.
        if (session.creatures) {
          const cworld = session.creatures.world;
          const player = state.avatars[PLAYER_ID];
          for (const cid of [...session.creatures.nodeByCreature.keys()].sort()) {
            const need = openNeeds(cworld.creatures[cid]!).find((n) => n.stay && n.atPlace);
            if (!need) {
              session.stayDwell.delete(cid);
              continue;
            }
            const npc = state.avatars[`npc_${cid}`];
            if (!npc || !player) continue;
            const near = Math.hypot(npc.x - player.x, npc.y - player.y) <= STAY_RADIUS;
            const t = near ? (session.stayDwell.get(cid) ?? 0) + dt : 0;
            session.stayDwell.set(cid, t);
            if (t < STAY_SECONDS) continue;
            session.stayDwell.delete(cid);
            const events = noteArrival(cworld, PLAYER_CREATURE_ID, need.atPlace!);
            if (!events.some((e) => e.type === "need-fulfilled")) continue;
            const npcSym = creatureGlyph(session, cid);
            showWorldBubble(state, `thanks:${cid}`, {
              anchor: { kind: "avatar", id: `npc_${cid}` },
              text: npcStatement(STAY_DONE_LINE, npcSym),
              glyph: STAY_DONE_LINE,
              ttl: 4,
            });
            speakNpc(STAY_DONE_LINE, npcSym);
            fulfillIfContent(cid);
            // Mid-conversation completion: the projection just changed.
            if (convo?.nodeId === cid) presentCreatureTurn();
          }
        }
        // ESCORT needs (motive batch): an agreed follower trails the player;
        // reaching the DESTINATION creature's zone fulfills ("take me to Bear").
        if (session.creatures && session.escorting.size > 0) {
          const cworld = session.creatures.world;
          const player = state.avatars[PLAYER_ID];
          for (const cid of [...session.escorting].sort()) {
            const need = openNeeds(cworld.creatures[cid]!)?.find((n) => n.escort && n.atPlace);
            if (!need?.atPlace) {
              session.escorting.delete(cid);
              continue;
            }
            const npcId = `npc_${cid}`;
            const npc = state.avatars[npcId];
            if (!npc || !player) continue;
            // Arrived? The FOLLOWER's own position decides, not the player's.
            const zone = zoneAt(session.embedding.layout, { x: npc.x, y: npc.y });
            if (zone && session.world.sites[need.atPlace] === zone) {
              session.escorting.delete(cid);
              session.npcTasks.delete(npcId);
              // It lives here now — home moves, so it doesn't wander back.
              const staged = session.staging.get(cid);
              if (staged) staged.home = { x: npc.x, y: npc.y };
              const events = noteArrival(cworld, PLAYER_CREATURE_ID, need.atPlace);
              if (events.some((e) => e.type === "need-fulfilled")) {
                const npcSym = creatureGlyph(session, cid);
                showWorldBubble(state, `thanks:${cid}`, {
                  anchor: { kind: "avatar", id: npcId },
                  text: npcStatement("thank_you", npcSym),
                  glyph: "thank_you",
                  ttl: 4,
                });
                speakNpc("thank_you", npcSym);
                fulfillIfContent(cid);
              }
              continue;
            }
            // Follow: re-path toward the player whenever idle and trailing.
            const gap = Math.hypot(npc.x - player.x, npc.y - player.y);
            if (gap > FOLLOW_GAP && (session.npcTasks.get(npcId)?.length ?? 0) === 0) {
              enqueueNpcErrand(session, npcId, {
                points: [{ x: player.x + 1.4, y: player.y + 1.0 }],
              });
            }
          }
        }
        // ── Hand-over BEHAVIOR (not a scripted step): a creature with empty
        // hands, no running task, and an item it AGREED to hand over fetches it
        // and sets it down within the recipient's reach. Re-triggers until the
        // recipient actually takes it (emergent, self-healing).
        if (session.creatures) {
          const playerAv = state.avatars[PLAYER_ID];
          for (const cid of session.creatures.nodeByCreature.keys()) {
            const npcId = `npc_${cid}`;
            if (!state.avatars[npcId] || playerAv === undefined) continue;
            if ((session.npcTasks.get(npcId)?.length ?? 0) > 0 || npcCarrying(npcId)) continue;
            const pending = pendingTransfers(session.creatures.world, cid).find(
              (p) => p.pendingTransferTo === PLAYER_CREATURE_ID,
            );
            if (!pending) continue;
            const conv = [...session.convItems.values()].find((i) => i.entityId === pending.id);
            const obj = conv ? state.objects[conv.objectId] : undefined;
            // TEMP diagnostics for the hand-over behavior (remove once stable).
            const skip = !conv
              ? "no world object mapped"
              : !obj
                ? "object missing from state"
                : obj.carriedBy
                  ? `carried by ${obj.carriedBy}`
                  : // Only skip when it's genuinely AT HAND (the delivery drop
                    // lands ~2.0 away) — behind-the-counter stock at 2.5–3 must
                    // still be walked over, not left for the player to fish out.
                    Math.hypot(obj.x - playerAv.x, obj.y - playerAv.y) <= 2.2
                    ? "already within reach"
                    : null;
            if (skip) {
              dlogOnce(session, `handover:${cid}:${pending.id}:${skip}`, `[symbol-game] hand-over ${cid} → ${pending.id} skipped: ${skip}`);
              continue;
            }
            if (!conv || !obj) continue; // (narrowing — skip already covered these)
            const npc = state.avatars[npcId]!;
            const home = session.staging.get(cid)?.home ?? { x: npc.x, y: npc.y };
            const objectId = conv.objectId;
            dlogOnce(session, `handover:${cid}:${pending.id}:go`, `[symbol-game] hand-over ${cid} → ${pending.id}: errand start`);
            enqueueNpcErrand(session, npcId, {
              points: [{ x: obj.x, y: obj.y }, { x: playerAv.x + 1.6, y: playerAv.y + 1.2 }, home],
              onArrive: (i) => {
                if (!world) return;
                if (i === 0 && !npcCarrying(npcId)) carryObject(world.state, objectId, npcId);
                if (i === 1 && world.state.objects[objectId]?.carriedBy === npcId) {
                  const o = world.state.objects[objectId]!;
                  dropObject(world.state, objectId, o.x, o.y);
                }
              },
            });
          }
          // ── AUTO-TAKE: an item a creature agreed to hand over, sitting free
          // within arm's reach, becomes CARRIED the moment the player rests
          // their gaze on it — receiving a gift shouldn't need a pick-dwell.
          // Empty hands only (one carried item at a time); the absorb loop
          // above then concludes the transfer like any other take.
          const gzTake = world?.getGaze();
          const playerHolds = Object.values(state.objects).some((o) => o.carriedBy === PLAYER_ID);
          if (playerAv && gzTake && !playerHolds) {
            for (const [objId, item] of session.convItems) {
              const st = session.creatures.world.items[item.entityId];
              if (st?.pendingTransferTo !== PLAYER_CREATURE_ID) continue;
              const obj = state.objects[objId];
              if (!obj || obj.carriedBy) continue;
              if (Math.hypot(obj.x - playerAv.x, obj.y - playerAv.y) > 2.6) continue;
              const fix = gzTake.committedWorld;
              const looking =
                gzTake.hover?.id === objId ||
                (!!fix && Math.hypot(fix.x - obj.x, fix.y - obj.y) <= 1.2);
              if (!looking) continue;
              carryObject(state, objId, PLAYER_ID);
              break;
            }
          }
        }
        // ── NPC conversation: approach bubble → dwell-to-talk → camera-face → cancel.
        const cvHost = world;
        const meAv = state.avatars[PLAYER_ID];
        let progress = 0;
        if (cvHost && meAv) {
          const gz = cvHost.getGaze();
          const fix = gz.committedWorld;
          const onFig = (px: number, py: number, r: number) =>
            !!fix && Math.hypot(fix.x - px, fix.y - py) <= r;
          const active = choice;
          if (active) {
            // Talking: hold the camera on the poser (LIVE position — the NPC
            // may have walked an errand); dwell on empty ground to leave.
            talkDwell.reset();
            const fig = poserPos(session, active.nodeId);
            if (fig) {
              cvHost.setConversation({ x: fig.x, y: fig.y });
              // The leave target is the fixation when it's NOT resting on the poser.
              const g = fix && !onFig(fig.x, fig.y, CONVO_FIG_RADIUS) ? { x: fix.x, y: fix.y } : null;
              const res = leaveDwell.step(g, dt * 1000);
              progress = res.progress;
              if (res.fired) {
                if (convo) closeCreatureConvo();
                else dispatchInput({ type: "cancel-choice", nodeId: active.nodeId });
              }
            }
          } else {
            // Find the nearest incomplete choose/converse poser within range.
            let nearFig: { nodeId: string; pos: { x: number; y: number } } | null = null;
            let nearD = Infinity;
            let nearRes: { id: string; pos: { x: number; y: number } } | null = null;
            let nearResD = Infinity;
            if (spirit) {
              // SPIRIT: talk to whoever the gaze RESTS on, at ANY distance (no
              // walking). Items are picked/placed by the host's distance-free carry.
              const hv = cvHost.getGaze().hover;
              const av = hv?.kind === "avatar" ? state.avatars[hv.id] : undefined;
              if (hv?.kind === "avatar" && av) {
                if (hv.id.startsWith("npc_")) {
                  const nodeId = hv.id.slice(4);
                  const t = session.ctx.nodeById.get(nodeId)?.type;
                  const talkable = t === "choose" || t === "converse" || t === "fulfill";
                  if (talkable && (t === "fulfill" || !session.rState.completed[nodeId])) {
                    nearFig = { nodeId, pos: poserPos(session, nodeId) ?? { x: av.x, y: av.y } };
                    nearD = 0;
                  }
                } else if (hv.id.startsWith("resident_")) {
                  nearRes = { id: hv.id, pos: { x: av.x, y: av.y } };
                  nearResD = 0;
                }
              }
            } else {
              // Nearest incomplete choose/converse/fulfill poser within range.
              for (const f of session.embedding.layout.figures) {
                const t = session.ctx.nodeById.get(f.nodeId)?.type;
                if (t !== "choose" && t !== "converse" && t !== "fulfill") continue;
                // A content creature (fulfill w/o need completes at start) stays
                // approachable — its service (vendor) IS the conversation.
                if (session.rState.completed[f.nodeId] && t !== "fulfill") continue;
                // LIVE position — an embodied NPC may be off its layout spot.
                const pos = poserPos(session, f.nodeId) ?? f.pos;
                const d = Math.hypot(meAv.x - pos.x, meAv.y - pos.y);
                if (d <= CONVO_RADIUS && d < nearD) { nearD = d; nearFig = { nodeId: f.nodeId, pos }; }
              }
              // Regular residents (streamed townsfolk) are talkable too — a
              // "quest-giver with no quest": a friendly greeting on dwell. A
              // resident only wins when it's closer than any quest poser.
              for (const [id, av] of Object.entries(state.avatars)) {
                if (!id.startsWith("resident_")) continue;
                const d = Math.hypot(meAv.x - av.x, meAv.y - av.y);
                if (d <= CONVO_RADIUS && d < nearResD) { nearResD = d; nearRes = { id, pos: { x: av.x, y: av.y } }; }
              }
            }
            if (nearFig && nearD <= nearResD) {
              const node = session.ctx.nodeById.get(nearFig.nodeId);
              // Approach bubble (refreshed while in range): a choose shows its
              // prompt; a converse previews its entry turn's default line.
              let greet = "";
              if (node?.type === "choose") greet = node.prompt;
              else if (node?.type === "converse") {
                const entryTurn = node.turns.find((turn) => turn.id === node.entry);
                greet = entryTurn?.lines[entryTurn.lines.length - 1]?.glyph ?? "";
              } else if (node?.type === "fulfill" && session.creatures) {
                greet = projectDialogue(
                  session.creatures.world,
                  node.id,
                  PLAYER_CREATURE_ID,
                  "b",
                  creatureProjectionOpts(session, node.announce),
                ).lineGlyph;
              }
              showWorldBubble(cvHost.state, `npc-greet:${nearFig.nodeId}`, {
                anchor: { kind: "point", x: nearFig.pos.x, y: nearFig.pos.y },
                text: greet ? npcStatement(greet, creatureGlyph(session, nearFig.nodeId)) : "",
                glyph: greet || undefined,
                ttl: 1.5,
              });
              // Dwell ON the poser → present the choice + face the camera.
              leaveDwell.reset();
              const onN = onFig(nearFig.pos.x, nearFig.pos.y, CONVO_FIG_RADIUS);
              const res = talkDwell.step(onN ? { x: nearFig.pos.x, y: nearFig.pos.y } : null, dt * 1000);
              progress = res.progress;
              if (res.fired) {
                clearWorldBubble(cvHost.state, `npc-greet:${nearFig.nodeId}`);
                cvHost.setConversation({ x: nearFig.pos.x, y: nearFig.pos.y });
                if (node?.type === "fulfill") openCreatureConvo(nearFig.nodeId);
                else dispatchInput({ type: "touch-figure", nodeId: nearFig.nodeId });
              }
            } else if (nearRes) {
              // A resident with no quest: a "quest-giver with no quest". It uses
              // the SAME dialogue system as everyone else — a needless creature,
              // so its projected tree is just small talk (hello, requests,
              // where-is, gifts). Registered lazily on first approach.
              ensureResidentCreature(session, nearRes.id);
              const greet = projectDialogue(
                session.creatures!.world,
                nearRes.id,
                PLAYER_CREATURE_ID,
                "b",
                creatureProjectionOpts(session),
              ).lineGlyph;
              showWorldBubble(cvHost.state, `npc-greet:${nearRes.id}`, {
                anchor: { kind: "point", x: nearRes.pos.x, y: nearRes.pos.y },
                text: greet ? npcStatement(greet) : "",
                glyph: greet || undefined,
                ttl: 1.5,
              });
              // Dwell ON the resident → open the conversation board + face them.
              leaveDwell.reset();
              const onN = onFig(nearRes.pos.x, nearRes.pos.y, CONVO_FIG_RADIUS);
              const res = talkDwell.step(onN ? { x: nearRes.pos.x, y: nearRes.pos.y } : null, dt * 1000);
              progress = res.progress;
              if (res.fired) {
                clearWorldBubble(cvHost.state, `npc-greet:${nearRes.id}`);
                cvHost.setConversation({ x: nearRes.pos.x, y: nearRes.pos.y });
                openCreatureConvo(nearRes.id);
              }
            } else {
              talkDwell.reset();
              leaveDwell.reset();
            }
          }
        }
        // The dwell-to-select indicator is the gaze SPARK's bloom now (render3d) —
        // it hovers over the very item being chosen. `progress` reaches the
        // spark via the host's `cursorProgress` dep. (Old 2D dwell ring removed.)
        convoProgress = progress;

        if (!steering()) return;
        const me = state.avatars[PLAYER_ID];
        if (!me) return;
        for (const input of detectSpace3D(session.embedding.layout, session.sState, { x: me.x, y: me.y }, dt)) {
          // Choose/converse nodes begin by DWELLING on the poser (conversation),
          // not by walking into them — skip the proximity auto-trigger for them.
          if (input.type === "touch-figure") {
            const t = session.ctx.nodeById.get(input.nodeId)?.type;
            if (t === "choose" || t === "converse") continue;
          }
          // Converse props are physical carryables now — no walk-over pickup.
          if (input.type === "pick-item" && session.convItems.has(input.instanceId)) continue;
          // Entering a creature's room: displayed stock (and anything loose)
          // is SEEN — sight is knowledge (creature-needs.md §5).
          if (input.type === "enter-zone" && session.creatures) {
            const ownerNodeId = session.world.zones.find((z) => z.id === input.zoneId)?.ownerNodeId;
            const node = ownerNodeId ? session.creatures.nodeByCreature.get(ownerNodeId) : undefined;
            if (node) {
              for (const id of node.stockEntityIds ?? []) {
                seeItem(session.creatures.world, PLAYER_CREATURE_ID, id, { kind: "held", by: node.id });
              }
              for (const id of node.propEntityIds ?? []) {
                if (session.creatures.world.items[id]?.ownerId === null) {
                  seeItem(session.creatures.world, PLAYER_CREATURE_ID, id, { kind: "loose" });
                }
              }
            }
          }
          dispatchInput(input);
        }
      },
      scheduleFrame: (cb) => {
        const id = requestAnimationFrame(cb);
        return () => cancelAnimationFrame(id);
      },
      now: () => performance.now(),
    });
    host.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
    host.start();
    world = host;
    dispatchInput({ type: "start" });
    feedPointer();
  }

  function start(game: GoalTreeGame, town: TownPlay | null = null, opts: { spirit?: boolean } = {}) {
    spirit = !!opts.spirit;
    sess = makeQuestSession(game, town);
    buildTownPlaceFacts(sess); // the town's common knowledge of places (no-op off a town)
    isWon = false;
    choice = null;
    convo = null;
    presenter.sessionStarted(sess);
    buildHost(sess);
  }

  return {
    start,
    replay() {
      const s = sess!;
      if (s.town) {
        // A town session rebuilds FROM ITS CONFIG (fresh stage streaming
        // state; the deterministic build returns the same town and quests).
        const play = buildTownPlay(s.town.config);
        start(play.bundle.game, play);
      } else {
        start(s.game);
      }
    },
    select(id, opts = {}) {
      if (convo && id.startsWith("act_")) {
        const index = Number(id.slice(4));
        const act = convo.acts[index];
        if (!act) return;
        const said = playerStatement(act.glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        handleCreatureAct(index);
      } else if (choice) {
        const e = sess?.entities.get(id);
        const said = e?.glyph ? playerStatement(e.glyph) : (e?.spokenLabel ?? e?.label ?? "");
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        dispatchInput({ type: "select-option", nodeId: choice.nodeId, entityId: id });
      }
    },
    cancelChoice() {
      if (convo) closeCreatureConvo();
      else if (choice) dispatchInput({ type: "cancel-choice", nodeId: choice.nodeId });
    },
    setPointer(clientX, clientY) {
      lastClient = { x: clientX, y: clientY };
      feedPointer();
    },
    clearPointer() {
      lastClient = null;
      world?.clearPointer();
    },
    setPaused(p) {
      paused = p;
      feedPointer();
    },
    resize(width, height, dpr) {
      world?.resize(width, height, dpr);
    },
    stop() {
      world?.stop();
      world = null;
      voice?.cancel();
    },
    get session() {
      return sess!;
    },
    get won() {
      return isWon;
    },
    get world() {
      return world;
    },
  };
}
