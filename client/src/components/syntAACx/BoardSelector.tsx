// src/components/syntAACx/BoardSelector.tsx
// This component appears as a bar below the chat when in SyntAACx mode

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FolderOpen, History, Sparkles, Edit, Eye } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useBoardStore } from '@/store/board-store';
import { useSharedState } from '@/contexts/FeaturePanelContext';
import { cn } from '@/lib/utils';

type BoardMode = 'generate' | 'select' | 'history';

export function BoardSelector() {
  const [mode, setMode] = useState<BoardMode>('generate');
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { board, boards, selectBoardById, setEditMode, isEditMode } = useBoardStore();
  const { setSharedState } = useSharedState();

  // When in generate mode, prompts go through the chat
  const handleGeneratePrompt = (prompt: string) => {
    setSharedState({ pendingPrompt: prompt });
  };

  return (
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
            onValueChange={(boardId) => {
              if (boardId) {
                selectBoardById(boardId);
              }
            }}
          >
            <SelectTrigger className={cn(
              'w-[180px] h-8 text-xs',
              isDark 
                ? 'bg-slate-800 border-slate-700' 
                : 'bg-white border-gray-300'
            )}>
              <SelectValue placeholder={t('board.selectBoard')} />
            </SelectTrigger>
            <SelectContent>
              {boards && boards.length > 0 ? (
                boards.map((b) => (
                  <SelectItem key={b._id} value={b._id}>
                    {b.name}
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

      {/* Right side: Edit/Preview toggle */}
      <div className={cn(
        'flex items-center gap-2',
        isRTL && 'flex-row-reverse'
      )}>
        {board && (
          <span className={cn(
            'text-xs mr-2',
            isDark ? 'text-slate-400' : 'text-gray-500'
          )}>
            {board.name}
          </span>
        )}
        
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
            disabled={!board}
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
            disabled={!board}
          >
            <Eye className="w-3 h-3" />
            <span className="hidden sm:inline">{t('board.preview')}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}