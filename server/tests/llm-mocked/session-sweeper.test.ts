/**
 * Abandoned-session sweeper (server/services/session-sweeper.ts).
 *
 * The loss class (2026-08-06 cluster): sessions whose app was paused/killed
 * (or whose monitor got stuck) never ran the close path — pending_messages
 * stayed undrained, no title/summary, monitorBusy stuck true, and status
 * stayed "open" forever. The sweeper finalizes them: drains what it can,
 * summarizes, and closes. It must never touch live or recent sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { truncateAll, db } from '../helpers/db.js';
import { installFakeLlm, uninstallFakeLlm, type FakeLlmHandles } from '../helpers/llm-mock.js';
import { chatSessions, students, type ChatMessage } from '@shared/schema';
import { sweepAbandonedSessionsOnce } from '../../services/session-sweeper.js';
import {
  registerLiveSession,
  unregisterLiveSession,
  type LiveSessionHandle,
} from '../../services/dual-agent/live-session-registry.js';

const HOUR = 3_600_000;

const LOG: ChatMessage[] = [
  { role: 'user', content: 'Maya pointed at the snack board.', timestamp: 1 },
  { role: 'assistant', content: 'Great intentional communication.', timestamp: 2 },
];

async function insertSession(
  overrides: Partial<typeof chatSessions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(chatSessions)
    .values({
      chatMode: 'aac',
      status: 'open',
      state: {},
      log: LOG,
      lastUpdate: new Date(Date.now() - HOUR), // abandoned by default
      ...overrides,
    })
    .returning({ id: chatSessions.id });
  return row.id;
}

async function readSession(id: string) {
  const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, id));
  return row;
}

describe('sweepAbandonedSessionsOnce', () => {
  let llm: FakeLlmHandles;

  beforeEach(() => {
    llm = installFakeLlm();
  });

  afterEach(async () => {
    uninstallFakeLlm();
    await truncateAll();
  });

  it('bulk-closes finalized-but-mislabeled sessions without any LLM call', async () => {
    const doneOld = await insertSession({ title: 'Done', summary: 'All finished.' });
    const doneRecent = await insertSession({
      title: 'Recent',
      summary: 'Still warm.',
      lastUpdate: new Date(), // active recently — untouched
    });

    const result = await sweepAbandonedSessionsOnce();

    expect(result.bulkClosed).toBe(1);
    expect((await readSession(doneOld)).status).toBe('closed');
    expect((await readSession(doneRecent)).status).toBe('open');
    expect(llm.structured.calls).toHaveLength(0);
  });

  it('finalizes an abandoned session with no summary: summarizes and closes', async () => {
    llm.structured.enqueueContent(
      JSON.stringify({ title: 'Swept summary', summary: 'Recovered by the sweeper.', importance: 1 }),
    );
    const id = await insertSession(); // no summary, old

    const result = await sweepAbandonedSessionsOnce();

    expect(result.finalized).toBe(1);
    const row = await readSession(id);
    expect(row.title).toBe('Swept summary');
    expect(row.status).toBe('closed');
  });

  it('drains undrained pending messages into the durable log and closes (stuck monitorBusy cleared)', async () => {
    // Even without a resolvable student the session loads, the forced drain
    // moves pending→log (the two presses PLUS the [SESSION_CLOSED] directive,
    // exactly like a normal close), and a monitor-LLM failure mid-pass doesn't
    // block finalization — the summary still generates from the drained log.
    llm.structured.enqueueContent(
      JSON.stringify({ title: 'From pending', summary: 'Presses were rescued.', importance: 2 }),
    );
    const id = await insertSession({
      log: [],
      pendingMessages: [
        { role: 'user', content: 'אני רוצה מים', timestamp: 1 },
        { role: 'user', content: 'אני רוצה מים בכוס', timestamp: 2 },
      ],
      monitorBusy: true,
      monitorBusySince: new Date(Date.now() - HOUR),
    });

    const result = await sweepAbandonedSessionsOnce();

    expect(result.finalized).toBe(1);
    const row = await readSession(id);
    const logRows = Array.isArray(row.log) ? (row.log as ChatMessage[]) : [];
    const texts = logRows.map(m => (typeof m.content === 'string' ? m.content : ''));
    expect(texts).toContain('אני רוצה מים');
    expect(texts).toContain('אני רוצה מים בכוס');
    expect(texts.some(t => t.includes('[SESSION_CLOSED]'))).toBe(true);
    expect(row.pendingMessages).toEqual([]);
    expect(row.title).toBe('From pending');
    expect(row.status).toBe('closed');
    expect(row.monitorBusy).toBe(false);
  });

  it('never touches recent, deleted, or CRM sessions', async () => {
    const recent = await insertSession({ lastUpdate: new Date() });
    const deleted = await insertSession({ deletedAt: new Date() });
    const crm = await insertSession({ crmPotentialCustomerId: 'crm-1' });

    const result = await sweepAbandonedSessionsOnce();

    expect(result.examined).toBe(0);
    expect(result.finalized).toBe(0);
    expect((await readSession(recent)).status).toBe('open');
    expect((await readSession(deleted)).status).toBe('open');
    expect((await readSession(crm)).status).toBe('open');
    expect(llm.structured.calls).toHaveLength(0);
  });

  it('skips sessions whose student has a live coordinator', async () => {
    const [student] = await db
      .insert(students)
      .values({ name: 'Live Student' })
      .returning({ id: students.id });
    const handle: LiveSessionHandle = {
      requestReload: () => {},
      supersede: () => {},
      isClassroom: false,
    };
    registerLiveSession(student.id, handle);
    try {
      const id = await insertSession({ studentId: student.id });

      const result = await sweepAbandonedSessionsOnce();

      expect(result.finalized).toBe(0);
      expect((await readSession(id)).status).toBe('open');
      expect(llm.structured.calls).toHaveLength(0);
    } finally {
      unregisterLiveSession(student.id, handle);
    }
  });
});
