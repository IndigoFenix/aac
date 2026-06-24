// shared/social-world/npc-conversation-logic.ts
//
// Pure, dependency-free kernels of the NPC conversation layer — the bits worth
// unit-testing without dragging in React or the (JSX) ProceduralFace. Kept in a
// sibling module so a headless test can import them directly (the same reason
// identity logic lives apart from identityService).

import type { NpcSpec } from "../world-engine/types.js";

export type ConvMode = "WITHDRAWN" | "GUARDED" | "PLAYFUL" | "OPEN" | "NEUTRAL";

const DIFFICULTY_NUM: Record<string, number> = { gentle: 0.2, medium: 0.5, challenging: 0.8 };

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Director mode + rapport → a body bias in -1..1 (withdrawn drifts off, open leans in). */
export function modeToPull(mode: ConvMode, rapport: number): number {
  const base: Record<ConvMode, number> = { WITHDRAWN: -0.8, GUARDED: -0.4, NEUTRAL: 0, OPEN: 0.5, PLAYFUL: 0.8 };
  return clamp(base[mode] * 0.6 + rapport * 0.4, -1, 1);
}

/**
 * Elect the NPC owner: the lexicographically-smallest participant id hosts every
 * NPC's body + brain. Deterministic so every peer converges on the same owner
 * without coordination (matches the toy-possession tie-break in world-engine/net).
 * `selfId` null (call not ready) ⇒ solo ⇒ this peer owns.
 */
export function electNpcOwner(selfId: string | null, otherIds: Iterable<string>): string | null {
  if (!selfId) return null;
  let min = selfId;
  for (const id of otherIds) if (id < min) min = id;
  return min;
}

/** Map an NpcSpec.persona onto the social-bot relay's `initialize` params. */
export function initParams(spec: NpcSpec, language: string): Record<string, unknown> {
  const p = spec.persona ?? {};
  const archetype = p.archetypeHint && p.archetypeHint !== "any" ? p.archetypeHint : undefined;
  const gender = p.genderHint === "male" || p.genderHint === "female" ? p.genderHint : undefined;
  return {
    archetype,
    gender,
    difficulty: DIFFICULTY_NUM[p.difficulty ?? "gentle"] ?? 0.2,
    language,
    interestHints: p.interestHints,
    scenario: p.scenario,
    targetSkills: p.targetSkills,
  };
}
