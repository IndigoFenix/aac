// Programmatic debug-panel builder. Replaces the previous hand-written
// slider rows in index.html so adding a new constant is a one-line spec
// here rather than HTML + bind-call. Three panels:
//   • Tuning  — live-tunable runtime constants (PLAYER, SPEED, CONTROLS, SKY, GFX)
//   • Readouts — live state values for inspecting the current movement regime
//   • Generation — number inputs that drive world generation; pressing the
//                  "regenerate & reload" button writes the URL hash + reloads
//
// Each panel is collapsible (clicking its toolbar button toggles it). Inside
// each panel, sections use <details>/<summary> so individual categories can
// be expanded/collapsed without losing the whole panel's state.

import { PLAYER, CONTROLS, SPEED, SKY, GFX, GALAXY, CHUNKS, PLANET, CLOUD_RENDERER_NAMES } from "./config";
import { DEFAULT_GALAXY_PARAMS } from "./galaxy";
import type { Player } from "./player";
import type { World } from "./world";
import * as THREE from "three";

// ─── Spec types ─────────────────────────────────────────────────────────────

interface SliderSpec {
  label: string;
  target: Record<string, number>;
  field: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}

interface ReadoutSpec {
  label: string;
  fn: () => string;
}

interface Section {
  title: string;
  open?: boolean;
  sliders?: SliderSpec[];
  readouts?: ReadoutSpec[];
}

// ─── Formatters ─────────────────────────────────────────────────────────────

const fmtInt = (v: number): string => v.toFixed(0);
const fmt1 = (v: number): string => v.toFixed(1);
const fmt2 = (v: number): string => v.toFixed(2);
const fmt3 = (v: number): string => v.toFixed(3);
const fmtPct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const fmtX = (v: number): string => `${v.toFixed(2)}×`;
const fmtExp = (v: number): string => v.toExponential(1);
const fmtBoost = (v: number): string =>
  v >= 1e6 ? `${(v / 1e6).toFixed(1)}M×`
    : v >= 1000 ? `${(v / 1000).toFixed(1)}k×`
      : `${v.toFixed(0)}×`;
const fmtSpeedV = (v: number): string =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)} Gm/s`
    : v >= 1e6 ? `${(v / 1e6).toFixed(2)} Mm/s`
      : v >= 1e3 ? `${(v / 1e3).toFixed(2)} km/s`
        : `${v.toFixed(0)} m/s`;
const fmtMeters = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} km`;
  return `${v.toFixed(1)} m`;
};
const fmtSpeed = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} km/s`;
  return `${v.toFixed(1)} m/s`;
};

// ─── Slider sections — live-tunable runtime constants ──────────────────────

function tuningSections(): Section[] {
  const P = PLAYER as unknown as Record<string, number>;
  const S = SPEED as unknown as Record<string, number>;
  const C = CONTROLS as unknown as Record<string, number>;
  const K = SKY as unknown as Record<string, number>;
  const G = GFX as unknown as Record<string, number>;
  const A = GALAXY as unknown as Record<string, number>;
  return [
    {
      title: "Walking & ground movement",
      sliders: [
        { label: "walk speed", target: P, field: "walkSpeedMax", min: 1, max: 50, step: 0.5, format: fmt1 },
        { label: "walk accel", target: P, field: "walkAccel", min: 1, max: 60, step: 1, format: fmt1 },
        { label: "walk lean", target: P, field: "walkLeanMax", min: 0, max: 1.2, step: 0.05, format: fmt2 },
        { label: "rest pitch", target: P, field: "walkRestPitch", min: 0, max: 1.2, step: 0.05, format: fmt2 },
        { label: "slope wall", target: P, field: "walkSlopeWallAngle", min: 0.2, max: 1.4, step: 0.05, format: fmt2 },
        { label: "slope slow", target: P, field: "walkSlopeSlowAngle", min: 0.1, max: 1.2, step: 0.05, format: fmt2 },
        { label: "eye height", target: P, field: "eyeHeight", min: 0.2, max: 3, step: 0.05, format: fmt2 },
        { label: "collide r", target: P, field: "collisionRadius", min: 0.1, max: 2, step: 0.05, format: fmt2 },
        { label: "normal eps", target: P, field: "groundNormalEpsilon", min: 0.1, max: 5, step: 0.1, format: fmt2 },
      ],
    },
    {
      title: "Takeoff (run + jump)",
      sliders: [
        { label: "run takeoff", target: P, field: "runningTakeoffSpeed", min: 2, max: 60, step: 0.5, format: fmt1 },
        { label: "wing unfold rt", target: P, field: "wingExtendRate", min: 0.5, max: 30, step: 0.5, format: fmt1 },
        { label: "jump secs", target: P, field: "jumpTakeoffSeconds", min: 0.05, max: 2, step: 0.05, format: fmt2 },
        { label: "jump speed", target: P, field: "jumpTakeoffSpeed", min: 1, max: 30, step: 0.5, format: fmt1 },
        { label: "jump pitch", target: P, field: "jumpTakeoffPitchBelow", min: 0, max: 1, step: 0.05, format: fmt2 },
        { label: "jump friction", target: P, field: "jumpTakeoffGroundFriction", min: 0, max: 20, step: 0.5, format: fmt1 },
        { label: "rocket α gate", target: P, field: "rocketRegimeAlpha", min: 0, max: 0.5, step: 0.005, format: fmt3 },
        { label: "run zone top", target: C, field: "runTakeoffMouseThreshold", min: 0, max: 0.6, step: 0.01, format: fmt2 },
        { label: "run zone scale", target: C, field: "runZoneSpeedScale", min: 0, max: 0.6, step: 0.01, format: fmt2 },
        { label: "jump zone top", target: C, field: "jumpTakeoffMouseThreshold", min: 0, max: 0.3, step: 0.01, format: fmt2 },
        { label: "jump zone rad", target: C, field: "jumpTakeoffMouseRadius", min: 0, max: 0.8, step: 0.02, format: fmt2 },
      ],
    },
    {
      title: "Atmospheric flight",
      open: true,
      sliders: [
        { label: "fly speed", target: P, field: "flySpeed", min: 5, max: 200, step: 1, format: fmtInt },
        { label: "pitch rate", target: P, field: "flyPitchRate", min: 0.1, max: 5, step: 0.1, format: fmt2 },
        { label: "yaw rate", target: P, field: "flyYawRate", min: 0.1, max: 5, step: 0.1, format: fmt2 },
        { label: "bank amt", target: P, field: "flyBankAmount", min: 0, max: 2, step: 0.05, format: fmt2 },
        { label: "grav align", target: C, field: "gravityAlignRate", min: 0, max: 20, step: 0.25, format: fmt2 },
      ],
    },
    {
      title: "Low-altitude brake",
      sliders: [
        { label: "lowalt cap", target: P, field: "flyLowAltCap", min: 1, max: 100, step: 0.5, format: fmt1 },
        { label: "clear scale", target: P, field: "flyLowAltClearScale", min: 10, max: 1000, step: 10, format: fmtInt },
        { label: "sample r", target: P, field: "flyLowAltSampleRadius", min: 10, max: 500, step: 5, format: fmtInt },
        { label: "friction base", target: P, field: "flyLowAltFrictionBase", min: 0, max: 10, step: 0.1, format: fmt1 },
        { label: "friction max", target: P, field: "flyLowAltMaxFriction", min: 0, max: 30, step: 0.5, format: fmt1 },
      ],
    },
    {
      title: "Landing & crashing",
      sliders: [
        { label: "soft speed", target: P, field: "landSoftSpeed", min: 1, max: 50, step: 0.5, format: fmt1 },
        { label: "good angle·", target: P, field: "landGoodAngleDot", min: 0, max: 1, step: 0.02, format: fmt2 },
        { label: "bounce spd", target: P, field: "landBounceSpeed", min: 5, max: 100, step: 1, format: fmt1 },
        { label: "stun spd", target: P, field: "landStunSpeed", min: 10, max: 200, step: 1, format: fmt1 },
        { label: "stun bad", target: P, field: "stunDurationBadAngle", min: 0.1, max: 6, step: 0.1, format: fmt1 },
        { label: "stun high", target: P, field: "stunDurationHighSpeed", min: 0.1, max: 8, step: 0.1, format: fmt1 },
        { label: "bounce retain", target: P, field: "bounceRetention", min: 0, max: 1, step: 0.05, format: fmt2 },
        { label: "land alt", target: C, field: "landingAltitude", min: 0.5, max: 10, step: 0.1, format: fmt1 },
      ],
    },
    {
      title: "Water / swim / dive",
      sliders: [
        { label: "swim speed", target: P, field: "swimSpeedMax", min: 0.5, max: 20, step: 0.25, format: fmt2 },
        { label: "submerge", target: P, field: "swimSubmersion", min: 0, max: 1, step: 0.02, format: fmt2 },
        { label: "dive angle·", target: P, field: "diveAngleDot", min: -1, max: 0, step: 0.05, format: fmt2 },
        { label: "dive mouseY", target: P, field: "swimDiveMouseThreshold", min: -1, max: 0, step: 0.05, format: fmt2 },
        { label: "dive secs", target: P, field: "diveSeconds", min: 0.1, max: 3, step: 0.05, format: fmt2 },
        { label: "underwater", target: P, field: "underwaterSpeed", min: 0.5, max: 15, step: 0.25, format: fmt2 },
        { label: "water dive·", target: P, field: "waterDiveImpactDot", min: -1, max: 0, step: 0.05, format: fmt2 },
      ],
    },
    {
      title: "Speed & warp",
      open: true,
      sliders: [
        { label: "alt accel A", target: S, field: "ALTITUDE_ACCEL_FACTOR", min: 0.5, max: 30, step: 0.1, format: fmt1 },
        { label: "min flight V", target: S, field: "MIN_FLIGHT_SPEED", min: 0, max: 500, step: 1, format: fmtInt },
        { label: "wing lift thr", target: S, field: "WING_LIFT_THRESHOLD", min: 1, max: 30, step: 0.25, format: fmt2 },
        { label: "hyper gain", target: S, field: "HYPER_GAIN_RATE", min: 0.05, max: 5, step: 0.05, format: fmt2 },
        { label: "hyper loss", target: S, field: "HYPER_LOSS_RATE", min: 0.1, max: 20, step: 0.1, format: fmt2 },
        { label: "lock brake", target: S, field: "HYPER_BRAKE_RATE", min: 0.1, max: 20, step: 0.1, format: fmt2 },
        { label: "hyper center", target: S, field: "HYPER_CENTER_THRESHOLD", min: 0.02, max: 0.5, step: 0.01, format: fmt2 },
        { label: "hyper max V", target: S, field: "HYPER_MAX_SPEED", min: 1e9, max: 1e18, step: 1e9, format: fmtSpeedV },
        { label: "gal cap boost", target: S, field: "GALACTIC_DENSITY_BOOST", min: 1, max: 1e6, step: 1, format: (v) => v >= 1000 ? `${(v/1000).toFixed(0)}k×` : `${v.toFixed(0)}×` },
        { label: "gal ref dens", target: S, field: "GALACTIC_REFERENCE_DENSITY", min: 1e-4, max: 10, step: 1e-3, format: fmtExp },
        { label: "hyper accel", target: S, field: "HYPER_ACCEL_RATE", min: 0.05, max: 5, step: 0.05, format: fmt2 },
        { label: "warp atm gate", target: S, field: "WARP_GATE_POWER", min: 0.5, max: 20, step: 0.1, format: fmt2 },
        { label: "warp inhibit N", target: S, field: "WARP_INHIBITION_POWER", min: 0.5, max: 8, step: 0.1, format: fmt2 },
        { label: "lock cone cos", target: S, field: "HYPER_CONE_COS", min: 0.5, max: 0.999, step: 0.001, format: fmt3 },
        { label: "lock time", target: S, field: "HYPER_LOCK_TIME", min: 0.25, max: 6, step: 0.1, format: fmt1 },
        { label: "lock decay", target: S, field: "HYPER_LOCK_DECAY", min: 0.1, max: 3, step: 0.05, format: fmt2 },
        { label: "lock approach", target: S, field: "LOCK_APPROACH_RATE", min: 0.05, max: 5, step: 0.05, format: fmt2 },
        { label: "lock boost", target: S, field: "LOCK_APPROACH_BOOST", min: 0.5, max: 100, step: 0.5, format: (v) => `${v.toFixed(1)}×` },
        { label: "climb fric", target: S, field: "WING_FRICTION_CLIMB", min: 0.1, max: 20, step: 0.1, format: fmt2 },
        { label: "dive fric", target: S, field: "WING_FRICTION_DIVE", min: 0.05, max: 10, step: 0.05, format: fmt2 },
        { label: "swoop fac", target: S, field: "WING_SWOOP_FACTOR", min: 0.5, max: 5, step: 0.1, format: fmt2 },
      ],
    },
    {
      title: "Flight strain",
      open: true,
      sliders: [
        { label: "vacuum wt", target: S, field: "STRAIN_VACUUM_WEIGHT", min: 0, max: 2, step: 0.05, format: fmt2 },
        { label: "climb wt", target: S, field: "STRAIN_CLIMB_WEIGHT", min: 0, max: 2, step: 0.05, format: fmt2 },
        { label: "gravity wt", target: S, field: "STRAIN_GRAVITY_WEIGHT", min: 0, max: 2, step: 0.05, format: fmt2 },
      ],
    },
    {
      title: "Sky / atmosphere",
      sliders: [
        { label: "atm start", target: K, field: "atmosphereStart", min: 0, max: 5000, step: 50, format: fmtInt },
        { label: "space alt", target: K, field: "spaceAltitude", min: 500, max: 20000, step: 100, format: fmtInt },
      ],
    },
    {
      title: "Render",
      sliders: [
        { label: "bloom thr", target: G, field: "bloomThreshold", min: 0.1, max: 5, step: 0.05, format: fmt2 },
        { label: "bloom str", target: G, field: "bloomStrength", min: 0, max: 3, step: 0.05, format: fmt2 },
        { label: "bloom rad", target: G, field: "bloomRadius", min: 0, max: 2, step: 0.05, format: fmt2 },
        { label: "exposure", target: G, field: "exposure", min: 0.1, max: 2.5, step: 0.05, format: fmt2 },
        { label: "ambient", target: G, field: "ambientMult", min: 0, max: 5, step: 0.05, format: fmtX },
        { label: "halo", target: G, field: "haloMult", min: 0, max: 5, step: 0.05, format: fmtX },
        { label: "fog density", target: G, field: "fogDensityMult", min: 0, max: 5, step: 0.05, format: fmtX },
        { label: "atm shell", target: G, field: "atmShellMult", min: 0, max: 5, step: 0.05, format: fmtX },
        { label: "atm fuzz", target: G, field: "atmFuzz", min: 0.05, max: 1, step: 0.05, format: fmt2 },
        { label: "sky fog km", target: G, field: "skyFogKm", min: 1, max: 100, step: 1, format: fmtInt },
        { label: "starfield", target: G, field: "starfieldMult", min: 0, max: 5, step: 0.05, format: fmtX },
        { label: "ocean z bias", target: G, field: "oceanDepthBias", min: 0, max: 20, step: 0.5, format: fmt2 },
        // warpMaxBoost is purely a visual-shader normalizer for the warp
        // distortion pass — keep its slider with the render controls.
        { label: "warp shader", target: P, field: "warpMaxBoost", min: 1, max: 1e9, step: 1e6, format: fmtBoost },
      ],
    },
    {
      title: "Clouds",
      sliders: [
        { label: "renderer", target: G, field: "cloudRenderer", min: 0, max: CLOUD_RENDERER_NAMES.length - 1, step: 1, format: (v) => CLOUD_RENDERER_NAMES[Math.round(v)] ?? String(v) },
        { label: "opacity", target: G, field: "cloudMult", min: 0, max: 2, step: 0.05, format: fmtX },
        { label: "sprite size", target: G, field: "cloudSpriteOversize", min: 0.5, max: 3, step: 0.05, format: fmtX },
        { label: "cover thresh", target: G, field: "cloudMinDensity", min: 0, max: 0.6, step: 0.01, format: fmt3 },
        { label: "wind mult", target: G, field: "cloudWindMult", min: 0, max: 5, step: 0.1, format: fmtX },
        { label: "fog boost", target: G, field: "cloudFogBoost", min: 0, max: 2, step: 0.05, format: fmtX },
        { label: "detail", target: G, field: "cloudDetailMult", min: 0, max: 2, step: 0.05, format: fmtX },
        { label: "vigor", target: G, field: "cloudVigorMult", min: 0, max: 2, step: 0.05, format: fmtX },
        { label: "bake ms", target: G, field: "cloudBakeMs", min: 0, max: 2, step: 0.05, format: fmt2 },
        { label: "update every", target: G, field: "cloudUpdateEvery", min: 1, max: 4, step: 1, format: fmtInt },
      ],
    },
    {
      title: "Galaxy aggregate",
      sliders: [
        { label: "cluster glow", target: A, field: "aggregateBrightness", min: 0, max: 0.5, step: 0.005, format: fmt3 },
        { label: "cluster scl", target: A, field: "aggregateIntrinsicScale", min: 0, max: 5e-9, step: 1e-11, format: fmtExp },
        { label: "cluster max", target: A, field: "aggregateMaxSize", min: 100, max: 2000, step: 50, format: fmtInt },
      ],
    },
  ];
}

// ─── Readout sections — live state values ──────────────────────────────────

function readoutSections(player: Player, world: World, input: { mouseX: number; mouseY: number }): Section[] {
  const s = player.state;
  const surfacePt = new THREE.Vector3();
  const dirToCenter = new THREE.Vector3();
  const displayVel = new THREE.Vector3();
  return [
    {
      title: "Hyperspeed",
      open: true,
      readouts: [
        { label: "hyper mult", fn: () => {
          const m = s.hyperMult;
          if (m < 100) return `${m.toFixed(1)}×`;
          return `${m.toExponential(1)}×`;
        }},
        { label: "desired", fn: () => fmtSpeedV(s.flightDebug.desiredSpeed) },
        { label: "locked body", fn: () => s.lockedBodyId ?? "—" },
        { label: "lock progress", fn: () => fmt2(s.lockProgress) },
        { label: "warp inhibit", fn: () => fmt3(s.flightDebug.warpInhibition) },
        { label: "gal density", fn: () => world.galacticDensityAt(s.position).toExponential(2) },
        { label: "warp gate", fn: () => fmt3(s.flightDebug.warpGate) },
      ],
    },
    {
      title: "Mode & state",
      open: true,
      readouts: [
        { label: "mode", fn: () => s.mode },
        { label: "active mode", fn: () => s.activeMode },
        { label: "wings ext", fn: () => fmt2(s.wingExtension) },
        { label: "legs ext", fn: () => fmt2(s.legsExtended) },
        { label: "bank", fn: () => fmt2(s.bank) },
        { label: "takeoff phase", fn: () => s.mode === "takeoff" ? fmt2(s.takeoffPhase) : "—" },
        { label: "dive phase", fn: () => s.mode === "diving" ? fmt2(s.divePhase) : "—" },
        { label: "stunned (s)", fn: () => s.stunnedTime > 0 ? fmt2(s.stunnedTime) : "—" },
      ],
    },
    {
      title: "Position & frame",
      open: true,
      readouts: [
        { label: "dominant", fn: () => s.gravity.dominant ? `${s.gravity.dominant.type} ${s.gravity.dominant.id.slice(-6)}` : "—" },
        { label: "influence", fn: () => fmt3(s.gravity.influence) },
        { label: "altitude", fn: () => fmtMeters(s.gravity.altitude) },
        { label: "ground h", fn: () => {
          const body = s.gravity.dominant;
          if (!body || !body.walkable || !body.heightAt) return "(non-walkable)";
          dirToCenter.copy(s.position).sub(body.worldPosition);
          if (dirToCenter.lengthSq() < 1) return "—";
          return fmtMeters(body.heightAt(dirToCenter.normalize()));
        }},
        { label: "dist center", fn: () => {
          const body = s.gravity.dominant;
          if (!body) return "—";
          return fmtMeters(s.position.distanceTo(body.worldPosition));
        }},
        { label: "surface pt", fn: () => {
          const body = s.gravity.dominant;
          if (!body || !body.surfaceAt) return "—";
          body.surfaceAt(s.position, surfacePt);
          return `${surfacePt.x.toFixed(0)}, ${surfacePt.y.toFixed(0)}, ${surfacePt.z.toFixed(0)}`;
        }},
        { label: "position", fn: () => `${s.position.x.toFixed(1)}, ${s.position.y.toFixed(1)}, ${s.position.z.toFixed(1)}` },
        { label: "pos finite", fn: () => {
          const ok = Number.isFinite(s.position.x) && Number.isFinite(s.position.y) && Number.isFinite(s.position.z) &&
            Number.isFinite(s.velocity.x) && Number.isFinite(s.velocity.y) && Number.isFinite(s.velocity.z);
          return ok ? "ok" : "BAD";
        }},
      ],
    },
    {
      title: "Velocity & speed",
      open: true,
      readouts: [
        // Real speed = how fast the player actually moves through space.
        // While flying, position advances by `forward × totalSpeed × dt`,
        // so this equals totalSpeed (and warpVelocity magnitude — both
        // are the same physical quantity, shown once here).
        { label: "real speed", fn: () => {
          if (s.mode === "walking") return fmtSpeed(Math.abs(s.walkSpeed));
          return fmtSpeed(s.warpVelocity.length());
        }},
        { label: "rel velocity", fn: () => {
          displayVel.copy(s.velocity);
          if (s.gravity.dominant) displayVel.sub(s.gravity.dominant.velocity);
          return fmtSpeed(displayVel.length());
        }},
        { label: "walk speed", fn: () => fmtSpeed(s.walkSpeed) },
        { label: "upward spd", fn: () => fmtSpeed(s.flightDebug.upwardSpeed) },
      ],
    },
    {
      title: "Atmosphere & gravity",
      open: true,
      readouts: [
        { label: "atm α", fn: () => fmt3(s.lastAtmAlpha) },
        { label: "atm body", fn: () => {
          const r = world.atmosphericDensityAt(s.position);
          return r.body ? `${r.body.type} ${r.body.id.slice(-6)}` : "—";
        }},
        { label: "in atmos", fn: () => s.lastAtmAlpha > 0.001 ? "yes" : "no" },
        { label: "gravity m/s²", fn: () => fmt2(s.lastGravityMag) },
        { label: "gravity ×G", fn: () => fmtX(s.lastGravityMag / 9.81) },
        { label: "flight strain", fn: () => fmt2(s.flightStrain) },
      ],
    },
    {
      title: "Speed model",
      open: true,
      readouts: [
        { label: "active", fn: () => s.activeMode },
        { label: "weights", fn: () =>
          `W${fmtPct(s.lastModeWeights.wing)} R${fmtPct(s.lastModeWeights.rocket)} P${fmtPct(s.lastModeWeights.warp)}` },
        { label: "rocket vis", fn: () => fmt2(s.rocketRegimeWeight) },
        { label: "alt speed", fn: () => fmtSpeed(s.flightDebug.altSpeed) },
        { label: "target speed", fn: () => fmtSpeed(s.flightDebug.targetSpeed) },
        { label: "desired", fn: () => fmtSpeedV(s.flightDebug.desiredSpeed) },
        { label: "wing speed", fn: () => fmtSpeedV(s.flightDebug.vWing) },
        { label: "total speed", fn: () => fmtSpeedV(s.flightDebug.totalSpeed) },
        { label: "fwd·up", fn: () => fmt2(s.flightDebug.forwardUp) },
        { label: "climbT", fn: () => fmt2(s.flightDebug.climbT) },
        { label: "warp inhibit", fn: () => fmt3(s.flightDebug.warpInhibition) },
        { label: "warp gate", fn: () => fmt3(s.flightDebug.warpGate) },
        { label: "low-alt cap", fn: () => fmtSpeed(s.flightDebug.lowAltCap) },
        { label: "obstacle clr", fn: () => fmtMeters(s.flightDebug.obstacleClearance) },
      ],
    },
    {
      title: "Dominant body (warp)",
      open: true,
      readouts: [
        // The body whose hill sphere contains the player — drives the
        // warp hill-gate. Inside Earth's hill: Earth. Outside Earth's
        // hill but inside Sun's hill: Sun. Falls back to nearest body
        // by distance if no body's hill contains the player.
        { label: "id", fn: () => s.flightDebug.dominantBodyId ?? "—" },
        { label: "altitude", fn: () => fmtMeters(s.flightDebug.dominantAlt) },
        { label: "hill radius", fn: () => fmtMeters(s.flightDebug.dominantHillRadius) },
        { label: "alt / hill", fn: () => {
          const f = s.flightDebug.hillFraction;
          if (!Number.isFinite(f)) return "∞ (interstellar)";
          if (f >= 0.01) return fmt3(f);
          return f.toExponential(2);
        }},
        { label: "angular size", fn: () => {
          const a = world.largestAngularSizeAt(s.position);
          if (a <= 0) return "—";
          if (a > 0.01) return `${(a * 57.2958).toFixed(2)}°`;
          return a.toExponential(2);
        }},
      ],
    },
    {
      title: "Nearest body (brake)",
      readouts: [
        // The geometrically-closest body — drives the low-altitude
        // safety brake. Distinct from "dominant body" above: a moon
        // nearby is the closest brake source even if you're still
        // dominated by the parent planet.
        { label: "id", fn: () => s.flightDebug.nearestBodyId ?? "—" },
        { label: "altitude", fn: () => fmtMeters(s.flightDebug.nearestAlt) },
      ],
    },
    {
      title: "Input",
      readouts: [
        { label: "mouse", fn: () => `${input.mouseX.toFixed(2)}, ${input.mouseY.toFixed(2)}` },
        { label: "mx, my", fn: () => `${(input.mouseX * 2 - 1).toFixed(2)}, ${(-(input.mouseY * 2 - 1)).toFixed(2)}` },
      ],
    },
  ];
}

// ─── DOM building ──────────────────────────────────────────────────────────

function buildSlider(spec: SliderSpec): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "dbg-row";
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = spec.label;
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(spec.min);
  slider.max = String(spec.max);
  slider.step = String(spec.step);
  slider.value = String(spec.target[spec.field]);
  const val = document.createElement("span");
  val.className = "val";
  const fmt = spec.format ?? fmt2;
  val.textContent = fmt(spec.target[spec.field]);
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    spec.target[spec.field] = v;
    val.textContent = fmt(v);
  });
  row.appendChild(lbl);
  row.appendChild(slider);
  row.appendChild(val);
  return row;
}

function buildReadout(spec: ReadoutSpec): { row: HTMLDivElement; refresh: () => void } {
  const row = document.createElement("div");
  row.className = "dbg-readout";
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = spec.label;
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = "—";
  row.appendChild(k);
  row.appendChild(v);
  let last = "";
  return {
    row,
    refresh: () => {
      let next: string;
      try {
        next = spec.fn();
      } catch {
        next = "—";
      }
      if (next !== last) {
        v.textContent = next;
        last = next;
      }
    },
  };
}

function buildSection(section: Section): { el: HTMLDetailsElement; refresh: () => void } {
  const details = document.createElement("details");
  if (section.open) details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = section.title;
  details.appendChild(summary);
  const body = document.createElement("div");
  body.className = "section-body";
  details.appendChild(body);

  const refreshers: Array<() => void> = [];
  if (section.sliders) {
    for (const s of section.sliders) body.appendChild(buildSlider(s));
  }
  if (section.readouts) {
    for (const r of section.readouts) {
      const built = buildReadout(r);
      body.appendChild(built.row);
      refreshers.push(built.refresh);
    }
  }
  return {
    el: details,
    refresh: () => {
      // Only run refreshers while the section is open — keeps the
      // readout loop cheap when sections are collapsed.
      if (details.open) {
        for (const r of refreshers) r();
      }
    },
  };
}

// ─── Generation panel (number inputs + reload button) ──────────────────────

function buildGenerationPanel(panel: HTMLElement, universeSeed: number): void {
  const section = document.createElement("details");
  section.open = true;
  const summary = document.createElement("summary");
  summary.textContent = "Generation (regenerate to apply)";
  section.appendChild(summary);
  const body = document.createElement("div");
  body.className = "section-body";
  section.appendChild(body);

  interface GenField {
    key: string;
    label: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
  }
  const fields: GenField[] = [
    { key: "seed", label: "seed", value: universeSeed },
    { key: "radius", label: "galaxy radius (ly)", value: DEFAULT_GALAXY_PARAMS.radius, min: 500, max: 1_000_000, step: 500 },
    { key: "arms", label: "arms", value: DEFAULT_GALAXY_PARAMS.arms, min: 1, max: 8, step: 1 },
    { key: "armstr", label: "arm strength", value: DEFAULT_GALAXY_PARAMS.armStrength, min: 0, max: 5, step: 0.1 },
    { key: "ltsm", label: "ly → m", value: GALAXY.lyToSceneMeters, min: 1e6, max: 1e16, step: 1e8 },
    { key: "mat", label: "materialize (ly)", value: GALAXY.materializeLy, min: 0.05, max: 5, step: 0.05 },
    { key: "demat", label: "dematerialize (ly)", value: GALAXY.dematerializeLy, min: 0.05, max: 5, step: 0.05 },
  ];

  // Also include the planet/chunk generation-time constants since "ALL the
  // constants" is part of the request. These are read at world-create time
  // only, so they need the reload to apply.
  const planetGenFields: GenField[] = [
    { key: "planet_radius", label: "planet radius (m)", value: PLANET.radius, step: 1000 },
    { key: "planet_seaLevel", label: "planet sea level", value: PLANET.seaLevel, step: 1 },
    { key: "planet_maxElevation", label: "max elevation", value: PLANET.maxElevation, step: 50 },
    { key: "planet_maxDepth", label: "max depth", value: PLANET.maxDepth, step: 50 },
    { key: "planet_continentFreq", label: "continent freq", value: PLANET.continentFreq, step: 1 },
    { key: "planet_detailFreq", label: "detail freq", value: PLANET.detailFreq, step: 10 },
    { key: "planet_detailWeight", label: "detail weight", value: PLANET.detailWeight, step: 0.01 },
    { key: "planet_influenceFalloff", label: "influence falloff", value: PLANET.influenceFalloff, step: 10000 },
    { key: "chunks_resolution", label: "chunk vertices", value: CHUNKS.resolution, step: 2 },
    { key: "chunks_maxDepth", label: "LOD max depth", value: CHUNKS.maxDepth, step: 1 },
    { key: "chunks_lodThreshold", label: "LOD subdivide", value: CHUNKS.lodThreshold, step: 0.05 },
    { key: "chunks_lodMergeThreshold", label: "LOD merge", value: CHUNKS.lodMergeThreshold, step: 0.05 },
    { key: "chunks_skirtDepth", label: "chunk skirt", value: CHUNKS.skirtDepth, step: 1 },
    { key: "chunks_surfaceDetailRange", label: "detail range", value: CHUNKS.surfaceDetailRange, step: 50 },
    { key: "chunks_surfaceDetailAmount", label: "detail amount", value: CHUNKS.surfaceDetailAmount, step: 0.05 },
  ];

  const inputs = new Map<string, HTMLInputElement>();

  for (const f of [...fields, ...planetGenFields]) {
    const row = document.createElement("div");
    row.className = "dbg-row num";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = f.label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.value = String(f.value);
    if (f.min !== undefined) inp.min = String(f.min);
    if (f.max !== undefined) inp.max = String(f.max);
    if (f.step !== undefined) inp.step = String(f.step);
    row.appendChild(lbl);
    row.appendChild(inp);
    body.appendChild(row);
    inputs.set(f.key, inp);
  }

  const btn = document.createElement("button");
  btn.className = "dbg-action";
  btn.textContent = "regenerate & reload";
  btn.addEventListener("click", () => {
    const params = new URLSearchParams();
    for (const [k, inp] of inputs) {
      if (inp.value !== "") params.set(k, inp.value);
    }
    window.location.hash = params.toString();
    window.location.reload();
  });
  body.appendChild(btn);

  panel.appendChild(section);
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface DebugUIDeps {
  player: Player;
  world: World;
  input: { mouseX: number; mouseY: number };
  universeSeed: number;
}

export interface DebugUI {
  /** Called from the main loop on the same DBG_INTERVAL cadence as before
   *  to refresh readouts. Slider values update synchronously on input
   *  events, so they don't need a tick. */
  refresh(): void;
}

export function setupDebugUI(deps: DebugUIDeps): DebugUI {
  // ── Toolbar buttons toggle the panels open/closed ─────────────────────
  const toolbar = document.getElementById("debug-toolbar")!;
  const panels = new Map<string, HTMLElement>([
    ["readouts", document.getElementById("readouts-panel")!],
    ["tuning", document.getElementById("tuning-panel")!],
    ["generation", document.getElementById("generation-panel")!],
  ]);
  const buttons = toolbar.querySelectorAll<HTMLButtonElement>(".dbg-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.panel!;
      const panel = panels.get(name)!;
      const willOpen = !panel.classList.contains("open");
      panel.classList.toggle("open", willOpen);
      btn.classList.toggle("active", willOpen);
    });
  });

  // ── Tuning panel ─────────────────────────────────────────────────────
  const tuningPanel = panels.get("tuning")!;
  for (const sec of tuningSections()) {
    tuningPanel.appendChild(buildSection(sec).el);
  }

  // ── Readouts panel ───────────────────────────────────────────────────
  const readoutsPanel = panels.get("readouts")!;
  const readoutRefreshers: Array<() => void> = [];
  for (const sec of readoutSections(deps.player, deps.world, deps.input)) {
    const built = buildSection(sec);
    readoutsPanel.appendChild(built.el);
    readoutRefreshers.push(built.refresh);
  }

  // ── Generation panel ─────────────────────────────────────────────────
  const generationPanel = panels.get("generation")!;
  buildGenerationPanel(generationPanel, deps.universeSeed);

  // Open readouts by default so movement debugging is immediately visible
  // on page load — tuning + generation stay collapsed until requested.
  readoutsPanel.classList.add("open");
  toolbar.querySelector<HTMLButtonElement>('[data-panel="readouts"]')!.classList.add("active");

  return {
    refresh() {
      for (const r of readoutRefreshers) r();
    },
  };
}
