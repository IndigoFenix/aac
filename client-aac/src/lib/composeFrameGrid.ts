/**
 * composeFrameGrid.ts
 *
 * Selects the most "important" frames from a buffer and composites them
 * into a single NxN grid image for AI analysis. Includes timestamp overlays
 * and L/R direction labels (same as prepareFrameForAI).
 */

import type { BufferedFrame } from "./frameRingBuffer";

export interface FrameGridConfig {
  gridCols: number;
  gridRows: number;
  /** Width of each sub-frame in pixels */
  subFrameWidth: number;
  /** Height of each sub-frame in pixels */
  subFrameHeight: number;
}

export const DEFAULT_GRID_CONFIG: FrameGridConfig = {
  gridCols: 4,
  gridRows: 4,
  subFrameWidth: 160,
  subFrameHeight: 120,
};

export interface ComposedGrid {
  /** Final composite JPEG blob */
  blob: Blob;
  /** Timestamp of each frame in reading order (ms since epoch) */
  timestamps: number[];
  /** Number of frames placed in the grid */
  frameCount: number;
}

/**
 * Select the most important frames from a candidate set.
 * Uses a greedy algorithm balancing temporal spread and visual diversity.
 */
function selectKeyFrames(frames: BufferedFrame[], maxCount: number): BufferedFrame[] {
  if (frames.length <= maxCount) return [...frames];

  const selected: BufferedFrame[] = [];
  const used = new Set<number>();

  // Always include first and last frame
  selected.push(frames[0]);
  used.add(0);
  selected.push(frames[frames.length - 1]);
  used.add(frames.length - 1);

  const totalTimeSpan = frames[frames.length - 1].timestamp - frames[0].timestamp || 1;

  // Greedily pick frames with highest combined score
  while (selected.length < maxCount) {
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < frames.length; i++) {
      if (used.has(i)) continue;

      const candidate = frames[i];

      // Temporal spread: how far is this from the nearest selected frame in time?
      let minTimeDist = Infinity;
      for (const s of selected) {
        const dist = Math.abs(candidate.timestamp - s.timestamp) / totalTimeSpan;
        if (dist < minTimeDist) minTimeDist = dist;
      }

      // Visual diversity: use motionLevel as a proxy for "interesting-ness"
      // Frames with higher motion are more visually distinct
      const motionBoost = candidate.motionLevel * 0.3;

      // Combined score
      const score = minTimeDist + motionBoost;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break;
    selected.push(frames[bestIdx]);
    used.add(bestIdx);
  }

  // Sort selected frames chronologically
  selected.sort((a, b) => a.timestamp - b.timestamp);
  return selected;
}

/**
 * Compose selected frames into a single grid image.
 * Frames are arranged left-to-right, top-to-bottom with timestamp overlays.
 * The final image is flipped horizontally with L/R labels (matching prepareFrameForAI).
 */
export async function composeFrameGrid(
  frames: BufferedFrame[],
  config?: Partial<FrameGridConfig>
): Promise<ComposedGrid> {
  const cfg = { ...DEFAULT_GRID_CONFIG, ...config };
  const maxFrames = cfg.gridCols * cfg.gridRows;
  const totalWidth = cfg.gridCols * cfg.subFrameWidth;
  const totalHeight = cfg.gridRows * cfg.subFrameHeight;

  // Select key frames
  const selected = selectKeyFrames(frames, maxFrames);
  if (selected.length === 0) {
    // Return a blank 1x1 image
    const canvas = new OffscreenCanvas(1, 1);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
    return { blob, timestamps: [], frameCount: 0 };
  }

  const firstTimestamp = selected[0].timestamp;
  const canvas = new OffscreenCanvas(totalWidth, totalHeight);
  const ctx = canvas.getContext("2d")!;

  // Black background for any unfilled cells
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, totalWidth, totalHeight);

  const timestamps: number[] = [];

  // Draw each sub-frame
  for (let i = 0; i < selected.length; i++) {
    const frame = selected[i];
    const col = i % cfg.gridCols;
    const row = Math.floor(i / cfg.gridCols);
    const x = col * cfg.subFrameWidth;
    const y = row * cfg.subFrameHeight;

    try {
      const bitmap = await createImageBitmap(frame.blob);

      // Draw flipped horizontally (cameras produce mirrored images)
      ctx.save();
      ctx.translate(x + cfg.subFrameWidth, y);
      ctx.scale(-1, 1);
      ctx.drawImage(bitmap, 0, 0, cfg.subFrameWidth, cfg.subFrameHeight);
      ctx.restore();
      bitmap.close();
    } catch {
      // Draw red X for failed frames
      ctx.fillStyle = "#300";
      ctx.fillRect(x, y, cfg.subFrameWidth, cfg.subFrameHeight);
    }

    // Timestamp overlay (relative to first frame)
    const relativeMs = frame.timestamp - firstTimestamp;
    const relativeSec = (relativeMs / 1000).toFixed(1);
    const label = `+${relativeSec}s`;

    const fontSize = Math.max(9, Math.round(cfg.subFrameHeight * 0.1));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = "top";

    const textWidth = ctx.measureText(label).width;
    const padding = 2;

    // Background pill (top-left of sub-frame)
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(x + 1, y + 1, textWidth + padding * 2, fontSize + padding * 2);

    // White text
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x + 1 + padding, y + 1 + padding);

    timestamps.push(frame.timestamp);
  }

  // Draw L/R direction labels on the full composite
  const labelFontSize = Math.max(12, Math.round(totalHeight * 0.04));
  ctx.font = `bold ${labelFontSize}px sans-serif`;
  ctx.textBaseline = "top";
  const labelPad = Math.round(labelFontSize * 0.4);
  const labelMargin = 6;

  for (const { letter, lx } of [
    { letter: "L", lx: labelMargin },
    { letter: "R", lx: totalWidth - labelMargin - ctx.measureText("R").width - labelPad * 2 },
  ] as const) {
    const tw = ctx.measureText(letter).width;
    const pillW = tw + labelPad * 2;
    const pillH = labelFontSize + labelPad * 2;

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.roundRect(lx, labelMargin, pillW, pillH, 4);
    ctx.fill();

    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.lineWidth = 2;
    ctx.strokeText(letter, lx + labelPad, labelMargin + labelPad);
    ctx.fillStyle = "#fff";
    ctx.fillText(letter, lx + labelPad, labelMargin + labelPad);
  }

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
  return { blob, timestamps, frameCount: selected.length };
}
