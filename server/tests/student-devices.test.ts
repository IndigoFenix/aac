/**
 * AAC device registration logic.
 *
 * A student's effective device limit is the SUM of maxDevicesPerStudent across
 * the licenses of all institutes they actively belong to (-1 anywhere makes it
 * unlimited). The AAC client re-runs registration on every startup, so when the
 * limit shrinks (student removed from an institute) even already-registered
 * devices must be blocked until enough slots are freed.
 *
 * Pure logic lives in services/student-device-logic.ts precisely so these
 * tests need no DB or repository mocks.
 */

import { describe, it, expect } from "@jest/globals";
import {
  UNLIMITED_DEVICES,
  DEVICE_REGISTRATION_TTL_DAYS,
  sumDeviceLimits,
  evaluateDeviceRegistration,
  deviceExpiryCutoff,
} from "../services/student-device-logic";

const perms = (n: number) => ({ maxDevicesPerStudent: n });

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

describe("sumDeviceLimits", () => {
  it("returns 0 for a student with no active institutes (removed-from-institute case)", () => {
    expect(sumDeviceLimits([])).toBe(0);
  });

  it("sums the limits of multiple institutes", () => {
    expect(sumDeviceLimits([perms(2), perms(3)])).toBe(5);
  });

  it("treats any unlimited license as an unlimited total", () => {
    expect(sumDeviceLimits([perms(2), perms(UNLIMITED_DEVICES)])).toBe(UNLIMITED_DEVICES);
    expect(sumDeviceLimits([perms(UNLIMITED_DEVICES)])).toBe(UNLIMITED_DEVICES);
  });

  it("a zero-device license contributes nothing", () => {
    expect(sumDeviceLimits([perms(0), perms(1)])).toBe(1);
  });

  it("clamps malformed negative values (other than -1) to 0", () => {
    expect(sumDeviceLimits([perms(-5), perms(2)])).toBe(2);
  });

  it("treats a license predating the field as unlimited (back-compat default)", () => {
    expect(sumDeviceLimits([{}, perms(2)])).toBe(UNLIMITED_DEVICES);
  });
});

describe("evaluateDeviceRegistration", () => {
  it("always allows under an unlimited limit", () => {
    const verdict = evaluateDeviceRegistration({
      limit: UNLIMITED_DEVICES,
      registeredDeviceIds: ["a", "b", "c"],
      deviceId: "d",
    });
    expect(verdict).toEqual({ allowed: true, isRegistered: false });
  });

  it("allows a new device while slots are free", () => {
    const verdict = evaluateDeviceRegistration({
      limit: 2,
      registeredDeviceIds: ["a"],
      deviceId: "b",
    });
    expect(verdict).toEqual({ allowed: true, isRegistered: false });
  });

  it("blocks a new device when every slot is taken", () => {
    const verdict = evaluateDeviceRegistration({
      limit: 2,
      registeredDeviceIds: ["a", "b"],
      deviceId: "c",
    });
    expect(verdict).toEqual({ allowed: false, isRegistered: false });
  });

  it("allows an already-registered device when the set fits the limit", () => {
    const verdict = evaluateDeviceRegistration({
      limit: 2,
      registeredDeviceIds: ["a", "b"],
      deviceId: "b",
    });
    expect(verdict).toEqual({ allowed: true, isRegistered: true });
  });

  it("blocks even a registered device once the limit shrank below the registered set", () => {
    // Student was in two institutes (limit 4, 4 devices registered), then left
    // one (limit 2). The startup recheck must block until 2 slots are freed.
    const verdict = evaluateDeviceRegistration({
      limit: 2,
      registeredDeviceIds: ["a", "b", "c", "d"],
      deviceId: "a",
    });
    expect(verdict).toEqual({ allowed: false, isRegistered: true });
  });

  it("re-allows the registered device after enough others were deregistered", () => {
    const verdict = evaluateDeviceRegistration({
      limit: 2,
      registeredDeviceIds: ["a", "b"],
      deviceId: "a",
    });
    expect(verdict).toEqual({ allowed: true, isRegistered: true });
  });

  it("blocks everything at limit 0 (no license grants devices)", () => {
    expect(
      evaluateDeviceRegistration({ limit: 0, registeredDeviceIds: [], deviceId: "a" }),
    ).toEqual({ allowed: false, isRegistered: false });
    // Even a leftover registration from a revoked license is blocked.
    expect(
      evaluateDeviceRegistration({ limit: 0, registeredDeviceIds: ["a"], deviceId: "a" }),
    ).toEqual({ allowed: false, isRegistered: true });
  });
});

describe("deviceExpiryCutoff", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("defaults to the TTL policy (30 days) before now", () => {
    expect(DEVICE_REGISTRATION_TTL_DAYS).toBe(30);
    expect(deviceExpiryCutoff(now).toISOString()).toBe("2026-05-16T12:00:00.000Z");
    expect(deviceExpiryCutoff(now).getTime()).toBe(daysBefore(now, 30).getTime());
  });

  it("puts a 31-day-old registration before the cutoff but not a 29-day-old one", () => {
    // Documents the strict `<` the repository applies: older than the cutoff
    // expires, anything at or after it keeps its slot.
    const cutoff = deviceExpiryCutoff(now);
    expect(daysBefore(now, 31) < cutoff).toBe(true);
    expect(daysBefore(now, 29) < cutoff).toBe(false);
    // Exactly at the cutoff is NOT expired.
    expect(daysBefore(now, 30) < cutoff).toBe(false);
  });

  it("shifts the cutoff when ttlDays is overridden", () => {
    expect(deviceExpiryCutoff(now, 7).getTime()).toBe(daysBefore(now, 7).getTime());
    expect(daysBefore(now, 10) < deviceExpiryCutoff(now, 7)).toBe(true);
    expect(daysBefore(now, 10) < deviceExpiryCutoff(now, 14)).toBe(false);
  });
});
