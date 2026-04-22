// server/services/biometric/recognition-service.ts
// Biometric recognition service — face, voice, contacts, known people.
//
// All face/voice embeddings live on the shared `biometric_data` table.
// users / students / studentContacts each carry a `biometricDataId` FK pointing
// to their row. When a studentContacts row is linked to a user or student, its
// biometricDataId is write-through-synced at creation time so one real person
// has one biometric record regardless of how many relationships they appear in.

import { db } from "../../db";
import {
  users,
  students,
  userStudents,
  studentContacts,
  biometricData,
  instituteStudents,
  instituteUsers,
  type BiometricData,
  type StudentContact,
  type InsertStudentContact,
  type UpdateStudentContact,
  type InsertBiometricData,
  type UpdateBiometricData,
} from "@shared/schema";
import { eq, and, isNotNull, sql, inArray, ne } from "drizzle-orm";

// ============================================================================
// Types
// ============================================================================

export type FaceEmbedding = number[];
export type VoiceEmbedding = number[];

export type EntityType = "user" | "student" | "contact";

export interface FaceMatchResult {
  matched: boolean;
  entityType: EntityType;
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
  entityType: EntityType;
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
  type: EntityType;
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
// Embedding math
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
// biometricData CRUD
// ============================================================================

export async function createBiometricData(data: InsertBiometricData = {}): Promise<BiometricData> {
  const [row] = await db.insert(biometricData).values(data).returning();
  return row;
}

export async function getBiometricData(id: string): Promise<BiometricData | undefined> {
  const [row] = await db.select().from(biometricData).where(eq(biometricData.id, id));
  return row;
}

export async function updateBiometricData(
  id: string,
  data: UpdateBiometricData,
): Promise<BiometricData | undefined> {
  const [row] = await db
    .update(biometricData)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(biometricData.id, id))
    .returning();
  return row;
}

export async function deleteBiometricData(id: string): Promise<void> {
  await db.delete(biometricData).where(eq(biometricData.id, id));
}

/**
 * Ensure a target entity (user/student/contact) has a biometric_data row and
 * return its id. If none exists, creates an empty one and sets the FK.
 *
 * For contacts: if the contact is linked to a user/student, delegates to that
 * canonical record's biometric_data — never creates a fresh row for the link.
 */
export async function ensureBiometricData(
  target: { type: EntityType; id: string },
): Promise<string> {
  if (target.type === "user") {
    const [u] = await db
      .select({ biometricDataId: users.biometricDataId })
      .from(users)
      .where(eq(users.id, target.id));
    if (u?.biometricDataId) return u.biometricDataId;
    const row = await createBiometricData();
    await db.update(users).set({ biometricDataId: row.id }).where(eq(users.id, target.id));
    return row.id;
  }
  if (target.type === "student") {
    const [s] = await db
      .select({ biometricDataId: students.biometricDataId })
      .from(students)
      .where(eq(students.id, target.id));
    if (s?.biometricDataId) return s.biometricDataId;
    const row = await createBiometricData();
    await db.update(students).set({ biometricDataId: row.id }).where(eq(students.id, target.id));
    return row.id;
  }
  // contact
  const [c] = await db
    .select({
      biometricDataId: studentContacts.biometricDataId,
      linkedUserId: studentContacts.linkedUserId,
      linkedStudentId: studentContacts.linkedStudentId,
    })
    .from(studentContacts)
    .where(eq(studentContacts.id, target.id));
  if (!c) throw new Error(`Contact ${target.id} not found`);

  // If linked, sync to the canonical record's biometric_data
  if (c.linkedUserId) {
    const bdId = await ensureBiometricData({ type: "user", id: c.linkedUserId });
    if (c.biometricDataId !== bdId) {
      await db
        .update(studentContacts)
        .set({ biometricDataId: bdId })
        .where(eq(studentContacts.id, target.id));
    }
    return bdId;
  }
  if (c.linkedStudentId) {
    const bdId = await ensureBiometricData({ type: "student", id: c.linkedStudentId });
    if (c.biometricDataId !== bdId) {
      await db
        .update(studentContacts)
        .set({ biometricDataId: bdId })
        .where(eq(studentContacts.id, target.id));
    }
    return bdId;
  }
  // Unlinked — own biometric row
  if (c.biometricDataId) return c.biometricDataId;
  const row = await createBiometricData();
  await db
    .update(studentContacts)
    .set({ biometricDataId: row.id })
    .where(eq(studentContacts.id, target.id));
  return row.id;
}

// ============================================================================
// Face / voice embedding helpers
// ============================================================================

async function getBiometricDataIdFor(target: { type: EntityType; id: string }): Promise<string | null> {
  if (target.type === "user") {
    const [u] = await db.select({ bd: users.biometricDataId }).from(users).where(eq(users.id, target.id));
    return u?.bd ?? null;
  }
  if (target.type === "student") {
    const [s] = await db.select({ bd: students.biometricDataId }).from(students).where(eq(students.id, target.id));
    return s?.bd ?? null;
  }
  const [c] = await db
    .select({ bd: studentContacts.biometricDataId })
    .from(studentContacts)
    .where(eq(studentContacts.id, target.id));
  return c?.bd ?? null;
}

export async function storeFaceEmbeddingForUser(userId: string, embedding: FaceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "user", id: userId });
  await updateBiometricData(bdId, { faceEmbedding: embedding });
}

export async function storeFaceEmbeddingForStudent(studentId: string, embedding: FaceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "student", id: studentId });
  await updateBiometricData(bdId, { faceEmbedding: embedding });
}

export async function storeFaceEmbeddingForContact(contactId: string, embedding: FaceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "contact", id: contactId });
  await updateBiometricData(bdId, { faceEmbedding: embedding });
}

export async function getFaceEmbeddingForUser(userId: string): Promise<FaceEmbedding | null> {
  const bdId = await getBiometricDataIdFor({ type: "user", id: userId });
  if (!bdId) return null;
  const row = await getBiometricData(bdId);
  return (row?.faceEmbedding as FaceEmbedding) ?? null;
}

export async function getFaceEmbeddingForStudent(studentId: string): Promise<FaceEmbedding | null> {
  const bdId = await getBiometricDataIdFor({ type: "student", id: studentId });
  if (!bdId) return null;
  const row = await getBiometricData(bdId);
  return (row?.faceEmbedding as FaceEmbedding) ?? null;
}

export async function removeFaceEmbeddingForUser(userId: string): Promise<void> {
  const bdId = await getBiometricDataIdFor({ type: "user", id: userId });
  if (bdId) await updateBiometricData(bdId, { faceEmbedding: null });
}

export async function removeFaceEmbeddingForStudent(studentId: string): Promise<void> {
  const bdId = await getBiometricDataIdFor({ type: "student", id: studentId });
  if (bdId) await updateBiometricData(bdId, { faceEmbedding: null });
}

export async function storeVoiceEmbeddingForUser(userId: string, embedding: VoiceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "user", id: userId });
  await updateBiometricData(bdId, { voiceEmbedding: embedding });
}

export async function storeVoiceEmbeddingForStudent(studentId: string, embedding: VoiceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "student", id: studentId });
  await updateBiometricData(bdId, { voiceEmbedding: embedding });
}

export async function getVoiceEmbeddingForUser(userId: string): Promise<VoiceEmbedding | null> {
  const bdId = await getBiometricDataIdFor({ type: "user", id: userId });
  if (!bdId) return null;
  const row = await getBiometricData(bdId);
  return (row?.voiceEmbedding as VoiceEmbedding) ?? null;
}

export async function getVoiceEmbeddingForStudent(studentId: string): Promise<VoiceEmbedding | null> {
  const bdId = await getBiometricDataIdFor({ type: "student", id: studentId });
  if (!bdId) return null;
  const row = await getBiometricData(bdId);
  return (row?.voiceEmbedding as VoiceEmbedding) ?? null;
}

export async function removeVoiceEmbeddingForUser(userId: string): Promise<void> {
  const bdId = await getBiometricDataIdFor({ type: "user", id: userId });
  if (bdId) await updateBiometricData(bdId, { voiceEmbedding: null });
}

export async function removeVoiceEmbeddingForStudent(studentId: string): Promise<void> {
  const bdId = await getBiometricDataIdFor({ type: "student", id: studentId });
  if (bdId) await updateBiometricData(bdId, { voiceEmbedding: null });
}

// ============================================================================
// Face matching — dedupe by biometricDataId so linked records match once
// ============================================================================

export async function findMatchingFace(
  embedding: FaceEmbedding,
  studentId?: string,
): Promise<FaceMatchResult | null> {
  let bestMatch: FaceMatchResult | null = null;
  let bestDistance = FACE_MATCH_THRESHOLD;
  const seenBdIds = new Set<string>();

  const tryMatch = (
    bdId: string | null,
    faceEmbedding: unknown,
    result: Omit<FaceMatchResult, "matched" | "distance" | "confidence">,
  ) => {
    if (!faceEmbedding) return;
    if (bdId && seenBdIds.has(bdId)) return; // already evaluated via canonical record
    if (bdId) seenBdIds.add(bdId);
    const distance = euclideanDistance(embedding, faceEmbedding as FaceEmbedding);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = {
        matched: true,
        distance,
        confidence: Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD),
        ...result,
      };
    }
  };

  // 1. The specific student + their contacts (most-likely matches first)
  if (studentId) {
    const [s] = await db
      .select({
        id: students.id,
        name: students.name,
        bdId: students.biometricDataId,
        faceEmbedding: biometricData.faceEmbedding,
      })
      .from(students)
      .leftJoin(biometricData, eq(biometricData.id, students.biometricDataId))
      .where(eq(students.id, studentId));
    if (s) {
      tryMatch(s.bdId, s.faceEmbedding, {
        entityType: "student",
        entityId: s.id,
        name: s.name,
      });
    }

    const contacts = await db
      .select({
        id: studentContacts.id,
        name: studentContacts.name,
        relationship: studentContacts.relationship,
        contextNotes: studentContacts.contextNotes,
        bdId: studentContacts.biometricDataId,
        faceEmbedding: biometricData.faceEmbedding,
        physicalDescription: biometricData.physicalDescription,
      })
      .from(studentContacts)
      .leftJoin(biometricData, eq(biometricData.id, studentContacts.biometricDataId))
      .where(and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true)));

    for (const c of contacts) {
      tryMatch(c.bdId, c.faceEmbedding, {
        entityType: "contact",
        entityId: c.id,
        name: c.name,
        relationship: c.relationship || undefined,
        description: c.physicalDescription || undefined,
        contextNotes: c.contextNotes || undefined,
      });
    }
  }

  // 2. All users with face embeddings
  const usersWithFaces = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
      bdId: users.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
    })
    .from(users)
    .innerJoin(biometricData, eq(biometricData.id, users.biometricDataId))
    .where(isNotNull(biometricData.faceEmbedding));

  for (const u of usersWithFaces) {
    const name =
      u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Unknown User";
    tryMatch(u.bdId, u.faceEmbedding, { entityType: "user", entityId: u.id, name });
  }

  // 3. All other students with face embeddings
  const studentsWithFaces = await db
    .select({
      id: students.id,
      name: students.name,
      bdId: students.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
    })
    .from(students)
    .innerJoin(biometricData, eq(biometricData.id, students.biometricDataId))
    .where(isNotNull(biometricData.faceEmbedding));

  for (const s of studentsWithFaces) {
    if (s.id === studentId) continue;
    tryMatch(s.bdId, s.faceEmbedding, {
      entityType: "student",
      entityId: s.id,
      name: s.name,
    });
  }

  return bestMatch;
}

// ============================================================================
// Voice matching (same dedup strategy)
// ============================================================================

export async function findMatchingVoice(
  embedding: VoiceEmbedding,
  studentId?: string,
): Promise<VoiceMatchResult | null> {
  let bestMatch: VoiceMatchResult | null = null;
  let bestSimilarity = VOICE_MATCH_THRESHOLD;
  const seenBdIds = new Set<string>();

  const tryMatch = (
    bdId: string | null,
    voiceEmbedding: unknown,
    result: Omit<VoiceMatchResult, "matched" | "similarity" | "confidence">,
  ) => {
    if (!voiceEmbedding) return;
    if (bdId && seenBdIds.has(bdId)) return;
    if (bdId) seenBdIds.add(bdId);
    const similarity = cosineSimilarity(embedding, voiceEmbedding as VoiceEmbedding);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = {
        matched: true,
        similarity,
        confidence: (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD),
        ...result,
      };
    }
  };

  if (studentId) {
    const [s] = await db
      .select({
        id: students.id,
        name: students.name,
        bdId: students.biometricDataId,
        voiceEmbedding: biometricData.voiceEmbedding,
      })
      .from(students)
      .leftJoin(biometricData, eq(biometricData.id, students.biometricDataId))
      .where(eq(students.id, studentId));
    if (s) {
      tryMatch(s.bdId, s.voiceEmbedding, {
        entityType: "student",
        entityId: s.id,
        name: s.name,
      });
    }
  }

  const usersWithVoices = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
      bdId: users.biometricDataId,
      voiceEmbedding: biometricData.voiceEmbedding,
    })
    .from(users)
    .innerJoin(biometricData, eq(biometricData.id, users.biometricDataId))
    .where(isNotNull(biometricData.voiceEmbedding));

  for (const u of usersWithVoices) {
    const name =
      u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Unknown User";
    tryMatch(u.bdId, u.voiceEmbedding, { entityType: "user", entityId: u.id, name });
  }

  const studentsWithVoices = await db
    .select({
      id: students.id,
      name: students.name,
      bdId: students.biometricDataId,
      voiceEmbedding: biometricData.voiceEmbedding,
    })
    .from(students)
    .innerJoin(biometricData, eq(biometricData.id, students.biometricDataId))
    .where(isNotNull(biometricData.voiceEmbedding));

  for (const s of studentsWithVoices) {
    if (s.id === studentId) continue;
    tryMatch(s.bdId, s.voiceEmbedding, {
      entityType: "student",
      entityId: s.id,
      name: s.name,
    });
  }

  return bestMatch;
}

// ============================================================================
// Single-entity match (still used by voice-gated flows)
// ============================================================================

export async function matchesFaceForUser(
  userId: string,
  embedding: FaceEmbedding,
): Promise<{ matched: boolean; confidence: number }> {
  const stored = await getFaceEmbeddingForUser(userId);
  if (!stored) return { matched: false, confidence: 0 };
  const distance = euclideanDistance(embedding, stored);
  const matched = distance < FACE_MATCH_THRESHOLD;
  return { matched, confidence: matched ? Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD) : 0 };
}

export async function matchesFaceForStudent(
  studentId: string,
  embedding: FaceEmbedding,
): Promise<{ matched: boolean; confidence: number }> {
  const stored = await getFaceEmbeddingForStudent(studentId);
  if (!stored) return { matched: false, confidence: 0 };
  const distance = euclideanDistance(embedding, stored);
  const matched = distance < FACE_MATCH_THRESHOLD;
  return { matched, confidence: matched ? Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD) : 0 };
}

export async function matchesVoiceForUser(
  userId: string,
  embedding: VoiceEmbedding,
): Promise<{ matched: boolean; confidence: number }> {
  const stored = await getVoiceEmbeddingForUser(userId);
  if (!stored) return { matched: false, confidence: 0 };
  const similarity = cosineSimilarity(embedding, stored);
  const matched = similarity > VOICE_MATCH_THRESHOLD;
  return {
    matched,
    confidence: matched ? (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD) : 0,
  };
}

export async function matchesVoiceForStudent(
  studentId: string,
  embedding: VoiceEmbedding,
): Promise<{ matched: boolean; confidence: number }> {
  const stored = await getVoiceEmbeddingForStudent(studentId);
  if (!stored) return { matched: false, confidence: 0 };
  const similarity = cosineSimilarity(embedding, stored);
  const matched = similarity > VOICE_MATCH_THRESHOLD;
  return {
    matched,
    confidence: matched ? (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD) : 0,
  };
}

// ============================================================================
// Known People — dedupes by biometricDataId when a contact is linked
// ============================================================================

export async function getKnownPeopleForStudent(studentId: string): Promise<KnownPerson[]> {
  const peopleById = new Map<string, KnownPerson>();
  const seenBdIds = new Set<string>();

  // 1. The student themselves
  const [student] = await db
    .select({
      id: students.id,
      name: students.name,
      bdId: students.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
      voiceEmbedding: biometricData.voiceEmbedding,
    })
    .from(students)
    .leftJoin(biometricData, eq(biometricData.id, students.biometricDataId))
    .where(eq(students.id, studentId));

  if (student) {
    if (student.bdId) seenBdIds.add(student.bdId);
    peopleById.set(`student:${student.id}`, {
      id: student.id,
      type: "student",
      name: student.name,
      relationship: "student",
      faceEmbedding: (student.faceEmbedding as number[] | null) ?? null,
      voiceEmbedding: (student.voiceEmbedding as number[] | null) ?? null,
    });
  }

  // 2. Users linked to this student (via userStudents)
  const linkedUsers = await db
    .select({
      userId: userStudents.userId,
      role: userStudents.role,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
      bdId: users.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
      voiceEmbedding: biometricData.voiceEmbedding,
    })
    .from(userStudents)
    .innerJoin(users, eq(users.id, userStudents.userId))
    .leftJoin(biometricData, eq(biometricData.id, users.biometricDataId))
    .where(and(eq(userStudents.studentId, studentId), eq(userStudents.isActive, true)));

  for (const u of linkedUsers) {
    if (u.bdId) seenBdIds.add(u.bdId);
    const name =
      u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Unknown";
    peopleById.set(`user:${u.userId}`, {
      id: u.userId,
      type: "user",
      name,
      relationship: u.role || "caregiver",
      faceEmbedding: (u.faceEmbedding as number[] | null) ?? null,
      voiceEmbedding: (u.voiceEmbedding as number[] | null) ?? null,
    });
  }

  // 3. Active contacts — skip those whose biometric data we've already added via link
  const contacts = await db
    .select({
      id: studentContacts.id,
      name: studentContacts.name,
      relationship: studentContacts.relationship,
      contextNotes: studentContacts.contextNotes,
      bdId: studentContacts.biometricDataId,
      linkedUserId: studentContacts.linkedUserId,
      linkedStudentId: studentContacts.linkedStudentId,
      faceEmbedding: biometricData.faceEmbedding,
      voiceEmbedding: biometricData.voiceEmbedding,
      physicalDescription: biometricData.physicalDescription,
    })
    .from(studentContacts)
    .leftJoin(biometricData, eq(biometricData.id, studentContacts.biometricDataId))
    .where(and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true)));

  for (const c of contacts) {
    // Skip if this contact's biometric data is already included via user/student link
    if (c.bdId && seenBdIds.has(c.bdId)) continue;
    if (c.bdId) seenBdIds.add(c.bdId);
    peopleById.set(`contact:${c.id}`, {
      id: c.id,
      type: "contact",
      name: c.name,
      relationship: c.relationship || undefined,
      faceEmbedding: (c.faceEmbedding as number[] | null) ?? null,
      voiceEmbedding: (c.voiceEmbedding as number[] | null) ?? null,
      description: c.physicalDescription || undefined,
      contextNotes: c.contextNotes || undefined,
    });
  }

  // Filter to only people with at least one embedding
  const peopleWithEmbeddings = Array.from(peopleById.values()).filter(
    (p) => p.faceEmbedding !== null || p.voiceEmbedding !== null,
  );

  console.log(
    `[Recognition] Found ${peopleById.size} people for student ${studentId}, ` +
      `${peopleWithEmbeddings.length} with embeddings (${contacts.length} contacts)`,
  );

  return peopleWithEmbeddings;
}

export async function getKnownPeopleForUser(userId: string): Promise<KnownPerson[]> {
  const people: KnownPerson[] = [];

  const [user] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
      bdId: users.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
      voiceEmbedding: biometricData.voiceEmbedding,
    })
    .from(users)
    .leftJoin(biometricData, eq(biometricData.id, users.biometricDataId))
    .where(eq(users.id, userId));

  if (user) {
    const name =
      user.fullName || `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Unknown";
    people.push({
      id: user.id,
      type: "user",
      name,
      relationship: "self",
      faceEmbedding: (user.faceEmbedding as number[] | null) ?? null,
      voiceEmbedding: (user.voiceEmbedding as number[] | null) ?? null,
    });
  }

  const linkedStudents = await db
    .select({
      studentId: userStudents.studentId,
      role: userStudents.role,
      name: students.name,
      bdId: students.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
      voiceEmbedding: biometricData.voiceEmbedding,
    })
    .from(userStudents)
    .innerJoin(students, eq(students.id, userStudents.studentId))
    .leftJoin(biometricData, eq(biometricData.id, students.biometricDataId))
    .where(and(eq(userStudents.userId, userId), eq(userStudents.isActive, true)));

  for (const s of linkedStudents) {
    people.push({
      id: s.studentId,
      type: "student",
      name: s.name,
      relationship: "student",
      faceEmbedding: (s.faceEmbedding as number[] | null) ?? null,
      voiceEmbedding: (s.voiceEmbedding as number[] | null) ?? null,
    });
  }

  return people.filter((p) => p.faceEmbedding !== null || p.voiceEmbedding !== null);
}

// ============================================================================
// Contact CRUD with linked-record invariants
// ============================================================================

const CONTACT_LINK_ERRORS = {
  bothLinks: "A contact cannot link to both a user and another student",
  selfLink: "A student cannot be their own contact",
} as const;

/**
 * Validate link invariants and resolve biometricDataId based on links.
 * Returns the data to actually insert/update.
 */
async function applyLinkInvariants<
  T extends {
    linkedUserId?: string | null;
    linkedStudentId?: string | null;
    studentId?: string | null;
    biometricDataId?: string | null;
  },
>(data: T, ownerStudentId?: string): Promise<T> {
  if (data.linkedUserId && data.linkedStudentId) {
    throw new Error(CONTACT_LINK_ERRORS.bothLinks);
  }
  const sid = ownerStudentId ?? data.studentId ?? null;
  if (data.linkedStudentId && sid && data.linkedStudentId === sid) {
    throw new Error(CONTACT_LINK_ERRORS.selfLink);
  }
  // Write-through biometricDataId from linked entity
  if (data.linkedUserId) {
    const bdId = await ensureBiometricData({ type: "user", id: data.linkedUserId });
    return { ...data, biometricDataId: bdId };
  }
  if (data.linkedStudentId) {
    const bdId = await ensureBiometricData({ type: "student", id: data.linkedStudentId });
    return { ...data, biometricDataId: bdId };
  }
  return data;
}

export async function createContact(data: InsertStudentContact): Promise<StudentContact> {
  const validated = await applyLinkInvariants(data);
  const [contact] = await db.insert(studentContacts).values(validated).returning();
  console.log(`[Recognition] Created contact "${contact.name}" for student ${data.studentId}`);
  return contact;
}

export async function getContact(id: string): Promise<StudentContact | undefined> {
  const [contact] = await db.select().from(studentContacts).where(eq(studentContacts.id, id));
  return contact;
}

export async function getContactsByStudent(studentId: string): Promise<StudentContact[]> {
  return db
    .select()
    .from(studentContacts)
    .where(and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true)));
}

export async function updateContact(
  id: string,
  data: UpdateStudentContact,
): Promise<StudentContact | undefined> {
  // Load current record so invariants can be validated against the merged view
  const [current] = await db
    .select({
      studentId: studentContacts.studentId,
      linkedUserId: studentContacts.linkedUserId,
      linkedStudentId: studentContacts.linkedStudentId,
    })
    .from(studentContacts)
    .where(eq(studentContacts.id, id));
  if (!current) return undefined;

  const merged = {
    ...data,
    linkedUserId: "linkedUserId" in data ? data.linkedUserId : current.linkedUserId,
    linkedStudentId: "linkedStudentId" in data ? data.linkedStudentId : current.linkedStudentId,
  };
  const validated = await applyLinkInvariants(merged, current.studentId);

  const [contact] = await db
    .update(studentContacts)
    .set({ ...validated, updatedAt: new Date() })
    .where(eq(studentContacts.id, id))
    .returning();
  return contact;
}

export async function deleteContact(id: string): Promise<void> {
  await db
    .update(studentContacts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(studentContacts.id, id));
}

/** Record a sighting for a contact — bumps timesIdentified and lastSeenAt. */
export async function recordContactSighting(contactId: string): Promise<void> {
  await db
    .update(studentContacts)
    .set({
      lastSeenAt: new Date(),
      timesIdentified: sql`${studentContacts.timesIdentified} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(studentContacts.id, contactId));
}

export async function enrollContactFace(contactId: string, embedding: FaceEmbedding): Promise<void> {
  await storeFaceEmbeddingForContact(contactId, embedding);
}

// ============================================================================
// Dedup check for AI enrollment
// ============================================================================

export async function findSimilarContact(
  studentId: string,
  embedding: FaceEmbedding,
): Promise<StudentContact | null> {
  const rows = await db
    .select({
      contact: studentContacts,
      faceEmbedding: biometricData.faceEmbedding,
    })
    .from(studentContacts)
    .innerJoin(biometricData, eq(biometricData.id, studentContacts.biometricDataId))
    .where(
      and(
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.isActive, true),
        isNotNull(biometricData.faceEmbedding),
      ),
    );

  for (const row of rows) {
    if (!row.faceEmbedding) continue;
    const distance = euclideanDistance(embedding, row.faceEmbedding as FaceEmbedding);
    if (distance < FACE_MATCH_THRESHOLD) {
      return row.contact;
    }
  }

  return null;
}

// ============================================================================
// Linkable entities — users + other students sharing an institute with this
// student. Used by the contact editor to populate linkedUserId / linkedStudentId.
// ============================================================================

export interface LinkableEntity {
  id: string;
  type: "user" | "student";
  name: string;
  detail?: string; // email for users, role/relationship context for students
}

export async function getLinkableEntitiesForStudent(
  studentId: string,
): Promise<LinkableEntity[]> {
  // 1. Find all institutes this student is a member of
  const studentInstitutes = await db
    .select({ instituteId: instituteStudents.instituteId })
    .from(instituteStudents)
    .where(
      and(
        eq(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true),
      ),
    );
  const instituteIds = studentInstitutes.map((r) => r.instituteId);
  if (instituteIds.length === 0) return [];

  // 2. Users in those institutes
  const institutesUsers = await db
    .selectDistinct({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
    })
    .from(instituteUsers)
    .innerJoin(users, eq(users.id, instituteUsers.userId))
    .where(
      and(
        inArray(instituteUsers.instituteId, instituteIds),
        eq(instituteUsers.isActive, true),
        eq(users.isActive, true),
      ),
    );

  // 3. Other students in those institutes (excluding the subject student)
  const institutesStudents = await db
    .selectDistinct({
      id: students.id,
      name: students.name,
      firstName: students.firstName,
      lastName: students.lastName,
    })
    .from(instituteStudents)
    .innerJoin(students, eq(students.id, instituteStudents.studentId))
    .where(
      and(
        inArray(instituteStudents.instituteId, instituteIds),
        ne(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true),
        eq(students.isActive, true),
      ),
    );

  const linkable: LinkableEntity[] = [
    ...institutesUsers.map((u) => ({
      id: u.id,
      type: "user" as const,
      name:
        u.fullName ||
        `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
        u.email ||
        "Unknown",
      detail: u.email,
    })),
    ...institutesStudents.map((s) => ({
      id: s.id,
      type: "student" as const,
      name: s.name || `${s.firstName || ""} ${s.lastName || ""}`.trim() || "Unknown",
    })),
  ];

  linkable.sort((a, b) => a.name.localeCompare(b.name));
  return linkable;
}
