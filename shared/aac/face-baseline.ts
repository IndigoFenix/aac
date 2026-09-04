// shared/aac/face-baseline.ts
//
// L2 of the face decoder, and the layer the accuracy actually comes from:
// score every channel against THIS CHILD'S OWN distribution instead of against
// a global constant.
//
// WHY. D8: every threshold in the decoder this replaces is a global constant,
// and this population's resting face is not the population mean the blendshape
// model was regressed on — hypotonia, an habitually open mouth, bruxism, gaze
// apraxia, midline hand stereotypies that occlude the lower face. A global
// `jawOpen > 0.5` on a child whose mouth rests open reports "mouth open"
// continuously and forever. The prod measurement makes it concrete: "brows
// raised" fired on 23% of one student's frames and 0% of both other subjects'.
// Whether that is her habitual posture, her forehead, or the model misreading
// her does not matter — it is a CONSTANT OF THAT PERSON, so it carries no
// information about her state, and the Observer was being told about it on
// every single turn.
//
// The literature is unanimous on the fix and on where it pays: person-specific
// normalization against the subject's own neutral, with the reported gains
// concentrated exactly where we live — low-to-mid-intensity expressions close
// to neutral. "Her brow is raised well beyond her usual" is a statement a
// clinician or an LLM can act on. "brow_raise 0.42" is not.
//
// ---------------------------------------------------------------------------
// WHY A HISTOGRAM, AND WHY MEDIAN/MAD
// ---------------------------------------------------------------------------
//
// The statistic is the MEDIAN and the MEDIAN ABSOLUTE DEVIATION, not the mean
// and standard deviation. Expressions are a minority of frames, so the median
// over everything is a good estimator of the resting face — but only if it is
// robust, and a mean is not: a two-minute smile drags a mean and then the smile
// stops registering as one.
//
// The storage is a fixed-range HISTOGRAM per channel rather than a reservoir of
// samples or a streaming quantile estimate, because a histogram is the only one
// of the three that is EXACTLY MERGEABLE — merging two sessions is adding
// counts, with no order dependence and no step-size to tune. That also makes
// the cross-session accumulation trivially correct, which matters: the
// head-neutral profile needed a page of weighting rules to get the same
// property. The cost is quantization, which is bounded and known (one bin at
// the median), and the MAD floor below is set to exactly that so nothing ever
// claims precision the bins cannot support.
//
// Adaptivity comes from CAPPING, the same idea as NEUTRAL_MEMORY_CAP: a stored
// channel counts at most FACE_MEMORY_CAP samples when new evidence arrives, so
// a face that genuinely changes over months eventually wins, and one long
// session can never dominate.
//
// ⚠️ MACHINE-WRITTEN. Stored under `aac_settings.learnedBaselines.face` and
// kept out of the AI-editable whitelist — see learned-baselines.ts.

import {
  channelRange, channelAttenuated,
  type FaceChannel,
} from "./face-aus";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bins per channel. Small enough that a whole profile is a couple of kilobytes
 *  of jsonb; the resolution that matters comes from the WARP below, not from
 *  the count. */
export const FACE_BASELINE_BINS = 32;

// ---------------------------------------------------------------------------
// WARPED BINS FOR ACTION UNITS
// ---------------------------------------------------------------------------
//
// AU intensities are not uniformly distributed over 0..1 — they pile up near
// zero, and several channels in this model never leave the bottom few percent
// at all. With 32 LINEAR bins the entire distribution of such a channel falls
// inside bin 0, its measured spread is zero, the MAD floor takes over, and no
// value can ever score more than ~1.7 sigma. That would defeat the point of
// the whole layer: personalised scoring exists precisely so an ATTENUATED
// channel stays usable (an attenuated channel is not a dead one — D2).
//
// So AU channels are binned on sqrt(intensity): the same 32 bins, but the ones
// near zero are ~30x finer in value, which is where the resolution is needed.
// Geometry channels are unbounded person-relative ratios with no pile-up at an
// end, so they stay linear.
//
// Everything OUTSIDE this section works in value space — binCenter un-warps —
// so the median and MAD are ordinary values and only the resolution changes.

const isWarped = (channel: FaceChannel): boolean => channel.startsWith("au:");

/** Value → 0..1 bin-space position. */
function warp(channel: FaceChannel, value: number): number {
  const { min, max } = channelRange(channel);
  if (!(max > min)) return 0;
  const t = (value - min) / (max - min);
  const c = Math.max(0, Math.min(1, t));
  return isWarped(channel) ? Math.sqrt(c) : c;
}

/** 0..1 bin-space position → value. */
function unwarp(channel: FaceChannel, t: number): number {
  const { min, max } = channelRange(channel);
  const c = Math.max(0, Math.min(1, t));
  return min + (isWarped(channel) ? c * c : c) * (max - min);
}

/** How wide, IN VALUE, the bin containing this value is. The honest resolution
 *  limit at that point of the scale, and therefore the MAD floor. */
function localBinWidth(channel: FaceChannel, value: number): number {
  const b = binOf(channel, value);
  const w = unwarp(channel, (b + 1) / FACE_BASELINE_BINS) - unwarp(channel, b / FACE_BASELINE_BINS);
  return w > 0 ? w : 1e-6;
}

/** Samples before the accumulated baseline is fully trusted. At the tracker's
 *  ~3 Hz that is about two minutes of readable face time. */
export const FACE_BASELINE_MIN_SAMPLES = 400;
/** Sessions needed alongside — the guard the sample count cannot provide. A
 *  huge n from one sitting describes one sitting. */
export const FACE_BASELINE_MIN_SESSIONS = 3;
/** Below this many samples a session says nothing and is discarded whole. */
export const FACE_SESSION_MIN_SAMPLES = 60;
/** One session contributes at most this much weight, however long it ran. */
export const FACE_SESSION_WEIGHT_CAP = 600;
/** The stored profile counts at most this much when weighing new evidence, so
 *  the baseline stays adaptive over months instead of freezing. */
export const FACE_MEMORY_CAP = 6_000;
/** MAD floor, in BIN WIDTHS at the median. One bin: the histogram cannot
 *  resolve a spread narrower than that, so claiming one would be inventing
 *  precision. This is also what keeps z finite on a channel that never moves.
 *  Measured LOCALLY because AU bins are not uniform in value — see warping. */
export const FACE_MAD_FLOOR_BINS = 1;
/** z is clamped here. Past it the number is meaningless anyway, and an
 *  unclamped z from a pinned channel would dominate every ranking. */
export const FACE_Z_CLAMP = 12;
/** A channel with this many samples and no observed spread at all is DEAD in
 *  this model for this person, and is excluded from composites — D2's actual
 *  fix, as opposed to hoping the threshold is low enough. */
export const CHANNEL_DEAD_MIN_SAMPLES = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Sparse histogram: bin index (as a string key, because this is jsonb) → count.
 *  Sparse because most channels rest in two or three bins, so a dense array
 *  would be mostly zeros on the wire. */
export interface ChannelHistogram {
  bins: Record<string, number>;
  n: number;
}

/** One student's learned facial distribution. */
export interface FaceBaselineProfile {
  channels: Record<FaceChannel, ChannelHistogram>;
  /** Total quality-gated frames across every session. */
  n: number;
  /** Distinct sessions that contributed. */
  sessions: number;
  updatedAt: string;
}

/** What one session observed, before merging. Same shape minus the bookkeeping. */
export interface SessionFaceObservation {
  channels: Record<FaceChannel, ChannelHistogram>;
  n: number;
}

export interface ChannelStats {
  /** Robust centre — this person's usual value for this channel. */
  median: number;
  /** Median absolute deviation, FLOORED at one bin width. */
  mad: number;
  /** The unfloored MAD, for the dead-channel test. */
  rawMad: number;
  /** Samples behind these numbers. */
  n: number;
  /** True when the channel has never been observed to move. Excluded from
   *  composites; see D2. */
  dead: boolean;
}

// ---------------------------------------------------------------------------
// Histogram primitives
// ---------------------------------------------------------------------------

export const emptyHistogram = (): ChannelHistogram => ({ bins: {}, n: 0 });

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Bin index for a value. Out-of-range values are CLAMPED into the end bins:
 *  an extreme is still evidence of an extreme, and dropping it would bias the
 *  distribution inward. */
export function binOf(channel: FaceChannel, value: number): number {
  return Math.max(0, Math.min(
    FACE_BASELINE_BINS - 1,
    Math.floor(warp(channel, value) * FACE_BASELINE_BINS),
  ));
}

/** Value at the centre of a bin. */
export function binCenter(channel: FaceChannel, bin: number): number {
  return unwarp(channel, (bin + 0.5) / FACE_BASELINE_BINS);
}

/** Record one sample. Mutates — this runs per channel per frame. */
export function observeChannel(hist: ChannelHistogram, channel: FaceChannel, value: number): void {
  if (!isNum(value)) return;
  const b = String(binOf(channel, value));
  hist.bins[b] = (hist.bins[b] ?? 0) + 1;
  hist.n++;
}

/** Non-empty bins, ascending, as [index, count]. */
function sortedBins(hist: ChannelHistogram): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [k, v] of Object.entries(hist.bins)) {
    const i = Number(k);
    if (Number.isInteger(i) && isNum(v) && v > 0) out.push([i, v]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Weighted quantile over the histogram, with linear interpolation INSIDE the
 *  containing bin so the estimate is not quantized to bin centres. */
function quantile(hist: ChannelHistogram, channel: FaceChannel, q: number): number {
  const bins = sortedBins(hist);
  const total = bins.reduce((a, b) => a + b[1], 0);
  if (total <= 0) return binCenter(channel, 0);
  const target = q * total;
  let cum = 0;
  for (const [idx, count] of bins) {
    if (cum + count >= target) {
      const frac = count > 0 ? (target - cum) / count : 0.5;
      // Interpolate in BIN space, then un-warp once — interpolating in value
      // space across a warped bin would bias every quantile outward.
      return unwarp(channel, (idx + Math.max(0, Math.min(1, frac))) / FACE_BASELINE_BINS);
    }
    cum += count;
  }
  return unwarp(channel, (bins[bins.length - 1][0] + 1) / FACE_BASELINE_BINS);
}

/**
 * Median, MAD and liveness for one channel.
 *
 * The MAD is a weighted median of |bin centre − median|, which is exact up to
 * the bin quantization and needs no second pass over samples we no longer have.
 */
export function channelStats(hist: ChannelHistogram | undefined, channel: FaceChannel): ChannelStats {
  if (!hist || hist.n <= 0) {
    const zero = binCenter(channel, 0);
    return {
      median: zero,
      mad: localBinWidth(channel, zero) * FACE_MAD_FLOOR_BINS,
      rawMad: 0, n: 0, dead: false,
    };
  }
  const median = quantile(hist, channel, 0.5);
  const w = localBinWidth(channel, median);

  const devs = sortedBins(hist)
    .map(([idx, count]) => [Math.abs(binCenter(channel, idx) - median), count] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const total = devs.reduce((a, b) => a + b[1], 0);
  let cum = 0;
  let rawMad = 0;
  for (const [d, count] of devs) {
    cum += count;
    if (cum >= total / 2) { rawMad = d; break; }
  }

  // ⚠️ DEAD means "this model never produces a value for this channel", NOT
  // "this person is very consistent". The difference is the ZERO bin: an AU
  // whose entire history sits in bin 0 was never reported at all, while one
  // sitting steadily in bin 25 is a real, stable, high resting value — a
  // student whose mouth habitually rests open, say. Calling the second one dead
  // excludes it from composites AND drops it to the absolute path, which
  // reinstates D8 in full: it would be reported as "mouth open" on every frame
  // forever, which is the exact failure this layer exists to fix.
  //
  // Only AU channels can be dead. Geometry is computed from landmarks here, not
  // emitted by the model, so it has no attenuation failure mode — and its
  // bin 0 is a range minimum, not a zero.
  const bins = sortedBins(hist);
  return {
    median,
    mad: Math.max(rawMad, w * FACE_MAD_FLOOR_BINS),
    rawMad,
    n: hist.n,
    dead: channel.startsWith("au:")
      && hist.n >= CHANNEL_DEAD_MIN_SAMPLES
      && bins.length === 1 && bins[0][0] === 0,
  };
}

/**
 * How unusual this value is FOR THIS PERSON, in robust standard deviations.
 *
 * The 0.6745 factor is the standard MAD→σ consistency constant, so a z here is
 * on the same scale a reader expects from a z-score — which matters, because
 * this number is going into a sentence an LLM will read.
 */
export function zScore(stats: ChannelStats, value: number): number {
  if (!isNum(value) || !(stats.mad > 0)) return 0;
  const z = (0.6745 * (value - stats.median)) / stats.mad;
  return Math.max(-FACE_Z_CLAMP, Math.min(FACE_Z_CLAMP, z));
}

// ---------------------------------------------------------------------------
// Reliability and merging
// ---------------------------------------------------------------------------

/** 0..1 — how much the accumulated profile deserves to be believed. Both axes
 *  must be satisfied: samples AND distinct sessions. Mirrors
 *  neutralReliability in head-attention.ts, deliberately. */
export function faceBaselineReliability(p: FaceBaselineProfile | null | undefined): number {
  if (!p || !(p.n > 0) || !(p.sessions > 0)) return 0;
  return Math.max(0, Math.min(1, Math.min(
    p.n / FACE_BASELINE_MIN_SAMPLES,
    p.sessions / FACE_BASELINE_MIN_SESSIONS,
  )));
}

/** Scale every count by `factor`, dropping bins that round away. Used for both
 *  caps — it is the histogram equivalent of a weight. */
function scaleHistogram(hist: ChannelHistogram, factor: number): ChannelHistogram {
  if (factor >= 1) return { bins: { ...hist.bins }, n: hist.n };
  const bins: Record<string, number> = {};
  let n = 0;
  for (const [k, v] of Object.entries(hist.bins)) {
    // Round rather than floor: flooring a long tail of 1-count bins erases the
    // tail entirely, which is exactly the part that says how much this channel
    // moves.
    const scaled = Math.round(v * factor);
    if (scaled > 0) { bins[k] = scaled; n += scaled; }
  }
  return { bins, n };
}

function addHistograms(a: ChannelHistogram, b: ChannelHistogram): ChannelHistogram {
  const bins: Record<string, number> = { ...a.bins };
  for (const [k, v] of Object.entries(b.bins)) bins[k] = (bins[k] ?? 0) + v;
  return { bins, n: a.n + b.n };
}

/**
 * Merge one session's observation into the stored profile.
 *
 * Both caps apply per channel: the session is scaled down to at most
 * FACE_SESSION_WEIGHT_CAP samples, and the stored side to at most
 * FACE_MEMORY_CAP, before the counts are added. That gives the two properties
 * that matter — a first real session dominates an empty profile (correct, there
 * is nothing else), and one odd session barely moves an established one.
 *
 * A channel the session never observed is left EXACTLY as it was. Absence is
 * not a zero sample; the same rule the seizure baseline follows for a limb that
 * was out of frame.
 */
export function mergeFaceBaseline(
  stored: FaceBaselineProfile | null | undefined,
  obs: SessionFaceObservation,
  nowIso: string,
): FaceBaselineProfile | undefined {
  if (!obs || obs.n < FACE_SESSION_MIN_SAMPLES) return stored ?? undefined;

  const channels: Record<FaceChannel, ChannelHistogram> = {};
  for (const [ch, h] of Object.entries(stored?.channels ?? {})) {
    channels[ch] = { bins: { ...h.bins }, n: h.n };
  }

  for (const [ch, raw] of Object.entries(obs.channels)) {
    if (!raw || raw.n <= 0) continue;
    const incoming = scaleHistogram(raw, Math.min(1, FACE_SESSION_WEIGHT_CAP / raw.n));
    if (incoming.n <= 0) continue;
    const prior = channels[ch];
    if (!prior || prior.n <= 0) {
      channels[ch] = incoming;
      continue;
    }
    const capped = scaleHistogram(prior, Math.min(1, FACE_MEMORY_CAP / prior.n));
    channels[ch] = addHistograms(capped, incoming);
  }

  return {
    channels,
    n: (stored?.n ?? 0) + obs.n,
    sessions: (stored?.sessions ?? 0) + 1,
    updatedAt: nowIso,
  };
}

/** Tolerate anything the jsonb column might hold. Never throws, never invents
 *  data — same contract as coerceSeizureConfig. */
export function coerceFaceBaseline(raw: unknown): FaceBaselineProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, any>;
  if (!isNum(r.n) || !isNum(r.sessions) || !r.channels || typeof r.channels !== "object") return undefined;

  const channels: Record<FaceChannel, ChannelHistogram> = {};
  for (const [ch, h] of Object.entries(r.channels as Record<string, any>)) {
    if (!h || typeof h !== "object" || !h.bins || typeof h.bins !== "object") continue;
    const bins: Record<string, number> = {};
    let n = 0;
    for (const [k, v] of Object.entries(h.bins as Record<string, any>)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0 || idx >= FACE_BASELINE_BINS) continue;
      if (!isNum(v) || v <= 0) continue;
      bins[k] = v;
      n += v;
    }
    if (n > 0) channels[ch] = { bins, n };
  }
  if (Object.keys(channels).length === 0) return undefined;

  return {
    channels,
    n: Math.max(0, r.n),
    sessions: Math.max(0, r.sessions),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Session accumulator
// ---------------------------------------------------------------------------

export interface FaceBaselineAccumulator {
  /** Record one QUALITY-GATED frame. The caller owns the gate: a frame the
   *  decoder could not read must not enter the distribution, or the baseline
   *  learns what a badly-lit turned-away face looks like. */
  observe(values: Map<FaceChannel, number>): void;
  /** Live stats for a channel — the stored profile PLUS what this session has
   *  seen so far, which is what makes a cold student usable within a couple of
   *  minutes instead of at the start of their fourth session. */
  stats(channel: FaceChannel): ChannelStats;
  /** 0..1 trust in the stats above, counting this session's own samples. */
  reliability(): number;
  /** What to send home at session end. Null when too thin to be worth it. */
  sessionObservation(): SessionFaceObservation | null;
  reset(): void;
}

/**
 * One accumulator per identified student (an anonymous face has nowhere to
 * persist to, but still benefits from the within-session half).
 *
 * The live/session split is the whole trick that histograms buy: `live` is the
 * seeded profile with this session's counts added, so reads are correct from
 * the first frame a stored profile exists for, while `session` stays clean for
 * the write-back and cannot double-count what is already stored.
 */
export function createFaceBaselineAccumulator(
  profile?: FaceBaselineProfile | null,
): FaceBaselineAccumulator {
  const seedN = profile?.n ?? 0;
  const seedSessions = profile?.sessions ?? 0;

  let live = new Map<FaceChannel, ChannelHistogram>();
  let session = new Map<FaceChannel, ChannelHistogram>();
  let sessionN = 0;
  const cache = new Map<FaceChannel, { at: number; stats: ChannelStats }>();

  function seed() {
    live = new Map();
    session = new Map();
    sessionN = 0;
    cache.clear();
    for (const [ch, h] of Object.entries(profile?.channels ?? {})) {
      live.set(ch, { bins: { ...h.bins }, n: h.n });
    }
  }
  seed();

  function histFor(map: Map<FaceChannel, ChannelHistogram>, ch: FaceChannel): ChannelHistogram {
    let h = map.get(ch);
    if (!h) { h = emptyHistogram(); map.set(ch, h); }
    return h;
  }

  return {
    observe(values) {
      let any = false;
      for (const [ch, v] of values) {
        if (!isNum(v)) continue;
        observeChannel(histFor(live, ch), ch, v);
        observeChannel(histFor(session, ch), ch, v);
        cache.delete(ch);
        any = true;
      }
      if (any) sessionN++;
    },

    stats(channel) {
      // Stats are re-derived at most once per 16 observations of that channel:
      // the quantile scan is cheap but this runs per channel per frame, and the
      // median cannot meaningfully move inside 16 samples of a profile that
      // already holds hundreds.
      const h = live.get(channel);
      const n = h?.n ?? 0;
      const hit = cache.get(channel);
      if (hit && n - hit.at < 16) return hit.stats;
      const s = channelStats(h, channel);
      cache.set(channel, { at: n, stats: s });
      return s;
    },

    reliability() {
      return faceBaselineReliability({
        channels: {},
        n: seedN + sessionN,
        // A cold student is inside their first session, so `sessions` must count
        // the one in progress or reliability would be pinned at zero all
        // session and the decoder would never say anything.
        sessions: seedSessions + 1,
        updatedAt: "",
      });
    },

    sessionObservation() {
      if (sessionN < FACE_SESSION_MIN_SAMPLES) return null;
      const channels: Record<FaceChannel, ChannelHistogram> = {};
      for (const [ch, h] of session) if (h.n > 0) channels[ch] = { bins: { ...h.bins }, n: h.n };
      if (Object.keys(channels).length === 0) return null;
      return { channels, n: sessionN };
    },

    reset: seed,
  };
}

/** Channels that should not enter a composite: dead, or too thin to have a
 *  distribution yet. Attenuation alone does NOT disqualify a channel — that is
 *  the point of z-scoring against the person. */
export function channelUsable(stats: ChannelStats): boolean {
  return !stats.dead && stats.n > 0;
}

/** Re-exported so a consumer weighing a composite can see which contributors
 *  this model is known to attenuate without importing two modules. */
export { channelAttenuated };
