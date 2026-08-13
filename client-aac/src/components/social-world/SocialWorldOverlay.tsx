// client-aac/src/components/social-world/SocialWorldOverlay.tsx
//
// AAC mount for the shared in-call game surface, plus a tiny reporter that lifts
// the "is a game active" signal up to home.tsx (home renders the game-mode
// layout — header hidden, context buttons swapped for the main board's 8 buttons
// beside the game — but lives OUTSIDE CallProvider, so it can't read useCall()).
//
// The game itself renders into a host element home places in the board region,
// so it sits ABOVE the game window and the quick buttons stay visible. "End
// game" leaves whichever game is active (a call's game detaches; a solo one
// stops).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CallGame } from "@shared/realtime-events";
import CallGameSurface from "@shared/social-world/CallGameSurface";
import { useCall } from "@/contexts/CallContext";
import { useDualAgentContextOptional } from "@/contexts/DualAgentContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { glyphBubbleImageUrl } from "@/lib/glyphRaster";

/** Resolve a backend ws:// URL, honoring VITE_API_URL (baked for the Electron AAC). */
function resolveAacWsUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
  if (base) {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = path;
    return url.toString();
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

/** One remote participant's video tile for the in-game people panel. `gain` is
 *  the proximity media-gate volume (1 = in your circle; <1 = fading at the edge). */
function PeerTile({ stream, name, gain }: { stream: MediaStream; name: string | null; gain: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attach = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el) {
      if (el.srcObject !== stream) el.srcObject = stream;
      el.volume = gain;
    }
  }, [stream, gain]);
  // Keep volume in sync as the peer moves through the hysteresis band.
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = gain;
  }, [gain]);
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-black/60">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- live WebRTC peer feed */}
      <video ref={attach} autoPlay playsInline className="h-full w-full object-cover" />
      {name && (
        <div className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 py-0.5 text-center text-xs text-white">
          {name}
        </div>
      )}
    </div>
  );
}

/** The other people in the call, shown opposite the button sidebar during a
 *  game. Portaled into a home-provided host so it lives in the board row but can
 *  read the call context. Renders nothing (zero width) when nobody else has
 *  joined — so a solo game keeps the full game window. */
export function SocialWorldPeople({ host }: { host: HTMLElement | null }) {
  const { activeGame, remoteStreams, contacts, peerGains } = useCall();
  const { t } = useLanguage();
  // iframe-quest games (shared Dollhouse) render through the active-app path,
  // not the social-game layout — this panel's host doesn't even exist then.
  if (!activeGame || activeGame.engine === "iframe-quest" || !host) return null;
  const nameFor = (personId: string) => contacts.find((c) => c.personId === personId)?.name ?? null;
  // In a conversation-circle game the panel shows only the student's CIRCLE
  // (in-range peers); everyone else still exists as an avatar in the world.
  // Non-circle games show every participant. The panel is ALWAYS rendered at a
  // constant width (even when empty) so the game window never resizes.
  const circlesOn = !!activeGame.conversationCircles;
  const entries = Array.from(remoteStreams.entries()).filter(
    ([personId]) => !circlesOn || peerGains.has(personId),
  );
  return createPortal(
    <div className="flex h-full w-full flex-col gap-2 overflow-auto bg-black/20 p-2">
      {entries.length === 0 ? (
        <div className="flex h-full items-center justify-center px-1 text-center text-xs text-white/40">
          {t("socialWorld.noOneNearby")}
        </div>
      ) : (
        entries.map(([personId, stream]) => (
          <PeerTile key={personId} stream={stream} name={nameFor(personId)} gain={peerGains.get(personId) ?? 1} />
        ))
      )}
    </div>,
    host,
  );
}

/** Lifts the active-game value to home so it can re-flow the layout. */
export function SocialGameReporter({ onChange }: { onChange: (game: CallGame | null) => void }) {
  const { activeGame } = useCall();
  useEffect(() => { onChange(activeGame); }, [activeGame, onChange]);
  return null;
}

/** Renders the game surface into the home-provided host (board region). `selfSpeech`
 *  is the student's latest spoken statement (text + the pressed button's glyph),
 *  shown as a bubble over their avatar and broadcast to peers. */
export function SocialWorldOverlay({ host, selfSpeech }: { host: HTMLElement | null; selfSpeech?: { text: string; glyph?: string; at: number } | null }) {
  const { activeGame, selfPersonId, sendWorld, worldHub, sendNpc, npcHub, publishPresence, presenceChannel, localStream, endGame, inviteIntoCall, contacts, contactsLoading, refreshContacts } = useCall();
  const { t } = useLanguage();
  const dual = useDualAgentContextOptional();
  const [showInvite, setShowInvite] = useState(false);

  // Avatar faces/names come from the group-chat roster (enrolled photos + names).
  const roster = dual?.conversationRoster ?? [];
  const getFaceUrl = useCallback(
    (personId: string) => roster.find((p) => p.personId === personId)?.photo ?? null,
    [roster],
  );
  const getLabel = useCallback(
    (personId: string) => roster.find((p) => p.personId === personId)?.name ?? "",
    [roster],
  );

  // NPC conversation transport (reliable call:npc) + the student's own name for
  // attribution + the brain WS URL (owner opens one /ws/social-bot per NPC).
  const npcTransport = useMemo(() => ({ send: sendNpc, subscribe: npcHub.subscribe.bind(npcHub) }), [sendNpc, npcHub]);
  const npcBrainWsUrl = useMemo(() => resolveAacWsUrl("/ws/social-bot"), []);
  const selfName = roster.find((p) => p.personId === selfPersonId)?.name ?? "";

  useEffect(() => { if (showInvite) refreshContacts(); }, [showInvite, refreshContacts]);

  // iframe-quest games mount their own embed via the active-app path; the
  // canvas surface here is only for "aivota-world" (SocialWorldCanvas) games.
  if (!activeGame || activeGame.engine === "iframe-quest" || !host) return null;
  return createPortal(
    <>
      <CallGameSurface
        game={activeGame}
        selfPersonId={selfPersonId}
        sendWorld={sendWorld}
        hub={worldHub}
        publishPresence={publishPresence}
        presenceChannel={presenceChannel}
        getFaceUrl={getFaceUrl}
        getLabel={getLabel}
        selfStream={localStream}
        npcBrainWsUrl={npcBrainWsUrl}
        npcTransport={npcTransport}
        selfName={selfName}
        audioMuted={dual?.audioEnabled === false}
        selfSpeech={selfSpeech}
        getGlyphImageUrl={glyphBubbleImageUrl}
        onExit={endGame}
        onInvite={() => setShowInvite(true)}
        t={t}
      />
      {showInvite && (
        // Pick a friend to ring into the game. Dwell-trap so gaze stays inside.
        <div className="absolute inset-0 z-10 flex flex-col bg-slate-950/95 p-6 text-white" data-dwell-trap>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-2xl font-bold">{t("socialWorld.invite")}</h2>
            <button
              type="button"
              data-dwell="invite-close"
              onClick={() => setShowInvite(false)}
              className="rounded-lg bg-white/15 px-4 py-2 text-lg font-medium hover:bg-white/25"
            >
              {t("common.close")}
            </button>
          </div>
          {contactsLoading ? (
            <div className="flex flex-1 items-center justify-center text-xl text-white/60">
              {t("common.loading")}
            </div>
          ) : contacts.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-xl text-white/60">
              {t("call.noCallableContacts")}
            </div>
          ) : (
            <div className="grid flex-1 gap-4 overflow-auto" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
              {contacts.map((c) => (
                <button
                  key={c.contactId}
                  type="button"
                  {...(c.online ? { "data-dwell": `invite-${c.contactId}` } : {})}
                  disabled={!c.online}
                  onClick={() => { if (c.online) { inviteIntoCall(c.contactId); setShowInvite(false); } }}
                  className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 p-4 ${
                    c.online ? "border-emerald-400/40 bg-white/10 hover:bg-white/20" : "border-white/10 bg-white/5 opacity-50"
                  }`}
                >
                  <div className="flex items-center justify-center rounded-full bg-emerald-600" style={{ width: "min(16vw, 110px)", height: "min(16vw, 110px)" }}>
                    <span className="font-bold leading-none" style={{ fontSize: "min(8vw, 56px)" }}>
                      {(c.name ?? "?").trim().charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="w-full truncate text-center text-lg font-medium">{c.name}</div>
                  <div className="text-sm text-white/70">{c.online ? t("call.online") : t("call.offline")}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>,
    host,
  );
}
