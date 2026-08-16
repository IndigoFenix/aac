// shared/world-engine/glyph-raster-cache.ts
//
// ON-DEVICE cache behind the in-world speech bubbles, holding two different
// things at two different levels of reuse.
//
// ── SLOT ASSETS (the one that matters) ──────────────────────────────────────
// A composed glyph is drawn by serializing the compositor to an SVG and decoding
// it as an image. An SVG loaded as an `<img>` may not fetch external hrefs, so
// every slot's artwork has to be INLINED as a data URL — and the bundled icons
// are 500x500 PNGs of 65-175 KB, which base64 to ~90-230 KB EACH.
//
// The killer is that this cost is per SENTENCE, not per icon. Bubbles say
// something new nearly every time, so each one builds a fresh ~0.3-1 MB data
// URL and the browser decodes every embedded 500x500 PNG again from scratch.
// Caching the fetched bytes (which the module already did) never helped: the
// bytes were reused, the DECODE was not. Emoji slots raster to a tiny canvas,
// which is exactly why only the bundled icons dragged.
//
// So slot art is shrunk ONCE to the size it can actually be shown at — the whole
// composed glyph rasters at 200px tall — and that small data URL is what every
// sentence inlines from then on. Keyed by asset URL, which is content-hashed by
// the bundler, so re-cut art lands on a new key and the stale one just ages out.
//
// ── GLYPH RASTERS ───────────────────────────────────────────────────────────
// A PNG of a WHOLE composed glyph, so an exactly-repeated line (and the fixed
// activity-bubble vocabulary, which quest-host prewarms) skips composition
// entirely. Low reuse for free-form speech — the slot cache above is what
// carries the general case.
//
// The cache is STRICTLY an optimization: every failure path resolves to "miss"
// and the caller composes from scratch. It must never be able to stop a bubble
// from rendering.
//
// DOM/IndexedDB-bound — main thread only, same as glyph-images.ts. In a worker,
// jsdom or node (tests) `indexedDB` is absent and every call no-ops.

/** Bump to retire every stored WHOLE-GLYPH raster. A stale one is
 *  indistinguishable from a fresh one — the epoch is the only thing that can
 *  invalidate it — so bump on any change to the compositor's output.
 *
 *  Slot assets need no epoch: their key IS the content-hashed asset URL, so
 *  re-cut art can never be served from an old entry. */
export const GLYPH_RASTER_EPOCH = 1;

const DB_NAME = "aivota-glyph-raster";
const DB_VERSION = 1;
const STORE_NAME = "rasters";

/** Key prefixes. Eviction only ever considers `g|` (see evictOverflow). */
const GLYPH_PREFIX = "g|";
const SLOT_PREFIX = "s|";

/** Cap on stored WHOLE-GLYPH rasters. Slot assets are deliberately NOT counted:
 *  they are bounded by the bundled art itself (a few hundred), each is a few KB
 *  once shrunk, and they are the entries with real reuse — letting churning
 *  sentence rasters evict them would undo the only fix that matters. */
const MAX_GLYPH_ENTRIES = 400;

interface CacheRecord {
  key: string;
  /** PNG bytes for a whole-glyph raster; a data-URL string for a slot asset. */
  data: ArrayBuffer | string;
  createdAt: number;
}

/** Key for one composed glyph in one direction and plate mode. */
export function glyphRasterKey(glyph: string, rtl: boolean, noBackground: boolean): string {
  return `${GLYPH_PREFIX}${GLYPH_RASTER_EPOCH}|${rtl ? "r" : "l"}|${noBackground ? "n" : "p"}|${glyph}`;
}

/** Key for one shrunk slot asset. `maxEdge` participates so changing the cap
 *  re-shrinks rather than serving art at the old size. */
export function slotAssetKey(url: string, maxEdge: number): string {
  return `${SLOT_PREFIX}${maxEdge}|${url}`;
}

/**
 * Whether a slot asset may be BANKED ACROSS SESSIONS (in-memory caching always
 * applies, to every URL). Only bundled art qualifies: the bundler content-hashes
 * its filename, so re-cut art lands on a new key and a stale entry can never be
 * served.
 *
 * A clinician-authored or AI-generated symbol is served from `/api/...` or a CDN
 * under an id that STAYS THE SAME when the picture behind it is replaced —
 * banking those would show a student last month's symbol. They also arrive
 * already sized for a board button, so excluding them costs nothing: the
 * oversized art this cache exists for is exactly the bundled kind.
 */
export function canBankSlotAsset(url: string): boolean {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return false;
  const origin = typeof location !== "undefined" ? location.origin : undefined;
  const known = origin && origin !== "null" ? origin : undefined;
  try {
    // An ABSOLUTE address is never a bundler-emitted asset (those are relative or
    // root-relative), so bank it only if we can positively confirm it points back
    // at this app. With no `location` to compare against — a worker, a test — we
    // cannot, and refusing is the safe answer.
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
    if (absolute && (!known || new URL(url, known).origin !== known)) return false;
    return !new URL(url, known ?? "http://app.local").pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function store(): IDBFactory | null {
  return typeof indexedDB !== "undefined" ? indexedDB : null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  const idb = store();
  if (!idb) return Promise.reject(new Error("no indexedDB"));
  let pending = dbPromise;
  if (!pending) {
    pending = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const s = db.createObjectStore(STORE_NAME, { keyPath: "key" });
          s.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise = pending;
    // Drop the memo on failure so a later glyph retries instead of being stuck
    // behind one rejected promise for the whole session.
    pending.catch(() => {
      if (dbPromise === pending) dbPromise = null;
    });
  }
  return pending;
}

async function readEntry(key: string): Promise<ArrayBuffer | string | null> {
  if (!store()) return null;
  try {
    const db = await openDB();
    return await new Promise<ArrayBuffer | string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as CacheRecord | undefined)?.data ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeEntry(key: string, data: ArrayBuffer | string): Promise<void> {
  if (!store()) return;
  try {
    const db = await openDB();
    const record: CacheRecord = { key, data, createdAt: Date.now() };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    await evictOverflow(db);
  } catch {
    /* cache-only — never surfaced */
  }
}

/** The stored bitmap for a whole composed glyph, or null on miss / any error. */
export async function readGlyphRaster(key: string): Promise<ArrayBuffer | null> {
  const data = await readEntry(key);
  return data instanceof ArrayBuffer ? data : null;
}

/** Bank a whole-glyph bitmap. Silent on any storage error. */
export async function writeGlyphRaster(key: string, png: ArrayBuffer): Promise<void> {
  if (png.byteLength === 0) return;
  await writeEntry(key, png);
}

/** The stored shrunk data URL for a slot asset, or null on miss / any error. */
export async function readSlotAsset(key: string): Promise<string | null> {
  const data = await readEntry(key);
  return typeof data === "string" && data ? data : null;
}

/** Bank a shrunk slot asset. Silent on any storage error. */
export async function writeSlotAsset(key: string, dataUrl: string): Promise<void> {
  if (!dataUrl) return;
  await writeEntry(key, dataUrl);
}

/** Drop the oldest WHOLE-GLYPH rasters once they exceed MAX_GLYPH_ENTRIES.
 *  Eviction is by INSERTION age, not last use: the alternative writes on every
 *  read, and the vocabulary a given student meets is stable enough that recency
 *  buys little. Slot assets are never evicted here — see MAX_GLYPH_ENTRIES. */
async function evictOverflow(db: IDBDatabase): Promise<void> {
  const rows = await new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    // Keys only, in createdAt order — pulling the payloads back out to sort
    // them would cost more than the eviction saves.
    const req = tx.objectStore(STORE_NAME).index("createdAt").openKeyCursor();
    const out: string[] = [];
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      const k = String(cur.primaryKey);
      if (k.startsWith(GLYPH_PREFIX)) out.push(k);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  if (rows.length <= MAX_GLYPH_ENTRIES) return;

  const doomed = rows.slice(0, rows.length - MAX_GLYPH_ENTRIES); // cursor is oldest-first
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const s = tx.objectStore(STORE_NAME);
    for (const k of doomed) s.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Wipe everything (icon art regenerated, troubleshooting). */
export async function clearGlyphRasterCache(): Promise<void> {
  if (!store()) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* cache-only — never surfaced */
  }
}
