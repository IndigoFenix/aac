// client-aac/src/lib/platform/bridge.ts
//
// The ONLY place in client-aac that reads `window.electronAPI`.
//
// Everything the Electron preload exposes (electron/preload.ts) is typed and
// accessed here, so a second native host can be added by giving each accessor
// a Capacitor branch — instead of hunting `(window as any).electronAPI` across
// components. Every accessor returns null when the bridge is absent; callers
// must handle that, because it is the normal case on web and iPad.

import type { UpdateStatus } from "@shared/native-update.js";
import type { AppInstanceReport } from "@shared/app-instances.js";
import { getHost } from "./host";

/** Gaze sidecar control. Electron/Windows only — see capabilities.gazeSidecar. */
export interface GazeSidecarStatus {
  device: string | null;
  dllPath: string | null;
  dllArch: "ia32" | "x64" | "arm64" | "unknown" | null;
  dllFound: boolean;
  running: boolean;
  /** Live localhost port the sidecar serves gaze on (OS-assigned). Null until it binds. */
  port: number | null;
  sidecarCode: string | null;
  sidecarMessage: string | null;
  needsDll: boolean;
  lastError: string | null;
}

export interface GazeBridge {
  ensure: (device: string) => Promise<GazeSidecarStatus | null>;
  status: () => Promise<GazeSidecarStatus | null>;
  stop: () => Promise<GazeSidecarStatus | null>;
  locateDll: (device: string) => Promise<GazeSidecarStatus | null>;
  setDll: (device: string, dllPath: string) => Promise<GazeSidecarStatus | null>;
  clearDll: (device: string) => Promise<GazeSidecarStatus | null>;
  openLog: () => Promise<{ logPath: string; opened: boolean; error: string | null }>;
}

/** In-app browser navigation allowlist, enforced in the Electron main process. */
export interface BrowserBridge {
  setAllowlist?: (list: unknown) => void;
  clearAllowlist?: () => void;
}

export interface UpdateBridge {
  getStatus: () => Promise<UpdateStatus>;
  check: () => Promise<void>;
  installNow: () => Promise<boolean>;
  onStatus: (cb: (status: UpdateStatus) => void) => () => void;
}

/**
 * "How many copies of me are running?" — Electron/Windows only.
 *
 * A second copy is not cosmetic: both instances spawn a gaze sidecar, and the
 * vendor eye-tracker DLL admits one consumer, so the tracker silently belongs to
 * whichever copy won. The client shows this so a caretaker closes the extra copy
 * instead of chasing a phantom hardware fault.
 */
export interface InstancesBridge {
  get: (refresh?: boolean) => Promise<AppInstanceReport | null>;
  onReport: (cb: (report: AppInstanceReport) => void) => () => void;
}

export interface ElectronBridge {
  isElectron?: boolean;
  getVersion?: () => Promise<string>;
  getPlatform?: () => string;
  browser?: BrowserBridge;
  gaze?: GazeBridge;
  update?: UpdateBridge;
  instances?: InstancesBridge;
}

export function getElectronBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { electronAPI?: ElectronBridge }).electronAPI ?? null;
}

export function getGazeBridge(): GazeBridge | null {
  return getElectronBridge()?.gaze ?? null;
}

export function getBrowserBridge(): BrowserBridge | null {
  return getElectronBridge()?.browser ?? null;
}

export function getInstancesBridge(): InstancesBridge | null {
  return getElectronBridge()?.instances ?? null;
}

/**
 * The running app's version as reported by the native shell, or null when
 * there is no shell to ask (web build falls back to the build-time constant).
 *
 * The Capacitor branch imports `@capacitor/app` DYNAMICALLY and only on the
 * host that can use it: a static import would pull the plugin into the
 * Electron and web bundles too, where it is dead weight.
 */
export async function getNativeVersion(): Promise<string | null> {
  const getVersion = getElectronBridge()?.getVersion;
  if (getVersion) {
    try {
      return await getVersion();
    } catch {
      return null;
    }
  }

  if (getHost() === "capacitor") {
    try {
      const { App } = await import("@capacitor/app");
      const info = await App.getInfo();
      return info.version || null;
    } catch {
      // Plugin missing from the native project, or getInfo() unavailable.
      // The build-time constant is a fine fallback.
      return null;
    }
  }

  return null;
}
