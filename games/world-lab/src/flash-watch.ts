// games/world-lab/src/flash-watch.ts
//
// THE STAR-FLASH TRAP — a per-frame detector for the single-frame bright
// flashes that appear whenever a scope includes space-scale generation.
//
// The symptom: an unpredictable, sometimes colour-tinted, blooming circle
// taking up a fair chunk of the screen for exactly ONE frame — as if a distant
// star had rendered up close for an instant. Most frequent at high speed in
// space, but seen near the ground too, under both shading modes, and it
// predates the seagull-dream renderer port.
//
// A flash that lasts one frame cannot be caught by eye, by a screenshot, or by
// stepping in a debugger — by the time you react it is six frames gone. So the
// trap runs INSIDE the frame loop:
//
//   1. Right after the present, downsample the drawing buffer into a small 2D
//      canvas and take its mean + peak luminance. This must happen in the SAME
//      task as the draw: the context has no `preserveDrawingBuffer`, so the
//      pixels are gone as soon as we yield.
//   2. Compare against the previous frame. A flash is a spike that is both
//      RELATIVELY large (ratio) and ABSOLUTELY large (floor), which rejects the
//      slow ramps of a sunrise or a planet swinging into view.
//   3. On a hit, grab the canvas as a PNG *immediately* (same task, same rule)
//      and dissect the starfield buffers the projector filled for this exact
//      frame — the brightest and biggest points, with the cell that emitted
//      each one.
//   4. On the NEXT frame, record whether the luminance fell back. A true
//      one-frame flash spikes and returns; a real bright object stays.
//
// The starfield is the prime suspect and the dissection is aimed at it: every
// point sits on a fixed-radius sphere around the camera, so nothing there can
// approach — but an AGGREGATE cell blob is drawn at up to `aggregateMaxSize`
// (800) pixels with an UNBOUNDED brightness, which is the one thing in the
// scene that can become a screen-filling bright disc.
//
// Usage — `?flashwatch=1`, then in the console:
//   __flash.clean()    strip the scene to just the starfield (see below)
//   __flash.report()   what has been caught so far
//   __flash.save()     download every captured frame as PNG + a JSON dossier
//   __flash.replay(i)  re-project a caught frame's galactic position and dump
//                      the offending cells again, deterministically

import type { SpaceSky, StarfieldSnapshot } from "@shared/world-engine/space/space-sky";
import type { HdrPeak } from "./hdr-probe";

/** Downsample width/height. Small enough that the readback costs ~nothing,
 *  large enough that a 200px blob still moves the mean. */
const GRID_W = 96;
const GRID_H = 54;

/** A flash must be at least this many times brighter than the previous frame. */
const RATIO = 1.25;
/** ...AND rise by at least this much absolute luminance (0-255). Rejects the
 *  ratio blowing up when the previous frame was nearly black. */
const FLOOR = 4;
/** Cap on stored captures — PNGs are big and we only need a handful. Set
 *  generously: the sustained-brightness false positives (a planet swinging into
 *  view) are filtered out only on the FOLLOWING frame, so they consume slots
 *  before we know they are not the bug. */
const MAX_CAPTURES = 40;
/** Ignore the first frames after arming — boot, first paint and the initial
 *  geometry pop are all legitimate step changes in brightness. */
const WARMUP_FRAMES = 30;
/** How many starfield points to name in the dossier. */
const TOP_N = 12;

export interface FlashPoint {
  index: number;
  /** Position on the starfield sphere (camera-relative scene units). */
  pos: [number, number, number];
  /** Linear HDR colour written into the buffer — this is pre-bloom radiance. */
  color: [number, number, number];
  /** gl_PointSize in pixels. */
  pix: number;
  /** Rough screen coverage: how much additive radiance this point can deposit. */
  weightedEnergy: number;
  /** Provenance, when the probe was enabled. */
  tier?: number;
  kind?: string;
  id?: string;
  distLy?: number;
  fadeWeight?: number;
  k?: number;
}

export interface FlashRecord {
  frame: number;
  timeMs: number;
  /** Mean luminance of this frame and the one before it (0-255). */
  mean: number;
  prevMean: number;
  /** Peak single-cell luminance in the downsampled grid. */
  peak: number;
  prevPeak: number;
  /** Filled on the following frame: did it fall back? A true one-frame flash
   *  has `nextMean` back near `prevMean`. */
  nextMean: number | null;
  /** True once `nextMean` shows the spike was transient. */
  transient: boolean | null;
  /** Player galactic position (ly) the starfield was projected from. */
  galactic: [number, number, number];
  /** How far that position moved since the previous frame (ly). A rebase
   *  glitch shows as a one-frame jump of order a cell size (5-5000 ly). */
  galacticStepLy: number;
  /** Points drawn in the starfield this frame. */
  starCount: number;
  /** The loudest points in the frame, brightest-first. */
  top: FlashPoint[];
  /** Peak raw scene radiance this frame, BEFORE the sanitize clamp, with the
   *  uv it came from. `bad` means NaN or half-float saturation — i.e. the
   *  sanitize pass was about to hand HDR_CLAMP to the bloom pyramid. */
  hdr: (HdrPeak & { prevValue: number }) | null;
  /** What is actually ON SCREEN at the peak uv — the object that emitted the
   *  spike, named, with the material state that could explain it. */
  culprit: string[] | null;
  /** PNG data URL of the offending frame (final composite, post-bloom). */
  png: string | null;
  /** The RAW pre-bloom scene, log-mapped: the culprit at its true size and
   *  shape, before the bloom smeared it into a disc. `crop` is 6x around the
   *  peak. */
  rawPng: string | null;
  rawCrop: string | null;
}

export interface FlashWatch {
  /** Call once per frame, IMMEDIATELY after the present. */
  sample(): void;
  /** Strip the scene down so nothing but the starfield can be bright. */
  clean(): void;
  /** BISECTION: hide one candidate emitter at a time and see whether the
   *  flashes stop. The firefly is a single texel with a pure-hue signature, and
   *  every candidate here is a TINY BRIGHT PRIMITIVE — which is the one shape
   *  the planet-limb sightings and the deep-space sightings have in common. */
  hide(what: Partial<Record<"beacons" | "atmosphere" | "starfield" | "halos" | "terrain", boolean>>): void;
  /** Scale every city beacon by `n` (1 = normal). The direct sub-pixel test:
   *  same colour, same material, just far more than one pixel wide. */
  fatBeacons(n: number): void;
  /** Pin beacons to a CONSTANT world size in metres (0 = back to normal),
   *  removing the distance compensation that keeps them a fixed apparent size. */
  fixedBeacons(m: number): void;
  /** Reset the baseline and the warm-up counter. Call once you are settled and
   *  flying — everything before it is discarded. */
  arm(): void;
  /** On demand: what is at this uv right now, and the raw pre-bloom image
   *  around it. Downloads the images. Use to interrogate the live frame — and
   *  to confirm the capture path works without waiting for a flash. */
  probeAt(u?: number, v?: number): { culprit: string[]; peak: HdrPeak | null };
  /** Every hit. `transient: true` are the one-frame flashes — the bug; the rest
   *  are sustained brightness changes (a planet swinging into view). */
  report(): FlashRecord[];
  /** Only the confirmed one-frame flashes. */
  flashes(): FlashRecord[];
  /** Running peak of raw scene radiance across every frame seen so far — the
   *  headline number for "does anything in this scene ever overflow".
   *
   *  `screenMean` / `screenPeak` are the PRESENTED frame's luminance, sampled
   *  inside the render loop. Read them from outside instead of grabbing the
   *  canvas yourself: the context has no `preserveDrawingBuffer`, so any read
   *  in a later task returns a blank buffer and looks like a black frame. */
  hdrStats(): {
    max: number; badFrames: number; frames: number;
    screenMean: number; screenPeak: number;
  };
  save(): void;
  enabled: boolean;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function createFlashWatch(
  canvas: HTMLCanvasElement,
  getSky: () => SpaceSky | null,
  getHdrPeak: () => HdrPeak | null,
  /** Raycast the scene at a uv and describe whatever is there. */
  identifyAt: (u: number, v: number) => string[],
  /** Read the raw pre-bloom scene back as viewable PNGs, centred on a uv. */
  captureRaw: (u: number, v: number) => { full: string; crop: string } | null,
  onClean: () => void,
  /** Bisection knobs. Booleans hide a category; `beaconScale` resizes beacons. */
  onHide: (what: {
    beacons?: boolean; atmosphere?: boolean; starfield?: boolean;
    halos?: boolean; terrain?: boolean;
    beaconScale?: number; beaconFixedM?: number;
  }) => void,
): FlashWatch {
  const grid = document.createElement("canvas");
  grid.width = GRID_W;
  grid.height = GRID_H;
  // `willReadFrequently` — we getImageData every single frame.
  const gtx = grid.getContext("2d", { willReadFrequently: true })!;

  let frame = 0;
  let prevMean = -1;
  let prevPeak = 0;
  const records: FlashRecord[] = [];
  let pendingNext: FlashRecord | null = null;
  let captures = 0;
  // Raw-radiance history. Tracked every frame, not just on hits: "did anything
  // ever overflow" is the question that decides whether the bloom clamp is the
  // mechanism, and it must be answered over the whole run.
  let hdrMax = 0;
  let hdrBadFrames = 0;
  let prevHdrValue = 0;
  let warmup = WARMUP_FRAMES;

  // A HUD counter, so a flash announces itself without the console open — the
  // whole point is that you cannot see the frame it happened on.
  const hud = document.createElement("div");
  hud.style.cssText =
    "position:fixed;right:8px;bottom:8px;z-index:99999;font:12px/1.4 monospace;" +
    "background:rgba(0,0,0,0.75);color:#8f8;padding:6px 9px;border-radius:4px;" +
    "pointer-events:none;white-space:pre";
  hud.textContent = "flash watch: arming…";
  document.body.appendChild(hud);
  function paintHud(): void {
    const t = records.filter(r => r.transient).length;
    const s = records.length - t;
    hud.style.color = t > 0 ? "#ff6" : "#8f8";
    hud.textContent =
      `flash watch · frame ${frame}\n` +
      `ONE-FRAME FLASHES: ${t}\n` +
      `sustained (ignored): ${s}\n` +
      `peak raw radiance: ${hdrMax.toExponential(2)}` +
      (hdrBadFrames ? `\n⚠ OVERFLOW/NaN frames: ${hdrBadFrames}` : "");
  }

  function dissect(snap: StarfieldSnapshot): FlashPoint[] {
    const { count, positions, colors, sizes, probe } = snap;
    // Rank by the radiance a point can actually deposit on screen: its HDR
    // colour times its footprint. A 3px star at k=6 is nothing next to an
    // 800px aggregate at k=1 — the flash is the latter shape.
    const scored: Array<{ i: number; e: number }> = [];
    for (let i = 0; i < count; i++) {
      const r = colors[i * 3]!, g = colors[i * 3 + 1]!, b = colors[i * 3 + 2]!;
      const px = sizes[i]!;
      scored.push({ i, e: luminance(r, g, b) * px * px });
    }
    scored.sort((a, b) => b.e - a.e);
    return scored.slice(0, TOP_N).map(({ i, e }): FlashPoint => {
      const p: FlashPoint = {
        index: i,
        pos: [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!],
        color: [colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!],
        pix: sizes[i]!,
        weightedEnergy: e,
      };
      if (probe && i < probe.tier.length) {
        p.tier = probe.tier[i];
        p.kind = probe.kind[i];
        p.id = probe.id[i];
        p.distLy = probe.distLy[i];
        p.fadeWeight = probe.weight[i];
        p.k = probe.k[i];
      }
      return p;
    });
  }

  return {
    enabled: true,

    sample(): void {
      frame++;
      // Downsample the drawing buffer. Valid ONLY in the same task as the
      // draw — no preserveDrawingBuffer, so a deferred read gets a blank.
      let data: Uint8ClampedArray;
      try {
        gtx.drawImage(canvas, 0, 0, GRID_W, GRID_H);
        data = gtx.getImageData(0, 0, GRID_W, GRID_H).data;
      } catch {
        return; // canvas not yet sized / context lost
      }

      let sum = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i += 4) {
        const l = luminance(data[i]!, data[i + 1]!, data[i + 2]!);
        sum += l;
        if (l > peak) peak = l;
      }
      const mean = sum / (GRID_W * GRID_H);

      // Close out the previous hit: a genuine one-frame flash has already
      // fallen back by now.
      if (pendingNext) {
        pendingNext.nextMean = mean;
        const rise = pendingNext.mean - pendingNext.prevMean;
        pendingNext.transient = mean < pendingNext.prevMean + rise * 0.5;
        if (pendingNext.transient) {
          console.warn(
            `[flash] ⇧ frame ${pendingNext.frame} CONFIRMED ONE-FRAME FLASH ` +
            `(fell back ${pendingNext.mean.toFixed(1)} → ${mean.toFixed(1)}). ` +
            `This is the bug — __flash.save() to dump it.`,
          );
        }
        pendingNext = null;
        paintHud();
      }

      const hdrPeak = getHdrPeak();
      if (hdrPeak) {
        if (Number.isFinite(hdrPeak.value) && hdrPeak.value > hdrMax) hdrMax = hdrPeak.value;
        if (hdrPeak.bad || !Number.isFinite(hdrPeak.value)) hdrBadFrames++;
      }

      // Warm-up: boot, first paint and the initial geometry pop are all real
      // step changes in brightness and would bury the signal. Stats above still
      // accumulate — only the TRIGGER is suppressed.
      if (warmup > 0) {
        warmup--;
        prevMean = mean; prevPeak = peak;
        if (hdrPeak && Number.isFinite(hdrPeak.value)) prevHdrValue = hdrPeak.value;
        paintHud();
        return;
      }

      // Two independent triggers. The screen-luminance spike is what the eye
      // sees; the raw-radiance spike catches the CAUSE even on a frame whose
      // bloom happened to land off-screen, and it is far more sensitive.
      const screenSpike =
        prevMean >= 0 && mean > prevMean * RATIO && mean - prevMean > FLOOR;
      const radianceSpike = !!hdrPeak && (
        hdrPeak.bad ||
        !Number.isFinite(hdrPeak.value) ||
        (prevHdrValue > 0 && hdrPeak.value > prevHdrValue * 8 && hdrPeak.value > 100)
      );

      if (screenSpike || radianceSpike) {
        const sky = getSky();
        const snap = sky?.snapshot() ?? null;
        // PNG first and synchronously — same task as the draw.
        let png: string | null = null;
        let raw: { full: string; crop: string } | null = null;
        if (captures < MAX_CAPTURES) {
          try { png = canvas.toDataURL("image/png"); captures++; } catch { /* tainted */ }
          // The pre-bloom readback is expensive, so it rides the same budget.
          if (hdrPeak) raw = captureRaw(hdrPeak.u, hdrPeak.v);
        }
        const rec: FlashRecord = {
          frame,
          timeMs: Math.round(performance.now()),
          mean, prevMean, peak, prevPeak,
          nextMean: null, transient: null,
          galactic: snap
            ? [snap.galactic.x, snap.galactic.y, snap.galactic.z]
            : [NaN, NaN, NaN],
          galacticStepLy: snap?.galacticStepLy ?? NaN,
          starCount: snap?.count ?? 0,
          top: snap ? dissect(snap) : [],
          hdr: hdrPeak ? { ...hdrPeak, prevValue: prevHdrValue } : null,
          // Raycast the peak uv NOW — the scene graph is still in this frame's
          // state, and one frame later the spike is gone.
          culprit: hdrPeak ? identifyAt(hdrPeak.u, hdrPeak.v) : null,
          png,
          rawPng: raw?.full ?? null,
          rawCrop: raw?.crop ?? null,
        };
        records.push(rec);
        pendingNext = rec;
        paintHud();
        const worst = rec.top[0];
        console.warn(
          `[flash] frame ${frame} (${screenSpike ? "screen" : ""}${screenSpike && radianceSpike ? "+" : ""}${radianceSpike ? "radiance" : ""}): ` +
          `mean ${prevMean.toFixed(1)} → ${mean.toFixed(1)} (peak ${peak.toFixed(0)}); ` +
          `raw radiance ${prevHdrValue.toExponential(2)} → ${(rec.hdr?.value ?? NaN).toExponential(2)}` +
          `${rec.hdr?.bad ? " OVERFLOW/NaN" : ""} at uv(${rec.hdr?.u.toFixed(3)}, ${rec.hdr?.v.toFixed(3)})` +
          `${rec.hdr?.rgb ? ` rgb=[${rec.hdr.rgb.map(c => c.toExponential(2)).join(", ")}]` : ""}; ` +
          `CULPRIT: ${rec.culprit?.join(" | ") ?? "?"}; ` +
          `galactic step ${rec.galacticStepLy.toExponential(2)} ly, ${rec.starCount} points. Loudest point: ` +
          (worst
            ? `${worst.kind ?? "?"} ${worst.id ?? "?"} tier ${worst.tier ?? "?"} ` +
              `${worst.pix.toFixed(0)}px k=${worst.k?.toFixed(3) ?? "?"} ` +
              `d=${worst.distLy?.toFixed(1) ?? "?"} ly ` +
              `rgb=[${worst.color.map(c => c.toFixed(2)).join(", ")}]`
            : "(no starfield)"),
        );
      }

      prevMean = mean;
      prevPeak = peak;
      if (hdrPeak && Number.isFinite(hdrPeak.value)) prevHdrValue = hdrPeak.value;
    },

    hdrStats() {
      return {
        max: hdrMax, badFrames: hdrBadFrames, frames: frame,
        screenMean: prevMean, screenPeak: prevPeak,
      };
    },

    clean(): void {
      onClean();
      getSky()?.setProbeEnabled(true);
      console.info("[flash] scene stripped; probe on. Park the cursor and wait.");
    },

    hide(what) {
      onHide(what);
      console.info("[flash] hidden:", what, "— re-arm and fly again.");
    },

    fatBeacons(n) {
      onHide({ beaconScale: n });
      console.info(`[flash] beacons scaled x${n} — re-arm and fly again.`);
    },

    fixedBeacons(m) {
      onHide({ beaconFixedM: m });
      console.info(
        `[flash] beacons pinned to ${m} m constant world size (0 = normal) — re-arm and fly again.`,
      );
    },

    arm(): void {
      records.length = 0;
      pendingNext = null;
      captures = 0;
      hdrMax = 0;
      hdrBadFrames = 0;
      prevMean = -1;
      prevHdrValue = 0;
      warmup = WARMUP_FRAMES;
      getSky()?.setProbeEnabled(true);
      console.info("[flash] armed — baseline reset, probe on. Fly.");
      paintHud();
    },

    probeAt(u?: number, v?: number) {
      const peak = getHdrPeak();
      const uu = u ?? peak?.u ?? 0.5;
      const vv = v ?? peak?.v ?? 0.5;
      const culprit = identifyAt(uu, vv);
      const raw = captureRaw(uu, vv);
      if (raw) {
        for (const [href, name] of [[raw.full, "RAW"], [raw.crop, "RAWCROP"]] as const) {
          const a = document.createElement("a");
          a.href = href;
          a.download = `probe-${name}-uv${uu.toFixed(3)}_${vv.toFixed(3)}.png`;
          a.click();
        }
      }
      console.info(`[flash] uv(${uu.toFixed(3)}, ${vv.toFixed(3)}):`, culprit, peak);
      return { culprit, peak };
    },

    report(): FlashRecord[] {
      return records;
    },

    flashes(): FlashRecord[] {
      return records.filter(r => r.transient);
    },

    save(): void {
      // Confirmed one-frame flashes first, and only those get a PNG — the
      // sustained hits are noise and would bury the evidence in downloads.
      const confirmed = records.filter(r => r.transient);
      (confirmed.length ? confirmed : records).forEach((r, i) => {
        const tag = `${r.transient ? "CONFIRMED" : "sustained"}-${String(i).padStart(2, "0")}-frame${r.frame}`;
        const dl = (href: string | null, suffix: string): void => {
          if (!href) return;
          const a = document.createElement("a");
          a.href = href;
          a.download = `flash-${tag}${suffix}.png`;
          a.click();
        };
        dl(r.png, "");
        dl(r.rawPng, "-RAW");     // pre-bloom: the culprit at true size
        dl(r.rawCrop, "-RAWCROP"); // 6x around the peak
      });
      const dossier = records.map(({ png, rawPng, rawCrop, ...rest }) => rest);
      const blob = new Blob([JSON.stringify(dossier, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "flash-dossier.json";
      a.click();
    },
  };
}
