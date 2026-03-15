// src/features/SyntAACxPanel.tsx
// This is the sliding panel version of SyntAACx that contains the board canvas and export bar

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Cloud, CloudDownload, Check, AlertCircle, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { BoardCanvas } from '@/components/syntAACx/board-canvas';
import { ButtonInspector } from '@/components/syntAACx/button-inspector';
import { BoardSelector } from '@/components/syntAACx/BoardSelector';
import { useBoardStore } from '@/store/board-store';
import { useSharedState, useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

interface DropboxFile {
  name: string;
  path: string;
  size: number;
  modified: string;
}

interface BoardExportStatus {
  exported: boolean;
  lastExportedAt?: string;
  fileName?: string;
  shareableUrl?: string;
}

interface SyntAACxPanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

export function SyntAACxPanel({ isOpen, onClose }: SyntAACxPanelProps) {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const { user } = useAuth();
  const { board, currentPageId, validation, isEditMode, setBoard } = useBoardStore();
  const { toast } = useToast();
  const { sharedState, setSharedState } = useSharedState();
  const { registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();
  const queryClient = useQueryClient();

  const [importModalOpen, setImportModalOpen] = useState(false);
  const [selectedImportFile, setSelectedImportFile] = useState<DropboxFile | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  // Check if board is currently loading (set by BoardSelector)
  const isBoardLoading = sharedState.isBoardLoading === true;

  // Register metadata builder for the boards feature
  // This sends the current board state with each chat message
  const buildBoardsMetadata = useCallback(() => {
    // Build featureContext for the backend sessionService
    const featureContext: Record<string, any> = {
      board: {}
    };

    if (board) {
      // Send the full board data so the LLM can view and modify it
      featureContext.board = {
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
      featureContext.board = {
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

      // New featureContext for backend processing
      featureContext,
    };
  }, [board, currentPageId]);

  // Register/unregister metadata builder
  useEffect(() => {
    registerMetadataBuilder('boards', buildBoardsMetadata);

    return () => {
      unregisterMetadataBuilder('boards');
    };
  }, [registerMetadataBuilder, unregisterMetadataBuilder, buildBoardsMetadata]);

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

  // Check export status for current board
  const { data: exportStatus } = useQuery<BoardExportStatus>({
    queryKey: ['/api/integrations/dropbox/board-status', board?.name],
    queryFn: async () => {
      if (!board?.name) return { exported: false };
      const res = await apiRequest('GET', `/api/integrations/dropbox/board-status/${encodeURIComponent(board.name)}`);
      return res.json();
    },
    enabled: !!user && !!board?.name && !!dropboxConnection?.connected,
  });

  // List files from Dropbox for import
  const { data: dropboxFiles, isLoading: isLoadingFiles } = useQuery<{ files: DropboxFile[] }>({
    queryKey: ['/api/integrations/dropbox/files'],
    enabled: importModalOpen && !!dropboxConnection?.connected,
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
      // Refresh export status
      if (board?.name) {
        queryClient.invalidateQueries({ queryKey: ['/api/integrations/dropbox/board-status', board.name] });
      }
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

  // Import from Dropbox
  const handleImport = async () => {
    if (!selectedImportFile) return;
    setIsImporting(true);

    try {
      const res = await apiRequest('POST', '/api/integrations/dropbox/download', {
        filePath: selectedImportFile.path,
      });
      const { fileData } = await res.json();

      // Decode base64 to ArrayBuffer
      const binary = atob(fileData);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const { GridsetImporter } = await import('@/lib/packagers');
      const importedBoard = await GridsetImporter.import(bytes.buffer);

      setBoard(importedBoard);
      setImportModalOpen(false);
      setSelectedImportFile(null);

      toast({
        title: t('export.importSuccess'),
        description: t('export.importSuccessDesc', { name: importedBoard.name }),
      });
    } catch (error) {
      console.error('Import failed:', error);
      toast({
        title: t('export.importFailed'),
        description: (error as Error).message,
        variant: 'destructive',
      });
    } finally {
      setIsImporting(false);
    }
  };

  // Board-was-updated-since-export indicator
  const boardUpdatedSinceExport = (() => {
    if (!exportStatus?.exported || !exportStatus.lastExportedAt) return false;
    // We can't precisely know when the board was last edited client-side,
    // but we mark the board as "dirty" if it has unsaved changes
    return (board as any)?.isDirty === true;
  })();

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

      {/* Header - Board Selector Bar */}
      <div className={cn(
        'border-b px-4 py-2 shrink-0',
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-200',
        isBoardLoading && 'opacity-50 pointer-events-none'
      )}>
        <BoardSelector />
      </div>

      {/* Main Content - Board Canvas with optional Button Inspector */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className={cn('flex h-full', isRTL && 'flex-row-reverse')}>
          {/* Board Canvas - main content */}
          <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
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

          {/* Dropbox export status */}
          {dropboxConnection?.connected && exportStatus?.exported && (
            <div className={cn(
              'flex items-center gap-1 text-xs',
              boardUpdatedSinceExport
                ? (isDark ? 'text-amber-400' : 'text-amber-600')
                : (isDark ? 'text-emerald-400' : 'text-emerald-600'),
              isRTL && 'flex-row-reverse'
            )}>
              {boardUpdatedSinceExport ? (
                <AlertCircle size={12} />
              ) : (
                <Check size={12} />
              )}
              <span>
                {boardUpdatedSinceExport
                  ? t('export.updatedSinceExport')
                  : t('export.synced')}
              </span>
            </div>
          )}
        </div>

        {/* Export Buttons */}
        <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
          {/* Import from Dropbox */}
          {dropboxConnection?.connected && (
            <Button
              onClick={() => setImportModalOpen(true)}
              disabled={isBoardLoading}
              size="sm"
              variant="outline"
              className={cn(
                'h-7 text-xs gap-1',
                isDark
                  ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-100'
              )}
            >
              <CloudDownload size={12} />
              {t('export.importFromDropbox')}
            </Button>
          )}

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
                {uploadToDropbox.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Cloud size={12} />
                )}
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
                {uploadToDropbox.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Cloud size={12} />
                )}
              </Button>
            )}
          </div>
        </div>
      </footer>

      {/* Import from Dropbox modal */}
      <Dialog open={importModalOpen} onOpenChange={setImportModalOpen}>
        <DialogContent className={cn(
          'max-w-md',
          isDark ? 'bg-slate-900 border-slate-700' : ''
        )}>
          <DialogHeader>
            <DialogTitle>{t('export.importFromDropbox')}</DialogTitle>
            <DialogDescription>{t('export.importDesc')}</DialogDescription>
          </DialogHeader>

          <div className="max-h-64 overflow-y-auto space-y-1">
            {isLoadingFiles ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : !dropboxFiles?.files?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {t('export.noFilesFound')}
              </p>
            ) : (
              dropboxFiles.files.map((file) => (
                <button
                  key={file.path}
                  onClick={() => setSelectedImportFile(file)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-md text-sm transition-colors',
                    selectedImportFile?.path === file.path
                      ? (isDark ? 'bg-blue-900/50 text-blue-300' : 'bg-blue-50 text-blue-700')
                      : (isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-gray-100 text-gray-700'),
                    isRTL && 'text-right'
                  )}
                >
                  <div className="font-medium">{file.name}</div>
                  <div className={cn(
                    'text-xs mt-0.5',
                    isDark ? 'text-slate-500' : 'text-gray-500'
                  )}>
                    {(file.size / 1024).toFixed(1)} KB
                    {file.modified && ` · ${new Date(file.modified).toLocaleDateString()}`}
                  </div>
                </button>
              ))
            )}
          </div>

          <div className={cn(
            'text-xs p-2 rounded',
            isDark ? 'bg-amber-900/30 text-amber-300' : 'bg-amber-50 text-amber-700'
          )}>
            {t('export.importWarning')}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setImportModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleImport}
              disabled={!selectedImportFile || isImporting}
            >
              {isImporting ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              {t('export.importButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
