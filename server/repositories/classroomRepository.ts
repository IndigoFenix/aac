// server/repositories/classroomRepository.ts
// Repository for classroom management operations

import {
    classrooms,
    classroomUsers,
    studentClassrooms,
    users,
    students,
    type Classroom,
    type InsertClassroom,
    type UpdateClassroom,
    type ClassroomUser,
    type InsertClassroomUser,
    type UpdateClassroomUser,
    type StudentClassroom,
    type InsertStudentClassroom,
    type UpdateStudentClassroom,
    type User,
    type Student,
  } from "@shared/schema";
  import { db } from "../db";
  import { eq, and, desc } from "drizzle-orm";
  
  export class ClassroomRepository {
    // ==================== Classroom CRUD Operations ====================
  
    /**
     * Create a new classroom
     */
    async createClassroom(insert: InsertClassroom): Promise<Classroom> {
      const [classroom] = await db
        .insert(classrooms)
        .values(insert)
        .returning();
      return classroom;
    }
  
    /**
     * Get a classroom by ID
     */
    async getClassroomById(id: string): Promise<Classroom | undefined> {
      const [classroom] = await db
        .select()
        .from(classrooms)
        .where(eq(classrooms.id, id));
      return classroom || undefined;
    }
  
    /**
     * Get all classrooms for an institute
     */
    async getClassroomsByInstituteId(instituteId: string): Promise<Classroom[]> {
      return await db
        .select()
        .from(classrooms)
        .where(
          and(
            eq(classrooms.instituteId, instituteId),
            eq(classrooms.isActive, true)
          )
        )
        .orderBy(classrooms.grade, classrooms.name);
    }
  
    /**
     * Get all classrooms (including inactive) for an institute
     */
    async getAllClassroomsByInstituteId(instituteId: string): Promise<Classroom[]> {
      return await db
        .select()
        .from(classrooms)
        .where(eq(classrooms.instituteId, instituteId))
        .orderBy(classrooms.grade, classrooms.name);
    }
  
    /**
     * Update a classroom
     */
    async updateClassroom(
      id: string,
      updates: UpdateClassroom
    ): Promise<Classroom | undefined> {
      const [updated] = await db
        .update(classrooms)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(classrooms.id, id))
        .returning();
      return updated || undefined;
    }
  
    /**
     * Soft delete a classroom
     */
    async deleteClassroom(id: string): Promise<boolean> {
      const [updated] = await db
        .update(classrooms)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(classrooms.id, id))
        .returning();
      return !!updated;
    }
  
    // ==================== Classroom User (Member) Operations ====================
  
    /**
     * Add a user to a classroom
     */
    async addUserToClassroom(
      classroomId: string,
      userId: string,
      role: string = "teacher",
      isPrimary: boolean = false
    ): Promise<ClassroomUser> {
      // Check if assignment already exists
      const existing = await this.getClassroomUserLink(classroomId, userId);
      
      if (existing) {
        // Reactivate if inactive
        if (!existing.isActive) {
          const [updated] = await db
            .update(classroomUsers)
            .set({ isActive: true, role, isPrimary, updatedAt: new Date() })
            .where(eq(classroomUsers.id, existing.id))
            .returning();
          return updated;
        }
        // Update existing active assignment
        const [updated] = await db
          .update(classroomUsers)
          .set({ role, isPrimary, updatedAt: new Date() })
          .where(eq(classroomUsers.id, existing.id))
          .returning();
        return updated;
      }
  
      const [link] = await db
        .insert(classroomUsers)
        .values({
          classroomId,
          userId,
          role,
          isPrimary,
          isActive: true,
        })
        .returning();
      return link;
    }
  
    /**
     * Get the link between a user and a classroom
     */
    async getClassroomUserLink(
      classroomId: string,
      userId: string
    ): Promise<ClassroomUser | undefined> {
      const [link] = await db
        .select()
        .from(classroomUsers)
        .where(
          and(
            eq(classroomUsers.classroomId, classroomId),
            eq(classroomUsers.userId, userId)
          )
        );
      return link || undefined;
    }
  
    /**
     * Get all members of a classroom
     */
    async getClassroomMembers(
      classroomId: string
    ): Promise<{ user: User; membership: ClassroomUser }[]> {
      const results = await db
        .select({
          user: users,
          membership: classroomUsers,
        })
        .from(classroomUsers)
        .innerJoin(users, eq(classroomUsers.userId, users.id))
        .where(
          and(
            eq(classroomUsers.classroomId, classroomId),
            eq(classroomUsers.isActive, true)
          )
        )
        .orderBy(desc(classroomUsers.isPrimary), users.fullName);
  
      return results;
    }
  
    /**
     * Get all classrooms a user is assigned to
     */
    async getClassroomsByUserId(
      userId: string
    ): Promise<{ classroom: Classroom; membership: ClassroomUser }[]> {
      const results = await db
        .select({
          classroom: classrooms,
          membership: classroomUsers,
        })
        .from(classroomUsers)
        .innerJoin(classrooms, eq(classroomUsers.classroomId, classrooms.id))
        .where(
          and(
            eq(classroomUsers.userId, userId),
            eq(classroomUsers.isActive, true),
            eq(classrooms.isActive, true)
          )
        )
        .orderBy(classrooms.grade, classrooms.name);
  
      return results;
    }
  
    /**
     * Get all classrooms a user is assigned to within an institute
     */
    async getClassroomsByUserIdAndInstituteId(
      userId: string,
      instituteId: string
    ): Promise<{ classroom: Classroom; membership: ClassroomUser }[]> {
      const results = await db
        .select({
          classroom: classrooms,
          membership: classroomUsers,
        })
        .from(classroomUsers)
        .innerJoin(classrooms, eq(classroomUsers.classroomId, classrooms.id))
        .where(
          and(
            eq(classroomUsers.userId, userId),
            eq(classroomUsers.isActive, true),
            eq(classrooms.isActive, true),
            eq(classrooms.instituteId, instituteId)
          )
        )
        .orderBy(classrooms.grade, classrooms.name);
  
      return results;
    }
  
    /**
     * Update a classroom user assignment
     */
    async updateClassroomUserLink(
      id: string,
      updates: UpdateClassroomUser
    ): Promise<ClassroomUser | undefined> {
      const [updated] = await db
        .update(classroomUsers)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(classroomUsers.id, id))
        .returning();
      return updated || undefined;
    }
  
    /**
     * Update classroom user by classroom and user IDs
     */
    async updateClassroomUserByIds(
      classroomId: string,
      userId: string,
      updates: UpdateClassroomUser
    ): Promise<ClassroomUser | undefined> {
      const [updated] = await db
        .update(classroomUsers)
        .set({ ...updates, updatedAt: new Date() })
        .where(
          and(
            eq(classroomUsers.classroomId, classroomId),
            eq(classroomUsers.userId, userId)
          )
        )
        .returning();
      return updated || undefined;
    }
  
    /**
     * Remove a user from a classroom (soft delete)
     */
    async removeUserFromClassroom(
      classroomId: string,
      userId: string
    ): Promise<boolean> {
      const [updated] = await db
        .update(classroomUsers)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(classroomUsers.classroomId, classroomId),
            eq(classroomUsers.userId, userId)
          )
        )
        .returning();
      return !!updated;
    }
  
    /**
     * Check if user is assigned to a classroom
     */
    async isUserAssignedToClassroom(
      classroomId: string,
      userId: string
    ): Promise<boolean> {
      const link = await this.getClassroomUserLink(classroomId, userId);
      return !!(link && link.isActive);
    }
  
    // ==================== Student Classroom Operations ====================
  
    /**
     * Add a student to a classroom
     */
    async addStudentToClassroom(
      studentId: string,
      classroomId: string,
      options: {
        isPrimary?: boolean;
        enrollmentDate?: string;
        notes?: string;
      } = {}
    ): Promise<StudentClassroom> {
      const { isPrimary = false, enrollmentDate, notes } = options;
  
      // Check if assignment already exists
      const existing = await this.getStudentClassroomLink(studentId, classroomId);
      
      if (existing) {
        // Reactivate if inactive
        if (!existing.isActive) {
          const [updated] = await db
            .update(studentClassrooms)
            .set({ 
              isActive: true, 
              isPrimary, 
              enrollmentDate: enrollmentDate || null,
              notes: notes || null,
              exitDate: null,
              updatedAt: new Date() 
            })
            .where(eq(studentClassrooms.id, existing.id))
            .returning();
          return updated;
        }
        return existing;
      }
  
      const [link] = await db
        .insert(studentClassrooms)
        .values({
          studentId,
          classroomId,
          isPrimary,
          enrollmentDate: enrollmentDate || null,
          notes: notes || null,
          isActive: true,
        })
        .returning();
      return link;
    }
  
    /**
     * Get the link between a student and a classroom
     */
    async getStudentClassroomLink(
      studentId: string,
      classroomId: string
    ): Promise<StudentClassroom | undefined> {
      const [link] = await db
        .select()
        .from(studentClassrooms)
        .where(
          and(
            eq(studentClassrooms.studentId, studentId),
            eq(studentClassrooms.classroomId, classroomId)
          )
        );
      return link || undefined;
    }
  
    /**
     * Get all students in a classroom
     */
    async getStudentsInClassroom(
      classroomId: string
    ): Promise<{ student: Student; enrollment: StudentClassroom }[]> {
      const results = await db
        .select({
          student: students,
          enrollment: studentClassrooms,
        })
        .from(studentClassrooms)
        .innerJoin(students, eq(studentClassrooms.studentId, students.id))
        .where(
          and(
            eq(studentClassrooms.classroomId, classroomId),
            eq(studentClassrooms.isActive, true),
            eq(students.isActive, true)
          )
        )
        .orderBy(students.name);
  
      return results;
    }
  
    /**
     * Get all classrooms a student is in
     */
    async getClassroomsByStudentId(
      studentId: string
    ): Promise<{ classroom: Classroom; enrollment: StudentClassroom }[]> {
      const results = await db
        .select({
          classroom: classrooms,
          enrollment: studentClassrooms,
        })
        .from(studentClassrooms)
        .innerJoin(classrooms, eq(studentClassrooms.classroomId, classrooms.id))
        .where(
          and(
            eq(studentClassrooms.studentId, studentId),
            eq(studentClassrooms.isActive, true),
            eq(classrooms.isActive, true)
          )
        )
        .orderBy(desc(studentClassrooms.isPrimary), classrooms.grade, classrooms.name);
  
      return results;
    }
  
    /**
     * Update a student classroom assignment
     */
    async updateStudentClassroomLink(
      id: string,
      updates: UpdateStudentClassroom
    ): Promise<StudentClassroom | undefined> {
      const [updated] = await db
        .update(studentClassrooms)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(studentClassrooms.id, id))
        .returning();
      return updated || undefined;
    }
  
    /**
     * Remove a student from a classroom (soft delete)
     */
    async removeStudentFromClassroom(
      studentId: string,
      classroomId: string
    ): Promise<boolean> {
      const [updated] = await db
        .update(studentClassrooms)
        .set({ 
          isActive: false, 
          exitDate: new Date().toISOString().split('T')[0],
          updatedAt: new Date() 
        })
        .where(
          and(
            eq(studentClassrooms.studentId, studentId),
            eq(studentClassrooms.classroomId, classroomId)
          )
        )
        .returning();
      return !!updated;
    }
  
    /**
     * Get classroom with full details (members and students count)
     */
    async getClassroomWithDetails(classroomId: string): Promise<{
      classroom: Classroom;
      memberCount: number;
      studentCount: number;
    } | undefined> {
      const classroom = await this.getClassroomById(classroomId);
      if (!classroom) return undefined;
  
      const members = await this.getClassroomMembers(classroomId);
      const studentEnrollments = await this.getStudentsInClassroom(classroomId);
  
      return {
        classroom,
        memberCount: members.length,
        studentCount: studentEnrollments.length,
      };
    }
  }
  
  export const classroomRepository = new ClassroomRepository();