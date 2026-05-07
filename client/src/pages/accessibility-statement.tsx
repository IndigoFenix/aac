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
const COORDINATOR_EMAIL = import.meta.env.VITE_ACCESSIBILITY_COORDINATOR_EMAIL || "accessibility@aivota.ai";
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
  const { language } = useLanguage();
  const he = language === 'he';
  const { accessibilityStandard, bundles, regimes } = useRegimes();

  const standardLabel = STANDARD_LABELS[accessibilityStandard][he ? 'he' : 'en'];
  const lastUpdated = he ? LAST_UPDATED_HE : LAST_UPDATED_EN;
  const coordinatorAddress = he ? COORDINATOR_ADDRESS_HE : COORDINATOR_ADDRESS_EN;

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
          <CardHeader className={he ? 'text-right' : 'text-left'}>
            <div className={`flex items-start justify-between gap-4 ${he ? 'flex-row-reverse' : ''}`}>
              <CardTitle className={`flex items-center gap-3 ${he ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
                <Accessibility className="w-6 h-6" />
                {he ? 'הצהרת נגישות' : 'Accessibility Statement'}
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.print()}
                className="accessibility-statement-actions"
                aria-label={he ? 'הדפס או שמור כ-PDF' : 'Print or save as PDF'}
              >
                <Printer className="w-4 h-4 me-2" />
                {he ? 'הדפס / שמור כ-PDF' : 'Print / Save as PDF'}
              </Button>
            </div>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${he ? 'text-right' : 'text-left'}`} dir={he ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {he ? 'עודכן לאחרונה: ' : 'Last updated: '}{lastUpdated}
                </div>

                {/* Compliance summary — populated from the active institute's regime */}
                <div className="rounded-md border bg-muted/30 p-4">
                  <div className="font-semibold mb-2">
                    {he ? 'סיכום עמידה בתקן' : 'Compliance Summary'}
                  </div>
                  <dl className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-4">
                    <dt className="font-medium">{he ? 'תקן נגישות:' : 'Accessibility standard:'}</dt>
                    <dd>{standardLabel}</dd>
                    {bundles.length > 0 && (
                      <>
                        <dt className="font-medium">{he ? 'משטרי ציות:' : 'Compliance regimes:'}</dt>
                        <dd>{bundles.map(b => b.label).join(' · ')}</dd>
                      </>
                    )}
                    {regimes.length === 0 && (
                      <>
                        <dt className="font-medium">{he ? 'משטרי ציות:' : 'Compliance regimes:'}</dt>
                        <dd className="text-muted-foreground">{he ? '(ברירת מחדל גלובלית)' : '(global default)'}</dd>
                      </>
                    )}
                  </dl>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {he ? 'המחויבות שלנו לנגישות' : 'Our Commitment to Accessibility'}</h3>
                  {he ? (
                    <p>
                      ב-<strong>Aivota</strong>, אנו מאמינים שתקשורת היא זכות אנושית בסיסית. אנו מחויבים להבטיח שהאתר ופלטפורמת ה-AAC שלנו נגישים לכולם, ללא קשר ליכולותיהם הפיזיות או הקוגניטיביות. אנו משקיעים משאבים משמעותיים כדי להפוך את הממשק הדיגיטלי שלנו לאינטואיטיבי ותואם למגוון הרחב ביותר של טכנולוגיות מסייעות.
                    </p>
                  ) : (
                    <p>
                      At <strong>Aivota</strong>, we believe that communication is a fundamental human right. We are dedicated to ensuring that our website and AAC platform are accessible to everyone, regardless of their physical or cognitive abilities. We invest significant resources into making our digital interface intuitive and compatible with the widest possible range of assistive technologies.
                    </p>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {he ? 'סטטוס תאימות' : 'Compliance Status'}</h3>
                  {he ? (
                    <p>
                      האתר והפלטפורמה מבוססת האינטרנט שלנו מתוכננים לעמוד ב<strong>{standardLabel}</strong>.
                    </p>
                  ) : (
                    <p>
                      Our website and web-based platform are designed to conform to <strong>{standardLabel}</strong>.
                    </p>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {he ? 'תכונות נגישות ב-Aivota' : 'Accessibility Features on Aivota'}</h3>
                  {he ? (
                    <>
                      <p>יישמנו את התכונות הבאות לתמיכה בצרכי משתמשים מגוונים:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>שילוב AAC וסמלים:</strong> הפלטפורמה שלנו משתמשת בסמלים קנייניים בניגודיות גבוהה שתוכננו במיוחד עבור משתמשים עם לקויות ראייה.
                        </li>
                        <li>
                          <strong>אופטימיזציית מעקב עיניים:</strong> הממשק מכויל לשימוש חלק עם חומרה ותוכנה מובילות למעקב מבט (למשל, Tobii Dynavox, Smartbox).
                        </li>
                        <li>
                          <strong>ניווט מקלדת:</strong> ניתן לבצע את כל הפונקציות החיוניות באמצעות מקלדת או מכשיר גישת מתג.
                        </li>
                        <li>
                          <strong>תמיכה בקוראי מסך:</strong> אנו משתמשים בתכונות ARIA (Accessible Rich Internet Applications) כדי להבטיח תאימות עם קוראי מסך כגון NVDA ו-VoiceOver.
                        </li>
                        <li>
                          <strong>טקסט חלופי:</strong> כל התמונות המשמעותיות כוללות טקסט חלופי תיאורי (alt-text).
                        </li>
                      </ul>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {he ? 'מגבלות ידועות' : 'Known Limitations'}</h3>
                  {he ? (
                    <>
                      <p>למרות שאנו שואפים לנגישות של 100%, ייתכן שחלק מהאזורים עדיין בתהליך אופטימיזציה:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>שילובי צד שלישי (למשל, פידים מוטמעים של רשתות חברתיות) עשויים להכיל מגבלות מעבר לשליטתנו הישירה.</li>
                        <li>מסמכים ישנים שהועלו לפני מרץ 2026 עשויים שלא להיות מתויגים במלואם עבור קוראי מסך.</li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>While we strive for 100% accessibility, some areas may still be in the process of optimization:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>Third-party integrations (e.g., embedded social media feeds) may have limitations beyond our direct control.</li>
                        <li>Legacy documents uploaded before March 2026 may not be fully tagged for screen readers.</li>
                      </ul>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {he ? 'צור קשר לסיוע' : 'Contact Us for Assistance'}</h3>
                  {he ? (
                    <>
                      <p>
                        אם נתקלת במחסומי נגישות או זקוק/ה למידע בפורמט חלופי, אנא פנה/י ל<strong>רכז/ת הנגישות</strong> שלנו. אנו מחויבים לטיפול בכל הבעיות במסגרת זמן סבירה.
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li><strong>רכז נגישות:</strong> {COORDINATOR_NAME}</li>
                        <li><strong>דוא"ל:</strong> <a href={`mailto:${COORDINATOR_EMAIL}`} className="text-primary underline underline-offset-2">{COORDINATOR_EMAIL}</a></li>
                        <li><strong>טלפון:</strong> {COORDINATOR_PHONE}</li>
                        <li><strong>כתובת דואר:</strong> {coordinatorAddress}</li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>
                        If you encounter any accessibility barriers or require information in an alternative format, please contact our <strong>Accessibility Coordinator</strong>. We are committed to addressing all issues within a reasonable timeframe.
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li><strong>Accessibility Coordinator:</strong> {COORDINATOR_NAME}</li>
                        <li><strong>Email:</strong> <a href={`mailto:${COORDINATOR_EMAIL}`} className="text-primary underline underline-offset-2">{COORDINATOR_EMAIL}</a></li>
                        <li><strong>Phone:</strong> {COORDINATOR_PHONE}</li>
                        <li><strong>Mailing Address:</strong> {coordinatorAddress}</li>
                      </ul>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {he ? 'משוב ודיווח' : 'Feedback and Reporting'}</h3>
                  {he ? (
                    <>
                      <p>אנו מקבלים בברכה את המשוב שלך על אופן השיפור. בעת דיווח על מחסום, אנא כלול/י:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>כתובת URL של דף האינטרנט או מסך האפליקציה.</li>
                        <li>תיאור הבעיה.</li>
                        <li>הטכנולוגיה המסייעת שבה השתמשת (אם רלוונטי).</li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>We welcome your feedback on how to improve. When reporting a barrier, please include:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>The web page URL or app screen.</li>
                        <li>A description of the problem.</li>
                        <li>The assistive technology you were using (if any).</li>
                      </ul>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
