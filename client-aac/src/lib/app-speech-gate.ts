// THE MIC HOLD FOR AUDIO THIS DEVICE IS MAKING.
//
// Two sources are invisible to the AAC's own audio player and therefore to the
// echo gate that covers our TTS: an embedded app's voice, and a remote party's
// audio on a call. Both come out of the same speaker and both get heard by the
// microphone. Each keeps its OWN deadline (see `deviceAudioBusy`) — one going
// quiet must never release a hold the other still needs.
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
  return s.aiTtsBusy || now < s.appSpeechUntil || now < s.remoteCallAudioUntil;
}
