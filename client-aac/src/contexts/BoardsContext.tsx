import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppInitializationOptional } from "./AppInitializationContext";

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
  label: string;
  spokenText?: string;
  color?: string;
  iconRef?: string;
  symbolPath?: string;
  action?: {
    type: "speak" | "link" | "back" | "home";
    text?: string;
    toPageId?: string;
  };
}

export interface BoardData {
  id: string;
  name: string;
  irData: BoardIR;
}

interface BoardsContextType {
  boards: BoardData[];
  isLoading: boolean;
  error: string | null;
  selectedBoard: BoardData | null;
  selectBoard: (board: BoardData | null) => void;
  refetch: () => Promise<void>;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, queryError, studentId]);

  const selectBoard = useCallback((board: BoardData | null) => {
    setSelectedBoard(board);
  }, []);

  const refetch = useCallback(async () => {
    await queryRefetch();
  }, [queryRefetch]);

  const value: BoardsContextType = {
    boards,
    isLoading,
    error,
    selectedBoard,
    selectBoard,
    refetch,
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
