import { studentRepository, aacSettingsRepository } from "../repositories";
import {
  type Student,
  type InsertStudent,
  type UpdateStudent,
  type StudentWithAacSettings,
  type UpdateAacSettings,
  type UserStudent,
  type InsertUserStudent,
  type UpdateUserStudent,
} from "@shared/schema";

/** Fields that belong to the aac_settings table (sent without the 'aac' prefix from clients) */
const AAC_SETTINGS_FIELDS = new Set([
  "enabled", "demoMode", "demoScenario", "chatAgentPrompt", "modelOverride",
  "interpretationLevel", "startupMode", "voiceType", "studentVoiceType",
  "customVoiceId", "customStudentVoiceId", "elevenlabsApiKey",
  "elevenlabsAiVoiceId", "elevenlabsStudentVoiceId", "iconTextRatio",
  "usePcsSymbols", "signLanguageReading", "multiCameraMode",
  "eyegazeEnabled", "eyegazeTimeout", "eyegazeProvider", "aiName", "knownPeople",
  "allowReadProgress", "allowReadReports", "allowNotes",
  "generateSymbols", "useApprovedSymbols", "useUnapprovedSymbols",
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
    userId: string
  ): Promise<{ hasAccess: boolean; student?: StudentWithAacSettings; link?: UserStudent; hasMedicalRights: boolean; hasEducationalRights: boolean; }> {
    const student = await studentRepository.getStudentWithAacSettings(studentId);
    if (!student) {
      return { hasAccess: false, hasMedicalRights: false, hasEducationalRights: false };
    }

    const link = await studentRepository.getUserStudentLink(userId, studentId);
    if (!link || !link.isActive) {
      return { hasAccess: false, student, hasMedicalRights: false, hasEducationalRights: false };
    }

    return { hasAccess: true, student, link, hasMedicalRights: true, hasEducationalRights: true };
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
