// src/components/BudgetMeters.tsx
// Live AAC token-budget usage meters. Renders one bar per rolling window,
// computed from the persisted leaky-bucket snapshot + the (selected) tier's
// windows. Shared by the admin budget editor and the read-only AAC Settings
// view so the two stay in lockstep.

import { budgetReadings, type BudgetState } from '@shared/aac/budget-meter';
import { tierByKey, windowsForTier } from '@shared/aac/budget-tiers';
import { useLanguage } from '@/contexts/LanguageContext';

// Compact "~2h 5m" style refill duration for the budget meters. Largest two
// units, translated unit suffixes passed in (so it stays locale-correct).
function formatBudgetRefill(mins: number, u: { d: string; h: string; m: string }): string {
  if (mins <= 0) return '';
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `~${days}${u.d}${hours > 0 ? ` ${hours}${u.h}` : ''}`;
  if (hours > 0) return `~${hours}${u.h}${m > 0 ? ` ${m}${u.m}` : ''}`;
  return `~${m}${u.m}`;
}

interface BudgetMetersProps {
  meters: BudgetState | undefined | null;
  /** Tier key to scale the windows by ("" / null = deployment default). */
  tierKey: string | null;
}

export function BudgetMeters({ meters, tierKey }: BudgetMetersProps) {
  const { t } = useLanguage();
  const readings = budgetReadings(
    (meters ?? {}) as BudgetState,
    windowsForTier(tierByKey(tierKey)),
    Date.now(),
  );

  return (
    <div className="space-y-3">
      {readings.map((r) => {
        const refill = r.refillMinutes <= 0
          ? t('aacSettings.budgetFull')
          : `${formatBudgetRefill(r.refillMinutes, {
              d: t('aacSettings.budgetUnitDay'),
              h: t('aacSettings.budgetUnitHour'),
              m: t('aacSettings.budgetUnitMinute'),
            })} ${t('aacSettings.budgetUntilFull')}`;
        const barColor = r.band === 'low' ? 'bg-red-500' : r.band === 'moderate' ? 'bg-amber-500' : 'bg-emerald-500';
        return (
          <div key={r.key} className="space-y-1" data-testid={`budget-meter-${r.key}`}>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t(`aacSettings.budgetWindow${r.key}`)}</span>
              <span className="tabular-nums">{r.percent}% · {refill}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div className={`h-full rounded-full ${barColor}`} style={{ width: `${r.percent}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
