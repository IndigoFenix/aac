// client/src/components/ConsentMissingIndicator.tsx
//
// Compact warning indicator shown when a student has no active informed
// consent record. Renders nothing when consent is present (or when we don't
// know yet). Click → opens the student-info panel where the consent wizard
// lives.

import { AlertTriangle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useActiveConsent } from "@/hooks/useConsentApi";
import { useFeaturePanel } from "@/contexts/FeaturePanelContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

interface ConsentMissingIndicatorProps {
  studentId: string | undefined;
  /** Visual size — default fits inline next to text. */
  size?: "sm" | "md";
  className?: string;
}

export function ConsentMissingIndicator({
  studentId,
  size = "sm",
  className,
}: ConsentMissingIndicatorProps) {
  const { t } = useLanguage();
  const { setActiveFeature } = useFeaturePanel();
  const consentQuery = useActiveConsent(studentId);

  // Hide while loading or when consent exists. The query returns
  // { consent: null } when there's none active — that's the trigger.
  if (!studentId) return null;
  if (consentQuery.isLoading) return null;
  const hasActive = !!consentQuery.data?.consent;
  if (hasActive) return null;

  const iconCls = size === "md" ? "w-4 h-4" : "w-3.5 h-3.5";
  const tooltip =
    t("consent.missing.indicatorTooltip") ||
    "No informed-consent record on file. Click to review.";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setActiveFeature("studentInfo");
            }}
            aria-label={tooltip}
            className={cn(
              "inline-flex items-center justify-center text-amber-600 hover:text-amber-700",
              "rounded-full focus:outline-none focus:ring-2 focus:ring-amber-400",
              className,
            )}
            data-testid="consent-missing-indicator"
          >
            <AlertTriangle className={iconCls} />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs max-w-[240px]">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
