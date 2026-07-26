// client-aac/src/contexts/EyeTrackingDwellContext.tsx
// Dwell selection for eye gaze or mouse/external-device cursor control.
// Hit-tests [data-dwell] elements and triggers click after dwell timeout.
//
// After a selection, hovering is disabled until the cursor moves 40px
// (straight-line) from where it was disabled. Genuine movement is the ONLY
// way to re-arm: a board rebuild that places a new button under a stationary
// cursor must never re-trigger a selection.
//
// In eyegaze mode, dwell is suspended while the gaze signal is stale (no
// fresh sample within STALE_GAZE_MS). Eyegaze providers stream continuously
// while a user is present, so silence means the tracker lost the eyes or the
// user left. Cursor-control ("mouse") mode is NOT staleness-gated — there a
// physically still cursor is the legitimate dwell gesture and stillness
// produces no events to judge freshness by.
//
// Uses requestAnimationFrame (throttled to ~20Hz) instead of setInterval so
// external devices that move the cursor without firing mousemove still work.

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import type { CalibrationSample } from "@/lib/gazeEstimator";
import type { GazePoint } from "@/lib/eyegaze/types";
import { DwellEngine, DEFAULT_REACTIVATION_PX } from "@shared/dwell-engine";
import { IntentDecoder, type IntentZone, type IntentState } from "@shared/intent-decoder";
import { pointInCornerCut } from "@shared/button-shape";

// ─── Types ───────────────────────────────────────────────────────
export type DwellMode = "off" | "eyegaze" | "mouse";

/** Which gesture selects a board button. Mirrors `aacSettings.selectionMethod`. */
export type SelectionMethod = "whole_button" | "selection_area" | "intent";

/** Live decoder readout — drives the spark and the tuning probe. */
export interface IntentReadout {
  state: IntentState;
  zone: IntentZone;
  /** Smoothed fixation centroid in viewport px. */
  centroid: { x: number; y: number };
  dispersion: number;
  threshold: number;
  /** Charging only because the fallback floor kicked in, not because it settled. */
  fallback: boolean;
  revisit: boolean;
  /** Timings derived from the AAC dwell setting, so the probe can show them. */
  timings: { chargeTimeMs: number; qualifyCoreMs: number; qualifyInkMs: number; pauseMs: number; memoryMs: number };
}

export interface DwellTarget {
  element: HTMLElement;
  rect: DOMRect;
  progress: number; // 0-1
  /** Rect of the button's SELECTION AREA, when it has one — the ring timer
   *  draws there instead of over the label. Null for whole-button dwell. */
  areaRect: DOMRect | null;
  /** Selection-area mode: the gaze is off the area and the timer is receding. */
  draining: boolean;
  /** The target's concave corner geometry, so the timer ring can trace its
   *  real outline instead of assuming a plain rounded rectangle. */
  cornerCut: { radius: number; offset: number } | null;
  /** Intent-decoder mode only: what the decoder currently believes. */
  intent: IntentReadout | null;
}

export interface DwellDebugInfo {
  hoverEnabled: boolean;
  movementFromAnchor: number;
  movementThreshold: number;
  /** True when no fresh gaze sample arrived within STALE_GAZE_MS (eyegaze mode only). */
  gazeStale: boolean;
  dwellElementLabel: string | null;
  dwellProgress: number;
  /** Intent-decoder mode only — the numbers a clinician needs to tune it. */
  intent: IntentReadout | null;
}

export interface EyeTrackingDwellContextValue {
  gazePosition: GazePoint | null;
  dwellTarget: DwellTarget | null;
  enabled: boolean;
  mode: DwellMode;
  /** Configured dwell time in ms (from aacSettings.eyegazeTimeout). Exposed so
   *  embedded games with their own dwell logic can honour the same setting. */
  dwellTimeMs: number;
  isCalibrated: boolean;
  isCalibrating: boolean;
  startCalibration: () => void;
  cancelCalibration: () => void;
  clearCalibration: () => void;
  getRawGaze: () => GazePoint | null;
  applyCalibration: (samples: CalibrationSample[]) => void;
  dwellDebug: DwellDebugInfo;
}

const DEFAULT_DEBUG: DwellDebugInfo = {
  hoverEnabled: true,
  movementFromAnchor: 0,
  movementThreshold: DEFAULT_REACTIVATION_PX,
  gazeStale: false,
  dwellElementLabel: null,
  dwellProgress: 0,
  intent: null,
};

const EyeTrackingDwellContext = createContext<EyeTrackingDwellContextValue>({
  gazePosition: null,
  dwellTarget: null,
  enabled: false,
  mode: "off",
  dwellTimeMs: 2000,
  isCalibrated: false,
  isCalibrating: false,
  startCalibration: () => {},
  cancelCalibration: () => {},
  clearCalibration: () => {},
  getRawGaze: () => null,
  applyCalibration: () => {},
  dwellDebug: DEFAULT_DEBUG,
});

export function useEyeTrackingDwell() {
  return useContext(EyeTrackingDwellContext);
}

// ─── Provider ────────────────────────────────────────────────────
interface Props {
  mode: DwellMode;
  dwellTimeMs: number;
  /** Which selection gesture is active. Defaults to whole-button dwell. */
  selectionMethod?: SelectionMethod;
  gazePoint: GazePoint | null;
  isCalibrated: boolean;
  supportsCalibration: boolean;
  getRawGaze: () => GazePoint | null;
  applyCalibration: (samples: CalibrationSample[]) => void;
  clearCalibrationData: () => void;
  children: ReactNode;
}

const TICK_INTERVAL_MS = 50; // throttle rAF to ~20Hz
// Eyegaze providers emit 20-90Hz while tracking; even blinks are shorter
// than this. No sample for this long means the signal is gone, not still.
const STALE_GAZE_MS = 500;
// The engine reports the firing tick as target:null, so the border would be
// cleared one tick short of closing — the student sees it select while the
// circle still has a gap. Hold the completed ring this long so closing the
// circle reads as the confirmation that the selection happened.
const COMPLETION_HOLD_MS = 250;

// A SELECTION AREA is only ~1/4 of a button wide, which is inside the angular
// error of most trackers. Grow its hit box by this fraction of its own size
// (clipped to the button) so aiming at the eye mark is forgiving without the
// area swallowing the label it exists to keep readable.
const AREA_HIT_PAD_RATIO = 0.35;

// The CORE mark is small — smaller than most trackers' angular error — so its
// hit box is grown by this fraction of its own size (clipped to the button, so
// it can never spill onto a neighbour). Missing it is not a failure here, only
// a slower charge, but there's no reason to make aiming harder than it is.
const CORE_HIT_PAD_RATIO = 0.6;

// A band around the button's edge that always counts as REST, even where an
// ink box reaches it. The icon and label rows between them fill nearly the
// whole button, so without this the only safe place to park a gaze would be
// the grid gutter. Together they make a lattice of rest across the board that
// costs no screen space — the only kind affordable here.
const REST_BAND_RATIO = 0.06;
const REST_BAND_MIN_PX = 4;
const REST_BAND_MAX_PX = 14;

/** What the gaze is over: the dwellable button plus its SELECTION AREA, if any. */
interface DwellHit {
  element: HTMLElement | null;
  areaRect: DOMRect | null;
  /** Only meaningful when `areaRect` is set. */
  inArea: boolean;
  /** Which part of the button the point landed on (intent-decoder mode). */
  zone: IntentZone;
}

const NO_HIT: DwellHit = { element: null, areaRect: null, inArea: false, zone: "rest" };

/**
 * Which zone of `button` the point is in.
 *   core — the small dot-in-circle mark between symbol and text: the one spot
 *          that means "I mean this one", charged at full rate.
 *   ink  — the symbol and the label: things a student READS, so they charge
 *          slowly rather than not at all.
 *   rest — everything else, including the button's padding. With the grid
 *          gutters that forms a lattice of places to park a gaze safely, which
 *          is a rest area costing no screen space.
 * A button with no `data-dwell-zone` children isn't decoder-aware (board
 * chrome, overlays, quick actions): the whole of it counts as core, because
 * those are recognised by shape and position rather than read, so there is
 * nothing to protect from an accidental selection.
 */
export function zoneAt(button: HTMLElement, x: number, y: number): IntentZone {
  const zones = button.querySelectorAll<HTMLElement>("[data-dwell-zone]");
  if (zones.length === 0) return "core";
  const btn = button.getBoundingClientRect();

  // Core first, and padded: it's the smallest target, and near the boundary a
  // student aiming at the mark should get the mark rather than the row beside it.
  for (const el of Array.from(zones)) {
    if (el.dataset.dwellZone !== "core") continue;
    const r = el.getBoundingClientRect();
    const pad = Math.min(r.width, r.height) * CORE_HIT_PAD_RATIO;
    if (
      x >= Math.max(btn.left, r.left - pad) &&
      x <= Math.min(btn.right, r.right + pad) &&
      y >= Math.max(btn.top, r.top - pad) &&
      y <= Math.min(btn.bottom, r.bottom + pad)
    ) {
      return "core";
    }
  }

  // The button's own edge band is rest whatever sits under it.
  const band = Math.min(
    REST_BAND_MAX_PX,
    Math.max(REST_BAND_MIN_PX, Math.min(btn.width, btn.height) * REST_BAND_RATIO),
  );
  if (
    x < btn.left + band ||
    x > btn.right - band ||
    y < btn.top + band ||
    y > btn.bottom - band
  ) {
    return "rest";
  }

  for (const el of Array.from(zones)) {
    if (el.dataset.dwellZone !== "ink") continue;
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return "ink";
  }

  return "rest";
}

/** Find the [data-dwell] element under a point, respecting [data-dwell-trap] boundaries. */
function findDwellElement(x: number, y: number): HTMLElement | null {
  const elements = document.elementsFromPoint(x, y);
  for (const el of elements) {
    const htmlEl = el as HTMLElement;
    // A REST MARKER sits ABOVE the buttons, so meeting one before any dwellable
    // element means the gaze is in the gap between buttons, not on one.
    if (htmlEl.closest("[data-dwell-void]")) return null;
    const trap = htmlEl.closest("[data-dwell-trap]") as HTMLElement | null;
    if (trap) {
      const found = htmlEl.closest("[data-dwell]") as HTMLElement | null;
      return found && trap.contains(found) ? found : null;
    }
    const found = htmlEl.closest("[data-dwell]") as HTMLElement | null;
    if (found) return inCornerCut(found, x, y) ? null : found;
  }
  return null;
}

/**
 * A shaped button's LAYOUT box stays a rectangle however its surface is drawn,
 * so `elementsFromPoint` still reports a hit in the bitten-out corner. Exclude
 * it explicitly: the gap belongs to no button, and the shape would otherwise
 * be lying about what it does. `data-corner-cut` is published by ShapedButton
 * as the resolved "radius,offset" in px.
 */
function inCornerCut(el: HTMLElement, x: number, y: number): boolean {
  const cut = cornerCutOf(el);
  if (!cut) return false;
  return pointInCornerCut(el.getBoundingClientRect(), cut.radius, cut.offset, x, y);
}

/** The element's resolved corner-cut geometry, or null when it isn't shaped.
 *  Also drives the dwell ring, so the timer traces the button's real outline. */
export function cornerCutOf(el: HTMLElement): { radius: number; offset: number } | null {
  const spec = el.dataset.cornerCut;
  if (!spec) return null;
  const [radius, offset] = spec.split(",").map(Number);
  return radius > 0 ? { radius, offset } : null;
}

/**
 * The button's SELECTION AREA (confirm) child, or null when the whole button is
 * the dwell target. Shared with HoldHighlightOverlay so both gestures agree on
 * what counts as a selection area.
 */
export function selectionAreaOf(button: HTMLElement): HTMLElement | null {
  return button.querySelector("[data-dwell-area]") as HTMLElement | null;
}

/**
 * Is (x, y) inside `area`'s padded box? Padding is clipped to `button` so a
 * generous hit box can never spill onto a neighbouring button.
 */
export function pointInSelectionArea(button: HTMLElement, area: HTMLElement, x: number, y: number): boolean {
  const areaRect = area.getBoundingClientRect();
  const btnRect = button.getBoundingClientRect();
  const pad = Math.min(areaRect.width, areaRect.height) * AREA_HIT_PAD_RATIO;
  return (
    x >= Math.max(btnRect.left, areaRect.left - pad) &&
    x <= Math.min(btnRect.right, areaRect.right + pad) &&
    y >= Math.max(btnRect.top, areaRect.top - pad) &&
    y <= Math.min(btnRect.bottom, areaRect.bottom + pad)
  );
}

/**
 * Hit-test a point against the dwellable button under it and — when that button
 * carries a selection area — whether the point is inside it.
 */
export function hitTestDwell(x: number, y: number, needZone = false): DwellHit {
  const element = findDwellElement(x, y);
  if (!element) return NO_HIT;

  // Zone resolution costs a rect read per zone box, so it's skipped entirely
  // outside intent mode rather than paid for on every tick.
  const zone: IntentZone = needZone ? zoneAt(element, x, y) : "core";
  const areaEl = selectionAreaOf(element);
  if (!areaEl) return { element, areaRect: null, inArea: false, zone };

  return {
    element,
    areaRect: areaEl.getBoundingClientRect(),
    inArea: pointInSelectionArea(element, areaEl, x, y),
    zone,
  };
}

export function EyeTrackingDwellProvider({
  mode,
  dwellTimeMs,
  selectionMethod = "whole_button",
  gazePoint: externalGazePoint,
  isCalibrated: externalIsCalibrated,
  supportsCalibration,
  getRawGaze,
  applyCalibration: externalApplyCalibration,
  clearCalibrationData,
  children,
}: Props) {
  const enabled = mode !== "off";

  // ── React state (for rendering) ──
  const [gazePosition, setGazePosition] = useState<GazePoint | null>(null);
  const [dwellTarget, setDwellTarget] = useState<DwellTarget | null>(null);
  const [isCalibrated, setIsCalibrated] = useState(externalIsCalibrated);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [dwellDebug, setDwellDebug] = useState<DwellDebugInfo>(DEFAULT_DEBUG);

  // ── Cursor position refs (written by events/prop, read by rAF loop) ──
  const cursorPosRef = useRef<GazePoint | null>(null);  // mouse mode
  const gazePointRef = useRef<GazePoint | null>(null);   // eyegaze mode

  // ── Dwell state (decision logic lives in the shared DwellEngine) ──
  const gazeUpdatedAtRef = useRef(0); // performance.now() of last fresh gaze sample
  // Held here rather than inside the rAF loop because the decoder must be fed
  // every FRESH sample at the tracker's own rate — dispersion measured off
  // 20Hz render ticks would repeat stale points and fake a steady fixation.
  const decoderRef = useRef<IntentDecoder<HTMLElement> | null>(null);

  // ── Stable refs for props that change often ──
  const isCalibratingRef = useRef(isCalibrating);
  isCalibratingRef.current = isCalibrating;

  // ── Sync props to refs ──
  useEffect(() => { setIsCalibrated(externalIsCalibrated); }, [externalIsCalibrated]);
  useEffect(() => {
    gazePointRef.current = externalGazePoint;
    // Each gaze sample arrives as a fresh object, so this effect runs per
    // sample even when coordinates repeat — making it a freshness signal.
    if (externalGazePoint) {
      gazeUpdatedAtRef.current = performance.now();
      decoderRef.current?.addSample(externalGazePoint.x, externalGazePoint.y, gazeUpdatedAtRef.current);
    }
  }, [externalGazePoint]);

  // ── Mouse/pointer tracking (mouse mode) ──
  useEffect(() => {
    if (mode !== "mouse") { cursorPosRef.current = null; return; }
    const handler = (e: PointerEvent | MouseEvent) => {
      cursorPosRef.current = { x: e.clientX, y: e.clientY };
      decoderRef.current?.addSample(e.clientX, e.clientY, performance.now());
    };
    // Listen to both — pointermove covers more input device types
    window.addEventListener("pointermove", handler, { passive: true });
    window.addEventListener("mousemove", handler, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handler);
      window.removeEventListener("mousemove", handler);
    };
  }, [mode]);

  // ── Calibration controls ──
  const startCalibration = useCallback(() => {
    if (mode !== "eyegaze" || !supportsCalibration) return;
    setIsCalibrating(true);
  }, [mode, supportsCalibration]);

  const cancelCalibration = useCallback(() => { setIsCalibrating(false); }, []);

  const clearCalibration = useCallback(() => {
    clearCalibrationData();
    setIsCalibrated(false);
  }, [clearCalibrationData]);

  const applyCalibrationWrapped = useCallback((samples: CalibrationSample[]) => {
    externalApplyCalibration(samples);
    setIsCalibrated(true);
    setIsCalibrating(false);
  }, [externalApplyCalibration]);

  // ── Auto-trigger calibration on first eyegaze use ──
  const autoCalibTriggeredRef = useRef(false);
  const supportsCalibrationRef = useRef(supportsCalibration);
  supportsCalibrationRef.current = supportsCalibration;
  useEffect(() => {
    if (mode === "eyegaze" && supportsCalibration && !isCalibrated && !isCalibrating && !autoCalibTriggeredRef.current) {
      autoCalibTriggeredRef.current = true;
      const timer = setTimeout(() => {
        if (supportsCalibrationRef.current) startCalibration();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [mode, supportsCalibration, isCalibrated, isCalibrating, startCalibration]);

  useEffect(() => {
    if (mode !== "eyegaze") autoCalibTriggeredRef.current = false;
  }, [mode]);

  // ── Main rAF loop ──
  useEffect(() => {
    if (!enabled) {
      setGazePosition(null);
      setDwellTarget(null);
      setDwellDebug(DEFAULT_DEBUG);
      return;
    }

    // Fresh engine per mode/timing change: staleness gating applies to
    // eyegaze only — in cursor-control mode a still cursor IS the dwell
    // gesture and stillness produces no events to judge freshness by.
    const staleGazeMs = mode === "eyegaze" ? STALE_GAZE_MS : null;
    const useIntent = selectionMethod === "intent";
    // Exactly one engine runs at a time. They can't be mixed per-button: both
    // own the post-selection re-arm anchor, and two of those would let a single
    // gaze fire twice.
    const engine = useIntent ? null : new DwellEngine<HTMLElement>({ dwellTimeMs, staleGazeMs });
    const decoder = useIntent
      ? new IntentDecoder<HTMLElement>({ dwellTimeMs, staleGazeMs })
      : null;
    decoderRef.current = decoder;
    // Constant for this decoder's lifetime — read once rather than per tick.
    const timings = decoder?.timings ?? null;

    let rafId: number;
    let lastTickTime = 0;
    // Timestamp until which the completed ring stays painted; 0 = not holding.
    let completionHoldUntil = 0;

    const tick = (time: number) => {
      rafId = requestAnimationFrame(tick);

      // Throttle to ~20Hz
      if (time - lastTickTime < TICK_INTERVAL_MS) return;
      lastTickTime = time;

      // Get current point
      const point = mode === "mouse" ? cursorPosRef.current : gazePointRef.current;
      if (!point || isCalibratingRef.current) {
        setGazePosition(point ?? null);
        setDwellTarget(null);
        completionHoldUntil = 0;
        engine?.clearTarget();
        decoder?.clearTarget();
        return;
      }

      setGazePosition(point);

      const hit = hitTestDwell(point.x, point.y, useIntent);

      let r: {
        target: HTMLElement | null;
        fired: HTMLElement | null;
        progress: number;
        draining: boolean;
        hoverEnabled: boolean;
        gazeStale: boolean;
        movementFromAnchor: number;
      };
      let readout: IntentReadout | null = null;

      if (decoder) {
        const d = decoder.update(hit.element, hit.zone, point, time, gazeUpdatedAtRef.current);
        r = d;
        readout =
          d.centroid && timings
            ? {
                state: d.state,
                zone: d.zone,
                centroid: d.centroid,
                dispersion: d.dispersion,
                threshold: d.threshold,
                fallback: d.fallback,
                revisit: d.revisit,
                timings,
              }
            : null;
      } else {
        // `inArea` stays undefined for buttons with no selection area, which
        // keeps them on whole-button dwell.
        r = engine!.update(
          hit.element,
          point,
          time,
          gazeUpdatedAtRef.current,
          hit.areaRect ? hit.inArea : undefined,
        );
      }

      // Measure before the click: the handler may re-render the board and
      // detach the element, which would collapse its rect to zeros.
      const firedRect = r.fired?.getBoundingClientRect() ?? null;
      const firedAreaRect = r.fired === hit.element ? hit.areaRect : null;
      if (r.fired) r.fired.click();

      if (r.target) {
        completionHoldUntil = 0;
        setDwellTarget({
          element: r.target,
          rect: r.target.getBoundingClientRect(),
          progress: r.progress,
          areaRect: hit.areaRect,
          draining: r.draining,
          cornerCut: cornerCutOf(r.target),
          intent: readout,
        });
      } else if (r.fired && firedRect) {
        // Paint the closed circle on the element that just fired, using the
        // pre-click rect so it survives the board re-rendering underneath it.
        completionHoldUntil = time + COMPLETION_HOLD_MS;
        setDwellTarget({
          element: r.fired,
          rect: firedRect,
          progress: 1,
          areaRect: firedAreaRect,
          draining: false,
          cornerCut: cornerCutOf(r.fired),
          intent: readout,
        });
      } else if (time >= completionHoldUntil) {
        completionHoldUntil = 0;
        setDwellTarget(null);
      }
      setDwellDebug({
        hoverEnabled: r.hoverEnabled,
        movementFromAnchor: r.movementFromAnchor,
        movementThreshold: DEFAULT_REACTIVATION_PX,
        gazeStale: r.gazeStale,
        dwellElementLabel: (r.target ?? r.fired)?.textContent?.slice(0, 30) ?? null,
        dwellProgress: r.progress,
        intent: readout,
      });
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      decoderRef.current = null;
    };
  }, [enabled, mode, dwellTimeMs, selectionMethod]);

  return (
    <EyeTrackingDwellContext.Provider
      value={{
        gazePosition,
        dwellTarget,
        enabled,
        mode,
        dwellTimeMs,
        isCalibrated,
        isCalibrating,
        startCalibration,
        cancelCalibration,
        clearCalibration,
        getRawGaze,
        applyCalibration: applyCalibrationWrapped,
        dwellDebug,
      }}
    >
      {children}
    </EyeTrackingDwellContext.Provider>
  );
}
