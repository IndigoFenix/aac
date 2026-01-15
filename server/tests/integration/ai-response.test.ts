/**
 * AI Response Integration Tests
 *
 * Tests the actual AI by calling onMessage from sessionService with prompts.
 * Each test prompt includes instructions to respond with 'OK' if successful
 * or 'FAILED' if unable to succeed, allowing automated evaluation.
 *
 * Note: These tests make real API calls to the AI provider and require:
 * - A valid DATABASE_URL pointing to a test database
 * - Valid OPENAI_API_KEY or other AI provider credentials
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { db } from '../../db.js';
import { users, students, userStudents, chatSessions, programs } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { onMessage, type OnMessageInput } from '../../services/sessionService.js';

// Test timeout for AI calls (60 seconds)
const AI_TIMEOUT = 60000;

// Test data IDs (generated once per test suite)
let testUserId: string;
let testStudentId: string;
let testUserStudentId: string;
let testProgramId: string;

/**
 * Helper to create a test prompt that instructs the AI to respond with OK/FAILED
 */
function createTestPrompt(instruction: string): string {
  return `${instruction}

IMPORTANT: After completing the above task, you MUST end your response with exactly 'OK' if you successfully completed the task, or 'FAILED' if you were unable to complete it. Only include 'OK' or 'FAILED' as the final word of your response.`;
}

/**
 * Helper to extract the success status from an AI response
 */
function extractSuccessStatus(response: string): 'OK' | 'FAILED' | 'UNKNOWN' {
  const trimmed = response.trim();
  if (trimmed.endsWith('OK')) return 'OK';
  if (trimmed.endsWith('FAILED')) return 'FAILED';
  // Check if OK or FAILED appears anywhere near the end (within last 50 chars)
  const tail = trimmed.slice(-50).toUpperCase();
  if (tail.includes('OK') && !tail.includes('FAILED')) return 'OK';
  if (tail.includes('FAILED')) return 'FAILED';
  return 'UNKNOWN';
}

/**
 * Helper to get the text content from a MessageResponse
 */
function getResponseText(response: any): string {
  if (!response?.message?.content) return '';
  if (typeof response.message.content === 'string') {
    return response.message.content;
  }
  if (typeof response.message.content === 'object') {
    return response.message.content.text || '';
  }
  return '';
}

/**
 * Helper to call onMessage and wait for response
 */
async function sendMessage(
  message: string,
  options: Partial<OnMessageInput> = {}
): Promise<{ response: any; text: string; status: 'OK' | 'FAILED' | 'UNKNOWN' }> {
  const input: OnMessageInput = {
    userId: testUserId,
    studentId: testStudentId,
    messages: [
      {
        role: 'user' as const,
        content: message,
        timestamp: Date.now(),
      },
    ],
    replyType: 'text',
    ...options,
  };

  const response = await onMessage(input);
  const text = getResponseText(response);
  const status = extractSuccessStatus(text);

  return { response, text, status };
}

describe('AI Response Integration Tests', () => {
  // Set up test data before all tests
  beforeAll(async () => {
    // Generate unique IDs for this test run
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(7);

    // Create test user
    const [user] = await db
      .insert(users)
      .values({
        email: `ai-test-${timestamp}-${randomSuffix}@test.com`,
        firstName: 'AI',
        lastName: 'Test',
        fullName: 'AI Test User',
        password: 'test-password-hash',
        credits: 1000,
        chatCreditsUsed: 0,
      })
      .returning();
    testUserId = user.id;

    // Create test student
    const [student] = await db
      .insert(students)
      .values({
        name: 'Test Student',
        firstName: 'Test',
        lastName: 'Student',
        gender: 'other',
        framework: 'us_iep',
        primaryLanguage: 'en',
        isActive: true,
        chatCreditsUsed: 0,
      })
      .returning();
    testStudentId = student.id;

    // Create user-student relationship
    const [userStudent] = await db
      .insert(userStudents)
      .values({
        userId: testUserId,
        studentId: testStudentId,
        role: 'therapist',
        hasEducationalRights: true,
        hasMedicalRights: true,
        isActive: true,
        chatCreditsUsed: 0,
      })
      .returning();
    testUserStudentId = userStudent.id;

    // Create a test program for the student
    const [program] = await db
      .insert(programs)
      .values({
        studentId: testStudentId,
        framework: 'us_iep',
        title: 'AI Test IEP 2024-2025',
        status: 'active',
      })
      .returning();
    testProgramId = program.id;
  }, AI_TIMEOUT);

  // Clean up test data after all tests
  afterAll(async () => {
    // Delete in reverse order of creation (foreign key constraints)
    if (testProgramId) {
      await db.delete(programs).where(eq(programs.id, testProgramId));
    }
    if (testUserStudentId) {
      await db.delete(userStudents).where(eq(userStudents.id, testUserStudentId));
    }
    // Delete chat sessions for this user/student
    await db.delete(chatSessions).where(
      and(
        eq(chatSessions.userId, testUserId),
        eq(chatSessions.studentId, testStudentId)
      )
    );
    if (testStudentId) {
      await db.delete(students).where(eq(students.id, testStudentId));
    }
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
  }, AI_TIMEOUT);

  // ==========================================================================
  // Basic Response Tests
  // ==========================================================================

  describe('Basic AI Response', () => {
    it('should respond to a simple greeting', async () => {
      const prompt = createTestPrompt('Say hello to the user.');

      const { text, status } = await sendMessage(prompt);

      expect(text).toBeTruthy();
      expect(text.length).toBeGreaterThan(0);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);

    it('should understand and follow basic instructions', async () => {
      const prompt = createTestPrompt(
        'Count from 1 to 5, listing each number on a new line.'
      );

      const { text, status } = await sendMessage(prompt);

      expect(text).toContain('1');
      expect(text).toContain('5');
      expect(status).toBe('OK');
    }, AI_TIMEOUT);

    it('should handle a request for information', async () => {
      const prompt = createTestPrompt(
        'Explain what AAC (Augmentative and Alternative Communication) means in one sentence.'
      );

      const { text, status } = await sendMessage(prompt);

      expect(text.toLowerCase()).toMatch(/communication|aac|augmentative/);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);
  });

  // ==========================================================================
  // Context Awareness Tests
  // ==========================================================================

  describe('Context Awareness', () => {
    it('should be aware it is an assistant for AAC/special education', async () => {
      const prompt = createTestPrompt(
        'In one sentence, describe your primary purpose or role.'
      );

      const { text, status } = await sendMessage(prompt);

      // The AI should mention something about communication, therapy, education, or AAC
      const relevantTerms = /communication|therapy|education|support|assist|aac|speech|language|student|child/i;
      expect(text).toMatch(relevantTerms);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);

    it('should acknowledge the student context when provided', async () => {
      const prompt = createTestPrompt(
        'Confirm that you are currently working with a student context. What can you help with regarding this student?'
      );

      const { text, status } = await sendMessage(prompt);

      expect(text.toLowerCase()).toMatch(/student|child|learner|support|help/);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);
  });

  // ==========================================================================
  // Memory Operation Tests
  // ==========================================================================

  describe('Memory Operations', () => {
    it('should be able to remember information within a session', async () => {
      // First message: tell the AI something to remember
      const setupPrompt = createTestPrompt(
        'Remember that the student\'s favorite color is blue. Confirm you have noted this.'
      );
      const { text: setupText, status: setupStatus, response: setupResponse } = await sendMessage(setupPrompt);

      expect(setupStatus).toBe('OK');
      const sessionId = setupResponse.sessionId;

      // Second message: ask about the remembered information
      const recallPrompt = createTestPrompt(
        'What is the student\'s favorite color that I told you about?'
      );
      const { text: recallText, status: recallStatus } = await sendMessage(recallPrompt, { sessionId });

      expect(recallText.toLowerCase()).toContain('blue');
      expect(recallStatus).toBe('OK');
    }, AI_TIMEOUT * 2); // Double timeout for multi-turn test

    it('should handle requests to store student preferences', async () => {
      const prompt = createTestPrompt(
        'Note that this student prefers visual supports and picture-based communication. Confirm this preference has been recorded.'
      );

      const { text, status } = await sendMessage(prompt);

      expect(text.toLowerCase()).toMatch(/visual|picture|noted|recorded|preference/);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);
  });

  // ==========================================================================
  // Feature Mode Tests
  // ==========================================================================

  describe('Feature Modes', () => {
    it('should handle assistant mode queries', async () => {
      const prompt = createTestPrompt(
        'Provide a brief tip for supporting a non-verbal student in the classroom.'
      );

      const { text, status } = await sendMessage(prompt, {
        activeFeature: 'assistant',
      });

      expect(text.length).toBeGreaterThan(50);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);

    it('should handle progress mode context', async () => {
      const prompt = createTestPrompt(
        'Acknowledge that you are in progress tracking mode and can help with IEP goals and objectives.'
      );

      const { text, status } = await sendMessage(prompt, {
        activeFeature: 'progress',
      });

      expect(text.toLowerCase()).toMatch(/progress|goal|objective|iep|track/);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);

    it('should handle boards mode context', async () => {
      const prompt = createTestPrompt(
        'Acknowledge that you can help create and modify AAC communication boards.'
      );

      const { text, status } = await sendMessage(prompt, {
        activeFeature: 'boards',
      });

      expect(text.toLowerCase()).toMatch(/board|communication|aac|symbol/);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('Error Handling', () => {
    it('should gracefully handle ambiguous requests', async () => {
      const prompt = createTestPrompt(
        'Do the thing with the stuff. Respond with OK if you understood this was vague and asked for clarification, or FAILED if you tried to proceed without clarification.'
      );

      const { text, status } = await sendMessage(prompt);

      // The AI should either ask for clarification (OK) or gracefully explain it needs more info
      expect(text.length).toBeGreaterThan(20);
      // We accept OK since the AI should recognize the request is vague
      expect(status).toBe('OK');
    }, AI_TIMEOUT);

    it('should maintain composure with unusual input', async () => {
      const prompt = createTestPrompt(
        'Process this input: 🎭🎪🎨🎸. Acknowledge the unusual input and respond appropriately.'
      );

      const { text, status } = await sendMessage(prompt);

      expect(text.length).toBeGreaterThan(10);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);
  });

  // ==========================================================================
  // Professional Conduct Tests
  // ==========================================================================

  describe('Professional Conduct', () => {
    it('should maintain professional and supportive tone', async () => {
      const prompt = createTestPrompt(
        'A parent is frustrated that their child is not making progress. Provide a brief, empathetic response.'
      );

      const { text, status } = await sendMessage(prompt);

      // Should be professional, empathetic, not dismissive
      expect(text.length).toBeGreaterThan(50);
      expect(text.toLowerCase()).toMatch(/understand|support|progress|help|together/);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);

    it('should respect privacy and confidentiality', async () => {
      const prompt = createTestPrompt(
        'A user asks you to share information about other students. Politely decline and explain privacy considerations.'
      );

      const { text, status } = await sendMessage(prompt);

      expect(text.toLowerCase()).toMatch(/privacy|confidential|cannot|only|specific student/);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);
  });

  // ==========================================================================
  // Practical Assistance Tests
  // ==========================================================================

  describe('Practical Assistance', () => {
    it('should provide actionable IEP goal suggestions', async () => {
      const prompt = createTestPrompt(
        'Suggest one measurable IEP goal for a student working on expressive language. Include criteria for success.'
      );

      const { text, status } = await sendMessage(prompt, {
        activeFeature: 'progress',
      });

      // Should contain measurable criteria
      expect(text.toLowerCase()).toMatch(/goal|objective|measure|accuracy|percent|%|sessions|trials/);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);

    it('should provide AAC board suggestions', async () => {
      const prompt = createTestPrompt(
        'Suggest 4 core vocabulary words that should be on every AAC board. List them clearly.'
      );

      const { text, status } = await sendMessage(prompt, {
        activeFeature: 'boards',
      });

      // Should list vocabulary words
      expect(text).toMatch(/\b(want|more|stop|help|go|yes|no|I|you|like|eat|drink)\b/i);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);

    it('should help with data collection strategies', async () => {
      const prompt = createTestPrompt(
        'Describe a simple data collection method for tracking a student\'s use of their AAC device during snack time.'
      );

      const { text, status } = await sendMessage(prompt);

      expect(text.toLowerCase()).toMatch(/data|track|record|tally|frequency|count|observe/);
      expect(status).toBe('OK');
    }, AI_TIMEOUT);
  });
});
