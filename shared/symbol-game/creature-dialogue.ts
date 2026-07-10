// shared/symbol-game/creature-dialogue.ts
//
// Dialogue as a PROJECTION of creature state, following the condition-based
// dialogue states of planning-docs/symbol-learning-game/dialogue-states.md:
//
//   STATE 1 — creature has a (visible) need: "I want / give me {thing}", with
//     player acts: I give (offer) · I will help (agree) · I won't / give.not
//     (refuse → sad) · I don't have it (cant → ok) · trade (single-known) or
//     trade-for-what menu (multi-known) · where-is (own need + heard wants;
//     answers: holder clue / "I have it" / "you have it" / don't-know) ·
//     confused · bye.
//   STATE 2 — no need, or hiding it (announce "after"): greet only (no
//     advertising mumble): "hi" / "you want something?" (vendor), with acts:
//     how-are-you (reveals a hidden need) · give-me (request, may be priced =
//     the trade counter) · I don't have it (when priced) · where-is for things
//     other creatures asked for · offers · confused · bye.
//
// Registry-backed question words + acts: where-is → "place#question + {thing}"
// ("where [is] X") · trade-for-what → "thing#question" ("what") · trade →
// the `trade` symbol (crossing arrows) · bye → "goodbye" (waving hand).
// Remaining interim: I-don't-know → "think.not" (`know` is a queued symbol).

import {
  causalPhrase,
  giveAsk,
  giveOffer,
  noStock,
  phrase,
  requestAsk,
  VENDOR_GREET,
  wantAsk,
  REJECTED_LINE,
  type LeveledGlyphs,
  type PhraseSpec,
  type SyntaxLevel,
} from "./dialogue-gen.js";
import {
  giveItem,
  itemMatchesNeed,
  knownHoldings,
  needStateOk,
  openNeeds,
  requestItem,
  settleObligations,
  STATE_TAGS,
  valueTo,
  type Clause,
  type CreatureEvent,
  type CreatureId,
  type CreatureNeed,
  type CreatureWorld,
  type ItemId,
  type ItemState,
  type NeedTarget,
} from "./creatures.js";

// ---------------------------------------------------------------------------
// Projection shapes
// ---------------------------------------------------------------------------

export type DialogueActKind =
  | "offer" // hand over an item in hand ("I give {thing}")
  | "agree" // "I will help" — closes; go do it
  | "refuse" // "I won't / give.not {thing}" — NPC is sad; closes
  | "cant" // "I don't have {thing}" — NPC says ok; closes
  | "request" // "give me {thing}" (any known holding; may be priced)
  | "trade" // propose the swap directly (single known holding)
  | "trade-menu" // "trade for what?" — opens the pick list
  | "trade-pick" // a pick inside the trade menu
  | "back" // leave an open sub-menu (trade / directions list)
  | "more" // advance to the next page of an open list
  | "how-are-you" // small talk; reveals a hidden need
  | "where-is" // information request about an ITEM (who holds it)
  | "ask-directions" // ask where a PLACE is, directly (a single known subject)
  | "directions-menu" // open the "where is…" list (several known subjects)
  | "directions-pick" // a pick inside the "where is…" list
  | "why" // ask WHY a need exists — reveals the cause clause (narration)
  | "confused" // re-model one level down (presentation-level)
  | "bye"; // close the conversation

export interface DialogueAct {
  kind: DialogueActKind;
  itemId?: ItemId;
  /** For directions acts: the place-fact SUBJECT id the player is asking about
   *  (resolved to geometry by the host, not by this pure layer). */
  subjectId?: string;
  glyph: string;
}

export interface DialogueProjection {
  lineGlyph: string;
  acts: DialogueAct[];
}

/** Per-conversation presentation state the CALLER holds (resets on walk-away). */
export interface ConversationMemo {
  /** A price the creature stated this conversation (the trade counter). */
  statedPrice?: { kind: "need" | "return"; itemId: ItemId };
  /** A hidden (announce:"after") need revealed by small talk this conversation. */
  revealed?: boolean;
  /** The trade-for-what pick list is open. */
  tradeMenu?: boolean;
  /** A generic paginated pick-list is open (e.g. the "where is…" directions
   *  menu). `menu` selects the item provider; `page` is the 0-based page,
   *  wrapped on overflow. */
  list?: { menu: string; page: number };
}

export interface ProjectionOpts {
  /** Does this creature volunteer its need unprompted ("before", default),
   *  only when asked ("after"), or NEVER ("never" — Request c: it just looks
   *  sad; the player must infer the want and OFFER it)? */
  announce?: "before" | "after" | "never";
  /** Resolve an item id to its glyph SYMBOL (world layer owns the mapping). */
  symbolOf: (itemId: ItemId) => string;
  /** Resolve a creature id to its glyph SYMBOL (for "the rabbit has it" clues). */
  symbolOfCreature?: (creatureId: CreatureId) => string;
  /** Items OTHER creatures asked for — the state-2 where-is menu. */
  askableWhere?: ItemId[];
  /** The player's KNOWN direction subjects (places they've heard of), MOST-
   *  RECENT FIRST, each with the glyph naming what they'd ask about ("where is
   *  the blue house?"). Already filtered to subjects THIS creature can answer
   *  (town common knowledge + own). Empty/undefined = no directions option. */
  askDirections?: { id: string; glyph: string }[];
  /** Physical gate on OFFERS/trades: only items actually IN HAND. */
  offerFilter?: (itemId: ItemId) => boolean;
  /**
   * Resolve an item to its PLACE symbol ("home.color_blue") — the building the
   * item (or its holder) is in. World layer owns the mapping; undefined = no
   * building clue (the answer falls back to the bare holder / "there").
   */
  placeOf?: (itemId: ItemId) => string | undefined;
  /** Board capacity. Default 8 (the response board is 2×4). */
  maxActs?: number;
}

const at = (g: LeveledGlyphs, level: SyntaxLevel): string => g[level];

// -- descriptor helpers (Item b) ---------------------------------------------
// Variant items carry COMPOSED glyphs ("ball.big"): head = the kind, dot
// modifiers = the descriptors. Same head + different modifiers = right kind,
// wrong variant — the corrective-response case.
const headOf = (symbol: string): string => symbol.split(".")[0] ?? symbol;

/** State-aware views over the static entity symbols (transformations): `base`
 *  strips STATE tags (an item's INITIAL state travels in its entity glyph),
 *  `now` re-composes the item's CURRENT states, `want` composes a need's
 *  REQUIRED state ("apple.hot" while the world only holds a cold one). */
function makeSyms(world: CreatureWorld, sym: (id: ItemId) => string) {
  const base = (id: ItemId): string => {
    const parts = sym(id).split(".");
    return [parts[0]!, ...parts.slice(1).filter((m) => !STATE_TAGS.has(m))].join(".");
  };
  const now = (id: ItemId): string => [base(id), ...(world.items[id]?.states ?? [])].join(".");
  // The WANTED composition: base (kind + immutable descriptors) + the required
  // state, if any — NEVER the item's baked spawn state ("apple.cold" for a
  // hot-need item). A stateless need is just its base identity.
  const want = (n: Pick<CreatureNeed, "itemId" | "requiresState">): string =>
    n.requiresState ? `${base(n.itemId)}.${n.requiresState}` : base(n.itemId);
  // What the creature WANTS, decoupled from the designated instance: a TARGET
  // need reads as its predicate ("something hot" / "food"), never the specific
  // item the generator picked; an exact need reads as its item.
  const wantOf = (n: CreatureNeed): string => (n.target ? targetGlyph(n.target) : want(n));
  return { base, now, want, wantOf };
}

/** Verbalize a causal CLAUSE as a phrase() spec — the deixis-resolved subject
 *  (whoSym) plus a state-aware object (syms). Used for the WHY answer and (later)
 *  the in_order_to need line. */
function clauseSpec(
  cl: Clause,
  whoSym: (id: CreatureId) => string,
  syms: { base: (id: ItemId) => string; now: (id: ItemId) => string },
): PhraseSpec {
  switch (cl.kind) {
    case "possessionLack":
      return { subject: whoSym(cl.creature), verb: "have.not", object: syms.base(cl.item) };
    case "creatureState":
      return { subject: whoSym(cl.creature), verb: cl.state, key: cl.state };
    case "itemState":
      // Base symbol + the state as separate glyphs ("window + open"), NOT the
      // composed now() form (which would double the state: "window.open + open").
      return { subject: syms.base(cl.item), verb: cl.state, key: cl.state };
    case "likes":
      // Preference (motive batch): "i_me + like + {item|facet}" — the facet is
      // a bare quality symbol ("color_red" — "I like red").
      return { subject: whoSym(cl.creature), verb: "like", object: cl.item ? syms.base(cl.item) : (cl.facet ?? "thing") };
    case "wantsTo":
      // Desire (motive batch): "i_me + want + {verb}" — "I want to play".
      return { subject: whoSym(cl.creature), verb: "want", object: cl.verb };
  }
}

// -- interim templates (registry gaps noted in the header) -------------------

const BYE: LeveledGlyphs = { a: "goodbye", b: "goodbye", c: "goodbye" };
// The generic pick-list controls (shared by the directions "where is…" menu):
// "more" advances a page, "no" backs out, "place?" opens the menu.
const MORE_PAGE: LeveledGlyphs = { a: "more", b: "more", c: "more" };
const LIST_BACK: LeveledGlyphs = { a: "no", b: "no", c: "no" };
const CONFUSED_GLYPH: LeveledGlyphs = { a: "confused", b: "confused", c: "confused" };
const WHERE_MENU: LeveledGlyphs = { a: "place#question", b: "place#question", c: "place#question" };
// "no" would read as refusal — the honest single glyph is the not-knowing.
const DONT_KNOW: LeveledGlyphs = phrase({ subject: "i_me", verb: "think.not", key: "think.not" });
const HOW_ARE_YOU: LeveledGlyphs = {
  a: "ok#question",
  b: "you + ok#question",
  c: "you + ok#question",
};

function agreeHelp(): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "help", object: "you", key: "yes" });
}
function refuseGlyph(holding: string | null): LeveledGlyphs {
  return holding
    ? phrase({ subject: "i_me", verb: "give.not", object: holding, key: "no" })
    : phrase({ subject: "i_me", verb: "help.not", object: "you", key: "no" });
}
function cantGlyph(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "have.not", object: thing, key: "have.not" });
}
function whereIs(thing: string): LeveledGlyphs {
  // `place#question` is the registry's "where" question word; the full form is
  // the §Specifics "where + get + {item}" frame. Level a keeps the THING (the
  // clarity exception): a bare map is unreadable when several where-is buttons
  // sit side by side — and even alone it doesn't say where WHAT.
  return {
    a: `place#question + ${thing}`,
    b: `place#question + ${thing}`,
    c: `place#question + get + ${thing}`,
  };
}
/** The WHY ask BUTTON (puzzle-types §Specifics "Ask for reason"). `why` is a
 *  queued question word (glyph-symbol-vocabulary.md); it renders as its label
 *  until the symbol ships. The creature's ANSWER is the two-clause causal line. */
function whyAsk(thing: string): LeveledGlyphs {
  return { a: "why", b: `why + ${thing}`, c: `why + you + want + ${thing}` };
}
/** Multi-item needs: a same-kind need already fulfilled → the ask reads MORE. */
function wantMore(thing: string): LeveledGlyphs {
  return { a: "more", b: `more + ${thing}`, c: `want + more + ${thing}` };
}
/** Placement (state) need: "I want {thing} in {dest}". */
function wantPlace(thing: string, dest: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "want", object: thing, tail: { join: "in", symbol: dest } });
}
/** DISPOSAL placement (motive batch): "throw {thing} in {garbage}" — a DISTINCT
 *  statement from an ordinary placement (the `throw` verb leads, not `want`). */
function wantThrow(thing: string, dest: string): LeveledGlyphs {
  return { a: "throw", b: `throw + ${thing}`, c: `you + throw + ${thing} + in + ${dest}` };
}
/** Device-state need (§5): "I want the {device} {state}" (on/off/open/closed).
 *  Level a is the STATE alone — the ON/OFF concept under test. */
function wantDevice(device: string, state: string): LeveledGlyphs {
  return { a: state, b: `${device} + ${state}`, c: `i_me + want + ${device} + ${state}` };
}
/** Presence (go-to) need (§5): "you + go + to + {dest}" — the player navigates
 *  to the destination creature. Level a is the destination alone. */
function wantGo(dest: string): LeveledGlyphs {
  return { a: dest, b: `go + ${dest}`, c: `you + go + to + ${dest}` };
}
/** STAY-WITH want (motive batch): "you + stay + with + i_me" — the company ask. */
function wantStay(): LeveledGlyphs {
  return { a: "stay", b: "stay + with + i_me", c: "you + stay + with + i_me" };
}
/** ESCORT want (motive batch): "you + take + i_me + to + {dest}". Level b keeps
 *  the destination (the clarity exception — "take me" without WHERE says nothing). */
function wantEscort(dest: string): LeveledGlyphs {
  return { a: dest, b: `take + i_me + to + ${dest}`, c: `you + take + i_me + to + ${dest}` };
}
/** The stay-with COMPLETION line — the world layer speaks it when the dwell
 *  finishes ("I'm okay, thank you!"). Exported for the player. */
export const STAY_DONE_LINE = "i_me + ok + thank_you";
/** A bare WHY ask (stay-with — there's no want OBJECT to name). */
const WHY_PLAIN: LeveledGlyphs = { a: "why", b: "why", c: "why" };
/** The GLYPH for a parameter want (motive-driven-needs.md): a kind composes with
 *  its descriptors + state ("apple.hot"); a kind-less want is the salient facet
 *  alone ("hot" = "something hot"; "food"; "color_red"). */
function targetGlyph(t: NeedTarget): string {
  if (t.kind) return [t.kind, ...(t.descriptors ?? []), ...(t.state ? [t.state] : [])].join(".");
  return t.category ?? t.state ?? ((t.descriptors ?? []).join(".") || "thing");
}
/** A MOTIVE line (§C): "i_me + {condition}" — just the plight ("I am cold"),
 *  the want left to be inferred. */
function conditionLine(condition: string): LeveledGlyphs {
  return { a: condition, b: `i_me + ${condition}`, c: `i_me + ${condition}` };
}
/** The FACETS a need wants — its parameter TARGET, or (for an exact need) the
 *  designated item's own facets. Used to judge an OFFERED/CARRIED item against
 *  the want WITHOUT referencing the designated instance directly. */
function wantFacets(
  need: CreatureNeed,
  world: CreatureWorld,
): { kind?: string; category?: string; descriptors?: string[]; state?: string } {
  if (need.target) return need.target;
  const it = world.items[need.itemId];
  return { kind: it?.kind, descriptors: it?.descriptors, state: need.requiresState };
}
/** Is `item` the RIGHT SORT of thing for `want` (kind + category match)? A
 *  descriptor/state correction only makes sense for the same sort. */
function sameSort(want: { kind?: string; category?: string }, item: ItemState): boolean {
  return (!want.kind || item.kind === want.kind) && (!want.category || item.category === want.category);
}
/** On-behalf need: "give {thing} to {who}" — the first recipient frame. */
function wantFor(thing: string, who: string): LeveledGlyphs {
  return phrase({ subject: "you", verb: "give", object: thing, tail: { join: "to", symbol: who } });
}
function tradeGlyph(give: string, get: string): LeveledGlyphs {
  return { a: get, b: `trade + ${get}`, c: `${give} + for + ${get}` };
}
function tradeWhat(give: string): LeveledGlyphs {
  // `thing#question` is the registry's "what" question word: "trade… for what?"
  return { a: "trade", b: `trade + thing#question`, c: `${give} + for + thing#question` };
}
/** Someone (deixis-resolved: "you" / a creature's symbol) has the thing. */
function clueHolder(holder: string, thing: string): LeveledGlyphs {
  return phrase({ subject: holder, verb: "have", object: thing, key: holder, bFull: true });
}
/** The asked creature holds it itself ("I have it!") — first person. */
function clueSelf(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "have", object: thing, key: "have" });
}
/** A building location clue: "{thing} + in + home.color_blue" — "the ball is
 *  in the blue house". Level a shows just the house (the map answer). */
function cluePlace(thing: string, place: string): LeveledGlyphs {
  const g = `${thing} + in + ${place}`;
  return { a: place, b: g, c: g };
}
/** Creature declines an OFFERED item ("no thanks, I don't want the sock"). */
function declineOffer(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "want.not", object: thing, key: "no" });
}
/** Right KIND, wrong DESCRIPTOR: "{item} + {wanted-descriptor}.not" —
 *  "ball, not big" — names exactly what the offered variant is missing. */
function wrongVariant(head: string, wantedMod: string): LeveledGlyphs {
  const g = `${head} + ${wantedMod}.not`;
  return { a: `${wantedMod}.not`, b: g, c: g };
}
/** Creature refuses to part with a BOUND possession ("no — my cookie"). */
function mineDecline(thing: string): LeveledGlyphs {
  return { a: `${thing}.my`, b: `no + ${thing}.my`, c: `no + ${thing}.my` };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** The creature's currently-VISIBLE need (a hidden one shows after small talk;
 *  a NEVER-announced one stays hidden for good — inference territory). */
function visibleNeed(
  world: CreatureWorld,
  creatureId: CreatureId,
  opts: ProjectionOpts,
  memo: ConversationMemo,
) {
  const creature = world.creatures[creatureId];
  const need = creature ? openNeeds(creature)[0] : undefined;
  if (!need) return undefined;
  if (opts.announce === "never") return undefined;
  return opts.announce === "after" && !memo.revealed ? undefined : need;
}

/** The persistent sad emote of a creature that never states its want. */
const SAD_GREET: LeveledGlyphs = { a: "sad", b: "i_me + sad", c: "i_me + sad" };

export function projectDialogue(
  world: CreatureWorld,
  creatureId: CreatureId,
  playerId: CreatureId,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  memo: ConversationMemo = {},
): DialogueProjection {
  const creature = world.creatures[creatureId];
  if (!creature) return { lineGlyph: "hi", acts: [] };
  const sym = opts.symbolOf;
  const syms = makeSyms(world, sym);
  // Person deixis: a reference to the SPEAKER is "i_me", to the LISTENER
  // (the player) "you"; only third parties keep their creature symbol.
  const whoSym = (id: CreatureId): string =>
    id === creatureId ? "i_me" : id === playerId ? "you" : (opts.symbolOfCreature?.(id) ?? "there");
  const carried = Object.values(world.items)
    .filter((i) => i.ownerId === playerId && (opts.offerFilter?.(i.id) ?? true))
    .map((i) => i.id)
    .sort();
  const known = knownHoldings(world, playerId, creatureId);
  const need = visibleNeed(world, creatureId, opts, memo);
  // ANY carried instance matching an open possession need counts as "holding
  // the need" — multi-item needs share one symbol across instances, and the
  // visible need is merely the first. State needs (placement / on-behalf) are
  // never hand-overs to THIS creature, and a transformed-state requirement
  // must be MET before the hand-over line/offer appears.
  const isStateNeed = (n: {
    placedAt?: string;
    forCreature?: string;
    deviceState?: string;
    atPlace?: string;
  }) => !!n.placedAt || !!n.forCreature || !!n.deviceState || !!n.atPlace;
  const holdingNeed =
    need && !isStateNeed(need)
      ? (carried.find((c) => {
          const it = world.items[c];
          // Parameter-aware: a carried item that MATCHES an open possession need
          // (loose target or exact instance) counts as "holding the need".
          return !!it && creature.needs.some((n) => !n.fulfilled && itemMatchesNeed(n, it));
        }) ?? null)
      : null;

  // -- the line ---------------------------------------------------------------
  let lineGlyph: string;
  if (memo.statedPrice) {
    lineGlyph =
      memo.statedPrice.kind === "return"
        ? at(giveAsk(syms.now(memo.statedPrice.itemId)), level)
        : at(wantAsk(syms.now(memo.statedPrice.itemId)), level);
  } else if (memo.tradeMenu && need) {
    lineGlyph = at(tradeWhat(syms.want(need)), level); // "cookie for…?"
  } else if (need) {
    if (need.placedAt) {
      lineGlyph = at(
        need.dispose
          ? wantThrow(syms.now(need.itemId), sym(need.placedAt))
          : wantPlace(syms.want(need), sym(need.placedAt)),
        level,
      );
    } else if (need.forCreature) {
      const purpose = need.causalFact?.connective === "in_order_to" ? need.causalFact : undefined;
      if (purpose) {
        // The remedy→goal LINE: "give {thing} to {who} + in_order_to + {goal}".
        const action: PhraseSpec = {
          subject: "you",
          verb: "give",
          object: syms.want(need),
          tail: { join: "to", symbol: whoSym(need.forCreature) },
        };
        lineGlyph = at(causalPhrase(action, purpose.connective, clauseSpec(purpose.cause, whoSym, syms)), level);
      } else {
        lineGlyph = at(wantFor(syms.want(need), whoSym(need.forCreature)), level);
      }
    } else if (need.atPlace) {
      if (need.stay) {
        // STAY-WITH (motive batch): the want ("stay with me") or, at reveal
        // "motive", just the plight ("I am lonely") — the player infers.
        lineGlyph =
          creature.condition && (need.reveal ?? "want") === "motive"
            ? at(conditionLine(creature.condition), level)
            : at(wantStay(), level);
      } else if (need.escort) {
        // ESCORT (motive batch): "take me to {dest}" — agree, and it follows.
        lineGlyph = at(wantEscort(whoSym(need.atPlace)), level);
      } else {
        // Presence (go-to) need (§5): "you + go + to + {dest}".
        lineGlyph = at(wantGo(whoSym(need.atPlace)), level);
      }
    } else if (need.deviceState) {
      // Device-state need (§5): "i_me want {device} {state}". WHY reveals the
      // device's current bad state as the cause.
      lineGlyph = at(wantDevice(syms.base(need.itemId), need.deviceState), level);
    } else if (holdingNeed) {
      lineGlyph = at(giveAsk(syms.now(holdingNeed)), level);
    } else if (creature.condition && !isStateNeed(need)) {
      // MOTIVE need (feedback): the OPENING is either the WANT ("I want something
      // hot") or just the MOTIVE ("I am cold") — never the two-clause "want
      // because" as an UNPROMPTED greeting (that reads backwards). The causal
      // link is the WHY answer; the motive's acts are the same want acts.
      lineGlyph =
        (need.reveal ?? "want") === "motive"
          ? at(conditionLine(creature.condition), level)
          : at(wantAsk(syms.wantOf(need)), level);
    } else {
      // A same-kind need already fulfilled → "more"; else the want (a parameter
      // target reads as "something hot", never the designated item).
      const wantG = syms.wantOf(need);
      const again = creature.needs.some((n) => n.fulfilled && sym(n.itemId) === sym(need.itemId));
      lineGlyph = at(again ? wantMore(wantG) : wantAsk(wantG), level);
    }
  } else if (opts.announce === "never" && openNeeds(creature).length > 0) {
    // Request c: the unstated need shows as a persistent EMOTE, never words —
    // the player reads the sadness + the staged evidence and offers.
    lineGlyph = at(SAD_GREET, level);
  } else {
    // No visible need: greet only — never an advertising mumble.
    const isVendor = Object.values(world.items).some((i) => i.ownerId === creatureId && i.displayed);
    lineGlyph = isVendor ? at(VENDOR_GREET, level) : "hi";
  }

  // -- the acts ---------------------------------------------------------------
  const acts: DialogueAct[] = [];
  const push = (kind: DialogueActKind, glyphs: LeveledGlyphs, itemId?: ItemId) =>
    acts.push({ kind, itemId, glyph: at(glyphs, level) });

  const maxActs = opts.maxActs ?? 8;

  // A generic paginated pick-list is open (the "where is…" directions menu, and
  // future list menus): show ONLY that page — picks + more + back — like the
  // trade menu's own early return below.
  if (memo.list) {
    return { lineGlyph, acts: listActs(memo.list, opts, level, maxActs) };
  }

  if (memo.tradeMenu && need) {
    // The trade pick list: "cookie for {item}?" per known holding, plus back.
    for (const itemId of known) {
      if (world.items[itemId]?.bound) continue;
      push("trade-pick", tradeGlyph(syms.want(need), syms.now(itemId)), itemId);
    }
    push("back", { a: "no", b: "no", c: "no" });
    push("confused", { a: "confused", b: "confused", c: "confused" });
    return { lineGlyph, acts };
  }

  if (need) {
    // STATE 1 — a visible need.
    if (holdingNeed) {
      push("offer", giveOffer(syms.now(holdingNeed)), holdingNeed);
      const tradeable = known.filter((k) => !world.items[k]?.bound);
      if (tradeable.length === 1) {
        push("trade", tradeGlyph(syms.now(holdingNeed), syms.now(tradeable[0]!)), tradeable[0]);
      } else if (tradeable.length > 1) {
        push("trade-menu", tradeWhat(syms.now(holdingNeed)));
      }
    } else {
      push("agree", agreeHelp());
      // "I don't have it" makes no sense while visibly holding a state need's
      // item — the missing step is the box / the recipient, not finding it — nor
      // for a presence need (there's no item to have).
      if (!need.atPlace && !(isStateNeed(need) && carried.includes(need.itemId))) {
        // "I don't have {want}" names the WANT ("something hot"), not the item.
        push("cant", cantGlyph(syms.wantOf(need)), need.itemId);
      }
    }
    // WRONG-VARIANT offers: surface a CARRIED item that is the right SORT of
    // thing for the want but doesn't fully satisfy it (a cold "hot" item, a
    // small "big" one) — the corrective decline is the lesson. Judged by the
    // want's FACETS against the item actually carried, not the designated one.
    if (!need.placedAt && !need.atPlace) {
      const w = wantFacets(need, world);
      // Only surface near-misses of a real SORT (a named kind/category); a
      // kind-less want ("something hot") has no "wrong variant" to offer — the
      // player offers a matching item (holdingNeed) instead.
      const hasSort = !!(w.kind || w.category);
      for (const c of hasSort ? carried : []) {
        if (c === holdingNeed) continue;
        const cItem = world.items[c];
        if (!cItem || !sameSort(w, cItem) || itemMatchesNeed(need, cItem)) continue;
        if (acts.some((a) => a.kind === "offer" && a.itemId === c)) continue;
        push("offer", giveOffer(syms.now(c)), c);
      }
    }
    push("refuse", refuseGlyph(holdingNeed ? syms.now(holdingNeed) : null), need.itemId);
    // Where-is is about finding what's WANTED — "where is something hot" — not
    // the designated item; a presence (go-to) need has no item to find.
    if (!need.atPlace) {
      push("where-is", whereIs(syms.wantOf(need)), need.itemId);
    }
    // Information requests aren't gated on MY need: heard wants are askable
    // here too — the ask-around loop, where any creature may hold the clue.
    for (const itemId of opts.askableWhere ?? []) {
      if (itemId === need.itemId) continue;
      if (carried.includes(itemId) || world.items[itemId]?.ownerId === playerId) continue;
      push("where-is", whereIs(syms.base(itemId)), itemId);
    }
    // WHY: a REVEAL-style because fact (the reason isn't in the line) can be
    // asked — item lack, a device's bad state, a preference ("I like it"), a
    // desire ("I want to play"), or the item's own spoilage. A creature-state
    // because LEADS in the line already, so it gets no why act. The ask names
    // the WANT (predicate-decoupled), never the designated instance.
    const fact = need.causalFact;
    if (
      (fact?.connective === "because" || fact?.connective === "therefore") &&
      fact.cause.kind !== "creatureState"
    ) {
      push("why", whyAsk(syms.wantOf(need)), need.itemId);
    }
    // MOTIVE need: when the want is stated, WHY reveals the motive ("I want hot
    // because I am cold"). A motive-only opening already shows the plight. The
    // stay-with need ("stay with me… why? …because I'm lonely") is a state
    // need, so it gets its own bare WHY.
    if (creature.condition && (need.reveal ?? "want") !== "motive") {
      if (!isStateNeed(need)) {
        push("why", whyAsk(syms.wantOf(need)), need.itemId);
      } else if (need.stay) {
        push("why", WHY_PLAIN, need.itemId);
      }
    }
  } else {
    // STATE 2 — no visible need: small talk, requests, information.
    push("how-are-you", HOW_ARE_YOU);
    for (const itemId of known) {
      push("request", requestAsk(syms.now(itemId)), itemId);
    }
    if (memo.statedPrice && !carried.includes(memo.statedPrice.itemId)) {
      push("cant", cantGlyph(syms.now(memo.statedPrice.itemId)), memo.statedPrice.itemId);
    }
    for (const itemId of opts.askableWhere ?? []) {
      if (carried.includes(itemId) || world.items[itemId]?.ownerId === playerId) continue;
      push("where-is", whereIs(syms.base(itemId)), itemId);
    }
    // Gifts are still possible (the creature may decline what it doesn't value).
    for (const itemId of carried) {
      if (acts.some((a) => a.kind === "offer" && a.itemId === itemId)) continue;
      push("offer", giveOffer(syms.now(itemId)), itemId);
    }
  }
  // ASK FOR DIRECTIONS — the town places the player has heard of that THIS
  // person can point to (host-filtered). One subject → a direct "where is X?";
  // several → open the paginated "where is…" list. Available in both states:
  // anyone in town can be asked the way.
  const askDirs = opts.askDirections ?? [];
  if (askDirs.length === 1) {
    acts.push({
      kind: "ask-directions",
      subjectId: askDirs[0]!.id,
      glyph: at(whereIs(askDirs[0]!.glyph), level),
    });
  } else if (askDirs.length > 1) {
    push("directions-menu", WHERE_MENU);
  }

  push("confused", { a: "confused", b: "confused", c: "confused" });
  push("bye", BYE);

  // Cap to the board, always keeping confused + bye.
  const standing = acts.filter((a) => a.kind === "confused" || a.kind === "bye");
  const rest = acts.filter((a) => a.kind !== "confused" && a.kind !== "bye");
  return { lineGlyph, acts: [...rest.slice(0, Math.max(0, maxActs - standing.length)), ...standing] };
}

/**
 * Render one page of an open pick-list (the directions "where is…" menu, and
 * any future list menu). Picks + a MORE button (only when there's more than one
 * page, wrapping) + a BACK button, sized to leave board room for the controls.
 */
function listActs(
  list: { menu: string; page: number },
  opts: ProjectionOpts,
  level: SyntaxLevel,
  maxActs: number,
): DialogueAct[] {
  // The menu's item provider. Only "where is…" today; keyed so more can be added.
  const items: { id: string; glyph: string }[] =
    list.menu === "where-is" ? (opts.askDirections ?? []) : [];
  // Reserve slots for more + back + confused.
  const pageSize = Math.max(1, maxActs - 3);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = ((list.page % pages) + pages) % pages;
  const slice = items.slice(page * pageSize, page * pageSize + pageSize);
  const acts: DialogueAct[] = slice.map((it) => ({
    kind: "directions-pick",
    subjectId: it.id,
    glyph: at(whereIs(it.glyph), level),
  }));
  if (pages > 1) acts.push({ kind: "more", glyph: at(MORE_PAGE, level) });
  acts.push({ kind: "back", glyph: at(LIST_BACK, level) });
  acts.push({ kind: "confused", glyph: at(CONFUSED_GLYPH, level) });
  return acts;
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

export interface ActResult {
  events: CreatureEvent[];
  responseGlyph?: string;
  /** A second line spoken right after the response (the building clue that
   *  follows "the bear has it" — "the ball is in the blue house"). */
  followUpGlyph?: string;
  /** The player asked for directions to this place-fact SUBJECT. The pure layer
   *  can't compute distance/bearing, so it hands the subject up to the host,
   *  which resolves the geometry, speaks the phrase, and swivels the camera. */
  askedDirections?: string;
  close?: boolean;
  memo: ConversationMemo;
}

/** Apply a selected act; the caller re-projects afterwards (or closes). */
export function selectAct(
  world: CreatureWorld,
  creatureId: CreatureId,
  playerId: CreatureId,
  act: DialogueAct,
  level: SyntaxLevel,
  opts: ProjectionOpts,
  memo: ConversationMemo = {},
): ActResult {
  const sym = opts.symbolOf;
  const syms = makeSyms(world, sym);
  const whoSym = (id: CreatureId): string =>
    id === creatureId ? "i_me" : id === playerId ? "you" : (opts.symbolOfCreature?.(id) ?? "there");
  const creature = world.creatures[creatureId];
  switch (act.kind) {
    case "offer": {
      if (!act.itemId) return { events: [], memo };
      // A state need is not fulfilled hand-to-hand — redirect to the box /
      // the recipient.
      const placeNeed = creature?.needs.find((n) => !n.fulfilled && n.placedAt && n.itemId === act.itemId);
      if (placeNeed) {
        return {
          events: [],
          responseGlyph: at(
            placeNeed.dispose
              ? wantThrow(syms.now(placeNeed.itemId), sym(placeNeed.placedAt!))
              : wantPlace(syms.want(placeNeed), sym(placeNeed.placedAt!)),
            level,
          ),
          memo,
        };
      }
      const behalfNeed = creature?.needs.find((n) => !n.fulfilled && n.forCreature && n.itemId === act.itemId);
      if (behalfNeed) {
        return {
          events: [],
          responseGlyph: at(wantFor(syms.want(behalfNeed), whoSym(behalfNeed.forCreature!)), level),
          memo,
        };
      }
      const res = giveItem(world, playerId, creatureId, act.itemId);
      if (!res.accepted) {
        // Name the OFFERED item by its LIVE composition ("apple.hot" after the
        // fire), never its baked spawn glyph — the reason must read true NOW.
        const offered = syms.now(act.itemId);
        const oItem = world.items[act.itemId];
        // Predicate-driven decline: judge the ACTUALLY-OFFERED item's facets
        // against each open possession need's WANT. Same SORT of thing but the
        // wrong state/descriptor → name what's missing ("apple + hot.not",
        // "ball + big.not"); else a plain "don't want it".
        if (oItem && creature) {
          for (const n of creature.needs) {
            if (n.fulfilled || n.placedAt || n.forCreature || n.deviceState || n.atPlace) continue;
            const w = wantFacets(n, world);
            if (!sameSort(w, oItem)) continue;
            if (w.state && !oItem.states.includes(w.state)) {
              return { events: [], responseGlyph: at(wrongVariant(headOf(offered), w.state), level), memo };
            }
            const missing = (w.descriptors ?? []).find((d) => !(oItem.descriptors ?? []).includes(d));
            if (missing) {
              return { events: [], responseGlyph: at(wrongVariant(headOf(offered), missing), level), memo };
            }
          }
        }
        return { events: [], responseGlyph: at(declineOffer(offered), level), memo };
      }
      const settled = settleObligations(world, creatureId);
      const cleared = memo.statedPrice?.itemId === act.itemId ? { revealed: memo.revealed } : memo;
      return { events: [...res.events, ...settled], responseGlyph: "thank_you", memo: cleared };
    }
    case "request": {
      if (!act.itemId) return { events: [], memo };
      const out = requestItem(world, playerId, creatureId, act.itemId);
      if (out.kind === "accept") {
        return { events: out.events, responseGlyph: "yes", memo };
      }
      if (out.kind === "price") {
        return { events: [], memo: { ...memo, statedPrice: out.price } };
      }
      const item = world.items[act.itemId];
      const refusal =
        item?.ownerId === creatureId && item.bound
          ? mineDecline(syms.now(act.itemId))
          : noStock(syms.now(act.itemId));
      return { events: [], responseGlyph: at(refusal, level), memo };
    }
    case "trade":
    case "trade-pick": {
      // Give the needed thing, receive the picked thing: the give creates the
      // debt, the recorded want (this IS the ask) pends the item. Prefer the
      // need instance the player actually HOLDS (multi-item needs share a
      // symbol); placement needs are never hand-overs.
      // State needs and unmet transformed-state requirements can't be paid
      // hand-to-hand — the give would bounce.
      const tradeNeeds = creature
        ? openNeeds(creature).filter(
            (n) =>
              !n.placedAt &&
              !n.forCreature &&
              needStateOk(n, world.items[n.itemId]?.states ?? []),
          )
        : [];
      const needItemId =
        tradeNeeds.map((n) => n.itemId).find((id) => world.items[id]?.ownerId === playerId) ??
        tradeNeeds[0]?.itemId;
      if (!act.itemId || !needItemId) return { events: [], memo: { ...memo, tradeMenu: false } };
      const give = giveItem(world, playerId, creatureId, needItemId);
      if (!give.accepted) {
        return { events: [], responseGlyph: "no", memo: { ...memo, tradeMenu: false } };
      }
      const ask = requestItem(world, playerId, creatureId, act.itemId);
      const askEvents = ask.kind === "accept" ? ask.events : [];
      const settled = settleObligations(world, creatureId);
      return {
        events: [...give.events, ...askEvents, ...settled],
        responseGlyph: "yes",
        memo: { revealed: memo.revealed },
      };
    }
    case "trade-menu":
      return { events: [], memo: { ...memo, tradeMenu: true } };
    case "back":
      // Leave whichever sub-menu is open (trade counter / directions list).
      return { events: [], memo: { ...memo, tradeMenu: false, list: undefined } };
    case "directions-menu":
      // Open the "where is…" pick list at its first page.
      return { events: [], memo: { ...memo, list: { menu: "where-is", page: 0 } } };
    case "more":
      // Advance the open list a page (projection wraps on overflow).
      return {
        events: [],
        memo: { ...memo, list: memo.list ? { ...memo.list, page: memo.list.page + 1 } : undefined },
      };
    case "ask-directions":
    case "directions-pick":
      // The pure layer can't measure distance/bearing — hand the subject to the
      // host, which resolves the town geometry, speaks the phrase, and points.
      // Close any open list; the answer is a single spoken turn.
      return act.subjectId
        ? { events: [], askedDirections: act.subjectId, memo: { ...memo, list: undefined } }
        : { events: [], memo: { ...memo, list: undefined } };
    case "agree":
      return { events: [], responseGlyph: "thank_you", close: true, memo };
    case "refuse":
      return { events: [], responseGlyph: at(REJECTED_LINE, level), close: true, memo };
    case "cant":
      return { events: [], responseGlyph: "ok", close: true, memo };
    case "how-are-you": {
      const hidden = creature ? openNeeds(creature)[0] : undefined;
      if (hidden && opts.announce === "never") {
        // It never SAYS what it wants — only that it's sad. Infer the rest.
        return { events: [], responseGlyph: at(SAD_GREET, level), memo };
      }
      if (hidden && opts.announce === "after" && !memo.revealed) {
        // Small talk reveals the hidden need — the next line states it.
        return {
          events: [],
          responseGlyph: at(
            hidden.placedAt
              ? wantPlace(syms.want(hidden), sym(hidden.placedAt))
              : hidden.forCreature
                ? wantFor(syms.want(hidden), whoSym(hidden.forCreature))
                : hidden.atPlace
                  ? hidden.stay
                    ? wantStay()
                    : hidden.escort
                      ? wantEscort(whoSym(hidden.atPlace))
                      : wantGo(whoSym(hidden.atPlace))
                  : wantAsk(syms.wantOf(hidden)),
            level,
          ),
          memo: { ...memo, revealed: true },
        };
      }
      return { events: [], responseGlyph: "ok", memo };
    }
    case "where-is": {
      if (!act.itemId || !creature) return { events: [], memo };
      // DECOUPLED from the designated instance: a TARGET need is answered by a
      // KNOWN item that ACTUALLY MATCHES the want IN ITS CURRENT STATE — a cold
      // apple never answers "where is something hot" (the creature simply
      // doesn't know where something hot is). Exact needs + heard wants resolve
      // the specific item as before.
      const ownTargetNeed = creature.needs.find(
        (n) => !n.fulfilled && n.itemId === act.itemId && n.target,
      );
      let itemId = act.itemId;
      if (ownTargetNeed) {
        const match = Object.keys(creature.knowledge)
          .sort()
          .find((id) => {
            const it = world.items[id];
            return !!it && itemMatchesNeed(ownTargetNeed, it);
          });
        if (!match) return { events: [], responseGlyph: at(DONT_KNOW, level), memo };
        itemId = match;
      }
      const fact = creature.knowledge[itemId];
      // The BUILDING clue ("in the blue house") — the world layer resolves the
      // item's house; with real buildings the holder alone isn't findable.
      const place = opts.placeOf?.(itemId);
      if (fact?.kind === "held" && fact.by === creatureId) {
        // First person — never its own name ("I have it", not "rabbit has it").
        return { events: [], responseGlyph: at(clueSelf(syms.now(itemId)), level), memo };
      }
      if (fact?.kind === "held") {
        // whoSym: the player reads as "you", third parties keep their symbol.
        // A third party's clue gets the building follow-up ("bear has the
        // ball" … "the ball is in the blue house") — never for "you have it".
        const followUp =
          fact.by !== playerId && place
            ? { followUpGlyph: at(cluePlace(syms.now(itemId), place), level) }
            : {};
        return {
          events: [],
          responseGlyph: at(clueHolder(whoSym(fact.by), syms.now(itemId)), level),
          ...followUp,
          memo,
        };
      }
      if (fact?.kind === "loose") {
        // A loose item's clue IS the building when known — "over there" says
        // nothing once rooms are walled houses.
        return {
          events: [],
          responseGlyph: place ? at(cluePlace(syms.now(itemId), place), level) : "there",
          memo,
        };
      }
      return { events: [], responseGlyph: at(DONT_KNOW, level), memo };
    }
    case "why": {
      // Reveal the cause. Effect clause = the creature's sad state ("i_me sad").
      // A CAUSAL FACT answers with its clause; else a MOTIVE creature answers
      // with its condition ("because i_me cold"). No world effect, no close.
      const effect: PhraseSpec = { subject: "i_me", verb: "sad", key: "sad" };
      const factNeed = creature?.needs.find((n) => !n.fulfilled && n.causalFact);
      if (factNeed?.causalFact) {
        const kind = factNeed.causalFact.cause.kind;
        // Preference/desire facts answer with the WANT as the effect ("I want a
        // toy because I want to play", "…because I like red"); lack/state facts
        // keep the sad effect ("I'm sad because the generator is off").
        const eff: PhraseSpec =
          kind === "likes" || kind === "wantsTo"
            ? { subject: "i_me", verb: "want", object: syms.wantOf(factNeed) }
            : effect;
        const cause = clauseSpec(factNeed.causalFact.cause, whoSym, syms);
        return {
          events: [],
          responseGlyph: at(causalPhrase(eff, factNeed.causalFact.connective, cause), level),
          memo,
        };
      }
      if (creature?.condition) {
        // "I want hot because I am cold" — the want + its motive. The causal link
        // belongs HERE (the answer), not in the opening greeting. A stay-with
        // need's want is the company ("stay with me because I'm lonely").
        const motiveNeed = creature.needs.find(
          (n) => !n.fulfilled && !n.placedAt && !n.forCreature && !n.deviceState && !n.atPlace,
        );
        const stayNeed = creature.needs.find((n) => !n.fulfilled && n.stay);
        const clause: PhraseSpec = motiveNeed
          ? { subject: "i_me", verb: "want", object: syms.wantOf(motiveNeed) }
          : stayNeed
            ? { subject: "you", verb: "stay", tail: { join: "with", symbol: "i_me" } }
            : effect;
        const condClause: PhraseSpec = { subject: "i_me", verb: creature.condition, key: creature.condition };
        return { events: [], responseGlyph: at(causalPhrase(clause, "because", condClause), level), memo };
      }
      return { events: [], memo };
    }
    case "confused":
      return { events: [], memo }; // caller re-projects one level down
    case "bye":
      return { events: [], responseGlyph: "ok", close: true, memo };
  }
}
