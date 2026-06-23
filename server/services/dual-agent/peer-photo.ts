// Resolve a chat peer's stored face photo as a data URL, for the group-chat
// header. Authorization is implicit: we only ever look this up for peers the
// participant is already in a room with (membership established by the call), so
// the server can safely hand the image to co-participants without exposing a
// kiosk-guessable photo endpoint.
//
// A peer is a `person` (the canonical human) — a student OR a non-student such
// as a caretaker. We resolve the person to its facet and fetch that facet's
// enrolled face image (biometricData.faceImageUrl, an S3 key), then inline it as
// a base64 data URL. Results are cached per personId (including "no photo") so
// repeated roster pushes don't refetch.

import { personRepository } from "../../repositories/personRepository";
import { getPersonFaceImageUrlForStudent, getFaceImageUrlForUser } from "../biometric/recognition-service";
import { s3Service } from "../storage/s3-service";

// personId → data URL, or null when the person has no stored photo.
const cache = new Map<string, string | null>();

export async function getPeerFacePhotoDataUrl(personId: string): Promise<string | null> {
  const cached = cache.get(personId);
  if (cached !== undefined) return cached;
  try {
    const person = await personRepository.getById(personId);
    let key: string | null = null;
    if (person?.studentId) {
      // (studentId, studentId) resolves the student's OWN enrolled face image.
      key = await getPersonFaceImageUrlForStudent(person.studentId, person.studentId);
    } else if (person?.userId) {
      key = await getFaceImageUrlForUser(person.userId);
    }
    if (!key) {
      cache.set(personId, null);
      return null;
    }
    const buf = await s3Service.download(key);
    const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
    cache.set(personId, dataUrl);
    return dataUrl;
  } catch (err) {
    // Don't cache transient errors — a later push can retry.
    console.error("[peerPhoto] fetch error for", personId, err);
    return null;
  }
}
