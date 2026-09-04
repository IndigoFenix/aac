// shared/aac/device-voice.ts
//
// WHEN THE DEVICE SAYS IT ITSELF, AT THE MOMENT OF THE TAP.
//
// Device-voice mode (`aac_settings.useLocalTts`) promises the clinician "free,
// instant, and works with no connection". It was none of those in the middle:
// a press went up the socket, the server ran its press handling, and sent back
// `client_local_tts` — a message whose entire content was the words the client
// had already had in its hand when the child's finger landed. The voice was
// the device's, but the LATENCY was the network's.
//
// So the client speaks first and tells the server it did (`spokenLocally`).
// This is the rule for when, kept out of the hook so it can be tested and so
// both callers — a board press and a composed builder sentence — apply the
// same one.

export interface DeviceVoiceContext {
  /** `clientConfig.deviceVoice` — the student speaks with this device's voice. */
  deviceVoice?: boolean;
  /**
   * The header's audio-output mute is OFF. It silences everything this window
   * makes, and the local voice was historically the leak that survived it.
   */
  audioEnabled?: boolean;
}

/**
 * Should THIS window voice `sentence` right now, before the server hears about
 * it at all?
 *
 * `label` is the button's own label when there is one. `[MORE]` is the one
 * press that is not an utterance — it asks for other options, and the server
 * short-circuits it before any TTS — so it must not be spoken here either.
 * Anything else with words is something the student said.
 */
export function speakOnDeviceNow(
  ctx: DeviceVoiceContext,
  sentence: string | undefined,
  label?: string,
): boolean {
  if (!ctx.deviceVoice) return false;
  if (ctx.audioEnabled === false) return false;
  if (!sentence || !sentence.trim()) return false;
  if (label === "[MORE]") return false;
  return true;
}
