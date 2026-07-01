// shared/symbol-game/catalog/requesting.ts
//
// Catalog family A — Requesting & wanting (planning-docs/symbol-learning-game-plan.md §4.A).
// Concepts: WANT, MORE, ALL-DONE (→ "finished"), GIVE/TAKE.
//
// Each entry is a QuoteExchange: an NPC prompt + a student response set. Glyph
// templates are language-INVARIANT; `textKey` resolves the per-locale text.
// `{slot}` placeholders bind from shared/symbol-game/pools.ts and freeze before
// distractors are generated (§6.2).
//
// Notes:
//   • "finished" is the shipped ALL-DONE symbol (no "all_done" key in the registry).
//   • A2/A3 are intent quotes (§3.4): the marked `correct` drives LOW-phase
//     scaffolding, but at P4 they're `intentNoKey` — logged, not scored.
//   • A1 is a DO beat (comprehension verified in the world), so it has no board
//     responses; it compiles to a transport/collect node, not a choose.

import type { QuoteExchange } from "../types.js";

export const REQUESTING_EXCHANGES: QuoteExchange[] = [
  // A1 — "I want ___" → carry the matching treat (among others) to the spot (DO beat).
  {
    id: "a1-want-fetch",
    concept: "want",
    action: { kind: "fetch", slot: "treat" },
    prompt: {
      id: "a1-prompt",
      glyph: "i_me + want + {treat}",
      textKey: "symbolGame.quote.a1.prompt",
      slots: ["treat"],
      speaker: "npc",
      concept: "want",
    },
    responses: [],
  },

  // A2 — vendor offers a treat/reject; "want / no". Intent quote at P4.
  {
    id: "a2-want-or-not",
    concept: "want",
    intentNoKey: true,
    prompt: {
      id: "a2-prompt",
      glyph: "want + {treat}",
      textKey: "symbolGame.quote.a2.prompt",
      slots: ["treat"],
      speaker: "npc",
      concept: "want",
      operator: "question",
    },
    responses: [
      {
        quote: {
          id: "a2-want",
          glyph: "want",
          textKey: "symbolGame.quote.a2.want",
          slots: [],
          speaker: "board",
          concept: "want",
        },
        correct: true,
      },
      {
        quote: {
          id: "a2-want-not",
          glyph: "want.not",
          textKey: "symbolGame.quote.a2.wantNot",
          slots: [],
          speaker: "board",
          concept: "want",
        },
      },
    ],
  },

  // A3 — machine emits one {emit}, waits; "more / all done". Contingency; intent at P4.
  {
    id: "a3-more-or-done",
    concept: "more",
    intentNoKey: true,
    prompt: {
      id: "a3-prompt",
      glyph: "more + {emit}",
      textKey: "symbolGame.quote.a3.prompt",
      slots: ["emit"],
      speaker: "npc",
      concept: "more",
      operator: "question",
    },
    responses: [
      {
        quote: {
          id: "a3-more",
          glyph: "more",
          textKey: "symbolGame.quote.a3.more",
          slots: [],
          speaker: "board",
          concept: "more",
        },
        correct: true,
      },
      {
        quote: {
          id: "a3-finished",
          glyph: "finished",
          textKey: "symbolGame.quote.a3.finished",
          slots: [],
          speaker: "board",
          concept: "finished",
        },
      },
    ],
  },

  // A4 — "give me ___?" → ok / no.
  {
    id: "a4-give-me",
    concept: "give",
    prompt: {
      id: "a4-prompt",
      glyph: "give + to + i_me + {toy}",
      textKey: "symbolGame.quote.a4.prompt",
      slots: ["toy"],
      speaker: "npc",
      concept: "give",
      operator: "question",
    },
    responses: [
      {
        quote: {
          id: "a4-give",
          glyph: "give",
          textKey: "symbolGame.quote.a4.give",
          slots: [],
          speaker: "board",
          concept: "give",
        },
        correct: true,
      },
      {
        quote: {
          id: "a4-give-not",
          glyph: "give.not",
          textKey: "symbolGame.quote.a4.giveNot",
          slots: [],
          speaker: "board",
          concept: "give",
        },
      },
    ],
  },

  // A6 — friend has no {toy}; "give ___ / take ___" (head-slot minimal pair, {toy} held constant).
  {
    id: "a6-give-or-take",
    concept: "give",
    prompt: {
      id: "a6-prompt",
      glyph: "{friend} + have.not + {toy}",
      textKey: "symbolGame.quote.a6.prompt",
      slots: ["friend", "toy"],
      speaker: "npc",
      concept: "give",
    },
    responses: [
      {
        quote: {
          id: "a6-give",
          glyph: "give + {toy}",
          textKey: "symbolGame.quote.a6.give",
          slots: ["toy"],
          speaker: "board",
          concept: "give",
        },
        correct: true,
      },
      {
        quote: {
          id: "a6-take",
          glyph: "take + {toy}",
          textKey: "symbolGame.quote.a6.take",
          slots: ["toy"],
          speaker: "board",
          concept: "take",
        },
      },
    ],
  },

  // A7 — "want more ___?" → want more / no more (the `.more` modifier on a request).
  {
    id: "a7-want-more",
    concept: "more",
    prompt: {
      id: "a7-prompt",
      glyph: "want.more + {treat}",
      textKey: "symbolGame.quote.a7.prompt",
      slots: ["treat"],
      speaker: "npc",
      concept: "more",
      operator: "question",
    },
    responses: [
      {
        quote: {
          id: "a7-want-more",
          glyph: "want.more",
          textKey: "symbolGame.quote.a7.wantMore",
          slots: [],
          speaker: "board",
          concept: "more",
        },
        correct: true,
      },
      {
        quote: {
          id: "a7-want-not-more",
          glyph: "want.not.more",
          textKey: "symbolGame.quote.a7.wantNotMore",
          slots: [],
          speaker: "board",
          concept: "more",
        },
      },
    ],
  },
];
