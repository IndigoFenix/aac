// server/services/biometric/face-service.ts
// Face recognition service for generating and comparing face embeddings

import { db } from "../../db";
import { users, students } from "@shared/schema";
import { eq, or, isNotNull } from "drizzle-orm";

// 128-dimensional face embedding (standard for face-api.js)
export type FaceEmbedding = number[];

// Euclidean distance threshold for face matching (lower = stricter)
const FACE_MATCH_THRESHOLD = 0.6;

/**
 * Calculate Euclidean distance between two embeddings
 */
function euclideanDistance(a: FaceEmbedding, b: FaceEmbedding): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimensions don't match: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.pow(a[i] - b[i], 2);
  }
  return Math.sqrt(sum);
}

/**
 * Store face embedding for a user
 */
export async function storeFaceEmbeddingForUser(
  userId: string,
  embedding: FaceEmbedding
): Promise<void> {
  await db.update(users)
    .set({ faceEmbedding: embedding })
    .where(eq(users.id, userId));
}

/**
 * Store face embedding for a student
 */
export async function storeFaceEmbeddingForStudent(
  studentId: string,
  embedding: FaceEmbedding
): Promise<void> {
  await db.update(students)
    .set({ faceEmbedding: embedding })
    .where(eq(students.id, studentId));
}

/**
 * Get face embedding for a user
 */
export async function getFaceEmbeddingForUser(userId: string): Promise<FaceEmbedding | null> {
  const [user] = await db.select({ faceEmbedding: users.faceEmbedding })
    .from(users)
    .where(eq(users.id, userId));
  return user?.faceEmbedding as FaceEmbedding | null;
}

/**
 * Get face embedding for a student
 */
export async function getFaceEmbeddingForStudent(studentId: string): Promise<FaceEmbedding | null> {
  const [student] = await db.select({ faceEmbedding: students.faceEmbedding })
    .from(students)
    .where(eq(students.id, studentId));
  return student?.faceEmbedding as FaceEmbedding | null;
}

/**
 * Remove face embedding for a user
 */
export async function removeFaceEmbeddingForUser(userId: string): Promise<void> {
  await db.update(users)
    .set({ faceEmbedding: null })
    .where(eq(users.id, userId));
}

/**
 * Remove face embedding for a student
 */
export async function removeFaceEmbeddingForStudent(studentId: string): Promise<void> {
  await db.update(students)
    .set({ faceEmbedding: null })
    .where(eq(students.id, studentId));
}

export interface FaceMatchResult {
  matched: boolean;
  entityType: "student" | "user";
  entityId: string;
  name: string;
  distance: number;
  confidence: number;
}

/**
 * Find matching face from stored embeddings
 * Returns the best match if found, or null if no match
 */
export async function findMatchingFace(
  embedding: FaceEmbedding,
  studentId?: string
): Promise<FaceMatchResult | null> {
  // Get the student's embedding first (most likely match)
  if (studentId) {
    const [student] = await db.select({
      id: students.id,
      name: students.name,
      faceEmbedding: students.faceEmbedding,
    })
      .from(students)
      .where(eq(students.id, studentId));

    if (student?.faceEmbedding) {
      const distance = euclideanDistance(embedding, student.faceEmbedding as FaceEmbedding);
      if (distance < FACE_MATCH_THRESHOLD) {
        return {
          matched: true,
          entityType: "student",
          entityId: student.id,
          name: student.name,
          distance,
          confidence: Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD),
        };
      }
    }
  }

  // Get all users with face embeddings
  const usersWithFaces = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName,
    faceEmbedding: users.faceEmbedding,
  })
    .from(users)
    .where(isNotNull(users.faceEmbedding));

  // Get all students with face embeddings (excluding the current student)
  const studentsWithFaces = await db.select({
    id: students.id,
    name: students.name,
    faceEmbedding: students.faceEmbedding,
  })
    .from(students)
    .where(isNotNull(students.faceEmbedding));

  let bestMatch: FaceMatchResult | null = null;
  let bestDistance = FACE_MATCH_THRESHOLD;

  // Check users
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

  // Check students
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

/**
 * Check if an embedding matches a specific user
 */
export async function matchesFaceForUser(
  userId: string,
  embedding: FaceEmbedding
): Promise<{ matched: boolean; confidence: number }> {
  const storedEmbedding = await getFaceEmbeddingForUser(userId);
  if (!storedEmbedding) {
    return { matched: false, confidence: 0 };
  }
  const distance = euclideanDistance(embedding, storedEmbedding);
  const matched = distance < FACE_MATCH_THRESHOLD;
  return {
    matched,
    confidence: matched ? Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD) : 0,
  };
}

/**
 * Check if an embedding matches a specific student
 */
export async function matchesFaceForStudent(
  studentId: string,
  embedding: FaceEmbedding
): Promise<{ matched: boolean; confidence: number }> {
  const storedEmbedding = await getFaceEmbeddingForStudent(studentId);
  if (!storedEmbedding) {
    return { matched: false, confidence: 0 };
  }
  const distance = euclideanDistance(embedding, storedEmbedding);
  const matched = distance < FACE_MATCH_THRESHOLD;
  return {
    matched,
    confidence: matched ? Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD) : 0,
  };
}
