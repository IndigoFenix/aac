/**
 * Normalize synthetic (non-UUID) primary keys in goals/objectives to fresh
 * UUIDs. Runs through the SSM tunnel (npm run db-tunnel) against prod.
 *
 * SAFETY:
 *   - Dry-run by default: does all the work inside a transaction, prints the
 *     old->new mapping, then ROLLBACKs. Nothing is persisted.
 *   - Pass --apply to COMMIT.
 *   - Verifies zero non-UUID ids remain before committing; otherwise ROLLBACK.
 *   - For each row it remaps child references (every goal_id / objective_id
 *     column in public) old->new first, then the row's own id.
 *
 * Usage:
 *   npx tsx scripts/fix-synthetic-ids.ts            # dry run
 *   npx tsx scripts/fix-synthetic-ids.ts --apply    # commit
 */
import { execSync } from 'child_process';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

function getProdSecret() {
  const s = JSON.parse(
    execSync(
      'aws secretsmanager get-secret-value --region il-central-1 --secret-id "aivota-prod/database" --query SecretString --output text',
      { env: { ...process.env, AWS_PROFILE: 'aac' }, encoding: 'utf8' },
    ),
  );
  return { host: s.DB_HOST, user: s.DB_USER, password: s.DB_PASSWORD, database: s.DB_NAME };
}

/** Tables in public that have the given referencing column. */
async function tablesWithColumn(client: pg.PoolClient, column: string): Promise<string[]> {
  const r = await client.query(
    `select table_name from information_schema.columns
      where table_schema = 'public' and column_name = $1
      order by table_name`,
    [column],
  );
  return r.rows.map((x) => x.table_name as string);
}

async function main() {
  const secret = getProdSecret();
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: 5432,
    user: secret.user,
    password: secret.password,
    database: secret.database,
    ssl: { rejectUnauthorized: false, servername: secret.host },
  });
  const client = await pool.connect();
  console.log(`Mode: ${APPLY ? 'APPLY (will COMMIT)' : 'DRY RUN (will ROLLBACK)'}\n`);

  // entity -> { pkTable, childColumn (FK columns in other tables that point here) }
  const ENTITIES = [
    { table: 'goals', childColumn: 'goal_id' },
    { table: 'objectives', childColumn: 'objective_id' },
  ];

  try {
    await client.query('BEGIN');

    for (const ent of ENTITIES) {
      const childTables = await tablesWithColumn(client, ent.childColumn);
      const synthetic = (
        await client.query(`select id from "${ent.table}" where id !~* $1 order by id`, [UUID_RE])
      ).rows.map((r) => r.id as string);

      console.log(`\n=== ${ent.table}: ${synthetic.length} row(s) to remap ===`);
      console.log(`    child FK columns scanned: ${childTables.map((t) => `${t}.${ent.childColumn}`).join(', ') || '(none)'}`);

      for (const oldId of synthetic) {
        const newId = (await client.query('select gen_random_uuid() as id')).rows[0].id as string;

        // Remap any child references first (defensive — currently 0 for these rows).
        let remapped = 0;
        for (const t of childTables) {
          // Don't touch the entity's own table via this generic pass.
          const res = await client.query(
            `update "${t}" set "${ent.childColumn}" = $1 where "${ent.childColumn}" = $2`,
            [newId, oldId],
          );
          remapped += res.rowCount ?? 0;
        }

        // Remap the row's own primary key.
        const own = await client.query(
          `update "${ent.table}" set id = $1 where id = $2`,
          [newId, oldId],
        );
        console.log(`  ${oldId}  ->  ${newId}   (row updated: ${own.rowCount}, child refs remapped: ${remapped})`);
      }
    }

    // Verify nothing synthetic remains.
    const remGoals = (await client.query(`select count(*)::int n from goals where id !~* $1`, [UUID_RE])).rows[0].n;
    const remObjs = (await client.query(`select count(*)::int n from objectives where id !~* $1`, [UUID_RE])).rows[0].n;
    console.log(`\nVerification — remaining non-UUID ids: goals=${remGoals}, objectives=${remObjs}`);

    if (remGoals !== 0 || remObjs !== 0) {
      console.log('Verification FAILED — rolling back.');
      await client.query('ROLLBACK');
      process.exit(1);
    }

    if (APPLY) {
      await client.query('COMMIT');
      console.log('\n✅ COMMITTED. Synthetic ids normalized.');
    } else {
      await client.query('ROLLBACK');
      console.log('\n↩️  DRY RUN complete — rolled back, nothing persisted. Re-run with --apply to commit.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Fix failed:', e.message);
  process.exit(1);
});
