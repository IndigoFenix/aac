// src/components/syntAACx/prompt-pane.tsx

import React, { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Wand2,
  Upload,
  FileSpreadsheet,
  PlusCircle,
  ListTree,
  ChevronUp,
  ChevronDown,
  Home,
  Trash2,
  Save,
  Plus,
  Send,
  Eye,
  Pencil,
  ChevronRight,
  Settings,
  MessageSquare,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

import { useBoardStore } from "@/store/board-store";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { BoardIR, PageIR } from "@/types/board-ir";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { ChatMessage } from "@shared/schema";

export function PromptPane() {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [prompt, setPrompt] = useState("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isBoardSettingsOpen, setIsBoardSettingsOpen] = useState(false);

  const [isNewBoardDialogOpen, setIsNewBoardDialogOpen] = useState(false);
  const [isManageBoardsDialogOpen, setIsManageBoardsDialogOpen] = useState(false);
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardRows, setNewBoardRows] = useState(4);
  const [newBoardCols, setNewBoardCols] = useState(4);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    setBoard,
    addEmptyBoard,
    boards,
    activeBoardId,
    selectBoardById,
    reorderBoards,
    deleteBoardById,
    homeBoardId,
    setHomeBoard,
    appendGeneratedPages,
    hydrateBoardsFromServer,
    openBoardFromServer,
    markBoardSaved,
    board,
    currentPageId,
    setCurrentPage,
    selectedButtonId,
    selectButton,
    addPage,
    isEditMode,
    setEditMode,
    updateBoard,
    addButton,
    renamePage,
    deletePage,
    reorderPages,
  } = useBoardStore();

  const { toast } = useToast();

  // Example prompts with translations
  const examplePrompts = [
    t("prompt.example1"),
    t("prompt.example2"),
    t("prompt.example3"),
    t("prompt.example4"),
  ];

  // Scroll to bottom of chat when new messages arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // Load list of boards on mount
  useQuery({
    queryKey: ["/api/boards"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/boards");
      if (!res.ok) {
        throw new Error("Failed to load boards");
      }
      const rows = await res.json();
      hydrateBoardsFromServer(rows);
      return rows;
    },
  });

  // AI generator
  const generateMutation = useMutation({
    mutationFn: async (body: {
      prompt: string;
      language?: string;
      gridSize?: { rows: number; cols: number };
      boardContext?: BoardIR;
      currentPageId?: string | null;
    }) => {
      const res = await apiRequest("POST", "/api/board/generate", body);
      if (!res.ok) {
        throw new Error("Failed to generate board");
      }
      return (await res.json()) as BoardIR;
    },
    onSuccess: (updatedBoard) => {
      const pageCount = updatedBoard.pages?.length ?? 0;

      // Add assistant response to chat
      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: pageCount > 1
          ? t("board.createdPages")
          : t("board.updated"),
        timestamp: new Date().getTime(),
      };
      setChatHistory((prev) => [...prev, assistantMsg]);

      if (activeBoardId) {
        const activeBefore =
          boards.find((b: any) => b._id === activeBoardId) || updatedBoard;
        const prevPageCount = activeBefore.pages?.length ?? 0;
        const addedPages = Math.max(0, pageCount - prevPageCount);

        updateBoard(updatedBoard);

        toast({
          title: addedPages > 0 ? t("board.pagesAdded") : t("board.boardUpdated"),
          description:
            addedPages > 0
              ? t("board.addedPagesDesc")
              : t("board.updatedDesc"),
        });
      } else {
        setBoard(updatedBoard);
        toast({
          title: t("board.generated"),
          description:
            pageCount > 1
              ? t("board.generatedMultiPage")
              : t("board.generatedSinglePage"),
        });
      }
    },
    onError: (error: any) => {
      const errorMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: t("board.generateError"),
        timestamp: new Date().getTime(),
      };
      setChatHistory((prev) => [...prev, errorMsg]);

      toast({
        title: t("board.generationFailed"),
        description: error?.message || t("board.somethingWrong"),
        variant: "destructive",
      });
    },
  });

  const handleGenerate = () => {
    if (!prompt.trim()) return;

    // Add user message to chat
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: prompt,
      timestamp: new Date().getTime(),
    };
    setChatHistory((prev) => [...prev, userMsg]);

    const gridSizeMatch = prompt.match(/(\d+)x(\d+)/i);
    let gridSize: { rows: number; cols: number } | undefined;

    if (gridSizeMatch) {
      const rows = parseInt(gridSizeMatch[1], 10);
      const cols = parseInt(gridSizeMatch[2], 10);
      if (rows >= 2 && rows <= 6 && cols >= 2 && cols <= 6) {
        gridSize = { rows, cols };
      }
    }

    let boardContext: BoardIR | undefined;
    let effectiveCurrentPageId: string | undefined;

    if (!gridSize && activeBoardId) {
      const activeBoard = boards.find((b: any) => b._id === activeBoardId) || null;
      if (activeBoard) {
        gridSize = activeBoard.grid;
      }
    }

    if (activeBoardId) {
      const activeBoard = boards.find((b: any) => b._id === activeBoardId) || null;
      if (activeBoard) {
        boardContext = {
          name: activeBoard.name,
          grid: activeBoard.grid,
          pages: activeBoard.pages,
          assets: activeBoard.assets,
          coverImage: activeBoard.coverImage,
        };
        effectiveCurrentPageId = currentPageId || activeBoard.pages?.[0]?.id;
      }
    }

    generateMutation.mutate({
      prompt,
      gridSize,
      boardContext,
      currentPageId: effectiveCurrentPageId,
    });

    // Clear the prompt
    setPrompt("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const handleExamplePrompt = (examplePrompt: string) => {
    setPrompt(examplePrompt);
    textareaRef.current?.focus();
  };

  const handleCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === "text/csv") {
      setCsvFile(file);
      toast({
        title: t("board.csvUploaded"),
        description: t("board.csvUploadedDesc"),
      });
    }
  };

  const handleCreateEmptyBoard = () => {
    const name = newBoardName.trim() || `${t("board.board")} ${boards.length + 1}`;
    addEmptyBoard({
      name,
      rows: newBoardRows,
      cols: newBoardCols,
    });
    setIsNewBoardDialogOpen(false);
    setNewBoardName("");
    setIsBoardSettingsOpen(false);
  };

  // Save current board
  const saveBoardMutation = useMutation({
    mutationFn: async () => {
      const active = boards.find((b: any) => b._id === activeBoardId);
      if (!active) {
        throw new Error("No active board to save");
      }

      const irData: BoardIR = {
        name: active.name,
        grid: active.grid,
        pages: active.pages,
        assets: active.assets,
        coverImage: active.coverImage,
      };

      const payload = {
        id: active.dbId,
        name: active.name,
        irData,
      };

      const res = await apiRequest("POST", "/api/board/save", payload);
      if (!res.ok) {
        throw new Error("Failed to save board");
      }
      return res.json() as Promise<{ id: string; name: string }>;
    },
    onSuccess: (saved) => {
      markBoardSaved(saved.id, saved.name);
      toast({
        title: t("board.saved"),
        description: t("board.savedDesc"),
      });
    },
    onError: (error: any) => {
      toast({
        title: t("board.saveFailed"),
        description: error?.message || t("board.saveFailedDesc"),
        variant: "destructive",
      });
    },
  });

  const handleSaveBoard = () => {
    if (!activeBoardId) {
      toast({
        title: t("board.noBoardSelected"),
        description: t("board.noBoardSelectedDesc"),
        variant: "destructive",
      });
      return;
    }
    saveBoardMutation.mutate();
  };

  const handleOpenBoard = async (boardMeta: any) => {
    try {
      if (boardMeta.pages && boardMeta.pages.length > 0) {
        selectBoardById(boardMeta._id);
        setIsManageBoardsDialogOpen(false);
        return;
      }

      if (boardMeta.dbId) {
        const res = await apiRequest("GET", `/api/board/${boardMeta.dbId}`);
        if (!res.ok) {
          throw new Error("Failed to load board");
        }
        const full = await res.json();
        openBoardFromServer(full);
        setIsManageBoardsDialogOpen(false);
        return;
      }

      selectBoardById(boardMeta._id);
      setIsManageBoardsDialogOpen(false);
    } catch (error: any) {
      toast({
        title: t("board.openFailed"),
        description: error?.message || t("board.openFailedDesc"),
        variant: "destructive",
      });
    }
  };

  const activeBoardLabel = (() => {
    const active = boards.find((b: any) => b._id === activeBoardId);
    return active?.name || t("board.noBoard");
  })();

  return (
    <div className={cn(
      "w-80 shrink-0 border-r flex flex-col min-h-0",
      isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
      isRTL && "border-r-0 border-l"
    )}>
      {/* Header with mode toggle */}
      <div className={cn(
        "px-4 py-3 border-b flex items-center justify-between",
        isDark ? "border-slate-800" : "border-gray-200"
      )}>
        <h2 className={cn(
          "text-sm font-semibold tracking-wide",
          isDark ? "text-slate-200" : "text-gray-800"
        )}>
          {t("board.builder")}
        </h2>
        
        {/* Edit/Preview Mode Toggle */}
        <div className={cn(
          "flex items-center gap-1 rounded-lg p-0.5",
          isDark ? "bg-slate-800" : "bg-gray-100"
        )}>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 px-2.5 text-xs font-medium rounded-md transition-all",
              isEditMode
                ? "bg-blue-600 text-white hover:bg-blue-600"
                : isDark 
                  ? "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
            )}
            onClick={() => setEditMode(true)}
          >
            <Pencil size={12} className={cn("mr-1.5", isRTL && "mr-0 ml-1.5")} />
            {t("board.edit")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 px-2.5 text-xs font-medium rounded-md transition-all",
              !isEditMode
                ? "bg-emerald-600 text-white hover:bg-emerald-600"
                : isDark 
                  ? "text-slate-400 hover:text-slate-200 hover:bg-slate-700"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
            )}
            onClick={() => setEditMode(false)}
          >
            <Eye size={12} className={cn("mr-1.5", isRTL && "mr-0 ml-1.5")} />
            {t("board.preview")}
          </Button>
        </div>
      </div>

      {/* Chat History Area */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        <ScrollArea className="flex-1 px-4 py-3">
          {chatHistory.length === 0 ? (
            <div className="text-center py-8">
              <MessageSquare className={cn(
                "w-10 h-10 mx-auto mb-3",
                isDark ? "text-slate-700" : "text-gray-300"
              )} />
              <p className={cn(
                "text-sm mb-4",
                isDark ? "text-slate-500" : "text-gray-500"
              )}>
                {t("prompt.description")}
              </p>
              
              {/* Quick prompts */}
              <div className="space-y-2">
                {examplePrompts.map((example) => (
                  <button
                    key={example}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-lg text-xs transition-colors border",
                      isDark 
                        ? "bg-slate-800/50 hover:bg-slate-800 text-slate-400 hover:text-slate-300 border-slate-700/50"
                        : "bg-gray-50 hover:bg-gray-100 text-gray-600 hover:text-gray-800 border-gray-200"
                    )}
                    onClick={() => handleExamplePrompt(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {chatHistory.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm",
                    msg.role === "user"
                      ? isRTL 
                        ? "bg-blue-600/20 text-blue-100 mr-4"
                        : "bg-blue-600/20 text-blue-100 ml-4"
                      : isRTL
                        ? isDark ? "bg-slate-800 text-slate-300 ml-4" : "bg-gray-100 text-gray-700 ml-4"
                        : isDark ? "bg-slate-800 text-slate-300 mr-4" : "bg-gray-100 text-gray-700 mr-4"
                  )}
                >
                  {msg.content}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          )}
        </ScrollArea>

        {/* Prompt Input Area */}
        <div className={cn(
          "px-4 py-3 border-t backdrop-blur",
          isDark ? "border-slate-800 bg-slate-900/80" : "border-gray-200 bg-white/80"
        )}>
          <div className="relative">
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("prompt.placeholder")}
              className={cn(
                "min-h-[80px] max-h-[160px] resize-none text-sm rounded-lg",
                isRTL ? "pl-12 pr-3" : "pr-12 pl-3",
                isDark 
                  ? "bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-500 focus:ring-blue-500 focus:border-blue-500"
                  : "bg-gray-50 border-gray-300 text-gray-800 placeholder:text-gray-400 focus:ring-blue-500 focus:border-blue-500"
              )}
            />
            <Button
              onClick={handleGenerate}
              disabled={generateMutation.isPending || !prompt.trim()}
              size="icon"
              className={cn(
                "absolute bottom-2 h-8 w-8 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700",
                isRTL ? "left-2" : "right-2"
              )}
            >
              {generateMutation.isPending ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Send size={14} />
              )}
            </Button>
          </div>
          <p className={cn(
            "text-[10px] mt-1.5",
            isDark ? "text-slate-600" : "text-gray-400"
          )}>
            {t("prompt.hint")}
          </p>
        </div>
      </div>

      {/* Board Settings Collapsible */}
      <Collapsible open={isBoardSettingsOpen} onOpenChange={setIsBoardSettingsOpen}>
        <CollapsibleTrigger asChild>
          <button className={cn(
            "w-full px-4 py-2.5 border-t flex items-center justify-between text-xs transition-colors",
            isDark 
              ? "border-slate-800 text-slate-400 hover:text-slate-300 hover:bg-slate-800/50"
              : "border-gray-200 text-gray-500 hover:text-gray-700 hover:bg-gray-50"
          )}>
            <span className={cn("flex items-center gap-2", isRTL && "flex-row-reverse")}>
              <Settings size={12} />
              {t("board.settings")}
            </span>
            <div className={cn("flex items-center gap-2", isRTL && "flex-row-reverse")}>
              <span className={cn(
                "truncate max-w-[100px]",
                isDark ? "text-slate-500" : "text-gray-400"
              )}>
                {activeBoardLabel}
              </span>
              <ChevronRight
                size={12}
                className={cn(
                  "transition-transform",
                  isBoardSettingsOpen && "rotate-90",
                  isRTL && !isBoardSettingsOpen && "rotate-180"
                )}
              />
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className={cn(
            "px-4 py-3 border-t space-y-2",
            isDark ? "border-slate-800 bg-slate-800/30" : "border-gray-200 bg-gray-50"
          )}>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "w-full justify-start text-xs",
                isDark 
                  ? "bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800"
                  : "bg-white border-gray-300 text-gray-700 hover:bg-gray-100"
              )}
              onClick={() => {
                setNewBoardRows(4);
                setNewBoardCols(4);
                setIsNewBoardDialogOpen(true);
              }}
            >
              <PlusCircle size={12} className={cn("mr-2", isRTL && "mr-0 ml-2")} />
              {t("board.createEmptyBoard")}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "w-full justify-start text-xs",
                isDark 
                  ? "text-slate-400 hover:text-slate-300 hover:bg-slate-800"
                  : "text-gray-600 hover:text-gray-800 hover:bg-gray-100"
              )}
              onClick={() => setIsManageBoardsDialogOpen(true)}
            >
              <ListTree size={12} className={cn("mr-2", isRTL && "mr-0 ml-2")} />
              {t("board.manageBoards")}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "w-full justify-start text-xs",
                isDark 
                  ? "text-slate-400 hover:text-slate-300 hover:bg-slate-800"
                  : "text-gray-600 hover:text-gray-800 hover:bg-gray-100"
              )}
              onClick={handleSaveBoard}
              disabled={!activeBoardId || saveBoardMutation.isPending}
            >
              <Save size={12} className={cn("mr-2", isRTL && "mr-0 ml-2")} />
              {saveBoardMutation.isPending ? t("board.saving") : t("board.saveBoard")}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Create board dialog */}
      <Dialog open={isNewBoardDialogOpen} onOpenChange={setIsNewBoardDialogOpen}>
        <DialogContent className={cn(
          "max-w-sm",
          isDark ? "bg-slate-900 border-slate-800 text-slate-200" : "bg-white border-gray-200 text-gray-800"
        )}>
          <DialogHeader>
            <DialogTitle className={isDark ? "text-slate-100" : "text-gray-900"}>
              {t("board.newBoardDialogTitle")}
            </DialogTitle>
            <DialogDescription className={isDark ? "text-slate-400" : "text-gray-500"}>
              {t("board.newBoardDialogSubtitle")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="space-y-1">
              <Label htmlFor="newBoardName" className={isDark ? "text-slate-300" : "text-gray-700"}>
                {t("board.newBoardName")}
              </Label>
              <Input
                id="newBoardName"
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                placeholder={t("board.newBoardNamePlaceholder")}
                className={isDark 
                  ? "bg-slate-800 border-slate-700 text-slate-200" 
                  : "bg-white border-gray-300 text-gray-800"
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="rows" className={isDark ? "text-slate-300" : "text-gray-700"}>
                  {t("board.rows")}
                </Label>
                <Input
                  id="rows"
                  type="number"
                  min={2}
                  max={8}
                  value={newBoardRows}
                  onChange={(e) =>
                    setNewBoardRows(
                      Math.min(8, Math.max(2, parseInt(e.target.value || "0", 10)))
                    )
                  }
                  className={isDark 
                    ? "bg-slate-800 border-slate-700 text-slate-200" 
                    : "bg-white border-gray-300 text-gray-800"
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cols" className={isDark ? "text-slate-300" : "text-gray-700"}>
                  {t("board.cols")}
                </Label>
                <Input
                  id="cols"
                  type="number"
                  min={2}
                  max={8}
                  value={newBoardCols}
                  onChange={(e) =>
                    setNewBoardCols(
                      Math.min(8, Math.max(2, parseInt(e.target.value || "0", 10)))
                    )
                  }
                  className={isDark 
                    ? "bg-slate-800 border-slate-700 text-slate-200" 
                    : "bg-white border-gray-300 text-gray-800"
                  }
                />
              </div>
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button
              variant="outline"
              onClick={() => setIsNewBoardDialogOpen(false)}
              className={isDark 
                ? "border-slate-700 text-slate-300 hover:bg-slate-800" 
                : "border-gray-300 text-gray-700 hover:bg-gray-100"
              }
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={handleCreateEmptyBoard} className="bg-blue-600 hover:bg-blue-700">
              <PlusCircle size={14} className={cn("mr-2", isRTL && "mr-0 ml-2")} />
              {t("board.createBoard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage boards dialog */}
      <Dialog open={isManageBoardsDialogOpen} onOpenChange={setIsManageBoardsDialogOpen}>
        <DialogContent className={cn(
          "max-w-md",
          isDark ? "bg-slate-900 border-slate-800 text-slate-200" : "bg-white border-gray-200 text-gray-800"
        )}>
          <DialogHeader>
            <DialogTitle className={isDark ? "text-slate-100" : "text-gray-900"}>
              {t("board.manageBoardsTitle")}
            </DialogTitle>
            <DialogDescription className={isDark ? "text-slate-400" : "text-gray-500"}>
              {t("board.manageBoardsSubtitle")}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-72 mt-2 -mx-2 px-2">
            {boards.length === 0 ? (
              <p className={cn("text-sm", isDark ? "text-slate-500" : "text-gray-500")}>
                {t("board.noBoardsYet")}
              </p>
            ) : (
              <div className="space-y-2">
                {boards.map((board: any, index: number) => {
                  const isHome = board.isHome || board._id === homeBoardId;
                  const isActive = board._id === activeBoardId;

                  return (
                    <div
                      key={board._id}
                      className={cn(
                        "flex items-center justify-between rounded-lg border px-3 py-2",
                        isActive
                          ? "bg-blue-600/10 border-blue-600/30"
                          : isDark 
                            ? "bg-slate-800/50 border-slate-700"
                            : "bg-gray-50 border-gray-200"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-sm font-medium truncate",
                            isDark ? "text-slate-200" : "text-gray-800"
                          )}>
                            {board.name}
                          </span>
                          {board.dbId && (
                            <span className={cn(
                              "text-[9px] px-1.5 py-0.5 rounded uppercase",
                              isDark ? "bg-slate-700 text-slate-400" : "bg-gray-200 text-gray-600"
                            )}>
                              {t("board.saved")}
                            </span>
                          )}
                          {isHome && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 uppercase">
                              {t("board.home")}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className={cn(
                            "h-7 px-2 text-xs",
                            isDark ? "text-slate-300 hover:bg-slate-700" : "text-gray-700 hover:bg-gray-200"
                          )}
                          onClick={() => handleOpenBoard(board)}
                        >
                          {t("board.open")}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className={cn(
                            "h-7 w-7",
                            isDark ? "text-slate-400 hover:bg-slate-700" : "text-gray-500 hover:bg-gray-200"
                          )}
                          disabled={index === 0}
                          onClick={() => reorderBoards(index, index - 1)}
                        >
                          <ChevronUp size={12} />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className={cn(
                            "h-7 w-7",
                            isDark ? "text-slate-400 hover:bg-slate-700" : "text-gray-500 hover:bg-gray-200"
                          )}
                          disabled={index === boards.length - 1}
                          onClick={() => reorderBoards(index, index + 1)}
                        >
                          <ChevronDown size={12} />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className={cn(
                            "h-7 w-7",
                            isHome
                              ? "text-amber-400 hover:bg-amber-500/20"
                              : isDark ? "text-slate-400 hover:bg-slate-700" : "text-gray-500 hover:bg-gray-200"
                          )}
                          onClick={() => setHomeBoard(board._id)}
                        >
                          <Home size={12} />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-red-400 hover:bg-red-500/20"
                          disabled={boards.length <= 1}
                          onClick={() => deleteBoardById(board._id)}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          <DialogFooter className="mt-3">
            <Button
              variant="outline"
              onClick={() => setIsManageBoardsDialogOpen(false)}
              className={isDark 
                ? "border-slate-700 text-slate-300 hover:bg-slate-800" 
                : "border-gray-300 text-gray-700 hover:bg-gray-100"
              }
            >
              {t("common.close")}
            </Button>
            <Button
              onClick={() => {
                setIsManageBoardsDialogOpen(false);
                setIsNewBoardDialogOpen(true);
              }}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <PlusCircle size={14} className={cn("mr-2", isRTL && "mr-0 ml-2")} />
              {t("board.newBoard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}