/**
 * THE STATIC↔LIVE HANDOFF, end to end on a REAL generated town: the
 * town-stage streamer's `loadedLots()` (the single source of truth) must
 * hide exactly the static plan instances whose live twins are materialized
 * (city-visuals setLiveLots) — never both rendered (z-fighting walls/doors),
 * never neither (holes). Pins the data path headlessly; only the draw is
 * browser-side.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildTownPlay } from "@shared/world-engine/interaction/town/town-play";
import { buildTownMesh } from "../../../world-lab/src/city-visuals";

const play = buildTownPlay({ seed: 21, days: 120, questCount: 0, key: "handoff", startPop: 90 });
const center = play.stage.center;

/** The two same-count InstancedMeshes are buildings then doors (build order). */
function lotMeshes(group: THREE.Group): { buildings: THREE.InstancedMesh; doors: THREE.InstancedMesh } {
  const lotCount = play.plan.houses.length + play.plan.works.length;
  const inst = group.children.filter(
    (c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh && (c as THREE.InstancedMesh).count === lotCount,
  );
  expect(inst.length).toBe(2);
  return { buildings: inst[0]!, doors: inst[1]! };
}

/** Instance scale straight off the matrix columns. NOT `decompose`: three
 *  guards degenerate matrices and reports scale (1,1,1) for the zero-scale
 *  HIDE matrix, so decompose cannot tell "hidden" from "identity". */
const scaleOf = (mesh: THREE.InstancedMesh, i: number): number => {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  const e = m.elements;
  const col = (c: number): number => Math.hypot(e[c * 4]!, e[c * 4 + 1]!, e[c * 4 + 2]!);
  return Math.hypot(col(0), col(1), col(2));
};

describe("static↔live handoff — loadedLots drives setLiveLots", () => {
  it("streaming near a house loads its lot, and the static instance (box + door) hides", () => {
    const view = buildTownMesh(play.plan, play.stage.roads, center, () => 0);
    const { buildings, doors } = lotMeshes(view.group);

    // Park the player at house 0's centre — the streamer stages it.
    const h = play.plan.houses[0]!;
    const p = { x: center.x + h.dx + h.w / 2, y: center.y + h.dy + h.h / 2 };
    play.stage.frame(p, 1);

    expect(play.stage.loadedLots).toBeTypeOf("function");
    const lots = play.stage.loadedLots!();
    expect(lots.houses.has(h.index)).toBe(true);

    view.setLiveLots(lots);
    // Instance 0 = plan.houses[0] (build order): hidden = zero-scale matrix.
    expect(scaleOf(buildings, 0)).toBeLessThan(1e-6);
    expect(scaleOf(doors, 0)).toBeLessThan(1e-6);

    // A far-away house's lot must NOT be loaded — its static instance stands.
    let farI = -1;
    let farD = 0;
    play.plan.houses.forEach((o, i) => {
      const d = Math.hypot(o.dx - h.dx, o.dy - h.dy);
      if (d > farD) { farD = d; farI = i; }
    });
    expect(farD).toBeGreaterThan(200); // the town is big enough to have a far lot
    expect(lots.houses.has(play.plan.houses[farI]!.index)).toBe(false);
    expect(scaleOf(buildings, farI)).toBeGreaterThan(0.5);

    // The mount-less state restores everything.
    view.setLiveLots(null);
    expect(scaleOf(buildings, 0)).toBeGreaterThan(0.5);
    expect(scaleOf(doors, 0)).toBeGreaterThan(0.5);
  });

  it("works lots map by array position (w_<i> ids)", () => {
    if (!play.plan.works.length) return;
    const view = buildTownMesh(play.plan, play.stage.roads, center, () => 0);
    const { buildings } = lotMeshes(view.group);
    const wk = play.plan.works[0]!;
    const p = { x: center.x + wk.dx + wk.w / 2, y: center.y + wk.dy + wk.h / 2 };
    play.stage.frame(p, 1);
    const lots = play.stage.loadedLots!();
    expect(lots.works.has(0)).toBe(true);
    view.setLiveLots(lots);
    expect(scaleOf(buildings, play.plan.houses.length)).toBeLessThan(1e-6);
  });
});
