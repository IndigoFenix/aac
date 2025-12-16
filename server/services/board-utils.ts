/**
 * Board Utilities
 * 
 * Extracted business logic for AAC board manipulation.
 * Used by the session service when handling board-related memory operations.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface BoardButton {
    id: string;
    row: number;
    col: number;
    label: string;
    spokenText?: string;
    color?: string;
    iconRef?: string;
    symbolPath?: string;
    selfClosing?: boolean;
    action?: {
      type: "speak" | "link";
      text?: string;
      toPageId?: string;
    };
  }
  
  export interface BoardPage {
    id: string;
    name: string;
    buttons: BoardButton[];
    layout?: { rows: number; cols: number };
  }
  
  export interface BoardGrid {
    rows: number;
    cols: number;
  }
  
  export interface ParsedBoardData {
    name: string;
    grid: BoardGrid;
    pages: BoardPage[];
    currentPageId?: string;
  }
  
  export interface GeneratedButtonSpec {
    label: string;
    spokenText?: string;
    color?: string;
    iconRef?: string;
    row?: number;
    col?: number;
    pageId?: string;
    selfClosing?: boolean;
    linkPageId?: string;
    symbolPath?: string;
  }
  
  export interface GeneratedBoardUpdate {
    summary: string;
    newPages: { id: string; name: string }[];
    newButtons: GeneratedButtonSpec[];
    deletedPageIds?: string[];
    deletedButtonIds?: string[];
    editedButtons?: {
      id: string;
      label?: string;
      spokenText?: string;
      color?: string;
      iconRef?: string;
      row?: number;
      col?: number;
      pageId?: string;
      selfClosing?: boolean;
      linkPageId?: string;
    }[];
  }
  
  // ============================================================================
  // CONSTANTS
  // ============================================================================
  
  export const BOARD_COLORS = {
    needs: "#3B82F6",
    emotions: "#F59E0B",
    people: "#EC4899",
    activities: "#EAB308",
    objects: "#6B7280",
    yes: "#059669",
    no: "#DC2626",
    default: "#6B7280",
  };
  
  export const DEFAULT_GRID: BoardGrid = { rows: 3, cols: 3 };
  
  // ============================================================================
  // SANITIZATION
  // ============================================================================
  
  /**
   * Sanitize a button's label and spokenText to enforce length limits
   */
  export function sanitizeButton(button: Partial<BoardButton> | GeneratedButtonSpec): void {
    if (button.label && button.label.length > 30) {
      button.label = button.label.substring(0, 30);
    }
    if (button.spokenText && button.spokenText.length > 100) {
      button.spokenText = button.spokenText.substring(0, 100);
    }
  }
  
  /**
   * Sanitize all buttons in an AI response
   */
  export function sanitizeAIResponse(aiResponse: { buttons?: any[] }): void {
    if (!aiResponse.buttons || !Array.isArray(aiResponse.buttons)) return;
    for (const button of aiResponse.buttons) {
      sanitizeButton(button);
    }
  }
  
  /**
   * Sanitize a board update response
   */
  export function sanitizeBoardUpdate(update: GeneratedBoardUpdate): void {
    for (const button of update.newButtons) {
      sanitizeButton(button);
    }
    if (update.editedButtons) {
      for (const button of update.editedButtons) {
        sanitizeButton(button);
      }
    }
  }
  
  // ============================================================================
  // POSITIONING
  // ============================================================================
  
  /**
   * Find the next available position on a grid
   */
  export function findNextPosition(
    requestedRow: number | undefined,
    requestedCol: number | undefined,
    grid: BoardGrid,
    occupiedPositions: Set<string>
  ): { row: number; col: number } {
    // If position specified and valid, try to use it
    if (requestedRow !== undefined && requestedCol !== undefined) {
      const row = Math.max(0, Math.min(requestedRow, grid.rows - 1));
      const col = Math.max(0, Math.min(requestedCol, grid.cols - 1));
  
      if (!occupiedPositions.has(`${row},${col}`)) {
        occupiedPositions.add(`${row},${col}`);
        return { row, col };
      }
    }
  
    // Find next available position (row by row)
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        if (!occupiedPositions.has(`${row},${col}`)) {
          occupiedPositions.add(`${row},${col}`);
          return { row, col };
        }
      }
    }
  
    // Grid full - return 0,0
    return { row: 0, col: 0 };
  }
  
  /**
   * Get occupied positions from a page's buttons
   */
  export function getOccupiedPositions(buttons: BoardButton[]): Set<string> {
    return new Set(buttons.map((b) => `${b.row},${b.col}`));
  }
  
  // ============================================================================
  // ID GENERATION
  // ============================================================================
  
  /**
   * Generate a unique button ID
   */
  export function generateButtonId(): string {
    return `btn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Generate a unique page ID
   */
  export function generatePageId(): string {
    return `page-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  // ============================================================================
  // BOARD CREATION
  // ============================================================================
  
  /**
   * Create a fallback board with basic buttons
   */
  export function createFallbackBoard(
    name?: string,
    gridSize?: BoardGrid
  ): ParsedBoardData {
    const grid = gridSize || DEFAULT_GRID;
  
    return {
      name: name || "Communication Board",
      grid,
      pages: [
        {
          id: "page-1",
          name: "Main Page",
          buttons: [
            {
              id: "btn-1",
              row: 0,
              col: 0,
              label: "Yes",
              spokenText: "Yes",
              color: BOARD_COLORS.yes,
              iconRef: "fas fa-check",
              action: { type: "speak", text: "Yes" },
            },
            {
              id: "btn-2",
              row: 0,
              col: 1,
              label: "No",
              spokenText: "No",
              color: BOARD_COLORS.no,
              iconRef: "fas fa-times",
              action: { type: "speak", text: "No" },
            },
            {
              id: "btn-3",
              row: 0,
              col: 2,
              label: "Help",
              spokenText: "I need help",
              color: BOARD_COLORS.emotions,
              iconRef: "fas fa-question",
              action: { type: "speak", text: "I need help" },
            },
          ],
          layout: grid,
        },
      ],
      currentPageId: "page-1",
    };
  }
  
  /**
   * Create an empty board with the specified grid size
   */
  export function createEmptyBoard(
    name: string,
    gridSize?: BoardGrid
  ): ParsedBoardData {
    const grid = gridSize || DEFAULT_GRID;
    const pageId = generatePageId();
  
    return {
      name,
      grid,
      pages: [
        {
          id: pageId,
          name: "Main Page",
          buttons: [],
          layout: grid,
        },
      ],
      currentPageId: pageId,
    };
  }
  
  // ============================================================================
  // BUTTON CREATION
  // ============================================================================
  
  /**
   * Create a button from a spec
   */
  export function createButtonFromSpec(
    spec: GeneratedButtonSpec,
    grid: BoardGrid,
    occupiedPositions: Set<string>
  ): BoardButton {
    const { row, col } = findNextPosition(
      spec.row,
      spec.col,
      grid,
      occupiedPositions
    );
  
    const action = spec.linkPageId
      ? { type: "link" as const, toPageId: spec.linkPageId }
      : { type: "speak" as const, text: spec.spokenText || spec.label };
  
    return {
      id: generateButtonId(),
      row,
      col,
      label: spec.label,
      spokenText: spec.spokenText || spec.label,
      color: spec.color || BOARD_COLORS.default,
      iconRef: spec.iconRef || "fas fa-comment",
      symbolPath: spec.symbolPath,
      selfClosing: spec.selfClosing,
      action,
    };
  }
  
  // ============================================================================
  // BOARD UPDATE OPERATIONS
  // ============================================================================
  
  /**
   * Apply a board update to an existing board
   */
  export function applyBoardUpdate(
    currentBoard: ParsedBoardData,
    update: GeneratedBoardUpdate
  ): ParsedBoardData {
    // Sanitize the update first
    sanitizeBoardUpdate(update);
  
    let newPages = [...currentBoard.pages.map((p) => ({ ...p, buttons: [...p.buttons] }))];
  
    // Step 1: Delete pages (if requested)
    if (update.deletedPageIds && update.deletedPageIds.length > 0) {
      newPages = newPages.filter((p) => !update.deletedPageIds!.includes(p.id));
    }
  
    // Step 2: Delete buttons (if requested)
    if (update.deletedButtonIds && update.deletedButtonIds.length > 0) {
      for (const page of newPages) {
        page.buttons = page.buttons.filter(
          (b) => !update.deletedButtonIds!.includes(b.id)
        );
      }
    }
  
    // Step 3: Edit buttons (if requested)
    if (update.editedButtons && update.editedButtons.length > 0) {
      for (const edit of update.editedButtons) {
        for (const page of newPages) {
          const buttonIndex = page.buttons.findIndex((b) => b.id === edit.id);
          if (buttonIndex !== -1) {
            const button = page.buttons[buttonIndex];
  
            // If moving to a different page
            if (edit.pageId && edit.pageId !== page.id) {
              page.buttons.splice(buttonIndex, 1);
  
              const targetPage = newPages.find((p) => p.id === edit.pageId);
              if (targetPage) {
                const updatedButton = { ...button };
                if (edit.label !== undefined) updatedButton.label = edit.label;
                if (edit.spokenText !== undefined) updatedButton.spokenText = edit.spokenText;
                if (edit.color !== undefined) updatedButton.color = edit.color;
                if (edit.iconRef !== undefined) updatedButton.iconRef = edit.iconRef;
                if (edit.selfClosing !== undefined) updatedButton.selfClosing = edit.selfClosing;
  
                const occupiedPositions = getOccupiedPositions(targetPage.buttons);
                const { row, col } = findNextPosition(
                  edit.row,
                  edit.col,
                  currentBoard.grid,
                  occupiedPositions
                );
                updatedButton.row = row;
                updatedButton.col = col;
  
                if (edit.linkPageId !== undefined) {
                  updatedButton.action = { type: "link", toPageId: edit.linkPageId };
                }
  
                targetPage.buttons.push(updatedButton);
              }
            } else {
              // Edit in place
              if (edit.label !== undefined) button.label = edit.label;
              if (edit.spokenText !== undefined) button.spokenText = edit.spokenText;
              if (edit.color !== undefined) button.color = edit.color;
              if (edit.iconRef !== undefined) button.iconRef = edit.iconRef;
              if (edit.selfClosing !== undefined) button.selfClosing = edit.selfClosing;
  
              // Update position if specified
              if (edit.row !== undefined || edit.col !== undefined) {
                const occupiedPositions = new Set(
                  page.buttons
                    .filter((b) => b.id !== button.id)
                    .map((b) => `${b.row},${b.col}`)
                );
                const { row, col } = findNextPosition(
                  edit.row ?? button.row,
                  edit.col ?? button.col,
                  currentBoard.grid,
                  occupiedPositions
                );
                button.row = row;
                button.col = col;
              }
  
              // Update action if link changed
              if (edit.linkPageId !== undefined) {
                button.action = { type: "link", toPageId: edit.linkPageId };
              } else if (edit.spokenText !== undefined && !edit.linkPageId) {
                button.action = { type: "speak", text: edit.spokenText };
              }
            }
            break;
          }
        }
      }
    }
  
    // Step 4: Create new pages
    for (const pageSpec of update.newPages) {
      if (!newPages.find((p) => p.id === pageSpec.id)) {
        newPages.push({
          id: pageSpec.id,
          name: pageSpec.name,
          buttons: [],
          layout: currentBoard.grid,
        });
      }
    }
  
    // Step 5: Add new buttons to their respective pages
    for (const buttonSpec of update.newButtons) {
      const targetPage = newPages.find((p) => p.id === buttonSpec.pageId);
  
      if (!targetPage) {
        console.warn(
          `Page ${buttonSpec.pageId} not found, skipping button ${buttonSpec.label}`
        );
        continue;
      }
  
      const occupiedPositions = getOccupiedPositions(targetPage.buttons);
      const newButton = createButtonFromSpec(
        buttonSpec,
        currentBoard.grid,
        occupiedPositions
      );
  
      targetPage.buttons.push(newButton);
    }
  
    return { ...currentBoard, pages: newPages };
  }
  
  // ============================================================================
  // BOARD CONTEXT HELPERS
  // ============================================================================
  
  /**
   * Build a minimal context object for LLM board updates
   */
  export function buildBoardContext(
    board: ParsedBoardData,
    currentPageId: string
  ) {
    const page = board.pages.find((p) => p.id === currentPageId);
  
    return {
      boardName: board.name,
      gridSize: board.grid,
      currentPageId,
      currentPage: {
        name: page?.name || "Unknown",
        buttonCount: page?.buttons.length || 0,
        buttons:
          page?.buttons.map((b) => ({
            id: b.id,
            label: b.label,
            row: b.row,
            col: b.col,
          })) || [],
      },
      allPages: board.pages.map((p) => ({
        id: p.id,
        name: p.name,
        buttonCount: p.buttons.length,
      })),
    };
  }
  
  /**
   * Get the current page from a board
   */
  export function getCurrentPage(board: ParsedBoardData): BoardPage | undefined {
    if (!board.currentPageId) {
      return board.pages[0];
    }
    return board.pages.find((p) => p.id === board.currentPageId);
  }
  
  /**
   * Set the current page ID on a board
   */
  export function setCurrentPage(
    board: ParsedBoardData,
    pageId: string
  ): ParsedBoardData {
    const page = board.pages.find((p) => p.id === pageId);
    if (!page) {
      console.warn(`Page ${pageId} not found in board`);
      return board;
    }
    return { ...board, currentPageId: pageId };
  }
  
  // ============================================================================
  // VALIDATION
  // ============================================================================
  
  /**
   * Validate that a board has the required structure
   */
  export function validateBoard(board: any): board is ParsedBoardData {
    if (!board || typeof board !== "object") return false;
    if (typeof board.name !== "string") return false;
    if (!board.grid || typeof board.grid.rows !== "number" || typeof board.grid.cols !== "number") return false;
    if (!Array.isArray(board.pages)) return false;
    
    for (const page of board.pages) {
      if (!page.id || typeof page.id !== "string") return false;
      if (!page.name || typeof page.name !== "string") return false;
      if (!Array.isArray(page.buttons)) return false;
    }
    
    return true;
  }
  
  /**
   * Validate button spec has minimum required fields
   */
  export function validateButtonSpec(spec: any): spec is GeneratedButtonSpec {
    if (!spec || typeof spec !== "object") return false;
    if (typeof spec.label !== "string" || spec.label.length === 0) return false;
    return true;
  }