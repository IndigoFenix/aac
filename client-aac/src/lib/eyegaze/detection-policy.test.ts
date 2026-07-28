// client-aac/src/lib/eyegaze/detection-policy.test.ts
//
// The regression these guard is a real field failure: a Tobii Dynavox IS5 whose
// sidecar connected successfully every single time, while the student sat in
// front of a dead cursor. The client had given up after two probes and had no
// way back short of logging out and in. See detection-policy.ts.

import {
  detectionSatisfied,
  hardwareReadiness,
  hardwareSignalKey,
  isFallbackProvider,
  retryDelayMs,
  shouldAttemptSwitch,
  RETRY_MAX_MS,
  type DetectionInputs,
} from "./detection-policy";

/** A student with a Tobii, a live sidecar, and nothing detected yet. */
function inputs(over: Partial<DetectionInputs> = {}): DetectionInputs {
  return {
    enabled: true,
    preferred: "tobii",
    activeProvider: "mouse",
    hardwareReady: true,
    attempts: 0,
    lastAttemptAt: 0,
    now: 0,
    ...over,
  };
}

describe("isFallbackProvider", () => {
  it("treats the mouse and 'nothing active' as not-yet-detected", () => {
    expect(isFallbackProvider("mouse")).toBe(true);
    expect(isFallbackProvider(null)).toBe(true);
  });

  it("treats real trackers as detected", () => {
    expect(isFallbackProvider("tobii")).toBe(false);
    expect(isFallbackProvider("eyetech")).toBe(false);
    expect(isFallbackProvider("camera")).toBe(false);
  });
});

describe("detectionSatisfied", () => {
  it("requires the exact provider when one is named", () => {
    expect(detectionSatisfied("tobii", "tobii")).toBe(true);
    expect(detectionSatisfied("tobii", "mouse")).toBe(false);
    expect(detectionSatisfied("tobii", "camera")).toBe(false);
    expect(detectionSatisfied("tobii", null)).toBe(false);
  });

  it("accepts any real tracker on auto, but never the mouse fallback", () => {
    expect(detectionSatisfied("auto", "tobii")).toBe(true);
    expect(detectionSatisfied("auto", "gazepoint")).toBe(true);
    // The silent failure: "auto" landing on the mouse looks like success.
    expect(detectionSatisfied("auto", "mouse")).toBe(false);
    expect(detectionSatisfied("auto", null)).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("probes immediately on the first attempt", () => {
    expect(retryDelayMs(0)).toBe(0);
  });

  it("backs off as attempts accumulate", () => {
    const delays = [1, 2, 3, 4].map(retryDelayMs);
    expect(delays).toEqual([2000, 2000, 4000, 8000]);
  });

  it("caps rather than growing without bound", () => {
    expect(retryDelayMs(5)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(50)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(10_000)).toBe(RETRY_MAX_MS);
  });

  it("never returns a non-finite delay — there is no 'give up' value", () => {
    for (let i = 0; i < 200; i++) {
      expect(Number.isFinite(retryDelayMs(i))).toBe(true);
    }
  });
});

describe("hardwareSignalKey", () => {
  it("changes when the sidecar restarts on a new port", () => {
    const before = hardwareSignalKey({ sidecarCode: "connected", port: 49152 });
    const after = hardwareSignalKey({ sidecarCode: "connected", port: 64317 });
    expect(before).not.toEqual(after);
  });

  it("changes when a running sidecar reaches 'connected'", () => {
    const starting = hardwareSignalKey({ sidecarCode: "starting", port: 51000 });
    const connected = hardwareSignalKey({ sidecarCode: "connected", port: 51000 });
    expect(starting).not.toEqual(connected);
  });

  it("is stable while nothing changes, so the backoff is not reset in a loop", () => {
    const signal = { sidecarCode: "connected", port: 51000 };
    expect(hardwareSignalKey(signal)).toEqual(hardwareSignalKey({ ...signal }));
  });

  it("has a distinct value for no signal at all", () => {
    expect(hardwareSignalKey(null)).toBe("none");
  });
});

describe("hardwareReadiness", () => {
  it("does not gate providers the sidecar has nothing to do with", () => {
    // Fixed-port vendors and auto must never be blocked by Tobii's sidecar.
    expect(hardwareReadiness({ preferred: "eyetech", sidecarSupported: true, signal: null })).toBeNull();
    expect(hardwareReadiness({ preferred: "auto", sidecarSupported: true, signal: null })).toBeNull();
    expect(hardwareReadiness({ preferred: "camera", sidecarSupported: false, signal: null })).toBeNull();
  });

  it("refuses to probe on hosts that cannot spawn a sidecar (web, iPad)", () => {
    expect(
      hardwareReadiness({ preferred: "tobii", sidecarSupported: false, signal: null }),
    ).toBe(false);
  });

  it("waits for a status rather than probing a port that isn't open yet", () => {
    expect(
      hardwareReadiness({ preferred: "tobii", sidecarSupported: true, signal: null }),
    ).toBe(false);
  });

  it("is not ready while the sidecar is still starting or has no port", () => {
    expect(
      hardwareReadiness({ preferred: "tobii", sidecarSupported: true, signal: { sidecarCode: "starting", port: null } }),
    ).toBe(false);
    expect(
      hardwareReadiness({ preferred: "tobii", sidecarSupported: true, signal: { sidecarCode: "no_device", port: 51000 } }),
    ).toBe(false);
    expect(
      hardwareReadiness({ preferred: "tobii", sidecarSupported: true, signal: { sidecarCode: "connected", port: null } }),
    ).toBe(false);
  });

  it("is ready once the sidecar is connected on a known port", () => {
    expect(
      hardwareReadiness({ preferred: "tobii", sidecarSupported: true, signal: { sidecarCode: "connected", port: 64317 } }),
    ).toBe(true);
  });
});

describe("shouldAttemptSwitch", () => {
  it("does nothing while eye tracking is off", () => {
    expect(shouldAttemptSwitch(inputs({ enabled: false }))).toBe(false);
  });

  it("does nothing once the chosen tracker is active", () => {
    expect(shouldAttemptSwitch(inputs({ activeProvider: "tobii" }))).toBe(false);
  });

  it("keeps working while stranded on the mouse fallback", () => {
    expect(shouldAttemptSwitch(inputs({ activeProvider: "mouse" }))).toBe(true);
  });

  it("does not burn probes when the hardware provably isn't there", () => {
    expect(shouldAttemptSwitch(inputs({ hardwareReady: false }))).toBe(false);
  });

  it("probes when no signal governs the provider (unknown readiness)", () => {
    expect(shouldAttemptSwitch(inputs({ preferred: "eyetech", hardwareReady: null }))).toBe(true);
  });

  it("honours the backoff between attempts", () => {
    // One failure in: must wait 2s.
    expect(shouldAttemptSwitch(inputs({ attempts: 1, lastAttemptAt: 1000, now: 2500 }))).toBe(false);
    expect(shouldAttemptSwitch(inputs({ attempts: 1, lastAttemptAt: 1000, now: 3000 }))).toBe(true);
  });
});

describe("the field regression: a cold sidecar that connects late", () => {
  // Timings taken from the reported gaze-sidecar.log: the old client probed at
  // t=0 and t=2000 only, while this machine's sidecar bound its port at ~1500ms
  // and the tracker itself reached "connected" 14s after spawn on a cold boot.
  const SIDECAR_LISTENING_AT = 1500;
  const TRACKER_CONNECTED_AT = 14_300;

  function readinessAt(t: number) {
    return hardwareReadiness({
      preferred: "tobii",
      sidecarSupported: true,
      signal:
        t < SIDECAR_LISTENING_AT
          ? null
          : {
              sidecarCode: t < TRACKER_CONNECTED_AT ? "no_device" : "connected",
              port: 64317,
            },
    });
  }

  it("still attempts after the tracker finally comes up 14s late", () => {
    // Simulate the loop: tick every second, attempt when the policy allows.
    let attempts = 0;
    let lastAttemptAt = 0;
    let succeededAt: number | null = null;

    for (let t = 0; t <= 30_000 && succeededAt === null; t += 1000) {
      const ready = readinessAt(t);
      const attempt = shouldAttemptSwitch(
        inputs({ hardwareReady: ready, attempts, lastAttemptAt, now: t }),
      );
      if (!attempt) continue;
      lastAttemptAt = t;
      attempts += 1;
      // The probe can only succeed once the sidecar is actually connected.
      if (ready === true) succeededAt = t;
    }

    expect(succeededAt).not.toBeNull();
    expect(succeededAt!).toBeGreaterThanOrEqual(TRACKER_CONNECTED_AT);
    // The old two-strike client had spent its entire budget by t=2000.
    expect(succeededAt!).toBeLessThan(30_000);
  });

  it("never latches into a permanent failure, however many attempts have failed", () => {
    // The heart of the bug: after N failures the old code was done forever.
    for (const attempts of [2, 3, 10, 100, 5000]) {
      const stuck = inputs({
        attempts,
        lastAttemptAt: 0,
        now: RETRY_MAX_MS + 1,
        hardwareReady: true,
      });
      expect(shouldAttemptSwitch(stuck)).toBe(true);
    }
  });

  it("recovers after a sidecar restart lands on a new port", () => {
    // Restart: the supervisor nulls the port, then reports a new one. The key
    // change is what resets the caller's backoff.
    const before = hardwareSignalKey({ sidecarCode: "connected", port: 64317 });
    const during = hardwareSignalKey({ sidecarCode: "starting", port: null });
    const after = hardwareSignalKey({ sidecarCode: "connected", port: 52385 });

    expect(new Set([before, during, after]).size).toBe(3);
    // And with the fresh signal, a caller that had backed off all the way out
    // is immediately allowed to probe again.
    expect(
      shouldAttemptSwitch(inputs({ attempts: 0, lastAttemptAt: 0, now: 0, hardwareReady: true })),
    ).toBe(true);
  });
});
