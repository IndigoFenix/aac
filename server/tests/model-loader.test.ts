// Tests for the client-side retrying model loader. Pure logic (timers +
// promises, no DOM/React), so it's imported straight from the client lib —
// same precedent as speech-segmenter.test.ts / sleep-system-logic.test.ts.

import { jest } from "@jest/globals";
import {
  createModelLoader,
  retryDelayMs,
  type ModelLoaderStatus,
} from "../../client-aac/src/lib/modelLoader";

describe("retryDelayMs", () => {
  it("grows and caps at 60s", () => {
    expect(retryDelayMs(0)).toBe(1_000);
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(5)).toBe(60_000);
    expect(retryDelayMs(50)).toBe(60_000);
  });
});

describe("createModelLoader", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("resolves get() on first-attempt success and loads only once", async () => {
    const load = jest.fn<() => Promise<string>>().mockResolvedValue("model");
    const loader = createModelLoader("test", load);

    expect(loader.status().state).toBe("idle");
    await expect(loader.get()).resolves.toBe("model");
    await expect(loader.get()).resolves.toBe("model");

    expect(load).toHaveBeenCalledTimes(1);
    expect(loader.tryGet()).toBe("model");
    expect(loader.status()).toMatchObject({ state: "ready", attempts: 1, lastError: null });
  });

  it("retries failed loads on the backoff schedule until one lands", async () => {
    const load = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("net down"))
      .mockRejectedValueOnce(new Error("still down"))
      .mockResolvedValue("model");
    const loader = createModelLoader("test", load);

    const got = loader.get();
    await jest.advanceTimersByTimeAsync(0);
    expect(loader.status()).toMatchObject({ state: "error", attempts: 1, lastError: "net down" });

    await jest.advanceTimersByTimeAsync(retryDelayMs(0));
    expect(loader.status()).toMatchObject({ state: "error", attempts: 2, lastError: "still down" });

    await jest.advanceTimersByTimeAsync(retryDelayMs(1));
    await expect(got).resolves.toBe("model");
    expect(loader.status()).toMatchObject({ state: "ready", attempts: 3, lastError: null });
  });

  it("resolves every waiter queued during loading/retries", async () => {
    const load = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("model");
    const loader = createModelLoader("test", load);

    const a = loader.get();
    const b = loader.get();
    await jest.advanceTimersByTimeAsync(0);
    const c = loader.get(); // queued while in error/backoff

    await jest.advanceTimersByTimeAsync(retryDelayMs(0));
    await expect(Promise.all([a, b, c])).resolves.toEqual(["model", "model", "model"]);
  });

  it("preload() starts loading without a waiter", async () => {
    const load = jest.fn<() => Promise<string>>().mockResolvedValue("model");
    const loader = createModelLoader("test", load);

    loader.preload();
    loader.preload(); // idempotent
    await jest.advanceTimersByTimeAsync(0);

    expect(load).toHaveBeenCalledTimes(1);
    expect(loader.tryGet()).toBe("model");
  });

  it("notifies subscribers on state changes and immediately on subscribe", async () => {
    const load = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("model");
    const loader = createModelLoader("test", load);

    const seen: ModelLoaderStatus[] = [];
    const unsubscribe = loader.subscribe((st) => seen.push(st));
    expect(seen).toHaveLength(1);
    expect(seen[0].state).toBe("idle");

    loader.preload();
    await jest.advanceTimersByTimeAsync(0);
    expect(seen.map((s) => s.state)).toEqual(["idle", "loading", "error"]);

    await jest.advanceTimersByTimeAsync(retryDelayMs(0));
    expect(seen.map((s) => s.state)).toEqual(["idle", "loading", "error", "loading", "ready"]);

    unsubscribe();
    loader.subscribe(() => {}); // new subscriber shouldn't affect `seen`
    expect(seen).toHaveLength(5);
  });
});
