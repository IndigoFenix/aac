// server/services/biometric/voice-service.ts
// Voice recognition service for generating and comparing voice embeddings (speaker identification)

import { db } from "../../db";
import { users, students } from "@shared/schema";
import { eq, isNotNull } from "drizzle-orm";

// Voice embeddings typically range from 128-512 dimensions depending on the model
export type VoiceEmbedding = number[];

// Cosine similarity threshold for voice matching (higher = stricter)
const VOICE_MATCH_THRESHOLD = 0.75;

/**
 * Calculate cosine similarity between two embeddings
 * Returns a value between -1 and 1, where 1 is identical
 */
function cosineSimilarity(a: VoiceEmbedding, b: VoiceEmbedding): number {
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

/**
 * Store voice embedding for a user
 */
export async function storeVoiceEmbeddingForUser(
  userId: string,
  embedding: VoiceEmbedding
): Promise<void> {
  await db.update(users)
    .set({ voiceEmbedding: embedding })
    .where(eq(users.id, userId));
}

/**
 * Store voice embedding for a student
 */
export async function storeVoiceEmbeddingForStudent(
  studentId: string,
  embedding: VoiceEmbedding
): Promise<void> {
  await db.update(students)
    .set({ voiceEmbedding: embedding })
    .where(eq(students.id, studentId));
}

/**
 * Get voice embedding for a user
 */
export async function getVoiceEmbeddingForUser(userId: string): Promise<VoiceEmbedding | null> {
  const [user] = await db.select({ voiceEmbedding: users.voiceEmbedding })
    .from(users)
    .where(eq(users.id, userId));
  return user?.voiceEmbedding as VoiceEmbedding | null;
}

/**
 * Get voice embedding for a student
 */
export async function getVoiceEmbeddingForStudent(studentId: string): Promise<VoiceEmbedding | null> {
  const [student] = await db.select({ voiceEmbedding: students.voiceEmbedding })
    .from(students)
    .where(eq(students.id, studentId));
  return student?.voiceEmbedding as VoiceEmbedding | null;
}

/**
 * Remove voice embedding for a user
 */
export async function removeVoiceEmbeddingForUser(userId: string): Promise<void> {
  await db.update(users)
    .set({ voiceEmbedding: null })
    .where(eq(users.id, userId));
}

/**
 * Remove voice embedding for a student
 */
export async function removeVoiceEmbeddingForStudent(studentId: string): Promise<void> {
  await db.update(students)
    .set({ voiceEmbedding: null })
    .where(eq(students.id, studentId));
}

export interface VoiceMatchResult {
  matched: boolean;
  entityType: "student" | "user";
  entityId: string;
  name: string;
  similarity: number;
  confidence: number;
}

/**
 * Find matching voice from stored embeddings
 * Returns the best match if found, or null if no match
 */
export async function findMatchingVoice(
  embedding: VoiceEmbedding,
  studentId?: string
): Promise<VoiceMatchResult | null> {
  // Get the student's embedding first (most likely match)
  if (studentId) {
    const [student] = await db.select({
      id: students.id,
      name: students.name,
      voiceEmbedding: students.voiceEmbedding,
    })
      .from(students)
      .where(eq(students.id, studentId));

    if (student?.voiceEmbedding) {
      const similarity = cosineSimilarity(embedding, student.voiceEmbedding as VoiceEmbedding);
      if (similarity > VOICE_MATCH_THRESHOLD) {
        return {
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

  // Get all users with voice embeddings
  const usersWithVoices = await db.select({
    id: users.id,
    firstName: users.firstName,
    lastName: users.lastName,
    voiceEmbedding: users.voiceEmbedding,
  })
    .from(users)
    .where(isNotNull(users.voiceEmbedding));

  // Get all students with voice embeddings
  const studentsWithVoices = await db.select({
    id: students.id,
    name: students.name,
    voiceEmbedding: students.voiceEmbedding,
  })
    .from(students)
    .where(isNotNull(students.voiceEmbedding));

  let bestMatch: VoiceMatchResult | null = null;
  let bestSimilarity = VOICE_MATCH_THRESHOLD;

  // Check users
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

  // Check students
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

/**
 * Check if an embedding matches a specific user
 */
export async function matchesVoiceForUser(
  userId: string,
  embedding: VoiceEmbedding
): Promise<{ matched: boolean; confidence: number }> {
  const storedEmbedding = await getVoiceEmbeddingForUser(userId);
  if (!storedEmbedding) {
    return { matched: false, confidence: 0 };
  }
  const similarity = cosineSimilarity(embedding, storedEmbedding);
  const matched = similarity > VOICE_MATCH_THRESHOLD;
  return {
    matched,
    confidence: matched ? (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD) : 0,
  };
}

/**
 * Check if an embedding matches a specific student
 */
export async function matchesVoiceForStudent(
  studentId: string,
  embedding: VoiceEmbedding
): Promise<{ matched: boolean; confidence: number }> {
  const storedEmbedding = await getVoiceEmbeddingForStudent(studentId);
  if (!storedEmbedding) {
    return { matched: false, confidence: 0 };
  }
  const similarity = cosineSimilarity(embedding, storedEmbedding);
  const matched = similarity > VOICE_MATCH_THRESHOLD;
  return {
    matched,
    confidence: matched ? (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD) : 0,
  };
}
