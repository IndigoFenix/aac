// Per-installation device identity for AAC device registration.
// The id is generated once and identifies this browser profile / native
// install, not the hardware.
//
// localStorage is the CACHE, not the record. It churns: WKWebView evicts it
// under storage pressure on iPad, and a browser-profile reset wipes it on a
// shared Windows machine — and every loss registers the same physical device
// AGAIN, eating another of the student's device slots. So where the host can
// hold the id outside web storage (an Electron file in userData, Capacitor
// Preferences — see lib/platform/bridge.ts), that copy is authoritative and
// localStorage is backfilled from it.

import { apiRequest } from "@/lib/queryClient";
import { getDeviceIdStore, getHost } from "@/lib/platform";

const DEVICE_ID_KEY = "aac_device_id";

/** The resolved id, shared by the sync and async accessors once either has run. */
let cachedId: string | null = null;
/** Memoizes the durable-store round trip so concurrent callers resolve once. */
let ensurePromise: Promise<string> | null = null;

function generateId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Synchronous accessor for the render path (the "this device" chip in
 * DeviceManager) — it cannot await the native store, so it reads localStorage
 * as before. Once ensureDeviceId() has resolved, `cachedId` guarantees it
 * returns the SAME id that was registered, not a stale localStorage value.
 */
export function getDeviceId(): string {
  if (cachedId) return cachedId;
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  cachedId = id;
  return id;
}

/**
 * Reconciles the two copies of the id, and says which need writing back.
 * Pure — the precedence rules are the whole point of this module, and they are
 * testable here without a DOM or a native host (see device-id.test.ts).
 *
 * The durable copy always wins: it is the one that survives the localStorage
 * loss this mechanism exists for, so a local id that disagrees is a churned id
 * to be overwritten, not a rival identity. A local-only id is the pre-upgrade
 * case — keep it (the server already knows that id) and seed the durable copy
 * from it. With neither, this genuinely is a new install.
 */
export function chooseDeviceId(
  durable: string | null,
  local: string | null,
  generate: () => string,
): { id: string; writeLocal: boolean; writeDurable: boolean } {
  if (durable) return { id: durable, writeLocal: local !== durable, writeDurable: false };
  if (local) return { id: local, writeLocal: false, writeDurable: true };
  return { id: generate(), writeLocal: true, writeDurable: true };
}

/**
 * The id to register with. Consults the durable host store, backfills whichever
 * copy is missing or stale, and memoizes the whole resolution so the parallel
 * callers (the registration hook, deregistration) share one round trip and can
 * never disagree about who this device is.
 *
 * Degrades to the plain localStorage behaviour on ANY failure: registration —
 * and therefore the student's access to this device — waits on this, so
 * identity resolution must never throw and never block on a wedged native call.
 */
export async function ensureDeviceId(): Promise<string> {
  if (!ensurePromise) ensurePromise = resolveDeviceId();
  return ensurePromise;
}

async function resolveDeviceId(): Promise<string> {
  try {
    const store = getDeviceIdStore();
    const durable = store ? await store.get() : null;
    const local = localStorage.getItem(DEVICE_ID_KEY);
    const choice = chooseDeviceId(durable, local, generateId);
    if (choice.writeLocal) localStorage.setItem(DEVICE_ID_KEY, choice.id);
    // store.set() already swallows its own failures; the surrounding catch is
    // for the store itself being unavailable.
    if (choice.writeDurable && store) await store.set(choice.id);
    cachedId = choice.id;
    return choice.id;
  } catch {
    return getDeviceId();
  }
}

/** Human-readable label shown in the device lists ("iPad (App)" etc.). */
export function getDeviceName(): string {
  const ua = navigator.userAgent;
  const platform =
    /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /iPhone/.test(ua)
        ? "iPhone"
        : /Android/.test(ua)
          ? "Android"
          : /Windows/.test(ua)
            ? "Windows"
            : /Macintosh/.test(ua)
              ? "Mac"
              : /Linux/.test(ua)
                ? "Linux"
                : "Device";
  // App-vs-Browser comes from the platform layer, not the UA: only Electron
  // stamps "Electron" into its user agent, so sniffing for it labelled every
  // Capacitor iPad install "(Browser)" — it reports a plain Safari/Mac UA.
  return getHost() === "web" ? `${platform} (Browser)` : `${platform} (App)`;
}

/**
 * Best-effort self de-registration, called on logout / student switch.
 * Never throws — if it fails (offline), the server-side startup recheck
 * is what eventually reconciles the slot count.
 */
export async function deregisterCurrentDevice(studentId: string): Promise<void> {
  try {
    await apiRequest("POST", `/api/students/${studentId}/devices/deregister`, {
      // Must be the id that was REGISTERED, so this waits on the durable
      // resolution rather than reading a possibly-stale localStorage value.
      deviceId: await ensureDeviceId(),
    });
  } catch {
    // Swallow: logout must proceed even when the server is unreachable.
  }
}
