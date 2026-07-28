// client-aac/src/lib/eyegaze/eyegaze-service.test.ts
//
// Service-level guards for the pieces the Tobii re-detection fix depends on:
// a "preferred" that can be corrected after construction, a probe budget that
// can be widened for a targeted upgrade, and a deactivate() that actually
// clears the active provider.

import { EyeGazeService } from "./eyegaze-service";
import type {
  EyeGazeProvider,
  EyeGazeProviderStatus,
  EyeGazeProviderType,
  GazeCallback,
} from "./types";

class StubProvider implements EyeGazeProvider {
  readonly needsCalibration = false;
  started = 0;
  stopped = 0;
  probes = 0;
  private callbacks = new Set<GazeCallback>();

  constructor(
    readonly type: EyeGazeProviderType,
    /** Answer probes with this. A number means "resolve true after N ms". */
    private probeResult: boolean | number = true,
  ) {}

  setProbeResult(result: boolean | number) {
    this.probeResult = result;
  }

  async probe(): Promise<boolean> {
    this.probes += 1;
    if (typeof this.probeResult === "number") {
      const delay = this.probeResult;
      return new Promise((resolve) => setTimeout(() => resolve(true), delay));
    }
    return this.probeResult;
  }

  async start(): Promise<void> { this.started += 1; }
  stop(): void { this.stopped += 1; }
  destroy(): void { this.callbacks.clear(); }
  onGaze(cb: GazeCallback): void { this.callbacks.add(cb); }
  offGaze(cb: GazeCallback): void { this.callbacks.delete(cb); }
  getStatus(): EyeGazeProviderStatus {
    return { type: this.type, connected: this.started > this.stopped, error: null, supportsCalibration: false };
  }
}

function serviceWith(providers: StubProvider[], config = {}) {
  const service = new EyeGazeService(config);
  for (const p of providers) service.registerProvider(p);
  return service;
}

describe("setPreferredProvider", () => {
  it("overrides the value frozen in at construction", async () => {
    // The hook builds the service on mount, when settings say "mouse", and
    // corrects it once the student's real settings arrive. Without this, auto-
    // detect took its preferred branch with "mouse" — which always probes true
    // — and a real tracker was never tried.
    const mouse = new StubProvider("mouse", true);
    const tobii = new StubProvider("tobii", true);
    const service = serviceWith([tobii, mouse], { preferredProvider: "mouse" });

    service.setPreferredProvider("tobii");
    const chosen = await service.autoDetectAndStart();

    expect(chosen).toBe("tobii");
    expect(tobii.started).toBe(1);
    expect(mouse.started).toBe(0);
  });

  it("still falls back through the priority list when the preferred one is absent", async () => {
    const mouse = new StubProvider("mouse", true);
    const tobii = new StubProvider("tobii", false);
    const service = serviceWith([tobii, mouse]);

    service.setPreferredProvider("tobii");

    expect(await service.autoDetectAndStart()).toBe("mouse");
  });
});

describe("switchProvider probe budget", () => {
  it("gives up on a slow probe at the default budget", async () => {
    const tobii = new StubProvider("tobii", 900); // answers after 900ms
    const service = serviceWith([tobii], { probeTimeoutMs: 300 });

    expect(await service.switchProvider("tobii")).toBe(false);
    expect(tobii.started).toBe(0);
  });

  it("accepts the same slow probe when the caller widens the budget", async () => {
    // A cold gaze sidecar needs ~1.5s to bind its port; the default sweep
    // budget is deliberately short so a miss doesn't stall the fallback.
    const tobii = new StubProvider("tobii", 900);
    const service = serviceWith([tobii], { probeTimeoutMs: 300 });

    expect(await service.switchProvider("tobii", 2500)).toBe(true);
    expect(tobii.started).toBe(1);
  });

  it("leaves the current provider running when an upgrade probe fails", async () => {
    // The student is on the mouse fallback; a failed Tobii attempt must not
    // take that away from them.
    const mouse = new StubProvider("mouse", true);
    const tobii = new StubProvider("tobii", false);
    const service = serviceWith([tobii, mouse]);

    await service.autoDetectAndStart();
    expect(service.getActiveProviderType()).toBe("mouse");

    expect(await service.switchProvider("tobii")).toBe(false);
    expect(service.getActiveProviderType()).toBe("mouse");
    expect(mouse.stopped).toBe(0);
  });
});

describe("deactivate", () => {
  it("stops the provider AND clears it, so detection restarts cleanly", async () => {
    // Regression: stopping the provider without clearing `active` made the
    // detection loop see "already active, nothing to do" after a disable/enable
    // cycle, leaving eye tracking dead until a full remount.
    const mouse = new StubProvider("mouse", true);
    const service = serviceWith([mouse]);

    await service.autoDetectAndStart();
    expect(service.getActiveProviderType()).toBe("mouse");

    service.deactivate();
    expect(mouse.stopped).toBe(1);
    expect(service.getActiveProviderType()).toBeNull();

    // Re-enable: the provider is actually started again.
    await service.autoDetectAndStart();
    expect(mouse.started).toBe(2);
    expect(service.getActiveProviderType()).toBe("mouse");
  });

  it("is safe to call when nothing is active", () => {
    const service = serviceWith([new StubProvider("mouse", true)]);
    expect(() => service.deactivate()).not.toThrow();
    expect(service.getActiveProviderType()).toBeNull();
  });
});
