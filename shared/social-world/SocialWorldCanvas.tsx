// shared/social-world/SocialWorldCanvas.tsx
//
// Renders the world engine and drives the local avatar. SHARED between the AAC
// and clinician clients — the simulation/render/transport are identical; only
// the surrounding chrome differs per client.
//
// Two modes, one loop:
//   • single-player (no `net`): tuning render + steering + ball feel.
//   • networked (`net` provided): the local avatar + owned toys are streamed
//     over the mesh's "world" channel (collectOutbound → net.send, ~15 Hz), and
//     peers' state is applied from net.subscribe (applyInbound).
//
// The `net` adapter is intentionally tiny so the canvas doesn't depend on the
// transport. When a call has a game attached, the in-call game surface maps the
// CallClient's worldData / peerLeft events onto it (the world state rides the
// mesh's unreliable "world" data channel alongside the call's audio/video).
//
// Rendering is delegated to a WorldView (see ../world-engine/world-view.ts): the
// `renderer` prop picks the 2D top-down view or the 3D Three.js view. The view
// owns BOTH the screen→world aim mapping and the draw call (they share one
// camera); the sim/transport loop below is identical either way.

import { useEffect, useRef, useState } from "react";
import type { Vec2, WorldNetMessage, WorldSpec } from "../world-engine/index.js";
import type { NpcEngagement, NpcProximity } from "./npc-controller.js";
import type { WorldPresence } from "./world-presence.js";
import { getWorldSpec, socialFieldSpec } from "../world-engine/specs/index.js";
import { createWorld2DView, type WorldView } from "../world-engine/world-view.js";
import { createWorld3DView } from "../world-engine/render3d.js";
import { cloneWorldTunables, type WorldTunables } from "../world-engine/world-tunables.js";
import { runWorldHost } from "./world-host.js";
import { WorldRenderClient, supportsOffscreenRender } from "./world-render-client.js";
import WorldDebugPanel from "./WorldDebugPanel";

/** Minimal transport the canvas needs in networked mode. */
export interface SocialWorldNet {
  /** The local participant's id (its avatar is the one this client owns). */
  localId: string;
  /** Broadcast this client's outbound world messages (toys/possession, and —
   *  when no presence relay is wired — its avatar too). */
  send: (msgs: WorldNetMessage[]) => void;
  /** Subscribe to inbound peer messages; returns an unsubscribe fn. */
  subscribe: (handler: (fromPersonId: string, msgs: WorldNetMessage[]) => void) => () => void;
  // --- Phase 1 position relay (optional) ---------------------------------
  // When present, the local avatar's position rides the world-wide RELAY instead
  // of the mesh, and remote avatars are applied from relay events. This is what
  // decouples WHERE-EVERYONE-IS from the media mesh (see large-world planning doc).
  /** Publish the local avatar's position to the relay (~send rate). */
  publishPresence?: (p: WorldPresence) => void;
  /** Subscribe to a remote participant's relayed position. */
  subscribePresence?: (handler: (p: WorldPresence) => void) => () => void;
  /** Subscribe to a participant dropping out of the world (leave / stale prune). */
  subscribePresenceLeave?: (handler: (personId: string) => void) => () => void;
}

interface Props {
  /** Which built-in world to run; defaults to the social field. */
  worldSpecKey?: string;
  /** A certified WorldSpec to run directly (custom apps). Wins over worldSpecKey. */
  worldSpec?: WorldSpec;
  /** Provide to run multiplayer; omit for the single-player test surface. */
  net?: SocialWorldNet;
  /** Where to drop the local avatar at spawn — typically the centroid of players
   *  already present, so people who enter together land near each other. Falls
   *  back to the field centre. Read ONCE at mount. */
  spawnHint?: () => Vec2 | null;
  /** A face-photo URL for a participant (drawn into their avatar circle), or null. */
  getFaceUrl?: (personId: string) => string | null;
  /** Display name for a participant — its initial is the no-photo fallback. */
  getLabel?: (personId: string) => string;
  /** The local camera stream — drawn LIVE into the local avatar so you see your
   *  own face on yourself. Null (e.g. a camera-less solo game) → coloured disc. */
  selfStream?: MediaStream | null;
  /** Which renderer to use. "3d" (default) is the Three.js environment; "2d" is
   *  the original top-down canvas view. Both consume the same simulation. */
  renderer?: "2d" | "3d";
  /** Whether THIS peer hosts the world's NPC bodies. Defaults to solo (`!net`):
   *  in a call, CallGameSurface passes the elected owner. Changing it rebuilds the
   *  host (re-spawning the local avatar) — rare (only on owner change). */
  hostNpcs?: boolean;
  /** Fires when the set of NPCs the local player can talk to changes (nearest
   *  first). Only meaningful on the NPC-hosting peer. */
  onNpcProximity?: (nearby: NpcProximity[]) => void;
  /** Live conversation bias per hosted NPC id — pushed into its body controller
   *  so it leans in / drifts off as the conversation's mood shifts. */
  npcEngagements?: Record<string, NpcEngagement>;
  /** Show the live tuning panel (debug affordance — see WorldDebugPanel). */
  debug?: boolean;
  /** Close the debug panel (the parent owns the `debug` flag). */
  onCloseDebug?: () => void;
}

/** Master switch for the OffscreenCanvas render worker. Falls back to the
 *  main-thread loop automatically when the worker can't run; flip to false to
 *  force the main-thread path everywhere (kill-switch). */
const WORKER_RENDER_ENABLED = true;

/** Stable spawn assignment so two peers don't always stack on spawn 0. */
function spawnIndexFor(id: string, n: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return n > 0 ? h % n : 0;
}

/** A small deterministic offset so players landing at the same point (e.g. the
 *  field centre, or right on top of an existing group) don't stack exactly. */
function spawnOffset(id: string): Vec2 {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const ang = (h % 360) * (Math.PI / 180);
  const r = 1.2 + ((h >>> 9) % 100) / 100; // 1.2 .. 2.2 world units out
  return { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
}

export default function SocialWorldCanvas({ worldSpecKey, worldSpec, net, spawnHint, getFaceUrl, getLabel, selfStream, renderer = "3d", hostNpcs: hostNpcsProp, onNpcProximity, npcEngagements, debug = false, onCloseDebug }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Proximity handler via a ref so the long-lived loop always calls the latest one
  // without re-running the effect (mirrors the face/label resolver pattern).
  const onNpcProximityRef = useRef(onNpcProximity);
  onNpcProximityRef.current = onNpcProximity;
  // An adapter set by whichever render path is live, so the engagement effect can
  // push into the host/worker without knowing which path it is.
  const engageAdapterRef = useRef<((npcId: string, e: NpcEngagement | null) => void) | null>(null);
  // Live tunables (debug menu). Pushed into the running host/worker WITHOUT
  // remounting (the render effect doesn't depend on them); a separate effect calls
  // the adapter the live path installs, mirroring the engagement plumbing.
  const [tunables, setTunables] = useState<WorldTunables>(() => cloneWorldTunables());
  const tunablesRef = useRef(tunables);
  tunablesRef.current = tunables;
  const tuneAdapterRef = useRef<((t: WorldTunables) => void) | null>(null);
  // Read once at mount via a ref so changing the prop identity can't re-spawn us.
  const spawnHintRef = useRef(spawnHint);
  spawnHintRef.current = spawnHint;
  // Face/label resolvers via refs so the long-lived render loop always sees the
  // latest (the roster updates over time) without re-running the effect.
  const getFaceUrlRef = useRef(getFaceUrl);
  getFaceUrlRef.current = getFaceUrl;
  const getLabelRef = useRef(getLabel);
  getLabelRef.current = getLabel;
  const selfStreamRef = useRef(selfStream);
  selfStreamRef.current = selfStream;

  // Render path: try the OffscreenCanvas worker first (when supported), and fall
  // back to the main-thread loop if it can't run. `fallbackEpoch` bumps to force a
  // FRESH canvas element on fallback — transferControlToOffscreen neuters the old
  // one, so the main-thread path can't reuse it.
  const [renderMode, setRenderMode] = useState<"worker" | "main">(
    WORKER_RENDER_ENABLED && supportsOffscreenRender() ? "worker" : "main",
  );
  const [fallbackEpoch, setFallbackEpoch] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const spec = worldSpec ?? getWorldSpec(worldSpecKey ?? "social-field") ?? socialFieldSpec;
    const localId = net?.localId ?? "you";
    // Who hosts the world's NPCs? CallGameSurface passes the elected owner in a
    // call; the solo surface (no net) defaults to hosting them itself.
    const hostNpcs = hostNpcsProp ?? !net;
    // Spawn near whoever is already here (so people entering together cluster),
    // else the field centre — plus a small offset to avoid exact stacking.
    const base = spawnHintRef.current?.() ?? { x: spec.manifold.width / 2, y: spec.manifold.height / 2 };
    const off = spawnOffset(localId);
    const spawnIndex = spawnIndexFor(localId, spec.spawns.length);
    const spawnAt = { x: base.x + off.x, y: base.y + off.y };

    // ── Worker render path ─────────────────────────────────────────────────────
    // The whole loop runs in the worker on an OffscreenCanvas; this thread only
    // bridges transport + input + faces. Self-cam-on-your-own-avatar is deferred
    // here (worker mode shows your photo/disc); the main fallback keeps it live.
    if (renderMode === "worker") {
      const fulfillFace = async (id: string): Promise<{ bitmap: ImageBitmap | null; label: string }> => {
        const url = getFaceUrlRef.current?.(id) ?? null;
        let bitmap: ImageBitmap | null = null;
        if (url) {
          try {
            const blob = await (await fetch(url)).blob();
            bitmap = await createImageBitmap(blob);
          } catch { bitmap = null; }
        }
        return { bitmap, label: getLabelRef.current?.(id) ?? "" };
      };

      let client: WorldRenderClient;
      try {
        client = new WorldRenderClient({
          canvas,
          worldSpec,
          worldSpecKey,
          localId,
          renderer,
          spawnIndex,
          spawnAt,
          hostNpcs,
          net: net ? { send: net.send, publishPresence: net.publishPresence } : undefined,
          fulfillFace,
          tunables: tunablesRef.current,
          onNpcProximity: (nearby) => onNpcProximityRef.current?.(nearby),
          initialSize: { width: canvas.clientWidth, height: canvas.clientHeight, dpr: window.devicePixelRatio || 1 },
          onFallback: (reason) => {
            console.warn("[WorldRender] worker fallback → main thread:", reason);
            setRenderMode("main");
            setFallbackEpoch((e) => e + 1);
          },
        });
      } catch (err) {
        // transferControlToOffscreen / Worker construction threw — go straight to
        // the main path (the effect re-runs after the canvas remounts).
        console.warn("[WorldRender] worker init threw → main thread:", err);
        setRenderMode("main");
        setFallbackEpoch((e) => e + 1);
        return;
      }

      const c = client;
      engageAdapterRef.current = (npcId, e) => c.setNpcEngagement(npcId, e);
      tuneAdapterRef.current = (t) => c.setTunables(t);
      const unsubscribe = net?.subscribe((_from, msgs) => c.applyNetInbound(msgs));
      const unsubPresence = net?.subscribePresence?.((p) => c.applyPresence(p));
      const unsubLeave = net?.subscribePresenceLeave?.((id) => c.applyPresenceLeave(id));
      const applyResize = () => c.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
      const ro = new ResizeObserver(applyResize);
      ro.observe(canvas);
      const onMove = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        c.setPointer(e.clientX - rect.left, e.clientY - rect.top);
      };
      const onLeave = () => c.clearPointer();
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerleave", onLeave);

      return () => {
        ro.disconnect();
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerleave", onLeave);
        unsubscribe?.();
        unsubPresence?.();
        unsubLeave?.();
        engageAdapterRef.current = null;
        tuneAdapterRef.current = null;
        c.dispose();
      };
    }

    // ── Main-thread render path (fallback / unsupported) ───────────────────────
    // Face-photo cache (keyed by URL). Loads lazily; faceFor returns the image
    // only once it has actually decoded, else null → the renderer draws a
    // coloured disc + initial. (Face sourcing stays on the MAIN thread — photos +
    // the live local camera — even when the render loop runs in a worker later.)
    const faceImgs = new Map<string, HTMLImageElement>();
    const loadFace = (url: string): HTMLImageElement => {
      let img = faceImgs.get(url);
      if (!img) {
        img = new Image();
        img.decoding = "async";
        img.src = url;
        faceImgs.set(url, img);
      }
      return img;
    };
    // Hidden <video> playing the local camera, drawn LIVE onto the local avatar.
    const selfVideo = document.createElement("video");
    selfVideo.muted = true;
    selfVideo.playsInline = true;
    selfVideo.autoplay = true;
    let appliedSelfStream: MediaStream | null = null;
    const syncSelfVideo = (): void => {
      const stream = selfStreamRef.current ?? null;
      if (stream !== appliedSelfStream) {
        appliedSelfStream = stream;
        selfVideo.srcObject = stream;
      }
      // (Re)start playback if paused — muted autoplay can race; retry each frame.
      if (stream && selfVideo.paused) selfVideo.play().catch(() => { /* retried next frame */ });
    };

    const faceFor = (id: string): CanvasImageSource | null => {
      if (id === localId) {
        // Live local camera, when the camera is actually on.
        syncSelfVideo();
        const liveCam =
          appliedSelfStream &&
          selfVideo.readyState >= 2 &&
          appliedSelfStream.getVideoTracks().some((t) => t.enabled && t.readyState === "live");
        if (liveCam) return selfVideo;
      }
      const url = getFaceUrlRef.current?.(id);
      if (!url) return null;
      const img = loadFace(url);
      return img.complete && img.naturalWidth > 0 ? img : null;
    };
    const labelFor = (id: string): string => getLabelRef.current?.(id) ?? "";

    // The renderer (2D top-down or 3D environment). It owns the camera, so it
    // supplies BOTH the pointer→world aim mapping and the draw call.
    const viewDeps = { canvas, localId, faceFor, labelFor };
    const view: WorldView =
      renderer === "2d" ? createWorld2DView(viewDeps) : createWorld3DView(viewDeps, spec);

    // The per-frame loop (sim + net + render) lives in the framework-free host so
    // the exact same code can run inside the OffscreenCanvas worker later. Here it
    // runs on the main thread, driven by requestAnimationFrame.
    const host = runWorldHost({
      view,
      spec,
      localId,
      spawnIndex,
      spawnAt,
      hostNpcs,
      net: net ? { send: net.send, publishPresence: net.publishPresence } : undefined,
      onNpcProximity: (nearby) => onNpcProximityRef.current?.(nearby),
      scheduleFrame: (cb) => {
        const id = requestAnimationFrame(cb);
        return () => cancelAnimationFrame(id);
      },
      now: () => performance.now(),
      tunables: tunablesRef.current,
    });
    engageAdapterRef.current = (npcId, e) => host.setNpcEngagement(npcId, e);
    tuneAdapterRef.current = (t) => host.setTunables(t);

    // Inbound peer state → host. Mesh: toys/possession (+ avatar when no relay).
    // Relay (Phase 1): remote avatar positions.
    const unsubscribe = net?.subscribe((_from, msgs) => host.applyNetInbound(msgs));
    const unsubPresence = net?.subscribePresence?.((p) => host.applyPresence(p));
    const unsubLeave = net?.subscribePresenceLeave?.((id) => host.applyPresenceLeave(id));

    // Size + pointer input (the host owns DOM measurement on the main thread).
    const applyResize = () => host.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
    applyResize();
    const ro = new ResizeObserver(applyResize);
    ro.observe(canvas);

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      host.setPointer(e.clientX - rect.left, e.clientY - rect.top);
    };
    const onLeave = () => host.clearPointer();
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    host.start();

    return () => {
      host.stop(); // stops the loop + disposes the view
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      unsubscribe?.();
      unsubPresence?.();
      unsubLeave?.();
      engageAdapterRef.current = null;
      tuneAdapterRef.current = null;
      try { selfVideo.pause(); selfVideo.srcObject = null; } catch { /* ignore */ }
    };
  }, [worldSpecKey, worldSpec, net, renderer, renderMode, fallbackEpoch, hostNpcsProp]);

  // Push live tunables (debug menu) into whichever render path is running, without
  // remounting it. Runs after the render effect so the adapter ref is installed.
  useEffect(() => {
    tuneAdapterRef.current?.(tunables);
  }, [tunables]);

  // Push live conversation bias into the hosted NPC bodies. Declared AFTER the
  // render effect so the adapter ref is set before this runs; calls are idempotent
  // so re-pushing the whole map on any change is harmless.
  useEffect(() => {
    const push = engageAdapterRef.current;
    if (!push || !npcEngagements) return;
    for (const [npcId, e] of Object.entries(npcEngagements)) push(npcId, e);
  }, [npcEngagements]);

  return (
    <>
      <canvas
        // Remount on a renderer switch OR a worker→main fallback: a canvas keeps its
        // first context type for life (and transferControlToOffscreen neuters it), so
        // the element itself must be replaced when toggling 2D↔3D or dropping to the
        // main-thread path.
        key={`${renderer}:${renderMode}:${fallbackEpoch}`}
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          touchAction: "none",
          cursor: "crosshair",
        }}
      />
      {debug && (
        <WorldDebugPanel tunables={tunables} onChange={setTunables} renderer={renderer} onClose={onCloseDebug} />
      )}
    </>
  );
}
