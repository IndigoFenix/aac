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
  const tables = await getUserTables();
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
