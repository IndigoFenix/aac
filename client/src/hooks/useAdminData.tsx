// src/hooks/useAdminData.tsx
// React hooks for admin persona and topic management

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';

// =============================================================================
// TYPES
// =============================================================================

export interface Persona {
  id: string;
  title: string;
  description: string | null;
  icon: string;
  prompt: string;
  manualSelection: boolean;
  active: boolean;
  testMode: boolean;
  instituteId: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Topic {
  id: string;
  title: string;
  parentId: string | null;
  content: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  children?: Topic[];
  childCount?: number;
}

export interface CreatePersonaData {
  title: string;
  description?: string | null;
  icon: string;
  prompt: string;
  manualSelection?: boolean;
  active?: boolean;
  testMode?: boolean;
  instituteId?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
}

export interface UpdatePersonaData {
  title?: string;
  description?: string | null;
  icon?: string;
  prompt?: string;
  manualSelection?: boolean;
  active?: boolean;
  testMode?: boolean;
  instituteId?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
}

export interface Voice {
  id: string;
  name: string;
  externalId: string;
  source: string;
  description: string | null;
  sampleUrl: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVoiceData {
  name: string;
  externalId: string;
  source?: string;
  description?: string;
  sampleUrl?: string;
  active?: boolean;
}

export interface UpdateVoiceData {
  name?: string;
  externalId?: string;
  source?: string;
  description?: string;
  sampleUrl?: string;
  active?: boolean;
}

export interface CreateTopicData {
  title: string;
  parentId?: string | null;
  content?: string;
  active?: boolean;
}

export interface UpdateTopicData {
  title?: string;
  parentId?: string | null;
  content?: string;
  active?: boolean;
}

// =============================================================================
// PERSONA HOOKS
// =============================================================================

/**
 * Hook to fetch all personas (admin)
 */
export function usePersonas() {
  return useQuery({
    queryKey: ['/api/admin/personas'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/admin/personas');
      const data = await res.json();
      return data.personas as Persona[];
    },
  });
}

/**
 * Hook to fetch a single persona
 */
export function usePersona(id: string | undefined) {
  return useQuery({
    queryKey: ['/api/admin/personas', id],
    queryFn: async () => {
      if (!id) return null;
      const res = await apiRequest('GET', `/api/admin/personas/${id}`);
      const data = await res.json();
      return data.persona as Persona;
    },
    enabled: !!id,
  });
}

/**
 * Hook to fetch selectable personas (for chat)
 */
export function useSelectablePersonas() {
  return useQuery({
    queryKey: ['/api/personas/selectable'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/personas/selectable');
      const data = await res.json();
      return data.personas as Persona[];
    },
  });
}

/**
 * Hook for persona mutations
 */
export function usePersonaMutations() {
  const queryClient = useQueryClient();

  const createPersona = useMutation({
    mutationFn: async (data: CreatePersonaData) => {
      const res = await apiRequest('POST', '/api/admin/personas', data);
      const result = await res.json();
      return result.persona as Persona;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/personas'] });
      queryClient.invalidateQueries({ queryKey: ['/api/personas/selectable'] });
    },
  });

  const updatePersona = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdatePersonaData }) => {
      const res = await apiRequest('PATCH', `/api/admin/personas/${id}`, data);
      const result = await res.json();
      return result.persona as Persona;
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/personas'] });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/personas', id] });
      queryClient.invalidateQueries({ queryKey: ['/api/personas/selectable'] });
    },
  });

  const deletePersona = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/admin/personas/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/personas'] });
      queryClient.invalidateQueries({ queryKey: ['/api/personas/selectable'] });
    },
  });

  return {
    createPersona,
    updatePersona,
    deletePersona,
  };
}

// =============================================================================
// TOPIC HOOKS
// =============================================================================

/**
 * Hook to fetch topics by parent ID (null for root topics)
 */
export function useTopics(parentId: string | null = null) {
  const queryKey = parentId
    ? ['/api/admin/topics', { parentId }]
    : ['/api/admin/topics', { parentId: 'root' }];

  return useQuery({
    queryKey,
    queryFn: async () => {
      const url = parentId
        ? `/api/admin/topics?parentId=${parentId}`
        : '/api/admin/topics';
      const res = await apiRequest('GET', url);
      const data = await res.json();
      return data.topics as Topic[];
    },
  });
}

/**
 * Hook to fetch a single topic with children and path
 */
export function useTopic(id: string | undefined) {
  return useQuery({
    queryKey: ['/api/admin/topics', id],
    queryFn: async () => {
      if (!id) return null;
      const res = await apiRequest('GET', `/api/admin/topics/${id}`);
      const data = await res.json();
      return {
        topic: data.topic as Topic,
        path: data.path as Topic[],
      };
    },
    enabled: !!id,
  });
}

/**
 * Hook for topic mutations
 */
export function useTopicMutations() {
  const queryClient = useQueryClient();

  const createTopic = useMutation({
    mutationFn: async (data: CreateTopicData) => {
      const res = await apiRequest('POST', '/api/admin/topics', data);
      const result = await res.json();
      return result.topic as Topic;
    },
    onSuccess: (_, variables) => {
      // Invalidate the parent's topic list
      if (variables.parentId) {
        queryClient.invalidateQueries({ queryKey: ['/api/admin/topics', { parentId: variables.parentId }] });
        queryClient.invalidateQueries({ queryKey: ['/api/admin/topics', variables.parentId] });
      } else {
        queryClient.invalidateQueries({ queryKey: ['/api/admin/topics', { parentId: 'root' }] });
      }
    },
  });

  const updateTopic = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateTopicData }) => {
      const res = await apiRequest('PATCH', `/api/admin/topics/${id}`, data);
      const result = await res.json();
      return result.topic as Topic;
    },
    onSuccess: (_, { id }) => {
      // Invalidate all topic queries since parent might have changed
      queryClient.invalidateQueries({ queryKey: ['/api/admin/topics'] });
    },
  });

  const deleteTopic = useMutation({
    mutationFn: async ({ id, cascade = false }: { id: string; cascade?: boolean }) => {
      const url = cascade
        ? `/api/admin/topics/${id}?cascade=true`
        : `/api/admin/topics/${id}`;
      await apiRequest('DELETE', url);
    },
    onSuccess: () => {
      // Invalidate all topic queries
      queryClient.invalidateQueries({ queryKey: ['/api/admin/topics'] });
    },
  });

  return {
    createTopic,
    updateTopic,
    deleteTopic,
  };
}

// =============================================================================
// LLM CONFIG HOOKS
// =============================================================================

/**
 * Hook to fetch all LLM configurations
 */
export function useLLMConfigs() {
  return useQuery({
    queryKey: ['/api/admin/settings/llm_configs'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/admin/settings/llm_configs');
      const data = await res.json();
      return data as {
        configs: Record<string, { provider: string; model: string }>;
        useCases: Record<string, { label: string; description: string; defaultProvider: string; defaultModel: string }>;
        modelOptions: Array<{
          provider: string;
          modelId: string;
          displayName: string;
          description: string;
          tier: string;
          inputCostPer1M: number;
          outputCostPer1M: number;
          supportsTools: boolean;
          supportsStreaming: boolean;
          supportsStructuredOutput: boolean;
        }>;
      };
    },
  });
}

/**
 * Hook for LLM config mutations
 */
export function useLLMConfigMutations() {
  const queryClient = useQueryClient();

  const updateConfigs = useMutation({
    mutationFn: async (configs: Record<string, { provider: string; model: string }>) => {
      const res = await apiRequest('PUT', '/api/admin/settings/llm_configs', { configs });
      const result = await res.json();
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/settings/llm_configs'] });
    },
  });

  return { updateConfigs };
}

// =============================================================================
// VOICE HOOKS
// =============================================================================

/**
 * Hook to fetch all voices (admin)
 */
export function useVoices() {
  return useQuery({
    queryKey: ['/api/admin/voices'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/admin/voices');
      const data = await res.json();
      return data.voices as Voice[];
    },
  });
}

/**
 * Hook to fetch active voices (for settings panel)
 */
export function useActiveVoices() {
  return useQuery({
    queryKey: ['/api/voices/active'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/voices/active');
      const data = await res.json();
      return data.voices as Voice[];
    },
  });
}

/**
 * Hook for voice mutations
 */
export function useVoiceMutations() {
  const queryClient = useQueryClient();

  const createVoice = useMutation({
    mutationFn: async (data: CreateVoiceData) => {
      const res = await apiRequest('POST', '/api/admin/voices', data);
      const result = await res.json();
      return result.voice as Voice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/voices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/voices/active'] });
    },
  });

  const updateVoice = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateVoiceData }) => {
      const res = await apiRequest('PATCH', `/api/admin/voices/${id}`, data);
      const result = await res.json();
      return result.voice as Voice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/voices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/voices/active'] });
    },
  });

  const deleteVoice = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/admin/voices/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/voices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/voices/active'] });
    },
  });

  return {
    createVoice,
    updateVoice,
    deleteVoice,
  };
}

// =============================================================================
// INSTITUTE HOOKS (admin)
// =============================================================================

export interface AdminInstitute {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
}

/**
 * Hook to fetch all active institutes (for admin dropdowns like persona form)
 */
export function useAllInstitutes() {
  return useQuery({
    queryKey: ['/api/admin/institutes'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/admin/institutes');
      const data = await res.json();
      return data.institutes as AdminInstitute[];
    },
  });
}

// =============================================================================
// LICENSE HOOKS (admin)
// =============================================================================

export interface AdminLicense {
  id: string;
  name: string | null;
  licenseType: string;
  subscriptionType: string | null;
  permissions: any | null;
  inviteEmail: string | null;
  instituteId: string | null;
  userId: string | null;
  isActive: boolean;
  activatedAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  createdAt: string;
  updatedAt: string;
  // Joined fields
  userName: string | null;
  userEmail: string | null;
  instituteName: string | null;
}

export interface CreateLicenseData {
  name?: string;
  licenseType?: string;
  subscriptionType?: string;
  permissions?: any;
  inviteEmail: string;
  firstName?: string;
  lastName?: string;
  createInstitute?: boolean;
  instituteName?: string;
  instituteType?: 'school' | 'hospital';
}

export interface UpdateLicenseData {
  name?: string;
  licenseType?: string;
  subscriptionType?: string;
  permissions?: any | null;
  isActive?: boolean;
  inviteEmail?: string | null;
}

/**
 * Hook to fetch all licenses (admin)
 */
export function useLicenses() {
  return useQuery({
    queryKey: ['/api/admin/licenses'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/admin/licenses');
      const data = await res.json();
      return data.licenses as AdminLicense[];
    },
  });
}

/**
 * Hook to fetch a single license
 */
export function useLicense(id: string | undefined) {
  return useQuery({
    queryKey: ['/api/admin/licenses', id],
    queryFn: async () => {
      if (!id) return null;
      const res = await apiRequest('GET', `/api/admin/licenses/${id}`);
      const data = await res.json();
      return data.license as AdminLicense;
    },
    enabled: !!id,
  });
}

/**
 * Hook for license mutations
 */
export function useLicenseMutations() {
  const queryClient = useQueryClient();

  const createLicense = useMutation({
    mutationFn: async (data: CreateLicenseData) => {
      const res = await apiRequest('POST', '/api/admin/licenses', data);
      const result = await res.json();
      return result.license as AdminLicense;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/licenses'] });
    },
  });

  const updateLicense = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateLicenseData }) => {
      const res = await apiRequest('PATCH', `/api/admin/licenses/${id}`, data);
      const result = await res.json();
      return result.license as AdminLicense;
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/licenses'] });
      queryClient.invalidateQueries({ queryKey: ['/api/admin/licenses', id] });
    },
  });

  const deleteLicense = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/admin/licenses/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/admin/licenses'] });
    },
  });

  const resendInvite = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('POST', `/api/admin/licenses/${id}/resend-invite`);
    },
  });

  return {
    createLicense,
    updateLicense,
    deleteLicense,
    resendInvite,
  };
}
