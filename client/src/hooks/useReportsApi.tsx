// src/hooks/useReportsApi.tsx
// Custom hooks for Reports API operations (Medical, Functional, Educational)
// All types imported from @shared/schema (single source of truth)

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import type {
  MedicalRecord,
  InsertMedicalRecord,
  UpdateMedicalRecord,
  FunctionalReport,
  InsertFunctionalReport,
  UpdateFunctionalReport,
  EducationalReport,
  InsertEducationalReport,
  UpdateEducationalReport,
  ReportStatus,
} from '@shared/schema';

// Composite type for all reports summary
export interface AllReportsSummary {
  medicalRecords: MedicalRecord[];
  functionalReports: FunctionalReport[];
  educationalReports: EducationalReport[];
  access: {
    hasMedicalRights: boolean;
    hasEducationalRights: boolean;
  };
}

// Re-export types for convenience
export type {
  MedicalRecord,
  FunctionalReport,
  EducationalReport,
  ReportStatus,
};

// =============================================================================
// QUERY HOOKS
// =============================================================================

/**
 * Fetch all reports for a student
 */
export function useAllReports(studentId: string | undefined, instituteId?: string, enabled: boolean = true) {
  return useQuery<AllReportsSummary>({
    queryKey: ['/api/students', studentId, 'reports', instituteId],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const qs = instituteId ? `?instituteId=${instituteId}` : '';
      const response = await apiRequest('GET', `/api/students/${studentId}/reports${qs}`);
      if (!response.ok) throw new Error('Failed to fetch reports');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch current (non-archived) reports for a student
 */
export function useCurrentReports(studentId: string | undefined, instituteId?: string, enabled: boolean = true) {
  return useQuery<{
    medicalRecord: MedicalRecord | null;
    functionalReport: FunctionalReport | null;
    educationalReport: EducationalReport | null;
    access: {
      hasMedicalRights: boolean;
      hasEducationalRights: boolean;
    };
  }>({
    queryKey: ['/api/students', studentId, 'reports', 'current', instituteId],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const qs = instituteId ? `?instituteId=${instituteId}` : '';
      const response = await apiRequest('GET', `/api/students/${studentId}/reports/current${qs}`);
      if (!response.ok) throw new Error('Failed to fetch current reports');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

// =============================================================================
// MEDICAL RECORD HOOKS
// =============================================================================

/**
 * Fetch all medical records for a student
 */
export function useMedicalRecords(studentId: string | undefined, enabled: boolean = true) {
  return useQuery<{ records: MedicalRecord[] }>({
    queryKey: ['/api/students', studentId, 'reports', 'medical'],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${studentId}/reports/medical`);
      if (!response.ok) throw new Error('Failed to fetch medical records');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch current medical record for a student
 */
export function useCurrentMedicalRecord(
  studentId: string | undefined, 
  instituteId?: string,
  enabled: boolean = true
) {
  return useQuery<{ record: MedicalRecord } | null>({
    queryKey: ['/api/students', studentId, 'reports', 'medical', 'current', instituteId],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const url = instituteId 
        ? `/api/students/${studentId}/reports/medical/current?instituteId=${instituteId}`
        : `/api/students/${studentId}/reports/medical/current`;
      const response = await apiRequest('GET', url);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Failed to fetch medical record');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch archived medical records for a student
 */
export function useArchivedMedicalRecords(
  studentId: string | undefined,
  instituteId?: string,
  enabled: boolean = true
) {
  return useQuery<{ records: MedicalRecord[] }>({
    queryKey: ['/api/students', studentId, 'reports', 'medical', 'archived', instituteId],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const url = instituteId
        ? `/api/students/${studentId}/reports/medical/archived?instituteId=${instituteId}`
        : `/api/students/${studentId}/reports/medical/archived`;
      const response = await apiRequest('GET', url);
      if (!response.ok) throw new Error('Failed to fetch archived medical records');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch a specific medical record by ID
 */
export function useMedicalRecordById(recordId: string | undefined, enabled: boolean = true) {
  return useQuery<{ record: MedicalRecord }>({
    queryKey: ['/api/medical-records', recordId],
    queryFn: async () => {
      if (!recordId) throw new Error('No record ID');
      const response = await apiRequest('GET', `/api/medical-records/${recordId}`);
      if (!response.ok) throw new Error('Failed to fetch medical record');
      return response.json();
    },
    enabled: !!recordId && enabled,
  });
}

// =============================================================================
// FUNCTIONAL REPORT HOOKS
// =============================================================================

/**
 * Fetch all functional reports for a student
 */
export function useFunctionalReports(studentId: string | undefined, enabled: boolean = true) {
  return useQuery<{ reports: FunctionalReport[] }>({
    queryKey: ['/api/students', studentId, 'reports', 'functional'],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${studentId}/reports/functional`);
      if (!response.ok) throw new Error('Failed to fetch functional reports');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch current functional report for a student
 */
export function useCurrentFunctionalReport(studentId: string | undefined, enabled: boolean = true) {
  return useQuery<{ report: FunctionalReport } | null>({
    queryKey: ['/api/students', studentId, 'reports', 'functional', 'current'],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${studentId}/reports/functional/current`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Failed to fetch functional report');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch archived functional reports for a student
 */
export function useArchivedFunctionalReports(studentId: string | undefined, enabled: boolean = true) {
  return useQuery<{ reports: FunctionalReport[] }>({
    queryKey: ['/api/students', studentId, 'reports', 'functional', 'archived'],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${studentId}/reports/functional/archived`);
      if (!response.ok) throw new Error('Failed to fetch archived functional reports');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch a specific functional report by ID
 */
export function useFunctionalReportById(reportId: string | undefined, enabled: boolean = true) {
  return useQuery<{ report: FunctionalReport }>({
    queryKey: ['/api/functional-reports', reportId],
    queryFn: async () => {
      if (!reportId) throw new Error('No report ID');
      const response = await apiRequest('GET', `/api/functional-reports/${reportId}`);
      if (!response.ok) throw new Error('Failed to fetch functional report');
      return response.json();
    },
    enabled: !!reportId && enabled,
  });
}

// =============================================================================
// EDUCATIONAL REPORT HOOKS
// =============================================================================

/**
 * Fetch all educational reports for a student
 */
export function useEducationalReports(studentId: string | undefined, enabled: boolean = true) {
  return useQuery<{ reports: EducationalReport[] }>({
    queryKey: ['/api/students', studentId, 'reports', 'educational'],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${studentId}/reports/educational`);
      if (!response.ok) throw new Error('Failed to fetch educational reports');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch current educational report for a student
 */
export function useCurrentEducationalReport(studentId: string | undefined, enabled: boolean = true) {
  return useQuery<{ report: EducationalReport } | null>({
    queryKey: ['/api/students', studentId, 'reports', 'educational', 'current'],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${studentId}/reports/educational/current`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Failed to fetch educational report');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch archived educational reports for a student
 */
export function useArchivedEducationalReports(studentId: string | undefined, enabled: boolean = true) {
  return useQuery<{ reports: EducationalReport[] }>({
    queryKey: ['/api/students', studentId, 'reports', 'educational', 'archived'],
    queryFn: async () => {
      if (!studentId) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${studentId}/reports/educational/archived`);
      if (!response.ok) throw new Error('Failed to fetch archived educational reports');
      return response.json();
    },
    enabled: !!studentId && enabled,
  });
}

/**
 * Fetch a specific educational report by ID
 */
export function useEducationalReportById(reportId: string | undefined, enabled: boolean = true) {
  return useQuery<{ report: EducationalReport }>({
    queryKey: ['/api/educational-reports', reportId],
    queryFn: async () => {
      if (!reportId) throw new Error('No report ID');
      const response = await apiRequest('GET', `/api/educational-reports/${reportId}`);
      if (!response.ok) throw new Error('Failed to fetch educational report');
      return response.json();
    },
    enabled: !!reportId && enabled,
  });
}

// =============================================================================
// MUTATION HOOKS
// =============================================================================

/**
 * Hook for report mutations with toast notifications
 */
export function useReportMutations(studentId: string | undefined) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const invalidateReports = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/students', studentId, 'reports'] });
  };

  // ==========================================================================
  // MEDICAL RECORD MUTATIONS
  // ==========================================================================

  const createMedicalRecord = useMutation<MedicalRecord, Error, Partial<InsertMedicalRecord>>({
    mutationFn: async (data) => {
      const response = await apiRequest('POST', `/api/students/${studentId}/reports/medical`, data);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create medical record');
      }
      const result = await response.json();
      return result.record;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.medical.created'), description: t('reports.medical.createdDesc') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const updateMedicalRecord = useMutation<MedicalRecord, Error, { recordId: string; updates: UpdateMedicalRecord }>({
    mutationFn: async ({ recordId, updates }) => {
      const response = await apiRequest('PATCH', `/api/medical-records/${recordId}`, updates);
      if (!response.ok) throw new Error('Failed to update medical record');
      const result = await response.json();
      return result.record;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.medical.updated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const finalizeMedicalRecord = useMutation<MedicalRecord, Error, string>({
    mutationFn: async (recordId) => {
      const response = await apiRequest('POST', `/api/medical-records/${recordId}/finalize`);
      if (!response.ok) throw new Error('Failed to finalize medical record');
      const result = await response.json();
      return result.record;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.medical.finalized'), description: t('reports.medical.finalizedDesc') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const createMedicalRecordRevision = useMutation<MedicalRecord, Error, string>({
    mutationFn: async (recordId) => {
      const response = await apiRequest('POST', `/api/medical-records/${recordId}/revision`);
      if (!response.ok) throw new Error('Failed to create medical record revision');
      const result = await response.json();
      return result.record;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.medical.revisionCreated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const deleteMedicalRecord = useMutation<void, Error, string>({
    mutationFn: async (recordId) => {
      const response = await apiRequest('DELETE', `/api/medical-records/${recordId}`);
      if (!response.ok) throw new Error('Failed to delete medical record');
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.medical.deleted') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // ==========================================================================
  // FUNCTIONAL REPORT MUTATIONS
  // ==========================================================================

  const createFunctionalReport = useMutation<FunctionalReport, Error, Partial<InsertFunctionalReport>>({
    mutationFn: async (data) => {
      const response = await apiRequest('POST', `/api/students/${studentId}/reports/functional`, data);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create functional report');
      }
      const result = await response.json();
      return result.report;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.functional.created'), description: t('reports.functional.createdDesc') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const updateFunctionalReport = useMutation<FunctionalReport, Error, { reportId: string; updates: UpdateFunctionalReport }>({
    mutationFn: async ({ reportId, updates }) => {
      const response = await apiRequest('PATCH', `/api/functional-reports/${reportId}`, updates);
      if (!response.ok) throw new Error('Failed to update functional report');
      const result = await response.json();
      return result.report;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.functional.updated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const finalizeFunctionalReport = useMutation<FunctionalReport, Error, string>({
    mutationFn: async (reportId) => {
      const response = await apiRequest('POST', `/api/functional-reports/${reportId}/finalize`);
      if (!response.ok) throw new Error('Failed to finalize functional report');
      const result = await response.json();
      return result.report;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.functional.finalized'), description: t('reports.functional.finalizedDesc') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const createFunctionalReportRevision = useMutation<FunctionalReport, Error, string>({
    mutationFn: async (reportId) => {
      const response = await apiRequest('POST', `/api/functional-reports/${reportId}/revision`);
      if (!response.ok) throw new Error('Failed to create functional report revision');
      const result = await response.json();
      return result.report;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.functional.revisionCreated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const deleteFunctionalReport = useMutation<void, Error, string>({
    mutationFn: async (reportId) => {
      const response = await apiRequest('DELETE', `/api/functional-reports/${reportId}`);
      if (!response.ok) throw new Error('Failed to delete functional report');
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.functional.deleted') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // ==========================================================================
  // EDUCATIONAL REPORT MUTATIONS
  // ==========================================================================

  const createEducationalReport = useMutation<EducationalReport, Error, Partial<InsertEducationalReport>>({
    mutationFn: async (data) => {
      const response = await apiRequest('POST', `/api/students/${studentId}/reports/educational`, data);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create educational report');
      }
      const result = await response.json();
      return result.report;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.educational.created'), description: t('reports.educational.createdDesc') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const updateEducationalReport = useMutation<EducationalReport, Error, { reportId: string; updates: UpdateEducationalReport }>({
    mutationFn: async ({ reportId, updates }) => {
      const response = await apiRequest('PATCH', `/api/educational-reports/${reportId}`, updates);
      if (!response.ok) throw new Error('Failed to update educational report');
      const result = await response.json();
      return result.report;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.educational.updated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const finalizeEducationalReport = useMutation<EducationalReport, Error, string>({
    mutationFn: async (reportId) => {
      const response = await apiRequest('POST', `/api/educational-reports/${reportId}/finalize`);
      if (!response.ok) throw new Error('Failed to finalize educational report');
      const result = await response.json();
      return result.report;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.educational.finalized'), description: t('reports.educational.finalizedDesc') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const createEducationalReportRevision = useMutation<EducationalReport, Error, string>({
    mutationFn: async (reportId) => {
      const response = await apiRequest('POST', `/api/educational-reports/${reportId}/revision`);
      if (!response.ok) throw new Error('Failed to create educational report revision');
      const result = await response.json();
      return result.report;
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.educational.revisionCreated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const deleteEducationalReport = useMutation<void, Error, string>({
    mutationFn: async (reportId) => {
      const response = await apiRequest('DELETE', `/api/educational-reports/${reportId}`);
      if (!response.ok) throw new Error('Failed to delete educational report');
    },
    onSuccess: () => {
      invalidateReports();
      toast({ title: t('reports.educational.deleted') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  return {
    // Medical record mutations
    createMedicalRecord,
    updateMedicalRecord,
    finalizeMedicalRecord,
    createMedicalRecordRevision,
    deleteMedicalRecord,
    // Functional report mutations
    createFunctionalReport,
    updateFunctionalReport,
    finalizeFunctionalReport,
    createFunctionalReportRevision,
    deleteFunctionalReport,
    // Educational report mutations
    createEducationalReport,
    updateEducationalReport,
    finalizeEducationalReport,
    createEducationalReportRevision,
    deleteEducationalReport,
  };
}
