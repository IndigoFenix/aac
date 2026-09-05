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
  FOUNDING_AGE_DAYS, wellVergePoint, type TownHouse,
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
  registerContainer,
  setContainerStock,
  ensureContainerStock,
  // ⚖️ #50 ① — how much ONE porter moves in ONE trip; the haul poster sizes
  // its rows to it (see `haulTripUnits`), never to a literal 8.
  haulTripUnits,
  stockedEntries,
  stockedIds,
  hasStock,
  deleteContainerRecord,
  isLooseProp,
  looseEntries,
} from "@shared/world-engine/kernel/town/containers.js";
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
  groundObstacles,
  interiorOptions,
  foundedProgress,
  isInteriorCandidate,
  markPieceSetUp,
  nextPlacedSerial,
  orderGathering,
  pendingRoomKindOf,
  pileEntries,
  // ⚖️ PULL-MODEL LABOR (task #51) — the two bill reads that used to be
  // closures in here. Hoisted to the kernel beside `stagingMissing` so a BODY
  // deciding its own contribution reads the same arithmetic the bookkeeper
  // does; the copies below were deleted, not left to drift.
  pileShortfall,
  refineBookOf,
  TOWN_ORDER_SCOPE,
  placeFurniture,
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
  // ⚖️ THE FELLING PREREQUISITE (2026-09-02) — the footprint∩wilderness test
  // and the settlement's own occupied ground, ONE derivation read both ways.
  FOUNDING_CLEARANCE,
  clearingPending,
  featuresOnFootprint,
  settlementFootprints,
  type AreaRecordStore,
  type GroundFeature,
  type Rect,
} from "@shared/world-engine/kernel/town/construction.js";
// ⚖️ PULL-MODEL LABOR (task #51) — THE SEAM, and the only thing this file
// knows about the other side of it. `pullLaborOn` is the ONE capability
// derivation (a READ, never a boot boolean: founding is a mid-session act);
// `isContributePursuit` is the ONE test that a body chose a bill and is
// working it. The director imports no quest-host type to ask either.
import {
  isContributePursuit,
  pullLaborOn,
  CLEAR_SITE_PREFIX,
  type ContributeBill,
  type FellRow,
} from "@shared/world-engine/kernel/town/pull-labor.js";
import {
  BLOCK_GLYPH,
  effectiveInPerOut,
  rawsForRefined,
  refinedGlyphOf,
  sourceBlocksBuilding,
  withRefinableCredit,
} from "@shared/world-engine/products.js";
import {
  createReservationLedger,
  freeUnits,
  resolveMaterials,
  spareStock,
  unreservedStock,
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
  costsMet,
  resolveStructure,
  structureCosts,
  structureDisplayGlyph,
  type CostBearing,
  type StructureSpec,
} from "@shared/world-engine/kernel/town/structures.js";
import {
  candidateInZone,
  categoriesOfSpec,
  communityGroundOf,
  ensureCommunityGround,
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
  allocateHands,
  bodyCarryView,
  type BodyCarry,
  type ScopeHands,
} from "@shared/world-engine/kernel/town/scope-shape.js";
import { goodsValueS, priceOf, townFillS } from "@shared/world-engine/kernel/town/pricing.js";
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
  clearFirstLine,
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
  sourceKindWord,
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
// ⚖️ ONE DEFINITION of `resident_<hi>_<m>` → the house index (task #51 item ⑤).
// 🚨 It is DELIBERATELY naive — it splits on `_` and takes field 1 — so every
// caller owes it a prefix gate; `viewerHouseOf` is where this file pays that.
import { houseIndexOfCid } from "@shared/world-engine/interaction/quest/creature-inspect.js";
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
import { roadDistance, roadRoute, type GrowSeed } from "@shared/world-engine/kernel/town/streets.js";
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
  wildFeatureRadiusOf,
  wildFeatureSizeRank,
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
import {
  drinkGlyphs, isBodyProduct, naturalSourceOf, sourceIsCuttable, sourceSpent, sourcesForGood, takeUnitsOf,
} from "../../products.js";
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
import { DEFAULT_TASK_TTL_S, type PooledTask } from "../behavior/task-pool.js";
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
  CIVIC_SCOPES,
  TOWN_SCOPE,
  creatureScope,
  houseScope,
  isPrivateOwner,
  mayUse,
  mayUseByScopes,
  ownerCidsOf,
} from "../behavior/ownership.js";
import {
  parseScopeId,
  scopeIdReceivesGoods,
  wildAreaId,
} from "@shared/world-engine/kernel/town/scope.js";
// #44 — region records join the construction supply: the standing stock is
// COUNTED (never moved) straight off the record; movement stays endpoint-
// shaped through the boundary shelf.
import { wildAreaStock, wildRectPointToward, type WildAreaRecord } from "./wild-area.js";

/**
 * ⚖️ #49 STAGE 2 — HAND THE SESSION'S WHOLE RECORD INDEX TO A NEW DURABLE
 * STORE. Called at the two moments the store CHANGES rather than the records:
 * a FOUNDING (the site's books take over from the town's — the same instant
 * `transfers`/`reservations`/`partnerStock` are re-pointed) and an
 * ABANDONMENT (they go back).
 *
 * Records are values — every wild-area function returns a new one — so the
 * rows are handed over verbatim, with the session's clock as their anchor.
 * Rebuilt rather than merged: a record the session no longer holds must stop
 * being durable in the same instant.
 */
function adoptAreaRecords(session: QuestSession, store: AreaRecordStore): void {
  store.rows.clear();
  for (const [key, rec] of session.areaRecords) store.rows.set(key, rec);
  store.at = session.taskClock;
}
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
import { constructionGameDays, serviceRadiusM, type WorldScale } from "@shared/world-engine/scale.js";

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
/** 🚨 IS THIS ID A PILE WHOSE STACK LIVES ON THE ORDER BOOK rather than in
 *  `containerRecords`? Four spellings, one law:
 *   • `orderpile:`/`sitepile:`/`annexpile:` — the ORDER ROW's own live `pile`
 *     (quest-host `pileOrderRow`/`pileEndpointOf`, which own the per-spelling
 *     eligibility and the annex `legacyOrd`-first fallback);
 *   • `bfurn:` — the shell's furniture-delivery pile on TownDeltas
 *     (`shellFurnPiles`, quest-host's `buildingFurnPile` branch).
 *  Every reader resolves all four through `stockEndpointOf`, so any WRITER
 *  that reaches for `containerRecords` under one of them is filling a store
 *  nobody will ever read, and the goods it debited are destroyed — see
 *  frontier-conservation-diagnosis.md §4 and §8. */
export function isPileEndpointId(id: string): boolean {
  return (
    id.startsWith(ORDER_PILE_EP) ||
    id.startsWith(SITE_PILE_EP) ||
    id.startsWith(ANNEX_PILE_EP) ||
    id.startsWith(BFURN_EP)
  );
}
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
// ⚖️ THE `pullLabor` CAPABILITY IS ASKED THROUGH `pullLaborOn(session)` DIRECTLY
// (task #51) — ONE DEFINITION, in `kernel/town/pull-labor.ts`. This file used to
// wrap it in a local `pullOn` that normalized the three fields, because the
// kernel read was written `foundedSite !== null` and a PARTIAL session (the
// normal shape of a director unit fixture) simply LACKS the field —
// `undefined !== null` is `true`, so an unnormalized read handed the capability
// to every fixture in the suite. 1b fixed that AT THE SOURCE (`!= null`, with
// the trap stated there), so the wrapper became a second answer to a question
// that must only have one. Every seat below still re-reads it PER SWEEP: founding
// is a mid-session act in a wild session, so a boot-time boolean would answer
// "no" for the whole life of the world this round exists to serve.

/**
 * ⚖️ WHO IS WORKING THIS SITE'S BILL, BY PURSUIT (task #51 item ③) — the pull
 * model's replacement for "which bodies claimed a `buildwork` row".
 *
 * 🚨 THE HARDEST COUPLING OF THE ROUND, stated as a function: labour banked
 * only for bodies whose CLAIMED POOLED TASK pointed at the site, so a body
 * standing at the work with no row banked ZERO — remove the rows without
 * replacing this read and all construction silently stops. The replacement
 * asks the body instead of the book: a contribute pursuit names the site it
 * serves (`bill.siteId`, the exact string `workSite` is called with —
 * `orderSiteId`), and the two DWELL links are the ones that do labour. A
 * `haul`/`fell` slice for the same site is real contribution and is NOT a
 * builder: its work is the trip, and counting it would bank bench-labour for
 * somebody walking a road.
 *
 * Sorted by cid so the crew list is the same on every peer (the pool's own
 * determinism law); presence and its per-body effects are order-independent
 * anyway, so the sort is hygiene, not a fix.
 */
export function contributeCrewAt(
  pursuits: ReadonlyMap<string, { tplKey?: string; bill?: ContributeBill }>,
  siteId: string,
): string[] {
  const out: string[] = [];
  for (const [cid, p] of pursuits) {
    if (!isContributePursuit(p)) continue;
    if (p.bill.siteId !== siteId) continue;
    if (p.bill.link !== "build" && p.bill.link !== "refine") continue;
    out.push(cid);
  }
  return out.sort();
}
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

/**
 * ⚖️ HOW FAR A CIVIC TASK RECRUITS — the SITE'S OWN NEIGHBOURHOOD, and no
 * further (civic-labor-and-polish.md §1, "conscription must be LOCAL").
 *
 * "Everyone works together" STANDS; what it may not mean is *everyone in
 * town*. The pool's candidates are registered creatures plus **embodied**
 * street residents, and embodiment follows the CAMERA — so for a site the
 * camera is not standing at, the only bodies inside a town-wide radius are
 * the player's always-embodied family, and `chooseClaimant`'s "nearest wins"
 * elects them BY FORFEIT. Observed 2026-08-07 (seed 7, a spoken `build
 * workshop`): mara spent 95 of 95 sampled frames on `drive=task`/`transfer`,
 * walking a ~520 m round trip to the town yard and back, while the households
 * beside the site — abstracted, therefore invisible to the pool — did nothing.
 * A site with no LOCAL body does not get one shipped in: it banks on the
 * schedule (the clock arm), which is what an unwatched town has always done.
 *
 * ⚖️ THE RADIUS IS DERIVED, and it is the SAME derivation the districts use
 * (`serviceRadiusM` — needs-aware districts: "a district is a need cycle's
 * walk across"). Two terms used to stand here; only the second survives:
 *
 *   · `plan.radius × 2` — the town's own DIAMETER. THIS was the over-reach:
 *     it made "the neighbourhood" mean "the town", which is the whole bug.
 *   · `serviceRadiusM(scale, "social")` — the reach itself now. WHY THE
 *     SOCIAL CLOCK (unchanged reasoning): a work party is a GATHERING, not
 *     hunger and not energy, and `social` is the drive that already measures
 *     how far a body ranges to be among its neighbours. On the shipped street
 *     profile that is 1.6 m/s × 192 s × 0.5 / 2 = **76.8 m** — a walk of about
 *     a minute, which is what "the next street over" costs.
 *
 * Off a town the WILDERNESS EARSHOT rule stays exactly as it was
 * ({@link SITE_HAUL_FOCUS_R}), and it doubles as the floor in town: a world
 * whose social clock runs faster than the legs never recruits from less than
 * shouting distance.
 */
export function civicRecruitRadiusM(scale: WorldScale, inTown: boolean): number {
  return inTown ? Math.max(SITE_HAUL_FOCUS_R, serviceRadiusM(scale, "social")) : SITE_HAUL_FOCUS_R;
}

/** A waiting plot re-resolves its missing materials at most this often —
 *  fresh stock (a felled tree hauled to the yard) unsticks it, without
 *  re-posting expired tasks every sweep.
 *
 *  ⏸️ For the CRAFT JOB this is now the park's `staleAt`-side rate limit only —
 *  see `craftGatherParkKey` (scope-behaviors.md §2.5.1: the re-gather "re-runs
 *  `resolveMaterials` on a clock while nothing has moved"). The SITE piles
 *  still ride it as a plain gate; converting them is the same park at a third
 *  scope and wants its own pass.
 *
 *  ⚖️ WHO OWNS IT UNDER PULL (task #51 item ⑥). Off the capability this is the
 *  POSTER's gate, exactly as written above. Under it there is no poster — and
 *  the gate is kept anyway, now owning the BOOKKEEPING sweep: `bookPileUnderPull`
 *  walks every source in reach once per head, and the ④ ONE-VOICE law forbids
 *  a standing condition re-announcing itself per tick. Dead on neither path,
 *  so it stays. */
export const SITE_HAUL_RETRY_S = 20;
// ── THE BLOCK CHAIN (phase 3) ───────────────────────────────────────────
/** Street-days of milling per refined unit, RELATIVE like ANNEX_BUILD_DAYS
 *  (a block is small work — a 6-block house bill mills in ~a third of the
 *  house's own build). */
export const REFINE_UNIT_BUILD_DAYS = 0.05;
/** Milling is BENCH work — one hand, however many volunteer. The one rate
 *  function under this cap keeps the 0.8 clock parity for refines too. */
export const REFINE_CREW_CAP = 1;
/** ⚖️ A MILL DELIVERS IN BATCHES (homestead-defect-round ④). One refine row
 *  is capped at this many OUTPUT units, so a 120-block bill mills as ten
 *  short rows in sequence — each staging quickly, committing quickly, and
 *  landing blocks at the site while the next batch gathers — instead of one
 *  row that shows nothing until 240 wood stand in a single pile. Sized to a
 *  basket-porter's few trips (12 blocks = 24 wood at the shipped 2:1) and
 *  ~0.6 build-days of bench labor per commit. The batch is a DELIVERY
 *  cadence, never extra work: total labor is REFINE_UNIT_BUILD_DAYS × units
 *  regardless of how it is sliced. */
export const REFINE_BATCH_UNITS = 12;
/** The storehouse's raw par level, PER RAW (wood, stone): free stored
 *  units under this post ambient gather hauls from the wild — logging as
 *  a standing town activity, storehouse-fed. THE DIAL-1 ANCHOR — read it
 *  through `storehouseRawParAt` wherever a live dial is in reach; the bare
 *  constant is kept exported for `commonsReserveOf`'s own doc and any
 *  reader that genuinely wants the real anchor, never the effective par. */
export const STOREHOUSE_RAW_PAR = 12;
/** The par-stock sweep's retry gate (seconds). */
export const STOREHOUSE_STOCK_RETRY_S = 60;

/**
 * ⚖️ S&D S3 H1 — multiplier ④ of five, AND THE PAR≡RESERVE COUPLING'S OTHER
 * HALF. `STOREHOUSE_RAW_PAR` is a BILL (how much raw stock the town buffers
 * to cover its own build appetite), so the dial divides it — `bills ÷ dial`,
 * same direction as `effectiveInPerOut`/`blockCosts`: a world whose
 * buildings need less raw material per block also needs a smaller shelf
 * buffer to cover the same construction pace. Floored at 1 (a par of 0
 * would mean the ambient gather never fires at all). Default 1, byte-
 * identical (`storehouseRawParAt(1) === STOREHOUSE_RAW_PAR`).
 *
 * `commonsReserveOf` calls THIS, never the bare constant — DECLARING THE
 * PAR≡RESERVE COUPLING: moving the par with the dial moves the reserve
 * floor by construction, because they are the same function call. There is
 * no second number to keep in step.
 */
export function storehouseRawParAt(conversionDial = 1): number {
  return Math.max(1, Math.round(STOREHOUSE_RAW_PAR / Math.max(1e-9, conversionDial)));
}

/**
 * ⚖️ THE COMMONS RESERVE — units of a material head the town holds back from
 * its OWN automated appetite, so a SPOKEN order always has something to draw.
 *
 * User addendum (2026-08-12): *"the fact that there aren't enough blocks to go
 * around suggests that either the town isn't stockpiling a surplus or that the
 * town's own demands are exceeding its capacity. This is probably patchable
 * with a simple surplus control, with the actual machinery going into the
 * detailed supply and demand economics."* This is that patch, and it is the
 * G1/G2 SPARE pattern at a third rung: a creature keeps at least one of
 * anything and gives only its surplus (`hasSurplus`); a town keeps its PAR and
 * spends only above it.
 *
 * 🚨 DERIVED, NEVER A NEW NUMBER, and the derivation is the whole argument.
 * The floor IS `STOREHOUSE_RAW_PAR`, for exactly the heads the par loop
 * restocks (`rawsForRefined(BLOCK_GLYPH)` — the same call `stepStorehouseStock`
 * makes). Three reasons that is the honest one:
 *
 *   · The town ALREADY declares this number to be what it wants on the shelf,
 *     and already works to restore it (the wild gather hauls). A reserve above
 *     par would be a stockpile the town never tries to reach; below par, a
 *     shelf the par loop immediately refills into the same appetite.
 *   · A head has a reserve exactly when it has a PAR. Nothing else needed a
 *     number invented for it, and no head can now be reserved that the town
 *     has no way to restock.
 *   · The household `boxCap` family was the other candidate in reach and is
 *     the WRONG rung: a box's capacity is what one family can store, not what
 *     the settlement keeps back, and it would make the commons' floor a
 *     function of furniture.
 *
 * NOT a claim, NOT a reordering: first-come reservations STAND (user ruling —
 * no preemption of existing holds). The floor only bites on the NEXT automated
 * draw. It is deliberately COARSE, exactly as the addendum asks; the real
 * machinery is the supply-and-demand round.
 *
 * `conversionDial` — see `storehouseRawParAt`, which this reads exclusively
 * (THE COUPLING). Default 1 keeps every caller that has not been updated to
 * pass a live dial byte-identical; call sites that hold a `session` should
 * pass `session.scale.resourceCompression`.
 */
export function commonsReserveOf(head: string, conversionDial = 1): number {
  return rawsForRefined(BLOCK_GLYPH).some((p) => stackHead(p.glyph) === stackHead(head))
    ? storehouseRawParAt(conversionDial)
    : 0;
}

/**
 * ⚖️ A DEMAND IS MET WITHIN THIS MUCH (S&D S1) — the noise floor on
 * `townShortage` under which prosperity may accrue. Not a tolerance for
 * hunger: the aggregate books hover by fractions of a percent around
 * equilibrium, and gating on a literal `> 0` would mean no household on any
 * map ever banked again. Past it, a demand is genuinely unmet and the day
 * banks nothing.
 */
export const PROSPERITY_DEMAND_MET = 0.05;

/** ⚖️ THE HOUSEHOLD'S KEEP-ONE FLOOR (S&D S1) — the G1/G2 spare rule at the
 *  smallest rung, as a `spareStock` floor function: a creature keeps at least
 *  one of anything and gives away the rest, so one unit of a head is never
 *  wealth. Head-blind by design; there is no head a household would keep two
 *  of on principle. */
export const HOUSEHOLD_KEEP_ONE = (): number => 1;

/**
 * ⚖️ IS THIS A DERIVED-STOCK OBJECT — a market shelf (`marketStore`) or a
 * producer's gate pile (`produceBox`)? Both stand as staged world objects
 * with a `containerRecords` row (so they anchor, get walked to, get
 * glyphed) but deliberately carry NO `.stock` map of their own — the
 * quest-host seeding comment says so at each ("NO containerStock — a
 * market shelf's stack is DERIVED (marketStore), never stored"; "a
 * producer pile's stack is DERIVED too"). The number a shopper sees is
 * computed live from the town's economy (`marketStoreUnits`/
 * `produceBoxUnits`) each time it's asked, never held as a stack anyone
 * could put into or a `stockedEntries` sweep could find. Nothing may PUT
 * into one, offer it as a transfer/craft SOURCE, or get a `StockEndpoint`
 * for one directly.
 *
 * This exact `session.marketStore.has(x) || session.produceBox.has(x)` test
 * was copy-pasted at eight call sites across quest-host.ts and this file.
 * SIX of them (quest-host's `stowCarriedIn`/`putSelectedIn`/`stockEndpointOf`/
 * `transferSourcesOf`; this file's `craftMaterialSources`/`siteMaterialSources`)
 * ALSO reject `x.startsWith("trade:")`, a "trade <good>" civic-board OPTION
 * id (quest-host's build/area/trade board), never a `containerRecords` entry
 * at all. The other two (`craftSpotOf`, `refineDepositId`) never see a
 * `trade:` id in the first place — one walks a building's furniture, the
 * other a `stockedEntries`/`stockedIds` sweep, and neither iteration source
 * can yield a bare UI-option id. So the `trade:` leg is a different
 * vocabulary (UI affordance ids, not economy objects), not a fact this
 * predicate could honestly fold in — it stays written out at the six call
 * sites whose id space can actually see one.
 *
 * RELATION TO THE GRAMMAR (scope.ts): every id these two maps hold is
 * seeded already shaped `store:<good>:<idx>` / `produce:<good>:<work>` —
 * exactly `SHELF_PREFIX`/`PRODUCE_PREFIX`, so `parseScopeId` would call them
 * `shelf`/`produce` ScopeRefs, and `scopeReceivesGoods` would say they DO
 * receive goods (they are shelving, not a `wild` source that only yields).
 * That is a fact about what KIND of place these are; this predicate asks a
 * narrower, ORTHOGONAL question — not "can this be stocked" but "is this
 * session's registry, right now, saying the stock is computed rather than
 * stored." The grammar says a shelf may hold goods; the object registry
 * says these particular shelves don't, yet.
 */
export function isDerivedStoreObject(session: QuestSession, objId: string): boolean {
  return session.marketStore.has(objId) || session.produceBox.has(objId);
}

/** The host-service seam: every quest-host closure the verbatim-moved
 *  bodies still reach for. Function entries destructure under their host
 *  names so the bodies needed no edits; the four accessors at the bottom
 *  wrap host MUTABLE state (their call sites are marked "phase 1a"). */
export interface ConstructionDirectorCtx {
  presenter: QuestPresenter;
  deps: Pick<QuestHostDeps, "onSiteFounded" | "onSiteAbandoned" | "siteNetworkAt">;
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
  postPooledTask(
    session: QuestSession,
    goal: GoalSpec,
    issuer: string,
    focus: TaskFocus,
    sourceGlyph: string,
    /** ⚖️ batch 2 L1 — hand-seconds this task is worth, when the poster has
     *  the number in hand (see `PooledTask.valueS`). */
    valueS?: number,
    /** ⚖️ #45 — the head a CIVIC sweep posted this to cover (see
     *  `PooledTask.need`): the why-chain answers "because the town needs X"
     *  and never "because you asked" for a task nobody spoke. */
    need?: string,
    /** ⚖️ #50 ④ — A PLAYER ASKED FOR THIS (see `PooledTask.spoken`): the pool
     *  offers a spoken order's tasks to claimants ahead of ambient ones.
     *  Omitted/false = the ambient row it has always been. */
    spoken?: boolean,
  ): void;
  /** ⚖️ batch 2 L3 — THE one freeness predicate (quest-host `handIsFree`):
   *  no errand queue, no live pursuit, no pooled claim, no party/escort/
   *  possession, and NOT inside a job shift. */
  handIsFree(session: QuestSession, cid: string): boolean;
  /** ⚖️ batch 2 L3/L4 — the town's labour pool as a reading (quest-host
   *  `townHandPool`). Sites SHARE it; none of them mints its own crew. */
  townHandPool(session: QuestSession): ScopeHands;
  playerWorldPos(session: QuestSession): { x: number; y: number } | null;
  familyOf(session: QuestSession): { house: number; mode: "some" | "all"; members: TownFamilyMember[] } | null;
  playerFocusArea(session: QuestSession): TaskFocus | null;
  /** ⚖️ #44 — THE DRAW ARM (quest-host `drawSourceShelf`): fell record →
   *  boundary shelf for exactly the goods asked, conserving by construction.
   *  The director's region draws run through THIS so the scheduled sweep,
   *  the twin and the walked haul all fell with one pair of hands. */
  drawSourceShelf(
    session: QuestSession,
    key: string,
    goods: Readonly<Record<string, number>>,
  ): void;
  issueTransferHaul(session: QuestSession, cid: string, agreementId: string): void;
  enqueueNpcErrand(session: QuestSession, npcId: string, errand: NpcErrand): void;
  townShortage(session: QuestSession, good: string): number;
  /** ⚖️ `townShortage`'s MIRROR (S&D S1): production above COMMITTED DEMAND
   *  (own need + export owed) as a fraction of it, 0 when the books merely
   *  balance. The growth motive's feed — one definition, host-side, because
   *  the export commitment lives there. */
  townSurplus(session: QuestSession, good: string): number;
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
  depleteWildSource(session: QuestSession, objId: string): void;
  /** ⚖️ THE REMOVAL ACT (2026-09-02) — felling's sibling for a source with no
   *  kill product: sheds whatever it still bears onto the ground where it
   *  stood, then takes the plant out of the world. False when it is not a
   *  removable standing feature, or when the shedding could not finish (in
   *  which case NOTHING was removed — see the host's own law). */
  cutWildFeature(session: QuestSession, objId: string, intoCid?: string): boolean;
  /** ⚖️ "get wood" means "cut a tree" — the means-end step in front of an
   *  automated draw on a standing body's kill glyph. Moves nothing. */
  cutForDraw(session: QuestSession, objId: string, glyph: string): void;
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
  /** WHAT THE TOWN'S TREE GREW AROUND (`TownStreets.seeds`). Enumeration
   *  regrows that tree, so it must re-enter growth with the SAME seeds or
   *  the candidate lots belong to a town that doesn't exist. */
  seeds: readonly GrowSeed[];
  /** LEGACY companion (`TownStreets.bearings`) — only the bare directions,
   *  so it cannot stand in for a route town's spans. Passed alongside for
   *  the seedless case, where both are empty and growth invents. */
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
    stockEndpointOf, postPooledTask, playerWorldPos, familyOf, drawSourceShelf,
    playerFocusArea, issueTransferHaul, enqueueNpcErrand, townShortage, townSurplus,
    standAvoid, stackTake, spawnLooseProp, residentTownCtx, removeLooseProp,
    relationToward, pushPocket, itemLocOf, issueGoalPlan, handlePlaceOrder,
    gazeCreature, fireCarryGesture, depleteWildSource, cutWildFeature, cutForDraw, dropFromStack,
    takeIntoHands, setDownFromHands, bodyCarryOf, takeUnitsFromBody,
    creatureMood, handIsFree, townHandPool,
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
   * ⚖️ A household's PROSPERITY signals for the day — RE-DERIVED AS REAL
   * SURPLUS (S&D S1; growth-motive law ②, user 2026-08-12: *"growth doesn't
   * happen for no reason, it happens due to unfulfilled needs"*).
   *
   * WHAT THIS USED TO BE, and why it had to go: `pantry` scored how full the
   * street-good boxes sit (×0.8) and `breadth` how many distinct stacks the
   * chests hold (×0.4). Both are SATIETY. A household that eats well banked
   * every single day and eventually built a room — the city grew because the
   * bank always filled, which is exactly the fault the law names.
   *
   * WHAT IT IS NOW — the SPARE PATTERN at the household rung, the same three
   * terms the commons reserve uses one floor up (`spareStock`):
   *
   *   stock − COMMITTED DEMAND − RESERVE = surplus, and only surplus banks.
   *
   * ① **An unmet demand banks NOTHING.** If the town is not meeting its own
   *    demand for a street good (`townShortage` past the noise floor), or the
   *    household's box has fallen under the buffer it keeps
   *    (`surplusUnits` — its own declared reserve), the day banks zero. A
   *    FULL PANTRY IN A SHORT TOWN IS NOT SAVINGS; it is the buffer draining.
   * ② **Satiety banks nothing, ever.** The pantry sawtooth runs between the
   *    keep-buffer and `boxCap`, and `boxCap` IS the household's committed
   *    demand over its stocking horizon (HOUSEHOLD × capDays × perCapitaDaily).
   *    So `held − boxCap` — the only surplus term available — is 0 for every
   *    household living its routine, however well fed. What banks is stock
   *    held ABOVE the routine.
   * ③ **Breadth counts SPARE stacks only.** A head is wealth when the
   *    household holds more than one unit of it that nobody has spoken for:
   *    `unreservedStock` takes out what its own open orders reserved,
   *    `spareStock(…, keep one)` takes out the G1/G2 keep-one floor. A chest
   *    full of blocks already claimed by the room it is raising is not
   *    breadth — it is the bill.
   *
   * The SHAPE is untouched: named 0..1-ish signals, summed and capped by
   * `PROSPERITY_DAILY_CAP`, spent at `PROSPERITY_THRESHOLD`. Only the feed
   * became honest.
   */
  function prosperitySignals(
    session: QuestSession,
    houseIndex: number,
  ): Array<{ key: string; value: number }> {
    const ctx = residentTownCtx(session, houseIndex);
    if (!ctx?.house || ctx.neighbor) return [];
    const house = ctx.house;
    // ── ① THE UNMET-DEMAND GATE ──────────────────────────────────────────
    for (const g of ctx.goods) {
      if (townShortage(session, g.good.key) > PROSPERITY_DEMAND_MET) return [];
      if (g.pantry(house, session.townClock) + 1e-9 < g.surplusUnits(house)) return [];
    }
    const signals: Array<{ key: string; value: number }> = [];
    // ── ② SURPLUS — holdings above the whole stocking horizon ────────────
    let spare = 0;
    let goodsN = 0;
    for (const g of ctx.goods) {
      const cap = Math.max(1, g.boxCap);
      const held = g.pantry(house, session.townClock) + storedGoodUnits(session, houseIndex, g.good.key);
      spare += Math.max(0, Math.min(1, (held - cap) / cap));
      goodsN++;
    }
    if (goodsN) signals.push({ key: "surplus", value: (spare / goodsN) * 0.8 });
    // ── ③ BREADTH — spare stacks, not stacks ─────────────────────────────
    let stacks = 0;
    for (const objId of houseContainerKeys(session, houseIndex)) {
      const stock = session.containerRecords.get(objId)?.stock;
      if (!stock) continue;
      const free = unreservedStock(stock, session.reservations, objId);
      stacks += Object.values(spareStock(free, HOUSEHOLD_KEEP_ONE)).filter((n) => n > 0).length;
    }
    signals.push({ key: "breadth", value: Math.min(1, stacks / 6) * 0.4 });
    return signals;
  }

  /** Units of a street good the household holds in its OWN containers (the
   *  pantry closed form is separate — this is what it has PUT AWAY, head-aware
   *  so `food.cooked` counts toward `food`). */
  function storedGoodUnits(session: QuestSession, houseIndex: number, good: string): number {
    const head = stackHead(good);
    let n = 0;
    for (const objId of houseContainerKeys(session, houseIndex)) {
      const stock = session.containerRecords.get(objId)?.stock;
      if (!stock) continue;
      for (const [g, q] of Object.entries(stock)) {
        if (q > 0 && stackHead(g) === head) n += q;
      }
    }
    return n;
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
    npcChatBubble(session, cid, line[session.meta.syntax]);
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

  /** ⚖️ #44 THE COMMUNITY SLOT — the houseless craft's `hi`. A founding-age
   *  town (or camp) has no household to key a job on, so the community
   *  ground's craft rides slot -1: same job map, same queue, same step —
   *  the row carries its own chosen hand (`CraftJob.crafter`) where a house
   *  job derives `resident_<hi>_0`. */
  const COMMUNITY_CRAFT_HI = -1;

  /** The community lot's WORLD disc, when one is chartered: the camp's own
   *  ground (kernel `communityGroundOf`), lifted out of the town-local frame
   *  by whichever centre this session has. */
  function communityLotWorld(
    session: QuestSession,
  ): { x: number; y: number; r: number } | null {
    const book = session.town?.deltas ?? session.foundedSite?.deltas;
    const c = session.town ? session.town.stage.center : session.foundedSite?.at;
    if (!book || !c) return null;
    const lot = communityGroundOf(book.zones());
    return lot ? { x: c.x + lot.x, y: c.y + lot.y, r: lot.r } : null;
  }

  /** A workbench standing on the camp's ground — the community twin of
   *  `houseBench`: the finished bench lands as a loose prop by the crate,
   *  and from that moment the pose (and the bench's labour speed-up)
   *  follow it. Spot-follows-bench, with the lot for a house. */
  function communityBench(session: QuestSession): { x: number; y: number } | null {
    const lot = communityLotWorld(session);
    if (!lot || !world) return null;
    for (const [objId, rec] of looseEntries(session)) {
      if (furnitureKindOfGlyph(rec.glyph ?? "") !== "workbench") continue;
      const o = world.state.objects[objId];
      if (!o) continue;
      if (Math.hypot(o.x - lot.x, o.y - lot.y) <= lot.r) return { x: o.x, y: o.y };
    }
    return null;
  }

  /** The bench a craft slot poses at — the house's own, or the camp's. */
  function craftBenchOf(session: QuestSession, hi: number): { x: number; y: number } | null {
    return hi >= 0 ? houseBench(session, hi) : communityBench(session);
  }

  /** ⚖️ #44 — the hand a COMMUNITY craft borrows: the nearest willing body
   *  to the camp's spot (the crew rule, applied to the bench — a founding
   *  has no households, so the job row carries its chosen hand).
   *  Deterministic: nearest, ties broken by cid. */
  function communityCrafterCid(
    session: QuestSession,
    at: { x: number; y: number },
  ): string | null {
    if (!world) return null;
    let best: { cid: string; d: number } | null = null;
    for (const cid of session.creatures?.nodeByCreature.keys() ?? []) {
      if (!willingHand(session, cid)) continue;
      const body = world.state.avatars[avatarIdOf(cid)];
      if (!body) continue;
      const d = Math.hypot(body.x - at.x, body.y - at.y);
      if (!best || d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && cid < best.cid)) {
        best = { cid, d };
      }
    }
    return best?.cid ?? null;
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
    // #44 COMMUNITY GROUND: the camp crafts at its own crate — the yard's
    // (or the founded site's) registered box standing ON the lot. No crate
    // yet (a stockless camp) resolves to no anchor, and `orderCraft`'s
    // dead-check refuses honestly.
    if (hi < 0) {
      if (session.containerRecords.has(SITE_STOCK_ID)) return SITE_STOCK_ID;
      return TOWN_YARD_EP;
    }
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
        if (!p.openable && session.containerRecords.get(p.id)?.stock === undefined) continue;
        // Economy-driven stacks are never a workbench's bin (the same
        // exclusion craftMaterialSources draws).
        if (isDerivedStoreObject(session, p.id)) continue;
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
      // The waiting line holds nothing BUT spoken orders (`orderCraft` is its
      // only writer), so a popped row keeps the rank it was queued with —
      // else the house's own rotation could displace it the moment it started.
      spoken: true,
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
    // 🚨 A PIECE LYING ON THE FLOOR IS INSTALLABLE (2026-08-11). The work list
    // calls it a `move` — `reconcileFurnishing` cannot tell a loose prop from a
    // standing chest, and for anything already INSIDE this house the two are
    // the same errand: walk to it, pick it up, stand it on its mark.
    // `handlePlaceOrder` has taken a loose prop as its source since the
    // watched-craft fix; only this sweep's filter kept it out.
    //
    // The consequence of the filter was the reported one: a workbench a family
    // had just made lay on its own kitchen floor forever. `install` needs a
    // unit STORED, and the arrival of a watched craft is a prop by definition —
    // so the only route left was `stepBlueprintReflow`, one carry per building
    // at a time, gated on a free pair of hands, competing with every other
    // re-flow in the house. The bench never rose, so the house stayed benchless,
    // so the bootstrap made another one.
    //
    // A `move` off a STANDING row still belongs to the re-flow sweep: that
    // carry has to lift a real placed row out of the building (`piecesInHand`)
    // and land it whole, which is machinery this path does not have.
    const tasks = buildingFurnishTasks(session, key);
    const task =
      tasks.find((q) => q.act === "install") ??
      tasks.find((q) => q.act === "move" && !!q.slot && !!q.from?.id.startsWith("small:"));
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
      // ONE BODY PER PIECE. The re-flow sweep reads the same work list and
      // would send its own free hand after the very same prop while this
      // errand is still walking — one of them would arrive to nothing. The
      // CLAIM is shared (`reflowCarriesOut`), so whichever sweep started the
      // carry owns that piece until the body stops walking. It used to be the
      // 12 s carry gate that was shared, which locked the whole HOUSE rather
      // than the one piece actually spoken for.
      if (task.act === "move" && task.from) {
        reflowCarriesOut(session, key).set(task.from.id, avatarIdOf(cid));
      }
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
   *  the same geometry the site walk uses; §2.2).
   *
   *  ⚖️ BOUND TO THE NEIGHBOURHOOD — WITH THE TOWN'S OWN STORE EXEMPT (§1's
   *  locality law, {@link civicRecruitRadiusM}, and its limit).
   *
   *  A kitchen craft used to enumerate EVERY stack in the town, so a bench in
   *  the old quarter would raid a stranger's cupboard 231 m across a city
   *  (measured 2026-08-11). Somebody else's box at that distance is not a
   *  source, and neither is a tree: those are the neighbourhood's business and
   *  the cap is what says so.
   *
   *  🚨 THE COMMUNAL STORE IS NOT SUBJECT TO IT, and the first cut of this cap
   *  proved why — MEASURED, not argued. The mill deposits its blocks in the
   *  storehouse (`commitRefineOrder` → `refineDepositId`), which sits at the
   *  town centre; capping every house's reach at the social radius severed the
   *  entire town from its own materials. Every craft in every house starved,
   *  each starved craft posted a refine order, the mill milled, the blocks
   *  landed out of reach, the order retired and the next sweep posted another:
   *  157 toasts in a four-minute run against 1 before (dx-doll-bench →
   *  fx-doll-bench, 2026-08-11). A storehouse a household cannot walk to is
   *  not a storehouse.
   *
   *  ⚠️ AND THE CAP WAS NEVER A RANKING FIX. `resolveMaterials` already draws
   *  nearest-first off `TransferSource.d`, so the long walk only ever happened
   *  when nothing nearer HELD the head — the cap can remove the last option, it
   *  can never improve the choice. Which is exactly what it must do for private
   *  property, and must not do for the town's own shelf. */
  function craftMaterialSources(
    session: QuestSession,
    hi: number,
    destAt: { x: number; y: number },
    excludeId: string,
  ): TransferSource[] {
    const member = `resident_${hi}_0`;
    const reach = civicRecruitRadius(session);
    const sources: TransferSource[] = [];
    for (const [boxId, boxRec] of stockedEntries(session)) {
      const stack = boxRec.stock!;
      if (boxId === excludeId) continue;
      if (isDerivedStoreObject(session, boxId) || boxId.startsWith("trade:")) continue;
      if (!mayUse(member, hi, boxRec.owner)) continue;
      const at = containerAnchor(session, boxId);
      if (!at) continue;
      const communal = isCivicStockDest(session, boxId);
      // Chord first — a street walk is never SHORTER than the straight line,
      // so a box already out of reach as the crow flies is dropped without
      // walking the graph for it (this runs over every stack in the town).
      if (!communal && Math.hypot(at.x - destAt.x, at.y - destAt.y) > reach) continue;
      const d = sourceDistanceM(session, destAt, at);
      if (!communal && d > reach) continue;
      sources.push({ id: boxId, stack, d });
    }
    return sources;
  }

  /** The labour clock this job WILL be stamped with when it starts. ONE
   *  definition: START stamps it, and the gather park uses it as its `staleAt`
   *  (§2.5.1: "`staleAt` = the job's own expected labour time, which is already
   *  computed"). */
  function craftLabourSecondsOf(session: QuestSession, hi: number, job: CraftJob): number {
    return (
      constructionGameDays(craftLaborDaysFor(job.at, !!craftBenchOf(session, hi)), session.scale) *
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
    // #44 — WHO WORKS IT: a house job's own member, or the community slot's
    // chosen hand (re-picked when that body is gone — the camp borrows
    // whoever is willing and near; it never wedges on a departed cid).
    let member = hi >= 0 ? `resident_${hi}_0` : (job.crafter ?? "");
    if (hi < 0 && (!member || !world.state.avatars[avatarIdOf(member)])) {
      const anchor = containerAnchor(session, job.spotId);
      member = (anchor ? communityCrafterCid(session, anchor) : null) ?? "";
      job.crafter = member || undefined;
      if (!member) return; // nobody willing stands anywhere — the job waits
    }
    const crafterBody = world.state.avatars[avatarIdOf(member)];
    const crafterWorkAt = craftBenchOf(session, hi) ?? containerAnchor(session, job.spotId);
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
      const npcId = avatarIdOf(member);
      if (session.transfers.executing(member)) return; // hauling first
      if (world.npcErrandActive(npcId) || (session.npcTasks.get(npcId)?.length ?? 0)) return;
      const standAt = nearestClearSpot(
        world.state,
        crafterWorkAt,
        { x: crafterBody.x, y: crafterBody.y },
        world.npcRadiusOf(npcId),
        standAvoid(member),
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
    const spot = ensureContainerStock(session, job.spotId);
    const consumes = job.consumes; // (`member` hoisted above — #44)
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
        // ⚖️ SPARE ONLY FOR AN AUTOMATED BENCH (surplus control S1). The
        // household's inventory rotation and its program crafts are the town's
        // OWN appetite at the smallest rung — ten families milling chairs is
        // exactly what emptied the yard under the spoken `make workbench`. A
        // job the player SPOKE draws the reserve; nothing else does.
        const { sources, withheld } = spareSources(
          session,
          craftMaterialSources(session, hi, anchor, job.spotId),
          missing,
          job.spoken === true,
        );
        const { draws } = resolveMaterials({
          holder: tmp,
          costs: missing,
          sources,
          ledger: session.reservations,
        });
        if (!draws.length && withheld) {
          // ⏸️ THE RESERVE IS WHY, and honest waiting is QUIET: the commons has
          // the wood on its shelf, this bench simply may not have it. Park on
          // the SAME two events (fresh stock, a released claim — both of which
          // grow the spare), but say nothing and chain nothing: a mill order
          // and a "there is none to fetch" would both be lies told over a full
          // yard.
          session.reservations.release(tmp);
          parkTown(session, craftGatherParkKey(hi), {
            scope: "job",
            why: `the commons keeps its reserve of ${Object.keys(missing).join(", ") || "the bill"}`,
            now: session.townClock,
            staleAfterS: craftLabourSecondsOf(session, hi, job),
          });
          return;
        }
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
          // ⚖️ THE HOUSEHOLD'S OWN BOOK (order-scoping law ①): this bill is
          // the FAMILY's, so the mill order it posts is the family's too —
          // sized to 4 blocks, milled at the family's bench, banked in the
          // family's box. It never reads the town's 198-block workshop bill
          // as its own work in progress, and never waits behind it.
          const { milling, rest } = ensureRefineOrders(
            session, missing, LOCAL_PLAYER_CID,
            // #44 — the community slot mills on the TOWN's book (the camp IS
            // the commons); a house job keeps its family ledger.
            hi >= 0 ? houseOrderScope(hi) : TOWN_ORDER_SCOPE,
            job.spoken === true,
          );
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
        // 🚨 THE OBSERVATION LAW, as the site piles already state it
        // (`obs ? postSiteHauls : twinStagePile`): a SHOWN house's materials
        // are carried by a body or they WAIT. The twin below is the
        // unobserved arm and nothing else — running it in a watched kitchen
        // teleported wood into the cupboard in front of the player, which is
        // the "builds itself" bug class in its craft costume. A watched house
        // with no free carrier this sweep simply gathers next sweep; the units
        // stay where they are and nothing is spoken for in the meantime.
        const twinMayRun = !isShown;
        let carried = false;
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
            carried = true;
          } else if (twinMayRun) {
            // THE ABSTRACT TWIN: the hidden house draws the same units from
            // the same stacks, instantly — conservation and coincidence.
            // ⚖️ "GET WOOD" MEANS "CUT A TREE" — the unobserved arm's own
            // means-end step, identical to the watched hauler's at the load.
            cutForDraw(session, d.endpoint, d.glyph);
            const src = session.containerRecords.get(d.endpoint)?.stock;
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
              depleteWildSource(session, d.endpoint); // a drained kill-source fells
            }
          }
        }
        // ⏸️ A WATCHED HOUSE WITH NO FREE PAIR OF HANDS PARKS (the same park,
        // its second cause). Without the twin this branch can now legitimately
        // move nothing — the carrier is already walking one load, or the family
        // are all out — and a resolve that moved nothing is a resolve worth
        // exactly as much as the world has changed. The wake set is unchanged
        // and it is the right one: the carrier's own unload bumps the stock
        // epoch at the seam, which is precisely the moment the next draw
        // becomes worth walking for.
        if (!carried && !twinMayRun) {
          parkTown(session, craftGatherParkKey(hi), {
            scope: "job",
            why: "the house is watched and no hand is free to carry",
            now: session.townClock,
            staleAfterS: craftLabourSecondsOf(session, hi, job),
          });
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
      const bench = craftBenchOf(session, hi);
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
      const raw = craftBenchOf(session, hi) ?? containerAnchor(session, job.spotId);
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
      // ── IT WAS MADE FOR SOMEBODY ELSE (CraftJob.for): SEND IT.
      //
      // A commissioned piece never becomes the maker's floor clutter. It stays
      // a stack unit at the spot and leaves as an ordinary civic haul — the
      // SAME agreement + pooled task `requestPiece` posts for a piece it found
      // already stored, so the shell's `inbound` test recognises it and never
      // designates a second. This is the leg that was missing: the shell asked,
      // the household made it, and nothing in the engine remembered the ask, so
      // the piece sat in a kitchen the shell's haul is forbidden to open
      // (`mayUse`) or on a floor no haul can see at all (2026-08-11).
      //
      // A commission whose building is GONE (demolished, cancelled) resolves to
      // no endpoint — the piece then falls through to the ordinary arrival
      // below and belongs to the house that made it. Nothing is ever owed to
      // nowhere.
      if (job.for && (spot[job.produces] ?? 0) > 0 && stockEndpointOf(session, job.for)) {
        const a = session.transfers.post({
          from: job.spotId,
          to: job.for,
          goods: { [job.produces]: 1 },
          issuer: LOCAL_PLAYER_CID,
          mode: "haul",
          now: session.taskClock,
          sourceGlyph: `bring ${job.label}`,
        });
        session.reservations.reserve(agrHolder(a.id), job.spotId, stackHead(job.produces), 1);
        const anchor = containerAnchor(session, job.spotId);
        postPooledTask(
          session,
          {
            kind: "transfer",
            agreementId: a.id,
            goods: a.goods,
            // §4.1 — the SHELL is where this is going, not the piece: the thing
            // being carried is already the sentence's object, and naming it
            // twice is "I will carry the door to the door".
            to: { kind: "named", id: shellHaulDestWord(session, job.for.slice(BFURN_EP.length)) },
          },
          LOCAL_PLAYER_CID,
          {
            x: anchor?.x ?? t.stage.center.x,
            y: anchor?.y ?? t.stage.center.y,
            radius: civicRecruitRadius(session),
          },
          `bring ${job.label}`,
          // ⚖️ ONE piece, and the commissioner has none (that is exactly why it
          // was ordered), so the shortage term is 1 — `requestPiece`'s own
          // arithmetic for the same errand.
          goodsValueS(1, 1, townFillS(session.scale), 1),
        );
        return;
      }
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
      const raw = craftBenchOf(session, hi) ?? containerAnchor(session, job.spotId);
      if (isShown && raw) {
        // ON the floor beside the bench, not INSIDE it. The bench/cupboard
        // coordinate is a fixture CENTRE, so spawning there buries the finished
        // thing in the furniture mesh — the same raw-centre trap the walk legs
        // had, in its cosmetic form. `nearestClearSpot` puts it on real floor.
        //
        // `dropFromStack` MOVES the unit out of the spot into a prop: if the prop
        // can't be made it stays stowed, and it can never be in both places.
        const body = world.state.avatars[avatarIdOf(member)];
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
    // ⚖️ #44 THE COMMUNITY SLOT, stepped beside the households: a houseless
    // camp's spoken craft runs at the crate on the community ground, observed
    // by the LOT's own patch (the order sites' observation law — never the
    // house-shown gate, which knows nothing about open ground). SPOKEN only:
    // the camp has no inventory rotation and no program — nothing ambient
    // ever claims this slot.
    {
      const lot = communityLotWorld(session);
      const cjob = craftJobsOf(session).get(COMMUNITY_CRAFT_HI);
      if (cjob || craftQueueOf(session).has(COMMUNITY_CRAFT_HI)) {
        const cShown = lot
          ? observedRect(session, {
              x: lot.x - lot.r, y: lot.y - lot.r, w: lot.r * 2, h: lot.r * 2,
            })
          : false;
        if (cjob) stepCraftJob(session, COMMUNITY_CRAFT_HI, cjob, cShown);
        else popQueuedCraft(session, COMMUNITY_CRAFT_HI);
      }
    }
    // CLUTTER drag zones over store/workshop rooms holding furniture stacks.
    const zones: Array<{ x: number; y: number; w: number; h: number; scale: number }> = [];
    for (const hi of session.houseShown) {
      const house = t.plan.houses.find((h) => h.index === hi);
      if (!house) continue;
      let stacks = 0;
      for (const objId of houseContainerKeys(session, hi)) {
        const stock = session.containerRecords.get(objId)?.stock;
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
    const seed = (fnv1a(`${session.meta.seed}|${Math.round(at.x)}|${Math.round(at.y)}`) % 100000) + 1;
    // THE ACCESS LANE (growth phase C §3.2): a homestead is a door and the
    // track that reaches it. The SESSION cannot know what circulation stands
    // out there — the wilderness has no roads and no memory of the last
    // site — so the host answers, and `foundSite` records the chord to the
    // nearest of it as a SPINE seed. Nothing near ⇒ no lane, and the town
    // this site grows into invents its stub exactly as before.
    const network = deps.siteNetworkAt?.({ x: at.x, y: at.y }) ?? [];
    const site = foundSite({
      seed, at, day,
      ...(network.length ? { network } : {}),
    });
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
    for (const [objId, rec] of [...looseEntries(session)]) {
      const obj = world.state.objects[objId];
      if (!obj || Math.hypot(obj.x - at.x, obj.y - at.y) > 8) continue;
      const stack: Record<string, number> = { [rec.glyph!]: 1 };
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
    registerContainer(session, SITE_STOCK_ID, "in", null, site.stock); // communal — the founders'
    // ⚖️ #44 INSTANT LOT DESIGNATION — founding IS the "houseless machinery
    // needs a sublocation" moment: the camp's ground partitions the same
    // instant (a community charter on the site's own deltas — persisted,
    // automatic, visible as marked ground), so the crate above stands ON a
    // lot and everything set down beside it stays in the founders' census.
    ensureCommunityGround(site.deltas, { x: 0, y: 0 }, session.handsCid);
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
    // ⚖️ #49 STAGE 2 — …AND SO DOES THE COUNTRYSIDE. The neighbouring stands
    // were minted at the MOUNT, long before anybody founded anything, so the
    // records are already accrued when this runs — and from this instant they
    // must ride the SITE's books, because those are the ones `siteTownConfig`
    // cuts the site's town from and `foundedSiteToJSON` saves. Adopting them
    // here is the same move the three lines above make, for the same reason:
    // the shelf and the stand it was drawn from may never serialize through
    // different doors.
    adoptAreaRecords(session, site.deltas.areaRecords);
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
    deleteContainerRecord(session, SITE_STOCK_ID);
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
    // ⚖️ #49 — the COUNTRYSIDE does not die with the site: the stands out
    // there were never the site's, and the session still holds them. Hand
    // them back to whatever store outlives this session now (the town's, or
    // nothing at all in a townless wilderness — in which case they were never
    // durable and honestly say so).
    if (session.town) adoptAreaRecords(session, session.town.deltas.areaRecords);
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
      // The CIVIC lots too (growth-phase-B stage-1 handoff 10): the hall and
      // the plaza market are ordinary frontage now and each covers a few of
      // its neighbours, which the footprint rects below cannot express — a
      // small structure would otherwise be offered a lot the plan spent.
      for (const s of plan.civicSlots ?? []) claimed.add(s);
      for (const b of session.town.deltas.founded()) claimed.add(b.slot);
      return {
        catalog: structureCatalogOf(session),
        deltas: session.town.deltas,
        stock: session.town.deltas.stock,
        center: session.town.stage.center,
        seed: session.town.config.seed,
        key: plan.key,
        seeds: plan.streets.seeds,
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
        seeds: [],
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
    opts?: {
      ignoreZones?: boolean;
      near?: { x: number; y: number };
      max?: number;
      /** The session whose street tree `near` should be measured on (§1.4).
       *  Absent = the chord, byte-identical to the legacy order. */
      session?: QuestSession;
    },
  ): FoundingCandidate[] {
    const useZones = !opts?.ignoreZones && ctx.zones.length > 0;
    // ⚖️ ONE GEOMETRY FOR SOURCE WALKS, applied to STEERING too: a `near`
    // point earned by counting street metres (the market deficit) must be
    // approached by counting them as well, or the last step of the decision
    // silently reverts to crow-flies. `sourceDistanceM` takes WORLD coords,
    // and `near` is town-local, so both sides go back through the ctx centre.
    const session = opts?.session;
    const steerDist = session && opts?.near
      ? (a: { x: number; y: number }, b: { x: number; y: number }): number => sourceDistanceM(
        session,
        { x: a.x + ctx.center.x, y: a.y + ctx.center.y },
        { x: b.x + ctx.center.x, y: b.y + ctx.center.y },
      )
      : undefined;
    const groundRects = groundObstacles(ctx.deltas);
    return foundingOptions({
      seed: ctx.seed,
      key: ctx.key,
      seeds: ctx.seeds,
      bearings: ctx.bearings,
      footprint: spec.footprint,
      type: spec.type,
      occupied: ctx.occupied,
      claimedSlots: ctx.claimedSlots,
      bound: ctx.bound,
      // The enumeration's tree must be the PLAN's tree (growth phase C §3.3):
      // both bend around the same annexed homesteads or the slot lattices
      // disagree and a founded building lands on ground the plan never laid.
      ...(groundRects.length ? { obstacles: groundRects } : {}),
      ...(opts?.near ? { near: opts.near } : {}),
      ...(steerDist ? { distM: steerDist } : {}),
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

  /**
   * The ABSTRACT CREW an unobserved site works with.
   *
   * ⚖️ IN TOWN IT IS THE TOWN'S POOL, AND IT IS FINITE (economy arc batch 2,
   * L4). What stood here was `if (session.town) return BUILDERS_CAP` — every
   * site told three builders unconditionally, so ten open sites banked thirty
   * builder-equivalents out of twelve residents. That is free lunch #1: a
   * town could out-build its own population by opening more sites, which is
   * the opposite of what a labour constraint means. The pool is now a
   * READING (`townHandPool`), and {@link allocateHands} splits it across the
   * sites that are actually working — see `crewShareOf` in the order loop.
   *
   * Off a town it is unchanged: the hands ambient recruitment would enlist —
   * registered residents/bonded creatures, WILLING volunteers (the pool's
   * compliance gate), and ambient resident bodies.
   */
  function availableCrew(session: QuestSession, issuer: string = LOCAL_PLAYER_CID): number {
    if (session.town) return townHandPool(session).free;
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

  /** Task-clock second a build-work site last had a hand CLAIMED to it (or
   *  first put its call out). A site that goes a whole claim window unanswered
   *  has no LOCAL labor and banks on the clock arm instead — §1's other half,
   *  in `workSite`. */
  const siteStaffedAt = new Map<string, number>();

  /**
   * 🚨 Task-clock second a CLAIMED build-work row last had its claimant AT the
   * work (seeded when the claim is first seen, so a body gets one whole window
   * to walk there). A claim is a PROMISE, not a builder: the pool never expires
   * a claimed row, and the pool sweep's errand-ran-out completion skips
   * `buildwork` on purpose — so without this stamp one claimant that wandered
   * off held its site "staffed" for the rest of the session while banking
   * nothing. Pruned as rows leave `claimed`; the site sweep also drops the
   * stamps of rows it retires.
   */
  const buildClaimSeenAt = new Map<string, number>();

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

  // ═══════ ⚖️ THE FELLING PREREQUISITE (user ruling, 2026-09-02) ═══════
  //
  //   "if a tree is in the way of a construction, making felling that tree a
  //    required task that is assigned automatically as a prerequisite."
  //
  // 🚨 A TREE IN THE WAY IS NOT A REFUSAL AND IT IS NOT A DELETION. The town
  // does not decline the order and it does not quietly unmake the wood; it
  // STAKES THE FELLING as required work, somebody does that work, and then the
  // walls go up. The staking model is `demolishRoom`'s, one rung out (*"Ordering
  // a demolition stakes the work, it never fells the room on the spot"*), and
  // the felling itself is NOT a new act: it is the ORDINARY material draw this
  // file already runs over standing trees (`siteMaterialSources` enumerates
  // them; `depleteWildSource` retires the drained source), triggered here by
  // FOOTPRINT OCCUPANCY instead of by material need. So the oak on the lot
  // pays for the house it was in the way of — one path, two reasons to walk it.
  //
  // ⚖️ AND IT TERMINATES, because of the ruling's other half (*"there is a
  // minimum growth level below which they are ignored"*): felling a
  // growth-bearing tree RE-SEEDS it at the identical spot — the S3 H2 law,
  // untouched here and everywhere — but a class-0 sapling is BELOW the
  // obstruction floor (`sourceBlocksBuilding`), so the lot reads free, the
  // build proceeds, and the suppression rule keeps that sapling a sapling for
  // as long as a building stands over it. No removal semantic, no exception to
  // the growth law, no stump special case.

  /** Clear ground a staked lot keeps around its walls before a standing
   *  source counts as in the way. The founding enumeration's OWN clearance,
   *  deliberately: "this lot is clear" must mean the same metres to the
   *  enumeration that refuses a lot for a building and to the sweep that
   *  stakes a felling for a tree. */
  const LOT_CLEAR_PAD = FOUNDING_CLEARANCE;

  /** Live footprint radius of a standing feature — measured against its LIVE
   *  stack (the host's copy), not its initial roll, so a half-quarried outcrop
   *  occupies what it actually occupies (`wildFeatureRadiusOf`' own law). */
  function wildFeatureFootprint(session: QuestSession, f: WildernessFeature): number {
    return wildFeatureRadiusOf(f, session.containerRecords.get(wildFeatureContainerId(f))?.stock);
  }

  /** Every standing wilderness feature a BUILD has to reckon with, as ground
   *  discs. ⚖️ THE THRESHOLD IS APPLIED HERE AND ONLY HERE — a seedling is not
   *  passed on to the geometry at all, because "below the floor is not there"
   *  is a fact about the FEATURE, never about the rectangle. */
  function standingBlockers(session: QuestSession): GroundFeature[] {
    const w = session.wilderness;
    if (!w?.features.length) return [];
    const out: GroundFeature[] = [];
    for (const f of w.features) {
      if (!sourceBlocksBuilding(f.species, f.sizeClass)) continue;
      out.push({ id: f.id, x: f.x, y: f.y, r: wildFeatureFootprint(session, f) });
    }
    return out;
  }

  /** The staked feature this id still names, or null — felled, folded away or
   *  grown-down below the floor, all three of which retire the stake. */
  function stakedFeature(session: QuestSession, id: string): WildernessFeature | null {
    return session.wilderness?.features.find((f) => f.id === id) ?? null;
  }

  /**
   * ⚖️ EVERY FOOTPRINT THIS SETTLEMENT OCCUPIES, world coords — standing
   * houses and works plus every founded row, RISING ONES INCLUDED (a staked
   * plot is spoken-for ground from the moment it is staked).
   *
   * Exported on the director because the GROWTH CLOCK is the other reader of
   * it (*"trees won't grow if a building is already there"*), and that clock
   * lives in the host. One derivation, two readers — never a second occupancy
   * notion that can disagree with the one the builder used.
   */
  function standingFootprints(session: QuestSession): Rect[] {
    const t = session.town;
    if (t) {
      const local: Rect[] = [
        ...t.plan.houses.map((h) => ({ x: h.dx, y: h.dy, w: h.w, h: h.h })),
        ...t.plan.works.map((w) => ({ x: w.dx, y: w.dy, w: w.w, h: w.h })),
      ];
      return settlementFootprints(t.stage.center, local, t.deltas);
    }
    const site = session.foundedSite;
    return site ? settlementFootprints(site.at, [], site.deltas) : [];
  }

  /** The wilderness standing on this lot RIGHT NOW (ids, deterministic order).
   *  Re-derived every sweep rather than pruned: an unfolded stand can lay a
   *  new tree down on ground somebody already staked, and the prerequisite has
   *  to know about it exactly as it knew about the first one. */
  function lotClearingNow(session: QuestSession, b: FoundedBuilding): string[] {
    const base = session.town ? session.town.stage.center : session.foundedSite?.at;
    if (!base || !session.wilderness) return [];
    const rect: Rect = { x: base.x + b.dx, y: base.y + b.dy, w: b.w, h: b.h };
    return featuresOnFootprint(rect, standingBlockers(session), LOT_CLEAR_PAD);
  }

  /** Where a felled lot's timber LANDS: the town's own shelf (the storehouse
   *  block bank, the yard, the site crate) — never the site pile.
   *
   *  🚨 ITEM CONSERVATION decides this, not convenience. A mature oak carries
   *  far more wood than the wall it was standing in the way of needs, and
   *  `completeFounding` DELETES the pile ("consumed — the materials are the
   *  building"), so surplus poured into a pile is surplus destroyed. On the
   *  shelf every unit survives, and it still feeds this bill — the site's own
   *  staging draws the shelf like any other source, and a stack on the lot's
   *  doorstep outranks everything further away. */
  function clearingDepositId(session: QuestSession): string | null {
    return (
      refineDepositId(session) ??
      (session.town ? TOWN_YARD_EP : session.foundedSite ? SITE_STOCK_ID : null)
    );
  }

  /** Everything still FREE on this source that clearing the lot will carry off
   *  it. Somebody else's reservation is somebody else's haul, and it empties
   *  the same tree — so it is never contested here.
   *
   *  ⚖️ WHAT THE CLEARING IS FOR IS THE SUBSTANCE, NEVER THE BEARING. There is
   *  no longer a method SWITCH here (it read `harvest` off a removable source
   *  and `kill` off a fellable one — the partition this round took out): the
   *  lot wants the thing that is IN THE WAY gone, and what is in the way is the
   *  trunk, the stone, the material the source is made of (`isBodyProduct`). A
   *  tree's hanging fruit is not what clearing the lot is about, and it rides
   *  down with the trunk anyway, where it stays takeable.
   *
   *  A source with no substance at all (a berry bush) yields nothing here and
   *  posts no haul — correctly, because the cut has already removed it whole. */
  function clearableUnits(
    session: QuestSession,
    f: WildernessFeature,
    endpoint: string,
  ): Record<string, number> {
    const stock = session.containerRecords.get(endpoint)?.stock;
    if (!stock) return {};
    const goods: Record<string, number> = {};
    for (const p of naturalSourceOf(f.species)?.products ?? []) {
      if (!isBodyProduct(p)) continue;
      const n = freeUnits(stock, session.reservations, endpoint, p.glyph);
      if (n > 0) goods[p.glyph] = n;
    }
    return goods;
  }

  /** When a clearing haul was first seen unanswered (agreement id → taskClock).
   *  Session-lived like every sweep timer beside it. */
  const clearHaulSeen = new Map<string, number>();

  /**
   * 🚨 A CLAIM IS NOT A CARRIER — the felling arm of the haul-liveness rule
   * the site bills already carry (`DEFAULT_TASK_TTL_S`, the "nobody came;
   * calling again" sweep). It is stated separately here because that sweep is
   * gated on PILE destinations and a felling delivers to the town's SHELF, so
   * it would never look at one — and a clearing haul that dies unanswered does
   * not merely slow a bill down, it blocks the lot FOREVER: the reservation it
   * left behind is the reason the next sweep finds no free units to speak for.
   *
   * Dead = one whole claim window with no load on anybody. The row fails
   * NAMED and both its claims go back on the shelf; nothing has moved, so
   * nothing can be double-drawn, and the caller re-posts.
   */
  function clearingHaulIsDead(session: QuestSession, a: TransferAgreement): boolean {
    if (haulIsLoaded(session, a)) {
      clearHaulSeen.delete(a.id);
      return false; // the goods are on a body — alive by definition
    }
    // ⚖️ PULL (task #51 item 1d) — AND A BODY THAT TOOK IT IS ALSO ALIVE. Under
    // the capability a row acquires an executor the moment a puller adopts it,
    // and the walk out to a staked tree is long: this stopwatch would fail the
    // agreement under a carrier who is still walking to the load, exactly the
    // way it may not. The abandon sweep (`sweepPullSlices`) is what reaps a
    // slice whose body let go, so the two do not overlap — the TTL keeps only
    // the case it was written for, a row NOBODY has taken.
    if (pullLaborOn(session) && a.executor) {
      clearHaulSeen.delete(a.id);
      return false;
    }
    const seen = clearHaulSeen.get(a.id);
    if (seen === undefined) {
      clearHaulSeen.set(a.id, session.taskClock);
      return false; // one whole window before anything judges it
    }
    if (session.taskClock - seen < DEFAULT_TASK_TTL_S) return false;
    session.transfers.fail(a.id, "no-executor");
    session.reservations.release(agrHolder(a.id));
    session.reservations.release(bagHolder(a.id));
    clearHaulSeen.delete(a.id);
    return true;
  }

  /**
   * COMMISSION THE CLEARING — one felling per staked tree, through the
   * material path this file already owns.
   *
   * 🚨 ONE OPEN ROW PER TREE (the `ensureRefineOrders` law, applied to
   * felling): while ANY haul is in flight off a source, the work is already
   * answered and nothing more is posted. Re-posting the remainder every sweep
   * is precisely the four-concurrent-refine-rows defect, and a tree is an even
   * easier place to make it — the stock only drains as the haul lands.
   */
  function commissionClearing(
    session: QuestSession,
    b: FoundedBuilding,
    ids: readonly string[],
    obs: boolean,
    issuer: string,
  ): void {
    const dest = clearingDepositId(session);
    const at = foundedLotAt(session, b);
    if (!dest || !at) return;
    const led = session.reservations;
    const destWord = dest === TOWN_YARD_EP || dest === SITE_STOCK_ID ? "yard" : "storehouse";
    const label = resolveStructure(structureCatalogOf(session), b.type)?.label ?? b.type;
    for (const id of ids) {
      const f = stakedFeature(session, id);
      if (!f) continue;
      const ep = wildFeatureContainerId(f);
      if (ep === dest) continue;
      const open = session.transfers
        .all()
        .find((a) => a.from === ep && (a.status === "pending" || a.status === "moving"));
      if (open && !clearingHaulIsDead(session, open)) {
        continue; // 🚨 one open row per tree — the work is already spoken for
      }
      // ═══ ⚖️ ONE ACT, THEN ONE HAUL (user ruling 2026-09-02) ═══
      //
      // This used to be TWO ARMS — a removal arm for blockers with no kill
      // product and a felling arm for the rest — which is exactly the partition
      // *"it's the same action for both"* denies. The lot's prerequisite is now
      // one sentence long: CUT WHAT IS IN THE WAY, then carry off whatever the
      // cut left lying there.
      //
      // The cut moves nothing (`cutWildFeature`'s ① — the trunk keeps its own
      // container), so the haul below is planned against the SAME endpoint on
      // the SAME sweep, and the wood is already reachable when it reads it. A
      // blocker with nothing to become is simply gone at this line and there is
      // no haul to post; a blocker that is already down is left alone and its
      // haul continues.
      //
      // 🚨 THE CUT IS WHAT MAKES THE STAKE TERMINATE, which is why a
      // harvest-only source may finally count as a blocker at all
      // (`sourceBlocksBuilding` widened to substantial-full-stop in the removal
      // round, and stays that way): every substantial thing on the lot now has
      // an act that ends it.
      // ⚖️ PULL (task #51 item 1d) — THE BOOKKEEPER DOES NOT TOUCH THE LAND.
      // *"Founding must NOT touch the land; clearing is a CONSEQUENCE"*
      // (feedback_arrival_is_not_an_event), and the user's own cut ruling says
      // the same thing one act smaller: marking a thing to come down is not
      // felling it. Under the capability the staked tree therefore STAYS
      // STANDING — the agreement below is its bill, `visibleBills` offers it as
      // a FELL link, and a body walks out and chops it. The agreement's units
      // read the same either way (`clearableUnits` counts the source's own body
      // products, standing or fallen), so nothing else in this function moves.
      //
      // 🚨 AND A BLOCKER WITH NOTHING TO CARRY GETS A MARK INSTEAD. A berry
      // bush in the walls' way yields no goods, so there is no agreement to be
      // its bill — and with the instant cut gone it would block the lot
      // forever. The felling DESIGNATION is exactly the bill for work that
      // moves nothing, so it is the one that is posted.
      const pull = pullLaborOn(session);
      if (!f.downed && sourceIsCuttable(f.species, f.sizeClass) && !pull) {
        cutWildFeature(session, ep);
        if (!stakedFeature(session, id)) continue; // removed outright — nothing to carry
      }
      const goods = clearableUnits(session, f, ep);
      if (!Object.keys(goods).length) {
        const book = session.town?.deltas ?? session.foundedSite?.deltas;
        if (pull && book && !f.downed && sourceIsCuttable(f.species, f.sizeClass)) {
          book.designateFell({
            featureId: f.id,
            at: { x: f.x, y: f.y },
            word: sourceKindWord(naturalSourceOf(f.species)?.kind) ?? "plants",
            issuer,
            spoken: false, // the builders' own prerequisite, not a player's ask
            postedDay: buildDayNow(session),
          });
        }
        continue;
      }
      if (!obs) {
        // THE ABSTRACT TWIN (`twinStagePile`'s arm, verbatim in shape): the
        // unwatched lot is cleared by the same ledger arithmetic the unwatched
        // haul uses — units off the tree, units onto the shelf, conservation
        // and coincidence. `depleteWildSource` then does what it does for every
        // other drained source: the last unit taken IS the felling.
        const dstEp = stockEndpointOf(session, dest);
        const src = session.containerRecords.get(ep)?.stock;
        if (!dstEp || !src) continue;
        let moved = false;
        for (const [g, n] of Object.entries(goods)) {
          const taken = takeStock(src, g, n);
          if (!Object.keys(taken).length) continue;
          putStock(dstEp, taken);
          moved = true;
        }
        if (moved) bumpStockEpoch(session);
        depleteWildSource(session, ep);
        continue;
      }
      const a = session.transfers.post({
        from: ep,
        to: dest,
        goods,
        issuer,
        mode: "haul",
        now: session.taskClock,
        sourceGlyph: `clear the ground for the ${label}`,
      });
      for (const [g, n] of Object.entries(goods)) led.reserve(agrHolder(a.id), ep, g, n);
      // ⚖️ PULL (task #51 item ①, seat ②) — NO ROW IS ISSUED FOR THE CLEARING.
      // The AGREEMENT stays: it is the bill for this tree (one open row per
      // tree, `clearingHaulIsDead` reaps it), and a contribute slice rides an
      // `agreementId` exactly as a pooled transfer row did — an agreement with
      // no pool row and no executor IS the shape a puller picks up. What goes
      // is the invisible foreman handing it to somebody. Off the capability
      // this is the standing call it always was.
      if (pullLaborOn(session)) continue;
      postPooledTask(
        session,
        { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: destWord } },
        issuer,
        { x: at.x, y: at.y, radius: civicRecruitRadius(session) },
        `clear the ground for the ${label}`,
        // A staked lot's clearing is wholly blocking — nothing on it can start
        // until it is done — so it is worth a full-urgency load of its goods.
        goodsValueS(stackTotalOf(goods), 1, townFillS(session.scale), 1),
        stackHead(Object.keys(goods)[0]!),
      );
    }
  }

  /** Units in a goods map (the pooled task's worth) — the map is already
   *  head-keyed here, so a plain sum is the honest count. */
  function stackTotalOf(goods: Readonly<Record<string, number>>): number {
    return Object.values(goods).reduce((s, n) => s + n, 0);
  }

  /**
   * ⚖️ THE MARK RETIRES WITH THE THING (task #51 item 1d) — one sweep, in the
   * bookkeeper, because a designation is a BOOK ROW and dead rows are the
   * books' to close.
   *
   * A mark dies three ways and all three are the same read: the thing came
   * down (the chop happened — the executor retires its own mark, this is the
   * belt), it was folded away or grown below the obstruction floor, or it was
   * never cuttable at all. Nothing here CUTS: a sweep that felled would be the
   * very deed this item removed.
   */
  function stepFellOrders(session: QuestSession): void {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas) return;
    const rows = deltas.fellOrders();
    if (!rows.length) return;
    for (const r of [...rows]) {
      const f = session.wilderness?.features.find((x) => x.id === r.featureId);
      if (!f || f.downed || !sourceIsCuttable(f.species, f.sizeClass)) deltas.cancelFell(r.featureId);
    }
  }

  /**
   * ⚖️ THE LOT'S OWN BILLS, READ BY A PULLER (task #51 item 1d — this is 1a's
   * REQUEST 2 closed).
   *
   * Under the capability `commissionClearing` posts a tree→shelf agreement
   * with NO pool row and NO executor and leaves the tree standing. That row is
   * a BILL and this is how a body finds it: one entry per staked blocker, in
   * the shape the reader's second row source takes (`FellRow`) — STANDING ⇒
   * the FELL link (walk out and chop it), already down ⇒ the HAUL link that
   * carries the timber to the shelf, riding the agreement that is already
   * holding those units.
   *
   * 🚨 THE ENUMERATION IS DELIBERATELY NARROW: only the endpoints THIS FILE
   * staked. A blanket "every executor-less agreement is a bill" would sweep up
   * the spoken-transfer seats (⑨⑩⑪) that the pool still owns by design, and
   * one body would hold two commitments.
   */
  function clearingBills(session: QuestSession): FellRow[] {
    if (!pullLaborOn(session)) return [];
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas) return [];
    const dest = clearingDepositId(session);
    const destWord = dest === TOWN_YARD_EP || dest === SITE_STOCK_ID ? "yard" : "storehouse";
    const out: FellRow[] = [];
    for (const o of deltas.orders()) {
      if (o.kind !== "found" || !o.clearing?.length) continue;
      for (const id of o.clearing) {
        const f = stakedFeature(session, id);
        if (!f) continue;
        const ep = wildFeatureContainerId(f);
        if (ep === dest) continue;
        const standing = !f.downed && sourceIsCuttable(f.species, f.sizeClass);
        // The row's own open agreement — pending and untaken is the only state
        // a puller may adopt (`begin` refuses the rest, which is the
        // de-confliction).
        const a = session.transfers
          .all()
          .find((r) => r.from === ep && r.status === "pending" && !r.executor);
        const goods = a?.goods ?? {};
        const head = stackHead(Object.keys(goods)[0] ?? "");
        const units = stackTotalOf(goods);
        if (!standing && !(a && units > 0)) continue; // down and already spoken for
        out.push({
          siteId: `${CLEAR_SITE_PREFIX}${f.id}`, // `clearSiteId`, spelled through its prefix
          objId: ep,
          at: { x: f.x, y: f.y },
          word: sourceKindWord(naturalSourceOf(f.species)?.kind) ?? "plants",
          standing,
          spoken: false, // the builders' prerequisite is civic, never "you asked"
          issuer: LOCAL_PLAYER_CID,
          ...(a && units > 0
            ? { haul: { agreementId: a.id, to: a.to, destWord, head, units } }
            : {}),
        });
      }
    }
    return out;
  }

  /**
   * WHAT TO CALL THE THING IN THE WAY, in a word the child's board can
   * actually SAY. Null = there is no such word, and the caller falls back to
   * the geometric "the place is small" rather than inventing one.
   *
   * 🚨 A SPECIES ID IS NOT A SPOKEN WORD (CLAUDE.md's silent-lexicon trap, and
   * this line walks straight into it if written the obvious way) — so WHICH
   * word a source gets is `host-lines.ts sourceKindWord`'s to say, not this
   * function's. The take refusal names the same standing things, and one owner
   * of the mapping is what keeps the two from calling an oak two things.
   */
  function blockerWordOf(session: QuestSession, b: FoundedBuilding): string | null {
    for (const id of b.clearing ?? []) {
      const f = stakedFeature(session, id);
      const word = f ? sourceKindWord(naturalSourceOf(f.species)?.kind) : null;
      if (word) return word;
    }
    return null;
  }

  /**
   * ONE SWEEP OF THE PREREQUISITE for one founded row. Returns TRUE while the
   * lot is still occupied — the caller holds staging closed on that answer.
   *
   * ⚖️ ONE VOICE PER STANDING CONDITION (`rateLimitedToast`, the 309-toasts
   * law): "there is still a tree on the plot" is a STANDING condition and it
   * speaks once a window, not once a tick.
   */
  function stepLotClearing(
    session: QuestSession,
    b: FoundedBuilding,
    obs: boolean,
    issuer: string,
  ): boolean {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas ?? null;
    const now = lotClearingNow(session, b);
    const was = b.clearing ?? [];
    if (now.length !== was.length || now.some((id, i) => id !== was[i])) {
      if (now.length) b.clearing = now;
      else delete b.clearing;
      // The ground under a staked plot changing is a first-class mutation —
      // the stage, the ghosts and the spot cache all read `version`.
      if (deltas) deltas.version++;
    }
    if (!now.length) return false;
    commissionClearing(session, b, now, obs, issuer);
    const label = resolveStructure(structureCatalogOf(session), b.type)?.label ?? b.type;
    rateLimitedToast(
      session,
      `clear:${b.ord}`,
      now.length > 1
        ? `🪓 clearing the ${label}'s ground — ${now.length} still standing on it`
        : `🪓 clearing the ${label}'s ground — one still standing on it`,
    );
    return true;
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

  /**
   * ⚖️ WHOSE SHELVES A SUBJECT MAY OPEN — the household `mayUse` measures a
   * reach against, for the cid actually ASKING (task #51 item ⑤).
   *
   * This line used to read `familyOf(session)?.house` inside
   * `siteMaterialSources` whatever cid was passed, so every reach in this file
   * was the PLAYER'S FAMILY'S reach wearing the issuer's name. Harmless while
   * the only subject was the player; wrong the moment a BODY reads a bill to
   * decide its own contribution — a resident of another house would have been
   * told it may open the player's boxes and not its own.
   *
   * 🚨 A SETTLER'S CID PARSES AS A HOUSE INDEX. `houseIndexOfCid` splits on
   * `_` and takes field 1, so `settler_3` answers house 3 — a real household's
   * chest, on a world where the settler has no household at all. The prefix
   * test is the gate, exactly as `idleForDirect`'s whitelist is.
   *
   * Everything that is neither a resident nor a settler — the local player,
   * a remote player cid, a civic sweep posting as LOCAL_PLAYER_CID — keeps the
   * answer this always gave, so no existing caller moves.
   */
  function viewerHouseOf(session: QuestSession, cid: string): number | null {
    if (cid.startsWith("resident_") || cid.startsWith("pet_")) {
      const hi = houseIndexOfCid(cid);
      return Number.isInteger(hi) ? hi : null;
    }
    if (/^settler_\d+$/.test(cid)) return null; // no household row anywhere
    return familyOf(session)?.house ?? null;
  }

  /** Candidate MATERIAL SOURCES for staging a site (pipeline ②): every
   *  usable container stack — the yard, the site crate, communal chests,
   *  wild features, our own boxes — ownership-gated exactly like a spoken
   *  transfer order. Distance-ranked to the work spot BY STREET
   *  (`sourceDistanceM`). Site piles are not containers, so a plot never raids
   *  another plot's heap — except for the SURPLUS arm under pull labor, below.
   *  Reach is the SUBJECT'S reach (`viewerHouseOf`): propriety is a question
   *  about whoever is asking, so the same yard can be another author's to draw
   *  from and not this one's. */
  function siteMaterialSources(
    session: QuestSession,
    destAt: { x: number; y: number },
    issuer: string = LOCAL_PLAYER_CID,
  ): TransferSource[] {
    const issuerHouse = viewerHouseOf(session, issuer);
    const sources: TransferSource[] = [];
    for (const [boxId, boxRec] of stockedEntries(session)) {
      if (isDerivedStoreObject(session, boxId) || boxId.startsWith("trade:")) continue;
      const owner = boxRec.owner;
      if (!mayUse(issuer, issuerHouse, owner)) continue;
      const at = containerAnchor(session, boxId);
      if (!at) continue;
      sources.push({ id: boxId, stack: boxRec.stock!, d: sourceDistanceM(session, destAt, at) });
    }
    // ⚖️ #44 — FOLDED REGION RECORDS JOIN THE SUPPLY (the ① ruling's law
    // revision: construction's starved paths fall through to region draws
    // instead of dead-ending at "there is none to fetch"). The COUNTING
    // stack is the boundary shelf PLUS the standing stock — a throwaway map,
    // read by `resolveMaterials`' arithmetic and never written: movement
    // stays endpoint-shaped (the endpoint's stack IS the shelf; the draw
    // arms below fell record→shelf before any unit moves). Folded-only by
    // construction: `unfoldWildArea` retires the record, so an expanded
    // stand's timber is enumerated as its REAL standing containers above.
    // Nature is nobody's — no ownership gate; distance ranks it like any
    // other source, so near stacks still win.
    // (`?.` — test harnesses build partial sessions; a fixture with no record
    // map simply has no regions, which is also the truthful reading.)
    for (const key of [...(session.areaRecords?.keys() ?? [])].sort()) {
      const rec = session.areaRecords.get(key)!;
      const id = wildAreaId(key);
      const stack: Record<string, number> = { ...(session.partnerStock?.[id] ?? {}) };
      for (const [g, n] of Object.entries(wildAreaStock(rec))) {
        if (n > 0) stack[g] = (stack[g] ?? 0) + n;
      }
      if (!Object.values(stack).some((n) => n > 0)) continue;
      const at = regionShelfPoint(session, rec);
      sources.push({ id, stack, d: sourceDistanceM(session, destAt, at) });
    }
    for (const s of donorPileSources(session, destAt)) sources.push(s);
    return sources;
  }

  /**
   * ⚖️ A DONOR PILE'S SURPLUS IS A SOURCE (task #51 item ④, pull labor only) —
   * and this is how lane ③ DISSOLVES.
   *
   * `releaseStarvedPile` exists because a heap that cannot finish its own bill
   * had no other way to let go: the director had to arbitrate, pick a
   * recipient it could make FEASIBLE, and push the whole gap across in one
   * shove. Under pull nobody pushes. A pile's surplus simply STANDS THERE like
   * any other stack, in the same distance-ranked list as the yard and the
   * wild, and the body that needs those units comes and takes what it can
   * carry. The arbitration, the ②b receive-hold and the one-release-at-a-time
   * invariant all become unnecessary rather than reimplemented.
   *
   * 🚨 SURPLUS, NEVER STOCK: `max(0, stock(head) − this row's own need(head))`,
   * where the need is the row's COSTS folded onto heads exactly as
   * `stagingMissing` folds them before it subtracts — the same derivation read
   * in the opposite direction, so the two can never disagree about a bill. The
   * units are offered by CONCRETE GLYPH in `takeStock`'s own order (plain head
   * first, then sorted variants), so what a source list promises is what a
   * draw would actually lift.
   *
   * ⚖️ PING-PONG IS STRUCTURALLY IMPOSSIBLE, which is the whole reason this
   * shape is allowed to be a plain source list. For ONE head a pile is either
   * short (`stagingMissing` positive ⇒ surplus 0) or spare (`stagingMissing`
   * zero ⇒ surplus = stock) — never both, because both numbers are the same
   * subtraction read in opposite directions. So no unit can be pulled toward a
   * pile that is simultaneously offering it, and the destination pile's own
   * entry contributes exactly 0 for every head it is asking about — which is
   * why this needs no "not me" test even though it does not know which pile it
   * is filling.
   *
   * A STAGED pile is not enumerated at all: `pileAccountOf` refuses one, and it
   * is right to — those raws are committed work with a mill running on them.
   */
  function donorPileSources(
    session: QuestSession,
    destAt: { x: number; y: number },
  ): TransferSource[] {
    if (!pullLaborOn(session)) return [];
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas) return [];
    const out: TransferSource[] = [];
    for (const o of deltas.orders()) {
      const acct = pileAccountOf(o);
      if (!acct) continue;
      const need = new Map<string, number>();
      for (const [g, n] of Object.entries(acct.costs)) {
        const head = stackHead(g);
        need.set(head, (need.get(head) ?? 0) + Math.max(0, n));
      }
      const stack: Record<string, number> = {};
      for (const head of new Set(Object.keys(acct.pile).map(stackHead))) {
        let spare = stackUnits(acct.pile, head) - (need.get(head) ?? 0);
        if (spare <= 0) continue;
        const keys = Object.keys(acct.pile)
          .filter((k) => stackHead(k) === head)
          .sort((a, b) => (a === head ? -1 : b === head ? 1 : a < b ? -1 : 1));
        for (const k of keys) {
          if (spare <= 0) break;
          const take = Math.min(spare, acct.pile[k] ?? 0);
          if (take <= 0) continue;
          stack[k] = take;
          spare -= take;
        }
      }
      if (!Object.keys(stack).length) continue;
      const id = orderPileId(acct.ord);
      const at = stockEndpointOf(session, id)?.at;
      if (!at) continue;
      out.push({ id, stack, d: sourceDistanceM(session, destAt, at) });
    }
    return out;
  }

  /**
   * ⚖️ HOW MUCH FREE `head` STOCK STANDS WITHIN THIS SITE'S REACH — a PURE,
   * NON-RESERVING read (task #51 item ①).
   *
   * 🚨 WHY IT EXISTS AT ALL: the only "can this bill be covered" question the
   * director could ask before was `resolveMaterials`, and that RESERVES every
   * draw it plans (reservations.ts) — which under push was fine, because the
   * poster handed each draw to a porter in the same breath. Under pull there
   * is no porter in that breath: a reservation made here would speak for units
   * no body is walking to, and the bill would deadlock behind its own claim.
   * So the bookkeeper ASKS and never TAKES; the draw and its reservation belong
   * to the body that decided to carry it.
   *
   * `viewer` is the subject whose reach is measured (`viewerHouseOf` through
   * `siteMaterialSources`), so a body and the bookkeeper reading on its behalf
   * get the same number — which is the point of exporting it: the puller sizes
   * its slice against exactly what this said was there.
   */
  function freeHeadStockWithinReach(
    session: QuestSession,
    destAt: { x: number; y: number },
    head: string,
    viewer: string = LOCAL_PLAYER_CID,
  ): number {
    let free = 0;
    for (const s of siteMaterialSources(session, destAt, viewer)) {
      free += freeUnits(s.stack, session.reservations, s.id, head);
    }
    return free;
  }

  /**
   * #44 — the shelf point the DIRECTOR measures with: the record's rect edge
   * toward the settlement's own gate, through the ONE geometry
   * (`wildRectPointToward`).
   *
   * ⚖️ #49 — THIS ONE IS THE **TRUE** ANSWER, DELIBERATELY UNCLAMPED. It is
   * read for RANKING only (`sourceDistanceM` into `TransferSource.d`) — nothing
   * walks here; movement resolves the endpoint's own `at` through the host's
   * `wildShelfPointOf`, which clamps the same geometry into the walkable
   * manifold. A minted neighbour tile (`wild:area:tile-<i>-<j>`) sits outside
   * the manifold at its TRUE offset, so clamping here would put ring 1 and
   * ring 2 in the same direction at the same distance and destroy the ordering
   * `sourcesByLeg`, `partnerLegSeconds` and this list all depend on. Two named
   * accessors, one derivation — see `wildRectPointToward`'s note.
   */
  function regionShelfPoint(
    session: QuestSession,
    rec: WildAreaRecord,
  ): { x: number; y: number } {
    return wildRectPointToward(rec, session.town?.stage.center ?? session.foundedSite?.at ?? null);
  }

  /** THE COMMONS, as a set of endpoint ids — the yard, the founded-site
   *  crate, the storehouse's own block bank. `isCivicStockDest`'s three
   *  answers, hoisted so a source walk asks once instead of per stack. */
  function civicStockIds(session: QuestSession): Set<string> {
    const out = new Set<string>([TOWN_YARD_EP, SITE_STOCK_ID]);
    const dep = refineDepositId(session);
    if (dep) out.add(dep);
    return out;
  }

  /**
   * ⚖️ SPARE ONLY — the source list an AUTOMATED draw may resolve against
   * (surplus control S1, user addendum 2026-08-12: automated bills/claims may
   * reserve materials only ABOVE a reserve floor; SPOKEN orders may draw the
   * reserve).
   *
   * The move is `unreservedStock`'s, one floor further down: hand the resolver
   * a COPY of each COMMONS stack with `commonsReserveOf` units taken out, and
   * it draws — and reserves — only what is genuinely surplus, through the same
   * `resolveMaterials` every other order uses. Nothing else changes: the
   * endpoint ids are the real ones, so the draws are real draws, and a
   * SPOKEN order gets the list untouched and may take the reserve down to zero.
   *
   * 🚨 THE FLOOR IS THE COMMONS', NOT EVERY STACK'S. A household's own box, a
   * neighbour's crate and a STANDING TREE are not the town's shelf — and none
   * of those three is an exception written here: the reserve rides exactly the
   * endpoints `civicStockIds` names, so anything that is not the commons is
   * simply not the thing being reserved. (S&D S4: the old note argued the wild
   * case specially — *"wild sources especially must stay uncapped or the
   * frontier stops harvesting"* — which was true and was never a rule. A
   * felled oak is production, not spending, because a natural source is not
   * the town's shelf; `scopeReceivesGoods` says so in the grammar and the
   * commons set says so here.)
   *
   * `withheld` says THE RESERVE IS WHY THERE IS NOTHING TO DRAW — free units
   * exist on the commons and the floor is holding them. Callers use it to stay
   * QUIET (honest waiting is quiet) instead of announcing "there is none to
   * fetch" over a shelf that visibly has some.
   */
  function spareSources(
    session: QuestSession,
    sources: readonly TransferSource[],
    want: Readonly<Record<string, number>>,
    spoken: boolean,
  ): { sources: TransferSource[]; withheld: boolean } {
    if (spoken) return { sources: [...sources], withheld: false };
    const dial = session.scale.resourceCompression;
    const heads = new Set<string>();
    for (const g of Object.keys(want)) {
      const head = stackHead(g);
      if (commonsReserveOf(head, dial) > 0) heads.add(head);
    }
    if (!heads.size) return { sources: [...sources], withheld: false };
    const civic = civicStockIds(session);
    let withheld = false;
    const out = sources.map((s) => {
      if (!civic.has(s.id)) return s;
      let stack: Record<string, number> | null = null;
      for (const head of heads) {
        if (freeUnits(s.stack, session.reservations, s.id, head) <= 0) continue;
        stack ??= { ...s.stack };
        takeStock(stack, head, commonsReserveOf(head, dial));
        withheld = true;
      }
      return stack ? { ...s, stack } : s;
    });
    return { sources: out, withheld };
  }

  /**
   * ⚖️ THE AUTOMATED-DRAW POLICY (S&D S4) — the parked question answered:
   * *what may a standing automated loop pull from private shelves, from the
   * commons, and from nature?* Three answers, one place, and none of them a
   * wilderness test:
   *
   *  • **NATURE — freely.** A natural source is unowned (`containerOwner` null
   *    — "nature is nobody's", quest-host `spawnWildFeature`), so the town's
   *    own reach already includes it. Felling an oak is PRODUCTION, not
   *    spending: nothing is drawn down that anybody was keeping.
   *  • **THE COMMONS — only its SPARE.** `spareSources` hands the resolver the
   *    civic stacks with `commonsReserveOf` taken out. And because the S3
   *    par≡reserve coupling makes that floor the very level this loop stocks
   *    TO, a par loop can never in practice pull from the commons: below par
   *    there is no spare, and at par there is nothing to want. The rule is
   *    stated anyway, because it is the rule — the arithmetic agreeing with it
   *    is the coupling working, not a coincidence to lean on.
   *  • **PRIVATE SHELVES — never.** This is the answer that changed. The loop
   *    resolved sources through the ISSUING BODY's reach, and the issuer is a
   *    townsman with a household, so a family's boxes were fair game for an
   *    ambient civic errand. A town's standing errand acts AS THE TOWN
   *    (`CIVIC_SCOPES`): the commons and the unowned, never a household's own.
   *    A SPOKEN order is untouched — you may still tell your own family to
   *    fetch its own wood, which is `mayUse` doing exactly its job.
   */
  function civicDrawSources(
    session: QuestSession,
    sources: readonly TransferSource[],
  ): TransferSource[] {
    return sources.filter(
      (s) =>
        // ⚖️ AN ORDER'S PILE IS NOT THE COMMONS (task #51 item ④). Under pull
        // labor `siteMaterialSources` also lists a gathering pile's SURPLUS,
        // because a BILL may draw what a sibling bill is not using — that is
        // the release lane, dissolved into the ordinary supply. The town's own
        // par loop is not a bill: "a plot never raids another plot's heap"
        // still holds for it, and a pile carries no `containerRecord`, so the
        // ownership filter below would wave it through as unowned.
        !s.id.startsWith(ORDER_PILE_EP) &&
        mayUseByScopes(CIVIC_SCOPES, session.containerRecords.get(s.id)?.owner),
    );
  }

  /**
   * ⚖️ WHAT THE TOWN HAS ON HAND — the stock a par is a level OF (S&D S4).
   *
   * The par loop used to count every reachable stack that was not a standing
   * tree, which made two halves of one declared coupling disagree: the reserve
   * floor rides `civicStockIds` (the yard, the site crate, the storehouse's
   * own bank) while the par it is pegged to was measured over private boxes as
   * well. A par is the level of a SHELF, and this town's shelves are its
   * commons: a chest of wood in a family's house is not the storehouse being
   * full, and standing timber is not stock at all — it is supply.
   */
  function townShelfSources(
    session: QuestSession,
    sources: readonly TransferSource[],
  ): TransferSource[] {
    const civic = civicStockIds(session);
    return sources.filter((s) => civic.has(s.id));
  }

  /** The costs no FREE stack can cover right now (head → units) — the
   *  build-order affordability check, over every haul-able source instead
   *  of the yard alone, minus what pending hauls have spoken for.
   *
   *  🚨 THROUGH THE ONE RESOLVER (`structureCosts` — phase 6). This read
   *  `spec.costs` raw, which since 02b61390 is the EXTRAS map alone: `{}` for
   *  every catalog row, so every structure priced as free and the board
   *  offered the whole catalog on an empty yard. `CostBearing` is what makes
   *  the two callers safe in one signature — a full row (with a `footprint`)
   *  is billed for its geometry, a bare `{ costs }` annex/partition literal is
   *  taken as given. */
  function buildMissingMaterials(
    session: QuestSession,
    spec: CostBearing,
    destAt: { x: number; y: number },
    issuer: string = LOCAL_PLAYER_CID,
  ): Record<string, number> {
    const sources = siteMaterialSources(session, destAt, issuer);
    const need = new Map<string, number>();
    for (const [g, n] of Object.entries(structureCosts(spec))) {
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

  /**
   * 🚫 THE PART OF A BILL NOTHING IN THE WORLD CAN COVER — the UNFULFILLABLE
   * test (user law ③, 2026-08-12: "unfulfillable orders must be refused
   * vocally if the player creates one, with the reason stated").
   *
   * ⚠️ SLOW IS NOT DEAD, AND THE DIFFERENCE IS THE WHOLE POINT. Pipeline ⑥'s
   * law stands for everything else: a bill the world can eventually cover is a
   * DESIGNATION that waits honestly, is named aloud ("we still need 272
   * block") and unsticks itself when a tree falls or a caravan lands. This
   * function answers the narrower question the refusal needs — is there, right
   * now, ANY reachable source holding the head, or holding a raw that refines
   * into it? Nothing else is a refusal.
   *
   * 🚨 TOTAL UNITS, NEVER FREE UNITS. A head every one of whose units is
   * spoken for by another order is CONTESTED, not absent — and contention is
   * exactly what the per-scope split says the two books are allowed to do to
   * each other. Refusing on `freeUnits` would make a spoken order fail because
   * an ambient one happened to reserve first, which is the shared queue
   * wearing a new hat.
   */
  function deadBillHeads(
    session: QuestSession,
    /** head → units still wanted (a `buildMissingMaterials` / recipe bill). */
    missing: Record<string, number>,
    /** What the ORDER's own author can reach for the head itself. */
    sources: TransferSource[],
    issuer: string = LOCAL_PLAYER_CID,
    /** The book the chain would post into — its mill spot decides which raws
     *  are reachable (per-scope order books). */
    scope: string = TOWN_ORDER_SCOPE,
  ): Record<string, number> {
    const holdsAny = (srcs: TransferSource[], head: string): boolean =>
      srcs.some((s) => stackUnits(s.stack, head) > 0);
    const dead: Record<string, number> = {};
    for (const [g, n] of Object.entries(missing)) {
      const head = stackHead(g);
      if (holdsAny(sources, head) || looseUnitsOf(session, head) > 0) continue;
      let chained = false;
      for (const p of rawsForRefined(head)) {
        const spot = refineSpotOf(session, p.refinesTo?.at, scope);
        if (!spot) continue;
        const raw = stackHead(p.glyph);
        if (
          holdsAny(siteMaterialSources(session, spot, issuer), raw) ||
          looseUnitsOf(session, raw) > 0
        ) {
          chained = true;
          break;
        }
      }
      if (!chained) dead[head] = n;
    }
    return dead;
  }

  /**
   * 🚫 ②a THE PART OF A BILL THE WHOLE REACHABLE WORLD CANNOT COVER
   * (homestead-defect-round). `deadBillHeads` answers the narrower question
   * "is there ANY source at all?" — the founding homestead exposed the state
   * between dead and slow: a 120-block house spoken over eight oaks is not
   * waiting for hauls, it is IMPOSSIBLE (total supply ≈ half the bill), and
   * the pipeline gathers, mills and shuttles forever with nothing ever
   * staging — the measured treadmill.
   *
   * Counted at TOTAL units, never free (contested is not absent —
   * `deadBillHeads`' own law), over the order's reach + the ground's loose
   * units + the mill chain measured at the mill's own spots and the mill's
   * own effective ratio (`effectiveInPerOut`), so this gate and the mill it
   * predicts can never disagree — and since the affordability board's
   * `withRefinableCredit` takes the same dial, neither can the BOARD. (It
   * could, once: the board divided by the raw catalogue ratio, so a
   * `resource_compression: 7.5` world showed a build hidden here and offered
   * there, off by exactly 2×.) Regrowth is deliberately NOT counted: the
   * refusal is about what stands NOW, it names both numbers, and a player
   * whose forest has since regrown simply orders again.
   */
  function infeasibleBillHeads(
    session: QuestSession,
    /** head → units of the WHOLE bill (never a residual — mixed
     *  denominators would double-count what free stock already covers). */
    bill: Record<string, number>,
    /** What the ORDER's own author can reach for the head itself. */
    sources: TransferSource[],
    issuer: string = LOCAL_PLAYER_CID,
    scope: string = TOWN_ORDER_SCOPE,
  ): Record<string, { need: number; have: number }> {
    const totalOf = (srcs: readonly TransferSource[], head: string): number =>
      srcs.reduce((s, src) => s + stackUnits(src.stack, head), 0);
    const out: Record<string, { need: number; have: number }> = {};
    for (const [g, n] of Object.entries(bill)) {
      const head = stackHead(g);
      let have = totalOf(sources, head) + looseUnitsOf(session, head);
      for (const p of rawsForRefined(head)) {
        const spot = refineSpotOf(session, p.refinesTo?.at, scope);
        if (!spot) continue;
        const raw = stackHead(p.glyph);
        const rawUnits =
          totalOf(siteMaterialSources(session, spot, issuer), raw) + looseUnitsOf(session, raw);
        const inPerOut = effectiveInPerOut(
          p.refinesTo?.inPerOut ?? 1,
          session.scale.resourceCompression,
        );
        have += Math.floor(rawUnits / Math.max(1, inPerOut));
      }
      if (have < n) out[head] = { need: n, have };
    }
    return out;
  }

  /**
   * 🪵 A LOOSE PROP IS STILL STOCK — units of a head lying ON THE GROUND
   * (`smallProps`), counted for the AVAILABILITY question only.
   *
   * The order-scoping round shipped the vocal refusal and immediately recorded
   * what it exposed: *"a loose `wood-1` prop is lying in view while the town
   * says it has none"* (handoff item 4). `siteMaterialSources` reads container
   * STACKS, and a prop on the floor is not a container — so the pipeline was
   * right and the SENTENCE was wrong, which is the worse of the two.
   *
   * This is the `looseFurnitureIn` move ("a stove taken apart to get past it
   * is still a stove, and it is still right here"), applied to materials: the
   * DEAD test — the one question whose answer is a refusal — counts what is
   * lying about, so a world with wood in view is SLOW, never DEAD. It waits
   * honestly, and the tidy chore that sweeps props into boxes is the path by
   * which the wood becomes drawable stock.
   *
   * 🚫 DELIBERATELY NOT A HAUL SOURCE, and that is the recorded remainder. A
   * prop has no stack to draw from: making one resolve as a `StockEndpoint`
   * means a prop→endpoint bridge whose take DELETES the world object, or the
   * unit exists twice (the item-conservation law). That is the supply/demand
   * round's, together with the rest of the wilderness-as-source-renderer
   * unification — see the landing notes.
   */
  function looseUnitsOf(session: QuestSession, glyph: string): number {
    // A prop is a WORLD OBJECT: no world (a pure-arithmetic host, a fixture)
    // means no floor for anything to be lying on, and the answer is zero.
    const objects = world?.state.objects;
    if (!objects) return 0; // no world (a pure-arithmetic host): nothing lying on a floor
    const head = stackHead(glyph);
    let n = 0;
    for (const [objId, rec] of looseEntries(session)) {
      if (stackHead(rec.glyph!) !== head) continue;
      const o = objects[objId];
      if (!o || o.carriedBy || o.containedIn) continue; // in hand / already put away
      n++;
    }
    return n;
  }

  /** The bill as the refusal says it — the "we still need 272 block" shape,
   *  which is the copy this vocabulary already ships. */
  const billNames = (bill: Record<string, number>): string =>
    Object.entries(bill).map(([g, n]) => `${n} ${g}`).join(", ");

  /** WHO SAYS THE TOWN'S NO.
   *
   *  The refusal's line is `noSourceLine` — deliberately the COLLECTIVE voice
   *  ("we don't have any wood"), a claim about the whole settlement's stock
   *  rather than one pair of pockets — so ANY standing mouth may carry it, and
   *  the only question is which one the player can see move. In order: the
   *  builder the order named; the focused household's head (the body a
   *  dollhouse player is looking at, and the one `stepCraftJob` already speaks
   *  this same line through); else the nearest LOADED body, which is what a
   *  founding camp of settlers has instead of a household.
   *
   *  Null only when nothing here has a mouth at all. The toast still runs: the
   *  HUD channel and the voice are two channels, never substitutes for one
   *  another (silence must be explicit). */
  function refusalVoiceOf(session: QuestSession, named: string | null): string | null {
    if (named) return named;
    const reg = session.creatures?.nodeByCreature;
    if (!reg) return null;
    const hi = familyOf(session)?.house;
    if (hi !== undefined && hi !== null && reg.has(`resident_${hi}_0`)) return `resident_${hi}_0`;
    const from = playerWorldPos(session) ?? session.town?.stage.center ?? null;
    let best: { cid: string; d: number } | null = null;
    for (const cid of reg.keys()) {
      if (isPlayerCid(cid)) continue;
      const body = world?.state.avatars[avatarIdOf(cid)];
      if (!body) continue;
      const d = from ? Math.hypot(body.x - from.x, body.y - from.y) : 0;
      // Deterministic across peers: distance, then the lexicographic id.
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && cid < best.cid)) {
        best = { cid, d };
      }
    }
    return best?.cid ?? null;
  }

  /** A pending annex's pile endpoint id (pipeline ⑤). */
  function annexPileId(ord: number): string {
    return `${ANNEX_PILE_EP}${ord}`;
  }

  /** How far a CIVIC task recruits — {@link civicRecruitRadiusM}, bound to
   *  the SITE'S OWN NEIGHBOURHOOD (§1's locality law). ONE definition; this
   *  is only the session-shaped call. */
  function civicRecruitRadius(session: QuestSession): number {
    return civicRecruitRadiusM(session.scale, !!session.town);
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

  /** ⚖️ ④ ONE VOICE PER STANDING CONDITION (homestead-defect-round). A
   *  starved or milling order re-announces itself from every sweep gate —
   *  measured 309 toasts in 1030 s on the founding homestead, three per
   *  cycle, most of them the same fact with a drifting number. A STANDING
   *  condition speaks once per window per key; the numbers it speaks are
   *  whatever is true when the window opens. Keyed per order+phase and
   *  session-lived like the sweep timers beside it — a reload forgets the
   *  window and the worst that costs is one repeated line. */
  const ORDER_TOAST_REPEAT_S = 90;
  const orderToastAt = new Map<string, number>();
  function rateLimitedToast(session: QuestSession, key: string, text: string): void {
    const last = orderToastAt.get(key);
    if (last !== undefined && session.taskClock < last + ORDER_TOAST_REPEAT_S) return;
    orderToastAt.set(key, session.taskClock);
    presenter.toast(text, "feedback");
  }

  // ⚖️ `pileShortfall` — what a pile still needs BEYOND its stacks and its
  // live in-flight hauls — now lives in kernel/town/construction.ts beside
  // `stagingMissing` (task #51: a self-issuing BODY must be able to ask the
  // same question). The closure copy that stood here was deleted; the calls
  // below pass `session.transfers.all()` where they used to pass `session`.

  // ── ⚖️ ① PREEMPT-TO-FEASIBILITY — THE RELEASE PATH FOR A STARVED PILE ────
  //
  // 🚨 WHAT THIS FIXES: a HOLD-AND-WAIT RESOURCE DEADLOCK
  // (frontier-conservation-diagnosis.md, RECURRENCE CHECK (d)). Two refine
  // rows milling at the same yard spot asked for ≈132 and ≈105 wood in a world
  // that contains 144. Every unit that landed was spoken for at the instant it
  // landed (`onTransferLanded` — *"spoken for from the instant it exists
  // there"*), `commitRefineOrder` returns early while `stagingMissing` is
  // non-empty, and NOTHING anywhere gave a pile a reason to let go: no
  // timeout, no preemption, no yield. Conservation was EXACT — wood 144 at
  // t=0 and 144 at the end, nothing destroyed — and both heaps simply froze.
  // The house site sat at `0% worked` for 1 237 sim-s while the 20 s gate
  // re-announced the same mill 62 times. THE PERMANENCE, not the shortage, is
  // the defect: a slow town is honest, a frozen one is a bug.
  //
  // THE RULE, and only this rule. An order whose shortfall CANNOT BE FETCHED
  // — the "and there is none to fetch" condition the two callers below have
  // already computed, which is the only place this runs — yields raws to a
  // sibling IF AND ONLY IF THAT MAKES THE SIBLING FEASIBLE: the recipient's
  // WHOLE remaining shortfall, every head of it, covered out of what this
  // donor is holding. A release that would merely move a shortage around is
  // refused, and the donor KEEPS HOLDING — which is the correct behaviour,
  // because "none to fetch" is a statement about today: the wild regrows, the
  // condition clears on its own and ordinary filling resumes. Only the
  // pointless shuffle is forbidden.
  //
  // 🚨 NO OSCILLATION, AND FEASIBILITY IS THE WHOLE ARGUMENT. Released goods
  // cannot ping-pong because a recipient made feasible STAGES on the very next
  // sweep — `stagingMissing` is empty, so the ladder moves it to labor — and a
  // staged row is not in the arbitration pool at all (`pileAccountOf` returns
  // null for it: its raws are committed work with a mill running on them, not
  // a hoard). Goods therefore leave the pool the moment they move. Between the
  // release and that staging the recipient cannot donate either: its shortfall
  // is zero, so the starved arm this lives in never runs for it. A release is
  // a one-way door by construction.
  //
  // ⚖️ AND THE RECIPIENT IS THE ONE NEAREST FINISHING (progress descending,
  // then lowest ord — deterministic, so the same standoff resolves the same
  // way every run). NOT a direction constraint: a donor may perfectly well be
  // further along than the sibling it feeds, and MUST be able to be. The
  // measured arc is exactly that case — a 132-wood row sat on 114 in a world
  // whose remaining wood could never reach 132, while two 34- and 50-wood rows
  // starved beside it. Forbidding the "downhill" release would have re-frozen
  // that wood under a new name; what makes it safe is not the direction, it is
  // that the goods land in a mill that immediately starts running.
  //
  // ⚖️ NOT A TELEPORT, AND NOT A NEW LIFECYCLE. An OBSERVED release posts a
  // real pile→pile haul a real body walks — the same agreement, the same
  // `agrHolder` reservation, the same pooled task, the same landing law as
  // every other haul (`pileShortfall` counts it against the recipient's bill
  // the moment it is posted, so nothing is promised twice). An UNOBSERVED one
  // moves the units as ledger arithmetic, exactly as `twinStagePile` already
  // draws its own raws. No pile is ever made a resolvable SOURCE, so the
  // engine's "a source yields but never receives" law (`scopeReceivesGoods`)
  // is untouched: this is one named order handing another named order its own
  // bill, not a shelf anybody may raid.

  /** A gathering order's PILE ACCOUNT — the two maps a release arbitrates
   *  over. Null for a row with nothing to arbitrate: a demolition (no pile at
   *  all), a costless legacy row, or one already STAGED — a staged pile's
   *  raws are committed work with a mill running on them, not a hoard. */
  type PileAccount = { ord: number; costs: Record<string, number>; pile: Record<string, number> };
  /** `forWrite` MATERIALIZES a missing `pile` map; the default READ path must
   *  not, because a probe that mutates the rows it measures is a probe that
   *  changes the run (a found row with no pile serializes differently once one
   *  is hung on it). Arbitration reads; only the credit below writes. */
  function pileAccountOf(o: ConstructionOrder, forWrite = false): PileAccount | null {
    if (o.kind === "demolish") return null;
    if (o.laborStartDay !== undefined) return null;
    if (o.kind === "found" && o.completed) return null;
    const costs = o.costs;
    if (!costs || !Object.keys(costs).length) return null;
    const row = o as { pile?: Record<string, number> };
    if (forWrite) row.pile ??= {};
    return { ord: o.ord, costs, pile: row.pile ?? {} };
  }

  /** How far along a pile is, in UNITS of its own bill (0..1) — the ranking
   *  key of the release: goods flow toward the order nearest finishing. */
  function pileProgress(acct: PileAccount): number {
    let total = 0;
    let filled = 0;
    for (const [g, n] of Object.entries(acct.costs)) {
      const want = Math.max(0, n);
      total += want;
      filled += Math.min(want, stackUnits(acct.pile, stackHead(g)));
    }
    return total > 0 ? filled / total : 1;
  }

  /** Is `a` a BETTER recipient than `b`? Progress descending, then ord
   *  ascending — a strict total order, so the pick is deterministic and the
   *  same standoff resolves the same way in every run. */
  function nearerDone(a: { p: number; ord: number }, b: { p: number; ord: number }): boolean {
    const EPS = 1e-9;
    return a.p > b.p + EPS || (Math.abs(a.p - b.p) <= EPS && a.ord < b.ord);
  }

  /** ⚖️ ②b THE RECEIVE-HOLD (homestead-defect-round). ord → taskClock time
   *  before which that order's pile may not DONATE. Session-lived like the
   *  sweep timers (`pileRetryAt`) — a reload forgets the hold and the worst
   *  a forgotten hold costs is one extra release. */
  const releaseReceivedAt = new Map<number, number>();
  /** Two piles this close are columns of the SAME heap — a "release" between
   *  them is bookkeeping, never a trip a porter should walk or a toast a
   *  player should hear. Measured disease: every order's pile at the one
   *  yard spot, bodies circling the crate moving wood from it to it. */
  const CO_LOCATED_PILE_M = 4;

  /** ⚖️ #50 ④ — DID A PLAYER ASK FOR THIS ROW? The `spoken` key every costed
   *  order already carries (surplus control S1: "a player spoke the order this
   *  pile feeds"), read for ANY order kind — a refine chained for a spoken
   *  bill inherits it, and so does the annex/interior row. `orderIsSpoken`
   *  beside `crewShareOf` asks the same question of `found` rows only, because
   *  that is all the hand allocator ranks; this is the general reader. */
  const rowIsSpoken = (o: ConstructionOrder | undefined): boolean =>
    !!o && (o as { spoken?: boolean }).spoken === true;

  /**
   * The starved pile `donorPileId` yields to the sibling it can FINISH, if
   * there is one. Returns true when a release was made.
   *
   * `mode` follows the caller's own observation split: `"haul"` from the
   * watched arm (a body walks it), `"ledger"` from the twin.
   */
  function releaseStarvedPile(
    session: QuestSession,
    donorPileId: string,
    issuer: string,
    mode: "haul" | "ledger",
  ): boolean {
    const deltas = session.town?.deltas ?? session.foundedSite?.deltas;
    if (!deltas || !donorPileId.startsWith(ORDER_PILE_EP)) return false;
    const donorOrd = Number(donorPileId.slice(ORDER_PILE_EP.length));
    if (!Number.isInteger(donorOrd)) return false;
    // ⚖️ A PILE THAT JUST RECEIVED MAY NOT DONATE (②b). Under world-total
    // scarcity no sibling can ever finish, and the "nearest done" ranking has
    // no fixed point — the measured homestead ping-ponged its last 86 wood
    // between two starving rows on every 20 s gate, forever. The half-day
    // hold breaks the cycle mechanically: whatever a release lands stays put
    // long enough for the recipient's own mill or stage to act on it.
    const heldUntil = releaseReceivedAt.get(donorOrd);
    if (heldUntil !== undefined && session.taskClock < heldUntil) return false;
    const rows = deltas.orders();
    const donorRow = rows.find((o) => o.ord === donorOrd);
    const donor = donorRow ? pileAccountOf(donorRow) : null;
    if (!donor) return false;
    // ONE RELEASE AT A TIME. A donation already walking is already counted
    // against the recipient's bill (`pileShortfall` subtracts in-flight
    // goods), so a second posted on the next 20 s gate would promise the same
    // heap twice and strand the difference.
    for (const a of session.transfers.all()) {
      if ((a.status === "pending" || a.status === "moving") && a.from === donorPileId) return false;
    }
    let best: { acct: PileAccount; row: ConstructionOrder; gap: Record<string, number>; p: number } | null = null;
    for (const o of rows) {
      if (o.ord === donorOrd) continue;
      const acct = pileAccountOf(o);
      if (!acct) continue;
      const gap = pileShortfall(session.transfers.all(), {
        pileId: orderPileId(acct.ord),
        ...(o.kind === "found" ? { legacyPileId: sitePileId(acct.ord) } : {}),
        missing: stagingMissing(acct),
      });
      if (!Object.keys(gap).length) continue; // already fed — nothing to make feasible
      // FEASIBILITY, THE WHOLE OF IT: every head this sibling still misses,
      // covered out of this donor's own heap. A release that leaves the
      // recipient short has moved a shortage, not ended one.
      if (!Object.entries(gap).every(([head, n]) => stackUnits(donor.pile, head) >= n)) continue;
      const p = pileProgress(acct);
      if (!best || nearerDone({ p, ord: acct.ord }, { p: best.p, ord: best.acct.ord })) {
        best = { acct, row: o, gap, p };
      }
    }
    if (!best) return false;
    const toPileId = orderPileId(best.acct.ord);
    const at = stockEndpointOf(session, toPileId)?.at;
    if (!at) return false;
    // ⚖️ CO-LOCATED PILES MOVE AS ARITHMETIC (②b). When the donor and the
    // recipient stand on the same spot (the homestead: every book's pile at
    // the one yard), the units change column, not place — no agreement, no
    // porter, no toast. Forcing the ledger arm here is exactly the twin's own
    // treatment of an unobserved move, applied to a move nothing could ever
    // observe because it goes nowhere.
    const donorAt = stockEndpointOf(session, donorPileId)?.at;
    const coLocated =
      !!donorAt && Math.hypot(at.x - donorAt.x, at.y - donorAt.y) <= CO_LOCATED_PILE_M;
    // ⚖️ PULL (task #51 item ④) — THE WALKED RELEASE IS RETIRED, and the lane
    // with it. Under the capability a donor pile's SURPLUS stands in the
    // ordinary supply walk (`donorPileSources`), so the units reach the bill
    // that needs them by somebody deciding to carry them — no arbitration, no
    // recipient chosen for them, no shove. What survives here is the arm that
    // was never labour: a CO-LOCATED move (and the unobserved `"ledger"` twin),
    // where the units change column and nothing walks at all. Refusing BEFORE
    // the receive-hold is set matters: a hold stamped on a recipient that got
    // nothing would gag it for half a day.
    if (pullLaborOn(session) && mode === "haul" && !coLocated) return false;
    // The recipient may not hand this heap onward until it has had a real
    // chance to act on it (half a day — the mill's own batch cadence).
    releaseReceivedAt.set(best.acct.ord, session.taskClock + 0.5 * session.scale.dayLengthS);
    const bill = Object.entries(best.gap)
      .map(([g, n]) => `${n} ${g}`)
      .join(", ");
    const word = pileHaulDestWord(session, best.row);
    if (mode === "ledger" || coLocated) {
      // NOW the recipient's map is written to, so now it is materialized.
      const dst = pileAccountOf(best.row, true)?.pile;
      if (!dst) return false;
      for (const [head, n] of Object.entries(best.gap)) {
        const taken = takeStock(donor.pile, head, n);
        for (const [g, c] of Object.entries(taken)) {
          dst[g] = (dst[g] ?? 0) + c;
        }
      }
      // ⏸️ A PILE GAINED UNITS — the same wake the watched unload bumps, for
      // the same reason (twin parity).
      bumpStockEpoch(session);
    } else {
      const a = session.transfers.post({
        from: donorPileId,
        to: toPileId,
        goods: { ...best.gap },
        issuer,
        mode: "haul",
        now: session.taskClock,
        sourceGlyph: `bring ${bill}`,
      });
      for (const [head, n] of Object.entries(best.gap)) {
        session.reservations.reserve(agrHolder(a.id), donorPileId, head, n);
      }
      postPooledTask(
        session,
        { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: word } },
        issuer,
        { x: at.x, y: at.y, radius: civicRecruitRadius(session) },
        `bring ${bill}`,
        goodsValueS(
          Object.values(a.goods).reduce((s, n) => s + n, 0),
          1,
          townFillS(session.scale),
          1,
        ),
        // ⚖️ #45 — a release is the town rebalancing its own piles; no one
        // asked, so the why-chain answers with the need.
        stackHead(Object.keys(best.gap)[0] ?? "block"),
      );
    }
    // A co-located move is silent by design (see CO_LOCATED_PILE_M): nothing
    // happened in the world a player can see, so nothing is announced.
    if (!coLocated) {
      rateLimitedToast(
        session,
        `release:${donorOrd}`,
        `🔁 ${bill} goes to the ${word} — the other order cannot finish today`,
      );
    }
    return true;
  }

  /**
   * ⚖️ A HAUL'S DESTINATION IS A PLACE, NEVER THE CARGO — `shellHaulDestWord`'s
   * law (§4.1), one pipeline over and for the same user report.
   *
   * The `to` PlaceRef on a pooled TRANSFER goal is WORDING and nothing else
   * (the haul runs off the agreement's endpoint); `goalIntentLine` phrases it
   * as `carry <goods> to <place>`. The REFINE arm passed `stackHead(r.produces)`
   * — a COMMODITY, literally `"block"` — so a porter walking wood to the mill
   * announced *"I will carry the wood to the block"*, which is the line the
   * user reported (diagnosis RECURRENCE CHECK (b)). It was the last caller in
   * the file still naming a destination with a product head; every other arm
   * already passes a structure glyph, a `ROOM_GLYPH` or `shellHaulDestWord`.
   *
   * ONE definition for all four order kinds, so the staging poster and the
   * reload re-pool can never drift apart on it.
   */
  function pileHaulDestWord(session: QuestSession, o: ConstructionOrder | undefined): string {
    if (!o) return "room";
    if (o.kind === "found") {
      return resolveStructure(structureCatalogOf(session), o.type)?.glyph ?? "yard";
    }
    if (o.kind === "refine") return refineMillWord(session, o);
    if (o.kind === "annex" || o.kind === "interior") {
      return ROOM_GLYPH[pendingRoomKindOf(o) as HouseRoom["kind"]] ?? "room";
    }
    return "room";
  }

  /** WHERE THE MILLING HAPPENS, as a word — `refineSpotOf`'s own three answers
   *  read back as place words: a household's own bench (the HOUSE), the town's
   *  standing station for that raw (its catalogue TYPE, a lexeme in every
   *  locale — `shellHaulDestWord`'s argument), else the YARD crate, which is
   *  literally where the benchless fallback puts the heap and what
   *  `postSiteHauls` already calls it. */
  function refineMillWord(session: QuestSession, r: RefineOrder): string {
    if (houseOfOrderScope(r.scope) !== null) return "house";
    const raws = rawsForRefined(stackHead(r.produces));
    const rawGlyph = Object.keys(r.costs ?? {})[0];
    const p = raws.find((q) => q.glyph === rawGlyph) ?? raws[0];
    const workType = p?.refinesTo?.at ?? REFINE_WORK_DEFAULT;
    return refineStationSpot(session, workType) ? workType : "yard";
  }

  /**
   * 🚨 WHERE AND WHEN a live pile haul's carrier was last SEEN MOVING (the haul
   * twin of `buildClaimSeenAt`): the sweep re-stamps it for as long as the body
   * is really walking the trip, and a row that goes a whole CLAIM WINDOW
   * without moving is retired — see the "a claim is not a carrier" note in the
   * staging sweep. Session-lived and pruned as rows leave `pending`/`moving`,
   * exactly like the bag claims.
   */
  const haulSeenWalking = new Map<string, { at: number; x: number; y: number }>();

  /** How far a carrier must have moved between sweeps to count as WALKING.
   *  Small enough that a body threading a doorway still reads as moving, big
   *  enough that a standing idle's jitter does not. */
  const HAUL_STEP_EPS_M = 0.25;

  /** Is this haul's LOAD already on its carrier? A loaded row is never retired
   *  for staleness: the goods are on the body, so the arrival and the body's
   *  own banking own them from here — the same split the unobserved twin makes
   *  (`twinResolveHauls` delivers a loaded row and only fails an unloaded one). */
  function haulIsLoaded(session: QuestSession, a: TransferAgreement): boolean {
    if (a.carried && Object.values(a.carried).some((n) => n > 0)) return true;
    if (!a.executor) return false;
    // Only the row's OWN heads count — a porter's lunch is not a delivery.
    const held = bodyCarryView(bodyCarryOf(session, a.executor));
    return Object.keys(a.goods).some((g) => stackUnits(held, g) > 0);
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
      // 🚨 ONE DOOR FOR THE DESTINATION — the same one every reader uses.
      // A PILE id is not a container: `stockEndpointOf` dispatches
      // `orderpile:`/`sitepile:`/`annexpile:` to the ORDER ROW's own live
      // `pile` map (legacy spellings and the annex `legacyOrd`-first fallback
      // included) and `bfurn:` to the shell's `shellFurnPiles` stack on
      // TownDeltas, and the container fallback is unreachable for any id that
      // parses as one of them. Crediting `containerRecords` under one wrote a
      // SHADOW STORE read by nothing — not the audit, not `pileShortfall`,
      // not `stagingMissing`, not `stepShellPrograms`' own `pile` read one
      // line under its twin call — so an unobserved delivery destroyed its
      // load and the site re-ordered it forever (the reported "carry the wood
      // to the block" loop; frontier-conservation-diagnosis.md §4, §8). A pile
      // whose row is gone (committed, abandoned, a shell key with no pending
      // building) has no stack to land in at all: leave the row for the
      // no-endpoint sweep below rather than pour the load into an account
      // nobody reads.
      const toPile = isPileEndpointId(a.to);
      const dstStock = toPile
        ? (stockEndpointOf(session, a.to)?.stack ?? null)
        : (session.containerRecords.get(a.to)?.stock ?? {});
      if (!dstStock) continue;
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
      // A pile's map is the row's own and is already live — only a container
      // record needs its store written back (byte-identical to before).
      if (!toPile) setContainerStock(session, a.to, dstStock);
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
      /** WHOSE ORDER BOOK this pile belongs to (per-scope order books) — a
       *  chained refine posted for it lands in the SAME book. */
      scope?: string;
      /** ⚖️ A PLAYER SPOKE THE ORDER THIS PILE FEEDS (surplus control S1):
       *  its hauls may draw the COMMONS RESERVE. Absent = automated, and an
       *  automated pile draws SPARE only. */
      spoken?: boolean;
    },
    issuer: string = LOCAL_PLAYER_CID,
  ): void {
    const want = pileShortfall(session.transfers.all(), opts);
    if (!Object.keys(want).length) return;
    const now = session.taskClock;
    if (now < (pileRetryAt.get(opts.pileId) ?? -Infinity)) return;
    pileRetryAt.set(opts.pileId, now + SITE_HAUL_RETRY_S);
    const led = session.reservations;
    const tmp = `stage:${opts.pileId}`;
    const { sources, withheld } = spareSources(
      session,
      siteMaterialSources(session, opts.at, issuer),
      want,
      opts.spoken === true,
    );
    const { draws } = resolveMaterials({
      holder: tmp,
      costs: want,
      sources,
      ledger: led,
    });
    if (!draws.length && withheld) {
      led.release(tmp); // ⚖️ the reserve is holding it — honest waiting is quiet
      return;
    }
    if (!draws.length) {
      led.release(tmp);
      // THE CHAIN (phase 3): a refinable shortfall posts a refine order
      // instead of starving — blocks get milled, the next resolve finds
      // them. Only what no chain can reach toasts the honest bill.
      const { milling, rest } = ensureRefineOrders(
        session, want, issuer, opts.scope ?? TOWN_ORDER_SCOPE, opts.spoken === true,
      );
      if (Object.keys(rest).length) {
        const bill = Object.entries(rest)
          .map(([g, n]) => `${n} ${g}`)
          .join(", ");
        rateLimitedToast(
          session,
          `starve:${opts.pileId}`,
          `🪵 the site still needs ${bill} — and there is none to fetch`,
        );
      } else if (milling > 0) {
        rateLimitedToast(
          session,
          `mill:${opts.pileId}`,
          `🪚 milling ${milling} ${BLOCK_GLYPH} for the site`,
        );
      }
      // ⚖️ ① THE RELEASE PATH — nothing reachable covers this bill and no
      // chain was launched for it (`milling === 0` is ②'s spoken refusal:
      // the mill itself was refused for want of raws), so what this pile is
      // holding may be worth more to a sibling it can FINISH. Unobserved arm
      // ⇒ ledger arithmetic, exactly like the draw below.
      if (Object.keys(rest).length || milling === 0) {
        releaseStarvedPile(session, opts.pileId, issuer, "ledger");
      }
      return;
    }
    for (const d of draws) {
      // ⚖️ "GET WOOD" MEANS "CUT A TREE" — see `cutForDraw`. Moves nothing, so
      // the draw below is exactly the draw that was planned.
      cutForDraw(session, d.endpoint, d.glyph);
      const src = session.containerRecords.get(d.endpoint)?.stock;
      if (!src) {
        // ⚖️ #44 — a REGION record's draw, unobserved: fell record → shelf
        // → pile, two audited ledger moves in one tick (the scheduled
        // sweep's own arithmetic; the record's depletion IS the felling,
        // so no depleteWildSource — there is no standing feature to fell).
        const ref = parseScopeId(d.endpoint);
        if (ref.kind === "wild" && ref.form === "area") {
          drawSourceShelf(session, ref.tag, { [d.glyph]: d.take });
          const shelf = session.partnerStock[d.endpoint];
          if (shelf) {
            const taken = takeStock(shelf, d.glyph, d.take);
            for (const [g, c] of Object.entries(taken)) {
              opts.pile[g] = (opts.pile[g] ?? 0) + c;
            }
          }
        }
        // ⚖️ A SIBLING PILE'S SURPLUS, UNOBSERVED (task #51 item ④). A pile is
        // an ENDPOINT, not a container record, so the arm above cannot see one
        // — and under pull labor `donorPileSources` puts spare pile units in
        // the ordinary supply walk. This is lane ③'s ledger release arriving
        // by supply instead of by arbitration: the same two audited stack
        // writes, no agreement, no porter, no toast. Off pull the surplus arm
        // lists nothing and this cannot be reached.
        else if (d.endpoint.startsWith(ORDER_PILE_EP)) {
          const donor = stockEndpointOf(session, d.endpoint)?.stack;
          if (donor) {
            const taken = takeStock(donor, d.glyph, d.take);
            for (const [g, c] of Object.entries(taken)) {
              opts.pile[g] = (opts.pile[g] ?? 0) + c;
            }
          }
        }
        continue;
      }
      const taken = takeStock(src, d.glyph, d.take);
      for (const [g, c] of Object.entries(taken)) {
        opts.pile[g] = (opts.pile[g] ?? 0) + c;
      }
      depleteWildSource(session, d.endpoint);
    }
    led.release(tmp);
  }

  /**
   * ⚖️ THE BOOKKEEPER'S SWEEP FOR ONE PILE (task #51, items ①②④⑥) — everything
   * `postPileHauls` does that is NOT issuing somebody a trip.
   *
   * USER RULING: *"no order is issued per person; instead the need exists as a
   * QUANTITY of required materials, like a stocking bill."* So under the pull
   * capability this runs in the poster's place and posts NOTHING. What is left
   * is genuinely the books:
   *
   *  ① THE CO-LOCATED MOVE (②, `CO_LOCATED_PILE_M`). When the source and the
   *    pile stand on the same spot the units change column, not place — that
   *    was never a trip and must not become one now (the "circling the crate"
   *    defect #50 fixed, and a puller must never walk a co-located leg). The
   *    poster's own skip (a LIDDED receiving container within 4 m) plus ②b's
   *    pile-to-pile arm, which arrives here under pull because a donor pile's
   *    surplus is an ordinary source now.
   *  ② THE CHAIN (item ②). The refine row is a BILL WITH ITS OWN PILE, and
   *    posting it is bookkeeping — the user's ruling 4. It used to fire only as
   *    the consequence of a FAILED DRAW, which under pull would never happen
   *    because the bookkeeper no longer draws. So the trigger is stated
   *    positively: what this pile still misses, MINUS the free head stock
   *    standing within its reach, is what the chain must make. The #50 ⑤ 1+1
   *    gather-ahead bound and the #43 anti-runaway law are `ensureRefineOrders`'
   *    own and are untouched.
   *  ③ THE VOICE (⑥, the ④ ONE-VOICE law). A site that can neither fetch nor
   *    mill still SAYS so, through the same rate-limited keys — nothing here
   *    may speak per sweep.
   *
   * 🚨 IT NEVER RESERVES. `resolveMaterials` reserves every draw it plans, and
   * a reservation with no body walking to it is a deadlock, not a plan (there
   * is no porter in this breath any more). The draw and its reservation belong
   * to the body that decided to carry the load — see `freeHeadStockWithinReach`,
   * the non-reserving read both sides ask.
   */
  function bookPileUnderPull(
    session: QuestSession,
    opts: {
      pileId: string;
      legacyPileId?: string;
      at: { x: number; y: number };
      missing: Record<string, number>;
      glyph: string;
      scope?: string;
      spoken?: boolean;
    },
    want: Record<string, number>,
    issuer: string,
  ): void {
    const left: Record<string, number> = { ...want };
    // ① CO-LOCATED — the poster's own skip, without the poster.
    const dstStack = stockEndpointOf(session, opts.pileId)?.stack;
    if (dstStack) {
      // SPARE ONLY for an automated bill (surplus control S1) — the same lens
      // the draw went through, so a co-located commons crate cannot be emptied
      // past the floor just because it happens to stand at the site.
      const { sources } = spareSources(
        session,
        siteMaterialSources(session, opts.at, issuer),
        want,
        opts.spoken === true,
      );
      for (const s of sources) {
        const srcAt = stockEndpointOf(session, s.id)?.at;
        if (!srcAt || Math.hypot(srcAt.x - opts.at.x, srcAt.y - opts.at.y) > CO_LOCATED_PILE_M) continue;
        // TWO kinds of neighbour move as arithmetic, and no third. A LIDDED,
        // receiving container is the poster's own skip verbatim. ANOTHER
        // ORDER'S PILE is ②b's release law — "the units change column, not
        // place" — which under pull arrives here instead of through
        // `releaseStarvedPile`, because the surplus is now an ordinary source
        // and a puller must never WALK a co-located leg. A standing tree still
        // needs a body to go and fell it, and an open shelf's visible props
        // belong to the walked load/unload seam.
        const rec = session.containerRecords.get(s.id);
        const live =
          rec?.stock && rec.relation === "in" && scopeIdReceivesGoods(s.id)
            ? rec.stock
            : s.id.startsWith(ORDER_PILE_EP)
              ? stockEndpointOf(session, s.id)?.stack
              : undefined;
        if (!live) continue;
        for (const head of Object.keys(left)) {
          // `s.stack` is what this source OFFERS (a pile's surplus, a commons
          // stack minus its floor); `live` is the map the units actually leave.
          const take = Math.min(left[head]!, freeUnits(s.stack, session.reservations, s.id, head));
          if (take <= 0) continue;
          let moved = 0;
          for (const [g, c] of Object.entries(takeStock(live, head, take))) {
            dstStack[g] = (dstStack[g] ?? 0) + c;
            moved += c;
          }
          if (moved <= 0) continue;
          // ⏸️ A PILE GAINED UNITS — the same wake the walked unload bumps.
          bumpStockEpoch(session);
          left[head] = left[head]! - moved;
          if (left[head]! <= 0) delete left[head];
        }
      }
    }
    if (!Object.keys(left).length) return; // the bill closed as arithmetic
    // ② THE CHAIN — what no stock within reach can cover.
    const beyondReach: Record<string, number> = {};
    for (const [head, n] of Object.entries(left)) {
      const gap = n - freeHeadStockWithinReach(session, opts.at, head, issuer);
      if (gap > 0) beyondReach[head] = gap;
    }
    // Stock STANDS within reach — a body will come and carry it. Honest
    // waiting is quiet, and there is nothing to mill.
    if (!Object.keys(beyondReach).length) return;
    const { milling, rest } = ensureRefineOrders(
      session, beyondReach, issuer, opts.scope ?? TOWN_ORDER_SCOPE, opts.spoken === true,
    );
    // ③ THE VOICE — the poster's own two lines, the same keys, the same window.
    if (Object.keys(rest).length) {
      const bill = Object.entries(rest)
        .map(([g, n]) => `${n} ${g}`)
        .join(", ");
      rateLimitedToast(
        session,
        `starve:${opts.pileId}`,
        `🪵 the site still needs ${bill} — and there is none to fetch`,
      );
    } else if (milling > 0) {
      rateLimitedToast(
        session,
        `mill:${opts.pileId}`,
        `🪚 milling ${milling} ${BLOCK_GLYPH} for the site`,
      );
    }
    // ⚖️ ① THE RELEASE PATH, PULL-SIDE. `releaseStarvedPile`'s WALKED arm is
    // retired under the capability (a donor pile's surplus is an ordinary
    // SOURCE now — see `donorPileSources`), but its CO-LOCATED arm is a ledger
    // move like the one above and still belongs to the books.
    if (Object.keys(rest).length || milling === 0) {
      releaseStarvedPile(session, opts.pileId, issuer, "haul");
    }
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
      /** WHOSE ORDER BOOK this pile belongs to (per-scope order books). */
      scope?: string;
      /** ⚖️ A PLAYER SPOKE THE ORDER THIS PILE FEEDS (surplus control S1) —
       *  see `twinStagePile`'s twin of this field. */
      spoken?: boolean;
    },
    issuer: string = LOCAL_PLAYER_CID,
  ) {
    const want = pileShortfall(session.transfers.all(), opts);
    if (!Object.keys(want).length) return;
    const now = session.taskClock;
    if (now < (pileRetryAt.get(opts.pileId) ?? -Infinity)) return;
    pileRetryAt.set(opts.pileId, now + SITE_HAUL_RETRY_S);
    // ⚖️ PULL (task #51) — THE POSTER IS THE FIRST SEAT TO GO. Under the
    // capability nobody is issued a trip: the bill is BOOKED (co-located
    // moves, the chain, the honest voice) and the bodies come to it
    // themselves. The gate stands here, after the shortfall read and the
    // retry gate, because both of those are BOOKKEEPING and both still own
    // their job under pull — the read IS the bill, and the gate is what keeps
    // the bookkeeping sweep off the 1 s tick (see `bookPileUnderPull`).
    if (pullLaborOn(session)) {
      bookPileUnderPull(session, opts, want, issuer);
      return;
    }
    const led = session.reservations;
    const tmp = `stage:${opts.pileId}`;
    const { sources, withheld } = spareSources(
      session,
      siteMaterialSources(session, opts.at, issuer),
      want,
      opts.spoken === true,
    );
    const { draws } = resolveMaterials({
      holder: tmp,
      costs: want,
      sources,
      ledger: led,
    });
    if (!draws.length && withheld) {
      led.release(tmp); // ⚖️ the reserve is holding it — honest waiting is quiet
      return;
    }
    if (!draws.length) {
      // STARVED, not waiting: the bill is known and NOTHING reachable can
      // cover any of it. Honest waiting is quiet; a world with no source at
      // all must SAY so, or "nothing happens" is indistinguishable from a
      // stall (the homestead report). Rate-limited by the same pileRetryAt
      // gate above, so this speaks at most once per retry window.
      // THE CHAIN (phase 3): a refinable shortfall posts a refine order
      // first — only what no chain can reach toasts the honest bill.
      led.release(tmp);
      const { milling, rest } = ensureRefineOrders(
        session, want, issuer, opts.scope ?? TOWN_ORDER_SCOPE, opts.spoken === true,
      );
      if (Object.keys(rest).length) {
        const bill = Object.entries(rest)
          .map(([g, n]) => `${n} ${g}`)
          .join(", ");
        rateLimitedToast(
          session,
          `starve:${opts.pileId}`,
          `🪵 the site still needs ${bill} — and there is none to fetch`,
        );
      } else if (milling > 0) {
        rateLimitedToast(
          session,
          `mill:${opts.pileId}`,
          `🪚 milling ${milling} ${BLOCK_GLYPH} for the site`,
        );
      }
      // ⚖️ ① THE RELEASE PATH — see `releaseStarvedPile` (and the twin's copy
      // of this gate). Watched arm, so a body walks the yield exactly as it
      // walks every other haul.
      if (Object.keys(rest).length || milling === 0) {
        releaseStarvedPile(session, opts.pileId, issuer, "haul");
      }
      return;
    }
    const trip = haulTripUnits();
    for (const d of draws) {
      // ⚖️ ② THE CO-LOCATED STAGING SKIP (#50, user report D 2026-09-03: *"a
      // lot of taking items out of the box, walking around the box, and then
      // putting them back in"*). When the SOURCE SHELF and the PILE stand on
      // the same spot, a haul is a walk from a place to itself: the porter
      // stands beside the crate, takes, aims at a point inside the crate's own
      // collider, paths AROUND it, and sets the units down in a different
      // column of the same heap. Nothing about the world changed except the
      // ledger — so move the ledger and post no errand at all. This is the
      // release path's own co-located law (`CO_LOCATED_PILE_M`, ②b — "the
      // units change column, not place"), applied to the arm that was actually
      // producing the observed circling, and reusing that owner rather than
      // minting a twin.
      //
      // WHAT IT DELIBERATELY DOES NOT COVER: a NATURAL SOURCE standing at the
      // spot (`scopeIdReceivesGoods` — a tree yields but never receives) still
      // gets a real errand, because felling is an ACT somebody has to walk out
      // and perform; and a container that SHOWS its contents (`relation: "on"`
      // — a table, a shelf) is left to the walked path, whose load/unload seam
      // owns the visible-prop bookkeeping this arithmetic has no hands for.
      // Both crates in the reported disease — the site's and the town yard's —
      // are lidded (`"in"`), so the fix lands exactly where the bug lives.
      const srcRec = session.containerRecords.get(d.endpoint);
      const srcAt = stockEndpointOf(session, d.endpoint)?.at;
      const dstStack = stockEndpointOf(session, opts.pileId)?.stack;
      if (
        srcRec?.stock &&
        srcRec.relation === "in" &&
        scopeIdReceivesGoods(d.endpoint) &&
        dstStack &&
        srcAt &&
        Math.hypot(srcAt.x - opts.at.x, srcAt.y - opts.at.y) <= CO_LOCATED_PILE_M
      ) {
        const taken = takeStock(srcRec.stock, d.glyph, d.take);
        for (const [g, c] of Object.entries(taken)) dstStack[g] = (dstStack[g] ?? 0) + c;
        // ⏸️ A PILE GAINED UNITS — the same wake the walked unload and the
        // co-located release both bump, for the same reason.
        if (Object.keys(taken).length) bumpStockEpoch(session);
        // A move that goes nowhere is SILENT by design (see the release
        // path's own note): the director must not narrate a walk nobody
        // walked. The staging toast one sweep later is the honest voice.
        continue;
      }
      // ⚖️ #44 — a REGION draw fells AT POST TIME: record → boundary shelf
      // (the scheduled path's own timing), so the walked haul loads real
      // cut goods at the road and a mid-flight unfold can never strand it.
      // The pile lump at the shelf renders the fell the fold law hides.
      const srcRef = parseScopeId(d.endpoint);
      if (srcRef.kind === "wild" && srcRef.form === "area") {
        drawSourceShelf(session, srcRef.tag, { [d.glyph]: d.take });
      }
      // ⚖️ ① ONE ROW PER CARRIER-LOAD (#50, user ruling C: *"they spend most
      // of their time idling"*). A draw used to be posted as ONE agreement
      // however big it was — and a porter can only ever carry `haulTripUnits`
      // (a basket) per trip, so a 24-wood row delivered 8, completed with the
      // LIE "bring 24 wood — delivered", and left the remainder to re-post
      // behind the 20 s `pileRetryAt` gate: three strictly SERIAL trips, one
      // body, everyone else idle beside them. Slicing the draw here posts all
      // three rows in ONE sweep, so three porters claim three trips in
      // parallel and each row's promise is a load somebody can actually
      // carry. The gate is untouched — it never has to fire for this bill
      // again, which is the point.
      //
      // A draw AT OR UNDER one carrier-load is a single row, byte-identical
      // to what this posted before (same agreement, same reservation, same
      // pooled task, same words).
      for (let moved = 0; moved < d.take; moved += trip) {
        const take = Math.min(trip, d.take - moved);
        const a = session.transfers.post({
          from: d.endpoint,
          to: opts.pileId,
          goods: { [d.glyph]: take },
          issuer,
          mode: "haul",
          now,
          sourceGlyph: `bring ${take} ${d.glyph}`,
        });
        // The reservation rides the agreement: consumed as the hauler loads,
        // released by the staging sweep when the agreement dies. Sliced with
        // the row, so the draw's total reservation is unchanged.
        led.reserve(agrHolder(a.id), d.endpoint, d.glyph, take);
        postPooledTask(
          session,
          { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: opts.glyph } },
          issuer,
          { x: opts.at.x, y: opts.at.y, radius: civicRecruitRadius(session) },
          `bring ${take} ${d.glyph}`,
          // ⚖️ batch 2 L1 — the number was already in the poster's hand.
          // A SITE PILE is short by definition (the bill is what `pileShortfall`
          // just answered and every unit of it is missing), so the shortage
          // term is 1 and the haul is worth its units at the town's own fill
          // clock. Nothing invented: `take` is the load being posted.
          goodsValueS(take, 1, townFillS(session.scale), 1),
          // ⚖️ #45 — a SPOKEN bill's hauls answer to their asker; an ambient
          // row's answer to the town's own need.
          opts.spoken === true ? undefined : stackHead(d.glyph),
          // ⚖️ #50 ④ — and a spoken bill's hauls OUTRANK ambient ones in the
          // pool, which is the ruling this key carries.
          opts.spoken === true,
        );
      }
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
        // ⚖️ surplus control S1 — the row already records who ordered it.
        ...(b.spoken ? { spoken: true } : {}),
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

  // ── PER-SCOPE ORDER BOOKS (user law ①, 2026-08-12) ──────────────────────
  //
  // "With the house scope, all orders should be scoped to the house, not the
  // town. So while the family members going out to collect blocks may
  // technically compete with those elsewhere, it only competes in the sense
  // that both need the same resources — they shouldn't be put in the same
  // queue."
  //
  // WHAT WAS WRONG. `ensureRefineOrders` kept ONE standing refine order per
  // refined head for the WHOLE session. A household that needed 4 blocks for a
  // spoken `make workbench` looked at the town's open 198-block workshop bill,
  // read `open >= n`, said "milling 4 block for the workbench" and posted
  // nothing — so the family's 4-block job could not finish until the town's
  // 198-block order did, at REFINE_CREW_CAP = 1 and 0.05 build-days a unit.
  // One queue, two scopes, and the small order always last (measured: the GL
  // closing sweep's handoff item 1).
  //
  // WHAT IT IS NOW. The per-head standing-order rule (the REFINE_CREW_CAP-class
  // limit — one bench, one queue) applies PER SCOPE: the town/civic book, and
  // one book per household. Each book mills at its OWN spot and banks into its
  // OWN container. The two books then meet exactly where the law says they
  // should — at the RAWS, through the reservation ledger that already
  // arbitrates two competing sites.
  //
  // ⚖️ THE PRIORITY LAW, REVERSED BY RULING (#50 ④, user 2026-09-03):
  // *"Player orders should take high priority and creatures should only idle
  // if either their need for rest is high or there is nothing to do."*
  //
  // This block used to end "There is deliberately NO cross-queue priority
  // anywhere in this file", and that sentence is now FALSE — it is repealed
  // here rather than left standing over code that contradicts it. What
  // changed and what did NOT:
  //  • WHAT DID: the TASK POOL orders its open rows so a task posted for a
  //    SPOKEN order (`spoken`, the key every costed order already carries for
  //    surplus control S1) is offered to claimants before an ambient/civic
  //    one. The carrier is that same `spoken` key, threaded to the pool as
  //    `PooledTask.spoken` — never `need` (cosmetic, #45) and never `issuer`
  //    (which reads LOCAL_PLAYER_CID for every civic sweep too, so it cannot
  //    tell an errand somebody asked for from one nobody did).
  //  • WHAT DID NOT: the ORDER BOOKS are still per scope, and one book still
  //    never pre-empts another's raws — the ledger arbitrates, first come.
  //    Priority ranks WHO GETS HANDS FIRST, never who gets the wood; that is
  //    the same split `crewShareOf` has always made when it sorts spoken
  //    founding rows ahead of ambient ones before allocating builders, and
  //    this is that rule reaching the other pool of hands.
  // The town/civic order book — every site bill, every ambient growth row —
  // is `TOWN_ORDER_SCOPE`, imported from kernel/town/construction.ts (task
  // #51: ONE definition, beside the `refineBookOf` that filters on it). The
  // local const of the same name and value was deleted.
  /** One household's own order book. */
  const houseOrderScope = (hi: number): string => `house:${hi}`;
  /** The house a scope key names, or null for the town/civic book. */
  const houseOfOrderScope = (scope: string | undefined): number | null => {
    if (!scope || !scope.startsWith("house:")) return null;
    const hi = Number(scope.slice("house:".length));
    return Number.isInteger(hi) ? hi : null;
  };

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
   * ⚖️ ③ A WORKSPOT IS GROUND A BODY CAN STAND ON (#50, user report D
   * 2026-09-03: *"they need to take the wood to the work location… (Assuming
   * that the box is the work location, which it really shouldn't be.)"*).
   *
   * A CONTAINER'S OWN CENTRE IS NOT A WORKSPOT. Every fallback below used to
   * answer `containerAnchor(...)` — the crate's centre — and a crate is a
   * SOLID COLLIDER (`objectIsSolid`; the site crate is a `chest` of radius
   * 0.7). Three things ride on that one point: the refine row's `at`, which is
   * where the mill LABOR is performed and where `pileEndpointOf` anchors the
   * `orderpile:<ord>` heap, and therefore where every staging haul aims. A
   * body sent to a point inside a box halts flush against its face and paths
   * AROUND it — the observed "walking around the box" — and the pile draws
   * inside the crate it was gathered from.
   *
   * So a CONTAINER answer is resolved to the first STANDABLE ground beside the
   * box (`standPointFor`, the same planner every walk-to-furniture path in the
   * engine already uses, biased toward the settlement's own centre so the spot
   * lands ON the lot rather than out in the field). That is one body-width off
   * the crate — well inside `CO_LOCATED_PILE_M`, so with ② the staging never
   * walks at all: the heap and the labor simply stop happening INSIDE the box.
   *
   * WHAT IS NOT TOUCHED, and why: a DOORSTEP (`refineStationSpot`,
   * `workDoorstep`) and a bare stage centre are already standable ground, and
   * a household's BENCH is a real work location — see the note at that arm.
   * The rule is not "nudge every answer", it is "a box is not a workspot".
   *
   * The work TYPE is the CATALOGUE's (products.ts `refinesTo.at` — wood mills
   * at the carpentry, stone cuts at the masonry), so the routing lives with
   * the material rather than being hard-coded here; an unmarked raw keeps the
   * carpentry.
   *
   * `at` NEVER GATES — stations.ts:422's law for the craft bench, and it holds
   * exactly as hard here. With no masonry standing, stone still cuts: beside
   * the yard crate, then the town center / founded site, which is precisely
   * where every raw refined before the split. The station is somewhere the
   * work GOES when there is one, never permission to do the work at all.
   * Null only with no deltas store of any kind.
   */
  function refineSpotOf(
    session: QuestSession,
    workType: string = REFINE_WORK_DEFAULT,
    /** WHOSE BOOK is milling (per-scope order books). A household mills at
     *  its OWN bench — that is what makes its queue its own in the world and
     *  not merely in the data: the town's single carpentry doorstep was the
     *  shared mill everyone queued at. */
    scope: string = TOWN_ORDER_SCOPE,
  ): { x: number; y: number } | null {
    const t = session.town;
    const centre = t?.stage.center ?? session.foundedSite?.at ?? null;
    /** The standable ground beside a registered container — see the header.
     *  Null in, null out; no world (a headless fixture) answers the raw
     *  anchor, which is what it always answered. */
    const beside = (id: string): { x: number; y: number } | null => {
      const raw = containerAnchor(session, id);
      if (!raw || !world) return raw;
      return standPointFor(
        world.state,
        id,
        raw,
        // Approach from the settlement's own middle, so the spot lands on the
        // lot's inside face rather than behind the crate.
        centre ?? raw,
        DEFAULT_BODY_RADIUS_M,
      );
    };
    if (t) {
      const hi = houseOfOrderScope(scope);
      if (hi !== null) {
        // The bench if one stands, else the household's own craft container —
        // a benchless family (the `make workbench` bootstrap) still mills at
        // home rather than walking its bill to the town's queue.
        //
        // ⚖️ A BENCH IS LEFT ALONE, DELIBERATELY (#50 ③). It is a real work
        // LOCATION — the thing the ruling says a crate is not — and "which
        // side of it do I stand on" is the WALKER's question, answered where
        // walkers ask it (`standPointFor` for a fixture, and since #50 ③ the
        // pile stand-point for the haul's own destination). Nudging the mill
        // spot off the bench would move every household mill in every
        // established town to answer a question nobody was asking. Only the
        // CONTAINER answers below are nudged, because a box is not a
        // workspot at all.
        const own = houseBench(session, hi) ?? beside(craftSpotOf(session, hi));
        if (own) return own;
      }
      return (
        refineStationSpot(session, workType) ??
        beside(TOWN_YARD_EP) ??
        t.stage.center
      );
    }
    const site = session.foundedSite;
    if (site) return beside(SITE_STOCK_ID) ?? site.at;
    return null;
  }

  /** The container milled blocks LAND in: a communal container standing
   *  inside a completed STOREHOUSE (storehouse-first — the town's block
   *  bank), else the yard / site crate. Null = mint into deltas.stock
   *  directly — the yard crate aliases that map when it renders, and since
   *  #50 ⑦ so does the FOUNDED SITE's crate (`FoundedSite.stock` IS
   *  `deltas.stock`), so the fallback can no longer land in a ledger nobody
   *  reads whichever settlement this session has.
   *
   *  ⚖️ A HOUSEHOLD'S OWN BOOK BANKS AT HOME (order-scoping law ①). Its
   *  blocks were milled at its own bench out of raws its own order staged;
   *  putting them on the town's communal shelf would hand them straight back
   *  to the queue the split exists to escape (whoever resolves first wins the
   *  free units). The craft spot IS the container beside the bench, so this
   *  is the same handful of metres the pile already crossed — never a
   *  teleport, and never another household's box. */
  function refineDepositId(session: QuestSession, scope: string = TOWN_ORDER_SCOPE): string | null {
    const t = session.town;
    const scopeHouse = houseOfOrderScope(scope);
    if (t && scopeHouse !== null) return craftSpotOf(session, scopeHouse);
    if (t) {
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
        for (const boxId of stockedIds(session)) {
          // ⚖️ A DELIVERY TARGET MUST RECEIVE (S&D S4). "A tree is not
          // shelving" used to be a scan of `session.wilderness.features` for
          // this id; it is a question about the ENDPOINT — a shelf receives, a
          // natural source only yields — and the grammar answers it for every
          // renderer at once (a standing oak, an embodied plant's body, a
          // grazing cow, an offloaded stand).
          if (!scopeIdReceivesGoods(boxId)) continue;
          const boxOwner = session.containerRecords.get(boxId)?.owner;
          if (boxOwner !== null && boxOwner !== undefined) continue;
          if (isDerivedStoreObject(session, boxId)) continue;
          const at = containerAnchor(session, boxId);
          if (!at) continue;
          if (at.x >= rect.x && at.x <= rect.x + rect.w && at.y >= rect.y && at.y <= rect.y + rect.h) {
            return boxId;
          }
        }
      }
      return hasStock(session, TOWN_YARD_EP) ? TOWN_YARD_EP : null;
    }
    if (session.foundedSite) {
      return hasStock(session, SITE_STOCK_ID) ? SITE_STOCK_ID : null;
    }
    return null;
  }

  // ⚖️ ⑤ `refineBookOf` — ONE (head, scope) BOOK, SPLIT BY LADDER PHASE (#50)
  // — now lives in kernel/town/construction.ts beside `stagingMissing` and
  // `pileShortfall` (task #51: the pipeline's 1+1 bound is part of the bill a
  // body reads, so it cannot stay a closure). The copy that stood here was
  // deleted; both call sites below now read the kernel's one definition.

  /** ENSURE the chain covers a starved bill: for each missing head a raw
   *  refines into, keep at most one GATHERING refine order PER SCOPE sized to
   *  the shortfall, plus (⑤) one already milling (a remainder re-triggers
   *  after the commit). Returns what the chain cannot reach (`rest` — the
   *  honest starved toast's bill) and how many units are being milled
   *  (`milling` — the softer message). */
  function ensureRefineOrders(
    session: QuestSession,
    want: Record<string, number>,
    /** The author the starved bill belongs to — the ranking below measures
     *  reachable raws through that author's own reach, so a chained refine
     *  order can never be ranked on stock the order itself may not draw. */
    issuer: string = LOCAL_PLAYER_CID,
    /** WHOSE ORDER BOOK the bill belongs to (per-scope order books, law ①).
     *  Default = the town/civic book, which is every caller that is not a
     *  household's own craft. */
    scope: string = TOWN_ORDER_SCOPE,
    /** ⚖️ THE BILL THAT ASKED WAS SPOKEN (surplus control S1/S2). A refine
     *  order is never spoken in its own right, so it inherits: the mill posted
     *  for a spoken `make` may draw the commons reserve for its raws, and the
     *  AUTOMATED arm below will not LAUNCH a mill the spare cannot feed.
     *  Default false = every ambient caller and every pre-patch call site. */
    spoken: boolean = false,
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
      // ⚖️ ONLY THIS SCOPE'S OWN ROWS COVER THIS SCOPE'S BILL (law ①). A row
      // in ANOTHER book is not this book's work in progress, however much of
      // the same head it happens to be milling.
      const book = refineBookOf(deltas, head, scope);
      const open = book.rows.reduce((s, r) => s + r.count, 0);
      // ⚖️ ⑤ GATHER-AHEAD — A BOUNDED 1+1 PIPELINE (#50, user ruling C: the
      // creatures "spend most of their time idling"). The ②c gate below is
      // relaxed by exactly one row: while a mill is LABORING (144 s of bench
      // work for a 12-block batch, during which its pile is full and the pool
      // has nothing to offer anybody), the NEXT batch may open and GATHER, so
      // the porters keep working through the mill window instead of standing
      // around waiting for it to finish. The moment that row's own materials
      // are in it WAITS (the stage gate in `stepFoundedConstruction` holds it
      // while a sibling labors) — so there is never a second mill running and
      // `REFINE_CREW_CAP = 1` still means one bench, one queue.
      //
      // #43 ②c'S ANTI-RUNAWAY INTENT STANDS, and this is why the bound is
      // exactly two: the disease it cured was UNBOUNDED re-posting — four
      // concurrent refine rows splitting one bill, their piles all on the one
      // yard spot, porters shuttling the same wood between them forever. Two
      // rows in fixed roles (one milling, one gathering) cannot do that: the
      // gatherer is the only row drawing raws, and nothing may be posted while
      // one is gathering.
      const gatherAhead = book.staging.length === 0 && book.rows.length < 2;
      if (open > 0 && !gatherAhead) {
        // ⚖️ `n`, NOT `open` — WHAT THIS CALLER IS OWED (2026-08-12). `milling`
        // is the number the caller SAYS OUT LOUD, and `open` is the town's
        // whole mill queue: every starved consumer announced the queue as if it
        // were its own order, so a bench short of 4 blocks toasted "milling 67
        // block for the workbench" while a market site said the same 67 in the
        // same window (measured: fx-doll-bench-long). One shared order covers
        // many bills; what each of them is waiting for is its own.
        //
        // 🚨 ONE OPEN ROW PER (head, scope) — homestead-defect-round ②c. The
        // gate used to be `open >= n`, which deduped only a bill the queue
        // already covered WHOLE: any shortfall re-posted the REMAINDER as a
        // fresh supply-sized row every sweep, and the release machinery then
        // returned wood to the commons where the next sweep read it as fresh
        // supply — measured on the founding homestead as FOUR concurrent
        // refine rows (66+6+23+25 blocks) splitting one 120-block bill, their
        // piles all at the same yard spot, porters shuttling the same wood
        // between them forever. While a row of this head is GATHERING in this
        // book (or two already stand — see the gather-ahead note above), the
        // chain is the answer and nothing more is posted; the remainder
        // re-triggers when an open row COMMITS (the batch cadence
        // REFINE_BATCH_UNITS documents), which is the convergence the old
        // remainder-repost never had.
        milling += n;
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
      // ⚖️ …AND FOR AN AUTOMATED BILL, KEY 1 IS THE SPARE, NOT THE FREE STOCK
      // (surplus control S1). One lens for both readings: the raw a town may
      // actually cut today is the one it can cut WITHOUT eating the reserve, so
      // ranking on free units while the cap below spends spare ones would pick
      // a raw it then declines to mill and pass over one it could have.
      const ranked = raws
        .map((p, i) => {
          const spot = refineSpotOf(session, p.refinesTo?.at, scope);
          const free = spot
            ? spareSources(
                session,
                siteMaterialSources(session, spot, issuer),
                { [p.glyph]: 1 },
                spoken,
              ).sources.reduce(
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
      // ⚖️ S&D S3 H1 — multiplier ② of five, at the site that actually MOVES
      // stock (the transaction below, `count * inPerOut`) AND at every reader
      // that decides whether a build is POSSIBLE: `withRefinableCredit` now
      // takes the same dial (products.ts), so the affordability board, this
      // mill and `infeasibleBillHeads` all divide by `effectiveInPerOut`.
      //
      // 🚫 THE OLD RESIDUAL IS RETIRED, AND WHY IT EXPIRED IS THE POINT. It
      // read: "a preview that shows MORE raw material than what a bench
      // actually charges is the safe direction", and it was logged when every
      // other reader WAS a preview. Two things broke it. (a) A refusal gate is
      // not a preview — `infeasibleBillHeads` REJECTS an order, so a reader
      // that disagrees with the mill is not conservative, it is wrong; on a
      // `resource_compression: 7.5` world the board and the gate differed by
      // exactly 2×. (b) The "safe direction" had already inverted: a dial ABOVE
      // 1 makes `effectiveInPerOut` SMALLER, so the bench charges LESS than the
      // dial-1 anchor assumed and the anchored board UNDER-credited — hiding
      // buttons for builds the town could perform. That is a false negative
      // about capability, not a cautious promise.
      //
      // The old note also named FREIGHT PRICING as an anchored reader. It is
      // not one: `freight.refineOutUnits` takes the ratio as an ARGUMENT, so
      // it has no anchor of its own and answers whatever its caller divides
      // by — and it currently has no caller at all.
      const inPerOut = effectiveInPerOut(raw.refinesTo?.inPerOut ?? 1, session.scale.resourceCompression);
      // ⚖️ AMBIENT GROWTH MAY NOT LAUNCH A BILL THAT WOULD EXHAUST THE COMMONS
      // (surplus control S2). The mill an AUTOMATED consumer asks for is sized
      // to the raws the SPARE can actually feed — not to the appetite. Two
      // things this deliberately is not: it is not a refusal (⑥ stands — an
      // order that CAN be fed is still posted at full size and still waits
      // honestly for hands), and it never touches an IN-FLIGHT row (first-come
      // reservations STAND; the cap bites only on the row about to be created).
      // A spare of zero posts NOTHING and stays quiet — the caller's `milling`
      // still counts the bill, so the bench says "milling N" rather than "there
      // is none to fetch" over a shelf that has some.
      // ⚖️ ② …AND A SPOKEN BILL IS SIZED TO SUPPLY TOO (2026-08-15). The cap
      // above used to be skipped outright for a spoken order — `if (!spoken)`
      // — so `say build house` posted a 120-block / 132-wood mill regardless
      // of what stood in the world, and a second book posting its own
      // full-size mill against the same finite commons produced 237 wood of
      // demand in a world holding 144 (the deadlock ① releases). Appetite is
      // not supply for anybody. What stays TRUE of ⑥ is the distinction the
      // S2 note already draws: a PARTIAL clamp is not a refusal — the order is
      // posted at the size the shelf can feed and waits honestly for hands,
      // and the delivery toast names the honest bill. Only a clamp to ZERO is
      // a refusal, and a refusal is VOCAL.
      const feasible = Math.floor(pick.free / Math.max(1, inPerOut));
      // `n`, not `n - open`: the caller's OWN bill is what this row is sized
      // to, and `open` is the book's queue. (Under ②c `open` was always 0
      // here; with ⑤'s gather-ahead a LABORING sibling may be open, and
      // subtracting its count would size the fresh gather to a batch that is
      // already milling.) REFINE_BATCH_UNITS slices the bill into the delivery
      // cadence (④) — the remainder re-triggers through the same three starved
      // paths after the batch commits.
      let count = Math.min(n, feasible, REFINE_BATCH_UNITS);
      if (count <= 0) {
        if (spoken) {
          // 🚨 REFUSALS ARE VOCAL (engine law) — the two-channel shape
          // `orderZone`/`orderTrade` use: the addressed clerk says no, and the
          // banner says it unconditionally so a player with nobody addressed
          // still hears an answer. Never a silent no-op. Rate-limited by the
          // caller's own per-pile retry gate, exactly like the starved toast.
          const clerk = session.addressedFamily ?? gazeCreature(session) ?? convoNodeId() ?? null;
          if (clerk && session.creatures?.nodeByCreature.has(clerk)) npcChatBubble(session, clerk, "no");
          presenter.toast(
            `💬 can't mill the ${head} — there is no ${raw.glyph} to cut`,
            "feedback",
          );
          continue; // NOT counted as `milling`: nothing was ordered and nothing is coming
        }
        milling += n; // the bill IS known and the chain IS the answer — just not today
        continue;
      }
      deltas.postRefineOrder({
        produces: refinedGlyphOf(raw.glyph) ?? head,
        count,
        costs: { [raw.glyph]: count * inPerOut },
        pile: {},
        at,
        startedDay: buildDayNow(session),
        buildDays: constructionGameDays(REFINE_UNIT_BUILD_DAYS * count, session.scale),
        // The town book writes NO key — a civic row serializes exactly as it
        // did before the split, so no save round-trips differently for it.
        ...(scope !== TOWN_ORDER_SCOPE ? { scope } : {}),
        // …and the SPOKEN key likewise: absent on every ambient row, so an
        // automated mill serializes byte-identically to a pre-patch save.
        ...(spoken ? { spoken: true } : {}),
      });
      milling += n; // …and the same on this arm: the caller's OWN bill, open + new
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
    const destId = refineDepositId(session, r.scope);
    const stack = destId
      ? ensureContainerStock(session, destId)
      : (deltas.stock as Record<string, number>);
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
    // ⚖️ THE ANCHOR IS THE ENDPOINT THE STOCK LANDS IN, whatever RENDERS that
    // endpoint (user law, 2026-08-12: a source/stock place is one kind of
    // thing — a storeroom, a shop, a yard, a stand of trees — and the
    // building around it is a renderer, not a separate rule).
    //
    // 🌲 WHAT THIS FIXES. The scan below used to be a GATE — "the par loop is
    // the STOREHOUSE's behaviour; no storehouse, no ambient logging" — and it
    // made the loop dead in the only world that has anything to log:
    // `plan.ts` lays no base works at `days ≤ FOUNDING_AGE_DAYS`, so a
    // founding town can never own a finished storehouse, and the two shipped
    // worlds each held one half of the chain (the dollhouse a storehouse and
    // no wilderness, the frontier wilderness and no storehouse — the GL
    // closing sweep's pincer, handoff item 2).
    //
    // `refineDepositId` had already answered the endpoint question — the
    // storehouse's crate, else the yard, else the founding site's pile — and
    // `isCivicStockDest`/`stepTaskPool` have always treated all three as the
    // same civic destination ("par-stock logging to the yard / storehouse is
    // the town's business", quest-host.ts). The doorstep scan was the one
    // place that disagreed. So the storehouse's doorstep is now a PREFERENCE
    // (a walk to the shed's door rather than to a crate behind it), not a
    // permit, and the fallback is simply where the destination endpoint
    // stands. No age test, no wilderness test, no new rule — one deleted.
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
    store ??= containerAnchor(session, destId);
    if (!store) return;
    if (!observedRect(session, { x: store.x - 2, y: store.y - 2, w: 4, h: 4 })) return;
    const sources = siteMaterialSources(session, store, issuer);
    // ⚖️ S&D S4 — the two halves of the policy, named once (see
    // `civicDrawSources` / `townShelfSources`): what the town HAS is what sits
    // on its own shelves; what this loop may DRAW is the commons' spare and
    // whatever nobody owns. A shelf never stocks itself, whichever of the
    // three the destination happens to be today.
    const onHand = townShelfSources(session, sources);
    const drawable = civicDrawSources(session, sources).filter((s) => s.id !== destId);
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
    // ⚖️ S&D S3 — THE PAR≡RESERVE COUPLING, live: the same dial-resolved par
    // this loop stocks TO is `commonsReserveOf`'s own floor (storehouseRawParAt).
    const par = storehouseRawParAt(session.scale.resourceCompression);
    for (const p of rawsForRefined(BLOCK_GLYPH)) {
      const free = onHand.reduce((s, src) => s + freeUnits(src.stack, led, src.id, p.glyph), 0);
      // Loads already walking count toward the par — the retry window must
      // top up the SHORTFALL, never re-order the whole batch.
      const wantN = par - free - (inbound[p.glyph] ?? 0);
      if (wantN <= 0) continue;
      const tmp = `stock:${destId}:${p.glyph}`;
      // AUTOMATED, therefore SPARE-ONLY on the commons (`spoken: false`) — the
      // one reserve gate every other ambient draw goes through, rather than a
      // second rule written here.
      const { sources: draw } = spareSources(session, drawable, { [p.glyph]: wantN }, false);
      const { draws } = resolveMaterials({
        holder: tmp,
        costs: { [p.glyph]: wantN },
        sources: draw,
        ledger: led,
        // ⚖️ S&D S3 H2 — "larger trees will typically be cut first" (user
        // law, verbatim): the draw ranks by size class before cost, never by
        // hand-seconds fiction (transfer.ts `rankKey`'s own doc). A species
        // with no growth clock (rock) answers 0 for every candidate — pure
        // distance order, unchanged, and so does every candidate that is not
        // a natural source at all. NOT a wilderness gate (S4): this is the
        // RENDERER being asked for the state only it holds — which size class
        // is standing here — the way a chest is asked how full it is.
        price: {
          rankKey: (s) => {
            const f = session.wilderness?.features.find((x) => wildFeatureContainerId(x) === s.id);
            return f ? wildFeatureSizeRank(f) : 0;
          },
        },
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
        // ⚖️ #45 — worded by the REAL destination: "carry the stone to the
        // storehouse" over a homestead's yard crate was the user's report
        // (refineDepositId falls back to the yard/site crate when no
        // storehouse stands — the word must fall back with it).
        const destWord = destId === TOWN_YARD_EP || destId === SITE_STOCK_ID ? "yard" : "storehouse";
        postPooledTask(
          session,
          { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: destWord } },
          issuer,
          { x: store.x, y: store.y, radius: civicRecruitRadius(session) },
          `bring ${d.take} ${d.glyph}`,
          // ⚖️ batch 2 L1 — `wantN` was computed one line up and thrown away.
          // THE SHORTAGE IS THE PAR SHORTFALL, which is law ②'s inventory-
          // manager reading applied at the town rung: a stocking row's want IS
          // the shelf's shortfall (`needShortageOf`), so a yard one unit under
          // par is worth almost nothing and an empty one is worth a full load.
          // Not `townShortage`: the raws have no `eco.fills` row, so it answers
          // 0 for every one of them and would price the whole par loop at zero.
          goodsValueS(
            d.take,
            Math.max(0, Math.min(1, wantN / par)),
            townFillS(session.scale),
            1,
          ),
          stackHead(d.glyph), // ⚖️ #45 — a par top-up is the town's own need
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
    // 🚨 THE BILL IS `structureCosts(spec)`, NEVER `spec.costs` (phase 6). The
    // row authors only its EXTRAS; the blocks are derived from the footprint by
    // the ONE resolver. Passing the raw map founded every player-ordered
    // building with an EMPTY bill — `stagingMissing` answered {} on the next
    // line, the plot staged instantly, no haul was ever posted and the walls
    // rose out of nothing (the frontier farm finished with the yard's 14 wood
    // and 6 stone untouched, 2026-08-11). Everything downstream of `b.costs`
    // — the site pile, postSiteHauls, the mill's refine orders, the builder's
    // ghosts, the completion labor branch — was correct and starved.
    const b = ctx.deltas.foundBuilding(
      candidate,
      buildDayNow(session),
      constructionGameDays(spec.buildDays, session.scale),
      structureCosts(spec),
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
    // ⚖️ THE FELLING PREREQUISITE, STAKED AT ORDER TIME (2026-09-02): whatever
    // is standing on this lot is recorded on the row as REQUIRED WORK. The
    // order is accepted either way — a tree is never a refusal — and the sweep
    // commissions the felling from here on.
    const blockers = lotClearingNow(session, b);
    if (blockers.length) b.clearing = blockers;
    // A zero-bill structure stages instantly (labor from today — exactly the
    // pre-pipeline clock); everything else waits on its hauls. 🚫 …AND NOTHING
    // stages onto occupied ground: the bill and the lot are two prerequisites,
    // and the instant path used to know about only one of them.
    if (!blockers.length && !Object.keys(stagingMissing(b)).length) {
      ctx.deltas.stageFounded(b.ord, b.startedDay);
    } else if (Object.keys(stagingMissing(b)).length) {
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
        const gathering = orderGathering(b);
        const pile = pileEntries(b.pile);
        sites.push({
          id: `site_wf_${b.ord}`,
          x: site.at.x + b.dx, y: site.at.y + b.dy, w: b.w, h: b.h,
          type: b.type,
          // ⑦ — the same ladder a town site climbs, and the same icon.
          stage: Math.min(foundedStage(b, day), 2) as 0 | 1 | 2,
          progress: foundedProgress(b, day),
          ...(gathering ? { gathering } : {}), // ④ #43 — the gather readout
          ...(pile.length ? { pile } : {}), // #44 — the hauled goods, drawn
          ...(spec ? { glyph: structureDisplayGlyph(spec) } : {}),
          word: b.type, // the SPOKEN word beside the drawn glyph
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
            registerContainer(session, piece.id, "in", null, {}); // communal — the founders'
          }
        }
      }
    }
    const base = (world.state.spec.buildings ?? []).filter((bd) => !wildFoundedIds.has(bd.id));
    wildFoundedIds.clear();
    for (const s of specs) wildFoundedIds.add(s.id);
    world.setBuildings([...base, ...specs]);
    // #44 — ordered sites are drop-reserved; COMMUNITY GROUND is the exact
    // opposite (the camp's lot exists to be dropped on), so it joins the
    // painted set only, AFTER the reservation mapping above it.
    world.setReservedGround(sites.map(({ x, y, w, h }) => ({ x, y, w, h })));
    const lot = communityGroundOf(site.deltas.zones());
    if (lot) {
      // #44 — the COMMUNITY PILE renders on the lot: the site ledger's own
      // rows as stacked goods (the crate stays the endpoint).
      const pile = pileEntries(site.stock);
      sites.push({
        id: `site_lot_${lot.ord}`,
        x: site.at.x + lot.x - lot.r,
        y: site.at.y + lot.y - lot.r,
        w: lot.r * 2,
        h: lot.r * 2,
        type: "community",
        stage: 0, // marked ground, never "worked" — the lot is not a build
        ...(pile.length ? { pile } : {}),
        word: "yard", // the camp is the yard's own ground (#45 place word)
      });
    }
    questViewOf()?.setSites?.(sites); // phase 1a: host state via accessor
    lastSites = sites;
  }

  /**
   * ⚖️ A HAUL'S DESTINATION IS THE BUILDING, NEVER THE PIECE
   * (civic-labor-and-polish.md §4.1).
   *
   * The `to` PlaceRef on a pooled TRANSFER goal is WORDING and nothing else —
   * the haul itself runs off the agreement's endpoint (`a.to`), so this word is
   * only ever read by `goalIntentLine` / `goalDestination`. Both call sites that
   * fill it for a `bfurn:` delivery used to derive it from the CARGO: the shell
   * program passed the `StationKind` it was asking for, and the reload re-pool
   * ran `furnitureKindOfGlyph` over the goods. With a door in the goods that
   * makes the object and the destination the SAME WORD, and the hauler announces
   * *"I will carry the door to the door"* — the user's report.
   *
   * The building's own word answers it. The structure TYPE is the spoken one
   * ("workshop", "market") — exactly the reading `buildingPlaceWord` gives a
   * body standing inside it, and every type in the catalog is already a lexeme
   * in every locale; the catalog LABEL ("carpentry") is display chrome and may
   * not be drawable. `"building"` is the honest fallback for a key that names
   * nothing standing (it, too, is a catalog type and a lexeme).
   */
  function shellHaulDestWord(session: QuestSession, key: string): string {
    const wi = workIndexOfKey(session, key);
    return (wi >= 0 ? session.town?.plan.works[wi]?.type : undefined) ?? "building";
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
   * ⚖️ WHICH HOUSEHOLD MAKES A SHELL'S PIECE — a household of the SITE'S OWN
   * NEIGHBOURHOOD (civic-labor-and-polish.md §1 step 3), never the focus family
   * by fiat.
   *
   * This line used to read `familyOf(session)?.house`, so EVERY door and every
   * workbench any shell in town ever wanted was made at the player's kitchen
   * table — the user's "why was the player's house specifically conscripted for
   * everything?". It is the same embodied-set bias as the recruit radius wearing
   * a different hat: there, the family was nearest by forfeit; here, they were
   * named outright.
   *
   * The walk is the ordinary one: houses inside {@link civicRecruitRadiusM} of
   * the site, measured the way every other source walk measures
   * (`sourceDistanceM` — street metres where there are streets), BENCHED houses
   * first (a benchless one has to bootstrap its own workbench before the piece,
   * so it is strictly slower and mints a tool nobody asked for), then nearest,
   * then lowest index so the same shell picks the same kitchen every sweep. A
   * household already holding a craft job is skipped — one slot per house.
   *
   * `"none"` = no local household can take it. The want then WAITS: the next
   * sweep asks again, the neighbourhood's own crafters free up, and nothing is
   * ever conscripted from across town to fill the gap.
   *
   * 🚨 `"held"` — THE SAME WALK ANSWERS "DO WE NEED TO MAKE ONE AT ALL"
   * (project_building_scope_inventory's law, at the one call site that never
   * got it: *"Every 'do we need to make one' gate means `anywhere`"*). The
   * caller reaches here only because no BOX in reach holds the piece — but a
   * finished craft on a SHOWN house leaves its box the instant it is made
   * (`dropFromStack` — it becomes a prop on the floor, which is a real unit
   * that no `stockEndpointOf` can name), and the household's hands and the
   * shell's own delivery pile are the same blind spot. Asking the boxes alone,
   * this sweep saw "none stored" over a door that was lying right there and
   * designated ANOTHER one, every window, forever: the user's "Mara kept
   * crafting it over and over", and a standing breach of item conservation
   * (blocks burnt to mint duplicates). One exists ⇒ we wait for it.
   *
   * 🚨 …AND IT NAMES THE HOLDER (2026-08-12). "Wait for it" is only honest if
   * something is bringing it, and for a whole round nothing was: the piece was
   * in a household box the caller's own scan is forbidden to open (`mayUse`
   * refuses another household's containers outright), so the shell waited for a
   * delivery nobody had scheduled. The commission (`CraftJob.for`) schedules
   * one at the moment of making; this field is the SECOND half — the recovery
   * for a delivery that failed, and for every piece already sitting in a
   * neighbour's cupboard from before the commission existed. A caller that gets
   * `"held"` can now go and fetch it.
   */
  type CraftHand =
    | { kind: "make"; house: number }
    | { kind: "held"; house: number }
    | { kind: "none" };
  function craftHouseholdFor(
    session: QuestSession,
    at: { x: number; y: number },
    glyph: string,
  ): CraftHand {
    const t = session.town;
    if (!t) return { kind: "none" };
    const reach = civicRecruitRadius(session);
    let best: { hi: number; d: number; benched: boolean } | null = null;
    for (const h of t.plan.houses) {
      const hi = h.index;
      const door = houseDoorstep(t.stage.center, h);
      // Chord first: a street walk is never SHORTER than the straight line, so
      // a house already too far as the crow flies can be dropped without
      // walking the graph for it (this runs over every house in town).
      if (Math.hypot(door.x - at.x, door.y - at.y) > reach) continue;
      const d = sourceDistanceM(session, at, door);
      if (d > reach) continue;
      if (houseHolds(session, hi, glyph) > 0) return { kind: "held", house: hi };
      if (craftJobsOf(session).get(hi)) continue; // its one slot is taken
      const benched =
        !!houseBench(session, hi) || houseHolds(session, hi, furnitureGlyph("workbench")) > 0;
      if (
        !best ||
        (benched !== best.benched
          ? benched
          : d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && hi < best.hi))
      ) {
        best = { hi, d, benched };
      }
    }
    return best ? { kind: "make", house: best.hi } : { kind: "none" };
  }

  /**
   * WORK-BUILDING PROGRAM PULL (pipeline ⑥ — recursion's craft-designation
   * leg): a standing program row on a completed work building (a shell's
   * ordered bedroom) PULLS its required furniture. A stored `furn.<kind>`
   * stack anywhere usable is hauled over as a CIVIC task (any resident may
   * carry it — the `bfurn:` delivery pile); none stored starts a CRAFT JOB
   * at a NEIGHBOURING household, bench-first (the ④ automation law) — the
   * shell's bed recurses into wood, which recurses into the felled tree. One
   * action per sweep; per-building rate limit.
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
        // 🚨 …AND A COMMISSION ALREADY PLACED IS A DELIVERY UNDERWAY (CraftJob.for).
        // The two lines above only see a piece that EXISTS; between the order and
        // the finished thing this sweep re-asked every 20 s, skipped the busy
        // household (`craftHouseholdFor` passes over a taken craft slot) and
        // designated the SAME piece at the next house along — a bed apiece across
        // the neighbourhood while the first one was still being cut. The brake
        // used to be accidental: the first piece to finish answered `"held"` and
        // stopped the rest. Now the promise itself is legible, so the sweep waits
        // on the order it placed rather than on the object it produces.
        for (const j of craftJobsOf(session).values()) {
          if (j.for === `${BFURN_EP}${key}` && j.produces === glyph) return "wait";
        }
        const at = {
          x: center.x + wk.dx + wk.w / 2,
          y: center.y + wk.dy + wk.h / 2,
        };
        // ⚖️ THE THIRD COPY, RETIRED (scope-behaviors.md §2.2): the inline
        // nearest-first sort that used to live here is now the ONE priced walk,
        // with this call's own "does it hold one" test passed in.
        //
        // 🚨 A NEIGHBOUR'S BOX IS IN REACH FOR THIS ONE GLYPH (2026-08-12). The
        // scan is otherwise the issuer's own propriety walk, and `mayUse`
        // refuses another household's containers — which is right for wood and
        // wrong for the door THIS SHELL COMMISSIONED. The two sides of the want
        // used to answer different questions about the same object: the "do we
        // need to make one" test sees the whole scope (`"anywhere"`) and said
        // `"held"`, the haul sees only boxes it may open and said "nothing
        // stored", and the piece sat in a kitchen forever. One definition now:
        // whatever `"held"` can SEE, this can FETCH.
        const heldAt = craftHouseholdFor(session, at, glyph);
        const src = rankPricedSources(
          heldAt.kind === "held"
            ? [
                ...siteMaterialSources(session, at, issuer),
                ...houseContainerKeys(session, heldAt.house)
                  .filter((id) => (session.containerRecords.get(id)?.stock?.[glyph] ?? 0) > 0)
                  .map((id) => ({
                    id,
                    stack: session.containerRecords.get(id)!.stock!,
                    d: sourceDistanceM(session, at, containerAnchor(session, id) ?? at),
                  })),
              ]
            : siteMaterialSources(session, at, issuer),
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
            // §4.1 — the SHELL is where this is going, not `k`: the piece being
            // carried is already the sentence's object, and naming it twice is
            // "I will carry the door to the door".
            {
              kind: "transfer",
              agreementId: a.id,
              goods: a.goods,
              to: { kind: "named", id: shellHaulDestWord(session, key) },
            },
            issuer,
            { x: at.x, y: at.y, radius: civicRecruitRadius(session) },
            `bring ${k}`,
            // ⚖️ batch 2 L1 — ONE piece, and the shell has none (the two lines
            // above are exactly that test), so the shortage term is 1.
            goodsValueS(1, 1, townFillS(session.scale), 1),
          );
          return "done";
        }
        // NONE STORED — the craft designation: a household in THE SITE'S OWN
        // NEIGHBOURHOOD makes it (bench-first). Busy crafter ⇒ retry next
        // sweep; nobody local ⇒ the want simply waits (§1's locality law —
        // never the focus family from across town, which is what this line
        // used to name outright).
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
        // Nothing fetchable. A `"held"` that reaches HERE is a unit no haul can
        // take — a prop on the maker's own floor. It is still a unit, so we do
        // not mint a second; F4's furnish sweep stands it up where it lies and
        // the next want is answered afresh.
        if (heldAt.kind === "held") return "wait";
        if (heldAt.kind === "none") return "done"; // nobody local is free; ask again next sweep
        const hi = heldAt.house;
        const target =
          houseBench(session, hi) || houseHolds(session, hi, furnitureGlyph("workbench")) > 0
            ? fdef
            : furnitureItemOf("workbench")!;
        craftJobsOf(session).set(hi, {
          ...furnitureCraftRecipe(target),
          spotId: craftSpotOf(session, hi),
          agreements: [],
          laborS: 0,
          // 🚨 THE COMMISSION IS RECORDED (CraftJob.for). Without it the shell
          // designates the piece, the household makes it, and the piece stays
          // in that household's kitchen — unreachable by the haul scan and
          // perfectly visible to the `"held"` test, so the shell waits on a
          // delivery nobody ever scheduled. Only the WANTED piece is owed:
          // the bench-first bootstrap (`target !== fdef`) is the maker's own
          // tool and belongs to the house that has to bootstrap it.
          ...(target === fdef ? { for: `${BFURN_EP}${key}` } : {}),
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

  /**
   * ⚖️ THE PACE IS A HAND COUNT, NOT A CLOCK (scope-unification ⑥,
   * 2026-08-13).
   *
   * What stood here was `REFLOW_GAP_S = 12` and a per-building `reflowAt`
   * map: one carry per building per twelve seconds, whoever happened to be
   * free and however many of them. A household with two people standing about
   * carried one chest a minute; a household with nobody home carried one just
   * as often, because the metronome never asked. The chapter's first draft
   * named it for what it was — "a timer standing in for a hand count".
   *
   * It is now the SAME census the build sites read (`availableCrew` /
   * `crewShareOf`): a building asks for the hands it could put on a carry
   * THIS INSTANT, {@link allocateHands} splits the town's free pool
   * (`townHandPool`) across everyone asking, and a share of one buys one
   * carry this sweep. Two free members ⇒ two carries; none ⇒ none, and the
   * drawing waits until somebody is free, which is what waiting for a hand
   * means.
   *
   * THE SPLIT NEEDS A CLOSED LIST, and only a finished pass has one — the
   * askers arrive from two different loops (`stepConstructionHousekeeping`
   * for houses, `stepShellPrograms` for shells), so no single call site knows
   * the whole claim list the way the order loop does. Asks therefore
   * accumulate through a tick and are allocated at the first ask of the NEXT
   * one: the same "read the whole roster on the town clock" shape as
   * `handPoolMemo`, and one tick of lag on a decision whose unit is a
   * ten-second walk.
   */
  /** Hands each building asked for, this tick (still filling). */
  const reflowAsk = new Map<string, number>();
  /** The townClock the filling ask list belongs to. */
  let reflowAskAt = -1;
  /** The CLOSED allocation — what each asker got out of the free pool. */
  let reflowShare = new Map<string, number>();

  function reflowShareOf(session: QuestSession, key: string, cap: number): number {
    if (session.townClock !== reflowAskAt) {
      const keys = [...reflowAsk.keys()];
      const got = allocateHands(
        keys.map((k) => reflowAsk.get(k) ?? 0),
        townHandPool(session).free,
      );
      reflowShare = new Map(keys.map((k, i) => [k, got[i] ?? 0]));
      reflowAsk.clear();
      reflowAskAt = session.townClock;
    }
    reflowAsk.set(key, cap);
    return reflowShare.get(key) ?? 0;
  }

  /**
   * ONE BODY PER PIECE — the timer's OTHER job, done honestly.
   *
   * A carry is in flight from the moment the body is sent until the piece
   * lands, and for all of that time the piece is still standing where it was,
   * so the work list still asks for it. The 12 s gate hid that by never
   * sending a second body inside its window; with the pace set by hands
   * instead, the next free member would be sent after the very same chest and
   * one of them would arrive to nothing. So the PIECE is claimed, by the body
   * that was sent — and a body that is no longer walking (its errand landed,
   * a pooled claim took it off, it streamed out) is carrying nothing, so its
   * piece goes straight back on the list. No clock anywhere in it.
   */
  const reflowCarry = new Map<string, Map<string, string>>();

  /** This building's live carries (piece → body), pruned to the ones a body is
   *  actually still walking. */
  function reflowCarriesOut(session: QuestSession, key: string): Map<string, string> {
    let out = reflowCarry.get(key);
    if (!out) {
      out = new Map<string, string>();
      reflowCarry.set(key, out);
    }
    for (const [pieceId, body] of [...out]) {
      const walking =
        (session.npcTasks.get(body)?.length ?? 0) > 0 && !!world?.state.avatars[body];
      if (!walking) out.delete(pieceId);
    }
    return out;
  }

  /**
   * WHO CARRIES IT. A house's own household comes first — rearranging your home
   * is your own business — and anyone standing about a work shell will do,
   * which is the same "everyone works together" rule the civic tasks run on.
   * Null = nobody free right now, and the sweep simply waits.
   *
   * ⚖️ ONE FREENESS, AND IT IS THE HOST'S (economy arc batch 2, L3). This used
   * to read `!npcTasks.length` and nothing else, so a body mid-pursuit, a body
   * already holding a pooled claim, and a farmhand inside its own shift all
   * read "free" and got a chest to carry. `handIsFree` is the one predicate;
   * the seats that need a body they can simply take all ask it.
   *
   * ⚖️ AND BOTH BRANCHES MEASURE (L3). The work branch hand-rolled
   * nearest-free; the household branch took the first free member BY INDEX, so
   * a house rearranged itself using whoever happened to be listed first rather
   * than whoever was standing next to the chest. Same law, both branches: the
   * NEAREST free body wins, ties by id.
   *
   * ⚖️ IT ANSWERS WITH THE WHOLE LIST (scope-unification ⑥). The pace is a
   * hand COUNT now, so the caller needs to know how many there are, not only
   * who is nearest — `[0]` is the same body the single-answer version picked.
   */
  function reflowHandsFor(session: QuestSession, buildingKey: string): string[] {
    if (!world) return [];
    /** Free bodies within `reach` of `at`, NEAREST FIRST, ties by id. */
    const nearestFree = (
      ids: Iterable<string>,
      at: { x: number; y: number },
      reach: number,
    ): string[] => {
      const near: Array<{ id: string; d: number }> = [];
      for (const id of ids) {
        const av = world!.state.avatars[id];
        if (!av || av.canOpen === false) continue;
        if (!handIsFree(session, id)) continue;
        const d = Math.hypot(av.x - at.x, av.y - at.y);
        if (d < reach) near.push({ id, d });
      }
      near.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return near.map((q) => q.id);
    };
    const hm = /^h_(\d+)$/.exec(buildingKey);
    if (hm) {
      const houseIndex = Number(hm[1]);
      const t = session.town;
      const h = t?.plan.houses.find((q) => q.index === houseIndex);
      const at = h && t
        ? { x: t.stage.center.x + h.dx + h.w / 2, y: t.stage.center.y + h.dy + h.h / 2 }
        : null;
      const ids: string[] = [];
      for (let m = 0; m < HOUSEHOLD; m++) ids.push(avatarIdOf(`resident_${houseIndex}_${m}`));
      // No town geometry to measure against (a founded-site session) ⇒ the
      // shipped index order, which is all there ever was to go on.
      if (!at) return ids.filter((id) => world!.state.avatars[id] && handIsFree(session, id));
      return nearestFree(ids, at, Infinity);
    }
    const b = pendingBuildingOf(session, buildingKey);
    if (!b || !session.town) return [];
    const c = session.town.stage.center;
    const at = { x: c.x + b.shape.dx + b.shape.w / 2, y: c.y + b.shape.dy + b.shape.h / 2 };
    const streetBodies: string[] = [];
    for (const id of Object.keys(world.state.avatars)) {
      if (id.startsWith("resident_")) streetBodies.push(id);
    }
    return nearestFree(streetBodies, at, civicRecruitRadius(session));
  }

  /**
   * PUT IT WHERE IT BELONGS — the sweep that makes the drawing come true.
   *
   * One carry per FREE HAND (see {@link reflowShareOf}): a resident walks to
   * the piece, picks it up, walks to its mark and sets it down. Two acts only,
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
    // NOBODY WAITS BEHIND A CHEST. Checked ahead of the hand census — a body
    // already stopped by something is not a thing to schedule.
    stepStrayBumps(session, key);
    // THE ASK, AND WHAT IT GOT. `hands` is what this building could put on a
    // carry right now (a body already carrying is not free, so the list
    // shrinks as its own carries go out); the town's free pool is split across
    // every asker. The ask is registered BEFORE any bail below — a building
    // that stops asking drops out of the next tick's split, and a building
    // that never asks can never be given a share it would not spend.
    const carried = reflowCarriesOut(session, key);
    const hands = reflowHandsFor(session, key);
    if (reflowShareOf(session, key, hands.length) < 1) return;
    const npcId = hands[0];
    if (!npcId) return; // nobody about to carry anything
    const task = buildingFurnishTasks(session, key).find(
      (q) => (q.act === "move" || q.act === "deconstruct") && !!q.from && !carried.has(q.from.id),
    );
    if (!task?.from) return;
    carried.set(task.from.id, npcId);
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
          carried.delete(from.id); // the hand is free again, whatever it found
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
        carried.delete(from.id); // the hand is free again, landed or not
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
      if (!isLooseProp(session, piece.id)) return null; // somebody else took it
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
    const tokenRec = session.containerRecords.get(token);
    const carriedStock = tokenRec?.stock;
    if (carriedStock && Object.keys(carriedStock).length) {
      registerContainer(session, rowId, tokenRec?.relation ?? "in", tokenRec?.owner ?? null, carriedStock);
    }
    deleteContainerRecord(session, token);
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
    // ⚖️ PULL (task #51 item 1d) — THE MARKS ARE BOOK ROWS, so the books close
    // the dead ones: a designation whose thing came down, was folded away or
    // grew below the obstruction floor. Cheap and idempotent (it returns on the
    // empty list, which is every world that never marked anything).
    stepFellOrders(session);
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
        // ⚖️ PULL (task #51 item ①, seat ⑦) — UNDER THE CAPABILITY "NO POOL ROW"
        // IS THE NORMAL STATE, not a reload seam: every haul is posted by the
        // body that decided to walk it, and none of them has a row. So the
        // re-post is retired here — but the reaper it was standing in for is
        // not. An agreement that NOBODY EVER TOOK (no executor, never began)
        // and has stood a whole claim window is a claim on goods with no
        // carrier behind it: `pileShortfall` counts its load against the bill,
        // so leaving it would answer a real shortfall with `{}` for the rest of
        // the session (the 2026-08-13 dead-haul disease, one rung earlier). It
        // EXPIRES: the row fails, its two claims go back on the shelf, and the
        // shortfall reopens for whoever next reads the bill.
        //
        // 🚫 AND IT DOES NOT SPEAK. The push model announced every expiry
        // ("no one can do that" ×42 on one frontier arc); nothing was asked of
        // anyone here, so there is no refusal to report.
        if (pullLaborOn(session)) {
          if (!a.executor && session.taskClock - a.createdAt >= DEFAULT_TASK_TTL_S) {
            session.transfers.fail(a.id, "no-executor");
            session.reservations.release(agrHolder(a.id));
            session.reservations.release(bagHolder(a.id));
          }
          continue;
        }
        const foundGlyph = (b: FoundedBuilding | undefined): string =>
          b ? (resolveStructure(structureCatalogOf(session), b.type)?.glyph ?? "yard") : "yard";
        // ⚖️ #50 ④ — the ROW this haul feeds says whether a player asked for
        // it (`spoken`, surplus control S1's own key). A re-post that dropped
        // the flag would demote a spoken bill's haul to ambient the first time
        // its task expired, which is exactly when a stalled player order most
        // needs to be at the front of the queue.
        const pileRow = a.to.startsWith(ORDER_PILE_EP)
          ? deltas.orders().find((q) => q.ord === Number(a.to.slice(ORDER_PILE_EP.length)))
          : a.to.startsWith(SITE_PILE_EP)
            ? deltas.orders().find((q) => q.ord === Number(a.to.slice(SITE_PILE_EP.length)))
            : undefined;
        const glyph = a.to.startsWith(ORDER_PILE_EP)
          ? // ⚖️ ③ ONE DEFINITION for the destination word — the same
            // `pileHaulDestWord` the staging poster uses, so a re-pooled haul
            // and its original can never announce different places (and the
            // refine arm's old `stackHead(o.produces)` — the "…to the block"
            // line — is gone from both).
            pileHaulDestWord(session, pileRow)
          : a.to.startsWith(SITE_PILE_EP)
            ? foundGlyph(deltas.founded().find((f) => f.ord === Number(a.to.slice(SITE_PILE_EP.length))))
            : a.to.startsWith(BFURN_EP)
              // §4.1 — the SHELL, not the cargo. Reading the destination off
              // `a.goods` is the very collision the shell program's own post
              // had: a re-pooled door haul announced "carry the door to the
              // door". The endpoint already names the building; ask it.
              ? shellHaulDestWord(session, a.to.slice(BFURN_EP.length))
              : "room";
        postPooledTask(
          session,
          { kind: "transfer", agreementId: a.id, goods: a.goods, to: { kind: "named", id: glyph } },
          issuer,
          { x: at.x, y: at.y, radius: civicRecruitRadius(session) },
          a.sourceGlyph ?? "bring materials",
          // ⚖️ batch 2 L1 — the RE-POST of a haul that lost its task carries
          // the same value the original post did: a pile short of its bill is
          // fully short, and the load is the agreement's own goods.
          goodsValueS(
            Object.values(a.goods).reduce((s, n) => s + n, 0),
            1,
            townFillS(session.scale),
            1,
          ),
          undefined, // `need` — unchanged: the re-post has never carried one
          rowIsSpoken(pileRow),
        );
      } else if (a.status === "moving" && a.executor && world) {
        const body = avatarIdOf(a.executor);
        const av = world.state.avatars[body];
        if (!av) {
          session.transfers.fail(a.id, "no-executor");
          haulSeenWalking.delete(a.id);
        } else if (!world.npcErrandActive(body) && !(session.npcTasks.get(body)?.length ?? 0)) {
          issueTransferHaul(session, a.executor, a.id);
          haulSeenWalking.set(a.id, { at: session.taskClock, x: av.x, y: av.y }); // re-aimed
        } else {
          const seen = haulSeenWalking.get(a.id);
          // WALKING = THE BODY MOVED, never merely "has an errand". An errand
          // that cannot advance stays ACTIVE forever, so the errand flag says
          // a trip was ordered, not that anyone is making it (measured: a
          // carrier stood on one spot for 1 400 s with `npcErrandActive` true).
          // A LOADED row is alive by definition — the goods are on the body.
          const walking =
            !seen ||
            Math.hypot(av.x - seen.x, av.y - seen.y) > HAUL_STEP_EPS_M ||
            haulIsLoaded(session, a);
          if (walking) {
            // Moving, loaded, or seen for the first time — a claimant gets one
            // whole window to get going before anything judges it
            // (`buildClaimSeenAt` seeds itself for the same reason).
            haulSeenWalking.set(a.id, { at: session.taskClock, x: av.x, y: av.y });
          } else if (session.taskClock - seen.at >= DEFAULT_TASK_TTL_S) {
            // 🚨 A CLAIM IS NOT A CARRIER (2026-08-13) — the haul twin of the
            // build-work claim rule below (`claimStale` in `workSite`). A
            // claimed transfer task NEVER expires (the pool only retires OPEN
            // rows, and the FILLED→DONE sweep completes a transfer task off
            // the AGREEMENT's status), and the re-aim above cannot fire while
            // the body still holds an errand or a queued step — so one porter
            // that took a haul and then stopped walking held BOTH the whole
            // remaining bill and the yard stock that would cover it:
            // `pileShortfall` subtracts every pending/moving row's goods, so
            // one dead 170-block row answered a 170-block shortfall with {}
            // and `postPileHauls` posted nothing for the rest of the session.
            // The site sat at 102 of a 272-block bill for 3 000 s of sim with
            // ~200 blocks in the yard, 170 of them spoken for by the dead row
            // (frontier seed 12, `say build farm`).
            //
            // A haul that has gone one whole CLAIM WINDOW without MOVING and
            // without a load is dead: it fails NAMED, exactly as the
            // unobserved twin fails an unclaimed one, and its two claims (the
            // source units and the basket) go back on the shelf — nothing has
            // left the yard, so nothing can be double-drawn. The re-post is
            // the ordinary one: `postPileHauls` finds the shortfall honest
            // again next sweep. The window is the pool's own TTL — no new
            // constant, the same "one posting cycle unanswered" the
            // build-work rule already means by it.
            session.transfers.fail(a.id, "no-executor");
            session.reservations.release(agrHolder(a.id));
            session.reservations.release(bagHolder(a.id));
            haulSeenWalking.delete(a.id);
            // ⚖️ AND IT SAYS SO. A site that quietly re-posts its own bill is
            // indistinguishable from a stalled one (the homestead report's
            // lesson, the same reason a starved pile toasts) — so the hand-off
            // is spoken once, when it happens.
            presenter.toast(
              `📦 ${a.sourceGlyph ?? "the haul"} — nobody came; calling again`,
              "feedback",
            );
          }
        }
      }
    }
    // The stamps of rows that are over (or that a reload lost) — the same
    // blind, idempotent GC the bag claims get above.
    for (const id of [...haulSeenWalking.keys()]) {
      const a = session.transfers.get(id);
      if (!a || (a.status !== "pending" && a.status !== "moving")) haulSeenWalking.delete(id);
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
    //
    // ⚖️ AND THE CREW IS SHARED (economy arc batch 2, L4). `crewShareOf`
    // answers what THIS site got out of the town's pool; off a town there is
    // no pool to share and the old union-of-willing-bodies count stands.
    //
    // WHAT SHARES IT: every order in its LABOR phase this tick — the sites
    // that would each have minted a full crew a moment ago. Order = the
    // deltas' own row order, which is founding order (ordinals are monotone
    // and never reused), so the split is deterministic across peers. Per-site
    // cap is the site's own (`REFINE_CREW_CAP` for a mill bench, otherwise
    // `BUILDERS_CAP`), and `allocateHands` conserves exactly: Σ crews is the
    // pool, never a multiple of it.
    //
    // ⚠️ THE POSTED SLOT COUNT IS NOT TOUCHED. A site still calls for
    // `BUILDERS_CAP` hands, because a REAL body that answers is conserved
    // already (one task per body) and a site that stopped calling could never
    // be found by a passer-by. The pool bounds the ABSTRACT crew — the one
    // that was being minted out of nothing.
    const crewCapOf = (o: ConstructionOrder): number =>
      o.kind === "refine" ? REFINE_CREW_CAP : BUILDERS_CAP;
    /** Did a PLAYER speak this row? Only a founded row records it (that is the
     *  only kind `orderBuild` posts); everything else is the town's own. */
    const orderIsSpoken = (o: ConstructionOrder): boolean =>
      o.kind === "found" && o.spoken === true;
    const inLaborPhase = (o: ConstructionOrder): boolean => {
      switch (o.kind) {
        case "found":
          return !o.completed && o.laborStartDay !== undefined && (o.labor ?? 0) < o.buildDays - 1e-9;
        case "refine":
          return o.laborStartDay !== undefined && (o.labor ?? 0) < o.buildDays - 1e-9;
        case "demolish":
          return !demolitionLaborDone(o);
        default:
          return !pendingLaborDone(o);
      }
    };
    let crewShares: Map<number, number> | null = null;
    const crewShareOf = (ord: number | undefined): number => {
      if (!crewShares) {
        // ⚖️ SPOKEN OUTRANKS AUTOMATED — WITHIN THE SCOPE, AND ONLY HERE
        // (order-scoping law ①, 2026-08-12). The town book is one list of
        // rows; the one thing they contend for is the shared hand pool, so
        // that is where "the player asked for this one" is allowed to mean
        // something. `allocateHands` floors everybody evenly first and then
        // pours the remainder in THIS order, so a spoken row is never a
        // starvation of the ambient ones — and when the pool covers every cap
        // (`free ≥ Σ caps`) the split is byte-identical to the unsorted one.
        // Founding order still decides among equals, so the split stays
        // deterministic across peers.
        const open = [...deltas.orders()]
          .filter(inLaborPhase)
          .sort((a, b) => (orderIsSpoken(b) ? 1 : 0) - (orderIsSpoken(a) ? 1 : 0) || a.ord - b.ord);
        const share = allocateHands(open.map(crewCapOf), townHandPool(session).free);
        crewShares = new Map(open.map((o, i) => [o.ord, share[i] ?? 0]));
      }
      return ord === undefined ? 0 : (crewShares.get(ord) ?? 0);
    };
    const clockArm = (row: { labor?: number; ord?: number }, cap: number = BUILDERS_CAP) => {
      const crew = session.town
        ? crewShareOf(row.ord)
        : Math.min(cap, availableCrew(session, issuer));
      const banked = elapsedS * CLOCK_SCHEDULE_RATE * laborRatePerS(session, crew);
      bankLabor(row, banked);
      if (banked > 0) deltas.version++;
    };
    const workSite = (
      siteId: string,
      at: { x: number; y: number },
      row: { labor?: number; buildDays?: number; ord?: number },
      rect?: { x: number; y: number; w: number; h: number },
      cap: number = BUILDERS_CAP,
    ) => {
      const tasks = [...session.taskPool.open(), ...session.taskPool.claimed()].filter(
        (t) => t.goal.kind === "buildwork" && t.goal.site === siteId,
      );
      // 🚨 A CLAIM IS NOT A BUILDER (2026-08-11). `staffed` used to mean "some
      // row says claimed", and a claimed buildwork row NEVER expires — the
      // pool's `expire` only ever retires OPEN rows, and the pool-sweep's
      // errand-ran-out completion explicitly skips `buildwork` because these
      // complete off real construction state. So one body that claimed a slot
      // and then walked off to eat held the site "staffed" forever: the
      // unstaffed timer was reset every sweep, the clock arm could never
      // engage, and `present` stayed 0 because nobody was inside
      // BUILD_WORK_EDGE_R. The site sat at its percentage for as long as
      // anyone watched it — the livelock behind "50 % worked" for ten
      // straight minutes (dx-doll-workshop / dx-doll-long).
      //
      // A claim counts as STAFFING while its claimant is present-or-arriving,
      // and a claim that has not put a body at the rect for one whole CLAIM
      // WINDOW is RELEASED back to open — where the pool's existing
      // expire/re-claim path can do its job. The window is the pool's own TTL:
      // no new constant, the same "one posting cycle unanswered" the unstaffed
      // rule already means by it.
      for (const t of tasks) {
        if (t.status !== "claimed") buildClaimSeenAt.delete(t.id);
        else if (!buildClaimSeenAt.has(t.id)) buildClaimSeenAt.set(t.id, session.taskClock);
      }
      const claimStale = (t: PooledTask): boolean =>
        session.taskClock - (buildClaimSeenAt.get(t.id) ?? session.taskClock) >= DEFAULT_TASK_TTL_S;
      for (const t of tasks) {
        if (t.status !== "claimed" || !claimStale(t)) continue;
        session.taskPool.release(t.id); // → open; the pool expires or re-claims it
        buildClaimSeenAt.delete(t.id);
      }
      // ⚖️ NOBODY LOCAL ⇒ THE CLOCK ARM (§1 step 2, the other half of the
      // locality law). With recruiting bound to the neighbourhood, a lot whose
      // own streets are empty of embodied bodies gets NO claimant — and the
      // observed arm banks only what stands at the work, so the site would sit
      // at 0 % for as long as anyone watched it. That is not honesty, it is a
      // stall: the town's crew IS working the site, they are simply abstracted
      // like everything else outside the streamer bands. So a site that goes a
      // full CLAIM WINDOW with nobody answering banks on the SAME schedule arm
      // an unwatched site has always used. The window is the pool's own TTL
      // (no new constant): one whole posting cycle unanswered is the pool's
      // definition of "no one can do that".
      // ⚖️ PULL — WHO IS STAFFING THIS WORK IS A QUESTION ABOUT BODIES, NOT
      // ROWS (task #51 item ③). Under the capability nobody was issued a slot,
      // so "staffed" cannot mean "a row says claimed": it means somebody CHOSE
      // this site's bill and is working it. Everything downstream — the
      // unstaffed window, the clock arm, `min(cap, present)` — keeps its exact
      // shape; only the source of the answer changes.
      //
      // ⚖️ AND THE 45 s WINDOW KEEPS ITS MEANING WITHOUT ITS OLD OWNER.
      // `DEFAULT_TASK_TTL_S` is the pool's constant and it stays the pool's,
      // because the non-pull path still runs — but under pull it is no longer
      // "one posting cycle unanswered" (nothing is posted): it is one whole
      // decision cycle in which NOBODY CHOSE this site. Same duration, same
      // consequence (the abstract crew takes over), an honest re-reading rather
      // than a second constant.
      const pull = pullLaborOn(session);
      const crew = pull ? contributeCrewAt(session.pursuits, siteId) : [];
      const staffed = pull ? crew.length > 0 : tasks.some((t) => t.status === "claimed");
      if (staffed || !siteStaffedAt.has(siteId)) siteStaffedAt.set(siteId, session.taskClock);
      const unstaffed =
        !staffed && session.taskClock - (siteStaffedAt.get(siteId) ?? session.taskClock) >= DEFAULT_TASK_TTL_S;
      // An unstaffed site keeps ONE standing call out (a passer-by may still
      // take it, and the moment one does the observed arm resumes) — but not
      // `cap` of them, which would be three expiries a window for a site whose
      // labor is already accounted for.
      // ⚖️ batch 2 L1 — WHAT A BUILD-WORK SLOT IS WORTH: the labour still owed,
      // in the currency labour is already measured in. `laborRatePerS` says ONE
      // builder banks `1 / dayLengthS` build-days per second, so the build-days
      // remaining on this row ARE `remaining × dayLengthS` hand-seconds — the
      // rate function inverted, not a new constant. The number was sitting on
      // `row.labor` and being discarded.
      const laborLeftS =
        row.buildDays !== undefined
          ? Math.max(0, row.buildDays - (row.labor ?? 0)) * session.scale.dayLengthS
          : undefined;
      // ⚖️ PULL (task #51 item ①, seat ⑧) — NOTHING IS POSTED. A site under the
      // capability does not call for hands; it keeps a bill, and the hands
      // decide. The loop bound below is what Stage 2 turns into SEATS.
      if (!pull) {
        for (let n = tasks.length; n < (unstaffed ? 1 : cap); n++) {
          session.taskPool.post({
            goal: { kind: "buildwork", site: siteId },
            issuer,
            focus: { x: at.x, y: at.y, radius: civicRecruitRadius(session) },
            now: session.taskClock,
            sourceGlyph: "build",
            ...(laborLeftS !== undefined ? { valueS: laborLeftS } : {}),
          });
        }
      }
      /** Is this body standing AT the work? Presence is measured from the site
       *  rect's EDGE (clamp-point), so a body a step inside the host house no
       *  longer counts as working. With no rect (a bare point site) the point
       *  itself is the edge — and for a REFINE row `at` is already
       *  `refineSpotOf`'s standable answer (the `beside()` point ~1.3 m off the
       *  crate), which is exactly where a refine dwell stands: distance 0.
       *  `orderRectOf` gives a refine row a 4 m box around that same point, so
       *  both spellings agree. */
      const atWork = (body: { x: number; y: number }): boolean => {
        const px = rect ? Math.min(Math.max(body.x, rect.x), rect.x + rect.w) : at.x;
        const py = rect ? Math.min(Math.max(body.y, rect.y), rect.y + rect.h) : at.y;
        return Math.hypot(body.x - px, body.y - py) <= BUILD_WORK_EDGE_R;
      };
      /** The BUILD LOOP animation: the sustained "play" rig — crouched over the
       *  work, limbs stroking at a spot in front (the same loop a crafter holds
       *  at the bench). Refreshed each sweep with a margin past the sweep gap,
       *  so it expires on its own the moment the builder stops standing at the
       *  site. Aim the body at the work so the stroke lands toward it, not
       *  wherever the walk finished. */
      const workPose = (npcId: string, body: { x: number; y: number; fx: number; fy: number }): void => {
        const d = Math.hypot(at.x - body.x, at.y - body.y);
        if (d > 0.3) {
          body.fx = (at.x - body.x) / d;
          body.fy = (at.y - body.y) / d;
        }
        session.needPoseShow.set(npcId, { t: elapsedS + 2, kind: "play" });
      };
      let present = 0;
      for (const cid of crew) {
        if (!world) break;
        const npcId = avatarIdOf(cid);
        const body = world.state.avatars[npcId];
        if (!body || !atWork(body)) continue;
        present++;
        workPose(npcId, body);
        // 🚫 AND NOTHING IS RE-AIMED. The claimant arm below re-issues a dwell
        // errand whenever its body runs idle, because the pool put that body
        // here and nothing else would keep it. A contribute pursuit owns its
        // own feet — the walk, the dwell and the giving-up are the BODY's
        // decisions — so a director errand pushed on top would be the invisible
        // foreman coming back in through the animation.
      }
      for (const t of pull ? [] : tasks) {
        if (t.status !== "claimed" || !t.claimedBy || !world) continue;
        const npcId = avatarIdOf(t.claimedBy);
        const body = world.state.avatars[npcId];
        if (!body) continue;
        if (atWork(body)) {
          present++;
          // THE CLAIM IS ALIVE — a body stood at the work this sweep, so its
          // window restarts. This stamp is the whole difference between "a row
          // says claimed" and "somebody is building it".
          buildClaimSeenAt.set(t.id, session.taskClock);
          workPose(npcId, body);
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
      if (unstaffed && present === 0) {
        clockArm(row, cap); // schedule-banked: the abstract crew, same rate function
        return;
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
        // ⚖️ THE FELLING PREREQUISITE (2026-09-02) — the lot is re-surveyed
        // every sweep and the felling is commissioned through the ordinary
        // material path. `blocked` holds STAGING closed (nothing is raised on
        // occupied ground) and nothing else: the bill goes on gathering in
        // parallel, because the two prerequisites are independent and making
        // one wait on the other would only make the site slower, not truer.
        const blocked = b.completed !== true && stepLotClearing(session, b, obs, issuer);
        // ADOPT a legacy no-cost row (step 3 — nothing may be its own
        // clock): stage it now and bank exactly where its old clock stood.
        // Behavior-preserving at the instant of adoption; from here on it
        // is an ordinary labor site on the observed/unobserved split.
        if (!blocked && !b.costs && b.laborStartDay === undefined) {
          const f =
            b.buildDays > 0
              ? Math.max(0, Math.min(1, (day - b.startedDay) / b.buildDays))
              : 1;
          deltas.stageOrder(b.ord, day);
          bankLabor(b, f * b.buildDays);
        }
        if (b.costs && b.laborStartDay === undefined) {
          // GATHER → STAGE (and CLEAR → STAGE: `blocked` is the lot's half of
          // the same bar — materials on the plot AND the plot to put them on).
          if (!blocked && Object.keys(stagingMissing(b)).length === 0) {
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
                  ...(b.spoken ? { spoken: true } : {}),
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
          // ⚖️ ⑤ NEVER TWO MILLS RUNNING (#50) — the stage-side half of the
          // bounded 1+1 pipeline `ensureRefineOrders` opens. A gathered batch
          // may WAIT with its raws in: the bench is busy, and a book whose
          // rows both staged would put two crews on one queue and double the
          // throughput `REFINE_CREW_CAP = 1` exists to hold at one. Holding
          // here (rather than refusing to gather) is what makes the second row
          // useful at all — its whole point is to have the materials ready the
          // instant the mill frees.
          const millBusy = refineBookOf(
            deltas,
            stackHead(r.produces),
            r.scope ?? TOWN_ORDER_SCOPE,
          ).laboring.some((q) => q.ord !== r.ord);
          const ready = Object.keys(stagingMissing(r)).length === 0;
          if (ready) {
            // Materials in and the bench free ⇒ mill. Bench busy ⇒ HOLD, and
            // say nothing: the sibling's own "milling N" toast is this book's
            // standing voice, and the row is doing exactly what a queue does.
            if (!millBusy) {
              deltas.stageOrder(r.ord, day);
              presenter.toast(
                `🪚 materials in — milling ${r.count} ${stackHead(r.produces)}`,
                "feedback",
              );
            }
          } else if (obs) {
            postPileHauls(
              session,
              {
                pileId: orderPileId(r.ord),
                at: r.at,
                missing: stagingMissing(r),
                // ⚖️ ③ A DESTINATION IS A PLACE, NEVER THE CARGO. This line
                // read `stackHead(r.produces)` — the COMMODITY — and produced
                // the user's *"I will carry the wood to the block"*
                // (`pileHaulDestWord`; diagnosis RECURRENCE CHECK (b)).
                glyph: pileHaulDestWord(session, r),
                // A chained refine stays in the book that asked for it.
                ...(r.scope ? { scope: r.scope } : {}),
                // …and keeps the standing of the bill that chained it.
                ...(r.spoken ? { spoken: true } : {}),
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
                ...(r.scope ? { scope: r.scope } : {}),
                ...(r.spoken ? { spoken: true } : {}),
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
                ...(p.spoken ? { spoken: true } : {}),
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
                ...(p.spoken ? { spoken: true } : {}),
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
        buildClaimSeenAt.delete(t.id);
        continue;
      }
      const m = /^o:(\d+)$/.exec(t.goal.site);
      const oo = m ? deltas.orders().find((q) => q.ord === Number(m[1])) : undefined;
      const rect = oo ? orderRectOf(session, oo) : null;
      if (rect && !observedRect(session, rect)) {
        session.taskPool.complete(t.id);
        buildClaimSeenAt.delete(t.id);
      }
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
    let hi = familyOf(session)?.house ?? session.town.plan.houses[0]?.index;
    let crafter: string | null = null;
    if (hi === undefined) {
      // ⚖️ #44 HOUSELESS ⇒ THE COMMUNITY SLOT (the ruled opener's craft arm):
      // a founding-age town has no household to key the job on, so it runs
      // at the camp — the crate on the community ground is the spot, and a
      // willing hand is chosen to work it (the row remembers whom). No crate
      // standing (a stockless camp) refuses through the caller's honest
      // "can't make that here".
      const at = containerAnchor(session, craftSpotOf(session, COMMUNITY_CRAFT_HI));
      if (!at) return false;
      crafter = communityCrafterCid(session, at);
      if (!crafter) return false;
      hi = COMMUNITY_CRAFT_HI;
    }
    const member = hi >= 0 ? `resident_${hi}_0` : crafter!;
    // 🚫 UNFULFILLABLE ⇒ REFUSED, ALOUD, WITH THE REASON (user law ③). Not
    // "short" — short is the ordinary honest wait this pipeline is built on.
    // Dead: no source the household can reach holds the head, and no raw that
    // refines into it is reachable either. Starting the job anyway burned the
    // house's ONE slot on work that could not begin, and said so only 90 s
    // later out of `stepCraftJob`'s starve branch.
    const spotId = craftSpotOf(session, hi);
    const spotAt = containerAnchor(session, spotId);
    if (spotAt) {
      const wantHeads: Record<string, number> = {};
      for (const [g, n] of Object.entries(recipe.consumes)) {
        const head = stackHead(g);
        wantHeads[head] = (wantHeads[head] ?? 0) + n;
      }
      const dead = deadBillHeads(
        session,
        wantHeads,
        [
          { id: spotId, stack: session.containerRecords.get(spotId)?.stock ?? {}, d: 0 },
          ...craftMaterialSources(session, hi, spotAt, spotId),
        ],
        LOCAL_PLAYER_CID,
        // #44 — a community craft's mills belong on the TOWN's own book
        // (the camp IS the commons), never a phantom `house:-1` ledger.
        hi >= 0 ? houseOrderScope(hi) : TOWN_ORDER_SCOPE,
      );
      const deadHead = Object.keys(dead)[0];
      if (deadHead) {
        const voice = refusalVoiceOf(session, speaker ?? null) ?? member;
        speakLine(session, voice, noSourceLine(stackHead(deadHead)), true);
        presenter.toast(
          `💬 can't make the ${word} — we still need ${billNames(dead)}, and there is none to fetch`,
          "feedback",
        );
        return true;
      }
    }
    const active = craftJobsOf(session).get(hi);
    // ⚖️ SPOKEN OUTRANKS AUTOMATED, WITHIN THE HOUSE (order-scoping law ①).
    // The waiting line already came first for an EMPTY slot
    // (`popQueuedCraft` before `startProgramCraft` before the rotation); what
    // it could not do was reach a slot the house had already given to its own
    // inventory rotation, so a spoken `make` queued behind a chair nobody
    // asked for. An automated job that has not begun LABOUR yields it — its
    // hauls come with it (the loads are the household's either way, and
    // dropping their claims mid-walk would be the double-spend the staging
    // sweep warns about), and its want re-derives on the next sweep
    // (`startProgramCraft` re-reads the work list every 90 s; the rotation
    // re-picks tomorrow). A job already at the bench is NOT interrupted:
    // taking the piece out of a crafter's hands is the "builds itself" bug
    // class in reverse.
    const yields = !!active && active.spoken !== true && active.laborStart === undefined;
    if (active && !yields) {
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
    if (active && yields) {
      // The yielding job's gathered units are already reserved AT the spot
      // under the house's own holder — they stay the household's, and the
      // walking loads keep walking.
      craftApproachAt.delete(hi);
      craftStarvedAt.delete(hi);
      session.townParks.delete(craftGatherParkKey(hi));
      presenter.toast(
        `🔨 the ${active.label} steps aside — the ${word} was asked for`,
        "feedback",
      );
    }
    craftJobsOf(session).set(hi, {
      ...recipe,
      spotId,
      agreements: active && yields ? active.agreements : [],
      laborS: 0,
      spoken: true,
      ...(crafter ? { crafter } : {}), // #44 — the community slot's chosen hand
    });
    if (speaker) npcChatBubble(session, speaker, "ok");
    presenter.toast(
      `🔨 making a ${word}${craftBenchOf(session, hi) ? "" : " — by hand, no workbench"}`,
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
    const syntax = session.meta.syntax;
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
    // 🚫 …BUT AN UNFULFILLABLE ONE IS REFUSED, ALOUD (user law ③, 2026-08-12).
    // The recorded divergence this closes: the BOARD gated a structure noun on
    // affordability while `orderBuild` refused nothing, so a poor town lost
    // building words off the child's board and the same sentence, spoken, still
    // staked a plot that could never rise. The board now shows what can be SAID
    // (quest-host's noun push demotes instead of hiding) and the ORDER refuses
    // what cannot be BUILT — both halves of the question, answered the same way.
    // "Dead" is strictly narrower than "short": see `deadBillHeads`.
    const deadBill = deadBillHeads(
      session, missing, siteMaterialSources(session, lotAt, issuer), issuer,
    );
    const deadHead = Object.keys(deadBill)[0];
    if (deadHead) {
      const voice = refusalVoiceOf(session, speakerFor);
      if (voice) speakLine(session, voice, noSourceLine(stackHead(deadHead)), true);
      presenter.toast(
        `💬 can't build the ${spec.label} — we still need ${billNames(deadBill)}, and there is none to fetch`,
        "feedback",
      );
      return true;
    }
    // 🚫 …AND AN IMPOSSIBLE ONE IS REFUSED THE SAME WAY (②a, homestead-defect
    // round). Between dead and slow sits the state the founding worlds
    // exposed: sources EXIST, but stock + loose units + the whole standing
    // chain cannot reach the bill, so pipeline ⑥'s honest wait would be a
    // forever-treadmill (measured: a 120-block house over eight oaks). The
    // refusal names both numbers — the player can see how far the land falls
    // short, fell what stands, and order again when the world has more.
    const wholeBill: Record<string, number> = {};
    for (const [g, n] of Object.entries(structureCosts(spec))) {
      const head = stackHead(g);
      wholeBill[head] = (wholeBill[head] ?? 0) + n;
    }
    const shortWorld = infeasibleBillHeads(
      session, wholeBill, siteMaterialSources(session, lotAt, issuer), issuer,
    );
    const shortEntry = Object.entries(shortWorld)[0];
    if (shortEntry) {
      const [head, gap] = shortEntry;
      const voice = refusalVoiceOf(session, speakerFor);
      if (voice) speakLine(session, voice, noSourceLine(stackHead(head)), true);
      presenter.toast(
        `💬 can't build the ${spec.label} — it needs ${gap.need} ${head} and everything within reach comes to ${gap.have}`,
        "feedback",
      );
      return true;
    }
    if (!explicitBuilder) {
      // UNTARGETED → the ①a TASK POOL: any appropriate creature in the
      // focus area may claim it (stepTaskPool's build capability check).
      // The task records the SAME focus that steered the lot ranking, so
      // the claimant's lot choice lands where the order was aimed.
      const posted = steerAt
        ? postPooledTask(
            session,
            { kind: "build", structure: spec.type, cap: 1 },
            issuer,
            steerAt,
            sentence,
            undefined, // `valueS` — unchanged: this poster has never priced one
            undefined, // `need` — a SPOKEN order; authority answers (#45)
            // ⚖️ #50 ④ — the player said this sentence out loud; it outranks
            // the town's ambient errands in the pool.
            true,
          )
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
      // 🚨 A SPOKEN ORDER REFUSES VOCALLY OR IT DID NOT REFUSE (the standing
      // law; S&D closing sweep 2026-08-12). This arm used to bubble and
      // nothing else — and a bubble is not a channel: `sayNpcLine` hangs
      // NOTHING when the nominated body has no poser point (off-view, not
      // streamed, an inert species), so an order handed to such a creature
      // vanished without the pooled task, the zoning refusal OR the honest
      // "can't build here" — the worst of the three. Every OTHER refusal in
      // this function toasts as well as speaks (see the dead-bill arm above);
      // this one now does too, and it NAMES the creature, because "someone
      // said no" with no bubble on screen is the same silence in slower
      // clothes.
      npcChatBubble(session, explicitBuilder, placementWontLine()[syntax]);
      presenter.toast(`💬 can't build the ${spec.label} — the one you asked won't`, "feedback");
      return true;
    }
    const walker = explicitBuilder === possession.creatureId ? null : explicitBuilder;
    const b = executeBuildOrder(session, spec, candidates[0]!, walker, issuer);
    if (!b) {
      presenter.toast(`💬 "${sentence}" — can't do that here`, "feedback");
      return true;
    }
    // ⚖️ A PLAYER SPOKE THIS ROW (order-scoping law ①). Stamped HERE rather
    // than threaded through `executeBuildOrder` because this is the only
    // caller that is a player order — every other one is the town growing.
    // Within the town book it buys first call on the shared crew, nothing
    // more (see `crewShareOf`); it never reaches into another scope's book.
    b.spoken = true;
    // THE ACCEPTED ORDER SPEAKS. A bare "ok" is right when the order can start
    // — nothing is outstanding. When it is STAKED AND SHORT, the builder names
    // what the structure is waiting on instead ("the house needs more blocks"):
    // the shortfall was only ever a toast, so a glyph reader was told the order
    // was accepted and never told why nothing then happened. `need` is the verb
    // that makes it a request rather than an assertion about where the blocks
    // already are.
    const shortHead = Object.entries(missing)[0];
    // ⚖️ …AND WHAT IS STANDING ON IT IS NAMED FIRST (2026-09-02). A lot with a
    // tree on it is ACCEPTED and STAKED; what a glyph reader needs to hear is
    // why nothing is happening yet, and "we still need blocks" would be a true
    // sentence about the wrong obstacle. The blocking noun is NAMED, the
    // `zoneRefusalLine` shape — never a bare "no", which this is not.
    const blocked = clearingPending(b);
    const blockerWord = blocked ? blockerWordOf(session, b) : null;
    if (walker && speakerFor) {
      if (blocked) {
        // A word for it if the board has one, else the geometric truth — a lot
        // with a boulder on it really is a place too small for the house.
        npcChatBubble(
          session,
          walker,
          blockerWord
            ? clearFirstLine(spec.glyph, blockerWord)[syntax]
            : placementCannotLine(spec.glyph, "service")[syntax],
        );
      } else if (b.laborStartDay === undefined && shortHead) {
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
      blocked
        ? `🪓 the ${spec.label} is staked out — the ground must be cleared first`
        : b.laborStartDay !== undefined
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
   * growth never stacks a second one while the first rises.
   *
   * Returns (world coords) the stranded household whose doorstep costs the
   * quarter the FEWEST street metres of recurring walking — the districts.ts
   * twin (growth phase C §1.4), not a chord centroid. A centroid of two
   * stranded arms lands in the fields between them and steers the new market
   * at open ground nobody walks past; the argmin lands ON the arm that is
   * actually short of a shop.
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
    const stranded: Array<{ door: { x: number; y: number }; at: { x: number; y: number }; w: number }> = [];
    for (const h of t.plan.houses) {
      const d0 = houseDoorstep(origin, h);
      let d = Infinity;
      for (const a of anchors) d = Math.min(d, roadDistance(t.plan.streets, d0, a));
      if (d <= R) continue;
      const w = Math.min(2, d / R - 1);
      mass += w;
      stranded.push({ door: d0, at: { x: h.dx + h.w / 2, y: h.dy + h.h / 2 }, w });
    }
    if (mass <= 0 || stranded.length === 0) return null;
    // THE TIME TAX (§1.4): steer at the stranded doorstep that minimizes the
    // quarter's total mass-weighted STREET metres. House order is plan order
    // (prefix-stable) and only strict improvements win, so ties fall to the
    // earliest lot — deterministic, like every other placement read here.
    let best = stranded[0]!;
    let bestCost = Infinity;
    for (const c of stranded) {
      let cost = 0;
      for (const q of stranded) {
        if (q === c) continue;
        cost += q.w * roadDistance(t.plan.streets, q.door, c.door);
      }
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return {
      deficit: Math.min(1, mass / NEIGH_FOUND_MASS),
      at: { x: t.stage.center.x + best.at.x, y: t.stage.center.y + best.at.y },
    };
  }

  /**
   * NEED-STEERED AUTO-FOUNDING (③ + city-founding), once per credited
   * town day: URGENT need (homeless souls, real shortage) founds at once;
   * otherwise the town banks its own REAL SURPLUS (S&D S1 — production above
   * committed demand; it used to bank the mean household signal) and a
   * banked threshold founds the
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
    // ⚖️ THE DAY'S TOWN GAIN — THE TOWN'S OWN REAL SURPLUS (S&D S1; growth
    // motive law ②). This was the MEAN HOUSEHOLD GAIN, which made the town's
    // bank a second reading of household satiety; the household rung now has
    // its own honest derivation (`prosperitySignals`), so the town gets ITS
    // rung's: production ABOVE committed demand, straight off the books
    // (`townSurplus` — got vs need PLUS what an export lane is owed), averaged
    // over the goods the town keeps books on and expressed as a fraction of a
    // full day's accrual.
    //
    // A town that merely MEETS its demand banks nothing. That is the whole
    // law: there is no surplus to spend, so nothing non-urgent is founded, and
    // a content town goes quiet. URGENT need (URGENT_CROWDING /
    // URGENT_SHORTAGE, inside foundingGrowthStep) bypasses the bank exactly as
    // before — survival was never funded by prosperity.
    let surplusSum = 0;
    let bookN = 0;
    for (const f of t.eco.fills) {
      surplusSum += Math.min(1, townSurplus(session, f.good));
      bookN++;
    }
    const bookSurplus = bookN ? surplusSum / bookN : 0;
    // 🚨 THE FLAT-CAP NO-HOUSES ARM IS DEAD (S&D S1). It read: a settlement
    // with people but no households accrues at the DAILY CAP — i.e. a camp
    // with nothing but a population scalar funded a workshop out of thin air,
    // the purest form of growth-for-free on the map. A HOUSE-LESS CAMP ACCRUES
    // 0. It is not frozen: a homeless population is URGENT crowding, and
    // urgent founds without any bank at all, so the camp still raises its
    // first houses — and once it has households and a surplus, it banks.
    const gain = t.plan.houses.length ? bookSurplus * FOUNDING_PROSPERITY_DAILY_CAP : 0;
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
      // ⚖️ AND IT MAY ONLY START WHAT THE SPARE COVERS (surplus control S2).
      // The town's ambient founding is the loudest automated appetite there is
      // — one workshop's ≈198-block bill reserves everything a yard has — so
      // the stock it prices itself against is the free yard MINUS the commons
      // reserve. Growth is not stopped, it is made to wait for a surplus,
      // which is the addendum's own diagnosis of the fault.
      reserve: (head) => commonsReserveOf(head, session.scale.resourceCompression),
      // ⚖️ …AND IT PRICES THE CHAIN AT THE MILL'S RATIO, not the catalogue's
      // (`effectiveInPerOut`). A live session HAS a dial; the kernel's default
      // of 1 is for the worldgen twin and the fixtures, not for the town the
      // player is standing in.
      conversionDial: session.scale.resourceCompression,
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
        //
        // Measured BY STREET (§1.4): the deficit point was earned by counting
        // street metres, so the lots ranked against it are too. Passing the
        // session is what turns `near` from a chord into a walk; the other
        // callers steer at ground the PLAYER pointed at, which is a claim
        // about a place and not about a journey, and they keep the chord.
        const near = spec.type === "market" && svc ? steeringNear(ctx, svc.at) : undefined;
        const cands = buildCandidates(ctx, spec, near ? { near, session } : undefined);
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
        conversionDial: session.scale.resourceCompression,
        furnStock: (glyph) => {
          let n = 0;
          for (const objId of houseContainerKeys(session, house.index)) {
            n += session.containerRecords.get(objId)?.stock?.[glyph] ?? 0;
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
          conversionDial: session.scale.resourceCompression,
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
    const locale = session.meta.locale ?? "en";
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
    const locale = session.meta.locale ?? "en";
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
    // ⚖️ A PLAYER ORDERED IT (surplus control S1) — the one thing that
    // separates this from the daily prosperity spend, which shares every
    // other line of `stakeAnnex`.
    return stakeAnnex(session, houseIndex, cluster, candidate, { spoken: true });
  }

  /**
   * ⚖️ CAN THE COMMONS SPARE AFFORD THIS ROOM? — the AUTOMATED annex launch
   * gate (surplus control S2), handed to `constructionStep` so it is asked
   * BEFORE the household's banked threshold is spent.
   *
   * The reading is `foundingGrowthStep`'s own, one rung down: the yard's
   * unreserved stock, minus the commons reserve, WITH refinable credit (a
   * block bill is honestly payable out of wood — that is the chain). So the
   * wood floor is what bites here even though a room's bill is in blocks, and
   * it bites in exactly the way the addendum describes: a town whose whole
   * woodpile is spoken for stops ordering rooms instead of staking plots
   * nobody can stock. A player's `build bedroom` never reaches this — it goes
   * through `orderAnnex`, which is spoken, and designations never refuse (⑥).
   */
  function annexWithinSpare(
    session: QuestSession,
    candidate: AnnexCandidate | InteriorCandidate,
  ): boolean {
    const t = session.town;
    if (!t) return true;
    const dial = session.scale.resourceCompression;
    const free = unreservedStock(t.deltas.stock, t.deltas.reservations, TOWN_YARD_EP);
    return costsMet(
      { costs: roomOrderCosts(candidate, dial) },
      withRefinableCredit(spareStock(free, (head) => commonsReserveOf(head, dial)), dial),
    );
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
     *  below must not answer it somewhere else.
     *
     *  ⚖️ `spoken` (surplus control S1) — a PLAYER-ordered room, so its
     *  staging may draw the commons reserve. The daily prosperity spend
     *  passes neither, and draws SPARE only. */
    opts?: { pinned?: boolean; spoken?: boolean },
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
    const costs = roomOrderCosts(candidate, session.scale.resourceCompression);
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
      ...(opts?.spoken ? { spoken: true } : {}),
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
        ...(opts?.spoken ? { spoken: true } : {}),
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
    for (const [objId, rec] of looseEntries(session)) {
      const kind = furnitureKindOfGlyph(rec.glyph!);
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
    const dest = destId ? (session.containerRecords.get(destId)?.stock ?? {}) : t.deltas.stock;
    for (const [kind, n] of Object.entries(stowed)) {
      const g = furnitureGlyph(kind as StationKind);
      dest[g] = (dest[g] ?? 0) + (n ?? 0);
    }
    for (const [g, n] of Object.entries(refund)) dest[g] = (dest[g] ?? 0) + n;
    for (const boxId of removedBoxes) {
      const stock = session.containerRecords.get(boxId)?.stock;
      if (!stock) continue;
      for (const [g, n] of Object.entries(stock)) dest[g] = (dest[g] ?? 0) + n;
      delete session.containerRecords.get(boxId)!.stock; // stock ONLY — relation/owner untouched, as before
    }
    if (destId) setContainerStock(session, destId, dest);
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
    const pieceRec = session.containerRecords.get(pieceId);
    const contents = pieceRec?.stock;
    if (prop && contents && Object.keys(contents).length) {
      registerContainer(session, prop, pieceRec?.relation ?? "in", pieceRec?.owner ?? null, contents);
    }
    deleteContainerRecord(session, pieceId);
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
    conversionDial = 1,
  ): Record<string, number> {
    const am = /_a(\d+)$/.exec(room.id);
    const a = am ? (delta?.annexes ?? []).find((x) => x.ord === Number(am[1])) : undefined;
    if (a) return annexCosts(a, conversionDial);
    const im = /_i(\d+)$/.exec(room.id);
    const i = im ? (delta?.interior ?? []).find((x) => x.ord === Number(im[1])) : undefined;
    if (i) return interiorCosts(i, conversionDial);
    return baseRoomCosts(room.rect, conversionDial);
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
    ).concat(generated.filter((g) => hasStock(session, g.id)).map((g) => g.id));
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
      const teardown = roomTeardownCosts(
        t.deltas.get(p.buildingKey),
        room,
        session.scale.resourceCompression,
      );
      for (const [head, n] of Object.entries(teardown)) {
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
    const costs = interiorCosts(candidate, session.scale.resourceCompression);
    const missing = buildMissingMaterials(session, { costs }, at, issuer);
    const missingNames = Object.entries(missing).map(([g, n]) => `${n} ${g}`).join(", ");
    const p = t.deltas.postAnnexSite({
      buildingKey: key,
      candidate,
      costs,
      pile: {},
      startedDay: buildDayNow(session),
      buildDays: constructionGameDays(ANNEX_BUILD_DAYS, session.scale),
      // ⚖️ ALWAYS A PLAYER'S CUT (surplus control S1) — `orderWorkRoom` has no
      // ambient caller, so a shell's subdivision may draw the reserve.
      spoken: true,
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
        spoken: true,
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
    return (
      (withRefinableCredit(free, session.scale.resourceCompression)[BLOCK_GLYPH] ?? 0) > 0
    );
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
    // ⚖️ THE ONE "how far is that, really" RULE (economy arc W1). Born here for
    // the site bill, but it is not a construction fact: it is what a WALK
    // measures, and a body that PRICES a leg by chord while PAYING street buys
    // a 68 m bargain and walks 400 m of plaza detour. The host's plan pricer
    // and its bag fetch now read the same number — through this handle, so the
    // coordinate-pair memo (and its street-net invalidation) stays ONE cache.
    sourceDistanceM,
    buildContext, buildSpotsNow, cancellableSite, cancelWork, structureLabelOf,
    structureCatalogOf, buildMissingMaterials, pendingGrowthRects,
    steeringNear, buildCandidates, buildworkSiteAt, foundedLotAt,
    pendingAnnexAt, pendingBuildingOf, agrHolder, bagHolder, onTransferLanded, buildDayNow,
    isCivicStockDest,
    // ⚖️ OCCUPIED GROUND, for the GROWTH CLOCK (user ruling 2026-09-02:
    // *"trees won't grow if a building is already there"*). The clock lives in
    // the host; the answer to "is a building already there" is the SAME one
    // the builder used to decide the lot was occupied, and it is handed out
    // rather than re-derived so a second occupancy notion can never appear.
    standingFootprints,
    // …and the threshold's own two readers, for the same reason: a sub-floor
    // seedling must read as "not there" to the spawner's solidity and to the
    // clock exactly as it does to the builder.
    standingBlockers, lotClearingNow,
    // ⚖️ PULL (task #51 item 1d) — the lot's own bills, for a puller (1a's
    // REQUEST 2). Under the capability the clearing posts an agreement nobody
    // is executing and leaves the tree standing; this is how a body finds it.
    // Exported rather than re-derived because "which trees did the builders
    // stake, and what is already spoken for" is the BOOKKEEPER's answer.
    clearingBills,
    // …and WHERE A LOOSE GOOD BELONGS (item 1e): the same shelf a felled lot's
    // timber lands on. "Put it away" and "carry it off" must not disagree
    // about where away is, so there is one function and both read it.
    clearingDepositId,
    // The mark sweep: a designation whose thing is gone or already down is a
    // dead row, and dead rows are the bookkeeper's to retire.
    stepFellOrders,
    // THE BLOCK CHAIN's two decision points (phase 5's masonry split): WHERE a
    // raw is worked, and WHICH raw gets worked first. Everything else in the
    // chain is the ordinary order loop, already reachable through the step
    // functions above; these two are pure lookups over the town plan that no
    // exported path exposes, and the routing they decide is invisible from
    // outside until a hauler has already walked to the wrong bench.
    refineSpotOf, ensureRefineOrders,
    // ⚖️ PULL-MODEL LABOR (task #51) — the ONE site-id spelling (`o:<ord>`,
    // founded / annex / refine rows alike) that `workSite` keys presence on.
    // A body issuing itself a slice writes it into `ContributeBill.siteId`
    // through this handle, so the bookkeeper's presence count and the
    // puller's bill can never disagree about which site a body is working.
    orderSiteId,
    // ⚖️ …and the NON-RESERVING reach read the bookkeeper decides the chain on
    // (task #51 item ①). Exported so the body sizing its own slice measures the
    // same free stock the books did: the number that says "a mill is needed" and
    // the number that says "I can carry some of that" must be one number, and
    // neither side may RESERVE by asking it.
    freeHeadStockWithinReach,
    // THE REFUSAL'S ONE TEST (order-scoping round, law ③): SLOW vs DEAD. Pure
    // over the live stacks, and the whole difference between an honest
    // designation that waits and an order refused aloud — so it is pinned
    // directly rather than only through the two order verbs that call it.
    deadBillHeads, siteMaterialSources,
    // 🚫 #43 ②a — the third refusal state (dead < IMPOSSIBLE < slow), pinned
    // directly for the same reason deadBillHeads is; and ②b's release arm,
    // whose receive-hold and co-located-ledger laws are invisible from
    // outside until porters are already circling a crate.
    infeasibleBillHeads, releaseStarvedPile,
    // §1's third decision point: WHICH HOUSEHOLD makes a shell's piece. A pure
    // lookup over the town plan, invisible from outside until somebody's mother
    // has already been put to work on a door across town.
    craftHouseholdFor,
    // §4.1's decision point: WHAT WORD a shell's furniture haul walks toward.
    // Pure over the town plan, and invisible from outside until a hauler has
    // already announced that it is carrying the door to the door.
    shellHaulDestWord,
    // ⚖️ …and the SAME decision for a STAGING haul (task #51, 1b's R2). Its own
    // law is "ONE definition for all four order kinds, so the staging poster and
    // the reload re-pool can never drift apart on it" — and a self-issued slice
    // is now a THIRD arm naming that destination. Exported rather than
    // re-derived, or a puller would announce a place the books never called it.
    pileHaulDestWord,
    executeBuildOrder, stepFoundedConstruction, stepFurnitureSetup,
    orderCraft, orderBuild, orderZone, stepZonedFounding,
    structureFocusOf, structureActsFor, structureConstructionOptions, structureFurnishOptions,
    orderAnnex, stakeAnnex, orderDemolish, orderWorkRoom, orderWorkDemolish,
    // ⚖️ SURPLUS CONTROL's launch gate for the ambient annex (S2). `stakeAnnex`
    // itself cannot host it — `constructionStep` has already spent the
    // household's threshold by the time it calls — so the predicate is handed
    // UP to the step that does the spending. Exported (rather than only
    // reachable through the day tick) because it is the one place the reserve
    // meets the room bill, and a pin on it is a pin on the whole gate.
    annexWithinSpare,
    // PHASE 4 — the removal verbs (empty a room, break one piece).
    orderEmpty, orderWorkEmpty, orderBreakPiece,
  };
}
