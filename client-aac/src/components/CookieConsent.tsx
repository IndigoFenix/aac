import { useEffect, useState } from "react";
import { Cookie } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { hasDecidedCookieConsent, writeCookieConsent } from "@/lib/cookieConsent";

export function CookieConsent() {
  const { t, isRTL } = useLanguage();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!hasDecidedCookieConsent()) setVisible(true);
  }, []);

  const decide = (choice: "all" | "essential") => {
    writeCookieConsent(choice);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label={t("cookieConsent.title")}
      className="fixed bottom-4 left-4 right-4 z-[100] mx-auto max-w-2xl rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl p-4"
    >
      <div className={`flex items-start gap-3 ${isRTL ? "flex-row-reverse" : ""}`}>
        <Cookie className="w-6 h-6 text-blue-600 shrink-0 mt-0.5" />
        <div className={`flex-1 space-y-2 ${isRTL ? "text-right" : ""}`}>
          <p className="text-sm font-medium text-gray-900 dark:text-white">
            {t("cookieConsent.title")}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("cookieConsent.description")}{" "}
            <a
              href="/cookie-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-blue-600 hover:opacity-80"
            >
              {t("cookieConsent.learnMore")}
            </a>
          </p>
          <div className={`flex flex-wrap gap-2 pt-1 ${isRTL ? "flex-row-reverse" : ""}`}>
            <Button size="sm" onClick={() => decide("all")}>
              {t("cookieConsent.acceptAll")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide("essential")}>
              {t("cookieConsent.rejectNonEssential")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
