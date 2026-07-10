/**
 * CITY VIEW — the settlement inspected as a MAP plus its books.
 *
 * A read-only projection, one level between the world map and the
 * walkable zoom: the town plan (zoom.ts townPlan — the same prefix-stable
 * layout the streaming world lowers) drawn top-down with streets worn by
 * traffic, district tints, and typed works; beside it the settlement's
 * aggregate truth (population, tier, civ, charter, buildings, stockpiles,
 * per-commodity fills), its CHRONICLE (the step-5 history's own column:
 * population over time plus the structural events that touched it), and —
 * on click — any building's data: a work's production, a house's
 * household (the same deterministic residents the walkable world spawns),
 * pantry, district and shopping source.
 *
 * Everything here READS: settlement scalars, the CivHistory frames, the
 * TownGoods clock projections. Nothing feeds back — it is the §5b
 * presentation discipline applied to a ledger instead of a landscape.
 */

import type { TriWorld, CivHistory } from "./tri";
import type { TownPlan, TownHouse } from "./zoom";
import { HOUSEHOLD, memberIndex, worksOf } from "./zoom";
import type { TownGoods } from "./food";
import { DEFAULT_ECONOMY } from "./economy-core";
import type { CompiledEconomy } from "./economy";

/* ------------------------------ overview ------------------------------ */

export interface CityOverview {
  key: string;
  name: string;
  /** Tier key, "ruin", or null when the world declares no tiers. */
  tier: string | null;
  civ: { name: string; color: string } | null;
  pop: number;
  dead: { day: number; pop: number } | null;
  colonyOf: string | null;
  /** Keys of colonies this city funded. */
  colonies: string[];
  /** Grid persons harvested at founding (0 = colonists walked in). */
  harvested: number;
  charter: { farmland: number; ore_access: number; timberland: number };
  /** Building counts, only the vars the world actually declares. */
  buildings: Array<{ label: string; count: number }>;
  /** Stockpiles (granary, plank store…), only where declared. */
  stockpiles: Array<{ label: string; value: number }>;
  /** Per-commodity service levels, only where declared. */
  fills: Array<{ good: string; got: number; need: number; fill: number }>;
  /** NON-CIVIC populations living here (herds, vermin) — every species
   *  in the world's registry with a live headcount scalar. The civic
   *  souls are `pop`; these share the streets without tiering the town. */
  fauna: Array<{ key: string; name: string; glyph: string; count: number }>;
}

/** Prettify a scalar key for a panel label ("plank_store" → "Plank store"). */
const pretty = (key: string): string =>
  (key.charAt(0).toUpperCase() + key.slice(1)).replace(/_/g, " ");

export function cityOverview(tri: TriWorld, key: string): CityOverview {
  const city = tri.cities.find(c => c.key === key);
  if (!city) throw new Error(`cityOverview: unknown city ${key}`);
  const d = tri.dual;
  const eco = tri.economy ?? DEFAULT_ECONOMY;
  const has = (name: string): boolean => !!d.entityWorld.scalars[name];
  const s = (name: string): number => d.settlementScalar(key, name);
  const civ = d.civOf(key);
  return {
    key,
    name: city.name,
    tier: tri.tierOf(key),
    civ: civ ? { name: civ.name, color: civ.color } : null,
    pop: d.settlementPop(key),
    dead: city.dead ?? null,
    colonyOf: city.colonyOf ?? null,
    colonies: tri.cities.filter(c => c.colonyOf === key).map(c => c.key),
    harvested: city.harvested,
    charter: tri.charterOf(key),
    // Every row below comes from the WORLD'S REGISTRY (the compiled
    // economy) — a modded building, stockpile or commodity shows its
    // count, bank and supply bar the moment its ledger exists.
    buildings: eco.works
      .filter(w => has(w.countScalar))
      .map(w => ({ label: pretty(w.countScalar), count: s(w.countScalar) })),
    stockpiles: eco.stockpiles
      .filter(sp => has(sp.key))
      .map(sp => ({ label: sp.name ?? pretty(sp.key), value: s(sp.key) })),
    fills: eco.fills.filter(f => has(f.got) && has(f.need)).map(f => {
      const n = s(f.need);
      return { good: f.good, got: s(f.got), need: n, fill: n > 0 ? Math.max(0, Math.min(1, s(f.got) / n)) : 1 };
    }),
    fauna: eco.species
      .filter(sp => sp.key !== "human" && sp.countScalar && has(sp.countScalar))
      .map(sp => ({
        key: sp.key, name: sp.name, glyph: sp.glyph ?? "•",
        count: Math.round(s(sp.countScalar!)),
      }))
      .filter(f => f.count > 0),
  };
}

/* ------------------------------ chronicle ------------------------------ */

export interface CityChronicle {
  /** Recorded days and this city's population at each (present frames). */
  days: number[];
  pops: number[];
  events: Array<{ day: number; label: string }>;
}

/** This city's column of the recorded history (step 5), plus every
 *  structural event that names it — its founding, the colonies it sent,
 *  its death, its wars. */
export function cityChronicle(tri: TriWorld, key: string): CityChronicle {
  const ci = tri.cities.findIndex(c => c.key === key);
  if (ci < 0) throw new Error(`cityChronicle: unknown city ${key}`);
  const city = tri.cities[ci];
  const hist: CivHistory | null = tri.history();
  const days: number[] = [];
  const pops: number[] = [];
  const events: Array<{ day: number; label: string }> = [];

  const firstDay = (idx: number): number | null => {
    if (!hist) return null;
    const f = hist.frames.find(fr => fr.pop.length > idx);
    return f ? f.day : null;
  };

  if (hist) {
    for (const f of hist.frames) {
      if (f.pop.length <= ci) continue;
      days.push(f.day);
      pops.push(f.pop[ci]);
    }
  }

  const founded = firstDay(ci) ?? 0;
  events.push({
    day: founded,
    label: city.colonyOf
      ? `founded by colonists from ${city.colonyOf}`
      : `founded (crowd of ${city.harvested})`,
  });
  for (const c of tri.cities) {
    if (c.colonyOf !== key) continue;
    const day = firstDay(tri.cities.indexOf(c));
    events.push({ day: day ?? 0, label: `sent colonists — founded ${c.name}` });
  }
  for (const w of tri.dual.conquests()) {
    if (w.loser === key) events.push({ day: w.day, label: `conquered by ${w.winner} (${w.mode}, ${w.casualties} dead)` });
    if (w.winner === key) events.push({ day: w.day, label: `conquered ${w.loser} (${w.mode})` });
  }
  for (const t of tri.dual.tombstones()) {
    if (t.key === key) events.push({ day: t.day, label: `abandoned — ${t.pop.toLocaleString()} people walked away` });
  }
  if (city.dead && !tri.dual.tombstones().some(t => t.key === key)) {
    events.push({ day: city.dead.day, label: `fell (pop ${city.dead.pop.toLocaleString()})` });
  }
  events.sort((a, b) => a.day - b.day);
  return { days, pops, events };
}

/* ------------------------- building hit-testing ------------------------ */

export type BuildingRef =
  | { kind: "work"; index: number }
  | { kind: "house"; index: number }
  | { kind: "field"; index: number };

/** The building under a town-local point (meters from the town center).
 *  Works win ties (they matter more), then houses, then fields. A second
 *  pass pads footprints by 2 m — at full-town zoom a house is a few
 *  pixels, and a near-miss click should still land (lots sit ~5 m apart,
 *  so the pad can't grab a neighbor before an exact hit would). */
export function hitTestBuilding(plan: TownPlan, x: number, y: number): BuildingRef | null {
  const pass = (pad: number): BuildingRef | null => {
    const inRect = (dx: number, dy: number, w: number, h: number): boolean =>
      x >= dx - pad && x <= dx + w + pad && y >= dy - pad && y <= dy + h + pad;
    for (let i = 0; i < plan.works.length; i++) {
      const wk = plan.works[i];
      if (inRect(wk.dx, wk.dy, wk.w, wk.h)) return { kind: "work", index: i };
    }
    for (let i = 0; i < plan.houses.length; i++) {
      const h = plan.houses[i];
      if (inRect(h.dx, h.dy, h.w, h.h)) return { kind: "house", index: i };
    }
    for (let i = 0; i < plan.fields.length; i++) {
      const f = plan.fields[i];
      if (inRect(f.dx, f.dy, f.w, f.h)) return { kind: "field", index: i };
    }
    return null;
  };
  return pass(0) ?? pass(2);
}

/* ---------------------------- building info ---------------------------- */

export interface BuildingInfo {
  title: string;
  lines: string[];
}

/** Titles/glyphs of the STRUCTURAL works — economy buildings carry
 *  their own in the registry (BuildingDef.title / .glyph). */
const STRUCTURAL_TITLES: Record<string, string> = {
  hall: "🏛 Town hall",
  market: "🧺 Market",
};
const STRUCTURAL_GLYPHS: Record<string, string> = { hall: "🏛", market: "🧺" };

/** Render one registry info-line template: `{scalar}` → raw value,
 *  `{scalar:N}` → toFixed(N), `{per:out/count}` → per-building form. */
function renderInfoLine(
  tpl: string,
  s: (name: string) => number,
  per: (out: number, count: number) => string,
): string {
  return tpl
    .replace(/\{per:(\w+)\/(\w+)\}/g, (_m, out: string, cnt: string) => per(s(out), s(cnt)))
    .replace(/\{(\w+):(\d)\}/g, (_m, name: string, d: string) => s(name).toFixed(Number(d)))
    .replace(/\{(\w+)\}/g, (_m, name: string) => String(s(name)));
}

const hash32 = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** What a clicked building is doing right now — production for works
 *  (registry info templates over the settlement scalars; hall and
 *  market are structural and keep bespoke lines), the household for
 *  houses (the same deterministic residents the walkable world spawns),
 *  every good's box level and source. `t` is the wall clock in seconds
 *  (the goods projections run on it). `others` is the town's remaining
 *  goods projections beyond food (streetGoodsFor(...).slice(1)); a bare
 *  instance is accepted for older call sites. */
export function buildingInfo(
  tri: TriWorld,
  key: string,
  plan: TownPlan,
  goods: TownGoods,
  ref: BuildingRef,
  t: number,
  others?: TownGoods[] | TownGoods | null,
): BuildingInfo {
  const s = (name: string): number => tri.dual.settlementScalar(key, name);
  const per = (out: number, count: number): string =>
    count > 0 ? `${out.toFixed(1)}/day (${(out / count).toFixed(1)} per building)` : `${out.toFixed(1)}/day`;
  const extras = Array.isArray(others) ? others : others ? [others] : [];
  const candidates = [goods, ...extras];

  if (ref.kind === "field") {
    return { title: "Cultivated field", lines: ["Worked land beyond the lots — the farm gates' hinterland."] };
  }

  if (ref.kind === "work") {
    const wk = plan.works[ref.index];
    const lines: string[] = [];
    const def = worksOf(tri).find(w => w.key === wk.type);
    if (wk.type === "hall") {
      lines.push("Administration and imports depot.");
      if (tri.dual.entityWorld.scalars.granary) lines.push(`Granary: ${s("granary").toFixed(0)} rations banked.`);
      if (tri.dual.entityWorld.scalars.plank_store) lines.push(`Plank store: ${s("plank_store").toFixed(0)} banked.`);
    } else if (wk.type === "market") {
      const src = goods.sources.find(x => x.work === ref.index);
      if (src) {
        const district = goods.districts().find(dd => dd.source.work === ref.index);
        lines.push(`Shelf stock now: ${goods.stockOf(src, t).toFixed(1)} rations.`);
        lines.push(`Stocked at dawn: ${goods.stallDaily(src).toFixed(1)} rations/day.`);
        if (district) {
          lines.push(`Serves ${district.houseIdx.length} households (${district.kind} district, fill ${(district.fill * 100).toFixed(0)}%).`);
        }
      } else {
        lines.push("A market stall.");
      }
    } else if (def) {
      // A registered economy building: its info templates, then — when
      // some good sells over ITS counter — the live shelf.
      for (const tpl of def.info) lines.push(renderInfoLine(tpl, s, per));
      const seller = candidates.find(g => g !== goods && g.good.shelved.includes(wk.type));
      if (seller) {
        const src = seller.sources.find(x => x.work === ref.index);
        if (src) {
          lines.push(`Counter stock now: ${seller.stockOf(src, t).toFixed(1)} ${seller.good.unit ?? "units"}.`);
          const district = seller.districts().find(dd => dd.source.work === ref.index);
          if (district) lines.push(`Serves ${district.houseIdx.length} households.`);
        }
      }
    }
    const title = STRUCTURAL_TITLES[wk.type] ?? def?.title ?? wk.type;
    return { title, lines };
  }

  const house = plan.houses[ref.index];
  const lines: string[] = [];
  const district = goods.districtOf(house);
  if (district) {
    lines.push(`District: ${district.kind} (fill ${(district.fill * 100).toFixed(0)}%).`);
  }
  lines.push(`Pantry: ${goods.pantry(house, t).toFixed(1)} / ${goods.boxCap} rations.`);
  lines.push(`Shops at: ${goods.sourceOf(house).kind}.`);
  for (const g of extras) {
    const label = g.good.boxLabel ?? `${g.good.key} box`;
    const name = g.good.errandName ?? g.good.key;
    lines.push(`${label}: ${g.pantry(house, t).toFixed(1)} / ${g.boxCap} ${g.good.unit ?? "units"}.`);
    lines.push(`${name.charAt(0).toUpperCase()}${name.slice(1)} from: ${g.sourceOf(house).kind}.`);
  }
  // The VARIANT SEAM: the settlement ledger knows one FOOD; which food a
  // family favors is projection flavor — deterministic, display-only,
  // and the hook where real variants (fish vs grain as their own flow
  // nets) would attach without a second ledger.
  const FAVORITES = plan.biome === "mining"
    ? ["rye bread", "salt mutton", "mountain cheese", "smoked trout"]
    : ["barley bread", "river fish", "orchard fruit", "soft cheese"];
  lines.push(`Table favorite: ${FAVORITES[hash32(`${key}:fav:${house.index}`) % FAVORITES.length]}.`);
  lines.push("Household:");
  for (let m = 0; m < HOUSEHOLD; m++) {
    const v = tri.dual.sampleVillager(key, memberIndex(house.index, m));
    const runs = m > 0 ? extras.find(g => g.good.slot === m) : undefined;
    const tag = m === 0 ? " (the shopper)"
      : runs ? ` (runs the ${runs.good.errandName ?? runs.good.key} errands)` : "";
    if (v) lines.push(`  ${v.name}${tag}`);
  }
  return { title: `🏠 House #${house.index}`, lines };
}

/* ------------------------------ the map ------------------------------- */

export interface CityMapTransform {
  /** Pixels per meter. */
  scale: number;
  /** Canvas pixel of the town center. */
  ox: number;
  oy: number;
}

const DISTRICT_TINT: Record<string, string> = {
  mining: "rgba(96,108,132,0.38)",
  farm: "rgba(120,152,84,0.30)",
  craft: "rgba(150,110,70,0.30)",
  core: "rgba(198,168,110,0.18)",
  residential: "",
};
/** A work's map glyph: structural, else its registry def's. */
function glyphOf(type: string, works: CompiledEconomy["works"]): string {
  return STRUCTURAL_GLYPHS[type] ?? works.find(w => w.key === type)?.glyph ?? "▪";
}

/** Paint the town plan top-down: ground, fields, traffic-worn streets,
 *  district-tinted houses, typed works, the selection highlight. Returns
 *  the transform so the caller can map clicks back to town meters. */
export function paintCityMap(
  ctx: CanvasRenderingContext2D,
  plan: TownPlan,
  goods: TownGoods,
  opts: {
    w: number; h: number; selected?: BuildingRef | null;
    /** The town's remaining goods (their trips wear the streets too). */
    extras?: TownGoods[];
    /** Work registry for glyphs (defaults to the standard economy). */
    works?: CompiledEconomy["works"];
  },
): CityMapTransform {
  const works = opts.works ?? DEFAULT_ECONOMY.works;
  const { w, h } = opts;
  const span = Math.max(80, plan.radius + 40) * 2;
  const scale = Math.min(w, h) / span;
  const ox = w / 2;
  const oy = h / 2;
  const X = (m: number): number => ox + m * scale;
  const Y = (m: number): number => oy + m * scale;

  ctx.fillStyle = plan.groundColor;
  ctx.fillRect(0, 0, w, h);

  // Fields fan past the farm gates.
  ctx.fillStyle = "rgba(154,142,58,0.45)";
  for (const f of plan.fields) ctx.fillRect(X(f.dx), Y(f.dy), f.w * scale, f.h * scale);

  // Streets: plaza disc + the organic tree, width worn by traffic (the
  // same wear law the walkable view draws — §3b, arterials BECOME).
  const net = plan.streets;
  const traffics = [goods, ...(opts.extras ?? [])].map(g => g.streetTraffic());
  ctx.fillStyle = "rgba(203,183,142,0.4)";
  ctx.beginPath();
  ctx.arc(ox, oy, net.plazaR * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const st of net.streets) {
    const trips = traffics.reduce((sum, tr) => sum + (tr.get(st.id) ?? 0), 0);
    const wear = Math.min(1, Math.sqrt(trips) / 12);
    ctx.strokeStyle = `rgba(203,183,142,${(0.35 + 0.35 * wear).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, ((st.ring ? 2.8 : st.gen === 0 ? 3.4 : 2.4) + 2.8 * wear) * scale);
    ctx.beginPath();
    ctx.moveTo(X(st.pts[0].x), Y(st.pts[0].y));
    for (let i = 1; i < st.pts.length; i++) ctx.lineTo(X(st.pts[i].x), Y(st.pts[i].y));
    ctx.stroke();
  }

  // Houses, tinted by their district.
  for (const house of plan.houses) {
    ctx.fillStyle = house.color;
    ctx.fillRect(X(house.dx), Y(house.dy), house.w * scale, house.h * scale);
    const kind = goods.districtOf(house)?.kind;
    const tint = kind ? DISTRICT_TINT[kind] : "";
    if (tint) {
      ctx.fillStyle = tint;
      ctx.fillRect(X(house.dx), Y(house.dy), house.w * scale, house.h * scale);
    }
  }

  // Works on top, with their glyphs.
  for (const wk of plan.works) {
    ctx.fillStyle = wk.color;
    ctx.fillRect(X(wk.dx), Y(wk.dy), wk.w * scale, wk.h * scale);
    ctx.strokeStyle = "rgba(30,26,20,0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(X(wk.dx), Y(wk.dy), wk.w * scale, wk.h * scale);
    const size = Math.max(9, Math.min(16, 12 * scale * 1.4));
    ctx.font = `${size}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyphOf(wk.type, works), X(wk.dx + wk.w / 2), Y(wk.dy + wk.h / 2));
  }

  // Selection highlight.
  const sel = opts.selected;
  if (sel) {
    const r = sel.kind === "work" ? plan.works[sel.index]
      : sel.kind === "house" ? plan.houses[sel.index]
        : plan.fields[sel.index];
    if (r) {
      ctx.strokeStyle = "#ffd23f";
      ctx.lineWidth = 2;
      ctx.strokeRect(X(r.dx) - 2, Y(r.dy) - 2, r.w * scale + 4, r.h * scale + 4);
    }
  }

  return { scale, ox, oy };
}

/** A small population-over-time sparkline for the chronicle panel. */
export function paintSparkline(
  ctx: CanvasRenderingContext2D,
  chron: CityChronicle,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h);
  if (chron.days.length < 2) return;
  const maxPop = Math.max(1, ...chron.pops);
  const d0 = chron.days[0];
  const dSpan = Math.max(1, chron.days[chron.days.length - 1] - d0);
  ctx.strokeStyle = "#7ea0e8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  chron.days.forEach((day, i) => {
    const x = ((day - d0) / dSpan) * (w - 6) + 3;
    const y = h - 3 - (chron.pops[i] / maxPop) * (h - 8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // Event ticks along the base line.
  ctx.fillStyle = "#ffd23f";
  for (const e of chron.events) {
    const x = ((Math.max(d0, Math.min(e.day, d0 + dSpan)) - d0) / dSpan) * (w - 6) + 3;
    ctx.fillRect(x - 1, h - 6, 2, 5);
  }
}

/** The wall-clock houses use for the map's own hit info. */
export function nowSeconds(): number {
  return (typeof performance !== "undefined" ? performance.now() : 0) / 1000;
}
