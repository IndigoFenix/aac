// Saving the open board — one implementation, two callers.
//
// The Save button lives in the panel FOOTER, while the unsaved-changes dialogs
// that offer "save and switch" / "save and clear" live in the header's
// BoardSelector. Both need the same rules about what saving means (which
// institute the board belongs to, whether this user may write it at all), so
// they share this hook instead of each growing their own copy.
//
// Each caller gets its own mutation instance, so `isPending` is per-button —
// the footer's spinner does not spin inside a dialog and vice versa. That is
// the intent: they are separate user actions that happen to persist the same
// board.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { useBoardStore } from '@/store/board-store';
import { BoardIR } from '@/types/board-ir';

interface SavedBoard {
  id: string;
  name: string;
  studentId?: string | null;
}

export interface BoardSave {
  /** Fire and forget — errors are toasted. */
  save: () => void;
  /** Awaitable, for "save and then leave" flows. Rejects on failure. */
  saveAsync: () => Promise<SavedBoard>;
  isPending: boolean;
  /** Shared package content this user may open but not change. */
  isReadOnly: boolean;
  /** A board that has never been saved, with no institute to belong to. */
  needsInstitute: boolean;
  /** Why Save is disabled, ready for a tooltip. Undefined when it is enabled. */
  blockedReason?: string;
  /** Is there a board, and may it be written? */
  canSave: boolean;
}

export function useBoardSave(): BoardSave {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { student } = useStudent();
  const { currentInstitute } = useInstitute();
  const instituteId = currentInstitute?.id;
  const board = useBoardStore((s) => s.board);
  const markBoardSaved = useBoardStore((s) => s.markBoardSaved);

  const mutation = useMutation({
    mutationFn: async (): Promise<SavedBoard> => {
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
      if ((board as any).isGenerated !== undefined) {
        payload.isGenerated = (board as any).isGenerated;
      }

      /** Turn the server's `error:CODE` into something the user can read. */
      const failure = async (res: Response) => {
        const code = await res
          .json()
          .then((b: any) =>
            typeof b?.error === 'string' && b.error.startsWith('error:') ? b.error.slice(6) : '',
          )
          .catch(() => '');
        return new Error(code ? t(`errors.${code}`) : t('board.saveFailedDesc'));
      };

      // Use PATCH for existing boards, POST for new ones
      if (board.dbId) {
        const res = await apiRequest('PATCH', `/api/boards/${board.dbId}`, payload);
        if (!res.ok) throw await failure(res);
        return res.json();
      }

      // Every board belongs to a {{student}} or to an institute, so a new one
      // needs the selected institute — the server refuses without it, and the
      // Save button is disabled before we ever get here.
      if (!instituteId) {
        throw new Error(t('errors.INSTITUTE_REQUIRED'));
      }
      payload.instituteId = instituteId;
      // Associate new boards with the currently selected student
      if (student?.id) {
        payload.studentId = student.id;
      }
      const res = await apiRequest('POST', '/api/boards', payload);
      if (!res.ok) throw await failure(res);
      return res.json();
    },
    onSuccess: (saved) => {
      markBoardSaved(saved.id, saved.name);
      // Both POST and PATCH echo the stored row, so take the attachment from
      // the server rather than assuming the loaded student won — otherwise a
      // board saved for a student sits in the "not attached" group until the
      // next refetch.
      useBoardStore.setState((state) => {
        const current = state.board;
        if (!current) return state;
        const updated = { ...current, studentId: saved.studentId ?? undefined } as any;
        return {
          board: updated,
          boards: state.boards.map((b: any) => (b._id === updated._id ? updated : b)),
        };
      });
      queryClient.invalidateQueries({ queryKey: ['/api/boards/library'] });
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

  const isReadOnly = board?.canEdit === false;
  const needsInstitute = !!board && !board.dbId && !instituteId;

  return {
    save: () => mutation.mutate(),
    saveAsync: () => mutation.mutateAsync(),
    isPending: mutation.isPending,
    isReadOnly,
    needsInstitute,
    blockedReason: isReadOnly
      ? t('board.readOnlyTooltip')
      : needsInstitute
        ? t('board.needsInstituteTooltip')
        : undefined,
    canSave: !!board && !isReadOnly && !needsInstitute,
  };
}
