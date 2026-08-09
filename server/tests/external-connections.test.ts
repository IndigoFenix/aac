/**
 * The credentials vault, pure half — no database.
 *
 * Two things are pinned here:
 *
 *   1. tokens survive an encrypt→decrypt round trip and never sit in the
 *      ciphertext in the clear (the vault's whole reason to exist), and
 *   2. the lazy-migration decision: vault beats the legacy plaintext
 *      `appConfig.<app>.<secret>` blob, and stripping that secret takes out the
 *      ONE key without disturbing any sibling — Spotify's plaintext refresh
 *      token shared appConfig with youtube/gameOptions/social_trainer state that
 *      a clobbering write would have destroyed.
 *
 * The DB-backed half lives in server/tests/integration/external-connections.test.ts
 * (this config runs without Postgres).
 */

import { describe, it, expect } from '@jest/globals';
import { encrypt, decrypt } from '../services/encryption.js';
import {
  chooseTokenSource,
  stripLegacySecret,
} from '../services/externalConnectionsService.js';

describe('vault encryption', () => {
  it('round-trips a refresh token', async () => {
    const token = 'AQD-spotify-refresh-token-abc123';
    const ciphertext = await encrypt(token);
    expect(await decrypt(ciphertext)).toBe(token);
  });

  it('never leaves the secret readable in the stored value', async () => {
    const token = 'AQD-spotify-refresh-token-abc123';
    const ciphertext = await encrypt(token);
    expect(ciphertext).not.toContain(token);
    // iv:salt:authTag:ciphertext, all hex
    expect(ciphertext.split(':')).toHaveLength(4);
    expect(ciphertext).toMatch(/^[0-9a-f:]+$/);
  });

  it('produces different ciphertext each time (random iv + salt)', async () => {
    const a = await encrypt('same-token');
    const b = await encrypt('same-token');
    expect(a).not.toBe(b);
    expect(await decrypt(a)).toBe(await decrypt(b));
  });

  it('rejects ciphertext that does not decrypt (rotated key / tampering)', async () => {
    const ciphertext = await encrypt('secret');
    const parts = ciphertext.split(':');
    parts[3] = parts[3].replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    await expect(decrypt(parts.join(':'))).rejects.toThrow();
  });
});

describe('chooseTokenSource — which store wins', () => {
  it('prefers the vault and asks for no migration', () => {
    expect(chooseTokenSource('vault-token', 'legacy-token')).toEqual({
      token: 'vault-token',
      source: 'vault',
      needsMigration: false,
    });
  });

  it('falls back to the legacy blob and flags the migration', () => {
    expect(chooseTokenSource(undefined, 'legacy-token')).toEqual({
      token: 'legacy-token',
      source: 'legacy',
      needsMigration: true,
    });
    expect(chooseTokenSource(null, 'legacy-token').source).toBe('legacy');
  });

  it('reports none when neither store holds a token', () => {
    expect(chooseTokenSource(undefined, undefined)).toEqual({
      token: null,
      source: 'none',
      needsMigration: false,
    });
  });

  it('treats empty strings and non-strings as absent', () => {
    expect(chooseTokenSource('', 'legacy-token').source).toBe('legacy');
    expect(chooseTokenSource('', '').source).toBe('none');
    expect(chooseTokenSource(undefined, { nope: true }).source).toBe('none');
    expect(chooseTokenSource(undefined, 12345).source).toBe('none');
  });
});

describe('stripLegacySecret — surgical removal from appConfig', () => {
  const fullConfig = () => ({
    youtube: { permitted: ['abc'] },
    gameOptions: { useAi: 'energy' },
    spotify: { enabled: true, connected: true, accountEmail: 'a@b.c', refreshToken: 'plain-text' },
  });

  it('removes only the secret key, keeping every sibling', () => {
    const { appConfig, changed } = stripLegacySecret(fullConfig(), 'spotify', 'refreshToken');
    expect(changed).toBe(true);
    expect(appConfig.spotify).toEqual({ enabled: true, connected: true, accountEmail: 'a@b.c' });
    expect(appConfig.youtube).toEqual({ permitted: ['abc'] });
    expect(appConfig.gameOptions).toEqual({ useAi: 'energy' });
  });

  it('does not mutate the caller\'s object', () => {
    const original = fullConfig();
    stripLegacySecret(original, 'spotify', 'refreshToken');
    expect(original.spotify.refreshToken).toBe('plain-text');
  });

  it('reports no change when the secret is already gone', () => {
    const clean = { spotify: { enabled: true }, youtube: {} };
    const { appConfig, changed } = stripLegacySecret(clean, 'spotify', 'refreshToken');
    expect(changed).toBe(false);
    expect(appConfig).toEqual(clean);
  });

  it('reports no change when the app section or the whole blob is missing', () => {
    expect(stripLegacySecret({ youtube: {} }, 'spotify', 'refreshToken').changed).toBe(false);
    expect(stripLegacySecret(null, 'spotify', 'refreshToken')).toEqual({ appConfig: {}, changed: false });
    expect(stripLegacySecret(undefined, 'spotify', 'refreshToken')).toEqual({ appConfig: {}, changed: false });
  });

  it('strips an explicit null/undefined-valued secret key too', () => {
    const { changed, appConfig } = stripLegacySecret(
      { spotify: { enabled: true, refreshToken: null } },
      'spotify',
      'refreshToken',
    );
    expect(changed).toBe(true);
    expect('refreshToken' in appConfig.spotify).toBe(false);
  });
});
