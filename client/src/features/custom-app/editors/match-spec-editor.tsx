// src/features/custom-app/editors/match-spec-editor.tsx
//
// Editor for a MatchSpec (used by interaction triggers' `self` and `other`).
// `self` cannot specify position or classId, so those fields are hidden when
// `kind === "self"`.

import type { ClassDef, CounterDef, CounterOp, MatchSpec, RelativePosition } from "@shared/custom-app-types";
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
import { cn } from "@/lib/utils";

const POSITIONS: RelativePosition[] = ["sameCell", "adjacent", "inside", "contains"];
const COUNTER_OPS = ["gt", "lt", "eq", "gte", "lte"] as const;

interface MatchSpecEditorProps {
  kind: "self" | "other";
  value: MatchSpec | undefined;
  onChange: (next: MatchSpec | undefined) => void;
  /** All classes in the def, used for the classId picker (other only). */
  classes: ClassDef[];
  /** Counters from the matched class — for `self` use the class being edited; for `other` use the picked class if any. */
  knownCounters?: CounterDef[];
  isDark: boolean;
}

export function MatchSpecEditor({
  kind,
  value,
  onChange,
  classes,
  knownCounters,
  isDark,
}: MatchSpecEditorProps) {
  const { t } = useLanguage();
  const enabled = value !== undefined;
  const v = value ?? {};

  const patch = (p: Partial<MatchSpec>) => {
    onChange({ ...v, ...p });
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? {} : undefined)}
        />
        <span>{t("customApps.matchSpecEnable")}</span>
      </label>

      {enabled && (
        <div
          className={cn(
            "space-y-2 pl-2 border-l-2",
            isDark ? "border-slate-700" : "border-gray-200",
          )}
        >
          {kind === "other" && (
            <>
              <div className="space-y-0.5">
                <Label className="text-[10px] opacity-70">{t("customApps.position")}</Label>
                <Select
                  value={v.position ?? "_any"}
                  onValueChange={(val) =>
                    patch({ position: val === "_any" ? undefined : (val as RelativePosition) })
                  }
                >
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_any">{t("customApps.matchSpecAny")}</SelectItem>
                    {POSITIONS.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-0.5">
                <Label className="text-[10px] opacity-70">{t("customApps.classId")}</Label>
                <Select
                  value={v.classId ?? "_any"}
                  onValueChange={(val) =>
                    patch({ classId: val === "_any" ? undefined : val })
                  }
                >
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_any">{t("customApps.matchSpecAny")}</SelectItem>
                    {classes.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.label ?? c.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <CsvField
            label={t("customApps.matchStates")}
            value={v.states ?? []}
            onChange={(arr) => patch({ states: arr.length ? arr : undefined })}
          />
          <CsvField
            label={t("customApps.matchTypes")}
            value={v.types ?? []}
            onChange={(arr) => patch({ types: arr.length ? arr : undefined })}
          />
          <CsvField
            label={t("customApps.matchRequiredTypes")}
            value={v.requiredTypes ?? []}
            onChange={(arr) => patch({ requiredTypes: arr.length ? arr : undefined })}
          />
          <CsvField
            label={t("customApps.matchForbiddenTypes")}
            value={v.forbiddenTypes ?? []}
            onChange={(arr) => patch({ forbiddenTypes: arr.length ? arr : undefined })}
          />

          <CounterConditionField
            value={v.counter}
            counters={knownCounters}
            onChange={(c) => patch({ counter: c })}
          />
        </div>
      )}
    </div>
  );
}

function CsvField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-0.5">
      <Label className="text-[10px] opacity-70">{label}</Label>
      <Input
        value={value.join(", ")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          )
        }
        className="h-7 text-xs"
        placeholder="—"
      />
    </div>
  );
}

function CounterConditionField({
  value,
  counters,
  onChange,
}: {
  value: MatchSpec["counter"];
  counters: CounterDef[] | undefined;
  onChange: (next: MatchSpec["counter"]) => void;
}) {
  const { t } = useLanguage();
  const enabled = value !== undefined;
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-[10px] opacity-70 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            onChange(e.target.checked ? { id: counters?.[0]?.id ?? "", op: "gte", value: 0 } : undefined)
          }
        />
        <span>{t("customApps.counterCondition")}</span>
      </label>
      {enabled && value && (
        <div className="grid grid-cols-3 gap-1">
          {counters && counters.length > 0 ? (
            <Select value={value.id} onValueChange={(id) => onChange({ ...value, id })}>
              <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                {counters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.label ?? c.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={value.id}
              onChange={(e) => onChange({ ...value, id: e.target.value })}
              className="h-7 text-xs"
              placeholder={t("customApps.counterId")}
            />
          )}
          <Select
            value={value.op}
            onValueChange={(op) => onChange({ ...value, op: op as CounterOp })}
          >
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COUNTER_OPS.map((op) => (
                <SelectItem key={op} value={op}>{op}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            value={value.value}
            onChange={(e) => onChange({ ...value, value: Number(e.target.value) })}
            className="h-7 text-xs"
          />
        </div>
      )}
    </div>
  );
}

