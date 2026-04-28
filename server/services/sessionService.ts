/**
 * Session Service
 * 
 * Handles chat session management for the AAC system.
 * 
 * Key features:
 * - Mode-based agent templates (chat, boards, interpret, docuslp)
 * - Memory stored on User, Student, and UserStudent objects
 * - Session-scoped context (Context_) for boards, documents, etc.
 * - Credits tracked per User, Student, and UserStudent
 */

import { db } from "../db";
import { eq, and, sql } from "drizzle-orm";
import { settingsRepository } from "../repositories/settingsRepository";
import type { UseCaseKey } from "@shared/llm-options";
import {
  users,
  students,
  userStudents,
  chatSessions,
  type User,
  type Student,
  type StudentWithAacSettings,
  aacSettings,
  type UserStudent,
  type ChatSession,
  type InsertChatSession,
  type ChatState,
  type ChatMessage,
  type FeatureType,
  type AgentMemoryField,
  type Topic,
  MessageResponse,
  BoardGrid,
  Institute,
  InstituteStudent,
  type Persona,
} from "@shared/schema";
import { personaRepository } from "../repositories/personaRepository";
import { ChatMessageManager, AgentTemplate, CurrentImage, MdStreamEvent } from "./chat/chat-handler";
import { AgentLike } from "./chat/prompt-kit";
import {
  ParsedBoardData,
  createFallbackBoard,
  createEmptyBoard,
} from "./board-utils";
import {
  ChatContextManager,
  createChatContextManager,
  injectChatContext,
  buildProgressSystemPrompt,
  AccessPermissions,
} from "./chat-context-integration";
import { buildSessionAccessCtx } from "./sharing/sessionCtx";
import { canAccessMonitorNotes } from "./sharing/visibility";
import { getConsentStatus } from "./consent/consentGate";
import { activityLogService } from "./activityLogService";
import { STUDENT_CHAT_MEMORY_FIELD_IDS } from "./memory-schema/student-memory-schema";
import {
  BOARD_SYSTEM_PROMPT,
  CUSTOM_APP_SYSTEM_PROMPT,
  getSystemPrompt,
} from "./system-prompts";
import { customSymbolRepository } from "../repositories/customSymbolRepository";
import { aacSettingsRepository } from "../repositories/aacSettingsRepository";
import { instituteRepository } from "../repositories/instituteRepository";
import { calendarRepository } from "../repositories/calendarRepository";
import { startOfDayInTimezone } from "../lib/timezone";
import { licenseService } from "./licenseService";
import type { LicensePermissions } from "@shared/license-permissions";
import { resolveImageKeys, queueSymbolGeneration } from "./symbol/auto-symbol-service";

/**
 * Resolve imageKeys on a Context_Board: look up existing symbols in DB,
 * queue generation via Gemini if the student has generateSymbols enabled.
 * Mutates board buttons in-place to set symbolPath.
 */
async function resolveImageKeysOnBoard(board: any, studentId?: string): Promise<void> {
  if (!board?.pages) {
    console.log(`[resolveImageKeysOnBoard] Skipped: no board pages`);
    return;
  }

  // Check student symbol settings — when no student, default to enabled
  let generateEnabled = false;
  let useSymbols = false;
  if (!studentId) {
    generateEnabled = true;
    useSymbols = true;
    console.log(`[resolveImageKeysOnBoard] No student — defaulting to generateSymbols=true, useUnapproved=true`);
  } else {
    try {
      const settings = await aacSettingsRepository.getByStudentId(studentId);
      generateEnabled = settings?.generateSymbols ?? false;
      useSymbols = generateEnabled || !!(settings?.useApprovedSymbols) || !!(settings?.useUnapprovedSymbols);
      console.log(`[resolveImageKeysOnBoard] Student ${studentId}: generateSymbols=${generateEnabled}, useSymbols=${useSymbols}`);
    } catch { /* ignore — treat as disabled */ }
  }

  // Collect buttons and coverImage (both use imageKey → symbolPath resolution)
  const allButtons = (board.pages as any[]).flatMap((p: any) => p.buttons || []);
  const imageItems: any[] = [...allButtons];
  if (board.coverImage?.imageKey && !board.coverImage?.symbolPath?.includes('/api/custom-symbols/')) {
    imageItems.push(board.coverImage);
  }
  const buttonsWithKeys = imageItems.filter((b: any) => b.imageKey && !b.symbolPath?.includes('/api/custom-symbols/'));
  if (buttonsWithKeys.length === 0) {
    console.log(`[resolveImageKeysOnBoard] No pending imageKeys found`);
    return;
  }

  console.log(`[resolveImageKeysOnBoard] ${buttonsWithKeys.length} buttons with unresolved imageKeys: ${buttonsWithKeys.map((b: any) => b.imageKey).join(", ")}`);

  // If no symbol features are enabled, strip imageKeys so client doesn't show spinners
  if (!useSymbols) {
    console.log(`[resolveImageKeysOnBoard] Symbol features disabled — stripping imageKeys`);
    for (const btn of buttonsWithKeys) { delete btn.imageKey; }
    return;
  }

  // Phase 1 (fast): DB lookups — resolve existing symbols immediately
  // Use unapproved symbols too since auto-generated symbols start as unapproved
  const unresolved = await resolveImageKeys(buttonsWithKeys, { useUnapproved: true });

  // Phase 2 (background): queue generation for missing symbols
  if (generateEnabled && unresolved.length > 0) {
    console.log(`[resolveImageKeysOnBoard] Queuing ${unresolved.length} for generation: ${unresolved.join(", ")}`);
    queueSymbolGeneration(unresolved);
  } else if (!generateEnabled && unresolved.length > 0) {
    console.log(`[resolveImageKeysOnBoard] Generation disabled — ${unresolved.length} keys will not be generated`);
  }

  // Strip imageKey from buttons that were resolved (no spinner needed) and
  // from unresolved buttons when generation is disabled (they'll never resolve)
  if (!generateEnabled) {
    for (const btn of buttonsWithKeys) {
      if (!btn.symbolPath) delete btn.imageKey;
    }
  }
}

import {
  createMemoryLoadState,
  deserializeLoadState,
  processMemoryToolWithDB,
  serializeLoadState,
  populateMemoryFromDB,
} from "./chat/memory-db-bridge";
import { AgentMemoryFieldWithDB } from "./chat/memory-types";
import { 
  createDBMemoryProcessor, 
  LoopDetectionConfig,
} from "./chat/tool-router";
import {
  AAC_DEFAULT_PERSONA_PROMPT,
  getAACMemoryFields,
} from "./memory-schema/aac-memory-schema";
import {
  LIBRARY_TOPICS_FIELD,
} from "./memory-schema/topic-memory-schema";
import {
  STUDENT_MEMORY_FIELDS,
} from "./memory-schema/student-memory-schema";
import {
  STUDENT_INCIDENTS_FIELD,
} from "./memory-schema/incident-memory-schema";
import {
  getAACSettingsMemoryFields,
} from "./memory-schema/aac-settings-memory-schema";
import {
  USER_MEMORY_FIELDS,
} from "./memory-schema/user-memory-schema";
import {
  RELATIONSHIP_MEMORY_FIELDS,
} from "./memory-schema/relationship-memory-schema";
import {
  STUDENT_CONTACTS_FIELD,
  STUDENT_LINKABLE_ENTITIES_FIELD,
} from "./memory-schema/contacts-memory-schema";


// ============================================================================
// LOOP DETECTION CONFIGURATION
// ============================================================================

/**
 * Loop detection rules for the CliniAACian system.
 * These can be customized based on the expected usage patterns.
 */
export const CLINIAACIAN_LOOP_DETECTION_CONFIG: LoopDetectionConfig = {
  /** 
   * Allow up to 3 identical sequence repetitions before breaking.
   * This gives the AI room for legitimate retries while catching infinite loops.
   */
  maxRepetitions: 3,
  
  /**
   * Track up to 100 recent tool calls for pattern detection.
   * This is enough to catch loops while not consuming too much memory.
   */
  maxHistorySize: 100,
  
  /**
   * Enable loop detection by default.
   */
  enabled: true,
};

// ============================================================================
// SERVER-SIDE BOARD CACHE
// ============================================================================
// Context_Board is in-memory-only (no DB persistence). It relies on the client
// sending board data back in featureContext.board.data on each request. This
// breaks when the user switches panels — the client may not have the board data
// ready (BoardSelector not mounted, or React render timing). This cache stores
// the last-known board per session so the server can restore it.

const boardCache = new Map<string, { board: any; timestamp: number }>();

/** Cache the board for a session. Skips empty/default boards. */
function cacheBoardForSession(sessionId: string | undefined, board: any): void {
  if (!sessionId || !board) return;
  // Only cache boards that have real content (not just "New Board" with empty pages)
  const hasContent = board.name !== "New Board" ||
    (board.pages?.length > 0 && board.pages.some((p: any) => p.buttons?.length > 0));
  if (hasContent) {
    boardCache.set(sessionId, { board, timestamp: Date.now() });
  }
}

/** Retrieve cached board for a session. Returns null if not found or expired (1hr). */
function getCachedBoard(sessionId: string | undefined): any | null {
  if (!sessionId) return null;
  const entry = boardCache.get(sessionId);
  if (!entry) return null;
  // Expire after 1 hour
  if (Date.now() - entry.timestamp > 3600_000) {
    boardCache.delete(sessionId);
    return null;
  }
  return entry.board;
}

// ============================================================================
// PERSONA HELPERS
// ============================================================================

/**
 * Process jurisdiction-specific placeholders in persona prompts.
 *
 * Placeholder format:
 * - {{US_ONLY: ...}} - Content only shown when framework is 'us_iep'
 * - {{IL_ONLY: ...}} - Content only shown when framework is 'tala' (Israel)
 *
 * If no framework is specified, both placeholders are removed.
 */
function processPersonaPrompt(prompt: string, framework: string | null): string {
  // Process {{US_ONLY: ...}} blocks
  const usOnlyRegex = /\{\{US_ONLY:\s*([\s\S]*?)\}\}/g;
  prompt = prompt.replace(usOnlyRegex, (_match, content) => {
    return framework === 'us_iep' ? content.trim() : '';
  });

  // Process {{IL_ONLY: ...}} blocks
  const ilOnlyRegex = /\{\{IL_ONLY:\s*([\s\S]*?)\}\}/g;
  prompt = prompt.replace(ilOnlyRegex, (_match, content) => {
    return framework === 'tala' ? content.trim() : '';
  });

  // Clean up any double newlines left behind
  prompt = prompt.replace(/\n{3,}/g, '\n\n');

  return prompt.trim();
}

/**
 * Build the system prompt by combining the general prompt with the persona prompt.
 */
interface PersonaPromptResult {
  prompt: string;
  persona: Awaited<ReturnType<typeof personaRepository.getPersonaById>> | null;
}

async function buildPersonaSystemPrompt(
  personaId: string | undefined,
  framework: string | null
): Promise<PersonaPromptResult> {
  // Get the base general prompt
  const basePrompt = getSystemPrompt('assistant', framework as 'us_iep' | 'tala' | null);

  // If no persona ID provided, just return the base prompt
  if (!personaId) {
    return { prompt: basePrompt, persona: null };
  }

  // Look up persona from database
  const persona = await personaRepository.getPersonaById(personaId);

  // If persona not found or inactive, fall back to base prompt
  if (!persona || !persona.active) {
    console.log(`[buildPersonaSystemPrompt] Persona not found or inactive: ${personaId}, using base prompt`);
    return { prompt: basePrompt, persona: null };
  }

  // Process jurisdiction placeholders in the persona prompt
  const processedPersonaPrompt = processPersonaPrompt(persona.prompt, framework);

  // Combine base prompt with persona-specific prompt
  if (processedPersonaPrompt) {
    // Resolve multilingual title to English for AI system prompts
    const { resolveLocalizedText } = await import("@shared/localized-text");
    const resolvedTitle = resolveLocalizedText(persona.title, 'en');
    return { prompt: `${basePrompt}\n\n=== Persona: ${resolvedTitle} ===\n${processedPersonaPrompt}`, persona };
  }

  return { prompt: basePrompt, persona };
}

async function buildAACPersonaSystemPrompt(
  student: Student | StudentWithAacSettings,
  framework: string | null
): Promise<string> {
  // Get the base general prompt for AAC
  let prompt = `=== Guidelines for interacting with ${student.name} ===\n`;
  const chatAgentPrompt = (student as StudentWithAacSettings).aacSettings?.chatAgentPrompt;
  if (chatAgentPrompt && chatAgentPrompt.trim().length > 0) {
    prompt += processPersonaPrompt(chatAgentPrompt, framework);
  } else {
    prompt += AAC_DEFAULT_PERSONA_PROMPT;
  }
  return prompt;
}
// ============================================================================
// AGENT TEMPLATES (Mode-based, stored locally)
// ============================================================================

interface LocalAgentTemplate extends AgentLike {
  intelligence: number;
  memory: number;
  memoryFields: AgentMemoryField[];
}

/**
 * Memory fields that are populated from User, Student, and UserStudent
 * These are FLAT top-level fields - the memory system requires arrays/maps to be at root level
 *
 * PRIVACY COMPLIANCE:
 * - NO medical diagnoses
 * - NO disability classifications
 * - NO behavioral/psychological notes
 * - NO insurance or financial info
 * - NO detailed evaluation data
 *
 * NOTE: These fields now have db.read/db.write operations for lazy loading from database.
 * See the memory-schema files for implementation details:
 * - student-memory-schema.ts: Student_* fields
 * - user-memory-schema.ts: User_* fields
 * - relationship-memory-schema.ts: Relationship_* fields
 */
export const MASTER_MEMORY_FIELDS: AgentMemoryFieldWithDB[] = [
  // User_* fields with db operations
  ...USER_MEMORY_FIELDS,
  // Student_* fields with db operations
  ...STUDENT_MEMORY_FIELDS,
  // Student_Contacts — backed by the studentContacts table (not chatMemory)
  STUDENT_CONTACTS_FIELD,
  // Student_Incidents — backed by the incidents table
  STUDENT_INCIDENTS_FIELD,
  // Read-only list of linkable users/students (shared-institute scope)
  STUDENT_LINKABLE_ENTITIES_FIELD,
  // Relationship_* fields with db operations
  ...RELATIONSHIP_MEMORY_FIELDS,
];

/**
 * Fields that have been REMOVED for privacy compliance:
 * 
 * REMOVED: Student_Milestones
 * - Reason: Could contain developmental/medical milestone information
 * - Alternative: Use the Goals system in the IEP/TALA program
 * 
 * REMOVED: Student_People.Notes
 * - Reason: Could contain sensitive information about family situations
 * - Alternative: Keep notes in secure Records section
 * 
 * NOT ADDED: Student_MedicalInfo
 * - Reason: Medical information must stay in medicalRecords table
 * - Alternative: Access through Records API with proper authorization
 * 
 * NOT ADDED: Student_Diagnosis
 * - Reason: HIPAA/FERPA protected information
 * - Alternative: Access through Records API with proper authorization
 * 
 * NOT ADDED: Student_BehavioralNotes
 * - Reason: Sensitive behavioral/psychological information
 * - Alternative: Use functionalReports with proper access control
 */

/**
 * Sensitive field patterns that should NEVER be added to AI memory
 */
export const SENSITIVE_FIELD_PATTERNS = [
  /diagnosis/i,
  /medication/i,
  /allergy/i,
  /medical/i,
  /disability/i,
  /classification/i,
  /behavioral.*history/i,
  /psychiatric/i,
  /psychological/i,
  /health.*condition/i,
  /insurance/i,
  /ssn/i,
  /social.*security/i,
  /custody/i,
  /abuse/i,
  /neglect/i,
  /restraint/i,
  /incident/i,
  /hospitalization/i,
];

/**
 * Check if a field ID contains sensitive information
 */
export function isSensitiveFieldId(fieldId: string): boolean {
  return false; // Temporarily disable sensitive field filtering
  // return SENSITIVE_FIELD_PATTERNS.some(pattern => pattern.test(fieldId));
}

/**
 * Filter memory values to remove any sensitive data that might have been
 * accidentally included
 */
export function filterSensitiveMemoryValues(
  values: Record<string, any>
): Record<string, any> {
  const filtered: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(values)) {
    // Skip sensitive keys
    if (isSensitiveFieldId(key)) {
      console.warn(`[Privacy] Filtered sensitive field from AI memory: ${key}`);
      continue;
    }
    
    // Recursively filter objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      filtered[key] = filterSensitiveMemoryValues(value);
    } else {
      filtered[key] = value;
    }
  }
  
  return filtered;
}


// ============================================================================
// CONTEXT MEMORY FIELDS (Session-scoped, not persisted to DB)
// ============================================================================

/**
 * Board memory field schema for AAC communication boards
 * Single nested structure - pages contain buttons
 */
const BOARD_MEMORY_FIELD: AgentMemoryField = {
  id: "Context_Board",
  type: "object",
  title: "Communication Board",
  description: "The AAC communication board. View pages to see their buttons.",
  opened: true,
  properties: {
    name: {
      id: "name",
      type: "string",
      title: "Board Name",
    },
    grid: {
      id: "grid",
      type: "object",
      title: "Grid Size",
      properties: {
        rows: { id: "rows", type: "integer", title: "Rows" },
        cols: { id: "cols", type: "integer", title: "Columns" },
      },
      required: ["rows", "cols"],
    },
    currentPageId: {
      id: "currentPageId",
      type: "string",
      title: "Current Page ID",
    },
    automaticSelectionHint: {
      id: "automaticSelectionHint",
      type: "string",
      title: "Auto-Selection Hint",
      description: "When the AI should automatically select this board (e.g. 'During mealtimes')",
    },
    pages: {
      id: "pages",
      type: "array",
      title: "Pages",
      opened: true,
      items: {
        id: "page",
        type: "object",
        properties: {
          id: { id: "id", type: "string", title: "Page ID" },
          name: { id: "name", type: "string", title: "Page Name" },
          buttons: {
            id: "buttons",
            type: "array",
            title: "Buttons",
            items: {
              id: "button",
              type: "object",
              properties: {
                id: { id: "id", type: "string", title: "Button ID" },
                row: { id: "row", type: "integer", title: "Row" },
                col: { id: "col", type: "integer", title: "Column" },
                label: { id: "label", type: "string", title: "Label" },
                spokenText: { id: "spokenText", type: "string", title: "Spoken Text" },
                color: { id: "color", type: "string", title: "Color" },
                iconRef: { id: "iconRef", type: "string", title: "Icon" },
                symbolPath: { id: "symbolPath", type: "string", title: "Symbol Path" },
                rebusKey: { id: "rebusKey", type: "string", title: "Rebus Key", description: "Widgit Rebus concept name for Grid3 export (e.g. happy, mum, ice cream)" },
                imageKey: { id: "imageKey", type: "string", title: "Image Key", description: "Unambiguous English key for auto-generated symbol images (e.g. drinking_water, play_activity)" },
                selfClosing: { id: "selfClosing", type: "boolean", title: "Self Closing" },
                action: {
                  id: "action",
                  type: "object",
                  title: "Action",
                  properties: {
                    type: { id: "type", type: "string", title: "Type" },
                    text: { id: "text", type: "string", title: "Text" },
                    toPageId: { id: "toPageId", type: "string", title: "Target Page" },
                  },
                  required: ["type"],
                },
              },
              required: ["id", "row", "col", "label"],
            },
          },
        },
        required: ["id", "name", "buttons"],
      },
    },
  },
  required: ["name", "grid", "pages"],
} as AgentMemoryField;

/**
 * Custom app (game) memory field. Holds the full game definition while
 * the AI is authoring / editing it. Not persisted to DB via memory — the
 * clinician saves via the app builder UI (POST /api/custom-apps).
 *
 * Top-level shape is kept loose; the detailed schema is enforced by
 * shared/custom-app-validator.ts when saving, and described in
 * CUSTOM_APP_SYSTEM_PROMPT for the AI.
 */
const CUSTOM_APP_MEMORY_FIELD: AgentMemoryField = {
  id: "Context_CustomApp",
  type: "object",
  title: "Custom App (Game)",
  description: "The game / custom app being authored or edited.",
  opened: true,
  properties: {
    type: { id: "type", type: "string", title: "App Type" },
    label: { id: "label", type: "string", title: "Name" },
    description: { id: "description", type: "string", title: "Description" },
    iconRef: { id: "iconRef", type: "string", title: "Icon (emoji)" },
    imageKey: { id: "imageKey", type: "string", title: "Image Key" },
    symbolPath: { id: "symbolPath", type: "string", title: "Symbol Path" },
    aiInstructions: { id: "aiInstructions", type: "string", title: "AI Instructions" },
    turnBased: { id: "turnBased", type: "boolean", title: "Turn-based" },
    startRoom: { id: "startRoom", type: "string", title: "Starting Room" },
    classes: {
      id: "classes",
      type: "array",
      title: "Classes",
      items: { id: "class", type: "object", title: "Class" },
    },
    buttons: {
      id: "buttons",
      type: "array",
      title: "Buttons",
      items: { id: "button", type: "object", title: "Button" },
    },
    rooms: {
      id: "rooms",
      type: "array",
      title: "Rooms",
      items: { id: "room", type: "object", title: "Room" },
    },
  },
  required: ["type", "label", "classes", "buttons", "rooms", "startRoom"],
} as unknown as AgentMemoryField;

// ============================================================================
// AGENT TEMPLATES
// ============================================================================

const AGENT_TEMPLATE_BASE: LocalAgentTemplate = {
  name: "CliniAACian Assistant",
  corePrompt: `You are CliniAACian, a helpful AI assistant for AAC (Augmentative and Alternative Communication) professionals and caregivers.`,
  greeting: "Hello! I'm CliniAACian, your AAC assistant. How can I help you today?",
  intelligence: 2,
  memory: 2,
  memoryFields: [...MASTER_MEMORY_FIELDS],
  tools: {
    mediaAnalysis: { enabled: true },
    fdaLookup: { enabled: true },
  },
  library: [],
}

const AAC_TEMPLATE_BASE: LocalAgentTemplate = {
  name: "CliniAACian AAC Assistant",
  corePrompt: '', // Built dynamically based on student persona or default AAC prompt
  greeting: "Hello! I'm CliniAACian, your AAC communication assistant. How can I support you today?",
  intelligence: 2,
  memory: 2,
  memoryFields: [...MASTER_MEMORY_FIELDS],
  tools: {},
  library: [],
}

// ============================================================================
// MEMORY CONTEXT
// ============================================================================

interface MemoryContext {
  user?: User;
  student?: StudentWithAacSettings;
  userStudent?: UserStudent;
  institute?: Institute;
  instituteUser?: { id: string };
}

// Memory values are stored flat with prefixed keys
// e.g., { "User_AiPersonalityPreferences": "...", "Student_Interests": [...], "Context_Board": {...} }
type FlatMemoryValues = Record<string, any>;

// Prefixes for memory field ownership
const MEMORY_PREFIX = {
  USER: "User_",
  STUDENT: "Student_",
  RELATIONSHIP: "Relationship_",
  CONTEXT: "Context_", // Session-scoped context (not persisted to DB)
};


/**
 * Build memory values from context, filtering sensitive data
 */
function buildMemoryValues(context: MemoryContext): FlatMemoryValues {
  const values: FlatMemoryValues = {};
  
  // Load User memory values (prefixed with User_)
  if (context.user) {
    const userMemory = (context.user.chatMemory as Record<string, any>) || {};
    for (const [key, value] of Object.entries(userMemory)) {
      const prefixedKey = key.startsWith(MEMORY_PREFIX.USER) ? key : `${MEMORY_PREFIX.USER}${key}`;
      
      // Skip sensitive fields
      if (isSensitiveFieldId(prefixedKey)) continue;
      
      values[prefixedKey] = value;
    }
  }
  
  // Load Student memory values (prefixed with Student_)
  if (context.student) {
    const studentMemory = (context.student.chatMemory as Record<string, any>) || {};
    for (const [key, value] of Object.entries(studentMemory)) {
      const prefixedKey = key.startsWith(MEMORY_PREFIX.STUDENT) ? key : `${MEMORY_PREFIX.STUDENT}${key}`;
      
      // Skip sensitive fields
      if (isSensitiveFieldId(prefixedKey)) continue;
      
      values[prefixedKey] = value;
    }
  }
  
  // Load UserStudent relationship memory values (prefixed with Relationship_)
  if (context.userStudent) {
    const relationshipMemory = (context.userStudent.chatMemory as Record<string, any>) || {};
    for (const [key, value] of Object.entries(relationshipMemory)) {
      const prefixedKey = key.startsWith(MEMORY_PREFIX.RELATIONSHIP) ? key : `${MEMORY_PREFIX.RELATIONSHIP}${key}`;
      
      // Skip sensitive fields
      if (isSensitiveFieldId(prefixedKey)) continue;
      
      values[prefixedKey] = value;
    }
  }
  
  // Note: Context_ fields are NOT loaded from DB - they are injected per-request
  
  return values;
}

// Extract memory values for a specific entity based on prefix
function extractMemoryForEntity(
  allValues: FlatMemoryValues, 
  prefix: string
): Record<string, any> {
  const entityMemory: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(allValues)) {
    if (key.startsWith(prefix)) {
      // Store with the full prefixed key to maintain consistency
      entityMemory[key] = value;
    }
  }
  
  return entityMemory;
}

// ============================================================================
// MODE CONTEXT TYPES
// ============================================================================

/**
 * Context data that can be passed for specific modes
 * This is session-scoped and injected into memoryValues
 */
export interface FeatureContext {
  /** Board context for "boards" mode */
  board?: {
    data: ParsedBoardData;
    currentPageId?: string;
    requestedGridSize?: BoardGrid;
  };
  
  /** Document context for future document editing modes */
  document?: {
    data: any;
    documentId?: string;
  };

  /** Progress mode context for IEP/TALA management */
  progress?: {
    programId?: string;  // Optional specific program ID
  };
  
  // Future mode contexts can be added here
}

// ============================================================================
// DATABASE HELPERS
// ============================================================================

async function getUser(userId: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user || undefined;
}

async function getStudent(studentId: string): Promise<StudentWithAacSettings | undefined> {
  const rows = await db
    .select({ student: students, aac: aacSettings })
    .from(students)
    .leftJoin(aacSettings, eq(students.id, aacSettings.studentId))
    .where(eq(students.id, studentId));
  if (!rows.length) return undefined;
  const { student, aac } = rows[0];
  return { ...student, aacSettings: aac };
}

async function getUserStudent(userId: string, studentId: string): Promise<UserStudent | undefined> {
  const [relationship] = await db
    .select()
    .from(userStudents)
    .where(and(
      eq(userStudents.userId, userId),
      eq(userStudents.studentId, studentId),
      eq(userStudents.isActive, true)
    ));
  return relationship || undefined;
}

async function getSession(sessionId: string): Promise<ChatSession | undefined> {
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  return session || undefined;
}

async function createSession(data: InsertChatSession): Promise<ChatSession> {
  const [session] = await db.insert(chatSessions).values(data).returning();
  return session;
}

async function updateSession(
  sessionId: string, 
  updates: Partial<InsertChatSession>
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));
}

async function updateUserMemory(userId: string, memory: Record<string, any>): Promise<void> {
  await db
    .update(users)
    .set({ chatMemory: memory, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

async function updateStudentMemory(studentId: string, memory: Record<string, any>): Promise<void> {
  await db
    .update(students)
    .set({ chatMemory: memory, updatedAt: new Date() })
    .where(eq(students.id, studentId));
}

async function updateUserStudentMemory(id: string, memory: Record<string, any>): Promise<void> {
  await db
    .update(userStudents)
    .set({ chatMemory: memory, updatedAt: new Date() })
    .where(eq(userStudents.id, id));
}

async function spendCredits(
  context: MemoryContext,
  creditsUsed: number
): Promise<void> {
  // Spend credits proportionally or from primary source
  // For now, we track on each entity that exists
  if (context.user) {
    await db
      .update(users)
      .set({
        chatCreditsUsed: sql`${users.chatCreditsUsed} + ${creditsUsed}`,
        chatCreditsUpdated: new Date(),
      })
      .where(eq(users.id, context.user.id));
  }
  if (context.student) {
    await db
      .update(students)
      .set({
        chatCreditsUsed: sql`${students.chatCreditsUsed} + ${creditsUsed}`,
        chatCreditsUpdated: new Date(),
      })
      .where(eq(students.id, context.student.id));
  }
  if (context.userStudent) {
    await db
      .update(userStudents)
      .set({
        chatCreditsUsed: sql`${userStudents.chatCreditsUsed} + ${creditsUsed}`,
        chatCreditsUpdated: new Date(),
      })
      .where(eq(userStudents.id, context.userStudent.id));
  }
}

// ============================================================================
// MESSAGE MANAGER FACTORY
// ============================================================================

interface GetMessageManagerInput {
  userId?: string;
  studentId?: string;
  instituteId?: string;
  sessionId?: string;
  feature?: FeatureType;
  /** Persona ID (UUID) from the personas table, or undefined for default */
  persona?: string;
  featureContext?: FeatureContext;
  onThinkingUpdate?: (thinkingText: string) => void;
  onNavigate?: (feature: string) => void;
  onSelectStudent?: (studentId: string) => void;
  onFilesNeeded?: (files: Array<{ fileId: string; filename: string }>) => void;
  vectorStoreId?: string;
  /** Base64 data URLs for inline images */
  images?: string[];
  /** Attached documents (base64 data URLs with filenames, optionally pre-extracted text) */
  documents?: Array<{ dataUrl: string; filename: string; extractedText?: string }>;
  /** Image to include with the current request (not stored in history) */
  currentImage?: CurrentImage;
  /** Override the system prompt instead of building it from persona/student settings */
  systemPromptOverride?: string;
  /** IANA timezone of the requesting user (for AI prompt context and "today" windows). */
  timezone?: string;
}

interface GetMessageManagerResult {
  manager: ChatMessageManager;
  memoryValues: FlatMemoryValues;
}

/**
 * Load calendar events that the AI should be aware of at conversation start.
 * Returns a list of flagged events with priority/urgency metadata.
 */
async function loadFlaggedCalendarEvents(
  userId: string,
  instituteId?: string,
  timezone?: string,
): Promise<any[]> {
  const now = new Date();
  // Compute "today" boundaries in the requesting user's zone when supplied.
  // Without a zone the server's local time is used, which produces a wrong
  // window for users whose local day differs from the server's.
  const todayStart = timezone
    ? startOfDayInTimezone(timezone, now)
    : (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; })();
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  const yesterday = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

  const threeDaysOut = new Date(todayStart.getTime() + 4 * 24 * 60 * 60 * 1000 - 1);

  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

  // Fetch events in the window via the plan's visibility rules.
  const { calendarService } = await import("./calendarService");
  const rawEvents = await calendarService.getEventsForUser(userId, yesterday, threeDaysOut, {
    selectedInstituteId: instituteId,
  });

  // Expand recurring events into concrete occurrences
  const expanded = calendarRepository.expandRecurringEvents(rawEvents, yesterday, threeDaysOut);

  const flagged: any[] = [];
  const seen = new Set<string>(); // dedupe by event id + date

  for (const { event: ev, date: occurrenceDate } of expanded) {
    const dedupeKey = `${ev.id}:${occurrenceDate.toDateString()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Calculate the occurrence's actual time span
    const evStart = new Date(ev.startTime);
    const duration = new Date(ev.endTime).getTime() - evStart.getTime();
    const occStart = new Date(occurrenceDate);
    occStart.setHours(evStart.getHours(), evStart.getMinutes(), evStart.getSeconds());
    const occEnd = new Date(occStart.getTime() + duration);
    const isRepeating = ev.repeatType !== 'none';

    if (isRepeating) {
      // Repeating: flag if this occurrence is within ±1 hour of now
      const isWithinHour = occStart <= oneHourFromNow && occEnd >= oneHourAgo;
      if (isWithinHour) {
        const isNow = occStart <= now && occEnd >= now;
        flagged.push({
          id: ev.id,
          title: ev.title,
          description: ev.description,
          occurrenceDate: occurrenceDate.toISOString(),
          startTime: occStart.toISOString(),
          endTime: occEnd.toISOString(),
          repeatType: ev.repeatType,
          flag: isNow ? 'happening_now' : (occStart > now ? 'starting_soon' : 'just_ended'),
          opened: true,
        });
      }
    } else {
      // Non-repeating: categorize by date
      const isToday = occStart >= todayStart && occStart <= todayEnd;
      const isYesterday = occStart >= yesterday && occStart < todayStart;
      const isUpcoming = occStart > todayEnd && occStart <= threeDaysOut;

      if (isToday) {
        const isNow = occStart <= now && occEnd >= now;
        flagged.push({
          id: ev.id,
          title: ev.title,
          description: ev.description,
          occurrenceDate: occurrenceDate.toISOString(),
          startTime: occStart.toISOString(),
          endTime: occEnd.toISOString(),
          flag: isNow ? 'happening_now' : (occStart > now ? 'later_today' : 'earlier_today'),
          opened: true,
        });
      } else if (isYesterday) {
        flagged.push({
          id: ev.id,
          title: ev.title,
          description: ev.description,
          occurrenceDate: occurrenceDate.toISOString(),
          startTime: occStart.toISOString(),
          endTime: occEnd.toISOString(),
          flag: 'yesterday',
          opened: false,
        });
      } else if (isUpcoming) {
        flagged.push({
          id: ev.id,
          title: ev.title,
          description: ev.description,
          occurrenceDate: occurrenceDate.toISOString(),
          startTime: occStart.toISOString(),
          endTime: occEnd.toISOString(),
          flag: 'upcoming_3_days',
          opened: false,
        });
      }
    }
  }

  return flagged;
}

/**
 * Build a system-prompt addendum describing the student's consent-gate state.
 * The AI uses this to know up-front whether PHI write operations will be
 * blocked, so it can explain blocked tool calls to the user without confusion.
 *
 * Returns null when there's nothing meaningful to say (gate off and no
 * legacy-grace context — i.e. the AI has nothing to caveat).
 */
function formatConsentStatusForPrompt(
  consent: import("./consent/consentGate").ConsentStatus,
): string | null {
  if (!consent.gateEnabled) return null; // gate off → no caveat needed

  const header = "[CONSENT STATUS — informed-consent gate]";
  if (consent.hasActiveConsent) {
    return `${header}\nThis student has an active informed-consent record on file. PHI operations are permitted.`;
  }
  if (consent.inLegacyGrace) {
    const until = consent.legacyConsentDeadline?.split("T")[0] ?? "soon";
    return `${header}\nThis student does not yet have an informed-consent record but is in a legacy grace window through ${until}. PHI operations are still permitted today, but the record needs to be collected before the deadline. If the user asks about consent or progress on signing, mention this.`;
  }
  return `${header}\nThis student has no active informed-consent record. PHI write operations (creating/finalizing reports, sharing records, recording incidents, starting AAC sessions) WILL FAIL with a "consent_required" error until a guardian completes the consent wizard for this student. If a tool call fails for that reason, calmly explain to the user that the student is in consent-pending state and direct them to the "Sign consent" button on the Student Info panel.`;
}

async function getMessageManager(input: GetMessageManagerInput): Promise<GetMessageManagerResult> {
  const { userId, studentId, instituteId, sessionId, featureContext, persona, feature = "chat", onThinkingUpdate, onNavigate, onSelectStudent, onFilesNeeded } = input;
  const isAACFeature = (feature === 'aac');

  // Validate input - at least one identifier must be provided
  if (!userId && !studentId && !sessionId) {
    throw { status: 400, message: "Must provide userId, studentId, or sessionId" };
  }

  // Build memory context
  const context: MemoryContext = {};
  
  if (userId) {
    context.user = await getUser(userId);
    if (!context.user) {
      throw { status: 404, message: `User not found: ${userId}` };
    }
  }
  
  if (studentId) {
    context.student = await getStudent(studentId);
    if (!context.student) {
      throw { status: 404, message: `student not found: ${studentId}` };
    }
  }
  
  // If both user and student provided, get their relationship
  if (userId && studentId) {
    context.userStudent = await getUserStudent(userId, studentId);
    // Relationship is optional - they might not have one yet
  }

  // Load selected institute if provided
  if (instituteId) {
    context.institute = await instituteRepository.getInstituteById(instituteId);
  }

  // Resolve the user's membership record for this institute, used for subject-scoped
  // session keying (each (user, institute) pair is a distinct subject).
  if (userId && instituteId) {
    const link = await instituteRepository.getInstituteUserLink(instituteId, userId);
    if (link) context.instituteUser = { id: link.id };
  }

  if (isAACFeature && !context.student) {
    throw { status: 400, message: "AAC feature requires a valid studentId" };
  }

  // Get or create session
  let session: ChatSession | undefined;
  let chatState: ChatState;
  let log: ChatMessage[] = [];

  const template: LocalAgentTemplate = {
    ...(isAACFeature ? AAC_TEMPLATE_BASE : AGENT_TEMPLATE_BASE),
    memoryFields: [...(isAACFeature ? AAC_TEMPLATE_BASE : AGENT_TEMPLATE_BASE).memoryFields],
  };
  // Select core prompt based on conversation persona (loaded from database)
  let personaResult: PersonaPromptResult = { prompt: '', persona: null };
  if (isAACFeature) {
    if (input.systemPromptOverride) {
      template.corePrompt = input.systemPromptOverride;
    } else {
      template.corePrompt = await buildAACPersonaSystemPrompt(context.student!, context?.student?.framework || null);
    }
  } else {
    personaResult = await buildPersonaSystemPrompt(persona, context?.student?.framework || null);
    template.corePrompt = personaResult.prompt;
  }
  
  // Static prompt mode: system prompt shows only schema, data lives in tool responses.
  // Enable via STATIC_MEMORY_PROMPT=true env var. Defaults to dynamic (current behavior).
  const useStaticMemoryPrompt = process.env.STATIC_MEMORY_PROMPT === 'true';

  const newChatState: ChatState = {
    history: [],
    memoryState: { visible: [], page: {}, staticPromptMode: useStaticMemoryPrompt || undefined },
    conversationSummary: "",
    openedTopics: [],
  };
  chatState = newChatState;

  if (sessionId) {
    const existing = await getSession(sessionId);
    if (!existing) {
      throw { status: 404, message: "Session not found" };
    }

    const reqIds = {
      userId: userId ?? null,
      studentId: studentId ?? null,
      instituteId: instituteId ?? null,
      instituteUserId: context.instituteUser?.id ?? null,
      userStudentId: context.userStudent?.id ?? null,
    };
    const sesIds = {
      userId: existing.userId,
      studentId: existing.studentId,
      instituteId: existing.instituteId ?? null,
      instituteUserId: existing.instituteUserId ?? null,
      userStudentId: existing.userStudentId,
    };

    // Ownership: if the session has a userId, it must match the caller.
    // Legacy/null-userId sessions are owned by whoever picks them up.
    const ownershipMismatch = sesIds.userId != null && reqIds.userId != null && sesIds.userId !== reqIds.userId;

    // Switch: session and request both have a value for the field, and they differ.
    // null→value is not a switch (it's a fill-in, handled below).
    const isSwitch = (a: string | null, b: string | null) => a != null && b != null && a !== b;
    const subjectSwitch =
      isSwitch(sesIds.studentId, reqIds.studentId) ||
      isSwitch(sesIds.instituteId, reqIds.instituteId) ||
      isSwitch(sesIds.instituteUserId, reqIds.instituteUserId);

    if (ownershipMismatch || subjectSwitch) {
      console.warn(
        `[sessionService] ${ownershipMismatch ? "ownership-mismatch" : "subject-switch"} on session ${sessionId} — opening new session`,
        { reqIds, sesIds }
      );
      // Fall through to new-session creation below.
      session = undefined;
    } else {
      // Reuse. Fill in any subject fields the session is missing but the request provides.
      const updates: Partial<InsertChatSession> = {};
      if (sesIds.userId == null && reqIds.userId != null) updates.userId = reqIds.userId;
      if (sesIds.studentId == null && reqIds.studentId != null) updates.studentId = reqIds.studentId;
      if (sesIds.instituteId == null && reqIds.instituteId != null) updates.instituteId = reqIds.instituteId;
      if (sesIds.instituteUserId == null && reqIds.instituteUserId != null) updates.instituteUserId = reqIds.instituteUserId;
      if (sesIds.userStudentId == null && reqIds.userStudentId != null) updates.userStudentId = reqIds.userStudentId;
      if (Object.keys(updates).length > 0) {
        await updateSession(existing.id, updates);
        Object.assign(existing, updates);
      }
      session = existing;
      chatState = (session.state as ChatState) || newChatState;
      log = (session.log as ChatMessage[]) || [];
    }
  }

  if (!session) {
    session = await createSession({
      userId: userId || null,
      studentId: studentId || null,
      userStudentId: context.userStudent?.id || null,
      instituteId: instituteId || null,
      instituteUserId: context.instituteUser?.id || null,
      chatMode: feature,
      state: chatState,
      log: [],
      last: [],
      started: new Date(),
      lastUpdate: new Date(),
      creditsUsed: 0,
    });
  }

  // === Progress Mode Setup ===
  let chatContextManager: ChatContextManager | undefined;
  let contextMemoryFields: AgentMemoryFieldWithDB[] = [];

  let accessPermissions: AccessPermissions = {
    medical: 'hidden',
    functional: 'hidden',
    educational: 'hidden',
  };

  // Fetch license permissions based on the selected institute
  // AAC mode is governed by student aacSettings, not institute licenses
  let licensePerms: LicensePermissions | undefined;
  if (context.user && !isAACFeature) {
    licensePerms = await licenseService.getInstitutePermissions(
      context.institute?.id,
      context.user.isSystemAdmin ?? false
    );
  }

  // Deserialize existing load state from chatState if available
  // Note: May be the cause of some bugs. If issues arise, consider setting it to undefined.
  const existingLoadState = chatState.loadStateCache ? deserializeLoadState(chatState.loadStateCache) : undefined;

  // For AAC mode, reports are accessed via read-only Context_* fields (loaded separately)
  // so we keep report permissions hidden to avoid creating duplicate Context_Reports
  if (context.student && !isAACFeature) {
    // Determine report permissions based on user rights
    // Family institutes grant full access to all members
    const isFamilyInstitute = context.institute?.type === 'family';
    const hasMedicalRights = isFamilyInstitute || (context.userStudent?.hasMedicalRights ?? false);
    const hasEducationalRights = isFamilyInstitute || (context.userStudent?.hasEducationalRights ?? false);

    // License must also grant dashboard access for reports to be visible
    const licenseDashboard = licensePerms?.dashboardLevel ?? 0;
    const licenseAllowsReports = licenseDashboard !== 0;

    const canEdit = true; // For now, assume edit rights if they have any access

    // Convert rights to permissions — both user-student rights AND license must allow
    accessPermissions.medical = (hasMedicalRights && licenseAllowsReports) ? (canEdit ? 'editable' : 'readonly') : 'hidden';
    accessPermissions.functional = (hasEducationalRights && licenseAllowsReports) ? (canEdit ? 'editable' : 'readonly') : 'hidden';
    accessPermissions.educational = (hasEducationalRights && licenseAllowsReports) ? (canEdit ? 'editable' : 'readonly') : 'hidden';
  }

  // Build the AccessCtx the AI's DB ops will use for cross-institute filtering.
  // Mirrors buildClinicianCtx for HTTP controllers — see planning-docs/cross-
  // institute-sharing-plan.md ("AI access" section).
  const accessCtx = await buildSessionAccessCtx({
    userId: context.user?.id,
    studentId: context.student?.id,
    instituteId: context.institute?.id,
    isAACFeature,
    isSystemAdmin: context.user?.isSystemAdmin ?? false,
  });

  // Gate the AAC-observed `Student_*` chat-memory fields behind monitor_note
  // access. When a clinician (institute principal) lacks the share, drop those
  // field definitions entirely so the AI never sees that surface — `Student_*`
  // chat memory and AAC-recorded incidents (the latter handled at the
  // visibility predicate via withIncidentVisibility). AAC mode (student
  // principal) and admins always see chat memory.
  //
  // When the share IS granted, log a `view` of the monitor-note dataset for
  // this student. The audit subject is the student (chat memory is keyed to
  // students.chatMemory) — one event per session-init records "this institute
  // had AAC-observed access for student Y at time T", which is the HIPAA-grade
  // shape. Per-field-access logging would be too noisy and isn't needed at
  // this granularity.
  let masterFieldsForClinician = MASTER_MEMORY_FIELDS;
  if (!isAACFeature && context.student && accessCtx?.kind === "institute") {
    const allowMonitorNotes = await canAccessMonitorNotes(accessCtx, context.student.id);
    if (!allowMonitorNotes) {
      masterFieldsForClinician = MASTER_MEMORY_FIELDS.filter(
        (f) => !STUDENT_CHAT_MEMORY_FIELD_IDS.has(f.id),
      );
    } else {
      activityLogService.log({
        userId: accessCtx.userId,
        instituteId: accessCtx.instituteId,
        eventType: "view",
        subjectType1: "monitor_note",
        subjectId1: context.student.id,
        subjectType2: "student",
        subjectId2: context.student.id,
        details: { viaShare: true, dataset: "chatMemory" },
      });
    }
  }

  // Create the unified manager
  // For AAC mode, we don't use chatContextManager.getMemoryFields(), so pass empty array
  // For other modes, pass the (possibly monitor_note-filtered) field list
  chatContextManager = await createChatContextManager(
    context.student?.id,
    context.user?.id,
    featureContext?.progress?.programId,
    isAACFeature ? [] : masterFieldsForClinician,
    existingLoadState,
    context.institute?.id, // instituteId for medical records filtering
    accessPermissions,
    licensePerms,
    input.timezone,
    accessCtx,
  );
    
  // Build memory fields based on mode
  const hasStudent = !!context.student;

  if (isAACFeature) {
    // === AAC Mode Setup ===
    // AAC mode uses: Student_* fields + Library + AAC-specific context fields
    // Board updates use formSchema/setValues for single-pass responses (not memory system)
    // It does NOT use User_*, Relationship_*, institute, progress, or reports fields
    console.log('[getMessageManager] AAC mode - building memory fields');

    // Privacy options from AAC settings
    const aacPrivacy = (context.student as any)?.aacSettings;

    // Filter to only Student_* fields (not User_* or Relationship_*)
    let studentFields = MASTER_MEMORY_FIELDS.filter(f => f.id.startsWith('Student_'));
    if (aacPrivacy?.allowNotes === false) {
      studentFields = studentFields.filter(f => f.id !== 'Student_Notes');
    }
    contextMemoryFields.push(...studentFields);

    // Add library field (Context_Library)
    contextMemoryFields.push(LIBRARY_TOPICS_FIELD as AgentMemoryFieldWithDB);

    // Note: BOARD_MEMORY_FIELD is NOT added for AAC - board uses formSchema/setValues instead

    // Add AAC-specific read-only context fields (gated by privacy settings)
    const aacFields = getAACMemoryFields({
      allowReadProgress: aacPrivacy?.allowReadProgress ?? true,
      allowReadReports: aacPrivacy?.allowReadReports ?? true,
    });
    contextMemoryFields.push(...aacFields);

    // Add AAC settings fields (writable — AI can modify settings)
    contextMemoryFields.push(...getAACSettingsMemoryFields());
    console.log('[getMessageManager] AAC mode - added', studentFields.length, 'Student fields +', aacFields.length, 'AAC context fields + AAC settings fields');
  } else {
    // Non-AAC modes use chatContextManager fields (includes institute, library, progress, reports)
    contextMemoryFields.push(...chatContextManager.getMemoryFields());

    // Add AAC settings fields when a student is selected (so clinician can modify settings via chat)
    if (hasStudent) {
      contextMemoryFields.push(...getAACSettingsMemoryFields());
    }

    // Add progress system prompt
    const additionalPrompt = buildProgressSystemPrompt(accessPermissions, hasStudent, context.institute?.language);
    template.corePrompt = template.corePrompt + additionalPrompt;

    // === Board Mode Setup ===
    if (feature === 'boards') {
      if (featureContext?.board) {
        let boardPrompt = BOARD_SYSTEM_PROMPT;

        // Load custom symbols for the student and include in prompt
        if (studentId) {
          try {
            const symbols = await customSymbolRepository.getAvailableSymbolsForStudent(studentId);
            if (symbols.length > 0) {
              const symbolList = symbols.map(s => {
                const parts = [s.key || s.id];
                if (s.description) parts.push(`— ${s.description}`);
                return `- ${parts.join(' ')} (ID: ${s.id})`;
              }).join('\n');
              boardPrompt += `\n\n## Custom Symbols

Custom image symbols are available for this student's buttons. Set the \`symbolPath\` field to \`/api/custom-symbols/SYMBOL_ID/image\` to use a custom symbol instead of an emoji.
Prefer custom symbols over emojis when the symbol clearly represents the concept.

Available symbols:
${symbolList}

Example button with custom symbol:
\`\`\`
{ id: "btn-1", row: 0, col: 0, label: "Water", spokenText: "I want water", color: "#3B82F6", iconRef: "💧", symbolPath: "/api/custom-symbols/${symbols[0].id}/image", action: { type: "speak", text: "I want water" } }
\`\`\``;
              console.log(`[getMessageManager] Board mode — loaded ${symbols.length} custom symbols for student ${studentId}`);
            }
          } catch (err) {
            console.warn('[getMessageManager] Failed to load custom symbols:', err);
          }
        }

        template.corePrompt = `${template.corePrompt}\n${boardPrompt}`;
      }

      // Add BOARD_MEMORY_FIELD to contextMemoryFields for prompt rendering
      contextMemoryFields.push(BOARD_MEMORY_FIELD as AgentMemoryFieldWithDB);
    }

    // === Custom Apps (Games) Mode Setup ===
    if (feature === 'customApps') {
      template.corePrompt = `${template.corePrompt}\n${CUSTOM_APP_SYSTEM_PROMPT}`;
      contextMemoryFields.push(CUSTOM_APP_MEMORY_FIELD as AgentMemoryFieldWithDB);
    }
  }
  template.memoryFields = contextMemoryFields as AgentMemoryField[];

  // Build memory values from context
  let memoryValues = buildMemoryValues(context);
  console.log('[DEBUG] After buildMemoryValues:');
  console.log('  - context.student?.chatMemory:', JSON.stringify(context.student?.chatMemory));
  console.log('  - memoryValues keys:', Object.keys(memoryValues));
  console.log('  - memoryValues:', JSON.stringify(memoryValues, null, 2));

  // For AAC mode, pre-load Student_* fields that have opened: true
  // This ensures the AI sees the actual data instead of stale/empty values
  if (isAACFeature && context.student) {
    console.log('[getMessageManager] AAC mode - loading Student_* fields from database');

    // Get loadState to track what we load
    const loadState = chatContextManager?.getLoadState() ?? createMemoryLoadState();

    // Pre-load Student_* fields that are marked as opened
    const studentFields = STUDENT_MEMORY_FIELDS.filter(f => f.opened);
    if (studentFields.length > 0) {
      try {
        const populateResult = await populateMemoryFromDB(
          studentFields,
          memoryValues,
          chatState.memoryState,
          loadState,
          {
            baseContext: { studentId: context.student.id, userId: context.user?.id },
            defaultLimit: 50,
            forceRefresh: false,
          }
        );
        console.log('[getMessageManager] AAC mode - loaded paths:', populateResult.loadedPaths);
        if (populateResult.errors.length > 0) {
          console.warn('[getMessageManager] AAC mode - load errors:', populateResult.errors);
        }
      } catch (error) {
        console.error('[getMessageManager] AAC mode - failed to load Student_* fields:', error);
      }
    }
  }

  // For non-AAC modes, load program data from database via chatContextManager
  // AAC mode uses lazy loading via db.read functions in the memory fields
  if (!isAACFeature) {
      console.log('[DEBUG] Non-AAC mode - calling injectChatContext');
      console.log('  - studentId:', context.student?.id);
      console.log('  - baseContext:', chatContextManager.getBaseContext());

      const populateResult = await injectChatContext(
        memoryValues,
        chatState.memoryState,
        chatContextManager
      );
      memoryValues = populateResult;

      console.log('[DEBUG] After injectChatContext:');
      console.log('  - memoryValues keys:', Object.keys(memoryValues));
      console.log('  - Context_Program:', memoryValues['Context_Program']);
  }

  console.log('[getMessageManager] Initial memory values:', memoryValues);

  // Inject mode-specific context into memory values
  injectModeContext(memoryValues, feature, featureContext, sessionId);



  // Inject flagged calendar events so the AI is aware of important upcoming/recent events
  if (!isAACFeature && licensePerms?.calendar && context.user) {
    try {
      const flagged = await loadFlaggedCalendarEvents(context.user.id, context.institute?.id, input.timezone);
      if (flagged.length > 0) {
        memoryValues["Context_CalendarAlerts"] = flagged;
      }
    } catch (err) {
      console.warn('[getMessageManager] Failed to load calendar alerts:', err);
    }
  }

  // Create callbacks
  const onUpdateMemoryValues = async (newMemoryValues: FlatMemoryValues) => {
    // Extract and save memory values to the appropriate database objects based on prefix
    // Note: Context_ fields are NOT persisted - they live only in the session
    
    // User memory (fields prefixed with User_)
    if (context.user) {
      const userMemory = extractMemoryForEntity(newMemoryValues, MEMORY_PREFIX.USER);
      const currentMemory = (context.user.chatMemory as Record<string, any>) || {};
      if (Object.keys(userMemory).length > 0 && JSON.stringify(currentMemory) !== JSON.stringify(userMemory)) {
        await updateUserMemory(context.user.id, userMemory);
        context.user = { ...context.user, chatMemory: userMemory };
      }
    }
    
    // Student memory (fields prefixed with Student_)
    if (context.student) {
      const studentMemory = extractMemoryForEntity(newMemoryValues, MEMORY_PREFIX.STUDENT);
      const currentMemory = (context.student.chatMemory as Record<string, any>) || {};
      if (Object.keys(studentMemory).length > 0 && JSON.stringify(currentMemory) !== JSON.stringify(studentMemory)) {
        await updateStudentMemory(context.student.id, studentMemory);
        context.student = { ...context.student, chatMemory: studentMemory };
      }
    }
    
    // UserStudent relationship memory (fields prefixed with Relationship_)
    if (context.userStudent) {
      const relationshipMemory = extractMemoryForEntity(newMemoryValues, MEMORY_PREFIX.RELATIONSHIP);
      const currentMemory = (context.userStudent.chatMemory as Record<string, any>) || {};
      if (Object.keys(relationshipMemory).length > 0 && JSON.stringify(currentMemory) !== JSON.stringify(relationshipMemory)) {
        await updateUserStudentMemory(context.userStudent.id, relationshipMemory);
        context.userStudent = { ...context.userStudent, chatMemory: relationshipMemory };
      }
    }
    
    // Context_ fields are NOT persisted to DB - they are returned in the response
    // for the frontend to handle
  };

  const enrichCorePrompt = (context: MemoryContext, corePrompt: string, isAACFeature: boolean) => {
    // Add any additional instructions or context to the core prompt if needed
    let prefix = "";
    prefix = `Current datetime: ${new Date().toISOString()}\n`;
    if (isAACFeature) {
      prefix += `You are speaking with the student.\n`;
    } else {
      if (context.user) {
        if (context.student) {
          if (context.userStudent) {
            prefix += `You are speaking with ${context.user.fullName}, who is a ${context.userStudent.role} for the student.\n`;
          } else {
            prefix += `You are speaking with ${context.user.fullName}, who is connected to the student.\n`;
          }
        } else {
          prefix += `You are speaking with ${context.user.fullName}.\n`;
        }
      }
    }
    if (chatContextManager){
      prefix += chatContextManager.getStudentInfo();
      prefix += chatContextManager.getProgramSummary();
    }
    return `${corePrompt}\n${prefix}`;
  }

  const onUpdateChatState = async (state: ChatState, newLog?: ChatMessage[]) => {
    if (!session) return;

    if (chatContextManager) {
      state.loadStateCache = serializeLoadState(chatContextManager.getLoadState());
    }
    
    const update: Partial<InsertChatSession> = {
      state,
      lastUpdate: new Date(),
    };
    
    if (newLog) {
      update.log = newLog;
      // Build "last" - the last two messages with content
      const last: ChatMessage[] = [];
      for (let i = newLog.length - 1; i >= 0; i--) {
        const msg = newLog[i];
        if (msg.content && (msg.role === "user" || msg.role === "assistant")) {
          last.unshift({
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
          });
        }
        if (last.length >= 2) break;
      }
      update.last = last;
    }
    
    await updateSession(session.id, update);
  };

  const onCreditsUsed = async (creditsUsed: number) => {
    await spendCredits(context, creditsUsed);
    if (session) {
      await db
        .update(chatSessions)
        .set({
          creditsUsed: sql`${chatSessions.creditsUsed} + ${creditsUsed}`,
          lastUpdate: new Date(),
        })
        .where(eq(chatSessions.id, session.id));
    }
  };

  // Surface consent-gate status to the AI so it doesn't get confused when
  // PHI tool calls fail with "consent_required". Only injects something
  // when there's a student in scope and the gate is on the path of blocking.
  if (context.student?.id) {
    try {
      const consent = await getConsentStatus(context.student.id);
      const note = formatConsentStatusForPrompt(consent);
      if (note) template.corePrompt = `${template.corePrompt}\n\n${note}`;
    } catch (err) {
      console.warn('[getMessageManager] Failed to load consent status for prompt:', err);
    }
  }

  template.corePrompt = enrichCorePrompt(context, template.corePrompt, isAACFeature);

  console.log('[getMessageManager] Final template:', template);

  // Build agent-like object from template for ChatMessageManager
  const agentFromTemplate: AgentTemplate = {
    id: `template-${feature}`,
    accountId: context.user?.id || context.student?.id || "system",
    name: template.name,
    corePrompt: template.corePrompt,
    greeting: template.greeting,
    intelligence: template.intelligence,
    memory: template.memory,
    memoryFields: template.memoryFields,
    tools: template.tools || {},
    library: template.library || [],
    apiEndpoints: [],
    validSources: [],
    securityKeys: [],
    public: false,
    creditsUsed: 0,
    updatedCredits: new Date(),
    creditsTotal: 100000,
    creditsRegen: 100000,
    instanceCreditsTotal: 100000,
    instanceCreditsRegen: 1,
    deletedAt: null,
    delegatePolicies: [],
    display: {},
  };

  // Calculate max credits (simplified - use user credits if available)
  const maxCredits = context.user?.credits || 10000;

  // Create the memory processor
  const loadStateRef = { current: chatContextManager.getLoadState() };

  // Build fields for the memory processor based on mode
  let fieldsForProcessor: AgentMemoryFieldWithDB[];

  if (isAACFeature) {
    // AAC mode: Student_* fields + Library + AAC context fields
    // Note: BOARD_MEMORY_FIELD is disabled for AAC - board updates use formSchema/setValues instead
    // for faster single-pass responses
    const aacPrivacy2 = (context.student as any)?.aacSettings;
    let studentFieldsProc = MASTER_MEMORY_FIELDS.filter(f => f.id.startsWith('Student_'));
    if (aacPrivacy2?.allowNotes === false) {
      studentFieldsProc = studentFieldsProc.filter(f => f.id !== 'Student_Notes');
    }
    fieldsForProcessor = [
      ...studentFieldsProc,
      LIBRARY_TOPICS_FIELD as AgentMemoryFieldWithDB,
      // BOARD_MEMORY_FIELD disabled - using formSchema/setValues for board updates
      ...getAACMemoryFields({
        allowReadProgress: aacPrivacy2?.allowReadProgress ?? true,
        allowReadReports: aacPrivacy2?.allowReadReports ?? true,
      }),
      ...getAACSettingsMemoryFields(),
    ];
  } else {
    // Non-AAC modes: use chatContextManager fields (includes institute, library, progress, reports)
    fieldsForProcessor = chatContextManager.getMemoryFields();
    if (hasStudent) {
      fieldsForProcessor = [...fieldsForProcessor, ...getAACSettingsMemoryFields()];
    }

    // Add BOARD_MEMORY_FIELD for boards mode
    if (feature === 'boards') {
      fieldsForProcessor = [...fieldsForProcessor, BOARD_MEMORY_FIELD as AgentMemoryFieldWithDB];
    }
    if (feature === 'customApps') {
      fieldsForProcessor = [...fieldsForProcessor, CUSTOM_APP_MEMORY_FIELD as AgentMemoryFieldWithDB];
    }
  }

  const memoryProcessor = createDBMemoryProcessor(
    processMemoryToolWithDB,
    fieldsForProcessor,
    { current: memoryValues },
    { current: chatState.memoryState },
    loadStateRef,
    chatContextManager.getBaseContext()
  );

  // Fetch LLM provider config from DB for this use case
  const llmUseCase: UseCaseKey = isAACFeature ? 'aac_moderator' : 'clinician';
  let llmConfig = await settingsRepository.getLLMConfig(llmUseCase);

  // Per-persona LLM override (non-AAC only)
  if (!isAACFeature && personaResult.persona?.llmProvider && personaResult.persona?.llmModel) {
    llmConfig = {
      provider: personaResult.persona.llmProvider as any,
      model: personaResult.persona.llmModel,
    };
  }

  const messageManager = new ChatMessageManager({
    agent: agentFromTemplate,
    session: session as any,
    memoryValues,
    chatState,
    log,
    maxCredits,
    onUpdateMemoryValues,
    onUpdateChatState,
    onCreditsUsed,
    onThinkingUpdate,
    onNavigate: !isAACFeature ? onNavigate : undefined,
    onSelectStudent: !isAACFeature ? onSelectStudent : undefined,
    onFilesNeeded,
    memoryProcessor,
    vectorStoreId: input.vectorStoreId,
    images: input.images,
    documents: input.documents,
    loopDetectionConfig: CLINIAACIAN_LOOP_DETECTION_CONFIG,
    currentImage: input.currentImage,
    providerConfig: llmConfig,
    timezone: input.timezone,
  });


  // Return both manager and memoryValues reference
  // The memoryValues object is passed by reference, so changes made by the memory system
  // will be reflected in this object
  return { manager: messageManager, memoryValues };
}

// ============================================================================
// MODE CONTEXT INJECTION
// ============================================================================

/**
 * Inject mode-specific context into memory values
 */
function injectModeContext(
  memoryValues: FlatMemoryValues,
  feature: FeatureType,
  featureContext?: FeatureContext,
  sessionId?: string
): void {
  console.log('[injectModeContext] Called with mode:', feature, 'featureContext:', !!featureContext);

  // Board context for "boards" or "aac" mode
  if ((feature === "boards" || feature === "aac") && featureContext?.board) {
    const { data, currentPageId, requestedGridSize } = featureContext.board;

    console.log('[injectModeContext] Board mode - data:', !!data, 'currentPageId:', currentPageId, 'requestedGridSize:', requestedGridSize);

    if (data) {
      // Use existing board data, optionally override currentPageId
      memoryValues["Context_Board"] = {
        ...data,
        currentPageId: currentPageId || data.currentPageId || data.pages?.[0]?.id,
      };
      console.log('[injectModeContext] Set Context_Board from client data, pages:', data.pages?.length);
    } else {
      // Client didn't send board data — check server-side cache first
      const cached = getCachedBoard(sessionId);
      if (cached) {
        memoryValues["Context_Board"] = {
          ...cached,
          currentPageId: currentPageId || cached.currentPageId || cached.pages?.[0]?.id,
        };
        console.log('[injectModeContext] Set Context_Board from SERVER CACHE, name:', cached.name, 'pages:', cached.pages?.length);
      } else if (requestedGridSize) {
        // Create empty board with requested grid size
        memoryValues["Context_Board"] = createEmptyBoard("New Board", requestedGridSize);
        console.log('[injectModeContext] Set Context_Board from createEmptyBoard');
      } else {
        // Create default fallback board
        memoryValues["Context_Board"] = createFallbackBoard();
        console.log('[injectModeContext] Set Context_Board from createFallbackBoard');
      }
    }

    console.log('[injectModeContext] Context_Board now set:', !!memoryValues["Context_Board"]);
  } else if (feature === "aac" && !featureContext?.board) {
    // AAC mode without existing board - create a default empty board
    memoryValues["Context_Board"] = createEmptyBoard("Communication Board", { rows: 4, cols: 4 });
    console.log('[injectModeContext] AAC mode - created default empty board');
  }

  if (!featureContext) {
    console.log('[injectModeContext] No featureContext for other modes, returning');
    return;
  }

  // Progress context for "progress" mode
  if (!memoryValues["Context_Program"]) {
    memoryValues["Context_Program"] = null; // Will be populated from DB
  }

  // Document context for future modes
  if (featureContext.document) {
    memoryValues["Context_Document"] = featureContext.document.data;
  }
}

/**
 * Extract context data from memory values for the response.
 *
 * Also emits invalidation signals for student-scoped master-memory fields that
 * back real DB tables (e.g. Student_Contacts), so the client can refresh the
 * corresponding panels without needing a Context_* wrapper for every field.
 */
function extractContextFromMemoryValues(
  memoryValues: FlatMemoryValues,
  opts: { studentId?: string } = {},
): Record<string, any> {
  const contextData: Record<string, any> = {};

  console.log('[extractContextFromMemoryValues] Input keys:', Object.keys(memoryValues));

  // Extract all Context_ prefixed fields
  for (const [key, value] of Object.entries(memoryValues)) {
    if (key.startsWith(MEMORY_PREFIX.CONTEXT)) {
      // Convert Context_Board to "board", Context_AACSettings to "aacsettings", etc.
      const contextKey = key.replace(MEMORY_PREFIX.CONTEXT, "").toLowerCase();
      contextData[contextKey] = value;
      console.log('[extractContextFromMemoryValues] Extracted:', key, '->', contextKey);
    }
  }

  // Student-scoped table-backed fields — emit invalidation signals so the
  // matching client panels re-query. Only fire when we actually have a
  // studentId to attach (otherwise the client can't scope its invalidation).
  if (opts.studentId) {
    if ("Student_Contacts" in memoryValues) {
      contextData.studentContactsUpdated = { studentId: opts.studentId };
    }
    // Student_* fields covering core identity (name, gender, etc.) plus any
    // Student_People / chatMemory fields. Exclude fields that already have
    // their own signals (Student_Contacts) or are read-only (Student_LinkableEntities)
    // so we don't double-invalidate.
    const IGNORED_FOR_STUDENT_UPDATE = new Set(["Student_Contacts", "Student_LinkableEntities"]);
    const touchedStudentFields = Object.keys(memoryValues).filter(
      (k) => k.startsWith(MEMORY_PREFIX.STUDENT) && !IGNORED_FOR_STUDENT_UPDATE.has(k),
    );
    if (touchedStudentFields.length > 0) {
      contextData.studentUpdated = { studentId: opts.studentId };
    }
  }

  console.log('[extractContextFromMemoryValues] Output keys:', Object.keys(contextData));

  return contextData;
}

// ============================================================================
// PUBLIC API
// ============================================================================

export interface OnMessageInput {
  userId?: string;
  studentId?: string;
  instituteId?: string;
  sessionId?: string;
  activeFeature?: FeatureType;
  /** Persona ID (UUID) from the personas table, or undefined for default */
  persona?: string;
  messages?: ChatMessage[];
  replyType?: "text" | "html" | "md";

  /** Mode-specific context data (boards, documents, etc.) */
  featureContext?: FeatureContext;

  /** OpenAI vector store ID for file search (if files are attached) */
  vectorStoreId?: string;

  /** Base64 data URLs for inline images (sent as multimodal content to the LLM) */
  images?: string[];

  /** Attached documents (base64 data URLs with filenames, optionally pre-extracted text) */
  documents?: Array<{ dataUrl: string; filename: string; extractedText?: string }>;

  /** Image to include with the current request (not stored in history) */
  currentImage?: CurrentImage;

  /** Override the system prompt instead of building from persona/student settings */
  systemPromptOverride?: string;

  /** IANA timezone of the requesting user (e.g. "America/New_York"). Used for AI prompt context. */
  timezone?: string;
}

/**
 * Input for streaming message processing with thinking updates
 */
export interface OnMessageStreamingInput extends OnMessageInput {
  /** Callback for real-time thinking updates during tool calls */
  onThinkingUpdate?: (thinkingText: string) => void;
  /** Callback for real-time panel navigation during tool calls */
  onNavigate?: (feature: string) => void;
  /** Callback for real-time student selection during tool calls */
  onSelectStudent?: (studentId: string) => void;
  onFilesNeeded?: (files: Array<{ fileId: string; filename: string }>) => void;
}

function isCreditLimitError(error: any): boolean {
  const msg = error?.message || error?.error?.message || '';
  return msg.includes('credit balance is too low') || msg.includes('billing');
}

function isRateLimitError(error: any): boolean {
  const msg = error?.message || error?.error?.message || '';
  const status = error?.status || error?.error?.status || error?.statusCode;
  return status === 429 || msg.includes('rate_limit') || msg.includes('rate limit');
}

function isInputTooLargeError(error: any): boolean {
  const msg = error?.message || error?.error?.message || '';
  return isRateLimitError(error) && (msg.includes('input token') || msg.includes('prompt length'));
}

function classifyError(error: any): string {
  if (isCreditLimitError(error)) return "error:TOKEN_LIMIT";
  if (isInputTooLargeError(error)) return "error:INPUT_TOO_LARGE";
  if (isRateLimitError(error)) return "error:RATE_LIMIT";
  return "error:UNEXPECTED_ERROR";
}

export async function onMessage(input: OnMessageInput): Promise<MessageResponse> {
  try {
    const { userId, studentId, instituteId, sessionId, activeFeature, persona, messages, replyType, featureContext, vectorStoreId, images, documents, currentImage, systemPromptOverride, timezone } = input;

    const { manager: messageManager, memoryValues } = await getMessageManager({
      userId,
      studentId,
      instituteId,
      sessionId,
      feature: activeFeature,
      persona,
      featureContext,
      vectorStoreId,
      images,
      documents,
      currentImage,
      systemPromptOverride,
      timezone,
    });

    // Debug: Log what we injected
    console.log('[onMessage] After getMessageManager, memoryValues keys:', Object.keys(memoryValues));

    // Persist any incoming messages
    if (messages && messages.length > 0) {
      await messageManager.persistMessages(
        messages.map((message) => ({ ...message, timestamp: Date.now() }))
      );
    }

    // Generate response if requested
    if (replyType) {
      const response = await messageManager.getResponse(replyType);
      
      // Debug: Log what's in response.memoryValues
      console.log('[onMessage] After getResponse, response.memoryValues keys:', Object.keys(response.memoryValues || {}));
      
      // Merge: our injected values + any updates from LLM
      // This ensures Context_Board is included even if memory system doesn't return it
      console.log('[onMessage] MERGE — injected Context_Board name:', memoryValues?.Context_Board?.name ?? '(none)', 'pages:', memoryValues?.Context_Board?.pages?.length ?? 0);
      console.log('[onMessage] MERGE — response Context_Board name:', response.memoryValues?.Context_Board?.name ?? '(none)', 'pages:', response.memoryValues?.Context_Board?.pages?.length ?? 0);
      const mergedMemoryValues = {
        ...memoryValues,
        ...(response.memoryValues || {}),
      };

      console.log('[onMessage] MERGED Context_Board name:', mergedMemoryValues?.Context_Board?.name ?? '(none)', 'pages:', mergedMemoryValues?.Context_Board?.pages?.length ?? 0);

      // Resolve imageKeys → symbolPaths on the board (lookup + optional generation)
      await resolveImageKeysOnBoard(mergedMemoryValues?.Context_Board, studentId);

      // Cache the board for future requests (survives panel navigation)
      cacheBoardForSession(messageManager.session?.id, mergedMemoryValues?.Context_Board);

      // Extract context data (boards, documents, etc.) from memory values
      const contextData = extractContextFromMemoryValues(mergedMemoryValues, { studentId });

      console.log('[onMessage] Extracted contextData keys:', Object.keys(contextData));

      return {
        ...response,
        memoryValues: mergedMemoryValues,
        contextData,
      };
    } else {
      return {
        message: {
          role: "system",
          content: "",
          timestamp: Date.now(),
        },
        sessionId: messageManager.session?.id,
      };
    }
  } catch (error: any) {
    console.error("onMessage error:", error);
    return {
      message: {
        role: "system",
        content: classifyError(error),
        timestamp: Date.now(),
      },
      sessionId: input.sessionId,
    };
  }
}

/**
 * Process a message with streaming thinking updates.
 * This variant passes an optional onThinkingUpdate callback that will be called
 * whenever the AI is processing tool calls, allowing real-time status updates.
 */
export async function onMessageStreaming(input: OnMessageStreamingInput): Promise<MessageResponse> {
  try {
    const { userId, studentId, instituteId, sessionId, activeFeature, persona, messages, replyType, featureContext, onThinkingUpdate, onNavigate, onSelectStudent, onFilesNeeded, vectorStoreId, images, documents, currentImage, systemPromptOverride, timezone } = input;

    const { manager: messageManager, memoryValues } = await getMessageManager({
      userId,
      studentId,
      instituteId,
      sessionId,
      feature: activeFeature,
      persona,
      featureContext,
      onThinkingUpdate, // Pass the callback through to ChatMessageManager
      onNavigate,
      onSelectStudent,
      onFilesNeeded,
      vectorStoreId,
      images,
      documents,
      currentImage,
      systemPromptOverride,
      timezone,
    });

    // Debug: Log what we injected
    console.log('[onMessageStreaming] After getMessageManager, memoryValues keys:', Object.keys(memoryValues));

    // Persist any incoming messages
    let extractions: Array<{ filename: string; extractedText: string }> | undefined;
    if (messages && messages.length > 0) {
      extractions = await messageManager.persistMessages(
        messages.map((message) => ({ ...message, timestamp: Date.now() }))
      );
    }

    // Generate response if requested
    if (replyType) {
      const response = await messageManager.getResponse(replyType);

      // Debug: Log what's in response.memoryValues
      console.log('[onMessageStreaming] MERGE — injected Context_Board name:', memoryValues?.Context_Board?.name ?? '(none)', 'pages:', memoryValues?.Context_Board?.pages?.length ?? 0);
      console.log('[onMessageStreaming] MERGE — response Context_Board name:', response.memoryValues?.Context_Board?.name ?? '(none)', 'pages:', response.memoryValues?.Context_Board?.pages?.length ?? 0);

      // Merge: our injected values + any updates from LLM
      const mergedMemoryValues = {
        ...memoryValues,
        ...(response.memoryValues || {}),
      };
      console.log('[onMessageStreaming] MERGED Context_Board name:', mergedMemoryValues?.Context_Board?.name ?? '(none)', 'pages:', mergedMemoryValues?.Context_Board?.pages?.length ?? 0);

      // Resolve imageKeys → symbolPaths on the board (lookup + optional generation)
      await resolveImageKeysOnBoard(mergedMemoryValues?.Context_Board, studentId);

      // Cache the board for future requests (survives panel navigation)
      cacheBoardForSession(messageManager.session?.id, mergedMemoryValues?.Context_Board);

      // Extract context data (boards, documents, etc.) from memory values
      const contextData = extractContextFromMemoryValues(mergedMemoryValues, { studentId });

      return {
        ...response,
        memoryValues: mergedMemoryValues,
        contextData,
        extractions,
      };
    } else {
      return {
        message: {
          role: "system",
          content: "",
          timestamp: Date.now(),
        },
        sessionId: messageManager.session?.id,
      };
    }
  } catch (error: any) {
    console.error("onMessageStreaming error:", error);
    return {
      message: {
        role: "system",
        content: classifyError(error),
        timestamp: Date.now(),
      },
      sessionId: input.sessionId,
    };
  }
}

/**
 * Input for md streaming message processing
 */
export interface OnMessageMdStreamingInput extends OnMessageInput {
  onThinkingUpdate?: (thinkingText: string) => void;
  onNavigate?: (feature: string) => void;
  onSelectStudent?: (studentId: string) => void;
  onFilesNeeded?: (files: Array<{ fileId: string; filename: string }>) => void;
  signal?: AbortSignal;
}

/**
 * Events yielded by the md streaming generator, enriched with session data.
 */
export type SessionMdStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "navigate"; feature: string }
  | { type: "select_student"; studentId: string }
  | { type: "file_extracted"; filename: string; extractedText: string }
  | {
      type: "complete";
      message: ChatMessage;
      creditsUsed: number;
      sessionId?: string;
      chatState?: ChatState;
      memoryValues?: any;
      contextData?: Record<string, any>;
    };

/**
 * Process a message with token-by-token markdown streaming.
 * Uses the ChatProvider.streamChat() interface for real-time text output.
 */
export async function* onMessageMdStreaming(
  input: OnMessageMdStreamingInput
): AsyncGenerator<SessionMdStreamEvent> {
  try {
    const {
      userId, studentId, instituteId, sessionId, activeFeature, persona, messages,
      featureContext, onThinkingUpdate, onNavigate, onSelectStudent, onFilesNeeded,
      vectorStoreId, images, documents, currentImage, systemPromptOverride, timezone,
    } = input;

    const { manager: messageManager, memoryValues } = await getMessageManager({
      userId,
      studentId,
      instituteId,
      sessionId,
      feature: activeFeature,
      persona,
      featureContext,
      onThinkingUpdate,
      onNavigate,
      onSelectStudent,
      onFilesNeeded,
      vectorStoreId,
      images,
      documents,
      currentImage,
      systemPromptOverride,
      timezone,
    });

    // Persist any incoming messages
    if (messages && messages.length > 0) {
      const extractions = await messageManager.persistMessages(
        messages.map((message) => ({ ...message, timestamp: Date.now() }))
      );
      // Send extraction results back to client so it can cache them
      if (extractions) {
        for (const ext of extractions) {
          yield { type: 'file_extracted' as const, filename: ext.filename, extractedText: ext.extractedText };
        }
      }
    }

    // Stream the response
    for await (const event of messageManager.getStreamingMdResponse(input.signal)) {
      if (event.type === 'complete') {
        // Enrich with session data
        const mergedMemoryValues = {
          ...memoryValues,
          ...(messageManager.memoryValues || {}),
        };
        // Resolve imageKeys → symbolPaths on the board (lookup + optional generation)
        await resolveImageKeysOnBoard(mergedMemoryValues?.Context_Board, studentId);

        const contextData = extractContextFromMemoryValues(mergedMemoryValues, { studentId });

        // Cache the board for future requests (survives panel navigation)
        cacheBoardForSession(messageManager.session?.id, mergedMemoryValues?.Context_Board);

        yield {
          type: 'complete',
          message: event.message,
          creditsUsed: event.creditsUsed,
          sessionId: messageManager.session?.id,
          chatState: messageManager.toJSON(),
          memoryValues: mergedMemoryValues,
          contextData,
        };
      } else {
        yield event;
      }
    }
  } catch (error: any) {
    console.error("onMessageMdStreaming error:", error);
    yield {
      type: 'complete',
      message: {
        role: "system",
        content: classifyError(error),
        timestamp: Date.now(),
      },
      creditsUsed: 0,
      sessionId: input.sessionId,
    };
  }
}

export async function persistMessages(params: {
  userId?: string;
  studentId?: string;
  sessionId: string;
  items: {
    role: string;
    text: string;
    timestamp: number;
    metadata?: Record<string, any>;
  }[];
}): Promise<{ ok: boolean }> {
  const manager = await getMessageManager({
    userId: params.userId,
    studentId: params.studentId,
    sessionId: params.sessionId,
  });
  
  await manager.manager.persistMessages(
    params.items.map((item) => ({
      role: item.role as "user" | "assistant" | "system" | "tool",
      content: item.text,
      timestamp: item.timestamp,
      metadata: item.metadata,
    }))
  );
  
  return { ok: true };
}

export async function getSessionInfo(sessionId: string): Promise<ChatSession | undefined> {
  return getSession(sessionId);
}

// Export for use in other modules
export {
  getMessageManager,
  BOARD_MEMORY_FIELD,
  type FeatureType,
  type MemoryContext,
  type ParsedBoardData,
  type BoardGrid,
  type CurrentImage,
};