/**
 * Backfill biometric_data's LLM-vision descriptor columns — estimated_age,
 * estimated_sex, physical_description (plus hair_color, eye_color,
 * identifying_features, which come free on the same call) — for records that
 * have a face photo but never went through analyzeFacePhoto().
 *
 * WHY
 * ---
 * Face recognition is gaining an "attribute veto": a candidate match gets
 * rejected when its observed age/sex clashes with the stored person (a child
 * can't match a senior). Those columns are normally populated at upload time
 * by analyzeFacePhoto() (see server/services/biometric/photo-upload.ts,
 * uploadBiometricPhoto). Records enrolled before that pipeline existed, or
 * whose photo arrived through a path that skipped it, sit on NULL columns —
 * the veto can't protect them because there's nothing to compare against.
 *
 * analyzeFacePhoto() (server/services/biometric/photo-analyzer.ts) is a pure
 * buffer -> descriptor-fields function: it calls Gemini vision and (as a
 * side effect, same as any real LLM call) logs to apiTracker and charges the
 * credit ledger, but it does NOT write to biometric_data or any entity table
 * — uploadBiometricPhoto is the one that persists the result. So this script
 * calls analyzeFacePhoto() directly and owns the persistence itself, exactly
 * mirroring what uploadBiometricPhoto does with the fields it gets back.
 *
 * WHAT IT TOUCHES
 * ---------------
 * With --apply: writes ONLY the descriptor columns that are currently
 * NULL/empty on a given row, via explicit-column raw SQL. Never overwrites a
 * non-null value — not even in --recheck mode, when a freshly-computed value
 * disagrees with what's stored. Disagreements are reported, never
 * auto-corrected; a human decides. Never touches face_embedding(s),
 * voice_embedding(s), face_image_url, or anything outside biometric_data.
 *
 * Uses raw SQL rather than the drizzle schema so it works against a database
 * whose migrations lag the local schema (see scripts/diagnose-face-confusion.ts,
 * scripts/reenroll-face-anchor.ts).
 *
 * COST
 * ----
 * Each processed row makes one real analyzeFacePhoto() call (Gemini vision,
 * billed to the credit ledger). The script prints the scoped row count and
 * the resulting call-count estimate BEFORE doing any work, and processes rows
 * strictly sequentially — never in parallel.
 *
 * Usage:
 *   npx tsx scripts/backfill-biometric-attributes.ts --student <studentId> [--apply] [--recheck]
 *   npx tsx scripts/backfill-biometric-attributes.ts --all [--apply] [--recheck]
 *
 *   --student <id>  Scope to one student's known-people pool: the student's
 *                   own biometric record, their ACTIVE contacts', and their
 *                   linked users' (joins students/student_contacts/user_students).
 *   --all           Scope to every biometric_data row that has a face photo.
 *                   Exactly one of --student/--all is required.
 *   --apply         Write the NULL/empty fields computed below. Default is a
 *                   dry run (print only, nothing written).
 *   --recheck       Process ALL scoped rows with a photo (not just rows
 *                   missing a field) and additionally report any field where
 *                   a freshly-computed value disagrees with a stored one.
 *                   This is the periodic-audit mode. Disagreements are
 *                   report-only in every mode, --apply included.
 */
import dotenv from "dotenv";
dotenv.config();

import pg from "pg";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const RECHECK = args.includes("--recheck");
const ALL = args.includes("--all");
const studentFlagIdx = args.indexOf("--student");
const STUDENT_ID = studentFlagIdx >= 0 ? args[studentFlagIdx + 1] : undefined;

if ((!STUDENT_ID && !ALL) || (STUDENT_ID && ALL)) {
  console.error(
    "Usage: npx tsx scripts/backfill-biometric-attributes.ts (--student <studentId> | --all) [--apply] [--recheck]",
  );
  console.error("Exactly one of --student/--all is required.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Fields analyzeFacePhoto() can populate. The attribute-veto trio is the
// reason this script exists; the other three ride along for free on the same
// call and photo-upload.ts writes all six identically, so we do too.
// ---------------------------------------------------------------------------
const VETO_FIELDS = ["estimatedAge", "estimatedSex", "physicalDescription"] as const;
const ALL_FIELDS = [
  "hairColor",
  "eyeColor",
  "estimatedAge",
  "estimatedSex",
  "identifyingFeatures",
  "physicalDescription",
] as const;
type Field = (typeof ALL_FIELDS)[number];

const COLUMN_OF: Record<Field, string> = {
  hairColor: "hair_color",
  eyeColor: "eye_color",
  estimatedAge: "estimated_age",
  estimatedSex: "estimated_sex",
  identifyingFeatures: "identifying_features",
  physicalDescription: "physical_description",
};

const normalize = (s: string): string => s.trim().toLowerCase();

interface ScopedRow {
  id: string;
  faceImageUrl: string | null;
  ownerLabel: string;
  stored: Record<Field, string | null>;
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  ssl: { rejectUnauthorized: false },
});
const q = async (text: string, params: any[] = []) => (await pool.query(text, params)).rows;

// ---------------------------------------------------------------------------
// 1. Resolve scope -> list of biometric_data ids
// ---------------------------------------------------------------------------
let scopedIds: string[];

if (STUDENT_ID) {
  const [student] = await q(
    `select id::text as id, name, biometric_data_id::text as bd_id from students where id = $1`,
    [STUDENT_ID],
  );
  if (!student) {
    console.error(`Student ${STUDENT_ID} not found`);
    await pool.end();
    process.exit(1);
  }

  const poolMembers: { who: string; bdId: string | null }[] = [
    { who: `student:${student.id} "${student.name}"`, bdId: student.bd_id },
  ];

  const contacts = await q(
    `select id::text as id, name, biometric_data_id::text as bd_id
       from student_contacts where student_id = $1 and is_active = true`,
    [STUDENT_ID],
  );
  for (const c of contacts) poolMembers.push({ who: `contact:${c.id} "${c.name}"`, bdId: c.bd_id });

  const linkedUsers = await q(
    `select us.user_id::text as user_id, u.full_name, u.biometric_data_id::text as bd_id
       from user_students us join users u on u.id = us.user_id
      where us.student_id = $1 and us.is_active = true`,
    [STUDENT_ID],
  );
  for (const u of linkedUsers) poolMembers.push({ who: `user:${u.user_id} "${u.full_name}"`, bdId: u.bd_id });

  console.log("=".repeat(78));
  console.log(`BACKFILL BIOMETRIC ATTRIBUTES — ${APPLY ? "APPLY" : "DRY RUN"}${RECHECK ? " / RECHECK" : ""}`);
  console.log("=".repeat(78));
  console.log(`\n=== KNOWN-PEOPLE POOL for student ${STUDENT_ID} "${student.name}" ===`);
  for (const p of poolMembers) console.log(`  ${p.who} -> bd=${p.bdId ?? "(none)"}`);

  const withBd = poolMembers.filter((p) => p.bdId);
  if (withBd.length < poolMembers.length) {
    console.log(`  (${poolMembers.length - withBd.length} pool member(s) have no biometric record — skipped)`);
  }

  scopedIds = [...new Set(withBd.map((p) => p.bdId!))];
  console.log(`\nScope: student "${student.name}" (${STUDENT_ID}) pool -> ${scopedIds.length} unique biometric record(s)`);
} else {
  console.log("=".repeat(78));
  console.log(`BACKFILL BIOMETRIC ATTRIBUTES — ${APPLY ? "APPLY" : "DRY RUN"}${RECHECK ? " / RECHECK" : ""}`);
  console.log("=".repeat(78));
  const rows = await q(`select id::text as id from biometric_data where face_image_url is not null`);
  scopedIds = rows.map((r: any) => r.id);
  console.log(`\nScope: --all -> ${scopedIds.length} biometric_data row(s) with a face photo`);
}

if (!scopedIds.length) {
  console.log("\nNothing in scope. Exiting.");
  await pool.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Load the scoped rows + a best-effort human label for each. A record can
//    be shared (contact linked to a user, say) or, rarely, unreferenced.
// ---------------------------------------------------------------------------
const loaded = await q(
  `select bd.id::text as id, bd.face_image_url, bd.hair_color, bd.eye_color, bd.estimated_age,
          bd.estimated_sex, bd.identifying_features, bd.physical_description,
          coalesce(
            (select string_agg(distinct 'student:' || name, ', ') from students where biometric_data_id = bd.id),
            ''
          ) as student_label,
          coalesce(
            (select string_agg(distinct 'contact:' || name, ', ') from student_contacts where biometric_data_id = bd.id),
            ''
          ) as contact_label,
          coalesce(
            (select string_agg(distinct 'user:' || full_name, ', ') from users where biometric_data_id = bd.id),
            ''
          ) as user_label
     from biometric_data bd
    where bd.id = ANY($1)`,
  [scopedIds],
);

const rows: ScopedRow[] = loaded.map((r: any) => {
  const labels = [r.student_label, r.contact_label, r.user_label].filter(Boolean).join(", ");
  return {
    id: r.id,
    faceImageUrl: r.face_image_url,
    ownerLabel: labels || "(unreferenced record)",
    stored: {
      hairColor: r.hair_color,
      eyeColor: r.eye_color,
      estimatedAge: r.estimated_age,
      estimatedSex: r.estimated_sex,
      identifyingFeatures: r.identifying_features,
      physicalDescription: r.physical_description,
    },
  };
});

const withPhoto = rows.filter((r) => r.faceImageUrl);
const withoutPhoto = rows.filter((r) => !r.faceImageUrl);
if (withoutPhoto.length) {
  console.log(`\n${withoutPhoto.length} scoped record(s) have no face photo — cannot process:`);
  for (const r of withoutPhoto) console.log(`  ${r.id}  ${r.ownerLabel}`);
}

const missingAVetoField = (r: ScopedRow) => VETO_FIELDS.some((f) => !r.stored[f]);
const candidates = RECHECK ? withPhoto : withPhoto.filter(missingAVetoField);

console.log(`\n${withPhoto.length} scoped record(s) have a face photo.`);
console.log(
  RECHECK
    ? `--recheck: processing ALL ${candidates.length} of them.`
    : `${candidates.length} of them are missing at least one of estimated_age/estimated_sex/physical_description.`,
);
console.log(
  `\nESTIMATED LLM VISION CALLS: ${candidates.length} (one analyzeFacePhoto() call per row, billed to the credit ledger)`,
);

if (!candidates.length) {
  console.log("\nNothing to process. Exiting.");
  await pool.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. Process sequentially
// ---------------------------------------------------------------------------
// Imported after dotenv(): photo-analyzer's own imports (apiTracker ->
// credit-ledger -> server/db) throw at import time without DATABASE_URL, and
// s3-service reads S3_UPLOADS_BUCKET at module load. Same pattern as
// scripts/cleanup-orphan-biometric-data.ts and scripts/reenroll-face-anchor.ts.
const { analyzeFacePhoto, NoFaceDetectedError, PhotoAnalysisUnavailableError } = await import(
  "../server/services/biometric/photo-analyzer.js"
);
const { s3Service } = await import("../server/services/storage/s3-service.js");

const disagreements: { id: string; who: string; field: Field; stored: string; computed: string }[] = [];
let wouldOrDidUpdate = 0;
let failed = 0;

for (const [i, row] of candidates.entries()) {
  console.log("\n" + "-".repeat(78));
  console.log(`[${i + 1}/${candidates.length}] ${row.ownerLabel}  bd=${row.id}`);
  console.log(`  photo: ${row.faceImageUrl}`);

  let photo: Buffer;
  try {
    photo = await s3Service.download(row.faceImageUrl!);
  } catch (err: any) {
    console.log(`  DOWNLOAD FAILED: ${err?.message ?? err} — skipped`);
    failed++;
    continue;
  }

  let computed: Awaited<ReturnType<typeof analyzeFacePhoto>>;
  try {
    computed = await analyzeFacePhoto(photo, "image/jpeg", {});
  } catch (err: any) {
    if (err instanceof NoFaceDetectedError) {
      console.log(`  NO FACE DETECTED: ${err.message} — skipped`);
    } else if (err instanceof PhotoAnalysisUnavailableError) {
      console.log(`  ANALYSIS UNAVAILABLE: ${err.message} — skipped`);
    } else {
      console.log(`  ANALYSIS FAILED: ${err?.message ?? err} — skipped`);
    }
    failed++;
    continue;
  }

  console.log(`  ${"field".padEnd(22)} ${"stored".padEnd(50)} computed`);
  const toWrite: Partial<Record<Field, string>> = {};
  for (const f of ALL_FIELDS) {
    const storedVal = row.stored[f];
    const computedVal = computed[f];
    const isEmpty = storedVal == null || storedVal === "";
    let flag = "";
    if (isEmpty && computedVal) {
      toWrite[f] = computedVal;
      flag = "  <- will fill (was NULL)";
    } else if (!isEmpty && computedVal && normalize(storedVal!) !== normalize(computedVal)) {
      flag = "  <<< DISAGREES WITH STORED VALUE";
      disagreements.push({ id: row.id, who: row.ownerLabel, field: f, stored: storedVal!, computed: computedVal });
    }
    console.log(`  ${f.padEnd(22)} ${String(storedVal ?? "NULL").padEnd(50)} ${computedVal ?? "—"}${flag}`);
  }

  const fieldsToWrite = Object.keys(toWrite) as Field[];
  if (!fieldsToWrite.length) {
    console.log("  (nothing to fill — every field already has a stored value)");
  } else if (APPLY) {
    const setClauses = fieldsToWrite.map((f, idx) => `${COLUMN_OF[f]} = $${idx + 2}`).join(", ");
    const values = fieldsToWrite.map((f) => toWrite[f]);
    await pool.query(`update biometric_data set ${setClauses}, updated_at = now() where id = $1`, [row.id, ...values]);
    console.log(`  APPLIED — wrote: ${fieldsToWrite.join(", ")}`);
    wouldOrDidUpdate++;
  } else {
    console.log(`  DRY RUN — would write: ${fieldsToWrite.join(", ")} (re-run with --apply)`);
    wouldOrDidUpdate++;
  }
}

// ---------------------------------------------------------------------------
// 4. Summary
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));
console.log(
  `  processed: ${candidates.length}   failed/skipped: ${failed}   ${APPLY ? "updated" : "would update"}: ${wouldOrDidUpdate}`,
);

if (RECHECK) {
  console.log(`\n=== DISAGREEMENTS (${disagreements.length}) — report only, never auto-fixed ===`);
  if (!disagreements.length) {
    console.log("  none — every populated field matches a freshly-computed value.");
  } else {
    for (const d of disagreements) {
      console.log(`  ${d.who}  bd=${d.id}  ${d.field}: stored="${d.stored}"  computed="${d.computed}"`);
    }
  }
}

if (!APPLY) {
  console.log("\nDRY RUN — nothing was written. Re-run with --apply to write the NULL/empty fields shown above.");
}

await pool.end();
