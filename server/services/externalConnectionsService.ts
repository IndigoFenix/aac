// server/services/externalConnectionsService.ts
//
// The per-STUDENT credentials vault (`external_connections`).
//
// One row per (student, provider) OAuth link. Tokens are encrypted app-side with
// AES-256-GCM (./encryption) before they ever reach the database, and they are
// NEVER written to `aac_settings.app_config`: that jsonb blob round-trips through
// the client settings save path, so anything in it is client-writable. Serves
// Spotify today; the smart-home account-linking flow (Alexa event gateway /
// Google HomeGraph) stores its tokens here too —
// planning-docs/smart-home-actions.md.
//
// SECURITY — this is a server-internal DATA LAYER, not an authorization boundary.
// It queries `external_connections` by studentId directly, and this codebase has a
// known hazard where direct table queries silently bypass support-mode
// restrictions (support sessions are limited to two predicates enforced further
// up the stack). So every caller MUST have already authorized the caller's access
// to `studentId` before calling in here; this module makes no access-control
// decision of its own and speaks no HTTP.

import { and, eq } from 'drizzle-orm';
import { externalConnections } from '@shared/schema';
import { db } from '../db';
import { decrypt, encrypt } from './encryption';

/** Providers that can hold a per-student connection. `provider` is a text column,
 *  so adding one needs no migration — only a member here. */
export type ExternalProvider = 'spotify' | 'alexa' | 'google';

export type ExternalConnection = typeof externalConnections.$inferSelect;

export interface UpsertConnectionInput {
  /** Plaintext — encrypted here. `null` clears the stored token; omit to leave it. */
  accessToken?: string | null;
  /** Plaintext — encrypted here. `null` clears the stored token; omit to leave it. */
  refreshToken?: string | null;
  providerAccountId?: string | null;
  tokenExpiresAt?: Date | null;
  /** Shallow-merged into the existing metadata so sibling keys survive. */
  metadata?: Record<string, unknown>;
}

export interface DecryptedTokens {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date | null;
}

/** The connection row for (student, provider), or null when there is none. */
export async function getConnection(
  studentId: string,
  provider: ExternalProvider,
): Promise<ExternalConnection | null> {
  const [row] = await db
    .select()
    .from(externalConnections)
    .where(
      and(
        eq(externalConnections.studentId, studentId),
        eq(externalConnections.provider, provider),
      ),
    );
  return row ?? null;
}

/**
 * Create or update the (student, provider) row, encrypting any tokens on the way
 * in. Only the fields present in `input` are touched — an omitted field keeps its
 * stored value, an explicit `null` clears it. The unique index on
 * (student_id, provider) is what actually guarantees one row per pair.
 */
export async function upsertConnection(
  studentId: string,
  provider: ExternalProvider,
  input: UpsertConnectionInput,
): Promise<ExternalConnection> {
  const existing = await getConnection(studentId, provider);

  const patch: Record<string, unknown> = {};
  if (input.accessToken !== undefined) {
    patch.encryptedAccessToken = input.accessToken === null ? null : await encrypt(input.accessToken);
  }
  if (input.refreshToken !== undefined) {
    patch.encryptedRefreshToken = input.refreshToken === null ? null : await encrypt(input.refreshToken);
  }
  if (input.providerAccountId !== undefined) patch.providerAccountId = input.providerAccountId;
  if (input.tokenExpiresAt !== undefined) patch.tokenExpiresAt = input.tokenExpiresAt;
  if (input.metadata !== undefined) {
    const current = (existing?.metadata as Record<string, unknown> | null) ?? {};
    patch.metadata = { ...current, ...input.metadata };
  }

  if (existing) {
    const [updated] = await db
      .update(externalConnections)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(externalConnections.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(externalConnections)
    .values({ studentId, provider, ...patch })
    .returning();
  return created;
}

/**
 * Decrypted tokens for (student, provider), or null when there is no row.
 *
 * A row whose ciphertext will not decrypt (e.g. ENCRYPTION_KEY was rotated) is
 * reported as NO connection rather than throwing: the caller then behaves as if
 * the student were never linked, which forces a clean re-connect instead of
 * wedging every future request on an unreadable secret.
 */
export async function getDecryptedTokens(
  studentId: string,
  provider: ExternalProvider,
): Promise<DecryptedTokens | null> {
  const row = await getConnection(studentId, provider);
  if (!row) return null;

  try {
    const tokens: DecryptedTokens = { tokenExpiresAt: row.tokenExpiresAt ?? null };
    if (row.encryptedAccessToken) tokens.accessToken = await decrypt(row.encryptedAccessToken);
    if (row.encryptedRefreshToken) tokens.refreshToken = await decrypt(row.encryptedRefreshToken);
    return tokens;
  } catch (error: any) {
    console.error(
      `[ExternalConnections] Undecryptable ${provider} tokens for student ${studentId} ` +
        `(treating as not connected):`,
      error?.message || error,
    );
    return null;
  }
}

/** Remove the (student, provider) row. Returns true when a row was deleted. */
export async function deleteConnection(
  studentId: string,
  provider: ExternalProvider,
): Promise<boolean> {
  const deleted = await db
    .delete(externalConnections)
    .where(
      and(
        eq(externalConnections.studentId, studentId),
        eq(externalConnections.provider, provider),
      ),
    )
    .returning();
  return deleted.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy migration off plaintext `appConfig` blobs — pure, so it is unit-testable
// without a database. A SQL backfill is impossible for these secrets (the
// ciphertext only exists app-side), so each student's token moves the first time
// their connection is used.
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenSourceDecision {
  /** The token to use, or null when neither store has one. */
  token: string | null;
  source: 'vault' | 'legacy' | 'none';
  /** True when the token came from the legacy blob and must be moved into the vault. */
  needsMigration: boolean;
}

/**
 * Which store a secret should be read from. Vault always wins; the legacy
 * plaintext blob is only a fallback, and using it means the value still has to be
 * encrypted into the vault and stripped from the blob.
 */
export function chooseTokenSource(
  vaultToken: string | null | undefined,
  legacyToken: unknown,
): TokenSourceDecision {
  if (typeof vaultToken === 'string' && vaultToken.length > 0) {
    return { token: vaultToken, source: 'vault', needsMigration: false };
  }
  if (typeof legacyToken === 'string' && legacyToken.length > 0) {
    return { token: legacyToken, source: 'legacy', needsMigration: true };
  }
  return { token: null, source: 'none', needsMigration: false };
}

/**
 * Remove ONE secret key from one app's section of an appConfig blob, preserving
 * every other appConfig key and every other key inside that section (the house
 * pattern for partial appConfig writes: clone, edit the one branch, write the
 * whole blob back — see aac-settings-memory-schema.ts). Returns the original
 * object identity untouched; `changed` is false when there was nothing to strip,
 * so the caller can skip the write entirely.
 */
export function stripLegacySecret(
  appConfig: Record<string, any> | null | undefined,
  appKey: string,
  secretKey: string,
): { appConfig: Record<string, any>; changed: boolean } {
  const base: Record<string, any> = appConfig && typeof appConfig === 'object' ? { ...appConfig } : {};
  const section = base[appKey];
  if (!section || typeof section !== 'object' || !(secretKey in section)) {
    return { appConfig: base, changed: false };
  }
  const { [secretKey]: _removed, ...rest } = section as Record<string, any>;
  base[appKey] = rest;
  return { appConfig: base, changed: true };
}
