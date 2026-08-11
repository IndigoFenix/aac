/**
 * Who owns `chat_sessions.state.history` vs `chat_sessions.log`.
 *
 * The AAC session and the Monitor's chat-framework session share ONE row. The
 * framework (sessionService.onMessage -> ChatMessageManager) owns
 * `state.history` and `state.conversationSummary`: history is the Monitor's own
 * LLM conversation, culled to `cullMessagesTo` with a generated summary of what
 * was dropped. The AAC conversation record is `log`.
 *
 * dual-agent-service used to write `state.history = state.messages` on every
 * save, which threw that cull away each cycle — so the next Monitor call
 * re-culled the whole conversation from scratch and paid a fresh summariser
 * call to do it, with input that grew for the life of the session. It also
 * meant the pending turns were appended twice (once by us, once by
 * persistMessages), so the Monitor saw every turn of the conversation twice.
 *
 * These tests pin the ownership split. If one of them fails, the two writers
 * are fighting over the same field again.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { truncateAll, db } from '../helpers/db.js';
import { chatSessions, type ChatMessage } from '@shared/schema';
import { dualAgentService } from '../../services/dual-agent/dual-agent-service.js';

/** The Monitor's culled working set — what compressHistory leaves behind. */
const CULLED: ChatMessage[] = [
  { role: 'system', content: '[Conversation summary of removed messages]\nEarlier: snack board.', timestamp: 1 },
  { role: 'user', content: 'pressed MORE', timestamp: 2 },
];

/** The AAC conversation record — everything that happened. */
const FULL: ChatMessage[] = [
  { role: 'user', content: 'pressed APPLE', timestamp: 1 },
  { role: 'assistant', content: 'You want an apple?', timestamp: 2 },
  { role: 'user', content: 'pressed YES', timestamp: 3 },
  { role: 'user', content: 'pressed MORE', timestamp: 4 },
];

const MONITOR_SUMMARY = 'Student worked through the snack board and asked for more.';

async function insertSession(
  overrides: Partial<typeof chatSessions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(chatSessions)
    .values({ chatMode: 'aac', status: 'open', state: {}, log: [], ...overrides })
    .returning({ id: chatSessions.id });
  return row.id;
}

/** Minimal DualAgentSessionState — only the fields saveSessionToDB reads. */
function makeState(sessionId: string, messages: ChatMessage[], overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    remoteStorageEnabled: true,
    messages,
    pendingMessages: [],
    muteState: 'unmuted',
    interactivePrompt: 'be encouraging',
    monitorBusy: false,
    sessionSummary: 'rolling session summary for the live agents',
    summarizedMsgCount: 4,
    ...overrides,
  } as any;
}

const save = (state: unknown) =>
  (dualAgentService as any).saveSessionToDB(state) as Promise<void>;

const readRow = async (id: string) => {
  const [row] = await db
    .select({ state: chatSessions.state, log: chatSessions.log })
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .limit(1);
  return { state: row.state as Record<string, any>, log: row.log as ChatMessage[] };
};

describe('Monitor history ownership (state.history vs log)', () => {
  afterEach(truncateAll);

  describe('saveSessionToDB', () => {
    it('leaves the Monitors culled history and its summary alone', async () => {
      const id = await insertSession({
        state: { history: CULLED, conversationSummary: MONITOR_SUMMARY, muteState: 'unmuted' },
        log: FULL,
      });

      await save(makeState(id, [...FULL, { role: 'assistant', content: 'More apple!', timestamp: 5 }]));

      const { state } = await readRow(id);
      // The cull survives the save — this is the regression. If history came
      // back as the 5-message conversation, autoCompress would re-cull (and
      // re-summarise) the whole thing on the very next Monitor call.
      expect(state.history).toEqual(CULLED);
      expect(state.conversationSummary).toBe(MONITOR_SUMMARY);
    });

    it('writes the conversation to log, not into the Monitors history', async () => {
      const id = await insertSession({
        state: { history: CULLED, conversationSummary: MONITOR_SUMMARY },
        log: FULL,
      });

      const grown = [...FULL, { role: 'assistant' as const, content: 'More apple!', timestamp: 5 }];
      await save(makeState(id, grown));

      const { state, log } = await readRow(id);
      expect(log).toEqual(grown);
      expect(state.history).not.toEqual(grown);
    });

    it('still writes the fields the AAC session owns', async () => {
      const id = await insertSession({ state: { history: CULLED }, log: FULL });

      await save(makeState(id, FULL, { muteState: 'muted', sessionSummary: 'fresh rolling summary' }));

      const { state } = await readRow(id);
      expect(state.muteState).toBe('muted');
      expect(state.sessionSummary).toBe('fresh rolling summary');
      expect(state.summarizedMsgCount).toBe(4);
    });

    it('does not leak the rolling session summary into the framework field', async () => {
      // `conversationSummary` is the chat framework's field and lands in the
      // system prompt. Feeding it the rolling session summary (which updates
      // every N turns) changed the prompt under the prompt cache.
      const id = await insertSession({
        state: { history: CULLED, conversationSummary: MONITOR_SUMMARY },
        log: FULL,
      });

      await save(makeState(id, FULL, { sessionSummary: 'a brand new rolling summary' }));

      const { state } = await readRow(id);
      expect(state.conversationSummary).toBe(MONITOR_SUMMARY);
    });
  });

  describe('loadHistoryForReconnect', () => {
    it('replays the conversation from log, not the culled history', async () => {
      const id = await insertSession({
        state: { history: CULLED, conversationSummary: MONITOR_SUMMARY },
        log: FULL,
      });

      const turns = await dualAgentService.loadHistoryForReconnect(id);

      expect(turns.map((t) => t.text)).toEqual([
        'pressed APPLE',
        'You want an apple?',
        'pressed YES',
        'pressed MORE',
      ]);
    });

    it('falls back to state.history for rows written before the split', async () => {
      // Legacy row: conversation lives in state.history, log never written.
      const id = await insertSession({ state: { history: FULL }, log: [] });

      const turns = await dualAgentService.loadHistoryForReconnect(id);

      expect(turns).toHaveLength(FULL.length);
      expect(turns[0]).toEqual({ role: 'user', text: 'pressed APPLE' });
      expect(turns[1]).toEqual({ role: 'model', text: 'You want an apple?' });
    });
  });
});
