// client-aac/src/components/GroupChatHeader.tsx
// Group-chat header — a side-by-side row of the chat's peer faces, shown at the
// top of the screen during a multi-student conversation (shape C). Each face
// shows, in priority order: the peer's LIVE call video (when their camera is
// on), else their stored enrolled photo, else their initial.
//
// Dwelling on / tapping a face FOCUSES that peer: it highlights here and tells
// the server (sendConversationFocus(personId)) so the AI builds phrases
// addressed specifically to them. Tapping the focused face again clears it.
//
// A separate turn cue (server `floor_state`) glows the tile of whoever holds the
// floor / was asked, and shows a "Your turn" pill when it's this student's turn.
// Advisory only — it never blocks input.

import { useCallback, useEffect, useState } from "react";
// Deep import — pure identity-color module, never the world-engine barrel.
import { colorHexForId } from "@shared/world-engine/peer-colors";
import { useDualAgentContextOptional } from "@/contexts/DualAgentContext";
import { useCall } from "@/contexts/CallContext";
import { useLanguage } from "@/contexts/LanguageContext";

/** A peer's live video, when the call has a live video track for them. */
function PeerVideo({ stream }: { stream: MediaStream }) {
  const attach = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && el.srcObject !== stream) el.srcObject = stream;
    },
    [stream],
  );
  return <video ref={attach} autoPlay playsInline muted className="w-full h-full object-cover" />;
}

export function GroupChatHeader({ hidden }: { hidden?: boolean } = {}) {
  const { t } = useLanguage();
  const dual = useDualAgentContextOptional();
  const roster = dual?.conversationRoster ?? [];
  const sendConversationFocus = dual?.sendConversationFocus;
  const floor = dual?.floorState ?? null;

  const { remoteStreams, selfPersonId, callState, activeGame } = useCall();

  // While in a call (e.g. a social game), only show peers actually CONNECTED to
  // the call — drop conversation-room members who aren't in it. Outside a call
  // (utterance-only group chat) show the whole roster.
  const inCall = callState !== "idle";
  const peers = inCall ? roster.filter((p) => remoteStreams.has(p.personId)) : roster;

  const [focused, setFocused] = useState<string | null>(null);

  // Drop a stale focus if the focused peer leaves the chat.
  useEffect(() => {
    if (focused && !peers.some((p) => p.personId === focused)) {
      setFocused(null);
    }
  }, [peers, focused]);

  const toggleFocus = useCallback(
    (personId: string) => {
      const next = focused === personId ? null : personId;
      setFocused(next);
      sendConversationFocus?.(next);
    },
    [focused, sendConversationFocus],
  );

  // During a social-world game, peers render as avatars IN the world — the
  // floating face row at the top is redundant (and overlaps the game), so hide
  // it. Same when the call has been pulled into the big-video window (the faces
  // are in that layout). An iframe-quest game (shared dollhouse) is the
  // EXCEPTION: peers appear in-world only as spark lights, so this row is the
  // student's live view of them — and the gaze target that flips the sidebar
  // to the social board (data-board-focus below).
  const iframeQuest = activeGame?.engine === "iframe-quest";
  if ((activeGame && !iframeQuest) || hidden || peers.length === 0) return null;

  const myTurn = !!floor?.holder && floor.holder === selfPersonId;

  return (
    <div
      className="fixed top-safe-0 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-1 px-4 pt-2 pb-3 pointer-events-none"
      aria-label={t("call.groupChat.peopleInChat")}
    >
      {/* data-board-focus: gazing at a peer's live video flips the in-game
          sidebar to the LLM communication board (see home's SidebarFocusSensor). */}
      <div className="flex items-end gap-3" data-board-focus="social">
        {peers.map((p) => {
          const initial = (p.name ?? "?").trim().charAt(0).toUpperCase();
          const isFocused = focused === p.personId;
          const isTurn = floor?.holder === p.personId; // their turn to speak
          const isAsked = floor?.awaiting === p.personId; // they asked the group
          const stream = remoteStreams.get(p.personId) ?? null;
          const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.readyState === "live" && t.enabled);

          // Ring: amber = the addressee this student selected; emerald glow =
          // whose turn it is; otherwise neutral.
          const ring = isFocused
            ? "ring-amber-400"
            : isTurn
              ? "ring-emerald-400 animate-pulse"
              : isAsked
                ? "ring-sky-400"
                : "ring-white/70 dark:ring-gray-800/70";

          return (
            <button
              key={p.personId}
              type="button"
              data-dwell={`chat-peer-${p.personId}`}
              onClick={() => toggleFocus(p.personId)}
              aria-label={`${isFocused ? t("call.groupChat.talkingTo") : t("call.groupChat.talkTo")} ${p.name}`}
              aria-pressed={isFocused}
              className={`pointer-events-auto flex flex-col items-center gap-1 select-none transition ${
                isFocused || isTurn ? "scale-105" : "opacity-90 hover:opacity-100"
              }`}
            >
              <div
                className={`relative overflow-hidden rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-lg ring-4 transition ${ring}`}
                style={{
                  width: "min(13vw, 72px)",
                  height: "min(13vw, 72px)",
                  // In the shared dollhouse, each peer's spark light carries a
                  // stable color — the same color rims their face here so the
                  // student can match lights to people.
                  ...(iframeQuest ? { boxShadow: `0 0 0 3px ${colorHexForId(p.personId)}` } : {}),
                }}
              >
                {hasVideo && stream ? (
                  <PeerVideo stream={stream} />
                ) : p.photo ? (
                  <img src={p.photo} alt="" className="w-full h-full object-cover" draggable={false} />
                ) : (
                  <span className="font-bold leading-none" style={{ fontSize: "min(6vw, 34px)" }}>
                    {initial}
                  </span>
                )}
              </div>
              <span
                className={`max-w-[80px] truncate text-sm font-semibold px-1.5 rounded ${
                  isFocused ? "bg-amber-400 text-gray-900" : "bg-black/45 text-white"
                }`}
              >
                {p.name}
              </span>
            </button>
          );
        })}
      </div>
      {myTurn && (
        <div className="pointer-events-none rounded-full bg-emerald-500 text-white text-sm font-bold px-3 py-0.5 shadow">
          {t("call.groupChat.yourTurn")}
        </div>
      )}
    </div>
  );
}

export default GroupChatHeader;
