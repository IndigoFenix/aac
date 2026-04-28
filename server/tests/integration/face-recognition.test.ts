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
import { makeUser, makeStudent } from '../helpers/factories.js';
import {
  createContact,
  enrollContactFace,
  findMatchingFace,
  recordContactSighting,
  getKnownPeopleForStudent,
} from '../../services/biometric/recognition-service.js';
import { studentContacts } from '@shared/schema';
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
