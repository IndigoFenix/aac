// shared/world-engine/interaction/dialogue/dialogue-gen.ts
//
// The GET-ITEM dialogue generator — turns one bound quest spec into the
// goal-tree `converse` node(s) + entities that play it, following the dialogue
// templates of planning-docs/symbol-learning-game/puzzle-types.md §Specifics.
//
// Three quest shapes (the Quest Complexity dimension):
//   simple   — a GIVER wants an item that lies loose in their room.
//   request  — the GIVER wants an item a VENDOR stocks; the player must ask
//              the vendor for it (repeating the giver's syntax — the lesson).
//   exchange — a TRADER holds the item but wants a PAY item first (cause and
//              effect: give X, receive Y).
//
// Every NPC utterance and board option exists at three SYNTAX LEVELS
// (a: single glyph · b: two glyphs · c: sentence). A game is generated at one
// level, and every main turn carries a CONFUSED option that drops the SAME
// turn one level down (puzzle-types: "reduces syntax complexity") — pure graph
// structure, no engine support needed. At the floor level it re-presents the
// same turn (the NPC repeats itself — a harmless re-model).
//
// Dialogue rules honored (schema-enforced):
//   • every turn keeps an unconditional option (the board never renders empty)
//   • give options are gated on carrying the given item
//   • an item is consumed by at most one converse node
//
// Symbols: only registry-SHIPPED symbols are used in the fixed templates
// (yes/no/ok/help/confused/want/give/have/sad/here/hi/thank_you…). Question
// words (where/why) are a known registry gap — the ask-for-clue branch uses
// HELP until they ship (see glyph-symbol-vocabulary.md).
//
// i18n note: glyph strings are the language-INVARIANT canonical form; SPOKEN
// per-locale text comes from the translation rulesets in ./lang (en/he/es/pt),
// applied at speak time — see lang/core.ts.

import type {
  ConverseNode,
  ConverseOption,
  ConverseTurn,
  EntityDef,
} from "../../solver/types.js";
import type { PoolMember } from "@shared/world-engine/interaction/types.js";
import type { Connective } from "@shared/world-engine/interaction/behavior/creatures.js";

// ---------------------------------------------------------------------------
// Syntax levels
// ---------------------------------------------------------------------------

export type SyntaxLevel = "a" | "b" | "c";

/** One utterance at each syntax level. */
export type LeveledGlyphs = Record<SyntaxLevel, string>;

/** The levels a game generated at `level` actually uses (level → floor). */
export function levelChain(level: SyntaxLevel): SyntaxLevel[] {
  const order: SyntaxLevel[] = ["c", "b", "a"];
  return order.slice(order.indexOf(level));
}

function levelDown(level: SyntaxLevel): SyntaxLevel {
  return level === "c" ? "b" : "a";
}

// ---------------------------------------------------------------------------
// Quest spec
// ---------------------------------------------------------------------------

export type QuestComplexity = "simple" | "request" | "exchange" | "lend";

export interface GetItemQuestSpec {
  /** Quest id prefix — seeds every node/entity id ("q0"). */
  id: string;
  /** Syntax level the dialogue opens at (confusion drops it). */
  level: SyntaxLevel;
  complexity: QuestComplexity;
  /** The quest giver (a friend-pool member). */
  giver: PoolMember;
  /** The wanted item. */
  item: PoolMember;
  /** The vendor/trader NPC (request/exchange/lend only). */
  supplier?: PoolMember;
  /** What the trader wants in exchange (exchange only). */
  pay?: PoolMember;
  /** The lending vendor's other borrowable (lend only). */
  lend?: PoolMember;
  /** Wrong things the player can ask the vendor for (request only). */
  distractorAsks?: PoolMember[];
  /**
   * Exchange only: does the trader state their price unprompted ("before"),
   * or only after the player requests the item ("after")? Default "before".
   */
  announce?: "before" | "after";
}

export interface GeneratedQuest {
  /** The giver's conversation (+ the supplier's, for request/exchange). */
  converses: ConverseNode[];
  /** NPCs, items, and board-option entities (shared ones use fixed ids). */
  entities: EntityDef[];
  /** Concepts exercised, for meta.learningGoals. */
  concepts: string[];
}

// ---------------------------------------------------------------------------
// Shared board options (fixed ids — world assembly dedupes across quests)
// ---------------------------------------------------------------------------

const SHARED_OPTIONS: Record<string, string> = {
  opt_yes: "yes",
  opt_no: "no",
  opt_ok: "ok",
  opt_help: "help",
  opt_confused: "confused",
};

export function sharedOptionEntities(): EntityDef[] {
  return Object.entries(SHARED_OPTIONS).map(([id, glyph]) => ({
    id,
    kind: "item",
    label: glyph,
    glyph,
  }));
}

// ---------------------------------------------------------------------------
// The PHRASE generator — conceptual Subject/Verb/Object → LeveledGlyphs
// ---------------------------------------------------------------------------

/**
 * A conceptual phrase: WHO does WHAT to WHAT (+ an optional relation tail).
 * Subjects/objects arrive already deixis-resolved ("i_me"/"you"/a creature's
 * symbol). The generator derives every syntax level from the same structure:
 *
 *   a — the single most informative slot (`key`; default object → verb).
 *   b — two content slots: object + tail when a tail exists (the relation is
 *       the teaching point), else verb + object, else subject + verb.
 *   c — the full, proper sentence: subject + verb + object (+ tail), capped
 *       at 3 CONTENT slots (joins like "to"/"in" bind free) — the subject
 *       drops first when a tail complement would push past three.
 *
 * This is deliberately the ONE place GLYPH order lives: `order` is "svo" today;
 * a future SOV/VSO locale reorders slots here. SPOKEN word order is separate —
 * the per-locale translation rulesets (./lang) re-derive roles from the glyph
 * string and say it properly (all shipped locales are SVO, so both agree).
 */
export interface PhraseSpec {
  subject?: string;
  verb?: string;
  object?: string;
  /** Forward-binding complement after the object ("to bear", "in box"). */
  tail?: { join: string; symbol: string };
  /** Level-a override (default: object, else verb, else subject). */
  key?: string;
  /** Level-b override, for shapes where the auto pick reads wrong. */
  b?: string;
  /** Level-b needs the FULL sentence for clarity (clues: "rabbit have ball"). */
  bFull?: boolean;
}

export function phrase(p: PhraseSpec, order: "svo" = "svo"): LeveledGlyphs {
  void order; // one order today; per-locale SOV/VSO reorders slots HERE
  const tail = p.tail ? [p.tail.join, p.tail.symbol] : [];
  const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join(" + ");
  const a = p.key ?? p.object ?? p.verb ?? p.subject ?? "";
  const contentSlots = [p.subject, p.verb, p.object, p.tail?.symbol].filter(Boolean).length;
  const c =
    contentSlots > 3 ? join([p.verb, p.object, ...tail]) : join([p.subject, p.verb, p.object, ...tail]);
  const b =
    p.b ??
    (p.bFull
      ? c
      : p.tail
        ? join([p.object ?? p.verb, ...tail])
        : p.verb && p.object
          ? join([p.verb, p.object])
          : join([p.subject, p.verb ?? p.object]));
  return { a, b: b || a, c: c || b || a };
}

/**
 * A two-clause CAUSAL line (language-structure-tiers.md, Causation tier): an
 * EFFECT clause and a CAUSE clause joined by a connective. Built entirely on
 * phrase() — the connective is an INLINE token, so the wire stays a flat glyph
 * string (`lineGlyph: string`); only the RENDERER and the per-locale rulesets
 * learn to split/stack at connective tokens (the arrow layout the language doc
 * sketches). Level reduction mirrors the CONFUSED syntax-drop:
 *   a — the cause's key slot alone (the new concept, errorless).
 *   b — the cause clause (the BECAUSE half is the teaching point).
 *   c — the full two-clause form (renderer stacks effect / cause).
 */
export function causalPhrase(
  effect: PhraseSpec,
  connective: Connective,
  cause: PhraseSpec,
): LeveledGlyphs {
  const e = phrase(effect);
  const c = phrase(cause);
  return {
    a: c.a,
    b: `${connective} + ${c.b}`,
    c: `${e.c} + ${connective} + ${c.c}`,
  };
}

// ---------------------------------------------------------------------------
// Utterance templates (puzzle-types.md §Specifics, shipped symbols only)
// ---------------------------------------------------------------------------

/** GIVER/TRADER asks for a thing they don't see you holding. */
export function wantAsk(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "want", object: thing });
}

/** GIVER/TRADER asks for the thing you ARE holding (instructive). */
export function giveAsk(thing: string): LeveledGlyphs {
  return phrase({
    subject: "you",
    verb: "give",
    object: thing,
    tail: { join: "to", symbol: "i_me" },
    b: `give + ${thing}`,
  });
}

/** Player OFFERS the thing (the affirm-while-holding option). */
export function giveOffer(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "give", object: thing });
}

/** Player REQUESTS a thing from a vendor. */
export function requestAsk(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "want", object: thing });
}

/** VENDOR's open-ended greeting ("what do you want?"). */
export const VENDOR_GREET: LeveledGlyphs = {
  a: "hi",
  b: "want + thing#question",
  c: "you + want + thing#question",
};

/** VENDOR doesn't stock the asked thing. */
export function noStock(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "have.not", object: thing, key: "no" });
}

/** VENDOR advertises a thing they stock ("I have ___"). */
export function haveLine(thing: string): LeveledGlyphs {
  return phrase({ subject: "i_me", verb: "have", object: thing });
}

/** NPC reaction to a refusal. */
export const REJECTED_LINE: LeveledGlyphs = phrase({ subject: "i_me", verb: "sad", key: "sad" });

/** Clue: the thing is right here (simple quests — Clues dimension a). */
function clueHere(thing: string): LeveledGlyphs {
  return { a: "here", b: `${thing} + here`, c: `${thing} + here` };
}

/** Clue: that NPC has it (request/exchange quests). */
function clueWho(who: string, thing: string): LeveledGlyphs {
  return phrase({ subject: who, verb: "have", object: thing, key: who, bFull: true });
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function optionEntity(id: string, glyph: string): EntityDef {
  return { id, kind: "item", label: glyph, glyph };
}

function npcEntity(id: string, member: PoolMember): EntityDef {
  return {
    id,
    kind: "character",
    label: member.label,
    ...(member.iconRef ? { iconRef: member.iconRef } : {}),
    glyph: member.symbol,
  };
}

function itemEntity(id: string, member: PoolMember): EntityDef {
  return {
    id,
    kind: "item",
    label: member.label,
    ...(member.iconRef ? { iconRef: member.iconRef } : {}),
    glyph: member.symbol,
  };
}

/**
 * The shared "reject → sad → ok" and "help → clue → ok" tail turns, plus the
 * main-turn chain at descending syntax levels. `makeMain` builds one main turn
 * for a level; the CONFUSED option chains them downward.
 */
function buildTurnChain(
  level: SyntaxLevel,
  makeMain: (lvl: SyntaxLevel, confusedNext: string) => ConverseTurn,
  tailTurns: ConverseTurn[],
): { entry: string; turns: ConverseTurn[] } {
  const chain = levelChain(level);
  const mainId = (lvl: SyntaxLevel) => `main_${lvl}`;
  const turns: ConverseTurn[] = chain.map((lvl) => {
    const confusedNext = lvl === "a" ? mainId(lvl) : mainId(levelDown(lvl));
    return makeMain(lvl, confusedNext);
  });
  return { entry: mainId(level), turns: [...turns, ...tailTurns] };
}

/** The universal "ok" close-out turn body. */
function okClose(lines: LeveledGlyphs, id: string, level: SyntaxLevel): ConverseTurn {
  return {
    id,
    lines: [{ glyph: lines[level] }],
    options: [{ entityId: "opt_ok" }],
  };
}

/**
 * Generate one GET-ITEM quest: the giver's converse node, plus a vendor's or
 * trader's for request/exchange complexity. Entities include the NPCs, the
 * item(s), the per-level offer/request options, and the shared yes/no/ok/help/
 * confused options (fixed ids — dedupe when assembling a world).
 */
export function generateGetItemQuest(spec: GetItemQuestSpec): GeneratedQuest {
  const q = spec.id;
  const giverNpcId = `${q}_giver`;
  const itemId = `${q}_item`;
  const entities: EntityDef[] = [
    npcEntity(giverNpcId, spec.giver),
    itemEntity(itemId, spec.item),
    ...sharedOptionEntities(),
  ];
  const converses: ConverseNode[] = [];
  const concepts = new Set<string>(["want", "give", "help"]);

  // -- clue target: where does the giver point the player?
  const supplierNpcId = `${q}_supplier`;
  const clue =
    spec.complexity === "simple"
      ? clueHere(spec.item.symbol)
      : clueWho(spec.supplier?.symbol ?? "there", spec.item.symbol);

  // -- the giver's conversation ----------------------------------------------
  const giverOffers = levelChain(spec.level).map((lvl) => ({
    lvl,
    entity: optionEntity(`${q}_opt_give_${lvl}`, giveOffer(spec.item.symbol)[lvl]),
  }));
  entities.push(...giverOffers.map((o) => o.entity));

  const giverMain = (lvl: SyntaxLevel, confusedNext: string): ConverseTurn => ({
    id: `main_${lvl}`,
    lines: [
      { when: [{ kind: "carrying", entityId: itemId }], glyph: giveAsk(spec.item.symbol)[lvl] },
      { glyph: wantAsk(spec.item.symbol)[lvl] },
    ],
    options: [
      {
        entityId: giverOffers.find((o) => o.lvl === lvl)!.entity.id,
        when: [{ kind: "carrying", entityId: itemId }],
        give: [itemId],
        completes: true,
        cues: [{ kind: "emote", entityId: giverNpcId, emotion: "happy" }],
      },
      { entityId: "opt_yes" }, // "yes, I'll get it" — closes; go fetch
      { entityId: "opt_no", next: "rejected" },
      // The clue REVEALS the item (knowledge-gated requests): for supplier
      // quests the supplier's ask-option only unlocks once the player has
      // learned who holds the item. Simple quests reveal on sight instead
      // (props in an entered zone become known).
      {
        entityId: "opt_help",
        next: "clue",
        ...(spec.complexity !== "simple" ? { reveal: [itemId] } : {}),
      },
      { entityId: "opt_confused", next: confusedNext },
    ],
  });

  const giverChain = buildTurnChain(spec.level, giverMain, [
    okClose(REJECTED_LINE, "rejected", spec.level),
    okClose(clue, "clue", spec.level),
  ]);

  converses.push({
    type: "converse",
    id: `${q}_talk_giver`,
    npcEntityId: giverNpcId,
    entry: giverChain.entry,
    turns: giverChain.turns,
    ...(spec.complexity === "simple" ? { propEntityIds: [itemId] } : {}),
    zoneHint: `${spec.giver.label}'s spot`,
  });

  // -- the supplier's conversation (request/exchange) -------------------------
  if (spec.complexity === "request") {
    if (!spec.supplier) throw new Error(`request quest "${q}" needs a supplier`);
    entities.push(npcEntity(supplierNpcId, spec.supplier));
    concepts.add("have");

    const distractors = (spec.distractorAsks ?? []).slice(0, 2);

    const vendorMain = (lvl: SyntaxLevel, confusedNext: string): ConverseTurn => {
      const reqEntity = optionEntity(`${q}_opt_req_${lvl}`, requestAsk(spec.item.symbol)[lvl]);
      entities.push(reqEntity);
      const wrongs = distractors.map((d, i) => {
        const e = optionEntity(`${q}_opt_req_d${i}_${lvl}`, requestAsk(d.symbol)[lvl]);
        entities.push(e);
        return { entityId: e.id, next: `no_stock_${i}` } satisfies ConverseOption;
      });
      return {
        id: `main_${lvl}`,
        lines: [{ glyph: VENDOR_GREET[lvl] }],
        options: [
          {
            entityId: reqEntity.id,
            // Knowledge gate: you can only ask for what you know the vendor has.
            when: [{ kind: "knows", entityId: itemId }],
            receive: [itemId],
            completes: true,
            cues: [{ kind: "emote", entityId: supplierNpcId, emotion: "happy" }],
          },
          ...wrongs,
          { entityId: "opt_no" }, // "nothing, thanks" — closes
          { entityId: "opt_confused", next: confusedNext },
        ],
      };
    };

    const vendorChain = buildTurnChain(spec.level, vendorMain, [
      ...distractors.map((d, i) => okClose(noStock(d.symbol), `no_stock_${i}`, spec.level)),
    ]);

    converses.push({
      type: "converse",
      id: `${q}_talk_supplier`,
      npcEntityId: supplierNpcId,
      entry: vendorChain.entry,
      turns: vendorChain.turns,
      zoneHint: `${spec.supplier.label}'s stall`,
    });
  } else if (spec.complexity === "exchange") {
    if (!spec.supplier || !spec.pay) {
      throw new Error(`exchange quest "${q}" needs a supplier and a pay item`);
    }
    entities.push(npcEntity(supplierNpcId, spec.supplier));
    const payId = `${q}_pay`;
    entities.push(itemEntity(payId, spec.pay));
    concepts.add("take");

    const tradeOffers = levelChain(spec.level).map((lvl) => ({
      lvl,
      entity: optionEntity(`${q}_opt_trade_${lvl}`, giveOffer(spec.pay!.symbol)[lvl]),
    }));
    entities.push(...tradeOffers.map((o) => o.entity));

    /** The exchange press: hand over the pay, receive the item. */
    const tradeOption = (lvl: SyntaxLevel): ConverseOption => ({
      entityId: tradeOffers.find((o) => o.lvl === lvl)!.entity.id,
      when: [{ kind: "carrying", entityId: payId }],
      give: [payId],
      receive: [itemId],
      completes: true,
      cues: [{ kind: "emote", entityId: supplierNpcId, emotion: "happy" }],
    });

    let traderChain: { entry: string; turns: ConverseTurn[] };
    if (spec.announce === "after") {
      // Trader follows vendor rules: greet neutrally; the player must ASK for
      // the item (knowledge-gated), and only then does the trader state the
      // price. The price turn then behaves like the announcing trader's main.
      const askEntities = levelChain(spec.level).map((lvl) => ({
        lvl,
        entity: optionEntity(`${q}_opt_ask_${lvl}`, requestAsk(spec.item.symbol)[lvl]),
      }));
      entities.push(...askEntities.map((o) => o.entity));

      const priceTurn: ConverseTurn = {
        id: "price",
        lines: [
          { when: [{ kind: "carrying", entityId: payId }], glyph: giveAsk(spec.pay.symbol)[spec.level] },
          { glyph: wantAsk(spec.pay.symbol)[spec.level] },
        ],
        options: [
          tradeOption(spec.level),
          { entityId: "opt_yes" }, // "ok, I'll get it" — closes; go fetch the pay
          { entityId: "opt_no", next: "rejected" },
          { entityId: "opt_help", next: "clue" },
          { entityId: "opt_confused", next: "price" }, // re-model the price
        ],
      };
      const traderAskMain = (lvl: SyntaxLevel, confusedNext: string): ConverseTurn => ({
        id: `main_${lvl}`,
        lines: [{ glyph: VENDOR_GREET[lvl] }],
        options: [
          {
            entityId: askEntities.find((o) => o.lvl === lvl)!.entity.id,
            when: [{ kind: "knows", entityId: itemId }],
            next: "price",
          },
          { entityId: "opt_no" },
          { entityId: "opt_confused", next: confusedNext },
        ],
      });
      traderChain = buildTurnChain(spec.level, traderAskMain, [
        priceTurn,
        okClose(REJECTED_LINE, "rejected", spec.level),
        okClose(clueHere(spec.pay.symbol), "clue", spec.level),
      ]);
    } else {
      // Announcing trader: states the price unprompted (the announcement IS
      // the player's knowledge of the deal).
      const traderMain = (lvl: SyntaxLevel, confusedNext: string): ConverseTurn => ({
        id: `main_${lvl}`,
        lines: [
          { when: [{ kind: "carrying", entityId: payId }], glyph: giveAsk(spec.pay!.symbol)[lvl] },
          { glyph: wantAsk(spec.pay!.symbol)[lvl] },
        ],
        options: [
          tradeOption(lvl),
          { entityId: "opt_yes" },
          { entityId: "opt_no", next: "rejected" },
          { entityId: "opt_help", next: "clue" },
          { entityId: "opt_confused", next: confusedNext },
        ],
      });
      traderChain = buildTurnChain(spec.level, traderMain, [
        okClose(REJECTED_LINE, "rejected", spec.level),
        okClose(clueHere(spec.pay.symbol), "clue", spec.level),
      ]);
    }

    converses.push({
      type: "converse",
      id: `${q}_talk_supplier`,
      npcEntityId: supplierNpcId,
      entry: traderChain.entry,
      turns: traderChain.turns,
      propEntityIds: [payId],
      zoneHint: `${spec.supplier.label}'s stall`,
    });
  } else if (spec.complexity === "lend") {
    // A free vendor with TWO items who asks for the borrowed one back before
    // granting the next (puzzle-types Interaction directive 8).
    if (!spec.supplier || !spec.lend) {
      throw new Error(`lend quest "${q}" needs a supplier and a lend item`);
    }
    entities.push(npcEntity(supplierNpcId, spec.supplier));
    const lendId = `${q}_lend`;
    entities.push(itemEntity(lendId, spec.lend));
    concepts.add("have");

    const chain = levelChain(spec.level);
    const borrow = chain.map((lvl) => ({
      lvl,
      entity: optionEntity(`${q}_opt_borrow_${lvl}`, requestAsk(spec.lend!.symbol)[lvl]),
    }));
    const askItem = chain.map((lvl) => ({
      lvl,
      entity: optionEntity(`${q}_opt_ask_${lvl}`, requestAsk(spec.item.symbol)[lvl]),
    }));
    const askItemFree = chain.map((lvl) => ({
      lvl,
      entity: optionEntity(`${q}_opt_askfree_${lvl}`, requestAsk(spec.item.symbol)[lvl]),
    }));
    const giveBack = optionEntity(`${q}_opt_giveback`, giveOffer(spec.lend.symbol)[spec.level]);
    entities.push(...borrow.map((o) => o.entity), ...askItem.map((o) => o.entity),
      ...askItemFree.map((o) => o.entity), giveBack);

    // "Give it back first": asking for the item while still HOLDING the
    // borrowed one detours through the return turn; once the borrowed item was
    // legitimately given away (`given`), the ask grants free. The two ask
    // options are mutually exclusive in normal play (carrying vs. given).
    const returnTurn: ConverseTurn = {
      id: "return_first",
      lines: [{ glyph: giveAsk(spec.lend.symbol)[spec.level] }],
      options: [
        {
          entityId: giveBack.id,
          when: [{ kind: "carrying", entityId: lendId }],
          give: [lendId],
          receive: [itemId],
          completes: true,
          cues: [{ kind: "emote", entityId: supplierNpcId, emotion: "happy" }],
        },
        { entityId: "opt_no", next: "rejected" },
        { entityId: "opt_confused", next: "return_first" },
      ],
    };
    const lenderMain = (lvl: SyntaxLevel, confusedNext: string): ConverseTurn => ({
      id: `main_${lvl}`,
      // The vendor advertises the borrowable — that's how it becomes known.
      lines: [{ glyph: haveLine(spec.lend!.symbol)[lvl] }],
      options: [
        {
          entityId: borrow.find((o) => o.lvl === lvl)!.entity.id,
          receive: [lendId],
          next: `main_${lvl}`,
        },
        {
          entityId: askItem.find((o) => o.lvl === lvl)!.entity.id,
          when: [
            { kind: "knows", entityId: itemId },
            { kind: "carrying", entityId: lendId },
          ],
          next: "return_first",
        },
        {
          entityId: askItemFree.find((o) => o.lvl === lvl)!.entity.id,
          when: [
            { kind: "knows", entityId: itemId },
            { kind: "given", entityId: lendId },
          ],
          receive: [itemId],
          completes: true,
          cues: [{ kind: "emote", entityId: supplierNpcId, emotion: "happy" }],
        },
        { entityId: "opt_no" },
        { entityId: "opt_confused", next: confusedNext },
      ],
    });
    const lenderChain = buildTurnChain(spec.level, lenderMain, [
      returnTurn,
      okClose(REJECTED_LINE, "rejected", spec.level),
    ]);

    converses.push({
      type: "converse",
      id: `${q}_talk_supplier`,
      npcEntityId: supplierNpcId,
      entry: lenderChain.entry,
      turns: lenderChain.turns,
      zoneHint: `${spec.supplier.label}'s stall`,
    });
  }

  return { converses, entities, concepts: [...concepts] };
}
