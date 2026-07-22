// shared/world-engine/interaction/quest/quest-host.ts
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
// Import directly:  import { createQuestHost3D } from "@shared/world-engine/interaction/quest/quest-host";

import * as THREE from "three";
import type { EntityDef, FulfillNode, GoalTreeGame } from "../../solver/types.js";
import { certifyGoalTreeGame } from "../../solver/index.js";
import { buildLogicalWorld, type LogicalWorld } from "../../solver/logical-world.js";
import { walkGoalTree } from "../../solver/walk.js";
import { projectGameLayout } from "../../solver/projector2d.js";
import { generateHouse } from "../../place/house.js";
import { embedPuzzle, type PuzzleEmbedding } from "../../place/embed.js";
import {
  applyRuntimeInput,
  createRuntimeContext,
  createRuntimeState,
  type RuntimeContext,
  type RuntimeResult,
  type RuntimeState,
} from "../../solver/runtime.js";
import {
  ERRAND_WALK,
  FOOD_DAY_SEC,
  HOUSEHOLD,
  addStoreConsumption,
  goodBoxAt,
  houseDoorstep,
  storeUnitsLeft,
  workDoorstep,
  type StoreConsumption,
} from "@shared/world-engine/kernel/town/goods.js";
import { FOUNDING_AGE_DAYS, type TownHouse } from "@shared/world-engine/kernel/town/plan.js";
import {
  FURNITURE_ITEMS,
  STATION_PROPERTIES,
  furnitureGlyph,
  furnitureKindOfGlyph,
  type StationKind,
} from "@shared/world-engine/kernel/town/stations.js";
import {
  makePlacementContext,
  placementCandidates,
  placementFeasible,
  zoneAt as placementZoneAt,
  type PlacementFailure,
} from "@shared/world-engine/kernel/town/placement.js";
import { houseFurniture, workFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import {
  constructionStep,
  foundedBuildingDone,
  foundingOptions,
  nextPlacedSerial,
  placeFurniture,
  PROSPERITY_DAILY_CAP,
  type FoundedBuilding,
  type FoundingCandidate,
  type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  missingCosts,
  resolveStructure,
  spendCosts,
  costsMet,
  structureDisplayGlyph,
  type StructureSpec,
} from "@shared/world-engine/kernel/town/structures.js";
import {
  candidateInZone,
  categoriesOfSpec,
  FOUNDING_PROSPERITY_DAILY_CAP,
  foundingGrowthStep,
  resolveZoneCategory,
  slotZoningFn,
  // `zoneAt` names a room lookup in space3d/placement here — alias the charter one.
  zoneAt as charterZoneAt,
  type ZoneCharter,
} from "@shared/world-engine/kernel/town/zoning.js";
import {
  createTransferLedger,
  orderQuantity,
  planTransferSources,
  putStock,
  runDueTransfers,
  stackHead,
  stackUnits,
  takeGoods,
  townEndpointId,
  type StockEndpoint,
  type TransferAgreement,
  type TransferLedger,
  type TransferSource,
} from "@shared/world-engine/kernel/town/transfer.js";
import {
  BARTER_LEG_DAY_FRAC,
  barterQuote,
  barterWillingness,
  defaultTakeGood,
  inboundRouteHealth,
  runDueBarters,
  stockAbstractPartner,
  stubPartnerSignals,
  type BarterLegReport,
  type BarterSignals,
} from "@shared/world-engine/kernel/town/barter.js";
import { numeraireActive } from "@shared/world-engine/kernel/town/money.js";
import { barterRefusalLine, barterTermsLine } from "@shared/world-engine/interaction/dialogue/barter-lines.js";
import type { CompiledEconomy } from "@shared/world-engine/kernel/modules/economy/index.js";
import type { TownWorld } from "@shared/world-engine/kernel/town/town-world.js";
import { willingnessToPlace } from "@shared/world-engine/interaction/behavior/placement-will.js";
import {
  PLACEMENT_OK,
  placementCannotLine,
  placementDoneLine,
  placementVerdictLine,
  placementWontLine,
  zoneRefusalLine,
} from "@shared/world-engine/interaction/dialogue/placement-lines.js";
// HOST-LEVEL verdicts spoken as glyphs (outstanding-bugs-family-mode: a
// direct question must never be answered by a DOM banner alone).
import {
  CANT_HERE,
  WHO_DO_YOU_MEAN,
} from "@shared/world-engine/interaction/dialogue/host-lines.js";
import { noStock, type LeveledGlyphs } from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";
import type { BuildingSpec } from "@shared/world-engine/index.js";
import {
  buildingRoomPlan,
  houseIndexOfBuildingId,
  houseRoomPlan,
  livingRect,
  memberRoomOf,
} from "@shared/world-engine/kernel/town/rooms.js";
import { roadRoute } from "@shared/world-engine/kernel/town/streets.js";
import { IMPORT_ALLOTMENT, RARE_IMPORT_KIND, TRADE_IMPORT_KINDS } from "@shared/world-engine/kernel/town/trade.js";
import {
  abandonSite,
  depositSiteStock,
  foundSite,
  isSiteMaterial,
  noteSiteBuilding,
  siteAbandonRadius,
  siteIsEmpty,
  SITE_STOCK_ID,
  type FoundedSite,
} from "@shared/world-engine/interaction/town/founding.js";
import { buildWilderness, type WildernessContent, type WildernessParams } from "./wilderness.js";
import { createPossession, type Possession } from "./possession.js";
import {
  assignTownJobs,
  attendanceFactor,
  inShiftWindow,
  jobDutyOf,
  noteAbsence,
  rosterOf,
  shopDutyOf,
  type JobAssignment,
  type WorkAttendance,
} from "@shared/world-engine/kernel/town/roster.js";
import {
  mealOffset,
  scheduledHunger,
  MEAL_PERIOD_SEC,
} from "@shared/world-engine/kernel/town/activity.js";
import type {
  ChoiceOptionView,
  NarrationKind,
  ObjectiveSummary,
  SpaceInput,
} from "../../solver/space.js";
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
} from "../../solver/space3d.js";
import type { Layout2D } from "../../solver/layout2d.js";
import {
  createWorld3DView,
  defaultAvatarModelFactory,
  type AvatarModel,
  type AvatarModelFactory,
  type RenderHost,
  type SceneOverlay,
} from "../../render3d.js";
import { PathDebugOverlay3D } from "../../path-debug-3d.js";
import {
  createCreatureAvatarFactory,
  getSpeciesAssets,
} from "../../creatures/creature-model.js";
import {
  outfitPresetFor,
  outfitIndexOf,
  outfitIndexForDress,
  garmentGlyphOfIndex,
  dressPaletteFrom,
  DEFAULT_DRESS_PALETTE,
  type DressPalette,
} from "../../creatures/clothing.js";
import { FRUIT_TREES, SPARK_SPECIES_ID, requireSpecies, speciesBodyRadius } from "../../creatures/species.js";
import { libraryNouns } from "@shared/world-engine/interaction/content/pools.js";
import { buildConcepts } from "@shared/world-engine/interaction/content/concepts.js";
import { propertiesOf } from "@shared/world-engine/interaction/content/properties.js";
import { genderFor } from "@shared/world-engine/interaction/behavior/gender.js";
import { createGlyphImageSource } from "../../glyph-images.js";
import type { ImageResolver } from "@shared/glyph-compositor.js";
import { createDwellTracker } from "../../dwell.js";
import { runWorldHost, type WorldHost } from "../../world-host.js";
import type { WorldView } from "../../world-view.js";
import type { NpcErrand, NpcErrandPoint } from "../../npc-controller.js";
import {
  carryObject,
  clearWorldBubble,
  dropObject,
  expandWorldBuildings,
  placeInContainer,
  routeThroughDoors,
  buildingAt,
  showWorldBubble,
  unlockDoor,
  type AvatarActivity,
  type AvatarActivityKind,
  type WorldState,
} from "../../engine.js";
import { idlePadOf, routeIndoorAware } from "./floor-route.js";
// STAND-POINT PLANNING (stand-points.ts — pure, extracted so tests can pin it):
// where a body stands to use a fixture, same-room-gated so a probe past a
// wall-hugging chest never lands on clear ground OUTSIDE the room (the
// observed "deposit spot behind the house" bug — DEBUG-CREATURE-BEHAVIOR §5).
import {
  nearestClearSpot,
  standClear,
  standPointFor,
} from "./stand-points.js";
import { createNpcVoice, speechEstimateMs, type NpcVoice } from "../../npc-voice.js";
import { resolveLine, SAMPLE_NPC_DIALOGUE } from "../../npc-dialogue.js";
import {
  claimItem,
  concludeTransfer,
  createCreatureWorld,
  giveItem,
  putDownItem,
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
  perceiveFact,
  STATE_AXES,
  STATE_TAGS,
  STAY_DONE_LINE,
  toggleDevice,
  useStation,
  createCreatureGoalState,
  defaultCurfewRules,
  stepCreatureGoals,
  compileGoal,
  compileIntent,
  compliance,
  createTaskPool,
  chooseClaimant,
  VOLUNTEER_COMPLIANCE,
  goalIntentLine,
  goalActivity,
  commandEcho,
  defaultAnnounceCriteria,
  type TaskPool,
  type TaskCandidate,
  type TaskFocus,
  type AnnounceContext,
  type AnnounceCriteria,
  type IntentLineSyms,
  defaultBinder,
  parseSentence,
  type IntentFrame,
  type Ref,
  intentToAct,
  chooseSpeakerAct,
  makePersonality,
  type Personality,
  type CreatureGoalState,
  type GoalPlan,
  type GoalStep,
  type WorldResolver,
  type VillagePlan,
  type ConversationMemo,
  type CreatureNeed,
  type CreatureWorld,
  type DerivedCreatures,
  type DialogueAct,
  type GoingDest,
  type SyntaxLevel,
  DEFAULT_RELATION,
  decideNeed,
  decideNeeds,
  energyTemplate,
  funTemplate,
  hungerTemplate,
  learnProvides,
  nudgeRelation,
  preferredOf,
  provisionTemplate,
  socialTemplate,
  thirstTemplate,
  wasteTemplate,
  hygieneTemplate,
  tidyTemplate,
  unloadTemplate,
  dressTemplate,
  laundryTemplate,
  stowTemplate,
  cookTemplate,
  serveTemplate,
  canGrasp,
  needPressure,
  stressStep,
  STRESS_VISIBLE,
  type Relation,
  type NeedCtx,
  type NeedTarget,
  type NeedTemplate,
  type StationCandidate,
  type StockCandidate,
  type GoalSpec,
  type PlaceRef,
} from "@shared/world-engine/interaction/index.js";
import { planGoal, pursue } from "@shared/world-engine/interaction/behavior/action-planner.js";
import { needPursuitGoals } from "@shared/world-engine/interaction/behavior/need-goals.js";
import {
  objectMotive,
  attentionBonus,
  ramp,
  decayStrength,
  SPARK,
  type AttentionMotive,
  type SparkDraw,
  type SparkFocus,
} from "@shared/world-engine/interaction/behavior/spark-attention.js";
import { speakDirections, speakerGender, translateGlyph, type Gender } from "@shared/world-engine/interaction/lang/index.js";
import { creditDelivery } from "@shared/world-engine/interaction/town/town-quests.js";
import { buildTownPlay, foundedHouseRow, TOWN_PLAY_STRUCTURES, type TownFamilyMember, type TownFamilyPet, type TownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import {
  cohortEndpoint,
  cohortPopulation,
  cohortRatesStep,
  cohortRowOf,
  cohortWalkerCount,
  cohortWalkerSpots,
  DEFAULT_DISTRICT,
  demoteHousehold,
  districtOfPoint,
  moveInStep,
  parseCohortEndpointId,
  planCohortTransition,
  pooledHouseIndices,
  promoteHousehold,
  TRACKED_RESIDENTS_DEFAULT,
  type CohortHouseCandidate,
  type CohortRates,
} from "@shared/world-engine/kernel/town/population.js";
import { cityHudView, type CityHudChip } from "@shared/world-engine/interaction/quest/city-hud.js";
export type { CityHudChip } from "@shared/world-engine/interaction/quest/city-hud.js";
import { familyStateOf, type FamilyHudEntry } from "@shared/world-engine/interaction/quest/family-hud.js";
export type { FamilyHudEntry } from "@shared/world-engine/interaction/quest/family-hud.js";
import type { ClusterHouseCtx } from "@shared/world-engine/interaction/town/town-stage.js";
import { answerPlaceDirections, houseGlyphForColor, type PlaceFact } from "@shared/world-engine/interaction/dialogue/directions.js";
import { STREET_NPCS } from "../../kernel/town/residents.js";
import {
  TOWN_SCOPE,
  creatureScope,
  houseScope,
  isPrivateOwner,
  mayUse,
  ownerCidsOf,
} from "../behavior/ownership.js";
import { GoalTreeOverlay3D } from "@shared/world-engine/interaction/quest/quest-overlay-3d.js";
import { ZoneOverlay3D } from "@shared/world-engine/interaction/quest/zone-overlay-3d.js";
// THE LAW SUBSTRATE (nations P2): scoped prohibitions + the absolute ring.
import {
  absoluteLaws, addLaw, absolutelyForbidden, goalVerb, governingLaw,
  type AreaRef, type AreaTest, type Law,
} from "../behavior/laws.js";
import { resolveWorldCulture, type WorldCultureSpec } from "../../culture.js";
import { facetsOf, headOf, withVariation } from "../../variations.js";
import { LAW_ACCEPTED, tabooRefusalLine } from "../dialogue/law-lines.js";
import { embargoRemarkLine, tributeLine } from "../dialogue/tiding-lines.js";

/** GIRTH-CHECK A SPAWN POINT. Resident/pet/cast spawn coordinates come from the
 *  fixture-BLIND kernel (memberSpot's room padding, the eat-at-`tablePos` point,
 *  a pet's fixed living-room offset) — computed without knowing how much floor
 *  the *constructing species'* furniture actually leaves. A body embodied inside
 *  a solid fixture then relies on the engine's stuck-body failsafe (it can drift
 *  THROUGH walls to escape). So before a body enters the world, nudge its start
 *  off any furniture its OWN girth overlaps, at the mover's radius
 *  (`speciesBodyRadius`) against the LIVE fixtures — the same clearance rule the
 *  router and stand-points plan at. `nearestClearSpot` returns the point
 *  unchanged when it is already standable (open ground, and the default-species
 *  spawns furnished rooms already clear), so this only ever moves a body that
 *  would otherwise embody embedded. Home anchor biases the nudge inward. */
function girthSafeSpawn<
  T extends { x: number; y: number; species?: string; behavior?: { home?: { x: number; y: number } } },
>(host: WorldHost, n: T): T {
  const bodyR = speciesBodyRadius(n.species);
  const raw = { x: n.x, y: n.y };
  const spot = nearestClearSpot(host.state, raw, n.behavior?.home ?? raw, bodyR);
  return spot.x === raw.x && spot.y === raw.y ? n : { ...n, x: spot.x, y: spot.y };
}

// Conversation (dwell-to-talk) tuning.
const CONVO_RADIUS = 7;       // approach distance that raises an NPC's greeting bubble
const CONVO_FIG_RADIUS = 2.2; // gaze within this of a poser counts as "on" them
const CONVO_START_MS = 700;   // dwell ON an NPC to begin a conversation
const CONVO_CANCEL_MS = 1000; // dwell on empty ground (away from the NPC) to leave
const TAP_COOLDOWN_S = 1.0;   // after a device tap-toggle, ignore re-picks this long
// TASK POOL (phase ①a §2) — untargeted orders wait here for a willing taker.
const TASK_FOCUS_RADIUS = 26;    // the issuer's ATTENTION AREA around their effective position
const TASK_CLAIM_INTERVAL_S = 1; // claim/expiry sweep cadence (claims are per-sweep deterministic)
// TRANSFERS (city-expansion ②) — the town builder's-yard crate id (its stack
// map ALIASES deltas.stock, the FoundedSite-crate pattern) and the pocket
// endpoint prefix (a creature's hands as a stock endpoint).
const TOWN_YARD_ID = "town:yard";
const POCKET_EP = "pocket:";
/** Source endpoints a transfer order may draw on per order (fan-out cap). */
const TRANSFER_MAX_SOURCES = 3;
/** The explicit terminal fallback (phase ①a §1) — an utterance no responder
 *  caught: never silence, never a misleading "okay". */
const NOT_UNDERSTOOD_LINE = "i_me + understand.not";
/** A household member's standing toward its GUIDING SPIRIT — real authority
 *  (shared by the placement gate and the task pool's volunteer gate). */
const FAMILY_RELATION: Relation = { affinity: 0.5, trust: 0.8, authority: 0.8 };
// Motive batch (stay-with + escort) tuning.
const STAY_RADIUS = 5;  // "with" distance for the stay-with dwell
const STAY_SECONDS = 8; // company time until "I'm okay, thank you!"
const FOLLOW_GAP = 4;   // escort: follower re-paths when trailing farther than this
// THE STACK-KIND VOCABULARY (kernel/town/goods-kinds.ts — extracted so the
// pure rules are importable without this 3D host): which glyphs a good comes
// in (kindsOf), and the CARRY projection (carryKindsOf — includes treats for
// food) that everything reading a HAND must count through (§4).
import {
  FOOD_KINDS,
  CLOTHING_HEADS,
  TREAT_KINDS,
  kindsOf,
  isKindOf,
  goodKeyOfGlyph,
  stackTotalOf,
  carryKindsOf,
  carryTotalOf,
  splitStock,
  isLargeGlyph,
  inventoryRoom,
  totalStackUnits,
} from "@shared/world-engine/kernel/town/goods-kinds.js";
import {
  needRate,
  restDwellS,
  constructionGameDays,
  REAL_SCALE,
  type WorldScale,
} from "@shared/world-engine/scale.js";

// MOTIVE PACING (household-duties-and-sims-mode.md §3) is a property of the
// WORLD, not the engine: rates derive from the session's WorldScale
// (space-time-compression.md — realism is the default; a town document
// declares its compression in `game.scale`). Relative pacings — tiredness
// over ~1.6 days, loneliness over ~0.8, clothes lasting ~2 — live in
// scale.ts NEED_FILL_DAYS and hold at any day length.
const WASTE_MEAL_BUMP = 0.3; // eating pushes the waste meter this much
const WASTE_DRINK_BUMP = 0.45; // drinking pushes harder
// Ingest glyphs that satisfy THIRST rather than hunger — so "drink the water"
// empties the thirst row (and digests as a drink). Food is everything else.
const DRINK_GLYPHS = new Set(["water", "juice", "milk", "tea", "drink"]);
const FUN_DWELL_S = 7; // seconds playing at the box before the meter clears
const WASH_DWELL_S = 6; // seconds scrubbing in the bath
const PRIVY_DWELL_S = 4; // seconds at the privy
const SIT_DWELL_S = 8; // seconds a commanded "sit" holds the chair
/** A rest-shaped step's dwell time, by motive. Action dwells (play, scrub,
 *  privy, cook) are animation-scale and fixed; SLEEP is the one dwell that is
 *  world physics — the scale's sleep fraction of its day. */
function restDwellFor(tplKey: string, scale: WorldScale): number {
  if (tplKey === "fun") return FUN_DWELL_S;
  if (tplKey === "hygiene") return WASH_DWELL_S;
  if (tplKey === "waste") return PRIVY_DWELL_S;
  if (tplKey === "laundry") return WASH_DWELL_S; // the scrub at the tub
  if (tplKey.startsWith("cook:")) return COOK_DWELL_S; // the pot at the oven
  return restDwellS(scale);
}
/** The bubble a completed rest-shaped step shows (what just happened, glanceable). */
function restDoneEmoji(tplKey: string): string {
  if (tplKey === "fun") return "⚽";
  if (tplKey === "hygiene") return "🫧";
  if (tplKey === "waste") return "🚽";
  return "💤";
}
const EAT_SHOW_S = 2; // seconds the (instant) consume effect SHOWS as eating
/** Seconds a loose prop must sit on the floor before the TIDY chore may sweep
 *  it (a toy mid-game isn't snatched from under the player). */
const TIDY_GRACE_S = 45;
/** House water: the barrel's capacity and its provisioning low-water mark. */
const BARREL_CAP = 6;
const BARREL_REFILL_BELOW = 2;
/** The pet bowl tops out here — one meal waiting, one spare. */
const BOWL_CAP = 2;
/** The table holds this many MEALS waiting (the serve row's cap — also
 *  what the cook's drive keeps topped up, and the table's visible "on"
 *  slot count). */
const TABLE_MEAL_CAP = 2;
/** Seconds at the oven per unit cooked (the process dwell). */
const COOK_DWELL_S = 5;
/** Seconds an idle, un-owned resident may linger AWAY from home (a finished
 *  spoken command left it there) before it walks back on its own. */
const HOME_IDLE_GRACE_S = 10;
/** After a market take yields NOTHING (the abstract shelf emptied during the
 *  walk over), that member doesn't retry the same good for this long — the
 *  decide-time/arrival-time stock race was marching shoppers out and back
 *  empty-handed in an endless loop. */
const SHOP_RETRY_COOLDOWN_S = 90;
/** Conditions the MOTIVE METERS own (mirrored each tick; how-are-you answers
 *  from them). A quest-authored condition outside this set is never touched.
 *  `need_toilet` renders as a NEED phrase ("I need the bathroom") rather than
 *  a copula adjective — core AAC vocabulary, worth the special frame. */
const MOTIVE_CONDITIONS = new Set(["hungry", "thirsty", "tired", "lonely", "bored", "dirty", "need_toilet", "sad", "scruffy"]);
// Ambient NPC↔NPC chatter (idle townsfolk talk among themselves).
const CHAT_INTERVAL = 9;        // seconds between exchange ATTEMPTS
const CHAT_COOLDOWN = 22;       // per-creature quiet time after speaking/replying
const CHAT_PAIR_RADIUS = 6;     // two NPCs must be within this to talk
const CHAT_VISIBLE_RADIUS = 24; // the speaker must be roughly on-screen (near player)
const CHAT_REPLY_MS = 1500;     // stagger before the listener's reply bubble

// Glyph SENTENCES are spoken as PROPER language via the shared translation
// rulesets (shared/symbol-game/lang): "i_me + want + apple" → "I want an
// apple." / "אני רוצה תפוח." — grammar (agreement, articles, constructions)
// lives per-locale there; meta.locale picks the ruleset (en fallback).

/** One live GoalSpec being driven for one body — see `QuestSession.pursuits`.
 *  `source` names who set the goal; everything below it is source-blind except
 *  `tplKey` — the need template a `source: "need"` pursuit serves (its meter is
 *  cleared when the goal completes; a command carries none). */
export interface Pursuit {
  source: "command" | "need";
  goal: GoalSpec;
  glyph: string;
  tplKey?: string;
  acts?: number;
  stand?: Map<string, { x: number; y: number }>;
}

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
  /** Deterministic goal/rule state (society-rules.md): standing rules + a day/night
   *  clock. Riverside seeds a default "when night, go home" curfew per creature.
   *  Null when there are no creatures. */
  goals: CreatureGoalState | null;
  /** Per-creature staging: where it stands (home) and stows items (stockpile). */
  staging: Map<string, { home: { x: number; y: number }; stockpile: { x: number; y: number } }>;
  /** Per-NPC errand QUEUE — one task at a time (a creature carries one item). */
  npcTasks: Map<string, NpcErrand[]>;
  /** A goal-driven creature's stated destination while its errands run — recorded at
   *  plan issue, read by "where are you going?" (only while `npcTasks` is non-empty). */
  npcGoing: Map<string, GoingDest>;
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
  /** PARTY members — creatures recruited to follow the player and OBEY spoken
   *  commands. Their own need-schedule is suspended while enlisted, so a command
   *  wins (unlike a busy townsperson). Joined via "follow me", left via "stop". */
  party: Set<string>;
  /** INVENTORY as fungible STACKS (feedback_items_stack_one_container): items merge by
   *  SIGNATURE = their composed glyph ("food", "apple.hot"). `pocket` = the player's
   *  inventory as glyph → count (NOT distinct instances); `selectedPocketGlyph` = the
   *  armed stack; `smallProps` = world objectId → the LOOSE concrete prop on the ground
   *  ({instance id, glyph}) — the only place a small item is a concrete instance, so it
   *  can be carried/owned; picking it up MERGES it into the pocket count and drops the
   *  instance. A fresh instance is MATERIALIZED from a glyph only when a stack leaves
   *  storage into the world/dialogue (drop / put-visible / present). */
  pocket: Record<string, number>;
  selectedPocketGlyph: string | null;
  /** `at` = townClock when the prop hit the floor — the TIDY chore only sweeps
   *  props older than TIDY_GRACE_S (a toy mid-game isn't snatched). */
  smallProps: Map<string, { entityId: string; glyph: string; at?: number }>;
  /** CONTAINERS — ONE abstraction (feedback_items_stack_one_container): any object with
   *  `contains` slots is an openable container. `containers` maps its objectId → the
   *  placement relation ("in" = hidden inside; "on" = renders VISIBLY, e.g. a table).
   *  `containerStock` is each container's contents as a glyph→count STACK MAP (a chest's
   *  fixed goods, or whatever's been put in a cupboard/table); a MARKET store's stock is
   *  computed live from the economy instead (see `marketStore`). A building's inventory
   *  is just the AGGREGATE of its containers' stacks — no separate structure.
   *  `containerOwner` holds each container's OWNER SCOPE (ownership.ts —
   *  `house:<hi>` communal furniture, `creature:<cid>` a member's private box,
   *  `town` the well; legacy vendor stores keep their vendor node id). The
   *  walkers only LIST containers they may use; the social stop-gate refuses
   *  takes of private property while an owner is nearby to object. */
  containers: Map<string, "in" | "on">;
  containerStock: Map<string, Record<string, number>>;
  containerOwner: Map<string, string | null>;
  /** Containers PINNED open by an explicit "open the chest" command — they stay
   *  open with nobody near (the auto-close sweep skips them), until "shut". An
   *  access-opened lid (a creature reaching in) is NOT pinned: it shuts when the
   *  taker leaves. */
  containerPinned: Set<string>;
  /** MARKET STORES: a store-container objectId → the good KEY it sells. Its stock is
   *  DYNAMIC — computed from the time-pure shelf (`stockOf`) minus `marketConsumed` (the
   *  player's own draw this day), so taking DEPLETES the store and it restocks at dawn.
   *  (Uses `containerStock` for nothing — its stack is derived, not stored.) */
  marketStore: Map<string, string>;
  /** Per-good player-consumption offset on the market shelf (goodKey → {day, units}),
   *  the discrete-taker layer over the time-pure economy (NPC draw is already in base). */
  marketConsumed: Map<string, StoreConsumption>;
  /** Monotone id counter for freshly-MATERIALIZED item instances (a glyph → a concrete
   *  creature-world item, minted only when a stack enters the world/dialogue). */
  matSerial: number;
  /** AMBIENT NPC↔NPC chatter: seconds accumulated toward the next exchange
   *  attempt, and a per-creature cooldown (seconds remaining) so the same pair
   *  doesn't monopolize the conversation. */
  chatClock: number;
  chatCooldown: Map<string, number>;
  /** LIVE NEEDS (doc §13 promote⇄demote; needs.ts templates). Per resident:
   *  `needMeters` ("cid|tplKey" → level) = live meters (hunger), ticked only while the
   *  household is on show — the schedule's linear drain stands in off-screen;
   *  `needCarried` (cid → glyph→count) = units physically in hand (a fetched ration, a
   *  player GIFT — the deposit rule walks them home);
   *  `needStep` = the active move of the drive→arrive→effect→re-decide loop;
   *  `liveNeedBodies` = bodies the need loop is DRIVING — the clock's errand feed is
   *  suppressed for these (no double-drive), and they keep running even off-show until
   *  the disruption is neutralized (DEMOTE → `reanchor` the goods clock);
   *  `houseShown` = house indices whose interior was on show last frame — edge-detects
   *  LOAD (seed chests from the schedule) and UNLOAD (re-anchor the schedule from the
   *  chests), the §13a.3 handoff. */
  needMeters: Map<string, number>;
  needCarried: Map<string, Record<string, number>>;
  /** HOUSEHOLD ERRAND CLAIMS ("<houseIndex>|<tplKey>" → the member on it).
   *  An `exclusive` need template (restocking) is a job the HOME wants done
   *  once, not once per body: it is OPEN to every member, but the first to act
   *  on it CLAIMS it and the rest stand down (needs.ts `claimed: "other"`), so
   *  an empty pantry sends ONE shopper out instead of the whole family. The
   *  claim is released when the errand completes, when the claimant is evicted
   *  or demoted, or when it stops firing — never held by a body that isn't
   *  walking it. */
  errandClaims: Map<string, string>;
  needStep: Map<
    string,
    {
      tplKey: string;
      kind: string;
      goodKey: string;
      /** An AFFORDANCE row's selector (fun's `play`) — the row has no goodKey,
       *  so the take effect matches stock by what a thing DOES instead. */
      affords?: string;
      objId?: string;
      pos: { x: number; y: number };
      units: number;
      /** CONSUME at a table only: the free CHAIR claimed as the stand point
       *  (§3.3 — meals are eaten from chairs). Other bodies' seat picks read
       *  these claims (freeSeatAt), so two diners never take the same chair. */
      seatId?: string;
      /** REST/PROCESS only: seconds left at the station (counts down on arrival). */
      dwell?: number;
      /** REST/PROCESS display anchoring, resolved ONCE on the first show frame
       *  and held for the episode: the fixture the activity poses onto, or
       *  null = perform in place (a give-up fixes it to null, so a body that
       *  gave up meters away never slides onto the bed). Sticky on purpose —
       *  a per-frame distance gate FLAPPED at its boundary, jerking sleepers
       *  on/off the bed every few frames. */
      anchorId?: string | null;
      /** PROCESS only: the transform's facet edit (drop "dirty" = the wash),
       *  copied off the template's satisfy when the step is issued. */
      proc?: { drop?: string; add?: string };
      /** Stall watch: where the body last made progress + seconds pinned there. A body
       *  grinding on a door frame gets its walk re-issued (door-routed from live pos);
       *  `n` counts the re-issues — the third gives up and ARRIVES IN PLACE (guaranteed
       *  termination: a body must never wedge forever). */
      stall?: { x: number; y: number; t: number; n?: number };
    }
  >;
  liveNeedBodies: Set<string>;
  /** THE UNIFIED PURSUIT REGISTRY (action-planner.ts): a body carrying a
   *  GoalSpec — spoken command today, self-assigned need after S2 — re-derives
   *  the next step from the live world every tick (`stepPursuit`) instead of a
   *  baked one-shot errand. `source` says who set the goal: a need-derived
   *  action is a SELF-ASSIGNED command (the consolidation's north star), and
   *  the only per-source differences are SELECTION and the REACH BUDGET — the
   *  drive loop is one. `glyph` is the source sentence, for the spoken block
   *  reason. `acts` counts discrete actions attempted WITHOUT completing the
   *  goal — a body that can't finish (hands already full, an un-grabbable
   *  target) gives up aloud instead of crouching forever. `stand` COMMITS the
   *  approach spot per target position: an item ON a fixture has no standable
   *  centre, and recomputing the nearest clear spot every tick (it is
   *  body-relative) jitters the target, which thrashes the routed errand so its
   *  furniture doglegs never survive. Committing it — keyed by the target's raw
   *  position, so a putIn's item AND container stay stable, and cleared on a
   *  stall re-route — lets the ONE walk system carry the body around the
   *  furniture. */
  pursuits: Map<string, Pursuit>;
  /** "cid|tplKey" → townClock until which that need stays OFF the pursuit
   *  route (a pursuit for it just failed — the legacy walker takes the motive
   *  meanwhile; see NEED_PURSUIT_RETRY_S). */
  needPursuitCooldown: Map<string, number>;
  /** SOFT CONTROL — the spark's attention field (spark-attention.ts). `sparkDraw`
   *  = attention aimed at a hovered object's MOTIVE; `sparkFocus` = the ENGAGED
   *  creature — the ONE the player has drawn into attention (by conversing,
   *  hovering, or oscillating). ENGAGEMENT is the gate: only the engaged creature
   *  responds, and it responds strongly; nobody is pulled in unselected. Both
   *  decay each frame. Session-layer (spatial + timed), never on CreatureState. */
  sparkDraw: SparkDraw | null;
  sparkFocus: SparkFocus | null;
  /** townClock until which ENGAGEMENT is HELD at full (a conversation or a
   *  deliberate directive) — it doesn't decay while held, so "leave a
   *  conversation, then select an object" still lands. */
  sparkEngageHold: number;
  /** Attention aimed at a CHORE object (a loose thing to tidy, a box to fill).
   *  Stock/mess motives have no meter, so the ENGAGED idle creature is promoted
   *  to the chore (`stepSparkDirect`). Decays like the draw. */
  sparkChore: { chore: "tidy" | "provision"; x: number; y: number; strength: number } | null;
  /** cids the spark PROMOTED to a chore this frame — so the need loop announces
   *  their intent (stock/mess motives don't fire via the meter, so the
   *  meter-based `sparkTriggered` can't flag them). Consumed in stepNeeds. */
  sparkActing: Set<string>;
  /** townClock until which a directed DRAW holds — the gaze doesn't override a
   *  deliberate board press / oscillation target until it lapses. */
  sparkExplicitUntil: number;
  /** OSCILLATION detector — the "look at a creature, then a point, back and
   *  forth" gesture that clearly means "you, go/use there". `cid` = the creature
   *  side; `x`/`y`/`objId` = the point side; `flips` = creature↔point transitions;
   *  `sinceFlip` = seconds since the last one (resets the gesture if too long);
   *  `lastSide` = which side the gaze was on last. */
  sparkOsc: { cid: string; x: number; y: number; objId: string | null; flips: number; sinceFlip: number; lastSide: "cre" | "pt" } | null;
  /** THE ONE WALK STATE — bookkeeping for `walkTo`, the SINGLE "steer this body
   *  to a point" primitive both the needs walker and the command pursuit run.
   *  `tx`/`ty` = the committed destination (the routed errand is re-issued only
   *  when it CHANGES); `ax`/`ay` = where the body last showed motion (progress is
   *  measured by ACTUAL MOVEMENT, so circling furniture — which grows the
   *  straight-line distance to the goal — never false-reads as stuck); `stuckT` =
   *  seconds pinned; `reroutes` = re-route attempts spent before the give-up. A
   *  body walks for exactly one reason at a time, so one entry per cid is safe. */
  walk: Map<string, { tx: number; ty: number; ax: number; ay: number; stuckT: number; reroutes: number }>;
  /** Brief EAT visual (cid → seconds left + the station eaten at): a consume
   *  step applies its effect INSTANTLY, so this countdown is the only record
   *  that a meal is on show. Feeds the display-only body-activity channel
   *  (`syncNeedActivities` → AvatarState.activity). `seatId` = the chair the
   *  meal was eaten from (§3.3) — the show anchors a SIT on it instead of the
   *  standing eat. */
  needEatShow: Map<string, { t: number; objId?: string; seatId?: string }>;
  /** Consecutive NO-OP deposits ("cid|tplKey" → count): an arrived deposit that
   *  transferred nothing (§4 symptom B — the hand's stacks matched none of the
   *  step's kinds). The third strike banks the hands abstractly (the eviction
   *  completion) instead of walking the same futile leg forever. */
  needDepositFail: Map<string, number>;
  /** Brief commanded-pose visual ("you sit" — the sit rig): cid → seconds left
   *  + the chair. Same display-only channel as needEatShow. */
  needPoseShow: Map<string, { t: number; kind: AvatarActivityKind; objId?: string }>;
  /** ACTION HOLD — a body performing a DISCRETE action (pick / place / give /
   *  eat / open / take / deposit) crouches in place for a short beat and the
   *  effect lands at the CROUCH MIDPOINT, never while walking. cid → the pending
   *  effect + timer. While a body holds one, BOTH loops (command pursuit, needs
   *  walker) leave it alone — it is busy. This is what ties every animation to
   *  its action (concept-parser.md §10.2). `apply` is idempotent-guarded by
   *  `applied`; `label` is for the debug readout. */
  actionHold: Map<string, { t: number; dur: number; applied: boolean; apply: () => void; label: string }>;
  /** SURFACED unmet wants (the walker decided BLOCKED): cid → what it wants and
   *  where it would take it ("at" = the satisfy's station kinds). The visible
   *  half of ADOPTION — a housemate with a warm relation (or a spoken "help")
   *  reads this and derives an on-behalf supply row. Cleared the frame the need
   *  stops firing or becomes self-serviceable. */
  blockedNeeds: Map<string, { tplKey: string; goodKey: string; at: readonly string[]; priority: number }>;
  /** Spoken "help X" orders: helper cid → wanter cid. Forces adoption of the
   *  wanter's surfaced need at command priority (bypasses the relation gate,
   *  like all dollhouse obedience). Cleared when the want clears. */
  helpOrders: Map<string, string>;
  /** DERIVED STRESS (creature-behavior-brainstorming.md: the core psychological
   *  meter — mood falls out of needs): cid → 0..1, integrated while needs stay
   *  fired/blocked, decaying while content. Display + dialogue only; behavior
   *  consequences (leaving) are a later slice. */
  stress: Map<string, number>;
  /** WORN garment per body (cid → the clean garment kind on its back + a
   *  change counter that rotates the visible preset so every change SHOWS).
   *  The dress meter is this garment's dirt; the equip effect swaps it out as
   *  a `<kind>.dirty` unit in hand — the laundry chain's first link. */
  worn: Map<string, { glyph: string; n: number }>;
  /** The town's ACTIVE dress (creatures/clothing.ts) — the garment heads +
   *  colour palette residents wear, stores stock and bakes warm. Set at boot
   *  from `game.culture.dress`, else the curated default. A per-session subset
   *  of the garment vocabulary, so a town reads as its own culture. */
  dress: DressPalette;
  /** VISUAL carried prop per needs-walking body (cid → the one prop riding
   *  its hands). Pure display, reconciled from `needCarried` every tick
   *  (`syncNeedCarryProps`) — the stack map stays the only truth. Registered
   *  in neither smallProps nor the creature world, so no fetch/tidy/dialogue
   *  rule can ever mistake it for a real loose instance. */
  needProps: Map<string, { objId: string; glyph: string }>;
  houseShown: Set<number>;
  /** DOLLHOUSE mode (household-duties-and-sims-mode.md §3): the focused house
   *  index, or null. Its interior stays revealed, its members run the full
   *  Sims-mode motive set (energy/social on top of hunger), and spoken commands
   *  drive the looked-at member directly — all commands obeyed (the compliance
   *  gate stays in the code path for other scopes). */
  dollhouse: number | null;
  /** The world's space-time compression (space-time-compression.md): paces the
   *  live need meters, the sleep dwell, and construction. REALISM unless the
   *  document's `game.scale` declared otherwise (town demos declare the
   *  street-clock DOLLHOUSE profile explicitly). */
  scale: WorldScale;
  /** THE LAWS in force (nations P2, behavior/laws.ts): the world spec's
   *  universal absolute ring (game.culture — parental controls,
   *  unrepealable) plus player-spoken prohibitions ("no + fight").
   *  Commands are gated at speak(); NPC candidates through the selectGoal
   *  veto. Session-lived; town-scope persistence rides later arcs. */
  laws: Law[];
  /** The ADDRESSED family member (a tapped HUD chip — a stable eyegaze target):
   *  spoken commands go here first, before gaze/conversation/nearest. Null =
   *  no explicit address. */
  addressedFamily: string | null;
  /** Last pushed family-HUD signature (diff gate for the presenter channel). */
  familyHudSig: string;
  /** Last pushed Speak-menu nouns signature (same diff-gate pattern). */
  nounsSig: string;
  /** Seconds an idle, un-owned resident has lingered with nothing to do —
   *  past HOME_IDLE_GRACE_S it walks home (a finished command parked it). */
  idleAway: Map<string, number>;
  /** "cid|goodKey" → townClock time until which that member won't retry the
   *  MARKET for that good (a take that arrived to an empty shelf set it). */
  shopCooldown: Map<string, number>;
  /** DIAGNOSTIC: which system last issued each body's errand ("clock" feed /
   *  "needs:<tpl>" / "walk-home" / "command" / "follow") — the [doll]
   *  heartbeat prints it so a playtest can name the driver, not guess. */
  lastDrive: Map<string, string>;
  /** Directed relations ("observer|subject" → Relation), warmed by exchanges and
   *  gifts; DEFAULT_RELATION when absent. Feeds the dialogue's relational gates. */
  relations: Map<string, Relation>;
  /** JOBS→ECONOMY (roster.ts attendance): per-work absence tallies — workers
   *  recruited/commanded/live-driven during their shift. Yesterday's absence at
   *  a good's PRODUCER works thins today's dawn shelf. */
  workAbsence: Map<number, WorkAttendance>;
  /** PRODUCER piles — the "the farm made this" box at each producer work's
   *  gate: objectId → its good + work index. Stock is DYNAMIC (goods.ts
   *  `produceAt` × attendance − the player's consumed offset below). */
  produceBox: Map<string, { key: string; work: number }>;
  produceConsumed: Map<string, StoreConsumption>;
  /** INTERCITY TRADE depot (kernel/town/trade.ts): player takes from the
   *  import crate, keyed to the caravan's VISIT bucket (the crate refreshes
   *  when a new caravan lands), and thefts from the export pile. */
  tradeImportTaken: { day: number; taken: Record<string, number> } | null;
  tradeExportConsumed: StoreConsumption | null;
  /** TEMP: one-shot debug log keys (hand-over diagnostics). */
  dlogged: Set<string>;
  /** WILDERNESS session (founding flow): the deterministic resource/creature
   *  scatter laid over the open ground, or null. */
  wilderness: WildernessContent | null;
  /** The ONE site a wilderness session may found (a spoken "build"), or null.
   *  Its `stock` object IS the site stockpile container's stack map (aliased
   *  into `containerStock`), so ordinary container puts/takes keep it true. */
  foundedSite: FoundedSite | null;
  /** UNTARGETED-ORDER TASK POOL (phase ①a §2): serializable tasks + claims —
   *  an owned mutation layer (TownDeltas pattern). Stepped by stepTaskPool. */
  taskPool: TaskPool;
  /** Monotonic pool clock (seconds) — advances every frame in EVERY session
   *  (townClock only runs on town sessions), so expiry works in the wild too. */
  taskClock: number;
  /** BUILD ORDERS (①b): pooled build task id → the FoundedBuilding ordinal it
   *  committed — task "done" keys off REAL construction state, not errand
   *  queues. */
  buildTaskOrds: Map<string, number>;
  /** TRANSFER AGREEMENTS (city-expansion ②): the serializable ledger of
   *  endpoint→endpoint stock moves (kernel/town/transfer.ts) — one-shot
   *  creature hauls and standing scheduled legs. ALIASES the town's
   *  `deltas.transfers` when a town exists (P0: standing routes serialize
   *  with the deltas and survive reload); wilderness sessions own a
   *  session-lived ledger until their site becomes a town. */
  transfers: TransferLedger;
  /** INTERCITY BARTER (⑤): an ABSTRACT partner's synthetic shelf, by partner
   *  key — the stack map `town:<key>` endpoints alias when the partner isn't
   *  a real sim (a cluster neighbor's REAL yard is used instead). Topped up
   *  deterministically before each barter sweep (the stub's one mint, at the
   *  boundary). Aliases `deltas.partnerStock` when a town exists (P0). */
  partnerStock: Record<string, Record<string, number>>;
  /** Barter caravan render serial (deterministic ephemeral body ids). */
  caravanSerial: number;
  /** Creatures the spirit has RIDDEN this session (possession) — the family
   *  bond that lets them volunteer for pooled tasks at a fresh site where
   *  personal compliance would say stranger. */
  bondedCreatures: Set<string>;
  /** Diff signature of the contextual BUILDABLE board options last pushed. */
  civicSig: string;
  /** POOLED houses (④ cohorts) — the deltas.cohorts-derived cache: these
   *  households live as district statistics, and the resident model
   *  streams no bodies for them. Kept in step by demote/promote. */
  pooledHouses: Set<number>;
  /** Diff signature of the CITY HUD chips last pushed. */
  citySig: string;
  /** Where the formless SPIRIT hovers (a ladder boot feeds it) — the player
   *  position for distance rules while nobody is possessed. Null = use the
   *  walker body. */
  spiritPos: { x: number; y: number } | null;
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

/** One STACK in the player's inventory strip — items are fungible, merged by SIGNATURE
 *  (the composed glyph), so an entry is a glyph + how many are held, not a distinct
 *  instance (feedback_items_stack_one_container). */
export interface PocketEntry {
  /** The stack SIGNATURE = its composable glyph — also the key the host acts on. */
  glyph: string;
  /** How many are held (shown as a count badge; ≥ 1). */
  count: number;
  /** Short display label. */
  label: string;
  /** The armed stack (drop / put-in-container target; presented when in conversation). */
  selected: boolean;
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
  /** The player's INVENTORY of small items (instances) — the interactive bottom
   *  strip. Each entry is a pocketed creature-world item: its composable glyph, a
   *  short label, and whether it's the selected one (armed for drop / put / present). */
  pocket?(items: PocketEntry[]): void;
  won(): void;
  /** Completed-goal count changed (the embedded player reports it as score). */
  score?(value: number): void;
  /** Gameplay beats a platform may want to relay (e.g. "demonstration_shown"). */
  action?(action: string, meta?: Record<string, unknown>): void;
  /** The player's speakable nouns for the sentence builder — the known-by-
   *  default library + learned things. `symbol` is the composable glyph,
   *  `label` a short display name; `kind`/`affords` carry each noun's world
   *  semantics (concepts.ts) so the builder's SURFACER (surface-next.ts) can
   *  rank meaningful continuations. */
  nouns?(list: { symbol: string; label: string; kind?: "place" | "item" | "creature" | "unknown"; affords?: string[]; properties?: string[] }[]): void;
  /** DOLLHOUSE family HUD (family-hud.ts): one emoji-state chip per household
   *  member, re-pushed whenever a state changes. Chips double as the ADDRESS
   *  targets for spoken commands (`selectFamilyMember`). Never called outside
   *  dollhouse mode. */
  family?(members: FamilyHudEntry[]): void;
  /** CITY HUD (city-hud.ts, ④ cohorts): per-district chips + the city-total
   *  row, pushed once the town outgrows the tracked cap (diff-gated).
   *  Empty = hidden — a village under the cap never sees it. */
  city?(chips: CityHudChip[]): void;
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
  /** IRREGULAR GROUND (engine GroundSampler): terrain height at a sim (x, y).
   *  The sim stays plan-view 2D; bodies/buildings/roads/camera are PLACED on
   *  it (render3d). A planet host passes its terrain sampler so the town
   *  stands on real ground. Omit = flat (byte-identical to before). */
  groundAt?: (x: number, y: number) => number;
  /** WATER (engine WaterSampler): impassable to walkers and NPCs (the
   *  engine's terrain gate). A planet host passes sea = raw surface height
   *  below the waterline. Omit = dry. */
  waterAt?: (x: number, y: number) => boolean;
  /** SEAMLESS WALK↔FLY (host-embed): render the whole living town INTO the
   *  space-flight scene under a city anchor instead of owning the canvas. When
   *  set, the 3D view shares the flight camera + scene (see RenderHost), the
   *  town's internal rAF loop is NOT started (drive it via QuestHost3D.step), and
   *  the coordinator hands the camera between walking (town) and flying (flight).
   *  Omit = standalone canvas (byte-identical to before). */
  host?: RenderHost;
  /** POSSESSION (spirit ↔ avatar): fired AFTER the host executes a swap —
   *  `creatureId` = the spirit entered that creature's body (the host is now an
   *  ordinary walker; take the camera back with setExternalCamera(false));
   *  null = dismissed back to the formless spirit (return the camera to the
   *  ladder). Boots own the camera choreography; the host owns the body. */
  onPossession?: (creatureId: string | null) => void;
  /** FOUNDING: a spoken "build" in the wilderness created a new empty site —
   *  the boot re-centres its spirit view on it. `stock` is a snapshot of the
   *  materials deposited at founding; `seed` is the site's deterministic
   *  settlement seed (a planet boot derives the site's registry key from it —
   *  nations P0 planet-scale founding). */
  onSiteFounded?: (site: { key: string; seed: number; at: { x: number; y: number }; stock: Record<string, number> }) => void;
  /** ABANDONMENT: the player left the site while it was still EMPTY (see
   *  founding.ts siteIsEmpty) — it was cleared, its materials spilled. */
  onSiteAbandoned?: (key: string) => void;
  /** INTENT ANNOUNCEMENTS (phase ①a §3): the ONE predicate deciding whether a
   *  creature states what it is about to do before doing it. Omit for the
   *  conservative default (announce when claiming a pooled task). */
  announceCriteria?: AnnounceCriteria;
  /** INTERCITY BARTER partners (⑤) the BOOT knows about — nearby settlements
   *  a founded site / a town can trade with, beyond what the session's own
   *  stage carries (cluster neighbors and the bound caravan line register
   *  themselves). Stats-stub partners: scarcity reads the closed-form proxy.
   *  Omit = the stage's partners only (a founded site still gets one
   *  abstract "away" partner, so found → grow → trade works everywhere). */
  tradePartners?: () => Array<{ key: string; at: { x: number; y: number } }>;
}

export interface QuestHost3D {
  /** (Re)build the whole session and world for a game. `wilderness` lays the
   *  deterministic resource/creature scatter (wilderness.ts) over the ground —
   *  the founding flow's stage. */
  start(
    game: GoalTreeGame,
    town?: TownPlay | null,
    opts?: {
      spirit?: boolean; dollhouse?: number; wilderness?: WildernessParams;
      scale?: WorldScale;
      /** The world's cultural law (`game.culture` — nations P2): its
       *  absolutes found the session's unrepealable law ring. */
      culture?: WorldCultureSpec | null;
    },
  ): void;
  /** Rebuild the CURRENT session from scratch (deterministic). */
  replay(): void;
  /** Press a board option (a `QuestBoardOption.id`). `spokenExternally` =
   *  another surface already voiced the player's statement (the AAC board in
   *  its own frame) — the host holds responses back instead of speaking. */
  select(id: string, opts?: { spokenExternally?: boolean }): void;
  /** Close the active question/conversation without answering. */
  cancelChoice(): void;
  /** Select an inventory STACK by its glyph SIGNATURE. Arms it for drop /
   *  put-in-container (via the gaze), or — when a conversation is open — PRESENTS one
   *  to the listener (an offer). Selecting the already-selected stack clears it. */
  selectPocket(glyph: string): void;
  /** Address a DOLLHOUSE family member by tapping its HUD chip — spoken
   *  commands go to the addressed member first (a stable eyegaze target;
   *  moving bodies are hard to dwell on). Re-selecting clears the address. */
  selectFamilyMember(id: string): void;
  /** Speak a composed AAC SENTENCE to a creature (the one in conversation, else the
   *  nearest) — parsed by the concept parser, compiled to a Rule (installed as a
   *  standing custom) or a one-shot GoalSpec (the creature acts it out now). A
   *  conversational statement/question is surfaced but does not yet drive dialogue.
   *
   *  The sentence is VOICED in the player's own voice first (the same
   *  symbols-to-sentence parser the NPCs speak through — `playerStatement`),
   *  exactly as a board press does in `select`. `spokenExternally` = another
   *  surface already voiced it (the AAC board in its own frame), so the host
   *  yields instead of speaking twice. */
  speak(sentence: string, opts?: { spokenExternally?: boolean }): void;
  /** Feed the pointer/gaze in CLIENT px (the host maps to its canvas). A fed
   *  pointer PERSISTS — a still pointer keeps steering — until cleared. */
  setPointer(clientX: number, clientY: number): void;
  clearPointer(): void;
  setPaused(paused: boolean): void;
  /** What the gaze/pointer currently rests on (avatar/object id), for a debug tool to
   *  link a clicked on-screen object to its entity. Null when resting on nothing. */
  hoveredEntity(): { kind: "avatar" | "object"; id: string } | null;
  /** ONE-SHOT pick at a VIEWPORT (clientX/clientY) point — the entity there, resolved
   *  immediately so a debug tool can click-to-inspect even while PAUSED (the live hover
   *  can't settle at dt=0). Null on empty ground. */
  pickEntityAt(clientX: number, clientY: number): { kind: "avatar" | "object"; id: string } | null;
  resize(width: number, height: number, dpr: number): void;
  stop(): void;
  /** HOST-EMBED (seamless walk↔fly): advance + render ONE frame, driven by the
   *  space-flight composer's loop (created with `host`; its own rAF is not
   *  started). No-op for a standalone host. */
  step(dt: number, now: number): void;
  /** HOST-EMBED: hand the shared camera to (true) or away from (false) the town's
   *  grounded chase rig. The coordinator sets false on take-off (the flight camera
   *  takes over) and true again on landing. No-op for a standalone host. */
  setDriveCamera(on: boolean): void;
  /** HOST-EMBED: reveal a building's interior (spirit/dollhouse cutaway) WITHOUT
   *  taking the camera — a host that owns its own camera (the flight world
   *  orbiting a town) passes the building footprint, or null to clear. */
  setSpiritFocus(frame: { x: number; y: number; w: number; h: number } | null): void;
  /** SPIRIT LADDER: opt the view's OWNER-mode camera writes off — the ladder
   *  owns the shared camera while the host keeps simulating + rendering. */
  setExternalCamera(on: boolean): void;
  /** SPIRIT LADDER (planet law): opt the view's OWN spark off — the host keeps
   *  computing the cursor target (hover snap, select) and reports it via
   *  cursorWorld; the planet's one spark draws it. */
  setExternalCursor(on: boolean): void;
  /** SPIRIT LADDER: reveal building INTERIORS from occupancy/accessibility?
   *  Off on the ground rung — the parked gaze avatar is not an occupant, so
   *  walking the street past a house must not strip its walls. */
  setInteriorReveal(on: boolean): void;
  /** SPIRIT LADDER: the cursor target the view computed on its last render
   *  while the external-cursor opt-out is on — WORLD coords into `out`, null
   *  when there is none (no gaze, opt-out off, or no 3D view yet). */
  cursorWorld(out: THREE.Vector3): { hovering: boolean; select: number } | null;
  /** SPIRIT LADDER: the render camera (null before the session starts). */
  readonly camera: THREE.PerspectiveCamera | null;
  /** DIAGNOSTICS: one-line snapshot — the view's cutaway pass + this
   *  session's mode, pointer, settled gaze and hover (lab status line). */
  debugProbe(): string;
  /** DEBUG PATHS: draw every hosted body's steering as lines — the errand plan
   *  (cyan), the live leg (yellow), the detour-bent aim (red), a wander aim
   *  (grey). Survives a world reload: the next session's overlay adopts the
   *  flag. Off by default; costs a per-NPC capture in the host loop while on. */
  setPathDebug(on: boolean): void;
  pathDebugOn(): boolean;
  /** SPIRIT LADDER: the dollhouse rig pose for `frame` at azimuth `spiritAz`
   *  (WORLD coords; pose only — never writes the camera). */
  dollhousePose(
    frame: { x: number; y: number; w: number; h: number } | null,
    spiritAz: number,
    out: { pos: THREE.Vector3; look: THREE.Vector3; up: THREE.Vector3; fov: number },
  ): void;
  /** HOST-EMBED: hide/show the town's local walker — hidden while airborne (the
   *  flight scene draws the flying body). No-op for a standalone host. */
  setLocalAvatarHidden(hidden: boolean): void;
  /** HOST-EMBED floating origin: re-express the view's eased local caches
   *  (follow centre, smoothed heading, spark) in a moved anchor frame — the
   *  pair of WorldHost.rebase's sim re-expression. No-op before the view exists. */
  rebaseLocal(delta: THREE.Matrix4): void;
  /** GROUND HANDOFF: the player's pocket stacks (glyph → count), copied. */
  pocketSnapshot(): Record<string, number>;
  /** GROUND HANDOFF: replace the pocket with `stacks` (selection cleared) and
   *  repaint the strip — the receiving host's half of a walker transfer. */
  restorePocket(stacks: Record<string, number>): void;
  /** SPIRIT LADDER: where the formless spirit currently hovers (sim coords) —
   *  fed each frame by a ladder boot so distance rules (leaving an empty site)
   *  see the SPIRIT, not the parked walker body. */
  setSpiritPosition(x: number, y: number): void;
  /** The possessed creature id, or null (pure spirit / plain walker). */
  readonly possessed: string | null;
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

/** THE PLAYER'S OWN BODY — there isn't one. The player is a SPARK, and the spark
 *  is its own species (species.ts SPARK_SPECIES_ID), flagged BODILESS: it is not
 *  one of the town's people, it renders as a light, and the creature builder
 *  refuses to materialise it. Asked of the REGISTRY rather than assumed, so that
 *  one flag is what decides — give the spark a body plan and it gets built.
 *
 *  FORMLESS EVEN WHILE RIDING. This used to wear the possessed creature's body
 *  (`base(avatarIdOf(...))`), which made sense only while claiming DESTROYED the
 *  creature. It no longer does: the claimed creature keeps its own body and
 *  renders itself as the NPC it still is, and the spark parks on top of it — so
 *  re-skinning here would stand a SECOND copy of that creature on the same spot. */
function sparkAvatarModel(): AvatarModel {
  return requireSpecies(SPARK_SPECIES_ID).bodiless
    ? emptyAvatarModel()
    : createCreatureAvatarFactory({ speciesFor: () => SPARK_SPECIES_ID, heightM: 1.7 })(PLAYER_ID, true);
}

/** Which animal-person species stands in for a puzzle character's emoji face —
 *  the animal people REPLACE the animal character models. */
const ANIMAL_SPECIES_BY_ICON: Record<string, string> = {
  "🐻": "bear_person", "🧸": "bear_person",
  "🐸": "frog_person",
  "🐶": "dog_person", "🐕": "dog_person", "🐩": "dog_person", "🦮": "dog_person",
  "🐰": "rabbit_person", "🐇": "rabbit_person",
  // Grazing herds (open-country fauna) keep their true quadruped body.
  "🐴": "ungulate", "🐎": "ungulate",
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

/** Stable tiny hash — outfit assignment etc. (same body, same clothes forever). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Resolve a world culture's `dress` to the ACTIVE palette a session runs, kept
 *  clothing-aware here (culture.ts gates SHAPE only): invalid colours/heads are
 *  dropped against the garment vocabulary, and an empty selection falls back to
 *  the curated default. */
function resolveDressPalette(culture?: WorldCultureSpec | null): DressPalette {
  return dressPaletteFrom(culture?.dress?.kinds, culture?.dress?.palette);
}

/** Deal `n` units of a good into a stock map. CLOTHING deals across the town's
 *  ACTIVE dress (head × palette colour) so wardrobes and stores hold only the
 *  culture's colours — the player buys/gets culture-appropriate garments, and
 *  residents change into them. Every other good uses the plain kind split. */
function dealGood(dress: DressPalette, goodKey: string, n: number, salt: number): Record<string, number> {
  if (goodKey !== "clothing") return splitStock(goodKey, n, salt);
  const kinds: string[] = [];
  for (const h of dress.heads) for (const c of dress.colors) kinds.push(`${h}.${c}`);
  if (!kinds.length) return splitStock(goodKey, n, salt); // never empty-deal
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const k = kinds[(salt + i) % kinds.length]!;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function makeTownModelFactory(
  npcIcons: Map<string, string>,
  species: string,
  // DEFINED FAMILY overrides (resident cid → hand-authored member): species
  // and outfit-preset choices from the world document's `entities.creatures`.
  overrides?: Map<string, { species?: string; outfit?: number }>,
  // The town's ACTIVE dress (culture palette) — bounds which outfits residents
  // wear and which bakes warm at boot.
  dress: DressPalette = DEFAULT_DRESS_PALETTE,
): AvatarModelFactory {
  // Warm the shared bakes once so no hitch lands mid-play: the bare species and
  // the ACTIVE-dress wardrobe the town wears (one bake per head × palette colour,
  // shared — bounded by the culture palette, not the whole vocabulary).
  getSpeciesAssets(species);
  for (const head of dress.heads) {
    for (const color of dress.colors) {
      getSpeciesAssets(species, {}, outfitPresetFor(outfitIndexOf(head, color)));
    }
  }
  const people = createCreatureAvatarFactory({
    speciesFor: (id) => overrides?.get(id)?.species ?? species,
    heightM: 1.7,
    // Everyone in town WEARS CLOTHING — the wardrobe good made visible; a stable
    // per-body outfit within the town's palette (a defined member wears its
    // authored index forever; everyone else a culture-appropriate colour).
    outfitFor: (id) => {
      const o = overrides?.get(id)?.outfit;
      return outfitPresetFor(o !== undefined ? o : outfitIndexForDress(fnv1a(id), dress));
    },
  });
  // Town FAUNA + FLORA (the chains' living ends): sheep by the weaver, fruit
  // trees by the farms — separate factories so each stands its natural height.
  const sheep = createCreatureAvatarFactory({ speciesFor: () => "sheep", heightM: 0.95 });
  // Household PETS: family members of a non-person species (world-doc authored;
  // species rides the same overrides map, keyed by pet cid). No outfit.
  const petBody = createCreatureAvatarFactory({
    speciesFor: (id) => overrides?.get(id)?.species ?? "quadruped",
    heightM: 0.75,
  });
  const trees = new Map(
    FRUIT_TREES.map((ft) => [
      ft.fruit as string,
      createCreatureAvatarFactory({ speciesFor: () => ft.species, heightM: 3.4 }),
    ]),
  );
  const puzzle = makePuzzleCharacterFactory(npcIcons);
  return (id, isLocal) => {
    if (id.startsWith("npc_")) return puzzle(id, isLocal);
    if (id.startsWith("sheep_")) return sheep(id, isLocal);
    if (id.startsWith("pet_")) return petBody(id, isLocal);
    if (id.startsWith("tree_")) return (trees.get(id.split("_")[1] ?? "") ?? people)(id, isLocal);
    return people(id, isLocal);
  };
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
    // embedLayoutInWorld TRANSLATED the layout into the manifold (everything
    // shifted by EMBED_MARGIN - min). house.buildings carry the UNSHIFTED room
    // rects, so shift their footprints by the SAME delta — else the walls/roofs
    // (and buildingAt, and the dollhouse camera that frames them) land ~1.5 units
    // off from the spawn, objects, and zones. Doorway offsets are edge-relative,
    // so only the footprint origin moves.
    const shifted = embedding.layout.zones[0];
    const original = layout.zones[0];
    const bdx = shifted && original ? shifted.rect.x - original.rect.x : 0;
    const bdy = shifted && original ? shifted.rect.y - original.rect.y : 0;
    embedding.spec.buildings = house.buildings.map((b) => ({
      ...b,
      footprint: { ...b.footprint, x: b.footprint.x + bdx, y: b.footprint.y + bdy },
    }));
    embedding.spec = expandWorldBuildings(embedding.spec);
  } else if (village) {
    embedding.spec.buildings = village.buildings;
    embedding.spec = expandWorldBuildings(embedding.spec);
  }
  const entities = new Map(game.entities.map((e) => [e.id, e]));
  const { embodiedNodeIds, npcIcons } = planEmbodiedNpcs(game, embedding, entities);
  const derivedCreatures = (() => {
    const derived = creatureWorldFromGame(game);
    return derived.nodeByCreature.size ? derived : null;
  })();
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
    creatures: derivedCreatures,
    goals: derivedCreatures
      ? createCreatureGoalState(defaultCurfewRules(derivedCreatures.nodeByCreature.keys()))
      : null,
    staging: new Map(converse.staging.map((s) => [s.nodeId, { home: s.home, stockpile: s.stockpile }])),
    npcTasks: new Map(),
    npcGoing: new Map(),
    heardWants: new Set(),
    placeDests: converse.dests,
    stations: converse.stations,
    tapCooldown: new Map(),
    village,
    stayDwell: new Map(),
    escorting: new Set(),
    party: new Set(),
    pocket: {},
    selectedPocketGlyph: null,
    smallProps: new Map(),
    containers: new Map(),
    containerStock: new Map(),
    containerPinned: new Set(),
    containerOwner: new Map(),
    marketStore: new Map(),
    marketConsumed: new Map(),
    matSerial: 0,
    chatClock: 0,
    chatCooldown: new Map(),
    needMeters: new Map(),
    needCarried: new Map(),
    errandClaims: new Map(),
    needStep: new Map(),
    liveNeedBodies: new Set(),
    pursuits: new Map(),
    needPursuitCooldown: new Map(),
    sparkDraw: null,
    sparkFocus: null,
    sparkEngageHold: 0,
    sparkChore: null,
    sparkActing: new Set(),
    sparkExplicitUntil: 0,
    sparkOsc: null,
    walk: new Map(),
    needEatShow: new Map(),
    needDepositFail: new Map(),
    needPoseShow: new Map(),
    actionHold: new Map(),
    blockedNeeds: new Map(),
    helpOrders: new Map(),
    stress: new Map(),
    worn: new Map(),
    dress: DEFAULT_DRESS_PALETTE,
    needProps: new Map(),
    houseShown: new Set(),
    dollhouse: null,
    scale: REAL_SCALE,
    addressedFamily: null,
    familyHudSig: "",
    nounsSig: "",
    idleAway: new Map(),
    shopCooldown: new Map(),
    lastDrive: new Map(),
    relations: new Map(),
    workAbsence: new Map(),
    produceBox: new Map(),
    produceConsumed: new Map(),
    tradeImportTaken: null,
    tradeExportConsumed: null,
    dlogged: new Set(),
    wilderness: null,
    foundedSite: null,
    taskPool: createTaskPool(),
    taskClock: 0,
    buildTaskOrds: new Map(),
    // A town session's ledger/shelves ARE the deltas' (serialized with them —
    // standing routes survive reload); townless sessions keep their own.
    transfers: town ? town.deltas.transfers : createTransferLedger(),
    partnerStock: town ? town.deltas.partnerStock : {},
    caravanSerial: 0,
    bondedCreatures: new Set(),
    civicSig: "",
    // Restored pools re-exclude their houses from the resident model at
    // birth — a rebuilt city keeps its tiers (④).
    pooledHouses: new Set(town ? pooledHouseIndices(town.deltas.cohorts) : []),
    citySig: "",
    spiritPos: null,
    laws: [],
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

  // AMBIENT street goods: where to buy each one — its market/farm/weaver SOURCE
  // (`sourceOf`, shared across houses; house 0 is a fine reference). A resident's
  // shopping want (§8) can now be POINTED somewhere: ask "where is food?" of any
  // townsperson and be walked to the market. `buy:good:<key>` keeps a namespace
  // distinct from the cast `buy:<itemId>` facts above.
  const refHouse = houses[0];
  if (refHouse) {
    for (const g of town.stage.goods) {
      const src = g.sourceOf(refHouse);
      session.placeFacts.set(`buy:good:${g.good.key}`, {
        id: `buy:good:${g.good.key}`,
        thingGlyph: g.good.key,
        worldPos: { x: src.x, y: src.y },
      });
    }
  }
  // The RARE import is bought at the TRADE DEPOT — "where is cookie?" gets real
  // directions (the existing close/far phrasing carries the distance for free),
  // plus a `rare` follow-up where the answer is given.
  const tr = town.stage.trade;
  if (tr) {
    session.placeFacts.set(`buy:import:${tr.route.rare.kind}`, {
      id: `buy:import:${tr.route.rare.kind}`,
      thingGlyph: tr.route.rare.kind,
      worldPos: { ...tr.depot },
    });
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
  // A container-stacked ref (`stock:<box>|<glyph>`) IS its glyph.
  if (entityId.startsWith("stock:")) return entityId.split("|")[1] ?? entityId;
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
  // ONE gate for intent announcements (phase ①a §3) — hosts may tune it later;
  // the default announces on pooled-task claims only.
  const announceCriteria = deps.announceCriteria ?? defaultAnnounceCriteria;

  let sess: QuestSession | null = null;
  let world: WorldHost | null = null;
  /** Retained for host-embed control (camera handoff + hiding the local walker
   *  while airborne). The 3D view exposes setDriveCamera / setAvatarHidden. */
  let questView: WorldView | null = null;
  let overlay: GoalTreeOverlay3D | null = null;
  /** DEBUG PATHS: rebuilt per host (it mounts into the view's scene), but the
   *  ON/OFF choice is the LAB's and outlives a world reload — so the flag lives
   *  out here and every new overlay adopts it. */
  let pathDebug: PathDebugOverlay3D | null = null;
  let pathDebugOn = false;
  /** SPIRIT mode (AvatarKind "spirit"): the player is a stationary, formless
   *  first-person presence. No walking — dwell on anything in view to pick it
   *  up / put it down / talk. Set per-session by start({ spirit }). */
  let spirit = false;
  /** What the SPIRIT camera frames: the dollhouse's house rect (world coords),
   *  or null = the renderer's own default (building bounds / manifold). */
  let spiritFrame: { x: number; y: number; w: number; h: number } | null = null;
  /** Dollhouse diagnostic heartbeat accumulator (5s household state log). */
  let dollLogT = 0;

  // ── POSSESSION (spirit ↔ avatar; possession.ts is the guarded state
  //    machine, this host executes the swap). While possessed the session
  //    behaves as a WALKER: the spirit-only affordances (gaze-at-any-distance
  //    talk/containers, distance-free carry, the formless local model) read
  //    spiritNow() so they all flip together.
  const possession: Possession = createPossession({
    isSpirit: () => spirit && sess?.dollhouse === null,
    creatureExists: (cid) =>
      !!sess?.creatures?.world.creatures[cid] && cid !== PLAYER_CREATURE_ID,
    apply: (cid, prev) => applyPossession(cid, prev),
  });
  /** Spirit-mode affordances apply NOW (spirit session and nobody possessed). */
  const spiritNow = () => spirit && possession.creatureId === null;

  /** Execute a possession swap (state already transitioned — see possession.ts):
   *  THE PLAYER IS THE SPARK; THE AVATAR IS JUST A BODY. Claiming points this
   *  spark's steering at the creature's existing body and suspends that body's
   *  own drives — exactly what recruiting a party member does. The creature is
   *  never removed and never re-skinned: it keeps its model, personality,
   *  knowledge and job, and resumes them the moment the spark leaves.
   *
   *  This used to `removeNpc` the body, teleport the player walker into its
   *  place and re-skin it — then, on dismiss, re-add the creature with a
   *  HARDCODED generic `wander`. A baker came back a generic wanderer: its mind
   *  survived (`creatures[cid]` was never touched) but its job did not. */
  function applyPossession(cid: string | null, prev: string | null) {
    const s = sess;
    if (!s || !world) return;
    if (cid) {
      const body = avatarIdOf(cid);
      // Suspend the creature's own drives (the party-recruit suppression set).
      // The LIVE flag is KEPT (§4 — hands empty on every exit) so a creature
      // claimed mid-haul closes its episode cleanly.
      s.npcTasks.delete(body);
      s.needStep.delete(cid);
      s.party.delete(cid);
      world.setNpcErrand(body, null);
      // Drive the creature's OWN body. No teleport: the spark goes to the body,
      // not the body to the spark.
      if (!world.claimBody(body)) return;
      world.setStationary(false);
      if (convo) closeCreatureConvo();
      world.setConversation(null);
    } else if (prev) {
      // Release: the body stands where it is and resumes its own life — its
      // controller was only ever suspended. The spirit hovers where it left.
      const at = world.state.avatars[avatarIdOf(prev)];
      world.claimBody(null);
      if (at) s.spiritPos = { x: at.x, y: at.y };
      // The spark's own body is formless and parked — put it where the spirit
      // resumes, so a later claim/interaction measures distance from there.
      const p = world.state.avatars[PLAYER_ID];
      if (p && at) {
        p.x = at.x;
        p.y = at.y;
        p.vx = 0;
        p.vy = 0;
      }
      world.setStationary(spirit);
      // Resume the creature's need loop from now (it was suspended, not lost).
      s.needStep.delete(prev);
    }
    deps.onPossession?.(cid);
  }

  // The active question (a choose/converse `present-choice`, or one
  // SYNTHESIZED for a creature conversation — the camera/leave-dwell
  // machinery keys on it).
  let choice: { nodeId: string; posedByEntityId: string; prompt: string; options: ChoiceOptionView[] } | null = null;
  // A live need-based creature conversation (fulfill nodes) — dialogue is a
  // PROJECTION of creature state, re-computed after every act.
  let convo: { nodeId: string; level: SyntaxLevel; memo: ConversationMemo; acts: DialogueAct[] } | null = null;
  // An OPEN container's selection popup (bug #5): its object id + the ordered entity
  // ids on show. A press takes one; walking/looking away closes it, like a convo.
  let container: { objId: string; items: string[] } | null = null;
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
  // Drop / put-in-container action dwell for a SELECTED inventory item (separate from
  // the carry pickup-dwell, which the host owns and this must not touch).
  const dropDwell = createDwellTracker({ dwellMs: 650, tolerance: 1.2, graceMs: 300 });
  // OPEN-a-container dwell (bug #5): dwelling on an openable stocked container spills
  // its goods to grab. Separate from carry/drop dwells, and never runs while carrying.
  const openDwell = createDwellTracker({ dwellMs: 700, tolerance: 1.2, graceMs: 300 });
  // SOFT CONTROL Phase 2 — between-two-creatures: a deliberate dwell on the gap
  // between two people prompts them to chat (stepSparkPairChat). Shorter than the
  // 700 ms talk dwell, longer than a passing glance.
  const pairDwell = createDwellTracker({ dwellMs: 450, tolerance: 1.5, graceMs: 300 });
  // Conversation dwell progress — fed to the gaze-spark bloom (the selection
  // indicator) via the host's `cursorProgress` dep.
  let convoProgress = 0;

  const steering = () => !paused && !isWon && choice === null;
  // The pointer/gaze stays LIVE during a choice (so dwell-to-cancel works); the
  // avatar's walk aim is steered separately by the host (carry suspension /
  // setConversation → follow the partner), not by this gaze.
  // The pointer keeps feeding the PICK even while PAUSED (steering is separately gated
  // by steering(), and dt=0 stops motion) — so a debug tool can click-to-inspect a
  // frozen frame. Only a win clears it.
  const pointerLive = () => !isWon;

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

  /** Speaker agreement gender: the creature's NATURAL gender (a stable per-cid
   *  hash — gender.ts) when we know WHO is talking, else the old symbol-derived
   *  grammatical guess (a צפרדע reads feminine). Natural gender wins so a male
   *  frog still says "נותן" and a female resident "נותנת". */
  function npcSpeakerGender(speakerSymbol: string | undefined, speakerCid: string | undefined) {
    if (speakerCid) return genderFor(speakerCid);
    return speakerGender(speakerSymbol, sess?.game.meta.locale);
  }

  /** Speak a character's line aloud (free browser TTS) in the game's language.
   *  Composed glyph sentences are translated into speakable text first;
   *  speakerCid/speakerSymbol → gender, so agreeing languages conjugate for
   *  the creature actually talking. */
  function speakNpc(text: string, speakerSymbol?: string, speakerCid?: string) {
    if (!text) return;
    const locale = sess?.game.meta.locale;
    const spoken = translateGlyph(text, locale, {
      speaker: npcSpeakerGender(speakerSymbol, speakerCid),
      ...(sess ? { names: sessionNames(sess) } : {}),
    });
    voice?.speak(spoken, { lang: locale, ...speakerVoiceOpts(speakerCid ?? speakerSymbol) });
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
    return translateGlyph(glyph, sess?.game.meta.locale, {
      firstPerson: true,
      ...(sess ? { names: sessionNames(sess) } : {}),
    });
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
  function npcStatement(glyph: string, speakerSymbol?: string, speakerCid?: string): string {
    const locale = sess?.game.meta.locale;
    return translateGlyph(glyph, locale, {
      speaker: npcSpeakerGender(speakerSymbol, speakerCid),
      ...(sess ? { names: sessionNames(sess) } : {}),
    });
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
    // `good:<key>` marker ids (a resident's resource-type need) verbalize as the good
    // itself — "have.not food", never the raw marker string.
    return sess!.entities.get(itemId)?.glyph ?? (itemId.startsWith("good:") ? itemId.slice(5) : itemId);
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
        // A NAMED household member answers by NAME ("mara + have + ball").
        const name = nameOfCid(session, cid);
        if (name) return name;
        const npcEntity = session.creatures?.nodeByCreature.get(cid)?.npcEntityId;
        return (npcEntity && session.entities.get(npcEntity)?.glyph) || "there";
      },
      // The household name book — third-party fact questions resolve through it
      // ("where + mara" → her resident cid).
      creatureOf: (symbol: string) => nameBook(session).get(symbol),
      // Roster presence: the duty schedule is household common knowledge.
      presenceOf: (cid: string) => presenceWordOf(session, cid),
      askableWhere: [...session.heardWants],
      // The places the player has heard of that this townsperson can point to.
      askDirections: buildAskDirections(session),
      // Carry items are offered from the HAND, never from an abstract pack.
      offerFilter: (itemId: string) => playerCarries(session, itemId),
      // Building location clues: "the ball is in the blue house".
      placeOf: (itemId: string) => placeOfItem(session, itemId),
      // A resource-type shopping want points to WHERE it's bought (the market): a
      // shopper on an errand KNOWS its source, so "where is food?" answers with
      // directions instead of "I don't know" (bug #2).
      directionsForNeed: (need: CreatureNeed) => {
        const key = need.target?.category;
        const subj = key ? `buy:good:${key}` : undefined;
        return subj && session.placeFacts.has(subj) ? subj : undefined;
      },
      // Where a creature is HEADED right now — a resident's clock/live errand, or any
      // goal-driven creature's queued body step. Powers "where are you going?" (bug #4).
      goingOf: (cid: string) => creatureGoing(session, cid),
      // What a creature is VERIFIABLY doing — the "why are you X-ing?" premise
      // check ("why + you + build" at a walker → "i_me + build.not", not a
      // motive dump).
      doingOf: (cid: string) => creatureDoing(session, cid),
      // The live activity WITH its object ("what is the dog eating?" → "dog +
      // eat + apple") — read off the pursuit/need machinery, same verbs the
      // commands use (goalActivity).
      activityOf: (cid: string) => creatureActivity(session, cid),
      // The WANT gate's temperament input (willingness — a warm creature gifts a liked
      // asker): the same hashed dials the ambient chatter uses.
      personalityOf: (cid: string) => creatureMood(cid),
      // Directed relations, warmed by exchanges and gifts (neutral until then).
      relationOf: (observer: string, subject: string) =>
        session.relations.get(`${observer}|${subject}`) ?? DEFAULT_RELATION,
    };
  }

  /** The household NAME BOOK: spoken word → creature id. Members by NAME; pets
   *  by name AND species word ("dog + eat", "give apple to dog") — first pet
   *  wins a bare species reference. The parser's animacy classifier, the
   *  binder, and the fact questions ("where is Mara?") all resolve through it. */
  function nameBook(session: QuestSession): Map<string, string> {
    const byName = new Map<string, string>();
    const fam = familyOf(session);
    if (fam) {
      fam.members.forEach((m, i) => {
        if (m.name) byName.set(m.name.toLowerCase(), `resident_${fam.house}_${i}`);
      });
      for (const { cid, pet } of petsOf(session)) {
        if (pet.name) byName.set(pet.name.toLowerCase(), cid);
        const sp = (pet.species ?? "quadruped").toLowerCase();
        if (!byName.has(sp)) byName.set(sp, cid);
        if (!byName.has("dog") && (pet.species === undefined || pet.species === "quadruped")) {
          byName.set("dog", cid); // the board's household-animal word
        }
      }
    }
    return byName;
  }

  /** cid → its spoken NAME (reverse book — actual names only, never species
   *  words), so answers say "Mara has it", not "human has it". */
  function nameOfCid(session: QuestSession, cid: string): string | undefined {
    const fam = familyOf(session);
    if (fam) {
      for (let i = 0; i < fam.members.length; i++) {
        const m = fam.members[i]!;
        if (m.name && `resident_${fam.house}_${i}` === cid) return m.name.toLowerCase();
      }
    }
    return petsOf(session).find((p) => p.cid === cid)?.pet.name?.toLowerCase();
  }

  /** The PROPER-NOUN book for the lang layer (SpeakOpts.names): each household
   *  name → its bearer's natural gender (gender.ts) — names never take
   *  articles and agree by their own gender ("מרה רעבה"). */
  function sessionNames(session: QuestSession): ReadonlyMap<string, Gender> {
    const m = new Map<string, Gender>();
    const fam = familyOf(session);
    if (fam) {
      fam.members.forEach((mem, i) => {
        if (mem.name) m.set(mem.name.toLowerCase(), genderFor(`resident_${fam.house}_${i}`));
      });
      for (const { cid, pet } of petsOf(session)) {
        if (pet.name) m.set(pet.name.toLowerCase(), genderFor(cid));
      }
    }
    return m;
  }

  /** ROSTER-seeded presence (household-duties §1 — the duty schedule is common
   *  knowledge): a household body's current place WORD. Idle/at-home residents
   *  and pets read "home"; a worker inside its shift window "work"; a shopper
   *  mid-errand returns undefined (perceived/told facts may still answer). */
  function presenceWordOf(session: QuestSession, cid: string): string | undefined {
    if (cid.startsWith("pet_")) return "home";
    if (!session.town || !cid.startsWith("resident_")) return undefined;
    const going = residentGoing(session, cid);
    if (!going) return "home";
    if (going.kind === "home") return "home";
    if (going.kind === "place") return going.place;
    return undefined;
  }

  /** Warm the DIRECTED relations both ways (an exchange, a gift) — the same book
   *  the dialogue's compliance/generosity gates read. */
  function warmRelations(session: QuestSession, a: string, b: string, delta: Partial<Relation>) {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const key = `${x}|${y}`;
      session.relations.set(key, nudgeRelation(session.relations.get(key) ?? DEFAULT_RELATION, delta));
    }
  }

  /** ANY traveling creature's destination — a resident's clock/live errand first, else
   *  a goal-driven creature with queued body errands ("anyone traveling" answers, not
   *  just shoppers). The label was recorded when its plan was issued (`npcGoing`);
   *  a plan without one is still honestly "going there". Stationary → undefined. */
  function creatureGoing(session: QuestSession, cid: string): GoingDest | undefined {
    const res = residentGoing(session, cid);
    if (res) return res;
    if ((session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0) {
      return session.npcGoing.get(cid) ?? { kind: "place", place: "there" };
    }
    // The BODY's truth beats the pure schedule: a shopper's real walk (door transits,
    // detours) lags the clock, so the phase can already read "home" while the body is
    // still visibly traveling — it IS going somewhere, and the honest answer for a
    // resident is home. (Wander is a behavior, not an errand — idlers stay un-askable.)
    if (world?.npcErrandActive(avatarIdOf(cid))) {
      return cid.startsWith("resident_") ? { kind: "home" } : { kind: "place", place: "there" };
    }
    return undefined;
  }

  /** The activity VERBS a creature is verifiably doing right now — the honest
   *  premise check behind "why are you X-ing?" (ProjectionOpts.doingOf). The
   *  live activity's verb leads; a traveler is also walking (plus getting, en
   *  route to fetch); anything we can't verify returns undefined, so the
   *  listener answers "I don't understand" rather than risking a false denial
   *  (an idle-LOOKING member may be mid-meal on the needs loop — we never
   *  claim to know its full activity set). */
  function creatureDoing(session: QuestSession, cid: string): string[] | undefined {
    const verbs: string[] = [];
    const act = creatureActivity(session, cid);
    if (act) verbs.push(act.verb);
    const going = creatureGoing(session, cid);
    if (going) {
      verbs.push("go", "come", "walk", "run");
      if (going.kind === "fetch") verbs.push("get");
    }
    return verbs.length ? verbs : undefined;
  }

  /** Need-template prefixes → the activity frame their pursuit shows as (the
   *  founding motives speak their own verbs). Checked in order. */
  const TPL_ACTIVITY: readonly [string, { verb: string; object?: string }][] = [
    ["hunger", { verb: "eat" }],
    ["thirst", { verb: "drink" }],
    ["energy", { verb: "sleep" }],
    ["waste", { verb: "go", object: "bathroom" }],
    ["hygiene", { verb: "wash" }],
    ["fun", { verb: "play" }],
    ["social", { verb: "talk" }],
    ["laundry", { verb: "wash", object: "clothing" }],
    ["cook", { verb: "cook", object: "food" }],
    ["clean", { verb: "clean" }],
    ["tidy", { verb: "clean" }],
    ["dress", { verb: "wear" }],
  ];

  /** The live ACTIVITY of a creature, object included — the "what is X
   *  doing/eating?" answer (ProjectionOpts.activityOf) and the introspection
   *  the command echo mirrors. Reads, in order: an active command/spark
   *  pursuit's goal (goalActivity — the same verbs commands use), the needs
   *  walker's current step, then travel. Undefined = can't verify (never a
   *  false denial); null is never claimed here — an idle body may still be
   *  mid-something this host can't see. */
  function creatureActivity(
    session: QuestSession,
    cid: string,
  ): { verb: string; object?: string } | undefined {
    const pursuit = session.pursuits.get(cid);
    if (pursuit) return goalActivity(pursuit.goal, intentLineSyms(session)) ?? undefined;
    const step = session.needStep.get(cid);
    if (step) {
      const head = step.goodKey ? headOf(step.goodKey) : undefined;
      if (step.kind === "take") return { verb: "get", ...(head ? { object: head } : {}) };
      if (step.kind === "deposit") return { verb: "put", ...(head ? { object: head } : {}) };
      const tpl = TPL_ACTIVITY.find(([p]) => step.tplKey.startsWith(p));
      if (tpl) return tpl[1];
    }
    const going = creatureGoing(session, cid);
    if (going) {
      if (going.kind === "fetch") return { verb: "get", object: headOf(going.good) };
      return { verb: "go", object: going.kind === "home" ? "home" : going.place };
    }
    return undefined;
  }

  /** A resident's live DESTINATION from the town goods clock: fetching its good,
   *  heading home, or (provisioned/idle) not going anywhere. Residents only — the
   *  ambient crowd is what walks; cast bodies aren't clock-driven. */
  function residentGoing(session: QuestSession, cid: string): GoingDest | undefined {
    const town = session.town;
    if (!town || !cid.startsWith("resident_")) return undefined;
    const houseIndex = Number(cid.split("_")[1]);
    const member = Number(cid.split("_")[2]);
    const house = residentTownCtx(session, houseIndex)?.house; // neighbor-aware
    if (!house) return undefined;
    // LIVE-driven (needs loop): the destination is whatever the active step is —
    // fetching its good (a take at a chest/store) or carrying things home.
    const step = session.needStep.get(cid);
    if (session.liveNeedBodies.has(cid) && step) {
      return step.kind === "take" ? { kind: "fetch", good: step.goodKey } : { kind: "home" };
    }
    const good = residentShopGoods(session, houseIndex, member);
    if (good) {
      const est = good.errand(house, session.townClock);
      if (est.phase === "to_source" || est.phase === "at_source") return { kind: "fetch", good: good.good.key };
      if (est.phase === "to_home") return { kind: "home" };
    }
    // A WORKER inside its shift window is commuting to work or standing at it —
    // "I go to work" answers the whole window (standing there, it reads as
    // "I'm at work"; the alternative is a dead ask exactly when it's most natural).
    const jd = residentJobDuty(session, houseIndex, member);
    if (jd && inShiftWindow(jd.window, session.townClock, FOOD_DAY_SEC)) {
      return { kind: "place", place: "work" };
    }
    return undefined; // home/idle — not going anywhere
  }

  /** The player GAVE a resident a stack unit (an accepted offer). The physical unit
   *  goes into its CARRIED stack and the creature is PROMOTED to the live need loop
   *  (§13): the deposit rule walks it home to put the gift in the house box (a walking
   *  shopper turns around — no market trip needed), a hungry one eats it first, and on
   *  demote the goods clock RE-ANCHORS so the next scheduled trip reflects the gift.
   *  The old cycle-flag special case (`residentProvisioned`) fell out of this. */
  function giftResidentGood(session: QuestSession, cid: string, glyph: string) {
    if (!cid.startsWith("resident_")) return;
    const carried = session.needCarried.get(cid) ?? {};
    stackAdd(carried, glyph);
    session.needCarried.set(cid, carried);
    session.liveNeedBodies.add(cid);
    session.needStep.delete(cid); // whatever it was doing, re-decide with the gift in hand
    const need = session.creatures?.world.creatures[cid]?.needs.find(
      (n) => n.target?.category === goodKeyOfGlyph(glyph), // a gifted apple satisfies the FOOD want
    );
    if (need) need.fulfilled = true;
    // Kindness is remembered — the receiver warms toward the giver.
    warmRelations(session, cid, PLAYER_CREATURE_ID, { affinity: 0.1, trust: 0.05 });
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
    // is knowledge, so every held item is requestable (it may refuse). The same
    // sight carries each item's visible STATES ("the apple is hot") through the
    // generic fact channel (facts.ts — creature-knowledge.md).
    for (const item of Object.values(session.creatures.world.items)) {
      if (item.ownerId === convo.nodeId) {
        seeItem(session.creatures.world, PLAYER_CREATURE_ID, item.id, {
          kind: "held",
          by: convo.nodeId,
        });
        for (const s of item.states) {
          const axis = STATE_AXES[s];
          if (axis) {
            perceiveFact(session.creatures.world, PLAYER_CREATURE_ID, {
              kind: "itemState",
              item: item.id,
              axis,
              state: s,
            });
          }
        }
      }
    }
    // Face to face, each side sees the other's CONDITION (a hungry housemate
    // looks hungry) — the "how is Mara" answer a third party can later ask for.
    {
      const partner = session.creatures.world.creatures[convo.nodeId];
      if (partner) {
        perceiveFact(session.creatures.world, PLAYER_CREATURE_ID, {
          kind: "condition",
          creature: convo.nodeId,
          condition: partner.condition ?? null,
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
    // An AMBIENT resident states a shopping want (§8): hearing it teaches WHERE to buy
    // that good, so the board gains a "where is food?" option that points to the
    // market. (Residents have no `needItemEntityId`; their want is a resource type.)
    const resGood = residentGood(session, convo.nodeId);
    if (resGood) learnSubject(session, `buy:good:${resGood.key}`, true);
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
        text: npcStatement(line, npcSym, convo.nodeId),
        glyph: line,
        ttl: 6,
      });
    }
    if (doSpeak) speakNpc(line, npcSym, convo.nodeId);
    presenter.board({
      kind: "acts",
      nodeId: convo.nodeId,
      posedByEntityId: node.npcEntityId,
      prompt: line,
      promptText: npcStatement(line, npcSym, convo.nodeId),
      // label + spokenText carry the translated statement (written caption
      // and the board's voice); `glyph` stays the invariant symbol string.
      options: convo.acts.map((a, i) => ({
        id: `act_${i}`,
        label: playerStatement(a.glyph),
        glyph: a.glyph,
        spokenText: playerStatement(a.glyph),
      })),
    });
    pushKnownNouns(session);
  }

  /** The static concept library (pools × categories × species) — pure data,
   *  shared by every noun push. */
  const CONCEPT_LIBRARY = buildConcepts();

  /** Push the player's speakable nouns to the Speak menu. LEARNED things: every
   *  item they now KNOW about (monotone knowledge — during a conversation
   *  `presentCreatureTurn` has already `seeItem`'d the creature's holdings), what
   *  they carry, and the current creature's need. In the DOLLHOUSE, home is NOT
   *  hidden information: the family (by NAME), the furniture, and every loose
   *  thing in the house are speakable from the first frame — without them the
   *  builder can't even compose "you get the apple". Diff-gated (re-pushed only
   *  when the list changes), so the tick may call it every frame. */
  function pushKnownNouns(session: QuestSession) {
    if (!presenter.nouns) return;
    type NounKind = "place" | "item" | "creature" | "unknown";
    const seen = new Set<string>();
    const out: { symbol: string; label: string; kind: NounKind; affords: string[]; properties: string[] }[] = [];
    // A STATION's OWN act verbs — the ones its need template satisfies
    // (needs.ts), which no property implies: you SLEEP in a bed, WASH in a
    // bath, COOK at an oven. The generic handling verbs (open/shut/put) are
    // DERIVED from the thing's properties below, so a new container never has
    // to be listed here at all.
    const STATION_ACTS: Record<string, string[]> = {
      bed: ["sleep", "rest"],
      table: ["eat"],
      bath: ["wash"],
      barrel: ["drink", "fill"],
      bin: ["throw"],
      bowl: ["fill"],
      oven: ["cook", "heat"],
      workbench: ["make", "fix", "build"],
    };
    // CORE ENGINE CONCEPTS (user law): nouns the engine itself owns — places,
    // substances — have no spec and no object properties, so their semantics
    // are hard-coded HERE and nowhere else. Every other noun is spec-derived.
    const CORE_NOUNS: Record<string, { kind: NounKind; affords: string[] }> = {
      home: { kind: "place", affords: ["go", "clean"] },
      house: { kind: "place", affords: ["go", "build", "clean"] },
      yard: { kind: "place", affords: ["go"] },
      bathroom: { kind: "place", affords: ["go"] },
      water: { kind: "item", affords: ["drink", "get", "give", "fill", "want"] },
    };
    const CREATURE_AFFORDS = ["talk", "ask", "help", "hug", "give", "follow", "go"];
    /** The verbs a thing's PROPERTIES imply — the §4 tag vocabulary read for
     *  affordances, so mechanics and board agree by construction. */
    const propertyAffords = (props: readonly string[]): string[] => {
      const v: string[] = [];
      if (props.includes("openable")) v.push("open", "shut");
      if (props.includes("container")) v.push("put");
      if (props.includes("food")) v.push("eat", "want", "get", "give");
      if (props.includes("clothing")) v.push("wear", "wash", "want", "get", "give");
      if (props.includes("toy")) v.push("play", "want", "get", "give");
      return v;
    };
    const conceptMeta = (symbol: string): { kind: NounKind; affords: string[]; properties: string[] } => {
      const properties = propertiesOf(symbol);
      const c = CONCEPT_LIBRARY.get(symbol);
      if (c) {
        const kind: NounKind =
          c.species?.kind === "creature" || c.pools.some((p) => p.affordance === "receptive-npc")
            ? "creature"
            : c.pools.some((p) => p.affordance === "container")
              ? "place"
              : "item";
        return { kind, affords: c.affords, properties };
      }
      const core = CORE_NOUNS[symbol];
      if (core) return { ...core, properties };
      const acts = STATION_ACTS[symbol];
      if (acts || properties.includes("furniture")) {
        // A placed thing: go there, do its act, plus whatever its properties
        // afford. `furniture` decides PLACE-ness — a bowl (tableware) is an
        // item you pick up, a cupboard is somewhere you stand.
        const affords = ["go", ...(acts ?? []), ...propertyAffords(properties)];
        return { kind: "place", affords: [...new Set(affords)], properties };
      }
      const affords = [...new Set(["want", "get", "give", ...(acts ?? []), ...propertyAffords(properties)])];
      return { kind: properties.length ? "item" : "unknown", affords, properties };
    };
    const addRaw = (
      symbol: string,
      label: string,
      meta?: { kind: NounKind; affords: string[]; properties?: string[] },
    ) => {
      if (!symbol || seen.has(symbol)) return;
      seen.add(symbol);
      const head = headOf(symbol);
      const m = meta ?? conceptMeta(head);
      out.push({ symbol, label, kind: m.kind, affords: m.affords, properties: m.properties ?? propertiesOf(head) });
    };
    const add = (id: string | undefined) => {
      if (!id) return;
      const glyph = session.entities.get(id)?.glyph;
      if (glyph) addRaw(glyph, headOf(glyph));
    };
    const creature = { kind: "creature" as NounKind, affords: CREATURE_AFFORDS };
    // KNOWN PEOPLE are speakable TARGETS wherever a family exists — not only
    // inside the dollhouse (the clinician-side "known people" pattern: people
    // the student knows belong on the board, so "where + mara" composes from
    // the street too).
    const famPeople = familyOf(session);
    if (famPeople) {
      for (const m of famPeople.members) if (m.name) addRaw(m.name.toLowerCase(), m.name, creature);
      for (const { pet } of petsOf(session)) {
        if (pet.name) addRaw(pet.name.toLowerCase(), pet.name, creature);
        else addRaw("dog", "dog", creature);
      }
    }
    if (session.dollhouse !== null && world) {
      // R1 — REGISTRY-SOURCED, CONTEXT-BLIND (world-engine-board-organization
      // §2, user law): every furniture kind the STATION REGISTRY defines is
      // speakable inside a home, whether or not one stands in this particular
      // house. The builder must be predictable — a student composes
      // "refrigerator" the same way in every house, and a new station kind
      // reaches the board by being registered, not by being listed here.
      // (Which pieces are actually NEARBY is the CONTEXT board's job.)
      for (const kind of Object.keys(STATION_PROPERTIES) as StationKind[]) {
        // The privy answers to the BOARD's word ("bathroom" — the resolver
        // aliases it back to the privy object).
        const noun = kind === "privy" ? "bathroom" : kind;
        addRaw(noun, noun);
      }
      addRaw("home", "home");
      addRaw("water", "water");
      // The wardrobe's garments: "you wear the shirt", "give dress to mara".
      // Seed the bare HEADS as nouns; colour rides as a separate `color_*`
      // modifier word ("wear + shirt + red"), already in the lexicon.
      addRaw("clothing", "clothing");
      for (const k of CLOTHING_HEADS) addRaw(k, k);
      for (const [, rec] of session.smallProps) addRaw(rec.glyph, headOf(rec.glyph));
    }
    // BUILDABLE STRUCTURES (①b): at a town / founded site, the catalog's
    // nouns are speakable — the sentence builder can compose "build house"
    // ("build" is already in the LEXICON; these are its objects).
    if (session.town || session.foundedSite) {
      const stock = buildStockOf(session);
      for (const spec of structureCatalogOf(session)) {
        if (stock && costsMet(spec, stock)) {
          addRaw(spec.glyph, spec.label, { kind: "place", affords: ["build", "go"], properties: ["structure"] });
        }
      }
      // TRANSFER surface (②): the yard is a speakable destination, houses
      // are endpoints, and any building MATERIAL on hand (yard/site stock or
      // the pocket) is a speakable object — "bring wood to the yard".
      addRaw("yard", "yard");
      if (session.town) addRaw("house", "house");
      // THE AREA WORDS (nations P2 §3c — user law: "area" is a broad
      // territory, grid icon; "place" is a point): laws scope by them —
      // "no + fight + in + town", "no + build + in + area" (the district
      // under your feet, else a focus disc).
      addRaw("town", "town", { kind: "place", affords: ["go"] });
      addRaw("area", "area", { kind: "place", affords: ["go", "area"] });
      for (const g of Object.keys({ ...(stock ?? {}), ...session.pocket })) {
        const head = headOf(g);
        if (isSiteMaterial(head)) {
          addRaw(head, head, { kind: "item", affords: ["get", "give", "bring", "want"], properties: ["material"] });
        }
      }
    }
    const lead = out.length; // family + house stay first; learned things sort after
    if (session.creatures) {
      const w = session.creatures.world;
      const player = w.creatures[PLAYER_CREATURE_ID];
      if (player) for (const id of Object.keys(player.knowledge)) add(id);
      for (const [id, it] of Object.entries(w.items)) if (it.ownerId === PLAYER_CREATURE_ID) add(id);
      if (convo) add(session.creatures.nodeByCreature.get(convo.nodeId)?.needItemEntityId);
    }
    // THE LIBRARY IS KNOWN BY DEFAULT (language-expansion.md): every pool
    // CONCEPT is speakable from frame 1 — only specific CHARACTERS stay
    // encounter-added (they arrive via the family/knowledge sections above).
    for (const n of libraryNouns()) addRaw(n.symbol, n.label);
    const tail = out.splice(lead).sort((a, b) => a.symbol.localeCompare(b.symbol));
    out.push(...tail);
    const sig = out.map((n) => n.symbol).join("|");
    if (sig === session.nounsSig) return;
    session.nounsSig = sig;
    presenter.nouns(out);
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
    // A NEIGHBOR resident answers from ITS OWN town — its streets/center, and
    // a `buy:good:*` subject re-aimed at its own market (window coords).
    const rc = neighborCtxOf(session, convo.nodeId);
    const f = rc ? neighborPlaceFact(rc, fact) : fact;
    const ans = answerPlaceDirections(
      rc ? rc.plan.streets : session.town.plan.streets,
      rc ? rc.center : session.town.stage.center,
      { x: player.x, y: player.y },
      f,
    );
    const locale = session.game.meta.locale;
    const npcSym = session.entities.get(node.npcEntityId)?.glyph;
    const text = speakDirections(fact.thingGlyph, ans.proximity, ans.cardinal, locale, {
      speaker: npcSpeakerGender(npcSym, convo.nodeId),
    });
    // Voice it (already localised — skip glyph translation) + bubble it.
    voice?.cancel();
    voice?.speak(text, { lang: locale, ...speakerVoiceOpts(convo.nodeId) });
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
    // A RARE import's directions carry the judgment as a second line —
    // "cookie... rare" (the far-away good is scarce, and everyone knows it).
    if (subjectId.startsWith("buy:import:")) {
      const nodeId = convo.nodeId;
      setTimeout(() => {
        if (!world || sess !== session || convo?.nodeId !== nodeId) return;
        npcChatBubble(session, nodeId, `${fact.thingGlyph} + rare`);
      }, speechEstimateMs(text));
    }
    presentCreatureTurn(undefined, { speak: false, bubble: false });
  }

  /** Re-aim a `buy:good:*` fact at the answering NEIGHBOR's own source (its
   *  market/farm stall), lifted into window coords. Other subjects (the
   *  primary's cast homes/stalls) keep their positions — the neighbor points
   *  across the fields toward the primary. */
  function neighborPlaceFact(rc: ClusterHouseCtx, fact: PlaceFact): PlaceFact {
    const key = fact.id.startsWith("buy:good:") ? fact.id.slice("buy:good:".length) : null;
    const g = key ? rc.goods.find((x) => x.good.key === key) : undefined;
    const ref = rc.plan.houses[0];
    if (!g || !ref) return fact;
    const s = g.sourceOf(ref);
    return { ...fact, worldPos: { x: s.x + rc.offset.x, y: s.y + rc.offset.y } };
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
  /** A resident's OWN town by its (window) house index: the cluster member
   *  owning the reserved range (≥1000, town-cluster.ts), else the primary.
   *  Every house-keyed read goes through here — house/goods/plan from the
   *  OWNING town, `offset` lifting its stage positions into window coords. */
  function residentTownCtx(session: QuestSession, houseIndex: number) {
    const t = session.town;
    if (!t || !Number.isInteger(houseIndex) || houseIndex < 0) return null;
    // `TownHouse.index` is the LOT id, NOT the array position — stall
    // conversions are filtered out of plan.houses, so the array has GAPS.
    // Positional indexing here resolved a NEIGHBORING house for every lot
    // past a conversion (wrong home coords, wrong goods clock, wrong chest
    // fallback — the family "walking home" to someone else's house).
    const byIndex = (houses: TownHouse[], idx: number): TownHouse | undefined =>
      houses.find((hh) => hh.index === idx);
    const c = t.stage.cluster?.resolveHouse(houseIndex);
    if (c) return { ...c, house: byIndex(c.plan.houses, c.localHouse), neighbor: true };
    return {
      town: t.town, eco: t.eco, plan: t.plan, goods: t.stage.goods,
      localHouse: houseIndex, offset: { x: 0, y: 0 }, center: t.stage.center,
      house: byIndex(t.plan.houses, houseIndex), neighbor: false,
    };
  }

  /** The NEIGHBOR context of a conversing creature — null for the primary's
   *  people and every non-resident (they keep the primary's geometry). */
  function neighborCtxOf(session: QuestSession, cid: string): ClusterHouseCtx | null {
    if (!cid.startsWith("resident_")) return null;
    return session.town?.stage.cluster?.resolveHouse(Number(cid.split("_")[1])) ?? null;
  }

  /** The good member `m` SHOPS for, per the household DUTY ROSTER
   *  (kernel/town/roster.ts — the ONE allocator; nobody re-derives member↔slot).
   *  Town scope has no member exclusions, so one roster serves every house.
   *  Undefined for homebodies / off a town session. */
  function residentShopGoods(session: QuestSession, houseIndex: number, member: number) {
    const rc = residentTownCtx(session, houseIndex); // a neighbor duties by ITS goods
    if (!rc || !Number.isInteger(member) || member < 0) return undefined;
    const roster = rosterOf(
      rc.goods.map((g, i) => ({ key: g.good.key, slot: g.good.slot ?? i })),
      familyExcludedMembers(session, houseIndex), // a mode-"all" family hands roles down
    );
    const duty = shopDutyOf(roster[member]);
    return duty ? rc.goods.find((g) => g.good.key === duty.good) : undefined;
  }

  /** The good an ambient resident shops for (its roster duty), null when it has none. */
  function residentGood(session: QuestSession, residentId: string): { key: string } | null {
    const good = residentShopGoods(
      session,
      Number(residentId.split("_")[1]),
      Number(residentId.split("_")[2]),
    );
    return good ? { key: good.good.key } : null;
  }

  // ── The DEFINED FAMILY (world-doc `entities.creatures`, town-interpreted) ──
  // Hand-authored members of the focused household: names, species, outfits,
  // likes; mode "all" caps the household at exactly these members (the rest
  // were never generated — the resident model excluded them at build).

  /** The family, resolved: null when the document defined none. */
  function familyOf(session: QuestSession): { house: number; mode: "some" | "all"; members: TownFamilyMember[] } | null {
    const fam = session.town?.config.family;
    const house = session.town?.familyHouse ?? null;
    if (!fam || house === null) return null;
    return { house, mode: fam.mode, members: fam.members };
  }

  /** The hand-authored member at (house, m), or undefined (a generated soul). */
  function familyMemberOf(session: QuestSession, houseIndex: number, member: number): TownFamilyMember | undefined {
    const fam = familyOf(session);
    if (!fam || fam.house !== houseIndex) return undefined;
    return fam.members[member];
  }

  // ── Household PETS (creature-behavior-brainstorming.md V1): authored family
  // members of a non-person species. A pet's body is `pet_<house>_<n>`; it runs
  // the SAME need machinery with `grasp: false` — never a separate code path.

  function isPetCid(cid: string): boolean {
    return cid.startsWith("pet_");
  }

  /** The authored pets, with their body ids. Empty off a family session. */
  function petsOf(session: QuestSession): Array<{ cid: string; house: number; pet: TownFamilyPet }> {
    const fam = familyOf(session);
    const pets = session.town?.config.family?.pets;
    if (!fam || !pets?.length) return [];
    return pets.map((pet, i) => ({ cid: `pet_${fam.house}_${i}`, house: fam.house, pet }));
  }

  function petCidsOf(session: QuestSession): string[] {
    return petsOf(session).map((p) => p.cid);
  }

  /** Register a pet on the creature world (idempotent): likes, NO grasp — the
   *  capability gate that makes its pantry unreachable and its want surface. */
  function ensurePetCreature(session: QuestSession, petCid: string) {
    ensureResidentCreature(session, `resident_${houseIndexOfCid(petCid)}_0`); // seeds session.creatures
    const creatures = session.creatures!;
    if (creatures.world.creatures[petCid]) return;
    const rec = petsOf(session).find((p) => p.cid === petCid);
    const likes = rec?.pet.likes?.length ? [...rec.pet.likes] : [FOOD_KINDS[fnv1a(petCid) % FOOD_KINDS.length]!];
    creatures.world.creatures[petCid] = createCreatureWorld([{ id: petCid, likes, grasp: false }], [])
      .creatures[petCid]!;
    const node: FulfillNode = { id: petCid, type: "fulfill", npcEntityId: `resident_face:${petCid}` };
    creatures.creatureByNode.set(petCid, petCid);
    creatures.nodeByCreature.set(petCid, node);
  }

  /** Member indices a mode-"all" family EXCLUDES in its house (roster parity
   *  with the resident model's exclusion set). */
  function familyExcludedMembers(session: QuestSession, houseIndex: number): Set<number> | undefined {
    const fam = familyOf(session);
    if (!fam || fam.house !== houseIndex || fam.mode !== "all") return undefined;
    const ex = new Set<number>();
    for (let m = fam.members.length; m < HOUSEHOLD; m++) ex.add(m);
    return ex;
  }

  /** Avatar-model overrides (species/outfit) for the defined members + pets. */
  function familyOverrides(session: QuestSession): Map<string, { species?: string; outfit?: number }> | undefined {
    const fam = familyOf(session);
    if (!fam) return undefined;
    const out = new Map<string, { species?: string; outfit?: number }>();
    fam.members.forEach((m, i) => {
      if (m.species !== undefined || m.outfit !== undefined) {
        out.set(`resident_${fam.house}_${i}`, {
          ...(m.species !== undefined ? { species: m.species } : {}),
          ...(m.outfit !== undefined ? { outfit: m.outfit } : {}),
        });
      }
    });
    for (const { cid, pet } of petsOf(session)) {
      out.set(cid, { species: pet.species ?? "quadruped" });
    }
    return out.size ? out : undefined;
  }

  /** The town's JOB assignments (roster.ts `assignTownJobs`) — computed lazily once,
   *  from the SAME inputs the resident model uses, so both sides agree on who works
   *  where. Null off a town session. */
  let townJobsMemo: Map<number, JobAssignment[]> | null = null;
  function ensureTownJobs(session: QuestSession): Map<number, JobAssignment[]> | null {
    const town = session.town;
    if (!town) return null;
    if (!townJobsMemo) {
      townJobsMemo = assignTownJobs(
        town.plan.houses.map((h) => ({ index: h.index, door: houseDoorstep(town.stage.center, h) })),
        // Per-spec staff where a row declares it (①b founded buildings; an
        // under-construction row carries jobs 0 — nobody staffs a scaffold).
        town.plan.works.map((wk) => ({
          door: workDoorstep(town.stage.center, wk),
          ...(wk.jobs !== undefined ? { staff: wk.jobs } : {}),
        })),
        town.stage.goods.length,
        town.config.seed,
      );
    }
    return townJobsMemo;
  }
  function residentJobDuty(
    session: QuestSession,
    houseIndex: number,
    member: number,
  ): { work: number; window: { start: number; len: number } } | undefined {
    const town = session.town;
    const jobs = ensureTownJobs(session);
    if (!town || !jobs) return undefined;
    const roster = rosterOf(
      town.stage.goods.map((g, i) => ({ key: g.good.key, slot: g.good.slot ?? i })),
      familyExcludedMembers(session, houseIndex),
      jobs.get(houseIndex),
    );
    return jobDutyOf(roster[member]);
  }

  /** JOBS→ECONOMY sweep (roster.ts attendance): a worker whose shift is ON but
   *  whose body the schedule does not own — recruited to the party, running a
   *  spoken command, or promoted by the live need loop — is ABSENT; tally the
   *  seconds per work. Only disruption can cause absence, so only those small
   *  sets are swept; the off-screen crowd is present by definition. */
  function stepWorkAttendance(session: QuestSession, dt: number) {
    if (!session.town) return;
    const disrupted = new Set<string>([...session.party, ...session.liveNeedBodies]);
    for (const [bodyId, queue] of session.npcTasks) {
      if (bodyId.startsWith("resident_") && queue.length > 0) disrupted.add(bodyId);
    }
    for (const cid of disrupted) {
      if (!cid.startsWith("resident_")) continue;
      const jd = residentJobDuty(session, Number(cid.split("_")[1]), Number(cid.split("_")[2]));
      if (!jd || !inShiftWindow(jd.window, session.townClock, FOOD_DAY_SEC)) continue;
      session.workAbsence.set(
        jd.work,
        noteAbsence(session.workAbsence.get(jd.work), session.townClock, dt, FOOD_DAY_SEC),
      );
    }
  }

  /** ONE work's attendance factor at `day` (yesterday's absence; 1 when the
   *  work is unstaffed — nobody assigned means nobody missing). */
  function workAttendanceFactor(session: QuestSession, w: number, day: number): number {
    const jobs = ensureTownJobs(session);
    if (!jobs) return 1;
    let staff = 0;
    let windowLen = 0;
    for (const js of jobs.values()) {
      for (const j of js) {
        if (j.work === w) {
          staff++;
          windowLen = j.window.len;
        }
      }
    }
    if (staff === 0) return 1;
    return attendanceFactor(session.workAbsence.get(w), day, staff * windowLen * FOOD_DAY_SEC);
  }

  /** Yesterday's PRODUCER attendance for a good — the dawn-shelf damping factor,
   *  averaged over the good's staffed producer works. Full crews yesterday ⇒ 1;
   *  a poached farm crew ⇒ today's food shelf runs thin (never below the floor —
   *  the aggregate's other hands still move goods). */
  function producerAttendance(session: QuestSession, goodKey: string): number {
    const town = session.town;
    if (!town || !ensureTownJobs(session)) return 1;
    const g = town.stage.goods.find((x) => x.good.key === goodKey);
    if (!g) return 1;
    const day = Math.floor(session.townClock / FOOD_DAY_SEC);
    let sum = 0;
    let n = 0;
    town.plan.works.forEach((wk, w) => {
      if (!g.good.producers.includes(wk.type)) return;
      sum += workAttendanceFactor(session, w, day); // unstaffed works read 1
      n++;
    });
    return n > 0 ? sum / n : 1;
  }

  /** SLICE 3 — clock↔need RECONCILIATION (npc-behavior-and-town-economy.md §8.3). Keep
   *  the goods clock AND the dialogue need CONSISTENT: a resident's shopping want is TRUE
   *  only while it's actually OUT acquiring the good (errand phase `to_source`/`at_source`);
   *  once it's carrying the goods home or stocked (`to_home`/`home`), the want is satisfied
   *  and CLEARS. So "I want food" appears on the way to the market and drops when it
   *  returns — fixing "needs don't clear on return". The clock still drives the BODY; this
   *  only PROJECTS its phase onto the need for dialogue (both systems retained, as
   *  intended). Cheap (a few visible residents). NOTE (slice 3b): the clock is time-pure,
   *  so player INTERFERENCE (gifting a shopper its good) doesn't yet reschedule the trip —
   *  next tick the phase re-derives the want. That needs stateful, estimated errands. */
  function stepResidentEconomyNeeds(session: QuestSession, shown: (hi: number) => boolean) {
    const town = session.town;
    if (!session.creatures || !town) return;
    for (const cid of session.creatures.nodeByCreature.keys()) {
      if (!cid.startsWith("resident_") && !cid.startsWith("pet_")) continue;
      const houseIdx = Number(cid.split("_")[1]);
      const house = residentTownCtx(session, houseIdx)?.house; // neighbor-aware
      const m = Number(cid.split("_")[2]);
      const creature = session.creatures.world.creatures[cid];
      if (!house || !creature) continue;

      // LIVE REASONS (elemental-actions doc §2: the plan's edges ARE causal facts) —
      // publish WHY onto the dialogue self so the existing `why` act answers from the
      // live episode. HUNGER (any member): condition "hungry" + a want-food need with a
      // because-fact ("I want food because I'm hungry") — homebodies gain the need here,
      // which also makes them giftable through the normal offer path.
      const hungry = (session.needMeters.get(`${cid}|hunger:food`) ?? 0) >= 1;
      let foodNeed = creature.needs.find((n) => n.target?.category === "food");
      if (hungry && !foodNeed) {
        foodNeed = { itemId: "good:food", value: 2, target: { category: "food" }, fulfilled: false };
        creature.needs.push(foodNeed);
      }
      if (foodNeed) {
        if (hungry) foodNeed.fulfilled = false;
        else if (creature.condition === "hungry") foodNeed.fulfilled = true; // the runner branch below re-derives its own truth
      }
      // CONDITION MIRROR: every firing MOTIVE meter surfaces as the creature's
      // condition (highest first — the walker's own order), so "are you okay?"
      // answers honestly ("I am tired") and the why/emote paths follow. Only
      // condition ONLY, no causal fact: the dialogue layer's condition+want path
      // already answers why with "I want food because I'm hungry". A quest-
      // authored condition outside this set is never touched.
      const firing = (key: string) => (session.needMeters.get(`${cid}|${key}`) ?? 0) >= 1;
      const motive = hungry
        ? "hungry"
        : firing("thirst:water")
          ? "thirsty"
          : firing("waste")
            ? "need_toilet"
            : firing("energy")
              ? "tired"
              : firing("social")
                ? "lonely"
                : firing("hygiene")
                  ? "dirty"
                  : firing("fun")
                    ? "bored"
                    // DRESS — the worn garment is dirty enough to want changing.
                    // Without this the dress motive had no condition mirror, so
                    // "why?" about a member standing in filthy clothes had
                    // literally nothing to answer with (the silent-why bug).
                    : firing("dress")
                      ? "scruffy"
                    : (session.stress.get(cid) ?? 0) >= STRESS_VISIBLE
                      ? "sad" // derived stress (mood.ts): fine right now, but frayed
                      : undefined;
      if (motive) creature.condition = motive;
      else if (creature.condition && MOTIVE_CONDITIONS.has(creature.condition)) {
        creature.condition = undefined;
      }

      if (cid.startsWith("pet_")) continue; // a pet holds no duties — the mirror above is its whole surface
      const good = residentShopGoods(session, houseIdx, m);
      if (!good) continue; // homebody: hunger (above) is its whole economy surface
      const need = creature.needs.find((n) => n.target?.category === good.good.key);
      if (!need) continue;
      // LIVE (needs loop): it wants the good exactly while FETCHING it; a unit in hand
      // (a gift, a fresh purchase) reads as satisfied whatever the time-pure clock says.
      // "I have no {good}" must be TRUE to be said: a unit in hand — the carried
      // stack, or an owned instance (a player's gift) — forbids the lack claim, or
      // the same creature answers "where is it?" with "I have it" and "why do you
      // want it?" with "because I don't have it" in one breath.
      const holdsUnit =
        carryTotalOf(session.needCarried.get(cid), good.good.key) > 0 ||
        Object.values(session.creatures.world.items).some(
          (i) => i.ownerId === cid && (i.kind === good.good.key || i.category === good.good.key),
        );
      if (session.liveNeedBodies.has(cid)) {
        const step = session.needStep.get(cid);
        const carried = carryTotalOf(session.needCarried.get(cid), good.good.key);
        const hungerHolds = hungry && good.good.key === "food"; // the food want stays open while hungry
        need.fulfilled = !hungerHolds && (carried > 0 || !(step && step.kind === "take" && step.goodKey === good.good.key));
        // Restocking reason (unless hunger already owns the fact): "I want {good}
        // because I have no {good}" — the box shortfall that fired the trip.
        if (
          step?.tplKey === `provision:${good.good.key}` &&
          !(hungry && good.good.key === "food") &&
          !holdsUnit
        ) {
          need.causalFact = {
            connective: "because",
            cause: { kind: "possessionLack", creature: cid, item: `good:${good.good.key}` },
          };
        } else if (need.causalFact?.cause.kind === "possessionLack" && holdsUnit) {
          delete need.causalFact;
        }
        continue;
      }
      const est = good.errand(house, session.townClock);
      // An ON-SHOW house's clock is SUPPRESSED FICTION (no trips are issued;
      // the live loop shops) — its phase must never reach dialogue, or a
      // member standing in the kitchen claims to be out fetching cloth.
      const fetching = !shown(houseIdx) && (est.phase === "to_source" || est.phase === "at_source");
      // A CLOCK trip has the same honest reason a live one does — the box runs low —
      // so "why?" answers on any traveling shopper, not just a disrupted one.
      if (fetching && !holdsUnit) {
        need.causalFact = {
          connective: "because",
          cause: { kind: "possessionLack", creature: cid, item: `good:${good.good.key}` },
        };
      } else if (need.causalFact?.cause.kind === "possessionLack") {
        delete need.causalFact; // stale trip reason / no-longer-true lack
      }
      need.fulfilled = !(hungry && good.good.key === "food") && !fetching;
    }
  }

  /** Walk a DEMOTED resident back home, door-routed. The schedule owns the
   *  body again, and a schedule body belongs at home between trips — without
   *  this, a live episode that ended out in the town (a spoken command, a
   *  market run, a blocked want) left the body parked in the street until the
   *  next shopping cycle happened to claim it. No-op when already home-ish.
   *  The target is a PER-MEMBER spot about the room, probed clear of solid
   *  fixtures — the naive house CENTER is where the TABLE stands, and every
   *  homecoming converged on it and parked the family in one stuck pile. */
  /** THE IDLE PAD of a house's living room (floor-route idlePadOf) — the
   *  clear rectangle its members pace inside between errands, and the target
   *  region of every homecoming. Cached per house + construction rev; null =
   *  the room has no patch worth pacing (fall back to the legacy spot). */
  const idlePadCache = new Map<string, { x: number; y: number; w: number; h: number } | null>();
  function houseIdlePad(
    session: QuestSession,
    state: WorldState,
    houseIndex: number,
  ): { x: number; y: number; w: number; h: number } | null {
    const rc = residentTownCtx(session, houseIndex);
    if (!rc?.house) return null;
    const rev = session.town?.deltas?.get(`h_${houseIndex}`)?.rev ?? 0;
    const key = `${houseIndex}|${rev}`;
    let pad = idlePadCache.get(key);
    if (pad === undefined) {
      // The pad only makes sense over STAGED furniture — a dark house has no
      // fixture objects to avoid, and its pad would claim the whole room.
      // Only compute when the living room's table (always furnished) exists.
      if (!state.objects[`furn_${houseIndex}_table`]) return null;
      pad = idlePadOf(state, livingRect(rc.center, rc.house));
      idlePadCache.set(key, pad);
    }
    return pad;
  }

  function walkResidentHome(session: QuestSession, state: WorldState, cid: string) {
    if (!world || !cid.startsWith("resident_")) return;
    const houseIndex = Number(cid.split("_")[1]);
    const member = Number(cid.split("_")[2]);
    const rc = residentTownCtx(session, houseIndex);
    const body = state.avatars[cid];
    if (!rc?.house || !body) return;
    // `center` is the owning town's center in WINDOW coords for primary and
    // cluster members alike (ClusterHouseCtx.center) — never add `offset` too.
    // The homecoming anchors on the LIVING room (rooms.ts): the footprint
    // center can be a partition wall now.
    const lrHome = livingRect(rc.center, rc.house);
    const cx = lrHome.x + lrHome.w / 2;
    const cy = lrHome.y + lrHome.h / 2;
    // Idle pacing is CONFINED to the room's clear pad (DEBUG-CREATURE-BEHAVIOR
    // §1.2: wander has no router — it only ever roams ground the pad
    // guarantees clear; outside the pad the body stands until this walk
    // delivers it). Keep the confinement fresh even when already home.
    const pad = houseIdlePad(session, state, houseIndex);
    world.setNpcWanderRect(cid, pad);
    if (Math.hypot(body.x - cx, body.y - cy) <= Math.max(rc.house.w, rc.house.h) && !pad) return;
    // A deterministic per-member spot INSIDE the pad (spread by member index);
    // legacy ring spot when the room has no pad.
    let home: { x: number; y: number };
    if (pad) {
      const gx = 0.18 + 0.64 * ((member * 0.37 + 0.13) % 1);
      const gy = 0.18 + 0.64 * ((member * 0.61 + 0.29) % 1);
      home = { x: pad.x + pad.w * gx, y: pad.y + pad.h * gy };
      if (Math.hypot(body.x - home.x, body.y - home.y) <= 1.5) return; // already pacing there
    } else {
      const ang = 0.7 + member * 2.4;
      const rad = Math.max(0.8, Math.min(lrHome.w, lrHome.h) / 2 - 1.6);
      const raw = { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad };
      home = nearestClearSpot(state, raw, { x: cx, y: cy }, world.npcRadiusOf(cid));
    }
    session.lastDrive.set(cid, "walk-home");
    world.setNpcErrand(cid, doorRouteErrand(state, { x: body.x, y: body.y }, { points: [home] }, world.npcRadiusOf(cid)));
  }

  /** An unclaimed CHAIR pulled up to `tableId`, nearest the body — the meal's
   *  stand point (§3.3, DEBUG-CREATURE-BEHAVIOR: chairs are used for meals).
   *  A seat is TAKEN when another body's active step has claimed it (needStep
   *  seatId — steps are set in cid order within a frame, so two same-frame
   *  diners never race) or another body is physically on it (a commanded
   *  sitter, a diner dwelling out its meal after its step cleared). Null =
   *  no free chair; the caller falls back to standing at the table's edge. */
  function freeSeatAt(
    session: QuestSession,
    state: WorldState,
    cid: string,
    tableId: string,
  ): { id: string; x: number; y: number } | null {
    const t = state.objects[tableId];
    const body = state.avatars[cid];
    if (!t || !body) return null;
    const tSpec = state.spec.objects.find((s) => s.id === tableId);
    const reach = (tSpec?.radius ?? 1) + 1.6; // a pulled-up chair sits within arm's reach of the tabletop
    let best: { id: string; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const spec of state.spec.objects) {
      if (spec.fixture !== "chair") continue;
      const o = state.objects[spec.id];
      if (!o || Math.hypot(o.x - t.x, o.y - t.y) > reach) continue;
      let taken = false;
      for (const [other, st] of session.needStep) {
        if (other !== cid && st.seatId === spec.id) { taken = true; break; }
      }
      if (!taken) {
        for (const [pid, pav] of Object.entries(state.avatars)) {
          if (pid === cid || (!pid.startsWith("resident_") && !pid.startsWith("pet_"))) continue;
          if (Math.hypot(pav.x - o.x, pav.y - o.y) < 0.5) { taken = true; break; }
        }
      }
      if (taken) continue;
      const d = Math.hypot(o.x - body.x, o.y - body.y);
      if (d < bestD) {
        bestD = d;
        best = { id: spec.id, x: o.x, y: o.y };
      }
    }
    return best;
  }

  /** LIVE NEEDS (doc §13 slice 3 — the general machine; needs.ts templates). For each
   *  registered resident whose house interior is ON SHOW — or who is already PROMOTED
   *  (a gift mid-street keeps driving until the disruption is neutralized) — run its
   *  need templates one walk-step at a time: decide (`decideNeeds`) → walk → arrive →
   *  apply the elemental effect over the container/stack model → re-decide. Nothing is
   *  scripted: stealing the pantry dry re-routes the hungry to the market and fires the
   *  runner's provisioning trip; a gifted stack walks home into the house box. Off-show,
   *  un-promoted households aren't ticked — the schedule's linear drain stands in
   *  (SCHEDULED mode); the LOAD/UNLOAD edges (`stepHouseholdEdges`) do the §13a.3
   *  chest↔schedule handoff. */
  /** Is a lidded container ACCESSIBLE to a body now — an OPEN surface ("on"),
   *  one left OPEN (its lid `heldOpen`), or one this body can OPEN itself
   *  (grasp)? A graspless body (a pet) reaches only the first two, so an opened
   *  box is what lets it help itself. */
  function containerAccessible(session: QuestSession, id: string, grasp: boolean): boolean {
    if (session.containers.get(id) === "on") return true;
    if (world?.state.objects[id]?.heldOpen) return true;
    return grasp;
  }

  /** OPEN a container's lid as the ACCESS ACTION — it eases open and STAYS open
   *  (a graspless creature can then use it) until the taker leaves (auto-close)
   *  or an explicit "shut". `pin` = a command ("open the chest"), which keeps it
   *  open with nobody near. A brief reach gesture marks the act. Idempotent. */
  function openContainerLid(session: QuestSession, cid: string, boxId: string, pin = false) {
    const o = world?.state.objects[boxId];
    if (o && !o.heldOpen) {
      o.heldOpen = true;
      fireCarryGesture(avatarIdOf(cid), "pickup", { x: o.x, y: o.y });
    }
    if (pin) session.containerPinned.add(boxId);
  }

  /** AUTO-CLOSE: an access-opened lid (not command-PINNED) shuts once no body
   *  lingers beside it — "closing is triggered when the creature is done". Run
   *  each tick. */
  function stepContainerLids(session: QuestSession, state: WorldState) {
    for (const spec of state.spec.objects) {
      if (!spec.openable) continue;
      const o = state.objects[spec.id];
      if (!o?.heldOpen || session.containerPinned.has(spec.id)) continue;
      const range = spec.radius + 1.4;
      const near = Object.values(state.avatars).some(
        (a) => a.floor === o.floor && Math.abs(a.x - o.x) < range && Math.abs(a.y - o.y) < range,
      );
      if (!near) o.heldOpen = false; // the taker finished and left — the lid shuts
    }
  }

  /** Goals driven by the PER-TICK PURSUIT (the unified loop) rather than a baked
   *  one-shot errand — the planner-owned CARRIED-ITEM family, each proven to
   *  emit the same steps as the old `compileGoal` bake (symbol-game-action-
   *  planner.test.ts) so the migration is behaviour-preserving but now resilient
   *  (re-routes, resumes, adapts). `transform`, `rest` and `setOpen` now ride it
   *  too (S0 — their `applyGoalStep` arms are wired below). `toggle` stays OUT: it
   *  has an executor but not the pursuit's stand-nudge yet. Movement/social/host-
   *  policy goals keep their own dispatch. */
  const PURSUED_GOALS = new Set<GoalSpec["kind"]>([
    "consume", "fetch", "give", "putIn", "transform", "rest", "setOpen", "wear", "converse",
    "takeUnits", "putUnits", "processUnits", "equipUnits", "dropUnits", "consumeUnits",
  ]);
  /** Seconds a COMMANDED rest occupies its station (sleep/sit/play). A command
   *  rests once and the pursuit ends — a need-born rest carries its motive's own
   *  dwell on the goal (`dwellS`, from `restDwellFor`). */
  const REST_CMD_DWELL_S = SIT_DWELL_S;
  /** S2 MASTER SWITCH: clean self-needs (NEED_PURSUIT_MOTIVES in need-goals.ts)
   *  install `source: "need"` pursuits — a need IS a self-assigned command. OFF
   *  reverts every motive to the legacy needStep walker wholesale. */
  const NEED_PURSUITS_ENABLED = true;
  /** How far past its own furniture a NEED-born resolution may reach (loose
   *  items at the feet, the bowl beside a wandering pet) — see the NEED SCOPE
   *  in makeGoalResolver. */
  const NEED_SCOPE_REACH_M = 8;
  /** Seconds a need motive stays OFF the pursuit route after a pursuit for it
   *  ended without completing (blocked mid-flight / act-cap): the legacy walker
   *  — whose blocked machinery begs, surfaces for adoption and demotes — owns
   *  the motive for the spell, instead of an install→fail→reinstall churn. */
  const NEED_PURSUIT_RETRY_S = 25;
  /** Arrival radius for a pursuing body — the same 1.3 the needs walker counts. */
  const COMMAND_ARRIVE = 1.3;
  /** Discrete actions a single pursuit may attempt before parting aloud — the
   *  carried-item family needs at most ~3 (pick → walk → give/place), so a body
   *  past this is looping on a step it can't complete. */
  const COMMAND_ACT_CAP = 5;

  /** Default arrival radius for a walk (needs + commands both count 1.3). */
  const WALK_ARRIVE = 1.3;
  /** Seconds a body may sit motionless en route before the walk RE-ROUTES (and,
   *  after WALK_MAX_REROUTES of them, gives up and acts in place). */
  const WALK_STALL_S = 3;
  /** Re-routes a stuck walk attempts (from where the body actually stands, a
   *  fresh stand spot each time) before conceding the point is unreachable. */
  const WALK_MAX_REROUTES = 2;

  /**
   * THE ONE WALK PRIMITIVE — steer `cid`'s body to `target`. There is no
   * difference between walking for a need and walking for a command: both call
   * THIS. It owns the whole "get from A to B" contract:
   *   • issue the routed errand (doorRouteErrand → furniture doglegs + doors)
   *     ONCE per committed destination, never re-thrashed per tick;
   *   • judge progress by ACTUAL MOTION (circling furniture is progress, not a
   *     stall), so the shared controller's detour has time to carry the body
   *     around obstacles;
   *   • on a genuine pin (no motion for WALK_STALL_S), RE-ROUTE from where the
   *     body stands — `onReroute` lets the caller hand back a fresh stand spot
   *     (a need releases its claimed seat; a command drops its committed spot);
   *   • after WALK_MAX_REROUTES it returns "gaveup" so the caller acts in place
   *     (termination over fidelity).
   * Returns "arrived" once inside `arrive`, "arriving" while en route.
   */
  function walkTo(
    session: QuestSession,
    cid: string,
    target: { x: number; y: number },
    dt: number,
    opts?: { arrive?: number; onReroute?: () => { x: number; y: number } | null },
  ): "arriving" | "arrived" | "gaveup" {
    if (!world) return "gaveup";
    const body = world.state.avatars[avatarIdOf(cid)];
    if (!body) {
      session.walk.delete(cid);
      return "gaveup";
    }
    const arrive = opts?.arrive ?? WALK_ARRIVE;
    if (Math.hypot(body.x - target.x, body.y - target.y) <= arrive) {
      session.walk.delete(cid);
      return "arrived";
    }
    const issue = (to: { x: number; y: number }) =>
      world!.setNpcErrand(cid, doorRouteErrand(
        world!.state, { x: body.x, y: body.y }, { points: [{ x: to.x, y: to.y }] },
        world!.npcRadiusOf(avatarIdOf(cid)),
      ));
    let w = session.walk.get(cid);
    if (!w || Math.hypot(w.tx - target.x, w.ty - target.y) > 0.4) {
      // NEW leg (first walk, or the caller's committed target moved): route to it
      // and anchor the motion watch at the body's current spot.
      w = { tx: target.x, ty: target.y, ax: body.x, ay: body.y, stuckT: 0, reroutes: 0 };
      session.walk.set(cid, w);
      issue(target);
    } else if (Math.hypot(body.x - w.ax, body.y - w.ay) > 0.4) {
      // Physically MOVED — progress along SOME path (incl. the detour around
      // furniture, where straight-line distance to the goal briefly grows).
      w.ax = body.x;
      w.ay = body.y;
      w.stuckT = 0;
    } else if ((w.stuckT += dt) > WALK_STALL_S) {
      w.stuckT = 0;
      w.reroutes += 1;
      // NEVER SNAP WHILE VISIBLE. Giving up hands the caller a teleport / in-place
      // completion — fine off-screen (the only place the timing estimate is
      // trusted), but an impossible move if the player is watching the body OR
      // its destination. While either is on-screen, keep RE-ROUTING forever
      // instead of conceding: a genuinely stuck body is then a visible pathing
      // bug to fix, not a papered-over teleport.
      if (w.reroutes > WALK_MAX_REROUTES && !viewNear(session, body, target)) {
        session.walk.delete(cid);
        return "gaveup";
      }
      const fresh = opts?.onReroute?.() ?? target;
      w.tx = fresh.x;
      w.ty = fresh.y;
      w.ax = body.x;
      w.ay = body.y;
      issue(fresh);
    }
    return "arriving";
  }

  /** The spoken "I can't — it isn't here" line for a blocked pursuit: names the
   *  missing thing ("we don't have the banana"), never a silent stall. Covers the
   *  whole carried-item family — the thing that couldn't be reached is the
   *  goal's own item. */
  function pursuitBlockLine(goal: GoalSpec): LeveledGlyphs | string {
    const item =
      goal.kind === "consume" || goal.kind === "fetch" || goal.kind === "give" || goal.kind === "putIn"
        ? goal.item
        : undefined;
    const kind = item && "match" in item ? (item.match.kind ?? item.match.category) : undefined;
    return kind ? `i_me + have.not + ${kind}` : NOT_UNDERSTOOD_LINE;
  }

  /** THE ONE PURSUIT DRIVER (concept-parser.md §10): every body in
   *  `session.pursuits` — commanded today, need-born after S2 — re-derives its
   *  next step from the LIVE world each tick (`pursue`) and drives itself: walk
   *  the next leg, or perform the arrived-at action. A disrupted goal therefore
   *  resumes, re-routes, and adapts (a closer instance, a taken item) instead of
   *  running a stale baked plan; a goal it can no longer reach speaks the honest
   *  reason. The loop is SOURCE-BLIND — `pur.source` matters only to whoever
   *  installs and pre-empts entries, never to how one is driven. */
  function stepPursuit(session: QuestSession, state: WorldState, dt: number) {
    if (!world || session.pursuits.size === 0) return;
    const cmdBase = makeGoalResolver(session);
    for (const [cid, pur] of [...session.pursuits]) {
      // A NEED-born pursuit resolves inside its own scope (household + arm's
      // reach); a command's resolution stays town-wide. Built per body — the
      // scope is seeker-relative.
      const base = pur.source === "need" ? makeGoalResolver(session, cid) : cmdBase;
      // A failed need pursuit hands the motive back to the legacy walker for a
      // spell (the beg/adopt/demote machinery lives there) — without this, an
      // uncleared meter reinstalls the same failing plan every decide tick.
      const coolOff = () => {
        if (pur.source === "need" && pur.tplKey) {
          session.needPursuitCooldown.set(`${cid}|${pur.tplKey}`, session.townClock + NEED_PURSUIT_RETRY_S);
        }
      };
      const clear = () => {
        session.pursuits.delete(cid);
        session.walk.delete(cid);
        // Household ERRAND CLAIMS are the DECIDE loop's ledger, not the
        // pursuit's: a need-born trip (a provision buy) must HOLD its claim
        // across pursuit boundaries — released here at the take's completion,
        // a housemate would launch a duplicate trip while this one hauls home.
        // The decide loop claims on take and releases on any non-exclusive
        // decision, exactly as the legacy walker always has. A command has no
        // claim of its own — releasing just returns whatever a preempted need
        // episode held.
        if (pur.source === "command") releaseErrands(session, cid);
      };
      // GIVE-UP GUARD: a pursuit that keeps ACTING without ever completing (hands
      // already full so `pick` no-ops, an un-grabbable target) would crouch on the
      // same step forever. Cap discrete actions attempted per pursuit; over it,
      // part with the honest reason. Returns false (and ENDS the pursuit) when spent.
      const mayAct = (): boolean => {
        pur.acts = (pur.acts ?? 0) + 1;
        if (pur.acts > COMMAND_ACT_CAP) {
          clear();
          // A need-born pursuit parts SILENTLY — nobody ordered it, so there is
          // no one to answer; the want re-surfaces through the needs walker.
          if (pur.source === "command") {
            saySystem(session, pursuitBlockLine(pur.goal), `💬 "${pur.glyph}" — can't finish`, cid);
          } else {
            coolOff();
            console.log(`[needs] ${cid} pursuit ${pur.tplKey ?? pur.goal.kind} hit the act cap — dropped (cooling off)`);
          }
          return false;
        }
        return true;
      };
      // BUSY: the body is mid-crouch on the last action step — leave it be until
      // the hold clears (stepActionHolds), then re-plan from the updated world.
      if (session.actionHold.has(cid)) continue;
      const body = state.avatars[avatarIdOf(cid)];
      if (!body) {
        clear();
        continue;
      }
      const from = { x: body.x, y: body.y };
      // WALK TARGETS must be STANDABLE. An item ON a solid fixture (a banana on
      // the table) reports the fixture's CENTER as its position, which no body
      // can reach — it wedges on the fixture and never arrives. Nudge the
      // approach to clear ground beside it (nearestClearSpot, the same rule the
      // needs walker uses via standPointFor); pick/give act by objId from
      // wherever the body ends up, so a stand-beside spot is close enough.
      //
      // COMMIT the nudged spot per target (pur.stand): nearestClearSpot is
      // body-relative, so recomputing it each tick moves the target as the body
      // circles the furniture — which re-issues the routed errand every frame and
      // destroys the furniture doglegs before the body can walk them (the "grinds
      // straight into the table, never detours" bug). Cache keyed by the target's
      // raw position (0.5 m grid) so a putIn's item AND container each stay put;
      // the stall re-route clears the cache to replan from the new spot.
      const pursuerR = world.npcRadiusOf(avatarIdOf(cid));
      const standable = (raw: { x: number; y: number } | null) => {
        if (!raw) return null;
        if (standClear(state, raw, pursuerR)) return raw; // already reachable — body-independent, no commit needed
        const cache = (pur.stand ??= new Map<string, { x: number; y: number }>());
        const key = `${Math.round(raw.x * 2)}|${Math.round(raw.y * 2)}`;
        const hit = cache.get(key);
        if (hit) return hit;
        const spot = nearestClearSpot(state, raw, from, pursuerR);
        cache.set(key, spot);
        return spot;
      };
      const r: WorldResolver = {
        ...base,
        itemPosition: (id) => standable(base.itemPosition(id)),
        place: (p) => standable(base.place(p)),
        stationFor: (s) => standable(base.stationFor(s)), // a transform station is a solid box — stand beside it
        diningSpot: (self, kinds) => standable(base.diningSpot?.(self, kinds) ?? null), // the table is solid too
        colorStation: (self) => standable(base.colorStation?.(self) ?? null), // the tub is solid — stand beside it
        arrived: (self, pos) => {
          const b = state.avatars[avatarIdOf(self)];
          return !!b && Math.hypot(b.x - pos.x, b.y - pos.y) <= COMMAND_ARRIVE;
        },
      };
      const next = pursue(pur.goal, cid, r);
      if (next.kind === "done") {
        clear();
        continue;
      }
      if (next.kind === "blocked") {
        clear();
        // Commands answer their issuer; a need-born pursuit just drops — the
        // next needs decide re-evaluates fresh (and its own BLOCKED machinery
        // surfaces the want for adoption when nothing can serve it).
        if (pur.source === "command") {
          saySystem(session, pursuitBlockLine(pur.goal), `💬 "${pur.glyph}" — can't do that`, cid);
        } else {
          coolOff();
          console.log(`[needs] ${cid} pursuit ${pur.tplKey ?? pur.goal.kind} blocked mid-flight — back to the walker (cooling off)`);
        }
        continue;
      }
      if (next.kind === "move") {
        // THE ONE WALK: steer to the committed stand spot. On a genuine give-up
        // (unreachable after re-routes), do the pending action IN PLACE — the
        // effects work by objId from wherever the body stands (termination over
        // fidelity). onReroute drops the committed spots so the retry re-picks.
        const status = walkTo(session, cid, next.pos, dt, {
          arrive: COMMAND_ARRIVE,
          onReroute: () => {
            pur.stand?.clear();
            return null;
          },
        });
        if (status === "gaveup") {
          const action = (planGoal(pur.goal, cid, base)?.steps ?? []).find((s) => s.kind !== "moveTo");
          if (action) {
            if (!mayAct()) continue;
            pur.stand?.clear();
            beginAction(session, cid, `${pur.goal.kind} (in place)`, () => applyGoalStep(session, cid, action));
          } else {
            clear();
          }
        }
        continue;
      }
      // ARRIVED — CROUCH and perform the step here; `last` ⇒ that completes the
      // goal, so the pursuit ends once the crouch lands its effect. A non-last
      // step (a multi-step errand) resumes re-planning after the hold clears.
      if (!mayAct()) continue;
      session.walk.delete(cid);
      const step = next.step;
      const last = next.last;
      if (step.kind === "rest" || step.kind === "processStack") {
        // REST and the stack PROCESS are long POSED DWELLS, not 0.8 s crouches:
        // apply directly (each sets its own dwell errand + pose show), never
        // wrapped in beginAction (whose 0.8 s pin would cut the dwell short).
        applyGoalStep(session, cid, step);
        // A need-born rest CLEARS its motive's meter here (eat/converse clear
        // theirs inside their own effects — rest is the one dwell whose effect
        // IS the time spent, so the completion owns the clear; a process row's
        // drive is stock/mess-shaped, no meter to clear).
        if (step.kind === "rest" && pur.source === "need" && pur.tplKey) {
          session.needMeters.set(`${cid}|${pur.tplKey}`, 0);
        }
      } else {
        beginAction(session, cid, pur.goal.kind, () => applyGoalStep(session, cid, step));
      }
      if (last) clear();
    }
  }

  function stepNeeds(session: QuestSession, state: WorldState, dt: number, houseLoaded: (hi: number) => boolean) {
    const town = session.town;
    if (!town || !world) return;
    const seed = town.config.seed;
    // Every EMBODIED resident runs its needs — a body system, independent of whether the
    // dialogue world has registered the creature yet (that registration is chatter-paced
    // and conversation-gated; waiting on it made a freshly-robbed pantry look inert).
    // Live-but-evicted bodies still need their episode resolved, so sweep those too.
    // PETS run the same loop (one behavior model) with their species template rows.
    const cidSet = new Set<string>(session.liveNeedBodies);
    for (const id of Object.keys(state.avatars)) {
      if (id.startsWith("resident_") || id.startsWith("pet_")) cidSet.add(id);
    }
    // SORTED — the step order is the household ERRAND-CLAIM order (first to
    // act on a restock trip takes it), so it must not depend on the insertion
    // history of the live set. Sorting makes the same clock over the same
    // world claim identically on every peer (the multiplayer law the task pool
    // states: no RNG, pure over (task, candidates)).
    const cids = [...cidSet].sort();
    for (const cid of cids) {
      // SOFT CONTROL (attention-spark.md): consume the "spark promoted this body
      // to a chore this frame" flag — its chosen pursuit ANNOUNCES below (a
      // stock/mess chore doesn't fire via the meter, so `sparkTriggered` can't
      // flag it). Read once per decide, so it never lingers.
      const wasSparkActing = session.sparkActing.delete(cid);
      // CAPABILITY: a graspless body (a pet) cannot work doors — mark its body so
      // `tickDoors` never lets it OPEN one (it may still pass a door another left
      // open). Residents/townsfolk have hands and default to opening.
      const capBody = state.avatars[avatarIdOf(cid)];
      if (capBody) capBody.canOpen = !isPetCid(cid);
      // RECRUITED members follow the player, and a body running a spoken COMMAND
      // (queued goal errands — the dollhouse's direct obedience) finishes it first:
      // needs and schedule are suspended for both. The LIVE flag is KEPT (§4 fix —
      // hands must be emptied on every exit): a mid-errand hauler or a gifted
      // follower resumes its episode the moment the interruption ends, so the
      // carried stack gets deposited or banked (DEMOTE) instead of riding the
      // hands forever.
      if (
        session.party.has(cid) ||
        (session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0 ||
        session.pursuits.get(cid)?.source === "command" // obeying a spoken errand — stepPursuit owns it
      ) {
        // Recruited/tasked MID-pursuit: a NEED-born pursuit yields (exactly as
        // needStep is dropped) — a command-born one survives, it IS the order.
        if (session.pursuits.get(cid)?.source === "need") session.pursuits.delete(cid);
        session.needStep.delete(cid);
        releaseErrands(session, cid); // following/obeying — not shopping
        continue;
      }
      // BUSY: crouched on a discrete action (a take from the pantry, a deposit).
      // The step already fired beginAction and cleared needStep; leave the body
      // pinned and DON'T reclaim/re-decide until the crouch lands its effect.
      if (session.actionHold.has(cid)) continue;
      // ── RECLAIM A PHYSICAL CARRY ────────────────────────────────────────
      // THE ONE-WAY DOOR (playtest: authored spec items "picked up and carried
      // forever"). There are two carry models: the physical `ObjectState.
      // carriedBy` and the abstract `needCarried` stack. Only the stack is
      // visible to the needs walker — and `carriedBy` ALSO removes the prop
      // from every `loose` candidate list (`o.carriedBy` is skipped). So a
      // commanded "get the ball" parked the ball in a hand that no rule could
      // reach: never eaten, never tidied, never dropped. Unlike the hand-over
      // paths, the `pick` goal step has no paired `dropObject`.
      //
      // The seam is exactly the user's own rule — get rid of what you hold
      // "unless you are using, wearing, or TRANSPORTING it". A body that has
      // reached this line is not transporting: it holds no command and is not
      // in the party (the guard above `continue`d those). So the item is
      // handed to the needs layer, which then owns it properly: hunger EATS a
      // held apple, unload puts a held ball away or sets it down.
      //
      // Only real registered props are reclaimed — the display prop
      // `syncNeedCarryProps` hangs on a carrying body is in neither
      // `smallProps` nor the creature world, exactly so it can't be mistaken
      // for a real instance, and this lookup preserves that.
      if (!session.pursuits.has(cid)) {
        // (A body driving a NEED pursuit is TRANSPORTING — the carry belongs to
        // its plan; reclaiming it here would confiscate the apple en route to
        // the table. The pursuit's own endings hand any orphan back: a blocked
        // pursuit clears, and THIS reclaim absorbs the prop next tick.)
        // Scan for a carried object that is a REAL registered prop, rather
        // than taking whatever `npcCarrying` happens to return first: a body
        // mid-carry also wears the display prop, and picking that one would
        // skip the real item for the tick.
        const bodyId = avatarIdOf(cid);
        let heldObjId: string | undefined;
        let heldRec: { entityId: string; glyph: string; at?: number } | undefined;
        for (const [objId, rec] of session.smallProps) {
          if (state.objects[objId]?.carriedBy === bodyId) {
            heldObjId = objId;
            heldRec = rec;
            break;
          }
        }
        if (heldObjId && heldRec) {
          const bag = session.needCarried.get(cid) ?? {};
          bag[heldRec.glyph] = (bag[heldRec.glyph] ?? 0) + 1;
          session.needCarried.set(cid, bag);
          world.removeObject(heldObjId);
          session.smallProps.delete(heldObjId);
          if (session.creatures) delete session.creatures.world.items[heldRec.entityId];
          session.liveNeedBodies.add(cid); // the walker owns this body now
          session.needStep.delete(cid); // re-decide with the item in hand
          console.log(`[needs] ${cid} RECLAIMED a physically-carried ${heldRec.glyph} into its hands`);
        }
      }
      const houseIndex = Number(cid.split("_")[1]);
      const member = Number(cid.split("_")[2]);
      const house = residentTownCtx(session, houseIndex)?.house; // neighbor-aware
      if (!house) continue;
      const pet = isPetCid(cid);
      if (pet) ensurePetCreature(session, cid); // grasp:false must exist before ctx resolution
      const templates = pet ? petNeedTemplates(session) : residentNeedTemplates(session, houseIndex, house, member);
      // Dollhouse members run the dress row — pin down WHAT they spawned
      // wearing so the first change of clothes doffs that garment.
      if (!pet && session.dollhouse === houseIndex) seedWorn(session, cid, member);
      const shown = houseLoaded(houseIndex);
      const live = session.liveNeedBodies.has(cid);
      if (!shown && !live) {
        // SCHEDULED: un-ticked. Meters drop so a later load re-seeds from the schedule.
        for (const tpl of templates) session.needMeters.delete(`${cid}|${tpl.key}`);
        session.needStep.delete(cid);
        continue;
      }
      const body = state.avatars[cid];
      if (!body) {
        // EVICTED mid-episode (the player left; the streaming un-embodied it): the
        // off-screen world is the schedule's domain, so complete the episode
        // ABSTRACTLY — carried units land in the home box, the body's pending step is
        // dropped, and the clock re-anchors to the result. No zombie live state.
        if (live) {
          session.needStep.delete(cid);
          session.pursuits.delete(cid); // an evicted body's pursuit dies with it
          session.liveNeedBodies.delete(cid);
          releaseErrands(session, cid); // an evicted body can't finish the errand
          bankCarried(session, cid, houseIndex);
          reanchorHouseGoods(session, houseIndex);
        }
        continue;
      }
      // Tick meters only while ON SHOW (off-show the schedule's drain stands in).
      // Seeds: hunger from the meal schedule; other motives from a hash spread, so
      // a freshly-revealed household isn't all at zero (or all in sync).
      if (shown) {
        for (const tpl of templates) {
          if (tpl.drive.kind !== "meter") continue;
          const k = `${cid}|${tpl.key}`;
          if (!session.needMeters.has(k)) {
            session.needMeters.set(
              k,
              tpl.key.startsWith("hunger")
                ? scheduledHunger(mealOffset(seed, houseIndex, member), session.townClock)
                : (mealOffset(seed, houseIndex, member * 7 + tpl.key.length) / MEAL_PERIOD_SEC) * 0.7,
            );
          }
          session.needMeters.set(k, (session.needMeters.get(k) ?? 0) + tpl.drive.rate * dt);
        }
        // DERIVED STRESS (mood.ts): needs held PAST firing exert pressure;
        // stress integrates it and bleeds off while content. Pure derivation —
        // the invariant tests lean on it (equipped house flat, stripped house
        // climbing), so nothing here may special-case a motive.
        const levels: number[] = [];
        for (const tpl of templates) {
          if (tpl.drive.kind === "meter") {
            levels.push((session.needMeters.get(`${cid}|${tpl.key}`) ?? 0) / tpl.drive.threshold);
          }
        }
        session.stress.set(cid, stressStep(session.stress.get(cid) ?? 0, needPressure(levels), dt));
      }
      // A NEED-BORN PURSUIT owns the body (S2): stepPursuit drives it; meters
      // keep rising above so the next want is honest. No deciding, no needStep —
      // when the pursuit ends (done / blocked / dropped), this loop resumes on
      // the very next tick and re-decides from the fresh world.
      if (session.pursuits.get(cid)?.source === "need") continue;
      // ENTER live only while the member's schedule is idle — a body out on a clock
      // trip, or mid-SHIFT at its workplace, stays schedule-driven (needs wait for
      // after work). Once promoted, the loop owns the body until demote. An ON-SHOW
      // house never defers to the shop clock: the schedule projects no trips there
      // (residents.ts §13 rule) — the live loop IS the household's shopping.
      // Pets hold no duties — no clock gates apply.
      const runnerGood = pet ? undefined : residentShopGoods(session, houseIndex, member);
      if (!live && !shown && runnerGood && runnerGood.errand(house, session.townClock).phase !== "home") {
        session.needStep.delete(cid);
        continue;
      }
      const shiftDuty = pet ? undefined : residentJobDuty(session, houseIndex, member);
      if (!live && shiftDuty && inShiftWindow(shiftDuty.window, session.townClock, FOOD_DAY_SEC)) {
        session.needStep.delete(cid);
        continue;
      }
      // Progress an active step: still walking, or ARRIVED → apply its effect, re-decide.
      const step = session.needStep.get(cid);
      if (step) {
        // THE ONE WALK: steer to the step's stand spot (same primitive commands
        // run). A stall RE-ROUTES from where the body stands, re-picking the
        // stand spot — the original faced the body's decision-time position, and
        // a walk that wrapped a fixture can strand it on the blocked side (the
        // bed/wall pin). A claimed SEAT is released first (§3.3): the chair
        // approach may be exactly what's stuck; the table edge always serves.
        const status = walkTo(session, cid, step.pos, dt, {
          onReroute: () => {
            console.log(`[needs] ${cid} stalled en route to ${step.objId ?? "?"} — re-routing`);
            if (step.objId) {
              delete step.seatId;
              const raw = needObjectPos(session, state, houseIndex, step.objId);
              if (raw) step.pos = standPointFor(state, step.objId, raw, { x: body.x, y: body.y }, world?.npcRadiusOf(avatarIdOf(cid)));
            }
            return step.pos;
          },
        });
        if (status === "gaveup") {
          // GIVE UP (termination over fidelity): the spot is unreachable — ARRIVE
          // IN PLACE. The elemental effects work by objId from wherever the body
          // stands (a rest dozes here). PIN the body so the stale aim can't drag
          // it around mid-animation, and never slide onto the far fixture.
          console.log(`[needs] ${cid} give-up en route to ${step.objId ?? "?"} — arriving in place`);
          step.pos = { x: body.x, y: body.y };
          step.anchorId = null;
          world.setNpcErrand(cid, {
            points: [
              {
                x: body.x,
                y: body.y,
                dwell: (step.kind === "rest" || step.kind === "process" ? restDwellFor(step.tplKey, session.scale) : 1.1) + 3,
              },
            ],
          });
          continue;
        }
        if (status === "arriving") continue;
        // ARRIVED. REST-shaped needs dwell at the spot before their meter clears
        // (asleep at the bed; playing at the box; scrubbing in the bath; the
        // privy); everything else applies its elemental effect at once.
        if (step.kind === "rest") {
          step.dwell = (step.dwell ?? restDwellFor(step.tplKey, session.scale)) - dt;
          if (step.dwell > 0) continue; // sleeping / playing / washing
          session.needStep.delete(cid);
          session.needMeters.set(`${cid}|${step.tplKey}`, 0);
          showWorldBubble(state, `rest:${cid}`, {
            anchor: { kind: "avatar", id: cid },
            text: restDoneEmoji(step.tplKey),
            ttl: 2,
          });
          console.log(`[needs] ${cid} finished ${step.tplKey} (${step.objId ?? "in place"})`);
          continue;
        }
        if (step.kind === "process") {
          // The scrub at the tub: dwell it out, then the transform's facet
          // edit lands on the carried units (dirty shirts come out clean).
          step.dwell = (step.dwell ?? restDwellFor(step.tplKey, session.scale)) - dt;
          if (step.dwell > 0) continue;
          session.needStep.delete(cid);
          applyNeedStepEffect(session, state, cid, step);
          continue;
        }
        if (step.kind === "socialize") {
          session.needStep.delete(cid);
          const pid = step.objId ?? "";
          const pav = chatAvatar(state, pid);
          // Partner still here → a REAL exchange (gossip spreads, relations warm),
          // both loneliness meters clear. Wandered off → re-decide next frame.
          // A PET on either side skips the gossip (no dialogue engine) — company
          // itself is the exchange: hearts, warmth, both meters clear.
          if (pav && Math.hypot(pav.x - body.x, pav.y - body.y) <= 3.5) {
            if (isPetCid(cid) || isPetCid(pid)) {
              showWorldBubble(state, `social:${cid}`, { anchor: { kind: "avatar", id: cid }, text: "💗", ttl: 2 });
            } else {
              runNpcExchange(session, cid, pid);
            }
            session.needMeters.set(`${cid}|${step.tplKey}`, 0);
            session.needMeters.set(`${pid}|social`, 0);
            warmRelations(session, cid, pid, { affinity: 0.05, trust: 0.02 });
            console.log(`[needs] ${cid} socialized with ${pid}`);
          }
          continue;
        }
        // CROUCH to perform the take / deposit / equip: the elemental effect
        // lands at the crouch MIDPOINT (stepActionHolds) with the body pinned,
        // so it never applies mid-stride (the "moving while using" bug). Clear
        // needStep now; the busy-guard above holds re-decide until the crouch
        // ends, then the walker re-decides from the updated world.
        session.needStep.delete(cid);
        const arrived = step;
        beginAction(session, cid, `${arrived.kind}:${arrived.tplKey}`, () =>
          applyNeedStepEffect(session, state, cid, arrived),
        );
        continue;
      }
      // A SHOW still playing OWNS the body (the meal's sit at its chair, a
      // commanded pose): deciding the next step now issues a fresh errand and
      // walks the body off mid-animation — the observed "does the action while
      // walking around". The dwell waypoint is already holding it; decide when
      // the show ends. (Both show maps tick down in syncNeedActivities, called
      // in the same frame block as this walker — no stall risk.)
      if (session.needEatShow.has(cid) || session.needPoseShow.has(cid)) continue;
      // DECIDE from live state (the shared template walker), then drive the body.
      const decided = decideNeeds(templates, (tpl) => residentNeedCtx(session, state, cid, houseIndex, tpl, templates));
      // THE CLAIM: acting on a household-exclusive errand (a restock trip)
      // takes it, so the housemates deciding after this one in the same tick
      // read `claimed: "other"` and stay home. Anything else this body decides
      // to do releases whatever it held — the errand goes back in the pool for
      // someone else rather than being held by a body that wandered off to
      // sleep. Claiming on ACT (not on ctx resolution) is what keeps it
      // deterministic: the member order below is the claim order.
      if (decided?.tpl.exclusive && decided.intent.kind === "take") {
        claimErrand(session, houseIndex, decided.tpl.key, cid);
      } else if (!decided?.tpl.exclusive) {
        releaseErrands(session, cid);
      }
      // SURFACE the unmet want for ADOPTION: the top firing need decided BLOCKED
      // (a graspless pet at a lidded pantry, an empty world). Housemates read
      // this book (adoptionTemplates); anything else clears the entry — and a
      // served want also releases any standing "help X" orders aimed at it.
      if (decided?.intent.kind === "blocked" && !decided.tpl.key.startsWith("adopt:")) {
        const at = decided.tpl.satisfy.kind === "consume" ? (decided.tpl.satisfy.at ?? ["table"]) : [];
        session.blockedNeeds.set(cid, {
          tplKey: decided.tpl.key,
          goodKey: decided.tpl.item.category ?? "",
          at,
          priority: decided.tpl.priority,
        });
      } else {
        if (session.blockedNeeds.delete(cid)) {
          for (const [helper, wanter] of session.helpOrders) {
            if (wanter === cid) session.helpOrders.delete(helper);
          }
        }
      }
      if (!decided) {
        if (live) {
          // DEMOTE: the disruption is neutralized — hand the household back to the
          // clock. HANDS MUST BE EMPTY on this exit (§4 fix — "nothing fires" is
          // not "nothing to finish" when a stack is still in hand: a treat no
          // row projects, a good with no deposit row): bank the carried units
          // into the house boxes BEFORE the clock re-anchors, or the haul is
          // erased from the economy's books while physically in hand.
          const banked = bankCarried(session, cid, houseIndex);
          session.liveNeedBodies.delete(cid);
          releaseErrands(session, cid); // the errand goes back in the pool
          // With the interior dark the chests are final: re-anchor now; on show
          // the UNLOAD edge owns it (the chests stay the live truth while visible).
          if (!shown) reanchorHouseGoods(session, houseIndex);
          // A schedule body belongs AT HOME between trips: an episode that ended
          // out in the town (a command, a market run) walks back — the clock's
          // next trip starts from there, so nobody is left parked in the street.
          walkResidentHome(session, state, cid);
          console.log(
            `[needs] ${cid} DEMOTED (nothing fires${banked ? `; banked ${banked} carried` : ""}${shown ? "" : "; re-anchored"})`,
          );
        } else {
          // NEVER-PROMOTED idle body away from home — a finished spoken command
          // ("go to the market", a fetch) parked it there and no meter fires to
          // reclaim it. After a short grace it walks back on its own (the walk
          // is a no-op when already home).
          const t = (session.idleAway.get(cid) ?? 0) + dt;
          if (t >= HOME_IDLE_GRACE_S) {
            session.idleAway.delete(cid);
            walkResidentHome(session, state, cid);
          } else {
            session.idleAway.set(cid, t);
          }
        }
        continue;
      }
      session.idleAway.delete(cid);
      const { tpl, intent } = decided;
      // blocked: an unmet want — surfaces through dialogue, re-checked next frame (a
      // player putting food in the chest un-blocks it, live). idle can't reach here
      // (decideNeeds only returns firing needs). One-shot diagnostic per block episode.
      const blockKey = `needs:blocked:${cid}|${tpl.key}`;
      if (intent.kind === "blocked" || intent.kind === "idle") {
        if (intent.kind === "blocked") {
          // A blocked need can't be served — the live loop must NOT keep the
          // body (it would suppress the clock feed forever, the "left standing
          // in the street" bug). DEMOTE and walk home; the want keeps surfacing
          // through dialogue and re-promotes the moment it becomes servable.
          if (live) {
            session.liveNeedBodies.delete(cid);
            if (!shown) reanchorHouseGoods(session, houseIndex);
          }
          if (!session.dlogged.has(blockKey)) {
            session.dlogged.add(blockKey);
            walkResidentHome(session, state, cid);
            // The BEG, visible: the unreachable want shows over the head once
            // per block episode (a pet at an empty bowl pleads for food).
            if (shown && tpl.item.category) {
              showWorldBubble(state, `beg:${cid}`, {
                anchor: { kind: "avatar", id: cid },
                text: "🥺",
                glyph: kindsOf(tpl.item.category)[0],
                ttl: 3,
              });
            }
            console.log(`[needs] ${cid} BLOCKED on ${tpl.key} (no acquire branch can supply) — sent home`);
          }
        }
        continue;
      }
      session.dlogged.delete(blockKey);
      // SOFT CONTROL (attention-spark.md): this need fired only because the
      // spark's attention pushed a still-climbing meter over — the player
      // nudged it, so the creature ANNOUNCES its intent before acting (routine
      // self-directed needs stay quiet). Detected here so any downstream action
      // path (pursuit or legacy) can flag it.
      const sparkTriggered =
        tpl.drive.kind === "meter" &&
        (session.needMeters.get(`${cid}|${tpl.key}`) ?? 0) < tpl.drive.threshold &&
        attentionBonus(session.sparkDraw, session.sparkFocus, cid, tpl.key) > 0;
      // ── S2: THE SELF-ASSIGNED COMMAND ─────────────────────────────────────
      // The clean motives ride the unified pursuit engine: map the decided
      // (template, intent) to GoalSpec candidates (need-goals.ts) and install
      // the first that COMPILES as a `source: "need"` pursuit — the same loop a
      // spoken order runs. A candidate that can't compile falls through to the
      // legacy walker THIS tick (the degradation seam: market shelves and the
      // well are invisible to the item resolver until S3, so those trips —
      // restock sizing, purse accounting — stay on the stack machinery).
      if (NEED_PURSUITS_ENABLED && (session.needPursuitCooldown.get(`${cid}|${tpl.key}`) ?? 0) <= session.townClock) {
        const bag = session.needCarried.get(cid) ?? {};
        const carriedMatching =
          tpl.satisfy.kind === "consume" && tpl.item.category
            ? [
                ...(tpl.item.category === "food" ? carryKindsOf("meal") : []),
                ...carryKindsOf(tpl.item.category),
              ].reduce((s, k) => s + (bag[k] ?? 0), 0)
            : 0;
        const candidates = needPursuitGoals(tpl, intent, {
          carriedMatching,
          restDwellS: restDwellFor(tpl.key, session.scale),
          body: { x: body.x, y: body.y },
        });
        if (candidates.length > 0) {
          const nr = makeGoalResolver(session, cid); // NEED-scoped: own household + arm's reach
          const goal = candidates.find((g) => compileGoal(g, cid, nr));
          if (goal) {
            if (!session.liveNeedBodies.has(cid)) console.log(`[needs] ${cid} PROMOTED to live (${tpl.key} → pursuit)`);
            session.liveNeedBodies.add(cid);
            session.needStep.delete(cid);
            session.walk.delete(cid); // the pursuit starts its walk fresh
            session.pursuits.set(cid, { source: "need", tplKey: tpl.key, goal, glyph: tpl.key });
            if (sparkTriggered || wasSparkActing) announceSparkIntent(session, cid, goal);
            console.log(`[needs] ${cid} pursuit: ${goal.kind} (${tpl.key})`);
            continue;
          }
        }
      }
      const goodKey = tpl.item.category ?? "";
      if (intent.kind === "consumeHere") {
        applyNeedStepEffect(session, state, cid, { tplKey: tpl.key, kind: "consume", goodKey, units: 1 });
        continue;
      }
      if (intent.kind === "equipHere") {
        // The change of clothes happens where the body stands (usually right
        // beside the wardrobe the take step just walked it to).
        applyNeedStepEffect(session, state, cid, { tplKey: tpl.key, kind: "equip", goodKey, units: 1 });
        continue;
      }
      if (intent.kind === "dropHere") {
        // NOWHERE TO PUT IT AWAY — set it down where the body stands. The
        // units leave the hands and become real loose props on the floor, so
        // they are findable again (the fun row's toy, the tidy chore's
        // clutter) instead of vanishing into an abstract stack.
        applyNeedStepEffect(session, state, cid, {
          tplKey: tpl.key,
          kind: "drop",
          goodKey,
          units: intent.units,
        });
        continue;
      }
      if (intent.kind === "restHere") {
        // No bed — doze where it stands (the arrive branch dwells it out).
        // PIN the body: with no errand the controller WANDERS, dragging the
        // sleeper off the dwell spot and stretching the nap (the countdown
        // only runs within arrival range) — a dwell waypoint holds it still.
        session.liveNeedBodies.add(cid);
        session.needStep.set(cid, { tplKey: tpl.key, kind: "rest", goodKey, pos: { x: body.x, y: body.y }, units: 1 });
        world.setNpcErrand(cid, {
          points: [{ x: body.x, y: body.y, dwell: restDwellFor(tpl.key, session.scale) + 3 }],
        });
        continue;
      }
      const target = intent.kind === "take" ? intent.from : intent.kind === "deposit" ? intent.into : intent.station;
      // A meal at the TABLE is eaten from a CHAIR when a free one is pulled up
      // (§3.3): the seat becomes the stand point and the step records the claim
      // — freeSeatAt reads other steps' seatIds, so no two diners share one.
      // Chairs are PASSTHROUGH fixtures, so the chair's own center is standable.
      const seat =
        intent.kind === "consumeAt" && intent.station.kind === "table"
          ? freeSeatAt(session, state, cid, intent.station.id)
          : null;
      // A social partner is a CREATURE — walk to where it stands now (drifted?
      // the arrival check re-verifies and re-decides); furniture resolves by id.
      const pos = seat
        ? // The chair is tucked at the table (beside-anchor): its centre sits
          // just INSIDE the table's no-stand box (0.8 + 0.22 + 0.1 = 1.12 < the
          // 1.2 body box), so approaching the raw chair centre grinds into the
          // tabletop ("stuck reaching the consume point"). Nudge to a standable
          // spot off the table edge — the SIT show still slides the body onto
          // the seat (seatId), so it dines at the chair all the same.
          nearestClearSpot(state, { x: seat.x, y: seat.y }, { x: body.x, y: body.y }, world.npcRadiusOf(avatarIdOf(cid)))
        : intent.kind === "socialize"
          ? (() => {
              const pav = chatAvatar(state, target.id);
              return pav ? { x: pav.x, y: pav.y } : null;
            })()
          : (() => {
              // Solid fixtures (beds/tables/chests) are unreachable at their
              // CENTER — walk to the stand-beside spot instead (standPointFor).
              const raw = needObjectPos(session, state, houseIndex, target.id);
              return raw ? standPointFor(state, target.id, raw, { x: body.x, y: body.y }, world.npcRadiusOf(avatarIdOf(cid))) : null;
            })();
      if (!pos) continue;
      if (!session.liveNeedBodies.has(cid)) console.log(`[needs] ${cid} PROMOTED to live (${tpl.key})`);
      console.log(`[needs] ${cid} step: ${intent.kind} ${goodKey || tpl.key} @ ${target.id}`);
      session.liveNeedBodies.add(cid);
      session.needStep.set(cid, {
        tplKey: tpl.key,
        kind:
          intent.kind === "consumeAt"
            ? "consume"
            : intent.kind === "restAt"
              ? "rest"
              : intent.kind === "processAt"
                ? "process"
                : intent.kind,
        goodKey,
        ...(tpl.item.affords ? { affords: tpl.item.affords } : {}),
        objId: target.id,
        pos,
        ...(seat ? { seatId: seat.id } : {}),
        units: intent.kind === "take" || intent.kind === "deposit" ? intent.units : 1,
        // A transform step carries its facet edit (the wash's drop:"dirty").
        ...(intent.kind === "processAt" && tpl.satisfy.kind === "transform"
          ? {
              proc: {
                ...(tpl.satisfy.drop ? { drop: tpl.satisfy.drop } : {}),
                ...(tpl.satisfy.add ? { add: tpl.satisfy.add } : {}),
              },
            }
          : {}),
      });
      // REST legs end in a DWELL waypoint — the controller holds the sleeper
      // still for the nap (otherwise the errand clears on arrival and the
      // wander behavior drags the body off the dwell spot, stretching the
      // countdown, which only runs within arrival range).
      const legs = doorRouteErrand(state, { x: body.x, y: body.y }, { points: [pos] }, world.npcRadiusOf(avatarIdOf(cid)));
      if (intent.kind === "restAt" || intent.kind === "processAt") {
        const last = legs.points[legs.points.length - 1];
        if (last) last.dwell = restDwellFor(tpl.key, session.scale) + 3;
      } else if (intent.kind === "take" || intent.kind === "deposit") {
        // A beat at the box while the reach rig plays (syncNeedCarryProps) —
        // taking from and stowing into containers should be SEEN, not teleported.
        const last = legs.points[legs.points.length - 1];
        if (last) last.dwell = 1.1;
      } else if (intent.kind === "consumeAt") {
        // The MEAL is eaten sitting still. The consume effect is instant but
        // SHOWS for EAT_SHOW_S (needEatShow → the eat rig); without a dwell the
        // errand completes on arrival and wanderAim grabs the body on the very
        // next frame, so the diner spun away mid-bite and drifted back to
        // re-decide — the "creatures take forever to eat at a table" bug. Padded
        // like the rest legs: the needs loop counts arrival at 1.3 while the
        // controller only reaches its point at ERRAND_ARRIVE 0.9.
        const last = legs.points[legs.points.length - 1];
        if (last) last.dwell = EAT_SHOW_S + 1;
      }
      session.lastDrive.set(cid, `needs:${tpl.key}`);
      world.setNpcErrand(cid, legs);
      // SEED the walk state to the leg just issued (with its dwell tail): walkTo
      // then treats this as the committed leg and won't re-issue a plain errand
      // over it on the next tick — it only watches motion and re-routes on a
      // genuine stall, exactly as the old inline stall watch did.
      session.walk.set(cid, { tx: pos.x, ty: pos.y, ax: body.x, ay: body.y, stuckT: 0, reroutes: 0 });
    }
  }

  /** Mirror each resident's need state onto the DISPLAY-ONLY body-activity channel
   *  (AvatarState.activity — engine.ts): a rest step counting down its dwell shows as
   *  SLEEP (with the bed's objId, so the 3D view lies the body ON the bed) or PLAY
   *  (fun, at the box); a just-applied consume shows a brief EAT (needEatShow).
   *  Everything else clears. The sim never reads the field; the 3D view's creature
   *  bodies pose from it and the 2D view ignores it. */
  function syncNeedActivities(session: QuestSession, state: WorldState, dt: number) {
    for (const [cid, show] of session.needEatShow) {
      show.t -= dt;
      if (show.t <= 0) session.needEatShow.delete(cid);
    }
    for (const [cid, show] of session.needPoseShow) {
      show.t -= dt;
      if (show.t <= 0) session.needPoseShow.delete(cid);
    }
    for (const [id, av] of Object.entries(state.avatars)) {
      if (!id.startsWith("resident_") && !id.startsWith("pet_")) continue;
      const cidForHold = creatureOfAvatar(id) ?? id;
      // A body mid ACTION HOLD crouches (the "sit" rig) for the whole beat — the
      // reach/carry gesture the effect fires plays over it, so the action and its
      // animation are welded and the body is visibly stationary. Highest priority.
      if (session.actionHold.has(id) || session.actionHold.has(cidForHold)) {
        av.activity = { kind: "sit" };
        continue;
      }
      const step = session.needStep.get(id);
      let act: AvatarActivity | undefined;
      // A rest step's dwell only counts down while the body is AT the spot
      // (arrival range mirrors stepNeeds) — the activity shows exactly then.
      // Fun plays, the bath and privy SIT (the crouch rig), everything else sleeps.
      if (
        (step?.kind === "rest" || step?.kind === "process") &&
        step.dwell !== undefined &&
        step.dwell > 0 &&
        Math.hypot(av.x - step.pos.x, av.y - step.pos.y) <= 1.3
      ) {
        // The anchor decision is made ONCE per step episode (sticky): a body
        // that honestly walked its errand anchors — the stand ring puts it
        // 1.5–2.1 m from a double bed's CENTER and the follower brakes up to
        // 0.9 short, so the edge-relative cap is generous (the eased slide
        // absorbs it). Only a stall GIVE-UP (which fixed anchorId to null
        // already) performs in place — that was the real teleport case. A
        // per-frame gate here flapped at its boundary: the sleeper jerked
        // on/off the bed as the activity restarted every few frames.
        if (step.anchorId === undefined) {
          const o = step.objId ? state.objects[step.objId] : undefined;
          const spec = o ? state.spec.objects.find((s) => s.id === step.objId) : undefined;
          step.anchorId =
            o && spec && Math.hypot(av.x - o.x, av.y - o.y) <= spec.radius + 2.2 ? step.objId! : null;
        }
        const objId = step.anchorId ?? undefined;
        act =
          step.tplKey === "fun"
            ? { kind: "play", objId }
            : step.tplKey === "hygiene" || step.tplKey === "waste" || step.kind === "process"
              ? { kind: "sit", objId } // the crouch — scrubbing at the tub
              : { kind: "sleep", objId };
      } else {
        const eat = session.needEatShow.get(id);
        const pose = session.needPoseShow.get(id);
        // A meal eaten from a claimed chair (§3.3) shows as a SIT anchored on
        // the seat — resolveActivityAnchor slides the body onto it, facing the
        // table the chair faces. A standing meal keeps the eat rig. The seat
        // was gated ONCE when the show was created (the diner stood at the
        // chair) — never re-gated per frame here, so it can't flap.
        if (eat) {
          act = eat.seatId ? { kind: "sit", objId: eat.seatId } : { kind: "eat", objId: eat.objId };
        }
        else if (pose) {
          // A commanded pose ("you sit") shows once the body reaches its
          // station (or immediately, posing in place).
          const st = pose.objId ? state.objects[pose.objId] : undefined;
          if (!st || Math.hypot(av.x - st.x, av.y - st.y) <= 1.6) {
            act = { kind: pose.kind, objId: pose.objId };
          }
        }
      }
      if (act) av.activity = act;
      else if (av.activity) delete av.activity;
    }
  }

  /** ONE VISUAL PROP rides each needs-walking body that carries stack units —
   *  reconciled from `needCarried` every tick, so every path (takes, deposits,
   *  consumes, equips, washes, evictions) stays covered without per-effect
   *  hooks. The prop is registered NOWHERE else (no smallProps entry, no
   *  creature-world entity), so fetch/tidy/dialogue can never mistake the
   *  display for a real loose instance. Appearing fires the PICKUP gesture
   *  (reach → grasp → lift, then the held carry pose while walking — the
   *  creature-lab rig); emptied hands fire PUTDOWN (lower → release). */
  function syncNeedCarryProps(session: QuestSession, state: WorldState) {
    if (!world) return;
    const repGlyph = (cid: string): string | null => {
      const carried = session.needCarried.get(cid);
      if (!carried) return null;
      // Prefer what the ACTIVE errand is about (its good's kinds) so the shown
      // item matches the trip; else the biggest stack in hand.
      const goodKey = session.needStep.get(cid)?.goodKey;
      if (goodKey) {
        for (const k of carryKindsOf(goodKey)) {
          if ((carried[k] ?? 0) > 0) return k;
        }
      }
      let best: string | null = null;
      for (const [k, n] of Object.entries(carried)) {
        if (n > 0 && (best === null || n > (carried[best] ?? 0))) best = k;
      }
      return best;
    };
    // Sweep stale props: emptied hands (putdown plays), swapped goods (the
    // washed shirt replaces the dirty one below), evicted bodies — and
    // COMMANDED bodies, whose spoken-order machinery carries REAL props
    // (`npcCarrying` must not find this visual one and refuse the pick).
    for (const [cid, rec] of [...session.needProps]) {
      const commanded = (session.npcTasks.get(cid)?.length ?? 0) > 0;
      const glyph = state.avatars[cid] && !commanded ? repGlyph(cid) : null;
      if (glyph === rec.glyph) continue;
      world.removeObject(rec.objId);
      session.needProps.delete(cid);
      if (glyph === null) {
        const av = state.avatars[cid];
        if (av) {
          av.gesture = {
            kind: "putdown",
            targetX: av.x + av.fx,
            targetY: av.y + av.fy,
            holdS: 0,
            id: ++gestureSeq,
          };
        }
      }
    }
    // Dress every carrying body that lacks its prop (commanded bodies excepted).
    for (const [id, av] of Object.entries(state.avatars)) {
      if (!id.startsWith("resident_") && !id.startsWith("pet_")) continue;
      if (session.needProps.has(id)) continue;
      if ((session.npcTasks.get(id)?.length ?? 0) > 0) continue;
      const glyph = repGlyph(id);
      if (!glyph) continue;
      const objId = `needprop:${id}`;
      world.addObject({ id: objId, x: av.x, y: av.y, shape: "sphere", radius: 0.28, interactions: ["carry"], glyph });
      carryObject(state, objId, id);
      session.needProps.set(id, { objId, glyph });
      // The reach aims where the body faces — it just turned to the box/floor
      // spot the unit came from. A mid-carry pickup no-ops (glyph swaps only).
      av.gesture = {
        kind: "pickup",
        targetX: av.x + av.fx,
        targetY: av.y + av.fy,
        holdS: 0,
        id: ++gestureSeq,
      };
    }
  }

  /** The need templates a household member runs: HUNGER (food) for everyone; the RUNNER
   *  of a good also PROVISIONS the house box for it — the shopping errand as a need,
   *  thresholded at the same surplus buffer that paces the scheduled clock. Templates
   *  are DATA (needs.ts); a new good/need is a new row here, not new machinery. */
  function residentNeedTemplates(session: QuestSession, houseIndex: number, house: TownHouse, member: number): NeedTemplate[] {
    const goods = residentTownCtx(session, houseIndex)!.goods; // the OWNING town's books
    const rate = (k: Parameters<typeof needRate>[1]) => needRate(session.scale, k);
    const out: NeedTemplate[] = [];
    if (goods.some((g) => g.good.key === "food")) out.push(hungerTemplate("food", rate("hunger")));
    // WATER DUTY / COOK DUTY — the roster picks (unchanged): the first member
    // with no street-good errand bears water; the next duty-free one after it
    // cooks, never the roster's food shopper. Computed UP FRONT because the
    // restock rows below must exclude the cook (see the invariant there).
    let waterDuty = 0;
    for (let m = 0; m < HOUSEHOLD; m++) {
      if (!residentShopGoods(session, houseIndex, m)) { waterDuty = m; break; }
    }
    let cookDuty = -1;
    for (let m = 0; m < HOUSEHOLD; m++) {
      if (m === waterDuty) continue;
      if (residentShopGoods(session, houseIndex, m)?.good.key !== "food") { cookDuty = m; break; }
    }
    const cook = cookDuty >= 0 ? cookDuty : waterDuty;
    // RESTOCKING IS OPEN TO THE WHOLE HOUSE, CLAIMED BY ONE. Every member
    // carries a provision row for every street good — an empty pantry is the
    // household's problem, not the roster duty-holder's alone (the old rule
    // left four members with no restock row at all, so their only strategy
    // was a single-unit store trip each time they got hungry). `exclusive`
    // then keeps exactly one body on the errand at a time, so the family
    // doesn't all walk out together. The ROSTER still owns the off-show
    // scheduled cycle; this is the live loop only.
    //
    // ⚠️ THE COOK IS EXEMPT FROM THE **FOOD** ROW (round 7's corollary,
    // preserved): cook (3.3) outranks provision:food (3) and a transform
    // fires on ANY matching carried unit, so a cook who also shopped would
    // hijack its own grocery haul into the pot one apple at a time and never
    // stock the pantry. It still restocks every OTHER good.
    for (const good of goods) {
      if (good.good.key === "food" && member === cook && session.dollhouse === houseIndex) continue;
      out.push({
        ...provisionTemplate(good.good.key, Math.ceil(good.surplusUnits(house)), Math.floor(good.boxCap)),
        exclusive: true,
      });
    }
    // DOLLHOUSE members run the full Sims-mode motive set (§3 + round 2): tiredness
    // slept off at a bed, loneliness talked off with a housemate, thirst drunk at
    // the table from the barrel/well, waste at the privy, grime at the bath, and
    // the tidying chore over loose floor props. Data rows only.
    // WINDOW index — a neighbor's LOCAL index must never match the dollhouse.
    if (session.dollhouse === houseIndex) {
      const wardrobeCap = Math.floor(goods.find((g) => g.good.key === "clothing")?.boxCap ?? 8);
      out.push(
        thirstTemplate(rate("thirst")),
        wasteTemplate(rate("waste")),
        energyTemplate(rate("energy")),
        socialTemplate(rate("social")),
        hygieneTemplate(rate("hygiene")),
        tidyTemplate(),
        // UNLOAD (high priority, no acquire branch): whatever is in hand that
        // no other row claims gets put away NOW — bodies don't wander the
        // house holding things.
        unloadTemplate(),
        funTemplate(rate("fun")),
        // CLOTHING (round 3): worn garments dirty over time (the dress meter),
        // a change fetches a clean one from the wardrobe, the doffed garment
        // walks itself to the tub (laundry) and the washed unit gets stowed
        // back — one chain across three data rows and a type change.
        dressTemplate(rate("dirt")),
        laundryTemplate(),
        stowTemplate("clothing", wardrobeCap),
        // SERVE (round 7 — every member): carried or loose MEALS go ON
        // the table, where a hungry housemate's walker finds them
        // waiting. Gifts included: hand anyone a hot meal and it gets
        // tabled, not pocketed.
        serveTemplate("meal", TABLE_MEAL_CAP),
      );
      // WATER: the barrel is likewise the HOUSE's to keep full — every member
      // may fetch from the well, one at a time (the `exclusive` claim). Same
      // move as the street goods above; the old single "water duty" member
      // left everyone else with the well as their only drink.
      out.push({
        key: "provision:water",
        item: { category: "water" },
        drive: { kind: "stock", container: "home", below: BARREL_REFILL_BELOW },
        satisfy: { kind: "deposit", container: "home", upTo: BARREL_CAP },
        acquire: [{ kind: "source" }],
        priority: 3,
        exclusive: true,
      });
      // COOK (round 7, duty picked above): keeps meals on the table. It is the
      // one member with no provision:food row, so its raw-food takes are only
      // ever the cook's own — no grocery haul to hijack.
      if (member === cook) out.push(cookTemplate("food", "meal", TABLE_MEAL_CAP));
      out.push(...adoptionTemplates(session, houseIndex, `resident_${houseIndex}_${member}`));
    }
    return out;
  }

  /** The need rows a household PET runs — the SAME vocabulary, species-tuned:
   *  hunger eats what WAITS at the bowl (its acquire branches resolve to nothing
   *  for a graspless body — the capability gate — so an empty bowl BLOCKS and
   *  the want surfaces for adoption); naps happen wherever it stands; play with
   *  whatever affords it; company from whoever's home. */
  function petNeedTemplates(session: QuestSession): NeedTemplate[] {
    const rate = (k: Parameters<typeof needRate>[1]) => needRate(session.scale, k);
    return [
      hungerTemplate("food", rate("hunger"), ["bowl"]),
      thirstTemplate(rate("thirst"), ["bowl"]), // drinks from its bowl, not the table
      { ...energyTemplate(rate("energy")), satisfy: { kind: "rest", at: [] } }, // dozes in place
      socialTemplate(rate("social")),
      funTemplate(rate("fun")),
      // UNLOAD — a pet had NO put-away row of any kind, so anything it ended
      // up holding (a ball fetched by the fun row, a gift, an apple taken from
      // its bowl) it held for the rest of the session: nothing in its template
      // set could ever end a carry. It cannot open a lidded box, so this row
      // resolves to the DROP (orDrop) almost always — which is exactly right:
      // a dog puts the ball down, it doesn't file it.
      unloadTemplate(),
    ];
  }

  /** ADOPTION (the general on-behalf rule — never a hard-coded chore): a
   *  housemate whose want has surfaced as BLOCKED (it can't serve itself — a
   *  graspless pet at a lidded pantry, later the sick in bed) gets a derived
   *  supply row on every warm-related member: acquire the item through the
   *  HELPER's own branches, deposit ONE unit into the wanter's reachable
   *  station-container (its bowl, the table) — where the wanter's own walker
   *  finds it WAITING and eats. A spoken "help X" forces the row at command
   *  priority. The row stops firing the moment the recipient container holds a
   *  unit, and disappears when the want clears — no double-feeding. */
  function adoptionTemplates(session: QuestSession, houseIndex: number, helper: string): NeedTemplate[] {
    const out: NeedTemplate[] = [];
    const helped = session.helpOrders.get(helper);
    for (const [wanter, want] of session.blockedNeeds) {
      if (wanter === helper) continue;
      if (houseIndexOfCid(wanter) !== houseIndex) continue; // household scope
      if (!want.goodKey) continue; // only supplyable (item-typed) wants
      // Adoption needs a RECIPIENT station to leave the unit at (the bowl, the
      // table). A blocked want with no station kinds (an equip-shaped dress
      // want — its remedy is the same wardrobe the helper would draw from)
      // can't be served on behalf; it surfaces through dialogue only.
      if (!want.at.length) continue;
      const ordered = helped === wanter;
      // Relation gate (bypassed by the spoken order): a soured housemate won't bother.
      const rel = session.relations.get(`${helper}|${wanter}`) ?? DEFAULT_RELATION;
      if (!ordered && rel.affinity < 0) continue;
      const key = `adopt:${wanter}|${want.tplKey}`;
      // One helper at a time: skip if any body is already walking this row —
      // on EITHER engine (the legacy step or a need-born pursuit, S4).
      let taken = false;
      for (const [cid, step] of session.needStep) {
        if (cid !== helper && step.tplKey === key) { taken = true; break; }
      }
      for (const [cid, p] of session.pursuits) {
        if (cid !== helper && p.source === "need" && p.tplKey === key) { taken = true; break; }
      }
      if (taken) continue;
      out.push({
        key,
        item: { category: want.goodKey },
        drive: { kind: "stock", container: "recipient", below: 1 },
        satisfy: { kind: "deposit", container: "recipient", upTo: 1 },
        acquire: [{ kind: "container", role: "home" }, { kind: "source" }],
        // MUST outrank provision (3) — the LIVELOCK INVARIANT (needs.ts): a
        // unit this row takes from the pantry is "carried", which fires
        // provision's put-it-away rule; if provision outranked, it would bank
        // the unit straight back into the chest it came from, forever (the
        // observed take⇄deposit spin). An acquiring template outranks every
        // deposit row for its type.
        priority: ordered ? 6 : 3.5,
      });
    }
    return out;
  }

  /** House index off a body id — residents AND pets share the `_<house>_<n>` shape. */
  function houseIndexOfCid(cid: string): number {
    return Number(cid.split("_")[1]);
  }

  /** Is this creature in the PLAYER'S group — the observed household (dollhouse)
   *  or the party? Soft control (spark-attention.ts) weights its signal higher:
   *  the player's own people attend more than a neighbor or a stranger. */
  function inPlayerGroup(session: QuestSession, cid: string): boolean {
    return session.party.has(cid) || (session.dollhouse !== null && houseIndexOfCid(cid) === session.dollhouse);
  }

  // ── WORN CLOTHING: the worn record stores the full garment GLYPH
  // (`shirt.color_red`), and the visible outfit is the (head × colour) bake at
  // `outfitIndexOf(head, colour)` (creatures/clothing.ts). The colour is now
  // explicit in the glyph, so a change of clothes is visible by its colour — no
  // rotation counter needed (kept in the signature for the worn record's own
  // change count, which other rows read).

  /** The outfit-index a body wearing `glyph` shows — parsed from the garment's
   *  head + `color_*` facet (a colourless glyph falls back to the first
   *  palette colour). */
  function wornOutfitIndex(_cid: string, glyph: string, _n: number): number {
    const { kind, descriptors } = glyphFacets(glyph);
    const color = descriptors.find((d) => d.startsWith("color_")) ?? "";
    return outfitIndexOf(kind, color);
  }

  /** Seed a member's WORN garment from its spawn outfit (the authored index,
   *  else the same stable hash `outfitFor` dresses the body by) — so the first
   *  change of clothes doffs the coloured garment the body was visibly wearing
   *  (a valid `shirt.color_*` key the laundry chain recognises). */
  function seedWorn(session: QuestSession, cid: string, member: number) {
    if (session.worn.has(cid)) return;
    const authored = familyMemberOf(session, houseIndexOfCid(cid), member)?.outfit;
    // Match the avatar factory's `outfitFor`: an authored index is worn as-is;
    // everyone else wears a culture-appropriate garment (the same palette pick),
    // so the visible body and the worn record agree from frame one.
    const index =
      authored !== undefined ? Math.floor(authored) : outfitIndexForDress(fnv1a(cid), session.dress);
    session.worn.set(cid, { glyph: garmentGlyphOfIndex(index), n: 0 });
  }

  /**
   * Does a glyph satisfy a template's item target? `affords` selects on what
   * the thing CAN DO (the concept library's affordance list) rather than on
   * what it is — the seam that lets a motive name a function instead of a
   * fixture. `category` keeps the existing good-key vocabulary; an empty
   * target matches anything (the tidy chore's untyped sweep).
   */
  function matchesNeedItem(glyph: string, target: NeedTarget): boolean {
    const head = headOf(glyph);
    if (target.affords) {
      return !!CONCEPT_LIBRARY.get(head)?.affords.includes(target.affords);
    }
    if (target.kind) return head === target.kind;
    if (target.category) return isKindOf(glyph, target.category);
    return true;
  }

  /** Glyph heads that belong to a PROVISIONED good (street goods' kinds, treats,
   *  water) — the tidy chore must NOT sweep these; their own rows walk them.
   *  ⚠️ HEADS, not kinds: a clothing kind is `shirt.color_red` (head × colour),
   *  but every consumer queries this set by the bare HEAD (`glyph.split(".")[0]`),
   *  so the colour facet must be stripped on insert. Without this, no garment
   *  head matches → the tidy chore sweeps clothing as clutter and livelocks
   *  against the dress/laundry/stow rows (take-out-of-box / put-back-in loop). */
  function provisionedHeads(session: QuestSession, houseIndex: number): Set<string> {
    const heads = new Set<string>(["water", ...TREAT_KINDS]);
    for (const g of residentTownCtx(session, houseIndex)?.goods ?? []) {
      for (const k of kindsOf(g.good.key)) heads.add(headOf(k));
    }
    return heads;
  }

  /**
   * THE OBJECT'S DESIGNATED CONTAINER — where a glyph BELONGS, and so where
   * tidying returns it, where a give-up banks it and where a fetch looks first.
   * ONE ladder, consulted by every one of those paths, so eviction and the
   * happy path can never disagree about an item's home:
   *
   *   1. water            → the barrel
   *   2. a provisioned good → that good's chest (food's is the refrigerator)
   *   3. an OWNED object   → its owner's own box
   *   4. anything else     → the tidier's own box, else any member's box
   *   5. no box at all     → the cupboard (every house has one)
   *
   * Deliberately NOT one communal "toy box": a box is a box, and what makes one
   * a toy box is only what happens to be inside it.
   */
  function designatedContainerFor(
    session: QuestSession,
    glyph: string,
    houseIndex: number,
    cid?: string,
  ): string {
    const head = headOf(glyph);
    if (head === "water") return `furn_${houseIndex}_barrel`;
    if (provisionedHeads(session, houseIndex).has(head)) {
      return `furn_${houseIndex}_chest_${goodKeyOfGlyph(glyph)}`;
    }
    const boxOf = (m: number) => `furn_${houseIndex}_box_${m}`;
    const exists = (id: string) => !!session.containers.has(id);
    // An owned thing goes back to ITS owner's box, whoever is carrying it.
    const ownerId = session.creatures?.world.items[glyph]?.ownerId;
    const owned = ownerId ? /resident_\d+_(\d+)$/.exec(ownerId) : null;
    if (owned && exists(boxOf(Number(owned[1])))) return boxOf(Number(owned[1]));
    // Else the tidier's own box — you put things away in your own.
    const self = cid ? /resident_\d+_(\d+)$/.exec(cid) : null;
    if (self && exists(boxOf(Number(self[1])))) return boxOf(Number(self[1]));
    for (let m = 0; m < HOUSEHOLD; m++) if (exists(boxOf(m))) return boxOf(m);
    return `furn_${houseIndex}_cupboard`;
  }

  /** THE HANDS-EMPTY COMPLETION (§4, DEBUG-CREATURE-BEHAVIOR): bank every
   *  carried stack into the house's boxes by HEAD — a kind glyph into its
   *  GOOD's home box (apples → the food chest, water → the barrel), loose
   *  clutter into the box. Every exit from the needs loop that abandons an
   *  episode routes through this (eviction, DEMOTE, the deposit give-up) — the
   *  ONLY alternative is keeping the body live until the hand is disposed of.
   *  Returns the units banked (0 = hands were already empty). */
  function bankCarried(session: QuestSession, cid: string, houseIndex: number): number {
    const carried = session.needCarried.get(cid);
    if (!carried) return 0;
    let banked = 0;
    for (const [glyph, n] of Object.entries(carried)) {
      if (n <= 0) continue;
      const box = designatedContainerFor(session, glyph, houseIndex, cid);
      const stock = session.containerStock.get(box) ?? {};
      stock[glyph] = (stock[glyph] ?? 0) + n;
      session.containerStock.set(box, stock);
      banked += n;
    }
    session.needCarried.delete(cid);
    return banked;
  }

  /**
   * Is this held glyph IN USE — serving a live `use` need of this creature (the
   * toy it is playing with right now)? THE TIDY RULE is "sweep what's loose and
   * NOT IN USE": without this, tidy (priority 1.2) outranks fun (1.0), so the
   * instant a body took a toy out the chore banked it straight back — take out,
   * put in, forever. Once the need is satisfied the toy stops being in use and
   * becomes ordinary clutter, which is what puts it away after play.
   * General on purpose: any `use`-shaped row protects its own item.
   */
  function inUseByLiveNeed(
    session: QuestSession,
    cid: string,
    glyph: string,
    all: readonly NeedTemplate[] | undefined,
  ): boolean {
    for (const t of all ?? []) {
      if (t.satisfy.kind !== "use" || !matchesNeedItem(glyph, t.item)) continue;
      const threshold = t.drive.kind === "meter" ? t.drive.threshold : 1;
      if ((session.needMeters.get(`${cid}|${t.key}`) ?? 0) >= threshold) return true;
    }
    return false;
  }

  /** Total carried units that are NOT provisioned goods and NOT in use — the
   *  tidy row's "carried" (a picked-up toy on its way to its box). */
  function carriedClutter(
    session: QuestSession,
    houseIndex: number,
    cid: string,
    all?: readonly NeedTemplate[],
  ): number {
    const heads = provisionedHeads(session, houseIndex);
    let n = 0;
    for (const [glyph, u] of Object.entries(session.needCarried.get(cid) ?? {})) {
      if (heads.has(headOf(glyph))) continue;
      if (inUseByLiveNeed(session, cid, glyph, all)) continue; // mid-play — not clutter
      n += u;
    }
    return n;
  }

  /** The key an exclusive household errand is claimed under. */
  const errandClaimKey = (houseIndex: number, tplKey: string) => `${houseIndex}|${tplKey}`;

  /** Where THIS body stands toward a household-exclusive errand: does it hold
   *  the claim, or is a housemate already on it? An UNCLAIMED errand reads
   *  "self" — everyone is free to take it, and whoever actually acts claims it
   *  (`claimErrand`, from stepNeeds' deterministic member order), which is what
   *  makes exactly one shopper leave. A claim held by a body that is gone (no
   *  longer live, no longer embodied) is dropped here rather than wedging the
   *  errand shut forever. */
  function errandClaimFor(
    session: QuestSession,
    houseIndex: number,
    tplKey: string,
    cid: string,
  ): "self" | "other" {
    const key = errandClaimKey(houseIndex, tplKey);
    const holder = session.errandClaims.get(key);
    if (!holder || holder === cid) return "self";
    // STALE CLAIM: the holder stopped running its needs (evicted, demoted,
    // recruited into the party). Release it so the errand can be re-taken.
    if (!session.liveNeedBodies.has(holder) && !session.needStep.has(holder)) {
      session.errandClaims.delete(key);
      return "self";
    }
    return "other";
  }

  /** Take the claim on an exclusive errand (called when a body actually ACTS on
   *  one), and release every OTHER claim this body holds — one errand per body,
   *  the task pool's exactly-one law. */
  function claimErrand(session: QuestSession, houseIndex: number, tplKey: string, cid: string) {
    for (const [k, holder] of session.errandClaims) {
      if (holder === cid && k !== errandClaimKey(houseIndex, tplKey)) session.errandClaims.delete(k);
    }
    session.errandClaims.set(errandClaimKey(houseIndex, tplKey), cid);
  }

  /** Drop every errand claim this body holds (completion, demote, eviction). */
  function releaseErrands(session: QuestSession, cid: string) {
    for (const [k, holder] of session.errandClaims) {
      if (holder === cid) session.errandClaims.delete(k);
    }
  }

  /** Resolve ONE template's world snapshot for a resident/pet (needs.ts NeedCtx):
   *  its own house box under the "home" role (other houses would gate through
   *  willingness — not offered), the market store / town well as the buy source,
   *  the satisfy stations by kind. All counts read the SAME container/stack model
   *  the player's takes and puts mutate — that is what makes stealing/gifting
   *  land. Candidates are CAPABILITY-GATED (grasp). */
  function residentNeedCtx(
    session: QuestSession,
    state: WorldState,
    cid: string,
    houseIndex: number,
    tpl: NeedTemplate,
    /** The creature's WHOLE row set — lets the tidy row tell an item that's in
     *  use (a toy mid-play) from real clutter. Omitted on single-row probes. */
    allTemplates?: readonly NeedTemplate[],
  ): NeedCtx {
    const goodKey = tpl.item.category ?? "";
    const P = (id: string) => ({ kind: "named" as const, id });
    const rc = residentTownCtx(session, houseIndex)!; // the OWNING town's books
    const grasp = canGrasp(session.creatures?.world.creatures[cid]);
    const containers: Record<string, StockCandidate> = {};
    // HOME role: the good's own chest — except WATER, whose house store is the
    // barrel (both lidded: accessible if the body can open it, or someone left
    // it open).
    {
      const homeId = goodKey === "water" ? `furn_${houseIndex}_barrel` : `furn_${houseIndex}_chest_${goodKey}`;
      const cap = goodKey === "water"
        ? BARREL_CAP
        : Math.floor(rc.goods.find((g) => g.good.key === goodKey)?.boxCap ?? 0);
      if (containerAccessible(session, homeId, grasp) && needObjectPos(session, state, houseIndex, homeId)) {
        const units = stackTotalOf(session.containerStock.get(homeId), goodKey);
        containers.home = { id: homeId, place: P(homeId), units, room: Math.max(0, cap - units) };
      }
    }
    // STORAGE role — resolved PER ITEM, never to one fixed box.
    //  · tidy (deposit): the DESIGNATED container of what's actually in hand,
    //    so a swept-up thing goes back where it belongs.
    //  · fun (use/acquire): a box that currently HOLDS something matching the
    //    template — you fetch a toy from wherever a toy happens to be.
    if (tpl.satisfy.kind === "deposit" && tpl.satisfy.container === "storage") {
      const held = Object.keys(session.needCarried.get(cid) ?? {}).find(
        (g) => (session.needCarried.get(cid)?.[g] ?? 0) > 0,
      );
      const tid = designatedContainerFor(session, held ?? "", houseIndex, cid);
      // CAPABILITY GATE (was missing here): a graspless body cannot open a
      // LIDDED container, so offering it one sends the dog to a chest it can
      // never use — it would stand there failing the deposit. Only
      // pass-through ("on") containers — its bowl, a table — are reachable
      // without hands. With `orDrop` on the unload row, a body that is left
      // with no legal container simply puts the thing DOWN, which is the
      // right answer for an animal.
      if (state.objects[tid] && containerAccessible(session, tid, grasp)) {
        containers.storage = { id: tid, place: P(tid), units: 0 };
      }
    } else if (tpl.acquire.some((a) => a.kind === "container" && a.role === "storage")) {
      for (const [id, stock] of session.containerStock) {
        if (!id.startsWith(`furn_${houseIndex}_`)) continue;
        if (!mayUse(cid, houseIndex, session.containerOwner.get(id))) continue;
        const units = Object.entries(stock)
          .filter(([g, n]) => n > 0 && matchesNeedItem(g, tpl.item))
          .reduce((s, [, n]) => s + n, 0);
        if (units > 0 && needObjectPos(session, state, houseIndex, id)) {
          containers.storage = { id, place: P(id), units };
          break;
        }
      }
    }
    // SERVE role (round 7, the meal chain): the household TABLE. The
    // serve row deposits meals into it; the cook row's stock DRIVE
    // measures it in the drive's `of` category (meals) — the template
    // itself acquires raw food.
    if (
      (tpl.satisfy.kind === "deposit" && tpl.satisfy.container === "serve") ||
      (tpl.drive.kind === "stock" && tpl.drive.container === "serve")
    ) {
      const tid = `furn_${houseIndex}_table`;
      if (state.objects[tid]) {
        const measure =
          tpl.drive.kind === "stock" && tpl.drive.container === "serve" && tpl.drive.of
            ? tpl.drive.of
            : goodKey;
        const units = stackTotalOf(session.containerStock.get(tid), measure);
        containers.serve = { id: tid, place: P(tid), units, room: Math.max(0, TABLE_MEAL_CAP - units) };
      }
    }
    // RECIPIENT role (an ADOPTION row `adopt:<wanter>|<tpl>`): the wanter's own
    // reachable station-container — its bowl, the table — where a deposited unit
    // WAITS for the wanter's walker.
    if (tpl.key.startsWith("adopt:")) {
      const wanter = tpl.key.slice(6).split("|")[0]!;
      const want = session.blockedNeeds.get(wanter);
      const wanterHouse = houseIndexOfCid(wanter);
      for (const kind of want?.at ?? []) {
        const oid = `furn_${wanterHouse}_${kind}`;
        if (!state.objects[oid]) continue;
        const cap = kind === "bowl" ? BOWL_CAP : 99;
        const units = stackTotalOf(session.containerStock.get(oid), goodKey);
        containers.recipient = { id: oid, place: P(oid), units, room: Math.max(0, cap - units) };
        break;
      }
    }
    // SOURCES: water is drawn free at the town WELL; anything else is a market
    // buy. Both need grasp (a bucket to work, a purse to pay). A member cooling
    // off a good (it arrived to an empty shelf) sees no source at all until the
    // cooldown lapses — no empty-handed loops.
    let sources: StockCandidate[] = [];
    if (grasp) {
      if (goodKey === "water") {
        const wellId = "well";
        if (!rc.neighbor && state.objects[wellId]) {
          sources = [{ id: wellId, place: P(wellId), units: 99 }]; // the well never runs dry
        }
      } else {
        const storeId = `store:${goodKey}`;
        const coolUntil = session.shopCooldown.get(`${cid}|${goodKey}`) ?? 0;
        if (!rc.neighbor && state.objects[storeId] && session.townClock >= coolUntil) {
          sources = [{ id: storeId, place: P(storeId), units: marketStoreUnits(session, storeId) }];
        }
      }
    }
    // Stations by the template's SATISFY, generalized by KIND: consume at the
    // named surface containers (table / the pet's bowl — `waiting` counts the
    // good already there); rest at the named dwell stations (bed / box /
    // bath / privy); a social partner is a HOUSEMATE (people and pets),
    // nearest-first from live positions.
    let stations: StationCandidate[] = [];
    if (tpl.satisfy.kind === "consume") {
      for (const kind of tpl.satisfy.at ?? ["table"]) {
        const sid = `furn_${houseIndex}_${kind}`;
        if (state.objects[sid]) {
          // A FOOD want also counts waiting MEALS (round 7): a served
          // hot dish on the table pulls the hungry straight to it (the
          // acquire+consume combine — the dinner scene).
          const waiting =
            stackTotalOf(session.containerStock.get(sid), goodKey) +
            (goodKey === "food" ? stackTotalOf(session.containerStock.get(sid), "meal") : 0);
          stations.push({ id: sid, place: P(sid), kind, waiting });
        }
      }
    } else if (tpl.satisfy.kind === "rest" || tpl.satisfy.kind === "transform") {
      // Dwell stations (bed / box / bath / privy) — a TRANSFORM works at
      // the same kind of station (the wash at the tub), resolved identically.
      for (const kind of tpl.satisfy.at ?? ["bed"]) {
        const ids = kind === "bed"
          ? [`furn_${houseIndex}_bed_0`, `furn_${houseIndex}_bed_1`, `furn_${houseIndex}_bed_2`]
          : [`furn_${houseIndex}_${kind}`];
        let cands = ids.filter((sid) => !!state.objects[sid]);
        if (kind === "bed") {
          // OWN BED first (ownership.ts): beds carry creature scopes, so a
          // member lists only the bed(s) that are THEIRS — which is what
          // makes everyone sleep in their own bed. When none of their own
          // stands (the fit rule went without), politeness collapses: any
          // bed in the house serves rather than dozing on the floor.
          const own = cands.filter((sid) => mayUse(cid, houseIndex, session.containerOwner.get(sid)));
          if (own.length) cands = own;
        }
        for (const sid of cands) stations.push({ id: sid, place: P(sid), kind, waiting: 0 });
      }
    } else if (tpl.satisfy.kind === "social") {
      const body = state.avatars[cid];
      const partners: { id: string; d: number }[] = [];
      const candidates: string[] = [];
      for (let m2 = 0; m2 < HOUSEHOLD; m2++) candidates.push(`resident_${houseIndex}_${m2}`);
      for (const pid of petCidsOf(session)) {
        if (houseIndexOfCid(pid) === houseIndex) candidates.push(pid);
      }
      for (const pid of candidates) {
        if (pid === cid || session.party.has(pid)) continue;
        const pav = state.avatars[pid];
        if (!pav) continue;
        partners.push({ id: pid, d: body ? Math.hypot(pav.x - body.x, pav.y - body.y) : 0 });
      }
      partners.sort((a, b) => a.d - b.d);
      stations = partners.map((pt) => ({ id: pt.id, place: P(pt.id), kind: "partner", waiting: 0 }));
    }
    // LOOSE units. Two flavors by the template's item type:
    //   • ITEM-TYPED (laundry / stow — `goodKey` set): floor props MATCHING
    //     the type, no grace (a doffed shirt is laundry at once) — plus, for
    //     TRANSFORM rows only, matching stacks banked in the house's own
    //     containers (a dirty garment evicted into the wardrobe). A DEPOSIT
    //     row must never list containers here, or it would cycle stock out of
    //     the very box it deposits into.
    //   • UNTYPED (the tidy chore): unclaimed clutter INSIDE the room, past
    //     the grace period, that no provision row owns.
    // Nearest-first, either way.
    let loose: StockCandidate[] | undefined;
    if (tpl.drive.kind === "mess" || tpl.acquire.some((a) => a.kind === "loose")) {
      const house = rc.house;
      const body = state.avatars[cid];
      const cands: { c: StockCandidate; d: number }[] = [];
      if (house && tpl.item.affords) {
        // AFFORDANCE-TYPED (fun): anything lying out that carries the function.
        // No grace period — a toy on the floor is playable the moment it lands —
        // and OWNED things count: you play with your own teddy.
        const x0 = rc.center.x + house.dx;
        const y0 = rc.center.y + house.dy;
        for (const [objId, rec] of session.smallProps) {
          if (!matchesNeedItem(rec.glyph, tpl.item)) continue;
          const o = state.objects[objId];
          if (!o || o.carriedBy || o.containedIn) continue;
          if (o.x < x0 || o.x > x0 + house.w || o.y < y0 || o.y > y0 + house.h) continue;
          cands.push({
            c: { id: objId, place: P(objId), units: 1 },
            d: body ? Math.hypot(o.x - body.x, o.y - body.y) : 0,
          });
        }
      } else if (house && goodKey) {
        const x0 = rc.center.x + house.dx;
        const y0 = rc.center.y + house.dy;
        const kinds = kindsOf(goodKey);
        for (const [objId, rec] of session.smallProps) {
          if (!kinds.includes(rec.glyph)) continue;
          const o = state.objects[objId];
          if (!o || o.carriedBy || o.containedIn) continue;
          if (o.x < x0 || o.x > x0 + house.w || o.y < y0 || o.y > y0 + house.h) continue;
          cands.push({
            c: { id: objId, place: P(objId), units: 1 },
            d: body ? Math.hypot(o.x - body.x, o.y - body.y) : 0,
          });
        }
        if (tpl.satisfy.kind === "transform") {
          for (const [boxId, stock] of session.containerStock) {
            if (!boxId.startsWith(`furn_${houseIndex}_`)) continue;
            if (!containerAccessible(session, boxId, grasp)) continue;
            // Never raid a housemate's PRIVATE box (ownership.ts) — the
            // laundry chore reaches the wardrobe, not Mara's treasures.
            if (!mayUse(cid, houseIndex, session.containerOwner.get(boxId))) continue;
            const units = stackTotalOf(stock, goodKey);
            if (units <= 0) continue;
            const o = state.objects[boxId];
            if (!o) continue;
            cands.push({
              c: { id: boxId, place: P(boxId), units },
              d: body ? Math.hypot(o.x - body.x, o.y - body.y) : 0,
            });
          }
        }
      } else if (house) {
        const heads = provisionedHeads(session, houseIndex);
        const x0 = rc.center.x + house.dx;
        const y0 = rc.center.y + house.dy;
        for (const [objId, rec] of session.smallProps) {
          if (heads.has(headOf(rec.glyph))) continue;
          // SOMEONE'S OWN thing (a gift, a keepsake — creature-world ownerId)
          // IS tidied, but never re-homed: designatedContainerFor sends it back
          // to its OWNER's box, not the tidier's. Putting your teddy away in
          // your box is help; putting it in someone else's is theft.
          const o = state.objects[objId];
          if (!o || o.carriedBy || o.containedIn) continue;
          if (o.x < x0 || o.x > x0 + house.w || o.y < y0 || o.y > y0 + house.h) continue;
          if (session.townClock - (rec.at ?? 0) < TIDY_GRACE_S) continue;
          cands.push({
            c: { id: objId, place: P(objId), units: 1 },
            d: body ? Math.hypot(o.x - body.x, o.y - body.y) : 0,
          });
        }
      }
      cands.sort((a, b) => a.d - b.d);
      loose = cands.map((x) => x.c);
    }
    return {
      // SOFT CONTROL (spark-attention.ts): if the spark is drawing attention to a
      // matching object AND this creature is ENGAGED, add a strong effective-meter
      // bonus so it goes to use the thing. Never persisted (the meter itself is
      // untouched); an unengaged creature gets nothing, so nobody is pulled in.
      meter:
        (session.needMeters.get(`${cid}|${tpl.key}`) ?? 0) +
        attentionBonus(session.sparkDraw, session.sparkFocus, cid, tpl.key),
      // The CARRY projection (carryTotalOf, not stackTotalOf): a food row must
      // see a carried TREAT, or a gifted cookie projects to 0 for every row
      // the creature owns and rides the hands forever (§4).
      // `tidy` and `unload` both act on ORPHAN units — what's in hand that no
      // other row on this body claims. They differ only in what they reach
      // for: tidy sweeps the floor (low-priority chore), unload empties the
      // hands (high priority, no acquire branch — see unloadTemplate).
      carried: tpl.key === "tidy" || tpl.key === "unload"
        ? carriedClutter(session, houseIndex, cid, allTemplates)
        // An AFFORDANCE row counts whatever in hand carries the function —
        // the toy already held IS the fun, so the body plays instead of
        // fetching another.
        : tpl.item.affords
          ? Object.entries(session.needCarried.get(cid) ?? {})
              .filter(([g, n]) => n > 0 && matchesNeedItem(g, tpl.item))
              .reduce((s, [, n]) => s + n, 0)
          : carryTotalOf(session.needCarried.get(cid), goodKey),
      // A stock drive measured in another category (`of`) counts THAT
      // category's carried units for its fire check (needs.ts) — the
      // cook's in-hand meal is the loop's brake.
      ...(tpl.drive.kind === "stock" && tpl.drive.of
        ? { carriedOf: carryTotalOf(session.needCarried.get(cid), tpl.drive.of) }
        : {}),
      containers,
      sources,
      stations,
      ...(loose ? { loose } : {}),
      // WHAT THE BODY CAN STILL TAKE ON — hands + inventory slots left. Every
      // take is capped by it, so a bounded bag makes a bounded shopping trip.
      room: inventoryRoom(session.needCarried.get(cid)),
      // THE RESTOCK TARGET (the fix for single-unit grocery trips): how many
      // units the HOUSEHOLD still has ROOM for at home — which is exactly the
      // home container's remaining capacity, already resolved above. Applied
      // only to a `source` branch, so a body that has walked all the way to
      // the market fills the pantry instead of buying the one bite it wants
      // and walking home. Using the shortfall (not the cap) means a take can
      // never overfill the box and strand units in the bag.
      ...(containers.home?.room ? { restock: containers.home.room } : {}),
      // THE HOUSEHOLD CLAIM on an exclusive errand (restocking): whoever holds
      // it goes, everyone else stands down.
      ...(tpl.exclusive ? { claimed: errandClaimFor(session, houseIndex, tpl.key, cid) } : {}),
    };
  }

  /** Items are FUNGIBLE STACKS (§12b): when a resident's carried unit is eaten or
   *  banked into a box, any matching creature-world INSTANCE it owned (a player gift it
   *  walked home) stops existing as an instance too — otherwise the dialogue keeps
   *  answering "I have the cloth" about a unit that is now aggregate box stock, while
   *  its trip-reason claims the opposite. Knowledge of the dead instance goes with it. */
  function dropOwnedInstances(session: QuestSession, cid: string, goodKey: string, n: number) {
    const w = session.creatures?.world;
    if (!w) return;
    let left = n;
    for (const item of Object.values(w.items)) {
      if (left <= 0) break;
      if (item.ownerId !== cid) continue;
      if (item.kind !== goodKey && item.category !== goodKey) continue;
      if (item.bound) continue; // a need-bound keepsake is not spendable stock
      delete w.items[item.id];
      for (const c of Object.values(w.creatures)) delete c.knowledge[item.id];
      left--;
    }
  }

  /** THE INGEST EFFECT — what eating/drinking does to the EATER's body, declared
   *  ONCE so the autonomous need path and a spoken "eat X" command apply the
   *  IDENTICAL change (the redundancy the planner's effect model exists to kill):
   *  the matching hunger/thirst row empties, and digestion pushes the waste
   *  meter. `tplKey` names the row emptied (its "thirst"/"hunger" prefix also
   *  picks the digestion weight). A body with no such row — a stray, a pet that
   *  doesn't run the meter — is simply unaffected; it still visibly consumes the
   *  item. This is the effect BOUND to the `eat`/`consume` action; the two call
   *  sites (need-consume, command-eat) will collapse into one when the command
   *  path moves onto the per-tick planner. */
  function applyIngestEffect(session: QuestSession, cid: string, tplKey: string) {
    session.needMeters.set(`${cid}|${tplKey}`, 0);
    if (session.dollhouse === houseIndexOfCid(cid) && !isPetCid(cid)) {
      const wk = `${cid}|waste`;
      const bump = tplKey.startsWith("thirst") ? WASTE_DRINK_BUMP : WASTE_MEAL_BUMP;
      session.needMeters.set(wk, (session.needMeters.get(wk) ?? 0) + bump);
    }
  }

  /** Apply an ARRIVED step's elemental effect over the container/stack model. A take
   *  from a MARKET store is a real off-schedule purchase — it depletes the same shelf
   *  the player's takes deplete (the consumed offset over the time-pure stock). */
  function applyNeedStepEffect(
    session: QuestSession,
    state: WorldState,
    cid: string,
    step: {
      tplKey: string;
      kind: string;
      goodKey: string;
      /** An AFFORDANCE row's selector (fun's `play`) — see needStep. */
      affords?: string;
      objId?: string;
      seatId?: string;
      units: number;
      proc?: { drop?: string; add?: string };
    },
  ) {
    const carried = session.needCarried.get(cid) ?? {};
    const likes = session.creatures?.world.creatures[cid]?.likes ?? [];
    // A good's kinds, LIKED first — the choice order for taking and eating.
    // The CARRY projection (carryKindsOf): eating or banking FOOD also reaches
    // for a treat in hand — a gifted cookie gets eaten/put away, never orphaned.
    const kindOrder = (goodKey: string): string[] => {
      const kinds = [...carryKindsOf(goodKey)];
      const liked = preferredOf(likes, kinds);
      return liked ? [liked, ...kinds.filter((k) => k !== liked)] : kinds;
    };
    if (step.kind === "take" && step.objId) {
      // THE CARRY BOUND, RE-CHECKED ON ARRIVAL. The walker sized this take from
      // the room the body had when it DECIDED; a gift, a tidy pickup or a
      // housemate's hand-off during the walk may have filled the bag since.
      // Clamping here (rather than trusting the decision) means no take path
      // can overfill a body, and a body that arrives full simply takes nothing
      // and re-decides — the want stays live and surfaces.
      const room = inventoryRoom(carried);
      const units = Math.max(0, Math.min(step.units, room));
      if (units === 0) {
        console.log(`[needs] ${cid} arrived at ${step.objId} with a FULL inventory (${totalStackUnits(carried)}) — took nothing`);
        return;
      }
      // The town WELL: water is drawn free — no shelf, no depletion, no purse.
      if (step.objId === "well") {
        carried["water"] = (carried["water"] ?? 0) + units;
        session.needCarried.set(cid, carried);
        console.log(`[needs] ${cid} drew ${units}× water at the well`);
        return;
      }
      // A LOOSE floor prop (the tidy pickup): the prop dissolves into the
      // carrier's hands — same merge rule as the player's own pocket.
      if (step.objId.startsWith("small:")) {
        const rec = session.smallProps.get(step.objId);
        // A LARGE thing (furniture) is never pocketed — it rides in the HANDS,
        // so it may only be picked up by an otherwise empty-handed body. Small
        // things merge into the bag as before.
        if (rec && isLargeGlyph(rec.glyph) && totalStackUnits(carried) > 0) {
          console.log(`[needs] ${cid} can't pick up ${rec.glyph} — hands full and it won't fit in a bag`);
          return;
        }
        if (rec) {
          carried[rec.glyph] = (carried[rec.glyph] ?? 0) + 1;
          session.needCarried.set(cid, carried);
          world?.removeObject(step.objId);
          session.smallProps.delete(step.objId);
          if (session.creatures) delete session.creatures.world.items[rec.entityId];
          console.log(`[needs] ${cid} picked up ${rec.glyph} (tidying)`);
        }
        return;
      }
      // OPEN the lid to reach in — the access action for a lidded home/storage
      // box (stays open until the taker leaves; lets a graspless housemate use it).
      if (session.containers.get(step.objId) === "in") openContainerLid(session, cid, step.objId);
      let take = 0;
      const marketKey = session.marketStore.get(step.objId);
      if (marketKey) {
        take = Math.min(units, marketStoreUnits(session, step.objId));
        if (take === 0) {
          // Arrived to an EMPTY shelf (the abstract stock moved during the
          // walk) — cool this member off the good so it doesn't march out
          // and back empty-handed the moment the ledger flickers positive.
          session.shopCooldown.set(`${cid}|${step.goodKey}`, session.townClock + SHOP_RETRY_COOLDOWN_S);
        }
        if (take > 0) {
          session.marketConsumed.set(
            marketKey,
            addStoreConsumption(session.marketConsumed.get(marketKey), session.townClock, take),
          );
          // A shopper buys what it LIKES; no preference → a mixed basket.
          const liked = preferredOf(likes, kindsOf(step.goodKey));
          const basket = liked ? { [liked]: take } : dealGood(session.dress, step.goodKey, take, fnv1a(cid));
          for (const [k, n] of Object.entries(basket)) carried[k] = (carried[k] ?? 0) + n;
          session.needCarried.set(cid, carried);
        }
      } else {
        // From a stored container: draw the liked kind first, then the rest.
        // An AFFORDANCE row (fun's `play`) carries no goodKey, so its order is
        // whatever the box holds that DOES the thing — take the toy out.
        const stock = session.containerStock.get(step.objId) ?? {};
        const order = step.affords
          ? Object.keys(stock).filter((g) => (stock[g] ?? 0) > 0 && matchesNeedItem(g, { affords: step.affords }))
          : kindOrder(step.goodKey);
        for (const k of order) {
          while (take < units && (stock[k] ?? 0) > 0) {
            stock[k]! -= 1;
            if (stock[k]! <= 0) delete stock[k];
            carried[k] = (carried[k] ?? 0) + 1;
            take++;
          }
        }
        if (take > 0) {
          session.containerStock.set(step.objId, stock);
          session.needCarried.set(cid, carried);
        }
      }
      console.log(`[needs] ${cid} took ${take}×${step.goodKey || step.affords || step.tplKey} from ${step.objId}`);
    } else if (step.kind === "deposit" && step.objId) {
      // OPEN the lid to file it away — the access action for a lidded box (bug:
      // items were being put away THROUGH a shut lid). "on" surfaces have none.
      if (session.containers.get(step.objId) === "in") openContainerLid(session, cid, step.objId);
      const stock = session.containerStock.get(step.objId) ?? {};
      let put = 0;
      // The TIDY row deposits CLUTTER — whatever non-provisioned glyphs are in
      // hand (its goodKey is empty; the kinds loop below matches nothing).
      // Everything else banks through the CARRY projection (carryKindsOf), so
      // the deposit can empty exactly the hand ctx.carried counted — a treat
      // under a food row included (§4: a mismatch here is the no-op deposit).
      const kinds =
        step.tplKey === "tidy"
          ? Object.keys(carried).filter(
              (g) => !provisionedHeads(session, houseIndexOfCid(cid)).has(headOf(g)),
            )
          : [...carryKindsOf(step.goodKey)];
      for (const k of kinds) {
        while (put < step.units && (carried[k] ?? 0) > 0) {
          carried[k]! -= 1;
          if (carried[k]! <= 0) delete carried[k];
          stock[k] = (stock[k] ?? 0) + 1;
          dropOwnedInstances(session, cid, k, 1);
          // An "on" container SHOWS what was just set down (the served
          // meal steams on the tabletop; the pet bowl fills visibly).
          addVisibleContainedProp(session, step.objId, k);
          put++;
        }
      }
      if (put > 0) {
        session.needDepositFail.delete(`${cid}|${step.tplKey}`);
        session.containerStock.set(step.objId, stock);
        session.needCarried.set(cid, carried);
        showWorldBubble(state, `put:${cid}`, { anchor: { kind: "avatar", id: cid }, text: "", glyph: step.goodKey, ttl: 1.5 });
        console.log(`[needs] ${cid} deposited ${put}×${step.goodKey} into ${step.objId}`);
      } else {
        // A NO-OP deposit (§4 symptom B): arrived, reached, transferred nothing
        // — the hand emptied mid-walk or matched none of the step's kinds. The
        // walk stall-watch has a give-up; the deposit gets the same one: three
        // strikes and the hands are BANKED abstractly (the eviction completion)
        // instead of walking the same futile leg forever.
        const failKey = `${cid}|${step.tplKey}`;
        const strikes = (session.needDepositFail.get(failKey) ?? 0) + 1;
        if (strikes >= 3) {
          session.needDepositFail.delete(failKey);
          const banked = bankCarried(session, cid, houseIndexOfCid(cid));
          console.log(
            `[needs] ${cid} deposit no-op ×${strikes} on ${step.tplKey} @ ${step.objId} — GAVE UP, banked ${banked} carried`,
          );
        } else {
          session.needDepositFail.set(failKey, strikes);
          console.log(`[needs] ${cid} deposit no-op (${strikes}/3) on ${step.tplKey} @ ${step.objId}`);
        }
      }
    } else if (step.kind === "drop") {
      // PUT IT DOWN (the unload row's fallback — nowhere to file it, or a body
      // that can't open boxes at all). Each unit becomes a REAL loose prop at
      // the body's feet, registered in smallProps, so it re-enters the world
      // the tidy/fun rows can see rather than evaporating. Scatter slightly so
      // a multi-unit drop doesn't stack into one invisible pile.
      const av = state.avatars[cid];
      const order = kindOrder(step.goodKey === "" ? "" : step.goodKey);
      const held = order.filter((k) => (carried[k] ?? 0) > 0);
      // goodKey is empty for the untyped unload row — drop whatever is held.
      const glyphs = held.length > 0 ? held : Object.keys(carried).filter((k) => (carried[k] ?? 0) > 0);
      let dropped = 0;
      for (const glyph of glyphs) {
        while (dropped < step.units && (carried[glyph] ?? 0) > 0) {
          carried[glyph]! -= 1;
          if (carried[glyph]! <= 0) delete carried[glyph];
          if (av) {
            const a = (dropped * 2.399) % (Math.PI * 2); // deterministic scatter
            spawnLooseProp(session, glyph, av.x + Math.cos(a) * 0.35, av.y + Math.sin(a) * 0.35);
          }
          dropped++;
        }
      }
      if (dropped > 0) {
        session.needCarried.set(cid, carried);
        if (Object.keys(carried).length === 0) session.needCarried.delete(cid);
        console.log(`[needs] ${cid} PUT DOWN ${dropped}× (${glyphs.join(",")}) — nowhere to store it`);
      }
    } else if (step.kind === "equip") {
      // THE CHANGE OF CLOTHES: a clean garment in hand goes ON the body; the
      // one it was wearing comes OFF as a `.dirty` unit in the same hands —
      // which is all it takes to fire the laundry row next (carrying rule).
      const inHand = kindOrder(step.goodKey).filter((k) => (carried[k] ?? 0) > 0);
      if (inHand.length > 0) {
        const glyph = inHand[0]!;
        carried[glyph]! -= 1;
        if (carried[glyph]! <= 0) delete carried[glyph];
        dropOwnedInstances(session, cid, glyph, 1);
        const prev = session.worn.get(cid);
        if (prev) carried[`${prev.glyph}.dirty`] = (carried[`${prev.glyph}.dirty`] ?? 0) + 1;
        const n = (prev?.n ?? 0) + 1;
        session.worn.set(cid, { glyph, n });
        session.needCarried.set(cid, carried);
        session.needMeters.set(`${cid}|${step.tplKey}`, 0);
        // The VISIBLE swap: the render factory watches AvatarState.wearing
        // and re-dresses the body from the (cached) preset bake.
        const av = state.avatars[cid];
        if (av) av.wearing = wornOutfitIndex(cid, glyph, n);
        showWorldBubble(state, `wear:${cid}`, {
          anchor: { kind: "avatar", id: cid },
          text: "",
          glyph,
          ttl: 2,
        });
        console.log(`[needs] ${cid} changed into a ${glyph}${prev ? ` (doffed a dirty ${prev.glyph})` : ""}`);
      } else {
        // ARRIVED TO CHANGE WITH EMPTY HANDS (§4's symptom, equip edition): the
        // garment was banked, gifted away or evicted mid-walk. Silently doing
        // nothing here is what made "wear clothes" look broken — the body
        // walked over, stood there, and the meter stayed up, so it tried again
        // forever. Give it the deposit path's give-up: three strikes, then the
        // want is CLEARED and surfaced, so the dress row stops re-firing on a
        // garment that isn't coming.
        const failKey = `${cid}|${step.tplKey}`;
        const strikes = (session.needDepositFail.get(failKey) ?? 0) + 1;
        if (strikes >= 3) {
          session.needDepositFail.delete(failKey);
          session.needMeters.set(`${cid}|${step.tplKey}`, 0);
          console.log(`[needs] ${cid} equip no-op ×${strikes} on ${step.tplKey} — GAVE UP (nothing in hand to wear)`);
        } else {
          session.needDepositFail.set(failKey, strikes);
          console.log(`[needs] ${cid} equip no-op (${strikes}/3) on ${step.tplKey} — empty-handed at the change`);
        }
      }
    } else if (step.kind === "process") {
      // THE WASH / THE COOK (a transform's facet edit): every carried unit of
      // the step's type gets its state facet dropped/added — dirty shirts come
      // out clean, raw apples come out hot. The processed units are a
      // DIFFERENT type now, so this row stops firing on them and the put-away
      // row (stow / serve) takes over: type change = handoff. kindOrder (not
      // kindsOf) so a carried TREAT cooks too — a hot cookie is a meal.
      let done = 0;
      let sample: string | undefined;
      for (const k of kindOrder(step.goodKey)) {
        const nHeld = carried[k] ?? 0;
        if (nHeld <= 0) continue;
        let out = k;
        if (step.proc?.drop && out.split(".").includes(step.proc.drop)) {
          out = out
            .split(".")
            .filter((f, i) => i === 0 || f !== step.proc!.drop)
            .join(".");
        }
        if (step.proc?.add) {
          // Never double a facet (apple.hot.hot) — an already-transformed
          // unit in hand just stays what it is.
          if (out.split(".").includes(step.proc.add)) continue;
          out = `${out}.${step.proc.add}`;
        }
        delete carried[k];
        carried[out] = (carried[out] ?? 0) + nHeld;
        sample = out;
        done += nHeld;
      }
      if (done > 0) {
        session.needCarried.set(cid, carried);
        showWorldBubble(state, `wash:${cid}`, {
          anchor: { kind: "avatar", id: cid },
          text: step.proc?.add === "hot" ? "🍳" : "🫧",
          ...(sample ? { glyph: sample } : {}),
          ttl: 2,
        });
        console.log(`[needs] ${cid} processed ${done}×${step.goodKey} at ${step.objId ?? "?"} (${step.tplKey})`);
      }
    } else if (step.kind === "consume") {
      // Prefer the LIKED kind in hand; else the liked one WAITING at the station
      // (a table renders its contents — clear the visible prop too). A FOOD
      // want reaches for the HOT MEAL first (round 7): the cook's work is
      // worth eating — raw fruit is the fallback, never the preference.
      const eatOrder =
        step.goodKey === "food" ? [...kindOrder("meal"), ...kindOrder("food")] : kindOrder(step.goodKey);
      let eaten: string | undefined;
      const inHand = eatOrder.filter((k) => (carried[k] ?? 0) > 0);
      if (inHand.length > 0) {
        eaten = inHand[0]!;
        carried[eaten]! -= 1;
        if (carried[eaten]! <= 0) delete carried[eaten];
        session.needCarried.set(cid, carried);
        dropOwnedInstances(session, cid, eaten, 1);
      } else if (step.objId) {
        const stock = session.containerStock.get(step.objId) ?? {};
        const waiting = eatOrder.filter((k) => (stock[k] ?? 0) > 0);
        if (waiting.length > 0) {
          eaten = waiting[0]!;
          stock[eaten]! -= 1;
          if (stock[eaten]! <= 0) delete stock[eaten];
          session.containerStock.set(step.objId, stock);
          removeVisibleContainedProp(session, step.objId, eaten);
        }
      }
      // The body effect (empty the hunger/thirst row + digestion's waste bump)
      // is the shared ingest effect — same code a spoken "eat X" command runs.
      applyIngestEffect(session, cid, step.tplKey);
      // The effect is instant — hold a brief EAT body-visual so the meal is
      // SEEN (syncNeedActivities drives AvatarState.activity from this). A
      // meal eaten from a claimed CHAIR (§3.3) carries the seat along: the
      // show anchors a SIT on it (the body slides onto the seat, facing the
      // table the chair faces) instead of the standing eat. Gated ONCE here —
      // the diner must actually STAND at its chair (the chair is passthrough,
      // its center is the stand point); a give-up that consumed from afar
      // keeps the standing eat instead of sliding across the room.
      const seatId = (() => {
        if (!step.seatId) return undefined;
        const o = state.objects[step.seatId];
        const av = state.avatars[cid];
        return o && av && Math.hypot(av.x - o.x, av.y - o.y) <= 1.6 ? step.seatId : undefined;
      })();
      session.needEatShow.set(cid, { t: EAT_SHOW_S, objId: step.objId, ...(seatId ? { seatId } : {}) });
      showWorldBubble(state, `eat:${cid}`, {
        anchor: { kind: "avatar", id: cid },
        text: "",
        glyph: eaten ?? step.goodKey, // the bubble shows the fruit actually eaten
        ttl: 1.5,
      });
    }
  }

  /** A need target's world position: the streamed object when present, else (a dark
   *  house's chest — the gifted shopper walking home) its deterministic furniture spot. */
  function needObjectPos(
    session: QuestSession,
    state: WorldState,
    houseIndex: number,
    objId: string,
  ): { x: number; y: number } | null {
    const o = state.objects[objId];
    if (o) return { x: o.x, y: o.y };
    const m = objId.match(/^furn_(\d+)_chest_(.+)$/);
    if (!m) return null;
    const rc = residentTownCtx(session, Number(m[1])); // neighbor-aware
    const gi = rc ? rc.goods.findIndex((g) => g.good.key === m[2]) : -1;
    if (!rc?.house || gi < 0) return null;
    // rc.center is already in WINDOW coords, so the box spot lands there too.
    return goodBoxAt(rc.center, rc.house, rc.goods[gi]!.good.slot ?? gi);
  }

  /** Re-anchor ALL of a house's goods clocks to their real chest counts (§13 demote /
   *  the UNLOAD edge): the schedule resumes from whatever eating, restocking, thefts
   *  and gifts left in the boxes. */
  function reanchorHouseGoods(session: QuestSession, houseIndex: number) {
    const rc = residentTownCtx(session, houseIndex); // neighbor-aware: ITS clock
    const house = rc?.house;
    if (!rc || !house) return;
    for (const g of rc.goods) {
      const units = stackTotalOf(session.containerStock.get(`furn_${houseIndex}_chest_${g.good.key}`), g.good.key);
      g.reanchor(house, units, session.townClock);
    }
  }

  /** LOAD/UNLOAD edges of each house interior (§13a.3): while dark the SCHEDULE is the
   *  truth (seed the chests from it on reveal); while shown the CHESTS are the truth
   *  (re-anchor the schedule from them on conceal). Foreign glyphs a player stashed in
   *  a chest survive the reseed — only the good's own count re-syncs. */
  function stepHouseholdEdges(session: QuestSession, houseLoaded: (hi: number) => boolean) {
    const town = session.town;
    if (!town) return;
    for (const house of town.plan.houses) {
      const shown = houseLoaded(house.index);
      const was = session.houseShown.has(house.index);
      if (shown && !was) {
        session.houseShown.add(house.index);
        for (const g of town.stage.goods) {
          const objId = `furn_${house.index}_chest_${g.good.key}`;
          const level = Math.min(Math.floor(g.boxCap), Math.max(0, Math.round(g.pantry(house, session.townClock))));
          const stock = session.containerStock.get(objId) ?? {};
          for (const k of kindsOf(g.good.key)) delete stock[k]; // re-sync the good's own kinds only
          Object.assign(stock, dealGood(session.dress, g.good.key, level, house.index));
          session.containerStock.set(objId, stock);
        }
      } else if (!shown && was) {
        session.houseShown.delete(house.index);
        reanchorHouseGoods(session, house.index);
      }
    }
  }

  /** A table renders its contents: materialize one visible prop when a stack
   *  unit enters an "on" container (mirror of removeVisibleContainedProp —
   *  shared by the player's put and a creature's deposit). Registered in
   *  smallProps so the eat/take path can find and clear it; its containedIn
   *  keeps it off the tidy chore and the loose lists. */
  function addVisibleContainedProp(session: QuestSession, objId: string, glyph: string) {
    if (session.containers.get(objId) !== "on" || !world) return;
    const c = world.state.objects[objId];
    if (!c) return;
    const entityId = materialize(session, glyph, representativeOwnerCid(session.containerOwner.get(objId)));
    const pid = `small:${entityId}`;
    world.addObject({ id: pid, x: c.x, y: c.y, shape: "sphere", radius: 0.3, interactions: [], glyph });
    session.smallProps.set(pid, { entityId, glyph, at: session.townClock });
    placeInContainer(world.state, pid, objId, "on");
  }

  /** A table renders its contents: remove one matching visible prop when a stack unit
   *  leaves an "on" container (shared by the player's take and a creature's eat). */
  function removeVisibleContainedProp(session: QuestSession, objId: string, glyph: string) {
    if (session.containers.get(objId) !== "on" || !world) return;
    for (const [pObjId, rec] of session.smallProps) {
      if (rec.glyph === glyph && world.state.objects[pObjId]?.containedIn?.objectId === objId) {
        world.removeObject(pObjId);
        session.smallProps.delete(pObjId);
        if (session.creatures) delete session.creatures.world.items[rec.entityId];
        break;
      }
    }
  }

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
    // An ambient resident's SHOPPING want IS a conversation need (one behavior model,
    // npc-behavior-and-town-economy.md §8): a runner carries a resource-type need for
    // the good it shops (food/cloth); homebodies want nothing (small talk). This makes
    // its dialogue reflect what it's actually doing — while its BODY stays clock-driven
    // for now (residents are excluded from the goal loop below to avoid double-driving).
    const good = residentGood(session, residentId);
    const needs = good ? [{ itemId: `good:${good.key}`, value: 2, target: { category: good.key } }] : [];
    // Everyone LIKES a fruit (stable per person) — voices their food want as the
    // kind ("i_me want apple"), answers why through it, and picks it off shelves.
    // A DEFINED family member's authored likes win over the hash.
    const fm = familyMemberOf(session, Number(residentId.split("_")[1]), Number(residentId.split("_")[2]));
    const likes = fm?.likes?.length ? [...fm.likes] : [FOOD_KINDS[fnv1a(residentId) % FOOD_KINDS.length]!];
    // A quarter of the town has a sweet tooth — the rare import is IN DEMAND
    // ("i_me want cookie"), and there are never enough on the depot crate.
    if (!fm?.likes?.length && fnv1a(`${residentId}|treat`) % 4 === 0) likes.push(RARE_IMPORT_KIND);
    creatures.world.creatures[residentId] = createCreatureWorld([{ id: residentId, needs, likes }], [])
      .creatures[residentId]!;
    // Town common knowledge: every resident knows WHERE each good is bought, as a
    // provides FACT on the knowledge channel — so a decline to a "food" request
    // REDIRECTS to the market ("buy it there") instead of a bare no, and "where is
    // food?" answers even for a homebody. The place string is the host place-fact
    // subject `answerDirections` already resolves.
    if (session.town && session.creatures) {
      // A neighbor resident knows ITS OWN town's goods (same subject ids —
      // the answer geometry re-aims per answerer in answerDirections).
      const goods =
        residentTownCtx(session, Number(residentId.split("_")[1]))?.goods ?? session.town.stage.goods;
      for (const g of goods) {
        const subj = `buy:good:${g.good.key}`;
        if (session.placeFacts.has(subj)) {
          learnProvides(session.creatures.world, residentId, g.good.key, subj);
        }
      }
      // Everyone knows the rare import comes through the TRADE DEPOT — a
      // decline becomes a redirect there, and "where is cookie?" always answers.
      const rare = session.town.stage.trade?.route.rare.kind;
      if (rare && session.placeFacts.has(`buy:import:${rare}`)) {
        learnProvides(session.creatures.world, residentId, rare, `buy:import:${rare}`);
      }
    }
    const node: FulfillNode = {
      id: residentId,
      type: "fulfill",
      npcEntityId: `resident_face:${residentId}`,
    };
    creatures.creatureByNode.set(residentId, residentId);
    creatures.nodeByCreature.set(residentId, node);
  }

  function openCreatureConvo(nodeId: string, opts: { present?: boolean } = {}) {
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
    // `present: false` = the caller is about to run an act of its own (a
    // SPOKEN conversational move) — skip the greeting turn so the creature's
    // first line is the ANSWER, not "hi" talked over by the reply.
    if (opts.present !== false) presentCreatureTurn();
  }

  /** A board press answered the creature conversation. */
  function handleCreatureAct(index: number) {
    if (!convo) return;
    const act = convo.acts[index];
    if (act) runCreatureAct(act);
  }

  /** Run ONE dialogue act against the conversation partner — the shared path a board
   *  press takes. A SPOKEN sentence (mapped by `intentToAct`) drives the creature
   *  through this identical path, so speaking a request/question replies the same
   *  way picking it from the board would. */
  function runCreatureAct(act: DialogueAct) {
    const session = sess!;
    if (!convo || !session.creatures || !world) return;
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
    // GIFT to a townsperson (an accepted offer): the unit lands in its CARRIED stack
    // and the live need loop takes it from there — a hungry one eats it, a shopper
    // turns around and walks it home to the house box (doc §13; no clock special-case).
    if (act.kind === "offer" && res.responseGlyph === "thank_you" && convo.nodeId.startsWith("resident_")) {
      const glyph = act.itemId ? liveItemGlyph(session, act.itemId) : undefined;
      if (glyph) giftResidentGood(session, convo.nodeId, glyph);
    }
    if (res.close) {
      // A parting reaction (sad / ok / thanks) stays on screen after closing.
      if (res.responseGlyph) {
        const npcSym = node ? session.entities.get(node.npcEntityId)?.glyph : undefined;
        const at = poserPos(session, convo.nodeId);
        if (at && node) {
          showWorldBubble(world.state, `char:${node.npcEntityId}`, {
            anchor: { kind: "point", x: at.x, y: at.y },
            text: npcStatement(res.responseGlyph, npcSym, convo.nodeId),
            glyph: res.responseGlyph,
            ttl: 4,
          });
        }
        speakNpc(res.responseGlyph, npcSym, convo.nodeId);
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
        speakNpc(followUp, npcSym, nodeId);
        const delay = speechEstimateMs(npcStatement(res.responseGlyph ?? "", npcSym, nodeId));
        setTimeout(() => {
          if (!world || sess !== session) return;
          if (convo?.nodeId !== nodeId) return; // walked away
          const at = poserPos(session, nodeId);
          if (!at) return;
          showWorldBubble(world.state, `char:${node.npcEntityId}`, {
            anchor: { kind: "point", x: at.x, y: at.y },
            text: npcStatement(followUp, npcSym, nodeId),
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
    // Set an errand on the body, DOOR-ROUTED from where it actually stands right
    // now — inside a walled house a leg between rooms must line up with the real
    // doorway, not cut straight through a wall (npc-controller only slides on
    // walls, it never re-paths). Routing happens at start time so the live
    // position seeds it (a queued errand starts wherever the last one ended).
    const start = (e: NpcErrand) => {
      const at = host.state.avatars[npcId];
      host.setNpcErrand(npcId, at ? doorRouteErrand(host.state, { x: at.x, y: at.y }, e, host.npcRadiusOf(npcId)) : e);
    };
    const wrapped: NpcErrand = {
      ...errand,
      onDone: () => {
        errand.onDone?.();
        queue.shift();
        const next = queue[0];
        if (next) start(next);
      },
    };
    queue.push(wrapped);
    if (queue.length === 1) start(wrapped);
  }

  /** Expand an errand's waypoints so every leg that crosses a room boundary
   *  passes THROUGH the connecting doorway (routeThroughDoors). Inserted transit
   *  points fire no callback; the original `onArrive(index)` is remapped to the
   *  new index of each ORIGINAL waypoint so the world effects still land. */
  /** Splice the STREET route between two world points into a leg: people take roads,
   *  not chords across the block (and a building on the chord is exactly how they got
   *  stuck). Only legs long enough to plausibly cross a building are routed (the clock
   *  trips' own walkTo lists are already dense road points — their short legs pass
   *  through untouched); the leg's endpoint stays EXACT so arrive radii and dwell
   *  fire where the caller intended. Off-town (no street net) it's a no-op. */
  function roadLeg(
    session: QuestSession,
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): Array<{ x: number; y: number }> {
    const ROAD_LEG_MIN = 8;
    const town = session.town;
    if (!town || Math.hypot(b.x - a.x, b.y - a.y) < ROAD_LEG_MIN) return [b];
    const c = town.stage.center;
    const local = roadRoute(
      town.plan.streets,
      { x: a.x - c.x, y: a.y - c.y },
      { x: b.x - c.x, y: b.y - c.y },
    );
    if (local.length < 2) return [b];
    // Drop the route's own endpoints (≈a, ≈b) — keep the street waypoints between.
    return [...local.slice(1, -1).map((p) => ({ x: p.x + c.x, y: p.y + c.y })), b];
  }

  function doorRouteErrand(
    state: WorldState,
    startPos: { x: number; y: number },
    errand: NpcErrand,
    /** The MOVER's collision radius (worldHost.npcRadiusOf) — the leg planner
     *  must probe at exactly the girth locomotion enforces. */
    bodyR?: number,
  ): NpcErrand {
    const points: NpcErrandPoint[] = [];
    const origIndexAt: number[] = [];
    let prev: { x: number; y: number } = startPos;
    errand.points.forEach((pt, origIdx) => {
      // Street-route the leg first (people take roads), then thread each sub-leg
      // through real doorways — leaving a building always means door → street.
      // NEVER road-route a leg that starts AND ends inside the SAME building —
      // or the same HOUSE (rooms are separate buildings since round 4): an
      // indoor walk longer than the road-leg threshold (bed → chest, bedroom →
      // kitchen) was getting street waypoints — the member marched out the
      // door, along the lane and back in, for a trip across its own home.
      // routeThroughDoors (below) threads the interior doorways.
      const bA = buildingAt(state, prev.x, prev.y);
      const bB = buildingAt(state, pt.x, pt.y);
      const hA = bA ? houseIndexOfBuildingId(bA.id) : null;
      const indoorLeg =
        !!bA && !!bB && (bA.id === bB.id || (hA !== null && hA === houseIndexOfBuildingId(bB.id)));
      const via = sess && !indoorLeg ? roadLeg(sess, prev, pt) : [pt];
      via.forEach((q, vi) => {
        const isFinal = vi === via.length - 1;
        // THE INDOOR LEG PLANNER (floor-route.ts routeIndoorAware): door
        // threading + furniture-aware transit pairs (tight pass-through
        // arrivals) + dogleg corners around mid-room furniture. ONE assembly,
        // shared with the headless tests — never restate it here.
        const legs = routeIndoorAware(state, prev, q, bodyR);
        legs.forEach((p, i) => {
          const isEndpoint = isFinal && i === legs.length - 1;
          points.push({
            x: p.x,
            y: p.y,
            ...(isEndpoint ? {} : { arrive: p.arrive ?? 0.9 }),
            ...(isEndpoint && pt.dwell ? { dwell: pt.dwell } : {}),
          });
          origIndexAt.push(isEndpoint ? origIdx : -1);
        });
        prev = q;
      });
    });
    const onArrive = errand.onArrive;
    return {
      points,
      ...(onArrive
        ? {
            onArrive: (i: number) => {
              const o = origIndexAt[i];
              if (o !== undefined && o >= 0) onArrive(o);
            },
          }
        : {}),
      ...(errand.onDone ? { onDone: errand.onDone } : {}),
    };
  }

  /** Does this NPC's body currently hold an object? (One at a time.) */
  function npcCarrying(npcId: string): string | undefined {
    if (!world) return undefined;
    return Object.values(world.state.objects).find((o) => o.carriedBy === npcId)?.id;
  }

  /** entityId → the live world OBJECT that embodies it: a staged converse item
   *  or a loose small prop. Null = the entity has no physical body right now. */
  function objIdOfEntity(session: QuestSession, entityId: string): string | null {
    for (const [objId, it] of session.convItems) if (it.entityId === entityId) return objId;
    for (const [objId, rec] of session.smallProps) if (rec.entityId === entityId) return objId;
    return null;
  }

  /** avatar id → creature id (the inverse of `avatarIdOf`).
   *
   *  A RIDDEN body answers as the PLAYER: one body has two candidate creatures
   *  while claimed, and the spark wins because the creature's own agency is
   *  suspended for the duration. So a thing carried by the body you ride is
   *  carried by YOU (`carriedBy` is stamped with the driven body's id) — the
   *  same reason `avatarIdOf` resolves the player to that body. Released, the
   *  body answers as its own creature again. */
  function creatureOfAvatar(avatarId: string): string {
    if (avatarId === PLAYER_ID) return PLAYER_CREATURE_ID;
    if (world && avatarId === world.drivenBody()) return PLAYER_CREATURE_ID;
    return avatarId.startsWith("npc_") ? avatarId.slice(4) : avatarId;
  }

  /** Stow a CARRIED object into a container, mirroring the player's own put
   *  semantics: a loose prop dissolves into the container's STACK ("on" keeps
   *  it visible on the surface); a staged QUEST item stays an instance and is
   *  really contained, so the placement watchers (placeDests) see it. */
  function stowCarriedIn(session: QuestSession, objId: string, containerObjId: string): boolean {
    if (!world) return false;
    if (
      session.marketStore.has(containerObjId) ||
      session.produceBox.has(containerObjId) ||
      containerObjId.startsWith("trade:")
    ) {
      return false; // economy-driven stock takes no puts (same rule as putSelectedIn)
    }
    const rel = session.containers.get(containerObjId);
    const o = world.state.objects[objId];
    if (!rel || !o) return false;
    dropObject(world.state, objId, o.x, o.y); // release the carry first
    const small = session.smallProps.get(objId);
    if (!small) {
      placeInContainer(world.state, objId, containerObjId, rel);
      return true;
    }
    const stock = session.containerStock.get(containerObjId) ?? {};
    stackAdd(stock, small.glyph);
    session.containerStock.set(containerObjId, stock);
    if (rel === "on") {
      placeInContainer(world.state, objId, containerObjId, "on"); // visible on the table
    } else {
      world.removeObject(objId);
      session.smallProps.delete(objId);
      if (session.creatures) {
        delete session.creatures.world.items[small.entityId];
        for (const cr of Object.values(session.creatures.world.creatures)) {
          delete cr.knowledge[small.entityId];
        }
      }
    }
    return true;
  }

  /** Run one of a compiled goal's action steps (pick/give/place) as a world effect —
   *  the `onArrive` payload for the errand `issueGoalPlan` builds. Movement is the
   *  waypoints; these are the things the creature DOES on arriving. */
  /** A SOCIAL act lands (a hug — commanded or rule-fired): warmth BOTH ways,
   *  both loneliness meters ease, hearts over both heads. The one place hug
   *  semantics live — spirit hugs and walked-over hugs share it. */
  function applySocialAct(session: QuestSession, from: string, to: string, act: string) {
    if (!world) return;
    // The act eases the MOTIVE it serves — playing together fills fun, a
    // hug/chat fills social. Both warm the relation the same way.
    const meter = act === "play" ? "fun" : "social";
    if (from !== PLAYER_CREATURE_ID) {
      warmRelations(session, from, to, { affinity: 0.08, trust: 0.03 });
      session.needMeters.set(`${from}|${meter}`, 0);
    }
    warmRelations(session, to, from, { affinity: 0.08, trust: 0.03 });
    session.needMeters.set(`${to}|${meter}`, 0);
    for (const c of [from, to]) {
      const av = world.state.avatars[avatarIdOf(c)];
      if (!av) continue;
      showWorldBubble(world.state, `${act}:${c}`, { anchor: { kind: "avatar", id: avatarIdOf(c) }, text: "💗", ttl: 2.5 });
    }
    console.log(`[social] ${from} ${act} ${to}`);
  }

  /** Fire the reach rig on an NPC body: PICKUP on taking (reach → grasp →
   *  lift, then the held carry pose), PUTDOWN on setting down (lower →
   *  release). The animator no-ops when the pose doesn't apply, so callers
   *  fire unconditionally. `at` = the box / floor spot being reached toward. */
  /** Seconds a discrete action takes: crouch DOWN → touch (effect at mid) → rise. */
  const ACTION_DUR_S = 0.8;

  /** Perform a discrete action as a CROUCH-IN-PLACE beat (concept-parser.md §10.2):
   *  pin the body where it stands and land `apply` at the crouch MIDPOINT — never
   *  mid-stride. Both driving loops (stepPursuit, stepNeeds) leave a body
   *  alone while it holds one, so an action and its animation stay welded: the
   *  creature stops, crouches, touches the thing as the effect fires, and rises.
   *  A fresh call REPLACES any half-done hold on the same body. */
  function beginAction(session: QuestSession, cid: string, label: string, apply: () => void) {
    const npcId = avatarIdOf(cid);
    const av = world?.state.avatars[npcId];
    // Pin in place for the crouch so a residual/ stale errand can't drag the body
    // around while its action animation plays (the "moving while using" bug).
    if (av && world) world.setNpcErrand(cid, { points: [{ x: av.x, y: av.y, dwell: ACTION_DUR_S + 0.2 }] });
    session.actionHold.set(cid, { t: 0, dur: ACTION_DUR_S, applied: false, apply, label });
  }

  /** Advance every action hold: at the crouch MIDPOINT the effect lands ONCE
   *  (`applied` guards it), and at the end the hold clears so the owning loop
   *  resumes and re-plans from the now-updated world. */
  function stepActionHolds(session: QuestSession, dt: number) {
    for (const [cid, h] of [...session.actionHold]) {
      h.t += dt;
      if (!h.applied && h.t >= h.dur * 0.5) {
        h.applied = true;
        h.apply();
      }
      if (h.t >= h.dur) session.actionHold.delete(cid);
    }
  }

  function fireCarryGesture(npcId: string, kind: "pickup" | "putdown", at?: { x: number; y: number }) {
    const av = world?.state.avatars[npcId];
    if (!av) return;
    av.gesture = {
      kind,
      targetX: at ? at.x : av.x + av.fx,
      targetY: at ? at.y : av.y + av.fy,
      holdS: 0,
      id: ++gestureSeq,
    };
  }

  /** The registered TRANSFORM station whose `applies` IS `state` (fire → hot,
   *  water tub → cold), nearest `near` when given. `session.stations` are the
   *  town's item-transform stations (the drop-on-station swap, §8); a commanded
   *  "cook/cool the X" walks the item to one and works it. */
  function nearestStationApplying(
    session: QuestSession,
    state: string,
    near: { x: number; y: number } | null,
  ): QuestSession["stations"][number] | undefined {
    let best: QuestSession["stations"][number] | undefined;
    let bestD = Infinity;
    for (const st of session.stations) {
      if (st.applies !== state) continue;
      const o = world?.state.objects[st.objectId];
      if (!o) continue;
      const d = near ? Math.hypot(o.x - near.x, o.y - near.y) : 0;
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    return best;
  }

  function applyGoalStep(session: QuestSession, cid: string, step: GoalStep) {
    if (!world) return;
    const npcId = avatarIdOf(cid); // residents wear their bare cid — never `npc_resident_*`
    if (step.kind === "socialAct") {
      applySocialAct(session, cid, step.target, step.act);
      return;
    }
    if (step.kind === "pick") {
      // A `stock:` ref (container-stacked unit): withdraw one and MATERIALIZE
      // it into the hand — how "get the apple" reaches into the pantry.
      if (step.itemId.startsWith("stock:")) {
        if (npcCarrying(npcId)) return;
        const [boxId, glyph] = step.itemId.slice(6).split("|") as [string, string];
        // A commanded body meets the same social stop-gate as the player's
        // own hand (ownership.ts): foreign PRIVATE property is refused
        // while an owner is nearby to object.
        const bOwner = session.containerOwner.get(boxId);
        if (isPrivateOwner(bOwner) && !mayUse(cid, houseIndexOfCid(cid), bOwner)) {
          const objector = objectingOwner(bOwner, world.state.objects[boxId]);
          if (objector) {
            refusePrivateTake(session, boxId, glyph, objector);
            return;
          }
        }
        // OPEN the lid to reach in — the access action (a lidded box); it stays
        // open until the taker leaves (stepContainerLids) or "shut".
        if (session.containers.get(boxId) === "in") openContainerLid(session, cid, boxId);
        const stock = session.containerStock.get(boxId) ?? {};
        if ((stock[glyph] ?? 0) <= 0) return; // emptied during the walk — re-command re-resolves
        stock[glyph]! -= 1;
        if (stock[glyph]! <= 0) delete stock[glyph];
        session.containerStock.set(boxId, stock);
        removeVisibleContainedProp(session, boxId, glyph);
        const body = world.state.avatars[npcId];
        const at = body ?? world.state.objects[boxId];
        if (!at) return;
        spawnLooseProp(session, glyph, at.x, at.y);
        const newObj = [...session.smallProps.keys()].pop();
        if (newObj) carryObject(world.state, newObj, npcId);
        fireCarryGesture(npcId, "pickup", world.state.objects[boxId]);
        return;
      }
      const o = objIdOfEntity(session, step.itemId);
      if (o && !npcCarrying(npcId)) {
        const at = world.state.objects[o];
        // The FROM-AUTHORIZED hand-to-hand take ("take ball from dog"): the
        // planner named the source creature, so its held item is released
        // into the taker's hands. Any OTHER holder keeps it (carryObject
        // refuses a carried object — the planner never authorizes those).
        const holderAv = at?.carriedBy;
        if (holderAv && holderAv !== npcId) {
          if (step.from === undefined || holderAv !== avatarIdOf(step.from)) return;
          dropObject(world.state, o, at!.x, at!.y);
          const cworld = session.creatures?.world;
          if (cworld?.items[step.itemId]) putDownItem(cworld, step.from, step.itemId);
        }
        // A REAL prop resting INSIDE a lidded box (not just stock): OPEN the lid
        // to lift it out — the access action (bug: items taken through a shut
        // lid). "on" surfaces and loose props have no lid to work.
        const boxId = at?.containedIn?.objectId;
        if (boxId && session.containers.get(boxId) === "in") openContainerLid(session, cid, boxId);
        carryObject(world.state, o, npcId);
        fireCarryGesture(npcId, "pickup", at);
      }
      return;
    }
    if (step.kind === "drop") {
      // Set the HELD item down where the body stands (physical release). Reuses
      // the same ground-putdown as a give-with-no-recipient; relinquishes the
      // creature-world claim so the item goes loose (tidyable, takeable).
      const o = objIdOfEntity(session, step.itemId);
      const c = o ? world.state.objects[o] : undefined;
      if (!o || c?.carriedBy !== npcId) return;
      dropObject(world.state, o, c.x, c.y);
      fireCarryGesture(npcId, "putdown", { x: c.x, y: c.y });
      const cworld = session.creatures?.world;
      if (cworld?.items[step.itemId]) putDownItem(cworld, cid, step.itemId);
      return;
    }
    if (step.kind === "withdraw" || step.kind === "stow") {
      // THE STACK ECONOMY'S MANIPULATION ARMS (S3): move `units` between the
      // reached store and the abstract bag by DELEGATING to the needs walker's
      // own effects — market ledger + purse, the well's free draw, loose-prop
      // pickup, lid access, carry-bound clamping, the deposit's no-op strikes
      // and give-up banking all live there and stay the single source of truth.
      applyNeedStepEffect(session, world.state, cid, {
        tplKey: step.tplKey ?? "command",
        kind: step.kind === "withdraw" ? "take" : "deposit",
        goodKey: step.goodKey,
        ...(step.kind === "withdraw" && step.affords ? { affords: step.affords } : {}),
        objId: step.kind === "withdraw" ? step.fromId : step.intoId,
        units: step.units,
      });
      return;
    }
    if (step.kind === "processStack") {
      // THE WASH / THE COOK as a pursuit dwell (S3 slice 2): the facet edit
      // lands on the carried units (the delegated process effect — its own
      // bubble: 🫧/🍳), and the body dwells POSED at the station for the work's
      // length. The pose show holds the needs decide until the dwell ends, so
      // the follow-up row (stow the clean shirts, serve the meal) fires as the
      // body straightens up — the legacy sequence, on the unified engine.
      const state = world.state;
      const body = state.avatars[npcId];
      if (!body) return;
      applyNeedStepEffect(session, state, cid, {
        tplKey: step.tplKey ?? "command",
        kind: "process",
        goodKey: step.goodKey,
        objId: step.atId,
        units: 1,
        proc: { ...(step.drop ? { drop: step.drop } : {}), ...(step.add ? { add: step.add } : {}) },
      });
      const dwell = step.dwellS ?? WASH_DWELL_S;
      session.needStep.delete(cid);
      session.npcTasks.delete(npcId);
      session.needPoseShow.set(cid, { t: dwell, kind: "sit" });
      enqueueNpcErrand(session, npcId, { points: [{ x: body.x, y: body.y, dwell }] });
      return;
    }
    if (step.kind === "equipStack") {
      // The change of clothes over the BAG model (dress's own equip — doffs the
      // worn garment as a `.dirty` unit in hand, clears the dress meter, shows
      // the swap; empty-handed no-ops strike toward the give-up).
      applyNeedStepEffect(session, world.state, cid, {
        tplKey: step.tplKey ?? "command",
        kind: "equip",
        goodKey: step.goodKey,
        units: 1,
      });
      return;
    }
    if (step.kind === "dropStack") {
      // Put the carried units DOWN as real loose props at the feet.
      applyNeedStepEffect(session, world.state, cid, {
        tplKey: step.tplKey ?? "command",
        kind: "drop",
        goodKey: step.goodKey,
        units: step.units,
      });
      return;
    }
    if (step.kind === "consumeStack") {
      // EAT FROM THE BAG (S4): the pursuit walked the body to its dining spot
      // (or nowhere — eating in place). Resolve the station actually reached —
      // the nearest `at`-kind fixture within arm's reach — so the delegated
      // consume can ALSO draw a unit waiting there, and try for a free chair
      // (the §3.3 seat show; apply-time gated like every seat). The consume
      // effect owns the rest: liked-kind order, ingest, the eat show, digestion.
      const state = world.state;
      const av = state.avatars[npcId];
      let stId: string | undefined;
      for (const kind of step.at ?? []) {
        for (const spec of state.spec.objects) {
          if (spec.fixture !== kind && !spec.id.split(/[_:]/).includes(kind)) continue;
          const o = state.objects[spec.id];
          if (!o || !av) continue;
          if (Math.hypot(o.x - av.x, o.y - av.y) <= spec.radius + 1.8) {
            stId = spec.id;
            break;
          }
        }
        if (stId) break;
      }
      const seat = av && stId ? freeSeatAt(session, state, cid, stId) : null;
      applyNeedStepEffect(session, state, cid, {
        tplKey: step.tplKey ?? "command",
        kind: "consume",
        goodKey: step.goodKey,
        ...(stId ? { objId: stId } : {}),
        ...(seat ? { seatId: seat.id } : {}),
        units: 1,
      });
      return;
    }
    if (step.kind === "eat") {
      // CONSUME the specific item on arrival ("eat the banana"): a brief
      // reach-to-mouth cue, then the thing is used up — removeLooseProp clears
      // both the visible prop and the creature-world item, so it can't be
      // eaten twice or asked-after. Reaching for it from the hand or the
      // ground both land here (the planner walked the body over first).
      const glyph = liveItemGlyph(session, step.itemId);
      const head = (headOf(glyph)).toLowerCase();
      const o = objIdOfEntity(session, step.itemId);
      if (o) {
        const at = world.state.objects[o];
        fireCarryGesture(npcId, "pickup", at ? { x: at.x, y: at.y } : undefined);
        removeLooseProp(session, o);
      }
      // THE INGEST EFFECT is bound to the action, not to the need machinery:
      // if the eater runs a matching hunger/thirst row it empties (the meter
      // key already carries the template), so "you eat the banana" satisfies
      // hunger exactly as the creature eating on its own would. A body with no
      // such row just eats. Same applyIngestEffect the need path calls.
      const prefix = DRINK_GLYPHS.has(head) ? "thirst:" : "hunger:";
      const meterKey = [...session.needMeters.keys()].find((k) => k.startsWith(`${cid}|${prefix}`));
      if (meterKey) applyIngestEffect(session, cid, meterKey.slice(cid.length + 1));
      // THE MEAL IS SEEN (parity with the needs consume): a brief EAT visual —
      // and when the body stands at a table with a free chair, the show anchors
      // a SIT on it (the §3.3 dinner scene, now for every eater: a commanded
      // "you eat" and a need-born consume alike). No claim bookkeeping here —
      // freeSeatAt reads needStep claims and seated bodies, so a transient
      // double-book between two same-window pursuit diners is possible and
      // purely visual.
      const av = world.state.avatars[npcId];
      if (av) {
        let seatId: string | undefined;
        let tableId: string | undefined;
        for (const spec of world.state.spec.objects) {
          if (spec.fixture !== "table") continue;
          const t = world.state.objects[spec.id];
          if (!t || Math.hypot(t.x - av.x, t.y - av.y) > spec.radius + 1.8) continue;
          tableId = spec.id;
          const seat = freeSeatAt(session, world.state, cid, spec.id);
          if (seat && Math.hypot(av.x - seat.x, av.y - seat.y) <= 1.6) seatId = seat.id;
          break;
        }
        session.needEatShow.set(cid, { t: EAT_SHOW_S, ...(tableId ? { objId: tableId } : {}), ...(seatId ? { seatId } : {}) });
        showWorldBubble(world.state, `eat:${cid}`, {
          anchor: { kind: "avatar", id: npcId },
          text: "",
          glyph: head,
          ttl: 1.5,
        });
      }
      return;
    }
    if (step.kind === "toggle") {
      // OPEN / SHUT a DEVICE as a real body action ("you open the window") —
      // the persistent creature-world toggle (toggleDevice: a states array with
      // antonyms open↔closed / on↔off), now driven by a BODY that reached the
      // device rather than only the player's gaze (quest-host §8). The state
      // STAYS until toggled back. PHYSICAL doors + containers are a separate
      // open-state (a later phase); this covers device items (windows, lamps).
      const cworld = session.creatures?.world;
      const dev = cworld?.items[step.deviceId];
      if (cworld && dev?.device) {
        toggleDevice(cworld, cid, step.deviceId, step.state);
        const o = objIdOfEntity(session, step.deviceId);
        fireCarryGesture(npcId, "pickup", o ? world.state.objects[o] : undefined); // a reach at the device
      }
      return;
    }
    if (step.kind === "transform") {
      // COOK / COOL as a body action AT A TRANSFORM STATION (concept-parser §10
      // primitive): the body holds the item, stands at the station granting the
      // wanted state, and the crouch swaps its facet. Same `useStation` the
      // drop-on-station path runs (§8), so a commanded "cook the apple" and an
      // apple set on the fire compose the IDENTICAL glyph. House cooking/laundry
      // stay on the needs `processAt` path (carried-unit stacks) — untouched.
      let o = objIdOfEntity(session, step.itemId);
      if (!o || world.state.objects[o]?.carriedBy !== npcId) {
        // Stale/desynced id — transform the REAL prop in hand (give/place's rule).
        o = null;
        for (const [objId] of session.smallProps) {
          if (world.state.objects[objId]?.carriedBy === npcId) {
            o = objId;
            break;
          }
        }
      }
      if (!o || !session.creatures) return; // empty-handed — nothing to transform
      const body = world.state.avatars[npcId];
      const st = nearestStationApplying(session, step.state, body ? { x: body.x, y: body.y } : null);
      if (!st) return; // no station grants this state here — the pursuit spoke the reason
      const entityId = session.smallProps.get(o)?.entityId ?? session.convItems.get(o)?.entityId ?? step.itemId;
      const events = useStation(session.creatures.world, entityId, st.applies, st.removes, st.powerDeviceId);
      if (!events.length) return; // wrong direction / unpowered — a no-op, re-plan next tick
      const newGlyph = liveItemGlyph(session, entityId);
      const specObj = world.state.spec.objects.find((ob) => ob.id === o);
      if (specObj) specObj.glyph = newGlyph; // render3d re-rasters the icon
      const rec = session.smallProps.get(o);
      if (rec) rec.glyph = newGlyph; // later lookups (eat/tidy/give) see the new type
      const stObj = world.state.objects[st.objectId];
      fireCarryGesture(npcId, "pickup", stObj ? { x: stObj.x, y: stObj.y } : undefined); // a reach at the station
      showWorldBubble(world.state, `transform:${cid}`, {
        anchor: { kind: "avatar", id: npcId },
        text: st.applies === "hot" ? "🍳" : "🫧",
        glyph: newGlyph,
        ttl: 2,
      });
      return;
    }
    if (step.kind === "rest") {
      // OCCUPY the station and DWELL posed — the REST primitive (concept-parser
      // §10). The pursuit already WALKED the body here, so pose it in place: the
      // nearest rest fixture within reach sets the pose (bed → sleep, box →
      // play, else sit), the same `needPoseShow` channel "you sit" uses so the
      // body is visibly stationary. A dwell errand PINS it for the spell (else
      // the wander behavior walks it off mid-animation). One dwell, then the
      // pursuit ends — the needs walker keeps its own meter-clearing rest.
      const state = world.state;
      const body = state.avatars[npcId];
      if (!body) return;
      const REST_FIXTURES = new Set(["bed", "chair", "box", "bath", "privy"]);
      let stObjId: string | undefined;
      let stKind: string | undefined;
      let bestD = 2.2;
      for (const spec of state.spec.objects) {
        if (!spec.fixture || !REST_FIXTURES.has(spec.fixture)) continue;
        const o = state.objects[spec.id];
        if (!o) continue;
        const d = Math.hypot(o.x - body.x, o.y - body.y);
        if (d < bestD) {
          bestD = d;
          stObjId = spec.id;
          stKind = spec.fixture;
        }
      }
      // The goal's own pose wins (a doze in the open is a SLEEP, fun's toy-play
      // a PLAY — no fixture nearby to say so); else derive from what's reached.
      const pose: AvatarActivityKind =
        step.pose ?? (stKind === "bed" ? "sleep" : stKind === "box" ? "play" : "sit");
      const dwell = step.dwellS ?? REST_CMD_DWELL_S; // a need's nap vs the commanded-sit default
      session.needStep.delete(cid);
      session.npcTasks.delete(npcId);
      session.needPoseShow.set(cid, { t: dwell, kind: pose, ...(stObjId ? { objId: stObjId } : {}) });
      enqueueNpcErrand(session, npcId, { points: [{ x: body.x, y: body.y, dwell }] });
      session.lastDrive.set(npcId, "command");
      showWorldBubble(state, `rest:${cid}`, {
        anchor: { kind: "avatar", id: npcId },
        text: pose === "sleep" ? "😴" : pose === "play" ? "🎲" : "🛋️",
        ttl: 2,
      });
      return;
    }
    if (step.kind === "openClose") {
      // OPEN / SHUT a container LID as a body action (task 22): the physical
      // open-state (`heldOpen`), promoted from a pick/place side-effect to a
      // first-class primitive. A command PINS the lid (`containerPinned`) so it
      // stays open with nobody near — until "shut" or the pin is cleared. The
      // pursuit already walked the body here; act on the nearest LIDDED box it
      // reached ("on" surfaces have no lid). Capability was gated at plan time
      // (a graspless body never regresses this step).
      const state = world.state;
      const body = state.avatars[npcId];
      if (!body) return;
      let boxId: string | undefined;
      let bestD = 2.4;
      for (const [id, rel] of session.containers) {
        if (rel !== "in") continue; // only lidded boxes have an open-state
        const o = state.objects[id];
        if (!o) continue;
        const d = Math.hypot(o.x - body.x, o.y - body.y);
        if (d < bestD) {
          bestD = d;
          boxId = id;
        }
      }
      if (!boxId) return; // nothing lidded within reach — re-plan / part aloud
      if (step.open) {
        openContainerLid(session, cid, boxId, true); // PIN — a command keeps it open
      } else {
        session.containerPinned.delete(boxId); // release the pin, then shut
        const o = state.objects[boxId];
        if (o) o.heldOpen = false;
        fireCarryGesture(npcId, "pickup", o ? { x: o.x, y: o.y } : undefined);
      }
      showWorldBubble(state, `open:${cid}`, {
        anchor: { kind: "avatar", id: npcId },
        text: step.open ? "📂" : "📁",
        ttl: 2,
      });
      return;
    }
    if (step.kind === "equip") {
      // THE CHANGE OF CLOTHES (command): the clean garment in hand goes ON the
      // body; the one it was wearing comes OFF as a loose `.dirty` prop at the
      // feet — the laundry chain's first link (a body/housemate then washes it).
      // Mirrors the needs `equip` effect (session.worn + av.wearing + dress-meter
      // clear), but on the PHYSICAL held prop rather than the needCarried stack.
      const state = world.state;
      const av = state.avatars[npcId];
      if (!av) return;
      // Resolve the garment actually in hand (named, else the real prop in hand).
      let o = objIdOfEntity(session, step.itemId);
      if (!o || state.objects[o]?.carriedBy !== npcId) {
        o = null;
        for (const [objId] of session.smallProps) {
          if (state.objects[objId]?.carriedBy === npcId) {
            o = objId;
            break;
          }
        }
      }
      if (!o) return; // empty-handed — nothing to wear
      const glyph = session.smallProps.get(o)?.glyph ?? liveItemGlyph(session, step.itemId);
      // Keep the FULL clean garment signature (head + colour, minus any state
      // facet) so the doffed unit and the visible re-dress carry the colour —
      // e.g. "wear + shirt + red" dons `shirt.color_red`, not a bare `shirt`.
      const gf = glyphFacets(glyph);
      const wornGlyph = [gf.kind, ...gf.descriptors].join(".");
      // Doff the previous garment as a loose DIRTY unit at the feet (washable).
      const prev = session.worn.get(cid);
      if (prev) spawnLooseProp(session, `${prev.glyph}.dirty`, av.x + 0.3, av.y + 0.3);
      removeLooseProp(session, o); // the held garment is now worn — consume the prop
      const n = (prev?.n ?? 0) + 1;
      session.worn.set(cid, { glyph: wornGlyph, n });
      av.wearing = wornOutfitIndex(cid, wornGlyph, n); // the visible re-dress
      // Clear a DRESS meter if this body runs one (like ingest clears hunger).
      const dressKey = [...session.needMeters.keys()].find((k) => k.startsWith(`${cid}|dress`));
      if (dressKey) session.needMeters.set(dressKey, 0);
      fireCarryGesture(npcId, "pickup", { x: av.x, y: av.y });
      showWorldBubble(state, `wear:${cid}`, { anchor: { kind: "avatar", id: npcId }, text: "", glyph: wornGlyph, ttl: 2 });
      return;
    }
    if (step.kind === "color") {
      // THE RECOLOUR (command): swap the colour facet of the held item at the
      // coloring tub — `shirt.color_blue` → `shirt.color_red`, a colourless
      // `shirt` → `shirt.color_red` (variations.withVariation, kind-agnostic, so
      // the same verb tints any item later). Mirrors the `transform` arm's
      // in-hand glyph mutation, but the swap is a VARIATION not a state.
      const state = world.state;
      const av = state.avatars[npcId];
      if (!av) return;
      // Resolve the item actually in hand (named, else the real prop held).
      let o = objIdOfEntity(session, step.itemId);
      if (!o || state.objects[o]?.carriedBy !== npcId) {
        o = null;
        for (const [objId] of session.smallProps) {
          if (state.objects[objId]?.carriedBy === npcId) {
            o = objId;
            break;
          }
        }
      }
      if (!o) return; // empty-handed — nothing to colour
      const entityId = session.smallProps.get(o)?.entityId ?? session.convItems.get(o)?.entityId ?? step.itemId;
      // Swap the colour on the CANONICAL item so every later lookup (wear, give,
      // tidy) sees the new colour; keep head + other facets + state.
      const ent = session.entities.get(entityId);
      const cur = ent?.glyph ?? session.smallProps.get(o)?.glyph ?? liveItemGlyph(session, entityId);
      const recolored = withVariation(cur, step.color);
      if (ent) ent.glyph = recolored;
      const newGlyph = ent ? liveItemGlyph(session, entityId) : recolored;
      const specObj = state.spec.objects.find((ob) => ob.id === o);
      if (specObj) specObj.glyph = newGlyph; // render3d re-rasters the icon
      const rec = session.smallProps.get(o);
      if (rec) rec.glyph = newGlyph; // later lookups see the new colour
      fireCarryGesture(npcId, "pickup", { x: av.x, y: av.y }); // a reach at the tub
      showWorldBubble(state, `color:${cid}`, {
        anchor: { kind: "avatar", id: npcId },
        text: "🎨",
        glyph: newGlyph,
        ttl: 2,
      });
      return;
    }
    if (step.kind === "converse") {
      // TALK TO the partner (command CONVERSE): a real exchange — gossip spreads,
      // relations warm, both loneliness meters ease. Same effect the needs
      // `socialize` step runs; RE-VERIFY the partner is still here (it may have
      // wandered since planning — the pursuit walked, but a step of drift is
      // possible). A PET on either side skips the dialogue engine (company IS the
      // exchange: a heart, warmth, meters clear). Ensure both are creatures so
      // runNpcExchange has nodes to work with.
      const state = world.state;
      const body = state.avatars[npcId];
      const pid = step.target;
      const pav = chatAvatar(state, pid);
      if (!body || !pav || Math.hypot(pav.x - body.x, pav.y - body.y) > 3.5) return; // partner gone — re-plan
      // Register each party as a creature by its id TYPE (a resident / a pet) —
      // an arbitrary npc that answers to neither degrades gracefully (no gossip,
      // just the warmth below), same as the give path's conditional ensures.
      const ensureCreature = (c: string) => {
        if (isPetCid(c)) ensurePetCreature(session, c);
        else if (c.startsWith("resident_")) ensureResidentCreature(session, c);
      };
      ensureCreature(cid);
      ensureCreature(pid);
      if (isPetCid(cid) || isPetCid(pid)) {
        showWorldBubble(state, `social:${cid}`, { anchor: { kind: "avatar", id: npcId }, text: "💗", ttl: 2 });
      } else {
        runNpcExchange(session, cid, pid);
      }
      // Both loneliness meters ease IF the body runs one (a commanded NPC may not).
      for (const c of [cid, pid]) {
        const k = [...session.needMeters.keys()].find((m) => m.startsWith(`${c}|social`));
        if (k) session.needMeters.set(k, 0);
      }
      warmRelations(session, cid, pid, { affinity: 0.05, trust: 0.02 });
      console.log(`[command] ${cid} conversed with ${pid}`);
      return;
    }
    if (step.kind !== "give" && step.kind !== "place") return;
    // Resolve WHAT THE BODY ACTUALLY HOLDS. Prefer the named item, but never get
    // STUCK on a stale/desynced id (a re-materialized stock unit, a swapped
    // display prop): fall back to the REAL prop in hand (the reclaim scans
    // smallProps for exactly this reason — the display prop is in neither store).
    // The pursuit walked the body here specifically to hand this over / put it
    // down, so an empty hand is the only reason not to.
    let o = objIdOfEntity(session, step.itemId);
    if (!o || world.state.objects[o]?.carriedBy !== npcId) {
      o = null;
      for (const [objId] of session.smallProps) {
        if (world.state.objects[objId]?.carriedBy === npcId) {
          o = objId;
          break;
        }
      }
    }
    const c = o ? world.state.objects[o] : undefined;
    if (!o || !c) return; // empty-handed — nothing to give / put down
    const entityId =
      session.smallProps.get(o)?.entityId ?? session.convItems.get(o)?.entityId ?? step.itemId;
    if (step.kind === "give") {
      const cworld = session.creatures?.world;
      const item = cworld?.items[entityId];
      // To the PLAYER: drop within reach + the pending mark, so the gaze
      // auto-take absorbs it into the pocket (the shipped gift path).
      if (step.to === PLAYER_CREATURE_ID) {
        dropObject(world.state, o, c.x, c.y);
        fireCarryGesture(npcId, "putdown", { x: c.x, y: c.y });
        if (item) item.pendingTransferTo = PLAYER_CREATURE_ID;
        return;
      }
      if (step.to.startsWith("resident_")) ensureResidentCreature(session, step.to);
      if (isPetCid(step.to)) ensurePetCreature(session, step.to);
      // OFFER it — the receiver accepts only what it WANTS (the same willingness
      // a player-offer meets: valueTo / open needs, inside giveItem). NO forced
      // acceptance: an unwanted gift is REFUSED aloud and STAYS in the giver's
      // hand (whose own needs then handle it), exactly like the player offering
      // something no one wants.
      const accepted =
        cworld && item && cworld.creatures[step.to] ? giveItem(cworld, cid, step.to, entityId).accepted : false;
      if (!accepted) {
        const thing = headOf(item?.kind ?? liveItemGlyph(session, entityId));
        npcChatBubble(session, step.to, `i_me + want.not + ${thing}`); // "I don't want the X."
        return; // the giver keeps it — never forced on an unwilling receiver
      }
      // ACCEPTED → into the receiver's GRASP (a hand it can hold with), else set
      // it down AT ITS FEET (graspless — a pet — where its own need reaches it).
      // Either branch EMPTIES the giver's hand, so a hand-off never sticks.
      const rBodyId = avatarIdOf(step.to);
      const rBody = world.state.avatars[rBodyId];
      const recip = cworld?.creatures[step.to];
      if (recip && canGrasp(recip) && rBody && !npcCarrying(rBodyId)) {
        carryObject(world.state, o, rBodyId); // into the receiver's own hand
        fireCarryGesture(npcId, "putdown", { x: rBody.x, y: rBody.y });
        fireCarryGesture(rBodyId, "pickup", { x: rBody.x, y: rBody.y });
      } else {
        const at = rBody ?? c; // graspless / hands full → at the receiver's feet
        dropObject(world.state, o, at.x, at.y);
        fireCarryGesture(npcId, "putdown", { x: at.x, y: at.y });
      }
      return;
    }
    // place: prefer a real CONTAINER — the named one, else the nearest within
    // reach of the drop point — and fall back to setting the item down.
    const named = step.place.kind === "named" ? step.place.id : null;
    let containerId = named && session.containers.has(named) ? named : null;
    if (!containerId) {
      let bestD = 2.5;
      for (const [boxId] of session.containers) {
        const box = world.state.objects[boxId];
        if (!box) continue;
        const d = Math.hypot(box.x - c.x, box.y - c.y);
        if (d < bestD) {
          bestD = d;
          containerId = boxId;
        }
      }
    }
    // OPEN the lid to file it in — a lidded box takes the access action first
    // (bug: "put X away" stowed THROUGH a shut lid). "on" surfaces have none.
    if (containerId && session.containers.get(containerId) === "in") openContainerLid(session, cid, containerId);
    if (!containerId || !stowCarriedIn(session, o, containerId)) {
      dropObject(world.state, o, c.x, c.y);
      fireCarryGesture(npcId, "putdown", { x: c.x, y: c.y });
    } else {
      const box = world.state.objects[containerId];
      fireCarryGesture(npcId, "putdown", box ? { x: box.x, y: box.y } : undefined);
    }
  }

  /** GoalPlan (goal-selection.ts) → an NpcErrand, then queue it: moveTo steps are the
   *  waypoints; action steps attach to the last waypoint's onArrive. Reuses the door-
   *  routing + one-task-at-a-time queue via `enqueueNpcErrand`. */
  function issueGoalPlan(session: QuestSession, cid: string, plan: GoalPlan) {
    if (!world) return;
    const points: NpcErrandPoint[] = [];
    const actionsAt = new Map<number, GoalStep[]>();
    for (const step of plan.steps) {
      if (step.kind === "moveTo") points.push({ x: step.pos.x, y: step.pos.y });
      else {
        const i = Math.max(0, points.length - 1);
        (actionsAt.get(i) ?? actionsAt.set(i, []).get(i)!).push(step);
      }
    }
    // An ACTION-ONLY plan (bare "drop X" — no walk) fires in place: seed a
    // single waypoint at the body's current spot so the action still runs.
    // (Actions are already keyed at index 0 — points.length-1 clamps to 0.)
    if (!points.length) {
      if (!actionsAt.size) return;
      const body = world.state.avatars[avatarIdOf(cid)];
      if (!body) return;
      points.push({ x: body.x, y: body.y });
    }
    // Record the plan's stated destination for "where are you going?": the first
    // ACTION names it (fetch the item / bring it to the recipient / place it);
    // a movement-only plan is just "there".
    const action = plan.steps.find((s) => s.kind !== "moveTo");
    session.npcGoing.set(
      cid,
      action?.kind === "pick"
        ? { kind: "fetch", good: liveItemGlyph(session, action.itemId) }
        : action?.kind === "give"
          ? {
              kind: "place",
              place:
                action.to === PLAYER_CREATURE_ID
                  ? "you"
                  : (session.entities.get(session.creatures?.nodeByCreature.get(action.to)?.npcEntityId ?? "")
                      ?.glyph ?? "there"),
            }
          : action?.kind === "drop"
            ? { kind: "place", place: "here" } // putting it down where I am
            : action?.kind === "place" && action.place.kind === "home"
              ? { kind: "home" }
              : { kind: "place", place: "there" },
    );
    session.lastDrive.set(avatarIdOf(cid), "command");
    enqueueNpcErrand(session, avatarIdOf(cid), {
      points,
      onArrive: (i) => {
        for (const step of actionsAt.get(i) ?? []) applyGoalStep(session, cid, step);
      },
    });
  }

  /** Avatar id for a creature id — the player's body is PLAYER_ID, an ambient
   *  RESIDENT's (and a household PET's) body is its bare cid (the streaming
   *  model / spawnPets own those ids), every other creature's is `npc_*`.
   *  Recruiting a resident used to follow the ghost `npc_resident_*` and its
   *  body never moved — always map through here. */
  /** Creature → the BODY that carries it. The player's body is whatever its
   *  spark currently drives: while riding a claimed creature, a self-directed
   *  goal ("I go to the well", or any subject-less sentence with nothing
   *  addressed) must move THAT body — not the spark's own formless, parked one,
   *  which would walk an invisible nothing across the map. */
  function avatarIdOf(cid: string): string {
    if (cid === PLAYER_CREATURE_ID) return world?.drivenBody() ?? PLAYER_ID;
    return cid.startsWith("resident_") || cid.startsWith("pet_") ? cid : `npc_${cid}`;
  }

  /** A WorldResolver over the live world for compileGoal (goal-selection.ts).
   *  Movement (positions/home/creature-places) plus ITEMS: references resolve
   *  over the physically-embodied instances (staged converse items + loose
   *  small props), matched by facets, nearest-first — so "you get the apple" /
   *  "give the ball to me" bind for family members and party alike. Transform
   *  STATIONS resolve to the registered `session.stations` granting the state. */
  function makeGoalResolver(session: QuestSession, needScopeCid?: string): WorldResolver {
    const host = world!;
    const posOf = (cid: string) => {
      const a = host.state.avatars[avatarIdOf(cid)];
      return a ? { x: a.x, y: a.y } : null;
    };
    // THE NEED SCOPE (S3 fix — "the whole street poured into one pantry"): a
    // NEED-born resolution is bounded to the seeker's OWN HOUSEHOLD plus arm's
    // reach, exactly the candidates the legacy ctx offered (own containers +
    // nearby loose items). Without it, `resolveItem`'s town-wide nearest-first
    // sweep sent every hungry resident with a streamed-in interior marching to
    // the SAME visible food box. Commands stay unscoped — "get the cloth" may
    // legitimately cross town; a self-assigned meal may not.
    const scopeOk = (objId: string, pos: { x: number; y: number }): boolean => {
      if (!needScopeCid) return true;
      const fm = /^furn_(\d+)_/.exec(objId);
      if (fm) return Number(fm[1]) === houseIndexOfCid(needScopeCid); // furniture: OWN house only
      const b = host.state.avatars[avatarIdOf(needScopeCid)];
      return !!b && Math.hypot(pos.x - b.x, pos.y - b.y) <= NEED_SCOPE_REACH_M; // else: within reach
    };
    /** Facets of an embodied entity: the creature-world instance when it has
     *  one, else derived from its glyph (props exist before anyone owns them). */
    const facetsOf = (entityId: string, glyph: string) => {
      const it = session.creatures?.world.items[entityId];
      if (it) return it;
      const f = glyphFacets(glyph);
      return { ...f, category: goodKeyOfGlyph(f.kind), bound: false };
    };
    const carrierOf = (entityId: string): string | null => {
      const objId = objIdOfEntity(session, entityId);
      const by = objId ? host.state.objects[objId]?.carriedBy : undefined;
      return by ? creatureOfAvatar(by) : null;
    };
    // How close a candidate must sit to an explicit SOURCE endpoint ("take
    // ball from box") to count as being AT it — box-contained items share the
    // box's position, so arm's reach covers containment and table surfaces.
    const SOURCE_REACH_M = 2.5;
    const resolver: WorldResolver = {
      positionOf: posOf,
      homeOf: (id) => {
        // A resident's home is its own HOUSE — "you go home" walks it there
        // (also how a street GUEST is sent home; the party dispatch dismisses).
        if (id.startsWith("resident_")) {
          const rc = residentTownCtx(session, Number(id.split("_")[1]));
          if (rc?.house) {
            // The LIVING room's center — never the footprint center (a
            // partitioned house's center can be a wall; rooms.ts).
            const lrH = livingRect(rc.center, rc.house);
            return { x: lrH.x + lrH.w / 2, y: lrH.y + lrH.h / 2 };
          }
        }
        return session.staging.get(id)?.home ?? posOf(id);
      },
      place: (p) => {
        if (p.kind === "creature") return posOf(p.id);
        if (p.kind === "point") return { x: p.x, y: p.y };
        if (p.kind === "named") {
          // A real object id (need machinery), else the nearest world object
          // that ANSWERS to the spoken name ("bed" / "bin" / "table") —
          // by glyph head for items, by id token for EVERY placed object
          // (`furn_3_bed_0` answers to "bed"; a fixture needn't be a container
          // to be a destination — "go to bed" walks to the bed).
          const direct = host.state.objects[p.id];
          if (direct) return { x: direct.x, y: direct.y };
          // A house endpoint ("house:<hi>", the ② transfer vocabulary) —
          // its doorstep ("go to house.red" walks there too).
          const hm = /^house:(\d+)$/.exec(p.id);
          if (hm && session.town) {
            const hh = session.town.plan.houses.find((x) => x.index === Number(hm[1]));
            if (hh) return houseDoorstep(session.town.stage.center, hh);
          }
          // A FURNITURE id in a house that isn't streamed in (the off-show haul
          // home — a stow into the dark pantry): resolve its deterministic spot
          // (needObjectPos), and NEVER fall through to the nearest-token search
          // below — "furn_3_chest_food" contains the token "chest" and would
          // resolve to whichever chest is nearest the PLAYER (a misdelivery).
          const fm = /^furn_(\d+)_/.exec(p.id);
          if (fm) return needObjectPos(session, host.state, Number(fm[1]), p.id);
          const me = host.state.avatars[PLAYER_ID];
          let best: { x: number; y: number } | null = null;
          let bestD = Infinity;
          // Head of an object's glyph, `#`-instance-stripped, null for none.
          const objHead = (glyph: string | undefined) =>
            glyph ? headOf(glyph.split("#")[0]!) : null;
          // Board words that answer to a differently-named object: the AAC
          // core word "bathroom" IS the privy fixture; "yard" is the
          // builder's-yard crate (town) / the site stockpile (wilderness).
          const spoken =
            p.id === "bathroom" ? "privy" : p.id === "yard" ? (session.town ? "yard" : "stock") : p.id;
          const tryObj = (objId: string, head: string | null) => {
            const o = host.state.objects[objId];
            if (!o) return;
            if (head !== p.id && !objId.split(/[_:]/).includes(spoken) && !objId.split(/[_:]/).includes(p.id)) return;
            const d = me ? Math.hypot(o.x - me.x, o.y - me.y) : 0;
            if (d < bestD) {
              bestD = d;
              best = { x: o.x, y: o.y };
            }
          };
          for (const objId of Object.keys(host.state.objects)) tryObj(objId, null);
          for (const [objId, rec] of session.smallProps) tryObj(objId, objHead(rec.glyph));
          for (const [objId, it] of session.convItems) {
            tryObj(objId, objHead(session.entities.get(it.entityId)?.glyph));
          }
          return best;
        }
        return null; // "home" rides the goHome goal, not a putIn destination
      },
      resolveItem: (ref, seeker, from) => {
        if ("id" in ref) return objIdOfEntity(session, ref.id) ? ref.id : null;
        const t = ref.match;
        const seekerPos = posOf(seeker);
        let best: string | null = null;
        let bestD = Infinity;
        // An explicit SOURCE endpoint (fetch `from` — "take ball from box",
        // "take from dog"): a creature source admits ONLY its held items; a
        // place/object source only items in-or-at it (arm's reach — contained
        // items share the container's spot). Restriction, not preference: the
        // honest refusal ("the dog doesn't have it") beats a silent guess.
        const fromCid = from?.kind === "creature" ? from.id : null;
        const fromPos = from && from.kind !== "creature" ? resolver.place(from) : null;
        const atSource = (x: number, y: number) =>
          !fromPos || Math.hypot(x - fromPos.x, y - fromPos.y) <= SOURCE_REACH_M;
        // A spoken KIND may also name a CATEGORY ("get food" reaches a banana).
        const kindOk = (fk: string | undefined, cat: string | undefined) =>
          !t.kind || fk === t.kind || cat === t.kind;
        // LOOSE/staged INSTANCES and CONTAINER STOCKS compete in ONE pool, by
        // DISTANCE — the pantry chest beside the seeker beats a stray instance
        // across town (the "walks to the market past the full pantry" bug).
        // Instances are considered first, so they win exact ties (visible
        // beats boxed). Market/produce/trade stock is derived, not stored —
        // naturally absent from containerStock.
        const consider = (entityId: string, objId: string, glyph: string) => {
          const o = host.state.objects[objId];
          if (!o) return;
          if (!scopeOk(objId, o)) return; // a need never forages beyond its scope
          const holder = o.carriedBy ? creatureOfAvatar(o.carriedBy) : null;
          if (fromCid !== null) {
            if (holder !== fromCid) return; // source-restricted: its hands only
          } else if (holder && holder !== seeker) return; // in someone else's hands
          if (!atSource(o.x, o.y)) return; // outside the named source
          const f = facetsOf(entityId, glyph);
          if (f.bound) return; // a need-bound keepsake is not commandable
          if (!kindOk(f.kind, f.category)) return;
          if (t.category && f.category !== t.category) return;
          if (t.descriptors && !t.descriptors.every((d) => (f.descriptors ?? []).includes(d))) return;
          if (t.state && !(f.states ?? []).includes(t.state)) return;
          const d = seekerPos ? Math.hypot(o.x - seekerPos.x, o.y - seekerPos.y) : 0;
          if (d < bestD) {
            bestD = d;
            best = entityId;
          }
        };
        for (const [objId, it] of session.convItems) {
          consider(it.entityId, objId, session.entities.get(it.entityId)?.glyph ?? "");
        }
        for (const [objId, rec] of session.smallProps) consider(rec.entityId, objId, rec.glyph);
        // Container stocks: a matching stacked glyph resolves as a synthetic
        // `stock:<container>|<glyph>` ref; the pick step withdraws one unit
        // and materializes it into the hand. CAPABILITY-GATED like the needs
        // walker: a graspless seeker (the commanded pet) reaches only open
        // surfaces ("on" — the table, its bowl), never lidded boxes.
        const seekerGrasp = canGrasp(session.creatures?.world.creatures[seeker]);
        for (const [boxId, stock] of fromCid !== null ? [] : session.containerStock) {
          const box = host.state.objects[boxId];
          if (!box) continue;
          if (!scopeOk(boxId, box)) continue; // a need eats from ITS OWN pantry
          if (!atSource(box.x, box.y)) continue; // outside the named source
          if (!containerAccessible(session, boxId, seekerGrasp)) continue;
          // OWNERSHIP-GATED (ownership.ts): a command never auto-resolves
          // into someone ELSE's private box — an explicit take at the box
          // itself still meets the social stop-gate (and its objection).
          const bOwner = session.containerOwner.get(boxId);
          if (isPrivateOwner(bOwner) && !mayUse(seeker, houseIndexOfCid(seeker), bOwner)) continue;
          for (const [glyph, n] of Object.entries(stock)) {
            if (n <= 0) continue;
            const f = glyphFacets(glyph);
            const cat = goodKeyOfGlyph(f.kind);
            if (!kindOk(f.kind, cat)) continue;
            if (t.category && cat !== t.category) continue;
            if (t.descriptors && !t.descriptors.every((d) => (f.descriptors ?? []).includes(d))) continue;
            if (t.state) continue; // stacked units carry no transform states
            const d = seekerPos ? Math.hypot(box.x - seekerPos.x, box.y - seekerPos.y) : 0;
            if (d < bestD) {
              bestD = d;
              best = `stock:${boxId}|${glyph}`;
            }
          }
        }
        return best;
      },
      itemPosition: (id) => {
        if (id.startsWith("stock:")) {
          const boxId = id.slice(6).split("|")[0]!;
          const o = host.state.objects[boxId];
          return o ? { x: o.x, y: o.y } : null;
        }
        const objId = objIdOfEntity(session, id);
        const o = objId ? host.state.objects[objId] : undefined;
        return o ? { x: o.x, y: o.y } : null;
      },
      // A TRANSFORM STATION granting `state` (fire→hot, water tub→cold): the
      // registered `session.stations` whose `applies` IS the wanted state, at
      // its object's spot (the pursuit's `standable` nudges it beside the solid
      // box). House cooking/laundry stay on the needs `processAt` path — this is
      // the town's item-transform stations a spoken "cook/cool the X" reaches.
      stationFor: (state) => {
        const st = nearestStationApplying(session, state, null);
        const o = st ? host.state.objects[st.objectId] : undefined;
        return o ? { x: o.x, y: o.y } : null;
      },
      // WHERE self would EAT, by station-kind preference (the need templates'
      // satisfy.at — ["table"] for people, a pet's bowl): the nearest object of
      // the FIRST kind that resolves, matched like the `place` search (fixture
      // kind or an id token — `furn_3_table_0` answers to "table"). Capped to a
      // house-ish radius: a body hungry in the street eats where it stands, it
      // does not march across town to its dining table (the templates' own
      // else-in-place). The pursuit's `standable` wrapper nudges off the solid
      // fixture's edge.
      diningSpot: (self, kinds) => {
        const from = posOf(self);
        if (!from) return null;
        for (const kind of kinds) {
          let best: { x: number; y: number } | null = null;
          let bestD = 16;
          for (const spec of host.state.spec.objects) {
            if (spec.fixture !== kind && !spec.id.split(/[_:]/).includes(kind)) continue;
            const o = host.state.objects[spec.id];
            if (!o) continue;
            if (!scopeOk(spec.id, o)) continue; // dine at YOUR table, not a stranger's
            const d = Math.hypot(o.x - from.x, o.y - from.y);
            if (d < bestD) {
              bestD = d;
              best = { x: o.x, y: o.y };
            }
          }
          if (best) return best;
        }
        return null;
      },
      // The nearest COLORING TUB — a water barrel/bath doubling as the dye vat,
      // where a `color` command carries the item to recolour it. Unscoped (a
      // command may cross the house, unlike a self-need), nearest-first.
      colorStation: (self) => {
        const from = posOf(self);
        if (!from) return null;
        let best: { x: number; y: number } | null = null;
        let bestD = Infinity;
        for (const spec of host.state.spec.objects) {
          if (spec.fixture !== "barrel" && spec.fixture !== "bath") continue;
          const o = host.state.objects[spec.id];
          if (!o) continue;
          const d = Math.hypot(o.x - from.x, o.y - from.y);
          if (d < bestD) {
            bestD = d;
            best = { x: o.x, y: o.y };
          }
        }
        return best;
      },
      // A body works a lid only WITH a grasp — a graspless pet's body carries
      // `canOpen === false` (set each tick in stepNeeds), so an "open the chest"
      // for it regresses to blocked. Default (no body / unset) ⇒ can.
      canOpen: (self) => host.state.avatars[avatarIdOf(self)]?.canOpen !== false,
      carrierOf: (id) => (id.startsWith("stock:") ? null : carrierOf(id)),
    };
    return resolver;
  }

  /** Furniture/station words + places a spoken noun may name — the CLASSIFIER's
   *  place vocabulary (the resolver finds the actual object nearest-first). */
  const PLACE_NOUNS = new Set([
    "home", "bed", "table", "chair", "box", "cupboard", "chest",
    "bath", "bathroom", "privy", "barrel", "bin", "bowl", "oven", "well", "market", "store",
    "yard", "house", // transfer endpoints (②): the builder's yard, a house
  ]);

  /** Spoken words naming a LIDDED CONTAINER — "open/shut the X" on one works its
   *  physical LID (`setOpen`/`heldOpen`), not a creature-world device toggle.
   *  The openable container station kinds (STATION_PROPERTIES) + their synonyms. */
  const OPENABLE_CONTAINER_WORDS = new Set([
    "chest", "box", "cupboard", "barrel", "bin", "refrigerator", "fridge", "container",
  ]);

  /** World knowledge for the PARSER (ParseContext.classifyEntity): is this
   *  spoken noun a creature (a family/pet name, a species word), a place
   *  (furniture/stations/home), or an item (a known glyph kind)? Drives the
   *  general role rules — animate agents, recipients, destinations — instead
   *  of per-sentence special cases. */
  function classifySpokenNoun(
    session: QuestSession,
    byName: Map<string, string>,
    symbol: string,
  ): "place" | "item" | "creature" | "unknown" {
    const sym = symbol.toLowerCase();
    if (byName.has(sym)) return "creature";
    if (PLACE_NOUNS.has(sym)) return "place";
    // Known item kinds: goods + their kinds, treats, water, and whatever loose
    // props / pocket stacks exist right now.
    if (sym === "water" || TREAT_KINDS.includes(sym) || FOOD_KINDS.includes(sym)) return "item";
    if (CLOTHING_HEADS.includes(sym)) return "item"; // a garment HEAD ("shirt"); colour is a facet
    for (const g of session.town?.stage.goods ?? []) {
      if (kindsOf(g.good.key).includes(sym) || g.good.key === sym) return "item";
    }
    for (const [, rec] of session.smallProps) {
      if ((headOf(rec.glyph)).toLowerCase() === sym) return "item";
    }
    if (Object.keys(session.pocket).some((g) => (headOf(g)).toLowerCase() === sym)) return "item";
    for (const stock of session.containerStock.values()) {
      if (Object.keys(stock).some((g) => (headOf(g)).toLowerCase() === sym)) return "item";
    }
    return "unknown";
  }

  /** The creature the player stands nearest — the fallback target for a spoken
   *  command/rule when the player isn't in an active conversation. */
  function nearestCreature(session: QuestSession): string | null {
    if (!world || !session.creatures) return null;
    const p = world.state.avatars[PLAYER_ID];
    if (!p) return null;
    let best: string | null = null;
    let bestD = Infinity;
    for (const cid of session.creatures.nodeByCreature.keys()) {
      const a = world.state.avatars[`npc_${cid}`];
      if (!a) continue;
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = cid;
      }
    }
    return best;
  }

  let speakSeq = 0;

  /** The creature the player is LOOKING at (gaze hover), if it's a real creature. */
  function gazeCreature(session: QuestSession): string | null {
    const hv = world?.getGaze?.().hover;
    if (hv?.kind === "avatar" && hv.id.startsWith("npc_")) {
      const cid = hv.id.slice(4);
      if (session.creatures?.nodeByCreature.has(cid)) return cid;
    }
    return null;
  }

  /** Enlist a creature: it follows the player + obeys commands; drop its scheduled
   *  errand so the follow/command takes over immediately (a resident's needs/
   *  schedule are suspended while recruited — the clock's errand feed skips party
   *  members too). The LIVE flag is KEPT (§4 — hands empty on every exit): a
   *  mid-haul recruit's episode stays open, so on dismissal the carried stack
   *  gets deposited or banked instead of riding the hands forever. */
  function joinParty(session: QuestSession, cid: string) {
    session.party.add(cid);
    const body = avatarIdOf(cid);
    session.npcTasks.delete(body);
    session.needStep.delete(cid);
    world?.setNpcErrand(body, null);
  }

  /** Dismiss a creature from the party — it stops following and stays put; a
   *  resident's needs/schedule resume on their own (re-promote if anything fires). */
  function leaveParty(session: QuestSession, cid: string) {
    session.party.delete(cid);
    session.npcTasks.delete(avatarIdOf(cid));
    world?.setNpcErrand(avatarIdOf(cid), null);
  }

  // ── Items as STACKS · ONE container abstraction ───────────────────────────
  // Items are FUNGIBLE, merged by SIGNATURE = their composed glyph
  // (feedback_items_stack_one_container). The pocket and every container's contents are
  // glyph→count STACK MAPS — no lists of distinct instances. A concrete creature-world
  // instance is MATERIALIZED from a glyph only when a stack leaves storage into the world
  // or dialogue (a loose prop, a table-visible prop, an offer) — that's where ownership
  // and the generosity path need a real item. ONE container path: any object with
  // `contains` slots opens the same popup; a table (`on`) differs ONLY in rendering its
  // contents visibly.

  const STORE_DISPLAY_CAP = 4; // items a market box shows at once (keep pulling per day)

  /** Split a signature glyph into its facets: head kind, descriptor mods, state
   *  mods. Delegates to the canonical `facetsOf` (variations.ts) — one splitter. */
  function glyphFacets(glyph: string): { kind: string; descriptors: string[]; states: string[] } {
    const f = facetsOf(glyph);
    return { kind: f.head, descriptors: f.variations, states: f.states };
  }

  /** MATERIALIZE a fresh concrete creature-world item from a glyph SIGNATURE — the only
   *  place a stack becomes an instance (leaving storage into the world/dialogue). The new
   *  item's facets reconstruct the glyph so `itemMatchesNeed`/`giveItem` and the glyph
   *  renderer agree. Registered in `entities` so `symbolOf` resolves its glyph. */
  function materialize(session: QuestSession, glyph: string, ownerId: string | null = null): string {
    const id = `mat_${session.matSerial++}`;
    const { kind, descriptors, states } = glyphFacets(glyph);
    // A fruit KIND belongs to the FOOD category (apple is a kind of food) — this
    // is what lets a gifted apple satisfy a food want and lets the preference
    // voice ("i_me want apple") prove kind→category membership off a real item.
    const category = goodKeyOfGlyph(kind);
    if (session.creatures) {
      session.creatures.world.items[id] = createCreatureWorld(
        [],
        [{ id, kind, category, ...(descriptors.length ? { descriptors } : {}), ...(states.length ? { states } : {}) }],
      ).items[id]!;
      const it = session.creatures.world.items[id]!;
      it.ownerId = ownerId;
      // RARE far-away goods are WORTH more — a gifted cookie earns real
      // gratitude (the debt/willingness machinery reads item value).
      if (TREAT_KINDS.includes(kind)) it.value = 3;
    }
    session.entities.set(id, { id, kind: "item", label: kind, glyph });
    return id;
  }

  /** Add `n` of a glyph to a stack map (merge). */
  const stackAdd = (map: Record<string, number>, glyph: string, n = 1): void => {
    map[glyph] = (map[glyph] ?? 0) + n;
  };
  /** Remove one of a glyph from a stack map (delete the key at zero). Returns success. */
  const stackTake = (map: Record<string, number>, glyph: string): boolean => {
    if (!map[glyph]) return false;
    map[glyph] -= 1;
    if (map[glyph] <= 0) delete map[glyph];
    return true;
  };

  /** Build + push the inventory strip: one entry per glyph STACK, with its count. */
  function pushPocket(session: QuestSession) {
    presenter.pocket?.(
      Object.entries(session.pocket)
        .filter(([, n]) => n > 0)
        .map(([glyph, count]) => ({
          glyph,
          count,
          label: headOf(glyph),
          selected: session.selectedPocketGlyph === glyph,
        })),
    );
  }

  /** Sample the DOLLHOUSE family's live states into HUD chips (family-hud.ts):
   *  one emoji per member from the same machinery that drives the bodies —
   *  meters, the active need step, queued spoken commands, the clock's shift
   *  and shopping windows. Null outside dollhouse mode. */
  function familyHudEntries(session: QuestSession): FamilyHudEntry[] | null {
    if (!world) return null;
    if (session.dollhouse === null) {
      // FOUNDING GROUP (city-founding ②): no dollhouse, but the settlers ARE
      // the player's family — a chip each, addressable like any member.
      const settlers = settlersOf(session);
      if (!settlers.length) return null;
      return settlers.map((cid, i) => ({
        id: cid,
        label: settlerMemberOf(session, cid)?.name ?? `${i + 1}`,
        emoji: (session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0 ? "🏃" : "⛺",
        state: "guest" as const,
        selected: session.addressedFamily === cid,
        present: !!world!.state.avatars[avatarIdOf(cid)],
      }));
    }
    const h = session.dollhouse;
    const houseCtx = residentTownCtx(session, h);
    const entries: FamilyHudEntry[] = [];
    const fam = familyOf(session);
    for (let m = 0; m < HOUSEHOLD; m++) {
      const cid = `resident_${h}_${m}`;
      // Members a mode-"all" family EXCLUDES never exist — no chip. A member
      // merely NOT EMBODIED (out working/shopping/walking) keeps its chip,
      // dimmed, showing what took it away — absence must be visible.
      if (fam && fam.mode === "all" && m >= fam.members.length) continue;
      const present = !!world.state.avatars[cid];
      const duty = residentJobDuty(session, h, m);
      const onShift = !!duty && inShiftWindow(duty.window, session.townClock, FOOD_DAY_SEC);
      // "Out shopping" reads the LIVE loop, never the clock: the dollhouse is
      // an on-show house, whose schedule is suppressed — its phase keeps
      // ticking a FICTIONAL cycle that had chips claiming "on an errand"
      // about members standing in the kitchen. A real errand is a live
      // take/deposit step at a market store.
      const liveStep = session.needStep.get(cid);
      const shopping =
        !!liveStep &&
        (liveStep.kind === "take" || liveStep.kind === "deposit") &&
        (liveStep.objId?.startsWith("store:") ?? false);
      const label = familyMemberOf(session, h, m)?.name ?? `${m + 1}`;
      if (!present) {
        const state = onShift ? ("working" as const) : shopping ? ("errand" as const) : ("away" as const);
        entries.push({
          id: cid,
          label,
          emoji: state === "working" ? "💼" : state === "errand" ? "🧺" : "🚶",
          state,
          selected: session.addressedFamily === cid,
          present: false,
        });
        continue;
      }
      const step = session.needStep.get(cid) ?? null;
      const firing = (key: string) => (session.needMeters.get(`${cid}|${key}`) ?? 0) >= 1;
      const { emoji, state } = familyStateOf({
        commanded: (session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0,
        step: step
          ? { tplKey: step.tplKey, resting: step.kind === "rest" && step.dwell !== undefined }
          : null,
        hungry: firing("hunger:food"),
        thirsty: firing("thirst:water"),
        toilet: firing("waste"),
        tired: firing("energy"),
        lonely: firing("social"),
        dirty: firing("hygiene"),
        scruffy: firing("dress"),
        bored: firing("fun"),
        stressed: (session.stress.get(cid) ?? 0) >= STRESS_VISIBLE,
        away: onShift ? "shift" : shopping ? "shopping" : null,
      });
      entries.push({
        id: cid,
        label,
        emoji,
        state,
        selected: session.addressedFamily === cid,
        present: true,
      });
    }
    // PETS: family members of another species — same ladder, no duties.
    for (const { cid, house: ph, pet } of petsOf(session)) {
      if (ph !== h) continue;
      const present = !!world.state.avatars[cid];
      const step = session.needStep.get(cid) ?? null;
      const firing = (key: string) => (session.needMeters.get(`${cid}|${key}`) ?? 0) >= 1;
      const { emoji, state } = familyStateOf({
        commanded: (session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0,
        step: step
          ? { tplKey: step.tplKey, resting: step.kind === "rest" && step.dwell !== undefined }
          : null,
        hungry: firing("hunger:food"),
        thirsty: firing("thirst:water"),
        toilet: false,
        tired: firing("energy"),
        lonely: firing("social"),
        dirty: false,
        scruffy: false, // pets run bare — no dress row
        bored: firing("fun"),
        stressed: (session.stress.get(cid) ?? 0) >= STRESS_VISIBLE,
        away: null,
      });
      entries.push({
        id: cid,
        label: pet.name ?? "pet",
        emoji,
        state,
        selected: session.addressedFamily === cid,
        present,
      });
    }
    // GUESTS: recruited street residents ("you follow i_me") get a chip too —
    // addressable like family (tap + Speak), dismissed with "you go home".
    for (const cid of [...session.party].sort()) {
      if (!cid.startsWith("resident_") || Number(cid.split("_")[1]) === h) continue;
      if (!world.state.avatars[cid]) continue;
      const commanded = (session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0;
      entries.push({
        id: cid,
        label: "guest",
        emoji: commanded ? "🏃" : "🙋",
        state: "guest",
        selected: session.addressedFamily === cid,
        present: true,
      });
    }
    return entries;
  }

  /** Push the family HUD when it changed (or `force` after a chip tap). */
  function pushFamilyHud(session: QuestSession, force = false) {
    if (!presenter.family) return;
    const entries = familyHudEntries(session);
    if (entries === null) return;
    const sig = JSON.stringify(entries);
    if (!force && sig === session.familyHudSig) return;
    session.familyHudSig = sig;
    presenter.family(entries);
  }

  // "you eat" / "you sleep" — the SELF-CARE commands. Rather than scripting a
  // one-off animation, the command drives the member's OWN need machinery: the
  // meter is raised to firing and the live loop walks the body to the table or
  // bed exactly as autonomous need-satisfaction would (then clears the meter —
  // the HUD chip visibly flips back to content). A member whose meter is low
  // REFUSES out loud ("I'm not hungry / not tired") — negation the world means,
  // which is feedback worth as much as obedience.
  const SATISFY_NEED_PREFIX: Record<string, string> = {
    eat: "hunger:",
    drink: "thirst:",
    sleep: "energy",
    rest: "energy",
    play: "fun",
    talk: "social",
    wash: "hygiene",
    brush_teeth: "hygiene",
    wear: "dress",
  };
  const SATISFY_REFUSAL: Record<string, string> = {
    eat: "i_me + hungry.not",
    drink: "i_me + thirsty.not",
    sleep: "i_me + tired.not",
    rest: "i_me + tired.not",
    play: "i_me + bored.not",
    talk: "i_me + lonely.not",
    wash: "i_me + dirty.not",
    brush_teeth: "i_me + dirty.not",
    wear: "clothing + clean", // "The clothes are clean." — no change needed
  };
  /** How full the meter must be (fraction of threshold) before the member is
   *  WILLING to comply early — below this it isn't hungry/tired enough to mean it. */
  const SATISFY_WILLING_FRACTION = 0.35;

  /** WHY a need can't be served, as a spoken glyph line. The walker only ever
   *  says BLOCKED; this turns that into a reason the player can hear, from the
   *  same resolved context the walker decided on:
   *   · a station-required satisfy with no station → "I don't have a bath"
   *     (the house lacks the fixture — the honest, teachable answer);
   *   · anything else → "I don't have clothes / food / water" (nothing in the
   *     wardrobe, the pantry and the market all came up empty).
   *  General over every template, so a new need row gets a spoken reason free.
   *  Falls back to the not-understood line rather than inventing vocabulary. */
  function needBlockedLine(tpl: NeedTemplate, ctx: NeedCtx): string {
    const sat = tpl.satisfy;
    const wantsStation =
      (sat.kind === "rest" && sat.requireStation) || sat.kind === "transform";
    if (wantsStation && ctx.stations.length === 0) {
      const kind = (sat.kind === "rest" || sat.kind === "transform" ? sat.at?.[0] : undefined);
      if (kind) return `i_me + have.not + ${kind}`;
    }
    const category = tpl.item.category;
    if (category) return `i_me + have.not + ${category}`;
    return NOT_UNDERSTOOD_LINE;
  }

  /** Returns true when the command landed (obeyed or refused aloud) — false =
   *  this member has no such need here ("can't do that here"). */
  function commandSatisfy(session: QuestSession, cid: string, need: string): boolean {
    const houseIndex = Number(cid.split("_")[1]);
    const member = Number(cid.split("_")[2]);
    const house = residentTownCtx(session, houseIndex)?.house;
    if (!house) return false;
    const templatesOf = () =>
      isPetCid(cid) ? petNeedTemplates(session) : residentNeedTemplates(session, houseIndex, house, member);
    // METERLESS CHORES (tidy / laundry / cooking — stock & mess drives): if the
    // chore currently FIRES the walker takes it from here; a nothing-to-do
    // answers honestly ("the house is clean", "the clothes are clean", "I
    // don't have food"). The verb×category dispatch (intent-compile
    // CATEGORY_NEEDS) routes "wash the clothes" / "cook food" here.
    const CHORES: Record<string, { key: string; idleLine: string }> = {
      clean: { key: "tidy", idleLine: "home + clean" },
      laundry: { key: "laundry", idleLine: "clothing + clean" },
      cook: { key: "cook:", idleLine: "i_me + have.not + food" }, // cook:<goodKey>
    };
    const chore = CHORES[need];
    if (chore) {
      const tpl = templatesOf().find((t) => t.key === chore.key || t.key.startsWith(chore.key));
      if (!tpl || !world) return false;
      const fires = decideNeed(tpl, residentNeedCtx(session, world.state, cid, houseIndex, tpl));
      if (fires.kind === "idle") {
        ensureResidentCreature(session, cid);
        npcChatBubble(session, cid, chore.idleLine);
        return true;
      }
      session.needStep.delete(cid);
      session.npcTasks.delete(avatarIdOf(cid));
      session.liveNeedBodies.add(cid);
      ensureResidentCreature(session, cid);
      npcChatBubble(session, cid, "ok"); // accepted order — the reserved okay
      return true;
    }
    // "you sit" — a body pose, not a meter: walk to a free chair (else pose in
    // place) and hold the sit rig for a spell.
    if (need === "sit") return commandSit(session, cid, houseIndex);
    // "you wake up" — interrupt a rest dwell; the meter keeps a partial nap.
    if (need === "wake_up") {
      const step = session.needStep.get(cid);
      if (step?.kind === "rest") {
        session.needStep.delete(cid);
        const ek = `${cid}|${step.tplKey}`;
        session.needMeters.set(ek, (session.needMeters.get(ek) ?? 0) * 0.35);
        if (world) {
          showWorldBubble(world.state, `wake:${cid}`, { anchor: { kind: "avatar", id: cid }, text: "☀️", ttl: 2 });
        }
      }
      return true;
    }
    const prefix = SATISFY_NEED_PREFIX[need];
    if (!prefix) return false;
    const tpl = templatesOf().find((t) => t.key.startsWith(prefix));
    if (!tpl || tpl.drive.kind !== "meter") return false;
    const key = `${cid}|${tpl.key}`;
    const meter = session.needMeters.get(key) ?? 0;
    if (meter < tpl.drive.threshold * SATISFY_WILLING_FRACTION) {
      if (isPetCid(cid)) ensurePetCreature(session, cid);
      else ensureResidentCreature(session, cid);
      npcChatBubble(session, cid, SATISFY_REFUSAL[need]!);
      return true;
    }
    session.needMeters.set(key, Math.max(meter, tpl.drive.threshold));
    if (isPetCid(cid)) ensurePetCreature(session, cid);
    else ensureResidentCreature(session, cid);
    // CAN IT ACTUALLY BE DONE? The meter is now firing, so re-decide from the
    // live world before answering. An order the body cannot serve — "you wear"
    // with nothing clean in the wardrobe, "you wash" in a house with no tub —
    // used to get a cheerful "ok" and then silently do nothing (the walker
    // decided BLOCKED, demoted, and walked home without a word). Say WHY
    // instead: a refusal the player can hear is worth more than false
    // compliance, and it is the same honesty the CHORES path above already had.
    if (world) {
      const decided = decideNeed(tpl, residentNeedCtx(session, world.state, cid, houseIndex, tpl));
      if (decided.kind === "blocked") {
        session.needMeters.set(key, meter); // don't leave a want raised we can't serve
        npcChatBubble(session, cid, needBlockedLine(tpl, residentNeedCtx(session, world.state, cid, houseIndex, tpl)));
        return true;
      }
    }
    session.needStep.delete(cid); // re-decide fresh from the raised meter
    session.npcTasks.delete(avatarIdOf(cid)); // the new order overrides an old errand
    session.liveNeedBodies.add(cid); // the live loop owns the body (skips clock gates)
    // "ok" — RESERVED for exactly this: confirming an accepted order (①a §1).
    npcChatBubble(session, cid, "ok");
    return true;
  }

  /** "you sit" — walk to a free chair in the room (else pose where it stands)
   *  and hold the SIT rig for SIT_DWELL_S (needPoseShow drives the body pose). */
  function commandSit(session: QuestSession, cid: string, houseIndex: number): boolean {
    if (!world) return false;
    const state = world.state;
    const body = state.avatars[avatarIdOf(cid)];
    if (!body) return false;
    let chair: { id: string; x: number; y: number } | null = null;
    for (const cidx of [0, 1]) {
      const oid = `furn_${houseIndex}_chair_${cidx}`;
      const o = state.objects[oid];
      if (!o) continue;
      if (!chair || Math.hypot(o.x - body.x, o.y - body.y) < Math.hypot(chair.x - body.x, chair.y - body.y)) {
        chair = { id: oid, x: o.x, y: o.y };
      }
    }
    session.needStep.delete(cid);
    session.npcTasks.delete(avatarIdOf(cid));
    if (!chair) {
      session.needPoseShow.set(cid, { t: SIT_DWELL_S, kind: "sit" });
      // PIN the body for the pose — with no errand the wander behavior walks
      // it around while the sit animation plays.
      enqueueNpcErrand(session, avatarIdOf(cid), {
        points: [{ x: body.x, y: body.y, dwell: SIT_DWELL_S }],
      });
      return true;
    }
    const spot = standPointFor(state, chair.id, { x: chair.x, y: chair.y }, { x: body.x, y: body.y }, world?.npcRadiusOf(avatarIdOf(cid)));
    const chairId = chair.id;
    enqueueNpcErrand(session, avatarIdOf(cid), {
      points: [{ x: spot.x, y: spot.y, dwell: SIT_DWELL_S }],
      onArrive: () => session.needPoseShow.set(cid, { t: SIT_DWELL_S, kind: "sit", objId: chairId }),
    });
    session.lastDrive.set(cid, "command");
    return true;
  }

  /**
   * "put + chair + near + table" (construction v1) — a directed PLACEMENT.
   * GUIDANCE, not an RTS order: the player names only the piece and a
   * relation+anchor; the creature searches its own house with the SAME
   * placement rules the generator obeys (kernel placementCandidates), and
   * answers in three grades — place ("ok", walks the errand), "I cannot —
   * because" (no feasible spot / not my house / nothing in storage), or
   * "I don't want to — because" (feasible but past what its compliance
   * swallows). Every verdict SPEAKS. Returns true when the order landed
   * (obeyed OR refused aloud).
   */
  function handlePlaceOrder(
    session: QuestSession,
    cid: string,
    goal: Extract<GoalSpec, { kind: "place" }>,
    opts?: { quiet?: boolean },
  ): boolean {
    if (!world) return false;
    const state = world.state;
    const houseIndex = Number(cid.split("_")[1]);
    const ctx = residentTownCtx(session, houseIndex);
    const t = session.town;
    if (!ctx?.house || !t || ctx.neighbor) return false; // primary-town residents only (v1)
    const house = ctx.house;
    const center = ctx.center;
    const deltas = t.deltas;
    const key = `h_${house.index}`;

    // The PIECE: a furniture kind the item economy knows ("chair") — the
    // registry row carries its placed footprint.
    const kindStr = "match" in goal.item ? goal.item.match.kind : null;
    const def = kindStr ? FURNITURE_ITEMS.find((f) => f.kind === kindStr) : undefined;
    if (!def) return false;
    const kind = def.kind;
    const thing = kind;
    const speakLine = (line: { c: string }) => {
      if (opts?.quiet) return; // an AUTONOMOUS act neither asks nor refuses aloud
      ensureResidentCreature(session, cid);
      npcChatBubble(session, cid, line.c);
    };

    // The house's CURRENT furniture + plan (delta-applied) — both the
    // anchor lookup and the placement search read the same set.
    const delta = deltas.get(key);
    const plan = houseRoomPlan(center, house, delta);
    const goodDefs = ctx.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    const pieces = houseFurniture(center, house, goodDefs, "", delta);

    // The ANCHOR, in world coords (primary town: world == stage coords).
    // A named anchor is a matching piece of the creature's OWN house
    // ("near the table"); a point anchor is the committed gaze ("here").
    const a = goal.at.anchor;
    let anchor: { x: number; y: number } | null = null;
    if (a.kind === "point") anchor = { x: a.x, y: a.y };
    else if (a.kind === "named") {
      const hit = pieces.find((p) => p.kind === a.id);
      if (!hit) {
        // The named thing isn't standing in this house — honest "I can't".
        speakLine(placementVerdictLine(thing, { kind: "cannot", reason: "outside" })!);
        return true;
      }
      anchor = { x: hit.x, y: hit.y };
    }

    // OWNERSHIP pre-gate: a point anchor inside someone ELSE's footprint is
    // "not my house" — creatures furnish their own homes (mayUse's spirit).
    if (anchor) {
      const inOwn =
        anchor.x >= center.x + house.dx && anchor.x <= center.x + house.dx + house.w &&
        anchor.y >= center.y + house.dy && anchor.y <= center.y + house.dy + house.h;
      if (!inOwn) {
        speakLine(placementVerdictLine(thing, { kind: "cannot", reason: "not-mine" })!);
        return true;
      }
    }

    // STOCK pre-gate: an unplaced piece must exist as a `furn.<kind>` stack
    // in one of the house's own containers (storage — the ONE container
    // abstraction). Nothing stored ⇒ "I don't have a chair."
    const glyph = furnitureGlyph(kind);
    let sourceBox: string | null = null;
    for (const [objId, stock] of session.containerStock) {
      if (!objId.startsWith(`furn_${house.index}_`)) continue;
      if ((stock[glyph] ?? 0) > 0) {
        sourceBox = objId;
        break;
      }
    }
    if (!sourceBox) {
      speakLine(placementVerdictLine(thing, { kind: "cannot", reason: "have-not" })!);
      return true;
    }

    // THE SEARCH — the creature's own judgment over the shared fit rules.
    const pctx = makePlacementContext(center, house, plan, goodDefs, [...pieces]);
    const anchorZone = anchor ? placementZoneAt(pctx, anchor.x, anchor.y) : undefined;
    const candidates = placementCandidates(pctx, {
      kind,
      radius: def.radius,
      ...(anchor ? { anchor } : {}),
    });
    // The dominant refusal reason when nothing fits: probe the anchor spot.
    let failure: PlacementFailure | undefined;
    if (!candidates.length && anchor && anchorZone) {
      const probe = placementFeasible(pctx, anchorZone.room.id, {
        x: anchor.x, y: anchor.y, radius: def.radius, kind,
      });
      if (!probe.ok) failure = probe.reason;
    }

    // COMPLY / CAN'T / WON'T: family compliance overrides mild distaste
    // (the dollhouse's guiding spirit carries real authority); anyone else
    // only obliges genuinely natural spots.
    const family = familyOf(session)?.house === house.index;
    const verdict = willingnessToPlace({
      candidates,
      ...(failure !== undefined ? { failure } : {}),
      ...(family ? { relation: FAMILY_RELATION } : {}),
    });
    const line = placementVerdictLine(thing, verdict);
    if (line) {
      speakLine(line);
      return true; // refused ALOUD — the order landed (guidance, not RTS)
    }
    if (verdict.kind !== "place") return false; // unreachable — for the checker

    // ACCEPTED: "ok", then the errand — storage chest first (take the
    // stack), then the spot; the placement mutation lands on arrival and
    // the stage's delta watcher raises the real fixture the same frame.
    speakLine(PLACEMENT_OK);
    const spot = verdict.spot;
    const box = state.objects[sourceBox];
    const npcId = avatarIdOf(cid);
    session.needStep.delete(cid);
    session.npcTasks.delete(npcId);
    session.lastDrive.set(cid, "command");
    const points = [
      ...(box ? [{ x: box.x, y: box.y, dwell: 0.8 }] : []),
      { x: spot.x, y: spot.y, dwell: 0.4 },
    ];
    enqueueNpcErrand(session, npcId, {
      points,
      onDone: () => {
        const stock = session.containerStock.get(sourceBox!) ?? {};
        if ((stock[glyph] ?? 0) <= 0) return; // someone took it meanwhile — honest no-op
        stackTake(stock, glyph);
        session.containerStock.set(sourceBox!, stock);
        placeFurniture(deltas, key, {
          id: `furn_${house.index}_p${nextPlacedSerial(deltas.get(key))}`,
          kind,
          x: spot.x,
          y: spot.y,
          radius: def.radius,
          facing: spot.facing,
          openable: def.openable,
          roomId: spot.roomId,
        });
        npcChatBubble(session, cid, placementDoneLine(thing).b);
      },
    });
    return true;
  }

  /**
   * A household's PROSPERITY signals for the day (construction v1 §5) —
   * the PROXY trio, all read from existing deterministic state (no money
   * exists yet; this adapter is what a real economy later replaces):
   *   pantry   how full the street-good boxes sit (surplus households
   *            bank; hand-to-mouth ones don't),
   *   breadth  how many distinct stacks the house's chests hold,
   * each normalized to ~0..1 per day so the daily cap and threshold in
   * constructionStep read plainly.
   */
  function prosperitySignals(
    session: QuestSession,
    houseIndex: number,
  ): Array<{ key: string; value: number }> {
    const ctx = residentTownCtx(session, houseIndex);
    if (!ctx?.house || ctx.neighbor) return [];
    const house = ctx.house;
    const signals: Array<{ key: string; value: number }> = [];
    let fill = 0;
    let goodsN = 0;
    for (const g of ctx.goods) {
      const cap = Math.max(1, g.boxCap);
      fill += Math.max(0, Math.min(1, g.pantry(house, session.townClock) / cap));
      goodsN++;
    }
    if (goodsN) signals.push({ key: "pantry", value: (fill / goodsN) * 0.8 });
    let stacks = 0;
    for (const [objId, stock] of session.containerStock) {
      if (!objId.startsWith(`furn_${houseIndex}_`)) continue;
      stacks += Object.values(stock).filter((n) => n > 0).length;
    }
    signals.push({ key: "breadth", value: Math.min(1, stacks / 6) * 0.4 });
    return signals;
  }

  /** Last town-day each carpenter house crafted (construction v1). */
  const craftDayOf = new Map<number, number>();
  /** townClock second before a house may auto-place again (rate limit). */
  const autoPlaceAfter = new Map<number, number>();
  /** The drag-zone set last pushed to the host (diff-gated). */
  let lastDragKey = "";

  /**
   * CONSTRUCTION HOUSEKEEPING (construction v1 §6) — three ambient loops:
   *   craft   a WORKSHOP house turns wood into one furniture stack a day
   *           (the carpenter's supply — wood restocks off-screen; the
   *           economy is quantity-only, no coins change hands),
   *   place   a SHOWN house holding stored furniture sends a member to
   *           stand it up — the same search + willingness the spoken
   *           order runs, quiet and natural-taste-only (autonomy),
   *   clutter unplaced stacks in a store/workshop room SLOW the room
   *           (the engine drag seam) without ever blocking it.
   */
  function stepConstructionHousekeeping(session: QuestSession, shown: (hi: number) => boolean) {
    const t = session.town;
    if (!t || !world) return;
    const day = Math.floor(session.townClock / FOOD_DAY_SEC);
    const craftable = FURNITURE_ITEMS.filter((f) => f.craft);
    for (const house of t.plan.houses) {
      const hi = house.index;
      const delta = t.deltas.get(`h_${hi}`);
      const hasWorkshop = delta?.annexes.some((a) => a.cluster === "workshop") ?? false;
      if (hasWorkshop && craftable.length && (craftDayOf.get(hi) ?? -1) !== day) {
        craftDayOf.set(hi, day);
        const woodId = `furn_${hi}_woodstore`;
        const stock = session.containerStock.get(woodId) ?? {};
        if ((stock["wood"] ?? 0) <= 0) stock["wood"] = 3; // restocked off-screen
        const def = craftable[(day + hi) % craftable.length]!;
        const cost = def.craft!.consumes["wood"] ?? 1;
        const out = furnitureGlyph(def.kind);
        if ((stock["wood"] ?? 0) >= cost && (stock[out] ?? 0) < 2) {
          stock["wood"] = (stock["wood"] ?? 0) - cost;
          if ((stock["wood"] ?? 0) <= 0) delete stock["wood"];
          stackAdd(stock, out);
        }
        session.containerStock.set(woodId, stock);
      }
      // AUTO-PLACE: a shown household with stored furniture stands one up.
      if (!shown(hi)) continue;
      if ((autoPlaceAfter.get(hi) ?? 0) > session.townClock) continue;
      let kind: (typeof FURNITURE_ITEMS)[number]["kind"] | null = null;
      for (const [objId, stock] of session.containerStock) {
        if (!objId.startsWith(`furn_${hi}_`)) continue;
        for (const g of Object.keys(stock)) {
          const k = furnitureKindOfGlyph(g);
          if (k && k !== "workbench" && (stock[g] ?? 0) > 0) {
            kind = k;
            break;
          }
        }
        if (kind) break;
      }
      if (!kind) continue;
      const cid = `resident_${hi}_0`;
      if (!world.state.avatars[avatarIdOf(cid)]) continue; // nobody home to do it
      autoPlaceAfter.set(hi, session.townClock + 45);
      handlePlaceOrder(
        session,
        cid,
        { kind: "place", item: { match: { kind } }, at: { relation: "in", anchor: { kind: "home" } } },
        { quiet: true },
      );
    }
    // CLUTTER drag zones over store/workshop rooms holding furniture stacks.
    const zones: Array<{ x: number; y: number; w: number; h: number; scale: number }> = [];
    for (const hi of session.houseShown) {
      const house = t.plan.houses.find((h) => h.index === hi);
      if (!house) continue;
      let stacks = 0;
      for (const [objId, stock] of session.containerStock) {
        if (!objId.startsWith(`furn_${hi}_`)) continue;
        for (const g of Object.keys(stock)) {
          if (furnitureKindOfGlyph(g)) stacks += stock[g] ?? 0;
        }
      }
      if (!stacks) continue;
      const hp = houseRoomPlan(t.stage.center, house, t.deltas.get(`h_${hi}`));
      for (const room of hp.rooms) {
        if (room.kind !== "store" && room.kind !== "workshop") continue;
        zones.push({ ...room.rect, scale: Math.max(0.5, 1 - 0.12 * stacks) });
      }
    }
    const dragKey = JSON.stringify(zones);
    if (dragKey !== lastDragKey) {
      lastDragKey = dragKey;
      world.setDragZones(zones);
    }
  }

  /** A loose prop on the ground is picked up: MERGE its glyph into the pocket count and
   *  drop the concrete instance (the pocket is counts, not instances). */
  function pocketLoose(session: QuestSession, objId: string) {
    const rec = session.smallProps.get(objId);
    if (!rec) return;
    stackAdd(session.pocket, rec.glyph);
    world?.removeObject(objId);
    session.smallProps.delete(objId);
    if (session.creatures) delete session.creatures.world.items[rec.entityId]; // count now, not an instance
    pushPocket(session);
  }

  /** Spawn a loose, carryable prop for a glyph at a ground point — a fresh materialized
   *  instance (so it can be carried/owned); picking it up merges it back to a count. */
  function spawnLooseProp(session: QuestSession, glyph: string, x: number, y: number) {
    if (!world) return;
    const entityId = materialize(session, glyph, null);
    const objId = `small:${entityId}`;
    world.addObject({ id: objId, x, y, shape: "sphere", radius: 0.35, interactions: ["carry"], glyph });
    session.smallProps.set(objId, { entityId, glyph, at: session.townClock }); // `at` paces the tidy grace
  }

  /** Drop one of the selected stack onto the ground (loose again, re-grabbable). */
  function dropSelected(session: QuestSession, x: number, y: number) {
    const glyph = session.selectedPocketGlyph;
    if (!glyph || !stackTake(session.pocket, glyph)) return;
    spawnLooseProp(session, glyph, x, y);
    if (!session.pocket[glyph]) session.selectedPocketGlyph = null;
    pushPocket(session);
  }

  /** Put one of the selected stack INTO a container — a count move into its stack map.
   *  A TABLE (relation `on`) ALSO gets a VISIBLE materialized prop `containedIn` it, since
   *  a table's contents are shown; a chest/cupboard (`in`) just holds the count. */
  function putSelectedIn(session: QuestSession, containerObjId: string) {
    const glyph = session.selectedPocketGlyph;
    if (
      !glyph ||
      !world ||
      session.marketStore.has(containerObjId) ||
      session.produceBox.has(containerObjId) ||
      containerObjId.startsWith("trade:")
    ) {
      return; // markets, producer piles + trade crates are economy-driven (derived stock, no puts)
    }
    if (!stackTake(session.pocket, glyph)) return;
    const stock = session.containerStock.get(containerObjId) ?? {};
    stackAdd(stock, glyph);
    session.containerStock.set(containerObjId, stock);
    addVisibleContainedProp(session, containerObjId, glyph);
    if (!session.pocket[glyph]) session.selectedPocketGlyph = null;
    pushPocket(session);
  }

  /** Present one of the selected stack to the conversation partner — an OFFER. Materialize
   *  a concrete instance to hand over (generosity/`giveItem` need a real item); on accept
   *  decrement the stack, on decline delete the throwaway instance. */
  function presentSelected(session: QuestSession) {
    const glyph = session.selectedPocketGlyph;
    if (!glyph || !convo || !session.pocket[glyph]) return;
    const entityId = materialize(session, glyph, PLAYER_CREATURE_ID);
    runCreatureAct({ kind: "offer", itemId: entityId, glyph });
    const accepted = session.creatures?.world.items[entityId]?.ownerId !== PLAYER_CREATURE_ID;
    if (accepted) {
      stackTake(session.pocket, glyph); // the gift left the pocket
      if (!session.pocket[glyph]) session.selectedPocketGlyph = null;
    } else if (session.creatures) {
      delete session.creatures.world.items[entityId]; // declined — no lingering instance
    }
    pushPocket(session);
  }

  /** Seed a couple of grabbable loose props at the market so the pickup→stack path can be
   *  exercised (they MERGE into the pocket count). No-op off a town session. */
  function seedSmallItems(session: QuestSession) {
    if (!world || !session.town) return;
    const refHouse = session.town.plan.houses[0];
    if (!refHouse) return;
    session.town.stage.goods.forEach((g, gi) => {
      const src = g.sourceOf(refHouse);
      // Food scatters as its fruit KINDS (an apple, a banana, a grape at the
      // stall) — the loose props people can name, like, and ask for. CLOTHING
      // has a large (head × colour) vocabulary, so scatter only a couple of the
      // town's PALETTE garments, not one of every colour (a heap of shirts).
      const sample =
        g.good.key === "clothing"
          ? Object.keys(dealGood(session.dress, "clothing", 2, gi))
          : [...kindsOf(g.good.key)];
      sample.forEach((k, ki) => {
        spawnLooseProp(session, k, src.x + gi * 1.4 + ki * 0.9, src.y + 0.6 + ki * 0.3);
      });
    });
    // ONE rare treat on display at the depot — the real item that lets the
    // preference voice ("i_me want cookie") and the §2b chain engage.
    const tr = session.town.stage.trade;
    if (tr) spawnLooseProp(session, tr.route.rare.kind, tr.depot.x - 1.1, tr.depot.y + 1.0);
  }

  /** STORES + CONTAINERS — ONE abstraction. Register every openable container (its
   *  objectId → placement relation) and fill the ones that ship with stock:
   *   • MARKET stalls — a persistent box at each good's `sourceOf` (same spot "where is
   *     food?" points to); stock is DYNAMIC (economy `stockOf` − `marketConsumed`).
   *   • HOUSEHOLD furniture — chests (stocked with the house's goods), cupboards, and
   *     tables (empty, but openable/putable); a table renders its contents `on` it.
   *  A building's inventory is just the AGGREGATE of its containers' stacks. No-op off a
   *  town session. */
  function stockContainers(session: QuestSession) {
    const town = session.town;
    if (!world || !town) return;
    const refHouse = town.plan.houses[0];
    if (!refHouse) return;
    const vendorOf = (key: string): string | null =>
      town.bundle.cast.find((c) => c.role === "vendor" && c.good === key)?.nodeId ?? null;

    // MARKET stalls — a real openable box at each store, stock driven by the economy.
    town.stage.goods.forEach((g, gi) => {
      const src = g.sourceOf(refHouse);
      const objId = `store:${g.good.key}`;
      world!.addObject({
        id: objId,
        x: src.x + 1.4, // off to the side of the shopper's spot so it never blocks the stall
        y: src.y - 0.2 + gi * 0.2,
        shape: "box",
        radius: 0.6,
        fixture: "chest",
        openable: true,
        facing: 0,
        interactions: [],
        contains: [{ relation: "in", capacity: STORE_DISPLAY_CAP }],
        glyph: g.good.key,
      });
      session.containers.set(objId, "in");
      session.marketStore.set(objId, g.good.key);
      session.containerOwner.set(objId, vendorOf(g.good.key));
    });

    // THE TOWN WELL — the free water source on the square: no shelf economics,
    // never runs dry (need takes draw directly; the stocked stack serves the
    // player's own bucket). Working it needs grasp — a pet can't draw.
    world!.addObject({
      id: "well",
      x: town.stage.center.x + 2.5,
      y: town.stage.center.y + 2.5,
      shape: "box",
      radius: 0.8,
      fixture: "barrel",
      openable: false,
      facing: 0,
      interactions: [],
      contains: [{ relation: "in", capacity: 99 }],
      glyph: "water",
    });
    session.containers.set("well", "in");
    session.containerStock.set("well", { water: 99 });
    session.containerOwner.set("well", TOWN_SCOPE); // communal at the TOWN tier

    // THE BUILDER'S YARD (city-expansion ②, the ①b gap): the town's material
    // stock (deltas.stock) standing as a REAL crate beside the hall — the
    // FoundedSite-crate pattern: the container's stack map IS deltas.stock
    // (aliased, never copied), so ordinary container puts/takes and transfer
    // hauls keep the build-order spend model true. Deposit wood here and a
    // "build house" can afford it.
    {
      const hallIdx = town.plan.works.findIndex((wk) => wk.type === "hall");
      const hallDoor =
        hallIdx >= 0
          ? workDoorstep(town.stage.center, town.plan.works[hallIdx]!)
          : { x: town.stage.center.x, y: town.stage.center.y };
      world!.addObject({
        id: TOWN_YARD_ID,
        x: hallDoor.x - 2.2,
        y: hallDoor.y + 1.2,
        shape: "box",
        radius: 0.7,
        fixture: "chest",
        openable: true,
        facing: 0,
        interactions: [],
        contains: [{ relation: "in", capacity: 99 }],
        iconRef: "🏗️",
        glyph: "wood",
      });
      session.containers.set(TOWN_YARD_ID, "in");
      session.containerStock.set(TOWN_YARD_ID, town.deltas.stock); // ALIAS — the one stack map
      session.containerOwner.set(TOWN_YARD_ID, TOWN_SCOPE); // communal
    }

    // PRODUCER piles — the "the farm made this" box at each producer work's
    // gate (goods.ts `produceAt`: fills across the day, the dawn cart empties
    // it) — the START of the visible farm→market flow. Openable like a store;
    // player takes deplete via a consumed offset.
    town.stage.goods.forEach((g) => {
      for (const w of g.producerWorks()) {
        const wk = town.plan.works[w];
        if (!wk) continue;
        const d = workDoorstep(town.stage.center, wk);
        const objId = `produce:${g.good.key}:${w}`;
        world!.addObject({
          id: objId,
          x: d.x - 1.4,
          y: d.y + 0.6,
          shape: "box",
          radius: 0.55,
          fixture: "chest",
          openable: true,
          facing: 0,
          interactions: [],
          contains: [{ relation: "in", capacity: STORE_DISPLAY_CAP }],
          glyph: g.good.key,
        });
        session.containers.set(objId, "in");
        session.produceBox.set(objId, { key: g.good.key, work: w });
        session.containerOwner.set(objId, null);
      }
    });

    // DEFINED ITEMS (world doc `entities.objects`) — hand-authored things in
    // the family house: on the table, in the box, or loose on the floor.
    const fam = familyOf(session);
    const definedItems = session.town?.config.items;
    if (fam && definedItems?.length) {
      // By LOT id, not array position (stall conversions leave gaps).
      const fh = town.plan.houses.find((hh) => hh.index === fam.house);
      if (fh) {
        const flr = livingRect(town.stage.center, fh);
        definedItems.forEach((it, i) => {
          if (it.at === "floor") {
            // Loose props land on the LIVING room floor (the footprint
            // center can be a partition wall now; rooms.ts).
            spawnLooseProp(
              session,
              it.glyph,
              flr.x + flr.w / 2 + 1 + i * 0.8,
              flr.y + flr.h / 2 + 0.8,
            );
          } else {
            // `at:"box"` seeds into a member's box (0's — the boxes are
            // per-member now; there is no communal one). `at:"table"` unchanged.
            const objId = it.at === "table" ? `furn_${fam.house}_table` : `furn_${fam.house}_box_0`;
            const stock = session.containerStock.get(objId) ?? {};
            stock[it.glyph] = (stock[it.glyph] ?? 0) + 1;
            session.containerStock.set(objId, stock);
          }
        });
      }
    }

    // TRADE DEPOT — the intercity line's two crates beside the hall: IMPORTS
    // (trinkets the caravan brings; refreshes per visit) and the EXPORT pile
    // (the food surplus it will carry away — steal from it and the caravan
    // leaves light). Both derived stocks, same consumed-offset honesty.
    const tr = town.stage.trade;
    if (tr) {
      for (const [objId, dx, glyph] of [
        ["trade:imports", 0, TRADE_IMPORT_KINDS[0]!],
        ["trade:exports", 1.6, "food"],
      ] as const) {
        world!.addObject({
          id: objId,
          x: tr.depot.x + dx,
          y: tr.depot.y,
          shape: "box",
          radius: 0.55,
          fixture: "chest",
          openable: true,
          facing: 0,
          interactions: [],
          contains: [{ relation: "in", capacity: STORE_DISPLAY_CAP }],
          glyph,
        });
        session.containers.set(objId, "in");
        session.containerOwner.set(objId, null);
      }
    }

    // HOUSEHOLD furniture — the SAME container path (deterministic ids from houseFurniture,
    // present only while inside the house). Chests ship with the house's goods; cupboards
    // and tables start empty but are equally openable/putable. Round-2 stations:
    // the water BARREL ships stocked (thirst's home box), the trash BIN and the
    // pet BOWL start empty ("on" — a floor dish shows its meal).
    for (const house of town.plan.houses) {
      // COMMUNAL furniture belongs to the HOUSEHOLD tier (ownership.ts) —
      // every member's walker may list it; outsiders' never do.
      const owner = houseScope(house.index);
      session.containers.set(`furn_${house.index}_cupboard`, "in");
      session.containers.set(`furn_${house.index}_table`, "on");
      // (No communal toy box — each member owns one, seeded in the private
      // tier below.)
      session.containers.set(`furn_${house.index}_barrel`, "in");
      session.containers.set(`furn_${house.index}_bin`, "in");
      session.containers.set(`furn_${house.index}_bowl`, "on");
      session.containerOwner.set(`furn_${house.index}_cupboard`, owner);
      session.containerOwner.set(`furn_${house.index}_table`, owner);
      session.containerOwner.set(`furn_${house.index}_barrel`, owner);
      session.containerOwner.set(`furn_${house.index}_bin`, owner);
      session.containerOwner.set(`furn_${house.index}_bowl`, owner);
      session.containerStock.set(`furn_${house.index}_barrel`, { water: BARREL_CAP - 2 });
      for (const g of town.stage.goods) {
        const objId = `furn_${house.index}_chest_${g.good.key}`;
        session.containers.set(objId, "in");
        // Seed the chest to the REAL pantry level (doc §13a.3) — so eating draws down a
        // truthful count, not a token 2. Clamped to the box capacity; food splits
        // into fruit KINDS (each house flavors its own pantry mix).
        const level = Math.min(g.boxCap, Math.max(1, Math.round(g.pantry(house, session.townClock))));
        session.containerStock.set(objId, dealGood(session.dress, g.good.key, level, house.index));
        session.containerOwner.set(objId, owner);
      }
      // PRIVATE tier: each member's personal BOX (furniture places it in
      // their own bedroom, fit permitting) and their BED. The double bed
      // (bed_0) belongs to members 0+1; the singles split the rest by the
      // room plan. Entries for pieces the fit rule omitted are inert.
      const cidOf = (m: number) => creatureScope(`resident_${house.index}_${m}`);
      for (let m = 0; m < HOUSEHOLD; m++) {
        const boxId = `furn_${house.index}_box_${m}`;
        session.containers.set(boxId, "in");
        session.containerOwner.set(boxId, cidOf(m));
      }
      const rp = houseRoomPlan(town.stage.center, house);
      session.containerOwner.set(`furn_${house.index}_bed_0`, `${cidOf(0)}|${cidOf(1)}`);
      if (rp.bedrooms.length >= 2) {
        session.containerOwner.set(`furn_${house.index}_bed_1`, `${cidOf(2)}|${cidOf(3)}`);
        session.containerOwner.set(`furn_${house.index}_bed_2`, cidOf(4));
      } else {
        session.containerOwner.set(`furn_${house.index}_bed_1`, `${cidOf(2)}|${cidOf(3)}|${cidOf(4)}`);
      }
    }
  }

  /** The chains' LIVING ends: SHEEP grazing beside the cloth producer (wool on
   *  the hoof) and FRUIT TREES standing by the farms (the orchard the food
   *  comes from). Ambient scenery bodies — tiny tethers, no schedule; they ride
   *  the fauna headroom above the crowd budget. No-op off a town session. */
  function seedTownFauna(session: QuestSession) {
    const town = session.town;
    if (!town || !world) return;
    const c = town.stage.center;
    let treeCount = 0;
    town.stage.goods.forEach((g) => {
      for (const w of g.producerWorks()) {
        const wk = town.plan.works[w];
        if (!wk) continue;
        const d = workDoorstep(c, wk);
        if (g.good.key === "cloth") {
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + 0.7;
            world!.addNpc({
              id: `sheep_${w}_${i}`,
              x: d.x + Math.cos(a) * 4.5,
              y: d.y + Math.sin(a) * 4.5,
              behavior: {
                movement: "wander",
                wanderRadius: 5,
                home: { x: d.x, y: d.y },
                speed: 0.5,
                conversationRadius: 3,
              },
            });
          }
        }
        if (g.good.key === "food" && treeCount < 9) {
          // A short orchard row along the building's north edge, one tree per
          // fruit kind — clear of the doorstep (doors face the road).
          FRUIT_TREES.forEach((ft, fi) => {
            if (treeCount >= 9) return;
            const tx = c.x + wk.dx + 2 + fi * 4.5;
            const ty = c.y + wk.dy - 2.5;
            world!.addNpc({
              id: `tree_${ft.fruit}_${w}_${fi}`,
              x: tx,
              y: ty,
              // Rooted: zero tether AT its own spot, zero speed — a tree.
              behavior: { movement: "wander", wanderRadius: 0, home: { x: tx, y: ty }, speed: 0, conversationRadius: 1 },
            });
            treeCount++;
          });
        }
      }
    });
  }

  /** A market store's currently-available unit count: the time-pure shelf (`stockOf` at
   *  the town clock — already drained by the modelled NPC shoppers) minus the player's
   *  own consumed offset THIS day, floored, capped to the display. 0 ⇒ sold out. */
  function marketStoreUnits(session: QuestSession, objId: string): number {
    const town = session.town;
    const key = session.marketStore.get(objId);
    const refHouse = town?.plan.houses[0];
    const g = key ? town?.stage.goods.find((x) => x.good.key === key) : undefined;
    if (!town || !g || !refHouse) return 0;
    // JOBS→ECONOMY: yesterday's producer absence thins today's dawn stock.
    // TRADE→ECONOMY (nations P6): so does a PAUSED ROUTE — an embargo, a
    // partner's famine, a war on the road. Same shape of fact one tier up,
    // so the shelf reads thin and the market remark says "less + food"
    // without a scripted announcement.
    const base =
      g.stockOf(g.sourceOf(refHouse), session.townClock) *
      producerAttendance(session, key!) *
      inboundRouteHealth(session.transfers.active(), key!);
    const left = storeUnitsLeft(base, session.marketConsumed.get(key!), session.townClock);
    return Math.min(STORE_DISPLAY_CAP, Math.floor(left));
  }

  /** A producer pile's currently-available units: the day's accumulated
   *  production (damped by that work's attendance) minus the player's takes. */
  function produceBoxUnits(session: QuestSession, objId: string): number {
    const town = session.town;
    const pb = session.produceBox.get(objId);
    const g = pb ? town?.stage.goods.find((x) => x.good.key === pb.key) : undefined;
    if (!town || !pb || !g) return 0;
    const day = Math.floor(session.townClock / FOOD_DAY_SEC);
    const base =
      g.produceAt(pb.work, session.townClock) * workAttendanceFactor(session, pb.work, day);
    const left = storeUnitsLeft(base, session.produceConsumed.get(objId), session.townClock);
    return Math.min(STORE_DISPLAY_CAP, Math.floor(left));
  }

  /** A container's contents as a glyph→count STACK — the ONE accessor over all kinds: a
   *  market store's / producer pile's stack is derived from the economy; every other
   *  container's is stored. */
  /** The import crate's remaining stack — an even per-kind allotment for the
   *  current caravan VISIT, minus this visit's takes. */
  function tradeImportContents(session: QuestSession): Record<string, number> {
    const tr = session.town?.stage.trade;
    if (!tr) return {};
    const bucket = tr.tradeDay(session.townClock);
    const taken = session.tradeImportTaken?.day === bucket ? session.tradeImportTaken.taken : {};
    const per = Math.floor(IMPORT_ALLOTMENT / TRADE_IMPORT_KINDS.length);
    const out: Record<string, number> = {};
    for (const k of TRADE_IMPORT_KINDS) {
      const n = Math.max(0, per - (taken[k] ?? 0));
      if (n > 0) out[k] = n;
    }
    // The RARE cargo: the farther the partner, the fewer arrive (travel cost
    // as scarcity — trade.ts scales perVisit by the bound distance).
    const rare = tr.route.rare;
    const rn = Math.max(0, rare.perVisit - (taken[rare.kind] ?? 0));
    if (rn > 0) out[rare.kind] = rn;
    return out;
  }

  /** The export pile's units: the day's surplus so far, DAMPED by producer
   *  attendance (a poached farm crew truthfully thins the load), minus thefts. */
  function tradeExportUnits(session: QuestSession): number {
    const tr = session.town?.stage.trade;
    if (!tr) return 0;
    const base = tr.exportPile(session.townClock) * producerAttendance(session, "food");
    const left = storeUnitsLeft(base, session.tradeExportConsumed ?? undefined, session.townClock);
    return Math.min(STORE_DISPLAY_CAP, Math.floor(left));
  }

  function containerContents(session: QuestSession, objId: string): Record<string, number> {
    if (objId === "trade:imports") return tradeImportContents(session);
    if (objId === "trade:exports") return splitStock("food", tradeExportUnits(session), 2);
    const key = session.marketStore.get(objId);
    if (key) {
      const n = marketStoreUnits(session, objId);
      return dealGood(session.dress, key, n, 0); // food its fruit mix; clothing its palette
    }
    const pb = session.produceBox.get(objId);
    if (pb) {
      const n = produceBoxUnits(session, objId);
      return splitStock(pb.key, n, pb.work);
    }
    return session.containerStock.get(objId) ?? {};
  }

  /** Total items in a container (openability test). */
  const containerCount = (session: QuestSession, objId: string): number =>
    Object.values(containerContents(session, objId)).reduce((a, b) => a + b, 0);

  /** The nearest registered container to `me` within `CONVO_RADIUS` whose world object is
   *  present (streamed in). Fixtures aren't reliably in the gaze screen-pick, so we match
   *  BY POSITION (like the conversation dwell). `requireContents` restricts to non-empty
   *  ones (openable now) vs. any (a put target). */
  /** The motive a hovered world object draws attention to (spark-attention.ts),
   *  read from the object's OWN affordances / station role (the affordance law)
   *  — or null when it serves no meter-driven motive. A loose prop speaks
   *  through its glyph (concept affordances + object properties); a fixture
   *  through the station kind encoded in its id. */
  function hoverObjectMotive(session: QuestSession, objId: string): AttentionMotive | null {
    const prop = session.smallProps.get(objId);
    if (prop) {
      const head = headOf(prop.glyph);
      return objectMotive({
        affords: CONCEPT_LIBRARY.get(head)?.affords ?? [],
        properties: propertiesOf(prop.glyph),
        stationKind: null,
        isWater: isKindOf(prop.glyph, "water"),
      });
    }
    if (objId === "well") {
      return objectMotive({ affords: [], properties: [], stationKind: "well", isWater: true });
    }
    // Fixtures: `furn_<houseIndex>_<kind>` — strip a trailing instance index
    // (bed_0 → bed) to recover the station kind.
    const fm = objId.match(/^furn_\d+_(.+)$/);
    if (fm) {
      const kind = (fm[1] ?? "").replace(/_\d+$/, "");
      return objectMotive({ affords: [], properties: [], stationKind: kind, isWater: false });
    }
    return null;
  }

  /** Phase 2 — the CHORE a hovered object implies when it serves no meter motive:
   *  a storage box says "check if it needs filling" (provision), a loose thing on
   *  the ground says "put it away" (tidy). Only reached for objects `hoverObjectMotive`
   *  didn't claim (food/toy/bed…), so a food prop is still eaten, not swept. */
  function hoverObjectChore(session: QuestSession, objId: string): "tidy" | "provision" | null {
    if (session.containers.has(objId)) return "provision"; // a chest/cupboard → fill-check
    if (session.smallProps.has(objId)) return "tidy"; // loose clutter → put away
    return null;
  }

  /** Per-frame update of the spark's attention field (spark-attention.ts): ramp
   *  toward whatever the gaze hovers — an object's MOTIVE (draw), a CREATURE
   *  (focus), or a bare AREA (a motiveless draw, for the idle-move nudge) — and
   *  decay what is left. `blocked` (a conversation / open container / menu) means
   *  the spark draws nothing this frame; the field just fades. */
  function stepSparkAttention(session: QuestSession, host: WorldHost, dt: number, blocked: boolean) {
    // A deliberate BOARD SELECTION (Phase 3) holds its explicit draw at full
    // strength — the gaze doesn't override a pressed word until the hold lapses.
    if (session.townClock < session.sparkExplicitUntil) {
      if (session.sparkDraw) session.sparkDraw = { ...session.sparkDraw, strength: 1 };
      return;
    }
    const gz = host.getGaze();
    const hover = gz.hover;
    let target: { motive: AttentionMotive; x: number; y: number } | null = null;
    let choreTarget: { chore: "tidy" | "provision"; x: number; y: number } | null = null;
    let engageCid: string | null = null;
    if (!blocked) {
      if (hover?.kind === "object") {
        const o = host.state.objects[hover.id];
        const motive = hoverObjectMotive(session, hover.id);
        if (motive && o) target = { motive, x: o.x, y: o.y };
        else if (o) {
          const chore = hoverObjectChore(session, hover.id);
          if (chore) choreTarget = { chore, x: o.x, y: o.y };
        }
      } else if (hover?.kind === "avatar" && hover.id !== PLAYER_ID) {
        engageCid = hover.id;
      }
      // A bare-ground gaze draws nothing on its own (movement needs the explicit
      // oscillation gesture — stepSparkOsc — not a passive area hold).
    }
    // DRAW — ramp the hovered object's motive (fresh strength on a motive switch), else fade.
    if (target) {
      const d = session.sparkDraw;
      const prev = d && d.motive === target.motive ? d.strength : 0;
      session.sparkDraw = { motive: target.motive, x: target.x, y: target.y, strength: ramp(prev, dt) };
    } else if (session.sparkDraw) {
      const s = decayStrength(session.sparkDraw.strength, dt, SPARK.drawDecayS);
      session.sparkDraw = s > 0 ? { ...session.sparkDraw, strength: s } : null;
    }
    // CHORE — same ramp/fade for a hovered storage/clutter object.
    if (choreTarget) {
      const c = session.sparkChore;
      const prev = c && c.chore === choreTarget.chore ? c.strength : 0;
      session.sparkChore = { ...choreTarget, strength: ramp(prev, dt) };
    } else if (session.sparkChore) {
      const s = decayStrength(session.sparkChore.strength, dt, SPARK.drawDecayS);
      session.sparkChore = s > 0 ? { ...session.sparkChore, strength: s } : null;
    }
    // ENGAGEMENT — hovering a creature engages it; else hold (a conversation /
    // directive) or decay. Switching to a different creature drops any held
    // engagement on the previous one.
    if (engageCid) {
      const f = session.sparkFocus;
      const prev = f && f.cid === engageCid ? f.strength : 0;
      if (!f || f.cid !== engageCid) session.sparkEngageHold = 0;
      session.sparkFocus = { cid: engageCid, strength: ramp(prev, dt) };
    } else if (session.townClock < session.sparkEngageHold) {
      if (session.sparkFocus) session.sparkFocus = { ...session.sparkFocus, strength: 1 };
    } else if (session.sparkFocus) {
      const s = decayStrength(session.sparkFocus.strength, dt, SPARK.engageDecayS);
      session.sparkFocus = s > 0 ? { ...session.sparkFocus, strength: s } : null;
    }
  }

  // SOFT CONTROL (attention-spark.md) — the DIRECTED gestures. The model:
  // ENGAGEMENT selects WHO (talk to / hover / oscillate on the creature), the
  // draw or the pointed thing selects WHAT. Only the engaged creature acts, and
  // only if it is genuinely IDLE — never a body doing something (pursuit / task /
  // firing need / mid-walk). Self-limits (acting ⇒ no longer idle).
  const ENGAGE_MIN = 0.4; // engagement needed before a creature will be directed
  const CHORE_STRENGTH = 0.85; // a deliberate hold on the chore object
  const ENGAGE_CONVO_HOLD_S = 8; // engagement held this long after a conversation
  const ENGAGE_DIRECT_HOLD_S = 4; // …and after an oscillation / board directive
  const DIRECT_MIN_M = 2.5; // already-there → don't re-path (no jitter)
  const DIRECT_MAX_M = 26; // a directed move stays local
  const OSC_TRIGGER = 3; // creature↔point flips for the oscillation directive
  const OSC_GAP_S = 1.1; // the flips must come quickly, or the gesture resets
  const OSC_POINT_TOL_M = 3; // the point side must stay roughly put

  /** Is `cid` a directable body that is genuinely IDLE (never interrupt a task)? */
  function idleForDirect(session: QuestSession, cid: string): boolean {
    if (cid === PLAYER_ID) return false;
    if (!isPetCid(cid) && !/^resident_\d+_\d+$/.test(cid)) return false;
    if (session.party.has(cid) || session.pursuits.has(cid)) return false;
    if (session.liveNeedBodies.has(cid) || session.needStep.has(cid)) return false;
    if (session.walk.has(cid)) return false; // mid-walk (heading home / escort)
    if ((session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0) return false;
    return true;
  }

  /** Engage `cid` at full strength and hold it for `holdS` (a conversation / a
   *  directive) — so a follow-up selection still lands on this creature. */
  function engageCreature(session: QuestSession, cid: string, holdS: number) {
    session.sparkFocus = { cid, strength: 1 };
    session.sparkEngageHold = session.townClock + holdS;
  }

  /** Promote an ENGAGED idle creature to run a household CHORE — but only if it
   *  actually FIRES right now (a box below its buffer, real clutter), so pointing
   *  at a full box is a no-op. The need loop then drives + announces it. */
  function promoteChore(session: QuestSession, state: WorldState, cid: string, chore: "tidy" | "provision"): boolean {
    const houseIndex = houseIndexOfCid(cid);
    const member = Number(cid.split("_")[2]);
    const house = residentTownCtx(session, houseIndex)?.house;
    const templates = isPetCid(cid)
      ? petNeedTemplates(session)
      : house
        ? residentNeedTemplates(session, houseIndex, house, member)
        : null;
    if (!templates) return false;
    const fires = templates.some((t) => {
      if (!t.key.startsWith(chore)) return false;
      const intent = decideNeed(t, residentNeedCtx(session, state, cid, houseIndex, t, templates));
      return intent.kind !== "idle" && intent.kind !== "blocked";
    });
    if (!fires) return false; // nothing to fill / nothing loose — no busywork
    session.liveNeedBodies.add(cid);
    session.needStep.delete(cid);
    session.sparkActing.add(cid); // the need loop announces the chosen chore
    return true;
  }

  /** Engage `cid` and set a held DRAW of `motive` at `pt` — the engaged body's
   *  matching need fires and it goes to use the thing. Idle-gated. */
  function useItemMotive(session: QuestSession, cid: string, pt: { x: number; y: number }, motive: AttentionMotive) {
    if (!idleForDirect(session, cid)) return;
    engageCreature(session, cid, ENGAGE_DIRECT_HOLD_S);
    session.sparkDraw = { motive, x: pt.x, y: pt.y, strength: 1 };
    session.sparkExplicitUntil = session.townClock + ENGAGE_DIRECT_HOLD_S;
  }

  /** The motive a bare GLYPH implies (a box's item word — food→hunger, a toy→fun),
   *  read from the spec side like hoverObjectMotive but off the glyph directly. */
  function glyphMotive(glyph: string): AttentionMotive | null {
    const head = glyph.split(".")[0] ?? glyph;
    return objectMotive({
      affords: CONCEPT_LIBRARY.get(head)?.affords ?? [],
      properties: propertiesOf(glyph),
      stationKind: null,
      isWater: isKindOf(glyph, "water"),
    });
  }

  /** DIRECT the engaged creature `cid` at a specific point/object (an oscillation
   *  or a board press): engage it fully, then — an object with a motive → USE it
   *  (a held draw the engaged body responds to); a chore object → do the chore; a
   *  bare point → go there. Idle-gated (never interrupts). */
  function directCreatureTo(session: QuestSession, cid: string, pt: { x: number; y: number }, objId: string | null) {
    if (!world || !idleForDirect(session, cid)) return;
    const motive = objId ? hoverObjectMotive(session, objId) : null;
    if (motive) {
      useItemMotive(session, cid, pt, motive);
      console.log(`[spark] direct ${cid} → use ${objId} (${motive})`);
      return;
    }
    engageCreature(session, cid, ENGAGE_DIRECT_HOLD_S);
    const chore = objId ? hoverObjectChore(session, objId) : null;
    if (chore) {
      promoteChore(session, world.state, cid, chore);
      console.log(`[spark] direct ${cid} → chore ${chore} @${objId}`);
      return;
    }
    // A bare point (or a plain object) — go there, if it's a real move.
    const body = world.state.avatars[cid];
    const dist = body ? Math.hypot(body.x - pt.x, body.y - pt.y) : 0;
    if (dist < DIRECT_MIN_M || dist > DIRECT_MAX_M) return;
    const goal: GoalSpec = { kind: "goTo", place: { kind: "point", x: pt.x, y: pt.y } };
    session.pursuits.set(cid, { source: "command", goal, glyph: "here" });
    announceSparkIntent(session, cid, goal);
    console.log(`[spark] direct ${cid} → goTo @${pt.x.toFixed(1)},${pt.y.toFixed(1)}`);
  }

  /** CHORE-hover: the engaged idle creature does the chore the hovered
   *  storage/clutter object implies (the meter-object case is handled by the draw
   *  bonus in residentNeedCtx; chores have no meter, so they route here). */
  function stepSparkDirect(session: QuestSession, state: WorldState) {
    const f = session.sparkFocus;
    if (!f || f.strength < ENGAGE_MIN) return; // no engaged creature → nobody acts
    if (!idleForDirect(session, f.cid)) return;
    const ch = session.sparkChore;
    if (ch && ch.strength >= CHORE_STRENGTH) {
      if (promoteChore(session, state, f.cid, ch.chore)) {
        session.sparkChore = null; // consumed
        console.log(`[spark] ${f.cid} (engaged) → chore ${ch.chore}`);
      }
    }
  }

  /** OSCILLATION — "look at a creature, then a point, back and forth". A clear,
   *  deliberate directive: after enough quick flips, the engaged creature is sent
   *  to USE the pointed object / GO to the pointed spot. This is the ONLY way the
   *  spark moves a creature to a point (a passive area gaze never does), so a move
   *  only ever happens when the player made the goal unmistakable. */
  function stepSparkOsc(session: QuestSession, host: WorldHost, dt: number) {
    const gz = host.getGaze();
    const hover = gz.hover;
    let osc = session.sparkOsc;
    // Classify this frame's gaze side.
    if (hover?.kind === "avatar" && hover.id !== PLAYER_ID) {
      const cid = hover.id;
      if (osc && osc.cid === cid) {
        if (osc.lastSide === "pt") osc.flips++;
        osc.sinceFlip = 0;
        osc.lastSide = "cre";
      } else {
        session.sparkOsc = osc = { cid, x: NaN, y: NaN, objId: null, flips: 0, sinceFlip: 0, lastSide: "cre" };
      }
    } else if (gz.committedWorld) {
      const p = gz.committedWorld;
      const objId = hover?.kind === "object" ? hover.id : null;
      if (osc) {
        const firstPoint = !Number.isFinite(osc.x);
        const near = firstPoint || Math.hypot(p.x - osc.x, p.y - osc.y) <= OSC_POINT_TOL_M;
        if (near) {
          if (osc.lastSide === "cre") osc.flips++;
          osc.sinceFlip = 0;
          osc.lastSide = "pt";
          osc.x = p.x;
          osc.y = p.y;
          osc.objId = objId;
        } else {
          // The point jumped — restart the point side (keep the creature anchor).
          osc.x = p.x;
          osc.y = p.y;
          osc.objId = objId;
          osc.lastSide = "pt";
          osc.flips = 1;
          osc.sinceFlip = 0;
        }
      }
    }
    // Time out a stalled gesture.
    if (osc) {
      osc.sinceFlip += dt;
      if (osc.sinceFlip > OSC_GAP_S) {
        session.sparkOsc = null;
        return;
      }
      if (osc.flips >= OSC_TRIGGER && Number.isFinite(osc.x)) {
        directCreatureTo(session, osc.cid, { x: osc.x, y: osc.y }, osc.objId);
        session.sparkOsc = null; // consumed
      }
    }
  }

  /** SOFT CONTROL Phase 2 — between two creatures. Resting the gaze on the GAP
   *  between two nearby townsfolk (not on either one) prompts them to talk to
   *  each other: a universal "you two, chat" gesture, run through the ordinary
   *  NPC exchange. Cooldown-gated (runNpcExchange sets it on both), so it can't
   *  spam. */
  const PAIR_POINT_RADIUS = 3.2; // both people within this of the gaze point
  const PAIR_APART_MAX = 4.5; // and close enough to actually talk
  function stepSparkPairChat(session: QuestSession, state: WorldState, host: WorldHost, dt: number) {
    if (!session.creatures) {
      pairDwell.step(null, dt * 1000);
      return;
    }
    const gz = host.getGaze();
    const pt = gz.committedWorld;
    // A specific creature under the gaze is the FOCUS gesture, not this one.
    if (!pt || gz.hover?.kind === "avatar") {
      pairDwell.step(null, dt * 1000);
      return;
    }
    const near: { cid: string; d: number; x: number; y: number }[] = [];
    for (const cid of session.creatures.nodeByCreature.keys()) {
      if (session.party.has(cid)) continue;
      if ((session.chatCooldown.get(cid) ?? 0) > 0) continue;
      const av = chatAvatar(state, cid);
      if (!av) continue;
      const d = Math.hypot(av.x - pt.x, av.y - pt.y);
      if (d > PAIR_POINT_RADIUS) continue;
      near.push({ cid, d, x: av.x, y: av.y });
    }
    near.sort((a, b) => a.d - b.d);
    const a = near[0];
    const b = near[1];
    if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > PAIR_APART_MAX) {
      pairDwell.step(null, dt * 1000);
      return;
    }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (pairDwell.step(mid, dt * 1000).fired) {
      runNpcExchange(session, a.cid, b.cid);
      warmRelations(session, a.cid, b.cid, { affinity: 0.03 });
      console.log(`[spark] pair chat ${a.cid} ↔ ${b.cid}`);
    }
  }

  // SOFT CONTROL Phase 3 — the BOARD word press. Pressing a surfaced object word
  // is a DELIBERATE selection: it directs a creature (the ENGAGED one, else the
  // nearest idle body present) to that specific thing (attention-spark.md).
  const ATTEND_REACH_M = 16; // how far a board press reaches for an idle body

  /** The nearest idle creature to a point (within reach), preferring the player's
   *  own group — the body a board press falls back to when no creature is engaged.
   *  Close radius only, so a press never pulls someone in from across town. */
  function nearestIdleGroupCreature(
    session: QuestSession,
    state: WorldState,
    point: { x: number; y: number },
    maxDist: number,
  ): string | null {
    let best: string | null = null;
    let bestScore = Infinity;
    for (const [cid, av] of Object.entries(state.avatars)) {
      if (!idleForDirect(session, cid)) continue;
      const d = Math.hypot(av.x - point.x, av.y - point.y);
      if (d > maxDist) continue;
      // Prefer in-group: an out-group body is only picked if much nearer.
      const score = d + (inPlayerGroup(session, cid) ? 0 : maxDist);
      if (score < bestScore) {
        bestScore = score;
        best = cid;
      }
    }
    return best;
  }

  /** The word a world object is named by on the board (AAC — pressing it says
   *  it). A loose prop speaks its glyph; a fixture its station kind. */
  function objectWord(session: QuestSession, objId: string): string {
    const prop = session.smallProps.get(objId);
    if (prop) return prop.glyph;
    if (objId === "well") return "water";
    const fm = objId.match(/^furn_\d+_(.+)$/);
    if (fm) return ((fm[1] ?? "").replace(/_\d+$/, "").split("_")[0]) || "thing"; // chest_food→chest
    return "thing";
  }

  /** Draw a creature's attention to a SPECIFIC object (a pressed board word) —
   *  the ENGAGED creature if there is one (e.g. the one you just conversed with),
   *  else the nearest idle body already present. A deliberate selection, so it
   *  directs strongly; never pulls a distant body in. */
  function attendObject(session: QuestSession, objId: string) {
    if (!world) return;
    const state = world.state;
    const o = state.objects[objId];
    if (!o) return;
    const pt = { x: o.x, y: o.y };
    const engaged = session.sparkFocus;
    const cid =
      engaged && engaged.strength >= ENGAGE_MIN && idleForDirect(session, engaged.cid)
        ? engaged.cid
        : nearestIdleGroupCreature(session, state, pt, ATTEND_REACH_M);
    if (!cid) return;
    directCreatureTo(session, cid, pt, objId);
  }

  function nearestContainer(
    session: QuestSession,
    state: WorldState,
    me: { x: number; y: number } | undefined,
    requireContents: boolean,
  ): { id: string; x: number; y: number } | null {
    if (!me) return null;
    let target: { id: string; x: number; y: number } | null = null;
    let best = CONVO_RADIUS;
    for (const objId of session.containers.keys()) {
      const o = state.objects[objId];
      if (!o) continue;
      if (requireContents && containerCount(session, objId) <= 0) continue;
      const d = Math.hypot(me.x - o.x, me.y - o.y);
      if (d <= best) { best = d; target = { id: objId, x: o.x, y: o.y }; }
    }
    return target;
  }

  /** The non-empty container the GAZE fixation rests on, at any distance —
   *  the SPIRIT's way of looking inside (its body never approaches anything). */
  function containerAtGaze(
    session: QuestSession,
    state: WorldState,
    fix: { x: number; y: number } | null | undefined,
  ): { id: string; x: number; y: number } | null {
    if (!fix) return null;
    let target: { id: string; x: number; y: number } | null = null;
    let best = CONVO_FIG_RADIUS;
    for (const objId of session.containers.keys()) {
      const o = state.objects[objId];
      if (!o) continue;
      if (containerCount(session, objId) <= 0) continue;
      const d = Math.hypot(fix.x - o.x, fix.y - o.y);
      if (d <= best) { best = d; target = { id: objId, x: o.x, y: o.y }; }
    }
    return target;
  }

  /** OPEN a container as a SELECTION POPUP: its contents as a board of takeable STACKS,
   *  like a conversation. Stays open until the player walks/looks away (leave-dwell). */
  function openContainer(session: QuestSession, containerObjId: string) {
    if (!world || !world.state.objects[containerObjId]) return;
    if (containerCount(session, containerObjId) <= 0) return;
    container = { objId: containerObjId, items: [] };
    voice?.cancel();
    presentContainer(session);
  }

  /** Render the open container's contents as a board — one option per glyph STACK, its
   *  label carrying the count. */
  function presentContainer(session: QuestSession) {
    if (!container) return;
    const contents = containerContents(session, container.objId);
    const glyphs = Object.keys(contents);
    container.items = glyphs;
    if (glyphs.length === 0) {
      closeContainer();
      return;
    }
    const cObj = world?.state.objects[container.objId];
    if (cObj) world?.setConversation({ x: cObj.x, y: cObj.y });
    presenter.board({
      kind: "acts",
      nodeId: container.objId,
      posedByEntityId: container.objId,
      prompt: "open",
      promptText: "",
      options: [
        ...glyphs.map((glyph) => {
          const count = contents[glyph]!;
          const head = headOf(glyph);
          return { id: `take:${glyph}`, label: count > 1 ? `${head} ×${count}` : head, glyph, spokenText: "" };
        }),
        // Phase 3 (attention-spark.md): the container ITSELF, as well as its
        // contents — pressing it draws the family's attention to the box (a
        // fill-check) rather than taking from it.
        {
          id: `attend:${container.objId}`,
          label: objectWord(session, container.objId),
          glyph: objectWord(session, container.objId),
          spokenText: "",
        },
      ],
    });
  }

  /** A container owner SCOPE reduced to ONE representative creature id, for
   *  the legacy consumers that mark item ownership with a cid (visible "on"
   *  props → creature-world `ownerId`, which feeds the vendor-style pick
   *  veto and dialogue grants): the first named creature, a house's member
   *  0 (the historical stand-in), null for town/unowned. Legacy plain node
   *  ids (vendor stores) pass through untouched. */
  function representativeOwnerCid(owner: string | null | undefined): string | null {
    if (!owner || owner === TOWN_SCOPE) return null;
    const cids = ownerCidsOf(owner);
    if (cids.length) return cids[0]!;
    if (owner.startsWith("house:")) return `resident_${owner.slice(6)}_0`;
    return owner.includes(":") ? null : owner;
  }

  /** The owner OBJECTS to a take of their private property: ❌ at the box,
   *  "my X!" over the owner — the vendor-stock veto's voice, now speaking
   *  for the ownership layer's private tier. */
  function refusePrivateTake(session: QuestSession, objId: string, glyph: string, ownerCid: string) {
    if (!world) return;
    const box = world.state.objects[objId];
    if (box) {
      showWorldBubble(world.state, `denied:${objId}`, {
        anchor: { kind: "point", x: box.x, y: box.y },
        text: "❌",
        ttl: 1.6,
      });
    }
    const avId = avatarIdOf(ownerCid);
    if (world.state.avatars[avId]) {
      const g = `${headOf(glyph)}.my`;
      const ownerSym = creatureGlyph(session, ownerCid);
      showWorldBubble(world.state, `mine:${objId}`, {
        anchor: { kind: "avatar", id: avId },
        text: npcStatement(g, ownerSym, ownerCid),
        glyph: g,
        ttl: 2.5,
      });
      speakNpc(g, ownerSym, ownerCid);
    }
  }

  /** The nearest listed owner close enough to OBJECT to a take (the same
   *  8 m owner-present rule as the vendor-stock veto), else undefined. */
  function objectingOwner(owner: string | null | undefined, at: { x: number; y: number } | undefined): string | undefined {
    if (!at || !world) return undefined;
    return ownerCidsOf(owner).find((oc) => {
      const av = world!.state.avatars[avatarIdOf(oc)];
      return !!av && Math.hypot(av.x - at.x, av.y - at.y) <= 8;
    });
  }

  /** Take one of a glyph STACK out of the open container into the pocket — a count move.
   *  A MARKET store DEPLETES its shelf (the player's consumed offset over the time-pure
   *  economy); a stored container decrements its stack (and clears a table's visible prop).
   *  THE OWNER STOP-GATE (ownership.ts): taking PRIVATE property is refused while an
   *  owner is nearby to object — communal tiers stay takeable (stealing lands, visibly). */
  function takeFromContainer(session: QuestSession, glyph: string) {
    if (!container) return;
    const objId = container.objId;
    const cOwner = session.containerOwner.get(objId);
    if (isPrivateOwner(cOwner) && world) {
      const objector = objectingOwner(cOwner, world.state.objects[objId]);
      if (objector) {
        refusePrivateTake(session, objId, glyph, objector);
        return;
      }
    }
    const goodKey = session.marketStore.get(objId);
    const pb = session.produceBox.get(objId);
    if (objId === "trade:imports") {
      const tr = session.town?.stage.trade;
      if (!tr || (tradeImportContents(session)[glyph] ?? 0) <= 0) return;
      const bucket = tr.tradeDay(session.townClock);
      const rec = session.tradeImportTaken?.day === bucket ? session.tradeImportTaken : { day: bucket, taken: {} };
      rec.taken[glyph] = (rec.taken[glyph] ?? 0) + 1;
      session.tradeImportTaken = rec;
    } else if (objId === "trade:exports") {
      if (!isKindOf(glyph, "food") || tradeExportUnits(session) <= 0) return;
      session.tradeExportConsumed = addStoreConsumption(session.tradeExportConsumed ?? undefined, session.townClock);
    } else if (goodKey) {
      if (!isKindOf(glyph, goodKey) || marketStoreUnits(session, objId) <= 0) return;
      session.marketConsumed.set(goodKey, addStoreConsumption(session.marketConsumed.get(goodKey), session.townClock));
    } else if (pb) {
      // A producer pile depletes like a shelf — per-BOX consumed offset.
      if (!isKindOf(glyph, pb.key) || produceBoxUnits(session, objId) <= 0) return;
      session.produceConsumed.set(objId, addStoreConsumption(session.produceConsumed.get(objId), session.townClock));
    } else {
      const stock = session.containerStock.get(objId) ?? {};
      if (!stackTake(stock, glyph)) return;
      session.containerStock.set(objId, stock);
      // A table shows its contents — remove one matching visible prop as it's taken.
      if (session.containers.get(objId) === "on" && world) {
        for (const [pObjId, rec] of session.smallProps) {
          if (rec.glyph === glyph && world.state.objects[pObjId]?.containedIn?.objectId === objId) {
            world.removeObject(pObjId);
            session.smallProps.delete(pObjId);
            if (session.creatures) delete session.creatures.world.items[rec.entityId];
            break;
          }
        }
      }
    }
    stackAdd(session.pocket, glyph);
    pushPocket(session);
    presentContainer(session); // refresh remaining contents (closes when empty)
  }

  function closeContainer() {
    container = null;
    presenter.clearBoard();
    world?.setConversation(null);
    leaveDwell.reset();
  }

  // ── Ambient NPC↔NPC conversation ──────────────────────────────────────────
  // Idle townsfolk talk among themselves using the SAME dialogue engine the player
  // drives: the speaker picks a move off its own board (chooseSpeakerAct), by its
  // personality; the listener replies through selectAct. Purely expressive — the
  // only world writes allowed are monotone knowledge (gossip about where things are),
  // never a transfer, so ambient chatter can't disturb puzzle/quest state.

  /** A stable per-creature TEMPERAMENT hashed from its id — each townsperson chooses
   *  what to say consistently, with no personality data field (same dial board as any
   *  creature; here it only shapes small talk). */
  function creatureMood(cid: string): Personality {
    let h = 0;
    for (let i = 0; i < cid.length; i++) h = (h * 31 + cid.charCodeAt(i)) | 0;
    h = Math.abs(h);
    const dial = (shift: number) => 0.25 + (((h >> shift) & 7) / 7) * 0.6; // 0.25..0.85
    return makePersonality({
      warmth: dial(0),
      expressiveness: dial(3),
      openness: dial(6),
      assertiveness: dial(9),
    });
  }

  /** Show a bubble + voice a glyph line above a converse creature (live position).
   *  `preText` = an already-localized sentence (the directions prose) — shown and
   *  voiced as-is while the glyph strip still models the symbols. */
  function npcChatBubble(session: QuestSession, cid: string, glyph: string, preText?: string) {
    if (!world || !glyph) return;
    const node = session.creatures?.nodeByCreature.get(cid);
    if (!node) return;
    const sym = session.entities.get(node.npcEntityId)?.glyph;
    const at = poserPos(session, cid);
    if (at) {
      showWorldBubble(world.state, `char:${node.npcEntityId}`, {
        anchor: { kind: "point", x: at.x, y: at.y },
        text: preText ?? npcStatement(glyph, sym, cid),
        glyph,
        ttl: 5,
      });
    }
    if (preText) voice?.speak(preText, { lang: session.game.meta.locale, ...speakerVoiceOpts(cid) });
    else speakNpc(glyph, sym, cid);
  }

  /** The EXPLICIT terminal fallback (phase ①a §1): an utterance no responder
   *  caught is answered "I don't understand" — aloud by the addressed creature
   *  when there is one, else on the feedback surface. Never silence; never a
   *  misleading "okay". */
  /** Every law in force: the session ring (the world spec's absolutes +
   *  townless authored rows) plus the settlement's PERSISTED rows
   *  (deltas.laws — reload-proof, the TownDeltas transport). */
  function lawsInForce(session: QuestSession): readonly Law[] {
    const townRows = session.town?.deltas.laws ?? session.foundedSite?.deltas.laws;
    return townRows?.length ? [...session.laws, ...townRows] : session.laws;
  }

  /** Containment oracle for law areas, judged at a specific ACTOR's body
   *  (the player's when none named): structure = the building the body
   *  stands in; district = the zone charter covering it (later-wins, ③);
   *  disc = town-local metres (the zoning brush's frame). */
  function lawAreaTest(session: QuestSession, actorCid?: string | null): AreaTest {
    return (area) => {
      switch (area.kind) {
        case "everywhere": return true;
        case "town": return session.town !== null || session.foundedSite !== null;
        default: break;
      }
      if (!world) return false;
      const body = actorCid
        ? world.state.avatars[avatarIdOf(actorCid)] ?? world.state.avatars[actorCid]
        : world.state.avatars[PLAYER_ID];
      if (!body) return false;
      switch (area.kind) {
        case "structure":
          return buildingAt(world.state, body.x, body.y)?.id === area.id;
        case "district": {
          const ctx = buildContext(session);
          if (!ctx) return false;
          return charterZoneAt(ctx.deltas.zones(), body.x - ctx.center.x, body.y - ctx.center.y)?.ord === area.ord;
        }
        case "disc": {
          const ctx = buildContext(session);
          if (!ctx) return false;
          return Math.hypot(body.x - ctx.center.x - area.x, body.y - ctx.center.y - area.y) <= area.r;
        }
      }
    };
  }

  /** The AREA a spoken prohibition scopes to (§3c — selection over
   *  drawing): "town"/"home" → the settlement; "area"/here-gaze → the
   *  DISTRICT charter under the player's focus when one covers it, else a
   *  focus-sized disc (authored where you stand); nothing named → the
   *  settlement (or everywhere, townless). */
  function forbidArea(s: QuestSession, frame: IntentFrame): AreaRef {
    const inTown = s.town !== null || s.foundedSite !== null;
    const settlement: AreaRef = inTown ? { kind: "town" } : { kind: "everywhere" };
    const entSym = (r?: Ref): string | null => (r?.kind === "entity" ? r.symbol : null);
    const isGazePoint = (r?: Ref): boolean => r?.kind === "gaze" && r.of === "point";
    const bound = frame.bound?.find((b) => ["in", "on", "near", "at"].includes(b.relation));
    const ref = bound?.ref ?? frame.target ?? frame.object;
    const word = entSym(ref);
    if (word === "town" || word === "home" || word === "village") return settlement;
    if (word === "area" || isGazePoint(ref)) {
      const ctx = buildContext(s);
      const focus = playerFocusArea(s);
      if (ctx && focus) {
        const z = charterZoneAt(ctx.deltas.zones(), focus.x - ctx.center.x, focus.y - ctx.center.y);
        if (z) return { kind: "district", ord: z.ord };
        return { kind: "disc", x: focus.x - ctx.center.x, y: focus.y - ctx.center.y, r: focus.radius };
      }
    }
    return settlement;
  }

  function speakNotUnderstood(session: QuestSession, target: string | null, sentence: string) {
    if (target && session.creatures?.nodeByCreature.has(target)) {
      npcChatBubble(session, target, NOT_UNDERSTOOD_LINE);
      return;
    }
    presenter.toast(`💬 "${sentence}" — ${npcStatement(NOT_UNDERSTOOD_LINE)}`, "feedback");
  }

  /** THE ANSWER CHANNEL (outstanding-bugs-family-mode: "no direct question
   *  should produce UI messages alone"). A host verdict on something the
   *  player SAID is addressed to the player, so a creature says it out loud —
   *  the DOM banner is for the reader in the room, not the child at the board.
   *
   *  Speaker preference mirrors the command target exactly (the selected
   *  family chip → whom you're looking at → whoever you're talking to → the
   *  body you ride → nearest), so the voice that answers is the one that was
   *  asked. `willing` is the honest gate the user asked for: only a creature
   *  the dialogue world has actually REGISTERED can speak, and when none can,
   *  the toast still fires — a reason on screen beats no reason at all.
   *
   *  Returns whether it was spoken, so callers can keep a richer banner for a
   *  sighted adult AND still have the creature answer. */
  function saySystem(
    session: QuestSession,
    line: LeveledGlyphs | string,
    fallbackText: string,
    speaker?: string | null,
  ): boolean {
    // The session's SYNTAX level picks the register (one-word → full sentence),
    // exactly as every other creature line in the host resolves it.
    const glyphLine = typeof line === "string" ? line : line[session.game.meta.syntax ?? "b"];
    const cid =
      speaker ??
      session.addressedFamily ??
      gazeCreature(session) ??
      possession.creatureId ??
      nearestCreature(session);
    if (cid && session.creatures?.nodeByCreature.has(cid) && glyphLine) {
      npcChatBubble(session, cid, glyphLine);
      return true;
    }
    // NOBODY TO SPEAK IT — an empty world, or a creature the dialogue layer
    // hasn't registered yet. Fall back to the banner rather than swallowing
    // the verdict (silence must be explicit).
    presenter.toast(fallbackText, "feedback");
    return false;
  }

  /** Ambient acts that only SPEAK or spread monotone knowledge — safe to execute
   *  between NPCs. A transfer move (request/offer/trade) is spoken as flavour but not
   *  run, so no puzzle/quest item ever moves on its own. */
  const CHAT_SAFE_ACTS = new Set<DialogueAct["kind"]>([
    "how-are-you",
    "where-is",
    "where-going",
    "ask-directions", // the answer is knowledge + a pointed arm — no world effect
    "directions-pick",
    "tell",
    "why",
    "bye",
    "confused",
  ]);

  /** One ambient exchange: `speaker` says a personality-chosen move to `listener`,
   *  who replies a beat later. */
  function runNpcExchange(session: QuestSession, speaker: string, listener: string) {
    if (!world || !session.creatures) return;
    const cworld = session.creatures.world;
    const level = sess?.game.meta.syntax ?? "b";
    const lNode = session.creatures.nodeByCreature.get(listener);
    const opts = {
      ...creatureProjectionOpts(session, lNode?.announce),
      // An NPC asks from the town's COMMON knowledge of places — not from the
      // list the PLAYER happens to have heard of (which starts empty and kept
      // ambient direction-asking from ever happening).
      askDirections: [...session.placeFacts.values()]
        .slice(0, 8)
        .map((f) => ({ id: f.id, glyph: f.thingGlyph })),
    };
    const act = chooseSpeakerAct(cworld, speaker, listener, level, opts, {
      personality: creatureMood(speaker),
    });
    if (!act) return;
    session.chatCooldown.set(speaker, CHAT_COOLDOWN);
    session.chatCooldown.set(listener, CHAT_COOLDOWN);
    npcChatBubble(session, speaker, act.glyph);

    // The reply: run the safe acts for real (a `tell` gossips a location into the
    // listener's knowledge); a wanting/offering line is not EXECUTED between NPCs
    // (no puzzle item may move on its own), so the listener politely DECLINES —
    // "okay" is reserved for accepted orders (phase ①a §1), never a generic ack.
    const res = CHAT_SAFE_ACTS.has(act.kind)
      ? selectAct(cworld, listener, speaker, act, level, opts, {})
      : null;
    let reply = res ? res.responseGlyph : "no";
    let replyText: string | undefined;
    let pointAt: { x: number; y: number } | null = null;
    // A DIRECTIONS answer comes back as a subject, not a glyph (the pure layer
    // can't measure the town) — resolve it HERE like the player path does:
    // the SAME spoken prose the player would hear ("The blue house is far, to
    // the north."), never a broken glyph-pair gloss, + the pointing arm.
    if (res?.askedDirections && session.town) {
      const fact = session.placeFacts.get(res.askedDirections);
      const av = chatAvatar(world.state, listener);
      if (fact && av) {
        // The ANSWERER's own town: a neighbor listener measures/aims by its
        // streets, with `buy:good:*` re-aimed at its own market.
        const rc = neighborCtxOf(session, listener);
        const f = rc ? neighborPlaceFact(rc, fact) : fact;
        const ans = answerPlaceDirections(
          rc ? rc.plan.streets : session.town.plan.streets,
          rc ? rc.center : session.town.stage.center,
          { x: av.x, y: av.y },
          f,
        );
        // The rare import's directions carry the judgment: "cookie, north — rare."
        const rareTail = fact.id.startsWith("buy:import:") ? " + rare" : "";
        reply = `${fact.thingGlyph}${rareTail}`; // the strip models the THING
        const lSym = session.entities.get(lNode?.npcEntityId ?? "")?.glyph;
        replyText = speakDirections(fact.thingGlyph, ans.proximity, ans.cardinal, session.game.meta.locale, {
          speaker: npcSpeakerGender(lSym, listener),
        });
        pointAt = f.worldPos;
      }
    }
    if (!reply) return;
    const target = pointAt;
    const text = replyText;
    setTimeout(() => {
      if (!world || sess !== session) return;
      if (choice) return; // the player started a conversation — don't talk over it
      npcChatBubble(session, listener, reply!, text);
      if (target) pointNpcArm(listener, target);
    }, CHAT_REPLY_MS);
  }

  /** A converse creature's live avatar, under either id convention: a quest poser is
   *  `npc_<cid>`, a streamed town resident's body id IS the bare `cid` (`resident_*`). */
  function chatAvatar(state: WorldState, cid: string) {
    return state.avatars[`npc_${cid}`] ?? state.avatars[cid];
  }

  /** Idle townsfolk talk among themselves. Each frame: decay cooldowns; on the
   *  interval, register nearby streamed residents (so they can chat before the player
   *  has ever spoken to them), then pick a visible, off-cooldown converse creature and
   *  its nearest eligible neighbour and run one exchange. Silent while the PLAYER is in
   *  a conversation — never talk over the student's own turn. */
  function stepNpcChatter(session: QuestSession, state: WorldState, dt: number) {
    if (!world) return;
    for (const [k, v] of session.chatCooldown) {
      if (v <= dt) session.chatCooldown.delete(k);
      else session.chatCooldown.set(k, v - dt);
    }
    if (choice) return; // player mid-conversation — hold ambient chatter
    session.chatClock += dt;
    if (session.chatClock < CHAT_INTERVAL) return;
    session.chatClock = 0;

    const me = state.avatars[PLAYER_ID];
    // Bring nearby streamed residents into the dialogue world so they're chattable —
    // the same lazy registration a first approach does, done proactively for the crowd.
    if (me) {
      for (const id of Object.keys(state.avatars)) {
        if (!id.startsWith("resident_")) continue;
        const av = state.avatars[id]!;
        if (Math.hypot(av.x - me.x, av.y - me.y) <= CHAT_VISIBLE_RADIUS) {
          ensureResidentCreature(session, id);
        }
      }
    }
    if (!session.creatures) return;

    const eligible = (cid: string): boolean => {
      if (session.party.has(cid)) return false;
      if (convo?.nodeId === cid) return false;
      if ((session.chatCooldown.get(cid) ?? 0) > 0) return false;
      if (!chatAvatar(state, cid)) return false;
      // A quest poser mid-errand keeps to its task; residents mill freely (the town
      // stage drives their bodies — a bubble doesn't interrupt them). Body ids go
      // through avatarIdOf (a resident's body is its bare cid).
      if ((session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0) return false;
      if (npcCarrying(avatarIdOf(cid))) return false;
      return true;
    };
    const cids = [...session.creatures.nodeByCreature.keys()].filter(eligible);
    if (cids.length < 2) return;

    // Speakers on-screen (near the player), tried in random order so a speaker with
    // no neighbour this tick doesn't waste the whole interval.
    const near = me
      ? cids.filter((cid) => {
          const av = chatAvatar(state, cid)!;
          return Math.hypot(av.x - me.x, av.y - me.y) <= CHAT_VISIBLE_RADIUS;
        })
      : cids.slice();
    for (let i = near.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [near[i], near[j]] = [near[j]!, near[i]!];
    }
    for (const speaker of near) {
      const sav = chatAvatar(state, speaker)!;
      // MARKET REMARK (the more/less comparatives, spoken): a speaker near the
      // food stall sometimes comments on the shelf — "more food" when it's
      // piled high, "less food" when it runs thin (attendance/scarcity made
      // audible). A remark is this tick's whole utterance.
      const store = state.objects["store:food"];
      if (store && Math.hypot(store.x - sav.x, store.y - sav.y) <= 10 && Math.random() < 0.25) {
        const units = marketStoreUnits(session, "store:food");
        // NATIONS P6: when the shelf is thin AND this town's food routes are
        // paused, the remark carries its CAUSE — "less food because they
        // don't give food". That two-clause line is the whole macro event
        // made legible from the street: a child hears the embargo without
        // anyone naming an embargo. Routes flowing (or none at all) keeps
        // the plain scarcity comparative, byte-identical to before.
        const remark =
          units <= 2
            ? inboundRouteHealth(session.transfers.active(), "food") < 1
              ? embargoRemarkLine("food")[session.game.meta.syntax ?? "b"]
              : "less + food"
            : units >= STORE_DISPLAY_CAP
              ? "more + food"
              : null;
        if (remark) {
          session.chatCooldown.set(speaker, CHAT_COOLDOWN);
          npcChatBubble(session, speaker, remark);
          return;
        }
      }
      let listener: string | null = null;
      let best = CHAT_PAIR_RADIUS;
      for (const cid of cids) {
        if (cid === speaker) continue;
        const av = chatAvatar(state, cid)!;
        const d = Math.hypot(av.x - sav.x, av.y - sav.y);
        if (d <= best) { best = d; listener = cid; }
      }
      if (listener) {
        runNpcExchange(session, speaker, listener);
        return;
      }
    }
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
              text: npcStatement(command.prompt, poserSym, command.nodeId), // translated caption
              glyph: command.prompt, // render the composed glyph image too
              ttl: 6,
            });
          }
          speakNpc(command.prompt, poserSym, command.nodeId);
          // The presenter answers on whatever surface it owns — the AAC's REAL
          // response board (teaches its use), or an in-app panel. The entity's
          // COMPOSED glyph rides along so board buttons render the real symbol
          // the student is learning (emoji fallback included).
          presenter.board({
            kind: "choice",
            nodeId: command.nodeId,
            posedByEntityId: command.posedByEntityId,
            prompt: command.prompt,
            promptText: npcStatement(command.prompt, poserSym, command.nodeId),
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
    // Cast wanters are the PRIMARY's by construction (neighbor casts don't
    // stream); a gifted NEIGHBOR resident's aggregate share lands through
    // its OWN pantry instead (deposit → reanchorHouseGoods, cluster-resolved).
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
    // DEBUG PATHS: a second overlay riding the same scene. The view takes ONE
    // overlay, so the two are composed below rather than competing for the slot.
    // `world` is captured lazily — it doesn't exist until runWorldHost, further down.
    pathDebug = new PathDebugOverlay3D({ getPaths: () => world?.npcPaths() ?? [] });
    pathDebug.setEnabled(pathDebugOn);
    // ZONE CHARTERS on the ground (③): the chartered discs tint the ground
    // (category-colored, later charters visibly win, clearing erases) — a
    // spoken "area farms here" changes the world the same frame.
    const zoneOverlay = new ZoneOverlay3D({
      getView: () => {
        const t = session.town;
        if (t) return { zones: t.deltas.zones(), center: t.stage.center, version: t.deltas.version };
        const site = session.foundedSite;
        if (site) return { zones: site.deltas.zones(), center: site.at, version: site.deltas.version };
        return null;
      },
      ...(deps.groundAt ? { groundAt: deps.groundAt } : {}),
    });
    const goalTreeOverlay = overlay;
    const overlays: SceneOverlay[] = [goalTreeOverlay, pathDebug, zoneOverlay];
    const composedOverlay: SceneOverlay = {
      mount: (scene) => { for (const o of overlays) o.mount(scene); },
      update: (dt) => { for (const o of overlays) o.update(dt); },
      dispose: () => { for (const o of overlays) o.dispose(); },
    };
    // Render composed glyphs in in-world speech bubbles EXACTLY as the response
    // board renders them — same GlyphCompositor + the injected icon resolver.
    const glyphSource = createGlyphImageSource(
      deps.resolveImage ? { resolveImage: deps.resolveImage } : {},
    );
    const view = (questView = createWorld3DView(
      {
        canvas,
        localId: PLAYER_ID,
        faceFor: () => null,
        labelFor: (id) => (id === PLAYER_ID ? "You" : ""),
        glyphFor: glyphSource.glyphFor,
        // A model-less object IS its glyph — bare artwork, no tone plate.
        glyphIconFor: glyphSource.glyphIconFor,
      },
      session.embedding.spec,
      {
        overlay: composedOverlay,
        // SEAMLESS WALK↔FLY: render into the space-flight scene under the city
        // anchor instead of owning the canvas (shared camera + scene).
        ...(deps.host ? { host: deps.host } : {}),
        // SPIRIT: a fixed angled-overhead camera framing the whole scene —
        // or, in the dollhouse, exactly the focused HOUSE (structure-style
        // low 3/4 vantage + gaze-edge orbit around the home).
        spirit,
        ...(spiritFrame ? { spiritFrame } : {}),
        // A living town renders its people as creature-builder humans (residents
        // + player), keeping puzzle-givers as emoji capsules. A freestanding
        // quest world (no town) keeps the emoji-capsule cast.
        // SPIRIT: the local player is THE SPARK — bodiless, whether or not it
        // rides a creature (see sparkAvatarModel). Everyone else, the claimed
        // creature included, renders as itself. A WALKER scope (walk↔fly) is
        // not a spark at all: the pilot who lands has a real body and wears the
        // town's like anyone else, so the wrapper stands aside entirely.
        modelFactory: ((base: AvatarModelFactory): AvatarModelFactory =>
          spirit
            ? (id, isLocal) => (isLocal ? sparkAvatarModel() : base(id, isLocal))
            : base)(
          session.town
            ? makeTownModelFactory(
                session.npcIcons,
                session.town.plan.species ?? "human_cute", // the town's constructing species
                familyOverrides(session),
                session.dress, // the town's culture palette
              )
            : makePuzzleCharacterFactory(session.npcIcons),
        ),
        // A living town paints its streets on the ground (render-only ribbons).
        ...(session.town ? { roads: session.town.stage.roads } : {}),
      },
    ));
    const host = runWorldHost({
      view,
      spec: session.embedding.spec,
      localId: PLAYER_ID,
      spawnIndex: 0,
      hostNpcs: true,
      // IRREGULAR GROUND: place the whole session on the host's terrain.
      ...(deps.groundAt ? { groundAt: deps.groundAt } : {}),
      // WATER: the engine's terrain gate makes it impassable.
      ...(deps.waterAt ? { waterAt: deps.waterAt } : {}),
      // SPIRIT: the avatar never moves; carry goes distance-free (pick/place by gaze).
      ...(spirit ? { stationary: true } : {}),
      // A living town streams pure steering BODIES (the 2D lab's shared
      // street budget) — the engine's small default cap is for voiced NPCs.
      // Fauna (sheep/orchards) + dawn-cart haulers ride ON TOP of the resident
      // crowd budget — the streaming model still spends only STREET_NPCS.
      // Open country carries its scatter's minded locals PLUS the biome's
      // herds a boot streams in over them (addNpc) — over the voiced default.
      ...(session.town
        ? { maxNpcs: STREET_NPCS + 24 }
        : session.wilderness
          ? { maxNpcs: 24 }
          : {}),
      // Feed the conversation start/cancel dwell into the gaze-spark bloom (it is
      // the selection indicator now — the old dwell ring is gone).
      cursorProgress: () => convoProgress,
      // With buildings, the ENGINE's structure constraint owns collision (house
      // walls + locked doors seal rooms; the manifold clamp bounds the field) —
      // the whole village ground is walkable. Without them, fall back to the
      // layout's invisible walls.
      // A living town streams its REAL walls (stage → setStructures);
      // its ground is open — never wrap it in the invisible quest walls.
      // The WILDERNESS is open country by definition — no walls at all.
      ...(session.village || session.town || session.wilderness
        ? {}
        : { constraint: makeWallConstraint(session.embedding.layout, session.sState) }),
      // Carry the "move A→B" puzzle objects + converse items: dwell to pick up;
      // dwell on a spot to put them down. Vendor STOCK is owned — a completed
      // pick-dwell on it is DENIED (❌ + the owner's "mine!" bubble) until the
      // dialogue grants it.
      carry: {
        // A DOLLHOUSE SPIRIT is a formless observer: the world offers it no
        // grab affordance at all (pre-gate — no dwell ring, no tease). The one
        // exception is a GIFT already pending transfer to the player — but
        // that lands through the gaze AUTO-TAKE, not a pick-dwell, so nothing
        // is pickable here. Puzzle-world spirits (structure scope) keep the
        // gaze-carry — moving pieces IS their game.
        pickable: () => !(spirit && session.dollhouse !== null),
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
              text: glyph ? npcStatement(glyph, ownerSym, ownerNode) : (entity?.label ?? "mine"),
              ...(glyph ? { glyph } : {}),
              ttl: 2.5,
            });
            if (glyph) speakNpc(glyph, ownerSym, ownerNode);
            else speakRaw(entity?.label ?? "");
          }
        },
      },
      onFrame: (state, dt) => {
        // Host-side per-frame passthrough (HUD gaze refresh etc).
        deps.onFrame?.(dt);
        // FOUNDING: clear a still-empty site once the player leaves it.
        stepFoundedSite(session);
        // BUILD ORDERS (①b): finished construction completes off the clock,
        // and the contextual buildable-structure board stays current.
        stepFoundedConstruction(session, dt);
        pushCivicBuildBoard(session);
        // LIVING TOWN: stream the stage around the player — walls of the
        // nearby houses, residents embodying mid-errand, fresh shopping
        // trips on the street clock. The stage is cheap when nothing moves.
        if (session.town) {
          const prevDay = Math.floor(session.townClock / FOOD_DAY_SEC);
          session.townClock += dt;
          const newDay = Math.floor(session.townClock / FOOD_DAY_SEC);
          // AUTOMATIC EXPANSION (construction v1): once per town day, the
          // prosperity accrual + at-most-one-annex spend. Signals are the
          // proxy trio (pantry surplus, attendance, stocked breadth) — the
          // adapter a real economy later replaces. The stage's delta
          // watcher raises any new annex (scaffold-first when watched).
          if (newDay > prevDay) {
            const t = session.town;
            constructionStep(
              t.stage.center,
              t.plan,
              t.deltas,
              (houseIndex) => prosperitySignals(session, houseIndex),
              newDay,
            );
            // ZONE-STEERED FOUNDING (③, the ①b deferred piece): the town
            // banks its own prosperity (the mean of the same household
            // signals) and spends it FOUNDING the most-needed structure
            // inside a zone with ground for it — same FoundedBuilding path
            // as a spoken order (scaffold → completion sweep → roster),
            // spending the same yard stock. No zones ⇒ nothing changes.
            stepZonedFounding(session, newDay);
            // MOVE-IN (④): a finished empty house admits a household when
            // the town can feed one — build houses, people come.
            stepTownMoveIn(session);
            // COHORT RATES (④): each district pool integrates its
            // production/consumption up to today (idle-safe closed form).
            stepCohortDay(session, newDay);
          }
          const meTown = state.avatars[PLAYER_ID];
          const townHost = world;
          if (meTown && townHost) {
            // ROOF STATE is the gate for showing an interior — both its people AND
            // its furniture. A room is "on show" while its roof is NOT fully opaque:
            // transparent, or still easing back after you left. So its residents +
            // furniture appear as the roof opens and abstract only once it fully
            // SEALS — nothing pops out from under a half-faded roof, and an open
            // door you're OUTSIDE of (opaque roof) reveals nothing, so ambient
            // residents can't be conjured or talked to through a wall. Occupancy is
            // OR'd in so a room populates the instant you step in, before its roof
            // has begun to fade. Bodies mid-task (out on the lanes, or transiting a
            // door) stay embodied regardless; the resident model exempts them.
            const occupiedId = buildingAt(state, meTown.x, meTown.y)?.id ?? null;
            const revealed = townHost.revealedBuildings();
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
              // A SPIRIT sees the whole town from its orbit (the ladder
              // camera) — the street-level 120 m circle let bodies pop
              // in/out in plain sight from above (the reported blink on
              // the plaza). The guard must cover what the camera covers.
              spiritNow() ? Math.max(240, session.town.plan.radius * 2 + 80) : 120,
              (houseIndex) => {
                if (houseIndex === session.dollhouse) return true; // the dollhouse never abstracts
                // ANY room of the house counts (rooms are separate buildings
                // since round 4) — standing in the bedroom or peeling any
                // one roof shows the household.
                if (occupiedId !== null && houseIndexOfBuildingId(occupiedId) === houseIndex) return true;
                for (const id of revealed) if (houseIndexOfBuildingId(id) === houseIndex) return true;
                return false;
              },
              // ROOM granularity for the view guard: only the room the player
              // occupies / whose roof is open counts SEEN — a visible house's
              // closed back rooms stay legitimate spawn cover. The dollhouse's
              // focused house is the exception: its cutaway shows EVERY room
              // (accessibleBuildings floods the whole suite), so nothing may
              // materialize anywhere inside it.
              (buildingId) => {
                if (
                  session.dollhouse !== null &&
                  houseIndexOfBuildingId(buildingId) === session.dollhouse
                ) return true;
                return buildingId === occupiedId || revealed.has(buildingId);
              },
              // COHORT TIER (④): pooled households stream no bodies.
              (houseIndex) => session.pooledHouses.has(houseIndex),
            );
            if (f.buildings) townHost.setBuildings(f.buildings);
            // REMOVE before ADD: a construction-delta refurnish replaces a
            // house's set in one frame, and a surviving id must clear its
            // old body before the new spec lands (add rejects duplicates).
            for (const id of f.removeObjects) townHost.removeObject(id);
            for (const o of f.addObjects) townHost.addObject(o);
            for (const raw of f.add) {
              // A POSSESSED resident's body IS the player walker — the
              // streamer must never re-embody it (a clone).
              if (possession.creatureId && avatarIdOf(possession.creatureId) === raw.id) continue;
              // Girth-check the SPAWN before it embodies: a broad-bodied resident
              // placed at its room spot / the table must not land inside furniture.
              const n = girthSafeSpawn(townHost, raw);
              session.npcIcons.set(n.id, "🙂");
              townHost.addNpc(n);
              // A fresh resident body paces only inside its house's IDLE PAD
              // (may be null this frame if the furniture stages later — the
              // next homecoming refreshes it).
              if (n.id.startsWith("resident_")) {
                townHost.setNpcWanderRect(n.id, houseIdlePad(session, townHost.state, Number(n.id.split("_")[1])));
              }
            }
            for (const id of f.remove) townHost.removeNpc(id);
            for (const e of f.errands) {
              // A LIVE-driven body ignores the clock's feed until demote (§13 — the
              // need loop owns it; no double-drive); a RECRUITED one follows the
              // player; a COMMANDED one (queued goal errands) finishes its order.
              if (
                session.liveNeedBodies.has(e.npcId) ||
                session.party.has(e.npcId) ||
                (session.npcTasks.get(e.npcId)?.length ?? 0) > 0
              ) continue;
              // DOOR-ROUTE resident trips like the cast's (enqueueNpcErrand): any leg
              // that crosses a building boundary is threaded through the real doorway
              // instead of grinding on the wall beside it. Routed from the body's LIVE
              // spot (a mid-trip spawn walks the remainder). Between two open-ground
              // points routeThroughDoors is a no-op — the per-leg timeout still copes
              // with an intervening building; this only fixes the walled-room legs.
              const at = state.avatars[e.npcId];
              const errand = at
                ? doorRouteErrand(state, { x: at.x, y: at.y }, { points: e.points }, townHost.npcRadiusOf(e.npcId))
                : { points: e.points };
              session.lastDrive.set(e.npcId, "clock");
              townHost.setNpcErrand(e.npcId, errand);
            }
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
              // The player did it and watched it happen — sight writes the
              // device's new state as a fact ("the lamp is on").
              for (const s of dev.states) {
                const axis = STATE_AXES[s];
                if (axis) {
                  perceiveFact(cworld, PLAYER_CREATURE_ID, { kind: "itemState", item: item.entityId, axis, state: s });
                }
              }
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
              speakNpc("thank_you", creatureGlyph(session, ev.creatureId), ev.creatureId);
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
        // SMALL loose props ride the SAME carry→absorb path (per the pickup owner: "put it
        // in the same place large pickup is"). On landing in hand the prop MERGES into the
        // pocket STACK by its glyph signature and its instance is dropped (the pocket is
        // counts, not instances). A pending gift is settled first so debts still clear.
        if (session.creatures) {
          for (const [objId, rec] of [...session.smallProps]) {
            if (state.objects[objId]?.carriedBy !== PLAYER_ID) continue;
            if (session.creatures.world.items[rec.entityId]?.pendingTransferTo === PLAYER_CREATURE_ID) {
              concludeTransfer(session.creatures.world, PLAYER_CREATURE_ID, rec.entityId);
            }
            pocketLoose(session, objId);
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
                speakNpc("thank_you", creatureGlyph(session, ev.creatureId), ev.creatureId);
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
                speakNpc(wantGlyph, creatureGlyph(session, d.nodeId), d.nodeId);
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
                speakNpc("thank_you", creatureGlyph(session, ev.creatureId), ev.creatureId);
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
              text: npcStatement(STAY_DONE_LINE, npcSym, cid),
              glyph: STAY_DONE_LINE,
              ttl: 4,
            });
            speakNpc(STAY_DONE_LINE, npcSym, cid);
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
                  text: npcStatement("thank_you", npcSym, cid),
                  glyph: "thank_you",
                  ttl: 4,
                });
                speakNpc("thank_you", npcSym, cid);
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
          // above then concludes the transfer like any other take. Covers
          // staged CONVERSE items AND loose SMALL PROPS (a family member's
          // "give apple to i_me" drops a prop). A formless SPIRIT has no
          // reach — its gaze IS the reach, so the distance gate lifts; this
          // is the ONE way a dollhouse spirit ever takes a physical item.
          const gzTake = world?.getGaze();
          const playerHolds = Object.values(state.objects).some((o) => o.carriedBy === PLAYER_ID);
          if (playerAv && gzTake && !playerHolds) {
            const pendings: Array<{ objId: string; entityId: string }> = [];
            for (const [objId, item] of session.convItems) pendings.push({ objId, entityId: item.entityId });
            for (const [objId, rec] of session.smallProps) pendings.push({ objId, entityId: rec.entityId });
            for (const { objId, entityId } of pendings) {
              const st = session.creatures.world.items[entityId];
              if (st?.pendingTransferTo !== PLAYER_CREATURE_ID) continue;
              const obj = state.objects[objId];
              if (!obj || obj.carriedBy) continue;
              if (!spiritNow() && Math.hypot(obj.x - playerAv.x, obj.y - playerAv.y) > 2.6) continue;
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
        // ── SOCIETY RULES (society-rules.md): advance the day/night clock and let
        // each creature pick its goal; on a goal CHANGE, issue an errand. Riverside's
        // default is the "when night, go home" curfew, authored end-to-end through the
        // concept parser → intent-compile → rules. Same id convention + staging homes +
        // errand choke point as the hand-over loop above; no world-host changes.
        // PARTY FOLLOW: enlisted creatures trail the player whenever idle (a command
        // errand takes precedence — one task at a time). Their need-schedule is
        // suspended (they're excluded from the goal loop below), so a command wins.
        if (session.party.size > 0) {
          const player = state.avatars[PLAYER_ID];
          if (player) {
            for (const cid of session.party) {
              const npcId = avatarIdOf(cid);
              const npc = state.avatars[npcId];
              if (!npc) continue;
              const gap = Math.hypot(npc.x - player.x, npc.y - player.y);
              if (gap > FOLLOW_GAP && (session.npcTasks.get(npcId)?.length ?? 0) === 0) {
                session.lastDrive.set(npcId, "follow");
                enqueueNpcErrand(session, npcId, { points: [{ x: player.x + 1.4, y: player.y + 1.0 }] });
              }
            }
          }
        }
        if (session.goals && session.creatures && world) {
          stepCreatureGoals(session.goals, dt, {
            world: session.creatures.world,
            // Party members obey commands, not the curfew — exclude them. Ambient
            // residents are excluded too: their BODIES are driven by the town goods
            // clock (§5), so their shopping need must NOT also issue a goal here (the
            // "don't double-drive" invariant). Converging the two is slice 3.
            //
            // PETS ARE EXCLUDED FOR THE SAME REASON (playtest: "the dog takes the
            // apple and never eats it or puts it down"). A pet runs the NEEDS
            // WALKER — one behavior model, round 2's law — but it was falling
            // through this filter (only `resident_` was named) and so ran the goal
            // chooser as WELL. That chooser compiled its hunger into a `fetch` =
            // moveTo + `pick`, a TERMINAL plan with no eat and no drop: the apple
            // went into the physical `carriedBy` model, which the needs walker
            // cannot see, so hunger stayed blocked forever while the dog stood
            // there holding its dinner. Its hunger belongs to the walker (which
            // blocks honestly on the grasp gate and surfaces for ADOPTION — a
            // housemate fills the bowl and the pet eats from it).
            creatureIds: [...session.creatures.nodeByCreature.keys()].filter(
              (cid) => !session.party.has(cid) && !cid.startsWith("resident_") && !isPetCid(cid),
            ),
            resolver: makeGoalResolver(session),
            // avatarIdOf, not `npc_${cid}` — a resident/pet body IS the bare cid,
            // so the old key never matched one and `isBusy` read FALSE for them
            // no matter what they were doing or already carrying.
            isBusy: (cid) =>
              (session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0 || !!npcCarrying(avatarIdOf(cid)),
            issue: (cid, plan) => issueGoalPlan(session, cid, plan),
            // ABSOLUTE taboos prune candidates for every creature — no
            // author outranks the culture (nations P2, laws.ts). Judged at
            // each creature's own body, so a district taboo binds exactly
            // the ones standing in the district.
            veto: (goal, cid) => {
              const v = goalVerb(goal);
              return v !== null && absolutelyForbidden(lawsInForce(session), v, lawAreaTest(session, cid));
            },
          });
        }
        // LIVE NEEDS (doc §13): residents of an ON-SHOW house run their need templates
        // (eat from the pantry, restock it when it runs low), gated on the roof-reveal
        // state — the same "interior on show" signal the crowd streaming uses. The
        // LOAD/UNLOAD edges do the chest↔schedule handoff first, so a freshly-revealed
        // pantry reads the schedule's truth before anyone eats from it.
        if (session.town && world) {
          const meE = state.avatars[PLAYER_ID];
          const occupiedE = meE ? (buildingAt(state, meE.x, meE.y)?.id ?? null) : null;
          const revealedE = world.revealedBuildings();
          const shownE = (hi: number) => {
            if (hi === session.dollhouse) return true; // the dollhouse never abstracts
            // ANY room of the house counts (rooms-as-buildings, round 4).
            if (occupiedE !== null && houseIndexOfBuildingId(occupiedE) === hi) return true;
            for (const id of revealedE) if (houseIndexOfBuildingId(id) === hi) return true;
            return false;
          };
          // Reconcile each resident's shopping need with the goods clock (want is
          // true only while out for the good) — an ON-SHOW house's clock is
          // suppressed fiction, so its members' dialogue never reads it. Runs
          // before chatter so idle townsfolk talk with fresh state.
          stepResidentEconomyNeeds(session, shownE);
          stepHouseholdEdges(session, shownE);
          stepConstructionHousekeeping(session, shownE); // craft / auto-place / clutter (construction v1)
          // SOFT CONTROL (attention-spark.md): refresh the spark's attention
          // field (engagement + object draw) from the gaze BEFORE needs decide,
          // so an engaged creature's draw bonus is live this tick. Fades while a
          // conversation / container / menu is open. Then, when not blocked, run
          // the directed gestures: the engaged creature does a hovered chore; the
          // oscillation gesture sends it to use/go; a gap between two people chats.
          {
            // Conversing with a creature ENGAGES it strongly — held ~8s past the
            // conversation, so "leave the chat, then select an object" still lands.
            if (convo) engageCreature(session, convo.nodeId, ENGAGE_CONVO_HOLD_S);
            const sparkBlocked = !!convo || !!container || !!choice || !!session.selectedPocketGlyph;
            stepSparkAttention(session, world, dt, sparkBlocked);
            if (!sparkBlocked) {
              stepSparkDirect(session, state);
              stepSparkOsc(session, world, dt);
              stepSparkPairChat(session, state, world, dt);
            }
          }
          stepActionHolds(session, dt); // advance discrete-action crouches; land effects at mid-beat
          stepPursuit(session, state, dt); // per-tick goal pursuits (owns its bodies before needs sweep)
          stepContainerLids(session, state); // auto-close access-opened lids once the taker has left
          stepNeeds(session, state, dt, shownE);
          syncNeedActivities(session, state, dt); // body-activity visuals track the steps
          syncNeedCarryProps(session, state); // carried stacks show as held props + reach rigs
          stepWorkAttendance(session, dt); // jobs→economy: absence during shifts
          pushFamilyHud(session); // dollhouse chips track the states just stepped
          stepCohortTier(session, dt, shownE); // ④ tracked↔cohort turnover + city chips (hysteretic sweep)
          stepCohortWalkers(session); // ④ sampled district street life (cosmetic-only)
          pushKnownNouns(session); // the Speak menu tracks the house (diff-gated)
          // DOLLHOUSE HEARTBEAT: a 5-second household state line per member, so
          // a playtest can SEE why someone isn't home — embodied? which clock
          // phase owns them? live step? meters. Diagnostic; remove once the
          // household loop has earned trust.
          if (session.dollhouse !== null) {
            dollLogT += dt;
            if (dollLogT >= 5) {
              dollLogT = 0;
              const h = session.dollhouse;
              const rcD = residentTownCtx(session, h);
              const famD = familyOf(session);
              for (let m = 0; m < HOUSEHOLD; m++) {
                const cid = `resident_${h}_${m}`;
                // Log EVERY member that exists — an absent body is exactly the
                // case the heartbeat is for (mode-"all" overflow never exists).
                if (famD && famD.mode === "all" && m >= famD.members.length) continue;
                const body = state.avatars[cid];
                const good = rcD?.house ? residentShopGoods(session, h, m) : undefined;
                const phase = good && rcD?.house ? good.errand(rcD.house, session.townClock).phase : "—";
                const duty = residentJobDuty(session, h, m);
                const onShift = !!duty && inShiftWindow(duty.window, session.townClock, FOOD_DAY_SEC);
                const meter = (k: string) => (session.needMeters.get(`${cid}|${k}`) ?? 0).toFixed(2);
                const step = session.needStep.get(cid);
                // A missing body gets the CANDIDACY VERDICT from the resident
                // model itself — which gate ate it (and the GHOST desync the
                // model can't see alone gets self-healed on the spot).
                let why = "";
                if (!body && meE) {
                  const verdict = session.town.stage.explainResident?.(
                    { x: meE.x, y: meE.y },
                    session.townClock,
                    h,
                    m,
                    (id2) => {
                      const a = state.avatars[id2];
                      return a ? { x: a.x, y: a.y } : null;
                    },
                    shownE,
                  );
                  if (verdict) {
                    why = ` why=[${verdict}]`;
                    if (verdict.startsWith("GHOST")) {
                      session.town.stage.dropResidentBody?.(cid);
                      why += " → dropped (respawns next frame)";
                    }
                  }
                }
                console.log(
                  // `clock~` = the SUPPRESSED schedule's fictional phase (on-show
                  // houses are live-loop-driven; this column is reference only).
                  `[doll] ${cid} ${body ? `@${body.x.toFixed(1)},${body.y.toFixed(1)}` : "NOT-EMBODIED"}` +
                    ` clock~=${phase} shift=${onShift}${duty ? ` win=${duty.window.start.toFixed(2)}+${duty.window.len.toFixed(2)}` : ""}` +
                    ` live=${session.liveNeedBodies.has(cid)}` +
                    ` step=${step ? `${step.kind}:${step.tplKey}@${step.objId ?? "?"}` : "—"}` +
                    ` tasks=${session.npcTasks.get(avatarIdOf(cid))?.length ?? 0}` +
                    ` drive=${session.lastDrive.get(avatarIdOf(cid)) ?? session.lastDrive.get(cid) ?? "—"}` +
                    ` h=${meter("hunger:food")} e=${meter("energy")} s=${meter("social")} f=${meter("fun")}${why}`,
                );
              }
            }
          }
        }
        // Idle townsfolk chat among themselves (ambient, personality-driven). Runs
        // unconditionally — it registers nearby residents into the dialogue world.
        stepNpcChatter(session, state, dt);
        // UNTARGETED-ORDER TASK POOL (phase ①a §2): expiry, claims, completion.
        stepTaskPool(session, dt);
        // INVENTORY placement: a SELECTED stack (outside conversation) is placed by the
        // gaze — dwell on the nearest CONTAINER (by position) puts one in, dwell on nearby
        // GROUND drops one. (Selecting a stack WHILE in conversation presents it instead.)
        if (session.selectedPocketGlyph && !choice && !container && world) {
          const me = state.avatars[PLAYER_ID];
          const gz = world.getGaze();
          const box = nearestContainer(session, state, me, false); // any container is a put target
          const fix = gz.committedWorld;
          const onBox = !!box && !!fix && Math.hypot(fix.x - box.x, fix.y - box.y) <= CONVO_FIG_RADIUS;
          const reachGround = !!me && !!fix && Math.hypot(me.x - fix.x, me.y - fix.y) <= CONVO_RADIUS;
          if (box && onBox) {
            if (dropDwell.step({ x: box.x, y: box.y }, dt * 1000).fired) putSelectedIn(session, box.id);
          } else if (reachGround) {
            if (dropDwell.step({ x: fix!.x, y: fix!.y }, dt * 1000).fired) dropSelected(session, fix!.x, fix!.y);
          } else {
            dropDwell.step(null, dt * 1000);
          }
        } else {
          dropDwell.step(null, dt * 1000);
        }
        // OPEN A CONTAINER: with nothing armed and not already in a conversation or an open
        // box, dwelling on a NON-EMPTY container opens its SELECTION POPUP. ONE
        // path for every container (chest / cupboard / table / market store). Not a carry
        // (fixtures) — a dedicated dwell, so it never touches the carry pickup-dwell.
        // EMBODIED: the nearest container to the BODY (walk up to look inside).
        // SPIRIT: whichever container the GAZE rests on, at ANY distance — the
        // formless observer sees into the room it watches (in the dollhouse the
        // view is READ-ONLY; see `select`).
        if (!session.selectedPocketGlyph && !choice && !convo && !container && world) {
          const me = state.avatars[PLAYER_ID];
          const fix = world.getGaze().committedWorld;
          const target = spiritNow()
            ? containerAtGaze(session, state, fix)
            : nearestContainer(session, state, me, true); // non-empty = openable now
          const onBox = !!target && !!fix && Math.hypot(fix.x - target.x, fix.y - target.y) <= CONVO_FIG_RADIUS;
          if (target && onBox) {
            if (openDwell.step({ x: target.x, y: target.y }, dt * 1000).fired) openContainer(session, target.id);
          } else {
            openDwell.step(null, dt * 1000);
          }
        } else {
          openDwell.step(null, dt * 1000);
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
          if (container) {
            // Container popup open: hold the camera on the box; dwell on empty ground
            // (fixation off the box) to close it — the same leave gesture as a convo.
            talkDwell.reset();
            const cObj = state.objects[container.objId];
            if (cObj) {
              cvHost.setConversation({ x: cObj.x, y: cObj.y });
              const g = fix && !onFig(cObj.x, cObj.y, CONVO_FIG_RADIUS) ? { x: fix.x, y: fix.y } : null;
              const res = leaveDwell.step(g, dt * 1000);
              progress = res.progress;
              if (res.fired) closeContainer();
            } else {
              closeContainer(); // the box streamed away
            }
          } else if (active) {
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
            if (spiritNow()) {
              // SPIRIT: talk to whoever the gaze RESTS on, at ANY distance (no
              // walking). Items are picked/placed by the host's distance-free carry.
              const hv = cvHost.getGaze().hover;
              const av = hv?.kind === "avatar" ? state.avatars[hv.id] : undefined;
              if (hv?.kind === "avatar" && av) {
                if (hv.id.startsWith("npc_")) {
                  const nodeId = hv.id.slice(4);
                  const t = session.ctx.nodeById.get(nodeId)?.type;
                  // A creature that lives OUTSIDE the goal tree (a wilderness
                  // local) is talkable through its fulfill-shaped mind.
                  const talkable =
                    t === "choose" || t === "converse" || t === "fulfill" ||
                    session.creatures?.nodeByCreature.has(nodeId);
                  if (talkable && (t !== "choose" && t !== "converse" || !session.rState.completed[nodeId])) {
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
              // Off-tree creatures (wilderness locals) are talkable by walking
              // up, like any fulfill poser — same dwell, same dialogue.
              if (session.creatures) {
                for (const [cid] of session.creatures.nodeByCreature) {
                  if (session.ctx.nodeById.has(cid)) continue; // tree posers handled above
                  if (cid.startsWith("resident_") || cid.startsWith("pet_")) continue; // their own arm below
                  const av = state.avatars[avatarIdOf(cid)];
                  if (!av) continue;
                  const d = Math.hypot(meAv.x - av.x, meAv.y - av.y);
                  if (d <= CONVO_RADIUS && d < nearD) { nearD = d; nearFig = { nodeId: cid, pos: { x: av.x, y: av.y } }; }
                }
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
              // Off-tree creatures (wilderness locals) resolve their fulfill-
              // shaped node through the creature book instead of the goal tree.
              const node =
                session.ctx.nodeById.get(nearFig.nodeId) ??
                session.creatures?.nodeByCreature.get(nearFig.nodeId);
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
                text: greet ? npcStatement(greet, creatureGlyph(session, nearFig.nodeId), nearFig.nodeId) : "",
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
                text: greet ? npcStatement(greet, creatureGlyph(session, nearRes.id), nearRes.id) : "",
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
          // is SEEN — sight is knowledge (creature-needs.md §5), and sight
          // carries visible item STATES through the fact channel (facts.ts).
          if (input.type === "enter-zone" && session.creatures) {
            const cworld = session.creatures.world;
            const seeStates = (id: string) => {
              for (const s of cworld.items[id]?.states ?? []) {
                const axis = STATE_AXES[s];
                if (axis) {
                  perceiveFact(cworld, PLAYER_CREATURE_ID, { kind: "itemState", item: id, axis, state: s });
                }
              }
            };
            const ownerNodeId = session.world.zones.find((z) => z.id === input.zoneId)?.ownerNodeId;
            const node = ownerNodeId ? session.creatures.nodeByCreature.get(ownerNodeId) : undefined;
            if (node) {
              for (const id of node.stockEntityIds ?? []) {
                seeItem(cworld, PLAYER_CREATURE_ID, id, { kind: "held", by: node.id });
                seeStates(id);
              }
              for (const id of node.propEntityIds ?? []) {
                if (cworld.items[id]?.ownerId === null) {
                  seeItem(cworld, PLAYER_CREATURE_ID, id, { kind: "loose" });
                  seeStates(id);
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
    if (deps.host) {
      // HOST-EMBED: the space-flight composer owns the rAF and drives us via
      // QuestHost3D.step. Start GROUNDED — WALKING owns the shared camera until
      // the coordinator lifts off (setDriveCamera(false)).
      questView?.setDriveCamera?.(true);
    } else {
      host.start();
    }
    world = host;
    // A reloaded world re-adopts the lab's standing debug choice (the overlay
    // above already did; this turns the host-side capture that feeds it on).
    if (pathDebugOn) host.setPathDebug(true);
    dispatchInput({ type: "start" });
    feedPointer();
  }

  function start(
    game: GoalTreeGame,
    town: TownPlay | null = null,
    opts: {
      spirit?: boolean; dollhouse?: number; wilderness?: WildernessParams;
      scale?: WorldScale; culture?: WorldCultureSpec | null;
    } = {},
  ) {
    spirit = !!opts.spirit;
    if (possession.creatureId) possession.dismiss(); // a new session is never born possessed
    sess = makeQuestSession(game, town);
    if (opts.scale) sess.scale = opts.scale;
    // The world's universal absolute ring (game.culture) founds the law
    // book — issuer "world", unrepealable, everywhere.
    if (opts.culture) {
      sess.laws.push(...absoluteLaws(resolveWorldCulture(opts.culture).absolutes));
    }
    // How this town DRESSES (game.culture.dress) — residents wear, stores stock
    // and bakes warm THIS palette; absent/invalid falls back to the curated set.
    sess.dress = resolveDressPalette(opts.culture);
    // WILDERNESS (founding flow): widen the tiny questless manifold to the
    // scatter's side and spawn at the centre clearing BEFORE the world builds
    // — the spec is consumed at host construction.
    if (opts.wilderness && !town) {
      const content = buildWilderness(opts.wilderness);
      sess.wilderness = content;
      sess.embedding.spec.manifold = {
        kind: "flat",
        width: content.side,
        height: content.side,
        // A planet-mounted chunk's rect is content extent, never a wall.
        ...(opts.wilderness.bounded === false ? { bounded: false } : {}),
      };
      sess.embedding.spec.spawns = [{ id: "spawn", x: content.spawn.x, y: content.spawn.y }];
    } else if (opts.wilderness && town) {
      // FOUNDING-AGE SURROUNDINGS (city-founding): a TOWN session with open
      // country around it — the scatter lays over the town's OWN manifold
      // (never resized: the stage owns it), cleared around the plaza/site so
      // the ground the settlers build on stays open. Same seed ⇒ same trees.
      const m = sess.embedding.spec.manifold as { width?: number; height?: number };
      const side = Math.max(60, Math.min(m.width ?? 240, m.height ?? 240));
      sess.wilderness = buildWilderness({
        ...opts.wilderness,
        side,
        clearAt: town.stage.center,
        clearR: town.plan.radius + 6,
      });
    }
    // A SPIRIT DOLLHOUSE frames its house (the structure-scope camera: low 3/4
    // angle, gaze-edge orbit) — resolved BEFORE the view exists, since a town's
    // building bounds are the whole town, not the home.
    const focusHouse =
      town && opts.dollhouse !== undefined ? dollhouseHouseOf(town, opts.dollhouse) : undefined;
    spiritFrame =
      spirit && town && focusHouse
        ? {
            x: town.stage.center.x + focusHouse.dx,
            y: town.stage.center.y + focusHouse.dy,
            w: focusHouse.w,
            h: focusHouse.h,
          }
        : null;
    buildTownPlaceFacts(sess); // the town's common knowledge of places (no-op off a town)
    isWon = false;
    choice = null;
    convo = null;
    container = null;
    taskSweepT = 0; // a fresh session's pool sweeps from zero
    cohortSweepT = 0; // ...and the cohort tier sweeps from zero too (④)
    cohortWalkerLive.clear(); // stale walker records never survive a session
    presenter.sessionStarted(sess);
    buildHost(sess);
    seedSmallItems(sess); // grabbable resource props (world ready after buildHost)
    stockContainers(sess); // stores: openable good boxes holding grabbable goods (bug #5)
    seedTownFauna(sess); // sheep at the weaver, orchards at the farms (chain scenery)
    seedWilderness(sess); // trees/rocks (material containers) + possessable locals
    seedSettlers(sess); // the founding group camped at an age-0 town (city-founding ②)
    if (opts.dollhouse !== undefined) enterDollhouse(sess, opts.dollhouse);
  }

  /** The dollhouse's house: by index, else the roomiest (it fits the beds) —
   *  ONE resolution shared by the camera frame and the dollhouse entry. */
  function dollhouseHouseOf(town: TownPlay, houseIndex: number): TownHouse | undefined {
    let house: TownHouse | undefined = town.plan.houses.find((h) => h.index === houseIndex);
    if (!house) {
      for (const h of town.plan.houses) {
        if (!house || h.w * h.h > house.w * house.h) house = h;
      }
    }
    return house;
  }

  /** DOLLHOUSE (§3): focus the `initial_focus` house (`resolveTownFocus` already
   *  validated it; an unknown index falls back to the roomiest, which fits the
   *  beds) and stand the player inside it. The reveal gates keep its interior
   *  permanently on show; its members get the motive set; commands drive the
   *  looked-at member directly. The town keeps living around it. */
  function enterDollhouse(session: QuestSession, houseIndex: number) {
    const town = session.town;
    if (!town || !world) return;
    const house = dollhouseHouseOf(town, houseIndex);
    if (!house) return;
    session.dollhouse = house.index;
    const me = world.state.avatars[PLAYER_ID];
    if (me) {
      // The LIVING room's center — the footprint center can sit ON the
      // partition wall once the house has rooms (rooms.ts).
      const lr = livingRect(town.stage.center, house);
      me.x = lr.x + lr.w / 2;
      me.y = lr.y + lr.h / 2;
    }
    spawnPets(session);
  }

  /** Stand the household PETS in the world (idempotent). A pet body is a plain
   *  NPC tethered to the family room — the needs loop drives its errands like
   *  any resident's; it is never distance-culled (it lives where the camera is). */
  function spawnPets(session: QuestSession) {
    const town = session.town;
    if (!town || !world) return;
    for (const { cid, house: hi, pet } of petsOf(session)) {
      if (world.state.avatars[cid]) continue;
      const rc = residentTownCtx(session, hi);
      if (!rc?.house) continue;
      // The pet lives in the LIVING room (its bowl's room) — the raw
      // footprint center can be a partition wall now (rooms.ts).
      const lr = livingRect(rc.center, rc.house);
      const cx = lr.x + lr.w / 2;
      const cy = lr.y + lr.h / 2;
      // Girth-check the fixed living-room offset against the pet's OWN radius —
      // a big pet must not embody inside the couch/table its house was built for.
      world.addNpc(girthSafeSpawn(world, {
        id: cid,
        x: cx + 1.2,
        y: cy + 1.2,
        species: pet.species ?? "quadruped", // the BODY's girth, not just the model
        behavior: {
          movement: "wander",
          wanderRadius: Math.min(lr.w, lr.h) * 0.35,
          home: { x: cx, y: cy },
          speed: 0.9,
          conversationRadius: 2.5,
        },
      }));
      ensurePetCreature(session, cid);
    }
  }

  // ── WILDERNESS + FOUNDING (city-expansion step 0) ──────────────────────────

  /** Mint a wilderness creature's mind — a needless "resident with no house"
   *  (one behavior model): the same dialogue projection, likes, and
   *  possession/recruit machinery every other creature runs. */
  function ensureWildCreature(session: QuestSession, cid: string) {
    let creatures = session.creatures;
    if (!creatures) {
      creatures = {
        world: createCreatureWorld([{ id: PLAYER_CREATURE_ID }], []),
        creatureByNode: new Map(),
        nodeByCreature: new Map(),
      };
      session.creatures = creatures;
    }
    if (creatures.world.creatures[cid]) return;
    const likes = [FOOD_KINDS[fnv1a(cid) % FOOD_KINDS.length]!];
    creatures.world.creatures[cid] = createCreatureWorld([{ id: cid, needs: [], likes }], [])
      .creatures[cid]!;
    const node: FulfillNode = { id: cid, type: "fulfill", npcEntityId: `wild_face:${cid}` };
    creatures.creatureByNode.set(cid, cid);
    creatures.nodeByCreature.set(cid, node);
  }

  /** Lay the wilderness scatter over the ground: every FEATURE is an ordinary
   *  openable container (a tree holds wood, a rock holds stone — gathering IS
   *  the container-take path), every creature an ordinary wandering body with
   *  a real mind. The player walker starts at the centre clearing. */
  function seedWilderness(session: QuestSession) {
    const w = session.wilderness;
    if (!w || !world) return;
    for (const f of w.features) {
      world.addObject({
        id: f.id,
        x: f.x,
        y: f.y,
        shape: "box",
        radius: f.kind === "tree" ? 0.7 : 0.55,
        fixture: "chest",
        openable: true,
        facing: 0,
        interactions: [],
        contains: [{ relation: "in", capacity: 12 }],
        iconRef: f.kind === "tree" ? "🌳" : "🪨",
        glyph: Object.keys(f.stock)[0],
      });
      session.containers.set(f.id, "in");
      session.containerStock.set(f.id, { ...f.stock });
      session.containerOwner.set(f.id, null); // nature is nobody's
    }
    for (const c of w.creatures) {
      ensureWildCreature(session, c.id);
      const body = avatarIdOf(c.id);
      session.npcIcons.set(body, c.icon);
      world.addNpc({
        id: body,
        x: c.x,
        y: c.y,
        behavior: {
          movement: "wander",
          wanderRadius: 18,
          home: { x: c.x, y: c.y },
          speed: 1.1,
          conversationRadius: 3,
        },
      });
    }
    // A TOWN session owns its spawn (the village square / founding site) —
    // only a bare wilderness parks the player at the scatter's clearing.
    if (!session.town) {
      const p = world.state.avatars[PLAYER_ID];
      if (p) {
        p.x = w.spawn.x;
        p.y = w.spawn.y;
      }
      session.spiritPos = { x: w.spawn.x, y: w.spawn.y };
    }
  }

  // ── SETTLERS (city-founding ②): the founding population as BODIES ────────
  // An age-0 town's people are the PLAYER'S GROUP — a small family camped at
  // the site. Each settler is an ordinary creature (the needless wild-creature
  // mind — one behavior model) whose RELATION to the guiding spirit is FAMILY,
  // so they obey spoken orders and volunteer for pooled tasks like a
  // household. A defined family (config.family, houseless at founding age)
  // names them. They stop seeding once the town has a real house — the first
  // move-in is, narratively, this group settling in (resident-model identity
  // transfer is the open seam).

  /** Cap on embodied settlers — a founding is a family, not a crowd. */
  const SETTLER_MAX = 8;

  /** The founding group's creature ids (empty off a founding-age town). */
  function settlersOf(session: QuestSession): string[] {
    const town = session.town;
    if (!town) return [];
    if ((town.config.days ?? 220) > FOUNDING_AGE_DAYS) return [];
    if (town.plan.houses.length > 0) return [];
    const pop = Math.max(0, Math.round(town.config.startPop ?? 0));
    const defined = town.config.family?.members.length ?? 0;
    const n = Math.min(SETTLER_MAX, Math.max(pop, defined));
    return Array.from({ length: n }, (_, i) => `settler_${i}`);
  }

  /** A settler's defined member row (names/species ride config.family). */
  function settlerMemberOf(session: QuestSession, cid: string): TownFamilyMember | undefined {
    const m = /^settler_(\d+)$/.exec(cid);
    return m ? session.town?.config.family?.members[Number(m[1])] : undefined;
  }

  /** Stand the founding group at the site (idempotent — start() calls it once
   *  per session; a rebuild re-seeds the same deterministic camp ring). */
  function seedSettlers(session: QuestSession) {
    const town = session.town;
    if (!town || !world) return;
    const ids = settlersOf(session);
    const c = town.stage.center;
    ids.forEach((cid, i) => {
      ensureWildCreature(session, cid);
      // Family standing toward the guiding spirit — the group obeys and
      // volunteers (task-pool compliance reads this book).
      session.relations.set(`${cid}|${PLAYER_CREATURE_ID}`, FAMILY_RELATION);
      const body = avatarIdOf(cid);
      if (world!.state.avatars[body]) return;
      const member = settlerMemberOf(session, cid);
      const species = member?.species ?? town.config.species;
      // The camp ring: around the supply crate at the site centre.
      const ang = (i / ids.length) * Math.PI * 2 + 0.7;
      const r = 5 + (i % 3) * 1.7;
      world!.addNpc(girthSafeSpawn(world!, {
        id: body,
        x: c.x + Math.cos(ang) * r,
        y: c.y + Math.sin(ang) * r,
        ...(species ? { species } : {}),
        behavior: {
          movement: "wander",
          wanderRadius: 14,
          home: { x: c.x, y: c.y },
          speed: 1.1,
          conversationRadius: 3,
        },
      }));
    });
  }

  /** The player's EFFECTIVE position for distance rules: the walker body when
   *  embodied (possessed / plain walker), else where the spirit hovers. */
  function playerWorldPos(session: QuestSession): { x: number; y: number } | null {
    const p = world?.state.avatars[PLAYER_ID];
    if (!spiritNow()) return p ? { x: p.x, y: p.y } : null;
    return session.spiritPos ?? (p ? { x: p.x, y: p.y } : null);
  }

  /** Radius (world units) around the camera focus treated as "on screen" for the
   *  no-snap-while-visible rule — generous, so anything plausibly in frame is
   *  protected from a teleport (a body just off-screen keeping its honest walk
   *  costs nothing). */
  const VIEW_RADIUS = 42;

  /** Is EITHER `a` or `b` within the player's view of the world? The camera
   *  tracks the possessed creature if riding one, else the player/spirit. Used to
   *  suppress every "snap to the end when the timer expires" shortcut while the
   *  player could actually see it happen. */
  function viewNear(
    session: QuestSession,
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): boolean {
    const foci: { x: number; y: number }[] = [];
    const possessed = possession.creatureId ? world?.state.avatars[avatarIdOf(possession.creatureId)] : null;
    if (possessed) foci.push({ x: possessed.x, y: possessed.y });
    const pp = playerWorldPos(session);
    if (pp) foci.push(pp);
    if (foci.length === 0) return true; // no known focus → assume watched (never snap blindly)
    return foci.some(
      (f) =>
        Math.hypot(f.x - a.x, f.y - a.y) < VIEW_RADIUS || Math.hypot(f.x - b.x, f.y - b.y) < VIEW_RADIUS,
    );
  }

  // ── UNTARGETED ORDERS → TASK POOL (city-expansion phase ①a §2) ─────────────

  /** The PLAYER-issuer's attention area at order time — the same effective
   *  position every distance rule uses (walker body / hovering spirit). A
   *  creature issuer would supply its own body's area — the pool itself is
   *  issuer-agnostic (§4). */
  function playerFocusArea(session: QuestSession): TaskFocus | null {
    const at = playerWorldPos(session);
    return at ? { x: at.x, y: at.y, radius: TASK_FOCUS_RADIUS } : null;
  }

  /** A creature's directed relation toward a task ISSUER: the warmed book
   *  first, else the household bond when the issuer is this family's guiding
   *  spirit (the same standing handlePlaceOrder grants), else a neutral
   *  stranger. No other player special-case — creature issuers read the same
   *  book. */
  function relationToward(session: QuestSession, cid: string, issuer: string): Relation {
    const rec = session.relations.get(`${cid}|${issuer}`);
    if (rec) return rec;
    if (issuer === PLAYER_CREATURE_ID && cid.startsWith("resident_")) {
      const fam = familyOf(session);
      if (fam && fam.house === Number(cid.split("_")[1])) return FAMILY_RELATION;
    }
    return DEFAULT_RELATION;
  }

  /** Post an untargeted order into the pool. Returns null when there's nowhere
   *  to scope it (no focus / no creature layer to ever claim it). */
  function postPooledTask(
    session: QuestSession,
    goal: GoalSpec,
    issuer: string,
    focus: TaskFocus,
    sourceGlyph: string,
  ) {
    if (!session.creatures) return null;
    return session.taskPool.post({ goal, issuer, focus, now: session.taskClock, sourceGlyph });
  }

  /** The world's symbol resolvers for the intent-announcement line. */
  function intentLineSyms(session: QuestSession): IntentLineSyms {
    return {
      item: (ref) =>
        "id" in ref
          ? liveItemGlyph(session, ref.id)
          : [ref.match.kind ?? ref.match.category ?? "thing", ...(ref.match.descriptors ?? [])].join("."),
      place: (p) =>
        p.kind === "named"
          ? p.id
          : p.kind === "home"
            ? "home"
            : p.kind === "creature"
              ? (p.id === PLAYER_CREATURE_ID ? "you" : (creatureGlyph(session, p.id) ?? "there"))
              : "there",
      creature: (cid) =>
        cid === PLAYER_CREATURE_ID ? "you" : (creatureGlyph(session, cid) ?? "there"),
    };
  }

  /** THE COMMAND ECHO (semantic-gaps.md §Commands): the accepted order spoken
   *  back as the creature understood it — full grammar via commandEcho /
   *  goalIntentLine ("I will wash the clothes"). The reserved bare "ok" is
   *  EARNED: only when the child's own glyphs already matched the canonical
   *  form. Teaching and debugging in one line — a wrong echo is a parser bug;
   *  a right echo not acted on is an action bug. */
  function commandEchoLine(session: QuestSession, frame: IntentFrame, goal: GoalSpec): string {
    const { line, perfect } = commandEcho(frame, goal, intentLineSyms(session));
    if (!line || perfect) return "ok";
    return line[session.game.meta.syntax ?? "b"];
  }

  /** INTENT ANNOUNCEMENT (phase ①a §3): speak what the creature is ABOUT to do
   *  before it does it — gated by the ONE criteria hook (default: announce on
   *  a pooled-task claim; routine self-directed behavior stays quiet). */
  function announceIntent(session: QuestSession, ctx: AnnounceContext) {
    if (!announceCriteria(ctx)) return;
    const line = goalIntentLine(ctx.goal, intentLineSyms(session));
    if (!line) return;
    npcChatBubble(session, ctx.creatureId, line[session.game.meta.syntax ?? "b"]);
  }

  /** SOFT CONTROL — a spark-triggered need ALWAYS announces before acting
   *  (attention-spark.md): the player drew the creature's attention to a thing,
   *  so it states its intent even though routine self-directed behavior stays
   *  quiet. Ungated, unlike announceIntent's task-claim criteria. */
  function announceSparkIntent(session: QuestSession, cid: string, goal: GoalSpec) {
    const line = goalIntentLine(goal, intentLineSyms(session));
    if (!line) return;
    if (isPetCid(cid)) ensurePetCreature(session, cid);
    else ensureResidentCreature(session, cid);
    npcChatBubble(session, cid, line[session.game.meta.syntax ?? "b"]);
  }

  /** Per-sweep task lifecycle: expire stale OPEN tasks back to the player,
   *  retire CLAIMED tasks whose claimant's errand ran out, then let willing +
   *  capable creatures inside each open task's focus area CLAIM it — exactly
   *  one per task (chooseClaimant is pure + deterministic: nearest, ties by
   *  id, no RNG — the seed+clock+mutations law holds). */
  let taskSweepT = 0;
  function stepTaskPool(session: QuestSession, dt: number) {
    session.taskClock += dt;
    if (!world || !session.creatures) return;
    taskSweepT += dt;
    if (taskSweepT < TASK_CLAIM_INTERVAL_S) return;
    taskSweepT = 0;
    const pool = session.taskPool;
    // EXPIRY surfaces back to the issuer — a task never rots silently. An
    // expired TRANSFER task retires its agreement the same way (no-executor).
    for (const t of pool.expire(session.taskClock)) {
      if (t.goal.kind === "transfer") session.transfers.fail(t.goal.agreementId, "no-executor");
      presenter.toast(`💬 no one can do that: "${t.sourceGlyph ?? t.goal.kind}"`, "feedback");
    }
    // STANDING transfer agreements (②): run any DUE scheduled legs over the
    // live endpoints — deterministic given the clock (creation order).
    // A TRIBUTE pull (E5) from a STUB partner draws from its synthetic
    // shelf — mint it first (the ⑤ one-boundary-mint law), so the pull
    // moves real units; a cluster partner's REAL yard is used as-is and
    // can honestly run dry.
    {
      const due = session.transfers.due(session.taskClock).filter((a) => !a.barter);
      if (due.length) {
        const partners = tradePartnersOf(session);
        for (const a of due) {
          const p = partners.find((tp) => townEndpointId(tp.key) === a.from);
          if (p && !p.real) {
            for (const [g, n] of Object.entries(a.goods)) {
              stockAbstractPartner(p.stack, g, Math.max(3, n * 2));
            }
          }
        }
      }
    }
    runDueTransfers(session.transfers, (id) => stockEndpointOf(session, id), session.taskClock);
    // INTERCITY BARTER shipments (⑤): due barter agreements re-derive their
    // terms, re-check the partner's willingness, and move stock BOTH ways —
    // each landing rendered at the depot (a caravan body + the honest toast).
    stepBarters(session);
    // FILLED → DONE: the claimant's errand queue ran out. BUILD tasks are
    // the exception — they complete off REAL construction state (the
    // founded delta's clock, stepFoundedConstruction), never off the walk.
    // TRANSFER tasks likewise complete off the LEDGER's status (the walk
    // ends at the crate; the agreement is what actually finished).
    for (const t of pool.claimed()) {
      if (t.goal.kind === "build") continue;
      if (t.goal.kind === "transfer") {
        const st = session.transfers.get(t.goal.agreementId)?.status;
        if (st === undefined || st === "done" || st === "failed") pool.complete(t.id);
        continue;
      }
      // A PURSUIT-driven claim (S5) is done when its pursuit is gone — the
      // errand queue flickers empty BETWEEN pursuit legs (walk → crouch →
      // re-plan), so the legacy queue check would complete a task mid-work.
      // Source-gated: a NEED pursuit installed after the task finished must
      // not hold the completion open (one-task-per-body would jam).
      if (session.pursuits.get(t.claimedBy!)?.source === "command") continue;
      const body = avatarIdOf(t.claimedBy!);
      const queued = (session.npcTasks.get(body)?.length ?? 0) > 0;
      if (!queued && !world.npcErrandActive(body)) pool.complete(t.id);
    }
    const openTasks = pool.open();
    if (!openTasks.length) return;
    const resolver = makeGoalResolver(session);
    const bctx = buildContext(session);
    for (const task of openTasks) {
      // BUILD capability (①b): the goal never compiles to a body errand by
      // design — capability = the catalog resolves it, the stock covers its
      // costs, and a feasible lot exists. Computed once per task per sweep.
      let buildPrepMemo: { spec: StructureSpec; candidate: FoundingCandidate } | null | undefined;
      const buildPrep = (): { spec: StructureSpec; candidate: FoundingCandidate } | null => {
        if (buildPrepMemo !== undefined) return buildPrepMemo;
        buildPrepMemo = null;
        if (task.goal.kind === "build" && bctx) {
          const spec = resolveStructure(bctx.catalog, task.goal.structure);
          if (spec && costsMet(spec, bctx.stock)) {
            const cands = buildCandidates(bctx, spec);
            if (cands.length) buildPrepMemo = { spec, candidate: cands[0]! };
          }
        }
        return buildPrepMemo;
      };
      // TRANSFER capability (②): the goal never compiles to a body errand
      // by design — capability = the agreement is live, both endpoints
      // resolve, and the source actually holds the goods. Once per sweep.
      let transferPrepMemo: boolean | undefined;
      const transferPrep = (): boolean => {
        if (transferPrepMemo !== undefined) return transferPrepMemo;
        transferPrepMemo = false;
        if (task.goal.kind === "transfer") {
          const a = session.transfers.get(task.goal.agreementId);
          if (a && a.status === "pending") {
            const from = stockEndpointOf(session, a.from);
            const to = stockEndpointOf(session, a.to);
            transferPrepMemo =
              !!from?.at && !!to?.at && Object.keys(a.goods).some((g) => stackUnits(from.stack, g) > 0);
          }
        }
        return transferPrepMemo;
      };
      // APPROPRIATENESS = the existing willingness/capability machinery:
      // capable = the goal compiles to an executable plan for this body
      // ("cannot" never claims); willing = compliance toward the ISSUER
      // clears the volunteer bar ("wont" doesn't volunteer). A BUILD order
      // is CIVIC: a town resident volunteers for its town's construction
      // (roster-style appropriateness, not personal compliance), and a
      // bonded (once-ridden) creature volunteers for its family.
      const candidates: TaskCandidate[] = [];
      for (const cid of session.creatures.nodeByCreature.keys()) {
        if (cid === PLAYER_CREATURE_ID || cid === possession.creatureId) continue;
        if (session.party.has(cid) || session.escorting.has(cid)) continue;
        if (pool.claimedBy(cid)) continue; // one task per body
        const mind = session.creatures.world.creatures[cid];
        if (!mind || mind.cannotLeavePost) continue; // a post-bound puzzle creature never volunteers
        const body = world.state.avatars[avatarIdOf(cid)];
        if (!body) continue;
        const compliant =
          compliance(relationToward(session, cid, task.issuer), creatureMood(cid)) >=
          VOLUNTEER_COMPLIANCE;
        candidates.push({
          id: cid,
          pos: { x: body.x, y: body.y },
          capable:
            task.goal.kind === "build"
              ? buildPrep() !== null
              : task.goal.kind === "transfer"
                ? transferPrep() && canGrasp(mind)
                : compileGoal(task.goal, cid, resolver) !== null,
          willing:
            task.goal.kind === "build"
              ? cid.startsWith("resident_") || session.bondedCreatures.has(cid) || compliant
              : compliant,
        });
      }
      const winner = chooseClaimant(task, candidates);
      if (!winner) continue; // stays open — someone may wander into focus before expiry
      if (task.goal.kind === "build") {
        const prep = buildPrep();
        if (!prep) continue;
        if (!pool.claim(task.id, winner)) continue; // already FILLED — skip
        // Announce BEFORE doing ("I'll build the house") — the criteria hook.
        announceIntent(session, {
          creatureId: winner,
          goal: task.goal,
          source: "task-claim",
          taskId: task.id,
          issuer: task.issuer,
        });
        const b = executeBuildOrder(session, prep.spec, prep.candidate, winner);
        if (!b) {
          pool.release(task.id); // the stock moved between checks — reopen
          continue;
        }
        session.buildTaskOrds.set(task.id, b.ord);
        session.lastDrive.set(avatarIdOf(winner), "task");
        continue;
      }
      if (task.goal.kind === "transfer") {
        if (!transferPrep()) continue;
        const agreementId = task.goal.agreementId;
        if (!pool.claim(task.id, winner)) continue; // already FILLED — skip
        if (!session.transfers.begin(agreementId, winner)) {
          pool.release(task.id); // the agreement moved between checks — reopen
          continue;
        }
        // Announce BEFORE doing ("I'll put the wood in the yard").
        announceIntent(session, {
          creatureId: winner,
          goal: task.goal,
          source: "task-claim",
          taskId: task.id,
          issuer: task.issuer,
        });
        issueTransferHaul(session, winner, agreementId);
        session.lastDrive.set(avatarIdOf(winner), "task");
        continue;
      }
      const plan = compileGoal(task.goal, winner, resolver);
      if (!plan) continue; // capability flickered between checks — retry next sweep
      if (!pool.claim(task.id, winner)) continue; // already FILLED — skip
      // Announce BEFORE doing ("I'll get the wood") — the criteria hook gates it.
      announceIntent(session, {
        creatureId: winner,
        goal: task.goal,
        source: "task-claim",
        taskId: task.id,
        issuer: task.issuer,
      });
      // The claim takes the body over like any spoken command would.
      session.needStep.delete(winner);
      session.npcTasks.delete(avatarIdOf(winner));
      session.lastDrive.set(avatarIdOf(winner), "task");
      if (PURSUED_GOALS.has(task.goal.kind)) {
        // S5: a claimed pooled task IS a command — install a `source:"command"`
        // pursuit (the same engine a spoken order runs: per-tick re-plan,
        // stand-nudge, act cap, the honest blocked line) instead of a baked
        // one-shot errand. Completion = the pursuit clearing (the FILLED→DONE
        // sweep above).
        session.walk.delete(winner);
        session.pursuits.set(winner, {
          source: "command",
          goal: task.goal,
          glyph: task.sourceGlyph ?? task.goal.kind,
        });
      } else {
        issueGoalPlan(session, winner, plan);
      }
    }
  }

  // ── TRANSFER AGREEMENTS (city-expansion ②) ─────────────────────────────────
  // ONE scope-agnostic transfer primitive (kernel/town/transfer.ts): an
  // agreement between two STOCK ENDPOINTS, executed by a haul. Endpoints are
  // VIEWS over the live stack maps — containerStock entries (which already
  // alias the site crate and the town yard), deltas.stock, pockets — never
  // shadow copies: what a haul moves is what every other system reads.

  /** A registered container's walk-to anchor: its world object when streamed
   *  in, else its house's doorstep (furniture streams out with the interior —
   *  the stack map stays true either way). */
  function containerAnchor(session: QuestSession, id: string): { x: number; y: number } | null {
    const o = world?.state.objects[id];
    if (o) return { x: o.x, y: o.y };
    const m = /^furn_(\d+)_/.exec(id);
    const town = session.town;
    if (m && town) {
      const h = town.plan.houses.find((hh) => hh.index === Number(m[1]));
      if (h) return houseDoorstep(town.stage.center, h);
    }
    return null;
  }

  /** A house goods chest's capacity — the good's boxCap (PANTRY_CAP for
   *  food). Null for everything else (uncapped). */
  function houseChestCap(session: QuestSession, id: string): number | null {
    const m = /^furn_\d+_chest_(.+)$/.exec(id);
    if (!m || !session.town) return null;
    const g = session.town.stage.goods.find((x) => x.good.key === m[1]);
    return g ? Math.max(1, Math.round(g.boxCap)) : null;
  }

  /** Resolve an endpoint id to a LIVE StockEndpoint view, or null. Container
   *  ids resolve over containerStock; `pocket:<cid>` is a creature's hands
   *  (the player's pocket / a resident's carried stack). Derived stores
   *  (market shelves, produce piles, the trade depot) are time-pure
   *  projections with no mutable map to alias — NOT transfer endpoints. */
  function stockEndpointOf(session: QuestSession, id: string): StockEndpoint | null {
    if (!world) return null;
    if (id.startsWith(POCKET_EP)) {
      const cid = id.slice(POCKET_EP.length);
      if (cid === PLAYER_CREATURE_ID) {
        const at = playerWorldPos(session);
        return at ? { id, kind: "pocket", at, stack: session.pocket, owner: creatureScope(cid) } : null;
      }
      const body = world.state.avatars[avatarIdOf(cid)];
      if (!body) return null;
      const carried = session.needCarried.get(cid) ?? {};
      session.needCarried.set(cid, carried); // ensure the entry IS the alias
      return { id, kind: "pocket", at: { x: body.x, y: body.y }, stack: carried, owner: creatureScope(cid) };
    }
    // A COHORT DISTRICT POOL (④, population.ts) is a real endpoint: the
    // view ALIASES the pool's live stack (② transfers reach the district),
    // anchored at the district's walk-to point. Communal scope.
    const cohortDistrict = parseCohortEndpointId(id);
    if (cohortDistrict !== null) {
      const row = session.town ? cohortRowOf(session.town.deltas.cohorts, cohortDistrict) : undefined;
      if (!row) return null;
      const a = districtAnchorWorld(session, cohortDistrict);
      return cohortEndpoint(row, { x: a.x, y: a.y });
    }
    // A TRADE PARTNER's town-scale stack (⑤): `town:<partnerKey>` — the ②
    // bridge's endpoint id convention made LIVE. A real-sim partner (cluster
    // neighbor) aliases its OWN yard (deltas.stock — shipments conserve
    // across both economies); an abstract partner aliases its synthetic
    // shelf. No `at`: abstract, scheduled-only (transfer.ts convention).
    // ("town:yard" is a registered container and never reaches this branch.)
    if (id.startsWith("town:") && !session.containers.has(id)) {
      const p = tradePartnersOf(session).find((tp) => townEndpointId(tp.key) === id);
      if (!p) return null;
      return { id, kind: "town", stack: p.stack, owner: null };
    }
    if (session.marketStore.has(id) || session.produceBox.has(id) || id.startsWith("trade:")) return null;
    if (!session.containers.has(id)) return null;
    let stack = session.containerStock.get(id);
    if (!stack) {
      stack = {};
      session.containerStock.set(id, stack); // a registered but never-stocked container (a cupboard)
    }
    const at = containerAnchor(session, id);
    if (!at) return null;
    const kind = id === TOWN_YARD_ID ? "yard" : id === SITE_STOCK_ID ? "site" : "container";
    const ep: StockEndpoint = { id, kind, at, stack, owner: session.containerOwner.get(id) ?? null };
    const cap = houseChestCap(session, id);
    if (cap !== null) ep.capacity = cap;
    return ep;
  }

  /** The house a spoken "house"/"house.red" names: the colour glyph first
   *  (directions.ts houseGlyphForColor — the same word directions teach),
   *  else the nearest OTHER house ("the other house", never the family's
   *  own). Deterministic — ties break to the lower index. */
  function houseBySpoken(session: QuestSession, modifiers: string[]): number | null {
    const town = session.town;
    if (!town) return null;
    if (modifiers.length) {
      const want = `house.${modifiers[0]}`;
      const h = town.plan.houses.find((hh) => houseGlyphForColor(hh.color) === want);
      return h ? h.index : null;
    }
    const at = playerWorldPos(session);
    const fam = familyOf(session);
    let best: number | null = null;
    let bestD = Infinity;
    for (const h of town.plan.houses) {
      if (fam && h.index === fam.house) continue;
      const d = houseDoorstep(town.stage.center, h);
      const dist = at ? Math.hypot(d.x - at.x, d.y - at.y) : h.index;
      if (dist < bestD || (dist === bestD && best !== null && h.index < best)) {
        bestD = dist;
        best = h.index;
      }
    }
    return best;
  }

  /** A HOUSE as a stock endpoint: its chest for the goods' own good (the
   *  pantry for food, the wardrobe for clothing), else its communal
   *  cupboard — the household box vocabulary house↔house trade rides. */
  function houseEndpointId(session: QuestSession, hi: number, goodsHead: string): string | null {
    if (!session.town) return null;
    const chest = `furn_${hi}_chest_${goodKeyOfGlyph(goodsHead)}`;
    if (session.containers.has(chest)) return chest;
    const cupboard = `furn_${hi}_cupboard`;
    return session.containers.has(cupboard) ? cupboard : null;
  }

  /** The stock ENDPOINT a transfer destination names, or null when the place
   *  isn't endpoint-shaped (the legacy putIn/drop paths keep those). */
  function transferDestOf(session: QuestSession, place: PlaceRef, goodsHead: string): string | null {
    if (place.kind === "creature") return `${POCKET_EP}${place.id}`;
    if (place.kind !== "named") return null;
    const id = place.id;
    // "yard" — the builder's yard: the town crate (deltas.stock) or the
    // founded site's stockpile crate (the ①b spend stock, either way).
    if (id === "yard") return session.town ? TOWN_YARD_ID : session.foundedSite ? SITE_STOCK_ID : null;
    const hm = /^house:(\d+)$/.exec(id);
    if (hm) return houseEndpointId(session, Number(hm[1]), goodsHead);
    if (session.containers.has(id) && stockEndpointOf(session, id)) return id;
    // A spoken container noun ("box"/"chest"/"cupboard"/"table"): the nearest
    // registered container answering to it (the resolver's token rule).
    const at = playerWorldPos(session);
    let best: string | null = null;
    let bestD = Infinity;
    for (const boxId of session.containers.keys()) {
      if (!boxId.split(/[_:]/).includes(id)) continue;
      const anchor = containerAnchor(session, boxId);
      if (!anchor || !stockEndpointOf(session, boxId)) continue;
      const d = at ? Math.hypot(anchor.x - at.x, anchor.y - at.y) : 0;
      if (d < bestD || (d === bestD && best !== null && boxId < best)) {
        bestD = d;
        best = boxId;
      }
    }
    return best;
  }

  /** Candidate SOURCE endpoints for a transfer order: every container stack
   *  plus the issuer's own pocket, OWNERSHIP-GATED for the issuer (orders
   *  move only stock that is OURS to move — ownership.ts scope chain).
   *  Foreign stock is remembered so the refusal can be honest and named
   *  ("it's not ours"). */
  function transferSourcesOf(
    session: QuestSession,
    goodsHead: string,
    destId: string,
    destAt: { x: number; y: number },
  ): { sources: TransferSource[]; foreignOwner: string | null } {
    const issuerHouse = familyOf(session)?.house ?? null;
    const sources: TransferSource[] = [];
    let foreignOwner: string | null = null;
    for (const [boxId, stack] of session.containerStock) {
      if (boxId === destId) continue;
      if (session.marketStore.has(boxId) || session.produceBox.has(boxId) || boxId.startsWith("trade:")) continue;
      if (stackUnits(stack, goodsHead) <= 0) continue;
      const owner = session.containerOwner.get(boxId);
      if (!mayUse(PLAYER_CREATURE_ID, issuerHouse, owner)) {
        foreignOwner = owner ?? foreignOwner;
        continue;
      }
      const at = containerAnchor(session, boxId);
      if (!at) continue;
      sources.push({ id: boxId, stack, d: Math.hypot(at.x - destAt.x, at.y - destAt.y) });
    }
    const pocketId = `${POCKET_EP}${PLAYER_CREATURE_ID}`;
    if (pocketId !== destId && stackUnits(session.pocket, goodsHead) > 0) {
      const at = playerWorldPos(session);
      if (at) sources.push({ id: pocketId, stack: session.pocket, d: Math.hypot(at.x - destAt.x, at.y - destAt.y) });
    }
    return { sources, foreignOwner };
  }

  /** How the intent line phrases a destination endpoint. */
  function transferDestPlaceRef(destId: string): PlaceRef {
    if (destId.startsWith(POCKET_EP)) return { kind: "creature", id: destId.slice(POCKET_EP.length) };
    if (destId === TOWN_YARD_ID || destId === SITE_STOCK_ID) return { kind: "named", id: "yard" };
    if (/^furn_\d+_(chest_|cupboard)/.test(destId)) return { kind: "named", id: "house" };
    return { kind: "named", id: destId.split(/[_:]/).pop() ?? destId };
  }

  /**
   * ONE spoken transfer order (city-expansion ②), end to end: "give/bring
   * <goods> to <house/yard/person>", "put <goods> in <endpoint>", with
   * quantities. Returns false when the order isn't transfer-shaped (the
   * shipped single-unit give/putIn paths keep it); true when HANDLED —
   * accepted (agreements posted; hauls running or pooled) or refused ALOUD
   * with the reason NAMED ("we don't have 3 wood" / "it's not ours").
   */
  function orderTransfer(
    session: QuestSession,
    goal: Extract<GoalSpec, { kind: "give" } | { kind: "putIn" }>,
    qty: number,
    sentence: string,
    explicitHauler: string | null,
  ): boolean {
    if (!world || !session.creatures) return false;
    if (!("match" in goal.item)) return false; // an exact instance rides the legacy paths
    const head = goal.item.match.kind ?? goal.item.match.category;
    if (!head) return false;
    const syntax = session.game.meta.syntax ?? "b";
    // A single unit handed to a CREATURE stays the shipped give path (real
    // ownership + gratitude); endpoints and quantities come here.
    if (goal.kind === "give" && qty <= 1) return false;
    const destPlace: PlaceRef = goal.kind === "give" ? { kind: "creature", id: goal.to } : goal.container;
    const destId = transferDestOf(session, destPlace, head);
    if (!destId) return false;
    const dest = stockEndpointOf(session, destId);
    if (!dest?.at) return false;
    // Someone else's PRIVATE box is not a drop target — refused, named.
    if (isPrivateOwner(dest.owner) && !mayUse(PLAYER_CREATURE_ID, familyOf(session)?.house ?? null, dest.owner)) {
      const ownerCid = ownerCidsOf(dest.owner)[0];
      const who = (ownerCid && creatureGlyph(session, ownerCid)) || "someone";
      if (explicitHauler) npcChatBubble(session, explicitHauler, "no");
      presenter.toast(`💬 can't — that box is ${who}'s`, "feedback");
      return true;
    }
    // SOURCES, nearest-to-destination first (deterministic: ties by id).
    const { sources, foreignOwner } = transferSourcesOf(session, head, destId, dest.at);
    const available = sources.reduce((s, src) => s + stackUnits(src.stack, head), 0);
    const want = Number.isFinite(qty) ? qty : Math.max(1, available);
    // NOTHING in any endpoint and nothing foreign either: fall through to
    // the shipped paths — a LOOSE instance on the ground may still serve the
    // order (the legacy pick/place resolver sees loose props; this layer
    // deliberately moves only ENDPOINT stock).
    if (available === 0 && !foreignOwner) return false;
    const plan = planTransferSources(sources, head, want);
    const draws = plan.draws.slice(0, TRANSFER_MAX_SOURCES);
    const covered = draws.reduce((s, d) => s + d.take, 0);
    if (covered < want) {
      if (available === 0 && foreignOwner) {
        // The goods EXIST — but they're not ours. Honest, named.
        const ownerCid = ownerCidsOf(foreignOwner)[0];
        const who = ownerCid
          ? (creatureGlyph(session, ownerCid) ?? ownerCid)
          : foreignOwner.startsWith("house:")
            ? "the other house"
            : foreignOwner;
        if (explicitHauler) npcChatBubble(session, explicitHauler, "no");
        presenter.toast(`💬 the ${head} is not ours — it belongs to ${who}`, "feedback");
      } else {
        if (explicitHauler) npcChatBubble(session, explicitHauler, noStock(head)[syntax]);
        presenter.toast(
          `💬 we don't have ${want} ${head}${covered > 0 ? ` — only ${covered}` : ""}`,
          "feedback",
        );
      }
      return true;
    }
    // ONE agreement per source drawn (a split order fans out — two chests,
    // two hauls; emergent, deterministic).
    const posted: TransferAgreement[] = draws.map((d) =>
      session.transfers.post({
        from: d.id,
        to: destId,
        goods: { [head]: d.take },
        issuer: PLAYER_CREATURE_ID,
        mode: "haul",
        now: session.taskClock,
        sourceGlyph: sentence,
      }),
    );
    if (explicitHauler) {
      // WILLINGNESS — the build-order gate: a resident hauls for its town,
      // a bonded creature for its family, anyone else needs real compliance.
      const willing =
        explicitHauler.startsWith("resident_") ||
        session.bondedCreatures.has(explicitHauler) ||
        compliance(relationToward(session, explicitHauler, PLAYER_CREATURE_ID), creatureMood(explicitHauler)) >=
          VOLUNTEER_COMPLIANCE;
      if (!willing) {
        for (const a of posted) session.transfers.fail(a.id, "no-executor");
        npcChatBubble(session, explicitHauler, placementWontLine()[syntax]);
        return true;
      }
      npcChatBubble(session, explicitHauler, "ok"); // the RESERVED okay — an accepted order
      for (const a of posted) {
        session.transfers.begin(a.id, explicitHauler);
        issueTransferHaul(session, explicitHauler, a.id);
      }
      presenter.toast(`▶ ${sentence}`, "feedback");
      return true;
    }
    // UNTARGETED → the ①a task pool: one pooled task per agreement; any
    // appropriate creature in the focus area may claim, announcing first.
    const focus = playerFocusArea(session);
    if (!focus) {
      for (const a of posted) session.transfers.fail(a.id, "no-executor");
      presenter.toast(`💬 "${sentence}" — can't do that here`, "feedback");
      return true;
    }
    for (const a of posted) {
      postPooledTask(
        session,
        { kind: "transfer", agreementId: a.id, goods: a.goods, to: transferDestPlaceRef(destId) },
        PLAYER_CREATURE_ID,
        focus,
        sentence,
      );
    }
    presenter.toast(`🪧 ${sentence} — anyone nearby may take it`, "feedback");
    return true;
  }

  /** Walk `cid` through one agreement's HAUL: LOAD at the source (stock
   *  leaves the real map into the hauler's hands — a visible carried prop),
   *  UNLOAD at the destination (hands → the real map; capacity overflow
   *  spills honestly as loose piles — nothing vanishes). Completion writes
   *  the LEDGER; pooled tasks retire off that status, never the walk. */
  function issueTransferHaul(session: QuestSession, cid: string, agreementId: string) {
    if (!world) return;
    const a = session.transfers.get(agreementId);
    if (!a) return;
    const from = stockEndpointOf(session, a.from);
    const to = stockEndpointOf(session, a.to);
    if (!from?.at || !to?.at) {
      session.transfers.fail(agreementId, "no-endpoint");
      return;
    }
    const npcId = avatarIdOf(cid);
    const syntax = session.game.meta.syntax ?? "b";
    const head = stackHead(Object.keys(a.goods)[0] ?? "thing");
    session.needStep.delete(cid);
    session.npcTasks.delete(npcId);
    session.lastDrive.set(npcId, "transfer");
    session.npcGoing.set(cid, {
      kind: "place",
      place: a.to === TOWN_YARD_ID || a.to === SITE_STOCK_ID ? "yard" : "there",
    });
    const destAt = { x: to.at.x, y: to.at.y };
    enqueueNpcErrand(session, npcId, {
      points: [{ x: from.at.x, y: from.at.y }, destAt],
      onArrive: (i) => {
        const agr = session.transfers.get(agreementId);
        if (!agr || agr.status !== "moving" || !world) return;
        if (i === 0) {
          // A RESTORED mid-carry row already holds its load (serialized
          // `carried` — a reload never loses a load): the goods left the
          // source in the DEAD session, so taking again would double-draw
          // and the load() overwrite would vanish the old armful. Skip
          // straight to the visible carry token.
          const restored =
            agr.carried && Object.values(agr.carried).some((n) => n > 0);
          if (!restored) {
            // LOAD — the live map is the truth: a shelf raided during the walk
            // loads what's left, an emptied one fails ALOUD.
            const src = stockEndpointOf(session, agr.from);
            const taken = src ? takeGoods(src.stack, agr.goods) : {};
            const n = Object.values(taken).reduce((s, x) => s + x, 0);
            if (n <= 0) {
              session.transfers.fail(agreementId, "missing");
              npcChatBubble(session, cid, noStock(head)[syntax]);
              return;
            }
            for (const [g, c] of Object.entries(taken)) {
              for (let k = 0; k < c; k++) removeVisibleContainedProp(session, agr.from, g);
            }
            if (agr.from === `${POCKET_EP}${PLAYER_CREATURE_ID}`) pushPocket(session);
            session.transfers.load(agreementId, taken);
          }
          // The visible load: one carried prop tokens the whole armful.
          if (!npcCarrying(npcId)) {
            const body = world.state.avatars[npcId];
            if (body) {
              spawnLooseProp(session, head, body.x, body.y);
              const newObj = [...session.smallProps.keys()].pop();
              if (newObj) carryObject(world.state, newObj, npcId);
            }
          }
          fireCarryGesture(npcId, "pickup", from.at);
          return;
        }
        // UNLOAD.
        const dst = stockEndpointOf(session, agr.to);
        if (!dst) {
          session.transfers.fail(agreementId, "no-endpoint");
          return;
        }
        const carried = agr.carried ?? {};
        const { accepted, refused } = putStock(dst, carried);
        for (const [g, c] of Object.entries(accepted)) {
          for (let k = 0; k < c; k++) addVisibleContainedProp(session, agr.to, g);
        }
        let sp = 0;
        for (const [g, c] of Object.entries(refused)) {
          for (let k = 0; k < c && sp < 12; k++, sp++) {
            const ang = (sp / 6) * Math.PI * 2;
            spawnLooseProp(session, g, destAt.x + Math.cos(ang) * (1 + 0.3 * sp), destAt.y + Math.sin(ang) * (1 + 0.3 * sp));
          }
        }
        if (agr.to === `${POCKET_EP}${PLAYER_CREATURE_ID}`) pushPocket(session);
        else if (agr.to.startsWith(POCKET_EP)) {
          // A resident recipient re-decides with the goods in hand — the
          // gift path's law: the live loop eats it or walks it home.
          const rc = agr.to.slice(POCKET_EP.length);
          if (rc.startsWith("resident_")) {
            session.liveNeedBodies.add(rc);
            session.needStep.delete(rc);
          }
        }
        const held = npcCarrying(npcId);
        if (held && session.smallProps.has(held)) removeLooseProp(session, held);
        fireCarryGesture(npcId, "putdown", destAt);
        session.transfers.complete(agreementId);
        presenter.toast(`📦 ${agr.sourceGlyph ?? "transfer"} — delivered`, "feedback");
      },
    });
  }

  /** A spoken "build" in open country: found a new EMPTY site at the avatar —
   *  deposit the pocket's building materials (and any material piles lying at
   *  the spot) into its stockpile crate, dismiss the avatar back to spirit,
   *  and tell the boot to centre on it. One site per session; a town session
   *  is never wilderness. Returns false when founding doesn't apply here. */
  function foundNewSite(session: QuestSession): boolean {
    if (!session.wilderness || session.town || session.foundedSite || !world) return false;
    const at = playerWorldPos(session);
    if (!at) return false;
    const day = Math.floor(session.townClock / FOOD_DAY_SEC);
    const seed = (fnv1a(`${session.game.meta.seed ?? 0}|${Math.round(at.x)}|${Math.round(at.y)}`) % 100000) + 1;
    const site = foundSite({ seed, at, day });
    // The pocket's materials found the stock…
    depositSiteStock(site, session.pocket);
    pushPocket(session);
    // …and so do material PILES already dropped at the spot (loose props
    // within arm's-reach radius of the founding point).
    for (const [objId, rec] of [...session.smallProps]) {
      const obj = world.state.objects[objId];
      if (!obj || Math.hypot(obj.x - at.x, obj.y - at.y) > 8) continue;
      const stack: Record<string, number> = { [rec.glyph]: 1 };
      const moved = depositSiteStock(site, stack);
      if (Object.keys(moved).length) removeLooseProp(session, objId);
    }
    // The site stockpile crate — an ordinary container whose stack map IS the
    // site's stock (same object), so puts/takes keep the site record true.
    world.addObject({
      id: SITE_STOCK_ID,
      x: at.x + 1.2,
      y: at.y + 1.2,
      shape: "box",
      radius: 0.7,
      fixture: "chest",
      openable: true,
      facing: 0,
      interactions: [],
      contains: [{ relation: "in", capacity: 99 }],
      iconRef: "🏗️",
      glyph: "wood",
    });
    session.containers.set(SITE_STOCK_ID, "in");
    session.containerStock.set(SITE_STOCK_ID, site.stock);
    session.containerOwner.set(SITE_STOCK_ID, null); // communal — the founders'
    session.foundedSite = site;
    // The session's ledger/shelves become the SITE's (deltas-owned) — a
    // standing route agreed at the frontier serializes with the site and
    // rides siteTownConfig into the town it becomes (P0 persistence law:
    // the ledger lives beside the construction it feeds). Any wilderness
    // one-shot haul active at this exact moment is orphaned deliberately —
    // pre-site wilderness has no persistence at all.
    session.transfers = site.deltas.transfers;
    session.partnerStock = site.deltas.partnerStock;
    wildFoundedIds.clear(); // a fresh site raises nothing yet (①b)
    wildFurnishedOrds.clear();
    // Founding steps the spirit OUT of the avatar and centres it on the site.
    if (possession.creatureId) possession.dismiss();
    session.spiritPos = { x: at.x, y: at.y };
    deps.onSiteFounded?.({ key: site.key, seed: site.seed, at: { ...site.at }, stock: { ...site.stock } });
    return true;
  }

  /** Drop a loose small prop from the world + the session's books (founding
   *  sweep; the pocket-merge path in pickup has its own inline removal). */
  function removeLooseProp(session: QuestSession, objId: string) {
    const rec = session.smallProps.get(objId);
    if (!rec) return;
    session.smallProps.delete(objId);
    world?.removeObject(objId);
    if (session.creatures) delete session.creatures.world.items[rec.entityId];
  }

  /** ABANDONMENT (the founding contract): once the player is farther from a
   *  still-EMPTY site than the abandon radius, the site is cleared — its crate
   *  removed, its materials spilled back onto the ground as loose piles. Runs
   *  every frame; cheap (one distance check). */
  function stepFoundedSite(session: QuestSession) {
    const site = session.foundedSite;
    if (!site || !world) return;
    const pos = playerWorldPos(session);
    if (!pos) return;
    const side = Math.min(
      world.state.spec.manifold.width,
      world.state.spec.manifold.height,
    );
    if (Math.hypot(pos.x - site.at.x, pos.y - site.at.y) <= siteAbandonRadius(side)) return;
    if (!siteIsEmpty(site)) return;
    const spill = abandonSite(site);
    session.containers.delete(SITE_STOCK_ID);
    session.containerStock.delete(SITE_STOCK_ID);
    session.containerOwner.delete(SITE_STOCK_ID);
    world.removeObject(SITE_STOCK_ID);
    // Spill the materials back where they were gathered to (bounded — a
    // wilderness stock is small; anything past the cap merges into the last pile).
    let spilled = 0;
    for (const [glyph, n] of Object.entries(spill)) {
      for (let i = 0; i < n && spilled < 24; i++, spilled++) {
        const ang = (spilled / 8) * Math.PI * 2;
        const r = 1 + 0.35 * spilled;
        spawnLooseProp(session, glyph, site.at.x + Math.cos(ang) * r, site.at.y + Math.sin(ang) * r);
      }
    }
    session.foundedSite = null;
    // The site's ledger dies with the site — the session gets fresh books.
    session.transfers = createTransferLedger();
    session.partnerStock = {};
    presenter.toast("🏚️ the empty site was abandoned", "feedback");
    deps.onSiteAbandoned?.(site.key);
  }

  // ── BUILD ORDERS (city-expansion ①b): "build <structure>" ──────────────────
  // The dead end wired: a town-scope (or founded-site) build order resolves
  // against the STRUCTURE CATALOG, checks costs against the site/town STOCK
  // (missing glyphs NAMED), enumerates a lot (feasibility inside the
  // enumeration — foundingOptions), gates willingness (placement-will's
  // grades), commits the FOUNDED DELTA, and construction stands visibly on
  // the ground until its build clock runs out.

  /** Wall color of a lot still under construction (town-stage's scaffold). */
  const WILD_SCAFFOLD_COLOR = "#b3a488";

  /** The session's buildable-structure catalog (world content; config swap). */
  function structureCatalogOf(session: QuestSession): StructureSpec[] {
    return session.town?.structures ?? TOWN_PLAY_STRUCTURES;
  }

  /** The stock a build order spends: the founded site's gathered materials,
   *  or the town's builder's-yard (deltas.stock). Null off both. */
  function buildStockOf(session: QuestSession): Record<string, number> | null {
    if (session.town) return session.town.deltas.stock;
    if (session.foundedSite) return session.foundedSite.stock;
    return null;
  }

  /** The construction clock, in GAME-days of the session's scale (townClock
   *  on a town session; the always-running task clock at a wilderness site).
   *  On the street-clock profile this is the street day, as before. */
  function buildDayNow(session: QuestSession): number {
    return (session.town ? session.townClock : session.taskClock) / session.scale.dayLengthS;
  }

  interface BuildContext {
    catalog: StructureSpec[];
    deltas: TownDeltas;
    stock: Record<string, number>;
    /** World point the town-local founded coordinates hang off. */
    center: { x: number; y: number };
    seed: number;
    key: string;
    bearings: readonly number[];
    occupied: Array<{ x: number; y: number; w: number; h: number }>;
    claimedSlots: Set<number>;
    bound: number;
    /** ZONE CHARTERS (③) — the deltas' rows, read live. */
    zones: readonly ZoneCharter[];
    /** Economy district of a spec's `economy` key (zone category grouping);
     *  null off a town session (a founded site has no compiled economy). */
    districtOf: (economyKey: string) => string | null;
  }

  /** A spec's zone-admission categories in THIS session (its type + its
   *  economy row's district — zoning.ts). */
  function specCategories(ctx: BuildContext, spec: StructureSpec): Set<string> {
    return categoriesOfSpec(spec, ctx.districtOf);
  }

  /** Everything a build order needs, or null where building doesn't apply
   *  (neither a town session nor a founded site). */
  function buildContext(session: QuestSession): BuildContext | null {
    if (session.town) {
      const plan = session.town.plan;
      const claimed = new Set<number>();
      for (const h of plan.houses) claimed.add(h.slot ?? h.index);
      for (const b of session.town.deltas.founded()) claimed.add(b.slot);
      return {
        catalog: structureCatalogOf(session),
        deltas: session.town.deltas,
        stock: session.town.deltas.stock,
        center: session.town.stage.center,
        seed: session.town.config.seed,
        key: plan.key,
        bearings: plan.streets.bearings,
        occupied: [
          ...plan.houses.map((h) => ({ x: h.dx, y: h.dy, w: h.w, h: h.h })),
          ...plan.works.map((w) => ({ x: w.dx, y: w.dy, w: w.w, h: w.h })),
        ],
        claimedSlots: claimed,
        bound: plan.radius + 30,
        zones: session.town.deltas.zones(),
        districtOf: (k) => session.town!.eco.works.find((w) => w.key === k)?.district ?? null,
      };
    }
    const site = session.foundedSite;
    if (site && world) {
      const founded = site.deltas.founded();
      const W = world.state.spec.manifold.width;
      const H = world.state.spec.manifold.height;
      return {
        catalog: structureCatalogOf(session),
        deltas: site.deltas,
        stock: site.stock,
        center: site.at,
        seed: site.seed,
        key: site.key,
        bearings: [],
        occupied: founded.map((b) => ({ x: b.dx, y: b.dy, w: b.w, h: b.h })),
        claimedSlots: new Set(founded.map((b) => b.slot)),
        bound: Math.max(24, Math.min(site.at.x, site.at.y, W - site.at.x, H - site.at.y) - 4),
        zones: site.deltas.zones(),
        districtOf: () => null,
      };
    }
    return null;
  }

  /** Feasible lots for `spec` right now, best-first (foundingOptions).
   *  ZONE-AWARE by default (③): ground zoned for another category never
   *  comes back, and a zone that WANTS this structure outranks open
   *  ground. `ignoreZones` re-runs the raw enumeration — the refusal
   *  prober (was the ground merely zoned, or truly out?). */
  function buildCandidates(
    ctx: BuildContext,
    spec: StructureSpec,
    opts?: { ignoreZones?: boolean },
  ): FoundingCandidate[] {
    const useZones = !opts?.ignoreZones && ctx.zones.length > 0;
    return foundingOptions({
      seed: ctx.seed,
      key: ctx.key,
      bearings: ctx.bearings,
      footprint: spec.footprint,
      type: spec.type,
      occupied: ctx.occupied,
      claimedSlots: ctx.claimedSlots,
      bound: ctx.bound,
      ...(useZones ? { zoning: slotZoningFn(ctx.zones, specCategories(ctx, spec)) } : {}),
    });
  }

  /** COMMIT a validated build: spend the costs, write the founded delta,
   *  stand the scaffold (town: a plan row the stage reconciles; wilderness:
   *  the site's own walls), and walk the builder to the lot. Returns the
   *  founded row, or null when the stock could no longer cover it. */
  function executeBuildOrder(
    session: QuestSession,
    spec: StructureSpec,
    candidate: FoundingCandidate,
    builder: string | null,
  ): FoundedBuilding | null {
    const ctx = buildContext(session);
    if (!ctx) return null;
    if (!spendCosts(spec, ctx.stock)) return null;
    // A structure's catalog buildDays are RELATIVE (house = 1); the session's
    // scale turns them into game-days — half a year of them at realism, one
    // street-day on the shipped town profile (space-time-compression.md §4).
    const b = ctx.deltas.foundBuilding(
      candidate,
      buildDayNow(session),
      constructionGameDays(spec.buildDays, session.scale),
    );
    if (session.town) {
      // The plan row (staff arrives at completion) — the stage reconciles
      // the appended work on the version bump foundBuilding just made.
      session.town.plan.works.push({
        type: spec.type,
        dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
        color: spec.color,
        program: spec.program,
        ...(spec.stations ? { stations: spec.stations } : {}),
        jobs: 0,
        foundedOrd: b.ord,
      });
    } else if (session.foundedSite) {
      noteSiteBuilding(session.foundedSite);
      refreshWildFounded(session);
    }
    if (builder) {
      const target = workDoorstep(ctx.center, {
        type: spec.type, color: spec.color, dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
      });
      session.needStep.delete(builder);
      session.npcTasks.delete(avatarIdOf(builder));
      session.lastDrive.set(avatarIdOf(builder), "build");
      issueGoalPlan(session, builder, { steps: [{ kind: "moveTo", pos: target }] });
    }
    return b;
  }

  /** The wilderness site's founded buildings, raised into the live world:
   *  scaffold boxes while building, real doored rooms + work furniture
   *  (registered containers) when done. Idempotent — call on any change. */
  const wildFoundedIds = new Set<string>();
  const wildFurnishedOrds = new Set<number>();
  function refreshWildFounded(session: QuestSession) {
    const site = session.foundedSite;
    if (!site || !world) return;
    const day = buildDayNow(session);
    const specs: BuildingSpec[] = [];
    for (const b of site.deltas.founded()) {
      const spec = resolveStructure(structureCatalogOf(session), b.type);
      const wk = {
        dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
        ...(spec?.stations ? { stations: spec.stations } : {}),
      };
      if (!foundedBuildingDone(b, day)) {
        specs.push({
          id: `wf_${b.ord}`,
          footprint: { x: site.at.x + b.dx, y: site.at.y + b.dy, w: b.w, h: b.h },
          floors: 1, stairs: false, wallThickness: 0.4, doorways: [],
          color: WILD_SCAFFOLD_COLOR,
        });
        continue;
      }
      const roomPlan = buildingRoomPlan(site.at, 1000 + b.ord, wk, spec?.program ?? { store: true });
      for (const room of roomPlan.rooms) {
        specs.push({
          id: room.id,
          footprint: room.rect,
          floors: 1, stairs: false, wallThickness: 0.4,
          doorways: room.doorways,
          color: spec?.color ?? "#9b8a6d",
        });
      }
      if (!wildFurnishedOrds.has(b.ord)) {
        wildFurnishedOrds.add(b.ord);
        for (const piece of workFurniture(site.at, 1000 + b.ord, wk, spec?.program ?? { store: true })) {
          const ok = world.addObject({
            id: piece.id,
            x: piece.x,
            y: piece.y,
            shape: "box",
            radius: piece.radius,
            fixture: piece.kind,
            openable: piece.openable,
            facing: piece.facing,
            interactions: [],
            contains: [{ relation: "in", capacity: 4 }],
          });
          if (ok && piece.openable) {
            session.containers.set(piece.id, "in");
            session.containerStock.set(piece.id, {});
            session.containerOwner.set(piece.id, null); // communal — the founders'
          }
        }
      }
    }
    const base = (world.state.spec.buildings ?? []).filter((bd) => !wildFoundedIds.has(bd.id));
    wildFoundedIds.clear();
    for (const s of specs) wildFoundedIds.add(s.id);
    world.setBuildings([...base, ...specs]);
  }

  /** CONSTRUCTION COMPLETION sweep (~1 s): a founded building whose build
   *  clock ran out is marked complete IN THE DELTA (the serialized fact),
   *  its plan row gains its roster jobs (townJobsMemo invalidates so
   *  assignTownJobs re-deals with the new workplace), pooled build tasks
   *  keyed to it complete off this REAL construction state, and the world
   *  visibly swaps scaffold → doored building. */
  let foundedSweepT = 0;
  function stepFoundedConstruction(session: QuestSession, dt: number) {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas) return;
    foundedSweepT += dt;
    if (foundedSweepT < 1) return;
    foundedSweepT = 0;
    const day = buildDayNow(session);
    for (const b of deltas.founded()) {
      if (b.completed || !foundedBuildingDone(b, day)) continue;
      deltas.completeFounding(b.ord);
      const spec = resolveStructure(structureCatalogOf(session), b.type);
      if (session.town) {
        const row = session.town.plan.works.find((w) => w.foundedOrd === b.ord);
        if (row) row.jobs = spec?.jobs ?? 0;
        townJobsMemo = null; // the roster re-deals: the new workplace hires
        // THE ECONOMY LEARNS THE BUILDING EXISTS (city-founding): a founded
        // producer joins the aggregate books — its count scalar gates
        // process capacity (economy.ts capacityBy), so the town's FIRST
        // farm is what starts the food, not a phantom seed.
        const work = spec?.economy
          ? session.town.eco.works.find((w) => w.key === spec.economy)
          : null;
        if (work) session.town.town.inject(work.countScalar, 1);
      } else if (session.foundedSite) {
        refreshWildFounded(session);
      }
      for (const [taskId, ord] of [...session.buildTaskOrds]) {
        if (ord !== b.ord) continue;
        session.taskPool.complete(taskId);
        session.buildTaskOrds.delete(taskId);
      }
      presenter.toast(`🏛️ the ${spec?.label ?? b.type} is finished`, "feedback");
    }
  }

  /**
   * ONE spoken/board build order, end to end. Returns false when building
   * doesn't apply here at all (the caller phrases "can't build here");
   * true when the order was HANDLED — accepted or refused aloud (unknown
   * structure named, missing materials named, no ground, won't).
   */
  function orderBuild(
    session: QuestSession,
    structure: string,
    sentence: string,
    explicitBuilder: string | null,
  ): boolean {
    const ctx = buildContext(session);
    if (!ctx) return false;
    const syntax = session.game.meta.syntax ?? "b";
    const speakerFor =
      explicitBuilder && session.creatures?.nodeByCreature.has(explicitBuilder)
        ? explicitBuilder
        : null;
    const spec = resolveStructure(ctx.catalog, structure);
    if (!spec) {
      // UNKNOWN STRUCTURE — a NAMED conversational can't (never a silent
      // generic fallback; the workProgram() lesson).
      if (speakerFor) npcChatBubble(session, speakerFor, "no");
      presenter.toast(`💬 can't build "${structure}" — not a structure we know`, "feedback");
      return true;
    }
    const missing = missingCosts(spec, ctx.stock);
    if (Object.keys(missing).length) {
      // MISSING MATERIALS — the glyphs are NAMED in the refusal.
      const names = Object.entries(missing).map(([g, n]) => `${n} ${g}`).join(", ");
      if (speakerFor) npcChatBubble(session, speakerFor, noStock(spec.glyph)[syntax]);
      presenter.toast(`💬 we need more ${names} to build the ${spec.label}`, "feedback");
      return true;
    }
    const candidates = buildCandidates(ctx, spec);
    if (!candidates.length) {
      // No admissible lot. Probe WITHOUT the charters: ground that exists
      // raw but not zoned-aware is merely SPOKEN FOR — a WONT-shaped zoning
      // refusal with the category NAMED ("that's farmland"); truly-out
      // ground stays the kernel's honest CANNOT.
      const raw = ctx.zones.length ? buildCandidates(ctx, spec, { ignoreZones: true }) : [];
      const zoned = raw.length
        ? charterZoneAt(ctx.zones, raw[0]!.dx + raw[0]!.w / 2, raw[0]!.dy + raw[0]!.h / 2)
        : null;
      if (zoned?.category) {
        if (speakerFor) npcChatBubble(session, speakerFor, zoneRefusalLine(spec.glyph, zoned.category)[syntax]);
        presenter.toast(`💬 that ground is zoned for ${zoned.category} — no place for a ${spec.label}`, "feedback");
        return true;
      }
      // CANNOT — no feasible lot (the kernel's honest refusal).
      if (speakerFor) npcChatBubble(session, speakerFor, placementCannotLine(spec.glyph, "service")[syntax]);
      presenter.toast(`💬 no ground for a ${spec.label} here`, "feedback");
      return true;
    }
    if (!explicitBuilder) {
      // UNTARGETED → the ①a TASK POOL: any appropriate creature in the
      // focus area may claim it (stepTaskPool's build capability check).
      const focus = playerFocusArea(session);
      const posted = focus
        ? postPooledTask(session, { kind: "build", structure: spec.type, cap: 1 }, PLAYER_CREATURE_ID, focus, sentence)
        : null;
      presenter.toast(
        posted ? `🪧 ${sentence} — anyone nearby may take it` : `💬 "${sentence}" — can't do that here`,
        "feedback",
      );
      return true;
    }
    // WILLINGNESS (placement-will's grades): the player's own possessed
    // body always obliges; a town resident treats a civic build as its
    // town's business; a bonded (once-ridden) creature helps its family;
    // anyone else needs real compliance — else "won't", aloud.
    const willing =
      explicitBuilder === possession.creatureId ||
      explicitBuilder.startsWith("resident_") ||
      session.bondedCreatures.has(explicitBuilder) ||
      compliance(relationToward(session, explicitBuilder, PLAYER_CREATURE_ID), creatureMood(explicitBuilder)) >=
        VOLUNTEER_COMPLIANCE;
    if (!willing) {
      npcChatBubble(session, explicitBuilder, placementWontLine()[syntax]);
      return true;
    }
    const walker = explicitBuilder === possession.creatureId ? null : explicitBuilder;
    const b = executeBuildOrder(session, spec, candidates[0]!, walker);
    if (!b) {
      presenter.toast(`💬 "${sentence}" — can't do that here`, "feedback");
      return true;
    }
    if (walker && speakerFor) npcChatBubble(session, walker, "ok"); // the RESERVED okay — an accepted order
    presenter.toast(`🏗️ building the ${spec.label} — up in ${spec.buildDays} day${spec.buildDays === 1 ? "" : "s"}`, "feedback");
    return true;
  }

  // ── AREA CHARTERS (city-expansion ③): "area <category> here" ──────────────
  // The player's focus circle is the BRUSH: a spoken area order charters
  // exactly the ground the task pool would scope an order to (TaskFocus),
  // written town-local into the deltas (TownDeltas.addZone — serialized,
  // replayed, LATER CHARTERS WIN where discs overlap). "area none" clears.
  // (The KERNEL side keeps its `zone` geometry names — this is vocabulary.)

  /**
   * ONE spoken/board zone order, end to end. Returns false when zoning
   * doesn't apply here at all (no town, no founded site — the caller
   * phrases "can't do that here"); true when HANDLED — chartered with the
   * reserved-ok confirmation, or refused aloud with the word NAMED.
   */
  function orderZone(session: QuestSession, categoryWord: string | null, sentence: string): boolean {
    const ctx = buildContext(session);
    if (!ctx) return false;
    const focus = playerFocusArea(session);
    if (!focus) return false;
    const syntax = session.game.meta.syntax ?? "b";
    // The addressed "clerk" — whoever the order was aimed at confirms it
    // (the reserved okay); a bare order into the town confirms by toast +
    // the tint appearing (board words visibly change the world).
    const clerk = session.addressedFamily ?? gazeCreature(session) ?? convo?.nodeId ?? null;
    const brush = {
      x: focus.x - ctx.center.x,
      y: focus.y - ctx.center.y,
      r: focus.radius,
      issuer: PLAYER_CREATURE_ID,
    };
    if (categoryWord === null) {
      // UNZONE: a CLEARING charter — the ground under the brush reads
      // unzoned again (later-wins; nothing is deleted, replay holds).
      ctx.deltas.addZone({ ...brush, category: null });
      if (clerk && session.creatures?.nodeByCreature.has(clerk)) npcChatBubble(session, clerk, "ok");
      presenter.toast(`🗺️ cleared the zoning here`, "feedback");
      return true;
    }
    const category = resolveZoneCategory(ctx.catalog, ctx.districtOf, categoryWord);
    if (!category) {
      // UNKNOWN CATEGORY — a NAMED conversational can't (the workProgram()
      // lesson: never a silent generic fallback).
      if (clerk && session.creatures?.nodeByCreature.has(clerk)) npcChatBubble(session, clerk, "no");
      presenter.toast(`💬 can't zone "${categoryWord}" — not a structure we know`, "feedback");
      return true;
    }
    ctx.deltas.addZone({ ...brush, category });
    if (clerk && session.creatures?.nodeByCreature.has(clerk)) {
      npcChatBubble(session, clerk, "ok"); // the RESERVED okay — an accepted order
    }
    presenter.toast(`🗺️ zoned for ${category} here`, "feedback");
    return true;
  }

  // ── INTERCITY BARTER (city-expansion ⑤): "trade wood with the city" ──────
  // The economy stance EXECUTED at the boundary: communal inside, priced at
  // the edges. A deal is goods-for-goods at a ratio driven by BOTH towns'
  // scarcities (kernel/town/barter.ts — no currency anywhere); the clerk
  // SPEAKS THE TERMS on acceptance; shipments ride the ② ledger as barter
  // agreements and land as a visible caravan at the depot.

  /** A trade partner as the host sees one — key, place, scarcity signals,
   *  and the LIVE stack `town:<key>` aliases. */
  interface TradePartner {
    key: string;
    at: { x: number; y: number } | null;
    /** True = a real sim's books (cluster neighbor); false = the stub proxy. */
    real: boolean;
    signals: BarterSignals;
    stack: Record<string, number>;
  }

  /** An abstract partner's synthetic shelf (created on first touch). */
  function abstractPartnerStack(session: QuestSession, key: string): Record<string, number> {
    let s = session.partnerStock[key];
    if (!s) {
      s = {};
      session.partnerStock[key] = s;
    }
    return s;
  }

  /** A commodity shortage off ARBITRARY town books (the townShortage math,
   *  aimed at a partner's own fills/scalars). */
  function shortageOfBooks(eco: CompiledEconomy, tw: TownWorld, good: string): number {
    const fill = eco.fills.find((f) => f.good === good);
    if (!fill) return 0;
    const need = tw.scalar(fill.need);
    if (need <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - tw.scalar(fill.got) / need));
  }

  /**
   * Every partner this session can trade with, deterministic order:
   *   • cluster neighbors (REAL sims — live books + their actual yard);
   *   • the bound caravan line's partner (trade.ts route — a real neighbor's
   *     key when bindPartner ran, else the abstract "away" line), stub-proxied
   *     unless a cluster member already carries the key;
   *   • boot-supplied partners (deps.tradePartners — flight cities etc.);
   *   • a FOUNDED SITE with none of the above still gets ONE abstract
   *     partner ("away:<siteKey>") — the frontier trades from day one.
   * Multi-partner falls out of the `town:<key>` endpoint keying for free.
   */
  function tradePartnersOf(session: QuestSession): TradePartner[] {
    const out: TradePartner[] = [];
    const seen = new Set<string>();
    const day = buildDayNow(session);
    const push = (p: TradePartner) => {
      if (seen.has(p.key)) return;
      seen.add(p.key);
      out.push(p);
    };
    const stub = (key: string, at: { x: number; y: number } | null) =>
      push({
        key,
        at,
        real: false,
        signals: stubPartnerSignals(key, Math.floor(day)),
        stack: abstractPartnerStack(session, key),
      });
    const t = session.town;
    for (const cp of t?.stage.cluster?.partners?.() ?? []) {
      if (cp.books) {
        const books = cp.books;
        push({
          key: cp.key,
          at: cp.at,
          real: true,
          signals: { shortage: (g) => shortageOfBooks(books.eco, books.town, g) },
          stack: books.stock,
        });
      } else stub(cp.key, cp.at);
    }
    const route = t?.stage.trade?.route;
    if (route) stub(route.partnerKey, route.gate);
    for (const bp of deps.tradePartners?.() ?? []) stub(bp.key, bp.at);
    if (!out.length && session.foundedSite) stub(`away:${session.foundedSite.key}`, null);
    return out;
  }

  /** OUR side's scarcity signals: town books when we have them; a founded
   *  site reads its own crate (empty shelf = everything scarce — the honest
   *  frontier bargaining position). */
  function ourBarterSignals(session: QuestSession): BarterSignals {
    if (session.town) return { shortage: (g) => townShortage(session, g) };
    const site = session.foundedSite;
    if (site) {
      return { shortage: (g) => Math.max(0, Math.min(1, 1 - stackUnits(site.stock, g) / 6)) };
    }
    return { shortage: () => 0 };
  }

  /** The goods vocabulary a take-good defaults over: the street goods plus
   *  whatever the yard/site crate actually holds (deterministic order). */
  function tradeGoodsOf(session: QuestSession): string[] {
    const out: string[] = [];
    for (const g of session.town?.stage.goods ?? []) out.push(g.good.key);
    // A founded site has no street-goods books yet — food is the frontier's
    // canonical want (its crate-based shortage signal prices it honestly).
    if (!session.town && session.foundedSite) out.push("food");
    const stock = session.town?.deltas.stock ?? session.foundedSite?.stock ?? {};
    for (const g of Object.keys(stock).map(stackHead)) {
      if (!out.includes(g)) out.push(g);
    }
    return out;
  }

  /** The spoken partner word resolved against the known partners: a generic
   *  word (city/town/hamlet…) or no word takes the FIRST partner; a specific
   *  word must match a key (loose contains-match, case-blind). Null = the
   *  word names nobody we trade with (the caller refuses NAMED). */
  function resolveTradePartner(partners: TradePartner[], word: string | null): TradePartner | null {
    if (!partners.length) return null;
    if (!word) return partners[0]!;
    const w = word.trim().toLowerCase();
    if (["city", "town", "hamlet", "village", "neighbor", "away", "there"].includes(w)) {
      return partners[0]!;
    }
    return partners.find((p) => p.key.toLowerCase().includes(w)) ?? null;
  }

  /** Our give-side endpoint: the town yard / the founded site's crate. */
  function tradeHomeEndpointId(session: QuestSession): string | null {
    return session.town ? TOWN_YARD_ID : session.foundedSite ? SITE_STOCK_ID : null;
  }

  /**
   * TRIBUTE (nations P3/E5): "bring <good> from <partner>" — a STANDING
   * daily pull from a member settlement's yard into ours, executed by the
   * ② scheduled sweep (conserving, real stacks both sides; a stub
   * partner's shelf is minted at the boundary like barter's). The spoken
   * quantity scales the daily load (1–3); the first load travels. Returns
   * false when the word names no trade partner — the ordinary transfer
   * paths may still serve the order.
   */
  function orderTribute(
    session: QuestSession,
    goal: Extract<GoalSpec, { kind: "give" } | { kind: "putIn" }>,
    partnerWord: string,
    quantityWord: string | undefined,
    sentence: string,
  ): boolean {
    if (!("match" in goal.item)) return false;
    const head = goal.item.match.kind ?? goal.item.match.category;
    if (!head) return false;
    const homeId = tradeHomeEndpointId(session);
    if (!homeId) return false;
    const partner = resolveTradePartner(tradePartnersOf(session), partnerWord);
    if (!partner) return false;
    const q = orderQuantity(quantityWord);
    const perDay = Number.isFinite(q) ? Math.max(1, Math.min(3, q)) : 1;
    session.transfers.post({
      from: townEndpointId(partner.key),
      to: homeId,
      goods: { [head]: perDay },
      issuer: PLAYER_CREATURE_ID, // the sovereign's decree — a POLITY issuer at P4
      mode: "scheduled",
      now: session.taskClock,
      every: FOOD_DAY_SEC,
      dueAt: session.taskClock + BARTER_LEG_DAY_FRAC * FOOD_DAY_SEC,
      sourceGlyph: sentence,
    });
    const clerk = session.addressedFamily ?? gazeCreature(session) ?? convo?.nodeId ?? null;
    // NATIONS P6: the confirmation SPEAKS WHAT WAS AGREED, the way the
    // barter clerk speaks its terms — "they give food", the standing fact
    // the player just created, not a bare "ok" the student can't read back.
    if (clerk && session.creatures?.nodeByCreature.has(clerk)) {
      npcChatBubble(session, clerk, tributeLine(head, "in")[session.game.meta.syntax ?? "b"]);
    }
    presenter.toast(`👑 tribute: ${perDay} ${head} each day from ${partner.key}`, "feedback");
    return true;
  }

  /**
   * ONE spoken/board trade order, end to end. Returns false when trading
   * doesn't apply here at all (no town/site — the caller phrases "can't
   * trade here"); true when HANDLED — the deal posted with the TERMS SPOKEN
   * (the reserved-ok flow states the ratio: hearing the terms shift with
   * scarcity is the lesson), or refused aloud with the reason NAMED
   * ("they have enough wood", "we don't have 2 wood — only 1").
   * `quantity` is the spoken word: a number trades that many give-units
   * (whole quote batches); "all" makes a STANDING daily route.
   */
  function orderTrade(
    session: QuestSession,
    goal: Extract<GoalSpec, { kind: "trade" }>,
    quantityWord: string | undefined,
    sentence: string,
  ): boolean {
    const homeId = tradeHomeEndpointId(session);
    if (!homeId) return false;
    const partners = tradePartnersOf(session);
    if (!partners.length) return false;
    const syntax = session.game.meta.syntax ?? "b";
    const clerk = session.addressedFamily ?? gazeCreature(session) ?? convo?.nodeId ?? null;
    const speak = (line: { a: string; b: string; c: string } | "ok" | "no") => {
      if (clerk && session.creatures?.nodeByCreature.has(clerk)) {
        npcChatBubble(session, clerk, typeof line === "string" ? line : line[syntax]);
      }
    };
    const partner = resolveTradePartner(partners, goal.partner);
    if (!partner) {
      // UNKNOWN PARTNER — named, with who we DO trade with.
      speak("no");
      presenter.toast(
        `💬 we don't trade with "${goal.partner}" — our road goes to ${partners.map((p) => p.key).join(", ")}`,
        "feedback",
      );
      return true;
    }
    const give = stackHead(goal.give);
    const us = ourBarterSignals(session);
    // E4 (nations P3): once the trade network is dense enough, the clerk's
    // default take-side is the NUMERAIRE — the same pair-worth quote, one
    // fixed denominator, so spoken terms READ AS PRICES ("3 wood for
    // 2 metal"). An explicit take word, or a thin network, stays pure
    // barter — a village is never forced onto coin.
    const money = session.town?.eco.numeraire ?? null;
    const moneyed = numeraireActive(money, session.transfers.active());
    const take = goal.take
      ? stackHead(goal.take)
      : moneyed && money !== give && tradeGoodsOf(session).includes(money!)
        ? money!
        : defaultTakeGood(tradeGoodsOf(session), give, us);
    if (!take || take === give) {
      speak("no");
      presenter.toast(`💬 can't trade ${give} for ${take ?? "nothing"}`, "feedback");
      return true;
    }
    // THE PARTNER'S WILLINGNESS — it accepts only when the deal relieves its
    // own worst shortages; refusals speak the established honest vocabulary.
    const will = barterWillingness(give, take, us, partner.signals);
    if (!will.ok) {
      speak(barterRefusalLine(will.reason, give, take));
      presenter.toast(
        will.reason === "wont-part"
          ? `💬 ${partner.key} won't part with ${take}`
          : `💬 ${partner.key} has enough ${give}`,
        "feedback",
      );
      return true;
    }
    // THE QUOTE — computed at agreement time, attached to the row, spoken.
    const quote = barterQuote(give, take, us, partner.signals);
    const standing = quantityWord === "all";
    const wantUnits = standing ? quote.give : Math.max(quote.give, orderQuantity(quantityWord));
    const batches = Math.floor(wantUnits / quote.give);
    const giveN = batches * quote.give;
    // OUR side must cover the give-goods — honest, counted refusal.
    const home = stockEndpointOf(session, homeId);
    const have = home ? stackUnits(home.stack, give) : 0;
    if (have < giveN) {
      speak(noStock(give));
      presenter.toast(
        `💬 we don't have ${giveN} ${give}${have > 0 ? ` — only ${have}` : ""}`,
        "feedback",
      );
      return true;
    }
    session.transfers.post({
      from: homeId,
      to: townEndpointId(partner.key),
      goods: { [give]: giveN },
      issuer: PLAYER_CREATURE_ID,
      mode: "scheduled",
      now: session.taskClock,
      // The caravan takes TRAVEL TIME: the shipment lands a leg out, and a
      // standing route runs one leg per street day after that.
      dueAt: session.taskClock + FOOD_DAY_SEC * BARTER_LEG_DAY_FRAC,
      ...(standing ? { every: FOOD_DAY_SEC } : {}),
      sourceGlyph: sentence,
      barter: {
        take: { [take]: batches * quote.take },
        giveGood: give,
        takeGood: take,
        quote: { give: quote.give, take: quote.take },
        partnerKey: partner.key,
      },
    });
    // THE TERMS, SPOKEN — the reserved-ok flow states the ratio.
    speak(barterTermsLine(quote, give, take));
    presenter.toast(
      `🐴 trade with ${partner.key}: ${giveN} ${give} for ${batches * quote.take} ${take}` +
        (standing ? " — every day" : ""),
      "feedback",
    );
    return true;
  }

  /** Run every due barter shipment (stepTaskPool's sweep): abstract partners
   *  get their shelf topped up first (the stub's one deterministic mint), the
   *  kernel executor re-derives terms + willingness and moves stock BOTH
   *  ways, and each report renders — a caravan body at OUR depot for a
   *  shipment, a named toast on a suspension edge / resume. */
  function stepBarters(session: QuestSession) {
    const partners = tradePartnersOf(session);
    if (!partners.length) return;
    const byKey = new Map(partners.map((p) => [p.key, p]));
    const now = session.taskClock;
    for (const a of session.transfers.due(now)) {
      const b = a.barter;
      if (!b) continue;
      const p = byKey.get(b.partnerKey);
      if (p && !p.real) {
        stockAbstractPartner(p.stack, b.takeGood, Math.max(9, Object.values(b.take)[0] ?? 0));
      }
    }
    const reports = runDueBarters(
      session.transfers,
      (id) => stockEndpointOf(session, id),
      now,
      {
        us: ourBarterSignals(session),
        themOf: (key) => byKey.get(key)?.signals ?? null,
      },
    );
    for (const r of reports) renderBarterLeg(session, r);
  }

  /** What one barter leg SHOWS: shipped goods toast + the caravan body at
   *  our depot; suspension/resume edges named — status visible, not silent. */
  function renderBarterLeg(session: QuestSession, r: BarterLegReport) {
    const fmt = (m: Record<string, number>) =>
      Object.entries(m).map(([g, n]) => `${n} ${stackHead(g)}`).join(", ") || "nothing";
    if (r.status === "suspended") {
      if (r.newlySuspended) {
        presenter.toast(
          r.reason === "wont-part"
            ? `⏸ ${r.partnerKey} won't part with theirs — trade paused`
            : `⏸ ${r.partnerKey} has enough — trade paused`,
          "feedback",
        );
      }
      return;
    }
    if (r.status === "short") {
      // OUR side ran dry after the order was accepted (a drained yard, or
      // re-derived terms outgrew the stock) — paused visibly, once per edge.
      if (r.newlySuspended) {
        presenter.toast(`⏸ caravan to ${r.partnerKey} waits — not enough in the yard`, "feedback");
      }
      return;
    }
    if (r.status === "resumed") {
      presenter.toast(`▶ trade with ${r.partnerKey} resumed`, "feedback");
    }
    presenter.toast(
      `🐴 caravan from ${r.partnerKey}: ${fmt(r.sent)} → ${fmt(r.received)}`,
      "feedback",
    );
    spawnBarterCaravan(session);
  }

  /** The VISIBLE shipment: a mounted carrier walks the trade road in to OUR
   *  depot, dwells, and leaves the way it came (the daily-caravan geometry —
   *  the ephemeral body rides the same route polyline). Deterministic id;
   *  cosmetic where it must be (no route/world ⇒ the toast already told). */
  function spawnBarterCaravan(session: QuestSession) {
    const tr = session.town?.stage.trade;
    if (!world || !tr || tr.route.route.length < 2) return;
    const id = `barter_caravan_${session.caravanSerial++}`;
    const gate = tr.route.route[0]!;
    const inbound = tr.route.route.slice(1);
    const back = tr.route.route.slice(0, -1).reverse();
    session.npcIcons.set(id, "🐴");
    world.addNpc({
      id,
      x: gate.x,
      y: gate.y,
      behavior: {
        movement: "wander",
        conversationRadius: 0,
        wanderRadius: 0,
        home: { x: gate.x, y: gate.y },
        speed: 3.2,
      },
    });
    const dwell = 8;
    const points = [
      ...inbound.map((p, i) => (i === inbound.length - 1 ? { ...p, dwell } : { ...p })),
      ...back,
    ];
    enqueueNpcErrand(session, id, {
      points,
      onArrive: (i) => {
        if (i === points.length - 1) {
          world?.removeNpc(id);
          session.npcIcons.delete(id);
        }
      },
    });
  }

  /**
   * NEED-STEERED AUTO-FOUNDING (③ + city-founding), once per credited
   * town day: URGENT need (homeless souls, real shortage) founds at once;
   * otherwise the town banks prosperity off the SAME household signals
   * the annex accumulator reads and a banked threshold founds the
   * most-needed admitted structure (zoning.ts foundingGrowthStep —
   * deterministic: need-ranked, capacity/cap/stock-gated, no RNG).
   * Charters CONSTRAIN candidates when present; with none, need builds
   * on open street-tree ground. The commit is the player-order path:
   * yard stock spent, founded delta written, plan row appended (the
   * stage scaffolds it), the completion sweep + roster do the rest.
   */
  function stepZonedFounding(session: QuestSession, day: number) {
    const t = session.town;
    const ctx = buildContext(session);
    if (!t || !ctx) return;
    // The day's town gain: the MEAN household gain (each capped like the
    // annex accrual), so town growth paces with how the households live.
    let gainSum = 0;
    for (const h of t.plan.houses) {
      gainSum += Math.min(
        PROSPERITY_DAILY_CAP,
        Math.max(0, prosperitySignals(session, h.index).reduce((s, sig) => s + sig.value, 0)),
      );
    }
    // FOUNDING LABOR (city-founding): a settlement with people but no
    // households yet still works — the camp accrues at the daily cap, so
    // a founding town's non-urgent wants (a workshop after the farm)
    // eventually fund themselves without a single house standing.
    const gain = t.plan.houses.length
      ? gainSum / t.plan.houses.length
      : t.town.scalar("population") > 0
        ? FOUNDING_PROSPERITY_DAILY_CAP
        : 0;
    // House-role types (the crowding denominator counts BOTH base houses
    // and founded house-role works; a VACATED row already counts as its
    // plan.houses household — never twice).
    const houseTypes = new Set(ctx.catalog.filter((s) => s.role === "house").map((s) => s.type));
    const houseCount =
      t.plan.houses.length + t.plan.works.filter((w) => !w.vacated && houseTypes.has(w.type)).length;
    // ④ the crowding numerator reads STREET souls too — tracked households
    // plus the pooled cohort population (a crowded district wants houses
    // even when its residents aren't individually tracked). The aggregate
    // scalar stays the floor: established towns' books already carry it.
    const streetPop =
      t.plan.houses.filter((h) => !session.pooledHouses.has(h.index)).length * HOUSEHOLD +
      cohortPopulation(t.deltas.cohorts);
    const pop = Math.max(t.town.scalar("population"), streetPop);
    const order = foundingGrowthStep({
      deltas: ctx.deltas,
      catalog: ctx.catalog,
      gain,
      day,
      signals: {
        crowding: houseCount > 0 ? Math.min(2, pop / (houseCount * HOUSEHOLD)) : pop > 0 ? 2 : 0,
        shortage: (good) => townShortage(session, good),
      },
      economyOf: (k) => {
        const w = t.eco.works.find((x) => x.key === k);
        return w ? { cap: w.cap, sells: w.sells ?? [], district: w.district } : null;
      },
      capValueOf: (by) => t.town.scalar(by),
      countOf: (type) =>
        t.plan.works.filter((w) => w.type === type && !w.vacated).length +
        (houseTypes.has(type) ? t.plan.houses.length : 0),
      candidatesFor: (spec, zone) =>
        zone === null
          ? buildCandidates(ctx, spec)
          : buildCandidates(ctx, spec).filter((c) => candidateInZone(ctx.zones, zone, c)),
    });
    if (!order) return;
    // The player-order commit's visible half: the plan row the stage
    // reconciles (staff arrives at completion — the ①b sweep).
    t.plan.works.push({
      type: order.spec.type,
      dx: order.building.dx, dy: order.building.dy,
      w: order.building.w, h: order.building.h, door: order.building.door,
      color: order.spec.color,
      program: order.spec.program,
      ...(order.spec.stations ? { stations: order.spec.stations } : {}),
      jobs: 0,
      foundedOrd: order.building.ord,
    });
    const zoneName =
      order.zoneOrd >= 0
        ? ctx.deltas.zones().find((z) => z.ord === order.zoneOrd)?.category ?? "zoned"
        : null;
    presenter.toast(
      zoneName
        ? `🏗️ the town raises a ${order.spec.label} in the ${zoneName} zone`
        : `🏗️ the people raise a ${order.spec.label}`,
      "feedback",
    );
  }

  /** Contextual CIVIC BOARD options (①b board surface + ③ zoning): the
   *  buildable structures whose costs are met right now, then the ZONE
   *  words (every catalog category + "clear"), pushed while nothing else
   *  owns the board. Diff-gated; pressing one speaks the sentence. */
  function pushCivicBuildBoard(session: QuestSession) {
    const idle = !convo && !choice && !container;
    const ctx = idle ? buildContext(session) : null;
    const affordable = ctx ? ctx.catalog.filter((s) => costsMet(s, ctx.stock)) : [];
    // ZONE options (③): the catalog's speakable categories — chartering
    // needs no materials, so they ride whenever the session can build at
    // all (a town or a founded site).
    const zonable = ctx ? ctx.catalog : [];
    // TRADE options (⑤): with a partner on the road, the goods we can
    // actually cover AND the partner would actually take (the same
    // willingness gate the order runs) surface as one press each. Kept
    // small — the board is engine chrome, not a market screen.
    const tradeable: string[] = [];
    if (ctx) {
      const partners = tradePartnersOf(session);
      const partner = partners[0];
      if (partner) {
        const us = ourBarterSignals(session);
        const goodsAll = tradeGoodsOf(session);
        for (const g of goodsAll) {
          if (tradeable.length >= 3) break;
          if (stackUnits(ctx.stock, g) < 1) continue;
          const take = defaultTakeGood(goodsAll, g, us);
          if (!take || take === g) continue;
          if (!barterWillingness(g, take, us, partner.signals).ok) continue;
          tradeable.push(g);
        }
      }
    }
    const sig = ctx && (affordable.length || zonable.length || tradeable.length)
      ? `${affordable.map((s) => s.type).join("|")}//${zonable.map((s) => s.type).join("|")}//${tradeable.join("|")}`
      : "";
    if (sig === session.civicSig) return;
    const hadCivic = session.civicSig !== "";
    session.civicSig = sig;
    if (!sig) {
      if (idle && hadCivic) presenter.clearBoard();
      return;
    }
    const locale = session.game.meta.locale ?? "en";
    presenter.board({
      kind: "choice",
      nodeId: "__civic__",
      posedByEntityId: "__town__",
      prompt: "build",
      promptText: translateGlyph("build", locale),
      options: [
        // `glyph` renders the structure inside its container FRAME
        // (`building(farm)`); `spokenText` keeps the bare word, since the
        // frame is a visual motif and not part of the sentence.
        ...affordable.map((s) => ({
          id: `build:${s.type}`,
          label: s.label,
          glyph: `build + ${structureDisplayGlyph(s)}`,
          spokenText: translateGlyph(`build + ${s.glyph}`, locale),
        })),
        ...zonable.map((s) => ({
          id: `area:${s.type}`,
          label: `area ${s.label}`,
          glyph: `area + ${structureDisplayGlyph(s)}`,
          spokenText: translateGlyph(`area + ${s.glyph}`, locale),
        })),
        ...(zonable.length
          ? [{
              id: "area:none",
              label: "clear area",
              glyph: "area + none",
              spokenText: translateGlyph("area + none", locale),
            }]
          : []),
        ...tradeable.map((g) => ({
          id: `trade:${g}`,
          label: `trade ${g}`,
          glyph: `trade + ${g}`,
          spokenText: translateGlyph(`trade + ${g}`, locale),
        })),
      ],
    });
  }

  // ── POPULATION TIERS (city-expansion ④): move-in, cohorts, city HUD ───────
  // Kernel machinery in kernel/town/population.ts (pure, serialized in
  // TownDeltas); this block is the host wiring — signals in, mutations +
  // presenter pushes out. Below the tracked cap every step here no-ops:
  // the small village stays byte-identical.

  /** The tracked-resident cap this session runs under. */
  function trackedCapOf(session: QuestSession): number {
    return session.town?.config.trackedResidents ?? TRACKED_RESIDENTS_DEFAULT;
  }

  /** A commodity's CITY-WIDE shortage off the live books (③'s signal —
   *  1 − got/need, clamped). 0 off a town session or an unknown good. */
  function townShortage(session: QuestSession, good: string): number {
    const t = session.town;
    if (!t) return 0;
    const fill = t.eco.fills.find((f) => f.good === good);
    if (!fill) return 0;
    const need = t.town.scalar(fill.need);
    if (need <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - t.town.scalar(fill.got) / need));
  }

  /** Souls a household counts (HOUSEHOLD minus a mode-"all" family's
   *  never-generated members). */
  function membersOfHouse(session: QuestSession, houseIndex: number): number {
    return HOUSEHOLD - (familyExcludedMembers(session, houseIndex)?.size ?? 0);
  }

  /** The district governing a house (its footprint center, town-local). */
  function houseDistrictOf(session: QuestSession, h: TownHouse): number {
    return districtOfPoint(session.town!.deltas.zones(), h.dx + h.w / 2, h.dy + h.h / 2);
  }

  /** A district's world-space anchor: the charter disc (walk-to point +
   *  walker spread), the town center for the default district. */
  function districtAnchorWorld(
    session: QuestSession,
    district: number,
  ): { x: number; y: number; r: number } {
    const t = session.town!;
    const z =
      district === DEFAULT_DISTRICT ? undefined : t.deltas.zones().find((c) => c.ord === district);
    if (z) return { x: t.stage.center.x + z.x, y: t.stage.center.y + z.y, r: Math.max(8, z.r) };
    return { x: t.stage.center.x, y: t.stage.center.y, r: Math.max(20, t.plan.radius * 0.5) };
  }

  /** Houses whose members are IN FLIGHT — party, live needs, queued
   *  commands, an executing haul, the possessed body. Demotion never
   *  touches these (in-flight state stays tracked, never folded). */
  function busyResidentHouses(session: QuestSession): Set<number> {
    const out = new Set<number>();
    const note = (cid: string | undefined) => {
      if (cid?.startsWith("resident_")) out.add(Number(cid.split("_")[1]));
    };
    for (const cid of session.party) note(cid);
    for (const cid of session.liveNeedBodies) note(cid);
    for (const [bodyId, queue] of session.npcTasks) {
      if (queue.length > 0) note(bodyId);
    }
    for (const a of session.transfers.active()) note(a.executor);
    note(possession.creatureId ?? undefined);
    return out;
  }

  /** A tracked house's wellbeing for the HUD: stress-derived where the
   *  live loop has state, the content default otherwise. */
  function trackedHouseWellbeing(session: QuestSession, houseIndex: number): number {
    let sum = 0;
    let n = 0;
    for (let m = 0; m < HOUSEHOLD; m++) {
      const s = session.stress.get(`resident_${houseIndex}_${m}`);
      if (s === undefined) continue;
      sum += Math.max(0, Math.min(1, 0.9 - s * 0.7));
      n++;
    }
    return n ? sum / n : 0.75;
  }

  /**
   * MOVE-IN (④ scope 1), once per credited town day: the kernel rule
   * (population.ts moveInStep — food not scarce admits the oldest finished
   * empty house; famine turns newcomers away) writes the serialized
   * HOUSEHOLD fact, and this host materializes it LIVE: the founded row's
   * work row is VACATED in place (works indices are load-bearing) and a
   * real plan.houses row appends — the stage stands the same walls as a
   * HOME, the resident model streams the household in, the roster
   * re-deals. Rebuilds materialize the same house through
   * applyFoundedBuildings (one shape: foundedHouseRow).
   */
  function stepTownMoveIn(session: QuestSession) {
    const t = session.town;
    if (!t) return;
    const admitted = moveInStep({
      deltas: t.deltas,
      catalog: structureCatalogOf(session),
      signals: { crowding: 0, shortage: (g) => townShortage(session, g) },
    });
    if (!admitted) return;
    const spec = resolveStructure(structureCatalogOf(session), admitted.type);
    if (!spec) return;
    const wi = t.plan.works.findIndex((w) => w.foundedOrd === admitted.ord);
    if (wi >= 0) t.plan.works[wi]!.vacated = true;
    t.plan.houses.push(foundedHouseRow(t.plan, admitted, spec));
    townJobsMemo = null; // the roster re-deals around the new household
    presenter.toast(`🏠 a family moves into the new ${spec.label}`, "feedback");
  }

  /** Per-district rates off the SAME street books individuals project
   *  (goods.ts): production = the district's producers' dawn-cart daily
   *  units × the pool's share of the district's souls; consumption = the
   *  street per-capita daily; the cap = a district pantry norm. */
  function cohortDistrictRates(
    session: QuestSession,
    district: number,
    pooledPop: number,
  ): CohortRates {
    const t = session.town!;
    const zones = t.deltas.zones();
    let trackedInDistrict = 0;
    for (const h of t.plan.houses) {
      if (session.pooledHouses.has(h.index)) continue;
      if (districtOfPoint(zones, h.dx + h.w / 2, h.dy + h.h / 2) !== district) continue;
      trackedInDistrict += membersOfHouse(session, h.index);
    }
    const share = pooledPop / Math.max(1, pooledPop + trackedInDistrict);
    const production: Record<string, number> = {};
    const perCapita: Record<string, number> = {};
    const stackCap: Record<string, number> = {};
    for (const g of t.stage.goods) {
      const key = g.good.key;
      perCapita[key] = g.good.perCapitaDaily;
      stackCap[key] = Math.max(1, pooledPop * g.good.capDays * g.good.perCapitaDaily * 2);
      for (const wIdx of g.producerWorks()) {
        const wk = t.plan.works[wIdx]!;
        if (wk.vacated) continue;
        if (districtOfPoint(zones, wk.dx + wk.w / 2, wk.dy + wk.h / 2) !== district) continue;
        production[key] = (production[key] ?? 0) + g.good.cartRations * share;
      }
    }
    return { production, perCapita, stackCap };
  }

  /** COHORT RATES (④), once per credited town day: every pool integrates
   *  to today. Idle-safe — a pool that slept N days catches up in one
   *  closed step (no per-day loop, no RNG). */
  function stepCohortDay(session: QuestSession, day: number) {
    const t = session.town;
    if (!t) return;
    for (const row of t.deltas.cohorts) {
      cohortRatesStep(row, day, cohortDistrictRates(session, row.district, row.pop));
    }
  }

  /** DEMOTE one household into its district pool: members join the
   *  statistic, their CARRIED stacks fold into the pool inventory (the
   *  house pantry stays with the standing building), their live-loop
   *  state clears. Conserving — see population.ts. */
  function demoteHouse(session: QuestSession, houseIndex: number) {
    const t = session.town;
    if (!t || session.pooledHouses.has(houseIndex)) return;
    const h = t.plan.houses.find((x) => x.index === houseIndex);
    if (!h) return;
    const carried: Record<string, number> = {};
    let stressSum = 0;
    for (let m = 0; m < HOUSEHOLD; m++) {
      const cid = `resident_${houseIndex}_${m}`;
      const hand = session.needCarried.get(cid);
      if (hand) {
        for (const [g, n] of Object.entries(hand)) {
          if (n > 0) carried[g] = (carried[g] ?? 0) + n;
        }
        session.needCarried.delete(cid);
      }
      stressSum += session.stress.get(cid) ?? 0;
      session.needStep.delete(cid);
      session.liveNeedBodies.delete(cid);
      session.npcTasks.delete(avatarIdOf(cid));
    }
    const wellbeing = Math.max(0.2, Math.min(0.9, 0.75 - (stressSum / HOUSEHOLD) * 0.5));
    demoteHousehold(
      t.deltas.cohorts,
      houseDistrictOf(session, h),
      { index: houseIndex, members: membersOfHouse(session, houseIndex) },
      carried,
      wellbeing,
      session.townClock / FOOD_DAY_SEC,
    );
    session.pooledHouses.add(houseIndex);
  }

  /** PROMOTE one household back to the tracked tier — exactly the pooled
   *  members return; the resident model streams them in on its own rules
   *  (through doors and view edges, never a visible pop). */
  function promoteHouse(session: QuestSession, houseIndex: number) {
    const t = session.town;
    if (!t) return;
    if (!promoteHousehold(t.deltas.cohorts, houseIndex)) return;
    session.pooledHouses.delete(houseIndex);
  }

  /**
   * THE TIER SWEEP (④), every COHORT_SWEEP_S: score every house by what
   * the player can see and reach (−distance to the walker/spirit; the
   * family, the dollhouse, watched interiors, quest-cast homes and busy
   * members are PINNED), and let the kernel planner pick AT MOST ONE
   * hysteretic transition (population.ts planCohortTransition — the swap
   * margin is the no-flap band). Below the cap with no pools this whole
   * sweep is a single early return: the village stays byte-identical.
   */
  const COHORT_SWEEP_S = 2;
  let cohortSweepT = 0;
  function stepCohortTier(session: QuestSession, dt: number, shown: (hi: number) => boolean) {
    const t = session.town;
    if (!t) return;
    cohortSweepT += dt;
    if (cohortSweepT < COHORT_SWEEP_S) return;
    cohortSweepT = 0;
    const cap = trackedCapOf(session);
    // DORMANCY FAST PATH: nothing pooled and the town fits — do nothing.
    if (
      session.pooledHouses.size === 0 &&
      t.plan.houses.reduce((s, h) => s + membersOfHouse(session, h.index), 0) <= cap
    ) {
      return;
    }
    const fam = familyOf(session);
    const focus = playerWorldPos(session) ?? session.spiritPos ?? t.stage.center;
    const busy = busyResidentHouses(session);
    const castHouses = new Set<number>();
    for (const entry of t.bundle.cast) {
      if (entry.role === "wanter" && entry.house !== undefined) castHouses.add(entry.house);
    }
    const candidates: CohortHouseCandidate[] = t.plan.houses.map((h) => {
      const door = houseDoorstep(t.stage.center, h);
      return {
        index: h.index,
        members: membersOfHouse(session, h.index),
        score: -Math.hypot(door.x - focus.x, door.y - focus.y),
        pinned:
          h.index === fam?.house ||
          h.index === session.dollhouse ||
          shown(h.index) ||
          busy.has(h.index) ||
          castHouses.has(h.index),
        pooled: session.pooledHouses.has(h.index),
      };
    });
    const plan = planCohortTransition(cap, candidates);
    if (plan?.kind === "demote") demoteHouse(session, plan.index);
    else if (plan?.kind === "promote") promoteHouse(session, plan.index);
    else if (plan?.kind === "swap") {
      demoteHouse(session, plan.demote);
      promoteHouse(session, plan.promote);
    }
    pushCityHud(session);
  }

  /** SAMPLED DISTRICT LIFE (④): a few wandering bodies per pooled
   *  district — hashed off (seed, day, district), spawned outside the
   *  camera's reach, purely cosmetic (no economy effect, no dialogue). */
  const cohortWalkerLive = new Set<string>();
  function stepCohortWalkers(session: QuestSession) {
    const t = session.town;
    if (!t || !world) return;
    const me = playerWorldPos(session) ?? session.spiritPos;
    if (!me) return;
    const day = Math.floor(session.townClock / FOOD_DAY_SEC);
    const want = new Map<string, { x: number; y: number }>();
    for (const row of t.deltas.cohorts) {
      if (row.pop <= 0) continue;
      const anchor = districtAnchorWorld(session, row.district);
      const spots = cohortWalkerSpots(
        t.config.seed, day, row.district, anchor, cohortWalkerCount(row.pop),
      );
      spots.forEach((s, k) => {
        if (Math.hypot(s.x - me.x, s.y - me.y) < 240) want.set(`cohort_${row.district}_${k}`, s);
      });
    }
    for (const id of [...cohortWalkerLive]) {
      if (want.has(id)) continue;
      world.removeNpc(id);
      cohortWalkerLive.delete(id);
      session.npcIcons.delete(id);
    }
    for (const [id, s] of want) {
      if (cohortWalkerLive.has(id)) continue;
      // Never materialize inside the camera's reach (the 120 m the stage
      // passes as visibleR) — walkers enter the world off-screen only.
      if (Math.hypot(s.x - me.x, s.y - me.y) < 130) continue;
      cohortWalkerLive.add(id);
      session.npcIcons.set(id, "🙂");
      world.addNpc({
        id,
        x: s.x,
        y: s.y,
        behavior: {
          movement: "wander",
          conversationRadius: 0,
          wanderRadius: 8,
          home: s,
          speed: ERRAND_WALK,
        },
      });
    }
  }

  /** Push the CITY HUD chips when they changed (city-hud.ts assembles;
   *  the presenter renders). Locked (under the cap, no pools) pushes the
   *  EMPTY list once — the chips leave the screen with the condition. */
  function pushCityHud(session: QuestSession) {
    if (!presenter.city) return;
    const t = session.town;
    if (!t) return;
    const zones = t.deltas.zones();
    const view = cityHudView({
      cap: trackedCapOf(session),
      tracked: t.plan.houses
        .filter((h) => !session.pooledHouses.has(h.index))
        .map((h) => ({
          index: h.index,
          members: membersOfHouse(session, h.index),
          district: houseDistrictOf(session, h),
          wellbeing: trackedHouseWellbeing(session, h.index),
        })),
      cohorts: t.deltas.cohorts,
      categoryOf: (d) => zones.find((z) => z.ord === d)?.category ?? null,
      townGlyph: "🏘️",
      goods: t.stage.goods.map((g) => ({
        glyph: g.good.key,
        shortage: townShortage(session, g.good.key),
      })),
      yardStock: t.deltas.stock,
    });
    const chips = view ? [...view.districts, view.city] : [];
    const sig = JSON.stringify(chips);
    if (sig === session.citySig) return;
    session.citySig = sig;
    presenter.city(chips);
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
      // CIVIC BUILD option (①b board surface): pressing "build <structure>"
      // speaks the sentence and runs the same order path speak() would.
      if (id.startsWith("build:") && sess) {
        const s = sess;
        const type = id.slice(6);
        const glyph = `build + ${type}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        const explicitBuilder =
          possession.creatureId ?? s.addressedFamily ?? gazeCreature(s) ?? null;
        if (!orderBuild(s, type, glyph, explicitBuilder)) {
          saySystem(s, CANT_HERE, `💬 "${glyph}" — can't build here`);
        }
        return;
      }
      // CIVIC TRADE option (⑤): pressing "trade <good>" speaks the sentence
      // and runs the same order path speak() would — the take-good defaults
      // to the town's worst shortage and the clerk SAYS THE TERMS back.
      if (id.startsWith("trade:") && sess) {
        const s = sess;
        const good = id.slice(6);
        const glyph = `trade + ${good}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        if (!orderTrade(s, { kind: "trade", give: good, take: null, partner: null }, undefined, glyph)) {
          saySystem(s, CANT_HERE, `💬 "${glyph}" — no one to trade with here`);
        }
        return;
      }
      // CIVIC AREA option (③): pressing "area <category>" (or "area none")
      // speaks the sentence and charters the focus circle, exactly as the
      // spoken order would.
      if (id.startsWith("area:") && sess) {
        const s = sess;
        const word = id.slice(5);
        const glyph = word === "none" ? "area + none" : `area + ${word}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        if (!orderZone(s, word === "none" ? null : word, glyph)) {
          saySystem(s, CANT_HERE, `💬 "${glyph}" — can't designate an area here`);
        }
        return;
      }
      // SOFT CONTROL Phase 3: pressing a surfaced OBJECT word draws the family's
      // attention to that specific thing (and says the word aloud — AAC). A
      // deliberate, focus-free selection.
      if (id.startsWith("attend:") && sess) {
        const objId = id.slice(7);
        const said = playerStatement(objectWord(sess, objId));
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        attendObject(sess, objId);
        if (container && container.objId === objId) closeContainer(); // acted on the open box
        return;
      }
      if (container && id.startsWith("take:")) {
        if (!sess) return;
        // The DOLLHOUSE SPIRIT's container view is READ-ONLY — a formless
        // observer can't reach in. Pressing a stack NAMES it aloud, and (soft
        // control, attention-spark.md) SIGNALS the engaged creature — the one you
        // just conversed with — to go use that item; else the nearest idle body
        // present. Moving things is still the family's job, not the spirit's.
        if (spirit && sess.dollhouse !== null) {
          const glyph = id.slice(5);
          const said = playerStatement(glyph);
          if (opts.spokenExternally) yieldToStatement(said);
          else speakPlayerStatement(said);
          const motive = glyphMotive(glyph);
          const box = world?.state.objects[container.objId];
          if (motive && box) {
            const engaged = sess.sparkFocus;
            const cid =
              engaged && engaged.strength >= ENGAGE_MIN && idleForDirect(sess, engaged.cid)
                ? engaged.cid
                : nearestIdleGroupCreature(sess, world!.state, box, ATTEND_REACH_M);
            if (cid) useItemMotive(sess, cid, { x: box.x, y: box.y }, motive);
          }
          return;
        }
        takeFromContainer(sess, id.slice(5)); // id.slice(5) = the glyph stack
        return;
      }
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
      if (container) closeContainer();
      else if (convo) closeCreatureConvo();
      else if (choice) dispatchInput({ type: "cancel-choice", nodeId: choice.nodeId });
    },
    selectPocket(glyph) {
      const s = sess;
      if (!s || !s.pocket[glyph]) return;
      // In conversation, selecting a stack PRESENTS one (an offer) to the listener.
      if (convo) {
        s.selectedPocketGlyph = glyph;
        presentSelected(s);
        return;
      }
      // Otherwise toggle it as the armed stack for the gaze drop / put placement.
      s.selectedPocketGlyph = s.selectedPocketGlyph === glyph ? null : glyph;
      dropDwell.reset();
      pushPocket(s);
    },
    selectFamilyMember(id) {
      const s = sess;
      if (!s) return;
      // Chips address the dollhouse household — or the FOUNDING GROUP
      // (city-founding ②), which has no dollhouse yet.
      if (s.dollhouse === null && !settlersOf(s).length) return;
      s.addressedFamily = s.addressedFamily === id ? null : id;
      pushFamilyHud(s, true);
    },
    speak(sentence, opts = {}) {
      const s = sess;
      if (!s || !world) return;
      // VOICE THE STUDENT'S OWN SENTENCE FIRST — a statement composed on the
      // sentence builder is SPOKEN, exactly as a board press is in `select`,
      // through the same symbols-to-sentence parser the creatures speak
      // through (`playerStatement` → translateGlyph). Saying it out loud is
      // the point of the builder; the world reacting is the consequence.
      // An embedding AAC frame that already voiced it passes
      // `spokenExternally` and we hold our replies back instead.
      {
        const said = playerStatement(sentence);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
      }
      // The household NAME BOOK (family, pets, species words) — built up front:
      // the PARSER's classifier needs it (animacy: "mara + give + apple" makes
      // Mara the agent) and the binder resolves through it below.
      const byName = nameBook(s);
      const frame = parseSentence(sentence, { classifyEntity: (sym) => classifySpokenNoun(s, byName, sym) });

      // IN A CONVERSATION: a conversational move (request / where / hi / yes / no /
      // bye) is a DIALOGUE turn — the creature replies through the same path a board
      // press takes. Commands aren't conversational (intentToAct → null) and fall
      // through to the party/goal layer below.
      if (convo && s.creatures) {
        const node = s.creatures.nodeByCreature.get(convo.nodeId);
        const act = intentToAct(frame, s.creatures.world, PLAYER_CREATURE_ID, convo.nodeId, creatureProjectionOpts(s, node?.announce));
        if (act) {
          runCreatureAct(act);
          return;
        }
      }

      // The addressed creature: an explicitly SELECTED family chip wins (a
      // stable eyegaze target — deliberate beats incidental), then whom you're
      // LOOKING at, else in conversation, else — POSSESSED — the player's own
      // avatar creature (you can always talk to the body you ride), else nearest.
      const target =
        s.addressedFamily ?? gazeCreature(s) ?? convo?.nodeId ?? possession.creatureId ?? nearestCreature(s);
      // "there" → the ground point the player is looking at ("you go there").
      const look = world.getGaze?.().committedWorld ?? null;
      const gazePlace = look ? ({ kind: "point", x: look.x, y: look.y } as const) : null;
      // NAMES bind: a spoken family member's NAME ("Mara + eat", "give + apple
      // + to + Mara") resolves to its creature — wrapped over the default
      // binder so every subject/recipient slot understands the household.
      const binder = defaultBinder({
        player: PLAYER_CREATURE_ID,
        listener: target ?? PLAYER_CREATURE_ID,
        gazePlace,
      });
      if (byName.size) {
        const inner = binder.creature.bind(binder);
        binder.creature = (ref) => {
          if (ref?.kind === "entity") {
            const hit = byName.get(ref.symbol.toLowerCase());
            if (hit) return hit;
          }
          return inner(ref);
        };
      }
      // A spoken PLACE or ITEM is never a creature (②): the default binder
      // reads any bare symbol as a creature id, which would make "bring wood
      // to yard" a gift to a creature called "yard" and "take apple from
      // refrigerator" a take from a creature's hands. Places and item kinds
      // bind through the PLACE channel instead ("give X to <place>" compiles
      // to a putIn; a from-source resolves to the object's spot). Household
      // NAMES keep priority (classify says "creature" for them); unknown
      // symbols stay creatures (wilderness species words).
      {
        const innerCreature = binder.creature.bind(binder);
        binder.creature = (ref) => {
          if (ref?.kind === "entity") {
            const cls = classifySpokenNoun(s, byName, ref.symbol);
            if (cls === "place" || cls === "item") return null;
          }
          return innerCreature(ref);
        };
      }
      // A spoken HOUSE is a PLACE (②): "house.red" names the coloured house
      // (the directions vocabulary), bare "house" the nearest OTHER house —
      // so "bring wood to house" reads as a house-endpoint destination.
      if (s.town) {
        const innerPlace = binder.place.bind(binder);
        binder.place = (ref) => {
          if (ref?.kind === "entity" && ref.symbol === "house") {
            const hi = houseBySpoken(s, ref.modifiers);
            if (hi !== null) return { kind: "named", id: `house:${hi}` };
          }
          return innerPlace(ref);
        };
      }
      // Furniture kinds compile "put" to a PLACEMENT, not containment
      // (construction v1) — "put chair near table" places a piece; "put
      // apple in box" stays the classic putIn.
      binder.isFurniture = (ref) =>
        ref?.kind === "entity" && FURNITURE_ITEMS.some((f) => f.kind === ref.symbol);
      // A lidded CONTAINER kind — "open the chest" opens its physical LID (the
      // setOpen primitive) rather than a device toggle (a window).
      binder.isContainer = (ref) => ref?.kind === "entity" && OPENABLE_CONTAINER_WORDS.has(ref.symbol);
      // A CLOTHING kind — "wear the shirt" equips that garment (the wear
      // primitive); a non-garment "wear" falls through to the dress self-care.
      binder.isClothing = (ref) => ref?.kind === "entity" && propertiesOf(ref.symbol).includes("clothing");
      // A DEVICE kind — "stop the {device}" turns the active thing OFF
      // instead of halting the listener (semantic-gaps.md §Commands).
      binder.isDevice = (ref) => ref?.kind === "entity" && propertiesOf(ref.symbol).includes("device");
      const compiled = compileIntent(frame, binder, { id: `say_${speakSeq++}` });

      // ── THE LAW GATE (nations P2, behavior/laws.ts) ─────────────────────
      // A command (or standing rule) whose verb the law forbids HERE is
      // refused with the law NAMED — "we do not fight" — never confusion,
      // never execution. Runs on the FRAME verb so even verbs with no
      // GoalSpec yet (fight) land on the refusal, not on not-understood.
      if ((frame.kind === "command" || frame.kind === "rule") && frame.verb) {
        // Judged at the COMMANDED actor's body — a district law binds the
        // one standing in the district.
        const law = governingLaw(lawsInForce(s), frame.verb, lawAreaTest(s, target ?? null));
        if (law) {
          const line = tabooRefusalLine(frame.verb)[s.game.meta.syntax ?? "b"];
          if (target && s.creatures?.nodeByCreature.has(target)) {
            npcChatBubble(s, target, line);
          } else {
            presenter.toast(`💬 ${npcStatement(line)}`, "feedback");
          }
          return;
        }
      }
      // A spoken PROHIBITION ("no + fight") installs a Law: player-issued,
      // "law" tier (an authority's word — compliance nuance is P4), scoped
      // by the sentence (forbidArea: town / "area" = the district or a
      // focus disc). Settlement rows persist in the DELTAS (reload-proof);
      // townless ones live with the session.
      if (compiled.kind === "law") {
        const area = forbidArea(s, frame);
        const book = s.town?.deltas.laws ?? s.foundedSite?.deltas.laws ?? s.laws;
        addLaw(book, { tier: "law", forbid: compiled.forbid, area, issuer: PLAYER_CREATURE_ID });
        if (target && s.creatures?.nodeByCreature.has(target)) npcChatBubble(s, target, LAW_ACCEPTED);
        const where =
          area.kind === "town" ? " — here in town"
          : area.kind === "district" ? " — in this district"
          : area.kind === "disc" ? " — in this area" : "";
        presenter.toast(`⚖️ new law: no ${compiled.forbid}${where}`, "feedback");
        return;
      }

      if (compiled.kind === "rule") {
        s.goals?.rules.push(compiled.rule);
        presenter.toast(`📜 rule: ${sentence}`, "feedback");
        return;
      }
      if (compiled.kind === "dialogue") {
        // A CONVERSATIONAL move spoken OUTSIDE a conversation: the addressed
        // creature is the responder — open the conversation (silently: its
        // first line is the ANSWER, not a greeting) and run the move through
        // the same path a board press takes. "how are you" at a gazed creature
        // answers with its emotional state (phase ①a §1).
        if (target && s.creatures?.nodeByCreature.has(target)) {
          const node = s.creatures.nodeByCreature.get(target);
          const act = intentToAct(
            frame,
            s.creatures.world,
            PLAYER_CREATURE_ID,
            target,
            creatureProjectionOpts(s, node?.announce),
          );
          if (act) {
            openCreatureConvo(target, { present: false });
            runCreatureAct(act);
            return;
          }
        }
        speakNotUnderstood(s, target ?? null, sentence);
        return;
      }
      if (compiled.kind !== "goal") {
        // unbound / sequence — no responder caught it: the EXPLICIT terminal
        // fallback (never silence, never a misleading "okay").
        speakNotUnderstood(s, target ?? null, sentence);
        return;
      }
      const goal = compiled.goal;
      // WHO acts: the compiled actor (a named subject — "Mara + eat" — or the
      // listener), so a name beats the gaze for every command below.
      const actor = compiled.actor;

      // "you eat" / "you sleep" / "you play" / "you talk" → drive the member's
      // own need machinery (commandSatisfy): the body walks to the table/bed/
      // box/housemate and the HUD chip flips; a member who doesn't mean it
      // refuses aloud ("I'm not hungry" / "I don't want to play").
      if (goal.kind === "satisfy") {
        const member = actor.startsWith("resident_") || actor.startsWith("pet_") ? actor : null;
        if (member && commandSatisfy(s, member, goal.need)) {
          presenter.toast(`▶ ${sentence}`, "feedback");
        } else {
          // No such need on this body (a townsfolk with no dress row, a
          // stranger): the creature SAYS so instead of a silent banner.
          saySystem(s, CANT_HERE, `💬 "${sentence}" — can't do that here`, member);
        }
        return;
      }

      // "help the dog" / "you help Mara" — a standing ADOPTION order: the
      // helper serves the target's surfaced want through the general on-behalf
      // rule (residentNeedTemplates) until it clears. Command priority.
      if (goal.kind === "help") {
        const helper = actor.startsWith("resident_") ? actor : target?.startsWith("resident_") ? target : null;
        if (!helper || helper === goal.target) {
          saySystem(s, WHO_DO_YOU_MEAN, `💬 look at a family member, then "you help …"`);
          return;
        }
        s.helpOrders.set(helper, goal.target);
        s.needStep.delete(helper); // re-decide with the order in force
        s.liveNeedBodies.add(helper);
        npcChatBubble(s, helper, commandEchoLine(s, frame, goal)); // "I will help Mara" / the earned ok
        presenter.toast(`▶ ${sentence}`, "feedback");
        return;
      }

      // "put chair near table" — a directed PLACEMENT (construction v1):
      // the named/addressed resident judges the spot by the house
      // generator's own rules and answers place / can't / won't, aloud.
      if (goal.kind === "place") {
        const placer = actor.startsWith("resident_")
          ? actor
          : target?.startsWith("resident_")
            ? target
            : null;
        if (!placer) {
          saySystem(s, WHO_DO_YOU_MEAN, `💬 look at a family member, then "put …"`);
          return;
        }
        if (handlePlaceOrder(s, placer, goal)) {
          presenter.toast(`▶ ${sentence}`, "feedback");
        } else {
          saySystem(s, CANT_HERE, `💬 "${sentence}" — can't do that here`);
        }
        return;
      }

      // A hug FROM THE SPIRIT (the player is formless — no walk): warmth lands
      // directly; a member/pet actor walks over instead (compileGoal socialAct).
      if (goal.kind === "socialAct" && actor === PLAYER_CREATURE_ID) {
        applySocialAct(s, PLAYER_CREATURE_ID, goal.target, goal.act);
        presenter.toast(`▶ ${sentence}`, "feedback");
        return;
      }

      // "follow me" → the SPIRIT asks a creature to JOIN it: POSSESSION — the
      // creature becomes the player's avatar (spirit ↔ avatar switching; the
      // dollhouse keeps its family semantics and every embodied session keeps
      // the party recruit).
      if (goal.kind === "follow") {
        const joiner = actor !== PLAYER_CREATURE_ID ? actor : target;
        if (!joiner) {
          saySystem(s, WHO_DO_YOU_MEAN, `💬 look at a creature, then "you follow i_me"`);
          return;
        }
        if (spiritNow() && s.dollhouse === null) {
          const res = possession.possess(joiner);
          if (res.ok) s.bondedCreatures.add(joiner); // family bond — it volunteers for pooled tasks
          presenter.toast(
            res.ok
              ? `🫂 ${joiner} joined you — you walk as them now ("stop" to let go)`
              : `💬 can't join: ${res.reason}`,
            "feedback",
          );
          return;
        }
        joinParty(s, joiner);
        presenter.toast(`🎉 ${joiner} joined — party of ${s.party.size}`, "feedback");
        return;
      }
      // "stop" → DISMISS: the possessed avatar first (back to the spirit),
      // else the addressed/named member, else the whole party.
      if (goal.kind === "stay") {
        const stopper = actor !== PLAYER_CREATURE_ID ? actor : target;
        if (possession.creatureId && (!stopper || stopper === possession.creatureId)) {
          const prev = possession.creatureId;
          possession.dismiss();
          presenter.toast(`👻 ${prev} stays — you are the spirit again`, "feedback");
          return;
        }
        const leaving = stopper && s.party.has(stopper) ? [stopper] : [...s.party];
        leaving.forEach((c) => leaveParty(s, c));
        presenter.toast(leaving.length ? `✋ dismissed ${leaving.length}` : `✋ (no party)`, "feedback");
        return;
      }
      // "area farm(s) here" → an AREA CHARTER (③): the focus circle is the
      // brush; the charter lands in the deltas and the ground tints. "area
      // none" clears. Host-instant — no creature walks anywhere.
      if (goal.kind === "area") {
        if (orderZone(s, goal.category, sentence)) return;
        saySystem(s, CANT_HERE, `💬 "${sentence}" — can't designate an area here`);
        return;
      }
      // "trade wood with the city" → INTERCITY BARTER (⑤): the clerk quotes
      // the scarcity-driven terms aloud and the shipment rides the ② ledger
      // to a visible caravan. Host-instant like zone — town policy, not a
      // body errand. "trade all wood …" makes the route STANDING.
      if (goal.kind === "trade") {
        if (orderTrade(s, goal, frame.quantity, sentence)) return;
        saySystem(s, CANT_HERE, `💬 "${sentence}" — no one to trade with here`);
        return;
      }
      // "build" → FOUNDING (city-expansion step 0) or a BUILD ORDER (①b):
      // out in the wilderness a bare "build" stakes a new EMPTY site at the
      // avatar; at a founded site or in a town, "build <structure>" resolves
      // the catalog, checks stock + lot, and raises real construction —
      // targeted at the addressed creature / the possessed avatar, or
      // untargeted into the ①a task pool.
      if (goal.kind === "build") {
        if (foundNewSite(s)) {
          presenter.toast(`⛺ founded ${s.foundedSite!.key} — materials stocked`, "feedback");
          return;
        }
        // WHO builds, when someone was singled out: a named subject, the
        // ridden body, the tapped chip, the gazed/conversing creature.
        // Nobody explicit → the order pools (never "nearest grabs it").
        const explicitBuilder =
          (frame.subject !== undefined && actor !== PLAYER_CREATURE_ID ? actor : null) ??
          possession.creatureId ??
          s.addressedFamily ??
          gazeCreature(s) ??
          convo?.nodeId ??
          null;
        if (orderBuild(s, goal.structure, sentence, explicitBuilder)) return;
        saySystem(s, CANT_HERE, `💬 "${sentence}" — can't build here`);
        return;
      }
      // TRIBUTE (nations P3/E5): "bring <good> from <partner>" — a STANDING
      // pull from a member settlement's yard into ours, the sovereign's
      // decree. Same ② scheduled-agreement machinery the dawn carts run
      // (conserving, real stacks both sides); consent/terms arrive with the
      // P4 dispute machine — today the crown says so.
      if ((goal.kind === "give" || goal.kind === "putIn") && "match" in goal.item) {
        const fromBound = frame.bound?.find((b) => b.relation === "from");
        const fromWord = fromBound?.ref.kind === "entity" ? fromBound.ref.symbol : null;
        if (fromWord && orderTribute(s, goal, fromWord, frame.quantity, sentence)) return;
      }
      // A TRANSFER-SHAPED order (city-expansion ②): "give/bring <goods> to
      // <house/yard/person>", "put <goods> in <endpoint>", with quantities —
      // stock moves between REAL endpoints as an agreement + announced haul.
      // Orders this layer doesn't own (single-unit hand-overs, physical
      // drops at a spot) fall through to the shipped paths below.
      if ((goal.kind === "give" || goal.kind === "putIn") && "match" in goal.item) {
        const explicitHauler =
          (frame.subject !== undefined && actor !== PLAYER_CREATURE_ID && actor !== possession.creatureId
            ? actor
            : null) ??
          s.addressedFamily ??
          gazeCreature(s) ??
          convo?.nodeId ??
          null;
        if (orderTransfer(s, goal, orderQuantity(frame.quantity), sentence, explicitHauler)) {
          return;
        }
      }
      // Any other command drives the PARTY (that's what reliably obeys). In the
      // DOLLHOUSE, family obeys directly — the named/looked-at member takes the
      // command with no recruitment (all commands obeyed, §5.2; the compliance
      // gate stays in the code path for every other scope). No target → teach.
      // An EXPLICITLY singled-out actor — a named subject ("mara + go + home")
      // or the tapped chip — takes the command ALONE, party or not.
      const dollActor = actor.startsWith("resident_") ? actor : target?.startsWith("resident_") ? target : null;
      const dollTarget = s.dollhouse !== null && dollActor ? [dollActor] : [];
      const explicit =
        actor.startsWith("resident_") &&
        (actor === s.addressedFamily || (frame.subject !== undefined && actor !== (target ?? PLAYER_CREATURE_ID)));
      // A DELIBERATELY addressed creature (selected chip / looked-at / conversing
      // / ridden — NOT the incidental `nearestCreature` fallback) obeys a body
      // errand directly, even as a non-resident, non-party stranger: "tell
      // someone to do X" should drive that someone, not silently pool the order.
      // A truly UNADDRESSED order still falls to the task pool below.
      const addressed = s.addressedFamily ?? gazeCreature(s) ?? convo?.nodeId ?? possession.creatureId ?? null;
      const members =
        explicit ? [actor]
        : s.party.size ? [...s.party]
        : dollTarget.length ? dollTarget
        : addressed && s.creatures?.nodeByCreature.has(addressed) ? [addressed]
        : [];
      if (!members.length) {
        // UNTARGETED ORDER → the TASK POOL (phase ①a §2): the compiled goal +
        // issuer + the player's focus area at issue time. Any APPROPRIATE
        // creature inside the area may claim it (stepTaskPool); unclaimable
        // tasks expire back to the player ("no one can do that").
        const focus = playerFocusArea(s);
        const posted = focus ? postPooledTask(s, goal, PLAYER_CREATURE_ID, focus, sentence) : null;
        presenter.toast(
          posted
            ? `🪧 ${sentence} — anyone nearby may take it`
            : `💬 "${sentence}" — can't do that here`,
          "feedback",
        );
        return;
      }
      let moved = 0;
      for (const m of members) {
        // "Go home" DISMISSES a party guest — otherwise the follow loop would
        // drag it right back. Dismiss BEFORE issuing (leaveParty clears errands).
        if (goal.kind === "goHome" && s.party.has(m)) leaveParty(s, m);
        // PURSUED goals (consume, …) run the PER-TICK loop, not a baked errand:
        // install the pursuit and let stepPursuit drive it. A goal with
        // no reachable target right now speaks the honest reason ("we don't have
        // the banana") — an "eat" never escalates to shopping (that's the reach
        // boundary; concept-parser.md §10).
        if (PURSUED_GOALS.has(goal.kind)) {
          if (compileGoal(goal, m, makeGoalResolver(s))) {
            s.npcTasks.delete(avatarIdOf(m));
            s.needStep.delete(m);
            s.walk.delete(m); // drop any stale need-walk state — the pursuit starts fresh
            s.pursuits.set(m, { source: "command", goal, glyph: sentence });
            npcChatBubble(s, m, commandEchoLine(s, frame, goal)); // the echo — or the earned ok
          } else {
            saySystem(s, pursuitBlockLine(goal), `💬 "${sentence}" — can't do that here`, m);
          }
          moved++; // handled either way (obeyed or refused aloud) — never the silent toast
          continue;
        }
        const plan = compileGoal(goal, m, makeGoalResolver(s));
        if (plan) {
          s.npcTasks.delete(avatarIdOf(m)); // a command overrides the current errand
          issueGoalPlan(s, m, plan);
          npcChatBubble(s, m, commandEchoLine(s, frame, goal)); // the echo — or the earned ok
          moved++;
        }
      }
      presenter.toast(moved ? `▶ party (${moved}): ${sentence}` : `💬 "${sentence}" — can't do that here`, "feedback");
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
      world?.setPaused(p); // truly freeze the sim (dt=0), not just player steering
      feedPointer();
    },
    hoveredEntity() {
      return world?.getGaze().hover ?? null;
    },
    pickEntityAt(clientX, clientY) {
      if (!world) return null;
      const r = canvas.getBoundingClientRect();
      return world.pickAt(clientX - r.left, clientY - r.top);
    },
    debugProbe() {
      const gz = world?.getGaze();
      const c = gz?.committedWorld ?? null;
      const ptr = lastClient ? `${Math.round(lastClient.x)},${Math.round(lastClient.y)}` : "-";
      return (
        `${questView?.debugCutaway?.() ?? "view:none"} | ` +
        `sess:${spirit ? "spirit" : "walker"}${possession.creatureId ? "+poss" : ""} ` +
        `ptr:${ptr} gz:${c ? `${Math.round(c.x)},${Math.round(c.y)}` : "-"} ` +
        `hov:${gz?.hover?.id ?? "-"}`
      );
    },
    setPathDebug(on) {
      pathDebugOn = on; // remembered across reloads — buildHost re-adopts it
      pathDebug?.setEnabled(on);
      world?.setPathDebug(on); // the capture itself: no snapshots, no lines
    },
    pathDebugOn() {
      return pathDebugOn;
    },
    resize(width, height, dpr) {
      world?.resize(width, height, dpr);
    },
    step(dt, now) {
      world?.step(dt, now);
    },
    setDriveCamera(on) {
      questView?.setDriveCamera?.(on);
    },
    setSpiritFocus(frame) {
      questView?.setSpiritFocus?.(frame);
    },
    setExternalCamera(on) {
      questView?.setExternalCamera?.(on);
    },
    setInteriorReveal(on) {
      questView?.setInteriorReveal?.(on);
    },
    setExternalCursor(on) {
      questView?.setExternalCursor?.(on);
    },
    cursorWorld(out) {
      return questView?.externalCursorWorld?.(out) ?? null;
    },
    get camera() {
      return questView?.camera ?? null;
    },
    dollhousePose(frame, spiritAz, out) {
      questView?.dollhousePose?.(frame, spiritAz, out);
    },
    setLocalAvatarHidden(hidden) {
      questView?.setAvatarHidden?.(PLAYER_ID, hidden);
    },
    rebaseLocal(delta) {
      questView?.rebaseLocal?.(delta);
    },
    pocketSnapshot() {
      return { ...(sess?.pocket ?? {}) };
    },
    restorePocket(stacks) {
      const s = sess;
      if (!s) return;
      for (const g of Object.keys(s.pocket)) delete s.pocket[g];
      for (const [g, n] of Object.entries(stacks)) if (n > 0) s.pocket[g] = n;
      s.selectedPocketGlyph = null;
      pushPocket(s);
    },
    setSpiritPosition(x, y) {
      if (sess) sess.spiritPos = { x, y };
    },
    get possessed() {
      return possession.creatureId;
    },
    stop() {
      world?.stop();
      world = null;
      questView = null;
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
