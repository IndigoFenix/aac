import { adminUsers, type AdminUser, type UpsertAdminUser } from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";

class AdminUserRepository {
  async getById(id: string): Promise<AdminUser | undefined> {
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, id));
    return row;
  }

  async getByEmail(email: string): Promise<AdminUser | undefined> {
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.email, email));
    return row;
  }

  async list(): Promise<AdminUser[]> {
    return db.select().from(adminUsers);
  }

  async create(data: UpsertAdminUser): Promise<AdminUser> {
    const [row] = await db.insert(adminUsers).values(data).returning();
    return row;
  }

  async update(id: string, data: Partial<UpsertAdminUser>): Promise<AdminUser | undefined> {
    const [row] = await db
      .update(adminUsers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(adminUsers.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await db.delete(adminUsers).where(eq(adminUsers.id, id));
  }
}

export const adminUserRepository = new AdminUserRepository();
