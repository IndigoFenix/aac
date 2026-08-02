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
// The use-point contract (furniture-use.ts) is the ONE authority for how a body
// uses a fixture — the rest primitive reads it so the pose it shows and the pose
// the renderer/anchor compose can never disagree.
import { useContractFor } from "../../furniture-use.js";
// The anchor's own contact-handoff test — a use-walk's arrival is judged by the
// same contract (the arrival SPOT, never a ring around the whole piece), so the
// walk can never stop where the anchor can't reach.
import { withinEngageReach } from "./furniture-anchor.js";
import { fixtureKindForWord, fixtureWord, type FixtureKind, type ObjectSpec } from "../../types.js";
// THE SAME QUESTION THE RENDERER ASKS. A spawner that guesses whether an
// identity has a model can disagree with what render3d actually builds; asking
// the model registry itself is the only way the two can't drift (phase 5:
// wild features stop forcing a chest archetype over their own icon).
import { hasObjectModel } from "../../object-models.js";
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
import {
  FOUNDING_AGE_DAYS, PLAZA_WELL, wellVergePoint, type TownHouse,
} from "@shared/world-engine/kernel/town/plan.js";
import {
  ANNEX_ROOM_KIND,
  craftLaborDaysFor,
  FURNITURE_ITEMS,
  furnitureItemOf,
  nextCraftKind,
  STATION_PROPERTIES,
  furnitureGlyph,
  furnitureKindOfGlyph,
  workProgram,
  type FurnitureItemDef,
  type StationKind,
} from "@shared/world-engine/kernel/town/stations.js";
import {
  programOverridesOf,
  resolveRoomPrograms,
  resolveStructurePrograms,
  roomProgramMet,
  roomProgramOf,
  type RoomProgramDef,
} from "@shared/world-engine/kernel/town/programs.js";
import {
  makePlacementContext,
  placementCandidates,
  placementFeasible,
  zoneAt as placementZoneAt,
  type AnchorMode,
  type PlacementFailure,
} from "@shared/world-engine/kernel/town/placement.js";
import { houseFurniture, workFurniture, type FurniturePiece } from "@shared/world-engine/kernel/town/furniture.js";
import {
  annexOptions,
  annexWorldRect,
  bankLabor,
  constructionStep,
  demolishCheck,
  demolishRoom,
  demolishedRects,
  demolitionLaborDone,
  foundedBuildingDone,
  foundedStage,
  pendingLaborDone,
  foundingOptions,
  interiorOptions,
  isInteriorCandidate,
  markPieceSetUp,
  nextPlacedSerial,
  pendingRoomKindOf,
  placeFurniture,
  PROSPERITY_DAILY_CAP,
  requestAnnex,
  requestInterior,
  stagingMissing,
  TOWN_YARD_EP,
  workDeltaKey,
  type AnnexCandidate,
  type AnnexCluster,
  type BuildingDelta,
  type FoundedBuilding,
  type FoundingCandidate,
  type InteriorCandidate,
  type PendingAnnex,
  type PendingDemolition,
  type RoomOrder,
  type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  createReservationLedger,
  freeUnits,
  resolveMaterials,
  type ReservationLedger,
} from "@shared/world-engine/kernel/town/reservations.js";
import {
  ANNEX_ORDER,
  resolveStructureFocus,
  ROOM_GLYPH,
  structureActsOf,
  type StructureFocus,
} from "@shared/world-engine/interaction/town/structure-board.js";
import {
  resolveStructure,
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
  takeStock,
  townEndpointId,
  type StockEndpoint,
  type TransferAgreement,
  type TransferLedger,
  type TransferSource,
} from "@shared/world-engine/kernel/town/transfer.js";
import {
  craftItems,
  moveItems,
  type ResolveLocation,
} from "@shared/world-engine/kernel/town/item-move.js";
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
  type HouseRoom,
  type HouseRoomPlan,
  type HouseShape,
} from "@shared/world-engine/kernel/town/rooms.js";
import { roadDistance, roadRoute } from "@shared/world-engine/kernel/town/streets.js";
import {
  NEIGH_FOUND_MASS, WELL_FOUND_MASS, foundServicePoints,
} from "@shared/world-engine/kernel/town/districts.js";
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
import {
  armHarvestRegrow,
  buildWilderness,
  dueHarvestRegrowth,
  wildAnimalBodyId,
  wildFeatureContainerId,
  wildFeatureEmbodied,
  wildFeatureRadius,
  type WildernessContent,
  type WildernessCreature,
  type WildernessFeature,
  type WildernessParams,
  type WildSource,
} from "./wilderness.js";
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
  colorForId,
  createWorld3DView,
  defaultAvatarModelFactory,
  type AvatarModel,
  type AvatarModelFactory,
  type RenderHost,
  type SceneOverlay,
} from "../../render3d.js";
import { PathDebugOverlay3D } from "../../path-debug-3d.js";
import { AttentionDebugOverlay3D, type AttentionDebugLink } from "../../attention-debug-3d.js";
import {
  createCreatureAvatarFactory,
  getSpeciesAssets,
  type CreatureDetail,
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
import { DEFAULT_BODY_RADIUS_M, SPARK_SPECIES_ID, requireSpecies, speciesBodyRadius } from "../../creatures/species.js";
import { drinkGlyphs, naturalSourceOf, sourceKillExhausted, sourcesForGood, takeUnitsOf } from "../../products.js";
import { libraryNouns } from "@shared/world-engine/interaction/content/pools.js";
import { buildConcepts } from "@shared/world-engine/interaction/content/concepts.js";
import { propertiesOf } from "@shared/world-engine/interaction/content/properties.js";
import {
  craftRecipeOf,
  drawnMakeable,
  makeableGlyph,
  spokenMakeable,
} from "@shared/world-engine/interaction/content/makeable.js";
import { itemObjectSpec } from "@shared/world-engine/interaction/content/item-prop.js";
import {
  containerDefOfGlyph,
  mayDissolveToStack,
} from "@shared/world-engine/kernel/town/containers.js";
import {
  auditScopeTree,
  parseScopeId,
  walkScopeTree,
  type ScopeId,
  type ScopeNode,
  type ScopeTreeInput,
} from "@shared/world-engine/kernel/town/scope.js";
import { genderFor } from "@shared/world-engine/interaction/behavior/gender.js";
import { createGlyphImageSource } from "../../glyph-images.js";
import type { ImageResolver } from "@shared/glyph-compositor.js";
import { dwellBubble, dwellBubbleGlyphs, restDoneBubble } from "@shared/world-engine/interaction/quest/activity-bubble.js";
import { createDwellTracker } from "../../dwell.js";
import { runWorldHost, type WorldHost, type WorldHostNet } from "../../world-host.js";
import { claimMessage, sayMessage, type WorldCommand, type WorldNetMessage } from "../../net.js";
import { resolveAddressee } from "./addressee.js";
import type { WorldView } from "../../world-view.js";
import type { NpcErrand, NpcErrandPoint } from "../../npc-controller.js";
import {
  carryObject,
  clearWorldBubble,
  dropObject,
  expandWorldBuildings,
  faceEachOther,
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
  playRingSpot,
  standClear,
  standPointFor,
  type BodyAvoidance,
} from "./stand-points.js";
// WHAT THE GAZE AIMS AT (furniture-aim.ts — pure, extracted so tests can pin
// it): the hover IS the aim, never "whichever thing sits near the fixation",
// which used to open a chest's neighbour — and, for people, used to start a
// conversation with whoever stood near the chair you were selecting. ONE rule
// for furniture and creatures alike, so the two can never claim the same hover.
import { gazeOnCreature, resolveFurnitureAim, type FurnitureAimGaze } from "./furniture-aim.js";
import { dwellInteraction, type DwellPhase, type HoverTarget } from "./dwell-interaction.js";
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
  asIntent,
  commandEcho,
  ACTIVITY_REFUSAL,
  creatureReferenceGlyph,
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
  type GoingRoom,
  type ScheduledTrip,
  type TalkCandidate,
  pickTalkTarget,
  roomAt,
  stepActivity,
  stepDestination,
  tripDestination,
  type SyntaxLevel,
  DEFAULT_RELATION,
  decideNeed,
  decideNeeds,
  needDormDueIn,
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
  ritualPrepTemplate,
  ritualAttendTemplate,
  canGrasp,
  needPressure,
  stressStep,
  STRESS_VISIBLE,
  willingnessToJoin,
  type CompanionSpec,
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
import { probesOn } from "@shared/world-engine/perf-probes.js";
import {
  objectMotive,
  attentionActions,
  attentionBonus,
  ramp,
  decayStrength,
  SPARK,
  type AttentionMotive,
  type AttentionTargetInfo,
  type SparkDraw,
  type SparkFocus,
} from "@shared/world-engine/interaction/behavior/spark-attention.js";
import { isRtlLocale, speakDirections, speakerGender, translateGlyph, type Gender } from "@shared/world-engine/interaction/lang/index.js";
import { creditDelivery } from "@shared/world-engine/interaction/town/town-quests.js";
import { buildTownPlay, foundedHouseRow, TOWN_PLAY_STRUCTURES, type TownFamilyMember, type TownFamilyPet, type TownPlay } from "@shared/world-engine/interaction/town/town-play.js";
import {
  cohortEndpoint,
  cohortEndpointId,
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
import type { ClusterHouseCtx, ConstructionSite } from "@shared/world-engine/interaction/town/town-stage.js";
import {
  buildSpots,
  spotAt,
  type BuildSpot,
  type BuildSpotBuilding,
  type BuildSpotLot,
  type BuildSpotSite,
} from "@shared/world-engine/kernel/town/build-spots.js";
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
import { BuildOverlay3D } from "@shared/world-engine/interaction/quest/build-overlay-3d.js";
import {
  BOARD_BACK_GLYPH,
  BOARD_BACK_ID,
  BOARD_MORE_GLYPH,
  BOARD_MORE_ID,
  boardChrome,
  boardContentKey,
} from "@shared/world-engine/interaction/quest/board-chrome.js";
// THE LAW SUBSTRATE (nations P2): scoped prohibitions + the absolute ring.
import {
  absoluteLaws, addLaw, absolutelyForbidden, goalVerb, governingLaw,
  type AreaRef, type AreaTest, type Law,
} from "../behavior/laws.js";
import { resolveWorldCulture, type WorldCultureSpec } from "../../culture.js";
import {
  declareRitual,
  resolveRituals,
  ritualAnswer,
  ritualBill,
  ritualCallers,
  stepRitual,
  type RitualBody,
  type RitualCtx,
  type RitualState,
  type RitualTemplate,
} from "../behavior/rituals.js";
import { facetsOf, headOf, withVariation } from "../../variations.js";
import { LAW_ACCEPTED, noGatheringLine, tabooRefusalLine } from "../dialogue/law-lines.js";
import { DEFAULT_VOICE_POLICY } from "../dialogue/voice-policy.js";
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
// (CONVO_CANCEL_MS retired with the leave-by-looking-away dwell: a glance off the
// partner is an INSTRUCTION now, so a conversation ends on CONVO_IDLE_END_S.)
const TAP_COOLDOWN_S = 1.0;   // after a device tap-toggle, ignore re-picks this long
// TASK POOL (phase ①a §2) — untargeted orders wait here for a willing taker.
// (TASK_FOCUS_RADIUS moved to construction-director.ts — imported above.)
const TASK_CLAIM_INTERVAL_S = 1; // claim/expiry sweep cadence (claims are per-sweep deterministic)
// TRANSFERS (city-expansion ②) — the town builder's-yard crate id (its stack
// map ALIASES deltas.stock, the FoundedSite-crate pattern) and the pocket
// endpoint prefix (a creature's hands as a stock endpoint).
const TOWN_YARD_ID = TOWN_YARD_EP;
const POCKET_EP = "pocket:";
/** A town well's world-object id: the plaza's `well`, plus `well_<n>` for
 *  each NEIGHBORHOOD well the plan founded (needs-aware construction —
 *  plan.ts wells on the thirst-cycle walk radius). Same free-draw rules. */
const isWellId = (id: string): boolean => id === "well" || /^well_\d+$/.test(id);
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
import { designatedContainerId } from "@shared/world-engine/kernel/town/container-home.js";
import {
  needRate,
  restDwellS,
  constructionGameDays,
  serviceRadiusM,
  REAL_SCALE,
  type WorldScale,
} from "@shared/world-engine/scale.js";
// THE CONSTRUCTION DIRECTOR (phase 1a of the construction rewrite) — every
// construction-pipeline orchestration this host used to hold inline lives in
// construction-director.ts now (verbatim bodies; the host injects services
// via ConstructionDirectorCtx below and keeps board/speech chrome). The
// shared endpoint prefixes/tuning constants and fnv1a moved with it.
import {
  createConstructionDirector,
  fnv1a,
  TASK_FOCUS_RADIUS,
  SITE_PILE_EP,
  ANNEX_PILE_EP,
  ORDER_PILE_EP,
  BFURN_EP,
  SITE_HAUL_FOCUS_R,
  BUILD_WORK_DWELL_S,
  type BuildContext,
} from "./construction-director.js";

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
// The natural sources' drink yields (milk) join the crafted/served set.
const DRINK_GLYPHS = new Set(["water", "juice", "tea", "drink", ...drinkGlyphs()]);
const FUN_DWELL_S = 7; // seconds playing at the box before the meter clears
const WASH_DWELL_S = 6; // seconds scrubbing in the bath
const TOILET_DWELL_S = 4; // seconds at the toilet
const SIT_DWELL_S = 8; // seconds a commanded "sit" holds the chair
/**
 * THE PIECE THIS GOAL WILL POSE ON, when it will pose on one at all — the fixture
 * id for a `rest` at a NAMED station whose use-point contract is an on-fixture use
 * (a chair, a bed, a toilet: `onFixture`), else null.
 *
 * The seam exists because such a walk has a different arrival contract from every
 * other: the body does not merely need to be near its stand spot, it needs to be
 * somewhere the furniture anchor can pick it up and slide it on. A `restHere` doze
 * (`place.kind === "point"`) poses in place and names no piece; a table or chest is
 * a `reach` use the body stands beside, so neither takes the tighter contract.
 */
function onFixtureUseTargetOf(state: WorldState, goal: GoalSpec): string | null {
  if (goal.kind !== "rest" || goal.place.kind !== "named") return null;
  return onFixturePieceId(state, goal.place.id);
}
/** The same seam by bare object id — for the needs walker's steps, which carry
 *  an `objId` rather than a goal. Null when the id is not a pose-on piece. */
function onFixturePieceId(state: WorldState, objId: string | undefined | null): string | null {
  if (!objId) return null;
  const spec = state.spec.objects.find((s) => s.id === objId);
  if (!spec?.fixture) return null;
  return useContractFor(spec.fixture).onFixture ? spec.id : null;
}
/** A rest-shaped step's dwell time, by motive. Action dwells (play, scrub,
 *  toilet, cook) are animation-scale and fixed; SLEEP is the one dwell that is
 *  world physics — the scale's sleep fraction of its day. */
function restDwellFor(tplKey: string, scale: WorldScale): number {
  // ATTENDING a ritual is a SIT, not a nap: the dwell is short so the row
  // re-decides often (the meal that lands mid-wait must be able to interrupt
  // it), and the ritual's own clock — not this one — decides when the
  // gathering is over. Without the case a head would sit down for a full
  // sleep-length dwell and the dinner would go cold around it.
  if (tplKey.startsWith("attend:")) return RITUAL_SIT_S;
  if (tplKey === "fun") return FUN_DWELL_S;
  if (tplKey === "hygiene") return WASH_DWELL_S;
  if (tplKey === "waste") return TOILET_DWELL_S;
  if (tplKey === "laundry") return WASH_DWELL_S; // the scrub at the tub
  if (tplKey.startsWith("cook:")) return COOK_DWELL_S; // the pot at the oven
  return restDwellS(scale);
}
const EAT_SHOW_S = 2; // seconds the (instant) consume effect SHOWS as eating
/** A meal eaten FROM A CHAIR shows a little longer — the diner is settled, so
 *  the scene reads as sit → eat → rise rather than a bite and a bolt. */
const EAT_SIT_SHOW_S = 3.5;
/** Seconds a diner SETTLES ONTO its chair before the consume effect lands — the
 *  anchor's eased slide takes ~0.5 s, and eating must visibly happen SEATED.
 *  (The old order was arrive → eat standing → only then slide onto the seat.) */
const SIT_BEFORE_EAT_S = 1.2;
/** One turn of sitting at a ritual before the head re-decides (rituals.ts). */
const RITUAL_SIT_S = 2.5;
/** Seconds a household may NOT re-declare a ritual that just died unfed — the
 *  window in which its still-hungry heads actually get to feed themselves solo
 *  (see `ritualRetry`). Longer than a pantry walk, shorter than a mealtime. */
const RITUAL_RETRY_S = 60;
/** How near a head must be to its claimed station to count as SEATED — measured
 *  from the station's own footprint, like every other reach in this file. */
const RITUAL_SEATED_M = 1.6;
/** How far a seat's resolved stand point may sit from the seat itself before
 *  the seat counts as UNMOUNTABLE (freeSeatAt skips it). A usable seat stands
 *  its sitter on its own centre (0) or just off the covering table's edge
 *  (≤ ~0.35, the stand-point arithmetic); the blocked-face fallback answers
 *  with the table's far side (≥ ~1.4) — well past this line. */
const SEAT_MOUNT_REACH_M = 0.9;
/** Seconds a loose prop must sit on the floor before the TIDY chore may sweep
 *  it (a toy mid-game isn't snatched from under the player). */
const TIDY_GRACE_S = 45;
/** How far AHEAD of the body a thing is set out (metres) — the play area. Far
 *  enough that the setter isn't standing on its own game and a ring of players
 *  fits round it; close enough that the walk to it is a step, not an errand. */
const SET_OUT_AHEAD_M = 1.1;
/** House water: the barrel's capacity and its provisioning low-water mark. */
const BARREL_CAP = 6;
const BARREL_REFILL_BELOW = 2;
/** The pet bowl tops out here — one meal waiting, one spare. */
const BOWL_CAP = 2;
// (TABLE_MEAL_CAP retired: the table is no longer a LARDER with a standing
//  capacity the household must keep topped up. What may be laid on it is the
//  live meal ritual's BILL — one portion per head coming — see rituals.ts.)
/** Seconds at the oven per unit cooked (the process dwell). */
const COOK_DWELL_S = 5;
/** Seconds an idle, un-owned resident may linger AWAY from home (a finished
 *  spoken command left it there) before it walks back on its own. */
const HOME_IDLE_GRACE_S = 10;
/** ON-THE-CLOCK DORMANCY safety net (view-distance-lod-tiers.md step 2): the
 *  longest a contented body may sleep between decides when a NON-METER drive
 *  (stock/mess — pantry drain, clutter) is in its template set. Meter drives
 *  wake EXACTLY at their crossing; these have no closed-form timer, so the cap
 *  bounds how stale their answer can go. townClock seconds — deterministic
 *  over the shared clock, so a multiplayer owner handoff just recomputes. */
const NEED_DECIDE_CAP_S = 1.5;
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
// How long an ambient exchange counts as a STANDING conversation for the
// dollhouse camera. Pinned to the WORDS: the opener's bubble lives 5 s and the
// reply lands 1.5 s in, so 7 s is "until the last line has faded" plus a beat.
// The camera adds its own hysteresis on top — this number is about the fiction
// (are they still talking?), not about camera smoothing.
const CHAT_FOCUS_S = 7;

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
   *  SIGNATURE = their composed glyph ("food", "apple.hot").
   *
   *  `pocket` = THE INVENTORY OF THE BODY THE PLAYER IS BEING — a VIEW, not a
   *  store: it resolves to `needCarried` for the claimed creature while the
   *  spark rides one, else for the player's own creature. An inventory belongs
   *  to a body; there is no separate player account shadowing the creature's
   *  own (user law) — so what a claimed baker already carries IS what the strip
   *  shows, and what you pick up while riding stays with that body when you let
   *  go. Writing through it (`stackAdd(session.pocket, …)`) writes that
   *  creature's stack.
   *
   *  `selectedPocketGlyph` = the armed stack;
   *  `smallProps` = world objectId → the LOOSE concrete prop on the ground
   *  ({instance id, glyph}) — the only place a small item is a concrete instance, so it
   *  can be carried/owned; picking it up MERGES it into the pocket count and drops the
   *  instance. A fresh instance is MATERIALIZED from a glyph only when a stack leaves
   *  storage into the world/dialogue (drop / put-visible / present). */
  readonly pocket: Record<string, number>;
  /** WHOSE HANDS THE PLAYER IS USING — the claimed creature while the spark
   *  rides one, else the player's own creature. `pocket` resolves through it;
   *  possession is the only thing that moves it. */
  handsCid: string;
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
  /** ON-THE-CLOCK DORMANCY (view-distance-lod-tiers.md step 2): cid → the
   *  sleep a NULL decide armed. `due` = townClock of the earliest possible new
   *  fire — the exact meter crossing, capped by NEED_DECIDE_CAP_S when a
   *  non-meter drive (stock/mess) is in play. `epoch` = `needsPropsEpoch` at
   *  arm time, so a dropped/created prop wakes tidy/fun immediately. `at` =
   *  arm time — idle-away accumulates across the whole gap, not per decide.
   *  Every decide RUN clears the entry, which makes junction decides
   *  (step/pursuit/crouch endings) immediate for free. */
  needDecideDorm: Map<string, { due: number; epoch: number; at: number }>;
  /** Loose-prop world version — bumped when a small prop is REGISTERED
   *  (dropped/created); the dormancy gate's event-wake signal. */
  needsPropsEpoch: number;
  /** THE CULTURE'S RITUALS (rituals.ts) — kernel defaults ⊕ `game.culture.
   *  rituals`. Data; the loop below reads it, nothing writes it after boot. */
  ritualTemplates: readonly RitualTemplate[];
  /** LIVE RITUALS, keyed `<houseIndex>|<ritualKey>` — at most one meal and one
   *  play per household at a time. A ritual is a DECLARED EVENT (unlike a play
   *  area, whose lifetime is derivable from who is playing): the portions have
   *  to be committed to before anyone can eat, so it needs a record. It holds
   *  the roster, the bill and the phase clock — never the bodies, which is why
   *  a retiring ritual costs nothing: its heads simply stop seeing its context
   *  and fall back to their ordinary solo satisfy. */
  rituals: Map<string, RitualState>;
  /** cid → the station it holds at its ritual: a claimed seat's objId, or the
   *  ritual's own placeId for a `ring` station. Claimed ONCE on joining and
   *  held for the whole event — which is what makes the body WALK TO ITS CHAIR
   *  and sit down, instead of being slid onto one at the moment it eats. */
  ritualSeat: Map<string, string>;
  /** OPEN INVITATIONS, keyed `<houseIndex>|<ritualKey>|<cid>` — somebody asked
   *  this body to a gathering ("you eat with me", "we play together"). Read as
   *  `RitualBody.invited`, which is a PER-BODY WINDOW: it lowers that body's
   *  declare bar to a weak call, and lets it join one already declared with no
   *  call at all (rituals.ts).
   *
   *  SESSION-SIDE, not on RitualState, because an invitation is older than the
   *  ritual it may produce: it exists precisely while there is no gathering
   *  yet. `t` counts down the template's own `gatherS` — an invitation is
   *  consumed by the gathering it belongs to and expires with it, so nobody is
   *  dragged to a table by a word said an hour ago. `by` is who asked, for the
   *  relation warm-up when it's honored. */
  ritualInvites: Map<string, { by: string; t: number }>;
  /** ABANDON BACKOFF, keyed `<houseIndex>|<ritualKey>` → townClock before which
   *  the loop may not RE-declare that ritual. Set when a gathering dies with
   *  nobody fed. Without it a still-hungry caller re-declared on the very next
   *  tick, and — because stepRituals runs before stepNeeds and a declare is a
   *  junction — its fresh solo feed-myself step was wiped every frame: the
   *  observed sit-down/stand-up livelock at an empty table. The backoff is what
   *  makes the deadline's promised fallback ("the head feeds itself") real.
   *  A spoken invitation CLEARS it — an explicit ask outranks the damper. */
  ritualRetry: Map<string, number>;
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
  /** The LAST creature the player STARTED A CONVERSATION with — the standing
   *  addressee of a board selection (a pressed container item is a command to
   *  this creature while its body is still on screen). Never decays; replaced
   *  by the next conversation. */
  lastConvoCid: string | null;
  /** Refusal latch — "cid|objId" keys already refused aloud this draw episode,
   *  so an unwilling creature says "I'm not hungry" once, not every frame. */
  sparkRefused: Set<string>;
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
  actionHold: Map<string, { t: number; dur: number; effectAt: number; applied: boolean; apply: () => void; label: string; seatId?: string }>;
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
  /** THE SPOKEN-FOR LEDGER (pipeline ②, kernel/town/reservations.ts):
   *  units of stock reserved by pending site hauls, so growth and rival
   *  orders never draw the same wood. Aliases `deltas.reservations` exactly
   *  as `transfers` aliases the deltas' ledger (same lifecycle, same
   *  re-aliasing when a site is founded/abandoned). */
  reservations: ReservationLedger;
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
  /** The glyph to DRAW — the signature for everything ordinary, the piece's own
   *  vocabulary word for a `furn.<kind>` furniture stack (whose signature is
   *  storage bookkeeping and has no artwork). Falls back to `glyph`. */
  icon?: string;
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
  /** OWNER-AUTHORITATIVE MULTIPLAYER (the dollhouse over a call): every peer
   *  boots the same deterministic town from spec+seed; exactly ONE peer is the
   *  OWNER (runs the full town sim and streams every creature body as ordinary
   *  avatar packets); FOLLOWERS freeze the world-mutating sim, keep their own
   *  camera/ladder/gaze/board, and replicate bodies from the wire. Transport
   *  is opaque: outbound WorldNetMessage[] leave through `net.send`; inbound
   *  arrive via QuestHost3D.applyNetInbound, and relayed follower commands
   *  (the platform's reliable channel) via applyRemoteCommand.
   *
   *  Absent ⇒ byte-identical single-player behavior (hard requirement). */
  multiplayer?: {
    /** This peer's NETWORK identity (its personId) — the wire id its avatar,
     *  speech and claims stream under. Internal session ids (PLAYER_ID,
     *  PLAYER_CREATURE_ID) are untouched; the translation happens at the net
     *  boundary (see mpWireOut). */
    localId: string;
    role: "owner" | "follower";
    /** The platform's outbound transport (same seam as WorldHostDeps.net). */
    net: WorldHostNet;
  };
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
   *  yields instead of speaking twice. `targetId` = an EXPLICIT addressee
   *  creature id that PREEMPTS the whole local addressee stack (family chip /
   *  gaze / conversation / possession / nearest) — the multiplayer owner uses
   *  it to inject a relayed command at the SENDER's resolved target. */
  speak(sentence: string, opts?: { spokenExternally?: boolean; targetId?: string }): void;
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
  /** VIEW-DISTANCE LOD (view-distance-lod-tiers.md): cap the ambient street
   *  crowd the town streamer embodies — 0 = none (orbit / >~1km), null = the
   *  stage default. Ramped by the driver from camera→town distance so bodies
   *  stream in gradually on descent instead of flooding at the mount. */
  setCrowdBudget(n: number | null): void;
  /** VIEW-DISTANCE LOD (Phase 3): the fidelity town bodies render at — "full"
   *  on the ground, "simple" (cheap loft) on approach, "capsule" at far
   *  district range. Per-client and render-only: computed from the LOCAL
   *  camera (with hysteresis in the driver), so in multiplayer each peer
   *  dresses the same replicated bodies at its own fidelity. Existing bodies
   *  rebuild a few per frame on change. */
  setCreatureTier(t: CreatureTier): void;
  /** SPIRIT LADDER: the cursor target the view computed on its last render
   *  while the external-cursor opt-out is on — WORLD coords into `out`, null
   *  when there is none (no gaze, opt-out off, or no 3D view yet). */
  cursorWorld(out: THREE.Vector3): { hovering: boolean; select: number } | null;
  /** FLORA TWINS (one tree authority): materialize a wilderness feature in
   *  the LIVE session — a streamed scenery tree the player nears becomes a
   *  real gatherable entity at its exact spot (the host that streams the
   *  scenery hides that instance). No-op (false) without a wilderness
   *  session, when the id already stands, or when the stand-in could not
   *  spawn (body budget) — the caller must NOT hide its scenery then. */
  addWildFeature(f: WildernessFeature): boolean;
  /** Release a live wilderness feature back to scenery: remove its stand-in
   *  (box object or embodied body), its container maps and its scatter
   *  record. False when no such feature stands (e.g. already felled — the
   *  caller keeps its scenery instance hidden then). */
  removeWildFeature(id: string): boolean;
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
  /** MULTIPLAYER inbound (lossy mesh): a batch of raw wire payloads from
   *  peers. Validated and filtered here (unknown kinds tolerated — peers run
   *  vendored snapshots of different ages; own-identity echoes dropped), then
   *  applied to the world (avatar/object/possession/say/claim). No-op without
   *  `deps.multiplayer` or before the world boots. */
  applyNetInbound(msgs: unknown[]): void;
  /** MULTIPLAYER inbound (reliable relay): a follower's command, injected by
   *  the OWNER into its normal dispatch chain — a `speak` runs the full spoken
   *  pipeline with the SENDER's explicit target preempting the local addressee
   *  stack; a `claim` records the sender's spark→body ride. Followers ignore
   *  commands entirely (they don't own the sim; claims reach them over the
   *  mesh `claim` message instead). */
  applyRemoteCommand(cmd: WorldCommand): void;
  /** This peer's multiplayer role, or null when single-player. */
  multiplayerRole(): "owner" | "follower" | null;
  /** The creature the LOCAL player is currently addressing — resolved exactly
   *  as a subject-less `speak()` would (the same addressee stack: family chip,
   *  gaze, open conversation, possessed body, nearest). A FOLLOWER stamps this
   *  as `target` on the speak commands it relays, so the owner injects them at
   *  the SENDER's addressee rather than its own. Null before the session
   *  starts, or when nothing is addressable. */
  localAddressee(): string | null;
  /** The possessed creature id, or null (pure spirit / plain walker). */
  readonly possessed: string | null;
  readonly session: QuestSession;
  readonly won: boolean;
  /** The underlying world host (live engine state) — debug/test-bench surface. */
  readonly world: WorldHost | null;
  /**
   * EVERY PLACE AN ITEM COULD BE, walked parents-first, with each node's live
   * stack view (scope-unification.md step ①). Debug/test-bench: the
   * enumeration that lets anything ask "what does this town hold, all in"
   * rather than only "what is in that chest".
   */
  scopeTree(): ScopeNode[];
  /** The whole session's stock, summed by glyph across that tree — the
   *  conservation probe. `__questLab.stockAudit()`. */
  stockAudit(): Record<string, number>;
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

/** A REMOTE peer's spark — a small floating light tinted with the peer's
 *  stable identity colour (peer-colors colorHexForId, the same colour as its
 *  video-tile border), gently bobbing. Flat unlit materials ONLY: no bright
 *  moving specular highlights, ever (seizure risk — hard rule). The sim parks
 *  its position (streamed while free; beside the claimed body while riding —
 *  see stepMultiplayerFrame); this model only breathes in place. */
function remoteSparkModel(peerId: string): AvatarModel {
  const object = new THREE.Group();
  const tint = colorForId(peerId);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 12, 8),
    new THREE.MeshBasicMaterial({ color: tint }),
  );
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 12, 8),
    new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  const REST_Y = 1.35; // hovers head-high, so it reads beside a body, not underfoot
  core.position.y = halo.position.y = REST_Y;
  object.add(core);
  object.add(halo);
  let t = Math.random() * Math.PI * 2; // desync phases so two sparks never pulse in lockstep
  return {
    object,
    update(_frame, dt) {
      t += dt;
      const y = REST_Y + Math.sin(t * 1.6) * 0.06; // slow, small — a breath, not a strobe
      core.position.y = y;
      halo.position.y = y;
    },
    dispose() {
      core.geometry.dispose();
      (core.material as THREE.Material).dispose();
      halo.geometry.dispose();
      (halo.material as THREE.Material).dispose();
      object.removeFromParent();
    },
  };
}

/** Wire-id families that are WORLD BODIES rather than peers: any avatar whose
 *  id is NOT one of these (and not the local player) arrived over the network
 *  from a remote peer and renders as a spark (see remoteSparkModel). Kept in
 *  one place so the model wrapper and any future attribution logic agree. */
const WORLD_BODY_ID_RE = /^(npc_|resident_|settler|pet_|fauna:|flora:|cohort|barter_)/;

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

/** NATURAL-SOURCE BODIES (fauna/flora): one lazy factory per SPECIES (ids
 *  carry it — `fauna:<species>:…` / `flora:<species>:…`), each standing its
 *  registry height. Never a species-name special case. Shared by the town
 *  factory (herds, orchards) and the puzzle factory (wild product animals). */
function makeNaturalBodyFactory(
  detailFor?: (id: string) => CreatureDetail,
): (species: string) => ReturnType<typeof createCreatureAvatarFactory> {
  const cache = new Map<string, ReturnType<typeof createCreatureAvatarFactory>>();
  return (species: string) => {
    let f = cache.get(species);
    if (!f) {
      const src = naturalSourceOf(species);
      f = createCreatureAvatarFactory({
        speciesFor: () => species,
        heightM: src?.bodyHeightM ?? 0.95,
        ...(src?.kind === "animal" && detailFor ? { detailFor } : {}),
      });
      cache.set(species, f);
    }
    return f;
  };
}
const idSpeciesOf = (id: string) => id.split(":")[1] ?? "";

/** Puzzle characters (`npc_<nodeId>`): an animal-person CREATURE model when
 *  their emoji face maps to one, else the emoji-capsule fallback. Wild
 *  PRODUCT ANIMALS (`fauna:<species>:…` — step ④) stand their registry
 *  species body, exactly as a town's herds do. */
function makePuzzleCharacterFactory(npcIcons: Map<string, string>): AvatarModelFactory {
  const emoji = makeNpcModelFactory(npcIcons);
  const animal = createCreatureAvatarFactory({
    speciesFor: (id) => animalSpeciesForIcon(npcIcons.get(id)) ?? "human_cute",
    heightM: 1.7,
  });
  const naturalBody = makeNaturalBodyFactory();
  return (id, isLocal) => {
    if (id.startsWith("fauna:") || id.startsWith("flora:")) return naturalBody(idSpeciesOf(id))(id, isLocal);
    return animalSpeciesForIcon(npcIcons.get(id)) ? animal(id, isLocal) : emoji(id, isLocal);
  };
}

// (fnv1a — the stable tiny hash — moved to construction-director.ts; imported above.)

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

/** CREATURE VIEW TIER (view-distance-lod-tiers.md Phase 3): the fidelity every
 *  town body is BUILT at — full skinned bake, the simple (fewer-sides) bake, or
 *  the placeholder capsule at far district range. A RENDER-ONLY, per-client
 *  choice computed from the LOCAL camera (each multiplayer peer dresses the
 *  same replicated bodies at its own fidelity) — never sim state. */
export type CreatureTier = CreatureDetail | "capsule";

function makeTownModelFactory(
  npcIcons: Map<string, string>,
  species: string,
  // DEFINED FAMILY overrides (resident cid → hand-authored member): species
  // and outfit-preset choices from the world document's `entities.creatures`.
  overrides?: Map<string, { species?: string; outfit?: number }>,
  // The town's ACTIVE dress (culture palette) — bounds which outfits residents
  // wear and which bakes warm at boot.
  dress: DressPalette = DEFAULT_DRESS_PALETTE,
  // The body's CURRENT view tier, read PER ID at every model build (Phase 3;
  // per-body since the dollhouse fix — a camera inside its town needs its
  // far bodies cheap while its near ones stay full). Absent = full.
  tierFor?: (id: string) => CreatureTier,
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
  // The SIMPLE-loft wardrobe warms too, but STAGGERED off the critical path
  // (one bake per macrotask): a body's first drop into the simple band must
  // not pay its 55-70 ms main-thread bake mid-play (the readouts' recurring
  // `[bake-probe] …|lod:s` hitches), and warming them synchronously would
  // double the mount hitch instead.
  if (typeof setTimeout !== "undefined") {
    const warm: Array<() => void> = [() => getSpeciesAssets(species, {}, undefined, "simple")];
    for (const head of dress.heads) {
      for (const color of dress.colors) {
        warm.push(() => getSpeciesAssets(species, {}, outfitPresetFor(outfitIndexOf(head, color)), "simple"));
      }
    }
    const next = () => {
      const w = warm.shift();
      if (!w) return;
      w();
      setTimeout(next, 100);
    };
    setTimeout(next, 1000);
  }
  // Skinned bodies drop to the SIMPLE loft whenever the tier is not full — the
  // capsule tier only ever REPLACES a body wholesale (dispatch below), so any
  // skinned body it still builds (fresh spawns mid-cross) lofts cheap too.
  const detailFor = (id: string): CreatureDetail => (!tierFor || tierFor(id) === "full" ? "full" : "simple");
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
    detailFor,
  });
  // Town FAUNA + FLORA (the chains' living ends): the natural sources the
  // goods chains name — grazing herds by their producer, orchard plants by
  // the farms (makeNaturalBodyFactory — the same bodies wild product
  // animals stand in the open country).
  const naturalBody = makeNaturalBodyFactory(detailFor);
  const idSpecies = idSpeciesOf;
  // Household PETS: family members of a non-person species (world-doc authored;
  // species rides the same overrides map, keyed by pet cid). No outfit.
  const petBody = createCreatureAvatarFactory({
    speciesFor: (id) => overrides?.get(id)?.species ?? "quadruped",
    heightM: 0.75,
    detailFor,
  });
  const puzzle = makePuzzleCharacterFactory(npcIcons);
  return (id, isLocal) => {
    // SETTLERS (city-founding ②) are the town's founding PEOPLE — real
    // creature-builder bodies, never emoji capsules. Their creature-scoped
    // cid rides the generic npc_ body prefix, so they must dodge the
    // puzzle-giver arm.
    if (id.startsWith("npc_settler_")) return people(id, isLocal);
    if (id.startsWith("npc_")) return puzzle(id, isLocal);
    // CAPSULE TIER (Phase 3): at far district range every town BODY renders as
    // the placeholder capsule — never the local walker, never trees (landscape).
    if (
      !isLocal &&
      (id.startsWith("resident_") || id.startsWith("fauna:") || id.startsWith("pet_")) &&
      tierFor?.(id) === "capsule"
    ) {
      return defaultAvatarModelFactory(id, isLocal);
    }
    if (id.startsWith("fauna:") || id.startsWith("flora:")) return naturalBody(idSpecies(id))(id, isLocal);
    if (id.startsWith("pet_")) return petBody(id, isLocal);
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
    // THE POCKET IS NOT A THING OF ITS OWN (user law, 2026-07-26): an inventory
    // belongs to a BODY, so "the player's pocket" is just the carried stack of
    // whatever creature the player is being right now — a claimed avatar while
    // it rides one, its own walker body otherwise. One store per body, read
    // through the same `needCarried` map every other creature uses, so the box
    // on screen IS that creature's inventory rather than a parallel account
    // that shadowed it.
    handsCid: PLAYER_CREATURE_ID,
    get pocket(): Record<string, number> {
      const cid = this.handsCid;
      let bag = this.needCarried.get(cid);
      if (!bag) {
        bag = {};
        this.needCarried.set(cid, bag);
      }
      return bag;
    },
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
    needDecideDorm: new Map(),
    needsPropsEpoch: 0,
    ritualTemplates: resolveRituals(),
    rituals: new Map(),
    ritualSeat: new Map(),
    ritualInvites: new Map(),
    ritualRetry: new Map(),
    sparkDraw: null,
    sparkFocus: null,
    sparkEngageHold: 0,
    sparkChore: null,
    sparkActing: new Set(),
    sparkExplicitUntil: 0,
    lastConvoCid: null,
    sparkRefused: new Set(),
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
    reservations: town ? town.deltas.reservations : createReservationLedger(),
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

// ── TEMP DESCENT PROBE (planet→city mount-freeze investigation) ──────────────
// Measures the SYNCHRONOUS cost of a live-town mount: start()'s phase timings
// plus the first frames' stream deltas — how many buildings/residents/furniture
// materialize per frame and how much of the town the roof-reveal opened. Answers
// whether the whole-town spirit "dollhouse" reveal floods interiors at orbit
// (`reveal` climbs toward town size, +npc accumulates) or the cost is the
// building SHELLS alone (b: large, +npc/reveal near zero). In the browser
// console: `__descendProbe` (live object) or `__descendProbe.dump()`.
// REMOVE once the mount-scope fix lands.
interface DescendProbeFrameRec {
  n: number; ms: number; buildings: number | null;
  residentsIn: number; residentsOut: number; furnitureIn: number;
  revealed: number; spirit: boolean;
}
interface DescendProbeRec {
  key: string; totalStartMs: number; phases: Record<string, number>;
  frames: DescendProbeFrameRec[]; left: number; dump(): string;
}
const DESCEND_PROBE_FRAMES = 300;
let descendProbe: DescendProbeRec | null = null;
const descendNow = (): number =>
  typeof performance !== "undefined" ? performance.now() : 0;

/** Arm a fresh probe for a town mount; returns a phase-marking handle (null off
 *  a town session, so standalone/wilderness boots don't publish noise). */
function descendProbeArm(key: string | null): { mark(name: string): void } | null {
  if (!key || !probesOn()) return null;
  const t0 = descendNow();
  let last = t0;
  const rec: DescendProbeRec = {
    key, totalStartMs: 0, phases: {}, frames: [], left: DESCEND_PROBE_FRAMES,
    dump() {
      const head = `descent[${this.key}] start ${this.totalStartMs}ms ` +
        Object.entries(this.phases).map(([k, v]) => `${k}:${v}`).join(" ");
      const rows = this.frames.map((f) =>
        `#${f.n} ${f.ms}ms b:${f.buildings ?? "-"} +npc:${f.residentsIn} -npc:${f.residentsOut} ` +
        `furn:${f.furnitureIn} reveal:${f.revealed}${f.spirit ? " S" : ""}`);
      return [head, ...rows].join("\n");
    },
  };
  descendProbe = rec;
  (globalThis as unknown as Record<string, unknown>).__descendProbe = rec;
  return {
    mark(name: string) {
      const now = descendNow();
      rec.phases[name] = Math.round((now - last) * 10) / 10;
      last = now;
      rec.totalStartMs = Math.round((now - t0) * 10) / 10;
    },
  };
}

/** Record one frame()'s stream deltas into the live probe (first N frames). */
function descendProbeFrame(
  f: { buildings: unknown[] | null; add: unknown[]; remove: unknown[]; addObjects: unknown[] },
  revealed: number, spirit: boolean, ms: number,
): void {
  const p = descendProbe;
  if (!p || p.left <= 0) return;
  p.left--;
  p.frames.push({
    n: DESCEND_PROBE_FRAMES - p.left, ms: Math.round(ms * 10) / 10,
    buildings: f.buildings ? f.buildings.length : null,
    residentsIn: f.add.length, residentsOut: f.remove.length,
    furnitureIn: f.addObjects.length, revealed, spirit,
  });
  if (p.left === 0 && typeof console !== "undefined") console.log("[descent-probe]\n" + p.dump());
}

// TEMP sim-block reporter (view-distance-lod-tiers.md): rolling per-block cost
// across the WHOLE of onFrame, printed every ~2s UNCONDITIONALLY. The earlier
// threshold probes under-reported — a steady 100ms/frame block never crossed a
// per-frame gate, so the recurring hog stayed invisible. total(max) per block,
// sorted worst-first; sub-keys of the needs cluster print as `n.<step>`.
// Remove with the other probes.
const simAcc = {
  last: 0,
  frames: 0,
  blocks: new Map<string, { total: number; max: number }>(),
};
function simMark(name: string, ms: number): void {
  if (!probesOn()) return;
  const b = simAcc.blocks.get(name) ?? { total: 0, max: 0 };
  b.total += ms;
  if (ms > b.max) b.max = ms;
  simAcc.blocks.set(name, b);
}
function simFlush(): void {
  if (!probesOn()) return;
  simAcc.frames++;
  const now = descendNow();
  if (simAcc.last === 0) simAcc.last = now;
  if (now - simAcc.last < 2000) return;
  const rows = [...simAcc.blocks]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([k, v]) => `${k}:${v.total.toFixed(0)}(${v.max.toFixed(0)})`)
    .join(" ");
  if (typeof console !== "undefined") {
    console.log(`[sim-blocks] ${(now - simAcc.last).toFixed(0)}ms window / ${simAcc.frames} frames — ${rows}`);
  }
  simAcc.blocks.clear();
  simAcc.frames = 0;
  simAcc.last = now;
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

  // ── MULTIPLAYER (owner-authoritative — see QuestHostDeps.multiplayer) ────
  const mp = deps.multiplayer ?? null;
  const mpFollower = (): boolean => mp?.role === "follower";
  /** Claim-rebroadcast clock: claims are rare one-shots and late joiners miss
   *  them, so the claim HOLDER re-announces its standing claim ~5-secondly. */
  let mpClaimT = 0;
  /** WIRE-IDENTITY translation, outbound: the session's internal avatar id
   *  stays PLAYER_ID everywhere (18k lines agree on it), and ONLY the wire
   *  swaps it for this peer's personId — the least invasive correct seam.
   *  Avatar-identity fields (`id` of avatar/say/leave/claim, `by` of
   *  grab/release) are mapped; object ids (`object`/`rest`) pass through. */
  const mpWireOut = (m: WorldNetMessage): WorldNetMessage => {
    if (!mp) return m;
    switch (m.t) {
      case "avatar":
      case "say":
      case "leave":
      case "claim":
        return m.id === PLAYER_ID ? { ...m, id: mp.localId } : m;
      case "grab":
      case "release":
        return m.by === PLAYER_ID ? { ...m, by: mp.localId } : m;
      default:
        return m;
    }
  };
  /** The transport handed to runWorldHost — the platform net wrapped in the
   *  wire-identity translation above. Null in single-player (no net at all,
   *  so the world-host's networking block never runs — byte-identical). */
  const mpNet: WorldHostNet | null = mp
    ? {
        send: (msgs) => mp.net.send(msgs.map(mpWireOut)),
        ...(mp.net.publishPresence
          ? {
              publishPresence: (p) =>
                mp.net.publishPresence!(p.personId === PLAYER_ID ? { ...p, personId: mp.localId } : p),
            }
          : {}),
      }
    : null;
  /** A wire id that is a REMOTE PEER (not the local player, not any world-body
   *  family) — such an avatar arrived over the mesh and renders as a spark. */
  const isRemotePeerId = (id: string): boolean =>
    !!mp && id !== PLAYER_ID && id !== mp.localId && !WORLD_BODY_ID_RE.test(id);

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
  let attentionDebug: AttentionDebugOverlay3D | null = null;
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
  /** AMBIENT CROWD BUDGET (view-distance-lod-tiers.md Phase 2): the max street
   *  bodies the town-stage streamer may embody this frame, pushed per-frame by
   *  the driver (main.ts) from camera→town distance — 0 at orbit (>~1km: no
   *  individual creatures), ramping up on descent. null = the stage default. */
  let crowdBudget: number | null = null;
  /** CREATURE VIEW TIER (view-distance-lod-tiers.md Phase 3): the fidelity the
   *  town model factory builds bodies at, pushed per-frame by the driver from
   *  the LOCAL camera (render-only, per-client — see CreatureTier). A change
   *  queues every existing town body for a STAGGERED rebuild through the
   *  factory (a few per frame — a tier cross must never rebuild the whole
   *  crowd, plus its first-use bakes, in one frame). */
  let creatureTier: CreatureTier = "full";
  let retierQueue: string[] = [];
  // 2, not 4: one skinned rebuild costs ~15-25 ms — two per frame is already
  // a heavy frame, four was half the dollhouse's crawl (avatars 40-90 ms).
  const RETIER_STREAM = 2;
  let _retierCross = 0; // TEMP retier probe — band crossings this window
  let _retierLogT = 0;
  /** PER-BODY VIEW TIER (dollhouse fix, 2026-07-23): the town-level tier above
   *  is a coarse clamp for orbit/approach — it can't help a camera INSIDE its
   *  town, which dressed all ~64 live bodies FULL (the readout's 110–190 ms
   *  render frames). Each body additionally tiers by its OWN distance from the
   *  local camera focus (the player walker) — render chrome, never sim (the
   *  per-camera law) — with hysteresis, and crossings drain through the same
   *  staggered queue. The EFFECTIVE tier is the coarser of the two. */
  const bodyTiers = new Map<string, CreatureTier>();
  const BODY_SIMPLE_M = 45;
  const BODY_CAPSULE_M = 110;
  const BODY_TIER_HYST_M = 10;
  const TIER_RANK: Record<CreatureTier, number> = { full: 0, simple: 1, capsule: 2 };
  const seedBodyTier = (d: number): CreatureTier =>
    d > BODY_CAPSULE_M ? "capsule" : d > BODY_SIMPLE_M ? "simple" : "full";
  const bandedBodyTier = (prev: CreatureTier, d: number): CreatureTier => {
    switch (prev) {
      case "full":
        return d > BODY_SIMPLE_M + BODY_TIER_HYST_M
          ? d > BODY_CAPSULE_M + BODY_TIER_HYST_M ? "capsule" : "simple"
          : "full";
      case "simple":
        if (d > BODY_CAPSULE_M + BODY_TIER_HYST_M) return "capsule";
        return d < BODY_SIMPLE_M - BODY_TIER_HYST_M ? "full" : "simple";
      case "capsule":
        return d < BODY_CAPSULE_M - BODY_TIER_HYST_M
          ? d < BODY_SIMPLE_M - BODY_TIER_HYST_M ? "full" : "simple"
          : "capsule";
    }
  };
  /** The LOCAL CAMERA focus the per-body LOD measures from ([LOD per-camera]
   *  LAW: render chrome from the camera, NEVER a sim body). In spirit /
   *  dollhouse mode the camera frames `spiritFrame` — the observed house, which
   *  can sit far from the formless spark's PLAYER_ID body — so tier by distance
   *  from THAT rect's centre. Keying off PLAYER_ID instead demoted the very
   *  residents the camera watches to the capsule tier (no animator, no activity
   *  anchor), so they posed on the floor in front of their beds/chairs instead
   *  of sitting/sleeping on them. Off the dollhouse the walker IS the focus. */
  const cameraFocus = (): { x: number; y: number } | null => {
    if (spiritFrame) return { x: spiritFrame.x + spiritFrame.w / 2, y: spiritFrame.y + spiritFrame.h / 2 };
    return world?.state.avatars[PLAYER_ID] ?? null;
  };
  /** The tier a body BUILDS at — read by the model factory per id. A first
   *  query seeds from live distance (no hysteresis) so a far spawn builds
   *  cheap immediately instead of full-then-rebuilt. */
  const tierOf = (id: string): CreatureTier => {
    let b = bodyTiers.get(id);
    if (b === undefined) {
      const focus = cameraFocus();
      const bd = world?.state.avatars[id];
      b = focus && bd ? seedBodyTier(Math.hypot(bd.x - focus.x, bd.y - focus.y)) : "full";
      bodyTiers.set(id, b);
    }
    return TIER_RANK[b] > TIER_RANK[creatureTier] ? b : creatureTier;
  };
  /** CLOCK-ERRAND ROUTE QUEUE (view-distance-lod-tiers.md): trips emitted by
   *  the stage streamer wait here (per body — a fresh trip replaces a stale
   *  queued one) and door-route at most ERRAND_ROUTE_BUDGET per frame. Routing
   *  is the streamer's per-item lump; an approach frame can emit dozens of
   *  trips at once, and routing them all in one frame is a visible stutter. */
  const clockErrandQueue = new Map<string, Array<{ x: number; y: number; dwell?: number }>>();
  const ERRAND_ROUTE_BUDGET = 4;
  let _errSampleT = 0; // TEMP errand-sample pacing
  let _ghostLogT = 0; // TEMP ghost-spawn pacing

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
    // THE HANDS MOVE WITH THE SPARK. An inventory belongs to a body, so the
    // item strip is a VIEW of whichever creature the player is being: claim a
    // baker and the strip shows what the baker carries (and what you gather
    // stays with the baker when you let go). No transfer happens here — there
    // is nothing to transfer, because there was never a second account.
    s.handsCid = cid ?? PLAYER_CREATURE_ID;
    s.selectedPocketGlyph = null; // the armed stack belonged to the old hands
    pushPocket(s); // the strip now shows the new body's inventory
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
    // MULTIPLAYER: possession IS the claim — announce which body this spark
    // now rides (or that it let go) so peers park our light beside it. Sent on
    // claim AND release; the ~5 s rebroadcast (stepMultiplayerFrame) covers
    // late joiners. The wire mapper swaps PLAYER_ID for our personId.
    if (mpNet) {
      mpNet.send([claimMessage(PLAYER_ID, cid ? avatarIdOf(cid) : null)]);
      mpClaimT = 0;
    }
    deps.onPossession?.(cid);
  }

  /** MULTIPLAYER per-frame housekeeping, both roles — runs in onFrame (after
   *  the engine tick + remote smoothing, before render/send):
   *    • the claim holder re-announces its standing claim ~5-secondly, and
   *    • every remote spark with a recorded claim (state.peerClaims, written
   *      by the net layer) is PARKED beside the body it rides — a small fixed
   *      offset; the model's own gentle bob does the breathing — instead of
   *      wherever its streamed packets left it. Runs after smoothRemoteAvatars
   *      each frame, so the park wins over the glide. */
  function stepMultiplayerFrame(state: WorldState, dt: number) {
    if (!mp || !mpNet) return;
    mpClaimT += dt;
    if (mpClaimT >= 5) {
      mpClaimT = 0;
      if (possession.creatureId) {
        mpNet.send([claimMessage(PLAYER_ID, avatarIdOf(possession.creatureId))]);
      }
    }
    const claims = state.peerClaims;
    if (!claims) return;
    for (const peerId of Object.keys(claims)) {
      const spark = state.avatars[peerId];
      const body = state.avatars[claims[peerId]!];
      if (!spark || !body) continue; // body not streamed in here (yet)
      // Park JUST OUTSIDE the two bodies' combined collision radii (0.8 m at
      // defaults) — any closer and the owner's separateBodies pass would read
      // the pair as overlapped and shove the CLAIMED body around every frame.
      const px = body.x + 0.75;
      const py = body.y + 0.55;
      spark.x = px;
      spark.y = py;
      spark.vx = spark.vy = 0;
      // Pin the interpolation target too, so smoothRemoteAvatars stops trying
      // to glide the light back toward its (stale) streamed position.
      spark.tx = px;
      spark.ty = py;
      spark.tvx = 0;
      spark.tvy = 0;
      spark.floor = body.floor;
    }
  }

  // The active question (a choose/converse `present-choice`, or one
  // SYNTHESIZED for a creature conversation — the camera/leave-dwell
  // machinery keys on it).
  let choice: { nodeId: string; posedByEntityId: string; prompt: string; options: ChoiceOptionView[] } | null = null;
  // A live need-based creature conversation (fulfill nodes) — dialogue is a
  // PROJECTION of creature state, re-computed after every act.
  let convo: { nodeId: string; level: SyntaxLevel; memo: ConversationMemo; acts: DialogueAct[] } | null = null;
  // The OPEN FURNITURE board (bug #5): the piece the gaze rests on — its object id +
  // the glyph stacks on show, contents first, the thing itself last. A press takes one;
  // walking/looking away closes it, like a convo. Furniture with NO stock (a chair, an
  // empty chest) still opens one: the board names what the player is looking at.
  let container: { objId: string; items: string[] } | null = null;
  /** Is the open board a STOCKED one? Only then is it MODAL — holding the camera,
   *  walking an embodied body over, and pausing the attention spark, because the
   *  player is reaching into it. A bare NAMING board just labels what the gaze rests
   *  on; locking the view and freezing the world's gestures for a glance at a chair
   *  would cost far more than the label is worth. */
  const stockedBoard = () => !!container && container.items.length > 0;
  // The spirit ladder's focused-building frame (city-founding ③ focus
  // scope): re-asserted every structure-rung frame via setSpiritFocus,
  // nulled at town/district/ground. Sim-coords lot rect —
  // resolveStructureFocus matches it back to the plan lot it came from.
  let spiritFocus: { x: number; y: number; w: number; h: number } | null = null;
  // "SHOW AREAS" (city-founding areas): a TOGGLEABLE map-reading tint over
  // the named units (ZoneOverlay3D reads this gate) — never persistent
  // world texture. Areas otherwise show only through their consequences.
  let areaOverlayOn = false;
  // BUILD MODE (⑦ — one build word, then the ground answers). The civic board
  // used to unfold every construction option at once: a menu of verbs with no
  // object. Now it carries ONE `build` word; pressing it lights the GROUND
  // (every plot a structure could rise on, every building that could grow or
  // come down) and the player settles on a spot to get THAT spot's menu — the
  // object first, so the options are only ever the ones it can really take.
  let buildMode = false;
  /** The spot whose menu is on the board (a completed long dwell). */
  let buildSpotId: string | null = null;
  /** The spot under the gaze THIS frame — feeds the dwell table and lights
   *  the overlay's focus wash, so what is lit is what a dwell would open. */
  let hoverSpotId: string | null = null;
  // (The spot cache and the stage's last-emitted construction sites are
  //  DIRECTOR-held now — clearSpotCache()/setSites()/directorSites() below.)
  let isWon = false;
  let paused = false;

  // Pointer: the last CLIENT px (persistent — a still pointer keeps steering),
  // mapped onto the canvas for the world host, which owns the gaze-intent
  // interpreter + camera.
  let lastClient: { x: number; y: number } | null = null;
  // TWO DWELLS, NOT FIVE (dwell-interaction.ts). The spark rests on ONE thing;
  // how LONG it rests is the only other question, so there are exactly two
  // timers and the table decides what each means. Two lengths deliberately — a
  // third stops being something a student can perform on purpose.
  //
  // Both clocks start when the spark LANDS on a thing (the hover key re-anchors
  // them below), so these are times-since-arrival, not times-since-anything-else.
  // SHORT is a glance held on purpose; LONG stays at the conversation dwell this
  // has always used, so opening a conversation costs exactly what it used to.
  const SHORT_DWELL_MS = 300;
  const LONG_DWELL_MS = CONVO_START_MS; // 700
  // SAME tolerance and grace on both: they time ONE hover, so they must never
  // disagree about whether that hover is still current. With different values a
  // creature walking as you watch it could break the short clock while the long
  // one rode on — the long gesture firing where the short never had.
  const DWELL_TOLERANCE = CONVO_FIG_RADIUS;
  const DWELL_GRACE_MS = 450; // bridges a blink without dropping the fill
  const shortDwell = createDwellTracker({
    dwellMs: SHORT_DWELL_MS, tolerance: DWELL_TOLERANCE, graceMs: DWELL_GRACE_MS,
  });
  const longDwell = createDwellTracker({
    dwellMs: LONG_DWELL_MS, tolerance: DWELL_TOLERANCE, graceMs: DWELL_GRACE_MS,
  });
  // Which HOVER those timers are filling for. They anchor by POSITION, and two
  // things can stand closer than the jitter tolerance (a chest beside a table),
  // so a dwell that already fired on one would swallow the move to its
  // neighbour. Identity re-anchors them; a momentary loss of the pick leaves
  // them be, so the trackers' own grace still bridges blinks.
  let dwellKey: string | null = null;
  // Which phases have already fired for THIS hover, so a held gaze escalates
  // (short → long) exactly once instead of re-firing every frame.
  const firedPhases = new Set<DwellPhase>();
  // Leaving a conversation is NO LONGER a gesture. Under the hover table a
  // glance off the partner is an INSTRUCTION (ground ⇒ go there, object ⇒ go
  // interact with that), so it cannot also mean "leave" — the same look would
  // carry two meanings. A conversation now ends on its own inactivity timeout,
  // or when a different one begins.
  const CONVO_IDLE_END_S = 12;
  let convoIdleS = 0;
  /** Drop every accumulated dwell fill and its anchor. Called whenever the thing
   *  the player is engaged with changes underneath the gaze (a board opens, a
   *  conversation starts or ends, the session resets) — otherwise a fill earned
   *  against the old context would fire against the new one. */
  // ── BOARD CHROME (⑦ board-chrome.ts) ──────────────────────────────────
  // EVERY board goes out through `pushBoard`, so paging and a way back are
  // properties of the board SURFACE, not of whatever happens to be on it.
  // A producer just hands over its options and (when it has a parent) what
  // "back" should do; the chrome words are intercepted in `select` before
  // any producer sees them.
  /** The page currently shown, and the content it belongs to (a changed list
   *  always shows its first page — nobody is left paging an old one). */
  let boardPage = 0;
  let boardKey = "";
  /** What BACK does on the board that is up, or null (no parent). */
  let boardBack: (() => void) | null = null;
  /** The last raw view, so MORE can re-emit it at the next page. */
  let lastBoardView: QuestBoardView | null = null;

  function pushBoard(view: QuestBoardView, back?: (() => void) | null): void {
    const key = `${view.nodeId}//${boardContentKey(view.options)}`;
    if (key !== boardKey) {
      boardKey = key;
      boardPage = 0;
    }
    lastBoardView = view;
    boardBack = back ?? null;
    const locale = sess?.game.meta.locale ?? "en";
    const chrome = boardChrome({
      options: view.options,
      page: boardPage,
      back: !!back,
      moreText: translateGlyph(BOARD_MORE_GLYPH, locale),
      backText: translateGlyph(BOARD_BACK_GLYPH, locale),
    });
    boardPage = chrome.page;
    presenter.board({ ...view, options: chrome.options });
  }

  /** Blank the board AND its chrome — a stale page or back handler outliving
   *  the board it belonged to is how "back" starts doing the wrong thing. */
  function clearBoard(): void {
    boardKey = "";
    boardPage = 0;
    boardBack = null;
    lastBoardView = null;
    presenter.clearBoard();
  }

  function resetDwells(): void {
    shortDwell.reset();
    longDwell.reset();
    firedPhases.clear();
    dwellKey = null;
    convoIdleS = 0;
  }
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
        // Else the creature's SPECIES word ("the frog") — never a deictic
        // "there", which reads as a broken "the there" once articled.
        return creatureGlyph(session, cid) ?? speciesWordOf(speciesOf(session, cid));
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
      // WHAT THIS CULTURE GATHERS FOR, and whether a given body could join
      // right now — the two halves of an invitation's board presence. Both read
      // the culture's own ritual rows, so a world that declares a song ritual
      // gets "sing with me" with no edit anywhere.
      jointActivities: gatherableActivities(session),
      canJoin: (cid: string, verb: string) => canJoinActivity(session, cid, verb),
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
   *  out on its trip returns undefined (perceived/told facts may still answer).
   *
   *  Read off the SITUATION, not off the destination: a body that has stopped
   *  walking gets no destination (see residentGoing), but it is still exactly
   *  where its errand put it — a worker standing at its bench is AT work. */
  function presenceWordOf(session: QuestSession, cid: string): string | undefined {
    if (cid.startsWith("pet_")) return "home";
    const sit = residentSituation(session, cid);
    if (!sit) return undefined;
    switch (sit.kind) {
      case "step": {
        // A live step's business is in the house or out in town; only the
        // household case is a place this can name.
        const rooms = houseRoomDestsOf(session, Number(cid.split("_")[1]));
        return roomAt(rooms, stepDestPos(sit.step)) ? "home" : undefined;
      }
      case "scheduled":
        // A shift is a place in its own right. On a shopping trip, walking back
        // already counts as home (the schedule's last leg); out at the source,
        // only a sighting can say.
        if (sit.trip.kind === "shift") return "work";
        return sit.trip.phase === "to_home" ? "home" : undefined;
      case "idle":
        return "home";
    }
  }

  /** The rooms of a resident's own house as DESTINATIONS (going.ts): world rects
   *  with annex/demolition deltas applied, each carrying the word it answers
   *  with. The living room and halls carry NO word — their glyph is "home"/"room",
   *  and "I'm going home" is exactly what a body standing in the house must not
   *  say. Empty off a town session or for an unknown lot. */
  function houseRoomDestsOf(session: QuestSession, houseIndex: number): GoingRoom[] {
    const ctx = residentTownCtx(session, houseIndex); // neighbor-aware center
    if (!ctx?.house) return [];
    const delta = session.town?.deltas.get(`h_${ctx.house.index}`);
    return houseRoomPlan(ctx.center, ctx.house, delta).rooms.map((r) => ({
      rect: r.rect,
      ...(r.kind === "living" || r.kind === "hall" ? {} : { word: ROOM_GLYPH[r.kind] }),
    }));
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
    // still visibly traveling — it IS going somewhere. (Wander is a behavior, not an
    // errand — idlers stay un-askable.) WALKING, not merely erranded: an errand
    // whose current waypoint is being DWELLED out is a body standing still — the
    // sleeper pinned at its bed, the builder holding its work spot — and "where
    // are you going?" has no business being asked, let alone answered "home".
    const path = world?.npcErrandPath(avatarIdOf(cid));
    if (!path || path.dwelling) return undefined;
    if (!cid.startsWith("resident_")) return { kind: "place", place: "there" };
    // A resident's UNLABELED walk (no step, no queued task — a stray host errand):
    // "home" only when the walk actually ends inside its house and the body is not
    // in there already; inside, name the room it is crossing to.
    const rooms = houseRoomDestsOf(session, Number(cid.split("_")[1]));
    const end = path.points[path.points.length - 1];
    const destRoom = end ? roomAt(rooms, end) : undefined;
    const body = world?.state.avatars[avatarIdOf(cid)];
    const inside = !!body && !!roomAt(rooms, body);
    if (!destRoom) return inside ? undefined : { kind: "place", place: "there" };
    if (!inside) return { kind: "home" };
    return destRoom.word ? { kind: "room", room: destRoom.word } : undefined;
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
      const act = stepActivity(step);
      if (act) return act;
    }
    const going = creatureGoing(session, cid);
    if (going) {
      if (going.kind === "fetch") return { verb: "get", object: headOf(going.good) };
      if (going.kind === "activity") return { verb: going.verb, ...(going.object ? { object: going.object } : {}) };
      const dest = going.kind === "home" ? "home" : going.kind === "room" ? going.room : going.place;
      return { verb: "go", object: dest };
    }
    return undefined;
  }

  /** A live need STEP as an answer to "where are you going?" — the world side of
   *  going.ts's `stepDestination` (which owns the rules: arrived is not going, a
   *  body inside its own house is never "going home"). */
  function liveStepGoing(
    session: QuestSession,
    cid: string,
    houseIndex: number,
    step: NonNullable<ReturnType<QuestSession["needStep"]["get"]>>,
  ): GoingDest | undefined {
    const body = world?.state.avatars[avatarIdOf(cid)];
    if (!body) return undefined;
    return stepDestination(
      { kind: step.kind, tplKey: step.tplKey, goodKey: step.goodKey, at: stepDestPos(step) },
      { x: body.x, y: body.y, using: !!step.objId && body.anchor?.fixtureId === step.objId },
      houseRoomDestsOf(session, houseIndex),
      WALK_ARRIVE,
    );
  }

  /** Where a live step ENDS: the fixture's OWN spot, not the stand point beside
   *  it — a stand point can sit a hair over a room boundary, and the room it
   *  belongs to is the answer. */
  function stepDestPos(step: NonNullable<ReturnType<QuestSession["needStep"]["get"]>>): { x: number; y: number } {
    return (step.objId ? world?.state.objects[step.objId] : undefined) ?? step.pos;
  }

  /** What a resident is BUSY WITH per the household roster (common knowledge —
   *  household-duties §1): the live needs step, else the goods clock's shopping
   *  trip, else a work shift, else nothing. The ONE reading behind both answers
   *  that depend on it — the destination ("where are you going?", which is
   *  additionally gated on the body actually walking) and the presence word
   *  ("where is Mara?", which a body standing still does not change). */
  type ResidentSituation =
    | { kind: "step"; step: NonNullable<ReturnType<QuestSession["needStep"]["get"]>> }
    | { kind: "scheduled"; trip: ScheduledTrip }
    | { kind: "idle" };

  function residentSituation(session: QuestSession, cid: string): ResidentSituation | undefined {
    if (!session.town || !cid.startsWith("resident_")) return undefined;
    const houseIndex = Number(cid.split("_")[1]);
    const member = Number(cid.split("_")[2]);
    const house = residentTownCtx(session, houseIndex)?.house; // neighbor-aware
    if (!house) return undefined;
    const step = session.needStep.get(cid);
    if (session.liveNeedBodies.has(cid) && step) return { kind: "step", step };
    const good = residentShopGoods(session, houseIndex, member);
    if (good) {
      const phase = good.errand(house, session.townClock).phase;
      if (phase !== "home") return { kind: "scheduled", trip: { kind: "shopping", phase, good: good.good.key } };
    }
    const jd = residentJobDuty(session, houseIndex, member);
    if (jd && inShiftWindow(jd.window, session.townClock, FOOD_DAY_SEC)) {
      return { kind: "scheduled", trip: { kind: "shift" } };
    }
    return { kind: "idle" };
  }

  /** Speed below which a body is braking or jitter, not traveling (the reasoning
   *  behind engine.ts's FACE_SPEED_MIN: near a stop the smoothed velocity is
   *  noise). */
  const GOING_SPEED_MIN = 0.15;

  /** Is this body VISIBLY on the move — walking an errand leg, or simply moving?
   *  Undefined means there is no hosted body to ask (off-show), where the
   *  schedule is all anyone has and is trusted as-is. A DWELLED errand waypoint
   *  is a body standing still (a shopper at the stall, a worker at its bench). */
  function bodyWalking(cid: string): boolean | undefined {
    const id = avatarIdOf(cid);
    const body = world?.state.avatars[id];
    if (!body || !world) return undefined;
    const path = world.npcErrandPath(id);
    if (path && !path.dwelling) return true;
    return Math.hypot(body.vx, body.vy) > GOING_SPEED_MIN;
  }

  /** A resident's live DESTINATION: the live step's, the goods clock's shopping
   *  trip, or the commute to work. Residents only — the ambient crowd is what
   *  walks; cast bodies aren't clock-driven. Both branches let the BODY overrule
   *  the schedule when it can be seen standing still (going.ts: `tripDestination`
   *  and `stepDestination`). */
  function residentGoing(session: QuestSession, cid: string): GoingDest | undefined {
    const sit = residentSituation(session, cid);
    if (!sit) return undefined;
    switch (sit.kind) {
      case "step":
        return liveStepGoing(session, cid, Number(cid.split("_")[1]), sit.step);
      case "scheduled":
        return tripDestination(sit.trip, bodyWalking(cid));
      case "idle":
        return undefined;
    }
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
    pushBoard(
      {
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
      },
      () => closeCreatureConvo(), // BACK leaves the conversation
    );
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
        // The toilet answers to the BOARD's word ("bathroom" — the resolver
        // aliases it back to the toilet object).
        if (kind === "toilet") {
          addRaw("bathroom", "bathroom");
          continue;
        }
        // EVERY OTHER KIND SPEAKS THE VOCABULARY'S WORD (`fixtureWord`), never
        // its own name: the sim tells a goods `chest` from the toy `box` and
        // calls a cabinet a `cupboard`, but the board carries neither word —
        // so those two shipped as labelled buttons with NO ICON.
        const word = fixtureWord(kind);
        // A kind that folds onto a word ANOTHER kind owns gets no button of its
        // own — `chest` speaks "box", and the toy `box` is the box, so it adds
        // itself with its own properties (a chest's lid opens, a toy box's does
        // not; whichever came first must not decide that).
        if (word !== kind && STATION_PROPERTIES[word as StationKind]) continue;
        // Meta from the KIND — the spec side — so the renamed `cabinet` button
        // keeps the cupboard's container/openable affordances.
        addRaw(word, word, conceptMeta(kind));
      }
      addRaw("home", "home");
      addRaw("water", "water");
      // The wardrobe's garments: "you wear the shirt", "give dress to mara".
      // Seed the bare HEADS as nouns; colour rides as a separate `color_*`
      // modifier word ("wear + shirt + red"), already in the lexicon.
      addRaw("clothing", "clothing");
      for (const k of CLOTHING_HEADS) addRaw(k, k);
      for (const [, rec] of session.smallProps) addRaw(drawnMakeable(rec.glyph), spokenMakeable(rec.glyph));
    }
    // BUILDABLE STRUCTURES (①b): at a town / founded site, the catalog's
    // nouns are speakable — the sentence builder can compose "build house"
    // ("build" is already in the LEXICON; these are its objects).
    if (session.town || session.foundedSite) {
      // Affordability reads FREE haul-able availability (pipeline ②), not
      // the yard alone — wood in a chest or a standing tree counts.
      const center = session.town ? session.town.stage.center : session.foundedSite!.at;
      for (const spec of structureCatalogOf(session)) {
        if (!Object.keys(buildMissingMaterials(session, spec, center)).length) {
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
      const buildStock = session.town ? session.town.deltas.stock : session.foundedSite?.stock;
      for (const g of Object.keys({ ...(buildStock ?? {}), ...session.pocket })) {
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
    clearBoard();
    world?.setConversation(null);
    resetDwells();
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
    const out = new Map<string, { species?: string; outfit?: number }>();
    const memberRow = (m: TownFamilyMember): { species?: string; outfit?: number } => ({
      ...(m.species !== undefined ? { species: m.species } : {}),
      ...(m.outfit !== undefined ? { outfit: m.outfit } : {}),
    });
    const fam = familyOf(session);
    if (fam) {
      fam.members.forEach((m, i) => {
        if (m.species !== undefined || m.outfit !== undefined) {
          out.set(`resident_${fam.house}_${i}`, memberRow(m));
        }
      });
    }
    for (const { cid, pet } of petsOf(session)) {
      out.set(cid, { species: pet.species ?? "quadruped" });
    }
    // SETTLERS (city-founding ②): a defined family at founding age is
    // HOUSELESS (familyHouse null, so familyOf is silent) — its authored
    // species/outfits ride the settler BODIES instead (avatarIdOf gives
    // creature-scoped cids the npc_ prefix).
    const t = session.town;
    if (t && (t.config.days ?? 220) <= FOUNDING_AGE_DAYS && t.plan.houses.length === 0) {
      t.config.family?.members.forEach((m, i) => {
        if (m.species !== undefined || m.outfit !== undefined) {
          out.set(`npc_settler_${i}`, memberRow(m));
        }
      });
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
    fixture = "chair",
  ): { id: string; x: number; y: number } | null {
    const t = state.objects[tableId];
    const body = state.avatars[cid];
    if (!t || !body) return null;
    const tSpec = state.spec.objects.find((s) => s.id === tableId);
    const reach = (tSpec?.radius ?? 1) + 1.6; // a pulled-up chair sits within arm's reach of the tabletop
    let best: { id: string; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const spec of state.spec.objects) {
      if (spec.fixture !== fixture) continue;
      const o = state.objects[spec.id];
      if (!o || Math.hypot(o.x - t.x, o.y - t.y) > reach) continue;
      let taken = false;
      // A RITUAL CLAIM outranks everything: a head holds its seat for the whole
      // event, whether or not it has reached it yet, so a housemate deciding
      // mid-gathering can never be handed the chair someone is walking to.
      for (const [other, sid] of session.ritualSeat) {
        if (other !== cid && sid === spec.id) { taken = true; break; }
      }
      if (!taken) {
        for (const [other, st] of session.needStep) {
          if (other !== cid && st.seatId === spec.id) { taken = true; break; }
        }
      }
      if (!taken) {
        for (const [pid, pav] of Object.entries(state.avatars)) {
          if (pid === cid || (!pid.startsWith("resident_") && !pid.startsWith("pet_"))) continue;
          if (Math.hypot(pav.x - o.x, pav.y - o.y) < 0.5) { taken = true; break; }
        }
      }
      if (taken) continue;
      // THE MOUNT-ROOM RULE, claim-side (kernel placement.ts seatMountable):
      // the generator no longer emits a seat without standing room at its
      // face, but a pre-existing world or a hand-placed piece can still hold
      // one. Its stand point then resolves through the covering fixture's
      // GENERAL fallback — the far side of the table — and a claim on it
      // walks the sitter somewhere the furniture anchor can never pick it up
      // from. A seat is claimable only when its stand point stays within
      // mounting reach of the seat itself.
      const bodyR = world?.npcRadiusOf(cid);
      const sp = standPointFor(state, spec.id, { x: o.x, y: o.y }, { x: body.x, y: body.y }, bodyR);
      if (Math.hypot(sp.x - o.x, sp.y - o.y) > SEAT_MOUNT_REACH_M) continue;
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
  /** How far past a rest fixture's own EDGE a station-less doze may still count
   *  as "at" it (metres). Only the `restHere` fallback reads it — a `restAt`
   *  names its station and that is authoritative at any distance. Deliberately
   *  TIGHT: a doze in the open has no station, so the only piece it may adopt is
   *  one the body is already touching (it sat down at that chair, then nodded
   *  off). A generous radius here means a body that merely walked PAST a chair
   *  climbs onto it — the dog on the dining chair. */
  const REST_REACH_MARGIN = 0.5;
  /** How far past a posed station's own EDGE the body may stand and still SHOW
   *  the pose (syncNeedActivities). Strictly wider than the furniture anchor's
   *  engage reach (radius + body radius + ENGAGE_MARGIN), because the shown
   *  activity IS the claim the anchor engages on — a narrower gate would leave a
   *  band where the anchor would slide the body on but is never told to. */
  const POSE_REACH_M = 2.2;
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
  /** The arrival tolerance for a leg that ends in POSING ON a piece
   *  (`onFixureUseTargetOf`): the stand spot is the contact handoff, not a rough
   *  destination, so the body walks it properly instead of stopping a metre out.
   *  Loose enough that the follower's own braking still counts as there.
   *  ⚠️ Must stay ≤ the reach `r.arrived` uses, or the two fight. */
  const USE_LEG_ARRIVE = 0.45;
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
      // `objId` = the FIXTURE this point belongs to, when the goal named one. The
      // id is what carries the use-point contract (which side a chest is opened
      // from) and — for a PASS-THROUGH seat — the fact that a SEAT is the aim at
      // all. `nearestClearSpot` only ever sees a bare point, so it read a dining
      // chair as "somewhere inside the table" and put the approach on whichever
      // table face the WALKER came from: a table-width (~2.4 m) from the seat. The
      // body then cut the table's corner to get there and wedged on the collider,
      // and its arrival fell outside every use gate, so it never sat down.
      const standable = (raw: { x: number; y: number } | null, objId?: string) => {
        if (!raw) return null;
        if (standClear(state, raw, pursuerR)) return raw; // already reachable — body-independent, no commit needed
        const cache = (pur.stand ??= new Map<string, { x: number; y: number }>());
        const key = `${objId ?? ""}|${Math.round(raw.x * 2)}|${Math.round(raw.y * 2)}`;
        const hit = cache.get(key);
        if (hit) return hit;
        const spot = objId
          ? standPointFor(state, objId, raw, from, pursuerR, standAvoid(cid))
          : nearestClearSpot(state, raw, from, pursuerR, standAvoid(cid));
        cache.set(key, spot);
        return spot;
      };
      const r: WorldResolver = {
        ...base,
        itemPosition: (id) => standable(base.itemPosition(id)),
        // A goal that NAMES a real fixture hands its id down (see `standable`).
        // Guarded to a genuine fixture id: `place` also accepts a SPOKEN name
        // ("bed"), which resolves to some object but is not itself an object id —
        // that keeps the point-only resolution.
        place: (p) => {
          const named =
            p.kind === "named" && state.spec.objects.some((o) => o.id === p.id && o.fixture) ? p.id : undefined;
          return standable(base.place(p), named);
        },
        stationFor: (s) => standable(base.stationFor(s)), // a transform station is a solid box — stand beside it
        diningSpot: (self, kinds) => standable(base.diningSpot?.(self, kinds) ?? null), // the table is solid too
        colorStation: (self) => standable(base.colorStation?.(self) ?? null), // the tub is solid — stand beside it
        arrived: (self, pos) => {
          const b = state.avatars[avatarIdOf(self)];
          if (!b) return false;
          // A goal that ends in USING an on-fixture piece is arrived when the
          // FURNITURE ANCHOR can take the body from here (or already has) —
          // judged by the anchor's OWN contact-handoff test, so the walk can
          // never stop where the anchor can't reach, and never counts a stop the
          // anchor would refuse. That test is a small circle around the piece's
          // ARRIVAL SPOT, never a ring around the whole piece: a wide ring spans
          // the table a dining chair is tucked against, so a body across the
          // tabletop read "arrived" (2.35 m ≤ 2.42), rested in place, and never
          // rounded the table to its seat (observed live).
          const useId = onFixtureUseTargetOf(state, pur.goal);
          if (useId) {
            return b.anchor?.fixtureId === useId || withinEngageReach(state, useId, b, pursuerR);
          }
          return Math.hypot(b.x - pos.x, b.y - pos.y) <= COMMAND_ARRIVE;
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
        // The LEG's own tolerance must be at least as tight as `r.arrived` above,
        // or the two deadlock: walkTo would call the leg done and stop issuing the
        // errand while `pursue` kept returning "move", leaving the body parked
        // short of a spot nobody was steering it to any more. A use-leg therefore
        // walks the stand spot PROPERLY — that spot was chosen to put the piece
        // inside the anchor's reach, so the last metre is the whole point of it.
        const status = walkTo(session, cid, next.pos, dt, {
          arrive: onFixtureUseTargetOf(state, pur.goal) ? USE_LEG_ARRIVE : COMMAND_ARRIVE,
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

  // ── RITUALS (rituals.ts) ───────────────────────────────────────────────────
  // A social activity as a DECLARED EVENT: something calls it, a place is
  // chosen, the things it needs are prepared for the heads actually coming,
  // and they perform it together.
  //
  // ⚠️ THIS LOOP NEVER DRIVES A BODY. It owns the roster, the bill and the
  // phase clock, and it SHAPES the need context (`residentNeedCtx`) — which is
  // the whole coordination: a head's calling need is bound to the ritual's
  // place, so it stops foraging and waits for the meal, and derived prep/cook/
  // attend rows appear on its template set. Every step a body takes is still
  // taken by the need walker. That is why retiring a ritual costs nothing: its
  // heads simply stop seeing its context and fall back to their solo satisfy.

  /** The ritual a derived row belongs to. Rows are keyed `<motive>:<ritualKey>`
   *  (`prep:meal`, `cook:meal`, `attend:meal`) precisely so this lookup exists. */
  function ritualOfTemplate(session: QuestSession, houseIndex: number, tplKey: string): RitualState | undefined {
    const i = tplKey.indexOf(":");
    if (i < 0) return undefined;
    return session.rituals.get(`${houseIndex}|${tplKey.slice(i + 1)}`);
  }

  /** WHERE a ritual happens. A template that names fixture kinds takes the
   *  first the house has; one that names NONE (the play ritual) is placed at
   *  whatever a participant's own satisfy already PUT THERE — the toy set out
   *  on the floor. Nothing here creates a place: a ritual adopts one. */
  function ritualPlaceFor(
    session: QuestSession,
    state: WorldState,
    houseIndex: number,
    tpl: RitualTemplate,
  ): string | null {
    if (tpl.at.length) {
      for (const kind of tpl.at) {
        const id = `furn_${houseIndex}_${kind}`;
        if (state.objects[id]) return id;
      }
      return null;
    }
    const house = residentTownCtx(session, houseIndex)?.house;
    const rc = residentTownCtx(session, houseIndex);
    if (!house || !rc) return null;
    const x0 = rc.center.x + house.dx;
    const y0 = rc.center.y + house.dy;
    const areas: string[] = [];
    for (const objId of session.smallProps.keys()) {
      const o = state.objects[objId];
      if (!o || o.carriedBy || o.containedIn) continue;
      if (o.x < x0 || o.x > x0 + house.w || o.y < y0 || o.y > y0 + house.h) continue;
      if (isPlayArea(session, state, objId)) areas.push(objId);
    }
    areas.sort(); // deterministic — never RNG, never insertion order
    return areas[0] ?? null;
  }

  /** The fixture kind of a place ("table"), or "" for a loose prop on the floor. */
  function fixtureKindOf(state: WorldState, objId: string): string {
    return state.spec.objects.find((s) => s.id === objId)?.fixture ?? "";
  }

  /** MAY THIS BODY TAKE PART HERE? Asked of the body's OWN needs, never of its
   *  species: a ritual is eligible when one of its STRONG calls resolves to a
   *  template on this body whose satisfy accepts this place. A pet's hunger
   *  eats at its `bowl`, so the table's meal never calls it — and nothing here
   *  enumerates pets. A `use` satisfy accepts any floor station by nature.
   *
   *  Bodies the player has taken (party, a spoken command, a queued task) are
   *  never eligible: an ordered body is not at dinner. */
  function ritualEligible(
    session: QuestSession,
    cid: string,
    tpl: RitualTemplate,
    placeKind: string,
    templates: readonly NeedTemplate[],
  ): boolean {
    if (session.party.has(cid)) return false;
    if ((session.npcTasks.get(avatarIdOf(cid))?.length ?? 0) > 0) return false;
    if (session.pursuits.get(cid)?.source === "command") return false;
    // ONE RITUAL AT A TIME. You cannot be at dinner and at the game, and the
    // machinery agrees: a body holds ONE station claim, so a second ritual
    // recruiting it would either steal the first's seat or silently leave it
    // holding the wrong one.
    for (const [k, other] of session.rituals) {
      if (!k.endsWith(`|${tpl.key}`) && other.heads.includes(cid)) return false;
    }
    for (const c of tpl.calls) {
      if (c.kind !== "strong") continue;
      const t = templates.find((x) => x.key === c.tplKey);
      if (!t) continue;
      if (t.satisfy.kind === "use") return true;
      const at = "at" in t.satisfy ? t.satisfy.at : undefined;
      if (at?.includes(placeKind)) return true;
    }
    return false;
  }

  /** Is this body AT the gathering? Edge-relative, like every other reach in
   *  this file — a flat radius reads a wide piece as unreached from the very
   *  spot the walk aimed at.
   *
   *  Its claimed station OR the ritual's place counts: what the phase gate
   *  actually needs to know is "is everyone here", and a head standing at the
   *  table because its chair could not be reached IS here. Requiring the chair
   *  specifically makes the furniture's reachability a precondition for dinner
   *  ever starting. */
  function ritualSeated(session: QuestSession, state: WorldState, cid: string, placeId: string): boolean {
    const av = state.avatars[avatarIdOf(cid)];
    if (!av) return false;
    const at = (id: string | undefined) => {
      const o = id ? state.objects[id] : undefined;
      if (!o) return false;
      const spec = state.spec.objects.find((s) => s.id === id);
      return Math.hypot(av.x - o.x, av.y - o.y) <= (spec?.radius ?? 0.3) + RITUAL_SEATED_M;
    };
    return at(session.ritualSeat.get(cid)) || at(placeId);
  }

  /** How many the place can hold at once: a table seats its chairs; a ring on
   *  the floor is bounded only by the template (and by the crowding rule, which
   *  keeps the bodies apart on its own). */
  function ritualCapacity(
    session: QuestSession,
    state: WorldState,
    tpl: RitualTemplate,
    placeId: string,
  ): number {
    if (tpl.station.kind === "ring") return tpl.maxHeads;
    const t = state.objects[placeId];
    if (!t) return 0;
    const reach = (state.spec.objects.find((s) => s.id === placeId)?.radius ?? 1) + 1.6;
    let n = 0;
    for (const spec of state.spec.objects) {
      if (spec.fixture !== tpl.station.fixture) continue;
      const o = state.objects[spec.id];
      if (o && Math.hypot(o.x - t.x, o.y - t.y) <= reach) n++;
    }
    return n;
  }

  /** Claim this body's place at the ritual — the seat it will WALK TO and sit
   *  on, held for the whole event. (Claiming it up front instead of at the
   *  moment of eating is the fix for the diner that stood beside a chair, ate,
   *  and only then snapped onto it.)
   *
   *  ⚠️ RETRIED EVERY TICK for any head that hasn't got one, never only on the
   *  join. A claim can legitimately fail at the instant a body joins — the last
   *  free chair still has the previous sitting on it — and when that was the
   *  only attempt, the head stayed on the roster with nowhere to sit: its
   *  `attend` row blocked forever, it never counted as seated, and it inflated
   *  the bill for a portion nobody would eat until the deadline dropped it. */
  function claimRitualStation(
    session: QuestSession,
    state: WorldState,
    cid: string,
    tpl: RitualTemplate,
    live: RitualState,
  ): boolean {
    if (session.ritualSeat.has(cid)) return true;
    if (tpl.station.kind === "ring") {
      session.ritualSeat.set(cid, live.placeId);
      return true;
    }
    const seat = freeSeatAt(session, state, cid, live.placeId, tpl.station.fixture);
    if (!seat) return false;
    session.ritualSeat.set(cid, seat.id);
    return true;
  }

  /** JOINING IS A JUNCTION: whatever this body decided a moment ago was decided
   *  without the ritual in it (a walk to the pantry for a raw apple, say), so
   *  drop the step and the dormancy and let it re-decide against the event on
   *  the very next tick. Without this a head finishes its old errand first and
   *  the gathering visibly waits on nothing. */
  function ritualJunction(session: QuestSession, cid: string) {
    session.needStep.delete(cid);
    session.needDecideDorm.delete(cid);
    if (session.pursuits.get(cid)?.source === "need") session.pursuits.delete(cid);
  }

  const releaseRitualStation = (session: QuestSession, cid: string) => session.ritualSeat.delete(cid);

  /** The CHAIR this body holds as a head of ANY live seat-stationed ritual — or
   *  null. The place-agnostic twin of `ritualSeatAt`, with the same `ring`
   *  guard: a ring claim stores the placeId (a toy on the floor), which must
   *  never be handed back as something to sit on. */
  function ritualHeldSeat(session: QuestSession, cid: string): string | null {
    const sid = session.ritualSeat.get(cid);
    if (!sid) return null;
    for (const live of session.rituals.values()) {
      if (!live.heads.includes(cid)) continue;
      const tpl = session.ritualTemplates.find((t) => t.key === live.key);
      return tpl?.station.kind === "seat" ? sid : null;
    }
    return null;
  }

  /** The SEAT this body holds at a ritual being held at `placeId` — or null.
   *  Gated on the ritual's station being a seat at THIS place: a `ring` claim
   *  is the place itself (a toy on the floor), and handing that back as a chair
   *  to sit on would try to perch a diner on a ball. */
  function ritualSeatAt(session: QuestSession, cid: string, placeId: string): string | null {
    const sid = session.ritualSeat.get(cid);
    if (!sid) return null;
    for (const [k, live] of session.rituals) {
      if (live.placeId !== placeId || !live.heads.includes(cid)) continue;
      const tpl = session.ritualTemplates.find((t) => k.endsWith(`|${t.key}`));
      if (tpl?.station.kind === "seat") return sid;
    }
    return null;
  }

  /** Meter levels as FRACTIONS of each need's own threshold — the units a
   *  ritual call speaks, so one `level: 0.5` means the same on every world. */
  function ritualLevels(
    session: QuestSession,
    cid: string,
    templates: readonly NeedTemplate[],
  ): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of templates) {
      if (t.drive.kind !== "meter") continue;
      const th = t.drive.threshold || 1;
      out[t.key] = (session.needMeters.get(`${cid}|${t.key}`) ?? 0) / th;
    }
    return out;
  }

  // ── INVITATIONS ───────────────────────────────────────────────────────────
  // "you eat with me", "we play together" — a spoken invitation is NOT a new
  // activity and never becomes one (rituals.ts: a ritual introduces no new
  // action). It performs one of the ritual system's two existing entry
  // operations — DECLARE or JOIN — on somebody else's behalf, by lowering that
  // body's bar exactly the way a culture's mealtime `window` lowers everyone's.

  const inviteKey = (houseIndex: number, tplKey: string, cid: string) => `${houseIndex}|${tplKey}|${cid}`;

  /** THE RITUAL A NEED CALLS. Matched through the template's own `calls` — a
   *  STRONG call, the one that means "this need is what opens this gathering"
   *  — never a hard-coded eat→meal table, so a culture's authored rows work
   *  with no edit here. `needPrefix` is SATISFY_NEED_PREFIX's ("hunger:",
   *  "fun"), the same prefix convention the need-template keys use.
   *
   *  Weak calls are deliberately NOT considered: `social` is a weak call on
   *  BOTH shipped rituals, and letting it match would make "let's talk
   *  together" declare a dinner. A need no ritual is strongly called by simply
   *  has no gathering — see commandSatisfy for what happens then. */
  function ritualCalledBy(session: QuestSession, needPrefix: string): RitualTemplate | undefined {
    return session.ritualTemplates.find((t) =>
      t.calls.some((c) => c.kind === "strong" && c.tplKey.startsWith(needPrefix)),
    );
  }

  /** ASK a body to a gathering. Returns false when there is nothing to ask it
   *  to (no such ritual in this culture) — the caller then does the ordinary
   *  solo thing rather than inventing one. */
  function inviteToRitual(
    session: QuestSession,
    houseIndex: number,
    tpl: RitualTemplate,
    cid: string,
    by: string,
  ): boolean {
    if (!cid.startsWith("resident_") && !isPetCid(cid)) return false; // no body, no seat
    session.ritualInvites.set(inviteKey(houseIndex, tpl.key, cid), { by, t: tpl.gatherS });
    // An explicit asking outranks the abandon damper: the player (or a
    // housemate) SAID "we eat together", so the loop may declare again now.
    session.ritualRetry.delete(`${houseIndex}|${tpl.key}`);
    // An invitation is a JUNCTION: the body re-decides now, with the lowered
    // bar in force, instead of finishing whatever dormancy it was in.
    session.needDecideDorm.delete(cid);
    session.liveNeedBodies.add(cid);
    return true;
  }

  const invitedTo = (session: QuestSession, houseIndex: number, tplKey: string, cid: string): boolean =>
    session.ritualInvites.has(inviteKey(houseIndex, tplKey, cid));

  /** Drop every open invitation to one ritual — it started, or it died. */
  function clearRitualInvites(session: QuestSession, houseIndex: number, tplKey: string) {
    const prefix = `${houseIndex}|${tplKey}|`;
    for (const k of [...session.ritualInvites.keys()]) {
      if (k.startsWith(prefix)) session.ritualInvites.delete(k);
    }
  }

  /** Age out invitations. An invitation lives one `gatherS` — the same clock
   *  that decides how long a gathering waits for its heads decides how long an
   *  asking stands, so the two can never disagree. */
  function stepRitualInvites(session: QuestSession, dt: number) {
    for (const [k, inv] of session.ritualInvites) {
      const next = inv.t - dt;
      if (next <= 0) session.ritualInvites.delete(k);
      else session.ritualInvites.set(k, { ...inv, t: next });
    }
  }

  /** The fraction of the day a `window` is judged against. */
  const ritualDayF = (session: QuestSession): number =>
    (((session.townClock / session.scale.dayLengthS) % 1) + 1) % 1;

  /** The household's bodies + their resolved need rows, in the deterministic
   *  order stepNeeds uses. Resolved ONCE — every ritual reads the same set. */
  interface RitualBodySet {
    candidates: string[];
    rowsOf: Map<string, readonly NeedTemplate[]>;
  }
  function ritualBodySet(session: QuestSession, state: WorldState, houseIndex: number): RitualBodySet {
    const candidates: string[] = [];
    for (let m = 0; m < HOUSEHOLD; m++) {
      const cid = `resident_${houseIndex}_${m}`;
      if (state.avatars[cid]) candidates.push(cid);
    }
    for (const id of Object.keys(state.avatars)) {
      if (isPetCid(id) && houseIndexOfCid(id) === houseIndex) candidates.push(id);
    }
    candidates.sort();
    const rowsOf = new Map<string, readonly NeedTemplate[]>();
    for (const cid of candidates) {
      const house = residentTownCtx(session, houseIndexOfCid(cid))?.house;
      rowsOf.set(
        cid,
        isPetCid(cid) || !house
          ? petNeedTemplates(session)
          : residentNeedTemplates(session, houseIndex, house, Number(cid.split("_")[2])),
      );
    }
    return { candidates, rowsOf };
  }

  /** Everything ONE ritual is decided from, this instant: its place and the
   *  RitualCtx. Null when it has nowhere to be.
   *
   *  ONE builder, TWO callers — the per-frame tick and the spoken-invitation
   *  path. An invitation that was answered from a different context than the
   *  one the gathering then runs on is exactly how a creature ends up saying
   *  "I'll come" and never arriving. */
  function ritualCtxFor(
    session: QuestSession,
    state: WorldState,
    houseIndex: number,
    tpl: RitualTemplate,
    set: RitualBodySet,
    dayF: number,
    live: RitualState | null,
  ): { placeId: string; ctx: RitualCtx } | null {
    const placeId = live?.placeId ?? ritualPlaceFor(session, state, houseIndex, tpl);
    if (!placeId || !state.objects[placeId]) return null;
    const placeKind = fixtureKindOf(state, placeId);
    const bodies: RitualBody[] = set.candidates.map((cid) => ({
      id: cid,
      levels: ritualLevels(session, cid, set.rowsOf.get(cid) ?? []),
      eligible: ritualEligible(session, cid, tpl, placeKind, set.rowsOf.get(cid) ?? []),
      seated: ritualSeated(session, state, cid, placeId),
      invited: invitedTo(session, houseIndex, tpl.key, cid),
    }));
    return {
      placeId,
      ctx: {
        bodies,
        ready: tpl.prepare ? stackTotalOf(session.containerStock.get(placeId), tpl.prepare.category) : 0,
        capacity: ritualCapacity(session, state, tpl, placeId),
        dayF,
      },
    };
  }

  /** One tick of every ritual this household could be holding. Runs BEFORE
   *  `stepNeeds`, so the rows and bindings a body decides against this frame
   *  are this frame's. */
  function stepRituals(session: QuestSession, state: WorldState, dt: number) {
    const houseIndex = session.dollhouse;
    if (houseIndex === null || !world || !session.town) return;
    if (!residentTownCtx(session, houseIndex)?.house) return;
    stepRitualInvites(session, dt);
    const dayF = ritualDayF(session);
    const set = ritualBodySet(session, state, houseIndex);

    for (const tpl of session.ritualTemplates) {
      const key = `${houseIndex}|${tpl.key}`;
      const live = session.rituals.get(key);
      const resolved = ritualCtxFor(session, state, houseIndex, tpl, set, dayF, live ?? null);
      // The place went away mid-event (the toy was picked up, the table was
      // removed): the ritual has nowhere to be.
      if (!resolved) {
        if (live) retireRitual(session, key, live, "no place");
        continue;
      }
      const { placeId, ctx } = resolved;

      if (!live) {
        if (ctx.capacity <= 0) continue; // nowhere to put anybody
        // ABANDON BACKOFF: a gathering that just died unfed may not re-declare
        // until its heads have had a real chance to feed themselves solo —
        // otherwise the still-firing caller re-opens it on the next tick and
        // the declare junction wipes the very feed-myself step it needs.
        if ((session.ritualRetry.get(key) ?? 0) > session.townClock) continue;
        const caller = ritualCallers(tpl, ctx)[0];
        if (!caller) continue;
        const born = declareRitual(tpl, placeId, caller);
        if (!claimRitualStation(session, state, caller, tpl, born)) continue; // nowhere to sit — not yet
        session.rituals.set(key, born);
        ritualJunction(session, caller);
        console.log(`[ritual] house ${houseIndex} DECLARED ${tpl.key} at ${placeId} — called by ${caller}`);
        continue; // recruit on the next tick, against the declared roster
      }

      const step = stepRitual(tpl, live, ctx, dt);
      for (const cid of step.joined) {
        ritualJunction(session, cid);
        console.log(`[ritual] ${cid} joined ${tpl.key} (${step.next?.heads.length ?? 0} heads, bill ${step.next?.bill ?? 0})`);
      }
      // Every head without a station gets another attempt — see claimRitualStation.
      for (const cid of step.next?.heads ?? []) claimRitualStation(session, state, cid, tpl, live);
      for (const cid of step.left) releaseRitualStation(session, cid);
      for (const cid of step.completed) {
        // TAKING PART IS COMPANY: the meters the template names clear for
        // everyone who stayed to the end. The head's OWN satisfy (the meal it
        // ate, the game it played) already ran through its own need row — this
        // is only the part that comes from doing it together.
        for (const meter of tpl.relieves ?? []) session.needMeters.set(`${cid}|${meter}`, 0);
        releaseRitualStation(session, cid);
        session.needDecideDorm.delete(cid); // the event's end is a junction
      }
      if (step.next) {
        if (step.next.phase !== live.phase) {
          console.log(`[ritual] house ${houseIndex} ${tpl.key} → ${step.next.phase} (${step.next.heads.join(", ")})`);
          // The gathering has begun — every asking is answered, one way or the
          // other. Late arrivals belong to the NEXT one (the roster is frozen).
          if (step.next.phase === "perform") {
            clearRitualInvites(session, houseIndex, tpl.key);
            // THE SERVE IS A JUNCTION for every head: whoever was mid-attend
            // (a 2.5 s sit episode, or its pose show) re-decides NOW with the
            // meter un-suppressed, so everyone starts eating the moment the
            // performance opens instead of dwelling out a stale sit first.
            // The seat stays visibly held throughout — syncNeedActivities
            // derives the sit from the ritual itself, not from the step.
            for (const cid of step.next.heads) {
              ritualJunction(session, cid);
              session.needPoseShow.delete(cid);
            }
          }
        }
        session.rituals.set(key, step.next);
      } else {
        session.rituals.delete(key);
        clearRitualInvites(session, houseIndex, tpl.key);
        if (step.completed.length) console.log(`[ritual] house ${houseIndex} ${tpl.key} DONE — ${step.completed.join(", ")}`);
        else {
          // Died unfed — damp the re-declare (see `ritualRetry`).
          session.ritualRetry.set(key, session.townClock + RITUAL_RETRY_S);
          console.log(`[ritual] house ${houseIndex} ${tpl.key} abandoned`);
        }
      }
    }
  }

  /** Drop a ritual and free everyone it was holding. */
  function retireRitual(session: QuestSession, key: string, live: RitualState, why: string) {
    for (const cid of live.heads) {
      releaseRitualStation(session, cid);
      session.needDecideDorm.delete(cid);
    }
    const [hi, tplKey] = key.split("|");
    if (hi !== undefined && tplKey !== undefined) clearRitualInvites(session, Number(hi), tplKey);
    session.rituals.delete(key);
    console.log(`[ritual] ${key} retired — ${why}`);
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
        session.needDecideDorm.delete(cid); // command's end is a junction — decide fresh
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
          session.needDecideDorm.delete(cid); // wake — the hands changed
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
        session.needDecideDorm.delete(cid); // a re-shown house decides fresh
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
          session.needDecideDorm.delete(cid);
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
        // THE FURNITURE ANCHOR HOLDS IT ON THE FIXTURE: once the body has been
        // slid ONTO the piece it's using (furniture-anchor.ts pins it on the use
        // point, off `step.pos`), it has ARRIVED and is USING it — count that as
        // arrived so the rest/process dwell keeps ticking. Re-issuing a walk to the
        // (now distant) stand spot would only fight the anchor, which world-host
        // ignores for an anchored body anyway.
        // Anchored on the step's own fixture — OR on the CHAIR the step dines
        // from: a ritual head is already sitting on its claimed seat when the
        // meal lands, and the chair's computed stand spot can sit past the
        // arrive slack (the table's no-stand box pushes it out), so walking it
        // from the pinned seat stalls forever — the seat IS the destination.
        const anchoredToStep =
          (!!step.objId && body.anchor?.fixtureId === step.objId) ||
          (step.kind === "consume" && !!step.seatId && body.anchor?.fixtureId === step.seatId);
        const status: "arriving" | "arrived" | "gaveup" = anchoredToStep
          ? "arrived"
          : walkTo(session, cid, step.pos, dt, {
              // A leg that ends POSING ON a piece walks its stand spot properly —
              // the anchor's engage trigger is a small circle around that spot
              // (never a ring around the piece), so the default 1.3 m slack would
              // strand the body outside it: claiming, unengaged, dozing on the
              // floor beside its own bed.
              arrive: onFixturePieceId(state, step.objId) ? USE_LEG_ARRIVE : undefined,
              onReroute: () => {
                console.log(`[needs] ${cid} stalled en route to ${step.objId ?? "?"} — re-routing`);
                if (step.objId) {
                  delete step.seatId;
                  const raw = needObjectPos(session, state, houseIndex, step.objId);
                  if (raw) step.pos = needStandPoint(session, state, cid, step.objId, raw, { x: body.x, y: body.y }, step.kind === "rest");
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
        // toilet); everything else applies its elemental effect at once.
        if (step.kind === "rest") {
          step.dwell = (step.dwell ?? restDwellFor(step.tplKey, session.scale)) - dt;
          if (step.dwell > 0) continue; // sleeping / playing / washing
          session.needStep.delete(cid);
          session.needMeters.set(`${cid}|${step.tplKey}`, 0);
          showWorldBubble(state, `rest:${cid}`, {
            anchor: { kind: "avatar", id: cid },
            ...restDoneBubble(step.tplKey),
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
        // A MEAL WITH A CHAIR: SIT DOWN FIRST, then eat from the seat. The
        // dwell gives the furniture anchor its eased slide onto the chair
        // (syncNeedActivities shows the sit the moment the dwell starts), and
        // only then does the consume land — its eat show carries the seat, so
        // the diner stays visibly seated through the meal. The old order was
        // arrive → crouch-eat STANDING → only then slide onto the chair → pop
        // straight back up: "they eat, then sit down, then stand up".
        // Gated on actually STANDING AT the chair (same 1.6 the effect's own
        // seat gate uses) — a give-up that arrived in place across the room
        // keeps the ordinary standing crouch below.
        const dineSeat = step.kind === "consume" && step.seatId ? state.objects[step.seatId] : undefined;
        if (step.kind === "consume" && step.seatId && dineSeat &&
            Math.hypot(body.x - dineSeat.x, body.y - dineSeat.y) <= 1.6) {
          step.dwell = (step.dwell ?? SIT_BEFORE_EAT_S) - dt;
          if (step.dwell > 0) continue; // settling onto the chair
          session.needStep.delete(cid);
          applyNeedStepEffect(session, state, cid, step);
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
      // ── ON-THE-CLOCK DORMANCY (view-distance-lod-tiers.md step 2) ─────────
      // A body whose LAST decide found nothing sleeps until something could
      // change the answer: the earliest meter crossing (exact timer, armed
      // below), a loose-prop event (epoch), the spark demanding attention (an
      // active draw lowers effective thresholds; an engaged creature is the
      // "requires attention" tier and stays per-frame responsive), or the
      // safety-net cap for drives with no closed-form timer. Junctions are
      // implicit: only a null decide arms this, and every decide run clears
      // it — a finished step/pursuit/crouch re-decides on the very next tick.
      const dorm = session.needDecideDorm.get(cid);
      if (
        dorm &&
        session.townClock < dorm.due &&
        dorm.epoch === session.needsPropsEpoch &&
        !wasSparkActing &&
        !session.sparkDraw &&
        session.sparkFocus?.cid !== cid
      ) {
        continue;
      }
      // Idle-away time spans the whole slept gap, not just decide frames.
      const sinceDecide = dorm ? Math.max(dt, session.townClock - dorm.at) : dt;
      session.needDecideDorm.delete(cid);
      // DECIDE from live state (the shared template walker), then drive the body.
      const decided = decideNeeds(templates, (tpl) => residentNeedCtx(session, state, cid, houseIndex, tpl, templates));
      // PROVISIONING STAYS ON THE CLOCK while the house is UNWATCHED
      // (view-distance-lod-tiers.md): an unwatched household's restocking is the
      // BUILDING's need — the goods clock already walks a real shopper down the
      // street as a baked errand, with no per-frame rechecking. Starting the
      // same trip through the live loop instead PROMOTED the body into
      // `liveNeedBodies` — and since stock always trends below its buffer, the
      // need never stopped firing, so the body never demoted: it re-ran the
      // full decide/ctx resolution every frame forever (the sim-phase storm).
      // Only the TRIP START is gated (`take` implies empty hands): a body
      // already carrying units falls through and banks them — hands must
      // empty on every exit (§4).
      if (decided?.tpl.drive.kind === "stock" && !shown && decided.intent.kind === "take") {
        if (decided.tpl.exclusive) releaseErrands(session, cid); // back in the pool
        if (live) {
          // DEMOTE — the same hand-back as "nothing fires": the clock owns
          // this household's shopping again.
          const banked = bankCarried(session, cid, houseIndex);
          session.liveNeedBodies.delete(cid);
          releaseErrands(session, cid);
          reanchorHouseGoods(session, houseIndex);
          walkResidentHome(session, state, cid);
          console.log(
            `[needs] ${cid} DEMOTED (unwatched provisioning → clock${banked ? `; banked ${banked} carried` : ""})`,
          );
        }
        continue;
      }
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
      // The want is read off `decided.blocked` — the top unservable row — NOT
      // off the acted-on intent: a body that blocks on serve and goes to play
      // instead is still a body whose meal has nowhere to go, and the
      // housemates' adoption rows must keep seeing it.
      const blockedRow = decided?.blocked;
      if (blockedRow && !blockedRow.tpl.key.startsWith("adopt:")) {
        const at = blockedRow.tpl.satisfy.kind === "consume" ? (blockedRow.tpl.satisfy.at ?? ["table"]) : [];
        session.blockedNeeds.set(cid, {
          tplKey: blockedRow.tpl.key,
          goodKey: blockedRow.tpl.item.category ?? "",
          at,
          priority: blockedRow.tpl.priority,
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
          const t = (session.idleAway.get(cid) ?? 0) + sinceDecide;
          let graceLeft = Infinity;
          if (t >= HOME_IDLE_GRACE_S) {
            session.idleAway.delete(cid);
            walkResidentHome(session, state, cid);
          } else {
            session.idleAway.set(cid, t);
            // The walk-home check above must RUN again when the grace expires —
            // a sleep armed past it stranded commanded creatures at their
            // errand's endpoint until the next meter fired ("never came back").
            graceLeft = HOME_IDLE_GRACE_S - t;
          }
          // ARM the sleep: wake exactly when the earliest meter can newly
          // fire; a non-meter drive in the set (stock/mess) bounds it at the
          // safety-net cap, a pending walk-home grace bounds it at its expiry.
          // (A LIVE null decide demoted above instead — it re-decides once
          // un-live before it can sleep.)
          session.needDecideDorm.set(cid, {
            due:
              session.townClock +
              needDormDueIn(
                templates,
                (k) => session.needMeters.get(`${cid}|${k}`) ?? 0,
                NEED_DECIDE_CAP_S,
                graceLeft,
              ),
            epoch: session.needsPropsEpoch,
            at: session.townClock,
          });
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
      // SOFT CONTROL (attention-spark.md): a spark-PROMOTED chore (sparkActing,
      // consumed at the loop top) announces its intent before acting; routine
      // self-directed needs stay quiet. Meter-driven attention acts no longer
      // fire through this loop — performAttentionAction targets the specific
      // indicated instance and announces on its own.
      // ── S2: THE SELF-ASSIGNED COMMAND ─────────────────────────────────────
      // The clean motives ride the unified pursuit engine: map the decided
      // (template, intent) to GoalSpec candidates (need-goals.ts) and install
      // the first that COMPILES as a `source: "need"` pursuit — the same loop a
      // spoken order runs. A candidate that can't compile falls through to the
      // legacy walker THIS tick (the degradation seam: market shelves and the
      // well are invisible to the item resolver until S3, so those trips —
      // restock sizing, purse accounting — stay on the stack machinery).
      // A RITUAL HEAD'S DINNER STAYS ON THE LEGACY WALKER: it must eat FROM THE
      // SEAT IT ALREADY HOLDS (`ritualSeatAt` in the step below — "the eat
      // needs no move at all"), while the pursuit's consume goal plans a walk
      // to the served item's own spot on the tabletop — which stood the seated
      // diner up, marched it around the table, and ate the meal standing.
      const ritualSeatDine =
        intent.kind === "consumeAt" && !!ritualSeatAt(session, cid, intent.station.id);
      if (!ritualSeatDine && NEED_PURSUITS_ENABLED && (session.needPursuitCooldown.get(`${cid}|${tpl.key}`) ?? 0) <= session.townClock) {
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
            if (probesOn() && !session.liveNeedBodies.has(cid)) console.log(`[needs] ${cid} PROMOTED to live (${tpl.key} → pursuit)`);
            session.liveNeedBodies.add(cid);
            session.needStep.delete(cid);
            session.walk.delete(cid); // the pursuit starts its walk fresh
            session.pursuits.set(cid, { source: "need", tplKey: tpl.key, goal, glyph: tpl.key });
            if (wasSparkActing) announceSparkIntent(session, cid, goal);
            if (probesOn()) console.log(`[needs] ${cid} pursuit: ${goal.kind} (${tpl.key})`);
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
      if (intent.kind === "setOutHere") {
        // GET THE TOY OUT — the whole of "a play area appears". The unit leaves
        // the hands and becomes a REAL loose prop on open ground a step in
        // front of the body, and the SAME pass installs this body as its first
        // player, so the area is live from the instant it lands. That atomicity
        // is the point: a prop that exists for even one decide as unclaimed
        // clutter gets banked by the tidy chore (which outranks fun) or carried
        // off by the next bored housemate, and the set-out spins forever.
        //
        // The move itself is `dropFromStack` — take from the hand FIRST, make
        // the prop SECOND, put it back if the world refuses it — so the unit
        // can never be in both places or in neither (item conservation).
        const bag = session.needCarried.get(cid) ?? {};
        const glyph = Object.keys(bag).find((k) => (bag[k] ?? 0) > 0 && matchesNeedItem(k, tpl.item));
        if (!glyph) continue; // hands emptied mid-decide — re-decide next tick
        const bodyR = world.npcRadiusOf(avatarIdOf(cid));
        const heading = Math.hypot(body.fx, body.fy) > 1e-3 ? { x: body.fx, y: body.fy } : { x: 1, y: 0 };
        // OPEN SPACE, not underfoot: a step in front, nudged to somewhere a
        // body could actually stand — the players have to be able to ring it.
        const front = { x: body.x + heading.x * SET_OUT_AHEAD_M, y: body.y + heading.y * SET_OUT_AHEAD_M };
        const spot = nearestClearSpot(state, front, { x: body.x, y: body.y }, bodyR, standAvoid(cid));
        const propId = dropFromStack(session, bag, glyph, spot.x, spot.y);
        if (!propId) continue; // nothing moved — the unit is still in hand
        if (Object.keys(bag).length === 0) session.needCarried.delete(cid);
        session.liveNeedBodies.add(cid);
        session.needStep.set(cid, {
          tplKey: tpl.key,
          kind: "rest",
          goodKey,
          ...(tpl.item.affords ? { affords: tpl.item.affords } : {}),
          objId: propId,
          pos: playRingSpot(state, spot, { x: body.x, y: body.y }, bodyR, standAvoid(cid)),
          units: 1,
        });
        showWorldBubble(state, `play:${cid}`, {
          anchor: { kind: "avatar", id: cid },
          text: "",
          glyph,
          ttl: 2,
        });
        console.log(`[needs] ${cid} SET OUT ${glyph} as a play area (${propId})`);
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
      // A RITUAL HEAD EATS AT THE SEAT IT ALREADY HOLDS — claimed when it
      // joined and walked to during the gathering, so by the time the meal
      // lands the body is already on it and the eat needs no move at all. Only
      // a solo, ritual-less meal still hunts for a free chair here.
      const ritualSeatId =
        intent.kind === "consumeAt" ? ritualSeatAt(session, cid, intent.station.id) : null;
      const ritualSeatObj = ritualSeatId ? state.objects[ritualSeatId] : undefined;
      const seat =
        intent.kind === "consumeAt" && intent.station.kind === "table"
          ? ritualSeatObj
            ? { id: ritualSeatId!, x: ritualSeatObj.x, y: ritualSeatObj.y }
            : freeSeatAt(session, state, cid, intent.station.id)
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
          nearestClearSpot(state, { x: seat.x, y: seat.y }, { x: body.x, y: body.y }, world.npcRadiusOf(avatarIdOf(cid)), standAvoid(cid))
        : intent.kind === "socialize"
          ? (() => {
              const pav = chatAvatar(state, target.id);
              return pav ? { x: pav.x, y: pav.y } : null;
            })()
          : (() => {
              // Solid fixtures (beds/tables/chests) are unreachable at their
              // CENTER — walk to the stand-beside spot instead; a PLAY AREA on
              // the floor is ringed rather than stood on (needStandPoint).
              const raw = needObjectPos(session, state, houseIndex, target.id);
              return raw
                ? needStandPoint(session, state, cid, target.id, raw, { x: body.x, y: body.y }, intent.kind === "restAt")
                : null;
            })();
      if (!pos) continue;
      if (probesOn() && !session.liveNeedBodies.has(cid)) console.log(`[needs] ${cid} PROMOTED to live (${tpl.key})`);
      if (probesOn()) console.log(`[needs] ${cid} step: ${intent.kind} ${goodKey || tpl.key} @ ${target.id}`);
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
        // controller only reaches its point at ERRAND_ARRIVE 0.9. A CHAIR meal
        // additionally covers the settle-onto-the-seat dwell and the longer
        // seated show (sit → eat → rise).
        const last = legs.points[legs.points.length - 1];
        if (last) last.dwell = seat ? SIT_BEFORE_EAT_S + EAT_SIT_SHOW_S + 1 : EAT_SHOW_S + 1;
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
      // Settlers (city-founding ② — `npc_settler_*`) are ordinary creatures
      // too: they claim buildwork, so the build-loop pose show must reach
      // their bodies like any resident's.
      if (!id.startsWith("resident_") && !id.startsWith("pet_") && !id.startsWith("npc_settler_"))
        continue;
      const cidForHold = creatureOfAvatar(id) ?? id;
      // A body mid ACTION HOLD crouches (the "sit" rig) for the whole beat — the
      // reach/carry gesture the effect fires plays over it, so the action and its
      // animation are welded and the body is visibly stationary. Highest priority.
      const holdRec = session.actionHold.get(id) ?? session.actionHold.get(cidForHold);
      if (holdRec) {
        // A hold with a SEAT sits ON it (anchored — the dinner chair); a plain
        // hold is the crouch-in-place beat.
        av.activity = holdRec.seatId ? { kind: "sit", objId: holdRec.seatId } : { kind: "sit" };
        continue;
      }
      const step = session.needStep.get(id);
      let act: AvatarActivity | undefined;
      // A rest step's dwell only counts down while the body is AT the spot
      // (arrival range mirrors stepNeeds) — the activity shows exactly then.
      // Fun plays, the bath and toilet SIT (the crouch rig), everything else sleeps.
      // A body the furniture anchor has slid ONTO the step's fixture (asleep on
      // its bed, sat on its toilet) is legitimately "at the spot" even though the
      // pin moved it off `step.pos` (the stand spot) onto the fixture centre — so
      // the activity must persist, or clearing it would release the anchor and the
      // body would slide off and back on forever (the flap the sticky anchorId
      // decision below already guards against for the SHOW).
      const anchoredAtStep = !!step?.objId && av.anchor?.fixtureId === step.objId;
      if (
        step?.kind === "consume" &&
        step.seatId &&
        step.dwell !== undefined &&
        step.dwell > 0 &&
        (av.anchor?.fixtureId === step.seatId ||
          Math.hypot(av.x - step.pos.x, av.y - step.pos.y) <= 1.3)
      ) {
        // SETTLING ONTO THE CHAIR before the meal (SIT_BEFORE_EAT_S): the sit
        // names the seat so the furniture anchor slides the body on; the eat
        // show then takes over the SAME seat with no gap — the diner is seated
        // before the first bite and stays seated through it.
        act = { kind: "sit", objId: step.seatId };
      } else if (
        (step?.kind === "rest" || step?.kind === "process") &&
        step.dwell !== undefined &&
        step.dwell > 0 &&
        (anchoredAtStep || Math.hypot(av.x - step.pos.x, av.y - step.pos.y) <= 1.3)
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
        // PLAYERS FACE THE GAME. A ringed play area has no facing of its own to
        // borrow (it is a thing on the floor, not a fixture with a front), and
        // the body arrives pointing however it walked in — so aim it at the
        // station while it plays. That is also what puts the toy inside the
        // play pose's own working area (the animator strokes at a spot in
        // FRONT of the body), so bodies on opposite sides both reach it.
        // (Floor stations only — an on-fixture use takes its facing from the
        // fixture's own use contract, through the anchor.)
        const at = objId && session.smallProps.has(objId) ? state.objects[objId] : undefined;
        if (at && step.kind === "rest") {
          const dx = at.x - av.x;
          const dy = at.y - av.y;
          const d = Math.hypot(dx, dy);
          if (d > 1e-3) {
            av.fx = dx / d;
            av.fy = dy / d;
          }
        }
        act =
          step.tplKey === "fun"
            ? { kind: "play", objId }
            : // ATTENDING a ritual is a SIT on the claimed seat — set the moment
              // the body ARRIVES and held for the whole gathering, which is what
              // makes it walk to its chair and sit down rather than stand beside
              // one and be slid on at the moment it eats.
              step.tplKey.startsWith("attend:") ||
                step.tplKey === "hygiene" ||
                step.tplKey === "waste" ||
                step.kind === "process"
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
          // station (or immediately, posing in place). EDGE-RELATIVE: the reach
          // is measured from the piece's own footprint, never from its centre —
          // a flat 1.6 m read a wide bed as "not reached" from the very stand
          // spot the walk aimed at, so the claim never appeared and the anchor
          // had nothing to slide onto (the sleeper stayed on the floor). Wider
          // than the anchor's own engage reach on purpose: the claim must exist
          // before the anchor can act on it.
          const st = pose.objId ? state.objects[pose.objId] : undefined;
          const stSpec = pose.objId ? state.spec.objects.find((o) => o.id === pose.objId) : undefined;
          if (!st || Math.hypot(av.x - st.x, av.y - st.y) <= (stSpec?.radius ?? 0) + POSE_REACH_M) {
            act = { kind: pose.kind, objId: pose.objId };
          }
        }
      }
      // A RITUAL HEAD AT ITS CHAIR STAYS SEATED — derived from the ritual
      // itself, never from the step. Attending is delivered as short episodes
      // (RITUAL_SIT_S sits with a re-decide between them, so a landing meal or
      // a pressing need can interrupt), and each between-episode gap cleared
      // `activity` for a frame or two — which released the furniture anchor and
      // visibly stood the body up before the next sit slid it back on: the
      // observed sit-down/stand-up fidget at the table. While the body's
      // occupation is still this dinner (attending, eating, or momentarily
      // deciding), the seat it holds IS its pose.
      if (!act) {
        const seatId = ritualHeldSeat(session, cidForHold);
        const seat = seatId ? state.objects[seatId] : undefined;
        if (seat) {
          const occ =
            session.needStep.get(cidForHold)?.tplKey ?? session.pursuits.get(cidForHold)?.tplKey;
          const atDinner = !occ || occ.startsWith("attend:") || occ.startsWith("hunger:") || occ.startsWith("thirst:");
          const spec = state.spec.objects.find((s) => s.id === seatId);
          const near =
            av.anchor?.fixtureId === seatId ||
            Math.hypot(av.x - seat.x, av.y - seat.y) <= (spec?.radius ?? 0.3) + 0.7;
          if (atDinner && near && seatId) act = { kind: "sit", objId: seatId };
        }
      }
      if (act) av.activity = act;
      else if (av.activity) delete av.activity;
    }
  }

  // ── INDOOR EGRESS (strays walked out) ─────────────────────────────────
  // Free wander has no router (§1.2): a body left IDLE inside a building it
  // doesn't belong to — a recruited builder whose walls just rose around
  // it, a demolition worker, a hauler, a settler — draws its roam
  // candidates near its far-away home, fails them all, and stands pinned
  // indoors forever (the controller now honestly stands rather than
  // blind-aiming through the wall). The HOST owns routing, so the host
  // walks strays out: a door-routed errand to the first OUTDOOR point on
  // the way to the town's open ground; outside, the normal wander resumes.
  // Residents/pets idle in their OWN house are home, not stray — their
  // idle pad is their ground and walkResidentHome owns them.
  let egressSweepT = 0;
  /** First time a body was seen idle-indoors-stray — the grace timer, so a
   *  summoned visitor or a between-tasks builder isn't marched out the
   *  moment it pauses. Cleared whenever the body disqualifies. */
  const egressIdleSince = new Map<string, number>();
  const EGRESS_SWEEP_S = 1.5;
  const EGRESS_GRACE_S = 6;
  function stepIndoorEgress(session: QuestSession, state: WorldState, dt: number) {
    if (!world) return;
    egressSweepT += dt;
    if (egressSweepT < EGRESS_SWEEP_S) return;
    egressSweepT = 0;
    const ref = session.town?.stage.center ?? session.foundedSite?.at;
    if (!ref) return;
    const now = state.time;
    for (const [id, av] of Object.entries(state.avatars)) {
      if (!id.startsWith("resident_") && !id.startsWith("pet_") && !id.startsWith("npc_settler_"))
        continue;
      const disqualify = () => egressIdleSince.delete(id);
      const b = buildingAt(state, av.x, av.y);
      if (!b) { disqualify(); continue; }
      // Own house = home (the member/pet id carries its house index; a
      // settler's parse is NaN and never matches).
      const own = houseIndexOfBuildingId(b.id);
      if (own !== null && own === Number(id.split("_")[1])) { disqualify(); continue; }
      const cid = creatureOfAvatar(id) ?? id;
      // Anything already driving the body owns it — the sweep takes only
      // the truly idle (the exact state the wander bug strands them in).
      if (
        world.npcErrandActive(id) ||
        (session.npcTasks.get(id)?.length ?? 0) > 0 ||
        session.needStep.has(id) ||
        session.needStep.has(cid) ||
        session.needEatShow.has(id) ||
        session.needPoseShow.has(id) ||
        session.actionHold.has(id) ||
        session.actionHold.has(cid) ||
        session.transfers.executing(cid) ||
        (possession.creatureId !== null && avatarIdOf(possession.creatureId) === id) ||
        (convo !== null && session.lastConvoCid === cid)
      ) {
        disqualify();
        continue;
      }
      const since = egressIdleSince.get(id);
      if (since === undefined) {
        egressIdleSince.set(id, now);
        continue;
      }
      if (now - since < EGRESS_GRACE_S) continue;
      // Walk it OUT: the door graph names the way (transit points straddle
      // real doorways); the first point past the exterior wall is open
      // ground, and the errand's own router threads the indoor legs. With
      // no door path the fallback aim is the ref itself — no worse than
      // the blind roam this replaces, and the errand watchdogs own it.
      const out =
        routeThroughDoors(state, { x: av.x, y: av.y }, ref, 1.3).find(
          (p) => !buildingAt(state, p.x, p.y),
        ) ?? ref;
      egressIdleSince.delete(id);
      enqueueNpcErrand(session, id, { points: [{ x: out.x, y: out.y }] });
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
      const av = state.avatars[cid];
      // EMPTIED hands put down; SWAPPED hands (a clean shirt for the dirty one)
      // are quiet — nothing left the body, so nothing reaches. An evicted body
      // has no avatar left to play either, and the token just goes.
      const left =
        av &&
        setDownFromHands(
          session,
          cid,
          { kind: "consumed" },
          {
            objId: rec.objId,
            quiet: glyph !== null,
            reachAt: { x: av.x + av.fx, y: av.y + av.fy },
          },
        );
      if (!left) world.removeObject(rec.objId);
      session.needProps.delete(cid);
    }
    // Dress every carrying body that lacks its prop (commanded bodies excepted).
    for (const [id, av] of Object.entries(state.avatars)) {
      if (!id.startsWith("resident_") && !id.startsWith("pet_")) continue;
      if (session.needProps.has(id)) continue;
      if ((session.npcTasks.get(id)?.length ?? 0) > 0) continue;
      const glyph = repGlyph(id);
      if (!glyph) continue;
      // A SHADOW: the units are already counted in `needCarried`, so this is the
      // picture of them and must never be findable as a loose instance. The
      // reach aims where the body faces — it just turned to the box or the
      // floor spot the unit came from.
      const objId = takeIntoHands(
        session,
        id,
        { kind: "glyph", glyph, at: { x: av.x, y: av.y }, id: `needprop:${id}`, shadow: true },
        { reachAt: { x: av.x + av.fx, y: av.y + av.fy } },
      );
      if (!objId) continue;
      session.needProps.set(id, { objId, glyph });
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
    // the table from the barrel/well, waste at the toilet, grime at the bath, and
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
      );
      // RITUAL ROWS — derived, and only while one is actually live (the
      // adoptionTemplates pattern). This is where "the table is a larder the
      // household must keep topped up forever" went: cooking and laying the
      // table are now things you do FOR AN EVENT, sized to the heads coming.
      out.push(...ritualRowsFor(session, houseIndex, `resident_${houseIndex}_${member}`, member === cook));
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

  /** THE ROWS A LIVE RITUAL PUTS ON A HOUSEHOLD MEMBER — derived per tick from
   *  `session.rituals`, never stored, exactly like `adoptionTemplates`. Three,
   *  and each exists only while there is an event to serve:
   *
   *    prep    lay the place: carried or loose ritual items go ON it, up to the
   *            BILL (one portion per head coming) — not up to a shelf cap.
   *            Every member gets it: a housemate who happens to be holding a
   *            hot meal helps with dinner whether or not they are eating.
   *    cook    make what nobody has: raw food → `hot` at the oven, paced by the
   *            same bill. ⚠️ THE COOK-ONLY RULE IS LOAD-BEARING and unchanged —
   *            a transform fires on ANY matching carried unit, so a member who
   *            also shops for food would hijack its own grocery haul into the
   *            pot one apple at a time and the pantry would never fill.
   *    attend  take your seat and stay (see `ritualAttendTemplate` for why 1.5).
   *            HEADS ONLY — the helper who cooked but isn't eating has no seat.
   *
   *  Cooking is FOOD-CHAIN knowledge, not ritual-generic: a ritual that
   *  prepares some other category is supplied by the prep row's acquire
   *  branches alone (you fetch it, you don't cook it). */
  function ritualRowsFor(
    session: QuestSession,
    houseIndex: number,
    cid: string,
    isCook: boolean,
  ): NeedTemplate[] {
    const out: NeedTemplate[] = [];
    for (const tpl of session.ritualTemplates) {
      const live = session.rituals.get(`${houseIndex}|${tpl.key}`);
      if (!live) continue;
      const head = live.heads.includes(cid);
      if (tpl.prepare && tpl.prepare.perHead > 0) {
        const bill = live.bill;
        out.push({ ...ritualPrepTemplate(tpl.prepare.category, bill), key: `prep:${tpl.key}` });
        if (isCook && tpl.prepare.category === "meal") {
          out.push({ ...cookTemplate("food", "meal", bill), key: `cook:${tpl.key}` });
        }
      }
      if (head && tpl.station.kind === "seat") out.push(ritualAttendTemplate(tpl.key, tpl.station.fixture));
    }
    return out;
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

  /** THE OBJECT'S DESIGNATED CONTAINER — where a glyph BELONGS, and so where
   *  tidying returns it, where a give-up banks it and where a fetch looks
   *  first. The ladder itself is the pure designatedContainerId
   *  (kernel/town/container-home.ts); this wires the live session facts in. */
  function designatedContainerFor(
    session: QuestSession,
    glyph: string,
    houseIndex: number,
    cid?: string,
  ): string {
    return designatedContainerId(glyph, houseIndex, {
      provisionedHeads: provisionedHeads(session, houseIndex),
      ownerId: session.creatures?.world.items[glyph]?.ownerId,
      selfId: cid,
      exists: (id) => session.containers.has(id),
    });
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

  /**
   * WHO IS PLAYING at this loose prop right now — the live PLAY AREA.
   *
   * A thing set out on the floor is a TEMPORARY STATION: it exists as a place
   * to play only while somebody is actually playing at it, and the instant the
   * last player stops it is ordinary clutter again and the tidy chore files it.
   * That lifetime is DERIVED, never a registry — nothing to leak, nothing to
   * wedge open, and no way for a body that died mid-play to keep a toy pinned
   * out of the toybox forever.
   *
   * Two ways to count as a player, and both are needed:
   *   • the body is POSED on it (`activity.play` naming the prop) — the visible
   *     truth, and what keeps the area alive for everyone else mid-game;
   *   • the body's own rest-shaped step names it — which covers the walk, and
   *     critically the instant of SET-OUT, when the setter has put the toy down
   *     but has not yet reached it. Without that second arm there is a window in
   *     which the toy is loose, unowned and un-played-with, and the tidy chore
   *     (which outranks fun) banks it straight back into the box — the take-out/
   *     put-back spin, one layer up from the carried case `inUseByLiveNeed`
   *     already guards.
   * Kept general on purpose: any rest-shaped step at a loose prop is a use of
   * it, whatever motive asked for it.
   */
  function playersAt(session: QuestSession, state: WorldState, objId: string): string[] {
    const players = new Set<string>();
    for (const [id, av] of Object.entries(state.avatars)) {
      if (av.activity?.kind === "play" && av.activity.objId === objId) players.add(creatureOfAvatar(id) ?? id);
    }
    for (const [cid, step] of session.needStep) {
      if (step.kind === "rest" && step.objId === objId) players.add(cid);
    }
    return [...players];
  }

  /** Is this loose prop a LIVE PLAY AREA (someone is playing at it)? While it
   *  is, it is a STATION others may join — never clutter to sweep, and never a
   *  loose unit to pick up and carry off mid-game.
   *
   *  A ritual's PLACE counts even when nobody is mid-play: during a gathering
   *  the callers are walking to it, not yet playing at it, and without this the
   *  toy the whole event is about would read as clutter and get swept up out
   *  from under it. (The event's own retirement is what ends the exemption —
   *  the ritual is the thing keeping it alive, so no separate grace is needed.) */
  function isPlayArea(session: QuestSession, state: WorldState, objId: string): boolean {
    for (const live of session.rituals.values()) if (live.placeId === objId) return true;
    return playersAt(session, state, objId).length > 0;
  }

  /** Where a body STANDS to use `objId` for a need step. A FIXTURE is
   *  approached at its edge, on its declared use side (standPointFor); a thing
   *  set out ON THE FLOOR is RINGED instead (playRingSpot), so several players
   *  gather round one toy each on their own side. The distinction is the
   *  OBJECT, not the motive: you stand beside a bed and around a ball. `ring`
   *  gates it to rest-shaped steps — a tidy pickup still walks straight at the
   *  prop it is bending down for. */
  function needStandPoint(
    session: QuestSession,
    state: WorldState,
    cid: string,
    objId: string,
    raw: { x: number; y: number },
    from: { x: number; y: number },
    ring: boolean,
  ): { x: number; y: number } {
    const bodyR = world?.npcRadiusOf(avatarIdOf(cid));
    return ring && session.smallProps.has(objId)
      ? playRingSpot(state, raw, from, bodyR, standAvoid(cid))
      : standPointFor(state, objId, raw, from, bodyR, standAvoid(cid));
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
  /** PER-HOUSE CONTAINER INDEX (view-distance-lod-tiers.md step 3): the hot
   *  paths — need decides, the per-frame housekeeping loops — must never sweep
   *  the CITY's containerStock to find ONE household's boxes. `furn_<hi>_*`
   *  keys are effectively append-only (the map's only delete is the
   *  construction site's non-furn key), so the index rebuilds lazily when the
   *  key COUNT changes, with a 1 s townClock staleness cap as belt-and-braces.
   *  Built in the map's own insertion order, so per-house iteration — and
   *  every first-match pick over it — is identical to the full sweep it
   *  replaces. Values are read live from containerStock at use time. */
  const houseContainerIdx = new WeakMap<QuestSession, { n: number; at: number; byHouse: Map<number, string[]> }>();
  function houseContainerKeys(session: QuestSession, houseIndex: number): readonly string[] {
    const c = houseContainerIdx.get(session);
    if (c && c.n === session.containerStock.size && session.townClock - c.at < 1) {
      return c.byHouse.get(houseIndex) ?? [];
    }
    const byHouse = new Map<number, string[]>();
    for (const id of session.containerStock.keys()) {
      const m = /^furn_(\d+)_/.exec(id);
      if (!m) continue;
      const hi = Number(m[1]);
      const list = byHouse.get(hi);
      if (list) list.push(id);
      else byHouse.set(hi, [id]);
    }
    houseContainerIdx.set(session, { n: session.containerStock.size, at: session.townClock, byHouse });
    return byHouse.get(houseIndex) ?? [];
  }

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
      for (const id of houseContainerKeys(session, houseIndex)) {
        const stock = session.containerStock.get(id);
        if (!stock) continue;
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
    // RITUAL role (rituals.ts): the live event's PLACE — the table dinner is
    // being laid on, the floor the game is set out on. The prep row deposits
    // into it; the cook row's stock DRIVE measures it in the drive's `of`
    // category (meals) while the template itself acquires raw food.
    //
    // ⚠️ `room` comes from the RITUAL'S BILL, never a fixture capacity. That
    // one expression is the difference between "keep the table stocked" and
    // "lay it for the people coming": no ritual, no role, no cooking.
    if (
      (tpl.satisfy.kind === "deposit" && tpl.satisfy.container === "ritual") ||
      (tpl.drive.kind === "stock" && tpl.drive.container === "ritual")
    ) {
      const live = ritualOfTemplate(session, houseIndex, tpl.key);
      if (live && state.objects[live.placeId]) {
        const measure =
          tpl.drive.kind === "stock" && tpl.drive.container === "ritual" && tpl.drive.of
            ? tpl.drive.of
            : goodKey;
        const units = stackTotalOf(session.containerStock.get(live.placeId), measure);
        containers.ritual = { id: live.placeId, place: P(live.placeId), units, room: Math.max(0, live.bill - units) };
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
    // SOURCES: water is drawn free at a town WELL — the plaza's or the
    // NEAREST neighborhood one (needs-aware construction lays one per
    // thirst-radius quarter); anything else is a market buy. Both need grasp
    // (a bucket to work, a purse to pay). A member cooling off a good (it
    // arrived to an empty shelf) sees no source at all until the cooldown
    // lapses — no empty-handed loops.
    let sources: StockCandidate[] = [];
    if (grasp) {
      if (goodKey === "water") {
        if (!rc.neighbor) {
          const body = state.avatars[cid];
          const wells: Array<{ id: string; d: number }> = [];
          for (const [oid, o] of Object.entries(state.objects)) {
            if (!isWellId(oid)) continue;
            wells.push({ id: oid, d: body ? Math.hypot(o.x - body.x, o.y - body.y) : 0 });
          }
          // Nearest-first (the NeedCtx contract); id as the deterministic tie.
          wells.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
          sources = wells.map((w) => ({ id: w.id, place: P(w.id), units: 99 })); // wells never run dry
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
    // bath / toilet); a social partner is a HOUSEMATE (people and pets),
    // nearest-first from live positions.
    let stations: StationCandidate[] = [];
    if (tpl.satisfy.kind === "consume") {
      // THE STAMPEDE GUARD: a housemate ALREADY acting on this same row (its
      // pursuit or needStep carries the tplKey) is a diner in flight — a
      // served meal it is walking to must not also count as "waiting" for
      // everyone deciding after it. Without this, one banana on the table drew
      // ALL the hungry (the combine preempts acquisition), the losers churned
      // at the empty plate, and NOBODY fell through to the market — the
      // observed famine orbit. Subtracting the in-flight diners sends the
      // surplus hungry to acquisition, which at a source is a restock-sized
      // trip: the market run that actually breaks the famine.
      let inFlight = 0;
      for (let m2 = 0; m2 < HOUSEHOLD; m2++) {
        const other = `resident_${houseIndex}_${m2}`;
        if (other === cid) continue;
        if (session.pursuits.get(other)?.tplKey === tpl.key || session.needStep.get(other)?.tplKey === tpl.key) {
          inFlight++;
        }
      }
      for (const kind of tpl.satisfy.at ?? ["table"]) {
        const sid = `furn_${houseIndex}_${kind}`;
        if (state.objects[sid]) {
          // A FOOD want also counts waiting MEALS (round 7): a served
          // hot dish on the table pulls the hungry straight to it (the
          // acquire+consume combine — the dinner scene).
          const waiting =
            stackTotalOf(session.containerStock.get(sid), goodKey) +
            (goodKey === "food" ? stackTotalOf(session.containerStock.get(sid), "meal") : 0);
          // ⚠️ THE STAMPEDE GUARD DOES NOT APPLY TO YOUR OWN PLACE AT A RITUAL.
          // A ritual's bill is already one portion PER HEAD, so the food on the
          // table is reserved by construction and there is nothing to race for.
          // Subtracting the in-flight housemates there is actively wrong, and
          // was observed to deadlock a laid dinner: a housemate elsewhere in the
          // house pursuing its own hunger made the SEATED head read its own
          // plate as 0, so hunger blocked, `attend` held it in the chair, and it
          // sat looking at a meal it would not eat until the ritual timed out.
          const mine = [...session.rituals.values()].some(
            (r) => r.placeId === sid && r.heads.includes(cid),
          );
          stations.push({ id: sid, place: P(sid), kind, waiting: mine ? waiting : Math.max(0, waiting - inFlight) });
        }
      }
    } else if (tpl.key.startsWith("attend:")) {
      // ATTENDING a ritual rests at THIS BODY'S OWN CLAIMED STATION, never at
      // "a chair" — the seat was claimed when it joined and is what makes the
      // walk a walk TO A PLACE AT THE TABLE. `requireStation` then means a head
      // that somehow holds no seat simply doesn't attend (it blocks, which
      // shadows nothing) instead of resting against arbitrary furniture.
      const sid = session.ritualSeat.get(cid);
      if (sid && state.objects[sid] && needObjectPos(session, state, houseIndex, sid)) {
        stations = [{ id: sid, place: P(sid), kind: fixtureKindOf(state, sid), waiting: 0 }];
      }
    } else if (tpl.satisfy.kind === "rest" || tpl.satisfy.kind === "transform") {
      // Dwell stations (bed / box / bath / toilet) — a TRANSFORM works at
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
    } else if (tpl.satisfy.kind === "use") {
      // PLAY AREAS as stations. A toy SET OUT on the floor and currently in use
      // is not clutter to pick up — it is somewhere to GO AND PLAY, and anyone
      // whose own want fires may join it from a free side (the ring spot picks
      // the side; the crowding rule keeps the players apart). Same house scope
      // as the loose lists below, nearest-first. Decided BEFORE the acquire
      // branches, which is what makes the second bored body walk to the game
      // already in progress instead of fetching a second ball.
      const house = rc.house;
      const body = state.avatars[cid];
      if (house) {
        const x0 = rc.center.x + house.dx;
        const y0 = rc.center.y + house.dy;
        const areas: { c: StationCandidate; d: number }[] = [];
        for (const [objId, rec] of session.smallProps) {
          if (!matchesNeedItem(rec.glyph, tpl.item)) continue;
          const o = state.objects[objId];
          if (!o || o.carriedBy || o.containedIn) continue;
          if (o.x < x0 || o.x > x0 + house.w || o.y < y0 || o.y > y0 + house.h) continue;
          if (!isPlayArea(session, state, objId)) continue;
          areas.push({
            c: { id: objId, place: P(objId), kind: "play", waiting: 0 },
            d: body ? Math.hypot(o.x - body.x, o.y - body.y) : 0,
          });
        }
        areas.sort((a, b) => a.d - b.d || (a.c.id < b.c.id ? -1 : 1));
        stations = areas.map((a) => a.c);
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
    //
    // A LIVE PLAY AREA IS NEVER LOOSE — whichever flavor. A toy somebody is
    // playing at is a station (listed above), so it must not ALSO read as a
    // unit to pick up: the tidy chore would sweep the game away mid-play (the
    // exemption, one layer up from the carried case), and the fun row itself
    // would send a second bored body to carry off the very ball being played
    // with instead of joining the ring.
    const inPlay = (objId: string) => isPlayArea(session, state, objId);
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
          if (inPlay(objId)) continue; // a game in progress — join it, don't pocket it
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
          if (inPlay(objId)) continue;
          cands.push({
            c: { id: objId, place: P(objId), units: 1 },
            d: body ? Math.hypot(o.x - body.x, o.y - body.y) : 0,
          });
        }
        if (tpl.satisfy.kind === "transform") {
          for (const boxId of houseContainerKeys(session, houseIndex)) {
            const stock = session.containerStock.get(boxId);
            if (!stock) continue;
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
          if (inPlay(objId)) continue; // THE TIDY EXEMPTION — never sweep a game in progress
          cands.push({
            c: { id: objId, place: P(objId), units: 1 },
            d: body ? Math.hypot(o.x - body.x, o.y - body.y) : 0,
          });
        }
      }
      cands.sort((a, b) => a.d - b.d);
      loose = cands.map((x) => x.c);
    }
    // ── A RITUAL HEAD DOES NOT FORAGE ─────────────────────────────────────────
    // THE COORDINATION, and the only place a ritual touches a decision. While
    // this body is a head of a live ritual, the need that CALLED it is bound to
    // the ritual's place: the acquire branches close and the station list
    // narrows to the one place the event is at.
    //
    // What that buys: a hungry head stops walking to the pantry for a raw apple
    // the moment dinner is declared, and instead decides `blocked` on hunger —
    // which shadows nothing (the blocked-vs-actionable split in decideNeeds), so
    // it goes and does its prep duty, or sits down at its seat (`attend`), until
    // a meal is actually on the table. That waiting IS the ritual. When the
    // portions land the same row resolves `consumeAt` at the place, and everyone
    // eats together.
    //
    // ⚠️ It must be reversible on the instant, and it is: the binding is read
    // from `session.rituals` every decide, so the moment the gathering's
    // deadline lapses and the ritual retires, the very next decide sees the full
    // acquire branches again and the head feeds itself. That is what makes the
    // deadline a real safety net rather than a promise.
    let meterOverride: number | undefined;
    for (const rt of session.ritualTemplates) {
      const live = session.rituals.get(`${houseIndex}|${rt.key}`);
      if (!live || !live.heads.includes(cid)) continue;
      if (!rt.calls.some((c) => c.kind === "strong" && c.tplKey === tpl.key)) continue;
      stations = stations.filter((s) => s.id === live.placeId);
      if (!stations.length && state.objects[live.placeId]) {
        // The place isn't in this row's own station list (a floor station for a
        // fixture-shaped satisfy). Offer it anyway — the event is there.
        const waiting = stackTotalOf(session.containerStock.get(live.placeId), goodKey);
        stations = [{ id: live.placeId, place: P(live.placeId), kind: fixtureKindOf(state, live.placeId), waiting }];
      }
      sources = [];
      delete containers.home;
      delete containers.storage;
      loose = undefined;
      // ⚠️ AND WHILE IT IS STILL BEING GOT READY, THE NEED DOES NOT FIRE AT ALL.
      // Narrowing the stations is not enough to make people wait for each other:
      // a `consume` row holding a unit eats it wherever it stands (`consumeHere`
      // is the walker's answer when no station resolves), so the cook would eat
      // the first dish it made and the first head to reach the table would eat
      // alone. Reporting the meter as UNFIRED for the duration of the gathering
      // is the honest statement — you are not casting about for food, you are at
      // dinner — and it holds only until the phase flips (or, if the meal never
      // comes together, until `gatherS` retires the whole thing).
      //
      // ⚠️ ONLY WHILE THERE IS SOMETHING TO WAIT FOR (`prepare`). A ritual with
      // no bill — playing together — has nothing to hold anyone back from, and
      // its heads have no `attend` row either (a ring is not a seat to claim
      // and walk to): the calling need IS what carries them to the place. Gate
      // this on the bill and a joiner rings the game; gate it on the phase
      // alone and the joiner is frozen out of its own reason to come, so the
      // gathering waits for a body that will never arrive and the deadline
      // drops it every time.
      if (live.phase === "gather" && rt.prepare && rt.prepare.perHead > 0) meterOverride = 0;
    }
    return {
      // SOFT CONTROL note: the spark's attention no longer rides this meter —
      // a directed act targets the SPECIFIC indicated instance through
      // performAttentionAction (a category-matched need here would send the
      // body to the nearest "food", not the pointed apple). Raw meter only.
      meter: meterOverride ?? session.needMeters.get(`${cid}|${tpl.key}`) ?? 0,
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
          // A FOOD row that EATS also counts a carried MEAL (the projection
          // rule, §4): "meal" is a category DISJOINT from "food"
          // (MEAL_KINDS = the `.hot` variants), so a cooked unit in hand read
          // as 0 to hunger — which then walked to the pantry for a raw apple
          // while holding a dinner it could not put down (serve's table was
          // full or missing, so the meal rode the hands forever and the row
          // stayed BLOCKED). The consume EFFECT already reaches for the hot
          // meal first (`eatOrder`); this is the decision side catching up,
          // and it is the SAME projection the pursuit path applies.
          // ⚠️ CONSUME ROWS ONLY — a `transform` (cook) or `deposit`
          // (provision:food) row must NOT see meals, or the cook would take
          // its own finished dish back to the oven and the pantry row would
          // bank dinner into the raw-food chest.
          : carryTotalOf(session.needCarried.get(cid), goodKey) +
            (tpl.satisfy.kind === "consume" && goodKey === "food"
              ? carryTotalOf(session.needCarried.get(cid), "meal")
              : 0),
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
      // A town WELL: water is drawn free — no shelf, no depletion, no purse.
      if (isWellId(step.objId)) {
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
          if (!av) break; // no body to put it down from — it stays in hand
          const a = (dropped * 2.399) % (Math.PI * 2); // deterministic scatter
          // ATOMIC (item conservation): the unit leaves the hand and the prop
          // appears in one move, and if the world refuses the prop the unit
          // goes straight back — never decrement-then-hope.
          if (!dropFromStack(session, carried, glyph, av.x + Math.cos(a) * 0.35, av.y + Math.sin(a) * 0.35)) break;
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
      session.needEatShow.set(cid, {
        t: seatId ? EAT_SIT_SHOW_S : EAT_SHOW_S,
        objId: step.objId,
        ...(seatId ? { seatId } : {}),
      });
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
    // NO CARRY: a mirror prop stands for one unit of the container's stack, so
    // hands must not lift it out from under the count (`unshelveProp` is the
    // only way it becomes a real thing). Same object, one affordance different.
    world.addObject(itemObjectSpec(glyph, pid, c, { carry: false }));
    session.smallProps.set(pid, { entityId, glyph, at: session.townClock });
    session.needsPropsEpoch++; // a new loose prop wakes dormant tidy/fun decides
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

  /** LIFTING A UNIT OFF A SURFACE. A prop shown in/on a stocked container is a
   *  MIRROR of one stack unit, not a thing in its own right: it is spawned with
   *  no `carry` affordance so the player's gaze-carry can't lift it out from
   *  under the count (the ledger and the props would drift apart). A CREATURE
   *  reaching for one therefore met `carryObject` refusing — silently, every
   *  tick, until the act cap gave up: the observed "told to eat something off
   *  the table, gets stuck", and why the same food eaten off the FLOOR (a real
   *  loose prop) works. Reaching for it CONVERTS it instead: the unit leaves the
   *  stock and the very same object comes back as a loose prop hands can take.
   *  Same object id and entity, so a plan that already named it still holds. */
  function unshelveProp(session: QuestSession, objId: string, boxId: string): boolean {
    const rec = session.smallProps.get(objId);
    const o = world?.state.objects[objId];
    const stock = session.containerStock.get(boxId);
    if (!world || !rec || !o || !stock || !stackTake(stock, rec.glyph)) return false;
    session.containerStock.set(boxId, stock);
    world.removeObject(objId);
    world.addObject(itemObjectSpec(rec.glyph, objId, o));
    session.smallProps.set(objId, { ...rec, at: session.townClock }); // `at` re-paces the tidy grace
    session.needsPropsEpoch++; // loose now — wakes dormant tidy/fun decides
    return true;
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
    // AN ACCEPTED INVITATION ("eat with me" → "ok"): mark it, and the ordinary
    // ritual loop gathers them. The pure layer only SPOKE the answer — it emits
    // no events, because accepting an invitation moves no body; a ritual
    // introduces no new action, it only lowers this body's bar to declaring or
    // joining one. Marked here rather than inside selectAct so the pure
    // dialogue layer keeps knowing nothing about the world's tables and seats.
    if (act.kind === "invite" && act.verb && res.responseGlyph === "ok") {
      acceptInvitation(session, convo.nodeId, act.verb, PLAYER_CREATURE_ID);
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
  /** A body the player could open a conversation with. `resident` = a streamed
   *  townsperson (registered lazily, small talk); otherwise a goal-tree poser or
   *  an off-tree creature, whose node id it carries. */
  type TalkTarget = { nodeId: string; pos: { x: number; y: number }; resident: boolean };

  /** IS THE GAZE ON THIS PERSON — the ONE hover rule (furniture-aim.ts), the
   *  same one the furniture board resolves through. The hovered thing is the
   *  thing interacted with: hovering the chair beside Mara is looking at the
   *  chair, so it selects the chair and starts nothing with Mara. A fixation
   *  RADIUS can't say that — 2.2 m around a body swallows the furniture beside
   *  it, and did. Position + radius survive only as the fallback for a view
   *  that resolves no screen pick at all. */
  function gazeOnTalk(t: TalkTarget): boolean {
    const gz = world?.getGaze();
    return !!gz && gazeOnCreature(gz, [avatarIdOf(t.nodeId), t.nodeId], t.pos, CONVO_FIG_RADIUS);
  }

  /**
   * WHO the player would talk to right now.
   *
   * THE GAZE PICKS THE PARTNER: the talkable body it RESTS on wins — that is
   * how a crowd is addressed (and how a conversation is handed from one person
   * to the next; see the SWITCH in the convo step). Proximity only decides when
   * the gaze is on nobody, which is the approach case: the greeting bubble of
   * whoever you are walking up to. As a SPIRIT there is no walking, so reach
   * doesn't apply and only the gaze can choose.
   *
   * Naming a target is NOT engaging it — the caller still has to see the gaze
   * ON them (`gazeOnTalk`) before any dwell runs, so a proximity pick raises a
   * greeting bubble and nothing more.
   */
  function talkTargetOf(
    session: QuestSession,
    state: WorldState,
    me: { x: number; y: number },
  ): TalkTarget | null {
    const spirit = spiritNow();
    const gazedOn = gazeOnTalk;
    const byId = new Map<string, TalkTarget>();
    const cands: TalkCandidate[] = [];
    const add = (t: TalkTarget, questGiver: boolean) => {
      const dist = Math.hypot(me.x - t.pos.x, me.y - t.pos.y);
      if (!spirit && dist > CONVO_RADIUS) return;
      byId.set(t.nodeId, t);
      cands.push({ id: t.nodeId, dist, questGiver, gazed: gazedOn(t) });
    };
    /** Is this tree node one that can be talked to at all, right now? */
    const talkableNode = (nodeId: string): boolean => {
      const t = session.ctx.nodeById.get(nodeId)?.type;
      if (t === "fulfill") return true; // a content creature still serves (vendor)
      if (t === "choose" || t === "converse") return !session.rState.completed[nodeId];
      return !!session.creatures?.nodeByCreature.has(nodeId); // off-tree local
    };
    for (const f of session.embedding.layout.figures) {
      if (!talkableNode(f.nodeId)) continue;
      const t = session.ctx.nodeById.get(f.nodeId)?.type;
      if (t !== "choose" && t !== "converse" && t !== "fulfill") continue;
      add({ nodeId: f.nodeId, pos: poserPos(session, f.nodeId) ?? f.pos, resident: false }, true);
    }
    // Off-tree creatures (wilderness locals) talk through their fulfill-shaped mind.
    for (const [cid] of session.creatures?.nodeByCreature ?? []) {
      if (session.ctx.nodeById.has(cid)) continue; // tree posers handled above
      if (cid.startsWith("resident_") || cid.startsWith("pet_")) continue; // their own arm below
      const av = state.avatars[avatarIdOf(cid)];
      if (av) add({ nodeId: cid, pos: { x: av.x, y: av.y }, resident: false }, true);
    }
    // Streamed townsfolk: a "quest-giver with no quest" — same dialogue system.
    for (const [id, av] of Object.entries(state.avatars)) {
      if (id.startsWith("resident_")) add({ nodeId: id, pos: { x: av.x, y: av.y }, resident: true }, false);
    }
    const pick = pickTalkTarget(cands, { gazeOnly: spirit });
    return pick ? (byId.get(pick) ?? null) : null;
  }

  /** The tree/creature node behind a talk target (an off-tree local's node lives
   *  in the creature book, not the goal tree). */
  function talkNodeOf(session: QuestSession, nodeId: string) {
    return session.ctx.nodeById.get(nodeId) ?? session.creatures?.nodeByCreature.get(nodeId);
  }

  /** The APPROACH greeting a target previews while the player closes in: a
   *  choose shows its prompt, a converse its entry turn's line, anyone with a
   *  projected mind their opening line. */
  function greetGlyphOf(session: QuestSession, target: TalkTarget): string {
    if (target.resident) ensureResidentCreature(session, target.nodeId); // lazily, on first approach
    const node = talkNodeOf(session, target.nodeId);
    if (!target.resident) {
      if (node?.type === "choose") return node.prompt;
      if (node?.type === "converse") {
        const entryTurn = node.turns.find((turn) => turn.id === node.entry);
        return entryTurn?.lines[entryTurn.lines.length - 1]?.glyph ?? "";
      }
      if (node?.type !== "fulfill") return "";
    }
    if (!session.creatures) return "";
    return projectDialogue(
      session.creatures.world,
      target.nodeId,
      PLAYER_CREATURE_ID,
      "b",
      creatureProjectionOpts(session, node?.type === "fulfill" ? node.announce : undefined),
    ).lineGlyph;
  }

  /** Raise `target`'s approach bubble — the line it would open with, refreshed
   *  while the player closes in or holds a dwell on them. */
  function previewGreet(session: QuestSession, target: TalkTarget) {
    if (!world) return;
    const greet = greetGlyphOf(session, target);
    showWorldBubble(world.state, `npc-greet:${target.nodeId}`, {
      anchor: { kind: "point", x: target.pos.x, y: target.pos.y },
      text: greet ? npcStatement(greet, creatureGlyph(session, target.nodeId), target.nodeId) : "",
      glyph: greet || undefined,
      ttl: 1.5,
    });
  }

  /** OPEN the conversation with `target` (its dwell fired): face the camera and
   *  raise the board — the projected creature dialogue, or the goal tree's own
   *  choose/converse node. */
  function openTalk(session: QuestSession, target: TalkTarget) {
    if (!world) return;
    clearWorldBubble(world.state, `npc-greet:${target.nodeId}`);
    world.setConversation({ x: target.pos.x, y: target.pos.y });
    if (target.resident) ensureResidentCreature(session, target.nodeId);
    if (target.resident || talkNodeOf(session, target.nodeId)?.type === "fulfill") {
      openCreatureConvo(target.nodeId);
    } else {
      dispatchInput({ type: "touch-figure", nodeId: target.nodeId });
    }
  }

  /** LEAVE the open conversation — the creature board closes itself; a goal-tree
   *  choose/converse is cancelled through the runtime. */
  function leaveActiveConvo(nodeId: string) {
    if (convo) closeCreatureConvo();
    else dispatchInput({ type: "cancel-choice", nodeId });
  }

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
            // NO CORNER-CUTTING INDOORS. A point the router placed inside a
            // building is on a corridor it measured — often a gap of a few
            // centimetres between two fixtures' keep-outs — so the host's local
            // aim bend (detourAim) can only steer the body off it and into what
            // the route went around. Marked per POINT, not per leg: a walk home
            // from the street is free-roam until it crosses the threshold, and
            // tightens exactly there. Outdoors the bend is untouched.
            ...(buildingAt(state, p.x, p.y) ? { tight: true } : {}),
            ...(isEndpoint ? {} : { arrive: p.arrive ?? 0.9 }),
            ...(isEndpoint && pt.dwell ? { dwell: pt.dwell } : {}),
            // The doorway tag rides all the way to the follower: while this is
            // the live waypoint the body declares the crossing, which is what
            // opens the door (engine: AvatarState.crossingDoorId).
            ...(p.doorId ? { doorId: p.doorId } : {}),
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
    // 🚨 A SCOPE CANNOT BE A NUMBER (step ②). A container with something in it
    // goes into the box as a WHOLE OBJECT — id, stock and registration intact.
    // Dissolving it into a `furn.barrel` tally orphaned its own stock, keyed by
    // the object id that had just stopped existing: the reported bug, where the
    // water was visible in the deconstructed barrel and gone once the barrel had
    // been boxed and stood up again. (The refrigerator kept its food only
    // because nobody ever put IT in a box.) An EMPTY container still stacks —
    // a flat-packed barrel is just a barrel.
    const ownStock = session.containerStock.get(objId);
    if (!mayDissolveToStack(small.glyph, ownStock)) {
      // No room for a whole object ⇒ refuse, rather than quietly spilling it.
      return placeInContainer(world.state, objId, containerObjId, rel);
    }
    const stock = session.containerStock.get(containerObjId) ?? {};
    stackAdd(stock, small.glyph);
    session.containerStock.set(containerObjId, stock);
    if (rel === "on") {
      placeInContainer(world.state, objId, containerObjId, "on"); // visible on the table
    } else {
      world.removeObject(objId);
      session.smallProps.delete(objId);
      // An emptied container that just became a tally leaves no registration
      // behind — a stale one is an endpoint pointing at an object that is gone.
      session.containerStock.delete(objId);
      session.containers.delete(objId);
      session.containerOwner.delete(objId);
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
  /** A discrete USE (pick / put / take / eat) fires a reach→grasp→lift carry
   *  GESTURE the renderer plays over the crouch. That reach+grasp crouch runs
   *  ~1.4 s from the moment the gesture fires; if the body is released to its
   *  next leg before it finishes, it walks off STILL crouched (the "using while
   *  moving" bug). So the hold PINS the body until the visible reach is done,
   *  then locomotion resumes; the gesture's short lift tail then releases via the
   *  animator's movement-dissolve. The EFFECT (and, inside it, the gesture) lands
   *  EARLY in the hold so the whole reach plays inside the pin, not at its end. */
  const ACTION_HOLD_S = 1.6; // total pin — covers a carry gesture's reach + grasp
  const ACTION_EFFECT_S = 0.4; // when `apply` (and its gesture) fires within the hold

  /** Perform a discrete action as a CROUCH-IN-PLACE beat (concept-parser.md §10.2):
   *  pin the body where it stands and land `apply` EARLY in the hold — never
   *  mid-stride. Both driving loops (stepPursuit, stepNeeds) leave a body
   *  alone while it holds one, so an action and its animation stay welded: the
   *  creature stops, crouches, touches the thing as the effect fires, holds the
   *  reach out, and only then rises and walks on.
   *  A fresh call REPLACES any half-done hold on the same body. */
  function beginAction(
    session: QuestSession,
    cid: string,
    label: string,
    apply: () => void,
    opts?: { hold?: number; effectAt?: number; seatId?: string },
  ) {
    const npcId = avatarIdOf(cid);
    const av = world?.state.avatars[npcId];
    const hold = opts?.hold ?? ACTION_HOLD_S;
    const effectAt = Math.min(opts?.effectAt ?? ACTION_EFFECT_S, hold);
    // Pin in place for the whole hold so a residual / stale errand can't drag the
    // body around while its action animation plays (the "moving while using" bug).
    if (av && world) world.setNpcErrand(cid, { points: [{ x: av.x, y: av.y, dwell: hold + 0.2 }] });
    // `seatId` turns the hold's crouch into a SIT ON THAT CHAIR (the activity
    // names the fixture, so the anchor slides the body on) — the dinner case,
    // where the effect must land on a body already seated, not crouched beside.
    session.actionHold.set(cid, { t: 0, dur: hold, effectAt, applied: false, apply, label, ...(opts?.seatId ? { seatId: opts.seatId } : {}) });
  }

  /** Advance every action hold: at `effectAt` the effect lands ONCE (`applied`
   *  guards it), and at the end the hold clears so the owning loop resumes and
   *  re-plans from the now-updated world. */
  function stepActionHolds(session: QuestSession, dt: number) {
    for (const [cid, h] of [...session.actionHold]) {
      h.t += dt;
      if (!h.applied && h.t >= h.effectAt) {
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

  /**
   * WHERE A THING IN SOMEBODY'S HANDS COMES FROM.
   *
   *   `object`  something already in the world — a prop on the floor, or a
   *             MIRROR prop shown in a box, which converts on the way out.
   *   `glyph`   mint the prop for one unit. THE LEDGER MOVE IS THE CALLER'S:
   *             item-move.ts owns where units are, this owns only what hands
   *             look like, and mixing the two is what let a unit exist in a
   *             stack and on the ground at once.
   */
  type HandSource =
    | { kind: "object"; objId: string }
    | {
        kind: "glyph";
        glyph: string;
        /** Where it comes from (defaults to the body's own feet). */
        at?: { x: number; y: number };
        /** Force the object id — a caller that keeps its own book on the prop. */
        id?: string;
        /**
         * A DISPLAY TOKEN for units already counted somewhere else (the needs
         * walker's abstract bag, a haul's manifest). Registered NOWHERE — no
         * smallProps row, no creature-world entity — exactly so fetch, tidy and
         * dialogue can never mistake the picture of a thing for the thing.
         */
        shadow?: boolean;
      };

  /**
   * ═══ THE ONE WAY SOMETHING ENTERS A CREATURE'S HANDS ═══
   *
   * User law (2026-08-02): "there are multiple places where an item may go to
   * and from a creature's inventory… ensure that there's only one definition for
   * each action and each item. Otherwise nothing will make sense."
   *
   * There were five. Two of them did not put anything in a hand at all — the
   * blueprint re-flow rewrote the furniture row on arrival, and the storage
   * install decremented a stack at the far end — which is why furniture put INTO
   * a box was visible in somebody's hands and furniture taken OUT of one was
   * invisible, and why the refrigerator (exempt from breaking, so the row
   * rewrite was its only path) teleported while every other piece was carried.
   *
   * Three things happen here and they are not separable: the object exists, the
   * body holds it, and the body reaches for it. A caller that does two of the
   * three is the bug this replaces.
   *
   * Returns the carried object id, or null if nothing could be taken.
   */
  function takeIntoHands(
    session: QuestSession,
    bodyId: string,
    src: HandSource,
    opts?: {
      /** Where the reach aims. Defaults to the thing's own position — which is
       *  right for every real take, and is why the gesture stopped pointing at
       *  the middle distance the way the hand-rolled ones did. */
      reachAt?: { x: number; y: number };
    },
  ): string | null {
    if (!world) return null;
    const state = world.state;
    const body = state.avatars[bodyId];
    let objId: string | null = null;
    let reach = opts?.reachAt;
    if (src.kind === "object") {
      const o = state.objects[src.objId];
      if (!o) return null;
      reach ??= { x: o.x, y: o.y };
      // A MIRROR prop resting in a container converts as it leaves: the unit
      // comes off the stack and the very same object becomes one hands can
      // take. A no-op for a prop that was already loose.
      const boxId = o.containedIn?.objectId;
      if (boxId) unshelveProp(session, src.objId, boxId);
      objId = src.objId;
    } else {
      const at = src.at ?? (body ? { x: body.x, y: body.y } : null);
      if (!at) return null;
      reach ??= at;
      if (src.shadow) {
        objId = src.id ?? `hand:${bodyId}`;
        // A token id is the CALLER'S book, so a stale one can still be lying
        // about from a carry that died mid-trip. The fresh spec wins — carrying
        // whatever happened to hold that id is how a body ends up holding the
        // last thing it was asked to move.
        if (!world.addObject(itemObjectSpec(src.glyph, objId, at))) {
          world.removeObject(objId);
          world.addObject(itemObjectSpec(src.glyph, objId, at));
        }
      } else {
        objId = spawnLooseProp(session, src.glyph, at.x, at.y);
      }
    }
    if (!objId || !carryObject(state, objId, bodyId)) return null;
    fireCarryGesture(bodyId, "pickup", reach);
    return objId;
  }

  /**
   * ═══ THE ONE WAY SOMETHING LEAVES A CREATURE'S HANDS ═══
   *
   *   `ground`     set it down where it stands — it goes on being the item it is.
   *   `container`  put it away (stack merge / visible surface — stowCarriedIn).
   *   `consumed`   the caller is turning it into something ELSE and takes
   *                responsibility for it in the same breath: a fixture standing
   *                on its mark, a stack landing in a destination. The prop
   *                leaves the world because the thing it stood for still exists,
   *                somewhere a player can point at. NEVER use it to make
   *                something go away.
   *
   * Returns what left the hand, or null if the body was holding nothing.
   */
  function setDownFromHands(
    session: QuestSession,
    bodyId: string,
    to:
      | { kind: "ground"; x: number; y: number }
      | { kind: "container"; id: string }
      | { kind: "consumed" },
    opts?: {
      /** Which held object, when a body could be holding more than one (a real
       *  item plus a display token). Defaults to whatever it is holding. */
      objId?: string;
      /** Where the reach aims; defaults to the destination. */
      reachAt?: { x: number; y: number };
      /**
       * The thing is being REPLACED in the same hands, not put down — the
       * needs walker swapping a dirty shirt token for a clean one. Nothing
       * leaves the body, so nothing reaches. Never for a real put-down.
       */
      quiet?: boolean;
    },
  ): { objId: string; glyph: string | null } | null {
    if (!world) return null;
    const state = world.state;
    const objId = opts?.objId ?? npcCarrying(bodyId);
    if (!objId) return null;
    const o = state.objects[objId];
    if (!o || o.carriedBy !== bodyId) return null;
    const glyph =
      session.smallProps.get(objId)?.glyph ??
      state.spec.objects.find((s) => s.id === objId)?.glyph ??
      null;
    let landed = { x: o.x, y: o.y };
    if (to.kind === "ground") {
      landed = { x: to.x, y: to.y };
      dropObject(state, objId, to.x, to.y);
    } else if (to.kind === "container") {
      const box = state.objects[to.id];
      if (box) landed = { x: box.x, y: box.y };
      if (!stowCarriedIn(session, objId, to.id)) return null;
    } else {
      // CONSUMED — the prop's job is over because the caller is about to stand
      // the thing up or bank it. Registered props go through removeLooseProp so
      // the creature world drops the entity with them; a display token was never
      // registered and only has to leave the scene.
      if (session.smallProps.has(objId)) removeLooseProp(session, objId);
      else world.removeObject(objId);
    }
    if (!opts?.quiet) fireCarryGesture(bodyId, "putdown", opts?.reachAt ?? landed);
    return { objId, glyph };
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
        // The unit has left the stack above; the hand is the master's business.
        // The reach aims at the BOX, not the prop — the prop is minted at the
        // body's own feet, and reaching for your own feet reads as nothing.
        takeIntoHands(
          session,
          npcId,
          { kind: "glyph", glyph, at: { x: at.x, y: at.y } },
          { reachAt: world.state.objects[boxId] },
        );
        fellIfConsumed(session, boxId); // an emptied kill-source is felled
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
        // The mirror-prop conversion (unshelveProp), the carry and the reach all
        // live in the master now — this used to be the only one of the five
        // carry paths that did all three, which is why it was the only one that
        // consistently looked right.
        takeIntoHands(session, npcId, { kind: "object", objId: o });
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
      setDownFromHands(session, npcId, { kind: "ground", x: c.x, y: c.y }, { objId: o });
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
      // A DIRECT PIN, never enqueueNpcErrand: the queue is what `ritualEligible`
      // and the needs suspend read as "the player ordered this body", so a
      // ritual COOK dwelling at the oven through the queue was expelled from
      // the very meal it was cooking for ("an ordered body is not at dinner").
      // The pursuit owns the body here — the pin is a stand-still, no chain.
      world.setNpcErrand(npcId, { points: [{ x: body.x, y: body.y, dwell }] });
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
      const seated = seat && av && Math.hypot(av.x - seat.x, av.y - seat.y) <= 1.6;
      const doEat = () =>
        applyNeedStepEffect(session, state, cid, {
          tplKey: step.tplKey ?? "command",
          kind: "consume",
          goodKey: step.goodKey,
          ...(stId ? { objId: stId } : {}),
          ...(seat ? { seatId: seat.id } : {}),
          units: 1,
        });
      // SIT FIRST, then eat from the chair (the same order the single-item eat
      // and the legacy walker keep) — a free chair in reach seats the diner
      // before the bite lands; no chair keeps the standing eat.
      if (seated) {
        beginAction(session, cid, "eat:seated", doEat, {
          hold: SIT_BEFORE_EAT_S + 1.2,
          effectAt: SIT_BEFORE_EAT_S,
          seatId: seat.id,
        });
      } else {
        doEat();
      }
      return;
    }
    if (step.kind === "eat") {
      // CONSUME the specific item on arrival ("eat the banana"): a brief
      // reach-to-mouth cue, then the thing is used up — removeLooseProp clears
      // both the visible prop and the creature-world item, so it can't be
      // eaten twice or asked-after. Reaching for it from the hand or the
      // ground both land here (the planner walked the body over first).
      //
      // THE DINING SEAT resolves FIRST, because the sit must come before the
      // bite: a body at a table with a free chair settles ONTO the chair (a
      // seated action hold — the anchor slides it on), and only then does the
      // eat land, its show carrying the same seat. The old order applied the
      // effect standing and slid the diner on afterwards — "they eat, then sit
      // down, then stand up". No claim bookkeeping here — freeSeatAt reads
      // needStep claims and seated bodies, so a transient double-book between
      // two same-window pursuit diners is possible and purely visual.
      const state = world.state; // captured — the deferred doEat runs past the null-narrowing
      const av = state.avatars[npcId];
      let seatId: string | undefined;
      let tableId: string | undefined;
      if (av) {
        for (const spec of state.spec.objects) {
          if (spec.fixture !== "table") continue;
          const t = state.objects[spec.id];
          if (!t || Math.hypot(t.x - av.x, t.y - av.y) > spec.radius + 1.8) continue;
          tableId = spec.id;
          const seat = freeSeatAt(session, state, cid, spec.id);
          if (seat && Math.hypot(av.x - seat.x, av.y - seat.y) <= 1.6) seatId = seat.id;
          break;
        }
      }
      const doEat = () => {
        const glyph = liveItemGlyph(session, step.itemId);
        const head = (headOf(glyph)).toLowerCase();
        const o = objIdOfEntity(session, step.itemId);
        if (o) {
          const at = state.objects[o];
          fireCarryGesture(npcId, "pickup", at ? { x: at.x, y: at.y } : undefined);
          // EATEN OFF THE SURFACE (the plated meal, the pet's bowl): the prop is a
          // MIRROR of one unit of that container's stock, so the meal must leave
          // the COUNT as well as the tabletop — else the table keeps a phantom
          // serving that renders nowhere and can never be eaten again. Same draw-
          // down the needs walker's own consume does when it eats at a station.
          const shelf = at?.containedIn?.objectId;
          const stock = shelf ? session.containerStock.get(shelf) : undefined;
          if (shelf && stock) {
            stackTake(stock, session.smallProps.get(o)?.glyph ?? "");
            session.containerStock.set(shelf, stock);
          }
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
        // THE MEAL IS SEEN (parity with the needs consume): the EAT visual — a
        // chair meal shows seated (and a little longer), a standing one the eat rig.
        if (state.avatars[npcId]) {
          session.needEatShow.set(cid, {
            t: seatId ? EAT_SIT_SHOW_S : EAT_SHOW_S,
            ...(tableId ? { objId: tableId } : {}),
            ...(seatId ? { seatId } : {}),
          });
          showWorldBubble(state, `eat:${cid}`, {
            anchor: { kind: "avatar", id: npcId },
            text: "",
            glyph: head,
            ttl: 1.5,
          });
        }
      };
      if (seatId) {
        beginAction(session, cid, "eat:seated", doEat, {
          hold: SIT_BEFORE_EAT_S + 1.2,
          effectAt: SIT_BEFORE_EAT_S,
          seatId,
        });
      } else {
        doEat();
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
      // §10). The pursuit already WALKED the body here, so pose it in place.
      // A dwell errand PINS it for the spell (else the wander behavior walks it
      // off mid-animation). One dwell, then the pursuit ends — the needs walker
      // keeps its own meter-clearing rest.
      //
      // WHICH FIXTURE is being used comes from the GOAL, not from geometry: a
      // `restAt` names its station in `place` (need-goals restAt →
      // {kind:"named"}), and that id is what `needPoseShow` must carry so the
      // furniture anchor slides the body ONTO it. A blind "nearest rest fixture
      // within 2.2 m" scan used to stand in for this, and it silently dropped
      // the bed whenever the walk settled a few centimetres outside that flat
      // radius — the body then slept on the FLOOR beside its own bed (observed:
      // a sleeper 2.24 m from a 0.9 m-radius bed, i.e. barely a step past the
      // stand spot, posed `sit` in the open). The walk's own arrival tolerance
      // (COMMAND_ARRIVE, measured from a stand spot already a body-radius out)
      // makes that overshoot ORDINARY, so no fixed radius can be the authority.
      // The proximity scan survives only as the fallback for a `restHere` doze,
      // where the goal genuinely names no station — and it is radius-aware now,
      // so a wide bed is judged from its EDGE like every other reach.
      const state = world.state;
      const body = state.avatars[npcId];
      if (!body) return;
      const REST_FIXTURES = new Set(["bed", "chair", "box", "bath", "toilet"]);
      const fixtureKindOf = (id: string): string | undefined => {
        const spec = state.spec.objects.find((s) => s.id === id);
        return spec?.fixture && REST_FIXTURES.has(spec.fixture) ? spec.fixture : undefined;
      };
      let stObjId: string | undefined;
      let stKind: string | undefined;
      // THE GOAL'S OWN STATION first — the bed/chair/toilet this rest was for.
      if (step.place.kind === "named" && state.objects[step.place.id]) {
        const k = fixtureKindOf(step.place.id);
        if (k) {
          stObjId = step.place.id;
          stKind = k;
        }
      }
      if (!stObjId) {
        // A doze with no named station: fall back to what the body has actually
        // REACHED, edge-relative (radius + a reach margin), never a flat radius.
        let bestSlack = REST_REACH_MARGIN;
        for (const spec of state.spec.objects) {
          if (!spec.fixture || !REST_FIXTURES.has(spec.fixture)) continue;
          const o = state.objects[spec.id];
          if (!o) continue;
          const slack = Math.hypot(o.x - body.x, o.y - body.y) - spec.radius;
          if (slack < bestSlack) {
            bestSlack = slack;
            stObjId = spec.id;
            stKind = spec.fixture;
          }
        }
      }
      // WHAT the pose is: an ON-FIXTURE piece decides it from its own use-point
      // contract (torso contact ⇒ lie down, pelvis ⇒ sit), because that contract
      // is also what the renderer and the anchor read — a motive that asserted
      // "sleep" while the body is pinned on a CHAIR would leave the sim on the
      // seat and the picture unanchored (render3d only lies a sleeper on a
      // torso-contact piece). Otherwise the goal's own pose wins (a doze in the
      // open is a SLEEP, fun's toy-play a PLAY — no fixture to say so), falling
      // back to what was reached.
      const onFixtureContact = stKind ? useContractFor(stKind as FixtureKind) : null;
      const pose: AvatarActivityKind = onFixtureContact?.onFixture
        ? onFixtureContact.contactPart === "torso"
          ? "sleep"
          : "sit"
        : (step.pose ?? (stKind === "box" ? "play" : "sit"));
      const dwell = step.dwellS ?? REST_CMD_DWELL_S; // a need's nap vs the commanded-sit default
      session.needStep.delete(cid);
      session.npcTasks.delete(npcId);
      session.needPoseShow.set(cid, { t: dwell, kind: pose, ...(stObjId ? { objId: stObjId } : {}) });
      // A DIRECT PIN, never enqueueNpcErrand: an npcTasks entry reads as "the
      // player ordered this body" to `ritualEligible` and the needs suspend —
      // so a ritual head SITTING DOWN AT ITS OWN CHAIR through the queue was
      // expelled from the roster the moment it sat ("an ordered body is not at
      // dinner"), and the gathering collapsed head by head as each arrived.
      // The pursuit owns the body here — the pin is a stand-still, no chain.
      world.setNpcErrand(npcId, { points: [{ x: body.x, y: body.y, dwell }] });
      session.lastDrive.set(npcId, "command");
      showWorldBubble(state, `rest:${cid}`, {
        anchor: { kind: "avatar", id: npcId },
        // The STATION names the act (a toilet says toilet, a tub says wash);
        // with none, the pose does — through its own registered art, never a
        // stand-in emoji. See dwellBubble.
        ...dwellBubble(stKind, pose),
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
        // A HAND-OFF IS TWO ACTS, and it has to be: `carryObject` REFUSES an
        // object that is already carried, so the old single call could never
        // fire — the giver kept the prop while `giveItem` had already moved the
        // item to the receiver in the creature world, and the two disagreed.
        // Out of one hand, into the other, through the one door each way.
        const at = { x: rBody.x, y: rBody.y };
        setDownFromHands(session, npcId, { kind: "ground", ...at }, { objId: o });
        takeIntoHands(session, rBodyId, { kind: "object", objId: o }, { reachAt: at });
      } else {
        const at = rBody ?? c; // graspless / hands full → at the receiver's feet
        setDownFromHands(session, npcId, { kind: "ground", x: at.x, y: at.y }, { objId: o });
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

  /** The crowding-avoidance descriptor for creature `cid`'s stand points: keep
   *  clear of every OTHER body (its own body excluded), each at its real girth.
   *  Handed to `standPointFor`/`nearestClearSpot` so two creatures working or
   *  resting at the same spot stand shoulder-off instead of overlapping. */
  function standAvoid(cid: string): BodyAvoidance {
    return {
      selfId: avatarIdOf(cid),
      radiusOf: (id: string) => world?.npcRadiusOf(id) ?? DEFAULT_BODY_RADIUS_M,
    };
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
          // core word "bathroom" IS the toilet fixture; "yard" is the
          // builder's-yard crate (town) / the site stockpile (wilderness);
          // "cabinet" is the vocabulary's word for the `cupboard` kind, and
          // the ids carry the KIND (`furn_3_cupboard`), so the token search
          // below would never match the word the board actually offers.
          const spoken =
            p.id === "bathroom"
              ? "toilet"
              : p.id === "yard"
                ? (session.town ? "yard" : "stock")
                : fixtureKindForWord(p.id);
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
    // VOCABULARY WORDS, never fixture kinds: the `chest` and `cupboard` kinds
    // are spoken as `box` and `cabinet` (types.ts FIXTURE_WORD) and those two
    // words exist nowhere a speaker can reach them.
    "home", "bed", "table", "chair", "box", "cabinet",
    "bath", "bathroom", "toilet", "barrel", "bin", "bowl", "oven", "well", "market", "store",
    "yard", "house", // transfer endpoints (②): the builder's yard, a house
  ]);

  /** Spoken words naming a LIDDED CONTAINER — "open/shut the X" on one works its
   *  physical LID (`setOpen`/`heldOpen`), not a creature-world device toggle.
   *  The openable container station kinds (STATION_PROPERTIES) + their synonyms. */
  const OPENABLE_CONTAINER_WORDS = new Set([
    "box", "cabinet", "barrel", "bin", "refrigerator", "fridge", "container",
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
          // DISPLAY face, not the stack key (see presentContainer): a pocketed
          // `furn.<kind>` piece is a chair, not a "furn".
          icon: drawnMakeable(glyph),
          label: spokenMakeable(glyph),
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
  // The refusal lines live in the shared phrasebook (intent-lines.ts) so a
  // declined ORDER and a declined INVITATION speak the same "no".
  const SATISFY_REFUSAL = ACTIVITY_REFUSAL;
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

  // ── COMPANY: "eat with me", "we play together" ────────────────────────────

  /**
   * WHO "we" / "us" NAMES when the player says it.
   *
   * ⚠️ THE ONE PLACE the player's social identity is decided. The player is
   * NOT a ritual head — the formless spirit has no body, no meters and no
   * station, and faking them would make it a fixture in a household it is
   * meant to be watching over. But it is not a nobody either: it HAS a group,
   * and "we will eat together" is an honest thing for it to say. So the spirit
   * carries GROUP-MEMBER semantics without ever occupying a seat.
   *
   * Provisional by design — what the player fundamentally IS remains open, so
   * every caller resolves `we` through here and there is exactly one function
   * to revise when it settles.
   */
  function playerGroup(session: QuestSession): string[] {
    const out: string[] = [];
    const add = (cid?: string | null) => {
      if (cid && cid !== PLAYER_CREATURE_ID && !out.includes(cid)) out.push(cid);
    };
    add(possession.creatureId); // the body being ridden is the nearest thing to "me"
    for (const c of session.party) add(c);
    for (const c of session.bondedCreatures) add(c);
    // The household the spirit is keeping — its residents and its pets.
    const hi = session.dollhouse;
    if (hi !== null && world) {
      const home = Object.keys(world.state.avatars)
        .filter((id) => (id.startsWith("resident_") || isPetCid(id)) && houseIndexOfCid(id) === hi)
        .sort();
      for (const id of home) add(id);
    }
    return out;
  }

  /** A compiled CompanionSpec → the bodies it names. The PLAYER resolves to the
   *  body it is riding, if any: "eat with me" from a possessed avatar means
   *  that avatar, and from a formless spirit it names nobody — which is the
   *  honest answer, not a silently invented participant. */
  function resolveCompanions(session: QuestSession, spec: CompanionSpec): string[] {
    if (spec.kind === "group") return playerGroup(session);
    const out: string[] = [];
    for (const id of spec.ids) {
      const cid = id === PLAYER_CREATURE_ID ? possession.creatureId : id;
      if (cid && !out.includes(cid)) out.push(cid);
    }
    return out;
  }

  /** WHY a body won't come, as a spoken glyph line: the activity's own refusal
   *  ("I'm not hungry", "I'm not bored") — the same phrasebook a declined solo
   *  order already speaks, because it is the same "no". */
  const gatherRefusalLine = (need: string): string => SATISFY_REFUSAL[need] ?? NOT_UNDERSTOOD_LINE;

  /**
   * ASK bodies to a gathering — the spoken invitation ("you eat with me", "we
   * play together"). Each one answers for itself, in two separately-asked
   * parts, so a refusal can say WHICH:
   *   · CAN it? — `ritualAnswer` over the live ritual context (a seat, a place,
   *     room on the roster, not already performing);
   *   · WILL it? — `willingnessToJoin`, the personality gate (warmth toward
   *     this particular asker). A body that WANTS the activity accepts anyone.
   * An accepted invitation lowers that body's declare bar for one `gatherS`
   * and the ordinary ritual loop does the rest. A declined one speaks.
   *
   * Returns the bodies that accepted (empty = nobody is coming).
   */
  function askToGather(
    session: QuestSession,
    need: string,
    companions: readonly string[],
    asker: string,
  ): { accepted: string[]; tpl: RitualTemplate | null } {
    const houseIndex = session.dollhouse;
    const prefix = SATISFY_NEED_PREFIX[need];
    if (houseIndex === null || !world || !prefix) return { accepted: [], tpl: null };
    const tpl = ritualCalledBy(session, prefix);
    // NO GATHERING FOR THIS NEED — "you sleep with me" in a culture whose
    // ritual rows declare no shared sleeping. The word parsed, compiled, and
    // found nothing here to act on. Whether that SPEAKS is an audience
    // decision, not an engineering one (voice-policy.ts).
    if (!tpl) return { accepted: [], tpl: null };
    const state = world.state;
    const live = session.rituals.get(`${houseIndex}|${tpl.key}`) ?? null;
    const set = ritualBodySet(session, state, houseIndex);
    const resolved = ritualCtxFor(session, state, houseIndex, tpl, set, ritualDayF(session), live);
    if (!resolved) return { accepted: [], tpl }; // nowhere to gather

    const accepted: string[] = [];
    for (const cid of companions) {
      if (cid === asker) continue;
      const body = resolved.ctx.bodies.find((b) => b.id === cid);
      // Ask as though already invited — that IS the question being put.
      const can = body ? ritualAnswer(tpl, { ...body, invited: true }, live, resolved.ctx) : "decline";
      const level = body?.levels[tpl.calls.find((c) => c.kind === "strong")?.tplKey ?? ""] ?? 0;
      const will =
        can !== "decline" &&
        willingnessToJoin({
          level,
          personality: creatureMood(cid),
          relation: session.relations.get(`${cid}|${asker}`) ?? DEFAULT_RELATION,
        });
      if (will && inviteToRitual(session, houseIndex, tpl, cid, asker)) {
        accepted.push(cid);
        ensureResidentOrPet(session, cid);
        npcChatBubble(session, cid, "ok"); // the reserved okay — an accepted asking
      } else if (body) {
        ensureResidentOrPet(session, cid);
        npcChatBubble(session, cid, gatherRefusalLine(need));
      }
    }
    return { accepted, tpl };
  }

  /** Register whichever kind of body this is — residents and pets have separate
   *  ensure paths and every company site needs both. */
  function ensureResidentOrPet(session: QuestSession, cid: string) {
    if (isPetCid(cid)) ensurePetCreature(session, cid);
    else ensureResidentCreature(session, cid);
  }

  /** HONOR an accepted invitation: the body that said "ok" gets its bar lowered
   *  for that gathering. The willing/feasible decision was already made (the
   *  dialogue layer would not have answered "ok" otherwise) — this only records
   *  it. Also nudges the meter to the ritual's own WEAK bar, so a body that
   *  agreed to come actually has a reason to declare one when none is live yet:
   *  saying yes is a small want, and without it a polite "ok" would be followed
   *  by nobody going anywhere. */
  function acceptInvitation(session: QuestSession, cid: string, verb: string, by: string) {
    const houseIndex = session.dollhouse;
    const prefix = SATISFY_NEED_PREFIX[verb];
    if (houseIndex === null || !prefix) return;
    const tpl = ritualCalledBy(session, prefix);
    if (!tpl || !inviteToRitual(session, houseIndex, tpl, cid, by)) return;
    const rows = residentNeedRowsOf(session, cid);
    const call = tpl.calls.find((c) => c.kind === "weak") ?? tpl.calls[0];
    const row = call ? rows.find((t) => t.key.startsWith(call.tplKey)) : undefined;
    if (row && call && row.drive.kind === "meter") {
      const key = `${cid}|${row.key}`;
      const want = row.drive.threshold * call.level;
      session.needMeters.set(key, Math.max(session.needMeters.get(key) ?? 0, want));
    }
    warmRelations(session, cid, by, { affinity: 0.04, trust: 0.02 }); // being asked along is warmth
  }

  /** The need rows a body runs — residents by household member, pets by species. */
  function residentNeedRowsOf(session: QuestSession, cid: string): readonly NeedTemplate[] {
    const houseIndex = houseIndexOfCid(cid);
    const house = residentTownCtx(session, houseIndex)?.house;
    if (isPetCid(cid) || !house) return petNeedTemplates(session);
    return residentNeedTemplates(session, houseIndex, house, Number(cid.split("_")[2]));
  }

  /** THE ACTIVITY WORDS this culture gathers for — every self-care verb whose
   *  need STRONGLY calls one of the culture's rituals. Derived from the ritual
   *  rows, so the invitation vocabulary is exactly as wide as the world's own
   *  social life and no wider. */
  function gatherableActivities(session: QuestSession): string[] {
    return Object.keys(SATISFY_NEED_PREFIX).filter((verb) => {
      const prefix = SATISFY_NEED_PREFIX[verb];
      return !!prefix && !!ritualCalledBy(session, prefix);
    });
  }

  /** Could `cid` join a `verb` gathering right now? The FEASIBILITY half of an
   *  invitation (rituals.ts decides; this only resolves the context it needs).
   *  The WILLING half is the sociability gate — asked separately so a refusal
   *  can name which one failed. */
  function canJoinActivity(session: QuestSession, cid: string, verb: string): boolean {
    const houseIndex = session.dollhouse;
    const prefix = SATISFY_NEED_PREFIX[verb];
    if (houseIndex === null || !world || !prefix) return false;
    if (houseIndexOfCid(cid) !== houseIndex) return false; // not of this household
    const tpl = ritualCalledBy(session, prefix);
    if (!tpl) return false;
    const state = world.state;
    const live = session.rituals.get(`${houseIndex}|${tpl.key}`) ?? null;
    const set = ritualBodySet(session, state, houseIndex);
    const resolved = ritualCtxFor(session, state, houseIndex, tpl, set, ritualDayF(session), live);
    const body = resolved?.ctx.bodies.find((b) => b.id === cid);
    if (!resolved || !body) return false;
    return ritualAnswer(tpl, { ...body, invited: true }, live, resolved.ctx) !== "decline";
  }

  /** Returns true when the command landed (obeyed or refused aloud) — false =
   *  this member has no such need here ("can't do that here").
   *
   *  `with` marks the order as a SHARED act ("you eat with me"): the commanded
   *  body still does the ordinary thing its own need machinery would do — a
   *  ritual introduces no new action — and the companions are ASKED. A need
   *  this culture holds no gathering for keeps the solo behavior and the
   *  company is simply inert; that is honest, and better than inventing a
   *  gathering the world has no template for. */
  function commandSatisfy(
    session: QuestSession,
    cid: string,
    need: string,
    company?: CompanionSpec,
  ): boolean {
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
    // AND THE COMPANY. The commanded body's raised meter is what will DECLARE
    // the gathering on the next tick; the companions are asked so that they may
    // JOIN it. Asked AFTER the order is known to have landed — inviting people
    // to a dinner nobody is going to cook is the one order of operations that
    // could leave a table laid for a refusal.
    if (company) {
      const { tpl } = askToGather(session, need, resolveCompanions(session, company), cid);
      // An INERT company marker: the order landed and the body is going to do
      // the thing, but this world holds no gathering for it. Say so — and say
      // it INSTEAD of the bare "ok", because answering only the honored half of
      // the child's sentence with a cheerful "ok" is exactly the misleading
      // confirmation the rest of this host refuses to give. The `▶ sentence`
      // toast already reports that the order itself was accepted.
      if (!tpl && DEFAULT_VOICE_POLICY.inertCompany) {
        npcChatBubble(session, cid, noGatheringLine(need)[session.game.meta.syntax ?? "b"]);
      }
    }
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
    const spot = standPointFor(state, chair.id, { x: chair.x, y: chair.y }, { x: body.x, y: body.y }, world?.npcRadiusOf(avatarIdOf(cid)), standAvoid(cid));
    const chairId = chair.id;
    enqueueNpcErrand(session, avatarIdOf(cid), {
      points: [{ x: spot.x, y: spot.y, dwell: SIT_DWELL_S }],
      onArrive: () => session.needPoseShow.set(cid, { t: SIT_DWELL_S, kind: "sit", objId: chairId }),
    });
    session.lastDrive.set(cid, "command");
    return true;
  }

  // ── THE SPOKEN ROOM VOCABULARY (construction ④) ───────────────────────
  // The board's room buttons and the child's own sentence must name rooms
  // with the SAME words: `break + bedroom` off a button and "break the
  // bedroom" out loud are one order, so both resolve through here.

  /** Every house-plan room kind, as the plan's own union. */
  const ROOM_KINDS = Object.keys(ROOM_GLYPH) as Array<HouseRoom["kind"]>;

  /**
   * The house-plan room kind a SPOKEN WORD names, or null when the word is
   * not a room at all. Two sources, both live:
   *   • ROOM_GLYPH — the word every `break + <room>` button already speaks
   *     ("bathroom" is the bath, "room" the undesignated hall), so a spoken
   *     order can never disagree with the button beside it.
   *   • the session's ROOM PROGRAMS (defaults ⊕ culture, `word ?? kind` —
   *     placeBuilderNouns' own fold), so a culture that renames a kind gets
   *     the spoken word for free.
   *
   * `home` is deliberately NOT folded to the living room even though it is
   * that kind's display glyph: `home` is the word for the whole HOUSE, and
   * "break home" quietly meaning "take out the hearth room" is exactly the
   * silent mis-reading this layer exists to prevent. (The living room is
   * never demolishable anyway — structureActsOf excludes it.)
   */
  function spokenRoomKind(session: QuestSession, word: string): HouseRoom["kind"] | null {
    const byGlyph = ROOM_KINDS.find((k) => k !== "living" && ROOM_GLYPH[k] === word);
    if (byGlyph) return byGlyph;
    const defs = resolveRoomPrograms(programOverridesOf(session.town?.config.architecture));
    const kind = defs.find((d) => (d.word ?? d.kind) === word)?.kind;
    return kind && (ROOM_KINDS as string[]).includes(kind) ? (kind as HouseRoom["kind"]) : null;
  }

  /** The building a spoken construction order acts on: the FOCUSED structure
   *  (the dollhouse, or the spirit ladder's structure rung), else the home of
   *  whoever was addressed. Null when neither answers — the honest "which
   *  building?" the caller speaks. */
  function spokenBuildingOf(
    session: QuestSession,
    whom: Array<string | null | undefined>,
  ): {
    scope: "house" | "work";
    index: number;
    key: string;
    plan: HouseRoomPlan;
    /** Everything STANDING inside it (generated ⊕ placed) — what a spoken
     *  "break the bed" searches. A thunk: the room verbs never need it. */
    pieces: () => FurniturePiece[];
  } | null {
    const t = session.town;
    if (!t) return null;
    const center = t.stage.center;
    const goodDefs = t.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    // HUNG DOORS, added back (phase 5). `furnishPlan` drops doorway-pinned
    // rows on purpose — a leaf claims no floor, designates no room and is
    // drawn on the wall, so it must not reach placement, `kindsIn` or the
    // stage. But this thunk is not any of those: it is what a SPOKEN "break
    // the X" searches, and a door is exactly the sort of thing a child says
    // that about. Without this the resolver answers "there is no door here"
    // about a door plainly hanging in front of them, while the board path
    // breaks it fine — the kind of split where the sentence quietly does less
    // than the button.
    const hungDoors = (delta?: BuildingDelta): FurniturePiece[] =>
      (delta?.placed ?? [])
        .filter((p) => p.doorway !== undefined)
        .map((p) => ({
          id: p.id, kind: p.kind, x: p.x, y: p.y,
          radius: p.radius, facing: p.facing, openable: p.openable,
        }));
    const asHouse = (index: number) => {
      const house = t.plan.houses.find((h) => h.index === index);
      if (!house) return null;
      const key = `h_${index}`;
      const delta = t.deltas.get(key);
      return {
        scope: "house" as const,
        index,
        key,
        plan: houseRoomPlan(center, house, delta),
        pieces: () => [...houseFurniture(center, house, goodDefs, "", delta), ...hungDoors(delta)],
      };
    };
    const focus = structureFocusOf(session);
    if (focus?.kind === "house") return asHouse(focus.index);
    if (focus?.kind === "work") {
      const wk = t.plan.works[focus.index];
      if (!wk) return null;
      const key = workDeltaKey(wk, focus.index);
      const delta = t.deltas.get(key);
      const program = wk.program ?? workProgram(wk.type);
      return {
        scope: "work",
        index: focus.index,
        key,
        plan: buildingRoomPlan(center, focus.index, wk, program, delta),
        pieces: () => [...workFurniture(center, focus.index, wk, program, "", delta), ...hungDoors(delta)],
      };
    }
    // NO FOCUS — the addressed body's own home. A spoken order to a resident
    // is about the house that resident lives in, which is the only building
    // the speaker could mean when the camera is up at town scale.
    for (const cid of whom) {
      if (!cid?.startsWith("resident_")) continue;
      const hi = Number(cid.split("_")[1]);
      if (Number.isInteger(hi)) return asHouse(hi);
    }
    return null;
  }

  /** The ROOM a spoken room word picks out of a building's plan: the matching
   *  kind nearest the player (several bedrooms ⇒ the one being looked at),
   *  else the first. Null = that building has no such room. */
  function spokenRoomOf(
    session: QuestSession,
    plan: HouseRoomPlan,
    kind: HouseRoom["kind"],
  ): HouseRoom | null {
    const rooms = plan.rooms.filter((r) => r.kind === kind);
    if (rooms.length <= 1) return rooms[0] ?? null;
    const at = playerWorldPos(session);
    if (!at) return rooms[0]!;
    const d2 = (r: HouseRoom) =>
      (r.rect.x + r.rect.w / 2 - at.x) ** 2 + (r.rect.y + r.rect.h / 2 - at.y) ** 2;
    return rooms.reduce((best, r) => (d2(r) < d2(best) ? r : best), rooms[0]!);
  }

  /**
   * "put + chair + near + table" (construction v1) — a directed PLACEMENT.
   * GUIDANCE, not an RTS order: the player names only the piece and a
   * relation+anchor; the creature searches its own house with the SAME
   * placement rules the generator obeys (kernel placementCandidates), and
   * answers in three grades — place ("ok", walks the errand), "I cannot —
   * because" (no feasible spot / not my house / nothing in storage), or
   * "I don't want to — because" (feasible but past what its compliance
   * swallows). Every verdict SPEAKS. Returns "placed" when the errand is
   * walking, "refused" when the order landed but was declined (aloud — or
   * logged, under `quiet`), false when this creature can't serve it at all.
   */
  function handlePlaceOrder(
    session: QuestSession,
    cid: string,
    goal: Extract<GoalSpec, { kind: "place" }>,
    opts?: {
      quiet?: boolean;
      /** Restrict the spot search to ONE room — the program-fulfillment
       *  install names the room whose program wants the piece. */
      roomId?: string;
      /**
       * THE SPOT IS ALREADY DECIDED — the blueprint's own slot (blueprint.ts).
       * The autonomous install passes it so the piece lands on the mark the
       * outline has been drawn on rather than wherever a fresh search happens
       * to rank first; a promise the player watched must be the one kept. Still
       * CHECKED before use (`placementFeasible`) — the drawing is made against
       * the ideal layout, and a body or a delivery may have taken the floor
       * since — and a spot that no longer works falls back to the search.
       */
      spot?: { x: number; y: number; facing: number; roomId: string };
    },
  ): "placed" | "refused" | false {
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
    let anchorFacing: number | undefined;
    // A ROOM WORD is a destination, not a landmark (construction ④, the law's
    // "put {furniture} in {room}"): "put the bed in the kitchen" names the
    // FLOOR to search, so it binds the room filter the program-fulfillment
    // install already uses rather than a point to sit beside.
    let spokenRoomId: string | null = null;
    if (a.kind === "named") {
      const roomKind = spokenRoomKind(session, a.id);
      if (roomKind) {
        const room = spokenRoomOf(session, plan, roomKind);
        if (!room) {
          // No such room in this house — the honest "not here", the same
          // answer a missing landmark gets.
          speakLine(placementVerdictLine(thing, { kind: "cannot", reason: "outside" })!);
          return "refused";
        }
        spokenRoomId = room.id;
      }
    }
    if (a.kind === "point") anchor = { x: a.x, y: a.y };
    else if (a.kind === "named" && !spokenRoomId) {
      const hit = pieces.find((p) => p.kind === a.id);
      if (!hit) {
        // The named thing isn't standing in this house — honest "I can't".
        speakLine(placementVerdictLine(thing, { kind: "cannot", reason: "outside" })!);
        return "refused";
      }
      anchor = { x: hit.x, y: hit.y };
      anchorFacing = hit.facing; // the directional relations need its front
    }

    // OWNERSHIP pre-gate: a point anchor inside someone ELSE's footprint is
    // "not my house" — creatures furnish their own homes (mayUse's spirit).
    // Tested against the DELTA-APPLIED room plan, not the base footprint:
    // an annex is this house too, and the base-rect test refused a pointed
    // "put the bed here" in the room the player had just ordered built.
    if (anchor) {
      const inOwn = plan.rooms.some(
        (r) =>
          anchor!.x >= r.rect.x && anchor!.x <= r.rect.x + r.rect.w &&
          anchor!.y >= r.rect.y && anchor!.y <= r.rect.y + r.rect.h,
      );
      if (!inOwn) {
        speakLine(placementVerdictLine(thing, { kind: "cannot", reason: "not-mine" })!);
        return "refused";
      }
    }

    // STOCK pre-gate: an unplaced piece must exist as a `furn.<kind>` stack
    // in one of the house's own containers (storage — the ONE container
    // abstraction). Nothing stored ⇒ "I don't have a chair."
    const glyph = furnitureGlyph(kind);
    let sourceBox: string | null = null;
    for (const objId of houseContainerKeys(session, house.index)) {
      const stock = session.containerStock.get(objId);
      if (stock && (stock[glyph] ?? 0) > 0) {
        sourceBox = objId;
        break;
      }
    }
    if (!sourceBox) {
      speakLine(placementVerdictLine(thing, { kind: "cannot", reason: "have-not" })!);
      return "refused";
    }

    // THE SEARCH — the creature's own judgment over the shared fit rules.
    // The SPOKEN relation rides along: "next to the table" binds to the
    // adjacent band, "near the table" to the room-scaled vicinity ranked by
    // closeness, "in front of / behind the chest" to the facing (or blind-side)
    // wedge. Any other relation leaves the anchor as a mere seed (legacy).
    const anchorMode: AnchorMode | undefined =
      goal.at.relation === "beside" ? "beside"
      : goal.at.relation === "near" ? "near"
      : goal.at.relation === "front" ? "front"
      : goal.at.relation === "behind" ? "behind"
      : undefined;
    const searchRoomId = spokenRoomId ?? opts?.roomId ?? null;
    const pctx = makePlacementContext(center, house, plan, goodDefs, [...pieces]);
    const anchorZone = anchor ? placementZoneAt(pctx, anchor.x, anchor.y) : undefined;
    // THE BLUEPRINT'S OWN MARK, when the caller brought one and the floor still
    // takes it. Offered as the ONLY candidate so the willingness grades score
    // it rather than something merely nearby: an install that lands anywhere
    // but the outline makes the outline a guess.
    const pinnedSpot =
      opts?.spot && placementFeasible(pctx, opts.spot.roomId, {
        x: opts.spot.x, y: opts.spot.y, radius: def.radius, kind,
      }).ok
        ? [{ ...opts.spot, score: 1, factors: [] }]
        : null;
    const candidates = pinnedSpot ?? placementCandidates(pctx, {
      kind,
      radius: def.radius,
      ...(anchor ? { anchor } : {}),
      ...(anchorMode ? { anchorMode } : {}),
      ...(anchorFacing !== undefined ? { anchorFacing } : {}),
      // ONE room filter, two writers: the spoken room word and the autonomous
      // program-fulfillment install name the same thing, so they share it.
      ...(searchRoomId ? { roomId: searchRoomId } : {}),
    });
    // THE LAW'S OWN REFUSAL (construction-structures.md §Demolishing or
    // Changing Rooms): "Put {furniture} in {room} … otherwise refuses 'There
    // is not enough area'." A named room that yields no legal spot has one
    // cause and it is worth naming in those words — the generic willingness
    // grades below would report it as taste ("the place is not good"), which
    // is not what happened. ONLY the spoken room case: the autonomous
    // program-fulfillment install passes `opts.roomId` and never speaks.
    if (spokenRoomId && !candidates.length) {
      speakLine(placementVerdictLine(thing, { kind: "cannot", reason: "wall" })!);
      presenter.toast("There is not enough area", "feedback");
      return "refused";
    }
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
      // THE SILENT KILLER: under `quiet` (the program-fulfillment install) a
      // refusal is never spoken — so it is LOGGED instead. A verdict must always
      // be recorded somewhere, or the house re-tries forever and the piece never
      // stands up, with nothing anywhere reporting why.
      if (opts?.quiet) {
        console.log(`[furnish] ${cid} won't place the ${thing}: ${JSON.stringify(verdict)}`);
      }
      speakLine(line);
      return "refused"; // the order landed (guidance, not RTS)
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
    // THE PIECE COMES OUT OF THE BOX WHERE THE BOX IS. This used to take the
    // unit off the stack and raise the fixture in the same instant, both at the
    // far end — so a resident walked from the chest to the spot with empty
    // hands and a chair appeared when they got there. Furniture going INTO a
    // box was visible and furniture coming OUT of one was not, which is exactly
    // what it looked like. The take is now an event at the box, and the piece
    // is in hands for the walk.
    const boxIndex = box ? 0 : -1;
    let took = false;
    let carried: string | null = null;
    const drawStock = (): boolean => {
      const stock = session.containerStock.get(sourceBox!) ?? {};
      if ((stock[glyph] ?? 0) <= 0) return false; // someone took it meanwhile
      stackTake(stock, glyph);
      session.containerStock.set(sourceBox!, stock);
      took = true;
      return true;
    };
    enqueueNpcErrand(session, npcId, {
      points,
      onArrive: (i) => {
        if (i !== boxIndex || !box || !drawStock()) return;
        carried = takeIntoHands(
          session,
          npcId,
          { kind: "glyph", glyph, at: { x: box.x, y: box.y } },
          { reachAt: box },
        );
      },
      onDone: () => {
        // No box standing in the world to walk to (an unstreamed container):
        // the unit still has to leave the stack, and there was never anything
        // to see. Otherwise the take already happened, at the box.
        if (!took && !drawStock()) return; // honest no-op
        // The piece leaves the hands and BECOMES the fixture — one thing, two
        // situations, never two things. It lands DELIVERED (setUp:false), so it
        // stands as its real model on its side and the setup sweep rises it
        // upright a beat later (the settle).
        if (carried) {
          setDownFromHands(
            session,
            npcId,
            { kind: "consumed" },
            { objId: carried, reachAt: { x: spot.x, y: spot.y } },
          );
        } else {
          fireCarryGesture(npcId, "putdown", { x: spot.x, y: spot.y });
        }
        placeFurniture(deltas, key, {
          id: `furn_${house.index}_p${nextPlacedSerial(deltas.get(key))}`,
          kind,
          x: spot.x,
          y: spot.y,
          radius: def.radius,
          facing: spot.facing,
          openable: def.openable,
          roomId: spot.roomId,
          setUp: false,
          // A SPOKEN ORDER IS A CHANGE TO THE DRAWING (blueprint.ts): the
          // player chose this spot, so the blueprint keeps it and arranges the
          // rest of the room around it. The AUTONOMOUS install (`quiet`) is not
          // pinned — it lands on the blueprint's own mark and stays re-slottable
          // when the plan changes under it.
          ...(opts?.quiet ? {} : { pinned: true }),
        });
        npcChatBubble(session, cid, placementDoneLine(thing).b);
      },
    });
    return "placed";
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
   *  instance (so it can be carried/owned); picking it up merges it back to a count.
   *  What it LOOKS like is `itemObjectSpec`'s business and nobody else's; the
   *  record keeps the true stack glyph, which is what pocketing merges back. */
  function spawnLooseProp(session: QuestSession, glyph: string, x: number, y: number): string | null {
    if (!world) return null;
    const entityId = materialize(session, glyph, null);
    const objId = `small:${entityId}`;
    world.addObject(itemObjectSpec(glyph, objId, { x, y }));
    session.smallProps.set(objId, { entityId, glyph, at: session.townClock }); // `at` paces the tidy grace
    // A CONTAINER IS A CONTAINER WHEREVER IT IS (step ②): a basket on the floor
    // and a barrel on its side are places things can go, so they register as
    // such the moment they exist. Registration is what makes the stock map
    // reachable — without it a loose container has no endpoint and cannot hold
    // anything at all.
    const cdef = containerDefOfGlyph(glyph);
    if (cdef) session.containers.set(objId, cdef.relation);
    session.needsPropsEpoch++; // a new loose prop wakes dormant tidy/fun decides
    return objId;
  }

  /**
   * ONE UNIT LEAVES A STACK AND BECOMES A PROP ON THE GROUND — a MOVE, not a
   * creation. The unit is taken first and the prop made second, and if the prop
   * cannot be made the unit goes straight back. Without that pairing the two
   * halves drift: code that "spawns a prop for a glyph" while the stack still
   * holds it is how one crafted toy came to be carried by two creatures.
   * Returns the prop id, or null when nothing moved (the stack was empty).
   */
  function dropFromStack(
    session: QuestSession,
    stack: Record<string, number>,
    glyph: string,
    x: number,
    y: number,
  ): string | null {
    if (!stackTake(stack, glyph)) return null;
    const objId = spawnLooseProp(session, glyph, x, y);
    if (!objId) stackAdd(stack, glyph); // no world to put it in — keep it where it was
    return objId;
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
    // THE BUILDER'S YARD registers FIRST — before the houses gate below. An
    // age-0 town (a homestead: settlers, no plan houses yet) still has real
    // stock in deltas.stock, and without this endpoint that wood was
    // unreachable by every haul (the "age-0 supply crate" gap).
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

    // THE TOWN WELLS — free water sources: no shelf economics, never run dry
    // (need takes draw directly; the stocked stack serves the player's own
    // bucket). Working one needs grasp — a pet can't draw. The plaza well
    // every town digs, plus one per NEIGHBORHOOD the plan founded past the
    // thirst-cycle walk radius (needs-aware construction, plan.ts wells).
    const wellSpots: Array<{ id: string; x: number; y: number }> = [
      { id: "well", x: town.stage.center.x + PLAZA_WELL.x, y: town.stage.center.y + PLAZA_WELL.y },
      ...(town.plan.wells ?? []).map((wp, wi) => ({
        id: `well_${wi + 1}`,
        x: town.stage.center.x + wp.x,
        y: town.stage.center.y + wp.y,
      })),
    ];
    for (const ws of wellSpots) {
      world!.addObject({
        id: ws.id,
        x: ws.x,
        y: ws.y,
        shape: "box",
        radius: 0.8,
        fixture: "barrel",
        openable: false,
        facing: 0,
        interactions: [],
        contains: [{ relation: "in", capacity: 99 }],
        glyph: "water",
      });
      session.containers.set(ws.id, "in");
      session.containerStock.set(ws.id, { water: 99 });
      session.containerOwner.set(ws.id, TOWN_SCOPE); // communal at the TOWN tier
    }

    // (THE BUILDER'S YARD — city-expansion ②, the ①b gap — registers at the
    //  TOP of this function now, before the houses gate: an age-0 homestead
    //  has stock but no houses, and its yard must still be an endpoint.)

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

  /** The chains' LIVING ends: each good's HARVESTED natural sources standing
   *  beside its producer — the grazing herd whose live yield feeds the good
   *  (wool on the hoof by the weaver) and the orchard plants whose fruit the
   *  farms sell. Resolved from the natural-sources registry (products.ts),
   *  never a good-key special case: kill products (wood, meat, stone) come
   *  from wilderness features, not a herd. Ambient scenery bodies — tiny
   *  tethers, no schedule; they ride the fauna headroom above the crowd
   *  budget. No-op off a town session. */
  function seedTownFauna(session: QuestSession) {
    const town = session.town;
    if (!town || !world) return;
    const c = town.stage.center;
    let treeCount = 0;
    town.stage.goods.forEach((g) => {
      const herds = sourcesForGood(g.good.key, { kind: "animal", method: "harvest" });
      const orchard = sourcesForGood(g.good.key, { kind: "plant", method: "harvest" });
      for (const w of g.producerWorks()) {
        const wk = town.plan.works[w];
        if (!wk) continue;
        const d = workDoorstep(c, wk);
        const herd = herds[0];
        if (herd) {
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + 0.7;
            world!.addNpc({
              id: `fauna:${herd.species}:${w}_${i}`,
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
        if (orchard.length && treeCount < 9) {
          // A short orchard row along the building's north edge, one plant per
          // bearing species — clear of the doorstep (doors face the road).
          orchard.forEach((src, fi) => {
            if (treeCount >= 9) return;
            const tx = c.x + wk.dx + 2 + fi * 4.5;
            const ty = c.y + wk.dy - 2.5;
            world!.addNpc({
              id: `flora:${src.species}:${w}_${fi}`,
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
    if (isWellId(objId)) {
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
    let target: { motive: AttentionMotive; x: number; y: number; objId: string } | null = null;
    let choreTarget: { chore: "tidy" | "provision"; x: number; y: number } | null = null;
    let engageCid: string | null = null;
    if (!blocked) {
      if (hover?.kind === "object") {
        const o = host.state.objects[hover.id];
        const motive = hoverObjectMotive(session, hover.id);
        if (motive && o) target = { motive, x: o.x, y: o.y, objId: hover.id };
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
    // DRAW — ramp the hovered object's motive (fresh strength on an object
    // switch — a new target starts its own ramp), else fade.
    if (target) {
      const d = session.sparkDraw;
      const prev = d && d.motive === target.motive && d.objId === target.objId ? d.strength : 0;
      session.sparkDraw = {
        motive: target.motive,
        x: target.x,
        y: target.y,
        objId: target.objId,
        strength: ramp(prev, dt),
      };
    } else if (session.sparkDraw) {
      const s = decayStrength(session.sparkDraw.strength, dt, SPARK.drawDecayS);
      session.sparkDraw = s > 0 ? { ...session.sparkDraw, strength: s } : null;
      // Draw episode over — the refusal latch resets (a fresh point at the
      // same thing may refuse aloud again).
      if (!session.sparkDraw) session.sparkRefused.clear();
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
   *  actually FIRES right now (a box below its buffer, real clutter, a dirty
   *  wash), so pointing at a full box is a no-op. The need loop then drives +
   *  announces it. */
  function promoteChore(
    session: QuestSession,
    state: WorldState,
    cid: string,
    chore: "tidy" | "provision" | "laundry" | "adopt",
  ): boolean {
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

  // ── THE ATTENTION-ACTION EXECUTOR ──────────────────────────────────────────
  // Item types × creature state → the DEFAULT act (attentionActions, the pure
  // table): food while hungry = eat, a bed while tired = sleep, clean clothing
  // any time = wear, loose things = tidy… The act targets the SPECIFIC
  // indicated instance (consume/wear/fetch by entity id; rest at the named
  // fixture), states its intent first ("I will eat this apple"), and REFUSES
  // ALOUD when the gating meter is too low ("I'm not hungry").

  /** Vocal refusals for the meter-gated acts (mirrors SATISFY_REFUSAL). */
  const ATTENTION_REFUSAL: Record<string, string> = {
    eat: "i_me + hungry.not",
    drink: "i_me + thirsty.not",
    sleep: "i_me + tired.not",
    play: "i_me + bored.not",
    use: "i_me + need.not + bathroom",
    wash: "i_me + dirty.not",
    interact: "i_me + lonely.not",
  };

  /** The creature's meter-driven template for a motive prefix ("hunger",
   *  "social"…), or null. */
  function motiveTemplate(session: QuestSession, cid: string, motive: string): NeedTemplate | null {
    const houseIndex = houseIndexOfCid(cid);
    const member = Number(cid.split("_")[2]);
    const house = residentTownCtx(session, houseIndex)?.house;
    const templates = isPetCid(cid)
      ? petNeedTemplates(session)
      : house
        ? residentNeedTemplates(session, houseIndex, house, member)
        : null;
    return templates?.find((t) => t.key.startsWith(motive) && t.drive.kind === "meter") ?? null;
  }

  /** Everything the attention-action table wants to know about an object. */
  function attentionTargetInfo(session: QuestSession, objId: string): AttentionTargetInfo | null {
    const prop = session.smallProps.get(objId);
    if (prop) {
      const head = headOf(prop.glyph);
      const it = session.creatures?.world.items[prop.entityId];
      const f = glyphFacets(prop.glyph);
      const o = world?.state.objects[objId];
      return {
        affords: CONCEPT_LIBRARY.get(head)?.affords ?? [],
        properties: propertiesOf(prop.glyph),
        stationKind: null,
        isWater: isKindOf(prop.glyph, "water"),
        states: it?.states ?? f.states ?? [],
        isClothing: goodKeyOfGlyph(head) === "clothing",
        unclaimed: !it?.ownerId && !it?.bound,
        loose: !!o && !o.carriedBy && !o.containedIn,
        stockLow: false,
      };
    }
    if (isWellId(objId)) {
      return {
        affords: [], properties: [], stationKind: "well", isWater: true,
        states: [], isClothing: false, unclaimed: false, loose: false, stockLow: false,
      };
    }
    const fm = objId.match(/^furn_\d+_(.+)$/);
    if (fm) {
      const kind = (fm[1] ?? "").replace(/_\d+$/, "");
      return {
        affords: [], properties: [], stationKind: kind, isWater: false,
        states: [], isClothing: false, unclaimed: false, loose: false,
        // A container's "low" is probed for real by promoteChore's fires-check.
        stockLow: session.containers.has(objId),
      };
    }
    return null;
  }

  /** Refuse an act aloud, once per draw episode ("I'm not hungry"). */
  function refuseAttention(session: QuestSession, cid: string, actKind: string, latchKey: string) {
    const line = ATTENTION_REFUSAL[actKind];
    if (!line || session.sparkRefused.has(latchKey)) return;
    session.sparkRefused.add(latchKey);
    if (isPetCid(cid)) ensurePetCreature(session, cid);
    else ensureResidentCreature(session, cid);
    npcChatBubble(session, cid, line);
  }

  /** Install a directed pursuit (rides stepPursuit; a tplKey makes it
   *  need-shaped so completion credits the meter) and announce the intent
   *  ("I will eat this apple"). Compile-checked first — an unplannable goal
   *  installs nothing and announces nothing (returns false). */
  function installAttentionPursuit(
    session: QuestSession,
    cid: string,
    goal: GoalSpec,
    tplKey: string | null,
  ): boolean {
    if (!compileGoal(goal, cid, makeGoalResolver(session))) return false;
    session.liveNeedBodies.add(cid);
    session.needStep.delete(cid);
    session.walk.delete(cid);
    if (tplKey) session.pursuits.set(cid, { source: "need", tplKey, goal, glyph: tplKey });
    else session.pursuits.set(cid, { source: "command", goal, glyph: goal.kind });
    announceSparkIntent(session, cid, goal);
    return true;
  }

  /** No usable instance (a dining table, a barrel) — fire the creature's OWN
   *  need machinery like a spoken self-care order (commandSatisfy's core). */
  function fireNeedFallback(session: QuestSession, cid: string, tpl: NeedTemplate) {
    if (tpl.drive.kind !== "meter") return;
    const key = `${cid}|${tpl.key}`;
    session.needMeters.set(key, Math.max(session.needMeters.get(key) ?? 0, tpl.drive.threshold));
    session.needStep.delete(cid);
    session.liveNeedBodies.add(cid);
    session.sparkActing.add(cid); // the need loop announces the chosen act
  }

  /**
   * Perform the indicated object's DEFAULT act with creature `cid` (the
   * attention-action table): meter-gated acts check the creature's own meter
   * (WILLING fraction — an unwilling creature refuses aloud), anytime acts
   * (wear/get/tidy/get-more) run regardless. `command` = a deliberate order (a
   * board press) — it may interrupt errands; a soft gesture never does.
   * Returns true when something happened (acted or refused aloud).
   */
  function performAttentionAction(
    session: QuestSession,
    cid: string,
    objId: string,
    opts: { command?: boolean } = {},
  ): boolean {
    if (!world) return false;
    const state = world.state;
    const o = state.objects[objId];
    const info = attentionTargetInfo(session, objId);
    if (!o || !info) return false;
    const acts = attentionActions(info);
    if (!acts.length) return false;
    const entityId = session.smallProps.get(objId)?.entityId ?? null;
    const latchKey = `${cid}|${objId}`;
    let refusable: string | null = null; // the first unwilling meter act
    for (const act of acts) {
      if (act.motive) {
        const tpl = motiveTemplate(session, cid, act.motive);
        if (!tpl || tpl.drive.kind !== "meter") continue;
        const meter = session.needMeters.get(`${cid}|${tpl.key}`) ?? 0;
        if (meter < tpl.drive.threshold * SATISFY_WILLING_FRACTION) {
          refusable = refusable ?? act.kind;
          continue; // not hungry/tired enough to mean it — try an anytime act
        }
        if (opts.command) {
          session.npcTasks.delete(avatarIdOf(cid));
          session.pursuits.delete(cid);
        }
        const at = tpl.satisfy.kind === "consume" ? tpl.satisfy.at : undefined;
        let acted = false;
        switch (act.kind) {
          case "eat":
          case "drink":
            if (entityId) {
              acted = installAttentionPursuit(
                session,
                cid,
                { kind: "consume", item: { id: entityId }, ...(at ? { at } : {}) },
                tpl.key,
              );
            } else {
              fireNeedFallback(session, cid, tpl); // a dining table / the well
              acted = true;
            }
            break;
          case "play":
            acted = installAttentionPursuit(
              session,
              cid,
              { kind: "rest", place: { kind: "named", id: objId }, pose: "play", dwellS: restDwellFor(tpl.key, session.scale) },
              tpl.key,
            );
            break;
          case "sleep":
          case "use":
          case "wash":
            acted = installAttentionPursuit(
              session,
              cid,
              {
                kind: "rest",
                place: { kind: "named", id: objId },
                ...(act.kind === "sleep" ? { pose: "sleep" as const } : {}),
                dwellS: restDwellFor(tpl.key, session.scale),
              },
              tpl.key,
            );
            break;
        }
        if (!acted) continue;
        console.log(`[spark] ${cid} → ${act.kind} ${objId}`);
        return true;
      }
      // Anytime acts — no meter gate.
      switch (act.kind) {
        case "washItem":
          if (promoteChore(session, state, cid, "laundry")) {
            console.log(`[spark] ${cid} → wash ${objId}`);
            return true;
          }
          continue;
        case "wear":
          if (!entityId) continue;
          if (opts.command) session.npcTasks.delete(avatarIdOf(cid));
          if (!installAttentionPursuit(session, cid, { kind: "wear", item: { id: entityId } }, null)) continue;
          console.log(`[spark] ${cid} → wear ${objId}`);
          return true;
        case "getMore":
          if (promoteChore(session, state, cid, "provision")) {
            console.log(`[spark] ${cid} → get more @${objId}`);
            return true;
          }
          continue;
        case "get":
          if (!entityId) continue;
          if (opts.command) session.npcTasks.delete(avatarIdOf(cid));
          if (!installAttentionPursuit(session, cid, { kind: "fetch", item: { id: entityId } }, null)) continue;
          console.log(`[spark] ${cid} → get ${objId}`);
          return true;
        case "tidy":
          if (promoteChore(session, state, cid, "tidy")) {
            console.log(`[spark] ${cid} → tidy ${objId}`);
            return true;
          }
          continue;
      }
    }
    // Nothing ran — if a meter act was declined, say so ("I'm not hungry").
    if (refusable) {
      refuseAttention(session, cid, refusable, latchKey);
      return true;
    }
    return false;
  }

  /** DIRECT the engaged creature `cid` at a specific point/object (an oscillation
   *  or a board press): engage it fully, then — an object → its table act
   *  (performAttentionAction, exact instance); a bare point → go there.
   *  Idle-gated (never interrupts) unless `command`. */
  function directCreatureTo(
    session: QuestSession,
    cid: string,
    pt: { x: number; y: number },
    objId: string | null,
    opts: { command?: boolean } = {},
  ) {
    if (!world) return;
    if (!opts.command && !idleForDirect(session, cid)) return;
    engageCreature(session, cid, ENGAGE_DIRECT_HOLD_S);
    if (objId && performAttentionAction(session, cid, objId, opts)) return;
    // A bare point (or an object asking nothing) — go there, if it's a real move.
    const body = world.state.avatars[cid];
    const dist = body ? Math.hypot(body.x - pt.x, body.y - pt.y) : 0;
    if (dist < DIRECT_MIN_M || dist > DIRECT_MAX_M) return;
    const goal: GoalSpec = { kind: "goTo", place: { kind: "point", x: pt.x, y: pt.y } };
    session.pursuits.set(cid, { source: "command", goal, glyph: "here" });
    announceSparkIntent(session, cid, goal);
    console.log(`[spark] direct ${cid} → goTo @${pt.x.toFixed(1)},${pt.y.toFixed(1)}`);
  }

  /** Direct creature `cid` at ANOTHER CREATURE (the oscillation with a body on
   *  the point side): a target with a BLOCKED, stated need → help it (the
   *  adoption rows); else, social — talk to it (willing-gated, refuses aloud). */
  function performAttentionInteract(session: QuestSession, cid: string, targetCid: string) {
    if (!world || cid === targetCid) return;
    engageCreature(session, cid, ENGAGE_DIRECT_HOLD_S);
    // HELP: the target has announced an unmet need (its blocked beg) and this
    // creature's adoption rows can actually supply it.
    const targetBlocked = [...session.dlogged].some((k) => k.startsWith(`needs:blocked:${targetCid}|`));
    if (targetBlocked && promoteChore(session, world.state, cid, "adopt")) {
      const goal: GoalSpec = { kind: "help", target: targetCid };
      announceSparkIntent(session, cid, goal);
      console.log(`[spark] ${cid} → help ${targetCid}`);
      return;
    }
    // INTERACT: social, willing-gated.
    const tpl = motiveTemplate(session, cid, "social");
    if (tpl && tpl.drive.kind === "meter") {
      const meter = session.needMeters.get(`${cid}|${tpl.key}`) ?? 0;
      if (meter < tpl.drive.threshold * SATISFY_WILLING_FRACTION) {
        refuseAttention(session, cid, "interact", `${cid}|${targetCid}`);
        return;
      }
    }
    const goal: GoalSpec = { kind: "converse", target: targetCid };
    session.pursuits.set(cid, { source: "command", goal, glyph: "talk" });
    announceSparkIntent(session, cid, goal);
    console.log(`[spark] ${cid} → interact ${targetCid}`);
  }

  /** WHO a board selection addresses: the LAST creature the player started a
   *  conversation with — while its body is still on screen (streamed in) —
   *  else the engaged creature, else the nearest idle body present. */
  function attentionAddressee(session: QuestSession, pt: { x: number; y: number }): string | null {
    if (!world) return null;
    const last = session.lastConvoCid;
    if (
      last &&
      last !== PLAYER_ID &&
      (isPetCid(last) || /^resident_\d+_\d+$/.test(last)) &&
      world.state.avatars[avatarIdOf(last)]
    ) {
      return last;
    }
    const engaged = session.sparkFocus;
    if (engaged && engaged.strength >= ENGAGE_MIN && idleForDirect(session, engaged.cid)) return engaged.cid;
    return nearestIdleGroupCreature(session, world.state, pt, ATTEND_REACH_M);
  }

  /** A pressed CONTAINER ITEM (a glyph stack) is a COMMAND-LEVEL instruction to
   *  the addressee (attentionAddressee — the last conversation partner first):
   *  a motive glyph runs its table act on a matching unit ("I will eat the
   *  apple"), clean clothing is worn, anything else fetched. Willing-gated —
   *  a too-low meter refuses aloud ("I'm not hungry"). */
  function attendContainerGlyph(session: QuestSession, boxId: string, glyph: string) {
    if (!world) return;
    const box = world.state.objects[boxId];
    if (!box) return;
    const cid = attentionAddressee(session, { x: box.x, y: box.y });
    if (!cid) return;
    engageCreature(session, cid, ENGAGE_DIRECT_HOLD_S);
    const head = headOf(glyph);
    const f = glyphFacets(glyph);
    const match: NeedTarget = {
      kind: head,
      ...(f.descriptors.length ? { descriptors: f.descriptors } : {}),
    };
    const motive = glyphMotive(glyph);
    const MOTIVE_ACT: Record<AttentionMotive, string> = {
      hunger: "eat", thirst: "drink", fun: "play", energy: "sleep", waste: "use", hygiene: "wash",
    };
    if (motive) {
      const tpl = motiveTemplate(session, cid, motive);
      if (tpl && tpl.drive.kind === "meter") {
        const meter = session.needMeters.get(`${cid}|${tpl.key}`) ?? 0;
        if (meter < tpl.drive.threshold * SATISFY_WILLING_FRACTION) {
          refuseAttention(session, cid, MOTIVE_ACT[motive], `${cid}|${boxId}|${glyph}`);
          return;
        }
        // Command-level: the new order overrides an old errand.
        session.npcTasks.delete(avatarIdOf(cid));
        session.pursuits.delete(cid);
        if (motive === "hunger" || motive === "thirst") {
          const at = tpl.satisfy.kind === "consume" ? tpl.satisfy.at : undefined;
          installAttentionPursuit(session, cid, { kind: "consume", item: { match }, ...(at ? { at } : {}) }, tpl.key);
          return;
        }
        if (motive === "fun") {
          installAttentionPursuit(session, cid, { kind: "fetch", item: { match } }, null);
          return;
        }
        fireNeedFallback(session, cid, tpl);
        return;
      }
    }
    session.npcTasks.delete(avatarIdOf(cid));
    session.pursuits.delete(cid);
    if (goodKeyOfGlyph(head) === "clothing" && !f.states.includes("dirty")) {
      installAttentionPursuit(session, cid, { kind: "wear", item: { match } }, null);
      return;
    }
    installAttentionPursuit(session, cid, { kind: "fetch", item: { match } }, null);
  }

  /** The HOVER-FIRE + CHORE-hover step: when the engaged idle creature's drawn
   *  object crosses the trigger (its own meter + the attention bonus over the
   *  fire threshold), it performs the object's table act on THAT instance;
   *  a hovered storage/clutter object promotes its chore. */
  function stepSparkDirect(session: QuestSession, state: WorldState) {
    const f = session.sparkFocus;
    if (!f || f.strength < ENGAGE_MIN) return; // no engaged creature → nobody acts
    if (!idleForDirect(session, f.cid)) return;
    const d = session.sparkDraw;
    if (d && d.motive && d.objId) {
      const tpl = motiveTemplate(session, f.cid, d.motive);
      if (tpl && tpl.drive.kind === "meter") {
        const raw = session.needMeters.get(`${f.cid}|${tpl.key}`) ?? 0;
        const bonus = attentionBonus(d, f, f.cid, tpl.key);
        if (raw + bonus >= tpl.drive.threshold) {
          if (performAttentionAction(session, f.cid, d.objId)) {
            session.sparkDraw = null; // consumed
            session.sparkExplicitUntil = 0;
          }
        }
      }
    }
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
      } else if (osc) {
        // ANOTHER creature while a gesture is anchored: it is the POINT side —
        // "you two" (oscillating A↔B directs A at B: help / talk). The anchor
        // only changes when the gesture times out.
        const b = host.state.avatars[cid];
        if (b) {
          if (osc.lastSide === "cre") osc.flips++;
          osc.sinceFlip = 0;
          osc.lastSide = "pt";
          osc.x = b.x;
          osc.y = b.y;
          osc.objId = `cre:${cid}`;
        }
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
        if (osc.objId?.startsWith("cre:")) {
          performAttentionInteract(session, osc.cid, osc.objId.slice(4));
        } else {
          directCreatureTo(session, osc.cid, { x: osc.x, y: osc.y }, osc.objId);
        }
        session.sparkOsc = null; // consumed
      }
    }
  }

  // "YOU TWO" IS AN ALTERNATION, NOT A MIDPOINT. It used to be a dwell on the
  // GAP between two townsfolk — built on a misreading of the gesture, and a
  // proximity radius besides (it had to bail whenever the gaze was actually ON
  // somebody, which is the exact inverse of the hover law). The real gesture is
  // looking from one person to the other and back: `stepSparkOsc` already reads
  // it, and its creature↔creature arm routes A at B through
  // `performAttentionInteract` — a real `converse` pursuit rather than the canned
  // exchange this used to fire. Relations warm through the ordinary exchange path
  // that any conversation runs, so nothing is lost with it gone.

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

  /** The soft-control ATTENTION READOUT (attention-debug-3d.ts): the engaged
   *  creature, how much of the player's attention is ON it (engagement → the
   *  ring), and how close the drawn/chore thing is to TRIGGERING its need (→ the
   *  dash density). Empty when nothing is engaged. Debug-only; read each frame
   *  while path debug is on. */
  function attentionDebugLinks(session: QuestSession): AttentionDebugLink[] {
    const engage = session.sparkFocus;
    if (!world || !engage || engage.strength <= 0) return [];
    const av = world.state.avatars[engage.cid];
    if (!av) return [];
    const from = { x: av.x, y: av.y, floor: av.floor };
    let to: { x: number; y: number } | null = null;
    let trigger = 0;
    const draw = session.sparkDraw;
    const chore = session.sparkChore;
    if (draw && draw.motive && draw.strength > 0) {
      to = { x: draw.x, y: draw.y };
      // (raw meter for the drawn motive + the attention bonus) / threshold(=1).
      const meterKey = [...session.needMeters.keys()].find((k) => k.startsWith(`${engage.cid}|${draw.motive}`));
      const rawMeter = meterKey ? (session.needMeters.get(meterKey) ?? 0) : 0;
      trigger = Math.min(1, rawMeter + SPARK.bonus * draw.strength * engage.strength);
    } else if (chore && chore.strength > 0) {
      to = { x: chore.x, y: chore.y };
      trigger = chore.strength; // a chore has no meter — show how deliberate the hover is
    }
    return [{ from, to, engagement: engage.strength, trigger }];
  }

  /** The word a world object is named by on the board (AAC — pressing it says
   *  it). A loose prop speaks its glyph; a fixture its station kind. */
  function objectWord(session: QuestSession, objId: string): string {
    const prop = session.smallProps.get(objId);
    if (prop) return drawnMakeable(prop.glyph); // an unplaced piece IS a chair, not a "furn"
    if (isWellId(objId)) return "water";
    const ws = wildSourceOf(session, objId);
    if (ws) return ws.species; // a wild source IS its species (oak, sheep)
    // THE SPEC'S FIXTURE KIND IS THE TRUTH, ahead of the id — and ids LIE. The
    // food container keeps its historical `furn_<n>_chest_food` id while its
    // kind is `refrigerator` (stations.ts `kindByGood`), so reading the id
    // called the fridge a "chest": a word the vocabulary doesn't carry, which
    // is why that button had no icon either. `fixtureWord` then folds the kinds
    // the vocabulary doesn't distinguish (chest→box, cupboard→cabinet).
    const fx = world?.state.spec.objects.find((o) => o.id === objId)?.fixture;
    if (fx) return fixtureWord(fx);
    // A piece with no fixture flag: fall back to the id's own noun.
    const fm = objId.match(/^furn_\d+_(.+)$/);
    if (fm) return fixtureWord(((fm[1] ?? "").replace(/_\d+$/, "").split("_")[0]) || "thing");
    return "thing";
  }

  /** Draw a creature's attention to a SPECIFIC object (a pressed board word) —
   *  the last conversation partner (attentionAddressee), else the engaged /
   *  nearest idle body present. A deliberate selection = COMMAND-LEVEL: it may
   *  override an errand; it never pulls a distant body in. */
  function attendObject(session: QuestSession, objId: string) {
    if (!world) return;
    const o = world.state.objects[objId];
    if (!o) return;
    const pt = { x: o.x, y: o.y };
    const cid = attentionAddressee(session, pt);
    if (!cid) return;
    directCreatureTo(session, cid, pt, objId, { command: true });
  }

  /** Where a container STANDS this frame: a placed object's spot, or — a
   *  WILD PRODUCT ANIMAL (step ④): the container IS a walking body — its
   *  avatar's live position. One container abstraction; the spot follows.
   *  (Distinct from containerAnchor below, the transfer layer's walk-to
   *  resolver, which also answers for streamed-out furniture.) */
  function containerStandpoint(state: WorldState, objId: string): { x: number; y: number } | undefined {
    return state.objects[objId] ?? state.avatars[objId];
  }

  /** THE FURNITURE THE GAZE IS AIMED AT (furniture-aim.ts holds the rule and its
   *  reasoning) — the ONE resolver the board popup and the put gesture target
   *  through: the hovered piece, the piece a hovered prop sits in, else nothing.
   *  This binds it to the live session: the registered containers, the spec's
   *  FIXTURE flag (furniture, stocked or not), and live standpoints. */
  function gazeFurniture(
    session: QuestSession,
    state: WorldState,
    gz: FurnitureAimGaze,
    me: { x: number; y: number } | undefined,
    want: "furniture" | "container",
    /** NAMING vs ACTING: reach may veto acting on a thing, but it must never
     *  decide what the gaze is AIMED at. Pass true to resolve the target the
     *  spark is over regardless of how far the body stands from it. */
    ignoreReach = false,
  ): { id: string; x: number; y: number } | null {
    return resolveFurnitureAim(
      {
        isContainer: (id) => session.containers.has(id),
        isFurniture: (id) => !!state.spec.objects.find((o) => o.id === id)?.fixture,
        containedIn: (id) => state.objects[id]?.containedIn?.objectId,
        standpoint: (id) => containerStandpoint(state, id),
        ids: () => session.containers.keys(),
      },
      gz,
      { want, me, spirit: spiritNow() || ignoreReach, reach: CONVO_RADIUS, fixRadius: CONVO_FIG_RADIUS },
    );
  }

  /** Inverse of `avatarIdOf`: the creature a hovered BODY belongs to. */
  function cidOfAvatar(avatarId: string): string {
    return avatarId.startsWith("npc_") ? avatarId.slice(4) : avatarId;
  }

  /**
   * THE ONE HOVER READ (dwell-interaction.ts): what the spark is over this
   * frame — a creature, a fixture/object, or bare ground. Exactly one answer,
   * and it is the answer BOTH the dwell interactions and the spark's own
   * highlight resolve through, so what is lit can never differ from what fires.
   *
   * THE SCREEN PICK NAMES THE THING. No candidate list, no radius: a body the
   * gaze rests on IS the target even if it stands far off or has nothing to say.
   * That inversion is exactly what made hovering a person fail to start a
   * conversation — the old talk gesture discarded any body beyond CONVO_RADIUS,
   * and any node it judged un-talkable, BEFORE it ever consulted the gaze.
   *
   * Order is by specificity, never by distance: a body wins over the furniture
   * it stands among, furniture wins over the floor beneath it, and bare ground
   * is what is left when the gaze is on nothing at all.
   */
  function hoverTargetOf(
    session: QuestSession,
    state: WorldState,
    gz: FurnitureAimGaze,
    me: { x: number; y: number } | undefined,
  ): HoverTarget | null {
    const hv = gz.hover;
    if (hv?.kind === "avatar" && hv.id !== PLAYER_ID) {
      const av = state.avatars[hv.id];
      if (av) return { kind: "creature", id: cidOfAvatar(hv.id), x: av.x, y: av.y };
    }
    const fx = gazeFurniture(session, state, gz, me, "furniture", true);
    if (fx) return { kind: "object", id: fx.id, x: fx.x, y: fx.y };
    const fix = gz.committedWorld;
    return fix ? { kind: "ground", x: fix.x, y: fix.y } : null;
  }

  /** The identity of a hover, for re-anchoring the dwell trackers. Two different
   *  things must never inherit each other's accumulated fill. */
  function hoverKeyOf(t: HoverTarget | null): string | null {
    if (!t) return null;
    return t.kind === "ground" ? "ground" : `${t.kind}:${t.id}`;
  }

  /** OPEN a piece of FURNITURE as a SELECTION POPUP: the thing itself on the board,
   *  plus its contents as takeable STACKS when it holds any. An EMPTY chest — or a
   *  chair, which holds nothing ever — still shows: the board names what the player
   *  is looking at (pressing it draws the family's attention there), which is why
   *  this no longer refuses a stock-less piece and quietly left the builder board up.
   *  Stays open until the player walks/looks away (leave-dwell). */
  function openContainer(session: QuestSession, containerObjId: string) {
    if (!world || !containerStandpoint(world.state, containerObjId)) return;
    regrowWildStock(session, containerObjId); // ripen before the board is drawn
    // ONE SELECTION AT A TIME: reaching for a thing releases the build spot
    // that was selected, exactly as selecting a spot closes an open box.
    if (buildSpotId !== null) {
      buildSpotId = null;
      session.civicSig = "";
    }
    container = { objId: containerObjId, items: [] };
    resetDwells(); // a SWITCH from another piece must not inherit its fill
    voice?.cancel();
    presentContainer(session);
  }

  /** Render the open furniture as a board: one option per glyph STACK (its label
   *  carrying the count) — CONTENTS FIRST — then the thing itself. */
  function presentContainer(session: QuestSession) {
    if (!container) return;
    const contents = containerContents(session, container.objId);
    const glyphs = Object.keys(contents);
    container.items = glyphs;
    const cObj = world ? containerStandpoint(world.state, container.objId) : undefined;
    if (!cObj) {
      closeContainer(); // it streamed away / was consumed mid-board
      return;
    }
    // HOLD THE CAMERA (and an embodied body's approach) only for a board with STOCK
    // on it — that hold exists to steady a box you're reaching into. A bare naming
    // board must not lock the view or walk the body over for a glance at a chair.
    world?.setConversation(glyphs.length > 0 ? { x: cObj.x, y: cObj.y } : null);
    pushBoard({
      kind: "acts",
      nodeId: container.objId,
      posedByEntityId: container.objId,
      prompt: glyphs.length > 0 ? "open" : "",
      promptText: "",
      options: [
        ...glyphs.map((glyph) => {
          const count = contents[glyph]!;
          // The STACK's own key stays the id (that is what a take moves); the
          // word and the picture are its DISPLAY face — a stored piece of
          // furniture is a `furn.<kind>` stack whose head is bookkeeping, so it
          // would otherwise read "furn" with no artwork behind it.
          const head = spokenMakeable(glyph);
          return {
            id: `take:${glyph}`,
            label: count > 1 ? `${head} ×${count}` : head,
            glyph: drawnMakeable(glyph),
            spokenText: "",
          };
        }),
        // A WILD, unowned product animal offers the CLAIM (step ④ taming):
        // "my sheep" — pressing it makes the animal the player's.
        ...(((): QuestBoardView["options"] => {
          const wa = wildAnimalOf(session, container.objId);
          if (!wa || session.containerOwner.get(container.objId)) return [];
          const g = `${wa.species}.my`;
          return [{ id: `tame:${container.objId}`, label: g, glyph: g, spokenText: "" }];
        })()),
        // Phase 3 (attention-spark.md): the FURNITURE ITSELF, after its contents —
        // pressing it draws the family's attention to the thing (a fill-check)
        // rather than taking from it. On a stock-less piece it is the whole board.
        {
          id: `attend:${container.objId}`,
          label: objectWord(session, container.objId),
          glyph: objectWord(session, container.objId),
          spokenText: "",
        },
      ],
    }, () => closeContainer()); // BACK puts the thing down
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
    // Your OWN private property never objects to you (a tamed animal's owner
    // milks it freely); everyone else's still does.
    if (isPrivateOwner(cOwner) && world && !mayUse(PLAYER_CREATURE_ID, null, cOwner)) {
      const objector = objectingOwner(cOwner, containerStandpoint(world.state, objId));
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
      regrowWildStock(session, objId); // matured units are takeable this frame
      const stock = session.containerStock.get(objId) ?? {};
      if (!stackTake(stock, glyph)) return;
      // TOOLS MULTIPLY THE TAKE (step ④, registry-declared): the right tool
      // in the pocket moves more units per act — axe on wood, pick on stone.
      // Bare hands always work at one. Extra units add to the pocket here;
      // the common path below adds the first.
      const ws = wildSourceOf(session, objId);
      if (ws) {
        const units = takeUnitsOf(naturalSourceOf(ws.species), glyph, (t) => (session.pocket[t] ?? 0) > 0);
        for (let took = 1; took < units && stackTake(stock, glyph); took++) {
          stackAdd(session.pocket, glyph);
        }
      }
      session.containerStock.set(objId, stock);
      // A LIVE take off a standing source arms its regrow clock (no-op for
      // kill glyphs and non-wild containers).
      if (ws) armHarvestRegrow(ws, glyph, session.taskClock, FOOD_DAY_SEC);
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
    fellIfConsumed(session, objId); // an emptied kill-source is felled
  }

  function closeContainer() {
    container = null;
    clearBoard();
    world?.setConversation(null);
    resetDwells();
  }

  /** The wild PRODUCT ANIMAL a container id names (by its body id), or
   *  undefined for anything that isn't one. */
  function wildAnimalOf(
    session: QuestSession,
    objId: string,
  ): (WildernessCreature & { species: string }) | undefined {
    const c = session.wilderness?.creatures.find((x) => x.species && wildAnimalBodyId(x) === objId);
    return c?.species ? (c as WildernessCreature & { species: string }) : undefined;
  }

  /** The wild yield-bearer a container id names: a standing FEATURE by its
   *  container id (its body id when embodied, its own id as a box), or a
   *  PRODUCT ANIMAL by its body id. Undefined for everything else (house
   *  boxes, market shelves, plain locals). */
  function wildSourceOf(session: QuestSession, objId: string): WildSource | undefined {
    const w = session.wilderness;
    if (!w) return undefined;
    return (
      w.features.find((x) => wildFeatureContainerId(x) === objId) ?? wildAnimalOf(session, objId)
    );
  }

  /** TAME a wild product animal (step ④ husbandry): the claim makes it the
   *  PLAYER'S — ownership.ts private property (the stop-gate now defends it
   *  from others; your own never objects to you) — and the body re-tethers
   *  to graze where it was claimed instead of drifting the wild. No mind is
   *  added: livestock stays needless (relations' authority axis is for
   *  minds; an owned animal's bond IS the ownership row). On promotion to
   *  a town the owned animals are the seam that seeds the domestic herd
   *  (economy.ts role "domestic" — the registry-derivation step closes it). */
  function tameWildAnimal(session: QuestSession, objId: string) {
    const c = wildAnimalOf(session, objId);
    if (!c || !world) return;
    if (session.containerOwner.get(objId)) return; // already someone's
    session.containerOwner.set(objId, `creature:${PLAYER_CREATURE_ID}`);
    // Re-tether: same body id (model cache holds), grazing close to the
    // spot of the claim.
    const av = world.state.avatars[objId];
    const at = av ? { x: av.x, y: av.y } : { x: c.x, y: c.y };
    world.removeNpc(objId);
    world.addNpc({
      id: objId,
      x: at.x,
      y: at.y,
      species: c.species,
      behavior: { movement: "wander", wanderRadius: 6, home: at, speed: 0.8, conversationRadius: 3 },
    });
    // The claim, stamped over the animal ("my sheep").
    showWorldBubble(world.state, `tamed:${objId}`, {
      anchor: { kind: "avatar", id: objId },
      text: npcStatement(`${c.species}.my`),
      glyph: `${c.species}.my`,
      ttl: 2.5,
    });
    presentContainer(session); // the tame option retires; the takes stay
  }

  /** DEPLETION MADE VISIBLE (phase 5 step ④): re-stand a partly-quarried
   *  feature at the size its REMAINING kill stock earns it (wildFeatureRadius
   *  is the one calculator — the spawner sizes the same way, so a rock cut
   *  down to one stone and a rock that rolled one stone are the same pebble).
   *
   *  Re-stood, not re-built: the object is removed and added back under its
   *  own id, which is the established idiom here (tameWildAnimal re-tethers a
   *  body the same way) and the only public way to change a spec — the spec
   *  array is what the engine's fixture/collision caches are keyed on, so
   *  mutating a radius in place would leave them stale. Nothing observes the
   *  gap: the removal and the re-add happen inside one synchronous take, so
   *  no frame, no renderer sweep and no container board ever sees the object
   *  missing. The container maps are keyed by id and are not touched at all.
   *
   *  Only a BOX feature can be resized — an embodied plant stands as a real
   *  grown body, whose size is its blueprint's business, and a product animal
   *  is a body too (a half-milked cow is not a smaller cow). */
  function resizeWildFeature(session: QuestSession, f: WildernessFeature, objId: string) {
    if (!world || wildFeatureEmbodied(f)) return;
    const spec = world.state.spec.objects.find((o) => o.id === objId);
    if (!spec) return;
    const radius = wildFeatureRadius(f.species, session.containerStock.get(objId));
    if (Math.abs(spec.radius - radius) < 0.01) return; // nothing a player could see
    // A re-add mints FRESH object state, and the two things that survive a
    // resize in the player's eyes are the lid someone is holding open and
    // whatever is sitting inside (removeWorldObject frees contents by design —
    // correct for a despawn, wrong for a resize). Carry both across so the
    // only observable difference is the size.
    const at = world.state.objects[objId];
    const held = at?.heldOpen;
    const open = at?.open;
    const floor = at?.floor;
    const inside = Object.values(world.state.objects)
      .filter((o) => o.containedIn?.objectId === objId)
      .map((o) => ({ id: o.id, relation: o.containedIn!.relation }));
    world.removeObject(objId);
    world.addObject({ ...spec, x: at?.x ?? f.x, y: at?.y ?? f.y, radius });
    const now = world.state.objects[objId];
    if (now) {
      if (held !== undefined) now.heldOpen = held;
      if (open !== undefined) now.open = open;
      if (floor !== undefined) now.floor = floor;
    }
    for (const c of inside) {
      const o = world.state.objects[c.id];
      if (o) o.containedIn = { objectId: objId, relation: c.relation };
    }
  }

  /** KILL-METHOD ACQUISITION MADE REAL (products.ts): a wild source that is
   *  consumable (it carries kill products — the tree IS its wood, the animal
   *  its meat) disappears the moment its KILL stock empties: the last unit
   *  taken IS the felling/quarrying/kill, even while harvest yield still
   *  hangs (a felled tree bears nothing, a taken animal gives no more milk —
   *  the harvest stock dies with the source). Pure-harvest sources persist
   *  picked clean. A feature's object is removed; a product animal's BODY
   *  is removed (sandbox termination — clean, no carcass state). No-op for
   *  any container that isn't a wild source. */
  function fellIfConsumed(session: QuestSession, objId: string) {
    const w = session.wilderness;
    if (!w || !world) return;
    const fi = w.features.findIndex((f) => wildFeatureContainerId(f) === objId);
    const ci = fi < 0 ? w.creatures.findIndex((c) => c.species && wildAnimalBodyId(c) === objId) : -1;
    if (fi < 0 && ci < 0) return;
    const species = fi >= 0 ? w.features[fi]!.species : w.creatures[ci]!.species!;
    const src = naturalSourceOf(species);
    if (!src) return;
    // A take that DIDN'T finish the source still changed it: what is left of a
    // rock is smaller than what was there. Riding the felling check is the
    // whole point — every path that empties a wild source already calls this
    // (the player's take, a commanded body's `stock:` pick, a haul's load), so
    // depletion becomes visible everywhere at once without one new call site,
    // one new flag, or anything running per frame.
    if (fi >= 0) resizeWildFeature(session, w.features[fi]!, objId);
    if (!sourceKillExhausted(src, session.containerStock.get(objId))) return;
    if (container?.objId === objId) closeContainer();
    // The source's stand-in goes with it: a placed box object, or — an
    // embodied plant / product animal — its body.
    if (world.state.objects[objId]) world.removeObject(objId);
    else world.removeNpc(objId);
    if (fi >= 0) w.features.splice(fi, 1);
    else w.creatures.splice(ci, 1);
    session.containers.delete(objId);
    session.containerStock.delete(objId);
    session.containerOwner.delete(objId);
  }

  /** LIVE-HARVEST REGROWTH made real (products.ts regrowDays): apply a wild
   *  source's matured units to its live stock before anyone looks at or
   *  takes from it — the standing tree bears fruit again, the ewe's wool
   *  grows back. Lazy and deterministic — the ledger holds absolute
   *  taskClock deadlines (the clock that runs in EVERY session), so closed
   *  containers ripen too, and a long absence catches up whole periods up
   *  to the rolled bearing capacity. The pure calculator lives in
   *  wilderness.ts; the stacks are only ever written HERE. */
  function regrowWildStock(session: QuestSession, objId: string) {
    const s = wildSourceOf(session, objId);
    if (!s) return;
    const stock = session.containerStock.get(objId) ?? {};
    const due = dueHarvestRegrowth(s, stock, session.taskClock, FOOD_DAY_SEC);
    if (!due) return;
    for (const [glyph, n] of Object.entries(due.add)) stock[glyph] = (stock[glyph] ?? 0) + n;
    s.regrowAt = due.regrowAt;
    session.containerStock.set(objId, stock);
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
    const text = preText ?? npcStatement(glyph, sym, cid);
    if (at) {
      showWorldBubble(world.state, `char:${node.npcEntityId}`, {
        anchor: { kind: "point", x: at.x, y: at.y },
        text,
        glyph,
        ttl: 5,
      });
    }
    // MULTIPLAYER: the owner runs the creatures, so their lines happen HERE —
    // mirror each one over the wire as an ordinary avatar `say`, and followers
    // render the bubble through the same applyInbound → setAvatarSpeech path a
    // remote player's speech takes. This is THE NPC-dialogue chokepoint.
    if (mp?.role === "owner" && mpNet) {
      const avatarId = avatarIdOf(cid);
      if (world.state.avatars[avatarId]) mpNet.send([sayMessage(avatarId, text, glyph)]);
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
    // Square the pair up: two idle creatures talking turn to FACE EACH OTHER
    // for the exchange (both stand still, so the heading holds through the
    // reply). Sim-side facing state — the renderer applies the game-angle→yaw
    // mirror. Reasserted at the reply below in case a body has drifted.
    const sAvatar = chatAvatar(world.state, speaker);
    const lAvatar = chatAvatar(world.state, listener);
    if (sAvatar && lAvatar) faceEachOther(sAvatar, lAvatar);
    // WHO IS TALKING, for the dollhouse camera. An ambient exchange is a BURST
    // (both lines are posted from this one call), so there is no standing state
    // to read — the pair is LATCHED here for as long as its words are on screen
    // and republished every frame by `publishConversationPair`. This is the only
    // moment in the whole host that knows two BODIES just started talking.
    if (sAvatar && lAvatar) {
      chatFocus = { a: avatarIdOf(speaker), b: avatarIdOf(listener), hold: CHAT_FOCUS_S };
    }
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
      // Still facing each other as the listener answers (both were idle; this
      // corrects for any small drift since the opener).
      const sAv = chatAvatar(world.state, speaker);
      const lAv = chatAvatar(world.state, listener);
      if (sAv && lAv) faceEachOther(sAv, lAv);
      npcChatBubble(session, listener, reply!, text);
      if (target) pointNpcArm(listener, target);
    }, CHAT_REPLY_MS);
  }

  /** A converse creature's live avatar, under either id convention: a quest poser is
   *  `npc_<cid>`, a streamed town resident's body id IS the bare `cid` (`resident_*`). */
  function chatAvatar(state: WorldState, cid: string) {
    return state.avatars[`npc_${cid}`] ?? state.avatars[cid];
  }

  /** The AMBIENT pair the dollhouse camera is currently framing, with the
   *  seconds left on its latch. Set by `runNpcExchange`, counted down and
   *  published by `publishConversationPair`. */
  let chatFocus: { a: string; b: string; hold: number } | null = null;

  /**
   * WHO IS TALKING → the camera (construction phase 5 step 5). Runs once a
   * frame and hands the world host the ONE pair of bodies in a conversation.
   *
   * There is no standing "conversation" record anywhere in the sim to read:
   * an ambient exchange is a burst (`runNpcExchange`, latched into `chatFocus`
   * above) and the player's conversation is an open QUESTION (`choice`), not a
   * pair. So this is where the two are reconciled into the single fact a camera
   * needs. The PLAYER's conversation wins — it is the deliberate one, and the
   * ambient chatter is already suppressed while it stands (stepNpcChatter's
   * early return), so the two can never fight over the frame.
   *
   * The player side publishes BOTH ids even though the spirit has no body: the
   * renderer frames whichever of the pair it can actually see, so a formless
   * spirit talking to Ada frames Ada alone — exactly right — while an EMBODIED
   * player talking to Ada frames the two of them.
   */
  function publishConversationPair(dt: number) {
    if (!world) return;
    if (chatFocus) {
      chatFocus.hold -= dt;
      if (chatFocus.hold <= 0) chatFocus = null;
    }
    const partnerCid = choice ? choice.nodeId : null;
    if (partnerCid) {
      // A player conversation SUPERSEDES the ambient latch outright — otherwise
      // a chat that started a beat earlier would keep the camera on strangers
      // while the student is mid-turn with someone else.
      chatFocus = null;
      world.setConversationPair({ a: world.drivenBody(), b: avatarIdOf(partnerCid) });
      return;
    }
    world.setConversationPair(chatFocus ? { a: chatFocus.a, b: chatFocus.b } : null);
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
          if (i === 0 && !npcCarrying(npcId)) {
            takeIntoHands(session, npcId, { kind: "object", objId: stock.objectId });
          }
          if (i === 1 && host.state.objects[stock.objectId]?.carriedBy === npcId) {
            setDownFromHands(session, npcId, { kind: "ground", ...handover }, { objId: stock.objectId });
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
          if (i === 0 && !npcCarrying(npcId)) {
            takeIntoHands(session, npcId, { kind: "object", objId: held.objectId });
          }
          if (i === 1 && host.state.objects[held.objectId]?.carriedBy === npcId) {
            setDownFromHands(
              session,
              npcId,
              { kind: "ground", x: staging.stockpile.x, y: staging.stockpile.y },
              { objId: held.objectId },
            );
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
          pushBoard(
            {
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
            },
            // BACK declines the question — the runtime's own cancel path.
            () => dispatchInput({ type: "cancel-choice", nodeId: command.nodeId }),
          );
          break;
        }
        case "dismiss-choice":
          choice = null;
          clearBoard();
          // Leave the conversation: release the camera + resume steering.
          world?.setConversation(null);
          resetDwells();
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
    // ATTENTION READOUT: rides the SAME toggle — engagement rings + dotted
    // trigger-proximity lines make the soft-control field visible (below).
    attentionDebug = new AttentionDebugOverlay3D({ getLinks: () => attentionDebugLinks(session) });
    attentionDebug.setEnabled(pathDebugOn);
    // "SHOW AREAS" (city-founding areas): the charter tint is a TOGGLEABLE
    // map-reading overlay now — never persistent world texture. Areas
    // otherwise show only through their consequences (fields, pavement);
    // the board's "show areas" word flips the toggle.
    const zoneOverlay = new ZoneOverlay3D({
      getView: () => {
        if (!areaOverlayOn) return null;
        const t = session.town;
        if (t) {
          return {
            zones: t.deltas.zones(),
            center: t.stage.center,
            version: t.deltas.version,
            radius: t.plan.radius,
          };
        }
        const site = session.foundedSite;
        if (site) {
          return { zones: site.deltas.zones(), center: site.at, version: site.deltas.version, radius: 40 };
        }
        return null;
      },
      ...(deps.groundAt ? { groundAt: deps.groundAt } : {}),
    });
    const goalTreeOverlay = overlay;
    const overlays: SceneOverlay[] = [goalTreeOverlay, pathDebug, attentionDebug, zoneOverlay];
    const composedOverlay: SceneOverlay = {
      mount: (scene) => { for (const o of overlays) o.mount(scene); },
      update: (dt) => { for (const o of overlays) o.update(dt); },
      dispose: () => { for (const o of overlays) o.dispose(); },
    };
    // Render composed glyphs in in-world speech bubbles EXACTLY as the response
    // board renders them — same GlyphCompositor + the injected icon resolver.
    // DIRECTION COMES FROM THE GAME'S LOCALE, not `document.dir` — the quest
    // renders inside a game iframe whose document has no direction set, so the
    // default sniff composed Hebrew glyphs left-to-right while the very same
    // bubble spoke its text right-to-left.
    const glyphSource = createGlyphImageSource({
      ...(deps.resolveImage ? { resolveImage: deps.resolveImage } : {}),
      rtl: () => isRtlLocale(session.game.meta.locale),
    });
    // Compose the bubble vocabulary NOW, while the world is still settling, so a
    // bubble is never up before its icon: the fixed dwell/rest set, plus the
    // glyph every model-less object in the scene wears.
    glyphSource.prewarm(dwellBubbleGlyphs());
    glyphSource.prewarm(
      session.embedding.spec.objects.flatMap((o) => (o.glyph ? [o.glyph] : [])),
      { bare: true },
    );
    // WHAT BUILDING LOOKS LIKE (⑦): the lit ground while the build word is up,
    // and every live site's stage geometry + the glyph of what will stand
    // there. Joins the composed slot AFTER glyphSource exists — the site icons
    // come off the SAME composer the boards and bubbles use ([[icons via the
    // symbol system]]), never a bare emoji.
    const buildOverlay = new BuildOverlay3D({
      getView: () => {
        const s = sess;
        if (!s) return null;
        const spots = buildMode ? buildSpotsNow(s) : [];
        const sites = directorSites().filter((c) => (c.stage ?? 0) > 0 || c.glyph);
        // THE BUILDER'S PLAN (phase 6): every unbuilt bay and wanted piece,
        // drawn where it will stand. Always on — a site's legibility is not a
        // build-mode feature, it is what makes construction watchable.
        const ghosts = buildGhostsNow(s);
        if (!spots.length && !sites.length && !ghosts.length) return null;
        return {
          spots: spots.map((sp) => ({
            id: sp.id,
            x: sp.x, y: sp.y, w: sp.w, h: sp.h,
            focused: sp.id === buildSpotId || sp.id === hoverSpotId,
            // Ground that could TAKE a room reads differently from ground a
            // room already stands on — the player can see where they may
            // build without opening a menu to find out.
            tone: sp.kind === "lot" || sp.kind === "grow" ? ("offer" as const) : ("thing" as const),
          })),
          sites: sites.map((c) => ({
            id: c.id,
            x: c.x, y: c.y, w: c.w, h: c.h,
            stage: c.stage ?? 0,
            ...(c.glyph ? { glyph: c.glyph } : {}),
            ...(c.color ? { color: c.color } : {}),
          })),
          ghosts,
        };
      },
      glyphIconFor: glyphSource.glyphIconFor,
      ...(deps.groundAt ? { groundAt: deps.groundAt } : {}),
    });
    overlays.push(buildOverlay);
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
        modelFactory: ((base: AvatarModelFactory): AvatarModelFactory => {
          // MULTIPLAYER: a remote peer's avatar (wire id = its personId, not
          // any world-body family) is a SPARK — a small identity-tinted light
          // (remoteSparkModel; no bright moving speculars, hard rule). While
          // its claim maps it onto a body, the sim parks the light beside that
          // body (stepMultiplayerFrame); the body itself keeps its own model.
          const withPeers: AvatarModelFactory = mp
            ? (id, isLocal) =>
                !isLocal && isRemotePeerId(id) ? remoteSparkModel(id) : base(id, isLocal)
            : base;
          return spirit
            ? (id, isLocal) => (isLocal ? sparkAvatarModel() : withPeers(id, isLocal))
            : withPeers;
        })(
          session.town
            ? makeTownModelFactory(
                session.npcIcons,
                session.town.plan.species ?? "human_cute", // the town's constructing species
                familyOverrides(session),
                session.dress, // the town's culture palette
                tierOf, // Phase 3 view tier — PER BODY, read at every model build
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
      // MULTIPLAYER: the OWNER hosts (advances + streams) every creature body;
      // a FOLLOWER spawns the same deterministic cast as controller-less
      // REPLICAS the owner's avatar packets drive, and streams only its own
      // spark. Single-player is the owner of a world with no net — unchanged.
      hostNpcs: !mp || mp.role === "owner",
      ...(mpFollower() ? { replicaNpcs: true } : {}),
      ...(mpNet ? { net: mpNet } : {}),
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
      // TREES ARE NOT PART OF THIS NUMBER: rooted bodies (the wild flora
      // twins a forest stands up, the town's orchards) spend the host's
      // separate rooted ledger, which is sized for a forest because those
      // bodies never steer. Raised here because a dense stand puts ~30 oaks
      // inside the 80 m twin radius and every one of them is real.
      ...(session.town
        ? { maxNpcs: STREET_NPCS + 24, maxRootedNpcs: 160 }
        : session.wilderness
          ? { maxNpcs: 24, maxRootedNpcs: 160 }
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
        let _bm = descendNow(); // TEMP sim-block reporter
        // Host-side per-frame passthrough (HUD gaze refresh etc).
        deps.onFrame?.(dt);
        // MULTIPLAYER housekeeping (both roles): the ~5 s claim rebroadcast +
        // parking remote sparks beside the bodies they ride. Placed here so it
        // runs AFTER smoothRemoteAvatars (world-host calls it just before this
        // hook) and BEFORE the net send/render.
        stepMultiplayerFrame(state, dt);
        if (!mpFollower()) {
          // FOUNDING: clear a still-empty site once the player leaves it.
          stepFoundedSite(session);
          // BUILD ORDERS (①b): finished construction completes off the clock,
          // and the contextual buildable-structure board stays current.
          stepFoundedConstruction(session, dt);
          stepFurnitureSetup(session, dt);
          pushCivicBuildBoard(session);
        }
        simMark("s.founded", descendNow() - _bm); _bm = descendNow(); // TEMP
        // LIVING TOWN: stream the stage around the player — walls of the
        // nearby houses, residents embodying mid-errand, fresh shopping
        // trips on the street clock. The stage is cheap when nothing moves.
        if (session.town) {
          const prevDay = Math.floor(session.townClock / FOOD_DAY_SEC);
          // FOLLOWER: the town clock is world-mutating OWNER state — frozen
          // here, so the once-a-day steps below never fire (newDay===prevDay)
          // and the goods clock stops emitting fresh trips, while the stage
          // STREAMING below still runs (bodies/walls/furniture spawn around
          // this peer's own camera — the deterministic cast, as replicas).
          if (!mpFollower()) session.townClock += dt;
          const newDay = Math.floor(session.townClock / FOOD_DAY_SEC);
          // AUTOMATIC EXPANSION (construction v1): once per town day, the
          // prosperity accrual + at-most-one-annex spend. Signals are the
          // proxy trio (pantry surplus, attendance, stocked breadth) — the
          // adapter a real economy later replaces. The stage's delta
          // watcher raises any new annex (scaffold-first when watched).
          if (newDay > prevDay) {
            const t = session.town;
            // A BUILDING NEVER RISES BY ITSELF (⑥): the step DESIGNATES and
            // the host stakes it — the town's own growth waits on the same
            // hauls and the same builders a player's order does.
            for (const o of constructionStep(
              t.stage.center,
              t.plan,
              t.deltas,
              (houseIndex) => prosperitySignals(session, houseIndex),
              newDay,
              pendingGrowthRects(session),
            )) {
              const m = /^h_(\d+)$/.exec(o.buildingKey);
              if (m && o.action.kind === "annex") {
                stakeAnnex(session, Number(m[1]), o.action.cluster, o.action.candidate);
              }
            }
            // ZONE-STEERED FOUNDING (③, the ①b deferred piece): the town
            // banks its own prosperity (the mean of the same household
            // signals) and spends it FOUNDING the most-needed structure
            // inside a zone with ground for it — same FoundedBuilding path
            // as a spoken order (scaffold → completion sweep → roster),
            // spending the same yard stock. No zones ⇒ nothing changes.
            // The DAY-EDGE gates the cadence; the row stamps ride the
            // SCALE-day clock (buildDayNow), the unit every done-check reads
            // — an integer food-day here mis-stamped startedDay/laborStartDay.
            stepZonedFounding(session, buildDayNow(session));
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
            const _dpT0 = descendNow(); // TEMP descent probe
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
              // VIEW-DISTANCE LOD (Phase 2): cap the ambient crowd this frame
              // (0 at orbit) so street bodies never flood in one frame.
              crowdBudget ?? undefined,
              // THE BUSY PIN (⑥): recruited civic workers keep their bodies
              // and take no fresh trips until their work ends.
              (id) => busyCivicBodies(session).has(id),
            );
            let _sbT = descendNow(); simMark("s.frame", _sbT - _dpT0); // TEMP
            if (f.buildings) townHost.setBuildings(f.buildings);
            simMark("s.setB", descendNow() - _sbT); // TEMP — s.bCount total=Σ, max=biggest set
            if (f.buildings) simMark("s.bCount", f.buildings.length); // TEMP
            // CONSTRUCTION SITES (city-founding): marked plots, not walls —
            // painted flat by the view, reserved against drops by the engine.
            if (f.sites) {
              townHost.setReservedGround(f.sites.map(({ x, y, w, h }) => ({ x, y, w, h })));
              questView?.setSites?.(f.sites);
              setSites(f.sites); // the ⑦ overlay's stage geometry + icons (director-held)
            }
            _sbT = descendNow(); // TEMP
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
              const _added = townHost.addNpc(n);
              if (!_added) {
                // TRANSACTIONAL EMBODIMENT (view-distance-lod-tiers.md rework):
                // the model recorded this body embodied at emission; the world
                // refused. If the avatar EXISTS (duplicate — e.g. a possessed
                // body), the record is truthful — keep it. If it doesn't (cap,
                // any true failure), DROP the record so the model isn't left
                // holding a phantom it ghost-culls and re-emits forever; the
                // retry rides the model's abstract dwell, never the next frame.
                if (!townHost.state.avatars[n.id]) session.town.stage.dropResidentBody?.(n.id);
                clockErrandQueue.delete(n.id); // its walkTo must not route either way
                // TEMP ghost-spawn probe (diagnostic only — remove with probes).
                if (probesOn() && typeof console !== "undefined" && ++_ghostLogT >= 30) {
                  _ghostLogT = 0;
                  console.log(
                    `[ghost-spawn] addNpc REJECTED ${n.id} avatar=${townHost.state.avatars[n.id] ? "YES" : "no"}`,
                  );
                }
                continue;
              }
              // A fresh resident body paces only inside its house's IDLE PAD
              // (may be null this frame if the furniture stages later — the
              // next homecoming refreshes it).
              if (n.id.startsWith("resident_")) {
                townHost.setNpcWanderRect(n.id, houseIdlePad(session, townHost.state, Number(n.id.split("_")[1])));
              }
            }
            for (const id of f.remove) townHost.removeNpc(id);
            simMark("s.bodies", descendNow() - _sbT); _sbT = descendNow(); // TEMP
            // CLOCK ERRANDS ARE ROUTE-BUDGETED (view-distance-lod-tiers.md): door-
            // routing a trip is the streamer's one remaining per-item lump (~3 ms
            // × 50-90 waypoints even with the probe grid), and an approach frame
            // can emit DOZENS of trips at once (fresh bodies, cycle boundaries) —
            // routed in one frame that's a visible stutter. Emissions land in a
            // per-body queue (a newer trip for the same body replaces its queued
            // one) and at most ERRAND_ROUTE_BUDGET route per frame — a trip
            // starting a few frames late is invisible; the burst is not. The
            // ownership guards (live/party/commanded) re-check at DRAIN time —
            // ownership may have changed while queued.
            for (const e of f.errands) clockErrandQueue.set(e.npcId, e.points);
            if (clockErrandQueue.size) simMark("s.errQ", clockErrandQueue.size); // TEMP
            // TEMP: WHO keeps emitting? Trips are cycle-edge-gated (tripSent) so a
            // steady per-frame stream means some body re-emits — sample its ids.
            if (probesOn() && f.errands.length && ++_errSampleT >= 60) {
              _errSampleT = 0;
              console.log(`[errand-sample] ${f.errands.slice(0, 5).map((e) => e.npcId).join(", ")}${f.errands.length > 5 ? ` (+${f.errands.length - 5})` : ""}`);
            }
            let _routed = 0;
            const _rt0 = descendNow();
            for (const [npcId, pts] of clockErrandQueue) {
              // TIME-budgeted as well as count-budgeted: one cross-town door
              // route can cost ~20 ms alone (the readout's 14 k-probe frames),
              // so four of them in a frame is a visible hitch — stop routing
              // once this frame has spent its slice; the rest wait their turn.
              if (_routed >= ERRAND_ROUTE_BUDGET || descendNow() - _rt0 > 5) break;
              clockErrandQueue.delete(npcId);
              // A LIVE-driven body ignores the clock's feed until demote (§13 — the
              // need loop owns it; no double-drive); a RECRUITED one follows the
              // player; a COMMANDED one (queued goal errands) finishes its order.
              if (
                session.liveNeedBodies.has(npcId) ||
                session.party.has(npcId) ||
                (session.npcTasks.get(npcId)?.length ?? 0) > 0
              ) continue;
              // DOOR-ROUTE resident trips like the cast's (enqueueNpcErrand): any leg
              // that crosses a building boundary is threaded through the real doorway
              // instead of grinding on the wall beside it. Routed from the body's LIVE
              // spot (a mid-trip spawn walks the remainder). Between two open-ground
              // points routeThroughDoors is a no-op — the per-leg timeout still copes
              // with an intervening building; this only fixes the walled-room legs.
              const at = state.avatars[npcId];
              const errand: NpcErrand = at
                ? doorRouteErrand(state, { x: at.x, y: at.y }, { points: pts }, townHost.npcRadiusOf(npcId))
                : { points: pts };
              // CLOCK-DRIVEN (clock-path-dodging.md): the body rides an anchor
              // pacing the schedule; dodges locally, is never shoved, and only
              // a real disruption (forced out of its bubble) demotes it.
              errand.clocked = true;
              errand.onClockLost = () => session.lastDrive.set(npcId, "clock-lost");
              session.lastDrive.set(npcId, "clock");
              townHost.setNpcErrand(npcId, errand);
              _routed++;
            }
            descendProbeFrame(f, revealed.size, spiritNow(), descendNow() - _dpT0); // TEMP descent probe
            simMark("s.errands", descendNow() - _sbT); // TEMP
            if (f.errands.length) simMark("s.errCount", f.errands.length); // TEMP — emissions/frame
          }
        }
        simMark("stream", descendNow() - _bm); _bm = descendNow(); // TEMP
        // ── FOLLOWER FREEZE ─────────────────────────────────────────────────
        // Everything from here to the convo mark is WORLD-MUTATING sim (puzzle
        // watchers, creature goals, needs/rituals/pursuits, chatter, the task
        // pool) or the dwell-ACT surface (open/talk/direct/place — every act
        // mutates creatures or session state) — the OWNER's alone. A follower
        // relays its intents instead (applyRemoteCommand on the owner) and
        // keeps only its local camera/gaze/board/render. stepSparkAttention is
        // deliberately inside the freeze: it writes engagement/draw onto
        // creatures, which is a mutation.
        if (!mpFollower()) {
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
                if (i === 0 && !npcCarrying(npcId)) {
                  takeIntoHands(session, npcId, { kind: "object", objId: objectId });
                }
                if (i === 1 && world.state.objects[objectId]?.carriedBy === npcId) {
                  const o = world.state.objects[objectId]!;
                  setDownFromHands(session, npcId, { kind: "ground", x: o.x, y: o.y }, { objId: objectId });
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
        simMark("puzzles", descendNow() - _bm); _bm = descendNow(); // TEMP
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
        simMark("goals", descendNow() - _bm); _bm = descendNow(); // TEMP
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
          // TEMP sim-phase probe (view-distance-lod-tiers.md): time each sub-step
          // group so a slow quest-sim frame names its culprit. Logged over 120ms;
          // `__simPhase` in the console. Remove with the other probes.
          const _sp: Record<string, number> = {};
          let _sm = descendNow();
          stepResidentEconomyNeeds(session, shownE);
          stepHouseholdEdges(session, shownE);
          stepConstructionHousekeeping(session, shownE); // craft / auto-place / clutter (construction v1)
          _sp.economy = descendNow() - _sm; _sm = descendNow();
          // SOFT CONTROL (attention-spark.md): refresh the spark's attention
          // field (engagement + object draw) from the gaze BEFORE needs decide,
          // so an engaged creature's draw bonus is live this tick. Fades while a
          // conversation / container / menu is open. Then, when not blocked, run
          // the directed gestures: the engaged creature does a hovered chore; the
          // oscillation gesture sends it to use/go; a gap between two people chats.
          {
            // Conversing with a creature ENGAGES it strongly — held ~8s past the
            // conversation, so "leave the chat, then select an object" still lands.
            // It also becomes the STANDING ADDRESSEE (lastConvoCid): a later
            // board selection is a command to this creature while it's on screen.
            if (convo) {
              engageCreature(session, convo.nodeId, ENGAGE_CONVO_HOLD_S);
              session.lastConvoCid = convo.nodeId;
            }
            const sparkBlocked = !!convo || stockedBoard() || !!choice || !!session.selectedPocketGlyph;
            stepSparkAttention(session, world, dt, sparkBlocked);
            if (!sparkBlocked) {
              stepSparkDirect(session, state);
              stepSparkOsc(session, world, dt);
            }
          }
          _sp.spark = descendNow() - _sm; _sm = descendNow();
          stepActionHolds(session, dt); // advance discrete-action crouches; land effects at mid-beat
          stepPursuit(session, state, dt); // per-tick goal pursuits (owns its bodies before needs sweep)
          stepContainerLids(session, state); // auto-close access-opened lids once the taker has left
          _sp.pursuit = descendNow() - _sm; _sm = descendNow();
          // RITUALS FIRST — the roster, bill and phase this frame's need
          // decides are made against (it shapes the context; it drives nobody).
          stepRituals(session, state, dt);
          stepNeeds(session, state, dt, shownE);
          _sp.needs = descendNow() - _sm; _sm = descendNow();
          syncNeedActivities(session, state, dt); // body-activity visuals track the steps
          stepIndoorEgress(session, state, dt); // strays walked out of buildings they're stuck in
          syncNeedCarryProps(session, state); // carried stacks show as held props + reach rigs
          _sp.sync = descendNow() - _sm; _sm = descendNow();
          stepWorkAttendance(session, dt); // jobs→economy: absence during shifts
          pushFamilyHud(session); // dollhouse chips track the states just stepped
          _sp.work = descendNow() - _sm; _sm = descendNow();
          stepCohortTier(session, dt, shownE); // ④ tracked↔cohort turnover + city chips (hysteretic sweep)
          stepCohortWalkers(session); // ④ sampled district street life (cosmetic-only)
          _sp.cohort = descendNow() - _sm;
          pushKnownNouns(session); // the Speak menu tracks the house (diff-gated)
          for (const [k, v] of Object.entries(_sp)) simMark(`n.${k}`, v); // TEMP → sim-blocks
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
        simMark("needsBlock", descendNow() - _bm); _bm = descendNow(); // TEMP (n.* are its sub-steps)
        // Idle townsfolk chat among themselves (ambient, personality-driven). Runs
        // unconditionally — it registers nearby residents into the dialogue world.
        stepNpcChatter(session, state, dt);
        // …and tell the camera who is talking (dollhouse conversation dolly).
        // Immediately after the chatter step so a pair latched THIS frame is
        // published the same frame it starts speaking.
        publishConversationPair(dt);
        // UNTARGETED-ORDER TASK POOL (phase ①a §2): expiry, claims, completion.
        stepTaskPool(session, dt);
        simMark("chatter", descendNow() - _bm); _bm = descendNow(); // TEMP
        // ── THE ONE HOVER READ → THE ONE TABLE (dwell-interaction.ts) ─────────
        // The spark rests on exactly one thing; `hoverTargetOf` says what, and
        // `dwellInteraction` says what resting there MEANS given how long it has
        // rested and whether a conversation is running. Nothing else reads the
        // gaze to decide an interaction, and the SAME target feeds the spark's
        // own highlight, so what is lit is always what will fire.
        const meAv = state.avatars[PLAYER_ID];
        let progress = 0;
        if (world && meAv) {
          const gz = world.getGaze();
          const active = choice;
          const partnerCid = active ? active.nodeId : null;
          const target = hoverTargetOf(session, state, gz, meAv);
          // BUILD MODE (⑦): which lit spot the hover is over. Resolved from
          // the SAME point the hover reports — and only on GROUND, because
          // that is the only hover the table reads a spot on (a thing means
          // that thing). So the wash that brightens is always exactly the one
          // a dwell would open, and a hover over a chest lights nothing it
          // would not act on.
          hoverSpotId =
            buildMode && target?.kind === "ground"
              ? (spotAt(buildSpotsNow(session), target.x, target.y)?.id ?? null)
              : null;

          // Re-anchor both timers when the hover moves to a DIFFERENT thing, so
          // no fill is ever inherited across targets. In build mode the SPOT is
          // part of that identity — sweeping from one plot to the next must not
          // hand the second one the first one's fill.
          const key = hoverSpotId
            ? `${hoverKeyOf(target) ?? ""}|${hoverSpotId}`
            : hoverKeyOf(target);
          if (key !== dwellKey) {
            dwellKey = key;
            shortDwell.reset();
            longDwell.reset();
            firedPhases.clear();
          }

          // Hold the camera on whatever the player is engaged WITH.
          const partnerPos = partnerCid ? poserPos(session, partnerCid) : null;
          if (partnerPos) {
            world.setConversation({ x: partnerPos.x, y: partnerPos.y });
          } else if (container) {
            const cObj = containerStandpoint(state, container.objId);
            if (!cObj) closeContainer(); // it streamed away mid-board
            else world.setConversation(stockedBoard() ? { x: cObj.x, y: cObj.y } : null);
          }

          // A SELECTED stack is placed rather than interacted with: the gaze puts
          // it in the container it rests on, or drops it on ground within reach.
          // (Selecting a stack WHILE in conversation presents it instead.)
          if (session.selectedPocketGlyph && !active && !container) {
            const box = target?.kind === "object" && session.containers.has(target.id!) ? target : null;
            const spot = target?.kind === "ground" ? target : null;
            const canDrop = !!spot && Math.hypot(meAv.x - spot.x, meAv.y - spot.y) <= CONVO_RADIUS;
            const at = box ?? (canDrop ? spot : null);
            const res = shortDwell.step(at ? { x: at.x, y: at.y } : null, dt * 1000);
            progress = res.progress;
            if (res.fired && !firedPhases.has("short")) {
              firedPhases.add("short");
              if (box) putSelectedIn(session, box.id!);
              else if (spot) dropSelected(session, spot.x, spot.y);
            }
          } else {
            // Preview who a conversation would open with, before it opens.
            if (!active && target?.kind === "creature") {
              const greet = talkTargetOf(session, state, meAv);
              if (greet && greet.nodeId === target.id) previewGreet(session, greet);
            }
            const at = target ? { x: target.x, y: target.y } : null;
            const shortRes = shortDwell.step(at, dt * 1000);
            const longRes = longDwell.step(at, dt * 1000);
            // Report the phase still reaching for something, so the spark's
            // bloom tracks the gesture the player is actually performing.
            const pending: DwellPhase | null = !firedPhases.has("short")
              ? "short"
              : !firedPhases.has("long")
                ? "long"
                : null;
            progress = pending === "long" ? longRes.progress : shortRes.progress;

            for (const phase of ["short", "long"] as const) {
              const fired = phase === "short" ? shortRes.fired : longRes.fired;
              if (!fired || firedPhases.has(phase)) continue;
              const acts = dwellInteraction(target, phase, {
                conversingWith: partnerCid,
                building: buildMode,
                buildSpot: hoverSpotId,
              });
              if (!acts.length) continue;
              firedPhases.add(phase);
              convoIdleS = 0; // any deliberate act keeps the conversation alive
              for (const act of acts) switch (act.act) {
                case "menu":
                  // Reach VETOES acting (an embodied player walks over); it never
                  // decided the target.
                  if (spiritNow() || Math.hypot(meAv.x - target!.x, meAv.y - target!.y) <= CONVO_RADIUS) {
                    if (act.id !== container?.objId) openContainer(session, act.id);
                  }
                  break;
                case "talk": {
                  const t = talkTargetOf(session, state, meAv);
                  if (t && t.nodeId === act.id) openTalk(session, t);
                  break;
                }
                case "switch": {
                  const t = talkTargetOf(session, state, meAv);
                  if (t && t.nodeId === act.id && partnerCid) {
                    leaveActiveConvo(partnerCid);
                    openTalk(session, t);
                  }
                  break;
                }
                case "sendTo":
                  directCreatureTo(session, act.cid, { x: act.x, y: act.y }, null);
                  break;
                case "attendObject":
                  directCreatureTo(session, act.cid, { x: target!.x, y: target!.y }, act.id);
                  break;
                case "attendCreature":
                  performAttentionInteract(session, act.cid, act.id);
                  break;
                case "buildSpot":
                  // ⑦ — the spot the player settled on OWNS the board now:
                  // its own build/break menu, nothing else on it. A settle
                  // off every spot RELEASES the last one (back to the
                  // structure list), the same one-at-a-time rule a chest
                  // obeys.
                  selectBuildSpot(session, act.id);
                  break;
                case "room":
                  // NOT IMPLEMENTED — the only cell of the table with nowhere to
                  // go yet. "Select the room under the point" needs a room
                  // SURFACE (a board naming the room and what it holds, the way
                  // `openContainer` does for a fixture), and no such surface
                  // exists: `roomAt` can name the room from the kernel, but
                  // nothing presents one. Deliberately inert rather than guessing
                  // at a presentation — the table already routes here, so wiring
                  // it up is the only work left.
                  break;
              }
            }
          }

          // A CONVERSATION ENDS ON ITS OWN. Looking away is an instruction now,
          // not a leave, so idleness is what closes it — reset by any deliberate
          // act above.
          if (partnerCid) {
            convoIdleS += dt;
            if (convoIdleS > CONVO_IDLE_END_S) leaveActiveConvo(partnerCid);
          } else {
            convoIdleS = 0;
          }
        }
        // The dwell-to-select indicator is the gaze SPARK's bloom now (render3d) —
        // it hovers over the very item being chosen. `progress` reaches the
        // spark via the host's `cursorProgress` dep. (Old 2D dwell ring removed.)
        convoProgress = progress;
        simMark("convo", descendNow() - _bm); // TEMP
        } else {
          convoProgress = 0; // no dwell-acts on a follower — nothing fills
        } // ── end FOLLOWER FREEZE ──
        // CREATURE LOD (Phase 3, per-body since the dollhouse fix): re-band
        // every town body by its OWN distance from the local camera focus —
        // hysteretic, so a pacing body on a band edge never flaps — and queue
        // crossings for the staggered rebuild below. Entries for despawned
        // bodies are pruned so a later respawn re-seeds from live distance.
        {
          const focus = cameraFocus(); // the LOCAL camera, never PLAYER_ID ([LOD per-camera])
          if (focus) {
            for (const id in state.avatars) {
              if (!id.startsWith("resident_") && !id.startsWith("fauna:") && !id.startsWith("pet_")) continue;
              const bd = state.avatars[id];
              const prev = bodyTiers.get(id);
              const d = Math.hypot(bd.x - focus.x, bd.y - focus.y);
              if (prev === undefined) {
                bodyTiers.set(id, seedBodyTier(d)); // first sight — builds right, no rebuild
                continue;
              }
              const t = bandedBodyTier(prev, d);
              if (t !== prev) {
                bodyTiers.set(id, t);
                if (!retierQueue.includes(id)) {
                  retierQueue.push(id);
                  _retierCross++;
                }
              }
            }
            for (const id of bodyTiers.keys()) {
              if (!state.avatars[id]) bodyTiers.delete(id);
            }
          }
          // TEMP retier probe: ≤1 line/2s, only when bodies crossed bands —
          // a steady high count means the camera focus (the walker) is
          // sweeping band edges and rebuild pressure is per-body, not the
          // town flood the [retier] line above reports.
          _retierLogT += dt;
          if (probesOn() && _retierLogT >= 2) {
            if (_retierCross > 0) console.log(`[retier] body crossings=${_retierCross}/2s queue=${retierQueue.length}`);
            _retierCross = 0;
            _retierLogT = 0;
          }
        }
        // Drain the re-tier queue a few bodies per frame — a tier cross (even
        // a hysteretic one) must never rebuild the whole crowd, plus any
        // first-use simple bakes, in a single frame.
        if (retierQueue.length && questView) {
          for (const id of retierQueue.splice(0, RETIER_STREAM)) questView.resetAvatarModel?.(id);
        }
        simFlush(); // TEMP (space3d tail below is unmeasured — figure-count scale, cheap)

        // FOLLOWER: quest inputs (zone entry, figure touches) mutate the
        // goal-tree runtime — owner-only, like everything else above.
        if (mpFollower()) return;
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
    setWorld(host); // the director keeps its own binding (phase 1a)
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
    // BUILD MODE (⑦) is per-session view state — a replay starts with the
    // lights out and nothing lit from the town that just ended.
    buildMode = false;
    buildSpotId = null;
    hoverSpotId = null;
    clearSpotCache();
    setSites([]);
    sess = makeQuestSession(game, town);
    if (opts.scale) sess.scale = opts.scale;
    // The world's universal absolute ring (game.culture) founds the law
    // book — issuer "world", unrepealable, everywhere.
    if (opts.culture) {
      const culture = resolveWorldCulture(opts.culture);
      sess.laws.push(...absoluteLaws(culture.absolutes));
      // How this culture GATHERS (game.culture.rituals) — its meals, its play.
      // Always populated (kernel defaults ⊕ authored), so nothing downstream
      // has to know whether the world declared any.
      sess.ritualTemplates = culture.rituals;
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
    clockErrandQueue.clear(); // queued trips belong to the previous session's town
    presenter.sessionStarted(sess);
    const _dp = descendProbeArm(sess.town ? (sess.town.plan.key ?? "town") : null); // TEMP descent probe
    buildHost(sess);                       _dp?.mark("buildHost");
    seedSmallItems(sess); // grabbable resource props (world ready after buildHost)
    _dp?.mark("seedSmallItems");
    stockContainers(sess); // stores: openable good boxes holding grabbable goods (bug #5)
    _dp?.mark("stockContainers");
    seedTownFauna(sess); // each good's harvested sources at its producers (chain scenery)
    _dp?.mark("seedTownFauna");
    seedWilderness(sess); // trees/rocks (material containers) + possessable locals
    _dp?.mark("seedWilderness");
    seedSettlers(sess); // the founding group camped at an age-0 town (city-founding ②)
    _dp?.mark("seedSettlers");
    if (opts.dollhouse !== undefined) enterDollhouse(sess, opts.dollhouse);
    if (_dp && typeof console !== "undefined") // TEMP descent probe
      console.log(`[descent-probe] armed ${descendProbe?.key} — start ${descendProbe?.totalStartMs}ms`, descendProbe?.phases);
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
   *  a real mind. The feature's face and girth come from its natural source
   *  (products.ts), never a kind switch. The player walker starts at the
   *  centre clearing. */
  /** Stand ONE wilderness feature in the live world (the per-feature body of
   *  the seeding loop, extracted so flora twins can materialize live). A
   *  GROWN BODY where the registry declares one (step ④: bodyHeightM on a
   *  plant — the orchard blueprints carry their fruit visibly): a rooted
   *  flora body, exactly the town-orchard convention; the container rides
   *  the body (containerStandpoint). Everything else keeps the placeholder
   *  box. */
  function spawnWildFeature(session: QuestSession, f: WildernessFeature): boolean {
    if (!world) return false;
    const src = naturalSourceOf(f.species);
    const key = wildFeatureContainerId(f);
    let stood: boolean;
    if (wildFeatureEmbodied(f)) {
      // A refused addNpc (body budget) means NOTHING stands here — report it,
      // so a flora-twin caller keeps its scenery instance visible instead of
      // hiding a tree that has no body anywhere.
      stood = world.addNpc({
        id: key,
        x: f.x,
        y: f.y,
        species: f.species,
        behavior: { movement: "wander", wanderRadius: 0, home: { x: f.x, y: f.y }, speed: 0, conversationRadius: 3 },
      });
    } else {
      // THE MODEL COMES FROM THE SOURCE, NOT FROM THE SPAWNER (phase 5 step ④).
      // This branch used to force `fixture: "chest"` on every non-embodied
      // feature, and a fixture short-circuits identity resolution in
      // object-models — so a wild rock, icon and all, rendered as a wooden
      // treasure chest. The order now is: the source's DECLARED archetype
      // wins if it has one; otherwise the icon/glyph gets to name its own
      // model; and the chest survives only as the last-resort body for an
      // identity nothing can draw (a plant with no grown body and no recipe
      // — a box on the ground still reads as "something openable stands
      // here", which a bare floating emoji does not). The exact pair passed
      // to hasObjectModel is the pair render3d passes to buildObjectModel,
      // so the two can never disagree about whether a model exists.
      const icon = src?.feature?.icon ?? "🌳";
      const glyph = Object.keys(f.stock)[0];
      const declared = src?.feature?.fixture as FixtureKind | undefined;
      const fixture = declared ?? (hasObjectModel(icon, glyph) ? undefined : "chest");
      stood = world.addObject({
        id: f.id,
        x: f.x,
        y: f.y,
        // A modeled outcrop is ROUND on the ground — its footprint is the
        // disc the boulder actually occupies, so putting something down
        // "in" it stops answering out at the square's empty corners
        // (containerAt is the only reader of `shape`). A chest stays a box.
        shape: fixture ? "box" : "sphere",
        // Size is the source's declared radius scaled by what is LEFT in it
        // — a feature that rolled a single stone stands as a pebble from the
        // moment it is laid down, exactly as one quarried down to its last
        // stone does (wildFeatureRadius).
        radius: wildFeatureRadius(f.species, f.stock),
        ...(fixture ? { fixture } : {}),
        // SOLID regardless of which model won. Collision used to be a silent
        // side effect of the forced chest — drop the chest and bodies walk
        // straight through the boulder, which is a worse lie than the chest
        // was. Said outright now (ObjectSpec.solid), so how a feature LOOKS
        // and whether you can walk into it stop being the same fact.
        solid: true,
        openable: true,
        facing: 0,
        interactions: [],
        contains: [{ relation: "in", capacity: 12 }],
        iconRef: icon,
        glyph,
      });
    }
    if (!stood) return false;
    session.containers.set(key, "in");
    session.containerStock.set(key, { ...f.stock });
    session.containerOwner.set(key, null); // nature is nobody's
    return true;
  }

  function seedWilderness(session: QuestSession) {
    const w = session.wilderness;
    if (!w || !world) return;
    for (const f of w.features) spawnWildFeature(session, f);
    for (const c of w.creatures) {
      // PRODUCT ANIMAL (step ④ hunting/husbandry): a walking natural source.
      // Its yield rides the ONE container path — the body id keys the stock
      // maps, and containerAnchor resolves it to the live avatar, so takes,
      // regrowth and the felling rule (here: the kill) all work unchanged.
      // No mind: livestock is takeable, not talkable (dialogue would race
      // the container board on the same dwell).
      if (c.species) {
        const body = wildAnimalBodyId(c);
        session.containers.set(body, "in");
        session.containerStock.set(body, { ...(c.stock ?? {}) });
        session.containerOwner.set(body, null); // wild — nobody's, until tamed
        world.addNpc({
          id: body,
          x: c.x,
          y: c.y,
          species: c.species, // species-sized collision/planning radius
          behavior: {
            movement: "wander",
            wanderRadius: 12,
            home: { x: c.x, y: c.y },
            speed: 0.8,
            conversationRadius: 3,
          },
        });
        continue;
      }
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
      // ALWAYS a real species (a creature without one must not exist): the
      // authored member, else the town's constructing species, else the
      // people default the model factory uses (quest view wiring).
      const species =
        member?.species ?? town.config.species ?? town.plan.species ?? "human_cute";
      // The camp ring: around the supply crate at the site centre.
      const ang = (i / ids.length) * Math.PI * 2 + 0.7;
      const r = 5 + (i % 3) * 1.7;
      world!.addNpc(girthSafeSpawn(world!, {
        id: body,
        x: c.x + Math.cos(ang) * r,
        y: c.y + Math.sin(ang) * r,
        species,
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

  /** The world's symbol resolvers for the intent-announcement line. `deixis`
   *  marks EXACT-instance item refs with `.this` ("I will eat this apple") —
   *  the reserved way of naming a particular target. */
  /** A creature's registered SPECIES id (creatures/species.ts). Best-effort
   *  across every body convention: the player is a spark, authored family
   *  members + pets carry their override, settlers their member row, herds
   *  encode it in the id; everything else defaults to the town's constructing
   *  species. Never throws — a reference must resolve for any creature. */
  function speciesOf(session: QuestSession, cid: string): string {
    if (cid === PLAYER_CREATURE_ID || cid === PLAYER_ID) return SPARK_SPECIES_ID;
    const ov = familyOverrides(session)?.get(cid)?.species;
    if (ov) return ov;
    const settler = settlerMemberOf(session, cid)?.species;
    if (settler) return settler;
    const fauna = /^fauna:([^:]+):/.exec(cid);
    if (fauna) return fauna[1]!;
    if (isPetCid(cid)) return "quadruped";
    return session.town?.config.species ?? session.town?.plan.species ?? "human_cute";
  }

  /** Species id → the glyph WORD it renders as ("bear_person" → "bear",
   *  "human_cute" → "person", "ungulate" → "animal"). The lang lexicons carry
   *  these words, so a species is always speakable, never a bare id. */
  const SPECIES_WORD: Record<string, string> = { human: "person", quadruped: "animal", ungulate: "animal" };
  function speciesWordOf(speciesId: string | undefined): string {
    if (!speciesId) return "creature";
    const base = speciesId.replace(/_(person|cute)$/, "");
    return SPECIES_WORD[speciesId] ?? SPECIES_WORD[base] ?? base;
  }

  /** Do speaker + target share a GROUP (the reference's case-1 gate)? The
   *  player guides the observed family, so any named member it can name is its
   *  own group; two creatures share a group when they live in the same house. */
  function inSameGroup(session: QuestSession, speaker: string, target: string): boolean {
    if (speaker === target) return true;
    if (speaker === PLAYER_CREATURE_ID || speaker === PLAYER_ID) {
      // A named member the host can name belongs to the observed family — the
      // player's own group (inPlayerGroup also admits an explicit party).
      return inPlayerGroup(session, target) || nameOfCid(session, target) !== undefined;
    }
    const hs = houseIndexOfCid(speaker);
    const ht = houseIndexOfCid(target);
    return Number.isFinite(hs) && hs === ht;
  }

  /** THE creature reference for a spoken line (name / pronoun / species) — the
   *  ONE resolver every verb goes through (intent-lines.ts creatureReferenceGlyph),
   *  so no creature is ever voiced as "the there". The LISTENER (player) maps to
   *  the "you" deixis before the rule runs. */
  function creatureReference(session: QuestSession, speakerCid: string | undefined, targetCid: string): string {
    if (targetCid === PLAYER_CREATURE_ID || targetCid === PLAYER_ID) return "you";
    const speaker = speakerCid ?? PLAYER_CREATURE_ID;
    const targetSpecies = speciesOf(session, targetCid);
    return creatureReferenceGlyph(
      { species: speciesOf(session, speaker), gender: genderFor(speaker), speciesWord: "" },
      {
        species: targetSpecies,
        ...(nameOfCid(session, targetCid) ? { name: nameOfCid(session, targetCid)! } : {}),
        gender: genderFor(targetCid),
        speciesWord: creatureGlyph(session, targetCid) ?? speciesWordOf(targetSpecies),
        inGroup: inSameGroup(session, speaker, targetCid),
      },
    );
  }

  /** How close a fixture must stand to a point to BE that point, in metres. A
   *  directed spot is the stand spot beside the thing, not the thing's own
   *  centre, so this has to reach across that gap without swallowing the
   *  neighbouring piece. */
  const POINT_NAME_REACH_M = 2.0;

  /**
   * THE WORD FOR A BARE POINT: what a creature sent to a spot should call it.
   *
   * The fixture standing there wins ("I will go to the bed") — it is the most
   * specific true thing, and it is almost always why the point was chosen. Else
   * the ROOM containing it ("I will go to the bedroom"), read off the speaker's
   * own house plan. Undefined when neither applies, leaving the caller its
   * deictic fallback — honest for open ground, which really has no name.
   */
  function pointWord(
    session: QuestSession,
    speaker: string | undefined,
    p: { x: number; y: number },
  ): string | undefined {
    const state = world?.state;
    if (!state) return undefined;
    // The nearest NAMEABLE thing at the point: a placed fixture or a loose prop.
    let bestId: string | undefined;
    let bestD = POINT_NAME_REACH_M;
    for (const o of Object.values(state.objects)) {
      if (o.carriedBy) continue;
      const nameable =
        session.smallProps.has(o.id) || /^furn_\d+_/.test(o.id) || isWellId(o.id);
      if (!nameable) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d <= bestD) {
        bestD = d;
        bestId = o.id;
      }
    }
    if (bestId) {
      const word = objectWord(session, bestId);
      if (word && word !== "thing") return word;
    }
    // No thing there — name the room, from the SPEAKER's own house (rooms are
    // only nameable relative to whose home they are).
    // `houseIndexOfCid` reads the `_<house>_<n>` shape and yields NaN for anyone
    // who has no household (a wilderness local, the player) — no rooms to name.
    const houseIndex = speaker ? houseIndexOfCid(speaker) : NaN;
    if (!Number.isFinite(houseIndex)) return undefined;
    return roomAt(houseRoomDestsOf(session, houseIndex), p)?.word;
  }

  function intentLineSyms(
    session: QuestSession,
    opts: { deixis?: boolean; speaker?: string } = {},
  ): IntentLineSyms {
    return {
      item: (ref) =>
        "id" in ref
          ? `${liveItemGlyph(session, ref.id)}${opts.deixis ? ".this" : ""}`
          : [ref.match.kind ?? ref.match.category ?? "thing", ...(ref.match.descriptors ?? [])].join("."),
      place: (p) => {
        if (p.kind === "named") {
          // A world-object id speaks its WORD ("furn_3_bed_0" → "bed", a prop
          // its glyph) — never the raw id.
          if (session.smallProps.has(p.id) || /^furn_\d+_/.test(p.id) || isWellId(p.id)) {
            return objectWord(session, p.id);
          }
          return p.id;
        }
        if (p.kind === "home") return "home";
        if (p.kind === "creature") return creatureReference(session, opts.speaker, p.id);
        // A BARE POINT STILL HAS A NAME. "I will go there" is what the deictic
        // fallback says, and inside a house it says nothing at all — every room
        // is "there". Name what is actually AT the point: the fixture standing
        // on it, else the room containing it. "There" is the last resort, for
        // open ground with nothing to call it.
        return pointWord(session, opts.speaker, p) ?? "there";
      },
      creature: (cid) => creatureReference(session, opts.speaker, cid),
    };
  }

  /** THE COMMAND ECHO (semantic-gaps.md §Commands): the accepted order spoken
   *  back as the creature understood it — full grammar via commandEcho /
   *  goalIntentLine ("I will wash the clothes"). The reserved bare "ok" is
   *  EARNED: only when the child's own glyphs already matched the canonical
   *  form. Teaching and debugging in one line — a wrong echo is a parser bug;
   *  a right echo not acted on is an action bug. */
  function commandEchoLine(session: QuestSession, frame: IntentFrame, goal: GoalSpec, speaker?: string): string {
    const { line, perfect } = commandEcho(frame, goal, intentLineSyms(session, { deixis: true, speaker }));
    if (!line || perfect) return "ok";
    // The echo is a STATEMENT OF INTENT — the will-marked syntax ("I will
    // wash the clothes"), never the order's own imperative shape.
    return asIntent(line)[session.game.meta.syntax ?? "b"];
  }

  /** INTENT ANNOUNCEMENT (phase ①a §3): speak what the creature is ABOUT to do
   *  before it does it — gated by the ONE criteria hook (default: announce on
   *  a pooled-task claim; routine self-directed behavior stays quiet). Spoken
   *  in the intent syntax ("I will get the wood"). */
  function announceIntent(session: QuestSession, ctx: AnnounceContext) {
    if (!announceCriteria(ctx)) return;
    const line = goalIntentLine(ctx.goal, intentLineSyms(session, { deixis: true, speaker: ctx.creatureId }));
    if (!line) return;
    npcChatBubble(session, ctx.creatureId, asIntent(line)[session.game.meta.syntax ?? "b"]);
  }

  /** SOFT CONTROL — a spark-directed act ALWAYS announces before acting
   *  (attention-spark.md): the player drew the creature's attention to a thing,
   *  so it states its intent even though routine self-directed behavior stays
   *  quiet. Intent syntax + deixis: "I will eat this apple." Ungated, unlike
   *  announceIntent's task-claim criteria. */
  function announceSparkIntent(session: QuestSession, cid: string, goal: GoalSpec) {
    const line = goalIntentLine(goal, intentLineSyms(session, { deixis: true, speaker: cid }));
    if (!line) return;
    if (isPetCid(cid)) ensurePetCreature(session, cid);
    else ensureResidentCreature(session, cid);
    npcChatBubble(session, cid, asIntent(line)[session.game.meta.syntax ?? "b"]);
  }

  /** Per-sweep task lifecycle: expire stale OPEN tasks back to the player,
   *  retire CLAIMED tasks whose claimant's errand ran out, then let willing +
   *  capable creatures inside each open task's focus area CLAIM it — exactly
   *  one per task (chooseClaimant is pure + deterministic: nearest, ties by
   *  id, no RNG — the seed+clock+mutations law holds). */
  let taskSweepT = 0;
  /** Bodies the host OWNS for civic work right now (⑥ — the busy pin):
   *  pooled-task claimants and moving haul executors. The resident streamer
   *  reads this to keep them embodied and trip-free; memoized per taskClock
   *  tick (the model probes once per body per frame). */
  let busyBodiesMemo: { at: number; set: Set<string> } | null = null;
  function busyCivicBodies(session: QuestSession): Set<string> {
    if (busyBodiesMemo && busyBodiesMemo.at === session.taskClock) return busyBodiesMemo.set;
    const set = new Set<string>();
    for (const t of session.taskPool.claimed()) {
      if (t.claimedBy) set.add(avatarIdOf(t.claimedBy));
    }
    for (const a of session.transfers.active()) {
      if (a.status === "moving" && a.executor) set.add(avatarIdOf(a.executor));
    }
    busyBodiesMemo = { at: session.taskClock, set };
    return set;
  }

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
      if (t.goal.kind === "build" || t.goal.kind === "buildwork") continue; // the sweep retires these off REAL construction state
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
          if (spec) {
            // POINT-STEERED: the lot ranks by the task's RECORDED focus —
            // the claimant builds where the order was aimed, not merely
            // center-out (deterministic: the focus is part of the task).
            const near = steeringNear(bctx, task.focus);
            const cands = buildCandidates(bctx, spec, near ? { near } : undefined);
            // Capability = ground exists (⑥ — materials never gate a
            // DESIGNATION: the staked plot waits honestly and the staging
            // re-resolve unsticks it when stock appears).
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
      // CIVIC work — a town resident volunteers for its town's construction
      // (and for the hauls that stage it — pipeline ②'s communal law), a
      // bonded creature for its family; personal compliance covers the rest.
      // A BUILD-WORK site's live anchor (⑥) — null once the site is gone,
      // staged off, or already worked through.
      let buildworkPrepMemo: { x: number; y: number } | null | undefined;
      const buildworkPrep = (): { x: number; y: number } | null => {
        if (buildworkPrepMemo !== undefined) return buildworkPrepMemo;
        buildworkPrepMemo = null;
        if (task.goal.kind === "buildwork") {
          buildworkPrepMemo = buildworkSiteAt(session, task.goal.site);
        }
        return buildworkPrepMemo;
      };
      const civicTask =
        task.goal.kind === "build" ||
        task.goal.kind === "buildwork" ||
        (task.goal.kind === "transfer" &&
          (() => {
            const to = session.transfers.get(task.goal.agreementId)?.to;
            return (
              !!to &&
              (to.startsWith(ORDER_PILE_EP) ||
                to.startsWith(SITE_PILE_EP) ||
                to.startsWith(ANNEX_PILE_EP) ||
                to.startsWith(BFURN_EP) ||
                // Phase 3: par-stock logging to the yard / storehouse is
                // the town's business exactly like staging a site.
                isCivicStockDest(session, to))
            );
          })());
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
              : task.goal.kind === "buildwork"
                ? buildworkPrep() !== null
                : task.goal.kind === "transfer"
                  ? transferPrep() && canGrasp(mind)
                  : compileGoal(task.goal, cid, resolver) !== null,
          willing: civicTask
            ? cid.startsWith("resident_") || session.bondedCreatures.has(cid) || compliant
            : compliant,
        });
      }
      // ⑥ AMBIENT RECRUITMENT: civic work recruits BEYOND the registered
      // cast — any EMBODIED street resident may volunteer ("everyone works
      // together"). They register lazily at claim time (the conversation
      // path's ensureResidentCreature), so the far side of town is workforce
      // too, not scenery. Build/transfer/build-work goals never compile
      // per-body, so capability needs no mind; other kinds stay registered-only.
      if (
        civicTask &&
        (task.goal.kind === "build" || task.goal.kind === "transfer" || task.goal.kind === "buildwork")
      ) {
        const seen = new Set(candidates.map((c) => c.id));
        for (const [bodyId, body] of Object.entries(world.state.avatars)) {
          if (!bodyId.startsWith("resident_")) continue; // never stage haulers/pets/cast
          if (seen.has(bodyId) || session.creatures.nodeByCreature.has(bodyId)) continue;
          if (bodyId === possession.creatureId) continue;
          if (session.party.has(bodyId) || session.escorting.has(bodyId)) continue;
          if (session.liveNeedBodies.has(bodyId)) continue; // the need loop owns it
          if (pool.claimedBy(bodyId)) continue;
          candidates.push({
            id: bodyId,
            pos: { x: body.x, y: body.y },
            capable:
              task.goal.kind === "build"
                ? buildPrep() !== null
                : task.goal.kind === "buildwork"
                  ? buildworkPrep() !== null
                  : transferPrep(),
            willing: true, // a street resident treats civic work as its town's business
          });
        }
      }
      const winner = chooseClaimant(task, candidates);
      if (!winner) continue; // stays open — someone may wander into focus before expiry
      // A recruited ambient volunteer becomes a REAL creature the moment it
      // steps up (mind + node — the same registration a conversation does).
      if (winner.startsWith("resident_") && !session.creatures.nodeByCreature.has(winner)) {
        ensureResidentCreature(session, winner);
      }
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
      if (task.goal.kind === "buildwork") {
        // ⑥ BUILD WORK: walk to the staged site and STAND AT THE WORK —
        // the construction sweep banks labor only while builders are
        // present (and keeps re-issuing the standing dwell).
        const at = buildworkPrep();
        if (!at) continue;
        if (!pool.claim(task.id, winner)) continue; // already FILLED — skip
        announceIntent(session, {
          creatureId: winner,
          goal: task.goal,
          source: "task-claim",
          taskId: task.id,
          issuer: task.issuer,
        });
        const npcId = avatarIdOf(winner);
        session.needStep.delete(winner);
        session.npcTasks.delete(npcId);
        session.lastDrive.set(npcId, "task");
        // A builder's commute is schedule playback — exactly the clock-path
        // bubble's case (phase 2 step 3): paced at the one playback rate,
        // dodging within the bubble, demoted to physics only when forced out.
        enqueueNpcErrand(session, npcId, {
          points: [{ x: at.x, y: at.y, dwell: BUILD_WORK_DWELL_S }],
          clocked: true,
        });
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
    // EMBODIED sources — wild trees/fauna are AVATARS, not objects (their
    // bodies carry bodyHeightM), the same fallback containerStandpoint has
    // always had. Without it every NPC sourcing path (siteMaterialSources,
    // stockEndpointOf) is blind to a standing oak and a homestead build
    // starves in silence while the player can chop the same tree by hand.
    const av = world?.state.avatars[id];
    if (av) return { x: av.x, y: av.y };
    const m = /^furn_(\d+)_/.exec(id);
    const town = session.town;
    if (m && town) {
      const h = town.plan.houses.find((hh) => hh.index === Number(m[1]));
      if (h) return houseDoorstep(town.stage.center, h);
    }
    return null;
  }

  /**
   * THE ITEM LEDGER'S VIEW of this session (kernel/town/item-move.ts): a legal
   * `ItemLocation` → the live, aliased stack it names. Every atomic move goes
   * through this, so "where may an item be" has one answer.
   *
   * A creature's HANDS are its carried stack — the same `pocket:<cid>` endpoint
   * the rest of the host already speaks. That is the whole point of the union:
   * a carrier mid-haul is holding its load in a place a player could point at,
   * not parked in a bookkeeping field that a failed errand would delete.
   *
   * `ground` resolves to null on purpose — loose props are individual world
   * objects, not a stack map, so they are moved by `dropFromStack` /
   * `takeIntoStack` rather than by a stack-to-stack transfer.
   */
  const itemLocOf = (session: QuestSession): ResolveLocation => (loc) => {
    switch (loc.kind) {
      case "container": return stockEndpointOf(session, loc.id);
      // One carried stack per creature today; the bag splits from the hands when
      // the inventory tier lands (goods-kinds INVENTORY_SLOTS).
      case "hands":
      case "inventory": return stockEndpointOf(session, `${POCKET_EP}${loc.cid}`);
      case "ground": return null;
    }
  };

  /** A house goods chest's capacity — the good's boxCap (PANTRY_CAP for
   *  food). Null for everything else (uncapped). */
  function houseChestCap(session: QuestSession, id: string): number | null {
    const m = /^furn_\d+_chest_(.+)$/.exec(id);
    if (!m || !session.town) return null;
    const g = session.town.stage.goods.find((x) => x.good.key === m[1]);
    return g ? Math.max(1, Math.round(g.boxCap)) : null;
  }

  /**
   * HOW MUCH THIS CONTAINER HOLDS, in UNITS (step ②).
   *
   * The goods box wins where it applies — the ECONOMY sizes a pantry, from the
   * good's own `boxCap`, and no table here should second-guess it. Everything
   * else takes its kind's declared capacity, which is how a basket comes to
   * hold eight of something instead of being a bag of holding.
   *
   * Null = uncapped, which is what every non-goods container was until now.
   */
  function containerUnitCap(session: QuestSession, id: string): number | null {
    const good = houseChestCap(session, id);
    if (good !== null) return good;
    const glyph = session.smallProps.get(id)?.glyph;
    if (glyph) return containerDefOfGlyph(glyph)?.capacity ?? null;
    return null;
  }

  /** Resolve an endpoint id to a LIVE StockEndpoint view, or null. Container
   *  ids resolve over containerStock; `pocket:<cid>` is a creature's hands
   *  (the player's pocket / a resident's carried stack). Derived stores
   *  (market shelves, produce piles, the trade depot) are time-pure
   *  projections with no mutable map to alias — NOT transfer endpoints. */
  /**
   * EVERY PLACE AN ITEM COULD BE IN THIS SESSION, as a walkable tree
   * (scope-unification.md step ①). The enumeration is the part that did not
   * exist: `stockEndpointOf` could always answer "what is in THAT", and nothing
   * could ask "what is in the town", because nothing knew the list.
   *
   * Read-only and derived — no new state, no new ids. The town is the root
   * (spelled `TOWN_SCOPE`, as ownership.ts spells it), buildings hang off it,
   * containers hang off their building, bodies off their household.
   */
  function scopeTreeOf(session: QuestSession): ScopeTreeInput {
    const t = session.town;
    return {
      ids: () => {
        const out = new Set<ScopeId>();
        if (t) {
          out.add(TOWN_SCOPE);
          for (const h of t.plan.houses) out.add(`h_${h.index}`);
          t.plan.works.forEach((_, i) => out.add(`w_${i}`));
          for (const row of t.deltas.cohorts) out.add(cohortEndpointId(row.district));
          for (const o of t.deltas.orders()) out.add(`${ORDER_PILE_EP}${o.ord}`);
          for (const key of shellFurnPilesOf(session).keys()) out.add(`${BFURN_EP}${key}`);
          for (const p of tradePartnersOf(session)) out.add(townEndpointId(p.key));
        }
        // Registered containers AND known stacks: a far unshown house's
        // woodstore holds real goods whether or not its object is staged, and
        // the audit has to see them or it will report items as lost.
        for (const id of session.containers.keys()) out.add(id);
        for (const id of session.containerStock.keys()) out.add(id);
        // Bodies. The player counts — its pocket is an inventory like any
        // other, and will become a container like any other.
        out.add(`${POCKET_EP}${PLAYER_CREATURE_ID}`);
        for (const cid of session.needCarried.keys()) out.add(`${POCKET_EP}${cid}`);
        return out;
      },
      endpointOf: (id) => stockEndpointOf(session, id),
      houseOfCreature: (cid) => {
        if (!cid.startsWith("resident_") && !cid.startsWith("pet_")) return null;
        const hi = houseIndexOfCid(cid);
        return Number.isFinite(hi) ? hi : null;
      },
      buildingOfContainer: (objectId) => {
        const o = world?.state.objects[objectId];
        if (!o || !world) return null;
        // A CONTAINER IN SOMEBODY'S HANDS BELONGS TO THEM (step ②) — the
        // basket a body is carrying is its inventory, and hangs off the body
        // rather than off whatever room the body happens to be standing in.
        // This is the whole law in one line: a scope's inventory is the sum of
        // the containers it holds.
        if (o.carriedBy) return `${POCKET_EP}${creatureOfAvatar(o.carriedBy)}`;
        return buildingAt(world.state, o.x, o.y)?.id ?? null;
      },
      buildingOfOrder: (ord) => {
        // A FOUNDED order has no building yet — it IS one being made, on ground
        // that belongs to the town. Every other order grows or shrinks an
        // existing building and names it.
        const o = t?.deltas.orders().find((q) => q.ord === ord);
        return o && "buildingKey" in o ? o.buildingKey : null;
      },
      townId: () => (t ? TOWN_SCOPE : null),
    };
  }

  /** WHAT THIS SESSION HOLDS, ALL IN — every stack in the tree, summed by glyph.
   *  The conservation probe `condense`/`expand` will be checked against, landed
   *  with the tree rather than after it. */
  function sessionStockAudit(session: QuestSession): Record<string, number> {
    return auditScopeTree(scopeTreeOf(session));
  }

  function stockEndpointOf(session: QuestSession, id: string): StockEndpoint | null {
    if (!world) return null;
    // ONE PARSE, then a dispatch on a closed union (kernel/town/scope.ts). This
    // was ten string-prefix tests in a row, which is why nothing could ask what
    // CONTAINS what: the id vocabulary was known only to the reader that
    // happened to be looking for its own prefix. The branch BODIES below are
    // unchanged — step ① of scope-unification.md moves no behaviour.
    //
    // 🚨 `town:yard` is syntactically a `town:` id and semantically OUR
    // container, so the registry check keeps its precedence here rather than in
    // the parser: which of the two a `town:*` id means is a fact about this
    // session, not about the string.
    const ref = parseScopeId(id);
    if (ref.kind === "creature") {
      const cid = ref.cid;
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
    if (ref.kind === "district") {
      const row = session.town ? cohortRowOf(session.town.deltas.cohorts, ref.district) : undefined;
      if (!row) return null;
      const a = districtAnchorWorld(session, ref.district);
      return cohortEndpoint(row, { x: a.x, y: a.y });
    }
    // A TRADE PARTNER's town-scale stack (⑤): `town:<partnerKey>` — the ②
    // bridge's endpoint id convention made LIVE. A real-sim partner (cluster
    // neighbor) aliases its OWN yard (deltas.stock — shipments conserve
    // across both economies); an abstract partner aliases its synthetic
    // shelf. No `at`: abstract, scheduled-only (transfer.ts convention).
    // ("town:yard" is a registered container and never reaches this branch.)
    if (ref.kind === "town" && !session.containers.has(id)) {
      const p = tradePartnersOf(session).find((tp) => townEndpointId(tp.key) === id);
      if (!p) return null;
      return { id, kind: "town", stack: p.stack, owner: null };
    }
    // A CONSTRUCTION ORDER's PILE (phase 2): `orderpile:<ord>` aliases the
    // order's live pile — the staked plot's material heap. Communal,
    // uncapped, anchored at the site (the marking is walkable ground). Gone
    // once the order commits (completion consumed the pile).
    if (ref.kind === "orderPile") {
      const ord = ref.ord;
      const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
      const o = deltas?.orders().find((q) => q.ord === ord);
      if (!o || o.kind === "demolish") return null;
      if (o.kind === "found") {
        if (o.completed) return null;
        const at = foundedLotAt(session, o);
        if (!at) return null;
        o.pile ??= {};
        return { id, kind: "site", at, stack: o.pile, owner: null };
      }
      // A REFINE order's pile (phase 3) anchors at its own mill spot.
      if (o.kind === "refine") {
        return { id, kind: "site", at: o.at, stack: o.pile, owner: null };
      }
      const at = pendingAnnexAt(session, o);
      if (!at) return null;
      return { id, kind: "site", at, stack: o.pile, owner: null };
    }
    // A FOUNDED SITE PILE (LEGACY, pre-phase-2 agreements in flight):
    // `sitepile:<ord>` — founding ordinals are immortal, so the plain ord
    // lookup still lands on the adapted order's live pile.
    if (ref.kind === "sitePile") {
      const ord = ref.ord;
      const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
      const b = deltas?.founded().find((f) => f.ord === ord);
      if (!b || b.completed) return null;
      const at = foundedLotAt(session, b);
      if (!at) return null;
      b.pile ??= {};
      return { id, kind: "site", at, stack: b.pile, owner: null };
    }
    // A PENDING ANNEX PILE (LEGACY, pre-phase-2 agreements in flight):
    // `annexpile:<ord>` named the row's OLD per-kind ordinal — the one-
    // sequence adapter renumbered the row and kept that number as
    // `legacyOrd`, which is why it resolves FIRST here.
    if (ref.kind === "annexPile") {
      const ord = ref.ord;
      const rows =
        session.town?.deltas
          .orders()
          .filter((o): o is RoomOrder => o.kind === "annex" || o.kind === "interior") ?? [];
      const p = rows.find((a) => a.legacyOrd === ord) ?? rows.find((a) => a.ord === ord);
      const at = p ? pendingAnnexAt(session, p) : null;
      if (!p || !at) return null;
      return { id, kind: "site", at, stack: p.pile, owner: null };
    }
    // A BUILDING's FURNITURE-DELIVERY pile (⑥): `bfurn:<deltaKey>` — the
    // hauled piece lands here; the placement sweep stands it up. Anchored
    // at the building's center; communal.
    if (ref.kind === "buildingFurnPile") {
      const key = ref.buildingKey;
      const t = session.town;
      const b = pendingBuildingOf(session, key);
      if (!t || !b) return null;
      // The pile lives on TownDeltas now (rewrite 1b — persisted with the
      // agreements that feed it); materialize-on-touch is unchanged.
      const piles = shellFurnPilesOf(session);
      let stack = piles.get(key);
      if (!stack) {
        stack = {};
        piles.set(key, stack);
      }
      const at = {
        x: t.stage.center.x + b.shape.dx + b.shape.w / 2,
        y: t.stage.center.y + b.shape.dy + b.shape.h / 2,
      };
      return { id, kind: "site", at, stack, owner: null };
    }
    if (session.marketStore.has(id) || session.produceBox.has(id) || id.startsWith("trade:")) return null;
    // A KNOWN STACK is a real endpoint even when its container object isn't
    // STAGED right now (⑥ — the coincidence law): a far unshown house's
    // woodstore holds real goods, and civic resolution already reads its
    // stack; refusing the endpoint here made every draw from unstreamed
    // ground fail at claim time. The anchor is deterministic either way.
    if (!session.containers.has(id) && !session.containerStock.has(id)) return null;
    let stack = session.containerStock.get(id);
    if (!stack) {
      stack = {};
      session.containerStock.set(id, stack); // a registered but never-stocked container (a cupboard)
    }
    const at = containerAnchor(session, id);
    if (!at) return null;
    const kind = id === TOWN_YARD_ID ? "yard" : id === SITE_STOCK_ID ? "site" : "container";
    const ep: StockEndpoint = { id, kind, at, stack, owner: session.containerOwner.get(id) ?? null };
    const cap = containerUnitCap(session, id);
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
    // registered container answering to it (the resolver's token rule). Ids
    // carry the fixture KIND, so the board's word folds back first ("cabinet"
    // → the `furn_<n>_cupboard` token).
    const kindToken = fixtureKindForWord(id);
    const at = playerWorldPos(session);
    let best: string | null = null;
    let bestD = Infinity;
    for (const boxId of session.containers.keys()) {
      if (!boxId.split(/[_:]/).includes(kindToken)) continue;
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
    // WALK TO THE FIXTURE'S EDGE, NOT ITS CENTRE (the reach law —
    // [[project_furniture_use_radius_blind_gates]]). A container endpoint reports
    // its object's CENTRE, and a cupboard/chest is a solid collider: a body sent
    // to that coordinate can never stand on it, so it halts flush against the
    // face and the leg NEVER reports arrival. The unload then never runs — the
    // carrier stands there holding the load forever, the craft it was feeding
    // waits on materials that are two feet away, and the only visible sign is a
    // resident idling in the kitchen. `standPointFor` resolves the centre to a
    // real standable spot beside the piece, which is what every other walk-to-
    // furniture path in this file already does.
    const bodyR = world.npcRadiusOf(npcId);
    const standAt = (epAt: { x: number; y: number }, epId: string, from2: { x: number; y: number }) =>
      session.containers.has(epId)
        ? standPointFor(world!.state, epId, epAt, from2, bodyR, standAvoid(cid))
        : { x: epAt.x, y: epAt.y };
    const bodyNow = world.state.avatars[npcId] ?? { x: from.at.x, y: from.at.y };
    const pickAt = standAt(from.at, a.from, { x: bodyNow.x, y: bodyNow.y });
    const destAt = standAt(to.at, a.to, pickAt);
    enqueueNpcErrand(session, npcId, {
      points: [pickAt, destAt],
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
            // LOAD — the goods move SOURCE → THIS CREATURE'S HANDS, atomically.
            //
            // They used to be taken from the source and parked on the agreement's
            // `carried` field, which is not a place: `complete`, `fail` and
            // `cancel` all delete it, so a haul that died after loading destroyed
            // its cargo. Now the load lives somewhere real, and a dead errand
            // just leaves a creature holding something — which the hands-empty
            // banking already knows how to resolve. Nothing can vanish here.
            //
            // The live map stays the truth: a shelf raided during the walk loads
            // what's LEFT (ask for what is actually there), an emptied one fails
            // ALOUD.
            const src = stockEndpointOf(session, agr.from);
            const want: Record<string, number> = {};
            for (const [g, n] of Object.entries(agr.goods)) {
              const have = src ? stackUnits(src.stack, g) : 0;
              const take = Math.min(n, have);
              if (take > 0) want[g] = take;
            }
            const loaded = moveItems(
              itemLocOf(session),
              { kind: "container", id: agr.from },
              { kind: "hands", cid },
              want,
            );
            if (!loaded.ok || !Object.keys(loaded.moved).length) {
              session.transfers.fail(agreementId, "missing");
              npcChatBubble(session, cid, noStock(head)[syntax]);
              return;
            }
            for (const [g, c] of Object.entries(loaded.moved)) {
              for (let k = 0; k < c; k++) removeVisibleContainedProp(session, agr.from, g);
              // The loaded units are no longer spoken for (pipeline ② —
              // no-op for agreements that reserved nothing).
              session.reservations.consume(agrHolder(agreementId), agr.from, g, c);
            }
            if (agr.from === `${POCKET_EP}${PLAYER_CREATURE_ID}`) pushPocket(session);
            fellIfConsumed(session, agr.from); // a hauled-empty kill-source is felled
            // `carried` is now a MANIFEST — what this haul is meant to be
            // delivering — never the storage itself. The goods are in the hands.
            session.transfers.load(agreementId, loaded.moved);
          }
          // The visible load: one carried prop tokens the whole armful. (The
          // token is a REGISTERED instance while the manifest also counts the
          // units — one thing in two ledgers. Left as it was on purpose: that
          // is the scope-ledger rewrite's to settle, not this pass's.)
          const body = world.state.avatars[npcId];
          if (!npcCarrying(npcId) && body) {
            takeIntoHands(
              session,
              npcId,
              { kind: "glyph", glyph: head, at: { x: body.x, y: body.y } },
              { reachAt: from.at },
            );
          } else {
            fireCarryGesture(npcId, "pickup", from.at); // already holding the armful
          }
          return;
        }
        // UNLOAD.
        const dst = stockEndpointOf(session, agr.to);
        if (!dst) {
          session.transfers.fail(agreementId, "no-endpoint");
          return;
        }
        // UNLOAD — HANDS → destination, atomically. `agr.carried` is only the
        // manifest of what this haul set out with; the goods themselves are in
        // the creature's hands, so we deliver what it is ACTUALLY holding (it may
        // have eaten a carried apple, or been handed something on the way).
        const hands = stockEndpointOf(session, `${POCKET_EP}${cid}`);
        const deliver: Record<string, number> = {};
        for (const [g, n] of Object.entries(agr.carried ?? {})) {
          const held = hands ? stackUnits(hands.stack, g) : 0;
          const give = Math.min(n, held);
          if (give > 0) deliver[g] = give;
        }
        const dropped = moveItems(
          itemLocOf(session),
          { kind: "hands", cid },
          { kind: "container", id: agr.to },
          deliver,
        );
        if (!dropped.ok) {
          // The destination could not take it (full). The load stays IN HAND —
          // never scattered, never deleted — and the haul fails honestly. The
          // carrier's own banking will put it somewhere sensible. This used to
          // strew refused units on the ground as fresh props, which is where a
          // stack unit and a ground prop could both come to exist.
          session.transfers.fail(agreementId, "refused");
          fireCarryGesture(npcId, "putdown", destAt);
          return;
        }
        const accepted = dropped.moved;
        for (const [g, c] of Object.entries(accepted)) {
          for (let k = 0; k < c; k++) addVisibleContainedProp(session, agr.to, g);
        }
        // LANDING = RESERVATION, atomically (phase 2 step 1): a unit
        // delivered to a craft spot or a construction pile is spoken for
        // from the instant it exists there — before the ledger says "done",
        // so no resolver ever sees it as free supply, not even for one tick.
        onTransferLanded(session, agreementId, accepted);
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
        // The token's goods are in the destination's stack now, so the token is
        // spent. Anything ELSE in those hands (a quest item picked up on the
        // way) is not this haul's to dispose of — it only plays the gesture.
        const held = npcCarrying(npcId);
        if (held && session.smallProps.has(held)) {
          setDownFromHands(session, npcId, { kind: "consumed" }, { objId: held, reachAt: destAt });
        } else {
          fireCarryGesture(npcId, "putdown", destAt);
        }
        session.transfers.complete(agreementId);
        presenter.toast(`📦 ${agr.sourceGlyph ?? "transfer"} — delivered`, "feedback");
      },
    });
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


  /** Leave build mode / step back to the spot list, re-pushing the board. */
  function resetBuildFocus(session: QuestSession, opts?: { off?: boolean }): void {
    if (opts?.off) buildMode = false;
    buildSpotId = null;
    clearSpotCache();
    session.civicSig = "";
  }

  /**
   * SELECT A BUILD SPOT — the same ONE-AT-A-TIME rule every other selection
   * obeys: choosing a spot is choosing a thing, so it releases whatever else
   * was selected (an open container) exactly as opening a container releases
   * the spot. Null deselects. No-ops when nothing changes, so the board's
   * diff-gate stays honest.
   */
  function selectBuildSpot(session: QuestSession, id: string | null): void {
    if (buildSpotId === id) return;
    buildSpotId = id;
    if (id && container) closeContainer(); // one selection at a time
    session.civicSig = ""; // the board re-pushes for the new selection
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



  /** STRUCTURE BOARD (city-founding ③, ⑦ revision): the focused building's
   *  resting board — what it can set OUT, plus the ONE build word. Its
   *  construction acts moved behind that word with everything else's: at
   *  house scope exactly as at town scope, pressing `build` lights the
   *  ground and the building answers as a SPOT. Shares the civic diff-gate
   *  (`civicSig` — sig "" ⇔ nothing shown), so scope flips re-push once. */
  function pushStructureBoard(session: QuestSession, focus: StructureFocus) {
    const found = structureActsFor(session, focus);
    const furnish = found ? structureFurnishOptions(session, focus, found.acts) : null;
    // The build word rides whenever this building could actually answer it.
    const buildable =
      !!found &&
      structureConstructionOptions(session, focus, found.acts, found.house).options.length > 0;
    const sig =
      furnish && (furnish.options.length || buildable)
        ? `S${focus.kind}${focus.index}//${furnish.sig}//B${buildable ? 1 : 0}`
        : "";
    if (sig === session.civicSig) return;
    const hadBoard = session.civicSig !== "";
    session.civicSig = sig;
    if (!sig || !furnish) {
      if (hadBoard) clearBoard();
      return;
    }
    const locale = session.game.meta.locale ?? "en";
    pushBoard({
      kind: "choice",
      nodeId: "__structure__",
      posedByEntityId: "__town__",
      prompt: "home",
      promptText: translateGlyph("home", locale),
      options: [
        ...(buildable
          ? [{
              id: "build:mode",
              label: "build",
              glyph: "build",
              spokenText: translateGlyph("build", locale),
            }]
          : []),
        ...furnish.options,
      ],
    });
  }


  /**
   * THE BUILD-MODE BOARD (⑦). Two faces, both tiny:
   *   • no spot settled on — just the word that leaves ("stop"). The board is
   *     deliberately near-empty here: the SURFACE is the lit ground, and a
   *     list of options beside it would put the player back in a menu.
   *   • a spot settled on — exactly what THAT spot can take. A free plot
   *     lists the structures that fit it; a ROOM lists what can be done to
   *     that room (which is the only place the break word ever appears); a
   *     GROWTH AREA lists the room kinds that fit that ground; a standing
   *     building — the grain the ground offers above structure focus — lists
   *     its own acts (the same ones its focused board would give, one
   *     computation, `structureConstructionOptions`).
   */
  function pushBuildModeBoard(session: QuestSession, ctx: BuildContext): void {
    const spots = buildSpotsNow(session, ctx);
    let spot = spots.find((s) => s.id === buildSpotId) ?? null;
    if (buildSpotId && !spot) buildSpotId = null; // it got built / went away
    // ONE THING TO AIM AT ⇒ it is already aimed at. Focused on a single
    // house there is no list of places to choose between, so making the
    // player dwell on the only spot would be ceremony.
    if (!spot && spots.length === 1) {
      buildSpotId = spots[0]!.id;
      spot = spots[0]!;
    }
    const locale = session.game.meta.locale ?? "en";
    const options: QuestBoardView["options"] = [];
    let sig = `B${spots.length}:${spot?.id ?? ""}`;
    const buildWord = (s: StructureSpec, id: string) => ({
      id,
      label: s.label,
      glyph: `build + ${structureDisplayGlyph(s)}`,
      spokenText: translateGlyph(`build + ${s.glyph}`, locale),
    });
    if (!spot) {
      // NO PLACE CHOSEN — name the structure and the CITIZENS pick the
      // ground (the ①b behaviour, kept as the default): a player who knows
      // what they want but not where should never have to aim first. Only
      // at TOWN scope: founding a farm from inside one house is not a thing
      // that house can do (scope = the object in a vacuum).
      const founding = spots.some((s) => s.kind === "lot") ? ctx.catalog : [];
      sig += `//${founding.map((s) => s.type).join("|")}`;
      options.push(...founding.map((s) => buildWord(s, `build:${s.type}`)));
    } else if (spot.kind === "lot") {
      const specs = (spot.types ?? [])
        .map((tp) => resolveStructure(ctx.catalog, tp))
        .filter((s): s is StructureSpec => !!s);
      sig += `//${specs.map((s) => s.type).join("|")}`;
      options.push(...specs.map((s) => buildWord(s, `spot:${spot.slot}:${s.type}`)));
    } else if (spot.kind === "site" && spot.site) {
      // WORK IN PROGRESS — the only thing you can do to it is call it off.
      const target = cancellableSite(session, spot.site);
      sig += `//x${target?.kind ?? "none"}`;
      if (target) {
        const glyph = `break + ${target.kind === "demolition" ? "room" : "building"}`;
        options.push({
          id: `unbuild:${spot.site}`,
          label: `stop ${target.label}`,
          glyph,
          spokenText: translateGlyph(glyph, locale),
        });
      }
    } else if (spot.kind === "room" && spot.focus && spot.room) {
      // ONE ROOM, ITS OWN WORD (user law): the option to break a room exists
      // only while THAT room is lit. Aiming at a whole house and being handed
      // "break bedroom / break kitchen / break store" is a list of verbs with
      // no object — the very thing the build word was meant to abolish.
      const found = structureActsFor(session, spot.focus);
      const room = found?.acts.rooms.find((r) => r.id === spot.room);
      const breakable = !!found?.acts.demolish.some((r) => r.id === spot.room);
      const kind = room?.kind ?? (spot.roomKind as HouseRoom["kind"] | undefined);
      sig += `//r${spot.room}${breakable ? "!" : ""}`;
      if (breakable && kind) {
        const glyph = `break + ${ROOM_GLYPH[kind] ?? "room"}`;
        options.push({
          id: `${spot.focus.kind === "house" ? "demolish" : "wdemolish"}:${spot.focus.index}:${spot.room}`,
          label: `break ${kind}`,
          glyph,
          spokenText: translateGlyph(glyph, locale),
        });
      }
    } else if (spot.kind === "grow" && spot.focus && spot.offers) {
      // GROUND A ROOM COULD TAKE — the place was named by the aim, so the
      // press names only the kind, and the order is PINNED to this exact
      // candidate (the highlight is a promise about the ground).
      sig += `//g${spot.offers.map((o) => o.kind).join("|")}`;
      options.push(
        ...spot.offers.map((o) => {
          const glyph = `build + ${ROOM_GLYPH[o.kind as HouseRoom["kind"]] ?? "room"}`;
          return {
            id: `grow:${o.kind}`,
            label: `build ${o.kind}`,
            glyph,
            spokenText: translateGlyph(glyph, locale),
          };
        }),
      );
    } else if (spot.kind === "building" && spot.focus) {
      const found = structureActsFor(session, spot.focus);
      const built = found
        ? structureConstructionOptions(session, spot.focus, found.acts, found.house)
        : null;
      if (built) {
        sig += `//${built.sig}`;
        options.push(...built.options);
      }
    }
    if (sig === session.civicSig) return;
    session.civicSig = sig;
    pushBoard(
      {
        kind: "choice",
        nodeId: "__build__",
        posedByEntityId: "__town__",
        prompt: "build",
        promptText: translateGlyph("build", locale),
        options,
      },
      // BACK steps out one level: a chosen spot releases first, then the
      // whole mode. The board's own chrome — never a bespoke "stop" button.
      () => (spot ? selectBuildSpot(session, null) : resetBuildFocus(session, { off: true })),
    );
  }

  /** Contextual CIVIC BOARD options (①b board surface + ③ zoning): ONE build
   *  word (⑦ — the options live on the ground now, not in a list), then the
   *  ZONE words (every catalog category + "clear"), pushed while nothing else
   *  owns the board. Diff-gated; pressing one speaks the sentence.
   *  STRUCTURE SCOPE (③): while the player focuses ONE building, the
   *  town words yield to that building's own board. */
  function pushCivicBuildBoard(session: QuestSession) {
    const idle = !convo && !choice && !container;
    const ctx = idle ? buildContext(session) : null;
    // BUILD MODE OUTRANKS SCOPE (⑦). The lit ground is the same surface at
    // every scope — a focused house's own spot answers exactly as a town's
    // free lot does — so the build board wins over the resting structure
    // board while the word is up.
    if (idle && buildMode) {
      if (ctx) {
        pushBuildModeBoard(session, ctx);
        return;
      }
      // Nowhere to build at all (left the town, no site) — drop the mode
      // rather than hold lights over ground that can't answer. A busy board
      // (a conversation, an open chest) is NOT that: it keeps the mode.
      buildMode = false;
      buildSpotId = null;
      clearSpotCache();
    }
    if (idle) {
      const focus = structureFocusOf(session);
      if (focus) {
        pushStructureBoard(session, focus);
        return;
      }
    }
    // THE ONE BUILD WORD. It rides whenever this session can build at all —
    // affordability is a question about a PLACE and a STRUCTURE, and neither
    // is chosen yet (⑥b: a shortfall never refuses, it waits honestly).
    const buildable = !!ctx;
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
    const sig = ctx && (buildable || zonable.length || tradeable.length)
      ? `${buildable ? "build" : ""}//${zonable.map((s) => s.type).join("|")}//${tradeable.join("|")}//A${areaOverlayOn ? 1 : 0}`
      : "";
    if (sig === session.civicSig) return;
    const hadCivic = session.civicSig !== "";
    session.civicSig = sig;
    if (!sig) {
      if (idle && hadCivic) clearBoard();
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
        // ONE WORD (⑦). Pressing it lights the ground; the structures live in
        // the spot menus a dwell opens, where a place has already been named.
        ...(buildable
          ? [{
              id: "build:mode",
              label: "build",
              glyph: "build",
              spokenText: translateGlyph("build", locale),
            }]
          : []),
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
            },
            // "SHOW AREAS" (city-founding areas): the toggleable map-reading
            // overlay — designations are otherwise visible only through
            // their consequences.
            {
              id: "areas:show",
              label: areaOverlayOn ? "hide areas" : "show areas",
              glyph: "show + area",
              spokenText: translateGlyph("show + area", locale),
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
    // Their water follows them in (needs-aware districts): a household
    // landing past the thirst radius accrues founding mass NOW, not at
    // the next rebuild.
    digServiceWells(session);
  }

  /**
   * LIVE WELL DIGGING (needs-aware districts): rerun the thirst service
   * pass over the standing households, anchored on every well already dug
   * — a founded quarter gets its water when its people arrive. The rebuild
   * half is town-play.ts (the same pass after applyFoundedBuildings), so a
   * reload converges on the same coverage. Scale-blind sessions (no
   * plan.wells) never dig.
   */
  function digServiceWells(session: QuestSession) {
    const t = session.town;
    if (!t || !t.plan.wells || !world) return;
    const lots = foundServicePoints(t.plan.houses, [PLAZA_WELL, ...t.plan.wells], t.plan.streets, {
      convenientM: serviceRadiusM(session.scale, "thirst"),
      foundMass: WELL_FOUND_MASS,
    });
    for (const h of lots) {
      const wp = wellVergePoint(h);
      const wid = `well_${t.plan.wells.length + 1}`;
      t.plan.wells.push(wp);
      world.addObject({
        id: wid,
        x: t.stage.center.x + wp.x,
        y: t.stage.center.y + wp.y,
        shape: "box",
        radius: 0.8,
        fixture: "barrel",
        openable: false,
        facing: 0,
        interactions: [],
        contains: [{ relation: "in", capacity: 99 }],
        glyph: "water",
      });
      session.containers.set(wid, "in");
      session.containerStock.set(wid, { water: 99 });
      session.containerOwner.set(wid, TOWN_SCOPE); // communal at the TOWN tier
      presenter.toast("⛲ the neighborhood digs a well", "feedback");
    }
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

  // ── THE CONSTRUCTION DIRECTOR (phase 1a) ────────────────────────────────
  // The whole construction pipeline — craft jobs, founded/annex/demolition
  // designations and sweeps, build spots, zoned growth, order handlers —
  // extracted verbatim to construction-director.ts. The ctx hands it every
  // host closure those bodies capture; the destructure below re-binds the
  // moved functions under their original names so every remaining call site
  // in this file is unchanged. (Function declarations hoist, so the ctx can
  // reference them here; nothing calls the director until the frame loop.)
  const director = createConstructionDirector({
    presenter, deps, possession,
    avatarIdOf, npcChatBubble, containerAnchor, houseContainerKeys,
    stockEndpointOf, postPooledTask, playerWorldPos, familyOf,
    playerFocusArea, issueTransferHaul, enqueueNpcErrand, townShortage,
    standAvoid, stackTake, spawnLooseProp, residentTownCtx, removeLooseProp,
    relationToward, pushPocket, itemLocOf, issueGoalPlan, handlePlaceOrder,
    gazeCreature, fireCarryGesture, fellIfConsumed, dropFromStack,
    takeIntoHands, setDownFromHands,
    creatureMood,
    questViewOf: () => questView,
    invalidateTownJobs: () => { townJobsMemo = null; },
    convoNodeId: () => convo?.nodeId ?? null,
    spiritFocusOf: () => spiritFocus,
  });
  const {
    setWorld, setSites, sites: directorSites, buildGhostsNow, clearSpotCache, shellFurnPilesOf,
    prosperitySignals, stepConstructionHousekeeping,
    foundNewSite, stepFoundedSite,
    buildContext, buildSpotsNow, cancellableSite, cancelWork, structureLabelOf,
    structureCatalogOf, buildMissingMaterials, pendingGrowthRects,
    steeringNear, buildCandidates, buildworkSiteAt, foundedLotAt,
    pendingAnnexAt, pendingBuildingOf, agrHolder, onTransferLanded, buildDayNow,
    isCivicStockDest,
    executeBuildOrder, stepFoundedConstruction, stepFurnitureSetup,
    orderCraft, orderBuild, orderZone, stepZonedFounding,
    structureFocusOf, structureActsFor, structureConstructionOptions, structureFurnishOptions,
    orderAnnex, stakeAnnex, orderDemolish, orderWorkRoom, orderWorkDemolish,
    // ④ — the room verbs' stow-only twin and the single-piece break.
    orderEmpty, orderWorkEmpty, orderBreakPiece,
  } = director;

  const api: QuestHost3D = {
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
      // BOARD CHROME FIRST (⑦ board-chrome.ts). Paging and going back are
      // properties of the board itself, so they are answered here — before
      // any producer's ids — and no board ever handles either one.
      if (id === BOARD_MORE_ID) {
        if (lastBoardView) {
          boardPage += 1;
          pushBoard(lastBoardView, boardBack);
        }
        return;
      }
      if (id === BOARD_BACK_ID) {
        const back = boardBack;
        if (back) back();
        return;
      }
      // STRUCTURE BOARD acts (city-founding ③): the focused house's own
      // words — annex, demolish, furnish. Each speaks its sentence and
      // runs the kernel-validated order; refusals are spoken, never silent.
      if (id.startsWith("annex:") && sess) {
        const s = sess;
        const [, hi, cluster] = id.split(":");
        const roomKind = ANNEX_ROOM_KIND[cluster as AnnexCluster];
        const glyph = `build + ${roomKind ? ROOM_GLYPH[roomKind] : "room"}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        if (!orderAnnex(s, Number(hi), cluster as AnnexCluster)) {
          saySystem(s, CANT_HERE, `💬 "${glyph}" — can't build here`);
        }
        if (buildMode) resetBuildFocus(s); // back to the lit ground (⑦)
        return;
      }
      if (id.startsWith("wroom:") && sess) {
        // ⑤b — a focused WORK building's interior room ("build bedroom"
        // on the empty shell): the same spoken sentence, the work path.
        const s = sess;
        const [, wi, kind] = id.split(":");
        const roomKind = (kind ?? "hall") as HouseRoom["kind"];
        const glyph = `build + ${ROOM_GLYPH[roomKind] ?? "room"}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        if (!orderWorkRoom(s, Number(wi), roomKind)) {
          saySystem(s, CANT_HERE, `💬 "${glyph}" — can't build here`);
        }
        if (buildMode) resetBuildFocus(s);
        return;
      }
      if (id.startsWith("wdemolish:") && sess) {
        const s = sess;
        const [, wi, roomId] = id.split(":");
        const wk = s.town?.plan.works[Number(wi)];
        const droom =
          s.town && wk
            ? buildingRoomPlan(
                s.town.stage.center, Number(wi), wk,
                wk.program ?? workProgram(wk.type),
                s.town.deltas.get(workDeltaKey(wk, Number(wi))),
              ).rooms.find((r) => r.id === roomId)
            : undefined;
        const glyph = `break + ${droom ? ROOM_GLYPH[droom.kind] : "room"}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        if (!orderWorkDemolish(s, Number(wi), roomId ?? "")) {
          saySystem(s, CANT_HERE, `💬 "${glyph}" — can't do that here`);
        }
        if (buildMode) resetBuildFocus(s);
        return;
      }
      if (id.startsWith("demolish:") && sess) {
        const s = sess;
        const [, hi, roomId] = id.split(":");
        const dh = s.town?.plan.houses.find((h) => h.index === Number(hi));
        const droom =
          s.town && dh
            ? houseRoomPlan(s.town.stage.center, dh, s.town.deltas.get(`h_${hi}`)).rooms.find(
                (r) => r.id === roomId,
              )
            : undefined;
        const glyph = `break + ${droom ? ROOM_GLYPH[droom.kind] : "room"}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        if (!orderDemolish(s, Number(hi), roomId ?? "")) {
          saySystem(s, CANT_HERE, `💬 "${glyph}" — can't do that here`);
        }
        if (buildMode) resetBuildFocus(s);
        return;
      }
      if (id.startsWith("furn:") && sess) {
        const s = sess;
        const [, hi, kind] = id.split(":");
        const glyph = `put + ${kind}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        // The house's own people do the placing (the ONE placement path —
        // resident-mediated, willing-gated, refused aloud). Needs a body
        // home to do it (the auto-place guard).
        const cid = `resident_${Number(hi)}_0`;
        const handled =
          !!world?.state.avatars[avatarIdOf(cid)] &&
          handlePlaceOrder(s, cid, {
            kind: "place",
            item: { match: { kind: kind ?? "" } },
            at: { relation: "in", anchor: { kind: "home" } },
          });
        if (!handled) saySystem(s, CANT_HERE, `💬 "${glyph}" — no one here can place that`);
        if (buildMode) resetBuildFocus(s);
        return;
      }
      // BUILD MODE (⑦): the one build word LIGHTS THE GROUND rather than
      // unfolding a list, and "stop" puts the lights out. Both are view acts
      // on the same word — nothing lands in the deltas until a spot answers.
      if (id === "build:mode" && sess) {
        const s = sess;
        const said = playerStatement("build");
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        buildMode = true;
        resetBuildFocus(s);
        presenter.toast("🔨 look at a plot to build, or at a building to change it", "feedback");
        return;
      }
      // CALL OFF work in progress (⑦ deconstruction menu): the designation
      // drops and its hauled materials go back to the yard.
      if (id.startsWith("unbuild:") && sess) {
        const s = sess;
        const said = playerStatement("stop");
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        if (!cancelWork(s, id.slice(8))) {
          saySystem(s, CANT_HERE, `💬 that work can't be called off now`);
        }
        resetBuildFocus(s);
        return;
      }
      // A SPOT'S OWN BUILD (⑦): the place was named by the dwell, so this
      // press names only the structure — and the order is PINNED to that
      // plot (the highlight is a promise about the ground).
      if (id.startsWith("spot:") && sess) {
        const s = sess;
        const [, slotStr, type] = id.split(":");
        const glyph = `build + ${type}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        const spot = buildSpotsNow(s).find((sp) => sp.id === buildSpotId);
        const explicitBuilder =
          possession.creatureId ?? s.addressedFamily ?? gazeCreature(s) ?? null;
        const ok =
          !!spot &&
          orderBuild(s, type ?? "", glyph, explicitBuilder, {
            slot: Number(slotStr),
            at: { x: spot.x + spot.w / 2, y: spot.y + spot.h / 2 },
          });
        if (!ok) saySystem(s, CANT_HERE, `💬 "${glyph}" — can't build here`);
        resetBuildFocus(s);
        return;
      }
      // A GROWTH AREA'S OWN BUILD (⑦): the ground was named by the dwell, so
      // this press names only the room kind — and the order is PINNED to the
      // exact candidate that was lit, never re-derived to somewhere else in
      // the building.
      if (id.startsWith("grow:") && sess) {
        const s = sess;
        const kind = id.slice(5) as HouseRoom["kind"];
        const glyph = `build + ${ROOM_GLYPH[kind] ?? "room"}`;
        const said = playerStatement(glyph);
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        const spot = buildSpotsNow(s).find((sp) => sp.id === buildSpotId);
        const offer = spot?.offers?.find((o) => o.kind === kind);
        const ok =
          !!offer && !!spot?.focus &&
          (spot.focus.kind === "house"
            ? !!offer.cluster &&
              stakeAnnex(
                s, spot.focus.index, offer.cluster as AnnexCluster,
                offer.candidate as AnnexCandidate | InteriorCandidate,
                { pinned: true },
              )
            : orderWorkRoom(s, spot.focus.index, kind, offer.candidate as InteriorCandidate));
        if (!ok) saySystem(s, CANT_HERE, `💬 "${glyph}" — can't build here`);
        resetBuildFocus(s);
        return;
      }
      // CIVIC BUILD option (①b board surface): pressing "build <structure>"
      // speaks the sentence and runs the same order path speak() would. No
      // board raises these ids any more (⑦ routes through spots), but the
      // spoken/scripted order path still arrives here.
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
      // "SHOW AREAS" (city-founding areas): toggle the map-reading overlay.
      // A view act, not a designation — nothing lands in the deltas.
      if (id === "areas:show" && sess) {
        const said = playerStatement("show + area");
        if (opts.spokenExternally) yieldToStatement(said);
        else speakPlayerStatement(said);
        areaOverlayOn = !areaOverlayOn; // ZoneOverlay3D reads the gate next frame
        sess.civicSig = ""; // the button label flips show ↔ hide
        return;
      }
      // CIVIC AREA option (③): pressing "area <category>" (or "area none")
      // speaks the sentence and binds the named unit (the district under
      // the gaze, else the whole town), exactly as the spoken order would.
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
      if (container && id.startsWith("tame:")) {
        if (!sess) return;
        // The spoken claim ("my sheep") IS the act — say it, then own it.
        const wa = wildAnimalOf(sess, id.slice(5));
        if (wa) {
          const said = playerStatement(`${wa.species}.my`);
          if (opts.spokenExternally) yieldToStatement(said);
          else speakPlayerStatement(said);
        }
        tameWildAnimal(sess, id.slice(5));
        return;
      }
      if (container && id.startsWith("take:")) {
        if (!sess) return;
        // A BODILESS SPARK CANNOT REACH IN — anywhere, not just the dollhouse.
        // Hands are a property of a BODY, and the spark has none: it is a light
        // the world can notice, so pressing a stack NAMES it aloud and is a
        // COMMAND-LEVEL instruction (attention-spark.md) to the creature it is
        // addressing — the last one it conversed with (while on screen), else
        // the engaged one, else the nearest idle body of the player's group:
        // use that item — willing-gated, refused aloud.
        //
        // CLAIM A BODY and the same press is that body's own act: it takes the
        // stack into ITS inventory (`spiritNow()` is false the moment the spark
        // rides something, exactly as it is for a plain walker — one rule, one
        // question: does the player have hands here?). This used to key on
        // `dollhouse !== null` instead, so a spark gliding a live town's
        // streets teleported goods out of boxes it had no body to reach.
        if (spiritNow()) {
          const glyph = id.slice(5);
          const said = playerStatement(glyph);
          if (opts.spokenExternally) yieldToStatement(said);
          else speakPlayerStatement(said);
          attendContainerGlyph(sess, container.objId, glyph);
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
      resetDwells();
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
      // FOLLOWER: the sentence is VOICED here (the student always hears their
      // own words), but the WORLD half belongs to the owner — the platform
      // relays it as a WorldCommand "speak" (with THIS peer's resolved target)
      // and the owner injects it via applyRemoteCommand. Parsing/dispatching
      // locally too would fork the frozen replica world.
      if (mpFollower()) return;
      // The household NAME BOOK (family, pets, species words) — built up front:
      // the PARSER's classifier needs it (animacy: "mara + give + apple" makes
      // Mara the agent) and the binder resolves through it below.
      const byName = nameBook(s);
      const frame = parseSentence(sentence, { classifyEntity: (sym) => classifySpokenNoun(s, byName, sym) });

      // IN A CONVERSATION: a conversational move (request / where / hi / yes / no /
      // bye) is a DIALOGUE turn — the creature replies through the same path a board
      // press takes. Commands aren't conversational (intentToAct → null) and fall
      // through to the party/goal layer below.
      // NOT for a relayed command aimed elsewhere: an explicit `targetId` from a
      // remote peer must never be swallowed by the OWNER's open conversation.
      if (convo && s.creatures && (!opts.targetId || opts.targetId === convo.nodeId)) {
        const node = s.creatures.nodeByCreature.get(convo.nodeId);
        const act = intentToAct(frame, s.creatures.world, PLAYER_CREATURE_ID, convo.nodeId, creatureProjectionOpts(s, node?.announce));
        if (act) {
          runCreatureAct(act);
          return;
        }
      }

      // The addressed creature: an EXPLICIT relayed target preempts everything
      // (a remote peer resolved it from ITS OWN gaze/addressed state — see
      // resolveAddressee), then a SELECTED family chip (a stable eyegaze
      // target — deliberate beats incidental), then whom you're LOOKING at,
      // else in conversation, else — POSSESSED — the player's own avatar
      // creature (you can always talk to the body you ride), else nearest.
      const target = resolveAddressee(opts.targetId, {
        addressedFamily: s.addressedFamily,
        gaze: gazeCreature(s),
        convo: convo?.nodeId ?? null,
        possessed: possession.creatureId,
        nearest: nearestCreature(s),
      });
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
        ref?.kind === "entity" &&
        FURNITURE_ITEMS.some((f) => f.kind === fixtureKindForWord(ref.symbol));
      // A lidded CONTAINER kind — "open the chest" opens its physical LID (the
      // setOpen primitive) rather than a device toggle (a window).
      binder.isContainer = (ref) => ref?.kind === "entity" && OPENABLE_CONTAINER_WORDS.has(ref.symbol);
      // A CLOTHING kind — "wear the shirt" equips that garment (the wear
      // primitive); a non-garment "wear" falls through to the dress self-care.
      binder.isClothing = (ref) => ref?.kind === "entity" && propertiesOf(ref.symbol).includes("clothing");
      // A DEVICE kind — "stop the {device}" turns the active thing OFF
      // instead of halting the listener (semantic-gaps.md §Commands).
      binder.isDevice = (ref) => ref?.kind === "entity" && propertiesOf(ref.symbol).includes("device");
      // A RAISABLE STRUCTURE or a ROOM (construction ④). This binding is what
      // makes `build` mean build: without it every makeable word fell to the
      // craft reading, so a spoken "build a house" tried to whittle one. Three
      // live sources, no static list — the same vocabulary the boards offer:
      //   • the session's STRUCTURE CATALOG (resolveStructure — type/glyph/
      //     label, and it differs in the wilderness, at a site and in a town),
      //   • the STRUCTURE PROGRAMS (`word ?? type` — `house` speaks `home`),
      //   • the ROOM words (spokenRoomKind — the board's own room buttons ⊕
      //     the culture's room programs).
      // It only ever breaks a make/build TIE, so a word that is BOTH a
      // structure and a makeable still crafts under "make" — "make a house"
      // keeps whatever the makeable join says, and only "build" changes.
      binder.isStructure = (ref) => {
        if (ref?.kind !== "entity") return false;
        const w = ref.symbol;
        if (spokenRoomKind(s, w)) return true;
        const arch = programOverridesOf(s.town?.config.architecture);
        if (resolveStructurePrograms(arch).some((d) => (d.word ?? d.type) === w)) return true;
        return !!resolveStructure(structureCatalogOf(s), w);
      };
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
        if (member && commandSatisfy(s, member, goal.need, goal.with)) {
          presenter.toast(`▶ ${sentence}`, "feedback");
        } else if (goal.with) {
          // "we will eat together" with NOBODY ADDRESSED — the spirit calling
          // its own group to a gathering. It cannot be a head itself (no body,
          // no seat), so it does the one thing it honestly can: it ASKS, and
          // whichever member accepts declares the ritual in the ordinary way.
          const { accepted, tpl } = askToGather(s, goal.need, resolveCompanions(s, goal.with), PLAYER_CREATURE_ID);
          if (accepted.length) {
            presenter.toast(`▶ ${sentence}`, "feedback");
          } else if (!tpl && DEFAULT_VOICE_POLICY.inertCompany) {
            // NO SUCH GATHERING is a different answer from NOBODY IS FREE, and
            // the child deserves the one that is true: "we do not sleep
            // together" tells them about the world, "nobody can come" implies
            // a scheduling accident that never existed.
            saySystem(s, noGatheringLine(goal.need), `💬 "${sentence}" — we don't do that together`);
          } else {
            saySystem(s, CANT_HERE, `💬 "${sentence}" — nobody can come`, member);
          }
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
        npcChatBubble(s, helper, commandEchoLine(s, frame, goal, helper)); // "I will help Mara" / the earned ok
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
      // "make <thing>" → a CRAFT JOB (toys-and-song-expansion.md): the same
      // pipeline that makes furniture, pointed at a toy. Real inputs off real
      // stacks, the labor clock, the bench discount — and when a material is
      // missing the job's own gather branch hauls it, or waits honestly, which
      // IS the construction chain the plan asks for.
      if (goal.kind === "craft") {
        // WHO acknowledges, when someone was singled out ("you make a car") —
        // the same resolution `build` uses. This used to pass the SENTENCE in the
        // speaker slot, which made the acknowledgement bubble address a creature
        // id that never existed.
        const explicitMaker =
          (frame.subject !== undefined && actor !== PLAYER_CREATURE_ID ? actor : null) ??
          possession.creatureId ??
          s.addressedFamily ??
          gazeCreature(s) ??
          convo?.nodeId ??
          null;
        if (orderCraft(s, goal.glyph, explicitMaker)) return;
        saySystem(s, CANT_HERE, `💬 "${sentence}" — can't make that here`);
        return;
      }
      // ── THE UNMAKING VERBS (④, construction-structures.md §Demolishing or
      // Changing Rooms), spoken ──────────────────────────────────────────────
      // "break the bedroom" takes the room down whole; "empty the kitchen"
      // takes only its furniture out and leaves the walls standing. Both post
      // the SAME designation the structure board's buttons post — one path,
      // whether the word was pressed or said — so builders still have to come
      // and work it through, and every kernel refusal still speaks.
      if (goal.kind === "demolish" || goal.kind === "emptyRoom") {
        const emptying = goal.kind === "emptyRoom";
        const roomKind = spokenRoomKind(s, goal.room);
        if (!roomKind) {
          // A STRUCTURE word, not a room ("break the house"): a whole building
          // has no spoken unmaking path — the honest refusal, never a guess at
          // which of its rooms was meant.
          saySystem(s, CANT_HERE, `💬 "${sentence}" — can't take that down`);
          return;
        }
        const b = spokenBuildingOf(s, [actor, target, s.addressedFamily]);
        const room = b ? spokenRoomOf(s, b.plan, roomKind) : null;
        if (!b || !room) {
          // No building in focus, or no room of that kind in it. Which of the
          // two it was is not something the child can act on differently, but
          // the "there is no X here" IS — so that is what gets said.
          saySystem(s, CANT_HERE, `💬 "${sentence}" — no ${goal.room} here`);
          return;
        }
        const ok =
          b.scope === "house"
            ? emptying ? orderEmpty(s, b.index, room.id) : orderDemolish(s, b.index, room.id)
            : emptying ? orderWorkEmpty(s, b.index, room.id) : orderWorkDemolish(s, b.index, room.id);
        if (ok) return;
        saySystem(s, CANT_HERE, `💬 "${sentence}" — can't do that here`);
        return;
      }
      // "break the bed" — ONE PIECE comes apart where it stands. The board has
      // no button for this (a piece is not a room), so the sentence is the only
      // way in: the piece is named by KIND and the focused building — else the
      // addressed body's own home — is searched for a standing one, nearest the
      // player when several stand (the same tie-break the room words take).
      if (goal.kind === "breakPiece") {
        const word = "match" in goal.item ? goal.item.match.kind ?? "" : "";
        const pieceKind = fixtureKindForWord(word);
        const b = word ? spokenBuildingOf(s, [actor, target, s.addressedFamily]) : null;
        const standing = b ? b.pieces().filter((p) => p.kind === pieceKind) : [];
        const at = playerWorldPos(s);
        const piece =
          standing.length <= 1 || !at
            ? standing[0]
            : standing.reduce((best, p) =>
                Math.hypot(p.x - at.x, p.y - at.y) < Math.hypot(best.x - at.x, best.y - at.y) ? p : best,
              standing[0]!);
        if (!b || !piece) {
          // Nothing of that kind is standing here — the honest "there isn't
          // one", never a silent no-op on a word the child did say.
          saySystem(s, CANT_HERE, `💬 "${sentence}" — no ${word || "thing"} here`);
          return;
        }
        if (orderBreakPiece(s, b.key, piece.id)) return;
        saySystem(s, CANT_HERE, `💬 "${sentence}" — can't do that here`);
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
            npcChatBubble(s, m, commandEchoLine(s, frame, goal, m)); // the echo — or the earned ok
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
          npcChatBubble(s, m, commandEchoLine(s, frame, goal, m)); // the echo — or the earned ok
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
      attentionDebug?.setEnabled(on); // the attention readout rides the same toggle
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
      spiritFocus = frame;
      questView?.setSpiritFocus?.(frame);
    },
    setExternalCamera(on) {
      questView?.setExternalCamera?.(on);
    },
    setInteriorReveal(on) {
      questView?.setInteriorReveal?.(on);
    },
    setCrowdBudget(n) {
      crowdBudget = n;
    },
    setCreatureTier(t) {
      if (t === creatureTier) return;
      const prevTown = creatureTier;
      creatureTier = t;
      // Queue ONLY bodies whose EFFECTIVE tier (coarser of the town clamp and
      // the body's own band) actually changes — a town-level flip must never
      // rebuild bodies already governed by their per-body band. (An
      // unfiltered flood was the dollhouse crawl cycle: a flap rebuilt the
      // whole crowd both ways, seconds of staggered builds each time.)
      let queued = 0;
      for (const id of Object.keys(world?.state.avatars ?? {})) {
        if (!id.startsWith("resident_") && !id.startsWith("fauna:") && !id.startsWith("pet_")) continue;
        const b = bodyTiers.get(id) ?? "full";
        const oldEff = TIER_RANK[b] > TIER_RANK[prevTown] ? b : prevTown;
        const newEff = TIER_RANK[b] > TIER_RANK[t] ? b : t;
        if (oldEff === newEff) continue;
        if (!retierQueue.includes(id)) {
          retierQueue.push(id);
          queued++;
        }
      }
      // TEMP retier probe (perf-probes.ts): a town-tier change should be RARE
      // (a real descent/focus transition) — a steady stream of these lines is
      // the flap this filter and the driver debounce exist to kill.
      if (probesOn()) console.log(`[retier] town ${prevTown}→${t} queued=${queued}`);
    },
    setExternalCursor(on) {
      questView?.setExternalCursor?.(on);
    },
    cursorWorld(out) {
      return questView?.externalCursorWorld?.(out) ?? null;
    },
    addWildFeature(f) {
      const s = sess;
      const w = s?.wilderness;
      if (!s || !w || !world) return false;
      if (w.features.some((g) => g.id === f.id)) return false;
      // Stand the body FIRST — a refused spawn (body budget) must leave no
      // trace, so the caller's scenery instance stays visible and a later
      // attempt (budget freed) starts clean.
      if (!spawnWildFeature(s, f)) return false;
      w.features.push(f);
      return true;
    },
    removeWildFeature(id) {
      const s = sess;
      const w = s?.wilderness;
      if (!s || !w || !world) return false;
      const fi = w.features.findIndex((f) => f.id === id);
      if (fi < 0) return false;
      const f = w.features[fi]!;
      const key = wildFeatureContainerId(f);
      // Mirror fellIfConsumed's teardown — same stand-in, same maps — but
      // unconditionally: this is a RELEASE back to scenery, not a felling.
      if (container?.objId === key) closeContainer();
      if (world.state.objects[key]) world.removeObject(key);
      else if (world.state.avatars[key]) world.removeNpc(key);
      w.features.splice(fi, 1);
      s.containers.delete(key);
      s.containerStock.delete(key);
      s.containerOwner.delete(key);
      return true;
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
      setWorld(null); // the director's binding follows (phase 1a)
      questView = null;
      voice?.cancel();
    },
    applyNetInbound(msgs) {
      if (!mp || !world) return;
      const valid: WorldNetMessage[] = [];
      for (const raw of msgs) {
        // Tolerant validation: peers run vendored snapshots of different ages,
        // so anything message-shaped passes through (net.ts applyInbound
        // silently ignores unknown kinds); garbage is dropped here.
        if (!raw || typeof raw !== "object") continue;
        const m = raw as WorldNetMessage & { id?: unknown };
        if (typeof m.t !== "string") continue;
        // ECHO GUARD: never let the wire move/claim OUR avatar — neither under
        // our public personId (a loopback relay) nor under a raw PLAYER_ID
        // (an old snapshot that didn't translate its wire identity).
        if (
          (m.t === "avatar" || m.t === "say" || m.t === "leave" || m.t === "claim") &&
          (m.id === mp.localId || m.id === PLAYER_ID)
        ) {
          continue;
        }
        valid.push(m);
      }
      if (valid.length) world.applyNetInbound(valid);
    },
    applyRemoteCommand(cmd) {
      // OWNER-ONLY: followers don't own the sim — their copy converges from
      // the owner's streams (and claims reach them via the mesh message).
      if (mp?.role !== "owner" || !cmd || typeof cmd !== "object") return;
      if (cmd.kind === "speak") {
        // Inject the relayed sentence into the normal spoken pipeline with the
        // SENDER's resolved target preempting the local addressee stack. The
        // sender's own device already voiced it (spokenExternally).
        api.speak(cmd.sentence, { spokenExternally: true, targetId: cmd.target });
      } else if (cmd.kind === "claim" && world) {
        // The reliable-channel copy of the mesh claim — same record.
        const claims = (world.state.peerClaims ??= {});
        if (cmd.body === null) delete claims[cmd.from];
        else claims[cmd.from] = cmd.body;
      }
    },
    multiplayerRole() {
      return mp?.role ?? null;
    },
    localAddressee() {
      // The SAME stack a subject-less speak() resolves through (see speak):
      // family chip → gaze → open conversation → possessed body → nearest.
      const s = sess;
      if (!s || !world) return null;
      return resolveAddressee(null, {
        addressedFamily: s.addressedFamily,
        gaze: gazeCreature(s),
        convo: convo?.nodeId ?? null,
        possessed: possession.creatureId,
        nearest: nearestCreature(s),
      });
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
    scopeTree() {
      return sess ? walkScopeTree(scopeTreeOf(sess)) : [];
    },
    stockAudit() {
      return sess ? sessionStockAudit(sess) : {};
    },
  };
  return api;
}
