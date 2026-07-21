/**
 * Test DB helpers.
 *
 * Re-exports the shared `db` and `pool` from server/db.ts so tests, factories,
 * and services all hit the same connection pool. `truncateAll()` is opt-in:
 * import it and put `afterEach(truncateAll)` in any test file that wants a
 * clean DB between tests. (Not wired globally, so legacy tests that build
 * fixtures in `beforeAll` keep working.)
 */

import { db, pool } from '../../db.js';

export { db, pool };

let cachedTables: string[] | null = null;
let guardChecked = false;

/**
 * Pure guard: throw unless it is safe to truncate the database named `dbName`.
 * Extracted so it can be unit-tested without a live connection.
 *
 * Two layers, because a bare "name contains test" rule is only coincidental
 * protection — it happens to work only because the real DB is named `postgres`
 * (no "test" in it). The incident that motivated this wiped `postgres`; the
 * instance is *named* `aac-test`, but the DATABASE was `postgres`, so this
 * checks the database name, never the host/instance.
 *
 *  1. `dbName` must contain "test" (case-insensitive) — blocks `postgres` etc.
 *  2. If an expected test DB is known (parsed from TEST_DATABASE_URL), `dbName`
 *     must EQUAL it exactly — so we only ever truncate the one configured test
 *     database, not any database that merely has "test" somewhere in its name.
 */
export function assertTruncatable(dbName: string, expectedTestDb?: string): void {
  if (!dbName.toLowerCase().includes('test')) {
    throw new Error(
      `[truncateAll] REFUSING to truncate: connected database "${dbName}" does not contain ` +
        `"test". This is a hard guard against wiping a real database. Point DATABASE_URL/` +
        `TEST_DATABASE_URL at a dedicated test database whose name contains "test".`,
    );
  }
  if (expectedTestDb && dbName !== expectedTestDb) {
    throw new Error(
      `[truncateAll] REFUSING to truncate: connected database "${dbName}" is not the configured ` +
        `test database "${expectedTestDb}" (from TEST_DATABASE_URL). truncateAll only ever wipes ` +
        `the exact database TEST_DATABASE_URL points at.`,
    );
  }
}

/** Parse the database name out of TEST_DATABASE_URL, or undefined if unset/unparseable. */
function expectedTestDbName(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return undefined;
  try {
    return new URL(url).pathname.replace(/^\//, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hard safety check: refuse to truncate unless the DB we are actually connected
 * to is the configured test database. This queries `current_database()` on the
 * live pool — NOT the DATABASE_URL string — so it catches every path that could
 * point the pool at a real database (a dropped `globalSetup`, an inherited
 * `DATABASE_URL` from `.env`, a mis-set `TEST_DATABASE_URL`). This once wiped a
 * live DB; the guard exists so `truncateAll()` can never do that again, whatever
 * config runs it.
 */
async function assertTestDatabase(): Promise<void> {
  if (guardChecked) return;
  const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db');
  assertTruncatable(rows[0]?.db ?? '', expectedTestDbName());
  guardChecked = true;
}

async function getUserTables(): Promise<string[]> {
  if (cachedTables) return cachedTables;
  const { rows } = await pool.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('__drizzle_migrations')
    ORDER BY tablename
  `);
  cachedTables = rows.map((r) => r.tablename);
  return cachedTables;
}

/**
 * Truncate every user table in the public schema in one statement.
 * CASCADE handles FK ordering. Identity sequences are reset.
 */
export async function truncateAll(): Promise<void> {
  await assertTestDatabase();
  const tables = await getUserTables();
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
