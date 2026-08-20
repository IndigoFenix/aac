// client-aac/src/lib/platform/detect.ts
//
// Pure host detection + the capability matrix. No `window` access, no imports
// from the app — everything is passed in, so this is directly unit-testable
// (see detect.test.ts). `index.ts` is the thin layer that reads the real
// globals and memoizes the result.

import type { NativeHost, PlatformCapabilities } from "./types";

/** The subset of globals that identify a native shell. */
export interface HostGlobals {
  /** Injected by electron/preload.ts via contextBridge. */
  electronAPI?: { isElectron?: boolean };
  /** Injected by Capacitor's native bridge before the bundle boots. */
  Capacitor?: {
    isNativePlatform?: () => boolean;
    getPlatform?: () => string;
  };
}

/**
 * Identify the host from the globals present on `window`.
 *
 * Electron is checked first: it is the only host whose bridge is a preload
 * script, so if `electronAPI.isElectron` is set nothing else can be true.
 */
export function detectHost(globals: HostGlobals | null | undefined): NativeHost {
  if (!globals) return "web";

  if (globals.electronAPI?.isElectron === true) return "electron";

  const cap = globals.Capacitor;
  if (cap) {
    // The Capacitor JS shim is also present when the same bundle is served to
    // a plain browser, where it reports platform "web". That is NOT a native
    // host — only "ios"/"android" are. `isNativePlatform()` encodes exactly
    // this test; `getPlatform()` is the fallback for older cores that predate
    // it.
    if (typeof cap.isNativePlatform === "function") {
      if (cap.isNativePlatform() === true) return "capacitor";
    } else if (typeof cap.getPlatform === "function") {
      const platform = cap.getPlatform();
      if (platform === "ios" || platform === "android") return "capacitor";
    }
  }

  return "web";
}

/**
 * What each host can do. Adding a host means adding one row here and fixing
 * the resulting type error — not grepping for `isElectron`.
 */
const CAPABILITY_MATRIX: Record<NativeHost, Omit<PlatformCapabilities, "host">> = {
  electron: {
    gazeSidecar: true,
    drivableWebview: true,
    nativeVersion: true,
    selfUpdate: true,
    sessionRecording: true,
    localhostBridge: true,
  },
  capacitor: {
    // No child processes on iPadOS — vendor eye-tracker DLLs are unreachable.
    // Touch is the input path for v1; ARKit face tracking would be a native
    // plugin feeding the existing dwell engine, not a sidecar.
    gazeSidecar: false,
    // WKWebView has no <webview> tag. The iframe fallback in BrowserApp is
    // what renders here, with the same cross-origin limits as the web build.
    drivableWebview: false,
    nativeVersion: true,
    selfUpdate: true,
    // No getDisplayMedia in WKWebView — the screen half of a recording is
    // simply unreachable, and a camera-only clip is not what this feature is.
    sessionRecording: false,
    localhostBridge: true,
  },
  web: {
    gazeSidecar: false,
    drivableWebview: false,
    nativeVersion: false,
    selfUpdate: false,
    // Capture needs a user-gesture picker every session and OPFS storage is
    // quota-capped and evictable by the browser.
    sessionRecording: false,
    localhostBridge: false,
  },
};

export function capabilitiesFor(host: NativeHost): PlatformCapabilities {
  return { host, ...CAPABILITY_MATRIX[host] };
}

/**
 * iOS / iPadOS WebKit allows only ONE active camera capture per page.
 * Acquiring a second camera silently ends the first one's track, so
 * multi-camera mode must be disabled there (both in the Capacitor shell and
 * in Safari). This is an OS trait, not a host trait — iPadOS Safari reports
 * host "web" — hence a UA check rather than a CAPABILITY_MATRIX row.
 *
 * iPadOS ships a desktop-class UA ("Macintosh; Intel Mac OS X"), so the
 * Mac-with-touchscreen combination is the documented way to tell an iPad
 * from a real Mac.
 */
export function isSingleCameraCaptureOS(
  userAgent: string,
  maxTouchPoints: number,
): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return userAgent.includes("Macintosh") && maxTouchPoints > 1;
}
