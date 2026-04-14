// src/components/StudentModal.tsx
// Standalone modal for creating and editing students with institute/classroom assignment

import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { useInstitute, Classroom, StudentInstitute, InstituteMember } from '@/hooks/useInstitute';
import { useStudent } from '@/hooks/useStudent';
import { useStudentLabel } from '@/hooks/useStudentLabel';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest } from '@/lib/queryClient';
import { Student, UserStudent } from '@shared/schema';
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
import { Badge } from '@/components/ui/badge';
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
  BookOpen,
  Loader2,
  AlertTriangle,
  Check,
  UserPlus,
  UserMinus,
  Users,
} from 'lucide-react';
import { BiometricEnrollment } from '@/components/BiometricEnrollment';

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
  framework: string;
  country: string;
  grade: string;
  primaryLanguage: string;
}

// Grade options for UI
const GRADE_OPTIONS = [
  { value: 'pre_k', label: 'Pre-K' },
  { value: 'k', label: 'Kindergarten' },
  { value: '1', label: '1st Grade' },
  { value: '2', label: '2nd Grade' },
  { value: '3', label: '3rd Grade' },
  { value: '4', label: '4th Grade' },
  { value: '5', label: '5th Grade' },
  { value: '6', label: '6th Grade' },
  { value: '7', label: '7th Grade' },
  { value: '8', label: '8th Grade' },
  { value: '9', label: '9th Grade' },
  { value: '10', label: '10th Grade' },
  { value: '11', label: '11th Grade' },
  { value: '12', label: '12th Grade' },
  { value: 'special_ed', label: 'Special Education' },
  { value: 'adult_ed', label: 'Adult Education' },
];

const INITIAL_FORM_STATE: StudentFormData = {
  firstName: '',
  lastName: '',
  gender: '',
  birthDate: '',
  framework: 'tala',
  country: 'IL',
  grade: '',
  primaryLanguage: '',
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
  
  const { user } = useAuth();
  const {
    institutes,
    currentInstitute,
    getClassrooms,
    getMembers,
    addStudentToInstitute,
    getStudentInstitutes,
    addStudentToClassroom,
  } = useInstitute();

  // Form state
  const [formData, setFormData] = useState<StudentFormData>(INITIAL_FORM_STATE);

  // Institute assignment state
  // For creation: multi-select array of institute IDs
  const [selectedInstituteIds, setSelectedInstituteIds] = useState<string[]>([]);
  // For editing: single institute to add to (existing flow)
  const [selectedInstituteId, setSelectedInstituteId] = useState('');
  const [selectedClassroomId, setSelectedClassroomId] = useState('');
  const [availableClassrooms, setAvailableClassrooms] = useState<Classroom[]>([]);
  const [loadingClassrooms, setLoadingClassrooms] = useState(false);

  // Student's current institutes (for editing)
  const [studentInstitutes, setStudentInstitutes] = useState<StudentInstitute[]>([]);
  const [loadingStudentInstitutes, setLoadingStudentInstitutes] = useState(false);

  // School transfer warning
  const [showSchoolWarning, setShowSchoolWarning] = useState(false);
  const [currentActiveSchool, setCurrentActiveSchool] = useState<StudentInstitute | null>(null);

  // User-student link management (for institute admins)
  const [instituteMembers, setInstituteMembers] = useState<InstituteMember[]>([]);
  const [linkedUserIds, setLinkedUserIds] = useState<string[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [linkingUserId, setLinkingUserId] = useState<string | null>(null);

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  const createStudentMutation = useMutation({
    mutationFn: async (studentData: Partial<StudentFormData> & { instituteIds: string[] }) => {
      const res = await apiRequest('POST', '/api/students', studentData);
      return res.json();
    },
    onSuccess: async () => {
      await refetchStudent();
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });

      toast({
        title: t('toast.studentCreated') || 'Student Created',
        description: t('toast.studentCreatedDesc') || 'The student has been created successfully.',
      });

      handleClose();
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
      
      // Assign to new institute if selected
      if (selectedInstituteId && editingStudent?.id) {
        await handleInstituteAssignment(editingStudent.id);
      }
      
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
        gender: editingStudent.gender || '',
        birthDate: editingStudent.birthDate || '',
        framework: editingStudent.framework || 'tala',
        country: editingStudent.country || 'IL',
        grade: (editingStudent as any).grade || '',
        primaryLanguage: editingStudent.primaryLanguage || language,
      });
      loadStudentInstitutes(editingStudent.id);
      loadUserLinks(editingStudent.id);
    } else {
      resetForm();
    }
  }, [editingStudent]);

  // Load institute members when editing (for the link management section)
  useEffect(() => {
    if (editingStudent && currentInstitute?.id && (currentInstitute.type === 'school' || currentInstitute.type === 'clinic')) {
      getMembers(currentInstitute.id)
        .then(setInstituteMembers)
        .catch(() => setInstituteMembers([]));
    } else {
      setInstituteMembers([]);
    }
  }, [editingStudent, currentInstitute?.id]);

  // Load classrooms when institute is selected
  useEffect(() => {
    if (selectedInstituteId) {
      loadClassroomsForInstitute(selectedInstituteId);
    } else {
      setAvailableClassrooms([]);
      setSelectedClassroomId('');
    }
  }, [selectedInstituteId]);

  // Check for school transfer warning
  useEffect(() => {
    if (selectedInstituteId && editingStudent?.id) {
      const selectedInstitute = institutes.find(i => i.id === selectedInstituteId);
      if (selectedInstitute?.type === 'school') {
        // studentInstitutes uses flattened format - type is directly on the object
        const activeSchool = studentInstitutes.find(
          si => si.type === 'school' && si.isActive && si.id !== selectedInstituteId
        );
        if (activeSchool) {
          setCurrentActiveSchool(activeSchool);
          setShowSchoolWarning(true);
        } else {
          setCurrentActiveSchool(null);
          setShowSchoolWarning(false);
        }
      } else {
        setShowSchoolWarning(false);
      }
    } else {
      setShowSchoolWarning(false);
    }
  }, [selectedInstituteId, studentInstitutes, editingStudent, institutes]);

  // ==========================================================================
  // HANDLERS
  // ==========================================================================

  const loadClassroomsForInstitute = async (instituteId: string) => {
    const institute = institutes.find(i => i.id === instituteId);
    if (institute?.type !== 'school') {
      setAvailableClassrooms([]);
      return;
    }
    
    setLoadingClassrooms(true);
    try {
      const classrooms = await getClassrooms(instituteId);
      setAvailableClassrooms(classrooms);
    } catch (error) {
      console.error('Failed to load classrooms:', error);
      setAvailableClassrooms([]);
    } finally {
      setLoadingClassrooms(false);
    }
  };

  const loadUserLinks = async (studentId: string) => {
    setLoadingLinks(true);
    try {
      const res = await apiRequest('GET', `/api/students/${studentId}/links`);
      const data = await res.json();
      const links: UserStudent[] = data?.success ? data.links : [];
      setLinkedUserIds(links.filter(l => l.isActive).map(l => l.userId));
    } catch {
      setLinkedUserIds([]);
    } finally {
      setLoadingLinks(false);
    }
  };

  const handleLinkUser = async (targetUserId: string) => {
    if (!editingStudent || !currentInstitute) return;
    setLinkingUserId(targetUserId);
    try {
      await apiRequest('POST', `/api/students/${editingStudent.id}/link`, {
        targetUserId,
        role: 'caregiver',
        instituteId: currentInstitute.id,
      });
      setLinkedUserIds(prev => [...prev, targetUserId]);
    } catch (error) {
      console.error('Failed to link user:', error);
      toast({ title: t('common.error') || 'Error', description: t('student.linkFailed') || 'Failed to link user', variant: 'destructive' });
    } finally {
      setLinkingUserId(null);
    }
  };

  const handleUnlinkUser = async (targetUserId: string) => {
    if (!editingStudent || !currentInstitute) return;
    setLinkingUserId(targetUserId);
    try {
      await apiRequest('DELETE', `/api/students/${editingStudent.id}/link/${targetUserId}?instituteId=${currentInstitute.id}`);
      setLinkedUserIds(prev => prev.filter(id => id !== targetUserId));
    } catch (error) {
      console.error('Failed to unlink user:', error);
      toast({ title: t('common.error') || 'Error', description: t('student.unlinkFailed') || 'Failed to unlink user', variant: 'destructive' });
    } finally {
      setLinkingUserId(null);
    }
  };

  const loadStudentInstitutes = async (studentId: string) => {
    setLoadingStudentInstitutes(true);
    try {
      const studentInsts = await getStudentInstitutes(studentId);
      setStudentInstitutes(studentInsts);
    } catch (error) {
      console.error('Failed to load student institutes:', error);
      setStudentInstitutes([]);
    } finally {
      setLoadingStudentInstitutes(false);
    }
  };

  const handleInstituteAssignment = async (studentId: string) => {
    try {
      await addStudentToInstitute(selectedInstituteId, studentId, {
        grade: formData.grade || undefined,
      });
      
      // Also assign to classroom if selected
      if (selectedClassroomId) {
        await addStudentToClassroom(selectedClassroomId, studentId, {
          isPrimary: true,
        });
      }
    } catch (error) {
      console.error('Failed to assign student to institute:', error);
      toast({
        title: t('student.warning') || 'Warning',
        description: t('student.instituteAssignFailed') || 'Student saved but institute assignment failed.',
        variant: 'destructive',
      });
    }
  };

  const handleSubmit = () => {
    if (!formData.firstName.trim()) {
      toast({
        title: t('common.error') || 'Error',
        description: t('student.firstNameIsRequired') || 'First name is required',
        variant: 'destructive',
      });
      return;
    }

    // For creation, at least one institute is required
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
      framework: formData.framework,
      country: formData.country,
      primaryLanguage: formData.primaryLanguage || undefined,
    };

    if (editingStudent) {
      updateStudentMutation.mutate({ id: editingStudent.id, data: submitData });
    } else {
      createStudentMutation.mutate({ ...submitData, instituteIds: selectedInstituteIds });
    }
  };

  const resetForm = () => {
    setFormData({ ...INITIAL_FORM_STATE, primaryLanguage: language });
    setSelectedInstituteIds([]);
    setSelectedInstituteId('');
    setSelectedClassroomId('');
    setAvailableClassrooms([]);
    setStudentInstitutes([]);
    setShowSchoolWarning(false);
    setCurrentActiveSchool(null);
    setInstituteMembers([]);
    setLinkedUserIds([]);
    setLinkingUserId(null);
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

  const getGradeLabel = (gradeValue: string) => {
    const grade = GRADE_OPTIONS.find(g => g.value === gradeValue);
    return grade ? (t(`student.grades.${gradeValue}`) || grade.label) : gradeValue;
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

  // Exclude the current user from the linkable members list (do this first because the current user might be a customer service account)
  const otherMembers = instituteMembers.filter(m => m.id !== user?.id);

  // User link management: show only when editing, institute is school/clinic, user is admin, >1 member
  const isCurrentUserAdmin = currentInstitute?.isAdmin ?? false;
  const showUserLinks = !!editingStudent
    && !!currentInstitute
    && (currentInstitute.type === 'school' || currentInstitute.type === 'clinic')
    && isCurrentUserAdmin
    && otherMembers.length > 0;

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
                  <SelectItem value="Male">{t('student.genderMale') || 'Male'}</SelectItem>
                  <SelectItem value="Female">{t('student.genderFemale') || 'Female'}</SelectItem>
                  <SelectItem value="Other">{t('student.genderOther') || 'Other'}</SelectItem>
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

          {/* Row 3: Language and Country */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="studentLanguage">
                {t('student.primaryLanguage') || 'Primary Language'}
              </Label>
              <Select
                value={formData.primaryLanguage}
                onValueChange={(value) => setFormData(prev => ({ ...prev, primaryLanguage: value }))}
              >
                <SelectTrigger id="studentLanguage">
                  <SelectValue placeholder={t('student.selectLanguage') || 'Select language'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="he">עברית (Hebrew)</SelectItem>
                  <SelectItem value="es">Español (Spanish)</SelectItem>
                  <SelectItem value="pt">Português (Portuguese)</SelectItem>
                  <SelectItem value="fr">Français (French)</SelectItem>
                  <SelectItem value="ru">Русский (Russian)</SelectItem>
                  <SelectItem value="de">Deutsch (German)</SelectItem>
                  <SelectItem value="ar">العربية (Arabic)</SelectItem>
                  <SelectItem value="zh">中文 (Mandarin)</SelectItem>
                  <SelectItem value="yue">粵語 (Cantonese)</SelectItem>
                  <SelectItem value="ko">한국어 (Korean)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="studentCountry">
                {t('student.country') || 'Country'}
              </Label>
              <Select
                value={formData.country}
                onValueChange={(value) => setFormData(prev => ({ ...prev, country: value }))}
              >
                <SelectTrigger id="studentCountry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IL">{t('student.countryIsrael') || 'Israel'}</SelectItem>
                  <SelectItem value="US">{t('student.countryUS') || 'United States'}</SelectItem>
                  <SelectItem value="UK">{t('student.countryUK') || 'United Kingdom'}</SelectItem>
                  <SelectItem value="Other">{t('student.countryOther') || 'Other'}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Row 4: System Type */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="studentFramework">
                {t('student.systemType') || 'Educational System'}
              </Label>
              <Select
                value={formData.framework}
                onValueChange={(value) => setFormData(prev => ({ ...prev, framework: value }))}
              >
                <SelectTrigger id="studentFramework">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tala">{t('student.frameworkTala') || 'TALA (Israel)'}</SelectItem>
                  <SelectItem value="us_iep">{t('student.frameworkIep') || 'IEP (US)'}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Institute Assignment Section */}
          <Separator className="my-2" />

          <div className="space-y-4">
            <h3 className="text-sm font-medium">
              {editingStudent
                ? t('student.instituteAssignment') || 'Institute Assignment'
                : (t('student.instituteAssignmentRequired') || 'Institute Assignment *')}
            </h3>

            {/* No institutes warning */}
            {noInstitutes && !editingStudent && (
              <Alert className="border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20">
                <AlertTriangle className="h-4 w-4 text-yellow-600" />
                <AlertDescription className="text-yellow-800 dark:text-yellow-200">
                  {t('student.noInstitutesWarning') || 'You must belong to at least one institute to create a student.'}
                </AlertDescription>
              </Alert>
            )}

            {/* CREATION MODE: Multi-select institute checkboxes */}
            {!editingStudent && !noInstitutes && (
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

            {/* EDITING MODE: Show current institutes */}
            {editingStudent && loadingStudentInstitutes && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common.loading') || 'Loading...'}
              </div>
            )}

            {editingStudent && !loadingStudentInstitutes && studentInstitutes.length > 0 && (
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">
                  {t('student.currentInstitutes') || 'Current Institutes'}
                </Label>
                <div className="space-y-1">
                  {studentInstitutes.map((si) => (
                    <div
                      key={si.id}
                      className={cn(
                        'flex items-center justify-between p-2 rounded-md text-sm',
                        si.isActive ? 'bg-muted' : 'bg-muted/50 opacity-60'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {instituteIcon(si.type)}
                        <span>{si.name}</span>
                        {si.grade && (
                          <Badge variant="outline" className="text-xs">
                            {getGradeLabel(si.grade)}
                          </Badge>
                        )}
                      </div>
                      {!si.isActive && (
                        <Badge variant="secondary" className="text-xs">
                          {t('student.inactive') || 'Inactive'}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* EDITING MODE: Add to another institute */}
            {editingStudent && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="studentInstitute">
                    {t('student.assignToInstitute') || 'Assign to Institute'}
                  </Label>
                  <Select
                    value={selectedInstituteId}
                    onValueChange={setSelectedInstituteId}
                  >
                    <SelectTrigger id="studentInstitute">
                      <SelectValue placeholder={t('student.selectInstitute') || 'Select institute...'} />
                    </SelectTrigger>
                    <SelectContent>
                      {institutes.length === 0 ? (
                        <div className="p-2 text-sm text-muted-foreground text-center">
                          {t('student.noInstitutes') || 'No institutes available'}
                        </div>
                      ) : (
                        <>
                          {schoolInstitutes.length > 0 && (
                            <>
                              <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                                {t('institute.type.schoolPlural') || 'Schools'}
                              </div>
                              {schoolInstitutes.map((institute) => (
                                <SelectItem key={institute.id} value={institute.id}>
                                  <span className="flex items-center gap-2">
                                    <School className="w-4 h-4" />
                                    {institute.name}
                                  </span>
                                </SelectItem>
                              ))}
                            </>
                          )}
                          {clinicInstitutes.length > 0 && (
                            <>
                              <div className="px-2 py-1 text-xs font-semibold text-muted-foreground mt-1">
                                {t('institute.type.clinicPlural') || 'Clinics'}
                              </div>
                              {clinicInstitutes.map((institute) => (
                                <SelectItem key={institute.id} value={institute.id}>
                                  <span className="flex items-center gap-2">
                                    <Hospital className="w-4 h-4" />
                                    {institute.name}
                                  </span>
                                </SelectItem>
                              ))}
                            </>
                          )}
                          {familyInstitutes.length > 0 && (
                            <>
                              <div className="px-2 py-1 text-xs font-semibold text-muted-foreground mt-1">
                                {t('institute.type.familyPlural') || 'Families'}
                              </div>
                              {familyInstitutes.map((institute) => (
                                <SelectItem key={institute.id} value={institute.id}>
                                  <span className="flex items-center gap-2">
                                    <Home className="w-4 h-4" />
                                    {institute.name}
                                  </span>
                                </SelectItem>
                              ))}
                            </>
                          )}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {/* Grade Selection */}
                <div className="space-y-2">
                  <Label htmlFor="studentGradeLevel">
                    {t('student.gradeLevel') || 'Grade Level'}
                  </Label>
                  <Select
                    value={formData.grade}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, grade: value }))}
                  >
                    <SelectTrigger id="studentGradeLevel">
                      <SelectValue placeholder={t('student.selectGrade') || 'Select grade...'} />
                    </SelectTrigger>
                    <SelectContent>
                      {GRADE_OPTIONS.map((grade) => (
                        <SelectItem key={grade.value} value={grade.value}>
                          {t(`student.grades.${grade.value}`) || grade.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Classroom Selection - Only for schools (editing mode) */}
            {editingStudent && selectedInstituteId && institutes.find(i => i.id === selectedInstituteId)?.type === 'school' && (
              <div className="space-y-2">
                <Label htmlFor="studentClassroom">
                  {t('student.assignToClassroom') || 'Assign to Classroom'}
                </Label>
                {loadingClassrooms ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('common.loading') || 'Loading...'}
                  </div>
                ) : (
                  <Select
                    value={selectedClassroomId}
                    onValueChange={setSelectedClassroomId}
                  >
                    <SelectTrigger id="studentClassroom">
                      <SelectValue placeholder={t('student.selectClassroom') || 'Select classroom (optional)...'} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableClassrooms.length === 0 ? (
                        <div className="p-2 text-sm text-muted-foreground text-center">
                          {t('student.noClassrooms') || 'No classrooms available'}
                        </div>
                      ) : (
                        availableClassrooms.map((classroom) => (
                          <SelectItem key={classroom.id} value={classroom.id}>
                            <span className="flex items-center gap-2">
                              <BookOpen className="w-4 h-4" />
                              {classroom.name}
                              {classroom.grade && (
                                <span className="text-muted-foreground text-xs">
                                  ({getGradeLabel(classroom.grade)})
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* School Transfer Warning */}
            {showSchoolWarning && currentActiveSchool && (
              <Alert className="border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20">
                <AlertTriangle className="h-4 w-4 text-yellow-600" />
                <AlertDescription className="text-yellow-800 dark:text-yellow-200">
                  {(t('student.schoolTransferWarningNamed') ||
                    `This student is currently enrolled at ${currentActiveSchool.name}. Assigning to a new school will deactivate their previous enrollment.`
                  ).replace('${currentActiveSchool.name}', currentActiveSchool.name)}
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* User-Student Link Management (institute admins only) */}
          {showUserLinks && (
            <>
              <Separator className="my-2" />
              <div className="space-y-3">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  {t('student.manageUserAccess') || 'User Access'}
                </h3>
                {loadingLinks ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('common.loading') || 'Loading...'}
                  </div>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {otherMembers.map((member) => {
                      const isLinked = linkedUserIds.includes(member.id);
                      const isBusy = linkingUserId === member.id;
                      return (
                        <div
                          key={member.id}
                          className={cn(
                            'flex items-center justify-between p-2 rounded-md text-sm',
                            isLinked ? 'bg-primary/10 border border-primary/20' : 'bg-muted/50'
                          )}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate font-medium">
                              {member.fullName || member.email}
                            </span>
                            {member.role && (
                              <Badge variant="outline" className="text-xs shrink-0">
                                {member.role}
                              </Badge>
                            )}
                          </div>
                          <Button
                            variant={isLinked ? 'destructive' : 'outline'}
                            size="sm"
                            className="shrink-0 ms-2"
                            disabled={isBusy}
                            onClick={() => isLinked ? handleUnlinkUser(member.id) : handleLinkUser(member.id)}
                          >
                            {isBusy ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : isLinked ? (
                              <><UserMinus className="w-3 h-3 me-1" />{t('student.unlink') || 'Remove'}</>
                            ) : (
                              <><UserPlus className="w-3 h-3 me-1" />{t('student.link') || 'Add'}</>
                            )}
                          </Button>
                        </div>
                      );
                    })}
                    {otherMembers.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        {t('student.noOtherMembers') || 'No other members in this institute'}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Biometric Enrollment - hidden until feature is ready
          {editingStudent && (
            <BiometricEnrollment
              entityType="student"
              entityId={editingStudent.id}
              compact
            />
          )}
          */}
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
    </Dialog>
  );
}

// =============================================================================
// USAGE EXAMPLE
// =============================================================================
/*
import { StudentModal } from '@/components/StudentModal';

// In your component:
const [showStudentModal, setShowStudentModal] = useState(false);
const [editingStudent, setEditingStudent] = useState<Student | null>(null);

// Open for new student
const handleCreateStudent = () => {
  setEditingStudent(null);
  setShowStudentModal(true);
};

// Open for editing
const handleEditStudent = (student: Student) => {
  setEditingStudent(student);
  setShowStudentModal(true);
};

// In your JSX:
<StudentModal
  isOpen={showStudentModal}
  onClose={() => {
    setShowStudentModal(false);
    setEditingStudent(null);
  }}
  editingStudent={editingStudent}
/>
*/