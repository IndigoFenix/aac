// client-aac/src/lib/eyegaze/mouse-provider.ts
// Mouse position as a gaze source — used for testing and as ultimate fallback.

import type { EyeGazeProvider, EyeGazeProviderStatus, GazeCallback, GazeData } from "./types";

export class MouseGazeProvider implements EyeGazeProvider {
  readonly type = "mouse" as const;
  readonly needsCalibration = false;

  private callbacks = new Set<GazeCallback>();
  private connected = false;
  private handler: ((e: MouseEvent) => void) | null = null;

  async probe(): Promise<boolean> {
    return true; // always available
  }

  async start(): Promise<void> {
    this.connected = true;

    this.handler = (e: MouseEvent) => {
      const data: GazeData = {
        point: { x: e.clientX, y: e.clientY },
        confidence: 1.0,
        timestamp: performance.now(),
      };
      for (const cb of this.callbacks) cb(data);
    };

    window.addEventListener("mousemove", this.handler, { passive: true });
  }

  stop() {
    if (this.handler) {
      window.removeEventListener("mousemove", this.handler);
      this.handler = null;
    }
    this.connected = false;
  }

  destroy() {
    this.stop();
    this.callbacks.clear();
  }

  onGaze(cb: GazeCallback) { this.callbacks.add(cb); }
  offGaze(cb: GazeCallback) { this.callbacks.delete(cb); }

  getStatus(): EyeGazeProviderStatus {
    return {
      type: this.type,
      connected: this.connected,
      error: null,
      supportsCalibration: false,
      deviceName: "Mouse",
    };
  }
}
