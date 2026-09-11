/**
 * 🌍 TEXT MODE BOOTS A BAKED FLAT REGION — the region arm of `bootTextQuest`,
 * end to end (planning-docs/games/world-engine/planet-boot-round.md, S3b).
 *
 * ⚖️ THE USER'S RULING (2026-09-10, verbatim): *"it's not that important, but
 * it is a feature we'll want in the spec. Could also help with faster
 * testing since we don't have to build the whole planet every time."*
 *
 * WHAT THIS FILE PINS:
 *   ① `frontier-region.spec.json` boots headless — no planet bake, real
 *      cells/sites/cities/routes on a flat substrate.
 *   ② THE SCATTER IS THE CELL's — the session's laid species set equals the
 *      record's `wildMix`.
 *   ③ ONE CLIMATE REACHES BOTH SEATS — `session.climate` equals the record.
 *   ④ ≥ 1 `city:` PARTNER ROW is visible through the session's own trade
 *      read (never instrumented).
 *   ⑤ A FORAGE TAKE HAPPENS within 300 simulated seconds at dt 1/2 — read
 *      off the presenter's own toast/need log, not a counter added for this
 *      test.
 *   ⑥ DETERMINISM — two boots of the document build the identical world.
 *
 * 💰 COST: a region boot has NO planet-sized bake — plate tectonics on a
 * 96×64 grid, a founding scan, a civ layer. Seconds, not the planet arm's
 * 24–29 s (see this stage's landing note for the measured wall-time
 * comparison — "the user's faster-testing claim, measured").
 *
 * DB-free / GL-free — `npm run test:engine:arcs -- region-boot`.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootTextQuest, type TextQuestRun } from "@shared/world-engine/headless/text-quest.js";
import type { RegionScope } from "@shared/world-engine/interaction/town/planet-scope.js";

const WORLDS = join(process.cwd(), "scripts", "worlds");
const readDoc = (name: string): unknown => JSON.parse(readFileSync(join(WORLDS, name), "utf8"));

const SEED = 11;
const DT = 0.5;

/** Species → count over a session's laid countryside (the same shape
 *  `planet-boot.arc.test.ts`'s `scatterOf` reads). */
const scatterOf = (run: TextQuestRun): Array<[string, number]> => {
  const sp = new Map<string, number>();
  for (const f of run.session.wilderness?.features ?? []) sp.set(f.species, (sp.get(f.species) ?? 0) + 1);
  return [...sp].sort();
};

/** THE WORLD AS ONE STRING — the same digest shape `planet-boot.arc.test.ts`
 *  and `headless-determinism.arc.test.ts` compare. */
function digest(run: TextQuestRun): string {
  const ids = Object.keys(run.state.avatars).sort();
  const bodies = ids.map((id) => {
    const a = run.state.avatars[id]!;
    return `  ${id} ${String(a.x)} ${String(a.y)} f${String(a.floor)}`;
  });
  const convos = run.host.conversationAudit().map((c) => `  ${JSON.stringify(c)}`).sort();
  return [`clock=${String(run.session.townClock)}`, `n=${ids.length}`, ...bodies, `convos=${convos.length}`, ...convos].join("\n");
}

/** `[needs] <cid> took <qty>×<good> from <source>` — the engine's own
 *  narration, the same line `scripts/dev/arc-run.ts`'s `TAKE_RE` reads off
 *  the console to build `rationsPerDay`. Never instrument the engine for a
 *  metric: this test reads the identical line by intercepting `console.log`
 *  for the span of the advance, exactly as the arc-run harness does. */
const TAKE_RE = /\[needs\] (\S+) took ([\d.]+)×(\S+) from (\S+)/;

describe("🌍 the region arm — a baked flat map, booted headless", () => {
  let run: TextQuestRun;
  let foodTakeUnits: number;

  beforeAll(() => {
    run = bootTextQuest({ world: readDoc("frontier-region.spec.json"), seed: SEED, dt: DT });
    foodTakeUnits = 0;
    const origLog = console.log;
    console.log = ((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      const m = TAKE_RE.exec(line);
      if (m && m[3] === "food") foodTakeUnits += Number(m[2]);
      origLog(...args);
    }) as typeof console.log;
    try {
      run.advanceS(300);
    } finally {
      console.log = origLog;
    }
  }, 120_000);

  afterAll(() => {
    run?.dispose();
  });

  it("① boots headless — real cells, sites, cities, routes, no planet", () => {
    expect(run.region).not.toBeNull();
    const p = run.region as RegionScope;
    expect(p.region).toBeDefined();
    expect(p.region.grid.topo.n).toBe(96 * 64);
    expect(p.cities.length).toBeGreaterThanOrEqual(2);
    expect(p.routes.length).toBeGreaterThanOrEqual(1);
    expect(p.routes[0]!.frame).toBe("plane");
    expect(p.site.key).toBe("frontier");
    expect(p.site.stock).toEqual({ wood: 14, stone: 6, basket: 2 });
  });

  it("② the scatter species set equals the record's mix", () => {
    const p = run.region as RegionScope;
    const recorded = new Set(p.wildMix.map((m) => m.species));
    const laid = new Set(scatterOf(run).map(([sp]) => sp));
    // Every laid species names a mix entry — the countryside is the cell's,
    // not an invented default (`homesteadWildMix`'s charter-count fallback).
    for (const sp of laid) expect(recorded.has(sp)).toBe(true);
    expect(laid.size).toBeGreaterThan(0);
  });

  it("③ session.climate equals the record — one sample, both seats", () => {
    const p = run.region as RegionScope;
    expect(run.session.climate).toEqual(p.env.climate);
    expect(p.townConfig.climate).toEqual(p.env.climate);
  });

  it("④ ≥ 1 city: partner row is visible through the session's own trade read", () => {
    const p = run.region as RegionScope;
    expect(p.env.partners.length).toBeGreaterThanOrEqual(1);
    for (const r of p.env.partners) expect(r.key.startsWith("city:")).toBe(true);
    const tr = run.session.town!.stage.trade;
    expect(tr).not.toBeNull();
    expect(tr!.route.partnerKey.startsWith("city:")).toBe(true);
    expect(tr!.route.distanceM).toBeGreaterThan(0);
  });

  it("⑤ a forage take happens within 300 s at dt 1/2 (rations > 0, off the engine's own narration)", () => {
    expect(foodTakeUnits).toBeGreaterThan(0);
  });

  it("⑥ two boots of the document build the IDENTICAL world", () => {
    const second = bootTextQuest({ world: readDoc("frontier-region.spec.json"), seed: SEED, dt: DT });
    try {
      second.advanceS(300);
      expect(Object.keys(second.state.avatars).length).toBeGreaterThan(1);
      expect(digest(second)).toBe(digest(run));
      const p1 = run.region as RegionScope;
      const p2 = second.region as RegionScope;
      expect(p2.cell).toBe(p1.cell);
      expect(p2.env).toEqual(p1.env);
    } finally {
      second.dispose();
    }
  }, 120_000);
});
