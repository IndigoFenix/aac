// src/features/StudentProgressPanel.tsx
// Comprehensive IEP/TALA Program Management Panel
// Uses types derived from schema.ts as single source of truth

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useStudent } from '@/hooks/useStudent';
import { useChat } from '@/hooks/useChat';
import { useFeaturePanel, useSharedState } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { apiRequest, apiUrl } from '@/lib/queryClient';
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
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
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
  User,
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
  ProgramContact,
  StudentContact,
  InsertProgramContact,
  Meeting,
  ConsentForm,
  ProgressReport,
  DataPoint,
  InsertGoal,
  InsertObjective,
  InsertService,
  InsertDataPoint,
  ProgramFramework,
  ProgramStatus,
  ProfileDomainType,
  GoalStatus,
  ObjectiveStatus,
  ServiceType,
  ServiceSetting,
  ServiceDeliveryModel,
  ProgressStatus,
  TeamMemberRole,
  GasLevel,
  GasVaryingVariable,
  GasLevels,
  EnvironmentalFactors,
  EnvironmentalFactorCategory,
  PersonalFactors,
} from '@shared/schema';

// support_relationships and attitudes are no longer ICF categories here — those
// live on studentContacts rows (person-scoped), managed in the contacts panel.
const ENV_FACTOR_CATEGORIES: EnvironmentalFactorCategory[] = [
  'products_technology',
  'natural_environment',
  'services_systems_policies',
];

// Ordered list of the 5 GAS levels (for iteration in the UI)
const GAS_LEVEL_ORDER: GasLevel[] = [
  'much_less_than_expected',
  'less_than_expected',
  'expected',
  'better_than_expected',
  'much_better_than_expected',
];
const GAS_LEVEL_ORDINALS: Record<GasLevel, number> = {
  much_less_than_expected: -2,
  less_than_expected: -1,
  expected: 0,
  better_than_expected: 1,
  much_better_than_expected: 2,
};

// Composite type for full program details (not in schema, defined locally)
interface ProgramWithDetails {
  program: Program;
  profileDomains: ProfileDomain[];
  goals: Goal[];
  services: Service[];
  accommodations: Accommodation[];
  teamContacts: (ProgramContact & { contact: StudentContact })[];
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
  targetBehavior: string;
  criteria: string;
  methods: string;
  targetDate: string;
  // GAS (Goal Attainment Scaling)
  useGas: boolean;
  gasVaryingVariable: GasVaryingVariable | '';
  gasBaselineLevel: GasLevel | '';
  gasLevels: GasLevels;
  // Family-Centered Service
  clientImportanceRating: string; // stored as string for <Input type=number>
  setJointlyWithFamily: boolean;
  familyInput: string;
}

interface ObjectiveFormState {
  objectiveStatement: string;
  profileDomainId: string;
  criteria: string;
  methods: string;
  targetDate: string;
  /** Which level on the parent GAS goal's scale this objective targets. Only used when parent.useGas. */
  gasTargetLevel: GasLevel | '';
}

interface ServiceFormState {
  serviceType: ServiceType;
  customServiceName: string;
  description: string;
  setting: ServiceSetting;
  deliveryModel: ServiceDeliveryModel;
  providerName: string;
}

interface DataPointFormState {
  numericValue: string;
  unit: string;
  value: string;
  context: string;
  achievedLevel: GasLevel | '';
  collectedBy: string;
  /** ISO-local datetime string for the <input type="datetime-local">. Empty = now */
  recordedAt: string;
}

interface TeamContactFormState {
  contactId: string;           // the studentContacts row to add
  programRole: TeamMemberRole | '';  // optional per-program override
  isCoordinator: boolean;
  responsibilities: string;    // newline-separated
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format a Date as the value expected by <input type="datetime-local">:
 * YYYY-MM-DDTHH:mm in the user's local timezone.
 */
function toLocalDateTimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Get display name for a service
 */
function getServiceDisplayName(service: Service): string {
  return service.customServiceName || service.serviceType.replace(/_/g, ' ');
}


/**
 * Get unique domains for a goal by looking at its objectives
 * Since domains are now associated with objectives, not goals directly
 */
function getDomainsForGoal(goal: GoalWithNested, domains: ProfileDomain[]): ProfileDomain[] {
  if (!goal.objectives || goal.objectives.length === 0) return [];
  
  const domainIds = new Set<string>();
  goal.objectives.forEach(obj => {
    if (obj.profileDomainId) {
      domainIds.add(obj.profileDomainId);
    }
  });
  
  return domains.filter(d => domainIds.has(d.id));
}

/**
 * Get goals that have objectives in a specific domain
 */
function getGoalsByDomain(goals: GoalWithNested[], domainId: string): GoalWithNested[] {
  return goals.filter(goal => {
    if (!goal.objectives) return false;
    return goal.objectives.some(obj => obj.profileDomainId === domainId);
  });
}

// =============================================================================
// GAS T-SCORE
// =============================================================================

/**
 * Classical Kiresuk & Sherman GAS T-score.
 *   T = 50 + 10 · Σ(wᵢ·xᵢ) / √((1-ρ)·Σwᵢ² + ρ·(Σwᵢ)²)
 * ρ = 0.3 is the conventional goal intercorrelation.
 * A T-score of 50 means goals were achieved exactly as expected (level 0);
 * >50 means overall progress exceeded expectations, <50 fell short.
 */
function computeGasTScore(entries: Array<{ ordinal: number; weight: number }>): number | null {
  if (entries.length === 0) return null;
  const RHO = 0.3;
  let sumWX = 0, sumW = 0, sumWsq = 0;
  for (const { ordinal, weight } of entries) {
    const w = weight > 0 ? weight : 1;
    sumWX += w * ordinal;
    sumW += w;
    sumWsq += w * w;
  }
  const denom = Math.sqrt((1 - RHO) * sumWsq + RHO * sumW * sumW);
  if (denom === 0) return null;
  return 50 + (10 * sumWX) / denom;
}

/** Latest data point with an achievedLevel for a GAS goal */
function latestAchievedOrdinal(goal: GoalWithNested): number | null {
  if (!goal.useGas || !goal.dataPoints || goal.dataPoints.length === 0) return null;
  const ordered = [...goal.dataPoints].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
  );
  const GAS_ORDINALS: Record<string, number> = {
    much_less_than_expected: -2,
    less_than_expected: -1,
    expected: 0,
    better_than_expected: 1,
    much_better_than_expected: 2,
  };
  for (const dp of ordered) {
    if (dp.achievedLevel && GAS_ORDINALS[dp.achievedLevel] !== undefined) {
      return GAS_ORDINALS[dp.achievedLevel];
    }
  }
  return null;
}

// =============================================================================
// ICF Contextual Factors editor
// =============================================================================

type IcfSectionProps = {
  personalFactors: PersonalFactors;
  environmentalFactors: EnvironmentalFactors;
  disabled: boolean;
  onSave: (updates: { personalFactors?: PersonalFactors; environmentalFactors?: EnvironmentalFactors }) => void;
  t: (key: string, opts?: any) => string;
};

function IcfContextualFactorsSection({ personalFactors, environmentalFactors, disabled, onSave, t }: IcfSectionProps) {
  // Editable buffers so every keystroke doesn't hit the API.
  const [pfBuf, setPfBuf] = useState<PersonalFactors>(personalFactors);
  const [efBuf, setEfBuf] = useState<EnvironmentalFactors>(environmentalFactors);
  const [openPf, setOpenPf] = useState(false);
  const [openEf, setOpenEf] = useState(false);

  // Keep local buffers in sync when the upstream record changes (e.g. AI edits)
  useEffect(() => { setPfBuf(personalFactors); }, [personalFactors]);
  useEffect(() => { setEfBuf(environmentalFactors); }, [environmentalFactors]);

  const saveList = (cat: EnvironmentalFactorCategory, field: 'facilitators' | 'barriers', text: string) => {
    const list = text.split('\n').map(s => s.trim()).filter(Boolean);
    const next: EnvironmentalFactors = {
      ...efBuf,
      [cat]: { ...(efBuf[cat] || {}), [field]: list },
    };
    setEfBuf(next);
    onSave({ environmentalFactors: next });
  };
  const saveNotes = (cat: EnvironmentalFactorCategory, text: string) => {
    const next: EnvironmentalFactors = {
      ...efBuf,
      [cat]: { ...(efBuf[cat] || {}), notes: text || undefined },
    };
    setEfBuf(next);
    onSave({ environmentalFactors: next });
  };

  return (
    <div className="space-y-4">
      {/* Personal Factors */}
      <Collapsible open={openPf} onOpenChange={setOpenPf}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Heart className="w-4 h-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{t('program.personalFactors')}</CardTitle>
                    <CardDescription>{t('program.personalFactorsDesc')}</CardDescription>
                  </div>
                </div>
                <ChevronDown className={cn('w-5 h-5 text-muted-foreground transition-transform', openPf && 'rotate-180')} />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-4 pt-0">
              <Separator />
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('program.personal.interests')}</Label>
                  <Textarea
                    value={(pfBuf.interests || []).join('\n')}
                    onChange={(e) => setPfBuf(prev => ({ ...prev, interests: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }))}
                    onBlur={() => onSave({ personalFactors: pfBuf })}
                    placeholder={t('program.personal.interestsPlaceholder')}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('program.personal.motivators')}</Label>
                  <Textarea
                    value={(pfBuf.motivators || []).join('\n')}
                    onChange={(e) => setPfBuf(prev => ({ ...prev, motivators: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }))}
                    onBlur={() => onSave({ personalFactors: pfBuf })}
                    placeholder={t('program.personal.motivatorsPlaceholder')}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('program.personal.temperament')}</Label>
                  <Textarea
                    value={pfBuf.temperament || ''}
                    onChange={(e) => setPfBuf(prev => ({ ...prev, temperament: e.target.value }))}
                    onBlur={() => onSave({ personalFactors: pfBuf })}
                    placeholder={t('program.personal.temperamentPlaceholder')}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('program.personal.coping')}</Label>
                  <Textarea
                    value={pfBuf.coping || ''}
                    onChange={(e) => setPfBuf(prev => ({ ...prev, coping: e.target.value }))}
                    onBlur={() => onSave({ personalFactors: pfBuf })}
                    placeholder={t('program.personal.copingPlaceholder')}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>{t('program.personal.culturalBackground')}</Label>
                  <Textarea
                    value={pfBuf.culturalBackground || ''}
                    onChange={(e) => setPfBuf(prev => ({ ...prev, culturalBackground: e.target.value }))}
                    onBlur={() => onSave({ personalFactors: pfBuf })}
                    placeholder={t('program.personal.culturalBackgroundPlaceholder')}
                    disabled={disabled}
                  />
                </div>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Environmental Factors */}
      <Collapsible open={openEf} onOpenChange={setOpenEf}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Building2 className="w-4 h-4" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{t('program.environmentalFactors')}</CardTitle>
                    <CardDescription>{t('program.environmentalFactorsDesc')}</CardDescription>
                  </div>
                </div>
                <ChevronDown className={cn('w-5 h-5 text-muted-foreground transition-transform', openEf && 'rotate-180')} />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-4 pt-0">
              <Separator />
              {ENV_FACTOR_CATEGORIES.map((cat) => {
                const entry = efBuf[cat] || {};
                return (
                  <div key={cat} className="space-y-2 p-3 rounded-md border">
                    <Label className="text-sm font-semibold">{t(`program.environmental.category.${cat}`)}</Label>
                    <p className="text-xs text-muted-foreground">{t(`program.environmental.categoryDesc.${cat}`)}</p>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('program.environmental.facilitators')}</Label>
                        <Textarea
                          defaultValue={(entry.facilitators || []).join('\n')}
                          onBlur={(e) => saveList(cat, 'facilitators', e.target.value)}
                          placeholder={t('program.environmental.facilitatorsPlaceholder')}
                          className="min-h-[60px] text-sm"
                          disabled={disabled}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{t('program.environmental.barriers')}</Label>
                        <Textarea
                          defaultValue={(entry.barriers || []).join('\n')}
                          onBlur={(e) => saveList(cat, 'barriers', e.target.value)}
                          placeholder={t('program.environmental.barriersPlaceholder')}
                          className="min-h-[60px] text-sm"
                          disabled={disabled}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t('program.environmental.notes')}</Label>
                      <Textarea
                        defaultValue={entry.notes || ''}
                        onBlur={(e) => saveNotes(cat, e.target.value)}
                        placeholder={t('program.environmental.notesPlaceholder')}
                        className="min-h-[40px] text-sm"
                        disabled={disabled}
                      />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
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
  const { aiRefreshing } = useChat();
  const isAiRefreshing = aiRefreshing.has('progress');
  const { setActiveFeature, registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();
  const { sharedState, setSharedState } = useSharedState();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // State
  const [activeTab, setActiveTab] = useState('overview');
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [showObjectiveModal, setShowObjectiveModal] = useState(false);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [showDataPointModal, setShowDataPointModal] = useState(false);
  const [showTeamContactModal, setShowTeamContactModal] = useState(false);
  
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [editingObjective, setEditingObjective] = useState<Objective | null>(null);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [selectedGoalForObjective, setSelectedGoalForObjective] = useState<string | null>(null);
  const [selectedGoalForDataPoint, setSelectedGoalForDataPoint] = useState<string | null>(null);
  
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(new Set());

  // Form states - using schema-aligned field names
  const [programForm, setProgramForm] = useState({
    framework: 'tala' as ProgramFramework,
  });
  
  const [goalForm, setGoalForm] = useState<GoalFormState>({
    goalStatement: '',
    targetBehavior: '',
    criteria: '',
    methods: '',
    targetDate: '',
    useGas: false,
    gasVaryingVariable: '',
    gasBaselineLevel: 'much_less_than_expected',
    gasLevels: {},
    clientImportanceRating: '',
    setJointlyWithFamily: false,
    familyInput: '',
  });
  
  const [objectiveForm, setObjectiveForm] = useState<ObjectiveFormState>({
    objectiveStatement: '',
    profileDomainId: '',
    criteria: '',
    methods: '',
    targetDate: '',
    gasTargetLevel: '',
  });
  
  const [serviceForm, setServiceForm] = useState<ServiceFormState>({
    serviceType: 'speech_language_therapy',
    customServiceName: '',
    description: '',
    setting: 'therapy_room',
    deliveryModel: 'direct',
    providerName: '',
  });
  
  const [dataPointForm, setDataPointForm] = useState<DataPointFormState>({
    numericValue: '',
    unit: '',
    value: '',
    context: '',
    achievedLevel: '',
    collectedBy: '',
    recordedAt: '',
  });
  
  const [teamContactForm, setTeamContactForm] = useState<TeamContactFormState>({
    contactId: '',
    programRole: '',
    isCoordinator: false,
    responsibilities: '',
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

  // Fetch all studentContacts for the picker — populated only when the add-team
  // modal is opened, so we don't pay the query cost on every panel render.
  const { data: contactsData } = useQuery<{ success: boolean; contacts: StudentContact[] }>({
    queryKey: ['/api/biometric/students', student?.id, 'contacts'],
    queryFn: async () => {
      if (!student?.id) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/biometric/students/${student.id}/contacts`);
      if (!response.ok) throw new Error('Failed to fetch contacts');
      return response.json();
    },
    enabled: !!student?.id && isOpen && showTeamContactModal,
  });
  const availableContacts = (contactsData?.contacts || []) as StudentContact[];

  // Extract data with proper types
  const program = (programDetails?.program || currentProgram) as Program | undefined;
  const domains = (programDetails?.profileDomains || []) as ProfileDomain[];
  const goals = (programDetails?.goals || []) as GoalWithNested[];
  const services = (programDetails?.services || []) as Service[];
  const accommodations = (programDetails?.accommodations || []) as Accommodation[];
  const teamContacts = (programDetails?.teamContacts || []) as (ProgramContact & { contact: StudentContact })[];
  const meetings = (programDetails?.meetings || []) as Meeting[];
  const consentForms = (programDetails?.consentForms || []) as ConsentForm[];
  const progressReports = (programDetails?.progressReports || []) as ProgressReport[];
  const allPrograms = (allProgramsData?.programs || []) as Program[];

  // =============================================================================
  // MUTATIONS
  // =============================================================================

  // Create program
  const createProgramMutation = useMutation({
    mutationFn: async (data: { framework: ProgramFramework; }) => {
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

  const getProgamYear = (program: Program) => {
    if (!program.startDate || !program.endDate) return '';
    const startDate = new Date(program.startDate);
    const endDate = new Date(program.endDate);
    return `${startDate.getFullYear()} - ${endDate.getFullYear()}`;
  }

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

  // Update program-level fields (ICF contextual factors, notes, etc.)
  const updateProgramMutation = useMutation({
    mutationFn: async (updates: Partial<Program>) => {
      if (!program?.id) throw new Error('No program');
      const response = await apiRequest('PATCH', `/api/programs/${program.id}`, updates);
      if (!response.ok) throw new Error('Failed to update program');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
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

  // Update objective
  const updateObjectiveMutation = useMutation({
    mutationFn: async ({ objectiveId, updates }: { objectiveId: string; updates: Partial<Objective> }) => {
      const response = await apiRequest('PATCH', `/api/objectives/${objectiveId}`, updates);
      if (!response.ok) throw new Error('Failed to update objective');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('objective.updated') });
      setShowObjectiveModal(false);
      setEditingObjective(null);
      resetObjectiveForm();
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Delete objective
  const deleteObjectiveMutation = useMutation({
    mutationFn: async (objectiveId: string) => {
      const response = await apiRequest('DELETE', `/api/objectives/${objectiveId}`);
      if (!response.ok) throw new Error('Failed to delete objective');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('objective.deleted') });
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

  // --- Service user assignments (visible when editing an existing service) ---
  const { data: serviceUsersData, refetch: refetchServiceUsers } = useQuery({
    queryKey: ['/api/services', editingService?.id, 'users'],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/services/${editingService!.id}/users`);
      const json = await res.json();
      return (json.users || []) as { id: string; serviceId: string; userId: string }[];
    },
    enabled: !!editingService?.id,
  });
  const linkedServiceUserIds = (serviceUsersData || []).map((u) => u.userId);

  // Pool of users who share an institute with this student
  const { data: instituteMembersData } = useQuery({
    queryKey: ['/api/students', student?.id, 'institute-members'],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/students/${student!.id}/institute-members`);
      const json = await res.json();
      return (json.members || []) as {
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        fullName: string | null;
        profileImageUrl: string | null;
        biometricDataId: string | null;
      }[];
    },
    enabled: !!student?.id && !!editingService?.id,
  });
  const instituteMembers = instituteMembersData || [];

  const linkServiceUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest('POST', `/api/services/${editingService!.id}/users`, { userId });
      if (!res.ok) throw new Error('Failed to link user');
      return res.json();
    },
    onSuccess: () => refetchServiceUsers(),
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  const unlinkServiceUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest('DELETE', `/api/services/${editingService!.id}/users/${userId}`);
      if (!res.ok) throw new Error('Failed to unlink user');
      return res.json();
    },
    onSuccess: () => refetchServiceUsers(),
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // --- Scheduled events for the service ---
  const { data: serviceEventsData } = useQuery({
    queryKey: ['/api/services', editingService?.id, 'events'],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/services/${editingService!.id}/events`);
      const json = await res.json();
      return (json.events || []) as { id: string; title: string; startTime: string; endTime: string; repeatType: string }[];
    },
    enabled: !!editingService?.id,
  });
  const serviceEvents = serviceEventsData || [];

  const handleScheduleNewEvent = () => {
    if (!editingService) return;
    setSharedState({
      pendingEventForServiceId: editingService.id,
      pendingEventTitle: editingService.customServiceName || editingService.serviceType,
    });
    setShowServiceModal(false);
    setActiveFeature('calendar');
  };

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

  // Add a studentContacts row to this program's team (creates a programContacts junction row)
  const addTeamContactMutation = useMutation({
    mutationFn: async (data: Partial<InsertProgramContact>) => {
      const response = await apiRequest('POST', `/api/programs/${program?.id}/team`, data);
      if (!response.ok) throw new Error('Failed to add team contact');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
      toast({ title: t('team.memberAdded') });
      setShowTeamContactModal(false);
      resetTeamContactForm();
    },
    onError: (error: Error) => {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    },
  });

  // Remove a contact from the program team (soft-delete on the junction row — keeps the contact)
  const removeTeamContactMutation = useMutation({
    mutationFn: async (programContactId: string) => {
      const response = await apiRequest('DELETE', `/api/program-contacts/${programContactId}`);
      if (!response.ok) throw new Error('Failed to remove team contact');
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

  // Update junction-level fields (coordinator flag, programRole override, responsibilities)
  const updateTeamContactMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Record<string, unknown> }) => {
      const response = await apiRequest('PATCH', `/api/program-contacts/${id}`, updates);
      if (!response.ok) throw new Error('Failed to update team contact');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/programs', program?.id, 'full'] });
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
      targetBehavior: '',
      criteria: '',
      methods: '',
      targetDate: '',
      useGas: false,
      gasVaryingVariable: '',
      gasBaselineLevel: 'much_less_than_expected',
      gasLevels: {},
      clientImportanceRating: '',
      setJointlyWithFamily: false,
      familyInput: '',
    });
    setEditingGoal(null);
  };

  const resetObjectiveForm = () => {
    setObjectiveForm({
      objectiveStatement: '',
      profileDomainId: '',
      criteria: '',
      methods: '',
      targetDate: '',
      gasTargetLevel: '',
    });
    setSelectedGoalForObjective(null);
    setEditingObjective(null);
  };

  const resetServiceForm = () => {
    setServiceForm({
      serviceType: 'speech_language_therapy',
      customServiceName: '',
      description: '',
      setting: 'therapy_room',
      deliveryModel: 'direct',
      providerName: '',
    });
    setEditingService(null);
  };

  const resetDataPointForm = () => {
    setDataPointForm({
      numericValue: '',
      unit: '',
      value: '',
      context: '',
      achievedLevel: '',
      // Default collector to the current user's name. Clinicians can override
      // when logging data collected by someone else (aide, parent, etc.).
      collectedBy: user?.fullName || `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || '',
      // Default to the current local date/time — clinicians can back-date via the picker.
      recordedAt: toLocalDateTimeInput(new Date()),
    });
    setSelectedGoalForDataPoint(null);
  };

  const resetTeamContactForm = () => {
    setTeamContactForm({
      contactId: '',
      programRole: '',
      isCoordinator: false,
      responsibilities: '',
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

    const activeServices = services.filter((s) => s.isActive).length;

    // Aggregate GAS T-score across all GAS-scored goals that have at least one
    // achievedLevel data point. Unrated goals default to weight=3 (midpoint 1-5).
    const gasEntries: Array<{ ordinal: number; weight: number }> = [];
    let gasGoalsWithData = 0;
    for (const g of goals) {
      if (!g.useGas) continue;
      const ord = latestAchievedOrdinal(g);
      if (ord === null) continue;
      gasGoalsWithData += 1;
      const weight = g.clientImportanceRating ?? 3;
      gasEntries.push({ ordinal: ord, weight });
    }
    const gasTScore = computeGasTScore(gasEntries);

    return { activeGoals, achievedGoals, totalGoals, goalProgress, activeServices, gasTScore, gasGoalsWithData };
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
            <ArrowLeft className="w-4 h-4 icon-arrow-left" />
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
                          <p className="font-medium">{getProgamYear(p)}</p>
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
        <div className={cn('flex justify-between items-start')}>
          <div className={cn('flex items-center gap-3')}>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={handleBackClick}
            >
              <ArrowLeft className="w-4 h-4 icon-arrow-left" />
            </Button>
            <div>
              <div className={cn('flex items-center gap-2')}>
                <h1 className={cn('text-xl font-bold', isDark ? 'text-white' : 'text-slate-900')}>
                  {student?.name}
                </h1>
                <Badge className={STATUS_COLORS[program.status]}>
                  {t(`program.status.${program.status}`)}
                </Badge>
                {isAiRefreshing && (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className={cn('text-sm', isDark ? 'text-slate-400' : 'text-slate-600')}>
                {t(`program.framework${program.framework === 'tala' ? 'Tala' : 'Iep'}`)} • {getProgamYear(program)}
              </p>
            </div>
          </div>

          <div className={cn('flex items-center gap-2')}>
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
      <Tabs dir={isRTL ? 'rtl' : 'ltr'} value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <div className={cn(
          'border-b px-4 shrink-0',
          isDark ? 'border-slate-800 bg-slate-900/50' : 'border-gray-200 bg-white'
        )}>
          <TabsList className={cn(
            'h-12 bg-transparent gap-1'
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
                      <p className="text-2xl font-bold">{stats.activeServices}</p>
                      <p className="text-xs text-muted-foreground">{t('program.stats.activeServices')}</p>
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
                      <p className="text-2xl font-bold">{teamContacts.filter((tc) => tc.isActive).length}</p>
                      <p className="text-xs text-muted-foreground">{t('program.stats.teamMembers')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* GAS T-score summary — shown only when at least one GAS goal has data */}
            {stats.gasTScore !== null && stats.gasGoalsWithData > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                    <BarChart3 className="w-5 h-5" />
                    {t('program.gasOverallScore')}
                  </CardTitle>
                  <CardDescription>{t('program.gasOverallScoreDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className={cn('flex items-baseline gap-3', isRTL && 'flex-row-reverse')}>
                    <span className="text-4xl font-bold">{stats.gasTScore.toFixed(1)}</span>
                    <span className="text-sm text-muted-foreground">
                      {stats.gasTScore >= 50 ? t('program.gasAtOrAbove') : t('program.gasBelow')}
                    </span>
                  </div>
                  {/* T-score scale: 50 = expected, each 10 points is ~1 SD. Clamp to display range [20,80]. */}
                  <Progress value={Math.max(0, Math.min(100, ((stats.gasTScore - 20) / 60) * 100))} className="h-3" />
                  <p className="text-xs text-muted-foreground">
                    {t('program.gasGoalsCounted', { count: stats.gasGoalsWithData })}
                  </p>
                </CardContent>
              </Card>
            )}

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

                {/* Goals by Domain - Use getGoalsByDomain helper */}
                <div className="space-y-2 pt-4">
                  <p className="text-sm font-medium text-muted-foreground">{t('program.goalsByDomain')}</p>
                  {domains.map((domain) => {
                    // Get goals that have objectives in this domain
                    const domainGoals = getGoalsByDomain(goals, domain.id);
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
          <TabsContent dir={isRTL ? 'rtl' : 'ltr'} value="profile" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center')}>
              <div>
                <h2 className="text-lg font-semibold">{t('program.functionalProfile')}</h2>
                <p className="text-sm text-muted-foreground">{t('program.functionalProfileDesc')}</p>
              </div>
            </div>

            {/* ============================================================
                ICF Contextual Factors — Personal + Environmental
                These describe the world around the student, not targets of
                intervention. Authoritative for reports (chatMemory is the
                fluid observation layer).
                ============================================================ */}
            <IcfContextualFactorsSection
              personalFactors={(program.personalFactors as PersonalFactors | null) || {}}
              environmentalFactors={(program.environmentalFactors as EnvironmentalFactors | null) || {}}
              disabled={program.status === 'archived'}
              onSave={(updates) => updateProgramMutation.mutate(updates)}
              t={t}
            />

            <Separator />

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
                              {/* Count goals via objectives in this domain */}
                              {getGoalsByDomain(goals, domain.id).length} {t('program.goalsLinked')}
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
          <TabsContent dir={isRTL ? 'rtl' : 'ltr'} value="goals" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center')}>
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
                // UPDATED: Get domains from objectives instead of goal.profileDomainId
                const goalDomains = getDomainsForGoal(goal, domains);
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
                          <div className={cn('flex items-start justify-between gap-4')}>
                            <div className={cn('flex items-start gap-3')}>
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
                                <div className={cn('flex items-center gap-2 mt-1 flex-wrap')}>
                                  {/* UPDATED: Show multiple domains from objectives */}
                                  {goalDomains.length > 0 ? (
                                    goalDomains.map(domain => (
                                      <Badge key={domain.id} variant="outline" className="text-xs">
                                        {DOMAIN_ICONS[domain.domainType]}
                                        <span className="ms-1">{t(`program.domains.${domain.domainType}`)}</span>
                                      </Badge>
                                    ))
                                  ) : (
                                    <Badge variant="outline" className="text-xs text-muted-foreground">
                                      {t('goal.noDomain')}
                                    </Badge>
                                  )}
                                  <Badge className={STATUS_COLORS[goal.status]}>
                                    {t(`goal.status.${goal.status}`)}
                                  </Badge>
                                  {/* GAS per-goal indicator: latest achieved vs baseline */}
                                  {goal.useGas && (() => {
                                    const latest = latestAchievedOrdinal(goal);
                                    const baseline = goal.gasBaselineLevel
                                      ? { much_less_than_expected: -2, less_than_expected: -1, expected: 0, better_than_expected: 1, much_better_than_expected: 2 }[goal.gasBaselineLevel]
                                      : null;
                                    if (latest === null) {
                                      return (
                                        <Badge variant="outline" className="text-xs">
                                          GAS · {t('goal.gas.noData')}
                                        </Badge>
                                      );
                                    }
                                    const delta = baseline !== null ? latest - baseline : null;
                                    const sign = latest > 0 ? '+' : '';
                                    return (
                                      <Badge variant="outline" className={cn(
                                        'text-xs',
                                        latest > 0 && 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-300',
                                        latest < 0 && 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-300',
                                      )}>
                                        GAS {sign}{latest}{delta != null && delta !== 0 && ` (${delta > 0 ? '+' : ''}${delta})`}
                                      </Badge>
                                    );
                                  })()}
                                </div>
                              </div>
                            </div>
                            <div className={cn('flex items-center gap-2')}>
                              {program.status !== 'archived' && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingGoal(goal);
                                      // UPDATED: No profileDomainId in form
                                      setGoalForm({
                                        goalStatement: goal.goalStatement,
                                        targetBehavior: goal.targetBehavior || '',
                                        criteria: goal.criteria || '',
                                        methods: goal.methods || '',
                                        targetDate: goal.targetDate || '',
                                        useGas: goal.useGas || false,
                                        gasVaryingVariable: (goal.gasVaryingVariable as GasVaryingVariable) || '',
                                        gasBaselineLevel: (goal.gasBaselineLevel as GasLevel) || 'much_less_than_expected',
                                        gasLevels: (goal.gasLevels as GasLevels) || {},
                                        clientImportanceRating: goal.clientImportanceRating != null ? String(goal.clientImportanceRating) : '',
                                        setJointlyWithFamily: goal.setJointlyWithFamily || false,
                                        familyInput: goal.familyInput || '',
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
                            {goal.methods && (
                              <div className="space-y-1">
                                <Label className="text-muted-foreground">{t('goal.methods')}</Label>
                                <p className="text-sm">{goal.methods}</p>
                              </div>
                            )}
                          </div>

                          {/* UPDATED: progress is the schema field (0-100) */}
                          {goal.progress !== null && goal.progress !== undefined && goal.progress > 0 && (
                            <div className="space-y-2">
                              <div className={cn('flex justify-between text-sm')}>
                                <span>{t('goal.currentProgress')}</span>
                                <span className="font-medium">{goal.progress}%</span>
                              </div>
                              <Progress value={goal.progress} className="h-2" />
                            </div>
                          )}

                          {/* =========== OBJECTIVES SECTION =========== */}
                          <div className="space-y-3">
                            <div className={cn('flex items-center justify-between')}>
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
                                {goal.objectives.map((objective, idx) => {
                                  // Get domain for this objective
                                  const objDomain = domains.find(d => d.id === objective.profileDomainId);
                                  return (
                                    <div
                                      key={objective.id}
                                      className={cn(
                                        'p-3 rounded-lg border text-sm',
                                        isDark ? 'bg-slate-800/50 border-slate-700' : 'bg-gray-50 border-gray-200'
                                      )}
                                    >
                                      <div className={cn('flex items-start justify-between gap-2')}>
                                        <div className={cn('flex items-start gap-2')}>
                                          <span className={cn(
                                            'flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium mt-0.5',
                                            objective.status === 'achieved'
                                              ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                                              : objective.status === 'in_progress' || objective.status === 'active'
                                              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                                              : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                                          )}>
                                            {idx + 1}
                                          </span>
                                          <div className="flex-1 min-w-0">
                                            <p className={isRTL ? 'text-right' : ''}>{objective.objectiveStatement}</p>
                                            {/* Show domain for this objective */}
                                            {objDomain && (
                                              <Badge variant="outline" className="text-xs mt-1">
                                                {DOMAIN_ICONS[objDomain.domainType]}
                                                <span className="ms-1">{t(`program.domains.${objDomain.domainType}`)}</span>
                                              </Badge>
                                            )}
                                            {objective.criteria && (
                                              <p className={cn('text-xs text-muted-foreground mt-1', isRTL && 'text-right')}>
                                                {t('objective.criteria')}: {objective.criteria}
                                              </p>
                                            )}
                                            {/* Show methods if present */}
                                            {objective.methods && (
                                              <p className={cn('text-xs text-muted-foreground mt-1', isRTL && 'text-right')}>
                                                {t('objective.methods')}: {objective.methods}
                                              </p>
                                            )}
                                            {/* GAS target level badge — when the parent goal is GAS-scored
                                                and this objective aims at a specific level */}
                                            {goal.useGas && objective.gasTargetLevel && (
                                              <Badge variant="outline" className="text-xs mt-1">
                                                {(() => {
                                                  const ordinal = GAS_LEVEL_ORDINALS[objective.gasTargetLevel as GasLevel];
                                                  return `${t('objective.gasTargetLevelShort')}: ${ordinal > 0 ? '+' : ''}${ordinal} · ${t(`goal.gas.level.${objective.gasTargetLevel}`)}`;
                                                })()}
                                              </Badge>
                                            )}
                                            {/* Show objective progress */}
                                            {objective.progress !== null && objective.progress !== undefined && objective.progress > 0 && (
                                              <div className="mt-2">
                                                <div className={cn('flex justify-between text-xs')}>
                                                  <span>{t('objective.progress')}</span>
                                                  <span className="font-medium">{objective.progress}%</span>
                                                </div>
                                                <Progress value={objective.progress} className="h-1 mt-1" />
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-1">
                                          <Badge className={cn('flex-shrink-0', STATUS_COLORS[objective.status])}>
                                            {t(`objective.status.${objective.status}`)}
                                          </Badge>
                                          {program.status !== 'archived' && (
                                            <>
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  setEditingObjective(objective);
                                                  setSelectedGoalForObjective(goal.id);
                                                  setObjectiveForm({
                                                    objectiveStatement: objective.objectiveStatement,
                                                    profileDomainId: objective.profileDomainId || 'none',
                                                    criteria: objective.criteria || '',
                                                    methods: objective.methods || '',
                                                    targetDate: objective.targetDate || '',
                                                    gasTargetLevel: (objective.gasTargetLevel as GasLevel) || '',
                                                  });
                                                  setShowObjectiveModal(true);
                                                }}
                                              >
                                                <Edit className="w-3 h-3" />
                                              </Button>
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 text-destructive hover:text-destructive"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  if (confirm(t('objective.confirmDelete'))) {
                                                    deleteObjectiveMutation.mutate(objective.id);
                                                  }
                                                }}
                                              >
                                                <Trash2 className="w-3 h-3" />
                                              </Button>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                      {objective.targetDate && (
                                        <p className={cn('text-xs text-muted-foreground mt-2 flex items-center gap-1', isRTL && 'flex-row-reverse justify-end')}>
                                          <Calendar className="w-3 h-3" />
                                          {t('objective.targetDate')}: {new Date(objective.targetDate).toLocaleDateString()}
                                        </p>
                                      )}
                                    </div>
                                  );
                                })}
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
                            <div className={cn('flex items-center justify-between')}>
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
                                    <div className={cn('flex items-center justify-between')}>
                                      <div className={cn('flex items-center gap-3')}>
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
                                      <div className={cn('text-xs text-muted-foreground flex items-center gap-1')}>
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
          <TabsContent dir={isRTL ? 'rtl' : 'ltr'} value="services" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center')}>
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
              <Card dir={isRTL ? 'rtl' : 'ltr'}>
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
                  <Card dir={isRTL ? 'rtl' : 'ltr'} key={service.id} className={cn(!service.isActive && 'opacity-60')}>
                    <CardContent className="p-4">
                      <div className={cn('flex items-start justify-between gap-4')}>
                        <div className={cn('flex items-start gap-3')}>
                          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                            {SERVICE_ICONS[service.serviceType]}
                          </div>
                          <div className={isRTL ? 'text-right' : ''}>
                            {/* customServiceName is schema field for display name (NOT serviceName) */}
                            <h3 className="font-medium">{getServiceDisplayName(service)}</h3>
                            <p className="text-sm text-muted-foreground">
                              {t(`service.types.${service.serviceType}`)}
                            </p>
                            <div className={cn('flex items-center gap-3 mt-2 text-xs text-muted-foreground')}>
                              {service.setting && (
                                <span className="flex items-center gap-1">
                                  <Building2 className="w-3 h-3" />
                                  {t(`service.settings.${service.setting}`)}
                                </span>
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
                          <div className={cn('flex items-center gap-1')}>
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
                      <Card dir={isRTL ? 'rtl' : 'ltr'} key={acc.id}>
                        <CardContent className="p-3">
                          <div className={cn('flex items-start gap-3')}>
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
          <TabsContent dir={isRTL ? 'rtl' : 'ltr'} value="progress" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center')}>
              <div>
                <h2 className="text-lg font-semibold">{t('program.progressTracking')}</h2>
                <p className="text-sm text-muted-foreground">{t('program.progressTrackingDesc')}</p>
              </div>
            </div>

            {/* Quick Data Entry */}
            <Card dir={isRTL ? 'rtl' : 'ltr'}>
              <CardHeader>
                <CardTitle className="text-base">{t('program.progress.quickDataEntry')}</CardTitle>
              </CardHeader>
              <CardContent>
                {goals.filter((g) => g.status === 'active').length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('program.progress.noActiveGoals')}</p>
                ) : (
                  <div className="space-y-2">
                    {goals.filter((g) => g.status === 'active').map((goal) => (
                      <div 
                        key={goal.id}
                        dir={isRTL ? 'rtl' : 'ltr'}
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
            <Card dir={isRTL ? 'rtl' : 'ltr'}>
              <CardHeader>
                <CardTitle className="text-base">{t('program.progress.reports')}</CardTitle>
              </CardHeader>
              <CardContent>
                {progressReports.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('program.progress.noReports')}</p>
                ) : (
                  <div className="space-y-2">
                    {progressReports.map((report) => (
                      <div 
                        key={report.id}
                        dir={isRTL ? 'rtl' : 'ltr'}
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
                            <span className="text-xs text-muted-foreground ms-2">
                              ({report.reportingPeriod})
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {report.sharedWithParents && (
                            <Badge variant="outline" className="text-xs">
                              <Share2 className="w-3 h-3 me-1" />
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
          <TabsContent dir={isRTL ? 'rtl' : 'ltr'} value="team" className="p-4 space-y-4 mt-0">
            <div className={cn('flex justify-between items-center')}>
              <div>
                <h2 className="text-lg font-semibold">{t('program.teamAndCompliance')}</h2>
                <p className="text-sm text-muted-foreground">{t('program.teamAndComplianceDesc')}</p>
              </div>
              {program.status !== 'archived' && (
                <Button
                  className="gap-2"
                  onClick={() => {
                    resetTeamContactForm();
                    setShowTeamContactModal(true);
                  }}
                >
                  <UserPlus className="w-4 h-4" />
                  {t('team.addMember')}
                </Button>
              )}
            </div>

            {/* Team contacts — rows of programContacts with their underlying studentContact joined in */}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {teamContacts.map((tc) => {
                const c = tc.contact;
                const displayRole = tc.programRole || c.role;
                const photoSrc = c.biometricDataId
                  ? apiUrl(`/api/biometric-data/${c.biometricDataId}/photo`)
                  : null;
                return (
                  <Card key={tc.id} className={cn(!tc.isActive && 'opacity-60')}>
                    <CardContent className="p-4">
                      <div className={cn('flex items-start gap-3', isRTL && 'flex-row-reverse')}>
                        {photoSrc ? (
                          <img
                            src={photoSrc}
                            alt=""
                            className="w-10 h-10 rounded-full object-cover border shrink-0"
                            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <User className="w-4 h-4 text-primary" />
                          </div>
                        )}
                        <div className={cn('flex-1 min-w-0', isRTL ? 'text-right' : '')}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-medium truncate">{c.name}</h3>
                            {tc.isCoordinator && (
                              <Badge variant="secondary" className="text-xs">{t('team.coordinator')}</Badge>
                            )}
                          </div>
                          {displayRole && (
                            <p className="text-sm text-muted-foreground">
                              {t(`team.roles.${displayRole}`)}
                            </p>
                          )}
                          {c.contactEmail && (
                            <p className="text-xs text-muted-foreground mt-1 truncate">{c.contactEmail}</p>
                          )}
                          {c.contactPhone && (
                            <p className="text-xs text-muted-foreground">{c.contactPhone}</p>
                          )}
                          {tc.responsibilities && tc.responsibilities.length > 0 && (
                            <ul className="mt-2 text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                              {tc.responsibilities.map((r, i) => <li key={i}>{r}</li>)}
                            </ul>
                          )}
                        </div>
                        {program.status !== 'archived' && (
                          <div className="flex flex-col gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title={tc.isCoordinator ? t('team.unsetCoordinator') : t('team.setCoordinator')}
                              onClick={() =>
                                updateTeamContactMutation.mutate({
                                  id: tc.id,
                                  updates: { isCoordinator: !tc.isCoordinator },
                                })
                              }
                            >
                              <Award className={cn('w-4 h-4', tc.isCoordinator && 'text-primary')} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => {
                                if (confirm(t('team.confirmRemove'))) {
                                  removeTeamContactMutation.mutate(tc.id);
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
                );
              })}
            </div>

            {teamContacts.length === 0 && (
              <Card>
                <CardContent className="py-8">
                  <div className="text-center text-muted-foreground">
                    <Users className="w-10 h-10 mx-auto mb-3 opacity-50" />
                    <p className="text-sm">{t('team.noMembers')}</p>
                    <p className="text-xs mt-1">{t('team.noMembersHint')}</p>
                  </div>
                </CardContent>
              </Card>
            )}

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
                                    {consent.consentGiven ? t('consent.signed') : t('consent.pendingStatus')}
                                    {consent.signedBy && ` • ${consent.signedBy}`}
                                  </p>
                                )}
                              </div>
                            </div>
                            <Badge variant={consent.consentGiven ? 'default' : 'outline'}>
                              {consent.consentGiven ? (
                                <CheckCircle2 className="w-3 h-3 me-1" />
                              ) : (
                                <Circle className="w-3 h-3 me-1" />
                              )}
                              {consent.consentGiven ? t('consent.signed') : t('consent.pendingStatus')}
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
        <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
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
              {/* methods - schema field */}
              <div className="space-y-2">
                <Label>{t('goal.methods')}</Label>
                <Input
                  value={goalForm.methods}
                  onChange={(e) => setGoalForm(prev => ({ ...prev, methods: e.target.value }))}
                  placeholder={t('goal.methodsPlaceholder')}
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

            {/* =========================================================
                Family-Centered Service (FCS) — COPM-style joint goal-setting
                ========================================================= */}
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="setJointlyWithFamily"
                  checked={goalForm.setJointlyWithFamily}
                  onCheckedChange={(checked) => setGoalForm(prev => ({ ...prev, setJointlyWithFamily: !!checked }))}
                />
                <Label htmlFor="setJointlyWithFamily" className="text-sm font-normal">
                  {t('goal.setJointlyWithFamily')}
                </Label>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('goal.clientImportanceRating')}</Label>
                  <Input
                    type="number"
                    min={1}
                    max={5}
                    value={goalForm.clientImportanceRating}
                    onChange={(e) => setGoalForm(prev => ({ ...prev, clientImportanceRating: e.target.value }))}
                    placeholder="1-5"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('goal.familyInput')}</Label>
                <Textarea
                  value={goalForm.familyInput}
                  onChange={(e) => setGoalForm(prev => ({ ...prev, familyInput: e.target.value }))}
                  placeholder={t('goal.familyInputPlaceholder')}
                  className="min-h-[60px]"
                />
              </div>
            </div>

            {/* =========================================================
                GAS (Goal Attainment Scaling) — TALA-aligned ordinal scoring
                ========================================================= */}
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="useGas"
                  checked={goalForm.useGas}
                  onCheckedChange={(checked) => setGoalForm(prev => ({ ...prev, useGas: !!checked }))}
                />
                <Label htmlFor="useGas" className="text-sm font-medium">
                  {t('goal.useGas')}
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">{t('goal.gasDescription')}</p>

              {goalForm.useGas && (
                <div className="space-y-4 ps-4 border-s-2">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>{t('goal.gas.varyingVariable')}</Label>
                      <Select
                        value={goalForm.gasVaryingVariable || undefined}
                        onValueChange={(value: GasVaryingVariable) =>
                          setGoalForm(prev => ({ ...prev, gasVaryingVariable: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t('goal.gas.selectVariable')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="achievement">{t('goal.gas.variable.achievement')}</SelectItem>
                          <SelectItem value="mediation">{t('goal.gas.variable.mediation')}</SelectItem>
                          <SelectItem value="time">{t('goal.gas.variable.time')}</SelectItem>
                          <SelectItem value="frequency">{t('goal.gas.variable.frequency')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>{t('goal.gas.baselineLevel')}</Label>
                      <Select
                        value={goalForm.gasBaselineLevel || undefined}
                        onValueChange={(value: GasLevel) =>
                          setGoalForm(prev => ({ ...prev, gasBaselineLevel: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {GAS_LEVEL_ORDER.map(level => (
                            <SelectItem key={level} value={level}>
                              {GAS_LEVEL_ORDINALS[level] > 0 ? '+' : ''}{GAS_LEVEL_ORDINALS[level]} {t(`goal.gas.level.${level}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label>{t('goal.gas.levels')}</Label>
                    <p className="text-xs text-muted-foreground">{t('goal.gas.levelsHint')}</p>
                    {GAS_LEVEL_ORDER.map(level => {
                      const ordinal = GAS_LEVEL_ORDINALS[level];
                      const entry = goalForm.gasLevels[level] || { behavior: '' };
                      const isBaseline = goalForm.gasBaselineLevel === level;
                      const isTarget = level === 'expected';
                      return (
                        <div key={level} className="space-y-2 p-3 rounded-md border bg-muted/30">
                          <div className="flex items-center justify-between">
                            <Label className="text-sm font-semibold">
                              {ordinal > 0 ? '+' : ''}{ordinal} · {t(`goal.gas.level.${level}`)}
                            </Label>
                            <div className="flex gap-1">
                              {isBaseline && <Badge variant="outline" className="text-xs">{t('goal.gas.baselineBadge')}</Badge>}
                              {isTarget && <Badge variant="outline" className="text-xs">{t('goal.gas.targetBadge')}</Badge>}
                            </div>
                          </div>
                          <Textarea
                            value={entry.behavior || ''}
                            onChange={(e) => setGoalForm(prev => ({
                              ...prev,
                              gasLevels: {
                                ...prev.gasLevels,
                                [level]: { ...prev.gasLevels[level], behavior: e.target.value },
                              },
                            }))}
                            placeholder={t('goal.gas.behaviorPlaceholder')}
                            className="min-h-[50px] text-sm"
                          />
                          {/* Numeric value + unit only shown for quantitative varying variables */}
                          {(goalForm.gasVaryingVariable === 'frequency' ||
                            goalForm.gasVaryingVariable === 'time' ||
                            goalForm.gasVaryingVariable === 'achievement') && (
                            <div className="grid grid-cols-2 gap-2">
                              <Input
                                type="number"
                                step="any"
                                value={entry.numericValue != null ? String(entry.numericValue) : ''}
                                onChange={(e) => setGoalForm(prev => ({
                                  ...prev,
                                  gasLevels: {
                                    ...prev.gasLevels,
                                    [level]: {
                                      ...prev.gasLevels[level],
                                      behavior: prev.gasLevels[level]?.behavior || '',
                                      numericValue: e.target.value === '' ? undefined : parseFloat(e.target.value),
                                    },
                                  },
                                }))}
                                placeholder={t('goal.gas.numericPlaceholder')}
                                className="text-sm"
                              />
                              <Input
                                value={entry.unit || ''}
                                onChange={(e) => setGoalForm(prev => ({
                                  ...prev,
                                  gasLevels: {
                                    ...prev.gasLevels,
                                    [level]: {
                                      ...prev.gasLevels[level],
                                      behavior: prev.gasLevels[level]?.behavior || '',
                                      unit: e.target.value || undefined,
                                    },
                                  },
                                }))}
                                placeholder={t('goal.gas.unitPlaceholder')}
                                className="text-sm"
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
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
                const rating = goalForm.clientImportanceRating.trim()
                  ? Math.min(5, Math.max(1, parseInt(goalForm.clientImportanceRating)))
                  : undefined;
                const goalData: InsertGoal = {
                  programId: program.id,
                  goalStatement: goalForm.goalStatement,
                  criteria: goalForm.criteria || undefined,
                  methods: goalForm.methods || undefined,
                  targetDate: goalForm.targetDate || undefined,
                  useGas: goalForm.useGas,
                  gasVaryingVariable: goalForm.useGas && goalForm.gasVaryingVariable ? goalForm.gasVaryingVariable : null,
                  gasBaselineLevel: goalForm.useGas && goalForm.gasBaselineLevel ? goalForm.gasBaselineLevel : null,
                  gasLevels: goalForm.useGas ? goalForm.gasLevels : {},
                  clientImportanceRating: rating,
                  setJointlyWithFamily: goalForm.setJointlyWithFamily,
                  familyInput: goalForm.familyInput || undefined,
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
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              )}
              {editingGoal ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Objective Modal */}
      <Dialog open={showObjectiveModal} onOpenChange={setShowObjectiveModal}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingObjective ? t('objective.edit') : t('objective.add')}</DialogTitle>
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

            {/* NEW: Domain selection for objective */}
            <div className="space-y-2">
              <Label>{t('objective.domain')}</Label>
              <Select
                value={objectiveForm.profileDomainId}
                onValueChange={(value) => setObjectiveForm(prev => ({ ...prev, profileDomainId: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('objective.selectDomain')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('objective.noDomain')}</SelectItem>
                  {domains.map((domain) => (
                    <SelectItem key={domain.id} value={domain.id}>
                      {t(`program.domains.${domain.domainType}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* criteria */}
            <div className="space-y-2">
              <Label>{t('objective.criteria')}</Label>
              <Input
                value={objectiveForm.criteria}
                onChange={(e) => setObjectiveForm(prev => ({ ...prev, criteria: e.target.value }))}
                placeholder={t('objective.criteriaPlaceholder')}
              />
            </div>

            {/* Methods/strategies field */}
            <div className="space-y-2">
              <Label>{t('objective.methods')}</Label>
              <Textarea
                value={objectiveForm.methods}
                onChange={(e) => setObjectiveForm(prev => ({ ...prev, methods: e.target.value }))}
                placeholder={t('objective.methodsPlaceholder')}
                className="min-h-[60px]"
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

            {/* GAS target-level picker — only shown when the parent goal is GAS-scored
                and has at least one level defined. Points this objective at one level on
                the parent's scale. */}
            {(() => {
              const parent = selectedGoalForObjective ? goals.find(g => g.id === selectedGoalForObjective) : null;
              if (!parent?.useGas) return null;
              const parentLevels = (parent.gasLevels as GasLevels | undefined) || {};
              const definedLevels = GAS_LEVEL_ORDER.filter(lv => parentLevels[lv]?.behavior);
              if (definedLevels.length === 0) return null;
              return (
                <div className="space-y-2">
                  <Label>{t('objective.gasTargetLevel')}</Label>
                  <Select
                    value={objectiveForm.gasTargetLevel || 'none'}
                    onValueChange={(value) =>
                      setObjectiveForm(prev => ({
                        ...prev,
                        gasTargetLevel: value === 'none' ? '' : (value as GasLevel),
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('objective.gasTargetLevelPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('objective.gasTargetLevelNone')}</SelectItem>
                      {definedLevels.map((level) => {
                        const entry = parentLevels[level];
                        const ordinal = GAS_LEVEL_ORDINALS[level];
                        return (
                          <SelectItem key={level} value={level}>
                            <span className="font-medium">
                              {ordinal > 0 ? '+' : ''}{ordinal} · {t(`goal.gas.level.${level}`)}
                            </span>
                            {entry?.behavior && (
                              <span className="text-muted-foreground text-xs ms-2">
                                — {entry.behavior.slice(0, 60)}{entry.behavior.length > 60 ? '…' : ''}
                              </span>
                            )}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t('objective.gasTargetLevelHint')}</p>
                </div>
              );
            })()}
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
                
                const objectiveData = {
                  goalId: selectedGoalForObjective!,
                  objectiveStatement: objectiveForm.objectiveStatement,
                  profileDomainId: objectiveForm.profileDomainId && objectiveForm.profileDomainId !== 'none' ? objectiveForm.profileDomainId : undefined,
                  criteria: objectiveForm.criteria || undefined,
                  methods: objectiveForm.methods || undefined,
                  targetDate: objectiveForm.targetDate || undefined,
                  gasTargetLevel: objectiveForm.gasTargetLevel || null,
                };
                
                if (editingObjective) {
                  updateObjectiveMutation.mutate({ 
                    objectiveId: editingObjective.id, 
                    updates: objectiveData 
                  });
                } else if (selectedGoalForObjective) {
                  createObjectiveMutation.mutate({
                    goalId: selectedGoalForObjective,
                    data: objectiveData,
                  });
                }
              }}
              disabled={createObjectiveMutation.isPending || updateObjectiveMutation.isPending}
            >
              {(createObjectiveMutation.isPending || updateObjectiveMutation.isPending) && (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              )}
              {editingObjective ? t('common.save') : t('common.create')}
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

          <DialogBody className="grid gap-4 py-4">
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

            {editingService && (
              <>
                <Separator />

                {/* Assigned users */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    {t('service.assignedUsers')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('service.assignedUsersHint')}
                  </p>
                  {instituteMembers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('service.noInstituteMembers')}
                    </p>
                  ) : (
                    <div className="space-y-1 max-h-48 overflow-y-auto rounded-md border p-2">
                      {instituteMembers.map((m) => {
                        const linked = linkedServiceUserIds.includes(m.id);
                        const busy =
                          (linkServiceUserMutation.isPending && linkServiceUserMutation.variables === m.id) ||
                          (unlinkServiceUserMutation.isPending && unlinkServiceUserMutation.variables === m.id);
                        return (
                          <div
                            key={m.id}
                            className={cn(
                              'flex items-center justify-between p-2 rounded-md text-sm',
                              linked ? 'bg-primary/10 border border-primary/20' : 'bg-muted/40',
                            )}
                          >
                            <span className="truncate">{m.fullName || m.email}</span>
                            <Button
                              variant={linked ? 'destructive' : 'outline'}
                              size="sm"
                              className="h-7"
                              disabled={busy}
                              onClick={() =>
                                linked
                                  ? unlinkServiceUserMutation.mutate(m.id)
                                  : linkServiceUserMutation.mutate(m.id)
                              }
                            >
                              {busy ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : linked ? (
                                t('service.unassign')
                              ) : (
                                t('service.assign')
                              )}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <Separator />

                {/* Scheduled events */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-2">
                      <Calendar className="w-4 h-4" />
                      {t('service.scheduledEvents')}
                    </Label>
                    <Button variant="outline" size="sm" onClick={handleScheduleNewEvent}>
                      <Plus className="w-3 h-3 me-1" />
                      {t('service.scheduleNew')}
                    </Button>
                  </div>
                  {serviceEvents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('service.noScheduledEvents')}
                    </p>
                  ) : (
                    <div className="space-y-1 max-h-48 overflow-y-auto rounded-md border p-2">
                      {serviceEvents.map((ev) => (
                        <div key={ev.id} className="flex items-center justify-between p-2 rounded-md bg-muted/40 text-sm">
                          <div className="min-w-0">
                            <p className="font-medium truncate">{ev.title}</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(ev.startTime).toLocaleString()}
                              {ev.repeatType !== 'none' && (
                                <span className="ms-2">
                                  ({t(`service.repeat.${ev.repeatType}`) || ev.repeatType})
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </DialogBody>

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
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              )}
              {editingService ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Data Point Modal */}
      <Dialog open={showDataPointModal} onOpenChange={setShowDataPointModal}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t('dataPoint.record')}</DialogTitle>
            <DialogDescription>{t('dataPoint.modalDescription')}</DialogDescription>
          </DialogHeader>

          {(() => {
            const selectedGoal = selectedGoalForDataPoint
              ? goals.find(g => g.id === selectedGoalForDataPoint)
              : null;
            const isGasGoal = !!selectedGoal?.useGas;
            const gasLevels = (selectedGoal?.gasLevels as GasLevels | undefined) || {};
            const varyingVariable = selectedGoal?.gasVaryingVariable as GasVaryingVariable | undefined;
            const baselineLevel = selectedGoal?.gasBaselineLevel as GasLevel | undefined;
            // Quantitative varying variables prompt for an exact numeric value;
            // 'mediation' is categorical and takes the level's meaning at face value.
            const showQuantitativeInput =
              isGasGoal &&
              (varyingVariable === 'frequency' ||
                varyingVariable === 'time' ||
                varyingVariable === 'achievement');
            // Unit hint pulled from the level the user selected (if any).
            const selectedLevelEntry = dataPointForm.achievedLevel
              ? gasLevels[dataPointForm.achievedLevel as GasLevel]
              : undefined;
            const levelUnitHint = selectedLevelEntry?.unit || '';
            return (
              <>
                <DialogBody className="grid gap-4 py-4">
                  {/* Goal context header */}
                  {selectedGoal && (
                    <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                      <div className="text-xs text-muted-foreground uppercase tracking-wide">
                        {t('dataPoint.goalHeader')}
                      </div>
                      <div className="text-sm font-medium">{selectedGoal.goalStatement}</div>
                      {isGasGoal && varyingVariable && (
                        <div className="text-xs text-muted-foreground">
                          {t('goal.gas.varyingVariable')}: {t(`goal.gas.variable.${varyingVariable}`)}
                        </div>
                      )}
                    </div>
                  )}

                  {/* GAS level picker */}
                  {isGasGoal && (
                    <div className="space-y-2">
                      <Label>{t('dataPoint.achievedLevel')} *</Label>
                      <div className="space-y-2">
                        {GAS_LEVEL_ORDER.map(level => {
                          const ordinal = GAS_LEVEL_ORDINALS[level];
                          const entry = gasLevels[level];
                          const selected = dataPointForm.achievedLevel === level;
                          const isBaseline = baselineLevel === level;
                          const isTarget = level === 'expected';
                          return (
                            <button
                              type="button"
                              key={level}
                              onClick={() => setDataPointForm(prev => ({
                                ...prev,
                                achievedLevel: level,
                                // Pre-fill unit from the level if the form hasn't been edited yet
                                unit: prev.unit || entry?.unit || '',
                              }))}
                              className={cn(
                                'w-full text-start p-3 rounded-md border transition-colors',
                                selected ? 'border-primary bg-primary/10' : 'hover:bg-muted/50'
                              )}
                            >
                              <div className="flex items-center justify-between">
                                <div className="text-sm font-semibold">
                                  {ordinal > 0 ? '+' : ''}{ordinal} · {t(`goal.gas.level.${level}`)}
                                </div>
                                <div className="flex gap-1">
                                  {isBaseline && (
                                    <Badge variant="outline" className="text-xs">
                                      {t('goal.gas.baselineBadge')}
                                    </Badge>
                                  )}
                                  {isTarget && (
                                    <Badge variant="outline" className="text-xs">
                                      {t('goal.gas.targetBadge')}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              {entry?.behavior && (
                                <div className="text-xs text-muted-foreground mt-1">{entry.behavior}</div>
                              )}
                              {entry?.numericValue != null && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {entry.numericValue}{entry.unit ? ` ${entry.unit}` : ''}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Quantitative override — only shown for quantitative varying variables */}
                  {showQuantitativeInput && (
                    <div className="space-y-2">
                      <Label>{t('dataPoint.observedValue')}</Label>
                      <div className="flex gap-2">
                        <Input
                          type="number"
                          step="any"
                          value={dataPointForm.numericValue}
                          onChange={(e) => setDataPointForm(prev => ({ ...prev, numericValue: e.target.value }))}
                          placeholder={t('dataPoint.observedValuePlaceholder')}
                          className="flex-1"
                        />
                        <Input
                          value={dataPointForm.unit}
                          onChange={(e) => setDataPointForm(prev => ({ ...prev, unit: e.target.value }))}
                          placeholder={levelUnitHint || t('goal.gas.unitPlaceholder')}
                          className="w-24"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t('dataPoint.observedValueHint')}
                      </p>
                    </div>
                  )}

                  {/* Non-GAS goal: simple numeric entry */}
                  {!isGasGoal && (
                    <div className="space-y-2">
                      <Label>{t('dataPoint.numericValue')}</Label>
                      <Input
                        type="number"
                        step="any"
                        value={dataPointForm.numericValue}
                        onChange={(e) => setDataPointForm(prev => ({ ...prev, numericValue: e.target.value }))}
                        placeholder={t('dataPoint.numericPlaceholder')}
                      />
                    </div>
                  )}

                  {/* Free-text value — only for non-GAS goals. For GAS goals the
                      level's behavior already captures what happened. */}
                  {!isGasGoal && (
                    <div className="space-y-2">
                      <Label>{t('dataPoint.textValue')}</Label>
                      <Input
                        value={dataPointForm.value}
                        onChange={(e) => setDataPointForm(prev => ({ ...prev, value: e.target.value }))}
                        placeholder={t('dataPoint.textPlaceholder')}
                      />
                    </div>
                  )}

                  {/* Context notes — always */}
                  <div className="space-y-2">
                    <Label>{t('dataPoint.notes')}</Label>
                    <Textarea
                      value={dataPointForm.context}
                      onChange={(e) => setDataPointForm(prev => ({ ...prev, context: e.target.value }))}
                      placeholder={t('dataPoint.notesPlaceholder')}
                      className="min-h-[60px]"
                    />
                  </div>

                  {/* Session metadata: collector + timestamp */}
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>{t('dataPoint.collectedBy')}</Label>
                      <Input
                        value={dataPointForm.collectedBy}
                        onChange={(e) => setDataPointForm(prev => ({ ...prev, collectedBy: e.target.value }))}
                        placeholder={t('dataPoint.collectedByPlaceholder')}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('dataPoint.recordedAt')}</Label>
                      <Input
                        type="datetime-local"
                        value={dataPointForm.recordedAt}
                        onChange={(e) => setDataPointForm(prev => ({ ...prev, recordedAt: e.target.value }))}
                      />
                    </div>
                  </div>
                </DialogBody>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowDataPointModal(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    onClick={() => {
                      if (isGasGoal && !dataPointForm.achievedLevel) {
                        toast({ title: t('common.error'), description: t('dataPoint.achievedLevelRequired'), variant: 'destructive' });
                        return;
                      }
                      if (!isGasGoal && !dataPointForm.numericValue && !dataPointForm.value) {
                        toast({ title: t('common.error'), description: t('dataPoint.valueRequired'), variant: 'destructive' });
                        return;
                      }
                      if (selectedGoalForDataPoint) {
                        // For GAS goals: prefer the observed numeric input. If blank,
                        // fall back to the picked level's default numericValue (if any).
                        const achieved = dataPointForm.achievedLevel || undefined;
                        const levelEntry = achieved ? gasLevels[achieved] : undefined;
                        const numeric = dataPointForm.numericValue
                          ? parseFloat(dataPointForm.numericValue)
                          : levelEntry?.numericValue;
                        // For GAS goals the "value" text isn't meaningful — the level
                        // + behavior describe what happened. Serialize numericValue+unit
                        // for display if the clinician entered them.
                        let textValue = dataPointForm.value;
                        if (!textValue && isGasGoal) {
                          if (numeric != null) {
                            const unit = dataPointForm.unit || levelEntry?.unit || '';
                            textValue = unit ? `${numeric} ${unit}` : String(numeric);
                          } else if (levelEntry?.behavior) {
                            textValue = levelEntry.behavior;
                          }
                        }
                        const recordedAt = dataPointForm.recordedAt
                          ? new Date(dataPointForm.recordedAt)
                          : new Date();
                        createDataPointMutation.mutate({
                          goalId: selectedGoalForDataPoint,
                          data: {
                            numericValue: numeric,
                            value: textValue || '',
                            context: dataPointForm.context || undefined,
                            achievedLevel: achieved,
                            collectedBy: dataPointForm.collectedBy || undefined,
                            recordedAt,
                          } as InsertDataPoint,
                        });
                      }
                    }}
                    disabled={createDataPointMutation.isPending}
                  >
                    {createDataPointMutation.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                    {t('common.save')}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Add Team Contact Modal — picks an existing studentContacts row */}
      <Dialog open={showTeamContactModal} onOpenChange={setShowTeamContactModal}>
        <DialogContent className="sm:max-w-[480px]" dir={isRTL ? 'rtl' : 'ltr'}>
          <DialogHeader>
            <DialogTitle>{t('team.addMember')}</DialogTitle>
            <DialogDescription>{t('team.pickContactDescription')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {/* Contact picker — filtered to contacts not already on the team */}
            {(() => {
              const onTeamIds = new Set(teamContacts.map(tc => tc.contactId));
              const eligible = availableContacts.filter(c => !onTeamIds.has(c.id));
              if (eligible.length === 0) {
                return (
                  <div className="rounded-md border p-4 text-center space-y-3 bg-muted/30">
                    <p className="text-sm text-muted-foreground">{t('team.noContactsAvailable')}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setShowTeamContactModal(false);
                        setActiveFeature('contacts');
                      }}
                    >
                      {t('team.goToContacts')}
                    </Button>
                  </div>
                );
              }
              return (
                <div className="space-y-2">
                  <Label>{t('team.pickContact')} *</Label>
                  <Select
                    value={teamContactForm.contactId || undefined}
                    onValueChange={(value) => setTeamContactForm(prev => ({ ...prev, contactId: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('team.pickContactPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {eligible.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                          {c.role && (
                            <span className="text-muted-foreground text-xs ms-2">
                              · {t(`team.roles.${c.role}`)}
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => {
                      setShowTeamContactModal(false);
                      setActiveFeature('contacts');
                    }}
                  >
                    {t('team.createNewContact')}
                  </Button>
                </div>
              );
            })()}

            {/* Per-program role override */}
            <div className="space-y-2">
              <Label>{t('team.programRoleOverride')}</Label>
              <Select
                value={teamContactForm.programRole || undefined}
                onValueChange={(value: TeamMemberRole) =>
                  setTeamContactForm(prev => ({ ...prev, programRole: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('team.programRoleOverridePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="parent_guardian">{t('team.roles.parent_guardian')}</SelectItem>
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

            {/* Responsibilities — newline-separated list */}
            <div className="space-y-2">
              <Label>{t('team.responsibilities')}</Label>
              <Textarea
                value={teamContactForm.responsibilities}
                onChange={(e) => setTeamContactForm(prev => ({ ...prev, responsibilities: e.target.value }))}
                placeholder={t('team.responsibilitiesPlaceholder')}
                className="min-h-[60px]"
              />
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="isCoordinator"
                checked={teamContactForm.isCoordinator}
                onCheckedChange={(checked) =>
                  setTeamContactForm(prev => ({ ...prev, isCoordinator: !!checked }))
                }
              />
              <Label htmlFor="isCoordinator" className="text-sm font-normal">
                {t('team.isCoordinator')}
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTeamContactModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (!teamContactForm.contactId) {
                  toast({ title: t('common.error'), description: t('team.pickContactRequired'), variant: 'destructive' });
                  return;
                }
                const responsibilities = teamContactForm.responsibilities
                  .split('\n')
                  .map(s => s.trim())
                  .filter(Boolean);
                addTeamContactMutation.mutate({
                  contactId: teamContactForm.contactId,
                  programRole: teamContactForm.programRole || undefined,
                  responsibilities: responsibilities.length > 0 ? responsibilities : undefined,
                  isCoordinator: teamContactForm.isCoordinator,
                });
              }}
              disabled={addTeamContactMutation.isPending}
            >
              {addTeamContactMutation.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('team.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}