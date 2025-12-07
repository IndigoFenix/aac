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
              {language === 'he' ? 'תקנון שימוש' : 'Terms of Service'}
            </CardTitle>
          </CardHeader>
          
          <CardContent>
            <div className={`space-y-6 ${language === 'he' ? 'text-right' : 'text-left'}`} dir={language === 'he' ? 'rtl' : 'ltr'}>
              {language === 'he' ? (
                <>
                  <div className="text-sm text-muted-foreground">
                    עודכן לאחרונה בתאריך: 17.09.2025
                  </div>
                  
                  <div className="space-y-4 text-sm leading-relaxed">
                    <p>
                      ברוך הבא לשירות של חברת Xahaph AI (להלן: "השירות").
                      השימוש בשירות כפוף לתנאים המפורטים להלן. קרא בעיון את התנאים לפני השימוש.
                    </p>
                    
                    <div>
                      <h3 className="font-semibold text-lg mb-3">1. הסכמה לתנאים</h3>
                      <p>
                        בעת השימוש בשירות, אתה מאשר שקראת והבנת את תנאי השימוש וכי השימוש בשירות מהווה הסכמה מלאה ומחייבת לתנאים אלה. אם אינך מסכים לתנאים, אנא הימנע משימוש בשירות.
                      </p>
                    </div>
                    
                    <div>
                      <h3 className="font-semibold text-lg mb-3">2. שינויים בתנאי השימוש</h3>
                      <p>
                        חברת Xahaph AI רשאית לעדכן או לשנות את תנאי השימוש מעת לעת לפי שיקול דעתה הבלעדי. כל שינוי ייכנס לתוקף מיד עם פרסומו בשירות, והשימוש בשירות לאחר שינוי כזה יהווה הסכמה לתנאים המעודכנים.
                      </p>
                    </div>
                    
                    <div>
                      <h3 className="font-semibold text-lg mb-3">3. שימוש בשירות</h3>
                      <div className="space-y-3">
                        <p>השימוש בשירות מותר למטרות חוקיות בלבד.</p>
                        <p>
                          המשתמש מתחייב לא לעשות שימוש בשירות לצרכים הפוגעים בזכויות צדדים שלישיים, לרבות זכויות קניין רוחני, פרטיות, סודיות או כל זכות אחרת.
                        </p>
                        <p>
                          חברת Xahaph AI רשאית להפסיק את הגישה לשירות למשתמשים המפרים תנאים אלה.
                        </p>
                      </div>
                    </div>
                    
                    <div>
                      <h3 className="font-semibold text-lg mb-3">4. קניין רוחני</h3>
                      <p>
                        כל הזכויות בשירות, לרבות תוכן, עיצוב, טקסט, קוד, סימנים מסחריים, לוגואים, תמונות וסרטונים, שייכות לחברת Xahaph AI או לצדדים שלישיים שנתנו לה רישיון להשתמש בהם. אין להעתיק, לשכפל, להפיץ או לשדר כל חלק מהשירות ללא אישור בכתב ומראש מחברת Xahaph AI.
                      </p>
                    </div>
                    
                    <div>
                      <h3 className="font-semibold text-lg mb-3">5. הגבלת אחריות</h3>
                      <div className="space-y-3">
                        <p>השירות ניתן "כמות שהוא" (As Is) וללא אחריות מכל סוג.</p>
                        <p>
                          חברת Xahaph AI לא תישא באחריות לכל נזק ישיר, עקיף, תוצאתי או אחר שייגרם עקב השימוש בשירות או אי היכולת להשתמש בו.
                        </p>
                      </div>
                    </div>
                    
                    <div>
                      <h3 className="font-semibold text-lg mb-3">6. פרטיות</h3>
                      <p>
                        השימוש בשירות כפוף למדיניות הפרטיות של חברת Xahaph AI, המהווה חלק בלתי נפרד מתנאי השימוש.
                      </p>
                    </div>
                    
                    <div>
                      <h3 className="font-semibold text-lg mb-3">7. הדין החל וסמכות שיפוט</h3>
                      <p>
                        על תנאי שימוש אלה יחולו דיני מדינת ישראל בלבד. סמכות השיפוט הבלעדית בכל מחלוקת הקשורה בתנאים אלה או בשירות תהיה נתונה לבתי המשפט המוסמכים בעיר תל אביב-יפו.
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-4 text-sm leading-relaxed">
                  <div className="text-sm text-muted-foreground">
                    Last updated: September 17, 2025
                  </div>
                  
                  <p>
                    Welcome to the service provided by Xahaph AI ("the Service").
                    Use of the service is subject to the terms detailed below. Please read the terms carefully before use.
                  </p>
                  
                  <div>
                    <h3 className="font-semibold text-lg mb-3">1. Agreement to Terms</h3>
                    <p>
                      By using the service, you confirm that you have read and understood the terms of use and that use of the service constitutes full and binding agreement to these terms. If you do not agree to the terms, please refrain from using the service.
                    </p>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold text-lg mb-3">2. Changes to Terms of Use</h3>
                    <p>
                      Xahaph AI may update or change the terms of use from time to time at its sole discretion. Any change will take effect immediately upon publication in the service, and use of the service after such change will constitute agreement to the updated terms.
                    </p>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold text-lg mb-3">3. Use of Service</h3>
                    <div className="space-y-3">
                      <p>Use of the service is permitted for lawful purposes only.</p>
                      <p>
                        The user undertakes not to use the service for purposes that infringe the rights of third parties, including intellectual property rights, privacy, confidentiality or any other right.
                      </p>
                      <p>
                        Xahaph AI may terminate access to the service for users who violate these terms.
                      </p>
                    </div>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold text-lg mb-3">4. Intellectual Property</h3>
                    <p>
                      All rights in the service, including content, design, text, code, trademarks, logos, images and videos, belong to Xahaph AI or third parties who have licensed them to use. Do not copy, duplicate, distribute or transmit any part of the service without written permission in advance from Xahaph AI.
                    </p>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold text-lg mb-3">5. Limitation of Liability</h3>
                    <div className="space-y-3">
                      <p>The service is provided "As Is" and without warranty of any kind.</p>
                      <p>
                        Xahaph AI will not be liable for any direct, indirect, consequential or other damage caused by the use of the service or inability to use it.
                      </p>
                    </div>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold text-lg mb-3">6. Privacy</h3>
                    <p>
                      Use of the service is subject to Xahaph AI's privacy policy, which is an integral part of the terms of use.
                    </p>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold text-lg mb-3">7. Applicable Law and Jurisdiction</h3>
                    <p>
                      These terms of use shall be governed by the laws of the State of Israel only. Exclusive jurisdiction in any dispute related to these terms or the service shall be vested in the competent courts in Tel Aviv-Yafo.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}