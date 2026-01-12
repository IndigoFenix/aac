/**
 * Institute Memory Schema Tests
 *
 * Tests for organization management memory operations.
 * Focuses on verifying that memory operations correctly modify the database.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockDb, createMockAIHandler, type MockAIChatHandler, type TestContext } from '../mocks/ai-mock.js';

describe('Institute Memory Schema', () => {
  let handler: MockAIChatHandler;
  let testContext: TestContext;
  let userId: string;
  let studentId: string;

  beforeEach(() => {
    mockDb.clear();

    const user = mockDb.createUser({ firstName: 'Test', lastName: 'User' });
    const student = mockDb.createStudent({ name: 'Test Student', framework: 'us_iep' });
    mockDb.createUserStudent(user.id, student.id, { role: 'teacher', hasEducationalRights: true });

    userId = user.id;
    studentId = student.id;

    testContext = { userId, studentId };
    handler = createMockAIHandler(testContext);
  });

  afterEach(() => {
    mockDb.clear();
  });

  describe('Institutes', () => {
    it('should load institutes from database', async () => {
      mockDb.createInstitute({ name: 'Lincoln Elementary', type: 'school', address: '123 Main St' });
      mockDb.createInstitute({ name: 'City Hospital', type: 'hospital', address: '456 Medical Ave' });

      await handler.loadContext('institutes');

      const data = handler.getMemoryValue('Context_Institutes');
      expect(data.institutes).toHaveLength(2);
    });

    it('should add a school to the database', async () => {
      await handler.loadContext('institutes');

      const result = await handler.executeOperation({
        action: 'add',
        path: '/Context_Institutes/institutes',
        value: { name: 'Washington Middle School', type: 'school', isActive: true },
      });

      expect(result.ok).toBe(true);
      expect(result.dbSynced).toBe(true);

      const institutes = Array.from(mockDb.institutes.values());
      expect(institutes).toHaveLength(1);
      expect(institutes[0].name).toBe('Washington Middle School');
      expect(institutes[0].type).toBe('school');
    });

    it('should add a hospital to the database', async () => {
      await handler.loadContext('institutes');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Institutes/institutes',
        value: { name: 'Regional Medical Center', type: 'hospital', isActive: true },
      });

      const institutes = Array.from(mockDb.institutes.values());
      expect(institutes[0].type).toBe('hospital');
    });

    it('should add institute with full details', async () => {
      await handler.loadContext('institutes');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Institutes/institutes',
        value: {
          name: 'Jefferson High School',
          type: 'school',
          description: 'Public high school',
          address: '789 Education Blvd',
          phone: '555-0100',
          email: 'info@jefferson.edu',
          website: 'https://jefferson.edu',
          isActive: true,
        },
      });

      const institutes = Array.from(mockDb.institutes.values());
      expect(institutes[0].email).toBe('info@jefferson.edu');
    });

    it('should update institute information', async () => {
      mockDb.createInstitute({ name: 'Old Name School', type: 'school' });
      await handler.loadContext('institutes');

      await handler.executeOperation({
        action: 'set',
        path: '/Context_Institutes/institutes/0/name',
        value: 'New Name Academy',
      });

      const institutes = Array.from(mockDb.institutes.values());
      expect(institutes[0].name).toBe('New Name Academy');
    });

    it('should delete an institute from the database', async () => {
      mockDb.createInstitute({ name: 'School A', type: 'school' });
      mockDb.createInstitute({ name: 'School B', type: 'school' });
      await handler.loadContext('institutes');

      await handler.executeOperation({ action: 'delete', path: '/Context_Institutes/institutes/0' });

      expect(Array.from(mockDb.institutes.values())).toHaveLength(1);
    });
  });

  describe('Classrooms', () => {
    let instituteId: string;

    beforeEach(async () => {
      const institute = mockDb.createInstitute({ name: 'Test School', type: 'school' });
      instituteId = institute.id;
      await handler.loadContext('institutes');
    });

    it('should add a classroom to an institute', async () => {
      const result = await handler.executeOperation({
        action: 'add',
        path: '/Context_Institutes/institutes/0/classrooms',
        value: { name: 'Room 101', grade: '3', capacity: 25, isActive: true },
      });

      expect(result.ok).toBe(true);

      const classrooms = Array.from(mockDb.classrooms.values());
      expect(classrooms).toHaveLength(1);
      expect(classrooms[0].name).toBe('Room 101');
      expect(classrooms[0].instituteId).toBe(instituteId);
    });

    it('should add classroom with full details', async () => {
      await handler.executeOperation({
        action: 'add',
        path: '/Context_Institutes/institutes/0/classrooms',
        value: {
          name: 'Special Education Room A',
          grade: '3-5',
          description: 'Multi-grade special education',
          capacity: 12,
          roomNumber: 'B-204',
          academicYear: '2024-2025',
          isActive: true,
        },
      });

      const classrooms = Array.from(mockDb.classrooms.values());
      expect(classrooms[0].capacity).toBe(12);
      expect(classrooms[0].roomNumber).toBe('B-204');
    });

    it('should delete a classroom from the database', async () => {
      mockDb.createClassroom(instituteId, { name: 'Room 1' });
      mockDb.createClassroom(instituteId, { name: 'Room 2' });
      await handler.loadContext('institutes');

      await handler.executeOperation({
        action: 'delete',
        path: '/Context_Institutes/institutes/0/classrooms/0',
      });

      expect(Array.from(mockDb.classrooms.values())).toHaveLength(1);
    });

    it('should load classrooms nested within institutes', async () => {
      mockDb.createClassroom(instituteId, { name: 'Room A', grade: '1' });
      mockDb.createClassroom(instituteId, { name: 'Room B', grade: '2' });
      mockDb.createClassroom(instituteId, { name: 'Room C', grade: '3' });

      await handler.loadContext('institutes');

      const data = handler.getMemoryValue('Context_Institutes');
      expect(data.institutes[0].classrooms).toHaveLength(3);
    });
  });

  describe('Multiple Institutes', () => {
    it('should manage classrooms across multiple institutes separately', async () => {
      const school1 = mockDb.createInstitute({ name: 'School 1', type: 'school' });
      const school2 = mockDb.createInstitute({ name: 'School 2', type: 'school' });

      mockDb.createClassroom(school1.id, { name: 'S1-Room A' });
      mockDb.createClassroom(school1.id, { name: 'S1-Room B' });
      mockDb.createClassroom(school2.id, { name: 'S2-Room A' });
      mockDb.createClassroom(school2.id, { name: 'S2-Room B' });
      mockDb.createClassroom(school2.id, { name: 'S2-Room C' });

      await handler.loadContext('institutes');

      const data = handler.getMemoryValue('Context_Institutes');
      const inst1 = data.institutes.find((i: any) => i.name === 'School 1');
      const inst2 = data.institutes.find((i: any) => i.name === 'School 2');

      expect(inst1.classrooms).toHaveLength(2);
      expect(inst2.classrooms).toHaveLength(3);
    });

    it('should not include classrooms from other institutes', async () => {
      const school = mockDb.createInstitute({ name: 'School', type: 'school' });
      const hospital = mockDb.createInstitute({ name: 'Hospital', type: 'hospital' });

      mockDb.createClassroom(school.id, { name: 'Classroom 1' });
      mockDb.createClassroom(school.id, { name: 'Classroom 2' });

      await handler.loadContext('institutes');

      const data = handler.getMemoryValue('Context_Institutes');
      const schoolInst = data.institutes.find((i: any) => i.type === 'school');
      const hospitalInst = data.institutes.find((i: any) => i.type === 'hospital');

      expect(schoolInst.classrooms).toHaveLength(2);
      expect(hospitalInst.classrooms).toHaveLength(0);
    });
  });

  describe('Data Visibility', () => {
    it('should return empty institutes array when none exist', async () => {
      await handler.loadContext('institutes');

      const data = handler.getMemoryValue('Context_Institutes');
      expect(data.institutes).toHaveLength(0);
    });

    it('should only load active institutes', async () => {
      mockDb.createInstitute({ name: 'Active School', type: 'school', isActive: true });
      mockDb.createInstitute({ name: 'Inactive School', type: 'school', isActive: false });

      await handler.loadContext('institutes');

      const data = handler.getMemoryValue('Context_Institutes');
      expect(data.institutes).toHaveLength(1);
      expect(data.institutes[0].name).toBe('Active School');
    });

    it('should only load active classrooms', async () => {
      const institute = mockDb.createInstitute({ name: 'School', type: 'school' });
      mockDb.createClassroom(institute.id, { name: 'Active Room', isActive: true });
      mockDb.createClassroom(institute.id, { name: 'Inactive Room', isActive: false });

      await handler.loadContext('institutes');

      const data = handler.getMemoryValue('Context_Institutes');
      expect(data.institutes[0].classrooms).toHaveLength(1);
    });
  });

  describe('Batch Operations', () => {
    it('should create multiple institutes in batch', async () => {
      await handler.loadContext('institutes');

      await handler.executeBatch([
        { action: 'add', path: '/Context_Institutes/institutes', value: { name: 'School A', type: 'school', isActive: true } },
        { action: 'add', path: '/Context_Institutes/institutes', value: { name: 'School B', type: 'school', isActive: true } },
        { action: 'add', path: '/Context_Institutes/institutes', value: { name: 'Hospital A', type: 'hospital', isActive: true } },
      ]);

      expect(Array.from(mockDb.institutes.values())).toHaveLength(3);
    });
  });
});
