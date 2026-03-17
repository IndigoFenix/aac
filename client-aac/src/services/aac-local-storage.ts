// client-aac/src/services/aac-local-storage.ts
// IndexedDB-based local storage for AAC session data.
// Supports AES-GCM encryption with a per-student key.
// Works in both browser and Electron.

import type {
  AacSessionSnapshot,
  AacLocalStorageConfig,
} from "@shared/aac-local-storage";

const DB_NAME = "cliniaacian-aac";
const DB_VERSION = 1;
const STORE_NAME = "sessions";

// Max age for old session records (7 days)
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("studentId", "studentId", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function txPut(db: IDBDatabase, record: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function txDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function txGetAllByIndex<T>(db: IDBDatabase, indexName: string, value: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index(indexName);
    const req = idx.getAll(value);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

function txGetAll<T>(db: IDBDatabase): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Encryption helpers (Web Crypto API — AES-256-GCM)
// ---------------------------------------------------------------------------

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  // Pack as: iv (12 bytes) + ciphertext → base64
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...packed));
}

async function decrypt(key: CryptoKey, packed64: string): Promise<string> {
  const packed = Uint8Array.from(atob(packed64), c => c.charCodeAt(0));
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Internal record shape (stored in IndexedDB)
// ---------------------------------------------------------------------------

interface StoredRecord {
  key: string; // `${studentId}:${sessionId}`
  studentId: string;
  sessionId: string;
  /** JSON string (possibly encrypted) */
  data: string;
  encrypted: boolean;
  updatedAt: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save a session snapshot to local IndexedDB.
 */
export async function saveSessionSnapshot(
  snapshot: AacSessionSnapshot,
  config: AacLocalStorageConfig,
): Promise<void> {
  if (!config.localStorageEnabled) return;

  try {
    const db = await openDB();
    const key = `${snapshot.studentId}:${snapshot.sessionId}`;
    const json = JSON.stringify(snapshot);

    let data: string;
    let encrypted = false;

    if (config.encryptionKey) {
      const cryptoKey = await importKey(config.encryptionKey);
      data = await encrypt(cryptoKey, json);
      encrypted = true;
    } else {
      data = json;
    }

    const existing = await txGet<StoredRecord>(db, key);
    const record: StoredRecord = {
      key,
      studentId: snapshot.studentId,
      sessionId: snapshot.sessionId,
      data,
      encrypted,
      updatedAt: Date.now(),
      createdAt: existing?.createdAt ?? Date.now(),
    };

    await txPut(db, record);
    db.close();
  } catch (err) {
    console.warn("[AacLocalStorage] saveSessionSnapshot failed:", err);
  }
}

/**
 * Load the most recent session snapshot for a student.
 * Returns null if no local data exists or decryption fails.
 */
export async function loadLatestSnapshot(
  studentId: string,
  encryptionKey: string | null,
): Promise<AacSessionSnapshot | null> {
  try {
    const db = await openDB();
    const records = await txGetAllByIndex<StoredRecord>(db, "studentId", studentId);
    db.close();

    if (records.length === 0) return null;

    // Sort by updatedAt descending, pick the most recent
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    const record = records[0];

    return await decryptRecord(record, encryptionKey);
  } catch (err) {
    console.warn("[AacLocalStorage] loadLatestSnapshot failed:", err);
    return null;
  }
}

/**
 * Load a specific session snapshot by sessionId.
 */
export async function loadSessionSnapshot(
  studentId: string,
  sessionId: string,
  encryptionKey: string | null,
): Promise<AacSessionSnapshot | null> {
  try {
    const db = await openDB();
    const key = `${studentId}:${sessionId}`;
    const record = await txGet<StoredRecord>(db, key);
    db.close();

    if (!record) return null;
    return await decryptRecord(record, encryptionKey);
  } catch (err) {
    console.warn("[AacLocalStorage] loadSessionSnapshot failed:", err);
    return null;
  }
}

/**
 * Delete a specific session from local storage.
 */
export async function deleteSessionSnapshot(
  studentId: string,
  sessionId: string,
): Promise<void> {
  try {
    const db = await openDB();
    await txDelete(db, `${studentId}:${sessionId}`);
    db.close();
  } catch (err) {
    console.warn("[AacLocalStorage] deleteSessionSnapshot failed:", err);
  }
}

/**
 * Delete all local sessions for a student.
 */
export async function deleteAllStudentSessions(studentId: string): Promise<void> {
  try {
    const db = await openDB();
    const records = await txGetAllByIndex<StoredRecord>(db, "studentId", studentId);
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const rec of records) {
      store.delete(rec.key);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("[AacLocalStorage] deleteAllStudentSessions failed:", err);
  }
}

/**
 * Remove session records older than MAX_SESSION_AGE_MS.
 * Call periodically (e.g. on app start) to prevent unbounded growth.
 */
export async function cleanupOldSessions(): Promise<number> {
  try {
    const db = await openDB();
    const all = await txGetAll<StoredRecord>(db);
    const cutoff = Date.now() - MAX_SESSION_AGE_MS;
    const toDelete = all.filter(r => r.updatedAt < cutoff);

    if (toDelete.length > 0) {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const rec of toDelete) {
        store.delete(rec.key);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    db.close();
    return toDelete.length;
  } catch (err) {
    console.warn("[AacLocalStorage] cleanupOldSessions failed:", err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function decryptRecord(
  record: StoredRecord,
  encryptionKey: string | null,
): Promise<AacSessionSnapshot | null> {
  try {
    let json: string;
    if (record.encrypted) {
      if (!encryptionKey) {
        console.warn("[AacLocalStorage] Record is encrypted but no key provided");
        return null;
      }
      const cryptoKey = await importKey(encryptionKey);
      json = await decrypt(cryptoKey, record.data);
    } else {
      json = record.data;
    }
    return JSON.parse(json) as AacSessionSnapshot;
  } catch (err) {
    console.warn("[AacLocalStorage] Failed to decrypt/parse record:", err);
    return null;
  }
}
