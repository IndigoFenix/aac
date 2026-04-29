// src/features/custom-app/editors/counters-editor.tsx
//
// Editor for ClassDef.counters — a list of named numeric counters with
// optional clamps. Used in ObjectEditor's class form.

import type { CounterDef } from "@shared/custom-app-types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/contexts/LanguageContext";
import { uniqueId } from "../helpers";
import { ListEditor } from "./list-editor";

interface CountersEditorProps {
  value: CounterDef[] | undefined;
  onChange: (next: CounterDef[] | undefined) => void;
  isDark: boolean;
}

export function CountersEditor({ value, onChange, isDark }: CountersEditorProps) {
  const { t } = useLanguage();
  const items = value ?? [];

  return (
    <ListEditor<CounterDef>
      items={items}
      onChange={(next) => onChange(next.length ? next : undefined)}
      defaultItem={(existing) => ({
        id: uniqueId("counter", existing.map((c) => c.id)),
        initial: 0,
      })}
      addLabel={t("customApps.addCounter")}
      emptyLabel={t("customApps.noCounters")}
      isDark={isDark}
      renderItem={(c, _i, update) => (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-2">
            <SmallField label={t("customApps.id")}>
              <Input
                value={c.id}
                onChange={(e) => update({ id: e.target.value })}
                className="h-7 text-xs"
              />
            </SmallField>
            <SmallField label={t("customApps.label")}>
              <Input
                value={c.label ?? ""}
                onChange={(e) => update({ label: e.target.value || undefined })}
                className="h-7 text-xs"
              />
            </SmallField>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <SmallField label={t("customApps.initial")}>
              <Input
                type="number"
                value={c.initial}
                onChange={(e) => update({ initial: Number(e.target.value) })}
                className="h-7 text-xs"
              />
            </SmallField>
            <SmallField label={t("customApps.min")}>
              <Input
                type="number"
                value={c.min ?? ""}
                onChange={(e) =>
                  update({ min: e.target.value === "" ? undefined : Number(e.target.value) })
                }
                className="h-7 text-xs"
                placeholder="—"
              />
            </SmallField>
            <SmallField label={t("customApps.max")}>
              <Input
                type="number"
                value={c.max ?? ""}
                onChange={(e) =>
                  update({ max: e.target.value === "" ? undefined : Number(e.target.value) })
                }
                className="h-7 text-xs"
                placeholder="—"
              />
            </SmallField>
          </div>
        </div>
      )}
    />
  );
}

function SmallField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <Label className="text-[10px] opacity-70">{label}</Label>
      {children}
    </div>
  );
}
