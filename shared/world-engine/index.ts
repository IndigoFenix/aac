// shared/world-engine/index.ts — public surface for the data-driven world engine.
//
// A WorldSpec is pure JSON an app ships (and, later, an AI generates). The
// engine turns a CERTIFIED spec into a live, deterministic 2D simulation that
// the client renders (in 2D or 3D) and the call mesh syncs. certifyWorldSpec()
// is the single gate any stored/generated spec must pass before reaching the
// engine — the runtime may assume any spec it is handed has certified.

export * from "./types.js";
export * from "./schema.js";
export * from "./engine.js";
export * from "./net.js";

import type { WorldSpec } from "./types.js";
import { validateWorldSpec } from "./schema.js";

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
  return { ok: true, spec: validated.data };
}
