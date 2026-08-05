import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Cookie } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function CookiePolicy() {
  const { t, isRTL } = useLanguage();

  return (
    <div className="min-h-screen w-full bg-background py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={isRTL ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${isRTL ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Cookie className="w-6 h-6" />
              {t('legal.cookie.title')}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${isRTL ? 'text-right' : 'text-left'}`} dir={isRTL ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {t('legal.cookie.lastUpdated')}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {t('legal.cookie.whatAreCookiesHeading')}</h3>
                  <p>
                    {t('legal.cookie.whatAreCookiesBodyPre')}<strong>Aivota</strong>{t('legal.cookie.whatAreCookiesBodyPost')}
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {t('legal.cookie.howWeUseHeading')}</h3>
                  <p>{t('legal.cookie.howWeUseIntro')}</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.cookie.essentialLabel')}</strong> {t('legal.cookie.essentialBody')}
                    </li>
                    <li>
                      <strong>{t('legal.cookie.performanceLabel')}</strong> {t('legal.cookie.performanceBody')}
                    </li>
                    <li>
                      <strong>{t('legal.cookie.personalizationLabel')}</strong> {t('legal.cookie.personalizationBody')}
                    </li>
                    <li>
                      <strong>{t('legal.cookie.aiOptimizationLabel')}</strong> {t('legal.cookie.aiOptimizationBody')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {t('legal.cookie.typesUsedHeading')}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.cookie.firstPartyLabel')}</strong> {t('legal.cookie.firstPartyBody')}
                    </li>
                    <li>
                      <strong>{t('legal.cookie.thirdPartyLabel')}</strong> {t('legal.cookie.thirdPartyBody')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {t('legal.cookie.managingPreferencesHeading')}</h3>
                  <p>
                    {t('legal.cookie.managingPreferencesIntroPre')}<strong>{t('legal.cookie.amendment13Label')}</strong>{t('legal.cookie.managingPreferencesIntroPost')}
                  </p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.cookie.consentBannerLabel')}</strong> {t('legal.cookie.consentBannerBody')}
                    </li>
                    <li>
                      <strong>{t('legal.cookie.browserSettingsLabel')}</strong> {t('legal.cookie.browserSettingsBody')}
                    </li>
                    <li>
                      <strong>Global Privacy Control (GPC):</strong> {t('legal.cookie.gpcBody')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {t('legal.cookie.retentionHeading')}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.cookie.sessionCookiesLabel')}</strong> {t('legal.cookie.sessionCookiesBody')}
                    </li>
                    <li>
                      <strong>{t('legal.cookie.persistentCookiesLabel')}</strong> {t('legal.cookie.persistentCookiesBody')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {t('legal.cookie.contactHeading')}</h3>
                  <p>{t('legal.cookie.contactIntro')}</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li><strong>{t('legal.cookie.dpoEmailLabel')}</strong> <a href="mailto:dpo@aivota.ai" className="text-primary underline underline-offset-2">dpo@aivota.ai</a></li>
                    <li><strong>{t('legal.cookie.addressLabel')}</strong> {t('legal.cookie.addressValue')}</li>
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
