// server/repositories/licenseRepository.ts
// Repository for license management operations

import {
  licenses,
  institutes,
  users,
  type License,
  type InsertLicense,
  type UpdateLicense,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc } from "drizzle-orm";

export class LicenseRepository {
  async createLicense(data: InsertLicense): Promise<License> {
    const [license] = await db
      .insert(licenses)
      .values(data)
      .returning();
    return license;
  }

  async getLicenseById(id: string): Promise<License | undefined> {
    const [license] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.id, id));
    return license || undefined;
  }

  async getAllLicenses(): Promise<(License & {
    userName?: string | null;
    userEmail?: string | null;
    instituteName?: string | null;
  })[]> {
    const results = await db
      .select({
        license: licenses,
        userName: users.firstName,
        userEmail: users.email,
        instituteName: institutes.name,
      })
      .from(licenses)
      .leftJoin(users, eq(licenses.userId, users.id))
      .leftJoin(institutes, eq(licenses.instituteId, institutes.id))
      .orderBy(desc(licenses.createdAt));

    return results.map((r) => ({
      ...r.license,
      userName: r.userName,
      userEmail: r.userEmail,
      instituteName: r.instituteName,
    }));
  }

  async getLicensesByInstituteId(instituteId: string): Promise<License[]> {
    return db
      .select()
      .from(licenses)
      .where(eq(licenses.instituteId, instituteId))
      .orderBy(desc(licenses.createdAt));
  }

  async getLicenseByUserId(userId: string): Promise<License | undefined> {
    const [license] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.userId, userId));
    return license || undefined;
  }

  async getLicenseByInviteEmail(email: string): Promise<License | undefined> {
    const [license] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.inviteEmail, email));
    return license || undefined;
  }

  async updateLicense(id: string, updates: UpdateLicense): Promise<License | undefined> {
    const [license] = await db
      .update(licenses)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(licenses.id, id))
      .returning();
    return license || undefined;
  }

  async getLicenseByInviteToken(token: string): Promise<License | undefined> {
    const [license] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.inviteToken, token));
    return license || undefined;
  }

  async deleteLicense(id: string): Promise<boolean> {
    const [result] = await db
      .delete(licenses)
      .where(eq(licenses.id, id))
      .returning({ id: licenses.id });
    return !!result;
  }
}

export const licenseRepository = new LicenseRepository();
