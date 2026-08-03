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
  isDark?: boolean;
}

export function BoardPackageControl({ boardId, isDark }: BoardPackageControlProps) {
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

  // Whether the board belongs to a student is the SERVER's call — the editor
  // store doesn't carry studentId. So: try the plain add, and if the server
  // says it is student-owned, ask before making a copy. That keeps "share this
  // design" from silently becoming "duplicate this student's board".
  const [copyPromptFor, setCopyPromptFor] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: async (v: { packageId: string; copyStudentBoard?: boolean }) => {
      await apiRequest("POST", `/api/packages/${v.packageId}/boards${q}`, {
        boardId,
        ...(v.copyStudentBoard ? { copyStudentBoard: true } : {}),
      });
      return v;
    },
    onSuccess: () => {
      setCopyPromptFor(null);
      void queryClient.invalidateQueries({ queryKey: membershipKey });
      void queryClient.invalidateQueries({ queryKey: ["packages", instituteId] });
      toast({ title: t("packages.addedToPackage") });
    },
    onError: (err, variables) => {
      const message = String((err as Error)?.message ?? err);
      if (!variables.copyStudentBoard && message.includes("BOARD_BELONGS_TO_STUDENT")) {
        setCopyPromptFor(variables.packageId);
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

      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            data-testid="board-add-to-package"
          >
            <PackageIcon className="w-3 h-3 me-1" />
            {t("packages.addToPackage")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
          <DropdownMenuLabel>{t("packages.addToPackage")}</DropdownMenuLabel>
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
              onSelect={() => addMutation.mutate({ packageId: pkg.id })}
            >
              {pkg.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The board turned out to belong to a student — confirm the copy. */}
      <Dialog open={!!copyPromptFor} onOpenChange={(o) => !o && setCopyPromptFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("packages.copyToPackageTitle")}</DialogTitle>
            <DialogDescription>{t("packages.willBeCopiedHelp")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyPromptFor(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={addMutation.isPending}
              onClick={() =>
                copyPromptFor &&
                addMutation.mutate({ packageId: copyPromptFor, copyStudentBoard: true })
              }
            >
              {addMutation.isPending && <Loader2 className="w-4 h-4 me-1 animate-spin" />}
              {t("packages.copyAndAdd")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
