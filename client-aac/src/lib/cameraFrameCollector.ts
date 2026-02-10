/**
 * cameraFrameCollector.ts
 *
 * Standalone (non-React) class for environment camera frame capture with
 * motion detection and sleep/wake behavior. Reuses the same pixel-diff
 * algorithm and thresholds from cameraAttentivenessTypes.ts.
 */

import { MOTION_THRESHOLDS, RESOLUTION_SETTINGS, type CaptureResolution } from "./cameraAttentivenessTypes";

export interface CollectedFrame {
  blob: Blob;
  timestamp: number;
  motionLevel: number;
}

export class CameraFrameCollector {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stream: MediaStream | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private previousImageData: ImageData | null = null;
  private _isAwake = true;
  private _motionLevel = 0;
  private lastMotionTime = 0;
  private destroyed = false;

  constructor() {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.style.display = "none";
    document.body.appendChild(this.video);

    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d")!;
  }

  setStream(stream: MediaStream | null): void {
    if (this.destroyed) return;
    if (this.stream === stream) return;

    this.stream = stream;
    this.video.srcObject = stream;
    this.previousImageData = null;

    if (stream) {
      this.video.play().catch(() => {});
    } else {
      this.video.pause();
      this._isAwake = true;
      this._motionLevel = 0;
    }
  }

  start(intervalMs = 250): void {
    if (this.destroyed) return;
    this.stop();
    this.lastMotionTime = Date.now();
    this.timerId = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private tick(): void {
    if (!this.stream || this.video.readyState < 2) return;

    // Use low resolution for motion detection
    const { width, height } = RESOLUTION_SETTINGS.low;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.drawImage(this.video, 0, 0, width, height);
    const currentData = this.ctx.getImageData(0, 0, width, height);

    if (this.previousImageData) {
      this._motionLevel = this.detectMotion(currentData, this.previousImageData);

      if (this._isAwake) {
        if (this._motionLevel > MOTION_THRESHOLDS.motionThreshold) {
          this.lastMotionTime = Date.now();
        } else if (Date.now() - this.lastMotionTime > MOTION_THRESHOLDS.sleepTimeout) {
          this._isAwake = false;
        }
      } else {
        // Sleeping — check for wake
        if (this._motionLevel >= MOTION_THRESHOLDS.wakeThreshold) {
          this._isAwake = true;
          this.lastMotionTime = Date.now();
        }
      }
    }

    this.previousImageData = currentData;
  }

  private detectMotion(current: ImageData, previous: ImageData): number {
    const cur = current.data;
    const prev = previous.data;
    const pixelCount = cur.length / 4;
    let changed = 0;

    for (let i = 0; i < cur.length; i += 4) {
      const rDiff = Math.abs(cur[i] - prev[i]);
      const gDiff = Math.abs(cur[i + 1] - prev[i + 1]);
      const bDiff = Math.abs(cur[i + 2] - prev[i + 2]);
      if ((rDiff + gDiff + bDiff) / 3 > MOTION_THRESHOLDS.pixelSensitivity) {
        changed++;
      }
    }

    return changed / pixelCount;
  }

  async captureNow(resolution: CaptureResolution = "medium"): Promise<CollectedFrame | null> {
    if (this.destroyed || !this.stream || this.video.readyState < 2) return null;

    const { width, height } = RESOLUTION_SETTINGS[resolution];
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.drawImage(this.video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      this.canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7);
    });

    if (!blob || blob.size === 0) return null;

    return {
      blob,
      timestamp: Date.now(),
      motionLevel: this._motionLevel,
    };
  }

  getIsAwake(): boolean {
    return this._isAwake;
  }

  getMotionLevel(): number {
    return this._motionLevel;
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.video.pause();
    this.video.srcObject = null;
    if (this.video.parentNode) {
      this.video.parentNode.removeChild(this.video);
    }
    this.stream = null;
    this.previousImageData = null;
  }
}
