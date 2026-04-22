// src/components/ContactEditorModal.tsx
// Modal for creating or editing a single studentContacts row.
// Handles form, linked-entity picker, and biometric photo upload.

import { useState, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import type { StudentContact, TeamMemberRole } from '@shared/schema';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Save, Link2, Unlink } from 'lucide-react';
import { BiometricPhotoUpload } from '@/components/BiometricPhotoUpload';

interface LinkableEntity {
  id: string;
  type: 'user' | 'student';
  name: string;
  detail?: string;
}

export interface ContactEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  studentId: string;
  /** Pass a contact to edit; omit (or null) to create. */
  contact?: StudentContact | null;
}

interface FormState {
  name: string;
  relationship: string;
  role: TeamMemberRole | '';
  customRole: string;
  organization: string;
  contactEmail: string;
  contactPhone: string;
  contextNotes: string;
  linkedUserId: string;
  linkedStudentId: string;
}

const EMPTY: FormState = {
  name: '',
  relationship: '',
  role: '',
  customRole: '',
  organization: '',
  contactEmail: '',
  contactPhone: '',
  contextNotes: '',
  linkedUserId: '',
  linkedStudentId: '',
};

const ROLE_OPTIONS: TeamMemberRole[] = [
  'parent_guardian',
  'homeroom_teacher',
  'special_education_teacher',
  'general_education_teacher',
  'speech_language_pathologist',
  'occupational_therapist',
  'physical_therapist',
  'psychologist',
  'administrator',
  'case_manager',
  'external_provider',
  'student',
  'other',
];

// "user:<id>" | "student:<id>" | "none"
type LinkValue = string;

function contactToForm(c: StudentContact): FormState {
  return {
    name: c.name,
    relationship: c.relationship || '',
    role: (c.role as TeamMemberRole) || '',
    customRole: c.customRole || '',
    organization: c.organization || '',
    contactEmail: c.contactEmail || '',
    contactPhone: c.contactPhone || '',
    contextNotes: c.contextNotes || '',
    linkedUserId: c.linkedUserId || '',
    linkedStudentId: c.linkedStudentId || '',
  };
}

function formToPayload(form: FormState) {
  return {
    name: form.name.trim(),
    relationship: form.relationship.trim() || undefined,
    role: form.role || undefined,
    customRole: form.customRole.trim() || undefined,
    organization: form.organization.trim() || undefined,
    contactEmail: form.contactEmail.trim() || undefined,
    contactPhone: form.contactPhone.trim() || undefined,
    contextNotes: form.contextNotes.trim() || undefined,
    linkedUserId: form.linkedUserId.trim() || null,
    linkedStudentId: form.linkedStudentId.trim() || null,
  };
}

function currentLinkValue(form: FormState): LinkValue {
  if (form.linkedUserId) return `user:${form.linkedUserId}`;
  if (form.linkedStudentId) return `student:${form.linkedStudentId}`;
  return 'none';
}

export function ContactEditorModal({ isOpen, onClose, studentId, contact }: ContactEditorModalProps) {
  const { t, isRTL } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const editing = !!contact;

  const [form, setForm] = useState<FormState>(EMPTY);

  useEffect(() => {
    if (isOpen) {
      setForm(contact ? contactToForm(contact) : EMPTY);
    }
  }, [isOpen, contact]);

  // Load linkable entities for this student's institutes
  const linkablesQuery = useQuery<{ success: boolean; entities: LinkableEntity[] }>({
    queryKey: ['/api/biometric/students', studentId, 'linkable-entities'],
    queryFn: async () => {
      const response = await apiRequest(
        'GET',
        `/api/biometric/students/${studentId}/linkable-entities`,
      );
      if (!response.ok) throw new Error('Failed to load linkable entities');
      return response.json();
    },
    enabled: isOpen && !!studentId,
  });

  const linkables = linkablesQuery.data?.entities || [];
  const isLinked = !!(form.linkedUserId || form.linkedStudentId);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['/api/biometric/students', studentId, 'contacts'] });

  const createMut = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        'POST',
        `/api/biometric/students/${studentId}/contacts`,
        formToPayload(form),
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'Failed to create');
      return data.contact as StudentContact;
    },
    onSuccess: () => {
      toast({ title: t('contacts.created') });
      invalidate();
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
    },
  });

  const updateMut = useMutation({
    mutationFn: async () => {
      if (!contact) throw new Error('No contact to update');
      const response = await apiRequest(
        'PATCH',
        `/api/biometric/students/${studentId}/contacts/${contact.id}`,
        formToPayload(form),
      );
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'Failed to update');
      return data.contact as StudentContact;
    },
    onSuccess: () => {
      toast({ title: t('contacts.updated') });
      invalidate();
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
    },
  });

  const handleLinkChange = (value: LinkValue) => {
    if (value === 'none') {
      setForm((f) => ({ ...f, linkedUserId: '', linkedStudentId: '' }));
      return;
    }
    const [type, id] = value.split(':');
    if (type === 'user') {
      setForm((f) => ({ ...f, linkedUserId: id, linkedStudentId: '' }));
    } else {
      setForm((f) => ({ ...f, linkedStudentId: id, linkedUserId: '' }));
    }
    // Auto-populate name from the picked entity if name is empty
    setForm((f) => {
      if (f.name.trim()) return f;
      const entity = linkables.find((e) => `${e.type}:${e.id}` === value);
      return entity ? { ...f, name: entity.name } : f;
    });
  };

  const onSubmit = () => {
    if (!form.name.trim()) {
      toast({ title: t('common.error'), description: t('contacts.nameRequired'), variant: 'destructive' });
      return;
    }
    (editing ? updateMut : createMut).mutate();
  };

  const grouped = useMemo(() => {
    const users = linkables.filter((e) => e.type === 'user');
    const students = linkables.filter((e) => e.type === 'student');
    return { users, students };
  }, [linkables]);

  const isSubmitting = createMut.isPending || updateMut.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] flex flex-col" dir={isRTL ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle>{editing ? t('contacts.editTitle') : t('contacts.new')}</DialogTitle>
          <DialogDescription>
            {editing ? t('contacts.editDescription') : t('contacts.createDescription')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          {/* Link picker — offered first since it can auto-fill the name field */}
          <div className="space-y-1">
            <Label className="text-sm">
              {isLinked ? (
                <span className="flex items-center gap-1">
                  <Link2 className="w-3 h-3" /> {t('contacts.linkedTo')}
                </span>
              ) : (
                t('contacts.linkToExisting')
              )}
            </Label>
            <Select value={currentLinkValue(form)} onValueChange={handleLinkChange}>
              <SelectTrigger>
                <SelectValue placeholder={t('contacts.linkToExistingHint')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  <span className="flex items-center gap-2">
                    <Unlink className="w-3 h-3" /> {t('contacts.notLinked')}
                  </span>
                </SelectItem>
                {grouped.users.length > 0 && (
                  <>
                    <div className="px-2 py-1 text-xs text-muted-foreground font-semibold">
                      {t('contacts.users')}
                    </div>
                    {grouped.users.map((e) => (
                      <SelectItem key={`user:${e.id}`} value={`user:${e.id}`}>
                        {e.name}
                        {e.detail && <span className="text-muted-foreground text-xs ms-2">{e.detail}</span>}
                      </SelectItem>
                    ))}
                  </>
                )}
                {grouped.students.length > 0 && (
                  <>
                    <div className="px-2 py-1 text-xs text-muted-foreground font-semibold">
                      {t('contacts.otherStudents')}
                    </div>
                    {grouped.students.map((e) => (
                      <SelectItem key={`student:${e.id}`} value={`student:${e.id}`}>
                        {e.name}
                      </SelectItem>
                    ))}
                  </>
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {isLinked ? t('contacts.linkedHint') : t('contacts.unlinkedHint')}
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-sm">{t('contacts.name')} *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('contacts.namePlaceholder')}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">{t('contacts.relationship')}</Label>
              <Input
                value={form.relationship}
                onChange={(e) => setForm((f) => ({ ...f, relationship: e.target.value }))}
                placeholder={t('contacts.relationshipPlaceholder')}
              />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-sm">{t('contacts.role')}</Label>
              <Select
                value={form.role || undefined}
                onValueChange={(value) => setForm((f) => ({ ...f, role: value as TeamMemberRole }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('contacts.selectRole')} />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`team.roles.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm">{t('contacts.organization')}</Label>
              <Input
                value={form.organization}
                onChange={(e) => setForm((f) => ({ ...f, organization: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-sm">{t('contacts.email')}</Label>
              <Input
                type="email"
                value={form.contactEmail}
                onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">{t('contacts.phone')}</Label>
              <Input
                value={form.contactPhone}
                onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-sm">{t('contacts.contextNotes')}</Label>
            <Textarea
              value={form.contextNotes}
              onChange={(e) => setForm((f) => ({ ...f, contextNotes: e.target.value }))}
              placeholder={t('contacts.contextNotesPlaceholder')}
              className="min-h-[60px]"
            />
          </div>

          {/* Biometric photo — only for unlinked contacts; linked ones use the
              canonical record's biometric data. */}
          {editing && contact && (
            <div className="space-y-1 pt-2 border-t">
              <Label className="text-sm">{t('biometric.facePhoto')}</Label>
              {isLinked ? (
                <div className="text-xs text-muted-foreground">{t('biometric.linkedPhotoHint')}</div>
              ) : (
                <BiometricPhotoUpload
                  target={{ type: 'contact', studentId, contactId: contact.id }}
                  biometricDataId={contact.biometricDataId}
                  dense
                />
              )}
            </div>
          )}
          {!editing && (
            <p className="text-xs text-muted-foreground pt-2 border-t">
              {t('contacts.photoAfterCreate')}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={onSubmit} disabled={isSubmitting}>
            {isSubmitting ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : <Save className="w-4 h-4 me-2" />}
            {editing ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
