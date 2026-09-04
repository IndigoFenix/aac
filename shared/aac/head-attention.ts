// shared/aac/head-attention.ts
//
// Turns the head-pose stream into ONE debounced attention STATE — "attending"
// or "away", with a direction — instead of a per-tick stream of head_turn
// events.
//
// WHY THIS EXISTS. The old path (useFaceEvents.deriveEvents) emitted a
// head_turn event on every tick whose |yaw| or |pitch| crossed a single fixed
// threshold of 0.15, with no hysteresis and no dwell. Measured against real
// prod sessions (planning-docs/aac-face-expression-decoder.md §2.5) that
// produced, for two different students:
//
//   turned left 45% · turned right 20% · shaking head 21% · facing camera 4%
//
// with "turned left" and "turned right" appearing INSIDE THE SAME 8-second
// window. That is not head motion, it is a signal dithering across a threshold.
// Confirmed live 2026-09-02: a slight tilt is enough to register as looking
// left or right. Every one of those tokens was billed to the Observer on every
// turn, and carried no information.
//
// Three faults, three fixes, all of them here:
//   1. no hysteresis  → separate enter/exit thresholds, so the label cannot
//                       oscillate at the boundary
//   2. no dwell       → a candidate state must HOLD before it is committed
//   3. a stream       → the output is a state plus an episode on transition,
//                       not one event per sample
//
// The seizure detector already got this right — seizure-markers.ts gates every
// cue behind `sustained()`. This is the same idea applied to the path that
// feeds the [SCENE] line.
//
// ⚠️ UNITS. `yaw`/`pitch` here are the tracker's unitless landmark-asymmetry
// ratios (~-1..1) from useFaceTracking, NOT degrees. The thresholds below are
// in those units and have no physical meaning; they were chosen to sit well
// above the measured noise floor. When head pose moves to MediaPipe's
// facial transformation matrix (L0 in the plan) these must be re-derived in
// degrees — `client-aac/public/mirror-check.html` shows both estimators side by
// side for exactly that calibration.
//
// ⚠️ This module does NOT feed seizure detection. seizure-markers.ts reads
// FacialSample.yaw directly with its own threshold and its own sustain gate;
// nothing here can change a sided marker.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadPoseInput {
  /** + = turned to the SUBJECT's right. Unitless asymmetry ratio. */
  yaw: number;
  /** + = turned down. Unitless asymmetry ratio. */
  pitch: number;
}

export type AttentionState = "attending" | "away";
export type AwayDirection = "left" | "right" | "up" | "down";

/** A committed state that has just ENDED — the useful unit for the scene line
 *  and for any downstream analysis ("was away to the left for 3.2s"). */
export interface AttentionEpisode {
  state: AttentionState;
  direction: AwayDirection | null;
  startedAt: number;
  durationMs: number;
}

export interface AttentionReading {
  state: AttentionState;
  direction: AwayDirection | null;
  /** How long the CURRENT committed state has been held, ms. */
  heldMs: number;
  /** Non-null ONLY on the tick a new state commits; describes the state that
   *  just ended. This is the "episode, not a stream" half of the fix. */
  episode: AttentionEpisode | null;
  /** The running neutral currently being subtracted. Exposed for debugging and
   *  because it is a genuinely interesting per-student quantity. */
  neutral: HeadPoseInput;
  /** True until the neutral has had time to settle; callers should treat the
   *  reading as provisional (and must not assert "away") while set. A trusted
   *  cross-session profile clears this immediately — there is nothing to warm
   *  up to when the neutral is already known. */
  calibrating: boolean;
  /** 0..1 confidence in the ACCUMULATED profile backing this reading (0 = none
   *  stored, or too thin to believe). Carried out for the same reason
   *  FaceMatchResult/VoiceMatchResult carry `sampleCount`: the consumer needs
   *  to know how much evidence is behind the number, not just the number. */
  neutralTrust: number;
}

export interface HeadAttentionConfig {
  /** Deviation from neutral required to BECOME away. */
  enterYaw: number;
  enterPitch: number;
  /** Deviation below which an away state RELEASES. Must be < enter. */
  exitYaw: number;
  exitPitch: number;
  /** A candidate state must hold this long before it is committed. */
  minDwellMs: number;
  /** Half-life of the running neutral once warmed up. Long: this is meant to
   *  track how the student habitually sits relative to a mounted camera, not
   *  to follow their head around. */
  neutralHalfLifeMs: number;
  /** Faster half-life during warm-up, so a session starts usable quickly. */
  neutralWarmupHalfLifeMs: number;
  /** How long the warm-up lasts. */
  neutralWarmupMs: number;
  /** The neutral only adapts to samples within this distance of itself, so a
   *  sustained genuine turn cannot drag the neutral onto itself. */
  neutralMaxDev: number;
}

/**
 * Deliberately conservative: a missed turn costs nothing, a phantom one costs
 * a token on every Observer turn and teaches the AI something false. Same
 * philosophy as pose-classify.ts.
 *
 * Enter/exit are measured FROM THE RUNNING NEUTRAL, not from zero — which is
 * what lets them be tighter than the old absolute 0.15 while firing far less.
 * The old thresholds (0.15 event / 0.22 scene text) were absolute, so they were
 * fighting both the pitch offset (landmark 4 is not halfway between 10 and 152,
 * so pitch reads non-zero on a level head) and off-axis camera mounting.
 */
export const DEFAULT_HEAD_ATTENTION_CONFIG: HeadAttentionConfig = {
  enterYaw: 0.30,
  enterPitch: 0.30,
  exitYaw: 0.18,
  exitPitch: 0.18,
  minDwellMs: 500,
  neutralHalfLifeMs: 60_000,
  neutralWarmupHalfLifeMs: 1_500,
  neutralWarmupMs: 4_000,
  neutralMaxDev: 0.35,
};

// ---------------------------------------------------------------------------
// Learned neutral profile (accumulated ACROSS sessions)
// ---------------------------------------------------------------------------
//
// The within-session EMA above is only half the story. A neutral learned fresh
// every session — and this tracker is per FACE, so in practice every time
// tracking re-acquires — re-warms constantly, and during warm-up the reading is
// provisional. What we actually want is "how does THIS person habitually sit in
// front of THIS device", which is a fact about weeks, not seconds.
//
// Same discipline as the voice/face galleries (voice-pitch.ts,
// biometric/recognition-service.ts), for the same reason: a mean over three
// samples is not a baseline, it is a rumour.
//   * a QUALITY gate on intake — only plausible neutral evidence is accumulated
//   * TOTAL ACCUMULATED DATA carried on the profile (`n`, `sessions`), so
//     consumers can weigh certainty instead of trusting a thin profile
//   * a SPREAD FLOOR, because a 3-sample profile has ~0 spread and would
//     otherwise look razor-precise (exactly why PITCH_SPREAD_FLOOR_HZ exists)
//   * count-WEIGHTED merging with caps at both ends, so an early session cannot
//     swing the profile and one long session cannot dominate it
//
// Persisted per IDENTIFIED person (an anonymous face has nowhere to persist to).
// Machine-written, never clinician-edited — the `seizureDetection.{config,
// baseline}` split is the precedent, including keeping the machine half out of
// the AI-editable whitelist.

/** A person's learned habitual head pose relative to their device. */
export interface HeadNeutralProfile {
  yaw: number;
  pitch: number;
  /** Spread of accepted samples per axis. Floored — see NEUTRAL_SPREAD_FLOOR. */
  yawSpread: number;
  pitchSpread: number;
  /** Total accepted samples across EVERY session. */
  n: number;
  /** Distinct sessions that contributed. One session is one seating position;
   *  a profile from a single session describes a chair, not a person. */
  sessions: number;
  updatedAt: string;
}

/** What one session observed, before it is merged into the stored profile. */
export interface SessionNeutralObservation {
  yaw: number;
  pitch: number;
  yawSpread: number;
  pitchSpread: number;
  n: number;
}

/** Samples needed before the accumulated neutral is fully trusted. At the
 *  face tracker's ~3 Hz that is a couple of minutes of settled face time. */
export const NEUTRAL_MIN_SAMPLES = 400;
/** Sessions needed alongside. Guards the case the sample count cannot see: a
 *  huge n from ONE sitting still only describes that one sitting. */
export const NEUTRAL_MIN_SESSIONS = 3;
/** Floor on reported spread. A thin profile has ~0 variance and would read as
 *  precise; real head pose wobbles. Mirrors PITCH_SPREAD_FLOOR_HZ. */
export const NEUTRAL_SPREAD_FLOOR = 0.04;
/** A session whose own spread exceeds this was too restless to be evidence of
 *  a neutral at all — reject it rather than average the fidgeting in. */
export const NEUTRAL_SESSION_SPREAD_MAX = 0.25;
/** Minimum accepted samples for a session to contribute anything. */
export const NEUTRAL_SESSION_MIN_SAMPLES = 60;
/** One session contributes at most this much weight, however long it ran. */
export const NEUTRAL_SESSION_WEIGHT_CAP = 200;
/** The stored profile counts at most this much when weighing new evidence, so
 *  the neutral stays adaptive over months (a remounted tablet must eventually
 *  win) instead of freezing after a good fortnight. */
export const NEUTRAL_MEMORY_CAP = 2_000;
/** Hard cap on how far ONE merge may move the neutral. Bounds swings even if
 *  every weighting rule above is somehow satisfied. */
export const NEUTRAL_MAX_STEP = 0.08;
/** Reliability below which the stored neutral is a hint, not an anchor: it
 *  seeds the session but the reading stays `calibrating` until the session's
 *  own warm-up finishes. */
export const NEUTRAL_TRUST_MIN = 0.5;

/**
 * 0..1 — how much the accumulated profile deserves to be believed. Both axes
 * must be satisfied: samples AND distinct sessions. Returns 0 for a missing or
 * malformed profile, so callers can treat "never learned" and "unreliable"
 * the same way.
 */
export function neutralReliability(p: HeadNeutralProfile | null | undefined): number {
  if (!p || !Number.isFinite(p.yaw) || !Number.isFinite(p.pitch)) return 0;
  if (!(p.n > 0) || !(p.sessions > 0)) return 0;
  return Math.max(0, Math.min(1, Math.min(
    p.n / NEUTRAL_MIN_SAMPLES,
    p.sessions / NEUTRAL_MIN_SESSIONS,
  )));
}

/** Spread as it should be REPORTED — never below the floor. */
export function reportedSpread(raw: number): number {
  return Math.max(NEUTRAL_SPREAD_FLOOR, Number.isFinite(raw) ? Math.abs(raw) : 0);
}

const clampStep = (from: number, to: number): number => {
  const d = to - from;
  return from + Math.max(-NEUTRAL_MAX_STEP, Math.min(NEUTRAL_MAX_STEP, d));
};

/**
 * Merge one session's observation into the stored profile.
 *
 * Weighting is by COUNT, with a cap at both ends, which is what stops the two
 * failure modes: a brand-new profile is dominated by the first real session
 * (correct — there is nothing else), while an established one moves only
 * slightly per session (correct — one odd seating is not new truth). The step
 * clamp then bounds the movement absolutely.
 *
 * Returns the stored profile UNCHANGED when the observation fails its quality
 * gates, so a restless or too-short session leaves no trace.
 */
export function mergeNeutralProfile(
  stored: HeadNeutralProfile | null | undefined,
  obs: SessionNeutralObservation,
  nowIso: string,
): HeadNeutralProfile {
  const usable =
    obs.n >= NEUTRAL_SESSION_MIN_SAMPLES &&
    Number.isFinite(obs.yaw) && Number.isFinite(obs.pitch) &&
    obs.yawSpread <= NEUTRAL_SESSION_SPREAD_MAX &&
    obs.pitchSpread <= NEUTRAL_SESSION_SPREAD_MAX;

  if (!stored || !(stored.n > 0)) {
    if (!usable) {
      return stored ?? {
        yaw: 0, pitch: 0,
        yawSpread: NEUTRAL_SPREAD_FLOOR, pitchSpread: NEUTRAL_SPREAD_FLOOR,
        n: 0, sessions: 0, updatedAt: nowIso,
      };
    }
    return {
      yaw: obs.yaw, pitch: obs.pitch,
      yawSpread: reportedSpread(obs.yawSpread),
      pitchSpread: reportedSpread(obs.pitchSpread),
      n: obs.n, sessions: 1, updatedAt: nowIso,
    };
  }

  if (!usable) return stored;

  const wStored = Math.min(stored.n, NEUTRAL_MEMORY_CAP);
  const wObs = Math.min(obs.n, NEUTRAL_SESSION_WEIGHT_CAP);
  const a = wObs / (wStored + wObs);

  return {
    yaw: clampStep(stored.yaw, stored.yaw + a * (obs.yaw - stored.yaw)),
    pitch: clampStep(stored.pitch, stored.pitch + a * (obs.pitch - stored.pitch)),
    yawSpread: reportedSpread(stored.yawSpread + a * (obs.yawSpread - stored.yawSpread)),
    pitchSpread: reportedSpread(stored.pitchSpread + a * (obs.pitchSpread - stored.pitchSpread)),
    n: stored.n + obs.n,
    sessions: stored.sessions + 1,
    updatedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface RawLabel { away: boolean; direction: AwayDirection | null }

/**
 * Which way the head is off neutral, at the given thresholds. The dominant axis
 * is chosen by how far each exceeds ITS OWN threshold, not by raw magnitude —
 * the old code compared |yaw| to |pitch| directly, which is only meaningful if
 * both axes share a threshold and a scale, and they do not.
 */
export function classifyDeviation(
  devYaw: number,
  devPitch: number,
  yawT: number,
  pitchT: number,
): RawLabel {
  const ay = Math.abs(devYaw), ap = Math.abs(devPitch);
  const yawOver = ay > yawT, pitchOver = ap > pitchT;
  if (!yawOver && !pitchOver) return { away: false, direction: null };
  if (!pitchOver) return { away: true, direction: devYaw > 0 ? "right" : "left" };
  if (!yawOver) return { away: true, direction: devPitch > 0 ? "down" : "up" };
  return ay / yawT >= ap / pitchT
    ? { away: true, direction: devYaw > 0 ? "right" : "left" }
    : { away: true, direction: devPitch > 0 ? "down" : "up" };
}

const labelOf = (state: AttentionState, dir: AwayDirection | null) =>
  state === "away" ? `away:${dir}` : "attending";

/** EMA weight for a half-life over an elapsed interval. */
function emaAlpha(dtMs: number, halfLifeMs: number): number {
  if (dtMs <= 0 || halfLifeMs <= 0) return 0;
  return 1 - Math.pow(2, -dtMs / halfLifeMs);
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export interface HeadAttentionTracker {
  update(pose: HeadPoseInput | null | undefined, nowMs: number): AttentionReading;
  /** What this session has observed, for merging into the stored profile at
   *  session end. Null until enough accepted samples have accrued to be worth
   *  persisting — see NEUTRAL_SESSION_MIN_SAMPLES. */
  sessionObservation(): SessionNeutralObservation | null;
  reset(): void;
}

/**
 * One tracker per tracked face. Stateful by necessity (hysteresis and dwell are
 * memory), but the state is small and fully reset-able, and every decision is a
 * pure function of the inputs above — so the whole thing is testable without a
 * camera. See server/tests/head-attention.test.ts.
 */
export function createHeadAttentionTracker(
  overrides?: Partial<HeadAttentionConfig>,
  /** Accumulated cross-session profile for THIS person, when one exists and the
   *  face is identified. Seeds the neutral so the session starts already tuned;
   *  how much it is trusted is governed by neutralReliability, not by its mere
   *  presence. */
  profile?: HeadNeutralProfile | null,
): HeadAttentionTracker {
  const cfg: HeadAttentionConfig = { ...DEFAULT_HEAD_ATTENTION_CONFIG, ...overrides };
  const trust = neutralReliability(profile);

  let neutral: HeadPoseInput | null =
    trust > 0 && profile ? { yaw: profile.yaw, pitch: profile.pitch } : null;
  /** Seeded from a TRUSTED profile → no warm-up needed. Seeded from a thin one
   *  → the value is a head start, but the session still calibrates before we
   *  assert anything from it. */
  let seededTrusted = trust >= NEUTRAL_TRUST_MIN;
  let firstSeenAt = 0;
  let lastAt = 0;

  // Welford accumulation over ACCEPTED samples only, for this session's own
  // observation. "Accepted" is the quality gate: a finite pose, near the
  // current neutral, and not while committed away — a sustained turn is not
  // evidence about where neutral is.
  let obsN = 0, obsMeanYaw = 0, obsM2Yaw = 0, obsMeanPitch = 0, obsM2Pitch = 0;
  function observe(yaw: number, pitch: number) {
    obsN++;
    const dy = yaw - obsMeanYaw;
    obsMeanYaw += dy / obsN;
    obsM2Yaw += dy * (yaw - obsMeanYaw);
    const dp = pitch - obsMeanPitch;
    obsMeanPitch += dp / obsN;
    obsM2Pitch += dp * (pitch - obsMeanPitch);
  }
  let committed: { state: AttentionState; direction: AwayDirection | null; since: number } =
    { state: "attending", direction: null, since: 0 };
  let candidate: { label: string; state: AttentionState; direction: AwayDirection | null; since: number } | null = null;

  function reset() {
    neutral = trust > 0 && profile ? { yaw: profile.yaw, pitch: profile.pitch } : null;
    seededTrusted = trust >= NEUTRAL_TRUST_MIN;
    firstSeenAt = 0; lastAt = 0;
    committed = { state: "attending", direction: null, since: 0 };
    candidate = null;
    obsN = 0; obsMeanYaw = 0; obsM2Yaw = 0; obsMeanPitch = 0; obsM2Pitch = 0;
  }

  function sessionObservation(): SessionNeutralObservation | null {
    if (obsN < NEUTRAL_SESSION_MIN_SAMPLES) return null;
    return {
      yaw: obsMeanYaw,
      pitch: obsMeanPitch,
      yawSpread: Math.sqrt(obsM2Yaw / obsN),
      pitchSpread: Math.sqrt(obsM2Pitch / obsN),
      n: obsN,
    };
  }

  function update(pose: HeadPoseInput | null | undefined, nowMs: number): AttentionReading {
    // No pose this tick (face lost, or the tracker produced none): hold the
    // committed state rather than inventing "attending". An absent reading is
    // not evidence of attention.
    if (!pose || !Number.isFinite(pose.yaw) || !Number.isFinite(pose.pitch)) {
      return {
        state: committed.state,
        direction: committed.direction,
        heldMs: committed.since ? Math.max(0, nowMs - committed.since) : 0,
        episode: null,
        neutral: neutral ?? { yaw: 0, pitch: 0 },
        calibrating: neutral === null,
        neutralTrust: trust,
      };
    }

    if (firstSeenAt === 0) {
      // First pose of the session. With no trusted profile the only estimate we
      // have is this sample, which is why warm-up exists; with one, the stored
      // neutral stands and we skip straight to a usable reading.
      const seeded: HeadPoseInput = neutral ?? { yaw: pose.yaw, pitch: pose.pitch };
      neutral = seeded;
      firstSeenAt = nowMs;
      committed.since = nowMs;
      lastAt = nowMs;
      return {
        state: "attending", direction: null, heldMs: 0, episode: null,
        neutral: { ...seeded }, calibrating: !seededTrusted,
        neutralTrust: trust,
      };
    }

    // firstSeenAt !== 0 implies the neutral was seeded above; the fallback is
    // defensive only, and keeps the rest of this function null-free.
    const base: HeadPoseInput = neutral ?? { yaw: pose.yaw, pitch: pose.pitch };

    const dt = Math.max(0, nowMs - lastAt);
    lastAt = nowMs;
    // A trusted stored profile means there is nothing to warm up to.
    const warming = !seededTrusted && nowMs - firstSeenAt < cfg.neutralWarmupMs;

    const devYaw = pose.yaw - base.yaw;
    const devPitch = pose.pitch - base.pitch;

    // Adapt the neutral. Only from samples near it, so a real sustained turn
    // cannot pull the neutral onto itself and erase the very state we want.
    const nearNeutral =
      Math.abs(devYaw) < cfg.neutralMaxDev && Math.abs(devPitch) < cfg.neutralMaxDev;
    // Session observation intake — the QUALITY gate. Near the current neutral,
    // and not while committed away (a sustained turn says nothing about where
    // this person's neutral is).
    if (nearNeutral && committed.state === "attending") observe(pose.yaw, pose.pitch);

    if (warming || nearNeutral) {
      const a = emaAlpha(dt, warming ? cfg.neutralWarmupHalfLifeMs : cfg.neutralHalfLifeMs);
      neutral = {
        yaw: base.yaw + a * (pose.yaw - base.yaw),
        pitch: base.pitch + a * (pose.pitch - base.pitch),
      };
    } else {
      neutral = base;
    }

    // ---- hysteresis --------------------------------------------------------
    let raw: RawLabel;
    if (committed.state === "away") {
      // Stay away until the deviation drops below the EXIT thresholds. A change
      // of direction, though, has to clear ENTER — otherwise left/right would
      // flicker at the boundary while away.
      const stay = classifyDeviation(devYaw, devPitch, cfg.exitYaw, cfg.exitPitch);
      if (!stay.away) {
        raw = { away: false, direction: null };
      } else {
        const fresh = classifyDeviation(devYaw, devPitch, cfg.enterYaw, cfg.enterPitch);
        raw = fresh.away && fresh.direction !== committed.direction
          ? fresh
          : { away: true, direction: committed.direction };
      }
    } else {
      raw = classifyDeviation(devYaw, devPitch, cfg.enterYaw, cfg.enterPitch);
    }

    const rawState: AttentionState = raw.away ? "away" : "attending";
    const rawLabel = labelOf(rawState, raw.direction);

    // ---- dwell -------------------------------------------------------------
    let episode: AttentionEpisode | null = null;
    if (rawLabel === labelOf(committed.state, committed.direction)) {
      candidate = null;                       // back to the committed state
    } else if (!candidate || candidate.label !== rawLabel) {
      candidate = { label: rawLabel, state: rawState, direction: raw.direction, since: nowMs };
    } else if (nowMs - candidate.since >= cfg.minDwellMs) {
      // Commit. The episode describes the state that just ENDED.
      episode = {
        state: committed.state,
        direction: committed.direction,
        startedAt: committed.since,
        durationMs: Math.max(0, nowMs - committed.since),
      };
      committed = { state: candidate.state, direction: candidate.direction, since: nowMs };
      candidate = null;
    }

    return {
      state: committed.state,
      direction: committed.direction,
      heldMs: Math.max(0, nowMs - committed.since),
      episode,
      neutral: { ...(neutral ?? base) },
      calibrating: warming,
      neutralTrust: trust,
    };
  }

  return { update, sessionObservation, reset };
}

/** Short phrase for the [SCENE] line. Returns null while attending — an
 *  attending student is the default and does not need saying every tick. */
export function describeAttention(r: AttentionReading | null | undefined): string | null {
  if (!r || r.calibrating || r.state !== "away" || !r.direction) return null;
  const secs = Math.round(r.heldMs / 1000);
  const dir = r.direction === "up" || r.direction === "down" ? r.direction : `to the ${r.direction}`;
  return secs >= 2 ? `looking away ${dir} (${secs}s)` : `looking away ${dir}`;
}
