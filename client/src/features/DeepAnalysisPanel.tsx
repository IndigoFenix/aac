// src/features/DeepAnalysisPanel.tsx
//
// Clinician panel for deep analyses. Lets the clinician:
//   - See the list of past analyses for the selected student (history)
//   - Kick off a new analysis with optional special instructions
//   - View the markdown report of any completed analysis
//   - Delete analyses they no longer want
//
// Requires a selected student. Gated on license permission `deepAnalysisEnabled`
// on the server side (this panel is only shown to users whose license grants it).

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import { apiRequest } from "@/lib/queryClient";
import { useStudent } from "@/hooks/useStudent";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Loader2, Sparkles, Trash2, RefreshCcw } from "lucide-react";

marked.setOptions({ async: false });

interface DeepAnalysisRow {
  id: string;
  createdAt: string;
  completedAt: string | null;
  status: "pending" | "running" | "paused" | "complete" | "failed";
  title: string | null;
  summary: string | null;
  model: string;
}

interface DeepAnalysisFullRow extends DeepAnalysisRow {
  reportMarkdown: string | null;
  specialInstructions: string | null;
  error: string | null;
  stepCount: number;
  resumeCount: number;
  thinkingTokens: number;
  inputTokens: number;
  outputTokens: number;
  lastActivityAt: string | null;
}

interface DeepAnalysisPanelProps {
  isOpen?: boolean;
}

export function DeepAnalysisPanel(_props: DeepAnalysisPanelProps) {
  const { t, ts } = useLanguage();
  const { student } = useStudent();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // --- History (list)
  const historyKey = useMemo(() => ["deepAnalyses", student?.id], [student?.id]);
  const { data: history = [], isLoading: historyLoading } = useQuery({
    queryKey: historyKey,
    enabled: !!student?.id,
    refetchInterval: 5000, // cheap: updates status of in-flight analyses
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/deep-analysis?studentId=${student!.id}`);
      if (!res.ok) throw new Error("Failed to load deep analyses");
      return (await res.json()) as DeepAnalysisRow[];
    },
  });

  // --- Selected analysis (full)
  const { data: selected, isLoading: selectedLoading } = useQuery({
    queryKey: ["deepAnalysis", selectedId],
    enabled: !!selectedId,
    refetchInterval: (q) => {
      const row = q.state.data as DeepAnalysisFullRow | undefined;
      if (!row) return 0;
      return row.status === "running" || row.status === "pending" || row.status === "paused" ? 4000 : 0;
    },
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/deep-analysis/${selectedId}`);
      if (!res.ok) throw new Error("Failed to load deep analysis");
      return (await res.json()) as DeepAnalysisFullRow;
    },
  });

  const handleGenerate = async () => {
    if (!student?.id) return;
    setCreating(true);
    try {
      const res = await apiRequest("POST", `/api/deep-analysis`, {
        studentId: student.id,
        specialInstructions: specialInstructions.trim() || undefined,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Failed to create analysis");
      }
      const { id } = (await res.json()) as { id: string };
      setSelectedId(id);
      setSpecialInstructions("");
      await queryClient.invalidateQueries({ queryKey: historyKey });
      toast({ title: t("deepAnalysis.started") });
    } catch (err: any) {
      toast({ title: err.message || t("deepAnalysis.error"), variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t("deepAnalysis.confirmDelete"))) return;
    setDeleting(true);
    try {
      const res = await apiRequest("DELETE", `/api/deep-analysis/${id}`);
      if (!res.ok) throw new Error("Delete failed");
      if (selectedId === id) setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: historyKey });
    } catch (err: any) {
      toast({ title: err.message || t("deepAnalysis.error"), variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  if (!student) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground p-8">
        {t("deepAnalysis.selectStudent")}
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* History sidebar */}
      <aside className="w-64 shrink-0 border-e overflow-y-auto">
        <div className="p-3 border-b">
          <h3 className="text-sm font-semibold">{t("deepAnalysis.history")}</h3>
        </div>
        {historyLoading && (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> {t("deepAnalysis.loading")}
          </div>
        )}
        {!historyLoading && history.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">{t("deepAnalysis.noHistory")}</div>
        )}
        <ul>
          {history.map((h) => (
            // <li> keeps list semantics ("list, N items"), but with role=button
            // it acts as the click target. The interactive-role conflict is
            // intentional and the only way to keep both list announcement +
            // single-element click target.
            <li
              key={h.id}
              // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
              role="button"
              tabIndex={0}
              className={cn(
                "p-3 border-b cursor-pointer hover:bg-accent text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                selectedId === h.id && "bg-accent"
              )}
              onClick={() => setSelectedId(h.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(h.id); }
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">
                    {h.title || t("deepAnalysis.untitled")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(h.createdAt).toLocaleString()}
                  </div>
                  <StatusBadge status={h.status} />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(h.id);
                  }}
                  disabled={deleting}
                  aria-label={t("deepAnalysis.delete")}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </aside>

      {/* Main area */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="p-4 border-b space-y-3">
          <h2 className="text-lg font-semibold">{t("deepAnalysis.title")}</h2>
          <Textarea
            value={specialInstructions}
            onChange={(e) => setSpecialInstructions(e.target.value)}
            placeholder={t("deepAnalysis.specialInstructionsPlaceholder")}
            rows={3}
          />
          <div className="flex items-center gap-2">
            <Button onClick={handleGenerate} disabled={creating}>
              {creating
                ? <><Loader2 className="w-4 h-4 animate-spin me-2" /> {t("deepAnalysis.starting")}</>
                : <><Sparkles className="w-4 h-4 me-2" /> {t("deepAnalysis.generate")}</>}
            </Button>
            <Button
              variant="ghost"
              onClick={() => queryClient.invalidateQueries({ queryKey: historyKey })}
            >
              <RefreshCcw className="w-4 h-4 me-2" /> {t("deepAnalysis.refresh")}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {!selectedId && (
            <div className="text-sm text-muted-foreground">{t("deepAnalysis.selectOrGenerate")}</div>
          )}
          {selectedId && selectedLoading && !selected && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> {t("deepAnalysis.loading")}
            </div>
          )}
          {selected && (
            <div className="space-y-4">
              <header className="space-y-1">
                <h3 className="text-xl font-bold">{selected.title || t("deepAnalysis.untitled")}</h3>
                <div className="text-xs text-muted-foreground">
                  {t("deepAnalysis.started")}: {new Date(selected.createdAt).toLocaleString()}
                  {selected.completedAt && <> · {t("deepAnalysis.completed")}: {new Date(selected.completedAt).toLocaleString()}</>}
                </div>
                <StatusBadge status={selected.status} />
                {selected.specialInstructions && (
                  <div className="text-xs bg-muted/50 rounded p-2 mt-2">
                    <strong>{t("deepAnalysis.specialInstructions")}:</strong> {selected.specialInstructions}
                  </div>
                )}
                {selected.status === "failed" && selected.error && (
                  <div className="text-xs bg-destructive/10 text-destructive rounded p-2">
                    <strong>{t("deepAnalysis.error")}:</strong> {selected.error}
                  </div>
                )}
                {(selected.status === "running" || selected.status === "pending" || selected.status === "paused") && (
                  <div className="text-xs text-muted-foreground">
                    {t("deepAnalysis.inProgress").replace("{{STEP}}", String(selected.stepCount ?? 0))}
                  </div>
                )}
              </header>
              {selected.summary && (
                <div className="text-sm italic bg-muted/30 rounded p-3">
                  {selected.summary}
                </div>
              )}
              {selected.reportMarkdown && (
                <article
                  className="prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: marked.parse(selected.reportMarkdown) as string }}
                />
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: DeepAnalysisRow["status"] }) {
  const { t } = useLanguage();
  const color = {
    pending: "bg-muted text-muted-foreground",
    running: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    paused: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    complete: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    failed: "bg-destructive/10 text-destructive",
  }[status];
  return (
    <span className={cn("inline-block text-xs rounded px-2 py-0.5 mt-1", color)}>
      {t(`deepAnalysis.status.${status}`)}
    </span>
  );
}
