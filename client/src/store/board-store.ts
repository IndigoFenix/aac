// src/store/board-store.ts
import { create } from "zustand";
import { BoardIR, ButtonIR, PageIR, ActionIR } from "@/types/board-ir";

/**
 * Internal representation of a board inside the editor.
 * We extend the base BoardIR with a stable local ID and optional home flag.
 * This does NOT need to round‑trip to the backend – it is purely client state.
 */
type InternalBoard = BoardIR & {
  /** Local client-side id used for selection & ordering */
  _id: string;

  /** Database id from boards.id (if this board is saved on the backend) */
  dbId?: string;

  /** Whether this board is the "home" board in the workspace */
  isHome?: boolean;

  /** True once this board's IR has been loaded from the backend (via /api/board/:id) */
  loadedFromServer?: boolean;

  /** True when the board has local changes that are not yet saved */
  isDirty?: boolean;
};

const createId = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const toInternalBoard = (
  board: BoardIR,
  existing?: Partial<InternalBoard>
): InternalBoard => {
  const id = existing?._id ?? (board as any)._id ?? createId();

  const pages: PageIR[] = (board.pages || []).map((page, index) => ({
    ...page,
    id: page.id || `page-${Date.now()}-${index}`,
    buttons: page.buttons || [],
  }));

  return {
    ...board,
    pages,
    _id: id,
    isHome: existing?.isHome ?? (board as any).isHome ?? false,
  };
};

// Helper: strip internal fields before sending IR to backend
const stripInternalIrData = (board: InternalBoard): BoardIR => {
  const {
    _id,
    dbId,
    isHome,
    loadedFromServer,
    isDirty,
    ...irData
  } = board;
  return irData;
};

// Dummy hook: fires whenever a board is modified
const onBoardModified = (board: InternalBoard) => {
  // Replace this later with autosave / analytics / whatever you need.
  // For now it's just a debug log so you can see it being triggered.
  if (typeof window !== "undefined") {
    console.debug("[Board modified]", {
      dbId: board.dbId,
      name: board.name,
      isDirty: board.isDirty,
    });
  }
};

const findBoardById = (
  boards: InternalBoard[],
  id: string | null | undefined
): InternalBoard | null => {
  if (!id) return null;
  return boards.find((b) => b._id === id) ?? null;
};

export interface BoardState {
  // Active board for the canvas / exporters
  board: InternalBoard | null;

  // Multi‑board workspace
  boards: InternalBoard[];
  activeBoardId: string | null;
  homeBoardId: string | null;

  /**
   * Stack of page IDs used by "Jump to grid" / "Jump back" within the
   * currently active board.
   */
  navHistory: string[];

  /**
   * Optional page ID that "Jump back" prefers when set.
   */
  bookmarkPageId: string | null;

  currentPageId: string | null;
  selectedButtonId: string | null;
  isEditMode: boolean;
  validation: {
    isValid: boolean;
    errors: string[];
  };

  // Existing actions
  setBoard: (board: BoardIR) => void;
  updateBoard: (board: BoardIR) => void;
  setCurrentPage: (pageId: string) => void;
  selectButton: (buttonId: string | null) => void;
  setEditMode: (isEdit: boolean) => void;
  addPage: () => void;

  // page‑level management within a board
  renamePage: (pageId: string, name: string) => void;
  deletePage: (pageId: string) => void;
  reorderPages: (fromIndex: number, toIndex: number) => void;

  addButton: (button: Omit<ButtonIR, "id"> & { id?: string }) => void;
  updateButton: (buttonId: string, updates: Partial<ButtonIR>) => void;
  deleteButton: (buttonId: string) => void;
  duplicateButton: (buttonId: string) => void;

  // Board‑level management
  addEmptyBoard: (params: { name?: string; rows?: number; cols?: number }) => void;
  selectBoardById: (boardId: string) => void;
  reorderBoards: (fromIndex: number, toIndex: number) => void;
  deleteBoardById: (boardId: string) => void;
  setHomeBoard: (boardId: string) => void;
  appendGeneratedPages: (generated: BoardIR) => void;

  // Navigation helpers used by special button actions / debug (page‑level)
  jumpToPage: (pageId: string) => void;
  jumpHome: () => void;
  bookmarkCurrentPage: () => void;
  jumpBack: () => void;
  applyButtonAction: (buttonId: string) => void;
  /** Hydrate the boards list from the backend /api/boards (no irData included). */
  hydrateBoardsFromServer: (
    rows: { id: string; name: string }[]
  ) => void;

  /** Open a board fetched from /api/board/:id (with irData). */
  openBoardFromServer: (row: {
    id: string;
    name: string;
    irData: BoardIR;
  }) => void;

  /** Mark a board as saved, clear dirty flag, and store db id. */
  markBoardSaved: (dbId: string, name?: string) => void;
}


export const useBoardStore = create<BoardState>((set, get) => ({
  board: null as InternalBoard | null,
  boards: [],
  activeBoardId: null,
  homeBoardId: null,
  navHistory: [],
  bookmarkPageId: null,
  currentPageId: null,
  selectedButtonId: null,
  isEditMode: false,
  validation: {
    isValid: false,
    errors: [],
  },

  /**
   * Append the generated/imported board to the workspace and make it active.
   */
  setBoard: (rawBoard: BoardIR) => {
    set((state) => {
      const boardWithDefaultCover: BoardIR = {
        ...rawBoard,
        coverImage: rawBoard.coverImage || {
          symbolPath: "syntaacx_logo",
          backgroundColor: "#FFFFFFFF",
        },
      };
  
      // No dbId yet – this is a local board until saved
      const internal = toInternalBoard(boardWithDefaultCover) as InternalBoard;
      internal.isDirty = true;
      internal.loadedFromServer = false;
  
      const nextBoards = [...state.boards, internal];
  
      const isFirst = nextBoards.length === 1;
      const homeBoardId =
        state.homeBoardId ?? (isFirst ? internal._id : state.homeBoardId);
  
      const boardsWithHome = nextBoards.map((b) => ({
        ...b,
        isHome: b._id === homeBoardId,
      }));
  
      onBoardModified(internal);
  
      return {
        ...state,
        boards: boardsWithHome,
        board: internal,
        activeBoardId: internal._id,
        homeBoardId,
        currentPageId: internal.pages[0]?.id || null,
        selectedButtonId: null,
        navHistory: [],
        bookmarkPageId: null,
        validation: validateBoard(internal),
      };
    });
  },  

  updateBoard: (updated: BoardIR) => {
    set((state) => {
      if (!state.board || !state.activeBoardId) return state;
  
      const existing = state.boards.find(
        (b) => b._id === state.activeBoardId
      );
      if (!existing) return state;
  
      const boardWithCover: BoardIR = {
        ...updated,
        coverImage:
          updated.coverImage ||
          existing.coverImage || {
            symbolPath: "syntaacx_logo",
            backgroundColor: "#FFFFFFFF",
          },
      };
  
      const internal = toInternalBoard(boardWithCover, existing) as InternalBoard;
      internal.dbId = existing.dbId;
      internal.isHome = existing.isHome;
      internal.loadedFromServer = existing.loadedFromServer;
      internal.isDirty = true;
  
      const boards = state.boards.map((b) =>
        b._id === internal._id ? internal : b
      );
  
      onBoardModified(internal);
  
      return {
        ...state,
        board: internal,
        boards,
        validation: validateBoard(internal),
      };
    });
  },  

  setCurrentPage: (pageId: string) => {
    set({ currentPageId: pageId, selectedButtonId: null });
  },

  selectButton: (buttonId: string | null) => {
    set({ selectedButtonId: buttonId });
  },

  setEditMode: (isEdit: boolean) => {
    set({ isEditMode: isEdit });
  },

  addPage: () => {
    const { board, activeBoardId, boards } = get();
    if (!board || !activeBoardId) return;
  
    const newPage: PageIR = {
      id: `page-${Date.now()}`,
      name: `Page ${board.pages.length + 1}`,
      buttons: [],
      layout: board.grid,
    };
  
    const updatedBoard: InternalBoard = {
      ...(board as InternalBoard),
      pages: [...board.pages, newPage],
      isDirty: true,
    };
  
    const updatedBoards = boards.map((b) =>
      b._id === activeBoardId ? updatedBoard : b
    );
  
    onBoardModified(updatedBoard);
  
    set({
      board: updatedBoard,
      boards: updatedBoards,
      currentPageId: newPage.id,
      selectedButtonId: null,
      validation: validateBoard(updatedBoard),
    });
  },

  renamePage: (pageId: string, name: string) => {
    const { board, activeBoardId, boards } = get();
    if (!board || !activeBoardId) return;

    const updatedBoard: InternalBoard = {
      ...board,
      pages: board.pages.map((page) =>
        page.id === pageId ? { ...page, name } : page
      ),
    };

    const updatedBoards = boards.map((b) =>
      b._id === activeBoardId ? updatedBoard : b
    );

    set({
      board: updatedBoard,
      boards: updatedBoards,
      validation: validateBoard(updatedBoard),
    });
  },

  deletePage: (pageId: string) => {
    const { board, activeBoardId, boards, currentPageId } = get();
    if (!board || !activeBoardId) return;

    // Do not allow deleting the last remaining page
    if (board.pages.length <= 1) {
      return;
    }

    const pageIndex = board.pages.findIndex((p) => p.id === pageId);
    if (pageIndex === -1) return;

    const newPages = board.pages.filter((p) => p.id !== pageId);

    const updatedBoard: InternalBoard = {
      ...board,
      pages: newPages,
    };

    // Decide what becomes the current page
    let nextCurrentPageId: string | null = currentPageId;

    if (!newPages.length) {
      nextCurrentPageId = null;
    } else if (!currentPageId || currentPageId === pageId) {
      const fallbackIndex = Math.min(pageIndex, newPages.length - 1);
      nextCurrentPageId = newPages[fallbackIndex].id;
    } else if (!newPages.some((p) => p.id === currentPageId)) {
      nextCurrentPageId = newPages[0].id;
    }

    const updatedBoards = boards.map((b) =>
      b._id === activeBoardId ? updatedBoard : b
    );

    set({
      board: updatedBoard,
      boards: updatedBoards,
      currentPageId: nextCurrentPageId,
      selectedButtonId: null,
      validation: validateBoard(updatedBoard),
    });
  },

  reorderPages: (fromIndex: number, toIndex: number) => {
    const { board, activeBoardId, boards, currentPageId } = get();
    if (!board || !activeBoardId) return;

    const pageCount = board.pages.length;
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= pageCount ||
      toIndex >= pageCount
    ) {
      return;
    }

    const pages = [...board.pages];
    const [moved] = pages.splice(fromIndex, 1);
    pages.splice(toIndex, 0, moved);

    const updatedBoard: InternalBoard = {
      ...board,
      pages,
    };

    const updatedBoards = boards.map((b) =>
      b._id === activeBoardId ? updatedBoard : b
    );

    const stillExists = pages.some((p) => p.id === currentPageId);
    const nextCurrentPageId =
      stillExists && currentPageId ? currentPageId : pages[0]?.id ?? null;

    set({
      board: updatedBoard,
      boards: updatedBoards,
      currentPageId: nextCurrentPageId,
      validation: validateBoard(updatedBoard),
    });
  },

  addButton: (buttonData) => {
    const { board, currentPageId, activeBoardId, boards } = get();
    if (!board || !currentPageId || !activeBoardId) return;
  
    const newButton: ButtonIR = {
      ...buttonData,
      id: buttonData.id ?? `btn-${Date.now()}`,
    };
  
    const updatedBoard: InternalBoard = {
      ...(board as InternalBoard),
      pages: board.pages.map((page) =>
        page.id === currentPageId
          ? { ...page, buttons: [...page.buttons, newButton] }
          : page
      ),
      isDirty: true,
    };
  
    const updatedBoards = boards.map((b) =>
      b._id === activeBoardId ? updatedBoard : b
    );
  
    onBoardModified(updatedBoard);
  
    set({
      board: updatedBoard,
      boards: updatedBoards,
      selectedButtonId: newButton.id,
      validation: validateBoard(updatedBoard),
    });
  },  

  updateButton: (buttonId: string, updates: Partial<ButtonIR>) => {
    const { board, activeBoardId, boards } = get();
    if (!board || !activeBoardId) return;

    const updatedBoard: InternalBoard = {
      ...(board as InternalBoard),
      pages: board.pages.map((page) => ({
        ...page,
        buttons: page.buttons.map((button) =>
          button.id === buttonId ? { ...button, ...updates } : button
        ),
      })),
      isDirty: true,
    };

    const updatedBoards = boards.map((b) =>
      b._id === activeBoardId ? updatedBoard : b
    );

    onBoardModified(updatedBoard);

    set({
      board: updatedBoard,
      boards: updatedBoards,
      validation: validateBoard(updatedBoard),
    });
  },

  deleteButton: (buttonId: string) => {
    const { board, activeBoardId, boards } = get();
    if (!board || !activeBoardId) return;

    const updatedBoard: InternalBoard = {
      ...(board as InternalBoard),
      pages: board.pages.map((page) => ({
        ...page,
        buttons: page.buttons.filter((button) => button.id !== buttonId),
      })),
      isDirty: true,
    };

    const updatedBoards = boards.map((b) =>
      b._id === activeBoardId ? updatedBoard : b
    );

    onBoardModified(updatedBoard);

    set({
      board: updatedBoard,
      boards: updatedBoards,
      selectedButtonId: null,
      validation: validateBoard(updatedBoard),
    });
  },

  duplicateButton: (buttonId: string) => {
    const { board, currentPageId } = get();
    if (!board || !currentPageId) return;

    let buttonToDuplicate: ButtonIR | undefined;

    // Find the button to duplicate
    board.pages.forEach((page: any) => {
      const button = page.buttons.find((b: any) => b.id === buttonId);
      if (button) {
        buttonToDuplicate = button;
      }
    });

    if (!buttonToDuplicate) return;

    // Find an empty position on the current page
    const currentPage = board.pages.find(
      (p: any) => p.id === currentPageId
    );
    if (!currentPage) return;

    let newRow = buttonToDuplicate.row;
    let newCol = buttonToDuplicate.col + 1;

    while (newRow < board.grid.rows) {
      while (newCol < board.grid.cols) {
        const occupied = currentPage.buttons.some(
          (b: any) => b.row === newRow && b.col === newCol
        );
        if (!occupied) {
          break;
        }
        newCol++;
      }
      if (newCol < board.grid.cols) break;
      newRow++;
      newCol = 0;
    }

    if (newRow >= board.grid.rows) {
      // No empty position found
      return;
    }

    const duplicatedButton: ButtonIR = {
      ...buttonToDuplicate,
      id: `btn-${Date.now()}`,
      row: newRow,
      col: newCol,
      label: `${buttonToDuplicate.label} Copy`,
    };

    get().addButton(duplicatedButton);
  },

  // ---- Board‑set management ----

  addEmptyBoard: ({ name, rows = 4, cols = 4 }) => {
    set((state) => {
      const baseName =
        (name || "").trim() || `Board ${state.boards.length + 1}`;
  
      const firstPage: PageIR = {
        id: `page-${Date.now()}`,
        name: "Page 1",
        buttons: [],
        layout: { rows, cols },
      };
  
      const internal: InternalBoard = {
        name: baseName,
        grid: { rows, cols },
        pages: [firstPage],
        _id: createId(),
        isHome: false,
        assets: {},
        coverImage: {
          symbolPath: "syntaacx_logo",
          backgroundColor: "#FFFFFFFF",
        },
      };
  
      const nextBoards = [...state.boards, internal];
      const isFirst = nextBoards.length === 1;
      const homeBoardId =
        state.homeBoardId ?? (isFirst ? internal._id : state.homeBoardId);
  
      const boardsWithHome = nextBoards.map((b) => ({
        ...b,
        isHome: b._id === homeBoardId,
      }));
  
      return {
        ...state,
        boards: boardsWithHome,
        board: internal,
        activeBoardId: internal._id,
        homeBoardId,
        currentPageId: firstPage.id,
        selectedButtonId: null,
        navHistory: [],
        bookmarkPageId: null,
        validation: validateBoard(internal),
      };
    });
  },
  

  selectBoardById: (boardId: string) => {
    set((state) => {
      const target = findBoardById(state.boards, boardId);
      if (!target) return state;
  
      return {
        ...state,
        board: target,
        activeBoardId: target._id,
        currentPageId: target.pages[0]?.id || null,
        selectedButtonId: null,
        navHistory: [],
        bookmarkPageId: null,
        validation: validateBoard(target),
      };
    });
  },
  

  reorderBoards: (fromIndex: number, toIndex: number) => {
    set((state) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= state.boards.length ||
        toIndex >= state.boards.length
      ) {
        return state;
      }

      const boards = [...state.boards];
      const [moved] = boards.splice(fromIndex, 1);
      boards.splice(toIndex, 0, moved);

      // Preserve home flag via homeBoardId
      const boardsWithHome = boards.map((b) => ({
        ...b,
        isHome: b._id === state.homeBoardId,
      }));

      return {
        ...state,
        boards: boardsWithHome,
      };
    });
  },

  deleteBoardById: (boardId: string) => {
    set((state) => {
      const remaining = state.boards.filter((b) => b._id !== boardId);
      const activeRemoved = state.activeBoardId === boardId;
      const homeRemoved = state.homeBoardId === boardId;
  
      const nextActive =
        activeRemoved ? remaining[0]?._id ?? null : state.activeBoardId;
      const nextHome =
        homeRemoved ? remaining[0]?._id ?? null : state.homeBoardId;
  
      const boardsWithHome = remaining.map((b) => ({
        ...b,
        isHome: b._id === nextHome,
      }));
  
      const nextBoard = findBoardById(boardsWithHome, nextActive);
  
      return {
        ...state,
        boards: boardsWithHome,
        board: nextBoard,
        activeBoardId: nextActive,
        homeBoardId: nextHome,
        bookmarkPageId: null,
        navHistory: [],
        currentPageId: nextBoard?.pages[0]?.id || null,
        selectedButtonId: null,
        validation: nextBoard
          ? validateBoard(nextBoard)
          : { isValid: false, errors: ["No board loaded"] },
      };
    });
  },
  

  setHomeBoard: (boardId: string) => {
    set((state) => {
      const target = findBoardById(state.boards, boardId);
      if (!target) return state;

      const boardsWithHome = state.boards.map((b) => ({
        ...b,
        isHome: b._id === boardId,
      }));

      return {
        ...state,
        boards: boardsWithHome,
        homeBoardId: boardId,
      };
    });
  },

  // ---- Navigation helpers (page‑level within the active board) ----

  jumpToPage: (pageId: string) => {
    set((state) => {
      const board = state.board;
      if (!board) return state;

      const pageExists = board.pages.some((p) => p.id === pageId);
      if (!pageExists || state.currentPageId === pageId) {
        return state;
      }

      const navHistory =
        state.currentPageId != null
          ? [...state.navHistory, state.currentPageId]
          : state.navHistory;

      return {
        ...state,
        currentPageId: pageId,
        selectedButtonId: null,
        navHistory,
      };
    });
  },

  jumpHome: () => {
    set((state) => {
      const board = state.board;
      if (!board || !board.pages.length) return state;

      // For now, "home page" = first page in the board
      const homePageId = board.pages[0]?.id;
      if (!homePageId || state.currentPageId === homePageId) {
        return state;
      }

      return {
        ...state,
        currentPageId: homePageId,
        selectedButtonId: null,
      };
    });
  },

  bookmarkCurrentPage: () => {
    const { currentPageId } = get();
    if (!currentPageId) return;
    set({ bookmarkPageId: currentPageId });
  },

  jumpBack: () => {
    set((state) => {
      const board = state.board;
      if (!board) return state;

      // Prefer explicit bookmark if set
      if (state.bookmarkPageId) {
        const hasBookmark = board.pages.some(
          (p) => p.id === state.bookmarkPageId
        );
        if (!hasBookmark || state.currentPageId === state.bookmarkPageId) {
          return state;
        }
        return {
          ...state,
          currentPageId: state.bookmarkPageId,
          selectedButtonId: null,
        };
      }

      // Otherwise pop navigation history
      const history = [...state.navHistory];
      let targetPageId: string | null = null;

      while (history.length) {
        const candidate = history.pop() as string;
        const exists = board.pages.some((p) => p.id === candidate);
        if (exists && candidate !== state.currentPageId) {
          targetPageId = candidate;
          break;
        }
      }

      if (!targetPageId) {
        return {
          ...state,
          navHistory: history,
        };
      }

      return {
        ...state,
        currentPageId: targetPageId,
        selectedButtonId: null,
        navHistory: history,
      };
    });
  },


  appendGeneratedPages: (generated: BoardIR) => {
    set((state) => {
      const active =
        findBoardById(state.boards, state.activeBoardId) ?? state.board;
      if (!active) return state;
  
      const existingIds = new Set((active.pages || []).map((p) => p.id));
      const stamp = Date.now().toString(36);
  
      const newPages: PageIR[] = (generated.pages || []).map((page, pageIndex) => {
        let id = page.id;
        if (!id || existingIds.has(id)) {
          id = `page-${stamp}-${pageIndex}`;
        }
        existingIds.add(id);
  
        const buttons = (page.buttons || []).map((button, buttonIndex) => ({
          ...button,
          id: button.id ?? `btn-${stamp}-${pageIndex}-${buttonIndex}`,
        }));
  
        return {
          ...page,
          id,
          buttons,
          // Snap the new page to the active board's grid by default
          layout: page.layout || active.grid,
        };
      });
  
      if (!newPages.length) return state;
  
      const updatedBoard: InternalBoard = {
        ...active,
        pages: [...(active.pages || []), ...newPages],
        isDirty: true,
      };
  
      const updatedBoards = state.boards.map((b) =>
        b._id === updatedBoard._id ? updatedBoard : b
      );

      onBoardModified(updatedBoard);
  
      return {
        ...state,
        board: updatedBoard,
        boards: updatedBoards,
        currentPageId: newPages[0].id,
        selectedButtonId: null,
        validation: validateBoard(updatedBoard),
      };
    });
  },
  

  applyButtonAction: (buttonId: string) => {
    const { board, currentPageId } = get();
    if (!board) return;
  
    let targetButton: ButtonIR | undefined;
  
    // Prefer current page, then fall back to any page
    const currentPage = board.pages.find((p) => p.id === currentPageId);
    if (currentPage) {
      targetButton = currentPage.buttons.find((b) => b.id === buttonId);
    }
    if (!targetButton) {
      for (const page of board.pages) {
        const found = page.buttons.find((b) => b.id === buttonId);
        if (found) {
          targetButton = found;
          break;
        }
      }
    }
  
    if (!targetButton || !targetButton.action) return;
    const action: ActionIR = targetButton.action;
  
    switch (action.type) {
      case "link":
        if (action.toPageId) {
          get().jumpToPage(action.toPageId);
        }
        break;
      case "back":
        get().jumpBack();
        break;
      case "bookmark":
        get().bookmarkCurrentPage();
        break;
      case "home":
        get().jumpHome();
        break;
      case "speak":
      case "youtube":
        // Handled at runtime/export – no navigation here
        break;
      default:
        break;
    }
  
    // Self‑closing buttons automatically jump back after their primary action,
    // except when the primary action *is* the "back" action itself.
    if ((targetButton as any).selfClosing && action.type !== "back") {
      get().jumpBack();
    }
  },

  hydrateBoardsFromServer: (rows) => {
    set((state) => {
      // Index existing boards that already have a dbId
      const existingByDbId = new Map(
        state.boards
          .filter((b) => b.dbId)
          .map((b) => [b.dbId as string, b])
      );
  
      // Convert backend rows into InternalBoard stubs (no pages yet)
      const hydrated: InternalBoard[] = rows.map((row) => {
        const existing = existingByDbId.get(row.id);
        if (existing) {
          // Keep IR and flags, just refresh name
          return {
            ...existing,
            name: row.name,
          };
        }
  
        // New stub board – we’ll fetch full irData when the user opens it
        return {
          _id: createId(),
          dbId: row.id,
          name: row.name,
          grid: { rows: 0, cols: 0 },
          pages: [],
          assets: {},
          coverImage: {
            symbolPath: "syntaacx_logo",
            backgroundColor: "#FFFFFFFF",
          },
          isHome: false,
          loadedFromServer: false,
          isDirty: false,
        };
      });
  
      // Keep any purely local boards that do not have a dbId yet
      const localOnly = state.boards.filter((b) => !b.dbId);
  
      return {
        ...state,
        boards: [...hydrated, ...localOnly],
      };
    });
  },

  openBoardFromServer: (row) => {
    set((state) => {
      const { id, name, irData } = row;
  
      const existing = state.boards.find((b) => b.dbId === id);
  
      const base: InternalBoard =
        existing ??
        ({
          _id: createId(),
          dbId: id,
          isHome: false,
          loadedFromServer: false,
          isDirty: false,
          assets: {},
        } as InternalBoard);
  
      // Use your existing helper to normalize page/button ids, etc.
      const internal = toInternalBoard(
        {
          ...irData,
          name: irData.name || name,
        },
        base
      ) as InternalBoard;
  
      internal.dbId = id;
      internal.loadedFromServer = true;
      internal.isDirty = false;
  
      const boards = existing
        ? state.boards.map((b) =>
            b._id === internal._id ? internal : b
          )
        : [...state.boards, internal];
  
      return {
        ...state,
        boards,
        board: internal,
        activeBoardId: internal._id,
        currentPageId: internal.pages[0]?.id || null,
        selectedButtonId: null,
        validation: validateBoard(internal),
      };
    });
  },

  markBoardSaved: (dbId, name) => {
    set((state) => {
      const boards = state.boards.map((b) => {
        if (b.dbId === dbId || b._id === dbId) {
          const updated: InternalBoard = {
            ...b,
            dbId,
            name: name ?? b.name,
            isDirty: false,
          };
          return updated;
        }
        return b;
      });
  
      const active =
        state.board &&
        boards.find((b) => b._id === state.board!._id);
  
      return {
        ...state,
        boards,
        board: active ?? state.board,
      };
    });
  },
  
  
}));

// Computed selector for selected button (unchanged API)
export const useSelectedButton = () => {
  return useBoardStore((state) => {
    if (!state.board || !state.selectedButtonId) return null;

    for (const page of state.board.pages) {
      const button = page.buttons.find(
        (b: any) => b.id === state.selectedButtonId
      );
      if (button) return button;
    }
    return null;
  });
};

// Board validation function (kept close to the original behaviour)
function validateBoard(board: BoardIR): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!board.name.trim()) {
    errors.push("Board name is required");
  }

  if (!board.pages || board.pages.length === 0) {
    errors.push("Board must have at least one page");
  }

  (board.pages || []).forEach((page, pageIndex) => {
    if (!page.name.trim()) {
      errors.push(`Page ${pageIndex + 1} name is required`);
    }

    (page.buttons || []).forEach((button, buttonIndex) => {
      if (!button.label.trim()) {
        errors.push(
          `Button ${buttonIndex + 1} on page ${pageIndex + 1} must have a label`
        );
      }

      if (button.row < 0 || button.row >= board.grid.rows) {
        errors.push(`Button "${button.label}" row is out of bounds`);
      }

      if (button.col < 0 || button.col >= board.grid.cols) {
        errors.push(`Button "${button.label}" column is out of bounds`);
      }
    });

    // Check for overlapping buttons
    const positions = (page.buttons || []).map(
      (b) => `${b.row}-${b.col}`
    );
    const uniquePositions = new Set(positions);
    if (positions.length !== uniquePositions.size) {
      errors.push(`Page ${pageIndex + 1} has overlapping buttons`);
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
}
