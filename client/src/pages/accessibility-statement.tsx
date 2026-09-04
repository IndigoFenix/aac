import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Accessibility, Printer } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useRegimes } from "@/hooks/useRegimes";
import type { AccessibilityStandard } from "@shared/regime";

// Build-time config (overridable via Vite env vars). Defaults are the
// platform's published coordinator contact; an institute can ship its own
// build with override values for white-label deployments.
const COORDINATOR_NAME = import.meta.env.VITE_ACCESSIBILITY_COORDINATOR_NAME || "Opher Suhami";
const COORDINATOR_EMAIL = import.meta.env.VITE_ACCESSIBILITY_COORDINATOR_EMAIL || "opher@aivota.ai";
const COORDINATOR_PHONE = import.meta.env.VITE_ACCESSIBILITY_COORDINATOR_PHONE || "+972542271326";
const COORDINATOR_ADDRESS_EN = import.meta.env.VITE_ACCESSIBILITY_COORDINATOR_ADDRESS_EN || "4 Bental, Kfar Yona, Israel";
const COORDINATOR_ADDRESS_HE = import.meta.env.VITE_ACCESSIBILITY_COORDINATOR_ADDRESS_HE || "בנטל 4, כפר יונה, ישראל";
const LAST_UPDATED_EN = import.meta.env.VITE_ACCESSIBILITY_LAST_UPDATED_EN || "March 15, 2026";
const LAST_UPDATED_HE = import.meta.env.VITE_ACCESSIBILITY_LAST_UPDATED_HE || "15 במרץ, 2026";

const STANDARD_LABELS: Record<AccessibilityStandard, { en: string; he: string }> = {
  wcag_2_1_aa: { en: "WCAG 2.1 Level AA", he: "WCAG 2.1 ברמה AA" },
  wcag_2_2_aa: { en: "WCAG 2.2 Level AA", he: "WCAG 2.2 ברמה AA" },
  il_5568: { en: 'Israeli Standard (IS) 5568 (WCAG 2.1 AA)', he: 'תקן ישראלי (ת"י) 5568 (WCAG 2.1 ברמה AA)' },
  us_section_508: { en: "US Section 508", he: "סעיף 508 בארה\"ב" },
  eu_en_301_549: { en: "EU EN 301 549", he: "EN 301 549 של האיחוד האירופי" },
  uk_pba_2018: { en: "UK Public Sector Bodies Accessibility Regs 2018", he: "תקנות הנגישות של גופים בסקטור הציבורי בבריטניה 2018" },
};

export default function AccessibilityStatement() {
  const { language, t, isRTL } = useLanguage();
  const { accessibilityStandard, bundles, regimes } = useRegimes();

  const standardLabel = STANDARD_LABELS[accessibilityStandard][language === 'he' ? 'he' : 'en'];
  const lastUpdated = language === 'he' ? LAST_UPDATED_HE : LAST_UPDATED_EN;
  const coordinatorAddress = language === 'he' ? COORDINATOR_ADDRESS_HE : COORDINATOR_ADDRESS_EN;

  return (
    <div className="min-h-screen w-full bg-background py-8 print:bg-white print:py-0">
      <style>{`
        @media print {
          /* Hide print button + browser chrome on the printed page. */
          .accessibility-statement-actions { display: none !important; }
          /* Drop the card chrome so the printable page is clean text. */
          .accessibility-statement-card {
            box-shadow: none !important;
            border: none !important;
          }
          @page { margin: 1.5cm; }
        }
      `}</style>
      <div className="max-w-4xl mx-auto px-4">
        <Card className="accessibility-statement-card">
          <CardHeader className={isRTL ? 'text-right' : 'text-left'}>
            <div className={`flex items-start justify-between gap-4 ${isRTL ? 'flex-row-reverse' : ''}`}>
              <CardTitle className={`flex items-center gap-3 ${isRTL ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
                <Accessibility className="w-6 h-6" />
                {t('legal.accessibility.title')}
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.print()}
                className="accessibility-statement-actions"
                aria-label={t('legal.accessibility.printAriaLabel')}
              >
                <Printer className="w-4 h-4 me-2" />
                {t('legal.accessibility.printButton')}
              </Button>
            </div>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${isRTL ? 'text-right' : 'text-left'}`} dir={isRTL ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {t('legal.accessibility.lastUpdatedLabel')}{lastUpdated}
                </div>

                {/* Compliance summary — populated from the active institute's regime */}
                <div className="rounded-md border bg-muted/30 p-4">
                  <div className="font-semibold mb-2">
                    {t('legal.accessibility.complianceSummaryHeading')}
                  </div>
                  <dl className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-4">
                    <dt className="font-medium">{t('legal.accessibility.accessibilityStandardLabel')}</dt>
                    <dd>{standardLabel}</dd>
                    {bundles.length > 0 && (
                      <>
                        <dt className="font-medium">{t('legal.accessibility.complianceRegimesLabel')}</dt>
                        <dd>{bundles.map(b => b.label).join(' · ')}</dd>
                      </>
                    )}
                    {regimes.length === 0 && (
                      <>
                        <dt className="font-medium">{t('legal.accessibility.complianceRegimesLabel')}</dt>
                        <dd className="text-muted-foreground">{t('legal.accessibility.globalDefault')}</dd>
                      </>
                    )}
                  </dl>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {t('legal.accessibility.commitmentHeading')}</h3>
                  <p>
                    {t('legal.accessibility.commitmentPrefix')}<strong>Aivota Ltd</strong>{t('legal.accessibility.commitmentSuffix')}
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {t('legal.accessibility.complianceStatusHeading')}</h3>
                  <p>
                    {t('legal.accessibility.conformancePrefix')}<strong>{standardLabel}</strong>.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {t('legal.accessibility.featuresHeading')}</h3>
                  <p>{t('legal.accessibility.featuresIntro')}</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.accessibility.featureAacLabel')}</strong> {t('legal.accessibility.featureAacBody')}
                    </li>
                    <li>
                      <strong>{t('legal.accessibility.featureEyeTrackingLabel')}</strong> {t('legal.accessibility.featureEyeTrackingBody')}
                    </li>
                    <li>
                      <strong>{t('legal.accessibility.featureKeyboardLabel')}</strong> {t('legal.accessibility.featureKeyboardBody')}
                    </li>
                    <li>
                      <strong>{t('legal.accessibility.featureScreenReaderLabel')}</strong> {t('legal.accessibility.featureScreenReaderBody')}
                    </li>
                    <li>
                      <strong>{t('legal.accessibility.featureAltTextLabel')}</strong> {t('legal.accessibility.featureAltTextBody')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {t('legal.accessibility.limitationsHeading')}</h3>
                  <p>{t('legal.accessibility.limitationsIntro')}</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>{t('legal.accessibility.limitationThirdParty')}</li>
                    <li>{t('legal.accessibility.limitationLegacyDocs')}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {t('legal.accessibility.contactHeading')}</h3>
                  <p>
                    {t('legal.accessibility.contactIntroPrefix')}<strong>{t('legal.accessibility.contactIntroRole')}</strong>{t('legal.accessibility.contactIntroSuffix')}
                  </p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li><strong>{t('legal.accessibility.coordinatorNameLabel')}</strong> {COORDINATOR_NAME}</li>
                    <li><strong>{t('legal.accessibility.coordinatorEmailLabel')}</strong> <a href={`mailto:${COORDINATOR_EMAIL}`} className="text-primary underline underline-offset-2">{COORDINATOR_EMAIL}</a></li>
                    <li><strong>{t('legal.accessibility.coordinatorPhoneLabel')}</strong> {COORDINATOR_PHONE}</li>
                    <li><strong>{t('legal.accessibility.coordinatorAddressLabel')}</strong> {coordinatorAddress}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {t('legal.accessibility.feedbackHeading')}</h3>
                  <p>{t('legal.accessibility.feedbackIntro')}</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>{t('legal.accessibility.feedbackUrl')}</li>
                    <li>{t('legal.accessibility.feedbackDescription')}</li>
                    <li>{t('legal.accessibility.feedbackAssistiveTech')}</li>
                  </ul>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
