/**
 * React component that runs a game definition.
 *
 * Renders the current room as a grid, handles click + drag-drop input, and
 * exposes the engine's event stream + pending AI instructions via callbacks.
 *
 * Designed to be embedded in both the AAC client (main board area) and the
 * clinician client (preview).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ButtonDef,
  ClassDef,
  GameDefinition,
  GridCoord,
  Layer,
  OverridableProp,
} from "@shared/custom-app-types";
import { dispatch, drainPendingAiInstructions, initState } from "./engine";
import type { EngineAction, EngineEvent, EntityInstance, RuntimeState } from "./engine-types";
import { getClass, getEntitiesAtCell, getRoom, isSolid, isTile, sortStackBottomToTop, getContainedEntities } from "./selectors";

const LAYER_ORDER: Layer[] = ["background", "entity", "overlay"];

export interface GameRuntimeHandle {
  /** Send an AI action (from the AI tool layer). */
  sendAiAction: (action: Extract<EngineAction, { type: "ai_trigger" | "ai_create" }>) => void;
  /** Current runtime state (read-only). */
  getState: () => RuntimeState;
}

export interface GameRuntimeProps {
  def: GameDefinition;
  /** Callback fired on every engine event (state changes, errors, ai instructions). */
  onEvents?: (events: EngineEvent[]) => void;
  /** Callback fired when the engine has queued AI instructions for the prompt layer. */
  onAiInstructions?: (messages: string[]) => void;
  /** Optional exit action (rendered as a back button in the UI). */
  onExit?: () => void;
  /** Optional: resolve an image reference to a URL. Falls back to rendering `char`/`label`. */
  resolveImage?: (ref: string) => string | undefined;
  /** Hook to receive an imperative handle to the runtime. */
  apiRef?: React.MutableRefObject<GameRuntimeHandle | null>;
  /** Optional CSS class / style override for the root. */
  className?: string;
}

interface ReducerAction {
  type: "apply";
  action: EngineAction;
}

export function GameRuntime({
  def,
  onEvents,
  onAiInstructions,
  onExit,
  resolveImage,
  apiRef,
  className,
}: GameRuntimeProps) {
  const initial = useMemo(() => initState(def), [def]);
  const [state, dispatchLocal] = useReducer(
    (prev: RuntimeState, a: ReducerAction) => {
      const result = dispatch(prev, a.action, def);
      lastEventsRef.current = result.events;
      return result.state;
    },
    initial,
  );
  const lastEventsRef = useRef<EngineEvent[]>([]);

  // Surface engine events + drain AI instructions after each tick.
  useEffect(() => {
    if (lastEventsRef.current.length > 0) {
      onEvents?.(lastEventsRef.current);
      lastEventsRef.current = [];
    }
    if (state.pendingAiInstructions.length > 0) {
      const msgs = drainPendingAiInstructions(state);
      onAiInstructions?.(msgs);
    }
  }, [state, onEvents, onAiInstructions]);

  const sendAction = useCallback((action: EngineAction) => {
    dispatchLocal({ type: "apply", action });
  }, []);

  // Expose imperative handle.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      sendAiAction: (action) => sendAction(action),
      getState: () => state,
    };
    return () => {
      if (apiRef.current) apiRef.current = null;
    };
  }, [apiRef, sendAction, state]);

  const room = getRoom(def, state.currentRoomId);
  const [roomW, roomH] = room.size;

  // Track drag state so we can validate/drop.
  const [dragging, setDragging] = useState<string | null>(null);
  const [hoverCell, setHoverCell] = useState<GridCoord | null>(null);
  const [inventoryFor, setInventoryFor] = useState<string | null>(null);

  const handleCellClick = (cell: GridCoord) => {
    // Click fires on the topmost entity at the cell.
    const stack = sortStackBottomToTop(def, getEntitiesAtCell(def, state, cell));
    const top = stack[stack.length - 1];
    if (!top) return;
    const topCls = getClass(def, top.class_id);
    // Opening a container opens the inventory modal; still fire on_click too.
    if (topCls.max_capacity !== undefined) setInventoryFor(top.uid);
    sendAction({ type: "click", targetUid: top.uid });
  };

  const handleDrop = (cell: GridCoord) => {
    if (!dragging) return;
    sendAction({ type: "move", movingUid: dragging, to: cell });
    setDragging(null);
    setHoverCell(null);
  };

  const handleDropOnContainer = (containerUid: string) => {
    if (!dragging) return;
    sendAction({ type: "drop_into_container", movingUid: dragging, containerUid });
    setDragging(null);
    setHoverCell(null);
  };

  const handleButtonClick = (buttonId: string) => {
    sendAction({ type: "button_press", buttonId });
  };

  // ---------- Rendering ----------

  const cellSize = 64;
  const enabledButtons = def.buttons.filter((b) => state.buttons[b.id]?.enabled);

  return (
    <div className={className} style={{ display: "flex", gap: 12, padding: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {onExit && (
          <button onClick={onExit} style={{ padding: 6 }}>← Exit</button>
        )}
        {state.turnBased && (
          <div style={{ fontSize: 12 }}>
            Turn: <strong>{state.turn}</strong>
          </div>
        )}
        <div
          style={{
            position: "relative",
            width: roomW * cellSize,
            height: roomH * cellSize,
            border: "1px solid #444",
            background: "#1e293b",
            userSelect: "none",
          }}
        >
          {/* Grid cells (for click/drop targets) */}
          {Array.from({ length: roomH }).map((_, y) =>
            Array.from({ length: roomW }).map((_, x) => {
              const cell: GridCoord = [x, y];
              const isHover = hoverCell && hoverCell[0] === x && hoverCell[1] === y;
              return (
                <div
                  key={`cell-${x}-${y}`}
                  onClick={() => handleCellClick(cell)}
                  onDragOver={(e) => {
                    if (dragging) {
                      e.preventDefault();
                      setHoverCell(cell);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(cell);
                  }}
                  style={{
                    position: "absolute",
                    left: x * cellSize,
                    top: y * cellSize,
                    width: cellSize,
                    height: cellSize,
                    boxSizing: "border-box",
                    border: "1px solid #334155",
                    background: isHover ? "rgba(255,255,255,0.08)" : "transparent",
                  }}
                />
              );
            }),
          )}

          {/* Entities — grouped by layer for consistent z-order */}
          {LAYER_ORDER.map((layerName) => (
            <LayerGroup
              key={layerName}
              layerName={layerName}
              state={state}
              def={def}
              cellSize={cellSize}
              dragging={dragging}
              setDragging={setDragging}
              resolveImage={resolveImage}
              onDropOnContainer={handleDropOnContainer}
            />
          ))}
        </div>
      </div>

      {/* Sidebar buttons */}
      {enabledButtons.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 120 }}>
          {enabledButtons.map((b) => (
            <SidebarButton key={b.id} button={b} onClick={() => handleButtonClick(b.id)} resolveImage={resolveImage} />
          ))}
        </div>
      )}

      {/* Inventory modal */}
      {inventoryFor && state.entities[inventoryFor] && (
        <InventoryModal
          def={def}
          state={state}
          containerUid={inventoryFor}
          onClose={() => setInventoryFor(null)}
          resolveImage={resolveImage}
          onDragStart={(uid) => setDragging(uid)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function LayerGroup({
  layerName,
  state,
  def,
  cellSize,
  dragging,
  setDragging,
  resolveImage,
  onDropOnContainer,
}: {
  layerName: Layer;
  state: RuntimeState;
  def: GameDefinition;
  cellSize: number;
  dragging: string | null;
  setDragging: (uid: string | null) => void;
  resolveImage?: (ref: string) => string | undefined;
  onDropOnContainer: (uid: string) => void;
}) {
  const entities = Object.values(state.entities).filter((e) => {
    if (e.container_uid) return false;
    const cls = getClass(def, e.class_id);
    return (cls.layer ?? "entity") === layerName;
  });
  const sorted = sortStackBottomToTop(def, entities);

  return (
    <>
      {sorted.map((e) => {
        const cls = getClass(def, e.class_id);
        const hidden = (e.overrides.hidden ?? cls.hidden) === true;
        if (hidden) return null;
        const [w, h] = cls.size ?? [1, 1];
        const isContainer = cls.max_capacity !== undefined;
        const movable = (e.overrides.movable ?? cls.movable) === true;
        return (
          <div
            key={e.uid}
            draggable={movable}
            onDragStart={(ev) => {
              if (!movable) {
                ev.preventDefault();
                return;
              }
              ev.dataTransfer.effectAllowed = "move";
              ev.dataTransfer.setData("text/plain", e.uid);
              setDragging(e.uid);
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(ev) => {
              if (isContainer && dragging && dragging !== e.uid) {
                ev.preventDefault();
              }
            }}
            onDrop={(ev) => {
              if (isContainer && dragging && dragging !== e.uid) {
                ev.preventDefault();
                ev.stopPropagation();
                onDropOnContainer(e.uid);
              }
            }}
            style={{
              position: "absolute",
              left: e.position[0] * cellSize,
              top: e.position[1] * cellSize,
              width: w * cellSize,
              height: h * cellSize,
              boxSizing: "border-box",
              border: isContainer ? "2px dashed #94a3b8" : undefined,
              background: resolveColor(e, cls, "tile_color") ?? undefined,
              color: "#e2e8f0",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: movable ? "grab" : "pointer",
              pointerEvents: "auto",
            }}
            title={resolveLabel(e, cls) ?? cls.id}
          >
            <EntityVisual entity={e} cls={cls} resolveImage={resolveImage} />
          </div>
        );
      })}
    </>
  );
}

function EntityVisual({
  entity,
  cls,
  resolveImage,
}: {
  entity: EntityInstance;
  cls: ClassDef;
  resolveImage?: (ref: string) => string | undefined;
}) {
  const imageRef = (entity.overrides.image as string | undefined) ?? cls.image;
  const imageColor = resolveColor(entity, cls, "image_color");
  const char = (entity.overrides.char as string | undefined) ?? cls.char;
  const label = resolveLabel(entity, cls);

  const imageUrl = imageRef ? resolveImage?.(imageRef) : undefined;
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={label ?? cls.id}
        style={{
          maxWidth: "80%",
          maxHeight: "80%",
          filter: imageColor ? `drop-shadow(0 0 0 ${imageColor})` : undefined,
        }}
      />
    );
  }
  if (char) {
    return <span style={{ fontSize: 24, color: imageColor ?? "#e2e8f0" }}>{char}</span>;
  }
  if (label) {
    return <span style={{ color: imageColor ?? "#e2e8f0" }}>{label}</span>;
  }
  return null;
}

function SidebarButton({
  button,
  onClick,
  resolveImage,
}: {
  button: ButtonDef;
  onClick: () => void;
  resolveImage?: (ref: string) => string | undefined;
}) {
  const imageUrl = button.image ? resolveImage?.(button.image) : undefined;
  return (
    <button
      onClick={onClick}
      style={{
        padding: 10,
        background: button.button_color ?? "#334155",
        color: "#f1f5f9",
        border: "1px solid #475569",
        borderRadius: 6,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      {imageUrl ? (
        <img src={imageUrl} alt={button.label ?? button.id} style={{ width: 36, height: 36 }} />
      ) : null}
      <span>{button.label ?? button.id}</span>
    </button>
  );
}

function InventoryModal({
  def,
  state,
  containerUid,
  onClose,
  resolveImage,
  onDragStart,
}: {
  def: GameDefinition;
  state: RuntimeState;
  containerUid: string;
  onClose: () => void;
  resolveImage?: (ref: string) => string | undefined;
  onDragStart: (uid: string) => void;
}) {
  const container = state.entities[containerUid];
  const cls = container ? getClass(def, container.class_id) : undefined;
  const contained = getContainedEntities(state, containerUid);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0f172a",
          color: "#e2e8f0",
          padding: 16,
          borderRadius: 8,
          minWidth: 300,
          maxWidth: 480,
          border: "1px solid #475569",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <strong>{(cls && resolveLabel(container!, cls)) ?? "Inventory"}</strong>
          <button onClick={onClose}>×</button>
        </div>
        {contained.length === 0 ? (
          <div style={{ opacity: 0.6 }}>Empty</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 56px)", gap: 8 }}>
            {contained.map((e) => {
              const c = getClass(def, e.class_id);
              const movable = (e.overrides.movable ?? c.movable) === true;
              return (
                <div
                  key={e.uid}
                  draggable={movable}
                  onDragStart={(ev) => {
                    if (!movable) {
                      ev.preventDefault();
                      return;
                    }
                    ev.dataTransfer.effectAllowed = "move";
                    ev.dataTransfer.setData("text/plain", e.uid);
                    onDragStart(e.uid);
                  }}
                  style={{
                    width: 56,
                    height: 56,
                    border: "1px solid #475569",
                    background: resolveColor(e, c, "tile_color") ?? "#1e293b",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: movable ? "grab" : "default",
                  }}
                  title={resolveLabel(e, c) ?? c.id}
                >
                  <EntityVisual entity={e} cls={c} resolveImage={resolveImage} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveColor(entity: EntityInstance, cls: ClassDef, prop: "tile_color" | "image_color"): string | undefined {
  const v = (entity.overrides as Record<string, unknown>)[prop] ?? (cls as unknown as Record<string, unknown>)[prop];
  return typeof v === "string" ? v : undefined;
}

function resolveLabel(entity: EntityInstance, cls: ClassDef): string | undefined {
  const v = (entity.overrides.label as string | undefined) ?? cls.label;
  return typeof v === "string" ? v : undefined;
}

// Silence unused-imports warnings (these helpers may be used by future features).
void isTile;
void isSolid;
