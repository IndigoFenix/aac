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
import { Loader2, Eye, ChevronLeft, ChevronRight, FileText, Trash2, Download } from "lucide-react";
import {
  useAACSessionsAdmin,
  useChatSessionsAdmin,
  useAACSessionLog,
  useChatSessionLog,
  useSessionDebugLog,
  useDeleteSessionDebugLogsBefore,
  type AACSessionSummary,
  type ChatSessionSummary,
  type DebugLogEntry,
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
): string {
  const lines: string[] = [];
  lines.push(`Session Log (${type})`);
  lines.push(`Session ID: ${sessionId}`);
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push("=".repeat(60));
  lines.push("");
  for (const msg of messages) {
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
  const aacLog = useAACSessionLog(type === "aac" ? sessionId : null);
  const chatLog = useChatSessionLog(type === "chat" ? sessionId : null);
  const query = type === "aac" ? aacLog : chatLog;
  const messages = query.data?.data ?? [];
  const title = query.data?.title ?? null;
  const summary = query.data?.summary ?? null;
  const importance = query.data?.importance ?? null;
  const hasSummary = !!(title || summary);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pe-6">
            <DialogTitle>Session Log</DialogTitle>
            <Button
              variant="outline"
              size="sm"
              disabled={messages.length === 0 && !hasSummary}
              onClick={() =>
                sessionId &&
                downloadTextFile(
                  `session-log-${type}-${sessionId}.txt`,
                  formatSessionLogText(sessionId, type, messages, title, summary, importance),
                )
              }
            >
              <Download className="w-4 h-4 me-2" /> Export
            </Button>
          </div>
        </DialogHeader>
        {query.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : messages.length === 0 && !hasSummary ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No messages in this session.</p>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto pr-4">
            {messages.map((msg: any, i: number) => (
              <LogMessage key={i} msg={msg} />
            ))}
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
  const [logSession, setLogSession] = useState<string | null>(null);
  const [debugSession, setDebugSession] = useState<string | null>(null);

  const queryFilters = useMemo(
    () => ({
      ...filters,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    }),
    [filters, startDate, endDate]
  );

  const { data, isLoading } = useAACSessionsAdmin(queryFilters);
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
                <TableHead>Student</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Cost/min</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
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
        </TabsList>
        <TabsContent value="aac" className="mt-4">
          <AACTab />
        </TabsContent>
        <TabsContent value="chat" className="mt-4">
          <ChatTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
