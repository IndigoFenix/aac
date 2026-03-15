// client-aac/src/hooks/useDebugSession.ts
// Polls the expanded session endpoint for debug panel data

import { useQuery } from "@tanstack/react-query";
import { fetchWithAuth } from "@/lib/queryClient";

export interface DebugSessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface DebugSessionData {
  sessionId: string;
  monitorBusy: boolean;
  messageCount: number;
  pendingCount: number;
  interactivePrompt: string;
  lastMonitorActivity: number;
  lastInteractiveActivity: number;
  interactionMode: "interact" | "silent";
  messages: DebugSessionMessage[];
  pendingMessages: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }>;
}

export function useDebugSession(
  sessionId: string | null,
  studentId: string,
  enabled: boolean
) {
  return useQuery<DebugSessionData>({
    queryKey: ["/api/aac/dual/session", sessionId, "debug"],
    queryFn: async () => {
      if (!sessionId) throw new Error("No session");
      const res = await fetchWithAuth(
        `/api/aac/dual/session/${sessionId}?studentId=${studentId}&debugMode=true`
      );
      if (!res.ok) throw new Error(`Session fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: enabled && !!sessionId,
    refetchInterval: 3000,
    retry: false,
  });
}
