// src/features/custom-app/editors/states-editor.tsx
//
// Editor for ClassDef.states. Each state has an id and an optional list of
// override-prop pairs. Override values use the same input widget as the
// entity-instance inspector.

import type { OverridableProp, OverridePropSetting, StateDef } from "@shared/custom-app-types";
import { OVERRIDABLE_PROPS } from "@shared/custom-app-validator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { uniqueId } from "../helpers";
import { ListEditor } from "./list-editor";
import { OverrideValueInput } from "./override-value-input";

interface StatesEditorProps {
  value: StateDef[] | undefined;
  onChange: (next: StateDef[] | undefined) => void;
  isDark: boolean;
}

export function StatesEditor({ value, onChange, isDark }: StatesEditorProps) {
  const { t } = useLanguage();
  const items = value ?? [];

  return (
    <ListEditor<StateDef>
      items={items}
      onChange={(next) => onChange(next.length ? next : undefined)}
      defaultItem={(existing) => ({
        id: uniqueId("state", existing.map((s) => s.id)),
      })}
      addLabel={t("customApps.addState")}
      emptyLabel={t("customApps.noStates")}
      isDark={isDark}
      renderItem={(s, _i, update) => (
        <div className="space-y-2">
          <div className="space-y-0.5">
            <Label className="text-[10px] opacity-70">{t("customApps.id")}</Label>
            <Input
              value={s.id}
              onChange={(e) => update({ id: e.target.value })}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] opacity-70">{t("customApps.overrideProps")}</Label>
            <OverridePropsEditor
              value={s.overrideProps}
              onChange={(next) => update({ overrideProps: next })}
              isDark={isDark}
            />
          </div>
        </div>
      )}
    />
  );
}

function OverridePropsEditor({
  value,
  onChange,
  isDark,
}: {
  value: OverridePropSetting[] | undefined;
  onChange: (next: OverridePropSetting[] | undefined) => void;
  isDark: boolean;
}) {
  const { t } = useLanguage();
  const items = value ?? [];
  const usedProps = new Set(items.map((i) => i.prop));

  return (
    <ListEditor<OverridePropSetting>
      items={items}
      onChange={(next) => onChange(next.length ? next : undefined)}
      defaultItem={() => {
        // Pick the first unused prop, or fall back to the first prop.
        const free = OVERRIDABLE_PROPS.find((p) => !usedProps.has(p)) ?? OVERRIDABLE_PROPS[0];
        return { prop: free, value: "" };
      }}
      addLabel={t("customApps.addOverride")}
      emptyLabel={t("customApps.noOverrideProps")}
      isDark={isDark}
      renderItem={(op, _i, update) => (
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={op.prop}
            onValueChange={(v) => update({ prop: v as OverridableProp })}
          >
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {OVERRIDABLE_PROPS.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <OverrideValueInput
            prop={op.prop}
            value={op.value}
            noClear
            onChange={(v) => update({ value: v ?? "" })}
          />
        </div>
      )}
    />
  );
}
