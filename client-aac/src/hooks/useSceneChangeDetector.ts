// client-aac/src/hooks/useSceneChangeDetector.ts
//
// Cost-saving (Phase 2) helper: detect a large change in the camera frame that
// ISN'T the person or their hands — something held up to the camera, a new
// object, or a scenery change. When the background shifts materially we want to
// escalate the cheap text `scene_state` to a real image frame so the Observer
// (Gemini) can actually SEE and identify what appeared. We don't try to classify
// the object on-device — that's exactly what sending the frame is for.
//
// Method: downscale the video to a tiny grayscale buffer every ~300ms, diff it
// against the previous buffer, but ignore pixels inside the face/hand boxes
// (their motion is expected and already described). The exposed `getChange()`
// returns the fraction of BACKGROUND pixels that changed (0..1).

import { useCallback, useEffect, useRef } from "react";

export interface MaskBox { x: number; y: number; w: number; h: number } // normalized 0..1

export interface UseSceneChangeDetectorOptions {
  videoEl: HTMLVideoElement | null;
  enabled: boolean;
  /** Returns the face/hand boxes to exclude, in normalized image space. Read
   *  fresh on every sample (via a ref) so it never goes stale. */
  getMaskBoxes: () => MaskBox[];
  /** Sample cadence; defaults to 300ms (matches the tracking interval). */
  intervalMs?: number;
  /** Per-pixel grayscale delta (0..255) counted as "changed". */
  pixelDelta?: number;
}

// Tiny sampling grid — enough to notice a hand-held object or scene swap, cheap
// enough to run continuously.
const GRID_W = 48;
const GRID_H = 36;

export function useSceneChangeDetector(opts: UseSceneChangeDetectorOptions): { getChange: () => number } {
  const { videoEl, enabled, intervalMs = 300, pixelDelta = 24 } = opts;
  const changeRef = useRef(0);
  const prevRef = useRef<Uint8ClampedArray | null>(null);
  // Keep the mask getter in a ref so the sampling loop always reads current boxes.
  const getMaskBoxesRef = useRef(opts.getMaskBoxes);
  getMaskBoxesRef.current = opts.getMaskBoxes;

  useEffect(() => {
    if (!enabled || !videoEl) {
      prevRef.current = null;
      changeRef.current = 0;
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = GRID_W;
    canvas.height = GRID_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const inAnyBox = (nx: number, ny: number, boxes: MaskBox[]): boolean => {
      for (const b of boxes) {
        // Pad each box a little — face/hand edges and shadows move too.
        const px = b.w * 0.1, py = b.h * 0.1;
        if (nx >= b.x - px && nx <= b.x + b.w + px && ny >= b.y - py && ny <= b.y + b.h + py) {
          return true;
        }
      }
      return false;
    };

    const sample = () => {
      if (stopped) return;
      try {
        if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
          ctx.drawImage(videoEl, 0, 0, GRID_W, GRID_H);
          const data = ctx.getImageData(0, 0, GRID_W, GRID_H).data;
          const gray = new Uint8ClampedArray(GRID_W * GRID_H);
          for (let i = 0; i < GRID_W * GRID_H; i++) {
            gray[i] = data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11;
          }
          const prev = prevRef.current;
          if (prev) {
            const boxes = getMaskBoxesRef.current();
            let changed = 0;
            let total = 0;
            for (let y = 0; y < GRID_H; y++) {
              const ny = (y + 0.5) / GRID_H;
              for (let x = 0; x < GRID_W; x++) {
                const nx = (x + 0.5) / GRID_W;
                if (inAnyBox(nx, ny, boxes)) continue;
                total++;
                const idx = y * GRID_W + x;
                if (Math.abs(gray[idx] - prev[idx]) > pixelDelta) changed++;
              }
            }
            changeRef.current = total > 0 ? changed / total : 0;
          }
          prevRef.current = gray;
        }
      } catch {
        // drawImage can throw on a not-yet-ready / cross-origin frame — ignore.
      }
      timer = setTimeout(sample, intervalMs);
    };
    timer = setTimeout(sample, intervalMs);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      prevRef.current = null;
      changeRef.current = 0;
    };
  }, [videoEl, enabled, intervalMs, pixelDelta]);

  const getChange = useCallback(() => changeRef.current, []);
  return { getChange };
}

export default useSceneChangeDetector;
