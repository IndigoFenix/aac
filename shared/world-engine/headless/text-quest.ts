// shared/world-engine/headless/text-quest.ts
//
// THE HEADLESS BOOT — `bootTextQuest` stands up the SAME dollhouse session the
// shipped game boots (games/dollhouse/src/quest-boot.ts `bootLivingTown`), with
// the rendering surface swapped for the text view and the frame pump swapped
// for a hand-cranked clock. text-mode.md law ⑥: BYPASS THE PIXELS, NEVER THE
// SIM. Every sim-relevant step of that boot is replicated here, in order:
//
//   ① loadWorldManifest(structuredClone(raw), [ECONOMY_MODULE])
//   ② THE SCOPE DISPATCH  →  { spec, play, focus }: `buildTownScope` for a town
//      document, `buildPlanetScope` for a solar document declaring a founding
//      premise (the planet arm — see the block below), then ONE read of what
//      the ground says (`SiteEnvironment`, measured or declared)
//   ③ spirit flag (avatarKind), session scale, culture, dollhouse focus index
//   ④ createQuestHost3D({ view, presenter, voice: null, scheduleFrame, now,
//      npcRng, tradePartners?, groundAt?/waterAt? })
//   ⑤ host.start(bundle.game, play, { spirit, dollhouse, wilderness, scale,
//      culture, climate? })
//   ⑥ the TEXT CAMERA — the three SIM effects of the spirit ladder's structure
//      rung, and nothing else (see `applyCamera` below).
//
// ── DELIBERATELY NOT REPLICATED (render/chrome only) ────────────────────────
// Everything the browser boot does that a frame of simulation cannot see:
//   • `resolveImage` / glyph rasters — artwork for buttons that do not exist;
//   • the board-island claim, the toast/objective/satchel DOM, the win card;
//   • `ResizeObserver` (the seam declares a fixed viewport instead);
//   • the AIM ARBITRATION between a native pointer and the forwarded gaze
//     stream — there is exactly one input here, `look()`;
//   • `__questLab` / `__questLab_pose` / `__spiritLadder` window globals;
//   • the spirit LADDER object itself (its camera poses, blends, orbit dwell,
//     rung ascent/descent) — a text camera is STATIC, which is also what makes
//     resident streaming deterministic;
//   • crowd-budget / creature-tier LOD levers (render fidelity, per camera);
//   • multiplayer (`QuestHostDeps.multiplayer`) — one local player here;
//   • `groundAt` / `waterAt` samplers — the seat is wired (the environment
//     record carries them where a producer has a surface), but a MEASURED
//     headless record carries none: the headless ground seam is flat, and it
//     says so rather than inventing relief no frame would render.
//
// No React, no DOM, no games-bridge. The view is type-only where it can be.

import { hashSeed, mulberry32 } from "@shared/prng.js";
import type { WorldState } from "../engine.js";
import { avatarKind, loadWorldManifest } from "../kernel/manifest.js";
import { ECONOMY_MODULE } from "../kernel/modules/economy/index.js";
import {
  createQuestHost3D,
  type QuestBoardView,
  type QuestHost3D,
  type QuestPresenter,
  type QuestSession,
  type QuestViewSeam,
} from "../interaction/quest/quest-host.js";
import type { LedgerWarpResult } from "../interaction/quest/clock-warp.js";
import {
  homesteadWildMix, wildMixForBiome, type WildMixEntry,
} from "../interaction/quest/wilderness.js";
import type { ClimateSample } from "../products.js";
import { buildTownScope, type BuiltTownScope } from "../interaction/town/town-play-game.js";
import {
  buildPlanetScope, buildRegionScope, declaredEnvironment,
  type PlanetScope, type RegionScope, type SiteEnvironment,
} from "../interaction/town/planet-scope.js";
import type { TownPlay } from "../interaction/town/town-play.js";
import { buildClusterWindow } from "../interaction/town/town-cluster.js";
import type { SerializedTownDeltas } from "../kernel/town/construction.js";
import { FOUNDING_AGE_DAYS } from "../kernel/town/plan.js";
import { DOLLHOUSE_SCALE, resolveWorldScale, type WorldScale } from "../scale.js";
import { resolveSkillCatalogue } from "../kernel/town/skills.js";
import { PLAYER_ID } from "../solver/space3d.js";
import {
  WIDE_TICK_INNER_STEP_S,
  WIDE_TICK_MAX_FRAME_S,
  type WideTickConfig,
} from "../world-host.js";
import { createTextWorldView, type TextFocusFrame, type TextWorldView } from "./text-world-view.js";

// ── 🌍 THE PLANET ARM, HEADLESS (planet-boot round S2, 2026-09-10) ──────────
//
// ⚖️ THE USER'S LAW: *"Why can't text mode boot a planet world with cities
// streamed as partners? Text mode isn't supposed to be different from visual
// mode except for the visual rendering."*
//
// 🚨 WHAT THIS REPLACED. `bootTextQuest` used to refuse every scope but `town`,
// and the planet world was faked in two places at once: a TOWN document
// wearing `terrain: "planet"` stood in for the founding premise, and four
// HAND-WRITTEN CONSTANTS in this file stood in for its cell (a wet temperate
// wood: rain 1.0, 12 °C, `eco.tree` 0.35 ⇒ 15.05 oak/ha, a bush·apple·carrot·
// hazel larder). The world the browser actually bakes has none of that. Its
// founding cell is 12755 — a TROPICAL highland forest at 28.4 °C, `eco.tree`
// 0.24 ⇒ 10.32 oak/ha, whose only cultivar is the banana — so every headless
// measurement of "the frontier planet" was taken in a world that does not
// exist, and the whole PART 4 §6 forage forecast rested on the gap.
//
// 🌍 SO THE PLANET ARM IS THE ENGINE CALL. A `scope: "solar_system"` document
// declaring a founding premise boots through `interaction/town/planet-scope.ts
// buildPlanetScope` — the ONE definition the browser's own mount calls (S3):
// bake the home body, found on its forest cell, deposit the kit, measure the
// charter/climate/biome/ecology, found the cities, lay the roads, project the
// nearest three into town coordinates as trade partners. Nothing here samples,
// guesses or re-derives; this file dispatches and wires seats.
//
// 📜 …AND THE SECOND PRODUCER IS THE DOCUMENT ITSELF. A planet bake is 24–29 s,
// which no suite that only wants a founding CAMP should pay, so the same record
// can be DECLARED as town-document fields (`climate`/`biome`/`eco`/`charter`/
// `partners` — town-play-game.ts `CELL_FIELDS`) and read back by
// `declaredEnvironment`. `scripts/worlds/frontier-cell.spec.json` is that
// document, GENERATED from the real planet (`npm run world:lower --
// --declare-cell`), so the cheap path and the real path describe one cell.
//
// ⚠️ `terrain: "planet"` NO LONGER SUMMONS A CELL. It is what it always said it
// was — the ground character (`TownPlayConfig.terrain`) — and a town document
// that declares it without declaring a cell now scatters from the CHARTER arm
// like every other town document. That is a behaviour change for exactly one
// shipped document, the old hand-written `frontier-planet.spec.json`, which
// this round replaced. `frontier.spec.json` and `homestead.spec.json` declare
// no terrain at all and are byte-identical.
//
// WHERE THE RECORD LANDS (`SiteEnvironment`, one shape, wired once):
//   • `climate` TWICE — `TownPlayConfig.climate` (the books' farm yield) and
//     `host.start({climate})` (the live farm). The same sample to both, or the
//     abstract farm and the visible farm size the same ground differently.
//   • `biome` + `eco` through the WILDERNESS MIX (`wildMixForBiome`) — and
//     `perHa` is the predicate that decides whether the near-stand disc binds
//     and whether the neighbouring tiles MINT (quest-host: `mix.some(e =>
//     e.perHa !== undefined)`), so this is the difference between a countryside
//     and an authored stand.
//   • `partners` through `deps.tradePartners`.
//   • `ground` through `deps.groundAt`/`waterAt` — a MEASURED headless record
//     carries none (the headless ground seam is flat and says so); the seat is
//     live for the browser producer.

// ⚖️ kept exported for the resource-packing lane's temperate calibration anchor
// (2026-09-10); no boot path reads them — the planet/declared arms measure the
// real cell; deleted when that lane lands (planet-boot S4).

/**
 * THE FOUNDING CELL, headless — the ONE sample behind every planet-arm text
 * measurement, and deliberately a LITERAL rather than a bake.
 *
 * A headless boot has no `CellGrid`, so `climateSampleAt` has nothing to read;
 * these are the measured values of the cell the founding premise seeds on
 * (a wet temperate forest), in the substrate's own units and the same shape
 * `climateSampleAt` builds. Cross-checked, not invented: the pair reproduces
 * `near-stand.test.ts` ⑥'s 54 oaks on the 190 m rect and the forest-cell larder
 * PART 4 §6 forecasts closed-form (bush×4 · apple×2 · carrot×1 · hazel×5).
 */
export const PLANET_CELL_CLIMATE: ClimateSample = {
  rain: 1.0, tempC: 12, elevation: 5, fertility: 8, ore: 2,
};

/** …and its per-species abundance (`planet/ecology.ts ecoAbundanceAt`, 0..1).
 *  `tree` 0.35 ⇒ 15.05 oak/ha — the same constant `near-stand.test.ts` pins the
 *  measured founding cell at. */
export const PLANET_CELL_ECO: Readonly<Record<string, number>> = {
  tree: 0.35, grass: 0.02, horse: 0,
};

/** The founding premise seeds at a FOREST-biome cell (`main.ts
 *  stepFoundingPremise`) — DEFAULT_BIOSPHERE order, 1 = forest. */
export const PLANET_CELL_BIOME = 1;

/** The scatter a headless boot on planet ground uses — the browser's own line
 *  (`wildMixForBiome` with a climate AND an eco field, i.e. `perHa`). */
export function planetCellWildMix(seed: number): WildMixEntry[] {
  return wildMixForBiome(PLANET_CELL_BIOME, seed, PLANET_CELL_CLIMATE, PLANET_CELL_ECO);
}

/**
 * WHERE THE TEXT SESSION WATCHES FROM. A text camera is STATIC by design: it
 * never orbits, never blends and never changes rung, so the reveal set (and
 * therefore which residents the town streamer embodies) is a pure function of
 * the sim — which is what makes two same-seed runs identical.
 *
 *   • `dollhouse` — the shipped game's opening: the spirit parked at the focus
 *     house, its interior on show, the rest of the town sealed.
 *   • `town` — the whole-world stationary spirit: every ACCESSIBLE room on
 *     show, no focus frame.
 *   • `follow` — ride one creature. Minimal on purpose (step ⑨ owns movement):
 *     interiors reveal only while that creature is actually possessed, which is
 *     the ladder's own rule (`possessedNow || level === "structure"`).
 */
export type TextCamera =
  | { kind: "dollhouse" }
  | { kind: "town" }
  | { kind: "follow"; creatureId: string };

export interface TextQuestOpts {
  /** The PARSED world document (the object `game.spec.json` holds). Cloned
   *  before loading, exactly as the game's `loadSpec` does — `loadWorldManifest`
   *  mutates/normalizes what it is handed. */
  world: unknown;
  /** Seed for the injected NPC RNG. Default: the town document's own
   *  `config.seed`, so a run is reproducible from the document alone.
   *
   *  ⚠️ IT IS THE NPC RNG AND NOTHING ELSE. The WORLD's seed is the document's:
   *  the town plan, the residents, the quests and the scatter are all built
   *  from `play.config.seed` before this value is read, and on the planet arm
   *  the substrate is not seeded by the document at all (the home system's seed
   *  is a constant — `buildPlanetScope`). So `--seed 11` on the frontier planet
   *  plays the SAME planet and the SAME camp as `--seed 1337` with a different
   *  fold of NPC chatter, and a run that changes more than that has a bug. */
  seed?: number;
  /** Fixed frame step, seconds. Default 1/60 (text-mode.md D4).
   *
   *  ⏩ UP TO 0.5 — THE WIDE TICK (wide-tick-round.md W-②). Above 0.05 the boot
   *  turns on the world host's substep seam: the motion arms integrate at
   *  ≤ `innerStepS` each while the quest layer decides ONCE per frame, so a
   *  wide dt buys sim seconds per wall second instead of quietly shortening
   *  them (before the seam, the host clamped its own dt at 0.05 and a caller's
   *  wider step was a no-op that undercounted elapsed sim time). A wide run is
   *  NOT byte-identical to 1/20 — decisions are coarser; beats are the
   *  acceptance test (`scripts/wide-tick-ab.ts`). */
  dt?: number;
  /** ⏩ Seconds of MOTION per inner substep under a wide `dt`. Default 0.05 —
   *  today's frame budget. The seam's tuning parameter, not a user dial: raise
   *  it only with the A/B comparator's beats in hand. Ignored at dt ≤ 0.05. */
  innerStepS?: number;
  /** Default `{ kind: "dollhouse" }` — the shipped game's opening camera. */
  camera?: TextCamera;
  /** Clock origin in ms. Default 0. */
  startMs?: number;
  /** Per-frame hook, forwarded to the view's `onRender` (the projection's
   *  frame seam). Fires after the reveal cache is fresh. */
  onRender?: TextWorldViewOnRender;
  /**
   * 🌲 THE SCATTER MIX, overridden — the ONE thing a text boot could not say.
   *
   * The default is the charter arm (`homesteadWildMix`, absolute COUNTS), the
   * same line every browser boot computes off a town document. A world mounted
   * on a real planet cell scatters from its baked ECOLOGY instead
   * (`wildMixForBiome`, per-HECTARE densities), and that difference is not
   * cosmetic: `perHa` is the condition the founding mount reads to decide
   * whether the near-stand relevance disc binds AND whether the neighbouring
   * stands mint (#49). Without this seat the countryside premise — the whole
   * frontier-planet shape the world-lab boots — was unreachable headlessly, so
   * every headless measurement of it was taken in an authored-count world.
   *
   * Absent ⇒ byte-identical to every run that shipped.
   */
  wildMix?: ReadonlyArray<WildMixEntry>;
  /**
   * 💾 THE SAVE, RESTORED — `SerializedTownDeltas` handed to the build the way
   * `siteTownConfig` hands one to a browser boot (#49 Stage 2).
   *
   * The persistence law this round writes is *"a depleted neighbouring stand
   * survives save/load"*, and a law whose only proof is a browser eyeball is a
   * law nobody checks. With this seat the whole loop runs headless: boot →
   * draw a stand down → `session.town.deltas.toJSON()` → boot again with that
   * object → the same stand is still drawn down and the mint declines to put
   * its trees back.
   *
   * Absent ⇒ byte-identical to every run that shipped.
   */
  deltas?: SerializedTownDeltas;
}

type TextWorldViewOnRender = NonNullable<Parameters<typeof createTextWorldView>[0]["onRender"]>;

/** What the boot's own fan-out presenter has SEEN. Not part of the projection
 *  contract (a projection registers a TAP instead) — a test/debug convenience. */
export interface TextPresenterLog {
  /** The last board page the host pushed, exactly as it pushed it. */
  board: QuestBoardView | null;
  boards: number;
  clears: number;
  toasts: number;
  lastToast: string | null;
  objectives: number;
  sessions: number;
  wins: number;
}

export interface TextQuestRun {
  readonly host: QuestHost3D;
  readonly view: TextWorldView;
  /** The live world state. Throws once the run is disposed. */
  readonly state: WorldState;
  readonly session: QuestSession;
  /** Advance EXACTLY one frame of `frameDt` seconds. */
  stepFrame(): void;
  advance(frames: number): void;
  advanceS(seconds: number): void;
  /** ⏩ ADVANCE THE BOOKS `days` ECONOMY DAYS WITHOUT RUNNING THE FRAMES —
   *  `QuestHost3D.advanceLedgerDays`, forwarded (clock-warp.ts). The one way a
   *  headless consumer buys a week of ledgers without paying 33 600 frames for
   *  it. Refuses honestly (`ok:false`) while a live-need body is mid-errand;
   *  a caller that needs the span regardless must settle the town first, not
   *  poke the clock. */
  warpDays(days: number): LedgerWarpResult;
  /** Register a listener on the presenter FAN-OUT. Every host push reaches
   *  every tap; the boot's own record is unaffected. Returns a remove fn. */
  addPresenterTap(p: Partial<QuestPresenter>): () => void;
  /** See `TextPresenterLog`. */
  presenterLog(): TextPresenterLog;
  /** Speak a composed AAC sentence (the real `performPlayerAction` path). */
  speak(sentence: string, opts?: { spokenExternally?: boolean; targetId?: string }): void;
  /** Press a board option. */
  select(id: string): void;
  /** LOOK at a world point — the pointer/gaze pipeline, through the view's
   *  identity screen map (so a world point IS the client pixel). */
  look(worldX: number, worldY: number): void;
  clearLook(): void;
  readonly frameDt: number;
  readonly seed: number;
  /**
   * 🌍 THE PLANET THIS RUN STANDS ON — the whole boot record
   * (`buildPlanetScope`: substrate, checksum, cell, site, environment, cities,
   * states, routes, the wild mix, the town config), or null on every other arm.
   *
   * A SESSION READ, never instrumentation: the arc suites that want to know
   * which cell they measured, what its charter said or which cities were
   * streamed as partners read them off the same value the boot itself used. The
   * alternative — an engine-side counter or a debug export — would be a metric
   * the engine keeps for the tests, which is the one thing a measurement may
   * never ask of it.
   */
  readonly planet: PlanetScope | null;
  /**
   * 🌍 THE REGION THIS RUN STANDS ON (planet-boot round S3b) — the flat
   * sibling of `planet`, `buildRegionScope`'s whole record, or null on every
   * other arm. ADDITIVE: kept a SEPARATE field rather than folded into
   * `planet`'s type so no existing consumer of `run.planet` (typed
   * `PlanetScope | null`) has to narrow a wider union it never asked for.
   */
  readonly region: RegionScope | null;
  dispose(): void;
}

export function bootTextQuest(opts: TextQuestOpts): TextQuestRun {
  // ① THE DOCUMENT. structuredClone first: the loader normalizes in place, and
  //    a caller's parsed JSON must survive a second boot unchanged (the
  //    determinism test boots the same object twice).
  const loaded = loadWorldManifest(structuredClone(opts.world), [ECONOMY_MODULE]);
  if (!loaded.game) throw new Error("bootTextQuest: the document has no `game` settings");
  const game = loaded.game;

  // ② THE SCOPE — one dispatch, three arms.
  //    ⚖️ `planet` keeps its original `PlanetScope | null` shape (untouched —
  //    S2's `planet-boot.arc.test.ts` and every other consumer reads it
  //    unguarded); the region arm's own record is the ADDITIVE `region` seat
  //    below, never merged into `planet`'s type.
  let planet: PlanetScope | null = null;
  let region: RegionScope | null = null;
  let built: BuiltTownScope;
  let play: TownPlay;
  if (game.scope === "town") {
    //    THE TOWN ARM. Same call, same certification, same deterministic build.
    built = buildTownScope(game, "game", opts.deltas);
    //    …and its WALKING WINDOW when the document says `cluster: N` — the same
    //    hamlet ring world-lab's `bootLivingTown` composes, now one shared
    //    definition (town-cluster.ts `buildClusterWindow`). Before this seat a
    //    cluster world was BROWSER-ONLY: `cluster` parsed into the config and
    //    nothing headless read it, so `npm run world:text` / `npm run arc:run`
    //    could not boot one (trade-topology-round D-1). `cluster: 0` ⇒ the
    //    identical `built.play`, so every shipped document is untouched.
    //    The returned `windowShift` is unused here: the headless ground seam is
    //    FLAT (no `groundAt`/`waterAt` samplers to shift back), and everything
    //    downstream reads `play.stage.center`, which is already window-frame.
    ({ play } = buildClusterWindow(built));
  } else if (game.scope === "solar_system") {
    // 🌍 THE PLANET ARM — the engine's own boot, entire (see the header block).
    //
    // The PREMISE is gated by `buildPlanetScope` and nowhere else: it owns
    // `game.world`'s schema (`parseSolarWorld` + `PREMISE_FIELDS`), so a system
    // document with no premise, or a premise this engine cannot start, is
    // refused there with a path-exact message. A second premise test here would
    // be a second opinion about what a solar document may say.
    planet = buildPlanetScope(game);
    built = planet.scope;
    // 🚫 NO `buildClusterWindow` ON THIS ARM. The hamlet ring is a synthetic
    // neighbourhood invented for a town that has no neighbours; a planet HAS
    // them — 1757 cities and the roads between them — and they arrive as the
    // partner rows below. Windowing a ring in beside them would be two answers
    // to "who else is out there".
    play = built.play;
  } else if (game.scope === "region") {
    // 🌍 THE REGION ARM (planet-boot round S3b) — a baked FLAT substrate, the
    // third producer of the same `SiteEnvironment`. Mirrors the solar_system
    // arm exactly: `buildRegionScope` owns `game.world`'s schema and the
    // premise gate; no `buildClusterWindow` (a region has real neighbours
    // too — real cities, real roads — so a synthetic hamlet ring beside them
    // would again be two answers to "who else is out there").
    region = buildRegionScope(game);
    built = region.scope;
    play = built.play;
  } else {
    throw new Error(`bootTextQuest: only the town and planet scopes boot headless (got "${game.scope}")`);
  }

  // ②b WHAT THE GROUND SAYS — ONE READ FOR ALL THREE ARMS (planet-boot §6a/S3b).
  //    Measured off the substrate the planet or region arm baked, else
  //    declared by the document's own fields. Null ⇒ no cell under this
  //    boot: the charter arm, no partners, no climate — byte-identical to
  //    every run that shipped.
  const env: SiteEnvironment | null = planet?.env ?? region?.env ?? declaredEnvironment(play.config);
  const ground = env?.ground;

  // ③ THE SESSION SHAPE the game hands `host.start` — verbatim from bootLivingTown.
  const spirit = avatarKind(game) === "spirit";
  //    The document's declared scale, else the street-clock DOLLHOUSE profile
  //    (the town machinery is paced to that 240 s day).
  const scale: WorldScale = game.scale ? resolveWorldScale(game.scale) : DOLLHOUSE_SCALE;
  //    …and the world's SKILL TREE (`game.skills`), include-then-extend. No
  //    shipped document declares one, so this is the catalogue verbatim.
  const skills = resolveSkillCatalogue(game.skills);
  const culture = game.culture;
  const dollhouse = built.focus ? built.focus.house : undefined;
  //    The focus LOT in world coords — the ladder's `focusFrame`. (The host
  //    computes the same rect internally as `spiritFrame` and hands it to the
  //    view seam; this one drives the camera's own writes.)
  const focusLot = built.focus
    ? play.plan.houses.find((h) => h.index === built.focus!.house) ?? null
    : null;
  const focusFrame: TextFocusFrame | null = focusLot
    ? {
        x: focusLot.dx + play.stage.center.x,
        y: focusLot.dy + play.stage.center.y,
        w: focusLot.w,
        h: focusLot.h,
      }
    : null;

  const camera: TextCamera = opts.camera ?? { kind: "dollhouse" };
  const frameDt = opts.dt ?? 1 / 60;
  if (!(frameDt > 0) || frameDt > WIDE_TICK_MAX_FRAME_S) {
    throw new Error(`bootTextQuest: dt must be in (0, ${WIDE_TICK_MAX_FRAME_S}] (got ${frameDt})`);
  }
  // ⏩ THE OPT-IN (W-①/W-③). A frame inside the inner cap is today's boot with
  // no seam at all; a WIDE frame gets one, sized to exactly the step this pump
  // hands over — so the host's clamp admits the dt instead of swallowing it,
  // and the motion arms substep under it. `maxFrameS` is frameDt, not the
  // ceiling: this pump is fixed-step, so there is no hitch to catch up from.
  // The GATE is the DEFAULT cap, never the caller's — so `innerStepS` tunes the
  // substep size without deciding whether the seam exists (and an innerStepS
  // above the frame is a legitimate ask: it lifts the clamp and substeps not at
  // all, which is precisely the pre-seam frame at a wide dt — W0's before
  // picture is taken that way, with no throwaway edit to the engine).
  const innerStepS = opts.innerStepS ?? WIDE_TICK_INNER_STEP_S;
  const wideTick: WideTickConfig | null =
    frameDt > WIDE_TICK_INNER_STEP_S ? { innerStepS, maxFrameS: frameDt } : null;
  const seed = opts.seed ?? play.config.seed;

  // ── THE PRESENTER FAN-OUT ─────────────────────────────────────────────────
  // The boot owns the presenter (the host needs one before anything else
  // exists), so a projection cannot REPLACE it — it TAPS it. Every method
  // records into the boot's log and forwards to every tap, so two consumers
  // (a text session and a test) never fight over the one slot.
  const taps: Partial<QuestPresenter>[] = [];
  const log: TextPresenterLog = {
    board: null, boards: 0, clears: 0, toasts: 0, lastToast: null,
    objectives: 0, sessions: 0, wins: 0,
  };
  /** Forward one push to every tap, in registration order. */
  const fan = (call: (t: Partial<QuestPresenter>) => void): void => {
    for (const t of taps) call(t);
  };
  const presenter: QuestPresenter = {
    // Required half.
    sessionStarted(session) { log.sessions++; log.board = null; fan((t) => t.sessionStarted?.(session)); },
    board(v) { log.boards++; log.board = v; fan((t) => t.board?.(v)); },
    clearBoard() { log.clears++; log.board = null; fan((t) => t.clearBoard?.()); },
    toast(text, kind) { log.toasts++; log.lastToast = text; fan((t) => t.toast?.(text, kind)); },
    objectives(list) { log.objectives++; fan((t) => t.objectives?.(list)); },
    collect(nodeId, have, need) { fan((t) => t.collect?.(nodeId, have, need)); },
    satchel(inventory) { fan((t) => t.satchel?.(inventory)); },
    won() { log.wins++; fan((t) => t.won?.()); },
    // Optional half — present because the host CALLS them (a missing method is
    // a silently dropped push, and text mode's whole job is to drop nothing).
    pocket(items) { fan((t) => t.pocket?.(items)); },
    score(value) { fan((t) => t.score?.(value)); },
    action(action, meta) { fan((t) => t.action?.(action, meta)); },
    nouns(list) { fan((t) => t.nouns?.(list)); },
    addressees(list) { fan((t) => t.addressees?.(list)); },
    family(members) { fan((t) => t.family?.(members)); },
    city(chips) { fan((t) => t.city?.(chips)); },
  };

  // ── THE MANUAL PUMP ───────────────────────────────────────────────────────
  // world-host-carry.test.ts's pattern, one level up: the frame callback is
  // captured instead of scheduled, and `now` reads the same hand-advanced
  // clock the host's dt is computed from. The host's loop re-schedules itself
  // at the end of every frame, so the captured callback stays fresh.
  let tMs = opts.startMs ?? 0;
  let frameCb: ((now: number) => void) | null = null;
  const scheduleFrame = (cb: (now: number) => void): (() => void) => {
    frameCb = cb;
    return () => {
      if (frameCb === cb) frameCb = null;
    };
  };

  let view: TextWorldView | null = null;
  const seam: QuestViewSeam = {
    create(ctx) {
      view = createTextWorldView({
        localId: ctx.localId,
        spirit: ctx.spirit,
        // The host resolved the dollhouse rect already; seed from it so frame 1
        // is right even before the camera asserts itself.
        spiritFrame: ctx.spiritFrame,
        interiorReveal: camera.kind !== "follow",
        ...(opts.onRender ? { onRender: opts.onRender } : {}),
      });
      return view;
    },
    // A fixed viewport. Nothing measures a headless view, and with the identity
    // screen map the numbers only bound the host's screen-space picking.
    size: () => ({ w: 1280, h: 720, dpr: 1 }),
    // ⑦ — the build overlay is a render input, so it lands on the view like
    // any other and the projection reads it off the probe.
    buildOverlay: (v) => view?.setBuildOverlay(v),
  };

  // ④ THE HOST. `voice: null` is LOAD-BEARING — omitting it constructs the
  //    default speechSynthesis voice, which does not exist in Node.
  const host = createQuestHost3D({
    view: seam,
    presenter,
    voice: null,
    scheduleFrame,
    now: () => tMs,
    // Determinism (text-mode.md D4): the world-host's default is `Math.random`,
    // so a headless boot MUST inject. Same fold every other subsystem uses.
    npcRng: mulberry32(hashSeed(seed, "npc")),
    ...(wideTick ? { wideTick } : {}),
    // 🏙️ WHO ELSE IS OUT THERE — the record's partner rows, straight onto the
    //    host's own seat. The browser's founding mount passes exactly this
    //    (`nearbyCityPartners` → `deps.tradePartners`); before this line a
    //    headless founding had only the abstract `away:` partner, priced at the
    //    fictional `AWAY_DISTANCE_M`, so every trade measurement taken here was
    //    taken against a settlement that is not on the map.
    ...(env ? { tradePartners: () => env.partners } : {}),
    // ⛰️ …and the terrain samplers, for a producer that HAS a surface. Wrapped
    //    rather than passed by reference so the record owns its own `this`.
    ...(ground
      ? {
          groundAt: (x: number, y: number): number => ground.groundAt(x, y),
          waterAt: (x: number, y: number): boolean => ground.waterAt(x, y),
        }
      : {}),
  });

  // ⑤ START. Exactly the argument list bootLivingTown passes.
  //
  // 🌲 …INCLUDING `wilderness`, WHICH IT DID NOT UNTIL 2026-08-12. The header
  // above claims parity and this line was the one place it did not hold: every
  // browser boot computes `config.wilderness ?? (days ?? 220) ≤
  // FOUNDING_AGE_DAYS` and passes `{ seed, mix: homesteadWildMix(biome, seed) }`
  // when it holds; the harness passed nothing. So a founding-age world driven
  // headless had no standing tree, no rock and no `wild:` container of any
  // kind, and EVERY play-level measurement of the block economy — the whole GL
  // fix round's, this one's baselines included — was taken in a world with no
  // timber supply whatsoever (closing sweep, handoff item 2). The starve line
  // was honest; it was not the starve a stocked world shows.
  //
  // The `??` is the same one the browser gate uses, so this ALSO honours an
  // explicit `world.wilderness` declaration on an ESTABLISHED town — an aged
  // world that asks for open country gets it, and one that says `false` at
  // founding age gets none. Nothing in this expression is a content choice:
  // the shipped dollhouse (days 220, no declaration) is unchanged.
  const wildOn = play.config.wilderness ?? (play.config.days ?? 220) <= FOUNDING_AGE_DAYS;
  host.start(play.bundle.game, play, {
    spirit,
    ...(dollhouse !== undefined ? { dollhouse } : {}),
    ...(wildOn
      ? {
          wilderness: {
            seed: play.config.seed,
            // 🌍 THE CELL'S OWN COUNTRYSIDE (see the header block at the top of
            // this file). A boot that knows what ground it stands on scatters
            // from that ground's ECOLOGY — per-HECTARE densities, which is what
            // makes the near-stand disc bind and the neighbouring tiles mint.
            // A boot that does not keeps the CHARTER arm (absolute counts),
            // byte-identical to every run that shipped.
            mix:
              opts.wildMix ??
              (env
                ? wildMixForBiome(env.biome, play.config.seed, env.climate, env.eco)
                : homesteadWildMix(play.plan.biome, play.config.seed)),
          },
        }
      : {}),
    scale,
    skills,
    ...(culture ? { culture } : {}),
    // 🌡️ THE LIVE FARM'S HALF of the climate sample. The books' half rides
    //    `TownPlayConfig.climate` (the planet arm sets it in `planetScopeOn`;
    //    a declared document carries it as a field), and the two must be the
    //    SAME sample or the visible farm and the abstract farm size the same
    //    ground differently.
    ...(env ? { climate: env.climate } : {}),
  });
  if (!view) throw new Error("bootTextQuest: the host never built a view");
  const textView: TextWorldView = view;

  // ⑥ THE TEXT CAMERA — the ladder's THREE SIM EFFECTS, and nothing else.
  //
  // The spirit ladder (spirit/ladder.ts `stepStructure`) does a great deal that
  // is pure rendering: it eases an orbit, blends two poses, rebases the render
  // origin, drives a spark. Exactly three of its writes reach the SIMULATION,
  // and those are what a text camera owes the world:
  //
  //   1. PARK THE GAZE AVATAR at the focus house centre (`placeGazeAvatar`,
  //      fired once on engaging the rung). A spirit's PLAYER_ID body is a
  //      parked stand-in, but it is still the body `visibleBuildings` and the
  //      streamer's occupancy check read, so WHERE it stands is sim state.
  //   2. TELL THE HOST WHERE THE SPIRIT HOVERS (`setSpiritPosition`, fed every
  //      frame from `ladder.focusWorld`) — distance rules must see the SPIRIT,
  //      not the parked body.
  //   3. SET THE REVEAL (`setInteriorReveal` + `setSpiritFocus`), which decides
  //      `revealedBuildings()` and therefore which interiors get EMBODIED.
  //      Re-asserted every frame in the ladder because the view can be rebuilt
  //      under a streaming session; re-asserted here for the same reason.
  //
  // (In GL, 3 goes host → questView. Headless `questView` is null by
  //  construction, so the camera writes to the text view directly.)
  const cameraPoint = (): { x: number; y: number } | null => {
    if (camera.kind === "dollhouse") {
      return focusFrame
        ? { x: focusFrame.x + focusFrame.w / 2, y: focusFrame.y + focusFrame.h / 2 }
        : { x: play.stage.center.x, y: play.stage.center.y };
    }
    if (camera.kind === "town") return { x: play.stage.center.x, y: play.stage.center.y };
    const body = host.world?.state.avatars[camera.creatureId];
    return body ? { x: body.x, y: body.y } : null;
  };

  /** Effect 1 — once, on boot, exactly as the ladder's `s.engaged` latch. */
  const parkGazeAvatar = (): void => {
    if (camera.kind === "follow") return; // a followed body parks itself
    const at = cameraPoint();
    const p = host.world?.state.avatars[PLAYER_ID];
    if (!at || !p) return;
    p.x = at.x;
    p.y = at.y;
    p.vx = 0;
    p.vy = 0;
  };

  /** Effects 2 + 3 — idempotent, re-asserted before every frame. */
  const applyCamera = (): void => {
    const at = cameraPoint();
    if (at) host.setSpiritPosition(at.x, at.y);
    switch (camera.kind) {
      case "dollhouse":
        textView.setSpiritFocus(focusFrame);
        textView.setInteriorReveal(true);
        break;
      case "town":
        textView.setSpiritFocus(null); // frameless spirit = the full reveal
        textView.setInteriorReveal(true);
        break;
      case "follow":
        textView.setSpiritFocus(null);
        // The ladder's own rule: a formless spirit in the street is not an
        // occupant — CLAIM a body and the interior opens as for a walker.
        textView.setInteriorReveal(host.possessed !== null);
        break;
    }
  };

  parkGazeAvatar();
  applyCamera();

  const stepFrame = (): void => {
    // Camera writes land BEFORE the frame, so this frame's render() sees them —
    // and `revealedBuildings()` keeps its honest one-frame lag (the sim inside
    // this frame still reads what the PREVIOUS render computed).
    applyCamera();
    tMs += frameDt * 1000;
    frameCb?.(tMs);
  };

  return {
    host,
    view: textView,
    get state(): WorldState {
      const w = host.world;
      if (!w) throw new Error("bootTextQuest: the world host has stopped");
      return w.state;
    },
    get session(): QuestSession {
      return host.session;
    },
    stepFrame,
    advance(frames: number): void {
      for (let i = 0; i < frames; i++) stepFrame();
    },
    advanceS(seconds: number): void {
      const n = Math.max(0, Math.round(seconds / frameDt));
      for (let i = 0; i < n; i++) stepFrame();
    },
    warpDays(days: number): LedgerWarpResult {
      return host.advanceLedgerDays(days);
    },
    addPresenterTap(p: Partial<QuestPresenter>): () => void {
      taps.push(p);
      return () => {
        const i = taps.indexOf(p);
        if (i >= 0) taps.splice(i, 1);
      };
    },
    presenterLog(): TextPresenterLog {
      return { ...log };
    },
    speak(sentence, o): void {
      host.speak(sentence, o);
    },
    select(id: string): void {
      host.select(id);
    },
    look(worldX: number, worldY: number): void {
      // The view's screen map is the identity, and a headless host's client
      // origin is (0,0) — so a world point IS the client pixel to feed.
      host.setPointer(worldX, worldY);
    },
    clearLook(): void {
      host.clearPointer();
    },
    frameDt,
    seed,
    planet,
    region,
    dispose(): void {
      host.stop();
    },
  };
}
