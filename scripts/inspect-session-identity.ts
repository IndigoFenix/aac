/**
 * Inspect a student's recent sessions for identity-related events.
 * Lists recent chat_sessions, then dumps identity-relevant entries from the
 * chosen (default: latest) session's conversation log and session_debug_logs.
 *
 * Read-only.
 *
 * Usage:
 *   npx tsx scripts/inspect-session-identity.ts <studentId> [sessionId]
 */
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';

const studentId = process.argv[2];
const sessionIdArg = process.argv[3];
if (!studentId) {
  console.error('Usage: npx tsx scripts/inspect-session-identity.ts <studentId> [sessionId]');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  ssl: { rejectUnauthorized: false },
});
const q = async (text: string, params: any[] = []) => (await pool.query(text, params)).rows;

console.log('=== RECENT SESSIONS ===');
const sessions = await q(
  `select cs.id, cs.chat_mode, cs.started, cs.last_update, cs.status, cs.title, cs.importance,
          jsonb_array_length(cs.log) as log_len,
          (select count(*) from session_debug_logs d where d.session_id = cs.id) as debug_rows
     from chat_sessions cs
    where cs.student_id = $1
    order by cs.started desc
    limit 8`,
  [studentId],
);
for (const s of sessions) {
  console.log(
    `${s.id}  ${s.chat_mode}  started=${s.started?.toISOString?.()}  status=${s.status}  log=${s.log_len}  debugRows=${s.debug_rows}  title=${s.title ?? ''}`,
  );
}
if (!sessions.length) {
  console.log('(none)');
  process.exit(0);
}

const sessionId = sessionIdArg ?? sessions[0].id;
console.log(`\n=== INSPECTING SESSION ${sessionId} ===`);
const [sess] = await q(
  `select id, chat_mode, started, last_update, status, title, summary, importance
     from chat_sessions where id = $1`,
  [sessionId],
);
console.log(sess);

// Conversation-log entries that touch identity / the grandmother
const PATTERN = 'סבתא|grandmother|Grandmother|PEOPLE PRESENT|person_identified|set_person_as_user|voice_identified|Sima|סימה';
console.log(`\n=== LOG ENTRIES MATCHING /${PATTERN}/ ===`);
const logHits = await q(
  `select ord, elem
     from chat_sessions,
          lateral jsonb_array_elements(log) with ordinality as t(elem, ord)
    where id = $1 and elem::text ~ $2
    order by ord`,
  [sessionId, PATTERN],
);
console.log(`(${logHits.length} of ${sessions.find((s: any) => s.id === sessionId)?.log_len ?? '?'} entries match)`);
for (const h of logHits) {
  const txt = JSON.stringify(h.elem);
  console.log(`--- [${h.ord}] ${txt.length > 1500 ? txt.slice(0, 1500) + ' …TRUNCATED' : txt}`);
}

// Debug-log rows (only exist when session ran with debugMode)
console.log('\n=== session_debug_logs SECTION COUNTS ===');
const sections = await q(
  `select section, count(*) as n
     from session_debug_logs where session_id = $1
    group by section order by n desc`,
  [sessionId],
);
for (const s of sections) console.log(`  ${s.section}: ${s.n}`);

console.log(`\n=== DEBUG ROWS MATCHING /${PATTERN}/ (or OBSERVER:TOOL) ===`);
const dbgHits = await q(
  `select seq, timestamp, section, content
     from session_debug_logs
    where session_id = $1 and (content ~ $2 or section like 'OBSERVER:TOOL%')
    order by seq`,
  [sessionId, PATTERN],
);
for (const d of dbgHits) {
  const txt = d.content ?? '';
  console.log(
    `--- seq=${d.seq} ${d.timestamp?.toISOString?.()} [${d.section}]\n${txt.length > 1500 ? txt.slice(0, 1500) + ' …TRUNCATED' : txt}`,
  );
}

await pool.end();
