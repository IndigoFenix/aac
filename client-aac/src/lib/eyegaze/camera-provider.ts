// client-aac/src/lib/eyegaze/camera-provider.ts
// Wraps the existing gazeEstimator to produce a unified GazeData stream from camera face tracking.

import type { RawTrackedFace } from "../faceTrackingTypes";
import { createGazeEstimator, type CalibrationSample } from "../gazeEstimator";
import type { EyeGazeProvider, EyeGazeProviderStatus, GazeCallback, GazeData, GazePoint } from "./types";

const POLL_MS = 50; // 20Hz

export class CameraGazeProvider implements EyeGazeProvider {
  readonly type = "camera" as const;
  readonly needsCalibration = true;

  private estimator = createGazeEstimator();
  private callbacks = new Set<GazeCallback>();
  private faces: RawTrackedFace[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private error: string | null = null;

  /** Feed face tracking data from external source (useEyeGaze passes rawFaces here) */
  setFaces(faces: RawTrackedFace[]) {
    this.faces = faces;
  }

  async probe(): Promise<boolean> {
    try {
      return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.connected = true;
    this.error = null;

    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      if (this.faces.length === 0) return;
      const face = this.faces[0];

      const point = this.estimator.update(face);
      if (!point) return;

      const data = this.buildGazeData(point, face);
      for (const cb of this.callbacks) cb(data);
    }, POLL_MS);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.connected = false;
  }

  destroy() {
    this.stop();
    this.callbacks.clear();
    this.faces = [];
  }

  onGaze(cb: GazeCallback) { this.callbacks.add(cb); }
  offGaze(cb: GazeCallback) { this.callbacks.delete(cb); }

  getStatus(): EyeGazeProviderStatus {
    return {
      type: this.type,
      connected: this.connected,
      error: this.error,
      supportsCalibration: true,
      deviceName: "Webcam",
    };
  }

  // ── Calibration pass-through ──

  getRawGaze(): GazePoint | null {
    if (this.faces.length === 0) return null;
    return this.estimator.getRaw(this.faces[0]);
  }

  applyCalibration(samples: CalibrationSample[]) {
    this.estimator.applyCalibration(samples);
  }

  clearCalibration() {
    this.estimator.clearCalibration();
  }

  isCalibrated(): boolean {
    return this.estimator.isCalibrated();
  }

  resetSmoothing() {
    this.estimator.reset();
  }

  // ── Private ──

  private buildGazeData(point: GazePoint, face: RawTrackedFace): GazeData {
    const bs = face.blendshapes;
    const blinkLeft = (bs.get("eyeBlinkLeft") ?? 0) > 0.5;
    const blinkRight = (bs.get("eyeBlinkRight") ?? 0) > 0.5;

    return {
      point,
      confidence: face.noseTip ? 0.7 : 0,
      timestamp: performance.now(),
      blink: { left: blinkLeft, right: blinkRight },
      headPose: face.headPose
        ? { yaw: face.headPose.yaw, pitch: face.headPose.pitch }
        : undefined,
    };
  }
}
