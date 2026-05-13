// server/services/dual-agent/default-home-board.ts
// Builds the default AAC home board with translated navigation buttons.
// Each button uses the "exit" action to unload the board and instruct the AI.

import type { ParsedBoardData, BoardButton } from "@shared/schema";

// ---------------------------------------------------------------------------
// Button definitions with translations and AI instructions
// ---------------------------------------------------------------------------

interface HomeButtonDef {
  id: string;
  labels: Record<string, string>;
  icon: string;
  imageKey?: string;
  /** Static icon path served from /aac-buttons/main-menu/ (overrides emoji when set) */
  staticIcon?: string;
  /** Instruction sent to the AI when this button is pressed (via exit action text) */
  instruction: string;
}

const HOME_BUTTONS: HomeButtonDef[] = [
  {
    id: "home_interact",
    labels: { en: "Interact", he: "דבר איתי" },
    icon: "🗣️",
    staticIcon: "/aac-buttons/main-menu/ai_talking.png",
    instruction: "[INTERACT] The user wants to talk to you. Switch to Interaction Mode. Rebuild the board with conversation starters and topics relevant to the student's interests.",
  },
  {
    id: "home_talk",
    labels: { en: "Talk", he: "אני מדבר" },
    icon: "💬",
    staticIcon: "/aac-buttons/main-menu/human_talking.png",
    instruction: "[ASSIST] The user is talking to someone else. Switch to Assist Mode. Rebuild the board with phrases and responses the student might want to say in a conversation.",
  },
  {
    id: "home_my_day",
    labels: { en: "My Day", he: "היום שלי" },
    icon: "📅",
    instruction: "[MY DAY] The user wants to talk about events in their day. Rebuild the board with time-of-day activities (morning routine, school, lunch, afternoon, evening) and event-related buttons.",
  },
  {
    id: "home_interests",
    labels: { en: "Interests", he: "תחומי עניין" },
    icon: "⭐",
    instruction: "[INTERESTS] The user wants to explore their interests. Use the student profile from the system prompt to rebuild the board with buttons related to their known interests, hobbies, and favorite topics.",
  },
  {
    id: "home_feelings",
    labels: { en: "Feelings", he: "רגשות" },
    icon: "😊",
    imageKey: "feelings",
    staticIcon: "/aac-buttons/main-menu/feelings.png",
    instruction: "[FEELINGS] The user wants to express their feelings. Rebuild the board with emotion buttons (happy, sad, tired, excited, angry, scared, bored, etc.).",
  },
  {
    id: "home_help",
    labels: { en: "Help", he: "עזרה" },
    icon: "⚠️",
    imageKey: "person_help",
    staticIcon: "/aac-buttons/main-menu/person_help.png",
    instruction: "[HELP] The user needs help with something. Rebuild the board with common requests: I need help, I'm hurt, I need the bathroom, I'm hungry, I'm thirsty, I'm cold/hot, call someone, etc.",
  },
  {
    id: "home_apps",
    labels: { en: "Apps", he: "אפליקציות" },
    icon: "📱",
    instruction: "[APPS] The user wants to use apps. Rebuild the board with buttons for each available app (use open_app() to launch them). Include app names and icons.",
  },
  {
    id: "home_construct",
    labels: { en: "Build sentence", he: "בנה משפט" },
    icon: "🧩",
    imageKey: "person_thinking",
    staticIcon: "/aac-buttons/main-menu/person_thinking.png",
    // Intercepted by the client (see home.tsx handleBoardButtonClick) — opens
    // the sentence construction board as an overlay. NOT forwarded to the AI;
    // the construction board emits its own state injections once open.
    instruction: "[CONSTRUCTION BOARD] Open the sentence construction board.",
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
      text: def.instruction,
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
