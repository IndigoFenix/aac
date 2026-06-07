/**
 * paddleService unit tests (mocked SDK, no network).
 *
 * The live sandbox flow is exercised separately by
 * `scripts/test-paddle-sandbox.ts`, which hits the real Paddle sandbox API and
 * is therefore NOT part of `npm test`. These tests verify our wiring around the
 * SDK: environment/key selection, the lazy client, and that each method
 * delegates to the right SDK call with the right arguments.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
  afterEach,
} from "@jest/globals";

const productsCreate = jest.fn<any>();
const productsList = jest.fn<any>();
const pricesCreate = jest.fn<any>();
const customersCreate = jest.fn<any>();
const transactionsCreate = jest.fn<any>();
const transactionsGet = jest.fn<any>();
const webhooksUnmarshal = jest.fn<any>();

const paddleCtor = jest.fn<any>();

jest.unstable_mockModule("@paddle/paddle-node-sdk", () => ({
  Environment: { sandbox: "sandbox", production: "production" },
  Paddle: class {
    products = { create: productsCreate, list: productsList };
    prices = { create: pricesCreate, list: jest.fn() };
    customers = { create: customersCreate };
    transactions = { create: transactionsCreate, get: transactionsGet, list: jest.fn() };
    webhooks = { unmarshal: webhooksUnmarshal };
    constructor(key: string, opts: unknown) {
      paddleCtor(key, opts);
    }
  },
}));

let paddleService: typeof import("../services/paddleService.js").paddleService;

const ORIGINAL_ENV = { ...process.env };

beforeAll(async () => {
  ({ paddleService } = await import("../services/paddleService.js"));
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PADDLE_ENVIRONMENT = "sandbox";
  process.env.PADDLE_API_KEY_SANDBOX = "pdl_sdbx_test_key";
  delete process.env.PADDLE_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("paddleService configuration", () => {
  it("reports configured when the sandbox key is present", () => {
    expect(paddleService.environment).toBe("sandbox");
    expect(paddleService.isConfigured()).toBe(true);
  });

  it("reports not configured when the active env has no key", () => {
    delete process.env.PADDLE_API_KEY_SANDBOX;
    expect(paddleService.isConfigured()).toBe(false);
  });

  it("selects the production key when PADDLE_ENVIRONMENT=production", () => {
    process.env.PADDLE_ENVIRONMENT = "production";
    delete process.env.PADDLE_API_KEY_SANDBOX;
    expect(paddleService.environment).toBe("production");
    expect(paddleService.isConfigured()).toBe(false);

    process.env.PADDLE_API_KEY = "pdl_live_test_key";
    expect(paddleService.isConfigured()).toBe(true);
  });
});

describe("paddleService delegation", () => {
  it("creates a product via the SDK", async () => {
    productsCreate.mockResolvedValue({ id: "pro_1" });
    const body = { name: "P", taxCategory: "standard" as const };
    const result = await paddleService.createProduct(body);
    expect(productsCreate).toHaveBeenCalledWith(body);
    expect(result).toEqual({ id: "pro_1" });
  });

  it("creates a price via the SDK", async () => {
    pricesCreate.mockResolvedValue({ id: "pri_1" });
    const body = {
      description: "D",
      productId: "pro_1",
      unitPrice: { amount: "999", currencyCode: "USD" as const },
    };
    await paddleService.createPrice(body);
    expect(pricesCreate).toHaveBeenCalledWith(body);
  });

  it("creates a customer via the SDK", async () => {
    customersCreate.mockResolvedValue({ id: "ctm_1" });
    await paddleService.createCustomer({ email: "a@b.co" });
    expect(customersCreate).toHaveBeenCalledWith({ email: "a@b.co" });
  });

  it("creates and fetches a transaction via the SDK", async () => {
    transactionsCreate.mockResolvedValue({ id: "txn_1", status: "draft" });
    transactionsGet.mockResolvedValue({ id: "txn_1", status: "draft" });
    const body = { items: [{ priceId: "pri_1", quantity: 1 }], customerId: "ctm_1" };
    const created = await paddleService.createTransaction(body);
    expect(transactionsCreate).toHaveBeenCalledWith(body);
    expect(created.id).toBe("txn_1");

    await paddleService.getTransaction("txn_1");
    expect(transactionsGet).toHaveBeenCalledWith("txn_1");
  });

  it("lists products through the collection's next()", async () => {
    productsList.mockReturnValue({ next: async () => [{ id: "pro_1" }] });
    const list = await paddleService.listProducts();
    expect(list).toEqual([{ id: "pro_1" }]);
  });
});

describe("paddleService webhook verification", () => {
  it("throws when no webhook secret is configured", async () => {
    delete process.env.PADDLE_WEBHOOK_SECRET;
    await expect(
      paddleService.verifyWebhook("{}", "sig"),
    ).rejects.toThrow("PADDLE_WEBHOOK_SECRET");
  });

  it("unmarshals with the configured secret", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = "whsec_test";
    webhooksUnmarshal.mockResolvedValue({ eventType: "transaction.completed" });
    const event = await paddleService.verifyWebhook("{raw}", "sig123");
    expect(webhooksUnmarshal).toHaveBeenCalledWith("{raw}", "whsec_test", "sig123");
    expect(event).toEqual({ eventType: "transaction.completed" });
  });
});
