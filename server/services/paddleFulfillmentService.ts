/**
 * paddleFulfillmentService — what a verified Paddle webhook event actually DOES
 * to our data.
 *
 * Split out of the controller on purpose. The controller owns HTTP concerns
 * (signature, status codes, the `paddle_events` idempotency row); this file
 * owns the money: which user gets credits, which license gets extended. It is
 * pure with respect to I/O — every repository it touches arrives through
 * {@link FulfillmentDeps}, so the unit tests drive real logic against fakes
 * without a database and without `unstable_mockModule` gymnastics.
 *
 * Three laws worth stating, because each was a decision rather than an
 * accident:
 *
 *  1. AN EVENT WE CANNOT ACT ON IS `ignored`, NOT AN ERROR. Paddle retries a
 *     non-2xx until it gives up. An event for a price id we do not sell, or a
 *     checkout with no `userId` in customData, will never become fulfillable no
 *     matter how many times it is redelivered — so it terminates with a reason
 *     recorded and an HTTP 200. Only a genuine fault (the DB is down) throws,
 *     and only that earns a retry.
 *
 *  2. `isActive` IS NEVER TURNED OFF HERE. Cancel / past-due / pause make the
 *     TIMESTAMPS truthful (`subscriptionExpiresAt` moves to the end of the paid
 *     period) and nothing else. Enforcing expiry is a separate, later change in
 *     licenseService; doing half of it here would cut off a paying customer at
 *     the moment they hit a card decline rather than at the end of the period
 *     they already paid for.
 *
 *  3. SUBSCRIPTION STATE IS ORDER-GUARDED. Paddle does not promise delivery
 *     order. Before applying a subscription event we ask `paddle_events` for
 *     the newest already-PROCESSED event for the same subscription id; an event
 *     that is not strictly newer is ignored as stale. One-time transactions are
 *     exempt — each is its own fact, and the event-id primary key already stops
 *     a replay.
 *
 *  4. A PER-LICENSE PURCHASE IS RECOGNISED BY IDENTITY, NOT BY PRICE.
 *     Organisations are quoted individually and bought with a NON-CATALOG
 *     price, so there is no price id to look up — `customData.licenseId` (which
 *     we attach when we create the transaction) and, for later renewals,
 *     `licenses.paddle_subscription_id` are the whole recognition. That path
 *     runs BEFORE the catalog lookup on a transaction, and INSTEAD of it on a
 *     subscription whose price matches no plan. It grants no credits: credits
 *     are a separate product.
 */

import type { CreditPackage, License, SubscriptionPlan } from "@shared/schema";
import type { LicensePermissions } from "@shared/license-permissions";
import { paddleLog } from "./paddle-debug-log";

// ---------------------------------------------------------------------------
// The shape of a Paddle event, as much of it as we use.
// ---------------------------------------------------------------------------

/**
 * Structural, NOT the SDK's `EventEntity` class.
 *
 * The SDK's notification entities are classes with ~30 readonly fields and
 * private constructors that take the raw wire format; building one in a test
 * means hand-writing the whole `ITransactionNotificationResponse`. A real
 * unmarshalled event satisfies this interface, so production passes the SDK
 * object straight in while tests pass three fields.
 */
export interface PaddleEventLike {
  eventId: string;
  eventType: string;
  occurredAt: string | Date;
  data: unknown;
}

interface CustomDataLike {
  userId?: unknown;
  licenseId?: unknown;
}

interface ItemLike {
  price?: { id?: string | null } | null;
  quantity?: number | null;
}

interface TotalsLike {
  subtotal?: string | null;
  total?: string | null;
}

interface TransactionDataLike {
  id?: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  customData?: CustomDataLike | null;
  items?: ItemLike[] | null;
  currencyCode?: string | null;
  billingPeriod?: { startsAt?: string; endsAt?: string } | null;
  details?: { totals?: TotalsLike | null } | null;
}

interface SubscriptionDataLike {
  id?: string;
  customerId?: string | null;
  customData?: CustomDataLike | null;
  items?: ItemLike[] | null;
  currentBillingPeriod?: { startsAt?: string; endsAt?: string } | null;
  scheduledChange?: { action?: string; effectiveAt?: string } | null;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type FulfillmentOutcome =
  | { status: "processed"; actions: string[] }
  | { status: "ignored"; reason: string };

const ignored = (reason: string): FulfillmentOutcome => ({ status: "ignored", reason });

// ---------------------------------------------------------------------------
// Injected data access
// ---------------------------------------------------------------------------

export interface FulfillmentDeps {
  credits: {
    addCredits(
      userId: string,
      amount: number,
      type: string,
      description: string,
      externalRef?: string,
    ): Promise<void>;
  };
  creditPackages: {
    getCreditPackageByPaddlePriceId(priceId: string): Promise<CreditPackage | undefined>;
  };
  plans: {
    getSubscriptionPlanByPaddlePriceId(priceId: string): Promise<SubscriptionPlan | undefined>;
  };
  licenses: {
    getLicenseById(id: string): Promise<License | undefined>;
    getLicenseByUserId(userId: string): Promise<License | undefined>;
    getLicenseByPaddleSubscriptionId(subscriptionId: string): Promise<License | undefined>;
    getLicensesByInstituteId(instituteId: string): Promise<License[]>;
    updateLicense(id: string, updates: Record<string, unknown>): Promise<License | undefined>;
  };
  institutes: {
    getInstitutesByUserId(userId: string): Promise<{ id: string }[]>;
  };
  events: {
    lastProcessedOccurredAtForSubscription(subscriptionId: string): Promise<Date | null>;
  };
}

/** Subscription lifecycle events we act on, and how each treats the period end. */
const SUBSCRIPTION_EVENTS = new Set([
  "subscription.activated",
  "subscription.updated",
  "subscription.canceled",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
]);

/** Events on which a subscription's plan credits are granted for the period. */
const CREDIT_GRANTING_SUBSCRIPTION_EVENTS = new Set([
  "subscription.activated",
  "subscription.resumed",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toDate(value: string | Date | undefined | null): Date | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Price ids on an event's line items, de-duplicated, order preserved. */
function priceIdsOf(items: ItemLike[] | null | undefined): string[] {
  const out: string[] = [];
  for (const item of items ?? []) {
    const id = asString(item?.price?.id ?? undefined);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export class PaddleFulfillmentService {
  constructor(private readonly deps: FulfillmentDeps) {}

  /**
   * Apply one verified event. Returns `processed` or `ignored`; THROWS only on
   * a fault the caller should have Paddle retry (see law 1 above).
   */
  async handleEvent(event: PaddleEventLike): Promise<FulfillmentOutcome> {
    const occurredAt = toDate(event.occurredAt) ?? new Date();
    paddleLog(`fulfillment: ${event.eventType} (${event.eventId})`);

    if (event.eventType === "transaction.completed") {
      return this.handleTransactionCompleted(event.data as TransactionDataLike, event);
    }
    if (SUBSCRIPTION_EVENTS.has(event.eventType)) {
      return this.handleSubscription(
        event.data as SubscriptionDataLike,
        event.eventType,
        occurredAt,
      );
    }
    return ignored(`unhandled event type: ${event.eventType}`);
  }

  // -------------------------------------------------------------------------
  // One-time purchases
  // -------------------------------------------------------------------------

  private async handleTransactionCompleted(
    txn: TransactionDataLike | null | undefined,
    event: PaddleEventLike,
  ): Promise<FulfillmentOutcome> {
    const transactionId = asString(txn?.id) ?? event.eventId;

    // PER-LICENSE FIRST. An individually-quoted license is bought with a
    // non-catalog price, so there is no priceId to recognise below — the
    // `customData.licenseId` we put on the transaction when we created it IS
    // the recognition. Credit packages and catalog plans never carry one.
    const boundLicenseId = asString(txn?.customData?.licenseId);
    if (boundLicenseId) {
      const license = await this.deps.licenses.getLicenseById(boundLicenseId);
      if (license) {
        return this.activateLicenseFromTransaction(license, txn, transactionId, event);
      }
      paddleLog("fulfillment: transaction customData.licenseId did not resolve", {
        licenseId: boundLicenseId,
        transactionId,
      });
    }

    const userId = asString(txn?.customData?.userId);
    if (!userId) {
      return ignored(`transaction ${transactionId} has no customData.userId`);
    }

    const priceIds = priceIdsOf(txn?.items);
    if (priceIds.length === 0) {
      return ignored(`transaction ${transactionId} has no line items`);
    }

    const actions: string[] = [];
    const skipped: string[] = [];

    for (const priceId of priceIds) {
      const pkg = await this.deps.creditPackages.getCreditPackageByPaddlePriceId(priceId);
      if (pkg) {
        const amount = (pkg.credits ?? 0) + (pkg.bonusCredits ?? 0);
        await this.deps.credits.addCredits(
          userId,
          amount,
          "purchase",
          `Paddle purchase — ${pkg.name}`,
          transactionId,
        );
        actions.push(`granted ${amount} credits to ${userId} for package ${pkg.name}`);
        continue;
      }

      // A subscription's FIRST payment also arrives as transaction.completed.
      // The license work belongs to subscription.activated (which is the event
      // that carries the billing period), so recognising the price here only
      // stops it being reported as unknown.
      const plan = await this.deps.plans.getSubscriptionPlanByPaddlePriceId(priceId);
      if (plan) {
        skipped.push(`${priceId} is subscription plan "${plan.name}" — handled on subscription.*`);
        continue;
      }

      skipped.push(`unknown price id ${priceId}`);
      paddleLog(`fulfillment: unknown price id on transaction ${transactionId}`, { priceId });
    }

    if (actions.length === 0) {
      return ignored(`transaction ${transactionId}: nothing to fulfil (${skipped.join("; ")})`);
    }
    if (skipped.length > 0) actions.push(`skipped: ${skipped.join("; ")}`);
    return { status: "processed", actions };
  }

  /**
   * A per-license purchase completed: the license stops being a trial and
   * becomes paid through the end of the period.
   *
   * NO CREDITS. Credits are a separate product bought with a credit package;
   * paying for a license buys the license.
   *
   * A price MISMATCH is logged, never rejected. The money has already moved —
   * refusing the event would only make Paddle retry forever while the customer
   * who paid stays locked out. What we want is a record an operator can read.
   */
  private async activateLicenseFromTransaction(
    license: License,
    txn: TransactionDataLike | null | undefined,
    transactionId: string,
    event: PaddleEventLike,
  ): Promise<FulfillmentOutcome> {
    const occurredAt = toDate(event.occurredAt) ?? new Date();
    const yearly = license.subscriptionType === "yearly";
    const expiresAt =
      toDate(txn?.billingPeriod?.endsAt) ??
      new Date(occurredAt.getTime() + (yearly ? 365 : 30) * DAY_MS);

    const paid = asString(txn?.details?.totals?.subtotal ?? txn?.details?.totals?.total);
    const paidCurrency = asString(txn?.currencyCode);
    if (license.priceAmount != null && paid && Number(paid) !== license.priceAmount) {
      paddleLog("fulfillment: PRICE MISMATCH on per-license transaction", {
        licenseId: license.id,
        transactionId,
        quoted: license.priceAmount,
        paid,
      });
    }
    if (license.priceCurrency && paidCurrency && paidCurrency !== license.priceCurrency) {
      paddleLog("fulfillment: CURRENCY MISMATCH on per-license transaction", {
        licenseId: license.id,
        transactionId,
        quoted: license.priceCurrency,
        paid: paidCurrency,
      });
    }

    await this.deps.licenses.updateLicense(license.id, {
      isTrial: false,
      trialExpiresAt: null,
      isActive: true,
      paddleCustomerId: asString(txn?.customerId) ?? license.paddleCustomerId ?? null,
      paddleSubscriptionId: asString(txn?.subscriptionId) ?? license.paddleSubscriptionId ?? null,
      paddleTransactionId: transactionId,
      subscriptionExpiresAt: expiresAt,
      updatedAt: new Date(),
    });

    return {
      status: "processed",
      actions: [
        `license ${license.id} paid via transaction ${transactionId}, ` +
          `expires ${expiresAt.toISOString()}`,
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  private async handleSubscription(
    sub: SubscriptionDataLike | null | undefined,
    eventType: string,
    occurredAt: Date,
  ): Promise<FulfillmentOutcome> {
    const subscriptionId = asString(sub?.id);
    if (!subscriptionId) return ignored(`${eventType} has no subscription id`);

    // Law 3 — order guard.
    const lastApplied =
      await this.deps.events.lastProcessedOccurredAtForSubscription(subscriptionId);
    if (lastApplied && occurredAt.getTime() <= lastApplied.getTime()) {
      return ignored(
        `stale ${eventType} for ${subscriptionId}: occurred ${occurredAt.toISOString()}, ` +
          `already applied ${lastApplied.toISOString()}`,
      );
    }

    const priceIds = priceIdsOf(sub?.items);
    let plan: SubscriptionPlan | undefined;
    for (const priceId of priceIds) {
      plan = await this.deps.plans.getSubscriptionPlanByPaddlePriceId(priceId);
      if (plan) break;
    }

    // A per-license subscription is sold at a NON-CATALOG price, so no plan
    // will ever match its price id. That is the signal to take the
    // license-bound path rather than to give up. (Order deliberately: a
    // recognised catalog price keeps the catalog behaviour, including its own
    // customData.licenseId handling, unchanged.)
    if (!plan) {
      return this.handleLicenseSubscription(sub, subscriptionId, eventType, occurredAt, priceIds);
    }

    const userId = asString(sub?.customData?.userId);
    if (!userId) return ignored(`subscription ${subscriptionId} has no customData.userId`);

    const license = await this.resolveLicense(userId, asString(sub?.customData?.licenseId));
    if (!license) {
      return ignored(`subscription ${subscriptionId}: no license found for user ${userId}`);
    }

    const expiresAt = this.periodEnd(sub, eventType, plan, occurredAt);

    const updates: Record<string, unknown> = {
      paddleCustomerId: asString(sub?.customerId) ?? license.paddleCustomerId ?? null,
      paddleSubscriptionId: subscriptionId,
      subscriptionExpiresAt: expiresAt,
      updatedAt: new Date(),
    };

    // Law 2: only the healthy states assert isActive, and NOTHING clears it.
    if (
      eventType === "subscription.activated" ||
      eventType === "subscription.resumed" ||
      eventType === "subscription.updated"
    ) {
      updates.isActive = true;
    }
    if (plan.licenseType) updates.licenseType = plan.licenseType;
    if (plan.permissions) updates.permissions = plan.permissions as LicensePermissions;

    await this.deps.licenses.updateLicense(license.id, updates);

    const actions = [
      `license ${license.id} set to plan "${plan.name}" (${eventType}), ` +
        `expires ${expiresAt.toISOString()}`,
    ];

    // Credits are per billing period. Granted when a period BEGINS — activation
    // and resume — not on `updated`, which fires for plan/quantity/address
    // changes and would otherwise pay out several times inside one period.
    if (CREDIT_GRANTING_SUBSCRIPTION_EVENTS.has(eventType) && plan.credits > 0) {
      await this.deps.credits.addCredits(
        userId,
        plan.credits,
        "purchase",
        `Paddle subscription — ${plan.name}`,
        subscriptionId,
      );
      actions.push(`granted ${plan.credits} credits to ${userId}`);
    }

    return { status: "processed", actions };
  }

  /**
   * Subscription lifecycle for an INDIVIDUALLY-QUOTED license.
   *
   * Resolution is by identity, not by price: `customData.licenseId` if the
   * checkout named one, else the license already carrying this
   * `paddleSubscriptionId` — which is how a renewal or a cancellation months
   * later still finds its row, since Paddle's own events carry no customData
   * we did not put there at checkout.
   *
   * Like the catalog path, this makes the TIMESTAMP truthful and never clears
   * `isActive` (law 2); expiry enforcement lives in licenseService.
   */
  private async handleLicenseSubscription(
    sub: SubscriptionDataLike | null | undefined,
    subscriptionId: string,
    eventType: string,
    occurredAt: Date,
    priceIds: string[],
  ): Promise<FulfillmentOutcome> {
    const boundLicenseId = asString(sub?.customData?.licenseId);
    let license: License | undefined;
    if (boundLicenseId) license = await this.deps.licenses.getLicenseById(boundLicenseId);
    if (!license) {
      license = await this.deps.licenses.getLicenseByPaddleSubscriptionId(subscriptionId);
    }
    if (!license) {
      paddleLog(`fulfillment: no plan and no license for subscription ${subscriptionId}`, {
        priceIds,
        boundLicenseId,
      });
      return ignored(
        `subscription ${subscriptionId}: no subscription plan for price ids ` +
          `[${priceIds.join(", ")}] and no license bound to it`,
      );
    }

    const yearly = license.subscriptionType === "yearly";
    const expiresAt =
      (eventType === "subscription.canceled"
        ? toDate(sub?.scheduledChange?.effectiveAt)
        : undefined) ??
      toDate(sub?.currentBillingPeriod?.endsAt) ??
      new Date(occurredAt.getTime() + (yearly ? 365 : 30) * DAY_MS);

    const updates: Record<string, unknown> = {
      paddleCustomerId: asString(sub?.customerId) ?? license.paddleCustomerId ?? null,
      paddleSubscriptionId: subscriptionId,
      subscriptionExpiresAt: expiresAt,
      updatedAt: new Date(),
    };
    if (
      eventType === "subscription.activated" ||
      eventType === "subscription.resumed" ||
      eventType === "subscription.updated"
    ) {
      updates.isActive = true;
      updates.isTrial = false;
      updates.trialExpiresAt = null;
    }

    await this.deps.licenses.updateLicense(license.id, updates);
    return {
      status: "processed",
      actions: [
        `license ${license.id} (per-license price) ${eventType}, ` +
          `expires ${expiresAt.toISOString()}`,
      ],
    };
  }

  /**
   * When the currently-paid period ends.
   *
   * For a cancellation Paddle puts the effective date on `scheduledChange`
   * (cancel at period end) — that is the date the customer keeps access to, so
   * it wins over `currentBillingPeriod` when present. Everything else uses the
   * current period's end. The fallback, when Paddle sends neither (it can, for
   * an immediate cancellation), is the plan's own duration measured from the
   * event: better a slightly generous date we can see than a null that silently
   * means "never expires".
   */
  private periodEnd(
    sub: SubscriptionDataLike | null | undefined,
    eventType: string,
    plan: SubscriptionPlan,
    occurredAt: Date,
  ): Date {
    if (eventType === "subscription.canceled") {
      const scheduled = toDate(sub?.scheduledChange?.effectiveAt);
      if (scheduled) return scheduled;
    }
    const periodEnd = toDate(sub?.currentBillingPeriod?.endsAt);
    if (periodEnd) return periodEnd;
    return new Date(occurredAt.getTime() + (plan.duration ?? 30) * DAY_MS);
  }

  /**
   * Which license this payment applies to.
   *
   * Order, and why — this mirrors licenseService.getUserLicenseInfo's walk with
   * one deliberate difference:
   *   1. `customData.licenseId` if the checkout named one. Explicit beats
   *      inferred; an admin buying for a specific license must be obeyed.
   *   2. A private license bound directly to the user (`licenses.user_id`).
   *   3. The first ACTIVE license of an institute the user belongs to.
   *
   * The difference: getInstituteLicenseInfo only considers a license whose
   * `permissions` jsonb is non-null, because it is answering "what may this
   * person do". We are answering "what did this person pay for", and a license
   * created by a plan that grants no explicit permissions has none — so
   * filtering on it would skip exactly the row we mean to extend.
   *
   * AMBIGUITY, stated rather than hidden: a user in more than one institute
   * with more than one active license gets the FIRST (institutes in repository
   * order, licenses newest-first). If that becomes real, the checkout must pass
   * `licenseId` — which is why case 1 exists.
   */
  private async resolveLicense(
    userId: string,
    licenseId?: string,
  ): Promise<License | undefined> {
    if (licenseId) {
      const explicit = await this.deps.licenses.getLicenseById(licenseId);
      if (explicit) return explicit;
      paddleLog("fulfillment: customData.licenseId did not resolve", { licenseId, userId });
    }

    const own = await this.deps.licenses.getLicenseByUserId(userId);
    if (own) return own;

    const institutes = await this.deps.institutes.getInstitutesByUserId(userId);
    for (const inst of institutes) {
      const licenses = await this.deps.licenses.getLicensesByInstituteId(inst.id);
      const active = licenses.find((l) => l.isActive);
      if (active) return active;
    }
    return undefined;
  }
}

/**
 * The production instance, wired to the real repositories.
 *
 * Built lazily so importing this module (which the controller and its tests do)
 * does not force the repository/db graph to load in a DB-free unit test.
 */
let singleton: PaddleFulfillmentService | null = null;

export async function getPaddleFulfillmentService(): Promise<PaddleFulfillmentService> {
  if (singleton) return singleton;
  const [{ creditRepository, licenseRepository, instituteRepository, paddleEventRepository }, { settingsRepository }, { creditService }] =
    await Promise.all([
      import("../repositories/index.js"),
      import("../repositories/settingsRepository.js"),
      import("./creditService.js"),
    ]);

  singleton = new PaddleFulfillmentService({
    credits: {
      addCredits: (userId, amount, type, description, externalRef) =>
        creditService.addCredits(userId, amount, type, description, externalRef),
    },
    creditPackages: {
      getCreditPackageByPaddlePriceId: (priceId) =>
        creditRepository.getCreditPackageByPaddlePriceId(priceId),
    },
    plans: {
      getSubscriptionPlanByPaddlePriceId: (priceId) =>
        settingsRepository.getSubscriptionPlanByPaddlePriceId(priceId),
    },
    licenses: {
      getLicenseById: (id) => licenseRepository.getLicenseById(id),
      getLicenseByUserId: (userId) => licenseRepository.getLicenseByUserId(userId),
      getLicenseByPaddleSubscriptionId: (subscriptionId) =>
        licenseRepository.getLicenseByPaddleSubscriptionId(subscriptionId),
      getLicensesByInstituteId: (instituteId) =>
        licenseRepository.getLicensesByInstituteId(instituteId),
      updateLicense: (id, updates) => licenseRepository.updateLicense(id, updates as never),
    },
    institutes: {
      getInstitutesByUserId: (userId) => instituteRepository.getInstitutesByUserId(userId),
    },
    events: {
      lastProcessedOccurredAtForSubscription: (subscriptionId) =>
        paddleEventRepository.lastProcessedOccurredAtForSubscription(subscriptionId),
    },
  });
  return singleton;
}

/** Test seam: drop the memoised production instance. */
export function resetPaddleFulfillmentService(): void {
  singleton = null;
}
