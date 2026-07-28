// client-aac/src/lib/eyegaze/eyegaze-service.ts
// Orchestrator: registers providers, auto-detects the best available source, emits unified GazeData.

import type { EyeGazeProvider, EyeGazeProviderType, EyeGazeProviderStatus, GazeCallback, GazeData } from "./types";
import type { GazeSmootherConfig } from "@shared/gaze-smoothing.js";

const DEFAULT_PROBE_PRIORITY: EyeGazeProviderType[] = [
  "tobii", "eyetech", "lctech", "gazepoint", "webhid", "mouse",
];

const PROBE_TIMEOUT_MS = 500;

export interface EyeGazeServiceConfig {
  preferredProvider?: EyeGazeProviderType | "auto";
  probePriority?: EyeGazeProviderType[];
  probeTimeoutMs?: number;
}

export class EyeGazeService {
  private providers = new Map<EyeGazeProviderType, EyeGazeProvider>();
  private active: EyeGazeProvider | null = null;
  private callbacks = new Set<GazeCallback>();
  private relay: GazeCallback;
  private config: Required<EyeGazeServiceConfig>;

  constructor(config: EyeGazeServiceConfig = {}) {
    this.config = {
      preferredProvider: config.preferredProvider ?? "auto",
      probePriority: config.probePriority ?? DEFAULT_PROBE_PRIORITY,
      probeTimeoutMs: config.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
    };

    // Single relay callback that forwards data from active provider to all subscribers
    this.relay = (data: GazeData) => {
      for (const cb of this.callbacks) cb(data);
    };
  }

  registerProvider(provider: EyeGazeProvider) {
    this.providers.set(provider.type, provider);
  }

  getProvider(type: EyeGazeProviderType): EyeGazeProvider | undefined {
    return this.providers.get(type);
  }

  async autoDetectAndStart(): Promise<EyeGazeProviderType | null> {
    // If a specific provider is preferred, try it first
    if (this.config.preferredProvider !== "auto") {
      const pref = this.providers.get(this.config.preferredProvider);
      if (pref) {
        const ok = await this.probeWithTimeout(pref);
        if (ok) {
          await this.activateProvider(pref);
          return pref.type;
        }
      }
    }

    // Probe in priority order
    for (const type of this.config.probePriority) {
      const provider = this.providers.get(type);
      if (!provider) continue;

      const ok = await this.probeWithTimeout(provider);
      if (ok) {
        await this.activateProvider(provider);
        return provider.type;
      }
    }

    return null;
  }

  /**
   * Update the preferred provider after construction.
   *
   * Needed because the caller builds this service once, on mount, when the
   * student's settings have not loaded yet — so the constructor value is the
   * pre-load default ("mouse"), not what the student actually uses. Leaving it
   * frozen made autoDetectAndStart take its preferred branch with "mouse",
   * whose probe always succeeds, so a real tracker was never even tried.
   */
  setPreferredProvider(preferred: EyeGazeProviderType | "auto") {
    this.config.preferredProvider = preferred;
  }

  /**
   * @param probeTimeoutMs Override the probe budget for this one call. A
   *   targeted upgrade to a known tracker can afford to wait longer than the
   *   fast sweep through the priority list, where every miss delays the
   *   fallback the student is currently relying on.
   */
  async switchProvider(type: EyeGazeProviderType, probeTimeoutMs?: number): Promise<boolean> {
    const provider = this.providers.get(type);
    if (!provider) return false;

    const ok = await this.probeWithTimeout(provider, probeTimeoutMs);
    if (!ok) return false;

    // Stop current
    if (this.active) {
      this.active.offGaze(this.relay);
      this.active.stop();
    }

    await this.activateProvider(provider);
    return true;
  }

  onGaze(cb: GazeCallback) { this.callbacks.add(cb); }
  offGaze(cb: GazeCallback) { this.callbacks.delete(cb); }

  /** Push a smoothing config to every provider that supports it (hardware bridges). */
  setSmoothing(config: GazeSmootherConfig | false) {
    for (const p of this.providers.values()) p.setSmoothing?.(config);
  }

  /** Push the current pixels-per-degree (viewing geometry) to hardware bridges. */
  setPixelsPerDegree(pixelsPerDegree: number) {
    for (const p of this.providers.values()) p.setPixelsPerDegree?.(pixelsPerDegree);
  }

  getActiveProvider(): EyeGazeProvider | null {
    return this.active;
  }

  /**
   * Stop the active provider AND forget it, so the next detection starts clean.
   *
   * Callers used to stop the provider directly and leave `active` pointing at
   * it. Detection then saw a provider that looked active but was not running,
   * concluded there was nothing to do, and never restarted it — eye tracking
   * stayed dead after a disable/enable cycle.
   */
  deactivate() {
    if (!this.active) return;
    this.active.offGaze(this.relay);
    this.active.stop();
    this.active = null;
  }

  getActiveProviderType(): EyeGazeProviderType | null {
    return this.active?.type ?? null;
  }

  getAllStatuses(): EyeGazeProviderStatus[] {
    return Array.from(this.providers.values()).map(p => p.getStatus());
  }

  destroy() {
    if (this.active) {
      this.active.offGaze(this.relay);
      this.active.stop();
    }
    for (const p of this.providers.values()) {
      p.destroy();
    }
    this.providers.clear();
    this.callbacks.clear();
    this.active = null;
  }

  // ── Private ──

  private async activateProvider(provider: EyeGazeProvider) {
    provider.onGaze(this.relay);
    await provider.start();
    this.active = provider;
  }

  private probeWithTimeout(provider: EyeGazeProvider, timeoutMs?: number): Promise<boolean> {
    const budget = timeoutMs ?? this.config.probeTimeoutMs;
    return Promise.race([
      provider.probe(),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), budget),
      ),
    ]);
  }
}
