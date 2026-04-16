// Redis pub/sub implementation of FanoutBus.
//
// Not wired into production yet; enable by setting REALTIME_BUS=redis and
// providing REDIS_URL. Install `ioredis` as a dependency before switching.
// When moving to HIPAA-mode we should additionally:
//   - deploy ElastiCache inside the VPC with TLS in transit and at rest
//   - sign a BAA with the Redis provider
//   - keep payloads ID-only (unchanged) so message bodies never transit Redis
//   - disable MONITOR / SLOWLOG in production configs

import { randomUUID } from "crypto";
import type { FanoutBus } from "./bus";

const CHANNEL_NAME = "realtime_events";

// Minimal structural type so we don't import ioredis unless selected.
interface RedisClientLike {
  subscribe(channel: string): Promise<unknown>;
  publish(channel: string, payload: string): Promise<unknown>;
  on(event: "message", handler: (channel: string, payload: string) => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  quit(): Promise<unknown>;
}

type RedisConstructor = new (connectionString: string) => RedisClientLike;

export class RedisBus implements FanoutBus {
  readonly instanceId = randomUUID();
  private pub: RedisClientLike | null = null;
  private sub: RedisClientLike | null = null;
  private handler: ((channel: string, payload: string) => void) | null = null;

  constructor(private readonly connectionString: string) {}

  async start(): Promise<void> {
    let Redis: RedisConstructor;
    try {
      // Dynamic string avoids TS resolving the module at compile time, so the
      // repo builds without ioredis installed. Install it when enabling redis.
      const modName = "ioredis";
      const mod: any = await import(/* @vite-ignore */ modName);
      Redis = (mod.default ?? mod) as RedisConstructor;
    } catch (err) {
      throw new Error(
        "RedisBus selected but 'ioredis' is not installed. Run `npm install ioredis`.",
      );
    }

    this.pub = new Redis(this.connectionString);
    this.sub = new Redis(this.connectionString);

    this.sub.on("error", (err: Error) => {
      console.error("[RedisBus] sub error:", err);
    });
    this.pub.on("error", (err: Error) => {
      console.error("[RedisBus] pub error:", err);
    });

    this.sub.on("message", (_channel: string, raw: string) => {
      try {
        const decoded = JSON.parse(raw) as { channel: string; body: string };
        this.handler?.(decoded.channel, decoded.body);
      } catch (err) {
        console.error("[RedisBus] payload parse error:", err);
      }
    });

    await this.sub.subscribe(CHANNEL_NAME);
    console.log(`[RedisBus] subscribed to ${CHANNEL_NAME} (instance ${this.instanceId})`);
  }

  async publish(channel: string, payload: string): Promise<void> {
    if (!this.pub) return;
    const encoded = JSON.stringify({ channel, body: payload });
    await this.pub.publish(CHANNEL_NAME, encoded);
  }

  onMessage(handler: (channel: string, payload: string) => void): void {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    try { await this.pub?.quit(); } catch { /* ignore */ }
    try { await this.sub?.quit(); } catch { /* ignore */ }
    this.pub = null;
    this.sub = null;
  }
}
