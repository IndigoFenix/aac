// client-aac/src/lib/platform/index.ts
//
// Barrel for host detection. Read capabilities from here; never sniff
// `window.electronAPI` (or `window.Capacitor`) at a call site.
//
//   import { capabilities } from "@/lib/platform";
//   if (capabilities().gazeSidecar) { ... }
//
// The implementation lives in host.ts / detect.ts / bridge.ts / update.ts —
// sibling modules import those directly to avoid cycling through this barrel.

export { capabilities, getHost, __setHostForTests } from "./host";
export { capabilitiesFor, detectHost } from "./detect";
export type { HostGlobals } from "./detect";
export type { NativeHost, PlatformCapabilities } from "./types";
export { getUpdateProvider } from "./update";
export type { UpdateProvider, UpdateStatus } from "@shared/native-update.js";
export {
  getBrowserBridge,
  getElectronBridge,
  getGazeBridge,
  getInstancesBridge,
  getNativeVersion,
} from "./bridge";
export type { GazeBridge, GazeSidecarStatus, InstancesBridge } from "./bridge";
export type { AppInstance, AppInstanceReport } from "@shared/app-instances.js";
