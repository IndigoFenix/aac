import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface ActivityLogEntry {
  id: string;
  instituteId: string | null;
  userId: string | null;
  eventType: string;
  subjectType1: string;
  subjectId1: string | null;
  subjectType2: string | null;
  subjectId2: string | null;
  details: Record<string, unknown> | null;
  isAiInitiated: boolean;
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
  instituteName: string | null;
}

export interface ActivityLogFilters {
  limit: number;
  offset: number;
  instituteId?: string;
  userId?: string;
  eventType?: string;
  subjectType?: string;
  startDate?: string;
  endDate?: string;
  isAiInitiated?: string;
}

interface PaginatedResponse {
  success: boolean;
  data: ActivityLogEntry[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

function buildParams(filters: ActivityLogFilters): string {
  const params = new URLSearchParams();
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  if (filters.instituteId) params.set("instituteId", filters.instituteId);
  if (filters.userId) params.set("userId", filters.userId);
  if (filters.eventType) params.set("eventType", filters.eventType);
  if (filters.subjectType) params.set("subjectType", filters.subjectType);
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if (filters.isAiInitiated) params.set("isAiInitiated", filters.isAiInitiated);
  return params.toString();
}

export function useActivityLogs(filters: ActivityLogFilters) {
  const qs = buildParams(filters);
  return useQuery<PaginatedResponse>({
    queryKey: ["/api/admin/activity-logs", qs],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/activity-logs?${qs}`);
      return res.json();
    },
  });
}
