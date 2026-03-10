/**
 * Copy personas and topics tables from staging to production.
 *
 * Prerequisites:
 *   1. Run `npm run db-tunnel` in another terminal to open the SSM tunnel.
 *   2. Either set PROD_DATABASE_URL, or the script fetches creds from Secrets Manager.
 *
 * Usage:
 *   npx tsx scripts/copy-tables-to-prod.ts
 *   PROD_DATABASE_URL="postgresql://..." npx tsx scripts/copy-tables-to-prod.ts
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Client } = pg;
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import * as readline from "readline";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const TABLES = ["personas", "topics"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getProdConnectionString(): Promise<string> {
  if (process.env.PROD_DATABASE_URL) {
    return process.env.PROD_DATABASE_URL;
  }

  console.log("PROD_DATABASE_URL not set — fetching credentials from AWS Secrets Manager...");
  const region = "il-central-1";
  const profile = process.env.AWS_PROFILE || "aac";
  process.env.AWS_PROFILE = profile;

  const sm = new SecretsManagerClient({ region });

  // Try common secret name patterns
  const secretNames = [
    "aivota-prod-database-credentials",
    "aivota-prod/database",
    "aivota-prod-db",
  ];

  // List secrets to find the right one
  let secretJson: Record<string, string> | null = null;
  for (const name of secretNames) {
    try {
      const resp = await sm.send(new GetSecretValueCommand({ SecretId: name }));
      if (resp.SecretString) {
        secretJson = JSON.parse(resp.SecretString);
        console.log(`Found secret: ${name}`);
        break;
      }
    } catch {
      // try next
    }
  }

  if (!secretJson?.DATABASE_URL) {
    console.error(
      "Could not auto-discover production credentials from Secrets Manager.\n" +
      "Please set PROD_DATABASE_URL manually, e.g.:\n" +
      '  PROD_DATABASE_URL="postgresql://user:pass@localhost:5432/aivota" npx tsx scripts/copy-tables-to-prod.ts'
    );
    process.exit(1);
  }

  // Replace the RDS hostname with localhost since we're going through the tunnel
  const url = new URL(secretJson.DATABASE_URL);
  url.hostname = "localhost";
  // Remove sslmode for local tunnel
  url.searchParams.delete("sslmode");
  return url.toString();
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function copyTable(
  staging: Client,
  prod: Client,
  table: string,
): Promise<number> {
  console.log(`\n--- Copying table: ${table} ---`);

  // Read all rows from staging
  const { rows } = await staging.query(`SELECT * FROM ${table}`);
  console.log(`  Read ${rows.length} rows from staging`);

  if (rows.length === 0) {
    console.log("  Nothing to copy — skipping");
    return 0;
  }

  // For topics: disable the self-referential FK + unique constraint, then re-enable
  const isTopics = table === "topics";

  if (isTopics) {
    console.log("  Dropping self-referential FK and unique constraints...");
    // Find and drop the FK constraint on parent_id
    const fkResult = await prod.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'topics'::regclass
        AND contype = 'f'
        AND conname LIKE '%parent_id%'
    `);
    for (const { conname } of fkResult.rows) {
      await prod.query(`ALTER TABLE topics DROP CONSTRAINT "${conname}"`);
      console.log(`    Dropped FK: ${conname}`);
    }
    // Find and drop the unique constraint on (title, parent_id)
    const uqResult = await prod.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'topics'::regclass
        AND contype = 'u'
    `);
    for (const { conname } of uqResult.rows) {
      await prod.query(`ALTER TABLE topics DROP CONSTRAINT "${conname}"`);
      console.log(`    Dropped unique: ${conname}`);
    }
  }

  // Truncate the production table
  console.log(`  Truncating ${table} on production...`);
  await prod.query(`TRUNCATE TABLE ${table} CASCADE`);

  // Build column list from first row
  const columns = Object.keys(rows[0]);
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

  // Insert rows
  console.log(`  Inserting ${rows.length} rows into production...`);
  let inserted = 0;
  for (const row of rows) {
    const values = columns.map((c) => row[c]);
    await prod.query(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`, values);
    inserted++;
  }

  if (isTopics) {
    console.log("  Re-creating self-referential FK and unique constraints...");
    await prod.query(`
      ALTER TABLE topics
      ADD CONSTRAINT topics_parent_id_topics_id_fk
      FOREIGN KEY (parent_id) REFERENCES topics(id)
    `);
    await prod.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_title_parent
      ON topics (title, parent_id)
    `);
    console.log("    Constraints restored");
  }

  console.log(`  Done — ${inserted} rows copied`);
  return inserted;
}

async function main() {
  const stagingUrl = process.env.DATABASE_URL;
  if (!stagingUrl) {
    console.error("DATABASE_URL not set — cannot connect to staging. Check .env");
    process.exit(1);
  }

  const prodUrl = await getProdConnectionString();

  // Show what we're about to do
  const stagingParsed = new URL(stagingUrl);
  const prodParsed = new URL(prodUrl);
  console.log("\n=== Copy Tables: Staging → Production ===");
  console.log(`  Staging : ${stagingParsed.hostname}:${stagingParsed.port || 5432}/${stagingParsed.pathname.slice(1)}`);
  console.log(`  Prod    : ${prodParsed.hostname}:${prodParsed.port || 5432}/${prodParsed.pathname.slice(1)}`);
  console.log(`  Tables  : ${TABLES.join(", ")}`);
  console.log("\n  WARNING: This will DROP all existing data in these tables on production!\n");

  const confirm = await ask("Type 'yes' to proceed: ");
  if (confirm.toLowerCase() !== "yes") {
    console.log("Aborted.");
    process.exit(0);
  }

  // Connect to both databases
  const staging = new Client({
    connectionString: stagingUrl,
    ssl: stagingUrl.includes("rds.amazonaws.com") ? { rejectUnauthorized: false } : undefined,
  });
  const prod = new Client({
    connectionString: prodUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log("\nConnecting to staging...");
    await staging.connect();
    console.log("Connected to staging");

    console.log("Connecting to production...");
    await prod.connect();
    console.log("Connected to production");

    // Run the full copy inside a production transaction
    await prod.query("BEGIN");

    const results: Record<string, number> = {};
    for (const table of TABLES) {
      results[table] = await copyTable(staging, prod, table);
    }

    await prod.query("COMMIT");

    console.log("\n=== Summary ===");
    for (const [table, count] of Object.entries(results)) {
      console.log(`  ${table}: ${count} rows`);
    }
    console.log("\nDone!");
  } catch (err) {
    console.error("\nError during copy — rolling back production changes...");
    try {
      await prod.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    await staging.end().catch(() => {});
    await prod.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
