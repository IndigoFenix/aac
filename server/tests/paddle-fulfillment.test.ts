/**
 * paddleFulfillmentService unit tests — DB-free.
 *
 * The service takes every repository through a `FulfillmentDeps` object, so
 * these drive the REAL fulfillment logic against in-memory fakes: no database,
 * no module mocking, and the fakes are the same interface production satisfies.
 *
 * The DB-backed counterpart (real repositories, real Postgres) lives in
 * server/tests/integration/paddle-fulfillment-db.test.ts.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  PaddleFulfillmentService,
  type FulfillmentDeps,
  type PaddleEventLike,
} from "../services/paddleFulfillmentService.js";
import type { CreditPackage, License, SubscriptionPlan } from "@shared/schema";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface CreditGrant {
  userId: string;
  amount: number;
  type: string;
  description: string;
  externalRef?: string;
}

function makePackage(over: Partial<CreditPackage> = {}): CreditPackage {
  return {
    id: "pkg_1",
    name: "Starter Pack",
    credits: 100,
    price: 9.99,
    bonusCredits: 20,
    isActive: true,
    sortOrder: 0,
    paddlePriceId: "pri_pack",
    createdAt: new Date(),
    ...over,
  } as CreditPackage;
}

function makePlan(over: Partial<SubscriptionPlan> = {}): SubscriptionPlan {
  return {
    id: "plan_1",
    name: "Premium Monthly",
    price: 29.99,
    credits: 500,
    duration: 30,
    isActive: true,
    features: null,
    paddlePriceId: "pri_plan",
    licenseType: "premium",
    permissions: { maxStudents: 5 } as SubscriptionPlan["permissions"],
    createdAt: new Date(),
    ...over,
  } as SubscriptionPlan;
}

function makeLicense(over: Partial<License> = {}): License {
  return {
    id: "lic_1",
    userId: "user_1",
    instituteId: null,
    licenseType: "standard",
    isActive: true,
    permissions: null,
    paddleCustomerId: null,
    paddleSubscriptionId: null,
    subscriptionExpiresAt: null,
    ...over,
  } as License;
}

interface Harness {
  service: PaddleFulfillmentService;
  grants: CreditGrant[];
  licenseUpdates: { id: string; updates: Record<string, unknown> }[];
  licenses: Map<string, License>;
  setLastProcessed(subscriptionId: string, when: Date | null): void;
}

function harness(opts: {
  packages?: CreditPackage[];
  plans?: SubscriptionPlan[];
  licenses?: License[];
  institutes?: { id: string }[];
} = {}): Harness {
  const grants: CreditGrant[] = [];
  const licenseUpdates: { id: string; updates: Record<string, unknown> }[] = [];
  const licenses = new Map<string, License>((opts.licenses ?? []).map((l) => [l.id, l]));
  const lastProcessed = new Map<string, Date>();

  const deps: FulfillmentDeps = {
    credits: {
      async addCredits(userId, amount, type, description, externalRef) {
        grants.push({ userId, amount, type, description, externalRef });
      },
    },
    creditPackages: {
      async getCreditPackageByPaddlePriceId(priceId) {
        return (opts.packages ?? []).find((p) => p.paddlePriceId === priceId);
      },
    },
    plans: {
      async getSubscriptionPlanByPaddlePriceId(priceId) {
        return (opts.plans ?? []).find((p) => p.paddlePriceId === priceId);
      },
    },
    licenses: {
      async getLicenseById(id) {
        return licenses.get(id);
      },
      async getLicenseByUserId(userId) {
        return Array.from(licenses.values()).find((l) => l.userId === userId);
      },
      async getLicensesByInstituteId(instituteId) {
        return Array.from(licenses.values()).filter((l) => l.instituteId === instituteId);
      },
      async updateLicense(id, updates) {
        licenseUpdates.push({ id, updates });
        const current = licenses.get(id);
        if (!current) return undefined;
        const next = { ...current, ...updates } as License;
        licenses.set(id, next);
        return next;
      },
    },
    institutes: {
      async getInstitutesByUserId() {
        return opts.institutes ?? [];
      },
    },
    events: {
      async lastProcessedOccurredAtForSubscription(subscriptionId) {
        return lastProcessed.get(subscriptionId) ?? null;
      },
    },
  };

  return {
    service: new PaddleFulfillmentService(deps),
    grants,
    licenseUpdates,
    licenses,
    setLastProcessed(subscriptionId, when) {
      if (when) lastProcessed.set(subscriptionId, when);
      else lastProcessed.delete(subscriptionId);
    },
  };
}

function txnEvent(over: Record<string, unknown> = {}): PaddleEventLike {
  return {
    eventId: "evt_txn_1",
    eventType: "transaction.completed",
    occurredAt: "2026-09-01T10:00:00.000Z",
    data: {
      id: "txn_abc",
      customerId: "ctm_1",
      customData: { userId: "user_1" },
      items: [{ price: { id: "pri_pack" }, quantity: 1 }],
      ...over,
    },
  };
}

function subEvent(
  eventType: string,
  over: Record<string, unknown> = {},
  occurredAt = "2026-09-01T10:00:00.000Z",
): PaddleEventLike {
  return {
    eventId: `evt_${eventType}_1`,
    eventType,
    occurredAt,
    data: {
      id: "sub_abc",
      customerId: "ctm_1",
      customData: { userId: "user_1" },
      items: [{ price: { id: "pri_plan" }, quantity: 1 }],
      currentBillingPeriod: {
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-10-01T00:00:00.000Z",
      },
      ...over,
    },
  };
}

// ---------------------------------------------------------------------------

describe("paddleFulfillment — one-time credit packages", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness({ packages: [makePackage()], plans: [makePlan()] });
  });

  it("grants credits + bonus to the user named in customData, with the transaction id as the reference", async () => {
    const outcome = await h.service.handleEvent(txnEvent());

    expect(outcome.status).toBe("processed");
    expect(h.grants).toHaveLength(1);
    expect(h.grants[0]).toMatchObject({
      userId: "user_1",
      amount: 120, // 100 credits + 20 bonus
      type: "purchase",
      externalRef: "txn_abc",
    });
    expect(h.grants[0].description).toContain("Starter Pack");
  });

  it("ignores a transaction with no customData.userId rather than failing", async () => {
    const outcome = await h.service.handleEvent(txnEvent({ customData: null }));

    expect(outcome).toEqual({
      status: "ignored",
      reason: expect.stringContaining("customData.userId"),
    });
    expect(h.grants).toHaveLength(0);
  });

  it("ignores an unknown price id, naming it in the reason, and grants nothing", async () => {
    const outcome = await h.service.handleEvent(
      txnEvent({ items: [{ price: { id: "pri_not_ours" }, quantity: 1 }] }),
    );

    expect(outcome.status).toBe("ignored");
    expect(outcome.status === "ignored" && outcome.reason).toContain("pri_not_ours");
    expect(h.grants).toHaveLength(0);
  });

  it("does not double-fulfil a subscription's first payment (the plan price is left to subscription.*)", async () => {
    const outcome = await h.service.handleEvent(
      txnEvent({ items: [{ price: { id: "pri_plan" }, quantity: 1 }] }),
    );

    expect(outcome.status).toBe("ignored");
    expect(h.grants).toHaveLength(0);
  });
});

describe("paddleFulfillment — subscriptions", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness({
      packages: [makePackage()],
      plans: [makePlan()],
      licenses: [makeLicense()],
    });
  });

  it("sets the license fields from the plan on activation and grants the period's credits", async () => {
    const outcome = await h.service.handleEvent(subEvent("subscription.activated"));

    expect(outcome.status).toBe("processed");
    expect(h.licenseUpdates).toHaveLength(1);
    const { id, updates } = h.licenseUpdates[0];
    expect(id).toBe("lic_1");
    expect(updates).toMatchObject({
      paddleCustomerId: "ctm_1",
      paddleSubscriptionId: "sub_abc",
      isActive: true,
      licenseType: "premium",
      permissions: { maxStudents: 5 },
    });
    expect((updates.subscriptionExpiresAt as Date).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );

    expect(h.grants).toHaveLength(1);
    expect(h.grants[0]).toMatchObject({
      userId: "user_1",
      amount: 500,
      externalRef: "sub_abc",
    });
  });

  it("skips a stale event that occurred before one already applied", async () => {
    h.setLastProcessed("sub_abc", new Date("2026-09-05T00:00:00.000Z"));

    const outcome = await h.service.handleEvent(
      subEvent("subscription.updated", {}, "2026-09-02T00:00:00.000Z"),
    );

    expect(outcome.status).toBe("ignored");
    expect(outcome.status === "ignored" && outcome.reason).toContain("stale");
    expect(h.licenseUpdates).toHaveLength(0);
    expect(h.grants).toHaveLength(0);
  });

  it("applies an event that is newer than the last processed one", async () => {
    h.setLastProcessed("sub_abc", new Date("2026-09-01T00:00:00.000Z"));

    const outcome = await h.service.handleEvent(
      subEvent("subscription.updated", {}, "2026-09-02T00:00:00.000Z"),
    );

    expect(outcome.status).toBe("processed");
    expect(h.licenseUpdates).toHaveLength(1);
  });

  it("on cancellation moves the expiry to the scheduled effective date and NEVER clears isActive", async () => {
    const outcome = await h.service.handleEvent(
      subEvent("subscription.canceled", {
        scheduledChange: { action: "cancel", effectiveAt: "2026-10-15T00:00:00.000Z" },
      }),
    );

    expect(outcome.status).toBe("processed");
    const { updates } = h.licenseUpdates[0];
    expect((updates.subscriptionExpiresAt as Date).toISOString()).toBe(
      "2026-10-15T00:00:00.000Z",
    );
    expect(updates).not.toHaveProperty("isActive");
    expect(h.licenses.get("lic_1")!.isActive).toBe(true);
    // Cancellation is not a new billing period — no credits.
    expect(h.grants).toHaveLength(0);
  });

  it("past_due and paused make the timestamp truthful without deactivating or granting", async () => {
    for (const type of ["subscription.past_due", "subscription.paused"]) {
      const fresh = harness({ plans: [makePlan()], licenses: [makeLicense()] });
      const outcome = await fresh.service.handleEvent(subEvent(type));
      expect(outcome.status).toBe("processed");
      expect(fresh.licenseUpdates[0].updates).not.toHaveProperty("isActive");
      expect(fresh.grants).toHaveLength(0);
    }
  });

  it("falls back to the plan duration when Paddle sends no billing period", async () => {
    const outcome = await h.service.handleEvent(
      subEvent("subscription.activated", { currentBillingPeriod: null }),
    );

    expect(outcome.status).toBe("processed");
    const expires = h.licenseUpdates[0].updates.subscriptionExpiresAt as Date;
    // occurredAt 2026-09-01T10:00 + 30 days
    expect(expires.toISOString()).toBe("2026-10-01T10:00:00.000Z");
  });

  it("ignores a subscription whose price matches no plan", async () => {
    const outcome = await h.service.handleEvent(
      subEvent("subscription.activated", {
        items: [{ price: { id: "pri_unknown" }, quantity: 1 }],
      }),
    );

    expect(outcome.status).toBe("ignored");
    expect(outcome.status === "ignored" && outcome.reason).toContain("pri_unknown");
    expect(h.licenseUpdates).toHaveLength(0);
  });

  it("ignores when the user has no license anywhere", async () => {
    const empty = harness({ plans: [makePlan()] });
    const outcome = await empty.service.handleEvent(subEvent("subscription.activated"));

    expect(outcome.status).toBe("ignored");
    expect(outcome.status === "ignored" && outcome.reason).toContain("no license");
  });

  it("prefers an explicit customData.licenseId over the user's own license", async () => {
    const multi = harness({
      plans: [makePlan()],
      licenses: [makeLicense(), makeLicense({ id: "lic_2", userId: null, instituteId: "inst_1" })],
    });

    const outcome = await multi.service.handleEvent(
      subEvent("subscription.activated", {
        customData: { userId: "user_1", licenseId: "lic_2" },
      }),
    );

    expect(outcome.status).toBe("processed");
    expect(multi.licenseUpdates[0].id).toBe("lic_2");
  });

  it("falls back to an institute license when the user holds none directly", async () => {
    const viaInstitute = harness({
      plans: [makePlan()],
      licenses: [makeLicense({ id: "lic_inst", userId: null, instituteId: "inst_1" })],
      institutes: [{ id: "inst_1" }],
    });

    const outcome = await viaInstitute.service.handleEvent(subEvent("subscription.activated"));

    expect(outcome.status).toBe("processed");
    expect(viaInstitute.licenseUpdates[0].id).toBe("lic_inst");
  });

  it("leaves the tier alone when the plan defines neither licenseType nor permissions", async () => {
    const bare = harness({
      plans: [makePlan({ licenseType: null, permissions: null })],
      licenses: [makeLicense()],
    });

    await bare.service.handleEvent(subEvent("subscription.activated"));

    const { updates } = bare.licenseUpdates[0];
    expect(updates).not.toHaveProperty("licenseType");
    expect(updates).not.toHaveProperty("permissions");
  });
});

describe("paddleFulfillment — unhandled events", () => {
  it("ignores an event type we do not act on", async () => {
    const h = harness();
    const outcome = await h.service.handleEvent({
      eventId: "evt_x",
      eventType: "customer.updated",
      occurredAt: "2026-09-01T10:00:00.000Z",
      data: {},
    });
    expect(outcome).toEqual({
      status: "ignored",
      reason: expect.stringContaining("customer.updated"),
    });
  });
});
