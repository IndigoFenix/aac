/**
 * city-districts.ts — SHIM plus the game's standard classifier. The
 * tier-B district machinery moved into the shared engine's town layer
 * (shared/engine/town/city-districts.ts); the DEFAULT_ECONOMY-backed
 * classifier is grand-dream content and stays here.
 */
export * from "@shared/engine/town/city-districts";

import type { WorkClass } from "@shared/engine/town/city-districts";
import { DEFAULT_ECONOMY } from "./economy-core";

/** The standard classifier (DEFAULT_ECONOMY's registry) — callers with a
 *  world attach their own via `deriveDistricts`' `classOf`. */
export function defaultWorkClass(type: string): WorkClass {
  return DEFAULT_ECONOMY.works.find(w => w.key === type)?.district ?? null;
}
