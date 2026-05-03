// client-aac/src/lib/eyegaze/eyegaze-service.ts
// Orchestrator: registers providers, auto-detects the best available source, emits unified GazeData.

import type { EyeGazeProvider, EyeGazeProviderType, EyeGazeProviderStatus, GazeCallback, GazeData } from "./types";

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

  async switchProvider(type: EyeGazeProviderType): Promise<boolean> {
    const provider = this.providers.get(type);
    if (!provider) return false;

    const ok = await this.probeWithTimeout(provider);
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

  getActiveProvider(): EyeGazeProvider | null {
    return this.active;
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

  private probeWithTimeout(provider: EyeGazeProvider): Promise<boolean> {
    return Promise.race([
      provider.probe(),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), this.config.probeTimeoutMs),
      ),
    ]);
  }
}
