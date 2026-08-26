/**
 * /games/ Content-Security-Policy (server/games-static.ts).
 *
 * Games run on the API origin with the session cookie and an iframe sandbox
 * that has to grant `allow-same-origin`, so the CSP is the only thing standing
 * between a game script and `fetch('/api/…')`. Pin the shape that matters:
 * connect-src is path-scoped (never a bare 'self'), the login page's inline
 * script is nonce-authorised rather than 'unsafe-inline', frame-ancestors is
 * still there for the embeds, and the nonce is fresh per response.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mountGamesStatic, buildGamesCsp } from "../games-static";

let server: Server;
let base: string;
let dist: string;

beforeAll(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "games-csp-"));
  fs.mkdirSync(path.join(dist, "demo"));
  fs.writeFileSync(path.join(dist, "demo", "index.html"), "<!doctype html><title>demo</title>");
  const app = express();
  app.set("trust proxy", 1);
  mountGamesStatic(app, dist);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dist, { recursive: true, force: true });
});

function directive(csp: string, name: string): string | undefined {
  return csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
}

describe("games CSP", () => {
  it("path-scopes connect-src to the game surface, never the whole origin", async () => {
    const res = await fetch(`${base}/games/demo/`, { redirect: "manual" });
    // Unauthenticated → login redirect, but the header is already on it.
    expect(res.status).toBe(302);
    const csp = res.headers.get("content-security-policy") ?? "";
    const connect = directive(csp, "connect-src");
    expect(connect).toBeDefined();
    expect(connect).not.toMatch(/'self'/);
    expect(connect).toContain(`${base}/games/`);
    expect(connect).toContain(`${base}/api/custom-symbols/`);
    expect(connect).toContain(`${base}/auth/login`);
    expect(connect).toContain(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/social-bot`);
    expect(connect).not.toMatch(/\/api\/(?!custom-symbols\/)/);
    expect(directive(csp, "frame-ancestors")).toContain("'self' app:");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("authorises the login page's inline script by nonce, not 'unsafe-inline'", async () => {
    const res = await fetch(`${base}/games/_login`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    const script = directive(csp, "script-src") ?? "";
    expect(script).not.toContain("'unsafe-inline'");
    const nonce = /'nonce-([^']+)'/.exec(script)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
  });

  it("issues a fresh nonce per response", async () => {
    const a = await fetch(`${base}/games/_login`);
    const b = await fetch(`${base}/games/_login`);
    const nonceOf = (r: Response) =>
      /'nonce-([^']+)'/.exec(r.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonceOf(a)).toBeTruthy();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });

  it("uses wss + https origin behind a TLS-terminating proxy", () => {
    const req = {
      protocol: "https",
      get: (h: string) => (h.toLowerCase() === "host" ? "app.aivota.ai" : undefined),
    } as unknown as express.Request;
    const csp = buildGamesCsp(req, "n0nce", "frame-ancestors 'self' app:");
    const connect = directive(csp, "connect-src") ?? "";
    expect(connect).toContain("https://app.aivota.ai/games/");
    expect(connect).toContain("wss://app.aivota.ai/ws/social-bot");
    expect(connect).not.toContain("http://");
  });
});
