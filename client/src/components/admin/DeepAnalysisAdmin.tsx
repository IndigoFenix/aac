// src/components/admin/DeepAnalysisAdmin.tsx
//
// System-admin viewer for deep analyses across all students. Follows the
// ActivityLog pattern: filters + paginated table + detail dialog.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { marked } from "marked";
import { renderMarkdownSafe } from "@/lib/markdown";
import { apiRequest } from "@/lib/queryClient";
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
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";

marked.setOptions({ async: false });

const STATUSES = ["pending", "running", "paused", "complete", "failed"] as const;

interface DeepAnalysisListRow {
  id: string;
  studentId: string;
  studentFirstName: string | null;
  studentLastName: string | null;
  createdByUserId: string;
  createdByEmail: string | null;
  model: string;
  status: (typeof STATUSES)[number];
  title: string | null;
  summary: string | null;
  stepCount: number;
  resumeCount: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  costUsd: string; // numeric column arrives as string from drizzle
  createdAt: string;
  completedAt: string | null;
  lastActivityAt: string | null;
}

interface DeepAnalysisDetail extends DeepAnalysisListRow {
  specialInstructions: string | null;
  reportMarkdown: string | null;
  error: string | null;
  messages: unknown[];
  scratch: Record<string, unknown> | null;
}

interface Filters {
  limit: number;
  offset: number;
  studentId?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}

interface ListResponse {
  success: boolean;
  data: DeepAnalysisListRow[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
}

function buildParams(f: Filters): string {
  const p = new URLSearchParams();
  p.set("limit", String(f.limit));
  p.set("offset", String(f.offset));
  if (f.studentId) p.set("studentId", f.studentId);
  if (f.status)    p.set("status", f.status);
  if (f.startDate) p.set("startDate", f.startDate);
  if (f.endDate)   p.set("endDate", f.endDate);
  return p.toString();
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtCost(s: string | number | null | undefined): string {
  if (s == null) return "—";
  const n = typeof s === "string" ? Number(s) : s;
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}

function fmtStudent(r: { studentFirstName: string | null; studentLastName: string | null; studentId: string }): string {
  const name = [r.studentFirstName, r.studentLastName].filter(Boolean).join(" ").trim();
  return name || r.studentId.slice(0, 8);
}

function statusVariant(status: DeepAnalysisListRow["status"]): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "complete": return "default";
    case "running":
    case "pending":
    case "paused":   return "secondary";
    case "failed":   return "destructive";
    default:         return "outline";
  }
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

function DetailDialog({ id, open, onClose }: { id: string | null; open: boolean; onClose: () => void }) {
  const { data, isLoading } = useQuery<{ success: boolean; data: DeepAnalysisDetail }>({
    queryKey: ["/api/admin/deep-analyses", id],
    enabled: open && !!id,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/deep-analyses/${id}`);
      return res.json();
    },
  });
  const row = data?.data;
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{row?.title || "Deep Analysis"}</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}
        {row && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-muted-foreground">ID:</span> {row.id}</div>
              <div><span className="text-muted-foreground">Status:</span> <Badge variant={statusVariant(row.status)}>{row.status}</Badge></div>
              <div><span className="text-muted-foreground">Student:</span> {fmtStudent(row)}</div>
              <div><span className="text-muted-foreground">Clinician:</span> {row.createdByEmail || row.createdByUserId}</div>
              <div><span className="text-muted-foreground">Model:</span> {row.model}</div>
              <div><span className="text-muted-foreground">Cost:</span> {fmtCost(row.costUsd)}</div>
              <div><span className="text-muted-foreground">Started:</span> {fmtDate(row.createdAt)}</div>
              <div><span className="text-muted-foreground">Completed:</span> {fmtDate(row.completedAt)}</div>
              <div><span className="text-muted-foreground">Last activity:</span> {fmtDate(row.lastActivityAt)}</div>
              <div><span className="text-muted-foreground">Steps:</span> {row.stepCount} {row.resumeCount > 0 && `(${row.resumeCount} resumes)`}</div>
              <div><span className="text-muted-foreground">Input tokens:</span> {row.inputTokens.toLocaleString()}</div>
              <div><span className="text-muted-foreground">Output tokens:</span> {row.outputTokens.toLocaleString()}</div>
              <div><span className="text-muted-foreground">Thinking tokens:</span> {row.thinkingTokens.toLocaleString()}</div>
            </div>

            {row.specialInstructions && (
              <div>
                <div className="text-muted-foreground mb-1">Special instructions:</div>
                <pre className="p-2 bg-muted rounded text-xs whitespace-pre-wrap">{row.specialInstructions}</pre>
              </div>
            )}

            {row.status === "failed" && row.error && (
              <div>
                <div className="text-destructive mb-1">Error:</div>
                <pre className="p-2 bg-destructive/10 text-destructive rounded text-xs whitespace-pre-wrap">{row.error}</pre>
              </div>
            )}

            {row.summary && (
              <div>
                <div className="text-muted-foreground mb-1">Summary:</div>
                <div className="italic">{row.summary}</div>
              </div>
            )}

            {row.reportMarkdown && (
              <div>
                <div className="text-muted-foreground mb-1">Report:</div>
                <article
                  className="prose prose-sm dark:prose-invert max-w-none p-3 border rounded"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(row.reportMarkdown) }}
                />
              </div>
            )}

            <details>
              <summary className="cursor-pointer text-muted-foreground text-xs">Scratch (internal state)</summary>
              <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto max-h-60">
                {JSON.stringify(row.scratch ?? {}, null, 2)}
              </pre>
            </details>

            <details>
              <summary className="cursor-pointer text-muted-foreground text-xs">Messages ({row.messages?.length ?? 0})</summary>
              <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto max-h-96">
                {JSON.stringify(row.messages ?? [], null, 2)}
              </pre>
            </details>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- Main Component ----------

export function DeepAnalysisAdmin() {
  const [filters, setFilters] = useState<Filters>({ limit: 25, offset: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const qs = useMemo(() => buildParams(filters), [filters]);
  const { data, isLoading } = useQuery<ListResponse>({
    queryKey: ["/api/admin/deep-analyses", qs],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/deep-analyses?${qs}`);
      return res.json();
    },
  });

  const rows = data?.data ?? [];
  const pagination = data?.pagination ?? { total: 0, limit: 25, offset: 0, hasMore: false };

  // Aggregate totals across the current page (visible rows) so admins see at-a-glance usage.
  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({
        cost:   acc.cost   + Number(r.costUsd || 0),
        input:  acc.input  + (r.inputTokens  || 0),
        output: acc.output + (r.outputTokens || 0),
        think:  acc.think  + (r.thinkingTokens || 0),
      }),
      { cost: 0, input: 0, output: 0, think: 0 },
    );
  }, [rows]);

  const updateFilter = (key: keyof Filters, value: string | undefined) => {
    setFilters((f) => ({
      ...f,
      [key]: value === "__all__" ? undefined : (value || undefined),
      offset: 0,
    }));
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Deep Analyses</h1>
        <p className="text-muted-foreground">All deep-analysis runs across the platform.</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Input
          type="text"
          className="w-64 h-8"
          value={filters.studentId ?? ""}
          onChange={(e) => updateFilter("studentId", e.target.value)}
          placeholder="Student ID"
        />
        <Select value={filters.status ?? ""} onValueChange={(v) => updateFilter("status", v)}>
          <SelectTrigger className="w-36 h-8"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" className="w-40 h-8"
          value={filters.startDate ?? ""}
          onChange={(e) => updateFilter("startDate", e.target.value)} />
        <Input type="date" className="w-40 h-8"
          value={filters.endDate ?? ""}
          onChange={(e) => updateFilter("endDate", e.target.value)} />
        {(filters.studentId || filters.status || filters.startDate || filters.endDate) && (
          <Button variant="ghost" size="sm"
            onClick={() => setFilters({ limit: filters.limit, offset: 0 })}>
            Clear
          </Button>
        )}
        <div className="ms-auto text-xs text-muted-foreground">
          Page totals — cost: {fmtCost(totals.cost)} · in: {totals.input.toLocaleString()} · out: {totals.output.toLocaleString()} · think: {totals.think.toLocaleString()}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No deep analyses match these filters.</div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Student</TableHead>
                <TableHead>Clinician</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-end">Steps</TableHead>
                <TableHead className="text-end">In / Out / Think</TableHead>
                <TableHead className="text-end">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setSelectedId(r.id)}>
                  <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.createdAt)}</TableCell>
                  <TableCell className="text-sm">{fmtStudent(r)}</TableCell>
                  <TableCell className="text-sm">{r.createdByEmail || r.createdByUserId.slice(0, 8)}</TableCell>
                  <TableCell><Badge variant={statusVariant(r.status)} className="text-xs">{r.status}</Badge></TableCell>
                  <TableCell className="text-sm max-w-[220px] truncate">{r.title || "—"}</TableCell>
                  <TableCell className="text-xs">{r.model}</TableCell>
                  <TableCell className="text-xs text-end">{r.stepCount}{r.resumeCount > 0 && <span className="text-muted-foreground"> (+{r.resumeCount})</span>}</TableCell>
                  <TableCell className="text-xs text-end whitespace-nowrap">
                    {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()} / {r.thinkingTokens.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm text-end">{fmtCost(r.costUsd)}</TableCell>
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
        id={selectedId}
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
