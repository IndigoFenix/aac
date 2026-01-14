/**
 * topic-memory-schema.ts
 *
 * Memory field schema and database operations for the Knowledge Library (Topics).
 * Provides read-only access for the AI to browse library topics.
 *
 * This file defines:
 * 1. Memory field definitions for topic hierarchy
 * 2. Database operations using topicService (READ-ONLY)
 * 3. System prompt for library access
 *
 * Structure:
 * - Context_Library (map) - top-level topics, keyed by title
 *   - subtopics (map) - nested subtopics, keyed by title
 *     - subtopics (map) - recursively nested...
 *   - content (string) - the topic's content text
 *
 * AI can navigate by viewing paths like:
 * - /Context_Library - list all top-level topics
 * - /Context_Library/{TopicTitle} - view a specific topic's content and subtopics
 * - /Context_Library/{ParentTitle}/{ChildTitle} - view nested subtopic
 */

import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldObjectWithDB,
  type AgentMemoryFieldMapWithDB,
  type MemoryDBOperations,
  type DBOperationContext,
  type ListResult,
} from "../chat/memory-types";

import { topicService } from "../topicService";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Transform database topic to memory value
 */
function toMemoryValue(topic: any): any {
  if (!topic) return topic;
  return {
    id: topic.id,
    title: topic.title,
    content: topic.content || "",
    active: topic.active,
    // Initialize empty subtopics map for nested access
    subtopics: {},
  };
}

// ============================================================================
// DATABASE OPERATIONS - TOPICS (READ-ONLY)
// ============================================================================

/**
 * Topics operations (MAP) - active topics keyed by title
 * READ-ONLY: AI cannot create, update, or delete topics
 */
const topicsOps: MemoryDBOperations<any> = {
  /**
   * List topics at the current level (root or under parent)
   */
  list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
    // Get parentId from context (null for root-level)
    const parentId = ctx.all.topicId ?? null;

    const result = await topicService.getActiveTopicsByParentId(parentId);

    if (!result.success || !result.topics) {
      throw new Error(result.error || "Failed to get topics");
    }

    // Apply pagination
    const paged = result.topics.slice(offset, offset + limit);
    const items = paged.map(toMemoryValue);

    // Use titles as keys for AI-friendly access
    const keys = paged.map((t) => t.title);

    return {
      items,
      total: result.topics.length,
      keys,
    };
  },

  /**
   * Get a specific topic by title
   */
  get: async (ctx, key) => {
    const keyStr = String(key);
    const parentId = ctx.all.topicId ?? null;

    // Get topics at this level and find by title
    const result = await topicService.getActiveTopicsByParentId(parentId);
    if (!result.success || !result.topics) {
      return undefined;
    }

    // Find by title (case-insensitive)
    const topic = result.topics.find(
      (t) => t.title.toLowerCase() === keyStr.toLowerCase()
    );

    return topic ? toMemoryValue(topic) : undefined;
  },

  /**
   * Convert database record to memory format
   */
  fromDB: (record) => toMemoryValue(record),

  /**
   * Extract child context for nested operations
   * When viewing a topic, set its ID as the parent for subtopics
   */
  extractChildContext: (value, key) => ({
    // Set the current topic's ID for child operations
    topicId: value?.id,
    topicTitle: value?.title || key,
  }),

  /**
   * Get database key from value
   */
  getDBKey: (value) => value?.title,
};

// ============================================================================
// MEMORY FIELD SCHEMAS
// ============================================================================

/**
 * Topic schema - recursive structure for nested topics
 */
const topicSchema: AgentMemoryFieldObjectWithDB = {
  id: "topic",
  type: "object",
  opened: true,
  properties: {
    id: {
      id: "id",
      type: "string",
      description: "Topic UUID (for internal reference)",
    },
    title: {
      id: "title",
      type: "string",
      opened: true,
      description: "Topic title",
    },
    content: {
      id: "content",
      type: "string",
      description:
        "Topic content - knowledge base text for AI reference. May be empty if topic is just a category.",
    },
    subtopics: {
      id: "subtopics",
      type: "map",
      title: "Subtopics",
      description:
        "Nested subtopics under this topic. View to see available subtopics.",
      opened: true,
      // Self-reference through recursion - will use topicsOps
      values: {
        id: "subtopic",
        type: "object",
        opened: true,
        properties: {
          id: { id: "id", type: "string" },
          title: { id: "title", type: "string", opened: true },
          content: { id: "content", type: "string" },
          subtopics: {
            id: "subtopics",
            type: "map",
            title: "Subtopics",
            description: "Further nested subtopics",
            opened: true,
            values: {} as AgentMemoryFieldObjectWithDB, // Recursive placeholder
            db: topicsOps,
          } as AgentMemoryFieldMapWithDB,
        },
      },
      db: topicsOps,
    } as AgentMemoryFieldMapWithDB,
  },
};

// ============================================================================
// MAIN LIBRARY MEMORY FIELD
// ============================================================================

/**
 * Library map - the main entry point for knowledge library access
 */
export const LIBRARY_TOPICS_FIELD: AgentMemoryFieldMapWithDB = {
  id: "Context_Library",
  type: "map",
  title: "Knowledge Library",
  description:
    "Knowledge base topics organized hierarchically. Browse by viewing topics and their subtopics. Each topic may contain educational content and/or nested subtopics.",
  opened: true,
  values: topicSchema,
  db: topicsOps,
};

// ============================================================================
// SYSTEM PROMPT FOR LIBRARY ACCESS
// ============================================================================

export const LIBRARY_SYSTEM_PROMPT = `
You have access to a Knowledge Library containing reference information organized by topics.

**Browsing the Library**
- View /Context_Library to see available top-level topics
- View a specific topic to see its content and subtopics
- Navigate into subtopics for more detailed information

**Important Notes**
- The library is READ-ONLY - you cannot modify topics
- Topics may have content (knowledge text) and/or subtopics
- Content is provided by administrators for AI reference
- Use this information to inform your responses when relevant
`;

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * Get the library memory fields to add to the memory schema
 */
export function getLibraryMemoryFields(
  masterFields: AgentMemoryFieldWithDB[]
): AgentMemoryFieldWithDB[] {
  return [...masterFields, LIBRARY_TOPICS_FIELD];
}
