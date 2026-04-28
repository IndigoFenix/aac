/**
 * Jest global setup — runs once before any test workers spin up.
 *
 * - Loads .env so TEST_DATABASE_URL is available without manual export.
 * - Asserts the resolved DB name contains "test" so we never truncate prod.
 * - Sets process.env.DATABASE_URL so server/db.ts uses the test DB on import.
 * - Runs Drizzle migrations so the schema is up to date before tests run.
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

dotenv.config();

const DEFAULT_TEST_URL = 'postgresql://test:test@localhost:5432/test_db';

export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;
  if (!process.env.TEST_DATABASE_URL) {
    console.warn(
      '[test setup] TEST_DATABASE_URL is not set — falling back to local default. ' +
        'Run `npm run db:create-test` and add the printed TEST_DATABASE_URL to .env.',
    );
  }

  // Guardrail: refuse to run if the DB name doesn't contain "test".
  // Parses out the path from the URL (the part after the last '/').
  const dbName = (() => {
    try {
      return new URL(url).pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  })();

  if (!dbName.toLowerCase().includes('test')) {
    throw new Error(
      `[test setup] Refusing to run: database name "${dbName}" does not contain "test". ` +
        `Set TEST_DATABASE_URL to a dedicated test database.`,
    );
  }

  // Set DATABASE_URL so server/db.ts (and any service that imports it) connects to the test DB.
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';

  // Connect with a one-off pool to run migrations. We mirror server/db.ts's relaxed SSL
  // config so RDS-style URLs work, but honor sslmode=disable for plain-local Postgres.
  // If a CA bundle is present (./rds-ca-bundle.pem), use it for cert verification.
  const sslDisabled = /[?&]sslmode=disable/.test(url);
  const cleanUrl = url.replace(/[?&]sslmode=[^&]*/g, '');

  const caBundlePath = path.resolve(process.cwd(), 'rds-ca-bundle.pem');
  const ca = fs.existsSync(caBundlePath)
    ? fs.readFileSync(caBundlePath, 'utf8')
    : undefined;

  const pool = new pg.Pool({
    connectionString: cleanUrl,
    ssl: sslDisabled
      ? false
      : ca
        ? { ca }
        : { rejectUnauthorized: false },
    max: 2,
  });

  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
  } catch (err: any) {
    // pg throws AggregateError for connection failures; the default toString
    // hides the underlying causes. Print them so the user can act.
    const safeUrl = (() => {
      try {
        const u = new URL(url);
        u.password = '***';
        return u.toString();
      } catch {
        return '<unparseable url>';
      }
    })();
    console.error(`[test setup] Migration/connection failed against ${safeUrl}`);
    if (err && typeof err === 'object' && 'errors' in err && Array.isArray((err as any).errors)) {
      for (const cause of (err as any).errors) {
        console.error('  cause:', cause?.code ?? '', cause?.message ?? cause);
      }
    } else {
      console.error('  error:', err?.message ?? err);
    }
    throw err;
  } finally {
    await pool.end();
  }
}
