// client-aac/src/lib/platform/detect.test.ts
//
// Guards the host detection + capability matrix. These run in jest's `node`
// environment (no jsdom) because detect.ts is pure — globals are passed in.

import {
  capabilitiesFor,
  detectHost,
  isSingleCameraCaptureOS,
  type HostGlobals,
} from "./detect";
import type { NativeHost } from "./types";

describe("detectHost", () => {
  it("returns web when there are no globals at all (SSR / prerender)", () => {
    expect(detectHost(null)).toBe("web");
    expect(detectHost(undefined)).toBe("web");
    expect(detectHost({})).toBe("web");
  });

  it("detects Electron from the preload bridge", () => {
    expect(detectHost({ electronAPI: { isElectron: true } })).toBe("electron");
  });

  it("ignores an electronAPI that does not assert isElectron", () => {
    // Defensive: a page-script-injected `electronAPI` must not grant the app
    // Electron capabilities. The real preload always sets isElectron: true.
    expect(detectHost({ electronAPI: {} })).toBe("web");
  });

  it("detects Capacitor via isNativePlatform()", () => {
    const globals: HostGlobals = {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" },
    };
    expect(detectHost(globals)).toBe("capacitor");
  });

  it("treats the Capacitor web shim as a plain browser", () => {
    // The same bundle served to a browser still has window.Capacitor, but it
    // reports platform "web". That must NOT count as a native host.
    const globals: HostGlobals = {
      Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
    };
    expect(detectHost(globals)).toBe("web");
  });

  it("falls back to getPlatform() when isNativePlatform() is absent", () => {
    expect(detectHost({ Capacitor: { getPlatform: () => "ios" } })).toBe("capacitor");
    expect(detectHost({ Capacitor: { getPlatform: () => "web" } })).toBe("web");
  });

  it("prefers Electron when both bridges somehow appear", () => {
    const globals: HostGlobals = {
      electronAPI: { isElectron: true },
      Capacitor: { isNativePlatform: () => true },
    };
    expect(detectHost(globals)).toBe("electron");
  });
});

describe("capabilitiesFor", () => {
  const hosts: NativeHost[] = ["electron", "capacitor", "web"];

  it("reports its own host back", () => {
    for (const host of hosts) {
      expect(capabilitiesFor(host).host).toBe(host);
    }
  });

  it("grants the gaze sidecar only to Electron", () => {
    // iPadOS forbids child processes, so vendor eye-tracker DLLs are
    // unreachable there — touch is the input path.
    expect(capabilitiesFor("electron").gazeSidecar).toBe(true);
    expect(capabilitiesFor("capacitor").gazeSidecar).toBe(false);
    expect(capabilitiesFor("web").gazeSidecar).toBe(false);
  });

  it("grants a drivable webview only to Electron", () => {
    // WKWebView has no <webview> tag; the iframe fallback renders on iPad.
    expect(capabilitiesFor("electron").drivableWebview).toBe(true);
    expect(capabilitiesFor("capacitor").drivableWebview).toBe(false);
    expect(capabilitiesFor("web").drivableWebview).toBe(false);
  });

  it("gives both native hosts self-update and a runtime version", () => {
    for (const host of ["electron", "capacitor"] as const) {
      expect(capabilitiesFor(host).selfUpdate).toBe(true);
      expect(capabilitiesFor(host).nativeVersion).toBe(true);
    }
  });

  it("gives the web build no native affordances", () => {
    const web = capabilitiesFor("web");
    expect(web).toEqual({
      host: "web",
      gazeSidecar: false,
      drivableWebview: false,
      nativeVersion: false,
      selfUpdate: false,
      localhostBridge: false,
    });
  });

  it("returns a fresh object each call so callers cannot mutate the matrix", () => {
    const first = capabilitiesFor("electron");
    first.gazeSidecar = false;
    expect(capabilitiesFor("electron").gazeSidecar).toBe(true);
  });
});

describe("isSingleCameraCaptureOS", () => {
  it("flags explicit iOS device UAs regardless of touch points", () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
    expect(isSingleCameraCaptureOS(iphone, 0)).toBe(true);
    expect(isSingleCameraCaptureOS(iphone, 5)).toBe(true);
  });

  it("flags iPadOS's desktop-class UA via the Mac-with-touchscreen combination", () => {
    // What the Capacitor WKWebView on iPad actually reports (from the debug log).
    const ipadDesktopUa =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    expect(isSingleCameraCaptureOS(ipadDesktopUa, 5)).toBe(true);
  });

  it("does not flag a real Mac (no touchscreen)", () => {
    const macUa =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    expect(isSingleCameraCaptureOS(macUa, 0)).toBe(false);
  });

  it("does not flag Windows or Android", () => {
    const windowsUa =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0";
    const androidUa =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0";
    expect(isSingleCameraCaptureOS(windowsUa, 10)).toBe(false);
    expect(isSingleCameraCaptureOS(androidUa, 5)).toBe(false);
  });
});
