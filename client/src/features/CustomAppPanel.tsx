// src/features/CustomAppPanel.tsx
//
// Clinician panel for custom apps (games). The panel is now a full editor:
//   - 3-pane layout (left: object/room/button lists, center: object editor or
//     room canvas, right: contextual inspector that falls through to room and
//     then app properties when nothing finer is selected)
//   - Play mode swaps the body for the shared GameRuntime
//
// The AI also edits the underlying GameDefinition through the Zustand store
// (Context_CustomApp), so anything the editor changes is visible to the AI
// and vice versa.

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCustomAppStore } from "@/store/custom-app-store";
import { useFeaturePanel, useSharedState } from "@/contexts/FeaturePanelContext";
import { useStudent } from "@/hooks/useStudent";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2, Play, Save, Square, Trash2, UserCheck, UserPlus } from "lucide-react";
import { GameRuntime } from "@client-shared/game-runtime";
import { validateCustomAppDefinition } from "@shared/custom-app-validator";
import type { CustomApp } from "@shared/schema";
import { LeftRail } from "./custom-app/LeftRail";
import { RightRail } from "./custom-app/RightRail";
import { RoomEditor } from "./custom-app/RoomEditor";
import { ObjectEditor } from "./custom-app/ObjectEditor";
import { GoalTreeGamePreview } from "./custom-app/GoalTreeGamePreview";
import { editorReducer, initialEditorState } from "./custom-app/editor-state";
import { GOAL_TREE_APP_TYPE } from "@shared/goal-tree/types";

interface CustomAppPanelProps {
  isOpen?: boolean;
}

export function CustomAppPanel(_props: CustomAppPanelProps) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const { student } = useStudent();
  const { currentInstitute } = useInstitute();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();
  const { sharedState, setSharedState } = useSharedState();
  const isDark = theme === "dark";

  const {
    definition,
    dbId,
    isDirty,
    apps,
    questGame,
    questDirty,
    setDefinition,
    setDbId,
    markClean,
    setApps,
    upsertAppMeta,
    removeAppMeta,
    reset,
    setQuestGame,
    markQuestClean,
  } = useCustomAppStore();

  const [editor, dispatchEditor] = useReducer(editorReducer, initialEditorState);
  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(false);

  // --- Fetch the user's apps. Always refetch on mount so games created
  // through the chat (createQuestGame tool) appear without a full reload.
  const { data: fetchedApps, isLoading: appsLoading } = useQuery({
    queryKey: ["customApps"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/custom-apps");
      if (!res.ok) throw new Error("Failed to load custom apps");
      return (await res.json()) as Array<Omit<CustomApp, "definition">>;
    },
    refetchOnMount: "always",
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

  // --- Feed the open app/quest game to the chat AI each turn (featureContext
  // → Context_CustomApp / Context_QuestGame), so it edits current state.
  const buildCustomAppsMetadata = useCallback(() => {
    const featureContext: Record<string, unknown> = {};
    if (definition) featureContext.customapp = { data: definition };
    if (questGame) {
      featureContext.questgame = {
        data: {
          appId: questGame.appId,
          name: questGame.name,
          contentPack: questGame.contentPack,
        },
      };
    }
    return Object.keys(featureContext).length > 0 ? { featureContext } : {};
  }, [definition, questGame]);

  useEffect(() => {
    registerMetadataBuilder("customApps", buildCustomAppsMetadata);
    return () => unregisterMetadataBuilder("customApps");
  }, [registerMetadataBuilder, unregisterMetadataBuilder, buildCustomAppsMetadata]);

  // --- Is the open app assigned to the currently-selected student?
  const assignmentsQueryKey = useMemo(
    () => ["customApp:assignments", dbId],
    [dbId],
  );
  const { data: assignments } = useQuery({
    queryKey: assignmentsQueryKey,
    queryFn: async () => {
      if (!dbId) return [] as Array<{ appId: string; studentId: string }>;
      const res = await apiRequest("GET", `/api/custom-apps/${dbId}/assignments`);
      if (!res.ok) throw new Error("Failed to load assignments");
      return (await res.json()) as Array<{ appId: string; studentId: string }>;
    },
    enabled: !!dbId,
  });
  const isAssignedToCurrentStudent = !!(
    student?.id && assignments?.some((a) => a.studentId === student.id)
  );

  // --- Validation status of the current definition
  const validation = useMemo(() => {
    if (!definition) return { ok: true as const, errors: [] };
    return validateCustomAppDefinition(definition);
  }, [definition]);

  const canSave =
    (questGame !== null ? questDirty : definition !== null && validation.ok && isDirty) &&
    !saving;

  // --- Load an existing app into the editor (or, for goal-tree quest games,
  // into the embedded player preview — they are played here, not edited)
  const loadApp = useCallback(async (id: string) => {
    if ((isDirty || questDirty) && !confirm(t("customApps.discardUnsavedPrompt"))) return;
    try {
      const res = await apiRequest("GET", `/api/custom-apps/${id}`);
      if (!res.ok) throw new Error("Failed to load");
      const app = (await res.json()) as CustomApp;
      if (app.type === GOAL_TREE_APP_TYPE) {
        reset(); // clear any v1 definition + stale quest state
        const contentPack = (app.definition as { contentPack?: unknown } | null)?.contentPack;
        setQuestGame({
          appId: app.id,
          name: app.name,
          language: app.language,
          contentPack: contentPack ?? null,
        });
        setDbId(app.id); // assignment/delete controls key off dbId
        dispatchEditor({ type: "selectNone" });
        return;
      }
      setQuestGame(null);
      setDefinition(app.definition as never, { markDirty: false });
      setDbId(app.id);
      markClean();
      dispatchEditor({ type: "selectNone" });
    } catch (err) {
      toast({ title: t("customApps.loadError"), description: String(err), variant: "destructive" });
    }
  }, [isDirty, questDirty, markClean, reset, setDbId, setDefinition, setQuestGame, t, toast]);

  // --- When the chat creates a quest game, open it here immediately.
  // We do NOT refetch the app: the chat response already delivered the game's
  // contentPack via contextData.questgame → setQuestGame (and it may carry edits
  // the AI made in the SAME turn that the server row doesn't have yet).
  // Refetching would clobber those. We only need to key the assign/delete
  // controls to the new dbId and clear any v1 editor selection.
  useEffect(() => {
    const generated = sharedState.generatedQuestApp as
      | { appId: string }
      | undefined;
    if (!generated?.appId) return;
    setSharedState({ generatedQuestApp: undefined });
    setDbId(generated.appId);
    dispatchEditor({ type: "selectNone" });
  }, [sharedState.generatedQuestApp, setSharedState, setDbId, dispatchEditor]);

  const handleQuestSave = useCallback(async () => {
    if (!questGame || !questDirty) return;
    setSaving(true);
    try {
      const name =
        ((questGame.contentPack as { meta?: { title?: string } } | null)?.meta?.title) ??
        questGame.name;
      const res = await apiRequest("PATCH", `/api/custom-apps/${questGame.appId}`, {
        name,
        type: GOAL_TREE_APP_TYPE,
        definition: {
          engine: "goal-tree",
          engineVersion: 1,
          contentPack: questGame.contentPack,
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          Array.isArray(body?.details) ? body.details.slice(0, 3).join("; ") : body?.error ?? "Save failed",
        );
      }
      const updated = (await res.json()) as CustomApp;
      upsertAppMeta({
        id: updated.id,
        name: updated.name,
        description: updated.description,
        imageUrl: updated.imageUrl,
      });
      markQuestClean();
      toast({ title: t("customApps.saved") });
    } catch (err) {
      toast({ title: t("customApps.saveError"), description: String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [questGame, questDirty, markQuestClean, t, toast, upsertAppMeta]);

  // --- Save (create or update)
  const handleSave = useCallback(async () => {
    if (questGame) {
      await handleQuestSave();
      return;
    }
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
      const body: Record<string, unknown> = {
        name: definition.label,
        description: definition.description,
        type: definition.type,
        definition,
        isGenerated: true,
      };
      if (currentInstitute?.id) body.instituteId = currentInstitute.id;
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
  }, [definition, dbId, markClean, setDbId, t, toast, upsertAppMeta, currentInstitute?.id, questGame, handleQuestSave]);

  const handleDelete = useCallback(async () => {
    if (!dbId) return;
    if (!confirm(t("customApps.confirmDelete"))) return;
    try {
      const res = await apiRequest("DELETE", `/api/custom-apps/${dbId}`);
      if (!res.ok) throw new Error("Delete failed");
      removeAppMeta(dbId);
      reset();
      dispatchEditor({ type: "selectNone" });
      toast({ title: t("customApps.deleted") });
    } catch (err) {
      toast({ title: t("customApps.deleteError"), description: String(err), variant: "destructive" });
    }
  }, [dbId, removeAppMeta, reset, t, toast]);

  const toggleAssignment = useCallback(async () => {
    if (!dbId || !student?.id) return;
    setAssigning(true);
    try {
      if (isAssignedToCurrentStudent) {
        const res = await apiRequest(
          "DELETE",
          `/api/custom-apps/${dbId}/assignments/${student.id}`,
        );
        if (!res.ok) throw new Error("Unassign failed");
        toast({ title: t("customApps.unassigned") });
      } else {
        const res = await apiRequest("POST", `/api/custom-apps/${dbId}/assignments`, {
          studentId: student.id,
        });
        if (!res.ok) throw new Error("Assign failed");
        toast({ title: t("customApps.assigned") });
      }
      await queryClient.invalidateQueries({ queryKey: assignmentsQueryKey });
      await queryClient.invalidateQueries({ queryKey: ["customApps:available", student.id] });
    } catch (err) {
      toast({
        title: t("customApps.assignError"),
        description: String(err),
        variant: "destructive",
      });
    } finally {
      setAssigning(false);
    }
  }, [
    dbId,
    student?.id,
    isAssignedToCurrentStudent,
    queryClient,
    assignmentsQueryKey,
    t,
    toast,
  ]);

  const handleNew = useCallback(() => {
    if ((isDirty || questDirty) && !confirm(t("customApps.discardUnsavedPrompt"))) return;
    reset();
    dispatchEditor({ type: "selectNone" });
  }, [isDirty, questDirty, reset, t]);

  // ---- Derived values for the body
  const selectedClass = useMemo(() => {
    if (!definition || editor.selection.kind !== "class") return null;
    return definition.classes.find((c) => c.id === editor.selection.classId) ?? null;
  }, [definition, editor.selection]);

  const selectedRoom = useMemo(() => {
    if (!definition) return null;
    if (editor.selection.kind === "room") {
      return definition.rooms.find((r) => r.id === editor.selection.roomId) ?? null;
    }
    if (editor.selection.kind === "entity") {
      return definition.rooms.find((r) => r.id === editor.selection.roomId) ?? null;
    }
    return null;
  }, [definition, editor.selection]);

  const selectedEntityIndex = editor.selection.kind === "entity" ? editor.selection.index : null;

  const inPlay = editor.mode === "play" && definition !== null && validation.ok;

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

        {definition && (
          inPlay ? (
            <Button variant="outline" size="sm" onClick={() => dispatchEditor({ type: "exitPlay" })}>
              <Square className="w-4 h-4 mr-1" />
              {t("customApps.stop")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => dispatchEditor({ type: "enterPlay" })}
              disabled={!validation.ok}
              title={validation.ok ? "" : t("customApps.fixErrorsToPlay")}
            >
              <Play className="w-4 h-4 mr-1" />
              {t("customApps.play")}
            </Button>
          )
        )}

        {dbId && (
          <>
            {student?.id ? (
              <Button
                variant={isAssignedToCurrentStudent ? "default" : "outline"}
                size="sm"
                disabled={assigning}
                onClick={toggleAssignment}
                title={
                  isAssignedToCurrentStudent
                    ? t("customApps.unassign")
                    : t("customApps.assign")
                }
              >
                {assigning ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : isAssignedToCurrentStudent ? (
                  <UserCheck className="w-4 h-4 mr-1" />
                ) : (
                  <UserPlus className="w-4 h-4 mr-1" />
                )}
                {isAssignedToCurrentStudent
                  ? t("customApps.assignedToStudent")
                  : t("customApps.assignToStudent")}
              </Button>
            ) : null}
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
      <div className="flex-1 min-h-0 overflow-hidden">
        {questGame ? (
          <GoalTreeGamePreview
            contentPack={questGame.contentPack}
            language={questGame.language}
            isDark={isDark}
          />
        ) : !definition ? (
          <EmptyState isDark={isDark} />
        ) : inPlay ? (
          <div key={editor.playSession} className="h-full overflow-auto">
            <GameRuntime def={definition} onExit={() => dispatchEditor({ type: "exitPlay" })} />
          </div>
        ) : (
          <div className="flex h-full">
            <LeftRail
              definition={definition}
              selection={editor.selection}
              placementClassId={editor.placementClassId}
              dispatch={dispatchEditor}
              isDark={isDark}
            />
            <div className="flex-1 min-w-0 overflow-hidden">
              {selectedClass ? (
                <ObjectEditor
                  cls={selectedClass}
                  definition={definition}
                  onDeleted={() => dispatchEditor({ type: "selectNone" })}
                  onRenamed={(newId) => dispatchEditor({ type: "selectClass", classId: newId })}
                  onClose={() => dispatchEditor({ type: "selectNone" })}
                  isDark={isDark}
                />
              ) : selectedRoom ? (
                <RoomEditor
                  room={selectedRoom}
                  definition={definition}
                  selectedEntityIndex={selectedEntityIndex}
                  placementClassId={editor.placementClassId}
                  stickyPlacement={editor.stickyPlacement}
                  dispatch={dispatchEditor}
                  isDark={isDark}
                />
              ) : (
                <CenterPlaceholder isDark={isDark} />
              )}
            </div>
            <RightRail
              definition={definition}
              selection={editor.selection}
              dispatch={dispatchEditor}
              isDark={isDark}
            />
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

function CenterPlaceholder({ isDark }: { isDark: boolean }) {
  const { t } = useLanguage();
  return (
    <div
      className={cn(
        "h-full flex items-center justify-center text-center p-8",
        isDark ? "text-slate-500" : "text-gray-500",
      )}
    >
      <p className="text-sm max-w-sm">{t("customApps.centerPlaceholder")}</p>
    </div>
  );
}
