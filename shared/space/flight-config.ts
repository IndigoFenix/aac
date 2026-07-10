// shared/space/flight-config.ts
//
// Flight-physics tunables, ported verbatim from seagull-dream's config.ts
// (PLAYER / SPEED / CONTROLS blocks) so the ported player.ts behaves
// identically. Values and units are seagull's; comments abbreviated.

export const PLAYER = {
  walkSpeedMax: 4.17,          // ~15 kph walk cap (m/s)
  walkAccel: 16,              // walk speed lerp rate (1/s)
  walkLeanMax: 0.45,          // nose-down lean at run (rad)
  walkRestPitch: 0.55,        // nose-up rest tilt (rad)
  walkSlopeWallAngle: 0.95,   // ≈54°: forward → 0
  walkSlopeSlowAngle: 0.55,   // ≈31°: slowdown starts
  runningTakeoffSpeed: 8.33,  // ~30 kph
  wingExtendRate: 6,          // wing unfold lerp (1/s)
  flyLowAltCap: 8.33,         // low-altitude speed cap (m/s)
  flyLowAltClearScale: 200,   // clearance (m) that lifts the cap
  flyLowAltSampleRadius: 150, // horizontal obstacle sample radius (m)
  flyLowAltFrictionBase: 1.2, // low-alt brake base rate
  flyLowAltMaxFriction: 6.0,  // low-alt brake ceiling
  landSoftSpeed: 10,          // (declared; unused in dispatch)
  landGoodAngleDot: 0.7,      // upright-landing threshold
  landBounceSpeed: 25,        // ~90 kph bounce threshold
  landStunSpeed: 60,          // ~216 kph stun threshold
  stunDurationBadAngle: 1.5,  // s
  stunDurationHighSpeed: 3.0, // s
  bounceRetention: 0.55,      // rebound fraction
  swimSpeedMax: 2.5,          // swim cap (m/s)
  swimSubmersion: 0.15,       // eye depth below water (m)
  diveAngleDot: -0.8,         // (declared) dive angle
  swimDiveMouseThreshold: -0.5,
  diveSeconds: 0.4,           // dive anim
  underwaterSpeed: 4.0,       // constant underwater speed (m/s)
  waterDiveImpactDot: -0.5,   // flight → underwater on impact
  rocketRegimeAlpha: 0.05,    // α below → rocket takeoff
  jumpTakeoffSeconds: 0.25,   // jump anim
  jumpTakeoffSpeed: 6.0,      // jump launch speed (m/s)
  jumpTakeoffPitchBelow: 0.25,
  jumpTakeoffGroundFriction: 4.0,
  flySpeed: 32,               // cruise ref / warp-factor base (m/s)
  flyYawRate: 1.6,            // rad/s
  flyPitchRate: 1.0,          // rad/s
  flyBankAmount: 0.7,         // rad
  eyeHeight: 1.0,             // above ground (m)
  collisionRadius: 0.6,       // scatter bounding sphere (m)
  groundNormalEpsilon: 1.5,   // terrain-normal FD epsilon (m)
  warpMaxBoost: 100_000_000,  // display normalization only
} as const;

export const SPEED = {
  ALTITUDE_ACCEL_FACTOR: 8.3,
  MIN_FLIGHT_SPEED: 32,
  RHO_REF_AIR: 1.225,
  STRAIN_VACUUM_WEIGHT: 0.7,
  STRAIN_CLIMB_WEIGHT: 0.5,
  STRAIN_GRAVITY_WEIGHT: 0.3,
  HYPER_SPACE_ALPHA: 0.05,
  HYPER_CENTER_THRESHOLD: 0.15,
  HYPER_GAIN_RATE: 0.5,
  HYPER_LOSS_RATE: 10,
  HYPER_BRAKE_RATE: 0.5,
  HYPER_MAX_SPEED: 1e16,
  GALACTIC_DENSITY_BOOST: 1000,
  GALACTIC_REFERENCE_DENSITY: 0.1,
  HYPER_ACCEL_RATE: 0.5,
  WARP_INHIBITION_POWER: 2,
  WARP_GATE_POWER: 5,
  HYPER_CONE_COS: 0.9659258, // cos 15°
  HYPER_LOCK_TIME: 1.5,
  HYPER_LOCK_DECAY: 0.4,
  LOCK_APPROACH_RATE: 0.5,
  LOCK_APPROACH_BOOST: 1,
  WING_LIFT_THRESHOLD: 6,
} as const;

export const CONTROLS = {
  runTakeoffMouseThreshold: 0.35,
  runZoneSpeedScale: 0.25,
  jumpTakeoffMouseThreshold: 0.08,
  jumpTakeoffMouseRadius: 0.4,
  landingAltitude: 2.0,
  gravityAlignRate: 4.0,
} as const;

/** The new addition on top of seagull's gaze-hyperdrive: a MOUSE-WHEEL
 *  exponential speed factor, for fine-tuning cruise speed across the enormous
 *  interplanetary/interstellar range (the pilot's manual throttle). */
export const WHEEL = {
  gain: 0.15,        // factor ·= exp(gain · notches)
  minFactor: 0.05,
  maxFactor: 1e6,
} as const;

// player.ts module-level constants.
export const LOCK_CONE_BUFFER = 0.05; // rad
export const LOCK_HYSTERESIS = 1.5;
export const SPAWN_ALTITUDE = 1500;   // m above the spawn surface
export const BIRD_PULL = 0.2;         // readout auto-orient lerp (READOUT.birdPull)
