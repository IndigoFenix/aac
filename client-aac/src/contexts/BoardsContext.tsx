import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppInitializationOptional } from "./AppInitializationContext";
import { apiUrl } from "@/lib/queryClient";

// Board data types (matching PrebuiltBoardSection)
interface BoardIR {
  name: string;
  grid: { rows: number; cols: number };
  pages: PageIR[];
}

interface PageIR {
  id: string;
  name: string;
  buttons: ButtonIR[];
  layout?: { rows: number; cols: number };
}

interface ButtonIR {
  id: string;
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  label: string;
  spokenText?: string;
  color?: string;
  iconRef?: string;
  symbolPath?: string;
  action?: {
    type: "speak" | "link" | "back" | "home" | "exit" | "open_website";
    text?: string;
    toPageId?: string;
    url?: string;
    label?: string;
  };
}

export interface BoardData {
  id: string;
  name: string;
  /**
   * Absent in the LIST response — `/api/boards/student/:id` returns metadata
   * only, deliberately (a student can have many boards, and each irData is
   * large). Call `loadBoard(id)` to fill it in on demand.
   */
  irData?: BoardIR;
  /** Set when the board comes from an attached package; groups the picker. */
  packageName?: string;
  /**
   * The board author's corner-rest preference. Present in BOTH the list
   * metadata and the full board, and carried through `loadBoard` — dropping it
   * silently normalizes to `"small"` in `minRestSpace`, biting a corner out of
   * every button on a board whose clinician asked for none.
   */
  restSpace?: string;
}

interface BoardsContextType {
  boards: BoardData[];
  isLoading: boolean;
  error: string | null;
  selectedBoard: BoardData | null;
  selectBoard: (board: BoardData | null) => void;
  refetch: () => Promise<void>;
  /** Fetch (and cache) a board's full IR. Returns null when it cannot be loaded. */
  loadBoard: (boardId: string) => Promise<BoardData | null>;
  /** True while a specific board's IR is being fetched. */
  loadingBoardId: string | null;
}

const BoardsContext = createContext<BoardsContextType | undefined>(undefined);

interface BoardsProviderProps {
  children: ReactNode;
  studentId: string;
}

export function BoardsProvider({ children, studentId }: BoardsProviderProps) {
  const [selectedBoard, setSelectedBoard] = useState<BoardData | null>(null);
  const queryClient = useQueryClient();

  // Use optional initialization context (returns null if not inside provider)
  const initContext = useAppInitializationOptional();

  // Fetch boards using React Query
  const {
    data: boards = [],
    isLoading,
    error: queryError,
    refetch: queryRefetch,
  } = useQuery<BoardData[]>({
    queryKey: ["/api/boards/student", studentId],
    enabled: !!studentId,
  });

  const error = queryError ? (queryError as Error).message : null;

  // Report initialization status - use a single ref to track state
  const initStateRef = useRef<'idle' | 'started' | 'done'>('idle');
  useEffect(() => {
    if (!initContext || !studentId || initStateRef.current === 'done') return;

    if (initStateRef.current === 'idle') {
      // Start the task
      initContext.startTask('boards');
      initStateRef.current = 'started';
    }

    // Report completion/failure once loading is done
    if (!isLoading && initStateRef.current === 'started') {
      if (queryError) {
        initContext.failTask('boards', (queryError as Error).message || 'Failed to load boards');
      } else {
        initContext.completeTask('boards');
      }
      initStateRef.current = 'done';
    }
     
  }, [isLoading, queryError, studentId]);

  const selectBoard = useCallback((board: BoardData | null) => {
    setSelectedBoard(board);
  }, []);

  const refetch = useCallback(async () => {
    await queryRefetch();
  }, [queryRefetch]);

  // IR cache, keyed by board id. Boards are immutable for the length of a
  // session in practice, and re-fetching a large IR on every back-navigation
  // would be felt on a tablet.
  const irCacheRef = useRef<Map<string, BoardData>>(new Map());
  const [loadingBoardId, setLoadingBoardId] = useState<string | null>(null);

  const loadBoard = useCallback(
    async (boardId: string): Promise<BoardData | null> => {
      const cached = irCacheRef.current.get(boardId);
      if (cached) return cached;

      const meta = boards.find((b) => b.id === boardId);
      setLoadingBoardId(boardId);
      try {
        // `studentId` lets the server authorise a PACKAGE board the device did
        // not author — see canReadPackageBoard in boardController.
        const res = await fetch(
          apiUrl(`/api/boards/${boardId}?studentId=${encodeURIComponent(studentId)}`),
          { credentials: "include" },
        );
        if (!res.ok) return null;
        const full = (await res.json()) as {
          id: string;
          name: string;
          irData: BoardIR;
          restSpace?: string | null;
        };
        const merged: BoardData = {
          id: full.id,
          name: full.name ?? meta?.name ?? "",
          irData: full.irData,
          packageName: meta?.packageName,
          restSpace: full.restSpace ?? meta?.restSpace,
        };
        irCacheRef.current.set(boardId, merged);
        return merged;
      } catch {
        return null;
      } finally {
        setLoadingBoardId(null);
      }
    },
    [boards, studentId],
  );

  // A board list refresh invalidates cached IR (a clinician may have edited).
  useEffect(() => {
    irCacheRef.current.clear();
  }, [boards]);

  const value: BoardsContextType = {
    boards,
    isLoading,
    error,
    selectedBoard,
    selectBoard,
    refetch,
    loadBoard,
    loadingBoardId,
  };

  return (
    <BoardsContext.Provider value={value}>
      {children}
    </BoardsContext.Provider>
  );
}

export function useBoards(): BoardsContextType {
  const context = useContext(BoardsContext);
  if (context === undefined) {
    throw new Error('useBoards must be used within a BoardsProvider');
  }
  return context;
}

// Re-export types for consumers
export type { BoardIR, PageIR, ButtonIR };
