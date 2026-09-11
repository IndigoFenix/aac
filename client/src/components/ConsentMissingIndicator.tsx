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
import { useConsent } from "@/features/consent/ConsentProvider";
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
  // Read-only: this component mounts in three places at once (TopHeader,
  // ChatFeature, ChatPopup) and must NOT own an observer on the consent-active
  // query — see features/consent/ConsentProvider.tsx.
  const consent = useConsent();

  // Hide while loading, when consent exists, and when the read FAILED: a
  // warning that says "no consent on file" must rest on an answer, not on an
  // absent one. The student-info panel reports the failure honestly.
  if (!studentId) return null;
  // The provider tracks the SELECTED student; anything else is unknown here.
  if (consent.studentId !== studentId) return null;
  if (!consent.active.isSettled || consent.active.isError) return null;
  const hasActive = !!consent.active.data;
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
