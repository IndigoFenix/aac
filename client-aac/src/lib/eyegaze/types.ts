// client-aac/src/lib/eyegaze/types.ts
// Common interfaces for the unified eyegaze service.

export interface GazePoint {
  x: number;
  y: number;
}

export interface GazeData {
  point: GazePoint;
  confidence: number;                  // 0-1
  timestamp: number;                   // performance.now()
  blink?: { left: boolean; right: boolean };
  fixation?: { active: boolean; durationMs: number };
  pupils?: { leftDiameter?: number; rightDiameter?: number };
  headPose?: { yaw: number; pitch: number; roll?: number };
}

export type EyeGazeProviderType = "camera" | "tobii" | "eyetech" | "lctech" | "gazepoint" | "webhid" | "mouse";

export interface EyeGazeProviderStatus {
  type: EyeGazeProviderType;
  connected: boolean;
  error: string | null;
  supportsCalibration: boolean;
  deviceName?: string;
}

export type GazeCallback = (data: GazeData) => void;

export interface EyeGazeProvider {
  readonly type: EyeGazeProviderType;
  readonly needsCalibration: boolean;
  probe(): Promise<boolean>;
  start(): Promise<void>;
  stop(): void;
  destroy(): void;
  onGaze(cb: GazeCallback): void;
  offGaze(cb: GazeCallback): void;
  getStatus(): EyeGazeProviderStatus;
}
