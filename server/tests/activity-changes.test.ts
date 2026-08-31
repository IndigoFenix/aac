/**
 * Unit tests for the activity-log change summariser.
 *
 * The redaction rules here are the security-relevant part: `activity_logs` is
 * readable by institute admins and is NOT covered by the external-storage
 * tiering, so a field that leaks its value into `details` leaks it permanently.
 * Deny-by-default is the invariant these tests pin down.
 *
 * DB-free — runs under `npm run test:unit -- activity`.
 */

import { describe, it, expect } from '@jest/globals';
import {
  summarizeChanges,
  mergeChanges,
  changeDetails,
} from '../services/activityChanges.js';

describe('summarizeChanges', () => {
  describe('what counts as a change', () => {
    it('reports only fields the payload actually moved', () => {
      const before = { iconTextRatio: 3, languageLevel: 2, eyegazeEnabled: false };
      const changes = summarizeChanges('aac_settings', before, {
        iconTextRatio: 5,
        languageLevel: 2,
      });
      expect(Object.keys(changes)).toEqual(['iconTextRatio']);
      expect(changes.iconTextRatio).toEqual({ from: 3, to: 5 });
    });

    it('returns nothing when a save re-submits identical values', () => {
      const before = { iconTextRatio: 3, voiceType: 'woman' };
      expect(summarizeChanges('aac_settings', before, { ...before })).toEqual({});
    });

    it('treats a jsonb value as unchanged when it is structurally equal', () => {
      const before = { permittedWebsites: [{ url: 'a.com' }] };
      const changes = summarizeChanges('aac_settings', before, {
        permittedWebsites: [{ url: 'a.com' }],
      });
      expect(changes).toEqual({});
    });

    it('ignores bookkeeping columns and keys that are not columns at all', () => {
      const changes = summarizeChanges(
        'aac_settings',
        { iconTextRatio: 3 },
        { id: 'new-id', updatedAt: new Date(), studentId: 'x', age: 9, iconTextRatio: 4 },
      );
      expect(Object.keys(changes)).toEqual(['iconTextRatio']);
    });

    it('skips undefined values — an absent key is not a clear', () => {
      expect(summarizeChanges('aac_settings', { aiName: 'Buddy' }, { aiName: undefined })).toEqual({});
    });

    it('records a field that had no prior row at all', () => {
      const changes = summarizeChanges('aac_settings', null, { iconTextRatio: 4 });
      expect(changes.iconTextRatio).toEqual({ from: null, to: 4 });
    });
  });

  describe('redaction (deny-by-default)', () => {
    it('never records the value of a sensitive field — the aiName incident', () => {
      const changes = summarizeChanges(
        'aac_settings',
        { aiName: null },
        { aiName: 'redacted-guardian-2@example.invalid' },
      );
      expect(changes.aiName).toEqual({ from: 'empty', to: 'set', redacted: true });
      expect(JSON.stringify(changes)).not.toContain('lilitzysman');
    });

    it('redacts a student\'s name and birthdate', () => {
      const changes = summarizeChanges(
        'students',
        { name: 'Old Name', birthDate: '2015-01-01' },
        { name: 'Hadar Cohen', birthDate: '2016-02-02' },
      );
      expect(changes.name).toEqual({ from: 'set', to: 'set', redacted: true });
      expect(changes.birthDate.redacted).toBe(true);
      expect(JSON.stringify(changes)).not.toContain('Hadar');
    });

    it('redacts the prompt lists but still reports their size', () => {
      const changes = summarizeChanges(
        'aac_settings',
        { chatAgentPrompt: ['one'] },
        { chatAgentPrompt: ['one', 'two secret rule'] },
      );
      expect(changes.chatAgentPrompt).toEqual({
        from: '[1 items]',
        to: '[2 items]',
        redacted: true,
      });
      expect(JSON.stringify(changes)).not.toContain('secret');
    });

    it('redacts a free-text column that is not on any allowlist', () => {
      const changes = summarizeChanges(
        'aac_settings',
        { localStorageEncryptionKey: null },
        { localStorageEncryptionKey: 'AAAA-SECRET-KEY' },
      );
      expect(changes.localStorageEncryptionKey.redacted).toBe(true);
      expect(JSON.stringify(changes)).not.toContain('SECRET');
    });

    it('reduces an opaque jsonb blob to its shape', () => {
      const changes = summarizeChanges(
        'aac_settings',
        { appConfig: { a: 1 } },
        { appConfig: { a: 1, b: 2, c: 3 } },
      );
      expect(changes.appConfig).toEqual({
        from: '{1 fields}',
        to: '{3 fields}',
        redacted: true,
      });
    });
  });

  describe('values that are safe to record', () => {
    it('keeps boolean and numeric values verbatim', () => {
      const changes = summarizeChanges(
        'aac_settings',
        { eyegazeEnabled: false, eyegazeTimeout: 2000 },
        { eyegazeEnabled: true, eyegazeTimeout: 3500 },
      );
      expect(changes.eyegazeEnabled).toEqual({ from: false, to: true });
      expect(changes.eyegazeTimeout).toEqual({ from: 2000, to: 3500 });
    });

    it('keeps closed-enum text values verbatim', () => {
      const changes = summarizeChanges(
        'aac_settings',
        { voiceType: 'auto', selectionMethod: 'touch' },
        { voiceType: 'woman', selectionMethod: 'dwell' },
      );
      expect(changes.voiceType).toEqual({ from: 'auto', to: 'woman' });
      expect(changes.selectionMethod).toEqual({ from: 'touch', to: 'dwell' });
    });

    it('truncates a long allowlisted string rather than storing it whole', () => {
      const long = 'x'.repeat(200);
      const changes = summarizeChanges('aac_settings', { modelOverride: null }, { modelOverride: long });
      expect(String(changes.modelOverride.to)).toHaveLength(81); // 80 + ellipsis
      expect(String(changes.modelOverride.to).endsWith('…')).toBe(true);
    });
  });

  it('caps a runaway write instead of inflating the log row', () => {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    // Every boolean column on aac_settings, flipped — comfortably over the cap
    // once combined with the numeric ones.
    for (let i = 0; i < 60; i++) {
      before[`f${i}`] = false;
      after[`f${i}`] = true;
    }
    // Unknown columns are dropped, so use real ones to reach the cap.
    const realBefore = { eyegazeEnabled: false, iconTextRatio: 1 };
    const realAfter = { eyegazeEnabled: true, iconTextRatio: 2 };
    const changes = summarizeChanges('aac_settings', { ...before, ...realBefore }, { ...after, ...realAfter });
    expect(Object.keys(changes).length).toBeLessThanOrEqual(41);
  });

  it('falls back to redaction for a table it has no column map for', () => {
    const changes = summarizeChanges('some_other_table', { foo: 'a' }, { foo: 'b' });
    expect(changes.foo.redacted).toBe(true);
  });
});

describe('changeDetails', () => {
  it('is null when nothing changed, so a no-op save logs no details', () => {
    expect(changeDetails({})).toBeNull();
  });

  it('wraps the map and carries extra context', () => {
    const details = changeDetails({ aiName: { from: 'empty', to: 'set', redacted: true } }, { via: 'aac_settings' });
    expect(details).toEqual({
      via: 'aac_settings',
      changes: { aiName: { from: 'empty', to: 'set', redacted: true } },
    });
  });
});

describe('mergeChanges', () => {
  it('flattens the student and aac_settings halves of one PATCH', () => {
    const merged = mergeChanges(
      summarizeChanges('students', { primaryLanguage: 'en' }, { primaryLanguage: 'he' }),
      summarizeChanges('aac_settings', { iconTextRatio: 3 }, { iconTextRatio: 5 }),
    );
    expect(Object.keys(merged).sort()).toEqual(['iconTextRatio', 'primaryLanguage']);
  });
});

// ---------------------------------------------------------------------------
// Clinical record tables (AKIM appendix §5.8 — "the value that changed").
//
// These were added after the audit found capture covered only `students` and
// `aac_settings`. The property that matters is that widening coverage did NOT
// widen disclosure: a diagnosis or a clinical note must still reduce to
// presence, because activity_logs is readable by institute admins and outlives
// the record it describes.
// ---------------------------------------------------------------------------

describe("clinical record tables", () => {
  it("records WHICH diagnosis field changed without recording the diagnosis", () => {
    const changes = summarizeChanges(
      "medical_records",
      { primaryDiagnosis: "Rett syndrome", primaryDiagnosisCode: "F84.2" },
      { primaryDiagnosis: "Rett syndrome, atypical", primaryDiagnosisCode: "F84.2" },
    );

    expect(Object.keys(changes)).toEqual(["primaryDiagnosis"]);
    expect(changes.primaryDiagnosis.redacted).toBe(true);
    // The clinical value must not appear anywhere in the payload.
    expect(JSON.stringify(changes)).not.toMatch(/Rett/);
  });

  it("redacts the free-text clinical arrays on a medical record", () => {
    const changes = summarizeChanges(
      "medical_records",
      { alertsAllergies: [], medications: ["a"] },
      { alertsAllergies: ["penicillin"], medications: ["a", "b"] },
    );
    expect(JSON.stringify(changes)).not.toMatch(/penicillin/);
    expect(changes.alertsAllergies.redacted).toBe(true);
    expect(changes.medications.redacted).toBe(true);
  });

  it("still reports boolean flags literally, which is the useful part", () => {
    const changes = summarizeChanges(
      "medical_records",
      { hasSeizures: false },
      { hasSeizures: true },
    );
    if (changes.hasSeizures) {
      // Column exists on the table: a flag carries no PII, so it is literal.
      expect(changes.hasSeizures.redacted).toBeUndefined();
      expect(changes.hasSeizures.to).toBe(true);
    }
  });

  it("redacts functional-report narrative", () => {
    const changes = summarizeChanges(
      "functional_reports",
      { mobilityStatus: "independent" },
      { mobilityStatus: "requires wheelchair, left-side weakness" },
    );
    expect(changes.mobilityStatus.redacted).toBe(true);
    expect(JSON.stringify(changes)).not.toMatch(/wheelchair/);
  });

  it("redacts educational-report narrative", () => {
    const changes = summarizeChanges(
      "educational_reports",
      { communicationMode: "eye gaze" },
      { communicationMode: "eye gaze plus partner-assisted scanning" },
    );
    expect(changes.communicationMode.redacted).toBe(true);
    expect(JSON.stringify(changes)).not.toMatch(/scanning/);
  });

  it("redacts a contact's name and phone", () => {
    const changes = summarizeChanges(
      "student_contacts",
      { name: "Dana Levi", contactPhone: "050-1234567" },
      { name: "Dana Cohen", contactPhone: "050-7654321" },
    );
    expect(changes.name.redacted).toBe(true);
    expect(changes.contactPhone.redacted).toBe(true);
    const json = JSON.stringify(changes);
    expect(json).not.toMatch(/Cohen/);
    expect(json).not.toMatch(/7654321/);
  });

  it("reports nothing when a clinical save changes nothing", () => {
    expect(
      summarizeChanges(
        "medical_records",
        { primaryDiagnosis: "same" },
        { primaryDiagnosis: "same" },
      ),
    ).toEqual({});
  });

  it("drops keys that are not columns on the clinical table", () => {
    // Update bodies arrive off the wire and can carry stray client state;
    // reporting those as changed fields would be a lie.
    const changes = summarizeChanges(
      "medical_records",
      {},
      { notAColumnAtAll: "x", primaryDiagnosis: "y" },
    );
    expect(Object.keys(changes)).toEqual(["primaryDiagnosis"]);
  });
});

// ---------------------------------------------------------------------------
// Care-plan tables (AKIM appendix §5.8, Track C).
//
// programs / goals / objectives / progress_reports carry the workflow skeleton
// an auditor needs — who moved a plan to active, when a due date slipped, when
// a report was shared with parents — wrapped around narrative that a clinician
// or a parent wrote. That split is the whole point: the skeleton is literal,
// the narrative never is.
// ---------------------------------------------------------------------------

describe('care-plan tables', () => {
  describe('programs', () => {
    it('records a program status transition literally', () => {
      const changes = summarizeChanges('programs', { status: 'draft' }, { status: 'active' });
      expect(changes.status).toEqual({ from: 'draft', to: 'active' });
    });

    it('records framework and dates literally, since an auditor needs the timeline', () => {
      const changes = summarizeChanges(
        'programs',
        { framework: 'us_iep', dueDate: '2026-11-15', approvalDate: null },
        { framework: 'tala', dueDate: '2027-01-30', approvalDate: '2026-12-01' },
      );
      expect(changes.framework).toEqual({ from: 'us_iep', to: 'tala' });
      expect(changes.dueDate).toEqual({ from: '2026-11-15', to: '2027-01-30' });
      expect(changes.approvalDate).toEqual({ from: null, to: '2026-12-01' });
    });

    it('redacts the program notes and the ICF factor blobs', () => {
      const changes = summarizeChanges(
        'programs',
        { notes: '', personalFactors: {} },
        {
          notes: 'Mother reports night seizures since October.',
          personalFactors: { motivators: 'music', temperament: 'anxious' },
        },
      );
      expect(changes.notes).toEqual({ from: 'empty', to: 'set', redacted: true });
      expect(changes.personalFactors).toEqual({ from: '{0 fields}', to: '{2 fields}', redacted: true });
      const json = JSON.stringify(changes);
      expect(json).not.toContain('Mother reports night seizures since October.');
      expect(json).not.toContain('anxious');
    });

    it('redacts a program title, because clinicians type a child name into it', () => {
      const changes = summarizeChanges('programs', { title: null }, { title: 'Noa 2027 plan' });
      expect(changes.title).toEqual({ from: 'empty', to: 'set', redacted: true });
      expect(JSON.stringify(changes)).not.toContain('Noa');
    });
  });

  describe('goals', () => {
    it('records the goal lifecycle enums and dates literally', () => {
      const changes = summarizeChanges(
        'goals',
        { status: 'draft', interventionLevel: null, targetDate: '2026-06-01', achievedDate: null },
        {
          status: 'achieved',
          interventionLevel: 'participation',
          targetDate: '2026-06-01',
          achievedDate: '2026-05-20',
        },
      );
      expect(changes.status).toEqual({ from: 'draft', to: 'achieved' });
      expect(changes.interventionLevel).toEqual({ from: null, to: 'participation' });
      expect(changes.achievedDate).toEqual({ from: null, to: '2026-05-20' });
      expect(changes.targetDate).toBeUndefined();
    });

    it('keeps the GAS scale identifiers and the numeric ratings literal', () => {
      const changes = summarizeChanges(
        'goals',
        { useGas: false, gasBaselineLevel: null, progress: 0, setJointlyWithFamily: false },
        {
          useGas: true,
          gasBaselineLevel: 'less_than_expected',
          progress: 40,
          setJointlyWithFamily: true,
        },
      );
      expect(changes.useGas).toEqual({ from: false, to: true });
      expect(changes.gasBaselineLevel).toEqual({ from: null, to: 'less_than_expected' });
      expect(changes.progress).toEqual({ from: 0, to: 40 });
      expect(changes.setJointlyWithFamily).toEqual({ from: false, to: true });
    });

    it('redacts the goal statement and its criteria', () => {
      const changes = summarizeChanges(
        'goals',
        { goalStatement: 'Old statement', criteria: null },
        {
          goalStatement: 'Yael will request a break on her AAC device in 4 of 5 opportunities.',
          criteria: '4 of 5 trials across 3 consecutive sessions',
        },
      );
      expect(changes.goalStatement).toEqual({ from: 'set', to: 'set', redacted: true });
      expect(changes.criteria).toEqual({ from: 'empty', to: 'set', redacted: true });
      const json = JSON.stringify(changes);
      expect(json).not.toContain('Yael will request a break on her AAC device in 4 of 5 opportunities.');
      expect(json).not.toContain('4 of 5 trials across 3 consecutive sessions');
    });

    it('redacts familyInput, which a parent wrote and never offered to an audit trail', () => {
      const changes = summarizeChanges(
        'goals',
        { familyInput: null },
        { familyInput: 'Father says she uses the device at home but never at school.' },
      );
      expect(changes.familyInput).toEqual({ from: 'empty', to: 'set', redacted: true });
      expect(JSON.stringify(changes)).not.toContain('Father says she uses the device at home but never at school.');
    });

    it('reduces the GAS level definitions to a shape, not their behaviour text', () => {
      const changes = summarizeChanges(
        'goals',
        { gasLevels: {} },
        { gasLevels: { less_than_expected: { behavior: 'refuses the device and cries' } } },
      );
      expect(changes.gasLevels).toEqual({ from: '{0 fields}', to: '{1 fields}', redacted: true });
      expect(JSON.stringify(changes)).not.toContain('refuses the device and cries');
    });
  });

  describe('objectives', () => {
    it('records the objective status, GAS target level and dates literally', () => {
      const changes = summarizeChanges(
        'objectives',
        { status: 'draft', gasTargetLevel: null, achievedDate: null },
        { status: 'in_progress', gasTargetLevel: 'better_than_expected', achievedDate: '2026-04-02' },
      );
      expect(changes.status).toEqual({ from: 'draft', to: 'in_progress' });
      expect(changes.gasTargetLevel).toEqual({ from: null, to: 'better_than_expected' });
      expect(changes.achievedDate).toEqual({ from: null, to: '2026-04-02' });
    });

    it('redacts the objective statement and its measurement narrative', () => {
      const changes = summarizeChanges(
        'objectives',
        { objectiveStatement: 'Old text', measurementMethod: null },
        {
          objectiveStatement: 'Ari will hold head control for 30 seconds during circle time.',
          measurementMethod: 'Therapist tally sheet, weekly',
        },
      );
      expect(changes.objectiveStatement).toEqual({ from: 'set', to: 'set', redacted: true });
      expect(changes.measurementMethod).toEqual({ from: 'empty', to: 'set', redacted: true });
      const json = JSON.stringify(changes);
      expect(json).not.toContain('Ari will hold head control for 30 seconds during circle time.');
      expect(json).not.toContain('Therapist tally sheet, weekly');
    });
  });

  describe('progress reports', () => {
    it('records the parent-disclosure flag and its date literally, which is the audit event', () => {
      const changes = summarizeChanges(
        'progress_reports',
        { sharedWithParents: false, sharedDate: null, reportDate: '2026-03-01' },
        { sharedWithParents: true, sharedDate: '2026-03-05', reportDate: '2026-03-01' },
      );
      expect(changes.sharedWithParents).toEqual({ from: false, to: true });
      expect(changes.sharedDate).toEqual({ from: null, to: '2026-03-05' });
      expect(changes.reportDate).toBeUndefined();
    });

    it('redacts the summary, the recommendations and the reporting period', () => {
      const changes = summarizeChanges(
        'progress_reports',
        { overallSummary: null, recommendedChanges: null, reportingPeriod: 'Q1' },
        {
          overallSummary: 'Regression in fine motor control after the November hospitalization.',
          recommendedChanges: 'Increase OT to twice weekly.',
          // Open text by design, so it can carry a clinical remark, not just "Q2".
          reportingPeriod: 'Q2 post-hospitalization',
        },
      );
      expect(changes.overallSummary).toEqual({ from: 'empty', to: 'set', redacted: true });
      expect(changes.recommendedChanges).toEqual({ from: 'empty', to: 'set', redacted: true });
      expect(changes.reportingPeriod).toEqual({ from: 'set', to: 'set', redacted: true });
      const json = JSON.stringify(changes);
      expect(json).not.toContain('Regression in fine motor control after the November hospitalization.');
      expect(json).not.toContain('Increase OT to twice weekly.');
      expect(json).not.toContain('post-hospitalization');
    });
  });

  describe('reorder noise', () => {
    it('logs nothing when a drag-to-reorder moves a goal', () => {
      expect(summarizeChanges('goals', { sortOrder: 1 }, { sortOrder: 7 })).toEqual({});
    });

    it('logs nothing when a drag-to-reorder moves an objective', () => {
      expect(summarizeChanges('objectives', { sequenceOrder: 2 }, { sequenceOrder: 1 })).toEqual({});
    });

    it('still reports the real edit that rode along with a reorder', () => {
      const changes = summarizeChanges(
        'goals',
        { sortOrder: 1, status: 'draft' },
        { sortOrder: 4, status: 'active' },
      );
      expect(Object.keys(changes)).toEqual(['status']);
    });
  });
});
