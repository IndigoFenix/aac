/**
 * economy-json.ts — the BOOT GATE for external content files.
 *
 * `parseEconomyDoc` shape-checks unknown JSON into an `EconomyDoc` with
 * labeled errors: wrong types name the exact path, and UNKNOWN FIELDS
 * are rejected (an author's typo'd "prodcuers" fails loudly instead of
 * silently defaulting). This is structure only — semantic validation
 * (dangling references, missing anchors, the compiler laws) runs in
 * `compileEconomy`, and the idle-safety validator still gates the
 * compiled spec at world boot. Mods break at load, never at runtime.
 */

import type {
  BuildingDef, CommodityDef, CommodityStreetDef, EconomyDoc, SpeciesDef, StockpileDef,
} from "./economy";

class ParseError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface Ctx {
  path: string;
}

function fail(ctx: Ctx, msg: string): never {
  throw new ParseError(`${ctx.path}: ${msg}`);
}

function obj(ctx: Ctx, v: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObj(v)) fail(ctx, "expected an object");
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) fail(ctx, `unknown field "${k}" (allowed: ${allowed.join(", ")})`);
  }
  return v;
}

function str(ctx: Ctx, v: unknown, field: string): string {
  if (typeof v !== "string" || !v.length) fail(ctx, `"${field}" must be a non-empty string`);
  return v;
}

function num(ctx: Ctx, v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(ctx, `"${field}" must be a finite number`);
  return v;
}

function bool(ctx: Ctx, v: unknown, field: string): boolean {
  if (typeof v !== "boolean") fail(ctx, `"${field}" must be a boolean`);
  return v;
}

function arr(ctx: Ctx, v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) fail(ctx, `"${field}" must be an array`);
  return v;
}

function strArr(ctx: Ctx, v: unknown, field: string): string[] {
  return arr(ctx, v, field).map((x, i) => str({ path: `${ctx.path}.${field}[${i}]` }, x, field));
}

const DISTRICTS = ["farm", "mining", "craft", null] as const;

function parseStockpile(ctx: Ctx, raw: unknown): StockpileDef {
  const o = obj(ctx, raw, ["key", "max", "name", "construction"]);
  return {
    key: str(ctx, o.key, "key"),
    max: num(ctx, o.max, "max"),
    ...(o.name !== undefined ? { name: str(ctx, o.name, "name") } : {}),
    ...(o.construction !== undefined ? { construction: bool(ctx, o.construction, "construction") } : {}),
  };
}

function parseStreet(ctx: Ctx, raw: unknown): CommodityStreetDef {
  const o = obj(ctx, raw, [
    "capDays", "shopSec", "cartRations", "unit", "producers", "market",
    "stockColor", "boxLabel", "errandName",
  ]);
  return {
    capDays: num(ctx, o.capDays, "capDays"),
    shopSec: num(ctx, o.shopSec, "shopSec"),
    cartRations: num(ctx, o.cartRations, "cartRations"),
    unit: str(ctx, o.unit, "unit"),
    producers: strArr(ctx, o.producers, "producers"),
    ...(o.market !== undefined ? { market: bool(ctx, o.market, "market") } : {}),
    stockColor: str(ctx, o.stockColor, "stockColor"),
    boxLabel: str(ctx, o.boxLabel, "boxLabel"),
    errandName: str(ctx, o.errandName, "errandName"),
  };
}

function parseCommodity(ctx: Ctx, raw: unknown): CommodityDef {
  const o = obj(ctx, raw, [
    "key", "scalarMax", "perPersonDaily", "popScalar", "transport", "needSum", "allocate", "street",
  ]);
  const key = str(ctx, o.key, "key");
  const out: CommodityDef = { key, scalarMax: num(ctx, o.scalarMax, "scalarMax") };
  if (o.perPersonDaily !== undefined) out.perPersonDaily = num(ctx, o.perPersonDaily, "perPersonDaily");
  if (o.popScalar !== undefined) out.popScalar = str(ctx, o.popScalar, "popScalar");
  if (o.transport !== undefined) {
    const t = obj({ path: `${ctx.path}.transport` }, o.transport, ["id", "demand", "drift", "driftRequiresConstruction", "wearsRoad"]);
    const tc: Ctx = { path: `${ctx.path}.transport` };
    out.transport = {
      ...(t.id !== undefined ? { id: str(tc, t.id, "id") } : {}),
      ...(t.demand !== undefined ? { demand: str(tc, t.demand, "demand") } : {}),
      ...(t.drift !== undefined ? { drift: str(tc, t.drift, "drift") } : {}),
      ...(t.driftRequiresConstruction !== undefined
        ? { driftRequiresConstruction: bool(tc, t.driftRequiresConstruction, "driftRequiresConstruction") } : {}),
      ...(t.wearsRoad !== undefined ? { wearsRoad: bool(tc, t.wearsRoad, "wearsRoad") } : {}),
    };
  }
  if (o.needSum !== undefined) out.needSum = strArr(ctx, o.needSum, "needSum");
  if (o.allocate !== undefined) {
    out.allocate = arr(ctx, o.allocate, "allocate").map((x, i) => {
      const c: Ctx = { path: `${ctx.path}.allocate[${i}]` };
      const a = obj(c, x, ["share", "demand"]);
      return { share: str(c, a.share, "share"), demand: str(c, a.demand, "demand") };
    });
  }
  if (o.street !== undefined) out.street = parseStreet({ path: `${ctx.path}.street` }, o.street);
  return out;
}

function parseBuilding(ctx: Ctx, raw: unknown): BuildingDef {
  const o = obj(ctx, raw, [
    "key", "countScalar", "cap", "processes", "vars", "construction",
    "sells", "shelved", "leansToward", "mapCap", "district",
    "style", "vignette", "glyph", "title", "info",
  ]);
  const key = str(ctx, o.key, "key");
  const capO = obj({ path: `${ctx.path}.cap` }, o.cap, ["by", "rate"]);
  const conO = obj({ path: `${ctx.path}.construction` }, o.construction, ["tier", "costs"]);
  const tier = str({ path: `${ctx.path}.construction` }, conO.tier, "tier");
  if (tier !== "base" && tier !== "industry") fail({ path: `${ctx.path}.construction` }, `"tier" must be "base" or "industry"`);
  const district = o.district;
  if (!DISTRICTS.includes(district as (typeof DISTRICTS)[number])) {
    fail(ctx, `"district" must be one of farm | mining | craft | null`);
  }
  const styleO = obj({ path: `${ctx.path}.style` }, o.style, ["color", "w", "h"]);
  const vigO = obj({ path: `${ctx.path}.vignette` }, o.vignette, ["w", "h"]);
  if (o.leansToward !== null && typeof o.leansToward !== "string") {
    fail(ctx, `"leansToward" must be a substrate field name or null`);
  }
  return {
    key,
    countScalar: str(ctx, o.countScalar, "countScalar"),
    cap: {
      by: str({ path: `${ctx.path}.cap` }, capO.by, "by"),
      rate: num({ path: `${ctx.path}.cap` }, capO.rate, "rate"),
    },
    processes: arr(ctx, o.processes, "processes").map((x, i) => {
      const c: Ctx = { path: `${ctx.path}.processes[${i}]` };
      const p = obj(c, x, ["id", "input", "inputs", "output", "efficiency", "capacityRate"]);
      if ((p.input === undefined) === (p.inputs === undefined)) {
        fail(c, `exactly one of "input" / "inputs" is required`);
      }
      return {
        id: str(c, p.id, "id"),
        ...(p.input !== undefined ? { input: str(c, p.input, "input") } : {}),
        ...(p.inputs !== undefined
          ? {
              inputs: arr(c, p.inputs, "inputs").map((y, j) => {
                const rc: Ctx = { path: `${c.path}.inputs[${j}]` };
                const r = obj(rc, y, ["scalar", "efficiency"]);
                return { scalar: str(rc, r.scalar, "scalar"), efficiency: num(rc, r.efficiency, "efficiency") };
              }),
            }
          : {}),
        output: str(c, p.output, "output"),
        ...(p.efficiency !== undefined ? { efficiency: num(c, p.efficiency, "efficiency") } : {}),
        ...(p.capacityRate !== undefined ? { capacityRate: num(c, p.capacityRate, "capacityRate") } : {}),
      };
    }),
    ...(o.vars !== undefined
      ? {
          vars: arr(ctx, o.vars, "vars").map((x, i) => {
            const c: Ctx = { path: `${ctx.path}.vars[${i}]` };
            const r = obj(c, x, ["name", "max"]);
            return { name: str(c, r.name, "name"), max: num(c, r.max, "max") };
          }),
        }
      : {}),
    construction: {
      tier,
      costs: arr({ path: `${ctx.path}.construction` }, conO.costs, "costs").map((x, i) => {
        const c: Ctx = { path: `${ctx.path}.construction.costs[${i}]` };
        const r = obj(c, x, ["stockpile", "amount"]);
        return { stockpile: str(c, r.stockpile, "stockpile"), amount: num(c, r.amount, "amount") };
      }),
    },
    ...(o.sells !== undefined ? { sells: strArr(ctx, o.sells, "sells") } : {}),
    ...(o.shelved !== undefined ? { shelved: bool(ctx, o.shelved, "shelved") } : {}),
    leansToward: o.leansToward as string | null,
    mapCap: num(ctx, o.mapCap, "mapCap"),
    district: district as BuildingDef["district"],
    style: {
      color: str({ path: `${ctx.path}.style` }, styleO.color, "color"),
      w: num({ path: `${ctx.path}.style` }, styleO.w, "w"),
      h: num({ path: `${ctx.path}.style` }, styleO.h, "h"),
    },
    vignette: {
      w: num({ path: `${ctx.path}.vignette` }, vigO.w, "w"),
      h: num({ path: `${ctx.path}.vignette` }, vigO.h, "h"),
    },
    glyph: str(ctx, o.glyph, "glyph"),
    title: str(ctx, o.title, "title"),
    info: strArr(ctx, o.info, "info"),
  };
}

function parseSpecies(ctx: Ctx, raw: unknown): SpeciesDef {
  const o = obj(ctx, raw, [
    "key", "role", "name", "color", "glyph", "needs", "vitals", "civic",
    "foundingShare", "countScalar", "countMax", "capacity", "growth", "wild",
  ]);
  const role = str(ctx, o.role, "role");
  if (role !== "sapient" && role !== "domestic" && role !== "commensal") {
    fail(ctx, `"role" must be sapient | domestic | commensal`);
  }
  const out: SpeciesDef = {
    key: str(ctx, o.key, "key"),
    role: role as SpeciesDef["role"],
    name: str(ctx, o.name, "name"),
  };
  if (o.color !== undefined) out.color = str(ctx, o.color, "color");
  if (o.glyph !== undefined) out.glyph = str(ctx, o.glyph, "glyph");
  if (o.needs !== undefined) {
    out.needs = arr(ctx, o.needs, "needs").map((x, i) => {
      const c: Ctx = { path: `${ctx.path}.needs[${i}]` };
      const n = obj(c, x, ["resource", "value"]);
      return { resource: str(c, n.resource, "resource"), value: num(c, n.value, "value") };
    });
  }
  if (o.vitals !== undefined) {
    const vc: Ctx = { path: `${ctx.path}.vitals` };
    const vo = obj(vc, o.vitals, ["birth", "death", "starvation", "diet", "capacity"]);
    out.vitals = {
      birth: num(vc, vo.birth, "birth"),
      death: num(vc, vo.death, "death"),
      ...(vo.starvation !== undefined ? { starvation: num(vc, vo.starvation, "starvation") } : {}),
      ...(vo.diet !== undefined ? { diet: str(vc, vo.diet, "diet") } : {}),
      ...(vo.capacity !== undefined
        ? {
            capacity: (() => {
              const cc: Ctx = { path: `${vc.path}.capacity` };
              const co = obj(cc, vo.capacity, ["scalar", "perUnit"]);
              return { scalar: str(cc, co.scalar, "scalar"), perUnit: num(cc, co.perUnit, "perUnit") };
            })(),
          }
        : {}),
    };
  }
  if (o.civic !== undefined) out.civic = bool(ctx, o.civic, "civic");
  if (o.foundingShare !== undefined) out.foundingShare = num(ctx, o.foundingShare, "foundingShare");
  if (o.countScalar !== undefined) out.countScalar = str(ctx, o.countScalar, "countScalar");
  if (o.countMax !== undefined) out.countMax = num(ctx, o.countMax, "countMax");
  if (o.capacity !== undefined) {
    const cc: Ctx = { path: `${ctx.path}.capacity` };
    const co = obj(cc, o.capacity, ["by", "rate"]);
    out.capacity = { by: str(cc, co.by, "by"), rate: num(cc, co.rate, "rate") };
  }
  if (o.growth !== undefined) out.growth = num(ctx, o.growth, "growth");
  if (o.wild !== undefined) {
    const wc: Ctx = { path: `${ctx.path}.wild` };
    const wo = obj(wc, o.wild, ["field", "habitat", "scale"]);
    out.wild = {
      field: str(wc, wo.field, "field"),
      habitat: str(wc, wo.habitat, "habitat"),
      ...(wo.scale !== undefined ? { scale: num(wc, wo.scale, "scale") } : {}),
    };
  }
  return out;
}

/** Parse an external content file into an EconomyDoc, or throw a
 *  labeled ParseError. `label` names the file in every message. */
export function parseEconomyDoc(raw: unknown, label = "economy content"): EconomyDoc {
  const root: Ctx = { path: label };
  const o = obj(root, raw, ["stockpiles", "commodities", "buildings", "species"]);
  const out: EconomyDoc = {};
  if (o.stockpiles !== undefined) {
    out.stockpiles = arr(root, o.stockpiles, "stockpiles")
      .map((x, i) => parseStockpile({ path: `${label}.stockpiles[${i}]` }, x));
  }
  if (o.commodities !== undefined) {
    out.commodities = arr(root, o.commodities, "commodities")
      .map((x, i) => parseCommodity({ path: `${label}.commodities[${i}]` }, x));
  }
  if (o.buildings !== undefined) {
    out.buildings = arr(root, o.buildings, "buildings")
      .map((x, i) => parseBuilding({ path: `${label}.buildings[${i}]` }, x));
  }
  if (o.species !== undefined) {
    out.species = arr(root, o.species, "species")
      .map((x, i) => parseSpecies({ path: `${label}.species[${i}]` }, x));
  }
  return out;
}
