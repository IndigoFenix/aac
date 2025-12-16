// src/types/program.ts
// TypeScript type definitions for IEP/TALA Program Management

// =============================================================================
// ENUMS
// =============================================================================

export type ProgramFramework = 'tala' | 'us_iep';
export type ProgramStatus = 'draft' | 'active' | 'archived';

export type ProfileDomainType = 
  | 'cognitive_academic'
  | 'communication_language' 
  | 'social_emotional_behavioral'
  | 'motor_sensory'
  | 'life_skills_preparation'
  | 'other';

export type GoalStatus = 'draft' | 'active' | 'achieved' | 'modified' | 'discontinued';
export type ObjectiveStatus = 'not_started' | 'in_progress' | 'achieved' | 'modified' | 'discontinued';

export type ServiceType = 
  | 'speech_language_therapy'
  | 'occupational_therapy'
  | 'physical_therapy'
  | 'counseling'
  | 'specialized_instruction'
  | 'consultation'
  | 'aac_support'
  | 'other';

export type ServiceDeliveryModel = 'direct' | 'consultation' | 'collaborative' | 'indirect';

export type ServiceSetting = 
  | 'general_education'
  | 'resource_room'
  | 'self_contained'
  | 'home'
  | 'community'
  | 'therapy_room';

export type ServiceFrequencyPeriod = 'daily' | 'weekly' | 'monthly';

export type AccommodationType = 
  | 'visual_support'
  | 'aac_device'
  | 'modified_materials'
  | 'extended_time'
  | 'simplified_language'
  | 'environmental_modification'
  | 'other';

export type ProgressStatus = 
  | 'significant_progress'
  | 'making_progress'
  | 'limited_progress'
  | 'no_progress'
  | 'regression'
  | 'goal_met';

export type MeetingType = 
  | 'initial_evaluation'
  | 'annual_review'
  | 'reevaluation'
  | 'amendment'
  | 'transition_planning'
  | 'progress_review';

export type ConsentType = 
  | 'initial_evaluation'
  | 'reevaluation'
  | 'placement'
  | 'release_of_information'
  | 'service_provision';

export type TransitionArea = 'education' | 'employment' | 'independent_living' | 'community';

export type TeamMemberRole = 
  | 'parent_guardian'
  | 'student'
  | 'homeroom_teacher'
  | 'special_education_teacher'
  | 'general_education_teacher'
  | 'speech_language_pathologist'
  | 'occupational_therapist'
  | 'physical_therapist'
  | 'psychologist'
  | 'administrator'
  | 'case_manager'
  | 'external_provider'
  | 'other';

export type AssessmentSourceType = 
  | 'standardized_test'
  | 'structured_observation'
  | 'parent_questionnaire'
  | 'teacher_input'
  | 'curriculum_based'
  | 'behavioral_records';

// =============================================================================
// ENTITY TYPES
// =============================================================================

export interface Program {
  id: string;
  studentId: string;
  framework: ProgramFramework;
  programYear: string;
  status: ProgramStatus;
  dueDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  approvalDate?: string | null;
  leastRestrictiveEnvironment?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileDomain {
  id: string;
  programId: string;
  domainType: ProfileDomainType;
  presentLevels?: string | null;
  strengths?: string | null;
  needs?: string | null;
  parentInput?: string | null;
  educationalImpact?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BaselineMeasurement {
  id: string;
  profileDomainId: string;
  measurementName: string;
  measurementValue: string;
  measurementUnit?: string | null;
  measurementDate?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface AssessmentSource {
  id: string;
  profileDomainId: string;
  sourceType: AssessmentSourceType;
  sourceName: string;
  assessmentDate?: string | null;
  assessor?: string | null;
  findings?: string | null;
  documentUrl?: string | null;
  createdAt: string;
}

export interface Goal {
  id: string;
  programId: string;
  profileDomainId?: string | null;
  goalNumber?: number | null;
  title: string;
  description?: string | null;
  goalStatement?: string | null;
  smartSpecific?: Record<string, any> | null;
  smartMeasurable?: Record<string, any> | null;
  smartAchievable?: Record<string, any> | null;
  smartRelevant?: Record<string, any> | null;
  smartTimeBound?: Record<string, any> | null;
  baselineLevel?: string | null;
  targetLevel?: string | null;
  targetDate?: string | null;
  status: GoalStatus;
  achievedDate?: string | null;
  currentProgress?: number | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Objective {
  id: string;
  goalId: string;
  objectiveNumber?: number | null;
  description: string;
  criteria?: string | null;
  targetDate?: string | null;
  status: ObjectiveStatus;
  achievedDate?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Service {
  id: string;
  programId: string;
  serviceType: ServiceType;
  serviceName: string;
  description?: string | null;
  frequency?: number | null;
  frequencyPeriod?: ServiceFrequencyPeriod | null;
  durationMinutes?: number | null;
  setting?: ServiceSetting | null;
  deliveryModel?: ServiceDeliveryModel | null;
  provider?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  isActive: boolean;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceGoal {
  id: string;
  serviceId: string;
  goalId: string;
  createdAt: string;
}

export interface Accommodation {
  id: string;
  programId: string;
  serviceId?: string | null;
  accommodationType: AccommodationType;
  description: string;
  isRequired: boolean;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProgressReport {
  id: string;
  programId: string;
  reportDate: string;
  reportingPeriod?: string | null;
  overallNarrative?: string | null;
  sharedWithParents: boolean;
  sharedDate?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalProgressEntry {
  id: string;
  progressReportId: string;
  goalId: string;
  progressStatus: ProgressStatus;
  progressNarrative?: string | null;
  dataPointsSummary?: string | null;
  createdAt: string;
}

export interface DataPoint {
  id: string;
  goalId: string;
  objectiveId?: string | null;
  progressEntryId?: string | null;
  recordedAt: string;
  numericValue?: number | null;
  textValue?: string | null;
  recordedBy?: string | null;
  sessionNotes?: string | null;
  createdAt: string;
}

export interface TransitionPlan {
  id: string;
  programId: string;
  effectiveAge?: number | null;
  assessmentsCompleted?: Record<string, any> | null;
  studentVision?: string | null;
  parentVision?: string | null;
  courseOfStudy?: string | null;
  agencyInvolvement?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionGoal {
  id: string;
  transitionPlanId: string;
  area: TransitionArea;
  goalStatement: string;
  activities?: string | null;
  timeline?: string | null;
  responsibleParty?: string | null;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: string;
  programId: string;
  userId?: string | null;
  name: string;
  email?: string | null;
  role: TeamMemberRole;
  title?: string | null;
  organization?: string | null;
  phone?: string | null;
  isCoordinator: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Meeting {
  id: string;
  programId: string;
  meetingType: MeetingType;
  meetingDate: string;
  location?: string | null;
  attendees?: string[] | null;
  agenda?: string | null;
  minutes?: string | null;
  decisions?: string | null;
  parentConcerns?: string | null;
  parentPriorities?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConsentForm {
  id: string;
  programId: string;
  consentType: ConsentType;
  requestDate?: string | null;
  responseDate?: string | null;
  isSigned: boolean;
  signedBy?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// COMPOSITE TYPES
// =============================================================================

export interface ProgramWithDetails {
  program: Program;
  student: {
    id: string;
    name: string;
    [key: string]: any;
  };
  domains: ProfileDomain[];
  goals: Goal[];
  services: Service[];
  accommodations: Accommodation[];
  progressReports: ProgressReport[];
  transitionPlan: TransitionPlan | null;
  teamMembers: TeamMember[];
  meetings: Meeting[];
  consentForms: ConsentForm[];
}

export interface GoalWithContext {
  goal: Goal;
  domainName?: string | null;
  objectives: Objective[];
  latestProgress?: GoalProgressEntry | null;
  dataPointCount: number;
}

export interface StudentWithProgramSummary {
  id: string;
  name: string;
  currentProgram?: {
    id: string;
    framework: ProgramFramework;
    programYear: string;
    status: ProgramStatus;
    goalsCount: number;
    goalsCompleted: number;
    overallProgress: number;
  } | null;
  [key: string]: any;
}

export interface OverviewStats {
  totalStudents: number;
  activeCases: number;
  completedCases: number;
  pendingReview: number;
  upcomingDeadlines: number;
}

export interface ComplianceStatus {
  isComplete: boolean;
  missingConsents: ConsentType[];
  existingConsents: ConsentForm[];
}

export interface ProgramStats {
  activeGoals: number;
  achievedGoals: number;
  totalGoals: number;
  goalProgress: number;
  totalServiceMinutes: number;
  activeTeamMembers: number;
}

// =============================================================================
// FORM TYPES
// =============================================================================

export interface GoalFormData {
  title: string;
  description: string;
  profileDomainId: string;
  baselineLevel: string;
  targetLevel: string;
  targetDate: string;
}

export interface ObjectiveFormData {
  description: string;
  criteria: string;
  targetDate: string;
}

export interface ServiceFormData {
  serviceType: ServiceType;
  serviceName: string;
  description: string;
  frequency: number;
  frequencyPeriod: string;
  durationMinutes: number;
  setting: string;
  deliveryModel: string;
  provider: string;
}

export interface DataPointFormData {
  numericValue: string;
  textValue: string;
  sessionNotes: string;
}

export interface TeamMemberFormData {
  name: string;
  email: string;
  role: TeamMemberRole;
  title: string;
  phone: string;
  isCoordinator: boolean;
}

export interface ProgramFormData {
  framework: ProgramFramework;
  programYear: string;
}

// =============================================================================
// UI CONSTANTS
// =============================================================================

export const DOMAIN_ORDER: ProfileDomainType[] = [
  'cognitive_academic',
  'communication_language',
  'social_emotional_behavioral',
  'motor_sensory',
  'life_skills_preparation',
  'other',
];

export const ALL_GOAL_STATUSES: GoalStatus[] = [
  'draft',
  'active',
  'achieved',
  'modified',
  'discontinued',
];

export const ALL_OBJECTIVE_STATUSES: ObjectiveStatus[] = [
  'not_started',
  'in_progress',
  'achieved',
  'modified',
  'discontinued',
];

export const ALL_SERVICE_TYPES: ServiceType[] = [
  'speech_language_therapy',
  'occupational_therapy',
  'physical_therapy',
  'counseling',
  'specialized_instruction',
  'consultation',
  'aac_support',
  'other',
];

export const ALL_TEAM_ROLES: TeamMemberRole[] = [
  'parent_guardian',
  'student',
  'homeroom_teacher',
  'special_education_teacher',
  'general_education_teacher',
  'speech_language_pathologist',
  'occupational_therapist',
  'physical_therapist',
  'psychologist',
  'administrator',
  'case_manager',
  'external_provider',
  'other',
];

export const ALL_MEETING_TYPES: MeetingType[] = [
  'initial_evaluation',
  'annual_review',
  'reevaluation',
  'amendment',
  'transition_planning',
  'progress_review',
];

export const ALL_CONSENT_TYPES: ConsentType[] = [
  'initial_evaluation',
  'reevaluation',
  'placement',
  'release_of_information',
  'service_provision',
];