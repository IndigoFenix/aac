// src/components/billing/LicenseBillingCard.tsx
//
// The customer-facing view of ONE license: what state it is in, what it costs,
// when it runs out, and the button that pays for it.
//
// The button is the only part with subtlety. `POST /api/licenses/:id/checkout`
// creates the Paddle transaction SERVER-side — the client never names a price,
// because an organisation's price is quoted individually and lives on its
// license row. The client's whole job is to hand the returned transactionId to
// paddle-js and then re-read its own state, since the WEBHOOK, not this
// component, is what flips the license to paid.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Check, CreditCard, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { apiRequest, ServiceUnavailableError } from '@/lib/queryClient';
import { usePaddle } from '@/hooks/usePaddle';
import {
  useLicenseBilling,
  formatDate,
  formatMoney,
  type LicenseBillingInfo,
} from '@/hooks/useLicenseBilling';

/** `throwIfResNotOk` packs the body into the message as "<status>: <body>", so
 *  a server `{ error: 'CODE' }` has to be dug back out of it. */
function extractErrorCode(err: unknown): string | null {
  const raw = (err as { message?: string })?.message || '';
  const colonIdx = raw.indexOf(': ');
  if (colonIdx <= 0) return null;
  try {
    const parsed = JSON.parse(raw.substring(colonIdx + 2));
    return parsed.error || null;
  } catch {
    return null;
  }
}

interface LicenseBillingCardProps {
  /** Restrict the card to one kind of license holder. The institute panel
   *  passes 'institute'; the settings page passes 'user', so a member of an
   *  organisation isn't shown their org's billing in their personal settings. */
  scope?: LicenseBillingInfo['scope'];
  className?: string;
}

export function LicenseBillingCard({ scope, className }: LicenseBillingCardProps) {
  const { t, language } = useLanguage();
  const { toast } = useToast();
  const { info, refresh } = useLicenseBilling();
  const { ready, openCheckout } = usePaddle();
  const [starting, setStarting] = useState(false);
  // 'confirming' spans the gap between Paddle's CHECKOUT_COMPLETED (fired the
  // instant the card is charged) and our WEBHOOK landing (a few seconds later,
  // and that is what actually flips the row). Re-reading once at completion
  // read the row too early and showed the old state — so we snapshot what we
  // paid FROM and poll until the server disagrees with it.
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'confirmed'>('idle');
  const snapshot = useRef<{ status: string; expiresAt: string | null } | null>(null);

  useEffect(() => {
    if (phase !== 'confirming' || !info) return;
    const before = snapshot.current;
    const changed =
      !before || info.status !== before.status || info.expiresAt !== before.expiresAt;
    if (changed && info.status === 'active') {
      setPhase('confirmed');
      toast({ title: t('billing.confirmed'), description: t('billing.paymentCompleteDesc') });
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 60_000) {
        clearInterval(timer);
        setPhase('idle');
        toast({ title: t('billing.paymentComplete'), description: t('billing.confirmTimeout') });
        return;
      }
      void refresh();
    }, 2_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, info?.status, info?.expiresAt]);

  if (!info) return null;
  if (scope && info.scope !== scope) return null;

  // A perpetual, live license has nothing to say and nothing to sell. Anything
  // with an end date keeps the card so the customer can see the date.
  if (info.status === 'active' && !info.expiresAt && phase === 'idle') return null;

  // Null price = invoice customer. They still see where they stand; they just
  // have no self-serve price to be charged.
  const purchasable = info.priceAmount !== null && info.canManage;
  const isRenewal = info.status === 'active' || info.status === 'expired';

  const statusLabel =
    info.status === 'active'
      ? t('billing.statusActive')
      : info.status === 'trial'
        ? t('billing.statusTrial')
        : info.status === 'expired'
          ? t('billing.statusExpired')
          : t('billing.statusNone');

  const statusVariant =
    info.status === 'expired' ? 'destructive' : info.status === 'trial' ? 'secondary' : 'default';

  const expiryLine = (() => {
    if (!info.expiresAt) return null;
    const when = formatDate(info.expiresAt, language);
    if (info.status === 'expired') return t('billing.expiredOn', { date: when });
    if (info.status === 'trial') return t('billing.trialEnds', { date: when });
    return t('billing.paidUntil', { date: when });
  })();

  const planLabel =
    info.subscriptionType === 'yearly'
      ? t('billing.planYearly')
      : info.subscriptionType === 'monthly'
        ? t('billing.planMonthly')
        : null;

  const handlePay = async () => {
    setStarting(true);
    try {
      const res = await apiRequest('POST', `/api/licenses/${info.licenseId}/checkout`);
      const data = await res.json();
      if (!data?.transactionId) throw new Error('missing transactionId');

      snapshot.current = { status: info.status, expiresAt: info.expiresAt };
      const opened = openCheckout(data.transactionId, {
        onCompleted: () => {
          setPhase('confirming');
          void refresh();
        },
      });
      if (!opened) {
        toast({ title: t('billing.notReady'), variant: 'destructive' });
      }
    } catch (err) {
      // A 503 never reaches us with its body: queryClient converts it to a
      // ServiceUnavailableError before reading one. For THIS endpoint 503 has
      // exactly one meaning, so it is mapped rather than shown as an outage.
      const code =
        err instanceof ServiceUnavailableError
          ? 'PADDLE_NOT_CONFIGURED'
          : extractErrorCode(err) || 'UNEXPECTED_ERROR';
      toast({
        title: t('billing.checkoutFailed'),
        description: t(`errors.${code}`),
        variant: 'destructive',
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card className={className} data-testid="card-license-billing">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="w-5 h-5" />
          {t('billing.title')}
        </CardTitle>
        <CardDescription>{t('billing.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant} data-testid="badge-license-status">{statusLabel}</Badge>
          {planLabel && <Badge variant="outline">{planLabel}</Badge>}
          {info.priceAmount !== null && (
            <span className="text-sm text-muted-foreground" dir="ltr">
              {formatMoney(info.priceAmount, info.priceCurrency || 'USD', language)}
            </span>
          )}
        </div>

        {expiryLine && (
          <p className="text-sm text-muted-foreground" data-testid="text-license-expiry">
            {expiryLine}
          </p>
        )}

        {info.priceAmount === null ? (
          <p className="text-sm text-muted-foreground">{t('billing.invoiceOnly')}</p>
        ) : !info.canManage ? (
          <p className="text-sm text-muted-foreground">{t('billing.adminOnly')}</p>
        ) : null}

        {purchasable && phase === 'confirmed' ? (
          <Button disabled variant="secondary" data-testid="button-license-pay">
            <Check className="w-4 h-4 me-2" />
            {t('billing.confirmed')}
          </Button>
        ) : purchasable && phase === 'confirming' ? (
          <Button disabled data-testid="button-license-pay">
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
            {t('billing.confirming')}
          </Button>
        ) : purchasable ? (
          <Button onClick={handlePay} disabled={starting || !ready} data-testid="button-license-pay">
            {starting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {isRenewal ? t('billing.renew') : t('billing.activate')}
          </Button>
        ) : null}
        {purchasable && !ready && (
          <p className="text-xs text-muted-foreground">{t('billing.notReady')}</p>
        )}
      </CardContent>
    </Card>
  );
}
