// server/repositories/topicRepository.ts
// Repository for topic/library management operations

import {
  topics,
  type LibraryTopic,
  type InsertLibraryTopic,
  type UpdateLibraryTopic,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, isNull, sql } from "drizzle-orm";

export class TopicRepository {
  /**
   * Create a new topic
   */
  async createTopic(insert: InsertLibraryTopic): Promise<LibraryTopic> {
    const [topic] = await db
      .insert(topics)
      .values(insert)
      .returning();
    return topic;
  }

  /**
   * Get a topic by ID
   */
  async getTopicById(id: string): Promise<LibraryTopic | undefined> {
    const [topic] = await db
      .select()
      .from(topics)
      .where(eq(topics.id, id));
    return topic || undefined;
  }

  /**
   * Get topics by parent ID (null for root-level topics)
   */
  async getTopicsByParentId(parentId: string | null): Promise<LibraryTopic[]> {
    if (parentId === null) {
      return await db
        .select()
        .from(topics)
        .where(isNull(topics.parentId))
        .orderBy(topics.title);
    }
    return await db
      .select()
      .from(topics)
      .where(eq(topics.parentId, parentId))
      .orderBy(topics.title);
  }

  /**
   * Get active topics by parent ID (null for root-level topics)
   */
  async getActiveTopicsByParentId(parentId: string | null): Promise<LibraryTopic[]> {
    if (parentId === null) {
      return await db
        .select()
        .from(topics)
        .where(
          and(
            isNull(topics.parentId),
            eq(topics.active, true)
          )
        )
        .orderBy(topics.title);
    }
    return await db
      .select()
      .from(topics)
      .where(
        and(
          eq(topics.parentId, parentId),
          eq(topics.active, true)
        )
      )
      .orderBy(topics.title);
  }

  /**
   * Get all topics
   */
  async getAllTopics(): Promise<LibraryTopic[]> {
    return await db
      .select()
      .from(topics)
      .orderBy(topics.title);
  }

  /**
   * Get all active topics
   */
  async getActiveTopics(): Promise<LibraryTopic[]> {
    return await db
      .select()
      .from(topics)
      .where(eq(topics.active, true))
      .orderBy(topics.title);
  }

  /**
   * Get the full path from root to a topic (array of topics from root to target)
   */
  async getTopicPath(id: string): Promise<LibraryTopic[]> {
    const path: LibraryTopic[] = [];
    let currentId: string | null = id;

    while (currentId) {
      const topic = await this.getTopicById(currentId);
      if (!topic) break;
      path.unshift(topic); // Add to beginning to maintain root-to-leaf order
      currentId = topic.parentId;
    }

    return path;
  }

  /**
   * Check if a title is unique within a parent (for validation)
   */
  async isTitleUniqueInParent(
    title: string,
    parentId: string | null,
    excludeId?: string
  ): Promise<boolean> {
    let query;
    if (parentId === null) {
      query = await db
        .select()
        .from(topics)
        .where(
          and(
            eq(topics.title, title),
            isNull(topics.parentId)
          )
        );
    } else {
      query = await db
        .select()
        .from(topics)
        .where(
          and(
            eq(topics.title, title),
            eq(topics.parentId, parentId)
          )
        );
    }

    // If excluding an ID (for updates), filter it out
    if (excludeId) {
      return !query.some(t => t.id !== excludeId);
    }
    return query.length === 0;
  }

  /**
   * Check if a topic has children
   */
  async hasChildren(id: string): Promise<boolean> {
    const children = await db
      .select()
      .from(topics)
      .where(eq(topics.parentId, id))
      .limit(1);
    return children.length > 0;
  }

  /**
   * Get child count for a topic
   */
  async getChildCount(id: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(topics)
      .where(eq(topics.parentId, id));
    return result[0]?.count || 0;
  }

  /**
   * Update a topic
   */
  async updateTopic(
    id: string,
    updates: UpdateLibraryTopic
  ): Promise<LibraryTopic | undefined> {
    const [updated] = await db
      .update(topics)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(topics.id, id))
      .returning();
    return updated || undefined;
  }

  /**
   * Delete a topic (hard delete)
   * Note: This will fail if topic has children due to FK constraint
   */
  async deleteTopic(id: string): Promise<boolean> {
    const result = await db
      .delete(topics)
      .where(eq(topics.id, id))
      .returning();
    return result.length > 0;
  }

  /**
   * Recursively delete a topic and all its children
   */
  async deleteTopicWithChildren(id: string): Promise<boolean> {
    // Get all children first
    const children = await this.getTopicsByParentId(id);

    // Recursively delete children
    for (const child of children) {
      await this.deleteTopicWithChildren(child.id);
    }

    // Delete this topic
    return await this.deleteTopic(id);
  }
}

export const topicRepository = new TopicRepository();
