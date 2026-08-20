// server/services/venue-menus/student-allergies.ts
//
// Reading `medical_records.alerts_allergies` for the allergen filter (§3.3).
//
// A deliberately tiny module with one job. Allergies are PHI and are read here
// ONLY to decide what a student is shown; they are never logged, never sent to
// a model, and never leave the server — the filter runs server-side precisely
// so a menu request cannot become a way to learn what a child is allergic to.
//
// Only `final` records count. A draft medical record is a clinician's work in
// progress, and an allergy half-typed into a draft is not something to rely on
// — but note the direction that cuts: an EMPTY result means the filter has
// nothing to filter, so the caller must treat "no allergies found" as "no
// information", not as "safe".

import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { medicalRecords } from "@shared/schema-private";

/**
 * The student's recorded allergies, as free text lines.
 *
 * Returns [] when there is no final record, when the field is empty, or on any
 * error — see the header for why that is not the same as "safe".
 */
export async function getStudentAllergies(studentId: string): Promise<string[]> {
  try {
    const record = await db.query.medicalRecords.findFirst({
      where: and(eq(medicalRecords.studentId, studentId), eq(medicalRecords.status, "final")),
      orderBy: desc(medicalRecords.updatedAt),
    });

    const raw = record?.alertsAllergies;
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((line): line is string => typeof line === "string")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    console.error("[student-allergies] lookup failed:", (error as Error)?.message);
    return [];
  }
}
