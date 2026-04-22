// src/features/StudentInfoPanel.tsx
// Student Info panel — shows student profile details + institute/classroom assignment
// + user-student links. Mirrors the style of SettingsPanel.

import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useStudent } from '@/hooks/useStudent';
import { useStudentLabel } from '@/hooks/useStudentLabel';
import { useInstitute, Classroom, StudentInstitute, InstituteMember } from '@/hooks/useInstitute';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest, apiUrl } from '@/lib/queryClient';
import { openUI } from '@/lib/uiEvents';
import { cn } from '@/lib/utils';
import { UserStudent } from '@shared/schema';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Edit,
  School,
  Hospital,
  Home,
  BookOpen,
  Loader2,
  AlertTriangle,
  UserPlus,
  UserMinus,
  Users,
  GraduationCap,
  Building2,
  UserCircle,
  Save,
} from 'lucide-react';

interface StudentInfoPanelProps {
  isOpen: boolean;
}

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

interface ProfileForm {
  framework: string;
  country: string;
  grade: string;
  primaryLanguage: string;
}

const instituteIcon = (type: string) => {
  if (type === 'school') return <School className="w-4 h-4 text-blue-500" />;
  if (type === 'clinic') return <Hospital className="w-4 h-4 text-green-500" />;
  return <Home className="w-4 h-4 text-amber-500" />;
};

export function StudentInfoPanel({ isOpen }: StudentInfoPanelProps) {
  const { t, isRTL, language } = useLanguage();
  const { ts } = useStudentLabel();
  const { toast } = useToast();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { student, refetchStudent } = useStudent();
  const {
    institutes,
    currentInstitute,
    getClassrooms,
    getMembers,
    addStudentToInstitute,
    getStudentInstitutes,
    addStudentToClassroom,
  } = useInstitute();

  const [form, setForm] = useState<ProfileForm>({
    framework: 'tala',
    country: 'IL',
    grade: '',
    primaryLanguage: language,
  });

  // Institute assignment state
  const [selectedInstituteId, setSelectedInstituteId] = useState('');
  const [selectedClassroomId, setSelectedClassroomId] = useState('');
  const [availableClassrooms, setAvailableClassrooms] = useState<Classroom[]>([]);
  const [loadingClassrooms, setLoadingClassrooms] = useState(false);
  const [studentInstitutes, setStudentInstitutes] = useState<StudentInstitute[]>([]);
  const [loadingStudentInstitutes, setLoadingStudentInstitutes] = useState(false);
  const [showSchoolWarning, setShowSchoolWarning] = useState(false);
  const [currentActiveSchool, setCurrentActiveSchool] = useState<StudentInstitute | null>(null);

  // User-student link management
  const [instituteMembers, setInstituteMembers] = useState<InstituteMember[]>([]);
  const [linkedUserIds, setLinkedUserIds] = useState<string[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [linkingUserId, setLinkingUserId] = useState<string | null>(null);

  // Reset form when student changes
  useEffect(() => {
    if (student) {
      setForm({
        framework: (student as any).framework || 'tala',
        country: (student as any).country || 'IL',
        grade: (student as any).grade || '',
        primaryLanguage: (student as any).primaryLanguage || language,
      });
      setSelectedInstituteId('');
      setSelectedClassroomId('');
      loadStudentInstitutes(student.id);
      loadUserLinks(student.id);
    }
  }, [student?.id]);

  // Load institute members (for link management)
  useEffect(() => {
    if (student && currentInstitute?.id && (currentInstitute.type === 'school' || currentInstitute.type === 'clinic')) {
      getMembers(currentInstitute.id)
        .then(setInstituteMembers)
        .catch(() => setInstituteMembers([]));
    } else {
      setInstituteMembers([]);
    }
  }, [student?.id, currentInstitute?.id]);

  // Load classrooms when institute selected
  useEffect(() => {
    if (selectedInstituteId) {
      const inst = institutes.find(i => i.id === selectedInstituteId);
      if (inst?.type !== 'school') {
        setAvailableClassrooms([]);
        return;
      }
      setLoadingClassrooms(true);
      getClassrooms(selectedInstituteId)
        .then(setAvailableClassrooms)
        .catch(() => setAvailableClassrooms([]))
        .finally(() => setLoadingClassrooms(false));
    } else {
      setAvailableClassrooms([]);
      setSelectedClassroomId('');
    }
  }, [selectedInstituteId]);

  // School transfer warning
  useEffect(() => {
    if (selectedInstituteId && student?.id) {
      const selectedInstitute = institutes.find(i => i.id === selectedInstituteId);
      if (selectedInstitute?.type === 'school') {
        const activeSchool = studentInstitutes.find(
          si => si.type === 'school' && si.isActive && si.id !== selectedInstituteId
        );
        if (activeSchool) {
          setCurrentActiveSchool(activeSchool);
          setShowSchoolWarning(true);
          return;
        }
      }
    }
    setCurrentActiveSchool(null);
    setShowSchoolWarning(false);
  }, [selectedInstituteId, studentInstitutes, student?.id, institutes]);

  const loadStudentInstitutes = async (studentId: string) => {
    setLoadingStudentInstitutes(true);
    try {
      const insts = await getStudentInstitutes(studentId);
      setStudentInstitutes(insts);
    } catch (err) {
      console.error('Failed to load student institutes:', err);
      setStudentInstitutes([]);
    } finally {
      setLoadingStudentInstitutes(false);
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

  const updateStudentMutation = useMutation({
    mutationFn: async (data: Partial<ProfileForm>) => {
      if (!student) throw new Error('No student');
      const res = await apiRequest('PATCH', `/api/students/${student.id}`, data);
      return res.json();
    },
    onSuccess: async () => {
      await refetchStudent();
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: t('toast.studentUpdated') || 'Student Updated',
        description: t('toast.studentUpdatedDesc') || 'The student has been updated successfully.',
      });
    },
    onError: (error: any) => {
      toast({
        title: t('toast.studentUpdateFailed') || 'Failed to Update Student',
        description: error?.message || t('toast.studentUpdateFailedDesc') || 'An error occurred.',
        variant: 'destructive',
      });
    },
  });

  const handleSaveProfile = () => {
    updateStudentMutation.mutate({
      framework: form.framework,
      country: form.country,
      primaryLanguage: form.primaryLanguage,
    });
  };

  const handleInstituteAssignment = async () => {
    if (!student || !selectedInstituteId) return;
    try {
      await addStudentToInstitute(selectedInstituteId, student.id, {
        grade: form.grade || undefined,
      });
      if (selectedClassroomId) {
        await addStudentToClassroom(selectedClassroomId, student.id, { isPrimary: true });
      }
      toast({
        title: t('student.instituteAssigned') || 'Assigned',
        description: t('student.instituteAssignedDesc') || 'Student assignment updated.',
      });
      setSelectedInstituteId('');
      setSelectedClassroomId('');
      await loadStudentInstitutes(student.id);
    } catch (err: any) {
      toast({
        title: t('common.error') || 'Error',
        description: err?.message || t('student.instituteAssignFailed') || 'Assignment failed.',
        variant: 'destructive',
      });
    }
  };

  const handleLinkUser = async (targetUserId: string) => {
    if (!student || !currentInstitute) return;
    setLinkingUserId(targetUserId);
    try {
      await apiRequest('POST', `/api/students/${student.id}/link`, {
        targetUserId,
        role: 'caregiver',
        instituteId: currentInstitute.id,
      });
      setLinkedUserIds(prev => [...prev, targetUserId]);
    } catch {
      toast({ title: t('common.error') || 'Error', description: t('student.linkFailed') || 'Failed to link user', variant: 'destructive' });
    } finally {
      setLinkingUserId(null);
    }
  };

  const handleUnlinkUser = async (targetUserId: string) => {
    if (!student || !currentInstitute) return;
    setLinkingUserId(targetUserId);
    try {
      await apiRequest('DELETE', `/api/students/${student.id}/link/${targetUserId}?instituteId=${currentInstitute.id}`);
      setLinkedUserIds(prev => prev.filter(id => id !== targetUserId));
    } catch {
      toast({ title: t('common.error') || 'Error', description: t('student.unlinkFailed') || 'Failed to unlink user', variant: 'destructive' });
    } finally {
      setLinkingUserId(null);
    }
  };

  const handleOpenEditModal = () => {
    if (!student) return;
    openUI('editStudent', student);
  };

  const getGradeLabel = (gradeValue: string) => {
    const grade = GRADE_OPTIONS.find(g => g.value === gradeValue);
    return grade ? (t(`student.grades.${gradeValue}`) || grade.label) : gradeValue;
  };

  const calculateAge = (birthDateStr?: string | null): number | null => {
    if (!birthDateStr) return null;
    const birth = new Date(birthDateStr);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--;
    return age;
  };

  const schoolInstitutes = institutes.filter(i => i.type === 'school');
  const clinicInstitutes = institutes.filter(i => i.type === 'clinic');
  const familyInstitutes = institutes.filter(i => i.type === 'family');
  const otherMembers = instituteMembers.filter(m => m.id !== user?.id);
  const isCurrentUserAdmin = currentInstitute?.isAdmin ?? false;
  const showUserLinks = !!student
    && !!currentInstitute
    && (currentInstitute.type === 'school' || currentInstitute.type === 'clinic')
    && isCurrentUserAdmin
    && otherMembers.length > 0;

  if (!isOpen) return null;

  if (!student) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="text-center space-y-2">
          <UserCircle className="w-12 h-12 mx-auto text-muted-foreground opacity-50" />
          <p className="text-lg font-medium text-muted-foreground">
            {ts('studentInfo.noStudent') || 'Select a student to view their info'}
          </p>
        </div>
      </div>
    );
  }

  const age = calculateAge((student as any).birthDate);
  const photoSrc = (student as any).biometricDataId
    ? apiUrl(`/api/biometric-data/${(student as any).biometricDataId}/photo`)
    : null;

  return (
    <ScrollArea className="h-full">
      <div className={cn('p-6', isDark ? 'bg-background' : 'bg-gray-50/50')}>
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Header */}
          <div className={isRTL ? 'text-right' : ''}>
            <h1 className="text-3xl font-bold text-foreground mb-2">
              {ts('studentInfo.title') || 'Student Info'}
            </h1>
            <p className="text-muted-foreground">
              {ts('studentInfo.subtitle') || 'View and manage student details'}
            </p>
          </div>

          {/* Profile Section */}
          <Card>
            <CardHeader>
              <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                <UserCircle className="w-5 h-5" />
                {ts('studentInfo.profile') || 'Profile'}
              </CardTitle>
              <CardDescription>
                {ts('studentInfo.profileDesc') || 'Basic identity information'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className={cn('flex items-center gap-4', isRTL && 'flex-row-reverse')}>
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                  {photoSrc ? (
                    <img
                      src={photoSrc}
                      alt={student.name}
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <GraduationCap className="w-8 h-8 text-primary" />
                  )}
                </div>
                <div className={cn('flex-1', isRTL && 'text-right')}>
                  <h3 className="font-semibold text-lg">{student.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {[
                      (student as any).gender && (t(`student.gender${(student as any).gender}`) || (student as any).gender),
                      age !== null && `${age} ${t('student.yearsOld') || 'years old'}`,
                    ].filter(Boolean).join(' • ')}
                  </p>
                  {(student as any).birthDate && (
                    <p className="text-xs text-muted-foreground">
                      {new Date((student as any).birthDate).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <Button variant="outline" onClick={handleOpenEditModal}>
                  <Edit className="w-4 h-4 me-2" />
                  {ts('studentInfo.edit') || 'Edit'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Educational Details */}
          <Card>
            <CardHeader>
              <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                <GraduationCap className="w-5 h-5" />
                {ts('studentInfo.educationalDetails') || 'Educational Details'}
              </CardTitle>
              <CardDescription>
                {ts('studentInfo.educationalDetailsDesc') || 'System, language, and location settings'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('student.systemType') || 'Educational System'}</Label>
                  <Select
                    value={form.framework}
                    onValueChange={(v) => setForm(prev => ({ ...prev, framework: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tala">{t('student.frameworkTala') || 'TALA (Israel)'}</SelectItem>
                      <SelectItem value="us_iep">{t('student.frameworkIep') || 'IEP (US)'}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{t('student.country') || 'Country'}</Label>
                  <Select
                    value={form.country}
                    onValueChange={(v) => setForm(prev => ({ ...prev, country: v }))}
                  >
                    <SelectTrigger>
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

                <div className="space-y-2 md:col-span-2">
                  <Label>{t('student.primaryLanguage') || 'Primary Language'}</Label>
                  <Select
                    value={form.primaryLanguage}
                    onValueChange={(v) => setForm(prev => ({ ...prev, primaryLanguage: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
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
              </div>

              <div className={cn('flex', isRTL ? 'justify-start' : 'justify-end')}>
                <Button
                  onClick={handleSaveProfile}
                  disabled={updateStudentMutation.isPending}
                  className="flex items-center gap-2"
                >
                  {updateStudentMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  {t('common.save') || 'Save'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Institute Assignment */}
          <Card>
            <CardHeader>
              <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                <Building2 className="w-5 h-5" />
                {t('student.instituteAssignment') || 'Institute Assignment'}
              </CardTitle>
              <CardDescription>
                {ts('studentInfo.instituteAssignmentDesc') || 'Schools, clinics, and families this student belongs to'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {loadingStudentInstitutes && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('common.loading') || 'Loading...'}
                </div>
              )}

              {!loadingStudentInstitutes && studentInstitutes.length > 0 && (
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

              {/* Add to another institute */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('student.assignToInstitute') || 'Assign to Institute'}</Label>
                  <Select value={selectedInstituteId} onValueChange={setSelectedInstituteId}>
                    <SelectTrigger>
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
                              {schoolInstitutes.map((inst) => (
                                <SelectItem key={inst.id} value={inst.id}>
                                  <span className="flex items-center gap-2">
                                    <School className="w-4 h-4" />
                                    {inst.name}
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
                              {clinicInstitutes.map((inst) => (
                                <SelectItem key={inst.id} value={inst.id}>
                                  <span className="flex items-center gap-2">
                                    <Hospital className="w-4 h-4" />
                                    {inst.name}
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
                              {familyInstitutes.map((inst) => (
                                <SelectItem key={inst.id} value={inst.id}>
                                  <span className="flex items-center gap-2">
                                    <Home className="w-4 h-4" />
                                    {inst.name}
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

                <div className="space-y-2">
                  <Label>{t('student.gradeLevel') || 'Grade Level'}</Label>
                  <Select
                    value={form.grade}
                    onValueChange={(v) => setForm(prev => ({ ...prev, grade: v }))}
                  >
                    <SelectTrigger>
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

              {/* Classroom — only for schools */}
              {selectedInstituteId && institutes.find(i => i.id === selectedInstituteId)?.type === 'school' && (
                <div className="space-y-2">
                  <Label>{t('student.assignToClassroom') || 'Assign to Classroom'}</Label>
                  {loadingClassrooms ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t('common.loading') || 'Loading...'}
                    </div>
                  ) : (
                    <Select value={selectedClassroomId} onValueChange={setSelectedClassroomId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('student.selectClassroom') || 'Select classroom (optional)...'} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableClassrooms.length === 0 ? (
                          <div className="p-2 text-sm text-muted-foreground text-center">
                            {t('student.noClassrooms') || 'No classrooms available'}
                          </div>
                        ) : (
                          availableClassrooms.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              <span className="flex items-center gap-2">
                                <BookOpen className="w-4 h-4" />
                                {c.name}
                                {c.grade && (
                                  <span className="text-muted-foreground text-xs">
                                    ({getGradeLabel(c.grade)})
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

              {selectedInstituteId && (
                <div className={cn('flex', isRTL ? 'justify-start' : 'justify-end')}>
                  <Button onClick={handleInstituteAssignment} className="flex items-center gap-2">
                    <Save className="w-4 h-4" />
                    {t('student.assign') || 'Assign'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* User-Student Link Management */}
          {showUserLinks && (
            <Card>
              <CardHeader>
                <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                  <Users className="w-5 h-5" />
                  {t('student.manageUserAccess') || 'User Access'}
                </CardTitle>
                <CardDescription>
                  {ts('studentInfo.userAccessDesc') || 'Caregivers and staff with access to this student'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {loadingLinks ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('common.loading') || 'Loading...'}
                  </div>
                ) : (
                  <div className="space-y-1 max-h-64 overflow-y-auto">
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
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
