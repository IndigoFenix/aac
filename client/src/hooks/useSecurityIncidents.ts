// Data access for the security incident register (AKIM appendix §6).
//
// The notification endpoint is the one to read carefully: it PREVIEWS by
// default. `dryRun: false` is what actually mails a breach notification to a
// customer, so it is passed explicitly at the call site rather than defaulted
// anywhere in this file.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export type IncidentKind = "phi_breach" | "security_breach" | "vendor_incident";
export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus =
  | "open"
  | "contained"
  | "notified"
  | "closed"
  | "dismissed";
export type IncidentObligation = "regulator" | "customer" | "investigation_report";

export interface SecurityIncident {
  id: string;
  reference: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  description: string | null;
  discoveredAt: string;
  occurredAt: string | null;
  containedAt: string | null;
  endedAt: string | null;
  regimes: string[];
  regulatorNotifyDueAt: string | null;
  regulatorNotifiedAt: string | null;
  customerNotifyDueAt: string | null;
  customerNotifiedAt: string | null;
  investigationReportDueAt: string | null;
  investigationReportSentAt: string | null;
  affectedInstituteIds: string[];
  affectedSubjectCount: number | null;
  affectedScope: string | null;
  closedAt: string | null;
  closureSummary: string | null;
  createdAt: string;
  updatedAt: string;
  /** Server-computed: which obligations are past due and unmet. */
  overdue: IncidentObligation[];
}

export interface IncidentTimelineEvent {
  id: string;
  incidentId: string;
  kind:
    | "opened"
    | "note"
    | "status_change"
    | "notification_sent"
    | "deadline_warning"
    | "deadline_missed"
    | "closed";
  body: string | null;
  metadata: Record<string, unknown> | null;
  actorAdminUserId: string | null;
  createdAt: string;
}

const LIST_KEY = "/api/admin/security-incidents";

export function useSecurityIncidents(includeClosed: boolean) {
  return useQuery<{ success: boolean; incidents: SecurityIncident[] }>({
    queryKey: [LIST_KEY, includeClosed],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `${LIST_KEY}?includeClosed=${includeClosed ? "true" : "false"}`,
      );
      return res.json();
    },
  });
}

export function useSecurityIncident(id: string | null) {
  return useQuery<{
    success: boolean;
    incident: SecurityIncident;
    timeline: IncidentTimelineEvent[];
  }>({
    queryKey: [LIST_KEY, id],
    enabled: Boolean(id),
    queryFn: async () => {
      const res = await apiRequest("GET", `${LIST_KEY}/${id}`);
      return res.json();
    },
  });
}

export interface OpenIncidentBody {
  kind: IncidentKind;
  severity: IncidentSeverity;
  title: string;
  description?: string;
  discoveredAt?: string;
  occurredAt?: string | null;
  affectedScope?: string;
  affectedSubjectCount?: number | null;
  regimes?: string[];
}

export function useOpenIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: OpenIncidentBody) => {
      const res = await apiRequest("POST", LIST_KEY, body);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

export function useUpdateIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `${LIST_KEY}/${id}`, body);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

export function useAddIncidentNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      const res = await apiRequest("POST", `${LIST_KEY}/${id}/notes`, { body });
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

export function useCloseIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (closureSummary: string) => {
      const res = await apiRequest("POST", `${LIST_KEY}/${id}/close`, { closureSummary });
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}

/**
 * Outcomes, not errors. `unfilled_tokens` is the expected result of a first
 * preview — the server returns 200 with the rendered letter and the list of
 * what is still missing, because `apiRequest` discards the body of a non-2xx.
 */
export type NotifyOutcome =
  | "preview"
  | "sent"
  | "unfilled_tokens"
  | "no_recipients"
  | "send_failed";

export interface NotifyResponse {
  success: boolean;
  outcome?: NotifyOutcome;
  subject?: string;
  text?: string;
  recipients?: string[];
  missingTokens?: string[];
  failedRecipients?: string[];
  message?: string;
}

export interface NotifyBody {
  target: "customer" | "regulator" | "investigation_report";
  recipients: string[];
  locale: "he" | "en";
  vars: Record<string, string>;
  /** false = actually send. Always passed explicitly by the caller. */
  dryRun: boolean;
}

export function useNotifyIncident(id: string) {
  const qc = useQueryClient();
  return useMutation<NotifyResponse, Error, NotifyBody>({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", `${LIST_KEY}/${id}/notify`, body);
      return res.json();
    },
    onSuccess: (_data, variables) => {
      if (!variables.dryRun) void qc.invalidateQueries({ queryKey: [LIST_KEY] });
    },
  });
}
