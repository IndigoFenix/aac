import {
  Environment,
  Paddle,
  type CreateProductRequestBody,
  type CreatePriceRequestBody,
  type CreateCustomerRequestBody,
  type CreateTransactionRequestBody,
} from "@paddle/paddle-node-sdk";

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
