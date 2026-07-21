/**
 * FIXTURE FACING — the game-angle → THREE-yaw conversion, pinned end to end.
 *
 * `facing` is a GAME angle (atan2 over game x/y) naming where a piece's FRONT
 * looks; every producer agrees (placement.ts frameDirAngle/faceInto, furniture.ts
 * chair/chest). Recipes are +X-forward (object-models.ts). Game y renders as
 * THREE +z, so the frames are MIRRORED and the yaw must negate.
 *
 * These tests do NOT re-state the formula — they rotate a real THREE object by
 * the yaw under test and read the resulting world direction back out, so a
 * regression to `rotation.y = facing` fails here rather than in a screenshot.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { fixtureYaw, bedSleeperYaw, sitterYaw } from "@shared/world-engine/render3d";
import { SEAT_TOP_FRAC } from "@shared/world-engine/object-models";

/** Where does a recipe's local `dir` end up, in GAME angle, once yawed? Mirrors
 *  the renderer's own mapping: mesh at rotation.y = yaw, THREE z read as game y. */
function gameAngleOfLocalDir(yaw: number, dir: THREE.Vector3): number {
  const o = new THREE.Object3D();
  o.rotation.y = yaw;
  o.updateMatrixWorld(true);
  const w = dir.clone().applyQuaternion(o.quaternion);
  return Math.atan2(w.z, w.x); // THREE z IS game y (position.set(obj.x, _, obj.y))
}

const LOCAL_FORWARD = new THREE.Vector3(1, 0, 0); // recipes face +X
const LOCAL_BACK = new THREE.Vector3(-1, 0, 0); // backrest / headboard / pillow
const LOCAL_HEAD = new THREE.Vector3(0, 0, -1); // a creature rig's head is -Z

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe("fixtureYaw — a +X recipe ends up looking where `facing` says", () => {
  // ±π/2 is the case the old raw-facing bug got a full 180° wrong: a chair
  // north/south of its table, a cupboard on a wall running along game y.
  for (const facing of [0, Math.PI / 2, -Math.PI / 2, Math.PI, 0.7, -2.4]) {
    it(`facing ${facing.toFixed(3)} → front points at game angle ${facing.toFixed(3)}`, () => {
      const got = gameAngleOfLocalDir(fixtureYaw(facing), LOCAL_FORWARD);
      expect(wrap(got - facing)).toBeCloseTo(0, 10);
    });
  }

  it("undefined facing is treated as 0 (front along game +x)", () => {
    expect(gameAngleOfLocalDir(fixtureYaw(undefined), LOCAL_FORWARD)).toBeCloseTo(0, 10);
  });

  it("REGRESSION: raw `facing` mirrors — provably wrong at ±π/2", () => {
    // The historical bug, stated as a fact so it can't quietly return: assigning
    // facing raw aims the front at −facing. At π/2 that is a 180° error.
    const raw = gameAngleOfLocalDir(Math.PI / 2, LOCAL_FORWARD);
    expect(Math.abs(wrap(raw - Math.PI / 2))).toBeCloseTo(Math.PI, 10); // ±π = the same turn
    // ...while being INVISIBLE along the x axis, which is why it survived.
    expect(gameAngleOfLocalDir(0, LOCAL_FORWARD)).toBeCloseTo(0, 10);
  });
});

describe("a chair faces its table", () => {
  // The generator's own rule (furniture.ts:313): facing = atan2(table − chair).
  const table = { x: 4, y: 7 };
  // Both chairs sit on the door-frame `u` axis, "eachSide" — when u maps to
  // game y this is the ±π/2 worst case the mirror ruined.
  for (const chair of [
    { x: 4, y: 5.88 },
    { x: 4, y: 8.12 },
    { x: 2.88, y: 7 },
    { x: 5.12, y: 7 },
  ]) {
    it(`chair at (${chair.x}, ${chair.y}) has its BACK away from the table`, () => {
      const facing = Math.atan2(table.y - chair.y, table.x - chair.x);
      const yaw = fixtureYaw(facing);

      // The seat's front looks at the table...
      const front = gameAngleOfLocalDir(yaw, LOCAL_FORWARD);
      expect(wrap(front - facing)).toBeCloseTo(0, 10);

      // ...so the backrest (local −X) must be strictly FARTHER from the table
      // than the seat is. This is the property the user actually sees.
      const o = new THREE.Object3D();
      o.rotation.y = yaw;
      o.updateMatrixWorld(true);
      const b = LOCAL_BACK.clone().applyQuaternion(o.quaternion);
      const backPos = { x: chair.x + b.x * 0.165, y: chair.y + b.z * 0.165 };
      const dSeat = Math.hypot(table.x - chair.x, table.y - chair.y);
      const dBack = Math.hypot(table.x - backPos.x, table.y - backPos.y);
      expect(dBack).toBeGreaterThan(dSeat);
    });
  }
});

describe("sitterYaw — a sitter looks where its seat looks", () => {
  // The rig's FORWARD is its local +Z (creature-model.ts facingYaw), a
  // quarter-turn off a fixture recipe's +X — hence a different formula from
  // fixtureYaw for the same intent.
  for (const facing of [0, Math.PI / 2, -Math.PI / 2, Math.PI, -0.4]) {
    it(`seat facing ${facing.toFixed(3)}: rig forward points the same way`, () => {
      const got = gameAngleOfLocalDir(sitterYaw(facing), new THREE.Vector3(0, 0, 1));
      expect(wrap(got - facing)).toBeCloseTo(0, 10);
    });
  }

  it("a diner on a chair ends up looking at the table", () => {
    // The whole chain: chair placed beside a table (furniture.ts rule) → the
    // chair's facing → the SITTER's yaw. This is the property the fix buys.
    const table = { x: 0, y: 0 };
    const chair = { x: 0, y: -1.12 }; // the ±π/2 case the mirror broke
    const facing = Math.atan2(table.y - chair.y, table.x - chair.x);
    const fwd = gameAngleOfLocalDir(sitterYaw(facing), new THREE.Vector3(0, 0, 1));
    const toTable = Math.atan2(table.y - chair.y, table.x - chair.x);
    expect(wrap(fwd - toTable)).toBeCloseTo(0, 10);
  });

  it("sitter and fixture agree — the rig's forward matches the seat's front", () => {
    for (const facing of [0.3, Math.PI / 2, -1.1, Math.PI]) {
      const seatFront = gameAngleOfLocalDir(fixtureYaw(facing), LOCAL_FORWARD);
      const rigFront = gameAngleOfLocalDir(sitterYaw(facing), new THREE.Vector3(0, 0, 1));
      expect(wrap(rigFront - seatFront)).toBeCloseTo(0, 10);
    }
  });
});

describe("SEAT_TOP_FRAC — seats sit at plausible human heights", () => {
  // Guards the recipe-derived fractions against silent drift in the recipes.
  it("a chair seat lands near 0.48 m at its standard radius", () => {
    expect(SEAT_TOP_FRAC.chair! * 0.22).toBeCloseTo(0.484, 3);
  });
  it("a privy seat lands near 0.5 m at its standard radius", () => {
    expect(SEAT_TOP_FRAC.privy! * 0.5).toBeCloseTo(0.505, 3);
  });
  it("only the kinds with a real seat surface resolve", () => {
    // A tub/workbench must stay ABSENT — resolveActivityAnchor returns null for
    // them, preserving the crouch-in-place behavior.
    expect(Object.keys(SEAT_TOP_FRAC).sort()).toEqual(["chair", "privy"]);
    expect(SEAT_TOP_FRAC.bath).toBeUndefined();
  });
});

describe("bedSleeperYaw — the head lands on the pillow", () => {
  // Paired with fixtureYaw BY CONSTRUCTION: the bed is yawed by fixtureYaw and
  // the sleeper by bedSleeperYaw, and the pillow direction must agree. Flip
  // either alone and this fails.
  for (const facing of [0, Math.PI / 2, -Math.PI / 2, Math.PI, 1.9]) {
    it(`bed facing ${facing.toFixed(3)}: sleeper head aligns with the pillow end`, () => {
      const pillowDir = gameAngleOfLocalDir(fixtureYaw(facing), LOCAL_BACK);
      const headDir = gameAngleOfLocalDir(bedSleeperYaw(facing), LOCAL_HEAD);
      expect(wrap(headDir - pillowDir)).toBeCloseTo(0, 10);
    });
  }
});
