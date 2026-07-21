// client-aac/src/lib/platform/update.ts
//
// Resolves the update provider for the current host. `useAppUpdate` consumes
// only this — it never knows which shell it is running in.
//
//   electron  — electron-updater, bridged through the preload (already live)
//   capacitor — OTA web-bundle swap (Phase 2; see the stub below)
//   web       — none; a browser tab updates by reloading
//
// Returning null is a normal outcome and means "render no update UI".

import { getElectronBridge } from "./bridge";
import { getHost } from "./host";
import type { UpdateProvider } from "@shared/native-update.js";

function electronProvider(): UpdateProvider | null {
  const update = getElectronBridge()?.update;
  if (!update) return null;
  // The preload's shape already matches UpdateProvider exactly — both sides
  // are typed off update-status.ts, so drift is a compile error, not a bug.
  return update;
}

function capacitorProvider(): UpdateProvider | null {
  // Phase 2: wrap @capgo/capacitor-updater here. It exposes download/set/
  // reload plus `download` progress events, which map onto the UpdateStatus
  // union directly:
  //   notifyAppReady()            → { kind: "idle" }
  //   getLatest()                 → { kind: "checking" } → available/not-available
  //   download() progress         → { kind: "downloading", percent }
  //   download() resolved         → { kind: "downloaded", version }
  //   set() + reload()            → installNow()
  // Until then the iPad build shows no update UI, exactly like the web build.
  return null;
}

/**
 * The update provider for this host, or null when updates aren't self-managed.
 * Cheap and side-effect free — safe to call on every render.
 */
export function getUpdateProvider(): UpdateProvider | null {
  switch (getHost()) {
    case "electron":
      return electronProvider();
    case "capacitor":
      return capacitorProvider();
    case "web":
      return null;
  }
}
