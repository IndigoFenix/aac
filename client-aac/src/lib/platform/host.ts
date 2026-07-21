// client-aac/src/lib/platform/host.ts
//
// The memoized host resolution. Lives apart from index.ts so sibling modules
// (update.ts, bridge.ts) can depend on it without importing the barrel — a
// barrel import here would form a cycle, and ESM would hand one of them a
// half-initialized module depending on which side loaded first.
//
// Detection is memoized because the native bridges are injected before the
// bundle boots and never appear or vanish mid-session.

import { capabilitiesFor, detectHost, type HostGlobals } from "./detect";
import type { NativeHost, PlatformCapabilities } from "./types";

let cached: PlatformCapabilities | null = null;

function readGlobals(): HostGlobals | null {
  if (typeof window === "undefined") return null;
  return window as unknown as HostGlobals;
}

/** Capabilities of the host this bundle is running inside. */
export function capabilities(): PlatformCapabilities {
  if (!cached) cached = capabilitiesFor(detectHost(readGlobals()));
  return cached;
}

/** Host name. For logging and diagnostics — branch on `capabilities()`. */
export function getHost(): NativeHost {
  return capabilities().host;
}

/**
 * Force a host for tests. Pass null to restore real detection.
 * Not for production code — there is no legitimate reason to lie about the host.
 */
export function __setHostForTests(host: NativeHost | null): void {
  cached = host ? capabilitiesFor(host) : null;
}
