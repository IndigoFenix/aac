// client-aac/src/components/IntentCoreMark.tsx
//
// Marks the button's FAST-SELECT centre for the gaze intent decoder: a faint
// dot-in-circle sitting in the gap between the symbol and the text.
//
// Why it's there. The decoder charges from anywhere on the button, but not at
// the same speed — the icon and the label are things a student READS, so they
// charge slowly, while this spot is the one place that means "I mean this one"
// and charges at full rate. An unmarked fast zone is an invisible rule; a
// student can't aim at something they can't see, and a clinician can't explain
// it. So the zone gets a mark.
//
// It is deliberately FAINT. Unlike the selection-area eye mark this replaced,
// aiming here is an accelerator and not a requirement — anything that read as
// a button ("press here") would misrepresent what it does.
//
// Carries `data-dwell-zone="core"`; the icon and label rows carry "ink". It is
// a real flex item rather than an absolute overlay so it can never sit on top
// of the symbol or the text, whatever the icon-text ratio.

import { memo } from "react";

interface Props {
  /** CSS length for the mark's height; it reserves this much of the button. */
  size: string;
}

export const IntentCoreMark = memo(function IntentCoreMark({ size }: Props) {
  return (
    // Square and only as wide as the mark itself: the hit zone IS what's drawn,
    // so the decoder never treats a band the student can't see as "the centre".
    <span
      data-dwell-zone="core"
      aria-hidden="true"
      className="flex items-center justify-center shrink-0 pointer-events-none"
      style={{ height: size, width: size }}
    >
      <svg
        viewBox="0 0 16 16"
        style={{ height: "100%", width: "100%", opacity: 0.28 }}
        fill="none"
      >
        <circle cx="8" cy="8" r="5.4" stroke="rgb(30,41,59)" strokeWidth="1.2" />
        <circle cx="8" cy="8" r="1.9" fill="rgb(30,41,59)" />
      </svg>
    </span>
  );
});

export default IntentCoreMark;
