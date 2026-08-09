/**
 * Regression coverage for sessionSummary.generateSessionSummary.
 *
 * The bug: structured providers return `content` as a JSON *string* (Claude
 * JSON.stringifies the forced tool input; OpenAI returns output_text), but
 * generateSessionSummary treated `response.content` as an already-parsed
 * object — so `typeof parsed !== "object"` was always true and it bailed with
 * "no parsed content from provider", leaving title/summary/importance unset on
 * EVERY session. See the wall of that exact line in server/session-summary-debug.log.
 *
 * The fix parses string content (matching every other structuredComplete caller,
 * e.g. chat-handler.ts) while still accepting an object for forward-compat.
 *
 * Note on the mock: helpers/llm-mock.ts `enqueueContent` stores content verbatim,
 * so the historical tests would have queued an OBJECT — the opposite of the real
 * provider shape. That mismatch is exactly what let this bug hide. Here we queue a
 * JSON STRING to mirror production, plus one object case to lock in both paths.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { truncateAll, db } from '../helpers/db.js';
import { installFakeLlm, uninstallFakeLlm, type FakeLlmHandles } from '../helpers/llm-mock.js';
import { chatSessions, students, type ChatMessage } from '@shared/schema';
import { generateSessionSummary } from '../../services/sessionSummary.js';

const LOG: ChatMessage[] = [
  { role: 'user', content: 'Maya pointed at the snack board three times today.', timestamp: 1 },
  { role: 'assistant', content: 'That is a great sign of intentional communication.', timestamp: 2 },
];

async function insertSession(
  overrides: Partial<typeof chatSessions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(chatSessions)
    .values({
      chatMode: 'chat',
      status: 'closed',
      state: {},
      log: LOG,
      ...overrides,
    })
    .returning({ id: chatSessions.id });
  return row.id;
}

async function readSession(id: string) {
  const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, id));
  return row;
}

describe('generateSessionSummary', () => {
  let llm: FakeLlmHandles;

  beforeEach(() => {
    llm = installFakeLlm();
  });

  afterEach(async () => {
    uninstallFakeLlm();
    await truncateAll();
  });

  it('persists title/summary/importance when the provider returns JSON-string content (real provider shape)', async () => {
    llm.structured.enqueueContent(
      JSON.stringify({
        title: 'Snack board pointing',
        summary: 'Maya intentionally pointed at the snack board three times.',
        importance: 2,
      }),
    );

    const id = await insertSession();
    await generateSessionSummary(id);

    const row = await readSession(id);
    expect(row.title).toBe('Snack board pointing');
    expect(row.summary).toContain('snack board');
    expect(row.importance).toBe(2);
    expect(llm.structured.calls).toHaveLength(1);
  });

  it('also accepts already-parsed object content (forward-compat)', async () => {
    llm.structured.enqueueContent({
      title: 'Object-shaped title',
      summary: 'Provider returned a parsed object instead of a string.',
      importance: 1,
    });

    const id = await insertSession();
    await generateSessionSummary(id);

    const row = await readSession(id);
    expect(row.title).toBe('Object-shaped title');
    expect(row.importance).toBe(1);
  });

  it('marks an empty session without calling the LLM', async () => {
    const id = await insertSession({ log: [] });
    await generateSessionSummary(id);

    const row = await readSession(id);
    expect(row.title).toBe('(empty session)');
    expect(row.importance).toBe(0);
    expect(llm.structured.calls).toHaveLength(0);
  });

  it('recovers messages from pending_messages when the log is empty, then summarizes', async () => {
    // Mirrors the production failure: the Monitor never drained pending → log
    // (short session / host recycle), so log is [] but the presses are still
    // in pending_messages. generateSessionSummary should recover them rather
    // than mislabel the session as "(empty session)".
    llm.structured.enqueueContent(
      JSON.stringify({
        title: 'Recovered from pending',
        summary: 'Maya pointed at the snack board.',
        importance: 2,
      }),
    );

    const id = await insertSession({
      log: [],
      pendingMessages: [
        { role: 'user', content: 'Maya pointed at the snack board.', timestamp: 1 },
        { role: 'assistant', content: 'Nice intentional communication.', timestamp: 2 },
      ],
    });
    await generateSessionSummary(id);

    const row = await readSession(id);
    // Pending messages were moved into the log...
    expect(Array.isArray(row.log) ? (row.log as ChatMessage[]).length : 0).toBe(2);
    expect(row.pendingMessages).toEqual([]);
    // ...and a real summary was generated (not the empty-session placeholder).
    expect(row.title).toBe('Recovered from pending');
    expect(row.importance).toBe(2);
    expect(llm.structured.calls).toHaveLength(1);
  });

  it('is idempotent — skips sessions already summarized', async () => {
    const id = await insertSession({ title: 'Existing', summary: 'Already done.', importance: 3 });
    await generateSessionSummary(id);

    const row = await readSession(id);
    expect(row.title).toBe('Existing');
    expect(llm.structured.calls).toHaveLength(0); // no LLM call when title+summary present
  });

  it('grounds the summarizer in the linked student and drops text-less tool-call turns', async () => {
    // Regression: a Hebrew parent chat about a hospitalized child was
    // summarized as being about the family's DOG — the summarizer got a raw
    // transcript with no idea who the subject was, and "cluster seizures +
    // midazolam" pattern-matched to canine epilepsy. The fix injects a
    // Subject grounding line from the linked student record. The same session
    // shape also exposed empty "ASSISTANT:" lines from tool-call turns with
    // no content — those must not reach the transcript.
    llm.structured.enqueueContent(
      JSON.stringify({ title: 'עדכון הוראות', summary: 'שחף מאושפזת.', importance: 2 }),
    );

    const [student] = await db
      .insert(students)
      .values({ name: 'שחף סוחמי', firstName: 'שחף' })
      .returning({ id: students.id });
    const id = await insertSession({
      studentId: student.id,
      log: [
        { role: 'user', content: 'התייחס בשיחת AAC ששחף מאושפזת במיון', timestamp: 1 },
        { role: 'assistant', content: { md: 'אני מעדכן את הוראות ה-AAC שלי.' }, timestamp: 2 },
        // Tool-call turn: no content at all — must not become "ASSISTANT: ".
        { role: 'assistant', toolCalls: [{ name: 'manageMemory' }], timestamp: 3 } as unknown as ChatMessage,
        { role: 'tool', content: '{"success":true}', timestamp: 4 },
      ],
    });
    await generateSessionSummary(id);

    expect(llm.structured.calls).toHaveLength(1);
    const sent = String(llm.structured.calls[0].input[0].content);
    expect(sent).toContain('Subject: שחף');
    expect(sent).toContain('AAC device');
    // The md-object content was extracted; the empty tool-call turn was dropped.
    expect(sent).toContain('ASSISTANT: אני מעדכן');
    expect(sent).not.toMatch(/^ASSISTANT:\s*$/m);
    // Tool results never reach the transcript.
    expect(sent).not.toContain('"success"');
  });

  it('marks a session whose log is all tool traffic as empty without calling the LLM', async () => {
    const id = await insertSession({
      log: [
        { role: 'assistant', toolCalls: [{ name: 'manageMemory' }], timestamp: 1 } as unknown as ChatMessage,
        { role: 'tool', content: '{"ok":true}', timestamp: 2 },
      ],
    });
    await generateSessionSummary(id);

    const row = await readSession(id);
    expect(row.title).toBe('(empty session)');
    expect(row.importance).toBe(0);
    expect(llm.structured.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Context-aware analyst path (substantial sessions)
  // -------------------------------------------------------------------------

  /** A transcript long enough to cross CONTEXT_TRANSCRIPT_MIN_CHARS. */
  function longLog(): ChatMessage[] {
    const filler = 'שחף הצביעה על הלוח ודיברה על המשפחה והחברים שלה בגן. '.repeat(6);
    return [1, 2, 3, 4].map(i => ({
      role: i % 2 ? 'user' : 'assistant',
      content: `${filler} (turn ${i})`,
      timestamp: i,
    })) as ChatMessage[];
  }

  async function insertStudent(): Promise<string> {
    const [student] = await db
      .insert(students)
      .values({ name: 'שחף סוחמי', firstName: 'שחף' })
      .returning({ id: students.id });
    return student.id;
  }

  it('runs the context-aware analyst for substantial sessions: memory tool offered, view round-trips, final answer persisted', async () => {
    // Round 1: the analyst views Student_Notes. Round 2: it answers.
    llm.structured.enqueue({
      promptTokens: 0, completionTokens: 0, cachedTokens: 0, refused: false, content: null,
      toolCalls: [{
        type: 'function_call',
        call_id: 'mem-1',
        name: 'manageMemory',
        arguments: JSON.stringify({ operations: [{ action: 'view', path: '/Student_Notes' }] }),
      }],
    } as any);
    llm.structured.enqueueContent(
      JSON.stringify({ title: 'הפעם הראשונה שדיברה על הגן', summary: 'שחף דיברה על חברים.', importance: 2 }),
    );

    const studentId = await insertStudent();
    const id = await insertSession({ studentId, log: longLog() });
    await generateSessionSummary(id);

    expect(llm.structured.calls).toHaveLength(2);
    // The analyst round offered the memory tool…
    const first = llm.structured.calls[0];
    expect(first.tools?.some(t => t.type === 'function' && t.function.name === 'manageMemory')).toBe(true);
    expect(String(first.instructions)).toContain('READ-ONLY');
    // …and the second round carried the executed tool round-trip.
    const second = llm.structured.calls[1];
    const kinds = second.input.map(i => i.type);
    expect(kinds).toContain('function_call');
    expect(kinds).toContain('function_call_output');

    const row = await readSession(id);
    expect(row.title).toBe('הפעם הראשונה שדיברה על הגן');
    expect(row.importance).toBe(2);
  });

  it('skips the analyst for short sessions — single call, no tools', async () => {
    llm.structured.enqueueContent(
      JSON.stringify({ title: 'שיחה קצרה', summary: 'ברכה קצרה.', importance: 1 }),
    );

    const studentId = await insertStudent();
    const id = await insertSession({
      studentId,
      log: [
        { role: 'user', content: 'היי', timestamp: 1 },
        { role: 'assistant', content: 'שלום שחף!', timestamp: 2 },
      ],
    });
    await generateSessionSummary(id);

    expect(llm.structured.calls).toHaveLength(1);
    expect(llm.structured.calls[0].tools).toBeUndefined();
    const row = await readSession(id);
    expect(row.title).toBe('שיחה קצרה');
  });

  it('falls back to the light path when the analyst loop fails mid-flight', async () => {
    // The analyst's first round returns a tool call; its second round finds an
    // empty queue and the fake provider throws. The context path aborts and
    // the tool-less light path is attempted next (it throws too — nothing
    // queued — and the outer catch swallows it: errors are logged, never
    // thrown). Three attempted calls, the last without tools, nothing
    // persisted.
    llm.structured.enqueue({
      promptTokens: 0, completionTokens: 0, cachedTokens: 0, refused: false, content: null,
      toolCalls: [{
        type: 'function_call',
        call_id: 'mem-1',
        name: 'manageMemory',
        arguments: JSON.stringify({ operations: [{ action: 'view', path: '/Student_Notes' }] }),
      }],
    } as any);

    const studentId = await insertStudent();
    const id = await insertSession({ studentId, log: longLog() });
    await generateSessionSummary(id);

    expect(llm.structured.calls).toHaveLength(3);
    expect(llm.structured.calls[0].tools).toBeDefined(); // analyst round
    expect(llm.structured.calls[2].tools).toBeUndefined(); // light-path attempt
    const row = await readSession(id);
    expect(row.title).toBeNull();
  });
});
