/**
 * Tests for the right-to-erasure (GDPR Art. 17 / IL Privacy Protection Law)
 * soft-delete + scheduled hard-delete pipeline.
 *
 * Verifies:
 *   - softDeleteStudent flips tombstone columns and revokes user/institute access
 *   - cancelErasure restores access while inside the window
 *   - cancelErasure throws once the window has elapsed
 *   - getErasureStatus reflects state correctly across transitions
 *   - the cron sweep hard-deletes expired tombstoned students
 *   - hard-delete cascades through PHI tables (programs, goals, chat_sessions, etc.)
 *   - audit-log entries for student_erasure_* are exempt from retention pruning
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeStudent, makeInstitute } from '../helpers/factories.js';
import {
  studentErasureService,
  ERASURE_AUDIT_EVENT_TYPES,
} from '../../services/studentErasureService.js';
import { runStudentErasureSweep } from '../../services/studentErasureCron.js';
import { runActivityLogRetentionCheck } from '../../services/activityLogRetentionCron.js';
import { s3Service } from '../../services/storage/s3-service.js';
import { personRepository } from '../../repositories/personRepository.js';
import {
  createContact,
  enrollContactFace,
} from '../../services/biometric/recognition-service.js';
import {
  students,
  studentContacts,
  userStudents,
  programs,
  goals,
  profileDomains,
  chatSessions,
  activityLogs,
  aacSettings,
  biometricData,
  aacUtteranceEvents,
  lettersOfMedicalNecessity,
  clinicianActivityIntervals,
  persons,
  personChatRooms,
  personChats,
  personChatRoomParticipants,
  callSessions,
  callParticipants,
} from '@shared/schema';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * activityLogService.log is fire-and-forget; under test we sometimes race
 * the assertion. Poll for up to 2s for the expected log row to land.
 */
async function waitForLog(eventType: string, subjectId: string): Promise<any> {
  for (let i = 0; i < 20; i++) {
    const rows = await db
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.eventType, eventType as any));
    const match = rows.find((r) => r.subjectId1 === subjectId);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Activity log ${eventType} for ${subjectId} did not appear within 2s`);
}

describe('student erasure', () => {
  afterEach(truncateAll);

  describe('softDeleteStudent', () => {
    it('sets tombstone columns and revokes user-students link', async () => {
      const owner = await makeUser();
      const { student, link } = await makeStudent(owner.id);

      const status = await studentErasureService.softDeleteStudent(
        student.id,
        owner.id,
        null,
      );

      expect(status.state).toBe('tombstoned');
      expect(status.deletedAt).toBeInstanceOf(Date);
      expect(status.scheduledHardDeleteAt).toBeInstanceOf(Date);
      expect(status.cancellable).toBe(true);

      const [row] = await db.select().from(students).where(eq(students.id, student.id));
      expect(row.deletedAt).not.toBeNull();
      expect(row.scheduledHardDeleteAt).not.toBeNull();
      expect(row.isActive).toBe(false);

      const [linkRow] = await db.select().from(userStudents).where(eq(userStudents.id, link.id));
      expect(linkRow.isActive).toBe(false);
    });

    it('writes a student_erasure_requested audit log', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      await studentErasureService.softDeleteStudent(student.id, owner.id, null, 'guardian request');

      const logRow = await waitForLog('student_erasure_requested', student.id);
      expect(logRow.subjectId1).toBe(student.id);
      expect((logRow.details as any).reason).toBe('guardian request');
    });

    it('is idempotent — second call does not extend the window', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const first = await studentErasureService.softDeleteStudent(student.id, owner.id, null);
      const second = await studentErasureService.softDeleteStudent(student.id, owner.id, null);

      expect(first.scheduledHardDeleteAt!.getTime()).toBe(second.scheduledHardDeleteAt!.getTime());
    });

    it('returns state="missing" for an unknown studentId', async () => {
      const owner = await makeUser();
      const status = await studentErasureService.softDeleteStudent(
        '00000000-0000-4000-8000-000000000000',
        owner.id,
        null,
      );
      expect(status.state).toBe('missing');
    });
  });

  describe('cancelErasure', () => {
    it('restores access when called within the window', async () => {
      const owner = await makeUser();
      const { student, link } = await makeStudent(owner.id);

      await studentErasureService.softDeleteStudent(student.id, owner.id, null);
      const status = await studentErasureService.cancelErasure(student.id, owner.id, null);

      expect(status.state).toBe('active');
      expect(status.deletedAt).toBeNull();

      const [row] = await db.select().from(students).where(eq(students.id, student.id));
      expect(row.deletedAt).toBeNull();
      expect(row.isActive).toBe(true);

      const [linkRow] = await db.select().from(userStudents).where(eq(userStudents.id, link.id));
      expect(linkRow.isActive).toBe(true);
    });

    it('throws once scheduledHardDeleteAt has elapsed', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      // Backdate scheduledHardDeleteAt to the past, simulating an expired window.
      await db
        .update(students)
        .set({
          deletedAt: new Date(Date.now() - 31 * ONE_DAY_MS),
          scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS),
          isActive: false,
        })
        .where(eq(students.id, student.id));

      await expect(
        studentErasureService.cancelErasure(student.id, owner.id, null),
      ).rejects.toThrow(/Erasure window/);
    });
  });

  describe('hard-delete sweep', () => {
    it('does not touch a tombstoned student whose window is still open', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      await studentErasureService.softDeleteStudent(student.id, owner.id, null);

      const result = await runStudentErasureSweep();
      expect(result.hardDeleted).toBe(0);

      const [row] = await db.select().from(students).where(eq(students.id, student.id));
      expect(row).toBeDefined();
    });

    it('hard-deletes a tombstoned student whose window has elapsed', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      await studentErasureService.softDeleteStudent(student.id, owner.id, null);

      // Backdate scheduledHardDeleteAt to the past.
      await db
        .update(students)
        .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
        .where(eq(students.id, student.id));

      const result = await runStudentErasureSweep();
      expect(result.hardDeleted).toBe(1);
      expect(result.failed).toEqual([]);

      const [row] = await db.select().from(students).where(eq(students.id, student.id));
      expect(row).toBeUndefined();
    });

    it('cascades through PHI tables', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      // Sprinkle some PHI rows that should all disappear.
      const [program] = await db
        .insert(programs)
        .values({
          studentId: student.id,
          framework: 'us_iep',
          status: 'active',
        } as any)
        .returning();
      const [domain] = await db
        .insert(profileDomains)
        .values({
          programId: program.id,
          domainType: 'other',
          customName: 'Communication',
        } as any)
        .returning();
      const [goal] = await db
        .insert(goals)
        .values({
          programId: program.id,
          goalStatement: 'Greet 3 peers per day',
        } as any)
        .returning();
      const [chat] = await db
        .insert(chatSessions)
        .values({
          studentId: student.id,
          userId: owner.id,
          chatMode: 'chat',
          state: {},
        } as any)
        .returning();
      // Insurance-bridge + utterance-log PHI (no FK cascade — must be deleted
      // explicitly by _hardDeleteStudent or they survive erasure as orphans).
      const [utterance] = await db
        .insert(aacUtteranceEvents)
        .values({
          studentId: student.id,
          text: 'hello world',
          wordCount: 2,
          uniqueWordCount: 2,
          source: 'live_speech',
        } as any)
        .returning();
      const [lmn] = await db
        .insert(lettersOfMedicalNecessity)
        .values({ studentId: student.id } as any)
        .returning();
      const [interval] = await db
        .insert(clinicianActivityIntervals)
        .values({ userId: owner.id, studentId: student.id } as any)
        .returning();

      // Soft delete + backdate window + sweep.
      await studentErasureService.softDeleteStudent(student.id, owner.id, null);
      await db
        .update(students)
        .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
        .where(eq(students.id, student.id));
      await runStudentErasureSweep();

      // All cascade rows gone.
      expect(
        (await db.select().from(programs).where(eq(programs.id, program.id))).length,
      ).toBe(0);
      expect(
        (await db.select().from(profileDomains).where(eq(profileDomains.id, domain.id))).length,
      ).toBe(0);
      expect((await db.select().from(goals).where(eq(goals.id, goal.id))).length).toBe(0);
      expect(
        (await db.select().from(chatSessions).where(eq(chatSessions.id, chat.id))).length,
      ).toBe(0);
      expect(
        (await db.select().from(aacSettings).where(eq(aacSettings.studentId, student.id))).length,
      ).toBe(0);
      expect(
        (await db.select().from(aacUtteranceEvents).where(eq(aacUtteranceEvents.id, utterance.id))).length,
      ).toBe(0);
      expect(
        (await db.select().from(lettersOfMedicalNecessity).where(eq(lettersOfMedicalNecessity.id, lmn.id))).length,
      ).toBe(0);
      expect(
        (await db.select().from(clinicianActivityIntervals).where(eq(clinicianActivityIntervals.id, interval.id))).length,
      ).toBe(0);
    });

    it('erases the person facet: direct rooms deleted, group rooms creator-nulled, messages/calls/persons removed', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      // createStudent fires person provisioning fire-and-forget; resolve both
      // facets deterministically (getOrCreate is idempotent on the unique index).
      const studentPerson = await personRepository.getOrCreateForStudent(student.id);
      const ownerPerson = await personRepository.getOrCreateForUser(owner.id);

      // A room the STUDENT created — both participants, a message, and a call.
      const [studentRoom] = await db.insert(personChatRooms).values({
        instituteId: 'inst-erasure-test', isDirect: true, createdByPersonId: studentPerson.id,
      } as any).returning();
      await db.insert(personChatRoomParticipants).values([
        { roomId: studentRoom.id, personId: studentPerson.id },
        { roomId: studentRoom.id, personId: ownerPerson.id },
      ] as any);
      await db.insert(personChats).values({
        roomId: studentRoom.id, senderPersonId: studentPerson.id, body: 'hi from student',
      } as any);
      const [call] = await db.insert(callSessions).values({
        roomId: studentRoom.id, instituteId: 'inst-erasure-test', initiatedByPersonId: studentPerson.id,
      } as any).returning();
      await db.insert(callParticipants).values({ callId: call.id, personId: ownerPerson.id } as any);

      // A room someone ELSE created — the student sent one message into it.
      const [ownerRoom] = await db.insert(personChatRooms).values({
        instituteId: 'inst-erasure-test', isDirect: false, createdByPersonId: ownerPerson.id,
      } as any).returning();
      await db.insert(personChatRoomParticipants).values([
        { roomId: ownerRoom.id, personId: ownerPerson.id },
        { roomId: ownerRoom.id, personId: studentPerson.id },
      ] as any);
      const [studentMsg] = await db.insert(personChats).values({
        roomId: ownerRoom.id, senderPersonId: studentPerson.id, body: 'student in owner room',
      } as any).returning();
      const [ownerMsg] = await db.insert(personChats).values({
        roomId: ownerRoom.id, senderPersonId: ownerPerson.id, body: 'owner message',
      } as any).returning();

      // A GROUP room the STUDENT created — must survive for its other members.
      const [studentGroupRoom] = await db.insert(personChatRooms).values({
        instituteId: 'inst-erasure-test', isDirect: false, createdByPersonId: studentPerson.id,
      } as any).returning();
      await db.insert(personChatRoomParticipants).values([
        { roomId: studentGroupRoom.id, personId: studentPerson.id },
        { roomId: studentGroupRoom.id, personId: ownerPerson.id },
      ] as any);
      await db.insert(personChats).values({
        roomId: studentGroupRoom.id, senderPersonId: studentPerson.id, body: 'group msg from student',
      } as any);

      await studentErasureService.softDeleteStudent(student.id, owner.id, null);
      await db
        .update(students)
        .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
        .where(eq(students.id, student.id));
      const result = await runStudentErasureSweep();
      expect(result.failed).toEqual([]);
      expect(result.hardDeleted).toBe(1);

      // Student-created room + everything in it is gone (cascade).
      expect((await db.select().from(personChatRooms).where(eq(personChatRooms.id, studentRoom.id))).length).toBe(0);
      expect((await db.select().from(callSessions).where(eq(callSessions.id, call.id))).length).toBe(0);
      // The student's message in the OTHER room is gone; the owner's survives.
      expect((await db.select().from(personChats).where(eq(personChats.id, studentMsg.id))).length).toBe(0);
      expect((await db.select().from(personChats).where(eq(personChats.id, ownerMsg.id))).length).toBe(1);
      // The other person's room survives with only them still in it.
      expect((await db.select().from(personChatRooms).where(eq(personChatRooms.id, ownerRoom.id))).length).toBe(1);
      const remaining = await db.select().from(personChatRoomParticipants)
        .where(eq(personChatRoomParticipants.roomId, ownerRoom.id));
      expect(remaining.map((p) => p.personId)).toEqual([ownerPerson.id]);
      // The GROUP room the student created survives with the creator nulled
      // and the student's message + membership scrubbed.
      const [groupRow] = await db.select().from(personChatRooms).where(eq(personChatRooms.id, studentGroupRoom.id));
      expect(groupRow).toBeDefined();
      expect(groupRow.createdByPersonId).toBeNull();
      expect((await db.select().from(personChats).where(eq(personChats.roomId, studentGroupRoom.id))).length).toBe(0);
      const groupRemaining = await db.select().from(personChatRoomParticipants)
        .where(eq(personChatRoomParticipants.roomId, studentGroupRoom.id));
      expect(groupRemaining.map((p) => p.personId)).toEqual([ownerPerson.id]);
      // The student's persons row is gone; the owner's persists.
      expect((await db.select().from(persons).where(eq(persons.studentId, student.id))).length).toBe(0);
      expect((await db.select().from(persons).where(eq(persons.id, ownerPerson.id))).length).toBe(1);
    });

    it('writes a student_erasure_completed audit log', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      await studentErasureService.softDeleteStudent(student.id, owner.id, null);
      await db
        .update(students)
        .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
        .where(eq(students.id, student.id));

      await runStudentErasureSweep();

      const logRow = await waitForLog('student_erasure_completed', student.id);
      expect(logRow.subjectId1).toBe(student.id);
    });
  });

  describe('S3 cleanup', () => {
    it("erases the student's CONTACTS' face records and photos too", async () => {
      // A contact's face lives on its own biometric_data row, referenced only by
      // the contact. Deleting the contacts without releasing those rows leaves
      // every enrolled face this student's circle ever gave us sitting in the
      // DB and the bucket, unreachable by any later erasure — Art. 17 residue.
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const contact = await createContact({ studentId: student.id, name: 'Grandma' } as any);
      await enrollContactFace(contact.id, new Array(128).fill(0.1));
      const [contactRow] = await db
        .select({ bd: studentContacts.biometricDataId })
        .from(studentContacts)
        .where(eq(studentContacts.id, contact.id));
      const contactBdId = contactRow.bd!;
      await db
        .update(biometricData)
        .set({ faceImageUrl: 'biometric/contact-face.jpg' })
        .where(eq(biometricData.id, contactBdId));

      const deleteSpy = jest.spyOn(s3Service, 'delete').mockResolvedValue(undefined);
      try {
        await studentErasureService.softDeleteStudent(student.id, owner.id, null);
        await db
          .update(students)
          .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
          .where(eq(students.id, student.id));

        const result = await runStudentErasureSweep();
        expect(result.hardDeleted).toBe(1);

        // Row gone, and its photo queued for the bucket.
        const [survivor] = await db
          .select()
          .from(biometricData)
          .where(eq(biometricData.id, contactBdId));
        expect(survivor).toBeUndefined();
        expect(deleteSpy).toHaveBeenCalledWith('biometric/contact-face.jpg');
      } finally {
        deleteSpy.mockRestore();
      }
    });

    it("does not erase a LINKED contact's shared face record", async () => {
      // The contact is a user in their own right; that person's face record
      // isn't this student's to erase.
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);
      const relative = await makeUser();

      const contact = await createContact({
        studentId: student.id, name: 'Uncle', linkedUserId: relative.id,
      } as any);
      const [contactRow] = await db
        .select({ bd: studentContacts.biometricDataId })
        .from(studentContacts)
        .where(eq(studentContacts.id, contact.id));
      const sharedBdId = contactRow.bd!;

      await studentErasureService.softDeleteStudent(student.id, owner.id, null);
      await db
        .update(students)
        .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
        .where(eq(students.id, student.id));
      expect((await runStudentErasureSweep()).hardDeleted).toBe(1);

      const [survivor] = await db
        .select()
        .from(biometricData)
        .where(eq(biometricData.id, sharedBdId));
      expect(survivor).toBeDefined();
    });

    it('passes the biometric S3 key to s3Service.delete after the DB commit', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      // Create a biometric record and link it to the student.
      const [bio] = await db
        .insert(biometricData)
        .values({ faceImageUrl: 'biometric/test-key-abc.jpg' } as any)
        .returning();
      await db.update(students).set({ biometricDataId: bio.id }).where(eq(students.id, student.id));

      const deleteSpy = jest.spyOn(s3Service, 'delete').mockResolvedValue(undefined);

      try {
        await studentErasureService.softDeleteStudent(student.id, owner.id, null);
        await db
          .update(students)
          .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
          .where(eq(students.id, student.id));

        const result = await runStudentErasureSweep();
        expect(result.hardDeleted).toBe(1);
        expect(result.s3KeysFailed).toEqual([]);

        expect(deleteSpy).toHaveBeenCalledWith('biometric/test-key-abc.jpg');
      } finally {
        deleteSpy.mockRestore();
      }
    });

    it('records S3 failures without rolling back the DB delete', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const [bio] = await db
        .insert(biometricData)
        .values({ faceImageUrl: 'biometric/will-fail.jpg' } as any)
        .returning();
      await db.update(students).set({ biometricDataId: bio.id }).where(eq(students.id, student.id));

      const deleteSpy = jest.spyOn(s3Service, 'delete').mockRejectedValue(new Error('simulated S3 outage'));

      try {
        await studentErasureService.softDeleteStudent(student.id, owner.id, null);
        await db
          .update(students)
          .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
          .where(eq(students.id, student.id));

        const result = await runStudentErasureSweep();
        expect(result.hardDeleted).toBe(1);
        expect(result.s3KeysFailed).toContain('biometric/will-fail.jpg');

        // DB state: student row + biometric_data row are gone despite the S3 failure.
        const [studentRow] = await db.select().from(students).where(eq(students.id, student.id));
        expect(studentRow).toBeUndefined();
        const [bioRow] = await db.select().from(biometricData).where(eq(biometricData.id, bio.id));
        expect(bioRow).toBeUndefined();
      } finally {
        deleteSpy.mockRestore();
      }
    });

    it('skips S3 cleanup when the student has no biometric record', async () => {
      const owner = await makeUser();
      const { student } = await makeStudent(owner.id);

      const deleteSpy = jest.spyOn(s3Service, 'delete').mockResolvedValue(undefined);

      try {
        await studentErasureService.softDeleteStudent(student.id, owner.id, null);
        await db
          .update(students)
          .set({ scheduledHardDeleteAt: new Date(Date.now() - ONE_DAY_MS) })
          .where(eq(students.id, student.id));

        const result = await runStudentErasureSweep();
        expect(result.hardDeleted).toBe(1);
        expect(deleteSpy).not.toHaveBeenCalled();
      } finally {
        deleteSpy.mockRestore();
      }
    });
  });

  describe('audit-log retention exemption', () => {
    it('retention cron does NOT prune student_erasure_* events past the cutoff', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id);

      // Insert a 2-year-old erasure-completed log under an institute with
      // the default 1-year retention. A normal log this old would be
      // pruned; the erasure log must survive.
      const erasureRow = (await db
        .insert(activityLogs)
        .values({
          instituteId: institute.id,
          userId: owner.id,
          eventType: 'student_erasure_completed',
          subjectType1: 'student',
          subjectId1: '00000000-0000-4000-8000-000000000001',
          createdAt: new Date(Date.now() - 365 * 2 * ONE_DAY_MS),
        } as any)
        .returning())[0];

      // Sanity: a non-exempt log of the same age should be deleted.
      const normalRow = (await db
        .insert(activityLogs)
        .values({
          instituteId: institute.id,
          userId: owner.id,
          eventType: 'auth_login_failure',
          subjectType1: 'user',
          subjectId1: owner.id,
          createdAt: new Date(Date.now() - 365 * 2 * ONE_DAY_MS),
        } as any)
        .returning())[0];

      await runActivityLogRetentionCheck();

      const erasureExists = (await db.select().from(activityLogs).where(eq(activityLogs.id, erasureRow.id))).length;
      const normalExists = (await db.select().from(activityLogs).where(eq(activityLogs.id, normalRow.id))).length;
      expect(erasureExists).toBe(1);
      expect(normalExists).toBe(0);
    });

    it('exposes the exempt event-type list as a constant', () => {
      expect(ERASURE_AUDIT_EVENT_TYPES).toContain('student_erasure_requested');
      expect(ERASURE_AUDIT_EVENT_TYPES).toContain('student_erasure_cancelled');
      expect(ERASURE_AUDIT_EVENT_TYPES).toContain('student_erasure_completed');
    });
  });
});
