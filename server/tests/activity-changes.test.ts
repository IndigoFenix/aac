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
