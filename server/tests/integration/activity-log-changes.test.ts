/**
 * Integration tests for field-level activity logging.
 *
 * Two things are pinned down here, both traced back to a real incident: a
 * caretaker's email address ended up in `aac_settings.aiName` (and from there
 * in the live system prompts), and the activity log could not say which field
 * had moved or whether a human or the AI had moved it.
 *
 *   1. `studentService.updateStudent` reports the diff, split correctly across
 *      the students / aac_settings tables.
 *   2. The AI's AAC-settings write path leaves an audit row at all — it used to
 *      write `aiName` completely silently.
 *
 * Uses the real Postgres test DB (server/tests/global-setup.ts).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import { makeUser, makeStudent, studentService } from '../helpers/factories.js';
import { db } from '../../db.js';
import { activityLogs } from '@shared/schema';
import { eq } from 'drizzle-orm';
import type { ChangeMap } from '../../services/activityChanges.js';
import { AAC_SETTINGS_FIELD } from '../../services/memory-schema/aac-settings-memory-schema.js';

/** activityLogService.log is fire-and-forget — poll rather than read straight back. */
async function waitForLog(subjectId: string): Promise<any> {
  for (let i = 0; i < 20; i++) {
    const rows = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.subjectId1, subjectId));
    if (rows.length) return rows[rows.length - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No activity log for ${subjectId} within 2s`);
}

describe('activity log — field-level changes', () => {
  afterEach(truncateAll);

  describe('studentService.updateStudent', () => {
    it('reports student and AAC settings changes from one mixed PATCH', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      let changes: ChangeMap = {};
      await studentService.updateStudent(
        student.id,
        { primaryLanguage: 'he', iconTextRatio: 5, eyegazeEnabled: true },
        { onChanges: (c) => { changes = c; } },
      );

      expect(Object.keys(changes).sort()).toEqual([
        'eyegazeEnabled',
        'iconTextRatio',
        'primaryLanguage',
      ]);
      expect(changes.iconTextRatio).toEqual({ from: 3, to: 5 });
      expect(changes.eyegazeEnabled.to).toBe(true);
      expect(changes.primaryLanguage.to).toBe('he');
    });

    it('names aiName without recording the address that landed in it', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      let changes: ChangeMap = {};
      await studentService.updateStudent(
        student.id,
        { aiName: 'someone@example.com' },
        { onChanges: (c) => { changes = c; } },
      );

      expect(changes.aiName).toEqual({ from: 'empty', to: 'set', redacted: true });
      expect(JSON.stringify(changes)).not.toContain('example.com');
    });

    it('reports nothing for a save that changes nothing', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      await studentService.updateStudent(student.id, { iconTextRatio: 5 });

      let changes: ChangeMap = {};
      await studentService.updateStudent(
        student.id,
        { iconTextRatio: 5 },
        { onChanges: (c) => { changes = c; } },
      );
      expect(changes).toEqual({});
    });

    it('does not read the before-snapshot when no one is auditing', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      // No onChanges — must still apply the update, just without the extra read.
      const updated = await studentService.updateStudent(student.id, { iconTextRatio: 2 });
      expect(updated?.aacSettings?.iconTextRatio).toBe(2);
    });
  });

  describe('AI write path (aac-settings memory schema)', () => {
    it('writes an AI-attributed audit row naming the changed field', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const ctx: any = {
        all: {
          studentId: student.id,
          userId: owner.id,
          accessCtx: { kind: 'admin' },
        },
      };

      await (AAC_SETTINGS_FIELD as any).db.write(ctx, {
        aiName: 'someone@example.com',
        iconTextRatio: 5,
      });

      const row = await waitForLog(student.id);
      expect(row.eventType).toBe('update');
      expect(row.subjectType1).toBe('student');
      expect(row.isAiInitiated).toBe(true);
      expect(row.userId).toBe(owner.id);

      const details = row.details as any;
      expect(details.via).toBe('aac_settings');
      expect(Object.keys(details.changes).sort()).toEqual(['aiName', 'iconTextRatio']);
      expect(details.changes.aiName).toEqual({ from: 'empty', to: 'set', redacted: true });
      expect(details.changes.iconTextRatio).toEqual({ from: 3, to: 5 });
      expect(JSON.stringify(details)).not.toContain('example.com');
    });
  });
});
