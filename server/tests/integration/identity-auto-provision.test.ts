/**
 * Tests for SSO auto-provisioning (F.6).
 *
 * Covers:
 *   - autoProvisionFromProfile creates a new user + linked external identity
 *     when the IdP has autoProvision=true
 *   - calling on a provider with autoProvision=false throws
 *   - existing user matched by email is linked (no duplicate user)
 *   - userType maps from canonical claim into our internal bucket
 *   - missing email throws (we cannot create a user without one)
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { truncateAll, db } from '../helpers/db.js';
import { makeUser } from '../helpers/factories.js';
import { autoProvisionFromProfile } from '../../services/identity-auto-provision.js';
import { identityProviderRepository } from '../../repositories/identityProviderRepository.js';
import { users, userExternalIdentities } from '@shared/schema';
import type { CanonicalProfile } from '../../services/identity-claim-mapping.js';

async function makeSamlProvider(opts: { autoProvision: boolean; name?: string }) {
  return identityProviderRepository.create({
    name: opts.name ?? `Test SAML ${Date.now()}-${Math.random()}`,
    protocol: 'saml',
    samlSsoUrl: 'https://test.idp/sso',
    samlX509Cert: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
    samlNameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    autoProvision: opts.autoProvision,
    isActive: true,
    instituteIdType: 'il_moe',
  } as any);
}

function makeProfile(overrides: Partial<CanonicalProfile> = {}): CanonicalProfile {
  return {
    externalId: 'ext-' + Math.random().toString(36).slice(2),
    email: `t+${Date.now()}@example.com`,
    givenName: 'Test',
    familyName: 'User',
    raw: {},
    ...overrides,
  };
}

describe('SSO auto-provisioning', () => {
  afterEach(truncateAll);

  it('creates a new user and links the external identity when autoProvision=true', async () => {
    const provider = await makeSamlProvider({ autoProvision: true });
    const profile = makeProfile({ email: 'newteacher@example.com' });

    const out = await autoProvisionFromProfile(provider, profile);

    expect(out.created).toBe(true);
    expect(out.user.email).toBe('newteacher@example.com');
    expect(out.user.firstName).toBe('Test');
    expect(out.user.lastName).toBe('User');

    const link = await identityProviderRepository.getExternalIdentityByExternalId(provider.id, profile.externalId);
    expect(link).toBeDefined();
    expect(link!.userId).toBe(out.user.id);
  });

  it('links to an existing user matched by email instead of creating a duplicate', async () => {
    const provider = await makeSamlProvider({ autoProvision: true });
    const existing = await makeUser({ email: 'existing@example.com' });
    const profile = makeProfile({ email: 'existing@example.com' });

    const out = await autoProvisionFromProfile(provider, profile);

    expect(out.created).toBe(false);
    expect(out.user.id).toBe(existing.id);

    const allMatching = await db.select().from(users).where(eq(users.email, 'existing@example.com'));
    expect(allMatching.length).toBe(1);
  });

  it('case-insensitively matches the existing-user email', async () => {
    const provider = await makeSamlProvider({ autoProvision: true });
    const existing = await makeUser({ email: 'mixed@example.com' });
    const profile = makeProfile({ email: 'MIXED@example.com' });

    const out = await autoProvisionFromProfile(provider, profile);

    expect(out.created).toBe(false);
    expect(out.user.id).toBe(existing.id);
  });

  it('throws when the provider has autoProvision=false', async () => {
    const provider = await makeSamlProvider({ autoProvision: false });
    const profile = makeProfile();

    await expect(
      autoProvisionFromProfile(provider, profile),
    ).rejects.toThrow(/auto-provisioning disabled/);
  });

  it('throws when the SSO assertion has no email claim', async () => {
    const provider = await makeSamlProvider({ autoProvision: true });
    const profile = makeProfile({ email: undefined });

    await expect(
      autoProvisionFromProfile(provider, profile),
    ).rejects.toThrow(/no email claim/);
  });

  it('maps known userType claims into our internal bucket', async () => {
    const provider = await makeSamlProvider({ autoProvision: true });
    const profile = makeProfile({ email: 't+role@example.com', userType: 'teacher' });

    const out = await autoProvisionFromProfile(provider, profile);
    expect(out.user.userType).toBe('Teacher');
  });

  it('falls back to "Caregiver" for unknown userType claims', async () => {
    const provider = await makeSamlProvider({ autoProvision: true });
    const profile = makeProfile({ email: 't+unknown@example.com', userType: 'mysterious-role' });

    const out = await autoProvisionFromProfile(provider, profile);
    expect(out.user.userType).toBe('Caregiver');
  });

  it('derives names from fullName when given/family aren’t supplied', async () => {
    const provider = await makeSamlProvider({ autoProvision: true });
    const profile: CanonicalProfile = {
      externalId: 'ext-fullname',
      email: 't+fullname@example.com',
      fullName: 'Maya Levy',
      raw: {},
    };

    const out = await autoProvisionFromProfile(provider, profile);
    expect(out.user.firstName).toBe('Maya');
    expect(out.user.lastName).toBe('Levy');
  });

  it('records SSO provider in the link’s claims for audit', async () => {
    const provider = await makeSamlProvider({ autoProvision: true });
    const profile = makeProfile({
      email: 't+claims@example.com',
      raw: { teudat_zehut: '123456789', school_id: 'SCHOOL-42' },
    });

    const out = await autoProvisionFromProfile(provider, profile);

    const [link] = await db
      .select()
      .from(userExternalIdentities)
      .where(eq(userExternalIdentities.userId, out.user.id));
    expect((link.claims as any).teudat_zehut).toBe('123456789');
    expect((link.claims as any).school_id).toBe('SCHOOL-42');
  });
});
