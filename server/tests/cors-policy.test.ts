/**
 * Tests for the CORS middleware. The previous implementation rejected any
 * origin not explicitly in `ALLOWED_ORIGINS`, which broke deployments whose
 * hostname wasn't in the list (Render preview URLs, ad-hoc local ports) even
 * for same-origin requests. This test pins the same-origin auto-allow.
 *
 * No supertest dep, so we spin up the express app on an ephemeral port and
 * issue real HTTP requests via Node's built-in http module.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import http from "http";
import { applyCorsPolicy } from "../middleware/security.js";

interface Probe {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

async function withApp(
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const app = express();
  applyCorsPolicy(app);
  app.get("/probe", (_req, res) => {
    res.json({ ok: true });
  });
  // Express forwards the CORS error here.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
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

function probe(port: number, headers: Record<string, string>): Promise<Probe> {
  return new Promise<Probe>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/probe", method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const ORIGINAL_ENV = { ...process.env };

describe("applyCorsPolicy", () => {
  beforeEach(() => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.APP_URL;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("allows requests with no Origin header (server-to-server, curl)", async () => {
    process.env.ALLOWED_ORIGINS = "https://example.com";
    await withApp(async (port) => {
      const res = await probe(port, {});
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });
  });

  it("allows same-origin requests even when host is not in ALLOWED_ORIGINS", async () => {
    // The Render-failure scenario: ALLOWED_ORIGINS points at the production
    // domain, but the app is also reachable at its Render hostname.
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, {
        Host: "aivota-demo-us.onrender.com",
        "X-Forwarded-Proto": "https",
        Origin: "https://aivota-demo-us.onrender.com",
      });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("https://aivota-demo-us.onrender.com");
    });
  });

  it("allows origins in the ALLOWED_ORIGINS list", async () => {
    process.env.ALLOWED_ORIGINS = "https://aivota.ai,https://app.aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, {
        Host: "internal.example.com",
        Origin: "https://app.aivota.ai",
      });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("https://app.aivota.ai");
    });
  });

  it("rejects cross-origin requests not in the allowlist", async () => {
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, {
        Host: "aivota.ai",
        "X-Forwarded-Proto": "https",
        Origin: "https://evil.example.com",
      });
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toMatch(/CORS: origin https:\/\/evil\.example\.com not allowed/);
    });
  });

  it("always allows the desktop app origin (app://aac), even when not in ALLOWED_ORIGINS", async () => {
    // The Electron client's origin is fixed and unforgeable by web pages, so it
    // is allowed regardless of per-deployment config.
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, {
        Host: "aivota-demo-us.onrender.com",
        "X-Forwarded-Proto": "https",
        Origin: "app://aac",
      });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("app://aac");
    });
  });

  it("allows the desktop app origin even with no ALLOWED_ORIGINS configured in prod", async () => {
    // ALLOWED_ORIGINS + APP_URL both unset (deleted in beforeEach).
    await withApp(async (port) => {
      const res = await probe(port, {
        Host: "aivota-demo-us.onrender.com",
        "X-Forwarded-Proto": "https",
        Origin: "app://aac",
      });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("app://aac");
    });
  });

  it("supports wildcard subdomain entries in ALLOWED_ORIGINS", async () => {
    process.env.ALLOWED_ORIGINS = "https://*.aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, {
        Host: "internal.example.com",
        Origin: "https://tenant1.aivota.ai",
      });
      expect(res.status).toBe(200);
    });
  });

  it("allows loopback origins (localhost / 127.0.0.1) on any port in dev", async () => {
    // The local-dev failure scenario: vite binds to 127.0.0.1:5173 while the
    // dev defaults only list `localhost`. Both are loopback, both safe.
    process.env.NODE_ENV = "development";
    await withApp(async (port) => {
      for (const origin of [
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://[::1]:9999",
      ]) {
        const res = await probe(port, { Origin: origin });
        expect({ origin, status: res.status }).toEqual({ origin, status: 200 });
      }
    });
  });

  it("rejects loopback origins in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOWED_ORIGINS = "https://aivota.ai";
    await withApp(async (port) => {
      const res = await probe(port, {
        Host: "aivota.ai",
        "X-Forwarded-Proto": "https",
        Origin: "http://127.0.0.1:5173",
      });
      expect(res.status).toBe(500);
    });
  });
});
