/**
 * student-custom-apps-schema.ts
 *
 * Memory field for student ↔ custom-app assignments. Unlike other Student_*
 * fields, this one is NOT stored in `students.chatMemory`. Reads and writes
 * go directly to the `customAppAssignments` join table so clinicians editing
 * assignments in the AAC settings UI and the AI editing via memory stay
 * in sync.
 */

import { db } from "../../db";
import { and, eq, inArray } from "drizzle-orm";
import { customApps, customAppAssignments, instituteStudents } from "@shared/schema";
import { customAppRepository } from "../../repositories/customAppRepository";
import type {
  AgentMemoryFieldArrayWithDB,
  AgentMemoryFieldObjectWithDB,
  DBOperationContext,
} from "../chat/memory-types";

interface AssignmentItem {
  id: string;      // custom_apps.id
  name: string;    // display name (derived on read)
}

// ---------------------------------------------------------------------------
// Institute scoping
// ---------------------------------------------------------------------------

/** Returns the set of app ids available to this student (assigned + all apps in their institutes). */
async function getAvailableAppIdsForStudent(studentId: string): Promise<Set<string>> {
  const enrollments = await db
    .select({ instituteId: instituteStudents.instituteId })
    .from(instituteStudents)
    .where(and(
      eq(instituteStudents.studentId, studentId),
      eq(instituteStudents.isActive, true),
    ));
  const instituteIds = enrollments.map((e) => e.instituteId);
  if (instituteIds.length === 0) return new Set();

  const rows = await db
    .select({ id: customApps.id })
    .from(customApps)
    .where(inArray(customApps.instituteId, instituteIds));
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

async function readAssignments(ctx: DBOperationContext): Promise<AssignmentItem[] | undefined> {
  const studentId = ctx.all.studentId as string | undefined;
  if (!studentId) return undefined;

  const assignments = await db
    .select({ appId: customAppAssignments.appId })
    .from(customAppAssignments)
    .where(eq(customAppAssignments.studentId, studentId));
  if (assignments.length === 0) return [];

  const ids = assignments.map((a) => a.appId);
  const apps = await db
    .select({ id: customApps.id, name: customApps.name })
    .from(customApps)
    .where(inArray(customApps.id, ids));
  const nameById = new Map(apps.map((a) => [a.id, a.name]));
  return ids
    .filter((id) => nameById.has(id))
    .map((id) => ({ id, name: nameById.get(id)! }));
}

async function addAssignment(
  ctx: DBOperationContext,
  value: AssignmentItem,
): Promise<AssignmentItem> {
  const studentId = ctx.all.studentId as string | undefined;
  const userId = ctx.all.userId as string | undefined;
  if (!studentId) throw new Error("no studentId in context");
  const appId = value?.id;
  if (!appId) throw new Error("Student_CustomApps.add requires { id: <app_id> }");

  const available = await getAvailableAppIdsForStudent(studentId);
  if (!available.has(appId)) {
    throw new Error(
      `Custom app "${appId}" is not in the student's institutes. Only apps associated with the student's institutes can be assigned.`,
    );
  }

  await customAppRepository.assignToStudent({
    appId,
    studentId,
    assignedByUserId: userId ?? null,
  });

  const [app] = await db
    .select({ id: customApps.id, name: customApps.name })
    .from(customApps)
    .where(eq(customApps.id, appId));
  return { id: appId, name: app?.name ?? appId };
}

async function deleteAssignment(
  ctx: DBOperationContext,
  keyOrIndex: string | number,
): Promise<void> {
  const studentId = ctx.all.studentId as string | undefined;
  if (!studentId) return;

  // `key` can be either the app_id (string) or an array index (number).
  let appId: string | undefined;
  if (typeof keyOrIndex === "string") {
    appId = keyOrIndex;
  } else {
    const current = (await readAssignments(ctx)) ?? [];
    appId = current[keyOrIndex]?.id;
  }
  if (!appId) return;

  await customAppRepository.unassignFromStudent(appId, studentId);
}

async function writeAssignments(
  ctx: DBOperationContext,
  value: AssignmentItem[],
): Promise<AssignmentItem[]> {
  const studentId = ctx.all.studentId as string | undefined;
  const userId = ctx.all.userId as string | undefined;
  if (!studentId) throw new Error("no studentId in context");

  const desiredIds = (value ?? []).map((v) => v.id).filter(Boolean);
  const available = await getAvailableAppIdsForStudent(studentId);
  const invalid = desiredIds.filter((id) => !available.has(id));
  if (invalid.length > 0) {
    throw new Error(
      `These apps are not in the student's institutes and cannot be assigned: ${invalid.join(", ")}`,
    );
  }

  const existing = await db
    .select({ appId: customAppAssignments.appId })
    .from(customAppAssignments)
    .where(eq(customAppAssignments.studentId, studentId));
  const existingSet = new Set(existing.map((e) => e.appId));
  const desiredSet = new Set(desiredIds);

  // Remove ones no longer in the set.
  for (const appId of existingSet) {
    if (!desiredSet.has(appId)) {
      await customAppRepository.unassignFromStudent(appId, studentId);
    }
  }
  // Add ones that are new.
  for (const appId of desiredSet) {
    if (!existingSet.has(appId)) {
      await customAppRepository.assignToStudent({
        appId,
        studentId,
        assignedByUserId: userId ?? null,
      });
    }
  }

  return (await readAssignments(ctx)) ?? [];
}

async function clearAssignments(ctx: DBOperationContext): Promise<void> {
  const studentId = ctx.all.studentId as string | undefined;
  if (!studentId) return;
  const existing = await db
    .select({ appId: customAppAssignments.appId })
    .from(customAppAssignments)
    .where(eq(customAppAssignments.studentId, studentId));
  for (const e of existing) {
    await customAppRepository.unassignFromStudent(e.appId, studentId);
  }
}

// ---------------------------------------------------------------------------
// Field declaration
// ---------------------------------------------------------------------------

export const STUDENT_CUSTOM_APPS_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Student_CustomApps",
  type: "array",
  title: "Assigned Custom Apps",
  description:
    "Custom apps (games) currently assigned to this student. To assign a new app, call manageMemory with an `add` op on this path, providing `{ id: <app_id> }` — the app must belong to one of the student's institutes. To remove an assignment, call `delete` with the app id or the array index. The app's `name` field is read-only and auto-populated.",
  opened: false,
  items: {
    id: "Assignment",
    type: "object",
    properties: {
      id: { id: "id", type: "string", title: "App ID", description: "The custom_apps.id of the assigned app" },
      name: { id: "name", type: "string", title: "Name", description: "Display name (read-only)" },
    },
    required: ["id"],
  } as AgentMemoryFieldObjectWithDB,
  db: {
    // `id` on add is a reference to an existing custom_apps row (the app being
    // assigned), not a generated primary key — so it must NOT be stripped.
    clientProvidesId: true,
    read: readAssignments,
    write: writeAssignments,
    add: addAssignment,
    delete: deleteAssignment,
    clear: clearAssignments,
  },
};
