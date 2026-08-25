// TAMING → HERD (band-settlement-round.md B-⑥ — city-founding ④'s open
// tail, retired). The decided handoff law as tests: individual owned-animal
// containers are physics ONLY at homestead scale; at the promotion seam
// they CONVERT to the site's domestic-herd rows and the containers retire —
// never both accounts as physics at once. The herd row carries the pooled
// LIVE stock beside the count ("conserves the live stack, not the initial
// roll" — the wild codec's own law), so the conversion conserves goods
// exactly, not just heads.
//
// 🚨 The defect this ends (the "unwritten" F-① violation): a tamed animal
// survived every LOD fold and evaporated at the session boundary — no
// serialized field existed for it, and it came back WILD next mount.
//
// Deliberately quest-host-free: herd.ts reads a structural session slice,
// so these pins pay no per-worker transform tax.

import { describe, it, expect } from "@jest/globals";
import {
  ownedAnimalsOf, bankOwnedHerd, type HerdSession,
} from "@shared/world-engine/interaction/quest/herd.js";
import {
  registerContainer, setContainerOwner,
} from "@shared/world-engine/kernel/town/containers.js";
import {
  createTownDeltas, mergeHerd,
} from "@shared/world-engine/kernel/town/construction.js";
import {
  foundSite, mergeSites, siteTownConfig, type FoundedSite,
} from "@shared/world-engine/interaction/town/founding.js";
import type { WildernessContent } from "@shared/world-engine/interaction/quest/wilderness.js";

const OWNER = "creature:player";

/** A minimal HerdSession: the container registry slice + a scatter with
 *  the named product animals standing in it. */
function makeSession(animals: Array<{ id: string; species: string; stock: Record<string, number> }>): HerdSession {
  const wilderness: WildernessContent = {
    side: 240, seed: 7, spawn: { x: 120, y: 120 },
    features: [],
    creatures: animals.map((a, i) => ({
      id: a.id, icon: "", x: 20 + i * 4, y: 20, species: a.species, stock: { ...a.stock },
    })),
  };
  const session: HerdSession = {
    containerRecords: new Map(),
    wornBagIndex: new Map(),
    wilderness,
  } as unknown as HerdSession;
  for (const a of animals) {
    registerContainer(session, `fauna:${a.species}:${a.id}`, "in", null, { ...a.stock });
  }
  return session;
}

const tame = (session: HerdSession, species: string, id: string): void => {
  setContainerOwner(session, `fauna:${species}:${id}`, OWNER);
};

const site = (seed: number, at: { x: number; y: number }, day = 0): FoundedSite =>
  foundSite({ seed, at, day });

describe("the census — owned product animals, and nothing else (B-⑥)", () => {
  it("a WILD animal is nobody's and is not counted; a tamed one is", () => {
    const s = makeSession([
      { id: "wild_sheep_0", species: "sheep", stock: { wool: 2, meat: 1 } },
      { id: "wild_sheep_1", species: "sheep", stock: { wool: 1, meat: 1 } },
    ]);
    expect(ownedAnimalsOf(s)).toEqual([]);
    tame(s, "sheep", "wild_sheep_0");
    const owned = ownedAnimalsOf(s);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.species).toBe("sheep");
    expect(owned[0]!.stock).toEqual({ wool: 2, meat: 1 });
  });

  it("an owned CHEST never counts — only fauna bodies are animals", () => {
    const s = makeSession([]);
    registerContainer(s, "furn_3_chest_0", "in", OWNER, { wool: 5 });
    expect(ownedAnimalsOf(s)).toEqual([]);
  });
});

describe("⚖️ the conversion — never both accounts as physics at once", () => {
  it("bank moves count + LIVE stock onto the site and RETIRES the container", () => {
    const s = makeSession([
      { id: "wild_sheep_0", species: "sheep", stock: { wool: 2, meat: 1 } },
      { id: "wild_sheep_1", species: "sheep", stock: { wool: 3, meat: 1 } },
      { id: "wild_cow_0", species: "cow", stock: { milk: 1, meat: 2 } },
    ]);
    tame(s, "sheep", "wild_sheep_0");
    tame(s, "sheep", "wild_sheep_1");
    tame(s, "cow", "wild_cow_0");
    const removed: string[] = [];
    const target = site(11, { x: 30, y: 30 });

    const banked = bankOwnedHerd(s, target, { removeBody: (id) => removed.push(id) });

    // The counts half + the goods half, pooled per species, exactly.
    expect(target.herd).toEqual({
      sheep: { n: 2, stock: { wool: 5, meat: 2 } },
      cow: { n: 1, stock: { milk: 1, meat: 2 } },
    });
    expect(banked).toEqual(target.herd);
    // 🚨 NEVER BOTH: no owned fauna container remains, the scatter entries
    // left, and the world was asked to drop each body.
    expect(ownedAnimalsOf(s)).toEqual([]);
    expect(s.containerRecords.has("fauna:sheep:wild_sheep_0")).toBe(false);
    expect(s.wilderness!.creatures).toHaveLength(0);
    expect(removed.sort()).toEqual([
      "fauna:cow:wild_cow_0", "fauna:sheep:wild_sheep_0", "fauna:sheep:wild_sheep_1",
    ]);
  });

  it("wild neighbours stay standing — the bank takes only what is OWNED", () => {
    const s = makeSession([
      { id: "wild_sheep_0", species: "sheep", stock: { wool: 2 } },
      { id: "wild_sheep_1", species: "sheep", stock: { wool: 1 } },
    ]);
    tame(s, "sheep", "wild_sheep_0");
    const target = site(12, { x: 30, y: 30 });
    bankOwnedHerd(s, target);
    expect(target.herd).toEqual({ sheep: { n: 1, stock: { wool: 2 } } });
    expect(s.containerRecords.has("fauna:sheep:wild_sheep_1")).toBe(true);
    expect(s.wilderness!.creatures.map(c => c.id)).toEqual(["wild_sheep_1"]);
  });

  it("idempotent: a second bank finds nobody and changes nothing", () => {
    const s = makeSession([{ id: "wild_sheep_0", species: "sheep", stock: { wool: 2 } }]);
    tame(s, "sheep", "wild_sheep_0");
    const target = site(13, { x: 30, y: 30 });
    bankOwnedHerd(s, target);
    const after = JSON.stringify(target.herd);
    expect(bankOwnedHerd(s, target)).toEqual({});
    expect(JSON.stringify(target.herd)).toBe(after);
  });
});

describe("🚨 the merge — the whitelist asymmetry, pinned both ways (H2)", () => {
  it("a single-site 'cluster' keeps its herd (the early return)", () => {
    const a = site(21, { x: 0, y: 0 });
    a.herd = { sheep: { n: 2, stock: { wool: 4 } } };
    expect(mergeSites([a]).herd).toEqual({ sheep: { n: 2, stock: { wool: 4 } } });
  });

  it("a multi-site merge SUMS the herds — site rows and overlay rows both", () => {
    const a = site(22, { x: 0, y: 0 }, 0);
    const b = site(23, { x: 40, y: 0 }, 1);
    const c = site(24, { x: 0, y: 40 }, 2);
    a.herd = { sheep: { n: 2, stock: { wool: 4 } } };
    b.herd = { sheep: { n: 1, stock: { wool: 1 } }, cow: { n: 1, stock: { milk: 2 } } };
    // A herd already folded into an overlay (a previously-merged member).
    mergeHerd(c.deltas.herd, { goat: { n: 3, stock: {} } });

    const merged = mergeSites([a, b, c]);
    expect(merged.deltas.herd).toEqual({
      sheep: { n: 3, stock: { wool: 5 } },
      cow: { n: 1, stock: { milk: 2 } },
      goat: { n: 3, stock: {} },
    });
    // The merged SITE carries no site-level rows — folded into the overlay,
    // exactly as stock is.
    expect(merged.herd).toBeUndefined();
  });
});

describe("the town seam — the herd rides the config as stock does", () => {
  it("siteTownConfig folds site.herd into deltas.herd", () => {
    const a = site(31, { x: 0, y: 0 });
    a.herd = { sheep: { n: 2, stock: { wool: 4 } } };
    mergeHerd(a.deltas.herd, { sheep: { n: 1, stock: { wool: 1 } } });
    const config = siteTownConfig(a);
    expect(config.deltas?.herd).toEqual({ sheep: { n: 3, stock: { wool: 5 } } });
  });

  it("a herdless site emits NO herd key — pre-B-⑥ serialized forms stay byte-identical", () => {
    const a = site(32, { x: 0, y: 0 });
    const config = siteTownConfig(a);
    expect("herd" in (config.deltas ?? {})).toBe(false);
    expect("herd" in createTownDeltas().toJSON()).toBe(false);
  });

  it("the overlay round-trips the herd (serialize → restore → serialize)", () => {
    const deltas = createTownDeltas({
      version: 0, buildings: {},
      herd: { sheep: { n: 2, stock: { wool: 4 } } },
    });
    expect(deltas.herd).toEqual({ sheep: { n: 2, stock: { wool: 4 } } });
    const json = deltas.toJSON();
    expect(json.herd).toEqual({ sheep: { n: 2, stock: { wool: 4 } } });
    expect(createTownDeltas(json).toJSON().herd).toEqual(json.herd);
  });
});
