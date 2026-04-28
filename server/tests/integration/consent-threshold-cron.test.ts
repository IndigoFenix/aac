/**
 * Tests for the daily minor-threshold-check cron.
 *
 * Verifies:
 *   - Students who have aged out of their regime get a single
 *     `minor_threshold_crossed` activity event.
 *   - Students still inside the regime are not flagged.
 *   - Subsequent runs don't double-fire — the de-dup check via the
 *     activity log prevents repeats.
 *   - Revoked consent records are ignored.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { eq, and } from 'drizzle-orm';

import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeStudent } from '../helpers/factories.js';
import { studentRepository } from '../../repositories/studentRepository.js';
import { studentContacts, studentConsentRecords, activityLogs } from '@shared/schema';
import { runMinorThresholdCheck } from '../../services/consent/consentThresholdCron.js';

/**
 * Inserts a consent record directly. We bypass the signConsent flow because
 * it gates on current age (regime is computed from current age + country).
 * For the cron we need: regime='il_general' frozen on the record + a current
 * age that has crossed the threshold. That's a state the production flow
 * naturally produces over time, but tests can't fast-forward time.
 */
async function setupAgedOutStudent(opts: {
  currentAgeYears: number;
  ageAtSigningYears: number;
  regime: 'il_general' | 'us_coppa' | 'eu_gdpr_minor' | 'uk_ico_under13' | 'gdpr_superset_default';
  country: string;
  revoked?: boolean;
}) {
  const owner = await makeUser();
  const { student } = await makeStudent(owner.id, { country: opts.country });
  const birth = new Date();
  birth.setFullYear(birth.getFullYear() - opts.currentAgeYears);
  await studentRepository.updateStudent(student.id, {
    birthDate: birth.toISOString().split('T')[0],
    country: opts.country,
  } as any);
  const [contact] = await db.insert(studentContacts).values({
    studentId: student.id,
    name: 'Parent',
    relationship: 'parent_guardian',
    role: 'parent_guardian',
    linkedUserId: owner.id,
    isLegalGuardian: true,
  }).returning();
  const [consent] = await db.insert(studentConsentRecords).values({
    studentId: student.id,
    signedByContactId: contact.id,
    country: opts.country,
    ageAtSigningYears: opts.ageAtSigningYears,
    isMinorEnhancedProtection: true,
    enhancedProtectionRegime: opts.regime,
    consentTextVersion: 'IL.2026.04',
    consentTextHash: 'a'.repeat(64),
    thirdPartyRecipients: [],
    purposeAcknowledged: true,
    voluntarinessAcknowledged: true,
    thirdPartyTransfersAcknowledged: true,
    optInModelTraining: false,
    optInAdvertising: false,
    optInThirdPartyResearch: false,
    optInMarketingComms: false,
    optInsForcedOff: false,
    identityVerificationMethod: 'in_person_clinician_attested',
    identityVerificationEvidence: {},
    nonRepudiationMethod: 'in_person_clinician_attested',
    nonRepudiationEvidence: {},
    revokedAt: opts.revoked ? new Date() : null,
    revokedByUserId: opts.revoked ? owner.id : null,
  } as any).returning();
  return { owner, student, contact, consent };
}

describe('minor-threshold cron', () => {
  afterEach(truncateAll);

  it('flags a US student who has crossed COPPA threshold (13)', async () => {
    const { consent } = await setupAgedOutStudent({
      currentAgeYears: 14,
      ageAtSigningYears: 11,
      regime: 'us_coppa',
      country: 'US',
    });

    const result = await runMinorThresholdCheck();
    expect(result.flagged).toBe(1);

    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.eventType, 'minor_threshold_crossed'),
          eq(activityLogs.subjectId1, consent.id),
        ),
      );
    expect(logs.length).toBe(1);
    expect((logs[0].details as any).priorRegime).toBe('us_coppa');
    expect((logs[0].details as any).threshold).toBe(13);
    expect((logs[0].details as any).currentAge).toBeGreaterThanOrEqual(13);
  });

  it('does not flag a student still inside the regime', async () => {
    await setupAgedOutStudent({
      currentAgeYears: 8,
      ageAtSigningYears: 7,
      regime: 'us_coppa',
      country: 'US',
    });
    const result = await runMinorThresholdCheck();
    expect(result.flagged).toBe(0);
  });

  it('is idempotent — second run does not re-flag', async () => {
    const { consent } = await setupAgedOutStudent({
      currentAgeYears: 14,
      ageAtSigningYears: 11,
      regime: 'us_coppa',
      country: 'US',
    });
    const r1 = await runMinorThresholdCheck();
    expect(r1.flagged).toBe(1);
    const r2 = await runMinorThresholdCheck();
    expect(r2.flagged).toBe(0);

    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.eventType, 'minor_threshold_crossed'),
          eq(activityLogs.subjectId1, consent.id),
        ),
      );
    expect(logs.length).toBe(1);
  });

  it('ignores revoked consent records', async () => {
    await setupAgedOutStudent({
      currentAgeYears: 14,
      ageAtSigningYears: 11,
      regime: 'us_coppa',
      country: 'US',
      revoked: true,
    });
    const result = await runMinorThresholdCheck();
    expect(result.flagged).toBe(0);
  });

  it('flags an EU GDPR-minor student crossing 16', async () => {
    const { consent } = await setupAgedOutStudent({
      currentAgeYears: 17,
      ageAtSigningYears: 14,
      regime: 'eu_gdpr_minor',
      country: 'DE',
    });
    const result = await runMinorThresholdCheck();
    expect(result.flagged).toBe(1);
    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.eventType, 'minor_threshold_crossed'),
          eq(activityLogs.subjectId1, consent.id),
        ),
      );
    expect((logs[0].details as any).priorRegime).toBe('eu_gdpr_minor');
    expect((logs[0].details as any).threshold).toBe(16);
  });
});
