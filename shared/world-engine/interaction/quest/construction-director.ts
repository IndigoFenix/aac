// shared/world-engine/interaction/quest/construction-director.ts
//
// THE CONSTRUCTION DIRECTOR — every construction-pipeline orchestration the
// quest host used to hold inline: craft jobs (③), program fulfillment (④),
// founded/annex/demolition designations and their staging sweeps (②⑤⑥),
// build spots (⑦), zoned growth founding, and the player's order handlers
// (build/craft/annex/demolish/zone). Extracted VERBATIM from quest-host.ts
// (phase 1a of the construction rewrite — construction-structures.md): the
// host injects its services through ConstructionDirectorCtx and keeps only
// board/speech chrome; every function body below is unchanged from its
// quest-host original.
//
// ⚠️ Same main-thread constraints as quest-host (DOM/THREE via the injected
// services). Import direction: quest-host → director, never back (the only
// import from quest-host is types).

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
import { fixtureKindForWord, fixtureWord, type FixtureKind } from "../../types.js";
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
  isCraftStation,
  nextCraftKind,
  STATION_PROPERTIES,
  stationRoomKind,
  furnitureGlyph,
  furnitureKindOfGlyph,
  workProgram,
  type BuildingProgram,
  type FurnitureItemDef,
  type StationKind,
} from "@shared/world-engine/kernel/town/stations.js";
import {
  programOverridesOf,
  resolveRoomPrograms,
  roomProgramMet,
  roomProgramOf,
} from "@shared/world-engine/kernel/town/programs.js";
import {
  makePlacementContext,
  placementCandidates,
  placementFeasible,
  zoneAt as placementZoneAt,
  type AnchorMode,
  type FurniturePiece,
  type PlacementFailure,
} from "@shared/world-engine/kernel/town/placement.js";
import { houseFurniture, workFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import {
  blueprintDelta,
  blueprintSlots,
  hasDrift,
  materializedRows,
  pieceAtItsSlot,
  reconcileFurnishing,
  type BlueprintSlot,
  type FurnishTask,
} from "@shared/world-engine/kernel/town/blueprint.js";
import {
  MIN_ROOM_COSTS,
  annexCosts,
  baseRoomCosts,
  interiorCosts,
  roomOrderCosts,
  annexOptions,
  annexWorldRect,
  bankLabor,
  constructionStep,
  demolishCheck,
  demolishRoom,
  demolishedRects,
  demolitionLaborDone,
  doorlessOf,
  emptyRoom,
  foundedBuildingDone,
  foundedStage,
  hangDoor,
  markDoorless,
  pendingLaborDone,
  foundingOptions,
  interiorOptions,
  foundedProgress,
  isInteriorCandidate,
  markPieceSetUp,
  nextPlacedSerial,
  pendingRoomKindOf,
  placeFurniture,
  PROSPERITY_DAILY_CAP,
  removePlacedPiece,
  removeProgram,
  requestAnnex,
  requestInterior,
  stagingMissing,
  stowGeneratedPiece,
  TOWN_YARD_EP,
  workDeltaKey,
  type AnnexCandidate,
  type AnnexCluster,
  type BuildingDelta,
  type ConstructionOrder,
  type CraftJob,
  type FoundedBuilding,
  type FoundingCandidate,
  type InteriorCandidate,
  type PendingAnnex,
  type PendingDemolition,
  type PlacedPiece,
  type QueuedCraft,
  type RefineOrder,
  type RoomOrder,
  type TownDeltas,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  BLOCK_GLYPH,
  rawsForRefined,
  refinedGlyphOf,
  withRefinableCredit,
} from "@shared/world-engine/products.js";
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
  rankPricedSources,
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
  bodyCarryView,
  type BodyCarry,
} from "@shared/world-engine/kernel/town/scope-shape.js";
import { priceOf } from "@shared/world-engine/kernel/town/pricing.js";
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
// WHAT A SITE SAYS (construction-lines.ts): the bill, the empty stock, the mill
// covering the gap, the finished shell — each in the glyph shape that reads as
// THAT claim. Never "{material} + in + {place}", which is the locative.
import {
  needsMaterialLine,
  noSourceLine,
  structureDoneLine,
  willMakeLine,
} from "@shared/world-engine/interaction/dialogue/construction-lines.js";
import type { BuildingSpec } from "@shared/world-engine/index.js";
import {
  buildingRoomPlan,
  doorwayKeyOf,
  doorwayWorldPoint,
  doorwaysWithLeaves,
  houseIndexOfBuildingId,
  houseRoomPlan,
  livingRect,
  memberRoomOf,
  type HouseRoom,
  type HouseRoomPlan,
  type HouseShape,
  type WorkShape,
} from "@shared/world-engine/kernel/town/rooms.js";
// THE BUILDER'S PLAN (phase 6) — the unbuilt pieces of a site, laid out where
// they will stand and coloured by what is holding each one up.
import {
  freeEdgesOf,
  paintGhosts,
  shellGhostPieces,
  sharedEdgeWith,
  type GhostPiece,
  type GhostPieceState,
} from "@shared/world-engine/kernel/town/build-ghosts.js";
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
  drawnGlyph,
  makeableGlyph,
  spokenWord,
} from "@shared/world-engine/interaction/content/makeable.js";
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
import { CLOCK_SCHEDULE_RATE } from "../../npc-controller.js";
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
// WHO AUTHORED THE ORDER (player-identity.ts). Construction is authored work:
// every haul, pooled task and zoning row here carries an ISSUER, and every
// willingness question below is asked *toward that issuer*. The old singleton
// answered all three of "who ordered this", "is this thing a player" and "is
// this the local device" with one string; the two survivors are `issuer` (a
// threaded author, defaulting to this device's) and `isPlayerCid` (the
// spark-set membership test — an author has no body to put to work).
import { isPlayerCid, LOCAL_PLAYER_CID } from "./player-identity.js";
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
import { familyStateOf, type FamilyHudEntry } from "@shared/world-engine/interaction/quest/family-hud.js";
import type { ClusterHouseCtx, ConstructionSite } from "@shared/world-engine/interaction/town/town-stage.js";
import {
  buildSpots,
  spotAt,
  type BuildSpot,
  type BuildSpotBuilding,
  type BuildSpotGrowIn,
  type BuildSpotLot,
  type BuildSpotRoom,
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
import type { QuestSession, QuestBoardView, QuestHostDeps, QuestPresenter, TownPark } from "./quest-host.js";
import { constructionGameDays, serviceRadiusM } from "@shared/world-engine/scale.js";

/** Stable tiny hash — deterministic salts (same input, same value forever).
 *  Moved here from quest-host (phase 1a) so both modules share one copy. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The issuer's ATTENTION AREA around their effective position. */
export const TASK_FOCUS_RADIUS = 26;

/** A founded site pile's endpoint id prefix (pipeline ② — `sitepile:<ord>`
 *  aliases the FoundedBuilding row's live `pile`). */
export const SITE_PILE_EP = "sitepile:";
/** A pending annex's growth-rect pile (pipeline ⑤ — `annexpile:<ord>`
 *  aliases the PendingAnnex row's live `pile`). */
export const ANNEX_PILE_EP = "annexpile:";
/** A construction ORDER's material pile (phase 2 — `orderpile:<ord>`, the
 *  ONE pile endpoint every new haul targets; the legacy `sitepile:`/
 *  `annexpile:` prefixes stay resolvable for in-flight pre-phase-2
 *  agreements). */
export const ORDER_PILE_EP = "orderpile:";
/** A BUILDING's furniture-delivery pile (pipeline ⑥ — `bfurn:<deltaKey>`):
 *  where a hauled `furn.<kind>` stack lands before the placement sweep
 *  stands it up in the building's program room. Session-lived stacks (the
 *  agreement itself persists; a reload's orphan rescue re-runs the leg). */
export const BFURN_EP = "bfurn:";
/** Annex labor, RELATIVE like StructureSpec.buildDays (house = 1) — a room
 *  is half a house's raising. */
export const ANNEX_BUILD_DAYS = 0.5;
/** BUILDERS MAKE BUILDINGS (⑥): labor banks only while builders stand at
 *  the staged site — one builder works at 1× (a house = its buildDays of
 *  standing), more work proportionally faster, capped here. */
export const BUILDERS_CAP = 3;
/** "At the site" — a builder within this of the site center is working. */
export const BUILD_WORK_R = 8;
/** "At the site" — within this of the site RECT'S EDGE a builder is working.
 *  Measured from the EDGE (the furniture-use law): the old 8 m center-radius
 *  reached ~6.5 m INTO the host house from a rear annex's centre, so a
 *  "builder" idling in the kitchen banked full-rate labor. */
export const BUILD_WORK_EDGE_R = 2.5;
/** The standing-work dwell chunk the sweep keeps re-issuing (seconds). */
export const BUILD_WORK_DWELL_S = 30;
/** Demolition labor, RELATIVE like ANNEX_BUILD_DAYS — tearing a room down
 *  is half of raising one. */
export const DEMOLISH_BUILD_DAYS = 0.25;
/** A crafter within this of the bench (or craft spot) shows the work loop. */
export const CRAFT_POSE_R = 3;
/** How many make-orders may WAIT behind a house's one craft slot (phase 4 —
 *  the queue that replaced the silent drop). Finite on purpose: a queue is a
 *  promise, and a promise the house can't keep in any reasonable time is a
 *  lie — past this the order is refused ALOUD ("the list is full"). */
export const CRAFT_QUEUE_CAP = 4;
/** Seconds a delivered furniture piece lies TIPPED before it is stood up —
 *  long enough to read as "just delivered, being assembled". */
export const FURN_SETUP_HOLD_S = 3;
/** A capable resident within this of a tipped piece performs the stand-up
 *  work reach as it is set up (otherwise it simply rises on its own). */
export const FURN_SETUP_R = 3.2;
/** How far around a staked plot its haul tasks recruit (the communal
 *  work-together radius — any idle body in earshot of the site). */
export const SITE_HAUL_FOCUS_R = 60;
/** A waiting plot re-resolves its missing materials at most this often —
 *  fresh stock (a felled tree hauled to the yard) unsticks it, without
 *  re-posting expired tasks every sweep.
 *
 *  ⏸️ For the CRAFT JOB this is now the park's `staleAt`-side rate limit only —
 *  see `craftGatherParkKey` (scope-behaviors.md §2.5.1: the re-gather "re-runs
 *  `resolveMaterials` on a clock while nothing has moved"). The SITE piles
 *  still ride it as a plain gate; converting them is the same park at a third
 *  scope and wants its own pass. */
export const SITE_HAUL_RETRY_S = 20;
// ── THE BLOCK CHAIN (phase 3) ───────────────────────────────────────────
/** Street-days of milling per refined unit, RELATIVE like ANNEX_BUILD_DAYS
 *  (a block is small work — a 6-block house bill mills in ~a third of the
 *  house's own build). */
export const REFINE_UNIT_BUILD_DAYS = 0.05;
/** Milling is BENCH work — one hand, however many volunteer. The one rate
 *  function under this cap keeps the 0.8 clock parity for refines too. */
export const REFINE_CREW_CAP = 1;
/** The storehouse's raw par level, PER RAW (wood, stone): free stored
 *  units under this post ambient gather hauls from the wild — logging as
 *  a standing town activity, storehouse-fed. */
export const STOREHOUSE_RAW_PAR = 12;
/** The par-stock sweep's retry gate (seconds). */
export const STOREHOUSE_STOCK_RETRY_S = 60;


/** The host-service seam: every quest-host closure the verbatim-moved
 *  bodies still reach for. Function entries destructure under their host
 *  names so the bodies needed no edits; the four accessors at the bottom
 *  wrap host MUTABLE state (their call sites are marked "phase 1a"). */
export interface ConstructionDirectorCtx {
  presenter: QuestPresenter;
  deps: Pick<QuestHostDeps, "onSiteFounded" | "onSiteAbandoned">;
  possession: Possession;
  avatarIdOf(cid: string): string;
  npcChatBubble(session: QuestSession, cid: string, glyph: string, preText?: string): void;
  containerAnchor(session: QuestSession, id: string): { x: number; y: number } | null;
  houseContainerKeys(session: QuestSession, houseIndex: number): readonly string[];
  /** ═══ WHAT A BUILDING OWNS ═══ — the scope law as a call (scope.ts
   *  `scopeUnits`). `"stored"` is what is put away in its containers;
   *  `"anywhere"` is the whole scope, floors and hands and delivery pile
   *  included. A gate that means "have we got one" MUST ask `"anywhere"`. */
  buildingUnits(
    session: QuestSession,
    buildingKey: string,
    glyph: string,
    where: "stored" | "anywhere",
  ): number;
  stockEndpointOf(session: QuestSession, id: string): StockEndpoint | null;
  postPooledTask(session: QuestSession, goal: GoalSpec, issuer: string, focus: TaskFocus, sourceGlyph: string): void;
  playerWorldPos(session: QuestSession): { x: number; y: number } | null;
  familyOf(session: QuestSession): { house: number; mode: "some" | "all"; members: TownFamilyMember[] } | null;
  playerFocusArea(session: QuestSession): TaskFocus | null;
  issueTransferHaul(session: QuestSession, cid: string, agreementId: string): void;
  enqueueNpcErrand(session: QuestSession, npcId: string, errand: NpcErrand): void;
  townShortage(session: QuestSession, good: string): number;
  standAvoid(cid: string): BodyAvoidance;
  stackTake(map: Record<string, number>, glyph: string): boolean;
  spawnLooseProp(session: QuestSession, glyph: string, x: number, y: number): string | null;
  /** Rich host-inferred return — deliberately untyped at the seam (phase 1b re-cuts it). */
  residentTownCtx(session: QuestSession, houseIndex: number): any;
  removeLooseProp(session: QuestSession, objId: string): void;
  relationToward(session: QuestSession, cid: string, issuer: string): Relation;
  pushPocket(session: QuestSession): void;
  itemLocOf(session: QuestSession): ResolveLocation;
  issueGoalPlan(session: QuestSession, cid: string, plan: GoalPlan): void;
  handlePlaceOrder(
    session: QuestSession,
    cid: string,
    goal: Extract<GoalSpec, { kind: "place" }>,
    opts?: {
      quiet?: boolean;
      roomId?: string;
      /** The blueprint's own mark for this piece — the install lands on the
       *  outline the player has been watching, not on a fresh guess. */
      spot?: { x: number; y: number; facing: number; roomId: string };
    },
  ): "placed" | "refused" | false;
  gazeCreature(session: QuestSession): string | null;
  fireCarryGesture(npcId: string, kind: "pickup" | "putdown", at?: { x: number; y: number }): void;
  /** THE ONE WAY something enters/leaves a creature's hands (quest-host) — the
   *  object, the carry and the reach in one act. A caller that does two of the
   *  three is the bug these replaced. */
  takeIntoHands(
    session: QuestSession,
    bodyId: string,
    src:
      | { kind: "object"; objId: string }
      | { kind: "glyph"; glyph: string; at?: { x: number; y: number }; id?: string; shadow?: boolean },
    opts?: { reachAt?: { x: number; y: number } },
  ): string | null;
  setDownFromHands(
    session: QuestSession,
    bodyId: string,
    to:
      | { kind: "ground"; x: number; y: number }
      | { kind: "container"; id: string }
      | { kind: "consumed" },
    opts?: { objId?: string; reachAt?: { x: number; y: number }; quiet?: boolean },
  ): { objId: string; glyph: string | null } | null;
  /** WHAT A BODY HAS ON IT (scope-unification.md §2.1) — the object in its
   *  hands and the containers it carries or wears. There is no abstract bag to
   *  read any more, so the director asks the host what the body is really
   *  holding, and takes units off it through the one door. */
  bodyCarryOf(session: QuestSession, cid: string): BodyCarry;
  takeUnitsFromBody(
    session: QuestSession,
    cid: string,
    glyph: string,
    n: number,
    opts?: { reachAt?: { x: number; y: number } },
  ): number;
  fellIfConsumed(session: QuestSession, objId: string): void;
  dropFromStack(session: QuestSession, stack: Record<string, number>, glyph: string, x: number, y: number): string | null;
  creatureMood(cid: string): Personality;
  questViewOf(): WorldView | null;
  invalidateTownJobs(): void;
  convoNodeId(): string | null;
  spiritFocusOf(): { x: number; y: number; w: number; h: number } | null;
  /** ⏸️ THE TOWN-RUNG DEFER PARK (scope-behaviors.md §2.5.1, §7 step 6). The
   *  host owns the state (`session.townParks`) so both rungs' parks are ONE
   *  implementation — the director only names its scope and its wake. */
  parkTown(
    session: QuestSession,
    key: string,
    o: { scope: TownPark["scope"]; why: string; now: number; staleAfterS: number; dueAt?: number },
  ): void;
  townParked(session: QuestSession, key: string, now: number): boolean;
  /** ⏸️ A CONTAINER GAINED UNITS (quest-host `bumpStockEpoch`) — the wake
   *  signal both rungs' parks read. The UNOBSERVED arms credit stock too, and
   *  they must say so or the observed and unobserved economies diverge. */
  bumpStockEpoch(session: QuestSession): void;
}

/** Everything a build order enumerates against (hoisted out of the factory
 *  so the host's board/dwell signatures can name it — phase 1a). */
export interface BuildContext {
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

export function createConstructionDirector(ctx: ConstructionDirectorCtx) {
  const {
    presenter, deps, possession,
    avatarIdOf, npcChatBubble, containerAnchor, houseContainerKeys, buildingUnits,
    stockEndpointOf, postPooledTask, playerWorldPos, familyOf,
    playerFocusArea, issueTransferHaul, enqueueNpcErrand, townShortage,
    standAvoid, stackTake, spawnLooseProp, residentTownCtx, removeLooseProp,
    relationToward, pushPocket, itemLocOf, issueGoalPlan, handlePlaceOrder,
    gazeCreature, fireCarryGesture, fellIfConsumed, dropFromStack,
    takeIntoHands, setDownFromHands, bodyCarryOf, takeUnitsFromBody,
    creatureMood,
    // Host MUTABLE state, reached through accessors (the four places the
    // verbatim bodies were edited to call these are marked "phase 1a").
    questViewOf, invalidateTownJobs, convoNodeId, spiritFocusOf,
    parkTown, townParked, bumpStockEpoch,
  } = ctx;
  let world: WorldHost | null = null;
  let lastSites: ConstructionSite[] = [];
  let spotCache: { key: string; spots: BuildSpot[] } | null = null;

  // ═══════ A-craft (verbatim from quest-host.ts) ═══════
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
    for (const objId of houseContainerKeys(session, houseIndex)) {
      const stock = session.containerStock.get(objId);
      if (stock) stacks += Object.values(stock).filter((n) => n > 0).length;
    }
    signals.push({ key: "breadth", value: Math.min(1, stacks / 6) * 0.4 });
    return signals;
  }

  /** Last town-day each carpenter house crafted (construction v1). */
  const craftDayOf = new Map<number, number>();
  /** The drag-zone set last pushed to the host (diff-gated). */
  let lastDragKey = "";

  // ── CRAFT JOBS (construction pipeline ③) ──────────────────────────────
  // Furniture is MADE through the pipeline: real wood drawn from real
  // stacks (reserved, hauled when watched / moved abstractly when not),
  // then a LABOR CLOCK — cut to a third when the crafter works at a
  // standing workbench, full hand-rate without one (the bench never
  // gates; the first bench is itself hand-made). The clock is the truth;
  // a shown body walks to the bench and renders the work (the jobs law).
  // One job per house; session-lived rows (the craftDayOf pattern).
  //
  // The job carries a RECIPE, not a furniture row: furniture was the first thing
  // the pipeline made but never the only possible one, and a TOY is made exactly
  // the same way (toys-and-song-expansion.md — real cloth or wood drawn from real
  // stacks, the same labor clock, the same bench discount, the same honest wait
  // when an input is missing). Everything below this line is about gathering and
  // labor; nothing needs to know whether the output is a chair or a toy rabbit.
  // (CraftJob moved to kernel/town/construction.ts — rewrite 1b: the rows
  //  are PERSISTED on TownDeltas now, so a reload resumes the work.)

  /** How long a craft waits on an in-flight haul before assuming the load is
   *  lost and re-gathering. Generous — a carrier crossing a town legitimately
   *  takes a while — but finite, which is the whole point: the job used to wait
   *  on a vanished haul forever, and an ordered craft simply never happened.
   *
   *  ⏱️ DELIBERATELY STILL A TIMER (scope-behaviors.md §2.5.1, verbatim):
   *  "`CRAFT_HAUL_TIMEOUT_S` stays a timeout, because 'a carrier that should
   *  have arrived has not' is a statement about ELAPSED TIME AND NOTHING ELSE."
   *  There is no world condition to park on here — the wait is CORRECT while a
   *  carrier walks ("that is the NORMAL case for as long as a carrier is en
   *  route"), and what this measures is the carrier's LIVENESS, not the plan's
   *  price. Converting it would be purity, not honesty. The park-shaped branch
   *  is the other one — the re-gather; see `craftGatherParkKey`. */
  const CRAFT_HAUL_TIMEOUT_S = 90;

  /** ⏸️ The gather park's key for a house's craft job (scope-behaviors.md
   *  §2.5.1 — `{scope: "job", holder: hi}`). */
  const craftGatherParkKey = (hi: number): string => `job|${hi}`;

  /** A furniture row as a craft job recipe — the adapter that keeps the
   *  pipeline's original caller unchanged now that the job is recipe-shaped. */
  function furnitureCraftRecipe(def: FurnitureItemDef): Pick<CraftJob, "produces" | "consumes" | "at" | "label"> {
    return {
      produces: furnitureGlyph(def.kind),
      consumes: def.craft!.consumes,
      ...(def.craft!.at ? { at: def.craft!.at } : {}),
      label: def.kind,
    };
  }
  // PERSISTED ROWS (rewrite 1b): craft jobs and building furniture-delivery
  // piles live on TownDeltas — a reload RESUMES the work (agreements and
  // craftspot reservations keep their owner instead of orphaning). The
  // fallback maps only ever serve a townless session, which never persisted.
  const fallbackCraftJobs = new Map<number, CraftJob>();
  const craftJobsOf = (s: QuestSession) => s.town?.deltas.craftJobs ?? fallbackCraftJobs;
  /** THE WAITING LINE (phase 4): house index → the make-orders queued behind
   *  the one craft slot. Persisted beside the job itself, absent-tolerant, so
   *  a reload keeps the player's second and third orders. */
  const fallbackCraftQueue = new Map<number, QueuedCraft[]>();
  const craftQueueOf = (s: QuestSession) => s.town?.deltas.craftQueue ?? fallbackCraftQueue;
  const fallbackShellFurnPiles = new Map<string, Record<string, number>>();
  const shellFurnPilesOf = (s: QuestSession) =>
    s.town?.deltas.shellFurnPiles ?? fallbackShellFurnPiles;
  // (craftRetryAt retired — scope-behaviors.md §7 step 6. The 20 s re-gather
  //  clock is now a DEFER park on `session.townParks`: "the re-gather that
  //  re-runs `resolveMaterials` on a clock while nothing has moved" waits on
  //  the two things that CAN move — a container gaining units
  //  (`needsStockEpoch`) and a claim being released (`releaseEpoch`) — with the
  //  job's own labour time as the backstop.)
  /** townClock second before a house re-checks its program wants (④). */
  const programCraftAt = new Map<number, number>();
  /** townClock second a SHOWN crafter's walk to the work began — the
   *  approach time-box (cleared on arrival / job end). Session-lived. */
  const craftApproachAt = new Map<number, number>();
  /** townClock second before a STARVED craft (no reachable materials at
   *  all) speaks its shortfall again. Session-lived. */
  const craftStarvedAt = new Map<number, number>();
  /** How long a watched crafter may fail to reach the work before the
   *  embodied-anywhere rule resumes (termination over fidelity). */
  const CRAFT_APPROACH_GRACE_S = 25;
  /** taskClock second before a WORK building re-checks its program wants. */
  const shellProgramAt = new Map<string, number>();
  /** DELIVERED-FURNITURE SETUP holds (construction ⑥ visuals): key
   *  `<buildingKey>|<pieceId>` → seconds a just-placed piece stays TIPPED on
   *  its side before a resident stands it up. Session-lived (a reload just
   *  re-holds a still-tipped piece; the flag itself persists in the delta). */
  const furnitureSetupHold = new Map<string, number>();

  /** The session's room-program defs (pipeline ④): kernel defaults ⊕ the
   *  world's culture (`game.culture.architecture.rooms`). */
  function roomProgramDefsOf(session: QuestSession) {
    return resolveRoomPrograms(programOverridesOf(session.town?.config.architecture));
  }

  /**
   * ONE GATE FOR EVERY CONSTRUCTION UTTERANCE: speak a leveled line as `cid`'s
   * bubble, at the session's syntax level.
   *
   * Two conditions. The body must be REGISTERED as a creature — an abstract twin
   * has no mouth. And `shown` is the CALLER's own observability judgement: a
   * house sweep already knows whether it is watched, and an unwatched site
   * talking to nobody is not silence-must-be-explicit, it is noise (the toast
   * already carries the fact to the HUD). A caller that speaks through a body it
   * just found STANDING at the work passes `true` — that body is observable by
   * construction.
   */
  function speakLine(
    session: QuestSession,
    cid: string,
    line: LeveledGlyphs,
    shown: boolean,
  ): void {
    if (!shown || !session.creatures?.nodeByCreature.has(cid)) return;
    npcChatBubble(session, cid, line[session.game.meta.syntax ?? "b"]);
  }

  /** Units of `glyph` PUT AWAY in a house's containers — the narrow reading, and
   *  the one `reconcileFurnishing`'s budget wants (it is handed the loose pieces
   *  separately, as `standing`). Ask `houseHolds` when the question is "have we
   *  got one at all". */
  function houseStored(session: QuestSession, hi: number, glyph: string): number {
    return buildingUnits(session, `h_${hi}`, glyph, "stored");
  }

  /**
   * ═══ HAS THIS HOUSEHOLD GOT ONE ═══ — the whole scope, which is the question
   * every "do we need to make one" gate has always meant and never asked.
   *
   * A piece lying on the floor of the room, riding in a resident's hands or
   * sitting in the building's delivery pile is a piece the household OWNS. The
   * old reading (`furn_<hi>_*` container stacks only) said no to all three, so a
   * family with three workbenches on its kitchen floor kept making a fourth —
   * bench-first is a bootstrap, and a bootstrap that cannot see its own output
   * never terminates (observed live 2026-08-05).
   */
  function houseHolds(session: QuestSession, hi: number, glyph: string): number {
    return buildingUnits(session, `h_${hi}`, glyph, "anywhere");
  }

  /** Where a house crafts — THE SPOT FOLLOWS THE BENCH (phase 4 step 3).
   *  The crafter's POSE has always been the workbench (stepCraftJob's
   *  `crafterWorkAt`), while the spot keyed off `annexes` alone: the inputs
   *  were hauled to the kitchen cupboard while the body stood at the
   *  living-room bench, and the two disagreed for the whole job. With a
   *  bench standing (generated ⊕ placed, anywhere) the spot is the house
   *  CONTAINER nearest it, its own room preferred. Benchless it falls back
   *  to the workshop annex's woodstore, else the communal cupboard (any
   *  house can craft — the bench only speeds). */
  function craftSpotOf(session: QuestSession, hi: number): string {
    const t = session.town;
    const key = `h_${hi}`;
    const bench = houseBench(session, hi);
    const house = t?.plan.houses.find((h) => h.index === hi);
    if (t && bench && house) {
      const rooms = houseRoomPlan(t.stage.center, house, t.deltas.get(key)).rooms;
      const inRect = (
        r: { rect: { x: number; y: number; w: number; h: number } },
        x: number,
        y: number,
      ) => x >= r.rect.x && x <= r.rect.x + r.rect.w && y >= r.rect.y && y <= r.rect.y + r.rect.h;
      const benchRoom = rooms.find((r) => inRect(r, bench.x, bench.y));
      let best: { id: string; d: number; same: boolean } | null = null;
      // The house's OWN containers, read off its furniture — not off
      // containerStock, whose keys only exist once something has been put
      // in a box (a fresh workshop's empty woodstore has no row yet, and
      // that is precisely the box the bench wants).
      for (const p of buildingFurnitureOf(session, key)) {
        if (!p.openable && !session.containerStock.has(p.id)) continue;
        // Economy-driven stacks are never a workbench's bin (the same
        // exclusion craftMaterialSources draws).
        if (session.marketStore.has(p.id) || session.produceBox.has(p.id)) continue;
        const same = !!benchRoom && inRect(benchRoom, p.x, p.y);
        const d = Math.hypot(p.x - bench.x, p.y - bench.y);
        const better =
          !best ||
          (same !== best.same
            ? same
            : d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && p.id < best.id));
        if (better) best = { id: p.id, d, same };
      }
      if (best) return best.id;
    }
    const hasWorkshop = t?.deltas.get(key)?.annexes.some((a) => a.cluster === "workshop") ?? false;
    return hasWorkshop ? `furn_${hi}_woodstore` : `furn_${hi}_cupboard`;
  }

  /** POP the head of a house's make-order queue into the free craft slot
   *  (phase 4 step 5). The queued row is deliberately SPOT-LESS: the job is
   *  built HERE, so its spot follows the bench standing at this moment and
   *  no stale reservation ever rides the wait. Returns whether a job
   *  started (the caller's precedence: queue, then programs, then the
   *  workshop rotation). */
  function popQueuedCraft(session: QuestSession, hi: number): boolean {
    const queue = craftQueueOf(session);
    const q = queue.get(hi);
    const next = q?.shift();
    if (q && !q.length) queue.delete(hi);
    if (!next) return false;
    craftJobsOf(session).set(hi, {
      ...next,
      spotId: craftSpotOf(session, hi),
      agreements: [],
      laborS: 0,
    });
    presenter.toast(`🔨 making the ${next.label} now — its turn came`, "feedback");
    return true;
  }

  /**
   * MAKE WHAT THE DRAWING HAS NO PIECE FOR (pipeline ④, re-cut onto the
   * blueprint). The work list already knows the difference between the four
   * ways an empty slot gets filled; only ONE of them is a craft, and it is the
   * last resort:
   *
   *   "A HOUSE DOES NOT COMMISSION A SECOND BED WHILE THE FIRST STANDS IN THE
   *   HALL." A piece already in the house that is merely standing in the wrong
   *   place is AVAILABLE (reconcileFurnishing answers `move`), and one in a box
   *   is an install. Neither reaches this function. The old code asked "is a
   *   piece of this kind standing in the room that wants it" and crafted
   *   whenever the answer was no, which minted a duplicate every time a room
   *   commit shuffled the layout.
   *
   * AUTOMATION IS BENCH-FIRST (the law): a benchless house crafts the workbench
   * before the wanted piece. Non-craftable stations (oven, toilet) arrive with
   * their room's own generation, so they are skipped rather than stopping the
   * scan — the next want may well be makeable.
   *
   * 🚨 BENCH-FIRST ASKS THE SCOPE, NOT THE BOXES (`houseHolds`). A bootstrap
   * that cannot see its own output is a loop: the finished bench lands as a
   * PROP on the floor (a shown house's craft arrival), which left no unit in any
   * container, so the next sweep found the house benchless and made another one
   * — four on the kitchen floor and a fifth under way, 4 blocks apiece
   * (2026-08-05). Owning a bench and having stood it up are different facts, and
   * only the second one is `houseBench`.
   */
  function startProgramCraft(session: QuestSession, hi: number) {
    if (!session.town) return;
    const want = buildingFurnishTasks(session, `h_${hi}`).find(
      (q) => q.act === "make" && !!furnitureItemOf(q.kind)?.craft,
    );
    if (!want) return;
    const fdef = furnitureItemOf(want.kind)!;
    const target =
      houseBench(session, hi) || houseHolds(session, hi, furnitureGlyph("workbench")) > 0
        ? fdef
        : furnitureItemOf("workbench")!;
    craftJobsOf(session).set(hi, {
      ...furnitureCraftRecipe(target),
      spotId: craftSpotOf(session, hi),
      agreements: [],
      laborS: 0,
    });
  }

  /** Next town-clock second each house may attempt a program-fulfillment
   *  install (rate limit — a refusal must not spin every sweep). */
  const programFurnishAt = new Map<number, number>();
  /**
   * PROGRAM FULFILLMENT'S INSTALL HALF (④) — stand up a STORED piece that an
   * unmet ordered room's program requires. `startProgramCraft` makes the
   * missing piece and stops the moment a unit is stored, on the promise that
   * something "stands it up" — this sweep IS that something. Without it the
   * chain dangles: the room orders a bed, the bed is crafted, the bed sits in
   * the woodstore forever, the room never fulfills (observed live: "furniture
   * items in boxes", 2026-07-29).
   *
   * NOT the old blanket auto-place (removed by user law: placing is a creature
   * act, a household must not silently rearrange itself). This installs ONLY a
   * kind an unmet program row calls for, into the room that wants it, and the
   * act is a RESIDENT'S errand end to end — handlePlaceOrder walks the body to
   * the storage box, then the spot, and the piece lands tipped (setUp:false)
   * for the stand-up sweep, exactly as a spoken order would. A refusal is
   * logged (never silent) and backed off, not retried forever.
   */
  function stepStoredProgramFurnish(session: QuestSession, hi: number) {
    const t = session.town;
    if (!t || !world) return;
    if (session.townClock < (programFurnishAt.get(hi) ?? 0)) return;
    const key = `h_${hi}`;
    const delta = t.deltas.get(key);
    const house = t.plan.houses.find((h) => h.index === hi);
    if (!house) return;
    // Nothing ordered, nothing adrift and no tool waiting for its place.
    if (!delta?.programs?.length && !hasDrift(delta) && !ownedStationKinds(session, key).length) {
      return;
    }
    // Needs a body home to do the placing (the auto-place guard).
    const cid = `resident_${hi}_0`;
    if (!world.state.avatars[avatarIdOf(cid)]) return;
    const hp = houseRoomPlan(t.stage.center, house, delta);
    // ⚰️ THE HARD-CODED BENCH BRANCH IS GONE (2026-08-05). It used to stand a
    // stored workbench up here by name, searching workshop → store → living for
    // a spot of its own — and it was the only kind that got that service, it
    // could only see a unit sitting in a BOX (never the far commoner case, the
    // one the craft had just dropped on the floor), and the spot it chose was on
    // no blueprint slot, so `stepStrayBumps` was entitled to take the bench
    // apart again the moment somebody pressed against it. Observed live: stood
    // up at t=761, deconstructed at t=771, benchless again at t=772.
    //
    // The drawing now has a PLACE for a tool the household owns (layer 3), so
    // the bench arrives here as an ordinary `install` — same sweep, same
    // outline, same pinned spot as a bed, and safe from the bump rule because it
    // is standing where the drawing says it belongs. The room preference did not
    // die with it: it moved into the layer that draws the place, which is where
    // a fact about where benches belong should have lived all along.
    //
    // THE DRAWING NAMES THE SPOT. An install is not "find somewhere this fits
    // in the right room" any more — the blueprint already chose the spot, an
    // outline has been standing on it, and the piece lands exactly there. That
    // is the difference between a promise and a coincidence.
    const task = buildingFurnishTasks(session, key).find((q) => q.act === "install");
    if (!task?.slot) return;
    const room = hp.rooms.find((r) => r.id === task.slot!.roomId);
    programFurnishAt.set(hi, session.townClock + 45);
    const res = handlePlaceOrder(
      session,
      cid,
      { kind: "place", item: { match: { kind: task.kind } }, at: { relation: "in", anchor: { kind: "home" } } },
      { quiet: true, roomId: task.slot.roomId, spot: task.slot },
    );
    if (res === "placed") {
      presenter.toast(`🪑 the ${task.kind} is set up for the ${room?.kind ?? "room"}`, "feedback");
    }
  }

  /** The house's standing WORKBENCH (generated pieces minus removals, plus
   *  placed deltas) — presence picks the labor rate; its spot is where the
   *  crafter stands to work. */
  function houseBench(session: QuestSession, hi: number): { x: number; y: number } | null {
    const t = session.town;
    const house = t?.plan.houses.find((h) => h.index === hi);
    if (!t || !house) return null;
    const goodDefs = t.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    for (const p of houseFurniture(t.stage.center, house, goodDefs, "", t.deltas.get(`h_${hi}`))) {
      if (p.kind === "workbench") return { x: p.x, y: p.y };
    }
    return null;
  }

  /** Material sources a HOUSE's craft may draw on: every container stack
   *  its members may use (their own boxes, communal crates, the yard, wild
   *  features), nearest the craft spot first BY STREET (`sourceDistanceM` —
   *  the same geometry the site walk uses; §2.2). */
  function craftMaterialSources(
    session: QuestSession,
    hi: number,
    destAt: { x: number; y: number },
    excludeId: string,
  ): TransferSource[] {
    const member = `resident_${hi}_0`;
    const sources: TransferSource[] = [];
    for (const [boxId, stack] of session.containerStock) {
      if (boxId === excludeId) continue;
      if (session.marketStore.has(boxId) || session.produceBox.has(boxId) || boxId.startsWith("trade:")) continue;
      if (!mayUse(member, hi, session.containerOwner.get(boxId))) continue;
      const at = containerAnchor(session, boxId);
      if (!at) continue;
      sources.push({ id: boxId, stack, d: sourceDistanceM(session, destAt, at) });
    }
    return sources;
  }

  /** The labour clock this job WILL be stamped with when it starts. ONE
   *  definition: START stamps it, and the gather park uses it as its `staleAt`
   *  (§2.5.1: "`staleAt` = the job's own expected labour time, which is already
   *  computed"). */
  function craftLabourSecondsOf(session: QuestSession, hi: number, job: CraftJob): number {
    return (
      constructionGameDays(craftLaborDaysFor(job.at, !!houseBench(session, hi)), session.scale) *
      session.scale.dayLengthS
    );
  }

  /** Advance one house's craft job: gather (resolve + haul or the abstract
   *  twin), start labor when the spot covers the bill, finish on the clock. */
  function stepCraftJob(session: QuestSession, hi: number, job: CraftJob, isShown: boolean) {
    const t = session.town;
    if (!t || !world) return;
    // SOMEBODY HAS TO BE THERE TO MAKE IT (user law, 2026-07-28) — a craft works
    // like a construction: labour needs a labourer. Without this the clock alone
    // finished the piece, so unwatched houses across the whole town minted
    // furniture out of an empty room, and the crafter's presence was decorative.
    //
    // Gathering may proceed regardless (hauls are their own agreements with
    // their own bodies); it is the WORK that requires the crafter to be loaded.
    // A job whose crafter walks away simply pauses and resumes when they return,
    // which is why the labour clock is advanced by elapsed time rather than
    // stamped once — see the `laborStart` shift below.
    // VISIBLE work renders its cause (the observation law): a WATCHED craft
    // advances only while the crafter stands at the work (the build sites'
    // presence rule); an unwatched house keeps the abstract embodied-anywhere
    // twin — else far crafts would stall for bodies that never walk benches.
    const crafterBody = world.state.avatars[avatarIdOf(`resident_${hi}_0`)];
    const crafterWorkAt = houseBench(session, hi) ?? containerAnchor(session, job.spotId);
    let atWork =
      !isShown ||
      !crafterWorkAt ||
      (!!crafterBody &&
        Math.hypot(crafterBody.x - crafterWorkAt.x, crafterBody.y - crafterWorkAt.y) <= CRAFT_POSE_R);
    if (!atWork && crafterBody) {
      // TERMINATION OVER FIDELITY: a bench standing in a crowded corner can
      // be genuinely unreachable within the pose radius — the approach is
      // time-boxed, then the embodied-anywhere rule resumes so a craft can
      // NEVER wedge (a stuck job row silently blocked every future order:
      // "already making something" with nobody visibly making anything).
      const since = craftApproachAt.get(hi) ?? session.townClock;
      craftApproachAt.set(hi, since);
      if (session.townClock - since > CRAFT_APPROACH_GRACE_S) atWork = true;
    } else {
      craftApproachAt.delete(hi);
    }
    const crafterHome = !!crafterBody && atWork;
    /** Send a SHOWN, idle crafter to stand at the work (re-issued whenever
     *  they idle off-spot — the walk the at-the-bench gate waits on). */
    const walkCrafterToWork = (): void => {
      if (!isShown || !crafterBody || !crafterWorkAt || !world) return;
      const npcId = avatarIdOf(`resident_${hi}_0`);
      if (session.transfers.executing(`resident_${hi}_0`)) return; // hauling first
      if (world.npcErrandActive(npcId) || (session.npcTasks.get(npcId)?.length ?? 0)) return;
      const standAt = nearestClearSpot(
        world.state,
        crafterWorkAt,
        { x: crafterBody.x, y: crafterBody.y },
        world.npcRadiusOf(npcId),
        standAvoid(`resident_${hi}_0`),
      );
      enqueueNpcErrand(session, npcId, {
        points: [{ x: standAt.x, y: standAt.y, dwell: 30 }],
      });
    };
    // Dead hauls drop their spoken-for units and their rows. A DELIVERED
    // haul's units are already reserved on the spot under this job — the
    // unload seam did it the instant they landed (onTransferLanded; ⑥ —
    // inputs in transit are spoken for END TO END: civic resolution must
    // never read a craft spot's gathered wood as free supply, not even for
    // one tick).
    const spotHolder = `craftspot:${hi}`;
    const spot = session.containerStock.get(job.spotId) ?? {};
    session.containerStock.set(job.spotId, spot);
    const consumes = job.consumes;
    const member = `resident_${hi}_0`;
    // Units this job has already banked ON the spot (its own reservations).
    const ownReserved = (head: string): number => {
      let n = 0;
      for (const r of session.reservations.holderRows(spotHolder)) {
        if (r.endpoint === job.spotId && r.glyph === head) n += r.qty;
      }
      return n;
    };
    job.agreements = job.agreements.filter((id) => {
      const a = session.transfers.get(id);
      if (!a || a.status === "done" || a.status === "failed") {
        // A delivered haul's units were reserved AT LANDING (onTransferLanded,
        // the unload seam) — "done" needs no bookkeeping here. Releasing the
        // agreement's own holder only drops SOURCE-side leftovers (a partial
        // load). Measuring the stack after the fact is exactly the gap the
        // famine race lived in: everything between landing and this tick was
        // free supply any resolver could legally drain.
        session.reservations.release(agrHolder(id));
        return false;
      }
      return true;
    });
    if (job.laborStart === undefined) {
      // ONE SHORTFALL, TWO QUESTIONS. "What do I still need to fetch?" and "can
      // I start?" used to be computed separately — gather counted in-flight
      // hauls as covering the bill, START counted only what was physically on
      // the spot. When a haul went missing between them the job wedged: gather
      // saw nothing to fetch, START saw nothing to use, and neither branch could
      // move. They now share this function, so they can never disagree.
      const shortfallOf = (countLive: boolean): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const [g, n] of Object.entries(consumes)) {
          const head = stackHead(g);
          // Someone ELSE's claim on this spot is untouchable (the one-
          // reservation law); our own banked units are exactly what we consume.
          const othersReserved = Math.max(
            0,
            session.reservations.reservedUnits(job.spotId, head) - ownReserved(head),
          );
          let have = Math.max(0, stackUnits(spot, head) - othersReserved);
          if (countLive) {
            for (const id of job.agreements) {
              const a = session.transfers.get(id);
              if (a && (a.status === "pending" || a.status === "moving")) {
                have += stackUnits(a.goods, head);
              }
            }
          }
          if (n > have) out[head] = n - have;
        }
        return out;
      };
      // What is missing REGARDLESS of hauls in flight — the START gate.
      const shortNow = shortfallOf(false);
      // What is missing once live hauls land — what still needs FETCHING.
      let missing = shortfallOf(true);
      if (!Object.keys(shortNow).length) {
        job.waitingSince = undefined; // covered — fall through to START
      } else if (!Object.keys(missing).length) {
        // Nothing to fetch, yet nothing usable on the spot: hauls are walking.
        // That is the NORMAL case for as long as a carrier is en route, so it
        // must not cancel them — but it is also exactly the state the job used
        // to wedge in forever when a haul was lost. Time-box it: wait, and only
        // if the wait outlives any plausible walk do we assume the load is gone,
        // drop the rows and re-gather from scratch.
        job.waitingSince ??= session.townClock;
        if (session.townClock - job.waitingSince < CRAFT_HAUL_TIMEOUT_S) return;
        for (const id of job.agreements) session.reservations.release(agrHolder(id));
        job.agreements = [];
        job.waitingSince = undefined;
        session.townParks.delete(craftGatherParkKey(hi)); // the load is gone — gather afresh
        missing = shortfallOf(true); // re-measure with the dead rows gone
      } else {
        job.waitingSince = undefined; // there is real fetching to do
      }
      if (Object.keys(shortNow).length) {
        // ⏸️ THE GATHER PARK (scope-behaviors.md §2.5.1, §7 step 6). What stood
        // here was `craftRetryAt` + SITE_HAUL_RETRY_S: a 20 s stopwatch that
        // re-ran the whole source walk "while nothing has moved". The park says
        // the same thing honestly — a re-gather is worth doing exactly when a
        // source could now offer a material this job is short of, and there are
        // only two events that make that true: a container GAINED units
        // (`needsStockEpoch`) or a claim was RELEASED, freeing units somebody
        // else had spoken for (`releaseEpoch`). Backstop = the job's own labour
        // time, so a missed bump costs one piece's worth of waiting at most.
        if (townParked(session, craftGatherParkKey(hi), session.townClock)) return;
        const anchor = containerAnchor(session, job.spotId);
        if (!anchor) {
          return;
        }
        const tmp = `craft:${hi}`;
        const sources = craftMaterialSources(session, hi, anchor, job.spotId);
        const { draws } = resolveMaterials({
          holder: tmp,
          costs: missing,
          sources,
          ledger: session.reservations,
        });
        if (!draws.length) {
          // ⏸️ NOTHING TO DRAW — the walk found no free units for any short
          // head. Re-walking is worth exactly as much as the world has moved,
          // so park on the two events that can move it. (A resolve that DID
          // find draws changes the world itself and never parks: the next
          // sweep is measuring a different town.)
          parkTown(session, craftGatherParkKey(hi), {
            scope: "job",
            why: `no free source offers ${Object.keys(missing).join(", ") || "the bill"}`,
            now: session.townClock,
            staleAfterS: craftLabourSecondsOf(session, hi, job),
          });
        }
        if (!draws.length && !job.agreements.length) {
          // STARVED, not waiting (the site piles' rule, applied to the
          // bench): the recipe's bill is known and NOTHING reachable covers
          // any of it. The job holds its slot honestly — but it must SAY so,
          // or "already making something" reads as a stall with nobody
          // making anything (the field report). Rate-limited well below the
          // 20 s re-resolve so it reminds rather than nags.
          // THE CHAIN (phase 3): a refinable bill (the bed's blocks) posts
          // a refine order first — the mill fills it, the next re-resolve
          // finds the blocks. Only chain-less heads toast the shortage.
          session.reservations.release(tmp);
          const { milling, rest } = ensureRefineOrders(session, missing);
          if (session.townClock >= (craftStarvedAt.get(hi) ?? 0)) {
            craftStarvedAt.set(hi, session.townClock + 90);
            if (Object.keys(rest).length) {
              const bill = Object.entries(rest)
                .map(([g, n]) => `${n} ${g}`)
                .join(", ");
              presenter.toast(
                `🪵 making the ${job.label} needs ${bill} — and there is none to fetch`,
                "feedback",
              );
              // …and the CRAFTER SAYS IT (silence must be explicit). The toast
              // is the HUD's channel; a child reading glyphs needs the fact in
              // the world, from the body it belongs to. THIS branch's fact is
              // emptiness — the bill is known and no chain can reach it — so the
              // line is the town's, not the piece's: "we don't have blocks".
              const dry = Object.keys(rest)[0];
              if (dry) speakLine(session, member, noSourceLine(stackHead(dry)), isShown);
            } else if (milling > 0) {
              presenter.toast(
                `🪚 milling ${milling} ${BLOCK_GLYPH} for the ${job.label}`,
                "feedback",
              );
              speakLine(session, member, willMakeLine(BLOCK_GLYPH, milling > 1), isShown);
            }
          }
          return;
        }
        craftStarvedAt.delete(hi);
        // One visible haul per body — the member carries the first draw when
        // the house is watched; everything else moves as the abstract twin.
        let carrierFree =
          isShown &&
          !!world.state.avatars[avatarIdOf(member)] &&
          !session.transfers.executing(member) &&
          !!stockEndpointOf(session, job.spotId)?.at;
        for (const d of draws) {
          if (carrierFree && stockEndpointOf(session, d.endpoint)?.at) {
            const a = session.transfers.post({
              from: d.endpoint,
              to: job.spotId,
              goods: { [d.glyph]: d.take },
              issuer: member,
              mode: "haul",
              now: session.taskClock,
              sourceGlyph: `craft:${job.label}`,
            });
            session.reservations.reserve(agrHolder(a.id), d.endpoint, d.glyph, d.take);
            job.agreements.push(a.id);
            if (session.transfers.begin(a.id, member)) issueTransferHaul(session, member, a.id);
            carrierFree = false;
          } else {
            // THE ABSTRACT TWIN: the hidden house draws the same units from
            // the same stacks, instantly — conservation and coincidence.
            const src = session.containerStock.get(d.endpoint);
            if (src) {
              const taken = takeStock(src, d.glyph, d.take);
              for (const [g, c] of Object.entries(taken)) {
                spot[g] = (spot[g] ?? 0) + c;
                // Landed inputs stay SPOKEN FOR on the spot (⑥) — never
                // free supply for civic resolution mid-craft.
                session.reservations.reserve(spotHolder, job.spotId, stackHead(g), c);
              }
              // ⏸️ TWIN PARITY: the watched arm's unload bumps the stock epoch
              // at the seam; the instant draw is the same fact, unobserved.
              if (Object.keys(taken).length) bumpStockEpoch(session);
              fellIfConsumed(session, d.endpoint); // a drained kill-source fells
            }
          }
        }
        session.reservations.release(tmp);
        return;
      }
      // START — deduct the inputs, stamp the labor clock at the going rate.
      // OTHERS' reserved units are untouchable (⑥ — the one-reservation
      // law): a civic haul that has spoken for wood ON THIS SPOT must find
      // it when its hauler arrives. The job's OWN banked inputs (the
      // craftspot holder) are exactly what it consumes now.
      // `shortNow` above ALREADY applied this exact rule (it is the same
      // `shortfallOf(false)`), and we only reach here when it was empty — so
      // there is no second, divergent gate to wedge against. Re-checking here is
      // what let the two answers drift apart in the first place.
      // THE INGREDIENTS ARE NOT CONSUMED YET — they stay on the spot, RESERVED
      // to this job, and are consumed at the same instant the product appears
      // (`craftItems`, below). A craft used to eat its materials here and mint
      // the product a labour-day later, so anything that ended the job in
      // between — a reload, an abandoned house — destroyed them with nothing to
      // show. "Transforming into a craft is an atomic function that creates an
      // item at the same time it consumes its ingredients" (user law). The
      // reservation is what keeps them safe from other takers during the work.
      if (!crafterHome) {
        walkCrafterToWork(); // a shown crafter is SENT to the bench first
        return; // nobody at the work yet — the bill waits, reserved
      }
      const bench = houseBench(session, hi);
      // Craft labor in THE SESSION'S OWN DAY × the construction scale — the
      // hardcoded food-day ignored scale.construction entirely (the build
      // sites' unit law, applied to the bench).
      job.laborS = craftLabourSecondsOf(session, hi, job);
      job.laborStart = session.townClock;
      // A shown crafter walks to the bench (or the store) and DWELLS there
      // for the labor — the body renders the work; the clock stays the
      // truth either way.
      if (isShown) {
        const body = world.state.avatars[avatarIdOf(member)];
        const raw = bench ?? containerAnchor(session, job.spotId);
        if (body && raw && !session.transfers.executing(member)) {
          // THE SAME REACH LAW the haul needed: a workbench and a cupboard are
          // both solid, so their centres are not standable. Sent to one raw, the
          // crafter halts against the face and the leg never arrives — which
          // leaves the body parked on an errand it can never finish, looking
          // exactly like "it just stood there". The labor CLOCK is unaffected
          // (it is the truth either way), so this only ever cost the visible
          // work — but it cost the body's task queue too.
          const standAt = nearestClearSpot(
            world.state,
            raw,
            { x: body.x, y: body.y },
            world.npcRadiusOf(avatarIdOf(member)),
            standAvoid(member),
          );
          enqueueNpcErrand(session, avatarIdOf(member), {
            points: [{ x: standAt.x, y: standAt.y, dwell: job.laborS }],
          });
        }
      }
      return;
    }
    // WORK ONLY ADVANCES WHILE THE CRAFTER IS THERE. Push the finish line out by
    // however long they were away, so a job doesn't silently complete because
    // wall-clock passed while the house stood empty. (The alternative — failing
    // the job — would punish a resident for going to eat.)
    if (!crafterHome) {
      job.laborStart += Math.max(0, session.townClock - (job.lastWorkedAt ?? session.townClock));
      job.lastWorkedAt = session.townClock;
      walkCrafterToWork(); // pulled away mid-work — come back to the bench
      return;
    }
    job.lastWorkedAt = session.townClock;
    // The CRAFT LOOP animation (the build loop's twin): while the crafter
    // stands at the work, hold the sustained "play" rig — crouched over
    // the bench, hands working the piece. Refreshed each step; it expires
    // on its own the moment the job finishes or the crafter walks off.
    if (isShown) {
      const body = world.state.avatars[avatarIdOf(member)];
      const raw = houseBench(session, hi) ?? containerAnchor(session, job.spotId);
      if (body && raw && Math.hypot(body.x - raw.x, body.y - raw.y) <= CRAFT_POSE_R) {
        session.needPoseShow.set(avatarIdOf(member), { t: 3, kind: "play" });
      }
    }
    // WORK → DONE on the clock: ONE transaction turns the ingredients into the
    // piece. Either both happen or neither does.
    if (session.townClock >= job.laborStart + job.laborS) {
      session.reservations.release(spotHolder); // our own claim must not block us
      const made = craftItems(
        itemLocOf(session),
        { kind: "container", id: job.spotId },
        job.consumes,
        job.produces,
      );
      if (!made.ok) {
        // The materials went somewhere during the work (a raided spot). Nothing
        // was consumed and nothing was made — re-gather rather than silently
        // producing from nothing.
        job.laborStart = undefined;
        job.waitingSince = undefined;
        session.townParks.delete(craftGatherParkKey(hi)); // the spot was raided — gather afresh
        return;
      }
      craftJobsOf(session).delete(hi);
      craftApproachAt.delete(hi); // the approach box dies with its job
      // …AND IT HAS TO ARRIVE AS A THING.
      //
      // MAKING SOMETHING ALWAYS PRODUCES AN ITEM (user law, 2026-07-28) — and
      // that holds for FURNITURE too. A piece with nowhere to stand is not a
      // failed craft: it is a chair lying in the room. It exists, it can be
      // picked up and carried, it does NOT block movement and it cannot be used,
      // because it is an object rather than a fixture — and PLACING it is a
      // separate act a creature performs later, never an automatic consequence
      // of making it.
      //
      // The stack deposit above is the CONSERVING half and always runs: it keeps
      // an off-screen house's books straight, and it is the "stowed" state. But a
      // stack unit inside a lidded chest is invisible — container contents only
      // render for pass-through ("on") surfaces — so on its own the deposit means
      // a craft completes and nothing whatever appears, which is the bug this
      // replaces. When the house is on screen the unit becomes a real prop by the
      // bench, which is where a just-finished thing would actually be.
      const raw = houseBench(session, hi) ?? containerAnchor(session, job.spotId);
      if (isShown && raw) {
        // ON the floor beside the bench, not INSIDE it. The bench/cupboard
        // coordinate is a fixture CENTRE, so spawning there buries the finished
        // thing in the furniture mesh — the same raw-centre trap the walk legs
        // had, in its cosmetic form. `nearestClearSpot` puts it on real floor.
        //
        // `dropFromStack` MOVES the unit out of the spot into a prop: if the prop
        // can't be made it stays stowed, and it can never be in both places.
        const body = world.state.avatars[avatarIdOf(`resident_${hi}_0`)];
        const at = nearestClearSpot(world.state, raw, body ? { x: body.x, y: body.y } : raw);
        dropFromStack(session, spot, job.produces, at.x, at.y);
      }
    }
  }

  /**
   * CONSTRUCTION HOUSEKEEPING (construction v1 §6) — two ambient loops:
   *   craft   a WORKSHOP house turns wood into one furniture stack a day
   *           (the carpenter's supply — wood restocks off-screen; the
   *           economy is quantity-only, no coins change hands),
   *   clutter unplaced stacks in a store/workshop room SLOW the room
   *           (the engine drag seam) without ever blocking it.
   *
   * The third loop, PLACE, is gone (2026-07-28): installing furniture is a
   * creature's own act, never an automatic consequence of it existing. A
   * finished piece is an ITEM the moment it is made; a spoken "put the chair
   * here" is now the only route by which one gets stood up.
   */
  function stepConstructionHousekeeping(session: QuestSession, shown: (hi: number) => boolean) {
    const t = session.town;
    if (!t || !world) return;
    const day = Math.floor(session.townClock / FOOD_DAY_SEC);
    for (const house of t.plan.houses) {
      const hi = house.index;
      const delta = t.deltas.get(`h_${hi}`);
      const hasWorkshop = delta?.annexes.some((a) => a.cluster === "workshop") ?? false;
      // CRAFT (pipeline ③): one job at a time — advance the active one, or
      // start the day's next want. A benchless crafter makes the WORKBENCH
      // first, by hand. No off-screen restock anymore: no free wood ⇒ the
      // job honestly waits, and fresh stock unsticks it.
      const job = craftJobsOf(session).get(hi);
      if (job) {
        stepCraftJob(session, hi, job, shown(hi));
      } else if (!popQueuedCraft(session, hi)) {
        // THE PLAYER'S OWN WAITING LINE COMES FIRST (phase 4 step 5): a
        // spoken make-order that found the slot busy is a standing promise —
        // nothing the house wants for itself may cut in front of it. Only an
        // EMPTY queue falls through to the house's own wants below.
        //
        // PROGRAM FULFILLMENT (④) OUTRANKS THE RESTOCK ROTATION: the one
        // job slot used to go to the workshop's daily sale-stock craft
        // first, so an ordered room's want could be starved every day edge
        // (observed: bench installed → rotation minted ANOTHER bench for
        // stock → the bedroom's bed never started). A standing player want
        // is never outqueued by inventory.
        if (session.townClock >= (programCraftAt.get(hi) ?? 0)) {
          programCraftAt.set(hi, session.townClock + 90);
          startProgramCraft(session, hi);
        }
        if (!craftJobsOf(session).get(hi) && hasWorkshop && (craftDayOf.get(hi) ?? -1) !== day) {
          craftDayOf.set(hi, day);
          const def = nextCraftKind({
            day,
            salt: hi,
            hasBench: !!houseBench(session, hi),
            // THE SCOPE, not the boxes: the rotation's two gates are "do we
            // already own a bench" and "are there two of this kind about", and
            // a unit lying on the workshop floor answers yes to both. Reading
            // containers alone had the carpenter restocking what was already
            // in front of him.
            stored: (glyph) => houseHolds(session, hi, glyph),
          });
          if (def) {
            craftJobsOf(session).set(hi, {
              ...furnitureCraftRecipe(def),
              spotId: craftSpotOf(session, hi),
              agreements: [],
              laborS: 0,
            });
          }
        }
      }
      // BLANKET AUTO-PLACE STAYS GONE (user law, 2026-07-28: "Placing furniture
      // is a separate action, performed by a creature — not automatically"). The
      // old sweep stood ANY stored piece up anywhere it fit — a household
      // silently rearranging itself with nobody deciding to — and every refusal
      // ran silent under `quiet: true`, so a house with no free wall retried
      // forever and nothing reported why. A finished piece is an ITEM at the
      // moment it is made (stepCraftJob), visible and carryable, and the SPOKEN
      // order ("put the chair here") is how a player directs placement.
      //
      // THE ONE EXCEPTION (user refinement, 2026-07-29: "newly constructed
      // furniture should be set up in its correct spot if one is missing"): a
      // stored piece an UNMET ordered-room program requires is installed by a
      // resident's own errand — restoring the house to its declared program is
      // not rearranging it, and startProgramCraft's chain dangled without this
      // (it crafts the piece, then skips forever once a unit is stored).
      stepStoredProgramFurnish(session, hi);
      // AND THE HOUSE TIDIES ITSELF UP — but by WALKING, one piece at a time.
      // Adding a room re-draws where everything belongs; this is the half that
      // carries the furniture there (blueprint.ts — the blueprint/house split).
      stepBlueprintReflow(session, `h_${hi}`);
    }
    // CLUTTER drag zones over store/workshop rooms holding furniture stacks.
    const zones: Array<{ x: number; y: number; w: number; h: number; scale: number }> = [];
    for (const hi of session.houseShown) {
      const house = t.plan.houses.find((h) => h.index === hi);
      if (!house) continue;
      let stacks = 0;
      for (const objId of houseContainerKeys(session, hi)) {
        const stock = session.containerStock.get(objId);
        if (!stock) continue;
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


  // ═══════ B1-foundNewSite (verbatim from quest-host.ts) ═══════
  /** A spoken "build" in open country: found a new EMPTY site at the avatar —
   *  deposit the FOUNDER'S OWN building materials (and any material piles lying
   *  at the spot) into its stockpile crate, dismiss the avatar back to spirit,
   *  and tell the boot to centre on it. One site per session; a town session
   *  is never wilderness. Returns false when founding doesn't apply here. */
  function foundNewSite(session: QuestSession): boolean {
    if (!session.wilderness || session.town || session.foundedSite || !world) return false;
    const at = playerWorldPos(session);
    if (!at) return false;
    const day = Math.floor(session.townClock / FOOD_DAY_SEC);
    const seed = (fnv1a(`${session.game.meta.seed ?? 0}|${Math.round(at.x)}|${Math.round(at.y)}`) % 100000) + 1;
    const site = foundSite({ seed, at, day });
    // WHAT THE FOUNDER IS CARRYING founds the stock — the goods in its bag and
    // the one thing in its hands (there is no abstract pocket to tip out any
    // more). The BAG itself stays on the body: founding a site is not giving
    // your basket away. `depositSiteStock` moves only site MATERIALS, so a
    // sandwich survives the founding.
    {
      const cid = session.handsCid;
      for (const [glyph, n] of Object.entries(bodyCarryView(bodyCarryOf(session, cid)))) {
        // ASK BEFORE TAKING: only what the site can actually use leaves the
        // body, so nothing has to be handed back.
        if (n <= 0 || !isSiteMaterial(glyph)) continue;
        const took = takeUnitsFromBody(session, cid, glyph, n);
        if (took > 0) depositSiteStock(site, { [glyph]: took });
      }
    }
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
    session.reservations = site.deltas.reservations;
    session.partnerStock = site.deltas.partnerStock;
    wildFoundedIds.clear(); // a fresh site raises nothing yet (①b)
    wildFurnishedOrds.clear();
    // Founding steps the spirit OUT of the avatar and centres it on the site.
    if (possession.creatureId) possession.dismiss();
    session.spiritPos = { x: at.x, y: at.y };
    deps.onSiteFounded?.({ key: site.key, seed: site.seed, at: { ...site.at }, stock: { ...site.stock } });
    return true;
  }


  // ═══════ B2-sites (verbatim from quest-host.ts) ═══════
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
    session.reservations = createReservationLedger();
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


  /** The session's buildable-structure catalog (world content; config swap). */
  function structureCatalogOf(session: QuestSession): StructureSpec[] {
    return session.town?.structures ?? TOWN_PLAY_STRUCTURES;
  }

  /** The construction clock, in GAME-days of the session's scale (townClock
   *  on a town session; the always-running task clock at a wilderness site).
   *  On the street-clock profile this is the street day, as before. */
  function buildDayNow(session: QuestSession): number {
    return (session.town ? session.townClock : session.taskClock) / session.scale.dayLengthS;
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
    opts?: { ignoreZones?: boolean; near?: { x: number; y: number }; max?: number },
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
      ...(opts?.near ? { near: opts.near } : {}),
      ...(opts?.max !== undefined ? { max: opts.max } : {}),
      ...(useZones ? { zoning: slotZoningFn(ctx.zones, specCategories(ctx, spec)) } : {}),
    });
  }

  /** A WORLD-coords steering point → the ctx's TOWN-LOCAL `near` input
   *  (candidates enumerate relative the town/site center). */
  function steeringNear(
    ctx: BuildContext,
    at: { x: number; y: number } | null,
  ): { x: number; y: number } | undefined {
    return at ? { x: at.x - ctx.center.x, y: at.y - ctx.center.y } : undefined;
  }

  // ── BUILD SPOTS (⑦ — the ground answers the build word) ─────────────────
  /** How wide a SPOT-pinned order searches the lot enumeration before
   *  keeping only the pressed slot. Wide enough that a zoning MATCH on the
   *  far side of town can't push the player's own plot out of the list. */
  const SPOT_SLOT_SEARCH = 24;
  /** Free lots offered per structure type. */
  const SPOT_LOTS_PER_TYPE = 4;
  /** How far from the player spots are offered, metres — a town of two
   *  hundred houses must never light up all at once. */
  const SPOT_RADIUS = 70;
  /** Standing buildings offered at a time (nearest first). */
  const SPOT_BUILDINGS = 8;
  /** Lattice the origin quantizes to for the spot cache key. */
  const SPOT_CACHE_CELL = 8;

  /** Where the offer is centred: the player's own place in the world. */
  function buildSpotOrigin(session: QuestSession): { x: number; y: number } | null {
    return playerWorldPos(session) ?? session.town?.stage.center ?? session.foundedSite?.at ?? null;
  }

  /**
   * THE OFFERED SPOTS — the ground the build word lights up. The kernel does
   * the collapsing (build-spots.ts); this gathers the live inputs: the lot
   * enumeration the founding path already runs (once per catalog entry, over
   * a memoized street tree), and the nearby buildings that would really
   * answer a menu — a building is offered only when `structureActsFor` says
   * it can do something, so no spot is ever a dead end.
   *
   * Cached on the overlay version + the player's lattice cell. Only ever
   * asked while the build word is up.
   */
  function buildSpotsNow(session: QuestSession, ctxIn?: BuildContext | null): BuildSpot[] {
    const origin = buildSpotOrigin(session);
    const t = session.town;
    const deltas = t?.deltas ?? session.foundedSite?.deltas ?? null;
    if (!origin || !deltas) return [];
    // SCOPE = THE OBJECT IN A VACUUM. Focused on ONE building, the ground
    // that answers is that building's — no founding a farm from inside a
    // dollhouse. Part of the key: refocusing changes the whole offer.
    const focus = structureFocusOf(session);
    // The key is read WITHOUT building a context — this runs every frame the
    // build word is up (board, dwell and overlay all ask), and a hit must
    // cost a string compare, not a walk of the plan.
    const key = [
      deltas.version,
      Math.round(origin.x / SPOT_CACHE_CELL),
      Math.round(origin.y / SPOT_CACHE_CELL),
      t?.plan.houses.length ?? 0,
      t?.plan.works.length ?? 0,
      // Sites arrive a frame or two after the delta that spawned them (the
      // stage emits on change), so their count is part of the key.
      lastSites.length,
      focus ? `${focus.kind}${focus.index}` : "-",
    ].join("|");
    if (spotCache && spotCache.key === key) return spotCache.spots;
    const ctx = ctxIn ?? buildContext(session);
    if (!ctx) return [];
    const near = steeringNear(ctx, origin);
    const inReach = (x: number, y: number, w: number, h: number): boolean =>
      focus !== null || Math.hypot(x + w / 2 - origin.x, y + h / 2 - origin.y) <= SPOT_RADIUS;
    const lots: BuildSpotLot[] = [];
    if (!focus) {
      for (const spec of ctx.catalog) {
        for (const c of buildCandidates(ctx, spec, {
          ...(near ? { near } : {}),
          max: SPOT_LOTS_PER_TYPE,
        })) {
          const x = ctx.center.x + c.dx;
          const y = ctx.center.y + c.dy;
          if (!inReach(x, y, c.w, c.h)) continue;
          lots.push({ type: spec.type, slot: c.slot, x, y, w: c.w, h: c.h });
        }
      }
    }
    const buildings: BuildSpotBuilding[] = [];
    const rooms: BuildSpotRoom[] = [];
    const grow: BuildSpotGrowIn[] = [];
    const busy: Array<{ x: number; y: number; w: number; h: number }> = [];
    if (t) {
      const c = t.stage.center;
      // A staked designation's ground is spoken for — its own site IS the
      // spot there (below), never an offer to stake it a second time.
      for (const r of pendingGrowthRects(session)) busy.push(r);
      const near5: Array<BuildSpotBuilding & { d: number }> = [];
      const consider = (
        dkey: string,
        f: StructureFocus,
        r: { dx: number; dy: number; w: number; h: number },
      ): void => {
        if (focus && !(focus.kind === f.kind && focus.index === f.index)) return;
        const x = c.x + r.dx;
        const y = c.y + r.dy;
        if (!inReach(x, y, r.w, r.h)) return;
        near5.push({
          key: dkey,
          focus: f,
          x, y, w: r.w, h: r.h,
          d: Math.hypot(x + r.w / 2 - origin.x, y + r.h / 2 - origin.y),
        });
      };
      for (const h of t.plan.houses) consider(`h_${h.index}`, { kind: "house", index: h.index }, h);
      t.plan.works.forEach((wk, i) => {
        if (wk.vacated) return;
        consider(workDeltaKey(wk, i), { kind: "work", index: i }, wk);
      });
      near5.sort((a, b) => a.d - b.d || (a.key < b.key ? -1 : 1));
      for (const cand of near5) {
        if (buildings.length + rooms.length >= SPOT_BUILDINGS) break;
        const found = structureActsFor(session, cand.focus);
        if (!found) continue;
        if (!structureConstructionOptions(session, cand.focus, found.acts, found.house).options.length) {
          continue;
        }
        // SCOPE DECIDES THE GRAIN (user law). Focused ON this building, its
        // ROOMS and its room-shaped gaps are what the ground offers — one aim
        // each, so "break the bedroom" can only ever be reached by lighting
        // the bedroom. Looking at the town from above, a building is one
        // thing: its rooms are under a roof nobody has opened, and lighting
        // forty of them across the street would be noise.
        const focused = !!focus && focus.kind === cand.focus.kind && focus.index === cand.focus.index;
        if (focused) {
          const shape = pendingBuildingOf(session, cand.key)?.shape ?? null;
          for (const r of found.acts.rooms) {
            // A room with nothing to do stays dark — an unlit room is the
            // honest "nothing to build or break here", and a spot that opens
            // an empty menu is a dead end.
            if (!found.acts.demolish.some((d) => d.id === r.id)) continue;
            rooms.push({
              key: cand.key,
              focus: cand.focus,
              room: r.id,
              roomKind: r.kind,
              x: r.rect.x, y: r.rect.y, w: r.rect.w, h: r.rect.h,
            });
          }
          if (shape) {
            // A floor a staked cut already targets is spoken for — two cuts
            // never share a host, so that ground must not light up a second
            // time (outward ground is covered by `busy` below).
            const busyHosts = new Set(
              t.deltas
                .annexSites()
                .filter((p) => p.buildingKey === cand.key && isInteriorCandidate(p.candidate))
                .map((p) => (p.candidate as InteriorCandidate).hostId),
            );
            for (const g of found.acts.grow) {
              if (!g.outward && busyHosts.has((g.candidate as InteriorCandidate).hostId)) continue;
              const rect = annexWorldRect(c, shape, g.candidate);
              grow.push({
                key: cand.key,
                focus: cand.focus,
                offer: {
                  kind: g.kind,
                  ...(g.cluster ? { cluster: g.cluster } : {}),
                  candidate: g.candidate,
                },
                x: rect.x, y: rect.y, w: rect.w, h: rect.h,
              });
            }
          }
          // Decomposed to nothing (no breakable room, no ground): the whole
          // building answers, so the offer is never silently empty.
          if (!rooms.length && !grow.length) {
            buildings.push({
              key: cand.key, focus: cand.focus,
              x: cand.x, y: cand.y, w: cand.w, h: cand.h,
            });
          }
          continue;
        }
        buildings.push({
          key: cand.key,
          focus: cand.focus,
          x: cand.x, y: cand.y, w: cand.w, h: cand.h,
        });
      }
    }
    // WORK IN PROGRESS is its own spot (⑦): looking at a half-built thing
    // offers the only act it has — calling the work off.
    const sites: BuildSpotSite[] = lastSites
      .filter((s) => cancellableSite(session, s.id) !== null && inReach(s.x, s.y, s.w, s.h))
      .map((s) => ({ site: s.id, x: s.x, y: s.y, w: s.w, h: s.h }));
    const spots = buildSpots({ lots, buildings, rooms, grow, sites, busy });
    spotCache = { key, spots };
    return spots;
  }

  /** What a construction-site id names, when it names work that can be
   *  CALLED OFF (⑦ deconstruction menu). Null for anything settled — a
   *  finished building comes down through a demolition, which is work. */
  function cancellableSite(
    session: QuestSession,
    siteId: string,
  ): { kind: "founded" | "annex" | "demolition"; ord: number; label: string } | null {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas) return null;
    const founded = /^site_wf_(\d+)$/.exec(siteId);
    if (founded) {
      const b = deltas.founded().find((f) => f.ord === Number(founded[1]));
      return b && !b.completed
        ? { kind: "founded", ord: b.ord, label: structureLabelOf(session, b.type) }
        : null;
    }
    const work = /^site_w_(\d+)$/.exec(siteId);
    if (work) {
      const wk = session.town?.plan.works[Number(work[1])];
      const b = wk?.foundedOrd !== undefined
        ? deltas.founded().find((f) => f.ord === wk.foundedOrd)
        : undefined;
      return b && !b.completed
        ? { kind: "founded", ord: b.ord, label: structureLabelOf(session, b.type) }
        : null;
    }
    const annex = /^site_pa_(\d+)$/.exec(siteId);
    if (annex) {
      const p = deltas.annexSites().find((q) => q.ord === Number(annex[1]));
      return p ? { kind: "annex", ord: p.ord, label: pendingRoomKindOf(p) } : null;
    }
    const dem = /^site_pd_(\d+)$/.exec(siteId);
    if (dem) {
      const p = deltas.demolitionSites().find((q) => q.ord === Number(dem[1]));
      return p ? { kind: "demolition", ord: p.ord, label: "room" } : null;
    }
    return null; // a scaffold window — the room is already built
  }

  function structureLabelOf(session: QuestSession, type: string): string {
    return resolveStructure(structureCatalogOf(session), type)?.label ?? type;
  }

  /** CALL OFF work in progress: the designation drops and whatever was
   *  hauled to its plot goes back to the yard — materials are conserved, so
   *  a changed mind never costs the town its wood. */
  function cancelWork(session: QuestSession, siteId: string): boolean {
    const target = cancellableSite(session, siteId);
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!target || !deltas) return false;
    const bank = (pile: Record<string, number>): void => {
      for (const [g, n] of Object.entries(pile)) {
        if (n > 0) deltas.stock[g] = (deltas.stock[g] ?? 0) + n;
      }
    };
    if (target.kind === "founded") {
      const pile = deltas.cancelFounding(target.ord);
      if (!pile) return false;
      bank(pile);
      // The plan row goes with it — the stage drops the site the same frame.
      const t = session.town;
      if (t) {
        const i = t.plan.works.findIndex((w) => w.foundedOrd === target.ord);
        if (i >= 0) t.plan.works.splice(i, 1);
      } else if (session.foundedSite) {
        refreshWildFounded(session);
      }
    } else if (target.kind === "annex") {
      const p = deltas.annexSites().find((q) => q.ord === target.ord);
      if (!p) return false;
      bank(p.pile);
      deltas.removeAnnexSite(target.ord);
    } else {
      deltas.removeDemolitionSite(target.ord);
    }
    // Retire the builders: their site is gone, so the pooled work is done.
    for (const t of session.taskPool.claimed()) {
      if (t.goal.kind === "buildwork" && !buildworkSiteAt(session, t.goal.site)) {
        session.taskPool.complete(t.id);
      }
    }
    presenter.toast(`🚧 the ${target.label} is called off — materials back to the yard`, "feedback");
    return true;
  }


  // ═══════ B3-pipeline (verbatim from quest-host.ts) ═══════
  /** COMMIT a validated build: spend the costs, write the founded delta,
   *  stand the scaffold (town: a plan row the stage reconciles; wilderness:
   *  the site's own walls), and walk the builder to the lot. Returns the
   *  founded row, or null when the stock could no longer cover it. */
  /** A founded row's LEGACY site-pile endpoint id (pre-phase-2 agreements
   *  in flight; new hauls target `orderPileId`). */
  function sitePileId(ord: number): string {
    return `${SITE_PILE_EP}${ord}`;
  }

  /** An order's pile endpoint id (phase 2 — the one pile scheme). */
  function orderPileId(ord: number): string {
    return `${ORDER_PILE_EP}${ord}`;
  }

  /** An order's build-work site id (phase 2 — the one site scheme; the
   *  pre-phase-2 `f:`/`a:`/`d:` ids were session-lived, so nothing old can
   *  reference them across the code swap). */
  function orderSiteId(ord: number): string {
    return `o:${ord}`;
  }

  // ── OBSERVATION-KEYED DRIVERS (phase 2 step 3) ──────────────────────────
  // The clock is the DEFAULT driver; what visibility forces is a RENDERED
  // CAUSE, not physics. Per tick, every order is either OBSERVED (its site
  // inside the camera's reach — progress only through builders standing at
  // visible work) or UNOBSERVED (progress through the clock arm below, at
  // the one playback rate). The split is keyed on observation alone — never
  // on who created the row, which was the "builds itself" bug class.

  /** The camera's reach — the ~120 m the stage passes as visibleR (the
   *  cohort-walker spawn gate uses the same figure). A site rect whose
   *  nearest point is inside it is OBSERVED this tick. */
  const OBSERVED_SITE_R = 120;

  /** Is `rect` inside the player/spirit's observation reach this tick?
   *  A session with no anchor at all (headless sims, worldgen twins) is
   *  never observed — everything runs on the clock, which is exactly what
   *  those sessions always did. */
  function observedRect(
    session: QuestSession,
    rect: { x: number; y: number; w: number; h: number },
  ): boolean {
    const me = playerWorldPos(session) ?? session.spiritPos;
    if (!me) return false;
    const px = Math.min(Math.max(me.x, rect.x), rect.x + rect.w);
    const py = Math.min(Math.max(me.y, rect.y), rect.y + rect.h);
    return Math.hypot(me.x - px, me.y - py) <= OBSERVED_SITE_R;
  }

  /** An order's world rect (the observation test + the presence edge). */
  function orderRectOf(
    session: QuestSession,
    o: ConstructionOrder,
  ): { x: number; y: number; w: number; h: number } | null {
    if (o.kind === "found") {
      const base = session.town ? session.town.stage.center : session.foundedSite?.at;
      return base ? { x: base.x + o.dx, y: base.y + o.dy, w: o.w, h: o.h } : null;
    }
    if (o.kind === "refine") {
      // The mill spot's working reach — a bench, not a plot (town-less
      // sessions refine too, so this sits before the town gate).
      return { x: o.at.x - 2, y: o.at.y - 2, w: 4, h: 4 };
    }
    const t = session.town;
    if (!t) return null;
    if (o.kind === "demolish") {
      return (
        pendingBuildingOf(session, o.buildingKey)?.plan.rooms.find((r) => r.id === o.roomId)
          ?.rect ?? null
      );
    }
    const host = pendingBuildingOf(session, o.buildingKey);
    return host ? annexWorldRect(t.stage.center, host.shape, o.candidate) : null;
  }

  /** THE one labor rate (phase 2 step 3): build-day credit per elapsed
   *  SECOND for `crew` builders. Both arms call this — the observed arm
   *  with the builders physically present at the edge, the clock arm with
   *  the abstract crew × CLOCK_SCHEDULE_RATE — so the two can only ever
   *  differ by the schedule factor, never by unit (the FOOD_DAY_SEC vs
   *  dayLengthS mis-rate is what two conversions produce). */
  function laborRatePerS(session: QuestSession, crew: number): number {
    return Math.min(BUILDERS_CAP, Math.max(0, crew)) / session.scale.dayLengthS;
  }

  /** Would this hand volunteer for `issuer`'s civic work? The pool's
   *  willingness gate: residents and bonded creatures always; anyone else by
   *  real compliance TOWARD THE ORDERING AUTHOR — willingness is a relation,
   *  so it is answered against whoever gave the order, never against a fixed
   *  name. Shared by the abstract crew count and the stream-in placement so
   *  the clock arm and the reveal agree on who works.
   *  No AUTHOR is a hand (a player is a spark, not a puppet — and that holds
   *  for every author in the spark set, not just this device's), and neither
   *  is the body the player is currently riding. */
  function willingHand(session: QuestSession, cid: string, issuer: string = LOCAL_PLAYER_CID): boolean {
    if (isPlayerCid(cid) || cid === possession.creatureId) return false;
    if (session.party.has(cid) || session.escorting.has(cid)) return false;
    return (
      cid.startsWith("resident_") ||
      session.bondedCreatures.has(cid) ||
      compliance(relationToward(session, cid, issuer), creatureMood(cid)) >=
        VOLUNTEER_COMPLIANCE
    );
  }

  /** The ABSTRACT CREW an unobserved site works with: a settled town
   *  always fields a full crew (its workforce dwarfs the cap; whether any
   *  of it is streamed in right now is exactly what observation must not
   *  matter for); off a town it is the hands ambient recruitment would
   *  enlist — registered residents/bonded creatures, WILLING volunteers
   *  (the pool's compliance gate), and ambient resident bodies. */
  function availableCrew(session: QuestSession, issuer: string = LOCAL_PLAYER_CID): number {
    if (session.town) return BUILDERS_CAP;
    const crew = new Set<string>();
    for (const cid of session.creatures?.nodeByCreature.keys() ?? []) {
      if (willingHand(session, cid, issuer)) crew.add(cid);
    }
    for (const bodyId of Object.keys(world?.state.avatars ?? {})) {
      if (!bodyId.startsWith("resident_")) continue;
      if (bodyId === possession.creatureId) continue;
      if (session.party.has(bodyId) || session.escorting.has(bodyId)) continue;
      crew.add(bodyId);
    }
    return crew.size;
  }

  /** Last tick's observation per order — ONLY for the stream-in edge (the
   *  fact itself is per-tick; this is not per-row memory of progress). */
  const orderObservedPrev = new Map<number, boolean>();

  /** STREAM-IN materialization (phase 2 step 3): the reveal must show the
   *  work IN MOTION. Stage geometry at its banked fraction and the pile
   *  stacks are emergent (pure reads of labor and the pile map) — but the
   *  crew is bodies, and a visible body never teleports (walk-unification
   *  law). At the transition instant, off-screen able bodies are PLACED at
   *  the site mid-pose (nobody saw them move); anything already on screen
   *  simply walks over through ambient recruitment. */
  function materializeCrew(
    session: QuestSession,
    at: { x: number; y: number },
    cap: number = BUILDERS_CAP,
    issuer: string = LOCAL_PLAYER_CID,
  ): void {
    if (!world) return;
    const me = playerWorldPos(session) ?? session.spiritPos;
    const want = Math.min(cap, availableCrew(session, issuer));
    let standing = 0;
    const place = (cid: string): void => {
      if (!world || standing >= want) return;
      if (!willingHand(session, cid, issuer)) return;
      const npcId = avatarIdOf(cid);
      const body = world.state.avatars[npcId];
      if (!body) return;
      if (session.liveNeedBodies.has(cid)) return;
      if (session.taskPool.claimedBy(cid)) return;
      if ((session.npcTasks.get(npcId)?.length ?? 0) > 0) return;
      if (Math.hypot(body.x - at.x, body.y - at.y) <= BUILD_WORK_EDGE_R + 2) {
        standing++; // already at the work — the reveal is honest as-is
        return;
      }
      // Visible elsewhere ⇒ walks (never snaps); off-screen ⇒ placed.
      if (me && Math.hypot(body.x - me.x, body.y - me.y) <= OBSERVED_SITE_R) return;
      const stand = nearestClearSpot(
        world.state,
        at,
        { x: body.x, y: body.y },
        world.npcRadiusOf(npcId),
        standAvoid(cid),
      );
      body.x = stand.x;
      body.y = stand.y;
      // Mid-pose at the reveal; the workSite pass this same tick posts the
      // build tasks these hands then claim.
      session.needPoseShow.set(npcId, { t: 4, kind: "play" });
      standing++;
    };
    // Registered hands first (settlers, family — their bodies ride
    // avatarIdOf), then ambient resident bodies with no registered mind.
    for (const cid of session.creatures?.nodeByCreature.keys() ?? []) place(cid);
    for (const bodyId of Object.keys(world.state.avatars)) {
      if (bodyId.startsWith("resident_") && !session.creatures?.nodeByCreature.has(bodyId)) {
        place(bodyId);
      }
    }
  }

  /** The reservation HOLDER a site haul's units ride under — the agreement's
   *  own id, so consumption and release follow the agreement's lifecycle. */
  function agrHolder(agreementId: string): string {
    return `agr:${agreementId}`;
  }

  /** The reservation HOLDER a haul's BASKET rides under (step ④ ENABLE) — the
   *  agreement's id again, so the tool claim lives and dies with the trip.
   *  Kept DISTINCT from `agrHolder` because the two release at different
   *  moments: the goods are consumed at the load, the bag at the unload. */
  function bagHolder(agreementId: string): string {
    return `bag:${agreementId}`;
  }

  /** LANDING = RESERVATION, atomically (phase 2 step 1). Called from the
   *  haul's unload seam with what ACTUALLY landed, before the agreement is
   *  marked done — so there is no instant in which delivered construction
   *  inputs sit on their destination as free supply. The gap between landing
   *  and the consumer's next tick used to be exactly that: under a town-wide
   *  famine, every unit delivered to a craft spot could be legally drained
   *  by another resolver before the job's sweep re-measured the stack (the
   *  GL famine race — the bed that re-gathered forever).
   *  - A live craft job's delivery reserves straight under its OWN holder
   *    (`craftspot:<hi>`) — the job's done-agreement branch keeps no
   *    stack-measuring bookkeeping at all.
   *  - A site/annex/furnishing pile's delivery rides under the agreement's
   *    holder; the staging sweep's done-release is the acknowledgment (pile
   *    stacks are not resolve sources, so after that they are unreachable
   *    rather than raidable).
   *  Any other destination (a spoken box transfer, a gift) reserves nothing —
   *  there is no consumer to ever release it. */
  function onTransferLanded(
    session: QuestSession,
    agreementId: string,
    landed: Record<string, number>,
  ): void {
    const a = session.transfers.get(agreementId);
    if (!a) return;
    for (const [hi, job] of craftJobsOf(session)) {
      if (job.spotId !== a.to || !job.agreements.includes(agreementId)) continue;
      for (const [g, c] of Object.entries(landed)) {
        if (c > 0) session.reservations.reserve(`craftspot:${hi}`, a.to, stackHead(g), c);
      }
      return;
    }
    if (
      a.to.startsWith(ORDER_PILE_EP) ||
      a.to.startsWith(SITE_PILE_EP) ||
      a.to.startsWith(ANNEX_PILE_EP) ||
      a.to.startsWith(BFURN_EP)
    ) {
      for (const [g, c] of Object.entries(landed)) {
        if (c > 0) session.reservations.reserve(agrHolder(agreementId), a.to, stackHead(g), c);
      }
    }
  }

  /** World anchor of a founded lot (the staked plot's center). */
  function foundedLotAt(
    session: QuestSession,
    b: Pick<FoundedBuilding, "dx" | "dy" | "w" | "h">,
  ): { x: number; y: number } | null {
    const base = session.town ? session.town.stage.center : session.foundedSite?.at;
    return base ? { x: base.x + b.dx + b.w / 2, y: base.y + b.dy + b.h / 2 } : null;
  }

  // ── ⚖️ ONE GEOMETRY FOR SOURCE WALKS (scope-behaviors.md §2.2, §3) ───────
  //
  // The survey's exact complaint: the town's nearest-first "is implemented
  // three times — AND INCONSISTENTLY: construction uses crow-flies `hypot`
  // while shopping (`sourceOf`) and district deficits use `roadDistance`." The
  // currency section settles it: "`journeyS` = path length / speed. ROAD
  // DISTANCE WHERE THE GRAPH EXISTS (the `sourceOf` precedent), CHORD
  // OTHERWISE."
  //
  // PERF — the `sourceOf` discipline, not a per-tick graph walk. goods.ts picks
  // a house's market by road ONCE and caches it per house, because
  // `roadDistance` PROJECTS both endpoints onto the street tree every call. A
  // site's bill re-resolves over every container in town, so the same
  // arithmetic here would be O(containers × streets) per sweep. Both ends of
  // every measurement in this file are STABLE POINTS (a container's anchor, a
  // site centre, a doorstep), so a plain memo on the coordinate pair is a
  // near-total hit rate after the first sweep — the graph is walked once per
  // (site, chest) pair for as long as neither moves, and a chest that IS moved
  // re-measures on its own because its key changed. Cleared when the street
  // graph itself is replaced (a new town session).
  let roadMemoNet: unknown = null;
  const roadMemo = new Map<string, number>();
  /** Keep the memo from growing without bound across a long session; purely a
   *  size cap — dropping entries only ever costs a recompute of the same
   *  number, so determinism is untouched. */
  const ROAD_MEMO_CAP = 8192;

  /**
   * ⚖️ Metres between two points as a SOURCE WALK measures them: street metres
   * where the town has streets, chord where it doesn't (a founded site in the
   * wilderness, a townless session). ONE function, so construction stops
   * disagreeing with shopping about what "near" means.
   */
  function sourceDistanceM(
    session: QuestSession,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): number {
    const t = session.town;
    const net = t?.plan.streets;
    if (!net) return Math.hypot(to.x - from.x, to.y - from.y);
    if (roadMemoNet !== net) {
      roadMemoNet = net;
      roadMemo.clear();
    }
    // Street coordinates are TOWN-LOCAL (goods.ts / streets.ts convention).
    const c = t!.stage.center;
    const ax = from.x - c.x, ay = from.y - c.y, bx = to.x - c.x, by = to.y - c.y;
    const key = `${ax.toFixed(2)},${ay.toFixed(2)}|${bx.toFixed(2)},${by.toFixed(2)}`;
    const hit = roadMemo.get(key);
    if (hit !== undefined) return hit;
    const d = roadDistance(net, { x: ax, y: ay }, { x: bx, y: by });
    if (roadMemo.size >= ROAD_MEMO_CAP) roadMemo.clear();
    roadMemo.set(key, d);
    return d;
  }

  /** Candidate MATERIAL SOURCES for staging a site (pipeline ②): every
   *  usable container stack — the yard, the site crate, communal chests,
   *  wild features, our own boxes — ownership-gated exactly like a spoken
   *  transfer order. Distance-ranked to the work spot BY STREET
   *  (`sourceDistanceM`). Site piles are not containers, so a plot never raids
   *  another plot's heap.
   *  Reach is the ISSUER'S reach: propriety is a question about the author of
   *  the order, so the same yard can be another author's to draw from and not
   *  this one's. */
  function siteMaterialSources(
    session: QuestSession,
    destAt: { x: number; y: number },
    issuer: string = LOCAL_PLAYER_CID,
  ): TransferSource[] {
    const issuerHouse = familyOf(session)?.house ?? null;
    const sources: TransferSource[] = [];
    for (const [boxId, stack] of session.containerStock) {
      if (session.marketStore.has(boxId) || session.produceBox.has(boxId) || boxId.startsWith("trade:")) continue;
      const owner = session.containerOwner.get(boxId);
      if (!mayUse(issuer, issuerHouse, owner)) continue;
      const at = containerAnchor(session, boxId);
      if (!at) continue;
      sources.push({ id: boxId, stack, d: sourceDistanceM(session, destAt, at) });
    }
    return sources;
  }

  /** The costs no FREE stack can cover right now (head → units) — the
   *  build-order affordability check, over every haul-able source instead
   *  of the yard alone, minus what pending hauls have spoken for. */
  function buildMissingMaterials(
    session: QuestSession,
    spec: Pick<StructureSpec, "costs">,
    destAt: { x: number; y: number },
    issuer: string = LOCAL_PLAYER_CID,
  ): Record<string, number> {
    const sources = siteMaterialSources(session, destAt, issuer);
    const need = new Map<string, number>();
    for (const [g, n] of Object.entries(spec.costs)) {
      const head = stackHead(g);
      need.set(head, (need.get(head) ?? 0) + n);
    }
    const missing: Record<string, number> = {};
    for (const [head, n] of need) {
      const free = sources.reduce((s, src) => s + freeUnits(src.stack, session.reservations, src.id, head), 0);
      if (free < n) missing[head] = n - free;
    }
    return missing;
  }

  /** A pending annex's pile endpoint id (pipeline ⑤). */
  function annexPileId(ord: number): string {
    return `${ANNEX_PILE_EP}${ord}`;
  }

  /**
   * How far a CIVIC task recruits (⑥ — "everyone works together"): the WHOLE
   * town volunteers for communal construction, not just the bodies within
   * earshot of the site — a 205-house town's free lots all sit at the edge, far
   * from anyone. The recruited walker is PINNED (busy) for the trek. Off a
   * town, the wilderness earshot rule stays.
   *
   * ⚖️ THE MARGIN IS DERIVED (scope-behaviors.md §4.7: "`civicRecruitRadius`'s
   * literal-plus-geometry, which should be scale-derived like
   * `serviceRadiusM`"). Two terms, and only one of them was ever a literal:
   *
   *   · `plan.radius × 2` — the town's own DIAMETER. Geometry, not a constant:
   *     a body anywhere in town must be able to answer a call from anywhere
   *     else in it, which is the whole point of the civic radius.
   *   · `+ 80` — the reach PAST the edge, and the literal §4.7 sentences. It is
   *     now `serviceRadiusM(scale, "social")`.
   *
   * WHY THE SOCIAL CLOCK. `serviceRadiusM` measures a journey "in units of the
   * need's own fill clock" (§3), so the question is which drive a work party
   * is. It is not hunger (nobody walks to a raising because they are hungry)
   * and not energy (the trek is not the work). "Everyone works together" is a
   * GATHERING: the drive that already measures how far a body ranges to be
   * among its neighbours is `social`, and answering a call from the town is the
   * same act as answering one from a friend. On the shipped street profile that
   * is 1.6 m/s × 192 s × 0.5 / 2 = **76.8 m** against the old 80 — the same
   * radius to within 4 %, so no shipped town reshapes; on a world with a slower
   * appetite or faster legs it now moves with them instead of staying 80.
   */
  function civicRecruitRadius(session: QuestSession): number {
    const t = session.town;
    const margin = serviceRadiusM(session.scale, "social");
    return t ? Math.max(SITE_HAUL_FOCUS_R, t.plan.radius * 2 + margin) : SITE_HAUL_FOCUS_R;
  }

  /** A designation's building, resolved from its delta key: a plan house
   *  (`h_<i>`), a founded work (`f_<ord>` — the immortal founding ordinal,
   *  workDeltaKey), or a base work (`w_<i>`). Works graft a synthetic
   *  index — every geometry read uses only the frame fields. The plan is
   *  the LIVE one (delta applied, memoized). */
  function pendingBuildingOf(
    session: QuestSession,
    buildingKey: string,
  ): { shape: HouseShape; plan: ReturnType<typeof houseRoomPlan> } | null {
    const t = session.town;
    if (!t) return null;
    const hm = /^h_(\d+)$/.exec(buildingKey);
    if (hm) {
      const h = t.plan.houses.find((hh) => hh.index === Number(hm[1]));
      if (!h) return null;
      return { shape: h, plan: houseRoomPlan(t.stage.center, h, t.deltas.get(buildingKey)) };
    }
    const fm = /^f_(\d+)$/.exec(buildingKey);
    const wm = /^w_(\d+)$/.exec(buildingKey);
    const wi = fm
      ? t.plan.works.findIndex((w) => w.foundedOrd === Number(fm[1]))
      : wm
        ? Number(wm[1])
        : -1;
    const wk = wi >= 0 ? t.plan.works[wi] : undefined;
    if (!wk) return null;
    return {
      shape: { ...wk, index: 100000 + wi },
      plan: buildingRoomPlan(
        t.stage.center, wi, wk, wk.program ?? workProgram(wk.type), t.deltas.get(buildingKey),
      ),
    };
  }

  /** World anchor of a pending designation's rect — an annex's growth rect
   *  outside the footprint, an interior room's band inside it (both are
   *  frame rects; annexWorldRect maps either). */
  function pendingAnnexAt(session: QuestSession, p: PendingAnnex): { x: number; y: number } | null {
    const t = session.town;
    const b = pendingBuildingOf(session, p.buildingKey);
    if (!t || !b) return null;
    const r = annexWorldRect(t.stage.center, b.shape, p.candidate);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  /** World anchor of a pending DEMOLITION — the doomed room's own center
   *  (room rects are world rects; the plan is the delta-applied one, so
   *  the room stands right up until the commit removes it). */
  function pendingDemolitionAt(
    session: QuestSession,
    p: PendingDemolition,
  ): { x: number; y: number } | null {
    const b = pendingBuildingOf(session, p.buildingKey);
    const room = b?.plan.rooms.find((r) => r.id === p.roomId);
    if (!room) return null;
    return { x: room.rect.x + room.rect.w / 2, y: room.rect.y + room.rect.h / 2 };
  }

  /** A build-work site's live anchor (⑥): `o:<ord>` — an order still
   *  banking labor (phase 2: ONE id scheme over every kind). Null once the
   *  order is gone or worked through (claims stop; the sweep retires its
   *  tasks). The pre-phase-2 `f:`/`a:`/`d:` ids were session-lived, so
   *  nothing can still carry one. */
  function buildworkSiteAt(session: QuestSession, siteId: string): { x: number; y: number } | null {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas) return null;
    const m = /^o:(\d+)$/.exec(siteId);
    if (!m) return null;
    const o = deltas.orders().find((q) => q.ord === Number(m[1]));
    if (!o) return null;
    switch (o.kind) {
      case "found":
        // Staged is the gate, not costed — an ADOPTED no-cost row (step 3)
        // is a real labor site like any other.
        if (o.completed || o.laborStartDay === undefined) return null;
        if ((o.labor ?? 0) >= o.buildDays - 1e-9) return null;
        return foundedLotAt(session, o);
      case "annex":
      case "interior":
        if (o.laborStartDay === undefined || pendingLaborDone(o)) return null;
        return pendingAnnexAt(session, o);
      case "demolish":
        if (demolitionLaborDone(o)) return null;
        return pendingDemolitionAt(session, o);
      case "refine":
        if (o.laborStartDay === undefined || (o.labor ?? 0) >= o.buildDays - 1e-9) return null;
        return o.at;
    }
  }

  /** Commit-time validation for an INTERIOR designation: the recorded host
   *  must still stand and contain the cut (the plan may have shifted while
   *  materials gathered). requestInterior itself re-checks only the cap —
   *  the requestAnnex law; this is the plan-side half. */
  function interiorCommitOk(session: QuestSession, p: PendingAnnex): boolean {
    if (!isInteriorCandidate(p.candidate)) return false;
    const t = session.town;
    const b = pendingBuildingOf(session, p.buildingKey);
    if (!t || !b) return false;
    const host = b.plan.rooms.find((r) => r.id === (p.candidate as InteriorCandidate).hostId);
    if (!host) return false;
    const cut = annexWorldRect(t.stage.center, b.shape, p.candidate);
    const EPS = 1e-3;
    return (
      cut.x >= host.rect.x - EPS &&
      cut.y >= host.rect.y - EPS &&
      cut.x + cut.w <= host.rect.x + host.rect.w + EPS &&
      cut.y + cut.h <= host.rect.y + host.rect.h + EPS
    );
  }

  /** POST THE HAULS that stage a designation's pile (pipeline ②/⑤): count
   *  goods already in flight to it, resolve the remainder nearest-first
   *  over FREE stacks, reserve each draw under its agreement, and pool one
   *  civic task per haul — any idle body nearby may claim. Idempotent per
   *  call; rate-limited per pile so expired tasks don't repost every
   *  sweep. */
  const pileRetryAt = new Map<string, number>();

  /** What a pile still needs BEYOND its stacks and its live in-flight
   *  hauls (legacy endpoint alias included) — shared by the haul poster
   *  and the abstract twin, so the two arms can never disagree on the
   *  bill. */
  function pileShortfall(
    session: QuestSession,
    opts: { pileId: string; legacyPileId?: string; missing: Record<string, number> },
  ): Record<string, number> {
    const inflight: Record<string, number> = {};
    for (const a of session.transfers.all()) {
      if (a.to !== opts.pileId && (!opts.legacyPileId || a.to !== opts.legacyPileId)) continue;
      if (a.status !== "pending" && a.status !== "moving") continue;
      for (const [g, n] of Object.entries(a.goods)) {
        const head = stackHead(g);
        inflight[head] = (inflight[head] ?? 0) + n;
      }
    }
    const want: Record<string, number> = {};
    for (const [head, n] of Object.entries(opts.missing)) {
      const short = n - (inflight[head] ?? 0);
      if (short > 0) want[head] = short;
    }
    return want;
  }

  /** RESOLVE the in-flight hauls of an UNOBSERVED pile (phase 2 step 3).
   *  An off-screen carrier is scenery — its body may not step at all — so
   *  a haul frozen mid-walk would block the twin forever (the shortfall
   *  math defers to in-flight goods, honestly). The walk simply finishes
   *  unobserved: a LOADED haul lands hands → pile through the same
   *  item-model move and landing reservation the unload seam takes; an
   *  UNLOADED one fails named ("no-executor") so its source units free up
   *  for the twin's own draw. A carrier whose body is itself inside the
   *  observation reach is really walking — left alone to arrive. */
  function twinResolveHauls(
    session: QuestSession,
    pileId: string,
    legacyPileId?: string,
    issuer: string = LOCAL_PLAYER_CID,
  ): void {
    const me = playerWorldPos(session) ?? session.spiritPos;
    for (const a of session.transfers.all()) {
      if (a.status !== "pending" && a.status !== "moving") continue;
      if (a.to !== pileId && (!legacyPileId || a.to !== legacyPileId)) continue;
      if (a.executor === issuer) continue; // the ordering author IS its own observer
      const body = a.executor ? world?.state.avatars[avatarIdOf(a.executor)] : undefined;
      if (body && me && Math.hypot(body.x - me.x, body.y - me.y) <= OBSERVED_SITE_R) continue;
      const loaded = a.status === "moving" && a.carried && Object.values(a.carried).some((n) => n > 0);
      if (!loaded) {
        // Not yet loaded (or never claimed): nobody is coming while the
        // world is unwatched — release the spoken-for source units and let
        // the twin draw them itself.
        session.transfers.fail(a.id, "no-executor");
        session.reservations.release(agrHolder(a.id));
        // ④ MIRRORING THE OBSERVED ARM: the basket this trip spoke for goes
        // back on the shelf. Without it an unobserved haul that never happened
        // would hold the town's only bag out of every other porter's reach, and
        // the observed and unobserved arms would disagree about how much a trip
        // can carry — which is exactly the double-count this claim exists to
        // prevent.
        session.reservations.release(bagHolder(a.id));
        continue;
      }
      const exec = a.executor!;
      // WHAT THE CARRIER IS REALLY HOLDING — the goods in its bag, or the one
      // whole thing in its hands. A porter with no bag delivers a single unit
      // per trip, unobserved exactly as it would in view (decision 9).
      const exCarry = bodyCarryOf(session, exec);
      const held = bodyCarryView(exCarry);
      const dstStock = session.containerStock.get(a.to) ?? {};
      const delivered: Record<string, number> = {};
      for (const [g, n] of Object.entries(a.carried ?? {})) {
        let give = Math.min(n, stackUnits(held, g));
        while (give > 0) {
          // Off the body first, into the pile second — the unobserved half of
          // the same conservation the walked unload keeps.
          if (takeUnitsFromBody(session, exec, g, 1) < 1) break;
          dstStock[g] = (dstStock[g] ?? 0) + 1;
          delivered[g] = (delivered[g] ?? 0) + 1;
          give--;
        }
      }
      if (!Object.keys(delivered).length) {
        session.transfers.fail(a.id, "missing");
        session.reservations.release(agrHolder(a.id));
        session.reservations.release(bagHolder(a.id));
        continue;
      }
      session.containerStock.set(a.to, dstStock);
      // The seam's landing law, unobserved: reserved before "done".
      onTransferLanded(session, a.id, delivered);
      // ⏸️ TWIN PARITY: the watched unload bumps the stock epoch, so this one
      // must too. An unobserved delivery that woke nobody would leave the two
      // economies disagreeing about whether anything happened.
      bumpStockEpoch(session);
      // The bag stays ON the unobserved porter exactly as it would on a watched
      // one — the claim ends with the trip, the basket does not teleport home.
      session.reservations.release(bagHolder(a.id));
      session.transfers.complete(a.id);
    }
  }

  /** THE ABSTRACT TWIN at site scale (phase 2 step 3): an UNOBSERVED
   *  site's materials move as ledger arithmetic — the same free stacks,
   *  the same reservations, the same fell hooks the physical hauls use —
   *  so a hidden site can never double-spend against a watched one, and a
   *  drained kill-source fells either way. Hauls posted while the site was
   *  observed keep walking and still count toward the bill. Rate-limited
   *  by the same per-pile gate; a starved site still SPEAKS. */
  function twinStagePile(
    session: QuestSession,
    opts: {
      pileId: string;
      legacyPileId?: string;
      at: { x: number; y: number };
      missing: Record<string, number>;
      /** The order's LIVE pile map (drawn units land here). */
      pile: Record<string, number>;
    },
    issuer: string = LOCAL_PLAYER_CID,
  ): void {
    const want = pileShortfall(session, opts);
    if (!Object.keys(want).length) return;
    const now = session.taskClock;
    if (now < (pileRetryAt.get(opts.pileId) ?? -Infinity)) return;
    pileRetryAt.set(opts.pileId, now + SITE_HAUL_RETRY_S);
    const led = session.reservations;
    const tmp = `stage:${opts.pileId}`;
    const { draws } = resolveMaterials({
      holder: tmp,
      costs: want,
      sources: siteMaterialSources(session, opts.at, issuer),
      ledger: led,
    });
    if (!draws.length) {
      led.release(tmp);
      // THE CHAIN (phase 3): a refinable shortfall posts a refine order
      // instead of starving — blocks get milled, the next resolve finds
      // them. Only what no chain can reach toasts the honest bill.
      const { milling, rest } = ensureRefineOrders(session, want, issuer);
      if (Object.keys(rest).length) {
        const bill = Object.entries(rest)
          .map(([g, n]) => `${n} ${g}`)
          .join(", ");
        presenter.toast(`🪵 the site still needs ${bill} — and there is none to fetch`, "feedback");
      } else if (milling > 0) {
        presenter.toast(`🪚 milling ${milling} ${BLOCK_GLYPH} for the site`, "feedback");
      }
      return;
    }
    for (const d of draws) {
      const src = session.containerStock.get(d.endpoint);
      if (!src) continue;
      const taken = takeStock(src, d.glyph, d.take);
      for (const [g, c] of Object.entries(taken)) {
        opts.pile[g] = (opts.pile[g] ?? 0) + c;
      }
      fellIfConsumed(session, d.endpoint);
    }
    led.release(tmp);
  }

  function postPileHauls(
    session: QuestSession,
    opts: {
      pileId: string;
      /** The pre-phase-2 endpoint id this pile also answered to — an
       *  adapted save's in-flight hauls still target it, and they must
       *  count against the bill or the sweep double-orders the load. */
      legacyPileId?: string;
      at: { x: number; y: number };
      /** Costs still missing beyond the pile (stagingMissing output). */
      missing: Record<string, number>;
      /** The spoken destination word for the haul's intent line. */
      glyph: string;
    },
    issuer: string = LOCAL_PLAYER_CID,
  ) {
    const want = pileShortfall(session, opts);
    if (!Object.keys(want).length) return;
    const now = session.taskClock;
    if (now < (pileRetryAt.get(opts.pileId) ?? -Infinity)) return;
    pileRetryAt.set(opts.pileId, now + SITE_HAUL_RETRY_S);
    const led = session.reservations;
    const tmp = `stage:${opts.pileId}`;
    const { draws } = resolveMaterials({
      holder: tmp,
      costs: want,
      sources: siteMaterialSources(session, opts.at, issuer),
      ledger: led,
    });
    if (!draws.length) {
      // STARVED, not waiting: the bill is known and NOTHING reachable can
      // cover any of it. Honest waiting is quiet; a world with no source at
      // all must SAY so, or "nothing happens" is indistinguishable from a
      // stall (the homestead report). Rate-limited by the same pileRetryAt
      // gate above, so this speaks at most once per retry window.
      // THE CHAIN (phase 3): a refinable shortfall posts a refine order
      // first — only what no chain can reach toasts the honest bill.
      led.release(tmp);
      const { milling, rest } = ensureRefineOrders(session, want, issuer);
      if (Object.keys(rest).length) {
        const bill = Object.entries(rest)
          .map(([g, n]) => `${n} ${g}`)
          .join(", ");
        presenter.toast(`🪵 the site still needs ${bill} — and there is none to fetch`, "feedback");
      } else if (milling > 0) {
        presenter.toast(`🪚 milling ${milling} ${BLOCK_GLYPH} for the site`, "feedback");
      }
      return;
    }
    for (const d of draws) {
      const a = session.transfers.post({
        from: d.endpoint,
        to: opts.pileId,
        goods: { [d.glyph]: d.take },
        issuer,
        mode: "haul",
        now,
        sourceGlyph: `bring ${d.take} ${d.glyph}`,
      });
      // The reservation rides the agreement: consumed as the hauler loads,
      // released by the staging sweep when the agreement dies.
      led.reserve(agrHolder(a.id), d.endpoint, d.glyph, d.take);
      postPooledTask(
        session,
        { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: opts.glyph } },
        issuer,
        { x: opts.at.x, y: opts.at.y, radius: civicRecruitRadius(session) },
        `bring ${d.take} ${d.glyph}`,
      );
    }
    led.release(tmp);
  }

  function postSiteHauls(session: QuestSession, b: FoundedBuilding, issuer: string = LOCAL_PLAYER_CID) {
    const at = foundedLotAt(session, b);
    if (!at || !b.costs) return;
    postPileHauls(
      session,
      {
        pileId: orderPileId(b.ord),
        legacyPileId: sitePileId(b.ord), // founding ords are immortal — same number
        at,
        missing: stagingMissing(b),
        glyph: resolveStructure(structureCatalogOf(session), b.type)?.glyph ?? "yard",
      },
      issuer,
    );
  }

  // ── THE BLOCK CHAIN (phase 3 — construction-phase3-plan.md) ─────────────
  // Blocks are the one construction primitive; raws (wood, stone) refine
  // into them at a bench. The chain is CHAINED ORDERS all the way down: a
  // costed order starving on a refinable head posts a REFINE order instead
  // of toasting; the refine order's own raw bill fells trees through the
  // ordinary haul/twin machinery; a refine starving on raws keeps the
  // honest starved toast. Nothing here is a new lifecycle — every rung is
  // the one order loop.

  /** The work TYPE a raw refines at when the catalogue doesn't say — the
   *  CARPENTRY, because milling wood at a carpenter's bench is what the whole
   *  chain did before phase 5 split the trades, and an unmarked raw must keep
   *  doing exactly that. */
  const REFINE_WORK_DEFAULT = "workshop";

  /** The DOORSTEP of the town's standing work building of a given type —
   *  completed and un-vacated — or null when the town has none.
   *
   *  Split out of `refineSpotOf` because "does that trade STAND here?" is the
   *  same question `ensureRefineOrders` asks when it decides which raw to cut
   *  first, and a town that answers it two different ways is a town whose
   *  masons queue at the carpentry. */
  function refineStationSpot(
    session: QuestSession,
    workType: string = REFINE_WORK_DEFAULT,
  ): { x: number; y: number } | null {
    const t = session.town;
    if (!t) return null;
    for (let wi = 0; wi < t.plan.works.length; wi++) {
      const wk = t.plan.works[wi]!;
      if (wk.vacated || wk.type !== workType) continue;
      // A staked-out founding is not a standing station until its labor is in.
      const fb =
        wk.foundedOrd !== undefined
          ? t.deltas.founded().find((f) => f.ord === wk.foundedOrd)
          : undefined;
      if (fb && !foundedBuildingDone(fb, buildDayNow(session))) continue;
      return workDoorstep(t.stage.center, wk);
    }
    return null;
  }

  /**
   * Where milling happens, for the raw being milled. The work TYPE is the
   * CATALOGUE's (products.ts `refinesTo.at` — wood mills at the carpentry,
   * stone cuts at the masonry), so the routing lives with the material rather
   * than being hard-coded here; an unmarked raw keeps the carpentry.
   *
   * `at` NEVER GATES — stations.ts:422's law for the craft bench, and it holds
   * exactly as hard here. With no masonry standing, stone still cuts: at the
   * yard crate's spot, then the town center / founded site, which is precisely
   * where every raw refined before the split. The station is somewhere the
   * work GOES when there is one, never permission to do the work at all.
   * Null only with no deltas store of any kind.
   */
  function refineSpotOf(
    session: QuestSession,
    workType: string = REFINE_WORK_DEFAULT,
  ): { x: number; y: number } | null {
    const t = session.town;
    if (t) {
      return (
        refineStationSpot(session, workType) ??
        containerAnchor(session, TOWN_YARD_EP) ??
        t.stage.center
      );
    }
    const site = session.foundedSite;
    if (site) return containerAnchor(session, SITE_STOCK_ID) ?? site.at;
    return null;
  }

  /** The container milled blocks LAND in: a communal container standing
   *  inside a completed STOREHOUSE (storehouse-first — the town's block
   *  bank), else the yard / site crate. Null = mint into deltas.stock
   *  directly (the yard aliases it anyway). */
  function refineDepositId(session: QuestSession): string | null {
    const t = session.town;
    if (t) {
      const wildIds = new Set(
        (session.wilderness?.features ?? []).map((f) => wildFeatureContainerId(f)),
      );
      for (let wi = 0; wi < t.plan.works.length; wi++) {
        const wk = t.plan.works[wi]!;
        if (wk.vacated || wk.type !== "storehouse") continue;
        const fb =
          wk.foundedOrd !== undefined
            ? t.deltas.founded().find((f) => f.ord === wk.foundedOrd)
            : undefined;
        if (fb && !foundedBuildingDone(fb, buildDayNow(session))) continue;
        const rect = {
          x: t.stage.center.x + wk.dx,
          y: t.stage.center.y + wk.dy,
          w: wk.w,
          h: wk.h,
        };
        for (const boxId of session.containerStock.keys()) {
          // A COMMUNAL registered crate, never a wild feature that happens
          // to stand on the lot (a tree is not shelving).
          if (wildIds.has(boxId)) continue;
          if (session.containerOwner.get(boxId) !== null && session.containerOwner.get(boxId) !== undefined) continue;
          if (session.marketStore.has(boxId) || session.produceBox.has(boxId)) continue;
          const at = containerAnchor(session, boxId);
          if (!at) continue;
          if (at.x >= rect.x && at.x <= rect.x + rect.w && at.y >= rect.y && at.y <= rect.y + rect.h) {
            return boxId;
          }
        }
      }
      return session.containerStock.has(TOWN_YARD_EP) ? TOWN_YARD_EP : null;
    }
    if (session.foundedSite) {
      return session.containerStock.has(SITE_STOCK_ID) ? SITE_STOCK_ID : null;
    }
    return null;
  }

  /** ENSURE the chain covers a starved bill: for each missing head a raw
   *  refines into, keep ONE standing refine order sized to the shortfall
   *  (a remainder re-triggers after the commit). Returns what the chain
   *  cannot reach (`rest` — the honest starved toast's bill) and how many
   *  units are being milled (`milling` — the softer message). */
  function ensureRefineOrders(
    session: QuestSession,
    want: Record<string, number>,
    /** The author the starved bill belongs to — the ranking below measures
     *  reachable raws through that author's own reach, so a chained refine
     *  order can never be ranked on stock the order itself may not draw. */
    issuer: string = LOCAL_PLAYER_CID,
  ): { milling: number; rest: Record<string, number> } {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    const rest: Record<string, number> = {};
    let milling = 0;
    if (!deltas) return { milling, rest: { ...want } };
    for (const [head, n] of Object.entries(want)) {
      const raws = rawsForRefined(head);
      if (!raws.length) {
        rest[head] = n;
        continue;
      }
      const open = deltas
        .refineOrders()
        .filter((r) => stackHead(r.produces) === head)
        .reduce((s, r) => s + r.count, 0);
      if (open >= n) {
        milling += open;
        continue;
      }
      // WHICH RAW, in three keys. Each candidate is measured AT ITS OWN SPOT,
      // because since the masonry split the spot is a function of the raw:
      // what a mason can reach from the masonry is not what a carpenter can
      // reach from the carpentry.
      //  1. reachable FREE units — a raw with none is not one we can cut today
      //     (unchanged, and still the first key: `at` never gates, so a town
      //     with a masonry and no stone mills its wood);
      //  2. whether the trade that works it STANDS — a town with a masonry and
      //     no carpentry cuts its stone before it mills its wood, because the
      //     work goes three times faster where the bench is;
      //  3. CATALOGUE order (wood before stone), the tie-break that has always
      //     been, kept last so the choice stays deterministic.
      // A raw-less world still posts on key 3 alone, and the refine order
      // itself starves naming the raw — the honest failure, not a silent one.
      const ranked = raws
        .map((p, i) => {
          const spot = refineSpotOf(session, p.refinesTo?.at);
          const free = spot
            ? siteMaterialSources(session, spot, issuer).reduce(
                (s, src) => s + freeUnits(src.stack, session.reservations, src.id, p.glyph),
                0,
              )
            : 0;
          return { p, spot, free, stands: !!refineStationSpot(session, p.refinesTo?.at), i };
        })
        .sort(
          (a, b) =>
            (b.free > 0 ? 1 : 0) - (a.free > 0 ? 1 : 0) ||
            (b.stands ? 1 : 0) - (a.stands ? 1 : 0) ||
            a.i - b.i,
        );
      const pick = ranked[0]!;
      const raw = pick.p;
      const at = pick.spot;
      if (!at) {
        rest[head] = n;
        continue;
      }
      const count = n - open;
      deltas.postRefineOrder({
        produces: refinedGlyphOf(raw.glyph) ?? head,
        count,
        costs: { [raw.glyph]: count * (raw.refinesTo?.inPerOut ?? 1) },
        pile: {},
        at,
        startedDay: buildDayNow(session),
        buildDays: constructionGameDays(REFINE_UNIT_BUILD_DAYS * count, session.scale),
      });
      milling += count;
    }
    return { milling, rest };
  }

  /** COMMIT a finished refine (the per-kind executor): consume the raw
   *  bill FROM the pile, then mint — never the reverse (the craftItems
   *  law: a mill that eats its inputs and produces nothing is the bug
   *  class the ordering prevents). The product lands storehouse-first;
   *  any pile remainder banks with it; the row retires. */
  function commitRefineOrder(session: QuestSession, r: RefineOrder): void {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas) return;
    if (Object.keys(stagingMissing(r)).length) return; // pile ran thin — regather
    for (const [head, n] of Object.entries(r.costs)) takeStock(r.pile, head, n);
    const destId = refineDepositId(session);
    const stack = destId
      ? (session.containerStock.get(destId) ?? {})
      : (deltas.stock as Record<string, number>);
    if (destId) session.containerStock.set(destId, stack);
    stack[r.produces] = (stack[r.produces] ?? 0) + r.count;
    for (const [g, n] of Object.entries(r.pile)) {
      if (n > 0) stack[g] = (stack[g] ?? 0) + n;
      delete r.pile[g];
    }
    // ⏸️ THE MILL DELIVERED — a container gained units. This is the wake the
    // craft job parked on a refinable bill is actually waiting for: it posted
    // the refine order, and the blocks landing here is what makes a re-gather
    // worth doing. (`destId` null ⇒ the deltas' own stock, which no park
    // reads; bumping either way costs one re-decide and keeps one rule.)
    bumpStockEpoch(session);
    presenter.toast(`🪚 ${r.count} ${stackHead(r.produces)} milled and stored`, "feedback");
    deltas.removeOrder(r.ord);
  }

  /** Is this endpoint a communal STOCK delivery target — the yard, the
   *  founded-site crate, the storehouse's own crate? A haul to it is the
   *  town's business (the civic volunteer rules, like the site piles) —
   *  par-stock logging recruits exactly like construction hauling. */
  function isCivicStockDest(session: QuestSession, id: string): boolean {
    return id === TOWN_YARD_EP || id === SITE_STOCK_ID || id === refineDepositId(session);
  }

  /** PAR-STOCK LOGGING (phase 3 step 3): a town with a standing STOREHOUSE
   *  keeps raw materials on hand as a standing activity — free stored raws
   *  under STOREHOUSE_RAW_PAR post civic gather hauls from WILD sources
   *  (standing trees, rock — felled/quarried at drain by the ordinary haul
   *  machinery). Observed-only by design: an unwatched town needs no
   *  ambient stocking (unobserved construction twins draw straight from
   *  the wild), so the walkers this posts are always a rendered cause. */
  let storehouseStockAt = 0;
  function stepStorehouseStock(session: QuestSession, issuer: string = LOCAL_PLAYER_CID): void {
    const t = session.town;
    if (!t || !world) return;
    if (session.taskClock < storehouseStockAt) return;
    storehouseStockAt = session.taskClock + STOREHOUSE_STOCK_RETRY_S;
    const destId = refineDepositId(session);
    if (!destId) return;
    // The par loop is the STOREHOUSE'S behavior — no storehouse, no
    // ambient logging (the yard is a buffer, not a mandate).
    let store: { x: number; y: number } | null = null;
    for (let wi = 0; wi < t.plan.works.length; wi++) {
      const wk = t.plan.works[wi]!;
      if (wk.vacated || wk.type !== "storehouse") continue;
      const fb =
        wk.foundedOrd !== undefined
          ? t.deltas.founded().find((f) => f.ord === wk.foundedOrd)
          : undefined;
      if (fb && !foundedBuildingDone(fb, buildDayNow(session))) continue;
      store = workDoorstep(t.stage.center, wk);
      break;
    }
    if (!store) return;
    if (!observedRect(session, { x: store.x - 2, y: store.y - 2, w: 4, h: 4 })) return;
    const wildIds = new Set(
      (session.wilderness?.features ?? []).map((f) => wildFeatureContainerId(f)),
    );
    const sources = siteMaterialSources(session, store, issuer);
    const led = session.reservations;
    // ACKNOWLEDGE finished stocking hauls (the staging sweep's done-release,
    // applied to the yard): a FAILED haul's spoken-for source units must
    // free up or the next window resolves nothing over them — the stone par
    // wedged exactly there (GL-found: four failed rock hauls left every
    // stone on the map reserved forever). Done hauls' leftovers (partial
    // loads) release the same way; the landed units are free stock already.
    const inbound: Record<string, number> = {};
    for (const a of session.transfers.all()) {
      if (a.to !== destId) continue;
      if (a.status === "done" || a.status === "failed") {
        led.release(agrHolder(a.id));
      } else if (a.status === "pending" || a.status === "moving") {
        for (const [g, n] of Object.entries(a.goods)) {
          const head = stackHead(g);
          inbound[head] = (inbound[head] ?? 0) + n;
        }
      }
    }
    for (const p of rawsForRefined(BLOCK_GLYPH)) {
      const free = sources
        .filter((s) => !wildIds.has(s.id))
        .reduce((s, src) => s + freeUnits(src.stack, led, src.id, p.glyph), 0);
      // Loads already walking count toward the par — the retry window must
      // top up the SHORTFALL, never re-order the whole batch.
      const wantN = STOREHOUSE_RAW_PAR - free - (inbound[p.glyph] ?? 0);
      if (wantN <= 0) continue;
      const tmp = `stock:${destId}:${p.glyph}`;
      const { draws } = resolveMaterials({
        holder: tmp,
        costs: { [p.glyph]: wantN },
        sources: sources.filter((s) => wildIds.has(s.id)),
        ledger: led,
      });
      for (const d of draws) {
        const a = session.transfers.post({
          from: d.endpoint,
          to: destId,
          goods: { [d.glyph]: d.take },
          issuer,
          mode: "haul",
          now: session.taskClock,
          sourceGlyph: `bring ${d.take} ${d.glyph}`,
        });
        led.reserve(agrHolder(a.id), d.endpoint, d.glyph, d.take);
        postPooledTask(
          session,
          { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: "storehouse" } },
          issuer,
          { x: store.x, y: store.y, radius: civicRecruitRadius(session) },
          `bring ${d.take} ${d.glyph}`,
        );
      }
      led.release(tmp);
    }
  }

  function executeBuildOrder(
    session: QuestSession,
    spec: StructureSpec,
    candidate: FoundingCandidate,
    builder: string | null,
    issuer: string = LOCAL_PLAYER_CID,
  ): FoundedBuilding | null {
    const ctx = buildContext(session);
    if (!ctx) return null;
    // PIPELINE ② (construction-pipeline.md): the order is a DESIGNATION —
    // nothing is paid up front. The costs ride the row; hauls bring the
    // materials to the staked plot; labor runs from the day the pile covers
    // the bill (the staging sweep), not from today.
    // A structure's catalog buildDays are RELATIVE (house = 1); the session's
    // scale turns them into game-days — half a year of them at realism, one
    // street-day on the shipped town profile (space-time-compression.md §4).
    const b = ctx.deltas.foundBuilding(
      candidate,
      buildDayNow(session),
      constructionGameDays(spec.buildDays, session.scale),
      spec.costs,
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
        ...(spec.shell ? { bare: true } : {}),
        jobs: 0,
        foundedOrd: b.ord,
      });
    } else if (session.foundedSite) {
      noteSiteBuilding(session.foundedSite);
      refreshWildFounded(session);
    }
    // A zero-bill structure stages instantly (labor from today — exactly the
    // pre-pipeline clock); everything else waits on its hauls.
    if (!Object.keys(stagingMissing(b)).length) {
      ctx.deltas.stageFounded(b.ord, b.startedDay);
    } else {
      postSiteHauls(session, b, issuer);
    }
    if (builder) {
      const target = workDoorstep(ctx.center, {
        type: spec.type, color: spec.color, dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
      });
      session.needStep.delete(builder);
      session.npcTasks.delete(avatarIdOf(builder));
      session.lastDrive.set(avatarIdOf(builder), "build");
      // A hand-built one-leg plan: the walk is the whole errand and nothing
      // chooses between alternatives here, so it carries a ZERO price rather
      // than a made-up one (step ④ — an unpriced plan is a first-class state).
      issueGoalPlan(session, builder, { steps: [{ kind: "moveTo", pos: target }], cost: priceOf({}) });
    }
    return b;
  }

  /** The wilderness site's founded buildings, raised into the live world:
   *  marked SITES while building (flat reserved plots — city-founding
   *  "construction sites"), real doored rooms + work furniture (registered
   *  containers) when done. Idempotent — call on any change. */
  const wildFoundedIds = new Set<string>();
  const wildFurnishedOrds = new Set<number>();
  function refreshWildFounded(session: QuestSession) {
    const site = session.foundedSite;
    if (!site || !world) return;
    const day = buildDayNow(session);
    const specs: BuildingSpec[] = [];
    const sites: ConstructionSite[] = [];
    for (const b of site.deltas.founded()) {
      const spec = resolveStructure(structureCatalogOf(session), b.type);
      const wk = {
        dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
        ...(spec?.stations ? { stations: spec.stations } : {}),
        ...(spec?.shell ? { bare: true } : {}),
      };
      if (!foundedBuildingDone(b, day)) {
        sites.push({
          id: `site_wf_${b.ord}`,
          x: site.at.x + b.dx, y: site.at.y + b.dy, w: b.w, h: b.h,
          type: b.type,
          // ⑦ — the same ladder a town site climbs, and the same icon.
          stage: Math.min(foundedStage(b, day), 2) as 0 | 1 | 2,
          progress: foundedProgress(b, day),
          ...(spec ? { glyph: structureDisplayGlyph(spec) } : {}),
          ...(spec?.color ? { color: spec.color } : {}),
        });
        continue;
      }
      const roomPlan = buildingRoomPlan(
        site.at, 1000 + b.ord, wk, spec?.program ?? { store: true },
        site.deltas.get(`f_${b.ord}`),
      );
      // Openings this shell has no leaf for yet (phase 5) — the same read the
      // town stage does, because a wilderness shell is raised by the same
      // pipeline and must show the same bare doorways.
      const doorless = doorlessOf(site.deltas.get(`f_${b.ord}`));
      for (const room of roomPlan.rooms) {
        specs.push({
          id: room.id,
          footprint: room.rect,
          floors: 1, stairs: false, wallThickness: 0.4,
          doorways: doorwaysWithLeaves(room, room.doorways, doorless),
          color: spec?.color ?? "#9b8a6d",
        });
      }
      if (!wildFurnishedOrds.has(b.ord)) {
        wildFurnishedOrds.add(b.ord);
        for (const piece of workFurniture(
          site.at, 1000 + b.ord, wk, spec?.program ?? { store: true }, "",
          site.deltas.get(`f_${b.ord}`),
        )) {
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
    world.setReservedGround(sites.map(({ x, y, w, h }) => ({ x, y, w, h })));
    questViewOf()?.setSites?.(sites); // phase 1a: host state via accessor
    lastSites = sites;
  }

  /** The plan-works index a building delta key names (f_<ord> → the founded
   *  row's live index; w_<i> → i). -1 when it names nothing standing. */
  function workIndexOfKey(session: QuestSession, key: string): number {
    const t = session.town;
    if (!t) return -1;
    const fm = /^f_(\d+)$/.exec(key);
    if (fm) return t.plan.works.findIndex((w) => w.foundedOrd === Number(fm[1]));
    const wm = /^w_(\d+)$/.exec(key);
    return wm ? Number(wm[1]) : -1;
  }

  /**
   * WORK-BUILDING PROGRAM PULL (pipeline ⑥ — recursion's craft-designation
   * leg): a standing program row on a completed work building (a shell's
   * ordered bedroom) PULLS its required furniture. A stored `furn.<kind>`
   * stack anywhere usable is hauled over as a CIVIC task (any resident may
   * carry it — the `bfurn:` delivery pile); none stored starts a CRAFT JOB
   * at the family's house, bench-first (the ④ automation law) — the shell's
   * bed recurses into wood, which recurses into the felled tree. One action
   * per sweep; per-building rate limit.
   */
  function stepShellPrograms(session: QuestSession, issuer: string = LOCAL_PLAYER_CID) {
    const t = session.town;
    if (!t || !world) return;
    const day = buildDayNow(session);
    for (let wi = 0; wi < t.plan.works.length; wi++) {
      const wk = t.plan.works[wi]!;
      if (wk.vacated) continue;
      const key = workDeltaKey(wk, wi);
      // A BARE DOORWAY IS A WANT TOO (phase 5): a shell may carry no program
      // row at all and still be missing every one of its doors, so the sweep
      // must not be gated on the program list alone. Read as LENGTHS here —
      // this line runs for every work on every sweep, and the real work list
      // (a room plan, a furnish pass, placement searches) is only worth
      // computing past the rate limit below.
      const gate = t.deltas.get(key);
      const wantsDoor = ((gate?.doorless?.length) ?? 0) > 0;
      if (!gate?.programs?.length && !wantsDoor && !hasDrift(gate)) continue;
      const fb =
        wk.foundedOrd !== undefined
          ? t.deltas.founded().find((f) => f.ord === wk.foundedOrd)
          : undefined;
      if (fb && !foundedBuildingDone(fb, day)) continue; // walls first
      // A SHELL RE-DRAWS TOO. Cutting a room out of a workshop moves the same
      // registry-placed furniture a house's annex moves, so the same carry
      // sweep runs here (blueprint.ts). It is gated on its own clock inside.
      stepBlueprintReflow(session, key);
      if (session.taskClock < (shellProgramAt.get(key) ?? 0)) continue;
      shellProgramAt.set(key, session.taskClock + 20);
      const center = t.stage.center;
      // THE FROZEN CARRIER (phase 4 step 4 — the phase-2 order-pile fix,
      // applied to the shell pipeline): an UNOBSERVED building's inbound
      // furniture haul may be walked by a body that never steps, and the
      // deferral below defers to in-flight goods honestly — so the delivery
      // "underway" never arrives and the row waits forever. Resolve them the
      // way every other unobserved pile does: a LOADED carrier lands
      // hands→pile through the seam's law (the pile drains next sweep), an
      // unloaded one fails named so this sweep re-posts.
      const bRect = { x: center.x + wk.dx, y: center.y + wk.dy, w: wk.w, h: wk.h };
      if (!observedRect(session, bRect)) twinResolveHauls(session, `${BFURN_EP}${key}`, undefined, issuer);
      const pile = shellFurnPilesOf(session).get(key) ?? {};
      const inbound = new Set<string>();
      for (const a of session.transfers.active()) {
        if (a.to === `${BFURN_EP}${key}`) for (const g of Object.keys(a.goods)) inbound.add(g);
      }
      /**
       * ASK FOR ONE PIECE — the body every want of this building shares
       * (extracted verbatim in phase 5 so the DOOR leg below is the same
       * request as a bed's, not a parallel machine beside it):
       *   "skip"  nothing to make — non-craftable; the caller moves on
       *   "wait"  one is already in the pile or on the road; don't re-order
       *   "done"  an action was taken (or the one crafter is busy) — the
       *           sweep's one-action-per-tick budget is spent
       */
      const requestPiece = (k: StationKind): "skip" | "wait" | "done" => {
        const fdef = furnitureItemOf(k);
        if (!fdef?.craft) return "skip"; // non-craftables come with generation
        const glyph = furnitureGlyph(k);
        if ((pile[glyph] ?? 0) > 0 || inbound.has(glyph)) return "wait"; // delivery underway
        const at = {
          x: center.x + wk.dx + wk.w / 2,
          y: center.y + wk.dy + wk.h / 2,
        };
        // ⚖️ THE THIRD COPY, RETIRED (scope-behaviors.md §2.2): the inline
        // nearest-first sort that used to live here is now the ONE priced walk,
        // with this call's own "does it hold one" test passed in.
        const src = rankPricedSources(
          siteMaterialSources(session, at, issuer),
          (s) => s.stack[glyph] ?? 0,
        )[0];
        if (src) {
          const a = session.transfers.post({
            from: src.id,
            to: `${BFURN_EP}${key}`,
            goods: { [glyph]: 1 },
            issuer,
            mode: "haul",
            now: session.taskClock,
            sourceGlyph: `bring ${k}`,
          });
          postPooledTask(
            session,
            { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: k } },
            issuer,
            { x: at.x, y: at.y, radius: civicRecruitRadius(session) },
            `bring ${k}`,
          );
          return "done";
        }
        // NONE STORED — the craft designation: the family's house makes
        // it (bench-first). Busy crafter ⇒ retry next sweep.
        //
        // ⚠️ THE BENCH-FIRST FORK IS ④'s ENABLE COMPARISON, HARD-CODED
        // (scope-behaviors.md §2.4 — "the workbench bootstrap … enabler-shaped,
        // hard-coded, correct, and the proof the pattern is wanted"). It is
        // literally the basket question at a different rung: build the enabler
        // first because `CRAFT_STATION_FACTOR = 1/3` triples the work rate,
        // exactly as a basket multiplies the units a trip moves. It stays a
        // boolean this pass ON PURPOSE — a station's cost is a build order with
        // its own bill and its own labour clock, and pricing that needs the
        // station costs that land with §7 step 6. When they do, this fork
        // FOLDS INTO `haulBagLeg`'s arithmetic rather than living beside it.
        const hi = familyOf(session)?.house ?? t.plan.houses[0]?.index;
        if (hi === undefined || craftJobsOf(session).get(hi)) return "done";
        const target =
          houseBench(session, hi) || houseHolds(session, hi, furnitureGlyph("workbench")) > 0
            ? fdef
            : furnitureItemOf("workbench")!;
        craftJobsOf(session).set(hi, {
          ...furnitureCraftRecipe(target),
          spotId: craftSpotOf(session, hi),
          agreements: [],
          laborS: 0,
        });
        return "done";
      };
      // ── THE DOORS (phase 5). A doorway with no leaf wants a `furn.door`
      // exactly the way a bedroom wants a bed — same haul-then-craft ladder,
      // same pile, same one-action budget. Asked FIRST because a shell full of
      // holes is what you actually see, and because the count is bounded: one
      // request per sweep, one leaf per opening, and the request stops the
      // moment `doorless` empties. A leaf already in the pile ("wait") falls
      // through to the program rows so furniture isn't stuck behind the doors.
      if (wantsDoor && requestPiece("door") === "done") return;
      // THE EMPTY PLACES IN THIS SHELL'S DRAWING (blueprint.ts). Only `make`
      // reaches the request ladder: a piece already standing in the wrong room
      // is the re-flow sweep's job (carry it), one already in this shell's pile
      // is the placement sweep's (stand it up), and neither should be bought or
      // built a second time.
      for (const task of buildingFurnishTasks(session, key)) {
        if (task.act !== "make") continue;
        const r = requestPiece(task.kind);
        if (r === "skip") continue;
        if (r === "wait") break;
        return; // one action per sweep
      }
    }
  }

  /** Stand DELIVERED furniture up (⑥): a `bfurn:` pile's stack becomes a
   *  PlacedPiece the sweep after it lands — searched in the room whose
   *  program wants the kind, else the kind's own cell. The stage's work
   *  rev-watch raises the fixture the same frame. */
  function stepShellFurnPlacement(session: QuestSession) {
    const t = session.town;
    if (!t || !world) return;
    for (const [key, pile] of shellFurnPilesOf(session)) {
      const glyphs = Object.keys(pile).filter((g) => (pile[g] ?? 0) > 0);
      if (!glyphs.length) {
        shellFurnPilesOf(session).delete(key);
        continue;
      }
      const wi = workIndexOfKey(session, key);
      const wk = wi >= 0 ? t.plan.works[wi] : undefined;
      if (!wk) continue;
      const center = t.stage.center;
      const program = wk.program ?? workProgram(wk.type);
      for (const g of glyphs) {
        const kind = furnitureKindOfGlyph(g);
        const fdef = kind ? furnitureItemOf(kind) : undefined;
        if (!kind || !fdef) {
          delete pile[g]; // not furniture — never posted by us; drop honestly
          continue;
        }
        // Re-derive plan+pieces per placement (the previous piece changed them).
        const delta = t.deltas.get(key);
        const plan = buildingRoomPlan(center, wi, wk, program, delta);
        const pieces = workFurniture(center, wi, wk, program, "", delta);
        // ── HANG A DELIVERED LEAF (phase 5). A door does not land on a floor
        // spot: it goes into an OPENING, so the placement search is replaced
        // by "the first doorway of this building that still has no leaf". The
        // delta write is `hangDoor` — one move that drops the key AND records
        // the piece, so the doorway can never be observed with a leaf hanging
        // in a hole the engine still reports open.
        if (kind === "door") {
          const doorless = doorlessOf(delta);
          plan.rooms.some((room) =>
            room.doorways.some((d) => {
              const dk = doorwayKeyOf(room, d);
              if (!doorless.has(dk)) return false;
              const at = doorwayWorldPoint(room, d);
              const piece = {
                id: `furn_w${wi}_p${nextPlacedSerial(delta)}`,
                kind,
                // The opening's own midpoint — a hung leaf claims no floor, so
                // this is provenance (where to aim a `break`), not a footprint.
                x: at.x,
                y: at.y,
                radius: fdef.radius,
                facing: 0, // the doorway's geometry owns the swing, not the row
                openable: false,
                roomId: room.id,
                doorway: dk,
              };
              if (!hangDoor(t.deltas, key, piece)) return false;
              // No `setUp: false`: a door is hung, not delivered-then-assembled
              // — there is no tipped-on-its-side pose for a thing that lives
              // inside a wall.
              stackTake(pile, g);
              presenter.toast(`🚪 a door is hung in the ${room.kind}`, "feedback");
              return true;
            }),
          );
          // Nothing left to hang it in (a stale key, a room that moved)? The
          // leaf simply STAYS IN THE PILE — dropping it would destroy a real
          // unit (item conservation), and an idle pile costs nothing. Same
          // shape as the "no legal spot yet" arm below.
          continue;
        }
        // THE OUTLINE IS THE SPOT (blueprint.ts). The delivery lands on the
        // mark the drawing gave it — the same mark the ghost has been standing
        // on since the piece was ordered — and only falls back to a fresh
        // search when the drawing has no place for this kind (an unasked-for
        // delivery) or the floor has been taken since it was drawn.
        const wanted = buildingFurnishTasks(session, key).find(
          (q) => q.kind === kind && (q.act === "install" || q.act === "make"),
        )?.slot;
        const wantRoom = wanted ? plan.rooms.find((r) => r.id === wanted.roomId) : undefined;
        const pctx = makePlacementContext(center, wk, plan, [], [...pieces]);
        const spot =
          (wanted &&
          placementFeasible(pctx, wanted.roomId, {
            x: wanted.x, y: wanted.y, radius: fdef.radius, kind,
          }).ok
            ? { x: wanted.x, y: wanted.y, facing: wanted.facing, roomId: wanted.roomId }
            : undefined) ??
          placementCandidates(pctx, {
            kind,
            radius: fdef.radius,
            ...(wantRoom ? { roomId: wantRoom.id } : {}),
          })[0];
        if (!spot) continue; // no legal spot yet — retry next sweep
        stackTake(pile, g);
        // Delivered, not yet assembled: it stands on its side until the setup
        // sweep (with a nearby resident's work reach) rises it upright.
        placeFurniture(t.deltas, key, {
          id: `furn_w${wi}_p${nextPlacedSerial(t.deltas.get(key))}`,
          kind,
          x: spot.x,
          y: spot.y,
          radius: fdef.radius,
          facing: spot.facing,
          openable: fdef.openable,
          roomId: spot.roomId,
          setUp: false,
        });
        presenter.toast(`🪑 the ${kind} arrives for the ${wantRoom?.kind ?? "building"}`, "feedback");
      }
    }
  }

  let furnitureSetupT = 0;
  /** DELIVERED-FURNITURE STAND-UP sweep (~1 s, construction ⑥ visuals): a
   *  piece placed TIPPED on its side (setUp:false) is stood upright once its
   *  short hold elapses — the renderer eases it from flat to standing (the
   *  settle). A capable resident within reach plays a work reach as it rises
   *  (reusing the carry gesture); with nobody about it simply rises on its own,
   *  so a piece is never stuck lying down. Generic over every furniture kind —
   *  the flag drives it, no per-kind code. */
  function stepFurnitureSetup(session: QuestSession, dt: number) {
    const t = session.town;
    if (!t || !world) return;
    furnitureSetupT += dt;
    if (furnitureSetupT < 1) return;
    const span = furnitureSetupT;
    furnitureSetupT = 0;
    for (const key of t.deltas.keys()) {
      const d = t.deltas.get(key);
      if (!d) continue;
      for (const p of d.placed) {
        if (p.setUp !== false) continue;
        const hk = `${key}|${p.id}`;
        const rem = (furnitureSetupHold.get(hk) ?? FURN_SETUP_HOLD_S) - span;
        if (rem > 0) {
          furnitureSetupHold.set(hk, rem);
          continue;
        }
        // Hold elapsed — set it up. Nearest capable resident (hands, so no pet)
        // within reach does the stand-up work reach; else it simply rises.
        let worker: string | undefined;
        let bestD = FURN_SETUP_R;
        for (const [id, av] of Object.entries(world.state.avatars)) {
          if (!id.startsWith("resident_") || av.canOpen === false) continue;
          const dd = Math.hypot(av.x - p.x, av.y - p.y);
          if (dd <= bestD) {
            bestD = dd;
            worker = id;
          }
        }
        if (worker) fireCarryGesture(worker, "putdown", { x: p.x, y: p.y });
        markPieceSetUp(t.deltas, key, p.id);
        furnitureSetupHold.delete(hk);
      }
    }
  }

  /**
   * MAKE THE FURNITURE REAL — the one move the whole blueprint/house split
   * rests on (blueprint.ts).
   *
   * The station generator answers "where should furniture stand in a house
   * shaped like this". That is a BLUEPRINT, and the engine had been reading it
   * as the furniture: nothing was stored, so every piece was re-derived from
   * the current plan on every read. Put a kitchen on the back of a house and
   * the answer changed — so, in one frame, the refrigerator was in the kitchen.
   * Nothing had moved. The question had.
   *
   * So the FIRST time a building's shape is about to change, its furniture is
   * instantiated from the drawing as it stands and recorded. From then on the
   * generator never runs for that building again (`materialized`) — it only
   * ever draws, and what it draws is where somebody carries things to.
   *
   * LAZY on purpose. A town nobody has rebuilt keeps an empty overlay and
   * derives exactly as it always did, so worldgen, determinism and save size
   * are untouched for every untouched house — and a building that is
   * materialized was, by definition, about to be changed anyway.
   *
   * MUST run BEFORE the plan mutates. It is the pre-change state that is real.
   */
  function materializeFurniture(session: QuestSession, buildingKey: string): void {
    const t = session.town;
    const b = pendingBuildingOf(session, buildingKey);
    if (!t || !b || t.deltas.get(buildingKey)?.materialized) return;
    const pieces = buildingFurnitureOf(session, buildingKey);
    const rows = materializedRows(pieces, b.plan.rooms, t.deltas.get(buildingKey)?.placed ?? []);
    t.deltas.mutate(buildingKey, (d) => {
      // Flag and rows together, always: a building observed `materialized` with
      // an empty list is a house whose furniture vanished.
      d.materialized = true;
      d.placed.push(...rows);
    });
  }

  /**
   * WHAT IS IN MY WAY, AND DOES IT BELONG THERE (the bump rule).
   *
   * A house mid-rearrangement has furniture standing in places the routes were
   * never planned around — a chest across the only line between the door and
   * the hearth, a bed left where a partition just went up. A body pressed
   * against one of those has no way past and no patience to model: it takes the
   * thing apart on the spot, and the piece becomes the item it is made of.
   *
   * ONLY A DISPLACED PIECE. Something standing on its own blueprint mark is
   * part of the house, and walking into your own table is not a reason to
   * destroy it — that is what routing is for. The rule is scoped to exactly the
   * pieces the drawing does not account for, which is why it can be this blunt
   * without ever eating a room.
   */
  /** How close counts as bumping into it — a hand's width past contact, so a
   *  body pressed up against a chest registers and one merely walking past
   *  does not. */
  const BUMP_TOUCH_M = 0.1;
  /** How often the press check runs. The housekeeping sweep is per-tick, and
   *  "immediately" at half a second is still immediately to anyone watching. */
  const BUMP_CHECK_S = 0.5;
  const bumpAt = new Map<string, number>();

  function stepStrayBumps(session: QuestSession, buildingKey: string) {
    const t = session.town;
    if (!t || !world) return;
    if (session.taskClock < (bumpAt.get(buildingKey) ?? 0)) return;
    bumpAt.set(buildingKey, session.taskClock + BUMP_CHECK_S);
    const slots = buildingBlueprintOf(session, buildingKey).slots;
    // Every piece the drawing does not account for, whatever put it there — a
    // re-draw, a delivery that landed badly, a room that came down around it.
    // Street-good boxes are exempt for the usual reason (the economy's wiring,
    // and breaking one duplicates a unit).
    const stray = buildingFurnitureOf(session, buildingKey).filter(
      (p) => !p.good && !pieceAtItsSlot(p, slots),
    );
    if (!stray.length) return;
    for (const p of stray) {
      for (const [id, av] of Object.entries(world.state.avatars)) {
        // TOUCHING, not overlapping. Locomotion refuses to enter the piece's
        // square footprint at all, so a body stopped dead against a chest rests
        // exactly at the sum of the two extents and never a millimetre inside
        // it — testing for overlap would have meant this rule could essentially
        // never fire, which is the one thing it cannot afford, because the case
        // it exists for is somebody who cannot get out of a room.
        const near = p.radius + world.npcRadiusOf(id) + BUMP_TOUCH_M;
        if (Math.abs(av.x - p.x) > near || Math.abs(av.y - p.y) > near) continue;
        fireCarryGesture(id, "pickup", { x: p.x, y: p.y });
        orderBreakPiece(session, buildingKey, p.id, { incidental: true });
        return; // one per sweep — the delta just changed under everything above
      }
    }
  }

  /** How long a building waits between carries. One piece at a time, at
   *  walking pace — a re-arranged house should settle over a visible minute or
   *  so, which is the whole difference between furniture being MOVED and
   *  furniture having CHANGED. Long enough that it reads as work being done;
   *  short enough that a doorway somebody is standing in front of clears while
   *  they are still trying to get through it. */
  const REFLOW_GAP_S = 12;
  /** townClock second before a building may start its next carry. */
  const reflowAt = new Map<string, number>();

  /**
   * WHO CARRIES IT. A house's own household comes first — rearranging your home
   * is your own business — and anyone standing about a work shell will do,
   * which is the same "everyone works together" rule the civic tasks run on.
   * Null = nobody free right now, and the sweep simply waits.
   */
  function reflowHandFor(session: QuestSession, buildingKey: string): string | null {
    if (!world) return null;
    const free = (id: string): boolean => !session.npcTasks.get(id)?.length;
    const hm = /^h_(\d+)$/.exec(buildingKey);
    if (hm) {
      // ANY member of the household, in order — not just member 0, who is as
      // likely as anyone to be out at the well. A house with everybody busy
      // simply waits for the next sweep.
      for (let m = 0; m < HOUSEHOLD; m++) {
        const id = avatarIdOf(`resident_${hm[1]}_${m}`);
        if (world.state.avatars[id] && free(id)) return id;
      }
      return null;
    }
    const b = pendingBuildingOf(session, buildingKey);
    if (!b || !session.town) return null;
    const c = session.town.stage.center;
    const at = { x: c.x + b.shape.dx + b.shape.w / 2, y: c.y + b.shape.dy + b.shape.h / 2 };
    const reach = civicRecruitRadius(session);
    let best: string | null = null;
    let bestD = reach;
    for (const [id, av] of Object.entries(world.state.avatars)) {
      if (!id.startsWith("resident_") || av.canOpen === false || !free(id)) continue;
      const d = Math.hypot(av.x - at.x, av.y - at.y);
      // Ties by id so the same shell picks the same body every time.
      if (d < bestD || (d === bestD && best && id < best)) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /**
   * PUT IT WHERE IT BELONGS — the sweep that makes the drawing come true.
   *
   * One carry per building per {@link REFLOW_GAP_S}: a resident walks to the
   * piece, picks it up, walks to its mark and sets it down. Two acts only,
   * because the work list has only two that involve something already standing:
   *
   *   `move`        the drawing has a place for this piece — take it there.
   *   `deconstruct` the drawing has no place for it at all (an extra chair, a
   *                 piece whose room came down) — take it apart where it
   *                 stands. It goes back to being the item it is made of, and
   *                 the next pass may carry that item somewhere it IS wanted.
   *
   * The delta write happens ON ARRIVAL, never on scheduling, so an interrupted
   * carry leaves the piece exactly where it was and the sweep simply tries
   * again. Nothing is ever in two places, and nothing is ever in none.
   */
  function stepBlueprintReflow(session: QuestSession, key: string) {
    const t = session.town;
    if (!t || !world) return;
    // A piece in nobody's hands and nobody's building goes home first — checked
    // ahead of every gate below, because a building whose only drift was the
    // lifted row would otherwise gate itself out and strand the piece.
    recoverDroppedCarries(session);
    const delta = t.deltas.get(key);
    // Cheap gate: only a building that has been re-drawn (or has an ordered
    // room) can owe anything — or one that owns a tool with nowhere to stand
    // (blueprint layer 3), which is the same "the drawing and the furniture
    // disagree" in its third form. An untouched house's drawing IS its
    // furniture.
    if (!hasDrift(delta) && !delta?.programs?.length && !ownedStationKinds(session, key).length) {
      return;
    }
    // NOBODY WAITS BEHIND A CHEST. Checked ahead of the carry rate limit — a
    // body already stopped by something is not a thing to schedule.
    stepStrayBumps(session, key);
    if (session.townClock < (reflowAt.get(key) ?? 0)) return;
    const npcId = reflowHandFor(session, key);
    if (!npcId) return; // nobody about to carry anything
    const task = buildingFurnishTasks(session, key).find(
      (q) => (q.act === "move" || q.act === "deconstruct") && !!q.from,
    );
    if (!task?.from) return;
    reflowAt.set(key, session.townClock + REFLOW_GAP_S);
    const from = task.from;
    // CLAIM THE BODY the way every other directed errand does — a resident
    // whose need loop is still holding the wheel would re-route mid-carry and
    // the piece would never arrive. (A resident's creature id IS its body id.)
    session.needStep.delete(npcId);
    session.lastDrive.set(npcId, "command");

    if (task.act === "deconstruct") {
      // NO PLACE FOR IT UNDER THE NEW PLANS. Walk over and take it apart where
      // it stands — the same act the bump rule performs, for the same reason
      // and by the same code, so a piece that is in the way and a piece that is
      // merely surplus meet identical ends. It becomes the item it is made of,
      // which the next pass may well carry to a place that IS asking for one.
      enqueueNpcErrand(session, npcId, {
        points: [{ x: from.x, y: from.y, dwell: 0.9 }],
        onDone: () => {
          if (!buildingFurnitureOf(session, key).some((p) => p.id === from.id)) return;
          fireCarryGesture(npcId, "pickup", { x: from.x, y: from.y });
          // INCIDENTAL: the household re-arranging itself is not the player
          // un-ordering a room, so no standing want is dropped. The drawing is
          // never edited by what happens to pieces.
          orderBreakPiece(session, key, from.id, { incidental: true });
        },
      });
      return;
    }

    const slot = task.slot!;
    let token: string | null = null;
    enqueueNpcErrand(session, npcId, {
      points: [
        { x: from.x, y: from.y, dwell: 0.8 },
        { x: slot.x, y: slot.y, dwell: 0.4 },
      ],
      // THE PIECE IS PICKED UP HERE. This is the whole fix: the old sweep
      // walked the body to the piece, walked it to the mark, and rewrote the
      // row at the end — so the piece stood still through the entire trip and
      // then jumped. Nothing was ever carried, which is why the refrigerator
      // teleported: exempt from breaking, the row rewrite was its ONLY path,
      // while every other piece got taken apart by the bump rule and carried as
      // a real prop. One lift, one landing, the same for all of them.
      onArrive: (i) => {
        if (i !== 0) return;
        token = liftPieceIntoHands(session, key, npcId, from);
      },
      onDone: () => {
        if (!token) return; // the lift failed (somebody else got there first)
        landPieceFromHands(session, key, npcId, token, slot);
      },
    });
  }

  /**
   * A PIECE LEAVES THE FLOOR AND RIDES IN SOMEBODY'S HANDS.
   *
   * A carry is the one moment a piece is in neither place, and until now the
   * engine had no way to say that — furniture was either a row in the building
   * or a `small:` prop on the ground, so "being carried" was expressed by
   * rewriting the row at the far end (a teleport) or not at all.
   *
   * The row comes OUT of the building and is held, whole, in `piecesInHand`.
   * Whole matters: a street-good box's `good`, a player-spoken `pinned`, the
   * piece's own id all survive the trip and land again on the other side, so
   * carrying the refrigerator across the kitchen cannot cost the goods economy
   * its delivery point.
   *
   * The token in the hands is a SHADOW — the piece is accounted for in the
   * flight record, and a registered prop would be the same piece twice.
   */
  const piecesInHand = new Map<string, { key: string; row: PlacedPiece; body: string }>();

  function liftPieceIntoHands(
    session: QuestSession,
    key: string,
    npcId: string,
    piece: FurniturePiece,
  ): string | null {
    const t = session.town;
    if (!t || !world) return null;
    // Already loose on the floor (deconstructed to clear a path, or dropped):
    // it IS the thing hands take, and it is registered, so nothing to record.
    if (piece.id.startsWith("small:")) {
      if (!session.smallProps.has(piece.id)) return null; // somebody else took it
      return takeIntoHands(session, npcId, { kind: "object", objId: piece.id });
    }
    // Standing: materialize so the piece is a row (never the drawing), then
    // take the row out. The drawing is not consulted or edited at any point —
    // the place a bed belongs does not move because the bed did.
    materializeFurniture(session, key);
    const row = (t.deltas.get(key)?.placed ?? []).find((q) => q.id === piece.id);
    if (!row) return null; // a break or a demolition beat us to it
    const held: PlacedPiece = { ...row };
    if (!removePlacedPiece(t.deltas, key, piece.id)) return null;
    const tok = takeIntoHands(
      session,
      npcId,
      {
        kind: "glyph",
        glyph: furnitureGlyph(row.kind),
        at: { x: piece.x, y: piece.y },
        id: `carry:${key}:${piece.id}`,
        shadow: true,
      },
      { reachAt: { x: piece.x, y: piece.y } },
    );
    if (!tok) {
      placeFurniture(t.deltas, key, held); // no hands to hold it — straight back
      return null;
    }
    piecesInHand.set(tok, { key, row: held, body: npcId });
    return tok;
  }

  /** …AND LANDS ON ITS MARK. The token leaves the hands and the piece becomes a
   *  row again — the SAME row when it was lifted from one, a fresh delivered
   *  one when it came off the floor (`setUp: false`, so it rises with the
   *  settle exactly like every other arriving piece). */
  function landPieceFromHands(
    session: QuestSession,
    key: string,
    npcId: string,
    token: string,
    slot: BlueprintSlot,
  ): void {
    const t = session.town;
    if (!t) return;
    const flight = piecesInHand.get(token);
    const put = setDownFromHands(
      session,
      npcId,
      { kind: "consumed" },
      { objId: token, reachAt: { x: slot.x, y: slot.y } },
    );
    if (flight) {
      piecesInHand.delete(token);
      // Belt and braces: if the hand-off refused (the body let go on the way),
      // the token still must not outlive the flight — the piece is about to be
      // a row again and two of it is the one thing that must never happen.
      world?.removeObject(token);
      placeFurniture(t.deltas, flight.key, {
        ...flight.row,
        x: slot.x,
        y: slot.y,
        facing: slot.facing,
        roomId: slot.roomId,
      });
      return;
    }
    // It came off the floor, so it has never been a row: it becomes one now —
    // but ONLY if the prop really left the hands. A body that dropped it on the
    // way is still holding nothing and the prop is still lying somewhere; making
    // a row anyway would be one piece twice, which is the one thing that must
    // never happen. The next sweep finds the prop and carries it again.
    if (!put) return;
    const fdef = furnitureItemOf(slot.kind);
    const rowId = `furn_${key}_p${nextPlacedSerial(t.deltas.get(key))}`;
    // …AND THE CONTENTS COME BACK UP WITH IT. The barrel that was carried
    // across the room stands up still holding its water: the stock moves from
    // the prop's id to the standing piece's, which is the same move `break`
    // made in the other direction. Nothing is ever poured into a sibling.
    const carriedStock = session.containerStock.get(token);
    if (carriedStock && Object.keys(carriedStock).length) {
      session.containerStock.delete(token);
      session.containerStock.set(rowId, carriedStock);
      session.containers.set(rowId, session.containers.get(token) ?? "in");
      const owner = session.containerOwner.get(token);
      if (owner) session.containerOwner.set(rowId, owner);
    }
    session.containers.delete(token);
    session.containerOwner.delete(token);
    placeFurniture(t.deltas, key, {
      id: rowId,
      kind: slot.kind,
      x: slot.x,
      y: slot.y,
      radius: fdef?.radius ?? slot.radius,
      facing: slot.facing,
      openable: fdef?.openable ?? slot.openable,
      roomId: slot.roomId,
      setUp: false,
    });
  }

  /**
   * A CARRY THAT DIED. The body was re-tasked, evicted or unstreamed mid-trip,
   * so the token is no longer in its hands and the row is in nobody's building.
   * The piece goes back EXACTLY where it was standing — the law the old sweep
   * got for free by never lifting anything: an interrupted carry leaves the
   * piece where it was, and the sweep simply tries again. Nothing is ever in
   * two places, and nothing is ever in none.
   */
  function recoverDroppedCarries(session: QuestSession): void {
    if (!world || !piecesInHand.size || !session.town) return;
    for (const [token, f] of [...piecesInHand]) {
      if (world.state.objects[token]?.carriedBy === f.body) continue;
      piecesInHand.delete(token);
      world.removeObject(token);
      placeFurniture(session.town.deltas, f.key, f.row);
    }
  }

  /** CONSTRUCTION COMPLETION sweep (~1 s): a founded building whose build
   *  clock ran out is marked complete IN THE DELTA (the serialized fact),
   *  its plan row gains its roster jobs (townJobsMemo invalidates so
   *  assignTownJobs re-deals with the new workplace), pooled build tasks
   *  keyed to it complete off this REAL construction state, and the world
   *  visibly swaps scaffold → doored building. */
  let foundedSweepT = 0;
  function stepFoundedConstruction(
    session: QuestSession,
    dt: number,
    /** WHOSE ORDERS this sweep works off. Every row it drives was authored by
     *  someone; until a row carries its own author, the sweep speaks for the
     *  device that runs it — which is exactly what the singleton meant, said
     *  out loud and now overridable. */
    issuer: string = LOCAL_PLAYER_CID,
  ) {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas) return;
    foundedSweepT += dt;
    if (foundedSweepT < 1) return;
    const elapsedS = foundedSweepT; // labor accrues over the real swept span
    foundedSweepT = 0;
    const day = buildDayNow(session);
    // ── STAGING (pipeline ②) ── Dead sitepile hauls drop their spoken-for
    // units (idempotent — a consumed or already-released holder is empty).
    // For a DONE haul this release is also the acknowledgment of the units
    // the unload seam reserved on the pile at landing (onTransferLanded):
    // once acknowledged they sit as plain pile stock, which no resolver
    // reads as a source. A plot whose pile covers its bill starts its labor
    // clock; one still short re-resolves (rate-limited) so fresh stock
    // unsticks it.
    const isPileDest = (to: string) =>
      to.startsWith(ORDER_PILE_EP) ||
      to.startsWith(SITE_PILE_EP) ||
      to.startsWith(ANNEX_PILE_EP) ||
      to.startsWith(BFURN_EP);
    for (const a of session.transfers.all()) {
      if ((a.status === "done" || a.status === "failed") && isPileDest(a.to)) {
        session.reservations.release(agrHolder(a.id));
      }
    }
    // ④ TOOL-CLAIM GC — a basket spoken for by a haul that is over (or that a
    // reload lost entirely) is free again. Blind and idempotent: the holder id
    // names its own agreement, so nothing has to remember which trips took a
    // bag. Without it one crashed haul would retire a basket permanently.
    for (const r of session.reservations.toJSON().rows) {
      if (!r.holder.startsWith("bag:")) continue;
      const a = session.transfers.get(r.holder.slice(4));
      if (!a || (a.status !== "pending" && a.status !== "moving")) {
        session.reservations.release(r.holder);
      }
    }
    // LEGACY-SAVE JANITOR (rewrite 1b): jobs persist on TownDeltas now, so a
    // reload keeps every craft agreement owned — this sweep only ever fires
    // for a pre-1b save whose agreements outlived their session-lived jobs
    // (and stays as a leak backstop; it is idempotent and near-free).
    const trackedCraft = new Set<string>();
    for (const j of craftJobsOf(session).values()) for (const id of j.agreements) trackedCraft.add(id);
    for (const a of session.transfers.active()) {
      if (a.sourceGlyph?.startsWith("craft:") && !trackedCraft.has(a.id)) {
        session.transfers.fail(a.id, "no-executor");
        session.reservations.release(agrHolder(a.id));
      }
    }
    // Craft-SPOT reservations (⑥ — banked job inputs): with jobs persisted
    // (1b) every live row has an owner — release only what a PRE-1B save
    // orphaned (the same legacy janitor as above).
    for (const r of session.reservations.toJSON().rows) {
      if (!r.holder.startsWith("craftspot:")) continue;
      if (!craftJobsOf(session).has(Number(r.holder.slice("craftspot:".length)))) {
        session.reservations.release(r.holder);
      }
    }
    // Reload seam: agreements persist in the deltas, pooled tasks and NPC
    // errands don't — re-pool a pending sitepile haul that lost its task,
    // re-walk a moving one whose hauler lost its errand (the restored-carry
    // branch keeps its armful), fail one whose hauler is gone.
    const pooledAgr = new Set<string>();
    for (const t of [...session.taskPool.open(), ...session.taskPool.claimed()]) {
      if (t.goal.kind === "transfer") pooledAgr.add(t.goal.agreementId);
    }
    for (const a of session.transfers.active()) {
      if (!isPileDest(a.to)) continue;
      const at = stockEndpointOf(session, a.to)?.at ?? null;
      if (!at) {
        session.transfers.fail(a.id, "no-endpoint");
        continue;
      }
      if (a.status === "pending") {
        // FAIL FAST on a drained source (⑥): the stock moved under the
        // agreement — kill it now so the 20 s re-resolve picks a LIVE
        // source instead of waiting out the task's whole expiry.
        const from = stockEndpointOf(session, a.from);
        if (!from || !Object.keys(a.goods).some((g) => stackUnits(from.stack, g) > 0)) {
          session.transfers.fail(a.id, "missing");
          session.reservations.release(agrHolder(a.id));
          continue;
        }
      }
      if (a.status === "pending" && !pooledAgr.has(a.id)) {
        const foundGlyph = (b: FoundedBuilding | undefined): string =>
          b ? (resolveStructure(structureCatalogOf(session), b.type)?.glyph ?? "yard") : "yard";
        const glyph = a.to.startsWith(ORDER_PILE_EP)
          ? (() => {
              const o = deltas.orders().find((q) => q.ord === Number(a.to.slice(ORDER_PILE_EP.length)));
              if (o?.kind === "found") return foundGlyph(o);
              if (o?.kind === "refine") return stackHead(o.produces);
              if (o && (o.kind === "annex" || o.kind === "interior")) {
                return ROOM_GLYPH[pendingRoomKindOf(o) as HouseRoom["kind"]] ?? "room";
              }
              return "room";
            })()
          : a.to.startsWith(SITE_PILE_EP)
            ? foundGlyph(deltas.founded().find((f) => f.ord === Number(a.to.slice(SITE_PILE_EP.length))))
            : a.to.startsWith(BFURN_EP)
              ? (furnitureKindOfGlyph(Object.keys(a.goods)[0] ?? "") ?? "room")
              : "room";
        postPooledTask(
          session,
          { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: glyph } },
          issuer,
          { x: at.x, y: at.y, radius: civicRecruitRadius(session) },
          a.sourceGlyph ?? "bring materials",
        );
      } else if (a.status === "moving" && a.executor && world) {
        const body = avatarIdOf(a.executor);
        if (!world.state.avatars[body]) {
          session.transfers.fail(a.id, "no-executor");
        } else if (!world.npcErrandActive(body) && !(session.npcTasks.get(body)?.length ?? 0)) {
          issueTransferHaul(session, a.executor, a.id);
        }
      }
    }
    // ── BUILDERS MAKE BUILDINGS (⑥): a staged site banks labor only while
    // builders STAND at it — more of them, proportionally faster (capped).
    // The sweep keeps up to BUILDERS_CAP standing build-work tasks pooled
    // (any resident may claim — ambient recruitment), walks idle claimants
    // back to the spot, and banks elapsed × present.
    // Labor banks through THE ONE RATE FUNCTION (laborRatePerS — step 3):
    // build-day credit in the session's own day unit, crew-capped. The
    // clock arm below uses the same function × CLOCK_SCHEDULE_RATE, so the
    // two drivers can only ever differ by the schedule factor.
    const clockArm = (row: { labor?: number }, cap: number = BUILDERS_CAP) => {
      const banked =
        elapsedS *
        CLOCK_SCHEDULE_RATE *
        laborRatePerS(session, Math.min(cap, availableCrew(session, issuer)));
      bankLabor(row, banked);
      if (banked > 0) deltas.version++;
    };
    const workSite = (
      siteId: string,
      at: { x: number; y: number },
      row: { labor?: number },
      rect?: { x: number; y: number; w: number; h: number },
      cap: number = BUILDERS_CAP,
    ) => {
      const tasks = [...session.taskPool.open(), ...session.taskPool.claimed()].filter(
        (t) => t.goal.kind === "buildwork" && t.goal.site === siteId,
      );
      for (let n = tasks.length; n < cap; n++) {
        session.taskPool.post({
          goal: { kind: "buildwork", site: siteId },
          issuer,
          focus: { x: at.x, y: at.y, radius: civicRecruitRadius(session) },
          now: session.taskClock,
          sourceGlyph: "build",
        });
      }
      let present = 0;
      for (const t of tasks) {
        if (t.status !== "claimed" || !t.claimedBy || !world) continue;
        const npcId = avatarIdOf(t.claimedBy);
        const body = world.state.avatars[npcId];
        if (!body) continue;
        // Presence is measured from the site rect's EDGE (clamp-point), so a
        // body a step inside the host house no longer counts as working.
        const px = rect ? Math.min(Math.max(body.x, rect.x), rect.x + rect.w) : at.x;
        const py = rect ? Math.min(Math.max(body.y, rect.y), rect.y + rect.h) : at.y;
        if (Math.hypot(body.x - px, body.y - py) <= BUILD_WORK_EDGE_R) {
          present++;
          // The BUILD LOOP animation: the sustained "play" rig — crouched
          // over the work, limbs stroking at a spot in front (the same loop
          // a crafter holds at the bench). Refreshed each sweep with a
          // margin past the sweep gap, so it expires on its own the moment
          // the builder stops standing at the site. Aim the body at the
          // work so the stroke lands toward it, not wherever the walk
          // finished.
          const d = Math.hypot(at.x - body.x, at.y - body.y);
          if (d > 0.3) {
            body.fx = (at.x - body.x) / d;
            body.fy = (at.y - body.y) / d;
          }
          session.needPoseShow.set(npcId, { t: elapsedS + 2, kind: "play" });
        }
        // Keep the builder at the work (or walking to it): re-issue the
        // standing dwell whenever the body runs idle. The commute is
        // schedule playback — the clock-path bubble's case (clocked).
        if (!world.npcErrandActive(npcId) && !(session.npcTasks.get(npcId)?.length ?? 0)) {
          enqueueNpcErrand(session, npcId, {
            points: [{ x: at.x, y: at.y, dwell: BUILD_WORK_DWELL_S }],
            clocked: true,
          });
        }
      }
      const banked = elapsedS * laborRatePerS(session, Math.min(cap, present));
      bankLabor(row, banked);
      // Labor is a first-class mutation: without the bump every
      // deltas.version watcher (stage restage, overlays, the spot cache)
      // was blind to the ladder climbing.
      if (banked > 0) deltas.version++;
    };
    // ── ONE ORDER LOOP (phase 2, construction-phase2-plan.md steps 2+3):
    // every designation — a founded building, an ordered room, a
    // demolition — walks the SAME ladder: gather → stage → labor → commit.
    // The per-kind difference is geometry and the commit executor, never
    // the lifecycle. Per tick each order is driven by OBSERVATION alone:
    // observed = today's machinery (hauls walk, builders stand and bank at
    // the presence edge — the RENDERED CAUSE); unobserved = the clock arm
    // (the abstract twin draws the materials, labor banks at the one
    // playback rate). Keying the driver on who created the row was the
    // "builds itself" bug class this replaces.
    for (const o of [...deltas.orders()]) {
      if (o.kind === "found" && o.completed) continue;
      const rect = orderRectOf(session, o);
      const obs = rect ? observedRect(session, rect) : false;
      // First sight is no edge: a just-posted (or just-loaded) order's
      // crew walks in through recruitment rather than materializing.
      const wasObs = orderObservedPrev.get(o.ord) ?? obs;
      orderObservedPrev.set(o.ord, obs);
      if (o.kind === "found") {
        const b = o;
        // ADOPT a legacy no-cost row (step 3 — nothing may be its own
        // clock): stage it now and bank exactly where its old clock stood.
        // Behavior-preserving at the instant of adoption; from here on it
        // is an ordinary labor site on the observed/unobserved split.
        if (!b.costs && b.laborStartDay === undefined) {
          const f =
            b.buildDays > 0
              ? Math.max(0, Math.min(1, (day - b.startedDay) / b.buildDays))
              : 1;
          deltas.stageOrder(b.ord, day);
          bankLabor(b, f * b.buildDays);
        }
        if (b.costs && b.laborStartDay === undefined) {
          // GATHER → STAGE.
          if (Object.keys(stagingMissing(b)).length === 0) {
            deltas.stageOrder(b.ord, day);
            const spec = resolveStructure(structureCatalogOf(session), b.type);
            presenter.toast(
              `🧱 materials staged — builders raise the ${spec?.label ?? b.type}`,
              "feedback",
            );
          } else if (obs) {
            postSiteHauls(session, b, issuer);
          } else {
            const at = foundedLotAt(session, b);
            if (at) {
              twinResolveHauls(session, orderPileId(b.ord), sitePileId(b.ord), issuer);
              twinStagePile(
                session,
                {
                  pileId: orderPileId(b.ord),
                  legacyPileId: sitePileId(b.ord),
                  at,
                  missing: stagingMissing(b),
                  pile: (b.pile ??= {}),
                },
                issuer,
              );
            }
          }
        }
        if (b.laborStartDay !== undefined && (b.labor ?? 0) < b.buildDays - 1e-9) {
          // LABOR — staged the same sweep it covered (the old two-pass
          // behavior: stage, then bank, one tick).
          const at = foundedLotAt(session, b);
          if (at && rect) {
            if (obs) {
              if (!wasObs) materializeCrew(session, at, undefined, issuer);
              workSite(orderSiteId(b.ord), at, b, rect);
            } else {
              clockArm(b);
            }
          }
        }
        if (foundedBuildingDone(b, day)) commitFoundedOrder(session, b);
        continue;
      }
      if (o.kind === "refine") {
        // THE MILL (phase 3): the block chain's middle rung, riding the
        // same gather → stage → labor → commit ladder as every costed
        // order. The raw bill's hauls draw from the yard, the storehouse
        // or STANDING TREES (kill-sources fell at drain — the logging
        // leg); the labor is bench work under REFINE_CREW_CAP through
        // the one rate function; the commit mints the blocks into a real
        // container and retires the row. Sits before the town gate —
        // wilderness sites mill too.
        const r = o;
        if (r.laborStartDay === undefined) {
          if (Object.keys(stagingMissing(r)).length === 0) {
            deltas.stageOrder(r.ord, day);
            presenter.toast(
              `🪚 materials in — milling ${r.count} ${stackHead(r.produces)}`,
              "feedback",
            );
          } else if (obs) {
            postPileHauls(
              session,
              {
                pileId: orderPileId(r.ord),
                at: r.at,
                missing: stagingMissing(r),
                glyph: stackHead(r.produces),
              },
              issuer,
            );
          } else {
            twinResolveHauls(session, orderPileId(r.ord), undefined, issuer);
            twinStagePile(
              session,
              {
                pileId: orderPileId(r.ord),
                at: r.at,
                missing: stagingMissing(r),
                pile: r.pile,
              },
              issuer,
            );
          }
          continue;
        }
        if (!((r.labor ?? 0) >= r.buildDays - 1e-9)) {
          if (obs) {
            if (!wasObs) materializeCrew(session, r.at, REFINE_CREW_CAP, issuer);
            workSite(orderSiteId(r.ord), r.at, r, rect ?? undefined, REFINE_CREW_CAP);
          } else {
            clockArm(r, REFINE_CREW_CAP);
          }
          continue;
        }
        commitRefineOrder(session, r);
        continue;
      }
      if (!session.town) continue; // rooms + demolitions live on town plans
      if (o.kind === "demolish") {
        // Nothing to stage (unbuilding needs hands, not materials): builders
        // go straight to standing at the doomed room and working the labor
        // off; the demolish itself (with its stow banking) commits at the end.
        if (!demolitionLaborDone(o)) {
          const at = pendingDemolitionAt(session, o);
          if (!at) {
            // The building or room went from under the order (a rebuild, a
            // competing change) — the row drops; nothing was touched yet.
            deltas.removeOrder(o.ord);
            continue;
          }
          if (obs) {
            if (!wasObs) materializeCrew(session, at, undefined, issuer);
            workSite(orderSiteId(o.ord), at, o, rect ?? undefined);
          } else {
            clockArm(o);
          }
          continue;
        }
        commitDemolition(session, o);
        deltas.removeOrder(o.ord);
        continue;
      }
      // annex/interior — gather → stage → labor → the room rises through
      // the SAME commit the instant order used (requestAnnex for outward
      // growth, requestInterior for a subdivision cut).
      const p = o;
      const roomKind = pendingRoomKindOf(p);
      if (p.laborStartDay === undefined) {
        if (Object.keys(stagingMissing(p)).length === 0) {
          deltas.stageOrder(p.ord, day);
          presenter.toast(`🧱 materials staged — the ${roomKind} is going up`, "feedback");
        } else {
          const at = pendingAnnexAt(session, p);
          if (at && obs) {
            postPileHauls(
              session,
              {
                pileId: orderPileId(p.ord),
                // An adapted pre-phase-2 row's in-flight hauls still target
                // its old per-kind ordinal.
                ...(p.legacyOrd !== undefined ? { legacyPileId: annexPileId(p.legacyOrd) } : {}),
                at,
                missing: stagingMissing(p),
                glyph: ROOM_GLYPH[roomKind as HouseRoom["kind"]] ?? "room",
              },
              issuer,
            );
          } else if (at) {
            twinResolveHauls(
              session,
              orderPileId(p.ord),
              p.legacyOrd !== undefined ? annexPileId(p.legacyOrd) : undefined,
              issuer,
            );
            twinStagePile(
              session,
              {
                pileId: orderPileId(p.ord),
                ...(p.legacyOrd !== undefined ? { legacyPileId: annexPileId(p.legacyOrd) } : {}),
                at,
                missing: stagingMissing(p),
                pile: p.pile,
              },
              issuer,
            );
          }
        }
        continue;
      }
      if (!pendingLaborDone(p)) {
        // Staged but unworked — builders bank the labor (⑥).
        const at = pendingAnnexAt(session, p);
        const host = pendingBuildingOf(session, p.buildingKey);
        if (at && host) {
          if (obs) {
            if (!wasObs) materializeCrew(session, at, undefined, issuer);
            workSite(
              orderSiteId(p.ord),
              at,
              p,
              annexWorldRect(session.town.stage.center, host.shape, p.candidate),
            );
          } else {
            clockArm(p);
          }
        }
        continue;
      }
      commitRoomOrder(session, p);
    }
    // Retire build-work whose site is gone, worked through, or now running
    // on the clock arm — an UNOBSERVED site's crew is scenery debt: the
    // bodies free up, and the reveal re-recruits (materializeCrew places
    // off-screen hands mid-pose so the site is never seen empty-but-
    // progressing). Open rows expire on their own.
    for (const t of session.taskPool.claimed()) {
      if (t.goal.kind !== "buildwork") continue;
      if (!buildworkSiteAt(session, t.goal.site)) {
        session.taskPool.complete(t.id);
        continue;
      }
      const m = /^o:(\d+)$/.exec(t.goal.site);
      const oo = m ? deltas.orders().find((q) => q.ord === Number(m[1])) : undefined;
      const rect = oo ? orderRectOf(session, oo) : null;
      if (rect && !observedRect(session, rect)) session.taskPool.complete(t.id);
    }
    // The observation-edge memory dies with its order.
    for (const ord of [...orderObservedPrev.keys()]) {
      if (!deltas.orders().some((q) => q.ord === ord)) orderObservedPrev.delete(ord);
    }
    if (session.town) {
      // ⑥ RECURSION: standing work-building programs pull their furniture
      // (craft where none stored, haul where stored), and delivered pieces
      // stand up in their program rooms.
      stepShellPrograms(session, issuer);
      stepShellFurnPlacement(session);
      // Phase 3: the storehouse's par-stock logging (its own retry gate).
      stepStorehouseStock(session, issuer);
    }
  }

  /** COMMIT a finished FOUNDING (the per-kind executor): mark the row
   *  complete, staff the workplace, teach the economy the building exists,
   *  retire its build tasks. */
  function commitFoundedOrder(session: QuestSession, b: FoundedBuilding): void {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas) return;
    // Record the walls' MATERIAL before the pile is consumed (phase 3 —
    // the same-material abstraction hook): the dominant block facet wins;
    // a raw-paid legacy pile records nothing (reads as wood).
    let bestN = 0;
    for (const [g, n] of Object.entries(b.pile ?? {})) {
      if (stackHead(g) !== BLOCK_GLYPH || n <= bestN) continue;
      const facet = g.split(".").find((f) => f.startsWith("material_"));
      if (facet) {
        b.material = facet.slice("material_".length);
        bestN = n;
      }
    }
    deltas.completeFounding(b.ord);
    const spec = resolveStructure(structureCatalogOf(session), b.type);
    seedShellDoorless(session, b, spec);
    if (session.town) {
      const row = session.town.plan.works.find((w) => w.foundedOrd === b.ord);
      if (row) row.jobs = spec?.jobs ?? 0;
      invalidateTownJobs(); // the roster re-deals: the new workplace hires (phase 1a accessor)
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
    // THE BUILDER ANNOUNCES IT. Completion was a toast alone — the HUD's
    // channel — so a glyph reader watching the walls go up got no word when
    // they stopped. The crew that banked the labour is exactly who should say
    // it, and the copula frame ("the house is finished") agrees in every
    // ruleset because `finished` is a state word, not a bare noun.
    let announcer: string | undefined;
    for (const [taskId, ord] of [...session.buildTaskOrds]) {
      if (ord !== b.ord) continue;
      announcer ??= session.taskPool.get(taskId)?.claimedBy ?? undefined;
      session.taskPool.complete(taskId);
      session.buildTaskOrds.delete(taskId);
    }
    if (announcer && spec) speakLine(session, announcer, structureDoneLine(spec.glyph), true);
    presenter.toast(`🏛️ the ${spec?.label ?? b.type} is finished`, "feedback");
  }

  /**
   * THE SHELL ASKS FOR ITS DOORS (construction phase 5). A building the
   * PIPELINE raised is finished walls-and-roof, with a gap cut at every
   * doorway and nothing hanging in any of them — so at the moment its shell
   * completes, every opening is recorded `doorless`. The furniture sweeps then
   * treat "a doorway with no leaf" as exactly the kind of unmet want they
   * already handle, and the doors go in one at a time, visibly.
   *
   * WHY NOT AT ORDER TIME: an unbuilt lot has no rooms yet (the plan is only
   * meaningful once the walls stand), and a site under construction registers
   * no structures at all — there would be nothing for the keys to name.
   *
   * WHY WORLDGEN IS UNTOUCHED: nothing calls this for a base town's houses or
   * works. Their `doorless` stays absent, which reads as "every leaf hangs" —
   * the law's own allowance that a finished worldgen building may abstract its
   * walls, and its doors along with them.
   *
   * Keys are deduped through a Set because a shared interior doorway is
   * recorded on BOTH rooms it joins; `doorwayKeyOf` is what makes the two
   * records collapse to one.
   */
  function seedShellDoorless(
    session: QuestSession,
    b: FoundedBuilding,
    spec: ReturnType<typeof resolveStructure>,
  ): void {
    const t = session.town;
    const site = session.foundedSite;
    const deltas = t?.deltas ?? site?.deltas;
    if (!deltas) return;
    const key = `f_${b.ord}`;
    let plan: HouseRoomPlan | null = null;
    if (t) {
      // Through pendingBuildingOf so the plan is derived EXACTLY as the stage
      // will derive it (same index, same program, same delta) — a key computed
      // off a differently-shaped plan would name an opening that never exists.
      plan = pendingBuildingOf(session, key)?.plan ?? null;
    } else if (site) {
      plan = buildingRoomPlan(
        site.at,
        1000 + b.ord,
        {
          dx: b.dx, dy: b.dy, w: b.w, h: b.h, door: b.door,
          ...(spec?.stations ? { stations: spec.stations } : {}),
          ...(spec?.shell ? { bare: true } : {}),
        },
        spec?.program ?? { store: true },
        deltas.get(key),
      );
    }
    if (!plan) return;
    const keys = new Set<string>();
    for (const room of plan.rooms) {
      for (const d of room.doorways) keys.add(doorwayKeyOf(room, d));
    }
    // NOT IN SCOPE (and deliberately so): a partition cut AFTER this moment —
    // an annex or interior room ordered later — gets its leaf for free. Its
    // doorway is simply never listed, and absent means hung.
    markDoorless(deltas, key, [...keys]);
  }

  /** COMMIT a worked-off ROOM order (the per-kind executor). The ground may
   *  have moved since the order (the annex cap filled, the interior host
   *  re-shaped): a refused commit banks the pile back into the yard and
   *  drops the designation honestly, never silently.
   *  PIN THE FACTS FIRST (the furniture-jump fix): new geometry re-derives
   *  the whole house — the host room gains a doorway and every generated
   *  piece in it re-runs its fit scan. Snapshot the pre-commit furniture;
   *  after the commit, any piece the re-flow MOVED is converted to a placed
   *  row at its old spot (same id, so container stock and anchors survive)
   *  and its generated twin retired. Untouched pieces stay generated;
   *  goods-bound boxes (piece.good — the economy's pantry wiring) are left
   *  to re-flow. */
  function commitRoomOrder(session: QuestSession, p: RoomOrder): void {
    const deltas = session.town?.deltas;
    if (!deltas) return;
    const roomKind = pendingRoomKindOf(p);
    // THE FURNITURE BECOMES REAL FIRST (blueprint.ts). After this line the
    // generator no longer answers for this building's contents, so raising the
    // room re-draws the blueprint and moves nothing.
    materializeFurniture(session, p.buildingKey);
    const committed = isInteriorCandidate(p.candidate)
      ? interiorCommitOk(session, p) && requestInterior(deltas, p.buildingKey, p.candidate).ok
      : requestAnnex(deltas, p.buildingKey, p.candidate).ok;
    if (committed) {
      presenter.toast(`🏛️ the ${roomKind} is finished`, "feedback");
    } else {
      for (const [g, n] of Object.entries(p.pile)) {
        deltas.stock[g] = (deltas.stock[g] ?? 0) + n;
      }
      presenter.toast(`💬 the ${roomKind} can't rise anymore — materials returned`, "feedback");
    }
    deltas.removeOrder(p.ord);
  }

  /**
   * ONE spoken/board MAKE order, end to end — the mobile-item sibling of
   * `orderBuild`. Resolves the glyph to a pipeline recipe (`craftRecipeOf`:
   * furniture rows and toys alike) and starts the house's craft job, which then
   * gathers real inputs off real stacks — hauling them, or waiting honestly when
   * there are none, which IS the construction chain the plan asks for.
   *
   * Returns false when making doesn't apply here at all (no town — the caller
   * phrases "can't make that here"); true when HANDLED, accepted or refused
   * aloud. One job per house is the pipeline's existing rule, so a second order
   * is told it must wait rather than silently replacing the first.
   */
  function orderCraft(session: QuestSession, glyph: string, speaker?: string | null): boolean {
    if (!session.town) return false;
    const word = spokenWord(glyph);
    const recipe = craftRecipeOf(glyph);
    if (!recipe) {
      if (speaker) npcChatBubble(session, speaker, "no");
      presenter.toast(`💬 can't make "${word}" — we don't know how`, "feedback");
      return true;
    }
    const hi = familyOf(session)?.house ?? session.town.plan.houses[0]?.index;
    if (hi === undefined) return false;
    if (craftJobsOf(session).get(hi)) {
      // THE ORDER WAITS, IT IS NOT DROPPED (phase 4 step 5): the slot is one
      // per house, but a second spoken order used to be answered with "waits
      // its turn" and then thrown away — the line was a fiction. It is a real
      // queue now; the toast finally tells the truth. The row carries no spot
      // (the CraftJob is built at pop time, off the bench of that moment).
      const queue = craftQueueOf(session);
      const q = queue.get(hi) ?? [];
      if (q.length >= CRAFT_QUEUE_CAP) {
        if (speaker) npcChatBubble(session, speaker, "no");
        presenter.toast(
          `💬 the list is full — the ${word} will have to wait for another day`,
          "feedback",
        );
        return true;
      }
      q.push({
        produces: recipe.produces,
        consumes: recipe.consumes,
        ...(recipe.at ? { at: recipe.at } : {}),
        label: recipe.label,
      });
      queue.set(hi, q);
      if (speaker) npcChatBubble(session, speaker, "ok");
      presenter.toast(
        `🔨 already making something — the ${word} waits its turn (${q.length} in line)`,
        "feedback",
      );
      return true;
    }
    craftJobsOf(session).set(hi, {
      ...recipe,
      spotId: craftSpotOf(session, hi),
      agreements: [],
      laborS: 0,
    });
    if (speaker) npcChatBubble(session, speaker, "ok");
    presenter.toast(
      `🔨 making a ${word}${houseBench(session, hi) ? "" : " — by hand, no workbench"}`,
      "feedback",
    );
    return true;
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
    /** PINNED to a build SPOT (⑦): the street slot the player lit up and
     *  settled on. The order lands THERE or is refused — a highlight that
     *  builds somewhere else would be a lie about the ground. */
    spot?: { slot: number; at: { x: number; y: number } },
    /** WHO GAVE THE ORDER. The order's author owns the task it posts and is
     *  the one a named builder's willingness is measured toward — a peer's
     *  build order is that peer's to be refused, not this device's. */
    issuer: string = LOCAL_PLAYER_CID,
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
      // NOT A STRUCTURE, but MAKEABLE (pipeline ④ + the make/build law): "build
      // + chair" is a craft order, and so is "build + ball" — the two verbs are
      // interchangeable, so a `build` that names no structure still reaches the
      // mobile-item goal instead of dying as "not a structure we know". The
      // compiler routes most of these to `craft` directly; this arm catches the
      // ones that arrive as a build order anyway (a scope whose catalog claims
      // the word, then fails to resolve it). Hand-rate without a bench: the
      // player's explicit ask is never rerouted (bench-first binds AUTOMATION).
      const makeable = makeableGlyph(structure);
      if (makeable && orderCraft(session, makeable, speakerFor)) return true;
      // UNKNOWN STRUCTURE — a NAMED conversational can't (never a silent
      // generic fallback; the workProgram() lesson).
      if (speakerFor) npcChatBubble(session, speakerFor, "no");
      presenter.toast(`💬 can't build "${structure}" — not a structure we know`, "feedback");
      return true;
    }
    // POINT-STEERED (city-founding): "build + house + HERE" — the player's
    // committed gaze ranks feasible slots by distance, so the order lands
    // where the player is looking (lattice grain, guarantees intact). A SPOT
    // press (⑦) steers to the lit plot and then keeps only that slot: the
    // enumeration runs wide enough that a zoning MATCH elsewhere can't
    // outrank the ground the player actually pointed at.
    const steerAt: TaskFocus | null = spot
      ? { x: spot.at.x, y: spot.at.y, radius: TASK_FOCUS_RADIUS }
      : playerFocusArea(session);
    const near = steeringNear(ctx, steerAt);
    const enumerated = buildCandidates(ctx, spec, {
      ...(near ? { near } : {}),
      ...(spot ? { max: SPOT_SLOT_SEARCH } : {}),
    });
    const candidates = spot ? enumerated.filter((c) => c.slot === spot.slot) : enumerated;
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
    // MISSING MATERIALS never refuse anymore (pipeline ⑥): the order POSTS
    // as a designation and the staked plot honestly WAITS — fresh stock (a
    // felled tree, a caravan, a demolition bank) unsticks it through the
    // staging re-resolve. The shortfall is still NAMED aloud below.
    const lotAt = foundedLotAt(session, candidates[0]!) ?? ctx.center;
    const missing = buildMissingMaterials(session, spec, lotAt, issuer);
    const missingNames = Object.entries(missing).map(([g, n]) => `${n} ${g}`).join(", ");
    if (!explicitBuilder) {
      // UNTARGETED → the ①a TASK POOL: any appropriate creature in the
      // focus area may claim it (stepTaskPool's build capability check).
      // The task records the SAME focus that steered the lot ranking, so
      // the claimant's lot choice lands where the order was aimed.
      const posted = steerAt
        ? postPooledTask(session, { kind: "build", structure: spec.type, cap: 1 }, issuer, steerAt, sentence)
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
      compliance(relationToward(session, explicitBuilder, issuer), creatureMood(explicitBuilder)) >=
        VOLUNTEER_COMPLIANCE;
    if (!willing) {
      npcChatBubble(session, explicitBuilder, placementWontLine()[syntax]);
      return true;
    }
    const walker = explicitBuilder === possession.creatureId ? null : explicitBuilder;
    const b = executeBuildOrder(session, spec, candidates[0]!, walker, issuer);
    if (!b) {
      presenter.toast(`💬 "${sentence}" — can't do that here`, "feedback");
      return true;
    }
    // THE ACCEPTED ORDER SPEAKS. A bare "ok" is right when the order can start
    // — nothing is outstanding. When it is STAKED AND SHORT, the builder names
    // what the structure is waiting on instead ("the house needs more blocks"):
    // the shortfall was only ever a toast, so a glyph reader was told the order
    // was accepted and never told why nothing then happened. `need` is the verb
    // that makes it a request rather than an assertion about where the blocks
    // already are.
    const shortHead = Object.entries(missing)[0];
    if (walker && speakerFor) {
      if (b.laborStartDay === undefined && shortHead) {
        npcChatBubble(
          session,
          walker,
          needsMaterialLine(spec.glyph, stackHead(shortHead[0]), shortHead[1] > 1)[syntax],
        );
      } else {
        npcChatBubble(session, walker, "ok"); // the RESERVED okay — an accepted order
      }
    }
    presenter.toast(
      b.laborStartDay !== undefined
        ? `🏗️ building the ${spec.label} — builders to work`
        : missingNames
          ? `🏗️ the ${spec.label} is staked out — we still need ${missingNames}`
          : `🏗️ the ${spec.label} is staked out — bringing materials`,
      "feedback",
    );
    return true;
  }


  // ═══════ D-orderZone (verbatim from quest-host.ts) ═══════
  // ── AREA DESIGNATION (nations §3c — SELECTION, NOT DRAWING) ──────────────
  // An area order binds to a NAMEABLE UNIT, never a brush. Ground under
  // the player's gaze governed by an existing district charter → THAT
  // DISTRICT re-designates (an "over" row — extent from the charter tree
  // itself). Anywhere else → the WHOLE TOWN takes a steering preference
  // (a young town has no finer grain yet; laws steer, need builds).
  // "area none" clears the same unit. Legacy discs remain readable
  // forever; none are ever authored again.

  /**
   * ONE spoken/board area order, end to end. Returns false when areas
   * don't apply here at all (no town, no founded site — the caller
   * phrases "can't do that here"); true when HANDLED — designated with
   * the reserved-ok confirmation, or refused aloud with the word NAMED.
   */
  function orderZone(
    session: QuestSession,
    categoryWord: string | null,
    sentence: string,
    /** WHO DECREED IT. A zoning row is a persisted decree and names its
     *  author on the row — the one field of this order that outlives the
     *  session, so it must be the author who spoke, not the device. */
    issuer: string = LOCAL_PLAYER_CID,
  ): boolean {
    const ctx = buildContext(session);
    if (!ctx) return false;
    const focus = playerFocusArea(session);
    if (!focus) return false;
    // The addressed "clerk" — whoever the order was aimed at confirms it
    // (the reserved okay); a bare order into the town confirms by toast +
    // the overlay tint (board words visibly change the world).
    const clerk = session.addressedFamily ?? gazeCreature(session) ?? convoNodeId() ?? null; // phase 1a accessor
    const confirm = (): void => {
      if (clerk && session.creatures?.nodeByCreature.has(clerk)) npcChatBubble(session, clerk, "ok");
    };
    // The UNIT under the gaze: an existing governed district, else the town.
    const governed = charterZoneAt(ctx.zones, focus.x - ctx.center.x, focus.y - ctx.center.y);
    const rowBase = governed
      ? { shape: "over" as const, of: governed.ord, x: 0, y: 0, r: 0, issuer }
      : { shape: "town" as const, x: 0, y: 0, r: 0, issuer };
    if (categoryWord === null) {
      // CLEAR the unit — the district's ground reads unzoned again, or the
      // town's preferences wipe (later-wins; nothing deleted, replay holds).
      ctx.deltas.addZone({ ...rowBase, category: null });
      confirm();
      presenter.toast(
        governed ? `🗺️ this district is open ground again` : `🗺️ cleared the town's area preferences`,
        "feedback",
      );
      return true;
    }
    const category = resolveZoneCategory(ctx.catalog, ctx.districtOf, categoryWord);
    if (!category) {
      // UNKNOWN CATEGORY — a NAMED conversational can't (the workProgram()
      // lesson: never a silent generic fallback).
      if (clerk && session.creatures?.nodeByCreature.has(clerk)) npcChatBubble(session, clerk, "no");
      presenter.toast(`💬 can't designate "${categoryWord}" — not a structure we know`, "feedback");
      return true;
    }
    ctx.deltas.addZone({ ...rowBase, category });
    confirm();
    presenter.toast(
      governed
        ? `🗺️ this district is ${category} ground now`
        : `🗺️ the town will favor ${category}`,
      "feedback",
    );
    return true;
  }


  // ═══════ E-zonedFounding (verbatim from quest-host.ts) ═══════
  /**
   * MARKET SERVICE DEFICIT (needs-aware districts): the stranded founding
   * mass of households living past the hunger-cycle walk radius (scale.ts
   * serviceRadiusM) from their nearest standing market — measured in street
   * metres on the real tree, the districts.ts mass rule (min(2, d/R − 1)
   * per household), normalized against the stall founding bar. Every
   * non-vacated market work anchors, INCLUDING one still scaffolding —
   * a quarter's market under construction already answers its deficit, so
   * growth never stacks a second one while the first rises. Returns the
   * mass centroid (world coords) so the candidate ranking steers the new
   * market INTO the stranded quarter, not onto the plaza.
   */
  function marketServiceDeficit(
    session: QuestSession,
  ): { deficit: number; at: { x: number; y: number } } | null {
    const t = session.town;
    if (!t) return null;
    const R = serviceRadiusM(session.scale, "hunger");
    const origin = { x: 0, y: 0 };
    const anchors = t.plan.works
      .filter((w) => w.type === "market" && !w.vacated)
      .map((w) => workDoorstep(origin, w));
    if (anchors.length === 0) return null; // pre-market hamlet — farm-gate scale
    let mass = 0;
    let sx = 0;
    let sy = 0;
    for (const h of t.plan.houses) {
      const d0 = houseDoorstep(origin, h);
      let d = Infinity;
      for (const a of anchors) d = Math.min(d, roadDistance(t.plan.streets, d0, a));
      if (d <= R) continue;
      const w = Math.min(2, d / R - 1);
      mass += w;
      sx += (h.dx + h.w / 2) * w;
      sy += (h.dy + h.h / 2) * w;
    }
    if (mass <= 0) return null;
    return {
      deficit: Math.min(1, mass / NEIGH_FOUND_MASS),
      at: { x: t.stage.center.x + sx / mass, y: t.stage.center.y + sy / mass },
    };
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
    // A stranded quarter (needs-aware districts) is a growth need like a
    // shortage — and its centroid steers WHERE the answer rises.
    const svc = marketServiceDeficit(session);
    const order = foundingGrowthStep({
      deltas: ctx.deltas,
      catalog: ctx.catalog,
      gain,
      day,
      buildDaysOf: (rel) => constructionGameDays(rel, session.scale),
      // A BUILDING NEVER RISES BY ITSELF (⑥): the town's own growth founds
      // a STAGED designation — its bill is hauled to the plot and builders
      // work it off, exactly like a player's order. (The costless clock
      // twin stays for worldgen, where there is nobody to watch.)
      pipeline: true,
      signals: {
        crowding: houseCount > 0 ? Math.min(2, pop / (houseCount * HOUSEHOLD)) : pop > 0 ? 2 : 0,
        shortage: (good) => townShortage(session, good),
        serviceDeficit: (type) => (type === "market" && svc ? svc.deficit : 0),
      },
      economyOf: (k) => {
        const w = t.eco.works.find((x) => x.key === k);
        return w ? { cap: w.cap, sells: w.sells ?? [], district: w.district } : null;
      },
      capValueOf: (by) => t.town.scalar(by),
      countOf: (type) =>
        t.plan.works.filter((w) => w.type === type && !w.vacated).length +
        (houseTypes.has(type) ? t.plan.houses.length : 0),
      candidatesFor: (spec, zone) => {
        // The service build stands IN the stranded quarter (the `near`
        // steer) — center-out enumeration would drop it by the plaza and
        // leave the quarter exactly as far from bread as before.
        const near = spec.type === "market" && svc ? steeringNear(ctx, svc.at) : undefined;
        const cands = buildCandidates(ctx, spec, near ? { near } : undefined);
        return zone === null ? cands : cands.filter((c) => candidateInZone(ctx.zones, zone, c));
      },
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
    // The staked plot's hauls start NOW (the player-order path — postSiteHauls
    // resolves the bill against every haul-able source; the staging sweep
    // stamps labor once the pile covers it and builders raise it).
    if (!Object.keys(stagingMissing(order.building)).length) {
      ctx.deltas.stageFounded(order.building.ord, order.building.startedDay);
    } else {
      postSiteHauls(session, order.building);
    }
    const zoneName =
      order.zoneOrd >= 0
        ? ctx.deltas.zones().find((z) => z.ord === order.zoneOrd)?.category ?? "zoned"
        : null;
    presenter.toast(
      zoneName
        ? `🏗️ the town stakes out a ${order.spec.label} in the ${zoneName} zone`
        : `🏗️ the people stake out a ${order.spec.label}`,
      "feedback",
    );
  }


  // ═══════ F-structureActs (verbatim from quest-host.ts) ═══════
  /** The building the player is FOCUSED ON right now (city-founding ③
   *  focus scope): the boot dollhouse, else the spirit ladder's structure
   *  rung. Null = town scope (flight/town/district/ground framing). */
  function structureFocusOf(session: QuestSession): StructureFocus | null {
    const t = session.town;
    if (!t) return null;
    if (session.dollhouse !== null) return { kind: "house", index: session.dollhouse };
    const spiritFocus = spiritFocusOf(); // phase 1a: host state via accessor
    if (!spiritFocus) return null;
    return resolveStructureFocus(spiritFocus, t.stage.center, t.plan);
  }

  /** World rects of every OUTWARD growth a designation has already staked —
   *  ground that is spoken for, so no second order (player's or the town's
   *  own) overlaps it. Interior cuts have no outdoor rect; they lock their
   *  host room instead. */
  function pendingGrowthRects(session: QuestSession): Array<{ x: number; y: number; w: number; h: number }> {
    const t = session.town;
    if (!t) return [];
    return t.deltas.annexSites().flatMap((p) => {
      if (isInteriorCandidate(p.candidate)) return [];
      const m = /^h_(\d+)$/.exec(p.buildingKey);
      const ph = m ? t.plan.houses.find((h) => h.index === Number(m[1])) : undefined;
      return ph ? [annexWorldRect(t.stage.center, ph, p.candidate)] : [];
    });
  }

  /** World rects of every footprint EXCEPT `house` — what its annex must
   *  keep clear of (the constructionStep neighbor slice, house-centric). */
  function houseNeighborRects(t: TownPlay, house: TownHouse) {
    const c = t.stage.center;
    return [
      ...t.plan.houses
        .filter((h) => h.index !== house.index)
        .map((h) => ({ x: c.x + h.dx, y: c.y + h.dy, w: h.w, h: h.h })),
      ...t.plan.works.map((w) => ({ x: c.x + w.dx, y: c.y + w.dy, w: w.w, h: w.h })),
    ];
  }

  /** Everything ONE building can do right now, resolved off live state.
   *  Shared by the focused-structure board (③) and the build-spot menu a
   *  dwell opens (⑦) — one computation, so the two surfaces can never
   *  disagree about what a building affords. Null = nothing applies here
   *  (no town, a scaffold, a vacated row). */
  function structureActsFor(
    session: QuestSession,
    focus: StructureFocus,
  ): { acts: ReturnType<typeof structureActsOf>; house: TownHouse | null } | null {
    const t = session.town;
    const house =
      focus.kind === "house" && t
        ? (t.plan.houses.find((h) => h.index === focus.index) ?? null)
        : null;
    // FREE haul-able availability (⑤ — rooms stage from anywhere, not the
    // yard alone) around a doorstep.
    const freeStockAt = (at: { x: number; y: number }): Record<string, number> => {
      const sources = siteMaterialSources(session, at);
      const synthetic: Record<string, number> = {};
      // Every material a room can be billed in — one head, `block`, since
      // phase 3. Read off a bill rather than named literally so a future
      // second construction material is counted here for free.
      for (const g of Object.keys(MIN_ROOM_COSTS)) {
        synthetic[g] = sources.reduce(
          (n, src) => n + freeUnits(src.stack, session.reservations, src.id, g),
          0,
        );
      }
      return synthetic;
    };
    let acts: ReturnType<typeof structureActsOf> | null = null;
    if (t && house) {
      const center = t.stage.center;
      acts = structureActsOf({
        center,
        house,
        plan: houseRoomPlan(center, house, t.deltas.get(`h_${house.index}`)),
        // The PURE base plan — demolished rooms' rects, the in-place
        // re-creation candidates (⑤b).
        basePlan: houseRoomPlan(center, house),
        deltas: t.deltas,
        neighbors: houseNeighborRects(t, house),
        stock: freeStockAt(houseDoorstep(center, house)),
        furnStock: (glyph) => {
          let n = 0;
          for (const objId of houseContainerKeys(session, house.index)) {
            n += session.containerStock.get(objId)?.[glyph] ?? 0;
          }
          return n;
        },
      });
    } else if (focus.kind === "work" && t) {
      // ⑤b — a focused WORK building's own board: a completed founded
      // shell (or any standing work) subdivides from within. A scaffold
      // has no interior yet; a vacated row is a house now.
      const wk = t.plan.works[focus.index];
      const fb =
        wk?.foundedOrd !== undefined
          ? t.deltas.founded().find((f) => f.ord === wk.foundedOrd)
          : undefined;
      const standing = wk && !wk.vacated && (!fb || foundedBuildingDone(fb, buildDayNow(session)));
      if (standing) {
        const center = t.stage.center;
        const key = workDeltaKey(wk, focus.index);
        const shape: HouseShape = { ...wk, index: 100000 + focus.index };
        acts = structureActsOf({
          center,
          house: shape,
          plan: buildingRoomPlan(
            center, focus.index, wk, wk.program ?? workProgram(wk.type), t.deltas.get(key),
          ),
          deltas: t.deltas,
          buildingKey: key,
          keepRoot: false, // a shell's root may shrink — it has no goods anchors
          growOutward: false, // shells grow inward first (annexes are a later grain)
          neighbors: [],
          stock: freeStockAt(workDoorstep(center, wk)),
          furnStock: () => 0,
        });
      }
    }
    return acts ? { acts, house } : null;
  }

  /** One building's CONSTRUCTION acts as board options, in the historical
   *  order. House room buttons ride the annex id (orderAnnex resolves the
   *  MODE — in-place re-creation, annex ground, interior cut); kinds feasible
   *  only inward join through their cluster. Work rooms get their own id.
   *  These live behind the BUILD word now (⑦) — never on the resting board. */
  function structureConstructionOptions(
    session: QuestSession,
    focus: StructureFocus,
    acts: ReturnType<typeof structureActsOf>,
    house: TownHouse | null,
  ): { options: QuestBoardView["options"]; sig: string } {
    const clusterOfKind = (k: HouseRoom["kind"]): AnnexCluster | undefined =>
      ANNEX_ORDER.find((c) => ANNEX_ROOM_KIND[c] === k);
    const houseClusters = house
      ? [...acts.annex, ...acts.interior.map(clusterOfKind).filter((c): c is AnnexCluster => !!c)]
      : [];
    const workKinds = house ? [] : acts.interior;
    const locale = session.game.meta.locale ?? "en";
    return {
      sig: `${houseClusters.join("|")}//${workKinds.join("|")}//${acts.demolish.map((r) => r.id).join("|")}`,
      options: [
        ...houseClusters.map((c) => ({
          id: `annex:${focus.index}:${c}`,
          label: `build ${ANNEX_ROOM_KIND[c]}`,
          glyph: `build + ${ROOM_GLYPH[ANNEX_ROOM_KIND[c]]}`,
          spokenText: translateGlyph(`build + ${ROOM_GLYPH[ANNEX_ROOM_KIND[c]]}`, locale),
        })),
        ...workKinds.map((k) => ({
          id: `wroom:${focus.index}:${k}`,
          label: `build ${k}`,
          glyph: `build + ${ROOM_GLYPH[k]}`,
          spokenText: translateGlyph(`build + ${ROOM_GLYPH[k]}`, locale),
        })),
        ...acts.demolish.map((r) => ({
          id: `${house ? "demolish" : "wdemolish"}:${focus.index}:${r.id}`,
          label: `break ${r.kind}`,
          glyph: `break + ${ROOM_GLYPH[r.kind]}`,
          spokenText: translateGlyph(`break + ${ROOM_GLYPH[r.kind]}`, locale),
        })),
      ],
    };
  }

  /** Standing STORED FURNITURE the focused building could have set out.
   *  Placing a chair is not construction — it stays on the resting board. */
  function structureFurnishOptions(
    session: QuestSession,
    focus: StructureFocus,
    acts: ReturnType<typeof structureActsOf>,
  ): { options: QuestBoardView["options"]; sig: string } {
    const locale = session.game.meta.locale ?? "en";
    return {
      sig: acts.furnish.join("|"),
      options: acts.furnish.map((k) => ({
        id: `furn:${focus.index}:${k}`,
        label: `put ${k}`,
        glyph: `put + ${k}`,
        spokenText: translateGlyph(`put + ${k}`, locale),
      })),
    };
  }


  // ═══════ G-orders (verbatim from quest-host.ts) ═══════
  /** A PLAYER-ORDERED annex (structure board ③): materials-paid from the
   *  builder's stock — the auto-expansion path keeps paying in banked
   *  prosperity instead, so guidance ADDS speed without double-charging. */
  function orderAnnex(session: QuestSession, houseIndex: number, cluster: AnnexCluster): boolean {
    const t = session.town;
    const house = t?.plan.houses.find((h) => h.index === houseIndex);
    if (!t || !house) return false;
    const roomKind = ANNEX_ROOM_KIND[cluster];
    if (!roomKind) return false;
    const center = t.stage.center;
    const delta = t.deltas.get(`h_${houseIndex}`);
    const plan = houseRoomPlan(center, house, delta);
    // Pending growth rects (any house, annex candidates) count as
    // neighbors — two staked annexes never overlap (requestAnnex re-checks
    // only the cap); pending INTERIOR cuts lock their host room instead.
    const pendingRects = pendingGrowthRects(session);
    const busyHosts = new Set(
      t.deltas
        .annexSites()
        .filter((p) => p.buildingKey === `h_${houseIndex}` && isInteriorCandidate(p.candidate))
        .map((p) => (p.candidate as InteriorCandidate).hostId),
    );
    // ⑤b IN-PLACE RE-CREATION first: a demolished room of this kind whose
    // rect still fits re-splits the union host along the old partition
    // line (the doc's law — a rebuilt room reoccupies its footprint).
    // Then annex ground; then any other legal interior cut (a house
    // rarely has one — its rooms are all owned).
    const basePlan = houseRoomPlan(center, house);
    const preferred = demolishedRects(center, house, basePlan, delta, roomKind);
    const interiorCands = interiorOptions(center, house, plan, delta, roomKind, {
      keepRoot: true,
      preferred,
      excludeHosts: busyHosts,
    });
    const nearEq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const inPlace = interiorCands.find((c) =>
      preferred.some(
        (r) => nearEq(r.u0, c.u0) && nearEq(r.u1, c.u1) && nearEq(r.v0, c.v0) && nearEq(r.v1, c.v1),
      ),
    );
    const annexCand = inPlace
      ? undefined
      : annexOptions(
          center, house, plan,
          [...houseNeighborRects(t, house), ...pendingRects],
          delta, cluster,
        )[0];
    const candidate: AnnexCandidate | InteriorCandidate | undefined =
      inPlace ?? annexCand ?? interiorCands[0];
    if (!candidate) {
      presenter.toast(`💬 no ground for a ${roomKind} on this house`, "feedback");
      return true;
    }
    return stakeAnnex(session, houseIndex, cluster, candidate);
  }

  /**
   * STAKE A ROOM (pipeline ⑤): the shared tail of every annex order — the
   * player's, and the town's own daily growth. The room is a DESIGNATION,
   * nothing paid up front: materials haul to the rect (growth rect outside,
   * the cut band inside) and the room rises when the pile covers the bill
   * and BUILDERS have worked the labor off. Auto-expansion goes through
   * here too, so no room anywhere appears with nobody raising it (⑥).
   */
  function stakeAnnex(
    session: QuestSession,
    houseIndex: number,
    cluster: AnnexCluster,
    candidate: AnnexCandidate | InteriorCandidate,
    /** The player AIMED at this ground (⑦ — a lit area was pressed). The
     *  highlight is a promise about a place, so the empty-room shortcut
     *  below must not answer it somewhere else. */
    opts?: { pinned?: boolean },
    /** WHO ORDERED THE ROOM — the author whose reach the bill is measured
     *  against and whose name the staking hauls carry. */
    issuer: string = LOCAL_PLAYER_CID,
  ): boolean {
    const t = session.town;
    const house = t?.plan.houses.find((h) => h.index === houseIndex);
    if (!t || !house) return false;
    const roomKind = ANNEX_ROOM_KIND[cluster];
    const rect = annexWorldRect(t.stage.center, house, candidate);
    const at = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    // AN EMPTY ROOM IS ALREADY A ROOM (the law §Adding rooms): a bare room
    // standing in the house, big enough and wanted by nobody else, TAKES the
    // designation — no ground is broken, no materials haul, and the furnish
    // sweeps fill it exactly as they fill a raised annex. Only when the
    // house has no such floor does the construction below get staked.
    const livePlan = houseRoomPlan(t.stage.center, house, t.deltas.get(`h_${houseIndex}`));
    const spare = opts?.pinned
      ? null
      : spareRoomFor(session, `h_${houseIndex}`, livePlan, rect.w * rect.h, roomKind);
    if (spare && pushProgramWant(session, `h_${houseIndex}`, roomKind, spare.id)) {
      presenter.toast(`🛏 the ${roomKind} takes the empty room`, "feedback");
      return true;
    }
    // MISSING MATERIALS never refuse (⑥): the designation posts and waits;
    // the shortfall is NAMED in the confirmation below.
    // THE ROOM'S OWN BILL (phase 6), sized by the rect the enumeration picked
    // — not one flat block for every room in the world. An outward annex
    // brings a floor, a roof and its three unshared walls; an inward cut is a
    // partition and nothing else, and this path stakes either.
    const costs = roomOrderCosts(candidate);
    const missing = buildMissingMaterials(session, { costs }, at, issuer);
    const missingNames = Object.entries(missing).map(([g, n]) => `${n} ${g}`).join(", ");
    const p = t.deltas.postAnnexSite({
      buildingKey: `h_${houseIndex}`,
      cluster,
      candidate,
      costs,
      pile: {},
      startedDay: buildDayNow(session),
      buildDays: constructionGameDays(ANNEX_BUILD_DAYS, session.scale),
    });
    // THE PERSISTENT WANT (pipeline ④): the ordered room outlives the room
    // itself — its furniture requirement drives crafting until met. One row
    // per kind (a second order still annexes, the want needs no twin).
    // NOTE (phase 4): the row is REMOVABLE now — commitDemolition drops the
    // demolished room's want, so a torn-down bedroom no longer re-raises
    // itself (the never-self-healing law).
    pushProgramWant(session, `h_${houseIndex}`, roomKind);
    postPileHauls(
      session,
      {
        pileId: orderPileId(p.ord),
        at,
        missing: stagingMissing(p),
        glyph: ROOM_GLYPH[roomKind] ?? "room",
      },
      issuer,
    );
    presenter.toast(
      missingNames
        ? `🏗️ a ${roomKind} is staked out — we still need ${missingNames}`
        : `🏗️ a ${roomKind} is staked out — bringing materials`,
      "feedback",
    );
    return true;
  }

  // ── PHASE 4: DESIGNATIONS COME OFF AGAIN ────────────────────────────────
  // Programs were append-only through ④; the rows below are the first
  // paths that REMOVE a want, and the furniture helpers the removal and the
  // break/empty verbs share.

  /** Is a point inside a room's world rect? (The kindsIn predicate, named.) */
  function inRoomRect(
    r: { rect: { x: number; y: number; w: number; h: number } },
    x: number,
    y: number,
  ): boolean {
    return x >= r.rect.x && x <= r.rect.x + r.rect.w && y >= r.rect.y && y <= r.rect.y + r.rect.h;
  }

  /** EVERY piece standing in a building, by delta key — a house's generated
   *  ⊕ placed furniture or a work's, resolved the way pendingBuildingOf
   *  resolves its plan (`h_<i>` / `f_<ord>` / `w_<i>`). */
  function buildingFurnitureOf(session: QuestSession, buildingKey: string): FurniturePiece[] {
    const t = session.town;
    if (!t) return [];
    const delta = t.deltas.get(buildingKey);
    const hm = /^h_(\d+)$/.exec(buildingKey);
    if (hm) {
      const house = t.plan.houses.find((h) => h.index === Number(hm[1]));
      if (!house) return [];
      const goodDefs = t.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
      return houseFurniture(t.stage.center, house, goodDefs, "", delta);
    }
    const wi = workIndexOfKey(session, buildingKey);
    const wk = wi >= 0 ? t.plan.works[wi] : undefined;
    if (!wk) return [];
    return workFurniture(t.stage.center, wi, wk, wk.program ?? workProgram(wk.type), "", delta);
  }

  // ── THE BLUEPRINT (blueprint.ts — the drawing, as against the house) ─────
  // Everything below answers ONE question in two directions: where should this
  // building's furniture be, and what does the difference from where it IS ask
  // somebody to do. The wants used to be derived three times over — once for
  // the outlines, once for the craft queue, once for the install sweep — with
  // three subtly different "is this program satisfied" tests, of which two were
  // house-wide and therefore blind to a second bedroom. One drawing now, read
  // by all of them.

  /** A blueprint, memoized per building revision AND per the set of tools the
   *  building owns (layer 3 — a drawing that gains a place when the household
   *  acquires a bench must not be served from a cache keyed only on the shape).
   *  The drawing costs a room plan, a furnish pass and a placement search per
   *  unsatisfied program row, and the outline overlay pulls it several times a
   *  second. */
  const blueprintMemo = new Map<string, { sig: string; bp: BuildingBlueprint }>();

  /**
   * THE WORKING STATIONS THIS BUILDING HAS — layer 3's input, and the enabler
   * set asked from the spec side (`isCraftStation`: a piece other things are
   * made AT), never a hard-coded list. One row today (the workbench); a forge
   * recipe would add itself.
   *
   * BOTH HALVES OF "HAS": the scope's inventory (`"anywhere"` — a bench in a
   * box, on the floor, in somebody's hands) AND one already STANDING.
   *
   * 🚨 The standing half is not redundant, it is what makes the layer stable. A
   * placed row is neither a stack nor a prop, so an inventory-only reading drops
   * to zero the instant the bench is stood up — the slot would vanish from the
   * drawing, the bench would become a piece "the drawing does not account for",
   * `stepStrayBumps` would take it apart, and the whole thing would oscillate at
   * bump speed. A household that owns a bench has a place for one, whichever
   * situation the bench is currently in.
   */
  function ownedStationKinds(
    session: QuestSession,
    buildingKey: string,
    opts?: {
      /** Also count one already STANDING. Off for the cheap gates — a standing
       *  piece is an unpinned placed row, which is `hasDrift` already, so the
       *  gates short-circuit before this and never pay for the furniture
       *  derivation on the 199 untouched houses of a town. */
      standing?: boolean;
    },
  ): StationKind[] {
    const out: StationKind[] = [];
    let standing: FurniturePiece[] | null = null;
    for (const f of FURNITURE_ITEMS) {
      if (!isCraftStation(f.kind)) continue;
      if (buildingUnits(session, buildingKey, furnitureGlyph(f.kind), "anywhere") > 0) {
        out.push(f.kind);
        continue;
      }
      if (!opts?.standing) continue;
      standing ??= buildingFurnitureOf(session, buildingKey);
      if (standing.some((p) => p.kind === f.kind)) out.push(f.kind);
    }
    return out;
  }

  interface BuildingBlueprint {
    slots: BlueprintSlot[];
    /** Kinds an ordered room requires and the floor cannot take, by room —
     *  the one want that no amount of waiting fixes (something must come out
     *  first), and the only one drawn in red. */
    blocked: Array<{ kind: StationKind; room: HouseRoom }>;
    /** Kinds an ordered room will want whose ROOM IS STILL BEING BUILT. No
     *  slot, because there is no floor yet — but a bed takes about as long to
     *  make as a room takes to raise, so the making starts now. */
    pending: StationKind[];
  }

  const EMPTY_BLUEPRINT: BuildingBlueprint = { slots: [], blocked: [], pending: [] };

  /**
   * WHERE THIS BUILDING'S FURNITURE BELONGS, for the plan as it stands.
   *
   * Two layers, in order:
   *  1. The STATION REGISTRY realized against the current rooms — the ideal
   *     arrangement, drawn by the same driver that furnishes a house at
   *     worldgen (furniture.ts), so a re-drawn house is arranged exactly like
   *     one that had always looked this way. Doorway corridors, service lanes
   *     and the corner rule come along for free. Kitchen things land in the
   *     kitchen the moment a kitchen exists, because the registry's `cell`
   *     lookup resolves to a real one instead of falling back to the communal
   *     room — that IS the rearrangement the player asked for, stated once.
   *  2. The ORDERED ROOMS' own requirements, room by room. A registry that
   *     gives one bed per member has nothing to say about the SECOND bedroom
   *     the player just ordered, and a work building's registry has no bed at
   *     all; a program row asks for its room by name, and this layer answers
   *     for that room and no other.
   *
   * The drawing is made against `blueprintDelta` — the displacement records
   * stripped — so it can never be bent by the temporary state it exists to
   * correct.
   */
  function buildingBlueprintOf(session: QuestSession, buildingKey: string): BuildingBlueprint {
    const t = session.town;
    if (!t) return EMPTY_BLUEPRINT;
    const live = t.deltas.get(buildingKey);
    // ⚠️ THE SIGNATURE MUST BE CHEAP — this runs on EVERY call, memo hit or
    // miss, and the outline overlay pulls the drawing several times a second
    // per building. So the key asks only the inventory (map lookups); a change
    // to what is STANDING already bumps the delta's `rev`, because standing IS
    // the delta. (Putting the standing scan in the key cost 140ms/frame — the
    // expensive half ran ahead of the cache it was meant to guard.)
    const sig = `${live?.rev ?? 0}|${ownedStationKinds(session, buildingKey).join(",")}`;
    const memo = blueprintMemo.get(buildingKey);
    if (memo && memo.sig === sig) return memo.bp;
    // Past the cache: NOW the fuller question. `standing: true` HERE and
    // nowhere else — the drawing must keep a tool's place while the tool is
    // standing in it, or the slot would blink out the moment the bench went up
    // and the bump rule would take it apart again.
    const owned = ownedStationKinds(session, buildingKey, { standing: true });

    const bd = blueprintDelta(live);
    const goodDefs = t.stage.goods.map((g) => ({ key: g.good.key, slot: g.good.slot }));
    const center = t.stage.center;
    const hm = /^h_(\d+)$/.exec(buildingKey);
    const house = hm ? t.plan.houses.find((h) => h.index === Number(hm[1])) : undefined;
    const wi = house ? -1 : workIndexOfKey(session, buildingKey);
    const wk = wi >= 0 ? t.plan.works[wi] : undefined;
    if (!house && !wk) return EMPTY_BLUEPRINT;

    const shape = house ?? wk!;
    const goods = house ? goodDefs : [];
    const plan = house
      ? houseRoomPlan(center, house, bd)
      : buildingRoomPlan(center, wi, wk!, wk!.program ?? workProgram(wk!.type), bd);
    const ideal = house
      ? houseFurniture(center, house, goodDefs, "", bd)
      : workFurniture(center, wi, wk!, wk!.program ?? workProgram(wk!.type), "", bd);

    const slots = blueprintSlots(ideal, plan.rooms);
    const blocked: BuildingBlueprint["blocked"] = [];
    const pending: StationKind[] = [];

    // ── LAYER 2: the ordered rooms. ROOM-SCOPED, which is the whole point —
    // a house-wide "is there a bed anywhere" lets the original bedroom answer
    // for the annex, and the annex is then never drawn, never crafted and
    // never furnished (the dead gate).
    const defs = roomProgramDefsOf(session);
    const claimed: FurniturePiece[] = [...ideal];
    for (const row of live?.programs ?? []) {
      const def = roomProgramOf(row.room, defs);
      if (!def) continue;
      const pinned = row.roomId ? plan.rooms.find((r) => r.id === row.roomId) : undefined;
      const rooms = pinned ? [pinned] : plan.rooms.filter((r) => r.kind === def.kind);
      if (!rooms.length) {
        // THE ROOM IS STILL GOING UP. The want is real and its furniture is
        // makeable now — only the floor is missing, and a bed takes as long to
        // make as the room takes to raise. Kept slot-less on purpose: there is
        // nowhere honest to draw an outline, and nowhere to carry anything to.
        pending.push(...def.requires);
        continue;
      }
      for (const room of rooms) {
        for (const kind of def.requires) {
          if (slots.some((s) => s.kind === kind && s.roomId === room.id)) continue;
          const fdef = furnitureItemOf(kind);
          if (!fdef) continue;
          const pctx = makePlacementContext(center, shape, plan, goods, [...claimed]);
          const spot = placementCandidates(pctx, {
            kind,
            radius: fdef.radius,
            roomId: room.id,
          })[0];
          if (!spot) {
            // NOWHERE LEGAL TO STAND. The room is ordered to hold this piece
            // and its floor cannot take one — a full room, a piece too big for
            // the cell. Not an absent want: a blocked one.
            blocked.push({ kind, room });
            continue;
          }
          const piece: FurniturePiece = {
            id: `bp_${buildingKey}_${room.id}_${kind}`,
            kind,
            x: spot.x,
            y: spot.y,
            radius: fdef.radius,
            facing: spot.facing,
            openable: fdef.openable,
          };
          claimed.push(piece);
          slots.push({ ...piece, roomId: room.id });
        }
      }
    }

    // ── LAYER 3: A PLACE FOR THE TOOLS THIS HOUSEHOLD OWNS.
    //
    // The drawing is a list of PLACES, and until now it only had places for
    // what a room PROGRAM called for. A workbench the family made for itself
    // therefore had nowhere to belong in a house with no workshop — and the
    // consequences were not cosmetic:
    //
    //   • `reconcileFurnishing` saw it as pure surplus, so it never emitted the
    //     `move` that would have carried it anywhere;
    //   • `stepStrayBumps` DID see it — "every piece the drawing does not
    //     account for" — so the one that did get stood up was taken apart again
    //     ten seconds later by the first resident who pressed against it;
    //   • which put it back on the floor, benchless, and the bootstrap made
    //     another. All four symptoms, one missing place.
    //
    // ONLY ENABLERS (`isCraftStation` — a piece other things are made AT), and
    // only ones the scope really owns. Drawing a place for every spare chair
    // would be the blanket auto-place the user removed in 2026-07-28 ("placing
    // furniture is a separate action, performed by a creature"); drawing one for
    // the tool the household's own automation just built is the 2026-07-29
    // refinement ("newly constructed furniture should be set up in its correct
    // spot if one is missing") with the spot finally derived rather than
    // hard-coded. ONE place per kind: the second bench is spare, not a second
    // workshop.
    for (const kind of owned) {
      if (slots.some((s) => s.kind === kind)) continue; // the drawing has a place already
      if (pending.includes(kind)) continue; // a room going up has first claim on it
      const fdef = furnitureItemOf(kind);
      if (!fdef) continue;
      // ITS OWN ROOM FIRST, then the general-purpose rooms — a bench belongs
      // where work happens, and a house with no workshop keeps it out of the
      // kitchen (whose stations it would crowd) by preferring the store and
      // then the living room, which is the order the old hard-coded bench
      // branch used and the only part of it worth keeping.
      const want = stationRoomKind(kind);
      const order = [...(want ? [want] : []), "workshop", "store", "living"] as const;
      let placed = false;
      for (const rk of order) {
        const room = plan.rooms.find((r) => r.kind === rk);
        if (!room) continue;
        const pctx = makePlacementContext(center, shape, plan, goods, [...claimed]);
        const spot = placementCandidates(pctx, { kind, radius: fdef.radius, roomId: room.id })[0];
        if (!spot) continue;
        const piece: FurniturePiece = {
          id: `bp_${buildingKey}_${room.id}_${kind}`,
          kind,
          x: spot.x,
          y: spot.y,
          radius: fdef.radius,
          facing: spot.facing,
          openable: fdef.openable,
        };
        claimed.push(piece);
        slots.push({ ...piece, roomId: room.id });
        placed = true;
        break;
      }
      // Nowhere it fits: the piece stays an item on the floor and the tidy
      // chore owns it. Not `blocked` — nothing ORDERED this, so there is no
      // want to report as obstructed.
      if (!placed) continue;
    }

    const bp: BuildingBlueprint = { slots, blocked, pending };
    blueprintMemo.set(buildingKey, { sig, bp });
    return bp;
  }

  /**
   * DECONSTRUCTED FURNITURE LYING IN THIS BUILDING.
   *
   * A stove taken apart to get past it is still a stove, and it is still right
   * here. The drawing says a stove goes in that corner and does not care where
   * one comes from; the nearest available one happens to be the one on the
   * floor. Without this the loop dead-ends exactly as observed — pieces get
   * deconstructed to clear a path, are then invisible to the work list, and
   * nothing is ever put anywhere.
   *
   * Reported as ordinary standing pieces, so `reconcileFurnishing` needs to
   * know nothing about props: it sees a piece of the right kind that is not on
   * its mark, and says carry it.
   */
  function looseFurnitureIn(session: QuestSession, buildingKey: string): FurniturePiece[] {
    const b = pendingBuildingOf(session, buildingKey);
    if (!b || !world) return [];
    const out: FurniturePiece[] = [];
    for (const [objId, rec] of session.smallProps) {
      const kind = furnitureKindOfGlyph(rec.glyph);
      if (!kind) continue;
      const o = world.state.objects[objId];
      if (!o || o.carriedBy || o.containedIn) continue; // in hand or in a box already
      if (!b.plan.rooms.some((r) => inRoomRect(r, o.x, o.y))) continue;
      const fdef = furnitureItemOf(kind);
      out.push({
        id: objId,
        kind,
        x: o.x,
        y: o.y,
        radius: fdef?.radius ?? 0.4,
        facing: 0,
        openable: fdef?.openable ?? false,
      });
    }
    return out;
  }

  /** Units of a furniture kind this building has PUT AWAY — a house's own
   *  containers, a shell's delivery pile. Same question, two stores. */
  function buildingStored(session: QuestSession, buildingKey: string, kind: StationKind): number {
    const glyph = furnitureGlyph(kind);
    const hm = /^h_(\d+)$/.exec(buildingKey);
    if (hm) return houseStored(session, Number(hm[1]), glyph);
    return shellFurnPilesOf(session).get(buildingKey)?.[glyph] ?? 0;
  }

  /**
   * THE WORK LIST: what the house owes the drawing right now. Every consumer —
   * the outlines, the craft queue, the install sweep, the re-flow sweep — reads
   * this one list, so an outline is drawn for exactly the piece somebody is
   * about to go and fetch.
   */
  function buildingFurnishTasks(session: QuestSession, buildingKey: string): FurnishTask[] {
    // AN UNTOUCHED BUILDING OWES NOTHING, provably: with no ordered rooms and
    // nothing standing off its mark, the drawing and the furniture are the SAME
    // derivation, so the difference is empty by construction. Worth saying in
    // one line rather than discovering with a room plan, a furnish pass and a
    // placement search per building, several times a second, for a whole town.
    //
    // …UNLESS IT OWNS A TOOL IT HAS NOT STOOD UP (blueprint layer 3). Then the
    // two derivations differ by exactly that piece, which is the whole point of
    // drawing it a place — leaving this gate at "untouched ⇒ nothing" would
    // make the new layer unreachable for the building that most needs it: the
    // ordinary house whose only event was finishing a workbench.
    const d = session.town?.deltas.get(buildingKey);
    if (!d?.programs?.length && !hasDrift(d) && !ownedStationKinds(session, buildingKey).length) {
      return [];
    }
    const bp = buildingBlueprintOf(session, buildingKey);
    if (!bp.slots.length && !bp.pending.length) return [];
    const tasks = reconcileFurnishing({
      slots: bp.slots,
      // STANDING, plus what is lying about. Both are furniture the house has.
      standing: [
        ...buildingFurnitureOf(session, buildingKey),
        ...looseFurnitureIn(session, buildingKey),
      ],
      stored: (kind) => buildingStored(session, buildingKey, kind),
      pending: bp.pending,
    });
    // A piece already lying on the floor is never DECONSTRUCTED by this list —
    // it has been taken apart already, and the ambient tidy owns floor clutter.
    // Only "carry it to its place" applies to something lying on the floor.
    return tasks.filter((q) => !(q.act === "deconstruct" && q.from?.id.startsWith("small:")));
  }

  /** The GENERATED (worldgen, not delta-placed) pieces standing inside one
   *  room — what `emptyRoom` stows on the caller's behalf (decision 5:
   *  generated furniture mints its component item lazily, at removal). */
  function generatedPiecesIn(
    session: QuestSession,
    buildingKey: string,
    room: { rect: { x: number; y: number; w: number; h: number } },
  ): Array<{ id: string; kind: StationKind }> {
    const placedIds = new Set(
      (session.town?.deltas.get(buildingKey)?.placed ?? []).map((q) => q.id),
    );
    return buildingFurnitureOf(session, buildingKey)
      .filter((p) => !placedIds.has(p.id) && inRoomRect(room, p.x, p.y))
      // A STREET-GOOD BOX (`p.good`) is the ECONOMY'S WIRING, not the
      // household's furniture — the same law pinDisplacedFurniture states when
      // it leaves goods-bound boxes to re-flow. furnishPlan's goodsCorner arm
      // emits them UNCONDITIONALLY (removedPieces never withholds one), so
      // stowing a fridge would mint a `furn.refrigerator` stack while the
      // fridge itself kept standing — a duplicated unit (item conservation).
      // Emptying a kitchen therefore carries everything out but the pantry box.
      .filter((p) => !p.good)
      .map((p) => ({ id: p.id, kind: p.kind }));
  }

  /** BANK a stow result (phase 4 — extracted from commitDemolition so the
   *  empty/break paths bank IDENTICALLY): a house's stowed pieces and any
   *  wall refund land in its first SURVIVING container, else the town's
   *  yard stock; a work's go straight to the yard. Containers that left
   *  with the furniture re-home their contents (item conservation — no
   *  stack is ever orphaned under a dead object id). */
  function bankStowed(
    session: QuestSession,
    buildingKey: string,
    stowed: Partial<Record<StationKind, number>>,
    opts: { removedBoxes?: readonly string[]; refund?: Record<string, number> } = {},
  ): void {
    const t = session.town;
    if (!t) return;
    const removedBoxes = opts.removedBoxes ?? [];
    const refund = opts.refund ?? {};
    const hm = /^h_(\d+)$/.exec(buildingKey);
    const gone = new Set(removedBoxes);
    const destId = hm
      ? (houseContainerKeys(session, Number(hm[1])).find((id) => !gone.has(id)) ?? null)
      : null;
    const dest = destId ? (session.containerStock.get(destId) ?? {}) : t.deltas.stock;
    for (const [kind, n] of Object.entries(stowed)) {
      const g = furnitureGlyph(kind as StationKind);
      dest[g] = (dest[g] ?? 0) + (n ?? 0);
    }
    for (const [g, n] of Object.entries(refund)) dest[g] = (dest[g] ?? 0) + n;
    for (const boxId of removedBoxes) {
      const stock = session.containerStock.get(boxId);
      if (!stock) continue;
      for (const [g, n] of Object.entries(stock)) dest[g] = (dest[g] ?? 0) + n;
      session.containerStock.delete(boxId);
    }
    if (destId) session.containerStock.set(destId, dest);
  }

  /**
   * DROP THE WANTS NOTHING ANSWERS ANYMORE (phase 4 step 1 — the designation
   * lifecycle's removal half). Furniture just left the building: every
   * program row whose def REQUIRES one of the removed kinds is re-tested
   * against the LIVE plan, and only the rows no room satisfies at all come
   * off. A second still-furnished bedroom keeps the designation; the room
   * whose bed was broken loses it, so the sweeps never re-order it forever
   * (the never-self-healing law). The room's DISPLAYED kind re-derives from
   * what is left — rows are the wants, derivation is the fact.
   */
  function dropUnmetPrograms(
    session: QuestSession,
    buildingKey: string,
    kinds: readonly StationKind[],
  ): void {
    const t = session.town;
    if (!t || !kinds.length) return;
    const rows = t.deltas.get(buildingKey)?.programs;
    if (!rows?.length) return;
    const b = pendingBuildingOf(session, buildingKey);
    if (!b) return;
    const defs = roomProgramDefsOf(session);
    const pieces = buildingFurnitureOf(session, buildingKey);
    const kindsIn = (r: { rect: { x: number; y: number; w: number; h: number } }) =>
      pieces.filter((p) => inRoomRect(r, p.x, p.y)).map((p) => p.kind);
    const doomed: string[] = [];
    for (const row of rows) {
      const def = roomProgramOf(row.room, defs);
      if (!def) continue;
      if (!def.requires.some((k) => kinds.includes(k))) continue;
      const pinned = row.roomId ? b.plan.rooms.find((r) => r.id === row.roomId) : undefined;
      const met = pinned
        ? roomProgramMet(def, kindsIn(pinned))
        : b.plan.rooms.some((r) => roomProgramMet(def, kindsIn(r)));
      if (!met) doomed.push(row.room);
    }
    // Collected first — removeProgram rewrites the very array being read.
    for (const room of doomed) removeProgram(t.deltas, buildingKey, room);
  }

  /** THE STANDING WANT, pushed once (④'s dedup block, shared by the three
   *  order paths). `roomId` PINS the want to an existing room (phase 4's
   *  empty-room reuse) — an unpinned row of the same kind is pinned in
   *  place rather than twinned. Returns whether the want now names this
   *  room (false = another room already holds the kind's want, so the
   *  caller must not claim it took the empty room). */
  function pushProgramWant(
    session: QuestSession,
    buildingKey: string,
    roomKind: string,
    roomId?: string,
  ): boolean {
    const t = session.town;
    if (!t) return false;
    let claimed = !roomId;
    t.deltas.mutate(buildingKey, (d) => {
      d.programs ??= [];
      const row = d.programs.find((pr) => pr.room === roomKind);
      if (row) {
        if (roomId) {
          if (!row.roomId) row.roomId = roomId;
          claimed = row.roomId === roomId;
        }
        return;
      }
      d.programs.push({
        ord: d.programs.reduce((m, pr) => Math.max(m, pr.ord + 1), 0),
        room: roomKind,
        ...(roomId ? { roomId } : {}),
      });
      claimed = true;
    });
    return claimed;
  }

  /** A BARE ROOM ALREADY STANDING (the law §Adding rooms — "build a
   *  bedroom" over a room that is already there): big enough, holding no
   *  furniture at all, and claimed by no other program row. Never the
   *  living room (rooms[0] — the house's own hearth is not spare floor).
   *
   *  Null the moment the kind ALREADY has a standing want: the house is
   *  then already working on one (its room may be raised-but-unfurnished,
   *  which looks exactly like spare floor), and a second order must raise a
   *  second room rather than quietly re-point the first want. */
  function spareRoomFor(
    session: QuestSession,
    buildingKey: string,
    plan: HouseRoomPlan,
    minArea: number,
    roomKind: string,
  ): HouseRoom | null {
    const t = session.town;
    if (!t) return null;
    const rows = t.deltas.get(buildingKey)?.programs ?? [];
    if (rows.some((pr) => pr.room === roomKind)) return null;
    const claimed = new Set(rows.map((pr) => pr.roomId).filter((id): id is string => !!id));
    const pieces = buildingFurnitureOf(session, buildingKey);
    for (const room of plan.rooms.slice(1)) {
      if (claimed.has(room.id)) continue;
      if (room.rect.w * room.rect.h < minArea - 1e-6) continue;
      if (pieces.some((p) => inRoomRect(room, p.x, p.y))) continue;
      return room;
    }
    return null;
  }

  /**
   * BREAK ONE PIECE (phase 4 step 2 — the `break` verb's furniture arm).
   * The piece comes apart WHERE IT STANDS: a placed row un-places, a
   * generated one stows (its id never re-emits), and either way one
   * `furn.<kind>` stack lands loose on the floor — worldgen furniture mints
   * its component item lazily, at deconstruction (decision 5). Immediate
   * mutation with an ambient follow-up, the `put` verb's precedent: no new
   * walk-task machinery. Any stack the piece HELD re-homes into the
   * building's remaining storage. The designation-drop rule runs after.
   */
  function orderBreakPiece(
    session: QuestSession,
    buildingKey: string,
    pieceId: string,
    opts?: {
      /** NOBODY DECIDED THIS. The bump rule takes a piece apart to get past it,
       *  which is a fact about a doorway rather than a judgement about the
       *  furniture — so it must not drop the room's standing want the way a
       *  player-ordered `break` does. Otherwise walking into a chest cancels
       *  the kitchen. */
      incidental?: boolean;
    },
  ): boolean {
    const t = session.town;
    if (!t) return false;
    // TAKING A PIECE APART CHANGES THE HOUSE, NOT THE DRAWING. Materializing
    // first is what keeps those two things separate: the piece becomes a row,
    // the row goes, and the blueprint is not consulted or edited at any point.
    // The place where a bed belongs does not stop being that place because the
    // bed was broken — it becomes an empty place, which is a want.
    materializeFurniture(session, buildingKey);
    const delta = t.deltas.get(buildingKey);
    // A STREET-GOOD BOX IS NEVER BREAKABLE, materialized or not. Un-generated it
    // would mint its stack while the box kept standing (furnishPlan re-emits it
    // regardless); materialized it would take the household's pantry away and
    // leave the goods economy delivering into nothing.
    const placed = (delta?.placed ?? []).find((q) => q.id === pieceId && !q.good);
    const generated = placed
      ? undefined
      : buildingFurnitureOf(session, buildingKey).find((p) => p.id === pieceId && !p.good);
    const at = placed ?? generated;
    let kind: StationKind | null = null;
    if (placed) {
      kind = removePlacedPiece(t.deltas, buildingKey, pieceId);
      // DELIBERATELY NOT WITHHELD. An earlier pass added the piece's id to
      // `removedPieces` here, reasoning that a materialized row carries the
      // generator's own id and the drawing would otherwise ask for the piece
      // straight back. It does ask — and it SHOULD. Withholding deleted the
      // blueprint slot along with the furniture, so a chest broken to get past
      // it left no mark saying a chest belongs there, and the room was never
      // re-furnished: the observed "things got deconstructed and stowed away
      // and nothing else got placed". The drawing is not a list of this
      // building's possessions; it is a list of PLACES.
      // A HUNG LEAF (phase 5) comes off exactly like any other placed row —
      // and the opening it was in goes BARE again, which is the whole extra
      // fact. `markDoorless` is the mirror of the `hangDoor` that put it
      // there, so the shell's own furniture sweep will ask for a replacement
      // next tick: breaking a door is undoing an install, not a special verb.
      if (placed.doorway) markDoorless(t.deltas, buildingKey, [placed.doorway]);
    } else if (generated && !(delta?.removedPieces ?? []).includes(pieceId)) {
      stowGeneratedPiece(t.deltas, buildingKey, pieceId);
      kind = generated.kind;
    }
    if (!kind || !at) {
      presenter.toast(`💬 there is nothing like that here to take apart`, "feedback");
      return false;
    }
    const spot = world
      ? nearestClearSpot(world.state, { x: at.x, y: at.y }, { x: at.x, y: at.y })
      : { x: at.x, y: at.y };
    const prop = spawnLooseProp(session, furnitureGlyph(kind), spot.x, spot.y);
    // A CONTAINER TAKES ITS CONTENTS WITH IT (user law, 2026-08-02: "container
    // items need to be able to contain other items, whether they are placed
    // furniture or not").
    //
    // This used to tip the box's whole stock into whichever OTHER house
    // container happened to survive — and since the first surviving container
    // of a house with a food corner is the refrigerator, taking a barrel apart
    // put its water in the fridge. Contents belong to the container, not to the
    // building, and a barrel on its side is still a barrel with water in it.
    //
    // Only the headless case still banks: with no world there is no prop to
    // hold anything, and re-homing beats vanishing.
    const contents = session.containerStock.get(pieceId);
    if (prop && contents && Object.keys(contents).length) {
      session.containerStock.delete(pieceId);
      session.containerStock.set(prop, contents);
      session.containers.set(prop, session.containers.get(pieceId) ?? "in");
      const owner = session.containerOwner.get(pieceId);
      if (owner) session.containerOwner.set(prop, owner);
    }
    session.containers.delete(pieceId);
    session.containerOwner.delete(pieceId);
    // `removedBoxes` still names the piece so it can't be chosen as its own
    // destination; its stock has already left, so the pour-out loop finds
    // nothing to pour.
    bankStowed(session, buildingKey, prop ? {} : { [kind]: 1 }, { removedBoxes: [pieceId] });
    // A DOOR DESIGNATES NOTHING (phase 5): no room program requires one — a
    // door tells you nothing about what a room is for — so taking one off can
    // never drop a want. dropUnmetPrograms would already find no def naming
    // `door`; skipping it outright says WHY, and keeps a future program that
    // did name a door from silently un-designating a room when it breaks.
    if (!placed?.doorway && !opts?.incidental) dropUnmetPrograms(session, buildingKey, [kind]);
    presenter.toast(
      placed?.doorway
        ? `🚪 the door comes off its hinges`
        : opts?.incidental
          ? `🔨 the ${kind} is taken apart to get past`
          : `🔨 the ${kind} comes apart`,
      "feedback",
    );
    return true;
  }

  /** A PLAYER-ORDERED demolition (structure board ③) — a DESIGNATION, not
   *  an instant act (the build-order law, turned downward): the kernel
   *  rules gate it NOW so a doomed order refuses immediately and honestly,
   *  then builders must come and work the room down (the buildwork
   *  machinery); the actual demolish + stow banking runs at completion
   *  (commitDemolition). */
  function orderDemolish(session: QuestSession, houseIndex: number, roomId: string): boolean {
    const t = session.town;
    const house = t?.plan.houses.find((h) => h.index === houseIndex);
    if (!t || !house) return false;
    const key = `h_${houseIndex}`;
    const plan = houseRoomPlan(t.stage.center, house, t.deltas.get(key));
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room) return false;
    return postDemolition(session, key, plan, room);
  }

  /** Post the pending-demolition designation every order path shares:
   *  feasibility gates now, the labor comes later. `mode: "empty"` rides the
   *  SAME row and the same ladder — only the commit's executor differs. */
  function postDemolition(
    session: QuestSession,
    key: string,
    plan: HouseRoomPlan,
    room: HouseRoom,
    mode?: "empty",
  ): boolean {
    const t = session.town;
    if (!t) return false;
    const empty = mode === "empty";
    if (t.deltas.demolitionSites().some((p) => p.buildingKey === key && p.roomId === room.id)) {
      presenter.toast(
        empty
          ? `🧹 the ${room.kind} is already being cleared out`
          : `🔨 the ${room.kind} is already coming down`,
        "feedback",
      );
      return true;
    }
    // EMPTYING TEARS NOTHING DOWN, so no structural gate applies (even the
    // living room may be emptied — demolishCheck's "living"/merge/
    // connectivity rules are all about walls, and the walls stay). The room
    // must exist and hold no other order; that is the whole test.
    if (empty) {
      if (!plan.rooms.some((r) => r.id === room.id)) return false;
    } else if (!demolishCheck(t.deltas, key, plan, room.id).ok) {
      presenter.toast(`💬 the ${room.kind} can't come down`, "feedback");
      return true;
    }
    // Carrying furniture out is HALF the work of pulling a room down.
    const days = constructionGameDays(DEMOLISH_BUILD_DAYS, session.scale);
    t.deltas.postDemolitionSite({
      buildingKey: key,
      roomId: room.id,
      startedDay: buildDayNow(session),
      buildDays: empty ? Math.max(0.1, days / 2) : days,
      ...(empty ? { mode: "empty" as const } : {}),
    });
    presenter.toast(
      empty
        ? `🧹 the ${room.kind} is being cleared out — workers on the way`
        : `🔨 the ${room.kind} is coming down — workers on the way`,
      "feedback",
    );
    return true;
  }

  /** A PLAYER-ORDERED EMPTYING of a house room (phase 4 — the `empty`
   *  verb): orderDemolish's twin down to the row it posts; the commit runs
   *  the kernel's emptyRoom instead of demolishRoom. */
  function orderEmpty(session: QuestSession, houseIndex: number, roomId: string): boolean {
    const t = session.town;
    const house = t?.plan.houses.find((h) => h.index === houseIndex);
    if (!t || !house) return false;
    const key = `h_${houseIndex}`;
    const plan = houseRoomPlan(t.stage.center, house, t.deltas.get(key));
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room) return false;
    return postDemolition(session, key, plan, room, "empty");
  }

  /** Complete a pending demolition — the same kernel demolish the instant
   *  order used to run, with its stow banking: placed pieces (and their
   *  container stacks) return to the house's remaining boxes, a work's to
   *  the builder's yard. The plan may have shifted while the labor ran, so
   *  the demolish re-checks and a refusal is spoken, never silent. */
  /**
   * What a room GIVES BACK when it comes down — the exact bill that raised it,
   * recovered from the delta rather than assumed, so build-then-demolish can
   * never create or destroy blocks (the item-conservation law, applied to
   * walls). An annex/interior room is looked up by the ordinal in its id
   * (`_a3`, `_i1`); anything else is part of the original footprint and
   * settles for its partition.
   */
  function roomTeardownCosts(
    delta: BuildingDelta | undefined,
    room: HouseRoom,
  ): Record<string, number> {
    const am = /_a(\d+)$/.exec(room.id);
    const a = am ? (delta?.annexes ?? []).find((x) => x.ord === Number(am[1])) : undefined;
    if (a) return annexCosts(a);
    const im = /_i(\d+)$/.exec(room.id);
    const i = im ? (delta?.interior ?? []).find((x) => x.ord === Number(im[1])) : undefined;
    if (i) return interiorCosts(i);
    return baseRoomCosts(room.rect);
  }

  function commitDemolition(session: QuestSession, p: PendingDemolition): void {
    const t = session.town;
    const b = pendingBuildingOf(session, p.buildingKey);
    const plan = b?.plan;
    const room = plan?.rooms.find((r) => r.id === p.roomId);
    if (!t || !plan || !room) return; // the building/room is gone — the row just drops
    const hm = /^h_(\d+)$/.exec(p.buildingKey);
    const empty = p.mode === "empty";
    // The room's KIND, read off the LIVE plan BEFORE the act — the want it
    // answered dies with it, and afterwards there is nothing left to derive
    // the kind from.
    const goneKind = room.kind;
    // THE FURNITURE BECOMES REAL FIRST (blueprint.ts) — before anything else
    // reads it. Taking a room down re-draws the whole house, and after this
    // line that re-draw moves nothing. It must precede `generatedPiecesIn`: a
    // materialized building has no generated pieces left, so the empty path
    // carries each piece out exactly once instead of stowing some of them
    // twice (item conservation).
    materializeFurniture(session, p.buildingKey);
    // Snapshot the room's PLACED containers before the act — their stacks
    // move with the pieces (never orphaned under a dead object id). An
    // EMPTYING carries the GENERATED boxes out too, so theirs move as well.
    const generated = empty ? generatedPiecesIn(session, p.buildingKey, room) : [];
    const removedBoxes = (
      hm || empty
        ? (t.deltas.get(p.buildingKey)?.placed ?? [])
            .filter((q) => q.roomId === p.roomId)
            .map((q) => q.id)
        : []
    ).concat(generated.filter((g) => session.containerStock.has(g.id)).map((g) => g.id));
    const res = empty
      ? emptyRoom(t.deltas, p.buildingKey, plan, p.roomId, generated)
      : demolishRoom(t.deltas, p.buildingKey, plan, p.roomId);
    if (!res.ok) {
      presenter.toast(
        empty
          ? `💬 the ${goneKind} can't be cleared out after all`
          : `💬 the ${goneKind} can't come down after all`,
        "feedback",
      );
      return;
    }
    // WALLS DECONSTRUCT BACK INTO BLOCKS (phase 3 — the structures doc's
    // law): a torn-down room banks its block bill beside its stowed
    // furniture. Legacy wood-built rooms refund blocks too — rooms carry
    // no build provenance, and the upgrade is in the player's favor.
    // An EMPTYING refunds NOTHING: the walls are still standing.
    //
    // THE REFUND IS THE ROOM'S OWN BILL (phase 6), resolved by what the room
    // IS: an annex gives back its floor, roof and walls (the footprint
    // genuinely shrinks); an interior cut and a base room give back the one
    // partition that comes down. A flat refund would have minted blocks out of
    // nothing the moment bills started varying — cut the cheapest partition,
    // demolish it, bank a whole annex.
    const wallRefund: Record<string, number> = {};
    if (!empty) {
      for (const [head, n] of Object.entries(roomTeardownCosts(t.deltas.get(p.buildingKey), room))) {
        wallRefund[head === BLOCK_GLYPH ? (refinedGlyphOf("wood") ?? head) : head] = n;
      }
    }
    bankStowed(session, p.buildingKey, res.stowed, { removedBoxes, refund: wallRefund });
    // THE WANT GOES WITH THE ROOM (phase 4 step 1 — never self-healing): a
    // demolished (or emptied) bedroom must not re-order itself the next
    // sweep. Then every OTHER row the removed furniture leaves unanswerable
    // comes off too.
    removeProgram(t.deltas, p.buildingKey, goneKind);
    dropUnmetPrograms(session, p.buildingKey, Object.keys(res.stowed) as StationKind[]);
    presenter.toast(
      empty ? `🧹 the ${goneKind} is cleared out` : `🔨 the ${goneKind} comes down`,
      "feedback",
    );
  }

  /** A PLAYER-ORDERED interior room on a WORK building (⑤b — the shell's
   *  subdivision path): the same designation pipeline as a house room,
   *  keyed by the work's construction delta (workDeltaKey — a founded
   *  shell's rooms survive every rebuild under `f_<ord>`). */
  function orderWorkRoom(
    session: QuestSession,
    workIndex: number,
    roomKind: HouseRoom["kind"],
    /** The exact cut the player LIT (⑦ growth area). Absent = the order
     *  picks the best one itself, the spoken/board path's behaviour. */
    pinned?: InteriorCandidate,
    /** WHO ORDERED THE CUT — as `stakeAnnex`, the same author on the same
     *  two questions (what can be reached, whose hauls these are). */
    issuer: string = LOCAL_PLAYER_CID,
  ): boolean {
    const t = session.town;
    const wk = t?.plan.works[workIndex];
    if (!t || !wk || wk.vacated) return false;
    const key = workDeltaKey(wk, workIndex);
    // Only a standing building subdivides — a scaffold has no interior.
    const fb =
      wk.foundedOrd !== undefined
        ? t.deltas.founded().find((f) => f.ord === wk.foundedOrd)
        : undefined;
    if (fb && !foundedBuildingDone(fb, buildDayNow(session))) {
      presenter.toast(`💬 the walls aren't up yet`, "feedback");
      return true;
    }
    const center = t.stage.center;
    const delta = t.deltas.get(key);
    const shape: HouseShape = { ...wk, index: 100000 + workIndex };
    const plan = buildingRoomPlan(
      center, workIndex, wk, wk.program ?? workProgram(wk.type), delta,
    );
    // A host a pending cut already targets is spoken for — two staked
    // cuts never share a room.
    const busyHosts = new Set(
      t.deltas
        .annexSites()
        .filter((p) => p.buildingKey === key && isInteriorCandidate(p.candidate))
        .map((p) => (p.candidate as InteriorCandidate).hostId),
    );
    const candidate =
      pinned && !busyHosts.has(pinned.hostId)
        ? pinned
        : interiorOptions(center, shape, plan, delta, roomKind, {
            keepRoot: false,
            excludeHosts: busyHosts,
          })[0];
    const rect = candidate ? annexWorldRect(center, shape, candidate) : null;
    // AN EMPTY ROOM IS ALREADY A ROOM (the law §Adding rooms) — the house
    // path's rule, on a shell: a bare interior room nobody's want claims
    // takes the designation and the furnish sweeps fill it, no cut staked.
    // (Ahead of the refusal below: a shell with no legal cut left but a bare
    // room standing can still be given one honestly.) A PINNED cut skips it:
    // the player pointed at a place, and that place is the answer.
    const spare = pinned
      ? null
      : spareRoomFor(session, key, plan, rect ? rect.w * rect.h : 0, roomKind);
    if (spare && pushProgramWant(session, key, roomKind, spare.id)) {
      presenter.toast(`🛏 the ${roomKind} takes the empty room`, "feedback");
      return true;
    }
    if (!candidate || !rect) {
      presenter.toast(`💬 no room for a ${roomKind} in there`, "feedback");
      return true;
    }
    const at = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    // MISSING MATERIALS never refuse (⑥): the cut posts and waits; the
    // shortfall is NAMED in the confirmation below.
    // AN INTERIOR CUT IS A PARTITION (phase 6) — no floor, no roof, no outer
    // wall, so it costs a fraction of the annex above. Subdividing a standing
    // shell is genuinely the cheap way to get a room, and now says so.
    const costs = interiorCosts(candidate);
    const missing = buildMissingMaterials(session, { costs }, at, issuer);
    const missingNames = Object.entries(missing).map(([g, n]) => `${n} ${g}`).join(", ");
    const p = t.deltas.postAnnexSite({
      buildingKey: key,
      candidate,
      costs,
      pile: {},
      startedDay: buildDayNow(session),
      buildDays: constructionGameDays(ANNEX_BUILD_DAYS, session.scale),
    });
    // THE PERSISTENT WANT (④) rides the work's own delta — the standing
    // program outlives the room it raises (and comes off with it, phase 4).
    pushProgramWant(session, key, roomKind);
    postPileHauls(
      session,
      {
        pileId: orderPileId(p.ord),
        at,
        missing: stagingMissing(p),
        glyph: ROOM_GLYPH[roomKind] ?? "room",
      },
      issuer,
    );
    presenter.toast(
      missingNames
        ? `🏗️ a ${roomKind} is staked out — we still need ${missingNames}`
        : `🏗️ a ${roomKind} is staked out — bringing materials`,
      "feedback",
    );
    return true;
  }

  /** A PLAYER-ORDERED demolition on a WORK building (⑤b) — the same
   *  designation path as a house room (stowed pieces bank into the
   *  builder's yard at completion; a work has no house boxes of its own). */
  function orderWorkDemolish(session: QuestSession, workIndex: number, roomId: string): boolean {
    const t = session.town;
    const wk = t?.plan.works[workIndex];
    if (!t || !wk) return false;
    const key = workDeltaKey(wk, workIndex);
    const plan = buildingRoomPlan(
      t.stage.center, workIndex, wk, wk.program ?? workProgram(wk.type), t.deltas.get(key),
    );
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room) return false;
    return postDemolition(session, key, plan, room);
  }

  /** A PLAYER-ORDERED EMPTYING of a WORK building's room (phase 4) —
   *  orderWorkDemolish's twin; the stowed pieces bank into the builder's
   *  yard, the walls stay up. */
  function orderWorkEmpty(session: QuestSession, workIndex: number, roomId: string): boolean {
    const t = session.town;
    const wk = t?.plan.works[workIndex];
    if (!t || !wk) return false;
    const key = workDeltaKey(wk, workIndex);
    const plan = buildingRoomPlan(
      t.stage.center, workIndex, wk, wk.program ?? workProgram(wk.type), t.deltas.get(key),
    );
    const room = plan.rooms.find((r) => r.id === roomId);
    if (!room) return false;
    return postDemolition(session, key, plan, room, "empty");
  }


  // ── WHAT IS GOING TO STAND HERE (phase 6) ───────────────────────────────
  // A site was a rectangle and a clock. These functions turn every live order
  // into the PLAN OF ITS OWN BILL — one outline per bay of floor, wall and
  // roof, plus one per piece of furniture a room program still wants —
  // coloured by whether that material is claimed, being made, or unreachable.
  //
  // Pure read, computed on demand from the same delta rows the orders live on.
  // Nothing is cached and nothing is written: a ghost is a projection, so it
  // can never disagree with the bill or survive the thing it describes.

  /** Blocks a pile holds, counting FACTED variants (`block.material_wood`)
   *  toward the head — the same head arithmetic the costs are paid in. */
  function stagedBlocks(pile: Record<string, number> | undefined): number {
    let n = 0;
    for (const [g, k] of Object.entries(pile ?? {})) {
      if (stackHead(g) === BLOCK_GLYPH) n += Math.max(0, k);
    }
    return n;
  }

  /** Is anything actually COMING for this pile — hauls walking, or blocks
   *  milling for it? The difference between an amber ghost (wait) and a red
   *  one (the site is starved and wants you). Reads the live agreements plus
   *  the reachable free stock, which is exactly what `postPileHauls` consults
   *  before it decides to toast a starved bill. */
  function pileSupplying(
    session: QuestSession,
    pileId: string,
    at: { x: number; y: number },
  ): boolean {
    for (const a of session.transfers.all()) {
      if (a.to !== pileId) continue;
      if (a.status === "pending" || a.status === "moving") return true;
    }
    // Nothing walking: can anything reachable still cover a block, directly or
    // through the refine chain (a yard of wood is a yard of blocks-to-be)?
    const free: Record<string, number> = {};
    for (const src of siteMaterialSources(session, at)) {
      for (const g of Object.keys(src.stack)) {
        const head = stackHead(g);
        free[head] = (free[head] ?? 0) + freeUnits(src.stack, session.reservations, src.id, head);
      }
    }
    return (withRefinableCredit(free)[BLOCK_GLYPH] ?? 0) > 0;
  }

  /**
   * THE DRAWING, DRAWN. Every blueprint slot with nothing standing on it gets
   * an outline, at the exact spot the piece will land on — because the outline
   * and the placement are now the same computation read twice, an outline is a
   * promise the placement is obliged to keep.
   *
   * Two flavours, because they are waiting on different things:
   *  - `owed` is waiting on MATERIALS (nothing like it exists, it has to be
   *    made), so it is painted against the town's reach the way a wall bay is:
   *    amber while blocks can still be got, red when they cannot.
   *  - `coming` is waiting on LEGS. The piece exists — it is standing in the
   *    wrong room, or it is in a box — and somebody is going to carry it here.
   *    Painting that red because the woodpile is empty would be a lie.
   *
   * The `blocked` set is the third case and the only one that asks the player
   * for anything: an ordered room whose floor cannot take the piece it is
   * ordered to hold. No amount of waiting fixes that; something has to come out
   * first, so it is drawn at the room's centre and always red.
   */
  function furnitureGhostsFor(
    session: QuestSession,
    buildingKey: string,
    /** Pieces with nowhere legal to stand — always red (`paintGhosts`'s set). */
    blockedIds: Set<string>,
  ): { owed: GhostPiece[]; coming: GhostPiece[] } {
    const bp = buildingBlueprintOf(session, buildingKey);
    const owed: GhostPiece[] = [];
    const coming: GhostPiece[] = [];
    if (!bp.slots.length && !bp.blocked.length) return { owed, coming };
    // (A PENDING want draws nothing — its room has no floor yet, so there is
    // nowhere honest to stand an outline. It shows up the moment the walls do.)
    const billOf = (kind: StationKind): number =>
      Object.values(furnitureItemOf(kind)?.craft?.consumes ?? {}).reduce((a, b) => a + b, 0);

    for (const task of buildingFurnishTasks(session, buildingKey)) {
      // A STOW has no destination — the piece is going into a box, and a box is
      // not a place on the floor to outline.
      if (!task.slot) continue;
      const g: GhostPiece = {
        id: `g_${buildingKey}_furn_${task.slot.id}`,
        kind: "furniture",
        x: task.slot.x,
        y: task.slot.y,
        w: task.slot.radius * 2,
        h: task.slot.radius * 2,
        facing: task.slot.facing,
        blocks: billOf(task.kind),
      };
      (task.act === "make" ? owed : coming).push(g);
    }

    for (const b of bp.blocked) {
      const id = `g_${buildingKey}_furn_blocked_${b.room.id}_${b.kind}`;
      const fdef = furnitureItemOf(b.kind);
      blockedIds.add(id);
      owed.push({
        id,
        kind: "furniture",
        x: b.room.rect.x + b.room.rect.w / 2,
        y: b.room.rect.y + b.room.rect.h / 2,
        w: (fdef?.radius ?? 0.4) * 2,
        h: (fdef?.radius ?? 0.4) * 2,
        blocks: billOf(b.kind),
      });
    }
    return { owed, coming };
  }

  /**
   * THE GHOST MEMO. `buildGhostsNow` is pulled by the renderer EVERY FRAME, and
   * it is not cheap: a furniture ghost costs a room plan, a furnish pass and a
   * placement search per unmet program row. So it recomputes on a CHANGE or on
   * a slow tick, never per frame.
   *
   * The version is what actually moves a ghost — a delta bump is every order,
   * every delivery, every wall that goes up. The clock is the backstop for the
   * things that change WITHOUT a delta write: a pile filling, a haul starting,
   * a source going out of reach. A quarter-second is well under the time it
   * takes a builder to cross a site, so nothing visibly lags.
   */
  const GHOST_REFRESH_S = 0.25;
  let ghostMemo: { at: number; version: number; ghosts: GhostPieceState[] } | null = null;

  /** Every unbuilt piece in the world right now, painted (memoized). */
  function buildGhostsNow(session: QuestSession): GhostPieceState[] {
    const version = session.town?.deltas.version ?? session.foundedSite?.deltas.version ?? 0;
    const now = session.taskClock;
    if (ghostMemo && ghostMemo.version === version && now - ghostMemo.at < GHOST_REFRESH_S) {
      return ghostMemo.ghosts;
    }
    const ghosts = computeGhosts(session);
    ghostMemo = { at: now, version, ghosts };
    return ghosts;
  }

  function computeGhosts(session: QuestSession): GhostPieceState[] {
    const out: GhostPieceState[] = [];
    const day = buildDayNow(session);
    const t = session.town;
    const site = session.foundedSite;

    // ── SHELLS STILL RISING ──────────────────────────────────────────────
    const foundedRows: Array<{ rows: readonly FoundedBuilding[]; at: { x: number; y: number } }> = [];
    if (t) foundedRows.push({ rows: t.deltas.founded(), at: t.stage.center });
    if (site) foundedRows.push({ rows: site.deltas.founded(), at: site.at });
    for (const { rows, at: base } of foundedRows) {
      for (const b of rows) {
        if (foundedBuildingDone(b, day)) continue;
        const rect = { x: base.x + b.dx, y: base.y + b.dy, w: b.w, h: b.h };
        // OBSERVED SITES ONLY — the same reach the order loop uses to decide
        // whether a site runs on builders or on the clock. A farm is 68
        // outlines; drawing every site in a grown town would cost hundreds of
        // meshes nobody can see, and an unobserved site is scenery by
        // definition.
        if (!observedRect(session, rect)) continue;
        const centre = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
        const pileId = orderPileId(b.ord);
        out.push(
          ...paintGhosts(shellGhostPieces(`g_f${b.ord}`, rect), {
            staged: stagedBlocks(b.pile),
            supplying: pileSupplying(session, pileId, centre),
          }),
        );
      }
    }

    if (!t) return out;
    const center = t.stage.center;

    // ── ROOMS STAKED OUT ON STANDING BUILDINGS ───────────────────────────
    for (const p of t.deltas.annexSites()) {
      const b = pendingBuildingOf(session, p.buildingKey);
      if (!b) continue;
      const rect = annexWorldRect(center, b.shape, p.candidate);
      if (!observedRect(session, rect)) continue;
      const centre = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      // An outward annex builds every wall BUT the one it shares with the
      // house; an interior cut builds ONLY the partition. Both edges are read
      // off the geometry (build-ghosts.ts) rather than the door-local frame.
      const hostId = isInteriorCandidate(p.candidate) ? p.candidate.hostId : null;
      const host = hostId
        ? b.plan.rooms.find((r) => r.id === hostId)?.rect
        : { x: center.x + b.shape.dx, y: center.y + b.shape.dy, w: b.shape.w, h: b.shape.h };
      const opts = hostId
        ? { wallsOnly: true, onlyWall: host ? freeEdgesOf(rect, host) : [] }
        : { skipWall: host ? [sharedEdgeWith(rect, host)] : [] };
      out.push(
        ...paintGhosts(shellGhostPieces(`g_a${p.ord}`, rect, opts), {
          staged: stagedBlocks(p.pile),
          supplying: pileSupplying(session, orderPileId(p.ord), centre),
        }),
      );
    }

    // ── THE EMPTY PLACES IN THE DRAWING ──────────────────────────────────
    // Furniture is CRAFTED, not staged at a site pile — there is no per-piece
    // heap to read. So for a piece that must be MADE the question is only
    // whether the town can still reach the blocks: amber while it can, red when
    // it cannot. A piece that already exists and merely has to be carried over
    // is amber unconditionally, and a piece with nowhere to stand is red
    // regardless — neither of those is about materials at all.
    const paintWants = (key: string, at: { x: number; y: number }): void => {
      const blocked = new Set<string>();
      const { owed, coming } = furnitureGhostsFor(session, key, blocked);
      if (owed.length) {
        out.push(
          ...paintGhosts(owed, {
            staged: 0,
            supplying: pileSupplying(session, `${BFURN_EP}${key}`, at),
            blocked,
          }),
        );
      }
      // Waiting on legs, never on the woodpile — always the amber "on its way".
      if (coming.length) out.push(...paintGhosts(coming, { staged: 0, supplying: true }));
    };

    // WORK BUILDINGS — only ones that are STANDING: a shell whose walls are
    // not up yet has no floor to promise a bed a place on.
    for (let wi = 0; wi < t.plan.works.length; wi++) {
      const wk = t.plan.works[wi]!;
      if (wk.vacated) continue;
      const fb =
        wk.foundedOrd !== undefined
          ? t.deltas.founded().find((f) => f.ord === wk.foundedOrd)
          : undefined;
      if (fb && !foundedBuildingDone(fb, day)) continue;
      if (!observedRect(session, { x: center.x + wk.dx, y: center.y + wk.dy, w: wk.w, h: wk.h })) {
        continue; // out of reach — and each of these costs a placement search
      }
      paintWants(workDeltaKey(wk, wi), workDoorstep(center, wk));
    }

    // HOUSES — the case the player actually watches. An ordered bedroom with
    // no bed in it owes a bed exactly the way a workshop owes its bench, and
    // it is the same blueprint slot driving the same craft queue.
    for (const h of t.plan.houses) {
      const rect = { x: center.x + h.dx, y: center.y + h.dy, w: h.w, h: h.h };
      if (!observedRect(session, rect)) continue;
      paintWants(`h_${h.index}`, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
    }
    return out;
  }

  return {
    setWorld: (w: WorldHost | null) => { world = w; },
    setSites: (s: ConstructionSite[]) => { lastSites = s; },
    sites: () => lastSites,
    buildGhostsNow,
    clearSpotCache: () => { spotCache = null; },
    shellFurnPilesOf,
    prosperitySignals, stepConstructionHousekeeping,
    foundNewSite, stepFoundedSite,
    buildContext, buildSpotsNow, cancellableSite, cancelWork, structureLabelOf,
    structureCatalogOf, buildMissingMaterials, pendingGrowthRects,
    steeringNear, buildCandidates, buildworkSiteAt, foundedLotAt,
    pendingAnnexAt, pendingBuildingOf, agrHolder, bagHolder, onTransferLanded, buildDayNow,
    isCivicStockDest,
    // THE BLOCK CHAIN's two decision points (phase 5's masonry split): WHERE a
    // raw is worked, and WHICH raw gets worked first. Everything else in the
    // chain is the ordinary order loop, already reachable through the step
    // functions above; these two are pure lookups over the town plan that no
    // exported path exposes, and the routing they decide is invisible from
    // outside until a hauler has already walked to the wrong bench.
    refineSpotOf, ensureRefineOrders,
    executeBuildOrder, stepFoundedConstruction, stepFurnitureSetup,
    orderCraft, orderBuild, orderZone, stepZonedFounding,
    structureFocusOf, structureActsFor, structureConstructionOptions, structureFurnishOptions,
    orderAnnex, stakeAnnex, orderDemolish, orderWorkRoom, orderWorkDemolish,
    // PHASE 4 — the removal verbs (empty a room, break one piece).
    orderEmpty, orderWorkEmpty, orderBreakPiece,
  };
}
