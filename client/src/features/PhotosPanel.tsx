// client/src/features/PhotosPanel.tsx
//
// The clinician Photo Manager — planning-docs/aac-photos-plan.md §5.
//
// Structurally this follows SymbolsPanel (tabs per scope, a card grid, a create
// dialog), with three deliberate departures:
//
//  1. NO "my photos" tab. A photo belongs to a student or to an institute and
//     to nothing else — there is no user-scoped library, because a family photo
//     is not reusable vocabulary the way a symbol is.
//  2. Images load from PRESIGNED S3 URLs handed back by the list endpoint, not
//     from an /api/.../image route that streams bytes through the server. See
//     plan L5. The list is refetched inside the URL TTL so nothing goes stale.
//  3. Reordering uses arrow buttons rather than drag-only, so it works from a
//     keyboard. (The plan said drag-to-reorder; drag can be layered on top
//     later, but it must not be the only way.)

import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStudentLabel } from '@/hooks/useStudentLabel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  Plus, Trash2, Edit, Upload, Loader2, Images, Eye, EyeOff,
  ArrowUp, ArrowDown, AlertTriangle,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { downscaleForUpload } from '@/lib/downscale-image';

/** Extract message from apiRequest errors (format: "STATUS: JSON_BODY") */
function extractErrorCode(err: any): string | null {
  const raw = err?.message || '';
  const colonIdx = raw.indexOf(': ');
  if (colonIdx <= 0) return null;
  try {
    const parsed = JSON.parse(raw.substring(colonIdx + 2));
    return parsed.error || null;
  } catch {
    return null;
  }
}

interface LibraryPhoto {
  assignmentId: string;
  photoId: string;
  caption: string | null;
  sortOrder: number;
  hiddenFromStudent: boolean;
  width: number | null;
  height: number | null;
  aiDescription: string | null;
  takenAt: string | null;
  scope: 'student' | 'institute';
  thumbUrl: string;
  displayUrl: string;
}

interface LibraryResponse {
  photos: LibraryPhoto[];
  count: number;
  cap: number;
  canWrite: boolean;
  urlTtlSeconds: number;
}

/** How many files one upload request may carry — mirrors
 *  MAX_PHOTOS_PER_REQUEST in the controller. Larger selections are chunked. */
const MAX_PER_REQUEST = 20;

type ScopeKey = { kind: 'student'; id: string } | { kind: 'institute'; id: string };

function scopePath(scope: ScopeKey): string {
  return scope.kind === 'student' ? `student/${scope.id}` : `institute/${scope.id}`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Card
// ───────────────────────────────────────────────────────────────────────────────

function PhotoCard({
  photo, canWrite, onEdit, onDelete, onToggleHidden, onMoveUp, onMoveDown, busy,
}: {
  photo: LibraryPhoto;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggleHidden: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  busy?: boolean;
}) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <div className={cn(
      'border rounded-lg p-2 flex flex-col gap-2 hover:shadow-md transition-shadow',
      isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-gray-200',
      photo.hiddenFromStudent && 'opacity-60',
    )}>
      <img
        src={photo.thumbUrl}
        // The caption is what the student and the AI both use as this photo's
        // name, so it is also the correct alt text.
        alt={photo.caption || t('photos.uncaptioned')}
        className={cn('w-full aspect-square object-cover rounded', isDark ? 'bg-slate-700' : 'bg-gray-50')}
        loading="lazy"
      />

      <span className={cn(
        'text-sm text-center truncate w-full',
        photo.caption ? (isDark ? 'text-slate-200' : 'text-gray-900')
                      : (isDark ? 'text-amber-400' : 'text-amber-600'),
      )}>
        {photo.caption || t('photos.uncaptioned')}
      </span>

      {photo.hiddenFromStudent && (
        <span className={cn('text-xs text-center', isDark ? 'text-slate-400' : 'text-gray-500')}>
          {t('photos.hiddenBadge')}
        </span>
      )}

      {canWrite && (
        <div className="flex justify-center gap-0.5 flex-wrap">
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={t('photos.editCaption')} disabled={busy}>
            <Edit className="w-3 h-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleHidden}
            aria-label={photo.hiddenFromStudent ? t('photos.show') : t('photos.hide')}
            title={photo.hiddenFromStudent ? t('photos.show') : t('photos.hide')}
            disabled={busy}
          >
            {photo.hiddenFromStudent ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={onMoveUp} aria-label={t('photos.moveEarlier')} disabled={!onMoveUp || busy}>
            <ArrowUp className="w-3 h-3" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onMoveDown} aria-label={t('photos.moveLater')} disabled={!onMoveDown || busy}>
            <ArrowDown className="w-3 h-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-red-500 hover:text-red-700"
            aria-label={t('common.delete')}
            disabled={busy}
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// One scope's library
// ───────────────────────────────────────────────────────────────────────────────

function ScopeLibrary({ scope, isOpen }: { scope: ScopeKey; isOpen: boolean }) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<{ assignmentId: string; caption: string } | null>(null);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);

  const queryKey = ['photos', scope.kind, scope.id];

  const { data, isLoading } = useQuery<LibraryResponse>({
    queryKey,
    queryFn: () => apiRequest('GET', `/api/photos/${scopePath(scope)}`).then(r => r.json()),
    enabled: isOpen,
    // The image URLs are presigned and expire. Refetch comfortably inside the
    // TTL so a panel left open does not fill with broken images.
    refetchInterval: (query) => {
      const ttl = query.state.data?.urlTtlSeconds;
      return ttl ? Math.max(60_000, (ttl * 1000) / 3) : false;
    },
  });

  const photos = data?.photos ?? [];
  const count = data?.count ?? 0;
  const cap = data?.cap ?? 0;
  const canWrite = data?.canWrite ?? false;
  const atCap = cap > 0 && count >= cap;

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const updateMutation = useMutation({
    mutationFn: ({ assignmentId, patch }: { assignmentId: string; patch: Record<string, unknown> }) =>
      apiRequest('PATCH', `/api/photos/assignments/${assignmentId}`, patch),
    onSuccess: () => { invalidate(); setEditing(null); },
    onError: (err) => {
      toast({
        title: t('photos.updateFailed'),
        description: t(`errors.${extractErrorCode(err) || 'UNEXPECTED_ERROR'}`),
        variant: 'destructive',
      });
    },
    onSettled: () => setBusyId(undefined),
  });

  const deleteMutation = useMutation({
    mutationFn: (assignmentId: string) =>
      apiRequest('DELETE', `/api/photos/assignments/${assignmentId}`),
    onSuccess: invalidate,
    onError: (err) => {
      toast({
        title: t('photos.deleteFailed'),
        description: t(`errors.${extractErrorCode(err) || 'UNEXPECTED_ERROR'}`),
        variant: 'destructive',
      });
    },
    onSettled: () => setBusyId(undefined),
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedAssignmentIds: string[]) =>
      apiRequest('POST', '/api/photos/reorder', {
        ...(scope.kind === 'student' ? { studentId: scope.id } : { instituteId: scope.id }),
        orderedAssignmentIds,
      }),
    onSuccess: invalidate,
    onSettled: () => setBusyId(undefined),
  });

  const move = (index: number, delta: number) => {
    const next = [...photos];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setBusyId(photos[index].assignmentId);
    reorderMutation.mutate(next.map(p => p.assignmentId));
  };

  const uncaptionedCount = useMemo(
    () => photos.filter(p => !p.caption).length,
    [photos],
  );

  return (
    <div className="space-y-3">
      {/* Cap counter + add */}
      <div className="flex items-center justify-between gap-2">
        <span className={cn('text-sm', isDark ? 'text-slate-400' : 'text-gray-600')}>
          {t('photos.countOfCap', { count: String(count), cap: String(cap) })}
        </span>
        {canWrite && (
          <Button size="sm" onClick={() => setShowAdd(true)} disabled={atCap}>
            <Plus className="w-4 h-4 mr-1" /> {t('photos.add')}
          </Button>
        )}
      </div>

      {atCap && (
        <p className={cn('text-xs flex items-center gap-1', isDark ? 'text-amber-400' : 'text-amber-600')}>
          <AlertTriangle className="w-3 h-3 shrink-0" /> {t('photos.capReachedHint')}
        </p>
      )}

      {/* An uncaptioned photo still displays, but the AI can only match a query
          against a caption or a description — so nudge, every time. */}
      {uncaptionedCount > 0 && (
        <p className={cn('text-xs', isDark ? 'text-slate-400' : 'text-gray-500')}>
          {t('photos.uncaptionedHint', { count: String(uncaptionedCount) })}
        </p>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : photos.length === 0 ? (
        <p className={cn('text-sm text-center py-8', isDark ? 'text-slate-400' : 'text-gray-500')}>
          {t('photos.empty')}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {photos.map((photo, index) => (
            <PhotoCard
              key={photo.assignmentId}
              photo={photo}
              canWrite={canWrite}
              busy={busyId === photo.assignmentId}
              onEdit={() => setEditing({ assignmentId: photo.assignmentId, caption: photo.caption || '' })}
              onDelete={() => {
                setBusyId(photo.assignmentId);
                deleteMutation.mutate(photo.assignmentId);
              }}
              onToggleHidden={() => {
                setBusyId(photo.assignmentId);
                updateMutation.mutate({
                  assignmentId: photo.assignmentId,
                  patch: { hiddenFromStudent: !photo.hiddenFromStudent },
                });
              }}
              onMoveUp={index > 0 ? () => move(index, -1) : undefined}
              onMoveDown={index < photos.length - 1 ? () => move(index, 1) : undefined}
            />
          ))}
        </div>
      )}

      <AddPhotosDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        scope={scope}
        remaining={Math.max(0, cap - count)}
        onDone={invalidate}
      />

      {editing && (
        <Dialog open onOpenChange={(v) => { if (!v) setEditing(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('photos.editCaption')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="photo-caption">{t('photos.caption')}</Label>
              <Input
                id="photo-caption"
                value={editing.caption}
                onChange={e => setEditing({ ...editing, caption: e.target.value })}
                placeholder={t('photos.captionPlaceholder')}
              />
              <p className={cn('text-xs', isDark ? 'text-slate-400' : 'text-gray-500')}>
                {t('photos.captionHelp')}
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
              <Button
                onClick={() => updateMutation.mutate({
                  assignmentId: editing.assignmentId,
                  patch: { caption: editing.caption },
                })}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                {t('common.save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Add dialog
// ───────────────────────────────────────────────────────────────────────────────

interface PendingFile {
  file: File;
  previewUrl: string;
  caption: string;
}

function AddPhotosDialog({ open, onClose, scope, remaining, onDone }: {
  open: boolean;
  onClose: () => void;
  scope: ScopeKey;
  remaining: number;
  onDone: () => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track object URLs so they can be revoked — a 20-photo selection otherwise
  // leaks 20 decoded bitmaps for the life of the page.
  const createdUrls = useRef<string[]>([]);

  const releaseUrls = () => {
    createdUrls.current.forEach(URL.revokeObjectURL);
    createdUrls.current = [];
  };

  useEffect(() => releaseUrls, []);

  const reset = () => {
    releaseUrls();
    setPending([]);
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    const accepted = files.slice(0, remaining);
    if (files.length > remaining) {
      toast({
        title: t('photos.someSkipped'),
        description: t('photos.onlyRoomFor', { count: String(remaining) }),
      });
    }

    setPending(accepted.map(file => {
      const previewUrl = URL.createObjectURL(file);
      createdUrls.current.push(previewUrl);
      return { file, previewUrl, caption: '' };
    }));
  };

  const handleUpload = async () => {
    if (pending.length === 0) return;
    setUploading(true);
    try {
      let added = 0;
      let skippedForCap = 0;
      let failed = 0;

      // Chunked to match the server's per-request file limit, and to keep any
      // single request small enough to survive a Lambda round trip.
      for (let i = 0; i < pending.length; i += MAX_PER_REQUEST) {
        const chunk = pending.slice(i, i + MAX_PER_REQUEST);
        const formData = new FormData();
        for (const item of chunk) {
          // Shrink before sending: the server discards the original anyway.
          const { blob } = await downscaleForUpload(item.file);
          formData.append('photos', blob, item.file.name);
          formData.append('captions', item.caption.trim());
        }

        const res = await apiRequest('POST', `/api/photos/${scopePath(scope)}`, formData);
        const body = await res.json();
        added += body.added ?? 0;
        skippedForCap += body.skippedForCap ?? 0;
        failed += body.failed ?? 0;
        if (body.skippedForCap > 0) break; // no room left for later chunks
      }

      toast({
        title: t('photos.uploadComplete'),
        description: t('photos.uploadSummary', {
          added: String(added),
          skipped: String(skippedForCap),
          failed: String(failed),
        }),
      });

      reset();
      onDone();
      onClose();
    } catch (err: any) {
      const code = extractErrorCode(err);
      toast({
        title: t('photos.uploadFailed'),
        description: t(`errors.${code || 'UNEXPECTED_ERROR'}`),
        variant: 'destructive',
      });
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { reset(); onClose(); } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('photos.addPhotos')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="photo-files">{t('photos.chooseFiles')}</Label>
            <Input
              id="photo-files"
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFiles}
            />
            <p className={cn('text-xs mt-1', isDark ? 'text-slate-400' : 'text-gray-500')}>
              {t('photos.roomRemaining', { count: String(remaining) })}
            </p>
          </div>

          {pending.length > 0 && (
            <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
              {pending.map((item, index) => (
                <div key={item.previewUrl} className="flex items-center gap-2">
                  <img
                    src={item.previewUrl}
                    alt={t('photos.selectedPreview')}
                    className="w-12 h-12 object-cover rounded border shrink-0"
                  />
                  <Input
                    value={item.caption}
                    onChange={e => setPending(prev => prev.map((p, i) =>
                      i === index ? { ...p, caption: e.target.value } : p,
                    ))}
                    placeholder={t('photos.captionPlaceholder')}
                    aria-label={t('photos.caption')}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={uploading}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleUpload} disabled={uploading || pending.length === 0}>
            {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Upload className="w-4 h-4 mr-1" />}
            {t('photos.uploadCount', { count: String(pending.length) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────────
// Panel
// ───────────────────────────────────────────────────────────────────────────────

export function PhotosPanel({ isOpen }: { isOpen: boolean }) {
  const { student } = useStudent();
  const { currentInstitute } = useInstitute();
  const { t } = useLanguage();
  // `ts()` lives on useStudentLabel, not the language context — it swaps
  // "student" for "child"/"patient" per institute type.
  const { ts } = useStudentLabel();
  const [activeTab, setActiveTab] = useState<'student' | 'institute'>('student');

  if (!isOpen) return null;

  const hasStudent = !!student;
  const hasInstitute = !!currentInstitute;
  // Fall back to the institute tab when no student is selected, so the panel is
  // never rendered with a tab that has nothing behind it.
  const tab = activeTab === 'student' && !hasStudent ? 'institute' : activeTab;

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b flex items-center gap-2 shrink-0">
        <Images className="w-5 h-5" />
        <h2 className="text-lg font-semibold">{t('photos.title')}</h2>
      </div>

      {!hasStudent && !hasInstitute ? (
        <p className="text-sm text-muted-foreground p-4">{ts('photos.noScope')}</p>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => setActiveTab(v as 'student' | 'institute')}
          className="flex-1 flex flex-col min-h-0"
        >
          <TabsList className="mx-4 mt-2 shrink-0">
            {hasStudent && <TabsTrigger value="student">{ts('photos.studentTab')}</TabsTrigger>}
            {hasInstitute && <TabsTrigger value="institute">{t('photos.instituteTab')}</TabsTrigger>}
          </TabsList>

          <div className="flex-1 overflow-y-auto min-h-0">
            {hasStudent && (
              <TabsContent value="student" className="p-4 mt-0">
                <ScopeLibrary scope={{ kind: 'student', id: student!.id }} isOpen={isOpen && tab === 'student'} />
              </TabsContent>
            )}
            {hasInstitute && (
              <TabsContent value="institute" className="p-4 mt-0">
                <ScopeLibrary scope={{ kind: 'institute', id: currentInstitute!.id }} isOpen={isOpen && tab === 'institute'} />
              </TabsContent>
            )}
          </div>
        </Tabs>
      )}
    </div>
  );
}
