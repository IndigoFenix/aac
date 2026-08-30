/**
 * The tangent walk-chart (planet/walk-chart.ts): sim coordinates as a local
 * chart on the sphere — metric-honest over walking distances, anchored to
 * real terrain, re-anchorable without a seam.
 */
import { describe, it, expect } from "vitest";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import { createWalkChart } from "@shared/world-engine/planet/walk-chart";
import type { GameSettings } from "@shared/world-engine/kernel/manifest";

const game: GameSettings = {
  scope: "planet",
  world: {
    topology: { kind: "cube-sphere", faceN: 24 },
    geology: { seed: 7, epochs: 350, continentR: 0.38 },
    settle: true,
    radius: 6_371_000,
  },
  initialFocus: null, avatar: false, avatarSpecies: "human", mods: [], canFly: false, creativeMode: false, entities: null, scale: null,
};

describe("walk-chart — the sphere under a walking session", () => {
  const built = buildPlanetWorld(game);
  const R = built.spec.radius;
  const anchor = built.topo.pos3!(built.sites[0].cell);
  const chart = createWalkChart(built.surface, R, anchor);

  it("anchors to the terrain: ground is 0 at the origin, axes orthonormal", () => {
    expect(Math.abs(chart.groundAt(0, 0))).toBeLessThan(1e-6);
    const d = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(Math.abs(d(chart.east, chart.north))).toBeLessThan(1e-12);
    expect(Math.abs(d(chart.east, chart.dir0))).toBeLessThan(1e-12);
    expect(Math.abs(Math.hypot(...chart.east) - 1)).toBeLessThan(1e-12);
  });

  it("is metric-honest over walking distances (gnomonic error ≪ a stride)", () => {
    for (const km of [1, 5, 20]) {
      const x = km * 1000;
      const a = chart.dirAt(0, 0);
      const b = chart.dirAt(x, 0);
      const angle = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
      const groundDist = angle * R;
      // Chart metres vs great-circle metres: within 0.1% out to 20 km.
      expect(Math.abs(groundDist - x) / x).toBeLessThan(1e-3);
    }
  });

  it("samples the SAME terrain the planet draws", () => {
    const h0 = Math.max(0, built.surface.heightAt(chart.dir0));
    for (const [x, y] of [[300, -700], [5_000, 2_000], [-12_000, 8_000]] as const) {
      const dir = chart.dirAt(x, y);
      const raw = Math.max(0, built.surface.heightAt(dir));
      expect(Math.abs(chart.groundAt(x, y) - (raw - h0))).toBeLessThan(1e-9);
    }
    // The EMBEDDING variant folds the sphere's drop in (aligning with a
    // true planet mesh in the same scene).
    const embedded = createWalkChart(built.surface, R, anchor, { curvature: true });
    const [x, y] = [5_000, 2_000];
    expect(Math.abs(
      embedded.groundAt(x, y) - (chart.groundAt(x, y) - (x * x + y * y) / (2 * R)),
    )).toBeLessThan(1e-9);
  });

  it("chartXY inverts dirAt: the flight→walk landing handoff round-trips", () => {
    // Chart (x, y) → dir → back to (x, y): exact over the walkable patch.
    for (const [x, y] of [[0, 0], [300, -700], [5_000, 2_000], [-12_000, 8_000], [40_000, -25_000]] as const) {
      const back = chart.chartXY(chart.dirAt(x, y));
      expect(back.onFar).toBe(false);
      expect(Math.abs(back.x - x)).toBeLessThan(1e-3);
      expect(Math.abs(back.y - y)).toBeLessThan(1e-3);
    }
    // And dir → (x, y) → dir for an arbitrary near-anchor direction.
    const probe = chart.dirAt(3_140, -1_590);
    const rt = chart.dirAt(chart.chartXY(probe).x, chart.chartXY(probe).y);
    const dp = rt[0] * probe[0] + rt[1] * probe[1] + rt[2] * probe[2];
    expect(dp).toBeGreaterThan(1 - 1e-12);
  });

  it("chartXY flags the far hemisphere (chart doesn't reach — re-anchor first)", () => {
    const far: [number, number, number] = [-chart.dir0[0], -chart.dir0[1], -chart.dir0[2]];
    expect(chart.chartXY(far).onFar).toBe(true);
    // The anchor itself maps to the origin.
    const at0 = chart.chartXY(chart.dir0);
    expect(at0.onFar).toBe(false);
    expect(Math.hypot(at0.x, at0.y)).toBeLessThan(1e-6);
  });

  it("re-anchors without a seam: heights agree, headings parallel-transport", () => {
    const AT = { x: 8_000, y: -3_000 };
    const { chart: next, offset, heightShift } = chart.reanchorAt(AT.x, AT.y);
    expect(offset).toEqual(AT);
    // The new origin is the old point: heights around it agree once the
    // uniform shift is applied.
    for (const [dx, dy] of [[0, 0], [40, 25], [-300, 180], [1500, -900]] as const) {
      const oldH = chart.groundAt(AT.x + dx, AT.y + dy);
      const newH = next.groundAt(dx, dy);
      expect(Math.abs((oldH - heightShift) - newH)).toBeLessThan(0.05); // < 5 cm across a re-anchor
    }
    // Parallel transport: the new east stays aligned with the old (no snap).
    const d = chart.east[0] * next.east[0] + chart.east[1] * next.east[1] + chart.east[2] * next.east[2];
    expect(d).toBeGreaterThan(0.999999);
    // And it is deterministic.
    const again = chart.reanchorAt(AT.x, AT.y);
    expect(JSON.stringify(again.chart.dir0)).toBe(JSON.stringify(next.dir0));
  });
});
