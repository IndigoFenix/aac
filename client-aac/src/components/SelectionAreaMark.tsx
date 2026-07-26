// client-aac/src/components/SelectionAreaMark.tsx
//
// The SELECTION AREA: a small confirm target in a board button's lower corner,
// used when `selectionMethod` is "selection_area" instead of "whole_button".
//
// Why it exists: with whole-button dwell a student can't read a button's label
// without selecting it — looking IS choosing. Dwelling only this mark frees the
// rest of the button (and all of its text) to be looked at safely.
//
// It marks itself with a stylized eye — a circle with a dot in it — so the
// affordance reads as "look here". The dwell timer ring is NOT drawn here; the
// overlay (DwellOverlay / HoldHighlightOverlay) finds this element's rect and
// draws the ring around it, which is why the eye is inset well inside the plate.
//
// `data-dwell-area` is the contract: EyeTrackingDwellContext.hitTestDwell looks
// for it inside the hit `[data-dwell]` button, and its presence is what switches
// that button to fill/drain semantics. HoldHighlightOverlay honours it too, so a
// caretaker's press-and-hold has to start on the mark as well.
//
// Placement uses `inset-inline-end`, not `right`: the document root carries
// `dir="rtl"` for Hebrew/Arabic, so the logical property lands the mark in the
// lower-LEFT there without a JS direction check.

import { memo } from "react";
import { useLanguage } from "@/contexts/LanguageContext";

/** Fraction of the plate the eye graphic occupies — the rest is ring clearance. */
const EYE_INSET_RATIO = 0.58;

interface Props {
  /** CSS length for the plate (and therefore the dwell hit box). */
  size: string;
}

export const SelectionAreaMark = memo(function SelectionAreaMark({ size }: Props) {
  const { t } = useLanguage();
  return (
    <span
      data-dwell-area
      role="img"
      aria-label={t("board.selectionArea")}
      className="absolute pointer-events-none flex items-center justify-center rounded-full"
      style={{
        bottom: 3,
        insetInlineEnd: 3,
        width: size,
        height: size,
        background: "rgba(255,255,255,0.92)",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.12)",
      }}
    >
      <svg
        viewBox="0 0 16 16"
        style={{ width: `calc(${size} * ${EYE_INSET_RATIO})`, height: `calc(${size} * ${EYE_INSET_RATIO})` }}
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="rgb(51,65,85)" strokeWidth="1.6" />
        <circle cx="8" cy="8" r="2.4" fill="rgb(51,65,85)" />
      </svg>
    </span>
  );
});
