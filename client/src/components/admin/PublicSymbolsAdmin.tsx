import { useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiUrl } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { ChevronDown, Image as ImageIcon, Loader2, Search, Trash2, Upload, Sparkles, Pencil, Plus } from 'lucide-react';
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
  /** Bumped whenever the row or image bytes change — used for image cache busting. */
  updatedAt: string;
}

/** Resolve the image URL with a cache-busting version query, derived from the row's updatedAt. */
function symbolImageUrl(symbol: SymbolData): string {
  const v = encodeURIComponent(symbol.updatedAt || symbol.createdAt || '');
  return apiUrl(`/api/custom-symbols/${symbol.id}/image${v ? `?v=${v}` : ''}`);
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

function SymbolCard({ symbol, onApprove, onDelete, onEditImage }: {
  symbol: SymbolData;
  onApprove?: () => void;
  onDelete: () => void;
  onEditImage: () => void;
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
        src={symbolImageUrl(symbol)}
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
        <Button variant="ghost" size="sm" onClick={onEditImage} className="text-blue-500 hover:text-blue-700" aria-label="Replace image" title="Replace image">
          <Pencil className="w-3 h-3" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} className="text-red-500 hover:text-red-700" aria-label={t('common.delete')}>
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Add new symbol panel — upload OR generate, in one form
// ─────────────────────────────────────────────────────────────────────────────

function AddSymbolPanel({ onCreated }: { onCreated: () => void }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'upload' | 'generate'>('upload');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setKey('');
    setDescription('');
    setPrompt('');
    setFile(null);
    setPreviewSrc(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a file first');
      const fd = new FormData();
      fd.append('image', file);
      if (key.trim()) fd.append('key', key.trim());
      if (description.trim()) fd.append('description', description.trim());
      fd.append('isPublic', 'true');
      const res = await apiRequest('POST', '/api/custom-symbols', fd);
      return res.json() as Promise<SymbolData>;
    },
    onSuccess: () => {
      toast({ title: 'Symbol uploaded' });
      reset();
      setOpen(false);
      onCreated();
    },
    onError: (err: any) => {
      toast({ title: 'Upload failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!key.trim()) throw new Error('Key is required');
      const body = {
        key: key.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim() || undefined,
      };
      const res = await apiRequest('POST', '/api/custom-symbols/generate-and-create', body);
      return res.json() as Promise<SymbolData>;
    },
    onSuccess: () => {
      toast({ title: 'Symbol generated' });
      reset();
      setOpen(false);
      onCreated();
    },
    onError: (err: any) => {
      toast({ title: 'Generation failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) {
      setFile(null);
      setPreviewSrc(null);
      return;
    }
    setFile(f);
    const reader = new FileReader();
    reader.onload = () => setPreviewSrc(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(f);
  };

  const pending = uploadMutation.isPending || generateMutation.isPending;

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="mb-2">
        <Plus className="w-4 h-4 mr-1" /> Add symbol
      </Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add new symbol</DialogTitle>
            <DialogDescription>
              Upload an image or generate one from a description. The new symbol becomes a public,
              approved symbol available across the platform.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="add-key" className="text-xs">Key (snake_case, required)</Label>
              <Input
                id="add-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="ice_cream_cone"
                className="h-9"
              />
            </div>
            <div>
              <Label htmlFor="add-desc" className="text-xs">Description (optional)</Label>
              <Input
                id="add-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A scoop of ice cream in a cone"
                className="h-9"
              />
            </div>

            <Tabs value={mode} onValueChange={(v) => setMode(v as 'upload' | 'generate')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="upload"><Upload className="w-3.5 h-3.5 mr-1" />Upload</TabsTrigger>
                <TabsTrigger value="generate"><Sparkles className="w-3.5 h-3.5 mr-1" />Generate</TabsTrigger>
              </TabsList>

              <TabsContent value="upload" className="space-y-2 pt-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className={cn("block w-full text-sm", isDark ? "text-slate-300" : "text-gray-700")}
                />
                {previewSrc && (
                  <img src={previewSrc} alt="Preview" className="mx-auto w-32 h-32 object-contain rounded border" />
                )}
                <Button
                  onClick={() => uploadMutation.mutate()}
                  disabled={!file || pending}
                  className="w-full"
                >
                  {uploadMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Upload className="w-4 h-4 mr-1" />}
                  Upload and save
                </Button>
              </TabsContent>

              <TabsContent value="generate" className="space-y-2 pt-2">
                <Label htmlFor="add-prompt" className="text-xs">Prompt (defaults to key)</Label>
                <Textarea
                  id="add-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="A child holding a red apple"
                  rows={3}
                  className="text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Uses Gemini for prompt refinement + OpenAI gpt-image-1. May take 5–15 seconds.
                </p>
                <Button
                  onClick={() => generateMutation.mutate()}
                  disabled={!key.trim() || pending}
                  className="w-full"
                >
                  {generateMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
                  Generate and save
                </Button>
              </TabsContent>
            </Tabs>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setOpen(false); reset(); }} disabled={pending}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Replace-image dialog — per-symbol upload OR regenerate
// ─────────────────────────────────────────────────────────────────────────────

function EditImageDialog({ symbol, open, onOpenChange, onUpdated }: {
  symbol: SymbolData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { toast } = useToast();
  const [mode, setMode] = useState<'upload' | 'generate'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset transient state when the dialog closes or the target symbol changes.
  const reset = () => {
    setFile(null);
    setPreviewSrc(null);
    setPrompt('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!symbol || !file) throw new Error('No symbol or file');
      const fd = new FormData();
      fd.append('image', file);
      const res = await apiRequest('PUT', `/api/custom-symbols/${symbol.id}/image`, fd);
      return res.json() as Promise<SymbolData>;
    },
    onSuccess: () => {
      toast({ title: 'Image replaced' });
      reset();
      onOpenChange(false);
      onUpdated();
    },
    onError: (err: any) => {
      toast({ title: 'Replace failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      if (!symbol) throw new Error('No symbol');
      const body = prompt.trim() ? { prompt: prompt.trim() } : {};
      const res = await apiRequest('POST', `/api/custom-symbols/${symbol.id}/regenerate`, body);
      return res.json() as Promise<SymbolData>;
    },
    onSuccess: () => {
      toast({ title: 'Image regenerated' });
      reset();
      onOpenChange(false);
      onUpdated();
    },
    onError: (err: any) => {
      toast({ title: 'Regeneration failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) {
      setFile(null);
      setPreviewSrc(null);
      return;
    }
    setFile(f);
    const reader = new FileReader();
    reader.onload = () => setPreviewSrc(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(f);
  };

  const pending = uploadMutation.isPending || regenerateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Replace image</DialogTitle>
          <DialogDescription>
            Replace the image for <code className="text-xs">{symbol?.key ?? '(unnamed)'}</code>. Other
            metadata (key, description, associations) stays unchanged.
          </DialogDescription>
        </DialogHeader>

        {symbol && (
          <div className="flex justify-center">
            <img
              src={symbolImageUrl(symbol)}
              alt="Current"
              className={cn("w-24 h-24 object-contain rounded border", isDark ? "bg-slate-700 border-slate-600" : "bg-gray-50 border-gray-200")}
            />
          </div>
        )}

        <Tabs value={mode} onValueChange={(v) => setMode(v as 'upload' | 'generate')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="upload"><Upload className="w-3.5 h-3.5 mr-1" />Upload</TabsTrigger>
            <TabsTrigger value="generate"><Sparkles className="w-3.5 h-3.5 mr-1" />Regenerate</TabsTrigger>
          </TabsList>

          <TabsContent value="upload" className="space-y-2 pt-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className={cn("block w-full text-sm", isDark ? "text-slate-300" : "text-gray-700")}
            />
            {previewSrc && (
              <img src={previewSrc} alt="Preview" className="mx-auto w-32 h-32 object-contain rounded border" />
            )}
            <Button
              onClick={() => uploadMutation.mutate()}
              disabled={!file || pending}
              className="w-full"
            >
              {uploadMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Upload className="w-4 h-4 mr-1" />}
              Replace with upload
            </Button>
          </TabsContent>

          <TabsContent value="generate" className="space-y-2 pt-2">
            <Label htmlFor="edit-prompt" className="text-xs">
              Custom prompt (optional — defaults to {symbol?.description ? 'description' : 'key'})
            </Label>
            <Textarea
              id="edit-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={symbol?.description || (symbol?.key ?? '').replace(/_/g, ' ')}
              rows={3}
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Regeneration replaces the existing image. May take 5–15 seconds.
            </p>
            <Button
              onClick={() => regenerateMutation.mutate()}
              disabled={pending}
              className="w-full"
            >
              {regenerateMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />}
              Replace with generation
            </Button>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [editingSymbol, setEditingSymbol] = useState<SymbolData | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['custom-symbols'] });

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
              onEditImage={() => setEditingSymbol(s)}
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

      <AddSymbolPanel onCreated={invalidate} />

      <BulkDeletePanel
        onDeleted={invalidate}
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

      <EditImageDialog
        symbol={editingSymbol}
        open={!!editingSymbol}
        onOpenChange={(o) => { if (!o) setEditingSymbol(null); }}
        onUpdated={invalidate}
      />
    </div>
  );
}
