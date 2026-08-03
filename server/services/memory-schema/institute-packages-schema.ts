/**
 * institute-packages-schema.ts
 *
 * `Institute_Packages` — the Clinician AI's rail for authoring content packages.
 *
 * Reads and writes go straight at the packages tables (never `chatMemory`), so
 * the AI and the clinician package-manager UI can never drift apart.
 *
 * What the AI may NOT do here, by construction:
 *   - publish. `visibility` is read-only as a field; flipping a package public
 *     changes its legal status and needs a human attestation (plan §9.3).
 *   - touch a frozen (orphaned) package — there is no owner left to authorise it.
 *   - write lifecycle state: approvalStatus, linkCount, publish*, deletedAt.
 *
 * See planning-docs/aac-packages-plan.md §9.2.
 */

import { and, eq, inArray } from "drizzle-orm";
import { boards, instituteUsers, packages, users } from "@shared/schema";
import { db } from "../../db";
import { packageRepository } from "../../repositories/packageRepository";
import {
  isFrozen,
  resolvePackagePermission,
} from "../packages/packageAccess";
import { addPackageGrant, deletePackage, removePackageGrant } from "../packages/packageLinks";
import { validateBoardForPackage, describePackageFindings } from "@shared/package-validation";
import {
  checkPackageForVisibility,
  type PublishCheckFinding,
} from "../packages/packageContent";
import type {
  AgentMemoryFieldMapWithDB,
  AgentMemoryFieldObjectWithDB,
  DBOperationContext,
  ListResult,
  MemoryDBOperations,
} from "../chat/memory-types";

function getUserId(ctx: DBOperationContext): string {
  const userId = ctx.all.userId;
  if (!userId) throw new Error("userId required in context");
  return userId;
}

/** The AccessCtx the package resolver expects, built from memory context. */
function accessCtxFor(ctx: DBOperationContext, instituteId: string) {
  return { kind: "institute" as const, instituteId, userId: getUserId(ctx) };
}

/**
 * Resolve edit rights, with error text that names the actual reason. The model
 * retries on the message, so "forbidden" alone costs a turn.
 */
async function requireEdit(ctx: DBOperationContext, packageId: string) {
  const pkg = await packageRepository.getPackage(packageId);
  if (!pkg) throw new Error(`No package with id "${packageId}".`);
  if (isFrozen(pkg)) {
    throw new Error(
      `Package "${pkg.name}" has been deleted and is now read-only. It is kept only because ` +
        `students or colleagues still link to it, and it cannot be edited or re-shared.`,
    );
  }
  const permission = await resolvePackagePermission(
    accessCtxFor(ctx, pkg.instituteId!),
    packageId,
  );
  if (permission !== "edit") {
    throw new Error(
      `You have "${permission}" access to package "${pkg.name}", not "edit". Ask an admin of the ` +
        `owning organization for edit access, or edit a package you own.`,
    );
  }
  return pkg;
}

/** Shape the AI sees. Read-only fields are marked in the schema descriptions. */
async function toMemoryValue(pkg: typeof packages.$inferSelect) {
  const [boardEntries, grants] = await Promise.all([
    packageRepository.listBoards(pkg.id),
    packageRepository.listGrants(pkg.id),
  ]);
  return {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description ?? undefined,
    language: pkg.language ?? undefined,
    instituteId: pkg.instituteId ?? undefined,
    defaultMemberPermission: pkg.defaultMemberPermission,
    visibility: pkg.visibility,
    approvalStatus: pkg.approvalStatus,
    frozen: isFrozen(pkg),
    linkCount: pkg.linkCount,
    boards: boardEntries.map((b) => ({ boardId: b.id, name: b.name, autoLoad: b.autoLoad })),
    grants: grants.map((g) => ({
      userId: g.granteeUserId,
      email: g.granteeEmail ?? undefined,
      permission: g.permission,
    })),
    // Advisory only. The AI can PREPARE a package and tell the user whether it
    // would pass, but publishing needs a person — see §9.3.
    publishBlockers: describePublishBlockers(
      await checkPackageForVisibility(pkg.id, "public"),
    ),
  };
}

/** Turn publish-check findings into short lines the AI can relay to a human. */
function describePublishBlockers(findings: PublishCheckFinding[]): string[] {
  return findings.map((f) => {
    const where = f.buttonId ? `button "${f.buttonId}"` : "the board";
    switch (f.reason) {
      case "student_face_ref":
        return `"${f.boardName}": ${where} shows someone from a student's contacts.`;
      case "person_image_in_public":
        return `"${f.boardName}": ${where} uses a photo of a real person, which cannot be public.`;
      case "dangling_board_link":
        return `"${f.boardName}": ${where} links to a board outside this package.`;
    }
  });
}

/** Add/remove memberships so the package's boards match `desired`. */
async function syncBoards(
  ctx: DBOperationContext,
  pkg: typeof packages.$inferSelect,
  desired: Array<{ boardId: string; autoLoad?: boolean }>,
): Promise<void> {
  const userId = getUserId(ctx);
  const current = await packageRepository.listBoards(pkg.id);
  const currentIds = new Set(current.map((b) => b.id));
  const desiredIds = new Set(desired.map((d) => d.boardId).filter(Boolean));

  for (const existing of current) {
    if (!desiredIds.has(existing.id)) {
      await packageRepository.removeBoard(pkg.id, existing.id);
    }
  }

  for (const entry of desired) {
    if (!entry.boardId) continue;

    if (currentIds.has(entry.boardId)) {
      if (entry.autoLoad !== undefined) {
        await packageRepository.updateMembership(pkg.id, entry.boardId, {
          autoLoad: entry.autoLoad,
        });
      }
      continue;
    }

    const [board] = await db.select().from(boards).where(eq(boards.id, entry.boardId));
    if (!board) throw new Error(`No board with id "${entry.boardId}".`);

    // The AI never gets the copy path: duplicating a student's board is a
    // judgement call about that student's data, so it stays a human action in
    // the package manager UI.
    if (board.scope !== "package" && board.studentId !== null) {
      throw new Error(
        `Board "${board.name}" belongs to a student, so it cannot be added to a package directly. ` +
          `A person must copy it into the package from the package manager first.`,
      );
    }

    const siblings = new Set(await packageRepository.listBoardIds(pkg.id));
    siblings.add(board.id);
    const validation = validateBoardForPackage(board.irData, {
      visibility: pkg.visibility as "institute" | "public",
      siblingBoardIds: siblings,
    });
    if (!validation.ok) {
      throw new Error(
        `Board "${board.name}" cannot go in this package: ${describePackageFindings(validation.findings)}.`,
      );
    }

    if (board.scope !== "package") {
      const promoted = await packageRepository.promoteBoardToPackageScope(
        board.id,
        pkg.instituteId!,
      );
      if (!promoted) throw new Error(`Board "${board.name}" could not be moved into the package.`);
    } else if (board.instituteId !== pkg.instituteId) {
      throw new Error(`Board "${board.name}" belongs to a different organization.`);
    }

    await packageRepository.addBoard({
      packageId: pkg.id,
      boardId: board.id,
      autoLoad: entry.autoLoad ?? true,
      addedByUserId: userId,
    });
  }
}

/** Add/revoke grants so the package's grants match `desired`. */
async function syncGrants(
  ctx: DBOperationContext,
  pkg: typeof packages.$inferSelect,
  desired: Array<{ userId: string; permission?: "use" | "edit" }>,
): Promise<void> {
  const grantedBy = getUserId(ctx);
  const current = await packageRepository.listGrants(pkg.id);
  const desiredByUser = new Map(desired.filter((d) => d.userId).map((d) => [d.userId, d]));

  for (const existing of current) {
    if (!desiredByUser.has(existing.granteeUserId)) {
      await removePackageGrant(pkg.id, existing.granteeUserId);
    }
  }

  if (desiredByUser.size > 0) {
    // V1: grants are intra-institute only.
    const memberRows = await db
      .select({ userId: instituteUsers.userId })
      .from(instituteUsers)
      .where(
        and(
          eq(instituteUsers.instituteId, pkg.instituteId!),
          eq(instituteUsers.isActive, true),
          inArray(instituteUsers.userId, Array.from(desiredByUser.keys())),
        ),
      );
    const members = new Set(memberRows.map((m) => m.userId));

    for (const [userId, entry] of desiredByUser) {
      if (!members.has(userId)) {
        throw new Error(
          `User "${userId}" is not a member of the organization that owns this package. ` +
            `Packages can only be shared with colleagues in the owning organization, or made public.`,
        );
      }
      await addPackageGrant({
        packageId: pkg.id,
        granteeUserId: userId,
        permission: entry.permission ?? "use",
        grantedByUserId: grantedBy,
      });
    }
  }
}

const packageOps: MemoryDBOperations<any> = {
  list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
    const userId = getUserId(ctx);
    const selected = ctx.all.instituteId as string | undefined;

    const instituteIds = selected
      ? [selected]
      : (
          await db
            .select({ instituteId: instituteUsers.instituteId })
            .from(instituteUsers)
            .where(and(eq(instituteUsers.userId, userId), eq(instituteUsers.isActive, true)))
        ).map((r) => r.instituteId);

    const rows: Array<typeof packages.$inferSelect> = [];
    for (const instituteId of instituteIds) {
      rows.push(...(await packageRepository.listByInstitute(instituteId)));
    }

    const paged = rows.slice(offset, offset + limit);
    return {
      items: await Promise.all(paged.map(toMemoryValue)),
      total: rows.length,
      keys: paged.map((p) => p.id),
    };
  },

  get: async (ctx, key) => {
    const pkg = await packageRepository.getPackage(String(key));
    if (!pkg?.instituteId) return undefined;
    const permission = await resolvePackagePermission(
      accessCtxFor(ctx, pkg.instituteId),
      pkg.id,
    );
    return permission === "none" ? undefined : toMemoryValue(pkg);
  },

  add: async (ctx, value) => {
    const userId = getUserId(ctx);
    const instituteId = value.instituteId ?? (ctx.all.instituteId as string | undefined);
    if (!instituteId) {
      throw new Error(
        "instituteId is required — use the currently selected organization or pick one from Context_Institutes.",
      );
    }
    if (!value.name) throw new Error("A package needs a name.");

    const [membership] = await db
      .select({ userId: instituteUsers.userId })
      .from(instituteUsers)
      .where(
        and(
          eq(instituteUsers.instituteId, instituteId),
          eq(instituteUsers.userId, userId),
          eq(instituteUsers.isActive, true),
        ),
      );
    if (!membership) {
      throw new Error("You can only create packages in an organization you belong to.");
    }

    const created = await packageRepository.createPackage({
      instituteId,
      name: value.name,
      description: value.description ?? null,
      language: value.language ?? "en",
      defaultMemberPermission: value.defaultMemberPermission ?? "use",
      createdByUserId: userId,
    });

    if (Array.isArray(value.boards) && value.boards.length) {
      await syncBoards(ctx, created, value.boards);
    }
    if (Array.isArray(value.grants) && value.grants.length) {
      await syncGrants(ctx, created, value.grants);
    }

    return toMemoryValue((await packageRepository.getPackage(created.id))!);
  },

  update: async (ctx, key, value) => {
    const pkg = await requireEdit(ctx, String(key));

    if (value.visibility !== undefined && value.visibility !== pkg.visibility) {
      throw new Error(
        `Publishing is not something you can do. Making a package public requires a person to ` +
          `confirm it contains no images of identifiable people, in the package manager.`,
      );
    }

    const updates: Record<string, unknown> = {};
    if (value.name !== undefined) updates.name = value.name;
    if (value.description !== undefined) updates.description = value.description;
    if (value.language !== undefined) updates.language = value.language;
    if (value.defaultMemberPermission !== undefined) {
      updates.defaultMemberPermission = value.defaultMemberPermission;
    }
    if (Object.keys(updates).length) {
      await packageRepository.updatePackage(pkg.id, updates);
    }

    if (Array.isArray(value.boards)) await syncBoards(ctx, pkg, value.boards);
    if (Array.isArray(value.grants)) await syncGrants(ctx, pkg, value.grants);

    return toMemoryValue((await packageRepository.getPackage(pkg.id))!);
  },

  delete: async (ctx, key) => {
    const pkg = await requireEdit(ctx, String(key));
    await deletePackage(pkg.id);
  },
};

const packageSchema: AgentMemoryFieldObjectWithDB = {
  id: "package",
  type: "object",
  properties: {
    id: { id: "id", type: "string", title: "Package ID", description: "Read-only." },
    name: { id: "name", type: "string", title: "Name" },
    description: { id: "description", type: "string", title: "Description" },
    language: { id: "language", type: "string", title: "Language", description: "ISO code, e.g. 'en'." },
    instituteId: {
      id: "instituteId",
      type: "string",
      title: "Owning organization",
      description: "Set on creation only; ownership cannot be transferred here.",
    },
    defaultMemberPermission: {
      id: "defaultMemberPermission",
      type: "string",
      title: "Default member access",
      enum: ["none", "use", "edit"],
      description:
        "What a plain member of the owning organization gets without an explicit grant. Default 'use'.",
    },
    visibility: {
      id: "visibility",
      type: "string",
      title: "Visibility",
      enum: ["institute", "public"],
      description:
        "READ-ONLY. 'institute' = the owning organization only; 'public' = anyone. Making a package " +
        "public requires a person to confirm it in the package manager — you cannot set this.",
    },
    approvalStatus: {
      id: "approvalStatus",
      type: "string",
      title: "Public review status",
      description: "READ-ONLY. Only meaningful once a package is public.",
    },
    frozen: {
      id: "frozen",
      type: "boolean",
      title: "Deleted / read-only",
      description:
        "READ-ONLY. True when the package was deleted but is kept alive because students or " +
        "colleagues still link to it. Frozen packages cannot be edited.",
    },
    linkCount: {
      id: "linkCount",
      type: "number",
      title: "Links",
      description: "READ-ONLY. How many students and colleagues currently link to this package.",
    },
    publishBlockers: {
      id: "publishBlockers",
      type: "array",
      title: "What would block publishing",
      description:
        "READ-ONLY. Reasons this package could not be made public right now — usually a board " +
        "showing a real person. An empty list means it would pass the automated check. You can " +
        "report this to the user and help them fix the boards, but only a PERSON can publish: " +
        "they must confirm in the package manager that the package contains no images of " +
        "identifiable people.",
      items: { id: "blocker", type: "string" },
    },
    boards: {
      id: "boards",
      type: "array",
      title: "Boards",
      description:
        "The boards in this package. Write the WHOLE list to change membership — boards you omit " +
        "are removed from the package (the boards themselves are not deleted). Each entry is " +
        "{ boardId, autoLoad }. autoLoad=true means the AAC's AI may load it automatically during a " +
        "session; autoLoad=false keeps it in the student's board picker but hides it from the AI. " +
        "A board that belongs to a student cannot be added — a person must copy it in first.",
      items: {
        id: "packageBoard",
        type: "object",
        properties: {
          boardId: { id: "boardId", type: "string", title: "Board ID" },
          name: { id: "name", type: "string", title: "Name", description: "Read-only." },
          autoLoad: { id: "autoLoad", type: "boolean", title: "Auto-load", default: true },
        },
        required: ["boardId"],
      } as AgentMemoryFieldObjectWithDB,
    },
    grants: {
      id: "grants",
      type: "array",
      title: "Shared with",
      description:
        "Colleagues in the owning organization who have been given access. Write the WHOLE list to " +
        "change it. Each entry is { userId, permission } where permission is 'use' or 'edit'. " +
        "An 'edit' grant is effectively co-ownership. Only members of the owning organization can " +
        "be granted access.",
      items: {
        id: "packageGrant",
        type: "object",
        properties: {
          userId: { id: "userId", type: "string", title: "User ID" },
          email: { id: "email", type: "string", title: "Email", description: "Read-only." },
          permission: {
            id: "permission",
            type: "string",
            title: "Permission",
            enum: ["use", "edit"],
          },
        },
        required: ["userId"],
      } as AgentMemoryFieldObjectWithDB,
    },
  },
  required: ["name"],
};

export const INSTITUTE_PACKAGES_FIELD: AgentMemoryFieldMapWithDB = {
  id: "Institute_Packages",
  type: "map",
  title: "Content Packages",
  description:
    "Reusable bundles of AAC boards owned by an organization. A package is attached to a student " +
    "from their AAC settings (see Student_Packages), which exposes its auto-loading boards to the " +
    "AAC's AI. Create a package, add boards to it, and share it with colleagues here. " +
    "Making a package PUBLIC is not something you can do — it needs a person to confirm it.",
  opened: false,
  displayKey: "name",
  values: packageSchema,
  db: packageOps,
};
