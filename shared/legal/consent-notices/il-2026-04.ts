// Israeli Privacy Protection Authority — Section 11 informed-consent notice.
// Version IL.2026.04. Initial draft. FINAL WORDING REQUIRES LEGAL REVIEW.
//
// The structural slots (purpose / voluntariness / recipients / retention /
// rights) are universal across regimes; the wording here is specific to the
// Israeli PPL §11 + Feb-2026 PPA position paper.

import type { ConsentNoticeVariant } from "../types.js";

export const IL_2026_04_EN: ConsentNoticeVariant = {
  country: "IL",
  locale: "en",
  version: "IL.2026.04",
  content: {
    title: "Informed consent for student data collection",
    purposeStatement:
      "We collect this data to document SLP clinical sessions, track developmental progress, manage the AAC service, and enable communication tools for the student. The clinic uses this data to provide therapy, generate reports, and coordinate care.",
    voluntarinessStatement:
      "You are not legally obligated to provide this data. The clinic cannot, however, provide the SLP service or operate the AAC tools without it.",
    thirdPartyTransfersStatement:
      "Your child's data will be transferred to the categories of recipients listed below. Each recipient processes the data only as needed to provide the service. The list is current as of the time you sign this consent; if a new recipient is added, you will be asked to re-consent.",
    retentionStatement:
      "We retain student records for the duration of your engagement with the clinic plus the period required by Israeli health-record retention rules. You can request deletion at any time, subject to legal retention obligations.",
    rightsStatement:
      "Under Israeli law you have the right to access the data we hold about your child, request corrections, request deletion, and withdraw your consent at any time. Withdrawing consent stops further processing but does not invalidate processing that has already occurred. To exercise these rights or to file a complaint with the Privacy Protection Authority (PPA), contact the clinic's data protection officer.",
  },
};

export const IL_2026_04_HE: ConsentNoticeVariant = {
  country: "IL",
  locale: "he",
  version: "IL.2026.04",
  content: {
    title: "הסכמה מדעת לאיסוף מידע על תלמידים",
    purposeStatement:
      "אנו אוספים מידע זה כדי לתעד מפגשי טיפול בקלינאי תקשורת, לעקוב אחר ההתפתחות, לנהל את שירות התקשורת התומכת והחליפית (AAC) ולאפשר שימוש בכלי התקשורת של התלמיד. המרפאה משתמשת במידע כדי לספק טיפול, להפיק דוחות ולתאם טיפולים.",
    voluntarinessStatement:
      "אינך מחויב/ת על פי חוק למסור מידע זה. עם זאת, המרפאה אינה יכולה לספק את שירות קלינאות התקשורת או להפעיל את כלי ה-AAC ללא המידע.",
    thirdPartyTransfersStatement:
      "המידע על ילדך יועבר לקטגוריות הנמענים המפורטות להלן. כל נמען מעבד את המידע רק לפי הצורך לצורך מתן השירות. הרשימה מעודכנת לעת מתן הסכמתך; אם יתווסף נמען חדש, תתבקש/י להסכים מחדש.",
    retentionStatement:
      "אנו שומרים את רשומות התלמיד למשך תקופת הקשר שלך עם המרפאה בתוספת התקופה הנדרשת על פי כללי שמירת רשומות הבריאות בישראל. ניתן לבקש מחיקה בכל עת, בכפוף לחובות שמירה משפטיות.",
    rightsStatement:
      "על פי החוק הישראלי, יש לך זכות לעיין במידע שאנו מחזיקים על ילדך, לבקש תיקונים, לבקש מחיקה ולבטל את הסכמתך בכל עת. ביטול הסכמה עוצר את העיבוד הנוסף אך אינו מבטל עיבוד שכבר התרחש. למימוש זכויות אלה או להגשת תלונה לרשות להגנת הפרטיות (PPA), פנה/י לממונה על הגנת הפרטיות של המרפאה.",
  },
};

export const IL_2026_04_VARIANTS: ReadonlyArray<ConsentNoticeVariant> = [
  IL_2026_04_EN,
  IL_2026_04_HE,
];
