// games/world-lab/src/camera-panel.ts
//
// 🎥 THE CAMERA SECTION — the held orbit's pose, tuned by eye (user ruling C1,
// 2026-09-06: *"I want to do some tests to see what angle and distance actually
// look good"*).
//
// Four sliders over the ONE pose record (`shared/world-engine/spirit/orbit-pose.ts`),
// a live readout of what that pose actually puts on screen, and a "print
// constants" button that emits the record as the TypeScript to BAKE. The
// sliders are DEBUG ONLY and the override is persisted per browser; with
// nothing overridden the ladder runs the shipped defaults byte-identically.
//
// WHY A SEPARATE MODULE: main.ts already owns the ⏩/🌳 toolbar buttons and is
// 6.8k lines; this section owns its own DOM, its own state and its own
// arithmetic, and reaches the world only through the `info()` callback main.ts
// hands it (one owner per file — nothing here touches the scene graph).

import {
  ORBIT_POSE_DEFAULTS,
  orbitPose,
  orbitPoseOverridden,
  resetOrbitPose,
  setOrbitPose,
  type OrbitPose,
} from "@shared/world-engine/spirit/orbit-pose";
import {
  TIER_REF_BODY_M,
  projectedFraction,
  seedTierForProjected,
} from "@shared/world-engine/creatures/view-tiers";

/** WHAT THE LAB KNOWS ABOUT THE LIVE FRAME, asked once per readout tick. Every
 *  field may be null before a town mounts — the panel still works (it falls
 *  back to the founding ring so the sliders can be felt out on a cold boot). */
export interface CameraFrameInfo {
  /** The sim's relevance-ring radius in metres (`host.nearStand()`), which is
   *  what the held orbit frames. Null = no live town. */
  ringM: number | null;
  /** The camera's VERTICAL field of view, degrees (THREE's own convention). */
  fovDeg: number;
  /** Viewport height in pixels — the readout quotes the fraction in px too. */
  viewportH: number;
  /** Is the builder hold on (i.e. is the ring really the frame right now)? */
  held: boolean;
  /** MEASURED, not derived: camera→focus distance and its horizontal/vertical
   *  split in the live town's anchor-local frame. Null when no driver has fed
   *  one this frame. This is the honest cross-check on the derivation. */
  measured: { distM: number; outM: number; upM: number } | null;
}

/** The founding's ring (`NEAR_STAND_BASE_M`) — the stand-in when nothing is
 *  mounted yet, so the numbers on screen are never blank. */
const RING_FALLBACK_M = 30;
/** A mature oak (`products.ts` `bodyHeightM`). The second readout row: trees
 *  are half of what the LOD complaint was about, and a 23.8 m body is exactly
 *  the case metre-banding got wrong. */
const TREE_BODY_M = 23.8;

interface SliderSpec {
  key: keyof OrbitPose;
  label: string;
  min: number;
  max: number;
  step: number;
  /** How the value reads to a human (the raw number is always shown too). */
  hint: string;
}

const SLIDERS: readonly SliderSpec[] = [
  { key: "pitchRad", label: "pitch", min: 0.05, max: 1.5, step: 0.01,
    hint: "radians above the horizon · 0 = level with the ground, 1.57 = straight down. Moves the camera along an arc — it never changes the distance to the focus, so it cannot move an LOD tier." },
  { key: "frameFactor", label: "frame", min: 0.2, max: 2.5, step: 0.01,
    hint: "stand-off × the frame's own fov-fitting distance. 1 = the frame radius exactly fills the vertical fov; smaller = closer." },
  { key: "liftFrac", label: "lift", min: 0, max: 1.5, step: 0.01,
    hint: "look-at height above the focus, as a fraction of the frame radius — tilts the shot without moving the camera." },
  { key: "ringFrameFactor", label: "ring", min: 0.2, max: 2.5, step: 0.01,
    hint: "frame radius ÷ the relevance ring. 1 = the circle IS the outer camera bound (the 2026-09-05 ruling)." },
];

const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, css = "") => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  parent.appendChild(n);
  return n;
};

export interface CameraPanel {
  /** Push a readout tick (main.ts calls this a few times a second). */
  refresh(info: CameraFrameInfo): void;
  dispose(): void;
}

/**
 * Mount the 🎥 Camera button after `anchor` and its slider popover in `parent`.
 * `info()` is asked only while the panel is OPEN — a closed panel costs nothing.
 */
export function mountCameraPanel(anchor: HTMLElement, parent: HTMLElement): CameraPanel {
  const btn = document.createElement("button");
  btn.id = "camera-pose";
  btn.type = "button";
  btn.textContent = "🎥 Camera";
  btn.title =
    "DEBUG: the held district orbit's pose — pitch, stand-off, look-at lift and the ring-to-frame " +
    "ratio — as live sliders (persisted per browser). Tune by eye, then 'print constants' and bake " +
    "the block into shared/world-engine/spirit/orbit-pose.ts. Console: globalThis.__orbitPose.";
  btn.setAttribute("aria-pressed", "false");
  anchor.insertAdjacentElement("afterend", btn);

  const panel = mk("div", parent,
    "position:fixed;right:12px;top:52px;z-index:40;width:330px;padding:10px 12px;" +
    "background:#11151c;border:1px solid #2b3444;border-radius:8px;color:#c9d3e3;" +
    "font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;box-shadow:0 6px 24px #0008;display:none");

  mk("div", panel, "font-weight:600;color:#e6edf7;margin-bottom:6px").textContent =
    "🎥 held-orbit pose";

  const rows = new Map<keyof OrbitPose, { input: HTMLInputElement; val: HTMLElement }>();
  for (const s of SLIDERS) {
    const row = mk("div", panel, "margin:6px 0");
    const head = mk("div", row, "display:flex;justify-content:space-between;align-items:baseline");
    const lab = mk("span", head, "color:#9fb0c9");
    lab.textContent = s.label;
    lab.title = s.hint;
    const val = mk("span", head, "font-variant-numeric:tabular-nums;color:#e6edf7");
    const input = mk("input", row, "width:100%;margin:2px 0 0") as HTMLInputElement;
    input.type = "range";
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.title = s.hint;
    input.addEventListener("input", () => {
      setOrbitPose({ [s.key]: Number(input.value) } as Partial<OrbitPose>);
      paint();
    });
    rows.set(s.key, { input, val });
  }

  const readEl = mk("pre", panel,
    "margin:8px 0 6px;padding:6px 8px;background:#0b0e13;border-radius:6px;white-space:pre-wrap;" +
    "color:#8fb8e8;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace");

  const btnRow = mk("div", panel, "display:flex;gap:6px");
  const printBtn = mk("button", btnRow, "flex:1") as HTMLButtonElement;
  printBtn.type = "button";
  printBtn.textContent = "print constants";
  printBtn.title = "Emit this pose as the TypeScript block to bake into ORBIT_POSE_DEFAULTS " +
    "(console + the box below + the clipboard where the browser allows it).";
  const resetBtn = mk("button", btnRow, "flex:0 0 auto") as HTMLButtonElement;
  resetBtn.type = "button";
  resetBtn.textContent = "reset";
  resetBtn.title = "Drop every override — back to the shipped defaults.";

  const outEl = mk("pre", panel,
    "margin:6px 0 0;padding:6px 8px;background:#0b0e13;border-radius:6px;white-space:pre;" +
    "overflow:auto;max-height:150px;color:#a7e0a0;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;display:none");

  /** The block to BAKE — the whole point of the round: the eye picks the
   *  numbers, and these four lines are what ships. */
  const constantsBlock = (p: OrbitPose): string =>
    "export const ORBIT_POSE_DEFAULTS: Readonly<OrbitPose> = {\n" +
    `  pitchRad: ${+p.pitchRad.toFixed(4)},\n` +
    `  frameFactor: ${+p.frameFactor.toFixed(4)},\n` +
    `  liftFrac: ${+p.liftFrac.toFixed(4)},\n` +
    `  ringFrameFactor: ${+p.ringFrameFactor.toFixed(4)},\n` +
    "};";

  printBtn.addEventListener("click", () => {
    const block = constantsBlock(orbitPose());
    console.log(
      "%c🎥 bake into shared/world-engine/spirit/orbit-pose.ts:\n%s",
      "color:#a7e0a0", block,
    );
    outEl.textContent = block;
    outEl.style.display = "";
    void navigator.clipboard?.writeText(block).catch(() => {});
  });
  resetBtn.addEventListener("click", () => {
    resetOrbitPose();
    outEl.style.display = "none";
    paint();
  });

  let last: CameraFrameInfo = { ringM: null, fovDeg: 50, viewportH: 900, held: false, measured: null };

  /** THE READOUT. Derived from the pose the sliders hold, so it answers the
   *  question the sliders ask; the MEASURED line beside it is the cross-check
   *  that the ladder really landed there. */
  function paint(): void {
    const p = orbitPose();
    for (const s of SLIDERS) {
      const r = rows.get(s.key)!;
      const v = p[s.key];
      if (document.activeElement !== r.input) r.input.value = String(v);
      r.val.textContent = v.toFixed(2);
    }
    const ring = last.ringM ?? RING_FALLBACK_M;
    const fovRad = (last.fovDeg * Math.PI) / 180;
    const frameR = ring * p.ringFrameFactor;
    const dist = (frameR / Math.tan(fovRad / 2)) * p.frameFactor;
    const out = dist * Math.cos(p.pitchRad);
    const up = dist * Math.sin(p.pitchRad);
    const lift = frameR * p.liftFrac;
    const line = (label: string, bodyM: number): string => {
      const f = projectedFraction(bodyM, dist, fovRad);
      return `${label.padEnd(11)} ${(f * 100).toFixed(2).padStart(6)}% h ` +
        `(${Math.round(f * last.viewportH)}px)  → ${seedTierForProjected(f)}`;
    };
    readEl.textContent = [
      `ring ${ring.toFixed(1)} m${last.ringM === null ? " (no town — assumed)" : ""}` +
        `${last.held ? " · build hold" : " · hold OFF (ring not framed)"}`,
      `frame ${frameR.toFixed(1)} m · fov ${last.fovDeg}° · view ${last.viewportH}px`,
      `camera  out ${out.toFixed(1)} m  up ${up.toFixed(1)} m  dist ${dist.toFixed(1)} m  lift ${lift.toFixed(1)} m`,
      last.measured
        ? `measured out ${last.measured.outM.toFixed(1)} up ${last.measured.upM.toFixed(1)} dist ${last.measured.distM.toFixed(1)}`
        : "measured —  (no live town anchor this frame)",
      line(`body ${TIER_REF_BODY_M} m`, TIER_REF_BODY_M),
      line(`tree ${TREE_BODY_M} m`, TREE_BODY_M),
      orbitPoseOverridden() ? "OVERRIDDEN — not the shipped pose" : "shipped defaults",
    ].join("\n");
  }

  const setOpen = (on: boolean): void => {
    panel.style.display = on ? "" : "none";
    btn.setAttribute("aria-pressed", String(on));
    if (on) paint();
  };
  btn.addEventListener("click", () => setOpen(panel.style.display === "none"));

  paint();

  return {
    refresh(info) {
      if (panel.style.display === "none") return; // closed ⇒ free
      last = info;
      paint();
    },
    dispose() {
      btn.remove();
      panel.remove();
    },
  };
}
