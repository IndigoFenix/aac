/**
 * The credentials vault against a real database, plus the Spotify remediation
 * it exists for.
 *
 * The flaw being fixed: per-student Spotify refresh tokens were stored in
 * PLAINTEXT inside `aac_settings.app_config`, a jsonb blob the client can write
 * through the normal settings save path. Secrets now live encrypted in
 * `external_connections`, one row per (student, provider).
 *
 * No SQL backfill is possible — the ciphertext only exists app-side — so the
 * move is a LAZY code-path migration: the first token fetch after deploy reads
 * the legacy blob, encrypts it into the vault, and strips ONLY that one key back
 * out of appConfig. The tests below pin both halves: the secret really does move,
 * and every unrelated appConfig key survives the strip.
 *
 * Pure logic (encryption round trip, source choice, strip semantics) is in
 * server/tests/external-connections.test.ts, which needs no DB.
 */

import { describe, it, expect, afterEach, beforeEach, afterAll } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { externalConnections } from '@shared/schema';
import { truncateAll, db } from '../helpers/db.js';
import { makeReq, makeRes } from '../helpers/http.js';
import { makeUser, makeStudent } from '../helpers/factories.js';
import {
  getConnection,
  getDecryptedTokens,
  upsertConnection,
  deleteConnection,
} from '../../services/externalConnectionsService.js';
import { aacSettingsRepository } from '../../repositories/aacSettingsRepository.js';
import { spotifyController } from '../../controllers/spotifyController.js';

/** Owner of the most recently created student — the Spotify controller now
 *  verifies student access, so its fake requests carry this user. */
let ownerId = "";

async function newStudentId(): Promise<string> {
  const owner = await makeUser();
  const { student } = await makeStudent(owner.id);
  ownerId = owner.id;
  return student.id;
}

describe('external_connections vault', () => {
  afterEach(truncateAll);

  it('stores tokens encrypted and hands them back decrypted', async () => {
    const studentId = await newStudentId();

    await upsertConnection(studentId, 'spotify', {
      refreshToken: 'AQD-refresh-plain',
      accessToken: 'BQC-access-plain',
      providerAccountId: 'parent@example.com',
      metadata: { accountEmail: 'parent@example.com' },
    });

    const row = await getConnection(studentId, 'spotify');
    expect(row).toBeTruthy();
    expect(row!.encryptedRefreshToken).toBeTruthy();
    expect(row!.encryptedRefreshToken).not.toContain('AQD-refresh-plain');
    expect(row!.encryptedAccessToken).not.toContain('BQC-access-plain');
    expect(row!.providerAccountId).toBe('parent@example.com');
    expect(row!.metadata).toEqual({ accountEmail: 'parent@example.com' });

    const tokens = await getDecryptedTokens(studentId, 'spotify');
    expect(tokens).toEqual({
      refreshToken: 'AQD-refresh-plain',
      accessToken: 'BQC-access-plain',
      tokenExpiresAt: null,
    });
  });

  it('keeps ONE row per (student, provider) and leaves omitted fields alone', async () => {
    const studentId = await newStudentId();

    await upsertConnection(studentId, 'spotify', {
      refreshToken: 'first',
      providerAccountId: 'parent@example.com',
      metadata: { accountEmail: 'parent@example.com' },
    });
    await upsertConnection(studentId, 'spotify', {
      refreshToken: 'rotated',
      metadata: { scopes: ['streaming'] },
    });

    const rows = await db
      .select()
      .from(externalConnections)
      .where(eq(externalConnections.studentId, studentId));
    expect(rows).toHaveLength(1);
    // providerAccountId was not in the second patch, so it survives; metadata merges.
    expect(rows[0].providerAccountId).toBe('parent@example.com');
    expect(rows[0].metadata).toEqual({ accountEmail: 'parent@example.com', scopes: ['streaming'] });
    expect((await getDecryptedTokens(studentId, 'spotify'))!.refreshToken).toBe('rotated');
  });

  it('scopes rows per provider and per student', async () => {
    const a = await newStudentId();
    const b = await newStudentId();

    await upsertConnection(a, 'spotify', { refreshToken: 'a-spotify' });
    await upsertConnection(a, 'alexa', { refreshToken: 'a-alexa' });
    await upsertConnection(b, 'spotify', { refreshToken: 'b-spotify' });

    expect((await getDecryptedTokens(a, 'spotify'))!.refreshToken).toBe('a-spotify');
    expect((await getDecryptedTokens(a, 'alexa'))!.refreshToken).toBe('a-alexa');
    expect((await getDecryptedTokens(b, 'spotify'))!.refreshToken).toBe('b-spotify');
    expect(await getDecryptedTokens(b, 'alexa')).toBeNull();
  });

  it('clears a token on an explicit null and deletes the row on disconnect', async () => {
    const studentId = await newStudentId();
    await upsertConnection(studentId, 'spotify', { refreshToken: 'x', accessToken: 'y' });

    await upsertConnection(studentId, 'spotify', { accessToken: null });
    const tokens = await getDecryptedTokens(studentId, 'spotify');
    expect(tokens!.accessToken).toBeUndefined();
    expect(tokens!.refreshToken).toBe('x');

    expect(await deleteConnection(studentId, 'spotify')).toBe(true);
    expect(await getConnection(studentId, 'spotify')).toBeNull();
    expect(await getDecryptedTokens(studentId, 'spotify')).toBeNull();
    expect(await deleteConnection(studentId, 'spotify')).toBe(false);
  });

  it('reports a row it cannot decrypt as NOT connected (forces a clean re-link)', async () => {
    const studentId = await newStudentId();
    await upsertConnection(studentId, 'spotify', { refreshToken: 'x' });
    // Simulate a rotated ENCRYPTION_KEY: ciphertext that no longer decrypts.
    await db
      .update(externalConnections)
      .set({ encryptedRefreshToken: 'deadbeef:deadbeef:deadbeef:deadbeef' })
      .where(eq(externalConnections.studentId, studentId));

    expect(await getDecryptedTokens(studentId, 'spotify')).toBeNull();
    // The row itself is still there — only the read degrades.
    expect(await getConnection(studentId, 'spotify')).toBeTruthy();
  });
});

describe('Spotify controller — lazy migration off the plaintext blob', () => {
  const realFetch = global.fetch;
  const realId = process.env.SPOTIFY_CLIENT_ID;
  const realSecret = process.env.SPOTIFY_CLIENT_SECRET;
  let fetchCalls: any[] = [];
  let refreshResponse: Record<string, unknown> = { access_token: 'fresh-access', expires_in: 3600 };

  beforeEach(() => {
    process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
    process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';
    fetchCalls = [];
    refreshResponse = { access_token: 'fresh-access', expires_in: 3600 };
    global.fetch = (async (url: any, init: any) => {
      fetchCalls.push({ url, init });
      return { ok: true, json: async () => refreshResponse, text: async () => '' } as any;
    }) as typeof fetch;
  });

  afterEach(async () => {
    global.fetch = realFetch;
    await truncateAll();
  });

  afterAll(() => {
    if (realId === undefined) delete process.env.SPOTIFY_CLIENT_ID;
    else process.env.SPOTIFY_CLIENT_ID = realId;
    if (realSecret === undefined) delete process.env.SPOTIFY_CLIENT_SECRET;
    else process.env.SPOTIFY_CLIENT_SECRET = realSecret;
  });

  /** The body of the call to Spotify's token endpoint (fixture setup may fetch too). */
  function spotifyTokenCallBody(): string {
    const call = fetchCalls.find((c) => String(c.url).includes('accounts.spotify.com/api/token'));
    expect(call).toBeTruthy();
    return String(call.init.body);
  }

  /** A student whose settings still hold the pre-vault plaintext token. */
  async function legacyStudent(): Promise<string> {
    const studentId = await newStudentId();
    await aacSettingsRepository.upsert(studentId, {
      appConfig: {
        youtube: { permitted: ['channel-1'] },
        gameOptions: { useAi: 'energy' },
        spotify: {
          enabled: true,
          connected: true,
          accountEmail: 'parent@example.com',
          refreshToken: 'legacy-plaintext-token',
        },
      },
    } as any);
    return studentId;
  }

  it('serves a token from the legacy blob, then moves it into the vault', async () => {
    const studentId = await legacyStudent();

    const { res, capture } = makeRes();
    await spotifyController.getToken(makeReq({ user: { id: ownerId }, query: { studentId } }), res);

    expect(capture.statusCode).toBe(200);
    expect(capture.jsonBody).toEqual({ accessToken: 'fresh-access', expiresIn: 3600 });
    // The legacy secret is what was presented to Spotify.
    expect(spotifyTokenCallBody()).toContain('legacy-plaintext-token');

    // …and it now lives encrypted in the vault.
    const row = await getConnection(studentId, 'spotify');
    expect(row!.encryptedRefreshToken).not.toContain('legacy-plaintext-token');
    expect((await getDecryptedTokens(studentId, 'spotify'))!.refreshToken).toBe(
      'legacy-plaintext-token',
    );
  });

  it('strips ONLY refreshToken from appConfig, preserving every other key', async () => {
    const studentId = await legacyStudent();

    const { res } = makeRes();
    await spotifyController.getToken(makeReq({ user: { id: ownerId }, query: { studentId } }), res);

    const settings = await aacSettingsRepository.getByStudentId(studentId);
    const appConfig = settings!.appConfig as Record<string, any>;
    expect(appConfig.spotify.refreshToken).toBeUndefined();
    expect('refreshToken' in appConfig.spotify).toBe(false);
    expect(appConfig.spotify).toEqual({
      enabled: true,
      connected: true,
      accountEmail: 'parent@example.com',
    });
    expect(appConfig.youtube).toEqual({ permitted: ['channel-1'] });
    expect(appConfig.gameOptions).toEqual({ useAi: 'energy' });
  });

  it('prefers the vault once migrated and never rewrites appConfig', async () => {
    const studentId = await newStudentId();
    await aacSettingsRepository.upsert(studentId, {
      appConfig: { spotify: { enabled: true, connected: true, accountEmail: 'p@e.c' } },
    } as any);
    await upsertConnection(studentId, 'spotify', { refreshToken: 'vault-token' });

    const { res, capture } = makeRes();
    await spotifyController.getToken(makeReq({ user: { id: ownerId }, query: { studentId } }), res);

    expect(capture.statusCode).toBe(200);
    expect(spotifyTokenCallBody()).toContain('vault-token');
    const appConfig = (await aacSettingsRepository.getByStudentId(studentId))!
      .appConfig as Record<string, any>;
    expect(appConfig.spotify).toEqual({ enabled: true, connected: true, accountEmail: 'p@e.c' });
  });

  it('stores a rotated refresh token in the vault only', async () => {
    const studentId = await newStudentId();
    await upsertConnection(studentId, 'spotify', { refreshToken: 'old-token' });
    refreshResponse = { access_token: 'fresh-access', expires_in: 3600, refresh_token: 'new-token' };

    const { res, capture } = makeRes();
    await spotifyController.getToken(makeReq({ user: { id: ownerId }, query: { studentId } }), res);

    expect(capture.statusCode).toBe(200);
    expect((await getDecryptedTokens(studentId, 'spotify'))!.refreshToken).toBe('new-token');
    const settings = await aacSettingsRepository.getByStudentId(studentId);
    const appConfig = (settings?.appConfig as Record<string, any>) ?? {};
    expect(JSON.stringify(appConfig)).not.toContain('new-token');
  });

  it('404s when neither store has a token', async () => {
    const studentId = await newStudentId();
    const { res, capture } = makeRes();
    await spotifyController.getToken(makeReq({ user: { id: ownerId }, query: { studentId } }), res);
    expect(capture.statusCode).toBe(404);
    expect(capture.jsonBody).toEqual({ error: 'No Spotify account connected' });
  });

  it('disconnect drops the vault row and any plaintext remnant', async () => {
    const studentId = await legacyStudent();
    await upsertConnection(studentId, 'spotify', { refreshToken: 'vault-token' });

    const { res, capture } = makeRes();
    await spotifyController.disconnect(makeReq({ user: { id: ownerId }, query: { studentId } }), res);

    expect(capture.statusCode).toBe(200);
    expect(capture.jsonBody).toEqual({ success: true });
    expect(await getConnection(studentId, 'spotify')).toBeNull();

    const appConfig = (await aacSettingsRepository.getByStudentId(studentId))!
      .appConfig as Record<string, any>;
    expect(JSON.stringify(appConfig)).not.toContain('legacy-plaintext-token');
    expect(appConfig.spotify.connected).toBe(false);
    expect(appConfig.spotify.enabled).toBe(true); // the app stays enabled, just unlinked
    expect(appConfig.youtube).toEqual({ permitted: ['channel-1'] });
  });
});
