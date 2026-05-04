// src/features/custom-app/RoomEditor.tsx
//
// Edit-time canvas for a single room. Renders the entity grid using the same
// EntityVisual as the live runtime so what-you-see matches play mode.
//
// Click semantics:
//   - placement armed → drop a new entity of placementClassId at the clicked cell
//   - empty cell      → deselect (selectRoom)
//   - occupied cell   → select the topmost entity (selectEntity)
//
// Esc cancels placement.

import { useEffect, useMemo } from "react";
import type {
  GameDefinition,
  GridCoord,
  Layer,
  RoomDef,
} from "@shared/custom-app-types";
import { EntityVisual, resolveColor, resolveLabel } from "@client-shared/game-runtime";
import { useCustomAppStore } from "@/store/custom-app-store";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import type { EditorAction } from "./editor-state";

const LAYER_ORDER: Layer[] = ["background", "entity", "overlay"];
const CELL_SIZE = 56;

interface RoomEditorProps {
  room: RoomDef;
  definition: GameDefinition;
  /** Selected entity index inside this room, if any. */
  selectedEntityIndex: number | null;
  placementClassId: string | null;
  stickyPlacement: boolean;
  dispatch: React.Dispatch<EditorAction>;
  isDark: boolean;
}

export function RoomEditor({
  room,
  definition,
  selectedEntityIndex,
  placementClassId,
  stickyPlacement,
  dispatch,
  isDark,
}: RoomEditorProps) {
  const { t } = useLanguage();
  const { addRoomEntity, deleteRoomEntity } = useCustomAppStore();
  const [w, h] = room.size ?? [1, 1];
  const showGrid = room.showGrid !== false && !!room.size;
  const placementClass = useMemo(
    () => placementClassId ? definition.classes.find((c) => c.id === placementClassId) ?? null : null,
    [placementClassId, definition.classes],
  );

  // Esc cancels placement.
  useEffect(() => {
    if (!placementClassId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "cancelPlacement" });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [placementClassId, dispatch]);

  // Group entities by layer for stable z-order, like GameRuntime does.
  const entitiesByLayer = useMemo(() => {
    const groups: Record<Layer, Array<{ index: number; entity: NonNullable<RoomDef["entities"]>[number] }>> = {
      background: [],
      entity: [],
      overlay: [],
    };
    (room.entities ?? []).forEach((entity, index) => {
      const cls = definition.classes.find((c) => c.id === entity.classId);
      const layer = cls?.layer ?? "entity";
      groups[layer].push({ index, entity });
    });
    return groups;
  }, [room.entities, definition.classes]);

  const handleCellClick = (cell: GridCoord) => {
    // Find topmost entity at this cell (search overlay → entity → background).
    for (let li = LAYER_ORDER.length - 1; li >= 0; li--) {
      const group = entitiesByLayer[LAYER_ORDER[li]];
      for (let i = group.length - 1; i >= 0; i--) {
        const { index, entity } = group[i];
        const cls = definition.classes.find((c) => c.id === entity.classId);
        const [ew, eh] = cls?.size ?? [1, 1];
        const [ex, ey] = entity.position;
        if (cell[0] >= ex && cell[0] < ex + ew && cell[1] >= ey && cell[1] < ey + eh) {
          if (placementClassId) {
            // Placement takes priority — but only if the cell is empty enough.
            // (Allow placing on top — the engine layers them.)
            placeAt(cell);
            return;
          }
          dispatch({ type: "selectEntity", roomId: room.id, index });
          return;
        }
      }
    }
    if (placementClassId) {
      placeAt(cell);
    } else {
      // Empty cell click while not placing → just keep room selected.
      dispatch({ type: "selectRoom", roomId: room.id });
    }
  };

  const placeAt = (cell: GridCoord) => {
    if (!placementClassId) return;
    const newIndex = (room.entities ?? []).length;
    addRoomEntity(room.id, { classId: placementClassId, position: cell });
    dispatch({ type: "selectEntity", roomId: room.id, index: newIndex });
    if (!stickyPlacement) dispatch({ type: "cancelPlacement" });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 gap-3">
      {/* Placement banner */}
      {placementClassId && placementClass && (
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 rounded text-sm",
            isDark ? "bg-blue-950 text-blue-200" : "bg-blue-50 text-blue-800",
          )}
        >
          <span>
            {t("customApps.placingHint", {
              name: placementClass.label ?? placementClass.id,
            })}
            {stickyPlacement && ` · ${t("customApps.placingSticky")}`}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dispatch({ type: "cancelPlacement" })}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {!showGrid && (
        <div
          className={cn(
            "rounded border px-3 py-2 text-xs italic",
            isDark ? "border-slate-700 text-slate-400" : "border-gray-300 text-gray-500",
          )}
        >
          {t("customApps.gridlessRoomHint")}
        </div>
      )}

      {/* Canvas */}
      {showGrid && (
      <div
        className={cn(
          "relative shrink-0 self-start rounded border",
          isDark ? "border-slate-700" : "border-gray-300",
        )}
        style={{
          width: w * CELL_SIZE,
          height: h * CELL_SIZE,
          background: isDark ? "#1e293b" : "#f1f5f9",
          cursor: placementClassId ? "crosshair" : "default",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        {/* Grid cells */}
        {Array.from({ length: h }).map((_, y) =>
          Array.from({ length: w }).map((_, x) => (
            <div
              key={`cell-${x}-${y}`}
              onClick={() => handleCellClick([x, y])}
              style={{
                position: "absolute",
                left: x * CELL_SIZE,
                top: y * CELL_SIZE,
                width: CELL_SIZE,
                height: CELL_SIZE,
                boxSizing: "border-box",
                border: isDark ? "1px solid #334155" : "1px solid #cbd5e1",
              }}
            />
          )),
        )}

        {/* Entities */}
        {LAYER_ORDER.flatMap((layer) =>
          entitiesByLayer[layer].map(({ index, entity }) => {
            const cls = definition.classes.find((c) => c.id === entity.classId);
            if (!cls) {
              return (
                <UnknownEntity
                  key={index}
                  cell={entity.position}
                  classId={entity.classId}
                  isDark={isDark}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    deleteRoomEntity(room.id, index);
                    if (selectedEntityIndex === index) {
                      dispatch({ type: "selectRoom", roomId: room.id });
                    }
                  }}
                />
              );
            }
            const [ew, eh] = cls.size ?? [1, 1];
            const [ex, ey] = entity.position;
            const isSelected = selectedEntityIndex === index;
            const isContainer = cls.maxCapacity !== undefined;
            return (
              <div
                key={index}
                onClick={(e) => {
                  e.stopPropagation();
                  if (placementClassId) {
                    placeAt([ex, ey]);
                  } else {
                    dispatch({ type: "selectEntity", roomId: room.id, index });
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  deleteRoomEntity(room.id, index);
                  // If the deleted entity was selected, fall back to the room.
                  if (selectedEntityIndex === index) {
                    dispatch({ type: "selectRoom", roomId: room.id });
                  }
                }}
                style={{
                  position: "absolute",
                  left: ex * CELL_SIZE,
                  top: ey * CELL_SIZE,
                  width: ew * CELL_SIZE,
                  height: eh * CELL_SIZE,
                  boxSizing: "border-box",
                  outline: isSelected
                    ? "2px solid #38bdf8"
                    : isContainer
                      ? "2px dashed #94a3b8"
                      : undefined,
                  outlineOffset: isSelected ? -2 : undefined,
                  background: resolveColor(null, cls, "tileColor") ?? undefined,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
                title={resolveLabel(null, cls) ?? cls.id}
              >
                <EntityVisual entity={null} cls={cls} fontSize={20} />
              </div>
            );
          }),
        )}
      </div>
      )}

      {showGrid && (
        <div className={cn("text-xs", isDark ? "text-slate-500" : "text-gray-500")}>
          {t("customApps.canvasHint")}
        </div>
      )}
    </div>
  );
}

function UnknownEntity({
  cell,
  classId,
  isDark,
  onContextMenu,
}: {
  cell: GridCoord;
  classId: string;
  isDark: boolean;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      onContextMenu={onContextMenu}
      style={{
        position: "absolute",
        left: cell[0] * CELL_SIZE,
        top: cell[1] * CELL_SIZE,
        width: CELL_SIZE,
        height: CELL_SIZE,
        outline: "2px dashed #ef4444",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 10,
        color: isDark ? "#fca5a5" : "#b91c1c",
      }}
      title={`Unknown class: ${classId}`}
    >
      ?
    </div>
  );
}
