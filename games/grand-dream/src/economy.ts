/**
 * economy.ts — SHIM. The content seam moved into the shared engine
 * (shared/engine/modules/economy) when it became the first capability
 * module; grand-dream's content (economy-core.ts, content/*.json) and
 * every internal `./economy` import keep working through this re-export.
 */
export * from "@shared/engine/modules/economy/economy";
