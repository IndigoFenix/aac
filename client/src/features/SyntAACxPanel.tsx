// src/features/SyntAACxPanel.tsx
// This is the sliding panel version of SyntAACx that contains the board canvas and export bar

import { useEffect, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Cloud, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { BoardCanvas } from '@/components/syntAACx/board-canvas';
import { ButtonInspector } from '@/components/syntAACx/button-inspector';
import { useBoardStore } from '@/store/board-store';
import { useSharedState, useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

interface SyntAACxPanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

export function SyntAACxPanel({ isOpen, onClose }: SyntAACxPanelProps) {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  
  const { user } = useAuth();
  const { board, currentPageId, validation, isEditMode } = useBoardStore();
  const { toast } = useToast();
  const { sharedState, setSharedState } = useSharedState();
  const { registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();

  // Check if board is currently loading (set by BoardSelector)
  const isBoardLoading = sharedState.isBoardLoading === true;

  // Register metadata builder for the boards feature
  // This sends the current board state with each chat message
  const buildBoardsMetadata = useCallback(() => {
    // Build modeContext for the backend sessionService
    const modeContext: Record<string, any> = {
      board: {}
    };

    if (board) {
      // Send the full board data so the LLM can view and modify it
      modeContext.board = {
        data: board,
        currentPageId: currentPageId || board.pages?.[0]?.id,
      };
      console.log('[SyntAACxPanel] Building metadata with board:', {
        name: board.name,
        pageCount: board.pages?.length,
        buttonCount: board.pages?.reduce((sum: number, p: any) => sum + (p.buttons?.length || 0), 0),
        currentPageId: currentPageId || board.pages?.[0]?.id,
      });
    } else {
      // No board yet - request default grid size for new board creation
      modeContext.board = {
        requestedGridSize: { rows: 4, cols: 4 }
      };
      console.log('[SyntAACxPanel] Building metadata without board (new board request)');
    }

    return {
      // Legacy metadata for display purposes
      gridSize: board?.grid,
      boardContext: board ? {
        name: board.name,
        pageCount: board.pages?.length || 0,
        currentPageName: board.pages?.find((p: any) => p.id === currentPageId)?.name,
      } : undefined,
      currentPageId: currentPageId,
      
      // New modeContext for backend processing
      modeContext,
    };
  }, [board, currentPageId]);

  // Register/unregister metadata builder
  useEffect(() => {
    registerMetadataBuilder('boards', buildBoardsMetadata);
    
    return () => {
      unregisterMetadataBuilder('boards');
    };
  }, [registerMetadataBuilder, unregisterMetadataBuilder, buildBoardsMetadata]);

  // NOTE: Board data from chat responses is now handled by BoardSelector
  // This prevents duplicate processing and the issue of creating new boards
  // instead of updating existing ones.

  // Sync board state with shared state (for other components that need it)
  useEffect(() => {
    if (board) {
      setSharedState({ currentBoard: board });
    }
  }, [board, setSharedState]);

  // Check Dropbox connection status
  const { data: dropboxConnection } = useQuery<{ connected: boolean }>({
    queryKey: ['/api/integrations/dropbox/status'],
    enabled: !!user,
  });

  // Helper function to convert blob to base64
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        const base64Data = base64.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Export handlers
  const handleExportGridset = async () => {
    if (!board) return;
    const { GridsetPackager, downloadFile } = await import('@/lib/packagers');
    try {
      const blob = await GridsetPackager.package(board);
      const filename = `${board.name.replace(/[<>:"/\\|?*]/g, '_')}.gridset`;
      downloadFile(blob, filename);
    } catch (error) {
      console.error('Export failed:', error);
    }
  };

  const handleExportSnappkg = async () => {
    if (!board) return;
    const { SnappkgPackager, downloadFile } = await import('@/lib/packagers');
    try {
      const blob = await SnappkgPackager.package(board);
      const filename = `${board.name.replace(/[<>:"/\\|?*]/g, '_')}.snappkg`;
      downloadFile(blob, filename);
    } catch (error) {
      console.error('Export failed:', error);
    }
  };

  const handleExportOBZ = async () => {
    if (!board) return;
    const { OBZPackager, downloadFile } = await import('@/lib/packagers');
    try {
      const blob = await OBZPackager.package(board);
      const filename = `${board.name.replace(/[<>:"/\\|?*]/g, '_')}.obz`;
      downloadFile(blob, filename);
    } catch (error) {
      console.error('OBZ export failed:', error);
    }
  };

  // Upload mutation
  const uploadToDropbox = useMutation({
    mutationFn: async ({
      fileType,
      fileData,
      fileName,
    }: {
      fileType: string;
      fileData: string;
      fileName: string;
    }) => {
      if (!board) throw new Error('No board available');

      const response = await apiRequest('POST', '/api/integrations/dropbox/upload', {
        boardId: board.name,
        fileType,
        fileName,
        fileData,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: t('export.uploadSuccess'),
        description: t('export.uploadSuccessDesc'),
      });
    },
    onError: (error) => {
      toast({
        title: t('export.uploadFailed'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleUploadGridset = async () => {
    if (!board || !dropboxConnection?.connected) return;
    try {
      const { GridsetPackager } = await import('@/lib/packagers');
      const blob = await GridsetPackager.package(board);
      const fileData = await blobToBase64(blob);
      const fileName = `${board.name.replace(/[<>:"/\\|?*]/g, '_')}.gridset`;
      uploadToDropbox.mutate({ fileType: 'gridset', fileData, fileName });
    } catch (error) {
      console.error('Upload failed:', error);
    }
  };

  const handleUploadSnappkg = async () => {
    if (!board || !dropboxConnection?.connected) return;
    try {
      const { SnappkgPackager } = await import('@/lib/packagers');
      const blob = await SnappkgPackager.package(board);
      const fileData = await blobToBase64(blob);
      const fileName = `${board.name.replace(/[<>:"/\\|?*]/g, '_')}.snappkg`;
      uploadToDropbox.mutate({ fileType: 'snappkg', fileData, fileName });
    } catch (error) {
      console.error('Upload failed:', error);
    }
  };

  const handleUploadOBZ = async () => {
    if (!board || !dropboxConnection?.connected) return;
    try {
      const { OBZPackager } = await import('@/lib/packagers');
      const blob = await OBZPackager.package(board);
      const fileData = await blobToBase64(blob);
      const fileName = `${board.name.replace(/[<>:"/\\|?*]/g, '_')}.obz`;
      uploadToDropbox.mutate({ fileType: 'obz', fileData, fileName });
    } catch (error) {
      console.error('Upload failed:', error);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={cn(
      'flex flex-col h-full min-h-0',
      isDark ? 'bg-slate-950' : 'bg-gray-50'
    )}>
      {/* Loading Overlay */}
      {isBoardLoading && (
        <div className={cn(
          'absolute inset-0 z-50 flex flex-col items-center justify-center',
          isDark ? 'bg-slate-950/90' : 'bg-gray-50/90'
        )}>
          <div className={cn(
            'flex flex-col items-center gap-4 p-8 rounded-xl',
            isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-gray-200 shadow-lg'
          )}>
            <Loader2 className={cn(
              'w-10 h-10 animate-spin',
              isDark ? 'text-blue-400' : 'text-blue-600'
            )} />
            <div className="text-center">
              <h3 className={cn(
                'text-lg font-medium',
                isDark ? 'text-slate-200' : 'text-gray-800'
              )}>
                {t('board.loadingBoard')}
              </h3>
              <p className={cn(
                'text-sm mt-1',
                isDark ? 'text-slate-400' : 'text-gray-500'
              )}>
                {t('board.loadingBoardDesc')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Main Content - Board Canvas with optional Button Inspector */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className={cn('flex h-full', isRTL && 'flex-row-reverse')}>
          {/* Board Canvas - main content */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <BoardCanvas />
          </div>

          {/* Button Inspector - only in edit mode */}
          {isEditMode && !isBoardLoading && (
            <div className={cn(
              'w-72 shrink-0 border-l overflow-y-auto',
              isDark ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white',
              isRTL && 'border-l-0 border-r'
            )}>
              <ButtonInspector />
            </div>
          )}
        </div>
      </div>

      {/* Footer - Export Bar */}
      <footer
        className={cn(
          'border-t px-4 py-3 flex items-center justify-between shrink-0',
          isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-200',
          !isEditMode && 'opacity-90',
          isRTL && 'flex-row-reverse',
          isBoardLoading && 'opacity-50 pointer-events-none'
        )}
      >
        {/* Status */}
        <div className={cn('flex items-center gap-4', isRTL && 'flex-row-reverse')}>
          <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
            <div
              className={cn(
                'w-2 h-2 rounded-full',
                validation.isValid ? 'bg-emerald-500' : 'bg-red-500'
              )}
            />
            <span className={cn(
              'text-xs',
              isDark ? 'text-slate-400' : 'text-gray-600'
            )}>
              {validation.isValid ? t('board.valid') : t('board.hasErrors')}
            </span>
          </div>

          <div className={cn(
            'text-xs',
            isDark ? 'text-slate-500' : 'text-gray-500'
          )}>
            {board?.pages.length || 0} {t('board.pages')} •{' '}
            {board?.pages.reduce(
              (total: number, page: any) => total + page.buttons.length,
              0
            ) || 0}{' '}
            {t('board.buttons')}
          </div>
        </div>

        {/* Export Buttons */}
        <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
          {/* Grid3 */}
          <div className={cn('flex items-center gap-0.5', isRTL && 'flex-row-reverse')}>
            <Button
              onClick={handleExportGridset}
              disabled={!board || !validation.isValid || isBoardLoading}
              size="sm"
              className="h-7 text-xs bg-blue-600 hover:bg-blue-700"
            >
              .gridset
            </Button>
            {dropboxConnection?.connected && (
              <Button
                onClick={handleUploadGridset}
                disabled={!board || !validation.isValid || uploadToDropbox.isPending || isBoardLoading}
                size="icon"
                variant="outline"
                className={cn(
                  'h-7 w-7',
                  isDark 
                    ? 'border-slate-700 text-slate-400 hover:bg-slate-800'
                    : 'border-gray-300 text-gray-500 hover:bg-gray-100'
                )}
              >
                <Cloud size={12} />
              </Button>
            )}
          </div>

          {/* TD Snap */}
          <div className={cn('flex items-center gap-0.5', isRTL && 'flex-row-reverse')}>
            <Button
              onClick={handleExportSnappkg}
              disabled={!board || !validation.isValid || isBoardLoading}
              size="sm"
              className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700"
            >
              .snappkg
            </Button>
            {dropboxConnection?.connected && (
              <Button
                onClick={handleUploadSnappkg}
                disabled={!board || !validation.isValid || uploadToDropbox.isPending || isBoardLoading}
                size="icon"
                variant="outline"
                className={cn(
                  'h-7 w-7',
                  isDark 
                    ? 'border-slate-700 text-slate-400 hover:bg-slate-800'
                    : 'border-gray-300 text-gray-500 hover:bg-gray-100'
                )}
              >
                <Cloud size={12} />
              </Button>
            )}
          </div>

          {/* OBZ */}
          <div className={cn('flex items-center gap-0.5', isRTL && 'flex-row-reverse')}>
            <Button
              onClick={handleExportOBZ}
              disabled={!board || !validation.isValid || isBoardLoading}
              size="sm"
              className="h-7 text-xs bg-orange-600 hover:bg-orange-700"
            >
              .obz
            </Button>
            {dropboxConnection?.connected && (
              <Button
                onClick={handleUploadOBZ}
                disabled={!board || !validation.isValid || uploadToDropbox.isPending || isBoardLoading}
                size="icon"
                variant="outline"
                className={cn(
                  'h-7 w-7',
                  isDark 
                    ? 'border-slate-700 text-slate-400 hover:bg-slate-800'
                    : 'border-gray-300 text-gray-500 hover:bg-gray-100'
                )}
              >
                <Cloud size={12} />
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}