/**
 * relationship-memory-schema.ts
 *
 * Memory field definitions for Relationship_* fields with database operations.
 * These fields store user-student relationship data in the userStudent's chatMemory column.
 *
 * Fields included:
 * - Relationship_Notes: Session notes about the user-student relationship
 */

import { db } from "../../db";
import { eq, and } from "drizzle-orm";
import { userStudents } from "@shared/schema";
import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldArrayWithDB,
  type AgentMemoryFieldObjectWithDB,
  type DBOperationContext,
} from "../chat/memory-types";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Gets the userStudent's chatMemory field value by field ID
 */
async function getRelationshipMemoryField(
  ctx: DBOperationContext,
  fieldId: string
): Promise<any> {
  const userId = ctx.all.userId;
  const studentId = ctx.all.studentId;

  if (!userId || !studentId) {
    console.warn(`[relationship-memory-schema] Missing userId or studentId for ${fieldId}`);
    return undefined;
  }

  const [relationship] = await db
    .select({ chatMemory: userStudents.chatMemory })
    .from(userStudents)
    .where(
      and(
        eq(userStudents.userId, userId),
        eq(userStudents.studentId, studentId),
        eq(userStudents.isActive, true)
      )
    );

  if (!relationship) {
    console.warn(`[relationship-memory-schema] Relationship not found for user ${userId} and student ${studentId}`);
    return undefined;
  }

  const memory = (relationship.chatMemory as Record<string, any>) || {};
  return memory[fieldId];
}

/**
 * Updates the userStudent's chatMemory field value by field ID
 */
async function setRelationshipMemoryField(
  ctx: DBOperationContext,
  fieldId: string,
  value: any
): Promise<any> {
  const userId = ctx.all.userId;
  const studentId = ctx.all.studentId;

  if (!userId || !studentId) {
    throw new Error(`Cannot write to ${fieldId}: missing userId or studentId in context`);
  }

  // Get current relationship
  const [relationship] = await db
    .select({ id: userStudents.id, chatMemory: userStudents.chatMemory })
    .from(userStudents)
    .where(
      and(
        eq(userStudents.userId, userId),
        eq(userStudents.studentId, studentId),
        eq(userStudents.isActive, true)
      )
    );

  if (!relationship) {
    throw new Error(`Relationship not found for user ${userId} and student ${studentId}`);
  }

  // Update the specific field in chatMemory
  const currentMemory = (relationship.chatMemory as Record<string, any>) || {};
  const updatedMemory = { ...currentMemory, [fieldId]: value };

  // Save back to database
  await db
    .update(userStudents)
    .set({ chatMemory: updatedMemory, updatedAt: new Date() })
    .where(eq(userStudents.id, relationship.id));

  return value;
}

// ============================================================================
// RELATIONSHIP MEMORY FIELDS WITH DB OPERATIONS
// ============================================================================

/**
 * Relationship_Notes - Session notes about the user-student relationship
 */
export const RELATIONSHIP_NOTES_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Relationship_Notes",
  type: "array",
  title: "Session Notes",
  description: "General notes about sessions with this student (non-sensitive)",
  opened: false,
  items: {
    id: "Note",
    type: "object",
    properties: {
      Date: { id: "Date", type: "string", format: "date" },
      Content: { id: "Content", type: "string" },
    },
  } as AgentMemoryFieldObjectWithDB,
  db: {
    read: async (ctx) => getRelationshipMemoryField(ctx, "Relationship_Notes"),
    write: async (ctx, value) => setRelationshipMemoryField(ctx, "Relationship_Notes", value),
  },
};

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * All Relationship_* memory fields with database operations
 */
export const RELATIONSHIP_MEMORY_FIELDS: AgentMemoryFieldWithDB[] = [
  RELATIONSHIP_NOTES_FIELD,
];

/**
 * Get relationship memory fields
 */
export function getRelationshipMemoryFields(): AgentMemoryFieldWithDB[] {
  return RELATIONSHIP_MEMORY_FIELDS;
}
