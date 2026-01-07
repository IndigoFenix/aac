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
import {
  users,
  students,
  userStudents,
  chatSessions,
  type User,
  type Student,
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
  ChatPersona,
} from "@shared/schema";
import { ChatMessageManager, AgentTemplate } from "./chat/chat-handler";
import { AgentLike } from "./chat/prompt-kit";
import {
  ParsedBoardData,
  createFallbackBoard,
  createEmptyBoard,
} from "./board-utils";
import {
  ProgressModeManager,
  createProgressModeManager,
  injectProgressModeContext,
  getReportPermissionsFromRights,
  buildProgressSystemPrompt,
} from "./progress-mode-integration";
import {
  BOARD_SYSTEM_PROMPT,
  getSystemPrompt,
} from "./system-prompts";

import { 
  createMemoryLoadState,
  deserializeLoadState, 
  processMemoryToolWithDB, 
  serializeLoadState, 
  type AgentMemoryFieldWithDB 
} from "./chat/memory-db-bridge";
import { createDBMemoryProcessor, MemoryProcessor } from "./chat/tool-router";
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
 */
export const MASTER_MEMORY_FIELDS: AgentMemoryField[] = [
  // === User fields (prefixed with User_) ===
  {
    id: "User_AiPersonalityPreferences",
    type: "string",
    title: "AI Personality Preferences",
    description: "User's preferences for how the AI should communicate (tone, style, etc.)",
    opened: true,
  },
  {
    id: "User_Language",
    type: "string",
    title: "Preferred Language",
    description: "User's preferred language for communication",
    opened: true,
  },
  
  // === Student fields (prefixed with Student_) - NON-SENSITIVE ONLY ===
  {
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
        // NOTE: Removed "Notes" array - could contain sensitive information
      },
      required: ["Name"],
    },
  },
  {
    id: "Student_Interests",
    type: "array",
    title: "Interests",
    description: "Things the student enjoys or is interested in",
    opened: true,
    items: {
      id: "Interest",
      type: "string",
    },
  },
  {
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
  },
  {
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
      },
      RewardPreferences: {
        id: "RewardPreferences",
        type: "array",
        title: "Reward Preferences",
        items: { id: "Reward", type: "string" },
      },
      AvoidTopics: {
        id: "AvoidTopics",
        type: "array",
        title: "Topics to Avoid",
        description: "Topics that should be avoided in conversation",
        items: { id: "Topic", type: "string" },
      },
    },
  },
  {
    id: "Student_Notes",
    type: "array",
    title: "General Notes",
    description: "General notes about the student (non-sensitive)",
    opened: false,
    items: {
      id: "Note",
      type: "string"
    }
  },
  // === Relationship fields (prefixed with Relationship_) ===
  {
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
    },
  },
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
  tools: {},
  library: [],
}

// ============================================================================
// MEMORY CONTEXT
// ============================================================================

interface MemoryContext {
  user?: User;
  student?: Student;
  userStudent?: UserStudent;
  institute?: Institute;
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

async function getStudent(studentId: string): Promise<Student | undefined> {
  const [student] = await db.select().from(students).where(eq(students.id, studentId));
  return student || undefined;
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
  sessionId?: string;
  feature?: FeatureType;
  persona?: ChatPersona;
  featureContext?: FeatureContext;
}

interface GetMessageManagerResult {
  manager: ChatMessageManager;
  memoryValues: FlatMemoryValues;
}

async function getMessageManager(input: GetMessageManagerInput): Promise<GetMessageManagerResult> {
  const { userId, studentId, sessionId, featureContext, persona = "assistant", feature = "chat" } = input;

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

  // Get or create session
  let session: ChatSession | undefined;
  let chatState: ChatState;
  let log: ChatMessage[] = [];

  const template = AGENT_TEMPLATE_BASE;
  // Select core prompt based on conversation persona
  template.corePrompt = getSystemPrompt(persona, context?.student?.framework || null);
  
  const newChatState: ChatState = {
    history: [],
    memoryState: { visible: [], page: {} },
    conversationSummary: "",
    openedTopics: [],
  };
  
  // Add greeting if template has one (Disabled for now)
  /*
  if (template.greeting) {
    newChatState.history.push({
      role: "assistant",
      timestamp: Date.now(),
      content: template.greeting,
      credits: 0,
    });
  }
  */

  if (sessionId) {
    session = await getSession(sessionId);
    if (!session) {
      throw { status: 404, message: "Session not found" };
    }
    chatState = (session.state as ChatState) || newChatState;
    log = (session.log as ChatMessage[]) || [];
  } else {
    // Create new session
    chatState = newChatState;
    session = await createSession({
      userId: userId || null,
      studentId: studentId || null,
      userStudentId: context.userStudent?.id || null,
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
  let progressManager: ProgressModeManager | undefined;
  let contextMemoryFields: AgentMemoryFieldWithDB[] = [];

  if (context.student) {
    // Deserialize existing load state from chatState if available
    const existingLoadState = undefined; // Or restore from chatState.loadStateCache
    
    // Determine report permissions based on user rights
    // These could come from the userStudent relationship or be passed in featureContext
    const hasMedicalRights = context.userStudent?.hasMedicalRights ?? false;
    const hasEducationalRights = context.userStudent?.hasEducationalRights ?? false;
    
    // Convert rights to permissions
    const reportPermissions = getReportPermissionsFromRights(
      hasMedicalRights,
      hasEducationalRights,
      true // canEdit - set to false to make all reports read-only
    );
    
    // Create the unified manager
    progressManager = await createProgressModeManager(
      context.student.id,
      context.user?.id,
      featureContext?.progress?.programId,
      MASTER_MEMORY_FIELDS as AgentMemoryFieldWithDB[],
      existingLoadState,
      context.institute?.id, // instituteId for medical records filtering
      reportPermissions
    );
    
    // Get memory fields (includes both program and reports based on permissions)
    contextMemoryFields.push(...progressManager.getMemoryFields());
    
    // Update template with dynamic configuration
    const additionalPrompt = buildProgressSystemPrompt(reportPermissions);
    template.corePrompt = template.corePrompt + additionalPrompt;
    template.memoryFields = contextMemoryFields as AgentMemoryField[];
  }

  // === Board Mode Setup ===
  // Add board memory field to template.memoryFields when in boards mode
  if (feature === 'boards') {
    if (featureContext?.board) {
      const boardPrompt = BOARD_SYSTEM_PROMPT;
      template.corePrompt = `${template.corePrompt}\n${boardPrompt}`;
    }
    
    // Add BOARD_MEMORY_FIELD to contextMemoryFields for prompt rendering
    contextMemoryFields.push(BOARD_MEMORY_FIELD as AgentMemoryFieldWithDB);
    template.memoryFields = contextMemoryFields as AgentMemoryField[];
  }

  // Build memory values from context
  let memoryValues = buildMemoryValues(context);
  console.log('[DEBUG] After buildMemoryValues:');
  console.log('  - context.student?.chatMemory:', JSON.stringify(context.student?.chatMemory));
  console.log('  - memoryValues keys:', Object.keys(memoryValues));
  console.log('  - memoryValues:', JSON.stringify(memoryValues, null, 2));

  // For progress mode, load program data from database
  if (progressManager) {
      console.log('[DEBUG] Progress mode - calling injectProgressModeContext');
      console.log('  - studentId:', context.student?.id);
      console.log('  - baseContext:', progressManager.getBaseContext());
      
      const populateResult = await injectProgressModeContext(
        memoryValues,
        chatState.memoryState,
        progressManager
      );
      memoryValues = populateResult;
      
      console.log('[DEBUG] After injectProgressModeContext:');
      console.log('  - memoryValues keys:', Object.keys(memoryValues));
      console.log('  - Context_Program:', memoryValues['Context_Program']);
  }

  console.log('[getMessageManager] Initial memory values:', memoryValues);

  // Inject mode-specific context into memory values
  injectModeContext(memoryValues, feature, featureContext);

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

  const enrichCorePrompt = (context: MemoryContext, corePrompt: string) => {
    // Add any additional instructions or context to the core prompt if needed
    let prefix = "";
    prefix = `Current datetime: ${new Date().toISOString()}\n`;
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
    } else if (context.student) {
      prefix += `You are speaking with the student.\n`;
    }
    if (progressManager){
      prefix += progressManager.getStudentInfo();
      prefix += progressManager.getProgramSummary();
    }
    return `${corePrompt}\n${prefix}`;
  }

  const onUpdateChatState = async (state: ChatState, newLog?: ChatMessage[]) => {
    if (!session) return;

    if (progressManager) {
      state.loadStateCache = serializeLoadState(progressManager.getLoadState());
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

  template.corePrompt = enrichCorePrompt(context, template.corePrompt);

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

  // Create the memory processor based on mode
  let memoryProcessor: MemoryProcessor | undefined;

  if (progressManager) {
    // Create a load state ref (or get from progressManager)
    const loadStateRef = { current: progressManager.getLoadState() };
    
    // Get the base fields from progressManager (these have DB ops attached)
    let fieldsForProcessor = progressManager.getMemoryFields();
    
    // FIX: If in boards mode, add BOARD_MEMORY_FIELD to the processor's field list
    // This allows the memory processor to resolve /Context_Board paths
    if (feature === 'boards') {
      fieldsForProcessor = [...fieldsForProcessor, BOARD_MEMORY_FIELD as AgentMemoryFieldWithDB];
    }
    
    memoryProcessor = createDBMemoryProcessor(
      processMemoryToolWithDB,
      fieldsForProcessor,
      { current: memoryValues },
      { current: chatState.memoryState },
      loadStateRef,
      progressManager.getBaseContext()
    );
  } else if (feature === 'boards') {
    // Handle boards mode WITHOUT a student/progressManager (edge case)
    const loadStateRef = { current: createMemoryLoadState() };
    
    memoryProcessor = createDBMemoryProcessor(
      processMemoryToolWithDB,
      [BOARD_MEMORY_FIELD as AgentMemoryFieldWithDB],
      { current: memoryValues },
      { current: chatState.memoryState },
      loadStateRef,
      {
        studentId: context.student?.id,
        userId: context.user?.id,
      }
    );
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
    memoryProcessor
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
  featureContext?: FeatureContext
): void {
  console.log('[injectModeContext] Called with mode:', feature, 'featureContext:', !!featureContext);
  
  if (!featureContext) {
    console.log('[injectModeContext] No featureContext, returning');
    return;
  }

  // Board context for "boards" mode
  if (feature === "boards" && featureContext.board) {
    const { data, currentPageId, requestedGridSize } = featureContext.board;
    
    console.log('[injectModeContext] Board mode - data:', !!data, 'currentPageId:', currentPageId, 'requestedGridSize:', requestedGridSize);
    
    if (data) {
      // Use existing board data, optionally override currentPageId
      memoryValues["Context_Board"] = {
        ...data,
        currentPageId: currentPageId || data.currentPageId || data.pages?.[0]?.id,
      };
      console.log('[injectModeContext] Set Context_Board from data, pages:', data.pages?.length);
    } else if (requestedGridSize) {
      // Create empty board with requested grid size
      memoryValues["Context_Board"] = createEmptyBoard("New Board", requestedGridSize);
      console.log('[injectModeContext] Set Context_Board from createEmptyBoard');
    } else {
      // Create default fallback board
      memoryValues["Context_Board"] = createFallbackBoard();
      console.log('[injectModeContext] Set Context_Board from createFallbackBoard');
    }
    
    console.log('[injectModeContext] Context_Board now set:', !!memoryValues["Context_Board"]);
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
 * Extract context data from memory values for the response
 */
function extractContextFromMemoryValues(memoryValues: FlatMemoryValues): Record<string, any> {
  const contextData: Record<string, any> = {};
  
  console.log('[extractContextFromMemoryValues] Input keys:', Object.keys(memoryValues));
  
  // Extract all Context_ prefixed fields
  for (const [key, value] of Object.entries(memoryValues)) {
    if (key.startsWith(MEMORY_PREFIX.CONTEXT)) {
      // Convert Context_Board to "board", Context_Document to "document", etc.
      const contextKey = key.replace(MEMORY_PREFIX.CONTEXT, "").toLowerCase();
      contextData[contextKey] = value;
      console.log('[extractContextFromMemoryValues] Extracted:', key, '->', contextKey);
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
  sessionId?: string;
  activeFeature?: FeatureType;
  persona?: ChatPersona;
  messages?: ChatMessage[];
  replyType?: "text" | "html";
  
  /** Mode-specific context data (boards, documents, etc.) */
  featureContext?: FeatureContext;
}

export async function onMessage(input: OnMessageInput): Promise<MessageResponse> {
  try {
    const { userId, studentId, sessionId, activeFeature, persona, messages, replyType, featureContext } = input;

    const { manager: messageManager, memoryValues } = await getMessageManager({
      userId,
      studentId,
      sessionId,
      feature: activeFeature,
      persona,
      featureContext,
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
      const mergedMemoryValues = {
        ...memoryValues,
        ...(response.memoryValues || {}),
      };
      
      console.log('[onMessage] Complete mergedMemoryValues:', JSON.stringify(mergedMemoryValues));
      
      // Extract context data (boards, documents, etc.) from memory values
      const contextData = extractContextFromMemoryValues(mergedMemoryValues);
      
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
        content: error.message || "An unexpected error occurred.",
        timestamp: Date.now(),
      },
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
};