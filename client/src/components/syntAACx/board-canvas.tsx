// src/components/syntAACx/board-canvas.tsx

import { useBoardStore } from "@/store/board-store";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  ZoomIn,
  ZoomOut,
  ListTree,
  Trash2,
  ArrowUp,
  ArrowDown,
  Volume2,
  Play,
} from "lucide-react";
import { useState, useRef } from "react";
import { cn } from "@/lib/utils";
import { CoverImageSelector } from "./cover-image-selector";
import { YouTubePlayer } from "./youtube-player";
import { BoardIR } from "@/types/board-ir";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useSound } from "@/contexts/SoundContext";
import { useToast } from "@/hooks/use-toast";
import { pageGrid, fitGrid } from "@shared/board-grid";
import { BoardButtonVisual } from "@client-shared/board/BoardButtonVisual";
import { resolveBorderClass } from "@shared/button-color";
import { useClinicianBoardDeps, irToButtonInput } from "./use-clinician-board-deps";

/** Rows/columns a page's grid may be set to. 1 is legal: a single big button
 *  is a real board for an early communicator. */
const GRID_AXIS_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

export function BoardCanvas() {
  const { t, isRTL, language } = useLanguage();
  const { theme } = useTheme();
  const { speakText, isSpeaking } = useSound();
  const { toast } = useToast();
  const isDark = theme === "dark";

  const {
    board,
    currentPageId,
    setCurrentPage,
    selectedButtonId,
    selectButton,
    addPage,
    isEditMode,
    updateBoard,
    addButton,
    renamePage,
    deletePage,
    reorderPages,
  } = useBoardStore();

  const [zoom, setZoom] = useState(100);
  const [isManagePagesOpen, setIsManagePagesOpen] = useState(false);
  const [activeVideo, setActiveVideo] = useState<{
    videoId: string;
    title: string;
  } | null>(null);
  const [spokenText, setSpokenText] = useState<string | null>(null);
  
  const canvasRef = useRef<HTMLDivElement>(null);

  // Clinician render deps for the shared <BoardButtonVisual /> (icon chain +
  // Glyph wrapper), shared with the button inspector's preview.
  const clinicianDeps = useClinicianBoardDeps();

  if (!board) {
    return (
      <div className={cn(
        "flex-1 min-w-0 min-h-0 flex flex-col",
        isDark ? "bg-slate-950" : "bg-gray-100"
      )}>
        <div className="flex-1 flex items-center justify-center">
          <div className={cn(
            "text-center",
            isDark ? "text-slate-500" : "text-gray-500"
          )}>
            <div className={cn(
              "w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4",
              isDark ? "bg-slate-800/50" : "bg-gray-200"
            )}>
              <span className="text-3xl">📝</span>
            </div>
            <h3 className={cn(
              "text-lg font-medium mb-2",
              isDark ? "text-slate-300" : "text-gray-700"
            )}>
              {t("board.noBoardYet")}
            </h3>
            <p className={cn(
              "text-sm max-w-xs",
              isDark ? "text-slate-500" : "text-gray-500"
            )}>
              {t("board.noBoardDescription")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const currentPage =
    board.pages.find((p: any) => p.id === currentPageId) || board.pages[0];
  const currentPageIndex = board.pages.findIndex(
    (p: any) => p.id === currentPageId
  );

  // The grid belongs to the PAGE — `board.grid` is only the default a page
  // falls back to, and it stays in step with the home page so a new page
  // starts out the shape the board mostly is.
  const grid = pageGrid(board, currentPage);

  const handleGridSizeChange = (size: string) => {
    if (!board || !currentPage) return;
    const [rows, cols] = size.split("x").map(Number);

    // Shrinking used to DELETE every button that no longer fit — silently, and
    // on every page at once. Refuse instead: the clinician moves or deletes
    // them, and nothing disappears behind their back.
    // `{1,1}` as the floor, not fitGrid's default — an EMPTY page needs no
    // cells at all, and the 3x3 default would refuse to let it shrink.
    const needed = fitGrid(currentPage.buttons ?? [], { rows: 1, cols: 1 });
    if (rows < needed.rows || cols < needed.cols) {
      toast({
        title: t("board.gridTooSmall"),
        description: t("board.gridTooSmallDesc", {
          rows: String(needed.rows),
          cols: String(needed.cols),
        }),
        variant: "destructive",
      });
      return;
    }

    const isHomePage = (board as BoardIR).pages[0]?.id === currentPage.id;
    updateBoard({
      ...(board as BoardIR),
      grid: isHomePage ? { rows, cols } : board.grid,
      pages: (board as BoardIR).pages.map((page) =>
        page.id === currentPage.id ? { ...page, layout: { rows, cols } } : page
      ),
    });
  };

  const handlePreviousPage = () => {
    if (currentPageIndex > 0) {
      setCurrentPage(board.pages[currentPageIndex - 1].id);
    }
  };

  const handleNextPage = () => {
    if (currentPageIndex < board.pages.length - 1) {
      setCurrentPage(board.pages[currentPageIndex + 1].id);
    }
  };

  const handleAddPage = () => {
    addPage();
  };

  const zoomIn = () => {
    setZoom(Math.min(zoom + 25, 200));
  };

  const zoomOut = () => {
    setZoom(Math.max(zoom - 25, 50));
  };

  // Handle speaking text (preview mode action)
  const handleSpeak = async (text: string) => {
    setSpokenText(text);
    
    // Use SoundContext's speakText which tracks audio state globally
    const languageMap: Record<string, string> = {
      en: 'en-US',
      he: 'he-IL',
      ar: 'ar-SA',
    };
    const speechLang = languageMap[language] || 'en-US';
    await speakText(text, { lang: speechLang });

    // Clear the display after a delay
    setTimeout(() => {
      setSpokenText(null);
    }, 3000);
  };

  const handleButtonClick = (button: any, e: React.MouseEvent) => {
    e.stopPropagation();

    if (!isEditMode) {
      // Preview mode - execute the action
      const action = button.action;
      
      if (!action) {
        // Default: speak the label
        handleSpeak(button.spokenText || button.label);
        return;
      }

      switch (action.type) {
        case "speak":
          handleSpeak(action.text || button.spokenText || button.label);
          break;
        case "youtube":
          setActiveVideo({
            videoId: action.videoId,
            title: action.title || button.label,
          });
          break;
        case "link":
          if (action.toPageId) {
            setCurrentPage(action.toPageId);
          }
          break;
        case "home":
          if (board.pages.length > 0) {
            setCurrentPage(board.pages[0].id);
          }
          break;
        case "back":
          // In a real implementation, this would use navigation history
          if (currentPageIndex > 0) {
            setCurrentPage(board.pages[currentPageIndex - 1].id);
          }
          break;
        default:
          handleSpeak(button.spokenText || button.label);
      }
      return;
    }

    // Edit mode - select the button for editing
    selectButton(button.id);
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    // Only deselect if clicking directly on the canvas background, not on buttons
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvasArea) {
      selectButton(null);
    }
  };

  const handleCloseVideo = () => {
    setActiveVideo(null);
  };

  const handleEmptyCellClick = (row: number, col: number, e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Only allow adding buttons in edit mode
    if (!isEditMode) return;

    addButton({
      row,
      col,
      label: t("button.newButton"),
      spokenText: t("button.newButton"),
      color: "#3B82F6",
      iconRef: "fas fa-square",
      action: {
        type: "speak",
        text: t("button.newButton"),
      },
    });
  };

  return (
    <div className={cn(
      "flex-1 flex flex-col min-h-0",
      isDark ? "bg-slate-950" : "bg-gray-100"
    )}>
      {/* Toolbar - only visible in edit mode */}
      {isEditMode && (
        <div className={cn(
          "border-b px-4 py-3 flex flex-wrap items-center justify-between gap-3",
          isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200"
        )}>
          <div className={cn("flex items-center flex-wrap gap-3", isRTL && "flex-row-reverse")}>
            {/* Grid size — of THIS PAGE. Rows and columns are chosen
                separately because a page should be the shape of its buttons:
                7 buttons want 2×4, and a square-only picker could never say so. */}
            <div className={cn("flex items-center gap-2", isRTL && "flex-row-reverse")}>
              <span className={cn(
                "text-xs font-medium",
                isDark ? "text-slate-400" : "text-gray-600"
              )}>
                {t("board.pageGrid")}
              </span>
              {([
                ["rows", grid.rows, (n: number) => `${n}x${grid.cols}`],
                ["cols", grid.cols, (n: number) => `${grid.rows}x${n}`],
              ] as const).map(([axis, value, toSize], axisIndex) => (
                <div key={axis} className={cn("flex items-center gap-1", isRTL && "flex-row-reverse")}>
                  {axisIndex === 1 && (
                    <span className={cn("text-xs", isDark ? "text-slate-500" : "text-gray-400")}>×</span>
                  )}
                  <Select
                    onValueChange={(n) => handleGridSizeChange(toSize(Number(n)))}
                    value={String(value)}
                  >
                    <SelectTrigger
                      aria-label={t(axis === "rows" ? "board.rows" : "board.columns")}
                      className={cn(
                        "w-[58px] h-8 text-xs",
                        isDark
                          ? "bg-slate-800 border-slate-700 text-slate-200"
                          : "bg-white border-gray-300 text-gray-800"
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={isDark ? "bg-slate-800 border-slate-700" : "bg-white border-gray-200"}>
                      {GRID_AXIS_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)} className={isDark ? "text-slate-200" : "text-gray-800"}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            {/* Page Navigation */}
            <div className={cn(
              "flex items-center gap-1 rounded-lg px-1 py-0.5",
              isDark ? "bg-slate-800" : "bg-gray-100"
            )}>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7",
                  isDark 
                    ? "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
                )}
                onClick={handlePreviousPage}
                disabled={currentPageIndex <= 0}
              >
                {isRTL ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
              </Button>
              <span className={cn(
                "text-xs px-2 min-w-[60px] text-center",
                isDark ? "text-slate-300" : "text-gray-700"
              )}>
                {currentPageIndex + 1} / {board.pages.length}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7",
                  isDark 
                    ? "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
                )}
                onClick={handleNextPage}
                disabled={currentPageIndex >= board.pages.length - 1}
              >
                {isRTL ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
              </Button>
            </div>

            {/* Page Name */}
            <span className={cn(
              "text-xs max-w-[140px] truncate",
              isDark ? "text-slate-500" : "text-gray-500"
            )}>
              {currentPage?.name || `${t("board.page")} ${currentPageIndex + 1}`}
            </span>

            {/* Manage Pages */}
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 text-xs",
                isDark 
                  ? "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                  : "text-gray-600 hover:text-gray-800 hover:bg-gray-100"
              )}
              onClick={() => setIsManagePagesOpen(true)}
            >
              <ListTree size={12} className={cn("mr-1.5", isRTL && "mr-0 ml-1.5")} />
              {t("board.manage")}
            </Button>

            {/* Add Page */}
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-7 text-xs",
                isDark 
                  ? "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
                  : "bg-white border-gray-300 text-gray-700 hover:bg-gray-100"
              )}
              onClick={handleAddPage}
            >
              <Plus size={12} className={cn("mr-1", isRTL && "mr-0 ml-1")} />
              {t("board.addPage")}
            </Button>
          </div>

          {/* Right side controls */}
          <div className={cn("flex items-center gap-3", isRTL && "flex-row-reverse")}>
            {/* Cover Image Selector */}
            <CoverImageSelector />

            {/* Zoom Controls */}
            <div className={cn(
              "flex items-center gap-1 rounded-lg px-1 py-0.5",
              isDark ? "bg-slate-800" : "bg-gray-100"
            )}>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7",
                  isDark
                    ? "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
                )}
                onClick={zoomOut}
                aria-label="Zoom out"
              >
                <ZoomOut size={12} />
              </Button>
              <span className={cn(
                "text-xs px-1.5 min-w-[40px] text-center",
                isDark ? "text-slate-400" : "text-gray-500"
              )}>
                {zoom}%
              </span>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7",
                  isDark
                    ? "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
                )}
                onClick={zoomIn}
                aria-label="Zoom in"
              >
                <ZoomIn size={12} />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Speech Display (Preview Mode) */}
      {!isEditMode && spokenText && (
        <div className={cn(
          "absolute top-4 left-1/2 -translate-x-1/2 z-20 rounded-xl px-6 py-3 shadow-2xl flex items-center gap-3",
          isDark 
            ? "bg-slate-800 border border-slate-700"
            : "bg-white border border-gray-200"
        )}>
          <Volume2 className="text-blue-400" size={20} />
          <span className={cn(
            "text-lg font-medium",
            isDark ? "text-slate-200" : "text-gray-800"
          )}>
            {spokenText}
          </span>
        </div>
      )}

      {/* Canvas — pointer-driven 2D editor surface. Individual buttons inside
          the canvas are keyboard-reachable; the canvas itself catches background
          clicks and is exempt from the keyboard-equivalent rule (WCAG 2.1.1
          carve-out for fine pointer interaction). */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        ref={canvasRef}
        className="flex-1 p-6 overflow-auto relative"
        onClick={handleCanvasClick}
        data-canvas-area="true"
      >
        <div className="max-w-2xl mx-auto w-full h-full flex flex-col" data-canvas-area="true">
          <div
            className={cn(
              "rounded-2xl p-6 transition-all flex flex-col flex-1 min-h-0",
              isEditMode
                ? isDark 
                  ? "bg-slate-900 border border-slate-800 shadow-xl" 
                  : "bg-white border border-gray-200 shadow-lg"
                : isDark 
                  ? "bg-slate-900/50"
                  : "bg-white/50"
            )}
            data-canvas-area="true"
          >
            {/* Page info - only in edit mode */}
            {isEditMode && (
              <div className="mb-4" data-canvas-area="true">
                <h3 className={cn(
                  "text-base font-semibold",
                  isDark ? "text-slate-200" : "text-gray-800"
                )}>
                  {currentPage ? currentPage.name : t("board.untitledPage")}
                </h3>
                <p className={cn(
                  "text-xs",
                  isDark ? "text-slate-500" : "text-gray-500"
                )}>
                  {grid.rows}×{grid.cols} {t("board.grid")} • {t("board.page")} {currentPageIndex + 1} {t("board.of")} {board.pages.length}
                </p>
              </div>
            )}

            {/* Button Grid — fills the available preview area (like the AAC),
                so cells are sized by the area / rows×cols and buttons fill them
                rather than being locked to a square. */}
            <div
              className="grid gap-2 w-full flex-1 min-h-0"
              style={{
                gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
                transform: `scale(${zoom / 100})`,
                transformOrigin: "center center",
              }}
            >
              {Array.from(
                { length: grid.rows * grid.cols },
                (_, index) => {
                  const row = Math.floor(index / grid.cols);
                  const col = index % grid.cols;

                  // Check for video player
                  const videoPlayer = currentPage.videoPlayers?.find(
                    (vp: any) =>
                      row >= vp.row &&
                      row < vp.row + vp.rowSpan &&
                      col >= vp.col &&
                      col < vp.col + vp.colSpan
                  );

                  if (
                    videoPlayer &&
                    row === videoPlayer.row &&
                    col === videoPlayer.col
                  ) {
                    return (
                      <div
                        key={videoPlayer.id}
                        className={cn(
                          "rounded-xl overflow-hidden border-2 bg-black",
                          isDark ? "border-slate-700" : "border-gray-300"
                        )}
                        style={{
                          gridColumn: `span ${videoPlayer.colSpan}`,
                          gridRow: `span ${videoPlayer.rowSpan}`,
                          aspectRatio: "16/9",
                        }}
                      >
                        <iframe
                          src={`https://www.youtube.com/embed/${videoPlayer.videoId}?controls=1&rel=0&modestbranding=1`}
                          title={videoPlayer.title}
                          className="w-full h-full"
                          frameBorder="0"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                      </div>
                    );
                  }

                  if (videoPlayer) {
                    return null;
                  }

                  // Check for spanning button covering this cell
                  const spanningButton = currentPage.buttons.find(
                    (b: any) =>
                      ((b.rowSpan ?? 1) > 1 || (b.colSpan ?? 1) > 1) &&
                      row >= b.row &&
                      row < b.row + (b.rowSpan ?? 1) &&
                      col >= b.col &&
                      col < b.col + (b.colSpan ?? 1)
                  );

                  // If this cell is covered by a spanning button but is not its origin, skip it
                  if (spanningButton && (row !== spanningButton.row || col !== spanningButton.col)) {
                    return null;
                  }

                  // Check for button
                  const button = currentPage.buttons.find(
                    (b: any) => b.row === row && b.col === col
                  );

                  if (button) {
                    const btnRowSpan = (button as any).rowSpan ?? 1;
                    const btnColSpan = (button as any).colSpan ?? 1;
                    const isSpanning = btnRowSpan > 1 || btnColSpan > 1;
                    const actionType = button.action?.type;
                    const isLink = actionType === "link";
                    const isBack = actionType === "back" || actionType === "home";
                    // Outer element owns selection/positioning; the shared
                    // <BoardButtonVisual /> renders the visual (bg, icon, label,
                    // border) so editor buttons match the AAC exactly.
                    return (
                      <button
                        type="button"
                        key={button.id}
                        onClick={(e) => handleButtonClick(button, e)}
                        className={cn(
                          "relative rounded-xl transition-all",
                          isEditMode
                            ? selectedButtonId === button.id
                              ? isDark
                                ? "ring-2 ring-yellow-400 ring-offset-2 ring-offset-slate-900"
                                : "ring-2 ring-yellow-400 ring-offset-2 ring-offset-white"
                              : "hover:ring-2 hover:ring-white/20"
                            : "hover:scale-105 active:scale-95"
                        )}
                        style={isSpanning ? {
                          gridColumn: `span ${btnColSpan}`,
                          gridRow: `span ${btnRowSpan}`,
                        } : undefined}
                      >
                        <BoardButtonVisual
                          variant="board"
                          interactive={false}
                          button={irToButtonInput(button)}
                          deps={clinicianDeps}
                          borderClassName={resolveBorderClass({ buttonType: (button as any).buttonType, isLink, isBack })}
                        />

                        {/* Action type indicators */}
                        {isLink && (
                          <span className={cn(
                            "absolute top-0.5 z-10 text-blue-500 opacity-80 text-[0.5rem]",
                            isRTL ? "left-0.5" : "right-0.5"
                          )}>▶</span>
                        )}
                        {isBack && (
                          <span className={cn(
                            "absolute top-0.5 z-10 text-amber-500 opacity-80 text-[0.5rem]",
                            isRTL ? "right-0.5" : "left-0.5"
                          )}>◀</span>
                        )}
                        {!isEditMode && actionType === "youtube" && (
                          <Play size={10} className={cn(
                            "absolute top-1 z-10 opacity-60",
                            isRTL ? "left-1" : "right-1"
                          )} />
                        )}
                      </button>
                    );
                  }

                  // Empty cell - only show in edit mode
                  if (isEditMode) {
                    return (
                      <button type="button"
                        key={`empty-${index}`}
                        className={cn(
                          "border-2 border-dashed rounded-xl flex items-center justify-center transition-colors",
                          isDark
                            ? "border-slate-700 hover:border-slate-500 bg-slate-800/30"
                            : "border-gray-300 hover:border-gray-400 bg-gray-50"
                        )}
                        onClick={(e) => handleEmptyCellClick(row, col, e)}
                      >
                        <Plus className={isDark ? "text-slate-600" : "text-gray-400"} size={20} />
                      </button>
                    );
                  }

                  // Preview mode - render empty space (the grid track reserves the cell)
                  return <div key={`empty-${index}`} />;
                }
              )}
            </div>
          </div>
        </div>
      </div>

      {/* YouTube Video Player Modal */}
      {activeVideo && (
        <YouTubePlayer
          videoId={activeVideo.videoId}
          title={activeVideo.title}
          onClose={handleCloseVideo}
        />
      )}

      {/* Manage Pages Dialog */}
      <Dialog open={isManagePagesOpen} onOpenChange={setIsManagePagesOpen}>
        <DialogContent className={cn(
          "max-w-md",
          isDark ? "bg-slate-900 border-slate-800 text-slate-200" : "bg-white border-gray-200 text-gray-800"
        )}>
          <DialogHeader>
            <DialogTitle className={isDark ? "text-slate-100" : "text-gray-900"}>
              {t("board.pagesInBoard")}
            </DialogTitle>
            <DialogDescription className={isDark ? "text-slate-400" : "text-gray-500"}>
              {t("board.pagesDescription")}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-72 mt-2 -mx-2 px-2">
            <div className="space-y-2">
              {board.pages.map((page: any, index: number) => {
                const isCurrent = page.id === currentPage?.id;
                const isHome = index === 0;
                const canMoveUp = index > 0;
                const canMoveDown = index < board.pages.length - 1;
                const canDelete = board.pages.length > 1;

                return (
                  <div
                    key={page.id}
                    className={cn(
                      "flex items-center justify-between rounded-lg border px-3 py-2",
                      isCurrent
                        ? "bg-blue-600/10 border-blue-600/30"
                        : isDark 
                          ? "bg-slate-800/50 border-slate-700"
                          : "bg-gray-50 border-gray-200"
                    )}
                  >
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <Input
                          className={cn(
                            "h-7 text-sm",
                            isDark 
                              ? "bg-slate-800 border-slate-700 text-slate-200" 
                              : "bg-white border-gray-300 text-gray-800"
                          )}
                          value={page.name}
                          onChange={(e) => renamePage(page.id, e.target.value)}
                        />
                        {isHome && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 uppercase whitespace-nowrap">
                            {t("board.home")}
                          </span>
                        )}
                        {isCurrent && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 uppercase whitespace-nowrap">
                            {t("board.current")}
                          </span>
                        )}
                      </div>
                      <div className={cn(
                        "text-[10px]",
                        isDark ? "text-slate-500" : "text-gray-500"
                      )}>
                        {t("board.page")} {index + 1} • {(page.buttons || []).length} {t("board.buttons")}{(page.buttons || []).length === 1 ? "" : "s"}
                      </div>
                    </div>

                    <div className={cn("flex items-center gap-1 ml-2", isRTL && "flex-row-reverse")}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-7 w-7",
                          isDark 
                            ? "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                            : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
                        )}
                        disabled={!canMoveUp}
                        onClick={() => reorderPages(index, index - 1)}
                      >
                        <ArrowUp size={12} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-7 w-7",
                          isDark 
                            ? "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                            : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
                        )}
                        disabled={!canMoveDown}
                        onClick={() => reorderPages(index, index + 1)}
                      >
                        <ArrowDown size={12} />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={cn(
                          "h-7 px-2 text-xs",
                          isDark 
                            ? "text-slate-300 hover:bg-slate-700"
                            : "text-gray-700 hover:bg-gray-200"
                        )}
                        onClick={() => {
                          setCurrentPage(page.id);
                          setIsManagePagesOpen(false);
                        }}
                      >
                        {t("board.open")}
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-red-400 hover:bg-red-500/20"
                        disabled={!canDelete}
                        onClick={() => deletePage(page.id)}
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>

          <DialogFooter className="mt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsManagePagesOpen(false)}
              className={isDark 
                ? "border-slate-700 text-slate-300 hover:bg-slate-800" 
                : "border-gray-300 text-gray-700 hover:bg-gray-100"
              }
            >
              {t("common.close")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                addPage();
              }}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <Plus size={14} className={cn("mr-1.5", isRTL && "mr-0 ml-1.5")} />
              {t("board.addPage")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}