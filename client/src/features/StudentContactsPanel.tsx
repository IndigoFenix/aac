// src/features/StudentContactsPanel.tsx
// Student-scoped panel for managing contacts (parents, classmates, therapists,
// team members). Mirrors the structure of StudentProgressPanel — full-width
// layout, back button, selected-student required.

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiUrl } from '@/lib/queryClient';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import type { StudentContact } from '@shared/schema';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Plus,
  Search,
  Edit,
  Trash2,
  User,
  Users,
  Link2,
  Loader2,
  Contact as ContactIcon,
  ArrowLeft,
} from 'lucide-react';
import { ContactEditorModal } from '@/components/ContactEditorModal';

interface Props {
  isOpen: boolean;
}

export function StudentContactsPanel({ isOpen }: Props) {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { student } = useStudent();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { setActiveFeature, registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();

  const [searchQuery, setSearchQuery] = useState('');
  const [editingContact, setEditingContact] = useState<StudentContact | null>(null);
  const [creating, setCreating] = useState(false);

  const studentId = student?.id;

  const contactsQuery = useQuery<{ success: boolean; contacts: StudentContact[] }>({
    queryKey: ['/api/biometric/students', studentId, 'contacts'],
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/biometric/students/${studentId}/contacts`);
      if (!response.ok) throw new Error('Failed to load contacts');
      return response.json();
    },
    enabled: isOpen && !!studentId,
  });

  const contacts = contactsQuery.data?.contacts || [];

  const filteredContacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) =>
      [c.name, c.relationship, c.role, c.organization, c.contactEmail]
        .filter(Boolean)
        .some((f) => (f as string).toLowerCase().includes(q)),
    );
  }, [contacts, searchQuery]);

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest(
        'DELETE',
        `/api/biometric/students/${studentId}/contacts/${id}`,
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'Failed to delete');
    },
    onSuccess: () => {
      toast({ title: t('contacts.deleted') });
      queryClient.invalidateQueries({ queryKey: ['/api/biometric/students', studentId, 'contacts'] });
    },
    onError: (err: Error) => {
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
    },
  });

  const handleBackClick = () => {
    setActiveFeature('students');
  };

  // Register metadata builder (chat/AI can read current context)
  const buildContactsMetadata = useCallback(
    () => ({ studentId: student?.id }),
    [student?.id],
  );

  useEffect(() => {
    registerMetadataBuilder('contacts', buildContactsMetadata);
    return () => unregisterMetadataBuilder('contacts');
  }, [registerMetadataBuilder, unregisterMetadataBuilder, buildContactsMetadata]);

  if (!isOpen) return null;

  // No student selected — prompt the user to pick one (same pattern as Progress)
  if (!student) {
    return (
      <div
        className={cn(
          'flex items-center justify-center h-full',
          isDark ? 'bg-slate-950 text-slate-400' : 'bg-gray-50 text-slate-600',
        )}
      >
        <div className="text-center">
          <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="text-lg">{t('contacts.selectStudentFirst')}</p>
          <Button className="mt-4" onClick={handleBackClick}>
            {t('program.goToStudents')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn(
        'flex flex-col h-full min-h-0',
        isDark ? 'bg-slate-950' : 'bg-gray-50',
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'border-b shrink-0',
          isDark ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white',
        )}
      >
        {/* Back button row */}
        <div className="px-4 pt-3">
          <Button
            variant="ghost"
            size="sm"
            className={cn('gap-2 text-muted-foreground hover:text-foreground', isRTL && 'flex-row-reverse')}
            onClick={handleBackClick}
          >
            <ArrowLeft className="w-4 h-4 icon-arrow-left" />
            {t('common.back')}
          </Button>
        </div>

        {/* Title + actions row */}
        <div className="px-4 pb-4 pt-2">
          <div className={cn('flex items-start justify-between gap-4', isRTL && 'flex-row-reverse')}>
            <div className={isRTL ? 'text-right' : ''}>
              <h1 className={cn('text-xl font-bold', isDark ? 'text-white' : 'text-slate-900')}>
                {t('contacts.panelTitle')}
              </h1>
              <p className={cn('text-sm', isDark ? 'text-slate-400' : 'text-slate-600')}>
                {t('contacts.forStudent', { name: student.name || '' })}
              </p>
            </div>
            <Button className="gap-2 bg-primary text-primary-foreground shadow-md" onClick={() => setCreating(true)}>
              <Plus className="w-4 h-4" />
              {t('contacts.add')}
            </Button>
          </div>

          {/* Search */}
          <div className="relative max-w-sm mt-3">
            <Search
              className={cn(
                'absolute top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground',
                isRTL ? 'right-3' : 'left-3',
              )}
            />
            <Input
              placeholder={t('contacts.searchPlaceholder')}
              className={isRTL ? 'pr-10' : 'pl-10'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3 max-w-4xl mx-auto">
          {contactsQuery.isLoading && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!contactsQuery.isLoading && filteredContacts.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <ContactIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="text-sm">
                {searchQuery ? t('contacts.noResults') : t('contacts.empty')}
              </p>
              {!searchQuery && (
                <Button variant="outline" className="mt-4 gap-2" onClick={() => setCreating(true)}>
                  <Plus className="w-4 h-4" />
                  {t('contacts.add')}
                </Button>
              )}
            </div>
          )}

          {filteredContacts.map((contact) => {
            const isLinked = !!(contact.linkedUserId || contact.linkedStudentId);
            const photoSrc = contact.biometricDataId
              ? apiUrl(`/api/biometric-data/${contact.biometricDataId}/photo`)
              : null;
            return (
              <Card key={contact.id}>
                <CardContent className="p-4 flex items-center gap-3">
                  {photoSrc ? (
                    <img
                      src={photoSrc}
                      alt=""
                      className="w-12 h-12 rounded-full object-cover border shrink-0"
                      onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <User className="w-5 h-5 text-primary" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{contact.name}</span>
                      {contact.relationship && (
                        <Badge variant="secondary" className="text-xs">
                          {contact.relationship}
                        </Badge>
                      )}
                      {isLinked && (
                        <Badge variant="outline" className="text-xs">
                          <Link2 className="w-3 h-3 me-1" />
                          {contact.linkedUserId
                            ? t('contacts.linkedToUser')
                            : t('contacts.linkedToStudent')}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
                      {contact.role && <span>{t(`team.roles.${contact.role}`)}</span>}
                      {contact.organization && <span>· {contact.organization}</span>}
                      {contact.contactEmail && <span>· {contact.contactEmail}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setEditingContact(contact)}
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm(t('contacts.confirmDelete'))) deleteMut.mutate(contact.id);
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </ScrollArea>

      {/* Editor modal (create + edit share this) */}
      {(creating || editingContact) && (
        <ContactEditorModal
          isOpen={creating || !!editingContact}
          onClose={() => {
            setCreating(false);
            setEditingContact(null);
          }}
          studentId={studentId}
          contact={editingContact}
        />
      )}
    </div>
  );
}
