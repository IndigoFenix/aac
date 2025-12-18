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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { 
  FolderOpen, 
  History, 
  Sparkles, 
  Edit, 
  Eye, 
  Save,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useBoardStore } from '@/store/board-store';
import { useSharedState } from '@/contexts/FeaturePanelContext';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { BoardIR } from '@/types/board-ir';

type BoardMode = 'generate' | 'select' | 'history';

export function BoardSelector() {
  const [mode, setMode] = useState<BoardMode>('generate');
  const [pendingSwitchBoardId, setPendingSwitchBoardId] = useState<string | null>(null);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [isLoadingBoard, setIsLoadingBoard] = useState(false);
  
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
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

  // ============================================================================
  // LOAD BOARDS LIST FROM SERVER (metadata only, no irData)
  // ============================================================================
  
  useQuery({
    queryKey: ['/api/boards'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/boards');
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
      
      const payload = {
        name: board.name,
        irData,
      };
      
      // Use PATCH for existing boards, POST for new ones
      if (board.dbId) {
        const res = await apiRequest('PATCH', `/api/boards/${board.dbId}`, payload);
        if (!res.ok) {
          throw new Error('Failed to update board');
        }
        return res.json() as Promise<{ id: string; name: string }>;
      } else {
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
  // RENDER
  // ============================================================================

  return (
    <>
      <div className={cn(
        'flex items-center justify-between gap-4 flex-wrap',
        isRTL && 'flex-row-reverse'
      )}>
        {/* Left side: Mode selector and board picker */}
        <div className={cn(
          'flex items-center gap-3',
          isRTL && 'flex-row-reverse'
        )}>
          {/* Mode Tabs */}
          <Tabs value={mode} onValueChange={(v) => setMode(v as BoardMode)}>
            <TabsList className={cn(
              'h-8',
              isDark ? 'bg-slate-800' : 'bg-gray-100'
            )}>
              <TabsTrigger 
                value="generate" 
                className={cn(
                  'h-7 px-3 text-xs gap-1.5',
                  isRTL && 'flex-row-reverse'
                )}
              >
                <Sparkles className="w-3 h-3" />
                <span className="hidden sm:inline">{t('board.modes.generate')}</span>
              </TabsTrigger>
              <TabsTrigger 
                value="select" 
                className={cn(
                  'h-7 px-3 text-xs gap-1.5',
                  isRTL && 'flex-row-reverse'
                )}
              >
                <FolderOpen className="w-3 h-3" />
                <span className="hidden sm:inline">{t('board.modes.select')}</span>
              </TabsTrigger>
              <TabsTrigger 
                value="history" 
                className={cn(
                  'h-7 px-3 text-xs gap-1.5',
                  isRTL && 'flex-row-reverse'
                )}
              >
                <History className="w-3 h-3" />
                <span className="hidden sm:inline">{t('board.modes.history')}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Board picker (when in select mode) */}
          {mode === 'select' && (
            <Select
              value={board?._id || ''}
              onValueChange={handleBoardSwitch}
              disabled={isLoadingBoard}
            >
              <SelectTrigger className={cn(
                'w-[180px] h-8 text-xs',
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
                      <div className="flex items-center gap-2">
                        <span>{b.name}</span>
                        {b.isDirty && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-500">
                            •
                          </span>
                        )}
                        {!b.loadedFromServer && b.dbId && (
                          <span className={cn(
                            'text-[9px] px-1 py-0.5 rounded',
                            isDark ? 'bg-slate-700 text-slate-400' : 'bg-gray-200 text-gray-500'
                          )}>
                            {t('board.notLoaded')}
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
          )}

          {/* Generate mode hint */}
          {mode === 'generate' && (
            <p className={cn(
              'text-xs hidden md:block',
              isDark ? 'text-slate-400' : 'text-gray-500'
            )}>
              {t('board.prompt.description')}
            </p>
          )}
        </div>

        {/* Right side: Board info, Save button, and Edit/Preview toggle */}
        <div className={cn(
          'flex items-center gap-2',
          isRTL && 'flex-row-reverse'
        )}>
          {/* Board name and status */}
          {board && (
            <div className={cn(
              'flex items-center gap-2 mr-2',
              isRTL && 'mr-0 ml-2 flex-row-reverse'
            )}>
              <span className={cn(
                'text-xs',
                isDark ? 'text-slate-400' : 'text-gray-500'
              )}>
                {board.name}
              </span>
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

      {/* Unsaved Changes Dialog */}
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
    </>
  );
}