// server/services/guided-setup/student-setup-state.ts
//
// Read/write the GUIDED SETUP record on `institute_students.data.onboarding`.
// No migration: `data` is an existing jsonb column.
//
// Only SKIPS, ACKNOWLEDGEMENTS and DISMISSALS live here. Completion is derived
// from the real rows (student-setup-queries.ts), so the flow is resumable from
// any device and cannot drift.
//
// Every write MERGES into the existing `data` object — other keys on that jsonb
// belong to other features and must survive.

import { and, eq } from "drizzle-orm";

import { db } from "../../db.js";
import { instituteStudents } from "@shared/schema";
import {
  GUIDED_SETUP_RECORD_KEY,
  GUIDED_SETUP_SKIPPABLE_STEPS,
  type GuidedSetupRecord,
  type GuidedSetupSkippableStep,
} from "@shared/guided-setup";

type DataObject = Record<string, unknown>;

function coerceRecord(value: unknown): GuidedSetupRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<GuidedSetupRecord>;
  if (!raw.startedAt || !raw.startedByUserId) return null;
  return {
    v: 1,
    source: raw.source ?? "chat",
    startedAt: raw.startedAt,
    startedByUserId: raw.startedByUserId,
    // Read off the shared step order, never re-typed. This filter used to
    // spell the three skippable ids out, so when the flow grew CONTACTS the
    // skip was WRITTEN and then silently dropped on the way back in: the view
    // returned by the skip call said "done" (it was built from the in-memory
    // record) and the very next turn reopened the step.
    skipped: Array.isArray(raw.skipped)
      ? (raw.skipped.filter((s): s is GuidedSetupSkippableStep =>
          GUIDED_SETUP_SKIPPABLE_STEPS.includes(s as GuidedSetupSkippableStep),
        ) as GuidedSetupSkippableStep[])
      : [],
    ...(raw.aacReviewedAt ? { aacReviewedAt: raw.aacReviewedAt } : {}),
    ...(raw.notAacUser ? { notAacUser: true as const } : {}),
    ...(raw.completedAt ? { completedAt: raw.completedAt } : {}),
    ...(raw.dismissedAt ? { dismissedAt: raw.dismissedAt } : {}),
    ...(raw.rosterBatchId ? { rosterBatchId: raw.rosterBatchId } : {}),
  };
}

async function loadLink(
  studentId: string,
  instituteId: string,
): Promise<{ id: string; data: DataObject } | null> {
  const [row] = await db
    .select({ id: instituteStudents.id, data: instituteStudents.data })
    .from(instituteStudents)
    .where(
      and(
        eq(instituteStudents.instituteId, instituteId),
        eq(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true),
      ),
    );
  if (!row) return null;
  const data =
    row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? ({ ...(row.data as DataObject) } as DataObject)
      : ({} as DataObject);
  return { id: row.id, data };
}

/** The record for (institute, student), or null when the student never entered the flow. */
export async function readRecord(
  studentId: string,
  instituteId: string,
): Promise<GuidedSetupRecord | null> {
  const link = await loadLink(studentId, instituteId);
  if (!link) return null;
  return coerceRecord(link.data[GUIDED_SETUP_RECORD_KEY]);
}

/**
 * Write the record back, merging into the existing `data` jsonb.
 * Returns false when the student is not (actively) linked to the institute.
 */
export async function writeRecord(
  studentId: string,
  instituteId: string,
  record: GuidedSetupRecord,
): Promise<boolean> {
  const link = await loadLink(studentId, instituteId);
  if (!link) return false;
  const nextData: DataObject = { ...link.data, [GUIDED_SETUP_RECORD_KEY]: record };
  await db
    .update(instituteStudents)
    .set({ data: nextData, updatedAt: new Date() })
    .where(eq(instituteStudents.id, link.id));
  return true;
}

/** Read-modify-write. `mutate` returns the next record, or null to leave it alone. */
export async function updateRecord(
  studentId: string,
  instituteId: string,
  mutate: (current: GuidedSetupRecord | null) => GuidedSetupRecord | null,
): Promise<GuidedSetupRecord | null> {
  const current = await readRecord(studentId, instituteId);
  const next = mutate(current);
  if (!next) return current;
  const ok = await writeRecord(studentId, instituteId, next);
  return ok ? next : current;
}

export function newRecord(args: {
  userId: string;
  source?: GuidedSetupRecord["source"];
  now?: Date;
}): GuidedSetupRecord {
  return {
    v: 1,
    source: args.source ?? "chat",
    startedAt: (args.now ?? new Date()).toISOString(),
    startedByUserId: args.userId,
    skipped: [],
  };
}

/** Every student in the institute that carries a record (finished or not). */
export async function listRecords(
  instituteId: string,
): Promise<Array<{ studentId: string; record: GuidedSetupRecord }>> {
  const rows = await db
    .select({ studentId: instituteStudents.studentId, data: instituteStudents.data })
    .from(instituteStudents)
    .where(
      and(
        eq(instituteStudents.instituteId, instituteId),
        eq(instituteStudents.isActive, true),
      ),
    );
  const out: Array<{ studentId: string; record: GuidedSetupRecord }> = [];
  for (const row of rows) {
    const data =
      row.data && typeof row.data === "object" && !Array.isArray(row.data)
        ? (row.data as DataObject)
        : null;
    if (!data) continue;
    const record = coerceRecord(data[GUIDED_SETUP_RECORD_KEY]);
    if (record) out.push({ studentId: row.studentId, record });
  }
  return out;
}
