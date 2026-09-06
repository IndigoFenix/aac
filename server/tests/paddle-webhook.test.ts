/**
 * POST /api/paddle/webhook — DB-free end-to-end test of the HTTP layer.
 *
 * What is REAL here and what is faked, and why:
 *
 *  • The signature is REAL. The test builds `paddle-signature: ts=…;h1=…` the
 *    way Paddle does (hex HMAC-SHA256 of `${ts}:${rawBody}` under the webhook
 *    secret) and the request is verified by the actual SDK through
 *    paddleService.verifyWebhook. Reimplementing verification in a fake would
 *    test our fake, not the endpoint — and the endpoint's ONLY authentication
 *    is that signature.
 *
 *  • The raw-body middleware is REAL, mounted from the same shared helper the
 *    two entry points use, in the same order (raw for the webhook path, then
 *    the global express.json). This is the arrangement the whole scheme rests
 *    on: if express.json wins, the bytes Paddle signed are gone and no
 *    signature can ever validate again.
 *
 *  • The `paddle_events` repository and the fulfillment service are FAKED, so
 *    this suite needs no database. Their real behaviour is covered by
 *    paddle-fulfillment.test.ts and integration/paddle-fulfillment-db.test.ts.
 *
 * NOTE on timestamps: Paddle's validator rejects a signature whose `ts` is more
 * than 5 seconds old, so every signature here is built from the current clock.
 */

import { describe, it, expect, jest, beforeAll, beforeEach } from "@jest/globals";
import crypto from "crypto";
import express from "express";
import http from "http";

const WEBHOOK_SECRET = "pdl_ntfset_test_secret";

// ---------------------------------------------------------------------------
// Fakes — installed BEFORE the controller is imported (ESM: a plain jest.mock
// is inert in this repo, see CLAUDE.md / feedback_jest_mock_inert_under_esm).
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  eventType: string;
  occurredAt: Date;
  status: string;
  error: string | null;
}

const rows = new Map<string, FakeRow>();

const claimEvent = jest.fn<any>(async (input: any) => {
  const existing = rows.get(input.id);
  if (existing) return { claimed: false, row: existing };
  const row: FakeRow = {
    id: input.id,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    status: "received",
    error: null,
  };
  rows.set(input.id, row);
  return { claimed: true, row };
});

const setStatus = jest.fn<any>(async (id: string, status: string, error?: string | null) => {
  const row = rows.get(id);
  if (row) {
    row.status = status;
    row.error = error ?? null;
  }
  return row;
});

const reopenFailed = jest.fn<any>(async (id: string) => {
  const row = rows.get(id);
  if (row && row.status === "failed") row.status = "received";
});

jest.unstable_mockModule("../repositories/paddleEventRepository.js", () => ({
  paddleEventRepository: { claimEvent, setStatus, reopenFailed },
  PaddleEventRepository: class {},
}));

const handleEvent = jest.fn<any>(async () => ({ status: "processed", actions: ["ok"] }));

jest.unstable_mockModule("../services/paddleFulfillmentService.js", () => ({
  getPaddleFulfillmentService: async () => ({ handleEvent }),
  resetPaddleFulfillmentService: () => {},
  PaddleFulfillmentService: class {},
}));

const notifyPaddleFulfillmentProblem = jest.fn<any>();
// The alert path ends in SES and the test env carries live credentials — a
// real module here would EMAIL on every failure case below.
jest.unstable_mockModule("../services/providerAlertService.js", () => ({
  notifyPaddleFulfillmentProblem,
  resetPaddleAlertThrottle: () => {},
}));

let paddleController: typeof import("../controllers/paddleController.js").paddleController;
let applyPaddleWebhookRawBody: typeof import("../middleware/paddle-webhook-raw.js").applyPaddleWebhookRawBody;

// ---------------------------------------------------------------------------
// Harness — no supertest dependency in this repo (see cors-policy.test.ts).
// ---------------------------------------------------------------------------

interface Probe {
  status: number;
  body: string;
}

async function withApp(fn: (port: number) => Promise<void>): Promise<void> {
  const app = express();
  // The production ordering, from the production helper.
  applyPaddleWebhookRawBody(app);
  app.use(express.json({ limit: "100mb" }));
  app.post("/api/paddle/webhook", (req, res) => paddleController.handleWebhook(req, res));

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

function post(port: number, body: string, headers: Record<string, string>): Promise<Probe> {
  return new Promise<Probe>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/paddle/webhook",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Exactly the header Paddle sends: `ts=<unix>;h1=<hex hmac of "ts:body">`. */
function sign(rawBody: string, secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)): string {
  const h1 = crypto.createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

/**
 * A transaction.completed body in Paddle's WIRE format (snake_case).
 *
 * `items[].price.unit_price`, `price.quantity` and a top-level `payments` array
 * are not decoration: the SDK's notification entities construct sub-objects
 * from them unconditionally, so a body missing any of them makes `unmarshal`
 * THROW even though the signature is perfectly valid — and the controller
 * rightly cannot tell that apart from a forgery, so it answers 400.
 */
function eventBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: "evt_01test",
    event_type: "transaction.completed",
    occurred_at: "2026-09-01T10:00:00.000000Z",
    notification_id: "ntf_01test",
    data: {
      id: "txn_abc",
      status: "completed",
      currency_code: "USD",
      origin: "web",
      collection_mode: "automatic",
      custom_data: { userId: "user_1" },
      payments: [],
      items: [
        {
          price: {
            id: "pri_pack",
            product_id: "pro_1",
            description: "Starter Pack",
            type: "standard",
            tax_mode: "account_setting",
            unit_price: { amount: "999", currency_code: "USD" },
            quantity: { minimum: 1, maximum: 1 },
            status: "active",
          },
          quantity: 1,
        },
      ],
    },
    ...over,
  });
}

beforeAll(async () => {
  process.env.PADDLE_ENVIRONMENT = "sandbox";
  process.env.PADDLE_API_KEY_SANDBOX = "pdl_sdbx_test_key";
  process.env.PADDLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  ({ paddleController } = await import("../controllers/paddleController.js"));
  ({ applyPaddleWebhookRawBody } = await import("../middleware/paddle-webhook-raw.js"));
});

beforeEach(() => {
  rows.clear();
  claimEvent.mockClear();
  setStatus.mockClear();
  reopenFailed.mockClear();
  handleEvent.mockClear();
  handleEvent.mockImplementation(async () => ({ status: "processed", actions: ["ok"] }));
});

describe("paddle webhook — signature", () => {
  it("accepts a validly signed event and hands the PARSED event to fulfillment", async () => {
    const body = eventBody();
    await withApp(async (port) => {
      const res = await post(port, body, { "paddle-signature": sign(body) });
      expect(res.status).toBe(200);
    });

    expect(handleEvent).toHaveBeenCalledTimes(1);
    const event = handleEvent.mock.calls[0][0] as any;
    // The SDK's unmarshal turned snake_case wire format into an event entity.
    expect(event.eventId).toBe("evt_01test");
    expect(event.eventType).toBe("transaction.completed");
    expect(event.data.customData).toEqual({ userId: "user_1" });
    expect(rows.get("evt_01test")?.status).toBe("processed");
  });

  it("rejects a tampered body with 400 and never reaches fulfillment", async () => {
    const body = eventBody();
    const signature = sign(body);
    // Same length, same shape — only the beneficiary changed. If verification
    // were skipped this body would fulfil perfectly, which is the point.
    const tampered = body.replace('"userId":"user_1"', '"userId":"user_9"');
    expect(tampered).not.toBe(body);

    await withApp(async (port) => {
      const res = await post(port, tampered, { "paddle-signature": signature });
      expect(res.status).toBe(400);
    });

    expect(handleEvent).not.toHaveBeenCalled();
    expect(claimEvent).not.toHaveBeenCalled();
  });

  it("rejects a signature made with the wrong secret", async () => {
    const body = eventBody();
    await withApp(async (port) => {
      const res = await post(port, body, { "paddle-signature": sign(body, "wrong_secret") });
      expect(res.status).toBe(400);
    });
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("rejects a request with no paddle-signature header", async () => {
    const body = eventBody();
    await withApp(async (port) => {
      const res = await post(port, body, {});
      expect(res.status).toBe(400);
    });
    expect(handleEvent).not.toHaveBeenCalled();
  });

  it("does not reveal WHY it rejected", async () => {
    const body = eventBody();
    await withApp(async (port) => {
      const missing = await post(port, body, {});
      const wrong = await post(port, body, { "paddle-signature": sign(body, "wrong_secret") });
      expect(missing.body).toBe(wrong.body);
      expect(missing.body).not.toMatch(/signature|secret|hmac/i);
    });
  });
});

describe("paddle webhook — idempotency", () => {
  it("answers a duplicate event 200 WITHOUT re-running fulfillment", async () => {
    const body = eventBody();
    await withApp(async (port) => {
      const first = await post(port, body, { "paddle-signature": sign(body) });
      expect(first.status).toBe(200);

      const second = await post(port, body, { "paddle-signature": sign(body) });
      expect(second.status).toBe(200);
      expect(second.body).toContain("duplicate");
    });

    expect(claimEvent).toHaveBeenCalledTimes(2);
    expect(handleEvent).toHaveBeenCalledTimes(1);
  });

  it("re-runs fulfillment for an event whose previous attempt FAILED", async () => {
    const body = eventBody();
    rows.set("evt_01test", {
      id: "evt_01test",
      eventType: "transaction.completed",
      occurredAt: new Date(),
      status: "failed",
      error: "boom",
    });

    await withApp(async (port) => {
      const res = await post(port, body, { "paddle-signature": sign(body) });
      expect(res.status).toBe(200);
    });

    expect(reopenFailed).toHaveBeenCalledWith("evt_01test");
    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(rows.get("evt_01test")?.status).toBe("processed");
  });
});

describe("paddle webhook — outcomes", () => {
  it("records an ignored event and still answers 200 (so Paddle stops retrying)", async () => {
    handleEvent.mockImplementation(async () => ({
      status: "ignored",
      reason: "no customData.userId",
    }));

    const body = eventBody();
    await withApp(async (port) => {
      const res = await post(port, body, { "paddle-signature": sign(body) });
      expect(res.status).toBe(200);
    });

    expect(setStatus).toHaveBeenCalledWith("evt_01test", "ignored", "no customData.userId");
    expect(rows.get("evt_01test")?.status).toBe("ignored");
    // The fixture is a transaction.completed: money in, nothing fulfilled → alert.
    expect(notifyPaddleFulfillmentProblem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "unfulfilled", eventId: "evt_01test" }),
    );
  });

  it("does NOT alert when a non-payment event is ignored", async () => {
    notifyPaddleFulfillmentProblem.mockClear();
    handleEvent.mockImplementation(async () => ({
      status: "ignored",
      reason: "unhandled event type: address.created",
    }));

    const body = eventBody({ event_type: "address.created" });
    await withApp(async (port) => {
      const res = await post(port, body, { "paddle-signature": sign(body) });
      expect(res.status).toBe(200);
    });

    expect(notifyPaddleFulfillmentProblem).not.toHaveBeenCalled();
  });

  it("returns 500 and marks the row failed when fulfillment throws", async () => {
    handleEvent.mockImplementation(async () => {
      throw new Error("database is down");
    });

    const body = eventBody();
    await withApp(async (port) => {
      const res = await post(port, body, { "paddle-signature": sign(body) });
      expect(res.status).toBe(500);
    });

    expect(rows.get("evt_01test")?.status).toBe("failed");
    expect(rows.get("evt_01test")?.error).toContain("database is down");
    expect(notifyPaddleFulfillmentProblem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "failed", detail: "database is down" }),
    );
  });
});

describe("paddle webhook — raw body plumbing", () => {
  it("is refused, not silently unverified, if express.json consumed the body first", async () => {
    // The failure mode the shared helper exists to prevent: json parser first.
    const app = express();
    app.use(express.json());
    applyPaddleWebhookRawBody(app);
    app.post("/api/paddle/webhook", (req, res) => paddleController.handleWebhook(req, res));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    try {
      const body = eventBody();
      const res = await post(addr.port, body, { "paddle-signature": sign(body) });
      expect(res.status).toBe(400);
      expect(handleEvent).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
