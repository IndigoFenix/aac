// shared/world-engine/index.ts — public surface for the data-driven world engine.
//
// A WorldSpec is pure JSON an app ships (and, later, an AI generates). The
// engine turns a CERTIFIED spec into a live, deterministic 2D simulation that
// the client renders (in 2D or 3D) and the call mesh syncs. certifyWorldSpec()
// is the single gate any stored/generated spec must pass before reaching the
// engine — the runtime may assume any spec it is handed has certified.
//
// LAYOUT — everything the simulation needs to run LOCALLY (offline) lives under this folder.
// The network/LLM control surfaces that drive "bodies" from outside stay OUT (shared/social-world,
// shared/social-bot). This barrel is the sim CORE (engine/world-host/render/npc-body/net-format);
// the consolidated domains sit alongside it:
//   kernel/       the generic simulation kernel (cells · civ · geology · town · behavior)
//   solver/       the deterministic goal-tree solver
//   interaction/  NPC dialogue + the non-LLM intent decoder (the beta sentence builder)
//   space/ planet/ place/   celestial + world-embedding sim
// net.ts is the pure, offline wire FORMAT (no I/O) — the actual transport is in social-world.

export * from "./types.js";
export * from "./schema.js";
export * from "./engine.js";
export * from "./net.js";

import type { WorldSpec } from "./types.js";
import { validateWorldSpec } from "./schema.js";
import { expandWorldBuildings } from "./engine.js";

export type WorldCertification =
  | { ok: true; spec: WorldSpec }
  | { ok: false; stage: "schema"; errors: string[] };

/**
 * Certification gauntlet. v1 is schema-only — a sandbox world carries no
 * solvability obligation. Future content layers (e.g. an embedded goal-tree)
 * add stages here, mirroring certifyGoalTreeGame.
 */
export function certifyWorldSpec(input: unknown): WorldCertification {
  const validated = validateWorldSpec(input);
  if (!validated.ok) {
    return { ok: false, stage: "schema", errors: validated.errors };
  }
  // Lower buildings into perimeter structures so the engine sees a ready spec.
  return { ok: true, spec: expandWorldBuildings(validated.data) };
}
