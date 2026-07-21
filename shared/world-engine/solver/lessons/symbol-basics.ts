// shared/goal-tree/lessons/symbol-basics.ts
//
// The built-in default symbol-learning game ("Big and Small") — the content the
// `symbol_learning` app ships. A tiny but complete WATCH→MAKE lesson on the
// goal-tree engine, demonstrating the `observe` beat end to end:
//
//   • observe "see_big" — walk to the ball and WATCH it grow big, then shrink
//     small; the moment is labelled with the `big ↔ small` glyph (DemoCue scale).
//   • choose "pick_big" — the teacher asks "Which one is BIG?" (the MAKE test).
//   • both gate the finish: you must watch AND answer to reach the goal.
//
// It is a plain data constant (stable reference, so the player doesn't re-init
// each render) and MUST certify — covered by goal-tree-observe coverage and the
// app's load_game certification. English-only for v1; localized lesson packs are
// a follow-up (the AAC narrates over it in the student's language regardless).

import type { GoalTreeGame } from "../types.js";

export const symbolBasicsGame: GoalTreeGame = {
  engine: "goal-tree",
  engineVersion: 1,
  meta: {
    title: "Big and Small",
    description: "Watch how things get big and small, then show what you learned.",
    locale: "en",
    theme: "bright learning playground",
    aiCompanion: {
      name: "Sunny",
      persona: "Warm and playful. Cheers in short, simple sentences.",
    },
    learningGoals: ["big", "small"],
  },
  entities: [
    { id: "finish", kind: "marker", label: "Star", iconRef: "⭐" },
    { id: "watch_sign", kind: "obstacle", label: "Watch sign", iconRef: "🔒" },
    { id: "quiz_sign", kind: "obstacle", label: "Question", iconRef: "❓" },
    { id: "teacher", kind: "character", label: "Sunny", iconRef: "🧑‍🏫" },
    { id: "ball", kind: "item", label: "Ball", iconRef: "⚽" },
    { id: "big_thing", kind: "item", label: "Big one", iconRef: "🟠" },
    { id: "small_thing", kind: "item", label: "Small one", iconRef: "🔵" },
  ],
  root: {
    type: "reach",
    id: "finish",
    intro: "Let's learn about big and small!",
    outro: "You did it! Big and small — you know them now!",
    markerEntityId: "finish",
    zoneHint: "star meadow",
    via: [
      {
        type: "overcome",
        id: "watch_lock",
        obstacleEntityId: "watch_sign",
        prompt: "First, watch how the ball changes!",
        key: {
          type: "observe",
          id: "see_big",
          intro: "Look at the ball…",
          outro: "It got BIG, then small!",
          targetGlyph: "big",
          contrastGlyph: "small",
          stageEntityId: "ball",
          zoneHint: "watching spot",
          demonstrate: [
            { kind: "scale", entityId: "ball", to: 3, seconds: 1.3 },
            { kind: "scale", entityId: "ball", to: 0.5, seconds: 1.3 },
          ],
        },
      },
      {
        type: "overcome",
        id: "quiz_lock",
        obstacleEntityId: "quiz_sign",
        prompt: "Now show me — which one is big?",
        key: {
          type: "choose",
          id: "pick_big",
          posedByEntityId: "teacher",
          prompt: "Which one is BIG?",
          options: [
            { entityId: "big_thing", correct: true },
            { entityId: "small_thing", feedback: "That's the small one. Try the big one!" },
          ],
        },
      },
    ],
  },
};
