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
   * Host can record a session to the device: capture its own window without a
   * per-session picker, and stream multi-gigabyte files to a real filesystem.
   *
   * Electron only. WKWebView has no `getDisplayMedia` at all, so the iPad shell
   * could record the camera but never the screen — half the feature, and the
   * half that carries the privacy weight. A browser tab has neither a picker-free
   * capture nor durable storage: OPFS is quota-capped and evictable, which is
   * the opposite of what "keep this footage" means.
   */
  sessionRecording: boolean;

  /**
   * Host may reach eye-tracker companion software over `ws://localhost`.
   * Native shells can (Electron via `allowRunningInsecureContent`; iOS via an
   * ATS exception + local-network permission), so they get a longer probe
   * timeout before declaring "no tracker". A browser tab on https:// has the
   * connection killed by mixed-content rules and should fail fast.
   */
  localhostBridge: boolean;

  /**
   * Host can register itself to start when the device does, so a dedicated AAC
   * machine reaches the board without a caretaker driving a desktop first.
   *
   * Electron only, and there it means the OS login item — which fires at user
   * SIGN-IN, not at power-on; an unattended device also needs its Windows
   * account set to sign in automatically, which is provisioning, not app code.
   * iPadOS has no equivalent at any privilege level (an always-on iPad is
   * Guided Access or MDM single-app mode, set on the device), and a browser tab
   * plainly has none.
   *
   * Like selfUpdate, this states what the host CAN do; the bridge being present
   * and `supported` coming back true is the runtime truth — a dev (unpackaged)
   * Electron run reports false.
   */
  launchOnBoot: boolean;
}
