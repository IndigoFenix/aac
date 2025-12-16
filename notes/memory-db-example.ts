/**
 * memory-db-example.ts
 * 
 * Example implementation showing how to use memory-db-bridge with Drizzle ORM.
 * This demonstrates a typical use case: an educational platform with students and goals.
 * 
 * Schema structure:
 * - profile (object) - single record per agent instance
 * - students (array) - multiple students per agent instance
 *   - goals (nested array) - multiple goals per student
 * - contacts (map) - key-value pairs with dynamic keys
 */

import { eq, and, asc, desc, sql } from 'drizzle-orm';
import { pgTable, text, integer, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldObjectWithDB,
  type AgentMemoryFieldArrayWithDB,
  type AgentMemoryFieldMapWithDB,
  type MemoryDBOperations,
  type DBOperationContext,
  type MemoryLoadState,
  createMemoryLoadState,
  populateMemoryFromDB,
  processMemoryToolWithDB,
} from './memory-db-bridge';

// ──────────────────────────────────────────────────────────────────────────────
// Drizzle Table Definitions (Example)
// ──────────────────────────────────────────────────────────────────────────────

// Profile table - one per agent instance
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentInstanceId: text('agent_instance_id').notNull().unique(),
  name: text('name'),
  email: text('email'),
  preferences: jsonb('preferences'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Students table - many per agent instance
export const students = pgTable('students', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentInstanceId: text('agent_instance_id').notNull(),
  name: text('name').notNull(),
  grade: integer('grade'),
  email: text('email'),
  notes: text('notes'),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Goals table - many per student
export const goals = pgTable('goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  studentId: uuid('student_id').notNull().references(() => students.id),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('pending'),
  dueDate: timestamp('due_date'),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Contacts table - key-value map
export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentInstanceId: text('agent_instance_id').notNull(),
  key: text('key').notNull(), // The map key (e.g., person's name)
  phone: text('phone'),
  email: text('email'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ──────────────────────────────────────────────────────────────────────────────
// Database Operations Factory
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Creates database operations for a given Drizzle database instance.
 * This factory pattern allows the operations to be created once the DB is available.
 */
export function createDBOperations(db: PgDatabase<any>) {
  
  // ─────────────────────────────────────────────────────────────────────────
  // Profile Operations (object type - single record)
  // ─────────────────────────────────────────────────────────────────────────
  
  const profileOps: MemoryDBOperations<{
    name?: string;
    email?: string;
    preferences?: any;
  }> = {
    read: async (ctx) => {
      const result = await db.select({
        name: profiles.name,
        email: profiles.email,
        preferences: profiles.preferences,
      })
        .from(profiles)
        .where(eq(profiles.agentInstanceId, ctx.all.agentInstanceId))
        .limit(1);
      
      return result[0];
    },

    write: async (ctx, value) => {
      await db.insert(profiles)
        .values({
          agentInstanceId: ctx.all.agentInstanceId,
          ...value,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: profiles.agentInstanceId,
          set: {
            ...value,
            updatedAt: new Date(),
          },
        });
    },

    // No extractChildContext needed - profile is a terminal object
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Students Operations (array type - multiple records)
  // ─────────────────────────────────────────────────────────────────────────
  
  const studentsOps: MemoryDBOperations<{
    id?: string;
    name: string;
    grade?: number;
    email?: string;
    notes?: string;
  }> = {
    list: async (ctx, { offset, limit }) => {
      const items = await db.select({
        id: students.id,
        name: students.name,
        grade: students.grade,
        email: students.email,
        notes: students.notes,
      })
        .from(students)
        .where(eq(students.agentInstanceId, ctx.all.agentInstanceId))
        .orderBy(asc(students.sortOrder), asc(students.createdAt))
        .offset(offset)
        .limit(limit);

      const [countResult] = await db.select({ count: sql<number>`count(*)` })
        .from(students)
        .where(eq(students.agentInstanceId, ctx.all.agentInstanceId));

      return {
        items,
        total: Number(countResult?.count ?? 0),
      };
    },

    get: async (ctx, index) => {
      // For arrays, we get by position in the sorted list
      const items = await db.select({
        id: students.id,
        name: students.name,
        grade: students.grade,
        email: students.email,
        notes: students.notes,
      })
        .from(students)
        .where(eq(students.agentInstanceId, ctx.all.agentInstanceId))
        .orderBy(asc(students.sortOrder), asc(students.createdAt))
        .offset(Number(index))
        .limit(1);

      return items[0];
    },

    add: async (ctx, value, options) => {
      // Get the next sort order
      const [maxOrder] = await db.select({ max: sql<number>`coalesce(max(sort_order), -1)` })
        .from(students)
        .where(eq(students.agentInstanceId, ctx.all.agentInstanceId));
      
      const sortOrder = options?.index ?? ((maxOrder?.max ?? -1) + 1);

      const [created] = await db.insert(students)
        .values({
          agentInstanceId: ctx.all.agentInstanceId,
          name: value.name,
          grade: value.grade,
          email: value.email,
          notes: value.notes,
          sortOrder,
        })
        .returning({
          id: students.id,
          name: students.name,
          grade: students.grade,
          email: students.email,
          notes: students.notes,
        });

      return created;
    },

    update: async (ctx, key, value) => {
      // For arrays, key is the index - we need to find the actual record
      // First get the item at that index
      const items = await db.select({ id: students.id })
        .from(students)
        .where(eq(students.agentInstanceId, ctx.all.agentInstanceId))
        .orderBy(asc(students.sortOrder), asc(students.createdAt))
        .offset(Number(key))
        .limit(1);

      if (!items[0]) {
        throw new Error(`Student at index ${key} not found`);
      }

      const [updated] = await db.update(students)
        .set({
          ...value,
          updatedAt: new Date(),
        })
        .where(eq(students.id, items[0].id))
        .returning({
          id: students.id,
          name: students.name,
          grade: students.grade,
          email: students.email,
          notes: students.notes,
        });

      return updated;
    },

    delete: async (ctx, key) => {
      // Find the item at the index
      const items = await db.select({ id: students.id })
        .from(students)
        .where(eq(students.agentInstanceId, ctx.all.agentInstanceId))
        .orderBy(asc(students.sortOrder), asc(students.createdAt))
        .offset(Number(key))
        .limit(1);

      if (items[0]) {
        await db.delete(students).where(eq(students.id, items[0].id));
      }
    },

    clear: async (ctx) => {
      await db.delete(students)
        .where(eq(students.agentInstanceId, ctx.all.agentInstanceId));
    },

    // IMPORTANT: This extracts the studentId for child queries (goals)
    extractChildContext: (value, key) => ({
      studentId: value.id,
      studentIndex: key,
    }),

    getDBKey: (value) => value.id,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Goals Operations (nested array - scoped to parent student)
  // ─────────────────────────────────────────────────────────────────────────
  
  const goalsOps: MemoryDBOperations<{
    id?: string;
    title: string;
    description?: string;
    status?: string;
    dueDate?: Date;
  }> = {
    list: async (ctx, { offset, limit }) => {
      // Note: ctx.inherited.studentId comes from the parent student
      if (!ctx.inherited.studentId) {
        throw new Error('studentId required for goals query');
      }

      const items = await db.select({
        id: goals.id,
        title: goals.title,
        description: goals.description,
        status: goals.status,
        dueDate: goals.dueDate,
      })
        .from(goals)
        .where(eq(goals.studentId, ctx.inherited.studentId))
        .orderBy(asc(goals.sortOrder), asc(goals.createdAt))
        .offset(offset)
        .limit(limit);

      const [countResult] = await db.select({ count: sql<number>`count(*)` })
        .from(goals)
        .where(eq(goals.studentId, ctx.inherited.studentId));

      return {
        items,
        total: Number(countResult?.count ?? 0),
      };
    },

    get: async (ctx, index) => {
      if (!ctx.inherited.studentId) {
        throw new Error('studentId required for goals query');
      }

      const items = await db.select({
        id: goals.id,
        title: goals.title,
        description: goals.description,
        status: goals.status,
        dueDate: goals.dueDate,
      })
        .from(goals)
        .where(eq(goals.studentId, ctx.inherited.studentId))
        .orderBy(asc(goals.sortOrder), asc(goals.createdAt))
        .offset(Number(index))
        .limit(1);

      return items[0];
    },

    add: async (ctx, value, options) => {
      if (!ctx.inherited.studentId) {
        throw new Error('studentId required for creating goal');
      }

      const [maxOrder] = await db.select({ max: sql<number>`coalesce(max(sort_order), -1)` })
        .from(goals)
        .where(eq(goals.studentId, ctx.inherited.studentId));
      
      const sortOrder = options?.index ?? ((maxOrder?.max ?? -1) + 1);

      const [created] = await db.insert(goals)
        .values({
          studentId: ctx.inherited.studentId, // Automatically set from context!
          title: value.title,
          description: value.description,
          status: value.status ?? 'pending',
          dueDate: value.dueDate,
          sortOrder,
        })
        .returning({
          id: goals.id,
          title: goals.title,
          description: goals.description,
          status: goals.status,
          dueDate: goals.dueDate,
        });

      return created;
    },

    update: async (ctx, key, value) => {
      if (!ctx.inherited.studentId) {
        throw new Error('studentId required for updating goal');
      }

      // Find the goal at the index
      const items = await db.select({ id: goals.id })
        .from(goals)
        .where(eq(goals.studentId, ctx.inherited.studentId))
        .orderBy(asc(goals.sortOrder), asc(goals.createdAt))
        .offset(Number(key))
        .limit(1);

      if (!items[0]) {
        throw new Error(`Goal at index ${key} not found`);
      }

      const [updated] = await db.update(goals)
        .set({
          ...value,
          updatedAt: new Date(),
        })
        .where(eq(goals.id, items[0].id))
        .returning({
          id: goals.id,
          title: goals.title,
          description: goals.description,
          status: goals.status,
          dueDate: goals.dueDate,
        });

      return updated;
    },

    delete: async (ctx, key) => {
      if (!ctx.inherited.studentId) {
        throw new Error('studentId required for deleting goal');
      }

      const items = await db.select({ id: goals.id })
        .from(goals)
        .where(eq(goals.studentId, ctx.inherited.studentId))
        .orderBy(asc(goals.sortOrder), asc(goals.createdAt))
        .offset(Number(key))
        .limit(1);

      if (items[0]) {
        await db.delete(goals).where(eq(goals.id, items[0].id));
      }
    },

    clear: async (ctx) => {
      if (!ctx.inherited.studentId) {
        throw new Error('studentId required for clearing goals');
      }

      await db.delete(goals)
        .where(eq(goals.studentId, ctx.inherited.studentId));
    },

    getDBKey: (value) => value.id,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Contacts Operations (map type - keyed by contact name)
  // ─────────────────────────────────────────────────────────────────────────
  
  const contactsOps: MemoryDBOperations<{
    phone?: string;
    email?: string;
    notes?: string;
  }> = {
    list: async (ctx, { offset, limit }) => {
      const items = await db.select({
        key: contacts.key,
        phone: contacts.phone,
        email: contacts.email,
        notes: contacts.notes,
      })
        .from(contacts)
        .where(eq(contacts.agentInstanceId, ctx.all.agentInstanceId))
        .orderBy(asc(contacts.key))
        .offset(offset)
        .limit(limit);

      const [countResult] = await db.select({ count: sql<number>`count(*)` })
        .from(contacts)
        .where(eq(contacts.agentInstanceId, ctx.all.agentInstanceId));

      return {
        items: items.map(({ key, ...rest }) => rest),
        keys: items.map(item => item.key),
        total: Number(countResult?.count ?? 0),
      };
    },

    get: async (ctx, key) => {
      const items = await db.select({
        phone: contacts.phone,
        email: contacts.email,
        notes: contacts.notes,
      })
        .from(contacts)
        .where(and(
          eq(contacts.agentInstanceId, ctx.all.agentInstanceId),
          eq(contacts.key, String(key))
        ))
        .limit(1);

      return items[0];
    },

    add: async (ctx, value, options) => {
      if (!options?.key) {
        throw new Error('Key required for adding contact');
      }

      const [created] = await db.insert(contacts)
        .values({
          agentInstanceId: ctx.all.agentInstanceId,
          key: options.key,
          phone: value.phone,
          email: value.email,
          notes: value.notes,
        })
        .returning({
          phone: contacts.phone,
          email: contacts.email,
          notes: contacts.notes,
        });

      return created;
    },

    upsert: async (ctx, value, key) => {
      if (!key) {
        throw new Error('Key required for upserting contact');
      }

      const [result] = await db.insert(contacts)
        .values({
          agentInstanceId: ctx.all.agentInstanceId,
          key: String(key),
          phone: value.phone,
          email: value.email,
          notes: value.notes,
        })
        .onConflictDoUpdate({
          target: [contacts.agentInstanceId, contacts.key],
          set: {
            phone: value.phone,
            email: value.email,
            notes: value.notes,
            updatedAt: new Date(),
          },
        })
        .returning({
          phone: contacts.phone,
          email: contacts.email,
          notes: contacts.notes,
        });

      return result;
    },

    delete: async (ctx, key) => {
      await db.delete(contacts)
        .where(and(
          eq(contacts.agentInstanceId, ctx.all.agentInstanceId),
          eq(contacts.key, String(key))
        ));
    },

    rename: async (ctx, oldKey, newKey) => {
      await db.update(contacts)
        .set({ key: newKey, updatedAt: new Date() })
        .where(and(
          eq(contacts.agentInstanceId, ctx.all.agentInstanceId),
          eq(contacts.key, oldKey)
        ));
    },

    clear: async (ctx) => {
      await db.delete(contacts)
        .where(eq(contacts.agentInstanceId, ctx.all.agentInstanceId));
    },
  };

  return {
    profileOps,
    studentsOps,
    goalsOps,
    contactsOps,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Memory Field Schema Definition (with DB operations)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Creates the memory field definitions with database operations attached.
 */
export function createMemoryFields(db: PgDatabase<any>): AgentMemoryFieldWithDB[] {
  const ops = createDBOperations(db);

  // Goal schema (nested inside student)
  const goalSchema: AgentMemoryFieldObjectWithDB = {
    id: 'goal',
    type: 'object',
    properties: {
      id: { id: 'id', type: 'string', description: 'Database ID' },
      title: { id: 'title', type: 'string', description: 'Goal title' },
      description: { id: 'description', type: 'string', description: 'Detailed description' },
      status: { 
        id: 'status', 
        type: 'string', 
        description: 'Current status',
        enum: ['pending', 'in_progress', 'completed', 'cancelled']
      },
      dueDate: { id: 'dueDate', type: 'string', format: 'date-time', description: 'Due date' },
    },
    required: ['title'],
  };

  // Student schema (with nested goals array)
  const studentSchema: AgentMemoryFieldObjectWithDB = {
    id: 'student',
    type: 'object',
    properties: {
      id: { id: 'id', type: 'string', description: 'Database ID' },
      name: { id: 'name', type: 'string', description: 'Student name' },
      grade: { id: 'grade', type: 'integer', description: 'Grade level', minimum: 1, maximum: 12 },
      email: { id: 'email', type: 'string', format: 'email', description: 'Email address' },
      notes: { id: 'notes', type: 'string', description: 'Additional notes' },
      goals: {
        id: 'goals',
        type: 'array',
        description: 'Student goals and objectives',
        items: goalSchema,
        db: ops.goalsOps, // Goals have their own DB operations!
      } as AgentMemoryFieldArrayWithDB,
    },
    required: ['name'],
  };

  // Contact value schema (for map values)
  const contactValueSchema: AgentMemoryFieldObjectWithDB = {
    id: 'contactValue',
    type: 'object',
    properties: {
      phone: { id: 'phone', type: 'string', description: 'Phone number' },
      email: { id: 'email', type: 'string', format: 'email', description: 'Email address' },
      notes: { id: 'notes', type: 'string', description: 'Notes about this contact' },
    },
  };

  // Top-level memory fields
  const memoryFields: AgentMemoryFieldWithDB[] = [
    // Profile - object type, single record
    {
      id: 'profile',
      type: 'object',
      title: 'User Profile',
      description: 'Basic profile information',
      opened: true, // Visible by default
      properties: {
        name: { id: 'name', type: 'string', description: 'Display name' },
        email: { id: 'email', type: 'string', format: 'email', description: 'Email address' },
        preferences: { id: 'preferences', type: 'object', description: 'User preferences', properties: {}, additionalProperties: true },
      },
      db: ops.profileOps,
    } as AgentMemoryFieldObjectWithDB,

    // Students - array type, multiple records
    {
      id: 'students',
      type: 'array',
      title: 'Students',
      description: 'List of students being tracked',
      opened: true, // Visible by default
      items: studentSchema,
      db: ops.studentsOps,
    } as AgentMemoryFieldArrayWithDB,

    // Contacts - map type, keyed by name
    {
      id: 'contacts',
      type: 'map',
      title: 'Contacts',
      description: 'Contact information keyed by name',
      opened: false, // Hidden by default, AI must explicitly view
      values: contactValueSchema,
      db: ops.contactsOps,
    } as AgentMemoryFieldMapWithDB,
  ];

  return memoryFields;
}

// ──────────────────────────────────────────────────────────────────────────────
// Usage Example
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Example of how to use the memory system with database integration.
 */
export async function exampleUsage(db: PgDatabase<any>) {
  // Create memory fields with DB operations
  const memoryFields = createMemoryFields(db);

  // Initialize state
  let memoryValues: any = {};
  let memoryState = { visible: [], page: {} };
  let loadState = createMemoryLoadState();

  // Base context - identifies which agent instance we're working with
  const baseContext = {
    agentInstanceId: 'agent-123',
    userId: 'user-456', // Optional, for user-specific data
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1: Populate memory from database on conversation start
  // ─────────────────────────────────────────────────────────────────────────
  
  console.log('Loading visible memory from database...');
  
  const populateResult = await populateMemoryFromDB(
    memoryFields,
    memoryValues,
    memoryState,
    loadState,
    { baseContext, defaultLimit: 50 }
  );

  memoryValues = populateResult.memoryValues;
  loadState = populateResult.loadState;

  console.log('Loaded paths:', populateResult.loadedPaths);
  console.log('Memory values:', JSON.stringify(memoryValues, null, 2));

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2: Process AI memory operations with DB sync
  // ─────────────────────────────────────────────────────────────────────────

  // Import the original processor from memory-system.ts
  // const { processMemoryToolResponse } = await import('./memory-system');

  // Example: AI wants to add a new student
  const addStudentOp = {
    ops: [{
      action: 'add' as const,
      path: '/students',
      value: {
        name: 'Alice Johnson',
        grade: 10,
        email: 'alice@school.edu',
      },
    }]
  };

  console.log('\nProcessing: Add student...');
  
  // Note: In real usage, you'd import processMemoryToolResponse from memory-system.ts
  // and pass it as the originalProcessor parameter
  /*
  const result = await processMemoryToolWithDB(
    memoryFields,
    memoryValues,
    memoryState,
    loadState,
    addStudentOp,
    baseContext,
    processMemoryToolResponse
  );

  memoryValues = result.updatedMemoryValues;
  memoryState = result.updatedMemoryState;
  loadState = result.updatedLoadState;

  console.log('Operation results:', result.results);
  */

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3: AI views nested data (goals for a student)
  // ─────────────────────────────────────────────────────────────────────────

  // First, the student must be in memory (from step 1 or 2)
  // When AI views /students/0/goals, the system:
  // 1. Resolves the path to find the goals array schema
  // 2. Extracts studentId from the student at index 0
  // 3. Uses that studentId to query the goals table

  const viewGoalsOp = {
    ops: [{
      action: 'view' as const,
      path: '/students/0/goals',
    }]
  };

  console.log('\nProcessing: View student goals...');
  // Similar processing as above...

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4: AI adds a goal to a specific student
  // ─────────────────────────────────────────────────────────────────────────

  // The context flow:
  // - Path: /students/0/goals
  // - System resolves /students/0 and extracts studentId from that record
  // - When add() is called on goals, ctx.inherited.studentId is available
  // - The goal is created with the correct studentId automatically

  const addGoalOp = {
    ops: [{
      action: 'add' as const,
      path: '/students/0/goals',
      value: {
        title: 'Complete algebra homework',
        description: 'Chapter 5 exercises',
        status: 'pending',
      },
    }]
  };

  console.log('\nProcessing: Add goal to student...');
  // Similar processing...

  console.log('\nFinal memory state:', JSON.stringify(memoryValues, null, 2));
}

// ──────────────────────────────────────────────────────────────────────────────
// Integration with ChatMessageManager
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Example of how to integrate with the existing ChatMessageManager.
 * This shows the modifications needed in chat-handler.ts.
 */
export function createMemoryIntegration(db: PgDatabase<any>, agentInstanceId: string) {
  const memoryFields = createMemoryFields(db);
  let loadState = createMemoryLoadState();

  const baseContext = { agentInstanceId };

  return {
    memoryFields,
    loadState,
    baseContext,

    /**
     * Call this when initializing a chat session to load visible memory.
     */
    async initializeMemory(memoryValues: any, memoryState: any) {
      return populateMemoryFromDB(
        memoryFields,
        memoryValues,
        memoryState,
        loadState,
        { baseContext }
      );
    },

    /**
     * Call this in the tool registry when processing manageMemory tool calls.
     */
    async processMemoryTool(
      memoryValues: any,
      memoryState: any,
      input: any,
      originalProcessor: any
    ) {
      return processMemoryToolWithDB(
        memoryFields,
        memoryValues,
        memoryState,
        loadState,
        input,
        baseContext,
        originalProcessor
      );
    },

    /**
     * Mark specific paths as needing refresh (e.g., after external changes).
     */
    invalidatePaths(paths: string[]) {
      for (const path of paths) {
        loadState.stale.add(path);
      }
    },
  };
}