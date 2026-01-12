/**
 * Reports Memory Schema Tests
 *
 * Tests for medical, functional, and educational report memory operations.
 * Focuses on verifying that memory operations correctly modify the database.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockDb, createMockAIHandler, type MockAIChatHandler, type TestContext } from '../mocks/ai-mock.js';

describe('Reports Memory Schema', () => {
  let handler: MockAIChatHandler;
  let testContext: TestContext;
  let userId: string;
  let studentId: string;

  beforeEach(() => {
    mockDb.clear();

    const user = mockDb.createUser({ firstName: 'Test', lastName: 'User' });
    const student = mockDb.createStudent({ name: 'Test Student', framework: 'us_iep' });
    mockDb.createUserStudent(user.id, student.id, { role: 'therapist', hasEducationalRights: true, hasMedicalRights: true });

    userId = user.id;
    studentId = student.id;

    testContext = { userId, studentId };
    handler = createMockAIHandler(testContext);
  });

  afterEach(() => {
    mockDb.clear();
  });

  describe('Medical Record', () => {
    it('should load medical record from database', async () => {
      mockDb.createMedicalRecord(studentId, {
        primaryDiagnosis: 'Autism Spectrum Disorder',
        primaryDiagnosisCode: 'F84.0',
        status: 'draft',
      });

      await handler.loadContext('reports');

      const reports = handler.getMemoryValue('Context_Reports');
      expect(reports.medicalRecord).toBeDefined();
      expect(reports.medicalRecord.primaryDiagnosis).toBe('Autism Spectrum Disorder');
    });

    it('should set primary diagnosis in the database', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'set',
        path: '/Context_Reports/medicalRecord/primaryDiagnosis',
        value: 'Speech and Language Impairment',
      });

      const records = mockDb.getMedicalRecordsByStudentId(studentId);
      expect(records[0].primaryDiagnosis).toBe('Speech and Language Impairment');
    });

    it('should set diagnosis code in the database', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'set',
        path: '/Context_Reports/medicalRecord/primaryDiagnosisCode',
        value: 'F80.2',
      });

      const records = mockDb.getMedicalRecordsByStudentId(studentId);
      expect(records[0].primaryDiagnosisCode).toBe('F80.2');
    });

    it('should add medication to the database', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft', medications: ['Existing medication'] });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/medicalRecord/medications',
        value: 'Ritalin 10mg daily',
      });

      const records = mockDb.getMedicalRecordsByStudentId(studentId);
      expect(records[0].medications).toContain('Ritalin 10mg daily');
    });

    it('should add allergy alert to the database', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/medicalRecord/alertsAllergies',
        value: 'Peanut allergy - severe',
      });

      const records = mockDb.getMedicalRecordsByStudentId(studentId);
      expect(records[0].alertsAllergies).toContain('Peanut allergy - severe');
    });

    it('should add seizure alert to the database', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/medicalRecord/alertsSeizures',
        value: 'History of absence seizures',
      });

      const records = mockDb.getMedicalRecordsByStudentId(studentId);
      expect(records[0].alertsSeizures?.[0]).toBe('History of absence seizures');
    });

    it('should add co-morbidity to the database', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft', primaryDiagnosis: 'ASD' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/medicalRecord/coMorbidities',
        value: 'ADHD Combined Type',
      });

      const records = mockDb.getMedicalRecordsByStudentId(studentId);
      expect(records[0].coMorbidities).toContain('ADHD Combined Type');
    });

    it('should add medical equipment to the database', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/medicalRecord/medicalEquipment',
        value: 'Hearing aid - bilateral',
      });

      const records = mockDb.getMedicalRecordsByStudentId(studentId);
      expect(records[0].medicalEquipment).toContain('Hearing aid - bilateral');
    });
  });

  describe('Functional Report', () => {
    it('should load functional report from database', async () => {
      mockDb.createFunctionalReport(studentId, {
        status: 'draft',
        mobilityStatus: ['Ambulatory with no assistance'],
        adlStatus: ['Independent in most ADLs'],
      });

      await handler.loadContext('reports');

      const reports = handler.getMemoryValue('Context_Reports');
      expect(reports.functionalReport).toBeDefined();
      expect(reports.functionalReport.mobilityStatus).toBeDefined();
    });

    it('should add mobility status to the database', async () => {
      mockDb.createFunctionalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/functionalReport/mobilityStatus',
        value: 'Uses wheelchair for long distances',
      });

      const reports = mockDb.getFunctionalReportsByStudentId(studentId);
      expect(reports[0].mobilityStatus).toContain('Uses wheelchair for long distances');
    });

    it('should add ADL status to the database', async () => {
      mockDb.createFunctionalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/functionalReport/adlStatus',
        value: 'Requires assistance with dressing',
      });

      const reports = mockDb.getFunctionalReportsByStudentId(studentId);
      expect(reports[0].adlStatus).toContain('Requires assistance with dressing');
    });

    it('should add sensory profile information to the database', async () => {
      mockDb.createFunctionalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/functionalReport/sensoryProfile',
        value: 'Hypersensitive to loud noises',
      });

      const reports = mockDb.getFunctionalReportsByStudentId(studentId);
      expect(reports[0].sensoryProfile).toContain('Hypersensitive to loud noises');
    });

    it('should add safety risks to the database', async () => {
      mockDb.createFunctionalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/functionalReport/safetyRisks',
        value: 'Flight risk - requires supervision',
      });

      const reports = mockDb.getFunctionalReportsByStudentId(studentId);
      expect(reports[0].safetyRisks).toContain('Flight risk - requires supervision');
    });
  });

  describe('Educational Report', () => {
    it('should load educational report from database', async () => {
      mockDb.createEducationalReport(studentId, {
        status: 'draft',
        communicationMode: ['AAC - symbol-based'],
        assistiveTechnologyUsed: ['iPad with TouchChat'],
      });

      await handler.loadContext('reports');

      const reports = handler.getMemoryValue('Context_Reports');
      expect(reports.educationalReport).toBeDefined();
    });

    it('should add communication mode to the database', async () => {
      mockDb.createEducationalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/educationalReport/communicationMode',
        value: 'Combination of speech and AAC',
      });

      const reports = mockDb.getEducationalReportsByStudentId(studentId);
      expect(reports[0].communicationMode).toContain('Combination of speech and AAC');
    });

    it('should add receptive language information to the database', async () => {
      mockDb.createEducationalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/educationalReport/receptiveLanguage',
        value: 'Follows 2-step directions with visual supports',
      });

      const reports = mockDb.getEducationalReportsByStudentId(studentId);
      expect(reports[0].receptiveLanguage?.[0]).toBe('Follows 2-step directions with visual supports');
    });

    it('should add assistive technology to the database', async () => {
      mockDb.createEducationalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/educationalReport/assistiveTechnologyUsed',
        value: 'LAMP Words for Life on iPad',
      });

      const reports = mockDb.getEducationalReportsByStudentId(studentId);
      expect(reports[0].assistiveTechnologyUsed).toContain('LAMP Words for Life on iPad');
    });

    it('should add reinforcers to the database', async () => {
      mockDb.createEducationalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/educationalReport/reinforcers',
        value: 'iPad time, stickers, verbal praise',
      });

      const reports = mockDb.getEducationalReportsByStudentId(studentId);
      expect(reports[0].reinforcers).toContain('iPad time, stickers, verbal praise');
    });

    it('should add behavioral strategies to the database', async () => {
      mockDb.createEducationalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeOperation({
        action: 'add',
        path: '/Context_Reports/educationalReport/behavioralStrategies',
        value: 'First-Then board, visual schedule',
      });

      const reports = mockDb.getEducationalReportsByStudentId(studentId);
      expect(reports[0].behavioralStrategies).toContain('First-Then board, visual schedule');
    });
  });

  describe('Report Status and Visibility', () => {
    it('should only load draft and pending_review records', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft', primaryDiagnosis: 'Draft diagnosis' });
      mockDb.createMedicalRecord(studentId, { status: 'final', primaryDiagnosis: 'Final diagnosis' });

      await handler.loadContext('reports');

      const reports = handler.getMemoryValue('Context_Reports');
      expect(reports.medicalRecord.status).toBe('draft');
      expect(reports.medicalRecord.primaryDiagnosis).toBe('Draft diagnosis');
    });

    it('should return null when no report exists', async () => {
      await handler.loadContext('reports');

      const reports = handler.getMemoryValue('Context_Reports');
      expect(reports.medicalRecord).toBeNull();
      expect(reports.functionalReport).toBeNull();
      expect(reports.educationalReport).toBeNull();
    });

    it('should load pending_review status records', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'pending_review', primaryDiagnosis: 'Under review' });

      await handler.loadContext('reports');

      const reports = handler.getMemoryValue('Context_Reports');
      expect(reports.medicalRecord.status).toBe('pending_review');
    });
  });

  describe('All Reports Together', () => {
    it('should load all three report types', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft', primaryDiagnosis: 'ASD' });
      mockDb.createFunctionalReport(studentId, { status: 'draft', mobilityStatus: ['Ambulatory'] });
      mockDb.createEducationalReport(studentId, { status: 'draft', communicationMode: ['AAC'] });

      await handler.loadContext('reports');

      const reports = handler.getMemoryValue('Context_Reports');
      expect(reports.medicalRecord).toBeDefined();
      expect(reports.functionalReport).toBeDefined();
      expect(reports.educationalReport).toBeDefined();
    });

    it('should update all three reports in batch', async () => {
      mockDb.createMedicalRecord(studentId, { status: 'draft' });
      mockDb.createFunctionalReport(studentId, { status: 'draft' });
      mockDb.createEducationalReport(studentId, { status: 'draft' });
      await handler.loadContext('reports');

      await handler.executeBatch([
        { action: 'set', path: '/Context_Reports/medicalRecord/primaryDiagnosis', value: 'Test diagnosis' },
        { action: 'add', path: '/Context_Reports/functionalReport/mobilityStatus', value: 'Test mobility' },
        { action: 'add', path: '/Context_Reports/educationalReport/communicationMode', value: 'Test communication' },
      ]);

      const medRecords = mockDb.getMedicalRecordsByStudentId(studentId);
      const funcReports = mockDb.getFunctionalReportsByStudentId(studentId);
      const eduReports = mockDb.getEducationalReportsByStudentId(studentId);

      expect(medRecords[0].primaryDiagnosis).toBe('Test diagnosis');
      expect(funcReports[0].mobilityStatus).toContain('Test mobility');
      expect(eduReports[0].communicationMode).toContain('Test communication');
    });
  });
});
