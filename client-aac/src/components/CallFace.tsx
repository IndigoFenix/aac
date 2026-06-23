// client-aac/src/components/CallFace.tsx
// Renders the remote peer's video in the avatar slot during an active video
// call — a parallel to <ProceduralFace> (social peer) and <AacAvatar> (idle AI).
// Sized to match the avatar slot (80x80). While the call is still connecting or
// ringing-out (no remote stream yet) it shows the contact's name initial.

import { useCallback } from "react";
import { useCall } from "@/contexts/CallContext";

export function CallFace() {
  const { remoteStreams, activeContact, callState } = useCall();

  // First (1:1) remote stream.
  const remoteStream = remoteStreams.values().next().value ?? null;

  // Callback ref: sets srcObject when the stream changes AND when the
  // conditionally-mounted <video> attaches (robust against render ordering).
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    if (el && remoteStream && el.srcObject !== remoteStream) el.srcObject = remoteStream;
  }, [remoteStream]);

  const name = activeContact?.name ?? null;
  const initial = name ? name.trim().charAt(0).toUpperCase() : "?";
  const connecting = callState === "connecting" || callState === "ringing-out";

  return (
    <div
      className="relative overflow-hidden rounded-full bg-black/40 flex items-center justify-center select-none"
      style={{ width: 80, height: 80 }}
      title={name ?? "Call"}
    >
      {remoteStream ? (
        <video
          ref={attachVideo}
          autoPlay
          playsInline
          className="w-full h-full object-cover"
        />
      ) : (
        // No remote video yet — show the contact's initial (connecting/ringing).
        <div className="flex flex-col items-center justify-center w-full h-full bg-emerald-600 text-white">
          <span className="text-3xl font-bold leading-none">{initial}</span>
          {connecting && (
            <span className="mt-0.5 inline-block h-1.5 w-1.5 rounded-full bg-white/80 animate-pulse" />
          )}
        </div>
      )}
    </div>
  );
}

export default CallFace;
