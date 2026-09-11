/**
 * consent-gate-persist-path.test.ts
 *
 * Pins the SECOND half of the student-memory consent gate — the one in
 * `sessionService.onUpdateMemoryValues`.
 *
 * Why this test looks the way it does: the `Student_*` / `Relationship_*`
 * memory-schema `db` ops do NOT write to the database. They validate and return
 * the value; the row write happens once, at the end of the turn, in
 * `onUpdateMemoryValues`. And `memory-db-bridge.processMemoryToolWithDB` runs
 * the in-memory processor for EVERY op regardless of whether that op's DB
 * function threw — a failed op is reported to the model (`ok: false`) but its
 * value is never rolled back out of `memoryValues`. So a gate only at the schema
 * layer would tell the AI "refused" and then persist the row anyway, and
 * `Student_CommunicationProfile` — column-backed — has no other writer at all.
 *
 * `onUpdateMemoryValues` is a closure created inside `getMessageManager`; there
 * is no seam to call it from a test without standing up a whole message manager
 * and an LLM. This suite therefore pins its SHAPE: each of the three writes must
 * sit behind `mayPersistStudentPhi`, which is the single place `getConsentStatus`
 * is consulted on this path. If someone deletes a guard, this goes red.
 *
 * DB-free on purpose — it belongs to the `test:unit` tier.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SESSION_SERVICE = resolve(here, '../services/sessionService.ts');

/** The body of `onUpdateMemoryValues`, from its declaration to the next
 *  top-level callback declared after it. */
function onUpdateMemoryValuesBody(): string {
  const src = readFileSync(SESSION_SERVICE, 'utf8');
  const start = src.indexOf('const onUpdateMemoryValues = async');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('const enrichCorePrompt', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/**
 * The three writes this path performs, each named by a fragment unique to it.
 * A guard counts only if it is the nearest thing before the write — 600
 * characters is roughly the enclosing `if`, so a guard further away than that
 * is guarding something else.
 */
const GUARDED_WRITES: Array<[string, string]> = [
  ['students.communication_profile column', 'set({ communicationProfile'],
  ['students.chat_memory blob', 'await updateStudentMemory('],
  ['user_students.chat_memory blob', 'await updateUserStudentMemory('],
];

const GUARD = 'mayPersistStudentPhi';

describe('consent gate — the persist path in sessionService.onUpdateMemoryValues', () => {
  it('defines the guard, and consults getConsentStatus (not a second gate)', () => {
    const body = onUpdateMemoryValuesBody();
    expect(body).toContain(`const ${GUARD} = async (studentId: string)`);
    // The gate flag and the legacy grace window are the HELPER's business —
    // this path must not re-implement either.
    expect(body).toContain('getConsentStatus(studentId)');
    expect(body).toContain('.writesAllowed');
    expect(body).not.toMatch(/CONSENT_GATE_ENABLED/);
    expect(body).not.toMatch(/legacyConsentDeadline/);
  });

  for (const [label, marker] of GUARDED_WRITES) {
    it(`guards the ${label} write`, () => {
      const body = onUpdateMemoryValuesBody();
      const at = body.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const preceding = body.slice(0, at);
      const guardAt = preceding.lastIndexOf(`await ${GUARD}(`);
      expect(guardAt).toBeGreaterThan(-1);
      expect(at - guardAt).toBeLessThan(600);
    });
  }

  it('drops the blocked write rather than throwing mid-persist', () => {
    // Throwing here would abort the persistence that follows (relationship
    // memory, the guided-setup refresh) for a write we only need to drop —
    // and the AI has already been told no by the schema-layer refusal.
    const body = onUpdateMemoryValuesBody();
    expect(body).not.toMatch(/throw new ConsentGateError/);
    expect(body).toMatch(/console\.warn\([\s\S]{0,200}consent gate/);
  });
});
