// src/features/StudentProgressPanel.tsx
// Panel showing student progress - TalaProcess (Israel) or US_IEP_Process (US)

import { useState, useEffect, useCallback } from 'react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
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
  ChevronRight,
  ChevronLeft,
  Activity,
  Target,
  FileCheck,
  Save,
  Sparkles,
  BarChart,
  Brain,
  Trash2,
  Edit,
  Loader2,
  AlertCircle,
} from 'lucide-react';

interface StudentProgressPanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

type SystemType = 'tala' | 'us_iep';
type PhaseStatus = 'pending' | 'in-progress' | 'completed' | 'locked';

interface Phase {
  id: string;
  phaseId: string;
  phaseName: string;
  phaseOrder: number;
  status: PhaseStatus;
  dueDate?: string;
  completedAt?: string;
  notes?: string;
}

interface Goal {
  id: string;
  title: string;
  description?: string;
  goalType?: string;
  targetBehavior?: string;
  criteria?: string;
  criteriaPercentage?: number;
  measurementMethod?: string;
  conditions?: string;
  relevance?: string;
  targetDate?: string;
  status: string;
  progress: number;
  phaseId?: string;
  baselineData?: Record<string, any>;
}

interface ComplianceItem {
  id: string;
  itemKey: string;
  itemLabel: string;
  isCompleted: boolean;
  completedAt?: string;
  notes?: string;
}

interface ServiceRecommendation {
  id: string;
  serviceName: string;
  serviceType: string;
  durationMinutes: number;
  frequency: string;
  frequencyCount: number;
  provider?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  isActive: boolean;
}

interface BaselineMetrics {
  mlu: number | null;
  communicationRate: number | null;
  intelligibility: number | null;
  additionalMetrics: Record<string, any>;
}

interface ProgressData {
  phases: Phase[];
  goals: Goal[];
  complianceItems: ComplianceItem[];
  serviceRecommendations: ServiceRecommendation[];
  recentProgress: any[];
  overallProgress: number;
  compliancePercentage: number;
}

// Default empty goal for the form
const emptyGoal: Partial<Goal> = {
  title: '',
  description: '',
  goalType: 'communication',
  targetBehavior: '',
  criteria: '',
  criteriaPercentage: 80,
  measurementMethod: '',
  conditions: '',
  relevance: '',
  targetDate: undefined, // Use undefined, not empty string - avoids date parsing errors
  status: 'draft',
  progress: 0,
};

// Default empty service for the form
const emptyService: Partial<ServiceRecommendation> = {
  serviceName: '',
  serviceType: 'direct',
  durationMinutes: 30,
  frequency: 'weekly',
  frequencyCount: 1,
  provider: '',
  location: '',
};

export function StudentProgressPanel({ isOpen, onClose }: StudentProgressPanelProps) {
  const { t, isRTL, language } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { user } = useAuth();
  const { student } = useStudent();
  const { setActiveFeature, registerMetadataBuilder, unregisterMetadataBuilder } = useFeaturePanel();
  const { sharedState } = useSharedState();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Modal states
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [showBaselineModal, setShowBaselineModal] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [editingService, setEditingService] = useState<ServiceRecommendation | null>(null);
  
  // Form states
  const [goalForm, setGoalForm] = useState<Partial<Goal>>(emptyGoal);
  const [serviceForm, setServiceForm] = useState<Partial<ServiceRecommendation>>(emptyService);
  const [baselineForm, setBaselineForm] = useState({
    mlu: '',
    communicationRate: '',
    intelligibility: '',
  });

  // Determine system type from student data
  const systemType: SystemType = (student as any)?.systemType || 
    ((student as any)?.country === 'US' ? 'us_iep' : 'tala');

  // Fetch student progress data
  const { data: progressData, isLoading, error, refetch } = useQuery({
    queryKey: ['/api/students', student?.id, 'progress'],
    queryFn: async () => {
      if (!student?.id) throw new Error('No student selected');
      const response = await apiRequest('GET', `/api/students/${student.id}/progress`);
      return response.json();
    },
    enabled: !!student?.id && isOpen,
  });

  // Initialize progress mutation
  const initializeProgressMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/students/${student?.id}/initialize-progress`, {
        systemType,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ title: language === 'he' ? 'התקדמות אותחלה' : 'Progress initialized' });
    },
    onError: (error: any) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Update phase mutation
  const updatePhaseMutation = useMutation({
    mutationFn: async ({ phaseId, updates }: { phaseId: string; updates: any }) => {
      const response = await apiRequest('PATCH', `/api/phases/${phaseId}`, updates);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to update phase');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ 
        title: language === 'he' ? 'הצלחה' : 'Success',
        description: language === 'he' ? 'שלב עודכן בהצלחה' : 'Phase updated successfully',
      });
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה בעדכון שלב: ${error.message}` : `Failed to update phase: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Advance phase mutation
  const advancePhaseMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/students/${student?.id}/advance-phase`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to advance phase');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ 
        title: language === 'he' ? 'הצלחה' : 'Success',
        description: language === 'he' ? 'עברת לשלב הבא בהצלחה' : 'Advanced to next phase successfully',
      });
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה במעבר לשלב הבא: ${error.message}` : `Failed to advance: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Create goal mutation
  const createGoalMutation = useMutation({
    mutationFn: async (goalData: any) => {
      const response = await apiRequest('POST', `/api/students/${student?.id}/goals`, goalData);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create goal');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ 
        title: language === 'he' ? 'הצלחה' : 'Success',
        description: language === 'he' ? 'מטרה נוצרה בהצלחה' : 'Goal created successfully',
      });
      setShowGoalModal(false);
      setGoalForm(emptyGoal);
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה ביצירת מטרה: ${error.message}` : `Failed to create goal: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Update goal mutation
  const updateGoalMutation = useMutation({
    mutationFn: async ({ goalId, updates }: { goalId: string; updates: any }) => {
      const response = await apiRequest('PATCH', `/api/goals/${goalId}`, updates);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to update goal');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ 
        title: language === 'he' ? 'הצלחה' : 'Success',
        description: language === 'he' ? 'מטרה עודכנה בהצלחה' : 'Goal updated successfully',
      });
      setShowGoalModal(false);
      setEditingGoal(null);
      setGoalForm(emptyGoal);
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה בעדכון מטרה: ${error.message}` : `Failed to update goal: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Delete goal mutation
  const deleteGoalMutation = useMutation({
    mutationFn: async (goalId: string) => {
      const response = await apiRequest('DELETE', `/api/goals/${goalId}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to delete goal');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ 
        title: language === 'he' ? 'הצלחה' : 'Success',
        description: language === 'he' ? 'מטרה נמחקה בהצלחה' : 'Goal deleted successfully',
      });
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה במחיקת מטרה: ${error.message}` : `Failed to delete goal: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Update compliance item mutation
  const updateComplianceMutation = useMutation({
    mutationFn: async ({ itemId, isCompleted }: { itemId: string; isCompleted: boolean }) => {
      const response = await apiRequest('PATCH', `/api/compliance/${itemId}`, { isCompleted });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to update compliance');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה בעדכון: ${error.message}` : `Failed to update: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Create service recommendation mutation
  const createServiceMutation = useMutation({
    mutationFn: async (serviceData: any) => {
      const response = await apiRequest('POST', `/api/students/${student?.id}/services`, serviceData);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create service');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ 
        title: language === 'he' ? 'הצלחה' : 'Success',
        description: language === 'he' ? 'המלצת שירות נוספה בהצלחה' : 'Service added successfully',
      });
      setShowServiceModal(false);
      setServiceForm(emptyService);
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה בהוספת שירות: ${error.message}` : `Failed to add service: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Update service recommendation mutation
  const updateServiceMutation = useMutation({
    mutationFn: async ({ serviceId, updates }: { serviceId: string; updates: any }) => {
      const response = await apiRequest('PATCH', `/api/services/${serviceId}`, updates);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to update service');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ 
        title: language === 'he' ? 'הצלחה' : 'Success',
        description: language === 'he' ? 'שירות עודכן בהצלחה' : 'Service updated successfully',
      });
      setShowServiceModal(false);
      setEditingService(null);
      setServiceForm(emptyService);
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה בעדכון שירות: ${error.message}` : `Failed to update service: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Delete service recommendation mutation
  const deleteServiceMutation = useMutation({
    mutationFn: async (serviceId: string) => {
      const response = await apiRequest('DELETE', `/api/services/${serviceId}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to delete service');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ 
        title: language === 'he' ? 'הצלחה' : 'Success',
        description: language === 'he' ? 'שירות הוסר בהצלחה' : 'Service removed successfully',
      });
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה בהסרת שירות: ${error.message}` : `Failed to remove service: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Record baseline metrics mutation
  const recordBaselineMutation = useMutation({
    mutationFn: async (metrics: any) => {
      const response = await apiRequest('POST', `/api/students/${student?.id}/baseline`, { metrics });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to save baseline');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students', student?.id, 'progress'] });
      toast({ 
        title: language === 'he' ? 'הצלחה' : 'Success',
        description: language === 'he' ? 'נתוני בסיס נשמרו בהצלחה' : 'Baseline metrics saved successfully',
      });
      setShowBaselineModal(false);
      setBaselineForm({ mlu: '', communicationRate: '', intelligibility: '' });
    },
    onError: (error: Error) => {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? `שגיאה בשמירת נתוני בסיס: ${error.message}` : `Failed to save baseline: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  // Register metadata builder
  const buildProgressMetadata = useCallback(() => {
    return {
      studentId: student?.id,
      systemType,
      currentPhase: progressData?.progress?.phases?.find((p: Phase) => p.status === 'in-progress')?.phaseName,
    };
  }, [student?.id, systemType, progressData]);

  useEffect(() => {
    registerMetadataBuilder('progress', buildProgressMetadata);
    return () => unregisterMetadataBuilder('progress');
  }, [registerMetadataBuilder, unregisterMetadataBuilder, buildProgressMetadata]);

  // Extract data from API response
  const progress: ProgressData = progressData?.progress || {
    phases: [],
    goals: [],
    complianceItems: [],
    serviceRecommendations: [],
    recentProgress: [],
    overallProgress: 0,
    compliancePercentage: 0,
  };
  const phases = progress.phases;
  const goals = progress.goals;
  const complianceItems = progress.complianceItems;
  const serviceRecommendations = progress.serviceRecommendations;
  const baselineMetrics: BaselineMetrics = progressData?.baselineMetrics || {
    mlu: null,
    communicationRate: null,
    intelligibility: null,
    additionalMetrics: {},
  };
  const overallProgress = progress.overallProgress;
  const currentPhase = phases.find(p => p.status === 'in-progress');

  // Navigate back to students
  const handleBackClick = () => {
    setActiveFeature('students');
  };

  // Helper function to sanitize form data - convert empty strings to null for optional fields
  const sanitizeFormData = (data: Record<string, any>): Record<string, any> => {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === '' || value === undefined) {
        // Don't include empty strings - let server use defaults or null
        continue;
      } else if (typeof value === 'string' && value.trim() === '') {
        continue;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  };

  // Handle goal form submission
  const handleGoalSubmit = () => {
    // Validate required fields
    if (!goalForm.title?.trim()) {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? 'נדרש כותרת למטרה' : 'Goal title is required',
        variant: 'destructive',
      });
      return;
    }

    // Validate criteriaPercentage if provided
    if (goalForm.criteriaPercentage !== undefined && 
        (goalForm.criteriaPercentage < 0 || goalForm.criteriaPercentage > 100)) {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? 'אחוז יעד חייב להיות בין 0 ל-100' : 'Target percentage must be between 0 and 100',
        variant: 'destructive',
      });
      return;
    }

    // Sanitize form data - remove empty strings to avoid date parsing errors
    const sanitizedForm = sanitizeFormData(goalForm);
    
    const goalData = {
      ...sanitizedForm,
      phaseId: currentPhase?.id || null,
    };

    if (editingGoal) {
      updateGoalMutation.mutate({ goalId: editingGoal.id, updates: goalData });
    } else {
      createGoalMutation.mutate(goalData);
    }
  };

  // Handle service form submission
  const handleServiceSubmit = () => {
    // Validate required fields
    if (!serviceForm.serviceName?.trim()) {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? 'נדרש שם שירות' : 'Service name is required',
        variant: 'destructive',
      });
      return;
    }

    if (!serviceForm.durationMinutes || serviceForm.durationMinutes < 1) {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? 'נדרש משך זמן תקין' : 'Valid duration is required',
        variant: 'destructive',
      });
      return;
    }

    // Sanitize form data
    const sanitizedForm = sanitizeFormData(serviceForm);

    if (editingService) {
      updateServiceMutation.mutate({ serviceId: editingService.id, updates: sanitizedForm });
    } else {
      createServiceMutation.mutate(sanitizedForm);
    }
  };

  // Handle baseline form submission
  const handleBaselineSubmit = () => {
    // Validate at least one metric is provided
    if (!baselineForm.mlu && !baselineForm.communicationRate && !baselineForm.intelligibility) {
      toast({ 
        title: language === 'he' ? 'שגיאה' : 'Error',
        description: language === 'he' ? 'נדרש לפחות מדד אחד' : 'At least one metric is required',
        variant: 'destructive',
      });
      return;
    }

    const metrics: Record<string, number> = {};
    if (baselineForm.mlu) {
      const mluValue = parseFloat(baselineForm.mlu);
      if (isNaN(mluValue) || mluValue < 0) {
        toast({ 
          title: language === 'he' ? 'שגיאה' : 'Error',
          description: language === 'he' ? 'ערך MLU לא תקין' : 'Invalid MLU value',
          variant: 'destructive',
        });
        return;
      }
      metrics.mlu = mluValue;
    }
    if (baselineForm.communicationRate) {
      const rateValue = parseInt(baselineForm.communicationRate);
      if (isNaN(rateValue) || rateValue < 0) {
        toast({ 
          title: language === 'he' ? 'שגיאה' : 'Error',
          description: language === 'he' ? 'ערך קצב תקשורת לא תקין' : 'Invalid communication rate',
          variant: 'destructive',
        });
        return;
      }
      metrics.communicationRate = rateValue;
    }
    if (baselineForm.intelligibility) {
      const intValue = parseFloat(baselineForm.intelligibility);
      if (isNaN(intValue) || intValue < 0 || intValue > 100) {
        toast({ 
          title: language === 'he' ? 'שגיאה' : 'Error',
          description: language === 'he' ? 'אחוז מובנות חייב להיות בין 0 ל-100' : 'Intelligibility must be between 0 and 100',
          variant: 'destructive',
        });
        return;
      }
      metrics.intelligibility = intValue / 100;
    }

    recordBaselineMutation.mutate(metrics);
  };

  // Open goal modal for editing
  const handleEditGoal = (goal: Goal) => {
    setEditingGoal(goal);
    setGoalForm({
      title: goal.title,
      description: goal.description,
      goalType: goal.goalType,
      targetBehavior: goal.targetBehavior,
      criteria: goal.criteria,
      criteriaPercentage: goal.criteriaPercentage,
      measurementMethod: goal.measurementMethod,
      conditions: goal.conditions,
      relevance: goal.relevance,
      targetDate: goal.targetDate,
      status: goal.status,
      progress: goal.progress,
    });
    setShowGoalModal(true);
  };

  // Open service modal for editing
  const handleEditService = (service: ServiceRecommendation) => {
    setEditingService(service);
    setServiceForm({
      serviceName: service.serviceName,
      serviceType: service.serviceType,
      durationMinutes: service.durationMinutes,
      frequency: service.frequency,
      frequencyCount: service.frequencyCount,
      provider: service.provider,
      location: service.location,
    });
    setShowServiceModal(true);
  };

  if (!isOpen) return null;

  if (!student) {
    return (
      <div className={cn(
        'flex items-center justify-center h-full',
        isDark ? 'bg-slate-950 text-slate-400' : 'bg-gray-50 text-slate-600'
      )}>
        <div className="text-center">
          <p className="text-lg">{language === 'he' ? 'לא נבחר תלמיד' : 'No student selected'}</p>
          <Button className="mt-4" onClick={handleBackClick}>
            {t('common.back') || 'Back to Students'}
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={cn(
        'flex items-center justify-center h-full',
        isDark ? 'bg-slate-950' : 'bg-gray-50'
      )}>
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Show initialize button if no phases exist
  if (phases.length === 0) {
    return (
      <div className={cn(
        'flex flex-col h-full min-h-0',
        isDark ? 'bg-slate-950' : 'bg-gray-50'
      )}>
        <div className="p-6">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-muted-foreground hover:text-foreground mb-4"
            onClick={handleBackClick}
          >
            {isRTL ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
            {t('common.back') || 'Back'}
          </Button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Card className="max-w-md mx-4">
            <CardHeader className="text-center">
              <CardTitle>{language === 'he' ? 'התחל מעקב התקדמות' : 'Start Progress Tracking'}</CardTitle>
              <CardDescription>
                {language === 'he' 
                  ? `אתחל תהליך ${systemType === 'tala' ? 'תל״א' : 'IEP'} עבור ${student?.name}`
                  : `Initialize ${systemType === 'tala' ? 'Tala' : 'IEP'} process for ${student?.name}`}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <Button 
                onClick={() => initializeProgressMutation.mutate()}
                disabled={initializeProgressMutation.isPending}
                className="gap-2"
              >
                {initializeProgressMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {language === 'he' ? 'התחל עכשיו' : 'Start Now'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Goal Modal
  const GoalModal = (
    <Dialog open={showGoalModal} onOpenChange={setShowGoalModal}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editingGoal 
              ? (language === 'he' ? 'עריכת מטרה' : 'Edit Goal')
              : (language === 'he' ? 'מטרה חדשה' : 'New Goal')}
          </DialogTitle>
          <DialogDescription>
            {language === 'he' 
              ? 'הגדר מטרה SMART למעקב התקדמות'
              : 'Define a SMART goal for progress tracking'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="space-y-2">
            <Label>{language === 'he' ? 'כותרת (חובה)' : 'Title (Required)'}</Label>
            <Input
              value={goalForm.title || ''}
              onChange={(e) => setGoalForm(prev => ({ ...prev, title: e.target.value }))}
              placeholder={language === 'he' ? 'לדוגמה: שיפור תקשורת' : 'e.g., Improve communication'}
            />
          </div>

          <div className="space-y-2">
            <Label>{language === 'he' ? 'תיאור' : 'Description'}</Label>
            <Textarea
              value={goalForm.description || ''}
              onChange={(e) => setGoalForm(prev => ({ ...prev, description: e.target.value }))}
              placeholder={language === 'he' ? 'תיאור המטרה...' : 'Goal description...'}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{language === 'he' ? 'סוג מטרה' : 'Goal Type'}</Label>
              <Select
                value={goalForm.goalType || 'communication'}
                onValueChange={(value) => setGoalForm(prev => ({ ...prev, goalType: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="communication">{language === 'he' ? 'תקשורת' : 'Communication'}</SelectItem>
                  <SelectItem value="behavioral">{language === 'he' ? 'התנהגות' : 'Behavioral'}</SelectItem>
                  <SelectItem value="academic">{language === 'he' ? 'לימודי' : 'Academic'}</SelectItem>
                  <SelectItem value="general">{language === 'he' ? 'כללי' : 'General'}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{language === 'he' ? 'אחוז יעד' : 'Target Percentage'}</Label>
              <Input
                type="number"
                min="0"
                max="100"
                value={goalForm.criteriaPercentage || 80}
                onChange={(e) => setGoalForm(prev => ({ ...prev, criteriaPercentage: parseInt(e.target.value) }))}
              />
            </div>
          </div>

          {systemType === 'us_iep' && (
            <>
              <Separator />
              <p className="text-sm font-medium text-muted-foreground">
                {language === 'he' ? 'שדות SMART' : 'SMART Fields'}
              </p>

              <div className="space-y-2">
                <Label>{language === 'he' ? 'התנהגות יעד (Specific)' : 'Target Behavior (Specific)'}</Label>
                <Input
                  value={goalForm.targetBehavior || ''}
                  onChange={(e) => setGoalForm(prev => ({ ...prev, targetBehavior: e.target.value }))}
                  placeholder={language === 'he' ? 'מה התלמיד יבצע' : 'What the student will do'}
                />
              </div>

              <div className="space-y-2">
                <Label>{language === 'he' ? 'שיטת מדידה (Measurable)' : 'Measurement Method'}</Label>
                <Input
                  value={goalForm.measurementMethod || ''}
                  onChange={(e) => setGoalForm(prev => ({ ...prev, measurementMethod: e.target.value }))}
                  placeholder={language === 'he' ? 'לדוגמה: איסוף נתונים' : 'e.g., SLP data collection'}
                />
              </div>

              <div className="space-y-2">
                <Label>{language === 'he' ? 'תנאים (Achievable)' : 'Conditions'}</Label>
                <Input
                  value={goalForm.conditions || ''}
                  onChange={(e) => setGoalForm(prev => ({ ...prev, conditions: e.target.value }))}
                  placeholder={language === 'he' ? 'בהינתן...' : 'Given...'}
                />
              </div>

              <div className="space-y-2">
                <Label>{language === 'he' ? 'רלוונטיות (Relevant)' : 'Relevance'}</Label>
                <Textarea
                  value={goalForm.relevance || ''}
                  onChange={(e) => setGoalForm(prev => ({ ...prev, relevance: e.target.value }))}
                  placeholder={language === 'he' ? 'השפעה על תוכנית הלימודים' : 'Curriculum impact'}
                />
              </div>

              <div className="space-y-2">
                <Label>{language === 'he' ? 'תאריך יעד (Time-bound)' : 'Target Date'}</Label>
                <Input
                  type="date"
                  value={goalForm.targetDate || ''}
                  onChange={(e) => setGoalForm(prev => ({ 
                    ...prev, 
                    targetDate: e.target.value || undefined // Convert empty string to undefined
                  }))}
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => {
            setShowGoalModal(false);
            setEditingGoal(null);
            setGoalForm(emptyGoal);
          }}>
            {language === 'he' ? 'ביטול' : 'Cancel'}
          </Button>
          <Button 
            onClick={handleGoalSubmit}
            disabled={createGoalMutation.isPending || updateGoalMutation.isPending}
          >
            {(createGoalMutation.isPending || updateGoalMutation.isPending) && (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            )}
            {editingGoal 
              ? (language === 'he' ? 'עדכון' : 'Update')
              : (language === 'he' ? 'צור מטרה' : 'Create Goal')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Service Modal
  const ServiceModal = (
    <Dialog open={showServiceModal} onOpenChange={setShowServiceModal}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {editingService 
              ? (language === 'he' ? 'עריכת שירות' : 'Edit Service')
              : (language === 'he' ? 'המלצת שירות חדשה' : 'New Service Recommendation')}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="space-y-2">
            <Label>{language === 'he' ? 'שם השירות' : 'Service Name'}</Label>
            <Input
              value={serviceForm.serviceName || ''}
              onChange={(e) => setServiceForm(prev => ({ ...prev, serviceName: e.target.value }))}
              placeholder={language === 'he' ? 'לדוגמה: טיפול בדיבור' : 'e.g., Speech-Language'}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{language === 'he' ? 'סוג' : 'Type'}</Label>
              <Select
                value={serviceForm.serviceType || 'direct'}
                onValueChange={(value) => setServiceForm(prev => ({ ...prev, serviceType: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">{language === 'he' ? 'ישיר' : 'Direct'}</SelectItem>
                  <SelectItem value="consultation">{language === 'he' ? 'ייעוץ' : 'Consultation'}</SelectItem>
                  <SelectItem value="monitoring">{language === 'he' ? 'ניטור' : 'Monitoring'}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{language === 'he' ? 'משך (דקות)' : 'Duration (min)'}</Label>
              <Input
                type="number"
                min="5"
                step="5"
                value={serviceForm.durationMinutes || 30}
                onChange={(e) => setServiceForm(prev => ({ ...prev, durationMinutes: parseInt(e.target.value) }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{language === 'he' ? 'תדירות' : 'Frequency'}</Label>
              <Select
                value={serviceForm.frequency || 'weekly'}
                onValueChange={(value) => setServiceForm(prev => ({ ...prev, frequency: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">{language === 'he' ? 'שבועי' : 'Weekly'}</SelectItem>
                  <SelectItem value="bi-weekly">{language === 'he' ? 'דו-שבועי' : 'Bi-weekly'}</SelectItem>
                  <SelectItem value="monthly">{language === 'he' ? 'חודשי' : 'Monthly'}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{language === 'he' ? 'מספר פעמים' : 'Times per period'}</Label>
              <Input
                type="number"
                min="1"
                value={serviceForm.frequencyCount || 1}
                onChange={(e) => setServiceForm(prev => ({ ...prev, frequencyCount: parseInt(e.target.value) }))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{language === 'he' ? 'ספק/נותן שירות' : 'Provider'}</Label>
            <Input
              value={serviceForm.provider || ''}
              onChange={(e) => setServiceForm(prev => ({ ...prev, provider: e.target.value }))}
              placeholder={language === 'he' ? 'שם הספק' : 'Provider name'}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => {
            setShowServiceModal(false);
            setEditingService(null);
            setServiceForm(emptyService);
          }}>
            {language === 'he' ? 'ביטול' : 'Cancel'}
          </Button>
          <Button 
            onClick={handleServiceSubmit}
            disabled={createServiceMutation.isPending || updateServiceMutation.isPending}
          >
            {(createServiceMutation.isPending || updateServiceMutation.isPending) && (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            )}
            {editingService 
              ? (language === 'he' ? 'עדכון' : 'Update')
              : (language === 'he' ? 'הוסף שירות' : 'Add Service')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Baseline Modal
  const BaselineModal = (
    <Dialog open={showBaselineModal} onOpenChange={setShowBaselineModal}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{language === 'he' ? 'נתוני בסיס' : 'Baseline Metrics'}</DialogTitle>
          <DialogDescription>
            {language === 'he' ? 'הזן נתוני בסיס להערכה' : 'Enter baseline assessment data'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="space-y-2">
            <Label>MLU (Mean Length of Utterance)</Label>
            <Input
              type="number"
              step="0.1"
              min="0"
              max="10"
              value={baselineForm.mlu}
              onChange={(e) => setBaselineForm(prev => ({ ...prev, mlu: e.target.value }))}
              placeholder="e.g., 3.2"
            />
          </div>

          <div className="space-y-2">
            <Label>{language === 'he' ? 'קצב תקשורת (פעולות/10 דק׳)' : 'Communication Rate (acts/10min)'}</Label>
            <Input
              type="number"
              min="0"
              value={baselineForm.communicationRate}
              onChange={(e) => setBaselineForm(prev => ({ ...prev, communicationRate: e.target.value }))}
              placeholder="e.g., 12"
            />
          </div>

          <div className="space-y-2">
            <Label>{language === 'he' ? 'מובנות (%)' : 'Intelligibility (%)'}</Label>
            <Input
              type="number"
              min="0"
              max="100"
              value={baselineForm.intelligibility}
              onChange={(e) => setBaselineForm(prev => ({ ...prev, intelligibility: e.target.value }))}
              placeholder="e.g., 75"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowBaselineModal(false)}>
            {language === 'he' ? 'ביטול' : 'Cancel'}
          </Button>
          <Button 
            onClick={handleBaselineSubmit}
            disabled={recordBaselineMutation.isPending}
          >
            {recordBaselineMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {language === 'he' ? 'שמור' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Render US IEP Process
  if (systemType === 'us_iep') {
    return (
      <div className={cn(
        'flex flex-col h-full min-h-0',
        isDark ? 'bg-slate-950' : 'bg-gray-50'
      )}>
        {GoalModal}
        {ServiceModal}
        {BaselineModal}
        
        <ScrollArea className="flex-1">
          <div className="p-6 space-y-4">
            {/* Header */}
            <div className="mb-2">
              <Button
                variant="ghost"
                size="sm"
                className={cn('gap-2 text-muted-foreground hover:text-foreground mb-4', isRTL ? 'pr-0' : 'pl-0')}
                onClick={handleBackClick}
              >
                {isRTL ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
                {t('common.back') || 'Back'}
              </Button>
              <div className={cn('flex justify-between items-start', isRTL && 'flex-row-reverse')}>
                <div className={isRTL ? 'text-right' : ''}>
                  <div className={cn('flex items-center gap-2 mb-2', isRTL && 'flex-row-reverse justify-end')}>
                    <h1 className={cn('text-2xl font-bold', isDark ? 'text-white' : 'text-slate-900')}>
                      {student?.name}
                    </h1>
                    <Badge variant="outline" className="text-sm font-normal text-muted-foreground">
                      IEP Documentation
                    </Badge>
                  </div>
                  <div className={cn('flex items-center gap-3 text-muted-foreground text-sm', isRTL && 'flex-row-reverse')}>
                    {(student as any)?.school && (
                      <Badge variant="outline" className="rounded-sm px-2 font-normal bg-background">
                        {(student as any).school}
                      </Badge>
                    )}
                    <span className="w-1 h-1 bg-muted-foreground/40 rounded-full" />
                    <span>ID: {(student as any)?.idNumber || student?.id.slice(0, 8)}</span>
                    {currentPhase?.dueDate && (
                      <>
                        <span className="w-1 h-1 bg-muted-foreground/40 rounded-full" />
                        <span>
                          IEP Due: <span className="text-amber-600 font-medium">{currentPhase.dueDate}</span>
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className={cn('flex gap-2', isRTL && 'flex-row-reverse')}>
                  <Button variant="outline" size="sm" className="gap-2">
                    <FileCheck className="w-4 h-4" /> Export
                  </Button>
                </div>
              </div>
            </div>

            {/* Main Content Grid */}
            <div className="grid grid-cols-12 gap-6 min-h-[600px]">
              {/* Left Panel: PLAAFP Baseline Data */}
              <div className="col-span-3 space-y-4 flex flex-col">
                <Card className={cn(
                  'flex-1 border-l-4 border-l-blue-500',
                  isDark ? 'bg-slate-900/50' : 'bg-slate-50/50'
                )}>
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-center">
                      <CardTitle className={cn(
                        'text-sm font-bold uppercase tracking-wider flex items-center gap-2',
                        isDark ? 'text-slate-400' : 'text-slate-500'
                      )}>
                        <Activity className="w-4 h-4" />
                        PLAAFP Baseline
                      </CardTitle>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 w-8 p-0"
                        onClick={() => setShowBaselineModal(true)}
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {/* Quantitative Metrics */}
                    <div className="space-y-4">
                      <div className={cn(
                        'p-3 rounded-lg border shadow-sm',
                        isDark ? 'bg-slate-800 border-slate-700' : 'bg-white'
                      )}>
                        <p className="text-xs text-muted-foreground mb-1">Mean Length of Utterance (MLU)</p>
                        <div className="flex items-end justify-between">
                          <span className="text-3xl font-bold text-blue-600">
                            {baselineMetrics.mlu?.toFixed(1) || '—'}
                          </span>
                        </div>
                        <div className={cn(
                          'h-1 w-full mt-2 rounded-full overflow-hidden',
                          isDark ? 'bg-slate-700' : 'bg-slate-100'
                        )}>
                          <div className="h-full bg-blue-500" style={{ width: `${(baselineMetrics.mlu || 0) * 20}%` }} />
                        </div>
                      </div>

                      <div className={cn(
                        'p-3 rounded-lg border shadow-sm',
                        isDark ? 'bg-slate-800 border-slate-700' : 'bg-white'
                      )}>
                        <p className="text-xs text-muted-foreground mb-1">Communication Rate</p>
                        <div className="flex items-end justify-between">
                          <span className="text-3xl font-bold text-indigo-600">
                            {baselineMetrics.communicationRate || '—'}
                          </span>
                          <span className="text-xs text-slate-400">acts/10min</span>
                        </div>
                      </div>

                      <div className={cn(
                        'p-3 rounded-lg border shadow-sm',
                        isDark ? 'bg-slate-800 border-slate-700' : 'bg-white'
                      )}>
                        <p className="text-xs text-muted-foreground mb-1">Intelligibility</p>
                        <div className="flex items-end justify-between">
                          <span className="text-3xl font-bold text-teal-600">
                            {baselineMetrics.intelligibility ? `${Math.round(baselineMetrics.intelligibility * 100)}%` : '—'}
                          </span>
                          <span className="text-xs text-slate-400">Context Known</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Center Panel: Goals */}
              <div className="col-span-6 flex flex-col space-y-4">
                <Card className={cn(
                  'flex-1 border-2 shadow-md',
                  isDark ? 'border-blue-900' : 'border-blue-100'
                )}>
                  <CardHeader className={cn(
                    'pb-4',
                    isDark ? 'bg-blue-950/20' : 'bg-blue-50/50'
                  )}>
                    <div className={cn('flex justify-between items-center', isRTL && 'flex-row-reverse')}>
                      <CardTitle className={cn(
                        'text-xl flex items-center gap-2',
                        isDark ? 'text-blue-100' : 'text-blue-900'
                      )}>
                        <Target className="w-5 h-5 text-blue-600" />
                        SMART Goals
                      </CardTitle>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        onClick={() => {
                          setEditingGoal(null);
                          setGoalForm(emptyGoal);
                          setShowGoalModal(true);
                        }}
                      >
                        <Plus className="w-4 h-4" />
                        Add Goal
                      </Button>
                    </div>
                    <CardDescription>
                      {currentPhase?.phaseName || 'IEP Development'}
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-4 pt-6 overflow-y-auto max-h-[calc(100vh-350px)]">
                    {goals.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <Target className="w-12 h-12 mx-auto mb-4 opacity-50" />
                        <p>No goals defined yet</p>
                        <Button 
                          variant="outline" 
                          className="mt-4"
                          onClick={() => {
                            setEditingGoal(null);
                            setGoalForm(emptyGoal);
                            setShowGoalModal(true);
                          }}
                        >
                          <Plus className="w-4 h-4 mr-2" />
                          Create First Goal
                        </Button>
                      </div>
                    ) : (
                      goals.map((goal) => (
                        <div
                          key={goal.id}
                          className={cn(
                            'p-4 rounded-lg border',
                            isDark ? 'bg-slate-800/50 border-slate-700' : 'bg-secondary/50 border-border'
                          )}
                        >
                          <div className="flex justify-between items-start mb-2">
                            <h4 className="font-semibold flex items-center gap-2">
                              <FileText className="w-4 h-4 text-muted-foreground" />
                              {goal.title}
                            </h4>
                            <div className="flex gap-1">
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="h-8 w-8 p-0"
                                onClick={() => handleEditGoal(goal)}
                              >
                                <Edit className="w-4 h-4" />
                              </Button>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                                onClick={() => deleteGoalMutation.mutate(goal.id)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                          {goal.description && (
                            <p className="text-sm text-muted-foreground mb-3">
                              {goal.description}
                            </p>
                          )}
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <Badge variant="secondary">{goal.status}</Badge>
                            {goal.criteriaPercentage && (
                              <span>Target: {goal.criteriaPercentage}%</span>
                            )}
                            {goal.targetDate && (
                              <span>Due: {goal.targetDate}</span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Right Panel: Compliance & Services */}
              <div className="col-span-3 space-y-4">
                {/* Compliance Checklist */}
                <Card className={cn(
                  isDark ? 'bg-slate-900/50' : 'bg-slate-50/50'
                )}>
                  <CardHeader className="pb-2">
                    <CardTitle className={cn(
                      'text-sm font-bold uppercase tracking-wider flex items-center gap-2',
                      isDark ? 'text-slate-400' : 'text-slate-500'
                    )}>
                      <FileCheck className="w-4 h-4" />
                      Compliance
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {complianceItems.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No compliance items
                      </p>
                    ) : (
                      complianceItems.map((item) => (
                        <div key={item.id} className="flex items-center space-x-2">
                          <Checkbox
                            id={item.id}
                            checked={item.isCompleted}
                            onCheckedChange={(checked) => {
                              updateComplianceMutation.mutate({
                                itemId: item.id,
                                isCompleted: checked as boolean,
                              });
                            }}
                          />
                          <Label
                            htmlFor={item.id}
                            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                          >
                            {item.itemLabel}
                          </Label>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>

                {/* Service Recommendations */}
                <Card className={cn(
                  isDark ? 'bg-slate-900/50' : 'bg-slate-50/50'
                )}>
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-center">
                      <CardTitle className={cn(
                        'text-sm font-bold uppercase tracking-wider',
                        isDark ? 'text-slate-400' : 'text-slate-500'
                      )}>
                        Services
                      </CardTitle>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 w-8 p-0"
                        onClick={() => {
                          setEditingService(null);
                          setServiceForm(emptyService);
                          setShowServiceModal(true);
                        }}
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {serviceRecommendations.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No services defined
                      </p>
                    ) : (
                      serviceRecommendations.map((service) => (
                        <div
                          key={service.id}
                          className={cn(
                            'p-3 rounded border shadow-sm cursor-pointer hover:border-primary/50',
                            isDark ? 'bg-slate-800 border-slate-700' : 'bg-white'
                          )}
                          onClick={() => handleEditService(service)}
                        >
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-sm font-semibold">{service.serviceName}</span>
                            <Badge variant="secondary">{service.serviceType}</Badge>
                          </div>
                          <div className="text-lg font-bold">
                            {service.durationMinutes} <span className="text-sm font-normal text-muted-foreground">min</span> / {service.frequencyCount}x{' '}
                            <span className="text-sm font-normal text-muted-foreground">{service.frequency}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    );
  }

  // Render Tala Process (Israel)
  return (
    <div className={cn(
      'flex flex-col h-full min-h-0',
      isDark ? 'bg-slate-950' : 'bg-gray-50'
    )}>
      {GoalModal}
      {ServiceModal}
      
      <ScrollArea className="flex-1">
        <div className="p-6 max-w-5xl mx-auto space-y-6">
          {/* Header */}
          <div className="mb-6">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:text-foreground mb-4"
              onClick={handleBackClick}
            >
              {isRTL ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
              {t('tala.backButton') || 'חזרה לרשימת תלמידים'}
            </Button>
            <div className={cn('flex justify-between items-start', isRTL && 'flex-row-reverse')}>
              <div className={isRTL ? 'text-right' : ''}>
                <h1 className={cn(
                  'text-2xl font-bold mb-2',
                  isDark ? 'text-white' : 'text-slate-900'
                )}>
                  {student?.name} - {t('tala.title') || 'תהליך תל״א'}
                </h1>
                <div className={cn(
                  'flex items-center gap-3 text-muted-foreground text-sm',
                  isRTL && 'flex-row-reverse'
                )}>
                  {(student as any)?.school && (
                    <Badge variant="outline" className="rounded-sm px-2 font-normal bg-background">
                      {(student as any).school}
                    </Badge>
                  )}
                  <span className="w-1 h-1 bg-muted-foreground/40 rounded-full" />
                  <span>{t('students.idLabel') || 'ת.ז'}: {(student as any)?.idNumber || student?.id.slice(0, 8)}</span>
                  {currentPhase?.dueDate && (
                    <>
                      <span className="w-1 h-1 bg-muted-foreground/40 rounded-full" />
                      <span>
                        {t('tala.nextDeadline') || 'תאריך יעד'}:{' '}
                        <span className="text-amber-600 font-medium">{currentPhase.dueDate}</span>
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className={cn('flex gap-2', isRTL && 'flex-row-reverse')}>
                <Button variant="outline" size="sm" className="gap-2">
                  <Share2 className="w-4 h-4" /> {t('tala.share') || 'שיתוף'}
                </Button>
                <Button variant="outline" size="sm" className="gap-2">
                  <Download className="w-4 h-4" /> {t('tala.exportPdf') || 'ייצוא PDF'}
                </Button>
              </div>
            </div>
          </div>

          {/* Overall Progress */}
          <Card className={cn(
            'p-4',
            isDark ? 'bg-slate-900' : 'bg-white'
          )}>
            <div className={cn('flex items-center gap-4', isRTL && 'flex-row-reverse')}>
              <div className="flex-1">
                <div className={cn('flex justify-between mb-2', isRTL && 'flex-row-reverse')}>
                  <span className="text-sm font-medium">{t('tala.overallProgress') || 'התקדמות כללית'}</span>
                  <span className="text-sm font-bold">{overallProgress}%</span>
                </div>
                <div className={cn(
                  'h-3 w-full rounded-full overflow-hidden',
                  isDark ? 'bg-slate-800' : 'bg-secondary'
                )}>
                  <div
                    className="h-full bg-primary transition-all duration-500"
                    style={{ width: `${overallProgress}%` }}
                  />
                </div>
              </div>
            </div>
          </Card>

          <div className={cn(
            'grid grid-cols-1 lg:grid-cols-12 gap-8',
            isRTL && 'direction-rtl'
          )}>
            {/* Phase Navigation (Stepper) */}
            <div className="lg:col-span-4 space-y-6">
              <Card className="border-none shadow-none bg-transparent">
                <CardHeader className="px-0 pt-0">
                  <CardTitle className="text-lg">{t('tala.roadmap') || 'מפת דרכים'}</CardTitle>
                  <CardDescription>{t('tala.roadmapDesc') || 'מעקב התקדמות בכל שלב'}</CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  <div className="relative">
                    {/* Vertical Line */}
                    <div className={cn(
                      'absolute top-4 bottom-4 w-0.5 bg-border -z-10',
                      isRTL ? 'right-[19px]' : 'left-[19px]'
                    )} />

                    <div className="space-y-6">
                      {phases.map((phase, index) => (
                        <div key={phase.id} className={cn('group flex gap-4 items-start', isRTL && 'flex-row-reverse')}>
                          <div className={cn(
                            'w-10 h-10 rounded-full border-2 flex items-center justify-center shrink-0 bg-background transition-colors',
                            phase.status === 'completed' ? 'border-primary text-primary' :
                            phase.status === 'in-progress' ? 'border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/25' :
                            'border-muted text-muted-foreground'
                          )}>
                            {phase.status === 'completed' ? (
                              <CheckCircle2 className="w-6 h-6" />
                            ) : (
                              <span className="font-bold text-sm">{index + 1}</span>
                            )}
                          </div>
                          <div className={cn(
                            'flex-1 pt-1 p-3 rounded-lg transition-colors cursor-pointer border border-transparent',
                            phase.status === 'in-progress' ? 'bg-card shadow-sm border-border' : 'hover:bg-secondary/50',
                            isRTL && 'text-right'
                          )}>
                            <h4 className={cn(
                              'font-semibold text-sm',
                              phase.status === 'in-progress' ? 'text-primary' : 'text-foreground'
                            )}>
                              {phase.phaseName}
                            </h4>
                            {phase.dueDate && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {t('students.dueLabel') || 'תאריך יעד'}: {phase.dueDate}
                              </p>
                            )}
                            {phase.status === 'in-progress' && (
                              <Badge variant="secondary" className="mt-2 text-[10px] h-5">
                                {t('tala.phaseCurrent') || 'שלב נוכחי'}
                              </Badge>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Active Phase Content */}
            <div className="lg:col-span-8 space-y-6">
              {/* Completed Phases */}
              {phases.filter(p => p.status === 'completed').map((phase) => (
                <Card key={phase.id} className={cn(
                  'opacity-75 hover:opacity-100 transition-opacity border-dashed',
                  isDark ? 'bg-slate-900/30' : 'bg-muted/30'
                )}>
                  <CardHeader className="pb-3">
                    <div className={cn('flex justify-between items-center', isRTL && 'flex-row-reverse')}>
                      <CardTitle className="text-base text-muted-foreground flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4" /> {phase.phaseName}
                      </CardTitle>
                      <Button variant="ghost" size="sm" className="h-8 text-primary">
                        {t('tala.viewData') || 'צפה בנתונים'}
                      </Button>
                    </div>
                  </CardHeader>
                </Card>
              ))}

              {/* Active Phase */}
              {currentPhase && (
                <Card className={cn(
                  'border-primary shadow-md shadow-primary/5 relative overflow-hidden',
                  isRTL ? 'border-r-primary border-r-4' : 'border-l-primary border-l-4'
                )}>
                  <CardHeader>
                    <div className={cn('flex justify-between items-start', isRTL && 'flex-row-reverse')}>
                      <div className={isRTL ? 'text-right' : ''}>
                        <Badge className="mb-2 bg-primary/10 text-primary border-primary/20 hover:bg-primary/20">
                          {t('tala.inProgress') || 'בתהליך'}
                        </Badge>
                        <CardTitle className="text-2xl text-primary">
                          {currentPhase.phaseName}
                        </CardTitle>
                      </div>
                      {currentPhase.dueDate && (
                        <div className={cn(isRTL ? 'pl-1 text-left' : 'pr-1 text-right')}>
                          <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                            {t('tala.deadlineLabel') || 'תאריך יעד'}
                          </p>
                          <p className="font-bold text-foreground">{currentPhase.dueDate}</p>
                        </div>
                      )}
                    </div>
                  </CardHeader>

                  <Separator />

                  <CardContent className="pt-6 space-y-6">
                    {/* Goals */}
                    <div className="space-y-4">
                      <div className={cn('flex justify-between items-center', isRTL && 'flex-row-reverse')}>
                        <h3 className="font-semibold">{t('tala.goals') || 'מטרות'}</h3>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-2"
                          onClick={() => {
                            setEditingGoal(null);
                            setGoalForm(emptyGoal);
                            setShowGoalModal(true);
                          }}
                        >
                          <Plus className="w-4 h-4" />
                          {t('tala.addGoal') || 'הוסף מטרה'}
                        </Button>
                      </div>

                      {goals.length === 0 ? (
                        <div className={cn(
                          'p-8 rounded-lg border-2 border-dashed text-center',
                          isDark ? 'border-slate-700' : 'border-slate-200'
                        )}>
                          <Target className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                          <p className="text-muted-foreground">
                            {t('tala.noGoals') || 'אין מטרות עדיין'}
                          </p>
                        </div>
                      ) : (
                        goals.map((goal) => (
                          <div
                            key={goal.id}
                            className={cn(
                              'p-4 rounded-lg border',
                              isDark ? 'bg-slate-800/50 border-slate-700' : 'bg-secondary/50 border-border'
                            )}
                          >
                            <div className={cn(
                              'flex justify-between items-start mb-2',
                              isRTL && 'flex-row-reverse'
                            )}>
                              <h4 className={cn(
                                'font-semibold flex items-center gap-2',
                                isRTL && 'flex-row-reverse'
                              )}>
                                <FileText className="w-4 h-4 text-muted-foreground" />
                                {goal.title}
                              </h4>
                              <div className="flex gap-1">
                                <Button 
                                  variant="ghost" 
                                  size="sm" 
                                  className="h-8 w-8 p-0"
                                  onClick={() => handleEditGoal(goal)}
                                >
                                  <Edit className="w-4 h-4" />
                                </Button>
                                <Button 
                                  variant="ghost" 
                                  size="sm" 
                                  className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                                  onClick={() => deleteGoalMutation.mutate(goal.id)}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                            {goal.description && (
                              <p className={cn('text-sm text-muted-foreground', isRTL && 'text-right')}>
                                {goal.description}
                              </p>
                            )}
                            <div className={cn(
                              'flex items-center gap-4 mt-3 text-xs text-muted-foreground',
                              isRTL && 'flex-row-reverse'
                            )}>
                              <Badge variant="secondary">{goal.status}</Badge>
                              {goal.progress > 0 && (
                                <span>{t('tala.progress') || 'התקדמות'}: {goal.progress}%</span>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    <div className={cn(
                      'flex items-center justify-end gap-4 pt-4',
                      isRTL && 'flex-row-reverse'
                    )}>
                      <Button 
                        className="bg-primary text-primary-foreground shadow-md hover:bg-primary/90"
                        onClick={() => advancePhaseMutation.mutate()}
                        disabled={advancePhaseMutation.isPending}
                      >
                        {advancePhaseMutation.isPending && (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        )}
                        {t('tala.submitApproval') || 'שלח לאישור'}
                        {isRTL ? (
                          <ChevronLeft className="w-4 h-4 mr-2" />
                        ) : (
                          <ArrowRight className="w-4 h-4 ml-2" />
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Future Phases */}
              {phases.filter(p => p.status === 'pending' || p.status === 'locked').map((phase) => (
                <Card key={phase.id} className={cn(
                  'opacity-50',
                  isDark ? 'bg-slate-900/10' : 'bg-muted/10'
                )}>
                  <CardHeader className="pb-3">
                    <div className={cn('flex justify-between items-center', isRTL && 'flex-row-reverse')}>
                      <CardTitle className="text-base text-muted-foreground flex items-center gap-2">
                        <Circle className="w-4 h-4" /> {phase.phaseName}
                      </CardTitle>
                      <Badge variant="secondary">{t('tala.locked') || 'נעול'}</Badge>
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}