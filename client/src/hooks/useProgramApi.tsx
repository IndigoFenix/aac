// src/hooks/useProgramApi.ts
// Custom hooks for IEP/TALA Program API operations
// All types imported from @shared/schema (single source of truth)

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import type {
  Program,
  ProfileDomain,
  Goal,
  Objective,
  Service,
  Accommodation,
  TeamMember,
  Meeting,
  ConsentForm,
  ProgressReport,
  DataPoint,
  InsertProgram,
  InsertGoal,
  UpdateGoal,
  InsertObjective,
  InsertService,
  UpdateService,
  InsertDataPoint,
  InsertTeamMember,
  InsertMeeting,
  InsertProgressReport,
  UpdateProfileDomain,
} from '@shared/schema';

// Composite type for full program details (not in schema, defined locally)
export interface ProgramWithDetails {
  program: Program;
  domains: ProfileDomain[];
  goals: Goal[];
  services: Service[];
  accommodations: Accommodation[];
  teamMembers: TeamMember[];
  meetings: Meeting[];
  consentForms: ConsentForm[];
  progressReports: ProgressReport[];
}

// Re-export types for convenience
export type {
  Program,
  ProfileDomain,
  Goal,
  Objective,
  Service,
  Accommodation,
  TeamMember,
  Meeting,
  ConsentForm,
  ProgressReport,
  DataPoint,
};

// =============================================================================
// QUERY HOOKS
// =============================================================================

/**
 * Fetch the current active program for a student
 */
export function useCurrentProgram(studentId: string | undefined, enabled: boolean = true) {
  return useQuery<{ program: Program } | null>({
    queryKey: ['/api/students', studentId, 'programs', 'current'],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${studentId}/programs/current`);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error('Failed to fetch program');
      }
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch full program details including all related entities
 */
export function useProgramDetails(programId: string | undefined, enabled: boolean = true) {
  return useQuery<ProgramWithDetails>({
    queryKey: ['/api/programs', programId, 'full'],
    queryFn: async () => {
      if (!programId) throw new Error('No program');
      const response = await apiRequest('GET', `/api/programs/${programId}/full`);
      if (!response.ok) throw new Error('Failed to fetch program details');
      return response.json();
    },
    enabled: !!programId && enabled,
  });
}

/**
 * Fetch all programs for a student (for history)
 */
export function useStudentPrograms(studentId: string | undefined, enabled: boolean = true) {
  return useQuery<{ programs: Program[] }>({
    queryKey: ['/api/students', studentId, 'programs'],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${studentId}/programs`);
      if (!response.ok) throw new Error('Failed to fetch programs');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch goals for a program
 */
export function useProgramGoals(programId: string | undefined, enabled: boolean = true) {
  return useQuery<Goal[]>({
    queryKey: ['/api/programs', programId, 'goals'],
    queryFn: async () => {
      if (!programId) throw new Error('No program');
      const response = await apiRequest('GET', `/api/programs/${programId}/goals`);
      if (!response.ok) throw new Error('Failed to fetch goals');
      return response.json();
    },
    enabled: !!programId && enabled,
  });
}

/**
 * Fetch a single goal with context (objectives, data points, etc.)
 */
export function useGoalWithContext(goalId: string | undefined, enabled: boolean = true) {
  return useQuery<Goal & { objectives: Objective[]; dataPoints: DataPoint[] }>({
    queryKey: ['/api/goals', goalId, 'context'],
    queryFn: async () => {
      if (!goalId) throw new Error('No goal');
      const response = await apiRequest('GET', `/api/goals/${goalId}`);
      if (!response.ok) throw new Error('Failed to fetch goal');
      return response.json();
    },
    enabled: !!goalId && enabled,
  });
}

/**
 * Fetch data points for a goal
 */
export function useGoalDataPoints(goalId: string | undefined, enabled: boolean = true) {
  return useQuery<DataPoint[]>({
    queryKey: ['/api/goals', goalId, 'data-points'],
    queryFn: async () => {
      if (!goalId) throw new Error('No goal');
      const response = await apiRequest('GET', `/api/goals/${goalId}/data-points`);
      if (!response.ok) throw new Error('Failed to fetch data points');
      return response.json();
    },
    enabled: !!goalId && enabled,
  });
}

/**
 * Fetch compliance status for a program
 */
export function useProgramCompliance(programId: string | undefined, enabled: boolean = true) {
  return useQuery<{
    hasTeamMembers: boolean;
    hasGoals: boolean;
    hasServices: boolean;
    consentFormsComplete: boolean;
    meetingsScheduled: boolean;
  }>({
    queryKey: ['/api/programs', programId, 'compliance'],
    queryFn: async () => {
      if (!programId) throw new Error('No program');
      const response = await apiRequest('GET', `/api/programs/${programId}/compliance`);
      if (!response.ok) throw new Error('Failed to fetch compliance');
      return response.json();
    },
    enabled: !!programId && enabled,
  });
}

// =============================================================================
// MUTATION HOOKS
// =============================================================================

/**
 * Hook for program mutations with toast notifications
 */
export function useProgramMutations(studentId: string | undefined, programId: string | undefined) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const invalidateProgram = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
    queryClient.invalidateQueries({ queryKey: ['/api/students', studentId, 'programs'] });
  };

  // Create program
  const createProgram = useMutation<Program, Error, InsertProgram>({
    mutationFn: async (data) => {
      const response = await apiRequest('POST', `/api/students/${studentId}/programs`, {
        ...data,
        createDefaultDomains: true,
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create program');
      }
      return response.json();
    },
    onSuccess: () => {
      invalidateProgram();
      toast({ title: t('program.created'), description: t('program.createdDesc') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Activate program
  const activateProgram = useMutation<Program, Error, void>({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/programs/${programId}/activate`);
      if (!response.ok) throw new Error('Failed to activate program');
      return response.json();
    },
    onSuccess: () => {
      invalidateProgram();
      toast({ title: t('program.activated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Archive program
  const archiveProgram = useMutation<Program, Error, void>({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/programs/${programId}/archive`);
      if (!response.ok) throw new Error('Failed to archive program');
      return response.json();
    },
    onSuccess: () => {
      invalidateProgram();
      toast({ title: t('program.archived') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Update domain
  const updateDomain = useMutation<ProfileDomain, Error, { domainId: string; updates: UpdateProfileDomain }>({
    mutationFn: async ({ domainId, updates }) => {
      const response = await apiRequest('PATCH', `/api/domains/${domainId}`, updates);
      if (!response.ok) throw new Error('Failed to update domain');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('common.saved') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create goal
  const createGoal = useMutation<Goal, Error, InsertGoal>({
    mutationFn: async (goalData) => {
      const response = await apiRequest('POST', `/api/programs/${programId}/goals`, goalData);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create goal');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('goal.created') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Update goal
  const updateGoal = useMutation<Goal, Error, { goalId: string; updates: UpdateGoal }>({
    mutationFn: async ({ goalId, updates }) => {
      const response = await apiRequest('PATCH', `/api/goals/${goalId}`, updates);
      if (!response.ok) throw new Error('Failed to update goal');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('goal.updated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Delete goal
  const deleteGoal = useMutation<void, Error, string>({
    mutationFn: async (goalId) => {
      const response = await apiRequest('DELETE', `/api/goals/${goalId}`);
      if (!response.ok) throw new Error('Failed to delete goal');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('goal.deleted') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create objective
  const createObjective = useMutation<Objective, Error, { goalId: string; data: InsertObjective }>({
    mutationFn: async ({ goalId, data }) => {
      const response = await apiRequest('POST', `/api/goals/${goalId}/objectives`, data);
      if (!response.ok) throw new Error('Failed to create objective');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('objective.created') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create service
  const createService = useMutation<Service, Error, InsertService>({
    mutationFn: async (serviceData) => {
      const response = await apiRequest('POST', `/api/programs/${programId}/services`, serviceData);
      if (!response.ok) throw new Error('Failed to create service');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('service.created') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Update service
  const updateService = useMutation<Service, Error, { serviceId: string; updates: UpdateService }>({
    mutationFn: async ({ serviceId, updates }) => {
      const response = await apiRequest('PATCH', `/api/services/${serviceId}`, updates);
      if (!response.ok) throw new Error('Failed to update service');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('service.updated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Delete service
  const deleteService = useMutation<void, Error, string>({
    mutationFn: async (serviceId) => {
      const response = await apiRequest('DELETE', `/api/services/${serviceId}`);
      if (!response.ok) throw new Error('Failed to delete service');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('service.deleted') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create data point
  const createDataPoint = useMutation<DataPoint, Error, { goalId: string; data: InsertDataPoint }>({
    mutationFn: async ({ goalId, data }) => {
      const response = await apiRequest('POST', `/api/goals/${goalId}/data-points`, data);
      if (!response.ok) throw new Error('Failed to create data point');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('dataPoint.created') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create team member
  const createTeamMember = useMutation<TeamMember, Error, InsertTeamMember>({
    mutationFn: async (data) => {
      const response = await apiRequest('POST', `/api/programs/${programId}/team`, data);
      if (!response.ok) throw new Error('Failed to add team member');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('team.memberAdded') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Delete team member
  const deleteTeamMember = useMutation<void, Error, string>({
    mutationFn: async (memberId) => {
      const response = await apiRequest('DELETE', `/api/team-members/${memberId}`);
      if (!response.ok) throw new Error('Failed to remove team member');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('team.memberRemoved') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create progress report
  const createProgressReport = useMutation<ProgressReport, Error, InsertProgressReport>({
    mutationFn: async (data) => {
      const response = await apiRequest('POST', `/api/programs/${programId}/progress-reports`, data);
      if (!response.ok) throw new Error('Failed to create progress report');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('progressReport.created') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create meeting
  const createMeeting = useMutation<Meeting, Error, InsertMeeting>({
    mutationFn: async (data) => {
      const response = await apiRequest('POST', `/api/programs/${programId}/meetings`, data);
      if (!response.ok) throw new Error('Failed to create meeting');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', programId, 'full'] });
      toast({ title: t('meeting.created') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  return {
    createProgram,
    activateProgram,
    archiveProgram,
    updateDomain,
    createGoal,
    updateGoal,
    deleteGoal,
    createObjective,
    createService,
    updateService,
    deleteService,
    createDataPoint,
    createTeamMember,
    deleteTeamMember,
    createProgressReport,
    createMeeting,
  };
}

// =============================================================================
// UTILITY HOOKS
// =============================================================================

/**
 * Calculate program statistics using schema-aligned field names
 */
export function useProgramStats(goals: Goal[], services: Service[], teamMembers: TeamMember[]) {
  return {
    activeGoals: goals.filter(g => g.status === 'active').length,
    achievedGoals: goals.filter(g => g.status === 'achieved').length,
    totalGoals: goals.length,
    goalProgress: goals.length > 0 
      ? Math.round((goals.filter(g => g.status === 'achieved').length / goals.length) * 100) 
      : 0,
    // Uses correct schema field names: frequencyCount, sessionDuration
    totalServiceMinutes: services
      .filter(s => s.isActive)
      .reduce((sum, s) => {
        const freq = s.frequencyCount || 1;
        const duration = s.sessionDuration || 30;
        const periodsPerWeek = s.frequencyPeriod === 'daily' ? 5 : s.frequencyPeriod === 'weekly' ? 1 : 0.25;
        return sum + (freq * duration * periodsPerWeek);
      }, 0),
    activeTeamMembers: teamMembers.filter(m => m.isActive).length,
  };
}