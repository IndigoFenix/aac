/**
 * Session recording — capture a session to the DEVICE as two synchronized
 * video files (the student on camera, and the app's own screen), so promotional
 * material can be cut from real sessions.
 *
 * Stored as one jsonb object on `aac_settings.session_recording`, following the
 * `venue_menus` / `home_actions` precedent: one settings OBJECT read through
 * `normalizeSessionRecordingSettings` and never raw, rather than N booleans
 * sprayed across the table.
 *
 * SCOPE AND PRIVACY. Everything here describes files written to the local disk
 * of the device the student is sitting at. Nothing in this feature uploads,
 * streams, or otherwise transmits a frame — no server route consumes these
 * files and the recorder has no network path at all. That is deliberate: a
 * continuous video of a child is the most sensitive artifact the platform can
 * produce, and keeping it device-local keeps it outside the PHI-transit surface
 * docs/SECURITY_ARCHITECTURE.md governs. Getting footage off the device is a
 * human copying files out of a folder — a deliberate act by a caretaker.
 *
 * These settings are deliberately EXCLUDED from the AI-editable whitelists in
 * `server/services/memory-schema/aac-settings-memory-schema.ts`. The AI must
 * never be able to start a camera recording of a student.
 *
 * The mechanics live elsewhere — electron/hardware/recording-store.ts writes
 * the files, client-aac/src/lib/session-recorder drives the encoders. This
 * module is only the policy both sides agree on.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Capture resolution for the camera file. The screen file always follows the
 * app window's own pixel size — upscaling a UI is pointless and downscaling it
 * smears the board text, which is the one thing a promo clip must show clearly.
 *
 * `max` asks the camera for whatever it will give; `720p`/`1080p` name a
 * ceiling. The camera is SHARED with face tracking and the Observer's frame
 * grid (see useMultiCamera), so raising this raises their cost too — which is
 * why 720p, today's acquisition default and therefore no change at all, is the
 * default here.
 */
export type RecordingQuality = "720p" | "1080p" | "max";

export interface SessionRecordingSettings {
  /** Master switch. Everything else is inert while this is false. */
  enabled: boolean;

  /** Camera capture ceiling. See {@link RecordingQuality}. */
  quality: RecordingQuality;

  /**
   * Seconds of footage kept from BEFORE the first interaction of a clip.
   *
   * The interesting part of a session is a child deciding to engage, and that
   * happens entirely before the button press the recorder would otherwise
   * treat as the start. The encoders therefore run continuously while the
   * feature is on, and a clip opens with this much already in hand. 0 disables
   * the pre-roll, and with it the idle encoding cost.
   */
  preRollSeconds: number;

  /**
   * Seconds of quiet after the last interaction before the clip closes. Long
   * enough to bridge a child's thinking pause, short enough that a device left
   * running alone stops filling the disk.
   */
  idleTailSeconds: number;

  /**
   * Hard cap on a single clip, in minutes. Continuous activity past this rolls
   * into a new numbered clip, so one long session yields several editable
   * files instead of one unmanageable pair — and the eviction sweep below gets
   * something granular to delete.
   */
  maxClipMinutes: number;

  /**
   * Disk budget for the whole recording folder, in megabytes. When a finished
   * clip pushes the folder over, the OLDEST clips are deleted whole (camera +
   * screen + manifest together) until it fits again.
   */
  maxStorageMb: number;

  /**
   * Absolute folder the clips are written to. Null means the shell default (a
   * `recordings` folder under the app's user-data directory). Pointing this at
   * an external drive is the expected way to keep more than the local disk
   * budget allows.
   */
  folder: string | null;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const PRE_ROLL_SECONDS_MIN = 0;
export const PRE_ROLL_SECONDS_MAX = 60;
export const PRE_ROLL_SECONDS_DEFAULT = 10;

export const IDLE_TAIL_SECONDS_MIN = 5;
export const IDLE_TAIL_SECONDS_MAX = 600;
export const IDLE_TAIL_SECONDS_DEFAULT = 30;

export const MAX_CLIP_MINUTES_MIN = 1;
export const MAX_CLIP_MINUTES_MAX = 60;
export const MAX_CLIP_MINUTES_DEFAULT = 10;

/** 1 GB floor — below that a single clip could evict everything before it. */
export const MAX_STORAGE_MB_MIN = 1024;
export const MAX_STORAGE_MB_MAX = 1024 * 500; // 500 GB
export const MAX_STORAGE_MB_DEFAULT = 1024 * 20; // 20 GB

const QUALITIES: readonly RecordingQuality[] = ["720p", "1080p", "max"];

export const DEFAULT_SESSION_RECORDING: SessionRecordingSettings = {
  enabled: false,
  quality: "720p",
  preRollSeconds: PRE_ROLL_SECONDS_DEFAULT,
  idleTailSeconds: IDLE_TAIL_SECONDS_DEFAULT,
  maxClipMinutes: MAX_CLIP_MINUTES_DEFAULT,
  maxStorageMb: MAX_STORAGE_MB_DEFAULT,
  folder: null,
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  // ABSENT is not ZERO. `Number(null)`, `Number("")` and `Number(false)` are
  // all 0, which is finite — so coercing first would silently clamp a missing
  // field to the MINIMUM instead of the default, handing a half-written column
  // a 1 GB disk budget and a 1-minute clip cap. Absence is decided before any
  // arithmetic happens.
  if (raw === null || raw === undefined || typeof raw === "boolean") return fallback;
  if (typeof raw === "string" && !raw.trim()) return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * The one sanitization chokepoint. Every reader — the clinician editor, the
 * client hook, the Electron store — goes through this, so a hand-edited or
 * half-migrated column can never hand anyone a partial object.
 */
export function normalizeSessionRecordingSettings(raw: unknown): SessionRecordingSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const quality = QUALITIES.includes(o.quality as RecordingQuality)
    ? (o.quality as RecordingQuality)
    : DEFAULT_SESSION_RECORDING.quality;

  // A folder is only meaningful as a non-empty path; anything else falls back
  // to the shell default rather than creating an empty-named directory.
  const folderRaw = typeof o.folder === "string" ? o.folder.trim() : "";

  return {
    enabled: o.enabled === true,
    quality,
    preRollSeconds: clampInt(
      o.preRollSeconds, PRE_ROLL_SECONDS_MIN, PRE_ROLL_SECONDS_MAX, PRE_ROLL_SECONDS_DEFAULT,
    ),
    idleTailSeconds: clampInt(
      o.idleTailSeconds, IDLE_TAIL_SECONDS_MIN, IDLE_TAIL_SECONDS_MAX, IDLE_TAIL_SECONDS_DEFAULT,
    ),
    maxClipMinutes: clampInt(
      o.maxClipMinutes, MAX_CLIP_MINUTES_MIN, MAX_CLIP_MINUTES_MAX, MAX_CLIP_MINUTES_DEFAULT,
    ),
    maxStorageMb: clampInt(
      o.maxStorageMb, MAX_STORAGE_MB_MIN, MAX_STORAGE_MB_MAX, MAX_STORAGE_MB_DEFAULT,
    ),
    folder: folderRaw ? folderRaw : null,
  };
}

/**
 * Video constraints for the camera track at a given quality. Applied to the
 * SHARED camera track via `applyConstraints` — never a fresh `getUserMedia`,
 * which would be a second capture of the same device.
 */
export function cameraConstraintsFor(quality: RecordingQuality): MediaTrackConstraints {
  switch (quality) {
    case "max":
      // No ceiling: ask for something large and let the device cap it.
      return { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } };
    case "1080p":
      return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    case "720p":
    default:
      return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  }
}

/** Target video bitrate for the camera encoder, in bits per second. */
export function cameraBitrateFor(quality: RecordingQuality): number {
  switch (quality) {
    case "max": return 16_000_000;
    case "1080p": return 8_000_000;
    case "720p":
    default: return 4_000_000;
  }
}

/**
 * Target video bitrate for the screen encoder. The app window is mostly flat
 * colour, which compresses far better than camera noise — but text edges are
 * exactly what must not smear, so this stays generous.
 */
export const SCREEN_BITRATE_BPS = 8_000_000;

/** Audio bitrate for the room mic on the camera file. */
export const AUDIO_BITRATE_BPS = 128_000;

// ---------------------------------------------------------------------------
// Storage budget
// ---------------------------------------------------------------------------

/** One finished clip on disk, as the eviction planner sees it. */
export interface StoredClip {
  /** Clip id — names all three files of the clip. */
  id: string;
  /** Wall-clock start, for oldest-first ordering. */
  startedAtMs: number;
  /** Total bytes of every file belonging to this clip. */
  bytes: number;
}

export interface EvictionPlan {
  /** Clip ids to delete, oldest first. */
  deleteIds: string[];
  /**
   * Bytes still over budget after every deletion above — 0 when the plan
   * succeeds. Non-zero means even a lone clip exceeds the budget, which the
   * caller surfaces rather than deleting the only footage it just captured.
   */
  shortfallBytes: number;
}

/**
 * Decide which clips to drop so the folder fits its budget.
 *
 * `protectedIds` are never considered — the clip currently being written lives
 * there, so a long recording cannot delete itself out from under the encoder.
 * The NEWEST clip is likewise never deleted: a budget too small for one clip is
 * a misconfiguration to report, not a reason to leave the caretaker with
 * nothing at all.
 */
export function planEviction(
  clips: readonly StoredClip[],
  maxBytes: number,
  protectedIds: readonly string[] = [],
): EvictionPlan {
  const total = clips.reduce((sum, c) => sum + c.bytes, 0);
  if (total <= maxBytes) return { deleteIds: [], shortfallBytes: 0 };

  const guarded = new Set(protectedIds);
  const oldestFirst = [...clips].sort((a, b) => a.startedAtMs - b.startedAtMs);
  // Whatever sorts last is the newest clip — keep it whatever happens.
  const newest = oldestFirst[oldestFirst.length - 1];
  if (newest) guarded.add(newest.id);

  const deleteIds: string[] = [];
  let remaining = total;
  for (const clip of oldestFirst) {
    if (remaining <= maxBytes) break;
    if (guarded.has(clip.id)) continue;
    deleteIds.push(clip.id);
    remaining -= clip.bytes;
  }

  return {
    deleteIds,
    shortfallBytes: remaining > maxBytes ? remaining - maxBytes : 0,
  };
}

// ---------------------------------------------------------------------------
// On-disk shapes (shared by the Electron store and the renderer)
// ---------------------------------------------------------------------------

/** Which of a clip's two video files a chunk belongs to. */
export type RecordingTrack = "camera" | "screen";

/**
 * A point where both timelines are known simultaneously: `t` is the offset
 * into the file's own media timeline, `wall` the wall clock at that instant.
 *
 * The two encoders start in the same event-loop turn, so their files are
 * already aligned to within a frame — but MediaRecorder gives no guarantee
 * about when each encoder actually saw its first frame, and long clips drift.
 * Every chunk boundary is an instant that IS known in both timelines, so the
 * recorder writes one of these per chunk into the manifest. An editor can then
 * align the two files exactly instead of hunting for a clap.
 */
export interface SyncMark {
  /** Milliseconds since this file's own recording started. */
  t: number;
  /** `Date.now()` at that instant. */
  wall: number;
}

/** The `.json` sidecar written next to each clip's two video files. */
export interface RecordingManifest {
  clipId: string;
  /** Schema version, so a later reader can tell old sidecars apart. */
  version: 1;
  studentId: string | null;
  sessionId: string | null;
  /** `Date.now()` when the clip opened (the START of the pre-roll). */
  startedAtMs: number;
  /** `Date.now()` when the clip closed. */
  endedAtMs: number;
  /** Wall clock of the interaction that opened the clip — the pre-roll covers
   *  `startedAtMs .. triggeredAtMs`, so an editor knows where the lead-in ends. */
  triggeredAtMs: number;
  /** Why the clip ended: idle tail expired, length cap, or session teardown. */
  endReason: "idle" | "rotated" | "stopped";
  quality: RecordingQuality;
  tracks: Partial<Record<RecordingTrack, {
    file: string;
    mimeType: string;
    bytes: number;
    width: number | null;
    height: number | null;
    syncMarks: SyncMark[];
  }>>;
}
