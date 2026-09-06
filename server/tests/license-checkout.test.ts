/**
 * POST /api/licenses/:id/checkout — authorisation and the refusal branches.
 *
 * DB-free. What is real and what is faked:
 *
 *  • The controller AND licenseService.createCheckout are REAL — the rules
 *    under test (who may pay, and which license states are buyable) live one in
 *    each, and testing them apart would leave the seam between them untested.
 *
 *  • The repositories and paddleService are FAKED via `unstable_mockModule`,
 *    which is the only mocking that works here: a plain `jest.mock` is INERT
 *    under this repo's ESM jest, and an inert mock of paddleService means a
 *    unit test firing real HTTP at Paddle.
 */

import { describe, it, expect, jest, beforeEach, beforeAll } from "@jest/globals";
import type { License } from "@shared/schema";

// ---------------------------------------------------------------------------
// Fakes — installed BEFORE the controller graph is imported.
// ---------------------------------------------------------------------------

const licenses = new Map<string, License>();
const licenseUpdates: { id: string; updates: Record<string, unknown> }[] = [];
const instituteAdmins = new Map<string, Set<string>>(); // instituteId -> userIds

const createLicenseTransaction = jest.fn<any>(async () => "txn_created_1");
const isConfigured = jest.fn<any>(() => true);

jest.unstable_mockModule("../repositories/index.js", () => ({
  licenseRepository: {
    getLicenseById: async (id: string) => licenses.get(id),
    updateLicense: async (id: string, updates: Record<string, unknown>) => {
      licenseUpdates.push({ id, updates });
      const current = licenses.get(id);
      if (!current) return undefined;
      const next = { ...current, ...updates } as License;
      licenses.set(id, next);
      return next;
    },
  },
  instituteRepository: {
    isUserAdminOfInstitute: async (instituteId: string, userId: string) =>
      instituteAdmins.get(instituteId)?.has(userId) ?? false,
  },
  studentRepository: {},
}));

jest.unstable_mockModule("../services/paddleService.js", () => ({
  paddleService: { isConfigured, createLicenseTransaction },
}));

jest.unstable_mockModule("../services/emailService.js", () => ({
  emailService: { sendLicenseInvite: async () => ({ success: true }) },
}));

jest.unstable_mockModule("../services/studentService.js", () => ({
  studentService: {},
}));

jest.unstable_mockModule("../services/activityLogService.js", () => ({
  activityLogService: { log: () => {} },
}));

let licenseController: typeof import("../controllers/licenseController.js").licenseController;

beforeAll(async () => {
  ({ licenseController } = await import("../controllers/licenseController.js"));
});

// ---------------------------------------------------------------------------

function makeLicense(over: Partial<License> = {}): License {
  return {
    id: "lic_1",
    userId: "user_owner",
    instituteId: "inst_1",
    name: "Beit Issie Shapiro",
    licenseType: "standard",
    subscriptionType: "yearly",
    isActive: true,
    isTrial: true,
    trialExpiresAt: null,
    subscriptionExpiresAt: null,
    priceAmount: 120000,
    priceCurrency: "ILS",
    paddleCustomerId: null,
    paddleSubscriptionId: null,
    paddleTransactionId: null,
    permissions: null,
    ...over,
  } as License;
}

interface Reply {
  status: number;
  body: any;
}

async function checkout(licenseId: string, user: any): Promise<Reply> {
  const reply: Reply = { status: 200, body: undefined };
  const res: any = {
    status(code: number) {
      reply.status = code;
      return res;
    },
    json(body: any) {
      reply.body = body;
      return res;
    },
  };
  await licenseController.createCheckout({ params: { id: licenseId }, user } as any, res);
  return reply;
}

beforeEach(() => {
  licenses.clear();
  licenseUpdates.length = 0;
  instituteAdmins.clear();
  createLicenseTransaction.mockClear();
  isConfigured.mockReturnValue(true);
});

describe("POST /api/licenses/:id/checkout — authorisation", () => {
  beforeEach(() => {
    licenses.set("lic_1", makeLicense());
    instituteAdmins.set("inst_1", new Set(["user_admin"]));
  });

  it("lets the license's own user pay", async () => {
    const reply = await checkout("lic_1", { id: "user_owner" });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ transactionId: "txn_created_1" });
  });

  it("lets an admin of the license's institute pay", async () => {
    const reply = await checkout("lic_1", { id: "user_admin" });
    expect(reply.status).toBe(200);
  });

  it("lets a system admin pay", async () => {
    const reply = await checkout("lic_1", { id: "admin_1", isSystemAdmin: true });
    expect(reply.status).toBe(200);
  });

  it("refuses a plain member of the institute with 403", async () => {
    const reply = await checkout("lic_1", { id: "user_member" });
    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe("FORBIDDEN");
    expect(createLicenseTransaction).not.toHaveBeenCalled();
  });

  it("404s an unknown license before asking anything about the caller", async () => {
    const reply = await checkout("lic_nope", { id: "user_owner" });
    expect(reply.status).toBe(404);
  });
});

describe("POST /api/licenses/:id/checkout — what may be bought", () => {
  const owner = { id: "user_owner" };

  it("records the transaction id on the license and returns it", async () => {
    licenses.set("lic_1", makeLicense());

    const reply = await checkout("lic_1", owner);

    expect(reply.body).toEqual({ transactionId: "txn_created_1" });
    expect(licenseUpdates).toEqual([
      { id: "lic_1", updates: { paddleTransactionId: "txn_created_1" } },
    ]);
    expect(createLicenseTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        licenseId: "lic_1",
        priceAmount: 120000,
        priceCurrency: "ILS",
        subscriptionType: "yearly",
      }),
    );
  });

  it("409s LICENSE_NOT_PURCHASABLE when no price is quoted (invoice-paid customer)", async () => {
    licenses.set("lic_1", makeLicense({ priceAmount: null }));

    const reply = await checkout("lic_1", owner);

    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("LICENSE_NOT_PURCHASABLE");
    expect(createLicenseTransaction).not.toHaveBeenCalled();
  });

  it("409s LICENSE_NOT_PURCHASABLE for a price of zero", async () => {
    licenses.set("lic_1", makeLicense({ priceAmount: 0 }));
    expect((await checkout("lic_1", owner)).body.error).toBe("LICENSE_NOT_PURCHASABLE");
  });

  it("409s LICENSE_NOT_PURCHASABLE for a deactivated license", async () => {
    licenses.set("lic_1", makeLicense({ isActive: false }));
    expect((await checkout("lic_1", owner)).body.error).toBe("LICENSE_NOT_PURCHASABLE");
  });

  it("409s LICENSE_ALREADY_PAID when the paid period has not run out", async () => {
    licenses.set(
      "lic_1",
      makeLicense({
        isTrial: false,
        subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }),
    );

    const reply = await checkout("lic_1", owner);

    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("LICENSE_ALREADY_PAID");
  });

  it("allows re-purchase once the paid period has lapsed", async () => {
    licenses.set(
      "lic_1",
      makeLicense({
        isTrial: false,
        subscriptionExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      }),
    );

    expect((await checkout("lic_1", owner)).status).toBe(200);
  });

  it("503s PADDLE_NOT_CONFIGURED rather than throwing when no API key is set", async () => {
    licenses.set("lic_1", makeLicense());
    isConfigured.mockReturnValue(false);

    const reply = await checkout("lic_1", owner);

    expect(reply.status).toBe(503);
    expect(reply.body.error).toBe("PADDLE_NOT_CONFIGURED");
    expect(createLicenseTransaction).not.toHaveBeenCalled();
  });
});
