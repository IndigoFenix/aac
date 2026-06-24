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

import { useEffect, useRef } from "react";
import {
  applyInbound,
  applyRemoteAvatar,
  collectOutbound,
  createWorldState,
  removeAvatar,
  smoothRemoteAvatars,
  tickWorld,
  type Vec2,
  type WorldNetMessage,
  type WorldSpec,
  type WorldState,
} from "../world-engine/index.js";
import type { WorldPresence } from "./world-presence.js";
import { getWorldSpec, socialFieldSpec } from "../world-engine/specs/index.js";
import { followCamera, renderWorld2D, screenToWorld } from "../world-engine/render2d.js";

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
}

const SEND_INTERVAL_MS = 1000 / 15; // ~15 Hz mesh world-state (toys/possession)
const PRESENCE_INTERVAL_MS = 1000 / 8; // ~8 Hz relay position (cheap, position-only)
/** World units shown across the smaller screen dimension by the follow camera. */
const FOLLOW_VIEW_SPAN = 30;

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

export default function SocialWorldCanvas({ worldSpecKey, worldSpec, net, spawnHint, getFaceUrl, getLabel, selfStream }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const spec = worldSpec ?? getWorldSpec(worldSpecKey ?? "social-field") ?? socialFieldSpec;
    const localId = net?.localId ?? "you";
    // Spawn near whoever is already here (so people entering together cluster),
    // else the field centre — plus a small offset to avoid exact stacking.
    const base = spawnHintRef.current?.() ?? { x: spec.manifold.width / 2, y: spec.manifold.height / 2 };
    const off = spawnOffset(localId);
    const state: WorldState = createWorldState(
      spec,
      localId,
      spawnIndexFor(localId, spec.spawns.length),
      { x: base.x + off.x, y: base.y + off.y },
    );

    // Last pointer position in CSS pixels (relative to the canvas), or null when
    // the gaze/cursor has left. The world aim is derived from it EACH FRAME
    // against the moving follow camera, so the avatar tracks the screen point the
    // user is looking at even as the camera scrolls.
    let pointer: { x: number; y: number } | null = null;
    let raf = 0;
    let last = performance.now();
    let lastSend = 0;
    let lastPresence = 0;
    let pendingEvents: ReturnType<typeof tickWorld>["events"] = [];

    // Inbound peer state (networked only). Mesh: toys/possession (+ avatar when
    // no relay). Relay (Phase 1): remote avatar positions, applied per message.
    const unsubscribe = net?.subscribe((_from, msgs) => {
      for (const m of msgs) applyInbound(state, m);
    });
    const unsubPresence = net?.subscribePresence?.((p) => {
      if (p.personId === localId) return; // never let the relay move our own avatar
      applyRemoteAvatar(state, { id: p.personId, x: p.x, y: p.y, fx: p.fx, fy: p.fy, vx: p.vx, vy: p.vy });
    });
    const unsubLeave = net?.subscribePresenceLeave?.((id) => removeAvatar(state, id));

    // Face-photo cache (keyed by URL). Loads lazily; faceFor returns the image
    // only once it has actually decoded, else null → the renderer draws a
    // coloured disc + initial.
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

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Camera follows the local avatar at a fixed zoom (field is larger than view).
    const camFor = () => {
      const me = state.avatars[localId];
      const center = me ?? { x: spec.manifold.width / 2, y: spec.manifold.height / 2 };
      return followCamera(canvas.clientWidth, canvas.clientHeight, center, FOLLOW_VIEW_SPAN);
    };

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onLeave = () => { pointer = null; };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const cam = camFor();
      const aim: Vec2 | null = pointer ? screenToWorld(cam, pointer.x, pointer.y) : null;
      const { events } = tickWorld(state, { aim }, dt);
      // Glide remote avatars between network packets (dead-reckon + ease) so their
      // motion isn't jittery at the relay/mesh update rate.
      smoothRemoteAvatars(state, dt);

      if (net) {
        if (events.length) pendingEvents.push(...events);

        // Avatar position → world-wide RELAY (Phase 1). Position-only, lower rate.
        if (net.publishPresence && now - lastPresence >= PRESENCE_INTERVAL_MS) {
          const local = state.avatars[localId];
          if (local) {
            net.publishPresence({
              personId: localId,
              x: local.x, y: local.y,
              fx: local.fx, fy: local.fy,
              vx: local.vx, vy: local.vy,
            });
          }
          lastPresence = now;
        }

        // Avatar + toys/possession → mesh (the WORLD layer). Every participant
        // stays on the data mesh and streams its avatar, so EVERYONE renders as a
        // game object regardless of whether their live A/V is in range — only the
        // audio/video is proximity-gated (by the call context), not the world.
        // (The relay still publishes positions above for the circle solver; it
        // becomes the avatar source again if/when connections are gated for very
        // large worlds.)
        if (now - lastSend >= SEND_INTERVAL_MS) {
          net.send(collectOutbound(state, pendingEvents));
          pendingEvents = [];
          lastSend = now;
        }
      }

      renderWorld2D(ctx, state, cam, {
        localId,
        viewWidth: canvas.clientWidth,
        viewHeight: canvas.clientHeight,
        faceFor,
        labelFor,
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      unsubscribe?.();
      unsubPresence?.();
      unsubLeave?.();
      try { selfVideo.pause(); selfVideo.srcObject = null; } catch { /* ignore */ }
    };
  }, [worldSpecKey, worldSpec, net]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        touchAction: "none",
        cursor: "crosshair",
      }}
    />
  );
}
