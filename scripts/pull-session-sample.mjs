import "dotenv/config";
import pg from "pg";
const { Client } = pg;
const SID = process.argv[2] || "aac-1779642560542";
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
// Find sections that contain usage info.
const secs = await c.query(
  `select section, count(*) as n from session_debug_logs
   where session_id=$1 and (content like '%promptTokenCount%' or content like '%audioOutputTokens%')
   group by section order by n desc`, [SID]);
console.log("sections with usage info:");
for (const r of secs.rows) console.log(`  ${r.n}  ${r.section}`);

// Sample one usage block
const r = await c.query(
  `select section, content from session_debug_logs
   where session_id=$1 and content like '%audioOutputTokens%' limit 3`, [SID]);
for (const row of r.rows) {
  console.log("\n--- section:", row.section, "---");
  console.log(row.content.substring(0, 800));
}
await c.end();
