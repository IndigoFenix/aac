/**
 * Grand Dream — Routes Lab.
 *
 * A developer harness for grand-dream steps 1–2. Step 1: PopuSim
 * cross-site routes (ranged sheds + migration). Step 2: DUAL scenarios
 * boot a cell-systems settlement world over the same node graph, coupled
 * at the day boundary (dual.ts) — route strengths grow out of the
 * settlement economy's roads, migration is driven by its population
 * exchange. Renders the shared map, colors sites by trait prevalence,
 * and runs live invariant checks. Not wired into the AAC host.
 */

import { injectTile, pendingCount, worldStep } from "@cells/index";
import { runWorldHost, type WorldHost } from "@shared/world-engine/world-host";
import { bootLab } from "./boot";
import { bootDual, type DualWorld } from "./dual";
import type { CompositionWorld } from "@shared/engine/civ/composition";
import type { TriWorld, CivHistory } from "./tri";
import { SCENARIOS, cloneScenarioJson, type LabScenario } from "./scenarios";
import { runChecks } from "./checks";
import { paintSubstrateImage, createSubstratePresenter, type SubstratePresenter } from "./substrate-render";
import { createRevealTracker, createEasedValues, smooth, type RevealTracker, type EasedValues } from "./transients";
import { createGeoScrubber, type GeoScrubber } from "./geo-scrub";
import { createCivScrubber, type CivScrubber } from "./civ-scrub";
import type { TectonicFrame } from "./tectonics";
import { createTravelerBands, type BandWorld } from "./traveler-bands";
import {
  ERRAND_WALK, FOOD_DAY_SEC, goodBoxAt, streetGoodsFor, type TownFood,
} from "./food";
import { CORE_BASE, CORE_GOODS2, DEFAULT_ECONOMY } from "./economy-core";
import { CLOTHING } from "./economy-clothing";
import { compileEconomy, type EconomyDoc } from "./economy";
import { parseEconomyDoc } from "./economy-json";
import { docsFor, isWorldManifest, loadWorldManifest } from "@shared/engine/manifest";
import { ECONOMY_MODULE } from "@shared/engine/modules/economy";
import { pointAt } from "./streets";
import { houseFurniture } from "@shared/engine/town/furniture";
import {
  PEOPLE_R, STREET_NPCS, WORLD_TILE, createParty, createTownManager, disbandParty,
  generateWorld, nearestCity, parkParty, recruitVillager, terrainConstraint,
  townPlan, villagerNpcId, villagerOf, worldPos, type TownManager,
} from "./zoom";
import {
  buildingInfo, cityChronicle, cityOverview, hitTestBuilding, nowSeconds,
  paintCityMap, paintSparkline, type BuildingRef,
} from "./city-view";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("map");
const ctx = canvas.getContext("2d")!;
const scenarioSel = $<HTMLSelectElement>("scenario");
const traitSel = $<HTMLSelectElement>("trait");
const descEl = $("scenario-desc");
const playBtn = $<HTMLButtonElement>("play");
const stepBtn = $<HTMLButtonElement>("step");
const resetBtn = $<HTMLButtonElement>("reset");
const speedInput = $<HTMLInputElement>("speed");
const speedVal = $("speed-val");
const seedInput = $<HTMLInputElement>("seed");
const contentFile = $<HTMLInputElement>("content-file");
const contentStatus = $("content-status");
const dayEl = $("day");
const totalPopEl = $("totalpop");
const sculptTools = $("sculpt-tools");
const geoField = $("geo-field");
const geoScrub = $<HTMLInputElement>("geo-scrub");
const geoEpoch = $("geo-epoch");
const civField = $("civ-field");
const civScrub = $<HTMLInputElement>("civ-scrub");
const civDay = $("civ-day");
const toolRaise = $<HTMLButtonElement>("tool-raise");
const toolDig = $<HTMLButtonElement>("tool-dig");
const statsBody = $("stats").querySelector("tbody")!;
const traitHead = $("stat-trait-head");
const legendEl = $("legend");
const checkList = $("check-list");

interface Runtime {
  scenario: LabScenario;
  lw: CompositionWorld;
  initialTotal: number;
  colorTrait: string;
  /** Site key → normalized [x, y]: the scenario's layout, or (tri) the
   *  cities' substrate tile positions. */
  layout: Record<string, [number, number]>;
  /** Tri scenarios only: the coupled three-layer world + a pixel buffer
   *  for painting the substrate behind the graph. */
  tri?: TriWorld;
  triCanvas?: HTMLCanvasElement;
  /** Interpolated-transient water paint (timescales.md §5b): the shown
   *  river EASES toward the live solve, so re-routes carve instead of
   *  snapping. Shared by the map and the zoomed world view — one shown
   *  state per world. */
  presenter?: SubstratePresenter;
  /** Discrete-event transients (same doctrine, transients.ts): cities
   *  GROW IN when founded, roads REACH OUT from the network, and jumpy
   *  continuous quantities (route widths, flows, radii) ease. Primed at
   *  load — what already existed does not animate. */
  fx: { born: RevealTracker; roads: RevealTracker; eased: EasedValues };
  /** Geologic-history scrubber (geo-scrub.ts): present only when the
   *  world was made by the tectonic provider and carries keyframes. At
   *  pos < 1 the map shows DEEP TIME (eased between keyframes) and the
   *  graph hides — the cities belong to the present. */
  geo?: GeoScrubber;
  /** Civilization-history scrubber (civ-scrub.ts): built lazily on first
   *  slider input once the tri world has recorded ≥ 2 keyframes, rebuilt
   *  when frames accrued since. At pos < 1 the map draws the RECORDED
   *  settlement past over the present substrate (the civ layer is what's
   *  keyframed — terrain drifts slowly enough to stand behind it). */
  civ?: CivScrubber;
  /** The history snapshot the scrubber was built from (rosters for
   *  drawing) and its frame count (rebuild trigger). */
  civHist?: CivHistory;
  civBuiltFrames?: number;
  /** Day shown = lw.day() − day0 (elapsed since load, so every scenario
   *  starts at Day 0 regardless of the engine's boot day). */
  day0: number;
  /** Grid persons already harvested at load — mid-run foundings beyond
   *  this are the ledger's `injected` term. */
  harvested0: number;
}
let rt: Runtime | null = null;
let playing = false;
let acc = 0;
let lastTs = 0;

/** Loaded CUSTOM economy documents (the developer-mod seam): parsed and
 *  dry-run compiled at load — a bad file reports and changes nothing —
 *  then handed to the emergent tri scenarios on every (re)boot. */
let customContent: EconomyDoc[] = [];

/* --------------------------- scenario boot --------------------------- */

async function loadScenario(scenario: LabScenario, colorTrait?: string): Promise<void> {
  playing = false;
  playBtn.textContent = "▶ Play";
  closeZoom(); // the party's histfigs belong to the old world instance
  closeCityView(); // its plan/goods read the old world instance
  party.members = [];
  party.parkedAt = null;
  const seed = parseInt(seedInput.value, 10) || 12345;

  let lw: CompositionWorld;
  let tri: TriWorld | undefined;
  let geoFrames: TectonicFrame[] | undefined;
  if (scenario.tri) {
    const world = await scenario.tri(seed, customContent.length ? customContent : undefined);
    tri = world.tri;
    lw = tri.dual;
    geoFrames = (world as { frames?: TectonicFrame[] }).frames;
    // City positions come live from tri.cities (they can grow) — see
    // sitePixel.
  } else if (scenario.dual) {
    lw = await bootDual(JSON.parse(JSON.stringify(scenario.dual)), seed);
  } else {
    lw = await bootLab(cloneScenarioJson(scenario), seed);
  }

  const traits = lw.traitKeys();
  const chosen = colorTrait && traits.includes(colorTrait) ? colorTrait : traits[0] ?? "";
  rt = {
    scenario, lw, initialTotal: lw.totalPop(), colorTrait: chosen,
    layout: { ...scenario.layout }, tri,
    presenter: tri ? createSubstratePresenter(tri.grid) : undefined,
    fx: { born: createRevealTracker(1.4, 0.8), roads: createRevealTracker(1.8, 0.8), eased: createEasedValues(0.6) },
    geo: tri && geoFrames && geoFrames.length > 1
      ? createGeoScrubber(geoFrames, tri.grid.cols, tri.grid.rows)
      : undefined,
    day0: lw.day(), harvested0: tri ? tri.harvestedTotal() : 0,
  };
  sculptTools.style.display = tri ? "" : "none";
  geoField.style.display = rt.geo ? "" : "none";
  geoScrub.value = "1000";
  geoEpoch.textContent = "";
  civField.style.display = "none"; // shown once ≥ 2 frames exist (renderPanel)
  civScrub.value = "1000";
  civDay.textContent = "";

  descEl.textContent = scenario.desc;
  populateTraitSelect(traits, chosen);
  render();
}

function populateTraitSelect(traits: string[], chosen: string): void {
  traitSel.innerHTML = "";
  for (const t of traits) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    if (t === chosen) opt.selected = true;
    traitSel.appendChild(opt);
  }
  traitHead.textContent = chosen || "trait";
}

/* ----------------------------- rendering ----------------------------- */

/** Paint a deep-time frame from the geologic scrubber over the whole map. */
function paintGeoView(geo: GeoScrubber, ts: number): void {
  const tri = rt?.tri;
  if (!tri) return;
  const { cols, rows } = tri.grid;
  if (!rt!.triCanvas) {
    rt!.triCanvas = document.createElement("canvas");
    rt!.triCanvas.width = cols;
    rt!.triCanvas.height = rows;
  }
  const buf = rt!.triCanvas.getContext("2d")!;
  const img = buf.createImageData(cols, rows);
  geo.paint(img, ts);
  buf.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(rt!.triCanvas, 0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = "rgba(240,240,250,0.9)";
  ctx.font = "600 14px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`deep time — epoch ${Math.round(geo.epoch())} (scrub right to return to the present)`, 14, 24);
}

/** Paint the RECORDED settlement past (civ-scrub.ts) over the present
 *  substrate: rings sized by recorded population, colored by recorded
 *  majority civ, ruins dashed, road widths from recorded wear, borders
 *  tinted by recorded hostility. The civ layer is what's keyframed —
 *  terrain drifts slowly enough to stand behind it. */
function paintCivHistory(ts: number): void {
  const tri = rt?.tri;
  const hist = rt?.civHist;
  const scrub = rt?.civ;
  if (!tri || !hist || !scrub) return;
  const view = scrub.view(ts);
  const { cols, rows } = tri.grid;
  const px = (x: number, y: number): [number, number] =>
    [((x + 0.5) / cols) * canvas.width, ((y + 0.5) / rows) * canvas.height];
  const civColor = new Map<string, string>();
  const civsFn = (rt!.lw as CompositionWorld & Partial<Pick<DualWorld, "civs">>).civs;
  if (civsFn) for (const c of civsFn()) civColor.set(c.trait, c.color);

  // Roads under the nodes: width from recorded wear, heat from recorded
  // border hostility.
  for (let ei = 0; ei < hist.edges.length; ei++) {
    const e = view.edges[ei];
    if (!e.present) continue;
    const a = hist.cities[hist.edges[ei].a];
    const b = hist.cities[hist.edges[ei].b];
    if (!a || !b) continue;
    const [ax, ay] = px(a.x, a.y);
    const [bx, by] = px(b.x, b.y);
    const heat = Math.max(0, Math.min(1, e.hostility));
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineWidth = 1 + e.road * 5;
    ctx.strokeStyle = `rgba(${Math.round(150 + heat * 100)},${Math.round(155 - heat * 90)},${Math.round(165 - heat * 115)},0.8)`;
    ctx.stroke();
  }

  const maxPop = Math.max(1, ...view.cities.map(c => (c.present && !c.dead ? c.pop : 0)));
  for (let ci = 0; ci < hist.cities.length; ci++) {
    const c = view.cities[ci];
    if (!c.present) continue;
    const info = hist.cities[ci];
    const [x, y] = px(info.x, info.y);
    if (c.dead) {
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(165,165,175,0.85)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(175,175,185,0.9)";
      ctx.font = "italic 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${info.name} · ruin`, x, y + 24);
      ctx.globalAlpha = 1;
      continue;
    }
    const radius = 10 + 28 * Math.sqrt(c.pop / maxPop);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(95,115,165,0.45)";
    ctx.fill();
    ctx.lineWidth = c.civ ? 3 : 2;
    ctx.strokeStyle = civColor.get(c.civ) ?? "rgba(255,255,255,0.85)";
    ctx.stroke();
    ctx.fillStyle = "#f5f5fa";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(info.name, x, y + radius + 14);
  }

  ctx.fillStyle = "rgba(240,240,250,0.9)";
  ctx.font = "600 14px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`civilization history — day ${Math.round(view.day)} (scrub right to return to the present)`, 14, 24);
}

/** Paint the live substrate under the graph — the ORIGINAL sandbox's
 *  renderer (see substrate-render.ts), stretched over the whole map. */
function paintSubstrate(): void {
  const tri = rt?.tri;
  if (!tri) return;
  const { cols, rows } = tri.grid;
  if (!rt!.triCanvas) {
    rt!.triCanvas = document.createElement("canvas");
    rt!.triCanvas.width = cols;
    rt!.triCanvas.height = rows;
  }
  const buf = rt!.triCanvas.getContext("2d")!;
  const img = buf.createImageData(cols, rows);
  const now = performance.now() / 1000;
  if (rt!.presenter) rt!.presenter.paint(img, now);
  else paintSubstrateImage(tri.grid, img, now);
  buf.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(rt!.triCanvas, 0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
}

// Blue (0%) → red (100%) prevalence ramp.
function prevalenceColor(frac: number): string {
  const f = Math.max(0, Math.min(1, frac));
  const r = Math.round(60 + f * 180);
  const g = Math.round(120 - f * 70);
  const b = Math.round(220 - f * 170);
  return `rgb(${r},${g},${b})`;
}

function sitePixel(key: string): [number, number] {
  // Tri worlds: cities sit where they were founded, edge-to-edge over the
  // substrate — looked up live because auto-founding grows the list.
  if (rt!.tri) {
    const c = rt!.tri.cities.find(x => x.key === key);
    const nx = c ? (c.x + 0.5) / rt!.tri.grid.cols : 0.5;
    const ny = c ? (c.y + 0.5) / rt!.tri.grid.rows : 0.5;
    return [nx * canvas.width, ny * canvas.height];
  }
  const [nx, ny] = rt!.layout[key] ?? [0.5, 0.5];
  const pad = 70;
  return [pad + nx * (canvas.width - 2 * pad), pad + ny * (canvas.height - 2 * pad)];
}

/** Redraw the map. `panelToo` also rebuilds the side panel (skip it when
 *  called from the per-frame caravan animation loop). */
function render(panelToo: boolean = true): void {
  if (!rt) return;
  const { lw, colorTrait } = rt;
  const flowOf = (lw as CompositionWorld & Partial<Pick<DualWorld, "settlementFlow">>).settlementFlow;
  const now = performance.now();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // DEEP TIME: while the scrubber sits below "now", the map shows the
  // recorded tectonic history (eased between keyframes — §5b pointed
  // backward) and the settlement graph hides; the live world is untouched.
  if (rt.geo && rt.geo.pos() < 1) {
    paintGeoView(rt.geo, now / 1000);
    geoEpoch.textContent = `· epoch ${Math.round(rt.geo.epoch())}`;
    if (panelToo) renderPanel();
    return;
  }
  geoEpoch.textContent = "";

  // CIVILIZATION HISTORY: while its scrubber sits below "now", the map
  // replays the RECORDED settlement past (civ-scrub.ts) over the present
  // terrain; the live graph resumes at pos 1. Read-only toward the past.
  if (rt.civ && rt.civ.pos() < 1 && rt.civHist) {
    paintSubstrate();
    paintCivHistory(now / 1000);
    civDay.textContent = `· day ${Math.round(rt.civ.day())}`;
    if (panelToo) renderPanel();
    return;
  }
  civDay.textContent = "";
  paintSubstrate();

  // Discrete-event transients (transients.ts): reconcile what exists NOW,
  // so a city founded this day grows in and its road reaches out — the
  // §5b doctrine applied to births instead of fields.
  const routes = lw.routes();
  const civOf = (lw as CompositionWorld & Partial<Pick<DualWorld, "civOf">>).civOf;
  const sites = lw.sites();
  const { born, roads, eased } = rt.fx;
  const tSec = now / 1000;
  eased.frame(tSec);
  born.frame(tSec, sites.map(s => s.key));
  const routeKey = (r: { site_a: { key: string } | null; site_b: { key: string } | null }): string =>
    `${r.site_a?.key}~${r.site_b?.key}`;
  roads.frame(tSec, routes.filter(r => r.site_a && r.site_b).map(routeKey));

  // Routes first (under the nodes). Route order matches the dual spec's
  // edge order, so index e addresses the flow field directly.
  for (let e = 0; e < routes.length; e++) {
    const r = routes[e];
    if (!r.site_a || !r.site_b) continue;
    let [ax, ay] = sitePixel(r.site_a.key);
    let [bx, by] = sitePixel(r.site_b.key);
    // A NEW road reaches out from the established network toward the
    // younger endpoint (parametric reveal along the line).
    const grow = smooth(roads.phase(routeKey(r)));
    if (grow < 1) {
      if (born.phase(r.site_a.key) < born.phase(r.site_b.key)) {
        [ax, ay, bx, by] = [bx, by, ax, ay]; // grow FROM the older city
      }
      bx = ax + (bx - ax) * grow;
      by = ay + (by - ay) * grow;
    }
    const migrates = r.migration > 0;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineWidth = 1.5 + eased.value(`s:${routeKey(r)}`, r.strength) * 2.5;
    ctx.strokeStyle = migrates ? "rgba(120,200,140,0.7)" : "rgba(150,150,170,0.55)";
    if (migrates && r.strength === 0) ctx.setLineDash([6, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Caravans: a marching-dash render of the steady-state flow field
    // (§4c) — the world can be at rest while these keep moving, because
    // they are drawn FROM state, not simulated INTO it. The volume itself
    // eases (a re-solved flow net jumps); no caravans on an unfinished road.
    const flow = grow >= 1 ? (flowOf ? flowOf(e) : 0) : 0;
    const flowShown = eased.value(`f:${routeKey(r)}`, Math.abs(flow));
    if (flowShown > 1e-3) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineWidth = 2 + Math.min(4, flowShown * 0.12);
      ctx.strokeStyle = "rgba(235,195,90,0.85)";
      ctx.setLineDash([5, 11]);
      const speed = Math.min(60, 8 + flowShown * 1.5); // px/s, scales with volume
      ctx.lineDashOffset = -Math.sign(flow || 1) * (((now / 1000) * speed) % 16);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Route label at the midpoint (once the road is real).
    if (grow >= 1) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      ctx.fillStyle = "rgba(180,180,195,0.9)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      const bits: string[] = [];
      if (r.strength > 0) bits.push(`s${+r.strength.toFixed(2)}`); // dual strengths evolve — keep labels short
      if (r.migration > 0) bits.push(`m${r.migration}`);
      if (Math.abs(flow) > 1e-9) bits.push(`f${+Math.abs(flow).toFixed(1)}`);
      if (bits.length) ctx.fillText(bits.join(" "), mx, my - 6);
    }
  }

  // Nodes: a founded city GROWS IN (radius scales with its reveal phase,
  // plus a fading founding pulse); population growth eases instead of
  // stepping at day boundaries.
  const maxPop = Math.max(1, ...sites.map(s => s.pop));
  for (const s of sites) {
    const [x, y] = sitePixel(s.key);
    // A fallen settlement draws as a RUIN: a small faded dashed ring, no
    // pulse, no growth, the label greyed — the map remembers the place.
    const dead = rt?.tri?.cities.find(c => c.key === s.key)?.dead;
    if (dead) {
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(165,165,175,0.85)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(175,175,185,0.9)";
      ctx.font = "italic 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${s.name} · ruin`, x, y + 24);
      ctx.globalAlpha = 1;
      continue;
    }
    const ph = smooth(born.phase(s.key));
    const radius = eased.value(`r:${s.key}`, 18 + 34 * Math.sqrt(s.pop / maxPop)) * (0.25 + 0.75 * ph);
    const withTrait = colorTrait ? lw.popOnSiteWithTrait(s.key, colorTrait) : 0;
    const frac = s.pop > 0 ? withTrait / s.pop : 0;

    ctx.globalAlpha = 0.3 + 0.7 * ph;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = prevalenceColor(frac);
    ctx.fill();
    // Ring color = majority civ (membership trait), white when civless.
    const civ = civOf ? civOf(s.key) : null;
    ctx.lineWidth = civ ? 3.5 : 2;
    ctx.strokeStyle = civ ? civ.color : "rgba(255,255,255,0.85)";
    ctx.stroke();
    if (ph < 1) {
      // Founding pulse: an expanding, fading ring around the newborn.
      ctx.beginPath();
      ctx.arc(x, y, radius * (1 + 1.4 * (1 - ph)), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${(0.6 * (1 - ph)).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = "#f5f5fa";
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    // Tier label (village/town/city) when the tri world declares tiers —
    // regimes over live population, so promotions show up as the label
    // changing under a growing ring.
    const tier = rt?.tri?.tierOf(s.key);
    ctx.fillText(tier ? `${s.name} · ${tier}` : s.name, x, y + radius + 15);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(230,230,240,0.8)";
    ctx.fillText(`${(frac * 100).toFixed(1)}%`, x, y + 4);
    ctx.globalAlpha = 1;
  }

  if (panelToo) renderPanel();
}

/** True when the loaded world exposes a nonzero steady-state flow field —
 *  drives the continuous caravan animation. */
function hasFlow(): boolean {
  if (!rt) return false;
  const flowOf = (rt.lw as CompositionWorld & Partial<Pick<DualWorld, "settlementFlow">>).settlementFlow;
  if (!flowOf) return false;
  for (let e = 0; e < rt.lw.routes().length; e++) {
    if (Math.abs(flowOf(e)) > 1e-9) return true;
  }
  return false;
}

function renderPanel(): void {
  if (!rt) return;
  const { lw, colorTrait } = rt;
  dayEl.textContent = String(lw.day() - rt.day0); // elapsed since load
  // The civilization-history slider appears once there is a history to
  // scrub (≥ 2 recorded keyframes).
  if (rt.tri) civField.style.display = rt.tri.historyFrames() >= 2 ? "" : "none";
  totalPopEl.textContent = lw.totalPop().toLocaleString();
  traitHead.textContent = colorTrait || "trait";

  // Tri worlds: the substrate's own numbers ride along in the day line.
  let triExtra = document.getElementById("tri-extra");
  if (rt.tri) {
    if (!triExtra) {
      triExtra = document.createElement("span");
      triExtra.id = "tri-extra";
      dayEl.parentElement!.appendChild(triExtra);
    }
    triExtra.textContent = ` · wild ${rt.tri.gridPeople().toLocaleString()} · ore ${rt.tri.gridOre().toLocaleString()}`;
  } else if (triExtra) {
    triExtra.remove();
  }

  statsBody.innerHTML = "";
  const dual = lw as CompositionWorld & Partial<Pick<DualWorld, "settlementScalar">>;
  for (const s of lw.sites()) {
    const withTrait = colorTrait ? lw.popOnSiteWithTrait(s.key, colorTrait) : 0;
    const tr = document.createElement("tr");
    const pct = s.pop > 0 ? (withTrait / s.pop) * 100 : 0;
    const settlement = dual.settlementScalar
      ? ` <span class="sub">g ${dual.settlementScalar(s.key, "goods").toFixed(0)} · u ${dual.settlementScalar(s.key, "unrest").toFixed(2)}</span>`
      : "";
    tr.innerHTML =
      `<td>${s.name}${settlement}</td>` +
      `<td>${s.pop.toLocaleString()}</td>` +
      `<td>${withTrait.toLocaleString()} (${pct.toFixed(1)}%)</td>`;
    statsBody.appendChild(tr);
  }

  // Legend.
  legendEl.innerHTML =
    `<span class="chip" style="background:${prevalenceColor(0)}">0%</span>` +
    `<span class="chip" style="background:${prevalenceColor(0.5)}">50%</span>` +
    `<span class="chip" style="background:${prevalenceColor(1)}">100%</span>` +
    `<span class="chip line-solid">route (sheds)</span>` +
    `<span class="chip line-migr">migration</span>` +
    (hasFlow() ? `<span class="chip line-flow">caravans (flow field)</span>` : "");

  const injected = rt.tri ? (rt.tri.harvestedTotal() - rt.harvested0) * rt.tri.peopleScale : 0;
  const checks = runChecks(lw, rt.initialTotal, injected);
  checkList.innerHTML = "";
  for (const c of checks) {
    const li = document.createElement("li");
    li.className = c.ok ? "ok" : "bad";
    li.innerHTML = `<b>${c.ok ? "✓" : "✗"}</b> ${c.label} <span class="detail">${c.detail}</span>`;
    checkList.appendChild(li);
  }
}

/* ------------------------------ run loop ----------------------------- */

async function stepOnce(): Promise<void> {
  if (!rt) return;
  if (rt.tri) await rt.tri.advanceDays(1);
  else await rt.lw.step();
  render();
}

function frame(ts: number): void {
  if (playing && rt) {
    if (lastTs === 0) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    const daysPerSec = parseInt(speedInput.value, 10);
    acc += dt * daysPerSec;
    if (acc >= 1) {
      acc = 0;
      void stepOnce();
    }
  } else {
    lastTs = 0;
  }
  // Tri worlds live at frame rate even while the day clock is paused:
  // the substrate keeps settling (rivers carve, crowds pool, sculpting
  // re-routes drainage) — this is the sandbox merged in.
  if (rt?.tri && pendingCount(rt.tri.grid) > 0) {
    for (let i = 0; i < 8 && pendingCount(rt.tri.grid) > 0; i++) worldStep(rt.tri.grid);
  }
  // Caravans march even while the sim is paused or resting: the flow
  // field is static state, its render is continuous (map only — the
  // panel rebuilds on real steps).
  if (rt?.tri || hasFlow()) render(false);
  requestAnimationFrame(frame);
}

/* --------------------------- sculpting ------------------------------- */
// The sandbox, merged in: the player's motion shapes the landscape, and
// everything downstream — drainage, fertility, crowds, cities — follows.

let sculptTool: "raise" | "dig" | null = null;
let sculpting = false;

function setTool(tool: "raise" | "dig" | null): void {
  sculptTool = sculptTool === tool ? null : tool;
  toolRaise.classList.toggle("active", sculptTool === "raise");
  toolDig.classList.toggle("active", sculptTool === "dig");
}

// Wide brush with a smooth cosine falloff: heights are integers, so the
// rim's fractional deltas round away on a single tap, but a drag reapplies
// the profile and the taper accumulates — bumps, not cliffs, so drainage
// has real gradients to follow.
const BRUSH = { radius: 3.5, strength: 2.5 };

function sculptAt(clientX: number, clientY: number): void {
  const tri = rt?.tri;
  if (!tri || !sculptTool) return;
  if (rt?.geo && rt.geo.pos() < 1) return; // deep time: the brush edits the PRESENT
  const rect = canvas.getBoundingClientRect();
  const tx = Math.floor(((clientX - rect.left) / rect.width) * tri.grid.cols);
  const ty = Math.floor(((clientY - rect.top) / rect.height) * tri.grid.rows);
  const sign = sculptTool === "raise" ? 1 : -1;
  const r = Math.ceil(BRUSH.radius);
  for (let dy = -r; dy <= r; dy++) {
    const y = ty + dy;
    if (y < 0 || y >= tri.grid.rows) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = tx + dx;
      if (x < 0 || x >= tri.grid.cols) continue;
      const d = Math.hypot(dx, dy);
      if (d > BRUSH.radius) continue;
      const falloff = 0.5 * (1 + Math.cos((d / BRUSH.radius) * Math.PI));
      injectTile(tri.grid, y * tri.grid.cols + x, "height", sign * BRUSH.strength * falloff);
    }
  }
}

function initSculpting(): void {
  toolRaise.addEventListener("click", () => setTool("raise"));
  toolDig.addEventListener("click", () => setTool("dig"));
  canvas.addEventListener("pointerdown", e => {
    if (!rt?.tri || !sculptTool) return;
    sculpting = true;
    canvas.setPointerCapture(e.pointerId);
    sculptAt(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointermove", e => {
    if (sculpting) sculptAt(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerup", () => { sculpting = false; });
  canvas.addEventListener("pointercancel", () => { sculpting = false; });
  // No sculpt tool active → a click on a city opens the CITY VIEW (map +
  // books + clickable buildings); its "Walk here" enters the seamless
  // world (step 7).
  canvas.addEventListener("click", e => {
    if (!rt?.tri || sculptTool || zoom || cityView) return;
    const key = cityAt(e.clientX, e.clientY);
    if (key) openCityView(key);
  });
}

/* ---------------------- zoom-in play (step 7) ------------------------ */
// ONE seamless world at ONE scale: click a city to stand in it, then just
// walk — there is no village boundary. Villages stream in as chunks
// around the player (buildings drawn, villagers spawned onto the running
// host) and unload behind them. Recruit by walking up to a villager;
// leaving parks the party at the nearest settlement. The aggregate world
// keeps ticking behind the overlay.
const party = createParty();
let zoom: { host: WorldHost; overlay: HTMLDivElement; park: () => void } | null = null;

function closeZoom(): void {
  if (!zoom) return;
  zoom.park();
  zoom.host.stop();
  zoom.overlay.remove();
  zoom = null;
}

/** Shared overlay scaffold: title bar, play canvas, action foot bar. */
function makeOverlay(titleText: string, hintText: string): {
  overlay: HTMLDivElement; foot: HTMLDivElement; zc: HTMLCanvasElement; ZW: number; ZH: number;
} {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(10,12,20,0.82);display:flex;" +
    "flex-direction:column;align-items:center;justify-content:center;z-index:50;gap:8px";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:12px;align-items:center;color:#f0f0f5;font:600 15px system-ui";
  const title = document.createElement("span");
  title.textContent = titleText;
  const hint = document.createElement("span");
  hint.style.cssText = "font:400 12px system-ui;color:#b9b9c8";
  hint.textContent = hintText;
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕ Leave";
  closeBtn.addEventListener("click", closeZoom);
  bar.append(title, hint, closeBtn);

  const zc = document.createElement("canvas");
  const ZW = Math.min(720, window.innerWidth - 60);
  const ZH = Math.min(520, window.innerHeight - 130);
  zc.style.cssText = `width:${ZW}px;height:${ZH}px;border-radius:10px;background:#000`;

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:10px;min-height:30px;align-items:center;color:#d8d8e2;font:12px system-ui";
  overlay.append(bar, zc, foot);
  document.body.appendChild(overlay);
  return { overlay, foot, zc, ZW, ZH };
}

/* --------------------------- city view mode -------------------------- */
// The settlement inspected (city-view.ts): the town plan as a top-down
// map beside its books — overview, resources, chronicle — with any
// building clickable for its data. Read-only; the sim ticks on behind
// it. "Walk here" drops into the seamless world at the same city.
let cityView: { overlay: HTMLDivElement; stop: () => void } | null = null;

function closeCityView(): void {
  if (!cityView) return;
  cityView.stop();
  cityView.overlay.remove();
  cityView = null;
}

function openCityView(key: string): void {
  if (!rt?.tri || cityView || zoom) return;
  const tri = rt.tri;
  const city = tri.cities.find(c => c.key === key);
  if (!city) return;
  const seed = parseInt(seedInput.value, 10) || 12345;
  const plan = townPlan(tri, key, seed);
  const center = worldPos(city.x, city.y);
  const townGoods = streetGoodsFor(tri, { key, center, plan }, seed);
  const goods = townGoods[0];
  const extras = townGoods.slice(1);

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(10,12,20,0.82);display:flex;" +
    "flex-direction:column;align-items:center;justify-content:center;z-index:50;gap:8px";

  const ov0 = cityOverview(tri, key);
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:12px;align-items:center;color:#f0f0f5;font:600 15px system-ui";
  const title = document.createElement("span");
  title.textContent = `${ov0.name}${ov0.tier ? ` · ${ov0.tier}` : ""}${ov0.civ ? ` · ${ov0.civ.name}` : ""}`;
  if (ov0.civ) title.style.textShadow = `0 0 8px ${ov0.civ.color}`;
  const walkBtn = document.createElement("button");
  walkBtn.textContent = "🚶 Walk here";
  walkBtn.disabled = !!city.dead;
  walkBtn.addEventListener("click", () => { closeCityView(); openWorld(key); });
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕ Close";
  closeBtn.addEventListener("click", closeCityView);
  bar.append(title, walkBtn, closeBtn);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:10px;align-items:stretch";
  const mapC = document.createElement("canvas");
  const MW = Math.max(360, Math.min(560, window.innerWidth - 440));
  const MH = Math.min(540, window.innerHeight - 130);
  mapC.width = MW;
  mapC.height = MH;
  mapC.style.cssText = `width:${MW}px;height:${MH}px;border-radius:10px;background:#000;cursor:crosshair`;
  const panel = document.createElement("div");
  panel.style.cssText =
    `width:330px;max-height:${MH}px;overflow-y:auto;background:rgba(24,27,40,0.95);` +
    "border-radius:10px;padding:12px 14px;color:#d8dae6;font:12px system-ui;line-height:1.55";
  row.append(mapC, panel);
  overlay.append(bar, row);
  document.body.appendChild(overlay);

  // --- Panel scaffold: overview / resources / chronicle / building.
  const head = (t: string): string => `<div style="font:600 12px system-ui;color:#aab4d8;margin:10px 0 2px;text-transform:uppercase;letter-spacing:0.06em">${t}</div>`;
  const overviewDiv = document.createElement("div");
  const resourcesDiv = document.createElement("div");
  const chronHead = document.createElement("div");
  chronHead.innerHTML = head("Chronicle");
  const chronCanvas = document.createElement("canvas");
  chronCanvas.width = 300;
  chronCanvas.height = 56;
  chronCanvas.style.cssText = "width:300px;height:56px;background:rgba(12,14,24,0.7);border-radius:6px";
  const eventsDiv = document.createElement("div");
  const buildingDiv = document.createElement("div");
  panel.append(overviewDiv, resourcesDiv, chronHead, chronCanvas, eventsDiv, buildingDiv);

  const barRow = (label: string, fill: number, detail: string): string => {
    const pct = Math.round(fill * 100);
    return `<div style="display:flex;gap:6px;align-items:center;margin:1px 0">` +
      `<span style="width:52px;color:#aab4d8">${label}</span>` +
      `<span style="flex:1;height:7px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden">` +
      `<span style="display:block;width:${pct}%;height:100%;background:${fill >= 0.95 ? "#5fae6b" : fill >= 0.6 ? "#c9a94e" : "#c96a4e"}"></span></span>` +
      `<span style="width:86px;text-align:right;color:#9aa2bd">${detail}</span></div>`;
  };

  const renderPanel = (): void => {
    const ov = cityOverview(tri, key);
    const status = ov.dead
      ? `<b style="color:#c9a0a0">RUIN</b> — fell day ${ov.dead.day}`
      : `${ov.pop.toLocaleString()} people`;
    const origin = ov.colonyOf
      ? `Colony of <b>${ov.colonyOf}</b>`
      : `Founded on a crowd of ${ov.harvested}`;
    overviewDiv.innerHTML =
      head("Overview") +
      `${status}<br>${origin}` +
      (ov.colonies.length ? `<br>Colonies: ${ov.colonies.join(", ")}` : "") +
      (ov.fauna.length
        ? `<br>${ov.fauna.map(f => `${f.glyph} ${f.name} ${f.count.toLocaleString()}`).join(" · ")}`
        : "");
    resourcesDiv.innerHTML =
      head("Charter") +
      `farmland ${ov.charter.farmland.toFixed(0)} · ore ${ov.charter.ore_access.toFixed(0)} · timber ${ov.charter.timberland.toFixed(0)}` +
      (ov.buildings.length
        ? head("Buildings") + ov.buildings.map(b => `${b.label} ${b.count}`).join(" · ")
        : "") +
      (ov.stockpiles.length
        ? head("Stockpiles") + ov.stockpiles.map(s => `${s.label} ${s.value.toFixed(0)}`).join(" · ")
        : "") +
      (ov.fills.length
        ? head("Supply") + ov.fills.map(f => barRow(f.good, f.fill, `${f.got.toFixed(1)}/${f.need.toFixed(1)}`)).join("")
        : "");
    const chron = cityChronicle(tri, key);
    paintSparkline(chronCanvas.getContext("2d")!, chron, chronCanvas.width, chronCanvas.height);
    eventsDiv.innerHTML = chron.events
      .map(e => `<div style="color:#9aa2bd">day ${e.day} — ${e.label}</div>`)
      .join("");
  };

  let selected: BuildingRef | null = null;
  const renderBuilding = (): void => {
    if (!selected) {
      buildingDiv.innerHTML = head("Building") + `<i style="color:#8a90a8">Click a building on the map for its data.</i>`;
      return;
    }
    const info = buildingInfo(tri, key, plan, goods, selected, nowSeconds(), extras);
    buildingDiv.innerHTML =
      head("Building") +
      `<b>${info.title}</b><br>` +
      info.lines.map(l => (l.startsWith("  ") ? `&nbsp;&nbsp;${l.trim()}` : l)).join("<br>");
  };

  // --- The live map: traffic wear, stock and pantries are clock
  // projections — a gentle repaint keeps them honest without rAF cost.
  const mctx = mapC.getContext("2d")!;
  let xform = { scale: 1, ox: 0, oy: 0 };
  const paint = (): void => {
    xform = paintCityMap(mctx, plan, goods, {
      w: mapC.width, h: mapC.height, selected, extras,
      works: (tri.economy ?? DEFAULT_ECONOMY).works,
    });
  };
  mapC.addEventListener("click", e => {
    const r = mapC.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (mapC.width / r.width);
    const my = (e.clientY - r.top) * (mapC.height / r.height);
    selected = hitTestBuilding(plan, (mx - xform.ox) / xform.scale, (my - xform.oy) / xform.scale);
    renderBuilding();
    paint();
  });

  renderPanel();
  renderBuilding();
  paint();
  const mapTimer = window.setInterval(paint, 400);
  const panelTimer = window.setInterval(renderPanel, 2000);

  cityView = {
    overlay,
    stop: () => {
      window.clearInterval(mapTimer);
      window.clearInterval(panelTimer);
    },
  };
}

const rafFrame = (cb: (nowMs: number) => void): (() => void) => {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
};

function wirePointer(zc: HTMLCanvasElement, host: WorldHost): void {
  zc.addEventListener("pointermove", e => {
    const r = zc.getBoundingClientRect();
    host.setPointer(e.clientX - r.left, e.clientY - r.top);
  });
  zc.addEventListener("pointerleave", () => host.clearPointer());
}

/* ------------- the seamless world (step 7, single scale) ------------- */
// One world, one scale, no village boundary. The whole substrate is the
// manifold; villages STREAM: their buildings and villagers load as the
// player approaches (chunk manager) and unload behind them — villagers
// ride the engine's runtime streaming seam (host.addNpc/removeNpc), so
// the concurrent cast stays under the engine cap while the world holds
// any number of cities. Recruiting swaps the villager NPC for a party
// follower IN PLACE — no reload, the person just falls in behind you.

/** Street-level default view span (meters across the short axis) and the
 *  wheel-zoom range — zoom out to navigate a kilometer-scale world, back
 *  in to walk its streets. */
const SPAN_DEFAULT = 34;
const SPAN_MIN = 22;
const SPAN_MAX = 6000;

function createWorldView(
  zc: HTMLCanvasElement,
  tri: TriWorld,
  names: Map<string, string>,
  chunks: TownManager,
  bands: BandWorld,
): Parameters<typeof runWorldHost>[0]["view"] & { visibleRadius(): number } {
  const vctx = zc.getContext("2d")!;
  const { grid, dual } = tri;
  const buf = document.createElement("canvas");
  buf.width = grid.cols;
  buf.height = grid.rows;
  const bctx = buf.getContext("2d")!;
  const img = bctx.createImageData(grid.cols, grid.rows);
  let viewW = 1, viewH = 1, viewDpr = 1;
  let span = SPAN_DEFAULT;
  let lastCam: { scale: number; offsetX: number; offsetY: number } | null = null;

  // Construction transients (timescales.md §5b): towns BUILD on screen.
  // Houses and works reveal through a tracker (new lots scaffold in, a
  // lot converting to a stall fades through); street shown-length eases
  // toward the grown length (lanes pave outward). Primed at first sight —
  // a town you walk into is already whole.
  const bornB = createRevealTracker(2.4, 1.4);
  const paved = createEasedValues(3.0, 1.5);
  /** Last-seen world-space rects so fade-outs have something to draw. */
  const lastRect = new Map<string, { x: number; y: number; w: number; h: number; color: string }>();
  /** House tint by district character (tier B): the miners' quarter
   *  reads slate, the farm belt reads green-warm. Cached per TownFood
   *  (districts are derived once per plan). */
  const tintCache = new WeakMap<TownFood, Map<number, string | null>>();
  const tintFor = (food: TownFood): Map<number, string | null> => {
    let m = tintCache.get(food);
    if (!m) {
      m = new Map();
      for (const d of food.districts()) {
        const tint = d.kind === "mining" ? "rgba(96,116,150,0.30)"
          : d.kind === "farm" ? "rgba(140,170,60,0.22)"
            : d.kind === "craft" ? "rgba(170,120,70,0.24)" : null;
        for (const hi of d.houseIdx) m.set(hi, tint);
      }
      tintCache.set(food, m);
    }
    return m;
  };

  // Wheel zoom: the world is kilometers wide relative to a walking
  // human — zooming out is how you see where you're going.
  zc.addEventListener("wheel", e => {
    e.preventDefault();
    span = Math.min(SPAN_MAX, Math.max(SPAN_MIN, span * (e.deltaY > 0 ? 1.25 : 0.8)));
  }, { passive: false });

  const camFor = (center: { x: number; y: number }): { scale: number; offsetX: number; offsetY: number } => {
    const scale = Math.min(viewW, viewH) / span;
    return { scale, offsetX: viewW / 2 - center.x * scale, offsetY: viewH / 2 - center.y * scale };
  };
  const cityName = (key: string): string => dual.sites().find(s => s.key === key)?.name ?? key;

  return {
    /** How far from the player the camera can currently see (meters) —
     *  TownManager's pop-in rule: mid-errand spawns inside this radius
     *  relocate into their source building instead of open ground. */
    visibleRadius() {
      return span * 0.75 + 20;
    },
    screenToWorld(px, py) {
      if (!lastCam) return null;
      return { x: (px - lastCam.offsetX) / lastCam.scale, y: (py - lastCam.offsetY) / lastCam.scale };
    },
    render(state) {
      const me = state.avatars["player"];
      const cam = camFor(me ?? { x: (grid.cols * WORLD_TILE) / 2, y: (grid.rows * WORLD_TILE) / 2 });
      lastCam = cam;
      const tNow = performance.now() / 1000;
      vctx.fillStyle = "#0a0c14";
      vctx.fillRect(0, 0, viewW, viewH);

      // Terrain: only the camera's WINDOW of the substrate raster (a
      // real-scale map is far too large to draw whole). At street zoom a
      // tile is a km of ground — smoothing blends the biome borders.
      if (rt?.presenter && rt.tri?.grid === grid) rt.presenter.paint(img, tNow);
      else paintSubstrateImage(grid, img, tNow);
      bctx.putImageData(img, 0, 0);
      const tilePx = WORLD_TILE * cam.scale;
      const tx0 = Math.max(0, Math.floor(-cam.offsetX / tilePx) - 1);
      const ty0 = Math.max(0, Math.floor(-cam.offsetY / tilePx) - 1);
      const tx1 = Math.min(grid.cols, Math.ceil((viewW - cam.offsetX) / tilePx) + 1);
      const ty1 = Math.min(grid.rows, Math.ceil((viewH - cam.offsetY) / tilePx) + 1);
      if (tx1 > tx0 && ty1 > ty0) {
        vctx.imageSmoothingEnabled = tilePx > 48;
        vctx.drawImage(
          buf, tx0, ty0, tx1 - tx0, ty1 - ty0,
          cam.offsetX + tx0 * tilePx, cam.offsetY + ty0 * tilePx,
          (tx1 - tx0) * tilePx, (ty1 - ty0) * tilePx,
        );
        vctx.imageSmoothingEnabled = true;
      }

      // Towns. Street/near zoom: the real plan — fields, houses with
      // walls + door gaps, workshops. Far zoom: markers + names (town
      // DATA streams by distance, but markers never pop — they draw for
      // every city at any range).
      const detailed = cam.scale > 0.5;
      if (detailed) {
        // Reconcile the reveal tracker with EVERYTHING loaded (not just
        // what's on camera — panning must not read as demolition).
        paved.frame(tNow);
        const liveKeys: string[] = [];
        for (const town of chunks.loaded()) {
          for (const h of town.plan.houses) liveKeys.push(`b:${town.key}:h${h.index}`);
          for (const wk of town.plan.works) {
            liveKeys.push(`b:${town.key}:w:${wk.type}:${Math.round(wk.dx)},${Math.round(wk.dy)}`);
          }
          for (const s of town.roads.streets) liveKeys.push(`p:${town.key}:${s.id}`);
        }
        bornB.frame(tNow, liveKeys);
        if (lastRect.size > 4096) {
          const keep = new Set(liveKeys);
          for (const k of lastRect.keys()) if (!keep.has(k)) lastRect.delete(k);
        }

        for (const town of chunks.loaded()) {
          const sx = cam.offsetX + town.center.x * cam.scale;
          const sy = cam.offsetY + town.center.y * cam.scale;
          const ext = (town.plan.radius + 160) * cam.scale;
          if (sx < -ext || sx > viewW + ext || sy < -ext || sy > viewH + ext) continue;
          vctx.fillStyle = "rgba(154,142,58,0.45)";
          for (const f of town.plan.fields) {
            vctx.fillRect(sx + f.dx * cam.scale, sy + f.dy * cam.scale, f.w * cam.scale, f.h * cam.scale);
          }
          // Streets: the plaza and the organic street tree — packed
          // earth under the buildings. Houses FACE these, shoppers'
          // errands ride them, and WIDTH FOLLOWS TRAFFIC: the lanes the
          // food economy actually routes through are visibly worn into
          // arterials (city-development.md §3b). New streets pave
          // outward through the reveal phase; extensions ease.
          const net = town.roads;
          // Wear counts EVERY good's trips — the smithy lane widens too.
          const townTraffics = town.goods.map(g => g.streetTraffic());
          const tripsOn = (id: number): number =>
            townTraffics.reduce((sum, tr) => sum + (tr.get(id) ?? 0), 0);
          vctx.fillStyle = "rgba(203,183,142,0.35)";
          vctx.beginPath();
          vctx.arc(sx, sy, net.plazaR * cam.scale, 0, Math.PI * 2);
          vctx.fill();
          vctx.lineCap = "round";
          vctx.lineJoin = "round";
          for (const s of net.streets) {
            const key = `p:${town.key}:${s.id}`;
            const total = s.cum[s.cum.length - 1];
            const shown = paved.value(key, total) * smooth(bornB.phase(key));
            if (shown <= 0.5) continue;
            const wear = Math.min(1, Math.sqrt(tripsOn(s.id)) / 12);
            vctx.strokeStyle = `rgba(203,183,142,${(0.3 + 0.3 * wear).toFixed(3)})`;
            vctx.lineWidth = Math.max(1, ((s.ring ? 2.8 : s.gen === 0 ? 3.4 : 2.4) + 2.8 * wear) * cam.scale);
            vctx.beginPath();
            vctx.moveTo(sx + s.pts[0].x * cam.scale, sy + s.pts[0].y * cam.scale);
            for (let i = 1; i < s.pts.length; i++) {
              if (s.cum[i] <= shown) {
                vctx.lineTo(sx + s.pts[i].x * cam.scale, sy + s.pts[i].y * cam.scale);
                continue;
              }
              const f = (shown - s.cum[i - 1]) / (s.cum[i] - s.cum[i - 1]);
              if (f > 0) {
                const px = s.pts[i - 1].x + (s.pts[i].x - s.pts[i - 1].x) * f;
                const py = s.pts[i - 1].y + (s.pts[i].y - s.pts[i - 1].y) * f;
                vctx.lineTo(sx + px * cam.scale, sy + py * cam.scale);
              }
              break;
            }
            vctx.stroke();
          }
          // SEE-INSIDE, canvas edition — the same rule as the 3D roof
          // fade: the one footprint the player stands in fades, so its
          // interior (occupants, crates) reads through the roof. Other
          // buildings stay solid roofs.
          const meA = state.avatars["player"];
          const meLx = meA ? meA.x - town.center.x : Infinity;
          const meLy = meA ? meA.y - town.center.y : Infinity;
          const revealed = (r: { dx: number; dy: number; w: number; h: number }): boolean =>
            meLx > r.dx && meLx < r.dx + r.w && meLy > r.dy && meLy < r.dy + r.h;
          for (const h of town.plan.houses) {
            const hx = sx + h.dx * cam.scale;
            const hy = sy + h.dy * cam.scale;
            const hw = h.w * cam.scale;
            const hh = h.h * cam.scale;
            const hKey = `b:${town.key}:h${h.index}`;
            lastRect.set(hKey, {
              x: town.center.x + h.dx, y: town.center.y + h.dy, w: h.w, h: h.h, color: h.color,
            });
            if (hx + hw < 0 || hx > viewW || hy + hh < 0 || hy > viewH) continue;
            const ph = smooth(bornB.phase(hKey));
            // Under construction: the footprint rises from its center —
            // smaller, translucent, scaffold-edged until it settles.
            const g = 0.5 + 0.5 * ph;
            const gx = hx + (hw * (1 - g)) / 2;
            const gy = hy + (hh * (1 - g)) / 2;
            vctx.globalAlpha = (0.35 + 0.65 * ph) * (revealed(h) ? 0.3 : 1);
            vctx.fillStyle = h.color;
            vctx.fillRect(gx, gy, Math.max(1.5, hw * g), Math.max(1.5, hh * g));
            const tint = tintFor(town.food).get(h.index);
            if (tint) {
              vctx.fillStyle = tint;
              vctx.fillRect(gx, gy, Math.max(1.5, hw * g), Math.max(1.5, hh * g));
            }
            if (hw >= 3) {
              vctx.strokeStyle = ph < 1 ? "rgba(224,196,110,0.9)" : "rgba(30,24,16,0.4)";
              vctx.lineWidth = 1;
              vctx.strokeRect(gx, gy, hw * g, hh * g);
            }
            vctx.globalAlpha = 1;
            // FURNITURE, seen through the revealed roof (the shared
            // furniture model — the same pieces the 3D fixtures raise;
            // the goods crates draw below with their live fill).
            if (revealed(h) && cam.scale > 1.4) {
              for (const piece of houseFurniture(town.center, h, [])) {
                if (piece.kind === "chest") continue; // the crates' job
                const fs = piece.radius * 2 * cam.scale;
                const fx = cam.offsetX + (piece.x - piece.radius) * cam.scale;
                const fy = cam.offsetY + (piece.y - piece.radius) * cam.scale;
                vctx.fillStyle = piece.kind === "table" ? "#9a7248" : "#6f4e2f";
                vctx.fillRect(fx, fy, fs, fs);
                vctx.strokeStyle = "rgba(20,16,10,0.6)";
                vctx.lineWidth = 1;
                vctx.strokeRect(fx, fy, fs, fs);
              }
            }
            // The household FOOD BOX (street zoom only): a crate whose
            // green level is the pantry — full at plenty, scraping empty
            // under scarcity or just before a trip. Drawn where the
            // returning shopper's trip ends (pantryBoxAt), and read
            // through the WITNESS overlay: a box the player is looking
            // at fills when the shopper reaches it, never by itself.
            if (cam.scale > 1.4) {
              const crate = (box: { x: number; y: number }, frac: number, fillColor: string): void => {
                const s = 1.1 * cam.scale;
                const bx = cam.offsetX + (box.x - 0.55) * cam.scale;
                const by = cam.offsetY + (box.y - 0.55) * cam.scale;
                vctx.fillStyle = "#5d4630";
                vctx.fillRect(bx, by, s, s);
                if (frac > 0) {
                  vctx.fillStyle = fillColor;
                  vctx.fillRect(bx, by + s * (1 - frac), s, s * frac);
                }
                vctx.strokeStyle = "rgba(20,16,10,0.6)";
                vctx.lineWidth = 1;
                vctx.strokeRect(bx, by, s, s);
              };
              // ONE crate per good the town trades, each in its own
              // corner (slot) on its own clock: pantry green, the rest
              // in their registry stock colors.
              for (let gi = 0; gi < town.goods.length; gi++) {
                const g = town.goods[gi];
                const slot = g.good.slot ?? gi;
                const frac = Math.min(1, chunks.goodBox(town, gi, h, tNow) / g.boxCap);
                crate(goodBoxAt(town.center, h, slot), frac, gi === 0 ? "#7fae4e" : g.good.stockColor ?? "#8b98a8");
              }
            }
          }
          for (let wi = 0; wi < town.plan.works.length; wi++) {
            const wk = town.plan.works[wi];
            const wx = sx + wk.dx * cam.scale;
            const wy = sy + wk.dy * cam.scale;
            const wKey = `b:${town.key}:w:${wk.type}:${Math.round(wk.dx)},${Math.round(wk.dy)}`;
            lastRect.set(wKey, {
              x: town.center.x + wk.dx, y: town.center.y + wk.dy, w: wk.w, h: wk.h, color: wk.color,
            });
            if (wx + wk.w * cam.scale < 0 || wx > viewW || wy + wk.h * cam.scale < 0 || wy > viewH) continue;
            const wph = smooth(bornB.phase(wKey));
            vctx.globalAlpha = (0.35 + 0.65 * wph) * (revealed(wk) ? 0.3 : 1);
            vctx.fillStyle = wk.color;
            vctx.fillRect(wx, wy, wk.w * cam.scale, wk.h * cam.scale);
            vctx.strokeStyle = wph < 1 ? "rgba(224,196,110,0.9)" : "rgba(30,24,16,0.4)";
            vctx.lineWidth = 1;
            vctx.strokeRect(wx, wy, wk.w * cam.scale, wk.h * cam.scale);
            vctx.globalAlpha = 1;
            // Market STANDS: stall tables spread along the door side,
            // each with a little pile of grain sacks. The pile height is
            // the shelf's FRACTION of a full day's stock (stock ÷ what
            // the dawn cart brings), so it drains visibly across the
            // whole day — full at dawn, picked clean by dusk — and a
            // neighborhood stall's smaller shelf reads smaller than the
            // plaza's. Shoppers dwell at these stands (food.ts), so the
            // crowd fans out along the tables instead of piling in a
            // corner.
            const shelfGoods = town.goods.find(g => g.good.shelved.includes(wk.type)) ?? null;
            if (shelfGoods && cam.scale > 0.9) {
              const src = shelfGoods.sources.find(s => s.work === wi);
              const stands = src ? shelfGoods.stands(src) : [];
              const daily = src ? shelfGoods.stallDaily(src) : 0;
              const stock = src ? shelfGoods.stockOf(src, tNow) : 0;
              const frac = daily > 0 ? Math.min(1, stock / (daily * 1.15)) : 0;
              const perStand = Math.round(frac * 4); // 0..4 sacks per table
              for (const st of stands) {
                const tx = sx + (st.x - town.center.x) * cam.scale;
                const ty = sy + (st.y - town.center.y) * cam.scale;
                // The table (the smithy's is its sales counter).
                vctx.fillStyle = "#7a5a3a";
                vctx.fillRect(tx - 1.4 * cam.scale, ty - 0.7 * cam.scale, 2.8 * cam.scale, 1.4 * cam.scale);
                // Its stock, in the good's own color (grain gold, tool
                // steel, whatever new content declares).
                vctx.fillStyle = shelfGoods.good.stockColor ?? "#e0b25c";
                for (let sk = 0; sk < perStand; sk++) {
                  const ox = (sk % 2 - 0.5) * 1.1 * cam.scale;
                  const oy = -(Math.floor(sk / 2)) * 0.9 * cam.scale - 1.1 * cam.scale;
                  vctx.beginPath();
                  vctx.arc(tx + ox, ty + oy, Math.max(1.3, 0.4 * cam.scale), 0, Math.PI * 2);
                  vctx.fill();
                }
              }
            }
          }
          // STREET LIFE at map scale: ambient walkers sampled straight
          // from the traffic field (no identity, no schedule — the §3c
          // dots), riding a time-of-day curve. The zone around the
          // player is left to REAL bodies — dots never stand next to a
          // person you could talk to.
          {
            const me2 = state.avatars["player"];
            const dayFrac = (((tNow % FOOD_DAY_SEC) + FOOD_DAY_SEC) % FOOD_DAY_SEC) / FOOD_DAY_SEC;
            const curve = 0.35 + 0.75 * Math.sin(Math.PI * dayFrac);
            vctx.fillStyle = "rgba(216,168,110,0.85)";
            for (const s of net.streets) {
              const trips = tripsOn(s.id);
              if (trips < 6) continue;
              const total = s.cum[s.cum.length - 1];
              if (total < 20) continue;
              const n = Math.min(5, Math.floor((trips * curve) / 15));
              for (let i = 0; i < n; i++) {
                const h32 = ((s.id * 2654435761) ^ (i * 97897)) >>> 0;
                const dir = h32 & 1 ? 1 : -1;
                const prog = h32 / 4294967296 + (dir * tNow * ERRAND_WALK) / total;
                const at = pointAt(s, (((prog % 1) + 1) % 1) * total);
                const wx = town.center.x + at.x;
                const wy = town.center.y + at.y;
                if (me2 && Math.hypot(wx - me2.x, wy - me2.y) < 80) continue;
                const px2 = cam.offsetX + wx * cam.scale;
                const py2 = cam.offsetY + wy * cam.scale;
                if (px2 < -4 || px2 > viewW + 4 || py2 < -4 || py2 > viewH + 4) continue;
                vctx.beginPath();
                vctx.arc(px2, py2, Math.max(1.2, 0.3 * cam.scale), 0, Math.PI * 2);
                vctx.fill();
              }
            }
          }
          // URBAN WILDLIFE (commensal species, from the registry): the
          // vermin come out when the people go in — the same traffic
          // field, the INVERSE day curve, small dark scurries hugging
          // the lanes. Count scales with the live settlement scalar.
          {
            const dayFrac = (((tNow % FOOD_DAY_SEC) + FOOD_DAY_SEC) % FOOD_DAY_SEC) / FOOD_DAY_SEC;
            const nightCurve = 0.15 + 0.85 * (1 - Math.sin(Math.PI * dayFrac));
            vctx.fillStyle = "rgba(70,62,58,0.9)";
            for (const sp of (rt?.tri?.economy ?? DEFAULT_ECONOMY).species) {
              if (sp.role !== "commensal" || !sp.countScalar) continue;
              const count = tri.dual.settlementScalar(town.key, sp.countScalar);
              if (count < 20) continue;
              for (const s of net.streets) {
                const total = s.cum[s.cum.length - 1];
                if (total < 15) continue;
                const n = Math.min(4, Math.floor((count / 80) * nightCurve));
                for (let i = 0; i < n; i++) {
                  const h32 = ((s.id * 40503) ^ (i * 63689) ^ 0x9e37) >>> 0;
                  const dir = h32 & 2 ? 1 : -1;
                  // Scurry: faster than a stroll, hugging the lane edge.
                  const prog = h32 / 4294967296 + (dir * tNow * 3.2) / total;
                  const at = pointAt(s, (((prog % 1) + 1) % 1) * total);
                  const px2 = cam.offsetX + (town.center.x + at.x + (h32 & 1 ? 1.3 : -1.3)) * cam.scale;
                  const py2 = cam.offsetY + (town.center.y + at.y) * cam.scale;
                  if (px2 < -4 || px2 > viewW + 4 || py2 < -4 || py2 > viewH + 4) continue;
                  vctx.beginPath();
                  vctx.arc(px2, py2, Math.max(0.8, 0.15 * cam.scale), 0, Math.PI * 2);
                  vctx.fill();
                }
              }
            }
          }

          vctx.fillStyle = "#f5f5fa";
          vctx.font = "600 13px system-ui, sans-serif";
          vctx.textAlign = "center";
          vctx.fillText(cityName(town.key), sx, sy - (town.plan.radius + 18) * cam.scale);
        }

        // Demolitions and conversions: whatever just left the plan fades
        // where it stood (a lot turning into a stall crossfades — the
        // house ghost out, the market in).
        for (const e of bornB.exiting()) {
          const r = lastRect.get(e.key);
          if (!r) continue;
          const ex = cam.offsetX + r.x * cam.scale;
          const ey = cam.offsetY + r.y * cam.scale;
          if (ex + r.w * cam.scale < 0 || ex > viewW || ey + r.h * cam.scale < 0 || ey > viewH) continue;
          vctx.globalAlpha = 0.8 * e.phase;
          vctx.fillStyle = r.color;
          vctx.fillRect(ex, ey, Math.max(1.5, r.w * cam.scale), Math.max(1.5, r.h * cam.scale));
          vctx.globalAlpha = 1;
        }
      } else {
        for (const c of tri.cities) {
          const p = worldPos(c.x, c.y);
          const sx = cam.offsetX + p.x * cam.scale;
          const sy = cam.offsetY + p.y * cam.scale;
          if (sx < -40 || sx > viewW + 40 || sy < -40 || sy > viewH + 40) continue;
          vctx.fillStyle = "rgba(245,245,250,0.85)";
          vctx.beginPath();
          vctx.moveTo(sx, sy - 5);
          vctx.lineTo(sx + 5, sy);
          vctx.lineTo(sx, sy + 5);
          vctx.lineTo(sx - 5, sy);
          vctx.closePath();
          vctx.fill();
          vctx.font = "11px system-ui, sans-serif";
          vctx.textAlign = "center";
          vctx.fillText(cityName(c.key), sx, sy - 9);
        }
      }

      // STREAMED structures: the engine's own walls and doors (the same
      // machinery the bounded scenes used — blocking walls, door leaves
      // eased open by whoever walks up). Drawn the way render2d draws
      // them, from state.spec.structures + state.doors.
      vctx.lineCap = "round";
      for (const st of state.spec.structures ?? []) {
        if (st.kind === "stairs") continue; // single-storey towns
        const ax = cam.offsetX + st.a.x * cam.scale;
        const ay = cam.offsetY + st.a.y * cam.scale;
        const bx2 = cam.offsetX + st.b.x * cam.scale;
        const by2 = cam.offsetY + st.b.y * cam.scale;
        if (Math.max(ax, bx2) < 0 || Math.min(ax, bx2) > viewW || Math.max(ay, by2) < 0 || Math.min(ay, by2) > viewH) continue;
        const lw = Math.max(2, st.thickness * cam.scale);
        if (st.kind === "wall") {
          vctx.strokeStyle = st.color ?? "#9ca3af";
          vctx.lineWidth = lw;
          vctx.beginPath();
          vctx.moveTo(ax, ay);
          vctx.lineTo(bx2, by2);
          vctx.stroke();
        } else {
          const open = state.doors[st.id]?.open ?? 0;
          const locked = state.doors[st.id]?.locked ?? false;
          const hinge = st.hinge === "b" ? { x: bx2, y: by2 } : { x: ax, y: ay };
          const other = st.hinge === "b" ? { x: ax, y: ay } : { x: bx2, y: by2 };
          const len = Math.hypot(other.x - hinge.x, other.y - hinge.y);
          const ang = Math.atan2(other.y - hinge.y, other.x - hinge.x) + open * (Math.PI * 0.55);
          vctx.strokeStyle = "rgba(156,163,175,0.4)"; // frame slot
          vctx.lineWidth = lw;
          vctx.beginPath();
          vctx.moveTo(ax, ay);
          vctx.lineTo(bx2, by2);
          vctx.stroke();
          vctx.strokeStyle = locked ? "#7c2d12" : "#b45309"; // the leaf
          vctx.beginPath();
          vctx.moveTo(hinge.x, hinge.y);
          vctx.lineTo(hinge.x + Math.cos(ang) * len, hinge.y + Math.sin(ang) * len);
          vctx.stroke();
        }
      }
      vctx.lineCap = "butt";
      // Traveler bands on the roads: dots at any distance; embodied
      // ones (near the player) are drawn as real avatars instead.
      for (const snap of bands.bands(tNow)) {
        if (snap.embodied) continue;
        const sx = cam.offsetX + snap.x * cam.scale;
        const sy = cam.offsetY + snap.y * cam.scale;
        if (sx < -20 || sx > viewW + 20 || sy < -20 || sy > viewH + 20) continue;
        vctx.fillStyle = "rgba(235,195,90,0.95)";
        for (let j = 0; j < snap.band.members.length; j++) {
          const px = sx - snap.hx * j * 1.4 * cam.scale + snap.hy * (j % 2 ? 1 : -1) * cam.scale;
          const py = sy - snap.hy * j * 1.4 * cam.scale - snap.hx * (j % 2 ? 1 : -1) * cam.scale;
          vctx.beginPath();
          vctx.arc(px, py, Math.min(4, Math.max(2, 0.4 * cam.scale)), 0, Math.PI * 2);
          vctx.fill();
        }
      }

      // Avatars. Residents/travelers only exist near the player; when
      // zoomed far out they'd be sub-pixel clutter, so only the player
      // and party stay marked. Villagers INSIDE a building are hidden
      // (they're indoors — the closed-door abstraction): a fresh spawn
      // in a house or at the market becomes visible when it steps out
      // the door, never by popping onto open ground. The player peeking
      // inside the same building still sees its occupants.
      const playerAt = state.avatars["player"];
      const inRect = (x: number, y: number, r: { dx: number; dy: number; w: number; h: number }): boolean =>
        x > r.dx && x < r.dx + r.w && y > r.dy && y < r.dy + r.h;
      const indoors = (a: { x: number; y: number }): boolean => {
        for (const town of chunks.loaded()) {
          if (Math.abs(a.x - town.center.x) > town.plan.radius + 40) continue;
          if (Math.abs(a.y - town.center.y) > town.plan.radius + 40) continue;
          const lx = a.x - town.center.x;
          const ly = a.y - town.center.y;
          const px = playerAt ? playerAt.x - town.center.x : Infinity;
          const py = playerAt ? playerAt.y - town.center.y : Infinity;
          for (const h of town.plan.houses) {
            if (inRect(lx, ly, h)) return !inRect(px, py, h);
          }
          for (const wk of town.plan.works) {
            if (inRect(lx, ly, wk)) return !inRect(px, py, wk);
          }
        }
        return false;
      };
      for (const id of Object.keys(state.avatars)) {
        const a = state.avatars[id];
        const isParty = id === "player" || id.startsWith("party_");
        if (!detailed && !isParty) continue;
        if (!isParty && id.startsWith("villager_") && indoors(a)) continue;
        const sx = cam.offsetX + a.x * cam.scale;
        const sy = cam.offsetY + a.y * cam.scale;
        const r = Math.max(3.5, 0.45 * cam.scale);
        vctx.beginPath();
        vctx.arc(sx, sy, r, 0, Math.PI * 2);
        vctx.fillStyle = id === "player" ? "#ffd24a" : id.startsWith("party_") ? "#7ec4ff" : "#d8a86e";
        vctx.fill();
        vctx.strokeStyle = "rgba(10,10,20,0.8)";
        vctx.lineWidth = 2;
        vctx.stroke();
        vctx.beginPath();
        vctx.moveTo(sx, sy);
        vctx.lineTo(sx + a.fx * r * 1.6, sy + a.fy * r * 1.6);
        vctx.stroke();
        if (detailed) {
          vctx.fillStyle = "#f0f0f5";
          vctx.font = "11px system-ui, sans-serif";
          vctx.textAlign = "center";
          vctx.fillText(names.get(id) ?? id, sx, sy + r + 12);
        }
      }
    },
    resize(width, height, dpr) {
      viewW = Math.max(1, width);
      viewH = Math.max(1, height);
      viewDpr = dpr || 1;
      zc.width = Math.round(viewW * viewDpr);
      zc.height = Math.round(viewH * viewDpr);
      vctx.setTransform(viewDpr, 0, 0, viewDpr, 0, 0);
    },
    dispose() { /* nothing owned */ },
  };
}

function openWorld(atCity: string): void {
  if (!rt?.tri || zoom) return;
  const tri = rt.tri;
  const seed = parseInt(seedInput.value, 10) || 12345;
  let world: ReturnType<typeof generateWorld>;
  try {
    world = generateWorld(tri, { seed, atCity, party: party.members });
  } catch (err) {
    console.error(err);
    return;
  }

  const { overlay, foot, zc, ZW, ZH } = makeOverlay(
    "The Wide World",
    "point to walk · wheel zooms · houses and people stream in as you travel · ✕ parks the party nearby",
  );
  const names = new Map<string, string>([["player", "You"]]);
  for (const n of world.spec.npcs ?? []) names.set(n.id, n.name ?? n.id);
  const cityName = (key: string): string => tri.dual.sites().find(s => s.key === key)?.name ?? key;

  // One BODY budget, shared: party followers are permanent; villagers
  // (best-ranked street life first) and traveler bands split what
  // remains. STREET_NPCS, not the engine's spec cap — these are pure
  // bodies (no AI session, no network), so the host's runtime cap is
  // raised to match (`maxNpcs` below).
  let bands: BandWorld | null = null;
  // Disbanded party members stay standing as FREED folk until the player
  // walks away — then they melt back into the streaming pool.
  const freed: Array<{ id: string; siteKey: string; index: number }> = [];
  // Last streaming-reconcile tick (seconds) — see onFrame.
  let lastStream = 0;
  const chunks = createTownManager(tri, seed,
    () => STREET_NPCS - party.members.length - freed.length - (bands?.active() ?? 0));
  bands = createTravelerBands(tri, seed,
    () => STREET_NPCS - party.members.length - freed.length - chunks.active());

  let footKey = ""; // rebuild the foot bar only when its content changes
  const renderFoot = (nearVillagerId: string | null): void => {
    const key = `${nearVillagerId ?? ""}|${party.members.length}`;
    if (key === footKey) return;
    footKey = key;
    foot.innerHTML = "";
    if (nearVillagerId) {
      const who = villagerOf(nearVillagerId);
      if (who) {
        const btn = document.createElement("button");
        btn.textContent = `➕ Recruit ${names.get(nearVillagerId) ?? "villager"}`;
        btn.addEventListener("click", () => {
          const fig = recruitVillager(tri, party, who.siteKey, who.index);
          if (!fig) return;
          // Swap the villager body for a follower IN PLACE — no reload.
          const at = host.state.avatars[nearVillagerId];
          host.removeNpc(nearVillagerId);
          chunks.release(nearVillagerId);
          const pid = `party_${fig.id}`;
          host.addNpc({
            id: pid,
            x: at?.x ?? 0,
            y: at?.y ?? 0,
            name: fig.name,
            behavior: { movement: "approach_nearest", conversationRadius: 6 },
          });
          names.set(pid, fig.name);
          footKey = "";
          renderFoot(null);
          render();
        });
        foot.appendChild(btn);
      }
    }
    if (party.members.length) {
      const dis = document.createElement("button");
      dis.textContent = `Disband party (${party.members.length})`;
      dis.addEventListener("click", () => {
        // The people DON'T vanish: each follower body is swapped in
        // place for a freed wanderer tethered right here; they rejoin
        // the aggregate now and the streaming pool once out of sight.
        const spots = party.members.map(m => {
          const at = host.state.avatars[`party_${m.id}`];
          return { m, x: at?.x ?? 0, y: at?.y ?? 0 };
        });
        for (const { m } of spots) host.removeNpc(`party_${m.id}`);
        disbandParty(tri, party);
        for (const { m, x, y } of spots) {
          const id = `freed_${m.id}`;
          if (host.addNpc({
            id, x, y, name: m.name,
            behavior: { movement: "wander", conversationRadius: 5, wanderRadius: 25, speed: ERRAND_WALK },
          })) {
            names.set(id, m.name);
            freed.push({ id, siteKey: m.siteKey, index: m.index });
          }
        }
        footKey = "";
        renderFoot(null);
        render();
      });
      foot.appendChild(dis);
      const tag = document.createElement("span");
      tag.textContent = `party of ${party.members.length} following`;
      foot.appendChild(tag);
    }
  };

  const view = createWorldView(zc, tri, names, chunks, bands);
  const host = runWorldHost({
    view,
    spec: world.spec,
    localId: "player",
    spawnIndex: world.spawnIndexOf.get(atCity) ?? 0,
    hostNpcs: true,
    maxNpcs: STREET_NPCS,
    constraint: terrainConstraint(tri.grid),
    scheduleFrame: rafFrame,
    now: () => performance.now(),
    onFrame: state => {
      const me = state.avatars["player"];
      if (!me) return;
      // Freed folk melt back into the pool once the player is away.
      for (let i = freed.length - 1; i >= 0; i--) {
        const f = freed[i];
        const at = state.avatars[f.id];
        if (!at || Math.hypot(at.x - me.x, at.y - me.y) > PEOPLE_R + 60) {
          host.removeNpc(f.id);
          names.delete(f.id);
          chunks.restore(villagerNpcId(f.siteKey, f.index));
          freed.splice(i, 1);
        }
      }
      // Streaming reconciliation is ~8 Hz work, not per-frame work: the
      // candidate ranking walks every loaded house and costs real
      // milliseconds at city scale, while spawn radii are tens of meters
      // — nothing it decides can change in 16 ms. (The melt-back above
      // stays per-frame: it's a handful of distance checks.)
      const nowS = performance.now() / 1000;
      if (nowS - lastStream < 0.12) return;
      lastStream = nowS;
      // Stream villages around the player through the engine seam —
      // ranked against the host's LIVE bodies (the source of truth).
      const liveMap = new Map<string, { x: number; y: number }>();
      for (const id of Object.keys(state.avatars)) {
        const a = state.avatars[id];
        liveMap.set(id, { x: a.x, y: a.y });
      }
      const delta = chunks.update(me, liveMap, performance.now() / 1000, view.visibleRadius());
      if (delta.buildings) host.setBuildings(delta.buildings);
      for (const o of delta.addObjects ?? []) host.addObject(o);
      for (const id of delta.removeObjects ?? []) host.removeObject(id);
      for (const id of delta.despawn) {
        host.removeNpc(id);
        names.delete(id);
      }
      // A villager's trip ends AT their pantry box — reaching that last
      // waypoint is what fills the crate (the witness TownManager.pantry
      // waits for), however long obstacles and door jams delayed them.
      const shoppingTrip = (id: string, points: Array<{ x: number; y: number; dwell?: number }>): void =>
        host.setNpcErrand(id, {
          points,
          onArrive: i => {
            if (i === points.length - 1) chunks.tripArrived(id, performance.now() / 1000);
          },
        });
      for (const s of delta.spawn) {
        if (host.addNpc(s.npc)) {
          names.set(s.npc.id, s.npc.name ?? s.npc.id);
          // Spawned mid-errand: finish the trip they were already on.
          if (s.walkTo) shoppingTrip(s.npc.id, s.walkTo);
        }
      }
      // Embodied residents whose pantry ran dry head out shopping.
      for (const e of delta.errands) shoppingTrip(e.id, e.points);
      // Traveler bands: embody the nearby ones; walkers get a road
      // errand toward their destination village.
      const bd = bands!.update(me, performance.now() / 1000);
      for (const id of bd.despawn) {
        host.removeNpc(id);
        names.delete(id);
      }
      for (const t of bd.spawn) {
        if (host.addNpc(t.npc)) {
          names.set(t.npc.id, t.npc.name ?? t.npc.id);
          host.setNpcErrand(t.npc.id, { points: [t.walkTo] });
        }
      }
    },
    onNpcProximity: nearby => {
      const near = nearby.find(n => n.npcId.startsWith("villager_"));
      renderFoot(near ? near.npcId : null);
    },
  });
  host.resize(ZW, ZH, window.devicePixelRatio || 1);
  wirePointer(zc, host);
  renderFoot(null);
  host.start();
  zoom = {
    host, overlay,
    // Leaving parks the party at the nearest settlement.
    park: () => {
      const me = host.state.avatars["player"];
      const near = me ? nearestCity(tri, me) : null;
      if (near) parkParty(party, near.key);
    },
  };
}

/** Map click → the city under the pointer (same radii render() draws). */
function cityAt(clientX: number, clientY: number): string | null {
  if (!rt?.tri) return null;
  const rect = canvas.getBoundingClientRect();
  const px = ((clientX - rect.left) / rect.width) * canvas.width;
  const py = ((clientY - rect.top) / rect.height) * canvas.height;
  const sites = rt.lw.sites();
  const maxPop = Math.max(1, ...sites.map(s => s.pop));
  for (const s of sites) {
    const [x, y] = sitePixel(s.key);
    const radius = 18 + 34 * Math.sqrt(s.pop / maxPop);
    if ((px - x) ** 2 + (py - y) ** 2 <= radius * radius) return s.key;
  }
  return null;
}

/* ------------------------------ wiring ------------------------------- */

function initControls(): void {
  for (const s of SCENARIOS) {
    const opt = document.createElement("option");
    opt.value = s.key;
    opt.textContent = s.name;
    scenarioSel.appendChild(opt);
  }
  speedVal.textContent = `${speedInput.value}/s`;

  scenarioSel.addEventListener("change", () => {
    const s = SCENARIOS.find(x => x.key === scenarioSel.value);
    if (s) void loadScenario(s);
  });
  traitSel.addEventListener("change", () => {
    if (rt) { rt.colorTrait = traitSel.value; render(); }
  });
  playBtn.addEventListener("click", () => {
    playing = !playing;
    playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
    lastTs = 0;
  });
  stepBtn.addEventListener("click", () => { playing = false; playBtn.textContent = "▶ Play"; void stepOnce(); });
  civScrub.addEventListener("input", () => {
    if (!rt?.tri) return;
    const frames = rt.tri.historyFrames();
    if (frames < 2) return;
    // Build lazily; rebuild when frames accrued since (playing on while
    // scrubbing re-scales the slider to the grown span).
    if (!rt.civ || rt.civBuiltFrames !== frames) {
      rt.civHist = rt.tri.history() ?? undefined;
      rt.civ = rt.civHist ? createCivScrubber(rt.civHist) : undefined;
      rt.civBuiltFrames = frames;
    }
    rt.civ?.setPos(parseInt(civScrub.value, 10) / 1000);
    render(false);
  });

  geoScrub.addEventListener("input", () => {
    rt?.geo?.setPos(parseInt(geoScrub.value, 10) / 1000);
  });
  resetBtn.addEventListener("click", () => { if (rt) void loadScenario(rt.scenario, rt.colorTrait); });
  speedInput.addEventListener("input", () => { speedVal.textContent = `${speedInput.value}/s`; });
  seedInput.addEventListener("change", () => { if (rt) void loadScenario(rt.scenario, rt.colorTrait); });

  // CUSTOM CONTENT (the developer-mod seam): a WORLD MANIFEST (the
  // engine kernel's document — `engine: "aivota-world"`, ordered packs)
  // or a bare EconomyDoc, told apart by the envelope. Either way the
  // docs parse at the boot gate, dry-run compile against the full
  // standard stack so semantic errors (dangling scalars, missing
  // anchors) surface NOW with the def's name, then the scenario reboots
  // with them. A bad file reports and changes nothing.
  contentFile.addEventListener("change", () => {
    const file = contentFile.files?.[0];
    if (!file) {
      customContent = [];
      contentStatus.textContent = "";
      if (rt) void loadScenario(rt.scenario, rt.colorTrait);
      return;
    }
    void file.text().then(text => {
      try {
        const raw: unknown = JSON.parse(text);
        const docs = isWorldManifest(raw)
          ? docsFor(loadWorldManifest(raw, [ECONOMY_MODULE], file.name), ECONOMY_MODULE)
          : [parseEconomyDoc(raw, file.name)];
        const eco = compileEconomy([CORE_BASE, CORE_GOODS2, CLOTHING, ...docs], { construction: true });
        customContent = docs;
        const added = docs.reduce((a, d) => a + (d.buildings?.length ?? 0), 0);
        contentStatus.textContent =
          `✓ ${file.name} — ${added} building${added === 1 ? "" : "s"}, ${eco.goods.length} street goods total`;
        contentStatus.style.color = "";
        if (rt) void loadScenario(rt.scenario, rt.colorTrait);
      } catch (e) {
        contentStatus.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
        contentStatus.style.color = "#d08080";
      }
    });
  });

  requestAnimationFrame(frame);
}

initControls();
initSculpting();
void loadScenario(SCENARIOS[0]);
