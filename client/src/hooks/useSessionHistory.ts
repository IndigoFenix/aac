import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// ---------- Types ----------

export interface AACSessionSummary {
  id: string;
  studentId: string;
  studentName: string | null;
  userId: string | null;
  userName: string | null;
  creditsUsed: number;
  status: string;
  started: string;
  lastActivity: string;
  ended: string | null;
  source?: "dual-agent" | "chat";
}

export interface ChatSessionSummary {
  id: string;
  userId: string | null;
  userName: string | null;
  studentId: string | null;
  studentName: string | null;
  chatMode: string;
  creditsUsed: number;
  status: "open" | "paused" | "closed";
  started: string;
  lastUpdate: string;
}

export interface PaginationInfo {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SessionFilters {
  limit: number;
  offset: number;
  studentId?: string;
  userId?: string;
  startDate?: string;
  endDate?: string;
}

interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: PaginationInfo;
}

interface LogResponse {
  success: boolean;
  data: any[];
}

// ---------- Hooks ----------

function buildParams(filters: SessionFilters, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
  }
  return params.toString();
}

export function useAACSessionsAdmin(filters: SessionFilters) {
  const qs = buildParams(filters, { studentId: filters.studentId });
  return useQuery<PaginatedResponse<AACSessionSummary>>({
    queryKey: ["/api/admin/sessions/aac", qs],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/sessions/aac?${qs}`);
      return res.json();
    },
  });
}

export function useChatSessionsAdmin(filters: SessionFilters) {
  const qs = buildParams(filters, { userId: filters.userId });
  return useQuery<PaginatedResponse<ChatSessionSummary>>({
    queryKey: ["/api/admin/sessions/chat", qs],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/sessions/chat?${qs}`);
      return res.json();
    },
  });
}

export function useAACSessionLog(sessionId: string | null) {
  return useQuery<LogResponse>({
    queryKey: ["/api/admin/sessions/aac", sessionId, "log"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/sessions/aac/${sessionId}/log`);
      return res.json();
    },
    enabled: !!sessionId,
  });
}

export function useChatSessionLog(sessionId: string | null) {
  return useQuery<LogResponse>({
    queryKey: ["/api/admin/sessions/chat", sessionId, "log"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/sessions/chat/${sessionId}/log`);
      return res.json();
    },
    enabled: !!sessionId,
  });
}
