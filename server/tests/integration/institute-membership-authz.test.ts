/**
 * Institute membership authorization — the one predicate pair (real DB).
 *
 * Phase 1 of the 2026-09-10 authorization structural pass. Three things are
 * pinned here, all of them behaviour rather than shape:
 *
 * 1. **C9 — `isActive` is honoured.** Removal from an institute is a SOFT
 *    delete (`removeUserFromInstitute` → `isActive: false`).
 *    `locationService` and `calendarService` used `getInstituteUserLink` raw as
 *    a boolean, so a terminated staff member kept read/write on the institute's
 *    locations and edit/delete on its calendar events — contradicting
 *    SECURITY_ARCHITECTURE §5.6's claim that workforce termination ends access
 *    immediately. Non-vacuity is asserted IN the test: the membership ROW is
 *    still there and still says `isAdmin`, which is exactly what the pre-change
 *    code tested, so these cases would have admitted.
 *
 * 2. **Support mode is answered identically by every membership predicate.**
 *    `instituteService.verifyMembership` used to read the raw row and therefore
 *    REFUSED a customer-support agent while `isUserMemberOfInstitute` admitted
 *    them — two answers to one question.
 *
 * 3. **`getAssignedAppIds` always filters.** Its `ctx` used to be optional, and
 *    an absent ctx dropped the cross-institute visibility predicate entirely
 *    (the fail-open half of the `buildClinicianCtx` sentinel).
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import { makeUser, makeInstitute, makeStudent, addUserToInstitute } from '../helpers/factories.js';
import { instituteRepository } from '../../repositories/instituteRepository.js';
import { customAppRepository } from '../../repositories/customAppRepository.js';
import { instituteService } from '../../services/instituteService.js';
import { locationService } from '../../services/locationService.js';
import { calendarService } from '../../services/calendarService.js';
import { runWithSupportContext } from '../../services/customerSupportService.js';
import type { CalendarEvent } from '@shared/schema';

describe('Institute membership authorization', () => {
  afterEach(truncateAll);

  let ownerId: string;
  let staffId: string;
  let adminId: string;
  let instituteId: string;

  beforeEach(async () => {
    const owner = await makeUser();
    const staff = await makeUser();
    const otherAdmin = await makeUser();
    const { institute } = await makeInstitute(owner.id);
    ownerId = owner.id;
    staffId = staff.id;
    adminId = otherAdmin.id;
    instituteId = institute.id;
    await addUserToInstitute(instituteId, staffId, { isAdmin: false });
    await addUserToInstitute(instituteId, adminId, { isAdmin: true });
  });

  // ---------------------------------------------------------------- C9 ----

  describe('C9 — a DEACTIVATED member is refused everywhere', () => {
    it('NON-VACUITY: the membership row survives deactivation and still says isAdmin', async () => {
      expect(await instituteRepository.removeUserFromInstitute(instituteId, adminId)).toBe(true);
      // This is precisely what the pre-change code read: `getInstituteUserLink`
      // filters on (instituteId, userId) only. `!!link` and `!!link?.isAdmin`
      // are BOTH still true, i.e. the old locationService/calendarService gates
      // would have admitted this user.
      const link = await instituteRepository.getInstituteUserLink(instituteId, adminId);
      expect(link).toBeDefined();
      expect(link!.isActive).toBe(false);
      expect(link!.isAdmin).toBe(true);
      expect(!!link).toBe(true);
      expect(!!link?.isAdmin).toBe(true);
      // The predicate pair, which is what everything now uses, says no.
      expect(await instituteRepository.isUserMemberOfInstitute(instituteId, adminId)).toBe(false);
      expect(await instituteRepository.isUserAdminOfInstitute(instituteId, adminId)).toBe(false);
    });

    it('locations: a deactivated member can no longer list, read or create', async () => {
      const created = await locationService.create(
        { instituteId, title: 'Clinic', latitude: 32.0853, longitude: 34.7818 },
        adminId,
      );
      expect(created).not.toBeNull();
      // Sanity: while active, staff can read it.
      expect(await locationService.listForInstitute(instituteId, staffId)).toHaveLength(1);

      await instituteRepository.removeUserFromInstitute(instituteId, staffId);

      expect(await locationService.listForInstitute(instituteId, staffId)).toBeNull();
      expect(await locationService.get(created!.id, staffId)).toBeNull();
      expect(
        await locationService.create(
          { instituteId, title: 'Sneaky', latitude: 1, longitude: 2 },
          staffId,
        ),
      ).toBeNull();
    });

    it('locations: a deactivated ADMIN can no longer edit or delete someone else\'s location', async () => {
      const created = await locationService.create(
        { instituteId, title: 'Clinic', latitude: 1, longitude: 2 },
        ownerId,
      );
      // Sanity: while active, another institute admin may edit it.
      expect(await locationService.update(created!.id, { title: 'Renamed' }, adminId)).not.toBeNull();

      await instituteRepository.removeUserFromInstitute(instituteId, adminId);

      expect(await locationService.update(created!.id, { title: 'Hijacked' }, adminId)).toBeNull();
      expect(await locationService.remove(created!.id, adminId)).toBe(false);
      // ...and the location is untouched.
      expect((await locationService.get(created!.id, ownerId))!.title).toBe('Renamed');
    });

    it('calendar: a deactivated admin can no longer edit an institute event', async () => {
      const event = {
        id: 'event-1',
        createdByUserId: ownerId,
        instituteId,
      } as unknown as CalendarEvent;

      expect(await calendarService.canUserEditEvent(event, adminId)).toBe(true);
      await instituteRepository.removeUserFromInstitute(instituteId, adminId);
      expect(await calendarService.canUserEditEvent(event, adminId)).toBe(false);
      // The creator keeps their own event either way — the rule that changed is
      // the institute-admin one, not the creator one.
      expect(await calendarService.canUserEditEvent(event, ownerId)).toBe(true);
    });

    it('verifyMembership refuses a deactivated member (it always did — pinned against regression)', async () => {
      await instituteRepository.removeUserFromInstitute(instituteId, staffId);
      expect(await instituteService.verifyMembership(instituteId, staffId)).toEqual({
        isMember: false,
        isAdmin: false,
      });
    });
  });

  // ------------------------------------------------------- support mode ----

  describe('every membership predicate answers support mode the same way', () => {
    const OUTSIDER = 'no-such-user-at-all';

    it('inside a support session for the institute, all three admit', async () => {
      const outsider = await makeUser();
      await runWithSupportContext(instituteId, async () => {
        expect(await instituteRepository.isUserMemberOfInstitute(instituteId, outsider.id)).toBe(true);
        expect(await instituteRepository.isUserAdminOfInstitute(instituteId, outsider.id)).toBe(true);
        const vm = await instituteService.verifyMembership(instituteId, outsider.id);
        expect(vm.isMember).toBe(true);
        expect(vm.isAdmin).toBe(true);
        // There is no membership ROW on this path — that absence is the whole
        // reason the raw-row reading refused a support agent.
        expect(vm.membership).toBeUndefined();
      });
    });

    it('outside a support session, all three refuse the same outsider', async () => {
      expect(await instituteRepository.isUserMemberOfInstitute(instituteId, OUTSIDER)).toBe(false);
      expect(await instituteRepository.isUserAdminOfInstitute(instituteId, OUTSIDER)).toBe(false);
      expect(await instituteService.verifyMembership(instituteId, OUTSIDER)).toEqual({
        isMember: false,
        isAdmin: false,
      });
    });

    it('a support session for a DIFFERENT institute grants nothing here', async () => {
      const { institute: other } = await makeInstitute(ownerId);
      await runWithSupportContext(other.id, async () => {
        expect(await instituteRepository.isUserMemberOfInstitute(instituteId, OUTSIDER)).toBe(false);
        expect(await instituteService.verifyMembership(instituteId, OUTSIDER)).toEqual({
          isMember: false,
          isAdmin: false,
        });
      });
    });

    it('getActiveMembership stays support-BLIND — the third-party question', async () => {
      // A package grant must land on a real member; a support session over the
      // institute must not make an arbitrary user look like one.
      const outsider = await makeUser();
      await runWithSupportContext(instituteId, async () => {
        expect(await instituteRepository.getActiveMembership(instituteId, outsider.id)).toBeUndefined();
        expect(await instituteRepository.getActiveMembership(instituteId, staffId)).toBeDefined();
      });
    });

    it('a deactivated member is NOT resurrected by getActiveMembership', async () => {
      await instituteRepository.removeUserFromInstitute(instituteId, staffId);
      expect(await instituteRepository.getInstituteUserLink(instituteId, staffId)).toBeDefined();
      expect(await instituteRepository.getActiveMembership(instituteId, staffId)).toBeUndefined();
    });
  });

  // --------------------------------------------- the fail-open sentinel ----

  describe('getAssignedAppIds always applies the visibility filter', () => {
    it('an institute principal does not see an assignment owned by another institute', async () => {
      const { student } = await makeStudent(ownerId);
      const { institute: otherInstitute } = await makeInstitute(adminId);

      const app = await customAppRepository.createApp({
        userId: ownerId,
        instituteId: otherInstitute.id,
        name: 'Other institute game',
        definition: {},
      } as any);
      await customAppRepository.assignToStudent({
        appId: app.id,
        studentId: student.id,
        // The ASSIGNMENT's owner is the cross-institute visibility key.
        instituteId: otherInstitute.id,
        assignedByUserId: adminId,
      } as any);

      // Principal scoped to `instituteId` — not the assignment's owner, no share.
      expect(
        await customAppRepository.getAssignedAppIds(student.id, {
          kind: 'institute',
          instituteId,
          userId: ownerId,
        }),
      ).toEqual([]);

      // The student principal (the AAC session, and the clinician fallback when
      // no institute is selected) sees their own assignment.
      expect(
        await customAppRepository.getAssignedAppIds(student.id, {
          kind: 'student',
          studentId: student.id,
        }),
      ).toEqual([app.id]);

      // A principal in the owning institute sees it.
      expect(
        await customAppRepository.getAssignedAppIds(student.id, {
          kind: 'institute',
          instituteId: otherInstitute.id,
          userId: adminId,
        }),
      ).toEqual([app.id]);
    });

    it('a student principal for someone else sees nothing', async () => {
      const { student } = await makeStudent(ownerId);
      const { student: otherStudent } = await makeStudent(adminId);
      const app = await customAppRepository.createApp({
        userId: ownerId,
        instituteId,
        name: 'Game',
        definition: {},
      } as any);
      await customAppRepository.assignToStudent({
        appId: app.id,
        studentId: student.id,
        instituteId,
        assignedByUserId: ownerId,
      } as any);

      expect(
        await customAppRepository.getAssignedAppIds(student.id, {
          kind: 'student',
          studentId: otherStudent.id,
        }),
      ).toEqual([]);
    });
  });
});
