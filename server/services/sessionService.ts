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
  type ChatMode,
  type AgentMemoryField,
  type Topic,
  MessageResponse,
  BoardGrid,
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
  PROGRESS_AGENT_CONFIG,
  getProgressMemoryFields,
} from "./progress-mode-integration";

import { deserializeLoadState, processMemoryToolWithDB, serializeLoadState, type AgentMemoryFieldWithDB } from "./chat/memory-db-bridge";
import { createDBMemoryProcessor, MemoryProcessor } from "./chat/tool-router";
// ============================================================================
// AGENT TEMPLATES (Mode-based, stored locally)
// ============================================================================

interface LocalAgentTemplate extends AgentLike {
  intelligence: number;
  memory: number;
  memoryFields: AgentMemoryField[];
}

// Memory fields that are populated from User, Student, and UserStudent
// These are FLAT top-level fields - the memory system requires arrays/maps to be at root level
const MASTER_MEMORY_FIELDS: AgentMemoryField[] = [
  // === User fields (prefixed with User_) ===
  {
    id: "User_AiPersonalityPreferences",
    type: "string",
    title: "AI Personality Preferences",
    description: "User's preferences for how the AI should communicate (tone, style, etc.)",
    opened: true,
  },
  
  // === Student fields (prefixed with Student_) ===
  {
    id: "Student_People",
    type: "array",
    title: "People",
    description: "Important people in the AAC user's life",
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
          description: "Relationship to the AAC user (e.g., mother, teacher, friend)",
        },
        Notes: {
          id: "Notes",
          type: "array",
          title: "Notes",
          description: "Additional notes about this person",
          items: {
            id: "Note",
            type: "string",
          },
        },
      },
      required: ["Name"],
    },
  },
  {
    id: "Student_Interests",
    type: "array",
    title: "Interests",
    description: "Things the AAC user enjoys or is interested in",
    opened: true,
    items: {
      id: "Interest",
      type: "string",
    },
  },
  {
    id: "Student_Milestones",
    type: "array",
    title: "Milestones",
    description: "Important milestones and goals for the AAC user",
    opened: true,
    items: {
      id: "Milestone",
      type: "object",
      properties: {
        Title: {
          id: "Title",
          type: "string",
          title: "Title",
          description: "Milestone title/description",
        },
        Date: {
          id: "Date",
          type: "string",
          title: "Date",
          description: "Target or achieved date",
          format: "date",
        },
        Achieved: {
          id: "Achieved",
          type: "boolean",
          title: "Achieved",
          description: "Whether the milestone has been achieved",
          default: false,
        },
      },
      required: ["Title"],
    },
  },
  
  // === UserStudent fields (relationship-specific, prefixed with Relationship_) ===
  // Can be extended with relationship-specific fields as needed
];

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
// BOARD MODE PROMPTS
// ============================================================================

const BOARD_SYSTEM_PROMPT = `You are an expert AAC (Augmentative and Alternative Communication) board designer.

## Board Structure

The board is stored at /Context_Board with this structure:
- name: Board name
- grid: { rows, cols }
- currentPageId: Which page is active
- pages: Array of pages, each containing:
  - id, name
  - buttons: Array of buttons with id, row, col, label, spokenText, color, iconRef, action

## Operations

### Initialize/replace board:
\`\`\`
manageMemory({ ops: [{ action: "set", path: "/Context_Board", value: {
  name: "My Board",
  grid: { rows: 3, cols: 3 },
  currentPageId: "page-main",
  pages: [{
    id: "page-main",
    name: "Main",
    buttons: [
      { id: "btn-1", row: 0, col: 0, label: "Hello", spokenText: "Hello!", color: "#3B82F6", iconRef: "fas fa-hand-wave", action: { type: "speak", text: "Hello!" } }
    ]
  }]
}}]})
\`\`\`

### View pages/buttons:
\`\`\`
manageMemory({ ops: [{ action: "view", path: "/Context_Board/pages/0/buttons" }]})
\`\`\`

### Edit a button property:
\`\`\`
manageMemory({ ops: [{ action: "set", path: "/Context_Board/pages/0/buttons/0/label", value: "Hi" }]})
\`\`\`

### Delete a button:
\`\`\`
manageMemory({ ops: [{ action: "delete", path: "/Context_Board/pages/0/buttons/0" }]})
\`\`\`

### Add a button (set at next index):
\`\`\`
manageMemory({ ops: [{ action: "set", path: "/Context_Board/pages/0/buttons/2", value: {
  id: "btn-new", row: 1, col: 0, label: "New", spokenText: "New button", color: "#F59E0B", iconRef: "fas fa-plus", action: { type: "speak", text: "New button" }
}}]})
\`\`\`

## Button Guidelines

**Labels:** 1-3 words | **Spoken Text:** Max 8 words | **IDs:** btn-{name}-{n}

**Colors:** Blue #3B82F6 (needs), Amber #F59E0B (emotions), Pink #EC4899 (people), Yellow #EAB308 (activities), Gray #6B7280 (objects), Green #059669 (yes), Red #DC2626 (no)

**Icons:** FontAwesome classes (fas fa-smile, fas fa-home, etc.)

**Actions:** { type: "speak", text: "..." } or { type: "link", toPageId: "page-id" }

When creating/modifying boards, use manageMemory and explain your changes.`;

const BOARD_CREATION_PROMPT = `You are starting with a new communication board. The user will tell you what kind of board they want to create.

If no board exists yet, you should:
1. Ask clarifying questions about the AAC user's needs
2. Create an appropriate board structure
3. Add relevant buttons based on the topic

Remember to view the board structure first before making changes.`;

// ============================================================================
// AGENT TEMPLATES
// ============================================================================

// Agent templates for each mode
const AGENT_TEMPLATES: Record<ChatMode, LocalAgentTemplate> = {
  chat: {
    name: "CliniAACian Assistant",
    corePrompt: `You are CliniAACian, a helpful AI assistant for AAC (Augmentative and Alternative Communication) professionals and caregivers.

You have access to information about the AAC user you're helping with. Use the memory system to store and retrieve important information about them.

Be warm, supportive, and knowledgeable about AAC practices. Help users with questions about:
- Communication strategies
- AAC device usage and setup
- Supporting AAC users in daily activities
- Tracking progress and milestones
- Understanding the AAC user's needs and preferences

Always be respectful when discussing the AAC user and remember that caregivers and professionals are working hard to support communication access.`,
    greeting: "Hello! I'm CliniAACian, your AAC assistant. How can I help you today?",
    intelligence: 2,
    memory: 2,
    memoryFields: [...MASTER_MEMORY_FIELDS],
    tools: {},
    library: [],
  },
  boards: {
    name: "Board Generator",
    corePrompt: BOARD_SYSTEM_PROMPT,
    greeting: "Hello! I can help you create and modify AAC communication boards. What would you like to build?\n\nYou can:\n- Create a new board for a specific topic or situation\n- Modify an existing board (add, edit, or remove buttons)\n- Get suggestions for improving your board layout",
    intelligence: 2,
    memory: 2,
    memoryFields: [...MASTER_MEMORY_FIELDS, BOARD_MEMORY_FIELD],
    tools: {},
    library: [],
  },
  interpret: {
    name: "Interpretation Assistant", 
    corePrompt: "You are an AAC interpretation assistant. Help interpret and understand AAC user communications.",
    greeting: "Hello! I can help interpret AAC communications. What would you like me to help with?",
    intelligence: 2,
    memory: 2,
    memoryFields: [...MASTER_MEMORY_FIELDS],
    tools: {},
    library: [],
  },
  docuslp: {
    name: "DocuSLP Assistant", 
    corePrompt: "You are a DocuSLP assistant for AAC users. Help document speech-language pathology sessions.",
    greeting: "Hello! I can help document SLP sessions for AAC users. What would you like to document?",
    intelligence: 2,
    memory: 2,
    memoryFields: [...MASTER_MEMORY_FIELDS],
    tools: {},
    library: [],
  },
  overview: {
    name: "Overview Assistant",
    corePrompt: "You are an overview assistant. Help users understand and navigate the CliniAACian system.",
    greeting: "Hello! How can I help you navigate the system?",
    intelligence: 1,
    memory: 1,
    memoryFields: [],
    tools: {},
    library: [],
  },
  students: {
    name: "Student Management Assistant",
    corePrompt: "You are a student management assistant. Help users manage AAC user profiles and information.",
    greeting: "Hello! How can I help you manage student profiles?",
    intelligence: 1,
    memory: 1,
    memoryFields: [...MASTER_MEMORY_FIELDS],
    tools: {},
    library: [],
  },
  progress: {
    name: PROGRESS_AGENT_CONFIG.name,
    corePrompt: PROGRESS_AGENT_CONFIG.corePrompt,
    greeting: PROGRESS_AGENT_CONFIG.greeting,
    intelligence: PROGRESS_AGENT_CONFIG.intelligence,
    memory: PROGRESS_AGENT_CONFIG.memory,
    // Note: memoryFields will be set dynamically in getMessageManager
    // because it includes DB operations that depend on context
    memoryFields: [...MASTER_MEMORY_FIELDS],
    tools: {},
    library: [],
  },
  settings: {
    name: "Settings Assistant",
    corePrompt: "You are a settings assistant. Help users configure their CliniAACian preferences.",
    greeting: "Hello! How can I help you with settings?",
    intelligence: 1,
    memory: 1,
    memoryFields: [],
    tools: {},
    library: [],
  },
};

// ============================================================================
// MEMORY CONTEXT
// ============================================================================

interface MemoryContext {
  user?: User;
  student?: Student;
  userStudent?: UserStudent;
}

// Memory values are stored flat with prefixed keys
// e.g., { "User_AiPersonalityPreferences": "...", "Student_Interests": [...], "Context_Board": {...} }
type FlatMemoryValues = Record<string, any>;

// Prefixes for memory field ownership
const MEMORY_PREFIX = {
  USER: "User_",
  AAC_USER: "Student_",
  RELATIONSHIP: "Relationship_",
  CONTEXT: "Context_", // Session-scoped context (not persisted to DB)
};

function buildMemoryValues(context: MemoryContext): FlatMemoryValues {
  const values: FlatMemoryValues = {};
  
  // Load User memory values (prefixed with User_)
  if (context.user) {
    const userMemory = (context.user.chatMemory as Record<string, any>) || {};
    for (const [key, value] of Object.entries(userMemory)) {
      // Store with prefix if not already prefixed
      const prefixedKey = key.startsWith(MEMORY_PREFIX.USER) ? key : `${MEMORY_PREFIX.USER}${key}`;
      values[prefixedKey] = value;
    }
  }
  
  // Load Student memory values (prefixed with Student_)
  if (context.student) {
    const studentMemory = (context.student.chatMemory as Record<string, any>) || {};
    for (const [key, value] of Object.entries(studentMemory)) {
      const prefixedKey = key.startsWith(MEMORY_PREFIX.AAC_USER) ? key : `${MEMORY_PREFIX.AAC_USER}${key}`;
      values[prefixedKey] = value;
    }
  }
  
  // Load UserStudent relationship memory values (prefixed with Relationship_)
  if (context.userStudent) {
    const relationshipMemory = (context.userStudent.chatMemory as Record<string, any>) || {};
    for (const [key, value] of Object.entries(relationshipMemory)) {
      const prefixedKey = key.startsWith(MEMORY_PREFIX.RELATIONSHIP) ? key : `${MEMORY_PREFIX.RELATIONSHIP}${key}`;
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
export interface ModeContext {
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
  mode?: ChatMode;
  modeContext?: ModeContext;
}

interface GetMessageManagerResult {
  manager: ChatMessageManager;
  memoryValues: FlatMemoryValues;
}

async function getMessageManager(input: GetMessageManagerInput): Promise<GetMessageManagerResult> {
  const { userId, studentId, sessionId, mode = "chat", modeContext } = input;

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
      throw { status: 404, message: `AAC User not found: ${studentId}` };
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
  let sessionMode: ChatMode = mode;

  const template = AGENT_TEMPLATES[sessionMode];
  
  const newChatState: ChatState = {
    history: [],
    memoryState: { visible: [], page: {} },
    conversationSummary: "",
    openedTopics: [],
  };
  
  // Add greeting if template has one
  if (template.greeting) {
    newChatState.history.push({
      role: "assistant",
      timestamp: Date.now(),
      content: template.greeting,
      credits: 0,
    });
  }

  if (sessionId) {
    session = await getSession(sessionId);
    if (!session) {
      throw { status: 404, message: "Session not found" };
    }
    chatState = (session.state as ChatState) || newChatState;
    log = (session.log as ChatMessage[]) || [];
    sessionMode = session.chatMode as ChatMode;
  } else {
    // Create new session
    chatState = newChatState;
    session = await createSession({
      userId: userId || null,
      studentId: studentId || null,
      userStudentId: context.userStudent?.id || null,
      chatMode: sessionMode,
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
  let progressMemoryFields: AgentMemoryFieldWithDB[] = [];

  if (mode === "progress" && context.student) {
    // NEW: Deserialize existing load state from chatState if available
    const existingLoadState = undefined; /*chatState.loadStateCache
      ? deserializeLoadState(chatState.loadStateCache)
      : undefined;*/

    progressManager = await createProgressModeManager(
      context.student.id,
      context.user?.id,
      modeContext?.progress?.programId,
      MASTER_MEMORY_FIELDS as AgentMemoryFieldWithDB[],
      existingLoadState  // NEW: Pass existing load state
    );
    
    // Get memory fields with DB operations
    progressMemoryFields = progressManager.getMemoryFields();
    
    // Update template with dynamic memory fields
    template.memoryFields = progressMemoryFields as AgentMemoryField[];
  }

  // Build memory values from context
  let memoryValues = buildMemoryValues(context);
  console.log('[DEBUG] After buildMemoryValues:');
  console.log('  - context.student?.chatMemory:', JSON.stringify(context.student?.chatMemory));
  console.log('  - memoryValues keys:', Object.keys(memoryValues));
  console.log('  - memoryValues:', JSON.stringify(memoryValues, null, 2));

  // For progress mode, load program data from database
  if (mode === "progress" && progressManager) {
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
  injectModeContext(memoryValues, sessionMode, modeContext);

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
      const studentMemory = extractMemoryForEntity(newMemoryValues, MEMORY_PREFIX.AAC_USER);
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
    if (context.user) {
      if (context.student) {
        if (context.userStudent) {
          prefix += `You are speaking with ${context.user.fullName}, who is a ${context.userStudent.role} for the student ${context.student.name}.\n`;
        } else {
          prefix += `You are speaking with ${context.user.fullName}, who is connected to the student ${context.student.name}.\n`;
        }
      } else {
        prefix += `You are speaking with ${context.user.fullName}.\n`;
      }
    } else if (context.student) {
      prefix += `You are speaking with the AAC user ${context.student.name}, who has ${context.student.diagnosis}.\n`;
    }
    if (progressManager){
      prefix += progressManager.getStudentInfo();
      prefix += progressManager.getProgramSummary();
    }
    return `${prefix}\n${corePrompt}`;
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

  // Build agent-like object from template for ChatMessageManager
  const agentFromTemplate: AgentTemplate = {
    id: `template-${sessionMode}`,
    accountId: context.user?.id || context.student?.id || "system",
    name: template.name,
    corePrompt: enrichCorePrompt(context, template.corePrompt),
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

  if (mode === "progress" && progressManager) {
    // Create a load state ref (or get from progressManager)
    const loadStateRef = { current: progressManager.getLoadState() };
    
    memoryProcessor = createDBMemoryProcessor(
      processMemoryToolWithDB,
      progressManager.getMemoryFields(),
      { current: memoryValues },
      { current: chatState.memoryState },
      loadStateRef,
      progressManager.getBaseContext()
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
  mode: ChatMode,
  modeContext?: ModeContext
): void {
  console.log('[injectModeContext] Called with mode:', mode, 'modeContext:', !!modeContext);
  
  if (!modeContext) {
    console.log('[injectModeContext] No modeContext, returning');
    return;
  }

  // Board context for "boards" mode
  if (mode === "boards" && modeContext.board) {
    const { data, currentPageId, requestedGridSize } = modeContext.board;
    
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
  if (mode === "progress") {
    // Note: The actual data loading happens via progressManager.populateMemory()
    // which is called separately. This just ensures the Context_Program key exists.
    if (!memoryValues["Context_Program"]) {
      memoryValues["Context_Program"] = null; // Will be populated from DB
    }
  }

  // Document context for future modes
  if (modeContext.document) {
    memoryValues["Context_Document"] = modeContext.document.data;
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
  mode?: ChatMode;
  messages?: ChatMessage[];
  replyType?: "text" | "html";
  
  /** Mode-specific context data (boards, documents, etc.) */
  modeContext?: ModeContext;
}

export async function onMessage(input: OnMessageInput): Promise<MessageResponse> {
  try {
    const { userId, studentId, sessionId, mode, messages, replyType, modeContext } = input;

    const { manager: messageManager, memoryValues } = await getMessageManager({
      userId,
      studentId,
      sessionId,
      mode,
      modeContext,
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
  AGENT_TEMPLATES, 
  BOARD_MEMORY_FIELD,
  type ChatMode, 
  type MemoryContext,
  type ParsedBoardData,
  type BoardGrid,
};