// src/features/InsuranceBridgePanel.tsx
// Insurance Bridge module — RTM Tracker (Phase 1) + LMN auto-generator (Phase 4).
// Surfaces per-student RTM totals for a billing period, with regime-aware
// threshold pills (e.g. 98977 / 98985 for us_cpt). Schema stores totals only
// — threshold curves live in shared/license-permissions + lib/insuranceRegime.
// LMN tab lets clinicians generate and finalize Letters of Medical Necessity.

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useInstitute } from '@/hooks/useInstitute';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { Receipt, AlertTriangle, Loader2, FileText, Plus, Lock, Printer, Download } from 'lucide-react';
import {
  getBillingRegimeConfig,
  resolveRtmCode,
  resolveClinicianTimeCode,
  type BillingRegimeConfig,
} from '@/lib/insuranceRegime';
import { openPrintableLmn } from '@/lib/insuranceLmnTemplates';
import type { BillingRegime } from '@shared/license-permissions';
import type { LetterOfMedicalNecessity } from '@shared/schema';
import type { LmnSections } from '@shared/insurance-lmn-types';

interface InsuranceBridgePanelProps {
  isOpen: boolean;
}

interface RtmStudentRollup {
  studentId: string;
  studentName: string | null;
  daysActive: number;
  serviceSeconds: number;
  sessionCount: number;
  firstSession: string | null;
  lastSession: string | null;
}

interface RtmRollupResponse {
  success: boolean;
  rollup: {
    instituteId: string;
    period: string;
    timezone: string;
    rule: string;
    students: RtmStudentRollup[];
  };
  billingRegime: BillingRegime;
}

interface ClinicianTimeStudentRollup {
  studentId: string;
  studentName: string | null;
  totalSeconds: number;
  intervalCount: number;
  hadInteractive: boolean;
}

interface ClinicianTimeResponse {
  success: boolean;
  rollup: {
    instituteId: string;
    period: string;
    idleCapSeconds: number;
    students: ClinicianTimeStudentRollup[];
  };
  billingRegime: BillingRegime;
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hrs}h` : `${hrs}h ${remMins}m`;
}

function daysInPeriod(period: string): number {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function DayStrip({ daysActive, totalDays }: { daysActive: number; totalDays: number }) {
  const cells = Array.from({ length: totalDays }, (_, i) => i < daysActive);
  return (
    <div className="flex gap-0.5" data-testid="rtm-day-strip">
      {cells.map((active, i) => (
        <div
          key={i}
          className={cn(
            'h-3 flex-1 rounded-sm',
            active
              ? 'bg-primary'
              : 'bg-muted',
          )}
          title={`Day ${i + 1}: ${active ? 'active' : 'inactive'}`}
        />
      ))}
    </div>
  );
}

function tierClassFor(tier: 'green' | 'amber' | 'none'): string {
  if (tier === 'green') {
    return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 border-green-300';
  }
  if (tier === 'amber') {
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 border-amber-300';
  }
  return '';
}

function RtmPill({
  daysActive,
  regime,
  t,
}: {
  daysActive: number;
  regime: BillingRegime;
  t: (k: string) => string;
}) {
  const rule = resolveRtmCode(regime, daysActive);
  if (!rule) {
    return (
      <Badge variant="outline" className="text-xs" data-testid="rtm-pill-none">
        {t('insurance.rtm.notEligible') || 'Not eligible'}
      </Badge>
    );
  }
  return (
    <Badge
      className={cn('text-xs border', tierClassFor(rule.tier))}
      title={rule.description}
      data-testid={`rtm-pill-${rule.code}`}
    >
      {rule.code}
    </Badge>
  );
}

function ClinicianTimePill({
  totalMinutes,
  hadInteractive,
  regime,
  t,
}: {
  totalMinutes: number;
  hadInteractive: boolean;
  regime: BillingRegime;
  t: (k: string) => string;
}) {
  const { rule, blockedByInteractive } = resolveClinicianTimeCode(
    regime,
    totalMinutes,
    hadInteractive,
  );
  if (rule) {
    return (
      <Badge
        className={cn('text-xs border', tierClassFor(rule.tier))}
        title={rule.description}
        data-testid={`clintime-pill-${rule.code}`}
      >
        {rule.code}
      </Badge>
    );
  }
  if (blockedByInteractive) {
    return (
      <Badge
        variant="outline"
        className="text-xs border-amber-400 text-amber-700 dark:text-amber-300"
        title={
          t('insurance.clinTime.blockedDesc') ||
          'Clinician time meets the threshold but no interactive AAC session was recorded this period.'
        }
        data-testid="clintime-pill-blocked"
      >
        {t('insurance.clinTime.blocked') || 'No interaction'}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs" data-testid="clintime-pill-none">
      {t('insurance.clinTime.notEligible') || 'Not eligible'}
    </Badge>
  );
}

export function InsuranceBridgePanel({ isOpen }: InsuranceBridgePanelProps) {
  const { t } = useLanguage();
  const { currentInstitute, currentPermissions } = useInstitute();
  const [period, setPeriod] = useState(currentPeriod);

  const instituteId = currentInstitute?.id;
  const insuranceEnabled = !!currentPermissions?.insuranceBridgeEnabled;
  const billingRegime = (currentPermissions?.billingRegime as BillingRegime | undefined) ?? 'none';
  const regimeCfg: BillingRegimeConfig = useMemo(
    () => getBillingRegimeConfig(billingRegime),
    [billingRegime],
  );
  const totalDays = daysInPeriod(period);

  const { data, isLoading, isError } = useQuery<RtmRollupResponse>({
    queryKey: ['insurance', 'rtm', instituteId, period],
    enabled: !!instituteId && isOpen && insuranceEnabled,
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `/api/insurance/rtm?instituteId=${encodeURIComponent(instituteId!)}&period=${encodeURIComponent(period)}`,
      );
      return res.json();
    },
  });

  const { data: clinicianTimeData } = useQuery<ClinicianTimeResponse>({
    queryKey: ['insurance', 'clinician-time', instituteId, period],
    enabled: !!instituteId && isOpen && insuranceEnabled,
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `/api/insurance/clinician-time?instituteId=${encodeURIComponent(instituteId!)}&period=${encodeURIComponent(period)}`,
      );
      return res.json();
    },
  });

  const clinicianTimeByStudent = useMemo(() => {
    const map = new Map<string, ClinicianTimeStudentRollup>();
    for (const row of clinicianTimeData?.rollup.students ?? []) {
      map.set(row.studentId, row);
    }
    return map;
  }, [clinicianTimeData]);

  if (!isOpen) return null;

  if (!insuranceEnabled) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-6 flex items-center gap-3 text-muted-foreground">
            <AlertTriangle className="w-5 h-5" />
            <span>
              {t('insurance.notEnabled') ||
                'The Insurance Bridge module is not enabled for this institute.'}
            </span>
          </CardContent>
        </Card>
      </div>
    );
  }

  const students = data?.rollup.students ?? [];
  const timezone = data?.rollup.timezone ?? 'UTC';

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6" data-testid="insurance-bridge-panel">
        <div className="flex items-center gap-3">
          <Receipt className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">
              {t('insurance.title') || 'Insurance Bridge'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('insurance.rtm.subtitle') ||
                'Remote Therapeutic Monitoring (RTM) — billable days and service time per student.'}
            </p>
          </div>
          <Badge variant="outline" className="ms-auto">
            {regimeCfg.label}
          </Badge>
        </div>

        <Tabs defaultValue="rtm" className="space-y-4">
          <TabsList>
            <TabsTrigger value="rtm" data-testid="insurance-tab-rtm">
              {t('insurance.tabs.rtm') || 'RTM Tracker'}
            </TabsTrigger>
            <TabsTrigger value="lmn" data-testid="insurance-tab-lmn">
              {t('insurance.tabs.lmn') || 'Letters of Medical Necessity'}
            </TabsTrigger>
            <TabsTrigger value="summary" data-testid="insurance-tab-summary">
              {t('insurance.tabs.summary') || 'Billing summary'}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="rtm" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('insurance.rtm.controls') || 'Period & rules'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="rtm-period">
                      {t('insurance.rtm.period') || 'Billing month'}
                    </Label>
                    <Input
                      id="rtm-period"
                      type="month"
                      value={period}
                      onChange={(e) => setPeriod(e.target.value || currentPeriod())}
                      className="w-44"
                      data-testid="rtm-period-input"
                    />
                  </div>
                  <div className="text-xs text-muted-foreground pb-2">
                    {(t('insurance.rtm.timezone') || 'Local timezone:')} {timezone}
                  </div>
                </div>
                {data?.rollup.rule && (
                  <div className="text-xs text-muted-foreground border-l-2 border-muted ps-3">
                    <span className="font-medium me-1">
                      {t('insurance.rtm.billableRule') || 'Billable session rule:'}
                    </span>
                    {data.rollup.rule}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  {t('insurance.rtm.roster') || 'Student roster'}
                  {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {isError && (
                  <div className="text-sm text-destructive">
                    {t('insurance.rtm.loadError') || 'Failed to load RTM data.'}
                  </div>
                )}
                {!isLoading && !isError && students.length === 0 && (
                  <div className="text-sm text-muted-foreground">
                    {t('insurance.rtm.noStudents') ||
                      'No students enrolled in this institute yet.'}
                  </div>
                )}
                {students.length > 0 && (
                  <div className="space-y-3">
                    {students.map((s) => {
                      const ct = clinicianTimeByStudent.get(s.studentId);
                      const reviewMinutes = ct ? Math.round(ct.totalSeconds / 60) : 0;
                      const hadInteractive = ct?.hadInteractive ?? false;
                      return (
                        <div
                          key={s.studentId}
                          className="grid grid-cols-12 items-center gap-3 p-3 rounded-md border bg-card"
                          data-testid={`rtm-row-${s.studentId}`}
                        >
                          <div className="col-span-3 truncate font-medium">
                            {s.studentName || s.studentId}
                          </div>
                          <div className="col-span-1 text-right tabular-nums">
                            {s.daysActive}
                            <span className="text-xs text-muted-foreground">
                              /{totalDays}
                            </span>
                          </div>
                          <div className="col-span-3">
                            <DayStrip daysActive={s.daysActive} totalDays={totalDays} />
                          </div>
                          <div className="col-span-1 text-xs text-muted-foreground tabular-nums">
                            {formatDuration(s.serviceSeconds)}
                          </div>
                          <div
                            className="col-span-2 text-xs text-muted-foreground tabular-nums"
                            data-testid={`rtm-row-${s.studentId}-review`}
                          >
                            {reviewMinutes} {t('insurance.clinTime.minShort') || 'min'}
                            {' · '}
                            {hadInteractive
                              ? (t('insurance.clinTime.interactive') || 'interactive')
                              : (t('insurance.clinTime.noInteractive') || 'no AAC')}
                          </div>
                          <div className="col-span-1 flex justify-end">
                            <RtmPill
                              daysActive={s.daysActive}
                              regime={billingRegime}
                              t={t}
                            />
                          </div>
                          <div className="col-span-1 flex justify-end">
                            <ClinicianTimePill
                              totalMinutes={reviewMinutes}
                              hadInteractive={hadInteractive}
                              regime={billingRegime}
                              t={t}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="lmn" className="space-y-4">
            <LmnTab
              instituteId={instituteId ?? null}
              regime={billingRegime}
              instituteName={currentInstitute?.name ?? null}
              instituteLogoUrl={currentInstitute?.logoUrl ?? null}
            />
          </TabsContent>

          <TabsContent value="summary" className="space-y-4">
            <BillingSummaryTab
              instituteId={instituteId ?? null}
              regime={billingRegime}
              period={period}
            />
          </TabsContent>
        </Tabs>
      </div>
    </ScrollArea>
  );
}

// =============================================================================
// LMN TAB
// =============================================================================

interface LmnTabProps {
  instituteId: string | null;
  regime: BillingRegime;
  instituteName: string | null;
  instituteLogoUrl: string | null;
}

function LmnTab({ instituteId, regime, instituteName, instituteLogoUrl }: LmnTabProps) {
  const { t } = useLanguage();
  const { student, students } = useStudent();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<LetterOfMedicalNecessity | null>(null);
  const [finalizing, setFinalizing] = useState<LetterOfMedicalNecessity | null>(null);

  const studentId = student?.id ?? null;

  const { data, isLoading, isError } = useQuery<{
    success: boolean;
    lmns: LetterOfMedicalNecessity[];
  }>({
    queryKey: ['insurance', 'lmn', 'list', instituteId, studentId],
    enabled: !!instituteId && !!studentId,
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `/api/insurance/lmn?instituteId=${encodeURIComponent(instituteId!)}&studentId=${encodeURIComponent(studentId!)}`,
      );
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/insurance/lmn', {
        instituteId,
        studentId,
      });
      return res.json() as Promise<{ success: boolean; lmn: LetterOfMedicalNecessity }>;
    },
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ['insurance', 'lmn', 'list', instituteId, studentId] });
      toast({ title: t('insurance.lmn.draftCreated') || 'Draft created' });
      setEditing(resp.lmn);
    },
    onError: (err: Error) => {
      toast({
        title: t('insurance.lmn.createFailed') || 'Failed to create LMN',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const lmns = data?.lmns ?? [];
  const studentEnrolled = !!studentId && students.some((s) => s.id === studentId);

  if (!instituteId) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {t('insurance.lmn.noInstitute') || 'Select an institute to manage LMNs.'}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="w-4 h-4" />
            {t('insurance.lmn.heading') || 'Letters of Medical Necessity'}
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          </CardTitle>
          <Button
            size="sm"
            disabled={!studentEnrolled || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            data-testid="lmn-create-btn"
          >
            {createMutation.isPending ? (
              <Loader2 className="w-4 h-4 me-1 animate-spin" />
            ) : (
              <Plus className="w-4 h-4 me-1" />
            )}
            {t('insurance.lmn.generateDraft') || 'Generate draft'}
          </Button>
        </CardHeader>
        <CardContent>
          {!student && (
            <div className="text-sm text-muted-foreground">
              {t('insurance.lmn.selectStudent') || 'Select a student to view their LMNs.'}
            </div>
          )}
          {student && !studentEnrolled && (
            <div className="text-sm text-amber-700 dark:text-amber-300">
              {t('insurance.lmn.notEnrolled') ||
                'This student is not enrolled in the current institute. LMN generation is restricted to the owning institute.'}
            </div>
          )}
          {isError && (
            <div className="text-sm text-destructive">
              {t('insurance.lmn.loadError') || 'Failed to load LMNs.'}
            </div>
          )}
          {student && studentEnrolled && !isLoading && lmns.length === 0 && (
            <div className="text-sm text-muted-foreground">
              {t('insurance.lmn.empty') || 'No LMNs yet — generate a draft to get started.'}
            </div>
          )}
          {lmns.length > 0 && (
            <div className="space-y-2">
              {lmns.map((lmn) => (
                <div
                  key={lmn.id}
                  className="flex items-center gap-3 rounded-md border p-3 bg-card"
                  data-testid={`lmn-row-${lmn.id}`}
                >
                  <div className="flex-1">
                    <div className="text-sm font-medium flex items-center gap-2">
                      {lmn.status === 'finalized' ? (
                        <Lock className="w-3 h-3 text-green-700 dark:text-green-300" />
                      ) : (
                        <FileText className="w-3 h-3 text-amber-700 dark:text-amber-300" />
                      )}
                      {lmn.status === 'finalized'
                        ? `${t('insurance.lmn.finalized') || 'Finalized'} · ${new Date(lmn.finalizedAt as unknown as string).toLocaleDateString()}`
                        : `${t('insurance.lmn.draft') || 'Draft'} · ${new Date(lmn.createdAt as unknown as string).toLocaleDateString()}`}
                    </div>
                    {lmn.signatureName && (
                      <div className="text-xs text-muted-foreground">
                        {lmn.signatureName}
                        {lmn.signatureCredentials ? `, ${lmn.signatureCredentials}` : ''}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(lmn)}
                    data-testid={`lmn-edit-${lmn.id}`}
                  >
                    {lmn.status === 'finalized'
                      ? t('insurance.lmn.view') || 'View'
                      : t('insurance.lmn.edit') || 'Edit'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      openPrintableLmn(lmn, regime, {
                        name: instituteName ?? '',
                        logoUrl: instituteLogoUrl ?? null,
                      })
                    }
                    data-testid={`lmn-print-${lmn.id}`}
                  >
                    <Printer className="w-3 h-3 me-1" />
                    {t('insurance.lmn.print') || 'Print'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {editing && (
        <LmnEditDialog
          lmn={editing}
          regime={regime}
          instituteName={instituteName}
          instituteLogoUrl={instituteLogoUrl}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(updated);
            queryClient.invalidateQueries({ queryKey: ['insurance', 'lmn', 'list', instituteId, studentId] });
          }}
          onRequestFinalize={(lmn) => {
            setEditing(null);
            setFinalizing(lmn);
          }}
        />
      )}

      {finalizing && (
        <LmnFinalizeDialog
          lmn={finalizing}
          regime={regime}
          instituteName={instituteName}
          instituteLogoUrl={instituteLogoUrl}
          onClose={() => setFinalizing(null)}
          onFinalized={(updated) => {
            setFinalizing(null);
            queryClient.invalidateQueries({ queryKey: ['insurance', 'lmn', 'list', instituteId, studentId] });
            // Open the print window straight away for the freshly-finalized LMN.
            openPrintableLmn(updated, regime, {
              name: instituteName ?? '',
              logoUrl: instituteLogoUrl ?? null,
            });
          }}
        />
      )}
    </>
  );
}

// =============================================================================
// LMN EDIT DIALOG
// =============================================================================

interface LmnEditDialogProps {
  lmn: LetterOfMedicalNecessity;
  regime: BillingRegime;
  instituteName: string | null;
  instituteLogoUrl: string | null;
  onClose: () => void;
  onSaved: (updated: LetterOfMedicalNecessity) => void;
  onRequestFinalize: (lmn: LetterOfMedicalNecessity) => void;
}

function LmnEditDialog({
  lmn,
  regime,
  instituteName,
  instituteLogoUrl,
  onClose,
  onSaved,
  onRequestFinalize,
}: LmnEditDialogProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const initialSections = lmn.sections as unknown as LmnSections;
  const [sections, setSections] = useState<LmnSections>(initialSections);
  const isFinalized = lmn.status === 'finalized';

  const setNarrative = (key: keyof LmnSections, val: string) =>
    setSections((s) => ({ ...s, [key]: val }) as LmnSections);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('PATCH', `/api/insurance/lmn/${lmn.id}`, { sections });
      return res.json() as Promise<{ success: boolean; lmn: LetterOfMedicalNecessity }>;
    },
    onSuccess: (resp) => {
      toast({ title: t('insurance.lmn.saved') || 'Saved' });
      onSaved(resp.lmn);
    },
    onError: (err: Error) => {
      toast({
        title: t('insurance.lmn.saveFailed') || 'Save failed',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {isFinalized
              ? t('insurance.lmn.viewTitle') || 'Letter of Medical Necessity (Finalized)'
              : t('insurance.lmn.editTitle') || 'Edit Letter of Medical Necessity'}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4 max-h-[60vh] overflow-y-auto">
          <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
            <div>
              <strong>{t('insurance.lmn.patient') || 'Patient'}:</strong>{' '}
              {sections.patientId.name ?? '—'}
            </div>
            <div>
              <strong>{t('insurance.lmn.diagnosis') || 'Diagnosis'}:</strong>{' '}
              {sections.diagnosis.primary ?? '—'}
              {sections.diagnosis.primaryCode ? ` (${sections.diagnosis.primaryCode})` : ''}
            </div>
            <div>
              <strong>{t('insurance.lmn.metricsSummary') || 'Metrics'}:</strong>{' '}
              MLU {sections.metrics.mlu} · NDW {sections.metrics.ndw} ·{' '}
              {sections.metrics.utteranceCount}{' '}
              {(t('insurance.lmn.utterances') || 'utterances').toLowerCase()}
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('insurance.lmn.severity') || 'Impairment severity'}</Label>
            <Textarea
              value={sections.severityNarrative}
              onChange={(e) => setNarrative('severityNarrative', e.target.value)}
              rows={4}
              disabled={isFinalized}
              data-testid="lmn-severity"
            />
          </div>

          <div className="space-y-2">
            <Label>{t('insurance.lmn.ruleOut') || 'Rule-out of natural communication modes'}</Label>
            <Textarea
              value={sections.ruleOutNarrative}
              onChange={(e) => setNarrative('ruleOutNarrative', e.target.value)}
              rows={4}
              disabled={isFinalized}
              data-testid="lmn-ruleout"
            />
          </div>

          <div className="space-y-2">
            <Label>{t('insurance.lmn.rationale') || 'Device selection rationale'}</Label>
            <Textarea
              value={sections.rationaleNarrative}
              onChange={(e) => setNarrative('rationaleNarrative', e.target.value)}
              rows={4}
              disabled={isFinalized}
              data-testid="lmn-rationale"
            />
          </div>

          <div className="space-y-2">
            <Label>{t('insurance.lmn.goals') || 'Goals & expected outcomes'}</Label>
            <Textarea
              value={sections.goalsNarrative}
              onChange={(e) => setNarrative('goalsNarrative', e.target.value)}
              rows={4}
              disabled={isFinalized}
              data-testid="lmn-goals"
            />
          </div>

          <div className="space-y-2">
            <Label>{t('insurance.lmn.attestation') || 'Clinician attestation'}</Label>
            <Textarea
              value={sections.attestationNarrative}
              onChange={(e) => setNarrative('attestationNarrative', e.target.value)}
              rows={4}
              disabled={isFinalized}
              data-testid="lmn-attestation"
            />
          </div>
        </DialogBody>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('common.close') || 'Close'}
          </Button>
          {!isFinalized && (
            <>
              <Button
                variant="outline"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                data-testid="lmn-save"
              >
                {saveMutation.isPending && <Loader2 className="w-4 h-4 me-1 animate-spin" />}
                {t('insurance.lmn.save') || 'Save draft'}
              </Button>
              <Button
                onClick={() => onRequestFinalize({ ...lmn, sections: sections as any })}
                data-testid="lmn-finalize"
              >
                <Lock className="w-4 h-4 me-1" />
                {t('insurance.lmn.finalizeAndPrint') || 'Finalize & Print'}
              </Button>
            </>
          )}
          <Button
            variant="outline"
            onClick={() =>
              openPrintableLmn(
                { ...lmn, sections: sections as any },
                regime,
                { name: instituteName ?? '', logoUrl: instituteLogoUrl ?? null },
              )
            }
          >
            <Printer className="w-4 h-4 me-1" />
            {t('insurance.lmn.preview') || 'Preview'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// LMN FINALIZE DIALOG
// =============================================================================

interface LmnFinalizeDialogProps {
  lmn: LetterOfMedicalNecessity;
  regime: BillingRegime;
  instituteName: string | null;
  instituteLogoUrl: string | null;
  onClose: () => void;
  onFinalized: (updated: LetterOfMedicalNecessity) => void;
}

function LmnFinalizeDialog({ lmn, onClose, onFinalized }: LmnFinalizeDialogProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [signatureName, setSignatureName] = useState('');
  const [signatureCredentials, setSignatureCredentials] = useState('');
  const [signatureLicense, setSignatureLicense] = useState('');

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', `/api/insurance/lmn/${lmn.id}/finalize`, {
        signatureName: signatureName.trim(),
        signatureCredentials: signatureCredentials.trim() || null,
        signatureLicense: signatureLicense.trim() || null,
      });
      return res.json() as Promise<{ success: boolean; lmn: LetterOfMedicalNecessity }>;
    },
    onSuccess: (resp) => {
      toast({ title: t('insurance.lmn.finalizeSuccess') || 'LMN finalized' });
      onFinalized(resp.lmn);
    },
    onError: (err: Error) => {
      toast({
        title: t('insurance.lmn.finalizeFailed') || 'Finalize failed',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('insurance.lmn.finalizeTitle') || 'Finalize LMN'}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="text-sm text-muted-foreground">
            {t('insurance.lmn.finalizeDesc') ||
              'Stamp the signature placeholder fields and lock the document. Finalized LMNs cannot be edited; create a new draft if revisions are needed.'}
          </div>
          <div className="space-y-2">
            <Label htmlFor="lmn-sig-name">
              {t('insurance.lmn.signatureName') || 'Clinician name'}
            </Label>
            <Input
              id="lmn-sig-name"
              value={signatureName}
              onChange={(e) => setSignatureName(e.target.value)}
              autoFocus
              data-testid="lmn-sig-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lmn-sig-creds">
              {t('insurance.lmn.signatureCredentials') || 'Credentials (e.g. SLP, M.A. CCC-SLP)'}
            </Label>
            <Input
              id="lmn-sig-creds"
              value={signatureCredentials}
              onChange={(e) => setSignatureCredentials(e.target.value)}
              data-testid="lmn-sig-creds"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lmn-sig-license">
              {t('insurance.lmn.signatureLicense') || 'License number (optional)'}
            </Label>
            <Input
              id="lmn-sig-license"
              value={signatureLicense}
              onChange={(e) => setSignatureLicense(e.target.value)}
              data-testid="lmn-sig-license"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel') || 'Cancel'}
          </Button>
          <Button
            disabled={!signatureName.trim() || finalizeMutation.isPending}
            onClick={() => finalizeMutation.mutate()}
            data-testid="lmn-confirm-finalize"
          >
            {finalizeMutation.isPending && <Loader2 className="w-4 h-4 me-1 animate-spin" />}
            <Lock className="w-4 h-4 me-1" />
            {t('insurance.lmn.confirmFinalize') || 'Finalize'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// BILLING SUMMARY TAB
// =============================================================================

interface BillingSummaryRow {
  studentId: string;
  studentName: string;
  daysActive: number;
  serviceSeconds: number;
  reviewMinutes: number;
  hadInteractive: boolean;
  rtmCode: string | null;
  clinTimeCode: string | null;
  clinTimeBlocked: boolean;
  lmnStatus: 'finalized' | 'draft' | 'none';
  lmnDate: string | null;
}

function csvEscape(val: string): string {
  if (/[",\n]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function downloadCsv(rows: BillingSummaryRow[], period: string, regimeLabel: string) {
  const headers = [
    'Student',
    'Days active',
    'Service time (sec)',
    'Review minutes',
    'Had interactive AAC',
    'RTM code',
    'Clinician time code',
    'Clinician time blocked',
    'Latest LMN status',
    'Latest LMN date',
  ];
  const lines = [
    `Insurance Bridge — Billing Summary (${regimeLabel}, ${period})`,
    headers.map(csvEscape).join(','),
    ...rows.map((r) =>
      [
        r.studentName,
        r.daysActive,
        r.serviceSeconds,
        r.reviewMinutes,
        r.hadInteractive ? 'yes' : 'no',
        r.rtmCode ?? '',
        r.clinTimeCode ?? '',
        r.clinTimeBlocked ? 'yes' : 'no',
        r.lmnStatus,
        r.lmnDate ?? '',
      ]
        .map((v) => csvEscape(String(v)))
        .join(','),
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `insurance-billing-${period}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface BillingSummaryTabProps {
  instituteId: string | null;
  regime: BillingRegime;
  period: string;
}

function BillingSummaryTab({ instituteId, regime, period }: BillingSummaryTabProps) {
  const { t } = useLanguage();
  const regimeCfg = useMemo(() => getBillingRegimeConfig(regime), [regime]);

  const enabled = !!instituteId;

  const { data: rtmData, isLoading: rtmLoading } = useQuery<RtmRollupResponse>({
    queryKey: ['insurance', 'rtm', instituteId, period],
    enabled,
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `/api/insurance/rtm?instituteId=${encodeURIComponent(instituteId!)}&period=${encodeURIComponent(period)}`,
      );
      return res.json();
    },
  });

  const { data: ctData, isLoading: ctLoading } = useQuery<ClinicianTimeResponse>({
    queryKey: ['insurance', 'clinician-time', instituteId, period],
    enabled,
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `/api/insurance/clinician-time?instituteId=${encodeURIComponent(instituteId!)}&period=${encodeURIComponent(period)}`,
      );
      return res.json();
    },
  });

  const { data: lmnData, isLoading: lmnLoading } = useQuery<{
    success: boolean;
    lmns: LetterOfMedicalNecessity[];
  }>({
    queryKey: ['insurance', 'lmn', 'institute', instituteId],
    enabled,
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `/api/insurance/lmn?instituteId=${encodeURIComponent(instituteId!)}`,
      );
      return res.json();
    },
  });

  const rows = useMemo<BillingSummaryRow[]>(() => {
    const ctByStudent = new Map<string, ClinicianTimeStudentRollup>();
    for (const r of ctData?.rollup.students ?? []) ctByStudent.set(r.studentId, r);

    // Pick the most recent LMN per student that touches the period — prefer
    // finalized over draft when both exist in the window.
    const latestLmnByStudent = new Map<
      string,
      { status: 'finalized' | 'draft'; date: string }
    >();
    const [yearStr, monthStr] = period.split('-');
    const periodStart = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, 1));
    const periodEnd = new Date(Date.UTC(Number(yearStr), Number(monthStr), 1));
    for (const lmn of lmnData?.lmns ?? []) {
      const stamp =
        lmn.status === 'finalized' && lmn.finalizedAt ? lmn.finalizedAt : lmn.createdAt;
      const at = new Date(stamp as unknown as string);
      if (at < periodStart || at >= periodEnd) continue;
      const existing = latestLmnByStudent.get(lmn.studentId);
      const candidate = {
        status: lmn.status as 'finalized' | 'draft',
        date: at.toISOString(),
      };
      if (!existing) {
        latestLmnByStudent.set(lmn.studentId, candidate);
      } else if (existing.status !== 'finalized' && candidate.status === 'finalized') {
        latestLmnByStudent.set(lmn.studentId, candidate);
      } else if (existing.status === candidate.status && candidate.date > existing.date) {
        latestLmnByStudent.set(lmn.studentId, candidate);
      }
    }

    return (rtmData?.rollup.students ?? []).map<BillingSummaryRow>((s) => {
      const ct = ctByStudent.get(s.studentId);
      const reviewMinutes = ct ? Math.round(ct.totalSeconds / 60) : 0;
      const hadInteractive = ct?.hadInteractive ?? false;
      const rtmRule = resolveRtmCode(regime, s.daysActive);
      const ctRes = resolveClinicianTimeCode(regime, reviewMinutes, hadInteractive);
      const lmn = latestLmnByStudent.get(s.studentId);
      return {
        studentId: s.studentId,
        studentName: s.studentName ?? s.studentId,
        daysActive: s.daysActive,
        serviceSeconds: s.serviceSeconds,
        reviewMinutes,
        hadInteractive,
        rtmCode: rtmRule?.code ?? null,
        clinTimeCode: ctRes.rule?.code ?? null,
        clinTimeBlocked: ctRes.blockedByInteractive,
        lmnStatus: lmn?.status ?? 'none',
        lmnDate: lmn?.date ?? null,
      };
    });
  }, [rtmData, ctData, lmnData, regime, period]);

  const isLoading = rtmLoading || ctLoading || lmnLoading;
  const isEmpty = !isLoading && rows.length === 0;

  if (regime === 'none') {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {t('insurance.summary.noRegime') ||
            'No billing regime is configured for this institute. Set the license\'s billingRegime to enable the summary.'}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          {t('insurance.summary.heading') || 'Monthly billing summary'}
          {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          disabled={isEmpty || isLoading}
          onClick={() => downloadCsv(rows, period, regimeCfg.label)}
          data-testid="billing-summary-csv"
        >
          <Download className="w-4 h-4 me-1" />
          {t('insurance.summary.exportCsv') || 'Export CSV'}
        </Button>
      </CardHeader>
      <CardContent>
        {isEmpty && (
          <div className="text-sm text-muted-foreground">
            {t('insurance.summary.empty') || 'No billable activity for this period.'}
          </div>
        )}
        {!isEmpty && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pe-3">{t('insurance.summary.student') || 'Student'}</th>
                  <th className="py-2 pe-3 tabular-nums">{t('insurance.summary.days') || 'Days'}</th>
                  <th className="py-2 pe-3 tabular-nums">{t('insurance.summary.review') || 'Review min'}</th>
                  <th className="py-2 pe-3">{t('insurance.summary.interactive') || 'Interactive'}</th>
                  <th className="py-2 pe-3">{t('insurance.summary.rtm') || 'RTM'}</th>
                  <th className="py-2 pe-3">{t('insurance.summary.clinTime') || 'Clinician time'}</th>
                  <th className="py-2 pe-3">{t('insurance.summary.lmn') || 'LMN'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.studentId}
                    className="border-b last:border-0"
                    data-testid={`billing-row-${r.studentId}`}
                  >
                    <td className="py-2 pe-3 truncate max-w-[200px]">{r.studentName}</td>
                    <td className="py-2 pe-3 tabular-nums">{r.daysActive}</td>
                    <td className="py-2 pe-3 tabular-nums">{r.reviewMinutes}</td>
                    <td className="py-2 pe-3 text-xs">
                      {r.hadInteractive
                        ? (t('insurance.clinTime.interactive') || 'interactive')
                        : (t('insurance.clinTime.noInteractive') || 'no AAC')}
                    </td>
                    <td className="py-2 pe-3">
                      {r.rtmCode ? (
                        <span className="font-mono text-xs">{r.rtmCode}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 pe-3">
                      {r.clinTimeCode ? (
                        <span className="font-mono text-xs">{r.clinTimeCode}</span>
                      ) : r.clinTimeBlocked ? (
                        <span className="text-xs text-amber-700 dark:text-amber-300">
                          {t('insurance.clinTime.blocked') || 'No interaction'}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 pe-3">
                      {r.lmnStatus === 'finalized' ? (
                        <span className="text-xs text-green-700 dark:text-green-300">
                          {t('insurance.lmn.finalized') || 'Finalized'}
                        </span>
                      ) : r.lmnStatus === 'draft' ? (
                        <span className="text-xs text-amber-700 dark:text-amber-300">
                          {t('insurance.lmn.draft') || 'Draft'}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
