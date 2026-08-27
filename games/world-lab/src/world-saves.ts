// games/world-lab/src/world-saves.ts
//
// THE WORLD SAVE (record-persistence round P1 — ledger §2/§3b). One
// versioned envelope holding a FLAT SCOPE-RECORD TABLE: `records` is
// `[{id, kind, payload, at?}]`, never a field per rung (ruling ⑥ — the
// scope-agnostic INDEX; a new rung is a new kind, never a format change).
// Kinds this build writes: `founded-site` (the engine's own
// SerializedFoundedSite plus its planet address) and `felled-marks`
// (REMAINING seconds per instance — the rest-time law, ruling ③: nothing
// in a save references a clock that dies; null = permanent). Kinds this
// build does NOT recognize are CARRIED THROUGH load→save untouched
// (legacy-fields-read-forever, applied forward: a newer build's records
// survive an older build's autosave).
//
// STORE DISCIPLINE = geo-bake's: IndexedDB, every failure path resolves to
// "no save is fine" (miss on load, silent skip on write), version prefix
// in the KEY so a format bump makes stale entries unreachable —
//   save1:<worldKey>
// — and the bump ships with a changelog line here when it happens.
//
// The envelope version `v` is the HANDOVER idiom on top: a payload whose
// `v` this build does not speak is declined WHOLE (never guessed at).

export const WORLD_SAVE_V = 1;
const DB_NAME = "world-lab-saves";
const STORE = "saves";

export interface WorldSaveRecord {
  /** The scope this record IS (deterministic keys — site key, body id). */
  id: string;
  /** Dispatch key. Unrecognized kinds are carried, never dropped. */
  kind: string;
  /** Kind-owned plain data (rung-specific SHAPE, generic INDEX). */
  payload: unknown;
  /** Optional per-record wall-ms quote stamp (the checkout seam). */
  at?: number;
}

export interface WorldSave {
  v: number;
  /** Wall-clock ms at save — the absence gap's anchor (ruling ②). */
  savedAt: number;
  worldKey: string;
  records: WorldSaveRecord[];
}

/**
 * ⚖️ RESERVED KINDS (persistence P2 — typed slots, producers unwired):
 * when their producing rounds land, these kinds join the same table —
 * never new envelope fields. The carry-through law above already keeps
 * them safe across builds that predate their producers.
 *   "town-deltas"        — a non-founded city's SerializedTownDeltas
 *                          (needs the loader's deltas restore door)
 *   "polities"           — SerializedPolities (planet/polities.ts)
 *   "resolutions-hwm"    — applyResolutions' high-water integer
 *   "interventions"      — StateIntervention[] (the Markov channel)
 *   "memories"           — DestinyMemory[] with Infinity spelled null
 */
export const RESERVED_SAVE_KINDS = [
  "town-deltas", "polities", "resolutions-hwm", "interventions", "memories",
] as const;

/** The founded-site kind's payload: the engine's durable record plus the
 *  planet address world-lab keys it by. */
export interface FoundedSitePayload {
  cell: number;
  bodyId: string;
  dir: [number, number, number];
  surfaceR: number;
  site: unknown; // SerializedFoundedSite — validated by createFoundedSite's caller
}

/** The felled-marks kind's payload: one body's stump ledger, at rest.
 *  `remainS` = seconds of regrowth left when saved; null = permanent
 *  (Infinity is not JSON — the null spelling is the envelope's law). */
export interface FelledMarksPayload {
  bodyId: string;
  marks: Array<{ key: string; remainS: number | null }>;
}

const openDb = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null); // private mode / quota / no IDB — no save is fine
    }
  });

/** Light structural gate — a corrupt save is a MISS, never a throw. The
 *  per-kind payloads are validated by their consumers (the engine's own
 *  readers); this checks only the envelope. */
function readWorldSave(x: unknown): WorldSave | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  if (s.v !== WORLD_SAVE_V) return null; // foreign version: declined whole
  if (typeof s.savedAt !== "number" || !Number.isFinite(s.savedAt)) return null;
  if (typeof s.worldKey !== "string") return null;
  if (!Array.isArray(s.records)) return null;
  const records: WorldSaveRecord[] = [];
  for (const raw of s.records) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.kind !== "string") return null;
    const rec: WorldSaveRecord = { id: r.id, kind: r.kind, payload: r.payload };
    if (typeof r.at === "number" && Number.isFinite(r.at)) rec.at = r.at;
    records.push(rec);
  }
  return { v: WORLD_SAVE_V, savedAt: s.savedAt, worldKey: s.worldKey, records };
}

export async function loadWorldSave(worldKey: string): Promise<WorldSave | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(`save${WORLD_SAVE_V}:${worldKey}`);
      req.onsuccess = () => resolve(readWorldSave(req.result));
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Delete one world's save — the RESET path (user 2026-08-27: "Add an
 *  option to reset the local store"). Same failure discipline: a failed
 *  delete resolves quietly; the caller clears in-memory state and reboots
 *  either way, and the autosave writes nothing while memory is empty. */
export async function deleteWorldSave(worldKey: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(`save${WORLD_SAVE_V}:${worldKey}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Fire-and-forget put — a failed write costs one autosave, never play. */
export async function putWorldSave(save: WorldSave): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(save, `save${WORLD_SAVE_V}:${save.worldKey}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
