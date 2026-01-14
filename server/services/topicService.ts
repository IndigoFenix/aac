// server/services/topicService.ts
// Business logic for topic/library management

import { topicRepository } from "../repositories/topicRepository";
import {
  type LibraryTopic,
  type InsertLibraryTopic,
  type UpdateLibraryTopic,
} from "@shared/schema";

export interface TopicWithChildren extends LibraryTopic {
  children?: LibraryTopic[];
  childCount?: number;
}

export class TopicService {
  /**
   * Create a new topic
   */
  async createTopic(
    data: InsertLibraryTopic
  ): Promise<{ success: boolean; topic?: LibraryTopic; error?: string }> {
    // Check for unique title within parent
    const isUnique = await topicRepository.isTitleUniqueInParent(
      data.title,
      data.parentId ?? null
    );
    if (!isUnique) {
      return { success: false, error: "A topic with this title already exists at this level" };
    }

    // If parentId is provided, verify parent exists
    if (data.parentId) {
      const parent = await topicRepository.getTopicById(data.parentId);
      if (!parent) {
        return { success: false, error: "Parent topic not found" };
      }
    }

    try {
      const topic = await topicRepository.createTopic(data);
      return { success: true, topic };
    } catch (error: any) {
      console.error("Error creating topic:", error);
      if (error.code === '23505') { // Unique constraint violation
        return { success: false, error: "A topic with this title already exists at this level" };
      }
      return { success: false, error: "Failed to create topic" };
    }
  }

  /**
   * Get a topic by ID
   */
  async getTopicById(
    id: string
  ): Promise<{ success: boolean; topic?: LibraryTopic; error?: string }> {
    const topic = await topicRepository.getTopicById(id);
    if (!topic) {
      return { success: false, error: "Topic not found" };
    }
    return { success: true, topic };
  }

  /**
   * Get a topic with its children and path
   */
  async getTopicWithDetails(
    id: string
  ): Promise<{ success: boolean; topic?: TopicWithChildren; path?: LibraryTopic[]; error?: string }> {
    const topic = await topicRepository.getTopicById(id);
    if (!topic) {
      return { success: false, error: "Topic not found" };
    }

    const children = await topicRepository.getTopicsByParentId(id);
    const path = await topicRepository.getTopicPath(id);

    return {
      success: true,
      topic: {
        ...topic,
        children,
        childCount: children.length,
      },
      path,
    };
  }

  /**
   * Get topics by parent ID (null for root topics)
   */
  async getTopicsByParentId(
    parentId: string | null
  ): Promise<{ success: boolean; topics?: LibraryTopic[]; error?: string }> {
    try {
      const topics = await topicRepository.getTopicsByParentId(parentId);
      return { success: true, topics };
    } catch (error: any) {
      console.error("Error getting topics by parent:", error);
      return { success: false, error: "Failed to get topics" };
    }
  }

  /**
   * Get active topics by parent ID (for AI/user view)
   */
  async getActiveTopicsByParentId(
    parentId: string | null
  ): Promise<{ success: boolean; topics?: LibraryTopic[]; error?: string }> {
    try {
      const topics = await topicRepository.getActiveTopicsByParentId(parentId);
      return { success: true, topics };
    } catch (error: any) {
      console.error("Error getting active topics:", error);
      return { success: false, error: "Failed to get active topics" };
    }
  }

  /**
   * Get an active topic by ID (for AI/user view)
   */
  async getActiveTopicById(
    id: string
  ): Promise<{ success: boolean; topic?: TopicWithChildren; path?: LibraryTopic[]; error?: string }> {
    const topic = await topicRepository.getTopicById(id);
    if (!topic) {
      return { success: false, error: "Topic not found" };
    }
    if (!topic.active) {
      return { success: false, error: "Topic not found" };
    }

    const children = await topicRepository.getActiveTopicsByParentId(id);
    const path = await topicRepository.getTopicPath(id);

    // Filter path to only include active topics
    const activePath = path.filter(t => t.active);

    return {
      success: true,
      topic: {
        ...topic,
        children,
        childCount: children.length,
      },
      path: activePath,
    };
  }

  /**
   * Get all topics (for admin)
   */
  async getAllTopics(): Promise<{ success: boolean; topics?: LibraryTopic[]; error?: string }> {
    try {
      const topics = await topicRepository.getAllTopics();
      return { success: true, topics };
    } catch (error: any) {
      console.error("Error getting all topics:", error);
      return { success: false, error: "Failed to get topics" };
    }
  }

  /**
   * Get topic path
   */
  async getTopicPath(
    id: string
  ): Promise<{ success: boolean; path?: LibraryTopic[]; error?: string }> {
    try {
      const path = await topicRepository.getTopicPath(id);
      return { success: true, path };
    } catch (error: any) {
      console.error("Error getting topic path:", error);
      return { success: false, error: "Failed to get topic path" };
    }
  }

  /**
   * Update a topic
   */
  async updateTopic(
    id: string,
    updates: UpdateLibraryTopic
  ): Promise<{ success: boolean; topic?: LibraryTopic; error?: string }> {
    // Verify topic exists
    const existing = await topicRepository.getTopicById(id);
    if (!existing) {
      return { success: false, error: "Topic not found" };
    }

    // If title is changing, check uniqueness
    if (updates.title && updates.title !== existing.title) {
      const parentId = updates.parentId !== undefined ? updates.parentId : existing.parentId;
      const isUnique = await topicRepository.isTitleUniqueInParent(
        updates.title,
        parentId,
        id
      );
      if (!isUnique) {
        return { success: false, error: "A topic with this title already exists at this level" };
      }
    }

    // If parentId is changing, verify new parent exists
    if (updates.parentId !== undefined && updates.parentId !== existing.parentId) {
      if (updates.parentId !== null) {
        const parent = await topicRepository.getTopicById(updates.parentId);
        if (!parent) {
          return { success: false, error: "Parent topic not found" };
        }
        // Prevent circular references
        if (updates.parentId === id) {
          return { success: false, error: "A topic cannot be its own parent" };
        }
      }
    }

    try {
      const topic = await topicRepository.updateTopic(id, updates);
      return { success: true, topic };
    } catch (error: any) {
      console.error("Error updating topic:", error);
      if (error.code === '23505') {
        return { success: false, error: "A topic with this title already exists at this level" };
      }
      return { success: false, error: "Failed to update topic" };
    }
  }

  /**
   * Delete a topic (hard delete)
   */
  async deleteTopic(
    id: string,
    cascade: boolean = false
  ): Promise<{ success: boolean; error?: string }> {
    // Verify topic exists
    const existing = await topicRepository.getTopicById(id);
    if (!existing) {
      return { success: false, error: "Topic not found" };
    }

    // Check for children
    const hasChildren = await topicRepository.hasChildren(id);
    if (hasChildren && !cascade) {
      return { success: false, error: "Cannot delete topic with children. Delete children first or use cascade delete." };
    }

    try {
      let deleted: boolean;
      if (cascade) {
        deleted = await topicRepository.deleteTopicWithChildren(id);
      } else {
        deleted = await topicRepository.deleteTopic(id);
      }
      return { success: deleted, error: deleted ? undefined : "Failed to delete topic" };
    } catch (error: any) {
      console.error("Error deleting topic:", error);
      return { success: false, error: "Failed to delete topic" };
    }
  }
}

export const topicService = new TopicService();
