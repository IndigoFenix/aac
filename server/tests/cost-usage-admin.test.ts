/**
 * Coverage for the admin Cost & Usage dashboard aggregation
 * (chatRepository.getCostUsageAnalytics). Verifies the SQL KPI totals and the
 * per-session points are computed from existing chat_sessions data, span both
 * AAC and clinician-chat sessions, and exclude CRM / soft-deleted sessions.
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

// Builds {started, lastUpdate} for a session of the given length in seconds,
// ending now.
function span(durationSec: number): { started: Date; lastUpdate: Date } {
  const end = new Date();
  const start = new Date(end.getTime() - durationSec * 1000);
  return { started: start, lastUpdate: end };
}

describe('cost & usage admin analytics', () => {
  afterEach(async () => {
    await truncateAll();
  });

  it('aggregates KPIs and points across AAC + chat, excluding CRM and deleted', async () => {
    // 10-minute AAC session.
    const aacId = await insertSession({
      chatMode: 'aac',
      creditsUsed: 0.5,
      costBreakdown: { observer: 0.3, monitor: 0.15, tts: 0.05 },
      ...span(600),
    });
    // 30-second chat session (a "ghost" — <= 1 min).
    const chatId = await insertSession({
      chatMode: 'chat',
      creditsUsed: 0.02,
      costBreakdown: { chat: 0.015, 'tool:generate_image': 0.005 },
      ...span(30),
    });
    // CRM landing-page session — must be excluded.
    await insertSession({ chatMode: 'chat', creditsUsed: 9, crmPotentialCustomerId: 'crm-1', ...span(600) });
    // Soft-deleted session — must be excluded.
    await insertSession({ chatMode: 'aac', creditsUsed: 9, deletedAt: new Date(), ...span(600) });

    const { points, kpis, categoryBreakdown } = await chatRepository.getCostUsageAnalytics({});

    // Cost breakdown is summed by category, per source.
    expect(categoryBreakdown.aac).toEqual({ observer: 0.3, monitor: 0.15, tts: 0.05 });
    expect(categoryBreakdown.chat).toEqual({ chat: 0.015, 'tool:generate_image': 0.005 });

    // KPIs are reported separately per session type.
    expect(kpis.aac.sessionCount).toBe(1);
    expect(kpis.aac.totalSpend).toBeCloseTo(0.5, 6);
    expect(kpis.aac.totalSeconds).toBeCloseTo(600, 0);
    expect(kpis.aac.ghostCount).toBe(0);

    expect(kpis.chat.sessionCount).toBe(1);
    expect(kpis.chat.totalSpend).toBeCloseTo(0.02, 6);
    expect(kpis.chat.totalSeconds).toBeCloseTo(30, 0);
    expect(kpis.chat.ghostCount).toBe(1); // the 30s chat session

    expect(points).toHaveLength(2);
    const aac = points.find((p) => p.id === aacId);
    const chat = points.find((p) => p.id === chatId);
    expect(aac?.source).toBe('aac');
    expect(aac?.durationSec).toBeCloseTo(600, 0);
    expect(aac?.cost).toBeCloseTo(0.5, 6);
    expect(chat?.source).toBe('chat');
    expect(chat?.durationSec).toBeCloseTo(30, 0);
  });

  it('honors the date range filter', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await insertSession({
      chatMode: 'aac',
      creditsUsed: 1,
      started: old,
      lastUpdate: new Date(old.getTime() + 600 * 1000),
    });
    const recentId = await insertSession({ chatMode: 'aac', creditsUsed: 2, ...span(300) });

    // Restrict to recent sessions only.
    const startDate = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { points, kpis } = await chatRepository.getCostUsageAnalytics({ startDate });

    expect(kpis.aac.sessionCount).toBe(1);
    expect(kpis.aac.totalSpend).toBeCloseTo(2, 6);
    expect(points).toHaveLength(1);
    expect(points[0].id).toBe(recentId);
  });
});
