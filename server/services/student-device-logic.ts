// Pure decision logic for AAC device registration. Kept free of DB/repository
// imports so it can be unit-tested directly (see server/tests/student-devices.test.ts).

import type { LicensePermissions } from "@shared/license-permissions";

/** Sentinel meaning "no device cap". */
export const UNLIMITED_DEVICES = -1;

/**
 * A student's effective device limit is the SUM of maxDevicesPerStudent across
 * the licenses of every institute they actively belong to. Any unlimited (-1)
 * license makes the total unlimited; negative garbage other than -1 counts as 0.
 * A student with no active institutes gets 0 — which is what enforces the
 * "removed from institute" case on the next startup recheck.
 */
export function sumDeviceLimits(
  permsList: Pick<LicensePermissions, "maxDevicesPerStudent">[],
): number {
  let total = 0;
  for (const perms of permsList) {
    // Missing field = license predates the feature = unlimited (the default).
    const limit = perms.maxDevicesPerStudent ?? UNLIMITED_DEVICES;
    if (limit === UNLIMITED_DEVICES) return UNLIMITED_DEVICES;
    total += Math.max(0, Math.floor(limit) || 0);
  }
  return total;
}

export interface DeviceRegistrationVerdict {
  /** May this device use the AAC for this student right now? */
  allowed: boolean;
  /** Was this device already holding a registration slot? */
  isRegistered: boolean;
}

/**
 * Decide whether a device may register / keep using a student.
 *
 * An already-registered device is only allowed while the WHOLE registered set
 * still fits the limit — if the limit shrank (student left an institute), even
 * registered devices are blocked until enough slots are freed.
 */
export function evaluateDeviceRegistration(opts: {
  limit: number;
  registeredDeviceIds: string[];
  deviceId: string;
}): DeviceRegistrationVerdict {
  const isRegistered = opts.registeredDeviceIds.includes(opts.deviceId);
  if (opts.limit === UNLIMITED_DEVICES) return { allowed: true, isRegistered };
  if (isRegistered) {
    return { allowed: opts.registeredDeviceIds.length <= opts.limit, isRegistered: true };
  }
  return { allowed: opts.registeredDeviceIds.length < opts.limit, isRegistered: false };
}
