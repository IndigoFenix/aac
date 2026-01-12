/**
 * AI Memory Integration Tests
 *
 * End-to-end tests that simulate real AI memory modification workflows.
 * Tests the complete flow from memory operation to database modification.
 * Focuses on operation formatting and data visibility, not text parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  mockDb,
  createMockAIHandler,
  type MockAIChatHandler,
  type TestContext,
} from '../mocks/ai-mock.js';

describe('AI Memory Integration', () => {
  let handler: MockAIChatHandler;
  let testContext: TestContext;
  let userId: string;
  let studentId: string;
  let programId: string;

  beforeEach(() => {
    mockDb.clear();

    // Create complete test environment
    const user = mockDb.createUser({
      firstName: 'Sarah',
      lastName: 'Johnson',
      email: 'sarah.johnson@example.com',
    });
    const student = mockDb.createStudent({
      name: 'Alex Smith',
      firstName: 'Alex',
      lastName: 'Smith',
      framework: 'us_iep',
      birthDate: '2015-06-15',
      gender: 'male',
      primaryLanguage: 'en',
    });
    mockDb.createUserStudent(user.id, student.id, {
      role: 'therapist',
      hasEducationalRights: true,
      hasMedicalRights: true,
    });

    // Create active program
    const program = mockDb.createProgram(student.id, {
      title: 'IEP 2024-2025',
      status: 'active',
      framework: 'us_iep',
    });

    userId = user.id;
    studentId = student.id;
    programId = program.id;

    testContext = { userId, studentId, programId };
    handler = createMockAIHandler(testContext);
  });

  afterEach(() => {
    mockDb.clear();
  });

  // ==========================================================================
  // Full Workflow Tests
  // ==========================================================================

  describe('Complete IEP Workflow', () => {
    it('should handle complete IEP creation workflow', async () => {
      // Step 1: Load the program
      await handler.loadContext('program');
      let program = handler.getMemoryValue('Context_Program');
      expect(program).toBeDefined();
      expect(program.id).toBe(programId);

      // Step 2: Add profile domains
      await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/profileDomains',
        value: {
          domainType: 'communication_language',
          strengths: 'Good vocabulary, understands complex sentences',
          needs: 'Expressive language delayed, uses 2-3 word phrases',
          impactStatement: 'Difficulty participating in class discussions',
        },
      });

      // Step 3: Add team members
      await handler.executeBatch([
        {
          action: 'add',
          path: '/Context_Program/teamMembers',
          value: {
            name: 'Dr. Emily Chen',
            role: 'speech_language_pathologist',
            contactEmail: 'chen@therapy.com',
            isCoordinator: true,
          },
        },
        {
          action: 'add',
          path: '/Context_Program/teamMembers',
          value: {
            name: 'Mr. James Wilson',
            role: 'special_education_teacher',
            contactEmail: 'wilson@school.edu',
          },
        },
        {
          action: 'add',
          path: '/Context_Program/teamMembers',
          value: {
            name: 'Mrs. Patricia Smith',
            role: 'parent',
          },
        },
      ]);

      // Step 4: Add annual goals
      await handler.executeBatch([
        {
          action: 'add',
          path: '/Context_Program/goals',
          value: {
            goalStatement: 'Alex will use 4-5 word sentences to communicate needs and wants with 80% accuracy across 3 consecutive sessions.',
            status: 'active',
            progress: 0,
            criteria: '80% accuracy',
            criteriaPercentage: 80,
          },
        },
        {
          action: 'add',
          path: '/Context_Program/goals',
          value: {
            goalStatement: 'Alex will follow 2-step directions without visual supports with 90% accuracy.',
            status: 'active',
            progress: 0,
            criteria: '90% accuracy',
            criteriaPercentage: 90,
          },
        },
      ]);

      // Reload to get updated goals
      await handler.loadContext('program');
      program = handler.getMemoryValue('Context_Program');

      // Step 5: Add objectives to goals
      if (program.goals?.length > 0) {
        await handler.executeBatch([
          {
            action: 'add',
            path: '/Context_Program/goals/0/objectives',
            value: {
              objectiveStatement: 'Alex will use 3-word phrases in 4/5 opportunities',
              criterion: '80% accuracy',
              status: 'in_progress',
              sequenceOrder: 1,
            },
          },
          {
            action: 'add',
            path: '/Context_Program/goals/0/objectives',
            value: {
              objectiveStatement: 'Alex will use 4-word phrases in 4/5 opportunities',
              criterion: '80% accuracy',
              status: 'not_started',
              sequenceOrder: 2,
            },
          },
        ]);
      }

      // Step 6: Add services
      await handler.executeBatch([
        {
          action: 'add',
          path: '/Context_Program/services',
          value: {
            serviceType: 'speech_language_therapy',
            providerName: 'Dr. Emily Chen',
            sessionDuration: 30,
            frequencyCount: 3,
            frequencyPeriod: 'weekly',
            setting: 'therapy_room',
          },
        },
        {
          action: 'add',
          path: '/Context_Program/services',
          value: {
            serviceType: 'occupational_therapy',
            sessionDuration: 45,
            frequencyCount: 1,
            frequencyPeriod: 'weekly',
            setting: 'classroom',
          },
        },
      ]);

      // Verify final state
      const goals = mockDb.getGoalsByProgramId(programId);
      const services = mockDb.getServicesByProgramId(programId);
      const teamMembers = mockDb.getTeamMembersByProgramId(programId);
      const domains = mockDb.getProfileDomainsByProgramId(programId);

      expect(goals.length).toBe(2);
      expect(services.length).toBe(2);
      expect(teamMembers.length).toBe(3);
      expect(domains.length).toBe(1);

      // Verify objectives were added
      const objectives = mockDb.getObjectivesByGoalId(goals[0].id);
      expect(objectives.length).toBe(2);
    });

    it('should track progress on goals over time', async () => {
      // Create initial goal
      mockDb.createGoal(programId, {
        goalStatement: 'Test goal for progress tracking',
        status: 'active',
        progress: 0,
      });
      await handler.loadContext('program');

      // Simulate progress updates over time
      await handler.executeOperation({
        action: 'set',
        path: '/Context_Program/goals/0/progress',
        value: 25,
      });

      let goals = mockDb.getGoalsByProgramId(programId);
      expect(goals[0].progress).toBe(25);

      await handler.executeOperation({
        action: 'set',
        path: '/Context_Program/goals/0/progress',
        value: 50,
      });

      goals = mockDb.getGoalsByProgramId(programId);
      expect(goals[0].progress).toBe(50);

      await handler.executeOperation({
        action: 'set',
        path: '/Context_Program/goals/0/progress',
        value: 80,
      });

      goals = mockDb.getGoalsByProgramId(programId);
      expect(goals[0].progress).toBe(80);

      // Mark as achieved when progress reaches criteria
      await handler.executeOperation({
        action: 'set',
        path: '/Context_Program/goals/0/status',
        value: 'achieved',
      });

      goals = mockDb.getGoalsByProgramId(programId);
      expect(goals[0].status).toBe('achieved');
    });
  });

  // ==========================================================================
  // Medical Records Workflow
  // ==========================================================================

  describe('Complete Medical Records Workflow', () => {
    it('should build complete medical record through memory operations', async () => {
      // Create initial record
      mockDb.createMedicalRecord(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      // Build complete medical record
      await handler.executeBatch([
        {
          action: 'set',
          path: '/Context_Reports/medicalRecord/primaryDiagnosis',
          value: 'Autism Spectrum Disorder, Level 2',
        },
        {
          action: 'set',
          path: '/Context_Reports/medicalRecord/primaryDiagnosisCode',
          value: 'F84.0',
        },
      ]);

      await handler.executeBatch([
        {
          action: 'add',
          path: '/Context_Reports/medicalRecord/coMorbidities',
          value: 'ADHD, Combined Type (F90.2)',
        },
        {
          action: 'add',
          path: '/Context_Reports/medicalRecord/coMorbidities',
          value: 'Generalized Anxiety Disorder (F41.1)',
        },
      ]);

      await handler.executeBatch([
        {
          action: 'add',
          path: '/Context_Reports/medicalRecord/medications',
          value: 'Methylphenidate 10mg, twice daily',
        },
        {
          action: 'add',
          path: '/Context_Reports/medicalRecord/medications',
          value: 'Melatonin 3mg, at bedtime',
        },
      ]);

      await handler.executeBatch([
        {
          action: 'add',
          path: '/Context_Reports/medicalRecord/alertsAllergies',
          value: 'Penicillin - causes hives',
        },
        {
          action: 'add',
          path: '/Context_Reports/medicalRecord/alertsSeizures',
          value: 'No seizure history',
        },
        {
          action: 'add',
          path: '/Context_Reports/medicalRecord/alertsCardiac',
          value: 'No cardiac concerns',
        },
      ]);

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/medicalRecord/medicalEquipment',
        value: 'Noise-canceling headphones for sensory regulation',
      });

      // Verify complete record
      const records = mockDb.getMedicalRecordsByStudentId(studentId);
      expect(records.length).toBeGreaterThan(0);
      expect(records[0].primaryDiagnosis).toBe('Autism Spectrum Disorder, Level 2');
      expect(records[0].coMorbidities?.length).toBe(2);
      expect(records[0].medications?.length).toBe(2);
      expect(records[0].alertsAllergies?.length).toBe(1);
      expect(records[0].medicalEquipment?.length).toBe(1);
    });
  });

  // ==========================================================================
  // Institute Management Workflow
  // ==========================================================================

  describe('Complete Institute Management Workflow', () => {
    it('should set up school with classrooms', async () => {
      await handler.loadContext('institutes');

      // Create school
      await handler.executeOperation({
        action: 'add',
        path: '/Context_Institutes/institutes',
        value: {
          name: 'Sunshine Elementary School',
          type: 'school',
          description: 'Public elementary school K-5',
          address: '123 School Lane, Anytown, ST 12345',
          phone: '555-123-4567',
          email: 'office@sunshine.edu',
          website: 'https://sunshine.edu',
          isActive: true,
        },
      });

      await handler.loadContext('institutes');

      // Add classrooms
      await handler.executeBatch([
        {
          action: 'add',
          path: '/Context_Institutes/institutes/0/classrooms',
          value: {
            name: 'Ms. Roberts - Grade 2',
            grade: '2',
            roomNumber: 'A-101',
            capacity: 22,
            isActive: true,
          },
        },
        {
          action: 'add',
          path: '/Context_Institutes/institutes/0/classrooms',
          value: {
            name: 'Mr. Thompson - Grade 2',
            grade: '2',
            roomNumber: 'A-102',
            capacity: 22,
            isActive: true,
          },
        },
        {
          action: 'add',
          path: '/Context_Institutes/institutes/0/classrooms',
          value: {
            name: 'Special Education - Resource Room',
            grade: 'K-5',
            roomNumber: 'B-201',
            capacity: 8,
            isActive: true,
          },
        },
      ]);

      // Verify setup
      const institutes = Array.from(mockDb.institutes.values());
      expect(institutes.length).toBe(1);
      expect(institutes[0].name).toBe('Sunshine Elementary School');

      const classrooms = Array.from(mockDb.classrooms.values());
      expect(classrooms.length).toBe(3);
    });
  });

  // ==========================================================================
  // Error Recovery Tests
  // ==========================================================================

  describe('Error Recovery', () => {
    it('should continue after failed operation in batch', async () => {
      await handler.loadContext('program');

      // Batch with one operation that might have issues
      const results = await handler.executeBatch([
        {
          action: 'add',
          path: '/Context_Program/goals',
          value: { goalStatement: 'Goal 1', status: 'draft' },
        },
        {
          action: 'set',
          path: '/Context_Program/nonexistent/deep/path',
          value: 'This might fail',
        },
        {
          action: 'add',
          path: '/Context_Program/goals',
          value: { goalStatement: 'Goal 2', status: 'draft' },
        },
      ]);

      // First and third should succeed
      expect(results[0].ok).toBe(true);
      expect(results[2].ok).toBe(true);

      // Should have created 2 goals
      const goals = mockDb.getGoalsByProgramId(programId);
      expect(goals.length).toBe(2);
    });

    it('should handle operations on empty context gracefully', async () => {
      // Don't load any context
      const result = await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/goals',
        value: { goalStatement: 'New goal', status: 'draft' },
      });

      // Operation should complete (even if it doesn't persist to DB)
      expect(result.action).toBe('add');
    });
  });

  // ==========================================================================
  // Concurrent Operations Tests
  // ==========================================================================

  describe('Concurrent Operations', () => {
    it('should handle rapid successive operations', async () => {
      await handler.loadContext('program');

      // Rapid additions
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          handler.executeOperation({
            action: 'add',
            path: '/Context_Program/goals',
            value: { goalStatement: `Goal ${i}`, status: 'draft' },
          })
        );
      }

      const results = await Promise.all(promises);
      expect(results.every(r => r.ok)).toBe(true);

      const goals = mockDb.getGoalsByProgramId(programId);
      expect(goals.length).toBe(5);
    });

    it('should handle batch with many operations', async () => {
      await handler.loadContext('program');

      const operations = [];
      for (let i = 0; i < 10; i++) {
        operations.push({
          action: 'add' as const,
          path: '/Context_Program/goals',
          value: { goalStatement: `Batch goal ${i}`, status: 'draft' },
        });
      }

      const results = await handler.executeBatch(operations);
      expect(results.length).toBe(10);
      expect(results.every(r => r.ok)).toBe(true);

      const goals = mockDb.getGoalsByProgramId(programId);
      expect(goals.length).toBe(10);
    });
  });

  // ==========================================================================
  // Data Integrity Tests
  // ==========================================================================

  describe('Data Integrity', () => {
    it('should maintain data consistency across operations', async () => {
      // Add initial data
      mockDb.createGoal(programId, {
        goalStatement: 'Persistent goal',
        status: 'active',
      });
      mockDb.createService(programId, {
        serviceType: 'speech_language_therapy',
      });

      await handler.loadContext('program');

      // Add more data
      await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/goals',
        value: { goalStatement: 'New goal', status: 'draft' },
      });

      // Reload and verify
      await handler.loadContext('program');
      const program = handler.getMemoryValue('Context_Program');

      expect(program.goals.length).toBe(2);
      expect(program.services.length).toBe(1);
    });

    it('should preserve existing data when adding new items', async () => {
      // Create goals with specific properties
      mockDb.createGoal(programId, {
        goalStatement: 'Goal with criteria',
        status: 'active',
        criteria: '80% accuracy',
        criteriaPercentage: 80,
        progress: 45,
      });

      await handler.loadContext('program');

      // Add a new goal
      await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/goals',
        value: { goalStatement: 'Another goal', status: 'draft' },
      });

      // Verify original goal still has all properties
      const goals = mockDb.getGoalsByProgramId(programId);
      const originalGoal = goals.find(g => g.goalStatement === 'Goal with criteria');

      expect(originalGoal).toBeDefined();
      expect(originalGoal?.criteria).toBe('80% accuracy');
      expect(originalGoal?.progress).toBe(45);
    });

    it('should correctly delete and cascade objectives', async () => {
      // Create goal with objectives
      const goal = mockDb.createGoal(programId, {
        goalStatement: 'Goal with objectives',
        status: 'active',
      });
      mockDb.createObjective(goal.id, { objectiveStatement: 'Objective 1' });
      mockDb.createObjective(goal.id, { objectiveStatement: 'Objective 2' });

      await handler.loadContext('program');

      // Delete the goal
      await handler.executeOperation({
        action: 'delete',
        path: '/Context_Program/goals/0',
      });

      // Verify goal and objectives are deleted
      expect(mockDb.getGoalsByProgramId(programId)).toHaveLength(0);
      expect(mockDb.getObjectivesByGoalId(goal.id)).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Memory Path Format Tests
  // ==========================================================================

  describe('Memory Path Formats', () => {
    it('should handle nested paths correctly', async () => {
      await handler.loadContext('program');

      // Add a goal first
      await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/goals',
        value: { goalStatement: 'Parent goal', status: 'active' },
      });

      await handler.loadContext('program');

      // Add objective to the goal using nested path
      const result = await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/goals/0/objectives',
        value: { objectiveStatement: 'First objective', status: 'not_started' },
      });

      expect(result.ok).toBe(true);

      // Verify objective was created
      const goals = mockDb.getGoalsByProgramId(programId);
      const objectives = mockDb.getObjectivesByGoalId(goals[0].id);
      expect(objectives.length).toBe(1);
    });

    it('should handle array index updates correctly', async () => {
      // Create multiple goals
      mockDb.createGoal(programId, { goalStatement: 'Goal 0', status: 'draft', progress: 0 });
      mockDb.createGoal(programId, { goalStatement: 'Goal 1', status: 'draft', progress: 0 });
      mockDb.createGoal(programId, { goalStatement: 'Goal 2', status: 'draft', progress: 0 });

      await handler.loadContext('program');

      // Update specific goals by index
      await handler.executeOperation({
        action: 'set',
        path: '/Context_Program/goals/1/progress',
        value: 50,
      });

      const goals = mockDb.getGoalsByProgramId(programId);
      expect(goals[0].progress).toBe(0);
      expect(goals[1].progress).toBe(50);
      expect(goals[2].progress).toBe(0);
    });

    it('should handle reports with array fields', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft', medications: [] });
      await handler.loadContext('reports');

      // Add multiple items to array field
      await handler.executeBatch([
        { action: 'add', path: '/Context_Reports/medicalRecord/medications', value: 'Med 1' },
        { action: 'add', path: '/Context_Reports/medicalRecord/medications', value: 'Med 2' },
        { action: 'add', path: '/Context_Reports/medicalRecord/medications', value: 'Med 3' },
      ]);

      const records = mockDb.getMedicalRecordsByStudentId(studentId);
      expect(records[0].medications).toHaveLength(3);
      expect(records[0].medications).toContain('Med 1');
      expect(records[0].medications).toContain('Med 2');
      expect(records[0].medications).toContain('Med 3');
    });
  });

  // ==========================================================================
  // View Operation Tests
  // ==========================================================================

  describe('View Operations', () => {
    it('should load program data correctly', async () => {
      // Setup data
      mockDb.createGoal(programId, { goalStatement: 'Goal 1', status: 'active' });
      mockDb.createService(programId, { serviceType: 'speech_language_therapy' });
      mockDb.createTeamMember(programId, { name: 'Test Member', role: 'slp' });

      await handler.loadContext('program');

      const program = handler.getMemoryValue('Context_Program');
      expect(program).toBeDefined();
      expect(program.goals).toHaveLength(1);
      expect(program.services).toHaveLength(1);
      expect(program.teamMembers).toHaveLength(1);
    });

    it('should load reports data correctly', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft', primaryDiagnosis: 'ASD' });
      mockDb.createFunctionalReport(studentId, { status: 'draft' });
      mockDb.createEducationalReport(studentId, { status: 'draft' });

      await handler.loadContext('reports');

      const reports = handler.getMemoryValue('Context_Reports');
      expect(reports.medicalRecord).toBeDefined();
      expect(reports.functionalReport).toBeDefined();
      expect(reports.educationalReport).toBeDefined();
    });

    it('should load institutes data correctly', async () => {
      const inst = mockDb.createInstitute({ name: 'Test School', type: 'school' });
      mockDb.createClassroom(inst.id, { name: 'Room 101' });
      mockDb.createClassroom(inst.id, { name: 'Room 102' });

      await handler.loadContext('institutes');

      const data = handler.getMemoryValue('Context_Institutes');
      expect(data.institutes).toHaveLength(1);
      expect(data.institutes[0].classrooms).toHaveLength(2);
    });
  });
});
