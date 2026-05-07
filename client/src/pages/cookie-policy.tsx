import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Cookie } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function CookiePolicy() {
  const { language } = useLanguage();
  const he = language === 'he';

  return (
    <div className="min-h-screen w-full bg-background py-8">
      <div className="max-w-4xl mx-auto px-4">
        <Card>
          <CardHeader className={he ? 'text-right' : 'text-left'}>
            <CardTitle className={`flex items-center gap-3 ${he ? 'justify-end flex-row-reverse' : 'justify-start'}`}>
              <Cookie className="w-6 h-6" />
              {he ? 'מדיניות עוגיות' : 'Cookie Policy'}
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className={`space-y-6 ${he ? 'text-right' : 'text-left'}`} dir={he ? 'rtl' : 'ltr'}>
              <div className="space-y-4 text-sm leading-relaxed">
                <div className="text-sm text-muted-foreground">
                  {he ? 'עודכן לאחרונה: 15 במרץ, 2026' : 'Last updated: March 15, 2026'}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">1. {he ? 'מה הן עוגיות?' : 'What are Cookies?'}</h3>
                  {he ? (
                    <p>
                      עוגיות הן קבצי טקסט קטנים המוצבים על המחשב או המכשיר הנייד שלך על ידי אתרים שבהם אתה מבקר/ת. הן נמצאות בשימוש נרחב כדי לגרום לאתרים לפעול, או לפעול ביעילות רבה יותר, וכן לספק מידע לבעלי האתר. ב-<strong>Aivota</strong>, אנו משתמשים בעוגיות וטכנולוגיות מעקב דומות (כגון משואות אינטרנט ופיקסלים) כדי לשפר את חוויתך עם פלטפורמת ה-AAC שלנו.
                    </p>
                  ) : (
                    <p>
                      Cookies are small text files that are placed on your computer or mobile device by websites that you visit. They are widely used to make websites work, or work more efficiently, as well as to provide information to the owners of the site. At <strong>Aivota</strong>, we use cookies and similar tracking technologies (like web beacons and pixels) to enhance your experience with our AAC platform.
                    </p>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">2. {he ? 'כיצד אנו משתמשים בעוגיות' : 'How We Use Cookies'}</h3>
                  {he ? (
                    <>
                      <p>אנו משתמשים בעוגיות למטרות הבאות:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>חיוניות:</strong> לשמירה על הסשן שלך ולהבטחת הפעולה המאובטחת של ממשק ה-AAC.
                        </li>
                        <li>
                          <strong>ביצועים וניתוח:</strong> להבנת האופן שבו משתמשים מתקשרים עם לוחות התקשורת הדינמיים שלנו כדי שנוכל לייעל זמני טעינה ותגובתיות ממשק.
                        </li>
                        <li>
                          <strong>התאמה אישית:</strong> לזכירת ההגדרות שלך, כגון פריסת סט הסמלים הקנייני המועדפת או כיול מעקב העיניים.
                        </li>
                        <li>
                          <strong>אופטימיזציית בינה מלאכותית:</strong> לאיסוף נתונים מזוהים על אופן השימוש בחיזויי הבינה המלאכותית הגנרטיבית שלנו, המסייעים לנו לשפר את דיוק מנוע ה-"XCS".
                        </li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>We use cookies for the following purposes:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>Essential:</strong> To maintain your session and ensure the secure operation of the AAC interface.
                        </li>
                        <li>
                          <strong>Performance & Analytics:</strong> To understand how users interact with our dynamic communication boards so we can optimize load times and UI responsiveness.
                        </li>
                        <li>
                          <strong>Personalization:</strong> To remember your settings, such as your preferred Proprietary Symbol Set layout or eye-tracking calibration.
                        </li>
                        <li>
                          <strong>AI Optimization:</strong> To collect de-identified data on how our Generative AI predictions are used, helping us improve the "XCS" engine's accuracy.
                        </li>
                      </ul>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">3. {he ? 'סוגי עוגיות בשימוש' : 'Types of Cookies Used'}</h3>
                  {he ? (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>
                        <strong>עוגיות צד ראשון:</strong> מוגדרות ישירות על ידי Aivota לניהול חשבונך ואבטחתך.
                      </li>
                      <li>
                        <strong>עוגיות צד שלישי:</strong> אנו עשויים להשתמש בספקי ניתוח מוכרים (למשל, Google Analytics 4) כדי לסייע לנו בניתוח תעבורת האתר. ספקים אלה עשויים להגדיר עוגיות משלהם.
                      </li>
                    </ul>
                  ) : (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>
                        <strong>First-Party Cookies:</strong> Set directly by Aivota to manage your account and security.
                      </li>
                      <li>
                        <strong>Third-Party Cookies:</strong> We may use reputable analytics providers (e.g., Google Analytics 4) to help us analyze site traffic. These providers may set their own cookies.
                      </li>
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">4. {he ? 'ניהול העדפות (ביטול הסכמה)' : 'Managing Your Preferences (Opt-Out)'}</h3>
                  {he ? (
                    <>
                      <p>
                        בהתאם ל<strong>תיקון 13 לחוק הגנת הפרטיות הישראלי</strong>, אנו מכבדים את זכותך לבחור.
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>באנר הסכמה:</strong> בביקורך הראשון, תוצג לך אפשרות "לקבל הכל", "לדחות הכל" או "להתאים אישית".
                        </li>
                        <li>
                          <strong>הגדרות דפדפן:</strong> באפשרותך גם לנהל עוגיות דרך הגדרות הדפדפן שלך. עם זאת, השבתת "עוגיות חיוניות" עלולה לגרום לתקלות בפלטפורמת ה-AAC של Aivota.
                        </li>
                        <li>
                          <strong>Global Privacy Control (GPC):</strong> אנו מכבדים אותות GPC מהדפדפן שלך כבקשת ביטול הסכמה תקפה לעוגיות לא חיוניות.
                        </li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>
                        In accordance with <strong>Amendment 13 of the Israeli Privacy Protection Law</strong>, we respect your right to choose.
                      </p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li>
                          <strong>Consent Banner:</strong> Upon your first visit, you will be presented with a choice to "Accept All," "Reject All," or "Customize."
                        </li>
                        <li>
                          <strong>Browser Settings:</strong> You can also manage cookies through your browser settings. However, disabling "Essential Cookies" may cause the Aivota AAC platform to malfunction.
                        </li>
                        <li>
                          <strong>Global Privacy Control (GPC):</strong> We honor GPC signals from your browser as a valid opt-out request for non-essential cookies.
                        </li>
                      </ul>
                    </>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">5. {he ? 'שמירת עוגיות' : 'Cookie Retention'}</h3>
                  {he ? (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>
                        <strong>עוגיות סשן:</strong> נמחקות אוטומטית כאשר אתה סוגר/ת את הדפדפן.
                      </li>
                      <li>
                        <strong>עוגיות קבועות:</strong> נשארות על מכשירך לתקופה מוגדרת (למשל, 12 חודשים) או עד שתמחק/י אותן ידנית.
                      </li>
                    </ul>
                  ) : (
                    <ul className="list-disc space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                      <li>
                        <strong>Session Cookies:</strong> Deleted automatically when you close your browser.
                      </li>
                      <li>
                        <strong>Persistent Cookies:</strong> Remain on your device for a set period (e.g., 12 months) or until you manually delete them.
                      </li>
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="font-semibold text-lg mb-3">6. {he ? 'פרטי התקשרות' : 'Contact Information'}</h3>
                  {he ? (
                    <>
                      <p>לכל שאלה בנוגע לשימוש שלנו בעוגיות, אנא פנו לממונה הגנת המידע שלנו:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li><strong>דוא"ל DPO:</strong> <a href="mailto:dpo@aivota.ai" className="text-primary underline underline-offset-2">dpo@aivota.ai</a></li>
                        <li><strong>כתובת:</strong> בנטל 4, כפר יונה, ישראל</li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p>For any questions regarding our use of cookies, please contact our Data Protection Officer:</p>
                      <ul className="list-disc mt-2 space-y-1" style={{ paddingInlineStart: '1.5rem' }}>
                        <li><strong>DPO Email:</strong> <a href="mailto:dpo@aivota.ai" className="text-primary underline underline-offset-2">dpo@aivota.ai</a></li>
                        <li><strong>Address:</strong> 4 Bental, Kfar Yona, Israel</li>
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
