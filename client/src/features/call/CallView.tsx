import { useCallback, useMemo } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { useCall } from "./CallContext";

/** In-call full-screen overlay: remote video, self-view, and call controls. */
export function CallView() {
  const { t } = useLanguage();
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
  } = useCall();

  const remoteStream = useMemo(() => {
    const first = remoteStreams.values().next();
    return first.done ? null : first.value;
  }, [remoteStreams]);

  // Callback refs: fire both when the stream changes AND when the (conditionally
  // mounted) <video> attaches, so srcObject is set even if the stream arrived
  // before the element mounted.
  const attachRemote = useCallback((el: HTMLVideoElement | null) => {
    if (el && el.srcObject !== remoteStream) el.srcObject = remoteStream;
  }, [remoteStream]);

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

      {/* Remote / status area */}
      <div className="relative flex-1 min-h-0 flex items-center justify-center">
        {isActive && remoteStream ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- live WebRTC call stream; captions cannot be supplied for a real-time peer feed
          <video
            ref={attachRemote}
            autoPlay
            playsInline
            className="h-full w-full object-contain"
            aria-label={activeContactName ?? t("call.remoteVideo")}
          />
        ) : (
          <div className="flex flex-col items-center gap-4">
            {isConnecting && <Loader2 className="w-10 h-10 animate-spin" aria-hidden="true" />}
            <div className="text-xl font-medium">{activeContactName ?? t("call.title")}</div>
            {statusText && <div className="text-sm text-white/70">{statusText}</div>}
          </div>
        )}

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
