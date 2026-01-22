/**
 * AAC Session Service
 *
 * Manages real-time AAC sessions with a hybrid in-memory + database pattern.
 * Each student can have their own active session (supporting multiple devices).
 *
 * Pattern:
 * - In-memory cache for fast context updates during active sessions
 * - Periodic database persistence for durability
 * - Immediate persistence for messages and credit changes
 * - Automatic eviction of stale sessions from cache
 */

import {
  type AACSession,
  type AACSessionContext,
  type AACMessage,
  type InsertAACSession,
  students,
  users,
  userStudents,
} from "@shared/schema";
import { aacSessionRepository } from "../../repositories/aacSessionRepository";
import { db } from "../../db";
import { eq, sql } from "drizzle-orm";

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Time after which an inactive session is evicted from cache (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** How often to check for stale cache entries (1 minute) */
const CLEANUP_INTERVAL_MS = 60 * 1000;

/** Debounce delay for context persistence (2 seconds) */
const PERSIST_DEBOUNCE_MS = 2000;

// ============================================================================
// TYPES
// ============================================================================

interface CachedSession {
  session: AACSession;
  context: AACSessionContext;
  conversationHistory: AACMessage[];
  lastAccess: number;
  dirty: boolean;
  creditsAccumulated: number; // Credits accumulated since last persist
}

// ============================================================================
// IN-MEMORY CACHE
// ============================================================================

/** In-memory cache keyed by studentId */
const sessionCache = new Map<string, CachedSession>();

/** Timers for debounced persistence */
const persistTimers = new Map<string, NodeJS.Timeout>();

/** Cleanup interval handle */
let cleanupInterval: NodeJS.Timeout | null = null;

// ============================================================================
// SESSION SERVICE CLASS
// ============================================================================

export class AACSessionService {
  // ==========================================================================
  // SESSION LIFECYCLE
  // ==========================================================================

  /**
   * Get or create an active session for a student.
   * Checks cache first, then database, creates new if none exists.
   */
  async getSession(studentId: string, userId?: string): Promise<AACSession> {
    // 1. Check in-memory cache first
    const cached = sessionCache.get(studentId);
    if (cached && !this.isExpired(cached)) {
      cached.lastAccess = Date.now();
      return this.buildSessionFromCache(cached);
    }

    // 2. Check database for existing active/paused session
    let session = await aacSessionRepository.getActiveOrPausedSessionByStudentId(
      studentId
    );

    // 3. Create new session if none exists
    if (!session) {
      session = await aacSessionRepository.createSession({
        studentId,
        userId,
        context: {},
        conversationHistory: [],
        status: "active",
        started: new Date(),
        lastActivity: new Date(),
      });
    }

    // 4. If session was paused, resume it
    if (session.status === "paused") {
      session = (await aacSessionRepository.resumeSession(session.id))!;
    }

    // 5. Cache in memory
    this.cacheSession(session);

    return session;
  }

  /**
   * Get session by ID (for direct access)
   */
  async getSessionById(sessionId: string): Promise<AACSession | undefined> {
    // Check if any cached session matches
    for (const [, cached] of Array.from(sessionCache.entries())) {
      if (cached.session.id === sessionId) {
        cached.lastAccess = Date.now();
        return this.buildSessionFromCache(cached);
      }
    }

    // Fallback to database
    return aacSessionRepository.getSession(sessionId);
  }

  /**
   * End a session (persists and removes from cache)
   */
  async endSession(studentId: string): Promise<AACSession | undefined> {
    const cached = sessionCache.get(studentId);
    if (cached) {
      // Persist any pending changes
      await this.persistSession(studentId, true);
      // Remove from cache
      sessionCache.delete(studentId);
      // Cancel any pending persist timer
      this.cancelPersistTimer(studentId);
    }

    // Update database
    const session = await aacSessionRepository.getActiveSessionByStudentId(studentId);
    if (session) {
      return aacSessionRepository.endSession(session.id);
    }
    return undefined;
  }

  /**
   * Pause a session (keeps in cache but marks as paused)
   */
  async pauseSession(studentId: string): Promise<AACSession | undefined> {
    const cached = sessionCache.get(studentId);
    if (cached) {
      await this.persistSession(studentId, true);
    }

    const session = await aacSessionRepository.getActiveSessionByStudentId(studentId);
    if (session) {
      const paused = await aacSessionRepository.pauseSession(session.id);
      if (cached && paused) {
        cached.session = paused;
      }
      return paused;
    }
    return undefined;
  }

  // ==========================================================================
  // CONTEXT OPERATIONS (Frequent Updates)
  // ==========================================================================

  /**
   * Update session context (in-memory, debounced DB persistence)
   */
  async updateContext(
    studentId: string,
    updates: Partial<AACSessionContext>
  ): Promise<void> {
    const cached = sessionCache.get(studentId);
    if (!cached) {
      throw new Error(
        `No active session for student ${studentId} - call getSession first`
      );
    }

    // Merge updates into cached context
    cached.context = { ...cached.context, ...updates };
    cached.dirty = true;
    cached.lastAccess = Date.now();

    // Schedule debounced DB persistence
    this.schedulePersist(studentId);
  }

  /**
   * Get current context from cache or database
   */
  async getContext(studentId: string): Promise<AACSessionContext | undefined> {
    const cached = sessionCache.get(studentId);
    if (cached) {
      cached.lastAccess = Date.now();
      return cached.context;
    }

    // Fallback to database
    const session = await aacSessionRepository.getActiveSessionByStudentId(studentId);
    return (session?.context as AACSessionContext) || undefined;
  }

  // ==========================================================================
  // CONVERSATION OPERATIONS (Immediate Persistence)
  // ==========================================================================

  /**
   * Add a message to the conversation history
   * Messages are persisted immediately for durability
   */
  async addMessage(studentId: string, message: AACMessage): Promise<void> {
    const cached = sessionCache.get(studentId);
    if (!cached) {
      throw new Error(
        `No active session for student ${studentId} - call getSession first`
      );
    }

    cached.conversationHistory.push(message);
    cached.lastAccess = Date.now();

    // Messages are important - persist immediately
    await this.persistSession(studentId, true);
  }

  /**
   * Get conversation history
   */
  async getConversationHistory(studentId: string): Promise<AACMessage[]> {
    const cached = sessionCache.get(studentId);
    if (cached) {
      cached.lastAccess = Date.now();
      return [...cached.conversationHistory];
    }

    // Fallback to database
    const session = await aacSessionRepository.getActiveSessionByStudentId(studentId);
    return (session?.conversationHistory as AACMessage[]) || [];
  }

  /**
   * Get recent messages (for context building)
   */
  async getRecentMessages(studentId: string, limit: number = 6): Promise<AACMessage[]> {
    const history = await this.getConversationHistory(studentId);
    return history.slice(-limit);
  }

  /**
   * Clear conversation history (start fresh)
   */
  async clearConversation(studentId: string): Promise<void> {
    const cached = sessionCache.get(studentId);
    if (cached) {
      cached.conversationHistory = [];
      cached.dirty = true;
      await this.persistSession(studentId, true);
    } else {
      const session = await aacSessionRepository.getActiveSessionByStudentId(studentId);
      if (session) {
        await aacSessionRepository.updateSessionConversation(session.id, []);
      }
    }
  }

  // ==========================================================================
  // CREDIT TRACKING
  // ==========================================================================

  /**
   * Track credit usage for AAC operations
   * Updates both the session and the student/user entities
   */
  async addCredits(
    studentId: string,
    credits: number,
    userId?: string
  ): Promise<void> {
    const cached = sessionCache.get(studentId);
    if (cached) {
      cached.creditsAccumulated += credits;
      cached.session.creditsUsed += credits;
      cached.dirty = true;
      cached.lastAccess = Date.now();
    }

    // Update session credits
    const session = cached?.session ||
      await aacSessionRepository.getActiveSessionByStudentId(studentId);
    if (session) {
      await aacSessionRepository.updateSessionCredits(session.id, credits);
    }

    // Update student's total credits
    await db
      .update(students)
      .set({
        chatCreditsUsed: sql`${students.chatCreditsUsed} + ${credits}`,
        chatCreditsUpdated: new Date(),
      })
      .where(eq(students.id, studentId));

    // If we have a userId, also track on user
    if (userId) {
      await db
        .update(users)
        .set({
          chatCreditsUsed: sql`${users.chatCreditsUsed} + ${credits}`,
          chatCreditsUpdated: new Date(),
        })
        .where(eq(users.id, userId));
    }
  }

  /**
   * Get total credits used in current session
   */
  async getSessionCredits(studentId: string): Promise<number> {
    const cached = sessionCache.get(studentId);
    if (cached) {
      return cached.session.creditsUsed;
    }

    const session = await aacSessionRepository.getActiveSessionByStudentId(studentId);
    return session?.creditsUsed || 0;
  }

  // ==========================================================================
  // INTERNAL: CACHE MANAGEMENT
  // ==========================================================================

  private cacheSession(session: AACSession): void {
    sessionCache.set(session.studentId, {
      session,
      context: (session.context as AACSessionContext) || {},
      conversationHistory: (session.conversationHistory as AACMessage[]) || [],
      lastAccess: Date.now(),
      dirty: false,
      creditsAccumulated: 0,
    });
  }

  private buildSessionFromCache(cached: CachedSession): AACSession {
    return {
      ...cached.session,
      context: cached.context,
      conversationHistory: cached.conversationHistory,
    };
  }

  private isExpired(cached: CachedSession): boolean {
    return Date.now() - cached.lastAccess > CACHE_TTL_MS;
  }

  // ==========================================================================
  // INTERNAL: PERSISTENCE
  // ==========================================================================

  private schedulePersist(studentId: string): void {
    // Cancel existing timer
    this.cancelPersistTimer(studentId);

    // Schedule new persist
    const timer = setTimeout(() => {
      this.persistSession(studentId, false);
    }, PERSIST_DEBOUNCE_MS);
    persistTimers.set(studentId, timer);
  }

  private cancelPersistTimer(studentId: string): void {
    const existing = persistTimers.get(studentId);
    if (existing) {
      clearTimeout(existing);
      persistTimers.delete(studentId);
    }
  }

  private async persistSession(
    studentId: string,
    immediate: boolean
  ): Promise<void> {
    const cached = sessionCache.get(studentId);
    if (!cached || (!cached.dirty && !immediate)) {
      return;
    }

    try {
      await aacSessionRepository.updateSession(cached.session.id, {
        context: cached.context,
        conversationHistory: cached.conversationHistory,
        lastActivity: new Date(),
      });

      cached.dirty = false;
      cached.creditsAccumulated = 0;
    } catch (error) {
      console.error(
        `[AACSessionService] Failed to persist session for student ${studentId}:`,
        error
      );
      // Don't clear dirty flag - will retry on next persist
    }
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  /**
   * Start the background cleanup interval
   */
  startCleanupInterval(): void {
    if (cleanupInterval) {
      return; // Already running
    }

    cleanupInterval = setInterval(async () => {
      for (const [studentId, cached] of Array.from(sessionCache.entries())) {
        if (this.isExpired(cached)) {
          // Persist before evicting
          await this.persistSession(studentId, true);
          sessionCache.delete(studentId);
          this.cancelPersistTimer(studentId);
          console.log(
            `[AACSessionService] Evicted stale session for student ${studentId}`
          );
        }
      }
    }, CLEANUP_INTERVAL_MS);

    console.log("[AACSessionService] Started cleanup interval");
  }

  /**
   * Stop the background cleanup interval
   */
  stopCleanupInterval(): void {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
      console.log("[AACSessionService] Stopped cleanup interval");
    }
  }

  /**
   * Persist all cached sessions (for graceful shutdown)
   */
  async persistAllSessions(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const studentId of Array.from(sessionCache.keys())) {
      promises.push(this.persistSession(studentId, true));
    }
    await Promise.all(promises);
    console.log(
      `[AACSessionService] Persisted ${promises.length} cached sessions`
    );
  }

  /**
   * Get cache statistics (for debugging)
   */
  getCacheStats(): {
    cachedSessions: number;
    studentIds: string[];
  } {
    return {
      cachedSessions: sessionCache.size,
      studentIds: Array.from(sessionCache.keys()),
    };
  }
}

// Export singleton instance
export const aacSessionService = new AACSessionService();
