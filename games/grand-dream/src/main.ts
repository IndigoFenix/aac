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
import { WORLD_MAX_NPCS } from "@shared/world-engine/index";
import { bootLab, type LabWorld } from "./boot";
import { bootDual, type DualWorld } from "./dual";
import type { TriWorld } from "./tri";
import { SCENARIOS, cloneScenarioJson, type LabScenario } from "./scenarios";
import { runChecks } from "./checks";
import { paintSubstrateImage } from "./substrate-render";
import { createTravelerBands, type BandWorld } from "./traveler-bands";
import { ERRAND_WALK, PANTRY_CAP } from "./food";
import {
  PEOPLE_R, WORLD_TILE, createParty, createTownManager, disbandParty, generateWorld,
  nearestCity, parkParty, recruitVillager, terrainConstraint, villagerNpcId, villagerOf,
  worldPos, type TownManager,
} from "./zoom";

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
const dayEl = $("day");
const totalPopEl = $("totalpop");
const sculptTools = $("sculpt-tools");
const toolRaise = $<HTMLButtonElement>("tool-raise");
const toolDig = $<HTMLButtonElement>("tool-dig");
const statsBody = $("stats").querySelector("tbody")!;
const traitHead = $("stat-trait-head");
const legendEl = $("legend");
const checkList = $("check-list");

interface Runtime {
  scenario: LabScenario;
  lw: LabWorld;
  initialTotal: number;
  colorTrait: string;
  /** Site key → normalized [x, y]: the scenario's layout, or (tri) the
   *  cities' substrate tile positions. */
  layout: Record<string, [number, number]>;
  /** Tri scenarios only: the coupled three-layer world + a pixel buffer
   *  for painting the substrate behind the graph. */
  tri?: TriWorld;
  triCanvas?: HTMLCanvasElement;
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

/* --------------------------- scenario boot --------------------------- */

async function loadScenario(scenario: LabScenario, colorTrait?: string): Promise<void> {
  playing = false;
  playBtn.textContent = "▶ Play";
  closeZoom(); // the party's histfigs belong to the old world instance
  party.members = [];
  party.parkedAt = null;
  const seed = parseInt(seedInput.value, 10) || 12345;

  let lw: LabWorld;
  let tri: TriWorld | undefined;
  if (scenario.tri) {
    const world = await scenario.tri(seed);
    tri = world.tri;
    lw = tri.dual;
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
    day0: lw.day(), harvested0: tri ? tri.harvestedTotal() : 0,
  };
  sculptTools.style.display = tri ? "" : "none";

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
  paintSubstrateImage(tri.grid, img, performance.now() / 1000);
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
  const flowOf = (lw as LabWorld & Partial<Pick<DualWorld, "settlementFlow">>).settlementFlow;
  const now = performance.now();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  paintSubstrate();

  // Routes first (under the nodes). Route order matches the dual spec's
  // edge order, so index e addresses the flow field directly.
  const routes = lw.routes();
  for (let e = 0; e < routes.length; e++) {
    const r = routes[e];
    if (!r.site_a || !r.site_b) continue;
    const [ax, ay] = sitePixel(r.site_a.key);
    const [bx, by] = sitePixel(r.site_b.key);
    const migrates = r.migration > 0;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineWidth = 1.5 + r.strength * 2.5;
    ctx.strokeStyle = migrates ? "rgba(120,200,140,0.7)" : "rgba(150,150,170,0.55)";
    if (migrates && r.strength === 0) ctx.setLineDash([6, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Caravans: a marching-dash render of the steady-state flow field
    // (§4c) — the world can be at rest while these keep moving, because
    // they are drawn FROM state, not simulated INTO it.
    const flow = flowOf ? flowOf(e) : 0;
    if (Math.abs(flow) > 1e-9) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineWidth = 2 + Math.min(4, Math.abs(flow) * 0.12);
      ctx.strokeStyle = "rgba(235,195,90,0.85)";
      ctx.setLineDash([5, 11]);
      const speed = Math.min(60, 8 + Math.abs(flow) * 1.5); // px/s, scales with volume
      ctx.lineDashOffset = -Math.sign(flow) * (((now / 1000) * speed) % 16);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Route label at the midpoint.
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

  // Nodes.
  const civOf = (lw as LabWorld & Partial<Pick<DualWorld, "civOf">>).civOf;
  const sites = lw.sites();
  const maxPop = Math.max(1, ...sites.map(s => s.pop));
  for (const s of sites) {
    const [x, y] = sitePixel(s.key);
    const radius = 18 + 34 * Math.sqrt(s.pop / maxPop);
    const withTrait = colorTrait ? lw.popOnSiteWithTrait(s.key, colorTrait) : 0;
    const frac = s.pop > 0 ? withTrait / s.pop : 0;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = prevalenceColor(frac);
    ctx.fill();
    // Ring color = majority civ (membership trait), white when civless.
    const civ = civOf ? civOf(s.key) : null;
    ctx.lineWidth = civ ? 3.5 : 2;
    ctx.strokeStyle = civ ? civ.color : "rgba(255,255,255,0.85)";
    ctx.stroke();

    ctx.fillStyle = "#f5f5fa";
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(s.name, x, y + radius + 15);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(230,230,240,0.8)";
    ctx.fillText(`${(frac * 100).toFixed(1)}%`, x, y + 4);
  }

  if (panelToo) renderPanel();
}

/** True when the loaded world exposes a nonzero steady-state flow field —
 *  drives the continuous caravan animation. */
function hasFlow(): boolean {
  if (!rt) return false;
  const flowOf = (rt.lw as LabWorld & Partial<Pick<DualWorld, "settlementFlow">>).settlementFlow;
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
  const dual = lw as LabWorld & Partial<Pick<DualWorld, "settlementScalar">>;
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
  // No sculpt tool active → a click on a city zooms in (step 7).
  canvas.addEventListener("click", e => {
    if (!rt?.tri || sculptTool || zoom) return;
    const key = cityAt(e.clientX, e.clientY);
    if (key) openWorld(key);
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
): Parameters<typeof runWorldHost>[0]["view"] {
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
      paintSubstrateImage(grid, img, tNow);
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
        for (const town of chunks.loaded()) {
          const sx = cam.offsetX + town.center.x * cam.scale;
          const sy = cam.offsetY + town.center.y * cam.scale;
          const ext = (town.plan.radius + 160) * cam.scale;
          if (sx < -ext || sx > viewW + ext || sy < -ext || sy > viewH + ext) continue;
          vctx.fillStyle = "rgba(154,142,58,0.45)";
          for (const f of town.plan.fields) {
            vctx.fillRect(sx + f.dx * cam.scale, sy + f.dy * cam.scale, f.w * cam.scale, f.h * cam.scale);
          }
          // Streets: plaza disc, ring roads, and the four cross-street
          // spokes — packed earth under the buildings. Houses FACE
          // these, and shoppers' errands ride them.
          const roads = town.roads;
          vctx.fillStyle = "rgba(203,183,142,0.35)";
          vctx.beginPath();
          vctx.arc(sx, sy, roads.rings[0] * cam.scale, 0, Math.PI * 2);
          vctx.fill();
          vctx.strokeStyle = "rgba(203,183,142,0.5)";
          vctx.lineWidth = Math.max(1, 5 * cam.scale);
          for (const R of roads.rings) {
            vctx.beginPath();
            vctx.arc(sx, sy, R * cam.scale, 0, Math.PI * 2);
            vctx.stroke();
          }
          vctx.lineWidth = Math.max(1, 8 * cam.scale);
          vctx.beginPath();
          for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
            vctx.moveTo(sx + ux * roads.rings[0] * cam.scale, sy + uy * roads.rings[0] * cam.scale);
            vctx.lineTo(sx + ux * roads.spokeMax * cam.scale, sy + uy * roads.spokeMax * cam.scale);
          }
          vctx.stroke();
          for (const h of town.plan.houses) {
            const hx = sx + h.dx * cam.scale;
            const hy = sy + h.dy * cam.scale;
            const hw = h.w * cam.scale;
            const hh = h.h * cam.scale;
            if (hx + hw < 0 || hx > viewW || hy + hh < 0 || hy > viewH) continue;
            vctx.fillStyle = h.color;
            vctx.fillRect(hx, hy, Math.max(1.5, hw), Math.max(1.5, hh));
            if (hw >= 3) {
              vctx.strokeStyle = "rgba(30,24,16,0.4)";
              vctx.lineWidth = 1;
              vctx.strokeRect(hx, hy, hw, hh);
            }
            // The household FOOD BOX (street zoom only): a crate by the
            // door whose green level is the pantry — full at plenty,
            // scraping empty under scarcity or just before a trip.
            if (cam.scale > 1.4) {
              const frac = Math.min(1, town.food.pantry(h, tNow) / PANTRY_CAP);
              const s = 1.1 * cam.scale;
              const bx = hx + 1.2 * cam.scale;
              const by = hy + hh - s - 1.2 * cam.scale;
              vctx.fillStyle = "#5d4630";
              vctx.fillRect(bx, by, s, s);
              if (frac > 0) {
                vctx.fillStyle = "#7fae4e";
                vctx.fillRect(bx, by + s * (1 - frac), s, s * frac);
              }
              vctx.strokeStyle = "rgba(20,16,10,0.6)";
              vctx.lineWidth = 1;
              vctx.strokeRect(bx, by, s, s);
            }
          }
          for (const wk of town.plan.works) {
            const wx = sx + wk.dx * cam.scale;
            const wy = sy + wk.dy * cam.scale;
            if (wx + wk.w * cam.scale < 0 || wx > viewW || wy + wk.h * cam.scale < 0 || wy > viewH) continue;
            vctx.fillStyle = wk.color;
            vctx.fillRect(wx, wy, wk.w * cam.scale, wk.h * cam.scale);
            vctx.strokeStyle = "rgba(30,24,16,0.4)";
            vctx.lineWidth = 1;
            vctx.strokeRect(wx, wy, wk.w * cam.scale, wk.h * cam.scale);
            // Market stalls: grain sacks out front, one per ~2 days of a
            // household's draw — the row visibly thins as the day wears
            // on (and starts thin at all when the flow net under-fed).
            if (wk.type === "market" && cam.scale > 0.9) {
              const sacks = Math.min(10, Math.round(town.food.marketStock(tNow) / (PANTRY_CAP / 2)));
              const doorY = wy - 1.6 * cam.scale;
              vctx.fillStyle = "#e0b25c";
              for (let sk = 0; sk < sacks; sk++) {
                vctx.beginPath();
                vctx.arc(wx + (2 + sk * 1.3) * cam.scale, doorY, Math.max(1.5, 0.45 * cam.scale), 0, Math.PI * 2);
                vctx.fill();
              }
            }
          }
          vctx.fillStyle = "#f5f5fa";
          vctx.font = "600 13px system-ui, sans-serif";
          vctx.textAlign = "center";
          vctx.fillText(cityName(town.key), sx, sy - (town.plan.radius + 18) * cam.scale);
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
      // and party stay marked.
      for (const id of Object.keys(state.avatars)) {
        const a = state.avatars[id];
        const isParty = id === "player" || id.startsWith("party_");
        if (!detailed && !isParty) continue;
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

  // One NPC budget, shared: party followers are permanent; villagers
  // (nearest village first) and traveler bands split what remains.
  let bands: BandWorld | null = null;
  // Disbanded party members stay standing as FREED folk until the player
  // walks away — then they melt back into the streaming pool.
  const freed: Array<{ id: string; siteKey: string; index: number }> = [];
  const chunks = createTownManager(tri, seed,
    () => WORLD_MAX_NPCS - party.members.length - freed.length - (bands?.active() ?? 0));
  bands = createTravelerBands(tri, seed,
    () => WORLD_MAX_NPCS - party.members.length - freed.length - chunks.active());

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

  const host = runWorldHost({
    view: createWorldView(zc, tri, names, chunks, bands),
    spec: world.spec,
    localId: "player",
    spawnIndex: world.spawnIndexOf.get(atCity) ?? 0,
    hostNpcs: true,
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
      // Stream villages around the player through the engine seam —
      // ranked against the host's LIVE bodies (the source of truth).
      const liveMap = new Map<string, { x: number; y: number }>();
      for (const id of Object.keys(state.avatars)) {
        const a = state.avatars[id];
        liveMap.set(id, { x: a.x, y: a.y });
      }
      const delta = chunks.update(me, liveMap, performance.now() / 1000);
      if (delta.structures) host.setStructures(delta.structures);
      for (const id of delta.despawn) {
        host.removeNpc(id);
        names.delete(id);
      }
      for (const s of delta.spawn) {
        if (host.addNpc(s.npc)) {
          names.set(s.npc.id, s.npc.name ?? s.npc.id);
          // Spawned mid-errand: finish the trip they were already on.
          if (s.walkTo) host.setNpcErrand(s.npc.id, { points: s.walkTo });
        }
      }
      // Embodied residents whose pantry ran dry head out shopping.
      for (const e of delta.errands) host.setNpcErrand(e.id, { points: e.points });
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
  resetBtn.addEventListener("click", () => { if (rt) void loadScenario(rt.scenario, rt.colorTrait); });
  speedInput.addEventListener("input", () => { speedVal.textContent = `${speedInput.value}/s`; });
  seedInput.addEventListener("change", () => { if (rt) void loadScenario(rt.scenario, rt.colorTrait); });

  requestAnimationFrame(frame);
}

initControls();
initSculpting();
void loadScenario(SCENARIOS[0]);
