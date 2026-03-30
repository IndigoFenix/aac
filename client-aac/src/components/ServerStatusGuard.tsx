import { useState, useEffect, useCallback, ReactNode } from "react";
import { apiUrl } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";

export function ServerStatusGuard({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"checking" | "ready" | "unavailable">("checking");
  const [attempt, setAttempt] = useState(0);
  const { t, direction } = useLanguage();

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/health"), { credentials: "include" });
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        setStatus("unavailable");
        return;
      }
      const data = await res.json();
      if (data.status === "healthy") {
        setStatus("ready");
      } else if (data.status === "starting") {
        setStatus("unavailable");
      } else {
        setStatus("ready");
      }
    } catch {
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  // Auto-retry when unavailable
  useEffect(() => {
    if (status !== "unavailable") return;
    const delay = Math.min(3000 * 2 ** attempt, 15000);
    const timer = setTimeout(() => {
      setAttempt((a) => a + 1);
      checkHealth();
    }, delay);
    return () => clearTimeout(timer);
  }, [status, attempt, checkHealth]);

  if (status === "ready") return <>{children}</>;

  if (status === "checking") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center" dir={direction}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto" />
          <p className="mt-4 text-gray-600 dark:text-gray-300">{t("app.loading")}</p>
        </div>
      </div>
    );
  }

  // unavailable
  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex flex-col items-center justify-center gap-4 px-4 text-center" dir={direction}>
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-600 mx-auto" />
      <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
        {t("errors.SERVICE_STARTING")}
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-300 max-w-md">
        {t("errors.SERVICE_UNAVAILABLE")}
      </p>
    </div>
  );
}
