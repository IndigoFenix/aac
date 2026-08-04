/**
 * Garbage-collect unreferenced biometric_data rows (and their S3 face photos).
 *
 * biometric_data is referenced, never referencing: users / students /
 * student_contacts each hold the FK. A row whose last holder dropped the
 * reference is unreachable — no UI can show it and no erasure path can find it,
 * yet it still holds a face embedding and a face photo. That is exactly the
 * kind of residue the retention rules don't allow to sit around.
 *
 * The live code now releases these at the moment the reference is dropped (see
 * releaseBiometricData); this script is the sweep for rows orphaned BEFORE that
 * guard existed, and the safety net if a blob delete ever fails mid-flight.
 *
 * Usage:
 *   npx tsx scripts/cleanup-orphan-biometric-data.ts            # dry run
 *   npx tsx scripts/cleanup-orphan-biometric-data.ts --apply    # delete
 */
import dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');

// Imported after dotenv: server/db.ts throws at import time without DATABASE_URL.
const { db } = await import('../server/db.js');
const { s3Service } = await import('../server/services/storage/s3-service.js');
const { biometricData, users, students, studentContacts } = await import('@shared/schema');
const { eq, sql } = await import('drizzle-orm');

const orphans = await db
  .select({
    id: biometricData.id,
    faceImageUrl: biometricData.faceImageUrl,
    hasFace: sql<boolean>`${biometricData.faceEmbedding} is not null`,
    hasVoice: sql<boolean>`${biometricData.voiceEmbedding} is not null`,
    createdAt: biometricData.createdAt,
    updatedAt: biometricData.updatedAt,
  })
  .from(biometricData)
  .where(
    sql`not exists (select 1 from ${users} u where u.biometric_data_id = ${biometricData.id})
     and not exists (select 1 from ${students} s where s.biometric_data_id = ${biometricData.id})
     and not exists (select 1 from ${studentContacts} c where c.biometric_data_id = ${biometricData.id})`,
  );

console.log(`${APPLY ? 'DELETING' : 'DRY RUN —'} ${orphans.length} unreferenced biometric_data row(s)`);
for (const o of orphans) {
  console.log(
    `  ${o.id}  image=${o.faceImageUrl ?? '(none)'}  face=${o.hasFace}  voice=${o.hasVoice}  created=${o.createdAt?.toISOString?.() ?? o.createdAt}`,
  );
}

// ---------------------------------------------------------------------------
// Stale shares — reported, never auto-repaired.
// ---------------------------------------------------------------------------
// A contact may share someone's biometric record ONLY while a link says it is
// the same person. An UNLINKED contact sitting on a shared record is a leftover
// from a link that was removed, and its next photo upload writes over the other
// person's face (this is how a contact's photo replaced a student's). The live
// code now hands the record back on unlink and refuses the write; this report
// catches rows that predate those guards. Splitting one apart is a judgement
// call about whose face is whose, so it is deliberately left to a human.
const staleShares = await db
  .select({
    contactId: studentContacts.id,
    name: studentContacts.name,
    studentId: studentContacts.studentId,
    biometricDataId: studentContacts.biometricDataId,
  })
  .from(studentContacts)
  .where(
    sql`${studentContacts.linkedUserId} is null
     and ${studentContacts.linkedStudentId} is null
     and ${studentContacts.biometricDataId} is not null
     and (
       exists (select 1 from ${users} u where u.biometric_data_id = ${studentContacts.biometricDataId})
       or exists (select 1 from ${students} s where s.biometric_data_id = ${studentContacts.biometricDataId})
       or exists (select 1 from ${studentContacts} o
                   where o.biometric_data_id = ${studentContacts.biometricDataId}
                     and o.id <> ${studentContacts.id})
     )`,
  );

if (staleShares.length) {
  console.log(`\n⚠  ${staleShares.length} unlinked contact(s) sharing someone else's biometric record:`);
  for (const s of staleShares) {
    console.log(`  contact ${s.contactId} "${s.name}" (student ${s.studentId}) → ${s.biometricDataId}`);
  }
  console.log('  Their next photo upload would have overwritten the other person\'s face.');
  console.log('  NOT auto-repaired — deciding whose face is on that record needs a human.');
} else {
  console.log('\nNo stale shares: every shared biometric record is backed by a link.');
}

if (!APPLY) {
  console.log('\nNothing written. Re-run with --apply to delete these rows and their S3 photos.');
  process.exit(0);
}

let rows = 0;
let blobs = 0;
const failedBlobs: string[] = [];
for (const o of orphans) {
  // Blob first: if the row went first and this threw, the key would be lost.
  if (o.faceImageUrl) {
    try {
      await s3Service.delete(o.faceImageUrl);
      blobs++;
    } catch (err: any) {
      failedBlobs.push(`${o.faceImageUrl} (${err?.message})`);
    }
  }
  await db.delete(biometricData).where(eq(biometricData.id, o.id));
  rows++;
}

console.log(`\nDeleted ${rows} row(s) and ${blobs} S3 object(s).`);
if (failedBlobs.length) {
  console.log(`S3 deletes that failed (row dropped anyway — sweep the bucket):\n  ${failedBlobs.join('\n  ')}`);
}
process.exit(0);
