// src/features/StudentProgressPanel.tsx
// Comprehensive IEP/TALA Program Management Panel
// Uses types derived from schema.ts as single source of truth

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useStudent } from '@/hooks/useStudent';
import { useFeaturePanel, useSharedState } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest } from '@/lib/queryClient';
import { cn } from '@/lib/utils';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import {
  CheckCircle2,
  Circle,
  Clock,
  ArrowRight,
  ArrowLeft,
  FileText,
  Download,
  Share2,
  Plus,
  ChevronDown,
  Activity,
  Target,
  BarChart3,
  Brain,
  Trash2,
  Edit,
  Loader2,
  Calendar,
  Users,
  BookOpen,
  Settings,
  MoreHorizontal,
  TrendingUp,
  Award,
  Briefcase,
  GraduationCap,
  Heart,
  Hand,
  Lightbulb,
  MessageSquare,
  UserPlus,
  FileSignature,
  Building2,
  PlayCircle,
  Archive,
  Unlock,
} from 'lucide-react';

// Import types from shared schema (single source of truth)
import type {
  Program,
  ProfileDomain,
  Goal,
  Objective,
  Service,
  Accommodation,
  TeamMember,
  Meeting,
  ConsentForm,
  ProgressReport,
  DataPoint,
  InsertGoal,
  InsertObjective,
  InsertService,
  InsertDataPoint,
  InsertTeamMember,
  ProgramFramework,
  ProgramStatus,
  ProfileDomainType,
  GoalStatus,
  ObjectiveStatus,
  ServiceType,
  ServiceFrequencyPeriod,
  ServiceSetting,
  ServiceDeliveryModel,
  ProgressStatus,
  TeamMemberRole,
} from '@shared/schema';

// Composite type for full program details (not in schema, defined locally)
interface ProgramWithDetails {
  program: Program;
  profileDomains: ProfileDomain[];
  goals: Goal[];
  services: Service[];
  accommodations: Accommodation[];
  teamMembers: TeamMember[];
  meetings: Meeting[];
  consentForms: ConsentForm[];
  progressReports: ProgressReport[];
}

interface GoalWithNested extends Goal {
  objectives?: Objective[];
  dataPoints?: DataPoint[];
}

// =============================================================================
// PROPS
// =============================================================================

interface StudentProgressPanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DOMAIN_ICONS: Record<ProfileDomainType, React.ReactNode> = {
  cognitive_academic: <Brain className="w-4 h-4" />,
  communication_language: <MessageSquare className="w-4 h-4" />,
  social_emotional_behavioral: <Heart className="w-4 h-4" />,
  motor_sensory: <Hand className="w-4 h-4" />,
  life_skills_preparation: <Lightbulb className="w-4 h-4" />,
  other: <FileText className="w-4 h-4" />,
};

const SERVICE_ICONS: Record<ServiceType, React.ReactNode> = {
  speech_language_therapy: <MessageSquare className="w-4 h-4" />,
  occupational_therapy: <Hand className="w-4 h-4" />,
  physical_therapy: <Activity className="w-4 h-4" />,
  counseling: <Heart className="w-4 h-4" />,
  specialized_instruction: <GraduationCap className="w-4 h-4" />,
  consultation: <Users className="w-4 h-4" />,
  aac_support: <Briefcase className="w-4 h-4" />,
  other: <FileText className="w-4 h-4" />,
};

const STATUS_COLORS: Record<GoalStatus | ObjectiveStatus | ProgramStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  active: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  achieved: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  modified: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  discontinued: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  not_started: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  in_progress: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  archived: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

const PROGRESS_STATUS_COLORS: Record<ProgressStatus, string> = {
  significant_progress: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  making_progress: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  limited_progress: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  no_progress: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  regression: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  goal_met: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
};

// =============================================================================
// FORM TYPES (for internal state management)
// =============================================================================

interface GoalFormState {
  goalStatement: string;
  profileDomainId: string;
  targetBehavior: string;
  criteria: string;
  conditions: string;
  targetDate: string;
}

interface ObjectiveFormState {
  objectiveStatement: string;
  criterion: string;
  context: string;
  targetDate: string;
}

interface ServiceFormState {
  serviceType: ServiceType;
  customServiceName: string;
  description: string;
  frequencyCount: number;
  frequencyPeriod: ServiceFrequencyPeriod;
  sessionDuration: number;
  setting: ServiceSetting;
  deliveryModel: ServiceDeliveryModel;
  providerName: string;
}

interface DataPointFormState {
  numericValue: string;
  value: string;
  context: string;
}

interface TeamMemberFormState {
  name: string;
  contactEmail: string;
  role: TeamMemberRole;
  customRole: string;
  contactPhone: string;
  isCoordinator: boolean;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get display name for a service
 */
function getServiceDisplayName(service: Service): string {
  return service.customServiceName || service.serviceType.replace(/_/g, ' ');
}

/**
 * Calculate weekly service minutes
 */
function calculateWeeklyMinutes(service: Service): number {
  const periodsPerWeek = 
    service.frequencyPeriod === 'daily' ? 5 : 
    service.frequencyPeriod === 'weekly' ? 1 : 
    0.25; // monthly
  return service.frequencyCount * service.sessionDuration * periodsPerWeek;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function StudentProgressPanel({ isOpen, onClose }: StudentProgressPanelProps) {
  const { t, isRTL } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { user } = useAuth();
  const { student } = useStudent();
  const { setActiveFeature, registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();
  const { sharedState } = useSharedState();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // State
  const [activeTab, setActiveTab] = useState('overview');
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [showObjectiveModal, setShowObjectiveModal] = useState(false);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [showDataPointModal, setShowDataPointModal] = useState(false);
  const [showTeamMemberModal, setShowTeamMemberModal] = useState(false);
  
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [selectedGoalForObjective, setSelectedGoalForObjective] = useState<string | null>(null);
  const [selectedGoalForDataPoint, setSelectedGoalForDataPoint] = useState<string | null>(null);
  
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(new Set());

  // Form states - using schema-aligned field names
  const [programForm, setProgramForm] = useState({
    framework: 'tala' as ProgramFramework,
    programYear: new Date().getFullYear().toString(),
  });
  
  const [goalForm, setGoalForm] = useState<GoalFormState>({
    goalStatement: '',
    profileDomainId: '',
    targetBehavior: '',
    criteria: '',
    conditions: '',
    targetDate: '',
  });
  
  const [objectiveForm, setObjectiveForm] = useState<ObjectiveFormState>({
    objectiveStatement: '',
    criterion: '',
    context: '',
    targetDate: '',
  });
  
  const [serviceForm, setServiceForm] = useState<ServiceFormState>({
    serviceType: 'speech_language_therapy',
    customServiceName: '',
    description: '',
    frequencyCount: 1,
    frequencyPeriod: 'weekly',
    sessionDuration: 30,
    setting: 'therapy_room',
    deliveryModel: 'direct',
    providerName: '',
  });
  
  const [dataPointForm, setDataPointForm] = useState<DataPointFormState>({
    numericValue: '',
    value: '',
    context: '',
  });
  
  const [teamMemberForm, setTeamMemberForm] = useState<TeamMemberFormState>({
    name: '',
    contactEmail: '',
    role: 'parent_guardian',
    customRole: '',
    contactPhone: '',
    isCoordinator: false,
  });

  // =============================================================================
  // QUERIES
  // =============================================================================

  // Fetch current program for student
  const { data: currentProgramData, isLoading: isLoadingProgram } = useQuery({
    queryKey: ['/api/students', student?.id, 'programs', 'current'],
    queryFn: async () => {
      if (!student?.id) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${student.id}/programs/current`);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error('Failed to fetch program');
      }
      return response.json();
    },
    enabled: !!student?.id && isOpen,
  });

  // Fetch full program details if we have a current program
  const currentProgram = currentProgramData?.program;
  
  const { data: programDetails, isLoading: isLoadingDetails } = useQuery<ProgramWithDetails>({
    queryKey: ['/api/programs', currentProgram?.id, 'full'],
    queryFn: async () => {
      if (!currentProgram?.id) throw new Error('No program');
      const response = await apiRequest('GET', `/api/programs/${currentProgram.id}/full`);
      if (!response.ok) throw new Error('Failed to fetch program details');
      return response.json();
    },
    enabled: !!currentProgram?.id && isOpen,
  });

  // Fetch all programs for student (for history)
  const { data: allProgramsData } = useQuery({
    queryKey: ['/api/students', student?.id, 'programs'],
    queryFn: async () => {
      if (!student?.id) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${student.id}/programs`);
      if (!response.ok) throw new Error('Failed to fetch programs');
      return response.json();
    },
    enabled: !!student?.id && isOpen,
  });

  // Extract data with proper types
  const program = (programDetails?.program || currentProgram) as Program | undefined;
  const domains = (programDetails?.profileDomains || []) as ProfileDomain[];
  const goals = (programDetails?.goals || []) as GoalWithNested[];
  const services = (programDetails?.services || []) as Service[];
  const accommodations = (programDetails?.accommodations || []) as Accommodation[];
  const teamMembers = (programDetails?.teamMembers || []) as TeamMember[];
  const meetings = (programDetails?.meetings || []) as Meeting[];
  const consentForms = (programDetails?.consentForms || []) as ConsentForm[];
  const progressReports = (programDetails?.progressReports || []) as ProgressReport[];
  const allPrograms = (allProgramsData?.programs || []) as Program[];

  // =============================================================================
  // MUTATIONS
  // =============================================================================

  // Create program
  const createProgramMutation = useMutation({
    mutationFn: async (data: { framework: ProgramFramework; programYear: string }) => {
      const response = await apiRequest('POST', `/api/students/${student?.id}/programs`, {
        ...data,
        createDefaultDomains: true,
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create program');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'programs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'programs', 'current'] });
      toast({ title: t('program.created'), description: t('program.createdDesc') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Activate program
  const activateProgramMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/programs/${program?.id}/activate`);
      if (!response.ok) throw new Error('Failed to activate program');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'programs'] });
      toast({ title: t('program.activated') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Archive program
  const archiveProgramMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/programs/${program?.id}/archive`);
      if (!response.ok) throw new Error('Failed to archive program');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'programs'] });
      toast({ title: t('program.archived') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Update domain - using schema field names (impactStatement, adverseEffectStatement, NOT presentLevels/educationalImpact)
  const updateDomainMutation = useMutation({
    mutationFn: async ({ domainId, updates }: { domainId: string; updates: Partial<ProfileDomain> }) => {
      const response = await apiRequest('PATCH', `/api/domains/${domainId}`, updates);
      if (!response.ok) throw new Error('Failed to update domain');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('common.saved') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create goal - using schema field names (goalStatement, NOT title/description)
  const createGoalMutation = useMutation({
    mutationFn: async (goalData: InsertGoal) => {
      const response = await apiRequest('POST', `/api/programs/${program?.id}/goals`, goalData);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create goal');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('goal.created') });
      setShowGoalModal(false);
      resetGoalForm();
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Update goal
  const updateGoalMutation = useMutation({
    mutationFn: async ({ goalId, updates }: { goalId: string; updates: Partial<Goal> }) => {
      const response = await apiRequest('PATCH', `/api/goals/${goalId}`, updates);
      if (!response.ok) throw new Error('Failed to update goal');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('goal.updated') });
      setShowGoalModal(false);
      setEditingGoal(null);
      resetGoalForm();
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Delete goal
  const deleteGoalMutation = useMutation({
    mutationFn: async (goalId: string) => {
      const response = await apiRequest('DELETE', `/api/goals/${goalId}`);
      if (!response.ok) throw new Error('Failed to delete goal');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('goal.deleted') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create objective - using schema field names (objectiveStatement, criterion, NOT description/criteria)
  const createObjectiveMutation = useMutation({
    mutationFn: async ({ goalId, data }: { goalId: string; data: InsertObjective }) => {
      const response = await apiRequest('POST', `/api/goals/${goalId}/objectives`, data);
      if (!response.ok) throw new Error('Failed to create objective');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('objective.created') });
      setShowObjectiveModal(false);
      resetObjectiveForm();
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create service - using schema field names (customServiceName, frequencyCount, sessionDuration, providerName)
  const createServiceMutation = useMutation({
    mutationFn: async (serviceData: InsertService) => {
      const response = await apiRequest('POST', `/api/programs/${program?.id}/services`, serviceData);
      if (!response.ok) throw new Error('Failed to create service');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('service.created') });
      setShowServiceModal(false);
      resetServiceForm();
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Update service
  const updateServiceMutation = useMutation({
    mutationFn: async ({ serviceId, updates }: { serviceId: string; updates: Partial<Service> }) => {
      const response = await apiRequest('PATCH', `/api/services/${serviceId}`, updates);
      if (!response.ok) throw new Error('Failed to update service');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('service.updated') });
      setShowServiceModal(false);
      setEditingService(null);
      resetServiceForm();
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Delete service
  const deleteServiceMutation = useMutation({
    mutationFn: async (serviceId: string) => {
      const response = await apiRequest('DELETE', `/api/services/${serviceId}`);
      if (!response.ok) throw new Error('Failed to delete service');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('service.deleted') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create data point - using schema field names (value, context, NOT textValue/sessionNotes)
  const createDataPointMutation = useMutation({
    mutationFn: async ({ goalId, data }: { goalId: string; data: InsertDataPoint }) => {
      const response = await apiRequest('POST', `/api/goals/${goalId}/data-points`, data);
      if (!response.ok) throw new Error('Failed to create data point');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('dataPoint.created') });
      setShowDataPointModal(false);
      resetDataPointForm();
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Create team member - using schema field names (contactEmail, contactPhone, NOT email/phone)
  const createTeamMemberMutation = useMutation({
    mutationFn: async (data: InsertTeamMember) => {
      const response = await apiRequest('POST', `/api/programs/${program?.id}/team`, data);
      if (!response.ok) throw new Error('Failed to add team member');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('team.memberAdded') });
      setShowTeamMemberModal(false);
      resetTeamMemberForm();
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Delete team member
  const deleteTeamMemberMutation = useMutation({
    mutationFn: async (memberId: string) => {
      const response = await apiRequest('DELETE', `/api/team-members/${memberId}`);
      if (!response.ok) throw new Error('Failed to remove team member');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('team.memberRemoved') });
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // =============================================================================
  // HELPERS
  // =============================================================================

  const resetGoalForm = () => {
    setGoalForm({
      goalStatement: '',
      profileDomainId: '',
      targetBehavior: '',
      criteria: '',
      conditions: '',
      targetDate: '',
    });
    setEditingGoal(null);
  };

  const resetObjectiveForm = () => {
    setObjectiveForm({
      objectiveStatement: '',
      criterion: '',
      context: '',
      targetDate: '',
    });
    setSelectedGoalForObjective(null);
  };

  const resetServiceForm = () => {
    setServiceForm({
      serviceType: 'speech_language_therapy',
      customServiceName: '',
      description: '',
      frequencyCount: 1,
      frequencyPeriod: 'weekly',
      sessionDuration: 30,
      setting: 'therapy_room',
      deliveryModel: 'direct',
      providerName: '',
    });
    setEditingService(null);
  };

  const resetDataPointForm = () => {
    setDataPointForm({ numericValue: '', value: '', context: '' });
    setSelectedGoalForDataPoint(null);
  };

  const resetTeamMemberForm = () => {
    setTeamMemberForm({
      name: '',
      contactEmail: '',
      role: 'parent_guardian',
      customRole: '',
      contactPhone: '',
      isCoordinator: false,
    });
  };

  const handleBackClick = () => {
    setActiveFeature('students');
  };

  const toggleDomainExpanded = (domainId: string) => {
    setExpandedDomains(prev => {
      const next = new Set(prev);
      if (next.has(domainId)) next.delete(domainId);
      else next.add(domainId);
      return next;
    });
  };

  const toggleGoalExpanded = (goalId: string) => {
    setExpandedGoals(prev => {
      const next = new Set(prev);
      if (next.has(goalId)) next.delete(goalId);
      else next.add(goalId);
      return next;
    });
  };

  // Calculate statistics using schema field names (progress, NOT currentProgress)
  const stats = useMemo(() => {
    const activeGoals = goals.filter((g) => g.status === 'active').length;
    const achievedGoals = goals.filter((g) => g.status === 'achieved').length;
    const totalGoals = goals.length;
    const goalProgress = totalGoals > 0 ? Math.round((achievedGoals / totalGoals) * 100) : 0;
    
    const totalServiceMinutes = services
      .filter((s) => s.isActive)
      .reduce((sum, s) => sum + calculateWeeklyMinutes(s), 0);

    return { activeGoals, achievedGoals, totalGoals, goalProgress, totalServiceMinutes };
  }, [goals, services]);

  // Register metadata builder
  const buildProgressMetadata = useCallback(() => {
    return {
      studentId: student?.id,
      programId: program?.id,
      framework: program?.framework,
      status: program?.status,
    };
  }, [student?.id, program?.id, program?.framework, program?.status]);

  useEffect(() => {
    registerMetadataBuilder('progress', buildProgressMetadata);
    return () => unregisterMetadataBuilder('progress');
  }, [registerMetadataBuilder, unregisterMetadataBuilder, buildProgressMetadata]);

  // =============================================================================
  // RENDER
  // =============================================================================

  if (!isOpen) return null;

  if (!student) {
    return (
      <div className={cn(
        'flex items-center justify-center h-full',
        isDark ? 'bg-slate-950 text-slate-400' : 'bg-gray-50 text-slate-600'
      )}>
        <div className="text-center">
          <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="text-lg">{t('program.noStudentSelected')}</p>
          <Button className="mt-4" onClick={handleBackClick}>
            {t('program.goToStudents')}
          </Button>
        </div>
      </div>
    );
  }

  if (isLoadingProgram || isLoadingDetails) {
    return (
      <div className={cn(
        'flex items-center justify-center h-full',
        isDark ? 'bg-slate-950' : 'bg-gray-50'
      )}>
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  // No program exists - show create option
  if (!program) {
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
          <Button
            variant="ghost"
            size="sm"
            className={cn('gap-2 text-muted-foreground hover:text-foreground', isRTL && 'flex-row-reverse')}
            onClick={handleBackClick}
          >
            {isRTL ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
            {t('common.back')}
          </Button>
        </div>

        {/* Create Program Card */}
        <div className="flex-1 flex items-center justify-center p-6">
          <Card className="max-w-lg w-full">
            <CardHeader className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
                <FileText className="w-8 h-8 text-primary" />
              </div>
              <CardTitle>{t('program.startNew')}</CardTitle>
              <CardDescription>
                {t('program.startNewDesc').replace('{name}', student?.name || '')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>{t('program.framework')}</Label>
                <Select
                  value={programForm.framework}
                  onValueChange={(value: ProgramFramework) => setProgramForm(prev => ({ ...prev, framework: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tala">{t('program.frameworkTala')}</SelectItem>
                    <SelectItem value="us_iep">{t('program.frameworkIep')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{t('program.year')}</Label>
                <Input
                  value={programForm.programYear}
                  onChange={(e) => setProgramForm(prev => ({ ...prev, programYear: e.target.value }))}
                  placeholder="2024-2025"
                />
              </div>

              <Button
                className="w-full gap-2"
                onClick={() => createProgramMutation.mutate(programForm)}
                disabled={createProgramMutation.isPending}
              >
                {createProgramMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                <PlayCircle className="w-4 h-4" />
                {t('program.createAndStart')}
              </Button>

              {allPrograms.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground text-center">{t('program.previousPrograms')}</p>
                    {allPrograms.slice(0, 3).map((p) => (
                          <div 
                          key={p.id}
                          className={cn(
                            'p-3 rounded-lg border flex items-center justify-between cursor-pointer hover:bg-accent/50 transition-colors',
                            isDark ? 'bg-slate-800/50 border-slate-700' : 'bg-gray-50 border-gray-200'
                          )}
                          onClick={() => {
                            queryClient.setQueryData(
                              ['/api/students', student?.id, 'programs', 'current'],
                              { program: p }
                            );
                          }}
                        >
                        <div>
                          <p className="font-medium">{p.programYear}</p>
                          <p className="text-xs text-muted-foreground">
                            {t(`program.framework${p.framework === 'tala' ? 'Tala' : 'Iep'}`)} • {t(`program.status.${p.status}`)}
                          </p>
                        </div>
                        <Badge className={STATUS_COLORS[p.status]}>{t(`program.status.${p.status}`)}</Badge>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // =============================================================================
  // MAIN PROGRAM VIEW
  // =============================================================================

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
        <div className={cn('flex justify-between items-start', isRTL && 'flex-row-reverse')}>
          <div className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={handleBackClick}
            >
              {isRTL ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
            </Button>
            <div className={isRTL ? 'text-right' : ''}>
              <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                <h1 className={cn('text-xl font-bold', isDark ? 'text-white' : 'text-slate-900')}>
                  {student?.name}
                </h1>
                <Badge className={STATUS_COLORS[program.status]}>
                  {t(`program.status.${program.status}`)}
                </Badge>
              </div>
              <p className={cn('text-sm', isDark ? 'text-slate-400' : 'text-slate-600')}>
                {t(`program.framework${program.framework === 'tala' ? 'Tala' : 'Iep'}`)} • {program.programYear}
              </p>
            </div>
          </div>

          <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
            {program.status === 'draft' && (
              <Button
                variant="default"
                size="sm"
                className="gap-2"
                onClick={() => activateProgramMutation.mutate()}
                disabled={activateProgramMutation.isPending}
              >
                {activateProgramMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Unlock className="w-4 h-4" />
                )}
                {t('program.activate')}
              </Button>
            )}
            {program.status === 'active' && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => archiveProgramMutation.mutate()}
                disabled={archiveProgramMutation.isPending}
              >
                {archiveProgramMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Archive className="w-4 h-4" />
                )}
                {t('program.archive')}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                <DropdownMenuItem className="gap-2">
                  <Download className="w-4 h-4" />
                  {t('program.exportPdf')}
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2">
                  <Share2 className="w-4 h-4" />
                  {t('program.share')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2">
                  <Settings className="w-4 h-4" />
                  {t('program.settings')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Tabs Navigation */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <div className={cn(
          'border-b px-4 shrink-0',
          isDark ? 'border-slate-800 bg-slate-900/50' : 'border-gray-200 bg-white'
        )}>
          <TabsList className={cn(
            'h-12 bg-transparent gap-1',
            isRTL && 'flex-row-reverse'
          )}>
            <TabsTrigger value="overview" className="gap-2 data-[state=active]:bg-primary/10">
              <BarChart3 className="w-4 h-4" />
              <span className="hidden sm:inline">{t('program.tabs.overview')}</span>
            </TabsTrigger>
            <TabsTrigger value="profile" className="gap-2 data-[state=active]:bg-primary/10">
              <BookOpen className="w-4 h-4" />
              <span className="hidden sm:inline">{t('program.tabs.profile')}</span>
            </TabsTrigger>
            <TabsTrigger value="goals" className="gap-2 data-[state=active]:bg-primary/10">
              <Target className="w-4 h-4" />
              <span className="hidden sm:inline">{t('program.tabs.goals')}</span>
            </TabsTrigger>
            <TabsTrigger value="services" className="gap-2 data-[state=active]:bg-primary/10">
              <Briefcase className="w-4 h-4" />
              <span className="hidden sm:inline">{t('program.tabs.services')}</span>
            </TabsTrigger>
            <TabsTrigger value="progress" className="gap-2 data-[state=active]:bg-primary/10">
              <TrendingUp className="w-4 h-4" />
              <span className="hidden sm:inline">{t('program.tabs.progress')}</span>
            </TabsTrigger>
            <TabsTrigger value="team" className="gap-2 data-[state=active]:bg-primary/10">
              <Users className="w-4 h-4" />
              <span className="hidden sm:inline">{t('program.tabs.team')}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <ScrollArea className="flex-1">
          {/* ============================================================= */}
          {/* OVERVIEW TAB */}
          {/* ============================================================= */}
          <TabsContent value="overview" className="p-4 space-y-6 mt-0">
            {/* Stats Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-4">
                  <div className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
                    <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                      <Target className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div className={isRTL ? 'text-right' : ''}>
                      <p className="text-2xl font-bold">{stats.activeGoals}</p>
                      <p className="text-xs text-muted-foreground">{t('program.stats.activeGoals')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <div className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
                    <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                      <Award className="w-5 h-5 text-green-600 dark:text-green-400" />
                    </div>
                    <div className={isRTL ? 'text-right' : ''}>
                      <p className="text-2xl font-bold">{stats.achievedGoals}/{stats.totalGoals}</p>
                      <p className="text-xs text-muted-foreground">{t('program.stats.goalsAchieved')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <div className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
                    <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                      <Clock className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                    </div>
                    <div className={isRTL ? 'text-right' : ''}>
                      <p className="text-2xl font-bold">{Math.round(stats.totalServiceMinutes)}</p>
                      <p className="text-xs text-muted-foreground">{t('program.stats.weeklyMinutes')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <div className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
                    <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                      <Users className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div className={isRTL ? 'text-right' : ''}>
                      <p className="text-2xl font-bold">{teamMembers.filter((m) => m.isActive).length}</p>
                      <p className="text-xs text-muted-foreground">{t('program.stats.teamMembers')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Progress Overview */}
            <Card>
              <CardHeader>
                <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                  <TrendingUp className="w-5 h-5" />
                  {t('program.overallProgress')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className={cn('flex justify-between text-sm', isRTL && 'flex-row-reverse')}>
                    <span>{t('program.goalCompletion')}</span>
                    <span className="font-medium">{stats.goalProgress}%</span>
                  </div>
                  <Progress value={stats.goalProgress} className="h-3" />
                </div>

                {/* Goals by Domain */}
                <div className="space-y-2 pt-4">
                  <p className="text-sm font-medium text-muted-foreground">{t('program.goalsByDomain')}</p>
                  {domains.map((domain) => {
                    const domainGoals = goals.filter((g) => g.profileDomainId === domain.id);
                    const achieved = domainGoals.filter((g) => g.status === 'achieved').length;
                    return (
                      <div key={domain.id} className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          {DOMAIN_ICONS[domain.domainType]}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={cn('flex justify-between text-sm', isRTL && 'flex-row-reverse')}>
                            <span className="truncate">{t(`program.domains.${domain.domainType}`)}</span>
                            <span className="text-muted-foreground">{achieved}/{domainGoals.length}</span>
                          </div>
                          <Progress 
                            value={domainGoals.length > 0 ? (achieved / domainGoals.length) * 100 : 0} 
                            className="h-1.5 mt-1" 
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Timeline / Deadlines */}
            {program.dueDate && (
              <Card>
                <CardHeader>
                  <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                    <Calendar className="w-5 h-5" />
                    {t('program.timeline')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className={cn('flex items-center gap-4', isRTL && 'flex-row-reverse')}>
                    <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">{t('program.dueDate')}:</span>
                      <span className="font-medium">{new Date(program.dueDate).toLocaleDateString()}</span>
                    </div>
                    {program.approvalDate && (
                      <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                        <span className="text-sm">{t('program.approvedDate')}:</span>
                        <span className="font-medium">{new Date(program.approvalDate).toLocaleDateString()}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ============================================================= */}
          {/* PROFILE TAB */}
          {/* ============================================================= */}
          <TabsContent value="profile" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center', isRTL && 'flex-row-reverse')}>
              <div>
                <h2 className="text-lg font-semibold">{t('program.functionalProfile')}</h2>
                <p className="text-sm text-muted-foreground">{t('program.functionalProfileDesc')}</p>
              </div>
            </div>

            {domains.map((domain) => (
              <Collapsible
                key={domain.id}
                open={expandedDomains.has(domain.id)}
                onOpenChange={() => toggleDomainExpanded(domain.id)}
              >
                <Card>
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                      <div className={cn('flex items-center justify-between', isRTL && 'flex-row-reverse')}>
                        <div className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
                          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                            {DOMAIN_ICONS[domain.domainType]}
                          </div>
                          <div className={isRTL ? 'text-right' : ''}>
                            <CardTitle className="text-base">{t(`program.domains.${domain.domainType}`)}</CardTitle>
                            <CardDescription>
                              {goals.filter((g) => g.profileDomainId === domain.id).length} {t('program.goalsLinked')}
                            </CardDescription>
                          </div>
                        </div>
                        <ChevronDown className={cn(
                          'w-5 h-5 text-muted-foreground transition-transform',
                          expandedDomains.has(domain.id) && 'rotate-180'
                        )} />
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="space-y-4 pt-0">
                      <Separator />
                      
                      <div className="grid gap-4">
                        {/* Impact Statement - schema field (NOT presentLevels) */}
                        <div className="space-y-2">
                          <Label>{t('program.impactStatement')}</Label>
                          <Textarea
                            value={domain.impactStatement || ''}
                            onChange={(e) => updateDomainMutation.mutate({
                              domainId: domain.id,
                              updates: { impactStatement: e.target.value }
                            })}
                            placeholder={t('program.impactStatementPlaceholder')}
                            className="min-h-[100px]"
                            disabled={program.status === 'archived'}
                          />
                        </div>

                        <div className="grid sm:grid-cols-2 gap-4">
                          {/* Strengths - schema field */}
                          <div className="space-y-2">
                            <Label>{t('program.strengths')}</Label>
                            <Textarea
                              value={domain.strengths || ''}
                              onChange={(e) => updateDomainMutation.mutate({
                                domainId: domain.id,
                                updates: { strengths: e.target.value }
                              })}
                              placeholder={t('program.strengthsPlaceholder')}
                              disabled={program.status === 'archived'}
                            />
                          </div>
                          {/* Needs - schema field */}
                          <div className="space-y-2">
                            <Label>{t('program.needs')}</Label>
                            <Textarea
                              value={domain.needs || ''}
                              onChange={(e) => updateDomainMutation.mutate({
                                domainId: domain.id,
                                updates: { needs: e.target.value }
                              })}
                              placeholder={t('program.needsPlaceholder')}
                              disabled={program.status === 'archived'}
                            />
                          </div>
                        </div>

                        {/* Adverse Effect Statement - IEP specific, schema field (NOT educationalImpact) */}
                        {program.framework === 'us_iep' && (
                          <div className="space-y-2">
                            <Label>{t('program.adverseEffectStatement')}</Label>
                            <Textarea
                              value={domain.adverseEffectStatement || ''}
                              onChange={(e) => updateDomainMutation.mutate({
                                domainId: domain.id,
                                updates: { adverseEffectStatement: e.target.value }
                              })}
                              placeholder={t('program.adverseEffectStatementPlaceholder')}
                              disabled={program.status === 'archived'}
                            />
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            ))}
          </TabsContent>

          {/* ============================================================= */}
          {/* GOALS TAB */}
          {/* ============================================================= */}
          <TabsContent value="goals" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center', isRTL && 'flex-row-reverse')}>
              <div>
                <h2 className="text-lg font-semibold">{t('program.goalsAndObjectives')}</h2>
                <p className="text-sm text-muted-foreground">{t('program.goalsAndObjectivesDesc')}</p>
              </div>
              {program.status !== 'archived' && (
                <Button 
                  className="gap-2"
                  onClick={() => {
                    resetGoalForm();
                    setShowGoalModal(true);
                  }}
                >
                  <Plus className="w-4 h-4" />
                  {t('goal.add')}
                </Button>
              )}
            </div>

            {goals.length === 0 ? (
              <Card>
                <CardContent className="py-12">
                  <div className="text-center">
                    <Target className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                    <p className="text-muted-foreground">{t('program.noGoals')}</p>
                    {program.status !== 'archived' && (
                      <Button 
                        variant="outline" 
                        className="mt-4 gap-2"
                        onClick={() => {
                          resetGoalForm();
                          setShowGoalModal(true);
                        }}
                      >
                        <Plus className="w-4 h-4" />
                        {t('goal.addFirst')}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ) : (
              goals.map((goal, index) => {
                const domain = domains.find((d) => d.id === goal.profileDomainId);
                return (
                  <Collapsible
                    key={goal.id}
                    open={expandedGoals.has(goal.id)}
                    onOpenChange={() => toggleGoalExpanded(goal.id)}
                  >
                    <Card className={cn(
                      goal.status === 'achieved' && 'border-green-200 dark:border-green-800'
                    )}>
                      <CollapsibleTrigger asChild>
                        <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                          <div className={cn('flex items-start justify-between gap-4', isRTL && 'flex-row-reverse')}>
                            <div className={cn('flex items-start gap-3', isRTL && 'flex-row-reverse')}>
                              <div className={cn(
                                'w-10 h-10 rounded-lg flex items-center justify-center font-bold text-sm shrink-0',
                                goal.status === 'achieved' 
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                  : 'bg-primary/10 text-primary'
                              )}>
                                {goal.status === 'achieved' ? <CheckCircle2 className="w-5 h-5" /> : index + 1}
                              </div>
                              <div className={isRTL ? 'text-right' : ''}>
                                {/* goalStatement is the main field in schema (NOT title) */}
                                <CardTitle className="text-base">{goal.goalStatement}</CardTitle>
                                <div className={cn('flex items-center gap-2 mt-1', isRTL && 'flex-row-reverse')}>
                                  {domain && (
                                    <Badge variant="outline" className="text-xs">
                                      {DOMAIN_ICONS[domain.domainType]}
                                      <span className="ml-1">{t(`program.domains.${domain.domainType}`)}</span>
                                    </Badge>
                                  )}
                                  <Badge className={STATUS_COLORS[goal.status]}>
                                    {t(`goal.status.${goal.status}`)}
                                  </Badge>
                                </div>
                              </div>
                            </div>
                            <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                              {program.status !== 'archived' && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingGoal(goal);
                                      setGoalForm({
                                        goalStatement: goal.goalStatement,
                                        profileDomainId: goal.profileDomainId || '',
                                        targetBehavior: goal.targetBehavior || '',
                                        criteria: goal.criteria || '',
                                        conditions: goal.conditions || '',
                                        targetDate: goal.targetDate || '',
                                      });
                                      setShowGoalModal(true);
                                    }}
                                  >
                                    <Edit className="w-4 h-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (confirm(t('goal.confirmDelete'))) {
                                        deleteGoalMutation.mutate(goal.id);
                                      }
                                    }}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </>
                              )}
                              <ChevronDown className={cn(
                                'w-5 h-5 text-muted-foreground transition-transform',
                                expandedGoals.has(goal.id) && 'rotate-180'
                              )} />
                            </div>
                          </div>
                        </CardHeader>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <CardContent className="pt-0 space-y-4">
                          <Separator />
                          
                          <div className="grid sm:grid-cols-2 gap-4">
                            {/* Schema fields: criteria, conditions */}
                            {goal.criteria && (
                              <div className="space-y-1">
                                <Label className="text-muted-foreground">{t('goal.criteria')}</Label>
                                <p className="text-sm">{goal.criteria}</p>
                              </div>
                            )}
                            {goal.conditions && (
                              <div className="space-y-1">
                                <Label className="text-muted-foreground">{t('goal.conditions')}</Label>
                                <p className="text-sm">{goal.conditions}</p>
                              </div>
                            )}
                          </div>

                          {/* progress is the schema field (0-100), NOT currentProgress */}
                          {goal.progress !== null && goal.progress > 0 && (
                            <div className="space-y-2">
                              <div className={cn('flex justify-between text-sm', isRTL && 'flex-row-reverse')}>
                                <span>{t('goal.currentProgress')}</span>
                                <span className="font-medium">{goal.progress}%</span>
                              </div>
                              <Progress value={goal.progress} className="h-2" />
                            </div>
                          )}

                          {/* =========== OBJECTIVES SECTION =========== */}
                          <div className="space-y-3">
                            <div className={cn('flex items-center justify-between', isRTL && 'flex-row-reverse')}>
                              <h4 className="text-sm font-medium flex items-center gap-2">
                                <Target className="w-4 h-4 text-muted-foreground" />
                                {t('objective.title')}
                                {goal.objectives && goal.objectives.length > 0 && (
                                  <Badge variant="secondary" className="text-xs">
                                    {goal.objectives.length}
                                  </Badge>
                                )}
                              </h4>
                              {program.status !== 'archived' && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 gap-1 text-xs"
                                  onClick={() => {
                                    resetObjectiveForm();
                                    setSelectedGoalForObjective(goal.id);
                                    setShowObjectiveModal(true);
                                  }}
                                >
                                  <Plus className="w-3 h-3" />
                                  {t('common.add')}
                                </Button>
                              )}
                            </div>
                            
                            {goal.objectives && goal.objectives.length > 0 ? (
                              <div className="space-y-2">
                                {goal.objectives.map((objective, idx) => (
                                  <div
                                    key={objective.id}
                                    className={cn(
                                      'p-3 rounded-lg border text-sm',
                                      isDark ? 'bg-slate-800/50 border-slate-700' : 'bg-gray-50 border-gray-200'
                                    )}
                                  >
                                    <div className={cn('flex items-start justify-between gap-2', isRTL && 'flex-row-reverse')}>
                                      <div className={cn('flex items-start gap-2', isRTL && 'flex-row-reverse')}>
                                        <span className={cn(
                                          'flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium mt-0.5',
                                          objective.status === 'achieved' 
                                            ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                                            : objective.status === 'in_progress'
                                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                                            : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                                        )}>
                                          {idx + 1}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                          <p className={isRTL ? 'text-right' : ''}>{objective.objectiveStatement}</p>
                                          {objective.criterion && (
                                            <p className={cn('text-xs text-muted-foreground mt-1', isRTL && 'text-right')}>
                                              {t('objective.criterion')}: {objective.criterion}
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                      <Badge className={cn('flex-shrink-0', STATUS_COLORS[objective.status])}>
                                        {t(`objective.status.${objective.status}`)}
                                      </Badge>
                                    </div>
                                    {objective.targetDate && (
                                      <p className={cn('text-xs text-muted-foreground mt-2 flex items-center gap-1', isRTL && 'flex-row-reverse justify-end')}>
                                        <Calendar className="w-3 h-3" />
                                        {t('objective.targetDate')}: {new Date(objective.targetDate).toLocaleDateString()}
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className={cn('text-sm text-muted-foreground italic', isRTL && 'text-right')}>
                                {t('objective.noObjectives')}
                              </p>
                            )}
                          </div>

                          <Separator />

                          {/* =========== DATA POINTS SECTION =========== */}
                          <div className="space-y-3">
                            <div className={cn('flex items-center justify-between', isRTL && 'flex-row-reverse')}>
                              <h4 className="text-sm font-medium flex items-center gap-2">
                                <Activity className="w-4 h-4 text-muted-foreground" />
                                {t('dataPoint.title')}
                                {goal.dataPoints && goal.dataPoints.length > 0 && (
                                  <Badge variant="secondary" className="text-xs">
                                    {goal.dataPoints.length}
                                  </Badge>
                                )}
                              </h4>
                              {program.status !== 'archived' && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 gap-1 text-xs"
                                  onClick={() => {
                                    resetDataPointForm();
                                    setSelectedGoalForDataPoint(goal.id);
                                    setShowDataPointModal(true);
                                  }}
                                >
                                  <Plus className="w-3 h-3" />
                                  {t('common.add')}
                                </Button>
                              )}
                            </div>

                            {goal.dataPoints && goal.dataPoints.length > 0 ? (
                              <div className="space-y-2">
                                {/* Show most recent 5 data points */}
                                {goal.dataPoints.slice(0, 5).map((dp) => (
                                  <div
                                    key={dp.id}
                                    className={cn(
                                      'p-3 rounded-lg border text-sm',
                                      isDark ? 'bg-slate-800/50 border-slate-700' : 'bg-gray-50 border-gray-200'
                                    )}
                                  >
                                    <div className={cn('flex items-center justify-between', isRTL && 'flex-row-reverse')}>
                                      <div className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
                                        {dp.numericValue !== null && dp.numericValue !== undefined && (
                                          <span className={cn(
                                            'text-lg font-semibold px-2 py-1 rounded',
                                            isDark ? 'bg-primary/20 text-primary' : 'bg-primary/10 text-primary'
                                          )}>
                                            {dp.numericValue}%
                                          </span>
                                        )}
                                        <div>
                                          {dp.value && (
                                            <p className={isRTL ? 'text-right' : ''}>{dp.value}</p>
                                          )}
                                          {dp.context && (
                                            <p className={cn('text-xs text-muted-foreground', isRTL && 'text-right')}>
                                              {dp.context}
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                      <div className={cn('text-xs text-muted-foreground flex items-center gap-1', isRTL && 'flex-row-reverse')}>
                                        <Clock className="w-3 h-3" />
                                        {new Date(dp.recordedAt).toLocaleDateString()}
                                      </div>
                                    </div>
                                    {dp.collectedBy && (
                                      <p className={cn('text-xs text-muted-foreground mt-1', isRTL && 'text-right')}>
                                        {t('dataPoint.collectedBy')}: {dp.collectedBy}
                                      </p>
                                    )}
                                  </div>
                                ))}
                                {goal.dataPoints.length > 5 && (
                                  <p className={cn('text-xs text-muted-foreground text-center py-1')}>
                                    {t('dataPoint.moreCount', { count: goal.dataPoints.length - 5 })}
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className={cn('text-sm text-muted-foreground italic', isRTL && 'text-right')}>
                                {t('dataPoint.noDataPoints')}
                              </p>
                            )}
                          </div>

                        </CardContent>
                      </CollapsibleContent>
                    </Card>
                  </Collapsible>
                );
              })
            )}
          </TabsContent>

          {/* ============================================================= */}
          {/* SERVICES TAB */}
          {/* ============================================================= */}
          <TabsContent value="services" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center', isRTL && 'flex-row-reverse')}>
              <div>
                <h2 className="text-lg font-semibold">{t('program.servicesAndAccommodations')}</h2>
                <p className="text-sm text-muted-foreground">{t('program.servicesAndAccommodationsDesc')}</p>
              </div>
              {program.status !== 'archived' && (
                <Button 
                  className="gap-2"
                  onClick={() => {
                    resetServiceForm();
                    setShowServiceModal(true);
                  }}
                >
                  <Plus className="w-4 h-4" />
                  {t('service.add')}
                </Button>
              )}
            </div>

            {services.length === 0 ? (
              <Card>
                <CardContent className="py-12">
                  <div className="text-center">
                    <Briefcase className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                    <p className="text-muted-foreground">{t('program.noServices')}</p>
                    {program.status !== 'archived' && (
                      <Button 
                        variant="outline" 
                        className="mt-4 gap-2"
                        onClick={() => {
                          resetServiceForm();
                          setShowServiceModal(true);
                        }}
                      >
                        <Plus className="w-4 h-4" />
                        {t('service.addFirst')}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {services.map((service) => (
                  <Card key={service.id} className={cn(!service.isActive && 'opacity-60')}>
                    <CardContent className="p-4">
                      <div className={cn('flex items-start justify-between gap-4', isRTL && 'flex-row-reverse')}>
                        <div className={cn('flex items-start gap-3', isRTL && 'flex-row-reverse')}>
                          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                            {SERVICE_ICONS[service.serviceType]}
                          </div>
                          <div className={isRTL ? 'text-right' : ''}>
                            {/* customServiceName is schema field for display name (NOT serviceName) */}
                            <h3 className="font-medium">{getServiceDisplayName(service)}</h3>
                            <p className="text-sm text-muted-foreground">
                              {t(`service.types.${service.serviceType}`)}
                            </p>
                            <div className={cn('flex items-center gap-3 mt-2 text-xs text-muted-foreground', isRTL && 'flex-row-reverse')}>
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {/* sessionDuration is schema field (NOT durationMinutes) */}
                                {service.sessionDuration} {t('common.minutes')}
                              </span>
                              <span>•</span>
                              <span>
                                {/* frequencyCount and frequencyPeriod are schema fields (NOT frequency) */}
                                {service.frequencyCount}x {t(`service.frequency.${service.frequencyPeriod}`)}
                              </span>
                              {service.setting && (
                                <>
                                  <span>•</span>
                                  <span className="flex items-center gap-1">
                                    <Building2 className="w-3 h-3" />
                                    {t(`service.settings.${service.setting}`)}
                                  </span>
                                </>
                              )}
                            </div>
                            {/* providerName is schema field (NOT provider) */}
                            {service.providerName && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {t('service.provider')}: {service.providerName}
                              </p>
                            )}
                          </div>
                        </div>
                        {program.status !== 'archived' && (
                          <div className={cn('flex items-center gap-1', isRTL && 'flex-row-reverse')}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => {
                                setEditingService(service);
                                setServiceForm({
                                  serviceType: service.serviceType,
                                  customServiceName: service.customServiceName || '',
                                  description: service.description || '',
                                  frequencyCount: service.frequencyCount,
                                  frequencyPeriod: service.frequencyPeriod,
                                  sessionDuration: service.sessionDuration,
                                  setting: service.setting || 'therapy_room',
                                  deliveryModel: service.deliveryModel || 'direct',
                                  providerName: service.providerName || '',
                                });
                                setShowServiceModal(true);
                              }}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => {
                                if (confirm(t('service.confirmDelete'))) {
                                  deleteServiceMutation.mutate(service.id);
                                }
                              }}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Accommodations Section */}
            {accommodations.length > 0 && (
              <>
                <Separator className="my-6" />
                <div>
                  <h3 className="text-base font-semibold mb-4">{t('program.accommodations')}</h3>
                  <div className="grid gap-3">
                    {accommodations.map((acc) => (
                      <Card key={acc.id}>
                        <CardContent className="p-3">
                          <div className={cn('flex items-start gap-3', isRTL && 'flex-row-reverse')}>
                            <Badge variant="outline">{t(`accommodation.types.${acc.accommodationType}`)}</Badge>
                            <p className="text-sm flex-1">{acc.description}</p>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              </>
            )}
          </TabsContent>

          {/* ============================================================= */}
          {/* PROGRESS TAB */}
          {/* ============================================================= */}
          <TabsContent value="progress" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center', isRTL && 'flex-row-reverse')}>
              <div>
                <h2 className="text-lg font-semibold">{t('program.progressMonitoring')}</h2>
                <p className="text-sm text-muted-foreground">{t('program.progressMonitoringDesc')}</p>
              </div>
            </div>

            {/* Quick Data Entry */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('progress.quickDataEntry')}</CardTitle>
              </CardHeader>
              <CardContent>
                {goals.filter((g) => g.status === 'active').length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('progress.noActiveGoals')}</p>
                ) : (
                  <div className="space-y-2">
                    {goals.filter((g) => g.status === 'active').map((goal) => (
                      <div 
                        key={goal.id}
                        className={cn(
                          'flex items-center justify-between p-3 rounded-lg border',
                          isDark ? 'bg-slate-800/50 border-slate-700' : 'bg-gray-50 border-gray-200'
                        )}
                      >
                        <span className="text-sm font-medium truncate flex-1">{goal.goalStatement}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-2 shrink-0"
                          onClick={() => {
                            resetDataPointForm();
                            setSelectedGoalForDataPoint(goal.id);
                            setShowDataPointModal(true);
                          }}
                        >
                          <Plus className="w-3 h-3" />
                          {t('dataPoint.add')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Progress Reports */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('progress.reports')}</CardTitle>
              </CardHeader>
              <CardContent>
                {progressReports.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('progress.noReports')}</p>
                ) : (
                  <div className="space-y-2">
                    {progressReports.map((report) => (
                      <div 
                        key={report.id}
                        className={cn(
                          'flex items-center justify-between p-3 rounded-lg border',
                          isDark ? 'bg-slate-800/50 border-slate-700' : 'bg-gray-50 border-gray-200'
                        )}
                      >
                        <div>
                          <span className="text-sm font-medium">
                            {new Date(report.reportDate).toLocaleDateString()}
                          </span>
                          {report.reportingPeriod && (
                            <span className="text-xs text-muted-foreground ml-2">
                              ({report.reportingPeriod})
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {report.sharedWithParents && (
                            <Badge variant="outline" className="text-xs">
                              <Share2 className="w-3 h-3 mr-1" />
                              {t('progress.shared')}
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ============================================================= */}
          {/* TEAM TAB */}
          {/* ============================================================= */}
          <TabsContent value="team" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center', isRTL && 'flex-row-reverse')}>
              <div>
                <h2 className="text-lg font-semibold">{t('program.teamAndCompliance')}</h2>
                <p className="text-sm text-muted-foreground">{t('program.teamAndComplianceDesc')}</p>
              </div>
              {program.status !== 'archived' && (
                <Button 
                  className="gap-2"
                  onClick={() => {
                    resetTeamMemberForm();
                    setShowTeamMemberModal(true);
                  }}
                >
                  <UserPlus className="w-4 h-4" />
                  {t('team.addMember')}
                </Button>
              )}
            </div>

            {/* Team Members */}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {teamMembers.map((member) => (
                <Card key={member.id} className={cn(!member.isActive && 'opacity-60')}>
                  <CardContent className="p-4">
                    <div className={cn('flex items-start justify-between', isRTL && 'flex-row-reverse')}>
                      <div className={isRTL ? 'text-right' : ''}>
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium">{member.name}</h3>
                          {member.isCoordinator && (
                            <Badge variant="secondary" className="text-xs">{t('team.coordinator')}</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {t(`team.roles.${member.role}`)}
                        </p>
                        {/* contactEmail and contactPhone are schema fields (NOT email/phone) */}
                        {member.contactEmail && (
                          <p className="text-xs text-muted-foreground mt-1">{member.contactEmail}</p>
                        )}
                        {member.contactPhone && (
                          <p className="text-xs text-muted-foreground">{member.contactPhone}</p>
                        )}
                      </div>
                      {program.status !== 'archived' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
                          onClick={() => {
                            if (confirm(t('team.confirmRemove'))) {
                              deleteTeamMemberMutation.mutate(member.id);
                            }
                          }}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Meetings Section */}
            {meetings.length > 0 && (
              <>
                <Separator className="my-6" />
                <div>
                  <h3 className="text-base font-semibold mb-4">{t('program.meetings')}</h3>
                  <div className="space-y-2">
                    {meetings.map((meeting) => (
                      <Card key={meeting.id}>
                        <CardContent className="p-3">
                          <div className={cn('flex items-center justify-between', isRTL && 'flex-row-reverse')}>
                            <div className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
                              <Calendar className="w-4 h-4 text-muted-foreground" />
                              <div>
                                <p className="text-sm font-medium">
                                  {t(`meeting.types.${meeting.meetingType}`)}
                                </p>
                                {/* scheduledDate is schema field (NOT meetingDate) */}
                                {meeting.scheduledDate && (
                                  <p className="text-xs text-muted-foreground">
                                    {new Date(meeting.scheduledDate).toLocaleDateString()}
                                    {meeting.location && ` • ${meeting.location}`}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Consent Forms Section */}
            {consentForms.length > 0 && (
              <>
                <Separator className="my-6" />
                <div>
                  <h3 className="text-base font-semibold mb-4">{t('program.consentForms')}</h3>
                  <div className="space-y-2">
                    {consentForms.map((consent) => (
                      <Card key={consent.id}>
                        <CardContent className="p-3">
                          <div className={cn('flex items-center justify-between', isRTL && 'flex-row-reverse')}>
                            <div className={cn('flex items-center gap-3', isRTL && 'flex-row-reverse')}>
                              <FileSignature className="w-4 h-4 text-muted-foreground" />
                              <div>
                                <p className="text-sm font-medium">
                                  {t(`consent.types.${consent.consentType}`)}
                                </p>
                                {/* consentGiven is schema field (NOT isSigned) */}
                                {consent.responseDate && (
                                  <p className="text-xs text-muted-foreground">
                                    {consent.consentGiven ? t('consent.signed') : t('consent.pending')}
                                    {consent.signedBy && ` • ${consent.signedBy}`}
                                  </p>
                                )}
                              </div>
                            </div>
                            <Badge variant={consent.consentGiven ? 'default' : 'outline'}>
                              {consent.consentGiven ? (
                                <CheckCircle2 className="w-3 h-3 mr-1" />
                              ) : (
                                <Circle className="w-3 h-3 mr-1" />
                              )}
                              {consent.consentGiven ? t('consent.signed') : t('consent.pending')}
                            </Badge>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              </>
            )}
          </TabsContent>
        </ScrollArea>
      </Tabs>

      {/* ============================================================= */}
      {/* MODALS */}
      {/* ============================================================= */}

      {/* Goal Modal */}
      <Dialog open={showGoalModal} onOpenChange={setShowGoalModal}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingGoal ? t('goal.edit') : t('goal.add')}</DialogTitle>
            <DialogDescription>{t('goal.modalDescription')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* goalStatement - main goal text (schema field, NOT title/description) */}
            <div className="space-y-2">
              <Label>{t('goal.goalStatement')} *</Label>
              <Textarea
                value={goalForm.goalStatement}
                onChange={(e) => setGoalForm(prev => ({ ...prev, goalStatement: e.target.value }))}
                placeholder={t('goal.goalStatementPlaceholder')}
                className="min-h-[80px]"
              />
            </div>

            <div className="space-y-2">
              <Label>{t('goal.domain')}</Label>
              <Select
                value={goalForm.profileDomainId}
                onValueChange={(value) => setGoalForm(prev => ({ ...prev, profileDomainId: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('goal.selectDomain')} />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((domain) => (
                    <SelectItem key={domain.id} value={domain.id}>
                      {t(`program.domains.${domain.domainType}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              {/* criteria - schema field */}
              <div className="space-y-2">
                <Label>{t('goal.criteria')}</Label>
                <Input
                  value={goalForm.criteria}
                  onChange={(e) => setGoalForm(prev => ({ ...prev, criteria: e.target.value }))}
                  placeholder={t('goal.criteriaPlaceholder')}
                />
              </div>
              {/* conditions - schema field */}
              <div className="space-y-2">
                <Label>{t('goal.conditions')}</Label>
                <Input
                  value={goalForm.conditions}
                  onChange={(e) => setGoalForm(prev => ({ ...prev, conditions: e.target.value }))}
                  placeholder={t('goal.conditionsPlaceholder')}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t('goal.targetDate')}</Label>
              <Input
                type="date"
                value={goalForm.targetDate}
                onChange={(e) => setGoalForm(prev => ({ ...prev, targetDate: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGoalModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!goalForm.goalStatement.trim()) {
                  toast({ title: t('common.error'), description: t('goal.statementRequired'), variant: 'destructive' });
                  return;
                }
                const goalData: InsertGoal = {
                  programId: program.id,
                  goalStatement: goalForm.goalStatement,
                  profileDomainId: goalForm.profileDomainId || undefined,
                  criteria: goalForm.criteria || undefined,
                  conditions: goalForm.conditions || undefined,
                  targetDate: goalForm.targetDate || undefined,
                };
                if (editingGoal) {
                  updateGoalMutation.mutate({ goalId: editingGoal.id, updates: goalData });
                } else {
                  createGoalMutation.mutate(goalData);
                }
              }}
              disabled={createGoalMutation.isPending || updateGoalMutation.isPending}
            >
              {(createGoalMutation.isPending || updateGoalMutation.isPending) && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              {editingGoal ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Objective Modal */}
      <Dialog open={showObjectiveModal} onOpenChange={setShowObjectiveModal}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle>{t('objective.add')}</DialogTitle>
            <DialogDescription>{t('objective.modalDescription')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* objectiveStatement - schema field (NOT description) */}
            <div className="space-y-2">
              <Label>{t('objective.statement')} *</Label>
              <Textarea
                value={objectiveForm.objectiveStatement}
                onChange={(e) => setObjectiveForm(prev => ({ ...prev, objectiveStatement: e.target.value }))}
                placeholder={t('objective.statementPlaceholder')}
              />
            </div>

            {/* criterion - schema field (NOT criteria) */}
            <div className="space-y-2">
              <Label>{t('objective.criterion')}</Label>
              <Input
                value={objectiveForm.criterion}
                onChange={(e) => setObjectiveForm(prev => ({ ...prev, criterion: e.target.value }))}
                placeholder={t('objective.criterionPlaceholder')}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('objective.targetDate')}</Label>
              <Input
                type="date"
                value={objectiveForm.targetDate}
                onChange={(e) => setObjectiveForm(prev => ({ ...prev, targetDate: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowObjectiveModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!objectiveForm.objectiveStatement.trim()) {
                  toast({ title: t('common.error'), description: t('objective.statementRequired'), variant: 'destructive' });
                  return;
                }
                if (selectedGoalForObjective) {
                  createObjectiveMutation.mutate({
                    goalId: selectedGoalForObjective,
                    data: {
                      goalId: selectedGoalForObjective,
                      objectiveStatement: objectiveForm.objectiveStatement,
                      criterion: objectiveForm.criterion || undefined,
                      context: objectiveForm.context || undefined,
                      targetDate: objectiveForm.targetDate || undefined,
                    },
                  });
                }
              }}
              disabled={createObjectiveMutation.isPending}
            >
              {createObjectiveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Service Modal */}
      <Dialog open={showServiceModal} onOpenChange={setShowServiceModal}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingService ? t('service.edit') : t('service.add')}</DialogTitle>
            <DialogDescription>{t('service.modalDescription')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('service.type')}</Label>
                <Select
                  value={serviceForm.serviceType}
                  onValueChange={(value: ServiceType) => setServiceForm(prev => ({ ...prev, serviceType: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="speech_language_therapy">{t('service.types.speech_language_therapy')}</SelectItem>
                    <SelectItem value="occupational_therapy">{t('service.types.occupational_therapy')}</SelectItem>
                    <SelectItem value="physical_therapy">{t('service.types.physical_therapy')}</SelectItem>
                    <SelectItem value="counseling">{t('service.types.counseling')}</SelectItem>
                    <SelectItem value="specialized_instruction">{t('service.types.specialized_instruction')}</SelectItem>
                    <SelectItem value="consultation">{t('service.types.consultation')}</SelectItem>
                    <SelectItem value="aac_support">{t('service.types.aac_support')}</SelectItem>
                    <SelectItem value="other">{t('service.types.other')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* customServiceName - schema field (NOT serviceName) */}
              <div className="space-y-2">
                <Label>{t('service.name')} *</Label>
                <Input
                  value={serviceForm.customServiceName}
                  onChange={(e) => setServiceForm(prev => ({ ...prev, customServiceName: e.target.value }))}
                  placeholder={t('service.namePlaceholder')}
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-4">
              {/* frequencyCount - schema field (NOT frequency) */}
              <div className="space-y-2">
                <Label>{t('service.frequency')}</Label>
                <Input
                  type="number"
                  min={1}
                  value={serviceForm.frequencyCount}
                  onChange={(e) => setServiceForm(prev => ({ ...prev, frequencyCount: parseInt(e.target.value) || 1 }))}
                />
              </div>

              {/* frequencyPeriod - schema field */}
              <div className="space-y-2">
                <Label>{t('service.period')}</Label>
                <Select
                  value={serviceForm.frequencyPeriod}
                  onValueChange={(value: ServiceFrequencyPeriod) => setServiceForm(prev => ({ ...prev, frequencyPeriod: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">{t('service.frequency.daily')}</SelectItem>
                    <SelectItem value="weekly">{t('service.frequency.weekly')}</SelectItem>
                    <SelectItem value="monthly">{t('service.frequency.monthly')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* sessionDuration - schema field (NOT durationMinutes) */}
              <div className="space-y-2">
                <Label>{t('service.duration')}</Label>
                <Input
                  type="number"
                  min={5}
                  step={5}
                  value={serviceForm.sessionDuration}
                  onChange={(e) => setServiceForm(prev => ({ ...prev, sessionDuration: parseInt(e.target.value) || 30 }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t('service.setting')}</Label>
              <Select
                value={serviceForm.setting}
                onValueChange={(value: ServiceSetting) => setServiceForm(prev => ({ ...prev, setting: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general_education">{t('service.settings.general_education')}</SelectItem>
                  <SelectItem value="resource_room">{t('service.settings.resource_room')}</SelectItem>
                  <SelectItem value="self_contained">{t('service.settings.self_contained')}</SelectItem>
                  <SelectItem value="therapy_room">{t('service.settings.therapy_room')}</SelectItem>
                  <SelectItem value="home">{t('service.settings.home')}</SelectItem>
                  <SelectItem value="community">{t('service.settings.community')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* providerName - schema field (NOT provider) */}
            <div className="space-y-2">
              <Label>{t('service.provider')}</Label>
              <Input
                value={serviceForm.providerName}
                onChange={(e) => setServiceForm(prev => ({ ...prev, providerName: e.target.value }))}
                placeholder={t('service.providerPlaceholder')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowServiceModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!serviceForm.customServiceName.trim()) {
                  toast({ title: t('common.error'), description: t('service.nameRequired'), variant: 'destructive' });
                  return;
                }
                const serviceData: InsertService = {
                  programId: program.id,
                  serviceType: serviceForm.serviceType,
                  customServiceName: serviceForm.customServiceName,
                  description: serviceForm.description || undefined,
                  frequencyCount: serviceForm.frequencyCount,
                  frequencyPeriod: serviceForm.frequencyPeriod,
                  sessionDuration: serviceForm.sessionDuration,
                  setting: serviceForm.setting,
                  deliveryModel: serviceForm.deliveryModel,
                  providerName: serviceForm.providerName || undefined,
                };
                if (editingService) {
                  updateServiceMutation.mutate({ serviceId: editingService.id, updates: { ...serviceData, isActive: true } });
                } else {
                  createServiceMutation.mutate(serviceData);
                }
              }}
              disabled={createServiceMutation.isPending || updateServiceMutation.isPending}
            >
              {(createServiceMutation.isPending || updateServiceMutation.isPending) && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              {editingService ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Data Point Modal */}
      <Dialog open={showDataPointModal} onOpenChange={setShowDataPointModal}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('dataPoint.record')}</DialogTitle>
            <DialogDescription>{t('dataPoint.modalDescription')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label>{t('dataPoint.numericValue')}</Label>
              <Input
                type="number"
                value={dataPointForm.numericValue}
                onChange={(e) => setDataPointForm(prev => ({ ...prev, numericValue: e.target.value }))}
                placeholder={t('dataPoint.numericPlaceholder')}
              />
            </div>

            {/* value - schema field (NOT textValue) */}
            <div className="space-y-2">
              <Label>{t('dataPoint.value')}</Label>
              <Input
                value={dataPointForm.value}
                onChange={(e) => setDataPointForm(prev => ({ ...prev, value: e.target.value }))}
                placeholder={t('dataPoint.valuePlaceholder')}
              />
            </div>

            {/* context - schema field (NOT sessionNotes) */}
            <div className="space-y-2">
              <Label>{t('dataPoint.context')}</Label>
              <Textarea
                value={dataPointForm.context}
                onChange={(e) => setDataPointForm(prev => ({ ...prev, context: e.target.value }))}
                placeholder={t('dataPoint.contextPlaceholder')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDataPointModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!dataPointForm.numericValue && !dataPointForm.value) {
                  toast({ title: t('common.error'), description: t('dataPoint.valueRequired'), variant: 'destructive' });
                  return;
                }
                if (selectedGoalForDataPoint) {
                  createDataPointMutation.mutate({
                    goalId: selectedGoalForDataPoint,
                    data: {
                      numericValue: dataPointForm.numericValue ? parseFloat(dataPointForm.numericValue) : undefined,
                      value: dataPointForm.value || '',
                      context: dataPointForm.context || undefined,
                      recordedAt: new Date(),
                    }
                  });
                }
              }}
              disabled={createDataPointMutation.isPending}
            >
              {createDataPointMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Team Member Modal */}
      <Dialog open={showTeamMemberModal} onOpenChange={setShowTeamMemberModal}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle>{t('team.addMember')}</DialogTitle>
            <DialogDescription>{t('team.addMemberDescription')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label>{t('team.name')} *</Label>
              <Input
                value={teamMemberForm.name}
                onChange={(e) => setTeamMemberForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder={t('team.namePlaceholder')}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('team.role')} *</Label>
              <Select
                value={teamMemberForm.role}
                onValueChange={(value: TeamMemberRole) => setTeamMemberForm(prev => ({ ...prev, role: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="parent_guardian">{t('team.roles.parent_guardian')}</SelectItem>
                  <SelectItem value="student">{t('team.roles.student')}</SelectItem>
                  <SelectItem value="homeroom_teacher">{t('team.roles.homeroom_teacher')}</SelectItem>
                  <SelectItem value="special_education_teacher">{t('team.roles.special_education_teacher')}</SelectItem>
                  <SelectItem value="general_education_teacher">{t('team.roles.general_education_teacher')}</SelectItem>
                  <SelectItem value="speech_language_pathologist">{t('team.roles.speech_language_pathologist')}</SelectItem>
                  <SelectItem value="occupational_therapist">{t('team.roles.occupational_therapist')}</SelectItem>
                  <SelectItem value="physical_therapist">{t('team.roles.physical_therapist')}</SelectItem>
                  <SelectItem value="psychologist">{t('team.roles.psychologist')}</SelectItem>
                  <SelectItem value="administrator">{t('team.roles.administrator')}</SelectItem>
                  <SelectItem value="case_manager">{t('team.roles.case_manager')}</SelectItem>
                  <SelectItem value="external_provider">{t('team.roles.external_provider')}</SelectItem>
                  <SelectItem value="other">{t('team.roles.other')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* contactEmail - schema field (NOT email) */}
            <div className="space-y-2">
              <Label>{t('team.email')}</Label>
              <Input
                type="email"
                value={teamMemberForm.contactEmail}
                onChange={(e) => setTeamMemberForm(prev => ({ ...prev, contactEmail: e.target.value }))}
                placeholder={t('team.emailPlaceholder')}
              />
            </div>

            {/* contactPhone - schema field (NOT phone) */}
            <div className="space-y-2">
              <Label>{t('team.phone')}</Label>
              <Input
                value={teamMemberForm.contactPhone}
                onChange={(e) => setTeamMemberForm(prev => ({ ...prev, contactPhone: e.target.value }))}
                placeholder={t('team.phonePlaceholder')}
              />
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="isCoordinator"
                checked={teamMemberForm.isCoordinator}
                onCheckedChange={(checked) => setTeamMemberForm(prev => ({ ...prev, isCoordinator: !!checked }))}
              />
              <Label htmlFor="isCoordinator" className="text-sm font-normal">
                {t('team.isCoordinator')}
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTeamMemberModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!teamMemberForm.name.trim()) {
                  toast({ title: t('common.error'), description: t('team.nameRequired'), variant: 'destructive' });
                  return;
                }
                const memberData: InsertTeamMember = {
                  programId: program.id,
                  name: teamMemberForm.name,
                  role: teamMemberForm.role,
                  customRole: teamMemberForm.customRole || undefined,
                  contactEmail: teamMemberForm.contactEmail || undefined,
                  contactPhone: teamMemberForm.contactPhone || undefined,
                  isCoordinator: teamMemberForm.isCoordinator,
                };
                createTeamMemberMutation.mutate(memberData);
              }}
              disabled={createTeamMemberMutation.isPending}
            >
              {createTeamMemberMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t('team.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}