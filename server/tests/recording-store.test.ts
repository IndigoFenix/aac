/**
 * recording-store.test.ts — The disk side of session recording.
 *
 * The store is an Electron main-process module, so `electron` and
 * `electron-log` are stubbed and the IPC handlers it registers are called
 * directly — the same calls the renderer makes over the bridge. That is enough
 * to exercise the parts that are easy to get silently wrong: a clip is written
 * into its OWN folder, the finished files come back seekable, eviction takes
 * the folder with the footage, and clips from the old flat layout still count
 * and are still evictable.
 *
 * (`jest.mock` does nothing under ESM — see the unstable_mockModule dance.)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { liveMuxedWebm } from "./helpers/live-muxed-webm.js";

/** Where the stubbed `app.getPath("videos")` points, per test. */
let videosDir = os.tmpdir();

type Handler = (event: unknown, opts: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

jest.unstable_mockModule("electron", () => ({
  app: {
    getPath: () => videosDir,
    on: () => undefined,
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
  },
  shell: { openPath: async () => "" },
}));

jest.unstable_mockModule("electron-log", () => ({
  default: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

const { setupRecordingStore, stopRecordingStore } =
  await import("../../electron/hardware/recording-store.js");

/** Call one of the store's IPC handlers the way the preload bridge does. */
async function call<T = any>(channel: string, opts?: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return (await handler({}, opts)) as T;
}

/** Feed a whole file in as the renderer would: one chunk per tick. */
async function appendFile(clipId: string, track: "camera" | "screen", data: Buffer): Promise<void> {
  const chunk = Math.ceil(data.length / 3);
  for (let at = 0; at < data.length; at += chunk) {
    const slice = data.subarray(at, Math.min(at + chunk, data.length));
    const res = await call<{ ok: boolean }>("recording:append", {
      clipId, track, data: new Uint8Array(slice),
    });
    expect(res.ok).toBe(true);
  }
}

const MB = 1024 * 1024;
/** Roomy enough that nothing is evicted while a test is setting up. */
const MAX_MB = 1024;

describe("recording store", () => {
  let root: string;

  beforeAll(() => {
    setupRecordingStore();
  });

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "recording-store-"));
    videosDir = root;
  });

  afterEach(async () => {
    await stopRecordingStore();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it("writes a clip's three files into a folder of their own", async () => {
    const folder = path.join(root, "clips");
    await call("recording:prepare", { folder, maxStorageMb: 1024 });

    const clipId = "20260821-101530-ab12";
    const begun = await call<{ ok: boolean; dir: string }>("recording:begin", { clipId });
    expect(begun.ok).toBe(true);
    expect(begun.dir).toBe(path.join(folder, clipId));

    await appendFile(clipId, "camera", liveMuxedWebm());
    await appendFile(clipId, "screen", liveMuxedWebm());
    const done = await call<{ ok: boolean; clipCount: number }>("recording:finish", {
      clipId,
      manifest: {
        clipId, version: 1, studentId: "s1", sessionId: null,
        startedAtMs: 1, endedAtMs: 2, triggeredAtMs: 1, endReason: "idle", quality: "720p",
        tracks: {
          camera: { file: "", mimeType: "video/webm;codecs=vp9,opus", bytes: 0, width: 1280, height: 720, audio: "mic", syncMarks: [] },
          screen: { file: "", mimeType: "video/webm;codecs=vp9,opus", bytes: 0, width: 1920, height: 1080, audio: "system", syncMarks: [] },
        },
      },
      maxStorageMb: 1024,
    });
    expect(done.ok).toBe(true);
    expect(done.clipCount).toBe(1);

    // Nothing loose in the root — the whole point of the folder.
    expect(await fs.promises.readdir(folder)).toEqual([clipId]);
    expect((await fs.promises.readdir(path.join(folder, clipId))).sort()).toEqual([
      `${clipId}.camera.webm`, `${clipId}.json`, `${clipId}.screen.webm`,
    ]);
  });

  it("finalizes both files and records what each one's sound is", async () => {
    const folder = path.join(root, "clips");
    await call("recording:prepare", { folder, maxStorageMb: 1024 });
    const clipId = "20260821-101530-cd34";
    await call("recording:begin", { clipId });
    await appendFile(clipId, "camera", liveMuxedWebm());
    await appendFile(clipId, "screen", liveMuxedWebm());
    await call("recording:finish", {
      clipId,
      manifest: {
        tracks: {
          camera: { mimeType: "video/webm;codecs=vp9,opus", audio: "mic", syncMarks: [{ t: 1, wall: 2 }] },
          screen: { mimeType: "video/webm;codecs=vp9,opus", audio: "system", syncMarks: [] },
        },
      },
      maxStorageMb: 1024,
    });

    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(folder, clipId, `${clipId}.json`), "utf8"),
    );
    // The camera hears the room and the screen hears the app; an editor opening
    // these months later has no other way to know which is which.
    expect(manifest.tracks.camera.audio).toBe("mic");
    expect(manifest.tracks.screen.audio).toBe("system");
    // Both files were made seekable, and the manifest carries the length that
    // finally exists.
    expect(manifest.tracks.camera.durationMs).toBeGreaterThan(2000);
    expect(manifest.tracks.screen.durationMs).toBeGreaterThan(2000);
    // Byte counts are the store's own, and the rewrite changed them.
    const onDisk = await fs.promises.stat(path.join(folder, clipId, `${clipId}.camera.webm`));
    expect(manifest.tracks.camera.bytes).toBe(onDisk.size);
    expect(manifest.tracks.camera.syncMarks).toEqual([{ t: 1, wall: 2 }]);
  });

  it("evicts a whole clip folder, oldest first, and keeps the newest", async () => {
    const folder = path.join(root, "clips");
    await call("recording:prepare", { folder, maxStorageMb: MAX_MB });
    // Three clips, each far too big for the budget below.
    const ids = ["20260821-090000-aaaa", "20260821-100000-bbbb", "20260821-110000-cccc"];
    const big = Buffer.alloc(2 * MB, 7);
    for (const clipId of ids) {
      await call("recording:begin", { clipId });
      await appendFile(clipId, "camera", big);
      await call("recording:finish", { clipId, manifest: {}, maxStorageMb: 1024 });
    }
    expect((await fs.promises.readdir(folder)).sort()).toEqual(ids);

    // A fourth clip takes the folder to 8 MB against a 5 MB budget, so whole
    // folders go oldest-first — footage and manifest together — until it fits.
    const clipId = "20260821-120000-dddd";
    await call("recording:begin", { clipId });
    await appendFile(clipId, "camera", big);
    const done = await call<{ deletedIds: string[]; clipCount: number }>("recording:finish", {
      clipId, manifest: {}, maxStorageMb: 5,
    });
    expect(done.deletedIds).toEqual([ids[0], ids[1]]);
    expect(done.clipCount).toBe(2);
    expect((await fs.promises.readdir(folder)).sort()).toEqual([ids[2], clipId]);
    // Deleted whole: no orphaned video left behind in an empty folder.
    expect(fs.existsSync(path.join(folder, ids[0]))).toBe(false);
  });

  it("still counts and evicts clips written in the old flat layout", async () => {
    const folder = path.join(root, "clips");
    await fs.promises.mkdir(folder, { recursive: true });
    const oldId = "20260101-080000-eeee";
    // Exactly what the store used to write: three loose files in the root.
    await fs.promises.writeFile(path.join(folder, `${oldId}.camera.webm`), Buffer.alloc(2 * MB, 1));
    await fs.promises.writeFile(path.join(folder, `${oldId}.screen.webm`), Buffer.alloc(2 * MB, 2));
    await fs.promises.writeFile(path.join(folder, `${oldId}.json`), "{}", "utf8");

    const prepared = await call<{ totalBytes: number; clipCount: number }>("recording:prepare", {
      folder, maxStorageMb: 1024,
    });
    expect(prepared.clipCount).toBe(1);
    expect(prepared.totalBytes).toBeGreaterThanOrEqual(4 * MB);

    const clipId = "20260821-130000-ffff";
    await call("recording:begin", { clipId });
    await appendFile(clipId, "camera", Buffer.alloc(2 * MB, 3));
    const done = await call<{ deletedIds: string[] }>("recording:finish", {
      clipId, manifest: {}, maxStorageMb: 3,
    });
    expect(done.deletedIds).toEqual([oldId]);
    expect(await fs.promises.readdir(folder)).toEqual([clipId]);
  });

  it("rebuilds a manifest for a clip a crash left without one", async () => {
    const folder = path.join(root, "clips");
    const clipId = "20260821-140000-9999";
    await fs.promises.mkdir(path.join(folder, clipId), { recursive: true });
    // A clip whose renderer died before `finish`: files on disk, no manifest.
    await fs.promises.writeFile(
      path.join(folder, clipId, `${clipId}.camera.webm`), liveMuxedWebm(),
    );

    await call("recording:prepare", { folder, maxStorageMb: 1024 });
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(folder, clipId, `${clipId}.json`), "utf8"),
    );
    expect(manifest.clipId).toBe(clipId);
    expect(manifest.tracks.camera.file).toBe(`${clipId}.camera.webm`);
    // Recovery finalizes too: this is footage nobody else will ever fix up.
    expect(manifest.tracks.camera.durationMs).toBeGreaterThan(2000);
  });

  it("deletes the folder of an aborted clip", async () => {
    const folder = path.join(root, "clips");
    await call("recording:prepare", { folder, maxStorageMb: 1024 });
    const clipId = "20260821-150000-1234";
    await call("recording:begin", { clipId });
    await appendFile(clipId, "camera", liveMuxedWebm());
    expect(await call<{ ok: boolean }>("recording:abort", { clipId })).toEqual({ ok: true });
    expect(await fs.promises.readdir(folder)).toEqual([]);
  });

  it("removes a temp file left behind by a killed finalize", async () => {
    const folder = path.join(root, "clips");
    const clipId = "20260821-160000-5678";
    await fs.promises.mkdir(path.join(folder, clipId), { recursive: true });
    await fs.promises.writeFile(path.join(folder, clipId, `${clipId}.camera.webm`), liveMuxedWebm());
    // A half-written rewrite: nothing counts it, so nothing would ever clear it.
    const stale = path.join(folder, clipId, `${clipId}.camera.webm.finalizing`);
    await fs.promises.writeFile(stale, Buffer.alloc(1024));

    await call("recording:prepare", { folder, maxStorageMb: 1024 });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(folder, clipId, `${clipId}.camera.webm`))).toBe(true);
  });

  it("refuses a clip id it did not mint", async () => {
    await call("recording:prepare", { folder: path.join(root, "clips"), maxStorageMb: 1024 });
    // The id names a directory, so anything shaped differently is a path.
    for (const clipId of ["../escape", "20260821-160000", "", "20260821-160000-TOOLONG"]) {
      expect(await call("recording:begin", { clipId })).toEqual({ ok: false, error: "bad-clip-id" });
    }
  });
});
