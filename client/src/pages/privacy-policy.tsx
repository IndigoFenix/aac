import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useRegimes } from "@/hooks/useRegimes";

const LAST_UPDATED_EN = import.meta.env.VITE_PRIVACY_POLICY_LAST_UPDATED_EN || "March 15, 2026";
const LAST_UPDATED_HE = import.meta.env.VITE_PRIVACY_POLICY_LAST_UPDATED_HE || "15 במרץ, 2026";

type Translate = (key: string, params?: Record<string, string | number>) => string;

function formatRetention(days: number, t: Translate): string {
  if (days >= 365) {
    const years = Math.round(days / 365);
    return t(years === 1 ? 'legal.privacy.retentionYearsOne' : 'legal.privacy.retentionYearsOther', { years });
  }
  return t('legal.privacy.retentionDays', { days });
}

function formatBreachWindow(hours: number | null, t: Translate): string {
  if (hours === null) return t('legal.privacy.breachNotConfigured');
  if (hours >= 168) {
    const days = Math.round(hours / 24);
    return t(days === 1 ? 'legal.privacy.breachDaysOne' : 'legal.privacy.breachDaysOther', { days });
  }
  return t(hours === 1 ? 'legal.privacy.breachHoursOne' : 'legal.privacy.breachHoursOther', { hours });
}

export default function PrivacyPolicy() {
  const { language, t, isRTL } = useLanguage();
  const { bundles, regimes } = useRegimes();
  const lastUpdated = language === 'he' ? LAST_UPDATED_HE : LAST_UPDATED_EN;

  // Strictest values across the active regimes — the same resolvers used
  // server-side (regimeService) but inlined here to avoid an extra fetch.
  let maxRetentionDays = 0;
  let minBreachHours: number | null = null;
  for (const b of bundles) {
    if (b.auditRetentionDays > maxRetentionDays) maxRetentionDays = b.auditRetentionDays;
    if (minBreachHours === null || b.breachNotificationHours < minBreachHours) {
      minBreachHours = b.breachNotificationHours;
    }
  }

  return (
    <div className="min-h-screen w-full bg-background py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={isRTL ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${isRTL ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Lock className="w-6 h-6" />
              {t('legal.privacy.title')}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${isRTL ? 'text-right' : 'text-left'}`} dir={isRTL ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {t('legal.privacy.lastUpdatedLabel')}{lastUpdated}
                </div>

                {/* Regime-driven processing summary. Shows the strictest retention
                    and shortest breach window across the active institute's regimes. */}
                <div className="rounded-md border bg-muted/30 p-4">
                  <div className="font-semibold mb-2">
                    {t('legal.privacy.summaryHeading')}
                  </div>
                  <dl className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-4">
                    <dt className="font-medium">{t('legal.privacy.summaryRegimesLabel')}</dt>
                    <dd>
                      {bundles.length > 0
                        ? bundles.map((b) => b.label).join(' · ')
                        : <span className="text-muted-foreground">{t('legal.privacy.summaryGlobalDefault')}</span>}
                    </dd>
                    {regimes.length > 0 && (
                      <>
                        <dt className="font-medium">{t('legal.privacy.summaryAuditRetentionLabel')}</dt>
                        <dd>{formatRetention(maxRetentionDays, t)}</dd>
                        <dt className="font-medium">{t('legal.privacy.summaryBreachWindowLabel')}</dt>
                        <dd>{formatBreachWindow(minBreachHours, t)}</dd>
                      </>
                    )}
                  </dl>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {t('legal.privacy.section1Heading')}</h3>
                  <p>
                    <strong>{t('legal.privacy.section1ControllerName')}</strong>, {t('legal.privacy.section1ControllerAddress')}
                  </p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.privacy.section1DpoLabel')}</strong> {t('legal.privacy.section1DpoBody')} <a href="mailto:dpo@aivota.com" className="text-primary underline underline-offset-2">dpo@aivota.com</a>
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {t('legal.privacy.section2Heading')}</h3>
                  <p>
                    {t('legal.privacy.section2Intro1')}<strong>{t('legal.privacy.section2LegalBasis')}</strong>{t('legal.privacy.section2Intro2')}<strong>{t('legal.privacy.section2Voluntary')}</strong>{t('legal.privacy.section2Intro3')}
                  </p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.privacy.section2SensitiveLabel')}</strong>{t('legal.privacy.section2SensitiveBody1')}<strong>{t('legal.privacy.section2SensitiveConsent')}</strong>{t('legal.privacy.section2SensitiveBody2')}
                    </li>
                    <li>
                      <strong>{t('legal.privacy.section2AiTrainingLabel')}</strong>{t('legal.privacy.section2AiTrainingBody1')}<strong>California AB 2013</strong>{t('legal.privacy.section2AiTrainingBody2')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {t('legal.privacy.section3Heading')}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>{t('legal.privacy.section3Li1')}</li>
                    <li>{t('legal.privacy.section3Li2')}</li>
                    <li>{t('legal.privacy.section3Li3Pre')}<strong>{t('legal.privacy.section3Li3Symbol')}</strong>{t('legal.privacy.section3Li3Post')}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {t('legal.privacy.section4Heading')}</h3>
                  <p>{t('legal.privacy.section4Intro')}</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.privacy.section4CloudLabel')}</strong>{t('legal.privacy.section4CloudBody')}
                    </li>
                    <li>
                      <strong>{t('legal.privacy.section4HealthcareLabel')}</strong>{t('legal.privacy.section4HealthcareBody')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {t('legal.privacy.section5Heading')}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.privacy.section5AccessLabel')}</strong>{t('legal.privacy.section5AccessBody')}
                    </li>
                    <li>
                      <strong>{t('legal.privacy.section5DeletionLabel')}</strong>{t('legal.privacy.section5DeletionBody1')}<strong>California Delete Act (2026)</strong>{t('legal.privacy.section5DeletionBody2')}<strong>DROP (Delete Request and Opt-Out Platform)</strong>.
                    </li>
                    <li>
                      <strong>{t('legal.privacy.section5AutomatedLabel')}</strong>{t('legal.privacy.section5AutomatedBody')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {t('legal.privacy.section6Heading')}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>{t('legal.privacy.section6RegsPre')}<strong>{t('legal.privacy.section6RegsName')}</strong>.</li>
                    <li>{t('legal.privacy.section6EncryptionBody')}</li>
                    <li><strong>{t('legal.privacy.section6RetentionLabel')}</strong>{t('legal.privacy.section6RetentionBody')}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">7. {t('legal.privacy.section7Heading')}</h3>
                  <p>
                    {t('legal.privacy.section7Pre')}<strong>{t('legal.privacy.section7RegName')}</strong>{t('legal.privacy.section7Post')}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
