// shared/call/audio-mixer.ts
//
// Mixes a participant's TWO audio sources into the ONE outgoing track a call
// sends. See planning-docs/live-video-chat.md §"Voice-chat rework" D1.
//
//     microphone ──► micGain   ──┐
//                                ├──► MediaStreamDestination ──► one track out
//     voice (TTS) ──► voiceGain ─┘
//
// WHY THIS EXISTS. The AAC used to add its TTS tap to the mic's MediaStream as a
// SECOND audio track. A media element renders exactly one audio track of a
// stream and picks it by track **id** — which is random per track — so every
// call was a coin flip between hearing the student's microphone and hearing
// their button presses, never both. (Measured: lower track id won 8/8, add order
// uncorrelated. Chrome exposes no `audioTracks` selection API to override it.)
//
// A student has two voices and they are NOT the same thing: the utterance is
// synthesized, deliberate and already attributed; the microphone is the room —
// ambient, and for this population it carries meaningful non-speech
// vocalisation. They need independent mute semantics, which is exactly what a
// gain node per source buys and a track toggle cannot.
//
// LAW: muting the call microphone must NEVER mute the student's voice. A child
// whose only channel is TTS must not be silenceable by a control labelled
// "mic". That is why the two sources have separate gains and why `setMicEnabled`
// touches only the mic side.

/** Minimal Web Audio surface this module needs (kept narrow for testability). */
type AudioCtx = AudioContext;

export interface CallAudioMixer {
  /** The single audio track to send. Stays the same object for the call's life. */
  readonly track: MediaStreamTrack;
  /** Room audio → peers. Stops capture as well as zeroing gain (privacy: a gain
   *  node alone still captures). Never affects the voice. */
  setMicEnabled(enabled: boolean): void;
  isMicEnabled(): boolean;
  /** The student's synthesized voice → peers. Independent of the microphone. */
  setVoiceEnabled(enabled: boolean): void;
  isVoiceEnabled(): boolean;
  /** Stop the mixer. Stops only what this module created — never the caller's
   *  mic track, and never the shared TTS tap the audio player is still using. */
  close(): void;
}

export interface CallAudioMixerOptions {
  /** The getUserMedia microphone track. Owned by the caller; not stopped here. */
  micTrack: MediaStreamTrack | null;
  /** The app's synthesized-voice tap. Cloned internally, so the caller's copy
   *  keeps feeding the local speakers after the call ends. */
  voiceTrack: MediaStreamTrack | null;
  /** Injectable for tests / non-browser hosts. */
  createContext?: () => AudioCtx;
}

/**
 * Build the mixer. Returns null when there is nothing to mix (no sources) or
 * Web Audio is unavailable — callers must handle null and degrade explicitly
 * rather than silently sending the wrong thing.
 */
export function createCallAudioMixer(opts: CallAudioMixerOptions): CallAudioMixer | null {
  const { micTrack, voiceTrack } = opts;
  if (!micTrack && !voiceTrack) return null;

  const makeCtx =
    opts.createContext ??
    (() => {
      const Ctor: typeof AudioContext | undefined =
        typeof AudioContext !== "undefined"
          ? AudioContext
          : (globalThis as any).webkitAudioContext;
      if (!Ctor) throw new Error("Web Audio unavailable");
      return new Ctor();
    });

  let ctx: AudioCtx;
  try {
    ctx = makeCtx();
  } catch {
    return null;
  }

  // A context created before a user gesture can start suspended; a suspended
  // context produces silence, so the outgoing track would be dead. Best-effort
  // resume (a call always follows a gesture in practice).
  if (ctx.state === "suspended") void ctx.resume().catch(() => { /* ignore */ });

  const dest = ctx.createMediaStreamDestination();

  const micGain = ctx.createGain();
  const voiceGain = ctx.createGain();
  micGain.gain.value = micTrack ? 1 : 0;
  voiceGain.gain.value = voiceTrack ? 1 : 0;
  micGain.connect(dest);
  voiceGain.connect(dest);

  if (micTrack) {
    ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(micGain);
  }

  // Clone the tap: the player's own track must outlive the call, and close()
  // stops only this copy.
  const voiceClone = voiceTrack ? voiceTrack.clone() : null;
  if (voiceClone) {
    ctx.createMediaStreamSource(new MediaStream([voiceClone])).connect(voiceGain);
  }

  const track = dest.stream.getAudioTracks()[0];
  if (!track) {
    try { voiceClone?.stop(); } catch { /* ignore */ }
    void ctx.close().catch(() => { /* ignore */ });
    return null;
  }

  let micEnabled = !!micTrack;
  let voiceEnabled = !!voiceTrack;
  let closed = false;

  return {
    track,

    setMicEnabled(enabled: boolean): void {
      if (closed || !micTrack) return;
      micEnabled = enabled;
      // Belt and braces: gain silences what we MIX, disabling the source track
      // stops the capture itself. "Mic off" has to mean the room is not being
      // listened to, not merely that it is being multiplied by zero.
      micGain.gain.value = enabled ? 1 : 0;
      micTrack.enabled = enabled;
    },
    isMicEnabled: () => micEnabled,

    setVoiceEnabled(enabled: boolean): void {
      if (closed || !voiceClone) return;
      voiceEnabled = enabled;
      // Gain only — the clone is shared plumbing off the live player and must
      // stay running so re-enabling is instant.
      voiceGain.gain.value = enabled ? 1 : 0;
    },
    isVoiceEnabled: () => voiceEnabled,

    close(): void {
      if (closed) return;
      closed = true;
      try { voiceClone?.stop(); } catch { /* ignore */ }
      for (const node of [micGain, voiceGain]) {
        try { node.disconnect(); } catch { /* ignore */ }
      }
      try { track.stop(); } catch { /* ignore */ }
      void ctx.close().catch(() => { /* ignore */ });
    },
  };
}
