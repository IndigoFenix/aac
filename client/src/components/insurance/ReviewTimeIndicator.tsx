// Per-student review-time indicator for the Insurance Bridge module.
// Tiny inline display the clinician sees while in a student-scoped view, so
// the activity tracker doesn't run silently in the background.

import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Receipt } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Format a duration into the two largest meaningful units so long review
 * periods read as days/hours rather than a single large minute count.
 * e.g. 1d 2h, 3h 15m, 45m.
 */
function formatDuration(
  totalSeconds: number,
  units: { day: string; hour: string; min: string },
): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;

  if (days > 0) return `${days}${units.day} ${hours}${units.hour}`;
  if (hours > 0) return `${hours}${units.hour} ${mins}${units.min}`;
  return `${mins}${units.min}`;
}

interface Props {
  /** Hide the indicator when false. */
  enabled: boolean;
  /** Required when enabled — the institute scope for the rollup. */
  instituteId: string | null;
  /** Required when enabled — the student to display. */
  studentId: string | null;
}

interface ResponseShape {
  success: boolean;
  rollup: {
    students: Array<{
      studentId: string;
      totalSeconds: number;
      hadInteractive: boolean;
    }>;
  };
}

export function ReviewTimeIndicator({ enabled, instituteId, studentId }: Props) {
  const { t } = useLanguage();
  const period = currentPeriod();
  const isEnabled = enabled && !!instituteId && !!studentId;

  const { data } = useQuery<ResponseShape>({
    queryKey: ['insurance', 'clinician-time-indicator', instituteId, period],
    enabled: isEnabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const res = await apiRequest(
        'GET',
        `/api/insurance/clinician-time?instituteId=${encodeURIComponent(instituteId!)}&period=${encodeURIComponent(period)}`,
      );
      return res.json();
    },
  });

  if (!isEnabled || !data) return null;

  const row = data.rollup.students.find((s) => s.studentId === studentId);
  const duration = formatDuration(row?.totalSeconds ?? 0, {
    day: t('insurance.clinTime.dayShort') || 'd',
    hour: t('insurance.clinTime.hourShort') || 'h',
    min: t('insurance.clinTime.minShort') || 'min',
  });

  return (
    <div
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      data-testid="review-time-indicator"
      title={
        t('insurance.clinTime.indicatorTitle') ||
        'Clinician review time logged this month for this student. Tracking is active while you interact with the page.'
      }
    >
      <Receipt className="w-3 h-3" />
      <span>
        {duration} {t('insurance.clinTime.reviewedThisMonth') || 'reviewed this month'}
      </span>
    </div>
  );
}
