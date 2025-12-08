// src/features/StudentsPanel.tsx
// Panel showing list of all students (AAC users) with filtering and search

import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useAacUser } from '@/hooks/useAacUser';
import { useFeaturePanel, useSharedState } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { openUI } from '@/lib/uiEvents';

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
  Search,
  Filter,
  Plus,
  MoreHorizontal,
  FileText,
  AlertCircle,
  User,
  GraduationCap,
  Building2,
} from 'lucide-react';

interface StudentsPanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

interface StudentWithProgress {
  id: string;
  name: string;
  idNumber?: string;
  school?: string;
  grade?: string;
  diagnosis?: string;
  disabilityOrSyndrome?: string;
  progress: number;
  currentPhase?: string;
  nextDeadline?: string;
  age?: number;
  role?: string;
  gender?: string;
  birthDate?: string;
  backgroundContext?: string;
  systemType?: string;
  country?: string;
}

export function StudentsPanel({ isOpen, onClose }: StudentsPanelProps) {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { user } = useAuth();
  const { aacUsers, selectAacUser } = useAacUser();
  const { setActiveFeature, registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();
  const { setSharedState } = useSharedState();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // Fetch students with progress data
  const { data: studentsData, isLoading } = useQuery({
    queryKey: ['/api/students/list'],
    queryFn: async () => {
      const response = await apiRequest('GET', '/api/students/list');
      return response.json();
    },
    enabled: !!user && isOpen,
  });

  // Use API data or fallback to aacUsers with mock progress
  const students: StudentWithProgress[] = studentsData?.students || aacUsers.map(u => ({
    ...u,
    progress: Math.floor(Math.random() * 100),
    currentPhase: 'Goal Development',
    nextDeadline: '11/15/2025',
  }));

  // Filter students
  const filteredStudents = students.filter(student => {
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

  // Handle student click - navigate to student progress
  const handleStudentClick = async (studentId: string) => {
    await selectAacUser(studentId);
    setSharedState({ selectedStudentId: studentId });
    setActiveFeature('progress');
  };

  // Handle create new student - opens the create student modal
  const handleCreateStudent = () => {
    openUI('createStudent');
  };

  // Handle edit student - opens the edit student modal with student data
  const handleEditStudent = (student: StudentWithProgress) => {
    openUI('editStudent', {
      id: student.id,
      name: student.name,
      gender: student.gender,
      birthDate: student.birthDate,
      diagnosis: student.diagnosis || student.disabilityOrSyndrome,
      backgroundContext: student.backgroundContext,
      systemType: student.systemType,
      country: student.country,
      school: student.school,
      grade: student.grade,
      idNumber: student.idNumber,
    });
  };

  if (!isOpen) return null;

  return (
    <div className={cn(
      'flex flex-col h-full min-h-0',
      isDark ? 'bg-slate-950' : 'bg-gray-50'
    )}>
      {/* Header */}
      <div className={cn(
        'p-4 border-b shrink-0',
        isDark ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white'
      )}>
        <div className={cn(
          'flex justify-between items-center mb-4',
          isRTL && 'flex-row-reverse'
        )}>
          <div className={isRTL ? 'text-right' : ''}>
            <h1 className={cn(
              'text-xl font-bold',
              isDark ? 'text-white' : 'text-slate-900'
            )}>
              {t('students.title') || 'Students'}
            </h1>
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
          >
            <Plus className="w-4 h-4" />
            {t('students.new_student') || 'New Student'}
          </Button>
        </div>

        {/* Filters */}
        <div className={cn(
          'flex gap-3 items-center',
          isRTL && 'flex-row-reverse'
        )}>
          <div className={cn('relative flex-1 max-w-sm', isRTL && 'text-right')}>
            <Search className={cn(
              'absolute top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground',
              isRTL ? 'right-3' : 'left-3'
            )} />
            <Input
              placeholder={t('students.search_placeholder') || 'Search students...'}
              className={isRTL ? 'pr-10' : 'pl-10'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Filter className="w-4 h-4" />
                {t('students.filter_status') || 'Status'}
                {statusFilter && <Badge variant="secondary" className="ml-1">{statusFilter}</Badge>}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
              <DropdownMenuLabel>{t('students.filter_status') || 'Filter by Status'}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setStatusFilter(null)}>
                All
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter('active')}>
                Active
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setStatusFilter('completed')}>
                Completed
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className={cn(
            'text-sm text-muted-foreground',
            isRTL && 'order-first'
          )}>
            {(t('students.found_count') || '{count} students found')
              .replace('{count}', filteredStudents.length.toString())}
          </span>
        </div>
      </div>

      {/* Student List */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3">
          {filteredStudents.map((student) => (
            <Card
              key={student.id}
              className={cn(
                'group cursor-pointer transition-all duration-200 hover:shadow-md',
                isRTL
                  ? 'border-r-4 border-r-transparent hover:border-r-primary'
                  : 'border-l-4 border-l-transparent hover:border-l-primary',
                isDark 
                  ? 'bg-slate-900 border-slate-800 hover:border-slate-700'
                  : 'bg-white hover:border-primary/20'
              )}
              onClick={() => handleStudentClick(student.id)}
            >
              <CardContent className={cn(
                'p-4 flex items-center gap-4',
                isRTL && 'flex-row-reverse'
              )}>
                {/* Avatar */}
                <div className={cn(
                  'w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg shrink-0 transition-colors',
                  isDark
                    ? 'bg-slate-800 text-slate-300 group-hover:bg-primary group-hover:text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground group-hover:bg-primary group-hover:text-primary-foreground'
                )}>
                  {student.name.split(' ').map(n => n[0]).join('')}
                </div>

                {/* Main Info */}
                <div className={cn(
                  'flex-1 min-w-[150px]',
                  isRTL && 'text-right'
                )}>
                  <div className={cn(
                    'flex items-center gap-2 mb-1',
                    isRTL && 'flex-row-reverse justify-end'
                  )}>
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
                  <div className={cn(
                    'flex items-center gap-2 text-sm text-muted-foreground',
                    isRTL && 'flex-row-reverse justify-end'
                  )}>
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
                  <div className={cn(
                    'w-[150px] hidden md:block',
                    isRTL && 'text-right'
                  )}>
                    <p className="text-xs text-muted-foreground uppercase font-semibold tracking-wider mb-1">
                      {t('students.diagnosis_label') || 'Diagnosis'}
                    </p>
                    <Badge variant="secondary" className="font-normal">
                      {student.diagnosis}
                    </Badge>
                  </div>
                )}

                {/* Progress */}
                <div className="w-[160px] flex flex-col gap-2">
                  <div className={cn(
                    'flex justify-between text-xs mb-1',
                    isRTL && 'flex-row-reverse'
                  )}>
                    <span className="text-muted-foreground">
                      {t('students.progress_label') || 'Progress'}
                    </span>
                    <span className="font-bold">{student.progress}%</span>
                  </div>
                  <div className={cn(
                    'h-2 w-full rounded-full overflow-hidden',
                    isDark ? 'bg-slate-800' : 'bg-secondary'
                  )}>
                    <div
                      className="h-full bg-primary transition-all duration-500"
                      style={{ width: `${student.progress}%` }}
                    />
                  </div>
                  {student.nextDeadline && student.nextDeadline !== '-' && (
                    <div className={cn(
                      'flex items-center gap-1.5 mt-1',
                      isRTL && 'flex-row-reverse'
                    )}>
                      <AlertCircle className="w-3 h-3 text-amber-500" />
                      <span className="text-xs text-amber-600 font-medium">
                        {t('students.due_label') || 'Due'}: {student.nextDeadline}
                      </span>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className={cn(
                  'flex items-center gap-2',
                  isRTL ? 'mr-2' : 'ml-2'
                )}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 hover:bg-primary/10 hover:text-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStudentClick(student.id);
                    }}
                  >
                    <FileText className="w-4 h-4" />
                    {t('students.open_plan') || 'Open Plan'}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                      <DropdownMenuLabel>{t('students.actions') || 'Actions'}</DropdownMenuLabel>
                      <DropdownMenuItem 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditStudent(student);
                        }}
                      >
                        {t('students.edit_details') || 'Edit Details'}
                      </DropdownMenuItem>
                      <DropdownMenuItem>{t('students.view_history') || 'View History'}</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive">
                        {t('students.archive') || 'Archive'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))}

          {filteredStudents.length === 0 && (
            <div className={cn(
              'text-center py-12',
              isDark ? 'text-slate-400' : 'text-slate-600'
            )}>
              <User className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">
                {searchQuery 
                  ? (t('students.no_results') || 'No students match your search')
                  : (t('students.no_students') || 'No students yet')}
              </p>
              {!searchQuery && (
                <Button 
                  className="mt-4"
                  onClick={handleCreateStudent}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  {t('students.add_first') || 'Add Your First Student'}
                </Button>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}