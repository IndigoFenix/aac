import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Grid3X3, Loader2 } from "lucide-react";
import type { ParsedBoardData, BoardButton } from "@shared/schema";
import { useBoards, type BoardData } from "@/contexts/BoardsContext";
import { useLanguage } from "@/contexts/LanguageContext";
import DynamicBoard from "@/components/DynamicBoard";
import { minRestSpace, type RestSpace } from "@shared/button-shape";

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
  /** Gate the board's corner rest space — pointless without a gaze gesture. */
  eyegazeEnabled?: boolean;
  /** The student's own rest-space preference; a board may narrow it, not widen it. */
  studentRestSpace?: RestSpace;
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
  eyegazeEnabled = false,
  studentRestSpace = "large",
}: PrebuiltBoardSectionProps) {
  const { t } = useLanguage();
  const [selectedBoard, setSelectedBoard] = useState<BoardData | null>(null);

  // Boards are pre-fetched during initialization.
  const { boards, isLoading } = useBoards();

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
        <div className="flex-1 overflow-y-auto p-2">
          <div className="grid grid-cols-2 gap-2">
            {boards
              .filter((b) => b.irData)
              .map((board) => (
                <motion.button
                  key={board.id}
                  onClick={() => setSelectedBoard(board)}
                  className="flex flex-col items-center justify-center p-3 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Grid3X3 className="w-8 h-8 text-primary mb-2" />
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200 text-center">
                    {board.name}
                  </span>
                </motion.button>
              ))}
          </div>
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
        // A static board may ask for LESS corner space than the student's
        // preference — smaller buttons, learned layout — but never for more:
        // the student setting is an accessibility need, not a default.
        restSpace={
          eyegazeEnabled
            ? minRestSpace(studentRestSpace, (selectedBoard as { restSpace?: string }).restSpace)
            : "none"
        }
        onNavigateToBoard={(boardId) => {
          const target = boards.find((b) => b.id === boardId);
          if (target) setSelectedBoard(target);
        }}
      />
    </div>
  );
}
