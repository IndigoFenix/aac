// src/features/custom-app/LeftRail.tsx
//
// Three stacked lists: Objects (classes), Rooms, Buttons. Each lets the user
// add a new item or select an existing one. Clicking a class while a room is
// the current selection arms placement; Shift-click makes placement sticky.

import type {
  ButtonDef,
  ClassDef,
  GameDefinition,
  RoomDef,
} from "@shared/custom-app-types";
import { EntityVisual } from "@client-shared/game-runtime";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Plus, Home as HomeIcon } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { EditorAction, Selection } from "./editor-state";
import {
  defaultButton,
  defaultClass,
  defaultRoom,
} from "./helpers";
import { useCustomAppStore } from "@/store/custom-app-store";

interface LeftRailProps {
  definition: GameDefinition;
  selection: Selection;
  placementClassId: string | null;
  dispatch: React.Dispatch<EditorAction>;
  isDark: boolean;
}

export function LeftRail({
  definition,
  selection,
  placementClassId,
  dispatch,
  isDark,
}: LeftRailProps) {
  const { t } = useLanguage();
  const { upsertClass, upsertRoom, upsertButton } = useCustomAppStore();

  const handleNewClass = () => {
    const cls = defaultClass(definition.classes.map((c) => c.id));
    upsertClass(cls);
    dispatch({ type: "selectClass", classId: cls.id });
  };
  const handleNewRoom = () => {
    const room = defaultRoom(definition.rooms.map((r) => r.id));
    upsertRoom(room);
    dispatch({ type: "selectRoom", roomId: room.id });
  };
  const handleNewButton = () => {
    const btn = defaultButton(definition.buttons.map((b) => b.id));
    upsertButton(btn);
    dispatch({ type: "selectButton", buttonId: btn.id });
  };

  // Click on a class: if a room is selected, arm placement. Otherwise select it.
  const handleClassClick = (classId: string, shiftKey: boolean) => {
    if (selection.kind === "room" || selection.kind === "entity") {
      dispatch({ type: "armPlacement", classId, sticky: shiftKey });
    } else {
      dispatch({ type: "selectClass", classId });
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col h-full overflow-y-auto border-r shrink-0 w-56",
        isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
      )}
    >
      <Section
        title={t("customApps.objects")}
        onAdd={handleNewClass}
        isDark={isDark}
      >
        {definition.classes.length === 0 ? (
          <Empty isDark={isDark}>{t("customApps.noObjects")}</Empty>
        ) : (
          definition.classes.map((c) => (
            <ClassRow
              key={c.id}
              cls={c}
              active={selection.kind === "class" && selection.classId === c.id}
              armed={placementClassId === c.id}
              canPlace={selection.kind === "room" || selection.kind === "entity"}
              onClick={(shift) => handleClassClick(c.id, shift)}
              isDark={isDark}
            />
          ))
        )}
      </Section>

      <Section
        title={t("customApps.rooms")}
        onAdd={handleNewRoom}
        isDark={isDark}
      >
        {definition.rooms.length === 0 ? (
          <Empty isDark={isDark}>{t("customApps.noRooms")}</Empty>
        ) : (
          definition.rooms.map((r) => (
            <RoomRow
              key={r.id}
              room={r}
              isStart={r.id === definition.startRoom}
              active={
                (selection.kind === "room" && selection.roomId === r.id) ||
                (selection.kind === "entity" && selection.roomId === r.id)
              }
              onClick={() => dispatch({ type: "selectRoom", roomId: r.id })}
              isDark={isDark}
            />
          ))
        )}
      </Section>

      <Section
        title={t("customApps.buttons")}
        onAdd={handleNewButton}
        isDark={isDark}
      >
        {definition.buttons.length === 0 ? (
          <Empty isDark={isDark}>{t("customApps.noButtons")}</Empty>
        ) : (
          definition.buttons.map((b) => (
            <ButtonRow
              key={b.id}
              btn={b}
              active={selection.kind === "button" && selection.buttonId === b.id}
              onClick={() => dispatch({ type: "selectButton", buttonId: b.id })}
              isDark={isDark}
            />
          ))
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function Section({
  title,
  onAdd,
  children,
  isDark,
}: {
  title: string;
  onAdd: () => void;
  children: React.ReactNode;
  isDark: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col border-b",
        isDark ? "border-slate-800" : "border-gray-200",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between px-3 py-1.5 text-xs font-semibold uppercase tracking-wide sticky top-0",
          isDark ? "bg-slate-900 text-slate-400" : "bg-white text-gray-500",
        )}
      >
        <span>{title}</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function Empty({ children, isDark }: { children: React.ReactNode; isDark: boolean }) {
  return (
    <div
      className={cn(
        "px-3 py-2 text-xs italic",
        isDark ? "text-slate-500" : "text-gray-400",
      )}
    >
      {children}
    </div>
  );
}

function Row({
  active,
  armed,
  onClick,
  children,
  isDark,
  title,
}: {
  active?: boolean;
  armed?: boolean;
  onClick: (shiftKey: boolean) => void;
  children: React.ReactNode;
  isDark: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => onClick(e.shiftKey)}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 text-sm text-left select-none",
        active && (isDark ? "bg-slate-800" : "bg-gray-100"),
        armed && (isDark ? "ring-1 ring-blue-500" : "ring-1 ring-blue-400"),
        !active && (isDark ? "hover:bg-slate-800/60" : "hover:bg-gray-50"),
      )}
    >
      {children}
    </button>
  );
}

function ClassRow({
  cls,
  active,
  armed,
  canPlace,
  onClick,
  isDark,
}: {
  cls: ClassDef;
  active: boolean;
  armed: boolean;
  canPlace: boolean;
  onClick: (shift: boolean) => void;
  isDark: boolean;
}) {
  return (
    <Row
      active={active}
      armed={armed}
      onClick={onClick}
      isDark={isDark}
      title={canPlace ? cls.id + " (click to place; shift = sticky)" : cls.id}
    >
      <div className="w-6 h-6 flex items-center justify-center shrink-0">
        <EntityVisual entity={null} cls={cls} fontSize={18} />
      </div>
      <span className="flex-1 truncate">{cls.label ?? cls.id}</span>
      {cls.label && cls.label !== cls.id && (
        <span className={cn("text-[10px] truncate max-w-[60px]", isDark ? "text-slate-500" : "text-gray-400")}>
          {cls.id}
        </span>
      )}
    </Row>
  );
}

function RoomRow({
  room,
  isStart,
  active,
  onClick,
  isDark,
}: {
  room: RoomDef;
  isStart: boolean;
  active: boolean;
  onClick: () => void;
  isDark: boolean;
}) {
  const [w, h] = room.size;
  return (
    <Row active={active} onClick={() => onClick()} isDark={isDark} title={room.id}>
      {isStart ? (
        <HomeIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
      ) : (
        <span className="w-3.5 h-3.5 shrink-0" />
      )}
      <span className="flex-1 truncate">{room.label ?? room.id}</span>
      <span className={cn("text-[10px]", isDark ? "text-slate-500" : "text-gray-400")}>
        {w}×{h}
      </span>
    </Row>
  );
}

function ButtonRow({
  btn,
  active,
  onClick,
  isDark,
}: {
  btn: ButtonDef;
  active: boolean;
  onClick: () => void;
  isDark: boolean;
}) {
  return (
    <Row active={active} onClick={() => onClick()} isDark={isDark} title={btn.id}>
      <span className="w-6 text-center shrink-0">{btn.iconRef ?? "•"}</span>
      <span className="flex-1 truncate">{btn.label ?? btn.id}</span>
    </Row>
  );
}
