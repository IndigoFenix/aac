import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiUrl } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { ChevronDown, Image as ImageIcon, Loader2, Search, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SymbolData {
  id: string;
  s3Key: string;
  key: string | null;
  description: string | null;
  isPublic: boolean;
  isApproved: boolean;
  createdByUserId: string | null;
  createdAt: string;
}

const PAGE_SIZE = 100;

type SymbolKind = 'unapproved' | 'public';

function filterSymbols(symbols: SymbolData[], query: string): SymbolData[] {
  if (!query.trim()) return symbols;
  const q = query.toLowerCase();
  return symbols.filter(s =>
    (s.key?.toLowerCase().includes(q)) ||
    (s.description?.toLowerCase().includes(q))
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function usePaginatedSymbols(kind: SymbolKind) {
  return useInfiniteQuery<SymbolData[], Error, SymbolData[], [string, SymbolKind], number>({
    queryKey: ['custom-symbols', kind],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiRequest('GET', `/api/custom-symbols/${kind}?limit=${PAGE_SIZE}&offset=${pageParam}`)
        .then(r => r.json()),
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      return allPages.reduce((sum, p) => sum + p.length, 0);
    },
    select: (data) => data.pages.flat(),
  });
}

function SymbolCard({ symbol, onApprove, onDelete }: {
  symbol: SymbolData;
  onApprove?: () => void;
  onDelete: () => void;
}) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <div className={cn(
      "border rounded-lg p-3 flex flex-col items-center gap-2 hover:shadow-md transition-shadow relative",
      isDark ? "bg-slate-800 border-slate-700" : "bg-white border-gray-200",
      !symbol.isApproved && (isDark ? "border-yellow-600/50" : "border-yellow-400"),
    )}>
      {!symbol.isApproved && (
        <span className="absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-600 font-medium">
          {t('symbols.pending')}
        </span>
      )}
      <img
        src={apiUrl(`/api/custom-symbols/${symbol.id}/image`)}
        alt={symbol.key || t('symbols.title')}
        className={cn("w-16 h-16 object-contain rounded", isDark ? "bg-slate-700" : "bg-gray-50")}
        loading="lazy"
      />
      <span className={cn("text-sm font-medium text-center truncate w-full", isDark ? "text-slate-200" : "text-gray-900")}>
        {symbol.key || t('symbols.unnamed')}
      </span>
      {symbol.description && (
        <span className={cn("text-xs text-center truncate w-full", isDark ? "text-slate-400" : "text-gray-500")}>
          {symbol.description}
        </span>
      )}
      <span className={cn("text-[10px]", isDark ? "text-slate-500" : "text-gray-400")}>
        {formatDate(symbol.createdAt)}
      </span>
      <div className="flex gap-1">
        {onApprove && (
          <Button variant="ghost" size="sm" onClick={onApprove} className="text-green-600 hover:text-green-700" title={t('symbols.approve')}>
            <span className="text-xs">&#10003;</span>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onDelete} className="text-red-500 hover:text-red-700" aria-label={t('common.delete')}>
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
}

function BulkDeletePanel({ onDeleted }: { onDeleted: () => void }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { toast } = useToast();
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const bulkDeleteMutation = useMutation({
    mutationFn: async (body: { startDate: string; endDate: string }) => {
      const res = await apiRequest('POST', '/api/custom-symbols/bulk-delete-unapproved', body);
      return res.json() as Promise<{ deletedCount: number }>;
    },
    onSuccess: ({ deletedCount }) => {
      toast({ title: 'Bulk delete complete', description: `Deleted ${deletedCount} unapproved symbol${deletedCount === 1 ? '' : 's'}.` });
      onDeleted();
    },
    onError: (err: any) => {
      toast({ title: 'Bulk delete failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    },
  });

  const canSubmit = !!startDate && !!endDate && startDate <= endDate;

  const handleConfirm = () => {
    setConfirmOpen(false);
    // Normalize: include the full end day (up to 23:59:59.999).
    const start = new Date(`${startDate}T00:00:00.000Z`).toISOString();
    const end = new Date(`${endDate}T23:59:59.999Z`).toISOString();
    bulkDeleteMutation.mutate({ startDate: start, endDate: end });
  };

  return (
    <div className={cn(
      "border rounded-lg p-4 space-y-3",
      isDark ? "bg-slate-800/50 border-slate-700" : "bg-gray-50 border-gray-200",
    )}>
      <h3 className="text-sm font-semibold">Bulk delete unapproved symbols</h3>
      <p className="text-xs text-muted-foreground">
        Permanently deletes unapproved public symbols created in the given date range (inclusive). S3 images are removed too.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="bulk-start" className="text-xs">Start date</Label>
          <Input
            id="bulk-start"
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="h-9"
          />
        </div>
        <div>
          <Label htmlFor="bulk-end" className="text-xs">End date</Label>
          <Input
            id="bulk-end"
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="h-9"
          />
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={!canSubmit || bulkDeleteMutation.isPending}
        >
          {bulkDeleteMutation.isPending
            ? <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            : <Trash2 className="w-4 h-4 mr-1" />}
          Delete in range
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete unapproved symbols?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all unapproved public symbols created between <strong>{startDate}</strong> and <strong>{endDate}</strong> (inclusive), along with their S3 images. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function PublicSymbolsAdmin() {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');

  const unapproved = usePaginatedSymbols('unapproved');
  const approved = usePaginatedSymbols('public');

  const unapprovedFiltered = useMemo(
    () => filterSymbols(unapproved.data ?? [], searchQuery),
    [unapproved.data, searchQuery],
  );
  const approvedFiltered = useMemo(
    () => filterSymbols(approved.data ?? [], searchQuery),
    [approved.data, searchQuery],
  );

  const approveSymbolMutation = useMutation({
    mutationFn: (id: string) => apiRequest('PATCH', `/api/custom-symbols/${id}`, { isApproved: true }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['custom-symbols'] }); },
  });

  const deleteSymbolMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/custom-symbols/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['custom-symbols'] }); },
  });

  const renderSection = (
    title: string,
    emptyMessage: string,
    symbols: SymbolData[],
    totalLoaded: number,
    query: ReturnType<typeof usePaginatedSymbols>,
  ) => (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">
        {title}
        <span className={cn("ms-2 text-sm font-normal", isDark ? "text-slate-400" : "text-gray-500")}>
          ({totalLoaded}{query.hasNextPage ? '+' : ''})
        </span>
      </h2>
      {symbols.length === 0 ? (
        <p className={cn("text-sm py-6", isDark ? "text-slate-400" : "text-gray-500")}>
          {searchQuery ? t('symbols.noResults') : emptyMessage}
        </p>
      ) : (
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {symbols.map(s => (
            <SymbolCard
              key={s.id}
              symbol={s}
              onApprove={!s.isApproved ? () => approveSymbolMutation.mutate(s.id) : undefined}
              onDelete={() => deleteSymbolMutation.mutate(s.id)}
            />
          ))}
        </div>
      )}
      {query.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage
              ? <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              : <ChevronDown className="w-4 h-4 mr-1" />}
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </section>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <ImageIcon className="w-5 h-5" />
        <h1 className="text-2xl font-semibold">{t('symbols.public')} {t('symbols.title')}</h1>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder={t('symbols.searchPlaceholder')}
          className="pl-8 h-9"
        />
      </div>

      <BulkDeletePanel
        onDeleted={() => queryClient.invalidateQueries({ queryKey: ['custom-symbols'] })}
      />

      {renderSection(
        'Pending Approval',
        t('symbols.noPublicSymbols'),
        unapprovedFiltered,
        unapproved.data?.length ?? 0,
        unapproved,
      )}

      {renderSection(
        'Approved',
        t('symbols.noPublicSymbols'),
        approvedFiltered,
        approved.data?.length ?? 0,
        approved,
      )}
    </div>
  );
}
