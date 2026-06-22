// server/services/biometric/recognition-service.ts
// Biometric recognition service — face, voice, contacts, known people.
//
// All face/voice embeddings live on the shared `biometric_data` table.
// users / students / studentContacts each carry a `biometricDataId` FK pointing
// to their row. When a studentContacts row is linked to a user or student, its
// biometricDataId is write-through-synced at creation time so one real person
// has one biometric record regardless of how many relationships they appear in.

import { db } from "../../db";
import {
  users,
  students,
  userStudents,
  studentContacts,
  biometricData,
  instituteStudents,
  instituteUsers,
  type BiometricData,
  type StudentContact,
  type InsertStudentContact,
  type UpdateStudentContact,
  type InsertBiometricData,
  type UpdateBiometricData,
} from "@shared/schema";
import { eq, and, isNotNull, sql, inArray, ne } from "drizzle-orm";

// ============================================================================
// Types
// ============================================================================

export type FaceEmbedding = number[];
export type VoiceEmbedding = number[];

export type EntityType = "user" | "student" | "contact";

/**
 * One captured face angle in a person's multi-angle gallery. The gallery
 * complements the single `faceEmbedding` anchor so a person is recognised
 * across pose/lighting/expression rather than only the enrolled frame.
 * `weight` starts at 1 and is reduced by corrections (misidentifications);
 * an entry whose weight falls to/under the floor is ignored when matching and
 * eventually evicted.
 */
export interface FaceGalleryEntry {
  embedding: number[];
  quality: number; // 0..1 frontality/size/detection score at capture time
  capturedAt: string; // ISO timestamp
  weight: number; // 1 = trusted; reduced on correction; evicted at/under floor
}

/**
 * One captured speech sample in a person's multi-sample voice gallery. Same
 * shape and lifecycle as FaceGalleryEntry, but the embedding is a speaker
 * (voice) vector and proximity is measured by cosine similarity (higher =
 * closer) rather than euclidean distance. Unlike faces, the gallery usually
 * seeds ITSELF — voice enrollment is rarely present, so the first attributed
 * speech sample becomes the de-facto anchor.
 */
export interface VoiceGalleryEntry {
  embedding: number[];
  quality: number; // 0..1 clarity/length/SNR score at capture time
  capturedAt: string; // ISO timestamp
  weight: number; // 1 = trusted; reduced on correction; evicted at/under floor
  /** Median fundamental frequency (Hz) of the sample, when measurable. Powers
   *  the FAST (pre-embedding) pitch read — cheap acoustic data the client sends
   *  immediately. Optional: unvoiced/whispered samples have none. */
  pitch?: number;
  /** Median formant dispersion (Hz) of the sample — vocal-tract-length cue. Stored
   *  alongside pitch; the fast read matches on BOTH (dispersion is more
   *  speaker-discriminative). Optional: noisy clips have none. */
  dispersion?: number;
}

export interface FaceMatchResult {
  matched: boolean;
  entityType: EntityType;
  entityId: string;
  name: string;
  distance: number;
  confidence: number;
  /** How many reference faces backed this match (enrolled anchor + above-floor
   *  gallery poses). A low score off ONE sample is weak-but-expected; the same
   *  score off many samples is far more meaningful. Lets callers express the
   *  CERTAINTY of the judgement, not just the raw score. */
  sampleCount: number;
  description?: string;
  contextNotes?: string;
  relationship?: string;
}

export interface VoiceMatchResult {
  matched: boolean;
  entityType: EntityType;
  entityId: string;
  name: string;
  similarity: number;
  confidence: number;
  /** How many reference voice samples backed this match (enrolled anchor +
   *  above-floor gallery samples). Mirrors FaceMatchResult.sampleCount: a weak
   *  score off ONE sample is weak-but-expected; the same score off many samples
   *  is far more meaningful. Voice galleries are usually small and self-seeded,
   *  so this matters even more than for faces. */
  sampleCount: number;
  description?: string;
  contextNotes?: string;
  relationship?: string;
}

export interface KnownPerson {
  id: string;
  type: EntityType;
  name: string;
  relationship?: string;
  faceEmbedding: number[] | null;
  /** Multi-angle gallery (additional poses); null/empty = anchor only. */
  faceGallery: FaceGalleryEntry[] | null;
  voiceEmbedding: number[] | null;
  /** Multi-sample voice gallery (additional speech samples); null/empty =
   *  anchor only, or — far more commonly for voice — no data yet. */
  voiceGallery: VoiceGalleryEntry[] | null;
  description?: string;
  contextNotes?: string;
}

// ============================================================================
// Thresholds
// ============================================================================

const FACE_MATCH_THRESHOLD = 0.6;
const VOICE_MATCH_THRESHOLD = 0.75;

// ---- Multi-angle gallery tuning -------------------------------------------
/** Max gallery entries kept per person (anchor is separate, always kept). */
const FACE_GALLERY_MAX = 10;
/** Entries with weight at/under this are ignored when matching and evicted. */
const FACE_GALLERY_WEIGHT_FLOOR = 0.25;
/** Each correction multiplies the offending entry's weight by this. */
const FACE_PENALTY_FACTOR = 0.5;
/**
 * A candidate frame is only worth adding as a NEW pose when its distance to the
 * existing anchor+gallery sits in this band: far enough to add information
 * (below MIN it's redundant with a pose we already have), but comfortably under
 * the match threshold (above MAX it's too close to a stranger to trust as the
 * same person and could poison the gallery).
 */
const FACE_GALLERY_NOVELTY_MIN = 0.32;
const FACE_GALLERY_NOVELTY_MAX = 0.5;
/** Only frames at/above this quality are enrolled into the gallery. */
const FACE_GALLERY_QUALITY_MIN = 0.35;

// ---- Multi-sample voice gallery tuning ------------------------------------
// Mirrors the face gallery but in COSINE-SIMILARITY space (higher = closer),
// so the novelty band is inverted: a new sample is worth keeping when it is
// clearly the same person (similarity comfortably above the match threshold)
// yet not a near-duplicate of a sample we already hold.
/** Max gallery samples kept per person (anchor is separate, always kept). */
const VOICE_GALLERY_MAX = 10;
/** Samples with weight at/under this are ignored when matching and evicted. */
const VOICE_GALLERY_WEIGHT_FLOOR = 0.25;
/** Each correction multiplies the offending sample's weight by this. */
const VOICE_PENALTY_FACTOR = 0.5;
/**
 * A candidate sample is only worth adding when its best similarity to the
 * existing anchor+gallery sits in this band: similar enough to trust it's the
 * same speaker (above MIN — comfortably over VOICE_MATCH_THRESHOLD so we don't
 * poison the gallery with a near-stranger), but not so similar it adds nothing
 * (above MAX it's a near-duplicate of a sample we already have).
 */
const VOICE_GALLERY_NOVELTY_MIN_SIM = 0.8;
const VOICE_GALLERY_NOVELTY_MAX_SIM = 0.92;
/** Only samples at/above this quality are enrolled into the gallery. */
const VOICE_GALLERY_QUALITY_MIN = 0.35;

// ============================================================================
// Embedding math
// ============================================================================

function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimensions don't match: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.pow(a[i] - b[i], 2);
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimensions don't match: ${a.length} vs ${b.length}`);
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;
  return dotProduct / magnitude;
}

/**
 * Smallest distance between a probe embedding and a person's known faces — the
 * enrolled `anchor` plus every above-floor gallery entry. This is what lets a
 * side/under-lit frame still match a person enrolled only frontally: it just
 * has to be close to ONE stored pose. Gallery entries below the weight floor
 * (corrected as bad) are skipped. Returns Infinity if the person has no usable
 * face data.
 */
function bestFaceDistance(
  probe: number[],
  anchor: number[] | null,
  gallery: FaceGalleryEntry[] | null,
): number {
  let best = Infinity;
  if (anchor && anchor.length === probe.length) {
    best = euclideanDistance(probe, anchor);
  }
  if (gallery) {
    for (const g of gallery) {
      if (!g?.embedding || g.embedding.length !== probe.length) continue;
      if ((g.weight ?? 1) <= FACE_GALLERY_WEIGHT_FLOOR) continue;
      const d = euclideanDistance(probe, g.embedding);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Count the reference faces actually usable for matching a person — the
 *  enrolled anchor (if any) plus every above-floor gallery pose. Drives the
 *  CERTAINTY of a match: more samples → a given score is more trustworthy. */
function usableSampleCount(anchor: number[] | null, gallery: FaceGalleryEntry[] | null): number {
  let n = anchor && anchor.length ? 1 : 0;
  if (gallery) for (const g of gallery) {
    if (g?.embedding?.length && (g.weight ?? 1) > FACE_GALLERY_WEIGHT_FLOOR) n++;
  }
  return n;
}

/** Coerce a stored jsonb value into a clean FaceGalleryEntry[] (defensive). */
function normalizeGallery(raw: unknown): FaceGalleryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FaceGalleryEntry[] = [];
  for (const e of raw) {
    if (!e || !Array.isArray((e as any).embedding)) continue;
    out.push({
      embedding: (e as any).embedding as number[],
      quality: typeof (e as any).quality === "number" ? (e as any).quality : 0,
      capturedAt: typeof (e as any).capturedAt === "string" ? (e as any).capturedAt : new Date().toISOString(),
      weight: typeof (e as any).weight === "number" ? (e as any).weight : 1,
    });
  }
  return out;
}

/**
 * Greatest cosine similarity between a probe voice embedding and a person's
 * known voices — the enrolled `anchor` plus every above-floor gallery sample.
 * This is the voice analog of bestFaceDistance: a sample captured in a
 * different mood / loudness still matches if it's close to ONE stored sample.
 * Samples below the weight floor (corrected as bad) are skipped. Returns
 * -Infinity if the person has no usable voice data.
 */
function bestVoiceSimilarity(
  probe: number[],
  anchor: number[] | null,
  gallery: VoiceGalleryEntry[] | null,
): number {
  let best = -Infinity;
  if (anchor && anchor.length === probe.length) {
    best = cosineSimilarity(probe, anchor);
  }
  if (gallery) {
    for (const g of gallery) {
      if (!g?.embedding || g.embedding.length !== probe.length) continue;
      if ((g.weight ?? 1) <= VOICE_GALLERY_WEIGHT_FLOOR) continue;
      const s = cosineSimilarity(probe, g.embedding);
      if (s > best) best = s;
    }
  }
  return best;
}

/** Count the reference voice samples actually usable for matching a person —
 *  the enrolled anchor (if any) plus every above-floor gallery sample. Drives
 *  the CERTAINTY of a voice match (voice galleries are small, so this matters). */
function usableVoiceSampleCount(anchor: number[] | null, gallery: VoiceGalleryEntry[] | null): number {
  let n = anchor && anchor.length ? 1 : 0;
  if (gallery) for (const g of gallery) {
    if (g?.embedding?.length && (g.weight ?? 1) > VOICE_GALLERY_WEIGHT_FLOOR) n++;
  }
  return n;
}

/** Coerce a stored jsonb value into a clean VoiceGalleryEntry[] (defensive). */
function normalizeVoiceGallery(raw: unknown): VoiceGalleryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: VoiceGalleryEntry[] = [];
  for (const e of raw) {
    if (!e || !Array.isArray((e as any).embedding)) continue;
    out.push({
      embedding: (e as any).embedding as number[],
      quality: typeof (e as any).quality === "number" ? (e as any).quality : 0,
      capturedAt: typeof (e as any).capturedAt === "string" ? (e as any).capturedAt : new Date().toISOString(),
      weight: typeof (e as any).weight === "number" ? (e as any).weight : 1,
    });
  }
  return out;
}

// ============================================================================
// biometricData CRUD
// ============================================================================

export async function createBiometricData(data: InsertBiometricData = {}): Promise<BiometricData> {
  const [row] = await db.insert(biometricData).values(data).returning();
  return row;
}

export async function getBiometricData(id: string): Promise<BiometricData | undefined> {
  const [row] = await db.select().from(biometricData).where(eq(biometricData.id, id));
  return row;
}

export async function updateBiometricData(
  id: string,
  data: UpdateBiometricData,
): Promise<BiometricData | undefined> {
  const [row] = await db
    .update(biometricData)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(biometricData.id, id))
    .returning();
  return row;
}

export async function deleteBiometricData(id: string): Promise<void> {
  await db.delete(biometricData).where(eq(biometricData.id, id));
}

/**
 * The entities (users and students) that reference a given biometric_data row,
 * for authorizing direct biometric-data access by id. A contact resolves to the
 * student it belongs to (access is granted through that student). Returns the
 * distinct user ids and student ids that "own" this record.
 */
export async function getEntitiesForBiometricData(
  id: string,
): Promise<{ userIds: string[]; studentIds: string[] }> {
  const [userRows, studentRows, contactRows] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.biometricDataId, id)),
    db.select({ id: students.id }).from(students).where(eq(students.biometricDataId, id)),
    db
      .select({ studentId: studentContacts.studentId })
      .from(studentContacts)
      .where(eq(studentContacts.biometricDataId, id)),
  ]);
  const studentIds = new Set<string>(studentRows.map((r) => r.id));
  for (const c of contactRows) if (c.studentId) studentIds.add(c.studentId);
  return {
    userIds: userRows.map((r) => r.id),
    studentIds: Array.from(studentIds),
  };
}

/**
 * Ensure a target entity (user/student/contact) has a biometric_data row and
 * return its id. If none exists, creates an empty one and sets the FK.
 *
 * For contacts: if the contact is linked to a user/student, delegates to that
 * canonical record's biometric_data — never creates a fresh row for the link.
 */
export async function ensureBiometricData(
  target: { type: EntityType; id: string },
): Promise<string> {
  if (target.type === "user") {
    const [u] = await db
      .select({ biometricDataId: users.biometricDataId })
      .from(users)
      .where(eq(users.id, target.id));
    if (u?.biometricDataId) return u.biometricDataId;
    const row = await createBiometricData();
    await db.update(users).set({ biometricDataId: row.id }).where(eq(users.id, target.id));
    return row.id;
  }
  if (target.type === "student") {
    const [s] = await db
      .select({ biometricDataId: students.biometricDataId })
      .from(students)
      .where(eq(students.id, target.id));
    if (s?.biometricDataId) return s.biometricDataId;
    const row = await createBiometricData();
    await db.update(students).set({ biometricDataId: row.id }).where(eq(students.id, target.id));
    return row.id;
  }
  // contact
  const [c] = await db
    .select({
      biometricDataId: studentContacts.biometricDataId,
      linkedUserId: studentContacts.linkedUserId,
      linkedStudentId: studentContacts.linkedStudentId,
    })
    .from(studentContacts)
    .where(eq(studentContacts.id, target.id));
  if (!c) throw new Error(`Contact ${target.id} not found`);

  // If linked, sync to the canonical record's biometric_data
  if (c.linkedUserId) {
    const bdId = await ensureBiometricData({ type: "user", id: c.linkedUserId });
    if (c.biometricDataId !== bdId) {
      await db
        .update(studentContacts)
        .set({ biometricDataId: bdId })
        .where(eq(studentContacts.id, target.id));
    }
    return bdId;
  }
  if (c.linkedStudentId) {
    const bdId = await ensureBiometricData({ type: "student", id: c.linkedStudentId });
    if (c.biometricDataId !== bdId) {
      await db
        .update(studentContacts)
        .set({ biometricDataId: bdId })
        .where(eq(studentContacts.id, target.id));
    }
    return bdId;
  }
  // Unlinked — own biometric row
  if (c.biometricDataId) return c.biometricDataId;
  const row = await createBiometricData();
  await db
    .update(studentContacts)
    .set({ biometricDataId: row.id })
    .where(eq(studentContacts.id, target.id));
  return row.id;
}

// ============================================================================
// Face / voice embedding helpers
// ============================================================================

async function getBiometricDataIdFor(target: { type: EntityType; id: string }): Promise<string | null> {
  if (target.type === "user") {
    const [u] = await db.select({ bd: users.biometricDataId }).from(users).where(eq(users.id, target.id));
    return u?.bd ?? null;
  }
  if (target.type === "student") {
    const [s] = await db.select({ bd: students.biometricDataId }).from(students).where(eq(students.id, target.id));
    return s?.bd ?? null;
  }
  const [c] = await db
    .select({ bd: studentContacts.biometricDataId })
    .from(studentContacts)
    .where(eq(studentContacts.id, target.id));
  return c?.bd ?? null;
}

export async function storeFaceEmbeddingForUser(userId: string, embedding: FaceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "user", id: userId });
  await updateBiometricData(bdId, { faceEmbedding: embedding });
}

export async function storeFaceEmbeddingForStudent(studentId: string, embedding: FaceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "student", id: studentId });
  await updateBiometricData(bdId, { faceEmbedding: embedding });
}

export async function storeFaceEmbeddingForContact(contactId: string, embedding: FaceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "contact", id: contactId });
  await updateBiometricData(bdId, { faceEmbedding: embedding });
}

export async function getFaceEmbeddingForUser(userId: string): Promise<FaceEmbedding | null> {
  const bdId = await getBiometricDataIdFor({ type: "user", id: userId });
  if (!bdId) return null;
  const row = await getBiometricData(bdId);
  return (row?.faceEmbedding as FaceEmbedding) ?? null;
}

export async function getFaceEmbeddingForStudent(studentId: string): Promise<FaceEmbedding | null> {
  const bdId = await getBiometricDataIdFor({ type: "student", id: studentId });
  if (!bdId) return null;
  const row = await getBiometricData(bdId);
  return (row?.faceEmbedding as FaceEmbedding) ?? null;
}

export async function removeFaceEmbeddingForUser(userId: string): Promise<void> {
  const bdId = await getBiometricDataIdFor({ type: "user", id: userId });
  if (bdId) await updateBiometricData(bdId, { faceEmbedding: null });
}

export async function removeFaceEmbeddingForStudent(studentId: string): Promise<void> {
  const bdId = await getBiometricDataIdFor({ type: "student", id: studentId });
  if (bdId) await updateBiometricData(bdId, { faceEmbedding: null });
}

export async function storeVoiceEmbeddingForUser(userId: string, embedding: VoiceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "user", id: userId });
  await updateBiometricData(bdId, { voiceEmbedding: embedding });
}

export async function storeVoiceEmbeddingForStudent(studentId: string, embedding: VoiceEmbedding): Promise<void> {
  const bdId = await ensureBiometricData({ type: "student", id: studentId });
  await updateBiometricData(bdId, { voiceEmbedding: embedding });
}

export async function getVoiceEmbeddingForUser(userId: string): Promise<VoiceEmbedding | null> {
  const bdId = await getBiometricDataIdFor({ type: "user", id: userId });
  if (!bdId) return null;
  const row = await getBiometricData(bdId);
  return (row?.voiceEmbedding as VoiceEmbedding) ?? null;
}

export async function getVoiceEmbeddingForStudent(studentId: string): Promise<VoiceEmbedding | null> {
  const bdId = await getBiometricDataIdFor({ type: "student", id: studentId });
  if (!bdId) return null;
  const row = await getBiometricData(bdId);
  return (row?.voiceEmbedding as VoiceEmbedding) ?? null;
}

export async function removeVoiceEmbeddingForUser(userId: string): Promise<void> {
  const bdId = await getBiometricDataIdFor({ type: "user", id: userId });
  if (bdId) await updateBiometricData(bdId, { voiceEmbedding: null });
}

export async function removeVoiceEmbeddingForStudent(studentId: string): Promise<void> {
  const bdId = await getBiometricDataIdFor({ type: "student", id: studentId });
  if (bdId) await updateBiometricData(bdId, { voiceEmbedding: null });
}

// ============================================================================
// Face matching — dedupe by biometricDataId so linked records match once
// ============================================================================

export async function findMatchingFace(
  embedding: FaceEmbedding,
  studentId: string,
): Promise<FaceMatchResult | null> {
  // SECURITY: matching is scoped strictly to THIS student's known people
  // (the student, users linked via userStudents, and the student's active
  // contacts) — never the entire enrolled population. A global 1:N scan across
  // every institute would be a cross-tenant biometric identification leak.
  if (!studentId) return null;

  let bestMatch: FaceMatchResult | null = null;
  let bestDistance = FACE_MATCH_THRESHOLD;

  // getKnownPeopleForStudent already dedupes by biometricDataId, so a person
  // linked through multiple records is only evaluated once.
  const people = await getKnownPeopleForStudent(studentId);

  for (const p of people) {
    if (!p.faceEmbedding && !(p.faceGallery && p.faceGallery.length)) continue;
    // Min distance across the enrolled anchor AND every above-floor gallery pose.
    const distance = bestFaceDistance(embedding, p.faceEmbedding as number[] | null, p.faceGallery);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = {
        matched: true,
        entityType: p.type,
        entityId: p.id,
        name: p.name,
        distance,
        confidence: Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD),
        sampleCount: usableSampleCount(p.faceEmbedding as number[] | null, p.faceGallery),
        description: p.description,
        contextNotes: p.contextNotes,
        relationship: p.relationship,
      };
    }
  }

  return bestMatch;
}

// ============================================================================
// Gallery growth (positive feedback) + correction (negative feedback)
// ============================================================================

export interface GalleryGrowthResult {
  added: boolean;
  reason: "added" | "redundant" | "too-far" | "low-quality" | "no-record";
  size: number;
}

/**
 * Consider adding a freshly-seen face frame to a person's multi-angle gallery.
 * Only confident, good-quality, genuinely-novel poses are kept — see the
 * NOVELTY/QUALITY constants. Caps the gallery and evicts the weakest entry
 * (lowest weight, then lowest quality) when full. The enrolled `faceEmbedding`
 * anchor is never touched. Idempotent-ish: a redundant pose is a no-op.
 *
 * `target` is the matched entity ({ type, id }) — for contacts this resolves to
 * the shared (possibly linked) biometric record, so growth benefits every
 * relationship that real person appears in.
 */
export async function growFaceGalleryForEntity(
  target: { type: EntityType; id: string },
  embedding: FaceEmbedding,
  quality: number,
): Promise<GalleryGrowthResult> {
  const bdId = await getBiometricDataIdFor(target);
  if (!bdId) return { added: false, reason: "no-record", size: 0 };

  const row = await getBiometricData(bdId);
  if (!row) return { added: false, reason: "no-record", size: 0 };

  const gallery = normalizeGallery(row.faceEmbeddings);

  if (quality < FACE_GALLERY_QUALITY_MIN) {
    return { added: false, reason: "low-quality", size: gallery.length };
  }

  // Distance to everything we already know about this person (anchor + gallery).
  const dist = bestFaceDistance(embedding, row.faceEmbedding as number[] | null, gallery);

  // Below MIN: we already have a near-identical pose — adds no information.
  if (dist < FACE_GALLERY_NOVELTY_MIN) {
    return { added: false, reason: "redundant", size: gallery.length };
  }
  // Above MAX: too far to trust as the same person — refuse, don't poison.
  if (dist > FACE_GALLERY_NOVELTY_MAX) {
    return { added: false, reason: "too-far", size: gallery.length };
  }

  gallery.push({
    embedding,
    quality,
    capturedAt: new Date().toISOString(),
    weight: 1,
  });

  // Cap: drop the weakest entry (lowest weight, tie-broken by lowest quality).
  if (gallery.length > FACE_GALLERY_MAX) {
    let worst = 0;
    for (let i = 1; i < gallery.length; i++) {
      const a = gallery[i];
      const b = gallery[worst];
      if (a.weight < b.weight || (a.weight === b.weight && a.quality < b.quality)) {
        worst = i;
      }
    }
    gallery.splice(worst, 1);
  }

  await updateBiometricData(bdId, { faceEmbeddings: gallery });
  console.log(
    `[Recognition] Grew face gallery for ${target.type}:${target.id} ` +
      `(d=${dist.toFixed(3)}, q=${quality.toFixed(2)}, size=${gallery.length})`,
  );
  return { added: true, reason: "added", size: gallery.length };
}

export interface GalleryPenaltyResult {
  penalized: "gallery" | "anchor" | "none";
  evicted: boolean;
  size: number;
}

/**
 * Negative feedback for a misidentification. Given the descriptor that was
 * WRONGLY matched to this person, find the stored face (anchor or gallery entry)
 * that produced the bad match and reduce its trust. Gallery entries lose weight
 * and are evicted once they fall to/under the floor; the enrolled anchor is
 * never deleted (it's the curated photo) but the mismatch is logged so a human
 * can re-enroll it. Repeated corrections steadily purge the bad pose that keeps
 * causing the confusion.
 */
export async function penalizeFaceMatch(
  target: { type: EntityType; id: string },
  wrongDescriptor: FaceEmbedding,
): Promise<GalleryPenaltyResult> {
  const bdId = await getBiometricDataIdFor(target);
  if (!bdId) return { penalized: "none", evicted: false, size: 0 };

  const row = await getBiometricData(bdId);
  if (!row) return { penalized: "none", evicted: false, size: 0 };

  const gallery = normalizeGallery(row.faceEmbeddings);
  const anchor = row.faceEmbedding as number[] | null;

  // Which stored face is closest to the descriptor that mis-fired? That's the
  // culprit. Compare the anchor against the best gallery entry.
  let anchorDist = Infinity;
  if (anchor && anchor.length === wrongDescriptor.length) {
    anchorDist = euclideanDistance(wrongDescriptor, anchor);
  }
  let galleryIdx = -1;
  let galleryDist = Infinity;
  for (let i = 0; i < gallery.length; i++) {
    const g = gallery[i];
    if (!g.embedding || g.embedding.length !== wrongDescriptor.length) continue;
    const d = euclideanDistance(wrongDescriptor, g.embedding);
    if (d < galleryDist) {
      galleryDist = d;
      galleryIdx = i;
    }
  }

  // Prefer penalizing a gallery entry (evictable) over the curated anchor.
  if (galleryIdx >= 0 && galleryDist <= anchorDist) {
    const entry = gallery[galleryIdx];
    entry.weight = (entry.weight ?? 1) * FACE_PENALTY_FACTOR;
    let evicted = false;
    if (entry.weight <= FACE_GALLERY_WEIGHT_FLOOR) {
      gallery.splice(galleryIdx, 1);
      evicted = true;
    }
    await updateBiometricData(bdId, { faceEmbeddings: gallery });
    console.log(
      `[Recognition] Penalized gallery pose for ${target.type}:${target.id} ` +
        `(d=${galleryDist.toFixed(3)}, ${evicted ? "evicted" : `weight=${entry.weight.toFixed(2)}`}, size=${gallery.length})`,
    );
    return { penalized: "gallery", evicted, size: gallery.length };
  }

  if (anchor && anchorDist < Infinity) {
    // The enrolled anchor itself caused the bad match — we don't delete it, but
    // flag it loudly so the curated photo can be re-enrolled.
    console.warn(
      `[Recognition] Misidentification traced to the ENROLLED ANCHOR for ` +
        `${target.type}:${target.id} (d=${anchorDist.toFixed(3)}). The enrolled ` +
        `face photo may be poor or mismatched — recommend re-enrollment.`,
    );
    return { penalized: "anchor", evicted: false, size: gallery.length };
  }

  return { penalized: "none", evicted: false, size: gallery.length };
}

// ============================================================================
// Voice matching (same dedup strategy)
// ============================================================================

export async function findMatchingVoice(
  embedding: VoiceEmbedding,
  studentId: string,
): Promise<VoiceMatchResult | null> {
  // SECURITY: scoped to this student's known people only (see findMatchingFace).
  if (!studentId) return null;

  let bestMatch: VoiceMatchResult | null = null;
  let bestSimilarity = VOICE_MATCH_THRESHOLD;

  const people = await getKnownPeopleForStudent(studentId);

  for (const p of people) {
    if (!p.voiceEmbedding && !(p.voiceGallery && p.voiceGallery.length)) continue;
    // Max similarity across the enrolled anchor AND every above-floor sample.
    const similarity = bestVoiceSimilarity(embedding, p.voiceEmbedding as number[] | null, p.voiceGallery);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = {
        matched: true,
        entityType: p.type,
        entityId: p.id,
        name: p.name,
        similarity,
        confidence: (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD),
        sampleCount: usableVoiceSampleCount(p.voiceEmbedding as number[] | null, p.voiceGallery),
        description: p.description,
        contextNotes: p.contextNotes,
        relationship: p.relationship,
      };
    }
  }

  return bestMatch;
}

/** A per-person pitch summary for the FAST (pre-embedding) voice read. Derived
 *  from the pitch values stored on that person's voice-gallery samples. */
export interface VoicePitchProfile {
  entityType: EntityType;
  entityId: string;
  name: string;
  meanHz: number;
  stdHz: number;
  n: number;
  /** Formant-dispersion stats (Hz), when this person has dispersion samples on
   *  file. Omitted when none — the fast matcher then scores on pitch alone. */
  meanDispersion?: number;
  stdDispersion?: number;
  nDispersion?: number;
}

/**
 * Build each known person's pitch profile from their voice-gallery samples.
 * Cheap relative to embedding matching — feeds the immediate pitch+lip read
 * while the full embedding is still being computed in the background. People
 * with no pitched samples yet are omitted (they simply can't be named by the
 * fast tier until the slow tier has learned a sample). Scoped to this student's
 * known people, like findMatchingVoice.
 */
export async function getVoicePitchProfiles(studentId: string): Promise<VoicePitchProfile[]> {
  if (!studentId) return [];
  const people = await getKnownPeopleForStudent(studentId);
  const stats = (vals: number[]): { mean: number; std: number } => {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return { mean, std: Math.sqrt(variance) };
  };
  const out: VoicePitchProfile[] = [];
  for (const p of people) {
    const gallery = p.voiceGallery ?? [];
    const pitches = gallery.map(e => e.pitch).filter((x): x is number => typeof x === "number" && x > 0);
    if (!pitches.length) continue;
    const ps = stats(pitches);
    const disps = gallery.map(e => e.dispersion).filter((x): x is number => typeof x === "number" && x > 0);
    const ds = disps.length ? stats(disps) : null;
    out.push({
      entityType: p.type, entityId: p.id, name: p.name,
      meanHz: ps.mean, stdHz: ps.std, n: pitches.length,
      ...(ds ? { meanDispersion: ds.mean, stdDispersion: ds.std, nDispersion: disps.length } : {}),
    });
  }
  return out;
}

// ============================================================================
// Voice gallery growth (positive feedback) + correction (negative feedback)
// ============================================================================

export interface VoiceGalleryGrowthResult {
  added: boolean;
  reason: "added" | "seeded" | "redundant" | "too-far" | "low-quality" | "no-record";
  size: number;
}

/**
 * Consider adding a freshly-heard speech sample to a person's voice gallery.
 * Voice differs from faces in one crucial way: there is usually NO enrolled
 * anchor (voice enrollment is rare), so when the person has no usable voice
 * data at all the FIRST good-quality sample SEEDS the gallery unconditionally —
 * it becomes the de-facto anchor. After that, the novelty band applies just
 * like faces: only confident, non-duplicate samples are kept (see the
 * VOICE_GALLERY_NOVELTY/QUALITY constants), capped and evicted weakest-first.
 * The enrolled `voice_embedding` anchor, if any, is never touched.
 *
 * `target` is the matched entity ({ type, id }) — for contacts this resolves to
 * the shared (possibly linked) biometric record, so growth benefits every
 * relationship that real person appears in.
 */
export async function growVoiceGalleryForEntity(
  target: { type: EntityType; id: string },
  embedding: VoiceEmbedding,
  quality: number,
  pitch?: number,
  dispersion?: number,
): Promise<VoiceGalleryGrowthResult> {
  // A person may have NO biometric record yet (no enrollment) — that's the norm
  // for voice. We read what exists but don't require it; the seeding branch
  // creates the record on demand so a confident sighting can start the gallery.
  let bdId = await getBiometricDataIdFor(target);
  const row = bdId ? await getBiometricData(bdId) : null;

  const gallery = normalizeVoiceGallery(row?.voiceEmbeddings);
  const anchor = (row?.voiceEmbedding as number[] | null) ?? null;

  if (quality < VOICE_GALLERY_QUALITY_MIN) {
    return { added: false, reason: "low-quality", size: gallery.length };
  }

  const usable = usableVoiceSampleCount(anchor, gallery);

  // Bootstrap: no usable voice data yet → this good-quality sample SEEDS the
  // gallery (faces can't do this — they always have an enrolled anchor; voice
  // usually has nothing, so the gallery must self-start). Create the biometric
  // record on demand if the person doesn't have one.
  if (usable === 0) {
    if (!bdId) {
      try {
        bdId = await ensureBiometricData(target);
      } catch (err) {
        console.warn(`[Recognition] Could not create biometric record for ${target.type}:${target.id}:`, err);
        return { added: false, reason: "no-record", size: 0 };
      }
    }
    gallery.push({ embedding, quality, capturedAt: new Date().toISOString(), weight: 1, ...(typeof pitch === "number" ? { pitch } : {}), ...(typeof dispersion === "number" ? { dispersion } : {}) });
    await updateBiometricData(bdId, { voiceEmbeddings: gallery });
    console.log(`[Recognition] Seeded voice gallery for ${target.type}:${target.id} (q=${quality.toFixed(2)})`);
    return { added: true, reason: "seeded", size: gallery.length };
  }

  // Past the seeding branch, usable > 0 guarantees a record exists.
  if (!bdId) return { added: false, reason: "no-record", size: gallery.length };

  // Best similarity to everything we already know about this voice.
  const sim = bestVoiceSimilarity(embedding, anchor, gallery);

  // Above MAX: a near-duplicate of a sample we already have — adds no information.
  if (sim > VOICE_GALLERY_NOVELTY_MAX_SIM) {
    return { added: false, reason: "redundant", size: gallery.length };
  }
  // Below MIN: too dissimilar to trust as the same speaker — refuse, don't poison.
  if (sim < VOICE_GALLERY_NOVELTY_MIN_SIM) {
    return { added: false, reason: "too-far", size: gallery.length };
  }

  gallery.push({ embedding, quality, capturedAt: new Date().toISOString(), weight: 1, ...(typeof pitch === "number" ? { pitch } : {}), ...(typeof dispersion === "number" ? { dispersion } : {}) });

  // Cap: drop the weakest sample (lowest weight, tie-broken by lowest quality).
  if (gallery.length > VOICE_GALLERY_MAX) {
    let worst = 0;
    for (let i = 1; i < gallery.length; i++) {
      const a = gallery[i];
      const b = gallery[worst];
      if (a.weight < b.weight || (a.weight === b.weight && a.quality < b.quality)) {
        worst = i;
      }
    }
    gallery.splice(worst, 1);
  }

  await updateBiometricData(bdId, { voiceEmbeddings: gallery });
  console.log(
    `[Recognition] Grew voice gallery for ${target.type}:${target.id} ` +
      `(sim=${sim.toFixed(3)}, q=${quality.toFixed(2)}, size=${gallery.length})`,
  );
  return { added: true, reason: "added", size: gallery.length };
}

/**
 * Negative feedback for a voice misidentification. Given the embedding that was
 * WRONGLY matched to this person, find the stored voice (anchor or gallery
 * sample) MOST SIMILAR to it — the one that produced the bad match — and reduce
 * its trust. Gallery samples lose weight and are evicted once they fall to/under
 * the floor; the enrolled anchor (if any) is never deleted but the mismatch is
 * logged for re-enrollment. Mirrors penalizeFaceMatch in similarity space.
 */
export async function penalizeVoiceMatch(
  target: { type: EntityType; id: string },
  wrongEmbedding: VoiceEmbedding,
): Promise<GalleryPenaltyResult> {
  const bdId = await getBiometricDataIdFor(target);
  if (!bdId) return { penalized: "none", evicted: false, size: 0 };

  const row = await getBiometricData(bdId);
  if (!row) return { penalized: "none", evicted: false, size: 0 };

  const gallery = normalizeVoiceGallery(row.voiceEmbeddings);
  const anchor = row.voiceEmbedding as number[] | null;

  // Which stored voice is closest (most similar) to the embedding that mis-fired?
  let anchorSim = -Infinity;
  if (anchor && anchor.length === wrongEmbedding.length) {
    anchorSim = cosineSimilarity(wrongEmbedding, anchor);
  }
  let galleryIdx = -1;
  let gallerySim = -Infinity;
  for (let i = 0; i < gallery.length; i++) {
    const g = gallery[i];
    if (!g.embedding || g.embedding.length !== wrongEmbedding.length) continue;
    const s = cosineSimilarity(wrongEmbedding, g.embedding);
    if (s > gallerySim) {
      gallerySim = s;
      galleryIdx = i;
    }
  }

  // Prefer penalizing a gallery sample (evictable) over the curated anchor.
  if (galleryIdx >= 0 && gallerySim >= anchorSim) {
    const entry = gallery[galleryIdx];
    entry.weight = (entry.weight ?? 1) * VOICE_PENALTY_FACTOR;
    let evicted = false;
    if (entry.weight <= VOICE_GALLERY_WEIGHT_FLOOR) {
      gallery.splice(galleryIdx, 1);
      evicted = true;
    }
    await updateBiometricData(bdId, { voiceEmbeddings: gallery });
    console.log(
      `[Recognition] Penalized voice sample for ${target.type}:${target.id} ` +
        `(sim=${gallerySim.toFixed(3)}, ${evicted ? "evicted" : `weight=${entry.weight.toFixed(2)}`}, size=${gallery.length})`,
    );
    return { penalized: "gallery", evicted, size: gallery.length };
  }

  if (anchor && anchorSim > -Infinity) {
    console.warn(
      `[Recognition] Voice misidentification traced to the ENROLLED ANCHOR for ` +
        `${target.type}:${target.id} (sim=${anchorSim.toFixed(3)}). The enrolled ` +
        `voice sample may be poor or mismatched — recommend re-enrollment.`,
    );
    return { penalized: "anchor", evicted: false, size: gallery.length };
  }

  return { penalized: "none", evicted: false, size: gallery.length };
}

// ============================================================================
// Single-entity match (still used by voice-gated flows)
// ============================================================================

export async function matchesFaceForUser(
  userId: string,
  embedding: FaceEmbedding,
): Promise<{ matched: boolean; confidence: number }> {
  const stored = await getFaceEmbeddingForUser(userId);
  if (!stored) return { matched: false, confidence: 0 };
  const distance = euclideanDistance(embedding, stored);
  const matched = distance < FACE_MATCH_THRESHOLD;
  return { matched, confidence: matched ? Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD) : 0 };
}

export async function matchesFaceForStudent(
  studentId: string,
  embedding: FaceEmbedding,
): Promise<{ matched: boolean; confidence: number }> {
  const stored = await getFaceEmbeddingForStudent(studentId);
  if (!stored) return { matched: false, confidence: 0 };
  const distance = euclideanDistance(embedding, stored);
  const matched = distance < FACE_MATCH_THRESHOLD;
  return { matched, confidence: matched ? Math.max(0, 1 - distance / FACE_MATCH_THRESHOLD) : 0 };
}

export async function matchesVoiceForUser(
  userId: string,
  embedding: VoiceEmbedding,
): Promise<{ matched: boolean; confidence: number }> {
  const stored = await getVoiceEmbeddingForUser(userId);
  if (!stored) return { matched: false, confidence: 0 };
  const similarity = cosineSimilarity(embedding, stored);
  const matched = similarity > VOICE_MATCH_THRESHOLD;
  return {
    matched,
    confidence: matched ? (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD) : 0,
  };
}

export async function matchesVoiceForStudent(
  studentId: string,
  embedding: VoiceEmbedding,
): Promise<{ matched: boolean; confidence: number }> {
  const stored = await getVoiceEmbeddingForStudent(studentId);
  if (!stored) return { matched: false, confidence: 0 };
  const similarity = cosineSimilarity(embedding, stored);
  const matched = similarity > VOICE_MATCH_THRESHOLD;
  return {
    matched,
    confidence: matched ? (similarity - VOICE_MATCH_THRESHOLD) / (1 - VOICE_MATCH_THRESHOLD) : 0,
  };
}

// ============================================================================
// Known People — dedupes by biometricDataId when a contact is linked
// ============================================================================

export async function getKnownPeopleForStudent(studentId: string): Promise<KnownPerson[]> {
  const peopleById = new Map<string, KnownPerson>();
  const seenBdIds = new Set<string>();

  // 1. The student themselves
  const [student] = await db
    .select({
      id: students.id,
      name: students.name,
      bdId: students.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
      faceEmbeddings: biometricData.faceEmbeddings,
      voiceEmbedding: biometricData.voiceEmbedding,
      voiceEmbeddings: biometricData.voiceEmbeddings,
    })
    .from(students)
    .leftJoin(biometricData, eq(biometricData.id, students.biometricDataId))
    .where(eq(students.id, studentId));

  if (student) {
    if (student.bdId) seenBdIds.add(student.bdId);
    peopleById.set(`student:${student.id}`, {
      id: student.id,
      type: "student",
      name: student.name,
      relationship: "student",
      faceEmbedding: (student.faceEmbedding as number[] | null) ?? null,
      faceGallery: normalizeGallery(student.faceEmbeddings),
      voiceEmbedding: (student.voiceEmbedding as number[] | null) ?? null,
      voiceGallery: normalizeVoiceGallery(student.voiceEmbeddings),
    });
  }

  // 2. Users linked to this student (via userStudents)
  const linkedUsers = await db
    .select({
      userId: userStudents.userId,
      role: userStudents.role,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
      bdId: users.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
      faceEmbeddings: biometricData.faceEmbeddings,
      voiceEmbedding: biometricData.voiceEmbedding,
      voiceEmbeddings: biometricData.voiceEmbeddings,
    })
    .from(userStudents)
    .innerJoin(users, eq(users.id, userStudents.userId))
    .leftJoin(biometricData, eq(biometricData.id, users.biometricDataId))
    .where(and(eq(userStudents.studentId, studentId), eq(userStudents.isActive, true)));

  for (const u of linkedUsers) {
    if (u.bdId) seenBdIds.add(u.bdId);
    const name =
      u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Unknown";
    peopleById.set(`user:${u.userId}`, {
      id: u.userId,
      type: "user",
      name,
      relationship: u.role || "caregiver",
      faceEmbedding: (u.faceEmbedding as number[] | null) ?? null,
      faceGallery: normalizeGallery(u.faceEmbeddings),
      voiceEmbedding: (u.voiceEmbedding as number[] | null) ?? null,
      voiceGallery: normalizeVoiceGallery(u.voiceEmbeddings),
    });
  }

  // 3. Active contacts — skip those whose biometric data we've already added via link
  const contacts = await db
    .select({
      id: studentContacts.id,
      name: studentContacts.name,
      relationship: studentContacts.relationship,
      contextNotes: studentContacts.contextNotes,
      bdId: studentContacts.biometricDataId,
      linkedUserId: studentContacts.linkedUserId,
      linkedStudentId: studentContacts.linkedStudentId,
      faceEmbedding: biometricData.faceEmbedding,
      faceEmbeddings: biometricData.faceEmbeddings,
      voiceEmbedding: biometricData.voiceEmbedding,
      voiceEmbeddings: biometricData.voiceEmbeddings,
      physicalDescription: biometricData.physicalDescription,
    })
    .from(studentContacts)
    .leftJoin(biometricData, eq(biometricData.id, studentContacts.biometricDataId))
    .where(and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true)));

  for (const c of contacts) {
    // Skip if this contact's biometric data is already included via user/student link
    if (c.bdId && seenBdIds.has(c.bdId)) continue;
    if (c.bdId) seenBdIds.add(c.bdId);
    peopleById.set(`contact:${c.id}`, {
      id: c.id,
      type: "contact",
      name: c.name,
      relationship: c.relationship || undefined,
      faceEmbedding: (c.faceEmbedding as number[] | null) ?? null,
      faceGallery: normalizeGallery(c.faceEmbeddings),
      voiceEmbedding: (c.voiceEmbedding as number[] | null) ?? null,
      voiceGallery: normalizeVoiceGallery(c.voiceEmbeddings),
      description: c.physicalDescription || undefined,
      contextNotes: c.contextNotes || undefined,
    });
  }

  // Filter to only people with at least one embedding (anchor, gallery, or voice)
  const peopleWithEmbeddings = Array.from(peopleById.values()).filter(
    (p) => p.faceEmbedding !== null || (p.faceGallery && p.faceGallery.length > 0) || p.voiceEmbedding !== null || (p.voiceGallery && p.voiceGallery.length > 0),
  );

  console.log(
    `[Recognition] Found ${peopleById.size} people for student ${studentId}, ` +
      `${peopleWithEmbeddings.length} with embeddings (${contacts.length} contacts)`,
  );

  return peopleWithEmbeddings;
}

/**
 * One selectable person for the AAC sentence-builder "person list". Unlike
 * `getKnownPeopleForStudent` (which is the face-MATCHING pool and therefore
 * filters to people who actually have an embedding), this is the full
 * directory the student can pick from — every active contact, every linked
 * user, and the student — whether or not we can recognise them on camera.
 * Carries no embeddings (the client never needs them here); `hasPhoto`
 * tells the client whether a stored photo can be fetched via the photo
 * endpoint, so it can show a real face instead of the 👤 silhouette.
 */
export interface PersonDirectoryEntry {
  id: string;
  type: EntityType;
  name: string;
  relationship?: string;
  hasPhoto: boolean;
}

/**
 * Full selectable-people directory for a student's sentence builder. Mirrors
 * the three sources of `getKnownPeopleForStudent` but keeps people who lack
 * embeddings (they're still selectable — they just won't be auto-identified
 * on camera). Dedupes by biometricDataId the same way so a contact that is
 * also a linked user appears once.
 */
export async function getPeopleDirectoryForStudent(
  studentId: string,
): Promise<PersonDirectoryEntry[]> {
  const byKey = new Map<string, PersonDirectoryEntry>();
  const seenBdIds = new Set<string>();

  // 1. The student themselves
  const [student] = await db
    .select({
      id: students.id,
      name: students.name,
      bdId: students.biometricDataId,
      faceImageUrl: biometricData.faceImageUrl,
    })
    .from(students)
    .leftJoin(biometricData, eq(biometricData.id, students.biometricDataId))
    .where(eq(students.id, studentId));

  if (student) {
    if (student.bdId) seenBdIds.add(student.bdId);
    byKey.set(`student:${student.id}`, {
      id: student.id,
      type: "student",
      name: student.name,
      relationship: "student",
      hasPhoto: !!student.faceImageUrl,
    });
  }

  // 2. Users linked to this student
  const linkedUsers = await db
    .select({
      userId: userStudents.userId,
      role: userStudents.role,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
      bdId: users.biometricDataId,
      faceImageUrl: biometricData.faceImageUrl,
    })
    .from(userStudents)
    .innerJoin(users, eq(users.id, userStudents.userId))
    .leftJoin(biometricData, eq(biometricData.id, users.biometricDataId))
    .where(and(eq(userStudents.studentId, studentId), eq(userStudents.isActive, true)));

  for (const u of linkedUsers) {
    if (u.bdId) seenBdIds.add(u.bdId);
    const name =
      u.fullName || `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Unknown";
    byKey.set(`user:${u.userId}`, {
      id: u.userId,
      type: "user",
      name,
      relationship: u.role || "caregiver",
      hasPhoto: !!u.faceImageUrl,
    });
  }

  // 3. Active contacts — skip those already represented via a linked record
  const contacts = await db
    .select({
      id: studentContacts.id,
      name: studentContacts.name,
      relationship: studentContacts.relationship,
      bdId: studentContacts.biometricDataId,
      faceImageUrl: biometricData.faceImageUrl,
    })
    .from(studentContacts)
    .leftJoin(biometricData, eq(biometricData.id, studentContacts.biometricDataId))
    .where(and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true)));

  for (const c of contacts) {
    if (c.bdId && seenBdIds.has(c.bdId)) continue;
    if (c.bdId) seenBdIds.add(c.bdId);
    byKey.set(`contact:${c.id}`, {
      id: c.id,
      type: "contact",
      name: c.name,
      relationship: c.relationship || undefined,
      hasPhoto: !!c.faceImageUrl,
    });
  }

  return Array.from(byKey.values());
}

/**
 * Resolve the stored face-image S3 key for a person (by their AAC-facing id)
 * but ONLY when that person belongs to the given student — so the AAC photo
 * endpoint can't be used to fetch an arbitrary biometric photo by guessing
 * ids. Returns null when the person isn't in the student's directory or has
 * no stored photo. The id may be a student id, a linked user id, or a
 * student_contacts id (matching the ids emitted by the directory above and
 * the `face:ID` refs the AI uses).
 */
export async function getPersonFaceImageUrlForStudent(
  studentId: string,
  personId: string,
): Promise<string | null> {
  // Student themselves
  if (personId === studentId) {
    const [row] = await db
      .select({ faceImageUrl: biometricData.faceImageUrl })
      .from(students)
      .leftJoin(biometricData, eq(biometricData.id, students.biometricDataId))
      .where(eq(students.id, studentId));
    return row?.faceImageUrl ?? null;
  }

  // Linked user
  const [linked] = await db
    .select({ faceImageUrl: biometricData.faceImageUrl })
    .from(userStudents)
    .innerJoin(users, eq(users.id, userStudents.userId))
    .leftJoin(biometricData, eq(biometricData.id, users.biometricDataId))
    .where(
      and(
        eq(userStudents.studentId, studentId),
        eq(userStudents.isActive, true),
        eq(userStudents.userId, personId),
      ),
    );
  if (linked) return linked.faceImageUrl ?? null;

  // Contact owned by this student
  const [contact] = await db
    .select({ faceImageUrl: biometricData.faceImageUrl })
    .from(studentContacts)
    .leftJoin(biometricData, eq(biometricData.id, studentContacts.biometricDataId))
    .where(
      and(
        eq(studentContacts.id, personId),
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.isActive, true),
      ),
    );
  if (contact) return contact.faceImageUrl ?? null;

  return null;
}

export async function getKnownPeopleForUser(userId: string): Promise<KnownPerson[]> {
  const people: KnownPerson[] = [];

  const [user] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
      bdId: users.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
      faceEmbeddings: biometricData.faceEmbeddings,
      voiceEmbedding: biometricData.voiceEmbedding,
      voiceEmbeddings: biometricData.voiceEmbeddings,
    })
    .from(users)
    .leftJoin(biometricData, eq(biometricData.id, users.biometricDataId))
    .where(eq(users.id, userId));

  if (user) {
    const name =
      user.fullName || `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Unknown";
    people.push({
      id: user.id,
      type: "user",
      name,
      relationship: "self",
      faceEmbedding: (user.faceEmbedding as number[] | null) ?? null,
      faceGallery: normalizeGallery(user.faceEmbeddings),
      voiceEmbedding: (user.voiceEmbedding as number[] | null) ?? null,
      voiceGallery: normalizeVoiceGallery(user.voiceEmbeddings),
    });
  }

  const linkedStudents = await db
    .select({
      studentId: userStudents.studentId,
      role: userStudents.role,
      name: students.name,
      bdId: students.biometricDataId,
      faceEmbedding: biometricData.faceEmbedding,
      faceEmbeddings: biometricData.faceEmbeddings,
      voiceEmbedding: biometricData.voiceEmbedding,
      voiceEmbeddings: biometricData.voiceEmbeddings,
    })
    .from(userStudents)
    .innerJoin(students, eq(students.id, userStudents.studentId))
    .leftJoin(biometricData, eq(biometricData.id, students.biometricDataId))
    .where(and(eq(userStudents.userId, userId), eq(userStudents.isActive, true)));

  for (const s of linkedStudents) {
    people.push({
      id: s.studentId,
      type: "student",
      name: s.name,
      relationship: "student",
      faceEmbedding: (s.faceEmbedding as number[] | null) ?? null,
      faceGallery: normalizeGallery(s.faceEmbeddings),
      voiceEmbedding: (s.voiceEmbedding as number[] | null) ?? null,
      voiceGallery: normalizeVoiceGallery(s.voiceEmbeddings),
    });
  }

  return people.filter(
    (p) => p.faceEmbedding !== null || (p.faceGallery && p.faceGallery.length > 0) || p.voiceEmbedding !== null || (p.voiceGallery && p.voiceGallery.length > 0),
  );
}

// ============================================================================
// Contact CRUD with linked-record invariants
// ============================================================================

const CONTACT_LINK_ERRORS = {
  bothLinks: "A contact cannot link to both a user and another student",
  selfLink: "A student cannot be their own contact",
} as const;

/**
 * Validate link invariants and resolve biometricDataId based on links.
 * Returns the data to actually insert/update.
 */
async function applyLinkInvariants<
  T extends {
    linkedUserId?: string | null;
    linkedStudentId?: string | null;
    studentId?: string | null;
    biometricDataId?: string | null;
  },
>(data: T, ownerStudentId?: string): Promise<T> {
  if (data.linkedUserId && data.linkedStudentId) {
    throw new Error(CONTACT_LINK_ERRORS.bothLinks);
  }
  const sid = ownerStudentId ?? data.studentId ?? null;
  if (data.linkedStudentId && sid && data.linkedStudentId === sid) {
    throw new Error(CONTACT_LINK_ERRORS.selfLink);
  }
  // Write-through biometricDataId from linked entity
  if (data.linkedUserId) {
    const bdId = await ensureBiometricData({ type: "user", id: data.linkedUserId });
    return { ...data, biometricDataId: bdId };
  }
  if (data.linkedStudentId) {
    const bdId = await ensureBiometricData({ type: "student", id: data.linkedStudentId });
    return { ...data, biometricDataId: bdId };
  }
  return data;
}

export async function createContact(data: InsertStudentContact): Promise<StudentContact> {
  const validated = await applyLinkInvariants(data);
  const [contact] = await db.insert(studentContacts).values(validated).returning();
  console.log(`[Recognition] Created contact "${contact.name}" for student ${data.studentId}`);
  return contact;
}

export async function getContact(id: string): Promise<StudentContact | undefined> {
  const [contact] = await db.select().from(studentContacts).where(eq(studentContacts.id, id));
  return contact;
}

export async function getContactsByStudent(studentId: string): Promise<StudentContact[]> {
  return db
    .select()
    .from(studentContacts)
    .where(and(eq(studentContacts.studentId, studentId), eq(studentContacts.isActive, true)));
}

export async function updateContact(
  id: string,
  data: UpdateStudentContact,
): Promise<StudentContact | undefined> {
  // Load current record so invariants can be validated against the merged view
  const [current] = await db
    .select({
      studentId: studentContacts.studentId,
      linkedUserId: studentContacts.linkedUserId,
      linkedStudentId: studentContacts.linkedStudentId,
    })
    .from(studentContacts)
    .where(eq(studentContacts.id, id));
  if (!current) return undefined;

  const merged = {
    ...data,
    linkedUserId: "linkedUserId" in data ? data.linkedUserId : current.linkedUserId,
    linkedStudentId: "linkedStudentId" in data ? data.linkedStudentId : current.linkedStudentId,
  };
  const validated = await applyLinkInvariants(merged, current.studentId);

  const [contact] = await db
    .update(studentContacts)
    .set({ ...validated, updatedAt: new Date() })
    .where(eq(studentContacts.id, id))
    .returning();
  return contact;
}

export async function deleteContact(id: string): Promise<void> {
  await db
    .update(studentContacts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(studentContacts.id, id));
}

/** Record a sighting for a contact — bumps timesIdentified and lastSeenAt. */
export async function recordContactSighting(contactId: string): Promise<void> {
  await db
    .update(studentContacts)
    .set({
      lastSeenAt: new Date(),
      timesIdentified: sql`${studentContacts.timesIdentified} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(studentContacts.id, contactId));
}

export async function enrollContactFace(contactId: string, embedding: FaceEmbedding): Promise<void> {
  await storeFaceEmbeddingForContact(contactId, embedding);
}

// ============================================================================
// Dedup check for AI enrollment
// ============================================================================

export async function findSimilarContact(
  studentId: string,
  embedding: FaceEmbedding,
): Promise<StudentContact | null> {
  const rows = await db
    .select({
      contact: studentContacts,
      faceEmbedding: biometricData.faceEmbedding,
    })
    .from(studentContacts)
    .innerJoin(biometricData, eq(biometricData.id, studentContacts.biometricDataId))
    .where(
      and(
        eq(studentContacts.studentId, studentId),
        eq(studentContacts.isActive, true),
        isNotNull(biometricData.faceEmbedding),
      ),
    );

  for (const row of rows) {
    if (!row.faceEmbedding) continue;
    const distance = euclideanDistance(embedding, row.faceEmbedding as FaceEmbedding);
    if (distance < FACE_MATCH_THRESHOLD) {
      return row.contact;
    }
  }

  return null;
}

// ============================================================================
// Linkable entities — users + other students sharing an institute with this
// student. Used by the contact editor to populate linkedUserId / linkedStudentId.
// ============================================================================

export interface LinkableEntity {
  id: string;
  type: "user" | "student";
  name: string;
  detail?: string; // email for users, role/relationship context for students
}

export async function getLinkableEntitiesForStudent(
  studentId: string,
): Promise<LinkableEntity[]> {
  // 1. Find all institutes this student is a member of
  const studentInstitutes = await db
    .select({ instituteId: instituteStudents.instituteId })
    .from(instituteStudents)
    .where(
      and(
        eq(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true),
      ),
    );
  const instituteIds = studentInstitutes.map((r) => r.instituteId);
  if (instituteIds.length === 0) return [];

  // 2. Users in those institutes
  const institutesUsers = await db
    .selectDistinct({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      fullName: users.fullName,
    })
    .from(instituteUsers)
    .innerJoin(users, eq(users.id, instituteUsers.userId))
    .where(
      and(
        inArray(instituteUsers.instituteId, instituteIds),
        eq(instituteUsers.isActive, true),
        eq(users.isActive, true),
      ),
    );

  // 3. Other students in those institutes (excluding the subject student)
  const institutesStudents = await db
    .selectDistinct({
      id: students.id,
      name: students.name,
      firstName: students.firstName,
      lastName: students.lastName,
    })
    .from(instituteStudents)
    .innerJoin(students, eq(students.id, instituteStudents.studentId))
    .where(
      and(
        inArray(instituteStudents.instituteId, instituteIds),
        ne(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true),
        eq(students.isActive, true),
      ),
    );

  const linkable: LinkableEntity[] = [
    ...institutesUsers.map((u) => ({
      id: u.id,
      type: "user" as const,
      name:
        u.fullName ||
        `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
        u.email ||
        "Unknown",
      detail: u.email,
    })),
    ...institutesStudents.map((s) => ({
      id: s.id,
      type: "student" as const,
      name: s.name || `${s.firstName || ""} ${s.lastName || ""}`.trim() || "Unknown",
    })),
  ];

  linkable.sort((a, b) => a.name.localeCompare(b.name));
  return linkable;
}
