// server/repositories/personRepository.ts
// Provisioning + resolution for the `persons` abstraction (the canonical human
// above users and students). Scoped to chat/call membership for now.
//
// Persons are get-or-created lazily: the first time a user/student needs to act
// as a chat member, we materialize their person row. Both facet FKs are UNIQUE,
// so concurrent creation is resolved with onConflictDoNothing + re-select.

import { persons, users, students, type Person } from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";

export class PersonRepository {
  async getById(personId: string): Promise<Person | null> {
    const [row] = await db.select().from(persons).where(eq(persons.id, personId));
    return row ?? null;
  }

  async getByUserId(userId: string): Promise<Person | null> {
    const [row] = await db.select().from(persons).where(eq(persons.userId, userId));
    return row ?? null;
  }

  async getByStudentId(studentId: string): Promise<Person | null> {
    const [row] = await db.select().from(persons).where(eq(persons.studentId, studentId));
    return row ?? null;
  }

  async getOrCreateForUser(userId: string): Promise<Person> {
    const existing = await this.getByUserId(userId);
    if (existing) return existing;
    await db.insert(persons).values({ userId }).onConflictDoNothing();
    const row = await this.getByUserId(userId);
    if (!row) throw new Error(`Failed to provision person for user ${userId}`);
    return row;
  }

  async getOrCreateForStudent(studentId: string): Promise<Person> {
    const existing = await this.getByStudentId(studentId);
    if (existing) return existing;
    await db.insert(persons).values({ studentId }).onConflictDoNothing();
    const row = await this.getByStudentId(studentId);
    if (!row) throw new Error(`Failed to provision person for student ${studentId}`);
    return row;
  }

  /** The user facet of a person, or null for a facet-less / student-only person. */
  async getUserId(personId: string): Promise<string | null> {
    const [row] = await db.select({ userId: persons.userId }).from(persons).where(eq(persons.id, personId));
    return row?.userId ?? null;
  }

  /** Human-readable name for a person — user-facet name, else student name. */
  async getDisplayName(personId: string): Promise<string> {
    const [row] = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        studentName: students.name,
      })
      .from(persons)
      .leftJoin(users, eq(users.id, persons.userId))
      .leftJoin(students, eq(students.id, persons.studentId))
      .where(eq(persons.id, personId));
    if (!row) return "Someone";
    const userName = [row.firstName, row.lastName].filter(Boolean).join(" ");
    return userName || row.studentName || row.email || "Someone";
  }
}

export const personRepository = new PersonRepository();
