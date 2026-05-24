/**
 * Admin Users Controller
 *
 * CRUD for the `admin_users` table — the backoffice's own user list. Gated
 * to admins who hold the `admins` section permission (or the `"*"` wildcard).
 */

import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { adminUserRepository } from "../repositories/adminUserRepository";
import { ensureAdminShellUser } from "../services/adminAuthService";
import { sanitizeAdminPermissions } from "@shared/admin-sections";

function formatAdmin(row: any) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    profileImageUrl: row.profileImageUrl,
    role: row.role,
    permissions: row.permissions ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class AdminUsersController {
  async list(_req: Request, res: Response): Promise<void> {
    try {
      const admins = await adminUserRepository.list();
      res.json({ success: true, admins: admins.map(formatAdmin) });
    } catch (error: any) {
      console.error("List admins error:", error);
      res.status(500).json({ success: false, message: "Failed to list admins" });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    try {
      const { email, firstName, lastName, permissions } = req.body ?? {};
      if (typeof email !== "string" || !email.includes("@")) {
        res.status(400).json({ success: false, message: "A valid email is required" });
        return;
      }
      const normalizedEmail = email.trim().toLowerCase();
      const existing = await adminUserRepository.getByEmail(normalizedEmail);
      if (existing) {
        res.status(409).json({ success: false, message: "An admin with this email already exists" });
        return;
      }
      const sanitized = sanitizeAdminPermissions(permissions);
      const created = await adminUserRepository.create({
        id: randomUUID(),
        email: normalizedEmail,
        firstName: typeof firstName === "string" ? firstName : null,
        lastName: typeof lastName === "string" ? lastName : null,
        permissions: sanitized.length === 0 ? ["*"] : sanitized,
      } as any);

      // Anchor a shell users row for FK refs / support mode. Idempotent.
      await ensureAdminShellUser(created);

      const actor = req.user as any;
      console.log(`[Admins] ${actor?.email ?? "(unknown)"} created admin ${created.email}`);

      res.json({ success: true, admin: formatAdmin(created) });
    } catch (error: any) {
      console.error("Create admin error:", error);
      res.status(500).json({ success: false, message: "Failed to create admin" });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const existing = await adminUserRepository.getById(id);
      if (!existing) {
        res.status(404).json({ success: false, message: "Admin not found" });
        return;
      }
      const updates: Record<string, unknown> = {};
      if (typeof req.body?.firstName === "string") updates.firstName = req.body.firstName;
      if (typeof req.body?.lastName === "string") updates.lastName = req.body.lastName;
      if (typeof req.body?.email === "string") updates.email = req.body.email.trim().toLowerCase();
      if (req.body?.permissions !== undefined) {
        const sanitized = sanitizeAdminPermissions(req.body.permissions);
        updates.permissions = sanitized.length === 0 ? [] : sanitized;
      }

      const updated = await adminUserRepository.update(id, updates as any);

      const actor = req.user as any;
      console.log(`[Admins] ${actor?.email ?? "(unknown)"} updated admin ${id} (${Object.keys(updates).join(", ")})`);

      res.json({ success: true, admin: formatAdmin(updated) });
    } catch (error: any) {
      console.error("Update admin error:", error);
      res.status(500).json({ success: false, message: "Failed to update admin" });
    }
  }

  async remove(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const actor = req.user as any;
      if (actor?.id === id) {
        res.status(400).json({
          success: false,
          message: "You cannot delete your own admin account",
        });
        return;
      }
      const existing = await adminUserRepository.getById(id);
      if (!existing) {
        res.status(404).json({ success: false, message: "Admin not found" });
        return;
      }
      await adminUserRepository.delete(id);

      console.log(`[Admins] ${actor?.email ?? "(unknown)"} deleted admin ${existing.email} (${id})`);

      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete admin error:", error);
      res.status(500).json({ success: false, message: "Failed to delete admin" });
    }
  }
}

export const adminUsersController = new AdminUsersController();
