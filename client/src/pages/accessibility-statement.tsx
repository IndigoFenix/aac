import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Accessibility } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function AccessibilityStatement() {
  const { language } = useLanguage();
  const he = language === 'he';

  return (
    <div className="min-h-screen w-full bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={he ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${he ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Accessibility className="w-6 h-6" />
              {he ? 'הצהרת נגישות' : 'Accessibility Statement'}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${he ? 'text-right' : 'text-left'}`} dir={he ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {he ? 'עודכן לאחרונה: 15 במרץ, 2026' : 'Last updated: March 15, 2026'}
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
                      האתר והפלטפורמה מבוססת האינטרנט שלנו מתוכננים לעמוד ב<strong>הנחיות הנגישות לתוכן אינטרנט (WCAG) 2.1 ברמה AA</strong>, שהוא התקן הנדרש על ידי <strong>תקן ישראלי (ת"י) 5568</strong> ומוכר תחת <strong>חוק האמריקאים עם מוגבלויות (ADA)</strong> בארה"ב.
                    </p>
                  ) : (
                    <p>
                      Our website and web-based platform are designed to conform to the <strong>Web Content Accessibility Guidelines (WCAG) 2.1 at Level AA</strong>, which is the standard required by <strong>Israeli Standard (IS) 5568</strong> and recognized under the <strong>U.S. Americans with Disabilities Act (ADA)</strong>.
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
                        <li><strong>רכז נגישות:</strong> עופר סוחמי</li>
                        <li><strong>דוא"ל:</strong> <a href="mailto:accessibility@aivota.ai" className="text-primary hover:underline">accessibility@aivota.ai</a></li>
                        <li><strong>טלפון:</strong> +972542271326</li>
                        <li><strong>כתובת דואר:</strong> בנטל 4, כפר יונה, ישראל</li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>
                        If you encounter any accessibility barriers or require information in an alternative format, please contact our <strong>Accessibility Coordinator</strong>. We are committed to addressing all issues within a reasonable timeframe.
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li><strong>Accessibility Coordinator:</strong> Opher Suhami</li>
                        <li><strong>Email:</strong> <a href="mailto:accessibility@aivota.ai" className="text-primary hover:underline">accessibility@aivota.ai</a></li>
                        <li><strong>Phone:</strong> +972542271326</li>
                        <li><strong>Mailing Address:</strong> 4 Bental, Kfar Yona, Israel</li>
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
