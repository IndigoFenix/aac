/**
 * Geologic-history scrubber — timescales.md §5b pointed BACKWARD.
 *
 * The tectonic provider records keyframes of a history that actually
 * happened (tectonics.ts `runTectonics`); this module makes them
 * scrubbable: a position ∈ [0,1] across the whole history picks a target
 * (linear blend of the two straddling keyframes), and the SHOWN terrain
 * eases toward it with the same `easeToward` primitive everything else
 * uses — drag the slider and the continents morph through their drift
 * instead of snapping frame to frame. Retargeting mid-morph is free, as
 * always: yank the slider and the view bends from wherever it visibly is.
 *
 * Pure presentation: the live world is untouched at any position — scrub
 * back to "now" (pos 1) and the ordinary substrate view resumes.
 */

import { easeToward, frameDt } from "./transients";
import { SEA_HEIGHT, type TectonicFrame } from "./tectonics";

export interface GeoScrubber {
  /** Position across the recorded history: 0 = oldest keyframe, 1 = now. */
  setPos(p: number): void;
  pos(): number;
  /** The (fractional) epoch at the current position, for captions. */
  epoch(): number;
  /** Ease the shown terrain toward the position's target and rasterize. */
  paint(img: ImageData, ts: number): void;
  /** Eased shown height at one cell — for tests. */
  height(cell: number): number;
}

const MORPH_TAU = 0.2; // s — snappy, but visibly a morph
const SEA_SHALLOW = [99, 178, 220], SEA_DEEP = [17, 64, 122];
const LAND_LOW = [120, 100, 70], LAND_HIGH = [235, 225, 205];
const ORE_LO = [150, 130, 160], ORE_HI = [90, 60, 120];

export function createGeoScrubber(frames: TectonicFrame[], cols: number, rows: number): GeoScrubber {
  const n = cols * rows;
  const lastFrame = frames[frames.length - 1];
  const shownH = Float32Array.from(lastFrame.height);
  const shownO = Float32Array.from(lastFrame.ore);
  let p = 1;
  let lastTs = -1;

  /** The keyframe pair straddling the position, and the blend between. */
  const seg = (): { a: TectonicFrame; b: TectonicFrame; t: number } => {
    if (frames.length < 2) return { a: frames[0], b: frames[0], t: 0 };
    const f = Math.max(0, Math.min(1, p)) * (frames.length - 1);
    const i = Math.min(frames.length - 2, Math.floor(f));
    return { a: frames[i], b: frames[i + 1], t: Math.min(1, f - i) };
  };

  const update = (ts: number): void => {
    const dt = frameDt(lastTs, ts);
    lastTs = ts;
    if (dt <= 0) return;
    const { a, b, t } = seg();
    for (let c = 0; c < n; c++) {
      shownH[c] = easeToward(shownH[c], a.height[c] + (b.height[c] - a.height[c]) * t, dt, MORPH_TAU, MORPH_TAU, 0.05);
      shownO[c] = easeToward(shownO[c], a.ore[c] + (b.ore[c] - a.ore[c]) * t, dt, MORPH_TAU, MORPH_TAU, 0.05);
    }
  };

  const lerp3 = (a: number[], b: number[], t: number): number[] => {
    const k = Math.max(0, Math.min(1, t));
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  };

  return {
    setPos(v) { p = Math.max(0, Math.min(1, v)); },
    pos: () => p,
    epoch() {
      const { a, b, t } = seg();
      return a.epoch + (b.epoch - a.epoch) * t;
    },
    height: cell => shownH[cell],
    paint(img, ts) {
      update(ts);
      const { a, b, t } = seg();
      const plates = t < 0.5 ? a.plate : b.plate; // ownership is discrete
      const R = 4;
      const area = (2 * R + 1) * (2 * R + 1);
      const hAt = (x: number, y: number): number =>
        shownH[Math.max(0, Math.min(rows - 1, y)) * cols + Math.max(0, Math.min(cols - 1, x))];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const h = shownH[i];
          let c: number[];
          if (h < SEA_HEIGHT) {
            c = lerp3(SEA_SHALLOW, SEA_DEEP, (SEA_HEIGHT - h) / 3);
          } else {
            c = lerp3(LAND_LOW, LAND_HIGH, h / 63);
            if (shownO[i] > 0.5) c = lerp3(ORE_LO, ORE_HI, shownO[i] / 15);
          }
          // Prominence shading (the substrate renderer's depth cue).
          let sum = 0;
          for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) sum += hAt(x + ox, y + oy);
          let factor = 1 + (h - sum / area) * 0.05 + (h - 16) * 0.012;
          factor = Math.max(0.5, Math.min(1.5, factor));
          // Plate boundaries: darken seams so the drift reads as PLATES.
          if (x + 1 < cols && plates[i] !== plates[i + 1]) factor *= 0.72;
          else if (y + 1 < rows && plates[i] !== plates[i + cols]) factor *= 0.72;
          const o = i * 4;
          img.data[o] = Math.max(0, Math.min(255, c[0] * factor));
          img.data[o + 1] = Math.max(0, Math.min(255, c[1] * factor));
          img.data[o + 2] = Math.max(0, Math.min(255, c[2] * factor));
          img.data[o + 3] = 255;
        }
      }
    },
  };
}
