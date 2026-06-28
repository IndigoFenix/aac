// shared/social-world/world-render.worker.ts
//
// Runs the ENTIRE social-world game loop on a worker thread, drawing into a
// transferred OffscreenCanvas. Moving sim + render off the main thread means the
// 3D scene never competes with React / DOM layout / the vision worker's messages,
// which is what made it choppy on the AAC. The same de-DOM'd `WorldView` code runs
// here as on the main-thread fallback (world-view.ts / render3d.ts take an
// OffscreenCanvas + injected size), and the same `runWorldHost` drives the loop.
//
// Main owns transport + DOM + faces; we get inbound state / input / face bitmaps as
// messages and emit outbound net + face requests back. Any fatal error (WebGL
// context loss, exception) is reported so main can rebuild on the main thread.
//
/// <reference lib="webworker" />

import { getWorldSpec, socialFieldSpec } from "../world-engine/specs/index.js";
import { createWorld2DView } from "../world-engine/world-view.js";
import { createWorld3DView } from "../world-engine/render3d.js";
import { runWorldHost, type WorldHost } from "./world-host.js";
import type { MainToWorker, WorkerToMain } from "./world-render-protocol.js";

const post = (msg: WorkerToMain, transfer?: Transferable[]) =>
  (globalThis as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage(msg, transfer);

// rAF exists on DedicatedWorkerGlobalScope in Chromium/Electron (vsync-paced); fall
// back to a coarse timer elsewhere. The host clamps dt, so a coarse timer still
// produces correct (if less smooth) motion.
const scheduleFrame = (cb: (nowMs: number) => void): (() => void) => {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (h: number) => void;
  };
  if (typeof g.requestAnimationFrame === "function") {
    const id = g.requestAnimationFrame(cb);
    return () => g.cancelAnimationFrame?.(id);
  }
  const id = setTimeout(() => cb(performance.now()), 16);
  return () => clearTimeout(id);
};

let host: WorldHost | null = null;
const faceCache = new Map<string, ImageBitmap | null>();
const labelCache = new Map<string, string>();
const requestedFaces = new Set<string>();
const glyphCache = new Map<string, ImageBitmap[]>();
const requestedGlyphs = new Set<string>();

function setup(msg: Extract<MainToWorker, { type: "init" }>): void {
  const spec = msg.worldSpec ?? getWorldSpec(msg.worldSpecKey ?? "social-field") ?? socialFieldSpec;

  // Faces are sourced on the main thread and pushed in as ImageBitmaps; the first
  // time we need one we ask for it (main fulfils + re-pumps on enrolment changes).
  const faceFor = (id: string): CanvasImageSource | null => {
    if (!requestedFaces.has(id)) {
      requestedFaces.add(id);
      post({ type: "request-face", id });
    }
    return faceCache.get(id) ?? null;
  };
  const labelFor = (id: string): string => labelCache.get(id) ?? "";

  // Glyph symbol images are likewise sourced on the main thread (it owns the glyph
  // registry + asset resolver); request once per glyph string, then cache.
  const glyphFor = (glyph: string): CanvasImageSource[] | null => {
    if (!requestedGlyphs.has(glyph)) {
      requestedGlyphs.add(glyph);
      post({ type: "request-glyph", glyph });
    }
    return glyphCache.get(glyph) ?? null;
  };

  const viewDeps = { canvas: msg.canvas, localId: msg.localId, faceFor, labelFor, glyphFor };
  // createWorld3DView constructs a WebGL context — the most likely failure point on
  // a given GPU/driver. Throwing here reports init-failed so main runs on-thread.
  const view = msg.renderer === "2d" ? createWorld2DView(viewDeps) : createWorld3DView(viewDeps, spec);

  host = runWorldHost({
    view,
    spec,
    localId: msg.localId,
    spawnIndex: msg.spawnIndex,
    spawnAt: msg.spawnAt,
    hostNpcs: msg.hostNpcs,
    onNpcProximity: (nearby) => post({ type: "npc-proximity", nearby }),
    net: {
      send: (msgs) => post({ type: "net-outbound", msgs }),
      publishPresence: (presence) => post({ type: "publish-presence", presence }),
    },
    scheduleFrame,
    now: () => performance.now(),
    tunables: msg.tunables,
  });
  host.resize(msg.width, msg.height, msg.dpr);
  host.start();

  // Surface a mid-session GPU context loss as a fatal so main can take over.
  try {
    (msg.canvas as unknown as EventTarget).addEventListener("webglcontextlost", (e) => {
      e.preventDefault?.();
      post({ type: "fatal", error: "webglcontextlost" });
    });
  } catch { /* OffscreenCanvas may not expose the event on every engine — best effort */ }

  post({ type: "ready" });
}

globalThis.addEventListener("message", (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "init":
        setup(msg);
        break;
      case "resize":
        host?.resize(msg.width, msg.height, msg.dpr);
        break;
      case "tune":
        host?.setTunables(msg.tunables);
        break;
      case "pointer":
        host?.setPointer(msg.x, msg.y);
        break;
      case "pointer-leave":
        host?.clearPointer();
        break;
      case "say":
        host?.say(msg.text, msg.glyph);
        break;
      case "net-inbound":
        host?.applyNetInbound(msg.msgs);
        break;
      case "presence":
        host?.applyPresence(msg.presence);
        break;
      case "presence-leave":
        host?.applyPresenceLeave(msg.personId);
        break;
      case "face": {
        const prev = faceCache.get(msg.id);
        if (prev && prev !== msg.bitmap) { try { prev.close(); } catch { /* ignore */ } }
        faceCache.set(msg.id, msg.bitmap);
        labelCache.set(msg.id, msg.label);
        break;
      }
      case "glyph": {
        const prev = glyphCache.get(msg.glyph);
        if (prev) for (const b of prev) { try { b.close(); } catch { /* ignore */ } }
        glyphCache.set(msg.glyph, msg.bitmaps);
        break;
      }
      case "npc-engagement":
        host?.setNpcEngagement(msg.npcId, msg.engagement);
        break;
      case "dispose":
        host?.stop();
        host = null;
        for (const b of faceCache.values()) { try { b?.close(); } catch { /* ignore */ } }
        faceCache.clear();
        for (const bs of glyphCache.values()) for (const b of bs) { try { b.close(); } catch { /* ignore */ } }
        glyphCache.clear();
        (globalThis as unknown as { close: () => void }).close();
        break;
    }
  } catch (err) {
    post({ type: msg.type === "init" ? "init-failed" : "fatal", error: String(err) });
  }
});
