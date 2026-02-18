// client-aac/src/lib/eyegaze/websocket-bridge-provider.ts
// Generic WebSocket bridge for hardware eye trackers (Tobii, EyeTech, LC Technologies).
// Connects to local companion software that exposes gaze data over a WebSocket server.

import type { EyeGazeProvider, EyeGazeProviderType, EyeGazeProviderStatus, GazeCallback, GazeData } from "./types";

/** Vendor-specific parser: converts raw JSON from the companion app to GazeData */
export type VendorParser = (raw: unknown) => GazeData | null;

export interface WebSocketBridgeConfig {
  type: EyeGazeProviderType;
  deviceName: string;
  url: string;
  probeUrl?: string;     // HTTP endpoint to check if companion is running
  parser: VendorParser;
  reconnectMs?: number;
}

export class WebSocketBridgeProvider implements EyeGazeProvider {
  readonly type: EyeGazeProviderType;
  readonly needsCalibration = false; // hardware trackers have their own calibration

  private config: WebSocketBridgeConfig;
  private callbacks = new Set<GazeCallback>();
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private error: string | null = null;
  private destroyed = false;

  constructor(config: WebSocketBridgeConfig) {
    this.config = config;
    this.type = config.type;
  }

  async probe(): Promise<boolean> {
    // Try HTTP probe first (faster, non-destructive)
    if (this.config.probeUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 500);
        const res = await fetch(this.config.probeUrl, { signal: controller.signal });
        clearTimeout(timeout);
        return res.ok;
      } catch {
        return false;
      }
    }

    // Fall back to brief WebSocket connect test
    return new Promise<boolean>((resolve) => {
      try {
        const ws = new WebSocket(this.config.url);
        const timer = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 500);

        ws.onopen = () => {
          clearTimeout(timer);
          ws.close();
          resolve(true);
        };

        ws.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
      } catch {
        resolve(false);
      }
    });
  }

  async start(): Promise<void> {
    this.destroyed = false;
    this.connect();
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect on intentional close
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    this.callbacks.clear();
  }

  onGaze(cb: GazeCallback) { this.callbacks.add(cb); }
  offGaze(cb: GazeCallback) { this.callbacks.delete(cb); }

  getStatus(): EyeGazeProviderStatus {
    return {
      type: this.type,
      connected: this.connected,
      error: this.error,
      supportsCalibration: false,
      deviceName: this.config.deviceName,
    };
  }

  // ── Private ──

  private connect() {
    if (this.destroyed) return;

    try {
      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => {
        this.connected = true;
        this.error = null;
      };

      this.ws.onmessage = (ev) => {
        try {
          const raw = JSON.parse(ev.data as string);
          const data = this.config.parser(raw);
          if (data) {
            for (const cb of this.callbacks) cb(data);
          }
        } catch {
          // skip unparseable messages
        }
      };

      this.ws.onerror = () => {
        this.error = `Connection error to ${this.config.deviceName}`;
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.scheduleReconnect();
      };
    } catch (e) {
      this.error = String(e);
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    const delay = this.config.reconnectMs ?? 3000;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

// ─── Vendor Parsers ─────────────────────────────────────────────

/** Tobii Stream Engine / Tobii Pro SDK companion — normalized 0-1 coords */
function parseTobii(raw: unknown): GazeData | null {
  const r = raw as Record<string, unknown>;
  const gp = r.gazePoint as Record<string, number> | undefined;
  if (!gp || typeof gp.x !== "number" || typeof gp.y !== "number") return null;

  return {
    point: {
      x: gp.x * window.innerWidth,
      y: gp.y * window.innerHeight,
    },
    confidence: typeof r.validity === "number" ? r.validity as number : 0.9,
    timestamp: performance.now(),
    blink: typeof r.leftEyeClosed === "boolean"
      ? { left: r.leftEyeClosed as boolean, right: (r.rightEyeClosed ?? r.leftEyeClosed) as boolean }
      : undefined,
    pupils: typeof r.leftPupilDiameter === "number"
      ? { leftDiameter: r.leftPupilDiameter as number, rightDiameter: r.rightPupilDiameter as number | undefined }
      : undefined,
  };
}

/** EyeTech TM5 / VT4 — screen pixel coords */
function parseEyeTech(raw: unknown): GazeData | null {
  const r = raw as Record<string, unknown>;
  const x = r.screenX ?? r.x;
  const y = r.screenY ?? r.y;
  if (typeof x !== "number" || typeof y !== "number") return null;

  return {
    point: { x, y },
    confidence: typeof r.quality === "number" ? (r.quality as number) / 100 : 0.8,
    timestamp: performance.now(),
  };
}

/** LC Technologies Eyegaze Edge — screen pixel coords */
function parseLCTech(raw: unknown): GazeData | null {
  const r = raw as Record<string, unknown>;
  const gazeX = r.gazeX ?? r.x;
  const gazeY = r.gazeY ?? r.y;
  if (typeof gazeX !== "number" || typeof gazeY !== "number") return null;

  return {
    point: { x: gazeX, y: gazeY },
    confidence: typeof r.trackingQuality === "number" ? (r.trackingQuality as number) : 0.8,
    timestamp: performance.now(),
    fixation: typeof r.fixation === "boolean"
      ? { active: r.fixation as boolean, durationMs: (r.fixationDuration as number) ?? 0 }
      : undefined,
  };
}

// ─── Factory Functions ──────────────────────────────────────────

export function createTobiiProvider(port = 49152): WebSocketBridgeProvider {
  return new WebSocketBridgeProvider({
    type: "tobii",
    deviceName: "Tobii Eye Tracker",
    url: `ws://localhost:${port}`,
    probeUrl: `http://localhost:${port}/status`,
    parser: parseTobii,
  });
}

export function createEyeTechProvider(port = 8086): WebSocketBridgeProvider {
  return new WebSocketBridgeProvider({
    type: "eyetech",
    deviceName: "EyeTech Eye Tracker",
    url: `ws://localhost:${port}`,
    parser: parseEyeTech,
  });
}

export function createLCTechProvider(port = 30000): WebSocketBridgeProvider {
  return new WebSocketBridgeProvider({
    type: "lctech",
    deviceName: "LC Technologies Eyegaze",
    url: `ws://localhost:${port}`,
    parser: parseLCTech,
  });
}
