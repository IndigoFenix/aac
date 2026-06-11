/**
 * Coverage for the admin session-history queries (chatRepository) — in
 * particular that `costBreakdown` (chat_sessions.cost_breakdown) is exposed
 * to the admin Session History UI for both the AAC and clinician-chat tabs.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll, db } from './helpers/db.js';
import { chatSessions } from '@shared/schema';
import { chatRepository } from '../repositories/chatRepository.js';

async function insertSession(values: Partial<typeof chatSessions.$inferInsert>): Promise<string> {
  const [row] = await db
    .insert(chatSessions)
    .values({ chatMode: 'chat', state: {}, ...values })
    .returning({ id: chatSessions.id });
  return row.id;
}

describe('session-history admin queries', () => {
  afterEach(async () => {
    await truncateAll();
  });

  it('getAACSessionsAdmin returns costBreakdown alongside creditsUsed', async () => {
    const id = await insertSession({
      chatMode: 'aac',
      creditsUsed: 0.5,
      costBreakdown: { observer: 0.3, speaker: 0.15, tts: 0.05 },
    });

    const rows = await chatRepository.getAACSessionsAdmin({ limit: 10, offset: 0 });
    const row = rows.find(r => r.id === id);
    expect(row).toBeDefined();
    expect(row!.creditsUsed).toBeCloseTo(0.5, 9);
    expect(row!.costBreakdown).toEqual({ observer: 0.3, speaker: 0.15, tts: 0.05 });
  });

  it('getSessionsAdmin returns costBreakdown for clinician chat sessions', async () => {
    const id = await insertSession({
      chatMode: 'chat',
      creditsUsed: 0.02,
      costBreakdown: { chat: 0.015, 'tool:webSearch': 0.005 },
    });

    const rows = await chatRepository.getSessionsAdmin({ limit: 10, offset: 0 });
    const row = rows.find(r => r.id === id);
    expect(row).toBeDefined();
    expect(row!.costBreakdown).toEqual({ chat: 0.015, 'tool:webSearch': 0.005 });
  });

  it('legacy sessions default to an empty breakdown object', async () => {
    const id = await insertSession({ chatMode: 'aac', creditsUsed: 1.25 });

    const rows = await chatRepository.getAACSessionsAdmin({ limit: 10, offset: 0 });
    const row = rows.find(r => r.id === id);
    expect(row).toBeDefined();
    // Column default is '{}' — the UI treats this as "no breakdown" and
    // shows the plain total.
    expect(row!.costBreakdown).toEqual({});
  });
});
