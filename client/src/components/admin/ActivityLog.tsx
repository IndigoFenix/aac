import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, ChevronLeft, ChevronRight, Bot } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  useActivityLogs,
  type ActivityLogFilters,
  type ActivityLogEntry,
} from "@/hooks/useActivityLog";

const EVENT_TYPES = [
  "create", "update", "delete", "link", "unlink", "view", "finalize", "revision",
  // Share lifecycle — added by migration 0079.
  "share_invite_created", "share_guardian_approved", "share_redeemed",
  "share_accepted", "share_declined", "share_revoked", "share_expired",
  "standing_share_granted", "standing_share_revoked",
] as const;
const SUBJECT_TYPES = [
  "student", "classroom", "institute", "user", "board", "custom_symbol",
  "program", "goal", "objective", "service", "accommodation",
  "progress_report", "data_point", "team_member", "program_contact",
  "student_contact", "biometric_data", "meeting",
  "medical_record", "functional_report", "educational_report",
  "profile_domain", "invite", "consent_form", "transition_plan", "transition_goal",
  "custom_app", "deep_analysis",
  "share_invite", "object_share", "standing_share",
  "incident", "monitor_note", "custom_app_assignment",
] as const;

function eventBadgeVariant(eventType: string): "default" | "secondary" | "destructive" | "outline" {
  switch (eventType) {
    case "create": return "default";
    case "update": return "secondary";
    case "delete": return "destructive";
    case "link":
    case "unlink": return "outline";
    case "view": return "outline";
    case "finalize":
    case "revision": return "secondary";
    // Share lifecycle: revocations/expirations stand out as destructive,
    // grants/redemptions/acceptances as default, mid-flow steps as secondary.
    case "share_revoked":
    case "standing_share_revoked":
    case "share_declined":
    case "share_expired":
      return "destructive";
    case "share_accepted":
    case "share_invite_created":
    case "standing_share_granted":
      return "default";
    case "share_guardian_approved":
    case "share_redeemed":
      return "secondary";
    default: return "outline";
  }
}

function formatSubjectType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------- Sub-Components ----------

function PaginationBar({
  total, limit, offset, onOffsetChange, onLimitChange,
}: {
  total: number; limit: number; offset: number;
  onOffsetChange: (o: number) => void;
  onLimitChange: (l: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <div className="flex items-center justify-between mt-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>{from}–{to} of {total}</span>
        <Select value={String(limit)} onValueChange={(v) => onLimitChange(Number(v))}>
          <SelectTrigger className="w-20 h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10</SelectItem>
            <SelectItem value="25">25</SelectItem>
            <SelectItem value="50">50</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}>
          <ChevronLeft className="w-4 h-4" /> Prev
        </Button>
        <Button variant="outline" size="sm" disabled={offset + limit >= total}
          onClick={() => onOffsetChange(offset + limit)}>
          Next <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function DetailDialog({ entry, open, onClose }: { entry: ActivityLogEntry | null; open: boolean; onClose: () => void }) {
  if (!entry) return null;
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{formatSubjectType(entry.eventType)} — {formatSubjectType(entry.subjectType1)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div><span className="text-muted-foreground">Date:</span> {new Date(entry.createdAt).toLocaleString()}</div>
          <div><span className="text-muted-foreground">User:</span> {entry.userName ?? entry.userEmail ?? entry.userId ?? "—"}</div>
          <div><span className="text-muted-foreground">Organization:</span> {entry.instituteName ?? entry.instituteId ?? "—"}</div>
          <div><span className="text-muted-foreground">Event:</span> {entry.eventType}</div>
          <div><span className="text-muted-foreground">Subject:</span> {formatSubjectType(entry.subjectType1)} ({entry.subjectId1 ?? "—"})</div>
          {entry.subjectType2 && (
            <div><span className="text-muted-foreground">Related:</span> {formatSubjectType(entry.subjectType2)} ({entry.subjectId2 ?? "—"})</div>
          )}
          {entry.isAiInitiated && (
            <div><Badge variant="outline"><Bot className="w-3 h-3 me-1" />AI</Badge></div>
          )}
          {entry.details && (
            <div>
              <span className="text-muted-foreground">Details:</span>
              <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-auto max-h-60">
                {JSON.stringify(entry.details, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Main Component ----------

export function ActivityLog() {
  const { t } = useLanguage();
  const [filters, setFilters] = useState<ActivityLogFilters>({
    limit: 25,
    offset: 0,
  });
  const [selectedEntry, setSelectedEntry] = useState<ActivityLogEntry | null>(null);

  const { data, isLoading } = useActivityLogs(filters);
  const logs = data?.data ?? [];
  const pagination = data?.pagination ?? { total: 0, limit: 25, offset: 0, hasMore: false };

  const updateFilter = (key: keyof ActivityLogFilters, value: string | undefined) => {
    setFilters((f) => ({ ...f, [key]: value === "__all__" ? undefined : (value || undefined), offset: 0 }));
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{t("admin.activityLog.title")}</h1>
        <p className="text-muted-foreground">{t("admin.activityLog.subtitle")}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Select value={filters.eventType ?? ""} onValueChange={(v) => updateFilter("eventType", v)}>
          <SelectTrigger className="w-36 h-8">
            <SelectValue placeholder={t("admin.activityLog.filters.allEvents")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("admin.activityLog.filters.allEvents")}</SelectItem>
            {EVENT_TYPES.map((et) => (
              <SelectItem key={et} value={et}>{t(`admin.activityLog.eventTypes.${et}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.subjectType ?? ""} onValueChange={(v) => updateFilter("subjectType", v)}>
          <SelectTrigger className="w-44 h-8">
            <SelectValue placeholder={t("admin.activityLog.filters.allSubjects")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("admin.activityLog.filters.allSubjects")}</SelectItem>
            {SUBJECT_TYPES.map((st) => (
              <SelectItem key={st} value={st}>{formatSubjectType(st)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.isAiInitiated ?? ""} onValueChange={(v) => updateFilter("isAiInitiated", v)}>
          <SelectTrigger className="w-32 h-8">
            <SelectValue placeholder={t("admin.activityLog.filters.allSources")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("admin.activityLog.filters.allSources")}</SelectItem>
            <SelectItem value="true">{t("admin.activityLog.filters.aiOnly")}</SelectItem>
            <SelectItem value="false">{t("admin.activityLog.filters.humanOnly")}</SelectItem>
          </SelectContent>
        </Select>

        <Input
          type="date"
          className="w-40 h-8"
          value={filters.startDate ?? ""}
          onChange={(e) => updateFilter("startDate", e.target.value)}
          placeholder="From"
        />
        <Input
          type="date"
          className="w-40 h-8"
          value={filters.endDate ?? ""}
          onChange={(e) => updateFilter("endDate", e.target.value)}
          placeholder="To"
        />

        {(filters.eventType || filters.subjectType || filters.isAiInitiated || filters.startDate || filters.endDate) && (
          <Button variant="ghost" size="sm" onClick={() => setFilters({ limit: filters.limit, offset: 0 })}>
            {t("admin.activityLog.filters.clear")}
          </Button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">{t("admin.activityLog.noLogs")}</div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin.activityLog.columns.date")}</TableHead>
                <TableHead>{t("admin.activityLog.columns.user")}</TableHead>
                <TableHead>{t("admin.activityLog.columns.event")}</TableHead>
                <TableHead>{t("admin.activityLog.columns.subject")}</TableHead>
                <TableHead>{t("admin.activityLog.columns.relatedSubject")}</TableHead>
                <TableHead>{t("admin.activityLog.columns.institute")}</TableHead>
                <TableHead className="w-12">{t("admin.activityLog.columns.ai")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((entry) => (
                <TableRow
                  key={entry.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setSelectedEntry(entry)}
                >
                  <TableCell className="text-xs whitespace-nowrap">{formatDate(entry.createdAt)}</TableCell>
                  <TableCell className="text-sm">{entry.userName ?? entry.userEmail ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={eventBadgeVariant(entry.eventType)} className="text-xs">
                      {t(`admin.activityLog.eventTypes.${entry.eventType}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatSubjectType(entry.subjectType1)}
                    {entry.subjectId1 && (
                      <span className="text-xs text-muted-foreground ms-1">({entry.subjectId1.slice(0, 8)})</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {entry.subjectType2 ? (
                      <>
                        {formatSubjectType(entry.subjectType2)}
                        {entry.subjectId2 && (
                          <span className="text-xs text-muted-foreground ms-1">({entry.subjectId2.slice(0, 8)})</span>
                        )}
                      </>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="text-sm">{entry.instituteName ?? "—"}</TableCell>
                  <TableCell>
                    {entry.isAiInitiated && <Bot className="w-4 h-4 text-muted-foreground" />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <PaginationBar
            total={pagination.total}
            limit={filters.limit}
            offset={filters.offset}
            onOffsetChange={(o) => setFilters((f) => ({ ...f, offset: o }))}
            onLimitChange={(l) => setFilters((f) => ({ ...f, limit: l, offset: 0 }))}
          />
        </>
      )}

      <DetailDialog
        entry={selectedEntry}
        open={!!selectedEntry}
        onClose={() => setSelectedEntry(null)}
      />
    </div>
  );
}
