import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function TermsOfService() {
  const { language } = useLanguage();
  const he = language === 'he';

  return (
    <div className="min-h-screen w-full bg-background py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={he ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${he ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Shield className="w-6 h-6" />
              {he ? 'תנאי שימוש' : 'Terms of Service'}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${he ? 'text-right' : 'text-left'}`} dir={he ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {he ? 'עודכן לאחרונה: 15 במרץ, 2026' : 'Last updated: March 15, 2026'}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {he ? 'אופי השירות והסתייגות רפואית' : 'Nature of the Service and Medical Disclaimer'}</h3>
                  <div className="space-y-3">
                    {he ? (
                      <>
                        <p>
                          <strong>1.1. כלי עזר בלבד:</strong> Aivota מספקת מנחה תקשורת מבוסס בינה מלאכותית ו<strong>סט סמלים קנייני</strong> המיועדים לסייע לאנשים עם לקויות תקשורת.
                        </p>
                        <p>
                          <strong>1.2. אינו מכשיר רפואי:</strong> הנך מאשר/ה כי <strong>Aivota אינה מכשיר רפואי</strong>, ותוצאותיה אינן מהוות ייעוץ רפואי, אבחון או טיפול. היא מיועדת אך ורק ככלי עזר תקשורתי פונקציונלי.
                        </p>
                        <p>
                          <strong>1.3. מגבלות בינה מלאכותית:</strong> השירות משתמש בבינה מלאכותית גנרטיבית אשר עלולה לייצר לעתים "הזיות" או תחזיות לא מדויקות. מטפלים חייבים לפקח על השימוש, במיוחד בהקשרים של בטיחות קריטית או רפואה.
                        </p>
                      </>
                    ) : (
                      <>
                        <p>
                          <strong>1.1. Assistive Tool Only:</strong> Aivota provides an Artificial Intelligence-driven communication moderator and a <strong>Proprietary Symbol Set</strong> designed to assist individuals with communication impairments.
                        </p>
                        <p>
                          <strong>1.2. Not a Medical Device:</strong> You acknowledge that <strong>Aivota is not a medical device</strong>, and its outputs do not constitute medical advice, diagnosis, or treatment. It is intended solely as a functional communication aid.
                        </p>
                        <p>
                          <strong>1.3. AI Limitations:</strong> The service utilizes Generative AI which may occasionally produce "hallucinations" or inaccurate predictions. Caregivers must supervise use, especially in critical safety or medical contexts.
                        </p>
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {he ? 'קניין רוחני ורישיון שימוש' : 'Intellectual Property & License Grant'}</h3>
                  <div className="space-y-3">
                    {he ? (
                      <>
                        <p>
                          <strong>2.1. בעלות:</strong> Aivota (ו/או מייסדה, עופר סוחמי, בהמתנה להתאגדות מלאה) מחזיקה בכל הזכויות, הבעלות והאינטרס בתוכנה, במודלי הבינה המלאכותית וב<strong>סט הסמלים הקנייני</strong> ("הקניין הרוחני").
                        </p>
                        <p>
                          <strong>2.2. רישיון מוגבל:</strong> אנו מעניקים לך רישיון אישי, לא בלעדי, שאינו ניתן להעברה וניתן לביטול, לשימוש בקניין הרוחני אך ורק לצורך תקשורת אישית דרך פלטפורמת Aivota.
                        </p>
                        <p>
                          <strong>2.3. הגבלות מחמירות:</strong> חל איסור על:
                        </p>
                        <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                          <li>חילוץ, העתקה או הפצה של <strong>סט הסמלים הקנייני</strong> מחוץ לפלטפורמה.</li>
                          <li>שימוש בקניין הרוחני לאימון, פיתוח או שיפור מודלי בינה מלאכותית או מערכות AAC של צדדים שלישיים.</li>
                          <li>הנדסה לאחור או "גריפת" קוד או תוכן הפלטפורמה.</li>
                        </ul>
                      </>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {he ? 'הגבלת אחריות ואחריות' : 'Liability and Warranty Disclaimers'}</h3>
                  <div className="space-y-3">
                    {he ? (
                      <>
                        <p>
                          <strong>3.1. "כמות שהוא":</strong> השירות ניתן "כמות שהוא". במידה המותרת בחוק, Aivota מסירה כל אחריות, מפורשת או משתמעת.
                        </p>
                        <p>
                          <strong>3.2. תקרת אחריות:</strong> בהתאם ל<strong>חוק החוזים האחידים הישראלי (2026)</strong> ולסטנדרטים מסחריים אמריקאיים, האחריות הכוללת של Aivota עבור כל תביעה תוגבל לסכום ששולם בפועל על ידך עבור השירות במהלך <strong>12 החודשים</strong> שקדמו לתביעה.
                        </p>
                        <p>
                          <strong>3.3. החרגה:</strong> איננו אחראים לשגיאות תקשורת, מצוקה רגשית או נזקים תוצאתיים הנובעים מתוצרי בינה מלאכותית.
                        </p>
                      </>
                    ) : (
                      <>
                        <p>
                          <strong>3.1. "As-Is" Basis:</strong> The service is provided "As-Is." To the extent permitted by law, Aivota disclaims all warranties, express or implied.
                        </p>
                        <p>
                          <strong>3.2. Liability Cap:</strong> In accordance with <strong>Israeli Standard Contracts Law (2026)</strong> and U.S. commercial standards, Aivota's total liability for any claim shall be limited to the amount actually paid by you for the service during the <strong>12 months</strong> preceding the claim.
                        </p>
                        <p>
                          <strong>3.3. Exclusion:</strong> We are not liable for any communication errors, emotional distress, or consequential damages resulting from AI-generated outputs.
                        </p>
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {he ? 'שקיפות AI (תאימות ארה"ב - CA/TX/CO)' : 'AI Transparency (U.S. Compliance - CA/TX/CO)'}</h3>
                  <div className="space-y-3">
                    {he ? (
                      <>
                        <p>
                          <strong>4.1. גילוי:</strong> בהתאם ל-<strong>California AB 2013</strong> ו-<strong>Texas TRAIGA (2026)</strong>, אנו מגלים כי מערכת זו משתמשת בבינה מלאכותית גנרטיבית שאומנה על מאגרי נתונים גדולים לחיזוי ויצירת לוחות תקשורת.
                        </p>
                        <p>
                          <strong>4.2. אדם בלולאה:</strong> אנו מעודדים אימות "אדם בלולאה" עבור כל תקשורת קריטית.
                        </p>
                      </>
                    ) : (
                      <>
                        <p>
                          <strong>4.1. Disclosure:</strong> In compliance with <strong>California AB 2013</strong> and <strong>Texas TRAIGA (2026)</strong>, we disclose that this system uses generative AI trained on large datasets to predict and generate communication boards.
                        </p>
                        <p>
                          <strong>4.2. Human-in-the-Loop:</strong> We encourage "Human-in-the-loop" verification for all critical communications.
                        </p>
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {he ? 'סיום' : 'Termination'}</h3>
                  <div className="space-y-3">
                    {he ? (
                      <>
                        <p>
                          <strong>5.1. זכות הדדית:</strong> כל צד רשאי לסיים הסכם זה בכל עת עם הודעה בכתב של <strong>30 ימים</strong> מראש.
                        </p>
                        <p>
                          <strong>5.2. הפרה מיידית:</strong> Aivota שומרת לעצמה את הזכות להשעות גישה באופן מיידי אם תזהה גריפה בלתי מורשית או גניבת קניין רוחני הקשורה לסט הסמלים הקנייני.
                        </p>
                      </>
                    ) : (
                      <>
                        <p>
                          <strong>5.1. Mutual Right:</strong> Either party may terminate this agreement at any time with <strong>30 days</strong> written notice.
                        </p>
                        <p>
                          <strong>5.2. Immediate Breach:</strong> Aivota reserves the right to suspend access immediately if it detects unauthorized scraping or IP theft related to the Proprietary Symbol Set.
                        </p>
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {he ? 'הדין החל וסמכות שיפוט' : 'Governing Law and Jurisdiction'}</h3>
                  <div className="space-y-3">
                    {he ? (
                      <>
                        <p>
                          <strong>6.1. משתמשים ישראליים:</strong> הסכם זה כפוף לחוקי <strong>מדינת ישראל</strong>. בהתאם ל<strong>תיקון מס' 3 לחוק החוזים (2026)</strong>, הנוסח הכתוב של הסכם זה יהווה את מקור הפרשנות העיקרי. סמכות שיפוט בלעדית נתונה לבתי המשפט בתל אביב-יפו.
                        </p>
                        <p>
                          <strong>6.2. משתמשים אמריקאיים:</strong> סכסוכים יהיו כפופים לחוקי <strong>מדינת דלאוור</strong> (או מדינת ההתאגדות שלך).
                        </p>
                        <p>
                          <strong>6.3. ויתור על תביעה ייצוגית:</strong> במידה המותרת בחוק, הנך מסכים/ה לפתור סכסוכים על בסיס אישי ומוותר/ת על כל זכות להשתתף בתביעה ייצוגית.
                        </p>
                      </>
                    ) : (
                      <>
                        <p>
                          <strong>6.1. Israeli Users:</strong> This agreement is governed by the laws of the <strong>State of Israel</strong>. Pursuant to <strong>Amendment No. 3 to the Contracts Law (2026)</strong>, the written text of this agreement shall be the primary source of interpretation. Exclusive jurisdiction lies with the courts of Tel Aviv-Jaffa.
                        </p>
                        <p>
                          <strong>6.2. U.S. Users:</strong> Disputes shall be governed by the laws of the <strong>State of Delaware</strong> (or your state of incorporation).
                        </p>
                        <p>
                          <strong>6.3. Class Action Waiver:</strong> To the extent permitted by law, you agree to resolve disputes on an individual basis and waive any right to participate in a class-action lawsuit.
                        </p>
                      </>
                    )}
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
