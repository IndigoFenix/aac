import { useState, useEffect, useCallback, ReactNode } from "react";
import { apiUrl } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";

export function ServerStatusGuard({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"checking" | "ready" | "unavailable">("checking");
  const [attempt, setAttempt] = useState(0);
  const { t } = useLanguage();

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
        // error status but server is reachable — let the app handle it
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

  // A normal cold start resolves within the first few health retries, so keep
  // showing a plain spinner (not the worded "service starting" panel) until a
  // couple of attempts have failed. This stops the scary message from flashing
  // on every first-connect-after-idle while still surfacing it for a genuinely
  // stuck backend.
  if (status === "checking" || attempt < 2) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  // unavailable (persisted past the initial cold-start window)
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4 px-4 text-center">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" />
      <h2 className="text-lg font-semibold text-foreground">
        {t("error.serviceStarting")}
      </h2>
      <p className="text-sm text-muted-foreground max-w-md">
        {t("error.serviceUnavailable")}
      </p>
    </div>
  );
}
