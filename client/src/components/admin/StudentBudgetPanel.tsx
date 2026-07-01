// src/components/admin/StudentBudgetPanel.tsx
// Admin: view + edit one student's AAC token-budget settings (tier + the
// attention/facilitator/live-model cost controls) and view their live usage.

import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  useStudentBudget,
  useStudentBudgetMutations,
  type StudentBudget,
} from '@/hooks/useAdminData';
import { useLanguage } from '@/contexts/LanguageContext';
import { BUDGET_TIERS, tierByKey } from '@shared/aac/budget-tiers';
import { BudgetMeters } from '@/components/BudgetMeters';

function studentDisplayName(s: StudentBudget): string {
  const name = [s.firstName, s.lastName].filter(Boolean).join(' ').trim();
  return name || s.name || s.id;
}

interface StudentBudgetPanelProps {
  licenseId: string;
  studentId: string;
}

export function StudentBudgetPanel({ licenseId, studentId }: StudentBudgetPanelProps) {
  const { t, isRTL } = useLanguage();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data: budget, isLoading, error } = useStudentBudget(studentId);
  const { updateBudget } = useStudentBudgetMutations();

  const [budgetTier, setBudgetTier] = useState('');
  const [fullAttentionMode, setFullAttentionMode] = useState(false);
  const [boardManagerLiveModel, setBoardManagerLiveModel] = useState(false);
  const [allowFacilitatorControl, setAllowFacilitatorControl] = useState(false);

  useEffect(() => {
    if (budget) {
      setBudgetTier(budget.budgetTier || '');
      setFullAttentionMode(budget.fullAttentionMode ?? false);
      setBoardManagerLiveModel(budget.boardManagerLiveModel ?? false);
      setAllowFacilitatorControl(budget.allowFacilitatorControl ?? false);
    }
  }, [budget]);

  const hasChanges = budget != null && (
    budgetTier !== (budget.budgetTier || '') ||
    fullAttentionMode !== (budget.fullAttentionMode ?? false) ||
    boardManagerLiveModel !== (budget.boardManagerLiveModel ?? false) ||
    allowFacilitatorControl !== (budget.allowFacilitatorControl ?? false)
  );

  const handleSave = async () => {
    try {
      await updateBudget.mutateAsync({
        studentId,
        data: {
          budgetTier: budgetTier || null,
          fullAttentionMode,
          boardManagerLiveModel,
          allowFacilitatorControl,
        },
      });
      toast({ title: t('admin.budget.saved') });
    } catch (err: any) {
      toast({
        title: t('common.error'),
        description: err.message || t('admin.budget.saveError'),
        variant: 'destructive',
      });
    }
  };

  const BackIcon = isRTL ? ChevronRight : ChevronLeft;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !budget) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-destructive">{t('admin.budget.loadError')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 -ms-2"
          onClick={() => navigate(`/admin/licenses/${licenseId}/students`)}
          data-testid="button-back-to-students"
        >
          <BackIcon className="w-4 h-4 me-1" />
          {t('admin.budget.backToStudents')}
        </Button>
        <h1 className="text-2xl font-bold">{studentDisplayName(budget)}</h1>
        <p className="text-muted-foreground">{t('admin.budget.editSubtitle')}</p>
      </div>

      {/* Budget tier + cost controls */}
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.budget.settingsTitle')}</CardTitle>
          <CardDescription>{t('admin.budget.settingsDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Tier */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-base font-medium">{t('aacSettings.budgetTier')}</Label>
              <p className="text-sm text-muted-foreground">{t('aacSettings.budgetTierDesc')}</p>
            </div>
            <Select value={budgetTier || '_default'} onValueChange={(v) => setBudgetTier(v === '_default' ? '' : v)}>
              <SelectTrigger className="w-full md:w-[220px]" data-testid="select-budget-tier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_default">
                  {t('aacSettings.budgetTierDefault')} ({tierByKey('').key.charAt(0).toUpperCase() + tierByKey('').key.slice(1)})
                </SelectItem>
                {Object.values(BUDGET_TIERS).map((tier) => (
                  <SelectItem key={tier.key} value={tier.key}>
                    {tier.key.charAt(0).toUpperCase() + tier.key.slice(1)} — ${tier.priceMonthly}/mo
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Full attention mode */}
          <div className="flex items-center justify-between pt-4 border-t">
            <div className="space-y-0.5">
              <Label className="text-base font-medium">{t('aacSettings.fullAttentionMode')}</Label>
              <p className="text-sm text-muted-foreground">{t('aacSettings.fullAttentionModeDesc')}</p>
            </div>
            <Switch
              checked={fullAttentionMode}
              onCheckedChange={setFullAttentionMode}
              data-testid="switch-full-attention-mode"
            />
          </div>

          {/* Allow facilitator control */}
          <div className="flex items-center justify-between pt-4 border-t">
            <div className="space-y-0.5">
              <Label className="text-base font-medium">{t('aacSettings.allowFacilitatorControl')}</Label>
              <p className="text-sm text-muted-foreground">{t('aacSettings.allowFacilitatorControlDesc')}</p>
            </div>
            <Switch
              checked={allowFacilitatorControl}
              onCheckedChange={setAllowFacilitatorControl}
              data-testid="switch-allow-facilitator-control"
            />
          </div>

          {/* Board Manager live model */}
          <div className="flex items-center justify-between pt-4 border-t">
            <div className="space-y-0.5">
              <Label className="text-base font-medium">{t('aacSettings.boardManagerLiveModel')}</Label>
              <p className="text-sm text-muted-foreground">{t('aacSettings.boardManagerLiveModelDesc')}</p>
            </div>
            <Switch
              checked={boardManagerLiveModel}
              onCheckedChange={setBoardManagerLiveModel}
              data-testid="switch-board-manager-live-model"
            />
          </div>
        </CardContent>
      </Card>

      {/* Usage meters — previews the SELECTED tier's caps against the persisted
          usage snapshot, so changing the tier above previews the new bars. */}
      <Card>
        <CardHeader>
          <CardTitle>{t('aacSettings.budgetMetersTitle')}</CardTitle>
          <CardDescription>{t('aacSettings.budgetMetersDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <BudgetMeters meters={budget.budgetMeters} tierKey={budgetTier || null} />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!hasChanges || updateBudget.isPending} data-testid="button-save-budget">
          {updateBudget.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
