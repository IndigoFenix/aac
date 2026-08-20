/**
 * loadAwsSecrets — the shared Secrets Manager → process.env bootstrap used by
 * both AWS entry points. The override flag is the whole point: ECS must keep
 * the env its task definition sets (EMAIL_FROM, REALTIME_BUS, ...) while
 * Lambda keeps its historical "secret wins" behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { loadAwsSecrets } from '../config/aws-secrets';

const ENV_KEYS = [
  'DATABASE_URL', 'DATABASE_SECRET_ARN', 'APP_SECRETS_ARN',
  'EMAIL_FROM', 'OPENAI_API_KEY', 'NEW_KEY_ADDED_LATER',
];

const secrets: Record<string, string> = {
  'arn:db': JSON.stringify({ DATABASE_URL: 'postgres://from-secret' }),
  'arn:app': JSON.stringify({
    EMAIL_FROM: 'stale-smtp@gmail.com',
    OPENAI_API_KEY: 'sk-secret',
    NEW_KEY_ADDED_LATER: 'present',
    EMPTY: '',
    NUMERIC: 42,
  }),
};
const fetchSecret = async (id: string) => secrets[id];
const silent = () => {};

describe('loadAwsSecrets', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('loads every string key of the app secret (no per-key allowlist)', async () => {
    process.env.DATABASE_SECRET_ARN = 'arn:db';
    process.env.APP_SECRETS_ARN = 'arn:app';
    const loaded = await loadAwsSecrets({ override: false, fetchSecret, log: silent });
    expect(loaded).toBe(true);
    expect(process.env.DATABASE_URL).toBe('postgres://from-secret');
    expect(process.env.OPENAI_API_KEY).toBe('sk-secret');
    expect(process.env.NEW_KEY_ADDED_LATER).toBe('present');
    expect(process.env.EMPTY).toBeUndefined();
    expect(process.env.NUMERIC).toBeUndefined();
  });

  it('override:false keeps values the task definition already set (ECS)', async () => {
    process.env.DATABASE_SECRET_ARN = 'arn:db';
    process.env.APP_SECRETS_ARN = 'arn:app';
    process.env.EMAIL_FROM = 'Aivota <noreply@aivota.ai>';
    process.env.DATABASE_URL = 'postgres://from-task-def';
    await loadAwsSecrets({ override: false, fetchSecret, log: silent });
    expect(process.env.EMAIL_FROM).toBe('Aivota <noreply@aivota.ai>');
    expect(process.env.DATABASE_URL).toBe('postgres://from-task-def');
    expect(process.env.OPENAI_API_KEY).toBe('sk-secret');
  });

  it('override:true lets the secret replace the environment (Lambda)', async () => {
    process.env.DATABASE_SECRET_ARN = 'arn:db';
    process.env.APP_SECRETS_ARN = 'arn:app';
    process.env.EMAIL_FROM = 'Aivota <noreply@aivota.ai>';
    await loadAwsSecrets({ override: true, fetchSecret, log: silent });
    expect(process.env.EMAIL_FROM).toBe('stale-smtp@gmail.com');
  });

  it('is a no-op outside AWS when DATABASE_URL is already present', async () => {
    process.env.DATABASE_URL = 'postgres://local';
    const loaded = await loadAwsSecrets({ override: false, fetchSecret, log: silent });
    expect(loaded).toBe(false);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it('fails closed when neither ARNs nor DATABASE_URL exist', async () => {
    await expect(loadAwsSecrets({ override: false, fetchSecret, log: silent }))
      .rejects.toThrow(/DATABASE_SECRET_ARN and APP_SECRETS_ARN/);
  });

  it('fails when the database secret has no DATABASE_URL and none is set', async () => {
    process.env.DATABASE_SECRET_ARN = 'arn:app'; // wrong secret on purpose
    await expect(loadAwsSecrets({ override: false, fetchSecret, log: silent }))
      .rejects.toThrow(/DATABASE_URL not found/);
  });
});
