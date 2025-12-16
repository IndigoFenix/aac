import { studentRepository } from "../repositories";
import {
  type Student,
  type InsertStudent,
  type UpdateStudent,
  type UserStudent,
  type InsertUserStudent,
  type UpdateUserStudent,
} from "@shared/schema";

export class StudentService {
  // ==================== AAC User Operations ====================

  /**
   * Create a new AAC user and link it to the creating user
   * This is the primary method for creating AAC users through the app
   */
  async createStudent(
    insert: InsertStudent,
    userId: string,
    role: string = "owner"
  ): Promise<Student> {
    const { student } = await studentRepository.createStudentWithLink(
      insert,
      userId,
      role
    );
    return student;
  }

  /**
   * Create an AAC user and return both the user and the link
   */
  async createStudentWithLink(
    insert: InsertStudent,
    userId: string,
    role: string = "owner"
  ): Promise<{ student: Student; link: UserStudent }> {
    return await studentRepository.createStudentWithLink(
      insert,
      userId,
      role
    );
  }

  /**
   * Get all AAC users linked to a specific user
   */
  async getStudentsByUserId(userId: string): Promise<Student[]> {
    return studentRepository.getStudentsByUserId(userId);
  }

  /**
   * Get all AAC users with their link details for a user
   */
  async getStudentsWithLinksByUserId(
    userId: string
  ): Promise<{ student: Student; link: UserStudent }[]> {
    return studentRepository.getStudentsWithLinksByUserId(userId);
  }

  /**
   * Get an AAC user by their ID
   */
  async getStudentById(studentId: string): Promise<Student | undefined> {
    return studentRepository.getStudentById(studentId);
  }

  /**
   * @deprecated Use getStudentById instead
   */
  async getStudentByStudentId(studentId: string): Promise<Student | undefined> {
    return studentRepository.getStudentById(studentId);
  }

  /**
   * Update an AAC user
   */
  async updateStudent(
    studentId: string,
    updates: UpdateStudent
  ): Promise<Student | undefined> {
    return studentRepository.updateStudent(studentId, updates);
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
  ): Promise<{ hasAccess: boolean; student?: Student; link?: UserStudent }> {
    const student = await studentRepository.getStudentById(studentId);
    if (!student) {
      return { hasAccess: false };
    }

    const link = await studentRepository.getUserStudentLink(userId, studentId);
    if (!link || !link.isActive) {
      return { hasAccess: false, student };
    }

    return { hasAccess: true, student, link };
  }

  // ==================== User-AAC User Link Operations ====================

  /**
   * Link a user to an existing AAC user
   */
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

  /**
   * Get the link between a user and an AAC user
   */
  async getUserStudentLink(
    userId: string,
    studentId: string
  ): Promise<UserStudent | undefined> {
    return studentRepository.getUserStudentLink(userId, studentId);
  }

  /**
   * Get all users linked to an AAC user
   */
  async getUsersLinkedToStudent(studentId: string): Promise<UserStudent[]> {
    return studentRepository.getUsersByStudentId(studentId);
  }

  /**
   * Update the link between a user and an AAC user
   */
  async updateUserStudentLink(
    linkId: string,
    updates: UpdateUserStudent
  ): Promise<UserStudent | undefined> {
    return studentRepository.updateUserStudentLink(linkId, updates);
  }

  /**
   * Remove a user's access to an AAC user (deactivates the link)
   */
  async unlinkUserFromStudent(
    userId: string,
    studentId: string
  ): Promise<boolean> {
    return studentRepository.deactivateUserStudentLink(userId, studentId);
  }

  // ==================== Utility Methods ====================

  /**
   * Calculate age from birth date
   */
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

  /**
   * Get AAC user with calculated age
   */
  async getStudentWithAge(studentId: string): Promise<(Student & { age: number | null }) | undefined> {
    const student = await this.getStudentById(studentId);
    if (!student) return undefined;
    
    return {
      ...student,
      age: this.calculateAge(student.birthDate),
    };
  }
}

export const studentService = new StudentService();