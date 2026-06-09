/**
 * Re-key legacy AAC chat-session primary keys from the old `aac-<timestamp>`
 * placeholder format to fresh UUIDs (matching clinician sessions and the new
 * AAC code path in dual-agent-service.ts). Runs through the SSM tunnel
 * (npm run db-tunnel) against prod.
 *
 * WHY: new AAC sessions now mint a crypto.randomUUID(); historical rows still
 * carry `aac-<ms>` ids. Those ids were also collision-prone (two sessions in
 * the same millisecond shared a key). This normalizes the old rows.
 *
 * SAFETY:
 *   - Dry-run by default: does all the work inside a transaction, prints the
 *     old->new mapping, then ROLLBACKs. Nothing is persisted.
 *   - Pass --apply to COMMIT.
 *   - Requires migration 0117 (session_debug_logs FK ON UPDATE CASCADE) to be
 *     applied first; verified up front and aborts otherwise. With the cascade,
 *     updating chat_sessions.id automatically repoints session_debug_logs.
 *   - aac_utterance_events.chat_session_id has no FK, so it is remapped
 *     explicitly.
 *   - Verifies zero `aac-%` ids remain before committing; otherwise ROLLBACK.
 *
 * Usage:
 *   npx tsx scripts/fix-aac-session-ids.ts            # dry run
 *   npx tsx scripts/fix-aac-session-ids.ts --apply    # commit
 */
import { execSync } from 'child_process';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const FK_NAME = 'session_debug_logs_session_id_chat_sessions_id_fk';

function getProdSecret() {
  const s = JSON.parse(
    execSync(
      'aws secretsmanager get-secret-value --region il-central-1 --secret-id "aivota-prod/database" --query SecretString --output text',
      { env: { ...process.env, AWS_PROFILE: 'aac' }, encoding: 'utf8' },
    ),
  );
  return { host: s.DB_HOST, user: s.DB_USER, password: s.DB_PASSWORD, database: s.DB_NAME };
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

  try {
    // Guard: the session_debug_logs FK must cascade ON UPDATE, otherwise
    // re-keying a parent that has debug-log children would violate the FK.
    // pg_constraint.confupdtype: 'c' = cascade, 'a' = no action.
    const fk = await client.query(
      `select confupdtype from pg_constraint where conname = $1`,
      [FK_NAME],
    );
    if (fk.rowCount === 0) {
      throw new Error(`FK ${FK_NAME} not found — schema unexpected, aborting.`);
    }
    if (fk.rows[0].confupdtype !== 'c') {
      throw new Error(
        `FK ${FK_NAME} is not ON UPDATE CASCADE (confupdtype=${fk.rows[0].confupdtype}). ` +
          `Apply migration 0117 first (npm run db:migrate), then re-run.`,
      );
    }

    await client.query('BEGIN');

    const legacy = (
      await client.query(`select id from chat_sessions where id like 'aac-%' order by id`)
    ).rows.map((r) => r.id as string);

    console.log(`=== chat_sessions: ${legacy.length} legacy aac- id(s) to remap ===\n`);

    for (const oldId of legacy) {
      const newId = (await client.query('select gen_random_uuid() as id')).rows[0].id as string;

      // Loose reference (no FK) — remap explicitly.
      const utter = await client.query(
        `update aac_utterance_events set chat_session_id = $1 where chat_session_id = $2`,
        [newId, oldId],
      );

      // Parent id — session_debug_logs.session_id cascades automatically.
      await client.query(`update chat_sessions set id = $1 where id = $2`, [newId, oldId]);

      console.log(`  ${oldId}  ->  ${newId}   (utterance events remapped: ${utter.rowCount ?? 0})`);
    }

    const remaining = (
      await client.query(`select count(*)::int n from chat_sessions where id like 'aac-%'`)
    ).rows[0].n;
    console.log(`\nVerification — remaining aac- ids: ${remaining}`);

    if (remaining !== 0) {
      console.log('Verification FAILED — rolling back.');
      await client.query('ROLLBACK');
      process.exit(1);
    }

    if (APPLY) {
      await client.query('COMMIT');
      console.log('\n✅ COMMITTED. Legacy AAC session ids normalized to UUIDs.');
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
