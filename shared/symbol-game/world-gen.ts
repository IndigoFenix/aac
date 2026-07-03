// shared/symbol-game/world-gen.ts
//
// The QUEST-WORLD generator: puzzle-dimension parameters → one certified-able
// GoalTreeGame containing several GET-ITEM quests (dialogue-gen.ts), each an
// NPC room hanging off a village square, all gating the celebration star.
//
// Tree shape:
//   root = reach(star) via [ one overcome per conversation ]
// Every converse is a via-guard key, so (per logical-world's rules) each NPC
// gets its own room off the START zone, and the star's door opens only when
// every conversation has completed. The star sits in its own room behind that
// door — walk to it to win.
//
// Determinism: pass `rng` (e.g. a seeded PRNG) for reproducible worlds; pool
// draws prefer registry-SHIPPED members and never repeat a member within a
// world (items must be distinct anyway — the schema forbids two quests
// consuming the same entity, and distinct members keep the lessons readable).

import type { EntityDef, GoalTreeGame, OvercomeNode } from "../goal-tree/types.js";
import type { PoolDef, PoolMember } from "./types.js";
import { POOLS } from "./pools.js";
import { mulberry32, randomSeed } from "../prng.js";
import {
  generateGetItemQuest,
  type GetItemQuestSpec,
  type QuestComplexity,
  type SyntaxLevel,
} from "./dialogue-gen.js";

export interface SymbolWorldParams {
  /** How many quests (clamped by NPC supply — request/exchange use 2 NPCs each). */
  questCount?: number;
  /** Syntax level the dialogues open at. Default "b". */
  syntax?: SyntaxLevel;
  /** Quest shape, or "mixed" to cycle simple → request → exchange. Default "simple". */
  complexity?: QuestComplexity | "mixed";
  /** Exchange quests: trader states the price unprompted ("before", default) or
   *  only after the player requests the item ("after"). */
  traderAnnounce?: "before" | "after";
  /** World seed — reproduces generator draws AND the downstream layout/
   *  building stages (recorded on `meta.seed`). Omitted → random, recorded. */
  seed?: number;
  /** Explicit random source — overrides `seed` for the generator draws. */
  rng?: () => number;
  /** Pools to draw from (default the shared POOLS). */
  pools?: Record<string, PoolDef>;
}

/** Shipped-first shuffle of a pool's members (queued symbols may not render yet). */
function shuffledMembers(pool: PoolDef, rng: () => number): PoolMember[] {
  const shipped = pool.members.filter((m) => m.glyphStatus !== "queued");
  const queued = pool.members.filter((m) => m.glyphStatus === "queued");
  const shuffle = (arr: PoolMember[]) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  return [...shuffle(shipped), ...shuffle(queued)];
}

/** Draws members without repetition, cycling only when the pool runs dry. */
class Drawer {
  private queue: PoolMember[];
  private i = 0;
  constructor(pool: PoolDef, rng: () => number) {
    this.queue = shuffledMembers(pool, rng);
  }
  next(): PoolMember {
    const m = this.queue[this.i % this.queue.length]!;
    this.i += 1;
    return m;
  }
  /** Peek at unused members (for vendor distractor asks). */
  rest(count: number): PoolMember[] {
    const out: PoolMember[] = [];
    for (let k = this.i; k < this.queue.length && out.length < count; k++) {
      out.push(this.queue[k]!);
    }
    return out;
  }
}

/**
 * Build a multi-quest symbol world. The result is an ordinary GoalTreeGame —
 * run it through `certifyGoalTreeGame` (the player does this on load) for the
 * full schema → solver → layout gauntlet.
 */
export function buildSymbolWorld(params: SymbolWorldParams = {}): GoalTreeGame {
  const seed = params.seed ?? randomSeed();
  const rng = params.rng ?? mulberry32(seed);
  const pools = params.pools ?? POOLS;
  const syntax = params.syntax ?? "b";
  const friendPool = pools.friend;
  const itemPools = [pools.treat, pools.toy].filter((p): p is PoolDef => !!p);
  if (!friendPool || itemPools.length < 2) {
    throw new Error("buildSymbolWorld needs the friend, treat and toy pools");
  }

  const complexityFor = (i: number): QuestComplexity => {
    if (params.complexity === "mixed") {
      return (["simple", "request", "exchange"] as const)[i % 3]!;
    }
    return params.complexity ?? "simple";
  };

  // Clamp the quest count so every NPC in the world is a distinct friend.
  const requested = Math.max(1, Math.min(4, Math.floor(params.questCount ?? 2)));
  let questCount = 0;
  let npcsNeeded = 0;
  for (let i = 0; i < requested; i++) {
    const need = complexityFor(i) === "simple" ? 1 : 2;
    if (npcsNeeded + need > friendPool.members.length) break;
    npcsNeeded += need;
    questCount += 1;
  }
  if (questCount === 0) questCount = 1;

  const friends = new Drawer(friendPool, rng);
  const drawers = itemPools.map((p) => new Drawer(p, rng));

  const entities = new Map<string, EntityDef>();
  const addEntities = (list: EntityDef[]) => {
    for (const e of list) if (!entities.has(e.id)) entities.set(e.id, e);
  };
  const guards: OvercomeNode[] = [];
  const concepts = new Set<string>();

  for (let i = 0; i < questCount; i++) {
    const complexity = complexityFor(i);
    const itemDrawer = drawers[i % drawers.length]!;
    const payDrawer = drawers[(i + 1) % drawers.length]!;
    const item = itemDrawer.next();

    const spec: GetItemQuestSpec = {
      id: `q${i}`,
      level: syntax,
      complexity,
      giver: friends.next(),
      item,
      ...(complexity !== "simple" ? { supplier: friends.next() } : {}),
      ...(complexity === "exchange" ? { pay: payDrawer.next(), announce: params.traderAnnounce } : {}),
      ...(complexity === "lend" ? { lend: payDrawer.next() } : {}),
      ...(complexity === "request" ? { distractorAsks: itemDrawer.rest(2) } : {}),
    };
    const quest = generateGetItemQuest(spec);
    addEntities(quest.entities);
    for (const c of quest.concepts) concepts.add(c);

    // One star-door guard per conversation; the lock wears the quest item's
    // icon so the door reads "these quests open me".
    quest.converses.forEach((converse, j) => {
      const gateEntityId = `${spec.id}_gate_${j}`;
      addEntities([
        {
          id: gateEntityId,
          kind: "obstacle",
          label: `${item.label} lock`,
          iconRef: "🔒",
        },
      ]);
      guards.push({
        type: "overcome",
        id: `${spec.id}_overcome_${j}`,
        obstacleEntityId: gateEntityId,
        key: converse,
      });
    });
  }

  addEntities([{ id: "star", kind: "marker", label: "Star", iconRef: "⭐" }]);

  return {
    engine: "goal-tree",
    engineVersion: 1,
    meta: {
      title: "Symbol Quest Village",
      locale: "en",
      theme: "friendly village of helpers",
      learningGoals: [...concepts],
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
