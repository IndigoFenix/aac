// src/features/custom-app/editors/drop-rules-editor.tsx
//
// Editor for ClassDef.dropRules: a list of {type, classIds[]} rules. Each row
// has a type dropdown (adjacentTo / sameCell / inside) plus a class-ids
// multi-select picked from the current GameDefinition's classes.

import type { ClassDef, DropRule } from "@shared/custom-app-types";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListEditor } from "./list-editor";

interface DropRulesEditorProps {
  value: DropRule[] | undefined;
  onChange: (next: DropRule[] | undefined) => void;
  /** Other classes in the def — used for the class-ids picker. Excludes the class being edited. */
  classes: ClassDef[];
  isDark: boolean;
}

export function DropRulesEditor({ value, onChange, classes, isDark }: DropRulesEditorProps) {
  const { t } = useLanguage();
  const items = value ?? [];

  return (
    <ListEditor<DropRule>
      items={items}
      onChange={(next) => onChange(next.length ? next : undefined)}
      replaceOnUpdate
      defaultItem={() => ({ type: "adjacentTo", classIds: [] })}
      addLabel={t("customApps.addDropRule")}
      emptyLabel={t("customApps.noDropRules")}
      isDark={isDark}
      renderItem={(rule, _i, update) => (
        <div className="space-y-2">
          <div className="space-y-0.5">
            <Label className="text-[10px] opacity-70">{t("customApps.dropRuleType")}</Label>
            <Select
              value={rule.type}
              onValueChange={(v) => update({ ...rule, type: v as DropRule["type"] })}
            >
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="adjacentTo">{t("customApps.dropRuleAdjacentTo")}</SelectItem>
                <SelectItem value="sameCell">{t("customApps.dropRuleSameCell")}</SelectItem>
                <SelectItem value="inside">{t("customApps.dropRuleInside")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] opacity-70">{t("customApps.dropRuleClassIds")}</Label>
            <ClassMultiSelect
              classes={classes}
              selected={rule.classIds}
              onChange={(ids) => update({ ...rule, classIds: ids })}
              emptyLabel={t("customApps.noClasses")}
            />
          </div>
        </div>
      )}
    />
  );
}

function ClassMultiSelect({
  classes,
  selected,
  onChange,
  emptyLabel,
}: {
  classes: ClassDef[];
  selected: string[];
  onChange: (ids: string[]) => void;
  emptyLabel: string;
}) {
  if (classes.length === 0) {
    return <div className="text-xs italic opacity-60">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-0.5 max-h-32 overflow-y-auto">
      {classes.map((c) => {
        const checked = selected.includes(c.id);
        return (
          <label key={c.id} className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox
              checked={checked}
              onCheckedChange={(v) => {
                if (v) onChange([...selected, c.id]);
                else onChange(selected.filter((id) => id !== c.id));
              }}
            />
            <span>{c.label ?? c.id}</span>
            {c.label && c.label !== c.id && (
              <span className="opacity-50">({c.id})</span>
            )}
          </label>
        );
      })}
    </div>
  );
}
