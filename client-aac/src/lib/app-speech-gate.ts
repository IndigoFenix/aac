// THE MIC HOLD FOR AUDIO THIS DEVICE IS MAKING.
//
// Three sources are invisible to the AAC's own audio player and therefore to
// the echo gate that covers our TTS: an embedded app's voice, a remote party's
// audio on a call, and the device's OWN local voice (speechSynthesis / the
// Kokoro neural voice, which play through their own audio paths). All three
// come out of the same speaker and all three get heard by the microphone. Each
// keeps its OWN deadline (see `deviceAudioBusy`) — one going quiet must never
// release a hold another still needs.
//
// ---- the original case: AN EMBEDDED APP'S OWN VOICE ----
//
// A game speaks through the device's speaker with its own TTS (the world
// engine's `speechSynthesis` NPC voice, inside the iframe). That audio reaches
// the AAC's microphone, and nothing in the AAC's own audio player knows about
// it — so the echo gate that covers our TTS stays open. In session 7f5fccb5 the
// recogniser heard the Dollhouse say "אני הולכת לבית" ("I'm going home"),
// handed it over as the student's words, and the assistant answered it out loud
// — four times in three minutes, over a child who was playing.
//
// The app reports each utterance (games-bridge `game_speech`) and the AAC holds
// its mic shut until this DEADLINE. A deadline rather than a flag, because the
// release edge is not guaranteed: an iframe closing mid-sentence would strand
// the mic shut, which is worse than the leak.

/** Room-echo margin kept after the app stops speaking. */
export const APP_SPEECH_TAIL_MS = 600;
/** Hold applied when the app reports speech with no length estimate. */
export const APP_SPEECH_DEFAULT_MS = 2_500;
/** Ceiling on a single hold — a wild estimate must not deafen the session. */
export const APP_SPEECH_MAX_MS = 15_000;

export interface AppSpeechEdge {
  /** True as the utterance starts, false when it ends or is cancelled. */
  speaking: boolean;
  /** Estimated utterance length in ms (the app's own estimate). */
  ms?: number;
}

/**
 * The new hold deadline after an app-speech edge.
 *
 * A start EXTENDS (never shortens) the hold: overlapping utterances, or a queue
 * that runs on past this one, keep the mic shut. A stop cuts it back to the
 * tail — the words are over, only the room's echo of them is left.
 */
export function appSpeechHoldUntil(now: number, current: number, edge: AppSpeechEdge): number {
  if (!edge.speaking) return Math.min(current, now + APP_SPEECH_TAIL_MS);
  const span = Math.min(
    Math.max(edge.ms ?? APP_SPEECH_DEFAULT_MS, APP_SPEECH_TAIL_MS),
    APP_SPEECH_MAX_MS,
  );
  return Math.max(current, now + span + APP_SPEECH_TAIL_MS);
}


/** The live hold deadlines, plus whether our own TTS is playing. */
export interface DeviceAudioState {
  /** Our audio player is mid-utterance (its own synchronous busy flag). */
  aiTtsBusy: boolean;
  /** Deadline for an embedded app's speech (0 = none). */
  appSpeechUntil: number;
  /** Deadline for a remote party's call audio (0 = none). */
  remoteCallAudioUntil: number;
  /**
   * Deadline for the device's own LOCAL voice — `client_local_tts`, spoken by
   * speechSynthesis or the Kokoro neural voice (0 = none).
   *
   * Required, not optional: a new source of device audio that a call site can
   * forget to pass is a source that leaks, and this one leaked for exactly
   * that reason (see the device-voice note above `foreignDeviceAudio`).
   */
  localTtsUntil: number;
}

/**
 * "Is this device making sound right now?" — the one question every mic gate
 * actually asks. Any source being live holds the mic; sources are INDEPENDENT,
 * so an app finishing its line does not open the mic while a call is still
 * talking, and vice versa.
 *
 * Pure so the independence can be tested: it is the property most easily lost
 * if the deadlines are ever merged into one.
 */
export function deviceAudioBusy(now: number, s: DeviceAudioState): boolean {
  return s.aiTtsBusy
    || now < s.appSpeechUntil
    || now < s.remoteCallAudioUntil
    || now < s.localTtsUntil;
}

/**
 * Device audio the LIVE MODEL DID NOT PRODUCE.
 *
 * The raw PCM stream treats our own player's audio as harmless — it is the
 * model's own output coming back, and the model's echo handling knows it made
 * it. That reasoning does NOT extend to sound the model never produced: an
 * embedded app's voice, and (since device-voice mode) our own local TTS. To
 * the model that audio is simply a person in the room talking, so it must be
 * DROPPED from the stream, not merely counted like the echo of our own player.
 *
 * ---- the device-voice case ----
 *
 * `aac_settings.useLocalTts` makes every student press speak through
 * speechSynthesis / Kokoro instead of streamed server audio. That rung of the
 * TTS ladder used to be reached only after every cloud provider had failed, so
 * its audio hit the mic rarely enough to pass for noise; device-voice mode put
 * it on EVERY press. The AAC then heard the student's own sentence come back
 * through its microphone, attributed it to a person in the room, and answered
 * it — the AAC talking with its own echo.
 *
 * A remote party's call audio is deliberately NOT here: it is a person, whose
 * words the conversation room already delivers by their proper route, and the
 * `deviceAudioBusy` hold is what keeps the mic from delivering them a second
 * time.
 */
export function foreignDeviceAudio(
  now: number,
  s: Pick<DeviceAudioState, "appSpeechUntil" | "localTtsUntil">,
): boolean {
  return now < s.appSpeechUntil || now < s.localTtsUntil;
}
