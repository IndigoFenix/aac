// server/services/biometric/recognition-service.ts
// Consolidated biometric recognition service — face, voice, contacts, known people

import { db } from "../../db";
import { users, students, userStudents, studentContacts } from "@shared/schema";
import type { StudentContact, InsertStudentContact, UpdateStudentContact } from "@shared/schema";
import { eq, and, isNotNull } from "drizzle-orm";

// ============================================================================
// Types
// ============================================================================

export type FaceEmbedding = number[];
export type VoiceEmbedding = number[];

export interface FaceMatchResult {
  matched: boolean;
  entityType: "student" | "user" | "contact";
  entityId: string;
  name: string;
  distance: number;
  confidence: number;
  description?: string;
  contextNotes?: string;
  relationship?: string;
}

export interface VoiceMatchResult {
  matched: boolean;
  entityType: "student" | "user" | "contact";
  entityId: string;
  name: string;
  similarity: number;
  confidence: number;
  description?: string;
  contextNotes?: string;
  relationship?: string;
}

export interface KnownPerson {
  id: string;
  type: "student" | "user" | "contact";
  name: string;
  relationship?: string;
  faceEmbedding: number[] | null;
  voiceEmbedding: number[] | null;
  description?: string;
  contextNotes?: string;
}

// ============================================================================
// Thresholds
// ============================================================================

const FACE_MATCH_THRESHOLD = 0.6;
const VOICE_MATCH_THRESHOLD = 0.75;

// ============================================================================
// Embedding Math
// ============================================================================

function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimensions don't match: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.pow(a[i] - b[i], 2);
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimensions don't match: ${a.length} vs ${b.length}`);
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;
  return dotProduct / magnitude;
}

// ============================================================================
// Face Embedding CRUD (users/students)
// ============================================================================

export async function storeFaceEmbeddingForUser(userId: string, embedding: FaceEmbedding): Promise<void> {
  await db.update(users).set({ faceEmbedding: embedding }).where(eq(users.id, userId));
}

export async function storeFaceEmbeddingForStudent(studentId: string, embedding: FaceEmbedding): Promise<void> {
  await db.update(students).set({ faceEmbedding: embedding }).where(eq(students.id, studentId));
}

export async function getFaceEmbeddingForUser(userId: string): Promise<FaceEmbedding | null> {
  const [user] = await db.select({ faceEmbedding: users.faceEmbedding }).from(users).where(eq(users.id, userId));
  return user?.faceEmbedding as FaceEmbedding | null;
}

export async function getFaceEmbeddingForStudent(studentId: string): Promise<FaceEmbedding | null> {
  const [student] = await db.select({ faceEmbedding: students.faceEmbedding }).from(students).where(eq(students.id, studentId));
  return student?.faceEmbedding as FaceEmbedding | null;
}

export async function removeFaceEmbeddingForUser(userId: string): Promise<void> {
  await db.update(users).set({ faceEmbedding: null }).where(eq(users.id, userId));
}

export async function removeFaceEmbeddingForStudent(studentId: string): Promise<void> {
  await db.update(students).set({ faceEmbedding: null }).where(eq(students.id, studentId));
}

// ============================================================================
// Voice Embedding CRUD (users/students)
// ============================================================================

export async function storeVoiceEmbeddingForUser(userId: string, embedding: VoiceEmbedding): Promise<void> {
  await db.update(users).set({ voiceEmbedding: embedding }).where(eq(users.id, userId));
}

export async function storeVoiceEmbeddingForStudent(studentId: string, embedding: VoiceEmbedding): Promise<void> {
  await db.update(students).set({ voiceEmbedding: embedding }).where(eq(students.id, studentId));
}

export async function getVoiceEmbeddingForUser(userId: string): Promise<VoiceEmbedding | null> {
  const [user] = await db.select({ voiceEmbedding: users.voiceEmbedding }).from(users).where(eq(users.id, userId));
  return user?.voiceEmbedding as VoiceEmbedding | null;
}

export async function getVoiceEmbeddingForStudent(studentId: string): Promise<VoiceEmbedding | null> {
  const [student] = await db.select({ voiceEmbedding: students.voiceEmbedding }).from(students).where(eq(students.id, studentId));
  return student?.voiceEmbedding as VoiceEmbedding | null;
}

export async function removeVoiceEmbeddingForUser(userId: string): Promise<void> {
  await db.update(users).set({ voiceEmbedding: null }).where(eq(users.id, userId));
}

export async function removeVoiceEmbeddingForStudent(studentId: string): Promise<void> {
  await db.update(students).set({ voiceEmbedding: null }).where(eq(students.id, studentId));
}

// ============================================================================
// Face Matching (extended to include contacts)
// ============================================================================

export async function findMatchingFace(
  embedding: FaceEmbedding,
  studentId?: string
): Promise<FaceMatchResult | null> {
  let bestMatch: FaceMatchResult | null = null;
  let bestDistance = FACE_MATCH_THRESHOLD;

  // Check the specific student first (most likely match)
  if (studentId) {
    const [student] = await db.select({
      id: students.id,
      name: students.name,
      faceEmbedding: students.faceEmbedding,
    }).from(students).where(eq(students.id, studentId));

    if (student?.faceEmbedding) {
      const distance = euclideanDistance(embedding, student.faceEmbedding as FaceEmbedding);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = {
          matched: true,
          entityType: "student",
          entityId: student.id,
          name: student.name,
          distance,
          confidence: Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD),
        };
      }
    }

    // Check contacts for this student
    const contacts = await db.select({
      id: studentContacts.id,
      name: studentContacts.name,
      relationship: studentContacts.relationship,
      description: studentContacts.description,
      contextNotes: studentContacts.contextNotes,
      faceEmbedding: studentContacts.faceEmbedding,
    }).from(studentContacts).where(
      and(
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.isActive, true),
        isNotNull(studentContacts.faceEmbedding)
      )
    );

    for (const contact of contacts) {
      if (!contact.faceEmbedding) continue;
      const distance = euclideanDistance(embedding, contact.faceEmbedding as FaceEmbedding);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = {
          matched: true,
          entityType: "contact",
          entityId: contact.id,
          name: contact.name,
          distance,
          confidence: Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD),
          relationship: contact.relationship || undefined,
          description: contact.description || undefined,
          contextNotes: contact.contextNotes || undefined,
        };
      }
    }
  }

  // Check all users with face embeddings
  const usersWithFaces = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName,
    faceEmbedding: users.faceEmbedding,
  }).from(users).where(isNotNull(users.faceEmbedding));

  for (const user of usersWithFaces) {
    if (!user.faceEmbedding) continue;
    const distance = euclideanDistance(embedding, user.faceEmbedding as FaceEmbedding);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = {
        matched: true,
        entityType: "user",
        entityId: user.id,
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Unknown User",
        distance,
        confidence: Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD),
      };
    }
  }

  // Check all students with face embeddings (excluding current)
  const studentsWithFaces = await db.select({
    id: students.id,
    name: students.name,
    faceEmbedding: students.faceEmbedding,
  }).from(students).where(isNotNull(students.faceEmbedding));

  for (const student of studentsWithFaces) {
    if (!student.faceEmbedding || student.id === studentId) continue;
    const distance = euclideanDistance(embedding, student.faceEmbedding as FaceEmbedding);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = {
        matched: true,
        entityType: "student",
        entityId: student.id,
        name: student.name,
        distance,
        confidence: Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD),
      };
    }
  }

  return bestMatch;
}

// ============================================================================
// Voice Matching
// ============================================================================

export async function findMatchingVoice(
  embedding: VoiceEmbedding,
  studentId?: string
): Promise<VoiceMatchResult | null> {
  let bestMatch: VoiceMatchResult | null = null;
  let bestSimilarity = VOICE_MATCH_THRESHOLD;

  if (studentId) {
    const [student] = await db.select({
      id: students.id,
      name: students.name,
      voiceEmbedding: students.voiceEmbedding,
    }).from(students).where(eq(students.id, studentId));

    if (student?.voiceEmbedding) {
      const similarity = cosineSimilarity(embedding, student.voiceEmbedding as VoiceEmbedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = {
          matched: true,
          entityType: "student",
          entityId: student.id,
          name: student.name,
          similarity,
          confidence: (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD),
        };
      }
    }
  }

  const usersWithVoices = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName,
    voiceEmbedding: users.voiceEmbedding,
  }).from(users).where(isNotNull(users.voiceEmbedding));

  for (const user of usersWithVoices) {
    if (!user.voiceEmbedding) continue;
    const similarity = cosineSimilarity(embedding, user.voiceEmbedding as VoiceEmbedding);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = {
        matched: true,
        entityType: "user",
        entityId: user.id,
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Unknown User",
        similarity,
        confidence: (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD),
      };
    }
  }

  const studentsWithVoices = await db.select({
    id: students.id,
    name: students.name,
    voiceEmbedding: students.voiceEmbedding,
  }).from(students).where(isNotNull(students.voiceEmbedding));

  for (const student of studentsWithVoices) {
    if (!student.voiceEmbedding || student.id === studentId) continue;
    const similarity = cosineSimilarity(embedding, student.voiceEmbedding as VoiceEmbedding);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = {
        matched: true,
        entityType: "student",
        entityId: student.id,
        name: student.name,
        similarity,
        confidence: (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD),
      };
    }
  }

  return bestMatch;
}

// ============================================================================
// Single-entity Face/Voice Matching
// ============================================================================

export async function matchesFaceForUser(
  userId: string,
  embedding: FaceEmbedding
): Promise<{ matched: boolean; confidence: number }> {
  const storedEmbedding = await getFaceEmbeddingForUser(userId);
  if (!storedEmbedding) return { matched: false, confidence: 0 };
  const distance = euclideanDistance(embedding, storedEmbedding);
  const matched = distance < FACE_MATCH_THRESHOLD;
  return { matched, confidence: matched ? Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD) : 0 };
}

export async function matchesFaceForStudent(
  studentId: string,
  embedding: FaceEmbedding
): Promise<{ matched: boolean; confidence: number }> {
  const storedEmbedding = await getFaceEmbeddingForStudent(studentId);
  if (!storedEmbedding) return { matched: false, confidence: 0 };
  const distance = euclideanDistance(embedding, storedEmbedding);
  const matched = distance < FACE_MATCH_THRESHOLD;
  return { matched, confidence: matched ? Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD) : 0 };
}

export async function matchesVoiceForUser(
  userId: string,
  embedding: VoiceEmbedding
): Promise<{ matched: boolean; confidence: number }> {
  const storedEmbedding = await getVoiceEmbeddingForUser(userId);
  if (!storedEmbedding) return { matched: false, confidence: 0 };
  const similarity = cosineSimilarity(embedding, storedEmbedding);
  const matched = similarity > VOICE_MATCH_THRESHOLD;
  return { matched, confidence: matched ? (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD) : 0 };
}

export async function matchesVoiceForStudent(
  studentId: string,
  embedding: VoiceEmbedding
): Promise<{ matched: boolean; confidence: number }> {
  const storedEmbedding = await getVoiceEmbeddingForStudent(studentId);
  if (!storedEmbedding) return { matched: false, confidence: 0 };
  const similarity = cosineSimilarity(embedding, storedEmbedding);
  const matched = similarity > VOICE_MATCH_THRESHOLD;
  return { matched, confidence: matched ? (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD) : 0 };
}

// ============================================================================
// Known People (student + linked users + active contacts)
// ============================================================================

export async function getKnownPeopleForStudent(studentId: string): Promise<KnownPerson[]> {
  const knownPeople: KnownPerson[] = [];

  // 1. Get the student themselves
  const [student] = await db.select({
    id: students.id,
    name: students.name,
    faceEmbedding: students.faceEmbedding,
    voiceEmbedding: students.voiceEmbedding,
  }).from(students).where(eq(students.id, studentId));

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

  // 2. Get all users linked to this student
  const linkedUsers = await db.select({
    userId: userStudents.userId,
    role: userStudents.role,
    firstName: users.firstName,
    lastName: users.lastName,
    fullName: users.fullName,
    faceEmbedding: users.faceEmbedding,
    voiceEmbedding: users.voiceEmbedding,
  }).from(userStudents)
    .innerJoin(users, eq(users.id, userStudents.userId))
    .where(and(eq(userStudents.studentId, studentId), eq(userStudents.isActive, true)));

  for (const linkedUser of linkedUsers) {
    const name = linkedUser.fullName ||
      `${linkedUser.firstName || ""} ${linkedUser.lastName || ""}`.trim() || "Unknown";
    knownPeople.push({
      id: linkedUser.userId,
      type: "user",
      name,
      relationship: linkedUser.role || "caregiver",
      faceEmbedding: linkedUser.faceEmbedding as number[] | null,
      voiceEmbedding: linkedUser.voiceEmbedding as number[] | null,
    });
  }

  // 3. Get all active contacts for this student
  const contacts = await db.select({
    id: studentContacts.id,
    name: studentContacts.name,
    relationship: studentContacts.relationship,
    description: studentContacts.description,
    contextNotes: studentContacts.contextNotes,
    faceEmbedding: studentContacts.faceEmbedding,
    voiceEmbedding: studentContacts.voiceEmbedding,
  }).from(studentContacts).where(
    and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true))
  );

  for (const contact of contacts) {
    knownPeople.push({
      id: contact.id,
      type: "contact",
      name: contact.name,
      relationship: contact.relationship || undefined,
      faceEmbedding: contact.faceEmbedding as number[] | null,
      voiceEmbedding: contact.voiceEmbedding as number[] | null,
      description: contact.description || undefined,
      contextNotes: contact.contextNotes || undefined,
    });
  }

  // Filter to only people with at least one embedding
  const peopleWithEmbeddings = knownPeople.filter(
    (p) => p.faceEmbedding !== null || p.voiceEmbedding !== null
  );

  console.log(
    `[Recognition] Found ${knownPeople.length} people for student ${studentId}, ` +
    `${peopleWithEmbeddings.length} with embeddings (${contacts.length} contacts)`
  );

  return peopleWithEmbeddings;
}

export async function getKnownPeopleForUser(userId: string): Promise<KnownPerson[]> {
  const knownPeople: KnownPerson[] = [];

  const [user] = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName,
    fullName: users.fullName,
    faceEmbedding: users.faceEmbedding,
    voiceEmbedding: users.voiceEmbedding,
  }).from(users).where(eq(users.id, userId));

  if (user) {
    const name = user.fullName ||
      `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Unknown";
    knownPeople.push({
      id: user.id,
      type: "user",
      name,
      relationship: "self",
      faceEmbedding: user.faceEmbedding as number[] | null,
      voiceEmbedding: user.voiceEmbedding as number[] | null,
    });
  }

  const linkedStudents = await db.select({
    studentId: userStudents.studentId,
    role: userStudents.role,
    name: students.name,
    faceEmbedding: students.faceEmbedding,
    voiceEmbedding: students.voiceEmbedding,
  }).from(userStudents)
    .innerJoin(students, eq(students.id, userStudents.studentId))
    .where(and(eq(userStudents.userId, userId), eq(userStudents.isActive, true)));

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

  return knownPeople.filter((p) => p.faceEmbedding !== null || p.voiceEmbedding !== null);
}

// ============================================================================
// Contact CRUD
// ============================================================================

export async function createContact(data: InsertStudentContact): Promise<StudentContact> {
  const [contact] = await db.insert(studentContacts).values(data).returning();
  console.log(`[Recognition] Created contact "${contact.name}" for student ${data.studentId}`);
  return contact;
}

export async function getContact(id: string): Promise<StudentContact | undefined> {
  const [contact] = await db.select().from(studentContacts).where(eq(studentContacts.id, id));
  return contact;
}

export async function getContactsByStudent(studentId: string): Promise<StudentContact[]> {
  return db.select().from(studentContacts).where(
    and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true))
  );
}

export async function updateContact(id: string, data: UpdateStudentContact): Promise<StudentContact | undefined> {
  const [contact] = await db.update(studentContacts)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(studentContacts.id, id))
    .returning();
  return contact;
}

export async function deleteContact(id: string): Promise<void> {
  await db.update(studentContacts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(studentContacts.id, id));
}

export async function enrollContactFace(contactId: string, embedding: FaceEmbedding): Promise<void> {
  await db.update(studentContacts)
    .set({ faceEmbedding: embedding, updatedAt: new Date() })
    .where(eq(studentContacts.id, contactId));
}

// ============================================================================
// Dedup check for AI enrollment
// ============================================================================

export async function findSimilarContact(
  studentId: string,
  embedding: FaceEmbedding
): Promise<StudentContact | null> {
  const contacts = await db.select().from(studentContacts).where(
    and(
      eq(studentContacts.studentId, studentId),
      eq(studentContacts.isActive, true),
      isNotNull(studentContacts.faceEmbedding)
    )
  );

  for (const contact of contacts) {
    if (!contact.faceEmbedding) continue;
    const distance = euclideanDistance(embedding, contact.faceEmbedding as FaceEmbedding);
    if (distance < FACE_MATCH_THRESHOLD) {
      return contact;
    }
  }

  return null;
}
