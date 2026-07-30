// Cached AAC session-plan sections (see server/services/dual-agent/session-plan.ts).
// One row per student: identity + goals hold a single PlanGroupEntry each;
// situations holds an LRU-capped array of entries (one per weekday/day-part/
// schedule slot). All three columns are registered log-tier sensitive in the
// external-storage registry, so reads hydrate and writes extract like the
// other PHI-derived jsonb columns.

import { aacSessionPlans } from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";
import {
  hydrateRecords,
  extractSensitiveFields,
  persistExtracted,
  type EntityRef,
} from "../external-storage";
import {
  type PlanGroupEntry,
  MAX_SITUATION_ENTRIES,
} from "../services/dual-agent/session-plan";

export interface AacSessionPlanRow {
  id: string;
  studentId: string;
  identity: PlanGroupEntry | null;
  situations: PlanGroupEntry[];
  goals: PlanGroupEntry | null;
}

export interface AacSessionPlanPatch {
  identity?: PlanGroupEntry;
  /** Appended to the situations list; an existing entry with the same hash is
   *  replaced in place. Oldest entries are evicted beyond MAX_SITUATION_ENTRIES. */
  situationsEntry?: PlanGroupEntry;
  goals?: PlanGroupEntry;
}

export class AacSessionPlanRepository {
  private ref(studentId: string): EntityRef {
    return { type: "student", id: studentId };
  }

  async getByStudentId(studentId: string): Promise<AacSessionPlanRow | undefined> {
    const [row] = await db
      .select()
      .from(aacSessionPlans)
      .where(eq(aacSessionPlans.studentId, studentId));
    if (!row) return undefined;
    const [hydrated] = await hydrateRecords("aac_session_plans", [row], this.ref(studentId));
    return {
      id: hydrated.id,
      studentId: hydrated.studentId,
      identity: (hydrated.identity as PlanGroupEntry | null) ?? null,
      situations: Array.isArray(hydrated.situations) ? (hydrated.situations as PlanGroupEntry[]) : [],
      goals: (hydrated.goals as PlanGroupEntry | null) ?? null,
    };
  }

  /**
   * Merge `patch` over the student's current plan row (creating it if absent).
   * Merging happens in memory over the HYDRATED row so external-storage
   * deployments don't lose the situations list on partial updates.
   */
  async upsert(studentId: string, patch: AacSessionPlanPatch): Promise<void> {
    const existing = await this.getByStudentId(studentId);

    let situations = existing?.situations ?? [];
    if (patch.situationsEntry) {
      situations = [
        ...situations.filter((e) => e.hash !== patch.situationsEntry!.hash),
        patch.situationsEntry,
      ];
      if (situations.length > MAX_SITUATION_ENTRIES) {
        situations = [...situations]
          .sort((a, b) => b.generatedAt - a.generatedAt)
          .slice(0, MAX_SITUATION_ENTRIES);
      }
    }

    const values = {
      studentId,
      identity: patch.identity ?? existing?.identity ?? null,
      situations,
      goals: patch.goals ?? existing?.goals ?? null,
      updatedAt: new Date(),
    };

    const [written] = await db
      .insert(aacSessionPlans)
      .values(values)
      .onConflictDoUpdate({
        target: aacSessionPlans.studentId,
        set: {
          identity: values.identity,
          situations: values.situations,
          goals: values.goals,
          updatedAt: values.updatedAt,
        },
      })
      .returning();

    const ref = this.ref(studentId);
    const ext = await extractSensitiveFields(
      "aac_session_plans",
      written.id,
      written as Record<string, unknown>,
      ref,
    );
    if (ext.isExternal) {
      const nullSet: Record<string, null> = {};
      for (const key of ext.externalWrites.keys()) {
        const field = key.split("/").pop()!;
        nullSet[field] = null;
      }
      await db.update(aacSessionPlans).set(nullSet).where(eq(aacSessionPlans.id, written.id));
      await persistExtracted(ref, ext.externalWrites);
    }
  }
}

export const aacSessionPlanRepository = new AacSessionPlanRepository();
