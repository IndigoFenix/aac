// Board editor ↔ packages bridge.
//
// Two jobs in one small control:
//   1. Show which packages this board belongs to — and warn that editing it
//      changes it for every student those packages are attached to.
//   2. Offer "add to package" without leaving the board editor.
//
// Renders nothing at all when the user has no packages license, so the board
// editor is unchanged for everyone else.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Loader2, Package as PackageIcon } from "lucide-react";
import type { Package } from "@shared/schema";

interface BoardPackageControlProps {
  /** The saved board's DB id. Null for an unsaved board — the control hides. */
  boardId: string | null | undefined;
  /** The {{student}} this board belongs to, if any. Drives the three-way
   *  resolution dialog: a board that belongs to a child cannot simply join a
   *  package, because the child would lose it or gain a shared copy. */
  boardStudentId?: string | null;
  /** The {{student}} open in the header — the one an "and give it to them"
   *  option would attach the package to. */
  selectedStudentId?: string | null;
  selectedStudentName?: string;
  /** The institute that owns the board. A package may only hold content of its
   *  own institute, so a board from someone else's institute (a public package
   *  you can use) cannot be added to yours at all. */
  boardInstituteId?: string | null;
  isDark?: boolean;
}

export function BoardPackageControl({
  boardId,
  boardStudentId,
  selectedStudentId,
  selectedStudentName,
  boardInstituteId,
  isDark,
}: BoardPackageControlProps) {
  const { t } = useLanguage();
  const { currentInstitute, currentPermissions } = useInstitute();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const instituteId = currentInstitute?.id;
  const q = instituteId ? `?instituteId=${instituteId}` : "";
  const enabled = !!currentPermissions?.packagesEnabled && !!boardId && !!instituteId;

  const membershipKey = useMemo(() => ["boardPackages", boardId], [boardId]);

  const { data: memberOf = [] } = useQuery<Package[]>({
    queryKey: membershipKey,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/boards/${boardId}/packages${q}`);
      return res.json();
    },
    enabled,
  });

  const { data: allPackages = [], isLoading: packagesLoading } = useQuery<Package[]>({
    queryKey: ["packages", instituteId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/packages${q}`);
      return res.json();
    },
    enabled: enabled && open,
  });

  // A board that belongs to a {{student}} cannot simply join a package: a
  // package board is institute content and has no student, so something has to
  // give. The three ways out differ in what the CHILD ends up with, so the
  // choice is theirs to make explicitly, never ours to assume.
  const [pendingPackage, setPendingPackage] = useState<{ id: string; name: string } | null>(null);

  // Which packages the board's {{student}} already has — decides whether
  // "move it" costs them the board or not. Only fetched while the dialog that
  // needs the answer is open.
  const { data: studentPackages } = useQuery<{ assignedIds: string[] }>({
    queryKey: ["packages:available", boardStudentId, instituteId],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/packages/student/${boardStudentId}/available${q}`,
      );
      return res.json();
    },
    enabled: enabled && !!boardStudentId && !!pendingPackage,
  });

  const addMutation = useMutation({
    mutationFn: async (v: {
      packageId: string;
      copyStudentBoard?: boolean;
      detachFromStudent?: boolean;
      assignPackageToStudent?: boolean;
    }) => {
      await apiRequest("POST", `/api/packages/${v.packageId}/boards${q}`, {
        boardId,
        ...(v.copyStudentBoard ? { copyStudentBoard: true } : {}),
        ...(v.detachFromStudent ? { detachFromStudent: true } : {}),
        ...(v.assignPackageToStudent ? { assignPackageToStudent: true } : {}),
      });
      return v;
    },
    onSuccess: () => {
      setPendingPackage(null);
      void queryClient.invalidateQueries({ queryKey: membershipKey });
      void queryClient.invalidateQueries({ queryKey: ["packages", instituteId] });
      // Moving a board out of a {{student}} (or attaching the package to them)
      // changes what the picker should list, and for whom.
      void queryClient.invalidateQueries({ queryKey: ["/api/boards/library"] });
      void queryClient.invalidateQueries({ queryKey: ["packages:available"] });
      toast({ title: t("packages.addedToPackage") });
    },
    onError: (err, variables) => {
      const message = String((err as Error)?.message ?? err);
      // Belt and braces: the editor may hold a stale studentId (a colleague
      // attached the board since it was listed), so honour the server's word.
      if (
        !variables.copyStudentBoard &&
        !variables.detachFromStudent &&
        message.includes("BOARD_BELONGS_TO_STUDENT")
      ) {
        const pkg = allPackages.find((p) => p.id === variables.packageId);
        setPendingPackage({ id: variables.packageId, name: pkg?.name ?? "" });
        return;
      }
      toast({
        title: t("packages.actionFailed"),
        description: message,
        variant: "destructive",
      });
    },
  });

  if (!enabled) return null;

  const memberIds = new Set(memberOf.map((p) => p.id));
  const addable = allPackages.filter((p) => !memberIds.has(p.id));

  /** Does the board's {{student}} already have the package we are adding to?
   *  If so, moving the board there does not take it away from them. */
  const packageAlreadyWithStudent =
    !!pendingPackage && (studentPackages?.assignedIds ?? []).includes(pendingPackage.id);

  // Only name the child when the board's {{student}} IS the one in the header —
  // otherwise the header name would be a confident lie about whose board this is.
  const studentLabel =
    (boardStudentId && boardStudentId === selectedStudentId && selectedStudentName) ||
    t("packages.thisStudent");

  /**
   * A package holds its own institute's content only, so a board owned by
   * another institute — the public-package case — can never be added here. The
   * membership badge still shows; only the action is pointless.
   */
  const canOfferPackages = !boardInstituteId || boardInstituteId === instituteId;

  /** Picking a package: ask first when the board belongs to a {{student}}. */
  const choosePackage = (pkg: { id: string; name: string }) => {
    if (boardStudentId) {
      setPendingPackage(pkg);
      return;
    }
    addMutation.mutate({ packageId: pkg.id });
  };

  return (
    <div className="flex items-center gap-1">
      {memberOf.length > 0 && (
        <span
          className={cn(
            "text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1 max-w-[200px]",
            isDark ? "bg-purple-500/20 text-purple-300" : "bg-purple-100 text-purple-700",
          )}
          // The warning that matters: this board is not yours alone any more.
          title={`${memberOf.map((p) => p.name).join(", ")} — ${t("packages.sharedBoardWarning")}`}
          data-testid="board-package-badge"
        >
          <PackageIcon className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">
            {memberOf.length === 1
              ? memberOf[0].name
              : t("packages.inNPackages", { count: memberOf.length })}
          </span>
        </span>
      )}

      <DropdownMenu open={open && canOfferPackages} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className={cn("h-6 px-2 text-[10px]", !canOfferPackages && "hidden")}
            data-testid="board-add-to-package"
          >
            <PackageIcon className="w-3 h-3 me-1" />
            {/* The badge beside this button already names the package (or
                counts them), so once the board is in one the action is
                "another" — otherwise it reads as if nothing happened. */}
            {memberOf.length > 0
              ? t("packages.addToAnotherPackage")
              : t("packages.addToPackage")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
          <DropdownMenuLabel>
            {memberOf.length > 0
              ? t("packages.addToAnotherPackage")
              : t("packages.addToPackage")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {packagesLoading && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> {t("common.loading")}
            </div>
          )}
          {!packagesLoading && addable.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("packages.noPackagesToAdd")}
            </div>
          )}
          {addable.map((pkg) => (
            <DropdownMenuItem
              key={pkg.id}
              disabled={addMutation.isPending}
              onSelect={() => choosePackage(pkg)}
            >
              {pkg.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The board belongs to a {{student}}. Three ways to resolve that, laid
          out by what the CHILD ends up with — never decided for them. */}
      <Dialog open={!!pendingPackage} onOpenChange={(o) => !o && setPendingPackage(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("packages.studentBoardTitle")}</DialogTitle>
            <DialogDescription>
              {t("packages.studentBoardHelp", {
                name: studentLabel,
                package: pendingPackage?.name ?? "",
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            {/* 1. Copy — the child keeps their board untouched. */}
            <Button
              variant="outline"
              className="h-auto py-2 flex flex-col items-start gap-0.5 text-start"
              disabled={addMutation.isPending}
              onClick={() =>
                pendingPackage &&
                addMutation.mutate({ packageId: pendingPackage.id, copyStudentBoard: true })
              }
              data-testid="board-package-copy"
            >
              <span className="font-medium">{t("packages.copyAndAdd")}</span>
              <span className="text-[11px] font-normal text-muted-foreground whitespace-normal">
                {t("packages.copyAndAddHelp", { name: studentLabel })}
              </span>
            </Button>

            {/* 2. Move and keep the child's access by attaching the package.
                   Pointless when they already have that package. */}
            {!packageAlreadyWithStudent && (
              <Button
                variant="outline"
                className="h-auto py-2 flex flex-col items-start gap-0.5 text-start"
                disabled={addMutation.isPending}
                onClick={() =>
                  pendingPackage &&
                  addMutation.mutate({
                    packageId: pendingPackage.id,
                    detachFromStudent: true,
                    assignPackageToStudent: true,
                  })
                }
                data-testid="board-package-move-and-assign"
              >
                <span className="font-medium">{t("packages.moveAndAssign")}</span>
                <span className="text-[11px] font-normal text-muted-foreground whitespace-normal">
                  {t("packages.moveAndAssignHelp", {
                    name: studentLabel,
                    package: pendingPackage?.name ?? "",
                  })}
                </span>
              </Button>
            )}

            {/* 3. Move outright — the child loses the board unless the package
                   is already theirs, which is why the help text differs. */}
            <Button
              variant="outline"
              className="h-auto py-2 flex flex-col items-start gap-0.5 text-start"
              disabled={addMutation.isPending}
              onClick={() =>
                pendingPackage &&
                addMutation.mutate({ packageId: pendingPackage.id, detachFromStudent: true })
              }
              data-testid="board-package-detach"
            >
              <span className="font-medium">{t("packages.removeFromStudent")}</span>
              <span className="text-[11px] font-normal text-muted-foreground whitespace-normal">
                {packageAlreadyWithStudent
                  ? t("packages.removeFromStudentKeptHelp", {
                      name: studentLabel,
                      package: pendingPackage?.name ?? "",
                    })
                  : t("packages.removeFromStudentHelp", { name: studentLabel })}
              </span>
            </Button>
          </div>

          <DialogFooter>
            {addMutation.isPending && <Loader2 className="w-4 h-4 me-1 animate-spin" />}
            <Button variant="outline" onClick={() => setPendingPackage(null)}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
