/**
 * Face recognition pipeline tests.
 *
 * Covers the server-side matching path used by the live-relay when the AAC
 * client sends face descriptors during a session: a contact's face embedding
 * is enrolled, a near-identical descriptor is matched, and a far descriptor
 * is rejected. Also verifies that recordContactSighting bumps the counter
 * (used by the rate-limited sighting bumper in live-relay).
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { truncateAll, db } from '../helpers/db.js';
import {
  makeUser,
  makeStudent,
  makeInstitute,
  addUserToInstitute,
  enrollStudent,
} from '../helpers/factories.js';
import {
  createContact,
  updateContact,
  deleteContact,
  ContactLinkError,
  releaseBiometricData,
  ensureBiometricData,
  enrollContactFace,
  findMatchingFace,
  recordContactSighting,
  getKnownPeopleForStudent,
  getPeopleDirectoryForStudent,
  getLinkableEntitiesForStudent,
  growFaceGalleryForEntity,
  penalizeFaceMatch,
  updateBiometricData,
  type FaceGalleryEntry,
} from '../../services/biometric/recognition-service.js';
import { studentContacts, biometricData } from '@shared/schema';
import { eq } from 'drizzle-orm';

const EMBEDDING_DIM = 128;

function makeEmbedding(seed: number, jitter = 0): number[] {
  const out: number[] = new Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const v = Math.sin(seed * 17 + i * 0.3);
    out[i] = v + (jitter ? jitter * Math.sin(i * 1.7 + seed) : 0);
  }
  return out;
}

/** A zero vector — a clean base for building embeddings at exact distances. */
function zeroVec(): number[] {
  return new Array(EMBEDDING_DIM).fill(0);
}

/**
 * Return a copy of `from` at an EXACT euclidean distance `dist`, by perturbing
 * `k` dimensions starting at `offsetDim`. Using disjoint dimension ranges for
 * different poses makes their mutual distances predictable (orthogonal), which
 * lets the tests assert which stored face a probe is closest to.
 */
function atDistance(from: number[], dist: number, offsetDim: number, k = 16): number[] {
  const out = from.slice();
  const per = dist / Math.sqrt(k);
  for (let i = 0; i < k; i++) out[offsetDim + i] += per;
  return out;
}

/** Read a contact's biometric_data id so a test can seed its gallery directly. */
async function bdIdForContact(contactId: string): Promise<string> {
  const [c] = await db
    .select({ bd: studentContacts.biometricDataId })
    .from(studentContacts)
    .where(eq(studentContacts.id, contactId));
  return c.bd!;
}

describe('Face recognition pipeline', () => {
  afterEach(truncateAll);

  let userId: string;
  let studentId: string;

  beforeEach(async () => {
    const user = await makeUser();
    const { student } = await makeStudent(user.id);
    userId = user.id;
    studentId = student.id;
  });

  it('matches an enrolled contact face to the original descriptor', async () => {
    const motherEmbedding = makeEmbedding(1);
    const contact = await createContact({
      studentId,
      name: 'Mother',
      relationship: 'mother',
    } as any);
    await enrollContactFace(contact.id, motherEmbedding);

    const match = await findMatchingFace(motherEmbedding, studentId);
    expect(match).not.toBeNull();
    expect(match!.matched).toBe(true);
    expect(match!.entityType).toBe('contact');
    expect(match!.entityId).toBe(contact.id);
    expect(match!.name).toBe('Mother');
    expect(match!.relationship).toBe('mother');
    expect(match!.confidence).toBeGreaterThan(0.9);
    expect(match!.sampleCount).toBe(1); // anchor only, no gallery yet
  });

  it('returns null when the descriptor is far from every known embedding', async () => {
    const enrolled = makeEmbedding(1);
    const contact = await createContact({
      studentId,
      name: 'Mother',
      relationship: 'mother',
    } as any);
    await enrollContactFace(contact.id, enrolled);

    const stranger = makeEmbedding(900); // unrelated seed
    const match = await findMatchingFace(stranger, studentId);
    expect(match).toBeNull();
  });

  it('picks the closer of two enrolled faces', async () => {
    const momEmbedding = makeEmbedding(1);
    const dadEmbedding = makeEmbedding(50);
    const mom = await createContact({
      studentId, name: 'Mom', relationship: 'mother',
    } as any);
    const dad = await createContact({
      studentId, name: 'Dad', relationship: 'father',
    } as any);
    await enrollContactFace(mom.id, momEmbedding);
    await enrollContactFace(dad.id, dadEmbedding);

    const noisyMom = makeEmbedding(1, 0.005); // tiny jitter, still closest to mom
    const match = await findMatchingFace(noisyMom, studentId);
    expect(match!.matched).toBe(true);
    expect(match!.entityId).toBe(mom.id);
  });

  it('exposes contacts via getKnownPeopleForStudent so the client can preview the pool', async () => {
    const e1 = makeEmbedding(2);
    const c1 = await createContact({
      studentId, name: 'Sister', relationship: 'sibling',
    } as any);
    await enrollContactFace(c1.id, e1);

    const known = await getKnownPeopleForStudent(studentId);
    const sister = known.find(p => p.id === c1.id);
    expect(sister).toBeDefined();
    expect(sister!.faceEmbedding).toHaveLength(EMBEDDING_DIM);
  });

  it('lists ALL active contacts in the people directory — even those with no face embedding', async () => {
    // The sentence-builder person list must surface everyone the student can
    // talk about, not just the camera-matchable pool. A contact with no
    // enrolled face is excluded from getKnownPeopleForStudent but must still
    // appear in the directory.
    const withFace = await createContact({
      studentId, name: 'Grandma', relationship: 'grandparent',
    } as any);
    await enrollContactFace(withFace.id, makeEmbedding(3));
    const noFace = await createContact({
      studentId, name: 'Bus Driver', relationship: 'other',
    } as any);

    const known = await getKnownPeopleForStudent(studentId);
    expect(known.find(p => p.id === noFace.id)).toBeUndefined(); // no embedding → not in matching pool

    const directory = await getPeopleDirectoryForStudent(studentId);
    const ids = directory.map(p => p.id);
    expect(ids).toContain(withFace.id);
    expect(ids).toContain(noFace.id);
    // Includes the student themselves as a selectable person.
    expect(ids).toContain(studentId);
    // No photo uploaded → hasPhoto is false.
    expect(directory.find(p => p.id === noFace.id)!.hasPhoto).toBe(false);
  });

  it('matches a pose far from the enrolled anchor via the multi-angle gallery', async () => {
    // The anchor only captures one frontal pose. A side/under-lit frame sits
    // beyond the 0.6 match threshold from it and would be REJECTED if matching
    // used the anchor alone — but it matches because the gallery holds that pose.
    const anchor = zeroVec();
    const contact = await createContact({
      studentId, name: 'Mom', relationship: 'mother',
    } as any);
    await enrollContactFace(contact.id, anchor);

    // A profile pose 0.8 away from the anchor (beyond threshold) seeded directly.
    const profilePose = atDistance(anchor, 0.8, /*offsetDim*/ 0);
    const gallery: FaceGalleryEntry[] = [
      { embedding: profilePose, quality: 0.9, capturedAt: new Date().toISOString(), weight: 1 },
    ];
    await updateBiometricData(await bdIdForContact(contact.id), { faceEmbeddings: gallery });

    // A probe very close to the profile pose (0.1) but ~0.8 from the anchor.
    const probe = atDistance(profilePose, 0.1, /*offsetDim*/ 32);

    // Sanity: anchor alone would reject (distance ~0.81 > 0.6 threshold).
    const anchorOnly = await findMatchingFace(probe, studentId);
    // With the gallery present it must match Mom via the profile pose.
    expect(anchorOnly).not.toBeNull();
    expect(anchorOnly!.entityId).toBe(contact.id);
    expect(anchorOnly!.distance).toBeLessThan(0.2);
    expect(anchorOnly!.sampleCount).toBe(2); // anchor + 1 gallery pose
  });

  it('ignores a gallery pose whose weight has fallen below the floor', async () => {
    const anchor = zeroVec();
    const contact = await createContact({
      studentId, name: 'Mom', relationship: 'mother',
    } as any);
    await enrollContactFace(contact.id, anchor);

    // A far pose at weight 0.2 (below the 0.25 floor) — must NOT be used to match.
    const farPose = atDistance(anchor, 0.8, 0);
    await updateBiometricData(await bdIdForContact(contact.id), {
      faceEmbeddings: [{ embedding: farPose, quality: 0.9, capturedAt: new Date().toISOString(), weight: 0.2 }],
    });

    const probe = atDistance(farPose, 0.1, 32); // close to the dead pose, far from anchor
    const match = await findMatchingFace(probe, studentId);
    expect(match).toBeNull(); // dead pose ignored, anchor too far → no match
  });

  it('grows the gallery only for good-quality, genuinely-novel poses', async () => {
    const anchor = zeroVec();
    const contact = await createContact({
      studentId, name: 'Mom', relationship: 'mother',
    } as any);
    await enrollContactFace(contact.id, anchor);
    const target = { type: 'contact' as const, id: contact.id };

    // A novel pose 0.4 from the anchor (inside the [0.32, 0.5] band) → added.
    const novel = atDistance(anchor, 0.4, 0);
    expect((await growFaceGalleryForEntity(target, novel, 0.9)).reason).toBe('added');

    // Near-identical to the anchor (0.2) → redundant, not added.
    const redundant = atDistance(anchor, 0.2, 0);
    expect((await growFaceGalleryForEntity(target, redundant, 0.9)).reason).toBe('redundant');

    // Far from everything (0.9, orthogonal dims) → too risky to trust, refused.
    const tooFar = atDistance(anchor, 0.9, 48);
    expect((await growFaceGalleryForEntity(target, tooFar, 0.9)).reason).toBe('too-far');

    // Novel distance but poor quality → rejected by the quality gate.
    const novel2 = atDistance(anchor, 0.4, 64);
    expect((await growFaceGalleryForEntity(target, novel2, 0.1)).reason).toBe('low-quality');

    const known = await getKnownPeopleForStudent(studentId);
    expect(known.find(p => p.id === contact.id)!.faceGallery).toHaveLength(1);
  });

  it('penalizes and eventually evicts the gallery pose behind a misidentification', async () => {
    const anchor = zeroVec();
    const contact = await createContact({
      studentId, name: 'Mom', relationship: 'mother',
    } as any);
    await enrollContactFace(contact.id, anchor);
    const bdId = await bdIdForContact(contact.id);

    const badPose = atDistance(anchor, 0.8, 0);
    await updateBiometricData(bdId, {
      faceEmbeddings: [{ embedding: badPose, quality: 0.9, capturedAt: new Date().toISOString(), weight: 1 }],
    });
    const target = { type: 'contact' as const, id: contact.id };

    // The descriptor that wrongly matched is near the bad pose (and far from anchor),
    // so the penalty targets the gallery entry, not the curated anchor.
    const wrongDescriptor = atDistance(badPose, 0.1, 32);

    const first = await penalizeFaceMatch(target, wrongDescriptor);
    expect(first.penalized).toBe('gallery');
    expect(first.evicted).toBe(false); // weight 1 → 0.5

    const second = await penalizeFaceMatch(target, wrongDescriptor);
    expect(second.penalized).toBe('gallery');
    expect(second.evicted).toBe(true); // weight 0.5 → 0.25 ≤ floor → removed
    expect(second.size).toBe(0);

    const known = await getKnownPeopleForStudent(studentId);
    expect(known.find(p => p.id === contact.id)!.faceGallery).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Biometric record lifecycle
  // --------------------------------------------------------------------------
  // biometric_data is referenced, never referencing. Once the last holder lets
  // go, the row is unreachable — a face embedding and a face photo that no UI
  // and no erasure path can ever find again. Every release path must clean up.

  describe('releasing biometric records', () => {
    it('drops the row a contact abandons when it is linked to a user', async () => {
      const contact = await createContact({ studentId, name: 'Ari' } as any);
      await enrollContactFace(contact.id, makeEmbedding(3));
      const ownRecord = await bdIdForContact(contact.id);
      await updateBiometricData(ownRecord, { faceImageUrl: 'biometric/contact-own.jpg' });

      // Linking re-points the contact at the user's canonical record.
      const linkTarget = await makeUser();
      await updateContact(contact.id, { linkedUserId: linkTarget.id } as any);

      const nowPointsAt = await bdIdForContact(contact.id);
      expect(nowPointsAt).not.toBe(ownRecord);

      const [stranded] = await db
        .select()
        .from(biometricData)
        .where(eq(biometricData.id, ownRecord));
      expect(stranded).toBeUndefined();
    });

    it('leaves a record alone while any holder still points at it', async () => {
      const shared = await makeUser();
      const contact = await createContact({
        studentId, name: 'Shared Person', linkedUserId: shared.id,
      } as any);
      const bdId = await bdIdForContact(contact.id);

      // The user still holds this record, so releasing on the contact's behalf
      // must be a no-op — it isn't this contact's to delete.
      const orphanedKey = await releaseBiometricData(bdId);

      expect(orphanedKey).toBeNull();
      const [row] = await db.select().from(biometricData).where(eq(biometricData.id, bdId));
      expect(row).toBeDefined();
    });

    it('reports the orphaned S3 key so the caller can delete the photo', async () => {
      const contact = await createContact({ studentId, name: 'Photo Only' } as any);
      await enrollContactFace(contact.id, makeEmbedding(4));
      const bdId = await bdIdForContact(contact.id);
      await updateBiometricData(bdId, { faceImageUrl: 'biometric/orphan-me.jpg' });

      // Drop the only reference, then release.
      await db.delete(studentContacts).where(eq(studentContacts.id, contact.id));
      const orphanedKey = await releaseBiometricData(bdId);

      expect(orphanedKey).toBe('biometric/orphan-me.jpg');
      const [row] = await db.select().from(biometricData).where(eq(biometricData.id, bdId));
      expect(row).toBeUndefined();
    });

    it('hands the record back when a contact is UNLINKED', async () => {
      // Setting a link makes the contact share the linked person's record.
      // Removing it must hand that record back — otherwise the contact keeps
      // writing to a face that is no longer theirs.
      const other = await makeUser();
      const contact = await createContact({ studentId, name: 'Was Linked' } as any);
      await updateContact(contact.id, { linkedUserId: other.id } as any);
      const shared = await bdIdForContact(contact.id);
      expect(shared).toBe(await ensureBiometricData({ type: 'user', id: other.id }));

      await updateContact(contact.id, { linkedUserId: null } as any);

      const [after] = await db
        .select({ bd: studentContacts.biometricDataId })
        .from(studentContacts)
        .where(eq(studentContacts.id, contact.id));
      expect(after.bd).toBeNull();

      // The user still holds their own record — handing it back must not delete it.
      const [stillThere] = await db.select().from(biometricData).where(eq(biometricData.id, shared));
      expect(stillThere).toBeDefined();
    });

    it("never lets an unlinked contact write into someone else's record", async () => {
      // Reproduces the reported failure: a contact left pointing at a student's
      // record (by a link that was removed before this guard existed) uploaded a
      // photo, and it replaced the STUDENT's face.
      const contact = await createContact({ studentId, name: 'Stale Share' } as any);
      const studentRecord = await ensureBiometricData({ type: 'student', id: studentId });
      await updateBiometricData(studentRecord, { faceImageUrl: 'biometric/the-student.jpg' });
      // Force the bad state the old unlink path used to leave behind.
      await db
        .update(studentContacts)
        .set({ biometricDataId: studentRecord })
        .where(eq(studentContacts.id, contact.id));

      // What a photo upload does first.
      const writeTarget = await ensureBiometricData({ type: 'contact', id: contact.id });

      expect(writeTarget).not.toBe(studentRecord);
      expect(await bdIdForContact(contact.id)).toBe(writeTarget);
      // The student's record is untouched — photo included.
      const [student] = await db.select().from(biometricData).where(eq(biometricData.id, studentRecord));
      expect(student.faceImageUrl).toBe('biometric/the-student.jpg');
    });

    it('still reuses the record an unlinked contact holds alone', async () => {
      const contact = await createContact({ studentId, name: 'Sole Owner' } as any);
      const own = await ensureBiometricData({ type: 'contact', id: contact.id });

      expect(await ensureBiometricData({ type: 'contact', id: contact.id })).toBe(own);
    });

    it('is a no-op for a missing or null id', async () => {
      await expect(releaseBiometricData(null)).resolves.toBeNull();
      await expect(releaseBiometricData(undefined)).resolves.toBeNull();
      await expect(releaseBiometricData('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
    });
  });

  describe('one account, one contact', () => {
    // Choosing an account says "this contact IS that person". Two contacts of
    // the same student pointing at one account claim the same human twice —
    // and both would write to that person's face record.
    it('refuses a second contact claiming an account another contact already is', async () => {
      const account = await makeUser();
      await createContact({ studentId, name: 'Mum', linkedUserId: account.id } as any);

      const err = await createContact({
        studentId, name: 'Mum again', linkedUserId: account.id,
      } as any).catch((e) => e);

      expect(err).toBeInstanceOf(ContactLinkError);
      expect(err.code).toBe('DUPLICATE_LINK');
      expect(err.message).toContain('Mum');
    });

    it('refuses an UPDATE that moves a contact onto a taken account', async () => {
      const account = await makeUser();
      await createContact({ studentId, name: 'Dad', linkedUserId: account.id } as any);
      const other = await createContact({ studentId, name: 'Uncle' } as any);

      const err = await updateContact(other.id, { linkedUserId: account.id } as any).catch((e) => e);

      expect(err).toBeInstanceOf(ContactLinkError);
      expect(err.code).toBe('DUPLICATE_LINK');
    });

    it('lets a contact keep the account it already claims', async () => {
      const account = await makeUser();
      const contact = await createContact({
        studentId, name: 'Sister', linkedUserId: account.id,
      } as any);

      // Editing any other field re-validates the same link — must not self-trip.
      const updated = await updateContact(contact.id, { relationship: 'sister' } as any);
      expect(updated!.linkedUserId).toBe(account.id);

      const resent = await updateContact(contact.id, { linkedUserId: account.id } as any);
      expect(resent!.linkedUserId).toBe(account.id);
    });

    it('frees the account again once the claiming contact is removed', async () => {
      const account = await makeUser();
      const first = await createContact({ studentId, name: 'Nanny', linkedUserId: account.id } as any);
      await deleteContact(first.id);

      const second = await createContact({
        studentId, name: 'Nanny (again)', linkedUserId: account.id,
      } as any);
      expect(second.linkedUserId).toBe(account.id);
    });

    it('scopes the rule to one student — another student may list the same person', async () => {
      const account = await makeUser();
      const { student: otherStudent } = await makeStudent(userId);
      await createContact({ studentId, name: 'Therapist', linkedUserId: account.id } as any);

      const theirs = await createContact({
        studentId: otherStudent.id, name: 'Therapist', linkedUserId: account.id,
      } as any);
      expect(theirs.linkedUserId).toBe(account.id);
    });

    it('greys the taken account out in the picker instead of waiting for the save', async () => {
      const { institute } = await makeInstitute(userId);
      await enrollStudent(institute.id, studentId, userId);
      const account = await makeUser();
      await addUserToInstitute(institute.id, account.id);
      const contact = await createContact({ studentId, name: 'Grandad', linkedUserId: account.id } as any);

      const entities = await getLinkableEntitiesForStudent(studentId);
      const entry = entities.find((e) => e.type === 'user' && e.id === account.id);
      expect(entry?.takenByContactId).toBe(contact.id);
      expect(entry?.takenByContactName).toBe('Grandad');
    });
  });

  it('bumps timesIdentified when recordContactSighting fires', async () => {
    const contact = await createContact({
      studentId, name: 'Teacher', relationship: 'teacher',
    } as any);
    expect(contact.timesIdentified).toBe(0);

    await recordContactSighting(contact.id);
    await recordContactSighting(contact.id);

    const [reloaded] = await db
      .select()
      .from(studentContacts)
      .where(eq(studentContacts.id, contact.id));
    expect(reloaded.timesIdentified).toBe(2);
    expect(reloaded.lastSeenAt).toBeInstanceOf(Date);
  });
});
