/**
 * institute-memory-schema.ts
 * 
 * Memory field schema and database operations for Institute, Classroom, and Student management.
 * Used when sessionService mode is "institute" or when organization management is needed.
 * 
 * This file defines:
 * 1. Memory field definitions for institute structure
 * 2. Database operations using instituteService, classroomService, and studentService
 * 3. System prompt for the organization management AI
 * 
 * Structure:
 * - Context_Institutes (map) - institutes the user is a member of, keyed by id
 *   - members (map) - users in the institute, keyed by userId
 *   - students (map) - students enrolled in the institute, keyed by studentId
 *   - classrooms (map) - classrooms in the institute (schools only), keyed by id
 *     - members (map) - users assigned to classroom
 *     - students (map) - students enrolled in classroom
 *   - invites (map) - pending invites, keyed by id
 * - Context_Students (map) - students the user has access to, keyed by id
 *   - users (map) - users linked to this student
 *   - institutes (array) - institutes the student belongs to
 *   - classrooms (array) - classrooms the student is enrolled in
 * 
 * Relationships:
 * - Students have many-to-many with Institutes (via instituteStudents)
 * - Students have many-to-many with Classrooms (via studentClassrooms)
 * - Students can only have ONE active school at a time (enforced by service)
 * - Users have many-to-many with Institutes (via instituteUsers)
 * - Users have many-to-many with Classrooms (via classroomUsers)
 * - Users have many-to-many with Students (via userStudents)
 */

import {
    type AgentMemoryFieldWithDB,
    type AgentMemoryFieldObjectWithDB,
    type AgentMemoryFieldArrayWithDB,
    type AgentMemoryFieldMapWithDB,
    type MemoryDBOperations,
    type DBOperationContext,
    type ListResult,
  } from "../chat/memory-types";
  
  import { instituteService } from "../instituteService";
  import { classroomService } from "../classroomService";
  import { studentService } from "../studentService";
  import { activityLogService } from "../activityLogService";
  import { aacSettingsRepository } from "../../repositories/aacSettingsRepository";
  import { instituteRepository } from "../../repositories/instituteRepository";
  import { licenseRepository } from "../../repositories/licenseRepository";
  import { calendarRepository } from "../../repositories/calendarRepository";
  import { calendarService } from "../calendarService";
  import { locationService } from "../locationService";
  import { parseLocalOrIsoInTimezone } from "../../lib/timezone";
  import type { LicensePermissions } from "@shared/license-permissions";
  import { resolvePermissions } from "@shared/license-permissions";
  
  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================
  
  /**
   * Transform database record to memory value, removing internal fields
   */
  function toMemoryValue<T extends Record<string, any>>(
    record: T,
    excludeFields: string[] = ["createdAt", "updatedAt"]
  ): any {
    if (!record) return record;
    const result = { ...record };
    for (const field of excludeFields) {
      delete (result as any)[field];
    }
    return result;
  }

  /**
   * Enrollment is exposed to the AI write-only for `idNumber`: it can be set
   * via add/update, but on read the actual value is replaced with "[REDACTED]"
   * (or left null/undefined when unset) so the AI cannot see existing student
   * ID numbers — yet still knows whether one is on file, so it does not ask
   * for a value that is already stored.
   */
  function toEnrollmentMemoryValue(record: any): any {
    const v = toMemoryValue(record);
    if (!v) return v;
    if (v.idNumber !== null && v.idNumber !== undefined && v.idNumber !== "") {
      v.idNumber = "[REDACTED]";
    }
    return v;
  }

  /**
   * The AI sees "[REDACTED]" on read for write-only ID fields. If it echoes
   * that placeholder back as a write, drop it so we never overwrite a real
   * stored value with the placeholder string. `undefined` means "leave alone".
   */
  function sanitizeIdNumberInput(input: unknown): string | undefined {
    if (input === null || input === undefined) return undefined;
    if (typeof input !== "string") return undefined;
    if (input === "[REDACTED]") return undefined;
    return input;
  }
  
  /**
   * Get the requesting user ID from context
   */
  function getUserId(ctx: DBOperationContext): string {
    const userId = ctx.all.userId;
    if (!userId) throw new Error("userId required in context");
    return userId;
  }
  
  // ============================================================================
  // DATABASE OPERATIONS - INSTITUTES
  // ============================================================================

  /**
   * Surfaced verbatim to the AI when it attempts to create/edit/delete an
   * institute record. Must stay single-line (sanitizeDbError keeps only the
   * first line) and tell the AI what to do instead.
   */
  const INSTITUTE_READONLY_ERROR =
    "Institute records are read-only for the AI: they are provisioned together with licenses. " +
    "Ask the user to edit institute details in the app's institute settings instead.";

  /**
   * Institutes operations (MAP) - institutes the user is a member of
   */
  const institutesOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const selectedInstituteId = ctx.all.instituteId as string | undefined;

      // Only show the selected institute
      if (selectedInstituteId) {
        const institute = await instituteService.getInstituteById(selectedInstituteId);
        if (institute) {
          const { isMember, membership } = await instituteService.verifyMembership(selectedInstituteId, userId);
          if (isMember && membership) {
            const item = { ...toMemoryValue(institute), membership: toMemoryValue(membership) };
            return { items: [item], total: 1, keys: [institute.id] };
          }
        }
        return { items: [], total: 0, keys: [] };
      }

      // No institute selected — show nothing
      return { items: [], total: 0, keys: [] };
    },
  
    get: async (ctx, key) => {
      const institute = await instituteService.getInstituteById(String(key));
      if (!institute) return undefined;
      
      const userId = getUserId(ctx);
      const { isMember, membership } = await instituteService.verifyMembership(
        institute.id,
        userId
      );
      
      if (!isMember) return undefined;
      
      return {
        ...toMemoryValue(institute),
        membership: membership ? toMemoryValue(membership) : undefined,
      };
    },
  
    // Institute records are tied to licensing and are provisioned/edited by
    // administrators in the app — the AI must never create, modify, or delete
    // them (members/students/classrooms below remain writable). The ops throw
    // instead of being omitted so the refusal reaches the AI as an explicit
    // tool error rather than a silent in-memory-only write.
    // Note: the schema-level `readOnly` flag can't express this — tool-router
    // enforces it per ROOT field only, which would also lock the writable
    // sub-collections under Context_Institutes.
    add: async () => {
      throw new Error(INSTITUTE_READONLY_ERROR);
    },

    update: async () => {
      throw new Error(INSTITUTE_READONLY_ERROR);
    },

    delete: async () => {
      throw new Error(INSTITUTE_READONLY_ERROR);
    },

    fromDB: (record) => ({
      ...toMemoryValue(record),
      // Initialize empty collections for nested data
      members: {},
      students: {},
      classrooms: {},
      invites: {},
    }),
  
    extractChildContext: (value, key) => ({
      // Use value.id if available, otherwise use the key as fallback
      instituteId: value?.id || (typeof key === 'string' ? key : undefined),
      instituteType: value?.type,
    }),
  
    getDBKey: (value) => value?.id,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - INSTITUTE MEMBERS
  // ============================================================================
  
  /**
   * Institute members operations (MAP) - users in an institute
   */
  const instituteMembersOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");
  
      const result = await instituteService.getInstituteMembers(instituteId, userId);
      if (!result.success || !result.members) {
        throw new Error(result.error || "Failed to get members");
      }
  
      const paged = result.members.slice(offset, offset + limit);
      const items = paged.map(({ user, membership }) => ({
        user: toMemoryValue(user, ["createdAt", "updatedAt", "password"]),
        membership: toMemoryValue(membership),
      }));
      
      const keys = paged.map(({ user }) => user.id);
  
      return {
        items,
        total: result.members.length,
        keys,
      };
    },
  
    update: async (ctx, key, value) => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");

      const result = await instituteService.updateMember(
        instituteId,
        String(key),
        { role: value.role, isAdmin: value.isAdmin },
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to update member");
      }

      activityLogService.log({
        instituteId,
        userId: getUserId(ctx),
        eventType: "update",
        subjectType1: "institute",
        subjectId1: instituteId,
        subjectType2: "user",
        subjectId2: String(key),
        isAiInitiated: true,
      });

      return { membership: result.membership ? toMemoryValue(result.membership) : undefined };
    },

    delete: async (ctx, key) => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");

      const result = await instituteService.removeMember(
        instituteId,
        String(key),
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to remove member");
      }

      activityLogService.log({
        instituteId,
        userId: getUserId(ctx),
        eventType: "unlink",
        subjectType1: "institute",
        subjectId1: instituteId,
        subjectType2: "user",
        subjectId2: String(key),
        isAiInitiated: true,
      });
    },

    fromDB: (record) => ({
      user: record?.user ? toMemoryValue(record.user, ["createdAt", "updatedAt", "password"]) : undefined,
      membership: record?.membership ? toMemoryValue(record.membership) : undefined,
    }),

    getDBKey: (value) => value?.user?.id || value?.membership?.userId,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - INSTITUTE STUDENTS
  // ============================================================================
  
  /**
   * Institute students operations (MAP) - students enrolled in an institute
   */
  const instituteStudentsOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");
  
      const result = await instituteService.getInstituteStudents(instituteId, userId);
      if (!result.success || !result.students) {
        throw new Error(result.error || "Failed to get institute students");
      }
  
      const paged = result.students.slice(offset, offset + limit);
      const items = paged.map(({ student, enrollment }) => ({
        student: toMemoryValue(student),
        enrollment: toEnrollmentMemoryValue(enrollment),
      }));

      const keys = paged.map(({ student }) => student.id);

      return {
        items,
        total: result.students.length,
        keys,
      };
    },

    add: async (ctx, value, options) => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");

      // Accept studentId from options.key (the map key) OR value.studentId
      const studentId = options?.key || value.studentId;
      if (!studentId) {
        throw new Error("studentId required - provide as 'key' parameter or in value.studentId");
      }

      // idNumber may be nested under enrollment when the AI mirrors the read shape.
      // "[REDACTED]" is the placeholder we hand back on reads — ignore it on writes
      // so the AI never accidentally overwrites a real id with the placeholder.
      const idNumber = sanitizeIdNumberInput(value.idNumber ?? value?.enrollment?.idNumber);
      const result = await instituteService.assignStudentToInstitute(
        instituteId,
        studentId,
        userId,
        {
          enrollmentDate: value.enrollmentDate,
          idNumber,
          grade: value.grade,
        }
      );

      if (!result.success || !result.enrollment) {
        throw new Error(result.error || "Failed to assign student");
      }

      // Get the full student data
      const student = await studentService.getStudentById(studentId);

      activityLogService.log({
        instituteId,
        userId: getUserId(ctx),
        eventType: "link",
        subjectType1: "institute",
        subjectId1: instituteId,
        subjectType2: "student",
        subjectId2: studentId,
        isAiInitiated: true,
      });

      return {
        student: student ? toMemoryValue(student) : undefined,
        enrollment: toEnrollmentMemoryValue(result.enrollment),
      };
    },

    update: async (ctx, key, value) => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");

      const idNumber = sanitizeIdNumberInput(value.idNumber ?? value?.enrollment?.idNumber);
      const grade = value.grade ?? value?.enrollment?.grade;
      const result = await instituteService.updateStudentEnrollment(
        instituteId,
        String(key),
        { idNumber, grade },
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to update enrollment");
      }

      activityLogService.log({
        instituteId,
        userId: getUserId(ctx),
        eventType: "update",
        subjectType1: "institute",
        subjectId1: instituteId,
        subjectType2: "student",
        subjectId2: String(key),
        isAiInitiated: true,
      });

      return { enrollment: result.enrollment ? toEnrollmentMemoryValue(result.enrollment) : undefined };
    },

    delete: async (ctx, key) => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");

      const result = await instituteService.removeStudentFromInstitute(
        instituteId,
        String(key),
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to remove student");
      }

      activityLogService.log({
        instituteId,
        userId: getUserId(ctx),
        eventType: "unlink",
        subjectType1: "institute",
        subjectId1: instituteId,
        subjectType2: "student",
        subjectId2: String(key),
        isAiInitiated: true,
      });
    },
  
    fromDB: (record) => ({
      student: record?.student ? toMemoryValue(record.student) : undefined,
      enrollment: record?.enrollment ? toEnrollmentMemoryValue(record.enrollment) : undefined,
    }),

    extractChildContext: (value, key) => ({
      // Use value.student.id if available, otherwise use the key as fallback
      studentId: value?.student?.id || (typeof key === 'string' ? key : undefined),
    }),

    getDBKey: (value) => value?.student?.id || value?.enrollment?.studentId,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - CLASSROOMS
  // ============================================================================
  
  /**
   * Classrooms operations (MAP) - classrooms in an institute
   */
  const classroomsOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");
  
      const result = await classroomService.getInstituteClassrooms(instituteId, userId);
      if (!result.success || !result.classrooms) {
        throw new Error(result.error || "Failed to get classrooms");
      }
  
      const paged = result.classrooms.slice(offset, offset + limit);
      const items = paged.map(c => toMemoryValue(c));
      const keys = paged.map(c => c.id);
  
      return {
        items,
        total: result.classrooms.length,
        keys,
      };
    },
  
    get: async (ctx, key) => {
      const keyStr = String(key);
      // Try to get by ID first
      let classroom = await classroomService.getClassroomById(keyStr);

      // If not found and we have an instituteId, try to find by name or roomNumber
      if (!classroom && ctx.all.instituteId) {
        const userId = getUserId(ctx);
        const result = await classroomService.getInstituteClassrooms(ctx.all.instituteId, userId);
        if (result.success && result.classrooms) {
          classroom = result.classrooms.find(
            c => c.name === keyStr || c.roomNumber === keyStr
          );
        }
      }

      return classroom ? toMemoryValue(classroom) : undefined;
    },
  
    add: async (ctx, value) => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");
  
      const result = await classroomService.createClassroom(
        {
          instituteId,
          name: value.name,
          grade: value.grade,
          description: value.description,
          capacity: value.capacity,
          roomNumber: value.roomNumber,
          academicYear: value.academicYear,
        },
        userId
      );
  
      if (!result.success || !result.classroom) {
        throw new Error(result.error || "Failed to create classroom");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "create",
        subjectType1: "classroom",
        subjectId1: result.classroom.id,
        isAiInitiated: true,
      });

      return toMemoryValue(result.classroom);
    },

    update: async (ctx, key, value) => {
      const userId = getUserId(ctx);

      const result = await classroomService.updateClassroom(
        String(key),
        value,
        userId
      );

      if (!result.success || !result.classroom) {
        throw new Error(result.error || "Failed to update classroom");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "update",
        subjectType1: "classroom",
        subjectId1: String(key),
        isAiInitiated: true,
      });

      return toMemoryValue(result.classroom);
    },

    delete: async (ctx, key) => {
      const userId = getUserId(ctx);

      const result = await classroomService.deleteClassroom(String(key), userId);
      if (!result.success) {
        throw new Error(result.error || "Failed to delete classroom");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "delete",
        subjectType1: "classroom",
        subjectId1: String(key),
        isAiInitiated: true,
      });
    },

    fromDB: (record) => ({
      ...toMemoryValue(record),
      members: {},
      students: {},
    }),
  
    extractChildContext: (value, key) => ({
      // Use value.id if available, otherwise use the key as fallback
      // This handles cases where the classroom was looked up by name/roomNumber
      classroomId: value?.id || (typeof key === 'string' ? key : undefined),
    }),

    getDBKey: (value) => value?.id,
  };

  // ============================================================================
  // DATABASE OPERATIONS - CLASSROOM MEMBERS
  // ============================================================================
  
  /**
   * Classroom members operations (MAP) - users assigned to a classroom
   */
  const classroomMembersOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const classroomId = ctx.all.classroomId;
      if (!classroomId) throw new Error("classroomId required");
  
      const result = await classroomService.getClassroomMembers(classroomId, userId);
      if (!result.success || !result.members) {
        throw new Error(result.error || "Failed to get classroom members");
      }
  
      const paged = result.members.slice(offset, offset + limit);
      const items = paged.map(({ user, membership }) => ({
        user: toMemoryValue(user, ["createdAt", "updatedAt", "password"]),
        membership: toMemoryValue(membership),
      }));
      
      const keys = paged.map(({ user }) => user.id);
  
      return {
        items,
        total: result.members.length,
        keys,
      };
    },
  
    add: async (ctx, value, options) => {
      const currentUserId = getUserId(ctx);
      const classroomId = ctx.all.classroomId;
      if (!classroomId) throw new Error("classroomId required");

      // Accept userId from options.key (the map key) OR value.userId
      const targetUserId = options?.key || value.userId;
      if (!targetUserId) {
        throw new Error("userId required - provide as 'key' parameter or in value.userId");
      }

      const result = await classroomService.addUserToClassroom(
        classroomId,
        targetUserId,
        value.role || "teacher",
        currentUserId,
        value.isPrimary || false
      );

      if (!result.success || !result.membership) {
        throw new Error(result.error || "Failed to add member");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "link",
        subjectType1: "classroom",
        subjectId1: classroomId,
        subjectType2: "user",
        subjectId2: targetUserId,
        isAiInitiated: true,
      });

      return { membership: toMemoryValue(result.membership) };
    },

    update: async (ctx, key, value) => {
      const userId = getUserId(ctx);
      const classroomId = ctx.all.classroomId;
      if (!classroomId) throw new Error("classroomId required");

      const result = await classroomService.updateClassroomMember(
        classroomId,
        String(key),
        { role: value.role, isPrimary: value.isPrimary },
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to update member");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "update",
        subjectType1: "classroom",
        subjectId1: classroomId,
        subjectType2: "user",
        subjectId2: String(key),
        isAiInitiated: true,
      });

      return { membership: result.membership ? toMemoryValue(result.membership) : undefined };
    },

    delete: async (ctx, key) => {
      const userId = getUserId(ctx);
      const classroomId = ctx.all.classroomId;
      if (!classroomId) throw new Error("classroomId required");

      const result = await classroomService.removeUserFromClassroom(
        classroomId,
        String(key),
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to remove member");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "unlink",
        subjectType1: "classroom",
        subjectId1: classroomId,
        subjectType2: "user",
        subjectId2: String(key),
        isAiInitiated: true,
      });
    },

    fromDB: (record) => ({
      user: record?.user ? toMemoryValue(record.user, ["createdAt", "updatedAt", "password"]) : undefined,
      membership: record?.membership ? toMemoryValue(record.membership) : undefined,
    }),

    getDBKey: (value) => value?.user?.id || value?.membership?.userId,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - CLASSROOM STUDENTS
  // ============================================================================
  
  /**
   * Classroom students operations (MAP) - students enrolled in a classroom
   */
  const classroomStudentsOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const classroomId = ctx.all.classroomId;
      if (!classroomId) throw new Error("classroomId required");
  
      const result = await classroomService.getClassroomStudents(classroomId, userId);
      if (!result.success || !result.students) {
        throw new Error(result.error || "Failed to get classroom students");
      }
  
      const paged = result.students.slice(offset, offset + limit);
      const items = paged.map(({ student, enrollment }) => ({
        student: toMemoryValue(student),
        enrollment: toMemoryValue(enrollment),
      }));
      
      const keys = paged.map(({ student }) => student.id);
  
      return {
        items,
        total: result.students.length,
        keys,
      };
    },
  
    add: async (ctx, value, options) => {
      const userId = getUserId(ctx);
      const classroomId = ctx.all.classroomId;
      if (!classroomId) throw new Error("classroomId required");

      // Accept studentId from options.key (the map key) OR value.studentId
      const studentId = options?.key || value.studentId;
      if (!studentId) {
        throw new Error("studentId required - provide as 'key' parameter or in value.studentId");
      }

      const result = await classroomService.addStudentToClassroom(
        studentId,
        classroomId,
        userId,
        {
          isPrimary: value.isPrimary,
          enrollmentDate: value.enrollmentDate,
          notes: value.notes,
        }
      );

      if (!result.success || !result.enrollment) {
        throw new Error(result.error || "Failed to add student");
      }

      const student = await studentService.getStudentById(studentId);

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "link",
        subjectType1: "classroom",
        subjectId1: classroomId,
        subjectType2: "student",
        subjectId2: studentId,
        isAiInitiated: true,
      });

      return {
        student: student ? toMemoryValue(student) : undefined,
        enrollment: toMemoryValue(result.enrollment),
      };
    },

    update: async (ctx, key, value) => {
      const userId = getUserId(ctx);
      const classroomId = ctx.all.classroomId;
      if (!classroomId) throw new Error("classroomId required");

      const result = await classroomService.updateStudentEnrollment(
        String(key),
        classroomId,
        { isPrimary: value.isPrimary, notes: value.notes },
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to update enrollment");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "update",
        subjectType1: "classroom",
        subjectId1: classroomId,
        subjectType2: "student",
        subjectId2: String(key),
        isAiInitiated: true,
      });

      return { enrollment: result.enrollment ? toMemoryValue(result.enrollment) : undefined };
    },

    delete: async (ctx, key) => {
      const userId = getUserId(ctx);
      const classroomId = ctx.all.classroomId;
      if (!classroomId) throw new Error("classroomId required");

      const result = await classroomService.removeStudentFromClassroom(
        String(key),
        classroomId,
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to remove student");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "unlink",
        subjectType1: "classroom",
        subjectId1: classroomId,
        subjectType2: "student",
        subjectId2: String(key),
        isAiInitiated: true,
      });
    },
  
    fromDB: (record) => ({
      student: record?.student ? toMemoryValue(record.student) : undefined,
      enrollment: record?.enrollment ? toMemoryValue(record.enrollment) : undefined,
    }),
  
    getDBKey: (value) => value?.student?.id || value?.enrollment?.studentId,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - INSTITUTE INVITES
  // ============================================================================
  
  /**
   * Institute invites operations (MAP) - pending invites for an institute
   */
  const instituteInvitesOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");
  
      const result = await instituteService.getInstituteInvites(instituteId, userId);
      if (!result.success || !result.invites) {
        throw new Error(result.error || "Failed to get invites");
      }
  
      const paged = result.invites.slice(offset, offset + limit);
      const items = paged.map(invite => toMemoryValue(invite));
      const keys = paged.map(invite => invite.id);
  
      return {
        items,
        total: result.invites.length,
        keys,
      };
    },
  
    add: async (ctx, value) => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId;
      if (!instituteId) throw new Error("instituteId required");
  
      const result = await instituteService.sendInvite(
        instituteId,
        value.inviteeEmail,
        userId,
        {
          role: value.role,
          grantAdmin: value.grantAdmin,
          message: value.message,
        }
      );
  
      if (!result.success || !result.invite) {
        throw new Error(result.error || "Failed to send invite");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "create",
        subjectType1: "invite",
        subjectId1: result.invite.id,
        isAiInitiated: true,
      });

      return toMemoryValue(result.invite);
    },

    delete: async (ctx, key) => {
      const userId = getUserId(ctx);

      const result = await instituteService.cancelInvite(String(key), userId);
      if (!result.success) {
        throw new Error(result.error || "Failed to cancel invite");
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "delete",
        subjectType1: "invite",
        subjectId1: String(key),
        isAiInitiated: true,
      });
    },

    fromDB: (record) => toMemoryValue(record),

    getDBKey: (value) => value?.id,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - STUDENTS (User's students)
  // ============================================================================
  
  /**
   * Students operations (MAP) - students the user has access to
   */
  const studentsOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId as string | undefined;
      const licensePerms = ctx.all.licensePermissions as LicensePermissions | undefined;

      // License with maxStudents === 0 means no student access
      if (licensePerms && licensePerms.maxStudents === 0) {
        return { items: [], total: 0, keys: [] };
      }

      // If an institute is selected, scope students to that institute
      const studentsWithLinks = instituteId
        ? await studentService.getStudentsForUserInInstitute(userId, instituteId)
        : await studentService.getStudentsWithLinksByUserId(userId);

      const paged = studentsWithLinks.slice(offset, offset + limit);
      const items = paged.map(({ student, link }) => ({
        ...toMemoryValue(student),
        link: link ? toMemoryValue(link) : undefined,
      }));

      const keys = paged.map(({ student }) => student.id);

      return {
        items,
        total: studentsWithLinks.length,
        keys,
      };
    },
  
    get: async (ctx, key) => {
      const userId = getUserId(ctx);
      
      const result = await studentService.verifyStudentAccess(String(key), userId);
      if (!result.hasAccess || !result.student) return undefined;
  
      return {
        ...toMemoryValue(result.student),
        link: result.link ? toMemoryValue(result.link) : undefined,
      };
    },
  
    add: async (ctx, value) => {
      const userId = getUserId(ctx);
      const instituteId = ctx.all.instituteId as string | undefined;

      // Resolve institute IDs: prefer explicit list, fall back to selected, then user's only one
      let enrollInstituteIds: string[] = [];
      if (value.instituteIds && Array.isArray(value.instituteIds) && value.instituteIds.length > 0) {
        enrollInstituteIds = value.instituteIds;
      } else if (instituteId) {
        enrollInstituteIds = [instituteId];
      } else {
        const userInstitutes = await instituteService.getUserInstitutesWithMembership(userId);
        if (userInstitutes.length === 1) {
          enrollInstituteIds = [userInstitutes[0].institute.id];
        }
      }

      if (enrollInstituteIds.length === 0) {
        throw new Error("At least one institute is required to create a student. The user has no institute selected.");
      }

      // Validate ALL institute IDs upfront before creating anything:
      // user must be a member of every institute being assigned
      for (const instId of enrollInstituteIds) {
        if (typeof instId !== 'string' || !instId) {
          throw new Error("Invalid institute ID provided.");
        }
        const isMember = await instituteRepository.isUserMemberOfInstitute(instId, userId);
        if (!isMember) {
          throw new Error(`Access denied: you are not a member of institute ${instId}.`);
        }
      }

      // Check license student limits per institute
      for (const instId of enrollInstituteIds) {
        const instituteLicenses = await licenseRepository.getLicensesByInstituteId(instId);
        const activeLicense = instituteLicenses.find(l => l.isActive && l.permissions);
        const perms = activeLicense ? resolvePermissions(activeLicense.permissions as Partial<LicensePermissions>) : null;

        if (perms) {
          if (perms.maxStudents === 0) {
            throw new Error("Your license does not allow adding students.");
          }
          if (perms.maxStudents !== -1) {
            const studentsResult = await instituteService.getInstituteStudents(instId, userId);
            const currentCount = studentsResult.students?.length ?? 0;
            if (currentCount >= perms.maxStudents) {
              throw new Error(`Student limit reached for this institute (${currentCount}/${perms.maxStudents}). Upgrade to add more.`);
            }
          }
        }
      }

      const { student, link } = await studentService.createStudentWithLink(
        {
          name: value.name,
          firstName: value.firstName,
          lastName: value.lastName,
          gender: value.gender,
          birthDate: value.birthDate,
          framework: value.framework,
          country: value.country,
          primaryLanguage: value.primaryLanguage,
          additionalLanguages: value.additionalLanguages,
        },
        userId,
        "owner"
      );

      // Enroll in all validated institutes
      for (const instId of enrollInstituteIds) {
        await instituteService.assignStudentToInstitute(instId, student.id, userId);
      }

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "create",
        subjectType1: "student",
        subjectId1: student.id,
        isAiInitiated: true,
      });

      return {
        ...toMemoryValue(student),
        link: toMemoryValue(link),
      };
    },

    update: async (ctx, key, value) => {
      const student = await studentService.updateStudent(String(key), value);
      if (!student) throw new Error("Failed to update student");

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "update",
        subjectType1: "student",
        subjectId1: String(key),
        isAiInitiated: true,
      });

      return toMemoryValue(student);
    },

    delete: async (ctx, key) => {
      throw new Error("AI is not allowed to delete students directly. User must delete the student manually.");
      const deleted = await studentService.deleteStudent(String(key));
      if (!deleted) throw new Error("Failed to delete student");
    },
  
    fromDB: (record) => ({
      ...toMemoryValue(record),
      aacSettings: {},
      users: {},
      institutes: [],
      classrooms: [],
    }),
  
    extractChildContext: (value, key) => ({
      // Use value.id if available, otherwise use the key as fallback
      studentId: value?.id || (typeof key === 'string' ? key : undefined),
    }),

    getDBKey: (value) => value?.id,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - STUDENT USERS (Users linked to a student)
  // ============================================================================
  
  /**
   * Student users operations (MAP) - users linked to a student
   */
  /**
   * Verify the requesting user is an admin of a school/clinic institute (required for link operations).
   * Returns the validated instituteId.
   */
  async function requireInstituteAdmin(ctx: DBOperationContext): Promise<string> {
    const userId = getUserId(ctx);
    const selectedInstituteId = ctx.all.instituteId as string | undefined;
    if (!selectedInstituteId) {
      throw new Error("An institute must be selected to manage user-student links.");
    }
    const institute = await instituteRepository.getInstituteById(selectedInstituteId);
    if (!institute || (institute.type !== 'school' && institute.type !== 'clinic')) {
      throw new Error("User-student links can only be managed within a school or clinic.");
    }
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(selectedInstituteId, userId);
    if (!isAdmin) {
      throw new Error("Only institute admins can manage user-student links.");
    }
    return selectedInstituteId;
  }

  const studentUsersOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");

      const links = await studentService.getUsersLinkedToStudent(studentId);

      const paged = links.slice(offset, offset + limit);
      const items = paged.map(link => toMemoryValue(link));
      const keys = paged.map(link => link.userId);

      return {
        items,
        total: links.length,
        keys,
      };
    },

    add: async (ctx, value) => {
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");

      const selectedInstituteId = await requireInstituteAdmin(ctx);

      // Target user must be a member of the same institute
      const targetUserId = value.userId;
      if (!targetUserId) throw new Error("userId required");
      const targetIsMember = await instituteRepository.isUserMemberOfInstitute(selectedInstituteId, targetUserId);
      if (!targetIsMember) {
        throw new Error("The target user is not a member of the selected institute.");
      }

      const link = await studentService.linkUserToStudent(
        targetUserId,
        studentId,
        value.role || "caregiver"
      );

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "link",
        subjectType1: "student",
        subjectId1: studentId,
        subjectType2: "user",
        subjectId2: targetUserId,
        isAiInitiated: true,
      });

      return toMemoryValue(link);
    },

    update: async (ctx, key, value) => {
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");

      await requireInstituteAdmin(ctx);

      const link = await studentService.getUserStudentLink(String(key), studentId);
      if (!link) throw new Error("Link not found");

      const updated = await studentService.updateUserStudentLink(link.id, value);
      if (!updated) throw new Error("Failed to update link");

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "update",
        subjectType1: "student",
        subjectId1: studentId,
        subjectType2: "user",
        subjectId2: String(key),
        isAiInitiated: true,
      });

      return toMemoryValue(updated);
    },

    delete: async (ctx, key) => {
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");

      await requireInstituteAdmin(ctx);

      // Cannot unlink the owner
      const targetLink = await studentService.getUserStudentLink(String(key), studentId);
      if (targetLink?.role === "owner") {
        throw new Error("Cannot unlink the student's owner.");
      }

      const removed = await studentService.unlinkUserFromStudent(String(key), studentId);
      if (!removed) throw new Error("Failed to remove link");

      activityLogService.log({
        instituteId: ctx.all.instituteId,
        userId: getUserId(ctx),
        eventType: "unlink",
        subjectType1: "student",
        subjectId1: studentId,
        subjectType2: "user",
        subjectId2: String(key),
        isAiInitiated: true,
      });
    },

    fromDB: (record) => toMemoryValue(record),

    getDBKey: (value) => value?.userId,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - STUDENT INSTITUTES (Institutes a student belongs to)
  // ============================================================================
  
  /**
   * Student institutes operations (ARRAY) - institutes a student is enrolled in
   */
  const studentInstitutesOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");
  
      const result = await instituteService.getStudentInstitutes(studentId, userId);
      if (!result.success || !result.institutes) {
        throw new Error(result.error || "Failed to get student institutes");
      }
  
      const paged = result.institutes.slice(offset, offset + limit);
      const items = paged.map(({ institute, enrollment }) => ({
        institute: toMemoryValue(institute),
        enrollment: toEnrollmentMemoryValue(enrollment),
      }));

      return {
        items,
        total: result.institutes.length,
      };
    },

    fromDB: (record) => ({
      institute: record?.institute ? toMemoryValue(record.institute) : undefined,
      enrollment: record?.enrollment ? toEnrollmentMemoryValue(record.enrollment) : undefined,
    }),
  
    getDBKey: (value) => value?.institute?.id || value?.enrollment?.instituteId,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - STUDENT CLASSROOMS (Classrooms a student is enrolled in)
  // ============================================================================
  
  /**
   * Student classrooms operations (ARRAY) - classrooms a student is enrolled in
   */
  const studentClassroomsOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");
  
      const classroomsWithEnrollment = await classroomService.getStudentClassrooms(studentId);
      
      const paged = classroomsWithEnrollment.slice(offset, offset + limit);
      const items = paged.map(({ classroom, enrollment }) => ({
        classroom: toMemoryValue(classroom),
        enrollment: toMemoryValue(enrollment),
      }));
  
      return {
        items,
        total: classroomsWithEnrollment.length,
      };
    },

    /**
     * Get a specific classroom enrollment by index
     * The key is the array index, we need to fetch all and return the one at that index
     */
    get: async (ctx, key): Promise<any> => {
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");

      const classroomsWithEnrollment = await classroomService.getStudentClassrooms(studentId);
      const index = typeof key === 'number' ? key : parseInt(String(key), 10);
      
      if (isNaN(index) || index < 0 || index >= classroomsWithEnrollment.length) {
        return undefined;
      }

      const { classroom, enrollment } = classroomsWithEnrollment[index];
      return {
        classroom: toMemoryValue(classroom),
        enrollment: toMemoryValue(enrollment),
      };
    },

    /**
     * Add a student to a classroom
     * 
     * Value should contain:
     * - classroomId: The classroom to add the student to (REQUIRED)
     * - isPrimary: Whether this is the primary classroom (optional)
     * - enrollmentDate: Enrollment date (optional)
     * - notes: Notes about the enrollment (optional)
     */
    add: async (ctx, value, options): Promise<any> => {
      const userId = getUserId(ctx);
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");

      // Get classroomId from value or options.key
      const classroomId = value?.classroomId || value?.classroom?.id || options?.key;
      if (!classroomId) {
        throw new Error("classroomId required - provide in value.classroomId or value.classroom.id");
      }

      const result = await classroomService.addStudentToClassroom(
        studentId,
        classroomId,
        userId,
        {
          isPrimary: value?.isPrimary ?? value?.enrollment?.isPrimary,
          enrollmentDate: value?.enrollmentDate ?? value?.enrollment?.enrollmentDate,
          notes: value?.notes ?? value?.enrollment?.notes,
        }
      );

      if (!result.success || !result.enrollment) {
        throw new Error(result.error || "Failed to add student to classroom");
      }

      // Fetch the classroom details
      const classroom = await classroomService.getClassroomById(classroomId);

      return {
        classroom: classroom ? toMemoryValue(classroom) : { id: classroomId },
        enrollment: toMemoryValue(result.enrollment),
      };
    },

    /**
     * Remove a student from a classroom
     * 
     * Key can be:
     * - Array index (number) - removes the enrollment at that index
     * - Classroom ID (string) - removes the enrollment for that classroom
     */
    delete: async (ctx, key): Promise<void> => {
      const userId = getUserId(ctx);
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");

      let classroomId: string;

      // If key is a number or looks like an index, we need to look up the classroom
      const keyAsNumber = typeof key === 'number' ? key : parseInt(String(key), 10);
      
      if (!isNaN(keyAsNumber) && keyAsNumber >= 0) {
        // Key is an index - fetch all classrooms and get the one at that index
        const classroomsWithEnrollment = await classroomService.getStudentClassrooms(studentId);
        
        if (keyAsNumber >= classroomsWithEnrollment.length) {
          throw new Error(`Invalid classroom index: ${key}. Student is only in ${classroomsWithEnrollment.length} classroom(s).`);
        }
        
        classroomId = classroomsWithEnrollment[keyAsNumber].classroom.id;
      } else {
        // Key is a classroom ID
        classroomId = String(key);
      }

      const result = await classroomService.removeStudentFromClassroom(
        studentId,
        classroomId,
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to remove student from classroom");
      }
    },

    /**
     * Update enrollment details (e.g., isPrimary, notes)
     */
    update: async (ctx, key, value): Promise<any> => {
      const userId = getUserId(ctx);
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");

      let classroomId: string;

      // If key is a number or looks like an index, we need to look up the classroom
      const keyAsNumber = typeof key === 'number' ? key : parseInt(String(key), 10);
      
      if (!isNaN(keyAsNumber) && keyAsNumber >= 0) {
        // Key is an index
        const classroomsWithEnrollment = await classroomService.getStudentClassrooms(studentId);
        
        if (keyAsNumber >= classroomsWithEnrollment.length) {
          throw new Error(`Invalid classroom index: ${key}`);
        }
        
        classroomId = classroomsWithEnrollment[keyAsNumber].classroom.id;
      } else {
        // Key is a classroom ID
        classroomId = String(key);
      }

      const result = await classroomService.updateStudentEnrollment(
        studentId,
        classroomId,
        { 
          isPrimary: value?.isPrimary ?? value?.enrollment?.isPrimary, 
          notes: value?.notes ?? value?.enrollment?.notes 
        },
        userId
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to update enrollment");
      }

      const classroom = await classroomService.getClassroomById(classroomId);
      
      return {
        classroom: classroom ? toMemoryValue(classroom) : { id: classroomId },
        enrollment: result.enrollment ? toMemoryValue(result.enrollment) : undefined,
      };
    },
  
    fromDB: (record) => ({
      classroom: record?.classroom ? toMemoryValue(record.classroom) : undefined,
      enrollment: record?.enrollment ? toMemoryValue(record.enrollment) : undefined,
    }),
  
    getDBKey: (value) => value?.classroom?.id || value?.enrollment?.classroomId,

    /**
     * Extract context for child operations
     */
    extractChildContext: (value, key) => ({
      classroomId: value?.classroom?.id || value?.enrollment?.classroomId,
    }),
  };

  
  // ============================================================================
  // MEMORY FIELD SCHEMAS
  // ============================================================================
  
  /**
   * Institute invite schema (map value)
   */
  const instituteInviteSchema: AgentMemoryFieldObjectWithDB = {
    id: "instituteInvite",
    type: "object",
    opened: false,
    properties: {
      id: { id: "id", type: "string" },
      inviteeEmail: { id: "inviteeEmail", type: "string", description: "Email address of the person being invited" },
      role: {
        id: "role",
        type: "string",
        enum: ["admin", "director", "teacher", "therapist", "aide", "staff", "observer"],
        default: "staff",
      },
      grantAdmin: { id: "grantAdmin", type: "boolean", default: false },
      message: { id: "message", type: "string", description: "Optional message to include in the invite" },
      status: {
        id: "status",
        type: "string",
        enum: ["pending", "accepted", "declined", "expired", "cancelled"],
      },
      expiresAt: { id: "expiresAt", type: "string", format: "ISO datetime" },
    },
    required: ["inviteeEmail"],
  };
  
  /**
   * Institute member schema (map value)
   */
  const instituteMemberSchema: AgentMemoryFieldObjectWithDB = {
    id: "instituteMember",
    type: "object",
    opened: false,
    properties: {
      user: {
        id: "user",
        type: "object",
        properties: {
          id: { id: "id", type: "string" },
          email: { id: "email", type: "string" },
          firstName: { id: "firstName", type: "string" },
          lastName: { id: "lastName", type: "string" },
          fullName: { id: "fullName", type: "string" },
          userType: { id: "userType", type: "string" },
        },
      },
      membership: {
        id: "membership",
        type: "object",
        properties: {
          role: {
            id: "role",
            type: "string",
            enum: ["admin", "director", "teacher", "therapist", "aide", "staff", "observer"],
          },
          isAdmin: { id: "isAdmin", type: "boolean" },
          isActive: { id: "isActive", type: "boolean" },
        },
      },
    },
  };
  
  /**
   * Institute student enrollment schema (map value)
   */
  const instituteStudentSchema: AgentMemoryFieldObjectWithDB = {
    id: "instituteStudent",
    type: "object",
    opened: false,
    properties: {
      student: {
        id: "student",
        type: "object",
        properties: {
          id: { id: "id", type: "string" },
          name: { id: "name", type: "string" },
          firstName: { id: "firstName", type: "string" },
          lastName: { id: "lastName", type: "string" },
          gender: { id: "gender", type: "string", enum: ["male", "female", "other"] },
          birthDate: { id: "birthDate", type: "string", format: "YYYY-MM-DD" },
        },
      },
      enrollment: {
        id: "enrollment",
        type: "object",
        properties: {
          enrollmentDate: { id: "enrollmentDate", type: "string", format: "YYYY-MM-DD" },
          exitDate: { id: "exitDate", type: "string", format: "YYYY-MM-DD" },
          grade: {
            id: "grade",
            type: "string",
            enum: ["pre_k", "k", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "special_ed", "adult_ed"],
          },
          idNumber: { id: "idNumber", type: "string", description: "WRITE-ONLY: student ID number within the institute. On read this is shown as \"[REDACTED]\" when an ID is on file (otherwise null) — you can tell whether one exists, but never the actual digits. You MAY set/update this when enrolling or updating a student. Do NOT ask the student or user to provide an ID number — only record one if it has been provided proactively by an authorized adult. Never echo the literal string \"[REDACTED]\" as a write — it is treated as a no-op." },
          isActive: { id: "isActive", type: "boolean" },
        },
      },
      studentId: { id: "studentId", type: "string", description: "The student's ID. When adding, provide this as the 'key' parameter OR in value.studentId" },
    },
  };
  
  /**
   * Classroom member schema (map value)
   */
  const classroomMemberSchema: AgentMemoryFieldObjectWithDB = {
    id: "classroomMember",
    type: "object",
    opened: false,
    properties: {
      user: {
        id: "user",
        type: "object",
        properties: {
          id: { id: "id", type: "string" },
          email: { id: "email", type: "string" },
          firstName: { id: "firstName", type: "string" },
          lastName: { id: "lastName", type: "string" },
          fullName: { id: "fullName", type: "string" },
        },
      },
      membership: {
        id: "membership",
        type: "object",
        properties: {
          role: {
            id: "role",
            type: "string",
            enum: ["lead_teacher", "co_teacher", "therapist", "aide", "observer"],
          },
          isPrimary: { id: "isPrimary", type: "boolean" },
          isActive: { id: "isActive", type: "boolean" },
        },
      },
      userId: { id: "userId", type: "string", description: "The user's ID. When adding, provide this as the 'key' parameter OR in value.userId" },
      role: { id: "role", type: "string", description: "Role for the classroom membership" },
      isPrimary: { id: "isPrimary", type: "boolean", description: "Is this the primary classroom assignment?" },
    },
  };
  
  /**
   * Classroom student enrollment schema (map value)
   */
  const classroomStudentSchema: AgentMemoryFieldObjectWithDB = {
    id: "classroomStudent",
    type: "object",
    opened: false,
    properties: {
      student: {
        id: "student",
        type: "object",
        properties: {
          id: { id: "id", type: "string" },
          name: { id: "name", type: "string" },
          firstName: { id: "firstName", type: "string" },
          lastName: { id: "lastName", type: "string" },
        },
      },
      enrollment: {
        id: "enrollment",
        type: "object",
        properties: {
          isPrimary: { id: "isPrimary", type: "boolean", description: "Is this the primary/homeroom classroom?" },
          enrollmentDate: { id: "enrollmentDate", type: "string", format: "YYYY-MM-DD" },
          exitDate: { id: "exitDate", type: "string", format: "YYYY-MM-DD" },
          notes: { id: "notes", type: "string" },
          isActive: { id: "isActive", type: "boolean" },
        },
      },
      studentId: { id: "studentId", type: "string", description: "The student's ID. When adding, provide this as the 'key' parameter OR in value.studentId" },
      isPrimary: { id: "isPrimary", type: "boolean", description: "Is this the student's primary/homeroom classroom?" },
      enrollmentDate: { id: "enrollmentDate", type: "string", description: "Date student was enrolled (YYYY-MM-DD)" },
      notes: { id: "notes", type: "string", description: "Notes about the enrollment" },
    },
  };
  
  /**
   * Classroom schema (map value)
   */
  const classroomSchema: AgentMemoryFieldObjectWithDB = {
    id: "classroom",
    type: "object",
    properties: {
      id: { id: "id", type: "string" },
      name: { id: "name", type: "string" },
      grade: {
        id: "grade",
        type: "string",
        enum: ["pre_k", "k", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "special_ed", "adult_ed"],
      },
      description: { id: "description", type: "string" },
      capacity: { id: "capacity", type: "integer" },
      roomNumber: { id: "roomNumber", type: "string" },
      academicYear: { id: "academicYear", type: "string", description: "e.g., '2024-2025'" },
      isActive: { id: "isActive", type: "boolean" },
      members: {
        id: "members",
        type: "map",
        title: "Classroom Members",
        description: "Users assigned to this classroom. Keys are user UUIDs. To add a user, use their UUID as the 'key' parameter.",
        values: classroomMemberSchema,
        db: classroomMembersOps,
      } as AgentMemoryFieldMapWithDB,
      students: {
        id: "students",
        type: "map",
        title: "Classroom Students",
        description: "Students enrolled in this classroom. Keys are student UUIDs. To add a student, use their UUID as the 'key' parameter.",
        values: classroomStudentSchema,
        db: classroomStudentsOps,
      } as AgentMemoryFieldMapWithDB,
    },
    required: ["name"],
  };
  
  /**
   * Institute schema (map value)
   */
  const instituteSchema: AgentMemoryFieldObjectWithDB = {
    id: "institute",
    type: "object",
    properties: {
      id: { id: "id", type: "string" },
      name: { id: "name", type: "string" },
      type: {
        id: "type",
        type: "string",
        enum: ["school", "clinic"],
        description: "Type of institute. Classrooms are only available for schools.",
      },
      description: { id: "description", type: "string" },
      address: { id: "address", type: "string" },
      phone: { id: "phone", type: "string" },
      email: { id: "email", type: "string" },
      website: { id: "website", type: "string" },
      isActive: { id: "isActive", type: "boolean" },
      language: { id: "language", type: "string", description: "Primary language of the institute (e.g., 'en', 'he')" },
      membership: {
        id: "membership",
        type: "object",
        description: "The current user's membership in this institute",
        properties: {
          role: { id: "role", type: "string" },
          isAdmin: { id: "isAdmin", type: "boolean" },
          isActive: { id: "isActive", type: "boolean" },
        },
      },
      members: {
        id: "members",
        type: "map",
        title: "Institute Members",
        description: "Users who are members of this institute (keyed by userId)",
        values: instituteMemberSchema,
        db: instituteMembersOps,
      } as AgentMemoryFieldMapWithDB,
      students: {
        id: "students",
        type: "map",
        title: "Institute Students",
        description: "Students enrolled in this institute. Keys are student UUIDs (from student.id). To add a student, use their UUID as the 'key' parameter.",
        values: instituteStudentSchema,
        db: instituteStudentsOps,
      } as AgentMemoryFieldMapWithDB,
      classrooms: {
        id: "classrooms",
        type: "map",
        title: "Classrooms",
        description: "Classrooms in this institute. View to see available classrooms.",
        displayKey: "name",
        values: classroomSchema,
        db: classroomsOps,
      } as AgentMemoryFieldMapWithDB,
      invites: {
        id: "invites",
        type: "map",
        title: "Pending Invites",
        description: "Pending invitations to join this institute (keyed by inviteId)",
        values: instituteInviteSchema,
        db: instituteInvitesOps,
      } as AgentMemoryFieldMapWithDB,
    },
    required: ["name", "type"],
  };
  
  /**
   * User-Student link schema
   */
  const userStudentLinkSchema: AgentMemoryFieldObjectWithDB = {
    id: "userStudentLink",
    type: "object",
    opened: false,
    properties: {
      userId: { id: "userId", type: "string" },
      role: {
        id: "role",
        type: "string",
        enum: ["owner", "caregiver", "therapist", "teacher"],
        default: "caregiver",
        description:
          "System-access role granting this user login rights to the student's records. " +
          "This is NOT a relationship label — to record someone (parent, classmate, sibling, " +
          "outside therapist, etc.) as a person in the student's life, add a row to /Student_Contacts instead.",
      },
      hasEducationalRights: { id: "hasEducationalRights", type: "boolean", default: true },
      hasMedicalRights: { id: "hasMedicalRights", type: "boolean", default: true },
      isActive: { id: "isActive", type: "boolean" },
    },
    required: ["userId"],
  };
  
  /**
   * Student institute enrollment schema (array item)
   */
  const studentInstituteSchema: AgentMemoryFieldObjectWithDB = {
    id: "studentInstitute",
    type: "object",
    opened: false,
    properties: {
      institute: {
        id: "institute",
        type: "object",
        properties: {
          id: { id: "id", type: "string" },
          name: { id: "name", type: "string" },
          type: { id: "type", type: "string", enum: ["school", "clinic"] },
        },
      },
      enrollment: {
        id: "enrollment",
        type: "object",
        properties: {
          enrollmentDate: { id: "enrollmentDate", type: "string" },
          grade: { id: "grade", type: "string" },
          isActive: { id: "isActive", type: "boolean" },
        },
      },
    },
  };
  
  /**
   * Student classroom enrollment schema (array item)
   */
  const studentClassroomSchema: AgentMemoryFieldObjectWithDB = {
    id: "studentClassroom",
    type: "object",
    opened: false,
    properties: {
      classroom: {
        id: "classroom",
        type: "object",
        properties: {
          id: { id: "id", type: "string" },
          name: { id: "name", type: "string" },
          grade: { id: "grade", type: "string" },
        },
      },
      enrollment: {
        id: "enrollment",
        type: "object",
        properties: {
          isPrimary: { id: "isPrimary", type: "boolean" },
          enrollmentDate: { id: "enrollmentDate", type: "string" },
          isActive: { id: "isActive", type: "boolean" },
        },
      },
    },
  };
  
  // ============================================================================
  // AAC SETTINGS SCHEMA & DB OPS
  // ============================================================================

  const aacSettingsSchema: AgentMemoryFieldObjectWithDB = {
    id: "aacSettings",
    type: "object",
    description: "AAC system settings for this student. View to see current settings.",
    properties: {
      enabled: { id: "enabled", type: "boolean", description: "Whether AAC mode is enabled" },
      demoMode: { id: "demoMode", type: "boolean", description: "Demo scenario enabled" },
      demoScenario: { id: "demoScenario", type: "string", description: "Which demo scenario to use" },
      chatAgentPrompt: { id: "chatAgentPrompt", type: "array", items: { id: "rule", type: "string" }, description: "CUSTOM AAC prompt — a LIST of specific behaviors caretakers explicitly requested, one per entry (rigid; takes priority over the auto prompt except on safety)" },
      autoAacPrompt: { id: "autoAacPrompt", type: "array", items: { id: "note", type: "string" }, description: "AUTO AAC prompt — a LIST of AI-generated notes on what the AAC needs to know about this student, one per entry, kept current as new info is learned" },
      modelOverride: { id: "modelOverride", type: "string", description: "AI model override" },
      startupMode: {
        id: "startupMode",
        type: "integer",
        description: "Session startup mode: 0 = quick (default; reuses cached session-plan sections when the student's data/schedule haven't changed — fastest startup), 1 = thorough (regenerates the full session plan fresh every session).",
        minimum: 0,
        maximum: 1,
      },
      voiceType: { id: "voiceType", type: "string", enum: ["auto", "man", "woman", "boy", "girl"], description: "AI voice type" },
      studentVoiceType: { id: "studentVoiceType", type: "string", enum: ["man", "woman", "boy", "girl"], description: "Student's voice type" },
      customVoiceId: { id: "customVoiceId", type: "string", description: "Custom AI voice ID (ElevenLabs)" },
      customStudentVoiceId: { id: "customStudentVoiceId", type: "string", description: "Custom student voice ID (ElevenLabs)" },
      iconTextRatio: {
        id: "iconTextRatio",
        type: "integer",
        description: "Icon-to-text size ratio (1=mostly icon, 5=mostly text)",
        minimum: 1,
        maximum: 5,
      },
      usePcsSymbols: { id: "usePcsSymbols", type: "boolean", description: "Use PCS symbols instead of emoji" },
      signLanguage: { id: "signLanguage", type: "string", description: "Sign language code to recognize ('asl', 'isr'); null/empty disables" },
      multiCameraMode: { id: "multiCameraMode", type: "boolean", description: "Multi-camera support" },
      eyegazeEnabled: { id: "eyegazeEnabled", type: "boolean", description: "Dwell-based symbol selection enabled" },
      eyegazeTimeout: {
        id: "eyegazeTimeout",
        type: "integer",
        description: "Dwell time in ms",
        minimum: 1000,
        maximum: 10000,
      },
      eyegazeProvider: {
        id: "eyegazeProvider",
        type: "string",
        enum: ["auto", "camera", "tobii", "eyetech", "lctech", "webhid", "mouse"],
        description: "Eyegaze tracking provider",
      },
    },
  };

  const aacSettingsExclude = ["id", "studentId", "createdAt", "updatedAt", "knownPeople"];

  const aacSettingsOps: MemoryDBOperations<any> = {
    read: async (ctx) => {
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");
      const settings = await aacSettingsRepository.getByStudentId(studentId);
      return settings ? toMemoryValue(settings, aacSettingsExclude) : undefined;
    },

    write: async (ctx, value) => {
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");
      const updated = await aacSettingsRepository.upsert(studentId, value);
      return toMemoryValue(updated, aacSettingsExclude);
    },

    update: async (ctx, _key, value) => {
      const studentId = ctx.all.studentId;
      if (!studentId) throw new Error("studentId required");
      const updated = await aacSettingsRepository.upsert(studentId, value);
      return toMemoryValue(updated, aacSettingsExclude);
    },
  };

  // Attach DB ops to the schema
  (aacSettingsSchema as any).db = aacSettingsOps;

  // ============================================================================
  // STUDENT SCHEMA
  // ============================================================================

  /**
   * Student schema (map value)
   */
  const studentSchema: AgentMemoryFieldObjectWithDB = {
    id: "student",
    type: "object",
    required: ["firstName", "instituteIds", "name"],
    properties: {
      id: { id: "id", type: "string" },
      name: { id: "name", type: "string" },
      firstName: { id: "firstName", type: "string" },
      lastName: { id: "lastName", type: "string" },
      gender: { id: "gender", type: "string", enum: ["male", "female", "other"] },
      birthDate: { id: "birthDate", type: "string", format: "YYYY-MM-DD" },
      framework: {
        id: "framework",
        type: "string",
        enum: ["tala", "us_iep"],
        description: "Educational framework: TALA (Israel) or US IEP",
      },
      country: { id: "country", type: "string", enum: ["IL", "US"], default: "IL", description: "IL (Israel) or US (United States)" },
      primaryLanguage: { id: "primaryLanguage", type: "string", enum: ["he", "en", "es", "pt", "fr", "ru", "de", "ar", "zh", "yue", "ko"], default: "he", description: "Language code: he, en, es, pt, fr, ru, de, ar, zh, yue, ko" },
      additionalLanguages: {
        id: "additionalLanguages",
        type: "array",
        items: { id: "language", type: "string" },
      },
      instituteIds: {
        id: "instituteIds",
        type: "array",
        items: { id: "instituteId", type: "string" },
        description: "Institute IDs to enroll this student in (from Context_Institutes). Required — use the currently selected institute if only one.",
      },
      isActive: { id: "isActive", type: "boolean" },
      link: {
        id: "link",
        type: "object",
        description: "The current user's relationship with this student",
        properties: {
          role: { id: "role", type: "string" },
          hasEducationalRights: { id: "hasEducationalRights", type: "boolean" },
          hasMedicalRights: { id: "hasMedicalRights", type: "boolean" },
          isActive: { id: "isActive", type: "boolean" },
        },
      },
      aacSettings: aacSettingsSchema as AgentMemoryFieldObjectWithDB,
      users: {
        id: "users",
        type: "map",
        title: "Linked Users",
        description:
          "Registered platform users who have system login access to this student's records, " +
          "keyed by userId. This is an authorization grant, NOT a contact list — only add an " +
          "entry here if the person already has a user account and needs to sign in to access " +
          "the student. To record people in the student's life (parents, siblings, classmates, " +
          "therapists, teachers), use /Student_Contacts instead. If a contact also happens to " +
          "have a user account, the two are connected by setting linkedUserId on the contact.",
        values: userStudentLinkSchema,
        db: studentUsersOps,
      } as AgentMemoryFieldMapWithDB,
      institutes: {
        id: "institutes",
        type: "array",
        title: "Institutes",
        description: "Institutes this student belongs to",
        items: studentInstituteSchema,
        db: studentInstitutesOps,
      } as AgentMemoryFieldArrayWithDB,
      classrooms: {
        id: "classrooms",
        type: "array",
        title: "Classrooms",
        description: "Classrooms this student is enrolled in",
        items: studentClassroomSchema,
        db: studentClassroomsOps,
      } as AgentMemoryFieldArrayWithDB,
    },
  };

  // ============================================================================
  // MAIN INSTITUTE MEMORY FIELDS
  // ============================================================================
  
  /**
   * Institutes map - the main entry point for institute management
   */
  export const INSTITUTE_INSTITUTES_FIELD: AgentMemoryFieldMapWithDB = {
    id: "Context_Institutes",
    type: "map",
    title: "Institutes",
    description: "Organizations (schools or clinics) that the user is a member of. Target entries by name. " +
      "Institute records themselves are READ-ONLY (provisioned with licenses by administrators) — " +
      "you can manage their members, students, and classrooms, but never create, edit, or delete the institute itself.",
    opened: true,
    displayKey: "name",
    values: instituteSchema,
    db: institutesOps,
  };

  /**
   * Students map - students the user has access to
   */
  export const INSTITUTE_STUDENTS_FIELD: AgentMemoryFieldMapWithDB = {
    id: "Context_Students",
    type: "map",
    title: "Students",
    description: "Students (AAC users) that the user has access to. Target entries by first name.",
    opened: true,
    displayKey: "firstName",
    values: studentSchema,
    db: studentsOps,
  };
  
  // ============================================================================
  // DATABASE OPERATIONS - LOCATIONS
  // ============================================================================

  const locationOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);
      const selected = ctx.all.instituteId as string | undefined;

      // Scope to the selected institute when present; otherwise gather across
      // every institute the user belongs to.
      let locs: any[] = [];
      if (selected) {
        locs = (await locationService.listForInstitute(selected, userId)) ?? [];
      } else {
        const institutes = await instituteRepository.getInstitutesByUserId(userId);
        for (const inst of institutes) {
          const l = await locationService.listForInstitute(inst.id, userId);
          if (l) locs.push(...l);
        }
      }

      const paged = locs.slice(offset, offset + limit);
      return {
        items: paged.map((l) => toMemoryValue(l)),
        total: locs.length,
        keys: paged.map((l) => l.id),
      };
    },

    get: async (ctx, key) => {
      const userId = getUserId(ctx);
      const loc = await locationService.get(String(key), userId);
      return loc ? toMemoryValue(loc) : undefined;
    },

    add: async (ctx, value) => {
      const userId = getUserId(ctx);
      const instituteId = value.instituteId ?? (ctx.all.instituteId as string | undefined);
      if (!instituteId) {
        throw new Error("instituteId is required — use the currently selected organization or specify one from Context_Institutes.");
      }
      if (!value.title) throw new Error("A location needs a title.");

      // Auto-geocode: if the AI gave an address but no explicit coordinates,
      // look the coordinates up from the address.
      let { latitude, longitude } = value;
      if ((latitude == null || longitude == null) && value.address) {
        const geo = await locationService.geocodeAddress(value.address);
        if (!geo) {
          throw new Error(`Could not find GPS coordinates for the address "${value.address}". Provide a clearer/more complete address, or set latitude and longitude explicitly.`);
        }
        latitude = geo.lat;
        longitude = geo.lng;
      }
      if (latitude == null || longitude == null) {
        throw new Error("A location needs either an address (which is geocoded automatically) or explicit latitude and longitude.");
      }

      const created = await locationService.create(
        { instituteId, title: value.title, address: value.address ?? null, latitude, longitude },
        userId,
      );
      if (!created) throw new Error("Not permitted to add a location to this organization (you must be a member).");
      return toMemoryValue(created);
    },

    update: async (ctx, key, value) => {
      const userId = getUserId(ctx);
      const id = String(key);

      const updates: Record<string, any> = {};
      if (value.title !== undefined) updates.title = value.title;
      if (value.address !== undefined) updates.address = value.address;
      if (value.isActive !== undefined) updates.isActive = value.isActive;

      // Re-geocode when the address changes and no explicit coordinates were
      // supplied alongside it.
      if (value.address !== undefined && value.address && value.latitude === undefined && value.longitude === undefined) {
        const geo = await locationService.geocodeAddress(value.address);
        if (!geo) {
          throw new Error(`Could not find GPS coordinates for the address "${value.address}". Provide a clearer address, or set latitude and longitude explicitly.`);
        }
        updates.latitude = geo.lat;
        updates.longitude = geo.lng;
      }
      if (value.latitude !== undefined) updates.latitude = value.latitude;
      if (value.longitude !== undefined) updates.longitude = value.longitude;

      const updated = await locationService.update(id, updates, userId);
      if (!updated) throw new Error("Location not found or you are not permitted to edit it.");
      return toMemoryValue(updated);
    },

    delete: async (ctx, key) => {
      const userId = getUserId(ctx);
      const ok = await locationService.remove(String(key), userId);
      if (!ok) throw new Error("Location not found or you are not permitted to delete it.");
    },

    fromDB: (record) => toMemoryValue(record),
    getDBKey: (value) => value?.id,
  };

  const locationSchema: AgentMemoryFieldObjectWithDB = {
    id: "location",
    type: "object",
    properties: {
      id: { id: "id", type: "string" },
      title: { id: "title", type: "string", description: "Display name of the place (e.g. 'Downtown Clinic', 'Lincoln Elementary', 'Music Therapy Room')." },
      address: { id: "address", type: "string", description: "Street address. When you set or change this, the server AUTOMATICALLY looks up the GPS coordinates — you do NOT need to provide latitude/longitude yourself." },
      latitude: { id: "latitude", type: "number", description: "GPS latitude. Normally filled in automatically from the address; only set it manually to override the lookup." },
      longitude: { id: "longitude", type: "number", description: "GPS longitude. Normally filled in automatically from the address; only set it manually to override the lookup." },
      instituteId: { id: "instituteId", type: "string", description: "The organization this place belongs to (from Context_Institutes). Defaults to the currently selected organization." },
    },
    required: ["title"],
  };

  export const INSTITUTE_LOCATIONS_FIELD: AgentMemoryFieldMapWithDB = {
    id: "Context_Locations",
    type: "map",
    title: "Locations",
    description:
      "Physical places (GPS points) registered to your organizations — clinics, schools, therapy rooms, etc. " +
      "To add a place, give it a title and an address; the server geocodes the address into GPS coordinates automatically (editing the address re-geocodes it). " +
      "Assign places to calendar events via the event's locationIds field — this lets the system tell when a student is physically at an event.",
    opened: true,
    displayKey: "title",
    values: locationSchema,
    db: locationOps,
  };

  // ============================================================================
  // DATABASE OPERATIONS - CALENDAR EVENTS
  // ============================================================================

  const calendarOps: MemoryDBOperations<any> = {
    list: async (ctx, { offset, limit }): Promise<ListResult<any>> => {
      const userId = getUserId(ctx);

      // Show events for the next 90 days
      const startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 90);

      // Visibility per calendar-plan.md: applies selected-institute gating,
      // the student-path cross-institute leak, and student-service handling.
      const events = await calendarService.getEventsForUser(userId, startDate, endDate, {
        selectedStudentId: ctx.all.studentId as string | undefined,
        selectedInstituteId: ctx.all.instituteId as string | undefined,
      });

      // Strip participant list for events visible only via the selected student
      const reduced = await calendarService.applyReducedView(events, userId, {
        selectedStudentId: ctx.all.studentId as string | undefined,
        selectedInstituteId: ctx.all.instituteId as string | undefined,
      });

      // Expand recurring events into individual occurrences with concrete dates
      const expanded = calendarRepository.expandRecurringEvents(reduced, startDate, endDate);

      const paged = expanded.slice(offset, offset + limit);
      // Index reduced-view flag by event id so we can include it per occurrence
      const reducedById = new Map(reduced.map((e) => [e.id, (e as any).reducedView === true]));
      return {
        items: paged.map(({ event, date }) => ({
          ...toMemoryValue(event),
          occurrenceDate: date.toISOString(),
          // Include the requesting user's RSVP status, if any.
          myInviteStatus: (event as any).attendees?.find(
            (a: any) => a.attendeeType === "user" && a.attendeeId === userId,
          )?.inviteStatus ?? null,
          locationIds: ((event as any).locations ?? []).map((l: any) => l.id),
          reducedView: reducedById.get(event.id) === true || undefined,
        })),
        total: expanded.length,
        keys: paged.map(({ event }) => event.id),
      };
    },

    get: async (ctx, key) => {
      const userId = getUserId(ctx);
      const full = await calendarService.getEvent(String(key), userId);
      if (!full) return undefined;
      return {
        ...toMemoryValue(full),
        attendees: full.attendees.map((a) => toMemoryValue(a)),
        myInviteStatus:
          full.attendees.find((a) => a.attendeeType === "user" && a.attendeeId === userId)
            ?.inviteStatus ?? null,
        locationIds: (full.locations ?? []).map((l) => l.id),
      };
    },

    add: async (ctx, value) => {
      const userId = getUserId(ctx);
      const selectedInstituteId = ctx.all.instituteId as string | undefined;
      const tz = ctx.all.timezone as string | undefined;

      // Resolve the event's association FK: the AI can target an institute,
      // classroom, or service event. A plain (no association) event is
      // permitted. Per plan, only institute admins can create institute events.
      const instituteId = value.instituteId ?? undefined;
      const classroomId = value.classroomId ?? undefined;
      const serviceId = value.serviceId ?? undefined;

      if (instituteId) {
        const link = await instituteRepository.getInstituteUserLink(instituteId, userId);
        if (!link?.isAdmin) {
          throw new Error("Only institute admins can create institute events");
        }
      }

      const created = await calendarService.createEvent(
        {
          title: value.title,
          description: value.description,
          startTime: parseLocalOrIsoInTimezone(value.startTime, tz)!,
          endTime: parseLocalOrIsoInTimezone(value.endTime, tz)!,
          allDay: value.allDay ?? false,
          repeatType: value.repeatType ?? "none",
          repeatInterval: value.repeatInterval ?? 1,
          repeatDays: value.repeatDays,
          repeatMonthWeek: value.repeatMonthWeek,
          repeatEndDate: parseLocalOrIsoInTimezone(value.repeatEndDate, tz),
          instituteId,
          classroomId,
          serviceId,
        } as any,
        userId,
        Array.isArray(value.attendees)
          ? value.attendees
              .filter((a: any) => a?.attendeeType && a?.attendeeId)
              .map((a: any) => ({ attendeeType: a.attendeeType, attendeeId: a.attendeeId }))
          : undefined,
        Array.isArray(value.locationIds) ? value.locationIds.map(String) : undefined,
      );

      return { ...toMemoryValue(created), locationIds: (created.locations ?? []).map((l) => l.id) };
    },

    update: async (ctx, key, value) => {
      const userId = getUserId(ctx);
      const eventId = String(key);
      const tz = ctx.all.timezone as string | undefined;

      // RSVP is per-attendee, not part of the event row. Route it separately.
      if (value.myInviteStatus !== undefined && value.myInviteStatus !== null) {
        await calendarService.setRsvp(eventId, userId, value.myInviteStatus);
      }

      const updates: Record<string, any> = {};
      if (value.title !== undefined) updates.title = value.title;
      if (value.description !== undefined) updates.description = value.description;
      if (value.startTime !== undefined) updates.startTime = parseLocalOrIsoInTimezone(value.startTime, tz);
      if (value.endTime !== undefined) updates.endTime = parseLocalOrIsoInTimezone(value.endTime, tz);
      if (value.allDay !== undefined) updates.allDay = value.allDay;
      if (value.repeatType !== undefined) updates.repeatType = value.repeatType;
      if (value.repeatInterval !== undefined) updates.repeatInterval = value.repeatInterval;
      if (value.repeatDays !== undefined) updates.repeatDays = value.repeatDays;
      if (value.repeatMonthWeek !== undefined) updates.repeatMonthWeek = value.repeatMonthWeek;
      if (value.repeatEndDate !== undefined) updates.repeatEndDate = value.repeatEndDate ? parseLocalOrIsoInTimezone(value.repeatEndDate, tz) : null;

      // Skip the event-field update when only RSVP / locations changed.
      if (Object.keys(updates).length > 0) {
        const event = await calendarService.updateEvent(eventId, updates, userId);
        if (!event) throw new Error("Event not found or edit not permitted (creator or institute admin required)");
      }

      // Replace the event's assigned locations when provided (permission-checked).
      if (value.locationIds !== undefined) {
        const ok = await calendarService.setEventLocations(
          eventId,
          Array.isArray(value.locationIds) ? value.locationIds.map(String) : [],
          userId,
        );
        if (!ok) throw new Error("Not permitted to change this event's locations (creator or institute admin required).");
      }

      const fresh = await calendarService.getEvent(eventId, userId);
      return fresh ? { ...toMemoryValue(fresh), locationIds: (fresh.locations ?? []).map((l) => l.id) } : undefined;
    },

    delete: async (ctx, key) => {
      const userId = getUserId(ctx);
      const deleted = await calendarService.deleteEvent(String(key), userId);
      if (!deleted) throw new Error("Event not found or delete not permitted (creator or institute admin required)");
    },

    fromDB: (record) => toMemoryValue(record),
    getDBKey: (value) => value?.id,
  };

  const calendarEventSchema: AgentMemoryFieldObjectWithDB = {
    id: "event",
    type: "object",
    properties: {
      id: { id: "id", type: "string" },
      title: { id: "title", type: "string" },
      description: { id: "description", type: "string" },
      occurrenceDate: { id: "occurrenceDate", type: "string", format: "ISO 8601 datetime", description: "The actual date this occurrence falls on (accounts for recurrence expansion)." },
      startTime: { id: "startTime", type: "string", format: "ISO 8601 datetime", description: "Event start time. Provide the wall-clock LOCAL time as ISO 8601 WITHOUT a timezone suffix (e.g. \"2026-04-23T15:00:00\" for 3:00 PM local). The server interprets this in the user's time zone (see User Local Time section) and stores UTC. For recurring events, this is the first occurrence." },
      endTime: { id: "endTime", type: "string", format: "ISO 8601 datetime", description: "Event end time. Same local-wall-clock format as startTime (no timezone suffix)." },
      allDay: { id: "allDay", type: "boolean" },
      repeatType: { id: "repeatType", type: "string", enum: ["none", "daily", "weekly", "monthly_date", "monthly_weekday"], description: "'none'=one-time, 'daily'=every day, 'weekly'=specific days each week, 'monthly_date'=same date each month, 'monthly_weekday'=Nth weekday each month (e.g., 2nd Tuesday)." },
      repeatInterval: { id: "repeatInterval", type: "number", description: "For weekly: repeat every N weeks (1=every week, 2=every 2 weeks, etc). Default 1." },
      repeatDays: { id: "repeatDays", type: "array", items: { id: "day", type: "number" }, description: "For weekly: which days. 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat. Example: [1,3,5] for Mon/Wed/Fri." },
      repeatMonthWeek: { id: "repeatMonthWeek", type: "number", description: "For monthly_weekday: which occurrence. 1=first, 2=second, 3=third, -1=last. The weekday is taken from the event's start date." },
      repeatEndDate: { id: "repeatEndDate", type: "string", format: "ISO 8601 datetime", description: "When the recurring event stops repeating. Must be AFTER startTime — a series ending before it starts never occurs and is rejected." },
      instituteId: { id: "instituteId", type: "string", description: "If set, this is an institute-wide event. Only institute admins can create or edit events with this set." },
      classroomId: { id: "classroomId", type: "string", description: "If set, this is a classroom event. Only classroom members can create events with this set." },
      serviceId: { id: "serviceId", type: "string", description: "If set, links the event to a service in a student's program (therapy session, tutoring, etc.)." },
      myInviteStatus: { id: "myInviteStatus", type: "string", enum: ["pending", "accepted", "declined"], description: "The current user's RSVP status on this event. Updating this only changes the user's own attendee status, not the event itself." },
      locationIds: { id: "locationIds", type: "array", items: { id: "locationId", type: "string" }, description: "IDs of registered places (from Context_Locations) where this event happens. Set this to attach one or more locations; it lets the system detect when a student is physically at the event. Replaces the full set on update." },
    },
    required: ["title", "startTime", "endTime"],
  };

  export const INSTITUTE_CALENDAR_FIELD: AgentMemoryFieldMapWithDB = {
    id: "Context_Calendar",
    type: "map",
    title: "Calendar Events",
    description: "Calendar events for the next 90 days, with recurring events expanded into individual occurrences. Each entry has an occurrenceDate showing when it actually happens. Use Context_CalendarAlerts for today's priority events. " +
      "For recurring schedules: set startTime to the FIRST real occurrence — if the schedule is active now, start it today, not at a future term. " +
      "If a schedule spans two terms or school years, create a separate series per term.",
    opened: true,
    displayKey: "title",
    values: calendarEventSchema,
    db: calendarOps,
  };

  // ============================================================================
  // SYSTEM PROMPT FOR INSTITUTE MODE
  // ============================================================================
  
  export const INSTITUTE_SYSTEM_PROMPT = `
  You can manage educational organizations and students:
  
  **Organizations (Schools & Clinics)**
  - Institute records are READ-ONLY: they are provisioned with licenses by administrators
  - To change institute details (name, type, contact info), direct the user to institute settings
  - Manage institute members and their roles
  - Send invitations to new users via email
  - Enroll and manage students in institutes
  
  **Classrooms (Schools only)**
  - Create and manage classrooms within schools
  - Assign teachers and staff to classrooms
  - Enroll students in classrooms
  - Track primary/homeroom assignments
  
  **Students**
  - Create and manage student profiles
  - Link users (caregivers, therapists, teachers) to students
  - View student enrollments across institutes and classrooms
  
  **Important Rules**
  - Students can only be enrolled in ONE active school at a time
  - When enrolling a student in a new school, they are automatically transferred from their previous school
  - Students can be enrolled in multiple clinics simultaneously
  - Classrooms are only available for institutes of type "school"
  - Only institute admins can invite new members or remove existing ones

  **Privacy — ID numbers**
  - Never ask a student, parent, guardian, or any user to tell you their personal ID number, national ID, passport number, or any other private identification number.
  - If an authorized adult proactively supplies a student's institutional ID number (e.g. during enrollment), you MAY record it via the enrollment.idNumber field — but you cannot read it back afterward, and you must not repeat it aloud or in chat.
  - On read, idNumber appears as "[REDACTED]" when one is on file. Treat that as "an ID is already stored" — do not ask for a replacement, and never write back the literal "[REDACTED]" string.
  - Treat ID numbers as write-only data: capture when given, never request, never reveal.
  `;
  
  // ============================================================================
  // EXPORTS
  // ============================================================================
  
  /**
   * Get the complete memory fields for institute mode
   * Combines master memory fields with institute-specific fields
   */
  export function getInstituteMemoryFields(masterFields: AgentMemoryFieldWithDB[], includeCalendar?: boolean): AgentMemoryFieldWithDB[] {
    return [
      ...masterFields,
      INSTITUTE_INSTITUTES_FIELD,
      INSTITUTE_STUDENTS_FIELD,
      INSTITUTE_LOCATIONS_FIELD,
      ...(includeCalendar ? [INSTITUTE_CALENDAR_FIELD] : []),
    ];
  }