/**
 * Dump session_debug_logs rows for a session, filtered by section regex.
 * Read-only.
 *
 * Usage:
 *   npx tsx scripts/dump-session-debug-rows.ts <sessionId> <sectionRegex> [maxChars]
 */
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';

const [sessionId, sectionRe, maxCharsArg, seqFromArg, seqToArg] = process.argv.slice(2);
if (!sessionId || !sectionRe) {
  console.error('Usage: npx tsx scripts/dump-session-debug-rows.ts <sessionId> <sectionRegex> [maxChars] [seqFrom] [seqTo]');
  process.exit(1);
}
const maxChars = maxCharsArg ? parseInt(maxCharsArg, 10) : 4000;
const seqFrom = seqFromArg ? parseInt(seqFromArg, 10) : null;
const seqTo = seqToArg ? parseInt(seqToArg, 10) : null;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  ssl: { rejectUnauthorized: false },
});
const rows = (
  await pool.query(
    `select seq, timestamp, section, content
       from session_debug_logs
      where session_id = $1 and section ~ $2
        and ($3::int is null or seq >= $3) and ($4::int is null or seq <= $4)
      order by seq`,
    [sessionId, sectionRe, seqFrom, seqTo],
  )
).rows;

for (const d of rows) {
  const txt = d.content ?? '';
  console.log(
    `--- seq=${d.seq} ${d.timestamp?.toISOString?.()} [${d.section}]\n${txt.length > maxChars ? txt.slice(0, maxChars) + ' …TRUNCATED(' + txt.length + ')' : txt}`,
  );
}
console.log(`\n(${rows.length} rows)`);
await pool.end();
