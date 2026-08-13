/**
 * Recompute a biometric_data row's enrolled face anchor (`face_embedding`)
 * from the face photo already stored in S3.
 *
 * WHY
 * ---
 * The anchor is normally computed in the BROWSER: the clinician client runs
 * @vladmandic/face-api over the uploaded picture and POSTs the 128-D descriptor
 * alongside the JPEG (client/src/lib/biometricImage.ts →
 * server/services/biometric/photo-upload.ts, which stores whatever it is
 * handed). There is no server-side embedding path. So when an anchor is lost —
 * e.g. a photo upload aimed at the wrong record overwrote it — nothing in the
 * live system can rebuild it, even though the enrolled photo is still sitting
 * in S3. This script rebuilds it offline, mirroring the same pipeline.
 *
 * WHAT IT TOUCHES
 * ---------------
 * With --apply: `face_embedding` ONLY. It never writes the `face_embeddings`
 * gallery, never re-uploads or deletes the photo, and never runs the LLM
 * photo-analyzer (so physical_description and friends are left alone).
 *
 * Uses raw SQL rather than the drizzle schema so it works against a database
 * whose migrations lag the local schema.
 *
 * Usage:
 *   npx tsx scripts/reenroll-face-anchor.ts <biometricDataId>            # dry run
 *   npx tsx scripts/reenroll-face-anchor.ts <biometricDataId> --apply    # write
 */
import dotenv from "dotenv";
dotenv.config();

import pg from "pg";
import { extractFace, euclideanDistance, type FaceExtraction } from "./lib/face-embed.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const biometricDataId = args.find((a) => !a.startsWith("--"));

if (!biometricDataId) {
  console.error("Usage: npx tsx scripts/reenroll-face-anchor.ts <biometricDataId> [--apply]");
  process.exit(1);
}

/** Same threshold the recognition service matches at. */
const FACE_MATCH_THRESHOLD = 0.6;
/** Entries at/under this weight are ignored when matching. */
const FACE_GALLERY_WEIGHT_FLOOR = 0.25;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  ssl: { rejectUnauthorized: false },
});
const q = async (text: string, params: any[] = []) => (await pool.query(text, params)).rows;

const fmt = (n: number | null | undefined, d = 4) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "—";

function stats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    max: sorted[sorted.length - 1],
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

// ---------------------------------------------------------------------------
// 1. Load the record
// ---------------------------------------------------------------------------
const [bd] = await q(
  `select id, face_embedding, face_embeddings, face_image_url, face_image_quality,
          physical_description, estimated_age, estimated_sex, created_at, updated_at
     from biometric_data where id = $1`,
  [biometricDataId],
);
if (!bd) {
  console.error(`biometric_data ${biometricDataId} not found`);
  await pool.end();
  process.exit(1);
}

const storedAnchor: number[] | null = Array.isArray(bd.face_embedding) && bd.face_embedding.length
  ? bd.face_embedding
  : null;
const gallery: any[] = Array.isArray(bd.face_embeddings) ? bd.face_embeddings : [];

console.log("=".repeat(78));
console.log(`RE-ENROLL FACE ANCHOR — ${APPLY ? "APPLY" : "DRY RUN"}`);
console.log("=".repeat(78));
console.log("\n=== BIOMETRIC RECORD ===");
console.log({
  id: bd.id,
  faceImageUrl: bd.face_image_url,
  faceImageQuality: bd.face_image_quality,
  storedAnchor: storedAnchor ? `${storedAnchor.length}-D` : "NULL  <<< missing",
  gallerySize: gallery.length,
  physicalDescription: bd.physical_description,
  estimatedAge: bd.estimated_age,
  estimatedSex: bd.estimated_sex,
  createdAt: bd.created_at,
  updatedAt: bd.updated_at,
});

if (!bd.face_image_url) {
  console.error("\nRecord has no face_image_url — nothing to recompute from.");
  await pool.end();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Who owns this record, and what is their known-people pool?
// ---------------------------------------------------------------------------
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

console.log("\n=== OWNERS (entities pointing at this biometric_data row) ===");
if (!owners.length) console.log("  (none — orphan row)");
for (const o of owners) console.log(`  ${o.kind}:${o.entity_id} "${o.label}" student=${o.student_id ?? "—"}`);

// Every student whose known-people pool this record participates in.
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

interface PoolMember {
  who: string;
  bdId: string;
}
const poolMembers: PoolMember[] = [];
const seenBd = new Set<string>([biometricDataId]);
for (const sid of studentIds) {
  const [st] = await q(`select id::text as id, name, biometric_data_id::text as bd_id from students where id = $1`, [sid]);
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

console.log(`\n=== KNOWN-PEOPLE POOL (${poolMembers.length} other biometric record(s)) ===`);
for (const p of poolMembers) console.log(`  ${p.who} bd=${p.bdId}`);

// ---------------------------------------------------------------------------
// 3. Fetch the photo and recompute the descriptor
// ---------------------------------------------------------------------------
// Imported after dotenv(): s3-service reads S3_UPLOADS_BUCKET at module load.
const { s3Service } = await import("../server/services/storage/s3-service.js");

console.log(`\n=== PHOTO ===`);
console.log(`  s3 key: ${bd.face_image_url}`);
let photo: Buffer;
try {
  photo = await s3Service.download(bd.face_image_url);
} catch (err: any) {
  console.error(`  DOWNLOAD FAILED: ${err?.message ?? err}`);
  await pool.end();
  process.exit(1);
}
console.log(`  bytes:  ${photo.length}`);

console.log("\n=== DETECTION ===");
// 'enrollment' mirrors the clinician upload (ssdMobilenetv1 + full 68-point
// landmarks) — the pipeline that produced every stored anchor, so this is the
// descriptor we write. 'aac' mirrors the live client (tinyFaceDetector + tiny
// landmarks) and is computed for comparison only: the gallery was captured with
// it, so it shows how much the detector choice alone moves the descriptor.
const enrollment = await extractFace(photo, "enrollment");
if (!enrollment) {
  console.error("  NO FACE DETECTED by the enrollment pipeline — cannot recompute an anchor.");
  await pool.end();
  process.exit(1);
}
let aac: FaceExtraction | null = null;
try {
  aac = await extractFace(photo, "aac");
} catch (err: any) {
  console.log(`  (aac pipeline failed: ${err?.message ?? err})`);
}

const show = (e: FaceExtraction | null, name: string) => {
  if (!e) {
    console.log(`  ${name}: no face detected`);
    return;
  }
  console.log(
    `  ${name}: score=${fmt(e.detectionScore)} quality=${fmt(e.quality)} ` +
      `box=${Math.round(e.box.x)},${Math.round(e.box.y)} ${Math.round(e.box.width)}x${Math.round(e.box.height)} ` +
      `image=${e.imageWidth}x${e.imageHeight} dims=${e.descriptor.length}`,
  );
};
show(enrollment, "enrollment (ssd + full landmarks) ");
show(aac, "aac        (tiny + tiny landmarks)");
if (aac) {
  console.log(`  enrollment <-> aac descriptor distance: ${fmt(euclideanDistance(enrollment.descriptor, aac.descriptor))}`);
  console.log("    (detector/alignment noise floor for this photo — same face, same weights)");
}

const newAnchor = enrollment.descriptor;

// ---------------------------------------------------------------------------
// 4. Distances
// ---------------------------------------------------------------------------
if (storedAnchor) {
  console.log("\n=== NEW ANCHOR vs EXISTING STORED ANCHOR ===");
  console.log(`  distance: ${fmt(euclideanDistance(newAnchor, storedAnchor))}`);
  console.log("  (a small value means the stored anchor really is this photo's face — nothing was lost)");
}

console.log(`\n=== NEW ANCHOR vs OWN GALLERY (${gallery.length} entr${gallery.length === 1 ? "y" : "ies"}) ===`);
console.log("  sanity: if the gallery is genuinely the same person, most should sit well under 0.5");
const galleryDists: number[] = [];
const aacGalleryDists: number[] = [];
for (const [i, g] of gallery.entries()) {
  if (!Array.isArray(g?.embedding) || !g.embedding.length) {
    console.log(`  gallery[${i}]: no embedding`);
    continue;
  }
  const d = euclideanDistance(newAnchor, g.embedding);
  const dAac = aac ? euclideanDistance(aac.descriptor, g.embedding) : NaN;
  galleryDists.push(d);
  if (Number.isFinite(dAac)) aacGalleryDists.push(dAac);
  const belowFloor = (g.weight ?? 1) <= FACE_GALLERY_WEIGHT_FLOOR;
  const flag = d >= FACE_MATCH_THRESHOLD ? "  <<< BEYOND MATCH THRESHOLD — suspect" : d >= 0.5 ? "  <<  far" : "";
  console.log(
    `  gallery[${i}] q=${fmt(g.quality, 2)} w=${fmt(g.weight, 2)}${belowFloor ? " (below weight floor — ignored when matching)" : ""} ` +
      `capturedAt=${g.capturedAt}\n` +
      `              d(new enrollment anchor)=${fmt(d)}   d(new aac descriptor)=${fmt(dAac)}${flag}`,
  );
}
const gs = stats(galleryDists);
if (gs) {
  console.log(
    `\n  gallery distance summary (vs new anchor): min=${fmt(gs.min)} median=${fmt(gs.median)} ` +
      `mean=${fmt(gs.mean)} max=${fmt(gs.max)}`,
  );
  console.log(
    `  under 0.5: ${galleryDists.filter((d) => d < 0.5).length}/${galleryDists.length}   ` +
      `under ${FACE_MATCH_THRESHOLD}: ${galleryDists.filter((d) => d < FACE_MATCH_THRESHOLD).length}/${galleryDists.length}`,
  );
}
const as = stats(aacGalleryDists);
if (as) {
  console.log(
    `  gallery distance summary (vs new AAC-pipeline descriptor): min=${fmt(as.min)} median=${fmt(as.median)} ` +
      `mean=${fmt(as.mean)} max=${fmt(as.max)}`,
  );
}

// Informational: how the new anchor sits against everyone else this student knows.
console.log("\n=== NEW ANCHOR vs OTHER PEOPLE IN THE STUDENT'S POOL (informational) ===");
console.log(`  anything under ${FACE_MATCH_THRESHOLD} could cross-match at recognition time`);
let anyCross = false;
let globalMin = Infinity;
let globalMinLabel = "";
for (const p of poolMembers) {
  const [other] = await q(
    `select id, face_embedding, face_embeddings from biometric_data where id = $1`,
    [p.bdId],
  );
  if (!other) continue;
  const samples: { label: string; embedding: number[]; quality?: number; weight?: number }[] = [];
  if (Array.isArray(other.face_embedding) && other.face_embedding.length) {
    samples.push({ label: "anchor", embedding: other.face_embedding });
  }
  if (Array.isArray(other.face_embeddings)) {
    other.face_embeddings.forEach((g: any, i: number) => {
      if (Array.isArray(g?.embedding) && g.embedding.length) {
        samples.push({ label: `gallery[${i}]`, embedding: g.embedding, quality: g.quality, weight: g.weight });
      }
    });
  }
  if (!samples.length) {
    console.log(`  ${p.who}: no face data`);
    continue;
  }
  console.log(`  ${p.who}`);
  for (const s of samples) {
    const d = euclideanDistance(newAnchor, s.embedding);
    if (d < globalMin) {
      globalMin = d;
      globalMinLabel = `${p.who} ${s.label}`;
    }
    const flag = d < FACE_MATCH_THRESHOLD ? "  <<< WITHIN MATCH THRESHOLD" : "";
    if (flag) anyCross = true;
    console.log(`      ${s.label.padEnd(12)} d=${fmt(d)}${flag}`);
  }
}
if (Number.isFinite(globalMin)) {
  console.log(`\n  closest other-person sample: ${fmt(globalMin)} (${globalMinLabel})`);
  if (!anyCross) console.log("  no other-person sample falls within the match threshold — the new anchor is separable");
}

// ---------------------------------------------------------------------------
// 5. Write (or describe the write)
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
if (!APPLY) {
  console.log("DRY RUN — nothing was written. Would run:");
  console.log(`  update biometric_data`);
  console.log(`     set face_embedding = <${newAnchor.length}-D descriptor>, updated_at = now()`);
  console.log(`   where id = '${biometricDataId}'`);
  console.log(`  (face_embeddings gallery, face_image_url and all descriptor text fields untouched)`);
  console.log(`\n  first 6 values: [${newAnchor.slice(0, 6).map((v) => v.toFixed(5)).join(", ")}, …]`);
  console.log("\nRe-run with --apply to write it.");
} else {
  await q(
    `update biometric_data set face_embedding = $2::jsonb, updated_at = now() where id = $1`,
    [biometricDataId, JSON.stringify(newAnchor)],
  );
  console.log(`APPLIED — face_embedding set (${newAnchor.length}-D) on biometric_data ${biometricDataId}`);
  console.log("  gallery, photo and descriptor text fields untouched.");
}
console.log("=".repeat(78));

await pool.end();
