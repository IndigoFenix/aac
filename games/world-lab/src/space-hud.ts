/**
 * Targeting HUD for space flight — a DOM+CSS overlay ported from seagull's
 * object-readout.ts. It anchors to the locked body via world→screen projection:
 * a RING around the body (blue while acquiring, yellow when locked), four
 * cardinal ARROWS that slide inward as the lock builds, and a PREVIEW popup at
 * full lock (a radial-gradient disc tinted by the body's colour + its stats +
 * live distance). No eyegaze dwell / sub-object machinery — just the lock look.
 */
import * as THREE from "three";
import type { CelestialBody } from "@shared/world-engine/space/body";

const RING_MIN_PX = 16;
const RING_MAX_PX = 220;
const ARROW_START_PX = 46; // how far out the arrows start before sliding in

const CSS = `
.shud { position: absolute; inset: 0; pointer-events: none; z-index: 5; overflow: hidden; }
.shud.hidden, .shud .hidden { display: none; }
.shud .or-ring { position: absolute; border: 2px solid hsla(200,90%,65%,0.9); border-radius: 50%;
  box-shadow: 0 0 12px hsla(200,90%,60%,0.4); transition: border-color 180ms ease-out, box-shadow 180ms ease-out; }
.shud .or-ring.locked { border-color: hsla(50,95%,65%,0.95); box-shadow: 0 0 16px hsla(50,95%,55%,0.6); }
.shud .or-arrow { position: absolute; width: 0; height: 0; transform: translate(-50%,-50%);
  transition: filter 180ms ease-out; filter: drop-shadow(0 0 4px hsla(200,90%,60%,0.7)); }
.shud .or-arrow.locked { filter: drop-shadow(0 0 6px hsla(50,95%,55%,0.8)); }
.shud .or-arrow-t { border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 12px solid hsla(200,90%,65%,0.95); }
.shud .or-arrow-r { border-top: 8px solid transparent; border-bottom: 8px solid transparent; border-right: 12px solid hsla(200,90%,65%,0.95); }
.shud .or-arrow-b { border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 12px solid hsla(200,90%,65%,0.95); }
.shud .or-arrow-l { border-top: 8px solid transparent; border-bottom: 8px solid transparent; border-left: 12px solid hsla(200,90%,65%,0.95); }
.shud .or-arrow-t.locked { border-top-color: hsla(50,95%,65%,0.95); }
.shud .or-arrow-r.locked { border-right-color: hsla(50,95%,65%,0.95); }
.shud .or-arrow-b.locked { border-bottom-color: hsla(50,95%,65%,0.95); }
.shud .or-arrow-l.locked { border-left-color: hsla(50,95%,65%,0.95); }
.shud .or-popup { position: absolute; transform-origin: 50% 100%; background: rgba(15,23,42,0.94);
  border: 1px solid hsla(50,95%,65%,0.5); border-radius: 10px; padding: 8px 10px; min-width: 128px;
  font: 11px ui-monospace, Menlo, monospace; color: #f8fafc;
  box-shadow: 0 4px 18px rgba(0,0,0,0.5), 0 0 14px hsla(50,95%,65%,0.18); transition: opacity 120ms ease-out; }
.shud .or-popup.hidden { display: none; }
.shud .or-popup::before { content: ""; position: absolute; left: 50%; bottom: -10px; transform: translateX(-50%);
  width: 0; height: 0; border-left: 9px solid transparent; border-right: 9px solid transparent;
  border-top: 10px solid rgba(15,23,42,0.94); filter: drop-shadow(0 1px 0 hsla(50,95%,65%,0.5)); }
.shud .or-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.shud .or-glyph { width: 40px; height: 40px; border-radius: 50%; flex: 0 0 auto;
  box-shadow: inset -3px -3px 8px rgba(0,0,0,0.5), 0 0 8px rgba(255,255,255,0.15); }
.shud .or-glyph.has-rings { box-shadow: inset -3px -3px 8px rgba(0,0,0,0.5), 0 0 0 3px rgba(255,255,255,0.12), 0 0 8px rgba(255,255,255,0.15); }
.shud .or-name { font-weight: 600; font-size: 12px; color: hsla(50,90%,82%,1); }
.shud .or-sub { font-size: 10px; color: #94a3b8; text-transform: capitalize; }
.shud .or-stats { display: grid; grid-template-columns: auto auto; gap: 1px 10px; color: #cbd5e1; }
.shud .or-stats b { color: #f8fafc; font-weight: 600; }
.shud .or-distance { margin-top: 5px; color: hsla(200,80%,75%,1); }
.shud .or-city { position: absolute; transform: translate(-50%, -130%); white-space: nowrap;
  font: 10px ui-monospace, Menlo, monospace; color: hsla(45,90%,78%,0.95);
  background: rgba(15,23,42,0.72); border: 1px solid hsla(45,90%,65%,0.35); border-radius: 6px;
  padding: 1px 6px; text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
.shud .or-city b { color: #fef3c7; font-weight: 600; }
.shud .or-city.near { border-color: hsla(45,95%,65%,0.85); box-shadow: 0 0 10px hsla(45,95%,55%,0.35); }
`;

function fmtDist(m: number): string {
  const AU = 1.495978707e11, LY = 9.4607e15;
  if (m >= 0.1 * LY) return `${(m / LY).toFixed(2)} ly`;
  if (m >= 0.001 * AU) return `${(m / AU).toFixed(3)} AU`;
  if (m >= 1000) return `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} km`;
  return `${Math.round(m)} m`;
}

function displayColor(b: CelestialBody): string {
  const rp = b.resolvedPhysics;
  if (!rp) return "#889";
  return "#" + (b.type === "star" ? rp.state.color : rp.features.surfaceColor).getHexString();
}

/** Body stat rows for the preview card. */
function stats(b: CelestialBody): Array<[string, string]> {
  const rp = b.resolvedPhysics;
  if (!rp) return [];
  const R_E = 6.371e6;
  const rows: Array<[string, string]> = [
    ["⌀", `${(b.radius / R_E).toFixed(2)} R⊕`],
  ];
  if (b.type === "star") {
    rows.push(["☀", `${rp.state.luminosity.toFixed(2)} L☉`]);
    rows.push(["T", `${Math.round(rp.state.surfaceTemp)} K`]);
  } else {
    rows.push(["T", `${Math.round(rp.features.effectiveSurfaceTempK ?? rp.state.surfaceTemp)} K`]);
    rows.push(["⇩", `${rp.features.terrain.surfaceGravityG.toFixed(2)} g`]);
    const p = rp.features.atmosphere.surfacePressureBar;
    if (p > 0.001) rows.push(["☁", p >= 1 ? `${p.toFixed(1)} bar` : `${p.toFixed(3)} bar`]);
    if (b.hasOcean) rows.push(["💧", "water"]);
  }
  return rows;
}

/** A city chip the HUD labels — world position + whether the player is
 *  within its region (the "you could land here" glow). */
export interface HudCity {
  name: string;
  worldPos: THREE.Vector3;
  /** Unit surface normal at the city in WORLD frame (near-side culling). */
  outward: THREE.Vector3;
  near: boolean;
}

export interface SpaceHud {
  update(p: {
    body: CelestialBody | null;
    lockProgress: number;
    camera: THREE.PerspectiveCamera;
    playerPos: THREE.Vector3;
    canvasW: number;
    canvasH: number;
    dt: number;
    /** Cities to label this frame (host pre-filters to the nearby body). */
    cities?: readonly HudCity[];
  }): void;
  /** Hide/show the whole overlay (a town session covers the flight). */
  setVisible(on: boolean): void;
  dispose(): void;
}

export function createSpaceHud(container: HTMLElement): SpaceHud {
  if (!document.getElementById("shud-css")) {
    const style = document.createElement("style");
    style.id = "shud-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  if (getComputedStyle(container).position === "static") container.style.position = "relative";

  const root = document.createElement("div");
  root.className = "shud";
  // The LOCK cluster (ring + arrows + popup) shows only with a target; city
  // chips live beside it on the same overlay and manage themselves.
  const lock = document.createElement("div");
  lock.className = "hidden";
  root.appendChild(lock);
  const ring = document.createElement("div");
  ring.className = "or-ring";
  lock.appendChild(ring);
  const arrows: HTMLDivElement[] = [];
  for (const dir of ["t", "r", "b", "l"]) {
    const a = document.createElement("div");
    a.className = `or-arrow or-arrow-${dir}`;
    lock.appendChild(a);
    arrows.push(a);
  }
  const popup = document.createElement("div");
  popup.className = "or-popup hidden";
  const head = document.createElement("div");
  head.className = "or-head";
  const glyph = document.createElement("div");
  glyph.className = "or-glyph";
  const nameWrap = document.createElement("div");
  const name = document.createElement("div"); name.className = "or-name";
  const sub = document.createElement("div"); sub.className = "or-sub";
  nameWrap.append(name, sub);
  head.append(glyph, nameWrap);
  const statsEl = document.createElement("div"); statsEl.className = "or-stats";
  const distance = document.createElement("div"); distance.className = "or-distance";
  popup.append(head, statsEl, distance);
  lock.appendChild(popup);
  container.appendChild(root);

  // City chip pool — grown on demand, hidden when unused.
  const chips: HTMLDivElement[] = [];
  const chipFor = (i: number): HTMLDivElement => {
    while (chips.length <= i) {
      const c = document.createElement("div");
      c.className = "or-city hidden";
      root.appendChild(c);
      chips.push(c);
    }
    return chips[i];
  };

  const _proj = new THREE.Vector3();
  const _facing = new THREE.Vector3();
  let displayProgress = 0;
  let popupOpacity = 0;
  let shownId: string | null = null;

  function rebuild(body: CelestialBody): void {
    glyph.style.background = `radial-gradient(circle at 35% 30%, #ffffffcc 0%, transparent 32%), ${displayColor(body)}`;
    glyph.classList.toggle("has-rings", !!body.resolvedPhysics?.features.rings);
    name.textContent = body.id;
    sub.textContent = body.type;
    statsEl.innerHTML = "";
    for (const [k, v] of stats(body)) {
      const key = document.createElement("span"); key.textContent = k;
      const val = document.createElement("b"); val.textContent = v;
      statsEl.append(key, val);
    }
  }

  return {
    update({ body, lockProgress, camera, playerPos, canvasW, canvasH, dt, cities }) {
      // ── City labels (independent of the lock target) ────────────────────
      let used = 0;
      for (const c of cities ?? []) {
        // Far-side cull: the city's outward normal must face the camera.
        _facing.copy(camera.position).sub(c.worldPos);
        if (_facing.dot(c.outward) <= 0) continue;
        _proj.copy(c.worldPos).project(camera);
        if (_proj.z > 1 || _proj.z < -1 || Math.abs(_proj.x) > 1.05 || Math.abs(_proj.y) > 1.05) continue;
        const chip = chipFor(used++);
        chip.classList.remove("hidden");
        chip.classList.toggle("near", c.near);
        chip.innerHTML = `<b>${c.name}</b> · ${fmtDist(playerPos.distanceTo(c.worldPos))}`;
        chip.style.left = `${(_proj.x * 0.5 + 0.5) * canvasW}px`;
        chip.style.top = `${(1 - (_proj.y * 0.5 + 0.5)) * canvasH}px`;
      }
      for (let i = used; i < chips.length; i++) chips[i].classList.add("hidden");

      // ── Lock cluster ─────────────────────────────────────────────────────
      if (!body) { lock.classList.add("hidden"); shownId = null; displayProgress = 0; popupOpacity = 0; return; }
      _proj.copy(body.worldPosition).project(camera);
      if (_proj.z > 1 || _proj.z < -1) { lock.classList.add("hidden"); return; }
      lock.classList.remove("hidden");
      const px = (_proj.x * 0.5 + 0.5) * canvasW;
      const py = (1 - (_proj.y * 0.5 + 0.5)) * canvasH;

      // Ring sized to the body's apparent radius, clamped to a usable band.
      const dist = body.worldPosition.distanceTo(camera.position);
      const safe = Math.max(dist, body.radius * 1.001);
      const angR = Math.asin(Math.min(0.999, body.radius / safe));
      const fovRad = (camera.fov * Math.PI) / 180;
      const apparentR = (angR / (fovRad / 2)) * (canvasH / 2);
      const ringR = Math.max(RING_MIN_PX, Math.min(RING_MAX_PX, apparentR + 12));
      ring.style.cssText = `width:${ringR * 2}px;height:${ringR * 2}px;left:${px - ringR}px;top:${py - ringR}px`;

      const targetProg = Math.min(1, lockProgress);
      displayProgress += (targetProg - displayProgress) * Math.min(1, (targetProg > displayProgress ? 5 : 8) * dt);
      const locked = targetProg >= 0.999;
      ring.classList.toggle("locked", locked);

      const arrowOff = (1 - displayProgress) * ARROW_START_PX;
      const off: Array<[number, number]> = [[0, -(ringR + arrowOff)], [ringR + arrowOff, 0], [0, ringR + arrowOff], [-(ringR + arrowOff), 0]];
      for (let i = 0; i < 4; i++) {
        arrows[i].style.left = `${px + off[i][0]}px`;
        arrows[i].style.top = `${py + off[i][1]}px`;
        arrows[i].classList.toggle("locked", locked);
      }

      if (locked && shownId !== body.id) { rebuild(body); shownId = body.id; }
      popupOpacity += locked ? dt * 5 : -dt * 6;
      popupOpacity = Math.max(0, Math.min(1, popupOpacity));
      popup.classList.toggle("hidden", popupOpacity < 0.01);
      popup.style.opacity = String(popupOpacity);
      popup.style.left = `${px}px`;
      popup.style.top = `${py - ringR}px`;
      popup.style.transform = `translate(-50%, calc(-100% - 14px)) scale(${0.85 + 0.15 * popupOpacity})`;
      distance.textContent = `↗ ${fmtDist(Math.max(0, playerPos.distanceTo(body.worldPosition) - body.radius))}`;
    },
    setVisible(on) { root.classList.toggle("hidden", !on); },
    dispose() { root.remove(); },
  };
}
