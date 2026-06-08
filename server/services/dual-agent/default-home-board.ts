// server/services/dual-agent/default-home-board.ts
// Builds the default AAC home board with translated navigation buttons.
// Each button uses the "exit" action; the action `text` is just a TAG.
//
// The tag is the WHOLE protocol — no descriptive text needed. Routing:
//   - Server: `handleBoardExitInner` matches `/^\[([A-Z ]+)\]/` and looks
//     up `HOME_INTENTS` in `agent-coordinator.ts`. The matching entry
//     supplies the speaker behavioral hint AND the BoardManager
//     palette directive (`forceRebuildDirective`). Text after the tag
//     would be discarded.
//   - Client: `home.tsx` intercepts `[APPS BOARD]` and
//     `[CONSTRUCTION BOARD]` substring matches and opens the
//     corresponding overlay locally — these tags never reach the
//     server. Same rule: only the tag matters.

import type { ParsedBoardData, BoardButton } from "@shared/schema";

// ---------------------------------------------------------------------------
// Button definitions
// ---------------------------------------------------------------------------

interface HomeButtonDef {
  id: string;
  labels: Record<string, string>;
  icon: string;
  imageKey?: string;
  /** Static icon path served from /aac-buttons/main-menu/ (overrides emoji when set) */
  staticIcon?: string;
  /** Routing TAG sent as the exit action's text. Server- and
   *  client-side routing both match on the bracketed tag and ignore
   *  any trailing text, so this is just the tag — nothing more. */
  tag: string;
}

const HOME_BUTTONS: HomeButtonDef[] = [
  {
    id: "home_interact",
    labels: { en: "Interact", he: "דבר איתי" },
    icon: "🗣️",
    staticIcon: "/aac-buttons/main-menu/ai_talking.png",
    tag: "[INTERACT]",
  },
  {
    id: "home_talk",
    labels: { en: "Talk", he: "אני מדבר" },
    icon: "💬",
    staticIcon: "/aac-buttons/main-menu/human_talking.png",
    tag: "[ASSIST]",
  },
  {
    id: "home_my_day",
    labels: { en: "My Day", he: "היום שלי" },
    icon: "📅",
    tag: "[MY DAY]",
  },
  {
    id: "home_interests",
    labels: { en: "Interests", he: "תחומי עניין" },
    icon: "⭐",
    tag: "[INTERESTS]",
  },
  {
    id: "home_feelings",
    labels: { en: "Feelings", he: "רגשות" },
    icon: "😊",
    imageKey: "feelings",
    staticIcon: "/aac-buttons/main-menu/feelings.png",
    tag: "[FEELINGS]",
  },
  {
    id: "home_help",
    labels: { en: "Help", he: "עזרה" },
    icon: "⚠️",
    imageKey: "person_help",
    staticIcon: "/aac-buttons/main-menu/person_help.png",
    tag: "[HELP]",
  },
  {
    id: "home_apps",
    labels: { en: "Apps", he: "אפליקציות" },
    icon: "📱",
    // Intercepted by the client (home.tsx handleBoardButtonClick) — opens the
    // apps board overlay client-side. NOT forwarded to the AI; the overlay
    // sends its own [APP OPENED ...] instruction once the user picks an app.
    tag: "[APPS BOARD]",
  },
  {
    id: "home_construct",
    labels: { en: "Build sentence", he: "בנה משפט" },
    icon: "🧩",
    imageKey: "person_thinking",
    staticIcon: "/aac-buttons/main-menu/person_thinking.png",
    // Intercepted by the client (home.tsx handleBoardButtonClick) — opens the
    // sentence construction board as an overlay. NOT forwarded to the AI;
    // the construction board emits its own state injections once open.
    tag: "[CONSTRUCTION BOARD]",
  },
];

// ---------------------------------------------------------------------------
// Board builder
// ---------------------------------------------------------------------------

/**
 * Build the default home board for a given language.
 * Returns a ParsedBoardData that can be used as a virtual board in availableBoards.
 */
export function buildDefaultHomeBoard(language: string): ParsedBoardData {
  const lang = language.startsWith("he") ? "he" : "en";
  const cols = 4;
  const rows = 2;

  const buttons: BoardButton[] = HOME_BUTTONS.map((def, i) => ({
    id: def.id,
    row: Math.floor(i / cols),
    col: i % cols,
    label: def.labels[lang] || def.labels.en,
    iconRef: def.icon,
    ...(def.staticIcon ? { symbolPath: def.staticIcon } : { imageKey: def.imageKey }),
    sentence: def.labels[lang] || def.labels.en,
    exitBoard: true,
    action: {
      type: "exit" as const,
      text: def.tag,
    },
  }));

  return {
    name: lang === "he" ? "דף הבית" : "Home",
    grid: { rows, cols },
    pages: [{
      id: "home_page_main",
      name: lang === "he" ? "ראשי" : "Main",
      buttons,
    }],
  };
}

/**
 * The board key used to reference the home board in availableBoards.
 */
export const HOME_BOARD_KEY = "home";
