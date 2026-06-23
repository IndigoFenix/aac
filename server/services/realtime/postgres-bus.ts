// Postgres LISTEN/NOTIFY implementation of FanoutBus.
//
// Uses a dedicated pg.Client (not the Drizzle pool) because LISTEN holds the
// connection for the lifetime of the process. Payload is limited to ~8 kB by
// Postgres, which is fine for our ID-only bus messages.

import pg from "pg";
import { randomUUID } from "crypto";
import type { FanoutBus } from "./bus";

const NOTIFY_CHANNEL = "realtime_events";

export class PostgresBus implements FanoutBus {
  readonly instanceId = randomUUID();
  private client: pg.Client | null = null;
  private handlers: ((channel: string, payload: string) => void)[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly connectionString: string) {}

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.connectionString.replace(/[?&]sslmode=[^&]*/g, ""),
      ssl: { rejectUnauthorized: false },
    });
    client.on("notification", (msg) => {
      if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
      try {
        const decoded = JSON.parse(msg.payload) as { channel: string; body: string };
        for (const handler of this.handlers) handler(decoded.channel, decoded.body);
      } catch (err) {
        console.error("[PostgresBus] payload parse error:", err);
      }
    });
    client.on("error", (err) => {
      console.error("[PostgresBus] client error:", err);
      this.scheduleReconnect();
    });
    client.on("end", () => {
      console.warn("[PostgresBus] connection ended");
      this.scheduleReconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    this.client = client;
    console.log(`[PostgresBus] listening on channel ${NOTIFY_CHANNEL} (instance ${this.instanceId})`);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.client = null;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        console.error("[PostgresBus] reconnect failed:", err);
        this.scheduleReconnect();
      }
    }, 2000);
  }

  async publish(channel: string, payload: string): Promise<void> {
    if (!this.client) return;
    const encoded = JSON.stringify({ channel, body: payload });
    await this.client.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, encoded]);
  }

  onMessage(handler: (channel: string, payload: string) => void): void {
    this.handlers.push(handler);
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.client) return;
    try { await this.client.query(`UNLISTEN ${NOTIFY_CHANNEL}`); } catch { /* ignore */ }
    try { await this.client.end(); } catch { /* ignore */ }
    this.client = null;
  }
}
