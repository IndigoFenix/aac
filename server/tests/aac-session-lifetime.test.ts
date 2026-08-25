/**
 * AAC devices stay signed in "forever"; clinician sessions do not.
 *
 * The bug this pins: the AAC login left `cookie.maxAge` at the store default
 * (1 week) and express-session only re-sends `Set-Cookie` when the session is
 * MODIFIED — `rolling` is off and passport does not touch the session on
 * ordinary requests. The Postgres row kept sliding forward via `store.touch()`,
 * so the server thought the session was alive while the cookie held by the
 * device expired exactly 7 days after login. Every AAC device therefore needed
 * a fresh login weekly, which — since app updates ship more often than that —
 * read as "every update logs the student out".
 *
 * So the interesting assertions are about the SET-COOKIE HEADER, not about the
 * session object: bumping `cookie.maxAge` alone is invisible to `isModified()`
 * (which hashes the session without its cookie) and would never reach the
 * device. The end-to-end cases below run a real express-session stack over
 * memorystore to prove the header actually moves.
 *
 * DB-free — pure logic plus an in-memory session store, lives in the unit config.
 */

import { describe, it, expect } from "@jest/globals";
import express from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import http from "http";
import {
  AAC_SESSION_TTL_MS,
  AAC_SESSION_REFRESH_INTERVAL_MS,
  markAacSession,
  refreshAacSessionLifetime,
  refreshAacSession,
  type AacSessionLike,
} from "../session-lifetime.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const fakeSession = (over: Partial<AacSessionLike> = {}): AacSessionLike => ({
  cookie: { maxAge: 7 * DAY_MS },
  ...over,
});

describe("markAacSession", () => {
  it("gives the cookie a year and flags the session", () => {
    const s = fakeSession();
    markAacSession(s, 1_000);
    expect(s.cookie.maxAge).toBe(AAC_SESSION_TTL_MS);
    expect(s.aacClient).toBe(true);
    expect(s.aacRefreshedAt).toBe(1_000);
  });

  it("is a year, not a week — the old default was the whole bug", () => {
    expect(AAC_SESSION_TTL_MS).toBeGreaterThan(300 * DAY_MS);
  });
});

describe("refreshAacSessionLifetime", () => {
  it("ignores sessions that are not AAC devices", () => {
    const s = fakeSession({ cookie: { maxAge: DAY_MS } });
    expect(refreshAacSessionLifetime(s, Date.now())).toBe(false);
    expect(s.cookie.maxAge).toBe(DAY_MS);
    expect(s.aacRefreshedAt).toBeUndefined();
  });

  it("ignores a missing session", () => {
    expect(refreshAacSessionLifetime(undefined)).toBe(false);
    expect(refreshAacSessionLifetime(null)).toBe(false);
  });

  it("does not write on every request", () => {
    const s = fakeSession();
    markAacSession(s, 0);
    expect(refreshAacSessionLifetime(s, AAC_SESSION_REFRESH_INTERVAL_MS - 1)).toBe(false);
    expect(s.aacRefreshedAt).toBe(0);
  });

  it("re-stamps once the throttle interval has passed", () => {
    const s = fakeSession();
    markAacSession(s, 0);
    s.cookie.maxAge = 60_000; // as if the cookie had aged down
    const now = AAC_SESSION_REFRESH_INTERVAL_MS + 1;
    expect(refreshAacSessionLifetime(s, now)).toBe(true);
    expect(s.aacRefreshedAt).toBe(now);
    expect(s.cookie.maxAge).toBe(AAC_SESSION_TTL_MS);
  });

  it("keeps sliding forward — a used device never expires", () => {
    const s = fakeSession();
    markAacSession(s, 0);
    let now = 0;
    for (let day = 1; day <= 400; day++) {
      now += DAY_MS;
      refreshAacSessionLifetime(s, now);
    }
    expect(s.aacRefreshedAt).toBe(now);
    expect(s.cookie.maxAge).toBe(AAC_SESSION_TTL_MS);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a real express-session stack, so the assertions are about the
// bytes the device actually receives.
// ---------------------------------------------------------------------------

interface Probe {
  status: number;
  setCookie: string | undefined;
}

const MemoryStore = createMemoryStore(session);

function buildApp(): express.Express {
  const app = express();
  app.use(
    session({
      secret: "test-secret",
      resave: false,
      saveUninitialized: false,
      store: new MemoryStore({ checkPeriod: 60 * 60 * 1000 }),
      // Same shape as production: a 1-week default and no `rolling`.
      cookie: { maxAge: 7 * DAY_MS },
    }),
  );
  app.use(refreshAacSession);

  app.post("/login-aac", (req, res) => {
    (req.session as any).user = "student";
    markAacSession(req.session as unknown as AacSessionLike);
    res.json({ ok: true });
  });
  app.post("/login-clinician", (req, res) => {
    (req.session as any).user = "clinician";
    req.session.cookie.maxAge = DAY_MS;
    res.json({ ok: true });
  });
  // Pretend a day went by since the last re-stamp.
  app.post("/age", (req, res) => {
    req.session.aacRefreshedAt = Date.now() - AAC_SESSION_REFRESH_INTERVAL_MS - 1000;
    res.json({ ok: true });
  });
  app.get("/probe", (req, res) => {
    res.json({ user: (req.session as any).user ?? null });
  });
  return app;
}

function request(port: number, method: string, path: string, cookie?: string): Promise<Probe> {
  return new Promise<Probe>((resolve, reject) => {
    const headers: Record<string, string> = { "content-length": "0" };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      res.resume();
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          setCookie: res.headers["set-cookie"]?.[0],
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function withApp(fn: (port: number) => Promise<void>): Promise<void> {
  const server = http.createServer(buildApp());
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

/** `connect.sid=s%3A...; Path=/; Expires=...` -> the sid pair alone. */
const sidOf = (setCookie: string | undefined): string => {
  if (!setCookie) throw new Error("no Set-Cookie");
  return setCookie.split(";")[0];
};

/** Days from now until the cookie's Expires attribute. */
const daysOut = (setCookie: string | undefined): number => {
  const match = /expires=([^;]+)/i.exec(setCookie ?? "");
  if (!match) throw new Error(`no Expires in ${setCookie}`);
  return (new Date(match[1]).getTime() - Date.now()) / DAY_MS;
};

describe("session cookie over a real express-session stack", () => {
  it("hands an AAC device a year-long cookie", async () => {
    await withApp(async (port) => {
      const login = await request(port, "POST", "/login-aac");
      expect(daysOut(login.setCookie)).toBeGreaterThan(300);
    });
  });

  it("re-sends the AAC cookie once a day, so the expiry slides forward", async () => {
    await withApp(async (port) => {
      const login = await request(port, "POST", "/login-aac");
      const sid = sidOf(login.setCookie);

      // Same day: nothing to say, so no write and no header.
      const quiet = await request(port, "GET", "/probe", sid);
      expect(quiet.setCookie).toBeUndefined();

      // A day later the device gets a fresh year.
      await request(port, "POST", "/age", sid);
      const refreshed = await request(port, "GET", "/probe", sid);
      expect(refreshed.setCookie).toBeDefined();
      expect(sidOf(refreshed.setCookie)).toBe(sid); // same session, new expiry
      expect(daysOut(refreshed.setCookie)).toBeGreaterThan(300);
    });
  });

  it("leaves the clinician session alone — no global rolling", async () => {
    await withApp(async (port) => {
      const login = await request(port, "POST", "/login-clinician");
      expect(daysOut(login.setCookie)).toBeLessThan(2);
      const sid = sidOf(login.setCookie);

      const probe = await request(port, "GET", "/probe", sid);
      expect(probe.status).toBe(200);
      // An absolute 1-day expiry: the clinician cookie is NOT re-issued.
      expect(probe.setCookie).toBeUndefined();
    });
  });
});
