import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiUrl } from '@/lib/queryClient';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Search, Trash2, Edit, Wand2, Upload, Loader2, Image as ImageIcon, ChevronDown, UserPlus, Building2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

/** Extract message from apiRequest errors (format: "STATUS: JSON_BODY") */
function extractErrorMessage(err: any, fallback: string): string {
  const raw = err?.message || '';
  const colonIdx = raw.indexOf(': ');
  if (colonIdx > 0) {
    const body = raw.substring(colonIdx + 2);
    try {
      const parsed = JSON.parse(body);
      if (parsed.message) return parsed.message;
    } catch { /* not JSON */ }
    return body || fallback;
  }
  return raw || fallback;
}

interface SymbolData {
  id: string;
  s3Key: string;
  key: string | null;
  description: string | null;
  isPublic: boolean;
  isApproved: boolean;
  createdByUserId: string | null;
  assocKey?: string | null;
  assocDescription?: string | null;
  assocId?: string;
}

const PAGE_SIZE = 24;

function SymbolCard({ symbol, onEdit, onDelete, onAddToStudent, addToStudentLabel, alreadyOnStudent, addPending, onAddToInstitute, addToInstituteLabel, alreadyOnInstitute, addInstitutePending }: {
  symbol: SymbolData;
  onEdit?: () => void;
  onDelete?: () => void;
  onAddToStudent?: () => void;
  addToStudentLabel?: string;
  alreadyOnStudent?: boolean;
  addPending?: boolean;
  onAddToInstitute?: () => void;
  addToInstituteLabel?: string;
  alreadyOnInstitute?: boolean;
  addInstitutePending?: boolean;
}) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <div className={cn(
      "border rounded-lg p-3 flex flex-col items-center gap-2 hover:shadow-md transition-shadow relative",
      isDark ? "bg-slate-800 border-slate-700" : "bg-white border-gray-200",
    )}>
      <img
        src={apiUrl(`/api/custom-symbols/${symbol.id}/image`)}
        alt={symbol.assocKey || symbol.key || t('symbols.title')}
        className={cn("w-16 h-16 object-contain rounded", isDark ? "bg-slate-700" : "bg-gray-50")}
        loading="lazy"
      />
      <span className={cn("text-sm font-medium text-center truncate w-full", isDark ? "text-slate-200" : "text-gray-900")}>
        {symbol.assocKey || symbol.key || t('symbols.unnamed')}
      </span>
      {(symbol.assocDescription || symbol.description) && (
        <span className={cn("text-xs text-center truncate w-full", isDark ? "text-slate-400" : "text-gray-500")}>
          {symbol.assocDescription || symbol.description}
        </span>
      )}
      <div className="flex gap-1">
        {onEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={t('common.edit')}>
            <Edit className="w-3 h-3" />
          </Button>
        )}
        {onDelete && (
          <Button variant="ghost" size="sm" onClick={onDelete} className="text-red-500 hover:text-red-700" aria-label={t('common.delete')}>
            <Trash2 className="w-3 h-3" />
          </Button>
        )}
        {onAddToStudent && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddToStudent}
            disabled={alreadyOnStudent || addPending}
            aria-label={addToStudentLabel || t('symbols.addStudent')}
            title={alreadyOnStudent ? t('symbols.alreadyAdded') : (addToStudentLabel || t('symbols.addStudent'))}
            className={alreadyOnStudent ? "text-green-600" : ""}
          >
            {addPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
          </Button>
        )}
        {onAddToInstitute && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddToInstitute}
            disabled={alreadyOnInstitute || addInstitutePending}
            aria-label={addToInstituteLabel || t('symbols.addInstitute')}
            title={alreadyOnInstitute ? t('symbols.alreadyAdded') : (addToInstituteLabel || t('symbols.addInstitute'))}
            className={alreadyOnInstitute ? "text-green-600" : ""}
          >
            {addInstitutePending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Building2 className="w-3 h-3" />}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Client-side filter helper */
function filterSymbols(symbols: SymbolData[], query: string): SymbolData[] {
  if (!query.trim()) return symbols;
  const q = query.toLowerCase();
  return symbols.filter(s =>
    (s.key?.toLowerCase().includes(q)) ||
    (s.description?.toLowerCase().includes(q)) ||
    (s.assocKey?.toLowerCase().includes(q)) ||
    (s.assocDescription?.toLowerCase().includes(q))
  );
}

export function SymbolsPanel({ isOpen }: { isOpen: boolean }) {
  const { student } = useStudent();
  const { currentInstitute } = useInstitute();
  const { t } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('my');
  const [showCreate, setShowCreate] = useState(false);
  const [editAssoc, setEditAssoc] = useState<{ assocId: string; type: string; key: string; description: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Pagination state per tab
  const [myPage, setMyPage] = useState(1);
  const [studentPage, setStudentPage] = useState(1);
  const [institutePage, setInstitutePage] = useState(1);

  // Reset pagination when search changes
  const handleSearchChange = (q: string) => {
    setSearchQuery(q);
    setMyPage(1);
    setStudentPage(1);
    setInstitutePage(1);
  };

  // Queries
  const { data: mySymbols = [], isLoading: myLoading } = useQuery<SymbolData[]>({
    queryKey: ['custom-symbols', 'my'],
    queryFn: () => apiRequest('GET', '/api/custom-symbols/my').then(r => r.json()),
    enabled: isOpen,
  });

  const { data: studentSymbols = [], isLoading: studentLoading } = useQuery<SymbolData[]>({
    queryKey: ['custom-symbols', 'student', student?.id],
    queryFn: () => apiRequest('GET', `/api/custom-symbols/student/${student!.id}`).then(r => r.json()),
    enabled: isOpen && !!student,
  });

  const { data: instituteSymbols = [], isLoading: instituteLoading } = useQuery<SymbolData[]>({
    queryKey: ['custom-symbols', 'institute', currentInstitute?.id],
    queryFn: () => apiRequest('GET', `/api/custom-symbols/institute/${currentInstitute!.id}`).then(r => r.json()),
    enabled: isOpen && !!currentInstitute,
  });

  // Filtered + paginated lists
  const filteredMy = useMemo(() => filterSymbols(mySymbols, searchQuery), [mySymbols, searchQuery]);
  const filteredStudent = useMemo(() => filterSymbols(studentSymbols, searchQuery), [studentSymbols, searchQuery]);
  const filteredInstitute = useMemo(() => filterSymbols(instituteSymbols, searchQuery), [instituteSymbols, searchQuery]);

  const paginatedMy = filteredMy.slice(0, myPage * PAGE_SIZE);
  const paginatedStudent = filteredStudent.slice(0, studentPage * PAGE_SIZE);
  const paginatedInstitute = filteredInstitute.slice(0, institutePage * PAGE_SIZE);

  const deleteAssocMutation = useMutation({
    mutationFn: ({ assocId, type }: { assocId: string; type: string }) =>
      apiRequest('DELETE', `/api/custom-symbols/${type}-associations/${assocId}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['custom-symbols'] }); },
  });

  const updateAssocMutation = useMutation({
    mutationFn: ({ assocId, type, data }: { assocId: string; type: string; data: any }) =>
      apiRequest('PATCH', `/api/custom-symbols/${type}-associations/${assocId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-symbols'] });
      setEditAssoc(null);
    },
  });

  const addToStudentMutation = useMutation({
    mutationFn: ({ symbol }: { symbol: SymbolData }) =>
      apiRequest('POST', `/api/custom-symbols/${symbol.id}/student-associate`, {
        studentId: student!.id,
        key: symbol.assocKey || symbol.key || null,
        description: symbol.assocDescription || symbol.description || null,
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['custom-symbols'] }); },
  });

  const addToInstituteMutation = useMutation({
    mutationFn: ({ symbol }: { symbol: SymbolData }) =>
      apiRequest('POST', `/api/custom-symbols/${symbol.id}/institute-associate`, {
        instituteId: currentInstitute!.id,
        key: symbol.assocKey || symbol.key || null,
        description: symbol.assocDescription || symbol.description || null,
      }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['custom-symbols'] }); },
  });

  // Symbol IDs already associated with the current student — used to disable the
  // "Add to student" button on My Symbols cards once the link exists.
  const studentSymbolIds = useMemo(
    () => new Set(studentSymbols.map(s => s.id)),
    [studentSymbols],
  );
  const instituteSymbolIds = useMemo(
    () => new Set(instituteSymbols.map(s => s.id)),
    [instituteSymbols],
  );

  if (!isOpen) return null;

  const renderGrid = (symbols: SymbolData[], opts: {
    onEdit?: (s: SymbolData) => void;
    onDelete?: (s: SymbolData) => void;
    onAddToStudent?: (s: SymbolData) => void;
    addToStudentLabel?: string;
    isAlreadyOnStudent?: (s: SymbolData) => boolean;
    addPendingId?: string;
    onAddToInstitute?: (s: SymbolData) => void;
    addToInstituteLabel?: string;
    isAlreadyOnInstitute?: (s: SymbolData) => boolean;
    addInstitutePendingId?: string;
    emptyMessage: string;
    isLoading?: boolean;
    total: number;
    page: number;
    onLoadMore: () => void;
  }) => (
    <>
      {opts.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : symbols.length === 0 ? (
        <p className={cn("text-sm text-center py-8", isDark ? "text-slate-400" : "text-gray-500")}>{opts.emptyMessage}</p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {symbols.map(s => (
            <SymbolCard
              key={s.id}
              symbol={s}
              onEdit={opts.onEdit ? () => opts.onEdit!(s) : undefined}
              onDelete={opts.onDelete ? () => opts.onDelete!(s) : undefined}
              onAddToStudent={opts.onAddToStudent ? () => opts.onAddToStudent!(s) : undefined}
              addToStudentLabel={opts.addToStudentLabel}
              alreadyOnStudent={opts.isAlreadyOnStudent?.(s)}
              addPending={opts.addPendingId === s.id}
              onAddToInstitute={opts.onAddToInstitute ? () => opts.onAddToInstitute!(s) : undefined}
              addToInstituteLabel={opts.addToInstituteLabel}
              alreadyOnInstitute={opts.isAlreadyOnInstitute?.(s)}
              addInstitutePending={opts.addInstitutePendingId === s.id}
            />
          ))}
        </div>
      )}
      {symbols.length < opts.total && (
        <div className="flex justify-center pt-4">
          <Button variant="outline" size="sm" onClick={opts.onLoadMore}>
            <ChevronDown className="w-4 h-4 mr-1" /> {t('common.loadMore')}
          </Button>
        </div>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-4 border-b flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-5 h-5" />
          <h2 className="text-lg font-semibold">{t('symbols.title')}</h2>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-1" /> {t('symbols.create')}
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-4 mt-2 shrink-0">
          <TabsTrigger value="my">{t('symbols.mySymbols')}</TabsTrigger>
          {student && <TabsTrigger value="student">{t('symbols.student')}</TabsTrigger>}
          {currentInstitute && <TabsTrigger value="institute">{t('symbols.institute')}</TabsTrigger>}
        </TabsList>

        {/* Search bar */}
        <div className="px-4 pt-3 pb-1 shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder={t('symbols.searchPlaceholder')}
              className="pl-8 h-9"
            />
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <TabsContent value="my" className="p-4 mt-0">
            {renderGrid(paginatedMy, {
              onEdit: (s) => s.assocId && setEditAssoc({ assocId: s.assocId, type: 'user', key: s.assocKey || s.key || '', description: s.assocDescription || s.description || '' }),
              onDelete: (s) => s.assocId && deleteAssocMutation.mutate({ assocId: s.assocId, type: 'user' }),
              onAddToStudent: student ? (s) => addToStudentMutation.mutate({ symbol: s }) : undefined,
              addToStudentLabel: student ? t('symbols.addStudent').replace('{{STUDENT}}', student.name || t('symbols.student')) : undefined,
              isAlreadyOnStudent: student ? (s) => studentSymbolIds.has(s.id) : undefined,
              addPendingId: addToStudentMutation.isPending ? (addToStudentMutation.variables?.symbol.id) : undefined,
              onAddToInstitute: currentInstitute ? (s) => addToInstituteMutation.mutate({ symbol: s }) : undefined,
              addToInstituteLabel: currentInstitute ? t('symbols.addInstitute') : undefined,
              isAlreadyOnInstitute: currentInstitute ? (s) => instituteSymbolIds.has(s.id) : undefined,
              addInstitutePendingId: addToInstituteMutation.isPending ? (addToInstituteMutation.variables?.symbol.id) : undefined,
              emptyMessage: searchQuery ? t('symbols.noResults') : t('symbols.noSymbols'),
              isLoading: myLoading,
              total: filteredMy.length,
              page: myPage,
              onLoadMore: () => setMyPage(p => p + 1),
            })}
          </TabsContent>

          <TabsContent value="student" className="p-4 mt-0">
            {renderGrid(paginatedStudent, {
              onEdit: (s) => s.assocId && setEditAssoc({ assocId: s.assocId, type: 'student', key: s.assocKey || s.key || '', description: s.assocDescription || s.description || '' }),
              onDelete: (s) => s.assocId && deleteAssocMutation.mutate({ assocId: s.assocId, type: 'student' }),
              emptyMessage: searchQuery ? t('symbols.noResults') : t('symbols.noStudentSymbols').replace('{name}', student?.name || ''),
              isLoading: studentLoading,
              total: filteredStudent.length,
              page: studentPage,
              onLoadMore: () => setStudentPage(p => p + 1),
            })}
          </TabsContent>

          <TabsContent value="institute" className="p-4 mt-0">
            {renderGrid(paginatedInstitute, {
              onEdit: (s) => s.assocId && setEditAssoc({ assocId: s.assocId, type: 'institute', key: s.assocKey || s.key || '', description: s.assocDescription || s.description || '' }),
              onDelete: (s) => s.assocId && deleteAssocMutation.mutate({ assocId: s.assocId, type: 'institute' }),
              emptyMessage: searchQuery ? t('symbols.noResults') : t('symbols.noInstituteSymbols').replace('{name}', currentInstitute?.name || ''),
              isLoading: instituteLoading,
              total: filteredInstitute.length,
              page: institutePage,
              onLoadMore: () => setInstitutePage(p => p + 1),
            })}
          </TabsContent>
        </div>
      </Tabs>

      {/* Create Symbol Dialog */}
      <CreateSymbolDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        studentId={student?.id}
        instituteId={activeTab === 'institute' ? currentInstitute?.id : undefined}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['custom-symbols'] });
          setShowCreate(false);
        }}
      />

      {/* Edit Association Dialog */}
      {editAssoc && (
        <Dialog open onOpenChange={() => setEditAssoc(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('symbols.editSymbol')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>{t('symbols.key')}</Label>
                <Input
                  value={editAssoc.key}
                  onChange={e => setEditAssoc({ ...editAssoc, key: e.target.value })}
                />
              </div>
              <div>
                <Label>{t('symbols.description')}</Label>
                <Textarea
                  value={editAssoc.description}
                  onChange={e => setEditAssoc({ ...editAssoc, description: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditAssoc(null)}>{t('common.cancel')}</Button>
              <Button onClick={() => updateAssocMutation.mutate({
                assocId: editAssoc.assocId,
                type: editAssoc.type,
                data: { key: editAssoc.key || null, description: editAssoc.description || null },
              })}>
                {t('common.save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function CreateSymbolDialog({ open, onClose, studentId, instituteId, onCreated }: {
  open: boolean;
  onClose: () => void;
  studentId?: string;
  instituteId?: string;
  onCreated: () => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [mode, setMode] = useState<'upload' | 'generate'>('upload');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setMode('upload');
    setKey('');
    setDescription('');
    setFile(null);
    setPreview(null);
    setGeneratedImage(null);
    setLoading(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      const maxSizeMB = 5;
      if (f.size > maxSizeMB * 1024 * 1024) {
        toast({
          title: t('symbols.uploadError') || 'Upload Error',
          description: t('symbols.fileTooLarge', { max: `${maxSizeMB}MB` }) || `File is too large. Maximum size is ${maxSizeMB}MB.`,
          variant: 'destructive',
        });
        e.target.value = '';
        return;
      }
      setFile(f);
      setPreview(URL.createObjectURL(f));
    }
  };

  const handleGenerate = async () => {
    if (!description) return;
    setLoading(true);
    try {
      const res = await apiRequest('POST', '/api/custom-symbols/generate', { description });
      const data = await res.json();
      setGeneratedImage(data.image);
    } catch (err: any) {
      toast({ title: 'Generation failed', description: extractErrorMessage(err, 'Failed to generate symbol'), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      let imageBlob: Blob;
      if (mode === 'upload' && file) {
        imageBlob = file;
      } else if (mode === 'generate' && generatedImage) {
        const res = await fetch(generatedImage);
        imageBlob = await res.blob();
      } else {
        return;
      }

      const formData = new FormData();
      formData.append('image', imageBlob, 'symbol.png');
      if (key) formData.append('key', key);
      if (description) formData.append('description', description);

      const createRes = await apiRequest('POST', '/api/custom-symbols', formData);
      const symbol = await createRes.json();

      await apiRequest('POST', `/api/custom-symbols/${symbol.id}/user-associate`, { key: key || null, description: description || null });

      if (studentId) {
        await apiRequest('POST', `/api/custom-symbols/${symbol.id}/student-associate`, { studentId, key: key || null, description: description || null });
      }

      if (instituteId) {
        await apiRequest('POST', `/api/custom-symbols/${symbol.id}/institute-associate`, { instituteId, key: key || null, description: description || null });
      }

      reset();
      onCreated();
    } catch (err: any) {
      toast({ title: 'Upload failed', description: extractErrorMessage(err, 'Failed to save symbol'), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { reset(); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('symbols.createSymbol')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button variant={mode === 'upload' ? 'default' : 'outline'} size="sm" onClick={() => setMode('upload')}>
              <Upload className="w-4 h-4 mr-1" /> {t('symbols.upload')}
            </Button>
            <Button variant={mode === 'generate' ? 'default' : 'outline'} size="sm" onClick={() => setMode('generate')}>
              <Wand2 className="w-4 h-4 mr-1" /> {t('symbols.generate')}
            </Button>
          </div>

          <div>
            <Label>{t('symbols.keyName')}</Label>
            <Input value={key} onChange={e => setKey(e.target.value)} placeholder={t('symbols.keyPlaceholder')} />
          </div>

          <div>
            <Label>{t('symbols.description')}</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t('symbols.descriptionPlaceholder')} />
          </div>

          {mode === 'upload' ? (
            <div>
              <Label>{t('symbols.image')}</Label>
              <Input type="file" accept="image/*" onChange={handleFileChange} />
              {preview && <img src={preview} alt="preview" className={cn("w-24 h-24 object-contain mt-2 border rounded", isDark ? "border-slate-600 bg-slate-700" : "border-gray-200 bg-gray-50")} />}
            </div>
          ) : (
            <div>
              <Button onClick={handleGenerate} disabled={loading || !description} className="w-full">
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Wand2 className="w-4 h-4 mr-1" />}
                {t('symbols.generatePreview')}
              </Button>
              {generatedImage && (
                <img src={generatedImage} alt="generated" className={cn("w-24 h-24 object-contain mt-2 border rounded mx-auto", isDark ? "border-slate-600 bg-slate-700" : "border-gray-200 bg-gray-50")} />
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>{t('common.cancel')}</Button>
          <Button
            onClick={handleSave}
            disabled={loading || (mode === 'upload' ? !file : !generatedImage)}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            {t('symbols.saveSymbol')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
