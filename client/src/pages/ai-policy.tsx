import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Brain } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function AIPolicy() {
  const { t, isRTL } = useLanguage();

  return (
    <div className="min-h-screen w-full bg-background py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={isRTL ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${isRTL ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Brain className="w-6 h-6" />
              {t('legal.aiPolicy.title')}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${isRTL ? 'text-right' : 'text-left'}`} dir={isRTL ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {t('legal.aiPolicy.lastUpdated')}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {t('legal.aiPolicy.introHeading')}</h3>
                  <p>
                    {t('legal.aiPolicy.introText')}
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {t('legal.aiPolicy.usesHeading')}</h3>
                  <p>{t('legal.aiPolicy.usesIntro')}</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.aiPolicy.usesBoardsTitle')}</strong> {t('legal.aiPolicy.usesBoardsDesc')}
                    </li>
                    <li>
                      <strong>{t('legal.aiPolicy.usesInteractionTitle')}</strong> {t('legal.aiPolicy.usesInteractionDesc')}
                    </li>
                    <li>
                      <strong>{t('legal.aiPolicy.usesMonitoringTitle')}</strong> {t('legal.aiPolicy.usesMonitoringDesc')}
                    </li>
                    <li>
                      <strong>{t('legal.aiPolicy.usesClinicalTitle')}</strong> {t('legal.aiPolicy.usesClinicalDesc')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {t('legal.aiPolicy.providersHeading')}</h3>
                  <p>{t('legal.aiPolicy.providersIntro')}</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>Google (Gemini):</strong> {t('legal.aiPolicy.providerGoogleDesc')}
                    </li>
                    <li>
                      <strong>OpenAI:</strong> {t('legal.aiPolicy.providerOpenAIDesc')}
                    </li>
                    <li>
                      <strong>Anthropic (Claude):</strong> {t('legal.aiPolicy.providerAnthropicDesc')}
                    </li>
                  </ul>
                  <p className="mt-2">
                    {t('legal.aiPolicy.providersNote')}
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {t('legal.aiPolicy.oversightHeading')}</h3>
                  <p>
                    {t('legal.aiPolicy.oversightIntroPre')}<strong>{t('legal.aiPolicy.oversightIntroStrong')}</strong>{t('legal.aiPolicy.oversightIntroPost')}
                  </p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>{t('legal.aiPolicy.oversightItem1')}</li>
                    <li>{t('legal.aiPolicy.oversightItem2')}</li>
                    <li>{t('legal.aiPolicy.oversightItem3')}</li>
                    <li>{t('legal.aiPolicy.oversightItem4')}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {t('legal.aiPolicy.transparencyHeading')}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>{t('legal.aiPolicy.transparencyItem1')}</li>
                    <li>{t('legal.aiPolicy.transparencyItem2')}</li>
                    <li>{t('legal.aiPolicy.transparencyItem3Pre')}<strong>{t('legal.aiPolicy.transparencyItem3Strong')}</strong>{t('legal.aiPolicy.transparencyItem3Post')}</li>
                    <li>{t('legal.aiPolicy.transparencyItem4Pre')}<a href="mailto:ai@aivota.com" className="text-primary underline underline-offset-2">ai@aivota.com</a>{t('legal.aiPolicy.transparencyItem4Post')}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {t('legal.aiPolicy.dataHeading')}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>{t('legal.aiPolicy.dataItem1Pre')}<a href="/privacy-policy" className="text-primary underline underline-offset-2">{t('legal.aiPolicy.dataItem1LinkText')}</a>{t('legal.aiPolicy.dataItem1Post')}</li>
                    <li>{t('legal.aiPolicy.dataItem2')}</li>
                    <li>{t('legal.aiPolicy.dataItem3')}</li>
                    <li>{t('legal.aiPolicy.dataItem4')}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">7. {t('legal.aiPolicy.limitationsHeading')}</h3>
                  <p>{t('legal.aiPolicy.limitationsIntro')}</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>{t('legal.aiPolicy.limitationsItem1')}</li>
                    <li>{t('legal.aiPolicy.limitationsItem2Pre')}<strong>{t('legal.aiPolicy.limitationsItem2Strong')}</strong>{t('legal.aiPolicy.limitationsItem2Post')}</li>
                    <li>{t('legal.aiPolicy.limitationsItem3')}</li>
                    <li>{t('legal.aiPolicy.limitationsItem4')}</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">8. {t('legal.aiPolicy.rightsHeading')}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>{t('legal.aiPolicy.rightsOptOutTitle')}</strong> {t('legal.aiPolicy.rightsOptOutDesc')}
                    </li>
                    <li>
                      <strong>{t('legal.aiPolicy.rightsAccessTitle')}</strong> {t('legal.aiPolicy.rightsAccessDesc')}
                    </li>
                    <li>
                      <strong>{t('legal.aiPolicy.rightsCorrectionTitle')}</strong> {t('legal.aiPolicy.rightsCorrectionDesc')}
                    </li>
                    <li>
                      <strong>{t('legal.aiPolicy.rightsObjectionTitle')}</strong> {t('legal.aiPolicy.rightsObjectionDesc')}
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">9. {t('legal.aiPolicy.updatesHeading')}</h3>
                  <p>
                    {t('legal.aiPolicy.updatesTextPre')}<a href="mailto:ai@aivota.com" className="text-primary underline underline-offset-2">ai@aivota.com</a>{t('legal.aiPolicy.updatesTextPost')}
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
