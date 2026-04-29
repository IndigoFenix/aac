/**
 * student-memory-schema.ts
 *
 * Memory field definitions for Student_* fields with database operations.
 * These fields store non-sensitive student information in the student's chatMemory column.
 *
 * Fields included:
 * - Student_People: Important people in the student's life
 * - Student_Interests: Things the student enjoys
 * - Student_CommunicationStyle: How the student communicates
 * - Student_Preferences: Activity and reward preferences
 * - Student_Notes: General non-sensitive notes
 */

import { db } from "../../db";
import { eq } from "drizzle-orm";
import { students } from "@shared/schema";
import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldArrayWithDB,
  type AgentMemoryFieldObjectWithDB,
  type DBOperationContext,
} from "../chat/memory-types";
import type { AccessCtx } from "../sharing/visibility";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Gets a student's chatMemory field value by field ID.
 * This is the only operation that reads from the DB — used for initial loading
 * via populateMemoryFromDB. All mutations are handled in-memory first, then
 * persisted as a batch by onUpdateMemoryValues in sessionService.
 */
async function getStudentMemoryField(
  ctx: DBOperationContext,
  fieldId: string
): Promise<any> {
  const studentId = ctx.all.studentId;
  if (!studentId) {
    console.warn(`[student-memory-schema] No studentId in context for ${fieldId}`);
    return undefined;
  }

  // Fail-closed when the visibility ctx is missing. The schema-layer gate
  // (sessionService) only filters Student_* fields out for institute
  // principals lacking a monitor_note share; with accessCtx=undefined that
  // gate silently no-ops, so without this defense-in-depth check anyone with
  // a studentId — but no resolved institute or student principal — could
  // dump chatMemory (Student_Notes, Student_People, etc.) by hitting the
  // chat API with the studentId in the body.
  const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
  if (!accessCtx) {
    console.warn(`[student-memory-schema] No accessCtx for ${fieldId} on student ${studentId} — refusing read`);
    return undefined;
  }
  // For student principals, only the bound student is readable — defense
  // against any future code path that lets the AI vary studentId per call.
  if (accessCtx.kind === "student" && accessCtx.studentId !== studentId) {
    console.warn(`[student-memory-schema] Student ctx mismatch (${accessCtx.studentId} vs ${studentId}) — refusing read`);
    return undefined;
  }

  const [student] = await db
    .select({ chatMemory: students.chatMemory })
    .from(students)
    .where(eq(students.id, studentId));

  if (!student) {
    console.warn(`[student-memory-schema] Student not found: ${studentId}`);
    return undefined;
  }

  const memory = (student.chatMemory as Record<string, any>) || {};
  return memory[fieldId];
}

// ── Write-back no-ops ──────────────────────────────────────────────────────
// Individual mutations do NOT write to the DB. The in-memory processor handles
// all mutations synchronously (no race conditions), and onUpdateMemoryValues
// in sessionService persists the final state as a single atomic write.
// This eliminates race conditions when parallel tool calls modify the same fields.

/** No-op: returns value immediately. Persistence handled by onUpdateMemoryValues. */
async function setStudentMemoryField(
  _ctx: DBOperationContext,
  _fieldId: string,
  value: any
): Promise<any> {
  return value;
}

/** No-op: returns value immediately. Persistence handled by onUpdateMemoryValues. */
async function addToStudentMemoryArray(
  _ctx: DBOperationContext,
  _fieldId: string,
  value: any
): Promise<any> {
  return value;
}

/** No-op: persistence handled by onUpdateMemoryValues. */
async function deleteFromStudentMemoryArray(
  _ctx: DBOperationContext,
  _fieldId: string,
  _indexOrKey: string | number
): Promise<void> {
  // No-op
}

/** No-op: persistence handled by onUpdateMemoryValues. */
async function clearStudentMemoryArray(
  _ctx: DBOperationContext,
  _fieldId: string
): Promise<void> {
  // No-op
}

// ============================================================================
// STUDENT MEMORY FIELDS WITH DB OPERATIONS
// ============================================================================

/**
 * Student_People - Important people in the student's life
 */
export const STUDENT_PEOPLE_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Student_People",
  type: "array",
  title: "People",
  description: "Important people in the student's life (names and relationships only)",
  opened: true,
  items: {
    id: "Person",
    type: "object",
    properties: {
      Name: {
        id: "Name",
        type: "string",
        title: "Name",
        description: "Person's name",
      },
      Relationship: {
        id: "Relationship",
        type: "string",
        title: "Relationship",
        description: "Relationship to the student (e.g., mother, teacher, friend)",
      },
    },
    required: ["Name"],
  } as AgentMemoryFieldObjectWithDB,
  db: {
    read: async (ctx) => getStudentMemoryField(ctx, "Student_People"),
    write: async (ctx, value) => setStudentMemoryField(ctx, "Student_People", value),
    add: async (ctx, value) => addToStudentMemoryArray(ctx, "Student_People", value),
    delete: async (ctx, indexOrKey) => deleteFromStudentMemoryArray(ctx, "Student_People", indexOrKey),
    clear: async (ctx) => clearStudentMemoryArray(ctx, "Student_People"),
  },
};

/**
 * Student_Interests - Things the student enjoys
 */
export const STUDENT_INTERESTS_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Student_Interests",
  type: "array",
  title: "Interests",
  description: "Things the student enjoys or is interested in",
  opened: true,
  items: {
    id: "Interest",
    type: "string",
  } as AgentMemoryFieldWithDB,
  db: {
    read: async (ctx) => getStudentMemoryField(ctx, "Student_Interests"),
    write: async (ctx, value) => setStudentMemoryField(ctx, "Student_Interests", value),
    add: async (ctx, value) => addToStudentMemoryArray(ctx, "Student_Interests", value),
    delete: async (ctx, indexOrKey) => deleteFromStudentMemoryArray(ctx, "Student_Interests", indexOrKey),
    clear: async (ctx) => clearStudentMemoryArray(ctx, "Student_Interests"),
  },
};

/**
 * Student_CommunicationStyle - How the student communicates
 */
export const STUDENT_COMMUNICATION_STYLE_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Student_CommunicationStyle",
  type: "object",
  title: "Communication Style",
  description: "How the student communicates (method only, not detailed abilities)",
  opened: true,
  properties: {
    PrimaryMethod: {
      id: "PrimaryMethod",
      type: "string",
      title: "Primary Method",
      description: "verbal, nonverbal, AAC, or mixed",
    },
    PreferredModality: {
      id: "PreferredModality",
      type: "string",
      title: "Preferred Modality",
      description: "If AAC, which type (symbols, text, combined)",
    },
  },
  db: {
    read: async (ctx) => getStudentMemoryField(ctx, "Student_CommunicationStyle"),
    write: async (ctx, value) => setStudentMemoryField(ctx, "Student_CommunicationStyle", value),
  },
};

/**
 * Student_Preferences - Activity and reward preferences
 */
export const STUDENT_PREFERENCES_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Student_Preferences",
  type: "object",
  title: "Preferences",
  description: "Student's preferences for activities, rewards, and engagement",
  opened: true,
  properties: {
    FavoriteActivities: {
      id: "FavoriteActivities",
      type: "array",
      title: "Favorite Activities",
      items: { id: "Activity", type: "string" },
    } as AgentMemoryFieldArrayWithDB,
    RewardPreferences: {
      id: "RewardPreferences",
      type: "array",
      title: "Reward Preferences",
      items: { id: "Reward", type: "string" },
    } as AgentMemoryFieldArrayWithDB,
    AvoidTopics: {
      id: "AvoidTopics",
      type: "array",
      title: "Topics to Avoid",
      description: "Topics that should be avoided in conversation",
      items: { id: "Topic", type: "string" },
    } as AgentMemoryFieldArrayWithDB,
  },
  db: {
    read: async (ctx) => getStudentMemoryField(ctx, "Student_Preferences"),
    write: async (ctx, value) => setStudentMemoryField(ctx, "Student_Preferences", value),
  },
};

/**
 * Student_Notes - General non-sensitive notes
 */
export const STUDENT_NOTES_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Student_Notes",
  type: "array",
  title: "General Notes",
  description: "General notes about the student (non-sensitive)",
  opened: true,
  items: {
    id: "Note",
    type: "string",
  } as AgentMemoryFieldWithDB,
  db: {
    read: async (ctx) => getStudentMemoryField(ctx, "Student_Notes"),
    write: async (ctx, value) => setStudentMemoryField(ctx, "Student_Notes", value),
    add: async (ctx, value) => addToStudentMemoryArray(ctx, "Student_Notes", value),
    delete: async (ctx, indexOrKey) => deleteFromStudentMemoryArray(ctx, "Student_Notes", indexOrKey),
    clear: async (ctx) => clearStudentMemoryArray(ctx, "Student_Notes"),
  },
};

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * All Student_* memory fields with database operations
 */
import { STUDENT_CUSTOM_APPS_FIELD } from "./student-custom-apps-schema";

export const STUDENT_MEMORY_FIELDS: AgentMemoryFieldWithDB[] = [
  STUDENT_PEOPLE_FIELD,
  STUDENT_INTERESTS_FIELD,
  STUDENT_COMMUNICATION_STYLE_FIELD,
  STUDENT_PREFERENCES_FIELD,
  STUDENT_NOTES_FIELD,
  STUDENT_CUSTOM_APPS_FIELD,
];

/**
 * Subset of `Student_*` fields backed by `students.chatMemory` — i.e. the
 * fields populated by the AAC monitor agent during sessions. These are the
 * "monitor notes" governed by the `monitor_note` standing-share type:
 * exposed to the clinician AI only when the share grants it, hidden from the
 * schema entirely otherwise (so the AI doesn't even know they exist).
 *
 * Excludes `Student_CustomApps`, which is backed by the assignments table and
 * governed by `custom_app_assignment` access.
 */
export const STUDENT_CHAT_MEMORY_FIELD_IDS: ReadonlySet<string> = new Set([
  "Student_People",
  "Student_Interests",
  "Student_CommunicationStyle",
  "Student_Preferences",
  "Student_Notes",
]);

/**
 * Get student memory fields
 */
export function getStudentMemoryFields(): AgentMemoryFieldWithDB[] {
  return STUDENT_MEMORY_FIELDS;
}
