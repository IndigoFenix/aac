import { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { Grid3X3, Loader2 } from "lucide-react";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { useBoards, type BoardData } from "@/contexts/BoardsContext";
import { useLanguage } from "@/contexts/LanguageContext";
import DynamicBoard from "@/components/DynamicBoard";
import type { RestSpace } from "@shared/button-shape";
import type { SelectionMethod } from "@/contexts/EyeTrackingDwellContext";

// Clinician-built ("prebuilt") boards loaded for the student. This component is
// just the board PICKER + a host for the canonical renderer: once a board is
// chosen it renders through <DynamicBoard />, the same grid/button renderer the
// AI dynamic boards use. That gives prebuilt boards full glyph / face / custom-
// symbol rendering, the student's icon-text ratio, page navigation, and (new)
// board-to-board navigation — none of which the old bespoke renderer had.

interface PrebuiltBoardSectionProps {
  studentId: string;
  onSpeakAction: (text: string) => void;
  language?: string;
  voiceType?: string;
  onBack: () => void;
  /** When true, skip local speechSynthesis — let the AI handle speech. */
  suppressLocalSpeech?: boolean;
  /** Resolve a contact face image from client-side cache (for face: buttons). */
  getFaceImage?: (contactId: string) => string | null;
  /** Icon-to-text size ratio 1–5 (student preference), forwarded to the board. */
  iconTextRatio?: number;
  /**
   * The two eyegaze display settings, resolved by the caller exactly as they
   * are for AI boards — a clinician-built board is the same renderer showing
   * the same student's buttons, so it must not read differently under gaze.
   */
  selectionMethod?: SelectionMethod;
  restSpace?: RestSpace;
}

export default function PrebuiltBoardSection({
  studentId,
  onSpeakAction,
  language = "en",
  voiceType,
  onBack,
  suppressLocalSpeech = false,
  getFaceImage,
  iconTextRatio = 3,
  selectionMethod = "whole_button",
  restSpace = "none",
}: PrebuiltBoardSectionProps) {
  const { t } = useLanguage();
  const [selectedBoard, setSelectedBoard] = useState<BoardData | null>(null);

  // The LIST is metadata only — IR is fetched when a board is actually opened.
  const { boards, isLoading, loadBoard, loadingBoardId } = useBoards();

  const openBoard = useCallback(
    async (boardId: string) => {
      const full = await loadBoard(boardId);
      if (full?.irData) setSelectedBoard(full);
    },
    [loadBoard],
  );

  // Own boards first (no heading), then one group per package, in name order.
  const groupedBoards = useMemo(() => {
    const own = boards.filter((b) => !b.packageName);
    const byPackage = new Map<string, BoardData[]>();
    for (const board of boards) {
      if (!board.packageName) continue;
      const list = byPackage.get(board.packageName) ?? [];
      list.push(board);
      byPackage.set(board.packageName, list);
    }
    // With only one source there is nothing to distinguish — skip the heading.
    const onlyOneSource = byPackage.size === 0 || (own.length === 0 && byPackage.size === 1);
    const groups: Array<{ label: string | null; items: BoardData[] }> = [];
    if (own.length) groups.push({ label: null, items: own });
    for (const [label, items] of [...byPackage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      groups.push({ label: onlyOneSource ? null : label, items });
    }
    return groups;
  }, [boards]);

  // Back: leave the open board (return to the picker); at the picker root, defer
  // to the parent. Within-board page navigation is owned by <DynamicBoard />.
  const goBack = useCallback(() => {
    if (selectedBoard) setSelectedBoard(null);
    else onBack();
  }, [selectedBoard, onBack]);

  // Expose goBack so the global Quick Actions "Back" button can drive it.
  useEffect(() => {
    (window as any).__prebuiltBoardGoBack = goBack;
    return () => {
      delete (window as any).__prebuiltBoardGoBack;
    };
  }, [goBack]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!boards || boards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 p-4">
        <Grid3X3 className="w-8 h-8 mb-2" />
        <p className="text-sm text-center">{t("board.noBoards")}</p>
        <p className="text-xs text-center mt-1">{t("board.createInAdmin")}</p>
      </div>
    );
  }

  // Board picker.
  if (!selectedBoard) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-2 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("board.selectBoard")}</h3>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {/* Grouped by source once more than one contributes, so a student with
              several attached packages isn't facing 40 undifferentiated tiles. */}
          {groupedBoards.map(({ label, items }) => (
            <div key={label ?? "__own__"}>
              {label && (
                <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 px-1 pb-1">
                  {label}
                </h4>
              )}
              <div className="grid grid-cols-2 gap-2">
                {items.map((board) => (
                  <motion.button
                    key={board.id}
                    onClick={() => void openBoard(board.id)}
                    disabled={loadingBoardId !== null}
                    className="flex flex-col items-center justify-center p-3 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm disabled:opacity-60"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    {loadingBoardId === board.id ? (
                      <Loader2 className="w-8 h-8 text-primary mb-2 animate-spin" />
                    ) : (
                      <Grid3X3 className="w-8 h-8 text-primary mb-2" />
                    )}
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200 text-center">
                      {board.name}
                    </span>
                  </motion.button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Selected board → canonical renderer.
  return (
    <div className="h-full flex flex-col min-h-0">
      <DynamicBoard
        board={selectedBoard.irData as unknown as ParsedBoardData}
        onButtonClick={(_button: BoardButton, text: string) => onSpeakAction(text)}
        onBack={() => setSelectedBoard(null)}
        language={language}
        voiceType={voiceType}
        iconTextRatio={iconTextRatio}
        getFaceImage={getFaceImage}
        suppressLocalSpeech={suppressLocalSpeech}
        // Straight from AAC Settings, same as an AI board — see the prop docs.
        selectionMethod={selectionMethod}
        restSpace={restSpace}
        // Board-to-board links: the target's IR may not be loaded yet, so go
        // through the same lazy path rather than the metadata list.
        onNavigateToBoard={(boardId) => void openBoard(boardId)}
      />
    </div>
  );
}
