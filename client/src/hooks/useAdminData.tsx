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
  icon: string;
  prompt: string;
  manualSelection: boolean;
  active: boolean;
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
  icon: string;
  prompt: string;
  manualSelection?: boolean;
  active?: boolean;
}

export interface UpdatePersonaData {
  title?: string;
  icon?: string;
  prompt?: string;
  manualSelection?: boolean;
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
