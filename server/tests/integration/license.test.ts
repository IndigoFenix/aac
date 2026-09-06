/**
 * License integration tests.
 *
 * Covers create / update / link-to-user / delete and the resolution of
 * license info + permissions for an institute. Uses a real Postgres
 * test database — see server/tests/global-setup.ts.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import {
  makeUser,
  makeInstitute,
  makeLicense,
  licenseService,
  licenseRepository,
  instituteRepository,
} from '../helpers/factories.js';

describe('License integration', () => {
  afterEach(truncateAll);

  describe('create', () => {
    it('creates a standalone (non-institute) license bound to invite email', async () => {
      const license = await makeLicense({ inviteEmail: 'invitee@test.local' });
      expect(license.id).toBeDefined();
      expect(license.inviteEmail).toBe('invitee@test.local');
      expect(license.instituteId).toBeNull();
      expect(license.userId).toBeNull();
      expect(license.isActive).toBe(true);
      expect(license.licenseType).toBe('standard');
    });

    it('creates a license bound to an institute', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id, { type: 'school' });

      const license = await makeLicense({
        inviteEmail: 'admin@school.local',
        instituteId: institute.id,
      });

      expect(license.instituteId).toBe(institute.id);
      const found = await licenseRepository.getLicensesByInstituteId(institute.id);
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(license.id);
    });

    it('persists trial flags', async () => {
      const trialEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const license = await makeLicense({
        isTrial: true,
        trialExpiresAt: trialEnd.toISOString(),
      });

      expect(license.isTrial).toBe(true);
      expect(license.trialExpiresAt).toBeInstanceOf(Date);
      expect(license.trialExpiresAt!.getTime()).toBeCloseTo(trialEnd.getTime(), -3);
    });

    it('stores guardian-identity prefill on family-institute provisioning', async () => {
      const owner = await (await import('../helpers/factories.js')).makeUser({ isSystemAdmin: true });
      const license = await licenseService.createLicenseWithSetup(
        {
          inviteEmail: 'parent@test.local',
          firstName: 'Parent',
          lastName: 'Tester',
          createInstitute: true,
          instituteName: 'Family',
          instituteType: 'family',
          country: 'IL',
          phone: '+972541234567',
          governmentIdNumber: '123456789',
          governmentIdType: 'national_id',
          governmentIdCountry: 'IL',
          identityProvenanceNote: 'verified during intake call',
        } as any,
        'http://localhost',
        owner.id,
      );
      const defaults = license.inviteDefaults as any;
      expect(defaults.country).toBe('IL');
      expect(defaults.phone).toBe('+972541234567');
      expect(defaults.governmentIdNumber).toBe('123456789');
      expect(defaults.governmentIdType).toBe('national_id');
      expect(defaults.governmentIdCountry).toBe('IL');
      expect(defaults.identityProvenanceNote).toBe('verified during intake call');
    });

    it('drops guardian-identity prefill for non-family institutes', async () => {
      const owner = await (await import('../helpers/factories.js')).makeUser({ isSystemAdmin: true });
      const license = await licenseService.createLicenseWithSetup(
        {
          inviteEmail: 'school@test.local',
          firstName: 'School',
          lastName: 'Admin',
          createInstitute: true,
          instituteName: 'Some School',
          instituteType: 'school',
          country: 'IL',
          phone: '+972540000000',
          governmentIdNumber: '999999999',
        } as any,
        'http://localhost',
        owner.id,
      );
      const defaults = license.inviteDefaults as any;
      // School / clinic licenses should not carry guardian-identity bits.
      expect(defaults?.country).toBeUndefined();
      expect(defaults?.governmentIdNumber).toBeUndefined();
      // Recipient name fields still come through.
      expect(defaults?.firstName).toBe('School');
    });
  });

  describe('lookup', () => {
    it('finds a license by invite email', async () => {
      await makeLicense({ inviteEmail: 'lookup@test.local' });
      const found = await licenseRepository.getLicenseByInviteEmail('lookup@test.local');
      expect(found).toBeDefined();
      expect(found!.inviteEmail).toBe('lookup@test.local');
    });

    it('returns undefined for unknown invite email', async () => {
      const found = await licenseRepository.getLicenseByInviteEmail('nobody@test.local');
      expect(found).toBeUndefined();
    });
  });

  describe('update', () => {
    it('updates permissions JSON', async () => {
      const license = await makeLicense({ permissions: { all: false } as any });
      const updated = await licenseService.updateLicense(license.id, {
        permissions: {
          all: false,
          maxStudents: 10,
          aacEnabled: true,
          boardMakerEnabled: false,
          customAppsEnabled: false,
          unrestrictedAI: false,
          calendar: true,
          dashboardLevel: 1,
          expertAgentsCount: 0,
          deepAnalysisEnabled: false,
        },
      } as any);

      expect(updated).toBeDefined();
      expect(updated!.permissions?.aacEnabled).toBe(true);
      expect(updated!.permissions?.calendar).toBe(true);
      expect(updated!.permissions?.maxStudents).toBe(10);
    });
  });

  describe('linkLicenseToUser', () => {
    it('links a pending license to a user after registration', async () => {
      const email = 'pending-license@test.local';
      const license = await makeLicense({ inviteEmail: email });
      expect(license.userId).toBeNull();
      expect(license.activatedAt).toBeNull();

      const user = await makeUser({ email });
      const linked = await licenseService.linkLicenseToUser(email, user.id);

      expect(linked).toBeDefined();
      expect(linked!.userId).toBe(user.id);
      expect(linked!.activatedAt).toBeInstanceOf(Date);
    });

    it('returns undefined when no license matches the email', async () => {
      const user = await makeUser();
      const linked = await licenseService.linkLicenseToUser(
        'no-license@test.local',
        user.id,
      );
      expect(linked).toBeUndefined();
    });
  });

  describe('getInstituteLicenseInfo', () => {
    it('returns "none" when institute has no active license', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id);

      const info = await licenseService.getInstituteLicenseInfo(institute.id);
      expect(info.licenseType).toBe('none');
      expect(info.isTrial).toBe(false);
      expect(info.permissions.aacEnabled).toBe(false);
    });

    it('returns the active license for an institute', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id);

      await makeLicense({
        instituteId: institute.id,
        permissions: { all: true } as any,
        licenseType: 'premium',
      });

      const info = await licenseService.getInstituteLicenseInfo(institute.id);
      expect(info.licenseType).toBe('premium');
      // `all: true` resolves to MAX_LICENSE_PERMISSIONS via resolvePermissions
      expect(info.permissions.aacEnabled).toBe(true);
      expect(info.permissions.maxStudents).toBe(-1);
      expect(info.permissions.calendar).toBe(true);
    });

    it('isSystemAdmin shortcut grants MAX permissions regardless of institute', async () => {
      const info = await licenseService.getInstituteLicenseInfo(undefined, true);
      expect(info.licenseType).toBe('enterprise');
      expect(info.permissions.maxStudents).toBe(-1);
      expect(info.permissions.aacEnabled).toBe(true);
    });
  });

  describe('getInstituteLicenseInfo — expiry', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('an expired trial keeps its identity and price but grants nothing', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id);
      const license = await makeLicense({
        instituteId: institute.id,
        permissions: { all: true } as any,
        licenseType: 'premium',
        isTrial: true,
        trialExpiresAt: new Date(Date.now() - DAY).toISOString(),
      });
      await licenseRepository.updateLicense(license.id, {
        priceAmount: 120000,
        priceCurrency: 'ILS',
      } as any);

      const info = await licenseService.getInstituteLicenseInfo(institute.id);

      // Permissions are gone...
      expect(info.status).toBe('expired');
      expect(info.permissions.aacEnabled).toBe(false);
      expect(info.permissions.maxStudents).toBe(0);
      // ...but the client still learns WHICH license to offer, and for how much.
      expect(info.licenseId).toBe(license.id);
      expect(info.priceAmount).toBe(120000);
      expect(info.priceCurrency).toBe('ILS');
      expect(info.subscriptionType).toBe('monthly');
      expect(info.expiresAt).toBeInstanceOf(Date);
    });

    it('a running trial is "trial" and keeps its permissions', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id);
      await makeLicense({
        instituteId: institute.id,
        permissions: { all: true } as any,
        isTrial: true,
        trialExpiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
      });

      const info = await licenseService.getInstituteLicenseInfo(institute.id);
      expect(info.status).toBe('trial');
      expect(info.permissions.aacEnabled).toBe(true);
    });

    it('a license with NO expiry stays active — nobody loses access on deploy', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id);
      await makeLicense({ instituteId: institute.id, permissions: { all: true } as any });

      const info = await licenseService.getInstituteLicenseInfo(institute.id);
      expect(info.status).toBe('active');
      expect(info.expiresAt).toBeNull();
      expect(info.permissions.aacEnabled).toBe(true);
    });

    it('a paid license lapsed past the grace period expires', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id);
      const license = await makeLicense({
        instituteId: institute.id,
        permissions: { all: true } as any,
      });
      await licenseRepository.updateLicense(license.id, {
        subscriptionExpiresAt: new Date(Date.now() - 10 * DAY),
      } as any);

      const info = await licenseService.getInstituteLicenseInfo(institute.id);
      expect(info.status).toBe('expired');
      expect(info.permissions.aacEnabled).toBe(false);
    });

    it('prefers a live license over an expired one in the same institute', async () => {
      const owner = await makeUser();
      const { institute } = await makeInstitute(owner.id);
      const stale = await makeLicense({
        instituteId: institute.id,
        permissions: { all: true } as any,
        isTrial: true,
        trialExpiresAt: new Date(Date.now() - DAY).toISOString(),
      });
      const live = await makeLicense({
        instituteId: institute.id,
        permissions: { all: true } as any,
        licenseType: 'premium',
      });

      const info = await licenseService.getInstituteLicenseInfo(institute.id);
      expect(info.licenseId).toBe(live.id);
      expect(info.licenseId).not.toBe(stale.id);
      expect(info.status).toBe('active');
    });
  });

  describe('getInviteLink', () => {
    // The admin "copy verification link" fallback: hands over the same link the
    // invite email carries, without sending mail and without invalidating a
    // link that is already in the recipient's inbox.

    it('mints and persists a token for a standalone license that has none', async () => {
      const license = await makeLicense({ inviteEmail: 'nolink@test.local' });
      expect(license.inviteToken).toBeNull();

      const owner = await makeUser({ isSystemAdmin: true });
      const result = await licenseService.getInviteLink(license.id, 'http://localhost', owner.id);

      expect(result.success).toBe(true);
      const stored = await licenseRepository.getLicenseById(license.id);
      expect(stored!.inviteToken).toBeTruthy();
      expect(result.inviteLink).toBe(`http://localhost/invite/${stored!.inviteToken}`);
    });

    it('returns the same standalone link on repeat calls', async () => {
      const license = await makeLicense({ inviteEmail: 'stable@test.local' });
      const owner = await makeUser({ isSystemAdmin: true });

      const first = await licenseService.getInviteLink(license.id, 'http://localhost', owner.id);
      const second = await licenseService.getInviteLink(license.id, 'http://localhost', owner.id);

      expect(first.inviteLink).toBe(second.inviteLink);
    });

    it('reuses a live pending institute invite instead of rotating it', async () => {
      const owner = await makeUser({ isSystemAdmin: true });
      const { institute } = await makeInstitute(owner.id, { type: 'school' });
      const license = await makeLicense({
        inviteEmail: 'principal@school.local',
        instituteId: institute.id,
      });

      const existing = await instituteRepository.createInvite(
        institute.id,
        'principal@school.local',
        owner.id,
        { role: 'admin', grantAdmin: true, expiresInDays: 30 },
      );

      const result = await licenseService.getInviteLink(license.id, 'http://localhost', owner.id);

      // Same token → the link already emailed still works.
      expect(result.inviteLink).toBe(`http://localhost/invite/${existing.token}`);
      const pending = await instituteRepository.getPendingInviteByEmail(
        institute.id,
        'principal@school.local',
      );
      expect(pending!.id).toBe(existing.id);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('creates an institute invite when none is pending', async () => {
      const owner = await makeUser({ isSystemAdmin: true });
      const { institute } = await makeInstitute(owner.id, { type: 'school' });
      const license = await makeLicense({
        inviteEmail: 'fresh@school.local',
        instituteId: institute.id,
      });

      const result = await licenseService.getInviteLink(license.id, 'http://localhost', owner.id);

      expect(result.success).toBe(true);
      const pending = await instituteRepository.getPendingInviteByEmail(
        institute.id,
        'fresh@school.local',
      );
      expect(pending).toBeDefined();
      expect(result.inviteLink).toBe(`http://localhost/invite/${pending!.token}`);
    });

    it('fails for an unknown license', async () => {
      const owner = await makeUser({ isSystemAdmin: true });
      const result = await licenseService.getInviteLink(
        '00000000-0000-4000-8000-000000000000',
        'http://localhost',
        owner.id,
      );
      expect(result.success).toBe(false);
      expect(result.inviteLink).toBeUndefined();
    });

    it('fails when the license carries no invite email', async () => {
      const license = await makeLicense();
      await licenseRepository.updateLicense(license.id, { inviteEmail: null } as any);
      const owner = await makeUser({ isSystemAdmin: true });

      const result = await licenseService.getInviteLink(license.id, 'http://localhost', owner.id);
      expect(result.success).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes a license and subsequent lookup returns undefined', async () => {
      const license = await makeLicense();
      const deleted = await licenseService.deleteLicense(license.id);
      expect(deleted).toBe(true);

      const lookup = await licenseService.getLicenseById(license.id);
      expect(lookup).toBeUndefined();
    });

    it('returns false when deleting a non-existent license', async () => {
      const deleted = await licenseService.deleteLicense(
        '00000000-0000-4000-8000-000000000000',
      );
      expect(deleted).toBe(false);
    });
  });
});
