import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function TermsOfService() {
  const { t, isRTL } = useLanguage();

  return (
    <div className="min-h-screen w-full bg-background py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={isRTL ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${isRTL ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Shield className="w-6 h-6" />
              {t('legal.terms.title')}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${isRTL ? 'text-right' : 'text-left'}`} dir={isRTL ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {t('legal.terms.lastUpdated')}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {t('legal.terms.section1Heading')}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>{t('legal.terms.section1Clause1Label')}</strong> {t('legal.terms.section1Clause1BodyPre')}<strong>{t('legal.terms.section1Clause1BodyTerm')}</strong>{t('legal.terms.section1Clause1BodyPost')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section1Clause2Label')}</strong> {t('legal.terms.section1Clause2BodyPre')}<strong>{t('legal.terms.section1Clause2BodyTerm')}</strong>{t('legal.terms.section1Clause2BodyPost')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section1Clause3Label')}</strong> {t('legal.terms.section1Clause3Body')}
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {t('legal.terms.section2Heading')}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>{t('legal.terms.section2Clause1Label')}</strong> {t('legal.terms.section2Clause1BodyPre')}<strong>{t('legal.terms.section2Clause1BodyTerm')}</strong>{t('legal.terms.section2Clause1BodyPost')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section2Clause2Label')}</strong> {t('legal.terms.section2Clause2Body')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section2Clause3Label')}</strong> {t('legal.terms.section2Clause3Body')}
                    </p>
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>{t('legal.terms.section2Item1Pre')}<strong>{t('legal.terms.section2Item1Term')}</strong>{t('legal.terms.section2Item1Post')}</li>
                      <li>{t('legal.terms.section2Item2')}</li>
                      <li>{t('legal.terms.section2Item3')}</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {t('legal.terms.section3Heading')}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>{t('legal.terms.section3Clause1Label')}</strong> {t('legal.terms.section3Clause1Body')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section3Clause2Label')}</strong> {t('legal.terms.section3Clause2BodyPre')}<strong>{t('legal.terms.section3Clause2BodyTerm1')}</strong>{t('legal.terms.section3Clause2BodyMid')}<strong>{t('legal.terms.section3Clause2BodyTerm2')}</strong>{t('legal.terms.section3Clause2BodyPost')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section3Clause3Label')}</strong> {t('legal.terms.section3Clause3Body')}
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {t('legal.terms.section4Heading')}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>{t('legal.terms.section4Clause1Label')}</strong> {t('legal.terms.section4Clause1BodyPre')}<strong>{t('legal.terms.section4Clause1BodyTerm1')}</strong>{t('legal.terms.section4Clause1BodyMid')}<strong>{t('legal.terms.section4Clause1BodyTerm2')}</strong>{t('legal.terms.section4Clause1BodyPost')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section4Clause2Label')}</strong> {t('legal.terms.section4Clause2Body')}
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {t('legal.terms.section5Heading')}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>{t('legal.terms.section5Clause1Label')}</strong> {t('legal.terms.section5Clause1BodyPre')}<strong>{t('legal.terms.section5Clause1BodyTerm')}</strong>{t('legal.terms.section5Clause1BodyPost')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section5Clause2Label')}</strong> {t('legal.terms.section5Clause2Body')}
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {t('legal.terms.section6Heading')}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>{t('legal.terms.section6Clause1Label')}</strong> {t('legal.terms.section6Clause1BodyPre')}<strong>{t('legal.terms.section6Clause1BodyTerm1')}</strong>{t('legal.terms.section6Clause1BodyMid')}<strong>{t('legal.terms.section6Clause1BodyTerm2')}</strong>{t('legal.terms.section6Clause1BodyPost')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section6Clause2Label')}</strong> {t('legal.terms.section6Clause2BodyPre')}<strong>{t('legal.terms.section6Clause2BodyTerm')}</strong>{t('legal.terms.section6Clause2BodyPost')}
                    </p>
                    <p>
                      <strong>{t('legal.terms.section6Clause3Label')}</strong> {t('legal.terms.section6Clause3Body')}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
