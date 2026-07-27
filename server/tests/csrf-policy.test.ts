/**
 * Tests for the CSRF origin guard (`validateCSRF`).
 *
 * The case that motivated these: the iPad (Capacitor) client routes its API
 * calls through CapacitorHttp for cookie reasons, and a native HTTP request
 * carries NEITHER Origin NOR Referer — so every login POST was rejected with
 * "CSRF: missing Origin/Referer". The client now declares its origin in
 * `NATIVE_ORIGIN_HEADER`, which is honoured only for the fixed native origins.
 *
 * Same harness as cors-policy.test.ts: no supertest dep, so the app is bound to
 * an ephemeral port and driven with Node's http module.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import http from "http";
import { validateCSRF } from "../middleware/auth.js";
import { NATIVE_ORIGIN_HEADER } from "../middleware/security.js";

interface Probe {
  status: number;
  body: string;
}

async function withApp(fn: (port: number) => Promise<void>): Promise<void> {
  const app = express();
  app.use(validateCSRF);
  app.post("/probe", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/probe", (_req, res) => {
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("server not listening");
  try {
    await fn(addr.port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

function probe(
  port: number,
  headers: Record<string, string>,
  method: string = "POST",
): Promise<Probe> {
  return new Promise<Probe>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/probe", method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const ORIGINAL_ENV = { ...process.env };

describe("validateCSRF", () => {
  beforeEach(() => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.APP_URL;
    // The middleware short-circuits under NODE_ENV=test (supertest sends no
    // Origin); these tests exercise the real path, so pose as production.
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("skips GET requests entirely", async () => {
    await withApp(async (port) => {
      const res = await probe(port, {}, "GET");
      expect(res.status).toBe(200);
    });
  });

  it("rejects a state-changing request with no Origin, Referer, or native header", async () => {
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, {});
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/missing Origin\/Referer/);
    });
  });

  it("allows an allowlisted Origin", async () => {
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, { Origin: "https://aivota.ai" });
      expect(res.status).toBe(200);
    });
  });

  it("rejects an Origin that is not allowlisted", async () => {
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, { Origin: "https://evil.example.com" });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/origin not allowed/);
    });
  });

  it("falls back to Referer when Origin is absent", async () => {
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, { Referer: "https://aivota.ai/login" });
      expect(res.status).toBe(200);
    });
  });

  it("accepts the iPad client's declared native origin when Origin/Referer are absent", async () => {
    // The failing case: CapacitorHttp sends no Origin and no Referer at all.
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, { [NATIVE_ORIGIN_HEADER]: "capacitor://localhost" });
      expect(res.status).toBe(200);
    });
  });

  it("accepts the declared native origin with no ALLOWED_ORIGINS configured", async () => {
    // Native origins are blessed unconditionally, like they are for CORS — an
    // iPad build must not depend on a backend's env being updated.
    await withApp(async (port) => {
      const res = await probe(port, { [NATIVE_ORIGIN_HEADER]: "app://aac" });
      expect(res.status).toBe(200);
    });
  });

  it("ignores a declared origin that is not a known native origin", async () => {
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      for (const declared of [
        "https://evil.example.com",
        "https://aivota.ai", // even an allowlisted web origin: this header is native-only
        "capacitor://evil.example.com",
      ]) {
        const res = await probe(port, { [NATIVE_ORIGIN_HEADER]: declared });
        expect({ declared, status: res.status }).toEqual({ declared, status: 403 });
      }
    });
  });

  it("prefers a real Origin over the declared native header", async () => {
    // The header is a fallback only — it must not launder a rejected Origin.
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, {
        Origin: "https://evil.example.com",
        [NATIVE_ORIGIN_HEADER]: "capacitor://localhost",
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/origin not allowed/);
    });
  });
});
