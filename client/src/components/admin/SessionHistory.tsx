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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Eye, ChevronLeft, ChevronRight } from "lucide-react";
import {
  useAACSessionsAdmin,
  useChatSessionsAdmin,
  useAACSessionLog,
  useChatSessionLog,
  type AACSessionSummary,
  type ChatSessionSummary,
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
      <label className="text-sm text-muted-foreground">From</label>
      <Input
        type="date"
        className="w-40 h-8"
        value={startDate}
        onChange={(e) => onStartDateChange(e.target.value)}
      />
      <label className="text-sm text-muted-foreground">To</label>
      <Input
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Session Log</DialogTitle>
        </DialogHeader>
        {query.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No messages in this session.</p>
        ) : (
          <ScrollArea className="flex-1 pr-4" style={{ maxHeight: "60vh" }}>
            {messages.map((msg: any, i: number) => (
              <LogMessage key={i} msg={msg} />
            ))}
          </ScrollArea>
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
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Credits/min</TableHead>
                <TableHead className="w-16" />
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
                    <TableCell className="text-right">{s.creditsUsed.toFixed(2)}</TableCell>
                    <TableCell className="text-right">
                      {formatCostPerMin(s.creditsUsed, s.started, s.ended, s.lastActivity)}
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
        type="aac"
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
                <TableHead className="text-right">Credits</TableHead>
                <TableHead className="text-right">Credits/min</TableHead>
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
                    <TableCell className="text-right">{s.creditsUsed.toFixed(2)}</TableCell>
                    <TableCell className="text-right">
                      {formatCostPerMin(s.creditsUsed, s.started, null, s.lastUpdate)}
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

// ---------- Main Component ----------

export function SessionHistory() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Session History</h1>
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
