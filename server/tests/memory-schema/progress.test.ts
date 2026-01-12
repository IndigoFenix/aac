/**
 * Progress Memory Schema Tests
 *
 * Tests for IEP/TALA program-related memory operations.
 * Focuses on verifying that memory operations correctly modify the database.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockDb, createMockAIHandler, type MockAIChatHandler, type TestContext } from '../mocks/ai-mock.js';

describe('Progress Memory Schema', () => {
  let handler: MockAIChatHandler;
  let testContext: TestContext;
  let userId: string;
  let studentId: string;
  let programId: string;

  beforeEach(() => {
    mockDb.clear();

    const user = mockDb.createUser({ firstName: 'Test', lastName: 'User' });
    const student = mockDb.createStudent({ name: 'Test Student', framework: 'us_iep' });
    mockDb.createUserStudent(user.id, student.id, { role: 'therapist', hasEducationalRights: true, hasMedicalRights: true });
    const program = mockDb.createProgram(student.id, { title: 'IEP 2025', status: 'active', framework: 'us_iep' });

    userId = user.id;
    studentId = student.id;
    programId = program.id;

    testContext = { userId, studentId, programId };
    handler = createMockAIHandler(testContext);
  });

  afterEach(() => {
    mockDb.clear();
  });

  describe('Goals', () => {
    it('should load goals from database when viewing program', async () => {
      mockDb.createGoal(programId, { goalStatement: 'Goal 1', status: 'active', progress: 25 });
      mockDb.createGoal(programId, { goalStatement: 'Goal 2', status: 'draft', progress: 0 });

      await handler.loadContext('program');

      const program = handler.getMemoryValue('Context_Program');
      expect(program).toBeDefined();
      expect(program.goals).toHaveLength(2);
      expect(program.goals[0].goalStatement).toBe('Goal 1');
    });

    it('should add a goal to the database', async () => {
      await handler.loadContext('program');

      const result = await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/goals',
        value: { goalStatement: 'New goal', status: 'draft', progress: 0 },
      });

      expect(result.ok).toBe(true);
      expect(result.dbSynced).toBe(true);

      const goals = mockDb.getGoalsByProgramId(programId);
      expect(goals).toHaveLength(1);
      expect(goals[0].goalStatement).toBe('New goal');
    });

    it('should update goal progress in the database', async () => {
      mockDb.createGoal(programId, { goalStatement: 'Test goal', status: 'active', progress: 0 });
      await handler.loadContext('program');

      const result = await handler.executeOperation({
        action: 'set',
        path: '/Context_Program/goals/0/progress',
        value: 50,
      });

      expect(result.ok).toBe(true);

      const goals = mockDb.getGoalsByProgramId(programId);
      expect(goals[0].progress).toBe(50);
    });

    it('should update goal status in the database', async () => {
      mockDb.createGoal(programId, { goalStatement: 'Test goal', status: 'active' });
      await handler.loadContext('program');

      await handler.executeOperation({
        action: 'set',
        path: '/Context_Program/goals/0/status',
        value: 'achieved',
      });

      const goals = mockDb.getGoalsByProgramId(programId);
      expect(goals[0].status).toBe('achieved');
    });

    it('should delete a goal from the database', async () => {
      mockDb.createGoal(programId, { goalStatement: 'Goal 1' });
      mockDb.createGoal(programId, { goalStatement: 'Goal 2' });
      await handler.loadContext('program');

      await handler.executeOperation({ action: 'delete', path: '/Context_Program/goals/0' });

      const goals = mockDb.getGoalsByProgramId(programId);
      expect(goals).toHaveLength(1);
    });

    it('should add multiple goals in batch', async () => {
      await handler.loadContext('program');

      await handler.executeBatch([
        { action: 'add', path: '/Context_Program/goals', value: { goalStatement: 'Goal A', status: 'draft' } },
        { action: 'add', path: '/Context_Program/goals', value: { goalStatement: 'Goal B', status: 'draft' } },
        { action: 'add', path: '/Context_Program/goals', value: { goalStatement: 'Goal C', status: 'draft' } },
      ]);

      expect(mockDb.getGoalsByProgramId(programId)).toHaveLength(3);
    });
  });

  describe('Objectives', () => {
    let goalId: string;

    beforeEach(async () => {
      const goal = mockDb.createGoal(programId, { goalStatement: 'Parent goal', status: 'active' });
      goalId = goal.id;
      await handler.loadContext('program');
    });

    it('should add an objective to a goal', async () => {
      const result = await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/goals/0/objectives',
        value: { objectiveStatement: 'First objective', status: 'not_started', criterion: '80% accuracy' },
      });

      expect(result.ok).toBe(true);

      const objectives = mockDb.getObjectivesByGoalId(goalId);
      expect(objectives).toHaveLength(1);
      expect(objectives[0].objectiveStatement).toBe('First objective');
    });

    it('should delete objectives when parent goal is deleted', async () => {
      mockDb.createObjective(goalId, { objectiveStatement: 'Objective 1' });
      mockDb.createObjective(goalId, { objectiveStatement: 'Objective 2' });
      await handler.loadContext('program');

      await handler.executeOperation({ action: 'delete', path: '/Context_Program/goals/0' });

      expect(mockDb.getObjectivesByGoalId(goalId)).toHaveLength(0);
    });
  });

  describe('Services', () => {
    it('should load services from database', async () => {
      mockDb.createService(programId, { serviceType: 'speech_language_therapy', sessionDuration: 30 });
      mockDb.createService(programId, { serviceType: 'occupational_therapy', sessionDuration: 45 });

      await handler.loadContext('program');

      const program = handler.getMemoryValue('Context_Program');
      expect(program.services).toHaveLength(2);
    });

    it('should add a service to the database', async () => {
      await handler.loadContext('program');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/services',
        value: { serviceType: 'physical_therapy', providerName: 'Dr. Smith', sessionDuration: 60 },
      });

      const services = mockDb.getServicesByProgramId(programId);
      expect(services).toHaveLength(1);
      expect(services[0].providerName).toBe('Dr. Smith');
    });

    it('should delete a service from the database', async () => {
      mockDb.createService(programId, { serviceType: 'speech_language_therapy' });
      mockDb.createService(programId, { serviceType: 'occupational_therapy' });
      await handler.loadContext('program');

      await handler.executeOperation({ action: 'delete', path: '/Context_Program/services/0' });

      expect(mockDb.getServicesByProgramId(programId)).toHaveLength(1);
    });
  });

  describe('Team Members', () => {
    it('should load team members from database', async () => {
      mockDb.createTeamMember(programId, { name: 'Jane Doe', role: 'slp', isCoordinator: true });
      mockDb.createTeamMember(programId, { name: 'John Smith', role: 'ot' });

      await handler.loadContext('program');

      const program = handler.getMemoryValue('Context_Program');
      expect(program.teamMembers).toHaveLength(2);
    });

    it('should add a team member to the database', async () => {
      await handler.loadContext('program');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/teamMembers',
        value: { name: 'Sarah Johnson', role: 'special_education_teacher', contactEmail: 'sarah@school.edu' },
      });

      const members = mockDb.getTeamMembersByProgramId(programId);
      expect(members).toHaveLength(1);
      expect(members[0].contactEmail).toBe('sarah@school.edu');
    });

    it('should soft delete team member (set isActive to false)', async () => {
      const tm = mockDb.createTeamMember(programId, { name: 'To Remove', role: 'aide', isActive: true });
      await handler.loadContext('program');

      await handler.executeOperation({ action: 'delete', path: '/Context_Program/teamMembers/0' });

      const member = mockDb.teamMembers.get(tm.id);
      expect(member?.isActive).toBe(false);
      expect(mockDb.getTeamMembersByProgramId(programId, true)).toHaveLength(0);
    });
  });

  describe('Profile Domains', () => {
    it('should add a profile domain to the database', async () => {
      await handler.loadContext('program');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Program/profileDomains',
        value: { domainType: 'communication_language', strengths: 'Good vocabulary', needs: 'Expressive support' },
      });

      const domains = mockDb.getProfileDomainsByProgramId(programId);
      expect(domains).toHaveLength(1);
      expect(domains[0].domainType).toBe('communication_language');
    });
  });

  describe('Program Status', () => {
    it('should update program status in the database', async () => {
      await handler.loadContext('program');

      await handler.executeOperation({ action: 'set', path: '/Context_Program/status', value: 'archived' });

      const program = mockDb.programs.get(programId);
      expect(program?.status).toBe('archived');
    });
  });

  describe('Data Visibility', () => {
    it('should load complete program with all nested data', async () => {
      mockDb.createGoal(programId, { goalStatement: 'Goal 1', status: 'active' });
      mockDb.createService(programId, { serviceType: 'speech_language_therapy' });
      mockDb.createTeamMember(programId, { name: 'Team Member 1', role: 'slp' });
      mockDb.createProfileDomain(programId, { domainType: 'communication_language' });

      await handler.loadContext('program');

      const program = handler.getMemoryValue('Context_Program');
      expect(program.goals).toHaveLength(1);
      expect(program.services).toHaveLength(1);
      expect(program.teamMembers).toHaveLength(1);
      expect(program.profileDomains).toHaveLength(1);
    });

    it('should return null when no active program exists', async () => {
      mockDb.programs.clear();
      await handler.loadContext('program');

      const program = handler.getMemoryValue('Context_Program');
      expect(program).toBeNull();
    });

    it('should load objectives nested within goals', async () => {
      const goal = mockDb.createGoal(programId, { goalStatement: 'Goal with objectives' });
      mockDb.createObjective(goal.id, { objectiveStatement: 'Objective 1' });
      mockDb.createObjective(goal.id, { objectiveStatement: 'Objective 2' });

      await handler.loadContext('program');

      const program = handler.getMemoryValue('Context_Program');
      expect(program.goals[0].objectives).toHaveLength(2);
    });
  });
});
