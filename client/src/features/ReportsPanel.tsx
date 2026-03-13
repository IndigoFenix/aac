// src/features/ReportsPanel.tsx
// Comprehensive Reports Management Panel for Medical, Functional, and Educational Reports
// Uses types derived from schema.ts as single source of truth

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useStudent } from '@/hooks/useStudent';
import { useChat } from '@/hooks/useChat';
import { useInstitute } from '@/hooks/useInstitute';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
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
  FileText,
  Plus,
  ChevronDown,
  Activity,
  Brain,
  Trash2,
  Edit,
  Loader2,
  MoreHorizontal,
  Heart,
  GraduationCap,
  Archive,
  Lock,
  Copy,
  Eye,
  AlertTriangle,
  Stethoscope,
  ClipboardList,
  BookOpen,
  CheckCircle,
  Clock,
  AlertCircle,
  X,
} from 'lucide-react';

// Import types from shared schema
import type {
  MedicalRecord,
  FunctionalReport,
  EducationalReport,
  ReportStatus,
  UpdateMedicalRecord,
  UpdateFunctionalReport,
  UpdateEducationalReport,
} from '@shared/schema';

// Import API hooks
import {
  useCurrentReports,
  useArchivedMedicalRecords,
  useArchivedFunctionalReports,
  useArchivedEducationalReports,
  useReportMutations,
} from '@/hooks/useReportsApi';

// =============================================================================
// PROPS
// =============================================================================

interface ReportsPanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const STATUS_COLORS: Record<ReportStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  pending_review: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  final: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  superseded: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500',
};

const STATUS_ICONS: Record<ReportStatus, React.ReactNode> = {
  draft: <Edit className="w-3 h-3" />,
  pending_review: <Clock className="w-3 h-3" />,
  final: <CheckCircle className="w-3 h-3" />,
  superseded: <Archive className="w-3 h-3" />,
};

type ReportType = 'medical' | 'functional' | 'educational';

// =============================================================================
// PRINTABLE REPORT
// =============================================================================

function getArrayField(field: unknown): string[] {
  if (Array.isArray(field)) return field as string[];
  return [];
}

function openPrintableReport(
  report: MedicalRecord | FunctionalReport | EducationalReport,
  type: ReportType,
  student: { name: string; id: string } | null,
  institute: { name: string; logoUrl?: string } | null,
  t: (key: string) => string,
  isRTL: boolean = false,
) {
  const statusLabels: Record<string, string> = {
    draft: t('reports.status.draft'),
    pending_review: t('reports.status.pending_review'),
    final: t('reports.status.final'),
    superseded: t('reports.status.superseded'),
  };

  const renderArraySection = (label: string, items: string[]) => {
    if (!items.length) return '';
    return `
      <div class="section">
        <h3>${label}</h3>
        <ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
      </div>`;
  };

  const escapeHtml = (str: string) =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let bodyContent = '';

  if (type === 'medical') {
    const r = report as MedicalRecord;
    bodyContent = `
      ${r.primaryDiagnosis ? `<div class="section"><h3>${t('reports.medical.primaryDiagnosis')}</h3><p>${escapeHtml(r.primaryDiagnosis)}${r.primaryDiagnosisCode ? ` (${escapeHtml(r.primaryDiagnosisCode)})` : ''}</p></div>` : ''}
      ${renderArraySection(t('reports.medical.coMorbidities'), getArrayField(r.coMorbidities))}
      ${renderArraySection(t('reports.medical.secondaryDiagnoses'), getArrayField(r.secondaryDiagnoses))}
      ${renderArraySection(t('reports.medical.allergies'), getArrayField(r.alertsAllergies))}
      ${renderArraySection(t('reports.medical.seizures'), getArrayField(r.alertsSeizures))}
      ${renderArraySection(t('reports.medical.cardiac'), getArrayField(r.alertsCardiac))}
      ${renderArraySection(t('reports.medical.medications'), getArrayField(r.medications))}
      ${renderArraySection(t('reports.medical.medicalEquipment'), getArrayField(r.medicalEquipment))}
    `;
  } else if (type === 'functional') {
    const r = report as FunctionalReport;
    bodyContent = `
      ${renderArraySection(t('reports.functional.mobilityStatus'), getArrayField(r.mobilityStatus))}
      ${renderArraySection(t('reports.functional.adlStatus'), getArrayField(r.adlStatus))}
      ${renderArraySection(t('reports.functional.sensoryProfile'), getArrayField(r.sensoryProfile))}
      ${renderArraySection(t('reports.functional.safetyRisks'), getArrayField(r.safetyRisks))}
    `;
  } else {
    const r = report as EducationalReport;
    bodyContent = `
      ${renderArraySection(t('reports.educational.communicationMode'), getArrayField(r.communicationMode))}
      ${renderArraySection(t('reports.educational.receptiveLanguage'), getArrayField(r.receptiveLanguage))}
      ${renderArraySection(t('reports.educational.assistiveTechnology'), getArrayField(r.assistiveTechnologyUsed))}
      ${renderArraySection(t('reports.educational.reinforcers'), getArrayField(r.reinforcers))}
      ${renderArraySection(t('reports.educational.preferredActivities'), getArrayField(r.preferredActivities))}
      ${renderArraySection(t('reports.educational.behavioralStrategies'), getArrayField(r.behavioralStrategies))}
    `;
  }

  const logoHtml = institute?.logoUrl
    ? `<img src="${institute.logoUrl}" alt="${escapeHtml(institute.name)}" class="logo" />`
    : '';
  const instituteNameHtml = institute?.name
    ? `<span class="institute-name">${escapeHtml(institute.name)}</span>`
    : '';

  const html = `<!DOCTYPE html>
<html dir="${isRTL ? 'rtl' : 'ltr'}" lang="${isRTL ? 'he' : 'en'}">
<head>
  <meta charset="utf-8">
  <title>${t(`reports.${type}.title`)} - ${student?.name || ''}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; padding: 40px; color: #1a1a1a; max-width: 800px; margin: 0 auto; }
    .header { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; padding-bottom: 16px; border-bottom: 2px solid #333; }
    .logo { width: 64px; height: 64px; object-fit: contain; }
    .header-text { flex: 1; }
    .institute-name { font-size: 20px; font-weight: 600; display: block; }
    .report-title { font-size: 24px; font-weight: 700; margin-top: 16px; }
    .meta { display: flex; flex-wrap: wrap; gap: 24px; margin: 12px 0 24px; font-size: 13px; color: #555; }
    .meta span { display: inline-flex; gap: 4px; }
    .section { margin-bottom: 20px; }
    .section h3 { font-size: 15px; font-weight: 600; margin-bottom: 6px; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .section p { font-size: 14px; line-height: 1.5; }
    .section ul { list-style: disc; padding-inline-start: 24px; font-size: 14px; line-height: 1.8; }
    @media print {
      body { padding: 20px; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    ${logoHtml}
    <div class="header-text">
      ${instituteNameHtml}
    </div>
  </div>
  <div class="report-title">${t(`reports.${type}.title`)}</div>
  <div class="meta">
    <span><strong>${t('header.student')}:</strong> ${escapeHtml(student?.name || '')}</span>
    <span><strong>${statusLabels[report.status] || report.status}</strong></span>
    <span>${t('reports.createdAt')}: ${new Date(report.createdAt).toLocaleDateString()}</span>
    <span>${t('reports.updatedAt')}: ${new Date(report.updatedAt).toLocaleDateString()}</span>
    ${report.finalizedAt ? `<span>${t('reports.finalizedAt')}: ${new Date(report.finalizedAt).toLocaleDateString()}</span>` : ''}
  </div>
  ${bodyContent}
  <div class="no-print" style="margin-top:32px;text-align:center;">
    <button onclick="window.print()" style="padding:10px 32px;font-size:16px;cursor:pointer;border:1px solid #333;border-radius:6px;background:#fff;">
      ${t('reports.print') || 'Print'}
    </button>
  </div>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
  }
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function ReportsPanel({ isOpen, onClose }: ReportsPanelProps) {
  const { user } = useAuth();
  const { student } = useStudent();
  const { currentInstitute } = useInstitute();
  const { aiRefreshing } = useChat();
  const isAiRefreshing = aiRefreshing.has('reports');
  const { t, isRTL } = useLanguage();
  const { toast } = useToast();

  // State
  const [activeTab, setActiveTab] = useState<ReportType>('functional');
  const [showArchivedMedical, setShowArchivedMedical] = useState(false);
  const [showArchivedFunctional, setShowArchivedFunctional] = useState(false);
  const [showArchivedEducational, setShowArchivedEducational] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createType, setCreateType] = useState<ReportType>('functional');
  const [selectedReport, setSelectedReport] = useState<MedicalRecord | FunctionalReport | EducationalReport | null>(null);
  const [selectedReportType, setSelectedReportType] = useState<ReportType | null>(null);
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [showFinalizeDialog, setShowFinalizeDialog] = useState(false);

  // Queries
  const { data: currentReports, isLoading, error } = useCurrentReports(student?.id);
  const { data: archivedMedical } = useArchivedMedicalRecords(student?.id, undefined, showArchivedMedical);
  const { data: archivedFunctional } = useArchivedFunctionalReports(student?.id, showArchivedFunctional);
  const { data: archivedEducational } = useArchivedEducationalReports(student?.id, showArchivedEducational);

  // Mutations
  const {
    createMedicalRecord,
    updateMedicalRecord,
    createFunctionalReport,
    updateFunctionalReport,
    createEducationalReport,
    updateEducationalReport,
    finalizeMedicalRecord,
    finalizeFunctionalReport,
    finalizeEducationalReport,
    createMedicalRecordRevision,
    createFunctionalReportRevision,
    createEducationalReportRevision,
    deleteMedicalRecord,
    deleteFunctionalReport,
    deleteEducationalReport,
  } = useReportMutations(student?.id);

  // Handlers
  const handleCreateReport = (type: ReportType) => {
    setCreateType(type);
    setShowCreateDialog(true);
  };

  const handleConfirmCreate = async () => {
    try {
      switch (createType) {
        case 'medical':
          await createMedicalRecord.mutateAsync({});
          break;
        case 'functional':
          await createFunctionalReport.mutateAsync({});
          break;
        case 'educational':
          await createEducationalReport.mutateAsync({});
          break;
      }
      setShowCreateDialog(false);
    } catch (error) {
      // Error handled by mutation
    }
  };

  const handleViewReport = (report: MedicalRecord | FunctionalReport | EducationalReport, type: ReportType) => {
    openPrintableReport(report, type, student, currentInstitute, t, isRTL);
  };

  const handleEditReport = (report: MedicalRecord | FunctionalReport | EducationalReport, type: ReportType) => {
    setSelectedReport(report);
    setSelectedReportType(type);
    setShowViewDialog(true);
  };

  const handleFinalizeReport = (report: MedicalRecord | FunctionalReport | EducationalReport, type: ReportType) => {
    setSelectedReport(report);
    setSelectedReportType(type);
    setShowFinalizeDialog(true);
  };

  const handleConfirmFinalize = async () => {
    if (!selectedReport || !selectedReportType) return;

    try {
      switch (selectedReportType) {
        case 'medical':
          await finalizeMedicalRecord.mutateAsync(selectedReport.id);
          break;
        case 'functional':
          await finalizeFunctionalReport.mutateAsync(selectedReport.id);
          break;
        case 'educational':
          await finalizeEducationalReport.mutateAsync(selectedReport.id);
          break;
      }
      setShowFinalizeDialog(false);
      setSelectedReport(null);
      setSelectedReportType(null);
    } catch (error) {
      // Error handled by mutation
    }
  };

  const handleCreateRevision = async (report: MedicalRecord | FunctionalReport | EducationalReport, type: ReportType) => {
    try {
      switch (type) {
        case 'medical':
          await createMedicalRecordRevision.mutateAsync(report.id);
          break;
        case 'functional':
          await createFunctionalReportRevision.mutateAsync(report.id);
          break;
        case 'educational':
          await createEducationalReportRevision.mutateAsync(report.id);
          break;
      }
    } catch (error) {
      // Error handled by mutation
    }
  };

  const handleDeleteReport = async (report: MedicalRecord | FunctionalReport | EducationalReport, type: ReportType) => {
    try {
      switch (type) {
        case 'medical':
          await deleteMedicalRecord.mutateAsync(report.id);
          break;
        case 'functional':
          await deleteFunctionalReport.mutateAsync(report.id);
          break;
        case 'educational':
          await deleteEducationalReport.mutateAsync(report.id);
          break;
      }
    } catch (error) {
      // Error handled by mutation
    }
  };

  // Render helpers
  const renderStatusBadge = (status: ReportStatus) => (
    <Badge className={cn('gap-1', STATUS_COLORS[status])}>
      {STATUS_ICONS[status]}
      {t(`reports.status.${status}`)}
    </Badge>
  );

  const renderReportCard = (
    report: MedicalRecord | FunctionalReport | EducationalReport | null | undefined,
    type: ReportType,
    title: string,
    icon: React.ReactNode,
    description: string
  ) => {
    const isEditable = report?.status === 'draft' || report?.status === 'pending_review';
    const canFinalize = report?.status === 'draft' || report?.status === 'pending_review';
    const canCreateRevision = report?.status === 'final' || report?.status === 'superseded';
    const canDelete = report?.status === 'draft';

    return (
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {icon}
              <CardTitle className="text-lg">{title}</CardTitle>
            </div>
            {report && renderStatusBadge(report.status)}
          </div>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {!report ? (
            <div className="text-center py-6">
              <p className="text-muted-foreground mb-4">
                {t(`reports.${type}.noReport`)}
              </p>
              <Button onClick={() => handleCreateReport(type)}>
                <Plus className="w-4 h-4 me-2" />
                {t(`reports.${type}.create`)}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Report summary info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">{t('reports.createdAt')}:</span>
                  <span className="ms-2">{new Date(report.createdAt).toLocaleDateString()}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">{t('reports.updatedAt')}:</span>
                  <span className="ms-2">{new Date(report.updatedAt).toLocaleDateString()}</span>
                </div>
                {report.finalizedAt && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">{t('reports.finalizedAt')}:</span>
                    <span className="ms-2">{new Date(report.finalizedAt).toLocaleDateString()}</span>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => handleViewReport(report, type)}>
                  <Eye className="w-4 h-4 me-2" />
                  {t('common.view')}
                </Button>
                {isEditable && (
                  <Button variant="outline" size="sm" onClick={() => handleEditReport(report, type)}>
                    <Edit className="w-4 h-4 me-2" />
                    {t('common.edit')}
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm">
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                    {canFinalize && (
                      <DropdownMenuItem onClick={() => handleFinalizeReport(report, type)}>
                        <Lock className="w-4 h-4 me-2" />
                        {t('reports.finalize')}
                      </DropdownMenuItem>
                    )}
                    {canCreateRevision && (
                      <DropdownMenuItem onClick={() => handleCreateRevision(report, type)}>
                        <Copy className="w-4 h-4 me-2" />
                        {t('reports.createRevision')}
                      </DropdownMenuItem>
                    )}
                    {canDelete && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => handleDeleteReport(report, type)}
                        >
                          <Trash2 className="w-4 h-4 me-2" />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderArchivedReports = (
    reports: (MedicalRecord | FunctionalReport | EducationalReport)[] | undefined,
    type: ReportType,
    isOpen: boolean,
    setIsOpen: (open: boolean) => void
  ) => {
    if (!reports || reports.length === 0) return null;

    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mb-4">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between">
            <div className="flex items-center gap-2">
              <Archive className="w-4 h-4" />
              <span>{t('reports.archived')} ({reports.length})</span>
            </div>
            <ChevronDown className={cn('w-4 h-4 transition-transform', isOpen && 'rotate-180')} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          {reports.map((report) => (
            <Card key={report.id} className="bg-muted/30">
              <CardContent className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {renderStatusBadge(report.status)}
                    <span className="text-sm text-muted-foreground">
                      {report.finalizedAt
                        ? new Date(report.finalizedAt).toLocaleDateString()
                        : new Date(report.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => handleViewReport(report, type)}>
                      <Eye className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleCreateRevision(report, type)}>
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  // Loading state
  if (!student) {
    return (
      <div className={cn('h-full flex items-center justify-center p-8', !isOpen && 'hidden')}>
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">{t('reports.noStudentSelected')}</h3>
          <p className="text-muted-foreground">{t('reports.selectStudentFirst')}</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={cn('h-full flex items-center justify-center', !isOpen && 'hidden')}>
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const hasMedicalAccess = currentReports?.access?.hasMedicalRights ?? false;
  const hasEducationalAccess = currentReports?.access?.hasEducationalRights ?? false;

  return (
    <div
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn('h-full flex flex-col bg-background', !isOpen && 'hidden')}
    >
      {/* Header */}
      <div className="flex-shrink-0 p-4 md:p-6 border-b">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-semibold">{t('reports.title')}</h2>
              {isAiRefreshing && (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              )}
            </div>
            <p className="text-muted-foreground">
              {t('reports.subtitle', { name: student.name })}
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4 md:p-6">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ReportType)}>
            <TabsList className="mb-4 flex-wrap h-auto gap-1">
              {hasMedicalAccess && (
                <TabsTrigger value="medical" className="gap-1.5 text-xs md:text-sm">
                  <Stethoscope className="w-4 h-4" />
                  <span className="hidden sm:inline">{t('reports.medical.title')}</span>
                  <span className="sm:hidden">{t('reports.medical.title')}</span>
                </TabsTrigger>
              )}
              {hasEducationalAccess && (
                <>
                  <TabsTrigger value="functional" className="gap-1.5 text-xs md:text-sm">
                    <ClipboardList className="w-4 h-4" />
                    <span>{t('reports.functional.title')}</span>
                  </TabsTrigger>
                  <TabsTrigger value="educational" className="gap-1.5 text-xs md:text-sm">
                    <BookOpen className="w-4 h-4" />
                    <span>{t('reports.educational.title')}</span>
                  </TabsTrigger>
                </>
              )}
            </TabsList>

            {/* Medical Records Tab */}
            {hasMedicalAccess && (
              <TabsContent value="medical" className="mt-0">
                {renderReportCard(
                  currentReports?.medicalRecord,
                  'medical',
                  t('reports.medical.title'),
                  <Stethoscope className="w-5 h-5 text-red-500" />,
                  t('reports.medical.description')
                )}
                {renderArchivedReports(
                  archivedMedical?.records,
                  'medical',
                  showArchivedMedical,
                  setShowArchivedMedical
                )}
              </TabsContent>
            )}

            {/* Functional Reports Tab */}
            {hasEducationalAccess && (
              <TabsContent value="functional" className="mt-0">
                {renderReportCard(
                  currentReports?.functionalReport,
                  'functional',
                  t('reports.functional.title'),
                  <ClipboardList className="w-5 h-5 text-orange-500" />,
                  t('reports.functional.description')
                )}
                {renderArchivedReports(
                  archivedFunctional?.reports,
                  'functional',
                  showArchivedFunctional,
                  setShowArchivedFunctional
                )}
              </TabsContent>
            )}

            {/* Educational Reports Tab */}
            {hasEducationalAccess && (
              <TabsContent value="educational" className="mt-0">
                {renderReportCard(
                  currentReports?.educationalReport,
                  'educational',
                  t('reports.educational.title'),
                  <BookOpen className="w-5 h-5 text-blue-500" />,
                  t('reports.educational.description')
                )}
                {renderArchivedReports(
                  archivedEducational?.reports,
                  'educational',
                  showArchivedEducational,
                  setShowArchivedEducational
                )}
              </TabsContent>
            )}
          </Tabs>

          {/* No Access Warning */}
          {!hasMedicalAccess && !hasEducationalAccess && (
            <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
              <CardContent className="py-6 text-center">
                <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
                <p className="text-amber-800 dark:text-amber-200">
                  {t('reports.noAccess')}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>

      {/* Create Report Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t(`reports.${createType}.create`)}</DialogTitle>
            <DialogDescription>
              {t(`reports.${createType}.createDesc`)}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              {t('reports.createConfirm')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleConfirmCreate}
              disabled={
                createMedicalRecord.isPending ||
                createFunctionalReport.isPending ||
                createEducationalReport.isPending
              }
            >
              {(createMedicalRecord.isPending ||
                createFunctionalReport.isPending ||
                createEducationalReport.isPending) && (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              )}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Finalize Report Dialog */}
      <Dialog open={showFinalizeDialog} onOpenChange={setShowFinalizeDialog}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('reports.finalizeTitle')}</DialogTitle>
            <DialogDescription>
              {t('reports.finalizeWarning')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950 rounded-md">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              <p className="text-sm text-amber-800 dark:text-amber-200">
                {t('reports.finalizeCannotUndo')}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFinalizeDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleConfirmFinalize}
              disabled={
                finalizeMedicalRecord.isPending ||
                finalizeFunctionalReport.isPending ||
                finalizeEducationalReport.isPending
              }
            >
              {(finalizeMedicalRecord.isPending ||
                finalizeFunctionalReport.isPending ||
                finalizeEducationalReport.isPending) && (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              )}
              {t('reports.finalize')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View/Edit Report Dialog */}
      <Dialog open={showViewDialog} onOpenChange={setShowViewDialog}>
        <DialogContent className="max-w-[95vw] sm:max-w-[700px]">
          <DialogHeader>
            <DialogTitle>
              {selectedReportType && t(`reports.${selectedReportType}.title`)}
            </DialogTitle>
            {selectedReport && (
              <div className="flex items-center gap-2 mt-2">
                {renderStatusBadge(selectedReport.status)}
              </div>
            )}
          </DialogHeader>
          <DialogBody className="py-4">
            {selectedReport && selectedReportType === 'medical' && (
              <MedicalRecordForm
                record={selectedReport as MedicalRecord}
                onSave={async (updates) => {
                  await updateMedicalRecord.mutateAsync({
                    recordId: selectedReport.id,
                    updates,
                  });
                  setShowViewDialog(false);
                }}
                onClose={() => setShowViewDialog(false)}
                isEditable={selectedReport.status === 'draft' || selectedReport.status === 'pending_review'}
                isSaving={updateMedicalRecord.isPending}
              />
            )}
            {selectedReport && selectedReportType === 'functional' && (
              <FunctionalReportForm
                report={selectedReport as FunctionalReport}
                onSave={async (updates) => {
                  await updateFunctionalReport.mutateAsync({
                    reportId: selectedReport.id,
                    updates,
                  });
                  setShowViewDialog(false);
                }}
                onClose={() => setShowViewDialog(false)}
                isEditable={selectedReport.status === 'draft' || selectedReport.status === 'pending_review'}
                isSaving={updateFunctionalReport.isPending}
              />
            )}
            {selectedReport && selectedReportType === 'educational' && (
              <EducationalReportForm
                report={selectedReport as EducationalReport}
                onSave={async (updates) => {
                  await updateEducationalReport.mutateAsync({
                    reportId: selectedReport.id,
                    updates,
                  });
                  setShowViewDialog(false);
                }}
                onClose={() => setShowViewDialog(false)}
                isEditable={selectedReport.status === 'draft' || selectedReport.status === 'pending_review'}
                isSaving={updateEducationalReport.isPending}
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =============================================================================
// HELPER: Array Field Editor Component
// =============================================================================

interface ArrayFieldEditorProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

function ArrayFieldEditor({ label, values, onChange, placeholder, disabled }: ArrayFieldEditorProps) {
  const { t } = useLanguage();
  const [newItem, setNewItem] = useState('');

  const handleAdd = () => {
    if (newItem.trim()) {
      onChange([...values, newItem.trim()]);
      setNewItem('');
    }
  };

  const handleRemove = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {!disabled && (
        <div className="flex gap-2">
          <Input
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1"
          />
          <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-1 min-h-[32px]">
        {values.length === 0 && disabled && (
          <span className="text-muted-foreground text-sm">{t('common.none')}</span>
        )}
        {values.map((item, index) => (
          <Badge key={index} variant="secondary" className="gap-1">
            {item}
            {!disabled && (
              <button
                type="button"
                onClick={() => handleRemove(index)}
                className="ms-1 hover:text-destructive"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </Badge>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// FORM COMPONENTS
// =============================================================================

interface MedicalRecordFormProps {
  record: MedicalRecord;
  onSave: (updates: UpdateMedicalRecord) => Promise<void>;
  onClose: () => void;
  isEditable: boolean;
  isSaving: boolean;
}

function MedicalRecordForm({ record, onSave, onClose, isEditable, isSaving }: MedicalRecordFormProps) {
  const { t } = useLanguage();
  
  const [primaryDiagnosis, setPrimaryDiagnosis] = useState(record.primaryDiagnosis || '');
  const [primaryDiagnosisCode, setPrimaryDiagnosisCode] = useState(record.primaryDiagnosisCode || '');
  const [coMorbidities, setCoMorbidities] = useState<string[]>(getArrayField(record.coMorbidities));
  const [secondaryDiagnoses, setSecondaryDiagnoses] = useState<string[]>(getArrayField(record.secondaryDiagnoses));
  const [alertsAllergies, setAlertsAllergies] = useState<string[]>(getArrayField(record.alertsAllergies));
  const [alertsSeizures, setAlertsSeizures] = useState<string[]>(getArrayField(record.alertsSeizures));
  const [alertsCardiac, setAlertsCardiac] = useState<string[]>(getArrayField(record.alertsCardiac));
  const [medications, setMedications] = useState<string[]>(getArrayField(record.medications));
  const [medicalEquipment, setMedicalEquipment] = useState<string[]>(getArrayField(record.medicalEquipment));

  const handleSave = async () => {
    await onSave({
      primaryDiagnosis: primaryDiagnosis || null,
      primaryDiagnosisCode: primaryDiagnosisCode || null,
      coMorbidities,
      secondaryDiagnoses,
      alertsAllergies,
      alertsSeizures,
      alertsCardiac,
      medications,
      medicalEquipment,
    });
  };

  return (
    <div className="space-y-6">
      {/* Primary Diagnosis */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="primaryDiagnosis">{t('reports.medical.primaryDiagnosis')}</Label>
          <Input
            id="primaryDiagnosis"
            value={primaryDiagnosis}
            onChange={(e) => setPrimaryDiagnosis(e.target.value)}
            placeholder={t('reports.medical.primaryDiagnosisPlaceholder')}
            disabled={!isEditable}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="primaryDiagnosisCode">{t('reports.medical.primaryDiagnosisCode')}</Label>
          <Input
            id="primaryDiagnosisCode"
            value={primaryDiagnosisCode}
            onChange={(e) => setPrimaryDiagnosisCode(e.target.value)}
            placeholder="ICD-10"
            disabled={!isEditable}
          />
        </div>
      </div>

      <Separator />

      {/* Co-morbidities & Secondary Diagnoses */}
      <ArrayFieldEditor
        label={t('reports.medical.coMorbidities')}
        values={coMorbidities}
        onChange={setCoMorbidities}
        placeholder={t('reports.medical.addCoMorbidity')}
        disabled={!isEditable}
      />

      <ArrayFieldEditor
        label={t('reports.medical.secondaryDiagnoses')}
        values={secondaryDiagnoses}
        onChange={setSecondaryDiagnoses}
        placeholder={t('reports.medical.addDiagnosis')}
        disabled={!isEditable}
      />

      <Separator />

      {/* Alerts */}
      <div className="space-y-4">
        <h4 className="font-medium flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-destructive" />
          {t('reports.medical.alerts')}
        </h4>
        
        <ArrayFieldEditor
          label={t('reports.medical.allergies')}
          values={alertsAllergies}
          onChange={setAlertsAllergies}
          placeholder={t('reports.medical.addAllergy')}
          disabled={!isEditable}
        />

        <ArrayFieldEditor
          label={t('reports.medical.seizures')}
          values={alertsSeizures}
          onChange={setAlertsSeizures}
          placeholder={t('reports.medical.addSeizureAlert')}
          disabled={!isEditable}
        />

        <ArrayFieldEditor
          label={t('reports.medical.cardiac')}
          values={alertsCardiac}
          onChange={setAlertsCardiac}
          placeholder={t('reports.medical.addCardiacAlert')}
          disabled={!isEditable}
        />
      </div>

      <Separator />

      {/* Medications & Equipment */}
      <ArrayFieldEditor
        label={t('reports.medical.medications')}
        values={medications}
        onChange={setMedications}
        placeholder={t('reports.medical.addMedication')}
        disabled={!isEditable}
      />

      <ArrayFieldEditor
        label={t('reports.medical.medicalEquipment')}
        values={medicalEquipment}
        onChange={setMedicalEquipment}
        placeholder={t('reports.medical.addEquipment')}
        disabled={!isEditable}
      />

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-4 border-t">
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        {isEditable && (
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {t('common.save')}
          </Button>
        )}
      </div>
    </div>
  );
}

interface FunctionalReportFormProps {
  report: FunctionalReport;
  onSave: (updates: UpdateFunctionalReport) => Promise<void>;
  onClose: () => void;
  isEditable: boolean;
  isSaving: boolean;
}

function FunctionalReportForm({ report, onSave, onClose, isEditable, isSaving }: FunctionalReportFormProps) {
  const { t } = useLanguage();
  
  const [mobilityStatus, setMobilityStatus] = useState<string[]>(getArrayField(report.mobilityStatus));
  const [adlStatus, setAdlStatus] = useState<string[]>(getArrayField(report.adlStatus));
  const [sensoryProfile, setSensoryProfile] = useState<string[]>(getArrayField(report.sensoryProfile));
  const [safetyRisks, setSafetyRisks] = useState<string[]>(getArrayField(report.safetyRisks));

  const handleSave = async () => {
    await onSave({
      mobilityStatus,
      adlStatus,
      sensoryProfile,
      safetyRisks,
    });
  };

  return (
    <div className="space-y-6">
      <ArrayFieldEditor
        label={t('reports.functional.mobilityStatus')}
        values={mobilityStatus}
        onChange={setMobilityStatus}
        placeholder={t('reports.functional.addMobility')}
        disabled={!isEditable}
      />

      <Separator />

      <ArrayFieldEditor
        label={t('reports.functional.adlStatus')}
        values={adlStatus}
        onChange={setAdlStatus}
        placeholder={t('reports.functional.addAdl')}
        disabled={!isEditable}
      />

      <Separator />

      <ArrayFieldEditor
        label={t('reports.functional.sensoryProfile')}
        values={sensoryProfile}
        onChange={setSensoryProfile}
        placeholder={t('reports.functional.addSensory')}
        disabled={!isEditable}
      />

      <Separator />

      <ArrayFieldEditor
        label={t('reports.functional.safetyRisks')}
        values={safetyRisks}
        onChange={setSafetyRisks}
        placeholder={t('reports.functional.addRisk')}
        disabled={!isEditable}
      />

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-4 border-t">
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        {isEditable && (
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {t('common.save')}
          </Button>
        )}
      </div>
    </div>
  );
}

interface EducationalReportFormProps {
  report: EducationalReport;
  onSave: (updates: UpdateEducationalReport) => Promise<void>;
  onClose: () => void;
  isEditable: boolean;
  isSaving: boolean;
}

function EducationalReportForm({ report, onSave, onClose, isEditable, isSaving }: EducationalReportFormProps) {
  const { t } = useLanguage();
  
  const [communicationMode, setCommunicationMode] = useState<string[]>(getArrayField(report.communicationMode));
  const [receptiveLanguage, setReceptiveLanguage] = useState<string[]>(getArrayField(report.receptiveLanguage));
  const [assistiveTechnologyUsed, setAssistiveTechnologyUsed] = useState<string[]>(getArrayField(report.assistiveTechnologyUsed));
  const [reinforcers, setReinforcers] = useState<string[]>(getArrayField(report.reinforcers));
  const [preferredActivities, setPreferredActivities] = useState<string[]>(getArrayField(report.preferredActivities));
  const [behavioralStrategies, setBehavioralStrategies] = useState<string[]>(getArrayField(report.behavioralStrategies));

  const handleSave = async () => {
    await onSave({
      communicationMode,
      receptiveLanguage,
      assistiveTechnologyUsed,
      reinforcers,
      preferredActivities,
      behavioralStrategies,
    });
  };

  return (
    <div className="space-y-6">
      <ArrayFieldEditor
        label={t('reports.educational.communicationMode')}
        values={communicationMode}
        onChange={setCommunicationMode}
        placeholder={t('reports.educational.addCommunication')}
        disabled={!isEditable}
      />

      <Separator />

      <ArrayFieldEditor
        label={t('reports.educational.receptiveLanguage')}
        values={receptiveLanguage}
        onChange={setReceptiveLanguage}
        placeholder={t('reports.educational.addReceptive')}
        disabled={!isEditable}
      />

      <Separator />

      <ArrayFieldEditor
        label={t('reports.educational.assistiveTechnology')}
        values={assistiveTechnologyUsed}
        onChange={setAssistiveTechnologyUsed}
        placeholder={t('reports.educational.addTechnology')}
        disabled={!isEditable}
      />

      <Separator />

      <ArrayFieldEditor
        label={t('reports.educational.reinforcers')}
        values={reinforcers}
        onChange={setReinforcers}
        placeholder={t('reports.educational.addReinforcer')}
        disabled={!isEditable}
      />

      <Separator />

      <ArrayFieldEditor
        label={t('reports.educational.preferredActivities')}
        values={preferredActivities}
        onChange={setPreferredActivities}
        placeholder={t('reports.educational.addActivity')}
        disabled={!isEditable}
      />

      <Separator />

      <ArrayFieldEditor
        label={t('reports.educational.behavioralStrategies')}
        values={behavioralStrategies}
        onChange={setBehavioralStrategies}
        placeholder={t('reports.educational.addStrategy')}
        disabled={!isEditable}
      />

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-4 border-t">
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        {isEditable && (
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {t('common.save')}
          </Button>
        )}
      </div>
    </div>
  );
}