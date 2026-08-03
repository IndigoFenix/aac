/**
 * student-packages-schema.ts
 *
 * `Student_Packages` — which content packages are attached to a student.
 *
 * Like `Student_CustomApps` (and unlike the other `Student_*` fields) this is
 * NOT stored in `students.chatMemory`: reads and writes go straight at
 * `packageAssignments`, so the AI and the AAC settings panel can never drift.
 *
 * Every write routes through `packageLinks` so `packages.linkCount` stays
 * honest — a raw insert/delete here would strand orphaned packages forever.
 *
 * See planning-docs/aac-packages-plan.md §9.1.
 */

import { packageRepository } from "../../repositories/packageRepository";
import {
  attachPackageToStudent,
  detachPackageFromStudent,
} from "../packages/packageLinks";
import { isFrozen, resolvePackagePermission } from "../packages/packageAccess";
import type { AccessCtx } from "../sharing/visibility";
import type {
  AgentMemoryFieldArrayWithDB,
  AgentMemoryFieldObjectWithDB,
  DBOperationContext,
} from "../chat/memory-types";

interface AssignmentItem {
  id: string; // packages.id
  name: string; // display name, derived on read
}

function getStudentId(ctx: DBOperationContext): string {
  const studentId = ctx.all.studentId as string | undefined;
  if (!studentId) throw new Error("no studentId in context");
  return studentId;
}

/** Build the package access context from memory context. */
function accessCtx(ctx: DBOperationContext): AccessCtx {
  const userId = ctx.all.userId as string | undefined;
  const instituteId = ctx.all.instituteId as string | undefined;
  if (userId && instituteId) return { kind: "institute", instituteId, userId };
  // No selected institute — fall back to the student principal, which is what
  // the AAC-side callers are. Attach still requires a usable package below.
  return { kind: "student", studentId: getStudentId(ctx) };
}

/**
 * Check a package can be attached, with an error that names the actual reason.
 * The model retries on the message, so a generic refusal costs a whole turn.
 */
async function assertAttachable(ctx: DBOperationContext, packageId: string): Promise<void> {
  const pkg = await packageRepository.getPackage(packageId);
  if (!pkg) {
    throw new Error(
      `No package with id "${packageId}". List Institute_Packages to see what is available.`,
    );
  }
  if (isFrozen(pkg)) {
    throw new Error(
      `Package "${pkg.name}" has been deleted. Students who already have it keep it, but it ` +
        `cannot be added to anyone new.`,
    );
  }
  const permission = await resolvePackagePermission(accessCtx(ctx), packageId);
  if (permission === "none") {
    throw new Error(
      `Package "${pkg.name}" is not available to you. It belongs to an organization you are not ` +
        `a member of, and it is not public.`,
    );
  }
}

async function readAssignments(ctx: DBOperationContext): Promise<AssignmentItem[] | undefined> {
  const studentId = ctx.all.studentId as string | undefined;
  if (!studentId) return undefined;
  const assigned = await packageRepository.listAssignedPackages(studentId);
  return assigned.map((p) => ({ id: p.id, name: p.name }));
}

async function addAssignment(
  ctx: DBOperationContext,
  value: AssignmentItem,
): Promise<AssignmentItem> {
  const studentId = getStudentId(ctx);
  const packageId = value?.id;
  if (!packageId) {
    throw new Error("Student_Packages.add requires { id: <package_id> }");
  }
  await assertAttachable(ctx, packageId);

  const ctxForOwner = accessCtx(ctx);
  await attachPackageToStudent({
    packageId,
    studentId,
    instituteId: ctxForOwner.kind === "institute" ? ctxForOwner.instituteId : null,
    assignedByUserId: (ctx.all.userId as string | undefined) ?? null,
  });

  const pkg = await packageRepository.getPackage(packageId);
  return { id: packageId, name: pkg?.name ?? packageId };
}

async function deleteAssignment(
  ctx: DBOperationContext,
  keyOrIndex: string | number,
): Promise<void> {
  const studentId = ctx.all.studentId as string | undefined;
  if (!studentId) return;

  // `key` is either the package id or an array index.
  let packageId: string | undefined;
  if (typeof keyOrIndex === "string") {
    packageId = keyOrIndex;
  } else {
    const current = (await readAssignments(ctx)) ?? [];
    packageId = current[keyOrIndex]?.id;
  }
  if (!packageId) return;

  // Detaching needs no package permission — a package that has been revoked or
  // orphaned must still be removable from a student.
  await detachPackageFromStudent(packageId, studentId);
}

async function writeAssignments(
  ctx: DBOperationContext,
  value: AssignmentItem[],
): Promise<AssignmentItem[]> {
  const studentId = getStudentId(ctx);
  const desiredIds = (value ?? []).map((v) => v.id).filter(Boolean);

  // Validate every addition BEFORE mutating, so a bad id in the list doesn't
  // leave the student half-updated.
  const existing = new Set(await packageRepository.listAssignedPackageIds(studentId));
  for (const id of desiredIds) {
    if (!existing.has(id)) await assertAttachable(ctx, id);
  }

  const desired = new Set(desiredIds);
  for (const id of existing) {
    if (!desired.has(id)) await detachPackageFromStudent(id, studentId);
  }
  for (const id of desired) {
    if (!existing.has(id)) await addAssignment(ctx, { id, name: "" });
  }

  return (await readAssignments(ctx)) ?? [];
}

async function clearAssignments(ctx: DBOperationContext): Promise<void> {
  const studentId = ctx.all.studentId as string | undefined;
  if (!studentId) return;
  for (const id of await packageRepository.listAssignedPackageIds(studentId)) {
    await detachPackageFromStudent(id, studentId);
  }
}

export const STUDENT_PACKAGES_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Student_Packages",
  type: "array",
  title: "Attached Content Packages",
  description:
    "Content packages attached to this {{STUDENT}}. Attaching a package exposes its auto-loading " +
    "boards to the AAC assistant during sessions, and puts all of its boards in the {{STUDENT}}'s " +
    "board picker. To attach one, call manageMemory with an `add` op on this path providing " +
    "`{ id: <package_id> }` — the package must be one your organization owns, one shared with you, " +
    "or a public one (see Institute_Packages). To detach, call `delete` with the package id or the " +
    "array index. The `name` field is read-only and filled in automatically.",
  opened: false,
  items: {
    id: "Assignment",
    type: "object",
    properties: {
      id: {
        id: "id",
        type: "string",
        title: "Package ID",
        description: "The packages.id of the attached package",
      },
      name: { id: "name", type: "string", title: "Name", description: "Display name (read-only)" },
    },
    required: ["id"],
  } as AgentMemoryFieldObjectWithDB,
  db: {
    // `id` on add references an existing package row, not a generated primary
    // key — so it must NOT be stripped.
    clientProvidesId: true,
    read: readAssignments,
    write: writeAssignments,
    add: addAssignment,
    delete: deleteAssignment,
    clear: clearAssignments,
  },
};
