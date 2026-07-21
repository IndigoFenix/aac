// shared/native-update.ts
//
// The host-agnostic update lifecycle, shared by BOTH sides of the bridge:
//   - electron/auto-update.ts EMITS these over IPC (electron-updater)
//   - client-aac/src/lib/platform/update.ts CONSUMES them
//   - the Capacitor OTA provider will emit the same union on iPad
//
// It lives in shared/ rather than being declared twice because the two copies
// previously drifted by comment only — but a real drift (a renamed `kind`)
// would fail silently at runtime, since IPC payloads are untyped on the wire.
// One definition makes that a compile error instead.
//
// Both native update mechanisms — replacing an NSIS installer on Windows,
// swapping a web bundle on iPadOS — reduce to the same six states, so UI code
// never branches on host.

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "not-available"; version: string }
  | { kind: "downloading"; percent: number; bytesPerSecond: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

/**
 * What a host must implement to participate in update UI.
 *
 * `installNow` means "apply the downloaded update": on Electron that quits and
 * runs the installer; on Capacitor it reloads the WKWebView onto the new
 * bundle. Both are a restart from the student's point of view, so the
 * "restart to apply" wording holds for either.
 */
export interface UpdateProvider {
  getStatus: () => Promise<UpdateStatus>;
  check: () => Promise<void>;
  installNow: () => Promise<boolean>;
  onStatus: (cb: (status: UpdateStatus) => void) => () => void;
}
