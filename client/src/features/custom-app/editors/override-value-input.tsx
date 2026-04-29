// src/features/custom-app/editors/override-value-input.tsx
//
// Single source of truth for editing the value of an OverridableProp.
// Bool props (hidden/isSolid/movable) get a Switch; everything else is text.
// Used by the entity-instance inspector AND the states sub-editor.

import type { OverridableProp } from "@shared/custom-app-types";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const BOOL_PROPS = new Set<OverridableProp>(["hidden", "isSolid", "movable"]);

export interface OverrideValueInputProps {
  prop: OverridableProp;
  value: unknown;
  /** Pass undefined to clear / "use default". */
  onChange: (v: unknown) => void;
  /** Optional placeholder shown when value is undefined (e.g. the class default). */
  placeholder?: unknown;
  /** When true, never show the "use default" hint — use for state.overrideProps where the value is always explicit. */
  noClear?: boolean;
}

export function OverrideValueInput({
  prop,
  value,
  onChange,
  placeholder,
  noClear,
}: OverrideValueInputProps) {
  const isBool = BOOL_PROPS.has(prop);

  if (isBool) {
    const current = typeof value === "boolean" ? value : !!placeholder;
    return (
      <div className="flex items-center gap-2">
        <Switch checked={current} onCheckedChange={(v) => onChange(v)} />
        {!noClear && value !== undefined && (
          <button
            type="button"
            className="text-[10px] underline opacity-60"
            onClick={() => onChange(undefined)}
          >
            reset
          </button>
        )}
      </div>
    );
  }

  return (
    <Input
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={placeholder !== undefined ? String(placeholder) : "—"}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      className="h-7 text-xs"
    />
  );
}
