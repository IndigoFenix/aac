import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// ---------- Types ----------

import type { SessionCostBreakdown } from "@/components/admin/CostBreakdownCell";
export type { SessionCostBreakdown };

export interface AACSessionSummary {
  id: string;
  studentId: string;
  studentName: string | null;
  userId: string | null;
  userName: string | null;
  creditsUsed: number;
  costBreakdown?: SessionCostBreakdown | null;
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
  costBreakdown?: SessionCostBreakdown | null;
  status: "open" | "paused" | "closed";
  started: string;
  lastUpdate: string;
}

export interface CaptionProjectSummary {
  id: string;
  videoName: string | null;
  language: string | null;
  creditsUsed: number;
  costBreakdown?: SessionCostBreakdown | null;
  segmentCount: number;
  userId: string | null;
  userName: string | null;
  studentId: string | null;
  studentName: string | null;
  instituteId: string | null;
  instituteName: string | null;
  createdAt: string;
  updatedAt: string;
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
  title?: string | null;
  summary?: string | null;
  importance?: number | null;
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

export function useCaptionProjectsAdmin(filters: SessionFilters) {
  const qs = buildParams(filters);
  return useQuery<PaginatedResponse<CaptionProjectSummary>>({
    queryKey: ["/api/admin/caption-projects", qs],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/caption-projects?${qs}`);
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

export interface DebugLogEntry {
  id: string;
  seq: number;
  timestamp: string;
  section: string;
  content: string;
}

interface DebugLogResponse {
  success: boolean;
  data: DebugLogEntry[];
  pagination: PaginationInfo;
}

export function useSessionDebugLog(sessionId: string | null, opts: { section?: string; limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.section) params.set("section", opts.section);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return useQuery<DebugLogResponse>({
    queryKey: ["/api/admin/sessions", sessionId, "debug-log", qs],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/sessions/${sessionId}/debug-log${qs ? `?${qs}` : ""}`);
      return res.json();
    },
    enabled: !!sessionId,
  });
}

export interface DeleteDebugLogsResponse {
  success: boolean;
  deleted?: number;
  before?: string;
  message?: string;
}

/**
 * Bulk-delete all session debug logs recorded before a given date (admin
 * maintenance). `before` is a date/datetime string the server parses (e.g.
 * "2026-05-01"). Invalidates the session-debug queries so open views refresh.
 */
export function useDeleteSessionDebugLogsBefore() {
  const queryClient = useQueryClient();
  return useMutation<DeleteDebugLogsResponse, Error, string>({
    mutationFn: async (before: string) => {
      const res = await apiRequest("DELETE", "/api/admin/sessions/debug-logs", { before });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/sessions"] });
    },
  });
}
