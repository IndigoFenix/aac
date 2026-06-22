/**
 * Voice recognition pipeline tests.
 *
 * The voice gallery mirrors the face gallery but in COSINE-SIMILARITY space
 * (higher = closer) and with one crucial difference: there is usually no
 * enrolled anchor (voice enrollment is rare), so the first good-quality sample
 * SEEDS the gallery and becomes the de-facto anchor. These tests cover seeding,
 * best-similarity matching across the gallery, the weight floor, novelty/quality
 * gating on growth, and correction (penalize → evict).
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { truncateAll } from '../helpers/db.js';
import { makeUser, makeStudent } from '../helpers/factories.js';
import {
  createContact,
  findMatchingVoice,
  growVoiceGalleryForEntity,
  penalizeVoiceMatch,
  getKnownPeopleForStudent,
  updateBiometricData,
  ensureBiometricData,
  type VoiceGalleryEntry,
} from '../../services/biometric/recognition-service.js';

const VOICE_DIM = 64;
const BASE_DIMS = 8; // base voice direction occupies dims [0, BASE_DIMS)

/** Unit vector along the shared "base voice" direction (dims [0, BASE_DIMS)). */
function baseVoice(): number[] {
  const v = new Array(VOICE_DIM).fill(0);
  for (let i = 0; i < BASE_DIMS; i++) v[i] = 1 / Math.sqrt(BASE_DIMS);
  return v;
}

/** Unit vector orthogonal to the base, along dims [offset, offset+BASE_DIMS). */
function orthVoice(offset: number): number[] {
  const v = new Array(VOICE_DIM).fill(0);
  for (let i = 0; i < BASE_DIMS; i++) v[offset + i] = 1 / Math.sqrt(BASE_DIMS);
  return v;
}

/**
 * A UNIT vector whose cosine similarity to `baseVoice()` is exactly `sim`,
 * built by mixing the base direction with an orthogonal direction at `offset`.
 * Two such vectors built on DISJOINT offsets have predictable mutual similarity
 * (just the product of their base components), which lets the tests assert
 * which stored sample a probe is closest to.
 */
function voiceAtSim(sim: number, offset: number): number[] {
  const b = baseVoice();
  const o = orthVoice(offset);
  const perp = Math.sqrt(Math.max(0, 1 - sim * sim));
  return b.map((bi, i) => sim * bi + perp * o[i]);
}

/** Ensure a contact has a biometric_data row (createContact doesn't make one)
 *  and return its id, so a test can seed the anchor / gallery directly. */
async function bdIdForContact(contactId: string): Promise<string> {
  return ensureBiometricData({ type: 'contact', id: contactId });
}

describe('Voice recognition pipeline', () => {
  afterEach(truncateAll);

  let userId: string;
  let studentId: string;

  beforeEach(async () => {
    const user = await makeUser();
    const { student } = await makeStudent(user.id);
    userId = user.id;
    studentId = student.id;
  });

  it('seeds the voice gallery from the first sample when there is no anchor', async () => {
    // The common case: a contact has no enrolled voice at all. The first
    // good-quality attributed sample must SEED the gallery (faces never do this
    // — they always start from an enrolled anchor).
    const contact = await createContact({
      studentId, name: 'Mom', relationship: 'mother',
    } as any);
    const target = { type: 'contact' as const, id: contact.id };

    const sample = voiceAtSim(1, 16); // any clear sample
    const grow = await growVoiceGalleryForEntity(target, sample, 0.9);
    expect(grow.reason).toBe('seeded');
    expect(grow.size).toBe(1);

    // It now matches that same voice, backed by exactly one sample.
    const match = await findMatchingVoice(sample, studentId);
    expect(match).not.toBeNull();
    expect(match!.entityId).toBe(contact.id);
    expect(match!.sampleCount).toBe(1);
  });

  it('does not seed from a low-quality first sample', async () => {
    const contact = await createContact({
      studentId, name: 'Mom', relationship: 'mother',
    } as any);
    const target = { type: 'contact' as const, id: contact.id };

    const grow = await growVoiceGalleryForEntity(target, voiceAtSim(1, 16), 0.1);
    expect(grow.reason).toBe('low-quality');
    expect(grow.size).toBe(0);
  });

  it('matches a sample far from the anchor via a gallery sample', async () => {
    // Anchor is the base voice. A gallery sample sits at 0.5 similarity to it
    // (e.g. captured over a phone) — beyond the 0.75 threshold from the anchor,
    // so the anchor ALONE would reject a probe near it.
    const contact = await createContact({
      studentId, name: 'Dad', relationship: 'father',
    } as any);
    const bdId = await bdIdForContact(contact.id);
    await updateBiometricData(bdId, { voiceEmbedding: baseVoice() });

    const phonePose = voiceAtSim(0.5, 16);

    // Anchor only → a probe near the phone pose is rejected (0.5 < 0.75).
    const anchorOnly = await findMatchingVoice(phonePose, studentId);
    expect(anchorOnly).toBeNull();

    // Add the phone pose to the gallery → now it matches via best-similarity.
    const gallery: VoiceGalleryEntry[] = [
      { embedding: phonePose, quality: 0.9, capturedAt: new Date().toISOString(), weight: 1 },
    ];
    await updateBiometricData(bdId, { voiceEmbeddings: gallery });

    const match = await findMatchingVoice(phonePose, studentId);
    expect(match).not.toBeNull();
    expect(match!.entityId).toBe(contact.id);
    expect(match!.similarity).toBeGreaterThan(0.99);
    expect(match!.sampleCount).toBe(2); // anchor + 1 gallery sample
  });

  it('ignores a gallery sample whose weight has fallen below the floor', async () => {
    const contact = await createContact({
      studentId, name: 'Dad', relationship: 'father',
    } as any);
    const bdId = await bdIdForContact(contact.id);
    await updateBiometricData(bdId, { voiceEmbedding: baseVoice() });

    const phonePose = voiceAtSim(0.5, 16);
    await updateBiometricData(bdId, {
      voiceEmbeddings: [{ embedding: phonePose, quality: 0.9, capturedAt: new Date().toISOString(), weight: 0.2 }],
    });

    // Probe near the dead sample, far from the anchor → no match.
    const match = await findMatchingVoice(phonePose, studentId);
    expect(match).toBeNull();
  });

  it('grows the gallery only for good-quality, genuinely-novel samples', async () => {
    const contact = await createContact({
      studentId, name: 'Mom', relationship: 'mother',
    } as any);
    const bdId = await bdIdForContact(contact.id);
    await updateBiometricData(bdId, { voiceEmbedding: baseVoice() });
    const target = { type: 'contact' as const, id: contact.id };

    // Inside the [0.8, 0.92] novelty band → added.
    expect((await growVoiceGalleryForEntity(target, voiceAtSim(0.85, 16), 0.9)).reason).toBe('added');

    // Near-duplicate of the anchor (0.95 ≥ 0.92) → redundant.
    expect((await growVoiceGalleryForEntity(target, voiceAtSim(0.95, 16), 0.9)).reason).toBe('redundant');

    // Too dissimilar (0.6 < 0.8, disjoint dims so also far from the added sample)
    // → too risky to trust as the same speaker.
    expect((await growVoiceGalleryForEntity(target, voiceAtSim(0.6, 24), 0.9)).reason).toBe('too-far');

    // Novel similarity but poor quality → rejected by the quality gate.
    expect((await growVoiceGalleryForEntity(target, voiceAtSim(0.85, 32), 0.1)).reason).toBe('low-quality');

    const known = await getKnownPeopleForStudent(studentId);
    expect(known.find(p => p.id === contact.id)!.voiceGallery).toHaveLength(1);
  });

  it('penalizes and eventually evicts the sample behind a misidentification', async () => {
    const contact = await createContact({
      studentId, name: 'Mom', relationship: 'mother',
    } as any);
    const bdId = await bdIdForContact(contact.id);
    // Anchor dissimilar to the bad sample so the penalty targets the gallery.
    await updateBiometricData(bdId, { voiceEmbedding: baseVoice() });

    const badSample = voiceAtSim(0.5, 16);
    await updateBiometricData(bdId, {
      voiceEmbeddings: [{ embedding: badSample, quality: 0.9, capturedAt: new Date().toISOString(), weight: 1 }],
    });
    const target = { type: 'contact' as const, id: contact.id };

    const first = await penalizeVoiceMatch(target, badSample);
    expect(first.penalized).toBe('gallery');
    expect(first.evicted).toBe(false); // weight 1 → 0.5

    const second = await penalizeVoiceMatch(target, badSample);
    expect(second.penalized).toBe('gallery');
    expect(second.evicted).toBe(true); // weight 0.5 → 0.25 ≤ floor → removed
    expect(second.size).toBe(0);

    const known = await getKnownPeopleForStudent(studentId);
    expect(known.find(p => p.id === contact.id)!.voiceGallery).toHaveLength(0);
  });

  it('seeds a user voice gallery on demand when no biometric record exists', async () => {
    // A fresh user may have no biometric_data row at all. Seeding must CREATE
    // the record on demand — voice has no enrollment step to create it first.
    const target = { type: 'user' as const, id: userId };
    const grow = await growVoiceGalleryForEntity(target, voiceAtSim(1, 16), 0.8);
    expect(grow.reason).toBe('seeded');
    expect(grow.size).toBe(1);
  });
});
