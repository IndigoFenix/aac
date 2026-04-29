// src/features/custom-app/RenameClassDialog.tsx
//
// When the user changes a class id we don't apply the rename silently — we
// surface a modal that explains the choice: cascade rewrites every reference
// (interactions, dropRules, button effects, room placements); skip-cascade
// only renames the class itself, which leaves dangling references and breaks
// behaviors. Cancel reverts the input.

import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import type { GameDefinition } from "@shared/custom-app-types";
import { findClassReferences } from "./helpers";

interface RenameClassDialogProps {
  /** Pass null to keep the dialog closed. */
  pending: { oldId: string; newId: string } | null;
  definition: GameDefinition;
  onChoose: (cascade: boolean) => void;
  onCancel: () => void;
}

export function RenameClassDialog({
  pending,
  definition,
  onChoose,
  onCancel,
}: RenameClassDialogProps) {
  const { t } = useLanguage();

  const refs = useMemo(
    () => (pending ? findClassReferences(definition, pending.oldId) : []),
    [pending, definition],
  );

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("customApps.renameClassTitle")}</DialogTitle>
          <DialogDescription>
            {pending
              ? t("customApps.renameClassDescription", {
                  oldId: pending.oldId,
                  newId: pending.newId,
                })
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm">
          {refs.length === 0 ? (
            <p className="opacity-70">{t("customApps.renameNoRefs")}</p>
          ) : (
            <>
              <p>{t("customApps.renameRefsCount", { n: refs.length })}</p>
              <ul className="text-xs list-disc pl-5 max-h-32 overflow-auto opacity-80">
                {refs.map((r, i) => (
                  <li key={i}>
                    {r.location} — {r.detail}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => onChoose(false)}>
            {t("customApps.renameSkipCascade")}
          </Button>
          <Button onClick={() => onChoose(true)}>
            {t("customApps.renameCascade")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
