// client-aac/src/components/HoldHighlightOverlay.tsx
// Press-and-hold (mouse/touch) to HIGHLIGHT a board button instead of selecting it.
//
// Only active while eyegaze is enabled. In that mode a normal tap still selects
// the button exactly as before, but pressing and *holding* a button draws a
// yellow ring-timer + border extension (mirroring the eyegaze dwell effect, but
// yellow) and, once the hold completes, marks that button with a yellow
// highlight — and speaks its sentence via the client-side TTS — rather than
// selecting it. The highlight lasts only as long as the press: releasing (or
// cancelling) the pointer clears it. This lets a caretaker point a student
// toward a target without triggering selection.
//
// The committed highlight is owned by BoardAudioContext (shared with the audio
// scan feature), so a single yellow box is drawn whether the highlight came
// from a hold or from the scan. The in-progress ring/border below is local to
// the hold gesture.
//
// Hit-tests the same [data-dwell] elements the eyegaze dwell engine uses — and
// honours the same SELECTION AREA contract: when the pressed button carries a
// [data-dwell-area] child (selectionMethod "selection_area"), the press has to
// start ON that mark, and the ring draws around it rather than over the label.
// No drain behaviour here — a pointer either stays down or it doesn't.

import { useEffect, useRef, useState } from "react";
import { useBoardAudio } from "@/contexts/BoardAudioContext";
import { selectionAreaOf, pointInSelectionArea } from "@/contexts/EyeTrackingDwellContext";

const BORDER_WIDTH = 4;
const BORDER_RADIUS = 12; // matches rounded-xl
const RING_STROKE = 6;
const ACCENT = "rgba(250, 204, 21, 0.95)"; // yellow-400 — the in-progress ring/border
const HIGHLIGHT_STROKE = "rgba(234, 179, 8, 1)"; // yellow-500 — committed highlight border
const HIGHLIGHT_FILL = "rgba(250, 204, 21, 0.22)"; // committed highlight wash
// A drag or scroll away from the button this far cancels the hold — only a
// steady press over one button should commit a highlight.
const MOVE_TOLERANCE_PX = 24;
// Never let a mis-set timeout make the hold instant/unreachable.
const MIN_HOLD_MS = 400;
const TICK_MS = 40; // ~25Hz — enough to follow scroll/layout without churn.

interface HoldVisual {
  /** The button — the clock border traces this. */
  rect: DOMRect;
  /** Where the ring timer draws: the selection area when there is one. */
  ringRect: DOMRect;
  progress: number; // 0-1
}

interface Props {
  /** Only active when eyegaze is enabled (the tap-vs-hold contract only applies then). */
  enabled: boolean;
  /** Hold duration before the highlight commits — mirrors the dwell timeout. */
  holdDurationMs: number;
}

function rectsEqual(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

export default function HoldHighlightOverlay({ enabled, holdDurationMs }: Props) {
  const { highlightEl, highlight } = useBoardAudio();
  const [hold, setHold] = useState<HoldVisual | null>(null);

  // The context's highlight() speaks on commit; keep it in a ref so the hold
  // effect (keyed only on `enabled`) always calls the current version.
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;

  // Mutable hold state shared between the DOM event handlers and the rAF loop.
  const activeRef = useRef<{
    element: HTMLElement;
    /** The button's selection area, when it has one. Null = whole-button hold. */
    areaEl: HTMLElement | null;
    pointerId: number;
    startTime: number;
    completed: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false); // eat the click that follows a committed hold
  const rafRef = useRef<number | null>(null);
  const holdSnapRef = useRef<HoldVisual | null>(null); // last rendered ring, for change-detection

  const holdDurationRef = useRef(MIN_HOLD_MS);
  holdDurationRef.current = Math.max(MIN_HOLD_MS, holdDurationMs || 0);

  useEffect(() => {
    if (!enabled) return; // hold-to-highlight is an eyegaze-mode gesture

    let lastTick = 0;

    const pushHold = (next: HoldVisual | null) => {
      const prev = holdSnapRef.current;
      const changed =
        !!prev !== !!next ||
        (prev &&
          next &&
          (!rectsEqual(prev.rect, next.rect) ||
            !rectsEqual(prev.ringRect, next.ringRect) ||
            Math.abs(prev.progress - next.progress) > 0.005));
      if (changed) {
        holdSnapRef.current = next;
        setHold(next);
      }
    };

    const loop = (t: number) => {
      const active = activeRef.current;
      if (active) {
        rafRef.current = requestAnimationFrame(loop);
      } else {
        rafRef.current = null;
      }
      if (t - lastTick < TICK_MS) return;
      lastTick = t;

      if (!active) {
        pushHold(null);
        return;
      }
      if (!document.contains(active.element)) {
        activeRef.current = null;
        pushHold(null);
        return;
      }
      const rect = active.element.getBoundingClientRect();
      // The area element can be replaced by a board re-render mid-hold; fall
      // back to the button rather than dropping the ring.
      const ringRect =
        active.areaEl && document.contains(active.areaEl) ? active.areaEl.getBoundingClientRect() : rect;
      const progress = Math.min(1, (t - active.startTime) / holdDurationRef.current);
      if (progress >= 1 && !active.completed) {
        // Commit: this button becomes the highlight (and is spoken); the click
        // that will follow the pointer release must NOT select it.
        active.completed = true;
        suppressClickRef.current = true;
        highlightRef.current(active.element, true);
      }
      // Once committed the ring gives way to the persistent highlight box.
      pushHold(active.completed ? null : { rect, ringRect, progress });
    };

    const ensureLoop = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(loop);
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = (e.target as HTMLElement | null)?.closest("[data-dwell]") as HTMLElement | null;
      if (!target) return;
      // Selection-area buttons: the hold must START on the eye mark, same as the
      // gaze timer. A press anywhere else on the button is just a tap (which
      // still selects normally on release).
      const areaEl = selectionAreaOf(target);
      if (areaEl && !pointInSelectionArea(target, areaEl, e.clientX, e.clientY)) return;
      activeRef.current = {
        element: target,
        areaEl,
        pointerId: e.pointerId,
        startTime: performance.now(),
        completed: false,
      };
      ensureLoop();
    };

    const onPointerMove = (e: PointerEvent) => {
      const active = activeRef.current;
      if (!active || e.pointerId !== active.pointerId || active.completed) return;
      // Drift is measured against whatever the hold started on — the eye mark
      // when there is one, so sliding off it onto the label abandons the hold.
      const anchorEl = active.areaEl && document.contains(active.areaEl) ? active.areaEl : active.element;
      const r = anchorEl.getBoundingClientRect();
      const outside =
        e.clientX < r.left - MOVE_TOLERANCE_PX ||
        e.clientX > r.right + MOVE_TOLERANCE_PX ||
        e.clientY < r.top - MOVE_TOLERANCE_PX ||
        e.clientY > r.bottom + MOVE_TOLERANCE_PX;
      if (outside) {
        // Dragged/scrolled off before committing — abandon the hold. No click is
        // suppressed, so this behaves like a cancelled press.
        activeRef.current = null;
        pushHold(null);
      }
    };

    const endHold = (e: PointerEvent) => {
      const active = activeRef.current;
      if (!active || e.pointerId !== active.pointerId) return;
      const wasCompleted = active.completed;
      activeRef.current = null;
      pushHold(null);
      if (wasCompleted) {
        // The highlight lives only for the duration of the press — releasing (or
        // cancelling) the pointer clears it.
        highlightRef.current(null);
        // A committed hold arms suppressClick for the trailing click. pointercancel
        // produces no click, so disarm it to avoid eating an unrelated later click.
        if (e.type === "pointercancel") suppressClickRef.current = false;
      }
      // A short press (released before completion) is a normal tap: leave the
      // click alone so selection happens exactly as it does today.
    };

    const onClickCapture = (e: MouseEvent) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      e.stopPropagation();
      e.preventDefault();
    };

    const onContextMenu = (e: Event) => {
      // Long-press on touch would otherwise pop the context menu / selection.
      if (activeRef.current) e.preventDefault();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", endHold, true);
    window.addEventListener("pointercancel", endHold, true);
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("contextmenu", onContextMenu, true);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      activeRef.current = null;
      suppressClickRef.current = false;
      holdSnapRef.current = null;
      setHold(null);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", endHold, true);
      window.removeEventListener("pointercancel", endHold, true);
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, [enabled]);

  // Nothing to draw unless there's a committed highlight or an in-progress hold.
  if (!highlightEl && !hold) return null;

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9998 }}>
      <HighlightTracker el={highlightEl} />
      {hold && (
        <>
          <HoldBorder rect={hold.rect} progress={hold.progress} />
          <HoldRing
            rect={hold.ringRect}
            progress={hold.progress}
            /* On the eye mark the ring hugs the mark; on a whole button it
               sits at 60% so it doesn't crowd the icon. */
            fillFraction={hold.ringRect === hold.rect ? 0.6 : 1}
          />
        </>
      )}
    </div>
  );
}

/** Follows the highlighted button's rect (scroll/layout) and draws the box. */
function HighlightTracker({ el }: { el: HTMLElement | null }) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!el) {
      setRect(null);
      return;
    }
    let raf: number | null = null;
    let last = 0;
    const loop = (t: number) => {
      if (t - last >= TICK_MS) {
        last = t;
        if (!document.contains(el)) {
          setRect(null);
          return; // element gone — stop tracking
        }
        const r = el.getBoundingClientRect();
        setRect((prev) => (rectsEqual(prev, r) ? prev : r));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [el]);

  if (!rect) return null;
  return <HighlightBox rect={rect} />;
}

/** Solid yellow border + soft wash marking the committed highlight. */
function HighlightBox({ rect }: { rect: DOMRect }) {
  const pad = BORDER_WIDTH / 2;
  const x = rect.left - pad;
  const y = rect.top - pad;
  const w = rect.width + BORDER_WIDTH;
  const h = rect.height + BORDER_WIDTH;
  return (
    <svg style={{ position: "absolute", left: x, top: y, width: w, height: h, overflow: "visible" }}>
      <rect
        x={BORDER_WIDTH / 2}
        y={BORDER_WIDTH / 2}
        width={w - BORDER_WIDTH}
        height={h - BORDER_WIDTH}
        rx={BORDER_RADIUS}
        ry={BORDER_RADIUS}
        fill={HIGHLIGHT_FILL}
        stroke={HIGHLIGHT_STROKE}
        strokeWidth={BORDER_WIDTH}
      />
    </svg>
  );
}

/** Clock-border that draws itself around the button as the hold progresses. */
function HoldBorder({ rect, progress }: { rect: DOMRect; progress: number }) {
  const pad = BORDER_WIDTH / 2;
  const x = rect.left - pad;
  const y = rect.top - pad;
  const w = rect.width + BORDER_WIDTH;
  const h = rect.height + BORDER_WIDTH;

  const perimeter = 2 * (w + h) - 8 * BORDER_RADIUS + 2 * Math.PI * BORDER_RADIUS;
  const dashOffset = perimeter * (1 - progress);

  return (
    <svg style={{ position: "absolute", left: x, top: y, width: w, height: h, overflow: "visible" }}>
      <rect
        x={BORDER_WIDTH / 2}
        y={BORDER_WIDTH / 2}
        width={w - BORDER_WIDTH}
        height={h - BORDER_WIDTH}
        rx={BORDER_RADIUS}
        ry={BORDER_RADIUS}
        fill="none"
        stroke={ACCENT}
        strokeWidth={BORDER_WIDTH}
        strokeDasharray={perimeter}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Circular ring-timer centred on the hold target, filling as the hold progresses. */
function HoldRing({ rect, progress, fillFraction }: { rect: DOMRect; progress: number; fillFraction: number }) {
  const diameter = Math.min(rect.width, rect.height) * fillFraction;
  // The eye mark is small, so a fixed 6px stroke would swallow it whole.
  const stroke = Math.max(2, Math.min(RING_STROKE, diameter * 0.18));
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress);

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const svgSize = diameter;

  return (
    <svg style={{ position: "absolute", left: cx - svgSize / 2, top: cy - svgSize / 2, width: svgSize, height: svgSize }}>
      <circle
        cx={svgSize / 2}
        cy={svgSize / 2}
        r={radius}
        fill="none"
        stroke="rgba(255, 255, 255, 0.25)"
        strokeWidth={stroke}
      />
      <circle
        cx={svgSize / 2}
        cy={svgSize / 2}
        r={radius}
        fill="none"
        stroke={ACCENT}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${svgSize / 2} ${svgSize / 2})`}
      />
    </svg>
  );
}
