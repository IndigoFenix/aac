/**
 * webm-finalize.test.ts — Making a MediaRecorder's WebM seekable.
 *
 * A live-muxed WebM has no duration, no cluster sizes and no cue index, which
 * is why the recorded clips opened with a dead timer bar. These tests build the
 * exact shape MediaRecorder emits (they were written against the real files:
 * Segment size UNKNOWN, Info with a TimecodeScale and no Duration, clusters
 * with UNKNOWN sizes), run the finalizer over it, and check both halves of the
 * contract: the file gains what a player needs, and every byte of picture and
 * sound comes through untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { finalizeWebmFile } from "../../electron/hardware/webm-finalize.js";
import {
  DEFAULT_CLUSTERS as CLUSTERS,
  WEBM_ID as ID,
  clusterPayload,
  liveMuxedWebm,
} from "./helpers/live-muxed-webm.js";

// ---------------------------------------------------------------------------
// A minimal reader for the assertions
// ---------------------------------------------------------------------------

interface Parsed {
  id: number;
  size: number;
  unknown: boolean;
  /** Offset of the payload's first byte. */
  body: number;
  end: number;
}

function readElement(buf: Buffer, off: number): Parsed {
  const first = buf[off];
  let idLen = 0;
  for (let m = 0x80; m > 0; m >>= 1) { idLen++; if (first & m) break; }
  const id = buf.readUIntBE(off, idLen);
  let at = off + idLen;
  const sFirst = buf[at];
  let sLen = 0;
  for (let m = 0x80; m > 0; m >>= 1) { sLen++; if (sFirst & m) break; }
  let size = sFirst & (0xff >> sLen);
  let allOnes = size === (0xff >> sLen);
  for (let i = 1; i < sLen; i++) {
    size = size * 256 + buf[at + i];
    if (buf[at + i] !== 0xff) allOnes = false;
  }
  at += sLen;
  return { id, size, unknown: allOnes, body: at, end: allOnes ? buf.length : at + size };
}

/** Every direct child of a master element's payload. */
function children(buf: Buffer, start: number, end: number): Parsed[] {
  const out: Parsed[] = [];
  let off = start;
  while (off < end) {
    const el = readElement(buf, off);
    out.push(el);
    off = el.end;
    if (el.unknown) break;
  }
  return out;
}

function segmentOf(buf: Buffer): { start: number; el: Parsed } {
  const header = readElement(buf, 0);
  return { start: readElement(buf, header.end).body, el: readElement(buf, header.end) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("finalizeWebmFile", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "webm-finalize-"));
    file = path.join(dir, "clip.camera.webm");
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("gives the segment a real size and the file a duration", async () => {
    await fs.promises.writeFile(file, liveMuxedWebm());
    const result = await finalizeWebmFile(file);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeFalsy();

    const out = await fs.promises.readFile(file);
    const { el: segment, start } = segmentOf(out);
    expect(segment.unknown).toBe(false);
    // The segment must claim exactly the rest of the file — a player that
    // trusts the size and finds it short stops early.
    expect(start + segment.size).toBe(out.length);

    const info = children(out, start, out.length).find((c) => c.id === ID.INFO);
    expect(info).toBeDefined();
    const duration = children(out, info!.body, info!.end).find((c) => c.id === ID.DURATION);
    expect(duration).toBeDefined();
    // Last block sits at 2040 ms; the duration runs one frame past it, and that
    // frame is estimated from the video track's own spacing.
    const seconds = out.readDoubleBE(duration!.body);
    expect(seconds).toBeGreaterThan(2040);
    expect(seconds).toBeLessThan(2350);
    expect(result.durationMs).toBeCloseTo(seconds, 3);
  });

  it("indexes the key-frame clusters and points a SeekHead at the index", async () => {
    await fs.promises.writeFile(file, liveMuxedWebm());
    const result = await finalizeWebmFile(file);
    expect(result.clusters).toBe(3);
    // Clusters 0 and 2 open on a key frame; cluster 1 does not, and seeking to
    // it would land a player on a picture it cannot start decoding.
    expect(result.cues).toBe(2);

    const out = await fs.promises.readFile(file);
    const { start } = segmentOf(out);
    const top = children(out, start, out.length);
    const cues = top.find((c) => c.id === ID.CUES);
    expect(cues).toBeDefined();

    const points = children(out, cues!.body, cues!.end);
    expect(points).toHaveLength(2);
    const positions = points.map((point) => {
      const inner = children(out, point.body, point.end);
      const time = inner.find((c) => c.id === ID.CUE_TIME)!;
      const track = children(
        out,
        inner.find((c) => c.id === ID.CUE_TRACK_POSITIONS)!.body,
        inner.find((c) => c.id === ID.CUE_TRACK_POSITIONS)!.end,
      );
      return {
        time: Number(out.readBigUInt64BE(time.body)),
        track: Number(out.readBigUInt64BE(track.find((c) => c.id === ID.CUE_TRACK)!.body)),
        at: Number(out.readBigUInt64BE(
          track.find((c) => c.id === ID.CUE_CLUSTER_POSITION)!.body,
        )),
      };
    });
    expect(positions.map((p) => p.time)).toEqual([0, 2000]);
    // The cue track is the VIDEO track: seeking to an audio packet is useless.
    expect(positions.map((p) => p.track)).toEqual([1, 1]);
    // A cue position is relative to the segment's payload, and must actually
    // land on a cluster — this is the assertion that catches an off-by-header.
    for (const position of positions) {
      expect(readElement(out, start + position.at).id).toBe(ID.CLUSTER);
    }

    const seekHead = top.find((c) => c.id === ID.SEEK_HEAD);
    expect(seekHead).toBeDefined();
    const seekPositions = children(out, seekHead!.body, seekHead!.end).map((seek) => {
      const inner = children(out, seek.body, seek.end);
      const target = inner[0];
      return {
        id: out.readUIntBE(target.body, target.size),
        at: Number(out.readBigUInt64BE(inner[1].body)),
      };
    });
    for (const entry of seekPositions) {
      expect(readElement(out, start + entry.at).id).toBe(entry.id);
    }
    expect(seekPositions.map((s) => s.id)).toEqual([ID.INFO, ID.TRACKS, ID.CUES]);
  });

  it("closes every cluster and passes the frame data through untouched", async () => {
    await fs.promises.writeFile(file, liveMuxedWebm());
    await finalizeWebmFile(file);
    const out = await fs.promises.readFile(file);

    // Compared against what was encoded rather than against the source file:
    // the source's clusters have UNKNOWN sizes, so a reader cannot tell where
    // one ends without doing the very block walk under test here.
    const before = CLUSTERS.map((cluster) => clusterPayload(cluster));
    const { start: segStart } = segmentOf(out);
    const after = children(out, segStart, out.length)
      .filter((c) => c.id === ID.CLUSTER)
      .map((c) => out.subarray(c.body, c.end));
    expect(after).toHaveLength(before.length);
    for (const [index, payload] of after.entries()) {
      expect(payload.equals(before[index])).toBe(true);
    }
    // Every cluster now declares its length, which is what lets a player jump
    // from one to the next instead of scanning block by block.
    const { start } = segmentOf(out);
    for (const cluster of children(out, start, out.length).filter((c) => c.id === ID.CLUSTER)) {
      expect(cluster.unknown).toBe(false);
    }
  });

  it("keeps the complete clusters of a file cut off mid-write", async () => {
    // What a crash or a power loss leaves behind: the last chunk stops partway
    // through an element. The footage before it is not reproducible, so it is
    // kept and only the unreadable tail is dropped.
    const source = liveMuxedWebm();
    await fs.promises.writeFile(file, Buffer.concat([source, Buffer.from([0xa3, 0x9f, 0x81])]));
    const result = await finalizeWebmFile(file);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.clusters).toBe(3);

    const out = await fs.promises.readFile(file);
    const { start, el: segment } = segmentOf(out);
    expect(start + segment.size).toBe(out.length);
  });

  it("leaves an already-finalized file alone", async () => {
    await fs.promises.writeFile(file, liveMuxedWebm());
    await finalizeWebmFile(file);
    const once = await fs.promises.readFile(file);

    const again = await finalizeWebmFile(file);
    expect(again.ok).toBe(true);
    expect(again.skipped).toBe(true);
    // Byte-identical: re-running the pass on every app start (the orphan sweep
    // does) must not rewrite gigabytes of footage that is already correct.
    expect((await fs.promises.readFile(file)).equals(once)).toBe(true);
  });

  it("refuses to touch a file it cannot parse", async () => {
    const junk = Buffer.from("this is not a webm at all", "utf8");
    await fs.promises.writeFile(file, junk);
    const result = await finalizeWebmFile(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unparsable");
    expect((await fs.promises.readFile(file)).equals(junk)).toBe(true);
    // And no temp file left lying around to be counted against the disk budget.
    expect(await fs.promises.readdir(dir)).toEqual(["clip.camera.webm"]);
  });

  it("handles a video-only file, which is what the screen capture was", async () => {
    const videoOnly = liveMuxedWebm([
      { timecode: 0, blocks: [[1, 0, true], [1, 33, false]] },
      { timecode: 500, blocks: [[1, 0, true]] },
    ]);
    await fs.promises.writeFile(file, videoOnly);
    const result = await finalizeWebmFile(file);
    expect(result.ok).toBe(true);
    expect(result.cues).toBe(2);
  });
});
