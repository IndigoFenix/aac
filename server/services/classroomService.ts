// server/services/classroomService.ts
// Business logic for classroom management

import { instituteRepository, classroomRepository } from "../repositories";
import {
  type Classroom,
  type InsertClassroom,
  type UpdateClassroom,
  type ClassroomUser,
  type StudentClassroom,
  type User,
  type Student,
} from "@shared/schema";

export class ClassroomService {
  // ==================== Classroom CRUD ====================

  /**
   * Create a new classroom (admin only)
   */
  async createClassroom(
    data: InsertClassroom,
    requestingUserId: string
  ): Promise<{ success: boolean; classroom?: Classroom; error?: string }> {
    // Verify the institute is a school
    const institute = await instituteRepository.getInstituteById(data.instituteId);
    if (!institute) {
      return { success: false, error: "Institute not found" };
    }
    if (institute.type !== "school") {
      return { success: false, error: "Classrooms can only be created for schools" };
    }

    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      data.instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can create classrooms" };
    }

    const classroom = await classroomRepository.createClassroom(data);
    return { success: true, classroom };
  }

  /**
   * Get a classroom by ID
   */
  async getClassroomById(classroomId: string): Promise<Classroom | undefined> {
    return classroomRepository.getClassroomById(classroomId);
  }

  /**
   * Get all classrooms for an institute
   */
  async getInstituteClassrooms(
    instituteId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; classrooms?: Classroom[]; error?: string }> {
    // Verify membership
    const isMember = await instituteRepository.isUserMemberOfInstitute(
      instituteId,
      requestingUserId
    );
    if (!isMember) {
      return { success: false, error: "You are not a member of this institute" };
    }

    const classrooms = await classroomRepository.getClassroomsByInstituteId(instituteId);
    return { success: true, classrooms };
  }

  /**
   * Update a classroom
   */
  async updateClassroom(
    classroomId: string,
    updates: UpdateClassroom,
    requestingUserId: string
  ): Promise<{ success: boolean; classroom?: Classroom; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can update classrooms" };
    }

    const updated = await classroomRepository.updateClassroom(classroomId, updates);
    return { success: true, classroom: updated };
  }

  /**
   * Delete a classroom (soft delete)
   */
  async deleteClassroom(
    classroomId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can delete classrooms" };
    }

    const deleted = await classroomRepository.deleteClassroom(classroomId);
    return { success: deleted, error: deleted ? undefined : "Failed to delete classroom" };
  }

  // ==================== Classroom Member Operations ====================

  /**
   * Add a user to a classroom
   */
  async addUserToClassroom(
    classroomId: string,
    userId: string,
    role: string,
    requestingUserId: string,
    isPrimary: boolean = false
  ): Promise<{ success: boolean; membership?: ClassroomUser; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can add members to classrooms" };
    }

    // Verify the target user is a member of the institute
    const isMember = await instituteRepository.isUserMemberOfInstitute(
      classroom.instituteId,
      userId
    );
    if (!isMember) {
      return { success: false, error: "User must be a member of the institute first" };
    }

    const membership = await classroomRepository.addUserToClassroom(
      classroomId,
      userId,
      role,
      isPrimary
    );
    return { success: true, membership };
  }

  /**
   * Get all members of a classroom
   */
  async getClassroomMembers(
    classroomId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; members?: { user: User; membership: ClassroomUser }[]; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Verify membership in institute
    const isMember = await instituteRepository.isUserMemberOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    if (!isMember) {
      return { success: false, error: "You are not a member of this institute" };
    }

    const members = await classroomRepository.getClassroomMembers(classroomId);
    return { success: true, members };
  }

  /**
   * Update a classroom member's role
   */
  async updateClassroomMember(
    classroomId: string,
    userId: string,
    updates: { role?: string; isPrimary?: boolean },
    requestingUserId: string
  ): Promise<{ success: boolean; membership?: ClassroomUser; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can update classroom members" };
    }

    const membership = await classroomRepository.updateClassroomUserByIds(
      classroomId,
      userId,
      updates
    );
    if (!membership) {
      return { success: false, error: "Member not found in this classroom" };
    }

    return { success: true, membership };
  }

  /**
   * Remove a user from a classroom
   */
  async removeUserFromClassroom(
    classroomId: string,
    userId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Verify admin access
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    if (!isAdmin) {
      return { success: false, error: "Only admins can remove classroom members" };
    }

    const removed = await classroomRepository.removeUserFromClassroom(classroomId, userId);
    return { success: removed, error: removed ? undefined : "Failed to remove member" };
  }

  /**
   * Get all classrooms a user is assigned to
   */
  async getUserClassrooms(
    userId: string,
    instituteId?: string
  ): Promise<{ classroom: Classroom; membership: ClassroomUser }[]> {
    if (instituteId) {
      return classroomRepository.getClassroomsByUserIdAndInstituteId(userId, instituteId);
    }
    return classroomRepository.getClassroomsByUserId(userId);
  }

  // ==================== Student Classroom Operations ====================

  /**
   * Add a student to a classroom
   */
  async addStudentToClassroom(
    studentId: string,
    classroomId: string,
    requestingUserId: string,
    options: {
      isPrimary?: boolean;
      enrollmentDate?: string;
      notes?: string;
    } = {}
  ): Promise<{ success: boolean; enrollment?: StudentClassroom; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Check authorization: user must be admin or assigned to this classroom
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    const isAssigned = await classroomRepository.isUserAssignedToClassroom(
      classroomId,
      requestingUserId
    );

    if (!isAdmin && !isAssigned) {
      return { success: false, error: "You must be an admin or assigned to this classroom" };
    }

    const isStudentInInstitute = await instituteRepository.isStudentInInstitute(
      classroom.instituteId,
      studentId
    );

    if (!isStudentInInstitute) {
      return { success: false, error: "Student must be enrolled in the institute first" };
    }

    const enrollment = await classroomRepository.addStudentToClassroom(
      studentId,
      classroomId,
      options
    );
    return { success: true, enrollment };
  }

  /**
   * Get all students in a classroom
   */
  async getClassroomStudents(
    classroomId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; students?: { student: Student; enrollment: StudentClassroom }[]; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Check authorization: user must be member of institute
    const isMember = await instituteRepository.isUserMemberOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    if (!isMember) {
      return { success: false, error: "You are not a member of this institute" };
    }

    const students = await classroomRepository.getStudentsInClassroom(classroomId);
    return { success: true, students };
  }

  /**
   * Update a student's classroom enrollment
   */
  async updateStudentEnrollment(
    studentId: string,
    classroomId: string,
    updates: { isPrimary?: boolean; notes?: string },
    requestingUserId: string
  ): Promise<{ success: boolean; enrollment?: StudentClassroom; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Check authorization
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    const isAssigned = await classroomRepository.isUserAssignedToClassroom(
      classroomId,
      requestingUserId
    );

    if (!isAdmin && !isAssigned) {
      return { success: false, error: "You must be an admin or assigned to this classroom" };
    }

    const link = await classroomRepository.getStudentClassroomLink(studentId, classroomId);
    if (!link) {
      return { success: false, error: "Student is not in this classroom" };
    }

    const enrollment = await classroomRepository.updateStudentClassroomLink(link.id, updates);
    return { success: true, enrollment };
  }

  /**
   * Remove a student from a classroom
   */
  async removeStudentFromClassroom(
    studentId: string,
    classroomId: string,
    requestingUserId: string
  ): Promise<{ success: boolean; error?: string }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Check authorization
    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    const isAssigned = await classroomRepository.isUserAssignedToClassroom(
      classroomId,
      requestingUserId
    );

    if (!isAdmin && !isAssigned) {
      return { success: false, error: "You must be an admin or assigned to this classroom" };
    }

    const removed = await classroomRepository.removeStudentFromClassroom(studentId, classroomId);
    return { success: removed, error: removed ? undefined : "Failed to remove student" };
  }

  /**
   * Get all classrooms a student is enrolled in
   */
  async getStudentClassrooms(
    studentId: string
  ): Promise<{ classroom: Classroom; enrollment: StudentClassroom }[]> {
    return classroomRepository.getClassroomsByStudentId(studentId);
  }

  // ==================== Utility Methods ====================

  /**
   * Check if user can manage a classroom (is admin or assigned)
   */
  async canUserManageClassroom(
    classroomId: string,
    userId: string
  ): Promise<boolean> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) return false;

    const isAdmin = await instituteRepository.isUserAdminOfInstitute(
      classroom.instituteId,
      userId
    );
    if (isAdmin) return true;

    return classroomRepository.isUserAssignedToClassroom(classroomId, userId);
  }

  /**
   * Get classroom with full details
   */
  async getClassroomWithDetails(
    classroomId: string,
    requestingUserId: string
  ): Promise<{
    success: boolean;
    data?: {
      classroom: Classroom;
      members: { user: User; membership: ClassroomUser }[];
      students: { student: Student; enrollment: StudentClassroom }[];
    };
    error?: string;
  }> {
    const classroom = await classroomRepository.getClassroomById(classroomId);
    if (!classroom) {
      return { success: false, error: "Classroom not found" };
    }

    // Verify membership in institute
    const isMember = await instituteRepository.isUserMemberOfInstitute(
      classroom.instituteId,
      requestingUserId
    );
    if (!isMember) {
      return { success: false, error: "You are not a member of this institute" };
    }

    const members = await classroomRepository.getClassroomMembers(classroomId);
    const studentEnrollments = await classroomRepository.getStudentsInClassroom(classroomId);

    return {
      success: true,
      data: {
        classroom,
        members,
        students: studentEnrollments,
      },
    };
  }
}

export const classroomService = new ClassroomService();