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
const MASTER_MEMORY_FIELDS: AgentMemoryField[] = [
  // User memory field - stores user preferences
  {
    id: "User",
    type: "object",
    title: "User",
    description: "The caregiver/user interacting with the system",
    opened: true,
    properties: {
      AiPersonalityPreferences: {
        id: "AiPersonalityPreferences",
        type: "string",
        title: "AI Personality Preferences",
        description: "User's preferences for how the AI should communicate (tone, style, etc.)",
      },
    },
  },
  // Student memory field - stores AAC user information
  {
    id: "Student",
    type: "object",
    title: "AAC User",
    description: "The AAC user (person being assisted)",
    opened: true,
    properties: {
      People: {
        id: "People",
        type: "array",
        title: "People",
        description: "Important people in the AAC user's life",
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
      Interests: {
        id: "Interests",
        type: "array",
        title: "Interests",
        description: "Things the AAC user enjoys or is interested in",
        items: {
          id: "Interest",
          type: "string",
        },
      },
      Milestones: {
        id: "Milestones",
        type: "array",
        title: "Milestones",
        description: "Important milestones and goals",
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
    },
  },
  // UserStudent memory field - stores relationship-specific information
  {
    id: "UserStudent",
    type: "object",
    title: "User-AAC User Relationship",
    description: "Information specific to this user's relationship with this AAC user",
    opened: true,
    properties: {
      // Can be extended with relationship-specific fields
    },
  },
];

// Agent templates for each mode
const AGENT_TEMPLATES: Record<ChatMode, LocalAgentTemplate> = {
  none: {
    name: "Default Assistant",
    corePrompt: "You are an AAC communication assistant. Help with AAC-related tasks.",
    greeting: "Hello! How can I assist you with AAC today?",
    intelligence: 2,
    memory: 2,
    memoryFields: [...MASTER_MEMORY_FIELDS],
    tools: {},
    library: [],
  },
  board: {
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
};

// ============================================================================
// MEMORY CONTEXT
// ============================================================================

interface MemoryContext {
  user?: User;
  student?: Student;
  userStudent?: UserStudent;
}

interface MemoryValues {
  User?: Record<string, any>;
  Student?: Record<string, any>;
  UserStudent?: Record<string, any>;
}

function buildMemoryValues(context: MemoryContext): MemoryValues {
  const values: MemoryValues = {};
  
  if (context.user) {
    values.User = (context.user.chatMemory as Record<string, any>) || {};
  }
  if (context.student) {
    values.Student = (context.student.chatMemory as Record<string, any>) || {};
  }
  if (context.userStudent) {
    values.UserStudent = (context.userStudent.chatMemory as Record<string, any>) || {};
  }
  
  return values;
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
  const onUpdateMemoryValues = async (newMemoryValues: MemoryValues) => {
    // Save memory values back to the appropriate database objects
    if (context.user && newMemoryValues.User) {
      const currentMemory = (context.user.chatMemory as Record<string, any>) || {};
      const updatedMemory = { ...currentMemory, ...newMemoryValues.User };
      if (JSON.stringify(currentMemory) !== JSON.stringify(updatedMemory)) {
        await updateUserMemory(context.user.id, updatedMemory);
        context.user = { ...context.user, chatMemory: updatedMemory };
      }
    }
    if (context.student && newMemoryValues.Student) {
      const currentMemory = (context.student.chatMemory as Record<string, any>) || {};
      const updatedMemory = { ...currentMemory, ...newMemoryValues.Student };
      if (JSON.stringify(currentMemory) !== JSON.stringify(updatedMemory)) {
        await updateStudentMemory(context.student.id, updatedMemory);
        context.student = { ...context.student, chatMemory: updatedMemory };
      }
    }
    if (context.userStudent && newMemoryValues.UserStudent) {
      const currentMemory = (context.userStudent.chatMemory as Record<string, any>) || {};
      const updatedMemory = { ...currentMemory, ...newMemoryValues.UserStudent };
      if (JSON.stringify(currentMemory) !== JSON.stringify(updatedMemory)) {
        await updateUserStudentMemory(context.userStudent.id, updatedMemory);
        context.userStudent = { ...context.userStudent, chatMemory: updatedMemory };
      }
    }
  };

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
    console.log("onMessage input:", input);
    const { userId, studentId, sessionId, mode, messages, replyType } = input;

    const messageManager = await getMessageManager({
      userId,
      studentId,
      sessionId,
      mode,
    });

    console.log("MessageManager initialized for session:", messageManager.session?.id);

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