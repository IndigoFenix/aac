// The STATION / CLUSTER / OCCUPANT registries (§9 slices 1-2,
// shared/world-engine/kernel/town/stations.ts): generation reads DATA —
// furniture.ts drives the station registry, rooms.ts reads the cluster
// geometry floors and derives its program from the occupants' need-set.
// These tests pin the registry's integrity, the program arithmetic, and
// the consistency between the kernel's station kinds and the behavior
// layer's need templates (the two name the same stations or walkers
// starve in generated houses). Pure — no DB / LLM / GL.

import { describe, it, expect } from "@jest/globals";
import {
  CLUSTERS,
  HOUSEHOLD,
  HOUSE_STATIONS,
  houseProgram,
} from "@shared/world-engine/kernel/town/stations.js";
import { HOUSE_METRICS, houseRoomPlan } from "@shared/world-engine/kernel/town/rooms.js";
import { houseFurniture } from "@shared/world-engine/kernel/town/furniture.js";
import {
  energyTemplate,
  cookTemplate,
  funTemplate,
  hungerTemplate,
  hygieneTemplate,
  laundryTemplate,
  thirstTemplate,
  wasteTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";
import type { TownHouse } from "@shared/world-engine/kernel/town/plan.js";

const center = { x: 100, y: 100 };
const mkHouse = (index: number, w: number, h: number, door: TownHouse["door"]): TownHouse =>
  ({ index, dx: -w / 2, dy: -h / 2, w, h, door, color: "#a8875f", floors: 1 }) as TownHouse;

describe("station registry integrity", () => {
  it("every station's cluster exists in the cluster registry", () => {
    for (const def of HOUSE_STATIONS) {
      expect(CLUSTERS[def.cluster]).toBeDefined();
    }
  });

  it("anchored stations name an anchor defined EARLIER (order is semantics)", () => {
    const seen = new Set<string>();
    for (const def of HOUSE_STATIONS) {
      if (def.place.mode === "besideAnchor") {
        expect(seen.has(def.place.anchor)).toBe(true);
      }
      seen.add(def.key);
    }
  });

  it("footprints and keys are sane", () => {
    const keys = new Set<string>();
    for (const def of HOUSE_STATIONS) {
      expect(def.radius).toBeGreaterThan(0);
      expect(def.radius).toBeLessThan(1.5); // house-scale furniture
      expect(keys.has(def.key)).toBe(false); // ids must stay unique
      keys.add(def.key);
    }
  });

  it("clusters that can own a dedicated cell carry their geometry floors", () => {
    expect(CLUSTERS.wet!.minW).toBeGreaterThan(0);
    expect(CLUSTERS.sleep!.minW).toBeGreaterThan(0);
    expect(CLUSTERS.sleep!.minD).toBeGreaterThan(0);
    expect(CLUSTERS.sleep!.cellArea).toBeGreaterThan(0);
  });

  it("rooms.ts reads its cell floors FROM the cluster registry", () => {
    expect(HOUSE_METRICS.bathW).toBe(CLUSTERS.wet!.minW);
    expect(HOUSE_METRICS.bedMinW).toBe(CLUSTERS.sleep!.minW);
    expect(HOUSE_METRICS.bedMinD).toBe(CLUSTERS.sleep!.minD);
    expect(HOUSE_METRICS.bedArea).toBe(CLUSTERS.sleep!.cellArea);
  });
});

describe("the occupant program (need-derived demand, §9 slice 2)", () => {
  it("a household's sleepers pair up per sleep cell", () => {
    expect(houseProgram({ residents: HOUSEHOLD }).sleepCells).toBe(
      Math.ceil(HOUSEHOLD / (CLUSTERS.sleep!.perCell ?? 2)),
    );
  });

  it("the program SCALES with occupancy — an inn is the sleep cluster multiplied", () => {
    expect(houseProgram({ residents: 12 }).sleepCells).toBe(6);
    expect(houseProgram({ residents: 1 }).sleepCells).toBe(1);
    expect(houseProgram({ residents: 0 }).sleepCells).toBe(1); // never a bedroom-less dwelling
  });

  it("no generated plan realizes MORE sleep cells than the occupants demand", () => {
    const demand = houseProgram({ residents: HOUSEHOLD }).sleepCells;
    for (const door of ["north", "south", "east", "west"] as const) {
      for (let w = 7; w <= 13; w++) {
        for (let d = 7; d <= 10; d++) {
          const plan = houseRoomPlan(center, mkHouse(w * 31 + d, w, d, door));
          expect(plan.bedrooms.length).toBeLessThanOrEqual(demand);
        }
      }
    }
  });
});

describe("kernel stations ↔ behavior-layer need templates stay consistent", () => {
  it("every station kind a resident's needs name is one the registry can place", () => {
    const provided = new Set(HOUSE_STATIONS.map((d) => d.kind as string));
    provided.add("well"); // the town well is staged, not house furniture
    const templates = [
      hungerTemplate("food", 1),
      thirstTemplate(1),
      energyTemplate(1),
      funTemplate(1),
      wasteTemplate(1),
      hygieneTemplate(1),
      laundryTemplate(),
      cookTemplate("food", "meal", 2), // round 7: the stove is placeable
    ];
    for (const tpl of templates) {
      const at =
        tpl.satisfy.kind === "consume" || tpl.satisfy.kind === "rest" || tpl.satisfy.kind === "transform"
          ? (tpl.satisfy.at ?? [])
          : [];
      for (const kind of at) {
        expect(provided.has(kind)).toBe(true);
      }
    }
  });
});

describe("the driver realizes the registry", () => {
  const goods = [{ key: "food", slot: 0 }, { key: "tools", slot: 1 }];

  it("a roomy house places every singleton station the registry declares", () => {
    // 12×10 south door — the reference partitioned layout the furniture
    // suite leans on; roomy enough that nothing legitimately goes without.
    const pieces = houseFurniture(center, mkHouse(0, 12, 10, "south"), goods);
    const ids = new Set(pieces.map((p) => p.id));
    for (const def of HOUSE_STATIONS) {
      if (def.per === "good") {
        for (const g of goods) expect(ids.has(`furn_0_${def.key}_${g.key}`)).toBe(true);
      } else if (def.per !== "member" && def.key !== "bed_2" && def.key !== "chair" && !def.cellOnly) {
        // cellOnly stations (the optional rooms' bench/wood/stow chests,
        // construction v1) legitimately go without — their dedicated cell
        // exists only where an annex raised one.
        expect(ids.has(`furn_0_${def.key}`)).toBe(true);
      }
    }
    // At least one chair seats the table; members got private boxes.
    expect(pieces.some((p) => p.kind === "chair")).toBe(true);
    expect(pieces.some((p) => p.id.startsWith("furn_0_box_"))).toBe(true);
  });

  it("pieces carry the registry's footprints and affordances", () => {
    const byKey = new Map(HOUSE_STATIONS.map((d) => [d.key, d]));
    const pieces = houseFurniture(center, mkHouse(0, 12, 10, "south"), goods);
    for (const p of pieces) {
      // furn_0_<suffix>; suffix may carry a per-instance tail (_0, _food).
      const suffix = p.id.replace(/^furn_0_/, "");
      const def =
        byKey.get(suffix) ??
        byKey.get(suffix.replace(/_[^_]+$/, "")) ??
        byKey.get(suffix.split("_")[0]!);
      expect(def).toBeDefined();
      expect(p.radius).toBe(def!.radius);
      expect(p.openable).toBe(def!.openable);
      // A `per: "good"` station may override its MODEL per good (food stands
      // in a refrigerator) — still registry-declared, so the invariant holds.
      expect(p.kind).toBe((p.good && def!.kindByGood?.[p.good]) || def!.kind);
    }
  });
});
