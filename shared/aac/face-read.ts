// shared/aac/face-read.ts
//
// L4 + L5 of the face decoder: turn the per-frame channel stream into EPISODES,
// and render a deliberately cautious read.
//
// ---------------------------------------------------------------------------
// L4 — episodes, not ticks (D5)
// ---------------------------------------------------------------------------
//
// The decoder this replaces emitted a gaze event on EVERY tick (a direction, or
// `gaze_center` as the else-branch) plus a blink whenever the eyes were shut,
// so the summary the Observer was billed for on every turn read mostly
// "gaze center x20, blink both x4" — with the one informative event buried in
// it. The same three fixes that rescued head orientation apply here, for the
// same reasons: hysteresis so a channel cannot oscillate at its threshold, a
// minimum dwell so a single noisy frame is not an expression, and an EPISODE
// (onset, duration, peak) instead of a sample count. An episode also carries
// what distinguishes a genuine expression from a stereotypy or a chew, which no
// per-frame threshold can see.
//
// ---------------------------------------------------------------------------
// L5 — what it is allowed to claim
// ---------------------------------------------------------------------------
//
// Three rules, all of them from the population rather than from taste:
//
//   1. NO DISCRETE EMOTION WORD. Continuous valence/arousal plus the action
//      units plus a confidence. The categorical label is both the least
//      reliable output a blendshape-only model produces (~72% on a 3-class
//      reduction, on typical adult faces) and the most likely to be taken as
//      fact — an LLM handed the word "sad" acts on it as fact.
//
//   2. ENGAGEMENT IS REPORTED SEPARATELY FROM AFFECT, and first. This
//      population communicates substantially through eye gaze, with preserved
//      communicative intent and severe apraxia; assessment practice reads
//      movement, vocalization, gaze and expression together. Attention is more
//      reliably measurable and more actionable for this child than emotion is.
//
//   3. UNREADABLE IS NOT NEUTRAL (D4). Below the quality floor this returns a
//      read that asserts nothing, and says why. A face that is badly lit, 60°
//      away or half out of frame previously reported as "neutral" — an
//      affirmative claim about a child's affect made on no evidence.
//
// A fourth rule falls out of the baseline: with a thin baseline the decoder
// says nothing about expression rather than falling back on global thresholds,
// because global thresholds are the defect (D8), not the safety net. The one
// exception is the ABSOLUTE path below — a channel at 0.55+ of full scale is
// unmistakable when we have NOTHING to compare it to, and staying silent about
// it would be its own kind of dishonesty. That path switches off the moment a
// channel has a usable baseline, because a global threshold is worse than a
// personal one, not a second opinion alongside it.

import {
  computeQuality, computeGeometry, gazeVector, landmarkJitter,
  QUALITY_MIN_READ,
  type FaceGeometry, type FaceLandmarkSet, type FaceQuality,
} from "./face-features";
import {
  computeActionUnits, toChannelValues, channelLabel, channelAttenuated,
  auChannel, geomChannel,
  type ActionUnitMap, type FaceChannel,
} from "./face-aus";
import {
  channelUsable, zScore,
  type ChannelStats, type FaceBaselineAccumulator,
} from "./face-baseline";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FaceReadConfig {
  /** Robust standard deviations from this person's own median to BECOME active. */
  enterZ: number;
  /** …and to release. Must be < enterZ. */
  exitZ: number;
  /** A channel must hold before it is committed. Expression onset is 200–500 ms,
   *  so this must stay under that or real onsets are clipped. */
  minDwellMs: number;
  /** Absolute intensity (0..1, AU channels only) reported when the channel has
   *  NO usable baseline yet. The escape hatch that keeps a cold student from
   *  being silent — and it yields to the baseline as soon as there is one. */
  absoluteEnter: number;
  absoluteExit: number;
  /** Samples of a channel before its z is trusted at all. */
  minChannelSamples: number;
  /** Window over which head stability is measured. */
  stabilityWindowMs: number;
  /** Channels reported in one read. The list is ranked, so this is a token
   *  budget, not a detection limit. */
  maxReported: number;
  /** A channel whose personal MEDIAN is at least this is worth naming as a
   *  resting state — that is the "mouth open (her usual)" note. */
  restingNotable: number;
  /** Ceiling on reported affect confidence. A blendshape-only decoder on an
   *  atypical face does not get to be confident, and a number the reader can
   *  round up to "certain" is worse than no number. */
  maxAffectConfidence: number;
}

export const DEFAULT_FACE_READ_CONFIG: FaceReadConfig = {
  enterZ: 2.5,
  exitZ: 1.5,
  minDwellMs: 400,
  absoluteEnter: 0.55,
  absoluteExit: 0.4,
  minChannelSamples: 40,
  stabilityWindowMs: 2_500,
  maxReported: 4,
  restingNotable: 0.35,
  maxAffectConfidence: 0.6,
};

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface FaceSample {
  present: boolean;
  blendshapes?: Map<string, number>;
  landmarks?: FaceLandmarkSet | null;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  headPose?: { yaw: number; pitch: number; roll: number } | null;
  /** Frame width / height. Without it every geometric ratio is wrong by that
   *  factor — see the anisotropy warning in face-features.ts. */
  aspect?: number;
  /** Committed head-orientation state from head-attention.ts, when the caller
   *  has one. Used for engagement only; this module never re-derives it. */
  attentionAway?: boolean;
}

export interface ActiveChannel {
  channel: FaceChannel;
  /** Plain language — no FACS jargon reaches the AI. */
  label: string;
  /** Robust standard deviations above this person's own median. */
  z: number;
  /** Raw intensity, for a consumer that wants it. */
  value: number;
  /** How long it has been continuously active. */
  durationMs: number;
  /** Signed left − right where the channel is sided and the sides disagree
   *  materially. Unilateral facial movement is clinically meaningful. */
  asymmetry?: number;
  /** True when this fired on raw intensity because the channel had no usable
   *  baseline to score against. The read says so rather than implying a
   *  personal comparison that did not happen. */
  viaAbsolute: boolean;
}

export interface FaceReadEpisode {
  channel: FaceChannel;
  label: string;
  peakZ: number;
  peakValue: number;
  startedAt: number;
  durationMs: number;
}

export interface FaceEngagement {
  /** 0..1. Eyes and head both pointed at the device. */
  gazeOnScreen: number;
  /** 0..1, relative to how wide THIS person's eyes usually are. */
  eyeOpenness: number;
  /** 0..1. 1 = head still over the last few seconds. */
  headStability: number;
}

export interface FaceAffect {
  /** −1..1. Negative = displeasure. */
  valence: number;
  /** 0..1. Activation, not pleasantness. */
  arousal: number;
  /** 0..maxAffectConfidence. */
  confidence: number;
}

export interface FaceRead {
  /** 0..1 — see face-features.computeQuality. */
  quality: number;
  /** Why quality is low. Empty when it is fine. */
  qualityReasons: string[];
  /** False when nothing below may be asserted. NOT the same as "neutral". */
  readable: boolean;
  /** 0..1 trust in the personal baseline backing the z-scores. */
  baselineTrust: number;
  engagement: FaceEngagement | null;
  affect: FaceAffect | null;
  /** Currently-committed channels, most deviant first. */
  active: ActiveChannel[];
  /** Channels that ENDED on this tick. */
  episodes: FaceReadEpisode[];
  /** Things worth saying that are not events — chiefly "this is her resting
   *  state", which is the whole point of having a personal baseline. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Affect composites
// ---------------------------------------------------------------------------
//
// Weighted sums over SIGNED z, not over raw intensity, so every term is already
// personalised. Weights are FACS/EMFACS combinations, not one-blendshape-per-
// emotion heuristics.
//
// ⚠️ Nothing here GATES on a channel (D2). AU6 is the Duchenne marker that
// separates a felt smile from a social one, and requiring it would be the
// correct textbook move — but `cheekSquint*` has never been measured on this
// population and may be attenuated to uselessness by the model. So AU6 adds
// weight when present and costs nothing when absent, and its absence is
// reflected in CONFIDENCE, never in the valence itself.

interface Term { channel: FaceChannel; weight: number }

const VALENCE_TERMS: Term[] = [
  { channel: auChannel("AU12"), weight: 1.0 },   // lip corner puller
  { channel: auChannel("AU06"), weight: 0.6 },   // cheek raiser (Duchenne)
  { channel: auChannel("AU15"), weight: -0.9 },  // lip corner depressor
  { channel: auChannel("AU04"), weight: -0.7 },  // brow lowerer
  { channel: auChannel("AU09"), weight: -0.5 },  // nose wrinkler
  { channel: auChannel("AU20"), weight: -0.4 },  // lip stretcher
  { channel: auChannel("AU23"), weight: -0.3 },  // lip tightener
];

const AROUSAL_TERMS: Term[] = [
  { channel: auChannel("AU05"), weight: 0.9 },   // upper lid raiser
  { channel: auChannel("AU01"), weight: 0.6 },   // inner brow raiser
  { channel: auChannel("AU02"), weight: 0.5 },   // outer brow raiser
  { channel: auChannel("AU26"), weight: 0.5 },   // jaw drop
  { channel: auChannel("AU07"), weight: 0.4 },   // lid tightener
  { channel: auChannel("AU43"), weight: -0.6 },  // eyes closed
];

/** Channels whose personal median being HIGH is worth a note. Naming a resting
 *  state is what stops the Observer being told about it as if it were news —
 *  the measured case is one student's brows reading raised on 23% of frames and
 *  every other subject's on 0%. */
const RESTING_NOTABLE_CHANNELS: FaceChannel[] = [
  auChannel("AU26"), auChannel("AU25"), auChannel("AU04"),
  auChannel("AU02"), auChannel("AU01"), auChannel("AU12"),
];

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

interface ChannelState {
  /** Last few RAW values, for the median filter. */
  recent: number[];
  active: boolean;
  since: number;
  peakZ: number;
  peakValue: number;
  /** Pending transition awaiting dwell. */
  candidate: { active: boolean; since: number } | null;
  viaAbsolute: boolean;
}

export interface FaceReadTracker {
  /**
   * `baseline` is passed per call rather than held, because WHICH accumulator a
   * face scores against can change mid-session: the tracked face that is the
   * student (and so owns the persisted baseline) is whichever is largest in
   * frame, and that is re-decided every tick. A tracker that captured its
   * accumulator at construction would keep scoring a visitor's face against the
   * student's distribution the moment they swapped seats.
   */
  update(sample: FaceSample, baseline: FaceBaselineAccumulator, nowMs: number): FaceRead;
  reset(): void;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Median of the last up-to-3 raw samples. A 3-sample median kills exactly the
 *  failure mode MediaPipe actually has — a single frame where the mesh snaps —
 *  without the phase lag a smoothing filter would add to a 200 ms onset. */
function median3(xs: number[]): number {
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0];
  if (xs.length === 2) return (xs[0] + xs[1]) / 2;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const UNREADABLE = (q: FaceQuality, trust: number): FaceRead => ({
  quality: q.score,
  qualityReasons: q.reasons,
  readable: false,
  baselineTrust: trust,
  engagement: null,
  affect: null,
  active: [],
  episodes: [],
  notes: [],
});

/**
 * One tracker per tracked face. Owns the per-channel hysteresis/dwell state and
 * the baseline intake gate — a frame the decoder could not read must not enter
 * the distribution, or the baseline learns what a badly-lit turned-away face
 * looks like and every later z is measured against that.
 */
export function createFaceReadTracker(
  overrides?: Partial<FaceReadConfig>,
): FaceReadTracker {
  const cfg: FaceReadConfig = { ...DEFAULT_FACE_READ_CONFIG, ...overrides };
  let channels = new Map<FaceChannel, ChannelState>();
  let prevLandmarks: FaceLandmarkSet | null = null;
  let poseHistory: Array<{ t: number; yaw: number; pitch: number }> = [];

  function reset() {
    channels = new Map();
    prevLandmarks = null;
    poseHistory = [];
  }

  function stateFor(ch: FaceChannel): ChannelState {
    let s = channels.get(ch);
    if (!s) {
      s = { recent: [], active: false, since: 0, peakZ: 0, peakValue: 0, candidate: null, viaAbsolute: false };
      channels.set(ch, s);
    }
    return s;
  }

  function headStability(nowMs: number): number {
    const from = nowMs - cfg.stabilityWindowMs;
    const w = poseHistory.filter((p) => p.t >= from);
    if (w.length < 3) return 1;
    let sum = 0;
    for (let i = 1; i < w.length; i++) {
      sum += Math.hypot(w[i].yaw - w[i - 1].yaw, w[i].pitch - w[i - 1].pitch);
    }
    // 0.5 tracker units of accumulated movement across the window reads as
    // fully unsettled. Well above the noise floor measured on real sessions.
    return clamp01(1 - sum / 0.5);
  }

  function update(sample: FaceSample, baseline: FaceBaselineAccumulator, nowMs: number): FaceRead {
    const trust = baseline.reliability();

    const aspect = sample.aspect ?? 1;
    const geometry: FaceGeometry = sample.present ? computeGeometry(sample.landmarks, aspect) : {};
    const jitter = landmarkJitter(prevLandmarks, sample.landmarks, aspect, geometry.interocular);
    prevLandmarks = sample.landmarks ?? null;

    const quality = computeQuality({
      boundingBox: sample.boundingBox,
      headPose: sample.headPose,
      jitter,
      present: sample.present,
    });

    if (sample.headPose) {
      poseHistory.push({ t: nowMs, yaw: sample.headPose.yaw, pitch: sample.headPose.pitch });
      const from = nowMs - cfg.stabilityWindowMs * 2;
      if (poseHistory.length > 200 || poseHistory[0].t < from) {
        poseHistory = poseHistory.filter((p) => p.t >= from);
      }
    }

    if (!sample.present || quality.score < QUALITY_MIN_READ) {
      // Hold the channel states rather than clearing them: a two-frame dropout
      // must not end every episode. They simply stop advancing.
      return UNREADABLE(quality, trust);
    }

    const aus: ActionUnitMap = computeActionUnits(sample.blendshapes);
    const values = toChannelValues(aus, geometry);

    // Baseline intake — the quality gate is above, so everything reaching here
    // is a frame we were willing to read.
    baseline.observe(values);

    // ---- per-channel z, hysteresis, dwell ---------------------------------
    const episodes: FaceReadEpisode[] = [];
    const active: ActiveChannel[] = [];
    const zByChannel = new Map<FaceChannel, number>();
    const statsByChannel = new Map<FaceChannel, ChannelStats>();

    for (const [ch, raw] of values) {
      const st = stateFor(ch);
      st.recent.push(raw);
      if (st.recent.length > 3) st.recent.shift();
      const v = median3(st.recent);

      const stats = baseline.stats(ch);
      statsByChannel.set(ch, stats);
      const scored = stats.n >= cfg.minChannelSamples && channelUsable(stats);
      const z = scored ? zScore(stats, v) : 0;
      zByChannel.set(ch, z);

      // Absolute path applies to AU channels only: geometry channels are
      // unbounded person-relative ratios with no meaningful absolute scale.
      const absoluteEligible = ch.startsWith("au:");

      // ⚠️ THE ABSOLUTE PATH IS A FALLBACK, NOT AN OVERRIDE. It applies only
      // where there is no usable baseline for this channel. Letting it fire
      // alongside a good baseline reinstates D8 in full: a student whose mouth
      // habitually rests open sits above any absolute threshold permanently, so
      // "mouth open" would be reported on every frame forever — which is the
      // measured failure this whole layer exists to fix. Once we know what this
      // child's face usually does, that is the only comparison worth making.
      //
      // Only POSITIVE deviations become active. An action unit is an action;
      // "less brow lowerer than usual" is not something that happened, and
      // reporting it would put a stream of non-events back into the very budget
      // D5 is about. Signed z still feeds affect below.
      const wantActive = scored
        ? (st.active ? z >= cfg.exitZ : z >= cfg.enterZ)
        : absoluteEligible && (st.active ? v >= cfg.absoluteExit : v >= cfg.absoluteEnter);

      if (wantActive === st.active) {
        st.candidate = null;
      } else if (!st.candidate || st.candidate.active !== wantActive) {
        st.candidate = { active: wantActive, since: nowMs };
      } else if (nowMs - st.candidate.since >= cfg.minDwellMs) {
        if (wantActive) {
          st.active = true;
          st.since = nowMs;
          st.peakZ = z;
          st.peakValue = v;
          st.viaAbsolute = !scored;
        } else {
          episodes.push({
            channel: ch,
            label: channelLabel(ch),
            peakZ: st.peakZ,
            peakValue: st.peakValue,
            startedAt: st.since,
            durationMs: Math.max(0, nowMs - st.since),
          });
          st.active = false;
          st.viaAbsolute = false;
        }
        st.candidate = null;
      }

      if (st.active) {
        if (z > st.peakZ) st.peakZ = z;
        if (v > st.peakValue) st.peakValue = v;
        const auId = ch.startsWith("au:") ? ch.slice(3) : null;
        const auv = auId ? (aus as Record<string, { asymmetry?: number } | undefined>)[auId] : undefined;
        const asym = auv?.asymmetry;
        active.push({
          channel: ch,
          label: channelLabel(ch),
          z,
          value: v,
          durationMs: Math.max(0, nowMs - st.since),
          asymmetry: asym !== undefined && Math.abs(asym) > 0.15 ? asym : undefined,
          viaAbsolute: st.viaAbsolute,
        });
      }
    }

    // Rank for the token budget below. The two paths are on different scales,
    // so absolute readings are divided by the threshold that admitted them and
    // z readings by a nominal 4 sigma — both land near 1 at "clearly notable",
    // which is enough to order a list of at most a handful.
    const rank = (c: ActiveChannel) =>
      c.viaAbsolute ? c.value / Math.max(cfg.absoluteEnter, 1e-6) : c.z / 4;
    active.sort((a, b) => rank(b) - rank(a));

    // ---- engagement -------------------------------------------------------
    const gaze = gazeVector(sample.blendshapes);
    const eyeStats = [geomChannel("eyeAspectLeft"), geomChannel("eyeAspectRight")]
      .map((c) => ({ c, s: statsByChannel.get(c), v: values.get(c) }))
      .filter((e) => e.s && e.v !== undefined && e.s.n >= cfg.minChannelSamples);
    let eyeOpenness: number;
    if (eyeStats.length > 0) {
      // Openness relative to how wide THIS person's eyes usually are, which is
      // the only scale that means anything across hypotonia and ptosis.
      eyeOpenness = clamp01(
        eyeStats.reduce((a, e) => a + (e.v as number) / Math.max(e.s!.median, 1e-4), 0) / eyeStats.length,
      );
    } else {
      eyeOpenness = clamp01(1 - (aus.AU43?.value ?? 0));
    }
    const engagement: FaceEngagement = {
      gazeOnScreen: sample.attentionAway ? 0 : clamp01(1 - gaze.magnitude / 0.5) * clamp01(eyeOpenness * 1.4),
      eyeOpenness,
      headStability: headStability(nowMs),
    };

    // ---- affect -----------------------------------------------------------
    const composite = (terms: Term[]) => {
      let sum = 0, wUsed = 0, wTotal = 0, attenuatedMissing = 0;
      for (const t of terms) {
        wTotal += Math.abs(t.weight);
        const stats = statsByChannel.get(t.channel);
        const z = zByChannel.get(t.channel);
        if (!stats || z === undefined || stats.n < cfg.minChannelSamples || !channelUsable(stats)) {
          if (channelAttenuated(t.channel)) attenuatedMissing++;
          continue;
        }
        sum += t.weight * z;
        wUsed += Math.abs(t.weight);
      }
      return { sum, coverage: wTotal > 0 ? wUsed / wTotal : 0, attenuatedMissing };
    };

    let affect: FaceAffect | null = null;
    const v = composite(VALENCE_TERMS);
    const a = composite(AROUSAL_TERMS);
    if (v.coverage > 0 || a.coverage > 0) {
      // tanh over a 4-z scale: saturates gently, so a single extreme channel
      // cannot pin the output while a broad shift still reads as one.
      const valence = Math.tanh(v.sum / 4);
      const arousal = clamp01((Math.tanh(a.sum / 4) + 1) / 2);
      const magnitude = Math.max(Math.abs(valence), Math.abs(arousal * 2 - 1));
      affect = {
        valence,
        arousal,
        confidence: Math.min(
          cfg.maxAffectConfidence,
          quality.score * trust * Math.max(v.coverage, a.coverage) * magnitude,
        ),
      };
    }

    // ---- notes ------------------------------------------------------------
    const notes: string[] = [];
    if (trust > 0.5) {
      for (const ch of RESTING_NOTABLE_CHANNELS) {
        const stats = statsByChannel.get(ch);
        if (!stats || stats.n < cfg.minChannelSamples) continue;
        if (stats.median >= cfg.restingNotable) {
          notes.push(`${channelLabel(ch)} is her usual resting state`);
        }
      }
    }

    return {
      quality: quality.score,
      qualityReasons: quality.reasons,
      readable: true,
      baselineTrust: trust,
      engagement,
      affect,
      active: active.slice(0, cfg.maxReported),
      episodes,
      notes,
    };
  }

  return { update, reset };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const valenceWord = (v: number): string =>
  v > 0.35 ? "positive" : v < -0.35 ? "negative" : "neutral-valence";

export interface FaceReadPhrases {
  /** Attention/openness/stability. Reported FIRST and separately from affect —
   *  it is the more reliably measurable and more actionable channel for this
   *  population. */
  engagement: string[];
  /** What actually moved, plus the hedged affect line and the resting-state
   *  notes. Empty when the face is readable and nothing crossed threshold. */
  expression: string[];
  /** Set when nothing above may be asserted. The caller must say WHY rather
   *  than falling back on "neutral" — see D4. */
  unreadable: string | null;
}

/**
 * Split rendering, because the two halves have different owners: a caller that
 * already describes head orientation and eye direction from the attention state
 * wants the expression half only, and duplicating "gaze on screen" next to
 * "looking away to the left" is both wasted tokens and a contradiction waiting
 * to happen.
 *
 * Every claim names its own basis, because the reader is an LLM that will
 * otherwise treat all of it as equally certain: a personal deviation says
 * "beyond her usual", an absolute one says "strong", and an unreadable frame
 * says why it is unreadable.
 */
export function faceReadPhrases(read: FaceRead | null | undefined): FaceReadPhrases {
  const out: FaceReadPhrases = { engagement: [], expression: [], unreadable: null };
  if (!read) return out;

  if (!read.readable) {
    out.unreadable = read.qualityReasons.length
      ? `expression unreadable (${read.qualityReasons.join(", ")})`
      : "expression unreadable";
    return out;
  }

  if (read.engagement) {
    if (read.engagement.eyeOpenness < 0.25) out.engagement.push("eyes closed");
    else if (read.engagement.gazeOnScreen > 0.6) out.engagement.push("gaze on screen");
    if (read.engagement.headStability < 0.4) out.engagement.push("head moving");
  }

  for (const c of read.active) {
    let phrase = c.label;
    phrase += c.viaAbsolute ? " (strong)" : ` (${c.z.toFixed(1)}σ beyond her usual)`;
    if (c.asymmetry !== undefined) {
      phrase += c.asymmetry > 0 ? ", left side more" : ", right side more";
    }
    out.expression.push(phrase);
  }

  if (read.affect && read.affect.confidence >= 0.15) {
    const pct = Math.round(read.affect.confidence * 100);
    const arousal = read.affect.arousal > 0.6 ? "aroused" : "calm";
    out.expression.push(`${valenceWord(read.affect.valence)}/${arousal} — ${pct}% confidence`);
  }

  for (const n of read.notes) out.expression.push(n);
  return out;
}

/**
 * The whole [SCENE] phrase for one face, engagement first. Callers that render
 * head orientation themselves should use {@link faceReadPhrases} instead.
 */
export function describeFaceRead(read: FaceRead | null | undefined): string {
  if (!read) return "";
  const p = faceReadPhrases(read);
  if (p.unreadable) return p.unreadable;
  const parts = [...p.engagement, ...p.expression];
  if (parts.length === 0) return noChangePhrase(read);
  return parts.join(", ");
}

/**
 * What to say when the face IS readable and nothing crossed threshold. NOT
 * "neutral": the face is readable and nothing changed, which is a different and
 * much weaker claim than an assertion about affect.
 */
export function noChangePhrase(read: FaceRead): string {
  return read.baselineTrust < 0.5
    ? "no expression change (still learning her usual face)"
    : "no expression change from her usual";
}
