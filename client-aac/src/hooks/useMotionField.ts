// client-aac/src/hooks/useMotionField.ts
//
// Landmark-free dense motion energy, by frame differencing a heavily downscaled
// copy of the shared user-camera <video>.
//
// WHY: every landmark tracker degrades worst at exactly the moment the seizure
// detector needs it most. Hand landmarks fail on motion blur, on hands crossing
// and interlocking (which is what Rett hand-wringing IS), and on the fast
// out-of-plane rotation of a convulsion. Pose collapses at this camera distance.
// A per-pixel difference has none of those failure modes: it cannot lose track
// of a hand, because it never tracked one. It cannot tell you WHICH body part
// moved — that is what the landmark regions are for — but it always answers
// "how much, where in the frame, and at what rhythm".
//
// So this is the corroboration channel, not the primary one. It is cheap enough
// to leave running whenever seizure detection is on: at 32×24 a difference is
// 768 subtractions, orders of magnitude below one MediaPipe inference.
//
// ⚠️ `left`/`right` are the STUDENT's sides. The camera stream is unmirrored, so
// the student's left appears on the IMAGE's right. See seizureMotionSource.ts
// for the full note — the two files must agree or sided markers break.

import { useEffect, useRef } from "react";
import type { MotionFieldSample } from "@shared/aac/motion-types";
import type { BoundingBox } from "@/lib/faceTrackingTypes";

/** Downscale target. Small enough to be free, large enough to separate the head
 *  band from the band below it and left from right. */
const GRID_W = 32;
const GRID_H = 24;
/** Luma deltas below this are sensor noise, not movement. 0..255. */
const NOISE_FLOOR = 8;
/** Where the face sits when we have no face box — upper-middle of the frame. */
const DEFAULT_HEAD_BAND = { top: 0.05, bottom: 0.45 };

export interface UseMotionFieldOptions {
  videoEl: HTMLVideoElement | null;
  enabled: boolean;
  /** Sampling period. The host drops this during a seizure watch so the dense
   *  channel can resolve the clonic band alongside the landmark channels. */
  intervalMs: number;
  /** The student's face box, to place the head/lower band split. Optional —
   *  without it a fixed band split is used, which is coarser but never wrong
   *  enough to matter for a whole-frame energy read. */
  faceBox?: BoundingBox | null;
}

export interface UseMotionFieldReturn {
  /** Non-reactive getter — the DSP samples this when it builds a frame. Kept
   *  off React state on purpose: at watch cadence this ticks ~15×/s and
   *  re-rendering home.tsx that often would cost far more than the maths. */
  getSample: () => MotionFieldSample | null;
}

export function useMotionField(options: UseMotionFieldOptions): UseMotionFieldReturn {
  const { videoEl, enabled, intervalMs, faceBox } = options;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const prevRef = useRef<Uint8ClampedArray | null>(null);
  const prevTsRef = useRef(0);
  const sampleRef = useRef<MotionFieldSample | null>(null);
  const faceBoxRef = useRef<BoundingBox | null | undefined>(faceBox);
  faceBoxRef.current = faceBox;

  useEffect(() => {
    if (!enabled || !videoEl) {
      prevRef.current = null;
      sampleRef.current = null;
      return;
    }

    if (!canvasRef.current) {
      const c = document.createElement("canvas");
      c.width = GRID_W;
      c.height = GRID_H;
      canvasRef.current = c;
      // willReadFrequently: this canvas exists only to be read back.
      ctxRef.current = c.getContext("2d", { willReadFrequently: true });
    }
    const ctx = ctxRef.current;
    if (!ctx) return;

    const tick = () => {
      const video = videoEl;
      if (!video || video.readyState < 2) return;
      const now = Date.now();

      try {
        ctx.drawImage(video, 0, 0, GRID_W, GRID_H);
      } catch {
        return; // frame not decodable yet
      }
      const frame = ctx.getImageData(0, 0, GRID_W, GRID_H).data;

      const prev = prevRef.current;
      const prevTs = prevTsRef.current;
      // Copy before any early return, so the next tick always has a reference.
      const luma = new Uint8ClampedArray(GRID_W * GRID_H);
      for (let i = 0, p = 0; i < frame.length; i += 4, p++) {
        // Green channel as a luma proxy — one read instead of three, and green
        // carries most of the perceptual luminance anyway.
        luma[p] = frame[i + 1];
      }
      prevRef.current = luma;
      prevTsRef.current = now;

      if (!prev || prevTs <= 0) return;
      const dtSec = Math.max((now - prevTs) / 1000, 1e-3);
      // A long gap (tab hidden, tracker restart) makes the difference meaningless.
      if (dtSec > 1.5) return;

      // Band split: rows covered by the face vs. rows below it.
      const box = faceBoxRef.current;
      const headTop = box ? box.y : DEFAULT_HEAD_BAND.top;
      const headBottom = box ? box.y + box.height : DEFAULT_HEAD_BAND.bottom;
      const headRow0 = Math.max(0, Math.floor(headTop * GRID_H));
      const headRow1 = Math.min(GRID_H, Math.ceil(headBottom * GRID_H));

      let sumAll = 0, sumHead = 0, sumLower = 0, sumImgL = 0, sumImgR = 0;
      let nAll = 0, nHead = 0, nLower = 0, nImgL = 0, nImgR = 0;
      const halfCol = GRID_W / 2;

      for (let row = 0; row < GRID_H; row++) {
        for (let col = 0; col < GRID_W; col++) {
          const idx = row * GRID_W + col;
          const d = Math.abs(luma[idx] - prev[idx]);
          const v = d > NOISE_FLOOR ? d : 0;
          sumAll += v; nAll++;
          if (row >= headRow0 && row < headRow1) { sumHead += v; nHead++; }
          else if (row >= headRow1) { sumLower += v; nLower++; }
          if (col < halfCol) { sumImgL += v; nImgL++; } else { sumImgR += v; nImgR++; }
        }
      }

      // Per-second, and normalized to 0..1-ish by the 255 luma range so the
      // numbers are comparable with the landmark channels' scale-normalized
      // speeds rather than being in raw byte units.
      const rate = (sum: number, n: number) => (n ? sum / n / 255 / dtSec : 0);

      sampleRef.current = {
        overall: rate(sumAll, nAll),
        head: rate(sumHead, nHead),
        lower: rate(sumLower, nLower),
        // Un-mirror: image-left is the STUDENT's right.
        left: rate(sumImgR, nImgR),
        right: rate(sumImgL, nImgL),
      };
    };

    const id = setInterval(tick, Math.max(33, intervalMs));
    return () => {
      clearInterval(id);
      prevRef.current = null;
      prevTsRef.current = 0;
    };
  }, [videoEl, enabled, intervalMs]);

  const getSample = useRef(() => sampleRef.current).current;
  return { getSample };
}

export default useMotionField;
