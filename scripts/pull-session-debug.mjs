import "dotenv/config";
import pg from "pg";
const { Client } = pg;
const SID = process.argv[2] || "aac-1779642560542";
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const rows = await c.query(
  `select timestamp, content from session_debug_logs
   where session_id=$1 and section='SERVER → CLIENT' and content like '%"debug"%audioOutputTokens%'
   order by seq`, [SID]);

// Look at the context-size trajectory over time + check for compression drops.
const samples = [];
for (const row of rows.rows) {
  const m = row.content.match(/"promptTokens":(\d+),"completionTokens":(\d+),"details":\{"textInputTokens":(\d+),"nonTextInputTokens":(\d+),"textOutputTokens":(\d+),"audioOutputTokens":(\d+)\}/);
  if (!m) continue;
  samples.push({
    t: row.timestamp,
    prompt: +m[1],
    ti: +m[3],
    nti: +m[4],
    to: +m[5],
    ao: +m[6],
  });
}

// Detect drops (compression events)
const drops = [];
for (let i = 1; i < samples.length; i++) {
  const drop = samples[i-1].prompt - samples[i].prompt;
  if (drop > 5000) {
    drops.push({ at: samples[i].t, from: samples[i-1].prompt, to: samples[i].prompt, drop });
  }
}

console.log(`samples: ${samples.length}`);
console.log(`first prompt: ${samples[0]?.prompt.toLocaleString()}`);
console.log(`last prompt: ${samples[samples.length-1]?.prompt.toLocaleString()}`);
console.log(`max prompt: ${Math.max(...samples.map(s=>s.prompt)).toLocaleString()}`);
console.log(`min prompt: ${Math.min(...samples.map(s=>s.prompt)).toLocaleString()}`);
console.log();
console.log("=== context drops > 5k (potential compression events) ===");
if (drops.length === 0) {
  console.log("  NONE — context never dropped by more than 5k tokens.");
} else {
  for (const d of drops) {
    console.log(`  ${d.at.toISOString()}  ${d.from.toLocaleString()} → ${d.to.toLocaleString()}  (drop ${d.drop.toLocaleString()})`);
  }
}
console.log();

// Sample the trajectory at quartiles
const N = samples.length;
const ticks = [0, Math.floor(N*0.1), Math.floor(N*0.25), Math.floor(N*0.5), Math.floor(N*0.75), Math.floor(N*0.9), N-1];
console.log("=== context trajectory (sampled) ===");
for (const i of ticks) {
  const s = samples[i];
  if (!s) continue;
  console.log(`  turn ${String(i+1).padStart(3)}/${N}  ${s.t.toISOString()}  prompt=${s.prompt.toLocaleString()}  (text=${s.ti.toLocaleString()}, nonText=${s.nti.toLocaleString()})`);
}

// Cost with OFFICIAL rates from llm-options.ts
const RATES = { textIn: 0.50/1e6, audioIn: 3.00/1e6, textOut: 2.00/1e6, audioOut: 12.00/1e6 };
const sumTi = samples.reduce((s,x)=>s+x.ti,0);
const sumNti = samples.reduce((s,x)=>s+x.nti,0);
const sumTo = samples.reduce((s,x)=>s+x.to,0);
const sumAo = samples.reduce((s,x)=>s+x.ao,0);
console.log();
console.log("=== cost with OFFICIAL rates (from llm-options.ts: gemini-live-2.5-flash-native-audio) ===");
console.log(`  text input  @ $0.50/M : $${(sumTi * RATES.textIn).toFixed(2)}   (${sumTi.toLocaleString()} tok)`);
console.log(`  nontext in  @ $3.00/M : $${(sumNti * RATES.audioIn).toFixed(2)}   (${sumNti.toLocaleString()} tok)`);
console.log(`  text out    @ $2.00/M : $${(sumTo * RATES.textOut).toFixed(2)}   (${sumTo.toLocaleString()} tok)`);
console.log(`  audio out   @ $12.00/M: $${(sumAo * RATES.audioOut).toFixed(2)}   (${sumAo.toLocaleString()} tok)`);
const tot = sumTi*RATES.textIn + sumNti*RATES.audioIn + sumTo*RATES.textOut + sumAo*RATES.audioOut;
const minutes = (samples[samples.length-1].t.getTime() - samples[0].t.getTime()) / 60000;
console.log(`  ----------------------------`);
console.log(`  TOTAL                 : $${tot.toFixed(2)}   (${minutes.toFixed(1)} min = $${(tot/minutes).toFixed(2)}/min)`);

await c.end();
