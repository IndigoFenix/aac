// Subject access — "produce a copy of the data you hold about me".
// AKIM appendix §18.4 / GDPR Art. 15(3).
//
// The traversal deliberately MIRRORS `studentErasureService._hardDeleteStudent`:
// direct student-keyed tables → transitive rows via `programs` → the person
// facet (person-chat + calls) → the one-to-one biometric row. Erasure and
// access are the same question asked twice — "what do you hold about this
// child?" — and the only way the two answers stay in step is to walk the same
// tree. If a table is added to one and not the other, we either delete data we
// never disclosed or disclose data we cannot delete; both are findings.
//
// Two tables are in this walk that erasure misses today (a known gap recorded
// in the remediation plan, not fixed here — that file has another owner):
//   * `student_devices` — cleaned only by FK cascade, so it is invisible in the
//     erasure code but is very much data held about the child;
//   * `custom_symbols` reached through `student_symbol_associations`, whose S3
//     objects erasure never enumerates.
//
// ----------------------------------------------------------------------------
// WHAT IS WITHHELD, AND WHY IT IS NAMED RATHER THAN DROPPED
// ----------------------------------------------------------------------------
// Under-disclosure is the failure mode that matters here: the subject is
// entitled to the data held about them, so the default is INCLUDE. Four
// categories are withheld, and every one of them appears in `omitted` with a
// reason. A bundle that silently drops a field is indistinguishable from a
// bundle that never had it — which is exactly the ambiguity an access request
// exists to remove.
//
//  1. Biometric TEMPLATES (face/voice embeddings). A template is a security
//     credential, not a human-readable record: handing over the vector lets
//     anyone who obtains the bundle impersonate the child to a matcher, and it
//     tells the subject nothing they could read. We state that a template
//     exists and how many samples are on file. The registry's `biometric` tier
//     (external-storage/registry.ts) is the authority on which fields these
//     are — it is the curated inventory of personal-data fields, so the two
//     cannot drift. The image URL is the exception: it is a pointer to a
//     photograph of the subject, which they plainly may have, so it becomes a
//     presigned entry in `files`.
//  2. Credential-shaped columns anywhere — password / hash / token / secret.
//     Matched on the column NAME, deny-by-default, so a new credential column
//     added to any table is withheld the day it appears rather than the day
//     someone remembers this file.
//  3. `sessions` and `student_caretaker_pins` — login state and a PIN hash.
//     Authentication material, not a record about the child.
//  4. `activity_logs` and `session_debug_logs` — the audit trail is disclosed
//     through the accounting-of-disclosures query (§18.5), which is scoped and
//     filtered; a raw dump of it would leak the identities and actions of every
//     clinician who touched the record.
//
// Chat transcripts ARE included. They are the child's own words, and a
// communication record is the single most substantive thing we hold.

import { db } from "../db";
import {
  students,
  userStudents,
  instituteStudents,
  studentClassrooms,
  studentContacts,
  studentDevices,
  aacSettings,
  aacSessionPlans,
  photos,
  photoAssignments,
  biometricData,
  medicalRecords,
  functionalReports,
  educationalReports,
  programs,
  profileDomains,
  baselineMeasurements,
  assessmentSources,
  goals,
  objectives,
  userGoals,
  userObjectives,
  services,
  serviceGoals,
  serviceUsers,
  accommodations,
  progressReports,
  goalProgressEntries,
  dataPoints,
  incidents,
  transitionPlans,
  transitionGoals,
  programContacts,
  meetings,
  studentConsentRecords,
  consentInvitations,
  chatSessions,
  deepAnalyses,
  boards,
  customAppAssignments,
  dropboxBackups,
  studentShareInvites,
  objectShares,
  standingShares,
  studentSymbolAssociations,
  customSymbols,
  inviteCodeRedemptions,
  inviteCodes,
  consentForms,
  aacUtteranceEvents,
  lettersOfMedicalNecessity,
  clinicianActivityIntervals,
  persons,
  personChatRooms,
  personChats,
  personChatRoomParticipants,
  callSessions,
  callParticipants,
} from "@shared/schema";
import { eq, and, inArray, isNotNull } from "drizzle-orm";
import { SENSITIVE_FIELDS } from "../external-storage/registry";
import { s3Service } from "./storage/s3-service";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface ExportFileRef {
  /** The table whose row points at the object. */
  table: string;
  recordId: string;
  field: string;
  key: string;
  /** Null when a URL could not be minted (no bucket configured, S3 error). */
  url: string | null;
  expiresAt: string | null;
  /** Present only when `url` is null — why the subject got a key and no link. */
  error?: string;
}

export interface ExportOmission {
  table: string;
  /** `*` when the whole table is withheld. */
  field: string;
  reason: string;
}

export interface DataSubjectExport {
  generatedAt: string;
  studentId: string;
  /** Every table in the walk, `[]` when it held nothing — that is the evidence of completeness. */
  tables: Record<string, Record<string, unknown>[]>;
  files: ExportFileRef[];
  omitted: ExportOmission[];
}

export interface BuildExportOptions {
  /** TTL on the presigned URLs. Short by default — the URL IS the capability. */
  presignTtlSeconds?: number;
}

const DEFAULT_PRESIGN_TTL_SECONDS = 900;

/**
 * Column names that are credentials wherever they appear. Deny-by-default: a
 * new `apiTokenHash` column on any table is withheld the day it lands.
 */
const CREDENTIAL_NAME_RE = /password|hash|token|secret/i;

/** Registry `biometric`-tier fields that are POINTERS to a file, not templates. */
const BIOMETRIC_FILE_FIELDS = new Set(["faceImageUrl"]);

/** Tables never walked at all, with the reason the subject is owed. */
const WITHHELD_TABLES: ExportOmission[] = [
  {
    table: "sessions",
    field: "*",
    reason:
      "Login session state. Authentication material rather than a record about the data subject.",
  },
  {
    table: "student_caretaker_pins",
    field: "*",
    reason: "Caretaker PIN hash. A credential; disclosing it would defeat the control it enforces.",
  },
  {
    table: "activity_logs",
    field: "*",
    reason:
      "Audit trail. Disclosed through the accounting-of-disclosures report, which is scoped to " +
      "this subject; a raw dump would expose unrelated staff activity.",
  },
  {
    table: "session_debug_logs",
    field: "*",
    reason: "Engineering diagnostics, retained briefly and not part of the record about the subject.",
  },
];

// ---------------------------------------------------------------------------
// Row sanitising
// ---------------------------------------------------------------------------

/** How many samples a template gallery holds — stated instead of the vectors. */
function sampleCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return value === null || value === undefined ? 0 : 1;
}

/**
 * Strip credentials and biometric templates from one row, recording each
 * removal exactly once per (table, field) on `omitted`.
 */
function sanitizeRow(
  table: string,
  row: Record<string, unknown>,
  omitted: ExportOmission[],
  seen: Set<string>,
): Record<string, unknown> {
  const biometricTier = new Set(SENSITIVE_FIELDS[table]?.biometric ?? []);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    const note = (reason: string) => {
      const dedupe = `${table}.${key}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      omitted.push({ table, field: key, reason });
    };

    if (biometricTier.has(key) && !BIOMETRIC_FILE_FIELDS.has(key)) {
      const count = sampleCount(value);
      note(
        `Biometric template withheld: a template is a security credential rather than a ` +
          `human-readable record. ${count} sample(s) on file.`,
      );
      continue;
    }
    if (CREDENTIAL_NAME_RE.test(key)) {
      note("Credential-shaped column, withheld by name.");
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Build the subject-access bundle for one student.
 *
 * Read-only. Never throws on a missing S3 bucket — a file the subject cannot
 * be handed a link to is still a file we must tell them we hold, so the key is
 * reported with a null URL and the reason beside it.
 */
export async function buildDataSubjectExport(
  studentId: string,
  options: BuildExportOptions = {},
): Promise<DataSubjectExport> {
  const ttl = options.presignTtlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;
  const omitted: ExportOmission[] = [...WITHHELD_TABLES];
  const seenOmissions = new Set<string>();
  const files: ExportFileRef[] = [];
  const tables: Record<string, Record<string, unknown>[]> = {};

  const put = (name: string, rows: Record<string, unknown>[]) => {
    tables[name] = rows.map((r) => sanitizeRow(name, r, omitted, seenOmissions));
  };

  // ---- roots -------------------------------------------------------------
  const studentRows = (await db
    .select()
    .from(students)
    .where(eq(students.id, studentId))) as Record<string, unknown>[];
  put("students", studentRows);

  // ---- transitive parent ids, resolved once ------------------------------
  const programRows = await db.select().from(programs).where(eq(programs.studentId, studentId));
  const programIds = programRows.map((r) => r.id);
  put("programs", programRows as Record<string, unknown>[]);

  const profileDomainRows = programIds.length
    ? await db.select().from(profileDomains).where(inArray(profileDomains.programId, programIds))
    : [];
  const profileDomainIds = profileDomainRows.map((r) => r.id);
  put("profile_domains", profileDomainRows as Record<string, unknown>[]);

  const goalRows = programIds.length
    ? await db.select().from(goals).where(inArray(goals.programId, programIds))
    : [];
  const goalIds = goalRows.map((r) => r.id);
  put("goals", goalRows as Record<string, unknown>[]);

  const objectiveRows = goalIds.length
    ? await db.select().from(objectives).where(inArray(objectives.goalId, goalIds))
    : [];
  const objectiveIds = objectiveRows.map((r) => r.id);
  put("objectives", objectiveRows as Record<string, unknown>[]);

  const serviceRows = programIds.length
    ? await db.select().from(services).where(inArray(services.programId, programIds))
    : [];
  const serviceIds = serviceRows.map((r) => r.id);
  put("services", serviceRows as Record<string, unknown>[]);

  const transitionPlanRows = programIds.length
    ? await db.select().from(transitionPlans).where(inArray(transitionPlans.programId, programIds))
    : [];
  const transitionPlanIds = transitionPlanRows.map((r) => r.id);
  put("transition_plans", transitionPlanRows as Record<string, unknown>[]);

  const goalProgressRows = goalIds.length
    ? await db.select().from(goalProgressEntries).where(inArray(goalProgressEntries.goalId, goalIds))
    : [];
  const goalProgressIds = goalProgressRows.map((r) => r.id);
  put("goal_progress_entries", goalProgressRows as Record<string, unknown>[]);

  const boardRows = await db.select().from(boards).where(eq(boards.studentId, studentId));
  const boardIds = boardRows.map((r) => r.id);
  put("boards", boardRows as Record<string, unknown>[]);

  // ---- program children ---------------------------------------------------
  put(
    "user_goals",
    goalIds.length
      ? ((await db.select().from(userGoals).where(inArray(userGoals.goalId, goalIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "user_objectives",
    objectiveIds.length
      ? ((await db
          .select()
          .from(userObjectives)
          .where(inArray(userObjectives.objectiveId, objectiveIds))) as Record<string, unknown>[])
      : [],
  );

  // data_points reach the student by three independent paths (goal, objective,
  // progress entry) and any of the three columns may be null — the same fan-out
  // erasure has to handle. Union them by id so a row on two paths appears once.
  const dataPointRows = new Map<string, Record<string, unknown>>();
  const collectDataPoints = async (rows: Record<string, unknown>[]) => {
    for (const r of rows) dataPointRows.set(r.id as string, r);
  };
  if (goalIds.length) {
    await collectDataPoints(
      (await db.select().from(dataPoints).where(inArray(dataPoints.goalId, goalIds))) as Record<string, unknown>[],
    );
  }
  if (objectiveIds.length) {
    await collectDataPoints(
      (await db
        .select()
        .from(dataPoints)
        .where(inArray(dataPoints.objectiveId, objectiveIds))) as Record<string, unknown>[],
    );
  }
  if (goalProgressIds.length) {
    await collectDataPoints(
      (await db
        .select()
        .from(dataPoints)
        .where(inArray(dataPoints.goalProgressEntryId, goalProgressIds))) as Record<string, unknown>[],
    );
  }
  put("data_points", [...dataPointRows.values()]);

  put(
    "service_goals",
    serviceIds.length
      ? ((await db
          .select()
          .from(serviceGoals)
          .where(inArray(serviceGoals.serviceId, serviceIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "service_users",
    serviceIds.length
      ? ((await db
          .select()
          .from(serviceUsers)
          .where(inArray(serviceUsers.serviceId, serviceIds))) as Record<string, unknown>[])
      : [],
  );

  // accommodations hang off a program OR a service; union both.
  const accommodationRows = new Map<string, Record<string, unknown>>();
  if (programIds.length) {
    for (const r of (await db
      .select()
      .from(accommodations)
      .where(inArray(accommodations.programId, programIds))) as Record<string, unknown>[]) {
      accommodationRows.set(r.id as string, r);
    }
  }
  if (serviceIds.length) {
    for (const r of (await db
      .select()
      .from(accommodations)
      .where(inArray(accommodations.serviceId, serviceIds))) as Record<string, unknown>[]) {
      accommodationRows.set(r.id as string, r);
    }
  }
  put("accommodations", [...accommodationRows.values()]);

  put(
    "progress_reports",
    programIds.length
      ? ((await db
          .select()
          .from(progressReports)
          .where(inArray(progressReports.programId, programIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "program_contacts",
    programIds.length
      ? ((await db
          .select()
          .from(programContacts)
          .where(inArray(programContacts.programId, programIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "meetings",
    programIds.length
      ? ((await db.select().from(meetings).where(inArray(meetings.programId, programIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "consent_forms",
    programIds.length
      ? ((await db
          .select()
          .from(consentForms)
          .where(inArray(consentForms.programId, programIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "assessment_sources",
    profileDomainIds.length
      ? ((await db
          .select()
          .from(assessmentSources)
          .where(inArray(assessmentSources.profileDomainId, profileDomainIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "baseline_measurements",
    profileDomainIds.length
      ? ((await db
          .select()
          .from(baselineMeasurements)
          .where(inArray(baselineMeasurements.profileDomainId, profileDomainIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "transition_goals",
    transitionPlanIds.length
      ? ((await db
          .select()
          .from(transitionGoals)
          .where(inArray(transitionGoals.transitionPlanId, transitionPlanIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "dropbox_backups",
    boardIds.length
      ? ((await db
          .select()
          .from(dropboxBackups)
          .where(inArray(dropboxBackups.boardId, boardIds))) as Record<string, unknown>[])
      : [],
  );

  // ---- direct student-keyed tables ---------------------------------------
  const direct: Array<[string, () => Promise<unknown[]>]> = [
    ["deep_analyses", () => db.select().from(deepAnalyses).where(eq(deepAnalyses.studentId, studentId))],
    ["medical_records", () => db.select().from(medicalRecords).where(eq(medicalRecords.studentId, studentId))],
    ["functional_reports", () => db.select().from(functionalReports).where(eq(functionalReports.studentId, studentId))],
    ["educational_reports", () => db.select().from(educationalReports).where(eq(educationalReports.studentId, studentId))],
    ["incidents", () => db.select().from(incidents).where(eq(incidents.studentId, studentId))],
    ["student_consent_records", () => db.select().from(studentConsentRecords).where(eq(studentConsentRecords.studentId, studentId))],
    ["consent_invitations", () => db.select().from(consentInvitations).where(eq(consentInvitations.studentId, studentId))],
    // The child's own words — the most substantive record we hold, and included
    // in full for that reason.
    ["chat_sessions", () => db.select().from(chatSessions).where(eq(chatSessions.studentId, studentId))],
    ["aac_utterance_events", () => db.select().from(aacUtteranceEvents).where(eq(aacUtteranceEvents.studentId, studentId))],
    ["letters_of_medical_necessity", () => db.select().from(lettersOfMedicalNecessity).where(eq(lettersOfMedicalNecessity.studentId, studentId))],
    ["clinician_activity_intervals", () => db.select().from(clinicianActivityIntervals).where(eq(clinicianActivityIntervals.studentId, studentId))],
    ["custom_app_assignments", () => db.select().from(customAppAssignments).where(eq(customAppAssignments.studentId, studentId))],
    ["student_share_invites", () => db.select().from(studentShareInvites).where(eq(studentShareInvites.studentId, studentId))],
    ["object_shares", () => db.select().from(objectShares).where(eq(objectShares.studentId, studentId))],
    ["standing_shares", () => db.select().from(standingShares).where(eq(standingShares.studentId, studentId))],
    ["student_classrooms", () => db.select().from(studentClassrooms).where(eq(studentClassrooms.studentId, studentId))],
    ["student_contacts", () => db.select().from(studentContacts).where(eq(studentContacts.studentId, studentId))],
    ["institute_students", () => db.select().from(instituteStudents).where(eq(instituteStudents.studentId, studentId))],
    ["user_students", () => db.select().from(userStudents).where(eq(userStudents.studentId, studentId))],
    ["aac_settings", () => db.select().from(aacSettings).where(eq(aacSettings.studentId, studentId))],
    ["aac_session_plans", () => db.select().from(aacSessionPlans).where(eq(aacSessionPlans.studentId, studentId))],
    ["photo_assignments", () => db.select().from(photoAssignments).where(eq(photoAssignments.studentId, studentId))],
    // Absent from the erasure walk (FK cascade does the work there), which is
    // exactly why it is easy to forget it is data held about the child.
    ["student_devices", () => db.select().from(studentDevices).where(eq(studentDevices.studentId, studentId))],
  ];
  for (const [name, run] of direct) {
    put(name, (await run()) as Record<string, unknown>[]);
  }

  // ---- invite codes + redemptions ----------------------------------------
  const inviteCodeRows = await db.select().from(inviteCodes).where(eq(inviteCodes.studentId, studentId));
  put("invite_codes", inviteCodeRows as Record<string, unknown>[]);
  const inviteCodeIds = inviteCodeRows.map((r) => r.id);
  const redemptions = new Map<string, Record<string, unknown>>();
  for (const r of (await db
    .select()
    .from(inviteCodeRedemptions)
    .where(eq(inviteCodeRedemptions.studentId, studentId))) as Record<string, unknown>[]) {
    redemptions.set(r.id as string, r);
  }
  if (inviteCodeIds.length) {
    for (const r of (await db
      .select()
      .from(inviteCodeRedemptions)
      .where(inArray(inviteCodeRedemptions.inviteCodeId, inviteCodeIds))) as Record<string, unknown>[]) {
      redemptions.set(r.id as string, r);
    }
  }
  put("invite_code_redemptions", [...redemptions.values()]);

  // ---- symbols the student is associated with ----------------------------
  const symbolAssocRows = await db
    .select()
    .from(studentSymbolAssociations)
    .where(eq(studentSymbolAssociations.studentId, studentId));
  put("student_symbol_associations", symbolAssocRows as Record<string, unknown>[]);
  const symbolIds = symbolAssocRows.map((r) => r.symbolId);
  const symbolRows = symbolIds.length
    ? await db.select().from(customSymbols).where(inArray(customSymbols.id, symbolIds))
    : [];
  put("custom_symbols", symbolRows as Record<string, unknown>[]);

  // ---- photos -------------------------------------------------------------
  const photoIds = (tables["photo_assignments"] ?? []).map((r) => r.photoId as string).filter(Boolean);
  const photoRows = photoIds.length
    ? await db.select().from(photos).where(inArray(photos.id, [...new Set(photoIds)]))
    : [];
  put("photos", photoRows as Record<string, unknown>[]);

  // ---- person facet -------------------------------------------------------
  const personRows = await db.select().from(persons).where(eq(persons.studentId, studentId));
  put("persons", personRows as Record<string, unknown>[]);
  const personIds = personRows.map((r) => r.id);

  put(
    "person_chat_rooms",
    personIds.length
      ? ((await db
          .select()
          .from(personChatRooms)
          .where(inArray(personChatRooms.createdByPersonId, personIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "person_chats",
    personIds.length
      ? ((await db
          .select()
          .from(personChats)
          .where(inArray(personChats.senderPersonId, personIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "person_chat_room_participants",
    personIds.length
      ? ((await db
          .select()
          .from(personChatRoomParticipants)
          .where(inArray(personChatRoomParticipants.personId, personIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "call_participants",
    personIds.length
      ? ((await db
          .select()
          .from(callParticipants)
          .where(inArray(callParticipants.personId, personIds))) as Record<string, unknown>[])
      : [],
  );
  put(
    "call_sessions",
    personIds.length
      ? ((await db
          .select()
          .from(callSessions)
          .where(inArray(callSessions.initiatedByPersonId, personIds))) as Record<string, unknown>[])
      : [],
  );

  // ---- biometric row (one-to-one via students.biometricDataId) -----------
  const biometricDataId = (studentRows[0]?.biometricDataId as string | null) ?? null;
  const biometricRows = biometricDataId
    ? await db.select().from(biometricData).where(eq(biometricData.id, biometricDataId))
    : [];
  put("biometric_data", biometricRows as Record<string, unknown>[]);

  // Contacts carry their OWN biometric row unless linked; those faces are the
  // contact's data, not the child's — the row is reachable here only because it
  // is referenced from a contact row we already disclosed, so we surface the
  // image pointer and nothing else.
  const contactBiometricIds = (
    await db
      .select({ id: studentContacts.biometricDataId })
      .from(studentContacts)
      .where(and(eq(studentContacts.studentId, studentId), isNotNull(studentContacts.biometricDataId)))
  )
    .map((r) => r.id)
    .filter((id): id is string => Boolean(id));

  // ---- files --------------------------------------------------------------
  const fileTargets: Array<{ table: string; recordId: string; field: string; key: string }> = [];
  for (const row of tables["photos"] ?? []) {
    if (row.s3Key) fileTargets.push({ table: "photos", recordId: row.id as string, field: "s3Key", key: row.s3Key as string });
    if (row.thumbS3Key)
      fileTargets.push({ table: "photos", recordId: row.id as string, field: "thumbS3Key", key: row.thumbS3Key as string });
  }
  for (const row of tables["custom_symbols"] ?? []) {
    if (row.s3Key)
      fileTargets.push({ table: "custom_symbols", recordId: row.id as string, field: "s3Key", key: row.s3Key as string });
  }
  for (const row of tables["biometric_data"] ?? []) {
    if (row.faceImageUrl)
      fileTargets.push({
        table: "biometric_data",
        recordId: row.id as string,
        field: "faceImageUrl",
        key: row.faceImageUrl as string,
      });
  }
  if (contactBiometricIds.length) {
    const contactBio = await db
      .select({ id: biometricData.id, faceImageUrl: biometricData.faceImageUrl })
      .from(biometricData)
      .where(inArray(biometricData.id, contactBiometricIds));
    for (const row of contactBio) {
      if (row.faceImageUrl)
        fileTargets.push({
          table: "biometric_data",
          recordId: row.id,
          field: "faceImageUrl",
          key: row.faceImageUrl,
        });
    }
  }

  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  for (const target of fileTargets) {
    try {
      const url = await s3Service.presignGet(target.key, ttl);
      files.push({ ...target, url, expiresAt });
    } catch (err: any) {
      // A file we cannot link to is still a file we hold. Say so.
      files.push({
        ...target,
        url: null,
        expiresAt: null,
        error: err?.message ?? "Could not mint a download link for this object.",
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    studentId,
    tables,
    files,
    omitted,
  };
}
