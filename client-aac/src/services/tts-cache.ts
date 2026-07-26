// client-aac/src/services/tts-cache.ts
//
// On-device cache for synthesized speech, DELIBERATELY scoped to the two
// quick-button words ("yes" / "no").
//
// Scope rationale: this AAC's boards are AI-generated fresh every turn, so
// general utterance text has a very long tail and caching it would grow without
// bound for a near-zero hit rate. The quick-action row is the opposite — a
// fixed pair of buttons, in the student's own language, pressed constantly.
// Those two are worth keeping locally; nothing else is.
//
// Entries are keyed by voice AND language, because the same student can be
// re-voiced (different ElevenLabs voice) or switch language, and cached audio
// from the old voice must never leak into the new one.
//
// Cached payload is raw s16le PCM, the same format the streaming path feeds to
// the player, so a cache hit replays through the identical audio graph.

const DB_NAME = "cliniaacian-tts-cache";
const DB_VERSION = 1;
const STORE_NAME = "clips";

/** Hard cap on stored clips. Two per (voice, language) pair — this bounds the
 *  store across voice changes and multilingual students without needing a byte
 *  budget. Oldest-first eviction. */
const MAX_ENTRIES = 32;

export interface CachedTtsClip {
  key: string;
  voiceId: string;
  language: string;
  /** Normalized phrase this clip speaks. */
  phrase: string;
  /** Sample rate of `pcm`. */
  sourceRate: number;
  /** Raw s16le mono PCM. */
  pcm: ArrayBuffer;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Cacheable-phrase registry
// ---------------------------------------------------------------------------

/** Normalized phrases eligible for caching — set by the UI from the current
 *  locale's quick-action labels. Empty until registered, so nothing is cached
 *  by accident. */
let cacheablePhrases = new Set<string>();

/** Normalize for comparison + keying: trim, case-fold, drop edge punctuation.
 *  Keeps this robust to "Yes" vs "yes" vs "Yes." without touching the middle
 *  of a phrase (which would break non-Latin scripts). */
export function normalizePhrase(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
}

/**
 * Declare which phrases may be cached. Call with the CURRENT locale's
 * quick-action yes/no labels; re-call on language change.
 */
export function setCacheablePhrases(phrases: string[]): void {
  cacheablePhrases = new Set(phrases.map(normalizePhrase).filter(Boolean));
}

/** True when `text` is one of the registered quick-button words. */
export function isCacheablePhrase(text: string): boolean {
  return cacheablePhrases.has(normalizePhrase(text));
}

function cacheKey(voiceId: string, language: string, phrase: string): string {
  return `${voiceId}|${language}|${phrase}`;
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  let pending = dbPromise;
  if (!pending) {
    pending = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise = pending;
    // Clear the memo on failure so a later press can retry rather than being
    // permanently stuck with a rejected promise.
    pending.catch(() => {
      if (dbPromise === pending) dbPromise = null;
    });
  }
  return pending;
}

/**
 * Look up a cached clip. Returns null on miss, or on ANY storage error —
 * the cache is strictly an optimization and must never block speech.
 */
export async function getCachedClip(
  text: string,
  voiceId: string,
  language: string,
): Promise<CachedTtsClip | null> {
  const phrase = normalizePhrase(text);
  if (!cacheablePhrases.has(phrase)) return null;
  try {
    const db = await openDB();
    return await new Promise<CachedTtsClip | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(cacheKey(voiceId, language, phrase));
      req.onsuccess = () => resolve((req.result as CachedTtsClip) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[TtsCache] Lookup failed:", err);
    return null;
  }
}

/**
 * Store a clip if the phrase is one of the registered quick-button words.
 * No-ops silently otherwise, and on any storage error.
 */
export async function putCachedClip(params: {
  text: string;
  voiceId: string;
  language: string;
  sourceRate: number;
  pcm: ArrayBuffer;
}): Promise<void> {
  const phrase = normalizePhrase(params.text);
  if (!cacheablePhrases.has(phrase)) return;
  if (params.pcm.byteLength === 0) return;
  try {
    const db = await openDB();
    const record: CachedTtsClip = {
      key: cacheKey(params.voiceId, params.language, phrase),
      voiceId: params.voiceId,
      language: params.language,
      phrase,
      sourceRate: params.sourceRate,
      pcm: params.pcm,
      createdAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    await evictOverflow(db);
  } catch (err) {
    console.warn("[TtsCache] Store failed:", err);
  }
}

/** Drop the oldest entries once the store exceeds MAX_ENTRIES. */
async function evictOverflow(db: IDBDatabase): Promise<void> {
  const keys = await new Promise<{ key: string; createdAt: number }[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () =>
      resolve((req.result as CachedTtsClip[]).map((r) => ({ key: r.key, createdAt: r.createdAt })));
    req.onerror = () => reject(req.error);
  });
  if (keys.length <= MAX_ENTRIES) return;

  const doomed = keys.sort((a, b) => a.createdAt - b.createdAt).slice(0, keys.length - MAX_ENTRIES);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    doomed.forEach((d) => store.delete(d.key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Wipe every cached clip (voice change, sign-out, troubleshooting). */
export async function clearTtsCache(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[TtsCache] Clear failed:", err);
  }
}
