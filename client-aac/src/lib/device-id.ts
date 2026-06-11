// Per-installation device identity for AAC device registration.
// The id is generated once and persisted in localStorage — it identifies this
// browser profile / Electron install, not the hardware.

import { apiRequest } from "@/lib/queryClient";

const DEVICE_ID_KEY = "aac_device_id";

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
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
  return /Electron/i.test(ua) ? `${platform} (App)` : `${platform} (Browser)`;
}

/**
 * Best-effort self de-registration, called on logout / student switch.
 * Never throws — if it fails (offline), the server-side startup recheck
 * is what eventually reconciles the slot count.
 */
export async function deregisterCurrentDevice(studentId: string): Promise<void> {
  try {
    await apiRequest("POST", `/api/students/${studentId}/devices/deregister`, {
      deviceId: getDeviceId(),
    });
  } catch {
    // Swallow: logout must proceed even when the server is unreachable.
  }
}
