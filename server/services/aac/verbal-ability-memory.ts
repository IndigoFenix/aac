// server/services/aac/verbal-ability-memory.ts
//
// Where the student's structured VERBAL ABILITY lives, who may move it, and the
// one rule that must hold when it moves.
//
// The attribution trust gate (agent-coordinator.applyAttributionTrustGate) is
// deterministic: it reads ONE enum and overrules the Observer, which is prone
// to attributing overheard speech to a nonverbal child no matter what its
// prompt says. Until 2026-09-14 that enum was a hand-set column on the student
// row (`students.verbal_ability`) — a clinical capability fact living outside
// the record, going stale, and edited only when someone remembered the panel.
//
// Now the value is `Student_CommunicationStyle.VerbalAbility` in the student's
// chat memory, next to AccessMethod, and it is maintained by the AI:
//   • seeded at session start — from the legacy column if set (verbatim copy),
//     else from the Monitor's identity plan call, which derives it from the
//     communication profile, the report digest and the caretaker prompts;
//   • revised by the Monitor mid-session, by the clinician assistant in chat,
//     or by guided setup — all through the memory schema, so it is logged.
//
// THE RULE: a RAISE (toward more speech) must never be justified by speech
// transcripts attributed to the student. Those transcripts are exactly what
// the gate distrusts; using them as evidence would reopen the "bank" incident
// (planning-docs/aac-transcript-attribution-trust.md) with one more step. So a
// raise that lands in the same Monitor round as a demoted transcript is
// refused and reverted (`decideVerbalAbilitySync`). Lowering is always applied.
//
// The column stays readable as a fallback for one release, then goes.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { students } from "@shared/schema";
import { isVerbalAbility, VERBAL_ABILITIES, type VerbalAbility } from "@shared/aac/verbal-ability";
import { getConsentStatus } from "../consent/consentGate";

export const VERBAL_ABILITY_FIELD = "Student_CommunicationStyle";
export const VERBAL_ABILITY_KEY = "VerbalAbility";
export const VERBAL_ABILITY_SOURCE_KEY = "VerbalAbilitySource";
export const VERBAL_ABILITY_UPDATED_KEY = "VerbalAbilityUpdatedAt";

/** Who last set the value. `seed` = copied from the legacy column; `plan` =
 *  derived by the Monitor's identity plan call at session start. */
export const VERBAL_ABILITY_SOURCES = ["clinician", "monitor", "setup", "seed", "plan"] as const;
export type VerbalAbilitySource = (typeof VERBAL_ABILITY_SOURCES)[number];

export interface VerbalAbilityReading {
  value: VerbalAbility | null;
  /** `memory` = the chat-memory field; `column` = the legacy students column. */
  from: "memory" | "column" | null;
  source?: VerbalAbilitySource | string | null;
}

type StudentLike = {
  chatMemory?: unknown;
  verbalAbility?: unknown;
} | null | undefined;

/** Memory wins; the legacy column is the fallback. Unknown strings read as unset. */
export function readVerbalAbility(student: StudentLike): VerbalAbilityReading {
  const style = (student?.chatMemory as Record<string, any> | undefined)?.[VERBAL_ABILITY_FIELD];
  const mem = style?.[VERBAL_ABILITY_KEY];
  if (isVerbalAbility(mem)) {
    return { value: mem, from: "memory", source: style?.[VERBAL_ABILITY_SOURCE_KEY] ?? null };
  }
  const col = student?.verbalAbility;
  if (isVerbalAbility(col)) return { value: col, from: "column", source: "clinician" };
  return { value: null, from: null };
}

/** Rank on the speech axis: higher = more speech. Unset is below everything
 *  for the purpose of "is this a raise" — setting a value where there was none
 *  is treated as a raise only when it lands above `none`... see decide(). */
export function verbalAbilityRank(v: VerbalAbility | null | undefined): number {
  if (!isVerbalAbility(v)) return -1;
  return VERBAL_ABILITIES.indexOf(v);
}

/** True when `next` allows more speech than `prev`. Unset → anything except
 *  `none` counts as a raise (the gate goes from "no gating" to gating, but a
 *  fluent verdict written from heard speech is the very thing to refuse). */
export function isVerbalAbilityRaise(prev: VerbalAbility | null, next: VerbalAbility): boolean {
  if (prev === null) return next !== "none";
  return verbalAbilityRank(next) > verbalAbilityRank(prev);
}

export type VerbalAbilitySyncDecision = "noop" | "apply" | "refuse_raise";

/**
 * The pure rule the coordinator applies after every Monitor round.
 *  - nothing changed → noop
 *  - a lower value (or an unset → `none`) → apply
 *  - a raise → apply, UNLESS a transcript was demoted at or after the round
 *    began (`lastDemotionAt >= roundStartedAt`) → refuse_raise
 */
export function decideVerbalAbilitySync(opts: {
  current: VerbalAbility | null;
  next: VerbalAbility | null;
  lastDemotionAt: number | null;
  roundStartedAt: number;
}): VerbalAbilitySyncDecision {
  const { current, next, lastDemotionAt, roundStartedAt } = opts;
  if (next === current) return "noop";
  if (next === null) return "apply"; // cleared — the gate simply stops
  if (!isVerbalAbilityRaise(current, next)) return "apply";
  if (lastDemotionAt !== null && lastDemotionAt >= roundStartedAt) return "refuse_raise";
  return "apply";
}

/** Parse the identity plan call's `verbal_ability` section: one token, or
 *  `unspecified`/anything else → null. Tolerates trailing prose. */
export function parsePlannedVerbalAbility(section: string | undefined | null): VerbalAbility | null {
  if (!section) return null;
  const token = section.trim().toLowerCase().split(/[\s,.;:]+/)[0]?.replace(/[^a-z_]/g, "");
  return isVerbalAbility(token) ? token : null;
}

// ──────────────────────────────────────────────────────────────────
// Persistence (students.chat_memory)
// ──────────────────────────────────────────────────────────────────

export interface VerbalAbilityWriteDeps {
  readMemory: (studentId: string) => Promise<Record<string, any> | null>;
  writeMemory: (studentId: string, memory: Record<string, any>) => Promise<void>;
  /** Whether Student_* PHI writes are allowed for this child right now. */
  writesAllowed: (studentId: string) => Promise<boolean>;
}

export function defaultVerbalAbilityWriteDeps(): VerbalAbilityWriteDeps {
  return {
    readMemory: async (studentId) => {
      const [row] = await db.select({ chatMemory: students.chatMemory }).from(students).where(eq(students.id, studentId));
      return (row?.chatMemory as Record<string, any> | null) ?? null;
    },
    writeMemory: async (studentId, memory) => {
      await db.update(students).set({ chatMemory: memory, updatedAt: new Date() }).where(eq(students.id, studentId));
    },
    writesAllowed: async (studentId) => (await getConsentStatus(studentId)).writesAllowed,
  };
}

/**
 * Set (or clear, with null) the structured verbal ability in chat memory.
 * Merges into the existing Student_CommunicationStyle object so AccessMethod
 * and friends survive. Consent-gated like every Student_* write. Returns the
 * memory as written, or null when the write was refused/skipped.
 */
export async function writeVerbalAbility(
  studentId: string,
  value: VerbalAbility | null,
  source: VerbalAbilitySource,
  deps: VerbalAbilityWriteDeps = defaultVerbalAbilityWriteDeps(),
): Promise<Record<string, any> | null> {
  if (!(await deps.writesAllowed(studentId))) {
    console.warn(`[verbal-ability] write refused for ${studentId}: student PHI writes not allowed (consent)`);
    return null;
  }
  const memory = { ...((await deps.readMemory(studentId)) ?? {}) };
  const style = { ...((memory[VERBAL_ABILITY_FIELD] as Record<string, any> | undefined) ?? {}) };
  if (value === null) {
    delete style[VERBAL_ABILITY_KEY];
    delete style[VERBAL_ABILITY_SOURCE_KEY];
    delete style[VERBAL_ABILITY_UPDATED_KEY];
  } else {
    style[VERBAL_ABILITY_KEY] = value;
    style[VERBAL_ABILITY_SOURCE_KEY] = source;
    style[VERBAL_ABILITY_UPDATED_KEY] = new Date().toISOString();
  }
  memory[VERBAL_ABILITY_FIELD] = style;
  await deps.writeMemory(studentId, memory);
  return memory;
}
