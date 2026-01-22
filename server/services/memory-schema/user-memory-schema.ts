/**
 * user-memory-schema.ts
 *
 * Memory field definitions for User_* fields with database operations.
 * These fields store user preferences in the user's chatMemory column.
 *
 * Fields included:
 * - User_AiPersonalityPreferences: How the AI should communicate
 * - User_Language: Preferred language for communication
 */

import { db } from "../../db";
import { eq } from "drizzle-orm";
import { users } from "@shared/schema";
import {
  type AgentMemoryFieldWithDB,
  type DBOperationContext,
} from "../chat/memory-types";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Gets a user's chatMemory field value by field ID
 */
async function getUserMemoryField(
  ctx: DBOperationContext,
  fieldId: string
): Promise<any> {
  const userId = ctx.all.userId;
  if (!userId) {
    console.warn(`[user-memory-schema] No userId in context for ${fieldId}`);
    return undefined;
  }

  const [user] = await db
    .select({ chatMemory: users.chatMemory })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    console.warn(`[user-memory-schema] User not found: ${userId}`);
    return undefined;
  }

  const memory = (user.chatMemory as Record<string, any>) || {};
  return memory[fieldId];
}

/**
 * Updates a user's chatMemory field value by field ID
 */
async function setUserMemoryField(
  ctx: DBOperationContext,
  fieldId: string,
  value: any
): Promise<any> {
  const userId = ctx.all.userId;
  if (!userId) {
    throw new Error(`Cannot write to ${fieldId}: no userId in context`);
  }

  // Get current chatMemory
  const [user] = await db
    .select({ chatMemory: users.chatMemory })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  // Update the specific field in chatMemory
  const currentMemory = (user.chatMemory as Record<string, any>) || {};
  const updatedMemory = { ...currentMemory, [fieldId]: value };

  // Save back to database
  await db
    .update(users)
    .set({ chatMemory: updatedMemory, updatedAt: new Date() })
    .where(eq(users.id, userId));

  return value;
}

// ============================================================================
// USER MEMORY FIELDS WITH DB OPERATIONS
// ============================================================================

/**
 * User_AiPersonalityPreferences - How the AI should communicate
 */
export const USER_AI_PERSONALITY_PREFERENCES_FIELD: AgentMemoryFieldWithDB = {
  id: "User_AiPersonalityPreferences",
  type: "string",
  title: "AI Personality Preferences",
  description: "User's preferences for how the AI should communicate (tone, style, etc.)",
  opened: true,
  db: {
    read: async (ctx) => getUserMemoryField(ctx, "User_AiPersonalityPreferences"),
    write: async (ctx, value) => setUserMemoryField(ctx, "User_AiPersonalityPreferences", value),
  },
};

/**
 * User_Language - Preferred language for communication
 */
export const USER_LANGUAGE_FIELD: AgentMemoryFieldWithDB = {
  id: "User_Language",
  type: "string",
  title: "Preferred Language",
  description: "User's preferred language for communication",
  opened: true,
  db: {
    read: async (ctx) => getUserMemoryField(ctx, "User_Language"),
    write: async (ctx, value) => setUserMemoryField(ctx, "User_Language", value),
  },
};

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * All User_* memory fields with database operations
 */
export const USER_MEMORY_FIELDS: AgentMemoryFieldWithDB[] = [
  USER_AI_PERSONALITY_PREFERENCES_FIELD,
  USER_LANGUAGE_FIELD,
];

/**
 * Get user memory fields
 */
export function getUserMemoryFields(): AgentMemoryFieldWithDB[] {
  return USER_MEMORY_FIELDS;
}
