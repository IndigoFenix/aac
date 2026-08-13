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
  attributeVeto,
  parseEstimatedAge,
  parseEstimatedSex,
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
    // Unrelated seeds are far apart, so this is a clear-cut win — no tie flag.
    expect(match!.ambiguousWith).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Doppelgänger margin
  // --------------------------------------------------------------------------
  // A threshold says "close enough to be this person"; it never says "closer to
  // this person than to that one". Family faces routinely sit inside the
  // threshold of EACH OTHER (measured for one student: sister 0.4527, brother
  // 0.5508, mother 0.5613, grandmother 0.6045), so the winner-takes-all matcher
  // named one of them with full confidence off a coin-flip's worth of evidence.

  describe('doppelgänger margin', () => {
    it('flags the runner-up when two lookalike relatives are nearly equidistant', async () => {
      // Sister and brother 0.30 apart — genuinely different faces, but close.
      const sisterFace = zeroVec();
      const brotherFace = atDistance(sisterFace, 0.3, /*offsetDim*/ 0);

      const sister = await createContact({
        studentId, name: 'Sister', relationship: 'sibling',
      } as any);
      const brother = await createContact({
        studentId, name: 'Brother', relationship: 'sibling',
      } as any);
      await enrollContactFace(sister.id, sisterFace);
      await enrollContactFace(brother.id, brotherFace);

      // A probe ON the line between them: 0.14 from the sister, 0.16 from the
      // brother. Both clear the 0.6 threshold; the 0.02 separation does not
      // clear the 0.08 margin.
      const probe = atDistance(sisterFace, 0.14, 0);

      const match = await findMatchingFace(probe, studentId);
      expect(match).not.toBeNull();
      expect(match!.matched).toBe(true);
      // The winner is still reported exactly as before...
      expect(match!.entityId).toBe(sister.id);
      expect(match!.distance).toBeCloseTo(0.14, 4);
      expect(match!.confidence).toBeCloseTo(1 - 0.14 / 0.6, 4);
      expect(match!.sampleCount).toBe(1);
      // ...but carries the person it could not be told apart from.
      expect(match!.ambiguousWith).toBeDefined();
      expect(match!.ambiguousWith!.entityType).toBe('contact');
      expect(match!.ambiguousWith!.entityId).toBe(brother.id);
      expect(match!.ambiguousWith!.name).toBe('Brother');
      expect(match!.ambiguousWith!.relationship).toBe('sibling');
      expect(match!.ambiguousWith!.distance).toBeCloseTo(0.16, 4);
      expect(match!.runnerUpDistance).toBeCloseTo(0.16, 4);
    });

    it('flags the tie even when the runner-up is OUTSIDE the match threshold', async () => {
      // Separation is what matters, not whether the runner-up also matched.
      // Someone 0.02 past the line is every bit as likely to be the subject as
      // the winner who scraped inside it.
      const sisterFace = zeroVec();
      const probe = atDistance(sisterFace, 0.58, /*offsetDim*/ 0); // 0.58 → matches
      // Orthogonal dims, so the grandmother sits exactly 0.62 from the probe.
      const grandmaFace = atDistance(probe, 0.62, /*offsetDim*/ 32);

      const sister = await createContact({
        studentId, name: 'Sister', relationship: 'sibling',
      } as any);
      const grandma = await createContact({
        studentId, name: 'Grandma', relationship: 'grandparent',
      } as any);
      await enrollContactFace(sister.id, sisterFace);
      await enrollContactFace(grandma.id, grandmaFace);

      const match = await findMatchingFace(probe, studentId);
      expect(match).not.toBeNull();
      expect(match!.entityId).toBe(sister.id);
      expect(match!.distance).toBeCloseTo(0.58, 4);
      expect(match!.ambiguousWith).toBeDefined();
      expect(match!.ambiguousWith!.entityId).toBe(grandma.id);
      // The runner-up never would have matched on her own — 0.62 > 0.6 — yet the
      // 0.04 separation still makes this an unsafe identification.
      expect(match!.ambiguousWith!.distance).toBeGreaterThan(0.6);
      expect(match!.runnerUpDistance).toBeCloseTo(0.62, 4);
    });

    it('leaves the flag off when the winner is clearly separated', async () => {
      const momFace = zeroVec();
      const uncleFace = atDistance(momFace, 0.9, /*offsetDim*/ 0);

      const mom = await createContact({
        studentId, name: 'Mom', relationship: 'mother',
      } as any);
      const uncle = await createContact({
        studentId, name: 'Uncle', relationship: 'other',
      } as any);
      await enrollContactFace(mom.id, momFace);
      await enrollContactFace(uncle.id, uncleFace);

      // 0.1 from Mom, ~0.905 from the uncle (orthogonal dims) — separation well
      // past the 0.08 margin.
      const probe = atDistance(momFace, 0.1, /*offsetDim*/ 32);

      const match = await findMatchingFace(probe, studentId);
      expect(match).not.toBeNull();
      expect(match!.entityId).toBe(mom.id);
      expect(match!.distance).toBeCloseTo(0.1, 4);
      expect(match!.ambiguousWith).toBeUndefined();
      expect(match!.runnerUpDistance).toBeUndefined();
    });

    it('never flags a tie when the student has only one enrolled person', async () => {
      const mom = await createContact({
        studentId, name: 'Mom', relationship: 'mother',
      } as any);
      await enrollContactFace(mom.id, makeEmbedding(7));

      const match = await findMatchingFace(makeEmbedding(7), studentId);
      expect(match!.entityId).toBe(mom.id);
      expect(match!.ambiguousWith).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Attribute veto
  // --------------------------------------------------------------------------
  // The 128-d embedding is age-blind: a child's probe lands inside 0.6 of her
  // grandmother's stored anchor and no margin tuning separates them, because in
  // that space they really are nearest neighbours. Coarse attributes are the
  // one thing that CAN separate them — a child is never a senior. They are used
  // as a NEGATIVE filter only: a vetoed person is excluded from the probe
  // entirely, so they can be neither the winner nor the ambiguous runner-up.

  describe('attribute veto', () => {
    /** Stamp coarse attributes onto a contact's biometric record. */
    async function setAttributes(
      contactId: string,
      attrs: { estimatedAge?: string; estimatedSex?: string },
    ): Promise<void> {
      await updateBiometricData(await bdIdForContact(contactId), attrs as any);
    }

    it('excludes a senior-attributed person from a child-aged probe, even at a matching distance', async () => {
      const grandmaFace = zeroVec();
      const grandma = await createContact({
        studentId, name: 'Grandma', relationship: 'grandparent',
      } as any);
      await enrollContactFace(grandma.id, grandmaFace);
      await setAttributes(grandma.id, { estimatedAge: 'senior', estimatedSex: 'female' });

      // 0.3 — comfortably INSIDE the 0.6 threshold. This is the exact failure
      // the veto exists for: the distance says "yes", biology says "no".
      const probe = atDistance(grandmaFace, 0.3, /*offsetDim*/ 0);

      // Without observed attributes, nothing changes — she matches as before.
      const unfiltered = await findMatchingFace(probe, studentId);
      expect(unfiltered).not.toBeNull();
      expect(unfiltered!.entityId).toBe(grandma.id);
      expect(unfiltered!.distance).toBeCloseTo(0.3, 4);

      // With a child-aged observation, she is removed from the pool outright —
      // and she was the only candidate, so there is no match at all.
      const vetoed = await findMatchingFace(probe, studentId, { age: 7 });
      expect(vetoed).toBeNull();
    });

    it('does NOT veto one band of difference — that is ordinary model error', async () => {
      const momFace = zeroVec();
      const mom = await createContact({
        studentId, name: 'Mom', relationship: 'mother',
      } as any);
      await enrollContactFace(mom.id, momFace);
      await setAttributes(mom.id, { estimatedAge: '30' }); // adult band

      const probe = atDistance(momFace, 0.2, /*offsetDim*/ 0);

      // Observed 12 = child, stored 30 = adult: ONE band apart. ageGenderNet
      // reads a 16-year-old as 12 all the time; vetoing here would erase real
      // people from their own recognition.
      const match = await findMatchingFace(probe, studentId, { age: 12 });
      expect(match).not.toBeNull();
      expect(match!.entityId).toBe(mom.id);

      // Same in the other direction: adult observed, senior on file.
      await setAttributes(mom.id, { estimatedAge: '60' });
      const other = await findMatchingFace(probe, studentId, { age: 50 });
      expect(other).not.toBeNull();
      expect(other!.entityId).toBe(mom.id);
    });

    it('does NOT veto when either side has no attributes on file', async () => {
      const auntFace = zeroVec();
      const aunt = await createContact({
        studentId, name: 'Aunt', relationship: 'other',
      } as any);
      await enrollContactFace(aunt.id, auntFace); // no estimated_age / estimated_sex
      const probe = atDistance(auntFace, 0.2, /*offsetDim*/ 0);

      // Observation present, nothing stored → no opinion, no veto.
      const noStored = await findMatchingFace(probe, studentId, { age: 6, sex: 'male', sexConfidence: 0.99 });
      expect(noStored).not.toBeNull();
      expect(noStored!.entityId).toBe(aunt.id);

      // Stored present, nothing observed → likewise.
      await setAttributes(aunt.id, { estimatedAge: 'senior', estimatedSex: 'female' });
      const noObserved = await findMatchingFace(probe, studentId, {});
      expect(noObserved).not.toBeNull();
      expect(noObserved!.entityId).toBe(aunt.id);

      // An unreadable stored value is the same as nothing at all.
      await setAttributes(aunt.id, { estimatedAge: 'לא ידוע', estimatedSex: 'none' });
      const unreadable = await findMatchingFace(probe, studentId, { age: 6, sex: 'male', sexConfidence: 0.99 });
      expect(unreadable).not.toBeNull();
      expect(unreadable!.entityId).toBe(aunt.id);
    });

    it('keeps a vetoed person out of the ambiguous runner-up slot too', async () => {
      // The doppelgänger case, but the runner-up is a senior and the probe is a
      // child: excluding her only from the WINNER slot would still hand the
      // caller "one of Sister / Grandma" and block the identification.
      const sisterFace = zeroVec();
      const grandmaFace = atDistance(sisterFace, 0.3, /*offsetDim*/ 0);

      const sister = await createContact({
        studentId, name: 'Sister', relationship: 'sibling',
      } as any);
      const grandma = await createContact({
        studentId, name: 'Grandma', relationship: 'grandparent',
      } as any);
      await enrollContactFace(sister.id, sisterFace);
      await enrollContactFace(grandma.id, grandmaFace);
      await setAttributes(sister.id, { estimatedAge: '9' });
      await setAttributes(grandma.id, { estimatedAge: 'senior' });

      // 0.14 from the sister, 0.16 from the grandmother — a 0.02 separation,
      // well inside the 0.08 ambiguity margin.
      const probe = atDistance(sisterFace, 0.14, 0);

      // Baseline: without attributes this IS a declared tie.
      const tied = await findMatchingFace(probe, studentId);
      expect(tied!.entityId).toBe(sister.id);
      expect(tied!.ambiguousWith).toBeDefined();
      expect(tied!.ambiguousWith!.entityId).toBe(grandma.id);

      // With a child-aged observation the grandmother leaves the pool entirely,
      // so the sister is named outright — no runner-up, no tie flag.
      const match = await findMatchingFace(probe, studentId, { age: 8 });
      expect(match).not.toBeNull();
      expect(match!.entityId).toBe(sister.id);
      expect(match!.distance).toBeCloseTo(0.14, 4);
      expect(match!.ambiguousWith).toBeUndefined();
      expect(match!.runnerUpDistance).toBeUndefined();
    });

    // ---- pure-function rules (no DB) ---------------------------------------

    it('parses free-text stored attributes into bands', () => {
      // Numbers, with or without trailing units.
      expect(parseEstimatedAge('8')).toBe(8);
      expect(parseEstimatedAge('8 years')).toBe(8);
      expect(parseEstimatedAge('~42')).toBe(42);
      // Words map to a representative age inside their band.
      expect(parseEstimatedAge('senior')).toBe(70);
      expect(parseEstimatedAge('elderly')).toBe(70);
      expect(parseEstimatedAge('child')).toBe(8);
      expect(parseEstimatedAge('adult')).toBe(35);
      // Unreadable → null (never a veto).
      expect(parseEstimatedAge('')).toBeNull();
      expect(parseEstimatedAge(null)).toBeNull();
      expect(parseEstimatedAge('unknown')).toBeNull();
      expect(parseEstimatedAge('מבוגר')).toBeNull();
      expect(parseEstimatedAge('999')).toBeNull(); // implausible, not clamped

      // Sex: only unambiguous tokens count, and "female" is never read as "male".
      expect(parseEstimatedSex('Female')).toBe('female');
      expect(parseEstimatedSex('woman')).toBe('female');
      expect(parseEstimatedSex('M')).toBe('male');
      expect(parseEstimatedSex('boy')).toBe('male');
      expect(parseEstimatedSex('none')).toBeNull();
      expect(parseEstimatedSex('נקבה')).toBeNull();
      expect(parseEstimatedSex(null)).toBeNull();
    });

    it('applies the age rule only at two bands of separation', () => {
      // "senior" parses to 70 (senior band); an 8-year-old probe is two bands
      // away → veto.
      expect(attributeVeto({ age: 8 }, { estimatedAge: 70 }).veto).toBe(true);
      expect(attributeVeto({ age: 8 }, { estimatedAge: 70 }).reason).toMatch(/child/);
      expect(attributeVeto({ age: 8 }, { estimatedAge: 70 }).reason).toMatch(/senior/);
      // "8" is the child band; a senior probe against it vetoes symmetrically.
      expect(attributeVeto({ age: 72 }, { estimatedAge: parseEstimatedAge('8') }).veto).toBe(true);
      // One band apart, both directions → never.
      expect(attributeVeto({ age: 12 }, { estimatedAge: 35 }).veto).toBe(false);
      expect(attributeVeto({ age: 35 }, { estimatedAge: 70 }).veto).toBe(false);
      // Band edges: 13 is a child, 14 is an adult, 55 is an adult, 56 a senior.
      expect(attributeVeto({ age: 13 }, { estimatedAge: 56 }).veto).toBe(true);
      expect(attributeVeto({ age: 14 }, { estimatedAge: 56 }).veto).toBe(false);
      expect(attributeVeto({ age: 13 }, { estimatedAge: 55 }).veto).toBe(false);
      // Missing on either side → no opinion.
      expect(attributeVeto({}, { estimatedAge: 70 }).veto).toBe(false);
      expect(attributeVeto({ age: 8 }, { estimatedAge: null }).veto).toBe(false);
      // Raw stored text is re-parsed defensively.
      expect(attributeVeto({ age: 8 }, { estimatedAge: 'senior' as any }).veto).toBe(true);
    });

    it('applies the sex rule only when confident AND the face is adult-aged', () => {
      const conflicting = { estimatedSex: 'female' };
      // All guards satisfied → veto.
      expect(attributeVeto({ age: 30, sex: 'male', sexConfidence: 0.95 }, conflicting).veto).toBe(true);
      expect(attributeVeto({ age: 30, sex: 'male', sexConfidence: 0.95 }, conflicting).reason).toMatch(/sex/);
      // Not confident enough → never.
      expect(attributeVeto({ age: 30, sex: 'male', sexConfidence: 0.7 }, conflicting).veto).toBe(false);
      expect(attributeVeto({ age: 30, sex: 'male' }, conflicting).veto).toBe(false);
      // A child's face → never, however confident. The gender head is unreliable
      // on children, and this is exactly the population we serve.
      expect(attributeVeto({ age: 9, sex: 'male', sexConfidence: 0.99 }, conflicting).veto).toBe(false);
      // Age unknown → also never (an unknown age might BE a child).
      expect(attributeVeto({ sex: 'male', sexConfidence: 0.99 }, conflicting).veto).toBe(false);
      // Agreement, or an unreadable stored value → never.
      expect(attributeVeto({ age: 30, sex: 'female', sexConfidence: 0.99 }, conflicting).veto).toBe(false);
      expect(attributeVeto({ age: 30, sex: 'male', sexConfidence: 0.99 }, { estimatedSex: 'none' }).veto).toBe(false);
      expect(attributeVeto({ age: 30, sex: 'male', sexConfidence: 0.99 }, { estimatedSex: null }).veto).toBe(false);
    });
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
