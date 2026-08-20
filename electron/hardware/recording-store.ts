/**
 * Session-recording file store (main process).
 *
 * The renderer owns the encoders (two MediaRecorders — camera and app window)
 * and streams their chunks here; this module is the only thing that touches
 * the disk. It keeps one folder of CLIPS, where a clip is three files sharing
 * an id:
 *
 *   20260820-141233-a4f1.camera.webm
 *   20260820-141233-a4f1.screen.webm
 *   20260820-141233-a4f1.json          ← manifest, incl. the sync marks
 *
 * A clip is the unit of everything: it is written whole, deleted whole, and
 * counted whole against the disk budget.
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
import {
  planEviction,
  type RecordingManifest,
  type RecordingTrack,
  type StoredClip,
} from "../../shared/aac/session-recording.js";

const TRACKS: readonly RecordingTrack[] = ["camera", "screen"];

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

function resolveFolder(configured: unknown): string {
  const wanted = typeof configured === "string" && configured.trim()
    ? configured.trim()
    : defaultFolder();
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
  folder: string;
  openedAtMs: number;
  tracks: Map<RecordingTrack, OpenTrack>;
}

const openClips = new Map<string, OpenClip>();

function clipFile(folder: string, id: string, track: RecordingTrack): string {
  return path.join(folder, `${id}.${track}.webm`);
}

function manifestFile(folder: string, id: string): string {
  return path.join(folder, `${id}.json`);
}

/** Ids we generate. Anything else is refused — the id names a file path. */
const CLIP_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

function openTrack(clip: OpenClip, track: RecordingTrack): OpenTrack | null {
  const existing = clip.tracks.get(track);
  if (existing) return existing;
  const file = clipFile(clip.folder, clip.id, track);
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
  hasManifest: boolean;
}

/**
 * Everything in the folder, grouped into clips.
 *
 * Grouping is by FILENAME, not by manifest, so a clip whose manifest never got
 * written (renderer crash, power loss) is still counted against the budget and
 * still evictable. Otherwise a run of crashes would leave orphaned gigabytes
 * that the sweep could never see.
 */
async function inventory(folder: string): Promise<InventoryEntry[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(folder);
  } catch {
    return [];
  }

  const byId = new Map<string, InventoryEntry>();
  for (const name of names) {
    const m = /^(\d{8}-\d{6}-[a-z0-9]{4})\.(camera|screen)\.webm$/.exec(name)
      ?? /^(\d{8}-\d{6}-[a-z0-9]{4})\.(json)$/.exec(name);
    if (!m) continue;
    const id = m[1];
    const full = path.join(folder, name);
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = await fs.promises.stat(full);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    const entry = byId.get(id) ?? {
      id,
      // Parsed from the id itself — the id is minted from wall clock, so it
      // orders correctly even when a manifest is missing. mtime is the backstop.
      startedAtMs: parseClipIdTime(id) ?? mtimeMs,
      bytes: 0,
      files: [],
      hasManifest: false,
    };
    entry.bytes += size;
    entry.files.push(full);
    if (name.endsWith(".json")) entry.hasManifest = true;
    byId.set(id, entry);
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
async function sweep(folder: string, maxStorageMb: number): Promise<SweepResult> {
  const clips = await inventory(folder);
  const maxBytes = Math.max(0, Math.round(maxStorageMb)) * 1024 * 1024;
  const plan = planEviction(clips, maxBytes, [...openClips.keys()]);

  const deleted: string[] = [];
  for (const id of plan.deleteIds) {
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
    if (ok) deleted.push(id);
  }
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
    const tracks: RecordingManifest["tracks"] = {};
    for (const track of TRACKS) {
      const file = clipFile(folder, clip.id, track);
      try {
        const st = await fs.promises.stat(file);
        tracks[track] = {
          file: path.basename(file),
          mimeType: "video/webm",
          bytes: st.size,
          width: null,
          height: null,
          syncMarks: [],
        };
      } catch {
        // Track absent — a clip can legitimately have only one.
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
        manifestFile(folder, clip.id), JSON.stringify(manifest, null, 2), "utf8",
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
    const o = (opts ?? {}) as { folder?: unknown; maxStorageMb?: unknown };
    const folder = resolveFolder(o.folder);
    await recoverOrphans(folder);
    const maxStorageMb = typeof o.maxStorageMb === "number" ? o.maxStorageMb : 20480;
    const result = await sweep(folder, maxStorageMb);
    return { folder, isDefault: folder === defaultFolder(), ...result };
  });

  /** Mint a clip id and open its files. */
  ipcMain.handle("recording:begin", async (_e, opts: unknown) => {
    const o = (opts ?? {}) as { clipId?: unknown };
    const clipId = typeof o.clipId === "string" ? o.clipId : "";
    if (!CLIP_ID_PATTERN.test(clipId)) return { ok: false, error: "bad-clip-id" };
    if (openClips.has(clipId)) return { ok: false, error: "already-open" };

    const folder = activeFolder ?? resolveFolder(null);
    const clip: OpenClip = { id: clipId, folder, openedAtMs: Date.now(), tracks: new Map() };
    openClips.set(clipId, clip);
    return { ok: true, clipId, folder };
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
    const o = (opts ?? {}) as { clipId?: unknown; manifest?: unknown; maxStorageMb?: unknown };
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
      tracks[track] = {
        file: path.basename(entry.file),
        mimeType: fromRenderer?.mimeType ?? "video/webm",
        bytes: entry.bytes,
        width: fromRenderer?.width ?? null,
        height: fromRenderer?.height ?? null,
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
        manifestFile(clip.folder, clipId), JSON.stringify(full, null, 2), "utf8",
      );
    } catch (err) {
      log.warn(`[recording] manifest write failed for ${clipId}: ${String(err)}`);
    }

    const maxStorageMb = typeof o.maxStorageMb === "number" ? o.maxStorageMb : 20480;
    const swept = await sweep(clip.folder, maxStorageMb);
    return { ok: true, clipId, folder: clip.folder, ...swept };
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

  /** Open the recordings folder in the OS file manager. */
  ipcMain.handle("recording:reveal", async () => {
    const folder = activeFolder ?? defaultFolder();
    try {
      await fs.promises.mkdir(folder, { recursive: true });
    } catch { /* reported by openPath below */ }
    const err = await shell.openPath(folder);
    return { folder, opened: !err, error: err || null };
  });

  // A quit with clips still open must still leave playable files behind.
  app.on("before-quit", () => {
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
  for (const clip of [...openClips.values()]) {
    openClips.delete(clip.id);
    await closeClip(clip);
  }
}
