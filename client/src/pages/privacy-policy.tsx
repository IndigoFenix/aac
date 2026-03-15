import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function PrivacyPolicy() {
  const { language } = useLanguage();

  return (
    <div className="min-h-screen w-full bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={language === 'he' ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${language === 'he' ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Lock className="w-6 h-6" />
              {language === 'he' ? 'מדיניות פרטיות' : 'Privacy Policy'}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${language === 'he' ? 'text-right' : 'text-left'}`} dir={language === 'he' ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {language === 'he' ? 'עודכן לאחרונה: 15 במרץ, 2026' : 'Last updated: March 15, 2026'}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {language === 'he' ? 'זהות הבקר וממונה הגנת המידע' : 'Identity of the Controller & DPO'}</h3>
                  <p>
                    <strong>Aivota Ltd. (In Formation)</strong>, located at 4 Bental, Kfar Yona, Israel, is the data controller.
                  </p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>Data Protection Officer (DPO):</strong> In compliance with Amendment 13, as we process sensitive health data at scale, we have appointed a DPO. You may contact our DPO at <a href="mailto:dpo@aivota.com" className="text-primary hover:underline">dpo@aivota.com</a>
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {language === 'he' ? 'איסוף מידע ובסיס חוקי' : 'Information Collection & Legal Basis'}</h3>
                  <p>
                    We collect information under <strong>Section 11 of the Israeli Privacy Protection Law</strong>. Providing this information is <strong>voluntary</strong>; however, failure to provide it will prevent the use of the Aivota platform.
                  </p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>Sensitive Data:</strong> We collect medical diagnoses (e.g., Rett Syndrome), physical capabilities, and eye-movement data. <strong>Explicit, granular consent</strong> is required for this collection.
                    </li>
                    <li>
                      <strong>Generative AI Training:</strong> In accordance with <strong>California AB 2013</strong>, we disclose that our AI models are trained on proprietary AAC interaction logs and licensed linguistic datasets. We do not use your personal private conversations to train "Global" models without an additional, specific opt-in.
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {language === 'he' ? 'מטרות העיבוד' : 'Purpose of Processing'}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>To facilitate real-time communication for non-verbal users.</li>
                    <li>To calibrate and personalize dynamic AAC boards.</li>
                    <li>To improve our <strong>Proprietary Symbol Set</strong> (using de-identified, aggregated data).</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {language === 'he' ? 'שיתוף מידע וצדדים שלישיים' : 'Data Sharing & Third Parties'}</h3>
                  <p>We do not "sell" your data. We share data only with:</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>Cloud Providers:</strong> Secure servers (AWS/Google Cloud).
                    </li>
                    <li>
                      <strong>Healthcare Professionals:</strong> Only upon your specific request and authorization.
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {language === 'he' ? 'הזכויות שלך (ישראל וארה"ב)' : 'Your Rights (Israel & US)'}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>Access & Correction:</strong> You have the right to inspect your data per Section 13 of the Israeli Law.
                    </li>
                    <li>
                      <strong>Right to Deletion:</strong> You may request data deletion. Under the <strong>California Delete Act (2026)</strong>, we honor requests submitted via the <strong>DROP (Delete Request and Opt-Out Platform)</strong>.
                    </li>
                    <li>
                      <strong>Automated Decision-Making:</strong> You have the right to receive information about the logic behind our AI's communication predictions (per 2026 CCPA updates).
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {language === 'he' ? 'אבטחת מידע ושמירה' : 'Data Security & Retention'}</h3>
                  <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>We adhere to the <strong>Israeli Privacy Protection Regulations (Data Security) 5777-2017</strong>.</li>
                    <li>Data is encrypted both at rest and in transit.</li>
                    <li><strong>Retention:</strong> We retain sensitive health data only as long as your account is active or as required by law.</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">7. {language === 'he' ? 'העברת מידע בינלאומית' : 'International Data Transfer'}</h3>
                  <p>
                    If data is transferred outside of Israel, it is done so in accordance with the <strong>Transfer of Data Regulations (5761-2001)</strong>, ensuring the recipient country provides an adequate level of protection (e.g., EU/UK/US adequacy).
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
