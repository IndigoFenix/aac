// src/features/StudentsPanel.tsx
// Panel showing list of all students (AAC users) with filtering and search
// Simplified RTL support using dir attribute at container level

import { useState, useEffect, useCallback } from 'react';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useChat } from '@/hooks/useChat';
import { useFeaturePanel, useSharedState } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiUrl } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { openUI } from '@/lib/uiEvents';
import { useGuidedSetup } from '@/features/guided-setup/useGuidedSetup';
import { useStudentLabel } from '@/hooks/useStudentLabel';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  Search,
  Filter,
  Plus,
  MoreHorizontal,
  FileText,
  AlertCircle,
  User,
  GraduationCap,
  Building2,
  Loader2,
  Archive,
  RotateCcw,
  Users as UsersIcon,
} from 'lucide-react';

interface StudentsPanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

interface StudentWithProgress {
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  idNumber?: string;
  school?: string;
  grade?: string;
  diagnosis?: string;
  progress: number;
  currentPhase?: string;
  nextDeadline?: string;
  age?: number;
  role?: string;
  gender?: string | null;
  birthDate?: string | null;
  backgroundContext?: string | null;
  framework?: string | null;
  country?: string | null;
  biometricDataId?: string | null;
}

export function StudentsPanel({ isOpen, onClose }: StudentsPanelProps) {
  const { t, isRTL } = useLanguage();
  const { ts } = useStudentLabel();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { students, selectStudent, isLoading } = useStudent();
  const { currentInstitute, institutes, selectInstitute, currentPermissions } = useInstitute();
  const instituteId = currentInstitute?.id;
  const dashboardLevel = currentPermissions?.dashboardLevel ?? 0;
  const showProgress = dashboardLevel === -1 || dashboardLevel > 0;
  const { aiRefreshing } = useChat();
  const isAiRefreshing = aiRefreshing.has('students');
  const { setActiveFeature, registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();
  const { sharedState, setSharedState } = useSharedState();
  const {
    start: startGuidedSetup,
    isLaunching: guidedLaunching,
    isChatBusy: guidedChatBusy,
  } = useGuidedSetup();
  // "New student" opens a chat and waits 10–20 s for the first reply. Spin
  // while THIS button's turn is in flight; refuse the click while any chat turn
  // is, so a second press cannot open a second flow on top of the first.
  const newStudentBusy = guidedLaunching || guidedChatBusy;

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // ── Archive / restore ─────────────────────────────────────────────────────
  // The Archive menu item was wired to nothing until 2026-09-11 (its click
  // bubbled to the card and merely opened the student). Archiving flips the
  // student's `isActive` on the server and nothing else; every roster and
  // session query filters on that flag, so the student drops out of the list
  // and out of AAC sessions, and comes back with Restore.
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [archiveTarget, setArchiveTarget] = useState<StudentWithProgress | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  type ArchivedStudent = { id: string; name: string; age?: number | null };
  const archivedQuery = useQuery<ArchivedStudent[]>({
    queryKey: ['/api/students/archived', instituteId],
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `/api/students/archived?instituteId=${encodeURIComponent(instituteId as string)}`,
      );
      const data = await res.json();
      return (data?.students ?? []) as ArchivedStudent[];
    },
    enabled: !!instituteId && showArchived,
  });

  // StudentProvider keeps the roster in useState behind a manual fetch, so a
  // query invalidation alone refreshes nothing it renders from — the event is
  // what it listens for (the same one the AI's own writes fire).
  const afterArchiveChange = () => {
    window.dispatchEvent(new CustomEvent('cliniaacian:students-updated'));
    queryClient.invalidateQueries({ queryKey: ['/api/students'] });
    queryClient.invalidateQueries({ queryKey: ['/api/students/archived', instituteId] });
  };

  const archiveMutation = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await apiRequest('POST', `/api/students/${studentId}/archive`);
      return res.json();
    },
    onSuccess: async (_data, studentId) => {
      toast({ title: ts('students.archived') });
      // An archived student must not stay selected: every panel would go on
      // showing somebody the roster no longer lists.
      if (sharedState.selectedStudentId === studentId) {
        setSharedState({ selectedStudentId: undefined });
        await selectStudent(null);
      }
      afterArchiveChange();
    },
    onError: (err: Error) => {
      toast({ title: ts('students.archiveFailed'), description: err.message, variant: 'destructive' });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await apiRequest('POST', `/api/students/${studentId}/restore`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: ts('students.restored') });
      afterArchiveChange();
    },
    onError: (err: Error) => {
      toast({ title: ts('students.restoreFailed'), description: err.message, variant: 'destructive' });
    },
  });

  // `useStudent()` already scopes `students` to the selected institute (and
  // clears it when none is selected), so it is the only source of truth here.
  // There used to be a second, unscoped `/api/students` query; the server is
  // fail-closed without an instituteId, so that query always resolved to
  // `[]` and its result was silently discarded in favor of `students` anyway.
  const studentsWithProgress: StudentWithProgress[] = students.map(u => ({
    ...u,
    progress: 0,
    currentPhase: '---',
    nextDeadline: '---',
  }));

  // Filter students
  const filteredStudents = studentsWithProgress.filter(student => {
    const matchesSearch = !searchQuery || 
      student.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      student.idNumber?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      student.school?.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesStatus = !statusFilter || 
      (statusFilter === 'active' && student.progress < 100) ||
      (statusFilter === 'completed' && student.progress >= 100);

    return matchesSearch && matchesStatus;
  });

  // Register metadata builder
  const buildStudentsMetadata = useCallback(() => {
    return {
      totalStudents: students.length,
      filteredCount: filteredStudents.length,
    };
  }, [students.length, filteredStudents.length]);

  useEffect(() => {
    registerMetadataBuilder('students', buildStudentsMetadata);
    return () => unregisterMetadataBuilder('students');
  }, [registerMetadataBuilder, unregisterMetadataBuilder, buildStudentsMetadata]);

  // Handle student click - select the student and open their info panel
  const handleStudentClick = async (studentId: string) => {
    setSharedState({ selectedStudentId: studentId });
    await selectStudent(studentId);
    setActiveFeature('studentInfo');
  };

  const goToProgress = async (studentId: string) => {
    setSharedState({ selectedStudentId: studentId });
    selectStudent(studentId);
    setActiveFeature('progress');
  }

  // Handle create new student — starts the chat-driven Guided Setup flow. The
  // real form is still one click away: the rail offers "use a form instead",
  // which fires openUI('createStudent').
  const handleCreateStudent = () => {
    if (newStudentBusy || !instituteId) return;
    void startGuidedSetup();
  };

  // Handle edit student - opens the edit student modal with student data
  const handleEditStudent = (student: StudentWithProgress) => {
    openUI('editStudent', {
      id: student.id,
      name: student.name,
      firstName: student.firstName,
      lastName: student.lastName,
      gender: student.gender,
      birthDate: student.birthDate,
      framework: student.framework,
      country: student.country,
      biometricDataId: student.biometricDataId,
    });
  };

  if (!isOpen) return null;

  return (
    <div 
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn(
        'flex flex-col h-full min-h-0',
        isDark ? 'bg-slate-950' : 'bg-gray-50'
      )}
    >
      {/* Header */}
      <div className={cn(
        'p-4 border-b shrink-0',
        isDark ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white'
      )}>
        <div className="flex justify-between items-center mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className={cn(
                'text-xl font-bold',
                isDark ? 'text-white' : 'text-slate-900'
              )}>
                {t('students.title') || 'Students'}
              </h1>
              {isAiRefreshing && (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              )}
            </div>
            <p className={cn(
              'text-sm',
              isDark ? 'text-slate-400' : 'text-slate-600'
            )}>
              {t('students.subtitle') || 'Manage student profiles and progress'}
            </p>
          </div>
          <Button
            className="gap-2 bg-primary text-primary-foreground shadow-md"
            onClick={handleCreateStudent}
            disabled={newStudentBusy || !instituteId}
            title={!instituteId ? ts('students.selectInstituteFirst') : undefined}
          >
            {guidedLaunching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {t('students.newStudent')}
          </Button>
        </div>

        {/* Filters */}
        <div className="flex gap-3 items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className={cn(
              'absolute top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground',
              isRTL ? 'right-3' : 'left-3'
            )} />
            <Input
              placeholder={t('students.searchPlaceholder') || 'Search students...'}
              className={isRTL ? 'pr-10' : 'pl-10'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Filter className="w-4 h-4" />
                {t('students.filterBy') || 'Filter'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
              <DropdownMenuLabel>{t('students.status') || 'Status'}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setStatusFilter(null)}>
                {t('students.allStatus') || 'All'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter('active')}>
                {t('students.activeStatus') || 'Active'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter('completed')}>
                {t('students.completedStatus') || 'Completed'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="text-sm text-muted-foreground">
            {(t('students.foundCount') || '{count} students found')
              .replace('{count}', filteredStudents.length.toString())}
          </span>

          <div className="flex-1" />

          {instituteId && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground"
              onClick={() => setShowArchived((v) => !v)}
              aria-pressed={showArchived}
            >
              <Archive className="w-4 h-4" />
              {showArchived ? t('students.hideArchived') : t('students.showArchived')}
            </Button>
          )}
        </div>
      </div>

      {/* Student List */}
      <ScrollArea dir={isRTL ? 'rtl' : 'ltr'} className="flex-1">
        <div className="p-4 space-y-3">
          {!instituteId ? (
            <div className={cn(
              'text-center py-12',
              isDark ? 'text-slate-400' : 'text-slate-600'
            )}>
              <User className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">{ts('students.selectInstituteEmpty')}</p>
              {institutes.length > 0 && (
                <div className="mt-4 flex justify-center">
                  <select
                    className={cn(
                      'max-w-[220px] text-sm border border-input bg-background rounded-md px-3 py-2',
                      'focus:outline-none focus:ring-2 focus:ring-primary'
                    )}
                    dir="auto"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) selectInstitute(e.target.value);
                    }}
                  >
                    <option value="" disabled>{t('header.selectInstitute')}</option>
                    {institutes.map((institute) => (
                      <option key={institute.id} value={institute.id}>{institute.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredStudents.length === 0 ? (
            <div className={cn(
              'text-center py-12',
              isDark ? 'text-slate-400' : 'text-slate-600'
            )}>
              <User className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">
                {searchQuery
                  ? (t('students.noResults') || 'No students match your search')
                  : (t('students.noStudents') || 'No students yet')}
              </p>
              {!searchQuery && (
                <Button
                  className="mt-4"
                  onClick={handleCreateStudent}
                  disabled={newStudentBusy}
                >
                  {guidedLaunching ? (
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4 me-2" />
                  )}
                  {t('students.addFirst')}
                </Button>
              )}
            </div>
          ) : (
          filteredStudents.map((student) => (
            <Card
              key={student.id}
              dir={isRTL ? 'rtl' : 'ltr'}
              className={cn(
                'group cursor-pointer transition-all duration-200 hover:shadow-md',
                isRTL
                  ? 'border-r-4 border-r-transparent hover:border-r-primary'
                  : 'border-l-4 border-l-transparent hover:border-l-primary',
                sharedState.selectedStudentId === student.id
                  ? isRTL
                    ? 'border-r-4 border-r-primary shadow-lg'
                    : 'border-l-4 border-l-primary shadow-lg'
                  : '',
                isDark 
                  ? cn(
                      'bg-slate-900 border-slate-800 hover:border-slate-700',
                      sharedState.selectedStudentId === student.id && 'bg-slate-800'
                    )
                  : cn(
                      'bg-white hover:border-primary/20',
                      sharedState.selectedStudentId === student.id && 'bg-primary/5 border-primary/30'
                    )
              )}
              onClick={() => handleStudentClick(student.id)}
            >
              <CardContent className="p-4 flex items-center gap-4">
                {/* Avatar */}
                <div className={cn(
                  'w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg shrink-0 transition-colors overflow-hidden',
                  isDark
                    ? 'bg-slate-800 text-slate-300 group-hover:bg-primary group-hover:text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground group-hover:bg-primary group-hover:text-primary-foreground'
                )}>
                  {student.biometricDataId ? (
                    <img
                      src={apiUrl(`/api/biometric-data/${student.biometricDataId}/photo`)}
                      alt={student.name}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        const target = e.currentTarget as HTMLImageElement;
                        target.style.display = 'none';
                        const parent = target.parentElement;
                        if (parent) {
                          const initials = student.name.split(' ').map(n => n[0]).join('');
                          parent.innerHTML = initials;
                        }
                      }}
                    />
                  ) : (
                    student.name.split(' ').map(n => n[0]).join('')
                  )}
                </div>

                {/* Main Info */}
                <div className="flex-1 min-w-[150px]">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className={cn(
                      'font-bold text-base transition-colors',
                      isDark ? 'text-white' : 'text-slate-900',
                      'group-hover:text-primary'
                    )}>
                      {student.name}
                    </h3>
                    {student.idNumber && (
                      <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
                        ID: {student.idNumber}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    {student.grade && (
                      <>
                        <GraduationCap className="w-3 h-3" />
                        <span>{student.grade}</span>
                      </>
                    )}
                    {student.school && (
                      <>
                        <span className="w-1 h-1 bg-muted-foreground/40 rounded-full" />
                        <Building2 className="w-3 h-3" />
                        <span>{student.school}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Diagnosis */}
                {student.diagnosis && (
                  <div className="w-[150px] hidden md:block">
                    <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider mb-1">
                      {t('students.diagnosisLabel') || 'Diagnosis'}
                    </p>
                    <Badge variant="secondary" className="font-normal">
                      {student.diagnosis}
                    </Badge>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Student actions">
                        <MoreHorizontal className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                      <DropdownMenuLabel>{t('students.actions') || 'Actions'}</DropdownMenuLabel>
                      {showProgress && (
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            goToProgress(student.id);
                          }}>
                          {t('students.openProgress') || 'Open Plan'}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditStudent(student);
                        }}
                      >
                        {t('students.editDetails') || 'Edit Details'}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          selectStudent(student.id);
                          setActiveFeature('contacts');
                        }}
                      >
                        <UsersIcon className="w-4 h-4 me-2" />
                        {t('students.manageContacts') || 'Manage Contacts'}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setArchiveTarget(student);
                        }}
                      >
                        <Archive className="w-4 h-4 me-2" />
                        {t('students.archive')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))
          )}

          {/* Archived students — only on request, with the one move they
              need. Restore is offered to exactly the people who could see
              the student while active (same visibility query, inactive rows). */}
          {showArchived && instituteId && (
            <div className="pt-4 space-y-2" aria-busy={archivedQuery.isFetching}>
              <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                <Archive className="w-4 h-4" aria-hidden="true" />
                {ts('students.archivedSection')}
                {archivedQuery.isFetching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              </h2>
              {archivedQuery.isLoading ? null : (archivedQuery.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">{ts('students.noArchived')}</p>
              ) : (
                (archivedQuery.data ?? []).map((s) => (
                  <Card key={s.id} dir={isRTL ? 'rtl' : 'ltr'} className="opacity-80">
                    <CardContent className="p-3 flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                        <User className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{s.name}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={restoreMutation.isPending}
                        onClick={() => restoreMutation.mutate(s.id)}
                      >
                        {restoreMutation.isPending && restoreMutation.variables === s.id ? (
                          <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3.5 h-3.5 me-1.5" />
                        )}
                        {t('students.restore')}
                      </Button>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Archive confirmation. A destructive-styled action for something that
          is reversible reads wrong, so the button is the default style and the
          body says what actually happens: hidden, not deleted, restorable. */}
      <AlertDialog open={!!archiveTarget} onOpenChange={(open) => !open && setArchiveTarget(null)}>
        <AlertDialogContent dir={isRTL ? 'rtl' : 'ltr'}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('students.archiveConfirmTitle', { name: archiveTarget?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{ts('students.archiveConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveMutation.isPending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!archiveTarget) return;
                archiveMutation.mutate(archiveTarget.id, { onSettled: () => setArchiveTarget(null) });
              }}
            >
              {archiveMutation.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('students.archive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}