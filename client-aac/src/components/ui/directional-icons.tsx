// client-aac/src/components/ui/directional-icons.tsx
//
// THE direction rule for UI CHROME arrows. One owner, because the alternative
// is what we had: a dozen `isRTL ? <ChevronRight/> : <ChevronLeft/>` ternaries,
// three of them correct and the rest never written — so a Hebrew student's Back
// button pointed away from where back actually is (reported 2026-08-19).
//
// BACK / FORWARD are LOGICAL, not physical. `Back` points at the start edge of
// the reading direction (left in LTR, right in RTL); `Forward` at the end edge.
// Call sites say what the control MEANS and never name a side, which is the
// only spelling that cannot rot: nobody has to remember to add a ternary.
//
// This is chrome, NOT vocabulary. A symbol standing for a WORD goes through
// `rtlMirrorStyle` (shared/emoji-registry) instead — that predicate knows about
// faces, numerals and non-reversible art, none of which apply to a chevron.
//
// NOT for media transport. Rewind / fast-forward / play map to tape motion,
// not to reading order, and every platform (Material, Apple HIG) leaves them
// LTR in RTL locales. YouTubeApp's transport row deliberately does not import
// from here.

import {
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  ArrowRight,
  ArrowLeftToLine,
  ArrowRightToLine,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

/** Props every lucide icon takes that our call sites actually pass. */
interface IconProps {
  className?: string;
  size?: number | string;
}

/** Chevron toward the START of the reading direction — "back", "previous". */
export function ChevronBack(props: IconProps) {
  const { isRTL } = useLanguage();
  const Icon = isRTL ? ChevronRight : ChevronLeft;
  return <Icon {...props} />;
}

/** Chevron toward the END of the reading direction — "forward", "next". */
export function ChevronForward(props: IconProps) {
  const { isRTL } = useLanguage();
  const Icon = isRTL ? ChevronLeft : ChevronRight;
  return <Icon {...props} />;
}

/** Arrow toward the START of the reading direction. */
export function ArrowBack(props: IconProps) {
  const { isRTL } = useLanguage();
  const Icon = isRTL ? ArrowRight : ArrowLeft;
  return <Icon {...props} />;
}

/** Arrow toward the END of the reading direction. */
export function ArrowForward(props: IconProps) {
  const { isRTL } = useLanguage();
  const Icon = isRTL ? ArrowLeft : ArrowRight;
  return <Icon {...props} />;
}

/** Bar-terminated arrow toward the START — "step focus backwards" (Shift+Tab).
 *  Tab order follows reading order, so this is logical, not physical. */
export function ArrowBackToLine(props: IconProps) {
  const { isRTL } = useLanguage();
  const Icon = isRTL ? ArrowRightToLine : ArrowLeftToLine;
  return <Icon {...props} />;
}

/** Bar-terminated arrow toward the END — "step focus forwards" (Tab). */
export function ArrowForwardToLine(props: IconProps) {
  const { isRTL } = useLanguage();
  const Icon = isRTL ? ArrowLeftToLine : ArrowRightToLine;
  return <Icon {...props} />;
}

/** The solid triangle a board button wears to say "this opens another page",
 *  as a bare character for the corner marks that render text, not SVG. */
export function forwardTriangle(isRTL: boolean): string {
  return isRTL ? "◀" : "▶";
}

/** The solid triangle meaning "back / home". */
export function backTriangle(isRTL: boolean): string {
  return isRTL ? "▶" : "◀";
}
