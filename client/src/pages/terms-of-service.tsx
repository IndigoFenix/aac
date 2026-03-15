import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function TermsOfService() {
  const { language } = useLanguage();

  return (
    <div className="min-h-screen w-full bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={language === 'he' ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${language === 'he' ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Shield className="w-6 h-6" />
              {language === 'he' ? 'תנאי שימוש' : 'Terms of Service'}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${language === 'he' ? 'text-right' : 'text-left'}`} dir={language === 'he' ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {language === 'he' ? 'עודכן לאחרונה: 15 במרץ, 2026' : 'Last updated: March 15, 2026'}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {language === 'he' ? 'אופי השירות והסתייגות רפואית' : 'Nature of the Service and Medical Disclaimer'}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>1.1. Assistive Tool Only:</strong> Aivota provides an Artificial Intelligence-driven communication moderator and a <strong>Proprietary Symbol Set</strong> designed to assist individuals with communication impairments.
                    </p>
                    <p>
                      <strong>1.2. Not a Medical Device:</strong> You acknowledge that <strong>Aivota is not a medical device</strong>, and its outputs do not constitute medical advice, diagnosis, or treatment. It is intended solely as a functional communication aid.
                    </p>
                    <p>
                      <strong>1.3. AI Limitations:</strong> The service utilizes Generative AI which may occasionally produce "hallucinations" or inaccurate predictions. Caregivers must supervise use, especially in critical safety or medical contexts.
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {language === 'he' ? 'קניין רוחני ורישיון שימוש' : 'Intellectual Property & License Grant'}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>2.1. Ownership:</strong> Aivota (and/or its founder, Opher Suhami, pending full incorporation) owns all rights, title, and interest in the software, the AI models, and the <strong>Proprietary Symbol Set</strong> (the "IP").
                    </p>
                    <p>
                      <strong>2.2. Limited License:</strong> We grant you a personal, non-exclusive, non-transferable, and revocable license to use the IP solely for the purpose of personal communication through the Aivota platform.
                    </p>
                    <p>
                      <strong>2.3. Strict Restrictions:</strong> You shall not:
                    </p>
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>Extract, copy, or redistribute the <strong>Proprietary Symbol Set</strong> outside of the platform.</li>
                      <li>Use the IP to train, develop, or improve any third-party AI models or AAC systems.</li>
                      <li>Reverse-engineer or "scrape" the platform's code or content.</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {language === 'he' ? 'הגבלת אחריות ואחריות' : 'Liability and Warranty Disclaimers'}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>3.1. "As-Is" Basis:</strong> The service is provided "As-Is." To the extent permitted by law, Aivota disclaims all warranties, express or implied.
                    </p>
                    <p>
                      <strong>3.2. Liability Cap:</strong> In accordance with <strong>Israeli Standard Contracts Law (2026)</strong> and U.S. commercial standards, Aivota's total liability for any claim shall be limited to the amount actually paid by you for the service during the <strong>12 months</strong> preceding the claim.
                    </p>
                    <p>
                      <strong>3.3. Exclusion:</strong> We are not liable for any communication errors, emotional distress, or consequential damages resulting from AI-generated outputs.
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {language === 'he' ? 'שקיפות AI (תאימות ארה"ב - CA/TX/CO)' : 'AI Transparency (U.S. Compliance - CA/TX/CO)'}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>4.1. Disclosure:</strong> In compliance with <strong>California AB 2013</strong> and <strong>Texas TRAIGA (2026)</strong>, we disclose that this system uses generative AI trained on large datasets to predict and generate communication boards.
                    </p>
                    <p>
                      <strong>4.2. Human-in-the-Loop:</strong> We encourage "Human-in-the-loop" verification for all critical communications.
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {language === 'he' ? 'סיום' : 'Termination'}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>5.1. Mutual Right:</strong> Either party may terminate this agreement at any time with <strong>30 days</strong> written notice.
                    </p>
                    <p>
                      <strong>5.2. Immediate Breach:</strong> Aivota reserves the right to suspend access immediately if it detects unauthorized scraping or IP theft related to the Proprietary Symbol Set.
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {language === 'he' ? 'הדין החל וסמכות שיפוט' : 'Governing Law and Jurisdiction'}</h3>
                  <div className="space-y-3">
                    <p>
                      <strong>6.1. Israeli Users:</strong> This agreement is governed by the laws of the <strong>State of Israel</strong>. Pursuant to <strong>Amendment No. 3 to the Contracts Law (2026)</strong>, the written text of this agreement shall be the primary source of interpretation. Exclusive jurisdiction lies with the courts of Tel Aviv-Jaffa.
                    </p>
                    <p>
                      <strong>6.2. U.S. Users:</strong> Disputes shall be governed by the laws of the <strong>State of Delaware</strong> (or your state of incorporation).
                    </p>
                    <p>
                      <strong>6.3. Class Action Waiver:</strong> To the extent permitted by law, you agree to resolve disputes on an individual basis and waive any right to participate in a class-action lawsuit.
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
