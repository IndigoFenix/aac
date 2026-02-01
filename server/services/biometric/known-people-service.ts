// server/services/biometric/known-people-service.ts
// Service for fetching known people embeddings for identification

import { db } from "../../db";
import { users, students, userStudents } from "@shared/schema";
import { eq, and, isNotNull, or } from "drizzle-orm";

export interface KnownPerson {
  id: string;
  type: "student" | "user";
  name: string;
  relationship?: string;
  faceEmbedding: number[] | null;
  voiceEmbedding: number[] | null;
}

/**
 * Get all known people (student + connected users) with their biometric embeddings
 * This is used for frontend identification in the AAC system
 */
export async function getKnownPeopleForStudent(studentId: string): Promise<KnownPerson[]> {
  const knownPeople: KnownPerson[] = [];

  // 1. Get the student themselves
  const [student] = await db
    .select({
      id: students.id,
      name: students.name,
      faceEmbedding: students.faceEmbedding,
      voiceEmbedding: students.voiceEmbedding,
    })
    .from(students)
    .where(eq(students.id, studentId));

  if (student) {
    knownPeople.push({
      id: student.id,
      type: "student",
      name: student.name,
      relationship: "student",
      faceEmbedding: student.faceEmbedding as number[] | null,
      voiceEmbedding: student.voiceEmbedding as number[] | null,
    });
  }

  // 2. Get all users linked to this student with their relationships
  const linkedUsers = await db
    .select({
      userId: userStudents.userId,
      role: userStudents.role,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
      faceEmbedding: users.faceEmbedding,
      voiceEmbedding: users.voiceEmbedding,
    })
    .from(userStudents)
    .innerJoin(users, eq(users.id, userStudents.userId))
    .where(
      and(
        eq(userStudents.studentId, studentId),
        eq(userStudents.isActive, true)
      )
    );

  for (const linkedUser of linkedUsers) {
    const name = linkedUser.fullName ||
      `${linkedUser.firstName || ""} ${linkedUser.lastName || ""}`.trim() ||
      "Unknown";

    knownPeople.push({
      id: linkedUser.userId,
      type: "user",
      name,
      relationship: linkedUser.role || "caregiver",
      faceEmbedding: linkedUser.faceEmbedding as number[] | null,
      voiceEmbedding: linkedUser.voiceEmbedding as number[] | null,
    });
  }

  // 3. Filter to only include people with at least one embedding
  // (no point sending people who can't be identified)
  const peopleWithEmbeddings = knownPeople.filter(
    (p) => p.faceEmbedding !== null || p.voiceEmbedding !== null
  );

  console.log(
    `[KnownPeople] Found ${knownPeople.length} people for student ${studentId}, ` +
    `${peopleWithEmbeddings.length} with embeddings`
  );

  return peopleWithEmbeddings;
}

/**
 * Get known people with embeddings for a specific user
 * Returns the user + any students they're linked to
 */
export async function getKnownPeopleForUser(userId: string): Promise<KnownPerson[]> {
  const knownPeople: KnownPerson[] = [];

  // 1. Get the user themselves
  const [user] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
      faceEmbedding: users.faceEmbedding,
      voiceEmbedding: users.voiceEmbedding,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (user) {
    const name = user.fullName ||
      `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
      "Unknown";

    knownPeople.push({
      id: user.id,
      type: "user",
      name,
      relationship: "self",
      faceEmbedding: user.faceEmbedding as number[] | null,
      voiceEmbedding: user.voiceEmbedding as number[] | null,
    });
  }

  // 2. Get all students linked to this user
  const linkedStudents = await db
    .select({
      studentId: userStudents.studentId,
      role: userStudents.role,
      name: students.name,
      faceEmbedding: students.faceEmbedding,
      voiceEmbedding: students.voiceEmbedding,
    })
    .from(userStudents)
    .innerJoin(students, eq(students.id, userStudents.studentId))
    .where(
      and(
        eq(userStudents.userId, userId),
        eq(userStudents.isActive, true)
      )
    );

  for (const linkedStudent of linkedStudents) {
    knownPeople.push({
      id: linkedStudent.studentId,
      type: "student",
      name: linkedStudent.name,
      relationship: "student",
      faceEmbedding: linkedStudent.faceEmbedding as number[] | null,
      voiceEmbedding: linkedStudent.voiceEmbedding as number[] | null,
    });
  }

  // Filter to only include people with embeddings
  return knownPeople.filter(
    (p) => p.faceEmbedding !== null || p.voiceEmbedding !== null
  );
}
