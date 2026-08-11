// src/hooks/useInstitute.tsx
// React hook for institute management - Updated with classroom support

import { useState, useEffect, createContext, useContext, ReactNode, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useAuth } from '@/hooks/useAuth';
import { type LicensePermissions, DEFAULT_LICENSE_PERMISSIONS } from '@shared/license-permissions';

// =============================================================================
// TYPES
// =============================================================================

export interface Institute {
  id: string;
  name: string;
  type: 'school' | 'clinic' | 'family';
  description?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  logoUrl?: string;
  instituteIdNumber?: string;
  instituteIdType?: string;
  verificationStatus?: 'unverified' | 'pending' | 'verified';
  language?: string;
  isActive: boolean;
  isAdmin?: boolean;
  role?: string;
  membershipId?: string;
  licensePermissions?: LicensePermissions;
  licenseType?: string;
  isTrial?: boolean;
  trialExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityVerificationStatus {
  required: boolean;
  linked: boolean;
  expired: boolean;
  /** ISO timestamp when the link expires; null if no reverification enforced. */
  expiresAt: string | null;
  /** Negative when expired. Null if no reverification enforced. */
  daysUntilExpiry: number | null;
  provider?: { id: string; name: string; protocol: 'oidc' | 'oauth2' | 'saml' };
}

export interface InstituteMember {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  profileImageUrl?: string;
  role: string;
  isAdmin: boolean;
  membershipId: string;
  joinedAt: string;
}

export interface InstituteInvite {
  id: string;
  inviteeEmail: string;
  role: string;
  grantAdmin: boolean;
  message?: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
  expiresAt: string;
  createdAt: string;
}

export interface PendingInvite {
  id: string;
  institute: {
    id: string;
    name: string;
    type: 'school' | 'clinic' | 'family';
    logoUrl?: string;
  };
  invitedBy: {
    id: string;
    fullName?: string;
    email: string;
  } | null;
  role: string;
  grantAdmin: boolean;
  message?: string;
  expiresAt: string;
  createdAt: string;
}

// =============================================================================
// CLASSROOM TYPES
// =============================================================================

export interface Classroom {
  id: string;
  instituteId: string;
  name: string;
  // Nullable, not merely optional: these columns come back as null from the
  // server, and an update must be able to SEND null to clear one (undefined is
  // dropped by JSON.stringify, so the PATCH would keep the old value).
  grade?: string | null;
  description?: string | null;
  capacity?: number | null;
  roomNumber?: string | null;
  academicYear?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  // When fetched with membership
  role?: string;
  isPrimary?: boolean;
  membershipId?: string;
}

export interface ClassroomMember {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  profileImageUrl?: string;
  role: string;
  isPrimary: boolean;
  membershipId: string;
  assignedAt: string;
}

export interface ClassroomStudent {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  birthDate?: string;
  framework?: string;
  isPrimary: boolean;
  enrollmentDate?: string;
  notes?: string;
  enrollmentId: string;
}

// =============================================================================
// INSTITUTE STUDENT TYPES
// =============================================================================

export interface InstituteStudent {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  birthDate?: string;
  framework?: string;
  country?: string;
  idNumber?: string;
  grade?: string;
  enrollmentDate?: string;
  enrollmentId: string;
}

export interface StudentInstitute {
  id: string;
  name: string;
  type: 'school' | 'clinic' | 'family';
  logoUrl?: string;
  idNumber?: string;
  grade?: string;
  enrollmentDate?: string;
  exitDate?: string;
  exitReason?: string;
  isActive: boolean;
  enrollmentId: string;
}

// =============================================================================
// CONTEXT TYPE
// =============================================================================

interface InstituteContextType {
  // State
  institutes: Institute[];
  currentInstitute: Institute | null;
  /** License permissions for the currently selected institute (defaults if none selected) */
  currentPermissions: LicensePermissions;
  isLoading: boolean;
  error: string | null;

  // Institute operations
  selectInstitute: (instituteId: string | null) => void;
  createInstitute: (data: Partial<Institute> & { creatorRole?: string }) => Promise<Institute>;
  updateInstitute: (id: string, data: Partial<Institute>, logoFile?: File) => Promise<Institute>;
  deleteInstitute: (id: string) => Promise<void>;
  leaveInstitute: (id: string) => Promise<void>;

  // Member operations
  getMembers: (instituteId: string) => Promise<InstituteMember[]>;
  updateMember: (instituteId: string, userId: string, data: { role?: string; isAdmin?: boolean }) => Promise<void>;
  removeMember: (instituteId: string, userId: string) => Promise<void>;

  // Invite operations
  sendInvite: (instituteId: string, email: string, options?: { role?: string; grantAdmin?: boolean; message?: string }) => Promise<{ invite: InstituteInvite; inviteLink: string }>;
  getInvites: (instituteId: string) => Promise<InstituteInvite[]>;
  cancelInvite: (instituteId: string, inviteId: string) => Promise<void>;
  resendInvite: (instituteId: string, inviteId: string) => Promise<{ invite: InstituteInvite; inviteLink: string }>;

  // User's pending invites
  pendingInvites: PendingInvite[];
  acceptInvite: (inviteId: string) => Promise<void>;
  declineInvite: (inviteId: string) => Promise<void>;
  refetchPendingInvites: () => void;

  // Classroom operations
  getClassrooms: (instituteId: string) => Promise<Classroom[]>;
  createClassroom: (instituteId: string, data: Partial<Classroom>) => Promise<Classroom>;
  updateClassroom: (classroomId: string, data: Partial<Classroom>) => Promise<Classroom>;
  deleteClassroom: (classroomId: string) => Promise<void>;
  
  // Classroom member operations
  getClassroomMembers: (classroomId: string) => Promise<ClassroomMember[]>;
  addClassroomMember: (classroomId: string, userId: string, role: string, isPrimary?: boolean) => Promise<void>;
  updateClassroomMember: (classroomId: string, userId: string, data: { role?: string; isPrimary?: boolean }) => Promise<void>;
  removeClassroomMember: (classroomId: string, userId: string) => Promise<void>;
  
  // Classroom student operations
  getClassroomStudents: (classroomId: string) => Promise<ClassroomStudent[]>;
  addStudentToClassroom: (classroomId: string, studentId: string, options?: { isPrimary?: boolean; enrollmentDate?: string; notes?: string }) => Promise<void>;
  updateClassroomStudent: (classroomId: string, studentId: string, data: { isPrimary?: boolean; notes?: string }) => Promise<void>;
  removeStudentFromClassroom: (classroomId: string, studentId: string) => Promise<void>;

  // Institute student operations
  getInstituteStudents: (instituteId: string) => Promise<InstituteStudent[]>;
  addStudentToInstitute: (instituteId: string, studentId: string, options?: { enrollmentDate?: string; idNumber?: string; grade?: string }) => Promise<void>;
  // null clears the field — undefined would be dropped by JSON.stringify and
  // the server's merge would keep the old value.
  updateInstituteStudent: (instituteId: string, studentId: string, data: { idNumber?: string | null; grade?: string | null }) => Promise<void>;
  removeStudentFromInstitute: (instituteId: string, studentId: string, exitReason?: string) => Promise<void>;

  // Student's institutes
  getStudentInstitutes: (studentId: string) => Promise<StudentInstitute[]>;

  // Identity verification
  identityVerification: IdentityVerificationStatus | null;
  initiateIdentityLink: () => void;
  dismissIdentityPrompt: () => void;
  showIdentityPrompt: boolean;

  // Refetch
  refetchInstitutes: () => void;
}

// =============================================================================
// QUERY KEYS
// =============================================================================

const INSTITUTES_QUERY_KEY = ['/api/institutes'];
const PENDING_INVITES_QUERY_KEY = ['/api/invites/pending'];

// =============================================================================
// CONTEXT
// =============================================================================

const InstituteContext = createContext<InstituteContextType | null>(null);

export const useInstitute = () => {
  const context = useContext(InstituteContext);
  if (!context) {
    throw new Error('useInstitute must be used within an InstituteProvider');
  }
  return context;
};

// =============================================================================
// PROVIDER
// =============================================================================

export const InstituteProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [currentInstitute, setCurrentInstitute] = useState<Institute | null>(null);
  const [error, setError] = useState<string | null>(null);

  // localStorage key scoped to the current user
  const storageKey = user ? `cliniaacian.${user.id}.currentInstituteId` : null;

  // Fetch institutes
  const { data: institutesData, isLoading, refetch: refetchInstitutes } = useQuery({
    queryKey: INSTITUTES_QUERY_KEY,
    queryFn: async () => {
      const response = await apiRequest('GET', '/api/institutes');
      const data = await response.json();
      return data?.success && Array.isArray(data.institutes) ? data.institutes : [];
    },
    enabled: !!user,
  });

  const institutes: Institute[] = institutesData || [];

  // Fetch pending invites
  const { data: pendingInvitesData, refetch: refetchPendingInvites } = useQuery({
    queryKey: PENDING_INVITES_QUERY_KEY,
    queryFn: async () => {
      const response = await apiRequest('GET', '/api/invites/pending');
      const data = await response.json();
      return data?.success && Array.isArray(data.invites) ? data.invites : [];
    },
    enabled: !!user,
  });

  const pendingInvites: PendingInvite[] = pendingInvitesData || [];

  // Restore selected institute from localStorage, or auto-set if only one
  useEffect(() => {
    if (institutes.length > 0 && !currentInstitute && storageKey) {
      const storedId = localStorage.getItem(storageKey);
      if (storedId) {
        const found = institutes.find((i) => i.id === storedId);
        if (found) {
          setCurrentInstitute(found);
          return;
        }
      }
      // Auto-select if user belongs to exactly one institute
      if (institutes.length === 1) {
        setCurrentInstitute(institutes[0]);
        localStorage.setItem(storageKey, institutes[0].id);
      }
    }
  }, [institutes, currentInstitute, storageKey]);

  // =============================================================================
  // IDENTITY VERIFICATION
  // =============================================================================

  const [showIdentityPrompt, setShowIdentityPrompt] = useState(false);

  // Check identity verification status when current institute changes
  const { data: identityVerification } = useQuery<IdentityVerificationStatus | null>({
    queryKey: ['/api/identity/status', currentInstitute?.instituteIdType],
    queryFn: async () => {
      if (!currentInstitute?.instituteIdType) return null;
      const response = await apiRequest('GET', `/api/identity/status?instituteIdType=${currentInstitute.instituteIdType}`);
      return response.json();
    },
    enabled: !!user && !!currentInstitute?.instituteIdType,
  });

  // Show identity prompt when switching to a verified institute that requires linking
  useEffect(() => {
    if (!identityVerification) return;
    if (!identityVerification.required) return;
    if (identityVerification.linked && !identityVerification.expired) return;
    // Only prompt for verified institutes
    if (currentInstitute?.verificationStatus !== 'verified') return;
    setShowIdentityPrompt(true);
  }, [identityVerification, currentInstitute?.verificationStatus]);

  const initiateIdentityLink = useCallback(() => {
    if (!identityVerification?.provider?.id) return;
    const returnUrl = encodeURIComponent(window.location.pathname);
    window.location.href = `/api/identity/link/${identityVerification.provider.id}?returnUrl=${returnUrl}`;
  }, [identityVerification]);

  const dismissIdentityPrompt = useCallback(() => {
    setShowIdentityPrompt(false);
  }, []);

  // =============================================================================
  // INSTITUTE OPERATIONS
  // =============================================================================

  const selectInstitute = useCallback((instituteId: string | null) => {
    if (!instituteId) {
      setCurrentInstitute(null);
      if (storageKey) localStorage.removeItem(storageKey);
      return;
    }

    const found = institutes.find((i) => i.id === instituteId);
    if (found) {
      setCurrentInstitute(found);
      if (storageKey) localStorage.setItem(storageKey, instituteId);
    }
  }, [institutes, storageKey]);

  const createInstitute = useCallback(async (data: Partial<Institute> & { creatorRole?: string }): Promise<Institute> => {
    const { creatorRole, ...instituteData } = data;
    const response = await apiRequest('POST', '/api/institutes', {
      ...instituteData,
      creatorRole, // Pass the creator's role selection
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to create institute');
    }

    queryClient.invalidateQueries({ queryKey: INSTITUTES_QUERY_KEY });
    return result.institute;
  }, [queryClient]);

  const updateInstitute = useCallback(async (id: string, data: Partial<Institute>, logoFile?: File): Promise<Institute> => {
    let response: Response;
    if (logoFile) {
      // Use FormData when uploading a logo file — apiRequest handles FormData natively
      const formData = new FormData();
      formData.append('logo', logoFile);
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null) {
          formData.append(key, String(value));
        }
      }
      response = await apiRequest('PATCH', `/api/institutes/${id}`, formData);
    } else {
      response = await apiRequest('PATCH', `/api/institutes/${id}`, data);
    }
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to update institute');
    }

    queryClient.invalidateQueries({ queryKey: INSTITUTES_QUERY_KEY });

    if (currentInstitute?.id === id) {
      setCurrentInstitute({ ...currentInstitute, ...result.institute });
    }

    return result.institute;
  }, [queryClient, currentInstitute]);

  const deleteInstitute = useCallback(async (id: string): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/institutes/${id}`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to delete institute');
    }

    queryClient.invalidateQueries({ queryKey: INSTITUTES_QUERY_KEY });

    if (currentInstitute?.id === id) {
      setCurrentInstitute(null);
      if (storageKey) localStorage.removeItem(storageKey);
    }
  }, [queryClient, currentInstitute]);

  const leaveInstitute = useCallback(async (id: string): Promise<void> => {
    const response = await apiRequest('POST', `/api/institutes/${id}/leave`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to leave institute');
    }

    queryClient.invalidateQueries({ queryKey: INSTITUTES_QUERY_KEY });

    if (currentInstitute?.id === id) {
      setCurrentInstitute(null);
      if (storageKey) localStorage.removeItem(storageKey);
    }
  }, [queryClient, currentInstitute]);

  // =============================================================================
  // MEMBER OPERATIONS
  // =============================================================================

  const getMembers = useCallback(async (instituteId: string): Promise<InstituteMember[]> => {
    const response = await apiRequest('GET', `/api/institutes/${instituteId}/members`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch members');
    }

    return result.members || [];
  }, []);

  const updateMember = useCallback(async (
    instituteId: string,
    userId: string,
    data: { role?: string; isAdmin?: boolean }
  ): Promise<void> => {
    const response = await apiRequest('PATCH', `/api/institutes/${instituteId}/members/${userId}`, data);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to update member');
    }
  }, []);

  const removeMember = useCallback(async (instituteId: string, userId: string): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/institutes/${instituteId}/members/${userId}`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to remove member');
    }
  }, []);

  // =============================================================================
  // INVITE OPERATIONS
  // =============================================================================

  const sendInvite = useCallback(async (
    instituteId: string,
    email: string,
    options?: { role?: string; grantAdmin?: boolean; message?: string }
  ): Promise<{ invite: InstituteInvite; inviteLink: string }> => {
    const response = await apiRequest('POST', `/api/institutes/${instituteId}/invites`, {
      email,
      ...options,
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to send invite');
    }

    return { invite: result.invite, inviteLink: result.inviteLink };
  }, []);

  const getInvites = useCallback(async (instituteId: string): Promise<InstituteInvite[]> => {
    const response = await apiRequest('GET', `/api/institutes/${instituteId}/invites`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch invites');
    }

    return result.invites || [];
  }, []);

  const cancelInvite = useCallback(async (instituteId: string, inviteId: string): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/institutes/${instituteId}/invites/${inviteId}`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to cancel invite');
    }
  }, []);

  const resendInvite = useCallback(async (
    instituteId: string,
    inviteId: string
  ): Promise<{ invite: InstituteInvite; inviteLink: string }> => {
    const response = await apiRequest('POST', `/api/institutes/${instituteId}/invites/${inviteId}/resend`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to resend invite');
    }

    return { invite: result.invite, inviteLink: result.inviteLink };
  }, []);

  const acceptInvite = useCallback(async (inviteId: string): Promise<void> => {
    const response = await apiRequest('POST', `/api/invites/${inviteId}/accept`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to accept invite');
    }

    queryClient.invalidateQueries({ queryKey: INSTITUTES_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
  }, [queryClient]);

  const declineInvite = useCallback(async (inviteId: string): Promise<void> => {
    const response = await apiRequest('POST', `/api/invites/${inviteId}/decline`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to decline invite');
    }

    queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
  }, [queryClient]);

  // =============================================================================
  // CLASSROOM OPERATIONS
  // =============================================================================

  const getClassrooms = useCallback(async (instituteId: string): Promise<Classroom[]> => {
    const response = await apiRequest('GET', `/api/institutes/${instituteId}/classrooms`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch classrooms');
    }

    return result.classrooms || [];
  }, []);

  const createClassroom = useCallback(async (instituteId: string, data: Partial<Classroom>): Promise<Classroom> => {
    const response = await apiRequest('POST', `/api/institutes/${instituteId}/classrooms`, data);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to create classroom');
    }

    return result.classroom;
  }, []);

  const updateClassroom = useCallback(async (classroomId: string, data: Partial<Classroom>): Promise<Classroom> => {
    const response = await apiRequest('PATCH', `/api/classrooms/${classroomId}`, data);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to update classroom');
    }

    return result.classroom;
  }, []);

  const deleteClassroom = useCallback(async (classroomId: string): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/classrooms/${classroomId}`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to delete classroom');
    }
  }, []);

  // =============================================================================
  // CLASSROOM MEMBER OPERATIONS
  // =============================================================================

  const getClassroomMembers = useCallback(async (classroomId: string): Promise<ClassroomMember[]> => {
    const response = await apiRequest('GET', `/api/classrooms/${classroomId}/members`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch classroom members');
    }

    return result.members || [];
  }, []);

  const addClassroomMember = useCallback(async (
    classroomId: string,
    userId: string,
    role: string,
    isPrimary: boolean = false
  ): Promise<void> => {
    const response = await apiRequest('POST', `/api/classrooms/${classroomId}/members`, {
      userId,
      role,
      isPrimary,
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to add classroom member');
    }
  }, []);

  const updateClassroomMember = useCallback(async (
    classroomId: string,
    userId: string,
    data: { role?: string; isPrimary?: boolean }
  ): Promise<void> => {
    const response = await apiRequest('PATCH', `/api/classrooms/${classroomId}/members/${userId}`, data);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to update classroom member');
    }
  }, []);

  const removeClassroomMember = useCallback(async (classroomId: string, userId: string): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/classrooms/${classroomId}/members/${userId}`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to remove classroom member');
    }
  }, []);

  // =============================================================================
  // CLASSROOM STUDENT OPERATIONS
  // =============================================================================

  const getClassroomStudents = useCallback(async (classroomId: string): Promise<ClassroomStudent[]> => {
    const response = await apiRequest('GET', `/api/classrooms/${classroomId}/students`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch classroom students');
    }

    return result.students || [];
  }, []);

  const addStudentToClassroom = useCallback(async (
    classroomId: string,
    studentId: string,
    options?: { isPrimary?: boolean; enrollmentDate?: string; notes?: string }
  ): Promise<void> => {
    const response = await apiRequest('POST', `/api/classrooms/${classroomId}/students`, {
      studentId,
      ...options,
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to add student to classroom');
    }
  }, []);

  const updateClassroomStudent = useCallback(async (
    classroomId: string,
    studentId: string,
    data: { isPrimary?: boolean; notes?: string }
  ): Promise<void> => {
    const response = await apiRequest('PATCH', `/api/classrooms/${classroomId}/students/${studentId}`, data);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to update classroom student');
    }
  }, []);

  const removeStudentFromClassroom = useCallback(async (classroomId: string, studentId: string): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/classrooms/${classroomId}/students/${studentId}`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to remove student from classroom');
    }
  }, []);

  // =============================================================================
  // INSTITUTE STUDENT OPERATIONS
  // =============================================================================

  const getInstituteStudents = useCallback(async (instituteId: string): Promise<InstituteStudent[]> => {
    const response = await apiRequest('GET', `/api/institutes/${instituteId}/students`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch institute students');
    }

    return result.students || [];
  }, []);

  const addStudentToInstitute = useCallback(async (
    instituteId: string,
    studentId: string,
    options?: { enrollmentDate?: string; idNumber?: string; grade?: string }
  ): Promise<void> => {
    const response = await apiRequest('POST', `/api/institutes/${instituteId}/students`, {
      studentId,
      ...options,
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to add student to institute');
    }
  }, []);

  const updateInstituteStudent = useCallback(async (
    instituteId: string,
    studentId: string,
    data: { idNumber?: string | null; grade?: string | null }
  ): Promise<void> => {
    const response = await apiRequest('PATCH', `/api/institutes/${instituteId}/students/${studentId}`, data);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to update institute student');
    }
  }, []);

  const removeStudentFromInstitute = useCallback(async (
    instituteId: string,
    studentId: string,
    exitReason?: string
  ): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/institutes/${instituteId}/students/${studentId}`, {
      exitReason,
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to remove student from institute');
    }
  }, []);

  const getStudentInstitutes = useCallback(async (studentId: string): Promise<StudentInstitute[]> => {
    const response = await apiRequest('GET', `/api/students/${studentId}/institutes`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch student institutes');
    }

    return result.institutes || [];
  }, []);

  // =============================================================================
  // CONTEXT VALUE
  // =============================================================================

  // License permissions for the selected institute (defaults if none selected)
  const currentPermissions: LicensePermissions = currentInstitute?.licensePermissions ?? { ...DEFAULT_LICENSE_PERMISSIONS };

  const contextValue: InstituteContextType = {
    // State
    institutes,
    currentInstitute,
    currentPermissions,
    isLoading,
    error,
    
    // Institute operations
    selectInstitute,
    createInstitute,
    updateInstitute,
    deleteInstitute,
    leaveInstitute,
    
    // Member operations
    getMembers,
    updateMember,
    removeMember,
    
    // Invite operations
    sendInvite,
    getInvites,
    cancelInvite,
    resendInvite,
    pendingInvites,
    acceptInvite,
    declineInvite,
    refetchPendingInvites: () => refetchPendingInvites(),
    
    // Classroom operations
    getClassrooms,
    createClassroom,
    updateClassroom,
    deleteClassroom,
    
    // Classroom member operations
    getClassroomMembers,
    addClassroomMember,
    updateClassroomMember,
    removeClassroomMember,
    
    // Classroom student operations
    getClassroomStudents,
    addStudentToClassroom,
    updateClassroomStudent,
    removeStudentFromClassroom,
    
    // Institute student operations
    getInstituteStudents,
    addStudentToInstitute,
    updateInstituteStudent,
    removeStudentFromInstitute,
    getStudentInstitutes,

    // Identity verification
    identityVerification: identityVerification ?? null,
    initiateIdentityLink,
    dismissIdentityPrompt,
    showIdentityPrompt,

    // Refetch
    refetchInstitutes: () => refetchInstitutes(),
  };

  return (
    <InstituteContext.Provider value={contextValue}>
      {children}
    </InstituteContext.Provider>
  );
};