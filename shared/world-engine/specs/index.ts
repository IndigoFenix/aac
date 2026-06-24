// shared/world-engine/specs/index.ts
//
// Registry of named WorldSpecs. A game room references a spec by KEY (a short
// stable string) rather than embedding the whole document, so the server can
// hand a client "run social-field" and both resolve the same certified spec.
// Today the specs are static constants shipped in-tree; later an AI-generated
// spec is stored and registered the same way (key → certified WorldSpec).

import type { WorldSpec } from "../types.js";
import { socialFieldSpec } from "./social-field.js";
import { socialFieldNpcsSpec } from "./social-field-npcs.js";

export const WORLD_SPECS: Record<string, WorldSpec> = {
  "social-field": socialFieldSpec,
  "social-field-npcs": socialFieldNpcsSpec,
};

export function getWorldSpec(key: string): WorldSpec | null {
  return WORLD_SPECS[key] ?? null;
}

export { socialFieldSpec, socialFieldNpcsSpec };
