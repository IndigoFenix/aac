// shared/world-engine/specs/social-field.ts
//
// The first WorldSpec: a flat social field with one soccer ball. This is the
// "static JSON an app ships" the engine consumes for the Phase-1 "world on a
// call" slice. Authored here as a typed constant so it type-checks against the
// schema; shipping it as a .json asset later is a serialization detail (the app
// loads JSON → certifyWorldSpec → createWorldState).

import type { WorldSpec } from "../types.js";

export const socialFieldSpec: WorldSpec = {
  engine: "world",
  engineVersion: 1,
  meta: {
    title: "The Field",
    description: "A simple open field to meet up and kick a ball around.",
    locale: "en",
    theme: "playground",
  },
  // A roomy field with a central meeting area — players enter near the middle
  // (and near each other) and roam out; the camera follows so the size is for
  // space to spread into, not to fit on screen at once.
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
  multiplayer: { maxPlayers: 8, authority: "distributed" },
  content: { kind: "sandbox" },
};
