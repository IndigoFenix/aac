/**
 * Coverage for the clinician-scoped "past conversations" repository methods
 * (chatRepository.getSessionsForUser / getSessionForUser / renameSession /
 * softDeleteSessionForUser / getUntitledSessionIdsForUser).
 *
 * The security-critical property: every method is scoped to the requesting
 * user's own sessions. A user must never see, load, rename, or delete another
 * user's conversations. These tests assert that ownership boundary directly.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { truncateAll, db } from '../helpers/db.js';
import { makeUser } from '../helpers/factories.js';
import { chatRepository } from '../../repositories/chatRepository.js';
import { chatSessions, type ChatMessage } from '@shared/schema';

const LOG: ChatMessage[] = [
  { role: 'user', content: 'How is Maya doing with the snack board?', timestamp: 1 },
  { role: 'assistant', content: 'She used it three times today.', timestamp: 2 },
];

async function insertSession(
  overrides: Partial<typeof chatSessions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(chatSessions)
    .values({ chatMode: 'chat', status: 'open', state: {}, log: LOG, ...overrides })
    .returning({ id: chatSessions.id });
  return row.id;
}

describe('chatRepository — clinician own-data session methods', () => {
  afterEach(async () => {
    await truncateAll();
  });

  describe('getSessionsForUser', () => {
    it('returns only the requesting user\'s sessions, newest first', async () => {
      const me = await makeUser();
      const other = await makeUser();
      await insertSession({ userId: me.id });
      await insertSession({ userId: me.id });
      await insertSession({ userId: other.id });

      const mine = await chatRepository.getSessionsForUser({ userId: me.id });
      expect(mine).toHaveLength(2);
      expect(mine.every((s) => typeof s.id === 'string')).toBe(true);
    });

    it('omits empty, aac, crm, and soft-deleted sessions', async () => {
      const me = await makeUser();
      await insertSession({ userId: me.id, log: [] }); // empty
      await insertSession({ userId: me.id, chatMode: 'aac' }); // aac
      await insertSession({ userId: me.id, crmPotentialCustomerId: 'crm-1' }); // crm
      await insertSession({ userId: me.id, deletedAt: new Date() }); // deleted
      const keep = await insertSession({ userId: me.id }); // normal

      const list = await chatRepository.getSessionsForUser({ userId: me.id });
      expect(list.map((s) => s.id)).toEqual([keep]);
      expect(list[0].messageCount).toBe(2);
      expect(list[0].firstMessage).toContain('snack board');
    });
  });

  describe('getSessionForUser', () => {
    it('loads own session in full but returns undefined for another user\'s', async () => {
      const me = await makeUser();
      const other = await makeUser();
      const mineId = await insertSession({ userId: me.id });
      const theirsId = await insertSession({ userId: other.id });

      const mine = await chatRepository.getSessionForUser(mineId, me.id);
      expect(mine?.id).toBe(mineId);
      expect((mine?.log as ChatMessage[]).length).toBe(2);

      const blocked = await chatRepository.getSessionForUser(theirsId, me.id);
      expect(blocked).toBeUndefined();
    });
  });

  describe('renameSession', () => {
    it('renames own session and locks the title', async () => {
      const me = await makeUser();
      const id = await insertSession({ userId: me.id });

      const ok = await chatRepository.renameSession(id, me.id, '  Maya snack progress  ');
      expect(ok).toBe(true);

      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, id));
      expect(row.title).toBe('Maya snack progress'); // trimmed
      expect(row.titleManual).toBe(true);
    });

    it('refuses to rename another user\'s session', async () => {
      const me = await makeUser();
      const other = await makeUser();
      const theirs = await insertSession({ userId: other.id });

      const ok = await chatRepository.renameSession(theirs, me.id, 'Hijacked');
      expect(ok).toBe(false);

      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, theirs));
      expect(row.title).toBeNull();
    });
  });

  describe('softDeleteSessionForUser', () => {
    it('soft-deletes own session and hides it from the list', async () => {
      const me = await makeUser();
      const id = await insertSession({ userId: me.id });

      const ok = await chatRepository.softDeleteSessionForUser(id, me.id);
      expect(ok).toBe(true);

      const list = await chatRepository.getSessionsForUser({ userId: me.id });
      expect(list.map((s) => s.id)).not.toContain(id);
    });

    it('refuses to delete another user\'s session', async () => {
      const me = await makeUser();
      const other = await makeUser();
      const theirs = await insertSession({ userId: other.id });

      const ok = await chatRepository.softDeleteSessionForUser(theirs, me.id);
      expect(ok).toBe(false);

      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, theirs));
      expect(row.deletedAt).toBeNull();
    });
  });

  describe('getUntitledSessionIdsForUser', () => {
    it('returns idle untitled sessions but skips titled and fresh ones', async () => {
      const me = await makeUser();
      const old = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago (idle)
      const idle = await insertSession({ userId: me.id, lastUpdate: old });
      await insertSession({ userId: me.id, lastUpdate: old, title: 'Already titled' });
      await insertSession({ userId: me.id }); // fresh (lastUpdate defaults to now)

      const ids = await chatRepository.getUntitledSessionIdsForUser({ userId: me.id });
      expect(ids).toEqual([idle]);
    });
  });
});
