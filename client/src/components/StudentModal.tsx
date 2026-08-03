// src/components/StudentModal.tsx
// Modal for creating and editing a student's core identity:
// First Name, Last Name, Gender, Date of Birth, Face Photo.
// Institute assignment, classroom, grade, language, framework, country,
// and user-student links live in the Student Info panel.

import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { useInstitute } from '@/hooks/useInstitute';
import { useStudent } from '@/hooks/useStudent';
import { useStudentLabel } from '@/hooks/useStudentLabel';
import { apiRequest } from '@/lib/queryClient';
import { Student } from '@shared/schema';
import { cn } from '@/lib/utils';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Plus,
  Edit,
  School,
  Hospital,
  Home,
  Loader2,
  AlertTriangle,
  Check,
} from 'lucide-react';
import { BiometricPhotoUpload } from '@/components/BiometricPhotoUpload';
import { ConsentWizard } from '@/features/consent/ConsentWizard';

// =============================================================================
// TYPES
// =============================================================================

interface StudentModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingStudent?: Student | null;
}

interface StudentFormData {
  firstName: string;
  lastName: string;
  gender: string;
  birthDate: string;
}

const INITIAL_FORM_STATE: StudentFormData = {
  firstName: '',
  lastName: '',
  gender: '',
  birthDate: '',
};

// =============================================================================
// COMPONENT
// =============================================================================

export function StudentModal({ isOpen, onClose, editingStudent }: StudentModalProps) {
  const { t, isRTL, language } = useLanguage();
  const { ts } = useStudentLabel();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { refetchStudent } = useStudent();
  const { institutes } = useInstitute();

  // Form state
  const [formData, setFormData] = useState<StudentFormData>(INITIAL_FORM_STATE);

  // For creation: multi-select array of institute IDs
  const [selectedInstituteIds, setSelectedInstituteIds] = useState<string[]>([]);

  // After creating in a family institute, surface the consent wizard for the
  // newly-created student. Empty until the create mutation succeeds.
  const [pendingConsentStudentId, setPendingConsentStudentId] = useState<string | null>(null);

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  const createStudentMutation = useMutation({
    mutationFn: async (studentData: Partial<StudentFormData> & { instituteIds: string[]; primaryLanguage: string }) => {
      const res = await apiRequest('POST', '/api/students', studentData);
      return res.json();
    },
    onSuccess: async (data: any) => {
      await refetchStudent();
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });

      toast({
        title: t('toast.studentCreated') || 'Student Created',
        description: t('toast.studentCreatedDesc') || 'The student has been created successfully.',
      });

      // If the creator is a family-institute admin, the server auto-creates a
      // guardian-contact row pointing at them. Surface the consent wizard so
      // they can sign now rather than ending up in consent_pending state.
      const newStudentId = data?.student?.id;
      const createdInFamily = institutes.some(
        (i) => selectedInstituteIds.includes(i.id) && i.type === 'family',
      );
      if (newStudentId && createdInFamily) {
        setPendingConsentStudentId(newStudentId);
      } else {
        handleClose();
      }
    },
    onError: (error: any) => {
      toast({
        title: t('toast.studentCreateFailed') || 'Failed to Create Student',
        description: error?.message || t('toast.studentCreateFailedDesc') || 'An error occurred.',
        variant: 'destructive',
      });
    },
  });

  const updateStudentMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<StudentFormData> }) => {
      const res = await apiRequest('PATCH', `/api/students/${id}`, data);
      return res.json();
    },
    onSuccess: async () => {
      await refetchStudent();
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students/list'] });

      toast({
        title: t('toast.studentUpdated') || 'Student Updated',
        description: t('toast.studentUpdatedDesc') || 'The student has been updated successfully.',
      });

      handleClose();
    },
    onError: (error: any) => {
      toast({
        title: t('toast.studentUpdateFailed') || 'Failed to Update Student',
        description: error?.message || t('toast.studentUpdateFailedDesc') || 'An error occurred.',
        variant: 'destructive',
      });
    },
  });

  // ==========================================================================
  // EFFECTS
  // ==========================================================================

  // For creation: auto-select if user has exactly one institute
  useEffect(() => {
    if (!editingStudent && institutes.length === 1 && selectedInstituteIds.length === 0) {
      setSelectedInstituteIds([institutes[0].id]);
    }
  }, [editingStudent, institutes]);

  // Initialize form when editing student changes
  useEffect(() => {
    if (editingStudent) {
      setFormData({
        firstName: editingStudent.firstName || '',
        lastName: editingStudent.lastName || '',
        gender: (editingStudent.gender || '').toLowerCase(),
        birthDate: editingStudent.birthDate || '',
      });
    } else {
      resetForm();
    }
  }, [editingStudent]);

  // ==========================================================================
  // HANDLERS
  // ==========================================================================

  const handleSubmit = () => {
    if (!formData.firstName.trim()) {
      toast({
        title: t('common.error') || 'Error',
        description: t('student.firstNameIsRequired') || 'First name is required',
        variant: 'destructive',
      });
      return;
    }

    if (!editingStudent && selectedInstituteIds.length === 0) {
      toast({
        title: t('common.error') || 'Error',
        description: t('student.instituteRequired') || 'At least one institute is required',
        variant: 'destructive',
      });
      return;
    }

    const submitData = {
      firstName: formData.firstName,
      lastName: formData.lastName || undefined,
      gender: formData.gender || undefined,
      birthDate: formData.birthDate || undefined,
    };

    if (editingStudent) {
      updateStudentMutation.mutate({ id: editingStudent.id, data: submitData });
    } else {
      createStudentMutation.mutate({ ...submitData, instituteIds: selectedInstituteIds, primaryLanguage: language });
    }
  };

  const resetForm = () => {
    setFormData(INITIAL_FORM_STATE);
    setSelectedInstituteIds([]);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  const calculateAge = (birthDateStr: string): number | null => {
    if (!birthDateStr) return null;
    const birth = new Date(birthDateStr);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  };

  const schoolInstitutes = institutes.filter(i => i.type === 'school');
  const clinicInstitutes = institutes.filter(i => i.type === 'clinic');
  const familyInstitutes = institutes.filter(i => i.type === 'family');
  const isLoading = createStudentMutation.isPending || updateStudentMutation.isPending;
  const noInstitutes = institutes.length === 0;

  const toggleInstituteId = (id: string) => {
    setSelectedInstituteIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const instituteIcon = (type: string) => {
    if (type === 'school') return <School className="w-4 h-4 text-blue-500" />;
    if (type === 'clinic') return <Hospital className="w-4 h-4 text-green-500" />;
    return <Home className="w-4 h-4 text-amber-500" />;
  };

  // ==========================================================================
  // RENDER
  // ==========================================================================

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className={isRTL ? 'text-right' : ''}>
            {editingStudent ? ts('student.edit') || 'Edit Student' : ts('student.addNew') || 'Add New Student'}
          </DialogTitle>
          <DialogDescription className={isRTL ? 'text-right' : ''}>
            {editingStudent
              ? ts('student.editDescription') || 'Update student information.'
              : ts('student.addNewDescription') || 'Create a profile for a new student.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="grid gap-4 py-4">
          {/* Row 1: First Name and Last Name */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="studentFirstName">
                {t('student.firstNameRequired') || 'First Name *'}
              </Label>
              <Input
                id="studentFirstName"
                value={formData.firstName}
                onChange={(e) => setFormData(prev => ({ ...prev, firstName: e.target.value }))}
                placeholder={t('student.firstNamePlaceholder') || 'Enter first name'}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="studentLastName">
                {t('student.lastName') || 'Last Name'}
              </Label>
              <Input
                id="studentLastName"
                value={formData.lastName}
                onChange={(e) => setFormData(prev => ({ ...prev, lastName: e.target.value }))}
                placeholder={t('student.lastNamePlaceholder') || 'Enter last name'}
              />
            </div>
          </div>

          {/* Row 2: Gender and Birth Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="studentGender">
                {t('student.gender') || 'Gender'}
              </Label>
              <Select
                value={formData.gender}
                onValueChange={(value) => setFormData(prev => ({ ...prev, gender: value }))}
              >
                <SelectTrigger id="studentGender">
                  <SelectValue placeholder={t('student.genderPlaceholder') || 'Select gender'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="male">{t('student.genderMale') || 'Male'}</SelectItem>
                  <SelectItem value="female">{t('student.genderFemale') || 'Female'}</SelectItem>
                  <SelectItem value="other">{t('student.genderOther') || 'Other'}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="studentBirthDate">
                {t('student.dateOfBirth') || 'Date of Birth'}
              </Label>
              <Input
                id="studentBirthDate"
                type="date"
                value={formData.birthDate}
                onChange={(e) => setFormData(prev => ({ ...prev, birthDate: e.target.value }))}
                max={new Date().toISOString().split('T')[0]}
              />
              {formData.birthDate && (
                <p className="text-xs text-muted-foreground">
                  {(t('student.ageDisplay') || 'Age: {{age}} years').replace('{{age}}', String(calculateAge(formData.birthDate)))}
                </p>
              )}
            </div>
          </div>

          {/* Institute Assignment — only for creation */}
          {!editingStudent && (
            <>
              <Separator className="my-2" />
              <div className="space-y-4">
                <h3 className="text-sm font-medium">
                  {t('student.instituteAssignmentRequired') || 'Institute Assignment *'}
                </h3>

                {noInstitutes && (
                  <Alert className="border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20">
                    <AlertTriangle className="h-4 w-4 text-yellow-600" />
                    <AlertDescription className="text-yellow-800 dark:text-yellow-200">
                      {t('student.noInstitutesWarning') || 'You must belong to at least one institute to create a student.'}
                    </AlertDescription>
                  </Alert>
                )}

                {!noInstitutes && (
                  <div className="space-y-2">
                    <Label className="text-muted-foreground text-xs">
                      {t('student.selectInstitutes') || 'Select institutes for this student'}
                    </Label>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {[
                        ...(schoolInstitutes.length > 0 ? [{ header: t('institute.type.schoolPlural') || 'Schools', items: schoolInstitutes }] : []),
                        ...(clinicInstitutes.length > 0 ? [{ header: t('institute.type.clinicPlural') || 'Clinics', items: clinicInstitutes }] : []),
                        ...(familyInstitutes.length > 0 ? [{ header: t('institute.type.familyPlural') || 'Families', items: familyInstitutes }] : []),
                      ].map(({ header, items }) => (
                        <div key={header}>
                          <div className="px-1 py-1 text-xs font-semibold text-muted-foreground">
                            {header}
                          </div>
                          {items.map((inst) => {
                            const checked = selectedInstituteIds.includes(inst.id);
                            return (
                              <button
                                key={inst.id}
                                type="button"
                                onClick={() => toggleInstituteId(inst.id)}
                                className={cn(
                                  'flex items-center gap-2 w-full p-2 rounded-md text-sm transition-colors text-start',
                                  checked ? 'bg-primary/10 border border-primary/30' : 'bg-muted/50 hover:bg-muted'
                                )}
                              >
                                <div className={cn(
                                  'flex items-center justify-center w-4 h-4 rounded border',
                                  checked ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40'
                                )}>
                                  {checked && <Check className="w-3 h-3" />}
                                </div>
                                {instituteIcon(inst.type)}
                                <span>{inst.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Face photo — editing mode only (needs a student ID) */}
          {editingStudent && (
            <>
              <Separator className="my-2" />
              <div className="space-y-2">
                <Label>{t('biometric.facePhoto')}</Label>
                <BiometricPhotoUpload
                  target={{ type: 'student', studentId: editingStudent.id }}
                  biometricDataId={(editingStudent as any).biometricDataId}
                  dense
                  // A FIRST photo mints the biometric record, so the id this
                  // modal was handed is stale until the student is refetched —
                  // without this the avatar stays empty until a page reload.
                  onUploaded={() => {
                    queryClient.invalidateQueries({ queryKey: ['/api/students'] });
                    queryClient.invalidateQueries({ queryKey: ['/api/students/list'] });
                    refetchStudent();
                  }}
                />
              </div>
            </>
          )}
        </DialogBody>

        <DialogFooter className={isRTL ? 'flex-row-reverse' : ''}>
          <Button variant="outline" onClick={handleClose}>
            {t('common.cancel') || 'Cancel'}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isLoading || !formData.firstName.trim() || (!editingStudent && (noInstitutes || selectedInstituteIds.length === 0))}
            className="flex items-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common.saving') || 'Saving...'}
              </>
            ) : editingStudent ? (
              <>
                <Edit className="w-4 h-4" />
                {t('common.update') || 'Update'}
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                {ts('student.addStudent') || 'Add Student'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>

      {pendingConsentStudentId && (
        <ConsentWizard
          studentId={pendingConsentStudentId}
          onClose={() => {
            setPendingConsentStudentId(null);
            handleClose();
          }}
        />
      )}
    </Dialog>
  );
}
