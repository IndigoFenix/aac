// shared/social-world/world-render-client.ts
//
// Main-thread side of the OffscreenCanvas render worker. Transfers the canvas to
// the worker, relays input/net/face messages, and forwards the worker's outbound
// net + face requests. Mirrors the zero-regression contract of visionWorkerClient:
// ANY failure (spawn, init, or mid-session WebGL context loss) calls `onFallback`,
// and the caller rebuilds the world on the main thread with a fresh canvas.

import type { Vec2, WorldNetMessage, WorldSpec } from "../world-engine/index.js";
import type { WorldTunables } from "../world-engine/world-tunables.js";
import type { NpcEngagement, NpcProximity } from "./npc-controller.js";
import type { WorldPresence } from "./world-presence.js";
import type { MainToWorker, WorkerToMain } from "./world-render-protocol.js";

/** Is the off-thread render path even possible in this environment? */
export function supportsOffscreenRender(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function" &&
    typeof createImageBitmap === "function"
  );
}

export interface WorldRenderClientOpts {
  canvas: HTMLCanvasElement;
  worldSpec?: WorldSpec;
  worldSpecKey?: string;
  localId: string;
  renderer: "2d" | "3d";
  spawnIndex: number;
  spawnAt?: Vec2;
  /** Host the spec's NPCs in the worker (one peer per room; the solo surface). */
  hostNpcs?: boolean;
  /** Outbound transport (the call mesh). Absent ⇒ single-player. */
  net?: { send: (msgs: WorldNetMessage[]) => void; publishPresence?: (p: WorldPresence) => void };
  /** Resolve a participant's face image (decoded to an ImageBitmap) + label. The
   *  bitmap is transferred to the worker. Return a null bitmap for the disc fallback. */
  fulfillFace: (id: string) => Promise<{ bitmap: ImageBitmap | null; label: string }>;
  /** Resolve a composed glyph string to its decoded symbol images (the bubble
   *  strip). Bitmaps are transferred to the worker. Omit when the client has no
   *  glyphs (e.g. the clinician) — the worker then draws text-only bubbles. */
  fulfillGlyph?: (glyph: string) => Promise<ImageBitmap[]>;
  initialSize: { width: number; height: number; dpr: number };
  /** Initial gaze/camera/comfort tunables (debug menu); defaults if omitted. */
  tunables?: WorldTunables;
  /** The set of NPCs the local player can talk to changed (worker → main bridge). */
  onNpcProximity?: (nearby: NpcProximity[]) => void;
  /** Worker unusable (spawn/init/context-loss) — caller must rebuild on the main
   *  thread with a NEW canvas (the current one is neutered by the transfer). */
  onFallback: (reason: string) => void;
}

/** How often to re-push the faces the worker has asked for, so a photo that
 *  enrols mid-session (or a roster name change) reaches the avatar. */
const FACE_REPUMP_MS = 2000;

export class WorldRenderClient {
  private worker: Worker | null = null;
  private readonly requested = new Set<string>();
  private repumpTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly opts: WorldRenderClientOpts) {
    // transferControlToOffscreen() neuters the on-screen canvas — one-way, so a
    // later fallback needs a fresh canvas element (the caller remounts).
    const offscreen = opts.canvas.transferControlToOffscreen();
    const worker = new Worker(new URL("./world-render.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", (e) => this.fail(e?.message ?? "worker error"));
    worker.addEventListener("messageerror", () => this.fail("messageerror"));

    const init: MainToWorker = {
      type: "init",
      canvas: offscreen,
      worldSpec: opts.worldSpec,
      worldSpecKey: opts.worldSpecKey,
      localId: opts.localId,
      renderer: opts.renderer,
      spawnIndex: opts.spawnIndex,
      spawnAt: opts.spawnAt,
      hostNpcs: opts.hostNpcs,
      width: opts.initialSize.width,
      height: opts.initialSize.height,
      dpr: opts.initialSize.dpr,
      tunables: opts.tunables,
    };
    worker.postMessage(init, [offscreen]);

    this.repumpTimer = setInterval(() => this.repump(), FACE_REPUMP_MS);
  }

  private onMessage = (e: MessageEvent<WorkerToMain>): void => {
    const m = e.data;
    switch (m.type) {
      case "net-outbound":
        this.opts.net?.send(m.msgs);
        break;
      case "publish-presence":
        this.opts.net?.publishPresence?.(m.presence);
        break;
      case "request-face":
        this.requested.add(m.id);
        void this.fulfill(m.id);
        break;
      case "request-glyph":
        void this.fulfillGlyphImages(m.glyph);
        break;
      case "npc-proximity":
        this.opts.onNpcProximity?.(m.nearby);
        break;
      case "init-failed":
      case "fatal":
        this.fail(m.error);
        break;
      case "ready":
        break;
    }
  };

  private async fulfill(id: string): Promise<void> {
    let result: { bitmap: ImageBitmap | null; label: string };
    try {
      result = await this.opts.fulfillFace(id);
    } catch {
      return;
    }
    if (this.disposed || !this.worker) {
      try { result.bitmap?.close(); } catch { /* ignore */ }
      return;
    }
    const msg: MainToWorker = { type: "face", id, bitmap: result.bitmap, label: result.label };
    this.worker.postMessage(msg, result.bitmap ? [result.bitmap] : []);
  }

  private repump(): void {
    for (const id of this.requested) void this.fulfill(id);
  }

  /** Decode a glyph's symbol images on the main thread and transfer them in. */
  private async fulfillGlyphImages(glyph: string): Promise<void> {
    if (!this.opts.fulfillGlyph) return;
    let bitmaps: ImageBitmap[];
    try {
      bitmaps = await this.opts.fulfillGlyph(glyph);
    } catch {
      return;
    }
    if (this.disposed || !this.worker) {
      for (const b of bitmaps) { try { b.close(); } catch { /* ignore */ } }
      return;
    }
    this.worker.postMessage({ type: "glyph", glyph, bitmaps } satisfies MainToWorker, bitmaps);
  }

  private fail(reason: string): void {
    if (this.disposed) return;
    this.dispose();
    this.opts.onFallback(reason);
  }

  private send(msg: MainToWorker): void {
    if (!this.worker) return;
    try { this.worker.postMessage(msg); } catch { /* worker gone — fallback already in flight */ }
  }

  applyNetInbound(msgs: WorldNetMessage[]): void { this.send({ type: "net-inbound", msgs }); }
  applyPresence(presence: WorldPresence): void { this.send({ type: "presence", presence }); }
  applyPresenceLeave(personId: string): void { this.send({ type: "presence-leave", personId }); }
  setPointer(x: number, y: number): void { this.send({ type: "pointer", x, y }); }
  clearPointer(): void { this.send({ type: "pointer-leave" }); }
  say(text: string, glyph?: string): void { this.send({ type: "say", text, glyph }); }
  resize(width: number, height: number, dpr: number): void { this.send({ type: "resize", width, height, dpr }); }
  setNpcEngagement(npcId: string, engagement: NpcEngagement | null): void { this.send({ type: "npc-engagement", npcId, engagement }); }
  setTunables(tunables: WorldTunables): void { this.send({ type: "tune", tunables }); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.repumpTimer) { clearInterval(this.repumpTimer); this.repumpTimer = null; }
    try { this.worker?.postMessage({ type: "dispose" } satisfies MainToWorker); } catch { /* ignore */ }
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
  }
}
