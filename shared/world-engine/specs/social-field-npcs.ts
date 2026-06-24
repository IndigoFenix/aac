// shared/world-engine/specs/social-field-npcs.ts
//
// The social field, populated with two AI-driven NPCs — the demo/test world for
// the NPC system. Kept SEPARATE from social-field (the default call game) so real
// calls don't get NPCs until owner election lands (Phase 2); the clinician's
// "Test game room" button points here to exercise NPC steering in isolation.
//
// The two NPCs cover the contrasting movement behaviors:
//   • Maya wanders the field (idle presence),
//   • Theo walks up to whoever is nearest and holds a conversational distance.
// Their `persona` blocks mirror the social_trainer app params verbatim, so the
// Phase-2 brain can pass them straight to generatePersona / DirectedSession.

import type { WorldSpec } from "../types.js";

export const socialFieldNpcsSpec: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: {
    title: "The Field (with friends)",
    description: "The open field, with a couple of AI characters to meet and talk to.",
    locale: "en",
    theme: "playground",
  },
  manifold: { kind: "flat", width: 80, height: 60 },
  terrain: { kind: "flat", groundColor: "#6db36b" },
  spawns: [
    { id: "north", x: 40, y: 20, facing: Math.PI / 2 },
    { id: "south", x: 40, y: 40, facing: -Math.PI / 2 },
    { id: "west", x: 28, y: 30, facing: 0 },
    { id: "east", x: 52, y: 30, facing: Math.PI },
  ],
  toys: [
    {
      id: "ball",
      kind: "soccer_ball",
      x: 40,
      y: 30,
      radius: 0.5,
      dribbleDistance: 1.0,
      friction: 0.25,
      releaseSpeed: 0.6,
      touchRadius: 1.2,
    },
  ],
  npcs: [
    {
      id: "npc_maya",
      x: 24,
      y: 18,
      facing: 0,
      name: "Maya",
      persona: {
        genderHint: "female",
        archetypeHint: "sunny_extrovert",
        interestHints: ["drawing", "animals"],
        difficulty: "gentle",
        scenario: "making_friends",
      },
      behavior: { movement: "wander" },
    },
    {
      id: "npc_theo",
      x: 56,
      y: 42,
      facing: Math.PI,
      name: "Theo",
      persona: {
        genderHint: "male",
        archetypeHint: "even_keel",
        interestHints: ["space", "trains"],
        difficulty: "gentle",
        scenario: "greeting",
      },
      behavior: { movement: "approach_nearest", conversationRadius: 8 },
    },
  ],
  multiplayer: { maxPlayers: 8, authority: "distributed" },
  content: { kind: "sandbox" },
};
