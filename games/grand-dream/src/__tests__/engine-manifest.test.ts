/**
 * The ENGINE KERNEL's document gate (shared/engine/manifest.ts): a world
 * manifest declares its capability modules and carries ordered content
 * packs. The kernel refuses what this build can't run and routes what it
 * can — and the manifest path must compile to EXACTLY what the
 * hand-composed doc list does (the seam adds routing, never semantics).
 */

import { describe, expect, it } from "vitest";
import {
  docsFor, isWorldManifest, loadWorldManifest, type EngineModule,
} from "@shared/world-engine/kernel/manifest";
import { ECONOMY_MODULE } from "@shared/world-engine/kernel/modules/economy";
import { compileEconomy } from "../economy";
import { CORE_BASE, CORE_GOODS2 } from "../economy-core";

const WORLD = {
  engine: "aivota-world",
  engineVersion: 1,
  uses: ["economy"],
  packs: [
    { name: "core", economy: CORE_BASE },
    { name: "goods2", economy: CORE_GOODS2 },
  ],
};

/** A second module so multi-module routing and uses-scoping are real. */
const WEATHER_STUB: EngineModule<unknown> = { key: "weather", parse: s => s };

describe("loadWorldManifest: routing", () => {
  it("routes each pack's sections to its module, in pack order", () => {
    const loaded = loadWorldManifest(WORLD, [ECONOMY_MODULE]);
    expect(loaded.info.uses).toEqual(["economy"]);
    expect(loaded.info.packs).toEqual(["core", "goods2"]);
    // parse round-trips the shipped docs (the CLOTHING law, again).
    expect(docsFor(loaded, ECONOMY_MODULE)).toEqual([CORE_BASE, CORE_GOODS2]);
  });

  it("the manifest path compiles to EXACTLY the hand-composed economy", () => {
    const loaded = loadWorldManifest(WORLD, [ECONOMY_MODULE]);
    const viaManifest = compileEconomy(docsFor(loaded, ECONOMY_MODULE), { construction: true });
    const byHand = compileEconomy([CORE_BASE, CORE_GOODS2], { construction: true });
    expect(viaManifest).toEqual(byHand);
  });

  it("a pack may skip sections; docs still arrive in pack order", () => {
    const loaded = loadWorldManifest({
      ...WORLD,
      uses: ["economy", "weather"],
      packs: [
        { name: "core", economy: CORE_BASE, weather: { rain: 1 } },
        { name: "dry" }, // a pack of nothing is legal (a named placeholder)
        { name: "goods2", economy: CORE_GOODS2 },
      ],
    }, [ECONOMY_MODULE, WEATHER_STUB]);
    expect(docsFor(loaded, ECONOMY_MODULE)).toEqual([CORE_BASE, CORE_GOODS2]);
    expect(docsFor(loaded, WEATHER_STUB)).toEqual([{ rain: 1 }]);
  });
});

describe("loadWorldManifest: refusal (path-exact, never a silent skip)", () => {
  it("a world that uses a module this build lacks names what IS here", () => {
    expect(() => loadWorldManifest({ ...WORLD, uses: ["economy", "demography"] }, [ECONOMY_MODULE]))
      .toThrow(/world\.uses\[1\].*does not include "demography".*registered modules: economy/);
  });

  it("a section no module owns fails at its exact path", () => {
    expect(() => loadWorldManifest({
      ...WORLD, packs: [{ name: "core", economyy: {} }],
    }, [ECONOMY_MODULE])).toThrow(/world\.packs\[0\]\.economyy: no registered module/);
  });

  it("a section whose module is registered but undeclared in uses fails", () => {
    expect(() => loadWorldManifest({
      ...WORLD, packs: [{ name: "core", weather: {} }],
    }, [ECONOMY_MODULE, WEATHER_STUB])).toThrow(/world\.packs\[0\]\.weather.*not declared in world\.uses/);
  });

  it("module parse errors carry the pack path into the section", () => {
    expect(() => loadWorldManifest({
      ...WORLD,
      packs: [{ name: "bad", economy: { commodities: [{ key: "x", scalarMax: "big" }] } }],
    }, [ECONOMY_MODULE])).toThrow(/world\.packs\[0\]\.economy\.commodities\[0\].*"scalarMax" must be a finite number/);
  });

  it("the envelope is gated: engine id, version, unknown fields, packs shape", () => {
    expect(() => loadWorldManifest({ ...WORLD, engine: "other" }, [ECONOMY_MODULE]))
      .toThrow(/world\.engine: expected "aivota-world"/);
    expect(() => loadWorldManifest({ ...WORLD, engineVersion: 2 }, [ECONOMY_MODULE]))
      .toThrow(/world\.engineVersion: expected 1/);
    expect(() => loadWorldManifest({ ...WORLD, extra: true }, [ECONOMY_MODULE]))
      .toThrow(/world: unknown field "extra"/);
    expect(() => loadWorldManifest({ ...WORLD, packs: {} }, [ECONOMY_MODULE]))
      .toThrow(/world\.packs: must be an array/);
    expect(() => loadWorldManifest({ ...WORLD, packs: [{ economy: {} }] }, [ECONOMY_MODULE]))
      .toThrow(/world\.packs\[0\]\.name/);
    expect(() => loadWorldManifest({
      ...WORLD, packs: [{ name: "core" }, { name: "core" }],
    }, [ECONOMY_MODULE])).toThrow(/duplicate pack name "core"/);
    expect(() => loadWorldManifest({ ...WORLD, uses: ["economy", "economy"] }, [ECONOMY_MODULE]))
      .toThrow(/world\.uses\[1\]: duplicate "economy"/);
  });

  it("registering two modules on one key is the composition root's bug", () => {
    expect(() => loadWorldManifest(WORLD, [ECONOMY_MODULE, { key: "economy", parse: s => s }]))
      .toThrow(/engine: module key "economy" registered twice/);
  });
});

describe("isWorldManifest", () => {
  it("tells a manifest from a bare module section (the migration shim)", () => {
    expect(isWorldManifest(WORLD)).toBe(true);
    expect(isWorldManifest(CORE_BASE)).toBe(false);
    expect(isWorldManifest([])).toBe(false);
  });
});
