/**
 * Shape of the `sections` jsonb column on lettersOfMedicalNecessity.
 * Used by both the server (lmnService) and the client (template renderers
 * + edit UI). Source-of-truth for what an LMN draft contains.
 */

export interface LmnUtteranceMetricsSnapshot {
  windowStart: string;
  windowEnd: string;
  utteranceCount: number;
  totalWords: number;
  mlu: number;
  ndw: number;
  totalActiveSeconds: number;
  communicationRatePerMin: number;
}

export interface LmnSections {
  patientId: {
    name: string | null;
    birthDate: string | null;
    idNumber: string | null;
    institute: string | null;
  };
  diagnosis: {
    primary: string | null;
    primaryCode: string | null;
    coMorbidities: string[];
    secondary: string[];
  };
  metrics: LmnUtteranceMetricsSnapshot;
  goalsList: Array<{ title: string; description: string | null }>;
  /** Auto-prefilled severity statement; clinician edits before signing. */
  severityNarrative: string;
  /** Why natural communication modes are insufficient. Clinician fills. */
  ruleOutNarrative: string;
  /** Why this device is medically appropriate. Clinician fills. */
  rationaleNarrative: string;
  /** Goals/expected outcomes prose — prefilled from `goalsList`. */
  goalsNarrative: string;
  /** Boilerplate clinician attestation paragraph. Editable. */
  attestationNarrative: string;
}
