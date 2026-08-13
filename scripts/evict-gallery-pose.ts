/**
 * Evict suspect poses from a biometric_data row's multi-angle face gallery
 * (`face_embeddings`).
 *
 * WHY
 * ---
 * The gallery grows PASSIVELY: any confident, novel-enough sighting is appended
 * (server/services/biometric/recognition-service.ts). That is what makes a
 * person recognisable across pose and lighting, but it also means one confident
 * misidentification permanently installs somebody else's face in the gallery —
 * and because matching takes the MINIMUM distance over anchor + gallery, a
 * single poisoned entry keeps pulling the wrong person in. The live system can
 * only demote such an entry through a user correction (weight × 0.5, evicted at
 * the 0.25 floor). This is the surgical alternative when the bad entry is
 * already identified.
 *
 * Uses raw SQL rather than the drizzle schema so it works against a database
 * whose migrations lag the local schema.
 *
 * Usage:
 *   npx tsx scripts/evict-gallery-pose.ts <biometricDataId> <index> [<index>...]           # dry run
 *   npx tsx scripts/evict-gallery-pose.ts <biometricDataId> <index> [<index>...] --apply   # write
 */
import dotenv from "dotenv";
dotenv.config();

import pg from "pg";
import { euclideanDistance } from "./lib/face-embed.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const positional = args.filter((a) => !a.startsWith("--"));
const biometricDataId = positional[0];
const rawIndexes = positional.slice(1);

if (!biometricDataId || !rawIndexes.length) {
  console.error(
    "Usage: npx tsx scripts/evict-gallery-pose.ts <biometricDataId> <index> [<index>...] [--apply]",
  );
  process.exit(1);
}

const targets: number[] = [];
for (const raw of rawIndexes) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`Invalid gallery index: ${raw}`);
    process.exit(1);
  }
  if (!targets.includes(n)) targets.push(n);
}

/** Same threshold the recognition service matches at. */
const FACE_MATCH_THRESHOLD = 0.6;
/** Entries at/under this weight are already ignored when matching. */
const FACE_GALLERY_WEIGHT_FLOOR = 0.25;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  ssl: { rejectUnauthorized: false },
});
const q = async (text: string, params: any[] = []) => (await pool.query(text, params)).rows;

const fmt = (n: number | null | undefined, d = 4) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "—";

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// 1. Load
// ---------------------------------------------------------------------------
const [bd] = await q(
  `select id, face_embedding, face_embeddings, face_image_url, updated_at
     from biometric_data where id = $1`,
  [biometricDataId],
);
if (!bd) {
  console.error(`biometric_data ${biometricDataId} not found`);
  await pool.end();
  process.exit(1);
}

const anchor: number[] | null = Array.isArray(bd.face_embedding) && bd.face_embedding.length
  ? bd.face_embedding
  : null;
const gallery: any[] = Array.isArray(bd.face_embeddings) ? bd.face_embeddings : [];

const owners = await q(
  `select 'student' as kind, id::text as entity_id, name as label, id::text as student_id
     from students where biometric_data_id = $1
   union all
   select 'contact', id::text, name, student_id::text
     from student_contacts where biometric_data_id = $1
   union all
   select 'user', id::text, full_name, null
     from users where biometric_data_id = $1`,
  [biometricDataId],
);

console.log("=".repeat(78));
console.log(`EVICT GALLERY POSE — ${APPLY ? "APPLY" : "DRY RUN"}`);
console.log("=".repeat(78));
console.log("\n=== RECORD ===");
console.log({
  id: bd.id,
  owners: owners.map((o: any) => `${o.kind}:${o.entity_id} "${o.label}"`),
  anchor: anchor ? `${anchor.length}-D` : "NULL",
  gallerySize: gallery.length,
  faceImageUrl: bd.face_image_url,
  updatedAt: bd.updated_at,
});
if (!anchor) {
  console.log(
    "\n  NOTE: this record has NO anchor, so anchor distances below are unavailable and\n" +
      "  the live matcher is running on gallery entries alone. Consider running\n" +
      "  scripts/reenroll-face-anchor.ts first so eviction can be judged against a\n" +
      "  trusted reference.",
  );
}

const bad = targets.filter((i) => i >= gallery.length);
if (bad.length) {
  console.error(`\nIndex out of range (gallery has ${gallery.length} entries): ${bad.join(", ")}`);
  await pool.end();
  process.exit(1);
}

const embeddingOf = (g: any): number[] | null =>
  Array.isArray(g?.embedding) && g.embedding.length ? g.embedding : null;

// ---------------------------------------------------------------------------
// 2. Full gallery context — how every entry sits against the rest
// ---------------------------------------------------------------------------
console.log("\n=== GALLERY OVERVIEW ===");
console.log("  'median-to-peers' = median distance from this entry to every OTHER entry.");
console.log("  An entry that sits far from its own cluster is the shape contamination takes.");
const peerMedians: (number | null)[] = [];
for (const [i, g] of gallery.entries()) {
  const e = embeddingOf(g);
  if (!e) {
    peerMedians.push(null);
    console.log(`  [${i}] (no embedding)`);
    continue;
  }
  const peers: number[] = [];
  for (const [j, h] of gallery.entries()) {
    if (i === j) continue;
    const f = embeddingOf(h);
    if (f) peers.push(euclideanDistance(e, f));
  }
  const m = median(peers);
  peerMedians.push(m);
  const dAnchor = anchor ? euclideanDistance(e, anchor) : NaN;
  const mark = targets.includes(i) ? " <== TARGETED" : "";
  console.log(
    `  [${i}] q=${fmt(g.quality, 2)} w=${fmt(g.weight, 2)} capturedAt=${g.capturedAt} ` +
      `d(anchor)=${fmt(dAnchor)} median-to-peers=${fmt(m)}${mark}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Targeted entries in detail
// ---------------------------------------------------------------------------
for (const i of targets) {
  const g = gallery[i];
  const e = embeddingOf(g);
  console.log("\n" + "-".repeat(78));
  console.log(`=== TARGET gallery[${i}] ===`);
  console.log({
    quality: g?.quality,
    weight: g?.weight,
    capturedAt: g?.capturedAt,
    dims: e ? e.length : 0,
    belowWeightFloor: (g?.weight ?? 1) <= FACE_GALLERY_WEIGHT_FLOOR,
  });
  if (!e) {
    console.log("  (no embedding — nothing to compare)");
    continue;
  }
  console.log(
    `  distance to anchor: ${anchor ? fmt(euclideanDistance(e, anchor)) : "— (record has no anchor)"}`,
  );
  console.log("  distance to every other gallery entry:");
  for (const [j, h] of gallery.entries()) {
    if (i === j) continue;
    const f = embeddingOf(h);
    if (!f) {
      console.log(`      [${j}] (no embedding)`);
      continue;
    }
    const d = euclideanDistance(e, f);
    const alsoTargeted = targets.includes(j) ? "  (also targeted)" : "";
    const flag = d >= FACE_MATCH_THRESHOLD ? "  <<< beyond match threshold" : "";
    console.log(`      [${j}] d=${fmt(d)}${flag}${alsoTargeted}`);
  }
  console.log(`  median distance to peers: ${fmt(peerMedians[i])}`);
}

// ---------------------------------------------------------------------------
// 4. Cross-person evidence — is a targeted entry closer to somebody else?
// ---------------------------------------------------------------------------
const studentIds = new Set<string>();
for (const o of owners) if (o.student_id) studentIds.add(o.student_id);
for (const o of owners) {
  if (o.kind === "user") {
    const rows = await q(
      `select student_id::text as student_id from user_students where user_id = $1 and is_active = true`,
      [o.entity_id],
    );
    for (const r of rows) studentIds.add(r.student_id);
  }
}

const poolMembers: { who: string; bdId: string }[] = [];
const seenBd = new Set<string>([biometricDataId]);
for (const sid of studentIds) {
  const [st] = await q(
    `select id::text as id, name, biometric_data_id::text as bd_id from students where id = $1`,
    [sid],
  );
  if (st?.bd_id && !seenBd.has(st.bd_id)) {
    seenBd.add(st.bd_id);
    poolMembers.push({ who: `student:${st.id} ${st.name}`, bdId: st.bd_id });
  }
  const contacts = await q(
    `select id::text as id, name, relationship, is_active, biometric_data_id::text as bd_id
       from student_contacts where student_id = $1`,
    [sid],
  );
  for (const c of contacts) {
    if (!c.bd_id || seenBd.has(c.bd_id)) continue;
    seenBd.add(c.bd_id);
    poolMembers.push({ who: `contact:${c.id} ${c.name} (${c.relationship}, active=${c.is_active})`, bdId: c.bd_id });
  }
  const linkedUsers = await q(
    `select us.user_id::text as user_id, us.role, u.full_name, u.biometric_data_id::text as bd_id
       from user_students us join users u on u.id = us.user_id
      where us.student_id = $1 and us.is_active = true`,
    [sid],
  );
  for (const u of linkedUsers) {
    if (!u.bd_id || seenBd.has(u.bd_id)) continue;
    seenBd.add(u.bd_id);
    poolMembers.push({ who: `user:${u.user_id} ${u.full_name} (${u.role})`, bdId: u.bd_id });
  }
}

if (poolMembers.length) {
  console.log("\n" + "-".repeat(78));
  console.log("=== CROSS-PERSON CHECK (closest sample belonging to somebody else) ===");
  console.log("  A targeted entry whose nearest other-person sample beats its own");
  console.log("  median-to-peers is very likely that other person's face.");
  const others: { who: string; label: string; embedding: number[] }[] = [];
  for (const p of poolMembers) {
    const [row] = await q(`select face_embedding, face_embeddings from biometric_data where id = $1`, [p.bdId]);
    if (!row) continue;
    if (Array.isArray(row.face_embedding) && row.face_embedding.length) {
      others.push({ who: p.who, label: "anchor", embedding: row.face_embedding });
    }
    if (Array.isArray(row.face_embeddings)) {
      row.face_embeddings.forEach((g: any, i: number) => {
        const e = embeddingOf(g);
        if (e) others.push({ who: p.who, label: `gallery[${i}]`, embedding: e });
      });
    }
  }
  for (const i of targets) {
    const e = embeddingOf(gallery[i]);
    if (!e) continue;
    let best = Infinity;
    let bestWho = "";
    for (const o of others) {
      const d = euclideanDistance(e, o.embedding);
      if (d < best) {
        best = d;
        bestWho = `${o.who} ${o.label}`;
      }
    }
    const own = peerMedians[i];
    const verdict =
      Number.isFinite(best) && own != null && best < own
        ? "  <<< CLOSER TO THE OTHER PERSON THAN TO ITS OWN CLUSTER"
        : "";
    console.log(
      `  gallery[${i}]: own median-to-peers=${fmt(own)}  nearest other person=${fmt(best)}${verdict}`,
    );
    if (Number.isFinite(best)) console.log(`               nearest = ${bestWho}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Write (or describe the write)
// ---------------------------------------------------------------------------
const keep = gallery.filter((_, i) => !targets.includes(i));

console.log("\n" + "=".repeat(78));
console.log(
  `Evicting ${targets.length} entr${targets.length === 1 ? "y" : "ies"} ` +
    `[${targets.slice().sort((a, b) => a - b).join(", ")}] — gallery ${gallery.length} -> ${keep.length}`,
);
console.log("Surviving entries (renumbered after the splice):");
keep.forEach((g, n) => {
  const oldIndex = gallery.indexOf(g);
  console.log(`  new[${n}] <- old[${oldIndex}] q=${fmt(g?.quality, 2)} w=${fmt(g?.weight, 2)} capturedAt=${g?.capturedAt}`);
});

if (!APPLY) {
  console.log("\nDRY RUN — nothing was written. Would run:");
  console.log(`  update biometric_data`);
  console.log(`     set face_embeddings = <array of ${keep.length}>, updated_at = now()`);
  console.log(`   where id = '${biometricDataId}'`);
  console.log(`  (face_embedding anchor, photo and descriptor text fields untouched)`);
  console.log("\nRe-run with --apply to write it.");
} else {
  await q(
    `update biometric_data set face_embeddings = $2::jsonb, updated_at = now() where id = $1`,
    [biometricDataId, JSON.stringify(keep)],
  );
  console.log(`\nAPPLIED — face_embeddings now holds ${keep.length} entr${keep.length === 1 ? "y" : "ies"}.`);
  console.log("  anchor, photo and descriptor text fields untouched.");
}
console.log("=".repeat(78));

await pool.end();
