// The platform-wide "Beta" marker.
//
// One component so every in-progress feature is flagged the SAME way: a
// clinician who learns the badge once recognises it anywhere, and turning the
// whole platform's beta styling (or wording) over later is a one-file edit.
// Anything still changing under the user's feet — an app whose behaviour we
// expect to revise, a setting whose shape isn't settled — wears one.
//
// Usage: drop it beside the label it qualifies, never on its own line.
//   <Label>{t('aacSettings.appNatureHike')}</Label>
//   <BetaBadge />

import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';

export function BetaBadge({
  className,
  size = 'sm',
}: {
  className?: string;
  /** `sm` sits next to a row label; `md` next to a section title. */
  size?: 'sm' | 'md';
}) {
  const { t } = useLanguage();
  return (
    <Badge
      variant="outline"
      title={t('common.betaHint')}
      data-testid="badge-beta"
      className={cn(
        // Amber rather than a theme colour: "not finished yet" should read as a
        // caution everywhere, including inside sections that recolour Badge.
        'shrink-0 border-amber-500/50 bg-amber-500/10 font-semibold uppercase tracking-wide',
        'text-amber-700 dark:text-amber-300',
        size === 'sm' ? 'px-1.5 py-0 text-[10px] leading-4' : 'px-2 py-0.5 text-xs',
        className,
      )}
    >
      {t('common.beta')}
    </Badge>
  );
}
