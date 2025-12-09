/**
 * Session Service
 * 
 * Handles chat session management for the AAC system.
 * 
 * Key differences from the original:
 * - No agents/instances - uses "modes" (board, interpret) with local templates
 * - Memory is stored on User, Student, and UserStudent objects
 * - Credits are tracked per User, Student, and UserStudent
 * - Simplified input: userId, studentId, sessionId, mode
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
} from "@shared/schema";
import { ChatMessageManager, AgentTemplate } from "./chat/chat-handler";
import { AgentLike } from "./chat/prompt-kit";

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
    corePrompt: "You are an AAC board generation assistant. Help create communication boards.",
    greeting: "Hello! I can help you create AAC communication boards. What would you like to build?",
    intelligence: 2,
    memory: 2,
    memoryFields: [...MASTER_MEMORY_FIELDS],
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
// e.g., { "User_AiPersonalityPreferences": "...", "Student_Interests": [...] }
type FlatMemoryValues = Record<string, any>;

// Prefixes for memory field ownership
const MEMORY_PREFIX = {
  USER: "User_",
  AAC_USER: "Student_",
  RELATIONSHIP: "Relationship_",
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
}

async function getMessageManager(input: GetMessageManagerInput): Promise<ChatMessageManager> {
  const { userId, studentId, sessionId, mode = "interpret" } = input;

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
      started: new Date(),
      lastUpdate: new Date(),
      creditsUsed: 0,
    });
  }

  // Build memory values from context
  const memoryValues = buildMemoryValues(context);

  // Create callbacks
  const onUpdateMemoryValues = async (newMemoryValues: FlatMemoryValues) => {
    // Extract and save memory values to the appropriate database objects based on prefix
    
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
  };

  const enrichCorePrompt = (context: MemoryContext, corePrompt: string) => {
    // Add any additional instructions or context to the core prompt if needed
    let prefix = "";
    if (context.user) {
      if (context.student) {
        if (context.userStudent) {
          prefix += `You are speaking with ${context.user.fullName}, who is a ${context.userStudent.role} for the AAC user ${context.student.name}.\n`;
        } else {
          prefix += `You are speaking with ${context.user.fullName}, who is connected to the AAC user ${context.student.name}.\n`;
        }
      } else {
        prefix += `You are speaking with ${context.user.fullName}.\n`;
      }
    } else if (context.student) {
      prefix += `You are speaking with the AAC user ${context.student.name}, who has ${context.student.diagnosis}.\n`;
    }
    return `${prefix}\n\n${corePrompt}`;
  }

  const onUpdateChatState = async (state: ChatState, newLog?: ChatMessage[]) => {
    if (!session) return;
    
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
  });

  return messageManager;
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
}

export async function onMessage(input: OnMessageInput): Promise<MessageResponse> {
  try {
    const { userId, studentId, sessionId, mode, messages, replyType } = input;

    const messageManager = await getMessageManager({
      userId,
      studentId,
      sessionId,
      mode,
    });

    // Persist any incoming messages
    if (messages && messages.length > 0) {
      await messageManager.persistMessages(
        messages.map((message) => ({ ...message, timestamp: Date.now() }))
      );
    }

    // Generate response if requested
    if (replyType) {
      const response = await messageManager.getResponse(replyType);
      return response;
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
  
  await manager.persistMessages(
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
export { getMessageManager, AGENT_TEMPLATES, type ChatMode, type MemoryContext };