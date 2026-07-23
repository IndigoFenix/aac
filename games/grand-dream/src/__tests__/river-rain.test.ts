// RAIN-FED RIVERS — the climate rain field feeding the flow sources, so
// accumulation measures upstream RAINFALL rather than bare catchment area.
//
// Before this seam existed, `rain` was one global scalar: a rainforest coast
// and a desert interior of the same shape grew IDENTICAL river networks. The
// wiring under test: climateFields (pre-settle) → normalized `runoff` field →
// the river var's flow `sourceField` (spec/examples) → computeFlow's per-cell
// sources → the settled network that carves, greens, and founds.

import { describe, it, expect } from "vitest";
import { prepareSubstrateOn } from "../tri";
import { buildPlanetWorld } from "@shared/world-engine/planet/planet-game";
import { SEA_HEIGHT } from "@shared/world-engine/kernel/geology/tectonics";
import { makeCubeSphereTopology } from "@shared/world-engine/kernel/cells/topology";
import { serializeGrid, deserializeGrid, worldStep } from "@shared/world-engine/kernel/cells/index";
import type { GameSettings } from "@shared/world-engine/kernel/manifest";

describe("runoff field → flow sources (the kernel seam)", () => {
  // A toy planet with a clean experiment shape: a northern cone continent
  // (drains radially to a southern sea) that is symmetric east-west, and a
  // runoff field that is NOT — a wet east, a desert west. Any east-west
  // difference in the settled rivers is therefore the runoff's doing.
  const topo = makeCubeSphereTopology(12);
  const heightOf = (c: number): number => {
    const d = topo.pos3!(c);
    return d[1] > 0 ? 5 + 40 * d[1] : 0; // north = continent, south = sea
  };
  const WET = 1.8;
  const DRY = 0.2;
  const runoffOf = (c: number): number => (topo.pos3!(c)[0] > 0 ? WET : DRY);

  const build = (withRunoff: boolean) =>
    prepareSubstrateOn({
      topology: { kind: "cube-sphere", faceN: 12 },
      height: heightOf,
      founding: { threshold: 40, radius: 2, minSpacing: 5 },
      oreSeed: 7,
      ...(withRunoff ? { runoff: runoffOf } : {}),
    });

  const census = (grid: ReturnType<typeof build>["grid"]): { wet: number; dry: number } => {
    const { river, height } = grid.fields;
    let wet = 0, dry = 0;
    for (let c = 0; c < grid.topo.n; c++) {
      if (height[c] < SEA_HEIGHT || river[c] <= 16) continue;
      if (topo.pos3!(c)[0] > 0) wet++; else dry++;
    }
    return { wet, dry };
  };

  it("wet country grows more watercourse than desert on identical terrain", () => {
    // The control is essential, not decoration: the cone is analytically
    // east-west symmetric, but the flat-resolution BFS breaks its integer-ring
    // plateaus by deterministic cell order, which skews the CONTROL's trunks
    // too. So the claim is a RATIO OF RATIOS — the runoff build must be more
    // wet-side-heavy than the same build with uniform sources, decisively
    // (cross-multiplied so a riverless desert side can't divide by zero).
    const withRain = census(build(true).grid);
    const control = census(build(false).grid);
    expect(withRain.wet).toBeGreaterThan(0);
    expect(withRain.wet * Math.max(1, control.dry))
      .toBeGreaterThan(2 * withRain.dry * Math.max(1, control.wet));
    // And in absolute terms the wet side dominates its own desert side.
    expect(withRain.wet).toBeGreaterThan(withRain.dry * 2);
  });
});

describe("planet build wires climate rain into the rivers", () => {
  const game: GameSettings = {
    scope: "planet",
    world: {
      topology: { kind: "cube-sphere", faceN: 24 },
      geology: { seed: 7, epochs: 350 },
      settle: true, radius: 6_371_000,
      founding: { threshold: 100, radius: 2, minSpacing: 6, maxHarvest: 600 },
    },
    initialFocus: null, avatar: false, avatarSpecies: "human",
    canFly: false, creativeMode: false, entities: null,
  };
  const built = buildPlanetWorld(game);
  const { topo } = built;
  const runoff = built.grid.fields.runoff;
  const river = built.grid.fields.river;
  const height = built.grid.fields.height;

  it("seeds a normalized runoff field (land-mean 1) that survives in the grid", () => {
    expect(runoff).toBeDefined();
    let sum = 0, land = 0;
    for (let c = 0; c < topo.n; c++) {
      if (height[c] >= SEA_HEIGHT) { sum += runoff[c]; land++; }
    }
    expect(land).toBeGreaterThan(0);
    expect(sum / land).toBeCloseTo(1, 6);
    // Spatially varied, not a disguised scalar: deserts and rainforests exist.
    let lo = Infinity, hi = 0;
    for (let c = 0; c < topo.n; c++) {
      if (height[c] < SEA_HEIGHT) continue;
      lo = Math.min(lo, runoff[c]); hi = Math.max(hi, runoff[c]);
    }
    expect(hi).toBeGreaterThan(lo * 3);
  });

  it("the runoff field CAUSES the network: strip it and the rivers move", () => {
    // The causal check, not a statistical proxy. (A distributional assertion
    // like "channel cells are rainier than average land" is actually FALSE
    // here, for a real reason: coastal wet strips drain to sea at small
    // catchments, while the big trunks cross dry continental interiors — the
    // Volga/Niger shape. So test the mechanism directly: a deserialized twin
    // with the runoff field deleted must recompute a DIFFERENT network.)
    const twin = deserializeGrid(serializeGrid(built.grid))!;
    expect(twin).not.toBeNull();
    delete twin.fields.runoff;
    twin.flowDirty = true;
    worldStep(twin); // recomputeFlows runs first, with uniform sources
    const a = built.grid.fields.river;
    const b = twin.fields.river;
    let moved = 0;
    for (let c = 0; c < topo.n; c++) if (a[c] !== b[c]) moved++;
    expect(moved).toBeGreaterThan(topo.n * 0.05);
    // And the direction is right: with rain-scaled sources, rainy land feeds
    // MORE accumulation per cell than the uniform twin says it should.
    let rainyGain = 0, rainyN = 0;
    for (let c = 0; c < topo.n; c++) {
      if (height[c] < SEA_HEIGHT || runoff[c] < 1.5) continue;
      rainyGain += a[c] - b[c]; rainyN++;
    }
    expect(rainyN).toBeGreaterThan(10);
    expect(rainyGain / rainyN).toBeGreaterThan(0);
  });
});
