/**
 * Student-related object integration tests.
 *
 * Programs, profile domains, goals, objectives, services, calendar events,
 * incidents, GAS data points, transition plans/goals.
 *
 * Each describe block builds a (user, student, program) base in beforeEach
 * so tests can focus on the specific entity under test.
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { truncateAll, db } from '../helpers/db.js';
import { makeUser, makeStudent } from '../helpers/factories.js';
import {
  programRepository,
  calendarRepository,
  incidentRepository,
} from '../../repositories/index.js';
import {
  dataPoints,
  serviceGoals,
  transitionPlans,
  transitionGoals,
} from '@shared/schema';
import { eq } from 'drizzle-orm';

describe('Student-related objects', () => {
  afterEach(truncateAll);

  // Shared base setup
  let userId: string;
  let studentId: string;
  let programId: string;

  beforeEach(async () => {
    const user = await makeUser();
    const { student } = await makeStudent(user.id);
    const program = await programRepository.createProgram({
      studentId: student.id,
      framework: 'us_iep',
      title: 'Test Program',
      status: 'draft',
    } as any);
    userId = user.id;
    studentId = student.id;
    programId = program.id;
  });

  describe('programs', () => {
    it('creates a program for a student', async () => {
      const found = await programRepository.getProgramById(programId);
      expect(found).toBeDefined();
      expect(found!.studentId).toBe(studentId);
      expect(found!.status).toBe('draft');
    });

    it('lists programs by student', async () => {
      const list = await programRepository.getProgramsByStudentId(studentId);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(programId);
    });

    it('updates program status through draft → active → archived', async () => {
      let updated = await programRepository.updateProgram(programId, {
        status: 'active',
      } as any);
      expect(updated!.status).toBe('active');

      updated = await programRepository.updateProgram(programId, {
        status: 'archived',
      } as any);
      expect(updated!.status).toBe('archived');
    });
  });

  describe('profile domains, goals, and objectives', () => {
    it('creates a profileDomain → goal → objective hierarchy', async () => {
      const domain = await programRepository.createProfileDomain({
        programId,
        domainType: 'communication_language',
        strengths: 'Strong receptive language',
        needs: 'Expressive vocabulary',
      } as any);

      const goal = await programRepository.createGoal({
        programId,
        goalStatement: 'Increase expressive vocabulary',
        status: 'active',
      } as any);

      const objective = await programRepository.createObjective({
        goalId: goal.id,
        objectiveStatement: 'Use 20 new words',
        sequenceOrder: 1,
        profileDomainId: domain.id,
      } as any);

      expect(domain.programId).toBe(programId);
      expect(goal.programId).toBe(programId);
      expect(objective.goalId).toBe(goal.id);
      expect(objective.profileDomainId).toBe(domain.id);

      const goals = await programRepository.getGoalsByProgramId(programId);
      expect(goals).toHaveLength(1);
      expect(goals[0].id).toBe(goal.id);

      const objectives = await programRepository.getObjectivesByGoalId(goal.id);
      expect(objectives).toHaveLength(1);
      expect(objectives[0].id).toBe(objective.id);
    });
  });

  describe('services and serviceGoals', () => {
    it('creates a service and links it to a goal', async () => {
      const goal = await programRepository.createGoal({
        programId,
        goalStatement: 'Goal A',
        status: 'active',
      } as any);

      const service = await programRepository.createService({
        programId,
        serviceType: 'speech_language_therapy',
        deliveryModel: 'direct',
        isActive: true,
      } as any);

      await programRepository.linkServiceToGoal(service.id, goal.id);

      const links = await db
        .select()
        .from(serviceGoals)
        .where(eq(serviceGoals.serviceId, service.id));
      expect(links).toHaveLength(1);
      expect(links[0].goalId).toBe(goal.id);

      const services = await programRepository.getServicesByProgramId(programId);
      expect(services).toHaveLength(1);
      expect(services[0].id).toBe(service.id);
    });

    it('unlinks a service from a goal', async () => {
      const goal = await programRepository.createGoal({
        programId,
        goalStatement: 'Goal B',
        status: 'active',
      } as any);
      const service = await programRepository.createService({
        programId,
        serviceType: 'occupational_therapy',
        isActive: true,
      } as any);

      await programRepository.linkServiceToGoal(service.id, goal.id);
      await programRepository.unlinkServiceFromGoal(service.id, goal.id);

      const links = await db
        .select()
        .from(serviceGoals)
        .where(eq(serviceGoals.serviceId, service.id));
      expect(links).toHaveLength(0);
    });
  });

  describe('calendar events', () => {
    it('creates a calendar event tied to a service', async () => {
      const service = await programRepository.createService({
        programId,
        serviceType: 'speech_language_therapy',
        isActive: true,
      } as any);

      const start = new Date('2026-05-01T14:00:00Z');
      const end = new Date('2026-05-01T14:30:00Z');
      const event = await calendarRepository.createEvent(
        {
          title: 'Weekly SLP session',
          startTime: start,
          endTime: end,
          allDay: false,
          repeatType: 'weekly',
          repeatInterval: 1,
          serviceId: service.id,
        } as any,
        userId,
      );

      expect(event.id).toBeDefined();
      expect(event.serviceId).toBe(service.id);
      expect(event.createdByUserId).toBe(userId);

      const fetched = await calendarRepository.getEventById(event.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe('Weekly SLP session');
    });

    it('cascade-deletes events when their service is deleted', async () => {
      const service = await programRepository.createService({
        programId,
        serviceType: 'speech_language_therapy',
        isActive: true,
      } as any);

      const event = await calendarRepository.createEvent(
        {
          title: 'Bound to service',
          startTime: new Date('2026-05-01T14:00:00Z'),
          endTime: new Date('2026-05-01T14:30:00Z'),
          allDay: false,
          repeatType: 'none',
          serviceId: service.id,
        } as any,
        userId,
      );

      await programRepository.deleteService(service.id);

      const fetched = await calendarRepository.getEventById(event.id);
      expect(fetched).toBeUndefined();
    });
  });

  describe('incidents', () => {
    it('creates an incident with severity and lists by student', async () => {
      const incident = await incidentRepository.create({
        studentId,
        type: 'medical',
        severity: 'moderate',
        recordedAt: new Date('2026-04-20T10:00:00Z'),
        context: 'Brief seizure during morning routine',
        isSensitive: true,
        sensitivityCategory: 'medical',
      } as any);

      expect(incident.id).toBeDefined();
      expect(incident.severity).toBe('moderate');
      expect(incident.type).toBe('medical');

      const list = await incidentRepository.listByStudent(studentId);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(incident.id);
    });

    it('updates incident severity', async () => {
      const incident = await incidentRepository.create({
        studentId,
        type: 'functional',
        severity: 'low',
        recordedAt: new Date(),
      } as any);

      const updated = await incidentRepository.update(incident.id, {
        severity: 'high',
      } as any);
      expect(updated!.severity).toBe('high');
    });
  });

  describe('GAS data points', () => {
    it('records a GAS-scored data point against a goal', async () => {
      const goal = await programRepository.createGoal({
        programId,
        goalStatement: 'GAS goal',
        status: 'active',
        useGas: true,
        gasVaryingVariable: 'achievement',
        gasBaselineLevel: 'less_than_expected',
      } as any);

      const [dp] = await db
        .insert(dataPoints)
        .values({
          goalId: goal.id,
          recordedAt: new Date('2026-04-15T09:00:00Z'),
          value: 'expected level',
          numericValue: 0,
          achievedLevel: 'expected',
          context: 'Probe trial',
        } as any)
        .returning();

      expect(dp.id).toBeDefined();
      expect(dp.achievedLevel).toBe('expected');

      const [fetched] = await db
        .select()
        .from(dataPoints)
        .where(eq(dataPoints.goalId, goal.id));
      expect(fetched.id).toBe(dp.id);
    });
  });

  describe('transition plans and goals', () => {
    it('creates a transition plan and links transition goals', async () => {
      const [plan] = await db
        .insert(transitionPlans)
        .values({
          programId,
          postSecondaryEducation: 'Community college',
          employment: 'Part-time grocery clerk',
          independentLiving: 'Supported apartment',
        } as any)
        .returning();

      const [goal] = await db
        .insert(transitionGoals)
        .values({
          transitionPlanId: plan.id,
          area: 'employment',
          goalStatement: 'Apply for grocery clerk position by May',
          responsibleParty: 'Job coach',
          timeline: '3 months',
          status: 'active',
        } as any)
        .returning();

      expect(plan.programId).toBe(programId);
      expect(goal.transitionPlanId).toBe(plan.id);
      expect(goal.area).toBe('employment');

      const plans = await db
        .select()
        .from(transitionPlans)
        .where(eq(transitionPlans.programId, programId));
      expect(plans).toHaveLength(1);

      const goals = await db
        .select()
        .from(transitionGoals)
        .where(eq(transitionGoals.transitionPlanId, plan.id));
      expect(goals).toHaveLength(1);
    });
  });
});
