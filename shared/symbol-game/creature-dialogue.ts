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
  giveAsk,
  giveOffer,
  noStock,
  phrase,
  requestAsk,
  VENDOR_GREET,
  wantAsk,
  REJECTED_LINE,
  type LeveledGlyphs,
  type SyntaxLevel,
} from "./dialogue-gen.js";
import {
  giveItem,
  knownHoldings,
  needStateOk,
  openNeeds,
  requestItem,
  settleObligations,
  STATE_TAGS,
  valueTo,
  type CreatureEvent,
  type CreatureId,
  type CreatureNeed,
  type CreatureWorld,
  type ItemId,
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
  | "back" // leave the trade menu
  | "how-are-you" // small talk; reveals a hidden need
  | "where-is" // information request about an item
  | "confused" // re-model one level down (presentation-level)
  | "bye"; // close the conversation

export interface DialogueAct {
  kind: DialogueActKind;
  itemId?: ItemId;
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
const modsOf = (symbol: string): string[] => symbol.split(".").slice(1);

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
  const want = (n: Pick<CreatureNeed, "itemId" | "requiresState">): string =>
    n.requiresState ? `${base(n.itemId)}.${n.requiresState}` : sym(n.itemId);
  return { base, now, want };
}

// -- interim templates (registry gaps noted in the header) -------------------

const BYE: LeveledGlyphs = { a: "goodbye", b: "goodbye", c: "goodbye" };
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
/** Multi-item needs: a same-kind need already fulfilled → the ask reads MORE. */
function wantMore(thing: string): LeveledGlyphs {
  return { a: "more", b: `more + ${thing}`, c: `want + more + ${thing}` };
}
/** Placement (state) need: "I want {thing} in {dest}". */
function wantPlace(thing: string, dest: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "want", object: thing, tail: { join: "in", symbol: dest } });
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
  const isStateNeed = (n: { placedAt?: string; forCreature?: string }) => !!n.placedAt || !!n.forCreature;
  const holdingNeed =
    need && !isStateNeed(need)
      ? (carried.find((c) =>
          creature.needs.some(
            (n) =>
              !n.fulfilled &&
              !isStateNeed(n) &&
              n.itemId === c &&
              needStateOk(n, world.items[c]?.states ?? []),
          ),
        ) ?? null)
      : null;

  // -- the line ---------------------------------------------------------------
  let lineGlyph: string;
  if (memo.statedPrice) {
    lineGlyph =
      memo.statedPrice.kind === "return"
        ? at(giveAsk(sym(memo.statedPrice.itemId)), level)
        : at(wantAsk(sym(memo.statedPrice.itemId)), level);
  } else if (memo.tradeMenu && need) {
    lineGlyph = at(tradeWhat(syms.want(need)), level); // "cookie for…?"
  } else if (need) {
    if (need.placedAt) {
      lineGlyph = at(wantPlace(syms.want(need), sym(need.placedAt)), level);
    } else if (need.forCreature) {
      lineGlyph = at(wantFor(syms.want(need), whoSym(need.forCreature)), level);
    } else if (holdingNeed) {
      lineGlyph = at(giveAsk(syms.now(holdingNeed)), level);
    } else {
      // A same-kind need already fulfilled → "more" (Counting b, emergent).
      const again = creature.needs.some((n) => n.fulfilled && sym(n.itemId) === sym(need.itemId));
      lineGlyph = at(again ? wantMore(syms.want(need)) : wantAsk(syms.want(need)), level);
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
      // item — the missing step is the box / the recipient, not finding it.
      if (!(isStateNeed(need) && carried.includes(need.itemId))) {
        push("cant", cantGlyph(syms.want(need)), need.itemId);
      }
    }
    // Same-KIND wrong-variant offers (descriptors): carrying "ball.small" when
    // "ball.big" is wanted still shows the offer — the corrective decline
    // ("ball + big.not") is the lesson, so the act must be reachable.
    if (!need.placedAt) {
      // (Wrong-STATE offers need no special case — the exactly-needed item in
      // the wrong state IS holdingNeed-ineligible, and the general carried
      // check below keeps it offerable via the same-symbol guard on syms.now.)
      for (const c of carried) {
        if (c === holdingNeed) continue;
        if (headOf(sym(c)) !== headOf(sym(need.itemId)) || syms.now(c) === syms.want(need)) continue;
        if (acts.some((a) => a.kind === "offer" && a.itemId === c)) continue;
        push("offer", giveOffer(syms.now(c)), c);
      }
    }
    push("refuse", refuseGlyph(holdingNeed ? syms.now(holdingNeed) : null), need.itemId);
    push("where-is", whereIs(syms.base(need.itemId)), need.itemId);
    // Information requests aren't gated on MY need: heard wants are askable
    // here too — the ask-around loop, where any creature may hold the clue.
    for (const itemId of opts.askableWhere ?? []) {
      if (itemId === need.itemId) continue;
      if (carried.includes(itemId) || world.items[itemId]?.ownerId === playerId) continue;
      push("where-is", whereIs(syms.base(itemId)), itemId);
    }
  } else {
    // STATE 2 — no visible need: small talk, requests, information.
    push("how-are-you", HOW_ARE_YOU);
    for (const itemId of known) {
      push("request", requestAsk(syms.now(itemId)), itemId);
    }
    if (memo.statedPrice && !carried.includes(memo.statedPrice.itemId)) {
      push("cant", cantGlyph(sym(memo.statedPrice.itemId)), memo.statedPrice.itemId);
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
  push("confused", { a: "confused", b: "confused", c: "confused" });
  push("bye", BYE);

  // Cap to the board, always keeping confused + bye.
  const max = opts.maxActs ?? 8;
  const standing = acts.filter((a) => a.kind === "confused" || a.kind === "bye");
  const rest = acts.filter((a) => a.kind !== "confused" && a.kind !== "bye");
  return { lineGlyph, acts: [...rest.slice(0, Math.max(0, max - standing.length)), ...standing] };
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
          responseGlyph: at(wantPlace(syms.want(placeNeed), sym(placeNeed.placedAt!)), level),
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
        const offered = sym(act.itemId);
        // Right item, wrong STATE → "apple + hot.not" — go find the station.
        const stateNeed = creature?.needs.find(
          (n) =>
            !n.fulfilled &&
            !n.placedAt &&
            !n.forCreature &&
            n.itemId === act.itemId &&
            !needStateOk(n, world.items[act.itemId]?.states ?? []),
        );
        if (stateNeed?.requiresState) {
          return {
            events: [],
            responseGlyph: at(wrongVariant(headOf(offered), stateNeed.requiresState), level),
            memo,
          };
        }
        // Right KIND, wrong DESCRIPTOR → name what's missing ("ball + big.not")
        // instead of a flat "don't want" — the decline teaches the modifier.
        const wanted = creature?.needs.find(
          (n) =>
            !n.fulfilled &&
            !n.placedAt &&
            headOf(sym(n.itemId)) === headOf(offered) &&
            sym(n.itemId) !== offered,
        );
        const wantedMod = wanted
          ? (modsOf(sym(wanted.itemId)).find((m) => !modsOf(offered).includes(m)) ??
            modsOf(sym(wanted.itemId))[0])
          : undefined;
        if (wanted && wantedMod) {
          return { events: [], responseGlyph: at(wrongVariant(headOf(offered), wantedMod), level), memo };
        }
        return { events: [], responseGlyph: at(declineOffer(sym(act.itemId)), level), memo };
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
          ? mineDecline(sym(act.itemId))
          : noStock(sym(act.itemId));
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
      return { events: [], memo: { ...memo, tradeMenu: false } };
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
                : wantAsk(syms.want(hidden)),
            level,
          ),
          memo: { ...memo, revealed: true },
        };
      }
      return { events: [], responseGlyph: "ok", memo };
    }
    case "where-is": {
      if (!act.itemId || !creature) return { events: [], memo };
      const fact = creature.knowledge[act.itemId];
      // The BUILDING clue ("in the blue house") — the world layer resolves the
      // item's house; with real buildings the holder alone isn't findable.
      const place = opts.placeOf?.(act.itemId);
      if (fact?.kind === "held" && fact.by === creatureId) {
        // First person — never its own name ("I have it", not "rabbit has it").
        return { events: [], responseGlyph: at(clueSelf(syms.now(act.itemId)), level), memo };
      }
      if (fact?.kind === "held") {
        // whoSym: the player reads as "you", third parties keep their symbol.
        // A third party's clue gets the building follow-up ("bear has the
        // ball" … "the ball is in the blue house") — never for "you have it".
        const followUp =
          fact.by !== playerId && place
            ? { followUpGlyph: at(cluePlace(syms.now(act.itemId), place), level) }
            : {};
        return {
          events: [],
          responseGlyph: at(clueHolder(whoSym(fact.by), syms.now(act.itemId)), level),
          ...followUp,
          memo,
        };
      }
      if (fact?.kind === "loose") {
        // A loose item's clue IS the building when known — "over there" says
        // nothing once rooms are walled houses.
        return {
          events: [],
          responseGlyph: place ? at(cluePlace(syms.now(act.itemId), place), level) : "there",
          memo,
        };
      }
      return { events: [], responseGlyph: at(DONT_KNOW, level), memo };
    }
    case "confused":
      return { events: [], memo }; // caller re-projects one level down
    case "bye":
      return { events: [], responseGlyph: "ok", close: true, memo };
  }
}
