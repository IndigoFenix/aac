/**
 * aac-board-form.ts
 *
 * Utilities for converting AAC board data to/from the formSchema/formValues system.
 * This allows the AI to see and update the board in a single response pass.
 */

import { NlpSchema, formValues } from "../chat/prompt-kit";
import type { ParsedBoardData, BoardButton, BoardPage, BoardGrid } from "@shared/schema";

// Default grid size for AAC boards
const DEFAULT_GRID: BoardGrid = { rows: 4, cols: 4 };

/** Structure of a button in the form values array */
export interface ButtonFormValue {
  row: number;
  col: number;
  label: string;
  spokenText?: string;
  color?: string;
  iconRef?: string;
}

/**
 * Generate the NlpSchema for an AAC board.
 * Uses an array structure for efficient button representation.
 */
export function generateAACBoardFormSchema(grid: BoardGrid = DEFAULT_GRID): NlpSchema {
  return {
    type: 'object',
    instructions: `The AAC communication board (${grid.rows}x${grid.cols} grid).
Provide an array of buttons for the user to communicate with.
IMPORTANT: Always provide at least 2-4 relevant buttons based on the conversation context.
Use clear, simple labels. Consider the user's abilities and preferences.`,
    properties: {
      buttons: {
        type: 'array',
        instructions: 'Array of board buttons. Each button needs row, col, label, and optionally spokenText, color, iconRef.',
        items: {
          type: 'object',
          properties: {
            row: {
              type: 'number',
              instructions: `Row position (0 to ${grid.rows - 1})`,
            },
            col: {
              type: 'number',
              instructions: `Column position (0 to ${grid.cols - 1})`,
            },
            label: {
              type: 'string',
              instructions: 'Short display text (1-3 words)',
            },
            spokenText: {
              type: 'string',
              instructions: 'Text to speak when pressed (defaults to label if not set)',
            },
            color: {
              type: 'string',
              instructions: 'Button color hex code (e.g., "#3B82F6" blue, "#22C55E" green, "#EF4444" red)',
            },
            iconRef: {
              type: 'string',
              instructions: 'FontAwesome icon class (e.g., "fas fa-home")',
            },
          },
        },
      },
    },
  };
}

/**
 * Convert ParsedBoardData to formValues for the AI to see.
 * Returns buttons as an array for efficient representation.
 */
export function boardDataToFormValues(
  board: ParsedBoardData | null | undefined
): { buttons: ButtonFormValue[] } {
  if (!board || !board.pages || board.pages.length === 0) {
    return { buttons: [] };
  }

  // Find the current page or use the first page
  const currentPageId = board.currentPageId || board.pages[0]?.id;
  const currentPage = board.pages.find(p => p.id === currentPageId) || board.pages[0];

  if (!currentPage || !currentPage.buttons) {
    return { buttons: [] };
  }

  // Convert buttons to array format
  const buttons: ButtonFormValue[] = currentPage.buttons.map(button => ({
    row: button.row,
    col: button.col,
    label: button.label,
    spokenText: button.spokenText || undefined,
    color: button.color || undefined,
    iconRef: button.iconRef || undefined,
  }));

  return { buttons };
}

/**
 * Apply setValues from AI response to update the board data.
 * Expects setValues.buttons to be an array of ButtonFormValue objects.
 * Returns the updated ParsedBoardData.
 */
export function applySetValuesToBoard(
  currentBoard: ParsedBoardData | null | undefined,
  setValues: { buttons?: ButtonFormValue[] | null } | null | undefined,
  grid: BoardGrid = DEFAULT_GRID
): ParsedBoardData {
  // Start with current board or create a new one
  const board: ParsedBoardData = currentBoard ? { ...currentBoard } : {
    name: 'Communication Board',
    grid: { ...grid },
    pages: [{
      id: 'page-main',
      name: 'Main',
      buttons: [],
    }],
    currentPageId: 'page-main',
  };

  // If no buttons array provided, return current board unchanged
  if (!setValues || !setValues.buttons || !Array.isArray(setValues.buttons)) {
    return board;
  }

  // Ensure we have pages array
  if (!board.pages || board.pages.length === 0) {
    board.pages = [{
      id: 'page-main',
      name: 'Main',
      buttons: [],
    }];
    board.currentPageId = 'page-main';
  }

  // Find or create the current page
  const currentPageId = board.currentPageId || board.pages[0]?.id;
  let currentPage = board.pages.find(p => p.id === currentPageId);

  if (!currentPage) {
    currentPage = {
      id: 'page-main',
      name: 'Main',
      buttons: [],
    };
    board.pages = [currentPage];
    board.currentPageId = currentPage.id;
  }

  // Convert the button array from AI to BoardButton format
  const newButtons: BoardButton[] = setValues.buttons
    .filter(btn => btn && typeof btn === 'object' && btn.label)
    .map(btn => ({
      id: `btn-${btn.row}-${btn.col}`,
      row: btn.row ?? 0,
      col: btn.col ?? 0,
      label: btn.label,
      spokenText: btn.spokenText || btn.label,
      color: btn.color || '#3B82F6',
      iconRef: btn.iconRef || undefined,
      action: {
        type: 'speak' as const,
        text: btn.spokenText || btn.label,
      },
    }));

  // Update the current page's buttons (replace entirely with new array)
  currentPage.buttons = newButtons;

  // Create new board object with updated page
  return {
    ...board,
    pages: board.pages.map(p =>
      p.id === currentPage!.id ? currentPage! : p
    ),
  };
}

/**
 * System prompt section for AAC board interaction using setValues.
 */
export const AAC_BOARD_SETVALUES_PROMPT = `
## Communication Board

You manage a communication board that the user interacts with. The board displays buttons that the user can select to communicate.

### How to Update the Board

The current board buttons are shown in the "Page Elements" section. You can see each button's position, label, spoken text, color, and icon.

To update the board, use the "setValues" field in your response with a "buttons" array:

Example setValues:
{
  "buttons": [
    { "row": 0, "col": 0, "label": "Yes", "spokenText": "Yes, I agree!", "color": "#22C55E", "iconRef": "fas fa-check" },
    { "row": 0, "col": 1, "label": "No", "spokenText": "No, I disagree", "color": "#EF4444", "iconRef": "fas fa-times" },
    { "row": 1, "col": 0, "label": "More", "spokenText": "I want more options", "color": "#3B82F6", "iconRef": "fas fa-plus" }
  ]
}

### Button Properties

- **row, col**: Grid position (0-indexed)
- **label**: Short text (1-3 words) shown on the button
- **spokenText**: Text spoken aloud when pressed (defaults to label)
- **color**: Hex color code (e.g., "#3B82F6" blue, "#22C55E" green, "#EF4444" red)
- **iconRef**: FontAwesome icon class (e.g., "fas fa-home")

### Important Rules

1. ALWAYS provide at least 2-4 relevant buttons based on the conversation context
2. Use clear, simple labels that are easy to understand
3. Consider the user's communication abilities and preferences
4. Update buttons to match the current topic of conversation
5. The buttons array replaces all current buttons - include all buttons you want to show
`;
