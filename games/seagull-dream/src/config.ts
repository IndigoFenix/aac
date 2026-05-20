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
  /** Warp coefficient. Warp = V_BASE × (1/θ - 1/π)^WARP_POWER × gate,
   *  where θ is the largest body's angular size in radians at the
   *  player's position.
   *
   *  Default tuning: WARP_POWER = 1, V_BASE = 1e6 → Earth-Moon ≈ 60s.
   *  The trip-time analysis (treating warp as the dominant term):
   *    dx/dt ≈ V_BASE × x/(2R)   (for x >> R)
   *  integrates to `t = 2R·ln(D/R)/V_BASE`. With D = 60R (Moon distance)
   *  and R = 6.37 Mm, t = 60s requires V_BASE ≈ 870 000. We round up
   *  slightly to 1e6 to give a little headroom for the near-Earth
   *  gate-dampened phase and Moon approach. */
  V_WARP_BASE: 1_000_000,
  /** Steepness of the warp falloff with distance (impedance exponent).
   *  Default 1 makes vWarp linear in impedance, so each doubling of
   *  distance roughly doubles the warp speed — a "gentle" curve where
   *  acceleration is smooth rather than blowing up far out. Higher
   *  values (2, 3) produce sharper acceleration with distance and
   *  make interstellar warp much faster than close-system warp, but
   *  feel jumpy in-system. */
  WARP_POWER: 1,
  WARP_MULT: 1.0,
  /** Floor on angular size for true intergalactic void (no stars within
   *  the registry search radius). Caps the maximum warp speed at
   *  V_BASE × (1/floor − 1/π)^WARP_POWER. Inside a galaxy, the registry
   *  walk always returns a non-zero contribution well above this floor —
   *  it only activates in cosmic voids between galaxies. */
  ANGULAR_FLOOR: 1e-9,
  /** Earth sea-level air density (kg/m³) — reference for atmospheric α. */
  RHO_REF_AIR: 1.225,
  /** Exponent on (1-α) gating warp's atmospheric availability. */
  WARP_GATE_POWER: 5,
  /** p-norm exponent for blending wing-frame speed with warp speed.
   *  Higher → harder switch between modes; lower → softer crossover. */
  BLEND_POWER: 6,
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
   *  With N=2 on Earth (R=6371 km): warp gate ≈ 0.03 at 100 km,
   *  0.24 at 1000 km, 0.86 at 10 000 km, 0.996 at 100 000 km. Other
   *  bodies scale by their own radius: Moon's gate opens proportionally
   *  faster (R=1737 km), Sun's much slower (R=695 Mm). */
  WARP_INHIBITION_POWER: 2,
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
  /** Density multiplier on the VOLUMETRIC cloud pass. 0 = no clouds,
   *  >1 = thicker clouds. */
  cloudVolMult: 1.0,
  /** Cloud debug mode passed to the volumetric pass:
   *    0 = normal volumetric rendering
   *    1 = bypass scene-depth clip (clouds visible even behind geometry)
   *    2 = paint shell-intersection mask as solid red
   *    3 = paint fbm density along ray as grayscale
   *    4 = constant density 1.0 inside the shell (no noise) */
  cloudDebug: 0,
  /** Number of ray-march samples per pixel. Lower = faster but banded.
   *  16 is a solid default — the per-pixel cost is dominated by the
   *  light march on each sample, so doubling steps roughly doubles
   *  cost. Drop to 8 for low-end devices. */
  cloudSteps: 16,
  /** Cloud layer inner / outer altitude in METERS above planet surface.
   *  Wide default band (500 m → 10 km) so the camera consistently sits
   *  INSIDE the cloud shell — shell-intersection always succeeds and
   *  cloud rendering is robust as the player walks / flies through
   *  varied terrain altitudes. Real cloud layers are thinner, but for
   *  rendering correctness at planetary scale a wider band avoids
   *  boundary-case shell-misses. */
  cloudInnerM: 500,
  cloudOuterM: 10000,
  /** Legacy sphere-clouds opacity. Disabled by default — kept so the
   *  sphere mesh isn't a surprise visual artifact. */
  cloudMult: 0.0,
};
