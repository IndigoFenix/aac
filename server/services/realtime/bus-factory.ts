// Selects the FanoutBus implementation based on environment.
//
// REALTIME_BUS:
//   "memory"   — single-instance dev (default)
//   "postgres" — LISTEN/NOTIFY via DATABASE_URL
//   "redis"    — Redis pub/sub via REDIS_URL (requires ioredis)

import { InMemoryBus, type FanoutBus } from "./bus";
import { PostgresBus } from "./postgres-bus";
import { RedisBus } from "./redis-bus";

let bus: FanoutBus | null = null;

export function getBus(): FanoutBus {
  if (!bus) throw new Error("Realtime bus not initialized — call initBus() first");
  return bus;
}

export async function initBus(): Promise<FanoutBus> {
  if (bus) return bus;
  const kind = (process.env.REALTIME_BUS ?? "memory").toLowerCase();

  if (kind === "postgres") {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("REALTIME_BUS=postgres requires DATABASE_URL");
    bus = new PostgresBus(url);
  } else if (kind === "redis") {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REALTIME_BUS=redis requires REDIS_URL");
    bus = new RedisBus(url);
  } else {
    bus = new InMemoryBus();
  }

  await bus.start();
  console.log(`[realtime] bus initialized: ${kind} (instance ${bus.instanceId})`);
  return bus;
}

export async function stopBus(): Promise<void> {
  if (!bus) return;
  await bus.stop();
  bus = null;
}
