// client-aac/src/lib/eyegaze/websocket-bridge-provider.ts
// Generic WebSocket bridge for hardware eye trackers (Tobii, EyeTech, LC Technologies).
// Connects to local companion software that exposes gaze data over a WebSocket server.

import type { EyeGazeProvider, EyeGazeProviderType, EyeGazeProviderStatus, GazeCallback, GazeData } from "./types";
import { GazeSmoother, type GazeSmootherConfig } from "@shared/gaze-smoothing.js";
import { capabilities, getGazeBridge } from "@/lib/platform";

/** Vendor-specific parser: converts raw JSON from the companion app to GazeData */
export type VendorParser = (raw: unknown) => GazeData | null;

// A sample this weak means "no valid gaze" — don't smooth across the gap, or a
// reacquired eye would drag the cursor from wherever it was lost. Matches the
// MIN_GAZE_CONFIDENCE gate the dwell layer applies downstream (useEyeGaze.ts).
const SMOOTHING_CONFIDENCE_FLOOR = 0.3;

export interface WebSocketBridgeConfig {
  type: EyeGazeProviderType;
  deviceName: string;
  url: string;
  probeUrl?: string;     // HTTP endpoint to check if companion is running
  /**
   * Resolve the live endpoint just before each probe/connect. Used when the
   * companion binds a dynamic (OS-assigned) port — e.g. our gaze sidecar, whose
   * port is discovered from the supervisor. Returns null when no endpoint is
   * available yet (companion not running); the provider then skips connecting.
   * When omitted, `url`/`probeUrl` are used as-is.
   */
  resolveEndpoint?: () => Promise<{ url: string; probeUrl?: string } | null>;
  parser: VendorParser;
  reconnectMs?: number;
  probeTimeoutMs?: number;
  /**
   * Pixel-space smoothing for the raw hardware stream. Hardware trackers send
   * unsmoothed samples, so the cursor trembles; a One-Euro filter + fixation
   * lock removes the jitter without adding lag. Pass a config to enable,
   * `false`/omit to forward samples untouched.
   */
  smoothing?: GazeSmootherConfig | false;
}

// On a native host, local WebSocket servers may take longer to respond
// (mixed-content negotiation in Electron; local-network permission on iOS).
// Use a longer probe timeout there to avoid false negatives. A browser tab on
// https:// has the connection killed outright, so it should fail fast instead.
const DEFAULT_PROBE_TIMEOUT = capabilities().localhostBridge ? 1500 : 500;

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
  private smoother: GazeSmoother | null;
  // Last viewing-geometry value pushed from the app; re-applied whenever the
  // smoother is rebuilt (setSmoothing) so a strength change doesn't drop it.
  private pixelsPerDegree: number | null = null;

  constructor(config: WebSocketBridgeConfig) {
    this.config = config;
    this.type = config.type;
    this.smoother = config.smoothing ? new GazeSmoother(config.smoothing) : null;
  }

  /**
   * Refresh url/probeUrl from resolveEndpoint (if configured). Returns false when
   * no endpoint is available (companion not up yet), so callers can bail out.
   */
  private async refreshEndpoint(): Promise<boolean> {
    if (!this.config.resolveEndpoint) return true;
    try {
      const ep = await this.config.resolveEndpoint();
      if (!ep || !ep.url) return false;
      this.config.url = ep.url;
      this.config.probeUrl = ep.probeUrl;
      return true;
    } catch {
      return false;
    }
  }

  async probe(): Promise<boolean> {
    if (!(await this.refreshEndpoint())) return false;
    const timeout = this.config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT;

    // Try HTTP probe first (faster, non-destructive)
    if (this.config.probeUrl) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const res = await fetch(this.config.probeUrl, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) return true;
      } catch {
        // HTTP probe failed — fall through to WebSocket probe
      }
    }

    // Fall back to brief WebSocket connect test
    return new Promise<boolean>((resolve) => {
      try {
        const ws = new WebSocket(this.config.url);
        const timer = setTimeout(() => {
          ws.close();
          resolve(false);
        }, timeout);

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

  /** Swap the smoothing config live (e.g. clinician changed the strength setting). */
  setSmoothing(config: GazeSmootherConfig | false) {
    this.smoother = config ? new GazeSmoother(config) : null;
    // Rebuilding drops the previous geometry — restore the last known value.
    if (this.smoother && this.pixelsPerDegree != null) {
      this.smoother.setPixelsPerDegree(this.pixelsPerDegree);
    }
  }

  /** Update the pixel↔degree conversion live as the viewing distance changes. */
  setPixelsPerDegree(pixelsPerDegree: number) {
    if (!(pixelsPerDegree > 0)) return;
    this.pixelsPerDegree = pixelsPerDegree;
    this.smoother?.setPixelsPerDegree(pixelsPerDegree);
  }

  /**
   * Smooth the point in pixel space. Invalid/low-confidence samples pass through
   * untouched and reset the filter, so a lost-then-reacquired eye doesn't drag
   * the cursor across the screen from where it was last seen.
   */
  private smooth(data: GazeData): GazeData {
    if (!this.smoother) return data;
    if (data.confidence < SMOOTHING_CONFIDENCE_FLOOR) {
      this.smoother.reset();
      return data;
    }
    const { x, y } = this.smoother.filter(data.point.x, data.point.y, data.timestamp);
    return { ...data, point: { x, y } };
  }

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

  private async connect() {
    if (this.destroyed) return;

    // Resolve the live port before each (re)connect, so a sidecar restart on a
    // new OS-assigned port is picked up automatically.
    if (!(await this.refreshEndpoint())) {
      this.scheduleReconnect();
      return;
    }
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
            const smoothed = this.smooth(data);
            for (const cb of this.callbacks) cb(smoothed);
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
        this.smoother?.reset();
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

/** Gazepoint Open Gaze API bridge — normalized 0-1 coords */
function parseGazepoint(raw: unknown): GazeData | null {
  const r = raw as Record<string, unknown>;
  if (typeof r.x !== "number" || typeof r.y !== "number") return null;

  return {
    point: {
      x: r.x * window.innerWidth,
      y: r.y * window.innerHeight,
    },
    confidence: typeof r.confidence === "number" ? r.confidence : 0.8,
    timestamp: performance.now(),
    pupils: typeof r.leftPupil === "number"
      ? { leftDiameter: r.leftPupil, rightDiameter: r.rightPupil as number | undefined }
      : undefined,
    fixation: typeof r.fixationDuration === "number"
      ? { active: r.fixationDuration > 0, durationMs: r.fixationDuration * 1000 }
      : undefined,
  };
}

// ─── Factory Functions ──────────────────────────────────────────

// Hardware trackers stream raw, unsmoothed samples — enable pixel-space
// smoothing (One-Euro + fixation lock) so the cursor doesn't tremble on target.
// Defaults live in shared/gaze-smoothing.ts; pass {} to accept them.
const HARDWARE_SMOOTHING: GazeSmootherConfig = {};

// The gaze sidecar binds an OS-assigned port (a fixed 49152 collided with other
// eye-gaze software and Windows reserved ranges). Discover the live port from
// the supervisor on each probe/connect, so a sidecar restart on a new port is
// picked up automatically. Returns null when the sidecar isn't up yet.
async function resolveTobiiEndpoint(): Promise<{ url: string; probeUrl: string } | null> {
  try {
    const status = await getGazeBridge()?.status();
    const port = status?.port;
    if (!port) return null;
    // Use 127.0.0.1, NOT "localhost": the sidecar binds the IPv4 loopback, and on
    // Windows "localhost" often resolves to ::1 (IPv6) first, so a localhost
    // connection would never reach it.
    return { url: `ws://127.0.0.1:${port}`, probeUrl: `http://127.0.0.1:${port}/status` };
  } catch {
    return null;
  }
}

export function createTobiiProvider(): WebSocketBridgeProvider {
  return new WebSocketBridgeProvider({
    type: "tobii",
    deviceName: "Tobii Eye Tracker",
    // Placeholder — the real endpoint comes from resolveEndpoint (dynamic port).
    url: "ws://127.0.0.1:0",
    resolveEndpoint: resolveTobiiEndpoint,
    parser: parseTobii,
    smoothing: HARDWARE_SMOOTHING,
  });
}

export function createEyeTechProvider(port = 8086): WebSocketBridgeProvider {
  return new WebSocketBridgeProvider({
    type: "eyetech",
    deviceName: "EyeTech Eye Tracker",
    url: `ws://localhost:${port}`,
    parser: parseEyeTech,
    smoothing: HARDWARE_SMOOTHING,
  });
}

export function createLCTechProvider(port = 30000): WebSocketBridgeProvider {
  return new WebSocketBridgeProvider({
    type: "lctech",
    deviceName: "LC Technologies Eyegaze",
    url: `ws://localhost:${port}`,
    parser: parseLCTech,
    smoothing: HARDWARE_SMOOTHING,
  });
}

export function createGazepointProvider(port = 4243): WebSocketBridgeProvider {
  return new WebSocketBridgeProvider({
    type: "gazepoint",
    deviceName: "Gazepoint Eye Tracker",
    url: `ws://localhost:${port}`,
    parser: parseGazepoint,
    smoothing: HARDWARE_SMOOTHING,
  });
}
