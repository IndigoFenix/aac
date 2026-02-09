/**
 * frameRingBuffer.ts
 *
 * Fixed-capacity circular buffer for camera frames with metadata.
 * Stores recent frames for activity-driven detection pipeline.
 */

export interface BufferedFrame {
  blob: Blob;
  timestamp: number;
  motionLevel: number;
  /** Low-res pixel data for similarity comparison between frames */
  imageData?: ImageData;
}

export interface FrameRingBufferConfig {
  /** Maximum frames to store (default: 64 = ~16s at 4fps) */
  maxFrames: number;
  /** Capture interval in ms (default: 250 = 4fps) */
  captureIntervalMs: number;
}

export const DEFAULT_FRAME_BUFFER_CONFIG: FrameRingBufferConfig = {
  maxFrames: 64,
  captureIntervalMs: 250,
};

export class FrameRingBuffer {
  private frames: (BufferedFrame | null)[];
  private head = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(capacity = DEFAULT_FRAME_BUFFER_CONFIG.maxFrames) {
    this.capacity = capacity;
    this.frames = new Array(capacity).fill(null);
  }

  push(frame: BufferedFrame): void {
    this.frames[this.head] = frame;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Get the most recent N frames in chronological order */
  getRecent(count: number): BufferedFrame[] {
    const n = Math.min(count, this.count);
    const result: BufferedFrame[] = [];
    // Start from oldest of the N requested
    let idx = (this.head - n + this.capacity) % this.capacity;
    for (let i = 0; i < n; i++) {
      const frame = this.frames[idx];
      if (frame) result.push(frame);
      idx = (idx + 1) % this.capacity;
    }
    return result;
  }

  /** Get all frames captured since the given timestamp, chronological order */
  getSince(timestamp: number): BufferedFrame[] {
    const all = this.getRecent(this.count);
    return all.filter(f => f.timestamp >= timestamp);
  }

  clear(): void {
    this.frames = new Array(this.capacity).fill(null);
    this.head = 0;
    this.count = 0;
  }

  get length(): number {
    return this.count;
  }
}
