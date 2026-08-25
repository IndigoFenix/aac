/**
 * Turn a live-muxed WebM into a seekable one.
 *
 * A MediaRecorder writes its file as it goes, which means it never knows two
 * things a player wants immediately: how long the recording is, and where each
 * moment lives in the file. So it writes neither. Its Segment carries an
 * UNKNOWN size, its Info block has no `Duration`, its Clusters carry UNKNOWN
 * sizes, and there is no Cues index at all.
 *
 * Chrome and VLC cope by scanning; most other players do not. Windows Media
 * Player shows the picture and a dead timer bar — no length, no scrubbing, no
 * skipping ahead — which makes the footage nearly unusable for the one job it
 * has, being cut into promotional material.
 *
 * Nothing can fix that while recording: the numbers only exist once the last
 * frame is in. So each finished clip is rewritten once, here, in the main
 * process:
 *
 *   • the Segment gets a real size,
 *   • Info gets a real `Duration`,
 *   • every Cluster gets a real size,
 *   • a Cues index is appended, one entry per keyframe cluster,
 *   • a SeekHead at the front points at Info, Tracks and Cues.
 *
 * The frame data itself is copied through byte for byte — this re-muxes, it
 * never re-encodes, so nothing about the picture or sound changes and the pass
 * runs at disk speed.
 *
 * FAILURE IS ALWAYS "KEEP THE ORIGINAL". The rewrite goes to a temp file and
 * only replaces the clip once it is complete. A file this module cannot parse
 * (a truncated crash leftover, a container Chromium changes under us in some
 * later version) is left exactly as it was: an unseekable clip is a nuisance,
 * a destroyed one is irreplaceable footage of a child.
 */

import fs from "fs";

// ---------------------------------------------------------------------------
// EBML ids
// ---------------------------------------------------------------------------

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  SEEK: 0x4dbb,
  SEEK_ID: 0x53ab,
  SEEK_POSITION: 0x53ac,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  POSITION: 0xa7,
  PREV_SIZE: 0xab,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  SILENT_TRACKS: 0x5854,
  VOID: 0xec,
  CRC32: 0xbf,
  CUES: 0x1c53bb6b,
  CUE_POINT: 0xbb,
  CUE_TIME: 0xb3,
  CUE_TRACK_POSITIONS: 0xb7,
  CUE_TRACK: 0xf7,
  CUE_CLUSTER_POSITION: 0xf1,
} as const;

/** Elements that legitimately live inside a Cluster. Anything else ends it —
 *  which is the only way to find the end of an UNKNOWN-sized cluster. */
const CLUSTER_CHILDREN = new Set<number>([
  ID.TIMECODE, ID.POSITION, ID.PREV_SIZE, ID.SIMPLE_BLOCK,
  ID.BLOCK_GROUP, ID.SILENT_TRACKS, ID.VOID, ID.CRC32,
]);

const TRACK_TYPE_VIDEO = 1;

/** Read window. Big enough that element headers never straddle a refill. */
const READ_CHUNK = 1 << 20;
/** Copy buffer for the payload passthrough. */
const COPY_CHUNK = 4 << 20;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** An EBML id encodes its own width in its leading bits, so its byte length
 *  falls straight out of its magnitude. */
function idLength(id: number): number {
  if (id <= 0xff) return 1;
  if (id <= 0xffff) return 2;
  if (id <= 0xffffff) return 3;
  return 4;
}

function encodeId(id: number): Buffer {
  const len = idLength(id);
  const buf = Buffer.alloc(len);
  buf.writeUIntBE(id, 0, len);
  return buf;
}

/**
 * Encode a size vint at a chosen width. The sizes whose values are not known
 * until the layout is complete are written at a FIXED width, which is legal
 * EBML and is what lets the whole file be laid out arithmetically before a
 * single byte is written.
 */
function encodeSize(value: number, width: number): Buffer {
  const full = Buffer.alloc(8);
  const marker = 1n << BigInt(7 * width);
  full.writeBigUInt64BE((BigInt(value) | marker) << BigInt(8 * (8 - width)));
  return full.subarray(0, width);
}

/** Smallest legal width for a size — all-ones is reserved for UNKNOWN, so a
 *  value that would fill the field exactly needs one more byte. */
function sizeWidth(value: number): number {
  for (let w = 1; w <= 8; w++) {
    if (value < 2 ** (7 * w) - 1) return w;
  }
  return 8;
}

function element(id: number, payload: Buffer, sizeBytes?: number): Buffer {
  const width = sizeBytes ?? sizeWidth(payload.length);
  return Buffer.concat([encodeId(id), encodeSize(payload.length, width), payload]);
}

/** Fixed-width 8-byte unsigned int. Leading zeros are legal, and they keep
 *  every element written here a constant size regardless of its value. */
function uint8Payload(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.max(0, Math.round(value))));
  return buf;
}

function floatPayload(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(value);
  return buf;
}

/** Read one EBML element header out of an in-memory buffer. */
function readHeader(
  buf: Buffer, off: number,
): { id: number; size: number; body: number } | null {
  const first = buf[off];
  if (first === undefined || first === 0) return null;
  let idLen = 0;
  for (let m = 0x80; m > 0; m >>= 1) {
    idLen++;
    if (first & m) break;
  }
  if (idLen > 4 || off + idLen > buf.length) return null;
  const id = buf.readUIntBE(off, idLen);
  let at = off + idLen;
  const sFirst = buf[at];
  if (sFirst === undefined || sFirst === 0) return null;
  let sLen = 0;
  for (let m = 0x80; m > 0; m >>= 1) {
    sLen++;
    if (sFirst & m) break;
  }
  if (sLen > 8 || at + sLen > buf.length) return null;
  let size = sFirst & (0xff >> sLen);
  for (let i = 1; i < sLen; i++) size = size * 256 + buf[at + i];
  at += sLen;
  if (at + size > buf.length) return null;
  return { id, size, body: at };
}

/** Iterate the direct children of a master element's payload. */
function eachChild(payload: Buffer, visit: (id: number, body: Buffer) => void): void {
  let off = 0;
  while (off < payload.length) {
    const header = readHeader(payload, off);
    if (!header) return;
    visit(header.id, payload.subarray(header.body, header.body + header.size));
    off = header.body + header.size;
  }
}

function toUint(buf: Buffer): number {
  return buf.reduce((acc, byte) => acc * 256 + byte, 0);
}

// ---------------------------------------------------------------------------
// Sequential reader
// ---------------------------------------------------------------------------

class Reader {
  private buf: Buffer = Buffer.alloc(0);
  /** Absolute offset of buf[0]. */
  private base = 0;
  private idx = 0;

  constructor(private readonly fh: fs.promises.FileHandle, readonly size: number) {}

  get pos(): number {
    return this.base + this.idx;
  }

  /** Make at least `n` bytes available at the cursor. False at end of file. */
  private async fill(n: number): Promise<boolean> {
    if (this.buf.length - this.idx >= n) return true;
    const keep = this.buf.subarray(this.idx);
    const at = this.base + this.idx + keep.length;
    const want = Math.max(n - keep.length, READ_CHUNK);
    const next = Buffer.alloc(want);
    const { bytesRead } = await this.fh.read(next, 0, want, at);
    this.base = this.base + this.idx;
    this.idx = 0;
    this.buf = bytesRead > 0 ? Buffer.concat([keep, next.subarray(0, bytesRead)]) : Buffer.from(keep);
    return this.buf.length >= n;
  }

  async atEnd(): Promise<boolean> {
    return !(await this.fill(1));
  }

  async readId(): Promise<number | null> {
    if (!(await this.fill(1))) return null;
    const first = this.buf[this.idx];
    if (first === 0) return null;
    let len = 0;
    for (let m = 0x80; m > 0; m >>= 1) {
      len++;
      if (first & m) break;
    }
    if (len > 4 || !(await this.fill(len))) return null;
    const id = this.buf.readUIntBE(this.idx, len);
    this.idx += len;
    return id;
  }

  async readSize(): Promise<{ value: number; unknown: boolean } | null> {
    if (!(await this.fill(1))) return null;
    const first = this.buf[this.idx];
    if (first === 0) return null;
    let len = 0;
    for (let m = 0x80; m > 0; m >>= 1) {
      len++;
      if (first & m) break;
    }
    if (len > 8 || !(await this.fill(len))) return null;
    let value = first & (0xff >> len);
    let allOnes = value === (0xff >> len);
    for (let i = 1; i < len; i++) {
      const byte = this.buf[this.idx + i];
      value = value * 256 + byte;
      if (byte !== 0xff) allOnes = false;
    }
    this.idx += len;
    return { value, unknown: allOnes };
  }

  async readBytes(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) return null;
    const out = Buffer.from(this.buf.subarray(this.idx, this.idx + n));
    this.idx += n;
    return out;
  }

  seek(abs: number): void {
    this.base = abs;
    this.idx = 0;
    this.buf = Buffer.alloc(0);
  }

  skip(n: number): void {
    if (n <= this.buf.length - this.idx) this.idx += n;
    else this.seek(this.pos + n);
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface Range {
  start: number;
  end: number;
}

interface ClusterInfo {
  payloadStart: number;
  payloadEnd: number;
  /** Cluster Timecode, in TimecodeScale units. */
  timecode: number;
  /** The cue track's first block in this cluster is a keyframe. */
  keyframe: boolean;
}

interface Scan {
  ebmlHeader: Range;
  segmentDataStart: number;
  /** Info's PAYLOAD, which is copied and extended with a Duration. */
  infoPayload: Range;
  hasDuration: boolean;
  segmentSizeKnown: boolean;
  timecodeScale: number;
  /** Whole elements copied verbatim between Info and the first cluster. */
  preClusterCopies: Range[];
  clusters: ClusterInfo[];
  cueTrack: number | null;
  /** Latest block timestamp seen, in TimecodeScale units. */
  lastBlockTicks: number;
  /** Blocks seen on the cue track — used to estimate the final frame's length. */
  cueTrackBlocks: number;
  /** The file ends mid-element; the rewrite drops everything after the last
   *  complete cluster. */
  truncated: boolean;
}

/** Read a block header far enough to get its track, timestamp and keyframe bit. */
function parseBlockHeader(
  buf: Buffer,
): { track: number; relTime: number; keyframe: boolean } | null {
  const first = buf[0];
  if (first === undefined || first === 0) return null;
  let len = 0;
  for (let m = 0x80; m > 0; m >>= 1) {
    len++;
    if (first & m) break;
  }
  if (len > 8 || buf.length < len + 3) return null;
  let track = first & (0xff >> len);
  for (let i = 1; i < len; i++) track = track * 256 + buf[i];
  return {
    track,
    relTime: buf.readInt16BE(len),
    keyframe: (buf[len + 2] & 0x80) !== 0,
  };
}

/** Pull the track numbers and types out of a Tracks payload. */
function parseTracks(payload: Buffer): Array<{ number: number; type: number }> {
  const out: Array<{ number: number; type: number }> = [];
  eachChild(payload, (id, body) => {
    if (id !== ID.TRACK_ENTRY) return;
    let number = 0;
    let type = 0;
    eachChild(body, (childId, childBody) => {
      if (childId === ID.TRACK_NUMBER) number = toUint(childBody);
      if (childId === ID.TRACK_TYPE) type = toUint(childBody);
    });
    if (number) out.push({ number, type });
  });
  return out;
}

async function scan(reader: Reader): Promise<Scan | null> {
  // ── EBML header ──
  if ((await reader.readId()) !== ID.EBML) return null;
  const ebmlSize = await reader.readSize();
  if (!ebmlSize || ebmlSize.unknown) return null;
  reader.skip(ebmlSize.value);
  const ebmlHeader: Range = { start: 0, end: reader.pos };

  // ── Segment ──
  if ((await reader.readId()) !== ID.SEGMENT) return null;
  const segSize = await reader.readSize();
  if (!segSize) return null;
  const segmentSizeKnown = !segSize.unknown;
  const segmentDataStart = reader.pos;

  let infoPayload: Range | null = null;
  let hasDuration = false;
  let timecodeScale = 1_000_000;
  const preClusterCopies: Range[] = [];
  const clusters: ClusterInfo[] = [];
  let cueTrack: number | null = null;
  let lastBlockTicks = 0;
  let cueTrackBlocks = 0;
  let truncated = false;

  while (!(await reader.atEnd())) {
    const elStart = reader.pos;
    const id = await reader.readId();
    if (id === null) { truncated = true; break; }
    const size = await reader.readSize();
    if (size === null) { truncated = true; break; }
    const payloadStart = reader.pos;

    if (id === ID.CLUSTER) {
      const cluster = await scanCluster(
        reader, size.unknown ? null : size.value, payloadStart, cueTrack,
      );
      if (!cluster) { truncated = true; break; }
      clusters.push(cluster.info);
      lastBlockTicks = Math.max(lastBlockTicks, cluster.lastTicks);
      cueTrackBlocks += cluster.cueTrackBlocks;
      if (cluster.truncated) { truncated = true; break; }
      continue;
    }

    if (size.unknown) { truncated = true; break; }
    const payloadEnd = payloadStart + size.value;
    if (payloadEnd > reader.size) { truncated = true; break; }

    if (id === ID.INFO) {
      const payload = await reader.readBytes(size.value);
      if (!payload) { truncated = true; break; }
      infoPayload = { start: payloadStart, end: payloadEnd };
      eachChild(payload, (childId, body) => {
        // TimecodeScale is read only to report the duration in real time; the
        // rewrite keeps whatever the muxer chose.
        if (childId === ID.TIMECODE_SCALE) timecodeScale = toUint(body) || timecodeScale;
        if (childId === ID.DURATION) hasDuration = true;
      });
      continue;
    }

    if (id === ID.TRACKS) {
      const payload = await reader.readBytes(size.value);
      if (!payload) { truncated = true; break; }
      const entries = parseTracks(payload);
      cueTrack = entries.find((t) => t.type === TRACK_TYPE_VIDEO)?.number
        ?? entries[0]?.number ?? null;
      preClusterCopies.push({ start: elStart, end: payloadEnd });
      continue;
    }

    // A SeekHead or Cues from an earlier pass is rebuilt, not carried over;
    // anything else sitting before the clusters (Tags, Void) rides along.
    if (id !== ID.SEEK_HEAD && id !== ID.CUES) {
      preClusterCopies.push({ start: elStart, end: payloadEnd });
    }
    reader.skip(size.value);
  }

  if (!infoPayload || !clusters.length) return null;
  return {
    ebmlHeader, segmentDataStart, infoPayload, hasDuration, segmentSizeKnown,
    timecodeScale, preClusterCopies, clusters, cueTrack, lastBlockTicks,
    cueTrackBlocks, truncated,
  };
}

/**
 * Walk one cluster's children. A live-muxed cluster has an UNKNOWN size, so its
 * end is wherever an element appears that cannot be a cluster child.
 */
async function scanCluster(
  reader: Reader,
  knownSize: number | null,
  payloadStart: number,
  cueTrack: number | null,
): Promise<
  { info: ClusterInfo; lastTicks: number; cueTrackBlocks: number; truncated: boolean } | null
> {
  let timecode = 0;
  let keyframe = false;
  let sawCueTrackBlock = false;
  let lastTicks = 0;
  let cueTrackBlocks = 0;
  let truncated = false;

  const hardEnd = knownSize === null ? reader.size : payloadStart + knownSize;
  let end = hardEnd;

  while (reader.pos < hardEnd) {
    const childStart = reader.pos;
    if (await reader.atEnd()) {
      end = childStart;
      truncated = knownSize !== null;
      break;
    }
    const id = await reader.readId();
    if (id === null) { end = childStart; truncated = true; break; }
    if (knownSize === null && !CLUSTER_CHILDREN.has(id)) {
      // The next top-level element — this cluster ended at its first byte.
      reader.seek(childStart);
      end = childStart;
      break;
    }
    const size = await reader.readSize();
    if (size === null || size.unknown) { end = childStart; truncated = true; break; }
    const bodyStart = reader.pos;
    if (bodyStart + size.value > reader.size) { end = childStart; truncated = true; break; }

    if (id === ID.TIMECODE) {
      const body = await reader.readBytes(size.value);
      if (!body) { end = childStart; truncated = true; break; }
      timecode = toUint(body);
      lastTicks = Math.max(lastTicks, timecode);
      continue;
    }

    if (id === ID.SIMPLE_BLOCK) {
      const head = await reader.readBytes(Math.min(12, size.value));
      if (!head) { end = childStart; truncated = true; break; }
      const block = parseBlockHeader(head);
      if (block) {
        lastTicks = Math.max(lastTicks, timecode + block.relTime);
        if (cueTrack !== null && block.track === cueTrack) {
          cueTrackBlocks++;
          if (!sawCueTrackBlock) {
            sawCueTrackBlock = true;
            keyframe = block.keyframe;
          }
        }
      }
      reader.seek(bodyStart + size.value);
      continue;
    }

    reader.skip(size.value);
    if (reader.pos > hardEnd) { end = childStart; truncated = true; break; }
  }

  if (end <= payloadStart) return null;
  reader.seek(end);
  return {
    info: { payloadStart, payloadEnd: end, timecode, keyframe: keyframe || cueTrack === null },
    lastTicks,
    cueTrackBlocks,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

/**
 * Wait for a full write buffer to empty. Both listeners are removed either way:
 * a clip is hundreds of writes long, and leaving one behind per wait is how a
 * long file ends up warning about a listener leak.
 */
function drain(out: fs.WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (err?: Error): void => {
      out.off("drain", onDrain);
      out.off("error", onError);
      if (err) reject(err); else resolve();
    };
    const onDrain = (): void => done();
    const onError = (err: Error): void => done(err);
    out.once("drain", onDrain);
    out.once("error", onError);
  });
}

/** Copy `[start, end)` of the source into the write stream, with backpressure. */
async function copyRange(
  fh: fs.promises.FileHandle,
  start: number,
  end: number,
  out: fs.WriteStream,
  buf: Buffer,
): Promise<void> {
  let at = start;
  while (at < end) {
    const want = Math.min(buf.length, end - at);
    const { bytesRead } = await fh.read(buf, 0, want, at);
    if (bytesRead <= 0) return;
    at += bytesRead;
    if (!out.write(Buffer.from(buf.subarray(0, bytesRead)))) await drain(out);
  }
}

export interface FinalizeResult {
  ok: boolean;
  /** Why nothing was written, or why the file was left alone. */
  reason?: "unparsable" | "already-final" | "write-failed";
  /** The file was already seekable and was not touched. */
  skipped?: boolean;
  durationMs?: number;
  clusters?: number;
  cues?: number;
  truncated?: boolean;
  bytesBefore?: number;
  bytesAfter?: number;
}

/**
 * Rewrite one WebM in place so it carries a duration, cluster sizes and a cue
 * index. Returns what happened; never throws, and never leaves the original in
 * a worse state than it found it.
 */
export async function finalizeWebmFile(file: string): Promise<FinalizeResult> {
  let fh: fs.promises.FileHandle | null = null;
  const tmp = `${file}.finalizing`;
  let replaced = false;
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size === 0) return { ok: false, reason: "unparsable" };

    fh = await fs.promises.open(file, "r");
    const info = await scan(new Reader(fh, stat.size));
    if (!info) return { ok: false, reason: "unparsable" };
    if (info.hasDuration && info.segmentSizeKnown && !info.truncated) {
      return { ok: true, skipped: true, reason: "already-final", bytesBefore: stat.size };
    }

    // ── Duration ──
    // A block timestamp marks when a frame STARTS, so the file runs one frame
    // longer than the last one seen. The cue track's own average spacing stands
    // in for that frame: a screen capture's frame rate is nothing like a
    // camera's, and neither announces itself in the container.
    const avgFrameTicks = info.cueTrackBlocks > 1
      ? info.lastBlockTicks / (info.cueTrackBlocks - 1)
      : 33;
    const durationTicks = info.lastBlockTicks + Math.min(Math.max(avgFrameTicks, 1), 200);

    // ── Layout ──
    // Every size below is written at a fixed width, so this arithmetic is exact
    // before a byte goes out and the cue positions can name where the clusters
    // are going to land.
    const infoLen = info.infoPayload.end - info.infoPayload.start;
    const read = await fh.read(Buffer.alloc(infoLen), 0, infoLen, info.infoPayload.start);
    const infoEl = element(ID.INFO, Buffer.concat([
      read.buffer.subarray(0, read.bytesRead),
      element(ID.DURATION, floatPayload(durationTicks), 1),
    ]));

    const seekEntry = (targetId: number, position: number): Buffer =>
      element(ID.SEEK, Buffer.concat([
        element(ID.SEEK_ID, encodeId(targetId)),
        element(ID.SEEK_POSITION, uint8Payload(position), 1),
      ]));
    // Built once with placeholder positions purely for its length: every field
    // is fixed width, so the real positions produce the identical size.
    const seekHeadLen = element(ID.SEEK_HEAD, Buffer.concat([
      seekEntry(ID.INFO, 0), seekEntry(ID.TRACKS, 0), seekEntry(ID.CUES, 0),
    ])).length;

    const posInfo = seekHeadLen;
    // Tracks is the first element copied verbatim after Info.
    const posTracks = posInfo + infoEl.length;
    const preClusterLen = info.preClusterCopies.reduce((sum, r) => sum + (r.end - r.start), 0);

    const clusterHeaderLen = idLength(ID.CLUSTER) + 8;
    const clusterPositions: number[] = [];
    let cursor = posTracks + preClusterLen;
    for (const cluster of info.clusters) {
      clusterPositions.push(cursor);
      cursor += clusterHeaderLen + (cluster.payloadEnd - cluster.payloadStart);
    }
    const posCues = cursor;

    const cueTrackNumber = info.cueTrack ?? 1;
    const cuePoints: Buffer[] = [];
    info.clusters.forEach((cluster, index) => {
      // Seeking lands on a cluster and decodes forward, so a cue is only useful
      // where the picture can actually restart: a keyframe. The first cluster is
      // always cued so a player has somewhere to seek to at all.
      if (!cluster.keyframe && index !== 0) return;
      cuePoints.push(element(ID.CUE_POINT, Buffer.concat([
        element(ID.CUE_TIME, uint8Payload(cluster.timecode), 1),
        element(ID.CUE_TRACK_POSITIONS, Buffer.concat([
          element(ID.CUE_TRACK, uint8Payload(cueTrackNumber), 1),
          element(ID.CUE_CLUSTER_POSITION, uint8Payload(clusterPositions[index]), 1),
        ])),
      ])));
    });
    const cuesEl = element(ID.CUES, Buffer.concat(cuePoints), 8);
    const segmentSize = posCues + cuesEl.length;

    const seekHead = element(ID.SEEK_HEAD, Buffer.concat([
      seekEntry(ID.INFO, posInfo),
      seekEntry(ID.TRACKS, posTracks),
      seekEntry(ID.CUES, posCues),
    ]));

    // ── Write ──
    const out = fs.createWriteStream(tmp, { flags: "w" });
    // A permanent listener so a write error is never an uncaught event between
    // the temporary ones `drain` puts on; what actually handles it is the catch
    // around all of this, which leaves the original file untouched.
    out.on("error", () => { /* handled below */ });
    const copyBuf = Buffer.alloc(COPY_CHUNK);
    const write = async (buf: Buffer): Promise<void> => {
      if (!out.write(buf)) await drain(out);
    };

    await copyRange(fh, info.ebmlHeader.start, info.ebmlHeader.end, out, copyBuf);
    await write(Buffer.concat([encodeId(ID.SEGMENT), encodeSize(segmentSize, 8)]));
    await write(seekHead);
    await write(infoEl);
    for (const range of info.preClusterCopies) {
      await copyRange(fh, range.start, range.end, out, copyBuf);
    }
    for (const cluster of info.clusters) {
      await write(Buffer.concat([
        encodeId(ID.CLUSTER),
        encodeSize(cluster.payloadEnd - cluster.payloadStart, 8),
      ]));
      await copyRange(fh, cluster.payloadStart, cluster.payloadEnd, out, copyBuf);
    }
    await write(cuesEl);

    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
    await fh.close();
    fh = null;

    const after = await fs.promises.stat(tmp);
    await fs.promises.rename(tmp, file);
    replaced = true;
    return {
      ok: true,
      durationMs: (durationTicks * info.timecodeScale) / 1_000_000,
      clusters: info.clusters.length,
      cues: cuePoints.length,
      truncated: info.truncated,
      bytesBefore: stat.size,
      bytesAfter: after.size,
    };
  } catch {
    return { ok: false, reason: "write-failed" };
  } finally {
    if (fh) {
      try { await fh.close(); } catch { /* already gone */ }
    }
    if (!replaced) {
      try { await fs.promises.unlink(tmp); } catch { /* only exists after a failure */ }
    }
  }
}
