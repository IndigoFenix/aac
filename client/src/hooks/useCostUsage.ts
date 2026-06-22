import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

// One lightweight row per session. The dashboard derives every chart from
// these plus the exact KPI totals below.
export interface CostUsagePoint {
  id: string;
  source: "aac" | "chat";
  started: string; // ISO
  durationSec: number;
  cost: number;
  studentName: string | null;
  userName: string | null;
  instituteName: string | null;
}

export interface CostUsageKpiSet {
  sessionCount: number;
  totalSpend: number;
  totalSeconds: number;
  ghostCount: number;
}

export interface CostUsageResponse {
  success: boolean;
  points: CostUsagePoint[];
  // KPIs are reported separately per session type — AAC and non-AAC chat
  // sessions are too different to combine.
  kpis: { aac: CostUsageKpiSet; chat: CostUsageKpiSet };
  truncated: boolean;
}

export interface CostUsageFilters {
  startDate?: string;
  endDate?: string;
}

export function useCostUsage(filters: CostUsageFilters) {
  const params = new URLSearchParams();
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  const qs = params.toString();
  return useQuery<CostUsageResponse>({
    queryKey: ["/api/admin/cost-usage", qs],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/cost-usage${qs ? `?${qs}` : ""}`);
      return res.json();
    },
  });
}
