/**
 * Integration tests for the LMN auto-generator:
 *  - utterance metrics (MLU, NDW, comm rate) over a real seeded window
 *  - createLmnDraft pulls student + medical record + goals into sections
 *  - update / finalize transitions
 *
 * Uses the real Postgres test DB (server/tests/global-setup.ts).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import {
  makeUser,
  makeInstitute,
  makeStudent,
  enrollStudent,
} from '../helpers/factories.js';
import { db } from '../../db.js';
import {
  aacUtteranceEvents,
  chatSessions,
  medicalRecords,
  programs,
  goals,
  lettersOfMedicalNecessity,
} from '@shared/schema';
import { eq } from 'drizzle-orm';
import {
  getUtteranceMetrics,
  tokenizeUtterance,
} from '../../services/insurance/utteranceMetricsService.js';
import {
  createLmnDraft,
  updateLmnSections,
  finalizeLmn,
  type LmnSections,
} from '../../services/insurance/lmnService.js';

async function seedUtterance(opts: {
  studentId: string;
  text: string;
  recordedAt: Date;
}) {
  const tokens = tokenizeUtterance(opts.text);
  await db.insert(aacUtteranceEvents).values({
    studentId: opts.studentId,
    chatSessionId: null,
    text: opts.text,
    wordCount: tokens.length,
    uniqueWordCount: new Set(tokens).size,
    source: 'board_press',
    recordedAt: opts.recordedAt,
  } as any);
}

describe('tokenizeUtterance', () => {
  it('extracts lowercase Latin words and drops punctuation', () => {
    expect(tokenizeUtterance("Hello, world!")).toEqual(['hello', 'world']);
  });

  it('handles Hebrew tokens', () => {
    const out = tokenizeUtterance('שלום עולם');
    expect(out).toEqual(['שלום', 'עולם']);
  });

  it('drops punctuation-only tokens', () => {
    expect(tokenizeUtterance("--- ??? !!!")).toEqual([]);
  });
});

describe('getUtteranceMetrics', () => {
  afterEach(truncateAll);

  it('computes MLU, NDW, and counts over the window', async () => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);

    const now = new Date('2026-05-20T12:00:00Z');
    await seedUtterance({
      studentId: student.id,
      text: 'I want juice',
      recordedAt: new Date('2026-05-19T10:00:00Z'),
    });
    await seedUtterance({
      studentId: student.id,
      text: 'I want milk',
      recordedAt: new Date('2026-05-19T10:05:00Z'),
    });
    await seedUtterance({
      studentId: student.id,
      text: 'more juice please',
      recordedAt: new Date('2026-05-19T10:10:00Z'),
    });

    const metrics = await getUtteranceMetrics({
      studentId: student.id,
      windowDays: 30,
      endAt: now,
    });

    expect(metrics.utteranceCount).toBe(3);
    expect(metrics.totalWords).toBe(9); // 3+3+3
    expect(metrics.mlu).toBe(3); // 9/3
    // Unique tokens: i, want, juice, milk, more, please → 6
    expect(metrics.ndw).toBe(6);
  });

  it('zeros all metrics when no utterances exist', async () => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);
    const metrics = await getUtteranceMetrics({ studentId: student.id });
    expect(metrics.utteranceCount).toBe(0);
    expect(metrics.mlu).toBe(0);
    expect(metrics.ndw).toBe(0);
    expect(metrics.communicationRatePerMin).toBe(0);
  });

  it('subtracts billable AAC sessions from active time and computes rate', async () => {
    const owner = await makeUser();
    const { student } = await makeStudent(owner.id);

    const now = new Date('2026-05-20T12:00:00Z');
    // 600s billable session
    await db.insert(chatSessions).values({
      userId: owner.id,
      studentId: student.id,
      chatMode: 'aac',
      state: {},
      log: [{ role: 'user' }, { role: 'assistant' }],
      creditsUsed: 0.1,
      started: new Date('2026-05-19T10:00:00Z'),
      lastUpdate: new Date('2026-05-19T10:10:00Z'),
    } as any);
    await seedUtterance({
      studentId: student.id,
      text: 'one two three',
      recordedAt: new Date('2026-05-19T10:05:00Z'),
    });

    const metrics = await getUtteranceMetrics({
      studentId: student.id,
      windowDays: 30,
      endAt: now,
    });
    expect(metrics.totalActiveSeconds).toBe(600);
    // 1 utterance / 10 minutes = 0.1
    expect(metrics.communicationRatePerMin).toBe(0.1);
  });
});

describe('LMN lifecycle', () => {
  afterEach(truncateAll);

  it('createLmnDraft snapshots student, diagnosis, goals, and metrics', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const { student } = await makeStudent(owner.id, {
      firstName: 'Avery',
      lastName: 'Test',
    });
    await enrollStudent(institute.id, student.id, owner.id);

    await db.insert(medicalRecords).values({
      studentId: student.id,
      userId: owner.id,
      instituteId: institute.id,
      primaryDiagnosis: 'Mixed receptive-expressive language disorder',
      primaryDiagnosisCode: 'F80.2',
      coMorbidities: ['Epilepsy'],
      secondaryDiagnoses: [],
    } as any);

    const [program] = await db
      .insert(programs)
      .values({
        studentId: student.id,
        instituteId: institute.id,
        framework: 'us_iep',
        title: 'IEP 2026',
      } as any)
      .returning();
    await db.insert(goals).values({
      programId: program.id,
      goalStatement: 'Use 2-word combinations to request',
      relevance: 'Functional communication for daily needs',
    } as any);

    await seedUtterance({
      studentId: student.id,
      text: 'want juice',
      recordedAt: new Date(),
    });

    const lmn = await createLmnDraft({
      studentId: student.id,
      instituteId: institute.id,
      userId: owner.id,
    });
    const sections = lmn.sections as unknown as LmnSections;

    expect(lmn.status).toBe('draft');
    expect(sections.patientId.name).toBe('Avery Test');
    expect(sections.diagnosis.primary).toBe('Mixed receptive-expressive language disorder');
    expect(sections.diagnosis.primaryCode).toBe('F80.2');
    expect(sections.diagnosis.coMorbidities).toEqual(['Epilepsy']);
    expect(sections.metrics.utteranceCount).toBe(1);
    expect(sections.goalsList).toHaveLength(1);
    expect(sections.goalsList[0].title).toBe('Use 2-word combinations to request');
    // Auto-generated narratives are populated.
    expect(sections.severityNarrative.length).toBeGreaterThan(20);
    expect(sections.ruleOutNarrative.length).toBeGreaterThan(20);
    expect(sections.attestationNarrative.length).toBeGreaterThan(20);

    // metricsSnapshot column mirrors sections.metrics
    expect(lmn.metricsSnapshot).toMatchObject({
      utteranceCount: 1,
      mlu: sections.metrics.mlu,
    });
  });

  it('updateLmnSections edits the draft', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const { student } = await makeStudent(owner.id);
    await enrollStudent(institute.id, student.id, owner.id);

    const lmn = await createLmnDraft({
      studentId: student.id,
      instituteId: institute.id,
      userId: owner.id,
    });
    const original = lmn.sections as unknown as LmnSections;
    const updatedSections: LmnSections = {
      ...original,
      severityNarrative: 'Custom severity narrative.',
    };

    const updated = await updateLmnSections(lmn.id, updatedSections);
    const updatedRead = updated.sections as unknown as LmnSections;
    expect(updatedRead.severityNarrative).toBe('Custom severity narrative.');
  });

  it('finalizeLmn locks the row and stamps signature fields', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const { student } = await makeStudent(owner.id);
    await enrollStudent(institute.id, student.id, owner.id);

    const lmn = await createLmnDraft({
      studentId: student.id,
      instituteId: institute.id,
      userId: owner.id,
    });
    const finalized = await finalizeLmn(lmn.id, {
      signatureName: 'Jane Doe',
      signatureCredentials: 'M.A. CCC-SLP',
      signatureLicense: 'SLP-12345',
    });
    expect(finalized.status).toBe('finalized');
    expect(finalized.finalizedAt).not.toBeNull();
    expect(finalized.signatureName).toBe('Jane Doe');
    expect(finalized.signatureLicense).toBe('SLP-12345');
  });

  it('updateLmnSections rejects edits on a finalized LMN', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const { student } = await makeStudent(owner.id);
    await enrollStudent(institute.id, student.id, owner.id);

    const lmn = await createLmnDraft({
      studentId: student.id,
      instituteId: institute.id,
      userId: owner.id,
    });
    await finalizeLmn(lmn.id, {
      signatureName: 'Jane',
      signatureCredentials: null,
      signatureLicense: null,
    });
    const sections = lmn.sections as unknown as LmnSections;
    await expect(updateLmnSections(lmn.id, sections)).rejects.toThrow(/finalized/i);
  });

  it('finalizeLmn is idempotent — second call returns the existing finalized row', async () => {
    const owner = await makeUser();
    const { institute } = await makeInstitute(owner.id, { type: 'clinic' });
    const { student } = await makeStudent(owner.id);
    await enrollStudent(institute.id, student.id, owner.id);

    const lmn = await createLmnDraft({
      studentId: student.id,
      instituteId: institute.id,
      userId: owner.id,
    });
    const first = await finalizeLmn(lmn.id, {
      signatureName: 'Jane',
      signatureCredentials: null,
      signatureLicense: null,
    });
    const second = await finalizeLmn(lmn.id, {
      signatureName: 'Different',
      signatureCredentials: null,
      signatureLicense: null,
    });
    // Idempotent: signature stays as the original.
    expect(second.signatureName).toBe('Jane');
    expect(second.finalizedAt?.getTime()).toBe(first.finalizedAt?.getTime());

    // And the row in the DB matches what we got back.
    const [row] = await db
      .select()
      .from(lettersOfMedicalNecessity)
      .where(eq(lettersOfMedicalNecessity.id, lmn.id));
    expect(row.signatureName).toBe('Jane');
  });
});
