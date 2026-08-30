import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Loader2, Gamepad2, Volume2, VolumeX, UserPlus, Braces, Hand, MonitorUp } from "lucide-react";
import { InvitePeoplePopup } from "./InvitePeoplePopup";
import { GameJsonEditor } from "./GameJsonEditor";
import { MirroredBoardView } from "./MirroredBoardView";
import { StudentSplitView } from "./StudentSplitView";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useInstitute } from "@/hooks/useInstitute";
import { cn } from "@/lib/utils";
import CallGameSurface from "@shared/social-world/CallGameSurface";
import VideoTileLayout, { type VideoTileData } from "@shared/social-world/VideoTileLayout";
import { pickSpotlightId, VIDEO_LAYOUT_MODES, type VideoLayoutMode } from "@shared/call/video-layout";
import { STUDENT_VIEW_MODES, type StudentSurface, type StudentViewMode } from "@shared/call/student-view";
import type { CallGame } from "@shared/realtime-events";
import type { BoardButton } from "@shared/schema";
import { useCall } from "./CallContext";
import { fetchSocialGameOptions } from "./api";
import IframeQuestSurface, { colorForPeerId } from "./IframeQuestSurface";

/** Resolve a backend ws:// URL, honoring VITE_API_URL (the clinician dev server
 *  doesn't proxy /ws). Mirrors usePersonChatSocket / CallContext. */
function resolveCallWsUrl(path: string): string {
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

/** One remote participant's video tile for the in-game people sidebar. `gain` is
 *  the proximity volume (1 = in the circle; <1 = fading at the edge).
 *  `borderColor` tints the tile's ring — during an iframe world game it matches
 *  the peer's in-game color so faces map to avatars. */
function PeerVideoTile({ stream, name, borderColor }: { stream: MediaStream; name: string | null; borderColor?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  // Visual only — audio is owned by CallAudioSinks for the whole call.
  const attach = useCallback((el: HTMLVideoElement | null) => {
    ref.current = el;
    if (el) {
      if (el.srcObject !== stream) el.srcObject = stream;
      el.muted = true;
    }
  }, [stream]);
  return (
    <div
      className="relative aspect-square w-full overflow-hidden rounded-lg bg-black/60"
      style={borderColor ? { border: `2px solid ${borderColor}` } : undefined}
    >
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
    outputMuted,
    setOutputMuted,
    toggleAudio,
    toggleVideo,
    hangUp,
    cancel,
    participants,
    addressee,
    setAddressee,
    addressedBy,
    selfTranscript,
    lastSelfSpeech,
    game,
    startGame,
    stopGame,
    invitePeopleIntoCall,
    selfPersonId,
    sendWorld,
    worldHub,
    sendNpc,
    npcHub,
    publishPresence,
    presenceChannel,
    peerGains,
    activeSpeakerId,
    mirroredBoard,
    mirroredDwell,
    mirroredSelection,
    sendData,
    sendBuilderPress,
    facilitatorAck,
    indicateButton,
    screenStreams,
    screenRequested,
    requestScreenShare,
  } = useCall();
  const [invitePopupOpen, setInvitePopupOpen] = useState(false);
  // Multi-participant video layout (spotlight / grid / compact / auto) + the
  // pinned prominent peer (click a tile to pin).
  const [layoutMode, setLayoutMode] = useState<VideoLayoutMode>("spotlight");
  const [pinnedPeer, setPinnedPeer] = useState<string | null>(null);
  // "See their screen": video only, the student's mirrored screen only, or BOTH
  // side by side. Split is the useful default once a mirror exists — the grid
  // says what they pressed, the face says whether they meant it, and a clinician
  // reading intent needs the two together. "Interact" arms facilitator presses.
  const [studentView, setStudentView] = useState<StudentViewMode>("video");
  const [interactArmed, setInteractArmed] = useState(false);
  // The button this clinician is POINTING at (press-and-hold), so their own
  // copy shows the mark they just put on the child's screen.
  const [indicatedId, setIndicatedId] = useState<string | null>(null);
  // Live game-JSON editor (testing affordance): edit the running game and reload
  // it for everyone in the call.
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);

  // Reliable NPC-conversation transport (call:npc) + the brain WS URL.
  const npcTransport = useMemo(() => ({ send: sendNpc, subscribe: npcHub.subscribe.bind(npcHub) }), [sendNpc, npcHub]);
  const npcBrainWsUrl = useMemo(() => resolveCallWsUrl("/ws/social-bot"), []);

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
  // Stored-face photo for an in-game avatar (the roster carries them for peers,
  // including AAC students, so their faces show instead of plain discs).
  const getFaceUrl = useCallback(
    (personId: string) => participants.find((p) => p.personId === personId)?.photo ?? null,
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

  // Output mute: silence ALL audio this window plays (the remote peers + the
  // game's NPC voices). Distinct from the mic toggle, which mutes what we SEND.
  // Handy for testing on one machine (mute one window, listen on the other)
  // without feedback.
  // It lives in CallContext, not here: CallAudioSinks owns the call's audio for
  // the whole call, so the control over it must outlive this panel.

  const attachLocal = useCallback((el: HTMLVideoElement | null) => {
    if (el && el.srcObject !== localStream) el.srcObject = localStream;
  }, [localStream]);

  // Tiles for the multi-participant layout (plain video, no game). Speaker
  // highlight follows the active-speaker detector; gain follows proximity.
  const videoTiles: VideoTileData[] = useMemo(
    () => Array.from(remoteStreams.entries()).map(([personId, stream]) => {
      const p = participants.find((x) => x.personId === personId);
      return {
        personId,
        stream,
        name: p?.name ?? null,
        photoUrl: p?.photo ?? null,
        speaking: personId === activeSpeakerId,
      };
    }),
    [remoteStreams, participants, activeSpeakerId],
  );
  const spotlightId = useMemo(
    () => pickSpotlightId(videoTiles.map((x) => x.personId), { manualPin: pinnedPeer, activeSpeakerId }),
    [videoTiles, pinnedPeer, activeSpeakerId],
  );

  // Facilitator press: the clinician pressed a button on the mirrored board.
  // Routed to the AAC over the reliable channel; the student's own pipeline
  // voices it (student-voice TTS) and lands it in their sentence builder.
  const facilitate = useCallback((button: BoardButton, spokenText: string) => {
    sendData({ k: "facilitator-press", button, spokenText, at: Date.now() });
  }, [sendData]);

  // A refusal is news, not a state: show it for a few seconds and let it go,
  // rather than leaving a red badge pinned to the call for its duration.
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    if (!facilitatorAck || facilitatorAck.ok) { setRefusal(null); return; }
    setRefusal(facilitatorAck.reason ?? "unavailable");
    const timer = setTimeout(() => setRefusal(null), 6000);
    return () => clearTimeout(timer);
  }, [facilitatorAck]);

  // Press-and-hold on a mirrored button POINTS at it on the student's own
  // board, without pressing it. Available whether or not Interact is armed —
  // showing a child a word is not saying it for them.
  const indicate = useCallback((buttonId: string | null) => {
    setIndicatedId(buttonId);
    indicateButton(buttonId);
  }, [indicateButton]);

  // The board mirror is only meaningful for a 1:1 student call; offer it when one
  // has arrived. Dropping out of the student view also disarms Interact.
  const canViewBoard = !!mirroredBoard;
  const viewBoard = studentView !== "video";

  // Inbound screen-share (getDisplayMedia) from the student, when present.
  const screenStream = useMemo(() => {
    const first = screenStreams.values().next();
    return first.done ? null : first.value;
  }, [screenStreams]);
  const attachScreen = useCallback((el: HTMLVideoElement | null) => {
    if (el && el.srcObject !== screenStream) el.srcObject = screenStream;
  }, [screenStream]);

  // The camera to pair the mirror with: the peer that actually SENT it. In a
  // group call "the first remote stream" is routinely a different person, and
  // captioning a student's board with a colleague's face is worse than no face.
  const mirrorPeerId = mirroredBoard?.fromPersonId ?? null;
  const studentStream = mirrorPeerId ? remoteStreams.get(mirrorPeerId) ?? null : null;
  const studentName = mirrorPeerId ? getLabel(mirrorPeerId) || activeContactName : activeContactName;

  // What the surface pane is showing — a real screen capture outranks the
  // mirror, since it is the thing the clinician asked for.
  const shownSurface: StudentSurface = screenStream ? "screen" : mirroredBoard?.surface ?? "board";
  const surfaceLabel = mirroredBoard?.surface ? t(`call.surface.${mirroredBoard.surface}`) : undefined;

  if (callState === "idle") return null;

  const isConnecting = callState === "ringing-out" || callState === "connecting";
  const isActive = callState === "active";

  // AN IFRAME WORLD GAME OWNS THE SCREEN. It renders through the very same
  // surface the call panel's game room opens — one game, one interface, however
  // you got to it — so the call's chrome goes INSIDE the surface as overlays
  // instead of a stack of rows the game has to share the page with (which also
  // meant every roster or board change resized the game).
  if (isActive && game && game.engine === "iframe-quest") {
    return (
      <div
        className="fixed inset-0 z-[100] bg-black text-white"
        role="dialog"
        aria-modal="true"
        aria-label={t("call.title")}
      >
        <IframeQuestSurface
          game={game}
          onExit={stopGame}
          peers={
            gameSidebar.length > 0 ? (
              <div className="flex flex-col gap-2">
                {gameSidebar.map(([pid, stream]) => (
                  <PeerVideoTile
                    key={pid}
                    stream={stream}
                    name={participants.find((p) => p.personId === pid)?.name ?? null}
                    borderColor={colorForPeerId(pid)}
                  />
                ))}
              </div>
            ) : null
          }
          controls={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="icon"
                variant={audioEnabled ? "secondary" : "destructive"}
                onClick={() => toggleAudio(!audioEnabled)}
                aria-label={audioEnabled ? t("call.mute") : t("call.unmute")}
                aria-pressed={!audioEnabled}
                data-testid="call-toggle-audio"
              >
                {audioEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
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
                {videoEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
              </Button>
              <Button
                type="button"
                size="icon"
                variant={outputMuted ? "destructive" : "secondary"}
                onClick={() => setOutputMuted(!outputMuted)}
                aria-label={outputMuted ? t("call.unmuteSpeaker") : t("call.muteSpeaker")}
                aria-pressed={outputMuted}
                data-testid="call-toggle-output"
              >
                {outputMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                onClick={() => setInvitePopupOpen(true)}
                aria-label={t("call.invitePeople")}
                data-testid="call-invite-people"
              >
                <UserPlus className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="destructive"
                onClick={() => hangUp()}
                aria-label={t("call.hangUp")}
                data-testid="call-hang-up"
              >
                <PhoneOff className="w-4 h-4" />
              </Button>
            </div>
          }
        />

        {invitePopupOpen && (
          <InvitePeoplePopup
            title={t("call.invitePeople")}
            confirmLabel={t("call.invite")}
            excludePersonIds={[selfPersonId, ...participants.map((p) => p.personId)].filter(Boolean) as string[]}
            onConfirm={(personIds, autoAccept) => { void invitePeopleIntoCall(personIds, autoAccept); }}
            onClose={() => setInvitePopupOpen(false)}
          />
        )}
      </div>
    );
  }
  const statusText =
    callState === "ringing-out"
      ? t("call.calling")
      : callState === "connecting"
        ? t("call.connecting")
        : "";

  // THE STUDENT'S SCREEN, whichever way it is arriving. A real screen capture
  // outranks the mirror — the clinician asked for pixels and the mirror is the
  // approximation they asked to replace.
  const surfacePane = screenStream ? (
    <div className="relative h-full w-full">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- live screen-share feed */}
      <video ref={attachScreen} autoPlay playsInline muted className="h-full w-full object-contain" aria-label={t("call.screenLabel")} />
      <div className="absolute top-2 start-2 rounded bg-sky-600/90 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">
        {t("call.screenLabel")}
      </div>
    </div>
  ) : mirroredBoard ? (
    <MirroredBoardView
      board={mirroredBoard.board}
      pageId={mirroredBoard.pageId}
      rtl={mirroredBoard.rtl}
      contextButtons={mirroredBoard.contextButtons}
      quickButtons={mirroredBoard.quickButtons}
      surface={mirroredBoard.surface}
      surfaceLabel={surfaceLabel}
      title={mirroredBoard.title}
      strip={mirroredBoard.strip}
      chips={mirroredBoard.chips}
      hud={mirroredBoard.hud}
      dwellId={mirroredDwell}
      selection={mirroredSelection}
      interactive={interactArmed}
      onPress={facilitate}
      onBuilderPress={sendBuilderPress}
      onIndicate={indicate}
      indicatedId={indicatedId}
      onHover={(buttonId) => sendData({ k: "board-dwell", buttonId, at: Date.now() })}
      className="h-full w-full"
    />
  ) : null;

  // A screen share promotes itself: the clinician pressed "Share screen" and
  // expects to see one, whichever view mode they happened to be in.
  const showSurface = !!surfacePane && (viewBoard || !!screenStream);

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

      {/* THE AAC REFUSED A FACILITATED PRESS. `allowFacilitatorControl` is off
          by default, so without this the clinician arms Interact, clicks, and
          watches nothing happen — indistinguishable from a broken call. */}
      {isActive && refusal && (
        <div className="flex justify-center px-4 pb-1">
          <span role="status" className="rounded-full bg-rose-500/90 px-3 py-1 text-sm font-medium text-white shadow">
            {t(`call.facilitatorRefused.${refusal}`)}
          </span>
        </div>
      )}

      {/* Student-view picker — video / both / their screen. Only once a mirror
          has arrived (a 1:1 student call); until then there is no second thing
          to show and the control would be three ways of saying "video". */}
      {isActive && !game && canViewBoard && (
        <div className="flex flex-wrap items-center justify-center gap-2 px-4 pt-2 pb-1">
          <span className="me-1 text-xs uppercase tracking-wide text-white/60">{t("call.studentView.label")}</span>
          {STUDENT_VIEW_MODES.map((m) => (
            <button
              key={m}
              type="button"
              // Leaving the student's screen disarms Interact: an armed press
              // that you cannot see the target of is a press waiting to go astray.
              onClick={() => { setStudentView(m); if (m === "video") setInteractArmed(false); }}
              aria-pressed={studentView === m}
              data-testid={m === "board" ? "call-toggle-view-board" : `call-student-view-${m}`}
              className={cn(
                "rounded-full px-3 py-1 text-sm font-medium transition",
                studentView === m ? "bg-amber-400 text-gray-900" : "bg-white/15 text-white hover:bg-white/25",
              )}
            >
              {t(`call.studentView.${m}`)}
            </button>
          ))}
          {studentView !== "video" && (
            <span className="ms-2 text-xs text-white/50">{t("call.indicateHint")}</span>
          )}
        </div>
      )}

      {/* Video layout picker — when viewing the multi-participant video (not the
          mirrored board, not a game). Click a mode to re-arrange the tiles. */}
      {isActive && !game && !viewBoard && !screenStream && videoTiles.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2 px-4 pt-2 pb-1">
          <span className="me-1 text-xs uppercase tracking-wide text-white/60">{t("call.layout.label")}</span>
          {VIDEO_LAYOUT_MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setLayoutMode(m)}
              aria-pressed={layoutMode === m}
              className={cn(
                "rounded-full px-3 py-1 text-sm font-medium transition",
                layoutMode === m ? "bg-amber-400 text-gray-900" : "bg-white/15 text-white hover:bg-white/25",
              )}
            >
              {t(`call.layout.${m}`)}
            </button>
          ))}
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
                  borderColor={game.engine === "iframe-quest" ? colorForPeerId(pid) : undefined}
                />
              ))
            )}
          </div>
        )}

        {/* Main area: the student's screen (alone or beside their camera), the
            multi-participant video layout, or the game surface. */}
        <div className="relative flex-1 min-h-0 flex items-center justify-center">
          {isActive && !game ? (
            showSurface ? (
              studentView === "split" ? (
                <StudentSplitView
                  stream={studentStream}
                  name={studentName}
                  surface={shownSurface}
                  noVideoLabel={t("call.studentView.noCamera")}
                  resizeLabel={t("call.studentView.resize")}
                  className="p-2"
                >
                  {surfacePane}
                </StudentSplitView>
              ) : (
                surfacePane
              )
            ) : videoTiles.length > 0 ? (
              <VideoTileLayout
                tiles={videoTiles}
                mode={layoutMode}
                spotlightId={spotlightId}
                onPin={(id) => setPinnedPeer((cur) => (cur === id ? null : id))}
                t={t}
                className="h-full w-full"
              />
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="text-xl font-medium">{activeContactName ?? t("call.title")}</div>
              </div>
            )
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
              game" detaches it back to plain video. (An iframe world game never
              reaches here — it takes the whole screen, above.) */}
          {isActive && game && (
            <CallGameSurface
              game={game}
              selfPersonId={selfPersonId}
              sendWorld={sendWorld}
              hub={worldHub}
              publishPresence={publishPresence}
              presenceChannel={presenceChannel}
              getLabel={getLabel}
              getFaceUrl={getFaceUrl}
              selfStream={localStream}
              npcBrainWsUrl={npcBrainWsUrl}
              npcTransport={npcTransport}
              audioMuted={outputMuted}
              selfSpeech={lastSelfSpeech}
              onExit={stopGame}
              t={t}
            />
          )}

          {/* Live game-JSON editor — edit the running game and reload it for
              everyone in the call (testing affordance). */}
          {isActive && game && jsonEditorOpen && (
            <GameJsonEditor
              game={game}
              onReload={(g) => startGame(g)}
              onClose={() => setJsonEditorOpen(false)}
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

        {/* Output (speaker) mute — silences what we HEAR, distinct from the mic. */}
        <Button
          type="button"
          size="icon"
          variant={outputMuted ? "destructive" : "secondary"}
          onClick={() => setOutputMuted(!outputMuted)}
          aria-label={outputMuted ? t("call.unmuteSpeaker") : t("call.muteSpeaker")}
          aria-pressed={outputMuted}
          data-testid="call-toggle-output"
        >
          {outputMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </Button>

        {/* (Seeing the student's screen is the picker at the top of the panel —
            video / both / their screen. One owner of that state, and it has to
            offer three choices, which an icon toggle cannot.) */}

        {/* Ask the student device to share its real screen (getDisplayMedia) —
            for anything the board mirror can't show. */}
        {isActive && !game && (
          <Button
            type="button"
            size="icon"
            variant={screenRequested ? "default" : "secondary"}
            onClick={() => requestScreenShare(!screenRequested)}
            aria-label={screenRequested ? t("call.stopShareScreen") : t("call.shareScreen")}
            aria-pressed={screenRequested}
            data-testid="call-toggle-screen-share"
          >
            <MonitorUp className="w-5 h-5" />
          </Button>
        )}

        {/* Arm facilitator presses on the mirrored board (guided communication).
            Only while viewing the board. */}
        {isActive && !game && viewBoard && (
          <Button
            type="button"
            size="icon"
            variant={interactArmed ? "default" : "secondary"}
            onClick={() => setInteractArmed((a) => !a)}
            aria-label={interactArmed ? t("call.interactOn") : t("call.interact")}
            aria-pressed={interactArmed}
            data-testid="call-toggle-interact"
          >
            <Hand className="w-5 h-5" />
          </Button>
        )}

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

        {/* Edit the running game's JSON and reload it for everyone (testing). */}
        {isActive && game && (
          <Button
            type="button"
            size="icon"
            variant={jsonEditorOpen ? "default" : "secondary"}
            onClick={() => setJsonEditorOpen((o) => !o)}
            aria-label="Edit game JSON"
            aria-pressed={jsonEditorOpen}
            data-testid="call-edit-game-json"
          >
            <Braces className="w-5 h-5" />
          </Button>
        )}

        {/* Invite more people into the active call. */}
        {isActive && (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={() => setInvitePopupOpen(true)}
            aria-label={t("call.invitePeople")}
            data-testid="call-invite-people"
          >
            <UserPlus className="w-5 h-5" />
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

      {invitePopupOpen && (
        <InvitePeoplePopup
          title={t("call.invitePeople")}
          confirmLabel={t("call.invite")}
          excludePersonIds={[selfPersonId, ...participants.map((p) => p.personId)].filter(Boolean) as string[]}
          onConfirm={(personIds, autoAccept) => { void invitePeopleIntoCall(personIds, autoAccept); }}
          onClose={() => setInvitePopupOpen(false)}
        />
      )}
    </div>
  );
}
