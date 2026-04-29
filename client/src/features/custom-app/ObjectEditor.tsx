// src/features/custom-app/ObjectEditor.tsx
//
// Form for editing a single ClassDef. Identity / Visual / Behavior / AI fields
// are first-class; complex sub-collections (states, counters, dropRules,
// interactions) are JSON-edited fallbacks for v1.
//
// Renaming the class id triggers RenameClassDialog so the user can choose
// whether to cascade the change across references.

import { useEffect, useState } from "react";
import type { ClassDef, GameDefinition, Layer } from "@shared/custom-app-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCustomAppStore } from "@/store/custom-app-store";
import { findClassReferences, uniqueId } from "./helpers";
import { RenameClassDialog } from "./RenameClassDialog";
import { CountersEditor } from "./editors/counters-editor";
import { StatesEditor } from "./editors/states-editor";
import { DropRulesEditor } from "./editors/drop-rules-editor";
import { InteractionsEditor } from "./editors/interactions-editor";

interface ObjectEditorProps {
  cls: ClassDef;
  definition: GameDefinition;
  onDeleted: () => void;
  onRenamed: (newId: string) => void;
  onClose: () => void;
  isDark: boolean;
}

export function ObjectEditor({
  cls,
  definition,
  onDeleted,
  onRenamed,
  onClose,
  isDark,
}: ObjectEditorProps) {
  const { t } = useLanguage();
  const { upsertClass, deleteClass, renameClass } = useCustomAppStore();
  const [pendingRename, setPendingRename] = useState<{ oldId: string; newId: string } | null>(null);
  const [idDraft, setIdDraft] = useState(cls.id);

  // Keep the local id draft in sync when the user switches selection.
  useEffect(() => {
    setIdDraft(cls.id);
  }, [cls.id]);

  const patch = (p: Partial<ClassDef>) => upsertClass({ ...cls, ...p });

  const commitIdEdit = () => {
    const trimmed = idDraft.trim();
    if (trimmed === cls.id || trimmed === "") {
      setIdDraft(cls.id);
      return;
    }
    const otherIds = definition.classes.filter((c) => c.id !== cls.id).map((c) => c.id);
    const finalId = uniqueId(trimmed, otherIds);
    setPendingRename({ oldId: cls.id, newId: finalId });
  };

  const handleRenameChoice = (cascade: boolean) => {
    if (!pendingRename) return;
    renameClass(pendingRename.oldId, pendingRename.newId, cascade);
    onRenamed(pendingRename.newId);
    setIdDraft(pendingRename.newId);
    setPendingRename(null);
  };

  const handleDelete = () => {
    const refs = findClassReferences(definition, cls.id);
    const msg = refs.length > 0
      ? t("customApps.deleteClassRefsConfirm", { id: cls.id, n: refs.length })
      : t("customApps.deleteClassConfirm", { id: cls.id });
    if (!confirm(msg)) return;
    deleteClass(cls.id);
    onDeleted();
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <Header isDark={isDark}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase opacity-60">
              {t("customApps.objectClass")}
            </div>
            <div className="text-base font-medium truncate">
              {cls.label ?? cls.id}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 mr-1" />
            {t("common.delete")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} title={t("common.close")}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </Header>

      <div className="p-4 space-y-6">
        <Group title={t("customApps.identity")}>
          <Field label={t("customApps.id")}>
            <Input
              value={idDraft}
              onChange={(e) => setIdDraft(e.target.value)}
              onBlur={commitIdEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setIdDraft(cls.id);
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </Field>
          <Field label={t("customApps.label")}>
            <Input
              value={cls.label ?? ""}
              onChange={(e) => patch({ label: e.target.value || undefined })}
            />
          </Field>
          <Field label={t("customApps.types")}>
            <TagInput
              value={cls.types ?? []}
              onChange={(types) => patch({ types: types.length ? types : undefined })}
              placeholder={t("customApps.typesPlaceholder")}
            />
          </Field>
        </Group>

        <Group title={t("customApps.visual")}>
          <Field label={t("customApps.iconRef")}>
            <Input
              value={cls.iconRef ?? ""}
              onChange={(e) => patch({ iconRef: e.target.value || undefined })}
              placeholder="🐱"
              maxLength={4}
            />
          </Field>
          <Field label={t("customApps.imageKey")}>
            <Input
              value={cls.imageKey ?? ""}
              onChange={(e) => patch({ imageKey: e.target.value || undefined })}
              placeholder="drinking_water"
            />
          </Field>
          <Field label={t("customApps.symbolPath")}>
            <Input
              value={cls.symbolPath ?? ""}
              onChange={(e) => patch({ symbolPath: e.target.value || undefined })}
              placeholder="/api/custom-symbols/.../image"
            />
          </Field>
          <Field label={t("customApps.char")}>
            <Input
              value={cls.char ?? ""}
              onChange={(e) => patch({ char: e.target.value.slice(0, 1) || undefined })}
              maxLength={1}
              className="w-16"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("customApps.imageColor")}>
              <Input
                type="text"
                value={cls.imageColor ?? ""}
                onChange={(e) => patch({ imageColor: e.target.value || undefined })}
                placeholder="#ffffff"
              />
            </Field>
            <Field label={t("customApps.tileColor")}>
              <Input
                type="text"
                value={cls.tileColor ?? ""}
                onChange={(e) => patch({ tileColor: e.target.value || undefined })}
                placeholder="#1e293b"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("customApps.layer")}>
              <Select
                value={cls.layer ?? "entity"}
                onValueChange={(v) => patch({ layer: v as Layer })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="background">{t("customApps.layerBackground")}</SelectItem>
                  <SelectItem value="entity">{t("customApps.layerEntity")}</SelectItem>
                  <SelectItem value="overlay">{t("customApps.layerOverlay")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("customApps.size")}>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={1}
                  className="w-16"
                  value={cls.size?.[0] ?? 1}
                  onChange={(e) => {
                    const w = Math.max(1, Number(e.target.value));
                    const h = cls.size?.[1] ?? 1;
                    patch({ size: w === 1 && h === 1 ? undefined : [w, h] });
                  }}
                />
                <span>×</span>
                <Input
                  type="number"
                  min={1}
                  className="w-16"
                  value={cls.size?.[1] ?? 1}
                  onChange={(e) => {
                    const h = Math.max(1, Number(e.target.value));
                    const w = cls.size?.[0] ?? 1;
                    patch({ size: w === 1 && h === 1 ? undefined : [w, h] });
                  }}
                />
              </div>
            </Field>
          </div>
        </Group>

        <Group title={t("customApps.behavior")}>
          <Toggle label={t("customApps.isSolid")} checked={!!cls.isSolid} onChange={(v) => patch({ isSolid: v || undefined })} />
          <Toggle label={t("customApps.movable")} checked={!!cls.movable} onChange={(v) => patch({ movable: v || undefined })} />
          <Toggle label={t("customApps.hidden")} checked={!!cls.hidden} onChange={(v) => patch({ hidden: v || undefined })} />
          <Toggle label={t("customApps.isTile")} checked={!!cls.isTile} onChange={(v) => patch({ isTile: v || undefined })} />
          <Toggle label={t("customApps.canBeContained")} checked={!!cls.canBeContained} onChange={(v) => patch({ canBeContained: v || undefined })} />
          <Field label={t("customApps.containSize")}>
            <Input
              type="number"
              min={1}
              value={cls.containSize ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                patch({ containSize: e.target.value === "" || n < 1 ? undefined : n });
              }}
              placeholder="1"
              className="w-24"
            />
          </Field>
          <Field label={t("customApps.maxCapacity")}>
            <Input
              type="number"
              min={1}
              value={cls.maxCapacity ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                patch({ maxCapacity: e.target.value === "" || n < 1 ? undefined : n });
              }}
              placeholder="—"
              className="w-24"
            />
          </Field>
        </Group>

        <Group title={t("customApps.aiSection")}>
          <Field label={t("customApps.aiInstructions")}>
            <Textarea
              value={cls.aiInstructions ?? ""}
              onChange={(e) => patch({ aiInstructions: e.target.value || undefined })}
              rows={3}
            />
          </Field>
          <Toggle label={t("customApps.aiHidden")} checked={!!cls.aiHidden} onChange={(v) => patch({ aiHidden: v || undefined })} />
          <Toggle label={t("customApps.aiMovable")} checked={!!cls.aiMovable} onChange={(v) => patch({ aiMovable: v || undefined })} />
          <Toggle label={t("customApps.aiCreatable")} checked={!!cls.aiCreatable} onChange={(v) => patch({ aiCreatable: v || undefined })} />
        </Group>

        <Group title={t("customApps.counters")}>
          <CountersEditor
            value={cls.counters}
            onChange={(v) => patch({ counters: v })}
            isDark={isDark}
          />
        </Group>

        <Group title={t("customApps.states")}>
          <StatesEditor
            value={cls.states}
            onChange={(v) => patch({ states: v })}
            isDark={isDark}
          />
        </Group>

        <Group title={t("customApps.dropRules")}>
          <DropRulesEditor
            value={cls.dropRules}
            onChange={(v) => patch({ dropRules: v })}
            classes={definition.classes}
            isDark={isDark}
          />
        </Group>

        <Group title={t("customApps.interactions")}>
          <InteractionsEditor
            value={cls.interactions}
            onChange={(v) => patch({ interactions: v })}
            selfClass={cls}
            definition={definition}
            isDark={isDark}
          />
        </Group>
      </div>

      <RenameClassDialog
        pending={pendingRename}
        definition={definition}
        onChoose={handleRenameChoice}
        onCancel={() => {
          setIdDraft(cls.id);
          setPendingRename(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form primitives
// ---------------------------------------------------------------------------

function Header({ children, isDark }: { children: React.ReactNode; isDark: boolean }) {
  return (
    <div
      className={cn(
        "px-4 py-3 border-b shrink-0",
        isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
      )}
    >
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide opacity-70">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <Label className="text-sm cursor-pointer" onClick={() => onChange(!checked)}>{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap gap-1 items-center">
      {value.map((tag, i) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 bg-secondary rounded-full"
        >
          {tag}
          <button
            type="button"
            className="opacity-60 hover:opacity-100"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </span>
      ))}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        placeholder={placeholder}
        className="flex-1 min-w-[100px] h-7 text-xs"
      />
    </div>
  );
}

