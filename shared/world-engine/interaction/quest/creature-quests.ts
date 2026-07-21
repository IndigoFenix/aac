// shared/world-engine/interaction/quest/creature-quests.ts
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

import { certifyGoalTreeGame } from "../../solver/index.js";
import type { FulfillNode, GoalTreeGame, OvercomeNode, EntityDef, StationKind, FulfillCausalFact, FulfillNeedTarget } from "../../solver/types.js";
import { STATION_KINDS } from "../../solver/types.js";
import { walkGoalTree } from "../../solver/walk.js";
import {
  claimItem,
  concludeTransfer,
  createCreatureWorld,
  DEVICE_ANTONYM,
  giveItem,
  noteArrival,
  notePlacement,
  openNeeds,
  pendingTransfers,
  powerUp,
  requestItem,
  seeItem,
  settleObligations,
  STATE_TAGS,
  toggleDevice,
  useStation,
  type CausalFact,
  type Clause,
  type CreatureId,
  type CreatureSeed,
  type CreatureWorld,
  type ItemSeed,
} from "@shared/world-engine/interaction/behavior/creatures.js";
import type { PoolDef, PoolMember } from "@shared/world-engine/interaction/types.js";
import { KIND_CATEGORY, POOLS } from "@shared/world-engine/interaction/content/pools.js";
import { mulberry32, randomSeed } from "@shared/prng.js";
import type { QuestComplexity, SyntaxLevel } from "@shared/world-engine/interaction/dialogue/dialogue-gen.js";

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
   * v1 CAUSATION (causation-and-elements.md §4.4): attach a `because` fact to
   * each plain possession-need giver, so it can explain WHY it's sad ("i_me +
   * sad + because + i_me + have.not + {item}") and answer the WHY act. Pure
   * narration — certification is invariant to it. Skipped for placement /
   * on-behalf / transformed needs in v1 (those get their own frames later).
   */
  giverCausalWhy?: boolean;
  /**
   * v2 CAUSATION (causation-and-elements.md §4.3, step 2): give each DELIVER
   * (on-behalf) giver an `in_order_to` PURPOSE, so its LINE states the remedy
   * AND the goal — "give {thing} to {recip} + in_order_to + {recip} + happy"
   * (renders stacked via the two-clause split). Requires task: "deliver";
   * narration only, so certification is invariant to it.
   */
  deliverCausalPurpose?: boolean;
  /**
   * Step 4a CREATURE-STATE (causation-and-elements.md §5): give each giver a bad
   * SELF-CONDITION ("cold"). Its line leads with it — "i_me + want + {remedy} +
   * because + i_me + cold" — and the condition CLEARS when the need fulfills
   * (the getting-better demonstration, `condition-changed`). Pairs naturally
   * with `transformations: true` so the remedy is a hot item ("bring me a hot
   * apple because i'm cold"). Skipped on placement / deliver / never-announce.
   */
  giverCondition?: string;
  /**
   * Motive REVELATION level (§C, motive-driven-needs.md): how much a
   * `giverCondition` creature says — "want" (states the want, WHY reveals the
   * motive), "because" (want because motive — default), "motive" (just "I am
   * cold"; the player infers the want).
   */
  giverReveal?: "want" | "because" | "motive";
  /**
   * Step 4b DEVICES (§5): make each giver's need a DEVICE-STATE need — its item
   * is a fixed device (from the `device` pool) spawned in the opposite state,
   * and the need is to TOGGLE it to this one ("closed"/"on"). The giver's line
   * is "i_me + want + {device} + {state}"; WHY reveals "i_me + sad + because +
   * {device} + {badState}". Pairs with `giverCondition` (the P2 "cold because
   * the window is open" puzzle — the toggle clears the condition). Simple only.
   */
  giverDeviceNeed?: "on" | "off" | "open" | "closed";
  /**
   * POWER chain (§5): put a GENERATOR behind the device need — the device is
   * `poweredBy` it, so the player must switch the generator ON before the device
   * will turn on (a multi-step chain), and WHY reveals "sad because generator
   * off". Requires giverDeviceNeed. The generator itself can be extended into a
   * deeper switch→generator chain (poweredBy is recursive).
   */
  giverDevicePowered?: boolean;
  /**
   * P1 station-gating (§5): with `transformations`, gate the STATION on a
   * GENERATOR — it won't cool/heat the item until the player switches the
   * generator ON ("power the fridge to cool the food"). A real gate (`useStation`
   * no-ops unpowered), so the power step is a proven part of the solution. WHY
   * reveals "sad because generator off". Simple quests only.
   */
  giverStationPowered?: boolean;
  /**
   * Step 4c PLACES (§5): make each giver's need a PRESENCE (go-to) need — it
   * wants the player to GO to another creature ("you + go + to + Bear"),
   * fulfilled on arrival (`noteArrival`). The destination is a needless NPC in
   * its own zone. Simple quests only; needs 2 friends per quest (giver + dest).
   */
  giverGoToPlace?: boolean;
  /**
   * MOTIVE-BATCH presets (one param, ten shapes — see GiverMotive): give each
   * giver a flavored want + the WHY that explains it. "hungry"/"lonely" set a
   * self-CONDITION (cleared on remedy); "likes-*"/"play"/"music"/"read"/"wear"
   * attach a preference/desire WHY fact; "smelly" is an outdoor-garbage
   * placement; "escort" a follow-me presence need. Composes with giverReveal
   * (want/motive) for the condition-driven ones.
   */
  giverMotive?: GiverMotive;
  /**
   * World seed. One seed reproduces the WHOLE village: generator draws here,
   * plus the downstream layout/buildings/colors stages (they read it back from
   * `meta.seed`). Omitted → a random seed is drawn and still recorded.
   */
  seed?: number;
  /** Explicit random source — overrides `seed` for the generator draws. */
  rng?: () => number;
  pools?: Record<string, PoolDef>;
  /**
   * World-engine building TEMPLATE the (star-shaped) quest maps onto:
   *   "village" (default) — a plaza ringed by separate houses.
   *   "house"             — ONE building, every giver a color ROOM off a central
   *                         hall (the one-building household). Recorded on
   *                         meta.layout so certifier + client derive it alike.
   */
  layout?: "village" | "house";
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
type DescriptorAxis = (typeof DESCRIPTOR_AXES)[number];

/**
 * A CONDITION → the WANT it generates (motive-driven-needs.md §4): a parameter
 * TARGET (kind-less — "something hot" / "food") plus what makes it satisfiable:
 * a STATION that produces the required state (cold → fire), or the item POOL
 * whose members carry the required category (hungry → treat). clean/dirty +
 * wet/dry join when their glyphs ship.
 */
const MOTIVE_WANT: Record<string, { target: FulfillNeedTarget; station?: StationKind; pool?: string }> = {
  cold: { target: { state: "hot" }, station: "fire" },
  hot: { target: { state: "cold" }, station: "water" },
  hungry: { target: { category: "food" }, pool: "treat" },
};

/**
 * The MOTIVE-BATCH quest presets (one param, ten shapes): each entry picks the
 * want SHAPE (an exact item, a category/kind/descriptor target, a placement,
 * or a presence flavor) and the WHY that explains it. Pure composition over
 * the existing elements — see CreatureWorldParams.giverMotive.
 */
export type GiverMotive =
  | "hungry" // condition; wants "food" (any treat)
  | "likes-item" // exact item; WHY "because I like {item}"
  | "likes-color" // wants "something {color}"; WHY "because I like {color}"
  | "play" // wants a toy; WHY "because I want to play"
  | "music" // wants an instrument; WHY "because I want to play"
  | "read" // wants a book; WHY "because I want to read"
  | "wear" // wants clothing; WHY "because I want to get dressed"
  | "smelly" // smelly food → the OUTDOOR garbage; WHY "because it smells bad"
  | "lonely" // condition; wants the player to STAY a while
  | "escort"; // "take me to {B}" — the giver follows and must arrive

/** Category/kind targets + WHY verbs for the desire-flavored motives. */
const MOTIVE_TARGETS: Record<string, { target: FulfillNeedTarget; verb: string; pool: string }> = {
  play: { target: { category: "toy" }, verb: "play", pool: "toy" },
  music: { target: { category: "instrument" }, verb: "play", pool: "instrument" },
  read: { target: { kind: "book" }, verb: "read", pool: "reading" },
  wear: { target: { category: "clothing" }, verb: "wear", pool: "clothing" },
};

/** The item pool each motive draws its quest item from ("none" = itemless). */
const MOTIVE_POOL: Record<string, string | undefined> = {
  hungry: "treat",
  "likes-item": "treat",
  "likes-color": "toy",
  play: "toy",
  music: "instrument",
  read: "reading",
  wear: "clothing",
  smelly: "treat",
  lonely: undefined,
  escort: undefined,
};

// ---------------------------------------------------------------------------
// composeNeed — recombinable ELEMENTS → one creature's need
// (causation-and-elements.md §2). buildCreatureQuestWorld draws the element
// slots (RNG lives there) and hands them here; this is a PURE assembler, so a
// new need kind / element plugs in by extending THIS, not the generator body.
// Behavior is identical to the inline construction it replaced.
// ---------------------------------------------------------------------------

/** A causal FRAME (§4): which two-clause narration to attach to a need. Its
 *  compatibility with the need SHAPE is a table (causalFrameCompatible), checked
 *  fail-fast. `because-lack-item` resolves here (it references the need's own
 *  item); `in-order-to-recipient-happy` is applied by the deliver quest shape,
 *  which owns the recipient node id. */
export type CausalFrameKind =
  | "because-lack-item"
  | "because-self-condition"
  | "because-device-state"
  | "because-likes" // preference: "…because I like {item|facet}" (motive batch)
  | "because-wants-to" // desire: "…because I want to {verb}" (motive batch)
  | "because-item-state" // spoiled: "…because {item} smells bad" (motive batch)
  | "in-order-to-recipient-happy";

/** Fail-fast compatibility: a frame only attaches to a compatible need shape. */
export function causalFrameCompatible(
  frame: CausalFrameKind,
  need: Pick<
    FulfillNode,
    "needPlacedInEntityId" | "needItemState" | "needForNodeId" | "needDeviceState" | "announce"
  >,
): boolean {
  switch (frame) {
    case "because-lack-item":
      // A plain possession need only — never a placement/transform/deliver, and
      // not a hidden (never-announced) want (§8 Q2).
      return (
        !need.needPlacedInEntityId &&
        !need.needItemState &&
        !need.needForNodeId &&
        need.announce !== "never"
      );
    case "because-self-condition":
      // A want the creature LEADS with ("want {remedy} because i_me cold") — a
      // possession or TRANSFORMED (hot remedy) need, stated (not hidden), and
      // not a placement/on-behalf (whose line has no plain-want branch).
      return !need.needPlacedInEntityId && !need.needForNodeId && need.announce !== "never";
    case "because-likes":
    case "because-wants-to":
      // Preference/desire WHYs ride a STATED possession-branch want, exactly
      // like the self-condition frame.
      return !need.needPlacedInEntityId && !need.needForNodeId && need.announce !== "never";
    case "because-item-state":
      // The item's own bad state explains the ask — a stated placement ("take
      // the smelly food to the garbage") or plain want; never on-behalf.
      return !need.needForNodeId && need.announce !== "never";
    case "because-device-state":
      return !!need.needDeviceState; // "i_me sad because {device} {badState}" (WHY)
    case "in-order-to-recipient-happy":
      return !!need.needForNodeId; // a deliver (on-behalf) need
  }
}

/** The element slots for ONE giver's need — the recombiner's inputs. */
interface ComposeNeedSpec {
  /** Quest id prefix — seeds the node/entity ids ("q0"). */
  q: string;
  /** WHO supplies (simple → the item lies loose in the giver's own room). */
  questShape: QuestComplexity;
  giver: PoolMember; // PEOPLE slot
  item: PoolMember; // THING slot
  count: number; // counted need (1–3 instances of the one kind)
  descriptor: DescriptorAxis | null; // THING variant (Item b)
  station: StationKind | null; // STATE (Transformations b)
  container: PoolMember | null; // PLACE/container (placement need, Task b)
  announce: "before" | "after" | "never" | undefined;
  thoughtScaffold: boolean;
  needValue: number;
  /** A bad SELF-CONDITION ("cold") — sets node.condition (§5). Takes precedence
   *  over `because`. */
  condition: string | null;
  /** The MOTIVE-generated want predicate (§C): "something hot" for cold. */
  motiveTarget: FulfillNeedTarget | null;
  /** Revelation level for the motive want (§4): want / because / motive. */
  reveal: "want" | "because" | "motive" | undefined;
  /** A DEVICE-STATE need (§5): the `item` is a fixed DEVICE and the need is to
   *  TOGGLE it to this state ("closed"/"on"). Spawns it in the opposite (bad)
   *  state + a because-device-state WHY frame. Standalone (own quest shape). */
  deviceTargetState: string | null;
  /** POWER chain (§5): a GENERATOR that powers the device — the device becomes
   *  `poweredBy` it, so the player switches the generator on FIRST. The WHY then
   *  reveals the generator ("sad because generator off"). Device needs only. */
  deviceGenerator: PoolMember | null;
  /** PRESENCE (go-to) need (§5): the giver wants the player to GO to this
   *  destination fulfill node — no item. Standalone (own quest shape). */
  goToNodeId: string | null;
  /** ESCORT flavor (motive batch) on goToNodeId: the GIVER itself must reach
   *  the destination ("take me to Bear") — it follows the player there. */
  escort: boolean;
  /** STAY-WITH need (motive batch): no item — the player's COMPANY is the
   *  remedy ("stay with me because I'm lonely"). Standalone; returns early. */
  stayWith: boolean;
  /** Bake this STATE tag onto the item's spawn glyph ("smelly") and attach the
   *  matching because-item-state WHY ("…because it smells bad"). */
  itemBakedState: string | null;
  /** Stage the placement container OUTDOORS (the plaza) — the smelly-food
   *  quest's "take it OUT to the garbage". Container quests only. */
  placedOutdoors: boolean;
  /** Attach "because I like {item}" (the exact-want preference WHY). */
  likesItem: boolean;
  /** Attach "because I like {facet}" (facet = the wanted descriptor, e.g.
   *  "color_red") — the quality-want preference WHY. */
  likesFacet: string | null;
  /** Attach "because I want to {verb}" (play/read/wear) — the desire WHY. */
  wantsToVerb: string | null;
  /** Attach the `because-lack-item` frame (compat-checked). */
  because: boolean;
}

interface ComposedNeed {
  node: FulfillNode;
  /** In insertion order: giver npc, item instance(s), wrong variant, dest, keepsake. */
  entities: EntityDef[];
  concepts: string[];
  itemIds: string[];
  /** The wrong-descriptor distractor id (Item b) — the quest shape stocks it. */
  wrongId: string | null;
}

function composeNeed(spec: ComposeNeedSpec): ComposedNeed {
  const { q, questShape, giver, item, count, descriptor: axis, station, container } = spec;
  const entities: EntityDef[] = [];
  const concepts: string[] = [];
  const giverNpcId = `${q}_giver_npc`;
  entities.push(npcEntity(giverNpcId, giver));

  // STAY-WITH need (motive batch): "you + stay + with + i_me" — no item, no
  // destination; the player's dwelt COMPANY is the remedy. Returns early.
  if (spec.stayWith) {
    const node: FulfillNode = {
      type: "fulfill",
      id: `${q}_giver`,
      npcEntityId: giverNpcId,
      needValue: spec.needValue,
      needStayWith: true,
      ...(spec.condition ? { condition: spec.condition } : {}),
      zoneHint: `${giver.label}'s spot`,
    };
    node.motiveReveal = spec.reveal ?? "want";
    if (spec.announce && spec.announce !== "before") node.announce = spec.announce;
    concepts.push("stay", "with");
    if (spec.condition) concepts.push(spec.condition);
    return { node, entities, concepts, itemIds: [], wrongId: null };
  }

  // PRESENCE (go-to) need (§5): "you + go + to + {dest}" — no item; the
  // destination is a needless creature the orchestrator stages. The ESCORT
  // flavor (motive batch) sends the GIVER there instead: "take me to {dest}".
  if (spec.goToNodeId) {
    const node: FulfillNode = {
      type: "fulfill",
      id: `${q}_giver`,
      npcEntityId: giverNpcId,
      needValue: spec.needValue,
      needAtPlaceNodeId: spec.goToNodeId,
      ...(spec.escort ? { needEscort: true } : {}),
      zoneHint: `${giver.label}'s spot`,
    };
    if (spec.announce && spec.announce !== "before") node.announce = spec.announce;
    concepts.push(...(spec.escort ? ["take", "to"] : ["go", "to"]));
    return { node, entities, concepts, itemIds: [], wrongId: null };
  }

  // DEVICE-STATE need (§5): the "item" is a fixed DEVICE spawned in its bad
  // state; the need is to TOGGLE it to the good one. Self-contained (no
  // descriptors/stations/counting) — returns early.
  if (spec.deviceTargetState) {
    const badState = DEVICE_ANTONYM[spec.deviceTargetState] ?? "off";
    const deviceId = `${q}_item`;
    entities.push({ ...itemEntity(deviceId, item), glyph: `${item.symbol}.${badState}` });
    const props = [deviceId];
    // Power chain: a GENERATOR (spawned OFF) the device is poweredBy.
    let genId: string | undefined;
    if (spec.deviceGenerator) {
      genId = `${q}_gen`;
      entities.push({ ...itemEntity(genId, spec.deviceGenerator), glyph: `${spec.deviceGenerator.symbol}.off` });
      props.push(genId);
    }
    const node: FulfillNode = {
      type: "fulfill",
      id: `${q}_giver`,
      npcEntityId: giverNpcId,
      needItemEntityId: deviceId,
      needValue: spec.needValue,
      needDeviceState: spec.deviceTargetState,
      ...(genId ? { powerDeviceEntityId: genId } : {}),
      ...(questShape === "simple" ? { propEntityIds: props } : {}),
      ...(spec.condition ? { condition: spec.condition } : {}),
      zoneHint: `${giver.label}'s spot`,
    };
    if (spec.announce && spec.announce !== "before") node.announce = spec.announce;
    if (!causalFrameCompatible("because-device-state", node)) {
      throw new Error(`composeNeed: because-device-state frame incompatible with need "${node.id}"`);
    }
    // WHY reveals the blocker: the GENERATOR being off (teaches the chain) when
    // there is one, else the device's own bad state.
    node.causalFact = genId
      ? { connective: "because", cause: { kind: "itemState", itemEntityId: genId, state: "off" } }
      : { connective: "because", cause: { kind: "itemState", itemEntityId: deviceId, state: badState } };
    concepts.push("because", spec.deviceTargetState);
    if (genId) concepts.push("on");
    if (spec.condition) concepts.push(spec.condition);
    return { node, entities, concepts, itemIds: [deviceId], wrongId: null };
  }

  // Multi-item needs: N instances of ONE kind (same symbol, distinct entities).
  const itemIds = Array.from({ length: count }, (_, k) => (k === 0 ? `${q}_item` : `${q}_item${k + 1}`));
  // The spawn state baked into the entity glyph: a station's opposite (the
  // cold not-yet-heated apple), or an explicit bad state (the smelly food).
  const initialState = spec.itemBakedState ?? (station ? STATION_KINDS[station].removes : null);
  const withState = (e: EntityDef): EntityDef =>
    initialState
      ? {
          ...e,
          glyph: `${e.glyph}.${initialState}`,
          label: `${initialState.charAt(0).toUpperCase()}${initialState.slice(1)} ${e.label.toLowerCase()}`,
        }
      : e;
  for (const id of itemIds) {
    entities.push(withState(axis ? variantEntity(id, item, axis.wanted, axis.labels[0]) : itemEntity(id, item)));
  }
  let wrongId: string | null = null;
  if (axis) {
    wrongId = `${q}_wrong`;
    entities.push(variantEntity(wrongId, item, axis.wrong, axis.labels[1]));
    concepts.push(axis.wanted);
  }
  if (count > 1) concepts.push("more");

  const node: FulfillNode = {
    type: "fulfill",
    id: `${q}_giver`,
    npcEntityId: giverNpcId,
    needItemEntityId: itemIds[0]!,
    ...(count > 1 ? { needItemEntityIds: itemIds.slice(1) } : {}),
    needValue: spec.needValue,
    ...(questShape === "simple" ? { propEntityIds: [...itemIds, ...(wrongId ? [wrongId] : [])] } : {}),
    zoneHint: `${giver.label}'s spot`,
  };
  if (container) {
    // Task b: a state need — the item goes IN the container by the giver
    // (or OUTDOORS in the plaza, for the smelly-food garbage run).
    const destId = `${q}_dest`;
    entities.push(itemEntity(destId, container));
    node.needPlacedInEntityId = destId;
    if (spec.placedOutdoors) node.needPlacedOutdoors = true;
    concepts.push("in");
  }
  if (station) {
    node.needItemState = STATION_KINDS[station].applies;
    concepts.push(STATION_KINDS[station].applies);
  }
  if (spec.announce && spec.announce !== "before") node.announce = spec.announce;
  if (spec.announce === "never") {
    // Request c: the want is never SAID — a same-kind KEEPSAKE in exactly the
    // wanted composition stands beside the creature as the evidence, bound so it
    // can never be granted away.
    const keepId = `${q}_keep`;
    const keepBase = axis ? variantEntity(keepId, item, axis.wanted, axis.labels[0]) : itemEntity(keepId, item);
    entities.push(station ? { ...keepBase, glyph: `${keepBase.glyph}.${STATION_KINDS[station].applies}` } : keepBase);
    node.boundEntityIds = [keepId];
    node.thoughtScaffold = spec.thoughtScaffold;
    concepts.push("sad");
  }
  // A parameter TARGET stands on its own (condition-driven "something hot" AND
  // desire-driven "a toy"/"a book" wants both use it).
  if (spec.motiveTarget) node.needTarget = { ...spec.motiveTarget };
  if (spec.condition) {
    // MOTIVE need (§C): the creature's condition drives a parameter want
    // ("something hot" for cold, "food" for hungry), staged as a satisfiable
    // item (station/pool forced by the orchestrator). The projection verbalizes
    // it at the reveal level — no causal fact; the motive↔want link is intrinsic.
    node.condition = spec.condition;
    node.motiveReveal = spec.reveal ?? "want";
    concepts.push(spec.condition);
    if (node.motiveReveal !== "motive") concepts.push("want");
    if (node.motiveReveal === "because") concepts.push("because");
  } else if (spec.likesItem || spec.likesFacet) {
    // PREFERENCE WHY (motive batch): "…because I like {item|facet}".
    if (!causalFrameCompatible("because-likes", node)) {
      throw new Error(`composeNeed: because-likes frame incompatible with need "${node.id}"`);
    }
    node.causalFact = {
      connective: "because",
      cause: spec.likesFacet ? { kind: "likes", facet: spec.likesFacet } : { kind: "likes", itemEntityId: itemIds[0]! },
    };
    concepts.push("because", "like");
  } else if (spec.wantsToVerb) {
    // DESIRE WHY (motive batch): "…because I want to {play|read|wear}".
    if (!causalFrameCompatible("because-wants-to", node)) {
      throw new Error(`composeNeed: because-wants-to frame incompatible with need "${node.id}"`);
    }
    node.causalFact = { connective: "because", cause: { kind: "wantsTo", verb: spec.wantsToVerb } };
    concepts.push("because", spec.wantsToVerb);
  } else if (spec.itemBakedState) {
    // SPOILED-ITEM WHY (motive batch): "…because {item} smells bad".
    if (!causalFrameCompatible("because-item-state", node)) {
      throw new Error(`composeNeed: because-item-state frame incompatible with need "${node.id}"`);
    }
    node.causalFact = {
      connective: "because",
      cause: { kind: "itemState", itemEntityId: itemIds[0]!, state: spec.itemBakedState },
    };
    concepts.push("because", spec.itemBakedState);
  } else if (spec.because) {
    if (!causalFrameCompatible("because-lack-item", node)) {
      throw new Error(`composeNeed: because-lack-item frame incompatible with need "${node.id}"`);
    }
    node.causalFact = { connective: "because", cause: { kind: "possessionLack", itemEntityId: itemIds[0]! } };
    concepts.push("because");
  }
  return { node, entities, concepts, itemIds, wrongId };
}

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

  const requested = Math.max(0, Math.min(4, Math.floor(params.questCount ?? 0)));
  let questCount = 0;
  let npcsNeeded = 0;
  for (let i = 0; i < requested; i++) {
    const need =
      (complexityFor(i) === "simple" ? 1 : 2) +
      (params.task === "deliver" ? 1 : 0) +
      (params.giverGoToPlace || params.giverMotive === "escort" ? 1 : 0);
    if (npcsNeeded + need > friendPool.members.length) break;
    npcsNeeded += need;
    questCount += 1;
  }
  // A nonzero request truncated by pool exhaustion still yields one quest;
  // a requested ZERO is honored (questless world).
  if (questCount === 0 && requested > 0) questCount = 1;

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
  const deviceDrawer = params.giverDeviceNeed && pools.device ? new Drawer(pools.device, rng) : null;
  if (params.giverDeviceNeed && !deviceDrawer) {
    throw new Error("buildCreatureQuestWorld giverDeviceNeed needs the device pool");
  }
  // Motive-batch pools: the quest item comes from the motive's own pool (a
  // hungry creature's want must be answerable by what's staged), and the
  // smelly-food quest needs the disposal (garbage) container.
  const motive = params.giverMotive;
  const motivePoolId = motive ? MOTIVE_POOL[motive] : undefined;
  const motiveDrawer = motivePoolId && pools[motivePoolId] ? new Drawer(pools[motivePoolId]!, rng) : null;
  if (motivePoolId && !motiveDrawer) {
    throw new Error(`buildCreatureQuestWorld giverMotive "${motive}" needs the ${motivePoolId} pool`);
  }
  const disposalDrawer = motive === "smelly" && pools.disposal ? new Drawer(pools.disposal, rng) : null;
  if (motive === "smelly" && !disposalDrawer) {
    throw new Error('buildCreatureQuestWorld giverMotive "smelly" needs the disposal pool');
  }
  const wantsPower = (params.giverDeviceNeed && params.giverDevicePowered) || params.giverStationPowered;
  const powerDrawer = wantsPower && pools.powerSource ? new Drawer(pools.powerSource, rng) : null;
  if (wantsPower && !powerDrawer) {
    throw new Error("buildCreatureQuestWorld power chains need the powerSource pool");
  }

  for (let i = 0; i < questCount; i++) {
    const q = `q${i}`;
    const complexity = complexityFor(i);
    const itemDrawer = drawers[i % drawers.length]!;
    const otherDrawer = drawers[(i + 1) % drawers.length]!;
    // Device mode draws the "item" from the device pool; a motive with its own
    // pool (hungry → treat, music → instrument…) draws from that instead.
    const item = deviceDrawer ? deviceDrawer.next() : motiveDrawer ? motiveDrawer.next() : itemDrawer.next();
    const giver = friends.next();
    // Lend forces 1 — a borrowed item the giver consumed could never be given
    // back, and the lender would price exactly that return.
    const count = complexity === "lend" ? 1 : needCount;
    // Draw the optional element slots. RNG order is preserved (axis, then
    // station); container/box draws consume no RNG, so moving them here is safe.
    // likes-color FORCES a color axis (the want IS the color); one rng() draw
    // either way keeps the seed stream stable across the motive knob.
    const colorAxes = DESCRIPTOR_AXES.filter((a) => a.wanted.startsWith("color_"));
    const axis =
      motive === "likes-color"
        ? colorAxes[Math.floor(rng() * colorAxes.length)]!
        : params.descriptors
          ? DESCRIPTOR_AXES[Math.floor(rng() * DESCRIPTOR_AXES.length)]!
          : null;
    let station: StationKind | null = params.transformations
      ? (["fire", "water"] as const)[Math.floor(rng() * 2)]!
      : null;
    // The placement container: the task dropdown's box/basket, or the motive
    // batch's OUTDOOR garbage can (smelly food goes out, not in a box).
    const container = disposalDrawer ? disposalDrawer.next() : containerDrawer ? containerDrawer.next() : null;
    // Creature-state (§5): a bad self-condition on a want-branch need only
    // (compat allows a transformed remedy; excludes placement/deliver/never).
    // The motive batch adds hungry (want food) and lonely (want company).
    const motiveCondition = motive === "hungry" ? "hungry" : motive === "lonely" ? "lonely" : undefined;
    const condition =
      (params.giverCondition || motiveCondition) &&
      !container &&
      params.task !== "deliver" &&
      params.giverAnnounce !== "never"
        ? (motiveCondition ?? params.giverCondition!)
        : null;
    // MOTIVE (§C): the condition GENERATES the want ("something hot" for cold,
    // "food" for hungry) and FORCES what satisfies it — the remedy station
    // (cold → fire) or the item pool (hungry → treat, drawn above).
    const conditionWant = condition ? MOTIVE_WANT[condition] : undefined;
    if (conditionWant?.station) station = conditionWant.station;
    // Desire-flavored motives (play/music/read/wear): a category/kind target +
    // the "because I want to {verb}" WHY.
    const desire = motive ? MOTIVE_TARGETS[motive] : undefined;
    // v1 `because` (lack) frame: plain possession givers only; the condition
    // frame takes precedence (compat-checked in composeNeed either way).
    const because =
      !!params.giverCausalWhy &&
      !condition &&
      !container &&
      params.task !== "deliver" &&
      !station &&
      params.giverAnnounce !== "never";

    const composed = composeNeed({
      q,
      questShape: complexity,
      giver,
      item,
      count,
      descriptor: axis,
      station,
      container,
      announce: params.giverAnnounce,
      thoughtScaffold: params.thoughtScaffold ?? true,
      needValue: 3,
      condition,
      motiveTarget:
        conditionWant?.target ??
        desire?.target ??
        (motive === "likes-color" && axis ? { descriptors: [axis.wanted] } : null),
      reveal: condition ? params.giverReveal : undefined,
      deviceTargetState: params.giverDeviceNeed ?? null,
      deviceGenerator: powerDrawer && params.giverDevicePowered ? powerDrawer.next() : null,
      goToNodeId:
        (params.giverGoToPlace || motive === "escort") && complexity === "simple" ? `${q}_dest` : null,
      escort: motive === "escort",
      stayWith: motive === "lonely",
      itemBakedState: motive === "smelly" ? "smelly" : null,
      placedOutdoors: motive === "smelly",
      likesItem: motive === "likes-item",
      likesFacet: motive === "likes-color" && axis ? axis.wanted : null,
      wantsToVerb: desire?.verb ?? null,
      because,
    });
    for (const e of composed.entities) add(e);
    for (const c of composed.concepts) concepts.add(c);
    const giverNode = composed.node;
    const { itemIds, wrongId } = composed;

    gate(giverNode.id, item.label, giverNode);
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
      if (params.deliverCausalPurpose) {
        // The remedy→goal line: "give it to Bear IN ORDER TO Bear [is] happy".
        // The frame owns the recipient node id, so it's applied by this quest
        // shape (not composeNeed) — compat-checked against the same table.
        if (!causalFrameCompatible("in-order-to-recipient-happy", giverNode)) {
          throw new Error(`in-order-to frame incompatible with need "${giverNode.id}"`);
        }
        giverNode.causalFact = {
          connective: "in_order_to",
          cause: { kind: "creatureState", state: "happy", creatureNodeId: recipNodeId },
        };
        concepts.add("in_order_to");
        concepts.add("happy");
      }
    }

    // PRESENCE (go-to / escort): stage the DESTINATION — a needless NPC in its
    // own zone the player (or the escorted giver) travels to (`${q}_dest`,
    // matching the giver's needAtPlaceNodeId).
    if ((params.giverGoToPlace || motive === "escort") && complexity === "simple") {
      const dest = friends.next();
      const destNodeId = `${q}_dest`;
      add(npcEntity(`${q}_dest_npc`, dest));
      gate(destNodeId, dest.label, {
        type: "fulfill",
        id: destNodeId,
        npcEntityId: `${q}_dest_npc`,
        zoneHint: `${dest.label}'s spot`,
      });
    }

    if (complexity !== "simple" && itemIds.length > 0) {
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
      // P1 station-gating: stage a GENERATOR the station is powered by (simple
      // quests — station + item + power all sit in the giver's room).
      if (params.giverStationPowered && complexity === "simple" && powerDrawer) {
        const gen = powerDrawer.next();
        const genId = `${q}_stationgen`;
        add({ ...itemEntity(genId, gen), glyph: `${gen.symbol}.off` });
        giverNode.stationPowerDeviceId = genId;
        giverNode.propEntityIds = [...(giverNode.propEntityIds ?? []), genId];
        // WHY reveals the blocker — switch the generator on to power the station.
        if (!giverNode.causalFact) {
          giverNode.causalFact = { connective: "because", cause: { kind: "itemState", itemEntityId: genId, state: "off" } };
        }
        concepts.add("because");
        concepts.add("on");
      }
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
      // The building template (one-building household vs. village of houses).
      ...(params.layout ? { layout: params.layout } : {}),
      seed,
    },
    entities: [...entities.values()],
    root: {
      type: "reach",
      id: "root_star",
      markerEntityId: "star",
      zoneHint: "celebration square",
      // The schema wants via ABSENT when there are no guards (min-1 array) —
      // a questless structure's root is a bare reach, nothing to prove.
      ...(guards.length ? { via: guards } : {}),
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

/** Lower a node's entity-id-based FulfillCausalFact to the runtime CausalFact
 *  (resolving the implicit "self" creature). */
function toCausalFact(self: CreatureId, fact: FulfillCausalFact): CausalFact {
  const c = fact.cause;
  const cause: Clause =
    c.kind === "possessionLack"
      ? { kind: "possessionLack", creature: self, item: c.itemEntityId }
      : c.kind === "itemState"
        ? { kind: "itemState", item: c.itemEntityId, state: c.state }
        : c.kind === "likes"
          ? { kind: "likes", creature: self, ...(c.itemEntityId ? { item: c.itemEntityId } : {}), ...(c.facet ? { facet: c.facet } : {}) }
          : c.kind === "wantsTo"
            ? { kind: "wantsTo", creature: self, verb: c.verb }
            : { kind: "creatureState", creature: c.creatureNodeId ?? self, state: c.state };
  return { connective: fact.connective, cause };
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
  // Parameter-matching facets (motive-driven-needs.md): kind = head, descriptors
  // = the immutable (non-state) modifiers, category = the shared KIND_CATEGORY
  // tag ("food"/"toy"/"clothing") a category target matches against.
  const facetsOf = (id: string): { kind: string; category?: string; descriptors?: string[] } => {
    const parts = (entityGlyph.get(id) ?? id).split(".");
    const descriptors = parts.slice(1).filter((m) => !STATE_TAGS.has(m));
    const kind = parts[0]!;
    return {
      kind,
      ...(KIND_CATEGORY[kind] ? { category: KIND_CATEGORY[kind] } : {}),
      ...(descriptors.length ? { descriptors } : {}),
    };
  };

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
      needs: [
        ...needIds.map((itemId) => ({
          itemId,
          value: node.needValue ?? 3,
          ...(node.needPlacedInEntityId ? { placedAt: node.needPlacedInEntityId } : {}),
          ...(node.needPlacedOutdoors ? { dispose: true } : {}),
          ...(node.needForNodeId ? { forCreature: node.needForNodeId } : {}),
          ...(node.needItemState ? { requiresState: node.needItemState } : {}),
          ...(node.needDeviceState && itemId === node.needItemEntityId
            ? { deviceState: node.needDeviceState }
            : {}),
          // Parameter target + reveal level attach to the PRIMARY need.
          ...(node.needTarget && itemId === node.needItemEntityId
            ? { target: { ...node.needTarget } }
            : {}),
          ...(node.motiveReveal && itemId === node.needItemEntityId
            ? { reveal: node.motiveReveal }
            : {}),
          // The fact attaches to the PRIMARY need (its cause references that item).
          ...(node.causalFact && itemId === node.needItemEntityId
            ? { causalFact: toCausalFact(cid, node.causalFact) }
            : {}),
        })),
        // A PRESENCE (go-to) need has no item — the destination is the target.
        // ESCORT flavor: the WANTER must reach it (it follows the player).
        ...(node.needAtPlaceNodeId
          ? [
              {
                itemId: node.needAtPlaceNodeId,
                value: node.needValue ?? 3,
                atPlace: node.needAtPlaceNodeId,
                ...(node.needEscort ? { escort: true } : {}),
              },
            ]
          : []),
        // A STAY-WITH need points at the wanter ITSELF: the player dwells near
        // it. Rides the motive reveal (want the company / just "I'm lonely").
        ...(node.needStayWith
          ? [
              {
                itemId: cid,
                value: node.needValue ?? 3,
                atPlace: cid,
                stay: true,
                ...(node.motiveReveal ? { reveal: node.motiveReveal } : {}),
              },
            ]
          : []),
      ],
      debts: node.playerDebt ? { [PLAYER_CREATURE_ID]: node.playerDebt } : {},
      ...(node.condition ? { condition: node.condition } : {}),
    });
    for (const id of node.stockEntityIds ?? []) {
      items.set(id, { id, ownerId: cid, displayed: true, states: initialStates(id), ...facetsOf(id) });
    }
    for (const id of node.boundEntityIds ?? []) {
      items.set(id, { id, ownerId: cid, displayed: true, bound: true, states: initialStates(id), ...facetsOf(id) });
    }
    for (const id of node.propEntityIds ?? []) {
      if (!items.has(id)) items.set(id, { id, states: initialStates(id), ...facetsOf(id) });
    }
    // A device-state need's item is a fixed DEVICE (toggled, never owned).
    if (node.needDeviceState && node.needItemEntityId) {
      const dev = items.get(node.needItemEntityId);
      if (dev) {
        dev.device = true;
        // Power chain: the device is `poweredBy` a generator that must be ON.
        if (node.powerDeviceEntityId) {
          dev.poweredBy = { deviceId: node.powerDeviceEntityId, state: "on" };
          const gen = items.get(node.powerDeviceEntityId);
          if (gen) gen.device = true;
        }
      }
    }
    // P1: a power-gated station's generator is a device too (switched on).
    if (node.stationPowerDeviceId) {
      const gen = items.get(node.stationPowerDeviceId);
      if (gen) gen.device = true;
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
      // ...and loose props get picked up on the way in (never a fixed DEVICE).
      for (const id of node.propEntityIds ?? []) {
        if (world.items[id]?.ownerId === null && !world.items[id]?.device) {
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
        // A presence (go-to) need: the sim walks the player to the destination
        // (its zone reachability is proved by the static solver) — arrival
        // fulfills the need. No item involved.
        if (need?.atPlace) {
          noteArrival(world, PLAYER_CREATURE_ID, need.atPlace);
          continue;
        }
        // A device-state need: the sim powers up the chain behind the device
        // (switch on the generator first), then toggles it — the toggle fulfills
        // the need and clears any linked condition. No item to hold or carry.
        if (need?.deviceState) {
          powerUp(world, PLAYER_CREATURE_ID, need.itemId);
          toggleDevice(world, PLAYER_CREATURE_ID, need.itemId, need.deviceState);
          continue;
        }
        if (need && world.items[need.itemId]?.ownerId === PLAYER_CREATURE_ID) {
          if (need.requiresState && !world.items[need.itemId]!.states.includes(need.requiresState)) {
            // Detour to a station first (the pre-check guarantees one exists).
            const kind = (Object.keys(STATION_KINDS) as StationKind[]).find(
              (k) => STATION_KINDS[k].applies === need.requiresState,
            );
            if (kind) {
              // Power the station up first (P1) — useStation no-ops otherwise, so
              // skipping this step would leave the need unfulfilled (real gate).
              if (node.stationPowerDeviceId) {
                powerUp(world, PLAYER_CREATURE_ID, node.stationPowerDeviceId);
                toggleDevice(world, PLAYER_CREATURE_ID, node.stationPowerDeviceId, "on");
              }
              useStation(
                world,
                need.itemId,
                STATION_KINDS[kind].applies,
                STATION_KINDS[kind].removes,
                node.stationPowerDeviceId,
              );
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
