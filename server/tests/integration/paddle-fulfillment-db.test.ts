/**
 * Paddle fulfillment against the REAL repositories and a real Postgres.
 *
 * paddle-fulfillment.test.ts covers the decision logic with fakes; this suite
 * covers the half fakes cannot: that the wiring in
 * getPaddleFulfillmentService() reaches the right tables, that the new
 * `paddle_price_id` lookups actually find a row, that a credit grant lands in
 * BOTH `users.credits` and the `credit_transactions` ledger with the Paddle
 * transaction id in the external-reference column, and that the out-of-order
 * guard's jsonb query over `paddle_events` returns what it claims to.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import { makeUser, makeLicense, licenseRepository, userRepository } from '../helpers/factories.js';
import { creditRepository } from '../../repositories/creditRepository.js';
import { settingsRepository } from '../../repositories/settingsRepository.js';
import { paddleEventRepository } from '../../repositories/paddleEventRepository.js';
import {
  getPaddleFulfillmentService,
  resetPaddleFulfillmentService,
  type PaddleEventLike,
} from '../../services/paddleFulfillmentService.js';

const PACK_PRICE = 'pri_db_pack';
const PLAN_PRICE = 'pri_db_plan';

async function seedCatalog() {
  const pkg = await creditRepository.createCreditPackage({
    name: 'DB Starter Pack',
    credits: 100,
    price: 9.99,
    bonusCredits: 25,
    isActive: true,
    sortOrder: 0,
    paddlePriceId: PACK_PRICE,
  } as any);

  const plan = await settingsRepository.createSubscriptionPlan({
    name: 'DB Premium Monthly',
    price: 29.99,
    credits: 500,
    duration: 30,
    isActive: true,
    paddlePriceId: PLAN_PRICE,
    licenseType: 'premium',
    permissions: { maxStudents: 7 },
  } as any);

  return { pkg, plan };
}

describe('Paddle fulfillment (DB)', () => {
  beforeEach(() => {
    resetPaddleFulfillmentService();
  });
  afterEach(async () => {
    resetPaddleFulfillmentService();
    await truncateAll();
  });

  it('fulfils a credit-pack purchase into users.credits and the ledger', async () => {
    const user = await makeUser();
    const before = (await userRepository.getUser(user.id))!.credits;
    await seedCatalog();

    const service = await getPaddleFulfillmentService();
    const event: PaddleEventLike = {
      eventId: 'evt_db_txn',
      eventType: 'transaction.completed',
      occurredAt: new Date().toISOString(),
      data: {
        id: 'txn_db_1',
        customerId: 'ctm_db_1',
        customData: { userId: user.id },
        items: [{ price: { id: PACK_PRICE }, quantity: 1 }],
      },
    };

    const outcome = await service.handleEvent(event);
    expect(outcome.status).toBe('processed');

    const after = (await userRepository.getUser(user.id))!.credits;
    expect(after - before).toBe(125); // 100 + 25 bonus

    const ledger = await creditRepository.getUserCreditTransactions(user.id);
    const purchase = ledger.find((t) => t.type === 'purchase');
    expect(purchase).toBeDefined();
    expect(purchase!.amount).toBe(125);
    // The Paddle transaction id occupies the external-reference slot.
    expect(purchase!.stripePaymentIntentId).toBe('txn_db_1');
    expect(purchase!.description).toContain('DB Starter Pack');
  });

  it('finds a package/plan by paddle_price_id and ignores a price we do not sell', async () => {
    const { pkg, plan } = await seedCatalog();

    expect((await creditRepository.getCreditPackageByPaddlePriceId(PACK_PRICE))?.id).toBe(pkg.id);
    expect((await settingsRepository.getSubscriptionPlanByPaddlePriceId(PLAN_PRICE))?.id).toBe(
      plan.id,
    );
    expect(await creditRepository.getCreditPackageByPaddlePriceId('pri_nope')).toBeUndefined();

    const user = await makeUser();
    const service = await getPaddleFulfillmentService();
    const outcome = await service.handleEvent({
      eventId: 'evt_db_unknown',
      eventType: 'transaction.completed',
      occurredAt: new Date().toISOString(),
      data: {
        id: 'txn_db_2',
        customData: { userId: user.id },
        items: [{ price: { id: 'pri_nope' }, quantity: 1 }],
      },
    });

    expect(outcome.status).toBe('ignored');
    const after = (await userRepository.getUser(user.id))!.credits;
    const ledger = await creditRepository.getUserCreditTransactions(user.id);
    expect(ledger.some((t) => t.type === 'purchase')).toBe(false);
    expect(after).toBe((await userRepository.getUser(user.id))!.credits);
  });

  it('applies a subscription to the user\'s license and grants the plan credits', async () => {
    const user = await makeUser();
    await seedCatalog();
    const license = await makeLicense({ inviteEmail: user.email! });
    await licenseRepository.updateLicense(license.id, { userId: user.id } as any);

    const service = await getPaddleFulfillmentService();
    const outcome = await service.handleEvent({
      eventId: 'evt_db_sub',
      eventType: 'subscription.activated',
      occurredAt: new Date().toISOString(),
      data: {
        id: 'sub_db_1',
        customerId: 'ctm_db_1',
        customData: { userId: user.id },
        items: [{ price: { id: PLAN_PRICE }, quantity: 1 }],
        currentBillingPeriod: {
          startsAt: '2026-09-01T00:00:00.000Z',
          endsAt: '2026-10-01T00:00:00.000Z',
        },
      },
    });

    expect(outcome.status).toBe('processed');

    const updated = (await licenseRepository.getLicenseById(license.id))!;
    expect(updated.paddleCustomerId).toBe('ctm_db_1');
    expect(updated.paddleSubscriptionId).toBe('sub_db_1');
    expect(updated.licenseType).toBe('premium');
    expect(updated.permissions).toMatchObject({ maxStudents: 7 });
    expect(updated.isActive).toBe(true);
    expect(updated.subscriptionExpiresAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');

    const ledger = await creditRepository.getUserCreditTransactions(user.id);
    const grant = ledger.find((t) => t.stripePaymentIntentId === 'sub_db_1');
    expect(grant?.amount).toBe(500);
  });
});

describe('paddle_events ledger (DB)', () => {
  afterEach(truncateAll);

  it('claims an event once and reports the existing row on a replay', async () => {
    const input = {
      id: 'evt_claim_1',
      eventType: 'transaction.completed',
      occurredAt: new Date('2026-09-01T10:00:00.000Z'),
      payload: { data: { id: 'txn_1' } },
    };

    const first = await paddleEventRepository.claimEvent(input);
    expect(first.claimed).toBe(true);
    expect(first.row.status).toBe('received');

    await paddleEventRepository.setStatus('evt_claim_1', 'processed', 'granted 100');

    const second = await paddleEventRepository.claimEvent(input);
    expect(second.claimed).toBe(false);
    expect(second.row.status).toBe('processed');
    expect(second.row.processedAt).toBeInstanceOf(Date);
  });

  it('reopens a failed row so a Paddle retry can run again', async () => {
    await paddleEventRepository.claimEvent({
      id: 'evt_fail_1',
      eventType: 'transaction.completed',
      occurredAt: new Date(),
      payload: {},
    });
    await paddleEventRepository.setStatus('evt_fail_1', 'failed', 'boom');

    await paddleEventRepository.reopenFailed('evt_fail_1');
    expect((await paddleEventRepository.getEvent('evt_fail_1'))?.status).toBe('received');

    // A processed row must NOT be reopened by the same call.
    await paddleEventRepository.setStatus('evt_fail_1', 'processed', null);
    await paddleEventRepository.reopenFailed('evt_fail_1');
    expect((await paddleEventRepository.getEvent('evt_fail_1'))?.status).toBe('processed');
  });

  it('reads the newest PROCESSED occurred_at per subscription out of the payload', async () => {
    const rows = [
      { id: 'e1', occurredAt: '2026-09-01T00:00:00.000Z', status: 'processed', sub: 'sub_A' },
      { id: 'e2', occurredAt: '2026-09-05T00:00:00.000Z', status: 'processed', sub: 'sub_A' },
      // Newer, but ignored — it applied nothing, so it must not block anything.
      { id: 'e3', occurredAt: '2026-09-09T00:00:00.000Z', status: 'ignored', sub: 'sub_A' },
      { id: 'e4', occurredAt: '2026-09-20T00:00:00.000Z', status: 'processed', sub: 'sub_B' },
    ];
    for (const r of rows) {
      await paddleEventRepository.claimEvent({
        id: r.id,
        eventType: 'subscription.updated',
        occurredAt: new Date(r.occurredAt),
        payload: { data: { id: r.sub } },
      });
      await paddleEventRepository.setStatus(r.id, r.status as any, null);
    }

    const latestA = await paddleEventRepository.lastProcessedOccurredAtForSubscription('sub_A');
    expect(latestA?.toISOString()).toBe('2026-09-05T00:00:00.000Z');

    const latestB = await paddleEventRepository.lastProcessedOccurredAtForSubscription('sub_B');
    expect(latestB?.toISOString()).toBe('2026-09-20T00:00:00.000Z');

    expect(
      await paddleEventRepository.lastProcessedOccurredAtForSubscription('sub_missing'),
    ).toBeNull();
  });
});
