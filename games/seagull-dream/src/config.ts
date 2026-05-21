import * as THREE from "three";

// Demo-scale constants. We use a small planet (~2 km radius) so curvature is
// visible without needing LOD, and so the whole sphere fits in Float32 without
// precision tricks. Real-scale (Earth-radius + floating origin) comes later
// once controls are locked down.

export const PLANET = {
  /** Sphere radius in meters before elevation — Earth-scale. */
  radius: 6_371_000,
  /** Sea level height above sphere radius. */
  seaLevel: 0,
  /** Maximum positive displacement (mountain tops, ~Everest). */
  maxElevation: 8849,
  /** Maximum negative displacement below sea level (ocean floor, ~Mariana). */
  maxDepth: 10994,
  /** Continent noise spatial scale — higher = smaller continents.
   *  Earth-scale: 30 puts continents at ~700 km. */
  continentFreq: 30,
  /** Detail noise spatial scale. Earth-scale: 2000 puts terrain detail
   *  at ~10 km features — visible from the player's view radius. */
  detailFreq: 2000,
  /** How much detail noise contributes to final height. */
  detailWeight: 0.25,
  /** RNG seed. */
  seed: 1337,
  /**
   * Distance (m) above the planet radius at which gravity influence reaches
   * zero. Inside this band the player is "near a planet"; beyond it, they're
   * drifting in deep space.
   */
  influenceFalloff: 1_000_000,
  /**
   * Axis the planet spins around, in planet-local coords. Default +Y (no
   * axial tilt). Future: per-planet tilt for varied seasons.
   */
  rotationAxis: new THREE.Vector3(0, 1, 0),
  /**
   * Rotation rate, radians/sec. `2π / N` gives one full rotation every N
   * seconds → an "N-second day." With the Newtonian atmospheric model
   * the player's velocity is no longer coupled to surface wind on
   * takeoff, so rotation can be whatever feels right visually without
   * causing post-takeoff escape-velocity problems. 30 minutes makes
   * day/night cycle visible within a single play session.
   */
  rotationRate: (Math.PI * 2) / 1800,
};

export const CHUNKS = {
  /** Vertices per side per chunk. Fixed across LOD levels. */
  resolution: 33,
  /** Maximum subdivision depth per face. At depth D, chunks span 1/2^D of a
   *  face. With Earth-scale 6371 km radius and faceArc ≈ 10,000 km, depth
   *  18 → ~38 m chunks → ~1.2 m vertex spacing, which is fine for walking.
   *  LOD only deepens directly under the camera, so total chunk count
   *  stays bounded. */
  maxDepth: 18,
  /**
   * Subdivide a leaf node when chunkSize / cameraDistance exceeds this.
   */
  lodThreshold: 1.2,
  /**
   * Merge an already-subdivided node back to a leaf only when the ratio
   * drops below this value. The gap between merge and subdivide thresholds
   * creates a dead zone that prevents LOD thrashing when the camera hovers
   * near the boundary — a major source of visible "stuttering."
   */
  lodMergeThreshold: 0.8,
  /** Depth (m) to drop skirt vertices below the chunk surface. */
  skirtDepth: 50,
  /**
   * Distance (m) at which the procedural surface-detail noise is fully faded
   * out. Below 30% of this distance it's at full strength; between 30% and
   * 100% it ramps down. Fading prevents high-frequency shimmer on tiny pixels
   * at long range.
   */
  surfaceDetailRange: 800,
  /** ±brightness amplitude of the surface-detail noise. Bumped from 0.35
   *  so walking-distance ground texture has visible step-to-step motion;
   *  combined with the third (high-frequency) noise octave below, the
   *  bird moving forward visibly slides over distinct ground pixels
   *  rather than a smooth gradient. */
  surfaceDetailAmount: 0.55,
};

export const PLAYER = {
  /** Walking speed cap = 15 kph spec maximum before takeoff behavior, m/s. */
  walkSpeedMax: 4.17, // = 15 kph
  /** How quickly walk speed ramps to its target. */
  walkAccel: 16,
  /** Max forward body-lean angle at full walk speed, rad. Bird is tilted
   *  UPWARDS (nose-up) at zero speed and rotates toward horizontal as
   *  speed approaches walkSpeedMax. */
  walkLeanMax: 0.45,
  /** Resting nose-up tilt while standing still, rad. Bird sits head-up
   *  when not moving; this is the angle the body pitches BACK from
   *  horizontal at zero walk speed. ~30° matches a seagull's resting
   *  stance. */
  walkRestPitch: 0.55,
  /** Maximum walkable slope angle (rad). Past this, the slope acts as a
   *  wall — forward motion zeroes out. 0.95 rad ≈ 54° (between hiking-
   *  steep and unclimbable). */
  walkSlopeWallAngle: 0.95,
  /** Slope angle (rad) at which speed begins to fall toward zero — between
   *  here and walkSlopeWallAngle, speed scales linearly with the remaining
   *  margin. Below this angle, slope-projection alone keeps movement
   *  honest without any extra penalty. */
  walkSlopeSlowAngle: 0.55, // ≈ 31°
  /** Running-takeoff speed, m/s. When wings are out and flapping, bird
   *  accelerates toward this. */
  runningTakeoffSpeed: 8.33, // = 30 kph
  /** Lerp rate (per second) the walking-state wingExtension converges
   *  toward its target (0 = tucked, 1 = spread). 6 → wings finish
   *  unfolding in ~0.3 s when triggered, so the running-takeoff feels
   *  responsive without snapping. */
  wingExtendRate: 6,
  /** Speed cap close to the ground/obstacles, m/s. Independent of
   *  atmospheric pressure — purely a safety brake to make low flight
   *  navigable rather than a crash sim. Raised by obstacle distance
   *  (see flyLowAltClearScale). */
  flyLowAltCap: 8.33, // = 30 kph
  /** Vertical clearance (m) above the highest nearby obstacle at which
   *  the low-altitude cap fully lifts. Within `flyLowAltSampleRadius`
   *  m of any obstacle, cap interpolates from `flyLowAltCap` at zero
   *  clearance to UNCAPPED (cap → +∞) at this clearance. */
  flyLowAltClearScale: 200,
  /** Horizontal radius (m) at which we sample heightAt to find nearby
   *  obstacles for the low-altitude cap. Captures local mountain peaks
   *  but stays cheap (4-point cross). */
  flyLowAltSampleRadius: 150,
  /** Base friction rate (per second) for the low-altitude brake when
   *  the bird is just over the cap. Bird's wingSpeed bleeds toward
   *  the cap at this rate; result is a gradual slowdown rather than
   *  a hard clamp. */
  flyLowAltFrictionBase: 1.2,
  /** Hard ceiling on the low-altitude friction rate. Even a 300 kph
   *  dive into a mountainside friction-decays at most this fast so
   *  the brake reads as firm, not as a wall. */
  flyLowAltMaxFriction: 6.0,
  /** Impact speed (m/s) at or below which a well-angled touchdown
   *  results in a smooth landing into the running-takeoff state. */
  landSoftSpeed: 10, // = 36 kph — slow approach
  /** Body-up to ground-normal dot product at or above which the bird
   *  is considered "right-side up" for landing purposes. 0.7 ≈ 45° of
   *  tilt from upright. Past this the legs can't catch the impact and
   *  the bird tumbles. */
  landGoodAngleDot: 0.7,
  /** Impact speed above which the bird bounces off the surface
   *  instead of landing. Bounce reflects forward direction and bleeds
   *  off some of the wingSpeed. */
  landBounceSpeed: 25, // = 90 kph
  /** Impact speed above which the bird is stunned regardless of
   *  landing angle. The wing-cap impact (`flyUpwardCap` = 300 kph) is
   *  always far above this. */
  landStunSpeed: 60, // = 216 kph
  /** Stun duration (seconds) after a bad landing. */
  stunDurationBadAngle: 1.5,
  /** Stun duration (seconds) after a high-energy crash. */
  stunDurationHighSpeed: 3.0,
  /** Fraction of impact-velocity magnitude RETAINED after a bounce
   *  (1 = perfect rebound; 0 = no rebound). */
  bounceRetention: 0.55,
  /** Swim speed cap, m/s. Spec: top running speed before takeoff is
   *  SMALLER than walking. Picked at ~60% of walkSpeedMax. */
  swimSpeedMax: 2.5, // ≈ 9 kph
  /** Depth below the water surface that the bird's eye sits while
   *  swimming. Smaller than eyeHeight so it reads as "floating low
   *  in the water" rather than walking on the surface. */
  swimSubmersion: 0.15,
  /** forward·up dot product (where up is "away from water surface")
   *  below which the player is considered "angled straight down" for
   *  the dive trigger. -0.8 ≈ 37° below horizontal. */
  diveAngleDot: -0.8,
  /** While swimming, normalized-mouse-Y center-offset (range -1..1)
   *  BELOW which the dive is triggered. -0.5 ≈ pull the mouse to the
   *  lower half of the screen to dive. */
  swimDiveMouseThreshold: -0.5,
  /** Dive-animation duration, seconds. Short — analogous to the 250 ms
   *  jump takeoff. */
  diveSeconds: 0.4,
  /** Underwater locomotion speed, m/s. Spec: "underwater, player moves
   *  at a constant, low speed." */
  underwaterSpeed: 4.0,
  /** forward·up dot threshold (negative = downward) for an automatic
   *  flight → underwater transition on water impact. Steeper than -0.5
   *  (≈ 60° below horizontal) belly-flops into a dive instead of
   *  bouncing off the surface. */
  waterDiveImpactDot: -0.5,
  /** Atmospheric α threshold below which the bird uses ROCKETS instead
   *  of wings for takeoff. Matches the V_WING_BASE × α attenuation —
   *  by α≈0.05 wings produce ~5% of sea-level thrust, not enough to
   *  take off. */
  rocketRegimeAlpha: 0.05,
  /** Duration of the jumping-takeoff wing-unfold animation, seconds.
   *  Bird pauses (with friction-only motion) while wings unfold and
   *  flap once before launching. */
  jumpTakeoffSeconds: 0.25,
  /** Initial vertical speed (m/s) imparted by a jump takeoff. Sized so
   *  the bird clears the ground reliably and is committed to flight
   *  rather than landing again immediately. */
  jumpTakeoffSpeed: 6.0,
  /** Angle (rad) below perpendicular-to-ground that the jump takeoff
   *  aims. Pure perpendicular launch reads as comical; tilting the
   *  forward axis slightly toward the bird's heading gives a more
   *  natural lift-off. */
  jumpTakeoffPitchBelow: 0.25,
  /** Friction (per second) bleeding ground velocity during the jump
   *  takeoff animation. Spec says "do not completely pause ground
   *  movement, but slow down." */
  jumpTakeoffGroundFriction: 4.0,
  /** Flying speed, m/s. Used as the post-takeoff cruise reference and
   *  for the warp-factor display computation. */
  flySpeed: 32,
  /** Yaw rate while flying, rad/s at max mouse deflection. */
  flyYawRate: 1.6,
  /** Pitch rate while flying, rad/s at max mouse deflection. */
  flyPitchRate: 1.0,
  /** Roll amount applied to body model based on yaw input, rad. */
  flyBankAmount: 0.7,
  /** Eye height above ground while walking. Larger reduces mesh clipping. */
  eyeHeight: 1.0,
  /** Player's bounding-sphere radius for obstacle (tree / rock) collisions. */
  collisionRadius: 0.6,
  /** Finite-difference epsilon (m) for sampling terrain normal under player. */
  groundNormalEpsilon: 1.5,
  /**
   * Visual warp-distortion cap. Used by the main loop's warp shader pass
   * to normalize `lastWarpFactor → uWarp ∈ [0,1]`. Not a physics
   * constant; purely a display parameter.
   */
  warpMaxBoost: 100_000_000,
};

// ── Three-mode speed model (wing / rocket / warp) ───────────────────────────
// Simple geometric model. Each mode produces a target speed; warp is
// inertialess so the player's drive velocity snaps to the blended total
// every frame. Modes blend via p-norm so transitions are smooth.
//
//   wing   = pressure × lerp(V_DOWN, V_UP, climbT)
//            asymmetric: dive faster than climb, both fade in thin air
//   rocket = sqrt(2 × A × h) if above MIN_FLIGHT_SPEED, else 0
//            altitude-only; physically motivated as ballistic-coast
//            speed under uniform acceleration A
//   warp   = V_BASE × max(0, 1/θ - 1/π)^WARP_POWER × (1-α)^N × hillGate
//            θ is the angular size of the biggest body in view (radians);
//            the 1/π subtraction makes warp = 0 at any body's surface;
//            the (1-α) gate keeps atmospheres warp-locked; hillGate
//            also locks warp inside a body's hill-sphere neighborhood.
//
// α is summed kg/m³ atmospheric density normalized to Earth sea-level (1.225).

export const SPEED = {
  /** Altitude-acceleration factor (m/s²) for the flight-speed formula.
   *  Target flight speed at altitude h is `sqrt(2 × A × h)` — the
   *  speed required to coast ballistically up to altitude h under
   *  uniform acceleration A. Default 8.3 is close to Earth-1g, so
   *  the formula reads as "cruise = the speed needed to reach this
   *  altitude under Earth-like gravity." */
  ALTITUDE_ACCEL_FACTOR: 8.3,
  /** Minimum cruise speed (m/s) used as the floor on the altitude
   *  formula. Below the altitude at which `sqrt(2 × A × h)` exceeds
   *  this value (h_min = MIN² / (2 × A)), the bird cruises at this
   *  constant. Default 32 → low-altitude bird cruises around 32 m/s
   *  and accelerates with altitude past ~62 m. */
  MIN_FLIGHT_SPEED: 32,
  /** Earth sea-level air density (kg/m³) — reference for atmospheric α. */
  RHO_REF_AIR: 1.225,
  /** Asymmetric friction toward the altitude-based target speed.
   *  Climbing friction stays firm so the upward cap holds. Dive
   *  friction is much gentler so a steep dive carries momentum
   *  through the bottom of a swoop. Both scale with α (no drag
   *  in vacuum). */
  WING_FRICTION_CLIMB: 3.0,
  WING_FRICTION_DIVE: 0.4,
  /** Strength of "swooping" — the carry-over of dive momentum into the
   *  upward arc when the player pulls up from a steep dive in dense
   *  atmosphere. Higher = more momentum preserved through the bottom of
   *  the swoop. Scaled by atmospheric density so it only happens in
   *  atmosphere worth swooping through. */
  WING_SWOOP_FACTOR: 1.6,
  /** Flight-strain weight from vacuum/thin atmosphere. Strain rises
   *  toward 1 as α → 0; this is the dominant contributor in deep
   *  vacuum and drives the wings-fold-back + rockets-on phase
   *  transition. */
  STRAIN_VACUUM_WEIGHT: 0.7,
  /** Flight-strain weight from climbing in atmosphere. forward·up = 1
   *  (straight up) adds STRAIN_CLIMB_WEIGHT * α to strain; level adds
   *  0, dive subtracts (relief). Captures "wings work hard against
   *  gravity, glide downhill" in the strain factor. */
  STRAIN_CLIMB_WEIGHT: 0.5,
  /** Flight-strain weight from above-Earth gravity. (gravNorm - 1) ×
   *  α × STRAIN_GRAVITY_WEIGHT — high-G worlds raise strain even
   *  during level flight; low-G worlds don't reduce it (subtracted
   *  contribution clamps at zero). */
  STRAIN_GRAVITY_WEIGHT: 0.3,
  // ── Hyperspeed (gaze-driven multiplier) ────────────────────────────────
  /** Atmospheric α below which hyperspeed can build. Above this, the
   *  player is in atmosphere and the multiplier rapidly decays back
   *  to 1. */
  HYPER_SPACE_ALPHA: 0.05,
  /** Normalized mouse offset from screen center (range 0..√2) below
   *  which the gaze counts as "centered" — i.e. the player is looking
   *  in their direction of motion and intends to keep going. Default
   *  0.15 ≈ a 30% diameter circle at screen center. */
  HYPER_CENTER_THRESHOLD: 0.15,
  /** Per-second exponential growth rate of hyperMult while gaze is
   *  centered. Default 0.5 ≈ ×1.65 per second; reaches 100× in ~9 s
   *  and 10⁶× in ~28 s of sustained focus. */
  HYPER_GAIN_RATE: 0.5,
  /** Per-second decay rate per unit of gaze-offset beyond the
   *  centered band. Decay magnitude = HYPER_LOSS_RATE × (gazeOffset −
   *  HYPER_CENTER_THRESHOLD). Pointing the mouse 5% off-center gives
   *  a gentle ~0.1/s decay; pointing it at the screen edge gives a
   *  sharp ~2.5/s decay. Default 2.0 — larger values bias the loop
   *  toward intent (any slight drift kills speed fast). */
  HYPER_LOSS_RATE: 10,
  /** Per-second decay rate of hyperMult while the lock-on approach
   *  cap is actively reducing desired speed. This makes the brake
   *  REAL — the slowdown consumes the stored hyperMult so that
   *  losing the lock doesn't snap the bird back to full speed.
   *  Default 5.0 → ~0.7% remaining after 1 s of braking, so a few
   *  seconds of locked approach drains a huge hyperMult to ~1.
   *  Set high enough that it dominates HYPER_GAIN_RATE when both
   *  fire simultaneously (centered gaze on a locked target). */
  HYPER_BRAKE_RATE: 0.5,
  /** Hard cap on effective hyperspeed (m/s) at galactic-core
   *  density. Default 1e16 ≈ 10 trillion km/s. The effective cap
   *  scales UP in sparse regions (outer arms, intergalactic space)
   *  by a factor of `densityBoost` — at density 0 you get
   *  `HYPER_MAX_SPEED × GALACTIC_DENSITY_BOOST`. */
  HYPER_MAX_SPEED: 1e16,
  /** Maximum boost on HYPER_MAX_SPEED in zero-density regions.
   *  Default 1000 → intergalactic cap is 1e19 m/s. Tunable for
   *  pacing of cross-galaxy travel. */
  GALACTIC_DENSITY_BOOST: 1000,
  /** Reference star density (stars/ly³) at which the cap equals
   *  HYPER_MAX_SPEED (no boost). Default 0.1 — roughly the disc
   *  density at solar position. Lower local density → higher
   *  effective cap; higher local density → cap at base. */
  GALACTIC_REFERENCE_DENSITY: 0.1,
  /** Per-second rate at which the inertial wingSpeed lerps toward
   *  the desired (baseSpeed × hyperMult) target. Provides momentum
   *  so brief friction spikes (passing a body) don't crash speed. */
  HYPER_ACCEL_RATE: 0.5,
  /** Exponent on (R/r) for the warp gate falloff. Default 2 = inverse
   *  square — friction matches the gravitational scaling so
   *  near-body braking is firm without ever fully stopping the bird
   *  unless it tries to sit on the surface. */
  WARP_INHIBITION_POWER: 2,
  /** Exponent on (1 - α) for the atmospheric warp gate. Larger N =
   *  hyperMult is suppressed deeper into thin atmospheres. Default 5
   *  means at α=0.5 only ~3% of hyperMult bonus is allowed; at
   *  α=0.17 (≈15 km on Earth) ~40% is allowed. In vacuum the gate
   *  is fully open. Ensures the natural altitude-driven climb still
   *  reaches the bird's baseSpeed in atmosphere. */
  WARP_GATE_POWER: 5,
  // ── Lock-on (approach-cap, no reorient) ────────────────────────────────
  /** Half-angle (radians) of the forward-cone used to pick a lock
   *  candidate. ≈ cos(15°). Larger = looser intent detection. */
  HYPER_CONE_COS: 0.9659258, // cos(15°)
  /** Seconds the player must steadily face the same candidate body
   *  to build a full lock (lockProgress 0 → 1). */
  HYPER_LOCK_TIME: 1.5,
  /** Seconds for lockProgress to decay to 0 when the player looks
   *  away. Faster than build time so cancel is responsive. */
  HYPER_LOCK_DECAY: 0.4,
  /** Per-second rate at which the locked target's distance gates
   *  the maximum allowed desired speed: max_v = RATE × distance ×
   *  BOOST. With RATE = 0.5, time to decay from cruise distance D
   *  to D_exit is `ln(D / D_exit) / (RATE × BOOST)`. Earth-Moon
   *  (3.84×10⁸ → exit ~10⁶ m) ≈ 12 s at BOOST=1, ≈ 1.2 s at BOOST=10. */
  LOCK_APPROACH_RATE: 0.5,
  /** Multiplier on the lock-on approach cap. Increase to make
   *  locked approaches faster without changing the shape of the
   *  exponential-decay curve (or the per-second BRAKE_RATE that
   *  drains hyperMult while the cap is active). Default 1; bump to
   *  5-20 if approaches feel slow. */
  LOCK_APPROACH_BOOST: 1,
  /** Wing-vs-rocket visual blend. The bird is purely visual at this
   *  point: same speed everywhere, but at low atmospheric density (or
   *  high gravity) wings can't generate the thrust needed and rockets
   *  fire instead. Rocket visual weight is
   *
   *    rocketRegimeWeight = clamp(0, 1, 1 - WING_LIFT_THRESHOLD × α / gravNorm)
   *
   *  Default 6 → on Earth (g/g_earth = 1) the visual transition is
   *  centered at α ≈ 1/6 ≈ 0.17, which falls at ~15 km altitude given
   *  Earth's scale height (~8400 m, derived from kT/μg). On Mars-like
   *  worlds (low g, thin atm) rockets engage near the surface; on
   *  Jupiter-like worlds (thick atm, high g) wings carry the bird
   *  much higher. */
  WING_LIFT_THRESHOLD: 6,
  /** Warp inhibition exponent. Gate is `1 - (R / r)^N` where R is
   *  the dominant body's radius and r is the player's distance from
   *  its center. Equivalent to `1 - (g_at_player / g_surface)^(N/2)`
   *  — gravity-derived inhibition that smoothly hands off between
   *  hill spheres (the (R/r)² values for parent and child bodies are
   *  near-equal at hill boundaries by construction). Default 2 is
   *  the pure inverse-square law; higher N opens warp faster with
   *  altitude.
   *
   *  Note: this constant is declared once above (in the hyperspeed
   *  block). This trailing definition is intentionally left out — the
   *  friction term reads SPEED.WARP_INHIBITION_POWER from the earlier
   *  entry. */
};

export const CONTROLS = {
  /** Below this normalized screen Y (0=top), aim is "above the ground" —
   *  used for the running-takeoff trigger (wings unfold once aim is
   *  above this AND walk speed > walkSpeedMax). The boundary is mobile:
   *  effective threshold grows with walk speed via `runZoneSpeedScale`
   *  so the running-takeoff zone gets larger the faster you go. */
  runTakeoffMouseThreshold: 0.35,
  /** Additional fraction of screen-Y added to the run-takeoff zone per
   *  unit (walkSpeed / walkSpeedMax). At full walking speed the zone
   *  reaches `runTakeoffMouseThreshold + runZoneSpeedScale`. */
  runZoneSpeedScale: 0.25,
  /** Top-of-screen Y below which the JUMP takeoff always fires (even
   *  from a standstill). Tight zone — has to be deliberate. */
  jumpTakeoffMouseThreshold: 0.08,
  /** Mouse distance from center (normalized 0..1) needed for the jump
   *  takeoff zone — combined with `jumpTakeoffMouseThreshold` so the
   *  trigger sits at the top-center band of the screen. */
  jumpTakeoffMouseRadius: 0.4,
  /** Altitude (above ground) at which flight auto-transitions to walking. */
  landingAltitude: 2.0,
  /**
   * How quickly the body's up-axis re-aligns toward the dominant gravity-up
   * when flying. Higher = snappier orientation. Modulated by influence so
   * deep-space drifting preserves the player's current attitude.
   */
  gravityAlignRate: 4.0,
};

export const SKY = {
  /** Above this altitude (above sea level), atmosphere starts thinning.
   *  Tuned high enough that a gull walking around or flying low doesn't
   *  accidentally cross into the space-fade band — has to deliberately
   *  climb. */
  atmosphereStart: 500,
  /** Above this altitude, considered space (full starfield, no fog). At
   *  32 m/s vertical climb rate, reaching space takes ~90 seconds — clear
   *  intent rather than accident. */
  spaceAltitude: 3000,
};

// Galactic-frame settings — drive the conversion between light-year units
// (the registry's absolute coordinate space) and scene meters (what
// physics/rendering work in), plus the radii that govern when a star is
// materialized as a real solar system.
//
// Floating origin: every frame the world re-anchors the scene origin to
// the player's current galactic position so Float32 precision in the GPU
// buffer stays usable even at galactic scales (~100k ly). Distant
// objects at large scene-coords have correspondingly large quantization
// error, but the error is small in ANGULAR terms (error / distance) and
// invisible to the player.
export const GALAXY = {
  /**
   * Scene-meters per light-year — set to the real value
   * (9.4607304725808 × 10¹⁵ m). With this, 1 scene meter == 1 real
   * meter all the way out to the galactic scale, so in-system physics,
   * orbital geometry, and interstellar travel all share the same
   * units. Float32 precision concerns for distant rendering are
   * absorbed by the continuous floating-origin rebase (keeps the
   * camera-relative coords small) — see the comment above this block.
   */
  lyToSceneMeters: 9.4607304725808e15,
  /**
   * Player-to-star galactic distance (ly) below which a star is lifted
   * into a full SolarSystem. Picked just inside the natural Hill-sphere
   * extent of a single star at our scale: a star's Hill is ~200 Mm =
   * 0.2 ly, so 0.5 ly gives ~300 Mm of materialized lead-in for orbital
   * approach.
   */
  materializeLy: 0.5,
  /**
   * Hysteresis band — once materialized, a system stays loaded until
   * the player is this far away. Prevents flicker when the player
   * loiters near the boundary.
   */
  dematerializeLy: 0.8,
  /**
   * Canonical home-system seed. Whichever star is designated home gets
   * this systemSeed so generateSolarSystem produces the familiar
   * yellow-sun + earthlike-with-one-moon layout.
   */
  homeSystemSeed: 1337,
  /**
   * Per-cell brightness scale for non-leaf aggregates. Final per-cell
   * brightness is `cell.intrinsic × AGGREGATE_INTRINSIC_SCALE × weight ×
   * aggregateBrightness`, so brightness scales linearly with the
   * cluster's star count. Lower this for darker skies; raise for more
   * visible clusters. Bound by the cluster-glow slider in the dev
   * panel.
   */
  aggregateBrightness: 0.05,
  /**
   * Per-star contribution to aggregate cluster brightness — the linear
   * calibration in `k = cell.intrinsic × aggregateIntrinsicScale ×
   * weight × aggregateBrightness`. Larger values make dense cells
   * (bulge) dramatically brighter than sparse cells (arm edge),
   * exaggerating the density structure of the galaxy. Bound by the
   * `intrinsic scale` slider in the dev panel.
   */
  aggregateIntrinsicScale: 5e-10,
  /**
   * Maximum pixel size for an aggregate cluster sprite. Big enough
   * that overlapping cells' soft halos fuse into a smooth band
   * (single sprite radii need to exceed cell angular separation in
   * the rendered view). Capped so a very close cluster doesn't
   * fill the field of view entirely.
   */
  aggregateMaxSize: 800,
};

// ── Object-readout (body-anchored lock + popup info card) ──────────────────
// Optional setting (on for now). When enabled, the center lock-ring is
// suppressed and replaced with a ring drawn AROUND the candidate body in
// world-space plus 4 arrows that animate toward it as lock builds. At full
// lock, a popup info card appears above the body with property icons and
// a distance indicator.
export const READOUT = {
  /** Master toggle. Disable to fall back to the legacy center lock-ring. */
  enabled: true,
  /**
   * Minimum on-screen radius (px) for the body-anchored ring. The ring
   * is sized to the body's apparent radius (so it hugs the disc when
   * close), but clamps to this minimum so the ring is visible even when
   * the body is a sub-pixel dot. Bigger value = the ring reads as
   * "locked area" from further away.
   */
  ringMinPx: 38,
  /** Maximum ring radius (px) so the ring doesn't grow off-screen once
   *  the player is close enough to see the body's full disc. */
  ringMaxPx: 220,
  /** Approach distance (px from ring center) of the 4 cardinal arrows at
   *  lockProgress = 0. They animate from this distance inward toward the
   *  ring as the lock fills. */
  arrowStartPx: 64,
  /**
   * Soft bird auto-orient pull when the readout popup is open. This is
   * a fallback — the primary "look at target" mechanism is the cursor-
   * in-popup override (the main loop rewrites `input.mouseX/Y` to the
   * target's projected pixel while gaze is on the popup). The pull
   * here just keeps very-low-input drifts from slowly walking the
   * heading off target if the player is hovering outside the popup.
   * Set to 0 to disable; values around 0.1–0.3 feel like a gentle
   * magnet.
   */
  birdPull: 0.2,
  /**
   * Dwell time (ms) for popup interactive elements. Hovering a sub-
   * object dot or the parent-up button for this long fires the
   * selection — the standard eyegaze interaction model. Mouse clicks
   * always fire immediately as a fallback.
   */
  dwellMs: 700,
  /**
   * Threshold (multiples of one pixel of angular size) below which the
   * dominant-pixel collapse switches the lock target to its parent.
   * At 1.0 the collapse triggers exactly when body & parent share a
   * pixel; >1 gives a small hysteresis margin so the transition feels
   * stable at the boundary.
   */
  collapsePixelMultiplier: 1.25,
};

// ── Render tuning (live-slider-bound) ───────────────────────────────────────
// Active sliders only — these are the ones actually useful for iterating
// on the current visual state. One-off diagnostic sliders are removed as
// their tests resolve.
export const GFX = {
  /** UnrealBloomPass luminance threshold — pixels above this bloom. */
  bloomThreshold: 1.5,
  /** UnrealBloomPass strength — how much bloom adds to the source pixel. */
  bloomStrength: 0.9,
  /** UnrealBloomPass radius — kept as a constant (no slider). */
  bloomRadius: 0.6,
  /** Renderer tone-mapping exposure (ACES filmic). */
  exposure: 0.7,
  // Multipliers below stay as constants (default 1, no slider) so the
  // rest of the codebase keeps working but they don't clutter the UI.
  ambientMult: 1.0,
  haloMult: 1.0,
  fogDensityMult: 1.0,
  atmShellMult: 1.0,
  starfieldMult: 1.0,
  // ── Cloud system (cloud-field.ts + cloud-system.ts) ───────────────────
  // The post-process VolumetricCloudPass has been replaced by a per-body
  // hierarchical billboard system. These sliders tune the runtime; the
  // density-field structure (layers, banding, clumps) is derived per-body
  // from the physics-system atmosphere and isn't user-tunable here.
  //
  /** Overall opacity multiplier on the cloud sprite material. 0 = clouds
   *  invisible; 1 = full opacity. Useful for isolating other visual
   *  issues without removing the cloud system entirely. */
  cloudMult: 1.0,
  /** Sprite oversize multiplier — scales each billboard's render size
   *  relative to its cell extent. 1.0 = exact cell size (visible grid);
   *  ~1.4 = adjacent cells overlap into a continuous mass. */
  cloudSpriteOversize: 1.4,
  /** Minimum sample density below which a cell emits no sprite. Lower
   *  values render more wispy clouds but cost more sort/fill work. */
  cloudMinDensity: 0.04,
  /** Wind drift speed multiplier — scales the derived jet speed per
   *  body. 0 = clouds static; 1 = derived speed; >1 = exaggerated drift
   *  (useful when debugging banding). */
  cloudWindMult: 1.0,
  /** Fog modulation strength — when the camera enters a dense cloud
   *  cell, the sky pass adds this × density × tier-scale to the
   *  FogExp2 density so visibility drops naturally. 0 disables. */
  cloudFogBoost: 0.6,
};
