// client-aac/src/components/games/CallWorldGameFerry.tsx
//
// Ferry between the call transports and an embedded world-engine game iframe
// (a CallGame with engine "iframe-quest", e.g. the Dollhouse). The iframe is
// transport-blind: it emits/consumes opaque `world_data` (continuous state,
// unreliable mesh "world" channel) and `world_cmd` (discrete commands,
// reliable "aac" data channel) bridge messages; this component moves them
// verbatim in both directions and tells the game its multiplayer identity
// (`world_session` — selfId + owner/follower role).
//
// Lives INSIDE CallProvider (home's body renders outside it and can't
// useCall()); home reaches the outbound senders through `sendersRef` and the
// ferry pushes inbound traffic into the embed via `embedRef`.

import { useEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import { electNpcOwner } from "@shared/social-world/npc-conversation-logic";
import type { WorldCommandMessage } from "@shared/call/call-data-messages";
import { useCall } from "@/contexts/CallContext";
import type { GameEmbedHandle } from "./GameEmbed";

/** Outbound half, exposed to home's game-message handler. */
export interface WorldGameFerrySenders {
  sendWorldData: (msgs: unknown[]) => void;
  sendWorldCmd: (cmd: unknown, toId?: string) => void;
}

/** How often the multiplayer identity is re-asserted. Covers an iframe that
 *  wasn't ready when the roster changed, and embed remounts — `world_session`
 *  is tiny and idempotent. */
const SESSION_RESEND_MS = 3000;

export function CallWorldGameFerry({
  gameId,
  embedRef,
  sendersRef,
  stopGameRef,
}: {
  gameId: string;
  embedRef: RefObject<GameEmbedHandle | null>;
  sendersRef: MutableRefObject<WorldGameFerrySenders | null>;
  /** Lifted stopGame so home (outside CallProvider) can detach the call game
   *  when the student closes the app. */
  stopGameRef?: MutableRefObject<(() => void) | null>;
}) {
  const { game, selfPersonId, remoteStreams, contacts, worldHub, worldCmdHub, sendWorld, sendData, stopGame } =
    useCall();
  const active = game?.engine === "iframe-quest" && game.appId === gameId;

  useEffect(() => {
    if (!stopGameRef) return;
    stopGameRef.current = stopGame;
    return () => {
      stopGameRef.current = null;
    };
  }, [stopGame, stopGameRef]);

  // Read through refs inside subscriptions so they bind once per activation.
  const selfIdRef = useRef(selfPersonId);
  selfIdRef.current = selfPersonId;

  // Outbound: home's onGameMessage forwards the embed's world_data / world_cmd
  // through these. Cast is safe: the payload is the engine's own wire format,
  // produced and consumed by the (vendored) engine on each end.
  useEffect(() => {
    if (!active) return;
    sendersRef.current = {
      sendWorldData: (msgs) => sendWorld(msgs as Parameters<typeof sendWorld>[0]),
      sendWorldCmd: (cmd, toId) =>
        sendData({ k: "world-cmd", gameId, cmd, toId, at: Date.now() }),
    };
    return () => {
      sendersRef.current = null;
    };
  }, [active, gameId, sendWorld, sendData, sendersRef]);

  // Inbound continuous state → iframe.
  useEffect(() => {
    if (!active) return;
    return worldHub.subscribe((fromId, msgs) => {
      embedRef.current?.send({ type: "world_data", fromId, msgs });
    });
  }, [active, worldHub, embedRef]);

  // Inbound reliable commands → iframe (drop other games' and other targets').
  useEffect(() => {
    if (!active) return;
    return worldCmdHub.subscribe((fromId, raw) => {
      const wc = raw as WorldCommandMessage;
      if (wc.gameId !== gameId) return;
      if (wc.toId && wc.toId !== selfIdRef.current) return;
      embedRef.current?.send({ type: "world_cmd", fromId, cmd: wc.cmd });
    });
  }, [active, gameId, worldCmdHub, embedRef]);

  // Multiplayer identity: exactly one owner per call, elected as the smallest
  // personId among MESH-CONNECTED peers (self + remoteStreams) — the same
  // basis on every client, so all peers converge on one owner as streams
  // land. Re-sent on roster change and on a slow heartbeat.
  useEffect(() => {
    if (!active || !selfPersonId) return;
    const send = () => {
      const ownerId = electNpcOwner(selfPersonId, remoteStreams.keys());
      embedRef.current?.send({
        type: "world_session",
        selfId: selfPersonId,
        role: ownerId === selfPersonId ? "owner" : "follower",
        peers: Array.from(remoteStreams.keys()).map((id) => ({
          id,
          name: contacts.find((c) => c.personId === id)?.name ?? undefined,
        })),
      });
    };
    send();
    const timer = setInterval(send, SESSION_RESEND_MS);
    return () => clearInterval(timer);
  }, [active, selfPersonId, remoteStreams, contacts, embedRef]);

  return null;
}
