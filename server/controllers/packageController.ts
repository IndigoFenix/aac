/**
 * packageController.ts
 *
 * Content packages: CRUD, membership, grants.
 *
 * Every write resolves permission through `packageAccess` and refuses frozen
 * (orphaned) packages. Assignment to students is P3; publish/moderation is P5.
 *
 * See planning-docs/aac-packages-plan.md §5.4.
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { boardRepository, packageRepository } from "../repositories";
import { activityLogService } from "../services/activityLogService";
import { buildClinicianCtx } from "../services/sharing/clinicianCtx";
import {
  isFrozen,
  resolvePackagePermission,
} from "../services/packages/packageAccess";
import {
  addPackageGrant,
  attachPackageToStudent,
  deletePackage,
  detachPackageFromStudent,
  removePackageGrant,
} from "../services/packages/packageLinks";
import { studentService } from "../services/studentService";
import { describePackageFindings } from "@shared/package-validation";
import {
  checkBoardForPackage,
  checkPackageForVisibility,
} from "../services/packages/packageContent";
import type { AccessCtx } from "../services/sharing/visibility";
import { instituteService } from "../services/instituteService";

const createSchema = z.object({
  instituteId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  language: z.string().optional(),
  type: z.string().optional(),
  defaultMemberPermission: z.enum(["none", "use", "edit"]).optional(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    imageUrl: z.string().nullable().optional(),
    language: z.string().optional(),
    defaultMemberPermission: z.enum(["none", "use", "edit"]).optional(),
  })
  .strict();

const addBoardSchema = z.object({
  boardId: z.string().min(1),
  autoLoad: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  /**
   * Required to add a board that belongs to a student: it makes a COPY rather
   * than sharing the student's own board. Forcing the caller to ask for it
   * keeps "share this design" from silently becoming "share this student's
   * board" — see §3 class C.
   */
  copyStudentBoard: z.boolean().optional(),
});

const updateMembershipSchema = z
  .object({
    autoLoad: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

const grantSchema = z.object({
  granteeUserId: z.string().min(1),
  permission: z.enum(["use", "edit"]),
});

const assignSchema = z.object({
  studentId: z.string().min(1),
});

const publishSchema = z.object({
  attestation: z.object({ noPersonImages: z.literal(true) }),
});

/**
 * May this principal act on this student?
 *
 * Routes through the existing `verifyStudentAccess` rather than a second
 * notion of "manages" — a direct `userStudents` link passes regardless of the
 * selected institute, which is what lets a clinician with a personal caseload
 * work while another institute is selected.
 */
async function canAccessStudent(ctx: AccessCtx, studentId: string): Promise<boolean> {
  if (ctx.kind === "admin") return true;
  if (ctx.kind === "student") return ctx.studentId === studentId;
  const { hasAccess } = await studentService.verifyStudentAccess(
    studentId,
    ctx.userId,
    ctx.instituteId,
  );
  return hasAccess;
}

/** Resolve the caller's access context, or 400 if no institute is selected. */
async function requireCtx(req: Request, res: Response): Promise<AccessCtx | null> {
  const ctx = await buildClinicianCtx(req);
  if (!ctx) {
    res.status(400).json({ error: "error:INSTITUTE_NOT_SELECTED" });
    return null;
  }
  return ctx;
}

/**
 * Load a package and check the caller may act on it.
 * `need: 'edit'` additionally refuses orphans — they are frozen.
 */
async function loadPackageFor(
  req: Request,
  res: Response,
  packageId: string,
  need: "use" | "edit",
) {
  const ctx = await requireCtx(req, res);
  if (!ctx) return null;

  const pkg = await packageRepository.getPackage(packageId);
  if (!pkg) {
    res.status(404).json({ error: "error:PACKAGE_NOT_FOUND" });
    return null;
  }
  if (need === "edit" && isFrozen(pkg)) {
    res.status(409).json({ error: "error:PACKAGE_ORPHANED" });
    return null;
  }
  const permission = await resolvePackagePermission(ctx, packageId);
  if (permission === "none" || (need === "edit" && permission !== "edit")) {
    // 404 rather than 403 on a pure read miss so we don't confirm existence.
    res.status(need === "edit" ? 403 : 404).json({
      error: need === "edit" ? "error:PACKAGE_FORBIDDEN" : "error:PACKAGE_NOT_FOUND",
    });
    return null;
  }
  return { ctx, pkg, permission };
}

export class PackageController {
  /** POST /api/packages */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const body = createSchema.parse(req.body);
      const userId = req.user!.id;

      const { isMember } = await instituteService.verifyMembership(body.instituteId, userId);
      if (!isMember) {
        res.status(403).json({ error: "error:NOT_INSTITUTE_MEMBER" });
        return;
      }

      const pkg = await packageRepository.createPackage({
        instituteId: body.instituteId,
        name: body.name,
        description: body.description ?? null,
        imageUrl: body.imageUrl ?? null,
        language: body.language ?? "en",
        type: body.type ?? "board",
        defaultMemberPermission: body.defaultMemberPermission ?? "use",
        createdByUserId: userId,
      });

      res.status(201).json(pkg);
      activityLogService.log({
        userId,
        instituteId: body.instituteId,
        eventType: "create",
        subjectType1: "package",
        subjectId1: pkg.id,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /**
   * GET /api/packages?scope=mine|usable
   *  - `mine`   (default) packages owned by the selected institute
   *  - `usable` everything the caller may attach: own ∪ granted ∪ approved-public
   */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const ctx = await requireCtx(req, res);
      if (!ctx) return;

      const scope = req.query.scope === "usable" ? "usable" : "mine";
      const rows =
        scope === "usable"
          ? await packageRepository.listUsable(ctx)
          : ctx.kind === "institute"
            ? await packageRepository.listByInstitute(ctx.instituteId)
            : [];
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** GET /api/packages/:id — package + boards + grants, with the caller's permission. */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "use");
      if (!loaded) return;
      const [boardEntries, grants] = await Promise.all([
        packageRepository.listBoards(loaded.pkg.id),
        loaded.permission === "edit"
          ? packageRepository.listGrants(loaded.pkg.id)
          : Promise.resolve([]),
      ]);
      res.json({
        ...loaded.pkg,
        permission: loaded.permission,
        frozen: isFrozen(loaded.pkg),
        boards: boardEntries,
        grants,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** PATCH /api/packages/:id */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;

      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "error:INVALID_BODY", details: parsed.error.errors });
        return;
      }
      const updates: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed.data)) {
        if (v !== undefined) updates[k] = v;
      }

      const updated = await packageRepository.updatePackage(loaded.pkg.id, updates);
      res.json(updated);

      activityLogService.log({
        userId: req.user!.id,
        instituteId: loaded.pkg.instituteId,
        eventType: "update",
        subjectType1: "package",
        subjectId1: loaded.pkg.id,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /**
   * DELETE /api/packages/:id
   * Orphans rather than removes while anything still links to it, so a delete
   * never yanks a package out from under an attached student.
   */
  async remove(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;

      const outcome = await deletePackage(loaded.pkg.id);
      res.json({ outcome });

      activityLogService.log({
        userId: req.user!.id,
        instituteId: loaded.pkg.instituteId,
        eventType: "delete",
        subjectType1: "package",
        subjectId1: loaded.pkg.id,
        details: { outcome },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** GET /api/packages/:id/boards */
  async listBoards(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "use");
      if (!loaded) return;
      res.json(await packageRepository.listBoards(loaded.pkg.id));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/packages/:id/boards
   *
   * Three routes in, depending on what the board already is:
   *   already package-scoped in this institute → link it
   *   student-scope with NO student            → promote in place
   *   student-scope WITH a student             → copy (requires copyStudentBoard)
   */
  async addBoard(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;
      const body = addBoardSchema.parse(req.body);
      const userId = req.user!.id;
      const instituteId = loaded.pkg.instituteId!;

      const source = await boardRepository.getBoard(body.boardId);
      if (!source) {
        res.status(404).json({ error: "error:BOARD_NOT_FOUND" });
        return;
      }

      // Content gate. Class C (student faces) is refused at every visibility;
      // class B (person imagery) only when the package is public.
      const siblingIds = new Set(await packageRepository.listBoardIds(loaded.pkg.id));
      siblingIds.add(source.id);
      const findings = await checkBoardForPackage(
        source,
        loaded.pkg.visibility as "institute" | "public",
        siblingIds,
      );
      if (findings.length > 0) {
        res.status(409).json({
          error: "error:PACKAGE_BOARD_REJECTED",
          findings,
          message: describePackageFindings(findings),
        });
        return;
      }

      let boardId = source.id;
      let copied = false;

      if (source.scope === "package") {
        if (source.instituteId !== instituteId) {
          res.status(403).json({ error: "error:BOARD_OTHER_INSTITUTE" });
          return;
        }
      } else if (source.studentId === null) {
        if (source.userId !== userId) {
          res.status(403).json({ error: "error:BOARD_NOT_YOURS" });
          return;
        }
        const promoted = await packageRepository.promoteBoardToPackageScope(source.id, instituteId);
        if (!promoted) {
          res.status(409).json({ error: "error:BOARD_NOT_PROMOTABLE" });
          return;
        }
      } else {
        // Student-linked: never share the original — copy, and only on request.
        if (!body.copyStudentBoard) {
          res.status(409).json({ error: "error:BOARD_BELONGS_TO_STUDENT" });
          return;
        }
        if (source.userId !== userId) {
          res.status(403).json({ error: "error:BOARD_NOT_YOURS" });
          return;
        }
        const copy = await packageRepository.copyBoardIntoPackageScope(source, instituteId, userId);
        boardId = copy.id;
        copied = true;
      }

      const membership = await packageRepository.addBoard({
        packageId: loaded.pkg.id,
        boardId,
        autoLoad: body.autoLoad ?? true,
        sortOrder: body.sortOrder ?? 0,
        addedByUserId: userId,
      });

      res.status(201).json({ membership, boardId, copied });
      activityLogService.log({
        userId,
        instituteId,
        eventType: "update",
        subjectType1: "package",
        subjectId1: loaded.pkg.id,
        subjectType2: "board",
        subjectId2: boardId,
        details: { action: "add_board", copied },
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /** PATCH /api/packages/:id/boards/:boardId — autoLoad / sortOrder. */
  async updateBoard(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;
      const parsed = updateMembershipSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "error:INVALID_BODY", details: parsed.error.errors });
        return;
      }
      const updated = await packageRepository.updateMembership(
        loaded.pkg.id,
        req.params.boardId,
        parsed.data,
      );
      if (!updated) {
        res.status(404).json({ error: "error:PACKAGE_BOARD_NOT_FOUND" });
        return;
      }
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /** DELETE /api/packages/:id/boards/:boardId — removes membership, keeps the board. */
  async removeBoard(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;
      const removed = await packageRepository.removeBoard(loaded.pkg.id, req.params.boardId);
      if (!removed) {
        res.status(404).json({ error: "error:PACKAGE_BOARD_NOT_FOUND" });
        return;
      }
      res.status(204).send();
      activityLogService.log({
        userId: req.user!.id,
        instituteId: loaded.pkg.instituteId,
        eventType: "update",
        subjectType1: "package",
        subjectId1: loaded.pkg.id,
        subjectType2: "board",
        subjectId2: req.params.boardId,
        details: { action: "remove_board" },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** GET /api/packages/:id/grants */
  async listGrants(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;
      res.json(await packageRepository.listGrants(loaded.pkg.id));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** POST /api/packages/:id/grants */
  async addGrant(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;
      const body = grantSchema.parse(req.body);

      // V1: grants are intra-institute only. Cross-institute sharing is a
      // separate feature (plan §1.2) and must not sneak in through this door.
      const { isMember } = await instituteService.verifyMembership(
        loaded.pkg.instituteId!,
        body.granteeUserId,
      );
      if (!isMember) {
        res.status(400).json({ error: "error:GRANTEE_NOT_INSTITUTE_MEMBER" });
        return;
      }

      await addPackageGrant({
        packageId: loaded.pkg.id,
        granteeUserId: body.granteeUserId,
        permission: body.permission,
        grantedByUserId: req.user!.id,
      });

      res.status(201).json(await packageRepository.listGrants(loaded.pkg.id));
      activityLogService.log({
        userId: req.user!.id,
        instituteId: loaded.pkg.instituteId,
        eventType: "update",
        subjectType1: "package",
        subjectId1: loaded.pkg.id,
        details: { action: "grant", granteeUserId: body.granteeUserId, permission: body.permission },
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /** DELETE /api/packages/:id/grants/:grantId */
  async removeGrant(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;
      const grant = await packageRepository.getGrantById(req.params.grantId);
      if (!grant || grant.packageId !== loaded.pkg.id) {
        res.status(404).json({ error: "error:PACKAGE_GRANT_NOT_FOUND" });
        return;
      }
      await removePackageGrant(loaded.pkg.id, grant.granteeUserId);
      res.status(204).send();
      activityLogService.log({
        userId: req.user!.id,
        instituteId: loaded.pkg.instituteId,
        eventType: "update",
        subjectType1: "package",
        subjectId1: loaded.pkg.id,
        details: { action: "revoke", granteeUserId: grant.granteeUserId },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ------------------------------------------------------------------
  // Publishing
  // ------------------------------------------------------------------

  /**
   * GET /api/packages/:id/publish-check
   * Dry run: what would block this package from going public?
   * Read-only, so `use` access is enough — the AI reads it to advise.
   */
  async publishCheck(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "use");
      if (!loaded) return;
      const findings = await checkPackageForVisibility(loaded.pkg.id, "public");
      res.json({ ok: findings.length === 0, findings });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/packages/:id/publish  { attestation: { noPersonImages: true } }
   *
   * Flipping institute → public is the moment the content changes legal status,
   * so this is deliberately NOT reachable as a field write, and NOT reachable by
   * the AI. A named human confirms that the package holds no images of
   * identifiable people; that confirmation is stored and audited.
   *
   * Going public does not make it visible yet — it enters the admin review
   * queue as `pending`.
   */
  async publish(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;

      const body = publishSchema.parse(req.body);
      if (!body.attestation?.noPersonImages) {
        res.status(400).json({ error: "error:ATTESTATION_REQUIRED" });
        return;
      }

      // Re-validate EVERY board at the target visibility. Per-add validation ran
      // against the OLD visibility, so it cannot stand in for this.
      const findings = await checkPackageForVisibility(loaded.pkg.id, "public");
      if (findings.length > 0) {
        res.status(409).json({ error: "error:PACKAGE_BOARD_REJECTED", findings });
        return;
      }

      const attestation = {
        noPersonImages: true,
        at: new Date().toISOString(),
        byUserId: req.user!.id,
      };
      const updated = await packageRepository.updatePackage(loaded.pkg.id, {
        visibility: "public",
        approvalStatus: "pending",
        publishedAt: new Date(),
        publishedByUserId: req.user!.id,
        publishAttestation: attestation,
      });

      res.json(updated);
      activityLogService.log({
        userId: req.user!.id,
        instituteId: loaded.pkg.instituteId,
        eventType: "package_published",
        subjectType1: "package",
        subjectId1: loaded.pkg.id,
        details: { attestation, boardCount: (await packageRepository.listBoardIds(loaded.pkg.id)).length },
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /** POST /api/packages/:id/unpublish — back to institute-only. */
  async unpublish(req: Request, res: Response): Promise<void> {
    try {
      const loaded = await loadPackageFor(req, res, req.params.id, "edit");
      if (!loaded) return;

      const updated = await packageRepository.updatePackage(loaded.pkg.id, {
        visibility: "institute",
        approvalStatus: "none",
        publishedAt: null,
        publishedByUserId: null,
        publishAttestation: null,
      });

      res.json(updated);
      activityLogService.log({
        userId: req.user!.id,
        instituteId: loaded.pkg.instituteId,
        eventType: "package_unpublished",
        subjectType1: "package",
        subjectId1: loaded.pkg.id,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/packages/search?q=&language=
   * Public discovery. Approved public packages only — never institute-scoped
   * ones, and never anything still awaiting review.
   */
  async search(req: Request, res: Response): Promise<void> {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : undefined;
      const language = typeof req.query.language === "string" ? req.query.language : undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      res.json(await packageRepository.searchPublicPackages({ q, language, limit }));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ------------------------------------------------------------------
  // Admin moderation
  // ------------------------------------------------------------------

  /** GET /api/admin/packages/pending */
  async listPending(_req: Request, res: Response): Promise<void> {
    try {
      res.json(await packageRepository.listPendingApproval());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** POST /api/admin/packages/:id/approve */
  async approve(req: Request, res: Response): Promise<void> {
    try {
      const pkg = await packageRepository.getPackage(req.params.id);
      if (!pkg) {
        res.status(404).json({ error: "error:PACKAGE_NOT_FOUND" });
        return;
      }
      // The reviewer sees the content as it is NOW, so re-check rather than
      // trusting the publish-time pass — boards may have changed since.
      const findings = await checkPackageForVisibility(pkg.id, "public");
      if (findings.length > 0) {
        res.status(409).json({ error: "error:PACKAGE_BOARD_REJECTED", findings });
        return;
      }

      res.json(await packageRepository.updatePackage(pkg.id, { approvalStatus: "approved" }));
      activityLogService.log({
        userId: req.user!.id,
        instituteId: pkg.instituteId,
        eventType: "package_approved",
        subjectType1: "package",
        subjectId1: pkg.id,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** POST /api/admin/packages/:id/reject  { reason } */
  async reject(req: Request, res: Response): Promise<void> {
    try {
      const pkg = await packageRepository.getPackage(req.params.id);
      if (!pkg) {
        res.status(404).json({ error: "error:PACKAGE_NOT_FOUND" });
        return;
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason : null;

      // Rejection returns it to institute-only: a package sitting "public but
      // rejected" would be a confusing half-state, and it is not visible to
      // anyone outside the institute either way.
      res.json(
        await packageRepository.updatePackage(pkg.id, {
          approvalStatus: "rejected",
          visibility: "institute",
        }),
      );
      activityLogService.log({
        userId: req.user!.id,
        instituteId: pkg.instituteId,
        eventType: "package_rejected",
        subjectType1: "package",
        subjectId1: pkg.id,
        details: { reason },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ------------------------------------------------------------------
  // Student assignments
  // ------------------------------------------------------------------

  /**
   * GET /api/packages/student/:studentId/available
   * Packages this caller could attach, plus the ids already attached.
   */
  async availableForStudent(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const ctx = await buildClinicianCtx(req, studentId);
      if (!ctx) {
        res.status(400).json({ error: "error:INSTITUTE_NOT_SELECTED" });
        return;
      }
      res.json(await packageRepository.getAvailablePackagesForStudent(studentId, ctx));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/packages/:id/assignments  { studentId }
   *
   * Two gates, both required: the caller must be able to USE the package, and
   * must have access to the student. Frozen packages refuse new attachments —
   * an orphan can be kept and detached, never newly taken up.
   */
  async assignToStudent(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = assignSchema.parse(req.body);
      const ctx = await buildClinicianCtx(req, studentId);
      if (!ctx) {
        res.status(400).json({ error: "error:INSTITUTE_NOT_SELECTED" });
        return;
      }

      const pkg = await packageRepository.getPackage(req.params.id);
      if (!pkg) {
        res.status(404).json({ error: "error:PACKAGE_NOT_FOUND" });
        return;
      }
      if (isFrozen(pkg)) {
        res.status(409).json({ error: "error:PACKAGE_ORPHANED" });
        return;
      }
      if ((await resolvePackagePermission(ctx, pkg.id)) === "none") {
        res.status(404).json({ error: "error:PACKAGE_NOT_FOUND" });
        return;
      }
      if (!(await canAccessStudent(ctx, studentId))) {
        res.status(403).json({ error: "error:STUDENT_FORBIDDEN" });
        return;
      }

      await attachPackageToStudent({
        packageId: pkg.id,
        studentId,
        // Owner of the ASSIGNMENT row (not the package) — this is the
        // cross-institute visibility key, and the gap in the customApps path.
        instituteId: ctx.kind === "institute" ? ctx.instituteId : null,
        assignedByUserId: req.user!.id,
      });

      res.status(201).json({ packageId: pkg.id, studentId });
      activityLogService.log({
        userId: req.user!.id,
        instituteId: ctx.kind === "institute" ? ctx.instituteId : null,
        eventType: "create",
        subjectType1: "package_assignment",
        subjectId1: pkg.id,
        subjectType2: "student",
        subjectId2: studentId,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  /**
   * DELETE /api/packages/:id/assignments/:studentId
   *
   * Detaching only needs student access — NOT package permission. Someone must
   * always be able to take a package off a student they look after, including
   * an orphan or one shared by a colleague whose grant has since gone.
   */
  async unassignFromStudent(req: Request, res: Response): Promise<void> {
    try {
      const { studentId } = req.params;
      const ctx = await buildClinicianCtx(req, studentId);
      if (!ctx) {
        res.status(400).json({ error: "error:INSTITUTE_NOT_SELECTED" });
        return;
      }
      if (!(await canAccessStudent(ctx, studentId))) {
        res.status(403).json({ error: "error:STUDENT_FORBIDDEN" });
        return;
      }

      await detachPackageFromStudent(req.params.id, studentId);
      res.status(204).send();

      activityLogService.log({
        userId: req.user!.id,
        instituteId: ctx.kind === "institute" ? ctx.instituteId : null,
        eventType: "delete",
        subjectType1: "package_assignment",
        subjectId1: req.params.id,
        subjectType2: "student",
        subjectId2: studentId,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/packages/board-candidates?instituteId=
   * Boards the caller could add: their own student-scope boards plus the
   * institute's existing package boards. Metadata only.
   */
  async boardCandidates(req: Request, res: Response): Promise<void> {
    try {
      const ctx = await requireCtx(req, res);
      if (!ctx || ctx.kind !== "institute") {
        res.json({ own: [], institute: [] });
        return;
      }
      const [own, institute] = await Promise.all([
        packageRepository.listPromotableBoards(req.user!.id),
        packageRepository.listInstitutePackageBoards(ctx.instituteId),
      ]);
      res.json({ own, institute });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /** GET /api/boards/:id/packages — which packages contain this board (editor badge). */
  async packagesForBoard(req: Request, res: Response): Promise<void> {
    try {
      const ctx = await requireCtx(req, res);
      if (!ctx) return;
      const all = await packageRepository.listPackagesForBoard(req.params.id);
      const visible = [];
      for (const pkg of all) {
        if ((await resolvePackagePermission(ctx, pkg.id)) !== "none") visible.push(pkg);
      }
      res.json(visible);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

export const packageController = new PackageController();
