// src/features/PackagePanel.tsx
//
// Clinician panel for content packages — reusable bundles of AAC boards owned
// by an institute, attachable to students from their AAC settings.
//
// Two panes: the package list on the left, the selected package's editor on the
// right (details, member boards, and who it is shared with).
//
// Publishing (making a package public) is deliberately NOT here yet — it needs
// the content validator and a human attestation. See aac-packages-plan.md §9.3.

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  Globe,
  Loader2,
  Lock,
  Package as PackageIcon,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import type { Package, PackagePermission } from "@shared/schema";
import type { PackageValidationFinding } from "@shared/package-validation";

interface PackageBoardEntry {
  id: string;
  name: string;
  autoLoad: boolean;
  sortOrder: number;
  automaticSelection: boolean;
  automaticSelectionHint: string | null;
}

interface PackageGrantEntry {
  id: string;
  granteeUserId: string;
  granteeEmail: string | null;
  granteeName: string | null;
  permission: "use" | "edit";
}

interface PackageDetail extends Package {
  permission: PackagePermission;
  frozen: boolean;
  boards: PackageBoardEntry[];
  grants: PackageGrantEntry[];
}

interface BoardCandidate {
  id: string;
  name: string;
  studentId: string | null;
}

export function PackagePanel(_props: { isOpen?: boolean }) {
  const { t } = useLanguage();
  const { currentInstitute } = useInstitute();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addBoardOpen, setAddBoardOpen] = useState(false);
  const [grantEmail, setGrantEmail] = useState("");

  const instituteId = currentInstitute?.id;
  const q = instituteId ? `?instituteId=${instituteId}` : "";

  const listKey = useMemo(() => ["packages", instituteId], [instituteId]);
  const detailKey = useMemo(() => ["package", selectedId, instituteId], [selectedId, instituteId]);

  const { data: list = [], isLoading: listLoading } = useQuery<Package[]>({
    queryKey: listKey,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/packages${q}`);
      return res.json();
    },
    enabled: !!instituteId,
  });

  const { data: detail, isLoading: detailLoading } = useQuery<PackageDetail>({
    queryKey: detailKey,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/packages/${selectedId}${q}`);
      return res.json();
    },
    enabled: !!selectedId && !!instituteId,
  });

  const { data: candidates } = useQuery<{ own: BoardCandidate[]; institute: BoardCandidate[] }>({
    queryKey: ["packageBoardCandidates", instituteId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/packages/board-candidates${q}`);
      return res.json();
    },
    enabled: addBoardOpen && !!instituteId,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: listKey });
    void queryClient.invalidateQueries({ queryKey: detailKey });
  }, [queryClient, listKey, detailKey]);

  /** `student_face_ref` → `findingStudentFaceRef` (the i18n files are flat). */
  const findingKey = (reason: string) =>
    "finding" +
    reason
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");

  /** Surface a server error, translating the structured findings when present. */
  const reportError = useCallback(
    async (err: unknown) => {
      let description = String(err);
      try {
        const body = JSON.parse((err as Error).message.replace(/^\d+:\s*/, ""));
        if (Array.isArray(body.findings)) {
          description = (body.findings as PackageValidationFinding[])
            .map((f) =>
              t(`packages.${findingKey(f.reason)}`, {
                button: f.buttonId ?? "?",
                detail: f.detail,
              }),
            )
            .join("\n");
        } else if (body.error) {
          description = t(`packages.error${String(body.error).replace(/^error:/, "")}`);
        }
      } catch {
        /* leave the raw message */
      }
      toast({ title: t("packages.actionFailed"), description, variant: "destructive" });
    },
    [t, toast],
  );

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/packages${q}`, {
        instituteId,
        name: t("packages.newPackageName"),
      });
      return res.json() as Promise<Package>;
    },
    onSuccess: (pkg) => {
      setSelectedId(pkg.id);
      invalidate();
    },
    onError: reportError,
  });

  const updateMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      await apiRequest("PATCH", `/api/packages/${selectedId}${q}`, patch);
    },
    onSuccess: invalidate,
    onError: reportError,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/packages/${selectedId}${q}`);
      return res.json() as Promise<{ outcome: "deleted" | "orphaned" }>;
    },
    onSuccess: (result) => {
      toast({
        title: t("packages.deleted"),
        description:
          result.outcome === "orphaned" ? t("packages.deletedButStillInUse") : undefined,
      });
      setSelectedId(null);
      invalidate();
    },
    onError: reportError,
  });

  const addBoardMutation = useMutation({
    mutationFn: async (v: { boardId: string; copyStudentBoard?: boolean }) => {
      await apiRequest("POST", `/api/packages/${selectedId}/boards${q}`, v);
    },
    onSuccess: () => {
      setAddBoardOpen(false);
      invalidate();
    },
    onError: reportError,
  });

  const boardMembershipMutation = useMutation({
    mutationFn: async (v: { boardId: string; autoLoad: boolean }) => {
      await apiRequest("PATCH", `/api/packages/${selectedId}/boards/${v.boardId}${q}`, {
        autoLoad: v.autoLoad,
      });
    },
    onSuccess: invalidate,
    onError: reportError,
  });

  const removeBoardMutation = useMutation({
    mutationFn: async (boardId: string) => {
      await apiRequest("DELETE", `/api/packages/${selectedId}/boards/${boardId}${q}`);
    },
    onSuccess: invalidate,
    onError: reportError,
  });

  const removeGrantMutation = useMutation({
    mutationFn: async (grantId: string) => {
      await apiRequest("DELETE", `/api/packages/${selectedId}/grants/${grantId}${q}`);
    },
    onSuccess: invalidate,
    onError: reportError,
  });

  // --- Publishing -------------------------------------------------------
  // Only reachable from here, never from a field write and never from the AI:
  // making a package public changes its legal status, so a NAMED PERSON has to
  // confirm it holds no images of identifiable people.
  const [publishOpen, setPublishOpen] = useState(false);
  const [attested, setAttested] = useState(false);

  const { data: publishCheck, isFetching: checking } = useQuery<{
    ok: boolean;
    findings: Array<PackageValidationFinding & { boardName: string }>;
  }>({
    queryKey: ["package:publish-check", selectedId, instituteId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/packages/${selectedId}/publish-check${q}`);
      return res.json();
    },
    enabled: publishOpen && !!selectedId && !!instituteId,
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/packages/${selectedId}/publish${q}`, {
        attestation: { noPersonImages: true },
      });
    },
    onSuccess: () => {
      setPublishOpen(false);
      setAttested(false);
      toast({ title: t("packages.publishSubmitted"), description: t("packages.awaitingReview") });
      invalidate();
    },
    onError: reportError,
  });

  const unpublishMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/packages/${selectedId}/unpublish${q}`);
    },
    onSuccess: invalidate,
    onError: reportError,
  });

  const canEdit = detail?.permission === "edit" && !detail?.frozen;

  if (!instituteId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">{t("packages.selectInstitute")}</div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ---------------- Package list ---------------- */}
      <div className="w-64 shrink-0 border-e border-border flex flex-col min-h-0">
        <div className="p-3 border-b border-border flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{t("packages.title")}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            aria-label={t("packages.create")}
            data-testid="package-create"
          >
            {createMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {listLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-2">
              <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
            </div>
          )}
          {!listLoading && list.length === 0 && (
            <p className="text-sm text-muted-foreground p-2">{t("packages.empty")}</p>
          )}
          {list.map((pkg) => (
            <button
              key={pkg.id}
              onClick={() => setSelectedId(pkg.id)}
              className={cn(
                "w-full text-start px-3 py-2 rounded-lg text-sm flex items-center gap-2",
                selectedId === pkg.id ? "bg-accent" : "hover:bg-accent/50",
              )}
              data-testid={`package-item-${pkg.id}`}
            >
              <PackageIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
              <span className="truncate flex-1">{pkg.name}</span>
              {pkg.visibility === "public" ? (
                <Globe className="w-3.5 h-3.5 text-muted-foreground" aria-label={t("packages.public")} />
              ) : (
                <Lock className="w-3.5 h-3.5 text-muted-foreground" aria-label={t("packages.instituteOnly")} />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- Editor ---------------- */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4 space-y-4">
        {!selectedId && (
          <p className="text-sm text-muted-foreground">{t("packages.selectPackage")}</p>
        )}
        {selectedId && detailLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
          </div>
        )}

        {detail && (
          <>
            {detail.frozen && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                {t("packages.frozenNotice")}
              </div>
            )}

            {/* Details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("packages.details")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="package-name">{t("packages.name")}</Label>
                  <Input
                    id="package-name"
                    defaultValue={detail.name}
                    disabled={!canEdit}
                    onBlur={(e) => {
                      if (e.target.value && e.target.value !== detail.name) {
                        updateMutation.mutate({ name: e.target.value });
                      }
                    }}
                    data-testid="package-name-input"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="package-description">{t("packages.description")}</Label>
                  <Textarea
                    id="package-description"
                    defaultValue={detail.description ?? ""}
                    disabled={!canEdit}
                    onBlur={(e) => {
                      if (e.target.value !== (detail.description ?? "")) {
                        updateMutation.mutate({ description: e.target.value });
                      }
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="package-default-permission">
                    {t("packages.defaultMemberPermission")}
                  </Label>
                  <Select
                    disabled={!canEdit}
                    defaultValue={detail.defaultMemberPermission}
                    onValueChange={(v) => updateMutation.mutate({ defaultMemberPermission: v })}
                  >
                    <SelectTrigger id="package-default-permission">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("packages.permissionNone")}</SelectItem>
                      <SelectItem value="use">{t("packages.permissionUse")}</SelectItem>
                      <SelectItem value="edit">{t("packages.permissionEdit")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("packages.defaultMemberPermissionHelp")}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Boards */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">{t("packages.boards")}</CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canEdit}
                  onClick={() => setAddBoardOpen(true)}
                  data-testid="package-add-board"
                >
                  <Plus className="w-4 h-4 me-1" /> {t("packages.addBoard")}
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {detail.boards.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t("packages.noBoards")}</p>
                )}
                {detail.boards.map((board) => (
                  <div
                    key={board.id}
                    className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between border-b border-border pb-3 last:border-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{board.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {board.autoLoad && board.automaticSelection
                          ? t("packages.autoLoadOn")
                          : t("packages.autoLoadOff")}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Label
                        htmlFor={`autoload-${board.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        {t("packages.autoLoad")}
                      </Label>
                      <Switch
                        id={`autoload-${board.id}`}
                        checked={board.autoLoad}
                        disabled={!canEdit}
                        onCheckedChange={(v) =>
                          boardMembershipMutation.mutate({ boardId: board.id, autoLoad: v })
                        }
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canEdit}
                        onClick={() => removeBoardMutation.mutate(board.id)}
                        aria-label={t("packages.removeBoard")}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">{t("packages.autoLoadHelp")}</p>
              </CardContent>
            </Card>

            {/* Grants */}
            {detail.permission === "edit" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="w-4 h-4" /> {t("packages.sharedWith")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {detail.grants.length === 0 && (
                    <p className="text-sm text-muted-foreground">{t("packages.noGrants")}</p>
                  )}
                  {detail.grants.map((grant) => (
                    <div key={grant.id} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm truncate">
                          {grant.granteeName || grant.granteeEmail || grant.granteeUserId}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t(grant.permission === "edit" ? "packages.permissionEdit" : "packages.permissionUse")}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canEdit}
                        onClick={() => removeGrantMutation.mutate(grant.id)}
                        aria-label={t("packages.revokeGrant")}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">{t("packages.grantsHelp")}</p>
                </CardContent>
              </Card>
            )}

            {/* Sharing beyond the institute */}
            {canEdit && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Globe className="w-4 h-4" /> {t("packages.visibility")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {detail.visibility === "public"
                      ? t(
                          "packages.publicStatus" +
                            detail.approvalStatus.charAt(0).toUpperCase() +
                            detail.approvalStatus.slice(1),
                        )
                      : t("packages.instituteOnlyDesc")}
                  </p>
                  {detail.visibility === "public" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => unpublishMutation.mutate()}
                      disabled={unpublishMutation.isPending}
                      data-testid="package-unpublish"
                    >
                      {t("packages.unpublish")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPublishOpen(true)}
                      data-testid="package-publish"
                    >
                      <Globe className="w-4 h-4 me-1" /> {t("packages.publish")}
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Danger zone */}
            {canEdit && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                data-testid="package-delete"
              >
                <Trash2 className="w-4 h-4 me-1" /> {t("packages.delete")}
              </Button>
            )}
          </>
        )}
      </div>

      {/* ---------------- Add-board dialog ---------------- */}
      <Dialog open={addBoardOpen} onOpenChange={setAddBoardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("packages.addBoard")}</DialogTitle>
            <DialogDescription>{t("packages.addBoardHelp")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto space-y-1">
            {(candidates?.institute ?? []).map((board) => (
              <button
                key={board.id}
                className="w-full text-start px-3 py-2 rounded-lg text-sm hover:bg-accent/50"
                onClick={() => addBoardMutation.mutate({ boardId: board.id })}
              >
                {board.name}
                <span className="text-xs text-muted-foreground ms-2">
                  {t("packages.alreadyShared")}
                </span>
              </button>
            ))}
            {(candidates?.own ?? []).map((board) => (
              <button
                key={board.id}
                className="w-full text-start px-3 py-2 rounded-lg text-sm hover:bg-accent/50"
                onClick={() =>
                  addBoardMutation.mutate({
                    boardId: board.id,
                    // A board built for a student is copied, never shared in
                    // place — the student keeps their own.
                    copyStudentBoard: !!board.studentId,
                  })
                }
              >
                {board.name}
                {board.studentId && (
                  <span className="text-xs text-muted-foreground ms-2">
                    {t("packages.willBeCopied")}
                  </span>
                )}
              </button>
            ))}
            {!candidates && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground p-2">
                <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddBoardOpen(false)}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Publish dialog ---------------- */}
      <Dialog
        open={publishOpen}
        onOpenChange={(o) => {
          setPublishOpen(o);
          if (!o) setAttested(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("packages.publishTitle")}</DialogTitle>
            <DialogDescription>{t("packages.publishDescription")}</DialogDescription>
          </DialogHeader>

          {checking && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> {t("packages.checkingContent")}
            </div>
          )}

          {publishCheck && !publishCheck.ok && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 space-y-1">
              <p className="text-sm font-medium">{t("packages.publishBlocked")}</p>
              <ul className="text-sm list-disc ps-5 space-y-1">
                {publishCheck.findings.map((f, i) => (
                  <li key={i}>
                    <span className="font-medium">{f.boardName}</span>{" "}
                    {t(`packages.${findingKey(f.reason)}`, {
                      button: f.buttonId ?? "?",
                      detail: f.detail,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {publishCheck?.ok && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-1"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
                data-testid="package-attestation"
              />
              <span>{t("packages.attestation")}</span>
            </label>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!publishCheck?.ok || !attested || publishMutation.isPending}
              onClick={() => publishMutation.mutate()}
              data-testid="package-publish-confirm"
            >
              {publishMutation.isPending && <Loader2 className="w-4 h-4 me-1 animate-spin" />}
              {t("packages.publishConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default PackagePanel;
