/**
 * incident-memory-schema.ts
 *
 * Memory field for student incidents — lightweight medical/functional events
 * tied to a student but not to any program or goal. Backed by the dedicated
 * `incidents` table (not chatMemory).
 *
 * AI access: read/write through the standard manageMemory tool, e.g.
 *   manageMemory { ops: [{ action: "view", path: "/Student_Incidents", page: { offset: 0, limit: 20 } }] }
 *   manageMemory { ops: [{ action: "add", path: "/Student_Incidents", key: "<uuid>", value: { type: "medical", severity: "high", recordedAt: "...", context: "..." } }] }
 */

import { incidentRepository } from "../../repositories";
import type {
  AgentMemoryFieldMapWithDB,
  AgentMemoryFieldObjectWithDB,
  MemoryDBOperations,
  ListResult,
} from "../chat/memory-types";
import type { Incident } from "@shared/schema";

function toMemoryValue(record: Incident): any {
  const { ...rest } = record;
  return rest;
}

const incidentOps: MemoryDBOperations<Incident> = {
  list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
    const studentId = ctx.all.studentId as string | undefined;
    if (!studentId) return { items: [], total: 0, keys: [] };

    const items = await incidentRepository.listByStudent(studentId, { offset, limit });
    // Total count for pagination — repo doesn't return total separately, so we
    // re-query without limit. Cheap for typical incident volumes.
    const all = await incidentRepository.listByStudent(studentId);

    return {
      items: items.map(toMemoryValue),
      total: all.length,
      keys: items.map((i) => i.id),
    };
  },

  get: async (_ctx, key) => {
    const row = await incidentRepository.getById(String(key));
    return row ? toMemoryValue(row) : undefined;
  },

  add: async (ctx, value) => {
    const studentId = ctx.all.studentId as string | undefined;
    if (!studentId) throw new Error("studentId required to record an incident");

    const created = await incidentRepository.create({
      studentId,
      type: value.type,
      severity: value.severity,
      recordedAt: value.recordedAt ? new Date(value.recordedAt) : new Date(),
      context: value.context ?? null,
      collectedBy: value.collectedBy ?? null,
    });
    return toMemoryValue(created);
  },

  update: async (_ctx, key, value) => {
    const updates: Record<string, any> = {};
    if (value.type !== undefined) updates.type = value.type;
    if (value.severity !== undefined) updates.severity = value.severity;
    if (value.recordedAt !== undefined) updates.recordedAt = new Date(value.recordedAt);
    if (value.context !== undefined) updates.context = value.context;
    if (value.collectedBy !== undefined) updates.collectedBy = value.collectedBy;

    const row = await incidentRepository.update(String(key), updates as any);
    if (!row) throw new Error("Incident not found");
    return toMemoryValue(row);
  },

  delete: async (_ctx, key) => {
    const ok = await incidentRepository.delete(String(key));
    if (!ok) throw new Error("Incident not found");
  },

  fromDB: (record) => toMemoryValue(record),
  getDBKey: (value) => value?.id,
};

const incidentSchema: AgentMemoryFieldObjectWithDB = {
  id: "incident",
  type: "object",
  opened: true,
  properties: {
    id: { id: "id", type: "string" },
    type: {
      id: "type",
      type: "string",
      enum: ["medical", "functional"],
      description: "Category of the incident. 'medical' = health-related (seizure, illness, injury). 'functional' = behavioral or skill-related (regression, behavior episode, breakthrough).",
    },
    severity: {
      id: "severity",
      type: "string",
      enum: ["low", "moderate", "high", "critical"],
      description: "Severity level. 'low' = minor/routine, 'moderate' = notable, 'high' = significant concern, 'critical' = emergency or major event.",
    },
    recordedAt: {
      id: "recordedAt",
      type: "string",
      format: "date-time",
      description: "When the incident occurred. Provide a UTC ISO 8601 timestamp (e.g. \"2026-04-23T20:00:00Z\"). Convert from the user's local time using their time zone (see User Local Time section). Defaults to the current moment if omitted.",
    },
    context: { id: "context", type: "string", description: "Free-text description of what happened.", opened: true },
    collectedBy: { id: "collectedBy", type: "string", description: "Name or role of the person who recorded the incident." },
  },
  required: ["type", "severity"],
};

export const STUDENT_INCIDENTS_FIELD: AgentMemoryFieldMapWithDB = {
  id: "Student_Incidents",
  type: "map",
  title: "Incidents",
  description: "Student incidents — medical or functional events recorded for clinician review. Not tied to any program or goal. Each entry is keyed by incident UUID.",
  opened: true,
  displayKey: "type",
  values: incidentSchema,
  db: incidentOps,
};
