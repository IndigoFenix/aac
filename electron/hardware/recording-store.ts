/**
 * Session-recording file store (main process).
 *
 * The renderer owns the encoders (two MediaRecorders — camera and app window)
 * and streams their chunks here; this module is the only thing that touches
 * the disk. It keeps one folder of CLIPS, where a clip is its OWN FOLDER
 * holding three files:
 *
 *   20260820-141233-a4f1/
 *     20260820-141233-a4f1.camera.webm    ← the student, with the room mic
 *     20260820-141233-a4f1.screen.webm    ← the app window, with the app's sound
 *     20260820-141233-a4f1.json           ← manifest, incl. the sync marks
 *
 * A clip is the unit of everything: it is written whole, deleted whole, and
 * counted whole against the disk budget — so it is one directory, and the three
 * files that only make sense together cannot be separated by a careless copy.
 * The id stays on each filename anyway, because files DO get copied out into an
 * editor's bin where the folder that explained them is gone.
 *
 * Clips written before that layout existed sit loose in the root; they are
 * still inventoried, listed and evicted, just never created any more.
 *
 * ── Finalizing ──
 * A MediaRecorder's WebM has no duration, no cluster sizes and no cue index —
 * it cannot, since it is written as it goes. Most players respond by refusing
 * to seek and showing a dead timer bar. So a finished clip is rewritten once,
 * by webm-finalize.ts, before its manifest is written. That is a full pass over
 * the clip and is deliberately NOT on the path of anything the child is doing:
 * the renderer restarts its pre-roll encoders before it asks for a finish.
 *
 * The renderer cannot be trusted to close what it opens — a crashed or reloaded
 * renderer leaves streams dangling — so every open handle is closed on
 * `before-quit`, and a startup sweep finalizes clips left half-written by a
 * previous run (their manifest is missing, so they are reconstructed from the
 * files that survived rather than deleted; a truncated webm still plays up to
 * the last complete cluster).
 *
 * Nothing here is reachable from the network. There is no upload path.
 */

import { app, ipcMain, shell } from "electron";
import fs from "fs";
import path from "path";
import log from "electron-log";
import { finalizeWebmFile } from "./webm-finalize.js";
import {
  MAX_AGE_DAYS_DEFAULT,
  MAX_STORAGE_MB_DEFAULT,
  planEviction,
  planStudentPurge,
  type PurgeCandidate,
  type RecordingManifest,
  type RecordingTrack,
  type StoredClip,
} from "../../shared/aac/session-recording.js";

const TRACKS: readonly RecordingTrack[] = ["camera", "screen"];

/** Ids we generate. Anything else is refused — the id names a directory. */
const CLIP_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

/**
 * Default recording folder. `videos` rather than `userData` on purpose: the
 * whole point of these files is that a human copies them off the device, and
 * nobody finds their way into %APPDATA%\<app>\... unaided.
 */
function defaultFolder(): string {
  try {
    return path.join(app.getPath("videos"), "Aivota AAC Recordings");
  } catch {
    // `videos` is unavailable on some minimal Windows profiles.
    return path.join(app.getPath("userData"), "recordings");
  }
}

/** Where clips go. Set per-request from the student's settings; falls back to
 *  the default when the configured path is blank or unusable. */
let activeFolder: string | null = null;

/**
 * Folders that would silently turn "device-only" footage into an upload: UNC
 * network shares, and the sync roots of the usual cloud drives. A clinician
 * pasting `C:\Users\me\OneDrive\Recordings` into the settings box is exactly
 * the mistake this exists to catch.
 */
const SYNC_FOLDER_SEGMENT = /^(onedrive|onedrive - .*|dropbox|google drive|googledrive|my drive|icloud drive|icloudrive|box|box sync|nextcloud|sync)$/i;

export function isDisallowedRecordingFolder(folder: string): string | null {
  if (/^\\\\/.test(folder) || /^\/\//.test(folder)) return "network-share";
  const segments = folder.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => SYNC_FOLDER_SEGMENT.test(s.trim()))) return "cloud-sync";
  return null;
}

function resolveFolder(configured: unknown): string {
  let wanted = typeof configured === "string" && configured.trim()
    ? configured.trim()
    : defaultFolder();
  const disallowed = isDisallowedRecordingFolder(wanted);
  if (disallowed) {
    log.warn(`[recording] configured folder refused (${disallowed}) — falling back to the default`);
    wanted = defaultFolder();
  }
  try {
    fs.mkdirSync(wanted, { recursive: true });
    activeFolder = wanted;
    return wanted;
  } catch (err) {
    log.warn(`[recording] cannot use folder ${wanted} (${String(err)}) — falling back`);
    const fallback = defaultFolder();
    fs.mkdirSync(fallback, { recursive: true });
    activeFolder = fallback;
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Open clips
// ---------------------------------------------------------------------------

interface OpenTrack {
  stream: fs.WriteStream;
  file: string;
  bytes: number;
  /** Set once a write fails; further appends are dropped rather than throwing
   *  at the renderer mid-session (a disk-full clip should end, not crash). */
  failed: boolean;
}

interface OpenClip {
  id: string;
  /** The recordings root. */
  folder: string;
  /** This clip's own directory inside it. */
  dir: string;
  openedAtMs: number;
  tracks: Map<RecordingTrack, OpenTrack>;
}

const openClips = new Map<string, OpenClip>();

/** The clip's own directory under the recordings root. */
function clipDir(folder: string, id: string): string {
  return path.join(folder, id);
}

function clipFile(dir: string, id: string, track: RecordingTrack): string {
  return path.join(dir, `${id}.${track}.webm`);
}

function manifestFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function openTrack(clip: OpenClip, track: RecordingTrack): OpenTrack | null {
  const existing = clip.tracks.get(track);
  if (existing) return existing;
  const file = clipFile(clip.dir, clip.id, track);
  try {
    const stream = fs.createWriteStream(file, { flags: "w" });
    const entry: OpenTrack = { stream, file, bytes: 0, failed: false };
    stream.on("error", (err) => {
      entry.failed = true;
      log.error(`[recording] write failed for ${file}: ${String(err)}`);
    });
    clip.tracks.set(track, entry);
    return entry;
  } catch (err) {
    log.error(`[recording] cannot open ${file}: ${String(err)}`);
    return null;
  }
}

function closeTrack(entry: OpenTrack): Promise<void> {
  return new Promise((resolve) => {
    entry.stream.end(() => resolve());
    // `end` can hang if the stream already errored — never block teardown on it.
    entry.stream.on("error", () => resolve());
  });
}

async function closeClip(clip: OpenClip): Promise<void> {
  for (const entry of clip.tracks.values()) await closeTrack(entry);
}

// ---------------------------------------------------------------------------
// Folder inventory + eviction
// ---------------------------------------------------------------------------

interface InventoryEntry extends StoredClip {
  files: string[];
  /** The clip's own directory, or null for a clip from the old flat layout. */
  dir: string | null;
  hasManifest: boolean;
}

/** A clip's video file, wherever it lives. */
const CLIP_VIDEO_NAME = /^(\d{8}-\d{6}-[a-z0-9]{4})\.(camera|screen)\.webm$/;
const CLIP_MANIFEST_NAME = /^(\d{8}-\d{6}-[a-z0-9]{4})\.json$/;

/**
 * Everything in the folder, grouped into clips.
 *
 * Grouping is by NAME, not by manifest, so a clip whose manifest never got
 * written (renderer crash, power loss) is still counted against the budget and
 * still evictable. Otherwise a run of crashes would leave orphaned gigabytes
 * that the sweep could never see.
 *
 * Both layouts are read: a clip directory, and the loose files clips used to be
 * written as. The old ones are never created again, but they are somebody's
 * footage and must keep being listed and evicted like any other.
 */
async function inventory(folder: string): Promise<InventoryEntry[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }

  const byId = new Map<string, InventoryEntry>();
  const note = async (id: string, full: string, dir: string | null): Promise<void> => {
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = await fs.promises.stat(full);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      return;
    }
    const entry = byId.get(id) ?? {
      id,
      // Parsed from the id itself — the id is minted from wall clock, so it
      // orders correctly even when a manifest is missing. mtime is the backstop.
      startedAtMs: parseClipIdTime(id) ?? mtimeMs,
      bytes: 0,
      files: [],
      dir,
      hasManifest: false,
    };
    entry.bytes += size;
    entry.files.push(full);
    if (full.endsWith(".json")) entry.hasManifest = true;
    byId.set(id, entry);
  };

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!CLIP_ID_PATTERN.test(entry.name)) continue;
      const dir = path.join(folder, entry.name);
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!CLIP_VIDEO_NAME.test(name) && !CLIP_MANIFEST_NAME.test(name)) continue;
        await note(entry.name, path.join(dir, name), dir);
      }
      continue;
    }
    const m = CLIP_VIDEO_NAME.exec(entry.name) ?? CLIP_MANIFEST_NAME.exec(entry.name);
    if (!m) continue;
    await note(m[1], path.join(folder, entry.name), null);
  }
  return [...byId.values()];
}

/** `20260820-141233-a4f1` → epoch ms, in LOCAL time (that's how it was minted). */
function parseClipIdTime(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Delete whole clips — every file of each, then the clip's own directory.
 *
 * A clip is only reported deleted when every one of its files went; a partial
 * delete stays counted so the next pass tries again rather than leaving footage
 * behind that nothing believes is there. The directory is removed
 * non-recursively and only after the files, so anything a person put in there
 * themselves survives instead of being swept away with the footage.
 */
async function deleteClips(
  clips: readonly InventoryEntry[],
  ids: Iterable<string>,
): Promise<{ deleted: string[]; bytes: number }> {
  const deleted: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    const entry = clips.find((c) => c.id === id);
    if (!entry) continue;
    let ok = true;
    for (const file of entry.files) {
      try {
        await fs.promises.unlink(file);
      } catch (err) {
        ok = false;
        log.warn(`[recording] could not delete ${file}: ${String(err)}`);
      }
    }
    if (ok && entry.dir) {
      try {
        await fs.promises.rmdir(entry.dir);
      } catch (err) {
        log.warn(`[recording] could not remove ${entry.dir}: ${String(err)}`);
      }
    }
    if (ok) {
      deleted.push(id);
      bytes += entry.bytes;
    }
  }
  return { deleted, bytes };
}

export interface SweepResult {
  totalBytes: number;
  clipCount: number;
  deletedIds: string[];
  /** Bytes still over budget after evicting everything evictable. */
  shortfallBytes: number;
}

/**
 * Bring the folder back under its budget by deleting whole clips, oldest first.
 * Clips currently being written are protected, as is the newest clip — see
 * `planEviction`.
 */
async function sweep(folder: string, maxStorageMb: number, maxAgeDays?: number): Promise<SweepResult> {
  const clips = await inventory(folder);
  const maxBytes = Math.max(0, Math.round(maxStorageMb)) * 1024 * 1024;
  const plan = planEviction(clips, maxBytes, [...openClips.keys()]);

  // Age-based retention runs BEFORE the budget and is not subject to the
  // "keep the newest clip" protection: a recording of a child older than the
  // retention window goes, full stop. Clips still being written are never
  // touched (they are, by definition, not old).
  const deleteIds = new Set(plan.deleteIds);
  if (maxAgeDays && Number.isFinite(maxAgeDays) && maxAgeDays > 0) {
    const cutoff = Date.now() - Math.round(maxAgeDays) * 24 * 60 * 60 * 1000;
    for (const c of clips) {
      if (openClips.has(c.id)) continue;
      if (c.startedAtMs < cutoff) deleteIds.add(c.id);
    }
  }

  const { deleted } = await deleteClips(clips, deleteIds);
  if (deleted.length) {
    log.info(`[recording] evicted ${deleted.length} clip(s) to stay under ${maxStorageMb} MB`);
  }

  const after = await inventory(folder);
  return {
    totalBytes: after.reduce((sum, c) => sum + c.bytes, 0),
    clipCount: after.length,
    deletedIds: deleted,
    shortfallBytes: plan.shortfallBytes,
  };
}

// ---------------------------------------------------------------------------
// Retention: last-known settings, and the timer that applies them
// ---------------------------------------------------------------------------

/**
 * The sweep's inputs, kept on disk.
 *
 * Age retention is a promise about how long a video of a child may sit on a
 * device, and until now the only thing that could keep it was the recorder
 * running again: `sweep` was reachable from `recording:prepare` and
 * `recording:finish` and nowhere else. A device that recorded a term's worth of
 * sessions and was then set aside — the student moved, the feature was turned
 * off, the app is simply open on the board screen — kept every clip forever.
 *
 * So the settings the renderer last normalized are persisted here (a small
 * JSON beside the device id in userData, matching that file's precedent — there
 * is no electron-store in this app), and the timer below reads them without
 * needing a renderer, a logged-in student, or a network.
 */
interface PersistedSweepSettings {
  folder: string | null;
  maxStorageMb: number;
  maxAgeDays: number;
  savedAtMs: number;
}

function sweepSettingsFile(): string {
  return path.join(app.getPath("userData"), "recording-sweep.json");
}

function rememberSweepSettings(folder: string | null, maxStorageMb: number, maxAgeDays: number): void {
  const next: PersistedSweepSettings = { folder, maxStorageMb, maxAgeDays, savedAtMs: Date.now() };
  // Fire-and-forget: nothing the recorder does may wait on this write, and a
  // failure only costs the NEXT unattended sweep its tuning, not this one.
  void fs.promises
    .writeFile(sweepSettingsFile(), JSON.stringify(next, null, 2), "utf8")
    .catch((err) => log.warn(`[recording] could not persist sweep settings: ${String(err)}`));
}

/** Last-known settings, or the shared defaults when nothing was ever saved. */
async function loadSweepSettings(): Promise<PersistedSweepSettings> {
  const fallback: PersistedSweepSettings = {
    folder: null,
    maxStorageMb: MAX_STORAGE_MB_DEFAULT,
    maxAgeDays: MAX_AGE_DAYS_DEFAULT,
    savedAtMs: 0,
  };
  try {
    const raw = JSON.parse(await fs.promises.readFile(sweepSettingsFile(), "utf8")) as unknown;
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      folder: typeof o.folder === "string" && o.folder.trim() ? o.folder.trim() : null,
      maxStorageMb: typeof o.maxStorageMb === "number" && Number.isFinite(o.maxStorageMb)
        ? o.maxStorageMb : fallback.maxStorageMb,
      maxAgeDays: typeof o.maxAgeDays === "number" && Number.isFinite(o.maxAgeDays)
        ? o.maxAgeDays : fallback.maxAgeDays,
      savedAtMs: typeof o.savedAtMs === "number" ? o.savedAtMs : 0,
    };
  } catch {
    // Never saved, or unreadable. The defaults are the conservative answer:
    // 30 days, 20 GB — the same numbers a fresh install would sweep with.
    return fallback;
  }
}

/** How often the unattended sweep runs while the app is open. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Run one unattended sweep against the last-known settings.
 *
 * Deliberately total: an app that cannot prune its recordings folder must still
 * be an app a child can talk through, so every failure here is logged and
 * swallowed. `resolveFolder` is not used — it MKDIRS, and an unattended sweep
 * has no business creating a recordings folder on a device that has never
 * recorded (nor re-pointing `activeFolder` out from under a live clip).
 */
async function sweepUnattended(): Promise<void> {
  try {
    const settings = await loadSweepSettings();
    let folder = activeFolder;
    if (!folder) {
      const wanted = settings.folder ?? defaultFolder();
      // A folder the settings chokepoint would refuse today (someone moved the
      // path into OneDrive since) is not a folder to go deleting inside.
      if (settings.folder && isDisallowedRecordingFolder(wanted)) return;
      try {
        await fs.promises.stat(wanted);
      } catch {
        return; // Nothing has ever been recorded here.
      }
      folder = wanted;
    }
    const result = await sweep(folder, settings.maxStorageMb, settings.maxAgeDays);
    if (result.deletedIds.length) {
      log.info(
        `[recording] scheduled sweep removed ${result.deletedIds.length} clip(s) ` +
        `past ${settings.maxAgeDays}d / ${settings.maxStorageMb} MB`,
      );
    }
  } catch (err) {
    log.warn(`[recording] scheduled sweep failed: ${String(err)}`);
  }
}

/**
 * Start the retention timer: once at startup, then every six hours.
 *
 * Six hours rather than daily because the window a clip can outlive its
 * retention by is what this bounds, and rather than hourly because the sweep
 * stats every file in the folder — on an external drive holding a term of
 * footage that is not free.
 */
function startSweepTimer(): void {
  if (sweepTimer) return;
  void sweepUnattended();
  sweepTimer = setInterval(() => { void sweepUnattended(); }, SWEEP_INTERVAL_MS);
  // Never be the reason the process stays alive.
  sweepTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Erasure purge
// ---------------------------------------------------------------------------

/**
 * A clip's manifest `studentId`, or null when there is no readable manifest.
 *
 * `folder` is the root actually being inventoried and must be passed in, not
 * re-derived: a clip from the OLD FLAT LAYOUT has no directory of its own, so
 * its manifest is `<root>/<id>.json`, and re-deriving the root from
 * `activeFolder` would look in the wrong place on exactly the path this
 * feature exists for — a purge on a device that has not recorded this run, so
 * `activeFolder` is still null and the root came from the persisted settings.
 * The clip would then read as unattributable and quietly survive the erasure
 * it was named in.
 */
async function readClipStudentId(entry: InventoryEntry, folder: string): Promise<string | null> {
  const file = manifestFile(entry.dir ?? folder, entry.id);
  try {
    const raw = JSON.parse(await fs.promises.readFile(file, "utf8")) as Partial<RecordingManifest>;
    return typeof raw.studentId === "string" && raw.studentId ? raw.studentId : null;
  } catch {
    return null;
  }
}

export interface PurgeResult {
  clipIds: string[];
  bytes: number;
}

/**
 * Delete this device's footage of one student.
 *
 * This is the arm of erasure that reaches the disk. It runs on a signal from
 * the server (the relay's `purge_recordings`) and, crucially, ALSO on the
 * client noticing that the student's profile has become definitively
 * unreachable — because the device that most needs purging is the one that was
 * switched off when the erasure happened and never heard the message.
 *
 * Best-effort, and the selection rule says why: see `planStudentPurge` in
 * shared/aac/session-recording.ts. A clip whose manifest never got a studentId
 * cannot be attributed, so it goes only once it is past retention anyway.
 *
 * LEGACY FLAT CLIPS are in scope on the same terms as any other. `inventory`
 * returns them (loose files in the root, no directory of their own), and one
 * that still has its `<id>.json` is matched by NAME like anything else — the
 * old layout wrote the same manifest, just beside the videos instead of under
 * them. One with no readable manifest has no studentId to match, so it falls
 * to the orphan rule and goes only once past retention. That is the same
 * treatment a crash-recovered clip gets, and for the same reason: deleting
 * every unattributable clip outright would destroy footage of a different,
 * still-enrolled child.
 */
export async function purgeStudentRecordings(studentId: string): Promise<PurgeResult> {
  const id = typeof studentId === "string" ? studentId.trim() : "";
  if (!id) return { clipIds: [], bytes: 0 };

  const settings = await loadSweepSettings();
  const folder = activeFolder ?? settings.folder ?? defaultFolder();
  try {
    await fs.promises.stat(folder);
  } catch {
    return { clipIds: [], bytes: 0 }; // Nothing was ever recorded on this device.
  }

  const clips = await inventory(folder);
  const candidates: PurgeCandidate[] = [];
  for (const clip of clips) {
    candidates.push({
      id: clip.id,
      startedAtMs: clip.startedAtMs,
      bytes: clip.bytes,
      studentId: await readClipStudentId(clip, folder),
    });
  }

  const plan = planStudentPurge(candidates, {
    studentId: id,
    retentionDays: settings.maxAgeDays,
    nowMs: Date.now(),
    // A clip being written right now is not deleted out from under its encoder;
    // it closes normally and the NEXT purge or sweep takes it.
    protectedIds: [...openClips.keys()],
  });

  const { deleted, bytes } = await deleteClips(clips, plan.clipIds);
  if (deleted.length) {
    log.info(`[recording] purged ${deleted.length} clip(s) (${bytes} bytes) for an erased student`);
  }
  return { clipIds: deleted, bytes };
}

/**
 * Delete half-written finalizer temp files.
 *
 * The finalizer cleans up after itself, but it cannot if the process is killed
 * mid-rewrite. What is left is a partial copy of a clip that nothing counts
 * against the disk budget — the original is untouched and still the real file,
 * so the copy is pure waste.
 */
async function removeStaleTempFiles(folder: string): Promise<void> {
  const sweepDir = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && dir === folder && CLIP_ID_PATTERN.test(entry.name)) {
        await sweepDir(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".finalizing")) continue;
      try {
        await fs.promises.unlink(path.join(dir, entry.name));
        log.info(`[recording] removed stale ${entry.name}`);
      } catch { /* someone else's, or already gone */ }
    }
  };
  await sweepDir(folder);
}

/**
 * Reconstruct manifests for clips a previous run left without one, so they can
 * still be identified in an editor. The video files are kept: a webm truncated
 * mid-cluster still plays up to its last complete one, and this footage is not
 * reproducible.
 */
async function recoverOrphans(folder: string): Promise<number> {
  const clips = await inventory(folder);
  let recovered = 0;
  for (const clip of clips) {
    if (clip.hasManifest) continue;
    const dir = clip.dir ?? folder;
    const tracks: RecordingManifest["tracks"] = {};
    for (const track of TRACKS) {
      const file = clipFile(dir, clip.id, track);
      try {
        await fs.promises.stat(file);
      } catch {
        continue; // Track absent — a clip can legitimately have only one.
      }
      // These files were cut off mid-write by whatever ended the last run, so
      // this is also where they get their duration and cue index. The finalizer
      // drops the incomplete tail and keeps everything before it.
      const finalized = await finalizeWebmFile(file);
      try {
        const st = await fs.promises.stat(file);
        tracks[track] = {
          file: path.basename(file),
          mimeType: "video/webm",
          bytes: st.size,
          width: null,
          height: null,
          durationMs: finalized.durationMs ?? null,
          syncMarks: [],
        };
      } catch {
        // Vanished between the two stats — nothing to record.
      }
    }
    if (!Object.keys(tracks).length) continue;
    const manifest: RecordingManifest = {
      clipId: clip.id,
      version: 1,
      studentId: null,
      sessionId: null,
      startedAtMs: clip.startedAtMs,
      endedAtMs: clip.startedAtMs,
      triggeredAtMs: clip.startedAtMs,
      endReason: "stopped",
      quality: "720p",
      tracks,
    };
    try {
      await fs.promises.writeFile(
        manifestFile(clip.dir ?? folder, clip.id), JSON.stringify(manifest, null, 2), "utf8",
      );
      recovered++;
    } catch (err) {
      log.warn(`[recording] could not write recovery manifest for ${clip.id}: ${String(err)}`);
    }
  }
  if (recovered) log.info(`[recording] recovered ${recovered} interrupted clip(s)`);
  return recovered;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/** Register the recording IPC surface. Call once, after `app.whenReady()`. */
export function setupRecordingStore(): void {
  /** Prepare (and report on) the folder. The renderer calls this before it
   *  starts encoding, so a bad path fails loudly at setup rather than mid-clip. */
  ipcMain.handle("recording:prepare", async (_e, opts: unknown) => {
    const o = (opts ?? {}) as { folder?: unknown; maxStorageMb?: unknown; maxAgeDays?: unknown };
    const folder = resolveFolder(o.folder);
    await removeStaleTempFiles(folder);
    await recoverOrphans(folder);
    const maxStorageMb = typeof o.maxStorageMb === "number" ? o.maxStorageMb : 20480;
    // A renderer that predates the setting sends no maxAgeDays; fall back to
    // the shared default rather than to "keep forever".
    const maxAgeDays = typeof o.maxAgeDays === "number" ? o.maxAgeDays : MAX_AGE_DAYS_DEFAULT;
    // Remember what to sweep with when no renderer is around to say — see
    // PersistedSweepSettings.
    rememberSweepSettings(folder, maxStorageMb, maxAgeDays);
    const result = await sweep(folder, maxStorageMb, maxAgeDays);
    return { folder, isDefault: folder === defaultFolder(), ...result };
  });

  /** Mint a clip id and open its files. */
  ipcMain.handle("recording:begin", async (_e, opts: unknown) => {
    const o = (opts ?? {}) as { clipId?: unknown };
    const clipId = typeof o.clipId === "string" ? o.clipId : "";
    if (!CLIP_ID_PATTERN.test(clipId)) return { ok: false, error: "bad-clip-id" };
    if (openClips.has(clipId)) return { ok: false, error: "already-open" };

    const folder = activeFolder ?? resolveFolder(null);
    const dir = clipDir(folder, clipId);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (err) {
      log.error(`[recording] cannot create ${dir}: ${String(err)}`);
      return { ok: false, error: "folder-failed" };
    }
    const clip: OpenClip = { id: clipId, folder, dir, openedAtMs: Date.now(), tracks: new Map() };
    openClips.set(clipId, clip);
    return { ok: true, clipId, folder, dir };
  });

  /**
   * Append one encoder chunk. Chunks arrive as Uint8Array over structured
   * clone — the renderer sends at most a couple of megabytes a second per
   * track, well inside what the IPC channel carries comfortably.
   */
  ipcMain.handle("recording:append", async (_e, opts: unknown) => {
    const o = (opts ?? {}) as { clipId?: unknown; track?: unknown; data?: unknown };
    const clip = typeof o.clipId === "string" ? openClips.get(o.clipId) : undefined;
    if (!clip) return { ok: false, error: "no-clip" };
    if (!TRACKS.includes(o.track as RecordingTrack)) return { ok: false, error: "bad-track" };
    const data = o.data;
    if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
      return { ok: false, error: "bad-data" };
    }
    const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(new Uint8Array(data));

    const entry = openTrack(clip, o.track as RecordingTrack);
    if (!entry) return { ok: false, error: "open-failed" };
    if (entry.failed) return { ok: false, error: "write-failed", bytes: entry.bytes };

    entry.bytes += buf.byteLength;
    // Fire-and-forget into the stream's own buffer; `drain` backpressure is
    // handled by Node internally and a stalled disk surfaces via the error
    // handler. Awaiting each write would serialize two encoders behind one
    // spinning disk and drop frames.
    entry.stream.write(buf);
    return { ok: true, bytes: entry.bytes };
  });

  /** Close a clip, write its manifest, and re-run the disk budget. */
  ipcMain.handle("recording:finish", async (_e, opts: unknown) => {
    const o = (opts ?? {}) as { clipId?: unknown; manifest?: unknown; maxStorageMb?: unknown; maxAgeDays?: unknown };
    const clipId = typeof o.clipId === "string" ? o.clipId : "";
    const clip = openClips.get(clipId);
    if (!clip) return { ok: false, error: "no-clip" };

    openClips.delete(clipId);
    await closeClip(clip);

    // The renderer's byte counts are what it SENT; ours are what we WROTE.
    // Ours win — a dropped append must not show up as footage that exists.
    const manifest = (o.manifest ?? {}) as RecordingManifest;
    const tracks: RecordingManifest["tracks"] = {};
    for (const [track, entry] of clip.tracks) {
      const fromRenderer = manifest.tracks?.[track];
      // Make the file seekable before anyone can open it. This is the only
      // moment the numbers a player wants — the length, and where each moment
      // sits — are knowable at all.
      const finalized = await finalizeWebmFile(entry.file);
      if (!finalized.ok) {
        log.warn(`[recording] ${path.basename(entry.file)} left as-is (${finalized.reason})`);
      }
      let bytes = entry.bytes;
      try {
        bytes = (await fs.promises.stat(entry.file)).size;
      } catch {
        // Keep the write count; the sweep below reads the real sizes anyway.
      }
      tracks[track] = {
        file: path.basename(entry.file),
        mimeType: fromRenderer?.mimeType ?? "video/webm",
        bytes,
        width: fromRenderer?.width ?? null,
        height: fromRenderer?.height ?? null,
        audio: fromRenderer?.audio ?? null,
        durationMs: finalized.durationMs ?? null,
        syncMarks: Array.isArray(fromRenderer?.syncMarks) ? fromRenderer.syncMarks : [],
      };
    }

    const full: RecordingManifest = {
      clipId,
      version: 1,
      studentId: typeof manifest.studentId === "string" ? manifest.studentId : null,
      sessionId: typeof manifest.sessionId === "string" ? manifest.sessionId : null,
      startedAtMs: typeof manifest.startedAtMs === "number" ? manifest.startedAtMs : clip.openedAtMs,
      endedAtMs: Date.now(),
      triggeredAtMs:
        typeof manifest.triggeredAtMs === "number" ? manifest.triggeredAtMs : clip.openedAtMs,
      endReason: manifest.endReason === "rotated" || manifest.endReason === "stopped"
        ? manifest.endReason
        : "idle",
      quality: manifest.quality ?? "720p",
      tracks,
    };

    try {
      await fs.promises.writeFile(
        manifestFile(clip.dir, clipId), JSON.stringify(full, null, 2), "utf8",
      );
    } catch (err) {
      log.warn(`[recording] manifest write failed for ${clipId}: ${String(err)}`);
    }

    const maxStorageMb = typeof o.maxStorageMb === "number" ? o.maxStorageMb : 20480;
    const maxAgeDays = typeof o.maxAgeDays === "number" ? o.maxAgeDays : MAX_AGE_DAYS_DEFAULT;
    rememberSweepSettings(clip.folder, maxStorageMb, maxAgeDays);
    const swept = await sweep(clip.folder, maxStorageMb, maxAgeDays);
    return { ok: true, clipId, folder: clip.folder, dir: clip.dir, ...swept };
  });

  /** Close and DELETE a clip — used when a clip turns out to be empty. */
  ipcMain.handle("recording:abort", async (_e, opts: unknown) => {
    const o = (opts ?? {}) as { clipId?: unknown };
    const clipId = typeof o.clipId === "string" ? o.clipId : "";
    const clip = openClips.get(clipId);
    if (!clip) return { ok: false, error: "no-clip" };
    openClips.delete(clipId);
    await closeClip(clip);
    for (const entry of clip.tracks.values()) {
      try {
        await fs.promises.unlink(entry.file);
      } catch { /* already gone */ }
    }
    try {
      await fs.promises.rmdir(clip.dir);
    } catch { /* not empty, or never created */ }
    return { ok: true };
  });

  /** Folder contents, newest first — for the on-device caretaker view. */
  ipcMain.handle("recording:list", async () => {
    const folder = activeFolder ?? defaultFolder();
    const clips = await inventory(folder);
    clips.sort((a, b) => b.startedAtMs - a.startedAtMs);
    return {
      folder,
      totalBytes: clips.reduce((sum, c) => sum + c.bytes, 0),
      clips: clips.map((c) => ({ id: c.id, startedAtMs: c.startedAtMs, bytes: c.bytes })),
    };
  });

  /**
   * Delete this device's footage of one student — the erasure path.
   *
   * Returns what actually went, so the renderer can acknowledge it to the
   * server; an empty list is a legitimate answer (nothing of theirs is here).
   */
  ipcMain.handle("recording:purgeStudent", async (_e, opts: unknown) => {
    const o = (opts ?? {}) as { studentId?: unknown };
    const studentId = typeof o.studentId === "string" ? o.studentId : "";
    if (!studentId.trim()) return { clipIds: [], bytes: 0 };
    try {
      return await purgeStudentRecordings(studentId);
    } catch (err) {
      log.warn(`[recording] purge failed: ${String(err)}`);
      return { clipIds: [], bytes: 0 };
    }
  });

  /** Open the recordings folder in the OS file manager. */
  ipcMain.handle("recording:reveal", async () => {
    const folder = activeFolder ?? defaultFolder();
    try {
      await fs.promises.mkdir(folder, { recursive: true });
    } catch { /* reported by openPath below */ }
    const err = await shell.openPath(folder);
    return { folder, opened: !err, error: err || null };
  });

  // Retention no longer waits for the recorder to run again.
  startSweepTimer();

  // A quit with clips still open must still leave playable files behind.
  app.on("before-quit", () => {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    for (const clip of openClips.values()) {
      for (const entry of clip.tracks.values()) {
        try { entry.stream.end(); } catch { /* shutting down */ }
      }
    }
    openClips.clear();
  });
}

/** Close every open clip. Exposed for teardown paths other than `before-quit`. */
export async function stopRecordingStore(): Promise<void> {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  for (const clip of [...openClips.values()]) {
    openClips.delete(clip.id);
    await closeClip(clip);
  }
}
