// Lightweight Express req/res fakes for unit-style controller tests.
// Avoids pulling in supertest / a full app boot.

import type { Request, Response } from "express";

export interface FakeResponse {
  statusCode: number;
  jsonBody?: unknown;
  ended: boolean;
}

export function makeReq(opts: {
  user?: Record<string, unknown> | null;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
  protocol?: string;
  host?: string;
}): Request {
  const headers = {
    host: opts.host ?? "localhost:3000",
    ...(opts.headers ?? {}),
  };
  return {
    user: opts.user ?? null,
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body ?? {},
    headers,
    ip: opts.ip ?? "127.0.0.1",
    protocol: opts.protocol ?? "http",
    // Express's `req.get` is a header lookup; some controllers use it for
    // host resolution (getBaseUrl). Provide a minimal stub so fake reqs
    // exercise the same code path.
    get(name: string) {
      const k = String(name).toLowerCase();
      return (headers as Record<string, string>)[k] ?? (headers as Record<string, string>)[name];
    },
  } as unknown as Request;
}

export function makeRes(): { res: Response; capture: FakeResponse } {
  const capture: FakeResponse = { statusCode: 200, ended: false };
  const res = {
    status(code: number) {
      capture.statusCode = code;
      return this;
    },
    json(body: unknown) {
      capture.jsonBody = body;
      capture.ended = true;
      return this;
    },
    send(body: unknown) {
      capture.jsonBody = body;
      capture.ended = true;
      return this;
    },
  } as unknown as Response;
  return { res, capture };
}
