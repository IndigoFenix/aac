// games/goal-tree-player/src/GoalTreePlayer3D.tsx
//
// The goal-tree quest player rendered THROUGH the world engine in 3D. It drives
// the EXACT SAME per-frame loop as the social world — `runWorldHost` (shared/
// world-engine/world-host) — so physics, camera, gaze, and dialogue bubbles are
// one implementation whether a world is single-player or multiplayer. The quest
// is layered on via two host seams:
//   • a wall MoveConstraint (makeWallConstraint) the engine applies to movement,
//   • an onFrame hook that runs the quest's proximity detection (detectSpace3D)
//     and feeds the resulting SpaceInput to the goal-tree runtime.
// The quest furniture (rooms/figures/items/demonstrations) rides a SceneOverlay
// on the 3D view. To go multiplayer later, this same host takes an optional `net`.
//
// Mounted via main.tsx when the URL carries ?render=3d.

import { useEffect, useRef, useState } from "react";
import { onPlatformMessage, sendToParent } from "@shared/games-bridge";
import type { EntityDef, GoalNode, GoalTreeGame } from "@shared/goal-tree/types";
import { certifyGoalTreeGame } from "@shared/goal-tree/index";
import { buildLogicalWorld, type LogicalWorld } from "@shared/goal-tree/logical-world";
import { walkGoalTree } from "@shared/goal-tree/walk";
import { projectGameLayout } from "@shared/goal-tree/projector2d";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeContext,
  type RuntimeResult,
  type RuntimeState,
} from "@shared/goal-tree/runtime";
import type { NarrationKind, ObjectiveSummary, SpaceInput } from "@shared/goal-tree/space";
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
} from "@shared/goal-tree/space3d";
import * as THREE from "three";
import {
  createWorld3DView,
  defaultAvatarModelFactory,
  type AvatarModelFactory,
} from "@shared/world-engine/render3d";
import { createGlyphImageSource } from "@shared/world-engine/glyph-images";
import { createDwellTracker, type DwellTracker } from "@shared/world-engine/dwell";
import { playerImageResolver } from "./glyph-resolver";
import { runWorldHost, type WorldHost } from "@shared/world-engine/world-host";
import type { NpcErrand } from "@shared/world-engine/npc-controller";
import {
  applyTransform,
  claimItem,
  concludeTransfer,
  creatureWorldFromGame,
  notePlacement,
  openNeeds,
  pendingTransfers,
  planVillageBuildings,
  PLAYER_CREATURE_ID,
  projectDialogue,
  seeItem,
  selectAct,
  STATE_TAGS,
  type VillagePlan,
  type ConversationMemo,
  type CreatureNeed,
  type CreatureWorld,
  type DerivedCreatures,
  type DialogueAct,
  type SyntaxLevel,
} from "@shared/symbol-game/index";
import {
  carryObject,
  clearWorldBubble,
  dropObject,
  expandWorldBuildings,
  showWorldBubble,
  unlockDoor,
} from "@shared/world-engine/engine";
import { speakerGender, translateGlyph } from "@shared/symbol-game/lang/index";
import { createNpcVoice, speechEstimateMs, type NpcVoice } from "@shared/world-engine/npc-voice";
import { resolveLine, SAMPLE_NPC_DIALOGUE } from "@shared/world-engine/npc-dialogue";
import { GoalTreeOverlay3D } from "./goaltree-overlay-3d";
import {
  ChoicePanel,
  ObjectivesBar,
  SatchelBar,
  Toast,
  WinOverlay,
  type ActiveChoice,
  type GazeSample,
} from "./components";
import { demoGame } from "./demo-content";

const GAME_ID = "goal-tree-player-3d";
const DEFAULT_DWELL_MS = 650;
const TOAST_MS = 3500;
// Conversation (dwell-to-talk) tuning.
const CONVO_RADIUS = 7;       // approach distance that raises an NPC's greeting bubble
const CONVO_FIG_RADIUS = 2.2; // gaze within this of a poser counts as "on" them
const CONVO_START_MS = 700;   // dwell ON an NPC to begin a conversation
const CONVO_CANCEL_MS = 1000; // dwell on empty ground (away from the NPC) to leave

// Embedded in the AAC (an iframe) → the live AI companion narrates via the
// server TTS, so the game stays silent to avoid double audio. Standalone (the
// free single-player path, incl. the Electron app) → characters speak themselves
// via the browser's speechSynthesis (no server TTS cost).
const EMBEDDED = typeof window !== "undefined" && window.self !== window.top;

// Glyph SENTENCES are spoken as PROPER language via the shared translation
// rulesets (shared/symbol-game/lang): "i_me + want + apple" → "I want an
// apple." / "אני רוצה תפוח." — grammar (agreement, articles, constructions)
// lives per-locale there; meta.locale picks the ruleset (en fallback).

interface Session {
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
  stations: { nodeId: string; kind: string; objectId: string; applies: string; removes: string }[];
  /** The village's buildings (houses raised on the zone rects), or null when
   *  the layout can't be walled — then the invisible wall constraint applies. */
  village: VillagePlan | null;
  /** TEMP: one-shot debug log keys (hand-over diagnostics). */
  dlogged: Set<string>;
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

function makeSession(game: GoalTreeGame): Session {
  const certified = certifyGoalTreeGame(game);
  if (!certified.ok) {
    console.error("goal-tree-player-3d: game failed certification", certified.errors);
  }
  const world = certified.ok ? certified.world : buildLogicalWorld(game);
  const layout = certified.ok ? certified.layout : projectGameLayout(game, world);
  const embedding = embedLayoutInWorld(layout);
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
  const village = planVillageBuildings(game, world, embedding.layout);
  if (village) {
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
    village,
    dlogged: new Set(),
  };
}

/** The item's CURRENT composed glyph: entity glyph minus its baked-in STATE
 *  tags, plus the creature-world's live states ("apple.cold" → "apple.hot"
 *  after the fire station). */
function liveItemGlyph(session: Session, entityId: string): string {
  const base = session.entities.get(entityId)?.glyph ?? entityId;
  const parts = base.split(".");
  const kept = [parts[0]!, ...parts.slice(1).filter((m) => !STATE_TAGS.has(m))];
  const states = session.creatures?.world.items[entityId]?.states ?? [];
  return [...kept, ...states].join(".");
}

/** A need's WANTED composed glyph: the item's base composition plus the
 *  required state ("apple.hot" while the world only holds a cold one). */
function wantGlyphOf(session: Session, need: CreatureNeed): string {
  const base = session.entities.get(need.itemId)?.glyph ?? need.itemId;
  const kept = base.split(".").filter((m: string, i: number) => i === 0 || !STATE_TAGS.has(m));
  return [...kept, ...(need.requiresState ? [need.requiresState] : [])].join(".");
}

export default function GoalTreePlayer3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<Session | null>(null);
  if (!sessionRef.current) sessionRef.current = makeSession(demoGame());
  const hostRef = useRef<WorldHost | null>(null);
  const overlayRef = useRef<GoalTreeOverlay3D | null>(null);
  // Free client-side TTS for in-game characters (standalone only — see EMBEDDED).
  const voiceRef = useRef<NpcVoice | null>(null);

  // HUD state (low-frequency; the GL canvas never re-renders React).
  const [objectives, setObjectives] = useState<ObjectiveSummary[]>([]);
  const [collectHud, setCollectHud] = useState<Record<string, { have: number; need: number }>>({});
  const [satchel, setSatchel] = useState<Record<string, number>>({});
  const [toast, setToastState] = useState<{ text: string; kind: NarrationKind } | null>(null);
  const [choice, setChoice] = useState<ActiveChoice | null>(null);
  const [won, setWon] = useState(false);

  // Loop-visible mirrors.
  const objectivesRef = useRef<ObjectiveSummary[]>([]);
  const choiceRef = useRef<ActiveChoice | null>(null);
  // A live need-based creature conversation (fulfill nodes) — dialogue is a
  // PROJECTION of creature state, re-computed after every act.
  const creatureConvoRef = useRef<{
    nodeId: string;
    level: SyntaxLevel;
    memo: ConversationMemo;
    acts: DialogueAct[];
  } | null>(null);
  const wonRef = useRef(false);
  const pausedRef = useRef(false);
  const dwellMsRef = useRef(DEFAULT_DWELL_MS);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pointer: the last client px (persistent — a still pointer keeps steering),
  // mirrored into the host (canvas-relative) and into gazeRef (client px, for the
  // dwell-driven HUD). The host owns the gaze-intent interpreter + camera.
  const lastClientRef = useRef<{ x: number; y: number } | null>(null);
  const pointerModeRef = useRef<"mouse" | "eyegaze">("mouse");
  const gazeRef = useRef<GazeSample | null>(null);
  // Lenient dwell trackers for the NPC conversation (start on the NPC / leave on
  // empty ground). Same eyegaze-tolerant timer as carry.
  const talkDwell = useRef<DwellTracker>(createDwellTracker({ dwellMs: CONVO_START_MS, tolerance: CONVO_FIG_RADIUS, graceMs: 450 }));
  const leaveDwell = useRef<DwellTracker>(createDwellTracker({ dwellMs: CONVO_CANCEL_MS, tolerance: 2.0, graceMs: 450 }));
  // Conversation dwell progress — fed to the gaze-spark bloom (the selection
  // indicator) via the host's `cursorProgress` dep.
  const convoProgressRef = useRef(0);

  const steering = () => !pausedRef.current && !wonRef.current && choiceRef.current === null;
  // The pointer/gaze stays LIVE during a choice (so dwell-to-cancel works); the
  // avatar is frozen separately by the host (carry / setConversation → aim null).
  const pointerLive = () => !pausedRef.current && !wonRef.current;

  /** Push the current pointer into the host (or clear it when paused/won). */
  function feedPointer() {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const p = lastClientRef.current;
    if (p && pointerLive()) {
      const r = canvas.getBoundingClientRect();
      host.setPointer(p.x - r.left, p.y - r.top);
    } else {
      host.clearPointer();
    }
  }

  function showToast(text: string, kind: NarrationKind) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastState({ text, kind });
    toastTimer.current = setTimeout(() => setToastState(null), TOAST_MS);
  }

  /** Speak a character's line aloud (free browser TTS) in the game's language.
   *  NPC dialogue is VOICED even when embedded — the live AI companion never
   *  reads NPC lines, so there's no double audio. Composed glyph sentences are
   *  normalized into speakable text first. */
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

  function speakNpc(text: string, speakerSymbol?: string) {
    if (!text) return;
    const locale = sessionRef.current?.game.meta.locale;
    // speakerSymbol → grammatical gender, so agreeing languages conjugate for
    // the creature actually talking (a צפרדע says "נותנת", not "נותן").
    const spoken = translateGlyph(text, locale, { speaker: speakerGender(speakerSymbol, locale) });
    voiceRef.current?.speak(spoken, { lang: locale, ...speakerVoiceOpts(speakerSymbol) });
  }

  /** Canned, already-localized lines skip glyph translation. */
  function speakRaw(text: string) {
    if (!text) return;
    voiceRef.current?.speak(text, { lang: sessionRef.current?.game.meta.locale });
  }

  /** The PLAYER's statement for a glyph — same translation, but subject-less
   *  frames read FIRST PERSON ("give + ball" = "I'll give you the ball.", not
   *  the NPC's "Give me the ball."). Student gender isn't wired yet. */
  function playerStatement(glyph: string): string {
    return translateGlyph(glyph, sessionRef.current?.game.meta.locale, { firstPerson: true });
  }

  /** The student pressed a board button: the AAC board voices their statement
   *  in the PARENT frame, so this queue can't sequence it — hold our response
   *  back for the statement's estimated duration. Do NOT cancel here: the
   *  browser's TTS engine queue is shared across frames, so a cancel from this
   *  iframe would kill the parent's just-started statement (the parent's own
   *  speak already cut our NPC line — that part is handled). */
  function yieldToStatement(spokenText: string) {
    voiceRef.current?.pause(speechEstimateMs(spokenText));
  }

  /** An NPC's statement for a glyph — translation + the speaker's agreement. */
  function npcStatement(glyph: string, speakerSymbol?: string): string {
    const locale = sessionRef.current?.game.meta.locale;
    return translateGlyph(glyph, locale, { speaker: speakerGender(speakerSymbol, locale) });
  }

  /** The glyph SYMBOL of a creature's embodied NPC (for speaker agreement). */
  function creatureGlyph(session: Session, creatureId: string | undefined): string | undefined {
    if (!creatureId) return undefined;
    const npcEntityId = session.creatures?.nodeByCreature.get(creatureId)?.npcEntityId;
    return npcEntityId ? session.entities.get(npcEntityId)?.glyph : undefined;
  }

  // ── Need-based creature conversations (fulfill nodes) ──────────────────────

  /** TEMP: one-shot debug logger for the creature physical layer. */
  function dlogOnce(session: Session, key: string, msg: string) {
    if (session.dlogged.has(key)) return;
    session.dlogged.add(key);
    console.log(msg);
  }

  /** Item id → glyph symbol, for the projection's utterance templates. */
  function symbolOf(itemId: string): string {
    const session = sessionRef.current!;
    return session.entities.get(itemId)?.glyph ?? itemId;
  }

  /** The BUILDING an item is in, as its composed house symbol ("home.color_blue")
   *  — held items resolve through their holder's house, loose ones through the
   *  live object position. Undefined off-village / in the plaza / on the player. */
  function placeOfItem(session: Session, itemId: string): string | undefined {
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
    const live = conv ? hostRef.current?.state.objects[conv.objectId] : undefined;
    const pos = live ? { x: live.x, y: live.y } : conv?.pos;
    const zoneId = pos ? zoneAt(session.embedding.layout, pos) : null;
    return zoneId ? village.houseSymbolByZone[zoneId] : undefined;
  }

  /** The full projection options for a creature conversation. */
  function creatureProjectionOpts(session: Session, announce?: "before" | "after" | "never") {
    return {
      symbolOf,
      announce,
      symbolOfCreature: (cid: string) => {
        const npcEntity = session.creatures?.nodeByCreature.get(cid)?.npcEntityId;
        return (npcEntity && session.entities.get(npcEntity)?.glyph) || "there";
      },
      askableWhere: [...session.heardWants],
      // Carry items are offered from the HAND, never from an abstract pack.
      offerFilter: (itemId: string) => playerCarries(session, itemId),
      // Building location clues: "the ball is in the blue house".
      placeOf: (itemId: string) => placeOfItem(session, itemId),
    };
  }

  /** Is this item entity physically IN the player's hands right now? */
  function playerCarries(session: Session, entityId: string): boolean {
    const host = hostRef.current;
    if (!host) return false;
    return [...session.convItems.values()].some(
      (i) => i.entityId === entityId && host.state.objects[i.objectId]?.carriedBy === PLAYER_ID,
    );
  }

  /** (Re)present the projection for the active creature conversation. When the
   *  creature just REACTED (a clue, a refusal, a thank-you), the reaction IS the
   *  spoken line for this turn — re-projecting must not clobber it. */
  function presentCreatureTurn(lineOverride?: string) {
    const session = sessionRef.current!;
    const convo = creatureConvoRef.current;
    const host = hostRef.current;
    if (!convo || !session.creatures || !host) return;
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
    }
    convo.acts = proj.acts;
    const line = lineOverride ?? proj.lineGlyph;
    // The camera/leave-dwell machinery keys on choiceRef — synthesize one.
    choiceRef.current = {
      nodeId: convo.nodeId,
      posedByEntityId: node.npcEntityId,
      prompt: line,
      options: [],
    };
    const npcSym = session.entities.get(node.npcEntityId)?.glyph;
    const at = poserPos(session, convo.nodeId);
    if (at) {
      showWorldBubble(host.state, `char:${node.npcEntityId}`, {
        anchor: { kind: "point", x: at.x, y: at.y },
        // Written caption = the PROPER translation; the glyph image stays the
        // language-invariant symbol sentence.
        text: npcStatement(line, npcSym),
        glyph: line,
        ttl: 6,
      });
    }
    speakNpc(line, npcSym);
    if (EMBEDDED) {
      sendToParent({
        type: "set_board_options",
        prompt: line,
        // label + spokenText carry the translated statement (written caption
        // and the board's voice); `glyph` stays the invariant symbol string.
        options: proj.acts.map((a, i) => ({
          id: `act_${i}`,
          label: playerStatement(a.glyph),
          glyph: a.glyph,
          spokenText: playerStatement(a.glyph),
        })),
      });
    }
    // Standalone dev note: creature conversations render board-side only when
    // embedded; the in-game ChoicePanel is entity-based and stays for choose.
  }

  function closeCreatureConvo() {
    creatureConvoRef.current = null;
    choiceRef.current = null;
    if (EMBEDDED) sendToParent({ type: "clear_board_options" });
    hostRef.current?.setConversation(null);
    talkDwell.current.reset();
    leaveDwell.current.reset();
    feedPointer();
  }

  function openCreatureConvo(nodeId: string) {
    // A fresh conversation: whatever another creature was still saying is stale.
    voiceRef.current?.cancel();
    // Syntax level comes from the game's meta (the sandbox/world knob) — it
    // was silently hardcoded to "b" before, which made every line 2 glyphs.
    creatureConvoRef.current = {
      nodeId,
      level: sessionRef.current?.game.meta.syntax ?? "b",
      memo: {},
      acts: [],
    };
    presentCreatureTurn();
  }

  /** A board press answered the creature conversation. */
  function handleCreatureAct(index: number) {
    const session = sessionRef.current!;
    const convo = creatureConvoRef.current;
    const host = hostRef.current;
    if (!convo || !session.creatures || !host) return;
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
          showWorldBubble(host.state, `char:${node.npcEntityId}`, {
            anchor: { kind: "point", x: at.x, y: at.y },
            text: npcStatement(res.responseGlyph, npcSym),
            glyph: res.responseGlyph,
            ttl: 4,
          });
        }
        speakNpc(res.responseGlyph, npcSym);
      }
      closeCreatureConvo();
    } else if (creatureConvoRef.current) {
      // The reaction (a clue, "yes", a refusal) IS this turn's spoken line.
      presentCreatureTurn(res.responseGlyph);
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
          const h = hostRef.current;
          if (!h || sessionRef.current !== session) return;
          if (creatureConvoRef.current?.nodeId !== nodeId) return; // walked away
          const at = poserPos(session, nodeId);
          if (!at) return;
          showWorldBubble(h.state, `char:${node.npcEntityId}`, {
            anchor: { kind: "point", x: at.x, y: at.y },
            text: npcStatement(followUp, npcSym),
            glyph: followUp,
            ttl: 6,
          });
        }, delay);
      }
    }
  }

  /** The live position of a node's embodied NPC, else its layout figure spot. */
  function poserPos(session: Session, nodeId: string): { x: number; y: number } | null {
    const live = hostRef.current?.state.avatars[`npc_${nodeId}`];
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
  function enqueueNpcErrand(session: Session, npcId: string, errand: NpcErrand) {
    const host = hostRef.current;
    if (!host) return;
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
    const host = hostRef.current;
    if (!host) return undefined;
    return Object.values(host.state.objects).find((o) => o.carriedBy === npcId)?.id;
  }

  /**
   * A dialogue `receive` was granted: the vendor walks to the stock item, picks
   * it up, carries it over, and puts it down within the player's reach — then
   * returns home. Ownership releases at grant time.
   */
  function deliverStock(session: Session, nodeId: string, entityId: string) {
    const host = hostRef.current;
    const stock = [...session.convItems.values()].find(
      (i) => i.kind === "stock" && i.forNodeId === nodeId && i.entityId === entityId && !session.granted.has(i.objectId),
    );
    if (!host || !stock) return;
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
  function handOverItem(session: Session, nodeId: string, entityId: string) {
    const host = hostRef.current;
    if (!host) return;
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
    const session = sessionRef.current!;
    session.rState = result.state;

    for (const command of result.commands) {
      switch (command.type) {
        case "unlock-passage":
          applySpace3DCommand(session.sState, command);
          // The passage's physical ENGINE door(s) unlock too — the barred leaf
          // becomes an ordinary door that swings open on approach.
          for (const doorId of session.village?.doorIdsByPassage[command.passageId] ?? []) {
            if (hostRef.current) unlockDoor(hostRef.current.state, doorId);
          }
          break;
        case "collect-item":
          applySpace3DCommand(session.sState, command);
          break;
        case "present-choice": {
          choiceRef.current = command;
          // The avatar is frozen + the camera faces the poser via setConversation
          // (set by the dwell-to-talk trigger in onFrame); the pointer stays live.
          // The poser asks its question aloud, in a bubble over the character.
          const host = hostRef.current;
          const poserSym = session.entities.get(command.posedByEntityId)?.glyph;
          const fig = session.embedding.layout.figures.find((f) => f.nodeId === command.nodeId);
          if (host && fig) {
            showWorldBubble(host.state, `char:${command.posedByEntityId}`, {
              anchor: { kind: "point", x: fig.pos.x, y: fig.pos.y },
              text: npcStatement(command.prompt, poserSym), // translated caption
              glyph: command.prompt, // render the composed glyph image too
              ttl: 6,
            });
          }
          speakNpc(command.prompt, poserSym);
          // Embedded → answer on the REAL response board (teaches its use): lock
          // its side buttons to the options. Standalone → the in-game panel.
          if (EMBEDDED) {
            sendToParent({
              type: "set_board_options",
              prompt: command.prompt,
              options: command.options.map((o) => {
                const e = session.entities.get(o.entityId);
                // Send the entity's COMPOSED glyph so the board button renders the
                // real symbol the student is learning (fall back to the emoji);
                // label + spokenText carry the translated statement (written
                // caption and the board's voice).
                const said = e?.glyph ? playerStatement(e.glyph) : (e?.spokenLabel ?? e?.label);
                return {
                  id: o.entityId,
                  label: said ?? e?.label ?? o.entityId,
                  glyph: e?.glyph ?? e?.iconRef,
                  spokenText: said,
                };
              }),
            });
          } else {
            setChoice(command);
          }
          break;
        }
        case "dismiss-choice":
          choiceRef.current = null;
          setChoice(null);
          if (EMBEDDED) sendToParent({ type: "clear_board_options" });
          // Leave the conversation: release the camera + resume steering.
          hostRef.current?.setConversation(null);
          talkDwell.current.reset();
          leaveDwell.current.reset();
          feedPointer();
          break;
        case "demonstrate": {
          // Animate the cue props in-world (overlay), and caption the moment with
          // the taught glyph as a real world speech bubble over the stage — the
          // SAME bubble path a character or a remote player would use.
          overlayRef.current?.playDemonstration(command);
          const host = hostRef.current;
          const stage = session.embedding.layout.figures.find((f) => f.nodeId === command.nodeId);
          if (host && stage) {
            const caption = command.contrastGlyph
              ? `${npcStatement(command.targetGlyph)}  ↔  ${npcStatement(command.contrastGlyph)}`
              : npcStatement(command.targetGlyph);
            showWorldBubble(host.state, "demo:caption", {
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
          showToast(event.text, event.kind);
          break;
        case "objectives-changed":
          objectivesRef.current = event.objectives;
          setObjectives(event.objectives);
          break;
        case "item-collected":
          setCollectHud((prev) => ({
            ...prev,
            [event.nodeId]: { have: event.have, need: event.need },
          }));
          break;
        case "goal-completed":
          sendToParent({ type: "score", value: Object.keys(session.rState.completed).length });
          break;
        case "game-won": {
          wonRef.current = true;
          setWon(true);
          feedPointer();
          sendToParent({ type: "player_action", action: "game_won" });
          // The companion celebrates with a canned, language-keyed line over the
          // player — the same bubble + voice path a character uses.
          const host = hostRef.current;
          const line = resolveLine(SAMPLE_NPC_DIALOGUE, "celebrate", session.game.meta.locale);
          if (host && line) {
            showWorldBubble(host.state, "companion", {
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
          showToast(`${icon} …`, "feedback");
          break;
        }
        case "item-acquired": {
          // Into the satchel (a converse prop pickup or an NPC's grant) — the
          // bottom strip mirrors the runtime inventory.
          setSatchel({ ...session.rState.inventory });
          deliverStock(session, event.nodeId, event.entityId);
          const icon = session.entities.get(event.entityId)?.iconRef ?? "❔";
          showToast(`🎒 ${icon}`, "feedback");
          break;
        }
        case "item-given": {
          setSatchel({ ...session.rState.inventory });
          handOverItem(session, event.nodeId, event.entityId);
          const icon = session.entities.get(event.entityId)?.iconRef ?? "❔";
          showToast(`${icon} ➜ 🤝`, "feedback");
          break;
        }
        case "wrong-choice":
          if (!event.feedback) showToast("❌", "feedback");
          break;
        case "zone-entered":
          if (event.hint) showToast(event.hint, "intro");
          break;
        case "demonstration-shown":
          sendToParent({
            type: "player_action",
            action: "demonstration_shown",
            meta: { nodeId: event.nodeId, targetGlyph: event.targetGlyph },
          });
          break;
        case "obstacle-locked":
        case "guard-cleared":
          break;
      }
    }
  }

  function dispatchInput(input: SpaceInput) {
    const session = sessionRef.current!;
    processResult(applyRuntimeInput(session.ctx, session.rState, input));
  }

  /** Complete a creature's fulfill node only when it is fully CONTENT — a
   *  multi-item need fulfills one instance at a time, and the quest gate must
   *  wait for the last one. */
  function fulfillIfContent(creatureId: string) {
    const creature = sessionRef.current?.creatures?.world.creatures[creatureId];
    if (creature && openNeeds(creature).length > 0) return;
    dispatchInput({ type: "fulfill-need", nodeId: creatureId });
  }

  /** (Re)build the world host for a session: 3D view + quest overlay + the wall
   *  constraint + the per-frame quest detection. Same loop as the social world. */
  function buildHost(session: Session) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    hostRef.current?.stop(); // also disposes the previous view
    const overlay = new GoalTreeOverlay3D({
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
    overlayRef.current = overlay;
    // Render composed glyphs in in-world speech bubbles EXACTLY as the response
    // board renders them — same GlyphCompositor + same bundled-icon resolver.
    const glyphSource = createGlyphImageSource({ resolveImage: playerImageResolver });
    const view = createWorld3DView(
      {
        canvas,
        localId: PLAYER_ID,
        faceFor: () => null,
        labelFor: (id) => (id === PLAYER_ID ? "You" : ""),
        glyphFor: glyphSource.glyphFor,
      },
      session.embedding.spec,
      { overlay, modelFactory: makeNpcModelFactory(session.npcIcons) },
    );
    const host = runWorldHost({
      view,
      spec: session.embedding.spec,
      localId: PLAYER_ID,
      spawnIndex: 0,
      hostNpcs: true,
      // Feed the conversation start/cancel dwell into the gaze-spark bloom (it is
      // the selection indicator now — the old dwell ring is gone).
      cursorProgress: () => convoProgressRef.current,
      // With buildings, the ENGINE's structure constraint owns collision (house
      // walls + locked doors seal rooms; the manifold clamp bounds the field) —
      // the whole village ground is walkable. Without them, fall back to the
      // layout's invisible walls.
      ...(session.village
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
          const owner = hostRef.current?.state.avatars[`npc_${ownerNodeId}`];
          const obj = hostRef.current?.state.objects[objectId];
          return !!owner && !!obj ? Math.hypot(owner.x - obj.x, owner.y - obj.y) > 8 : true;
        },
        onPickDenied: (objectId) => {
          const host = hostRef.current;
          const item = session.convItems.get(objectId);
          if (!host || !item) return;
          const obj = host.state.objects[objectId];
          if (obj) {
            showWorldBubble(host.state, `denied:${objectId}`, {
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
          if (host.state.avatars[npcId]) {
            const ownerSym = creatureGlyph(session, ownerNode);
            showWorldBubble(host.state, `mine:${item.forNodeId}`, {
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
        // Keep the dwell-driven HUD buttons live on a still pointer.
        const p = lastClientRef.current;
        if (p) gazeRef.current = { x: p.x, y: p.y, at: performance.now(), mode: pointerModeRef.current };
        // Converse items are PHYSICAL: picking one up registers it in the
        // runtime satchel exactly once — the object stays in hand (carrying it
        // IS having it). Stock was already granted by the dialogue.
        for (const [objId, item] of session.convItems) {
          if (session.absorbed.has(objId)) continue;
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
              showToast("Not that one — bring the matching one!", "feedback");
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
              const events = applyTransform(session.creatures.world, item.entityId, st.applies, st.removes);
              const stObj = state.objects[st.objectId];
              dropObject(state, objId, (stObj?.x ?? obj.x) + 1.6, (stObj?.y ?? obj.y) + 1.4);
              if (!events.length) continue;
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
            const world: CreatureWorld = session.creatures.world;
            const creature = world.creatures[d.nodeId];
            const open = creature?.needs.filter((n: CreatureNeed) => !n.fulfilled && n.placedAt === d.entityId) ?? [];
            for (const need of open) {
              const conv = [...session.convItems.values()].find((i) => i.entityId === need.itemId);
              if (!conv || state.objects[conv.objectId]?.containedIn?.objectId !== d.objectId) continue;
              const events = notePlacement(world, PLAYER_CREATURE_ID, need.itemId, d.entityId);
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
              const wst = world.items[item.entityId];
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
                const h = hostRef.current;
                if (!h) return;
                if (i === 0 && !npcCarrying(npcId)) carryObject(h.state, objectId, npcId);
                if (i === 1 && h.state.objects[objectId]?.carriedBy === npcId) {
                  const o = h.state.objects[objectId]!;
                  dropObject(h.state, objectId, o.x, o.y);
                }
              },
            });
          }
          // ── AUTO-TAKE: an item a creature agreed to hand over, sitting free
          // within arm's reach, becomes CARRIED the moment the player rests
          // their gaze on it — receiving a gift shouldn't need a pick-dwell.
          // Empty hands only (one carried item at a time); the absorb loop
          // above then concludes the transfer like any other take.
          const gzTake = hostRef.current?.getGaze();
          const playerCarries = Object.values(state.objects).some((o) => o.carriedBy === PLAYER_ID);
          if (playerAv && gzTake && !playerCarries) {
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
        const cvHost = hostRef.current;
        const meAv = state.avatars[PLAYER_ID];
        let convoProgress = 0;
        if (cvHost && meAv) {
          const gz = cvHost.getGaze();
          const fix = gz.committedWorld;
          const onFig = (px: number, py: number, r: number) =>
            !!fix && Math.hypot(fix.x - px, fix.y - py) <= r;
          const active = choiceRef.current;
          if (active) {
            // Talking: hold the camera on the poser (LIVE position — the NPC
            // may have walked an errand); dwell on empty ground to leave.
            talkDwell.current.reset();
            const fig = poserPos(session, active.nodeId);
            if (fig) {
              cvHost.setConversation({ x: fig.x, y: fig.y });
              // The leave target is the fixation when it's NOT resting on the poser.
              const g = fix && !onFig(fig.x, fig.y, CONVO_FIG_RADIUS) ? { x: fix.x, y: fix.y } : null;
              const res = leaveDwell.current.step(g, dt * 1000);
              convoProgress = res.progress;
              if (res.fired) {
                if (creatureConvoRef.current) closeCreatureConvo();
                else dispatchInput({ type: "cancel-choice", nodeId: active.nodeId });
              }
            }
          } else {
            // Find the nearest incomplete choose/converse poser within range.
            let nearFig: { nodeId: string; pos: { x: number; y: number } } | null = null;
            let nearD = Infinity;
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
            if (nearFig) {
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
              leaveDwell.current.reset();
              const onN = onFig(nearFig.pos.x, nearFig.pos.y, CONVO_FIG_RADIUS);
              const res = talkDwell.current.step(onN ? { x: nearFig.pos.x, y: nearFig.pos.y } : null, dt * 1000);
              convoProgress = res.progress;
              if (res.fired) {
                clearWorldBubble(cvHost.state, `npc-greet:${nearFig.nodeId}`);
                cvHost.setConversation({ x: nearFig.pos.x, y: nearFig.pos.y });
                if (node?.type === "fulfill") openCreatureConvo(nearFig.nodeId);
                else dispatchInput({ type: "touch-figure", nodeId: nearFig.nodeId });
              }
            } else {
              talkDwell.current.reset();
              leaveDwell.current.reset();
            }
          }
        }
        // The dwell-to-select indicator is the gaze SPARK's bloom now (render3d) —
        // it hovers over the very item being chosen. `convoProgress` reaches the
        // spark via the host's `cursorProgress` dep. (Old 2D dwell ring removed.)
        convoProgressRef.current = convoProgress;

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
    hostRef.current = host;
    dispatchInput({ type: "start" });
    feedPointer();
  }

  function startSession(game: GoalTreeGame) {
    sessionRef.current = makeSession(game);
    wonRef.current = false;
    choiceRef.current = null;
    creatureConvoRef.current = null;
    objectivesRef.current = [];
    setWon(false);
    setChoice(null);
    setCollectHud({});
    setSatchel({});
    setObjectives([]);
    buildHost(sessionRef.current);
  }

  function replay() {
    startSession(sessionRef.current!.game);
  }

  // Bridge wiring (gaze + load/pause/close).
  useEffect(() => {
    const unsubscribe = onPlatformMessage((msg) => {
      switch (msg.type) {
        case "init":
          if (typeof msg.dwellMs === "number" && msg.dwellMs > 0) dwellMsRef.current = msg.dwellMs;
          break;
        case "gaze":
          // Raw pointer only — the host's gaze-intent does the smoothing/fixation.
          if (msg.mode === "off") {
            // The parent streams "off" ~30Hz whenever there is no gaze sample —
            // including when NO dwell provider is mounted at all (e.g. the
            // /symbol-game sandbox). Don't let that heartbeat clobber a live
            // MOUSE pointer: only honor "off" when gaze was actually driving.
            // Otherwise a still mouse (no pointermove) gets cleared 30×/sec and
            // the avatar coasts to a stop.
            if (pointerModeRef.current !== "mouse") {
              lastClientRef.current = null;
              gazeRef.current = null;
              hostRef.current?.clearPointer();
            }
          } else {
            lastClientRef.current = { x: msg.x, y: msg.y };
            pointerModeRef.current = msg.mode === "eyegaze" ? "eyegaze" : "mouse";
            feedPointer();
          }
          break;
        case "load_game": {
          const certified = certifyGoalTreeGame(msg.game);
          if (certified.ok) startSession(certified.game);
          else console.error("goal-tree-player-3d: rejected load_game", certified.errors);
          break;
        }
        case "pause":
          pausedRef.current = true;
          feedPointer();
          break;
        case "resume":
          pausedRef.current = false;
          feedPointer();
          break;
        case "board_option_selected":
          // The student answered on the real AAC board: a creature conversation
          // act, or a locked choose/converse option. The board voices their
          // statement in the parent frame — hold our response until it's done.
          if (creatureConvoRef.current && msg.id.startsWith("act_")) {
            const act = creatureConvoRef.current.acts[Number(msg.id.slice(4))];
            if (act) yieldToStatement(playerStatement(act.glyph));
            handleCreatureAct(Number(msg.id.slice(4)));
          } else if (choiceRef.current) {
            const e = sessionRef.current?.entities.get(msg.id);
            yieldToStatement(e?.glyph ? playerStatement(e.glyph) : (e?.spokenLabel ?? e?.label ?? ""));
            dispatchInput({ type: "select-option", nodeId: choiceRef.current.nodeId, entityId: msg.id });
          }
          break;
        case "request_close":
          sendToParent({ type: "session_end", reason: wonRef.current ? "won" : "quit" });
          break;
        default:
          break;
      }
    });
    sendToParent({ type: "ready", gameId: GAME_ID, version: "0.1.0" });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mouse fallback (standalone dev / clinician mouse). The pointer PERSISTS at its
  // last position — a still mouse keeps steering. Cleared only when it leaves the
  // document or the window blurs.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      lastClientRef.current = { x: e.clientX, y: e.clientY };
      pointerModeRef.current = "mouse";
      feedPointer();
    };
    const clear = () => {
      if (pointerModeRef.current === "mouse") {
        lastClientRef.current = null;
        hostRef.current?.clearPointer();
      }
    };
    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerleave", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", clear);
      window.removeEventListener("blur", clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount the host + keep it sized to the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    voiceRef.current = createNpcVoice(); // NPC dialogue is voiced in-app too
    // Voice inventory, once — answers "why does everyone sound the same?"
    // (distinct speakers need the OS to offer >1 voice for the language).
    const logVoices = () => {
      const vs = window.speechSynthesis?.getVoices() ?? [];
      if (vs.length) {
        console.log(
          `[voice] ${vs.length} system voices:`,
          vs.map((v) => `${v.lang} ${v.name}`).join(" · "),
        );
      }
    };
    logVoices();
    try {
      window.speechSynthesis?.addEventListener("voiceschanged", logVoices, { once: true });
    } catch { /* older engines */ }
    buildHost(sessionRef.current!);
    const ro = new ResizeObserver(() => {
      hostRef.current?.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
    });
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      hostRef.current?.stop();
      hostRef.current = null;
      voiceRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = sessionRef.current!;
  const nodeById: Map<string, GoalNode> = session.ctx.nodeById;

  return (
    <div className="player-root">
      <canvas ref={canvasRef} className="world-canvas" />

      <ObjectivesBar
        objectives={objectives}
        nodeById={nodeById}
        entities={session.entities}
        collectHud={collectHud}
      />

      <SatchelBar satchel={satchel} entities={session.entities} />

      {toast && <Toast text={toast.text} kind={toast.kind} />}

      {choice && (
        <ChoicePanel
          choice={choice}
          entities={session.entities}
          gazeRef={gazeRef}
          dwellMs={dwellMsRef.current}
          onSelect={(entityId) => {
            // Standalone: no AAC board exists, so the game itself voices the
            // player's statement (translated, slightly raised pitch), cutting
            // any NPC line mid-word; the response then queues behind it.
            const e = sessionRef.current?.entities.get(entityId);
            const said = e?.glyph ? playerStatement(e.glyph) : (e?.spokenLabel ?? e?.label ?? "");
            if (said) {
              voiceRef.current?.cancel();
              // voiceIndex 0 + raised pitch = the PLAYER's voice, distinct
              // from every creature (which use index ≥ 1 / pitch ≤ 1.16).
              voiceRef.current?.speak(said, {
                lang: sessionRef.current?.game.meta.locale,
                pitch: 1.35,
                voiceIndex: 0,
              });
            }
            dispatchInput({ type: "select-option", nodeId: choice.nodeId, entityId });
          }}
          onClose={() => dispatchInput({ type: "cancel-choice", nodeId: choice.nodeId })}
        />
      )}

      {won && (
        <WinOverlay
          title={session.game.root.outro ?? session.game.meta.title}
          gazeRef={gazeRef}
          dwellMs={dwellMsRef.current}
          onReplay={replay}
        />
      )}
    </div>
  );
}
