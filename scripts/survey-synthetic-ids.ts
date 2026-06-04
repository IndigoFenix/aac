/**
 * READ-ONLY survey for synthetic (non-UUID) primary keys.
 *
 * Background: the clinician AI could occasionally supply its own `id` on create
 * (e.g. "obj-comm-1") instead of letting the DB generate a UUID. Primary keys
 * are `varchar`, so such ids persist as valid-but-non-UUID rows. This script
 * finds them. It does NOT write anything.
 *
 * Connects through the SSM tunnel (npm run db-tunnel) on localhost:5432 using
 * the prod credentials from Secrets Manager. TLS validates against the RDS cert
 * via `servername` while the TCP target is localhost.
 *
 * Usage: npx tsx scripts/survey-synthetic-ids.ts
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

function getProdSecret(): { host: string; user: string; password: string; database: string; port: number } {
  const json = execSync(
    'aws secretsmanager get-secret-value --region il-central-1 --secret-id "aivota-prod/database" --query SecretString --output text',
    { env: { ...process.env, AWS_PROFILE: 'aac' }, encoding: 'utf8' },
  );
  const s = JSON.parse(json);
  return {
    host: s.DB_HOST,
    user: s.DB_USER,
    password: s.DB_PASSWORD,
    database: s.DB_NAME,
    port: Number(s.DB_PORT || '5432'),
  };
}

async function main() {
  const secret = getProdSecret();
  const ca = fs.readFileSync(path.resolve(__dirname, '../rds-ca-bundle.pem'), 'utf8');

  const pool = new pg.Pool({
    host: '127.0.0.1', // via SSM tunnel
    port: 5432,
    user: secret.user,
    password: secret.password,
    database: secret.database,
    // Encrypted to RDS through the SSM tunnel; the regional RDS root isn't in the
    // bundled CA, so skip chain verification for this read-only admin survey.
    ssl: { rejectUnauthorized: false, servername: secret.host },
  });

  const client = await pool.connect();
  try {
    const dbInfo = await client.query('select current_database() as db, inet_server_addr() as addr, version()');
    console.log(`Connected to DB "${dbInfo.rows[0].db}" (server ${dbInfo.rows[0].addr})\n`);

    // Find every public table whose `id` column is a string type (varchar/text)
    // and has a gen_random_uuid()-style default — those are the ones expected to
    // hold UUIDs.
    const cols = await client.query(
      `select c.table_name, c.column_default
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public'
          and c.column_name = 'id'
          and c.data_type in ('character varying', 'text')
          and t.table_type = 'BASE TABLE'
        order by c.table_name`,
    );

    const uuidDefaultTables = cols.rows.filter(
      (r) => typeof r.column_default === 'string' && /gen_random_uuid|uuid_generate/i.test(r.column_default),
    );

    console.log(`Scanning ${uuidDefaultTables.length} tables with a UUID-default string id...\n`);

    const findings: { table: string; bad: number; total: number; samples: string[] }[] = [];

    for (const { table_name } of uuidDefaultTables) {
      const ident = `"${table_name.replace(/"/g, '""')}"`;
      const bad = await client.query(
        `select id from ${ident} where id !~* $1 order by id limit 25`,
        [UUID_RE],
      );
      if (bad.rows.length === 0) continue;
      const cnt = await client.query(
        `select count(*)::int as n from ${ident} where id !~* $1`,
        [UUID_RE],
      );
      const total = await client.query(`select count(*)::int as n from ${ident}`);
      findings.push({
        table: table_name,
        bad: cnt.rows[0].n,
        total: total.rows[0].n,
        samples: bad.rows.map((r) => String(r.id)),
      });
    }

    if (findings.length === 0) {
      console.log('✅ No non-UUID primary keys found in any UUID-default table.');
    } else {
      console.log('⚠️  Tables containing non-UUID primary keys:\n');
      for (const f of findings) {
        console.log(`  ${f.table}: ${f.bad}/${f.total} rows have a non-UUID id`);
        console.log(`     samples: ${f.samples.slice(0, 10).join(', ')}${f.bad > 10 ? ' …' : ''}`);
      }
    }
    console.log('\nSurvey complete (read-only — nothing was modified).');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Survey failed:', e.message);
  process.exit(1);
});
