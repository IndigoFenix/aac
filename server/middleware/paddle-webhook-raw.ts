// server/middleware/paddle-webhook-raw.ts
//
// The Paddle webhook needs the EXACT bytes Paddle signed. `express.json()` is
// mounted globally in both entry points (server/index.ts and server/app.prod.ts)
// and replaces req.body with a parsed object, destroying the raw text — after
// which signature verification is not merely inconvenient, it is impossible.
//
// So a raw parser is mounted for this ONE path, ahead of the global json
// parser. Express runs the first body parser that matches and later parsers
// see an already-populated `req.body` and no-op, so the ordering is the whole
// mechanism: this must be applied BEFORE express.json().
//
// It lives in its own module because there are two entry points and a rule
// enforced in one of them is a rule that will be wrong in the other. (The third
// entry point, app.lambda.ts, is the manual Lambda rollback path and is
// deliberately left alone — no new features there, per CLAUDE.md.)

import express, { type Express } from "express";

/** The one path whose body must survive as raw bytes. */
export const PADDLE_WEBHOOK_PATH = "/api/paddle/webhook";

/**
 * Mount the raw body parser for the Paddle webhook. Call this immediately
 * before `app.use(express.json(...))`.
 *
 * 1mb, not the global 100mb: a Paddle notification is a few kilobytes, and this
 * endpoint is unauthenticated by design (the signature is the auth), so the
 * body limit is the only thing standing between an anonymous POST and a 100mb
 * allocation.
 */
export function applyPaddleWebhookRawBody(app: Express): void {
  app.use(
    PADDLE_WEBHOOK_PATH,
    express.raw({ type: "application/json", limit: "1mb" }),
  );
}
