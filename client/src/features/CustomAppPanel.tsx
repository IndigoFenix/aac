// src/features/CustomAppPanel.tsx
//
// The games / custom-apps editor is being rebuilt from scratch, so this panel
// is a placeholder until the new one lands. The sidebar entry stays visible
// (still gated on the customAppsEnabled licence permission) so navigation
// doesn't shift under existing users.
//
// The previous 3-pane editor still lives in ./custom-app/* but nothing renders
// it. useCustomAppStore is deliberately untouched — useChat still lets the AI
// edit a GameDefinition through it, independently of this panel.

import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";
import { Gamepad2 } from "lucide-react";

interface CustomAppPanelProps {
  isOpen?: boolean;
}

export function CustomAppPanel(_props: CustomAppPanelProps) {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  return (
    <div
      className={cn(
        "h-full w-full flex flex-col",
        isDark ? "bg-slate-950 text-slate-100" : "bg-gray-50 text-slate-900",
      )}
      data-testid="custom-app-panel"
    >
      {/* Header */}
      <div
        className={cn(
          "border-b px-4 py-2 shrink-0 flex items-center gap-2",
          isDark ? "bg-slate-900 border-slate-800" : "bg-white border-gray-200",
        )}
      >
        <Gamepad2 className="w-4 h-4" />
        <span className="text-sm font-medium">{t("customApps.title")}</span>
      </div>

      {/* Coming soon */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <Gamepad2
            className={cn("w-10 h-10 mx-auto", isDark ? "text-slate-600" : "text-gray-400")}
            aria-hidden="true"
          />
          <h2 className="text-lg font-semibold">{t("customApps.comingSoonTitle")}</h2>
          <p className={cn("text-sm", isDark ? "text-slate-400" : "text-gray-600")}>
            {t("customApps.comingSoonBody")}
          </p>
        </div>
      </div>
    </div>
  );
}
