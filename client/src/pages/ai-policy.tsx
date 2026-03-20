import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Brain } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function AIPolicy() {
  const { language } = useLanguage();
  const he = language === 'he';

  return (
    <div className="min-h-screen w-full bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={he ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${he ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Brain className="w-6 h-6" />
              {he ? 'מדיניות בינה מלאכותית' : 'AI Policy'}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${he ? 'text-right' : 'text-left'}`} dir={he ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {he ? 'עודכן לאחרונה: 15 במרץ, 2026' : 'Last updated: March 15, 2026'}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {he ? 'מבוא' : 'Introduction'}</h3>
                  {he ? (
                    <p>
                      Aivota משלבת טכנולוגיות בינה מלאכותית (AI) בפלטפורמת CliniAACian כדי לסייע בתקשורת חלופית ומשלימה (AAC) עבור משתמשים שאינם מילוליים. מדיניות זו מסבירה כיצד אנו משתמשים ב-AI, אילו אמצעי הגנה קיימים, ומהן הזכויות שלך בנוגע לקבלת החלטות מונחית AI.
                    </p>
                  ) : (
                    <p>
                      Aivota integrates artificial intelligence (AI) technologies into the CliniAACian platform to support augmentative and alternative communication (AAC) for non-verbal users. This policy explains how we use AI, what safeguards are in place, and what your rights are regarding AI-assisted decision-making.
                    </p>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {he ? 'כיצד אנו משתמשים ב-AI' : 'How We Use AI'}</h3>
                  {he ? (
                    <>
                      <p>הפלטפורמה שלנו משתמשת ב-AI למטרות הבאות:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>יצירת לוחות AAC דינמיים:</strong> AI מייצר בזמן אמת אפשרויות תקשורת מותאמות אישית, המבוססות על הקשר, העדפות והיכולות של המשתמש.
                        </li>
                        <li>
                          <strong>אינטראקציה בזמן אמת:</strong> סוכן AI אינטראקטיבי מנהל שיחה עם המשתמש, מסייע בתקשורת ומגיב לקלט שלו.
                        </li>
                        <li>
                          <strong>ניטור ומעקב:</strong> סוכן ניטור מעריך את השיחה מעת לעת, רושם תובנות ומספק הנחיות כדי לשפר את חוויית התקשורת.
                        </li>
                        <li>
                          <strong>תמיכה קלינית:</strong> צ'אט AI זמין לקלינאים ומטפלים כדי לסייע בניהול ותכנון טיפול.
                        </li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>Our platform uses AI for the following purposes:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>Dynamic AAC Board Generation:</strong> AI generates personalized communication options in real time, based on context, user preferences, and capabilities.
                        </li>
                        <li>
                          <strong>Real-Time Interaction:</strong> An interactive AI agent engages in conversation with the user, supporting communication and responding to their input.
                        </li>
                        <li>
                          <strong>Monitoring & Observation:</strong> A monitoring agent periodically evaluates the conversation, records insights, and provides guidance to improve the communication experience.
                        </li>
                        <li>
                          <strong>Clinical Support:</strong> An AI chat is available to clinicians and caregivers to assist with care management and planning.
                        </li>
                      </ul>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {he ? 'ספקי AI של צד שלישי' : 'Third-Party AI Providers'}</h3>
                  {he ? (
                    <>
                      <p>אנו משתמשים בשירותי AI מספקים חיצוניים, כולל:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>Google (Gemini):</strong> עבור יכולות אינטראקציה בזמן אמת, כולל עיבוד קול וטקסט.
                        </li>
                        <li>
                          <strong>OpenAI:</strong> עבור יכולות אינטראקציה בזמן אמת ועיבוד שפה טבעית.
                        </li>
                        <li>
                          <strong>Anthropic (Claude):</strong> עבור תמיכה קלינית ועיבוד שפה טבעית.
                        </li>
                      </ul>
                      <p className="mt-2">
                        כל הספקים כפופים להסכמי עיבוד נתונים המבטיחים עמידה בתקני הפרטיות והאבטחה שלנו. נתונים המועברים לספקים אלה מוגבלים למה שנדרש לשירות ואינם משמשים לאימון מודלים ללא הסכמה מפורשת.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>We use AI services from external providers, including:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>Google (Gemini):</strong> For real-time interaction capabilities, including voice and text processing.
                        </li>
                        <li>
                          <strong>OpenAI:</strong> For real-time interaction capabilities and natural language processing.
                        </li>
                        <li>
                          <strong>Anthropic (Claude):</strong> For clinical support and natural language processing.
                        </li>
                      </ul>
                      <p className="mt-2">
                        All providers are bound by data processing agreements ensuring compliance with our privacy and security standards. Data shared with these providers is limited to what is required for the service and is not used to train models without explicit consent.
                      </p>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {he ? 'פיקוח אנושי' : 'Human Oversight'}</h3>
                  {he ? (
                    <>
                      <p>
                        ה-AI בפלטפורמה שלנו פועל כ<strong>כלי עזר</strong>, לא כמקבל החלטות עצמאי. בהתאם לכך:
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>כל הפעולות הקליניות המשמעותיות דורשות אישור מקלינאי או מטפל מוסמך.</li>
                        <li>ה-AI אינו מבצע שינויים במידע רפואי או ביעדי טיפול ללא מעורבות אנושית.</li>
                        <li>קלינאים ומטפלים יכולים לצפות, לערוך ולדרוס כל המלצה של ה-AI.</li>
                        <li>סוכן הניטור רושם תובנות אך אינו יכול לשנות ישירות מידע רפואי או יעדים.</li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>
                        The AI in our platform operates as an <strong>assistive tool</strong>, not an autonomous decision-maker. Accordingly:
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>All significant clinical actions require approval from a qualified clinician or caregiver.</li>
                        <li>The AI does not modify medical information or treatment goals without human involvement.</li>
                        <li>Clinicians and caregivers can view, edit, and override any AI recommendation.</li>
                        <li>The monitoring agent records observations but cannot directly alter medical information or goals.</li>
                      </ul>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {he ? 'שקיפות ויכולת הסבר' : 'Transparency & Explainability'}</h3>
                  {he ? (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>אנו מחויבים לשקיפות לגבי אופן השימוש שלנו ב-AI ולמידת ההשפעה שיש לו על חוויית המשתמש.</li>
                      <li>כאשר ה-AI מייצר לוחות AAC או מגיב בשיחה, הוא פועל על בסיס הקשר השיחה, פרופיל המשתמש והעדפותיו.</li>
                      <li>בהתאם ל<strong>עדכוני CCPA 2026</strong>, למשתמשים יש זכות לקבל מידע על ההיגיון מאחורי החלטות AI המשפיעות עליהם.</li>
                      <li>באפשרותך לפנות אלינו בכל עת בכתובת <a href="mailto:ai@aivota.com" className="text-primary hover:underline">ai@aivota.com</a> לשאלות על אופן פעולת ה-AI.</li>
                    </ul>
                  ) : (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>We are committed to transparency about how we use AI and the extent of its influence on the user experience.</li>
                      <li>When the AI generates AAC boards or responds in conversation, it operates based on the conversation context, user profile, and preferences.</li>
                      <li>Under <strong>2026 CCPA updates</strong>, users have the right to receive information about the logic behind AI decisions that affect them.</li>
                      <li>You may contact us at any time at <a href="mailto:ai@aivota.com" className="text-primary hover:underline">ai@aivota.com</a> with questions about how the AI operates.</li>
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {he ? 'נתונים ו-AI' : 'Data & AI'}</h3>
                  {he ? (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>ה-AI מעבד נתוני שיחה ופרופיל משתמש כדי לספק תגובות מותאמות אישית. נתונים אלה מטופלים בהתאם ל<a href="/privacy-policy" className="text-primary hover:underline">מדיניות הפרטיות</a> שלנו.</li>
                      <li>סוכן הניטור עשוי לגשת למידע אישי של המשתמש (כגון יעדים ומידע רפואי) לצורך הערכה, אך יכול לכתוב רק לתחומי זיכרון מוגדרים.</li>
                      <li>יומני שיחות AI נשמרים לצורך שיפור השירות ומעקב קליני, ומטופלים לפי מדיניות שמירת הנתונים שלנו.</li>
                      <li>איננו משתמשים בשיחותיך הפרטיות לאימון מודלי AI גלובליים ללא הסכמה נפרדת ומפורשת.</li>
                    </ul>
                  ) : (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>The AI processes conversation data and user profile information to deliver personalized responses. This data is handled in accordance with our <a href="/privacy-policy" className="text-primary hover:underline">Privacy Policy</a>.</li>
                      <li>The monitoring agent may access personal user information (such as goals and medical information) for evaluation purposes, but can only write to designated memory fields.</li>
                      <li>AI conversation logs are retained for service improvement and clinical tracking, subject to our data retention policy.</li>
                      <li>We do not use your private conversations to train global AI models without separate, explicit consent.</li>
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">7. {he ? 'מגבלות ובטיחות' : 'Limitations & Safety'}</h3>
                  {he ? (
                    <>
                      <p>חשוב להבין את המגבלות הבאות של מערכות ה-AI שלנו:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>ה-AI עשוי לייצר תגובות שגויות או לא מתאימות. אנו ממליצים תמיד על פיקוח אנושי.</li>
                        <li>ה-AI <strong>אינו מכשיר רפואי</strong> ואינו מיועד לשמש כתחליף לייעוץ רפואי מקצועי.</li>
                        <li>הצעות תקשורת של ה-AI הן בגדר עזר בלבד ואינן מייצגות בהכרח את כוונת המשתמש.</li>
                        <li>אנו מיישמים מסנני תוכן ומנגנוני בטיחות כדי למזער תוכן בלתי הולם.</li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>It is important to understand the following limitations of our AI systems:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>The AI may produce inaccurate or inappropriate responses. We always recommend human oversight.</li>
                        <li>The AI is <strong>not a medical device</strong> and is not intended to replace professional medical advice.</li>
                        <li>AI communication suggestions are assistive only and do not necessarily represent the user's intent.</li>
                        <li>We implement content filters and safety mechanisms to minimize inappropriate content.</li>
                      </ul>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">8. {he ? 'הזכויות שלך' : 'Your Rights'}</h3>
                  {he ? (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>
                        <strong>ביטול הסכמה:</strong> באפשרותך לבקש את השבתת תכונות AI מסוימות עבור חשבונך בכל עת.
                      </li>
                      <li>
                        <strong>גישה למידע:</strong> יש לך זכות לבקש פרטים על אופן עיבוד הנתונים שלך על ידי מערכות ה-AI שלנו.
                      </li>
                      <li>
                        <strong>תיקון:</strong> אם ה-AI תיעד מידע שגוי בהערות או בזיכרון, באפשרותך לבקש תיקון.
                      </li>
                      <li>
                        <strong>התנגדות:</strong> בהתאם לחוק הישראלי ול-CCPA, יש לך זכות להתנגד לקבלת החלטות אוטומטית שמשפיעה עליך באופן מהותי.
                      </li>
                    </ul>
                  ) : (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>
                        <strong>Opt-Out:</strong> You may request the deactivation of specific AI features for your account at any time.
                      </li>
                      <li>
                        <strong>Access:</strong> You have the right to request details about how your data is processed by our AI systems.
                      </li>
                      <li>
                        <strong>Correction:</strong> If the AI has recorded inaccurate information in notes or memory, you may request correction.
                      </li>
                      <li>
                        <strong>Objection:</strong> Under Israeli law and the CCPA, you have the right to object to automated decision-making that significantly affects you.
                      </li>
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">9. {he ? 'עדכונים למדיניות' : 'Policy Updates'}</h3>
                  {he ? (
                    <p>
                      מדיניות זו עשויה להתעדכן ככל שטכנולוגיות ה-AI שלנו מתפתחות או ככל שדרישות רגולטוריות משתנות. נודיע לך על שינויים מהותיים באמצעות הודעה בפלטפורמה או בדוא"ל. לשאלות בנוגע למדיניות AI שלנו, אנא פנו אלינו בכתובת <a href="mailto:ai@aivota.com" className="text-primary hover:underline">ai@aivota.com</a>.
                    </p>
                  ) : (
                    <p>
                      This policy may be updated as our AI technologies evolve or as regulatory requirements change. We will notify you of material changes via an in-platform notice or email. For questions about our AI policy, please contact us at <a href="mailto:ai@aivota.com" className="text-primary hover:underline">ai@aivota.com</a>.
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
