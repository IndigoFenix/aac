/**
 * Diagnose a face-confusion pair: given a student_contacts id, load that
 * contact + its student, dump both biometric records' geometry (anchor +
 * gallery), and compute all cross-distances to see whether the two people
 * are separable at the current FACE_MATCH_THRESHOLD, and whether either
 * gallery holds a "poisoned" pose that is really the other person.
 *
 * Read-only. Prints metadata and distances, never raw embeddings.
 * Uses raw SQL (not the drizzle schema) so it works even when the local
 * schema is ahead of the target DB's migrations.
 *
 * Usage:
 *   npx tsx scripts/diagnose-face-confusion.ts <contactId>
 */
import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';

const contactId = process.argv[2];
if (!contactId) {
  console.error('Usage: npx tsx scripts/diagnose-face-confusion.ts <contactId>');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  ssl: { rejectUnauthorized: false },
});
const q = async (text: string, params: any[] = []) => (await pool.query(text, params)).rows;

const FACE_MATCH_THRESHOLD = 0.6;

function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

interface Sample {
  label: string;
  embedding: number[];
  quality?: number;
  capturedAt?: string;
  weight?: number;
}

function samplesOf(bd: any, who: string): Sample[] {
  const out: Sample[] = [];
  if (Array.isArray(bd?.face_embedding) && bd.face_embedding.length) {
    out.push({ label: `${who}.anchor`, embedding: bd.face_embedding });
  }
  if (Array.isArray(bd?.face_embeddings)) {
    bd.face_embeddings.forEach((g: any, i: number) => {
      if (Array.isArray(g?.embedding) && g.embedding.length) {
        out.push({
          label: `${who}.gallery[${i}]`,
          embedding: g.embedding,
          quality: g.quality,
          capturedAt: g.capturedAt,
          weight: g.weight,
        });
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
const [contact] = await q(
  `select id, student_id, name, relationship, linked_user_id, linked_student_id,
          biometric_data_id, context_notes, last_seen_at, times_identified, is_active
     from student_contacts where id = $1`,
  [contactId],
);
if (!contact) {
  console.error(`Contact ${contactId} not found`);
  process.exit(1);
}
console.log('=== CONTACT ===');
console.log(contact);

const [student] = await q(
  `select id, name, biometric_data_id from students where id = $1`,
  [contact.student_id],
);
if (!student) {
  console.error(`Student ${contact.student_id} not found`);
  process.exit(1);
}
console.log('=== STUDENT ===');
console.log(student);

if (contact.biometric_data_id && contact.biometric_data_id === student.biometric_data_id) {
  console.log('\n!!! CONTACT AND STUDENT SHARE THE SAME biometric_data ROW — that alone explains the confusion.');
}

const loadBd = async (id: string | null) =>
  id
    ? (await q(
        `select id, face_embedding, face_embeddings, voice_embedding, voice_embeddings,
                face_image_url, physical_description, created_at, updated_at
           from biometric_data where id = $1`,
        [id],
      ))[0]
    : undefined;

const studentBd = await loadBd(student.biometric_data_id);
const contactBd = await loadBd(contact.biometric_data_id);

function describeBd(bd: any, who: string) {
  console.log(`\n=== BIOMETRIC ${who} (${bd?.id ?? 'NONE'}) ===`);
  if (!bd) return;
  console.log({
    hasAnchor: Array.isArray(bd.face_embedding) && bd.face_embedding.length > 0,
    anchorDims: Array.isArray(bd.face_embedding) ? bd.face_embedding.length : 0,
    gallerySize: Array.isArray(bd.face_embeddings) ? bd.face_embeddings.length : 0,
    hasVoiceAnchor: Array.isArray(bd.voice_embedding) && bd.voice_embedding.length > 0,
    voiceGallerySize: Array.isArray(bd.voice_embeddings) ? bd.voice_embeddings.length : 0,
    faceImageUrl: bd.face_image_url ?? null,
    physicalDescription: bd.physical_description ?? null,
    createdAt: bd.created_at,
    updatedAt: bd.updated_at,
  });
  if (Array.isArray(bd.face_embeddings)) {
    for (const [i, g] of bd.face_embeddings.entries()) {
      console.log(
        `  gallery[${i}] q=${g?.quality?.toFixed?.(2)} w=${g?.weight?.toFixed?.(2)} capturedAt=${g?.capturedAt}`,
      );
    }
  }
}
describeBd(studentBd, 'STUDENT');
describeBd(contactBd, 'CONTACT');

const S = samplesOf(studentBd, 'student');
const C = samplesOf(contactBd, 'contact');

console.log('\n=== WITHIN-PERSON SPREAD ===');
for (const [name, set] of [['student', S], ['contact', C]] as const) {
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      console.log(`  ${set[i].label} <-> ${set[j].label}: ${dist(set[i].embedding, set[j].embedding).toFixed(4)}`);
    }
  }
  if (set.length < 2) console.log(`  (${name}: fewer than 2 samples)`);
}

console.log('\n=== CROSS-PERSON DISTANCES (threshold = 0.6; < threshold can cross-match) ===');
let minCross = Infinity;
let minPair = '';
for (const s of S) {
  for (const c of C) {
    if (s.embedding.length !== c.embedding.length) {
      console.log(`  ${s.label} <-> ${c.label}: DIM MISMATCH ${s.embedding.length} vs ${c.embedding.length}`);
      continue;
    }
    const d = dist(s.embedding, c.embedding);
    const flag = d < FACE_MATCH_THRESHOLD ? '  <<< WITHIN MATCH THRESHOLD' : '';
    console.log(`  ${s.label} <-> ${c.label}: ${d.toFixed(4)}${flag}`);
    if (d < minCross) {
      minCross = d;
      minPair = `${s.label} <-> ${c.label}`;
    }
  }
}
if (S.length && C.length) console.log(`\n  MIN cross distance: ${minCross.toFixed(4)} (${minPair})`);

console.log("\n=== POISON CHECK (entry closer to the OTHER person's anchor than its own) ===");
const anchorOf = (set: Sample[]) => set.find((s) => s.label.endsWith('.anchor'));
const sAnchor = anchorOf(S);
const cAnchor = anchorOf(C);
let poisoned = 0;
for (const [set, own, other] of [
  [S, sAnchor, cAnchor],
  [C, cAnchor, sAnchor],
] as const) {
  for (const e of set) {
    if (e.label.endsWith('.anchor') || !own || !other) continue;
    if (own.embedding.length !== e.embedding.length || other.embedding.length !== e.embedding.length) continue;
    const dOwn = dist(e.embedding, own.embedding);
    const dOther = dist(e.embedding, other.embedding);
    if (dOther < dOwn) {
      poisoned++;
      console.log(`  !!! ${e.label}: d(own anchor)=${dOwn.toFixed(4)} but d(other anchor)=${dOther.toFixed(4)} — likely the OTHER person`);
    }
  }
}
if (!poisoned) console.log('  none found');

// ---------------------------------------------------------------------------
console.log('\n=== FULL KNOWN-PEOPLE POOL FOR THIS STUDENT ===');
const otherContacts = await q(
  `select id, name, relationship, biometric_data_id as bd_id, linked_user_id, linked_student_id, is_active
     from student_contacts where student_id = $1`,
  [contact.student_id],
);
const linkedUsers = await q(
  `select us.user_id, us.role, u.biometric_data_id as bd_id, u.full_name
     from user_students us join users u on u.id = us.user_id
    where us.student_id = $1 and us.is_active = true`,
  [contact.student_id],
);

const pool2: { who: string; bdId: string | null }[] = [
  ...otherContacts.map((c: any) => ({
    who: `contact:${c.id} ${c.name} (${c.relationship}, active=${c.is_active}, linkedUser=${c.linked_user_id}, linkedStudent=${c.linked_student_id})`,
    bdId: c.bd_id,
  })),
  ...linkedUsers.map((u: any) => ({ who: `user:${u.user_id} ${u.full_name} (${u.role})`, bdId: u.bd_id })),
];
for (const p of pool2) console.log(`  ${p.who} bd=${p.bdId}`);

if (sAnchor) {
  console.log('\n=== POOL SAMPLE DISTANCES TO STUDENT ANCHOR ===');
  for (const p of pool2) {
    if (!p.bdId || p.bdId === student.biometric_data_id) continue;
    const bd = await loadBd(p.bdId);
    for (const smp of samplesOf(bd, p.who.slice(0, 60))) {
      if (smp.embedding.length !== sAnchor.embedding.length) continue;
      const d = dist(smp.embedding, sAnchor.embedding);
      const flag = d < FACE_MATCH_THRESHOLD ? '  <<< WITHIN MATCH THRESHOLD' : '';
      console.log(`  ${smp.label}: ${d.toFixed(4)}${flag}`);
    }
  }
}

await pool.end();
