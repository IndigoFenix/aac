/**
 * Live Paddle sandbox smoke test.
 *
 * Hits the real Paddle sandbox API using PADDLE_API_KEY_SANDBOX to prove the
 * server-side integration works end to end:
 *   1. connectivity (list products)
 *   2. create a product
 *   3. create a one-time price for it
 *   4. create a customer
 *   5. create a transaction for that price + customer
 *   6. read the transaction back
 *
 * This talks to the network and creates real sandbox objects, so it is NOT part
 * of `npm test`. Run it manually:
 *
 *   npx tsx scripts/test-paddle-sandbox.ts
 */
import dotenv from "dotenv";

dotenv.config();

import { paddleService } from "../server/services/paddleService";

function log(step: string, detail?: unknown) {
  // eslint-disable-next-line no-console
  console.log(`\n▶ ${step}`);
  if (detail !== undefined) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(detail, null, 2));
  }
}

async function main() {
  log(`Environment: ${paddleService.environment}`);

  if (!paddleService.isConfigured()) {
    throw new Error(
      "No Paddle API key configured. Set PADDLE_API_KEY_SANDBOX in .env.",
    );
  }

  // 1. Connectivity — list existing products.
  const existing = await paddleService.listProducts();
  log(`Connectivity OK — ${existing.length} existing product(s) found`);

  // A unique-ish suffix so reruns don't collide. (Date.now avoided per repo
  // conventions in scripts is fine here — this is a manual script, not a
  // workflow — but we use a high-res-ish counter to keep it deterministic.)
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

  // 2. Create a product.
  const product = await paddleService.createProduct({
    name: `Aivota Sandbox Test Product ${stamp}`,
    taxCategory: "standard",
  });
  log(`Created product ${product.id}`, { id: product.id, name: product.name });

  // 3. Create a one-time price ($9.99 USD).
  const price = await paddleService.createPrice({
    description: "Aivota Sandbox Test — one-time $9.99",
    productId: product.id,
    unitPrice: { amount: "999", currencyCode: "USD" },
    taxMode: "account_setting",
    quantity: { minimum: 1, maximum: 1 },
  });
  log(`Created price ${price.id}`, {
    id: price.id,
    unitPrice: price.unitPrice,
  });

  // 4. Create a customer.
  const customer = await paddleService.createCustomer({
    email: `sandbox-test-${stamp}@aivota.ai`,
    name: "Sandbox Test Customer",
  });
  log(`Created customer ${customer.id}`, {
    id: customer.id,
    email: customer.email,
  });

  // 5. Create a transaction.
  const transaction = await paddleService.createTransaction({
    items: [{ priceId: price.id, quantity: 1 }],
    customerId: customer.id,
  });
  log(`Created transaction ${transaction.id}`, {
    id: transaction.id,
    status: transaction.status,
    total: transaction.details?.totals?.grandTotal,
    currency: transaction.currencyCode,
    checkoutUrl: transaction.checkout?.url ?? null,
  });

  // 6. Read it back.
  const fetched = await paddleService.getTransaction(transaction.id);
  log(`Re-fetched transaction ${fetched.id} — status: ${fetched.status}`);

  log("✅ Paddle sandbox smoke test passed.");
  // eslint-disable-next-line no-console
  console.log(
    `\nReusable test priceId for the future client checkout: ${price.id}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("\n❌ Paddle sandbox smoke test failed:");
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
