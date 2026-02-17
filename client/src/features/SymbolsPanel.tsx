import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useStudent } from '@/hooks/useStudent';
import { useAuth } from '@/hooks/useAuth';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Search, Trash2, Edit, Wand2, Upload, Loader2, Image as ImageIcon } from 'lucide-react';

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

function SymbolCard({ symbol, onEdit, onDelete }: {
  symbol: SymbolData;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="border rounded-lg p-3 flex flex-col items-center gap-2 bg-white hover:shadow-md transition-shadow">
      <img
        src={`/api/custom-symbols/${symbol.id}/image`}
        alt={symbol.assocKey || symbol.key || t('symbols.title')}
        className="w-16 h-16 object-contain"
        loading="lazy"
      />
      <span className="text-sm font-medium text-center truncate w-full">
        {symbol.assocKey || symbol.key || t('symbols.unnamed')}
      </span>
      {(symbol.assocDescription || symbol.description) && (
        <span className="text-xs text-gray-500 text-center truncate w-full">
          {symbol.assocDescription || symbol.description}
        </span>
      )}
      <div className="flex gap-1">
        {onEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Edit className="w-3 h-3" />
          </Button>
        )}
        {onDelete && (
          <Button variant="ghost" size="sm" onClick={onDelete} className="text-red-500 hover:text-red-700">
            <Trash2 className="w-3 h-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

export function SymbolsPanel({ isOpen }: { isOpen: boolean }) {
  const { student } = useStudent();
  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('my');
  const [showCreate, setShowCreate] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [editAssoc, setEditAssoc] = useState<{ assocId: string; type: string; key: string; description: string } | null>(null);

  // Queries
  const { data: mySymbols = [] } = useQuery<SymbolData[]>({
    queryKey: ['/api/custom-symbols/my'],
    queryFn: () => apiRequest('GET', '/api/custom-symbols/my').then(r => r.json()),
    enabled: isOpen,
  });

  const { data: studentSymbols = [] } = useQuery<SymbolData[]>({
    queryKey: ['/api/custom-symbols/student', student?.id],
    queryFn: () => apiRequest('GET', `/api/custom-symbols/student/${student!.id}`).then(r => r.json()),
    enabled: isOpen && !!student,
  });

  const { data: publicSymbols = [] } = useQuery<SymbolData[]>({
    queryKey: ['/api/custom-symbols/public'],
    queryFn: () => apiRequest('GET', '/api/custom-symbols/public').then(r => r.json()),
    enabled: isOpen && activeTab === 'public',
  });

  // Mutations
  const deleteSymbolMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/custom-symbols/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-symbols'] });
    },
  });

  const deleteAssocMutation = useMutation({
    mutationFn: ({ assocId, type }: { assocId: string; type: string }) =>
      apiRequest('DELETE', `/api/custom-symbols/${type}-associations/${assocId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-symbols'] });
    },
  });

  const updateAssocMutation = useMutation({
    mutationFn: ({ assocId, type, data }: { assocId: string; type: string; data: any }) =>
      apiRequest('PATCH', `/api/custom-symbols/${type}-associations/${assocId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/custom-symbols'] });
      setEditAssoc(null);
    },
  });

  if (!isOpen) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-5 h-5" />
          <h2 className="text-lg font-semibold">{t('symbols.title')}</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowSearch(true)}>
            <Search className="w-4 h-4 mr-1" /> {t('symbols.search')}
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-1" /> {t('symbols.create')}
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <TabsList className="mx-4 mt-2">
          <TabsTrigger value="my">{t('symbols.mySymbols')}</TabsTrigger>
          {student && <TabsTrigger value="student">{t('symbols.student')}</TabsTrigger>}
          <TabsTrigger value="public">{t('symbols.public')}</TabsTrigger>
        </TabsList>

        <ScrollArea className="flex-1">
          <TabsContent value="my" className="p-4">
            {mySymbols.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">{t('symbols.noSymbols')}</p>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {mySymbols.map(s => (
                  <SymbolCard
                    key={s.id}
                    symbol={s}
                    onEdit={() => setEditAssoc({ assocId: s.assocId!, type: 'user', key: s.assocKey || s.key || '', description: s.assocDescription || s.description || '' })}
                    onDelete={() => s.assocId && deleteAssocMutation.mutate({ assocId: s.assocId, type: 'user' })}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="student" className="p-4">
            {studentSymbols.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">{t('symbols.noStudentSymbols').replace('{name}', student?.name || '')}</p>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {studentSymbols.map(s => (
                  <SymbolCard
                    key={s.id}
                    symbol={s}
                    onEdit={() => setEditAssoc({ assocId: s.assocId!, type: 'student', key: s.assocKey || s.key || '', description: s.assocDescription || s.description || '' })}
                    onDelete={() => s.assocId && deleteAssocMutation.mutate({ assocId: s.assocId, type: 'student' })}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="public" className="p-4">
            {publicSymbols.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">{t('symbols.noPublicSymbols')}</p>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {publicSymbols.map(s => (
                  <SymbolCard key={s.id} symbol={s} />
                ))}
              </div>
            )}
          </TabsContent>
        </ScrollArea>
      </Tabs>

      {/* Create Symbol Dialog */}
      <CreateSymbolDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        studentId={student?.id}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['/api/custom-symbols'] });
          setShowCreate(false);
        }}
      />

      {/* Search Symbol Dialog */}
      <SearchSymbolDialog
        open={showSearch}
        onClose={() => setShowSearch(false)}
        studentId={student?.id}
        onAdded={() => {
          queryClient.invalidateQueries({ queryKey: ['/api/custom-symbols'] });
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

function CreateSymbolDialog({ open, onClose, studentId, onCreated }: {
  open: boolean;
  onClose: () => void;
  studentId?: string;
  onCreated: () => void;
}) {
  const { t } = useLanguage();
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
    } catch (err) {
      console.error('Generate error:', err);
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

      // Auto-associate with user
      await apiRequest('POST', `/api/custom-symbols/${symbol.id}/user-associate`, { key: key || null, description: description || null });

      // Auto-associate with student if selected
      if (studentId) {
        await apiRequest('POST', `/api/custom-symbols/${symbol.id}/student-associate`, { studentId, key: key || null, description: description || null });
      }

      reset();
      onCreated();
    } catch (err) {
      console.error('Save error:', err);
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
              {preview && <img src={preview} alt="preview" className="w-24 h-24 object-contain mt-2 border rounded" />}
            </div>
          ) : (
            <div>
              <Button onClick={handleGenerate} disabled={loading || !description} className="w-full">
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Wand2 className="w-4 h-4 mr-1" />}
                {t('symbols.generatePreview')}
              </Button>
              {generatedImage && (
                <img src={generatedImage} alt="generated" className="w-24 h-24 object-contain mt-2 border rounded mx-auto" />
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

function SearchSymbolDialog({ open, onClose, studentId, onAdded }: {
  open: boolean;
  onClose: () => void;
  studentId?: string;
  onAdded: () => void;
}) {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolData[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await apiRequest('GET', `/api/custom-symbols/search?q=${encodeURIComponent(query)}`);
      setResults(await res.json());
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (symbolId: string, target: 'user' | 'student') => {
    try {
      if (target === 'user') {
        await apiRequest('POST', `/api/custom-symbols/${symbolId}/user-associate`, {});
      } else if (target === 'student' && studentId) {
        await apiRequest('POST', `/api/custom-symbols/${symbolId}/student-associate`, { studentId });
      }
      onAdded();
    } catch (err: any) {
      if (err?.status === 409) {
        // Already associated, ignore
      } else {
        console.error('Add error:', err);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('symbols.searchSymbols')}</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('symbols.searchPlaceholder')}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
          <Button onClick={handleSearch} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </Button>
        </div>
        <ScrollArea className="max-h-[400px]">
          {results.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-4">
              {query ? t('symbols.noResults') : t('symbols.searchPrompt')}
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3 p-2">
              {results.map(s => (
                <div key={s.id} className="border rounded-lg p-3 flex flex-col items-center gap-2">
                  <img
                    src={`/api/custom-symbols/${s.id}/image`}
                    alt={s.key || t('symbols.title')}
                    className="w-12 h-12 object-contain"
                    loading="lazy"
                  />
                  <span className="text-xs font-medium text-center">{s.key || t('symbols.unnamed')}</span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => handleAdd(s.id, 'user')}>
                      {t('symbols.addMy')}
                    </Button>
                    {studentId && (
                      <Button size="sm" variant="outline" onClick={() => handleAdd(s.id, 'student')}>
                        {t('symbols.addStudent')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
