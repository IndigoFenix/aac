import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useRegimes } from "@/hooks/useRegimes";

const LAST_UPDATED_EN = import.meta.env.VITE_PRIVACY_POLICY_LAST_UPDATED_EN || "March 15, 2026";
const LAST_UPDATED_HE = import.meta.env.VITE_PRIVACY_POLICY_LAST_UPDATED_HE || "15 במרץ, 2026";

function formatRetention(days: number, he: boolean): string {
  if (days >= 365) {
    const years = Math.round(days / 365);
    return he ? `${years} שנים` : `${years} year${years === 1 ? '' : 's'}`;
  }
  return he ? `${days} ימים` : `${days} days`;
}

function formatBreachWindow(hours: number | null, he: boolean): string {
  if (hours === null) return he ? 'לא הוגדר' : 'not configured';
  if (hours >= 168) {
    const days = Math.round(hours / 24);
    return he ? `${days} ימים` : `${days} day${days === 1 ? '' : 's'}`;
  }
  return he ? `${hours} שעות` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

export default function PrivacyPolicy() {
  const { language } = useLanguage();
  const he = language === 'he';
  const { bundles, regimes } = useRegimes();
  const lastUpdated = he ? LAST_UPDATED_HE : LAST_UPDATED_EN;

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
          <CardHeader className={he ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${he ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Lock className="w-6 h-6" />
              {he ? 'מדיניות פרטיות' : 'Privacy Policy'}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${he ? 'text-right' : 'text-left'}`} dir={he ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {he ? 'עודכן לאחרונה: ' : 'Last updated: '}{lastUpdated}
                </div>

                {/* Regime-driven processing summary. Shows the strictest retention
                    and shortest breach window across the active institute's regimes. */}
                <div className="rounded-md border bg-muted/30 p-4">
                  <div className="font-semibold mb-2">
                    {he ? 'סיכום עיבוד נתונים' : 'Data Processing Summary'}
                  </div>
                  <dl className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-4">
                    <dt className="font-medium">{he ? 'משטרי ציות:' : 'Compliance regimes:'}</dt>
                    <dd>
                      {bundles.length > 0
                        ? bundles.map((b) => b.label).join(' · ')
                        : <span className="text-muted-foreground">{he ? '(ברירת מחדל גלובלית)' : '(global default)'}</span>}
                    </dd>
                    {regimes.length > 0 && (
                      <>
                        <dt className="font-medium">{he ? 'שמירת לוג ביקורת:' : 'Audit log retention:'}</dt>
                        <dd>{formatRetention(maxRetentionDays, he)}</dd>
                        <dt className="font-medium">{he ? 'חלון הודעת פריצה:' : 'Breach-notification window:'}</dt>
                        <dd>{formatBreachWindow(minBreachHours, he)}</dd>
                      </>
                    )}
                  </dl>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {he ? 'זהות הבקר וממונה הגנת המידע' : 'Identity of the Controller & DPO'}</h3>
                  {he ? (
                    <>
                      <p>
                        <strong>Aivota Ltd. (בהקמה)</strong>, הממוקמת ברחוב בנטל 4, כפר יונה, ישראל, היא בעלת השליטה על הנתונים.
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>ממונה הגנת מידע (DPO):</strong> בהתאם לתיקון 13, מאחר שאנו מעבדים נתוני בריאות רגישים בקנה מידה נרחב, מינינו ממונה הגנת מידע. ניתן ליצור קשר עם הממונה בכתובת <a href="mailto:dpo@aivota.com" className="text-primary underline underline-offset-2">dpo@aivota.com</a>
                        </li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>
                        <strong>Aivota Ltd. (In Formation)</strong>, located at 4 Bental, Kfar Yona, Israel, is the data controller.
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>Data Protection Officer (DPO):</strong> In compliance with Amendment 13, as we process sensitive health data at scale, we have appointed a DPO. You may contact our DPO at <a href="mailto:dpo@aivota.com" className="text-primary underline underline-offset-2">dpo@aivota.com</a>
                        </li>
                      </ul>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {he ? 'איסוף מידע ובסיס חוקי' : 'Information Collection & Legal Basis'}</h3>
                  {he ? (
                    <>
                      <p>
                        אנו אוספים מידע בהתאם ל<strong>סעיף 11 לחוק הגנת הפרטיות הישראלי</strong>. מסירת מידע זה היא <strong>וולונטרית</strong>; עם זאת, אי-מסירתו תמנע שימוש בפלטפורמת Aivota.
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>נתונים רגישים:</strong> אנו אוספים אבחנות רפואיות (למשל, תסמונת רט), יכולות פיזיות ונתוני תנועת עיניים. נדרשת <strong>הסכמה מפורשת ופרטנית</strong> לאיסוף זה.
                        </li>
                        <li>
                          <strong>אימון בינה מלאכותית גנרטיבית:</strong> בהתאם ל-<strong>California AB 2013</strong>, אנו מגלים כי מודלי הבינה המלאכותית שלנו אומנו על יומני אינטראקציה קנייניים של AAC ומאגרי נתונים לשוניים מורשים. איננו משתמשים בשיחותיך הפרטיות לאימון מודלים "גלובליים" ללא הסכמה נוספת וספציפית.
                        </li>
                      </ul>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {he ? 'מטרות העיבוד' : 'Purpose of Processing'}</h3>
                  {he ? (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>לאפשר תקשורת בזמן אמת למשתמשים שאינם מילוליים.</li>
                      <li>לכייל ולהתאים אישית לוחות AAC דינמיים.</li>
                      <li>לשפר את <strong>סט הסמלים הקנייני</strong> שלנו (תוך שימוש בנתונים מזוהים ומצטברים).</li>
                    </ul>
                  ) : (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>To facilitate real-time communication for non-verbal users.</li>
                      <li>To calibrate and personalize dynamic AAC boards.</li>
                      <li>To improve our <strong>Proprietary Symbol Set</strong> (using de-identified, aggregated data).</li>
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {he ? 'שיתוף מידע וצדדים שלישיים' : 'Data Sharing & Third Parties'}</h3>
                  {he ? (
                    <>
                      <p>איננו "מוכרים" את הנתונים שלך. אנו משתפים נתונים רק עם:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>ספקי ענן:</strong> שרתים מאובטחים (AWS/Google Cloud).
                        </li>
                        <li>
                          <strong>אנשי מקצוע בתחום הבריאות:</strong> רק על פי בקשתך והרשאתך הספציפית.
                        </li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>We do not "sell" your data. We share data only with:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>Cloud Providers:</strong> Secure servers (AWS/Google Cloud).
                        </li>
                        <li>
                          <strong>Healthcare Professionals:</strong> Only upon your specific request and authorization.
                        </li>
                      </ul>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {he ? 'הזכויות שלך (ישראל וארה"ב)' : 'Your Rights (Israel & US)'}</h3>
                  {he ? (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>
                        <strong>גישה ותיקון:</strong> יש לך זכות לעיין בנתוניך בהתאם לסעיף 13 לחוק הישראלי.
                      </li>
                      <li>
                        <strong>זכות למחיקה:</strong> באפשרותך לבקש מחיקת נתונים. בהתאם ל-<strong>California Delete Act (2026)</strong>, אנו מכבדים בקשות שמוגשות דרך <strong>DROP (Delete Request and Opt-Out Platform)</strong>.
                      </li>
                      <li>
                        <strong>קבלת החלטות אוטומטית:</strong> יש לך זכות לקבל מידע על ההיגיון מאחורי חיזויי התקשורת של הבינה המלאכותית שלנו (בהתאם לעדכוני CCPA 2026).
                      </li>
                    </ul>
                  ) : (
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
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {he ? 'אבטחת מידע ושמירה' : 'Data Security & Retention'}</h3>
                  {he ? (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>אנו עומדים ב<strong>תקנות הגנת הפרטיות הישראליות (אבטחת מידע) תשע"ז-2017</strong>.</li>
                      <li>הנתונים מוצפנים הן במנוחה והן בהעברה.</li>
                      <li><strong>שמירה:</strong> אנו שומרים נתוני בריאות רגישים רק כל עוד חשבונך פעיל או כנדרש על פי חוק.</li>
                    </ul>
                  ) : (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>We adhere to the <strong>Israeli Privacy Protection Regulations (Data Security) 5777-2017</strong>.</li>
                      <li>Data is encrypted both at rest and in transit.</li>
                      <li><strong>Retention:</strong> We retain sensitive health data only as long as your account is active or as required by law.</li>
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">7. {he ? 'העברת מידע בינלאומית' : 'International Data Transfer'}</h3>
                  {he ? (
                    <p>
                      אם מידע מועבר מחוץ לישראל, הדבר נעשה בהתאם ל<strong>תקנות העברת מידע (תשס"א-2001)</strong>, תוך הבטחה שהמדינה המקבלת מספקת רמת הגנה נאותה (למשל, התאמה עם האיחוד האירופי/בריטניה/ארה"ב).
                    </p>
                  ) : (
                    <p>
                      If data is transferred outside of Israel, it is done so in accordance with the <strong>Transfer of Data Regulations (5761-2001)</strong>, ensuring the recipient country provides an adequate level of protection (e.g., EU/UK/US adequacy).
                    </p>
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
