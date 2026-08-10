// READ-ONLY diagnostic query. No writes.
import 'dotenv/config';
import pg from 'pg';

const cs = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');
const pool = new pg.Pool({ connectionString: cs, ssl: { rejectUnauthorized: false }, max: 2 });

const sql = process.argv.slice(2).join(' ');
if (!/^\s*(select|with)\b/i.test(sql)) { console.error('read-only: SELECT/WITH only'); process.exit(1); }

try {
  const r = await pool.query(sql);
  console.log(JSON.stringify(r.rows, null, 2));
} catch (e) {
  console.error('ERR:', e.message);
} finally {
  await pool.end();
}
