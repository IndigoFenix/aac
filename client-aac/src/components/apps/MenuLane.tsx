// client-aac/src/components/apps/MenuLane.tsx
//
// THE TWO BOARD LANES of the restaurant app: the venue's MENU, and the generic
// eating-out FLOOR words.
//
// Both are `ParsedBoardData` built on the server and both render through the
// ordinary board renderer, so this file is mostly about which one is showing
// and how the student gets to the other.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE FLOOR BOARD LIVES HERE AND NOT IN `availableBoards`
//
// It used to be registered as a virtual pre-built board, which put "Restaurant"
// in the Board Manager's <prebuilt_boards> list next to the student's own
// boards — competing with them for a model's attention in every single session
// where the feature was on, whether or not anyone was near a restaurant. It is
// not one of the student's boards. It is one of this app's screens.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY BOTH, AND WHY THE MENU DOES NOT REPLACE THE FLOOR
//
// A menu can say "chicken soup". It cannot say "this is too hot", "yuck", or
// "I am still hungry" — the menu board only keeps more / finished / bathroom on
// its pages, because the rest of the grid belongs to food. Those are the words
// a seated child needs most and the ones a meal goes wrong without, so in menu
// mode the floor board is one dwellable press away rather than in another app.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS RENDERS WITH `DynamicBoard`
//
// Handing the board straight to the ordinary renderer is not a shortcut — it is
// the only way these get reading mode, page navigation, the student's icon/text
// ratio, their selection method, their rest space and RTL, all of which are
// per-student settings that already work and that a hand-rolled grid inside an
// app would silently drop.
//
// See planning-docs/aac-restaurant-menus.md §4.5, §4.1a.

import { useState } from "react";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import DynamicBoard from "@/components/DynamicBoard";
import { useLanguage } from "@/contexts/LanguageContext";

interface MenuLaneProps {
  /** The venue, when it is known. Blank in floor mode with no binding. */
  venueName?: string;
  /** The venue's menu. Absent in floor mode. */
  menuBoard?: ParsedBoardData;
  /** The generic eating-out words. Always present in both board modes. */
  floorBoard?: ParsedBoardData;
  /** Which board to show first. */
  initial: "menu" | "floor";
  /** Voice a press the way any board press is voiced. */
  onSpeak?: (label: string, sentence: string) => void;
  /** Hand the device to the adult. Not dwellable — see FoodBrowseLane. */
  onSwitchToCaretaker: () => void;
  language?: string;
  iconTextRatio?: number;
  selectionMethod?: any;
  restSpace?: any;
}

export function MenuLane({
  venueName,
  menuBoard,
  floorBoard,
  initial,
  onSpeak,
  onSwitchToCaretaker,
  language,
  iconTextRatio,
  selectionMethod,
  restSpace,
}: MenuLaneProps) {
  const { t } = useLanguage();
  const [showing, setShowing] = useState<"menu" | "floor">(initial);

  const board = showing === "menu" ? menuBoard : floorBoard;
  if (!board) return null;

  // Only offer the toggle when there is somewhere to toggle TO. In floor mode
  // with no menu there is no second board, and a button that does nothing is
  // worse on a dwell surface than no button at all.
  const canToggle = !!menuBoard && !!floorBoard;

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-lg font-semibold mb-2 text-center">
        {venueName || t("aac.restaurant.title")}
      </h2>

      <div className="flex-1 min-h-0">
        <DynamicBoard
          board={board}
          language={language}
          iconTextRatio={iconTextRatio}
          selectionMethod={selectionMethod}
          restSpace={restSpace}
          // The SERVER owns what gets said: `spokenText` is the original dish
          // name, never the translated label, because the waiter is the
          // audience. The renderer hands us both; we pass the spoken one on
          // untouched.
          onButtonClick={(button: BoardButton, spokenText: string) => {
            onSpeak?.(button.label, spokenText || button.label);
          }}
        />
      </div>

      {canToggle && (
        <button
          type="button"
          data-dwell
          onClick={() => setShowing(showing === "menu" ? "floor" : "menu")}
          className="mt-2 rounded-xl bg-gray-200 dark:bg-gray-700 px-4 py-3 text-base"
          data-testid="menu-toggle-board"
        >
          {showing === "menu"
            ? t("aac.restaurant.otherWords")
            : t("aac.restaurant.backToMenu")}
        </button>
      )}

      <button
        type="button"
        onClick={onSwitchToCaretaker}
        className="mt-2 pt-2 text-xs text-gray-400 underline self-center"
        data-testid="menu-caretaker-lane"
      >
        {t("aac.restaurant.forGrownUp")}
      </button>
    </div>
  );
}
