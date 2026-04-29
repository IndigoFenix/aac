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
import { parseLocalOrIsoInTimezone } from "../../lib/timezone";
import { canWriteObject, type AccessCtx } from "../sharing/visibility";
import { requireConsentForMemoryWrite } from "../consent/consentGate";

function toMemoryValue(record: Incident): any {
  const { ...rest } = record;
  return rest;
}

/**
 * Cross-institute write authorization. Institute principals must own the
 * incident OR hold a permission='write' share covering it. Mirrors
 * `requireOwningInstitute` in reportController. Student/admin principals always
 * pass; orphan rows (institute_id null) belong to the student-only set, which
 * the visibility helper treats as same-institute.
 */
async function rejectCrossInstituteWrite(
  ctx: { all: Record<string, any> },
  incident: { id: string; instituteId: string | null; studentId: string },
) {
  const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
  // Fail-closed: a missing accessCtx is now a programming error after the
  // controller-side membership check + sessionService accessCtx plumbing
  // were added. Refuse rather than silently allow writes.
  if (!accessCtx) {
    throw new Error("Cannot modify an incident without a resolved access context");
  }
  if (accessCtx.kind !== "institute") return;
  const allowed = await canWriteObject(
    accessCtx,
    "incident",
    incident.id,
    incident.studentId,
    incident.instituteId,
  );
  if (!allowed) {
    throw new Error("Cannot modify an incident owned by another institute");
  }
}

const incidentOps: MemoryDBOperations<Incident> = {
  list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
    const studentId = ctx.all.studentId as string | undefined;
    const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
    if (!studentId) return { items: [], total: 0, keys: [] };
    // Fail-closed — incidentRepository.listByStudent fall-through with no
    // accessCtx returns rows from every institute that recorded an incident
    // for this student.
    if (!accessCtx) return { items: [], total: 0, keys: [] };

    const items = await incidentRepository.listByStudent(studentId, { offset, limit }, accessCtx);
    // Total count for pagination — repo doesn't return total separately, so we
    // re-query without limit. Cheap for typical incident volumes.
    const all = await incidentRepository.listByStudent(studentId, {}, accessCtx);

    return {
      items: items.map(toMemoryValue),
      total: all.length,
      keys: items.map((i) => i.id),
    };
  },

  get: async (ctx, key) => {
    const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
    // Fail-closed — see list above.
    if (!accessCtx) return undefined;
    const row = await incidentRepository.getById(String(key), accessCtx);
    return row ? toMemoryValue(row) : undefined;
  },

  add: async (ctx, value) => {
    const studentId = ctx.all.studentId as string | undefined;
    if (!studentId) throw new Error("studentId required to record an incident");
    await requireConsentForMemoryWrite(ctx);
    const tz = ctx.all.timezone as string | undefined;
    const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
    // Institute principals attribute new incidents to their own institute.
    // Student principal (AAC) leaves institute_id null — orphan, standing-share-eligible.
    const instituteId =
      accessCtx?.kind === "institute" ? accessCtx.instituteId : null;

    const created = await incidentRepository.create({
      studentId,
      instituteId,
      type: value.type,
      severity: value.severity,
      recordedAt: parseLocalOrIsoInTimezone(value.recordedAt, tz) ?? new Date(),
      context: value.context ?? null,
      collectedBy: value.collectedBy ?? null,
    });
    return toMemoryValue(created);
  },

  update: async (ctx, key, value) => {
    await requireConsentForMemoryWrite(ctx);
    const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
    // Load the existing row through the visibility gate so an institute
    // principal can't update an incident they shouldn't even be able to read.
    const existing = await incidentRepository.getById(String(key), accessCtx);
    if (!existing) throw new Error("Incident not found");
    await rejectCrossInstituteWrite(ctx, existing);

    const tz = ctx.all.timezone as string | undefined;
    const updates: Record<string, any> = {};
    if (value.type !== undefined) updates.type = value.type;
    if (value.severity !== undefined) updates.severity = value.severity;
    if (value.recordedAt !== undefined) updates.recordedAt = parseLocalOrIsoInTimezone(value.recordedAt, tz);
    if (value.context !== undefined) updates.context = value.context;
    if (value.collectedBy !== undefined) updates.collectedBy = value.collectedBy;

    const row = await incidentRepository.update(String(key), updates as any);
    if (!row) throw new Error("Incident not found");
    return toMemoryValue(row);
  },

  delete: async (ctx, key) => {
    await requireConsentForMemoryWrite(ctx);
    const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
    const existing = await incidentRepository.getById(String(key), accessCtx);
    if (!existing) throw new Error("Incident not found");
    await rejectCrossInstituteWrite(ctx, existing);

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
      description: "When the incident occurred. Provide the wall-clock local time as ISO 8601 WITHOUT a timezone suffix (e.g. \"2026-04-23T15:00:00\" for 3:00 PM local). The server interprets this in the user's local time zone (see User Local Time section) and stores UTC. Defaults to the current moment if omitted.",
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
