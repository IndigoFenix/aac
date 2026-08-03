// src/components/syntAACx/BoardSelector.tsx
// This component appears as a bar below the chat when in SyntAACx mode

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Edit,
  Eye,
  Save,
  Loader2,
  AlertTriangle,
  Zap,
  Info,
  Trash2,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useBoardStore } from '@/store/board-store';
import { useSharedState } from '@/contexts/FeaturePanelContext';
import { useStudent } from '@/hooks/useStudent';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { BoardIR } from '@/types/board-ir';
import { BoardPackageControl } from './BoardPackageControl';

export function BoardSelector() {
  const [pendingSwitchBoardId, setPendingSwitchBoardId] = useState<string | null>(null);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showClearUnsavedDialog, setShowClearUnsavedDialog] = useState(false);
  const [isLoadingBoard, setIsLoadingBoard] = useState(false);
  
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { student } = useStudent();
  
  const { 
    board, 
    boards, 
    activeBoardId,
    selectBoardById, 
    setEditMode, 
    isEditMode,
    hydrateBoardsFromServer,
    openBoardFromServer,
    markBoardSaved,
    updateBoard,
    setBoard,
  } = useBoardStore();
  
  const { sharedState, setSharedState } = useSharedState();

  // "Update Automatically" (isGenerated) only makes sense when the AI is allowed
  // to manage boards dynamically for this student.
  const dynamicBoardsEnabled = (student as any)?.aacSettings?.dynamicBoardsEnabled ?? false;

  /** Patch metadata on the loaded board + mirror into the boards list, marking
   *  it dirty. Mirrors the inline setState the auto-select controls used. */
  const patchBoardMeta = (patch: Record<string, any>) => {
    const currentBoard = useBoardStore.getState().board;
    if (!currentBoard) return;
    useBoardStore.setState((state) => {
      const updated = { ...currentBoard, ...patch, isDirty: true } as any;
      return {
        board: updated,
        boards: state.boards.map((b: any) => b._id === updated._id ? updated : b),
      };
    });
  };

  // ============================================================================
  // LOAD BOARDS LIST FROM SERVER (metadata only, no irData)
  // ============================================================================
  
  useQuery({
    queryKey: ['/api/boards', student?.id],
    queryFn: async () => {
      const endpoint = student?.id
        ? `/api/boards/student/${student.id}`
        : '/api/boards';
      const res = await apiRequest('GET', endpoint);
      if (!res.ok) {
        throw new Error('Failed to load boards');
      }
      const rows = await res.json();
      hydrateBoardsFromServer(rows);
      return rows;
    },
    staleTime: 30000, // Consider data fresh for 30 seconds
  });

  // ============================================================================
  // HANDLE BOARD DATA FROM CHAT RESPONSES
  // ============================================================================
  
  // Watch for board data from chat responses and update the current board
  // IMPORTANT: We only depend on boardGeneratorData changing, NOT on board store state.
  // Accessing store state directly via getState() prevents the update->effect->update loop.
  useEffect(() => {
    const boardData = sharedState?.boardGeneratorData?.board;
    if (!boardData) return;
    
    // Clear immediately to prevent re-processing on subsequent renders
    setSharedState({ boardGeneratorData: undefined });
    
    // Access current store state directly (not via hook dependencies)
    const { activeBoardId: currentActiveBoardId, board: currentBoard } = useBoardStore.getState();
    
    console.log('[BoardSelector] Received board data from chat:', boardData);
    
    // If we have an active board, update it instead of creating a new one
    if (currentActiveBoardId && currentBoard) {
      console.log('[BoardSelector] Updating existing board:', currentActiveBoardId);
      updateBoard(boardData);
    } else {
      // No active board - create a new one
      console.log('[BoardSelector] Creating new board from chat response');
      setBoard(boardData);
    }
  }, [sharedState?.boardGeneratorData, setSharedState, updateBoard, setBoard]);

  // ============================================================================
  // LOAD FULL BOARD DATA (with irData)
  // ============================================================================

  const loadFullBoardData = useCallback(async (boardMeta: { _id: string; dbId?: string; loadedFromServer?: boolean }) => {
    // If already loaded from server, just select it
    if (boardMeta.loadedFromServer) {
      selectBoardById(boardMeta._id);
      return;
    }

    // If it's a local-only board (no dbId), just select it
    if (!boardMeta.dbId) {
      selectBoardById(boardMeta._id);
      return;
    }

    // Need to fetch from server
    setIsLoadingBoard(true);
    setSharedState({ isBoardLoading: true });

    try {
      const res = await apiRequest('GET', `/api/boards/${boardMeta.dbId}`);
      if (!res.ok) {
        throw new Error('Failed to load board data');
      }
      
      const fullBoard = await res.json();
      
      // Open the board with full data
      openBoardFromServer({
        id: fullBoard.id,
        name: fullBoard.name,
        irData: fullBoard.irData,
        automaticSelection: fullBoard.automaticSelection,
        automaticSelectionHint: fullBoard.automaticSelectionHint,
        restSpace: fullBoard.restSpace,
        isGenerated: fullBoard.isGenerated,
      });

      toast({
        title: t('board.loaded'),
        description: fullBoard.name,
      });
    } catch (error: any) {
      console.error('Failed to load board:', error);
      toast({
        title: t('board.loadFailed'),
        description: error?.message || t('board.loadFailedDesc'),
        variant: 'destructive',
      });
    } finally {
      setIsLoadingBoard(false);
      setSharedState({ isBoardLoading: false });
    }
  }, [selectBoardById, openBoardFromServer, setSharedState, toast, t]);

  // ============================================================================
  // SAVE BOARD MUTATION
  // ============================================================================
  
  const saveBoardMutation = useMutation({
    mutationFn: async () => {
      if (!board) {
        throw new Error('No board to save');
      }
      
      // Strip internal fields to get clean IR data
      const irData: BoardIR = {
        name: board.name,
        grid: board.grid,
        pages: board.pages,
        assets: board.assets,
        coverImage: board.coverImage,
      };
      
      const payload: Record<string, any> = {
        name: board.name,
        irData,
      };
      // Include automatic selection fields if set
      if (board.automaticSelection !== undefined) {
        payload.automaticSelection = board.automaticSelection;
      }
      if (board.automaticSelectionHint !== undefined) {
        payload.automaticSelectionHint = board.automaticSelectionHint;
      }
      if (board.restSpace !== undefined) {
        payload.restSpace = board.restSpace;
      }
      if ((board as any).isGenerated !== undefined) {
        (payload as any).isGenerated = (board as any).isGenerated;
      }

      // Use PATCH for existing boards, POST for new ones
      if (board.dbId) {
        const res = await apiRequest('PATCH', `/api/boards/${board.dbId}`, payload);
        if (!res.ok) {
          throw new Error('Failed to update board');
        }
        return res.json() as Promise<{ id: string; name: string }>;
      } else {
        // Associate new boards with the currently selected student
        if (student?.id) {
          payload.studentId = student.id;
        }
        const res = await apiRequest('POST', '/api/boards', payload);
        if (!res.ok) {
          throw new Error('Failed to save board');
        }
        return res.json() as Promise<{ id: string; name: string }>;
      }
    },
    onSuccess: (saved) => {
      markBoardSaved(saved.id, saved.name);
      queryClient.invalidateQueries({ queryKey: ['/api/boards'] });
      queryClient.invalidateQueries({ queryKey: ['/api/boards', student?.id] });
      toast({
        title: t('board.saved'),
        description: t('board.savedDesc'),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t('board.saveFailed'),
        description: error?.message || t('board.saveFailedDesc'),
        variant: 'destructive',
      });
    },
  });

  // ============================================================================
  // BOARD SWITCHING WITH UNSAVED CHANGES WARNING
  // ============================================================================
  
  const handleBoardSwitch = useCallback((boardId: string) => {
    // Don't switch if already loading
    if (isLoadingBoard) return;

    // Find the board in the list
    const targetBoard = boards.find(b => b._id === boardId);
    if (!targetBoard) return;

    // Check if current board has unsaved changes
    if (board?.isDirty) {
      setPendingSwitchBoardId(boardId);
      setShowUnsavedDialog(true);
      return;
    }
    
    // No unsaved changes, load and switch
    loadFullBoardData(targetBoard);
  }, [board?.isDirty, boards, isLoadingBoard, loadFullBoardData]);

  const handleConfirmSwitch = useCallback(() => {
    if (pendingSwitchBoardId) {
      const targetBoard = boards.find(b => b._id === pendingSwitchBoardId);
      if (targetBoard) {
        loadFullBoardData(targetBoard);
      }
    }
    setPendingSwitchBoardId(null);
    setShowUnsavedDialog(false);
  }, [pendingSwitchBoardId, boards, loadFullBoardData]);

  const handleSaveAndSwitch = useCallback(async () => {
    try {
      await saveBoardMutation.mutateAsync();
      if (pendingSwitchBoardId) {
        const targetBoard = boards.find(b => b._id === pendingSwitchBoardId);
        if (targetBoard) {
          loadFullBoardData(targetBoard);
        }
      }
    } finally {
      setPendingSwitchBoardId(null);
      setShowUnsavedDialog(false);
    }
  }, [saveBoardMutation, pendingSwitchBoardId, boards, loadFullBoardData]);

  const handleCancelSwitch = useCallback(() => {
    setPendingSwitchBoardId(null);
    setShowUnsavedDialog(false);
  }, []);

  // ============================================================================
  // CLEAR BOARD
  // ============================================================================

  const handleClearBoard = useCallback(() => {
    if (!board) return;
    if (board.isDirty) {
      setShowClearUnsavedDialog(true);
      return;
    }
    // No unsaved changes, clear immediately
    useBoardStore.setState({
      board: null,
      activeBoardId: null,
      currentPageId: null,
      selectedButtonId: null,
      navHistory: [],
      bookmarkPageId: null,
      validation: { isValid: false, errors: [] },
    });
  }, [board]);

  const handleConfirmClear = useCallback(() => {
    useBoardStore.setState({
      board: null,
      activeBoardId: null,
      currentPageId: null,
      selectedButtonId: null,
      navHistory: [],
      bookmarkPageId: null,
      validation: { isValid: false, errors: [] },
    });
    setShowClearUnsavedDialog(false);
  }, []);

  const handleSaveAndClear = useCallback(async () => {
    try {
      await saveBoardMutation.mutateAsync();
      useBoardStore.setState({
        board: null,
        activeBoardId: null,
        currentPageId: null,
        selectedButtonId: null,
        navHistory: [],
        bookmarkPageId: null,
        validation: { isValid: false, errors: [] },
      });
    } finally {
      setShowClearUnsavedDialog(false);
    }
  }, [saveBoardMutation]);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <>
      {/* The document is dir="rtl" in RTL mode, so flex rows already reverse —
          do NOT add flex-row-reverse here or it double-flips back to LTR. */}
      <div className={cn(
        'flex items-center justify-between gap-4 flex-wrap'
      )}>
        {/* Left side: Board picker */}
        <div className="flex items-center gap-3">
          <Select
            value={board?._id || ''}
            onValueChange={handleBoardSwitch}
            disabled={isLoadingBoard}
          >
            <SelectTrigger className={cn(
              'w-[200px] h-8 text-xs',
              isDark
                ? 'bg-slate-800 border-slate-700'
                : 'bg-white border-gray-300'
            )}>
              {isLoadingBoard ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{t('common.loading')}</span>
                </div>
              ) : (
                <SelectValue placeholder={t('board.selectBoard')} />
              )}
            </SelectTrigger>
            <SelectContent>
              {boards && boards.length > 0 ? (
                boards.map((b) => (
                  <SelectItem key={b._id} value={b._id}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate">{b.name}</span>
                      {b.automaticSelection && (
                        <span
                          className="text-[9px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-500 flex items-center gap-1 max-w-[140px] shrink-0"
                          title={b.automaticSelectionHint || undefined}
                        >
                          <Zap className="w-2.5 h-2.5 shrink-0" />
                          {b.automaticSelectionHint && (
                            <span className="truncate">{b.automaticSelectionHint}</span>
                          )}
                        </span>
                      )}
                      {(b as any).isGenerated && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/20 text-purple-500 shrink-0">
                          AI
                        </span>
                      )}
                      {b.isDirty && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-500 shrink-0">
                          •
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))
              ) : (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {t('board.noBoards')}
                </div>
              )}
            </SelectContent>
          </Select>
        </div>

        {/* Right side: Board info, Save button, and Edit/Preview toggle */}
        <div className="flex items-center gap-2">
          {/* Board name and status */}
          {board && (
            <div className={cn(
              'flex items-center gap-2 mr-2',
              // Keep the spacing on the correct visual side in RTL (physical
              // margin swap); NOT flex-row-reverse — dir handles ordering.
              isRTL && 'mr-0 ml-2'
            )}>
              <span className={cn(
                'text-xs',
                isDark ? 'text-slate-400' : 'text-gray-500'
              )}>
                {board.name}
              </span>
              {board.automaticSelection && (
                <span
                  className={cn(
                    'text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1 max-w-[180px]',
                    isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-600'
                  )}
                  title={board.automaticSelectionHint || undefined}
                >
                  <Zap className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{board.automaticSelectionHint || 'Auto'}</span>
                </span>
              )}
              {board.isDirty && (
                <span className={cn(
                  'text-[9px] px-1.5 py-0.5 rounded',
                  isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-600'
                )}>
                  {t('board.unsaved')}
                </span>
              )}
              {board.dbId && !board.isDirty && (
                <span className={cn(
                  'text-[9px] px-1.5 py-0.5 rounded',
                  isDark ? 'bg-green-500/20 text-green-400' : 'bg-green-100 text-green-600'
                )}>
                  {t('board.saved')}
                </span>
              )}
              {/* Package membership + "add to package". Renders nothing without
                  the packages license or on an unsaved board. */}
              <BoardPackageControl boardId={board.dbId} isDark={isDark} />
            </div>
          )}
          
          {/* Save Button */}
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-7 text-xs gap-1.5',
              isDark
                ? 'border-slate-700 hover:bg-slate-800'
                : 'border-gray-300 hover:bg-gray-100',
              board?.isDirty && 'border-amber-500/50 bg-amber-500/10'
            )}
            onClick={() => saveBoardMutation.mutate()}
            disabled={!board || saveBoardMutation.isPending || isLoadingBoard}
          >
            {saveBoardMutation.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Save className="w-3 h-3" />
            )}
            <span className="hidden sm:inline">{t('board.save')}</span>
          </Button>

          {/* Clear Board Button */}
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-7 text-xs gap-1.5',
              isDark
                ? 'border-slate-700 text-slate-400 hover:bg-red-950 hover:text-red-400 hover:border-red-800'
                : 'border-gray-300 text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-300'
            )}
            onClick={handleClearBoard}
            disabled={!board || isLoadingBoard}
          >
            <Trash2 className="w-3 h-3" />
            <span className="hidden sm:inline">{t('board.clear')}</span>
          </Button>
          
          {/* Edit/Preview Toggle */}
          <div className={cn(
            'flex rounded-lg overflow-hidden border',
            isDark ? 'border-slate-700' : 'border-gray-300'
          )}>
            <Button
              variant={isEditMode ? 'default' : 'ghost'}
              size="sm"
              className={cn(
                'h-7 text-xs rounded-none gap-1.5',
                isEditMode 
                  ? 'bg-primary text-primary-foreground' 
                  : (isDark ? 'text-slate-400' : 'text-gray-600')
              )}
              onClick={() => setEditMode(true)}
              disabled={!board || isLoadingBoard}
            >
              <Edit className="w-3 h-3" />
              <span className="hidden sm:inline">{t('board.edit')}</span>
            </Button>
            <Button
              variant={!isEditMode ? 'default' : 'ghost'}
              size="sm"
              className={cn(
                'h-7 text-xs rounded-none gap-1.5',
                !isEditMode 
                  ? 'bg-primary text-primary-foreground' 
                  : (isDark ? 'text-slate-400' : 'text-gray-600')
              )}
              onClick={() => setEditMode(false)}
              disabled={!board || isLoadingBoard}
            >
              <Eye className="w-3 h-3" />
              <span className="hidden sm:inline">{t('board.preview')}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Auto-Selection settings + (when dynamic boards enabled) Update-Automatically */}
      {board && (
        <div className="flex items-start justify-between gap-3 mt-2 px-1">
          {/* Left: AAC Auto-Select toggle + always-visible Auto-Select Hint */}
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
            <div className="flex items-center gap-2">
              <Checkbox
                id="auto-select"
                // Auto-select is meaningless without a hint telling the AI WHEN to load,
                // so it's gated on one: shown unchecked + disabled when the hint is empty
                // (even if a stale automaticSelection=true is stored, e.g. from generation).
                checked={!!(board.automaticSelectionHint ?? '').trim() && (board.automaticSelection ?? false)}
                disabled={!(board.automaticSelectionHint ?? '').trim()}
                onCheckedChange={(checked) => patchBoardMeta({ automaticSelection: !!checked })}
              />
              <Label htmlFor="auto-select" className={cn(
                'text-xs cursor-pointer',
                isDark ? 'text-slate-400' : 'text-gray-500'
              )}>
                {t('board.autoSelect') || 'AAC Auto-Select'}
              </Label>
            </div>
            {/* Corner rest space — how much of each button's corner is cut away
                so an eyegaze student has somewhere to look that selects
                nothing. Per-board: a board with small buttons and a learned
                layout wants less of it than a dynamic one. */}
            <div className="flex items-center gap-1.5">
              <Label htmlFor="rest-space" className={cn(
                'text-xs whitespace-nowrap',
                isDark ? 'text-slate-400' : 'text-gray-500'
              )}>
                {t('board.restSpace')}
              </Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className={cn(
                      'w-3.5 h-3.5 cursor-help shrink-0',
                      isDark ? 'text-slate-500' : 'text-gray-400'
                    )} />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-xs">
                    {t('board.restSpaceHint')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <select
                id="rest-space"
                className={cn(
                  'text-xs rounded border px-1.5 py-0.5',
                  isDark ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-gray-200 text-gray-700'
                )}
                value={board.restSpace ?? 'small'}
                onChange={(e) => patchBoardMeta({ restSpace: e.target.value })}
              >
                <option value="none">{t('board.restSpaceNone')}</option>
                <option value="small">{t('board.restSpaceSmall')}</option>
                <option value="large">{t('board.restSpaceLarge')}</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="auto-select-hint" className={cn(
                'text-xs whitespace-nowrap',
                isDark ? 'text-slate-400' : 'text-gray-500'
              )}>
                {t('board.autoSelectHint') || 'Auto-Select Hint'}
              </Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className={cn(
                      'w-3.5 h-3.5 cursor-help shrink-0',
                      isDark ? 'text-slate-500' : 'text-gray-400'
                    )} />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-xs">
                    {t('board.autoSelectHintTooltip') || 'If set, the AAC will load this board automatically when the specified conditions are observed.'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Input
                id="auto-select-hint"
                placeholder={t('board.autoSelectHintPlaceholder') || "e.g. 'During mealtimes'"}
                value={board.automaticSelectionHint ?? ''}
                onChange={(e) => {
                  const newHint = e.target.value;
                  const prev = useBoardStore.getState().board as any;
                  const wasEmpty = !((prev?.automaticSelectionHint ?? '') as string).trim();
                  const nowEmpty = !newHint.trim();
                  patchBoardMeta({
                    automaticSelectionHint: newHint,
                    // Auto-enable on empty→non-empty; force off when emptied (toggle also disables).
                    automaticSelection: nowEmpty ? false : (wasEmpty ? true : (prev?.automaticSelection ?? false)),
                  });
                }}
                className={cn(
                  'h-7 text-xs w-44',
                  isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-gray-300'
                )}
              />
            </div>
          </div>

          {/* Right (opposite side): Update Automatically — only when dynamic boards enabled */}
          {dynamicBoardsEnabled && (
            <div className="flex items-center gap-2 shrink-0">
              <Checkbox
                id="update-auto"
                checked={(board as any).isGenerated ?? false}
                onCheckedChange={(checked) => patchBoardMeta({ isGenerated: !!checked })}
              />
              <Label htmlFor="update-auto" className={cn(
                'text-xs cursor-pointer whitespace-nowrap',
                isDark ? 'text-slate-400' : 'text-gray-500'
              )}>
                {t('board.updateAutomatically') || 'Update Automatically'}
              </Label>
            </div>
          )}
        </div>
      )}

      {/* Unsaved Changes Dialog (board switch) */}
      <Dialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <DialogContent className={cn(
          'max-w-md',
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-200'
        )}>
          <DialogHeader>
            <DialogTitle className={cn(
              'flex items-center gap-2',
              isDark ? 'text-slate-100' : 'text-gray-900'
            )}>
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              {t('board.unsavedChanges')}
            </DialogTitle>
            <DialogDescription className={isDark ? 'text-slate-400' : 'text-gray-500'}>
              {t('board.unsavedChangesDesc')}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className={cn(
            'flex gap-2 mt-4',
            isRTL && 'flex-row-reverse'
          )}>
            <Button
              variant="outline"
              onClick={handleCancelSwitch}
              className={isDark
                ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                : 'border-gray-300 text-gray-700 hover:bg-gray-100'
              }
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmSwitch}
            >
              {t('board.discardChanges')}
            </Button>
            <Button
              onClick={handleSaveAndSwitch}
              disabled={saveBoardMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {saveBoardMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              {t('board.saveAndSwitch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved Changes Dialog (clear board) */}
      <Dialog open={showClearUnsavedDialog} onOpenChange={setShowClearUnsavedDialog}>
        <DialogContent className={cn(
          'max-w-md',
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-200'
        )}>
          <DialogHeader>
            <DialogTitle className={cn(
              'flex items-center gap-2',
              isDark ? 'text-slate-100' : 'text-gray-900'
            )}>
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              {t('board.unsavedChanges')}
            </DialogTitle>
            <DialogDescription className={isDark ? 'text-slate-400' : 'text-gray-500'}>
              {t('board.clearUnsavedDesc')}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className={cn(
            'flex gap-2 mt-4',
            isRTL && 'flex-row-reverse'
          )}>
            <Button
              variant="outline"
              onClick={() => setShowClearUnsavedDialog(false)}
              className={isDark
                ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                : 'border-gray-300 text-gray-700 hover:bg-gray-100'
              }
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmClear}
            >
              {t('board.discardAndClear')}
            </Button>
            <Button
              onClick={handleSaveAndClear}
              disabled={saveBoardMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {saveBoardMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              {t('board.saveAndClear')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}