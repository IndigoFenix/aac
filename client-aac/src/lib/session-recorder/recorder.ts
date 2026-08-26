// client-aac/src/lib/session-recorder/recorder.ts
//
// The encoder side of session recording. Owns two MediaRecorders — the student
// on camera (with the room mic) and the app's own window (with the app's own
// sound) — and streams their chunks to the Electron store, which is the only
// thing that touches disk.
//
// The split of sound between the two files is deliberate: see `captureScreen`.
//
// ── The pre-roll problem ───────────────────────────────────────────────────
// "Also capture the moments when they start to interact" cannot be done by
// starting an encoder when the interaction lands: by then the approach, the
// look, the reach are already gone. So the encoders run continuously while the
// feature is on and a clip opens with footage already in hand.
//
// The obvious way to hold that footage — one long-running recorder and a ring
// of its recent chunks — does not work. A WebM file's clusters carry timecodes
// measured from when THAT recorder started, and the header that makes them
// readable arrives only in the first chunk. Keep the header, drop the middle,
// and you get a file whose picture begins forty minutes in; every player treats
// the gap as content.
//
// So instead each source runs a PAIR of recorders, staggered by the pre-roll
// length and each restarting at twice it. At any instant one of the two has
// been running for at least a full pre-roll and at most two, and its buffered
// chunks are a complete file from its own start. When a clip opens, the elder
// of the pair is promoted: its buffer is flushed to disk and it keeps writing
// there, one continuous recorder, one valid file with the lead-in already in
// it. The younger is stopped, so exactly one encoder per source runs for the
// duration of the clip — the long steady state.
//
// The cost is two encoders per source while idle, which is why
// `preRollSeconds: 0` is a real setting: it skips the pair entirely and starts
// a single recorder on demand.
//
// ── Synchronization ────────────────────────────────────────────────────────
// The two files are separate recordings; nothing in WebM relates them. Both
// promotions happen in the same turn, so they start aligned to within a frame,
// but neither MediaRecorder says when its encoder actually saw its first frame
// and long clips drift. Every chunk boundary IS an instant known in both
// timelines, so each one is written into the manifest as a SyncMark. An editor
// aligns on those instead of hunting for a clap.

import {
  AUDIO_BITRATE_BPS,
  SCREEN_BITRATE_BPS,
  cameraBitrateFor,
  cameraConstraintsFor,
  type RecordingAudioSource,
  type RecordingManifest,
  type RecordingTrack,
  type SessionRecordingSettings,
  type SyncMark,
} from "@shared/aac/session-recording.js";
import type { RecordingBridge } from "@/lib/platform";
import {
  initialGateState,
  stepGate,
  stopGate,
  type ClipEndReason,
  type GateState,
} from "./activity-gate";
import { makeClipId, randomClipSuffix } from "./clip-id";

/** How often the gate is advanced, and how often each encoder emits a chunk. */
const TICK_MS = 1000;

/**
 * How often each encoder is asked for a key frame.
 *
 * Left alone, Chromium's VP9 encoder emits one at the start and then almost
 * none — an eighteen-second clip came back with a single key frame in it. A
 * WebM cluster can only begin at one, so that clip was also a single cluster:
 * nothing to index, nothing to seek to, and an editor scrubbing it has to
 * decode from the beginning every time. Asking for one every couple of seconds
 * costs a little bitrate on footage that is already generously encoded, and
 * buys a file that can be cut.
 */
const KEY_FRAME_INTERVAL_MS = 2000;

/**
 * Pre-roll pairs restart at twice the pre-roll, staggered by one pre-roll, so
 * the elder always holds between one and two pre-rolls of footage.
 */
const GENERATION_FACTOR = 2;

export interface RecorderStatus {
  /** The host can record and the student's settings enable it. */
  enabled: boolean;
  /** Encoders are live (idle pair running, or a clip being written). */
  running: boolean;
  /** A clip is open right now. Drives the on-screen recording indicator. */
  clipOpen: boolean;
  /** Where clips are being written, once known. */
  folder: string | null;
  /** Bytes currently held by the recording folder. */
  totalBytes: number;
  clipCount: number;
  /** Set when recording stopped for a reason a caretaker should see. */
  error: string | null;
}

export interface SessionRecorderOptions {
  settings: SessionRecordingSettings;
  bridge: RecordingBridge;
  /** The SHARED camera stream. Never acquired here — a second getUserMedia on
   *  the user camera is what useMultiCamera exists to prevent. */
  getCameraStream: () => MediaStream | null;
  studentId: string | null;
  getSessionId: () => string | null;
  onStatus?: (status: RecorderStatus) => void;
}

// ---------------------------------------------------------------------------
// Codec selection
// ---------------------------------------------------------------------------

function pickMimeType(withAudio: boolean): string {
  const candidates = withAudio
    ? [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ]
    : [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "video/webm";
}

// ---------------------------------------------------------------------------
// One recorder generation
// ---------------------------------------------------------------------------

/**
 * A single MediaRecorder run over one source. While `live` is false its chunks
 * accumulate in memory as the pre-roll; once promoted they go to disk.
 */
class Generation {
  readonly recorder: MediaRecorder;
  readonly startedAtMs: number;
  readonly syncMarks: SyncMark[] = [];
  buffered: Blob[] = [];
  bufferedBytes = 0;
  live = false;
  stopped = false;

  constructor(
    stream: MediaStream,
    mimeType: string,
    videoBps: number,
    audioBps: number | undefined,
    private readonly onChunk: (gen: Generation, blob: Blob, atMs: number) => void,
  ) {
    // `videoKeyFrameIntervalDuration` is Chromium's, not the standard's, so it
    // is not in lib.dom — an older engine simply ignores it and we get the
    // long-GOP file we would have got anyway.
    const opts: MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number } = {
      mimeType,
      videoBitsPerSecond: videoBps,
      videoKeyFrameIntervalDuration: KEY_FRAME_INTERVAL_MS,
    };
    if (audioBps) opts.audioBitsPerSecond = audioBps;
    this.recorder = new MediaRecorder(stream, opts);
    this.recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      this.onChunk(this, ev.data, Date.now());
    };
    this.startedAtMs = Date.now();
    this.recorder.start(TICK_MS);
  }

  ageMs(nowMs: number): number {
    return nowMs - this.startedAtMs;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      if (this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // Already torn down by a dead track — nothing to do.
    }
  }
}

// ---------------------------------------------------------------------------
// One source (camera or screen)
// ---------------------------------------------------------------------------

/**
 * The pre-roll pair for one source, plus the promoted generation while a clip
 * is open. Owns nothing about clip lifecycle — that is the gate's job.
 */
class TrackPipeline {
  private generations: Generation[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** Serializes chunk writes: `blob.arrayBuffer()` is async, and two chunks
   *  racing through it would reach the file out of order. */
  private writeChain: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  live: Generation | null = null;
  writtenBytes = 0;
  width: number | null = null;
  height: number | null = null;

  constructor(
    readonly track: RecordingTrack,
    private readonly stream: MediaStream,
    readonly mimeType: string,
    private readonly videoBps: number,
    private readonly audioBps: number | undefined,
    private readonly preRollMs: number,
    private readonly appendChunk: (track: RecordingTrack, data: Uint8Array) => Promise<boolean>,
    /** What this file's sound is, for the manifest — the two files carry
     *  different audio on purpose, and an editor has to be told which is which. */
    readonly audioSource: RecordingAudioSource,
  ) {
    const settings = stream.getVideoTracks()[0]?.getSettings();
    this.width = settings?.width ?? null;
    this.height = settings?.height ?? null;
  }

  /** Start the idle pre-roll pair. No-op when pre-roll is disabled. */
  startIdle(): void {
    if (this.preRollMs <= 0) return;
    this.spawnGeneration();
    // The second of the pair starts one pre-roll later, which is what puts the
    // pair permanently out of phase.
    this.timers.push(setTimeout(() => this.spawnGeneration(), this.preRollMs));
  }

  private spawnGeneration(): void {
    if (this.live) return;
    const gen = new Generation(
      this.stream, this.mimeType, this.videoBps, this.audioBps,
      (g, blob, atMs) => this.handleChunk(g, blob, atMs),
    );
    this.generations.push(gen);
    // Retire it after two pre-rolls, replacing it with a fresh one — that
    // rotation is what bounds how much memory the idle buffer holds.
    this.timers.push(setTimeout(() => {
      if (gen.live) return;
      gen.stop();
      this.generations = this.generations.filter((g) => g !== gen);
      this.spawnGeneration();
    }, this.preRollMs * GENERATION_FACTOR));
  }

  private handleChunk(gen: Generation, blob: Blob, atMs: number): void {
    if (gen.live) {
      gen.syncMarks.push({ t: atMs - gen.startedAtMs, wall: atMs });
      this.enqueueWrite(blob);
      return;
    }
    if (gen.stopped) return; // trailing chunk from a retired generation
    gen.buffered.push(blob);
    gen.bufferedBytes += blob.size;
    gen.syncMarks.push({ t: atMs - gen.startedAtMs, wall: atMs });
  }

  private enqueueWrite(blob: Blob): void {
    this.pendingWrites++;
    this.writeChain = this.writeChain.then(async () => {
      try {
        const buf = await blob.arrayBuffer();
        const ok = await this.appendChunk(this.track, new Uint8Array(buf));
        if (ok) this.writtenBytes += buf.byteLength;
      } catch {
        // A failed chunk is a hole in the file, not a reason to tear down the
        // session; the store logs it and the manifest's byte count is the
        // store's own, so nothing downstream is misled about what exists.
      } finally {
        this.pendingWrites--;
      }
    });
  }

  /**
   * Promote the generation holding the most lead-in and flush its buffer to
   * disk. Returns the wall clock the resulting file actually starts at.
   */
  promote(nowMs: number): number {
    if (this.live) return this.live.startedAtMs;

    if (!this.generations.length) {
      // Pre-roll disabled (or the pair never started) — begin one now. The
      // clip then starts at the trigger, with no lead-in.
      const gen = new Generation(
        this.stream, this.mimeType, this.videoBps, this.audioBps,
        (g, blob, atMs) => this.handleChunk(g, blob, atMs),
      );
      this.generations.push(gen);
      gen.live = true;
      this.live = gen;
      return gen.startedAtMs;
    }

    const elder = this.generations.reduce((best, g) =>
      g.ageMs(nowMs) > best.ageMs(nowMs) ? g : best);
    for (const g of this.generations) {
      if (g !== elder) g.stop();
    }
    this.generations = [elder];
    elder.live = true;
    this.live = elder;

    for (const blob of elder.buffered) this.enqueueWrite(blob);
    elder.buffered = [];
    elder.bufferedBytes = 0;
    return elder.startedAtMs;
  }

  /** Stop the open clip's recorder and wait for its last chunks to land. */
  async demote(): Promise<{ syncMarks: SyncMark[]; bytes: number }> {
    const gen = this.live;
    if (!gen) return { syncMarks: [], bytes: this.writtenBytes };

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      gen.recorder.onstop = done;
      gen.stop();
      // `onstop` can never fire if the stream died under the recorder.
      setTimeout(done, 2000);
    });
    await this.drain();

    this.live = null;
    this.generations = this.generations.filter((g) => g !== gen);
    return { syncMarks: gen.syncMarks, bytes: this.writtenBytes };
  }

  /** Resolve once every queued chunk has been handed to the store. */
  async drain(): Promise<void> {
    // The chain grows as chunks arrive, so wait for it repeatedly rather than
    // once — awaiting a stale chain would return before the last write.
    for (let i = 0; i < 10 && this.pendingWrites > 0; i++) {
      await this.writeChain;
    }
  }

  /** Reset byte accounting between clips (each clip is its own file). */
  resetForNextClip(): void {
    this.writtenBytes = 0;
  }

  teardown(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const g of this.generations) g.stop();
    this.generations = [];
    this.live = null;
  }
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

export class SessionRecorder {
  private readonly opts: SessionRecorderOptions;
  private gate: GateState;
  private tick: ReturnType<typeof setInterval> | null = null;
  private activitySinceTick = false;

  private cameraPipeline: TrackPipeline | null = null;
  private screenPipeline: TrackPipeline | null = null;
  /** Our own streams, which we must stop. The shared camera track is NOT ours. */
  private micStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private cameraTrack: MediaStreamTrack | null = null;

  private clipId: string | null = null;
  private clipStartedAtMs = 0;
  private clipTriggeredAtMs = 0;
  /** Guards the clip open/close transitions, which are async and must not
   *  interleave — a rotation is a close and an open back to back. */
  private transition: Promise<void> = Promise.resolve();

  private status: RecorderStatus = {
    enabled: false, running: false, clipOpen: false,
    folder: null, totalBytes: 0, clipCount: 0, error: null,
  };

  constructor(opts: SessionRecorderOptions) {
    this.opts = opts;
    this.gate = initialGateState(Date.now());
  }

  getStatus(): RecorderStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<RecorderStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus?.(this.getStatus());
  }

  /** An interaction happened. Cheap and synchronous — safe to call from a
   *  render path or an event handler on every press and every utterance. */
  noteActivity(): void {
    this.activitySinceTick = true;
  }

  /**
   * Acquire the sources and start the idle encoders. Throws nothing: a failure
   * to acquire leaves the recorder disabled with `status.error` set, because a
   * session must never fail to start over a promotional-video feature.
   */
  async start(): Promise<void> {
    const { settings, bridge } = this.opts;
    if (!settings.enabled) return;

    this.setStatus({ enabled: true, error: null });

    try {
      const prepared = await bridge.prepare({
        folder: settings.folder,
        maxStorageMb: settings.maxStorageMb,
        maxAgeDays: settings.maxAgeDays,
      });
      this.setStatus({
        folder: prepared.folder,
        totalBytes: prepared.totalBytes,
        clipCount: prepared.clipCount,
      });
    } catch (err) {
      this.setStatus({ enabled: false, error: `folder unavailable: ${String(err)}` });
      return;
    }

    const cameraOk = await this.setupCamera();
    const screenOk = await this.setupScreen();
    if (!cameraOk && !screenOk) {
      this.setStatus({ enabled: false, error: "no capturable source" });
      return;
    }

    this.gate = initialGateState(Date.now());
    this.tick = setInterval(() => this.onTick(), TICK_MS);
    this.setStatus({ running: true });
  }

  private async setupCamera(): Promise<boolean> {
    const { settings } = this.opts;
    const shared = this.opts.getCameraStream();
    const videoTrack = shared?.getVideoTracks()[0] ?? null;
    if (!videoTrack) return false;
    this.cameraTrack = videoTrack;

    // Raise the SHARED track to the requested capture size rather than opening
    // a second one. Every other consumer (face tracking, the Observer's frame
    // grid) downscales what it reads, so a larger track is transparent to them
    // — at the cost of more pixels through their loops, which is exactly why
    // 720p (today's acquisition default) is the default here.
    try {
      await videoTrack.applyConstraints(cameraConstraintsFor(settings.quality));
    } catch {
      // The device would not go that high. Record what it will give.
    }

    // A dedicated mic capture with the processing chain OFF. The session's own
    // mic runs with echo cancellation, which is correct for the agents — and
    // exactly wrong here, because the "echo" it removes is the AI's voice
    // coming out of the speakers, which is half of the conversation a promo
    // clip needs to carry.
    let audioTracks: MediaStreamTrack[] = [];
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      audioTracks = this.micStream.getAudioTracks();
    } catch {
      // Recording silent video beats not recording — but say so, because a
      // camera file that turns out to have no room sound in it is only
      // discovered at edit time, long after the session it was meant to show.
      this.setStatus({ error: "microphone unavailable — the camera file will be silent" });
    }

    const combined = new MediaStream([videoTrack, ...audioTracks]);
    this.cameraPipeline = new TrackPipeline(
      "camera", combined, pickMimeType(audioTracks.length > 0),
      cameraBitrateFor(settings.quality),
      audioTracks.length ? AUDIO_BITRATE_BPS : undefined,
      settings.preRollSeconds * 1000,
      (track, data) => this.append(track, data),
      audioTracks.length ? "mic" : null,
    );
    this.cameraPipeline.startIdle();
    return true;
  }

  /**
   * Capture the app's own window, with the app's own SOUND.
   *
   * The two files carry deliberately different audio. The camera file gets the
   * room: the child, the caretaker, whatever is going on around the device.
   * This one gets only what the device itself is playing — the voice a button
   * press speaks, and the AI's replies — because that is the half of a session
   * a promotional cut needs clean, without a room mic's noise, echo or
   * background conversation over it. An editor with both files can mix either.
   *
   * "What the device is playing" is loopback audio, which the browser has no
   * API for: `getDisplayMedia({audio:true})` gets it because the Electron
   * display-media handler answers with `audio: 'loopback'` (see
   * electron/main.ts). Where the host cannot do that at all the request is
   * retried without sound, since a silent screen file still beats none.
   */
  private async captureScreen(): Promise<MediaStream | null> {
    const video = { frameRate: { ideal: 30 } };
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video, audio: true });
    } catch (err) {
      const withAudio = String(err);
      try {
        return await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
      } catch {
        this.setStatus({ error: `screen capture unavailable: ${withAudio}` });
        return null;
      }
    }
  }

  private async setupScreen(): Promise<boolean> {
    const { settings } = this.opts;
    // The Electron main process answers this with the app's own window and no
    // picker (see the display-media handler in electron/main.ts), so there is
    // nothing for a student to dismiss and nothing off-app in the frame.
    this.screenStream = await this.captureScreen();
    if (!this.screenStream) return false;
    const screenAudio = this.screenStream.getAudioTracks();
    if (!screenAudio.length) {
      // Worth saying out loud: a screen file that turns out to be silent is
      // exactly the surprise this feature cannot afford at edit time.
      this.setStatus({ error: "no system audio — the screen file will be silent" });
    }

    // A capture that dies mid-session (the window closes and reopens, the OS
    // revokes it) would otherwise just stop producing frames, and every clip
    // from then on would silently be camera-only. Say so instead.
    for (const track of this.screenStream.getVideoTracks()) {
      track.addEventListener("ended", () => {
        this.setStatus({ error: "screen capture ended" });
      });
    }

    this.screenPipeline = new TrackPipeline(
      "screen", this.screenStream, pickMimeType(screenAudio.length > 0),
      SCREEN_BITRATE_BPS, screenAudio.length ? AUDIO_BITRATE_BPS : undefined,
      settings.preRollSeconds * 1000,
      (track, data) => this.append(track, data),
      screenAudio.length ? "system" : null,
    );
    this.screenPipeline.startIdle();
    return true;
  }

  private async append(track: RecordingTrack, data: Uint8Array): Promise<boolean> {
    const clipId = this.clipId;
    if (!clipId) return false;
    const res = await this.opts.bridge.append({ clipId, track, data });
    if (!res.ok && res.error === "write-failed") {
      this.setStatus({ error: "disk write failed" });
    }
    return res.ok;
  }

  private onTick(): void {
    const now = Date.now();
    const activity = this.activitySinceTick;
    this.activitySinceTick = false;

    const { state, action } = stepGate(
      this.gate,
      {
        idleTailMs: this.opts.settings.idleTailSeconds * 1000,
        maxClipMs: this.opts.settings.maxClipMinutes * 60_000,
      },
      now,
      activity,
    );
    this.gate = state;

    switch (action.kind) {
      case "open":
        this.queue(() => this.openClip(action.triggeredAtMs));
        break;
      case "close":
        this.queue(() => this.closeClip(action.reason));
        break;
      case "rotate":
        this.queue(async () => {
          await this.closeClip("rotated");
          await this.openClip(action.atMs);
        });
        break;
      default:
        break;
    }
  }

  /** Serialize clip transitions — they are async and a rotation is two of them. */
  private queue(fn: () => Promise<void>): void {
    this.transition = this.transition.then(fn).catch((err) => {
      this.setStatus({ error: String(err) });
    });
  }

  private async openClip(triggeredAtMs: number): Promise<void> {
    if (this.clipId) return;
    const clipId = makeClipId(new Date(), randomClipSuffix());
    const begun = await this.opts.bridge.begin({ clipId });
    if (!begun.ok) {
      this.setStatus({ error: `cannot start clip: ${begun.error}` });
      return;
    }

    this.clipId = clipId;
    this.clipTriggeredAtMs = triggeredAtMs;
    this.cameraPipeline?.resetForNextClip();
    this.screenPipeline?.resetForNextClip();

    // Both promotions in one turn: that is what starts the two files aligned.
    const now = Date.now();
    const camStart = this.cameraPipeline?.promote(now) ?? now;
    const scrStart = this.screenPipeline?.promote(now) ?? now;
    // The clip starts when its EARLIER file does, so the manifest's window
    // covers everything either file holds.
    this.clipStartedAtMs = Math.min(camStart, scrStart);

    this.setStatus({ clipOpen: true, folder: begun.folder });
  }

  private async closeClip(reason: ClipEndReason): Promise<void> {
    const clipId = this.clipId;
    if (!clipId) return;

    const camera = await this.cameraPipeline?.demote();
    const screen = await this.screenPipeline?.demote();

    const tracks: RecordingManifest["tracks"] = {};
    if (camera && this.cameraPipeline) {
      tracks.camera = {
        file: `${clipId}.camera.webm`,
        mimeType: this.cameraPipeline.mimeType,
        bytes: camera.bytes,
        width: this.cameraPipeline.width,
        height: this.cameraPipeline.height,
        audio: this.cameraPipeline.audioSource,
        syncMarks: camera.syncMarks,
      };
    }
    if (screen && this.screenPipeline) {
      tracks.screen = {
        file: `${clipId}.screen.webm`,
        mimeType: this.screenPipeline.mimeType,
        bytes: screen.bytes,
        width: this.screenPipeline.width,
        height: this.screenPipeline.height,
        audio: this.screenPipeline.audioSource,
        syncMarks: screen.syncMarks,
      };
    }

    const manifest: RecordingManifest = {
      clipId,
      version: 1,
      studentId: this.opts.studentId,
      sessionId: this.opts.getSessionId(),
      startedAtMs: this.clipStartedAtMs,
      endedAtMs: Date.now(),
      triggeredAtMs: this.clipTriggeredAtMs,
      endReason: reason,
      quality: this.opts.settings.quality,
      tracks,
    };

    this.clipId = null;
    this.setStatus({ clipOpen: false });

    // Back to idle pre-roll BEFORE the store is asked to finish: `finish`
    // rewrites both files into seekable ones, which is a pass over every byte
    // of the clip, and the next interaction must not have to wait for it.
    if (reason !== "stopped") {
      this.cameraPipeline?.startIdle();
      this.screenPipeline?.startIdle();
    }

    const done = await this.opts.bridge.finish({
      clipId, manifest,
      maxStorageMb: this.opts.settings.maxStorageMb,
      maxAgeDays: this.opts.settings.maxAgeDays,
    });
    if (done.ok) {
      this.setStatus({
        totalBytes: done.totalBytes,
        clipCount: done.clipCount,
        // A shortfall means even one clip does not fit the budget — the
        // caretaker set it too low for the quality they asked for, and only
        // they can resolve that.
        error: done.shortfallBytes > 0
          ? "storage budget is too small for one clip"
          : this.status.error,
      });
    }
  }

  /** Stop everything and finish any open clip. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }

    const { action } = stopGate(this.gate, Date.now());
    this.gate = { openedAtMs: null, lastActivityMs: this.gate.lastActivityMs };
    if (action.kind === "close") {
      this.queue(() => this.closeClip("stopped"));
    }
    await this.transition;

    this.cameraPipeline?.teardown();
    this.screenPipeline?.teardown();
    this.cameraPipeline = null;
    this.screenPipeline = null;

    // Only our own captures get stopped. The camera track belongs to the
    // shared provider — stopping it would take the camera away from face
    // tracking and the Observer.
    for (const t of this.micStream?.getTracks() ?? []) t.stop();
    for (const t of this.screenStream?.getTracks() ?? []) t.stop();
    this.micStream = null;
    this.screenStream = null;

    // Hand the shared camera back at its usual size.
    if (this.cameraTrack && this.opts.settings.quality !== "720p") {
      try {
        await this.cameraTrack.applyConstraints(cameraConstraintsFor("720p"));
      } catch { /* the next consumer will cope with whatever it is */ }
    }
    this.cameraTrack = null;

    this.setStatus({ running: false, clipOpen: false });
  }
}
