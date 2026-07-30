/**
 * External Storage System — Sensitive Field & Ownership Registries
 *
 * SENSITIVE_FIELDS: Maps table name (snake_case) → tier config with camelCase field names.
 * OWNERSHIP_MAP: Maps table name → function that resolves the owning entity from a record.
 */

import type { EntityRef, TableTierConfig } from "./types";

// =============================================================================
// SENSITIVE FIELDS REGISTRY
// =============================================================================

/**
 * Maps DB table name (snake_case) to its sensitive field tiers.
 * Field names are in camelCase (matching Drizzle select output).
 */
export const SENSITIVE_FIELDS: Record<string, TableTierConfig> = {
  users: {
    core: ["email", "firstName", "lastName", "fullName", "password", "mfaSecret", "profileImageUrl"],
    log: ["chatMemory"],
    // Biometric fields moved to the shared biometric_data table.
  },
  students: {
    core: ["firstName", "lastName", "name", "birthDate", "gender"],
    log: ["chatMemory"],
  },
  student_contacts: {
    core: ["name", "relationship", "contactEmail", "contactPhone"],
    log: ["organization", "contextNotes"],
  },
  aac_settings: {
    core: ["aiName"],
    log: ["elevenlabsApiKey", "chatAgentPrompt", "autoAacPrompt", "knownPeople"],
  },
  // Cached session-plan sections — derived from chatMemory + the AAC prompts
  // (both log-tier above), so the cache follows the same tier.
  aac_session_plans: {
    log: ["identity", "situations", "goals"],
  },
  user_students: {
    log: ["chatMemory"],
  },
  medical_records: {
    core: ["primaryDiagnosis", "primaryDiagnosisCode", "birthDate"],
    log: ["secondaryDiagnoses", "coMorbidities", "alertsAllergies", "alertsSeizures", "alertsCardiac", "medications", "medicalEquipment"],
  },
  functional_reports: {
    log: ["mobilityStatus", "adlStatus", "sensoryProfile", "safetyRisks"],
  },
  educational_reports: {
    log: ["communicationMode", "receptiveLanguage", "assistiveTechnologyUsed", "reinforcers", "preferredActivities", "behavioralStrategies"],
  },
  chat_sessions: {
    log: ["state", "log", "last", "pendingMessages", "interactivePrompt"],
  },
  boards: {
    log: ["irData"],
  },
  programs: {
    log: ["notes", "metadata"],
  },
  profile_domains: {
    log: ["strengths", "needs", "impactStatement", "adverseEffectStatement"],
  },
  goals: {
    log: ["goalStatement", "targetBehavior", "criteria", "methods", "measurementMethod", "relevance"],
  },
  objectives: {
    log: ["objectiveStatement", "targetBehavior", "methods", "criteria", "measurementMethod", "relevance"],
  },
  services: {
    core: ["providerName"],
    log: ["description", "settingDescription"],
  },
  progress_reports: {
    log: ["overallSummary", "recommendedChanges"],
  },
  goal_progress_entries: {
    log: ["currentPerformance", "narrative"],
  },
  data_points: {
    log: ["value", "context", "collectedBy"],
  },
  program_contacts: {
    log: ["responsibilities"],
  },
  biometric_data: {
    // Biometric embeddings + photos are the most sensitive — tier them all.
    biometric: ["faceEmbedding", "voiceEmbedding", "faceImageUrl"],
    log: ["hairColor", "eyeColor", "estimatedAge", "estimatedSex", "physicalDescription", "identifyingFeatures"],
  },
  meetings: {
    log: ["notes", "decisions", "parentConcerns", "parentPriorities", "agenda"],
  },
  consent_forms: {
    core: ["signedBy"],
    log: ["notes"],
  },
  transition_plans: {
    log: ["postSecondaryEducation", "employment", "independentLiving", "communityParticipation", "transitionAssessmentSummary"],
  },
  transition_goals: {
    log: ["goalStatement", "activitiesServices", "responsibleParty"],
  },
  accommodations: {
    log: ["description"],
  },
  baseline_measurements: {
    core: ["skillDescription", "value"],
    log: ["assessedBy"],
  },
  assessment_sources: {
    log: ["summary", "resultsData"],
  },
  password_reset_tokens: {
    core: ["tokenHash"],
  },
  mfa_recovery_tokens: {
    core: ["tokenHash"],
  },
  institute_students: {
    core: ["idNumber"],
  },
};

// =============================================================================
// OWNERSHIP MAP
// =============================================================================

type OwnershipResolver = (record: Record<string, unknown>) => EntityRef | null;

/**
 * Maps table name → function that resolves the owning entity from a record.
 * Returns null when the entity can't be resolved from the record alone
 * (requires entityRefOverride in helpers).
 */
export const OWNERSHIP_MAP: Record<string, OwnershipResolver> = {
  // Self-owned
  users: (r) => ({ type: "user", id: r.id as string }),
  students: (r) => ({ type: "student", id: r.id as string }),

  // Student-owned (via studentId)
  student_contacts: (r) => r.studentId ? { type: "student", id: r.studentId as string } : null,
  aac_settings: (r) => r.studentId ? { type: "student", id: r.studentId as string } : null,
  aac_session_plans: (r) => r.studentId ? { type: "student", id: r.studentId as string } : null,
  user_students: (r) => r.studentId ? { type: "student", id: r.studentId as string } : null,
  medical_records: (r) => r.studentId ? { type: "student", id: r.studentId as string } : null,
  functional_reports: (r) => r.studentId ? { type: "student", id: r.studentId as string } : null,
  educational_reports: (r) => r.studentId ? { type: "student", id: r.studentId as string } : null,
  programs: (r) => r.studentId ? { type: "student", id: r.studentId as string } : null,
  institute_students: (r) => r.studentId ? { type: "student", id: r.studentId as string } : null,

  // User-owned (via userId)
  password_reset_tokens: (r) => r.userId ? { type: "user", id: r.userId as string } : null,
  mfa_recovery_tokens: (r) => r.userId ? { type: "user", id: r.userId as string } : null,

  // Conditional: studentId if present, otherwise userId
  chat_sessions: (r) => {
    if (r.studentId) return { type: "student", id: r.studentId as string };
    if (r.userId) return { type: "user", id: r.userId as string };
    return null;
  },
  boards: (r) => {
    if (r.studentId) return { type: "student", id: r.studentId as string };
    if (r.userId) return { type: "user", id: r.userId as string };
    return null;
  },

  // Program-child tables: no direct studentId — require entityRefOverride
  profile_domains: () => null,
  goals: () => null,
  objectives: () => null,
  services: () => null,
  accommodations: () => null,
  progress_reports: () => null,
  goal_progress_entries: () => null,
  data_points: () => null,
  transition_plans: () => null,
  transition_goals: () => null,
  program_contacts: () => null,
  biometric_data: () => null,
  meetings: () => null,
  consent_forms: () => null,
  baseline_measurements: () => null,
  assessment_sources: () => null,
};

/**
 * Get all sensitive field names for a table (all tiers combined).
 */
export function getAllSensitiveFields(tableName: string): string[] {
  const config = SENSITIVE_FIELDS[tableName];
  if (!config) return [];
  return [
    ...(config.core ?? []),
    ...(config.log ?? []),
    ...(config.biometric ?? []),
  ];
}

/**
 * Build a storage key for a specific field.
 */
export function buildStorageKey(tableName: string, recordId: string, field: string): string {
  return `${tableName}/${recordId}/${field}`;
}

/**
 * Get all storage keys for a record's sensitive fields.
 */
export function getAllStorageKeys(tableName: string, recordId: string): string[] {
  return getAllSensitiveFields(tableName).map(f => buildStorageKey(tableName, recordId, f));
}
