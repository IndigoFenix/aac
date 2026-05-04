// src/features/custom-app/RightRail.tsx
//
// The right-rail inspector cycles through three modes based on the editor
// selection:
//   - entity selected → EntityInstanceEditor (per-instance overrides + delete)
//   - room selected   → RoomPropertiesPanel (size, defaultTile, label, ...)
//   - nothing selected (or class/button selected) → AppPropertiesPanel
//
// All edits go through the Zustand store so the canvas (and AI's view) update
// immediately.

import type {
  ButtonDef,
  ClassDef,
  GameDefinition,
  OverridableProp,
  RoomDef,
  RoomEntityInstance,
} from "@shared/custom-app-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { OVERRIDABLE_PROPS } from "@shared/custom-app-validator";
import type { EditorAction, Selection } from "./editor-state";
import { clipEntitiesToSize } from "./helpers";
import { OverrideValueInput } from "./editors/override-value-input";
import { EffectsListEditor } from "./editors/effect-editor";

interface RightRailProps {
  definition: GameDefinition;
  selection: Selection;
  dispatch: React.Dispatch<EditorAction>;
  isDark: boolean;
}

export function RightRail({ definition, selection, dispatch, isDark }: RightRailProps) {
  return (
    <div
      className={cn(
        "flex flex-col h-full overflow-y-auto border-l shrink-0 w-72",
        isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
      )}
    >
      {selection.kind === "entity" ? (
        <EntityInstanceEditor
          definition={definition}
          roomId={selection.roomId}
          index={selection.index}
          dispatch={dispatch}
          isDark={isDark}
        />
      ) : selection.kind === "room" ? (
        <RoomPropertiesPanel
          definition={definition}
          roomId={selection.roomId}
          dispatch={dispatch}
          isDark={isDark}
        />
      ) : selection.kind === "button" ? (
        <ButtonEditor
          definition={definition}
          buttonId={selection.buttonId}
          dispatch={dispatch}
          isDark={isDark}
        />
      ) : (
        <AppPropertiesPanel definition={definition} isDark={isDark} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App properties (default when nothing is selected)
// ---------------------------------------------------------------------------

function AppPropertiesPanel({
  definition,
  isDark,
}: {
  definition: GameDefinition;
  isDark: boolean;
}) {
  const { t } = useLanguage();
  const { setAppMeta } = useCustomAppStore();

  return (
    <div className="flex flex-col">
      <Header title={t("customApps.appProperties")} subtitle={definition.label} isDark={isDark} />
      <div className="p-4 space-y-3">
        <Field label={t("customApps.label")}>
          <Input
            value={definition.label}
            onChange={(e) => setAppMeta({ label: e.target.value })}
          />
        </Field>
        <Field label={t("customApps.description")}>
          <Textarea
            value={definition.description ?? ""}
            onChange={(e) => setAppMeta({ description: e.target.value || undefined })}
            rows={2}
          />
        </Field>
        <Field label={t("customApps.startRoom")}>
          <Select
            value={definition.startRoom}
            onValueChange={(v) => setAppMeta({ startRoom: v })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {definition.rooms.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label ?? r.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Toggle
          label={t("customApps.turnBased")}
          checked={!!definition.turnBased}
          onChange={(v) => setAppMeta({ turnBased: v || undefined })}
        />
        <Field label={t("customApps.iconRef")}>
          <Input
            value={definition.iconRef ?? ""}
            onChange={(e) => setAppMeta({ iconRef: e.target.value || undefined })}
            placeholder="🎮"
            maxLength={4}
          />
        </Field>
        <Field label={t("customApps.imageKey")}>
          <Input
            value={definition.imageKey ?? ""}
            onChange={(e) => setAppMeta({ imageKey: e.target.value || undefined })}
          />
        </Field>
        <Field label={t("customApps.aiInstructions")}>
          <Textarea
            value={definition.aiInstructions ?? ""}
            onChange={(e) => setAppMeta({ aiInstructions: e.target.value || undefined })}
            rows={4}
          />
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room properties
// ---------------------------------------------------------------------------

function RoomPropertiesPanel({
  definition,
  roomId,
  dispatch,
  isDark,
}: {
  definition: GameDefinition;
  roomId: string;
  dispatch: React.Dispatch<EditorAction>;
  isDark: boolean;
}) {
  const { t } = useLanguage();
  const { upsertRoom, deleteRoom, setAppMeta } = useCustomAppStore();
  const room = definition.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const isStart = definition.startRoom === room.id;

  const patch = (p: Partial<RoomDef>) => upsertRoom({ ...room, ...p });
  const showGrid = room.showGrid !== false;
  const size = room.size ?? [1, 1];

  const handleResize = (w: number, h: number) => {
    const safeW = Math.max(1, Math.min(64, w));
    const safeH = Math.max(1, Math.min(64, h));
    if (safeW === size[0] && safeH === size[1]) return;
    const wouldClip = (room.entities ?? []).some(
      (e) => e.position[0] >= safeW || e.position[1] >= safeH,
    );
    if (wouldClip && !confirm(t("customApps.resizeConfirm"))) return;
    const clipped = clipEntitiesToSize(room.entities, safeW, safeH);
    upsertRoom({ ...room, size: [safeW, safeH], entities: clipped });
  };

  const handleDelete = () => {
    if (definition.rooms.length === 1) {
      alert(t("customApps.cannotDeleteLastRoom"));
      return;
    }
    if (!confirm(t("customApps.deleteRoomConfirm", { id: room.id }))) return;
    deleteRoom(room.id);
    dispatch({ type: "selectNone" });
  };

  return (
    <div className="flex flex-col">
      <Header
        title={t("customApps.roomProperties")}
        subtitle={room.label ?? room.id}
        isDark={isDark}
        right={
          <>
            <Button variant="ghost" size="sm" onClick={handleDelete}>
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dispatch({ type: "selectNone" })}
              title={t("common.close")}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        }
      />
      <div className="p-4 space-y-3">
        <Field label={t("customApps.id")}>
          <Input value={room.id} disabled className="opacity-70" />
        </Field>
        <Field label={t("customApps.label")}>
          <Input
            value={room.label ?? ""}
            onChange={(e) => patch({ label: e.target.value || undefined })}
          />
        </Field>
        <Toggle
          label={t("customApps.showBefore")}
          checked={room.showBefore !== false}
          onChange={(v) => patch({ showBefore: v ? undefined : false })}
        />
        <Toggle
          label={t("customApps.showGrid")}
          checked={showGrid}
          onChange={(v) => {
            // When turning the grid on, ensure size exists.
            if (v) {
              patch({ showGrid: undefined, size: room.size ?? [8, 8] });
            } else {
              patch({ showGrid: false });
            }
          }}
        />
        <Toggle
          label={t("customApps.showAfter")}
          checked={room.showAfter !== false}
          onChange={(v) => patch({ showAfter: v ? undefined : false })}
        />
        {showGrid && (
          <>
            <Field label={t("customApps.size")}>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={1}
                  max={64}
                  className="w-20"
                  value={size[0]}
                  onChange={(e) => handleResize(Number(e.target.value), size[1])}
                />
                <span>×</span>
                <Input
                  type="number"
                  min={1}
                  max={64}
                  className="w-20"
                  value={size[1]}
                  onChange={(e) => handleResize(size[0], Number(e.target.value))}
                />
              </div>
            </Field>
            <Field label={t("customApps.defaultTile")}>
              <Input
                value={room.defaultTile ?? ""}
                onChange={(e) => patch({ defaultTile: e.target.value.slice(0, 1) || undefined })}
                maxLength={1}
                className="w-16"
              />
            </Field>
          </>
        )}
        <Toggle
          label={t("customApps.startRoomFlag")}
          checked={isStart}
          onChange={(v) => {
            if (v) setAppMeta({ startRoom: room.id });
          }}
        />
        <Field label={t("customApps.enabledButtons")}>
          <ButtonMultiSelect
            buttons={definition.buttons}
            selected={room.buttons ?? []}
            onChange={(ids) => patch({ buttons: ids.length ? ids : undefined })}
          />
        </Field>
        <Field label={t("customApps.aiInstructions")}>
          <Textarea
            value={room.aiInstructions ?? ""}
            onChange={(e) => patch({ aiInstructions: e.target.value || undefined })}
            rows={3}
          />
        </Field>
        {showGrid && (
          <Field label={t("customApps.tilesAscii")}>
            <Textarea
              value={room.tiles ?? ""}
              onChange={(e) => patch({ tiles: e.target.value || undefined })}
              rows={Math.min(8, size[1])}
              className={cn("font-mono text-xs", isDark ? "bg-slate-950" : "bg-gray-50")}
              placeholder={`${size[0]}×${size[1]} ${t("customApps.tilesPlaceholder")}`}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

function ButtonMultiSelect({
  buttons,
  selected,
  onChange,
}: {
  buttons: ButtonDef[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (buttons.length === 0) {
    return <div className="text-xs italic opacity-60">—</div>;
  }
  return (
    <div className="space-y-1">
      {buttons.map((b) => {
        const checked = selected.includes(b.id);
        return (
          <label key={b.id} className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={checked}
              onCheckedChange={(v) => {
                if (v) onChange([...selected, b.id]);
                else onChange(selected.filter((id) => id !== b.id));
              }}
            />
            <span>{b.label ?? b.id}</span>
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entity instance editor (per-placement overrides + delete)
// ---------------------------------------------------------------------------

function EntityInstanceEditor({
  definition,
  roomId,
  index,
  dispatch,
  isDark,
}: {
  definition: GameDefinition;
  roomId: string;
  index: number;
  dispatch: React.Dispatch<EditorAction>;
  isDark: boolean;
}) {
  const { t } = useLanguage();
  const { updateRoomEntity, deleteRoomEntity } = useCustomAppStore();
  const room = definition.rooms.find((r) => r.id === roomId);
  const entity = room?.entities?.[index];
  const cls = entity ? definition.classes.find((c) => c.id === entity.classId) : null;

  if (!room || !entity) {
    return <Header title={t("customApps.instanceMissing")} isDark={isDark} />;
  }
  if (!cls) {
    return (
      <>
        <Header title={t("customApps.instanceMissing")} subtitle={entity.classId} isDark={isDark} />
        <div className="p-4">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              deleteRoomEntity(roomId, index);
              dispatch({ type: "selectRoom", roomId });
            }}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            {t("customApps.deleteFromRoom")}
          </Button>
        </div>
      </>
    );
  }

  const overrides = entity.overrides ?? {};
  const setOverride = (prop: OverridableProp, value: unknown) => {
    const next: Record<string, unknown> = { ...overrides };
    if (value === undefined || value === "" || value === null) delete next[prop];
    else next[prop] = value;
    updateRoomEntity(roomId, index, {
      overrides: Object.keys(next).length ? next : undefined,
    });
  };

  const roomSize = room.size ?? [1, 1];
  const setPosition = (x: number, y: number) => {
    const safeX = Math.max(0, Math.min(roomSize[0] - 1, x));
    const safeY = Math.max(0, Math.min(roomSize[1] - 1, y));
    updateRoomEntity(roomId, index, { position: [safeX, safeY] });
  };

  return (
    <div className="flex flex-col">
      <Header
        title={t("customApps.instanceTitle")}
        subtitle={cls.label ?? cls.id}
        isDark={isDark}
        right={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                deleteRoomEntity(roomId, index);
                dispatch({ type: "selectRoom", roomId });
              }}
              title={t("customApps.deleteFromRoom")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dispatch({ type: "selectRoom", roomId })}
              title={t("common.close")}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        }
      />
      <div className="p-4 space-y-3">
        <Field label={t("customApps.position")}>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={0}
              max={roomSize[0] - 1}
              className="w-20"
              value={entity.position[0]}
              onChange={(e) => setPosition(Number(e.target.value), entity.position[1])}
            />
            <span>,</span>
            <Input
              type="number"
              min={0}
              max={roomSize[1] - 1}
              className="w-20"
              value={entity.position[1]}
              onChange={(e) => setPosition(entity.position[0], Number(e.target.value))}
            />
          </div>
        </Field>

        <Field label={t("customApps.state")}>
          <Select
            value={entity.state ?? "_default"}
            onValueChange={(v) =>
              updateRoomEntity(roomId, index, { state: v === "_default" ? undefined : v })
            }
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_default">{t("customApps.stateDefault")}</SelectItem>
              {(cls.states ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Counters */}
        {cls.counters && cls.counters.length > 0 && (
          <Field label={t("customApps.counters")}>
            <div className="space-y-1">
              {cls.counters.map((c) => (
                <CounterRow
                  key={c.id}
                  id={c.id}
                  label={c.label ?? c.id}
                  initial={c.initial}
                  value={entity.counters?.[c.id]}
                  onChange={(v) => {
                    const next = { ...(entity.counters ?? {}) };
                    if (v === undefined) delete next[c.id];
                    else next[c.id] = v;
                    updateRoomEntity(roomId, index, {
                      counters: Object.keys(next).length ? next : undefined,
                    });
                  }}
                />
              ))}
            </div>
          </Field>
        )}

        {/* Overrides */}
        <details>
          <summary className="text-xs font-semibold uppercase tracking-wide opacity-70 cursor-pointer">
            {t("customApps.overrides")}
          </summary>
          <div className="space-y-2 mt-2">
            {OVERRIDABLE_PROPS.map((prop) => (
              <OverrideRow
                key={prop}
                prop={prop}
                value={overrides[prop]}
                classDefault={(cls as Record<string, unknown>)[prop]}
                onChange={(v) => setOverride(prop, v)}
              />
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

function CounterRow({
  id,
  label,
  initial,
  value,
  onChange,
}: {
  id: string;
  label: string;
  initial: number;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex-1 truncate" title={id}>{label}</span>
      <Input
        type="number"
        value={value ?? ""}
        placeholder={String(initial)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="w-20 h-7"
      />
    </div>
  );
}

function OverrideRow({
  prop,
  value,
  classDefault,
  onChange,
}: {
  prop: OverridableProp;
  value: unknown;
  classDefault: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0">{prop}</span>
      <div className="flex-1">
        <OverrideValueInput prop={prop} value={value} placeholder={classDefault} onChange={onChange} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Button editor
// ---------------------------------------------------------------------------

function ButtonEditor({
  definition,
  buttonId,
  dispatch,
  isDark,
}: {
  definition: GameDefinition;
  buttonId: string;
  dispatch: React.Dispatch<EditorAction>;
  isDark: boolean;
}) {
  const { t } = useLanguage();
  const { upsertButton, deleteButton } = useCustomAppStore();
  const btn = definition.buttons.find((b) => b.id === buttonId);
  if (!btn) return null;

  const patch = (p: Partial<ButtonDef>) => upsertButton({ ...btn, ...p });

  const handleDelete = () => {
    if (!confirm(t("customApps.deleteButtonConfirm", { id: btn.id }))) return;
    deleteButton(btn.id);
    dispatch({ type: "selectNone" });
  };

  return (
    <div className="flex flex-col">
      <Header
        title={t("customApps.buttonProperties")}
        subtitle={btn.label ?? btn.id}
        isDark={isDark}
        right={
          <>
            <Button variant="ghost" size="sm" onClick={handleDelete}>
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dispatch({ type: "selectNone" })}
              title={t("common.close")}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        }
      />
      <div className="p-4 space-y-3">
        <Field label={t("customApps.id")}>
          <Input value={btn.id} disabled className="opacity-70" />
        </Field>
        <Field label={t("customApps.label")}>
          <Input
            value={btn.label ?? ""}
            onChange={(e) => patch({ label: e.target.value || undefined })}
          />
        </Field>
        <Field label={t("customApps.iconRef")}>
          <Input
            value={btn.iconRef ?? ""}
            onChange={(e) => patch({ iconRef: e.target.value || undefined })}
            maxLength={4}
          />
        </Field>
        <Field label={t("customApps.buttonColor")}>
          <Input
            value={btn.buttonColor ?? ""}
            onChange={(e) => patch({ buttonColor: e.target.value || undefined })}
            placeholder="#334155"
          />
        </Field>
        <Toggle
          label={t("customApps.enabledByDefault")}
          checked={!!btn.enabledByDefault}
          onChange={(v) => patch({ enabledByDefault: v || undefined })}
        />
        <Field label={t("customApps.section")}>
          <Select
            value={btn.section ?? "before"}
            onValueChange={(v) =>
              patch({ section: v === "after" ? "after" : undefined })
            }
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="before">{t("customApps.sectionBefore")}</SelectItem>
              <SelectItem value="after">{t("customApps.sectionAfter")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("customApps.position")}>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={0}
              className="w-20"
              placeholder={t("customApps.row")}
              value={btn.row ?? ""}
              onChange={(e) =>
                patch({
                  row: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)),
                })
              }
            />
            <span>,</span>
            <Input
              type="number"
              min={0}
              className="w-20"
              placeholder={t("customApps.column")}
              value={btn.col ?? ""}
              onChange={(e) =>
                patch({
                  col: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)),
                })
              }
            />
          </div>
        </Field>
        <Field label={t("customApps.span")}>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={1}
              className="w-20"
              placeholder={t("customApps.rowSpan")}
              value={btn.rowSpan ?? ""}
              onChange={(e) =>
                patch({
                  rowSpan: e.target.value === "" ? undefined : Math.max(1, Number(e.target.value)),
                })
              }
            />
            <span>×</span>
            <Input
              type="number"
              min={1}
              className="w-20"
              placeholder={t("customApps.colSpan")}
              value={btn.colSpan ?? ""}
              onChange={(e) =>
                patch({
                  colSpan: e.target.value === "" ? undefined : Math.max(1, Number(e.target.value)),
                })
              }
            />
          </div>
        </Field>
        <Field label={t("customApps.effects")}>
          <EffectsListEditor
            value={btn.effects}
            onChange={(effects) => patch({ effects: effects as ButtonDef["effects"] })}
            definition={definition}
            allowCreateEntity
            isDark={isDark}
          />
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared form primitives
// ---------------------------------------------------------------------------

function Header({
  title,
  subtitle,
  right,
  isDark,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  isDark: boolean;
}) {
  return (
    <div
      className={cn(
        "px-4 py-3 border-b shrink-0 flex items-start gap-2",
        isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-xs uppercase opacity-60">{title}</div>
        {subtitle && <div className="text-base font-medium truncate">{subtitle}</div>}
      </div>
      {right}
    </div>
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

