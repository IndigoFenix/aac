// src/features/CustomAppPanel.tsx
//
// Clinician panel for custom apps (games). Lets the clinician:
//   - List their saved apps and load one into the editor
//   - See the definition being built/edited by the AI (via Context_CustomApp)
//   - Preview it via the shared GameRuntime
//   - Save to the database (POST /api/custom-apps or PATCH /api/custom-apps/:id)
//   - Assign to / unassign from the active student

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCustomAppStore } from "@/store/custom-app-store";
import { useStudent } from "@/hooks/useStudent";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2, Save, Trash2, UserPlus, UserMinus } from "lucide-react";
import { GameRuntime } from "@client-shared/game-runtime";
import { validateCustomAppDefinition } from "@shared/custom-app-validator";
import type { CustomApp } from "@shared/schema";

interface CustomAppPanelProps {
  isOpen?: boolean;
}

export function CustomAppPanel(_props: CustomAppPanelProps) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const { student } = useStudent();
  const { toast } = useToast();
  const isDark = theme === "dark";

  const {
    definition,
    dbId,
    isDirty,
    apps,
    setDefinition,
    setDbId,
    markClean,
    setApps,
    upsertAppMeta,
    removeAppMeta,
    reset,
  } = useCustomAppStore();

  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(false);

  // --- Fetch the user's apps
  const { data: fetchedApps, isLoading: appsLoading } = useQuery({
    queryKey: ["customApps"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/custom-apps");
      if (!res.ok) throw new Error("Failed to load custom apps");
      return (await res.json()) as Array<Omit<CustomApp, "definition">>;
    },
  });

  useEffect(() => {
    if (fetchedApps) {
      setApps(fetchedApps.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        imageUrl: a.imageUrl,
        updatedAt: (a.updatedAt as unknown as string) ?? undefined,
        loadedAt: (a.loadedAt as unknown as string) ?? undefined,
      })));
    }
  }, [fetchedApps, setApps]);

  // --- Validation status of the current definition
  const validation = useMemo(() => {
    if (!definition) return { ok: true as const, errors: [] };
    return validateCustomAppDefinition(definition);
  }, [definition]);

  const canSave = definition !== null && validation.ok && isDirty && !saving;

  // --- Load an existing app into the editor
  const loadApp = useCallback(async (id: string) => {
    if (isDirty && !confirm(t("customApps.discardUnsavedPrompt"))) return;
    try {
      const res = await apiRequest("GET", `/api/custom-apps/${id}`);
      if (!res.ok) throw new Error("Failed to load");
      const app = (await res.json()) as CustomApp;
      setDefinition(app.definition as never, { markDirty: false });
      setDbId(app.id);
      markClean();
    } catch (err) {
      toast({ title: t("customApps.loadError"), description: String(err), variant: "destructive" });
    }
  }, [isDirty, markClean, setDbId, setDefinition, t, toast]);

  // --- Save (create or update)
  const handleSave = useCallback(async () => {
    if (!definition) return;
    const v = validateCustomAppDefinition(definition);
    if (!v.ok) {
      toast({
        title: t("customApps.invalidDefinition"),
        description: v.errors.slice(0, 4).join("; "),
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: definition.label,
        description: definition.description,
        type: definition.type,
        definition,
        isGenerated: true,
      };
      if (dbId) {
        const res = await apiRequest("PATCH", `/api/custom-apps/${dbId}`, body);
        if (!res.ok) throw new Error((await res.json())?.error ?? "Save failed");
        const updated = (await res.json()) as CustomApp;
        upsertAppMeta({
          id: updated.id,
          name: updated.name,
          description: updated.description,
          imageUrl: updated.imageUrl,
        });
      } else {
        const res = await apiRequest("POST", "/api/custom-apps", body);
        if (!res.ok) throw new Error((await res.json())?.error ?? "Save failed");
        const created = (await res.json()) as CustomApp;
        setDbId(created.id);
        upsertAppMeta({
          id: created.id,
          name: created.name,
          description: created.description,
          imageUrl: created.imageUrl,
        });
      }
      markClean();
      toast({ title: t("customApps.saved") });
    } catch (err) {
      toast({
        title: t("customApps.saveError"),
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [definition, dbId, markClean, setDbId, t, toast, upsertAppMeta]);

  // --- Delete
  const handleDelete = useCallback(async () => {
    if (!dbId) return;
    if (!confirm(t("customApps.confirmDelete"))) return;
    try {
      const res = await apiRequest("DELETE", `/api/custom-apps/${dbId}`);
      if (!res.ok) throw new Error("Delete failed");
      removeAppMeta(dbId);
      reset();
      toast({ title: t("customApps.deleted") });
    } catch (err) {
      toast({ title: t("customApps.deleteError"), description: String(err), variant: "destructive" });
    }
  }, [dbId, removeAppMeta, reset, t, toast]);

  // --- Assignment
  const handleAssign = useCallback(async () => {
    if (!dbId || !student?.id) return;
    setAssigning(true);
    try {
      const res = await apiRequest("POST", `/api/custom-apps/${dbId}/assignments`, {
        studentId: student.id,
      });
      if (!res.ok) throw new Error("Assign failed");
      toast({ title: t("customApps.assigned") });
    } catch (err) {
      toast({ title: t("customApps.assignError"), description: String(err), variant: "destructive" });
    } finally {
      setAssigning(false);
    }
  }, [dbId, student?.id, t, toast]);

  const handleUnassign = useCallback(async () => {
    if (!dbId || !student?.id) return;
    setAssigning(true);
    try {
      const res = await apiRequest(
        "DELETE",
        `/api/custom-apps/${dbId}/assignments/${student.id}`,
      );
      if (!res.ok) throw new Error("Unassign failed");
      toast({ title: t("customApps.unassigned") });
    } catch (err) {
      toast({
        title: t("customApps.unassignError"),
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setAssigning(false);
    }
  }, [dbId, student?.id, t, toast]);

  // --- New blank definition
  const handleNew = useCallback(() => {
    if (isDirty && !confirm(t("customApps.discardUnsavedPrompt"))) return;
    reset();
  }, [isDirty, reset, t]);

  // ------------------------------------------------------------------ Render
  return (
    <div
      className={cn(
        "h-full w-full flex flex-col",
        isDark ? "bg-slate-950 text-slate-100" : "bg-gray-50 text-slate-900",
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "border-b px-4 py-2 shrink-0 flex items-center gap-3",
          isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
        )}
      >
        <select
          value={dbId ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v) void loadApp(v);
            else handleNew();
          }}
          disabled={appsLoading}
          className="text-sm border border-input bg-background rounded-md px-2 py-1 min-w-[200px]"
        >
          <option value="">{t("customApps.newBlank")}</option>
          {apps.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        <div className="flex-1" />

        {dbId && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={!student?.id || assigning}
              onClick={handleAssign}
              title={t("customApps.assign")}
            >
              <UserPlus className="w-4 h-4 mr-1" />
              {t("customApps.assign")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!student?.id || assigning}
              onClick={handleUnassign}
              title={t("customApps.unassign")}
            >
              <UserMinus className="w-4 h-4 mr-1" />
              {t("customApps.unassign")}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDelete} title={t("customApps.delete")}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </>
        )}

        <Button onClick={handleSave} disabled={!canSave}>
          {saving ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-1" />
          )}
          {t("customApps.save")}
        </Button>
      </div>

      {/* Validation errors bar */}
      {definition && !validation.ok && (
        <div
          className={cn(
            "border-b px-4 py-2 text-xs shrink-0",
            isDark ? "bg-red-950 border-red-900 text-red-200" : "bg-red-50 border-red-200 text-red-800",
          )}
        >
          <strong>{t("customApps.invalidDefinition")}:</strong>{" "}
          {validation.errors.slice(0, 3).join(" · ")}
          {validation.errors.length > 3 && ` (+${validation.errors.length - 3})`}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {!definition ? (
          <EmptyState isDark={isDark} />
        ) : (
          <div className="p-4">
            <div className="mb-3 text-sm opacity-80">
              <strong>{definition.label}</strong>
              {definition.description ? ` — ${definition.description}` : null}
            </div>
            {validation.ok ? (
              <GameRuntime def={definition} />
            ) : (
              <pre
                className={cn(
                  "text-xs p-3 rounded border overflow-auto max-h-[400px]",
                  isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
                )}
              >
                {JSON.stringify(definition, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ isDark }: { isDark: boolean }) {
  const { t } = useLanguage();
  return (
    <div
      className={cn(
        "h-full flex items-center justify-center text-center p-8",
        isDark ? "text-slate-400" : "text-gray-600",
      )}
    >
      <div className="max-w-md">
        <h3 className="text-lg font-medium mb-2">{t("customApps.emptyTitle")}</h3>
        <p className="text-sm">{t("customApps.emptyDescription")}</p>
      </div>
    </div>
  );
}
