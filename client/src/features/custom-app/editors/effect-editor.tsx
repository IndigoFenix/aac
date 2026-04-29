// src/features/custom-app/editors/effect-editor.tsx
//
// Editor for a single Effect (or ButtonEffect, which adds `createEntity`).
// The type dropdown selects the variant; only the relevant fields render.
// Used in lists by both the interactions editor and the button editor.

import type {
  ButtonEffect,
  ClassDef,
  CounterDef,
  Effect,
  GameDefinition,
  RoomDef,
  StateDef,
} from "@shared/custom-app-types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListEditor } from "./list-editor";

// All effect type tags, including the button-only `createEntity`.
const EFFECT_TYPES = [
  "changeState",
  "changeStateOther",
  "emitSignal",
  "incrementCounterSelf",
  "incrementCounterOther",
  "destroySelf",
  "destroyOther",
  "transformSelf",
  "transformOther",
  "setRoom",
  "endTurn",
  "endPlayerTurn",
  "endAiTurn",
  "sendAiInstruction",
  "createEntity",
] as const;
type EffectType = (typeof EFFECT_TYPES)[number];

const BASIC_TYPES: ReadonlySet<EffectType> = new Set([
  "changeState",
  "changeStateOther",
  "emitSignal",
  "incrementCounterSelf",
  "incrementCounterOther",
  "destroySelf",
  "destroyOther",
  "transformSelf",
  "transformOther",
  "setRoom",
  "endTurn",
  "endPlayerTurn",
  "endAiTurn",
  "sendAiInstruction",
]);

// ---------------------------------------------------------------------------
// Public list wrapper used by both the interactions editor and button editor.
// ---------------------------------------------------------------------------

interface EffectsListEditorProps<T extends Effect | ButtonEffect> {
  value: T[] | undefined;
  onChange: (next: T[]) => void;
  definition: GameDefinition;
  /** Counters/states known to the current class — used for self-targeted effect pickers. */
  selfClass?: ClassDef;
  /** When true, the createEntity variant is selectable (button effects). */
  allowCreateEntity?: boolean;
  isDark: boolean;
}

export function EffectsListEditor<T extends Effect | ButtonEffect>({
  value,
  onChange,
  definition,
  selfClass,
  allowCreateEntity,
  isDark,
}: EffectsListEditorProps<T>) {
  const { t } = useLanguage();

  return (
    <ListEditor<T>
      items={value ?? []}
      onChange={onChange}
      replaceOnUpdate
      defaultItem={() => ({ type: "endTurn" } as unknown as T)}
      addLabel={t("customApps.addEffect")}
      emptyLabel={t("customApps.noEffects")}
      isDark={isDark}
      renderItem={(eff, _i, update) => (
        <EffectEditor
          effect={eff}
          onChange={(next) => update(next as unknown as T)}
          definition={definition}
          selfClass={selfClass}
          allowCreateEntity={allowCreateEntity}
        />
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Single-effect editor.
// ---------------------------------------------------------------------------

interface EffectEditorProps {
  effect: Effect | ButtonEffect;
  onChange: (next: Effect | ButtonEffect) => void;
  definition: GameDefinition;
  selfClass?: ClassDef;
  allowCreateEntity?: boolean;
}

function EffectEditor({
  effect,
  onChange,
  definition,
  selfClass,
  allowCreateEntity,
}: EffectEditorProps) {
  const { t } = useLanguage();
  const types = EFFECT_TYPES.filter((tt) => allowCreateEntity || tt !== "createEntity");

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label className="text-[10px] opacity-70">{t("customApps.effectType")}</Label>
        <Select
          value={effect.type}
          onValueChange={(v) => onChange(defaultForEffectType(v as EffectType))}
        >
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {types.map((tt) => (
              <SelectItem key={tt} value={tt}>{labelForType(tt, t)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <EffectFields
        effect={effect}
        onChange={onChange}
        definition={definition}
        selfClass={selfClass}
      />
    </div>
  );
}

function EffectFields({
  effect,
  onChange,
  definition,
  selfClass,
}: {
  effect: Effect | ButtonEffect;
  onChange: (next: Effect | ButtonEffect) => void;
  definition: GameDefinition;
  selfClass?: ClassDef;
}) {
  const { t } = useLanguage();

  switch (effect.type) {
    case "changeState":
      return (
        <StateIdField
          value={effect.id}
          states={selfClass?.states}
          onChange={(id) => onChange({ ...effect, id })}
          label={t("customApps.targetState")}
        />
      );
    case "changeStateOther":
      // We don't know `other`'s class at edit time — accept free text.
      return (
        <TextField
          label={t("customApps.targetState")}
          value={effect.id}
          onChange={(id) => onChange({ ...effect, id })}
        />
      );
    case "emitSignal":
      return (
        <TextField
          label={t("customApps.signalId")}
          value={effect.id}
          onChange={(id) => onChange({ ...effect, id })}
        />
      );
    case "incrementCounterSelf":
      return (
        <CounterField
          counters={selfClass?.counters}
          counterId={effect.id}
          amount={effect.amount}
          onChange={(id, amount) => onChange({ ...effect, id, amount })}
        />
      );
    case "incrementCounterOther":
      // Other's counters unknown — free text + amount.
      return (
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label={t("customApps.counterId")}
            value={effect.id}
            onChange={(id) => onChange({ ...effect, id })}
          />
          <NumberField
            label={t("customApps.amount")}
            value={effect.amount}
            onChange={(amount) => onChange({ ...effect, amount })}
          />
        </div>
      );
    case "transformSelf":
    case "transformOther":
      return (
        <ClassIdField
          label={t("customApps.targetClass")}
          classes={definition.classes}
          value={effect.id}
          onChange={(id) => onChange({ ...effect, id })}
        />
      );
    case "setRoom":
      return (
        <RoomIdField
          rooms={definition.rooms}
          value={effect.id}
          onChange={(id) => onChange({ ...effect, id })}
        />
      );
    case "sendAiInstruction":
      return (
        <div className="space-y-0.5">
          <Label className="text-[10px] opacity-70">{t("customApps.aiMessage")}</Label>
          <Textarea
            value={effect.message}
            onChange={(e) => onChange({ ...effect, message: e.target.value })}
            rows={2}
            className="text-xs"
          />
        </div>
      );
    case "createEntity":
      return (
        <CreateEntityFields
          effect={effect}
          definition={definition}
          onChange={onChange}
        />
      );
    case "destroySelf":
    case "destroyOther":
    case "endTurn":
    case "endPlayerTurn":
    case "endAiTurn":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-0.5">
      <Label className="text-[10px] opacity-70">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-7 text-xs" />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-0.5">
      <Label className="text-[10px] opacity-70">{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 text-xs"
      />
    </div>
  );
}

function StateIdField({
  value,
  states,
  onChange,
  label,
}: {
  value: string;
  states: StateDef[] | undefined;
  onChange: (id: string) => void;
  label: string;
}) {
  // If we have a known list, offer a dropdown; otherwise fall back to text.
  if (!states || states.length === 0) {
    return <TextField label={label} value={value} onChange={onChange} />;
  }
  return (
    <div className="space-y-0.5">
      <Label className="text-[10px] opacity-70">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="_default">_default</SelectItem>
          {states.map((s) => (
            <SelectItem key={s.id} value={s.id}>{s.id}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CounterField({
  counters,
  counterId,
  amount,
  onChange,
}: {
  counters: CounterDef[] | undefined;
  counterId: string;
  amount: number;
  onChange: (id: string, amount: number) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-0.5">
        <Label className="text-[10px] opacity-70">{t("customApps.counterId")}</Label>
        {counters && counters.length > 0 ? (
          <Select value={counterId} onValueChange={(v) => onChange(v, amount)}>
            <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              {counters.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.label ?? c.id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={counterId}
            onChange={(e) => onChange(e.target.value, amount)}
            className="h-7 text-xs"
          />
        )}
      </div>
      <NumberField label={t("customApps.amount")} value={amount} onChange={(v) => onChange(counterId, v)} />
    </div>
  );
}

function ClassIdField({
  label,
  classes,
  value,
  onChange,
}: {
  label: string;
  classes: ClassDef[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="space-y-0.5">
      <Label className="text-[10px] opacity-70">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
        <SelectContent>
          {classes.map((c) => (
            <SelectItem key={c.id} value={c.id}>{c.label ?? c.id}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function RoomIdField({
  rooms,
  value,
  onChange,
}: {
  rooms: RoomDef[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="space-y-0.5">
      <Label className="text-[10px] opacity-70">{t("customApps.targetRoom")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="_next">{t("customApps.roomNext")}</SelectItem>
          {rooms.map((r) => (
            <SelectItem key={r.id} value={r.id}>{r.label ?? r.id}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CreateEntityFields({
  effect,
  definition,
  onChange,
}: {
  effect: Extract<ButtonEffect, { type: "createEntity" }>;
  definition: GameDefinition;
  onChange: (next: Effect | ButtonEffect) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="space-y-2">
      <ClassIdField
        label={t("customApps.targetClass")}
        classes={definition.classes}
        value={effect.classId}
        onChange={(classId) => onChange({ ...effect, classId })}
      />
      <div className="space-y-0.5">
        <Label className="text-[10px] opacity-70">{t("customApps.position")}</Label>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={0}
            value={effect.position[0]}
            onChange={(e) =>
              onChange({ ...effect, position: [Number(e.target.value), effect.position[1]] })
            }
            className="h-7 text-xs w-20"
          />
          <span>,</span>
          <Input
            type="number"
            min={0}
            value={effect.position[1]}
            onChange={(e) =>
              onChange({ ...effect, position: [effect.position[0], Number(e.target.value)] })
            }
            className="h-7 text-xs w-20"
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Defaults / labels
// ---------------------------------------------------------------------------

function defaultForEffectType(type: EffectType): Effect | ButtonEffect {
  switch (type) {
    case "changeState":
    case "changeStateOther":
      return { type, id: "" };
    case "emitSignal":
      return { type, id: "" };
    case "incrementCounterSelf":
    case "incrementCounterOther":
      return { type, id: "", amount: 1 };
    case "destroySelf":
    case "destroyOther":
    case "endTurn":
    case "endPlayerTurn":
    case "endAiTurn":
      return { type };
    case "transformSelf":
    case "transformOther":
      return { type, id: "" };
    case "setRoom":
      return { type, id: "" };
    case "sendAiInstruction":
      return { type, message: "" };
    case "createEntity":
      return { type, classId: "", position: [0, 0] };
  }
}

function labelForType(type: EffectType, t: (k: string) => string): string {
  // Use a single translation namespace; fall back to the raw type name if missing.
  const key = `customApps.effectType_${type}`;
  const v = t(key);
  return v && v !== key ? v : type;
}

// Silence the unused-import warning for BASIC_TYPES (kept for future filtering).
void BASIC_TYPES;
