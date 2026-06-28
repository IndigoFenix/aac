// shared/social-world/CallGameSurface.tsx
//
// The in-call game surface. When a call has a game attached, the call panel
// renders THIS over the video — the same world for every participant. SHARED by
// the AAC and clinician clients (the call panel IS the game panel); only the
// surrounding chrome and how it's mounted differ per client.
//
// It maps the call's "world" data channel (sendWorld + the inbound CallWorldHub)
// onto the SocialWorldCanvas net adapter, so each client owns its own avatar and
// the possessed ball, streamed latest-wins over the mesh.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CallGame } from "../realtime-events.js";
import type { NpcSpec, Vec2, WorldNetMessage } from "../world-engine/index.js";
import { getWorldSpec } from "../world-engine/specs/index.js";
import type { NpcProximity } from "./npc-controller.js";
import type { WorldPresence, WorldPresenceChannel } from "./world-presence.js";
import SocialWorldCanvas from "./SocialWorldCanvas";
import NpcConversationDock from "./NpcConversationDock";
import { useNpcConversations, electNpcOwner, type NpcNetMessage } from "./useNpcConversations.js";
import { CallWorldHub, buildSocialWorldNet } from "./call-game-net";

/** Transport for the reliable NPC-conversation relay (`call:npc`). The client wires
 *  this from its CallClient; absent ⇒ solo (no broadcast, this peer owns NPCs). */
export interface NpcTransport {
  send: (msg: NpcNetMessage) => void;
  /** msg is an NpcNetMessage on the wire (typed `unknown` to match the call hub). */
  subscribe: (handler: (fromPersonId: string, msg: unknown) => void) => () => void;
}

const DEFAULT_LABELS: Record<string, string> = {
  "socialWorld.title": "Play with friends",
  "socialWorld.exit": "End game",
  "socialWorld.invite": "Invite",
  "socialWorld.switchView": "Switch view",
};

interface Props {
  game: CallGame;
  /** This client's person id (the avatar it owns). Null until the call is ready. */
  selfPersonId: string | null;
  /** Broadcast outbound world messages over the call's "world" channel. */
  sendWorld: (msgs: WorldNetMessage[]) => void;
  /** Inbound world-message fan-out fed by the CallClient's `worldData` events. */
  hub: CallWorldHub;
  /** Phase 1 position relay: publish the local avatar over the world-wide channel. */
  publishPresence?: (p: WorldPresence) => void;
  /** Phase 1 position relay: inbound remote positions (feeds the circle solver). */
  presenceChannel?: WorldPresenceChannel;
  /** Detach the game (back to plain video) — typically only offered to the host. */
  onExit?: () => void;
  /** Invite more players into the game (e.g. the AAC contact picker). */
  onInvite?: () => void;
  /** Face-photo URL for a participant (drawn into their avatar), or null. */
  getFaceUrl?: (personId: string) => string | null;
  /** Display name for a participant — its initial is the no-photo avatar fallback. */
  getLabel?: (personId: string) => string;
  /** Local camera stream — drawn live onto the local avatar. */
  selfStream?: MediaStream | null;
  /** Resolved absolute ws URL for `/ws/social-bot` (the client builds it from its
   *  API origin). The NPC OWNER opens one session per NPC here; omit to leave NPCs
   *  as silent bodies. */
  npcBrainWsUrl?: string;
  /** Reliable NPC-conversation relay (`call:npc`). Omit in solo. */
  npcTransport?: NpcTransport;
  /** The local player's display name, for utterance attribution in group chat. */
  selfName?: string;
  /** Silence all NPC voice locally (the window's audio-output mute). */
  audioMuted?: boolean;
  /** The local user's latest utterance → a speech bubble over their avatar,
   *  broadcast to peers. Pass a new object (changing `at`) per utterance. */
  selfSpeech?: { text: string; glyph?: string; at: number } | null;
  /** Resolve a composed glyph string to a single self-contained image (data URL)
   *  of the WHOLE glyph, rendered via the shared GlyphCompositor (RTL, modifiers,
   *  emoji and all). Client-supplied; the canvas decodes it for both render paths
   *  and draws it above the avatar at its natural aspect ratio. */
  getGlyphImageUrl?: (glyph: string) => Promise<string | null>;
  /** Optional translator; falls back to English. */
  t?: (key: string) => string;
}

export default function CallGameSurface({ game, selfPersonId, sendWorld, hub, publishPresence, presenceChannel, onExit, onInvite, getFaceUrl, getLabel, selfStream, npcBrainWsUrl, npcTransport, selfName, audioMuted, selfSpeech, getGlyphImageUrl, t }: Props) {
  const tr = (key: string) => {
    const translated = t?.(key);
    return translated && translated !== key ? translated : DEFAULT_LABELS[key] ?? key;
  };

  // The world's NPCs (from its spec) + their live conversations. Proximity from the
  // canvas marks the nearest in-range NPC active; its brain runs over /ws/social-bot.
  const resolvedSpec = useMemo(() => game.worldSpec ?? getWorldSpec(game.worldSpecKey ?? "") ?? null, [game.worldSpec, game.worldSpecKey]);
  const npcs: NpcSpec[] = useMemo(() => resolvedSpec?.npcs ?? [], [resolvedSpec]);
  const npcIdSet = useMemo(() => new Set(npcs.map((n) => n.id)), [npcs]);
  const language = resolvedSpec?.meta.locale ?? "en";

  // Owner election: the lowest participant id hosts every NPC's body + brain (and
  // re-elects as people join/leave). Solo (no id yet) is trivially the owner.
  // presenceChannel.participants() isn't reactive, so bump a tick on its events.
  const [rosterTick, setRosterTick] = useState(0);
  useEffect(() => {
    if (!presenceChannel) return;
    const a = presenceChannel.subscribePresence(() => setRosterTick((n) => n + 1));
    const b = presenceChannel.subscribeLeave(() => setRosterTick((n) => n + 1));
    return () => { a(); b(); };
  }, [presenceChannel]);
  const isOwner = useMemo(() => {
    if (!selfPersonId) return true; // solo / call not ready
    const others = presenceChannel ? presenceChannel.participants().map((p) => p.personId) : [];
    return electNpcOwner(selfPersonId, others) === selfPersonId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfPersonId, presenceChannel, rosterTick]);

  const conv = useNpcConversations({
    wsUrl: npcs.length ? (npcBrainWsUrl ?? null) : null,
    npcs,
    language,
    isOwner,
    selfName: selfName ?? "You",
    resolveName: getLabel,
    muted: audioMuted,
    sendNpc: npcTransport?.send,
  });

  // Route inbound `call:npc` messages: NPC body positions into the world hub (so
  // they render even when the mesh pruned this peer from the owner), the rest into
  // the conversation layer. Via a ref so re-subscription doesn't churn each render.
  const applyInboundRef = useRef(conv.applyInbound);
  applyInboundRef.current = conv.applyInbound;
  useEffect(() => {
    if (!npcTransport) return;
    return npcTransport.subscribe((from, raw) => {
      if (!raw || typeof raw !== "object") return;
      const msg = raw as NpcNetMessage;
      if (msg.k === "pos") {
        if (Array.isArray(msg.avatars)) hub.emit(from, msg.avatars);
      } else {
        applyInboundRef.current(from, msg);
      }
    });
  }, [npcTransport, hub]);

  const setActiveRef = useRef(conv.setActive);
  setActiveRef.current = conv.setActive;
  const onNpcProximity = useCallback((nearby: NpcProximity[]) => {
    setActiveRef.current(nearby[0]?.npcId ?? null);
  }, []);

  const activeState = conv.activeId ? conv.states[conv.activeId] ?? null : null;

  // The OWNER also relays NPC body positions over the reliable channel (throttled),
  // so peers the mesh has pruned still see the NPCs move. Wraps the mesh sender.
  const lastPosRef = useRef(0);
  const sendWorldWrapped = useCallback((msgs: WorldNetMessage[]) => {
    sendWorld(msgs);
    if (!isOwner || !npcTransport || npcIdSet.size === 0) return;
    const now = Date.now();
    if (now - lastPosRef.current < 110) return; // ~8 Hz
    const avatars = msgs.filter((m) => m.t === "avatar" && npcIdSet.has(m.id));
    if (avatars.length) { lastPosRef.current = now; npcTransport.send({ k: "pos", avatars }); }
  }, [sendWorld, isOwner, npcTransport, npcIdSet]);

  // Renderer toggle. 3D is the default immersive environment; 2D is the top-down
  // view — also the motion-comfort fallback (near-zero vection) for anyone the 3D
  // camera makes queasy. Switching remounts the canvas, so the avatar respawns.
  const [viewMode, setViewMode] = useState<"2d" | "3d">("3d");
  // Live tuning panel for the gaze/camera system (debug affordance until the
  // per-student settings surface lands).
  const [debug, setDebug] = useState(false);

  // Networked only once we know our own id; otherwise run the canvas solo so the
  // world still renders while the call finishes connecting. When the relay
  // primitives are supplied, avatar positions ride the world-wide channel.
  const net = useMemo(
    () =>
      selfPersonId
        ? buildSocialWorldNet({ localId: selfPersonId, send: sendWorldWrapped, hub, publishPresence, presence: presenceChannel })
        : undefined,
    [selfPersonId, sendWorldWrapped, hub, publishPresence, presenceChannel],
  );

  // Spawn near whoever is already in the world (so people who enter together land
  // together): the centroid of known peers, or null → the canvas uses the centre.
  const getSpawnHint = useCallback((): Vec2 | null => {
    if (!presenceChannel || !selfPersonId) return null;
    const others = presenceChannel.participants().filter((p) => p.personId !== selfPersonId);
    if (others.length === 0) return null;
    const cx = others.reduce((s, p) => s + p.x, 0) / others.length;
    const cy = others.reduce((s, p) => s + p.y, 0) / others.length;
    return { x: cx, y: cy };
  }, [presenceChannel, selfPersonId]);

  return (
    <div style={{ position: "absolute", inset: 0, background: "#0f172a", overflow: "hidden" }}>
      <SocialWorldCanvas worldSpecKey={game.worldSpecKey} worldSpec={game.worldSpec} net={net} spawnHint={getSpawnHint} getFaceUrl={getFaceUrl} getLabel={getLabel} selfStream={selfStream} renderer={viewMode} hostNpcs={isOwner} onNpcProximity={onNpcProximity} npcEngagements={conv.engagements} debug={debug} onCloseDebug={() => setDebug(false)} selfSpeech={selfSpeech} getGlyphImageUrl={getGlyphImageUrl} />

      {/* Thin top bar: game name + end-game. Kept minimal so the world fills the
          surface; richer chrome (video billboards, controls) is per-client. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          gap: 12,
          background: "linear-gradient(to bottom, rgba(15,23,42,0.75), rgba(15,23,42,0))",
          pointerEvents: "none",
        }}
      >
        <span style={{ color: "#e2e8f0", fontWeight: 600, textShadow: "0 1px 2px rgba(0,0,0,0.6)" }}>
          {game.name ?? tr("socialWorld.title")}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => setDebug((d) => !d)}
            title="Tune gaze/camera (debug)"
            aria-label="Tune gaze/camera (debug)"
            style={{
              pointerEvents: "auto",
              background: debug ? "rgba(56,189,248,0.9)" : "rgba(148,163,184,0.55)",
              color: "#0f172a",
              border: "none",
              borderRadius: 8,
              padding: "8px 12px",
              fontWeight: 700,
              minWidth: 40,
              cursor: "pointer",
            }}
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={() => setViewMode((m) => (m === "3d" ? "2d" : "3d"))}
            data-dwell="social-world-view-toggle"
            title={tr("socialWorld.switchView")}
            aria-label={tr("socialWorld.switchView")}
            style={{
              pointerEvents: "auto",
              background: "rgba(148,163,184,0.9)",
              color: "#0f172a",
              border: "none",
              borderRadius: 8,
              padding: "8px 14px",
              fontWeight: 700,
              minWidth: 44,
              cursor: "pointer",
            }}
          >
            {/* Shows the mode you'll switch TO. */}
            {viewMode === "3d" ? "2D" : "3D"}
          </button>
          {onInvite && (
            <button
              type="button"
              onClick={onInvite}
              data-dwell="social-world-invite"
              style={{
                pointerEvents: "auto",
                background: "rgba(16,185,129,0.95)",
                color: "white",
                border: "none",
                borderRadius: 8,
                padding: "8px 14px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {tr("socialWorld.invite")}
            </button>
          )}
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              data-dwell="social-world-exit"
              style={{
                pointerEvents: "auto",
                background: "rgba(220,38,38,0.9)",
                color: "white",
                border: "none",
                borderRadius: 8,
                padding: "8px 14px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {tr("socialWorld.exit")}
            </button>
          )}
        </div>
      </div>

      {/* In-world conversation dock for the NPC the player is standing next to. */}
      <NpcConversationDock state={activeState} onSend={conv.send} t={t} />
    </div>
  );
}
