// src/hooks/useChatSessions.ts
//
// Clinician-facing "past conversations" sidebar data. Lists the current user's
// own chat sessions (optionally scoped to the selected student), plus rename
// and delete mutations. Distinct from useSessionHistory.ts, which is the
// admin (institute-wide) surface.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface ChatSessionListItem {
  id: string;
  title: string | null;
  titleManual: boolean;
  importance: number;
  chatMode: string;
  status: "open" | "paused" | "closed";
  started: string;
  lastUpdate: string;
  messageCount: number;
  firstMessage: string | null;
}

interface ListResponse {
  success: boolean;
  sessions: ChatSessionListItem[];
}

/** Query key for the current user's conversation list, scoped by student. */
export function chatSessionsKey(studentId?: string | null) {
  return ["/api/chat/sessions", studentId ?? "all"] as const;
}

/**
 * List the current user's past conversations. When `studentId` is provided the
 * list is scoped to that student. `enabled` lets callers defer the fetch until
 * the sidebar is actually opened.
 */
export function useChatSessions(studentId?: string | null, enabled = true) {
  return useQuery<ListResponse>({
    queryKey: chatSessionsKey(studentId),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (studentId) params.set("studentId", studentId);
      const qs = params.toString();
      const res = await apiRequest("GET", `/api/chat/sessions${qs ? `?${qs}` : ""}`);
      return res.json();
    },
    enabled,
    staleTime: 30 * 1000,
  });
}

export function useRenameChatSession(studentId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const res = await apiRequest("PATCH", `/api/chat/sessions/${id}`, { title });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: chatSessionsKey(studentId) });
    },
  });
}

export function useDeleteChatSession(studentId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/chat/sessions/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: chatSessionsKey(studentId) });
    },
  });
}
