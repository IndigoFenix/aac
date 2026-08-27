// shared/call/CallAudioSinks.tsx
//
// THE call's audio output. One <audio> element per remote participant, mounted
// for as long as that participant is in the call — never tied to whether some
// layout happens to be drawing them. See planning-docs/live-video-chat.md
// §"Voice-chat rework" D2.
//
// WHY. Remote audio used to ride on whichever <video> element a layout drew, in
// four independent places (the shared tile layout, the clinician's game sidebar,
// the AAC's avatar slot, the AAC's in-game people panel) with inconsistent
// muting. Two consequences:
//
//   • The shared tile only renders a <video> when the peer HAS live video, so a
//     participant with their camera off was completely INAUDIBLE. Survivable at
//     1:1 with video on; fatal for a group, where the layout deliberately shows
//     a subset of the people in the room.
//   • When two of those surfaces were mounted at once (AAC avatar slot + the
//     large video window) the same stream played twice.
//
// So: video elements become purely visual (all muted), and audio lives here.
// One owner, one volume, one mute — for every participant, all the time.

import { useEffect, useRef } from "react";

/** Gestures that can lift an autoplay block. */
const GESTURES = ["pointerdown", "keydown", "touchstart"] as const;
/** How often, and how many times, to retry a sink that has not started. */
const PLAY_RETRY_MS = 500;
const PLAY_RETRIES = 20; // ~10s

export interface CallAudioSinksProps {
  /** Remote participants' media streams, keyed by personId. Pass ONLY the
   *  camera/mic streams — a screen-share stream is video-only and does not
   *  belong here. */
  streams: Map<string, MediaStream>;
  /** Per-peer output volume 0..1 (the proximity gate in a conversation-circle
   *  world). Missing entries play at full volume. */
  gains?: Map<string, number>;
  /** Local output mute — silences every participant for this listener only.
   *  Never affects what anyone else hears. */
  muted?: boolean;
}

/** One participant's audio. Renders nothing visible.
 *
 *  STARTING PLAYBACK IS NOT AUTOMATIC. A media element can be refused permission
 *  to play, and it then sits there paused, looking from every other angle
 *  exactly like silence on the wire: srcObject set, not muted, volume 1,
 *  `readyState` 0. Measured on a real call — audio arriving at level 0.11 while
 *  every sink was `paused=true`, which is why the clinician heard nothing at all
 *  from the student. The first version of this component called `play()` once
 *  and swallowed the rejection, so nothing anywhere said why.
 *
 *  So: never swallow the failure, and keep trying — on the element's own readiness
 *  events, on a short bounded timer, and on the next user gesture, which is the
 *  one thing guaranteed to lift an autoplay block. */
function PeerAudio({ personId, stream, volume, muted }: { personId: string; stream: MediaStream; volume: number; muted: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  // Volume and mute are kept live separately from the play logic, so changing
  // either never re-attaches the stream (which would restart playback and clip
  // a word).
  useEffect(() => { if (ref.current) ref.current.volume = volume; }, [volume]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.volume = volume;
    el.muted = muted;

    let cancelled = false;
    let gestureBound = false;
    const tag = personId.slice(0, 8);

    const bindGesture = () => {
      if (gestureBound || cancelled) return;
      gestureBound = true;
      // Capture phase, and NOT `once` — the first gesture may land before the
      // stream is ready, and a call can outlive several blocked attempts.
      for (const ev of GESTURES) document.addEventListener(ev, onGesture, true);
    };
    const unbindGesture = () => {
      if (!gestureBound) return;
      gestureBound = false;
      for (const ev of GESTURES) document.removeEventListener(ev, onGesture, true);
    };

    const tryPlay = async (why: string) => {
      if (cancelled || !el.paused) return;
      // Re-assert the source before each attempt. A play() on an element whose
      // srcObject was never applied (or was cleared by a re-render) can only
      // fail, and it fails the same way an autoplay block does — so rule it out
      // rather than guess between them.
      if (el.srcObject !== stream) el.srcObject = stream;
      try {
        await el.play();
        if (cancelled) return;
        console.log(`[call-audio] sink ${tag} started playing (${why})`);
        unbindGesture();
      } catch (err: any) {
        if (cancelled) return;
        // LOUD. A paused sink is invisible otherwise.
        console.warn(
          `[call-audio] sink ${tag} could not start (${why}): ${err?.name ?? "error"}: ${err?.message ?? ""} — waiting for a user gesture`,
        );
        bindGesture();
      }
    };
    function onGesture() { void tryPlay("user gesture"); }

    const onReady = () => void tryPlay("ready");
    el.addEventListener("loadedmetadata", onReady);
    el.addEventListener("canplay", onReady);

    void tryPlay("attach");
    // Bounded retry: covers a stream whose track goes live after attach without
    // firing a readiness event we caught.
    let attempts = 0;
    const retry = setInterval(() => {
      if (cancelled || !el.paused || attempts++ >= PLAY_RETRIES) { clearInterval(retry); return; }
      void tryPlay(`retry ${attempts}`);
    }, PLAY_RETRY_MS);

    return () => {
      cancelled = true;
      clearInterval(retry);
      unbindGesture();
      el.removeEventListener("loadedmetadata", onReady);
      el.removeEventListener("canplay", onReady);
      try { el.srcObject = null; } catch { /* ignore */ }
    };
    // volume/muted are applied above and kept live by their own effects; they
    // are deliberately NOT deps here so a volume change never restarts audio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, personId]);

  // `data-call-audio-sink` is how the receive-side probe finds these elements to
  // report whether they are actually PLAYING.
  // eslint-disable-next-line jsx-a11y/media-has-caption -- live WebRTC peer audio
  return <audio ref={ref} autoPlay playsInline aria-hidden="true" data-call-audio-sink={personId} />;
}

/**
 * Mount ONCE per client, high enough that it lives for the whole call —
 * inside the call provider, not inside a view that comes and goes. Renders no
 * visible output.
 */
export default function CallAudioSinks({ streams, gains, muted = false }: CallAudioSinksProps) {
  return (
    <>
      {Array.from(streams.entries()).map(([personId, stream]) => (
        <PeerAudio
          key={personId}
          personId={personId}
          stream={stream}
          volume={gains?.get(personId) ?? 1}
          muted={muted}
        />
      ))}
    </>
  );
}
