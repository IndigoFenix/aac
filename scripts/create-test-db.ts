/**
 * Create a separate database on the same RDS instance for the integration
 * test suite. Reads DATABASE_URL from .env, connects to that instance, and
 * issues `CREATE DATABASE <name>` if it doesn't already exist. Idempotent.
 *
 * Usage:  tsx scripts/create-test-db.ts
 *
 * Optional env override: TEST_DB_NAME (default: aac_integration_test).
 *
 * After this completes, add a line like the following to .env:
 *   TEST_DATABASE_URL="postgres://USER:PASS@HOST:5432/aac_integration_test"
 * (the script prints the exact value to copy)
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'aac_integration_test';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to .env first.');
  process.exit(1);
}

if (!/^[a-z][a-z0-9_]*$/i.test(TEST_DB_NAME)) {
  console.error(`Refusing to create DB with unsafe name: ${TEST_DB_NAME}`);
  process.exit(1);
}

if (!TEST_DB_NAME.toLowerCase().includes('test')) {
  console.error(
    `TEST_DB_NAME must contain "test" (got "${TEST_DB_NAME}") — global-setup.ts uses this as a guardrail.`,
  );
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
const adminDb = url.pathname.slice(1) || 'postgres';

if (adminDb === TEST_DB_NAME) {
  console.error(
    `DATABASE_URL already points at "${TEST_DB_NAME}". Pick a different TEST_DB_NAME.`,
  );
  process.exit(1);
}

const caBundlePath = path.resolve(__dirname, '../rds-ca-bundle.pem');
const ca = fs.existsSync(caBundlePath)
  ? fs.readFileSync(caBundlePath, 'utf8')
  : undefined;

const sslDisabled = /[?&]sslmode=disable/.test(process.env.DATABASE_URL);

const pool = new pg.Pool({
  host: url.hostname,
  port: Number(url.port || '5432'),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: adminDb,
  ssl: sslDisabled
    ? false
    : ca
      ? { ca }
      : { rejectUnauthorized: false },
});

async function main() {
  console.log(`Connecting to ${url.hostname}/${adminDb} as ${url.username}...`);

  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
      [TEST_DB_NAME],
    );

    if (rows[0]?.exists) {
      console.log(`Database "${TEST_DB_NAME}" already exists — nothing to do.`);
    } else {
      // CREATE DATABASE cannot run inside a transaction; pg auto-commits this.
      // The identifier is validated against [a-z0-9_] above so direct interpolation is safe.
      await client.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
      console.log(`Created database "${TEST_DB_NAME}".`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  // Build the TEST_DATABASE_URL the user should set.
  const testUrl = new URL(process.env.DATABASE_URL!);
  testUrl.pathname = `/${TEST_DB_NAME}`;

  console.log('');
  console.log('Add this line to your .env (or export it before running tests):');
  console.log('');
  console.log(`TEST_DATABASE_URL="${testUrl.toString()}"`);
  console.log('');
  console.log('Then run:  npm test');
  console.log(
    '(The Jest globalSetup will run Drizzle migrations against this DB on first test run.)',
  );
}

main().catch((err) => {
  console.error('\nFailed to create test database:', err);
  process.exit(1);
});
