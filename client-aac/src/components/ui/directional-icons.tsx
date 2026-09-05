// client-aac/src/components/ui/directional-icons.tsx
//
// THE direction rule for UI CHROME arrows, as this client sees it. One owner,
// because the alternative is what we had: a dozen
// `isRTL ? <ChevronRight/> : <ChevronLeft/>` ternaries, three of them correct
// and the rest never written — so a Hebrew student's Back button pointed away
// from where back actually is (reported 2026-08-19).
//
// BACK / FORWARD are LOGICAL, not physical. `Back` points at the start edge of
// the reading direction (left in LTR, right in RTL); `Forward` at the end edge.
// Call sites say what the control MEANS and never name a side, which is the
// only spelling that cannot rot: nobody has to remember to add a ternary.
//
// The icons THEMSELVES now live in `@client-shared/builder/directional-icons`,
// which takes the direction as an explicit `rtl` prop — the clinician's "Edit
// visual" builder renders the same chrome from a different language context.
// This file is the AAC's binding of that prop to `useLanguage().isRTL`, and it
// keeps the API every app-chrome call site already imports: a caller here still
// passes only `className` / `size` and still never names a side.
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
  ChevronBack as SharedChevronBack,
  ChevronForward as SharedChevronForward,
  ArrowBack as SharedArrowBack,
  ArrowForward as SharedArrowForward,
  ArrowBackToLine as SharedArrowBackToLine,
  ArrowForwardToLine as SharedArrowForwardToLine,
} from "@client-shared/builder/directional-icons";
import { useLanguage } from "@/contexts/LanguageContext";

export { forwardTriangle, backTriangle } from "@client-shared/builder/directional-icons";

/** Props every lucide icon takes that our call sites actually pass. */
interface IconProps {
  className?: string;
  size?: number | string;
}

/** Chevron toward the START of the reading direction — "back", "previous". */
export function ChevronBack(props: IconProps) {
  const { isRTL } = useLanguage();
  return <SharedChevronBack {...props} rtl={isRTL} />;
}

/** Chevron toward the END of the reading direction — "forward", "next". */
export function ChevronForward(props: IconProps) {
  const { isRTL } = useLanguage();
  return <SharedChevronForward {...props} rtl={isRTL} />;
}

/** Arrow toward the START of the reading direction. */
export function ArrowBack(props: IconProps) {
  const { isRTL } = useLanguage();
  return <SharedArrowBack {...props} rtl={isRTL} />;
}

/** Arrow toward the END of the reading direction. */
export function ArrowForward(props: IconProps) {
  const { isRTL } = useLanguage();
  return <SharedArrowForward {...props} rtl={isRTL} />;
}

/** Bar-terminated arrow toward the START — "step focus backwards" (Shift+Tab).
 *  Tab order follows reading order, so this is logical, not physical. */
export function ArrowBackToLine(props: IconProps) {
  const { isRTL } = useLanguage();
  return <SharedArrowBackToLine {...props} rtl={isRTL} />;
}

/** Bar-terminated arrow toward the END — "step focus forwards" (Tab). */
export function ArrowForwardToLine(props: IconProps) {
  const { isRTL } = useLanguage();
  return <SharedArrowForwardToLine {...props} rtl={isRTL} />;
}
