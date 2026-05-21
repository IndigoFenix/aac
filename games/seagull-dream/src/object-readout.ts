import * as THREE from "three";
import { READOUT } from "./config";
import type { World } from "./world";
import type { Player, Input } from "./player";
import type { CelestialBody } from "./body";

// Object readout — body-anchored lock visuals + popup property card.
//
// Replaces the legacy crosshair-anchored conic-gradient lock ring. The
// ring is rendered AROUND the candidate body (in screen space via DOM
// overlay, positioned each frame by projecting the body's worldPosition
// through the camera). Four cardinal-direction arrows animate inward
// toward the ring as `lockProgress` builds. At full lock the ring goes
// yellow and a popup card pops up above it with a colored body indicator
// in the middle, symbol icons stacked on the LEFT and RIGHT, a triangle
// pointer at the bottom touching the ring, and a row of direct sub-
// objects beneath it.
//
// Eyegaze-aware behavior:
//   1. While the cursor is INSIDE the popup, the readout reports a
//      "cursor override" — the target body's projected screen pixel —
//      back to the main loop, which feeds it to the player as if the
//      cursor were on the target. This way reading the popup doesn't
//      tilt the bird off-target. (Without this, eyegaze players would
//      drop lock the moment they glance at the popup.)
//   2. Sub-object circles and the parent-up button are dwell-selectable:
//      a hover-for-N-ms timer triggers selection with a visible fill
//      animation. Regular mouse clicks also work.
//
// Dominant-pixel collapse: after the player's lock picker chooses a
// body, we walk up the parent chain. While angular separation between
// the body and its parent (from the player's viewpoint) is less than
// one pixel, the parent is the visually-dominant object and becomes
// the target. Stops once they're distinguishable. Manual dwell-
// selections bypass this so a user can intentionally focus a sub-object
// they couldn't have auto-locked.

// ── Public API ─────────────────────────────────────────────────────────

export interface ObjectReadout {
  /** Per-frame update — projects the focused body to screen, draws ring
   *  + arrows, populates / animates the popup card, runs the dominant-
   *  pixel collapse, advances dwell timers. */
  update(
    player: Player,
    world: World,
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    input: Input,
    dt: number,
  ): void;
  /** When the popup is open and the cursor is over the popup, returns
   *  the projected screen position (in canvas pixels) of the focused
   *  body — main.ts overwrites input.mouseX/mouseY with this so the
   *  bird keeps tracking the target. Returns null otherwise. */
  cursorOverride(): { x: number; y: number } | null;
}

export function createObjectReadout(): ObjectReadout {
  // ── Root container ─────────────────────────────────────────────────
  const root = document.createElement("div");
  root.id = "object-readout";
  root.classList.add("hidden");
  document.body.appendChild(root);

  // Ring around the body.
  const ring = document.createElement("div");
  ring.className = "or-ring";
  root.appendChild(ring);

  // Four cardinal arrows.
  const arrows: HTMLDivElement[] = [];
  for (let i = 0; i < 4; i++) {
    const arrow = document.createElement("div");
    arrow.className = `or-arrow or-arrow-${["t", "r", "b", "l"][i]}`;
    root.appendChild(arrow);
    arrows.push(arrow);
  }

  // Popup card. Layout:
  //   .or-top       — parent-up button (only shown when target has a parent)
  //   .or-main      — left icon column | center glyph | right icon column
  //   .or-distance  — distance line
  //   .or-children  — row of direct sub-object dots
  const popup = document.createElement("div");
  popup.className = "or-popup hidden";
  root.appendChild(popup);

  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.className = "or-up dwell";
  upButton.title = "Parent";
  // Up-arrow glyph (lighter weight; the dwell fill draws over the bg).
  upButton.appendChild(document.createTextNode("▲"));
  popup.appendChild(upButton);

  const main = document.createElement("div");
  main.className = "or-main";
  popup.appendChild(main);

  const leftCol = document.createElement("div");
  leftCol.className = "or-icon-col or-left";
  main.appendChild(leftCol);

  const glyph = document.createElement("div");
  glyph.className = "or-glyph";
  main.appendChild(glyph);

  const rightCol = document.createElement("div");
  rightCol.className = "or-icon-col or-right";
  main.appendChild(rightCol);

  const distance = document.createElement("div");
  distance.className = "or-distance";
  popup.appendChild(distance);

  const children = document.createElement("div");
  children.className = "or-children";
  popup.appendChild(children);

  // ── Reusable temporaries ───────────────────────────────────────────
  const _projTmp = new THREE.Vector3();
  const _bodyVec = new THREE.Vector3();
  const _parentVec = new THREE.Vector3();

  // Animation state.
  let displayProgress = 0;
  /** What the readout is currently presenting data for. May differ from
   *  state.lockedBodyId for one frame after the auto-collapse runs. */
  let displayedBodyId: string | null = null;
  let popupOpacity = 0;
  /** The body the user explicitly dwell-selected. As long as
   *  state.lockedBodyId matches this, we skip the dominant-pixel
   *  collapse — the user has stated their intent. Cleared once the
   *  candidate genuinely changes or the lock drops. */
  let manualTargetId: string | null = null;

  /** Cached screen-projection of the focused body, in canvas pixels.
   *  Written every frame by `update`; read by `cursorOverride()` so the
   *  main loop can decide whether to feed a synthetic cursor to the
   *  player. */
  let lastProjX = 0;
  let lastProjY = 0;
  let lastProjValid = false;
  let cursorInPopup = false;

  // ── Cursor tracking ───────────────────────────────────────────────
  // `cursorInPopup` is updated each frame inside `update` from the
  // popup's bounding rect tested against input.mouseX/Y (handles eyegaze
  // input which doesn't fire DOM hover events) OR `popup.matches(":hover")`
  // (handles real mouse). Either source triggers the override.

  // ── Helpers ────────────────────────────────────────────────────────

  function bodyById(world: World, id: string | null): CelestialBody | null {
    if (!id) return null;
    for (const b of world.bodies) if (b.id === id) return b;
    return null;
  }

  /** Direct children of `body` from `world.bodies` (bodies whose orbit
   *  parent is `body`). Sorted by semiMajor ascending. */
  function directChildren(world: World, body: CelestialBody): CelestialBody[] {
    const out: CelestialBody[] = [];
    for (const b of world.bodies) {
      if (b.orbit && b.orbit.parent === body) out.push(b);
    }
    out.sort((a, b) =>
      (a.orbit?.semiMajorAxis ?? 0) - (b.orbit?.semiMajorAxis ?? 0),
    );
    return out;
  }

  /** Project a world position through the camera. */
  function projectToScreen(
    worldPos: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    canvasW: number,
    canvasH: number,
  ): { x: number; y: number; behind: boolean } {
    _projTmp.copy(worldPos).project(camera);
    const behind = _projTmp.z > 1 || _projTmp.z < -1;
    const x = (_projTmp.x * 0.5 + 0.5) * canvasW;
    const y = (1 - (_projTmp.y * 0.5 + 0.5)) * canvasH;
    return { x, y, behind };
  }

  function apparentPixelRadius(
    body: CelestialBody,
    camera: THREE.PerspectiveCamera,
    canvasH: number,
  ): number {
    const dist = body.worldPosition.distanceTo(camera.position);
    const safe = Math.max(dist, body.radius * 1.001);
    const angularRadius = Math.asin(Math.min(0.999, body.radius / safe));
    const fovRad = (camera.fov * Math.PI) / 180;
    return (angularRadius / (fovRad / 2)) * (canvasH / 2);
  }

  /** Angular separation (radians) between two points as seen from a
   *  vantage. Used by the dominant-pixel collapse — at low angular
   *  separation the two bodies share a pixel from the player's view. */
  function angularSeparation(
    vantage: THREE.Vector3,
    a: THREE.Vector3,
    b: THREE.Vector3,
  ): number {
    _bodyVec.copy(a).sub(vantage);
    _parentVec.copy(b).sub(vantage);
    const lenA = _bodyVec.length();
    const lenB = _parentVec.length();
    if (lenA < 1 || lenB < 1) return 0;
    _bodyVec.divideScalar(lenA);
    _parentVec.divideScalar(lenB);
    const d = Math.max(-1, Math.min(1, _bodyVec.dot(_parentVec)));
    return Math.acos(d);
  }

  /** Walk up the parent chain while body & parent are within ~one
   *  pixel of each other from the player's viewpoint. The parent is
   *  always the visually-dominant object (it contains its child's
   *  pixel), so we keep climbing as long as they overlap. Per the spec
   *  this only uses the orbital hierarchy; unrelated bodies that happen
   *  to overlay aren't considered. */
  function collapseToDominant(
    body: CelestialBody,
    player: Player,
    camera: THREE.PerspectiveCamera,
    canvasH: number,
  ): CelestialBody {
    const fovRad = (camera.fov * Math.PI) / 180;
    const pixelAngle = fovRad / canvasH;
    // A small fudge factor so the collapse triggers a hair before the
    // visual separation reaches exactly one pixel — keeps the transition
    // from feeling jittery at the boundary.
    const threshold = pixelAngle * READOUT.collapsePixelMultiplier;
    let cur = body;
    let safety = 8;
    while (cur.orbit && safety-- > 0) {
      const sep = angularSeparation(
        player.state.position,
        cur.worldPosition,
        cur.orbit.parent.worldPosition,
      );
      if (sep > threshold) break;
      cur = cur.orbit.parent;
    }
    return cur;
  }

  // ── Property icon catalogue ────────────────────────────────────────
  //
  // Pure-symbol set: no text labels, just a unicode glyph in a tile.
  // Each icon has a tooltip via `title` attribute (useful for mouse
  // testing; eyegaze players won't see them but the icons themselves
  // have to be self-explanatory). Slots are filled in priority order:
  // up to 3 icons go on the LEFT side, up to 3 on the RIGHT, total 6.

  interface Icon {
    sym: string;
    title: string;
  }

  function buildIcons(body: CelestialBody): Icon[] {
    const phys = body.resolvedPhysics;
    if (!phys) return [];
    const { state, features } = phys;
    const out: Icon[] = [];

    // Mass — downward arrow as requested
    out.push({ sym: "⤓", title: `Mass: ${formatMass(state.totalMass)}` });

    // Radius — diameter glyph
    out.push({ sym: "⌀", title: `Radius: ${formatRadius(state.radius)}` });

    // Temperature
    const T = features?.effectiveSurfaceTempK ?? state.surfaceTemp;
    if (T > 0) {
      const tempSym = T > 1200 ? "🜂" : T > 350 ? "🌡" : T < 200 ? "❄" : "🌡";
      out.push({ sym: tempSym, title: `Temperature: ${T.toFixed(0)} K` });
    }

    // Stars: luminosity (replaces "atmosphere/pressure" for non-stars)
    if (body.type === "star") {
      out.push({
        sym: "☀",
        title: `Luminosity: ${formatLuminosity(state.luminosity)} L☉`,
      });
    } else if (
      features?.atmosphere.surfacePressureBar &&
      features.atmosphere.surfacePressureBar > 0.001
    ) {
      // Cloud icon for atmospheric pressure
      out.push({
        sym: "☁",
        title: `Atmosphere: ${formatPressure(features.atmosphere.surfacePressureBar)} bar`,
      });
    }

    // Surface gravity (non-stars)
    if (body.type !== "star" && features?.terrain.surfaceGravityG !== undefined) {
      out.push({
        sym: "⇩",
        title: `Surface gravity: ${features.terrain.surfaceGravityG.toFixed(2)} g`,
      });
    }

    // Liquid water
    if (body.hasOcean) {
      out.push({ sym: "💧", title: "Liquid water" });
    }

    // Ice — body is very cold and not a gas giant
    if (
      body.type !== "star" &&
      body.type !== "gas" &&
      T < 200 &&
      (features?.atmosphere.composition !== "h_he")
    ) {
      // Don't double-add — temperature already used ❄ above. Skip.
    }

    // Life (any non-"none" stage)
    if (features?.life.stage && features.life.stage !== "none") {
      out.push({ sym: "❀", title: `Life: ${features.life.stage}` });
    }

    // Rings
    if (features?.rings) {
      out.push({ sym: "◯", title: `Ring system (${features.rings.composition})` });
    }

    // Tidal heating — significant only on Io / Europa class
    if (features?.tidalHeatFlux && features.tidalHeatFlux > 0.5) {
      out.push({ sym: "🜨", title: `Tidal heating: ${features.tidalHeatFlux.toFixed(1)} W/m²` });
    }

    return out.slice(0, 6);
  }

  // ── Formatters (used only in tooltips) ─────────────────────────────

  function formatMass(earths: number): string {
    if (earths >= 1000) return `${(earths / 333000).toFixed(2)} M☉`;
    if (earths >= 100) return `${(earths / 318).toFixed(1)} Mj`;
    if (earths >= 1) return `${earths.toFixed(1)} M⊕`;
    if (earths >= 0.01) return `${earths.toFixed(2)} M⊕`;
    return earths.toExponential(1);
  }

  function formatRadius(earths: number): string {
    if (earths >= 50) return `${(earths / 109).toFixed(2)} R☉`;
    if (earths >= 1) return `${earths.toFixed(2)} R⊕`;
    return `${earths.toFixed(3)} R⊕`;
  }

  function formatLuminosity(L: number): string {
    if (L >= 100) return `${L.toFixed(0)}`;
    if (L >= 1) return `${L.toFixed(1)}`;
    return L.toExponential(1);
  }

  function formatPressure(bar: number): string {
    if (bar >= 10) return bar.toFixed(0);
    if (bar >= 1) return bar.toFixed(1);
    if (bar >= 0.01) return bar.toFixed(2);
    return bar.toExponential(1);
  }

  function formatDistance(m: number): string {
    if (!Number.isFinite(m)) return "—";
    if (m >= 9.46e15) return `${(m / 9.46e15).toFixed(2)} ly`;
    if (m >= 1.496e11) return `${(m / 1.496e11).toFixed(2)} AU`;
    if (m >= 1e9) return `${(m / 1e9).toFixed(2)} Gm`;
    if (m >= 1e6) return `${(m / 1e6).toFixed(2)} Mm`;
    if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
    return `${m.toFixed(0)} m`;
  }

  function bodyDisplayColor(body: CelestialBody): string {
    const phys = body.resolvedPhysics;
    if (phys?.state.color) {
      const c = phys.state.color;
      const boost = body.type === "star" ? 1.0 : 1.4;
      const r = Math.min(1, c.r * boost);
      const g = Math.min(1, c.g * boost);
      const b = Math.min(1, c.b * boost);
      return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    }
    if (body.haloColor) {
      const c = body.haloColor;
      return `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
    }
    return "#94a3b8";
  }

  // ── Dwell-button helper ────────────────────────────────────────────
  //
  // attaches mouseenter/leave/click handlers + a CSS-driven fill
  // overlay. Hovering for `dwellMs` ms fires the handler exactly once;
  // moving out cancels the timer. Used for all popup interactions
  // (sub-object dots, parent-up button) so the readout is fully
  // eyegaze-usable.

  function attachDwell(el: HTMLElement, handler: () => void): void {
    let timer: number | null = null;
    let fillStart = 0;
    let rafHandle: number | null = null;
    const fill = document.createElement("span");
    fill.className = "or-dwell-fill";
    el.appendChild(fill);

    function tick(): void {
      const t = (performance.now() - fillStart) / READOUT.dwellMs;
      fill.style.transform = `scaleY(${Math.min(1, t)})`;
      if (t < 1) rafHandle = requestAnimationFrame(tick);
    }
    function fire(): void {
      cancel();
      // Stale-timer guard: if the popup contents were rebuilt while
      // the timer was pending, the element is orphaned. Refusing to
      // fire prevents (e.g.) a planet dwell from triggering AFTER the
      // user already navigated up to the star.
      if (!el.isConnected) return;
      handler();
    }
    function start(): void {
      if (timer !== null) return;
      fillStart = performance.now();
      fill.style.transform = "scaleY(0)";
      rafHandle = requestAnimationFrame(tick);
      timer = window.setTimeout(fire, READOUT.dwellMs);
    }
    function cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
      fill.style.transform = "scaleY(0)";
    }
    el.addEventListener("mouseenter", start);
    el.addEventListener("mouseleave", cancel);
    el.addEventListener("click", fire);
  }

  // Parent-up button is created once; its handler reads the latest
  // displayed body from the closure-scoped variable each fire.
  let upHandlerTarget: { player: Player; body: CelestialBody } | null = null;
  attachDwell(upButton, () => {
    if (!upHandlerTarget) return;
    const parent = upHandlerTarget.body.orbit?.parent;
    if (!parent) return;
    upHandlerTarget.player.state.lockedBodyId = parent.id;
    upHandlerTarget.player.state.lockProgress = 1;
    manualTargetId = parent.id;
  });

  // ── Per-frame update ───────────────────────────────────────────────

  function update(
    player: Player,
    world: World,
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    input: Input,
    dt: number,
  ): void {
    if (!READOUT.enabled) {
      root.classList.add("hidden");
      displayedBodyId = null;
      displayProgress = 0;
      popupOpacity = 0;
      cursorInPopup = false;
      lastProjValid = false;
      return;
    }

    const state = player.state;
    const lockId = state.lockedBodyId;
    let body = bodyById(world, lockId);

    if (!body || state.lockProgress <= 0) {
      // Lock dropped — fade everything out + clear manual override so
      // a fresh candidate next time gets the collapse treatment again.
      displayProgress = Math.max(0, displayProgress - dt * 4);
      popupOpacity = Math.max(0, popupOpacity - dt * 6);
      if (displayProgress <= 0.01 && popupOpacity <= 0.01) {
        root.classList.add("hidden");
        displayedBodyId = null;
        manualTargetId = null;
      }
      lastProjValid = false;
      cursorInPopup = false;
      return;
    }

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // ── Dominant-pixel collapse ─────────────────────────────────────
    // Skip when the user has manually selected this body (dwell click).
    if (manualTargetId !== body.id) {
      const collapsed = collapseToDominant(body, player, camera, h);
      if (collapsed !== body) {
        // Push the collapsed target into the player's lock state so
        // bird auto-orient + approach cap follow the visually-dominant
        // object. Hysteresis in pickLockCandidate will keep it locked
        // on subsequent frames.
        state.lockedBodyId = collapsed.id;
        body = collapsed;
      }
    }

    // Body change → reset popup fade so the new body's card pops in
    // freshly + clear the manual override unless this body IS the
    // manual override (the dwell-click writes lockedBodyId synchronously
    // before this update runs).
    if (displayedBodyId !== body.id) {
      displayedBodyId = body.id;
      popupOpacity = 0;
      rebuildPopupContent(body);
      rebuildChildren(world, body, player);
      // Toggle the parent-up button's visibility / handler target.
      if (body.orbit) {
        upButton.classList.remove("hidden");
        upHandlerTarget = { player, body };
      } else {
        upButton.classList.add("hidden");
        upHandlerTarget = null;
      }
      // If the new body isn't the one the user manually picked, clear
      // the manual flag so future collapses re-engage.
      if (manualTargetId !== body.id) manualTargetId = null;
    } else {
      // Same target — but children's positions / counts can change
      // over time (active system materializing new moons, etc.). We
      // intentionally don't rebuild every frame — only on focus
      // changes, since material structure rarely changes mid-game.
    }

    const proj = projectToScreen(body.worldPosition, camera, w, h);
    if (proj.behind) {
      root.classList.add("hidden");
      lastProjValid = false;
      cursorInPopup = false;
      return;
    }
    root.classList.remove("hidden");
    lastProjX = proj.x;
    lastProjY = proj.y;
    lastProjValid = true;

    // Ring size — clamp body's apparent radius to a usable px band.
    const apparentR = apparentPixelRadius(body, camera, h);
    const ringR = Math.max(
      READOUT.ringMinPx,
      Math.min(READOUT.ringMaxPx, apparentR + 12),
    );
    const ringD = ringR * 2;
    ring.style.width = `${ringD}px`;
    ring.style.height = `${ringD}px`;
    ring.style.left = `${proj.x - ringR}px`;
    ring.style.top = `${proj.y - ringR}px`;

    const targetProg = Math.min(1, state.lockProgress);
    const progRate = targetProg > displayProgress ? 5 : 8;
    displayProgress += (targetProg - displayProgress) * Math.min(1, progRate * dt);
    const fullyLocked = targetProg >= 0.999;
    ring.classList.toggle("locked", fullyLocked);

    // Arrows: slide inward as displayProgress climbs.
    const arrowOff = (1 - displayProgress) * READOUT.arrowStartPx;
    const arrowOffsets: Array<[number, number]> = [
      [0, -(ringR + arrowOff)],
      [(ringR + arrowOff), 0],
      [0, (ringR + arrowOff)],
      [-(ringR + arrowOff), 0],
    ];
    for (let i = 0; i < 4; i++) {
      const [dx, dy] = arrowOffsets[i];
      arrows[i].style.left = `${proj.x + dx}px`;
      arrows[i].style.top = `${proj.y + dy}px`;
      arrows[i].classList.toggle("locked", fullyLocked);
    }

    // Popup.
    if (fullyLocked) {
      popupOpacity = Math.min(1, popupOpacity + dt * 5);
    } else {
      popupOpacity = Math.max(0, popupOpacity - dt * 6);
    }
    popup.classList.toggle("hidden", popupOpacity < 0.01);
    popup.style.opacity = String(popupOpacity);
    popup.style.left = `${proj.x}px`;
    popup.style.top = `${proj.y - ringR}px`;
    popup.style.transform = `translate(-50%, calc(-100% - 14px)) scale(${0.85 + 0.15 * popupOpacity})`;

    // Distance — live update every frame.
    const dist = state.position.distanceTo(body.worldPosition) - body.radius;
    distance.textContent = `↗ ${formatDistance(Math.max(0, dist))}`;

    // ── Cursor-in-popup detection ───────────────────────────────────
    // We compute the answer fresh each frame from input.mouseX/Y vs
    // the popup's bounding rect. The mouseenter/leave DOM events
    // (registered in the closure scope above) ALSO matter — they fire
    // when a real mouse cursor crosses the popup, which can happen at
    // sub-frame timing — but the per-frame rect test below is the
    // authoritative source for eyegaze input that doesn't fire DOM
    // events. We OR the two: in-popup if either source says so.
    if (popupOpacity > 0.5) {
      const rect = popup.getBoundingClientRect();
      const cx = input.mouseX * w;
      const cy = input.mouseY * h;
      const insideByGaze =
        cx >= rect.left && cx <= rect.right &&
        cy >= rect.top && cy <= rect.bottom;
      const insideByHover = popup.matches(":hover");
      cursorInPopup = insideByGaze || insideByHover;
    } else {
      cursorInPopup = false;
    }
    popup.classList.toggle("active", cursorInPopup);
  }

  function rebuildPopupContent(body: CelestialBody): void {
    glyph.style.background = `radial-gradient(circle at 35% 30%, #fff8 0%, transparent 30%), ${bodyDisplayColor(body)}`;
    const hasRings = !!body.resolvedPhysics?.features.rings;
    glyph.classList.toggle("has-rings", hasRings);

    const icons = buildIcons(body);
    leftCol.innerHTML = "";
    rightCol.innerHTML = "";
    // Split: first ceil(n/2) icons left, rest right. Left column reads
    // top-to-bottom, right column reads top-to-bottom.
    const half = Math.ceil(icons.length / 2);
    for (let i = 0; i < icons.length; i++) {
      const col = i < half ? leftCol : rightCol;
      const tile = document.createElement("div");
      tile.className = "or-icon";
      tile.title = icons[i].title;
      tile.textContent = icons[i].sym;
      col.appendChild(tile);
    }
  }

  function rebuildChildren(world: World, body: CelestialBody, player: Player): void {
    children.innerHTML = "";
    const kids = directChildren(world, body);
    if (kids.length === 0) {
      children.classList.add("empty");
      return;
    }
    children.classList.remove("empty");
    for (const kid of kids) {
      const node = document.createElement("button");
      node.className = "or-child dwell";
      node.type = "button";
      node.title = kid.id;
      const dot = document.createElement("span");
      dot.className = "or-child-dot";
      dot.style.background = bodyDisplayColor(kid);
      node.appendChild(dot);
      attachDwell(node, () => {
        player.state.lockedBodyId = kid.id;
        player.state.lockProgress = 1;
        manualTargetId = kid.id;
      });
      children.appendChild(node);
    }
  }

  function cursorOverride(): { x: number; y: number } | null {
    if (!READOUT.enabled) return null;
    if (!cursorInPopup) return null;
    if (!lastProjValid) return null;
    return { x: lastProjX, y: lastProjY };
  }

  return { update, cursorOverride };
}
