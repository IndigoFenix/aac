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

import { useCallback, useMemo } from "react";
import type { CallGame } from "../realtime-events.js";
import type { Vec2, WorldNetMessage } from "../world-engine/index.js";
import type { WorldPresence, WorldPresenceChannel } from "./world-presence.js";
import SocialWorldCanvas from "./SocialWorldCanvas";
import { CallWorldHub, buildSocialWorldNet } from "./call-game-net";

const DEFAULT_LABELS: Record<string, string> = {
  "socialWorld.title": "Play with friends",
  "socialWorld.exit": "End game",
  "socialWorld.invite": "Invite",
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
  /** Optional translator; falls back to English. */
  t?: (key: string) => string;
}

export default function CallGameSurface({ game, selfPersonId, sendWorld, hub, publishPresence, presenceChannel, onExit, onInvite, getFaceUrl, getLabel, selfStream, t }: Props) {
  const tr = (key: string) => {
    const translated = t?.(key);
    return translated && translated !== key ? translated : DEFAULT_LABELS[key] ?? key;
  };

  // Networked only once we know our own id; otherwise run the canvas solo so the
  // world still renders while the call finishes connecting. When the relay
  // primitives are supplied, avatar positions ride the world-wide channel.
  const net = useMemo(
    () =>
      selfPersonId
        ? buildSocialWorldNet({ localId: selfPersonId, send: sendWorld, hub, publishPresence, presence: presenceChannel })
        : undefined,
    [selfPersonId, sendWorld, hub, publishPresence, presenceChannel],
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
      <SocialWorldCanvas worldSpecKey={game.worldSpecKey} worldSpec={game.worldSpec} net={net} spawnHint={getSpawnHint} getFaceUrl={getFaceUrl} getLabel={getLabel} selfStream={selfStream} />

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
    </div>
  );
}
