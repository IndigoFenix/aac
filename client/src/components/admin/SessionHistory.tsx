import { useState, useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CostBreakdownCell } from "./CostBreakdownCell";
import { Loader2, Eye, ChevronLeft, ChevronRight, FileText, Trash2, Download, Coins } from "lucide-react";
import {
  useAACSessionsAdmin,
  useChatSessionsAdmin,
  useCaptionProjectsAdmin,
  useAACSessionLog,
  useChatSessionLog,
  useSessionDebugLog,
  useSessionCostEvents,
  useDeleteSessionDebugLogsBefore,
  type AACSessionSummary,
  type CaptionProjectSummary,
  type ChatSessionSummary,
  type DebugLogEntry,
  type CostEvent,
  type SessionFilters,
} from "@/hooks/useSessionHistory";

// ---------- Helpers ----------

function formatDuration(startStr: string, endStr: string | null | undefined, fallbackStr?: string): string {
  const start = new Date(startStr).getTime();
  const end = endStr ? new Date(endStr).getTime() : fallbackStr ? new Date(fallbackStr).getTime() : Date.now();
  const diffMs = end - start;
  if (diffMs < 0) return "--";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatCostPerMin(credits: number, startStr: string, endStr: string | null | undefined, fallbackStr?: string): string {
  const start = new Date(startStr).getTime();
  const end = endStr ? new Date(endStr).getTime() : fallbackStr ? new Date(fallbackStr).getTime() : Date.now();
  const mins = (end - start) / 60000;
  if (mins <= 0 || credits <= 0) return "--";
  return (credits / mins).toFixed(3);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact time-of-day (with seconds) — used on cost rows so a charge can be
 *  lined up against the message it followed. */
function formatClock(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** One-line token/model summary for a cost charge (empty for char-billed
 *  charges like TTS/STT that carry no token detail). */
function costTokenSummary(ev: CostEvent): string {
  const parts: string[] = [];
  if (ev.model) parts.push(ev.model);
  if (ev.promptTokens != null) parts.push(`in ${ev.promptTokens}`);
  if (ev.completionTokens != null) parts.push(`out ${ev.completionTokens}`);
  if (ev.cachedTokens) parts.push(`cached ${ev.cachedTokens}`);
  if (ev.cacheCreationTokens) parts.push(`cacheWrite ${ev.cacheCreationTokens}`);
  return parts.join(" · ");
}

type TimelineItem =
  | { kind: "msg"; ts: number; sort: number; msg: any }
  | { kind: "cost"; ts: number; sort: number; ev: CostEvent; cumulative: number };

/** Merge conversation messages and per-charge cost events into one
 *  time-ordered stream so costs sit next to the events that incurred them.
 *  `cumulative` is running spend in cost-event order (the endpoint already
 *  returns them oldest→newest, matching timestamp order). Messages without a
 *  timestamp inherit the previous message's time so they keep their order. */
function buildSessionTimeline(messages: any[], costEvents: CostEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastTs = 0;
  messages.forEach((msg, i) => {
    const raw = msg.timestamp || msg.createdAt;
    const t = raw ? new Date(raw).getTime() : NaN;
    if (!Number.isNaN(t)) lastTs = t;
    items.push({ kind: "msg", ts: Number.isNaN(t) ? lastTs : t, sort: i, msg });
  });
  let cum = 0;
  costEvents.forEach((ev, i) => {
    cum += ev.credits;
    const t = new Date(ev.timestamp).getTime();
    items.push({ kind: "cost", ts: Number.isNaN(t) ? lastTs : t, sort: i, ev, cumulative: cum });
  });
  // Time order; at an identical timestamp keep a message before the charge it triggered.
  items.sort((a, b) => a.ts - b.ts || (a.kind === b.kind ? a.sort - b.sort : a.kind === "msg" ? -1 : 1));
  return items;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active":
    case "open":
      return "default";
    case "paused":
      return "secondary";
    case "ended":
    case "closed":
      return "outline";
    default:
      return "outline";
  }
}

/** Trigger a browser download of plain-text content as a .txt file. */
function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Format a session conversation log (messages + summary) as plain text. */
function formatSessionLogText(
  sessionId: string,
  type: "aac" | "chat",
  messages: any[],
  title: string | null,
  summary: string | null,
  importance: number | null,
  costEvents: CostEvent[] = [],
): string {
  const lines: string[] = [];
  lines.push(`Session Log (${type})`);
  lines.push(`Session ID: ${sessionId}`);
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push("=".repeat(60));
  lines.push("");
  for (const item of buildSessionTimeline(messages, costEvents)) {
    if (item.kind === "cost") {
      const ev = item.ev;
      const toks = costTokenSummary(ev);
      lines.push(
        `[cost] ${new Date(ev.timestamp).toISOString()} ${ev.category} +$${ev.credits.toFixed(4)}` +
          ` (Σ $${item.cumulative.toFixed(4)})${toks ? ` — ${toks}` : ""}`,
      );
      lines.push("");
      continue;
    }
    const msg = item.msg;
    const role = msg.role || msg.type || "unknown";
    const content =
      typeof msg.content === "string"
        ? msg.content
        : typeof msg.text === "string"
          ? msg.text
          : JSON.stringify(msg.content ?? msg.text ?? msg, null, 2);
    const ts = msg.timestamp || msg.createdAt;
    lines.push(`[${role}]${ts ? ` ${new Date(ts).toISOString()}` : ""}`);
    lines.push(content);
    lines.push("");
  }
  if (title || summary) {
    lines.push("=".repeat(60));
    lines.push("SESSION SUMMARY");
    if (typeof importance === "number") lines.push(`Importance: ${importance}`);
    if (title) lines.push(`Title: ${title}`);
    if (summary) lines.push(summary);
  }
  return lines.join("\n");
}

/** Format a session debug trace as plain text. */
function formatDebugLogText(sessionId: string, entries: DebugLogEntry[]): string {
  const lines: string[] = [];
  lines.push("Session Debug Log");
  lines.push(`Session ID: ${sessionId}`);
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push(`Entries: ${entries.length}`);
  lines.push("=".repeat(60));
  lines.push("");
  for (const e of entries) {
    lines.push(`#${e.seq} [${e.section}] ${new Date(e.timestamp).toISOString()}`);
    lines.push(e.content);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- Sub-Components ----------

function PaginationBar({
  total,
  limit,
  offset,
  onOffsetChange,
  onLimitChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onOffsetChange: (o: number) => void;
  onLimitChange: (l: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <div className="flex items-center justify-between mt-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>
          Showing {from}–{to} of {total}
        </span>
        <Select value={String(limit)} onValueChange={(v) => onLimitChange(Number(v))}>
          <SelectTrigger className="w-20 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10</SelectItem>
            <SelectItem value="25">25</SelectItem>
            <SelectItem value="50">50</SelectItem>
          </SelectContent>
        </Select>
        <span>per page</span>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        >
          <ChevronLeft className="w-4 h-4" /> Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={offset + limit >= total}
          onClick={() => onOffsetChange(offset + limit)}
        >
          Next <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function FilterBar({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
}: {
  startDate: string;
  endDate: string;
  onStartDateChange: (v: string) => void;
  onEndDateChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <label htmlFor="session-history-start-date" className="text-sm text-muted-foreground">From</label>
      <Input
        id="session-history-start-date"
        type="date"
        className="w-40 h-8"
        value={startDate}
        onChange={(e) => onStartDateChange(e.target.value)}
      />
      <label htmlFor="session-history-end-date" className="text-sm text-muted-foreground">To</label>
      <Input
        id="session-history-end-date"
        type="date"
        className="w-40 h-8"
        value={endDate}
        onChange={(e) => onEndDateChange(e.target.value)}
      />
      {(startDate || endDate) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onStartDateChange("");
            onEndDateChange("");
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}

const IMPORTANCE_LABELS: Record<number, string> = {
  0: "0 · nothing happened",
  1: "1 · routine",
  2: "2 · interesting",
  3: "3 · major milestone",
};

/** AAC-tab-only filters: student search, cost range, duration range, min importance. */
function AACFilterBar({
  student,
  minCost,
  maxCost,
  minDurationMin,
  maxDurationMin,
  minImportance,
  onStudentChange,
  onMinCostChange,
  onMaxCostChange,
  onMinDurationChange,
  onMaxDurationChange,
  onMinImportanceChange,
}: {
  student: string;
  minCost: string;
  maxCost: string;
  minDurationMin: string;
  maxDurationMin: string;
  minImportance: string;
  onStudentChange: (v: string) => void;
  onMinCostChange: (v: string) => void;
  onMaxCostChange: (v: string) => void;
  onMinDurationChange: (v: string) => void;
  onMaxDurationChange: (v: string) => void;
  onMinImportanceChange: (v: string) => void;
}) {
  const hasAny =
    student || minCost || maxCost || minDurationMin || maxDurationMin || (minImportance && minImportance !== "__any__");

  return (
    <div className="flex items-center gap-3 mb-4 flex-wrap">
      <label htmlFor="aac-filter-student" className="text-sm text-muted-foreground">Student</label>
      <Input
        id="aac-filter-student"
        placeholder="Name or ID"
        className="w-40 h-8"
        value={student}
        onChange={(e) => onStudentChange(e.target.value)}
      />

      <label htmlFor="aac-filter-min-cost" className="text-sm text-muted-foreground">Cost</label>
      <div className="flex items-center gap-1">
        <Input
          id="aac-filter-min-cost"
          type="number"
          step="0.01"
          min="0"
          placeholder="min $"
          className="w-24 h-8"
          value={minCost}
          onChange={(e) => onMinCostChange(e.target.value)}
        />
        <span className="text-muted-foreground text-sm">–</span>
        <Input
          type="number"
          step="0.01"
          min="0"
          placeholder="max $"
          className="w-24 h-8"
          value={maxCost}
          onChange={(e) => onMaxCostChange(e.target.value)}
        />
      </div>

      <label htmlFor="aac-filter-min-duration" className="text-sm text-muted-foreground">Duration (min)</label>
      <div className="flex items-center gap-1">
        <Input
          id="aac-filter-min-duration"
          type="number"
          min="0"
          placeholder="min"
          className="w-20 h-8"
          value={minDurationMin}
          onChange={(e) => onMinDurationChange(e.target.value)}
        />
        <span className="text-muted-foreground text-sm">–</span>
        <Input
          type="number"
          min="0"
          placeholder="max"
          className="w-20 h-8"
          value={maxDurationMin}
          onChange={(e) => onMaxDurationChange(e.target.value)}
        />
      </div>

      <label htmlFor="aac-filter-importance" className="text-sm text-muted-foreground">Importance</label>
      <Select value={minImportance || "__any__"} onValueChange={onMinImportanceChange}>
        <SelectTrigger id="aac-filter-importance" className="w-44 h-8">
          <SelectValue placeholder="Any" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__any__">Any</SelectItem>
          {[0, 1, 2, 3].map((lvl) => (
            <SelectItem key={lvl} value={String(lvl)}>{IMPORTANCE_LABELS[lvl]}+</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasAny && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onStudentChange("");
            onMinCostChange("");
            onMaxCostChange("");
            onMinDurationChange("");
            onMaxDurationChange("");
            onMinImportanceChange("");
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}

function LogMessage({ msg }: { msg: any }) {
  const role = msg.role || msg.type || "unknown";
  const content =
    typeof msg.content === "string"
      ? msg.content
      : typeof msg.text === "string"
        ? msg.text
        : JSON.stringify(msg.content ?? msg.text ?? msg, null, 2);
  const ts = msg.timestamp || msg.createdAt;

  return (
    <div className="flex gap-2 py-2 border-b last:border-b-0">
      <Badge variant={role === "user" || role === "student" ? "default" : "secondary"} className="h-5 text-xs shrink-0">
        {role}
      </Badge>
      <div className="flex-1 min-w-0">
        <p className="text-sm whitespace-pre-wrap break-words">{content}</p>
        {ts && <p className="text-xs text-muted-foreground mt-1">{formatDate(ts)}</p>}
      </div>
    </div>
  );
}

function DebugLogDialog({
  open,
  onOpenChange,
  sessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
}) {
  const [section, setSection] = useState<string>("");
  const query = useSessionDebugLog(sessionId, { section: section || undefined, limit: 1000 });
  const entries: DebugLogEntry[] = query.data?.data ?? [];

  // Build list of unique sections seen in the result, for the filter dropdown.
  const sections = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.section);
    return Array.from(set).sort();
  }, [entries]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pe-6">
            <DialogTitle>Session Debug Log</DialogTitle>
            <Button
              variant="outline"
              size="sm"
              disabled={entries.length === 0}
              onClick={() =>
                sessionId &&
                downloadTextFile(
                  `debug-log-${sessionId}${section ? `-${section}` : ""}.txt`,
                  formatDebugLogText(sessionId, entries),
                )
              }
            >
              <Download className="w-4 h-4 me-2" /> Export
            </Button>
          </div>
        </DialogHeader>
        <div className="flex items-center gap-3 pb-2 border-b">
          <span className="text-sm text-muted-foreground">Filter:</span>
          <Select value={section || "__all__"} onValueChange={(v) => setSection(v === "__all__" ? "" : v)}>
            <SelectTrigger className="w-72 h-8">
              <SelectValue placeholder="All sections" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All sections</SelectItem>
              {sections.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground ms-auto">
            {query.data?.pagination ? `${entries.length} of ${query.data.pagination.total} entries` : null}
          </span>
        </div>
        {query.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No debug entries for this session. Only sessions started with debug mode enabled produce a trace.
          </p>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto font-mono text-xs">
            {entries.map((e) => (
              <div key={e.id} className="border-b py-2">
                <div className="flex items-baseline gap-2 mb-1">
                  <Badge variant="secondary" className="text-xs">{e.section}</Badge>
                  <span className="text-muted-foreground text-xs">{new Date(e.timestamp).toISOString()}</span>
                  <span className="text-muted-foreground text-xs">#{e.seq}</span>
                </div>
                <pre className="whitespace-pre-wrap break-words bg-muted/40 p-2 rounded">{e.content}</pre>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One inline cost charge in the session timeline — visually distinct from a
 *  message, right-aligned amount + running total, seconds-precise time so it
 *  correlates with the surrounding events. */
function CostEventRow({ ev, cumulative }: { ev: CostEvent; cumulative: number }) {
  const toks = costTokenSummary(ev);
  return (
    <div className="flex items-center gap-2 py-1.5 ps-6 border-b last:border-b-0 bg-amber-50/50 dark:bg-amber-950/20">
      <Coins className="w-3.5 h-3.5 text-amber-600 dark:text-amber-500 shrink-0" />
      <span className="font-mono text-xs truncate" title={ev.label ?? undefined}>{ev.category}</span>
      {toks && <span className="text-[11px] text-muted-foreground truncate hidden sm:inline">{toks}</span>}
      <span className="ms-auto text-xs tabular-nums shrink-0 whitespace-nowrap">
        +${ev.credits.toFixed(4)}
        <span className="text-muted-foreground ms-2">Σ&nbsp;${cumulative.toFixed(4)}</span>
      </span>
      <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums w-[64px] text-end">
        {formatClock(ev.timestamp)}
      </span>
    </div>
  );
}

function SessionLogDialog({
  open,
  onOpenChange,
  sessionId,
  type,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  type: "aac" | "chat";
}) {
  const [showCosts, setShowCosts] = useState(true);
  const aacLog = useAACSessionLog(type === "aac" ? sessionId : null);
  const chatLog = useChatSessionLog(type === "chat" ? sessionId : null);
  const query = type === "aac" ? aacLog : chatLog;
  // Up to 5000 charges so long Live sessions aren't silently truncated.
  const costQuery = useSessionCostEvents(sessionId, { limit: 5000 });
  const messages = query.data?.data ?? [];
  const costEvents: CostEvent[] = costQuery.data?.data ?? [];
  const costTotalCount = costQuery.data?.pagination?.total ?? costEvents.length;
  const totalCost = useMemo(() => costEvents.reduce((a, e) => a + e.credits, 0), [costEvents]);
  const title = query.data?.title ?? null;
  const summary = query.data?.summary ?? null;
  const importance = query.data?.importance ?? null;
  const hasSummary = !!(title || summary);
  const timeline = useMemo(
    () => buildSessionTimeline(messages, showCosts ? costEvents : []),
    [messages, costEvents, showCosts],
  );
  const isEmpty = messages.length === 0 && costEvents.length === 0 && !hasSummary;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pe-6">
            <DialogTitle>Session Log</DialogTitle>
            <div className="flex items-center gap-2">
              {costEvents.length > 0 && (
                <Button
                  variant={showCosts ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setShowCosts((v) => !v)}
                  title="Show per-charge costs inline with the conversation"
                >
                  <Coins className="w-4 h-4 me-2" />
                  {showCosts ? "Hide" : "Show"} costs · ${totalCost.toFixed(4)}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={isEmpty}
                onClick={() =>
                  sessionId &&
                  downloadTextFile(
                    `session-log-${type}-${sessionId}.txt`,
                    formatSessionLogText(sessionId, type, messages, title, summary, importance, costEvents),
                  )
                }
              >
                <Download className="w-4 h-4 me-2" /> Export
              </Button>
            </div>
          </div>
        </DialogHeader>
        {query.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : isEmpty ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No messages in this session.</p>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto pr-4">
            {showCosts && costEvents.length < costTotalCount && (
              <p className="text-[11px] text-muted-foreground py-2 text-center">
                Showing first {costEvents.length} of {costTotalCount} charges.
              </p>
            )}
            {timeline.map((item) =>
              item.kind === "cost" ? (
                <CostEventRow key={`c-${item.ev.id}`} ev={item.ev} cumulative={item.cumulative} />
              ) : (
                <LogMessage key={`m-${item.sort}`} msg={item.msg} />
              ),
            )}
            {hasSummary && (
              <div className="mt-4 pt-3 border-t-2 border-dashed bg-muted/30 -mx-4 px-4 py-3">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary" className="text-xs">Session Summary</Badge>
                  {typeof importance === "number" && (
                    <Badge variant="outline" className="text-xs">importance: {importance}</Badge>
                  )}
                </div>
                {title && <p className="text-sm font-semibold mb-1">{title}</p>}
                {summary && (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{summary}</p>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- Tab Contents ----------

function AACTab() {
  const [filters, setFilters] = useState<SessionFilters>({ limit: 25, offset: 0 });
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [student, setStudent] = useState("");
  const [minCost, setMinCost] = useState("");
  const [maxCost, setMaxCost] = useState("");
  const [minDurationMin, setMinDurationMin] = useState("");
  const [maxDurationMin, setMaxDurationMin] = useState("");
  const [minImportance, setMinImportance] = useState("");
  const [logSession, setLogSession] = useState<string | null>(null);
  const [debugSession, setDebugSession] = useState<string | null>(null);

  const queryFilters = useMemo(
    () => ({
      ...filters,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      student: student || undefined,
      minCost: minCost ? Number(minCost) : undefined,
      maxCost: maxCost ? Number(maxCost) : undefined,
      minDurationMin: minDurationMin ? Number(minDurationMin) : undefined,
      maxDurationMin: maxDurationMin ? Number(maxDurationMin) : undefined,
      minImportance: minImportance && minImportance !== "__any__" ? Number(minImportance) : undefined,
    }),
    [filters, startDate, endDate, student, minCost, maxCost, minDurationMin, maxDurationMin, minImportance]
  );

  const { data, isLoading } = useAACSessionsAdmin(queryFilters);
  const sessions = data?.data ?? [];
  const pagination = data?.pagination ?? { total: 0, limit: 25, offset: 0, hasMore: false };

  const resetOffset = () => setFilters((f) => ({ ...f, offset: 0 }));

  return (
    <>
      <FilterBar
        startDate={startDate}
        endDate={endDate}
        onStartDateChange={(v) => { setStartDate(v); resetOffset(); }}
        onEndDateChange={(v) => { setEndDate(v); resetOffset(); }}
      />
      <AACFilterBar
        student={student}
        minCost={minCost}
        maxCost={maxCost}
        minDurationMin={minDurationMin}
        maxDurationMin={maxDurationMin}
        minImportance={minImportance}
        onStudentChange={(v) => { setStudent(v); resetOffset(); }}
        onMinCostChange={(v) => { setMinCost(v); resetOffset(); }}
        onMaxCostChange={(v) => { setMaxCost(v); resetOffset(); }}
        onMinDurationChange={(v) => { setMinDurationMin(v); resetOffset(); }}
        onMaxDurationChange={(v) => { setMaxDurationMin(v); resetOffset(); }}
        onMinImportanceChange={(v) => { setMinImportance(v); resetOffset(); }}
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Student</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Cost/min</TableHead>
                <TableHead>Importance</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No AAC sessions found.
                  </TableCell>
                </TableRow>
              ) : (
                sessions.map((s: AACSessionSummary) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.studentName ?? s.studentId}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(s.started)}</TableCell>
                    <TableCell>
                      {formatDuration(s.started, s.ended, s.lastActivity)}
                      {s.status === "active" && (
                        <span className="text-xs text-muted-foreground ms-1">(active)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <CostBreakdownCell credits={s.creditsUsed} breakdown={s.costBreakdown} />
                    </TableCell>
                    <TableCell className="text-right">
                      ${formatCostPerMin(s.creditsUsed, s.started, s.ended, s.lastActivity)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{s.importance}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => setLogSession(s.id)} title="Conversation log">
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setDebugSession(s.id)} title="Debug trace">
                          <FileText className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
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

      <SessionLogDialog
        open={!!logSession}
        onOpenChange={(open) => { if (!open) setLogSession(null); }}
        sessionId={logSession}
        type="aac"
      />
      <DebugLogDialog
        open={!!debugSession}
        onOpenChange={(open) => { if (!open) setDebugSession(null); }}
        sessionId={debugSession}
      />
    </>
  );
}

function ChatTab() {
  const [filters, setFilters] = useState<SessionFilters>({ limit: 25, offset: 0 });
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [logSession, setLogSession] = useState<string | null>(null);

  const queryFilters = useMemo(
    () => ({
      ...filters,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    }),
    [filters, startDate, endDate]
  );

  const { data, isLoading } = useChatSessionsAdmin(queryFilters);
  const sessions = data?.data ?? [];
  const pagination = data?.pagination ?? { total: 0, limit: 25, offset: 0, hasMore: false };

  return (
    <>
      <FilterBar
        startDate={startDate}
        endDate={endDate}
        onStartDateChange={(v) => { setStartDate(v); setFilters((f) => ({ ...f, offset: 0 })); }}
        onEndDateChange={(v) => { setEndDate(v); setFilters((f) => ({ ...f, offset: 0 })); }}
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Student</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Cost/min</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No chat sessions found.
                  </TableCell>
                </TableRow>
              ) : (
                sessions.map((s: ChatSessionSummary) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.userName ?? s.userId ?? "--"}</TableCell>
                    <TableCell>{s.studentName ?? s.studentId ?? "--"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{s.chatMode}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(s.started)}</TableCell>
                    <TableCell>
                      {formatDuration(s.started, null, s.lastUpdate)}
                      {s.status === "open" && (
                        <span className="text-xs text-muted-foreground ms-1">(active)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <CostBreakdownCell credits={s.creditsUsed} breakdown={s.costBreakdown} />
                    </TableCell>
                    <TableCell className="text-right">
                      ${formatCostPerMin(s.creditsUsed, s.started, null, s.lastUpdate)}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => setLogSession(s.id)}>
                        <Eye className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
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

      <SessionLogDialog
        open={!!logSession}
        onOpenChange={(open) => { if (!open) setLogSession(null); }}
        sessionId={logSession}
        type="chat"
      />
    </>
  );
}

// ---------- Debug-log maintenance ----------

/** Admin control to bulk-delete session debug logs older than a chosen date.
 *  Debug-only / admin-only, so strings stay in English (no i18n). */
function DebugLogPurge() {
  const [before, setBefore] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const mutation = useDeleteSessionDebugLogsBefore();

  const handleConfirm = () => {
    setResult(null);
    mutation.mutate(before, {
      onSuccess: (data) => {
        setConfirmOpen(false);
        if (data.success) {
          const n = data.deleted ?? 0;
          setResult(`Deleted ${n} debug log ${n === 1 ? "entry" : "entries"} before ${before}.`);
        } else {
          setResult(data.message || "Failed to delete debug logs.");
        }
      },
      onError: (err) => {
        setConfirmOpen(false);
        setResult(err.message || "Failed to delete debug logs.");
      },
    });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm text-muted-foreground">Delete debug logs before:</span>
      <Input
        type="date"
        value={before}
        onChange={(e) => { setBefore(e.target.value); setResult(null); }}
        className="w-40 h-9"
      />
      <Button
        variant="destructive"
        size="sm"
        disabled={!before || mutation.isPending}
        onClick={() => setConfirmOpen(true)}
      >
        {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        <span className="ms-2">Delete</span>
      </Button>
      {result && <span className="text-xs text-muted-foreground">{result}</span>}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete debug logs?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This permanently deletes ALL session debug logs recorded before{" "}
            <span className="font-semibold">{before}</span>, across every session. This cannot be undone.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleConfirm} disabled={mutation.isPending}>
              {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : null}
              Delete logs
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- Main Component ----------

function CaptionProjectsTab() {
  const [filters, setFilters] = useState<SessionFilters>({ limit: 25, offset: 0 });
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const queryFilters = useMemo(
    () => ({ ...filters, startDate: startDate || undefined, endDate: endDate || undefined }),
    [filters, startDate, endDate],
  );

  const { data, isLoading } = useCaptionProjectsAdmin(queryFilters);
  const projects = data?.data ?? [];
  const pagination = data?.pagination ?? { total: 0, limit: 25, offset: 0, hasMore: false };

  return (
    <>
      <FilterBar
        startDate={startDate}
        endDate={endDate}
        onStartDateChange={(v) => { setStartDate(v); setFilters((f) => ({ ...f, offset: 0 })); }}
        onEndDateChange={(v) => { setEndDate(v); setFilters((f) => ({ ...f, offset: 0 })); }}
      />
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Video</TableHead>
                <TableHead>Lang</TableHead>
                <TableHead>Clinician</TableHead>
                <TableHead>Student</TableHead>
                <TableHead>Institute</TableHead>
                <TableHead className="text-right">Captions</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No caption projects found.
                  </TableCell>
                </TableRow>
              ) : (
                projects.map((p: CaptionProjectSummary) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium max-w-[16rem] truncate" title={p.videoName ?? undefined}>
                      {p.videoName ?? "(untitled)"}
                    </TableCell>
                    <TableCell>{p.language ?? "—"}</TableCell>
                    <TableCell>{p.userName ?? "—"}</TableCell>
                    <TableCell>{p.studentName ?? "—"}</TableCell>
                    <TableCell>{p.instituteName ?? "—"}</TableCell>
                    <TableCell className="text-right">{p.segmentCount ?? 0}</TableCell>
                    <TableCell>{formatDate(p.updatedAt)}</TableCell>
                    <TableCell className="text-right">
                      <CostBreakdownCell credits={p.creditsUsed} breakdown={p.costBreakdown} />
                    </TableCell>
                  </TableRow>
                ))
              )}
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
    </>
  );
}

export function SessionHistory() {
  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <h1 className="text-2xl font-bold">Session History</h1>
        <DebugLogPurge />
      </div>
      <Tabs defaultValue="aac">
        <TabsList>
          <TabsTrigger value="aac">AAC Sessions</TabsTrigger>
          <TabsTrigger value="chat">Chat Sessions</TabsTrigger>
          <TabsTrigger value="captions">Caption Projects</TabsTrigger>
        </TabsList>
        <TabsContent value="aac" className="mt-4">
          <AACTab />
        </TabsContent>
        <TabsContent value="chat" className="mt-4">
          <ChatTab />
        </TabsContent>
        <TabsContent value="captions" className="mt-4">
          <CaptionProjectsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
