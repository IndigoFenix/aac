import { studentRepository, aacSettingsRepository, instituteRepository } from "../repositories";
import {
  type Student,
  type InsertStudent,
  type UpdateStudent,
  type StudentWithAacSettings,
  type UpdateAacSettings,
  type UserStudent,
  type InsertUserStudent,
  type UpdateUserStudent,
  students,
  aacSettings,
  studentContacts,
  programContacts,
  userStudents,
  instituteStudents,
  studentClassrooms,
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
  accommodations,
  progressReports,
  goalProgressEntries,
  dataPoints,
  transitionPlans,
  transitionGoals,
  meetings,
  consentForms,
  chatSessions,
  boards,
  inviteCodes,
  inviteCodeRedemptions,
  studentSymbolAssociations,
} from "@shared/schema";
import { db } from "../db";
import { eq, inArray } from "drizzle-orm";
import { deleteExternalData, type EntityRef } from "../external-storage";

/** Fields that belong to the aac_settings table (sent without the 'aac' prefix from clients) */
const AAC_SETTINGS_FIELDS = new Set([
  "enabled", "demoMode", "demoScenario", "chatAgentPrompt", "modelOverride",
  "startupMode", "voiceType", "studentVoiceType",
  "customVoiceId", "customStudentVoiceId", "elevenlabsEnabled", "elevenlabsApiKey",
  "elevenlabsAiVoiceId", "elevenlabsStudentVoiceId",
  "geminiAiVoice", "geminiStudentVoice", "aiVoicePitch", "studentVoicePitch",
  "useLocalTts", "iconTextRatio",
  "usePcsSymbols", "signLanguageReading", "multiCameraMode",
  "eyegazeEnabled", "eyegazeTimeout", "eyegazeProvider", "aiName", "knownPeople",
  "allowReadProgress", "allowReadReports", "allowNotes", "shareMonitorNotesWithInstitute",
  "generateSymbols", "useApprovedSymbols", "useUnapprovedSymbols",
  "dynamicBoardsEnabled", "appConfig", "permittedWebsites", "permittedYoutubeChannels",
  "accessibility",
]);

/**
 * Split a mixed update body into student fields and AAC settings fields.
 * Accepts both new-style (no prefix) and old-style (aac* prefix) field names.
 */
function splitUpdateBody(body: Record<string, any>): {
  studentUpdates: Record<string, any>;
  aacUpdates: Record<string, any>;
} {
  const studentUpdates: Record<string, any> = {};
  const aacUpdates: Record<string, any> = {};

  for (const [key, value] of Object.entries(body)) {
    // New-style: field matches aac_settings column name directly
    if (AAC_SETTINGS_FIELDS.has(key)) {
      aacUpdates[key] = value;
      continue;
    }

    // Old-style: strip "aac" prefix and camelCase adjust
    // e.g. "aacVoiceType" → "voiceType", "aacChatAgentPrompt" → "chatAgentPrompt"
    if (key.startsWith("aac") && key.length > 3) {
      const stripped = key[3].toLowerCase() + key.slice(4);
      if (AAC_SETTINGS_FIELDS.has(stripped)) {
        aacUpdates[stripped] = value;
        continue;
      }
    }

    // Everything else goes to student updates
    studentUpdates[key] = value;
  }

  return { studentUpdates, aacUpdates };
}

export class StudentService {
  // ==================== AAC User Operations ====================

  /**
   * Create a new AAC user and link it to the creating user.
   * Also creates default AAC settings for the student.
   */
  async createStudent(
    insert: InsertStudent,
    userId: string,
    role: string = "owner"
  ): Promise<StudentWithAacSettings> {
    insert = { ...insert, ...this.parseStudentNames(insert) };
    const { student } = await studentRepository.createStudentWithLink(
      insert,
      userId,
      role
    );
    // Create default AAC settings row
    const aacSettingsRow = await aacSettingsRepository.createDefaults(student.id);
    return { ...student, aacSettings: aacSettingsRow };
  }

  /**
   * Create an AAC user and return both the user and the link
   */
  async createStudentWithLink(
    insert: InsertStudent,
    userId: string,
    role: string = "owner"
  ): Promise<{ student: StudentWithAacSettings; link: UserStudent }> {
    insert = { ...insert, ...this.parseStudentNames(insert) };
    const result = await studentRepository.createStudentWithLink(
      insert,
      userId,
      role
    );
    const aacSettingsRow = await aacSettingsRepository.createDefaults(result.student.id);
    return {
      student: { ...result.student, aacSettings: aacSettingsRow },
      link: result.link,
    };
  }

  /**
   * Get all AAC users linked to a specific user (with AAC settings)
   */
  async getStudentsByUserId(userId: string): Promise<StudentWithAacSettings[]> {
    return studentRepository.getStudentsWithAacSettingsByUserId(userId);
  }

  /**
   * Get all AAC users with their link details for a user
   */
  async getStudentsWithLinksByUserId(
    userId: string
  ): Promise<{ student: StudentWithAacSettings; link: UserStudent }[]> {
    const results = await studentRepository.getStudentsWithLinksByUserId(userId);
    // Enrich each student with their AAC settings
    const enriched = await Promise.all(
      results.map(async ({ student, link }) => {
        const withSettings = await studentRepository.getStudentWithAacSettings(student.id);
        return { student: withSettings || { ...student, aacSettings: null }, link };
      })
    );
    return enriched;
  }

  /**
   * Get students visible to a user within a specific institute.
   * Filters by institute enrollment + (direct assignment OR shared classroom OR family).
   */
  async getStudentsForUserInInstitute(
    userId: string,
    instituteId: string
  ): Promise<{ student: StudentWithAacSettings; link: UserStudent | null }[]> {
    const results = await studentRepository.getStudentsForUserInInstitute(userId, instituteId);
    const enriched = await Promise.all(
      results.map(async ({ student, link }) => {
        const withSettings = await studentRepository.getStudentWithAacSettings(student.id);
        return { student: withSettings || { ...student, aacSettings: null }, link };
      })
    );
    return enriched;
  }

  /**
   * Get an AAC user by their ID (with AAC settings)
   */
  async getStudentById(studentId: string): Promise<StudentWithAacSettings | undefined> {
    return studentRepository.getStudentWithAacSettings(studentId);
  }

  /**
   * Get a raw student (without AAC settings) — for cases that don't need them
   */
  async getStudentRaw(studentId: string): Promise<Student | undefined> {
    return studentRepository.getStudentById(studentId);
  }

  /**
   * @deprecated Use getStudentById instead
   */
  async getStudentByStudentId(studentId: string): Promise<StudentWithAacSettings | undefined> {
    return studentRepository.getStudentWithAacSettings(studentId);
  }

  /**
   * Users who share at least one active institute with the student — used as
   * the pool of valid candidates for assigning service users.
   */
  async getUsersSharingInstituteWithStudent(studentId: string) {
    return studentRepository.getUsersSharingInstituteWithStudent(studentId);
  }

  /**
   * Update a student. Accepts a mixed body with both student and AAC settings fields.
   * Splits them and routes to the correct tables.
   */
  async updateStudent(
    studentId: string,
    updates: Record<string, any>
  ): Promise<StudentWithAacSettings | undefined> {
    const parsedNames = this.parseStudentNames(updates);
    const merged = { ...parsedNames, ...updates };
    const { studentUpdates, aacUpdates } = splitUpdateBody(merged);

    // Update student fields if any
    if (Object.keys(studentUpdates).length > 0) {
      await studentRepository.updateStudent(studentId, studentUpdates as UpdateStudent);
    }

    // Update AAC settings if any
    if (Object.keys(aacUpdates).length > 0) {
      await aacSettingsRepository.upsert(studentId, aacUpdates as UpdateAacSettings);
    }

    // Return the full updated student with settings
    return studentRepository.getStudentWithAacSettings(studentId);
  }

  /**
   * Update only AAC settings for a student
   */
  async updateAacSettings(
    studentId: string,
    updates: UpdateAacSettings
  ): Promise<StudentWithAacSettings | undefined> {
    await aacSettingsRepository.upsert(studentId, updates);
    return studentRepository.getStudentWithAacSettings(studentId);
  }

  /**
   * Soft delete an AAC user
   */
  async deleteStudent(studentId: string): Promise<boolean> {
    return studentRepository.deleteStudent(studentId);
  }

  /**
   * Verify that a user has access to an AAC user
   */
  async verifyStudentAccess(
    studentId: string,
    userId: string,
    instituteId?: string
  ): Promise<{ hasAccess: boolean; student?: StudentWithAacSettings; link?: UserStudent; hasMedicalRights: boolean; hasEducationalRights: boolean; }> {
    const student = await studentRepository.getStudentWithAacSettings(studentId);
    if (!student) {
      return { hasAccess: false, hasMedicalRights: false, hasEducationalRights: false };
    }

    const link = await studentRepository.getUserStudentLink(userId, studentId);
    if (link?.isActive) {
      return { hasAccess: true, student, link, hasMedicalRights: true, hasEducationalRights: true };
    }

    // Check institute-based access: family membership or admin of school/clinic
    const enrollments = await instituteRepository.getInstitutesByStudentId(studentId);
    for (const { institute } of enrollments) {
      if (!institute) continue;

      // If a specific institute was requested, only check that one
      if (instituteId && institute.id !== instituteId) continue;

      // Family institutes grant full access to all members without a direct link
      if (institute.type === 'family') {
        const isMember = await instituteRepository.isUserMemberOfInstitute(institute.id, userId);
        if (isMember) {
          return { hasAccess: true, student, hasMedicalRights: true, hasEducationalRights: true };
        }
      }

      // Institute admins of school/clinic have full access to enrolled students
      if (institute.type === 'school' || institute.type === 'clinic') {
        const isAdmin = await instituteRepository.isUserAdminOfInstitute(institute.id, userId);
        if (isAdmin) {
          return { hasAccess: true, student, hasMedicalRights: true, hasEducationalRights: true };
        }
      }
    }

    return { hasAccess: false, student, hasMedicalRights: false, hasEducationalRights: false };
  }

  // ==================== User-AAC User Link Operations ====================

  async linkUserToStudent(
    userId: string,
    studentId: string,
    role: string = "caregiver"
  ): Promise<UserStudent> {
    return studentRepository.createUserStudentLink({
      userId,
      studentId,
      role,
      isActive: true,
    });
  }

  async getUserStudentLink(
    userId: string,
    studentId: string
  ): Promise<UserStudent | undefined> {
    return studentRepository.getUserStudentLink(userId, studentId);
  }

  async getUsersLinkedToStudent(studentId: string): Promise<UserStudent[]> {
    return studentRepository.getUsersByStudentId(studentId);
  }

  async updateUserStudentLink(
    linkId: string,
    updates: UpdateUserStudent
  ): Promise<UserStudent | undefined> {
    return studentRepository.updateUserStudentLink(linkId, updates);
  }

  async unlinkUserFromStudent(
    userId: string,
    studentId: string
  ): Promise<boolean> {
    return studentRepository.deactivateUserStudentLink(userId, studentId);
  }

  // ==================== Permanent Deletion ====================

  /**
   * Permanently delete a student and ALL associated data from the system.
   * This is irreversible. Deletes from all related tables in dependency order
   * within a single transaction, then cleans up external storage.
   */
  async permanentlyDeleteStudent(studentId: string): Promise<{ deleted: boolean; tablesAffected: Record<string, number> }> {
    const ref: EntityRef = { type: "student", id: studentId };
    const counts: Record<string, number> = {};

    // Collect IDs needed for cascading deletes before the transaction
    const programRows = await db.select({ id: programs.id }).from(programs).where(eq(programs.studentId, studentId));
    const programIds = programRows.map(r => r.id);

    let goalIds: string[] = [];
    let objectiveIds: string[] = [];
    let serviceIds: string[] = [];
    let profileDomainIds: string[] = [];
    let transitionPlanIds: string[] = [];

    if (programIds.length > 0) {
      const [goalRows, pdRows, tpRows, svcRows] = await Promise.all([
        db.select({ id: goals.id }).from(goals).where(inArray(goals.programId, programIds)),
        db.select({ id: profileDomains.id }).from(profileDomains).where(inArray(profileDomains.programId, programIds)),
        db.select({ id: transitionPlans.id }).from(transitionPlans).where(inArray(transitionPlans.programId, programIds)),
        db.select({ id: services.id }).from(services).where(inArray(services.programId, programIds)),
      ]);
      goalIds = goalRows.map(r => r.id);
      profileDomainIds = pdRows.map(r => r.id);
      transitionPlanIds = tpRows.map(r => r.id);
      serviceIds = svcRows.map(r => r.id);

      if (goalIds.length > 0) {
        const objRows = await db.select({ id: objectives.id }).from(objectives).where(inArray(objectives.goalId, goalIds));
        objectiveIds = objRows.map(r => r.id);
      }
    }

    // Helper to delete and count rows
    const del = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], table: any, condition: any, name: string) => {
      const rows = await tx.delete(table).where(condition).returning({ id: table.id });
      counts[name] = rows.length;
      return rows;
    };

    await db.transaction(async (tx) => {
      // --- Program-child leaf tables (deepest first) ---
      if (objectiveIds.length > 0) {
        await del(tx, userObjectives, inArray(userObjectives.objectiveId, objectiveIds), 'userObjectives');
        // dataPoints can reference objectiveId
        await del(tx, dataPoints, inArray(dataPoints.objectiveId, objectiveIds), 'dataPoints_byObjective');
      }

      if (goalIds.length > 0) {
        await del(tx, dataPoints, inArray(dataPoints.goalId, goalIds), 'dataPoints');
        await del(tx, goalProgressEntries, inArray(goalProgressEntries.goalId, goalIds), 'goalProgressEntries');
        await del(tx, serviceGoals, inArray(serviceGoals.goalId, goalIds), 'serviceGoals');
        await del(tx, userGoals, inArray(userGoals.goalId, goalIds), 'userGoals');
        await del(tx, objectives, inArray(objectives.goalId, goalIds), 'objectives');
      }

      if (profileDomainIds.length > 0) {
        await del(tx, baselineMeasurements, inArray(baselineMeasurements.profileDomainId, profileDomainIds), 'baselineMeasurements');
        await del(tx, assessmentSources, inArray(assessmentSources.profileDomainId, profileDomainIds), 'assessmentSources');
      }

      if (transitionPlanIds.length > 0) {
        await del(tx, transitionGoals, inArray(transitionGoals.transitionPlanId, transitionPlanIds), 'transitionGoals');
      }

      if (serviceIds.length > 0) {
        await del(tx, serviceGoals, inArray(serviceGoals.serviceId, serviceIds), 'serviceGoals_byService');
      }

      if (programIds.length > 0) {
        await del(tx, goals, inArray(goals.programId, programIds), 'goals');
        await del(tx, profileDomains, inArray(profileDomains.programId, programIds), 'profileDomains');
        await del(tx, services, inArray(services.programId, programIds), 'services');
        await del(tx, accommodations, inArray(accommodations.programId, programIds), 'accommodations');
        await del(tx, progressReports, inArray(progressReports.programId, programIds), 'progressReports');
        await del(tx, transitionPlans, inArray(transitionPlans.programId, programIds), 'transitionPlans');
        await del(tx, programContacts, inArray(programContacts.programId, programIds), 'programContacts');
        await del(tx, meetings, inArray(meetings.programId, programIds), 'meetings');
        await del(tx, consentForms, inArray(consentForms.programId, programIds), 'consentForms');
        await del(tx, programs, inArray(programs.id, programIds), 'programs');
      }

      // --- Direct student-linked tables ---
      await del(tx, inviteCodeRedemptions, eq(inviteCodeRedemptions.studentId, studentId), 'inviteCodeRedemptions');
      await del(tx, inviteCodes, eq(inviteCodes.studentId, studentId), 'inviteCodes');
      await del(tx, studentSymbolAssociations, eq(studentSymbolAssociations.studentId, studentId), 'studentSymbolAssociations');
      await del(tx, studentContacts, eq(studentContacts.studentId, studentId), 'studentContacts');
      await del(tx, medicalRecords, eq(medicalRecords.studentId, studentId), 'medicalRecords');
      await del(tx, functionalReports, eq(functionalReports.studentId, studentId), 'functionalReports');
      await del(tx, educationalReports, eq(educationalReports.studentId, studentId), 'educationalReports');
      await del(tx, chatSessions, eq(chatSessions.studentId, studentId), 'chatSessions');
      await del(tx, boards, eq(boards.studentId, studentId), 'boards');
      await del(tx, aacSettings, eq(aacSettings.studentId, studentId), 'aacSettings');

      // --- Relationship tables ---
      await del(tx, userStudents, eq(userStudents.studentId, studentId), 'userStudents');
      await del(tx, instituteStudents, eq(instituteStudents.studentId, studentId), 'instituteStudents');
      await del(tx, studentClassrooms, eq(studentClassrooms.studentId, studentId), 'studentClassrooms');

      // --- The student record itself ---
      await del(tx, students, eq(students.id, studentId), 'students');
    });

    // Clean up external storage (outside transaction - best effort)
    try {
      await deleteExternalData("students", studentId, ref);
    } catch (err) {
      console.error(`[permanentlyDeleteStudent] External storage cleanup failed for ${studentId}:`, err);
    }

    return { deleted: counts['students'] === 1, tablesAffected: counts };
  }

  // ==================== Utility Methods ====================

  calculateAge(birthDate: string | null): number | null {
    if (!birthDate) return null;

    const birth = new Date(birthDate);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }

    return age;
  }

  async getStudentWithAge(studentId: string): Promise<(StudentWithAacSettings & { age: number | null }) | undefined> {
    const student = await this.getStudentById(studentId);
    if (!student) return undefined;

    return {
      ...student,
      age: this.calculateAge(student.birthDate),
    };
  }

  parseStudentNames(student: {name?: string | null, firstName?: string | null, lastName?: string | null}): { name?: string, firstName?: string; lastName?: string } {
    let { name, firstName, lastName } = student;

    if ((firstName || lastName)) {
      // firstName/lastName are the source of truth — always derive name from them
      name = `${firstName || ""} ${lastName || ""}`.trim();
      return { name, firstName: firstName || undefined, lastName: lastName || undefined };
    } else if (name) {
      // Only name provided — split into firstName/lastName
      const nameParts = name.trim().split(" ");
      firstName = nameParts.shift() || "";
      lastName = nameParts.join(" ") || "";
      return { name, firstName, lastName };
    }

    return { };
  }
}

export const studentService = new StudentService();
