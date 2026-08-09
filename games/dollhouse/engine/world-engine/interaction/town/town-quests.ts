// shared/world-engine/interaction/town/town-quests.ts
//
// THE JOIN: a living town's RESIDENT and a symbol-game CREATURE become one
// entity, each existing AI keeping the half it was built for.
//
//   BODY — the town owns it. A resident's position is the errand clock's
//   closed form (engine/town/goods.ts): home, walking to a stall, dwelling,
//   walking back. The creature layer never schedules a resident; a
//   conversation freezes the body exactly the way world-host already
//   freezes any NPC mid-errand, and the cycle resumes on its own clock.
//
//   MIND — the creature sim owns it (creatures.ts). Dialogue, needs, giving,
//   debts and knowledge run on the same monotone rules every quest world
//   uses; what changes is where the SEEDS come from — the town's live books
//   instead of generator dice.
//
// The three contracts that reconcile the two systems' semantics (each was a
// genuine contradiction; the resolutions are deliberate and documented):
//
//   SNAPSHOT — creature needs are one-shot ("needs don't renew", the
//   certifiable puzzle contract); town needs are daily flows. So needs are
//   SAMPLED at session start from the books (scarcity-ranked: the good with
//   the emptiest ledger asks first) and stay monotone for the session. The
//   town keeps flowing underneath; the NEXT session samples fresh.
//
//   DELIVERY — a fulfilled creature need BINDS the item (retention: the
//   bear keeps its apple); a town delivery would be CONSUMED. Within the
//   session, retention wins (the certifier's invariants stay intact); the
//   town's share is applied through the books instead — applyTownOutcome
//   credits each delivered good's stockpile, which is what a consumed
//   delivery IS at aggregate scale.
//
//   GENEROSITY — creature vendors grant only against covering debt; town
//   stalls serve their neighbors freely (the street economy has no prices).
//   Town vendors ship with `playerDebt: 1` (the shipped free-vendor form):
//   ask and receive. Exchange/lend flavors remain available as difficulty
//   knobs, not defaults.
//
// Deliberately NOT projected from the books (v1): escort / stay-with needs —
// they would tear a resident off the errand clock (a body-authority
// conflict); those still come from the generator's staged casts.

import type { EntityDef, FulfillNode, GoalTreeGame, OvercomeNode } from "@shared/world-engine/solver/types.js";
import type { CompiledEconomy } from "@shared/world-engine/kernel/modules/economy/index.js";
import type { TownHost } from "@shared/world-engine/kernel/town/host.js";
import type { TownPlan } from "@shared/world-engine/kernel/town/plan.js";
import type { CreatureWorld } from "@shared/world-engine/interaction/behavior/creatures.js";
import type { PoolDef, PoolMember } from "@shared/world-engine/interaction/types.js";
import { POOLS } from "@shared/world-engine/interaction/content/pools.js";

/* ----------------------------- deterministic rng ----------------------------- */

function hashSeed(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shipped-first shuffled draw (the generator's Drawer, locally). */
function drawer(pool: PoolDef, rng: () => number): () => PoolMember {
  const shuffle = (arr: PoolMember[]): PoolMember[] => {
    const a = [...arr];
    for (let k = a.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [a[k], a[j]] = [a[j]!, a[k]!];
    }
    return a;
  };
  const queue = [
    ...shuffle(pool.members.filter(m => m.glyphStatus !== "queued")),
    ...shuffle(pool.members.filter(m => m.glyphStatus === "queued")),
  ];
  let i = 0;
  return () => queue[i++ % queue.length]!;
}

/* ------------------------------- the sampling ------------------------------- */

/** Which item VOCABULARY answers a town commodity — content's call
 *  (override via opts.goodPools). A good with no pool has no symbols to
 *  stage and is skipped from sampling (recorded on the bundle). */
export const DEFAULT_GOOD_POOLS: Record<string, string> = {
  food: "treat",
  cloth: "clothing",
  tools: "toy",
};

/** The self-condition a scarce good reads as (narration flavor). */
const GOOD_CONDITION: Record<string, string> = { food: "hungry", cloth: "cold" };

export interface TownNeedSample {
  /** Commodity key (a street good with a ledger this town keeps). */
  good: string;
  /** The ledger fill that ranked it (got/need, 1 when need is 0). */
  fill: number;
  /** Work types that sell this good over a counter (GoodSpec.sellers). */
  sellers: string[];
  condition?: string;
}

/** Sample the town's books: every street good the settlement keeps a
 *  ledger for, scarcity first (emptiest fill), slot order tying. The
 *  SATISFIABILITY law is met by construction — every sampled need is
 *  staged WITH its item and a granting vendor, exactly like the
 *  generator's known-good assignments; the books decide WHO is asking
 *  and how urgently, never whether the puzzle is solvable. */
export function sampleTownNeeds(
  town: TownHost,
  eco: CompiledEconomy,
  siteKey: string,
  max = 2,
  goodPools: Record<string, string> = DEFAULT_GOOD_POOLS,
): TownNeedSample[] {
  const samples: TownNeedSample[] = [];
  for (const g of eco.goods) {
    if (!goodPools[g.key]) continue; // no vocabulary — nothing to stage
    const need = town.dual.settlementScalar(siteKey, g.needScalar);
    const got = town.dual.settlementScalar(siteKey, g.gotScalar);
    const fill = need > 0 ? Math.max(0, Math.min(1, got / need)) : 1;
    samples.push({
      good: g.key,
      fill,
      sellers: [...g.sellers],
      ...(GOOD_CONDITION[g.key] ? { condition: GOOD_CONDITION[g.key] } : {}),
    });
  }
  samples.sort((a, b) => a.fill - b.fill); // stable: ties keep slot order
  return samples.slice(0, Math.max(0, max));
}

/* ------------------------------ the quest game ------------------------------ */

export interface TownCastEntry {
  /** The fulfill node — ALSO the creature id (creatureWorldFromGame). */
  nodeId: string;
  npcEntityId: string;
  role: "wanter" | "vendor";
  good: string;
  /** Wanter: home lot index in the town plan (the body's house). */
  house?: number;
  /** Vendor: the work type whose counter it stands at ("hall" when the
   *  town has no seller of this good — the imports depot, same fallback
   *  the street economy uses). */
  workType?: string;
}

export interface TownQuestBundle {
  game: GoalTreeGame;
  /** Entity ↔ town anchors — the hosting layer's placement sidecar
   *  (deterministic: same town + seed rebuilds it exactly). */
  cast: TownCastEntry[];
  needs: TownNeedSample[];
  /** Street goods sampled AWAY for lack of a vocabulary pool (mods). */
  skippedGoods: string[];
}

export interface TownQuestOpts {
  seed: number;
  /** Quest-giving residents (0..3; default 0 — no quests unless asked). */
  questCount?: number;
  syntax?: "a" | "b" | "c";
  locale?: string;
  pools?: Record<string, PoolDef>;
  goodPools?: Record<string, string>;
}

/**
 * Build a certified-shape quest game FROM the town's live books: for each
 * sampled scarce good, a WANTER resident (home = a real house lot) needs
 * an item of that good's vocabulary, and a VENDOR resident stocks it at
 * the good's own counter. The output is an ordinary fulfill-node game —
 * certifyCreatureQuestWorld and the whole play pipeline run UNCHANGED.
 */
export function buildTownQuestGame(
  town: TownHost,
  eco: CompiledEconomy,
  plan: TownPlan,
  siteKey: string,
  opts: TownQuestOpts,
): TownQuestBundle {
  const pools = opts.pools ?? POOLS;
  const goodPools = opts.goodPools ?? DEFAULT_GOOD_POOLS;
  const friendPool = pools.friend;
  if (!friendPool) throw new Error("buildTownQuestGame needs the friend pool");
  const rng = mulberry32(hashSeed(opts.seed, siteKey));
  const friends = drawer(friendPool, rng);
  const itemDrawers = new Map<string, () => PoolMember>();

  const questCount = Math.max(0, Math.min(3, Math.floor(opts.questCount ?? 0)));
  const skippedGoods = eco.goods.map(g => g.key).filter(k => !goodPools[k]);
  const needs = sampleTownNeeds(town, eco, siteKey, questCount, goodPools);

  const entities = new Map<string, EntityDef>();
  const add = (e: EntityDef): void => {
    if (!entities.has(e.id)) entities.set(e.id, e);
  };
  const guards: OvercomeNode[] = [];
  const cast: TownCastEntry[] = [];

  const gate = (nodeId: string, label: string, key: FulfillNode): void => {
    const gateId = `${nodeId}_gate`;
    add({ id: gateId, kind: "obstacle", label: `${label} lock`, iconRef: "🔒" });
    guards.push({ type: "overcome", id: `${nodeId}_overcome`, obstacleEntityId: gateId, key });
  };

  needs.forEach((need, i) => {
    const poolId = goodPools[need.good]!;
    if (!itemDrawers.has(poolId)) {
      const pool = pools[poolId];
      if (!pool) throw new Error(`buildTownQuestGame: good "${need.good}" names missing pool "${poolId}"`);
      itemDrawers.set(poolId, drawer(pool, rng));
    }
    const item = itemDrawers.get(poolId)!();
    const wanter = friends();
    const vendor = friends();
    const q = `t${i}`;

    add({ id: `${q}_item`, kind: "item", label: item.label, ...(item.iconRef ? { iconRef: item.iconRef } : {}), glyph: item.symbol });
    add({ id: `${q}_wanter_npc`, kind: "character", label: wanter.label, ...(wanter.iconRef ? { iconRef: wanter.iconRef } : {}), glyph: wanter.symbol });
    add({ id: `${q}_vendor_npc`, kind: "character", label: vendor.label, ...(vendor.iconRef ? { iconRef: vendor.iconRef } : {}), glyph: vendor.symbol });

    const wanterNode: FulfillNode = {
      type: "fulfill",
      id: `${q}_wanter`,
      npcEntityId: `${q}_wanter_npc`,
      needItemEntityId: `${q}_item`,
      needValue: 3,
      // Scarcity is the narration: a lean ledger reads as the condition
      // ("I'm hungry"); a full one still asks, just without the ailment.
      ...(need.condition && need.fill < 0.999 ? { condition: need.condition } : {}),
      zoneHint: `${wanter.label}'s house`,
    };
    const vendorNode: FulfillNode = {
      type: "fulfill",
      id: `${q}_vendor`,
      npcEntityId: `${q}_vendor_npc`,
      stockEntityIds: [`${q}_item`],
      likeEntityIds: [`${q}_item`],
      playerDebt: 1, // town stalls serve their neighbors freely
      zoneHint: `${vendor.label}'s stall`,
    };
    gate(wanterNode.id, wanter.label, wanterNode);
    gate(vendorNode.id, vendor.label, vendorNode);

    // Town anchors: the wanter LIVES somewhere real; the vendor stands at
    // this good's own counter (or the hall — the imports depot).
    const house = plan.houses.length
      ? plan.houses[hashSeed(opts.seed, `${siteKey}:home:${i}`) % plan.houses.length]!.index
      : 0;
    const workType = need.sellers.find(s => plan.works.some(w => w.type === s)) ?? "hall";
    cast.push({ nodeId: wanterNode.id, npcEntityId: wanterNode.npcEntityId, role: "wanter", good: need.good, house });
    cast.push({ nodeId: vendorNode.id, npcEntityId: vendorNode.npcEntityId, role: "vendor", good: need.good, workType });
  });

  // The star + gates are CERTIFICATION SCAFFOLDING only — a goal tree
  // needs a spine, and via-guards are how fulfill nodes attach to it.
  // The town stage builds neither (open town, decided 2026-07-09): the
  // locked door was a placeholder, and win designation is future work.
  add({ id: "star", kind: "marker", label: "Star", iconRef: "⭐" });

  const game: GoalTreeGame = {
    engine: "goal-tree",
    engineVersion: 1,
    meta: {
      title: "Town Helpers",
      locale: opts.locale ?? "en",
      theme: "a living village and its daily needs",
      learningGoals: ["want", "give", "have"],
      ...(opts.syntax ? { syntax: opts.syntax } : {}),
      seed: opts.seed,
    },
    entities: [...entities.values()],
    root: {
      type: "reach",
      id: "root_star",
      markerEntityId: "star",
      zoneHint: "the town plaza",
      // The schema wants via ABSENT when there are no guards (min-1 array) —
      // a questless town's root is a bare reach, nothing to prove.
      ...(guards.length ? { via: guards } : {}),
    },
  };

  return { game, cast, needs, skippedGoods };
}

/* ------------------------------- the outcome ------------------------------- */

/** Book units one delivered item is worth (the aggregate face of a
 *  consumed delivery — see the DELIVERY contract above). */
export const RATION_VALUE = 1;

export interface TownDelivery {
  good: string;
  /** Fulfilled needs of this good this session. */
  count: number;
  /** The stockpile credited (the good's flow-net drift target), or null
   *  when the economy banks nothing for it — the fulfillment itself is
   *  then the session's whole truth. */
  scalar: string | null;
}

export interface TownOutcome {
  deliveries: TownDelivery[];
}

/** Credit delivered units of a good to the town's books, live: the
 *  stockpile its flow net banks into (the drift target, found by the
 *  ONE-VOCABULARY rule — the net whose source is `{good}_out`). Returns
 *  the credited scalar, or null when the economy banks nothing for it.
 *  The per-event form of `applyTownOutcome` — call it as needs fulfill
 *  in an OPEN-ENDED session (no session end to batch at). `units`
 *  defaults to the ONE item every fulfillment is; a landed caravan (R&T ⑤
 *  T3b) credits its whole load through the same one rule. */
export function creditDelivery(
  town: { inject(scalar: string, delta: number): void },
  eco: CompiledEconomy,
  good: string,
  units = 1,
): string | null {
  const drift = eco.flownets.find(f => f.source === `${good}_out`)?.drift ?? null;
  if (drift && units > 0) town.inject(drift, RATION_VALUE * units);
  return drift;
}

/**
 * Apply a session's fulfillments back to the town's books: each
 * delivered good credits its stockpile (the drift target its flow net
 * already banks overproduction into), found by the ONE-VOCABULARY rule —
 * the net whose source is `{good}_out`. Idempotent per call site: pass
 * the live CreatureWorld once, at session end.
 */
export function applyTownOutcome(
  town: { inject(scalar: string, delta: number): void },
  eco: CompiledEconomy,
  bundle: TownQuestBundle,
  world: CreatureWorld,
): TownOutcome {
  const counts = new Map<string, number>();
  for (const entry of bundle.cast) {
    if (entry.role !== "wanter") continue;
    const creature = world.creatures[entry.nodeId];
    if (!creature) continue;
    const done = creature.needs.filter(n => n.fulfilled).length;
    if (done > 0) counts.set(entry.good, (counts.get(entry.good) ?? 0) + done);
  }
  const deliveries: TownDelivery[] = [];
  for (const [good, count] of counts) {
    const drift = eco.flownets.find(f => f.source === `${good}_out`)?.drift ?? null;
    if (drift) town.inject(drift, RATION_VALUE * count);
    deliveries.push({ good, count, scalar: drift });
  }
  return { deliveries };
}
