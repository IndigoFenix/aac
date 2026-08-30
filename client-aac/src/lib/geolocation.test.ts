// getCurrentGps must ALWAYS settle. A hang here strands the whole AAC session:
// useLiveSession awaits it after the socket opens but before sending
// `initialize`, so a never-settling promise leaves the server holding a silent
// connection and the app stuck on "connecting". That is a real iPadOS failure —
// with no location usage-description key in Info.plist, WKWebView invokes
// NEITHER the success nor the error callback.

// Native ESM: jest's globals are NOT injected, so every name used here has to
// be imported. Without this the whole `getCurrentGps` block died on
// `ReferenceError: jest is not defined` — i.e. the watchdog these tests exist
// to protect was not actually being exercised.
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { getCurrentGps, mayReadDeviceLocation, metersBetween } from "./geolocation";

type PositionCallback = (pos: unknown) => void;
type ErrorCallback = () => void;

function withGeolocation(
  impl: ((success: PositionCallback, error: ErrorCallback, opts: unknown) => void) | null,
) {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const previous = nav.geolocation;
  if (impl === null) {
    delete nav.geolocation;
  } else {
    nav.geolocation = { getCurrentPosition: impl };
  }
  return () => {
    if (previous === undefined) delete nav.geolocation;
    else nav.geolocation = previous;
  };
}

describe("getCurrentGps", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves a reading when the platform reports a position", async () => {
    const restore = withGeolocation((success) =>
      success({ coords: { latitude: 32.08, longitude: 34.78, accuracy: 12 } }),
    );
    try {
      await expect(getCurrentGps()).resolves.toEqual({
        latitude: 32.08,
        longitude: 34.78,
        accuracy: 12,
      });
    } finally {
      restore();
    }
  });

  it("resolves null when the platform reports an error (permission denied)", async () => {
    const restore = withGeolocation((_success, error) => error());
    try {
      await expect(getCurrentGps()).resolves.toBeNull();
    } finally {
      restore();
    }
  });

  it("resolves null when geolocation is unavailable entirely", async () => {
    const restore = withGeolocation(null);
    try {
      await expect(getCurrentGps()).resolves.toBeNull();
    } finally {
      restore();
    }
  });

  it("resolves null when getCurrentPosition throws synchronously", async () => {
    const restore = withGeolocation(() => {
      throw new Error("blocked");
    });
    try {
      await expect(getCurrentGps()).resolves.toBeNull();
    } finally {
      restore();
    }
  });

  it("settles even when NEITHER callback ever fires (the iPadOS hang)", async () => {
    // The regression this file exists for: a platform that silently swallows
    // the request. Without our own watchdog this promise never settles.
    const restore = withGeolocation(() => {
      /* never calls back — exactly what iPadOS does with no Info.plist key */
    });
    try {
      const pending = getCurrentGps(8000);
      jest.advanceTimersByTime(10_001);
      await expect(pending).resolves.toBeNull();
    } finally {
      restore();
    }
  });

  it("does not leave the watchdog pending after a normal resolve", async () => {
    const restore = withGeolocation((success) =>
      success({ coords: { latitude: 1, longitude: 2, accuracy: 3 } }),
    );
    try {
      await getCurrentGps(8000);
      // A leaked watchdog would keep a timer alive for every reading taken by
      // the periodic GPS watch.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      restore();
    }
  });

  it("omits accuracy when the platform does not report a number", async () => {
    const restore = withGeolocation((success) =>
      success({ coords: { latitude: 1, longitude: 2, accuracy: null } }),
    );
    try {
      await expect(getCurrentGps()).resolves.toEqual({ latitude: 1, longitude: 2 });
    } finally {
      restore();
    }
  });
});

describe("metersBetween", () => {
  it("is zero for identical readings", () => {
    const a = { latitude: 32.08, longitude: 34.78 };
    expect(metersBetween(a, a)).toBeCloseTo(0, 6);
  });

  it("approximates a known short distance", () => {
    // ~0.001° of latitude ≈ 111 m anywhere on the globe.
    const a = { latitude: 32.0, longitude: 34.78 };
    const b = { latitude: 32.001, longitude: 34.78 };
    expect(metersBetween(a, b)).toBeGreaterThan(100);
    expect(metersBetween(a, b)).toBeLessThan(120);
  });
});

// The gate in front of every reading. It is ONE function on purpose: the same
// two conditions used to be re-typed at each call site, and the venue lanes
// duly ended up without the Capacitor half — a "find nearby" press that could
// hang forever on an iPad. See docs/IPAD_BUILD.md.
describe("mayReadDeviceLocation", () => {
  it("is off unless the student's setting is explicitly on", () => {
    expect(mayReadDeviceLocation({ enabled: false, host: "web" })).toBe(false);
    expect(mayReadDeviceLocation({ enabled: false, host: "electron" })).toBe(false);
    // Default-off is the whole point: a child's whereabouts is a clinician
    // decision, so anything but a true must read as "do not ask".
    expect(mayReadDeviceLocation({ enabled: undefined as any, host: "web" })).toBe(false);
    expect(mayReadDeviceLocation({ enabled: "yes" as any, host: "web" })).toBe(false);
  });

  it("allows a reading on the hosts that can actually produce one", () => {
    expect(mayReadDeviceLocation({ enabled: true, host: "web" })).toBe(true);
    expect(mayReadDeviceLocation({ enabled: true, host: "electron" })).toBe(true);
  });

  it("refuses on the Capacitor host even when the setting is on", () => {
    // No NSLocationWhenInUseUsageDescription in the iPad shell: a reading can
    // never succeed, and iPadOS fires neither callback. Flip this test only
    // together with adding the plist key in scripts/ios-configure.mjs.
    expect(mayReadDeviceLocation({ enabled: true, host: "capacitor" })).toBe(false);
  });
});
