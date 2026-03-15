import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Accessibility } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function AccessibilityStatement() {
  const { language } = useLanguage();

  return (
    <div className="min-h-screen w-full bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={language === 'he' ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${language === 'he' ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Accessibility className="w-6 h-6" />
              {language === 'he' ? 'הצהרת נגישות' : 'Accessibility Statement'}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${language === 'he' ? 'text-right' : 'text-left'}`} dir={language === 'he' ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {language === 'he' ? 'עודכן לאחרונה: 15 במרץ, 2026' : 'Last updated: March 15, 2026'}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {language === 'he' ? 'המחויבות שלנו לנגישות' : 'Our Commitment to Accessibility'}</h3>
                  <p>
                    At <strong>Aivota</strong>, we believe that communication is a fundamental human right. We are dedicated to ensuring that our website and AAC platform are accessible to everyone, regardless of their physical or cognitive abilities. We invest significant resources into making our digital interface intuitive and compatible with the widest possible range of assistive technologies.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {language === 'he' ? 'סטטוס תאימות' : 'Compliance Status'}</h3>
                  <p>
                    Our website and web-based platform are designed to conform to the <strong>Web Content Accessibility Guidelines (WCAG) 2.1 at Level AA</strong>, which is the standard required by <strong>Israeli Standard (IS) 5568</strong> and recognized under the <strong>U.S. Americans with Disabilities Act (ADA)</strong>.
                  </p>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {language === 'he' ? 'תכונות נגישות ב-Aivota' : 'Accessibility Features on Aivota'}</h3>
                  <p>We have implemented the following features to support diverse user needs:</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>
                      <strong>AAC & Symbol Integration:</strong> Our platform uses high-contrast proprietary symbols specifically designed for users with visual impairments.
                    </li>
                    <li>
                      <strong>Eye-Tracking Optimization:</strong> The interface is calibrated for seamless use with major eye-gaze hardware and software (e.g., Tobii Dynavox, Smartbox).
                    </li>
                    <li>
                      <strong>Keyboard Navigation:</strong> All essential functions can be performed using a keyboard or switch-access device.
                    </li>
                    <li>
                      <strong>Screen Reader Support:</strong> We utilize ARIA (Accessible Rich Internet Applications) attributes to ensure compatibility with screen readers like NVDA and VoiceOver.
                    </li>
                    <li>
                      <strong>Alternative Text:</strong> All meaningful images include descriptive alternative text (alt-text).
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {language === 'he' ? 'מגבלות ידועות' : 'Known Limitations'}</h3>
                  <p>While we strive for 100% accessibility, some areas may still be in the process of optimization:</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>Third-party integrations (e.g., embedded social media feeds) may have limitations beyond our direct control.</li>
                    <li>Legacy documents uploaded before March 2026 may not be fully tagged for screen readers.</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {language === 'he' ? 'צור קשר לסיוע' : 'Contact Us for Assistance'}</h3>
                  <p>
                    If you encounter any accessibility barriers or require information in an alternative format, please contact our <strong>Accessibility Coordinator</strong>. We are committed to addressing all issues within a reasonable timeframe.
                  </p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li><strong>Accessibility Coordinator:</strong> Opher Suhami</li>
                    <li><strong>Email:</strong> <a href="mailto:accessibility@aivota.ai" className="text-primary hover:underline">accessibility@aivota.ai</a></li>
                    <li><strong>Phone:</strong> +972542271326</li>
                    <li><strong>Mailing Address:</strong> 4 Bental, Kfar Yona, Israel</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {language === 'he' ? 'משוב ודיווח' : 'Feedback and Reporting'}</h3>
                  <p>We welcome your feedback on how to improve. When reporting a barrier, please include:</p>
                  <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                    <li>The web page URL or app screen.</li>
                    <li>A description of the problem.</li>
                    <li>The assistive technology you were using (if any).</li>
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
