// src/components/syntAACx/BoardSelector.tsx
// This component appears as a bar below the chat when in SyntAACx mode

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
  UserPlus,
  Lock,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useBoardStore, resolveAutomaticSelection } from '@/store/board-store';
import { useSharedState, useFeaturePanel } from '@/contexts/FeaturePanelContext';
import type { FeatureType } from '@shared/schema';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import type { BoardLibraryResponse } from '@shared/board-library';
import { BoardPackageControl } from './BoardPackageControl';
import { useBoardSave } from './use-board-save';

/** What to call a {{student}} in a sentence — first name if we have one. */
const studentDisplayName = (s: any): string => s?.firstName || s?.name || '';

export function BoardSelector() {
  const [pendingSwitchBoardId, setPendingSwitchBoardId] = useState<string | null>(null);
  // Leaving the panel altogether raises the SAME dialog as switching boards —
  // walking away from unsaved work loses it either way. Exactly one of these
  // two is set while the dialog is open, and it says what "continue" means.
  const [pendingLeaveFeature, setPendingLeaveFeature] = useState<FeatureType | null>(null);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showClearUnsavedDialog, setShowClearUnsavedDialog] = useState(false);
  const [isLoadingBoard, setIsLoadingBoard] = useState(false);
  
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { student, selectStudent } = useStudent();
  const { currentInstitute } = useInstitute();
  const instituteId = currentInstitute?.id;

  const { 
    board, 
    boards, 
    activeBoardId,
    selectBoardById, 
    setEditMode, 
    isEditMode,
    hydrateBoardsFromServer,
    openBoardFromServer,
    updateBoard,
    setBoard,
  } = useBoardStore();
  
  const { sharedState, setSharedState } = useSharedState();
  const { setActiveFeature, registerNavigationGuard, unregisterNavigationGuard } = useFeaturePanel();

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

  // ONE request, already grouped and already permission-resolved: the server
  // decides which section a board belongs to and whether this user may save it.
  // The client used to stitch two endpoints together and guess the grouping
  // from row fields, which is what made the picker unreadable — a colleague's
  // board for this child was missing while every stray draft showed up under
  // every child.
  //
  // With no {{student}} selected this is the whole institute (Not assigned /
  // each package / each {{student}}); with one selected it is what that child
  // can actually open (their own boards, then their packages).
  const { data: library, isFetching: libraryFetching } = useQuery<BoardLibraryResponse>({
    queryKey: ['/api/boards/library', instituteId ?? 'none', student?.id ?? 'all'],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (instituteId) params.set('instituteId', instituteId);
      if (student?.id) params.set('studentId', student.id);
      const res = await apiRequest('GET', `/api/boards/library?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load boards');
      const data: BoardLibraryResponse = await res.json();
      hydrateBoardsFromServer(data.groups.flatMap((g) => g.boards) as any);
      return data;
    },
    staleTime: 30000, // Consider data fresh for 30 seconds
  });

  /** Every board id the server just listed, in the order it listed them. */
  const listedBoardIds = useMemo(
    () => new Set((library?.groups ?? []).flatMap((g) => g.boards.map((b) => b.id))),
    [library],
  );

  // The picker's sections, in the server's order. Boards are resolved back to
  // their store entries (which carry the local _id the <Select> keys on) and a
  // board the store hasn't caught up with yet is simply skipped rather than
  // rendered as a blank row.
  const renderGroups = useMemo(() => {
    const byDbId = new Map(boards.filter((b) => b.dbId).map((b) => [b.dbId as string, b]));

    const sections = (library?.groups ?? []).map((g) => ({
      key: `${g.kind}:${g.id ?? 'none'}`,
      label:
        g.kind === 'unassigned'
          ? t('board.groupNotAssigned')
          : g.kind === 'student'
            ? t('board.groupStudentBoards', { name: g.name })
            : g.name,
      readOnly: g.kind === 'package' && !g.canEdit,
      boards: g.boards.map((b) => byDbId.get(b.id)).filter(Boolean) as typeof boards,
    }));

    // A board that was never saved lives only in the store, so no server
    // section can hold it. It still has to be reachable — losing the board you
    // are working on out of the picker is worse than an extra heading.
    const unsaved = boards.filter((b) => !b.dbId);
    if (unsaved.length) {
      sections.push({
        key: 'unsaved',
        label: t('board.groupUnsaved'),
        readOnly: false,
        boards: unsaved,
      });
    }
    return sections.filter((s) => s.boards.length > 0);
  }, [library, boards, t]);

  /** The open board is a draft we could attach to the loaded student. */
  const canAttachToStudent =
    !!board?.dbId && !(board as any).studentId && !(board as any).packageName && !!student?.id;

  /**
   * The open board must always be one the header's {{student}} could actually
   * open. When it is not — the board belongs to another child, or to a package
   * this one does not have — the {{student}} is cleared rather than the board,
   * because the board is what the user is working on. The picker then falls
   * back to the whole-institute view, where the board is listed.
   *
   * Gated on a settled library: mid-fetch the list is simply not the answer yet.
   */
  useEffect(() => {
    if (!student?.id || !board?.dbId || !library || libraryFetching) return;
    // A board attached to THIS child is theirs by definition. Checked before
    // the list so a board that was just saved for them cannot clear them while
    // the refetch is still on its way.
    if ((board as any).studentId === student.id) return;
    if (listedBoardIds.has(board.dbId)) return;
    void selectStudent(null);
    toast({
      title: t('board.studentCleared'),
      description: t('board.studentClearedDesc', { name: studentDisplayName(student) }),
    });
  }, [
    student,
    board?.dbId,
    (board as any)?.studentId,
    library,
    libraryFetching,
    listedBoardIds,
    selectStudent,
    toast,
    t,
  ]);

  const attachToStudentMutation = useMutation({
    mutationFn: async () => {
      if (!board?.dbId || !student?.id) throw new Error('');
      const res = await apiRequest('PATCH', `/api/boards/${board.dbId}`, { studentId: student.id });
      if (!res.ok) {
        // The server's refusals here are specific and worth showing — no
        // access to this student, already attached to a different one. Same
        // "error:CODE" → errors.CODE convention the chat surfaces use.
        const code = await res
          .json()
          .then((b: any) => (typeof b?.error === 'string' && b.error.startsWith('error:') ? b.error.slice(6) : ''))
          .catch(() => '');
        throw new Error(code ? t(`errors.${code}`) : '');
      }
      return res.json();
    },
    onSuccess: () => {
      // NOT patchBoardMeta — attaching is already persisted, and that helper
      // forces isDirty, which would make a just-saved board look unsaved.
      useBoardStore.setState((state) => {
        const current = state.board;
        if (!current) return state;
        const updated = { ...current, studentId: student?.id } as any;
        return {
          board: updated,
          boards: state.boards.map((b: any) => (b._id === updated._id ? updated : b)),
        };
      });
      queryClient.invalidateQueries({ queryKey: ['/api/boards/library'] });
      toast({
        title: t('board.attached'),
        description: t('board.attachedDesc', { name: student?.firstName || student?.name || '' }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t('board.attachFailed'),
        description: error?.message || t('board.attachFailedDesc'),
        variant: 'destructive',
      });
    },
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

  const loadFullBoardData = useCallback(async (boardMeta: { _id: string; dbId?: string; loadedFromServer?: boolean; packageName?: string; canEdit?: boolean }) => {
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
        isGenerated: fullBoard.isGenerated,
        studentId: fullBoard.studentId,
        instituteId: fullBoard.instituteId,
        // The board row knows nothing about packages, nor about what THIS user
        // may do with it; both come from the picker list.
        packageName: boardMeta.packageName,
        canEdit: boardMeta.canEdit,
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
  // SAVE BOARD  (the button itself lives in the panel footer)
  // ============================================================================

  const saveBoard = useBoardSave();

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
      setPendingLeaveFeature(null);
      setPendingSwitchBoardId(boardId);
      setShowUnsavedDialog(true);
      return;
    }
    
    // No unsaved changes, load and switch
    loadFullBoardData(targetBoard);
  }, [board?.isDirty, boards, isLoadingBoard, loadFullBoardData]);

  /** Carry out whichever departure the dialog interrupted, then close it. */
  const runPendingDeparture = useCallback(() => {
    if (pendingSwitchBoardId) {
      const targetBoard = boards.find(b => b._id === pendingSwitchBoardId);
      if (targetBoard) {
        loadFullBoardData(targetBoard);
      }
    } else if (pendingLeaveFeature) {
      // `force` — the guard that raised this dialog would otherwise block the
      // very navigation the user just confirmed.
      setActiveFeature(pendingLeaveFeature, { force: true });
    }
    setPendingSwitchBoardId(null);
    setPendingLeaveFeature(null);
    setShowUnsavedDialog(false);
  }, [pendingSwitchBoardId, pendingLeaveFeature, boards, loadFullBoardData, setActiveFeature]);

  const handleConfirmSwitch = runPendingDeparture;

  const handleSaveAndSwitch = useCallback(async () => {
    try {
      await saveBoard.saveAsync();
      runPendingDeparture();
    } catch {
      // Save failed (the mutation already toasted) — keep the user here with
      // their changes rather than dropping them on the way out.
      setPendingSwitchBoardId(null);
      setPendingLeaveFeature(null);
      setShowUnsavedDialog(false);
    }
  }, [saveBoard, runPendingDeparture]);

  const handleCancelSwitch = useCallback(() => {
    setPendingSwitchBoardId(null);
    setPendingLeaveFeature(null);
    setShowUnsavedDialog(false);
  }, []);

  // Leaving the boards panel with an unsaved board raises the same dialog as
  // switching boards. Registered while this component is mounted, which is
  // exactly while the panel is open.
  useEffect(() => {
    registerNavigationGuard('boards', (target) => {
      if (!useBoardStore.getState().board?.isDirty) return false;
      setPendingSwitchBoardId(null);
      setPendingLeaveFeature(target);
      setShowUnsavedDialog(true);
      return true;
    });
    return () => unregisterNavigationGuard('boards');
  }, [registerNavigationGuard, unregisterNavigationGuard]);

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
      await saveBoard.saveAsync();
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
  }, [saveBoard]);

  // ============================================================================
  // RENDER
  // ============================================================================

  const studentName = studentDisplayName(student);

  /** Shared content this user may open but not change. Resolved by the same
   *  hook the footer's Save button uses, so the badge here and the disabled
   *  button there can never disagree. */
  const isReadOnlyBoard = saveBoard.isReadOnly;

  /** One labelled section of the picker. Renders nothing when empty, so a
   *  clinician with no drafts never sees an empty "not attached" heading. */
  const renderBoardGroup = (label: string, group: typeof boards, readOnly = false) => {
    if (!group.length) return null;
    return (
      <SelectGroup>
        <SelectLabel className={cn(
          'text-[10px] uppercase tracking-wide flex items-center gap-1',
          isDark ? 'text-slate-500' : 'text-gray-400'
        )}>
          <span className="truncate">{label}</span>
          {/* A package this user may use but not edit. Saying so at the
              heading is why the greyed-out Save further along makes sense. */}
          {readOnly && <Lock className="w-2.5 h-2.5 shrink-0" />}
        </SelectLabel>
        {group.map((b) => (
          <SelectItem key={b._id} value={b._id}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate">{b.name}</span>
              {b.automaticSelection && (
                <span
                  className="text-[9px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-500 flex items-center gap-1 max-w-[140px] shrink-0"
                  title={b.automaticSelectionHint || undefined}
                >
                  <Zap className="w-2.5 h-2.5 shrink-0" />
                  {false && b.automaticSelectionHint && (
                    <span className="truncate">{b.automaticSelectionHint}</span>
                  )}
                </span>
              )}
              {/* No package badge here: the board is already sitting under
                  that package's heading, so the name would just be said twice
                  in a row that has no width to spare. */}
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
        ))}
      </SelectGroup>
    );
  };

  return (
    <>
      {/* The document is dir="rtl" in RTL mode, so flex rows already reverse —
          do NOT add flex-row-reverse here or it double-flips back to LTR. */}
      {/* Row 1: WHICH board (picker + clear) at the start, WHOSE it is
          (ownership badges + package controls) at the end. Saving is not here —
          it lives in the panel footer, where the board's status is reported. */}
      <div className="flex items-center justify-between gap-4">
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
              {renderGroups.length > 0 ? (
                renderGroups.map((group) => (
                  <Fragment key={group.key}>
                    {renderBoardGroup(group.label, group.boards, group.readOnly)}
                  </Fragment>
                ))
              ) : (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {library && !library.canCreate ? t('board.noInstitute') : t('board.noBoards')}
                </div>
              )}
            </SelectContent>
          </Select>

          {/* Clear sits with the picker because that is what it does: it
              unselects whatever the picker selected. */}
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
        </div>

        {/* Right: who this board belongs to, and the actions that change
            that. The picker on the left says WHICH board; this says WHOSE. */}
        <div className="flex items-center gap-2">
          {/* Only the surprising state gets a badge: saying "this belongs to
              the {{student}} you have open" on every board would be noise, but
              a board that belongs to NOBODY — so the {{student}}'s device will
              never see it — has to say so. No package badge here either:
              BoardPackageControl already names the package (and counts them
              when there are several). */}
          {board?.dbId && !(board as any).studentId && !(board as any).packageName && (
            <span
              className={cn(
                'text-[9px] px-1.5 py-0.5 rounded',
                isDark ? 'bg-slate-700 text-slate-300' : 'bg-gray-200 text-gray-600'
              )}
              title={t('board.notAttachedTooltip')}
            >
              {t('board.notAttached')}
            </span>
          )}

          {/* Shared content this user may not change. The greyed-out Save in
              the footer needs a visible reason, not just a tooltip. */}
          {isReadOnlyBoard && (
            <span
              className={cn(
                'text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1',
                isDark ? 'bg-slate-700 text-slate-300' : 'bg-gray-200 text-gray-600'
              )}
              title={t('board.readOnlyTooltip')}
            >
              <Lock className="w-2.5 h-2.5 shrink-0" />
              {t('board.readOnly')}
            </span>
          )}

          {/* Attach an unattached draft to the loaded {{student}}. This is the
              only way a board saved with no {{student}} open ever reaches their
              device — and it is one-way, so it cannot be used to move a board
              off a child it already belongs to. */}
          {canAttachToStudent && (
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'h-7 text-xs gap-1.5',
                isDark
                  ? 'border-blue-800 text-blue-300 hover:bg-blue-950'
                  : 'border-blue-300 text-blue-600 hover:bg-blue-50'
              )}
              onClick={() => attachToStudentMutation.mutate()}
              disabled={attachToStudentMutation.isPending || isLoadingBoard}
              title={t('board.attachToStudentTooltip')}
            >
              {attachToStudentMutation.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <UserPlus className="w-3 h-3" />
              )}
              <span className="hidden sm:inline">
                {t('board.attachToStudent', { name: studentName })}
              </span>
            </Button>
          )}

          {/* Package membership + "add to package". Renders nothing without the
              packages license or on an unsaved board. */}
          {board && (
            <BoardPackageControl
              boardId={board.dbId}
              boardStudentId={(board as any).studentId ?? null}
              selectedStudentId={student?.id ?? null}
              selectedStudentName={studentName}
              boardInstituteId={(board as any).instituteId ?? null}
              isDark={isDark}
            />
          )}
        </div>
      </div>

      {/* Row 2: how the AAC should treat this board (start), and how this
          editor should show it (end). */}
      <div className="flex items-center justify-between gap-3 mt-2 px-1">
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
          {board && (
            <>
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
                  {t('board.autoSelect')}
                </Label>
              </div>
              {/* Corner rest space is NOT here on purpose — it is the student's
                  setting (AAC Settings → Rest Areas) and applies to every board
                  they open, so a board cannot ask for its own. */}
              <div className="flex items-center gap-1.5">
                <Label htmlFor="auto-select-hint" className={cn(
                  'text-xs whitespace-nowrap',
                  isDark ? 'text-slate-400' : 'text-gray-500'
                )}>
                  {t('board.autoSelectHint')}
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
                      {t('board.autoSelectHintTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Input
                  id="auto-select-hint"
                  placeholder={t('board.autoSelectHintPlaceholder')}
                  value={board.automaticSelectionHint ?? ''}
                  onChange={(e) => {
                    const newHint = e.target.value;
                    const prev = useBoardStore.getState().board as any;
                    patchBoardMeta({
                      automaticSelectionHint: newHint,
                      // Same rule the store applies to hints the AI writes.
                      automaticSelection: resolveAutomaticSelection(
                        prev?.automaticSelectionHint,
                        newHint,
                        prev?.automaticSelection,
                      ),
                    });
                  }}
                  className={cn(
                    'h-7 text-xs w-44',
                    isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-gray-300'
                  )}
                />
              </div>
              {/* Update Automatically — only when dynamic boards are enabled */}
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
                    {t('board.updateAutomatically')}
                  </Label>
                </div>
              )}
            </>
          )}
        </div>

        {/* Edit/Preview Toggle */}
        <div className={cn(
          'flex rounded-lg overflow-hidden border shrink-0',
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

      {/* Unsaved Changes Dialog — raised by a board switch OR by leaving the panel */}
      <Dialog
        open={showUnsavedDialog}
        // Dismissing by Esc/backdrop is a cancel: drop the pending departure
        // too, or the next confirm would act on a stale target.
        onOpenChange={(open) => { if (!open) handleCancelSwitch(); }}
      >
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
              {pendingLeaveFeature
                ? t('board.unsavedLeaveDesc')
                : t('board.unsavedChangesDesc')}
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
              {pendingLeaveFeature
                ? t('board.discardAndLeave')
                : t('board.discardChanges')}
            </Button>
            <Button
              onClick={handleSaveAndSwitch}
              disabled={saveBoard.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {saveBoard.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              {pendingLeaveFeature
                ? t('board.saveAndLeave')
                : t('board.saveAndSwitch')}
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
              disabled={saveBoard.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {saveBoard.isPending ? (
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