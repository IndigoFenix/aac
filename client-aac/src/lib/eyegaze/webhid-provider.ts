// client-aac/src/lib/eyegaze/webhid-provider.ts
// WebHID browser API provider — direct browser access to HID eye trackers (Chrome only).
// This is a placeholder implementation; actual HID report parsing requires device-specific documentation.

// WebHID API types (not in standard TS lib; Chrome-only API)
declare global {
  interface HIDDevice {
    vendorId: number;
    productName: string;
    opened: boolean;
    open(): Promise<void>;
    close(): Promise<void>;
    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
  }
  interface HIDInputReportEvent {
    data: DataView;
    device: HIDDevice;
    reportId: number;
  }
}

import type { EyeGazeProvider, EyeGazeProviderStatus, GazeCallback, GazeData } from "./types";

// Known eye tracker USB vendor IDs
const KNOWN_VENDOR_IDS = [
  0x2104, // Tobii
];

export class WebHIDGazeProvider implements EyeGazeProvider {
  readonly type = "webhid" as const;
  readonly needsCalibration = false;

  private callbacks = new Set<GazeCallback>();
  private device: HIDDevice | null = null;
  private connected = false;
  private error: string | null = null;

  async probe(): Promise<boolean> {
    if (!("hid" in navigator)) return false;

    try {
      // Check for already-granted devices with known vendor IDs
      const devices = await (navigator as any).hid.getDevices();
      return devices.some((d: HIDDevice) =>
        KNOWN_VENDOR_IDS.includes(d.vendorId),
      );
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (!("hid" in navigator)) {
      this.error = "WebHID not supported in this browser";
      return;
    }

    try {
      // Check already-granted devices first
      const granted = await (navigator as any).hid.getDevices();
      let device = granted.find((d: HIDDevice) =>
        KNOWN_VENDOR_IDS.includes(d.vendorId),
      );

      if (!device) {
        // Request device (requires user gesture)
        const selected = await (navigator as any).hid.requestDevice({
          filters: KNOWN_VENDOR_IDS.map((vendorId) => ({ vendorId })),
        });
        device = selected[0];
      }

      if (!device) {
        this.error = "No device selected";
        return;
      }

      if (!device.opened) {
        await device.open();
      }

      this.device = device;
      this.connected = true;
      this.error = null;

      device.addEventListener("inputreport", this.handleReport);
    } catch (e) {
      this.error = String(e);
      this.connected = false;
    }
  }

  stop() {
    if (this.device) {
      this.device.removeEventListener("inputreport", this.handleReport);
      this.device.close().catch(() => {});
      this.device = null;
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
      error: this.error,
      supportsCalibration: false,
      deviceName: this.device?.productName ?? "WebHID Eye Tracker",
    };
  }

  private handleReport = (event: HIDInputReportEvent) => {
    // Parse HID input report — this is device-specific and needs real device docs.
    // Placeholder: read first 4 bytes as two uint16 normalized coords.
    try {
      const view = event.data;
      if (view.byteLength < 4) return;

      const rawX = view.getUint16(0, true);
      const rawY = view.getUint16(2, true);

      // Normalize 0-65535 → screen pixels
      const data: GazeData = {
        point: {
          x: (rawX / 65535) * window.innerWidth,
          y: (rawY / 65535) * window.innerHeight,
        },
        confidence: 0.6,
        timestamp: performance.now(),
      };

      for (const cb of this.callbacks) cb(data);
    } catch {
      // Skip unparseable reports
    }
  };
}
