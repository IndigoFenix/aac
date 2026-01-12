/**
 * Mock Database for Testing
 *
 * Provides an in-memory database implementation for testing the memory schema
 * operations without requiring a real database connection.
 */

export interface MockUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  password?: string;
  chatMemory?: Record<string, any>;
  credits?: number;
  chatCreditsUsed?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockStudent {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  gender?: 'male' | 'female' | 'other';
  birthDate?: string;
  framework?: 'tala' | 'us_iep';
  country?: string;
  primaryLanguage?: string;
  additionalLanguages?: string[];
  isActive?: boolean;
  chatMemory?: Record<string, any>;
  chatCreditsUsed?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockUserStudent {
  id: string;
  userId: string;
  studentId: string;
  role: 'owner' | 'caregiver' | 'therapist' | 'teacher' | 'parent';
  hasEducationalRights?: boolean;
  hasMedicalRights?: boolean;
  isActive?: boolean;
  chatMemory?: Record<string, any>;
  chatCreditsUsed?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockProgram {
  id: string;
  studentId: string;
  instituteId?: string;
  framework: 'tala' | 'us_iep';
  title?: string;
  status: 'draft' | 'active' | 'archived';
  startDate?: string;
  endDate?: string;
  dueDate?: string;
  approvalDate?: string;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockGoal {
  id: string;
  programId: string;
  profileDomainId?: string;
  goalStatement: string;
  status: 'draft' | 'active' | 'achieved' | 'modified' | 'discontinued';
  progress?: number;
  targetDate?: string;
  criteria?: string;
  criteriaPercentage?: number;
  sortOrder?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockObjective {
  id: string;
  goalId: string;
  objectiveStatement: string;
  sequenceOrder?: number;
  criterion?: string;
  status: 'not_started' | 'in_progress' | 'achieved' | 'modified' | 'discontinued';
  targetDate?: string;
  achievedDate?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockService {
  id: string;
  programId: string;
  serviceType: string;
  customServiceName?: string;
  description?: string;
  providerName?: string;
  frequencyCount?: number;
  frequencyPeriod?: 'daily' | 'weekly' | 'monthly';
  sessionDuration?: number;
  setting?: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockTeamMember {
  id: string;
  programId: string;
  name: string;
  role: string;
  customRole?: string;
  contactEmail?: string;
  contactPhone?: string;
  isCoordinator?: boolean;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockProfileDomain {
  id: string;
  programId: string;
  domainType: string;
  customName?: string;
  strengths?: string;
  needs?: string;
  impactStatement?: string;
  sortOrder?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockMeeting {
  id: string;
  programId: string;
  meetingType: string;
  scheduledDate?: string;
  actualDate?: string;
  location?: string;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockDataPoint {
  id: string;
  goalId?: string;
  objectiveId?: string;
  value: string;
  numericValue?: number;
  context?: string;
  collectedBy?: string;
  recordedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockInstitute {
  id: string;
  name: string;
  type: 'school' | 'hospital';
  description?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockInstituteUser {
  id: string;
  instituteId: string;
  userId: string;
  role: string;
  isAdmin?: boolean;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockClassroom {
  id: string;
  instituteId: string;
  name: string;
  grade?: string;
  description?: string;
  capacity?: number;
  roomNumber?: string;
  academicYear?: string;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockMedicalRecord {
  id: string;
  studentId: string;
  userId?: string;
  instituteId?: string;
  status: 'draft' | 'pending_review' | 'final' | 'superseded';
  primaryDiagnosis?: string;
  primaryDiagnosisCode?: string;
  coMorbidities?: string[];
  secondaryDiagnoses?: string[];
  alertsAllergies?: string[];
  alertsSeizures?: string[];
  alertsCardiac?: string[];
  medications?: string[];
  medicalEquipment?: string[];
  finalizedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockFunctionalReport {
  id: string;
  studentId: string;
  userId?: string;
  instituteId?: string;
  programId?: string;
  status: 'draft' | 'pending_review' | 'final' | 'superseded';
  mobilityStatus?: string[];
  adlStatus?: string[];
  sensoryProfile?: string[];
  safetyRisks?: string[];
  finalizedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MockEducationalReport {
  id: string;
  studentId: string;
  userId?: string;
  instituteId?: string;
  programId?: string;
  status: 'draft' | 'pending_review' | 'final' | 'superseded';
  communicationMode?: string[];
  receptiveLanguage?: string[];
  assistiveTechnologyUsed?: string[];
  reinforcers?: string[];
  preferredActivities?: string[];
  behavioralStrategies?: string[];
  finalizedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * In-memory database store for testing
 */
class MockDatabase {
  // Core entities
  users: Map<string, MockUser> = new Map();
  students: Map<string, MockStudent> = new Map();
  userStudents: Map<string, MockUserStudent> = new Map();

  // Program entities
  programs: Map<string, MockProgram> = new Map();
  goals: Map<string, MockGoal> = new Map();
  objectives: Map<string, MockObjective> = new Map();
  services: Map<string, MockService> = new Map();
  teamMembers: Map<string, MockTeamMember> = new Map();
  profileDomains: Map<string, MockProfileDomain> = new Map();
  meetings: Map<string, MockMeeting> = new Map();
  dataPoints: Map<string, MockDataPoint> = new Map();

  // Institute entities
  institutes: Map<string, MockInstitute> = new Map();
  instituteUsers: Map<string, MockInstituteUser> = new Map();
  classrooms: Map<string, MockClassroom> = new Map();

  // Report entities
  medicalRecords: Map<string, MockMedicalRecord> = new Map();
  functionalReports: Map<string, MockFunctionalReport> = new Map();
  educationalReports: Map<string, MockEducationalReport> = new Map();

  /**
   * Clear all data from the mock database
   */
  clear(): void {
    this.users.clear();
    this.students.clear();
    this.userStudents.clear();
    this.programs.clear();
    this.goals.clear();
    this.objectives.clear();
    this.services.clear();
    this.teamMembers.clear();
    this.profileDomains.clear();
    this.meetings.clear();
    this.dataPoints.clear();
    this.institutes.clear();
    this.instituteUsers.clear();
    this.classrooms.clear();
    this.medicalRecords.clear();
    this.functionalReports.clear();
    this.educationalReports.clear();
  }

  /**
   * Create a test user
   */
  createUser(overrides: Partial<MockUser> = {}): MockUser {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const user: MockUser = {
      id,
      email: `test-${id.slice(0, 8)}@example.com`,
      firstName: 'Test',
      lastName: 'User',
      fullName: 'Test User',
      chatMemory: {},
      credits: 10000,
      chatCreditsUsed: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.users.set(id, user);
    return user;
  }

  /**
   * Create a test student
   */
  createStudent(overrides: Partial<MockStudent> = {}): MockStudent {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const student: MockStudent = {
      id,
      name: 'Test Student',
      firstName: 'Test',
      lastName: 'Student',
      gender: 'other',
      framework: 'us_iep',
      country: 'US',
      primaryLanguage: 'en',
      additionalLanguages: [],
      isActive: true,
      chatMemory: {},
      chatCreditsUsed: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.students.set(id, student);
    return student;
  }

  /**
   * Create a user-student relationship
   */
  createUserStudent(userId: string, studentId: string, overrides: Partial<MockUserStudent> = {}): MockUserStudent {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const userStudent: MockUserStudent = {
      id,
      userId,
      studentId,
      role: 'owner',
      hasEducationalRights: true,
      hasMedicalRights: true,
      isActive: true,
      chatMemory: {},
      chatCreditsUsed: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.userStudents.set(id, userStudent);
    return userStudent;
  }

  /**
   * Create a test program
   */
  createProgram(studentId: string, overrides: Partial<MockProgram> = {}): MockProgram {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const program: MockProgram = {
      id,
      studentId,
      framework: 'us_iep',
      title: 'Test Program',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.programs.set(id, program);
    return program;
  }

  /**
   * Create a test goal
   */
  createGoal(programId: string, overrides: Partial<MockGoal> = {}): MockGoal {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const goal: MockGoal = {
      id,
      programId,
      goalStatement: 'Test goal statement',
      status: 'active',
      progress: 0,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.goals.set(id, goal);
    return goal;
  }

  /**
   * Create a test objective
   */
  createObjective(goalId: string, overrides: Partial<MockObjective> = {}): MockObjective {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const objective: MockObjective = {
      id,
      goalId,
      objectiveStatement: 'Test objective statement',
      status: 'not_started',
      sequenceOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.objectives.set(id, objective);
    return objective;
  }

  /**
   * Create a test service
   */
  createService(programId: string, overrides: Partial<MockService> = {}): MockService {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const service: MockService = {
      id,
      programId,
      serviceType: 'speech_language_therapy',
      sessionDuration: 30,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.services.set(id, service);
    return service;
  }

  /**
   * Create a test team member
   */
  createTeamMember(programId: string, overrides: Partial<MockTeamMember> = {}): MockTeamMember {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const teamMember: MockTeamMember = {
      id,
      programId,
      name: 'Test Team Member',
      role: 'speech_language_pathologist',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.teamMembers.set(id, teamMember);
    return teamMember;
  }

  /**
   * Create a test profile domain
   */
  createProfileDomain(programId: string, overrides: Partial<MockProfileDomain> = {}): MockProfileDomain {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const domain: MockProfileDomain = {
      id,
      programId,
      domainType: 'communication_language',
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.profileDomains.set(id, domain);
    return domain;
  }

  /**
   * Create a test institute
   */
  createInstitute(overrides: Partial<MockInstitute> = {}): MockInstitute {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const institute: MockInstitute = {
      id,
      name: 'Test School',
      type: 'school',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.institutes.set(id, institute);
    return institute;
  }

  /**
   * Create a test classroom
   */
  createClassroom(instituteId: string, overrides: Partial<MockClassroom> = {}): MockClassroom {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const classroom: MockClassroom = {
      id,
      instituteId,
      name: 'Test Classroom',
      grade: '1',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.classrooms.set(id, classroom);
    return classroom;
  }

  /**
   * Create a test medical record
   */
  createMedicalRecord(studentId: string, overrides: Partial<MockMedicalRecord> = {}): MockMedicalRecord {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const record: MockMedicalRecord = {
      id,
      studentId,
      status: 'draft',
      coMorbidities: [],
      secondaryDiagnoses: [],
      alertsAllergies: [],
      alertsSeizures: [],
      alertsCardiac: [],
      medications: [],
      medicalEquipment: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.medicalRecords.set(id, record);
    return record;
  }

  /**
   * Create a test functional report
   */
  createFunctionalReport(studentId: string, overrides: Partial<MockFunctionalReport> = {}): MockFunctionalReport {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const report: MockFunctionalReport = {
      id,
      studentId,
      status: 'draft',
      mobilityStatus: [],
      adlStatus: [],
      sensoryProfile: [],
      safetyRisks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.functionalReports.set(id, report);
    return report;
  }

  /**
   * Create a test educational report
   */
  createEducationalReport(studentId: string, overrides: Partial<MockEducationalReport> = {}): MockEducationalReport {
    const id = overrides.id || globalThis.testUtils.generateUUID();
    const report: MockEducationalReport = {
      id,
      studentId,
      status: 'draft',
      communicationMode: [],
      receptiveLanguage: [],
      assistiveTechnologyUsed: [],
      reinforcers: [],
      preferredActivities: [],
      behavioralStrategies: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.educationalReports.set(id, report);
    return report;
  }

  /**
   * Get programs by student ID
   */
  getProgramsByStudentId(studentId: string, status?: string): MockProgram[] {
    return Array.from(this.programs.values())
      .filter(p => p.studentId === studentId && (!status || p.status === status))
      .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  }

  /**
   * Get goals by program ID
   */
  getGoalsByProgramId(programId: string): MockGoal[] {
    return Array.from(this.goals.values())
      .filter(g => g.programId === programId)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }

  /**
   * Get objectives by goal ID
   */
  getObjectivesByGoalId(goalId: string): MockObjective[] {
    return Array.from(this.objectives.values())
      .filter(o => o.goalId === goalId)
      .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
  }

  /**
   * Get services by program ID
   */
  getServicesByProgramId(programId: string): MockService[] {
    return Array.from(this.services.values())
      .filter(s => s.programId === programId);
  }

  /**
   * Get team members by program ID
   */
  getTeamMembersByProgramId(programId: string, activeOnly: boolean = true): MockTeamMember[] {
    return Array.from(this.teamMembers.values())
      .filter(tm => tm.programId === programId && (!activeOnly || tm.isActive));
  }

  /**
   * Get profile domains by program ID
   */
  getProfileDomainsByProgramId(programId: string): MockProfileDomain[] {
    return Array.from(this.profileDomains.values())
      .filter(d => d.programId === programId)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }

  /**
   * Get medical records by student ID
   */
  getMedicalRecordsByStudentId(studentId: string, status?: string[]): MockMedicalRecord[] {
    return Array.from(this.medicalRecords.values())
      .filter(r => r.studentId === studentId && (!status || status.includes(r.status)))
      .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  }

  /**
   * Get functional reports by student ID
   */
  getFunctionalReportsByStudentId(studentId: string, status?: string[]): MockFunctionalReport[] {
    return Array.from(this.functionalReports.values())
      .filter(r => r.studentId === studentId && (!status || status.includes(r.status)))
      .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  }

  /**
   * Get educational reports by student ID
   */
  getEducationalReportsByStudentId(studentId: string, status?: string[]): MockEducationalReport[] {
    return Array.from(this.educationalReports.values())
      .filter(r => r.studentId === studentId && (!status || status.includes(r.status)))
      .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));
  }
}

// Export singleton instance
export const mockDb = new MockDatabase();

// Export types
export type {
  MockDatabase,
};
