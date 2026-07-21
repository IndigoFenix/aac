// client-aac/src/lib/platform/types.ts
//
// Shared vocabulary for "which native shell is this bundle running inside".
//
// The AAC client ships in three hosts from ONE Vite bundle:
//   electron  — the packaged Windows desktop app (electron/preload.ts exposes
//               `window.electronAPI`; full Node/Chromium behind an IPC bridge)
//   capacitor — the packaged iPad app (WKWebView; native access via Capacitor
//               plugins, no Node, no child processes, no <webview> tag)
//   web       — a plain browser tab (aivota.ai/aac)
//
// Feature code must branch on a CAPABILITY, never on the host name. "Is this
// Electron?" is the wrong question — the right one is "can this host spawn a
// gaze sidecar?". Otherwise every new host means re-auditing every call site.

export type NativeHost = "electron" | "capacitor" | "web";

export interface PlatformCapabilities {
  /** Which shell we're in. For logging / diagnostics — do NOT branch on this. */
  host: NativeHost;

  /**
   * Host can spawn the DLL-based eye-tracker sidecar (Tobii, EyeTech, LC).
   * Requires spawning a bitness-matched native process — Electron/Windows only.
   * iPadOS forbids child processes outright, so gaze hardware is unreachable
   * there; the mouse/touch provider is the fallback.
   */
  gazeSidecar: boolean;

  /**
   * Host offers an embedded browser the eyegaze overlay can DRIVE (inject JS,
   * synthesize scroll/click/type). Electron's `<webview>` tag qualifies.
   * WKWebView has no equivalent — an iframe can be shown but never driven
   * cross-origin, and `SFSafariViewController` is fully opaque to us.
   */
  drivableWebview: boolean;

  /**
   * Host exposes its real installed app version at runtime, as opposed to the
   * `__APP_VERSION__` constant baked in at build time. Matters once OTA bundle
   * updates land: the running bundle's version can outpace the binary's.
   */
  nativeVersion: boolean;

  /**
   * Host manages its own updates (Electron: NSIS installer via
   * electron-updater. Capacitor: OTA web-bundle swap). A plain browser tab
   * updates by reloading, so there is nothing to surface.
   *
   * NOTE: this states what the host CAN do, not whether a provider is wired.
   * `getUpdateProvider()` returning null is the runtime truth — see update.ts.
   */
  selfUpdate: boolean;

  /**
   * Host may reach eye-tracker companion software over `ws://localhost`.
   * Native shells can (Electron via `allowRunningInsecureContent`; iOS via an
   * ATS exception + local-network permission), so they get a longer probe
   * timeout before declaring "no tracker". A browser tab on https:// has the
   * connection killed by mixed-content rules and should fail fast.
   */
  localhostBridge: boolean;
}
