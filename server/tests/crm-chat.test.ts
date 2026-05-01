/**
 * CRM Chat unit tests — pure-function paths only (hashing, header parsing,
 * memory-schema shape, agent template). DB-backed flows (find-or-create,
 * session resume, daily cap) are exercised via integration-style harness
 * later; this file should run fast and need no DB.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('CRM identify — IP hashing', () => {
  const ORIGINAL_SALT = process.env.CRM_IP_SALT;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.CRM_IP_SALT = 'test-salt-fixed';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    if (ORIGINAL_SALT === undefined) delete process.env.CRM_IP_SALT;
    else process.env.CRM_IP_SALT = ORIGINAL_SALT;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('produces a stable hex digest for the same IP', async () => {
    const { hashIp } = await import('../services/crmChat/identify');
    const a = hashIp('203.0.113.5');
    const b = hashIp('203.0.113.5');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different digests for different IPs', async () => {
    const { hashIp } = await import('../services/crmChat/identify');
    const a = hashIp('203.0.113.5');
    const b = hashIp('203.0.113.6');
    expect(a).not.toBe(b);
  });

  it('produces different digests when the salt changes', async () => {
    // The salt is read lazily on each hash call, so we don't need to reset
    // module cache — flipping the env mid-test is enough.
    const { hashIp } = await import('../services/crmChat/identify');
    process.env.CRM_IP_SALT = 'salt-A';
    const a = hashIp('203.0.113.5');
    process.env.CRM_IP_SALT = 'salt-B';
    const b = hashIp('203.0.113.5');
    expect(a).not.toBe(b);
  });

  it('throws in production if CRM_IP_SALT is unset', async () => {
    const { hashIp } = await import('../services/crmChat/identify');
    delete process.env.CRM_IP_SALT;
    process.env.NODE_ENV = 'production';
    expect(() => hashIp('203.0.113.5')).toThrow(/CRM_IP_SALT/);
  });
});

describe('CRM identify — header parsing', () => {
  beforeEach(() => {
    process.env.CRM_IP_SALT = 'test-salt-fixed';
  });

  function makeReq(headers: Record<string, string>, fallbackIp = '127.0.0.1'): any {
    return { headers, ip: fallbackIp };
  }

  it('prefers cf-connecting-ip', async () => {
    const { getClientIp } = await import('../services/crmChat/identify');
    const ip = getClientIp(makeReq({ 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.7' }));
    expect(ip).toBe('198.51.100.1');
  });

  it('falls back to first hop of x-forwarded-for', async () => {
    const { getClientIp } = await import('../services/crmChat/identify');
    const ip = getClientIp(makeReq({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    expect(ip).toBe('203.0.113.7');
  });

  it('falls back to req.ip when no headers present', async () => {
    const { getClientIp } = await import('../services/crmChat/identify');
    const ip = getClientIp(makeReq({}, '127.0.0.1'));
    expect(ip).toBe('127.0.0.1');
  });

  it('reads cf-ipcountry as uppercase ISO-2', async () => {
    const { getCountryCode } = await import('../services/crmChat/identify');
    expect(getCountryCode(makeReq({ 'cf-ipcountry': 'us' }))).toBe('US');
    expect(getCountryCode(makeReq({ 'cf-ipcountry': 'IL' }))).toBe('IL');
  });

  it('rejects garbage country codes', async () => {
    const { getCountryCode } = await import('../services/crmChat/identify');
    expect(getCountryCode(makeReq({ 'cf-ipcountry': 'zzz' }))).toBeNull();
    expect(getCountryCode(makeReq({}))).toBeNull();
  });
});

describe('CRM memory schema shape', () => {
  it('has the documented Customer_* fields', async () => {
    const { CRM_MEMORY_FIELDS } = await import('../services/memory-schema/crm-memory-schema');
    const ids = CRM_MEMORY_FIELDS.map((f) => f.id);
    expect(ids).toEqual([
      'Customer_FirstName',
      'Customer_LastName',
      'Customer_Email',
      'Customer_Organization',
      'Customer_Role',
      'Customer_Scratchpad',
    ]);
  });

  it('every field has db.read and db.write ops', async () => {
    const { CRM_MEMORY_FIELDS } = await import('../services/memory-schema/crm-memory-schema');
    for (const f of CRM_MEMORY_FIELDS) {
      expect(typeof f.db?.read).toBe('function');
      expect(typeof f.db?.write).toBe('function');
    }
  });

  it('every field starts opened so values render in the visualization', async () => {
    const { CRM_MEMORY_FIELDS } = await import('../services/memory-schema/crm-memory-schema');
    for (const f of CRM_MEMORY_FIELDS) {
      expect(f.opened).toBe(true);
    }
  });

  it('Customer_Scratchpad is a primitive string field (no array ops)', async () => {
    const { CUSTOMER_SCRATCHPAD_FIELD } = await import('../services/memory-schema/crm-memory-schema');
    expect(CUSTOMER_SCRATCHPAD_FIELD.type).toBe('string');
    expect(CUSTOMER_SCRATCHPAD_FIELD.db?.add).toBeUndefined();
    expect(CUSTOMER_SCRATCHPAD_FIELD.db?.insert).toBeUndefined();
  });

  it('refuses to read without crmPotentialCustomerId in context', async () => {
    const { __test } = await import('../services/memory-schema/crm-memory-schema');
    const ctx = { all: {}, base: {}, inherited: {}, path: '/Customer_Email', pathTokens: ['Customer_Email'] };
    const value = await __test.getCustomerMemoryField(ctx as any, 'Customer_Email');
    expect(value).toBeUndefined();
  });

  it('refuses to write without crmPotentialCustomerId in context', async () => {
    const { __test } = await import('../services/memory-schema/crm-memory-schema');
    const ctx = { all: {}, base: {}, inherited: {}, path: '/Customer_Email', pathTokens: ['Customer_Email'] };
    await expect(__test.setCustomerMemoryField(ctx as any, 'Customer_Email', 'a@b.com')).rejects.toThrow(
      /crmPotentialCustomerId/,
    );
  });
});

describe('CRM rate limiters', () => {
  it('FixedWindowLimiter accepts up to limit then 429s', async () => {
    const { FixedWindowLimiter } = await import('../services/crmChat/rateLimiter');
    const limiter = new FixedWindowLimiter(3, 60_000);
    expect(limiter.check('ip1').ok).toBe(true);
    expect(limiter.check('ip1').ok).toBe(true);
    expect(limiter.check('ip1').ok).toBe(true);
    const blocked = limiter.check('ip1');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('FixedWindowLimiter resets after the window passes', async () => {
    const { FixedWindowLimiter } = await import('../services/crmChat/rateLimiter');
    const limiter = new FixedWindowLimiter(2, 1_000);
    const t0 = 1_000_000;
    limiter.check('ip1', t0);
    limiter.check('ip1', t0 + 100);
    expect(limiter.check('ip1', t0 + 200).ok).toBe(false);
    // After the window expires, a fresh request is accepted again.
    expect(limiter.check('ip1', t0 + 1_500).ok).toBe(true);
  });

  it('FixedWindowLimiter sweeps stale entries to bound memory', async () => {
    const { FixedWindowLimiter } = await import('../services/crmChat/rateLimiter');
    const limiter = new FixedWindowLimiter(5, 1_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) limiter.check(`ip-${i}`, t0);
    expect(limiter.size()).toBe(50);
    // A check after the window has elapsed triggers the sweep.
    limiter.check('fresh', t0 + 2_000);
    expect(limiter.size()).toBe(1);
  });

  it('GlobalLimiter caps total events across all keys', async () => {
    const { GlobalLimiter } = await import('../services/crmChat/rateLimiter');
    const limiter = new GlobalLimiter(2, 60_000);
    expect(limiter.check().ok).toBe(true);
    expect(limiter.check().ok).toBe(true);
    expect(limiter.check().ok).toBe(false);
  });

  it('configured limiters cover identify, message, and config', async () => {
    const mod = await import('../services/crmChat/rateLimiter');
    expect(typeof mod.messageLimiter.check).toBe('function');
    expect(typeof mod.identifyLimiter.check).toBe('function');
    expect(typeof mod.configLimiter.check).toBe('function');
    expect(typeof mod.globalMessageLimiter.check).toBe('function');
  });
});

describe('Customer_Scratchpad cap', () => {
  it('trimScratchpad is a no-op under the char cap', async () => {
    const { __test } = await import('../services/memory-schema/crm-memory-schema');
    expect(__test.trimScratchpad('hello')).toBe('hello');
    expect(__test.trimScratchpad('')).toBe('');
  });

  it('trimScratchpad keeps the most recent characters when over cap', async () => {
    const { __test } = await import('../services/memory-schema/crm-memory-schema');
    const max = __test.CUSTOMER_SCRATCHPAD_MAX_CHARS;
    const oversized = 'A'.repeat(100) + 'B'.repeat(max);
    const trimmed = __test.trimScratchpad(oversized);
    expect(trimmed.length).toBe(max);
    // The oldest 100 'A' chars are dropped; the newer 'B's survive.
    expect(trimmed.startsWith('B')).toBe(true);
    expect(trimmed.endsWith('B')).toBe(true);
  });

  it('trimScratchpad coerces non-string inputs to a string', async () => {
    const { __test } = await import('../services/memory-schema/crm-memory-schema');
    expect(__test.trimScratchpad(undefined as any)).toBe('');
    expect(__test.trimScratchpad(null as any)).toBe('');
  });
});

describe('CRM agent template', () => {
  it('builds with default prompt and no outbound tools', async () => {
    const { buildCrmAgent } = await import('../services/crmChat/agentTemplate');
    const agent = buildCrmAgent({ systemPrompt: 'be friendly' });
    expect(agent.tools).toEqual({});
    expect(agent.corePrompt).toBe('be friendly');
    expect(Array.isArray(agent.memoryFields)).toBe(true);
    expect(agent.memoryFields!.length).toBeGreaterThan(0);
  });

  it('includes the shared knowledge library field in memoryFields', async () => {
    const { buildCrmAgent } = await import('../services/crmChat/agentTemplate');
    const agent = buildCrmAgent({ systemPrompt: 'be friendly' });
    const ids = (agent.memoryFields ?? []).map((f: any) => f.id);
    expect(ids).toContain('Context_Library');
  });
});

describe('CRM library access — crmAccessible filter', () => {
  // Capture every call topic-memory-schema makes to topicService so we can
  // assert it propagates the crmAccessibleOnly flag from the context.
  let calls: Array<{ parentId: string | null; options: any }> = [];
  const fakeTopics = [
    { id: 'public-1', title: 'Public', content: 'p', active: true, crmAccessible: true },
    { id: 'internal-1', title: 'Internal', content: 'i', active: true, crmAccessible: false },
  ];

  beforeEach(() => {
    calls = [];
    jest.resetModules();
    jest.doMock('../services/topicService', () => ({
      __esModule: true,
      topicService: {
        getActiveTopicsByParentId: jest
          .fn()
          .mockImplementation(async (parentId: string | null, options: any = {}) => {
            calls.push({ parentId, options });
            const topics = options.crmAccessibleOnly
              ? fakeTopics.filter((t) => t.crmAccessible)
              : fakeTopics;
            return { success: true, topics };
          }),
      },
    }));
  });

  afterEach(() => {
    jest.dontMock('../services/topicService');
    jest.resetModules();
  });

  it('passes crmAccessibleOnly:true when ctx.all.crmAccessibleOnly is set', async () => {
    const { LIBRARY_TOPICS_FIELD } = await import('../services/memory-schema/topic-memory-schema');
    const ctx: any = {
      all: { crmAccessibleOnly: true },
      base: {},
      inherited: {},
      path: '/Context_Library',
      pathTokens: ['Context_Library'],
    };
    const result = await LIBRARY_TOPICS_FIELD.db!.list!(ctx, { offset: 0, limit: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.crmAccessibleOnly).toBe(true);
    // Internal topic was filtered out at the service layer.
    expect(result.items.map((t: any) => t.title)).toEqual(['Public']);
  });

  it('omits the flag when ctx.all.crmAccessibleOnly is absent (regular chat)', async () => {
    const { LIBRARY_TOPICS_FIELD } = await import('../services/memory-schema/topic-memory-schema');
    const ctx: any = {
      all: {},
      base: {},
      inherited: {},
      path: '/Context_Library',
      pathTokens: ['Context_Library'],
    };
    const result = await LIBRARY_TOPICS_FIELD.db!.list!(ctx, { offset: 0, limit: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.crmAccessibleOnly).toBe(false);
    // Both topics returned — internal not filtered out.
    expect(result.items.map((t: any) => t.title)).toEqual(['Public', 'Internal']);
  });

  it('forwards the flag through the get() op as well', async () => {
    const { LIBRARY_TOPICS_FIELD } = await import('../services/memory-schema/topic-memory-schema');
    const ctx: any = {
      all: { crmAccessibleOnly: true },
      base: {},
      inherited: {},
      path: '/Context_Library/Public',
      pathTokens: ['Context_Library', 'Public'],
    };
    const item = await LIBRARY_TOPICS_FIELD.db!.get!(ctx, 'Public');
    expect(calls[0].options.crmAccessibleOnly).toBe(true);
    expect(item?.title).toBe('Public');
    // An internal topic is invisible to the CRM agent even by exact title.
    calls.length = 0;
    const internal = await LIBRARY_TOPICS_FIELD.db!.get!(ctx, 'Internal');
    expect(internal).toBeUndefined();
  });
});
