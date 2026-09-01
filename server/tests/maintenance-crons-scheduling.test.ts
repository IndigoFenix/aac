/**
 * Pins the two guards that keep the maintenance crons from deadlocking the
 * DB pool (the 2026-09-01 production outage — see maintenanceCrons.ts header).
 *
 *   1. Runs are serialised: cron-lock.ts holds a pool client for a cron's
 *      whole body, the body's queries need another, and the pool is `max: 3`,
 *      so two crons in flight at once is already the budget and three is a
 *      deadlock. The queue must never let bodies overlap.
 *   2. Intervals are armed from each cron's FIRST run, not from boot, so the
 *      periodic ticks stay staggered instead of converging at boot+24h.
 *
 * DB-free: the queue and the arming are pure scheduling; no cron body runs.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { createSerialQueue, armCron, type CronTimers } from "../services/maintenanceCrons.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("createSerialQueue", () => {
  it("never lets two bodies overlap, and preserves order", async () => {
    const queue = createSerialQueue();
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const body = (name: string, ms: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      active--;
      return name;
    };
    // Enqueued together, exactly the way seven interval ticks land at once.
    const results = await Promise.all([
      queue(body("a", 20)),
      queue(body("b", 5)),
      queue(body("c", 1)),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(peak).toBe(1);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("a rejecting body does not block the ones behind it", async () => {
    const queue = createSerialQueue();
    const failing = queue(async () => {
      throw new Error("sweep exploded");
    });
    const after = queue(async () => "ran anyway");
    await expect(failing).rejects.toThrow("sweep exploded");
    await expect(after).resolves.toBe("ran anyway");
  });
});

describe("armCron", () => {
  afterEach(() => jest.useRealTimers());

  /** Records every tick as [cronName, label, fake-clock ms]. */
  function arm(crons: Array<{ name: string; initialDelayMs: number; intervalMs?: number }>) {
    const ticks: Array<[string, string, number]> = [];
    const t0 = Date.now();
    const timers: CronTimers = { setTimeout, setInterval };
    const sink: NodeJS.Timeout[] = [];
    for (const cron of crons) {
      armCron(cron, (label) => ticks.push([cron.name, label, Date.now() - t0]), timers, sink);
    }
    return { ticks, sink };
  }

  it("counts the interval from the first run, so ticks keep their boot stagger", () => {
    jest.useFakeTimers();
    const { ticks } = arm([
      { name: "erasure", initialDelayMs: 90_000 },
      { name: "retention", initialDelayMs: 60_000 },
      { name: "deadlines", initialDelayMs: 45_000, intervalMs: HOUR },
    ]);
    jest.advanceTimersByTime(DAY + 90_000);

    const at = (name: string, label: string) =>
      ticks.filter(([n, l]) => n === name && l === label).map(([, , ms]) => ms);

    expect(at("retention", "initial")).toEqual([60_000]);
    expect(at("erasure", "initial")).toEqual([90_000]);
    // The daily ticks land 24h after EACH first run — 30s apart, not together.
    expect(at("retention", "scheduled")).toEqual([DAY + 60_000]);
    expect(at("erasure", "scheduled")).toEqual([DAY + 90_000]);
    // The hourly cron's 24th tick is at 24h+45s — it does not coincide with
    // either daily tick either.
    const hourly = at("deadlines", "scheduled");
    expect(hourly).toHaveLength(24);
    expect(hourly[23]).toBe(DAY + 45_000);

    // Nothing ever fires in the same millisecond.
    const stamps = ticks.map(([, , ms]) => ms);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it("hands every handle to the sink, including the interval created later", () => {
    jest.useFakeTimers();
    const { sink } = arm([{ name: "x", initialDelayMs: 1_000, intervalMs: HOUR }]);
    expect(sink).toHaveLength(1); // only the initial timeout exists at boot
    jest.advanceTimersByTime(1_000);
    expect(sink).toHaveLength(2); // the interval joined the same array
    for (const h of sink) clearTimeout(h);
  });
});
