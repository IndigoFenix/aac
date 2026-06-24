import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Loader2, Gamepad2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useInstitute } from "@/hooks/useInstitute";
import { cn } from "@/lib/utils";
import CallGameSurface from "@shared/social-world/CallGameSurface";
import type { CallGame } from "@shared/realtime-events";
import { useCall } from "./CallContext";
import { fetchSocialGameOptions } from "./api";

/** One remote participant's video tile for the in-game people sidebar. `gain` is
 *  the proximity volume (1 = in the circle; <1 = fading at the edge). */
function PeerVideoTile({ stream, name, gain }: { stream: MediaStream; name: string | null; gain: number }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const attach = useCallback((el: HTMLVideoElement | null) => {
    ref.current = el;
    if (el) {
      if (el.srcObject !== stream) el.srcObject = stream;
      el.volume = gain;
    }
  }, [stream, gain]);
  useEffect(() => { if (ref.current) ref.current.volume = gain; }, [gain]);
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-black/60">
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

/** In-call full-screen overlay: remote video, self-view, and call controls. */
export function CallView() {
  const { t } = useLanguage();
  const { currentInstitute } = useInstitute();
  const {
    callState,
    localStream,
    remoteStreams,
    activeContactName,
    audioEnabled,
    videoEnabled,
    toggleAudio,
    toggleVideo,
    hangUp,
    cancel,
    participants,
    addressee,
    setAddressee,
    addressedBy,
    selfTranscript,
    game,
    startGame,
    stopGame,
    selfPersonId,
    sendWorld,
    worldHub,
    publishPresence,
    presenceChannel,
    peerGains,
  } = useCall();

  const remoteEntry = useMemo(() => {
    const first = remoteStreams.entries().next();
    return first.done ? null : first.value;
  }, [remoteStreams]);
  const remoteStream = remoteEntry?.[1] ?? null;
  // Proximity volume for the displayed peer (1 unless they're fading at the edge
  // of the circle); applied to the remote <video> below.
  const remoteGain = remoteEntry ? peerGains.get(remoteEntry[0]) ?? 1 : 1;

  // During a game the peers move into a video SIDEBAR (the call panel is the game
  // panel). In a conversation-circle game it shows only the local circle; a plain
  // multiplayer game shows everyone. Names come from the conversation roster.
  const gameSidebar = useMemo(() => {
    if (!game) return [] as Array<[string, MediaStream]>;
    const circlesOn = !!game.conversationCircles;
    return Array.from(remoteStreams.entries()).filter(([pid]) => !circlesOn || peerGains.has(pid));
  }, [game, remoteStreams, peerGains]);

  // Avatar labels (the clinician roster has no photos, so avatars fall back to
  // name initials + colour).
  const getLabel = useCallback(
    (personId: string) => participants.find((p) => p.personId === personId)?.name ?? "",
    [participants],
  );

  // In-call game picker: the built-in default + the institute's multiplayer apps.
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  const [gameOptions, setGameOptions] = useState<CallGame[] | null>(null);
  const [gameOptionsLoading, setGameOptionsLoading] = useState(false);

  const openGameMenu = useCallback(() => {
    setGameMenuOpen(true);
    if (gameOptions || !currentInstitute?.id) return;
    setGameOptionsLoading(true);
    fetchSocialGameOptions(currentInstitute.id)
      .then(setGameOptions)
      .catch((err) => console.warn("[CallView] failed to load social games:", err))
      .finally(() => setGameOptionsLoading(false));
  }, [gameOptions, currentInstitute?.id]);

  const pickGame = useCallback((g: CallGame) => {
    startGame(g);
    setGameMenuOpen(false);
  }, [startGame]);

  // Callback refs: fire both when the stream changes AND when the (conditionally
  // mounted) <video> attaches, so srcObject is set even if the stream arrived
  // before the element mounted.
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const attachRemote = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
    if (el) {
      if (el.srcObject !== remoteStream) el.srcObject = remoteStream;
      el.volume = remoteGain;
    }
  }, [remoteStream, remoteGain]);
  // Keep volume synced as the peer moves through the hysteresis band.
  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.volume = remoteGain;
  }, [remoteGain]);

  const attachLocal = useCallback((el: HTMLVideoElement | null) => {
    if (el && el.srcObject !== localStream) el.srcObject = localStream;
  }, [localStream]);

  if (callState === "idle") return null;

  const isConnecting = callState === "ringing-out" || callState === "connecting";
  const isActive = callState === "active";
  const statusText =
    callState === "ringing-out"
      ? t("call.calling")
      : callState === "connecting"
        ? t("call.connecting")
        : "";

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/95 text-white"
      role="dialog"
      aria-modal="true"
      aria-label={t("call.title")}
    >
      {/* Addressee picker — only when there are multiple other participants, so
          the clinician can clarify who they're speaking to. Click a face to
          select; click again (or "Everyone") to clear. */}
      {isActive && participants.length > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-2 px-4 pt-3 pb-1">
          <span className="text-xs uppercase tracking-wide text-white/60 me-1">
            {t("call.whoTalkingTo")}
          </span>
          <button
            type="button"
            onClick={() => setAddressee(null)}
            aria-pressed={addressee === null}
            className={cn(
              "rounded-full px-3 py-1 text-sm font-medium transition",
              addressee === null ? "bg-amber-400 text-gray-900" : "bg-white/15 text-white hover:bg-white/25",
            )}
          >
            {t("call.everyone")}
          </button>
          {participants.map((p) => {
            const selected = addressee === p.personId;
            const initial = (p.name ?? "?").trim().charAt(0).toUpperCase();
            return (
              <button
                key={p.personId}
                type="button"
                onClick={() => setAddressee(selected ? null : p.personId)}
                aria-pressed={selected}
                aria-label={`${t("call.speakTo")} ${p.name}`}
                className={cn(
                  "flex items-center gap-2 rounded-full ps-1 pe-3 py-1 text-sm font-medium transition",
                  selected ? "bg-amber-400 text-gray-900" : "bg-white/15 text-white hover:bg-white/25",
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold",
                    selected ? "bg-gray-900/20 text-gray-900" : "bg-emerald-600 text-white",
                  )}
                >
                  {initial}
                </span>
                <span className="max-w-[8rem] truncate">{p.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* "X is talking to you" — when a participant turns to address the
          clinician (their AI selected this user, or they tapped the face). */}
      {isActive && addressedBy && participants.some((p) => p.personId === addressedBy.fromPersonId) && (
        <div className="flex justify-center pb-1">
          <span className="rounded-full bg-emerald-500/90 px-3 py-1 text-sm font-semibold text-white shadow">
            {addressedBy.fromName} {t("call.isTalkingToYou")}
          </span>
        </div>
      )}

      {/* Remote / status area. During a game it's a row: [peer sidebar][game]. */}
      <div className="relative flex-1 min-h-0 flex items-stretch">
        {/* Peer video sidebar — only during a game (start side; self-view is at
            the end, so they don't collide, in LTR or RTL). */}
        {isActive && game && (
          <div className="flex w-32 shrink-0 flex-col gap-2 overflow-auto bg-black/30 p-2">
            {gameSidebar.length === 0 ? (
              <div className="flex h-full items-center justify-center px-1 text-center text-xs text-white/40">
                {t("socialWorld.noOneNearby")}
              </div>
            ) : (
              gameSidebar.map(([pid, stream]) => (
                <PeerVideoTile
                  key={pid}
                  stream={stream}
                  name={participants.find((p) => p.personId === pid)?.name ?? null}
                  gain={peerGains.get(pid) ?? 1}
                />
              ))
            )}
          </div>
        )}

        {/* Main area: the remote feed (plain call) or the game surface. */}
        <div className="relative flex-1 min-h-0 flex items-center justify-center">
          {isActive && remoteStream && !game ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- live WebRTC call stream; captions cannot be supplied for a real-time peer feed
            <video
              ref={attachRemote}
              autoPlay
              playsInline
              className="h-full w-full object-contain"
              aria-label={activeContactName ?? t("call.remoteVideo")}
            />
          ) : (
            !game && (
              <div className="flex flex-col items-center gap-4">
                {isConnecting && <Loader2 className="w-10 h-10 animate-spin" aria-hidden="true" />}
                <div className="text-xl font-medium">{activeContactName ?? t("call.title")}</div>
                {statusText && <div className="text-sm text-white/70">{statusText}</div>}
              </div>
            )
          )}

          {/* Social-game surface — fills the main area when a game is attached
              (the call panel IS the game panel). Peers are in the sidebar; "End
              game" detaches it back to plain video. */}
          {isActive && game && (
            <CallGameSurface
              game={game}
              selfPersonId={selfPersonId}
              sendWorld={sendWorld}
              hub={worldHub}
              publishPresence={publishPresence}
              presenceChannel={presenceChannel}
              getLabel={getLabel}
              selfStream={localStream}
              onExit={stopGame}
              t={t}
            />
          )}
        </div>

        {/* Self-view */}
        {localStream && (
          <video
            ref={attachLocal}
            autoPlay
            playsInline
            muted
            className={cn(
              "absolute bottom-4 end-4 w-32 sm:w-44 aspect-video rounded-lg border border-white/20 object-cover shadow-lg bg-black",
              !videoEnabled && "opacity-40",
            )}
            aria-label={t("call.selfVideo")}
          />
        )}
      </div>

      {/* Live self-caption — what the server's speech recognizer is hearing from
          this caller. Confirms speech is (or isn't) being transcribed. */}
      {isActive && selfTranscript && (
        <div className="flex justify-center px-4 pb-2">
          <span className="max-w-2xl rounded-lg bg-black/60 px-3 py-1.5 text-center text-sm text-white/90">
            {selfTranscript}
          </span>
        </div>
      )}

      {/* Game picker — opens above the controls when the clinician taps the
          gamepad with no game running. Lists the built-in default + the
          institute's multiplayer custom apps. */}
      {isActive && gameMenuOpen && !game && (
        <div className="flex justify-center px-4 pb-2">
          <div className="w-full max-w-md rounded-xl bg-white/10 backdrop-blur p-2">
            <div className="px-2 py-1 text-xs uppercase tracking-wide text-white/60">
              {t("socialWorld.pick")}
            </div>
            {gameOptionsLoading && !gameOptions ? (
              <div className="px-2 py-3 text-sm text-white/70">{t("common.loading")}</div>
            ) : (
              <div className="flex flex-col gap-1">
                {(gameOptions ?? []).map((g) => (
                  <button
                    key={g.appId}
                    type="button"
                    onClick={() => pickGame(g)}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 text-start text-white hover:bg-white/15"
                  >
                    <Gamepad2 className="w-4 h-4 shrink-0" />
                    <span className="truncate">{g.name ?? t("socialWorld.title")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-center gap-4 py-6">
        <Button
          type="button"
          size="icon"
          variant={audioEnabled ? "secondary" : "destructive"}
          onClick={() => toggleAudio(!audioEnabled)}
          aria-label={audioEnabled ? t("call.mute") : t("call.unmute")}
          aria-pressed={!audioEnabled}
          data-testid="call-toggle-audio"
        >
          {audioEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
        </Button>

        <Button
          type="button"
          size="icon"
          variant={videoEnabled ? "secondary" : "destructive"}
          onClick={() => toggleVideo(!videoEnabled)}
          aria-label={videoEnabled ? t("call.cameraOff") : t("call.cameraOn")}
          aria-pressed={!videoEnabled}
          data-testid="call-toggle-video"
        >
          {videoEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
        </Button>

        {/* Start (open the game picker) / end the social game on the call. */}
        {isActive && (
          <Button
            type="button"
            size="icon"
            variant={game ? "default" : "secondary"}
            onClick={() => (game ? stopGame() : gameMenuOpen ? setGameMenuOpen(false) : openGameMenu())}
            aria-label={game ? t("socialWorld.exit") : t("socialWorld.start")}
            aria-pressed={!!game || gameMenuOpen}
            data-testid="call-toggle-game"
          >
            <Gamepad2 className="w-5 h-5" />
          </Button>
        )}

        <Button
          type="button"
          size="icon"
          variant="destructive"
          onClick={() => (callState === "ringing-out" ? cancel() : hangUp())}
          aria-label={t("call.hangUp")}
          data-testid="call-hang-up"
        >
          <PhoneOff className="w-5 h-5" />
        </Button>
      </div>
    </div>
  );
}
