import {
  Environment,
  Paddle,
  type CreateProductRequestBody,
  type CreatePriceRequestBody,
  type CreateCustomerRequestBody,
  type CreateTransactionRequestBody,
  type CurrencyCode,
  type TaxCategory,
} from "@paddle/paddle-node-sdk";

/** The one product every individually-quoted license checkout hangs off. */
const LICENSE_PRODUCT_NAME = "Aivota License";
/** Software-as-a-service; the closest Paddle tax category to what we sell. */
const LICENSE_TAX_CATEGORY: TaxCategory = "saas";

/**
 * Thin wrapper around the Paddle Node SDK.
 *
 * Paddle keeps sandbox and live accounts fully separate, each with its own API
 * key. We default to the sandbox while we build out payments; flip
 * PADDLE_ENVIRONMENT=production (and supply PADDLE_API_KEY) to go live.
 *
 * Env vars:
 *   PADDLE_ENVIRONMENT        "sandbox" (default) | "production"
 *   PADDLE_API_KEY_SANDBOX    server-side API key for the sandbox account
 *   PADDLE_API_KEY            server-side API key for the live account
 *   PADDLE_WEBHOOK_SECRET     webhook signing secret (for verifyWebhook)
 *
 * Note: the browser checkout (paddle-js) needs a *client-side token*, which is
 * a different credential from the server API key and lives on the client.
 */

class PaddleService {
  private client: Paddle | null = null;
  private licenseProductId: string | null = null;

  /**
   * Active environment, read lazily so it reflects env vars loaded after this
   * module is imported (e.g. dotenv.config() in scripts).
   */
  get environment(): Environment {
    return process.env.PADDLE_ENVIRONMENT === "production"
      ? Environment.production
      : Environment.sandbox;
  }

  private get apiKey(): string | undefined {
    return this.environment === Environment.production
      ? process.env.PADDLE_API_KEY
      : process.env.PADDLE_API_KEY_SANDBOX;
  }

  /**
   * Public client-side token for paddle-js (safe to expose to the browser).
   * Distinct from the server API key. Read lazily like the rest.
   */
  get clientToken(): string | undefined {
    return this.environment === Environment.production
      ? process.env.PADDLE_CLIENT_TOKEN
      : process.env.PADDLE_CLIENT_TOKEN_TEST;
  }

  /** True when an API key is configured for the active environment. */
  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Lazily-initialised SDK client. Throws if no key is configured. */
  private get paddle(): Paddle {
    if (!this.client) {
      const env = this.environment;
      const key = this.apiKey;
      if (!key) {
        throw new Error(
          `Paddle API key not configured for environment "${env}". ` +
            `Set ${env === Environment.production ? "PADDLE_API_KEY" : "PADDLE_API_KEY_SANDBOX"}.`,
        );
      }
      this.client = new Paddle(key, { environment: env });
    }
    return this.client;
  }

  // ---- Products & prices -------------------------------------------------

  async listProducts() {
    const collection = this.paddle.products.list();
    return collection.next();
  }

  async createProduct(body: CreateProductRequestBody) {
    return this.paddle.products.create(body);
  }

  async listPrices() {
    const collection = this.paddle.prices.list();
    return collection.next();
  }

  async createPrice(body: CreatePriceRequestBody) {
    return this.paddle.prices.create(body);
  }

  /**
   * The single Paddle product every per-license checkout hangs off.
   *
   * A non-catalog price still needs a product, and minting one per checkout
   * would litter the catalog with a product per customer per renewal. One
   * shared product with the price supplied inline is the shape Paddle
   * documents for individually-quoted deals.
   *
   * Memoised per process, and looked up by NAME before creating: a redeploy
   * must not create a second "Aivota License".
   */
  async ensureLicenseProduct(): Promise<string> {
    if (this.licenseProductId) return this.licenseProductId;

    const collection = this.paddle.products.list({ status: ["active"] });
    let page = await collection.next();
    while (page.length > 0) {
      const found = page.find((p) => p.name === LICENSE_PRODUCT_NAME);
      if (found) {
        this.licenseProductId = found.id;
        return found.id;
      }
      if (!collection.hasMore) break;
      page = await collection.next();
    }

    const created = await this.paddle.products.create({
      name: LICENSE_PRODUCT_NAME,
      taxCategory: LICENSE_TAX_CATEGORY,
      description: "Aivota platform license, priced per organisation.",
    });
    this.licenseProductId = created.id;
    return created.id;
  }

  /**
   * Create a checkout transaction for ONE license at its quoted price.
   *
   * The price is passed INLINE (`items[0].price`, no `priceId`) — Paddle's
   * non-catalog price shape, verified against
   * `types/price/non-catalog-price-request.d.ts` and
   * `types/transaction/transaction-item.d.ts` in the SDK. `billingCycle` turns
   * the transaction into a subscription: Paddle creates the subscription on
   * payment and thereafter sends us subscription.* events for it.
   *
   * Returns the transaction id; the browser opens it with
   * `Paddle.Checkout.open({ transactionId })`.
   */
  async createLicenseTransaction(input: {
    licenseId: string;
    userId: string | null;
    name: string;
    priceAmount: number;
    priceCurrency: string;
    subscriptionType: "monthly" | "yearly";
    paddleCustomerId: string | null;
  }): Promise<string> {
    const productId = await this.ensureLicenseProduct();
    const currencyCode = input.priceCurrency.toUpperCase() as CurrencyCode;

    const body: CreateTransactionRequestBody = {
      items: [
        {
          quantity: 1,
          price: {
            name: input.name.slice(0, 200),
            description: `Aivota license — ${input.name} (${input.subscriptionType})`.slice(0, 200),
            productId,
            unitPrice: { amount: String(input.priceAmount), currencyCode },
            billingCycle: {
              interval: input.subscriptionType === "yearly" ? "year" : "month",
              frequency: 1,
            },
            taxMode: "account_setting",
            quantity: { minimum: 1, maximum: 1 },
          },
        },
      ],
      customData: {
        licenseId: input.licenseId,
        ...(input.userId ? { userId: input.userId } : {}),
      },
      ...(input.paddleCustomerId ? { customerId: input.paddleCustomerId } : {}),
    };

    const transaction = await this.paddle.transactions.create(body);
    return transaction.id;
  }

  /** Test seam: forget the memoised license product. */
  resetLicenseProduct(): void {
    this.licenseProductId = null;
  }

  // ---- Customers ---------------------------------------------------------

  async createCustomer(body: CreateCustomerRequestBody) {
    return this.paddle.customers.create(body);
  }

  // ---- Transactions ------------------------------------------------------

  async createTransaction(body: CreateTransactionRequestBody) {
    return this.paddle.transactions.create(body);
  }

  async getTransaction(id: string) {
    return this.paddle.transactions.get(id);
  }

  async listTransactions() {
    const collection = this.paddle.transactions.list();
    return collection.next();
  }

  // ---- Webhooks ----------------------------------------------------------

  /**
   * Verify and parse a webhook payload. Pass the *raw* request body string and
   * the `paddle-signature` header. Returns the parsed event, or throws if the
   * signature is invalid.
   */
  async verifyWebhook(rawBody: string, signature: string) {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error("PADDLE_WEBHOOK_SECRET not configured");
    }
    return this.paddle.webhooks.unmarshal(rawBody, secret, signature);
  }
}

export const paddleService = new PaddleService();
