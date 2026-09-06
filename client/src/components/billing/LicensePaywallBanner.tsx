// src/components/billing/LicensePaywallBanner.tsx
//
// A slim strip under the header for the two states a customer must not
// discover by finding a feature missing: the license has EXPIRED, or a trial is
// about to.
//
// It does NOT block anything. The server already strips permissions when a
// license lapses, so the UI's job here is to explain why things went quiet and
// point at the billing card — a client-side hard block would only add a second,
// divergent copy of the entitlement rule.
//
// Dismissal is per SESSION (sessionStorage, keyed by license + state): an
// expiry notice that a click silences forever is a notice that does not work,
// but one that reappears on every render is worse. The key carries the state so
// dismissing "trial ends in 5 days" does not also silence the later expiry.

import { useState } from 'react';
import { AlertTriangle, Clock, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { useLicenseBilling, daysUntil } from '@/hooks/useLicenseBilling';

/** A trial gets a warning only inside this window. */
const TRIAL_WARNING_DAYS = 7;

function dismissKey(licenseId: string, state: string): string {
  return `aivota.billingBanner.${licenseId}.${state}`;
}

function wasDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    // Private-mode/storage-blocked browsers throw on access. The banner showing
    // is the safe failure here.
    return false;
  }
}

export function LicensePaywallBanner() {
  const { t } = useLanguage();
  const { setActiveFeature } = useFeaturePanel();
  const { info } = useLicenseBilling();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  if (!info) return null;

  const days = daysUntil(info.expiresAt);
  const isExpired = info.status === 'expired';
  const isTrialEnding =
    info.status === 'trial' && days !== null && days <= TRIAL_WARNING_DAYS;

  if (!isExpired && !isTrialEnding) return null;

  const state = isExpired ? 'expired' : 'trial';
  const key = dismissKey(info.licenseId, state);
  if (dismissedKey === key || wasDismissed(key)) return null;

  const message = isExpired
    ? t('billing.banner.expired')
    : days !== null && days <= 0
      ? t('billing.banner.trialEndsToday')
      : days === 1
        ? t('billing.banner.trialEndsTomorrow')
        : t('billing.banner.trialEndsIn', { days: String(days) });

  const dismiss = () => {
    setDismissedKey(key);
    try {
      sessionStorage.setItem(key, '1');
    } catch {
      /* storage blocked — the local state still hides it for this mount */
    }
  };

  // Where the billing card actually lives depends on who holds the license.
  const goToBilling = () => setActiveFeature(info.scope === 'institute' ? 'institute' : 'settings');

  return (
    <div
      role="status"
      data-testid="banner-license-paywall"
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-sm border-b',
        isExpired
          ? 'bg-destructive/10 border-destructive/30 text-destructive'
          : 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200',
      )}
    >
      {isExpired ? (
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      ) : (
        <Clock className="w-4 h-4 flex-shrink-0" />
      )}
      <span className="flex-1 min-w-0 truncate">{message}</span>
      {/* Plain button, not <Button variant="link">: this project's Button has no
          "link" variant (the type union rejects it). */}
      <button
        type="button"
        className="underline font-medium whitespace-nowrap flex-shrink-0"
        onClick={goToBilling}
        data-testid="button-banner-billing"
      >
        {t('billing.banner.viewBilling')}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('billing.banner.dismiss')}
        className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 flex-shrink-0"
        data-testid="button-banner-dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
