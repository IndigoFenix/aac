// Phase 0 cost-measurement helper — inspect real AAC session cost broken down
// by AGENT (cost_breakdown) and by MODALITY (cost_modality_breakdown, populated
// for sessions after migration 0131). Read-only. See planning-docs/aac-cost-saving*.
// Usage: node scripts/inspect-aac-costs.mjs [days] [limit]
import 'dotenv/config';
import pg from 'pg';

const days = Number(process.argv[2] || 10);
const limit = Number(process.argv[3] || 40);

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, '');
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 2 });

const { rows } = await pool.query(`
  SELECT id, student_id, chat_mode, started, last_update,
         credits_used, cost_breakdown, cost_modality_breakdown,
         EXTRACT(EPOCH FROM (last_update - started)) AS dur_s
  FROM chat_sessions
  WHERE chat_mode = 'aac'
    AND credits_used > 0
    AND started > now() - interval '${days} days'
  ORDER BY started DESC
  LIMIT ${limit}
`);

console.log(`\nFound ${rows.length} AAC sessions with cost in last 10 days.\n`);

// Aggregate category + modality totals across all sessions.
const catTotals = {};
const modTotals = {};
let grandTotal = 0;
let totalMinutes = 0;
let modSessions = 0;

for (const r of rows) {
  const durMin = Math.max(0, (Number(r.dur_s) || 0) / 60);
  totalMinutes += durMin;
  grandTotal += Number(r.credits_used) || 0;
  const cb = r.cost_breakdown || {};
  const mb = r.cost_modality_breakdown || {};
  const catLine = Object.entries(cb)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${Number(v).toFixed(4)}`)
    .join('  ');
  for (const [k, v] of Object.entries(cb)) catTotals[k] = (catTotals[k] || 0) + Number(v);
  if (Object.keys(mb).length) {
    modSessions++;
    for (const [k, v] of Object.entries(mb)) modTotals[k] = (modTotals[k] || 0) + Number(v);
  }
  console.log(
    `${r.started.toISOString().slice(0, 16)}  ${durMin.toFixed(0).padStart(3)}min  ` +
    `$${(Number(r.credits_used) || 0).toFixed(3).padStart(7)}  ` +
    `$${durMin > 0 ? (Number(r.credits_used) / durMin).toFixed(4) : '  n/a'}/min  | ${catLine}`
  );
}

console.log('\n===== By AGENT (cost_breakdown) =====');
for (const [k, v] of Object.entries(catTotals).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} $${v.toFixed(4).padStart(9)}  (${((v / grandTotal) * 100).toFixed(1)}%)`);
}
console.log(`  ${'TOTAL'.padEnd(22)} $${grandTotal.toFixed(4).padStart(9)}`);

console.log('\n===== By MODALITY (cost_modality_breakdown, migration 0131) =====');
if (modSessions === 0) {
  console.log('  (no sessions with modality detail yet — populates for sessions run after 0131)');
} else {
  const modTotal = Object.values(modTotals).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(modTotals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} $${v.toFixed(4).padStart(9)}  (${((v / modTotal) * 100).toFixed(1)}% of live)`);
  }
  console.log(`  ${'(live total)'.padEnd(12)} $${modTotal.toFixed(4).padStart(9)}  across ${modSessions} session(s)`);
}

console.log(`\n  Total session-minutes: ${totalMinutes.toFixed(0)}`);
console.log(`  Blended $/min: $${totalMinutes > 0 ? (grandTotal / totalMinutes).toFixed(4) : 'n/a'}\n`);

await pool.end();
