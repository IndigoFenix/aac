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
import { chatSessions, type ChatMessage } from '@shared/schema';
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

  it('is idempotent — skips sessions already summarized', async () => {
    const id = await insertSession({ title: 'Existing', summary: 'Already done.', importance: 3 });
    await generateSessionSummary(id);

    const row = await readSession(id);
    expect(row.title).toBe('Existing');
    expect(llm.structured.calls).toHaveLength(0); // no LLM call when title+summary present
  });
});
