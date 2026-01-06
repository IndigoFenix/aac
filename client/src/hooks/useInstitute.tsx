// src/hooks/useInstitute.tsx
// React hook for institute management

import { useState, useEffect, createContext, useContext, ReactNode, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useAuth } from '@/hooks/useAuth';

// Types
export interface Institute {
  id: string;
  name: string;
  type: 'school' | 'hospital';
  description?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  logoUrl?: string;
  isActive: boolean;
  isAdmin?: boolean;
  role?: string;
  membershipId?: string;
  createdAt: string;
  updatedAt: string;
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
    type: 'school' | 'hospital';
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

interface InstituteContextType {
  // State
  institutes: Institute[];
  currentInstitute: Institute | null;
  isLoading: boolean;
  error: string | null;

  // Institute operations
  selectInstitute: (instituteId: string | null) => void;
  createInstitute: (data: Partial<Institute>) => Promise<Institute>;
  updateInstitute: (id: string, data: Partial<Institute>) => Promise<Institute>;
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

  // Refetch
  refetchInstitutes: () => void;
}

const INSTITUTES_QUERY_KEY = ['/api/institutes'];
const PENDING_INVITES_QUERY_KEY = ['/api/invites/pending'];

const InstituteContext = createContext<InstituteContextType | null>(null);

export const useInstitute = () => {
  const context = useContext(InstituteContext);
  if (!context) {
    throw new Error('useInstitute must be used within an InstituteProvider');
  }
  return context;
};

export const InstituteProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [currentInstitute, setCurrentInstitute] = useState<Institute | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // Restore selected institute from localStorage
  useEffect(() => {
    if (institutes.length > 0 && !currentInstitute) {
      const storedId = localStorage.getItem('cliniaacian.currentInstituteId');
      if (storedId) {
        const found = institutes.find((i) => i.id === storedId);
        if (found) {
          setCurrentInstitute(found);
        }
      }
    }
  }, [institutes, currentInstitute]);

  // Select institute
  const selectInstitute = useCallback((instituteId: string | null) => {
    if (!instituteId) {
      setCurrentInstitute(null);
      localStorage.removeItem('cliniaacian.currentInstituteId');
      return;
    }

    const found = institutes.find((i) => i.id === instituteId);
    if (found) {
      setCurrentInstitute(found);
      localStorage.setItem('cliniaacian.currentInstituteId', instituteId);
    }
  }, [institutes]);

  // Create institute
  const createInstitute = useCallback(async (data: Partial<Institute>): Promise<Institute> => {
    const response = await apiRequest('POST', '/api/institutes', data);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to create institute');
    }

    queryClient.invalidateQueries({ queryKey: INSTITUTES_QUERY_KEY });
    return result.institute;
  }, [queryClient]);

  // Update institute
  const updateInstitute = useCallback(async (id: string, data: Partial<Institute>): Promise<Institute> => {
    const response = await apiRequest('PATCH', `/api/institutes/${id}`, data);
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

  // Delete institute
  const deleteInstitute = useCallback(async (id: string): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/institutes/${id}`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to delete institute');
    }

    queryClient.invalidateQueries({ queryKey: INSTITUTES_QUERY_KEY });

    if (currentInstitute?.id === id) {
      setCurrentInstitute(null);
      localStorage.removeItem('cliniaacian.currentInstituteId');
    }
  }, [queryClient, currentInstitute]);

  // Leave institute
  const leaveInstitute = useCallback(async (id: string): Promise<void> => {
    const response = await apiRequest('POST', `/api/institutes/${id}/leave`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to leave institute');
    }

    queryClient.invalidateQueries({ queryKey: INSTITUTES_QUERY_KEY });

    if (currentInstitute?.id === id) {
      setCurrentInstitute(null);
      localStorage.removeItem('cliniaacian.currentInstituteId');
    }
  }, [queryClient, currentInstitute]);

  // Get members
  const getMembers = useCallback(async (instituteId: string): Promise<InstituteMember[]> => {
    const response = await apiRequest('GET', `/api/institutes/${instituteId}/members`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch members');
    }

    return result.members || [];
  }, []);

  // Update member
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

  // Remove member
  const removeMember = useCallback(async (instituteId: string, userId: string): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/institutes/${instituteId}/members/${userId}`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to remove member');
    }
  }, []);

  // Send invite
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

  // Get invites
  const getInvites = useCallback(async (instituteId: string): Promise<InstituteInvite[]> => {
    const response = await apiRequest('GET', `/api/institutes/${instituteId}/invites`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to fetch invites');
    }

    return result.invites || [];
  }, []);

  // Cancel invite
  const cancelInvite = useCallback(async (instituteId: string, inviteId: string): Promise<void> => {
    const response = await apiRequest('DELETE', `/api/institutes/${instituteId}/invites/${inviteId}`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to cancel invite');
    }
  }, []);

  // Resend invite
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

  // Accept invite
  const acceptInvite = useCallback(async (inviteId: string): Promise<void> => {
    const response = await apiRequest('POST', `/api/invites/${inviteId}/accept`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to accept invite');
    }

    queryClient.invalidateQueries({ queryKey: INSTITUTES_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
  }, [queryClient]);

  // Decline invite
  const declineInvite = useCallback(async (inviteId: string): Promise<void> => {
    const response = await apiRequest('POST', `/api/invites/${inviteId}/decline`);
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Failed to decline invite');
    }

    queryClient.invalidateQueries({ queryKey: PENDING_INVITES_QUERY_KEY });
  }, [queryClient]);

  const contextValue: InstituteContextType = {
    institutes,
    currentInstitute,
    isLoading,
    error,
    selectInstitute,
    createInstitute,
    updateInstitute,
    deleteInstitute,
    leaveInstitute,
    getMembers,
    updateMember,
    removeMember,
    sendInvite,
    getInvites,
    cancelInvite,
    resendInvite,
    pendingInvites,
    acceptInvite,
    declineInvite,
    refetchPendingInvites: () => refetchPendingInvites(),
    refetchInstitutes: () => refetchInstitutes(),
  };

  return (
    <InstituteContext.Provider value={contextValue}>
      {children}
    </InstituteContext.Provider>
  );
};
