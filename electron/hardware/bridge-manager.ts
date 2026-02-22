import { GazepointBridge } from "./gazepoint-bridge";

interface DeviceStatus {
  detected: boolean;
  active: boolean;
  error?: string;
}

export interface HardwareStatus {
  gazepoint: DeviceStatus;
  // Phase 2: tobii, eyetech, lctech
}

export class HardwareBridgeManager {
  private gazepointBridge: GazepointBridge | null = null;
  private status: HardwareStatus = {
    gazepoint: { detected: false, active: false },
  };

  async start(): Promise<void> {
    // Probe for Gazepoint Control (TCP 4242)
    const gazepointDetected = await this.probeGazepoint();
    this.status.gazepoint.detected = gazepointDetected;

    if (gazepointDetected) {
      try {
        this.gazepointBridge = new GazepointBridge();
        await this.gazepointBridge.start();
        this.status.gazepoint.active = true;
        console.log("[HardwareBridge] Gazepoint bridge started on ws://localhost:4243");
      } catch (e) {
        this.status.gazepoint.error = String(e);
        console.error("[HardwareBridge] Failed to start Gazepoint bridge:", e);
      }
    } else {
      console.log("[HardwareBridge] Gazepoint Control not detected on port 4242");
    }

    // Phase 2: Probe for Tobii DLL, etc.
  }

  stop(): void {
    if (this.gazepointBridge) {
      this.gazepointBridge.stop();
      this.gazepointBridge = null;
      this.status.gazepoint.active = false;
    }
  }

  getStatus(): HardwareStatus {
    return { ...this.status };
  }

  private probeGazepoint(): Promise<boolean> {
    return new Promise((resolve) => {
      // Dynamic import to avoid requiring 'net' at module level in non-Node environments
      import("net").then(({ createConnection }) => {
        const socket = createConnection({ host: "127.0.0.1", port: 4242 }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.setTimeout(500);
        socket.on("timeout", () => {
          socket.destroy();
          resolve(false);
        });
        socket.on("error", () => {
          socket.destroy();
          resolve(false);
        });
      });
    });
  }
}
