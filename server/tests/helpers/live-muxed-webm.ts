/**
 * Build a WebM shaped exactly the way `MediaRecorder` writes one.
 *
 * That shape is the whole point: a live muxer cannot know the file's length or
 * where its clusters end while it is still writing, so it leaves the Segment
 * size UNKNOWN, omits `Duration` from `Info`, and leaves every Cluster size
 * UNKNOWN too. Anything testing the recording pipeline has to start from a file
 * with those holes in it, not from a well-formed one.
 *
 * Written against the real clips the AAC recorder produced.
 */

export const WEBM_ID = {
  EBML: 0x1a45dfa3, DOCTYPE: 0x4282, SEGMENT: 0x18538067, SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966, TIMECODE_SCALE: 0x2ad7b1, MUXING_APP: 0x4d80, DURATION: 0x4489,
  TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae, TRACK_NUMBER: 0xd7, TRACK_TYPE: 0x83,
  CLUSTER: 0x1f43b675, TIMECODE: 0xe7, SIMPLE_BLOCK: 0xa3,
  CUES: 0x1c53bb6b, CUE_POINT: 0xbb, CUE_TIME: 0xb3, CUE_TRACK_POSITIONS: 0xb7,
  CUE_TRACK: 0xf7, CUE_CLUSTER_POSITION: 0xf1,
} as const;

function idBytes(id: number): Buffer {
  const len = id <= 0xff ? 1 : id <= 0xffff ? 2 : id <= 0xffffff ? 3 : 4;
  const buf = Buffer.alloc(len);
  buf.writeUIntBE(id, 0, len);
  return buf;
}

function sizeBytes(value: number): Buffer {
  for (let width = 1; width <= 8; width++) {
    if (value < 2 ** (7 * width) - 1) {
      const full = Buffer.alloc(8);
      full.writeBigUInt64BE((BigInt(value) | (1n << BigInt(7 * width))) << BigInt(8 * (8 - width)));
      return full.subarray(0, width);
    }
  }
  throw new Error("size too large");
}

/** An element with a known size. */
export function webmElement(id: number, payload: Buffer): Buffer {
  return Buffer.concat([idBytes(id), sizeBytes(payload.length), payload]);
}

/** An element whose size is UNKNOWN — what a live muxer writes. */
function openElement(id: number, payload: Buffer): Buffer {
  return Buffer.concat([idBytes(id), Buffer.from([0xff]), payload]);
}

function uint(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
}

/** A SimpleBlock body: track vint, int16 offset, flags, then frame bytes. */
function simpleBlock(track: number, relTime: number, keyframe: boolean, size: number): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0x80 | track;
  head.writeInt16BE(relTime, 1);
  head[3] = keyframe ? 0x80 : 0x00;
  // Recognizable filler, so a byte-for-byte comparison after a rewrite means
  // something.
  return Buffer.concat([head, Buffer.alloc(size, (track * 16 + (relTime % 251)) & 0xff)]);
}

export interface ClusterSpec {
  timecode: number;
  /** [track, relative time, keyframe] per block. */
  blocks: Array<[number, number, boolean]>;
}

/** One cluster's payload — the part a rewrite must reproduce exactly. */
export function clusterPayload(cluster: ClusterSpec, frameBytes = 200): Buffer {
  return Buffer.concat([
    webmElement(WEBM_ID.TIMECODE, uint(cluster.timecode)),
    ...cluster.blocks.map(([track, rel, key]) =>
      webmElement(WEBM_ID.SIMPLE_BLOCK, simpleBlock(track, rel, key, frameBytes))),
  ]);
}

export const DEFAULT_CLUSTERS: ClusterSpec[] = [
  { timecode: 0, blocks: [[1, 0, true], [2, 0, true], [1, 33, false], [1, 66, false]] },
  { timecode: 1000, blocks: [[1, 0, false], [2, 5, true], [1, 33, false]] },
  { timecode: 2000, blocks: [[1, 0, true], [1, 33, false], [2, 40, true]] },
];

/**
 * A complete file in the recorder's own shape: one video track, one audio
 * track, and clusters that never announce where they end.
 */
export function liveMuxedWebm(clusters: ClusterSpec[] = DEFAULT_CLUSTERS): Buffer {
  const header = webmElement(WEBM_ID.EBML, webmElement(WEBM_ID.DOCTYPE, Buffer.from("webm", "ascii")));
  const info = webmElement(WEBM_ID.INFO, Buffer.concat([
    webmElement(WEBM_ID.TIMECODE_SCALE, uint(1_000_000)),
    webmElement(WEBM_ID.MUXING_APP, Buffer.from("Chrome", "ascii")),
  ]));
  const tracks = webmElement(WEBM_ID.TRACKS, Buffer.concat([
    webmElement(WEBM_ID.TRACK_ENTRY, Buffer.concat([
      webmElement(WEBM_ID.TRACK_NUMBER, Buffer.from([1])),
      webmElement(WEBM_ID.TRACK_TYPE, Buffer.from([1])),
    ])),
    webmElement(WEBM_ID.TRACK_ENTRY, Buffer.concat([
      webmElement(WEBM_ID.TRACK_NUMBER, Buffer.from([2])),
      webmElement(WEBM_ID.TRACK_TYPE, Buffer.from([2])),
    ])),
  ]));
  return Buffer.concat([
    header,
    openElement(WEBM_ID.SEGMENT, Buffer.concat([
      info, tracks, ...clusters.map((c) => openElement(WEBM_ID.CLUSTER, clusterPayload(c))),
    ])),
  ]);
}
