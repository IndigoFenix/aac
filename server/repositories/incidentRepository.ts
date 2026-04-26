// server/repositories/incidentRepository.ts
// Repository for student incidents (medical/functional events).

import {
  incidents,
  type Incident,
  type InsertIncident,
  type UpdateIncident,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import {
  withIncidentVisibility,
  type AccessCtx,
} from "../services/sharing/visibility";
import {
  recordShareDerivedView,
  recordShareDerivedViewSingle,
} from "../services/sharing/audit";

export class IncidentRepository {
  async create(data: InsertIncident): Promise<Incident> {
    const [row] = await db.insert(incidents).values(data).returning();
    return row;
  }

  async getById(id: string, ctx?: AccessCtx): Promise<Incident | undefined> {
    const where = ctx
      ? and(eq(incidents.id, id), withIncidentVisibility(incidents, ctx))
      : eq(incidents.id, id);
    const [row] = await db.select().from(incidents).where(where);
    if (ctx) recordShareDerivedViewSingle(ctx, "incident", row);
    return row || undefined;
  }

  async listByStudent(
    studentId: string,
    opts: { startDate?: Date; endDate?: Date; offset?: number; limit?: number } = {},
    ctx?: AccessCtx,
  ): Promise<Incident[]> {
    const conditions = [eq(incidents.studentId, studentId)];
    if (opts.startDate) conditions.push(gte(incidents.recordedAt, opts.startDate));
    if (opts.endDate) conditions.push(lte(incidents.recordedAt, opts.endDate));
    if (ctx) conditions.push(withIncidentVisibility(incidents, ctx));

    let query = db
      .select()
      .from(incidents)
      .where(and(...conditions))
      .orderBy(desc(incidents.recordedAt));

    if (opts.limit !== undefined) query = (query as any).limit(opts.limit);
    if (opts.offset !== undefined) query = (query as any).offset(opts.offset);

    const rows = await query;
    if (ctx) recordShareDerivedView(ctx, "incident", rows);
    return rows;
  }

  async update(id: string, updates: UpdateIncident): Promise<Incident | undefined> {
    const [row] = await db
      .update(incidents)
      .set(updates)
      .where(eq(incidents.id, id))
      .returning();
    return row || undefined;
  }

  async delete(id: string): Promise<boolean> {
    const [row] = await db
      .delete(incidents)
      .where(eq(incidents.id, id))
      .returning({ id: incidents.id });
    return !!row;
  }
}

export const incidentRepository = new IncidentRepository();
