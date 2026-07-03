// shared/symbol-game/creature-quests.ts
//
// The creature-based quest world: generator + derivation + SIMULATION certifier
// (creature-needs.md §8–§10, puzzle-mode scope).
//
//   • buildCreatureQuestWorld — dimension params → a GoalTreeGame whose quests
//     are `fulfill` nodes carrying creature SEEDS (need/likes/stock/props/debt).
//     Simple + gamified: one need per giver, curated initial debts, star-gated.
//   • creatureWorldFromGame — reconstructs the CreatureWorld from those nodes,
//     DETERMINISTICALLY (the client and the certifier build the same world).
//   • certifyCreatureQuestWorld — the schema/zone gauntlet PLUS a greedy-player
//     SIMULATION over the actual creature rules: sees displayed stock, claims
//     loose props, offers/requests/pays prices until every need fulfills. This
//     is the behavioral half the static solver can't see (it treats `fulfill`
//     as play-side, like transport).

import { certifyGoalTreeGame } from "../goal-tree/index.js";
import type { FulfillNode, GoalTreeGame, OvercomeNode, EntityDef, StationKind } from "../goal-tree/types.js";
import { STATION_KINDS } from "../goal-tree/types.js";
import { walkGoalTree } from "../goal-tree/walk.js";
import {
  applyTransform,
  claimItem,
  concludeTransfer,
  createCreatureWorld,
  giveItem,
  notePlacement,
  openNeeds,
  pendingTransfers,
  requestItem,
  seeItem,
  settleObligations,
  STATE_TAGS,
  type CreatureId,
  type CreatureSeed,
  type CreatureWorld,
  type ItemSeed,
} from "./creatures.js";
import type { PoolDef, PoolMember } from "./types.js";
import { POOLS } from "./pools.js";
import { mulberry32, randomSeed } from "../prng.js";
import type { QuestComplexity, SyntaxLevel } from "./dialogue-gen.js";

export const PLAYER_CREATURE_ID = "player";

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface CreatureWorldParams {
  questCount?: number;
  /** BCP-47 locale for meta — picks the spoken-translation ruleset. */
  locale?: string;
  syntax?: SyntaxLevel; // carried in meta.learningGoals context; dialogue level is play-side
  complexity?: QuestComplexity | "mixed";
  /** Traders: state the price only on request ("after", default) or unprompted. */
  traderAnnounce?: "before" | "after";
  /**
   * Where the where-is clue lives. "direct" (default): the wanter knows where
   * its item is — asking IT always yields the clue. "askAround": the wanter
   * does NOT know; the fact is seeded on a KNOWER (another quest's giver, else
   * this quest's supplier) — the player must ask around.
   */
  clueRouting?: "direct" | "askAround";
  /**
   * Counting b: instances of the needed kind per quest (1–3, default 1). The
   * giver needs ALL of them; a partial delivery projects as "want more". Lend
   * quests force 1 (a consumed borrowed item could never be given back).
   */
  needCount?: number;
  /**
   * Task b/c: "fetch" (default) = possession needs; "place" = the giver wants
   * the item PLACED in a container staged in its zone (a state need — handing
   * it over is redirected, the drop into the box is what fulfills);
   * "deliver" = the giver wants ANOTHER creature to have it ("give the ball
   * to Bear") — a recipient creature with the matching need joins the quest,
   * and giving IT the item fulfills both at once.
   */
  task?: "fetch" | "place" | "deliver";
  /**
   * Item b: descriptor variants via the GLYPH system. The needed item becomes
   * a composed variant ("ball.big") and a same-kind DISTRACTOR variant
   * ("ball.small") is placed alongside it (loose, or in the vendor's stock).
   * Offering the wrong variant is declined with "{item} + {descriptor}.not".
   */
  descriptors?: boolean;
  /**
   * Item Transformations b: the item spawns in the WRONG state (a cold apple)
   * and the giver's need requires the transformed one (`apple.hot`); a
   * matching STATION (fire/water) is staged in the item-holder's room —
   * dropping the item on it swaps the state. The untransformed offer is
   * declined with "{item} + {state}.not".
   */
  transformations?: boolean;
  /**
   * Request complexity for GIVERS: "before" (default — states the want),
   * "after" (Request b — reveal via small talk), "never" (Request c — only a
   * sad emote; a same-kind KEEPSAKE is staged beside the creature as the
   * inference evidence, and the player must OFFER the right thing).
   */
  giverAnnounce?: "before" | "after" | "never";
  /** Request-c scaffold: float the hidden want in a THOUGHT bubble (default
   *  true until the phase layer makes it fade). */
  thoughtScaffold?: boolean;
  /**
   * World seed. One seed reproduces the WHOLE village: generator draws here,
   * plus the downstream layout/buildings/colors stages (they read it back from
   * `meta.seed`). Omitted → a random seed is drawn and still recorded.
   */
  seed?: number;
  /** Explicit random source — overrides `seed` for the generator draws. */
  rng?: () => number;
  pools?: Record<string, PoolDef>;
}

/** Shipped-first, deterministic-with-rng member sequence (no repeats until dry). */
class Drawer {
  private queue: PoolMember[];
  private i = 0;
  constructor(pool: PoolDef, rng: () => number) {
    const shipped = pool.members.filter((m) => m.glyphStatus !== "queued");
    const queued = pool.members.filter((m) => m.glyphStatus === "queued");
    const shuffle = (arr: PoolMember[]) => {
      const a = [...arr];
      for (let k = a.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [a[k], a[j]] = [a[j]!, a[k]!];
      }
      return a;
    };
    this.queue = [...shuffle(shipped), ...shuffle(queued)];
  }
  next(): PoolMember {
    const m = this.queue[this.i % this.queue.length]!;
    this.i += 1;
    return m;
  }
}

function npcEntity(id: string, m: PoolMember): EntityDef {
  return { id, kind: "character", label: m.label, ...(m.iconRef ? { iconRef: m.iconRef } : {}), glyph: m.symbol };
}
function itemEntity(id: string, m: PoolMember): EntityDef {
  return { id, kind: "item", label: m.label, ...(m.iconRef ? { iconRef: m.iconRef } : {}), glyph: m.symbol };
}
/** A descriptor VARIANT of a pool item — the glyph is the composed form
 *  ("ball.big"); the emoji stays as the render placeholder until the composed
 *  glyph image decodes. */
function variantEntity(id: string, m: PoolMember, mod: string, modLabel: string): EntityDef {
  return {
    id,
    kind: "item",
    label: `${modLabel} ${m.label.toLowerCase()}`,
    ...(m.iconRef ? { iconRef: m.iconRef } : {}),
    glyph: `${m.symbol}.${mod}`,
  };
}

/** Minimal-pair descriptor axes (Item b): same head, ONE axis varies. All
 *  modifier keys are registry-backed (big/small = dimension transform,
 *  color_* = color transform; both apply to noun/animal heads). */
const DESCRIPTOR_AXES: { wanted: string; wrong: string; labels: [string, string] }[] = [
  { wanted: "big", wrong: "small", labels: ["Big", "Small"] },
  { wanted: "small", wrong: "big", labels: ["Small", "Big"] },
  { wanted: "color_red", wrong: "color_blue", labels: ["Red", "Blue"] },
  { wanted: "color_blue", wrong: "color_red", labels: ["Blue", "Red"] },
  { wanted: "color_green", wrong: "color_yellow", labels: ["Green", "Yellow"] },
];

/**
 * Build a creature-quest village: per quest a GIVER (a creature with one need)
 * and, per complexity, a SUPPLIER creature holding the item on display:
 *   simple   — the item lies loose in the giver's room.
 *   request  — a free vendor stocks it (initial debt covers it: ask and receive).
 *   exchange — a trader stocks it and needs a PAY item (loose in its room).
 *   lend     — a rental vendor stocks it PLUS a lure; debt covers ONE item at a
 *              time, so a borrowed lure must come back first (deadlock-free: the
 *              quest item can also be requested directly).
 */
export function buildCreatureQuestWorld(params: CreatureWorldParams = {}): GoalTreeGame {
  const seed = params.seed ?? randomSeed();
  const rng = params.rng ?? mulberry32(seed);
  const pools = params.pools ?? POOLS;
  const friendPool = pools.friend;
  const itemPools = [pools.treat, pools.toy].filter((p): p is PoolDef => !!p);
  if (!friendPool || itemPools.length < 2) {
    throw new Error("buildCreatureQuestWorld needs the friend, treat and toy pools");
  }

  const complexityFor = (i: number): QuestComplexity => {
    if (params.complexity === "mixed") return (["simple", "request", "exchange"] as const)[i % 3]!;
    return params.complexity ?? "simple";
  };

  const requested = Math.max(1, Math.min(4, Math.floor(params.questCount ?? 2)));
  let questCount = 0;
  let npcsNeeded = 0;
  for (let i = 0; i < requested; i++) {
    const need =
      (complexityFor(i) === "simple" ? 1 : 2) + (params.task === "deliver" ? 1 : 0);
    if (npcsNeeded + need > friendPool.members.length) break;
    npcsNeeded += need;
    questCount += 1;
  }
  if (questCount === 0) questCount = 1;

  const friends = new Drawer(friendPool, rng);
  const drawers = itemPools.map((p) => new Drawer(p, rng));

  const entities = new Map<string, EntityDef>();
  const add = (e: EntityDef) => {
    if (!entities.has(e.id)) entities.set(e.id, e);
  };
  const guards: OvercomeNode[] = [];
  const concepts = new Set<string>(["want", "give", "have"]);

  const gate = (nodeId: string, label: string, key: FulfillNode): void => {
    const gateId = `${nodeId}_gate`;
    add({ id: gateId, kind: "obstacle", label: `${label} lock`, iconRef: "🔒" });
    guards.push({ type: "overcome", id: `${nodeId}_overcome`, obstacleEntityId: gateId, key });
  };

  const quests: { giver: FulfillNode; itemIds: string[]; supplier?: FulfillNode }[] = [];
  const needCount = Math.max(1, Math.min(3, Math.floor(params.needCount ?? 1)));
  const containerDrawer =
    params.task === "place" && pools.container ? new Drawer(pools.container, rng) : null;
  if (params.task === "place" && !containerDrawer) {
    throw new Error("buildCreatureQuestWorld task 'place' needs the container pool");
  }

  for (let i = 0; i < questCount; i++) {
    const q = `q${i}`;
    const complexity = complexityFor(i);
    const itemDrawer = drawers[i % drawers.length]!;
    const otherDrawer = drawers[(i + 1) % drawers.length]!;
    const item = itemDrawer.next();
    const giver = friends.next();
    // Multi-item needs: N instances of ONE kind (same symbol, distinct
    // entities). Lend forces 1 — a borrowed item the giver consumed could
    // never be given back, and the lender would price exactly that return.
    const count = complexity === "lend" ? 1 : needCount;
    const itemIds = Array.from({ length: count }, (_, k) => (k === 0 ? `${q}_item` : `${q}_item${k + 1}`));
    const giverNodeId = `${q}_giver`;
    add(npcEntity(`${q}_giver_npc`, giver));
    // Descriptors: the needed item becomes a composed VARIANT and a same-kind
    // wrong-descriptor distractor travels with it wherever it's placed.
    const axis = params.descriptors
      ? DESCRIPTOR_AXES[Math.floor(rng() * DESCRIPTOR_AXES.length)]!
      : null;
    // Transformations: pick a station kind; the item spawns in the OPPOSITE
    // state (visibly wrong — a cold apple) and the need requires the swap.
    const station: StationKind | null = params.transformations
      ? (["fire", "water"] as const)[Math.floor(rng() * 2)]!
      : null;
    const initialState = station ? STATION_KINDS[station].removes : null;
    const withState = (e: EntityDef): EntityDef =>
      initialState
        ? {
            ...e,
            glyph: `${e.glyph}.${initialState}`,
            label: `${initialState.charAt(0).toUpperCase()}${initialState.slice(1)} ${e.label.toLowerCase()}`,
          }
        : e;
    for (const id of itemIds) {
      add(withState(axis ? variantEntity(id, item, axis.wanted, axis.labels[0]) : itemEntity(id, item)));
    }
    let wrongId: string | null = null;
    if (axis) {
      wrongId = `${q}_wrong`;
      add(variantEntity(wrongId, item, axis.wrong, axis.labels[1]));
      concepts.add(axis.wanted);
    }
    if (count > 1) concepts.add("more");

    const giverNode: FulfillNode = {
      type: "fulfill",
      id: giverNodeId,
      npcEntityId: `${q}_giver_npc`,
      needItemEntityId: itemIds[0]!,
      ...(count > 1 ? { needItemEntityIds: itemIds.slice(1) } : {}),
      needValue: 3,
      ...(complexity === "simple"
        ? { propEntityIds: [...itemIds, ...(wrongId ? [wrongId] : [])] }
        : {}),
      zoneHint: `${giver.label}'s spot`,
    };
    if (containerDrawer) {
      // Task b: a state need — the item goes IN the container by the giver.
      const box = containerDrawer.next();
      const destId = `${q}_dest`;
      add(itemEntity(destId, box));
      giverNode.needPlacedInEntityId = destId;
      concepts.add("in");
    }
    if (station) {
      giverNode.needItemState = STATION_KINDS[station].applies;
      concepts.add(STATION_KINDS[station].applies);
    }
    if (params.giverAnnounce && params.giverAnnounce !== "before") {
      giverNode.announce = params.giverAnnounce;
    }
    if (params.giverAnnounce === "never") {
      // Request c: the want is never SAID — a same-kind KEEPSAKE in exactly
      // the wanted composition (variant + state) stands beside the creature
      // as the evidence, bound so it can never be granted away.
      const keepId = `${q}_keep`;
      const keepBase = axis ? variantEntity(keepId, item, axis.wanted, axis.labels[0]) : itemEntity(keepId, item);
      add(
        station
          ? { ...keepBase, glyph: `${keepBase.glyph}.${STATION_KINDS[station].applies}` }
          : keepBase,
      );
      giverNode.boundEntityIds = [keepId];
      giverNode.thoughtScaffold = params.thoughtScaffold ?? true;
      concepts.add("sad");
    }
    gate(giverNodeId, item.label, giverNode);
    const quest: (typeof quests)[number] = { giver: giverNode, itemIds };
    quests.push(quest);

    if (params.task === "deliver") {
      // Task c: the giver wants the RECIPIENT to have it — the recipient is a
      // real creature with the matching need, in its own room. Handing it the
      // item fulfills BOTH needs at once (the "report back" is the giver's
      // changed projection, not a script).
      const recip = friends.next();
      const recipNodeId = `${q}_recip`;
      add(npcEntity(`${q}_recip_npc`, recip));
      const recipNode: FulfillNode = {
        type: "fulfill",
        id: recipNodeId,
        npcEntityId: `${q}_recip_npc`,
        needItemEntityId: itemIds[0]!,
        ...(count > 1 ? { needItemEntityIds: itemIds.slice(1) } : {}),
        needValue: 3,
        // The recipient wants it in the same TRANSFORMED state the giver asks for.
        ...(station ? { needItemState: STATION_KINDS[station].applies } : {}),
        zoneHint: `${recip.label}'s home`,
      };
      gate(recipNodeId, recip.label, recipNode);
      giverNode.needForNodeId = recipNodeId;
    }

    if (complexity !== "simple") {
      const supplier = friends.next();
      const supplierNodeId = `${q}_supplier`;
      add(npcEntity(`${q}_supplier_npc`, supplier));
      // The distractor variant is vendor DISTRACTOR STOCK: displayed and
      // requestable like anything else, LIKED by the vendor so a mistaken
      // grant is always recoverable via the return-price ("give it back").
      const wrongStock = wrongId ? [wrongId] : [];
      const supplierNode: FulfillNode = {
        type: "fulfill",
        id: supplierNodeId,
        npcEntityId: `${q}_supplier_npc`,
        stockEntityIds: [...itemIds, ...wrongStock],
        likeEntityIds: [...itemIds, ...wrongStock],
        zoneHint: `${supplier.label}'s stall`,
      };
      if (complexity === "request") {
        supplierNode.playerDebt = count; // free vendor: ask and receive each
      } else if (complexity === "exchange") {
        const pay = otherDrawer.next();
        const payId = `${q}_pay`;
        add(itemEntity(payId, pay));
        supplierNode.needItemEntityId = payId; // the price
        supplierNode.needValue = Math.max(2, count); // the debt must cover all
        supplierNode.propEntityIds = [payId]; // the pay lies loose in its room
        // Traders HIDE their need — they only state the price when the player
        // requests the item (or via small talk). "before" is opt-in.
        supplierNode.announce = params.traderAnnounce ?? "after";
        concepts.add("take");
      } else if (complexity === "lend") {
        const lure = otherDrawer.next();
        const lureId = `${q}_lure`;
        add(itemEntity(lureId, lure));
        supplierNode.stockEntityIds = [...itemIds, ...wrongStock, lureId];
        supplierNode.likeEntityIds = [...itemIds, ...wrongStock, lureId];
        supplierNode.playerDebt = 1; // one item out at a time
      }
      gate(supplierNodeId, supplier.label, supplierNode);
      quest.supplier = supplierNode;
    }

    // The station stands where the ITEM starts (the supplier's stall, or the
    // giver's own room for "simple") — get it, transform it, deliver it.
    if (station) {
      (quest.supplier ?? giverNode).stationKinds = [station];
    }
  }

  // Ask-around clue routing (Clues c): the wanter does NOT know where its item
  // is; the fact moves to a KNOWER the player must find. Only supplier-held
  // items qualify (a "simple" quest's item is loose in the wanter's own room).
  // Knower = the next quest's giver (ask a friend), else this quest's supplier
  // — whose self-knowledge ("I have it!") still completes the clue chain.
  if (params.clueRouting === "askAround") {
    for (let i = 0; i < quests.length; i++) {
      const quest = quests[i]!;
      if (!quest.supplier) continue;
      quest.giver.needLocationKnown = false;
      const knower = quests.length > 1 ? quests[(i + 1) % quests.length]!.giver : quest.supplier;
      if (knower !== quest.supplier) {
        knower.knowsItemEntityIds = [...(knower.knowsItemEntityIds ?? []), ...quest.itemIds];
      }
    }
  }

  add({ id: "star", kind: "marker", label: "Star", iconRef: "⭐" });

  return {
    engine: "goal-tree",
    engineVersion: 1,
    meta: {
      title: "Creature Quest Village",
      locale: params.locale ?? "en",
      theme: "friendly village of helpers",
      learningGoals: [...concepts],
      // The play-side dialogue level — the player reads THIS (not a baked
      // string): confusion still drops it live, per conversation.
      ...(params.syntax ? { syntax: params.syntax } : {}),
      seed,
    },
    entities: [...entities.values()],
    root: {
      type: "reach",
      id: "root_star",
      markerEntityId: "star",
      zoneHint: "celebration square",
      via: guards,
    },
  };
}

// ---------------------------------------------------------------------------
// Derivation (client + certifier build the SAME creature world)
// ---------------------------------------------------------------------------

export interface DerivedCreatures {
  world: CreatureWorld;
  /** fulfill node id → creature id (they're identical, kept explicit). */
  creatureByNode: Map<string, CreatureId>;
  /** creature id → its fulfill node. */
  nodeByCreature: Map<CreatureId, FulfillNode>;
}

/** Reconstruct the creature world from a game's fulfill nodes. Deterministic. */
export function creatureWorldFromGame(game: GoalTreeGame): DerivedCreatures {
  const creatures: CreatureSeed[] = [{ id: PLAYER_CREATURE_ID }];
  const items = new Map<string, ItemSeed>();
  const creatureByNode = new Map<string, CreatureId>();
  const nodeByCreature = new Map<CreatureId, FulfillNode>();
  // An item's INITIAL state lives in its entity glyph ("apple.cold") — the
  // one source both the visuals and the rules read.
  const entityGlyph = new Map(game.entities.map((e) => [e.id, e.glyph ?? ""]));
  const initialStates = (id: string): string[] =>
    (entityGlyph.get(id) ?? "").split(".").slice(1).filter((m) => STATE_TAGS.has(m));

  for (const { node } of walkGoalTree(game.root)) {
    if (node.type !== "fulfill") continue;
    const cid: CreatureId = node.id;
    creatureByNode.set(node.id, cid);
    nodeByCreature.set(cid, node);
    const needIds = node.needItemEntityId
      ? [node.needItemEntityId, ...(node.needItemEntityIds ?? [])]
      : [];
    creatures.push({
      id: cid,
      likes: node.likeEntityIds ?? [],
      needs: needIds.map((itemId) => ({
        itemId,
        value: node.needValue ?? 3,
        ...(node.needPlacedInEntityId ? { placedAt: node.needPlacedInEntityId } : {}),
        ...(node.needForNodeId ? { forCreature: node.needForNodeId } : {}),
        ...(node.needItemState ? { requiresState: node.needItemState } : {}),
      })),
      debts: node.playerDebt ? { [PLAYER_CREATURE_ID]: node.playerDebt } : {},
    });
    for (const id of node.stockEntityIds ?? []) {
      items.set(id, { id, ownerId: cid, displayed: true, states: initialStates(id) });
    }
    for (const id of node.boundEntityIds ?? []) {
      items.set(id, { id, ownerId: cid, displayed: true, bound: true, states: initialStates(id) });
    }
    for (const id of node.propEntityIds ?? []) {
      if (!items.has(id)) items.set(id, { id, states: initialStates(id) });
    }
  }
  const world = createCreatureWorld(creatures, [...items.values()]);
  const locate = (itemId: string): { kind: "held"; by: CreatureId } | { kind: "loose" } | null => {
    const item = world.items[itemId];
    if (!item) return null;
    return item.ownerId ? { kind: "held", by: item.ownerId } : { kind: "loose" };
  };
  for (const [cid, node] of nodeByCreature) {
    const creature = world.creatures[cid]!;
    // Seeded third-party knowledge (ask-around clue routing).
    for (const id of node.knowsItemEntityIds ?? []) {
      const where = locate(id);
      if (where && !creature.knowledge[id]) creature.knowledge[id] = where;
    }
    // Puzzle-mode rule: a creature KNOWS where the item it wants is (held by
    // its supplier, or lying loose) — so where-is on the wanter always yields
    // a real clue. Ask-around quests opt OUT (needLocationKnown: false); the
    // generator then routes the fact to a knower instead.
    if (node.needLocationKnown === false) continue;
    for (const need of creature.needs) {
      const where = locate(need.itemId);
      if (where && !creature.knowledge[need.itemId]) creature.knowledge[need.itemId] = where;
    }
  }
  return {
    world,
    creatureByNode,
    nodeByCreature,
  };
}

// ---------------------------------------------------------------------------
// Simulation certifier
// ---------------------------------------------------------------------------

export type CreatureCertification =
  | { ok: true }
  | { ok: false; stage: "game" | "simulation"; errors: string[] };

/**
 * Certify a creature-quest game: the ordinary goal-tree gauntlet (zones, layout,
 * static solver) PLUS a bounded greedy-player simulation over the creature
 * rules — visit every room (sight → knowledge), claim loose props, then per
 * creature: offer what it wants, request what's known, pay stated prices. All
 * needs must fulfill within the round budget. Deterministic, so a pass here is
 * a real playability proof.
 */
export function certifyCreatureQuestWorld(game: GoalTreeGame): CreatureCertification {
  const cert = certifyGoalTreeGame(game);
  if (!cert.ok) return { ok: false, stage: "game", errors: cert.errors };

  const { world, nodeByCreature } = creatureWorldFromGame(game);
  const creatureIds = [...nodeByCreature.keys()].sort();

  // Clue-chain guarantee: when a wanter is seeded NOT to know its item's
  // location (ask-around), some OTHER creature must know it — else where-is is
  // a dead end everywhere. (An owner's self-knowledge counts: "I have it!")
  const clueGaps: string[] = [];
  for (const cid of creatureIds) {
    const node = nodeByCreature.get(cid)!;
    if (node.needLocationKnown !== false || !node.needItemEntityId) continue;
    for (const itemId of [node.needItemEntityId, ...(node.needItemEntityIds ?? [])]) {
      if (!creatureIds.some((other) => other !== cid && world.creatures[other]!.knowledge[itemId])) {
        clueGaps.push(`no creature can answer where-is for "${itemId}"`);
      }
    }
  }
  if (clueGaps.length > 0) return { ok: false, stage: "simulation", errors: clueGaps };

  // Transformation guarantee: every required state has a station somewhere
  // that applies it — else the need is physically unreachable.
  const stationApplies = new Set<string>();
  for (const node of nodeByCreature.values()) {
    for (const kind of node.stationKinds ?? []) stationApplies.add(STATION_KINDS[kind].applies);
  }
  const stateGaps = creatureIds
    .map((cid) => nodeByCreature.get(cid)!)
    .filter((node) => node.needItemState && !stationApplies.has(node.needItemState))
    .map((node) => `required state "${node.needItemState}" has no station that applies it`);
  if (stateGaps.length > 0) return { ok: false, stage: "simulation", errors: stateGaps };

  // Inference guarantee (Request c): a never-announcing wanter must stage
  // same-kind EVIDENCE (a bound keepsake) — else nothing points at the want.
  const glyphHead = (entityId: string): string =>
    (game.entities.find((e) => e.id === entityId)?.glyph ?? entityId).split(".")[0]!;
  const evidenceGaps = creatureIds
    .map((cid) => nodeByCreature.get(cid)!)
    .filter((node) => node.announce === "never" && node.needItemEntityId)
    .filter((node) => {
      const head = glyphHead(node.needItemEntityId!);
      return !(node.boundEntityIds ?? []).some((id) => glyphHead(id) === head);
    })
    .map((node) => `"${node.id}" never announces its need but stages no same-kind evidence`);
  if (evidenceGaps.length > 0) return { ok: false, stage: "simulation", errors: evidenceGaps };

  for (let round = 0; round < 8; round++) {
    for (const cid of creatureIds) {
      const node = nodeByCreature.get(cid)!;
      // Visit the room: displayed stock + the creature's holdings are SEEN...
      for (const item of Object.values(world.items)) {
        if (item.ownerId === cid && item.displayed) {
          seeItem(world, PLAYER_CREATURE_ID, item.id, { kind: "held", by: cid });
        }
      }
      // ...and loose props get picked up on the way in.
      for (const id of node.propEntityIds ?? []) {
        if (world.items[id]?.ownerId === null) {
          claimItem(world, PLAYER_CREATURE_ID, id, { takerAcceptsAnything: true });
        }
      }
      // Converse purposefully: offer its want, then request only items some
      // creature still NEEDS (the certifying player doesn't window-shop — a
      // real child may borrow lures and return them; solvability needs only
      // the direct path), and satisfy any stated price the same visit.
      for (let step = 0; step < 6; step++) {
        const creature = world.creatures[cid]!;
        const need = openNeeds(creature)[0];
        if (need && world.items[need.itemId]?.ownerId === PLAYER_CREATURE_ID) {
          if (need.requiresState && !world.items[need.itemId]!.states.includes(need.requiresState)) {
            // Detour to a station first (the pre-check guarantees one exists).
            const kind = (Object.keys(STATION_KINDS) as StationKind[]).find(
              (k) => STATION_KINDS[k].applies === need.requiresState,
            );
            if (kind) {
              applyTransform(world, need.itemId, STATION_KINDS[kind].applies, STATION_KINDS[kind].removes);
            }
          }
          if (need.placedAt) {
            // A state need: the sim walks over and PLACES it (no physics here;
            // the player verifies the real drop via containedIn).
            notePlacement(world, PLAYER_CREATURE_ID, need.itemId, need.placedAt);
          } else if (need.forCreature) {
            // An on-behalf need: the delivery goes to the RECIPIENT (which
            // also settles this creature's need via settleOnBehalfNeeds).
            giveItem(world, PLAYER_CREATURE_ID, need.forCreature, need.itemId);
          } else {
            giveItem(world, PLAYER_CREATURE_ID, cid, need.itemId);
          }
          settleObligations(world, cid); // it may now owe a previously-asked item
          for (const p of pendingTransfers(world, cid)) {
            if (p.pendingTransferTo === PLAYER_CREATURE_ID) concludeTransfer(world, PLAYER_CREATURE_ID, p.id);
          }
          continue;
        }
        const neededSomewhere = new Set<string>();
        for (const other of Object.values(world.creatures)) {
          for (const n of openNeeds(other)) neededSomewhere.add(n.itemId);
        }
        const wanted = Object.values(world.items)
          .filter((i) => i.ownerId === cid && !i.bound && neededSomewhere.has(i.id))
          .map((i) => i.id)
          .sort()
          .find((id) => world.creatures[PLAYER_CREATURE_ID]!.knowledge[id] !== undefined);
        if (!wanted) break;
        // The sim's "take" happens immediately after any agreement (no physics).
        const takePending = () => {
          for (const p of pendingTransfers(world, cid)) {
            if (p.pendingTransferTo === PLAYER_CREATURE_ID) {
              concludeTransfer(world, PLAYER_CREATURE_ID, p.id);
            }
          }
        };
        const out = requestItem(world, PLAYER_CREATURE_ID, cid, wanted);
        takePending();
        if (out.kind === "accept") continue;
        if (out.kind === "price" && out.price.kind === "return") {
          const back = world.items[out.price.itemId];
          if (back?.ownerId === PLAYER_CREATURE_ID && !neededSomewhere.has(out.price.itemId)) {
            giveItem(world, PLAYER_CREATURE_ID, cid, out.price.itemId);
            settleObligations(world, cid);
            takePending();
            continue;
          }
        }
        break; // price we can't pay yet (its need — handled when we hold the item)
      }
    }
    const unmet = creatureIds.filter((cid) => openNeeds(world.creatures[cid]!).length > 0);
    if (unmet.length === 0) return { ok: true };
  }

  const unmet = creatureIds
    .filter((cid) => openNeeds(world.creatures[cid]!).length > 0)
    .map((cid) => {
      const need = openNeeds(world.creatures[cid]!)[0]!;
      return `creature "${cid}" still needs "${need.itemId}"`;
    });
  return { ok: false, stage: "simulation", errors: unmet };
}
