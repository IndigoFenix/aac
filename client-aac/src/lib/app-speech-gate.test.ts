// The mic hold that keeps a game's own voice out of the AAC's ears.
//
// Session 7f5fccb5 (2026-08-06): with the Dollhouse open, the recogniser picked
// up its NPC lines through the speaker ("אני הולכת לבית" / "אני הולכת לכתוב"),
// the Observer attributed them to the only person in the room, and the Speaker
// answered each one aloud. The AAC's echo gate covers its OWN audio player;
// an iframe's speechSynthesis is invisible to it, so the app has to say when it
// is talking — and this is what the AAC does with that.

import { describe, it, expect } from "@jest/globals";
import {
  appSpeechHoldUntil,
  deviceAudioBusy,
  APP_SPEECH_TAIL_MS,
  APP_SPEECH_DEFAULT_MS,
  APP_SPEECH_MAX_MS,
} from "./app-speech-gate";

const NOW = 1_000_000;

describe("app-speech mic hold", () => {
  it("holds for the reported utterance plus the room tail", () => {
    expect(appSpeechHoldUntil(NOW, 0, { speaking: true, ms: 2_000 }))
      .toBe(NOW + 2_000 + APP_SPEECH_TAIL_MS);
  });

  it("falls back to the default span when the app reports no length", () => {
    expect(appSpeechHoldUntil(NOW, 0, { speaking: true }))
      .toBe(NOW + APP_SPEECH_DEFAULT_MS + APP_SPEECH_TAIL_MS);
  });

  // The engine queues lines: a second utterance starts while the first hold is
  // still standing, and a shorter one must not cut it short.
  it("extends but never shortens a standing hold", () => {
    const long = appSpeechHoldUntil(NOW, 0, { speaking: true, ms: 6_000 });
    expect(appSpeechHoldUntil(NOW, long, { speaking: true, ms: 500 })).toBe(long);
    expect(appSpeechHoldUntil(NOW + 1_000, long, { speaking: true, ms: 9_000 }))
      .toBe(NOW + 1_000 + 9_000 + APP_SPEECH_TAIL_MS);
  });

  it("caps a wild estimate so a broken app can't deafen the session", () => {
    expect(appSpeechHoldUntil(NOW, 0, { speaking: true, ms: 10 * 60_000 }))
      .toBe(NOW + APP_SPEECH_MAX_MS + APP_SPEECH_TAIL_MS);
  });

  it("keeps a floor under a tiny estimate — the room still echoes", () => {
    expect(appSpeechHoldUntil(NOW, 0, { speaking: true, ms: 1 }))
      .toBe(NOW + APP_SPEECH_TAIL_MS + APP_SPEECH_TAIL_MS);
  });

  it("releases to the tail when the app stops speaking", () => {
    const standing = appSpeechHoldUntil(NOW, 0, { speaking: true, ms: 6_000 });
    expect(appSpeechHoldUntil(NOW + 500, standing, { speaking: false }))
      .toBe(NOW + 500 + APP_SPEECH_TAIL_MS);
  });

  // A cancel fires `false` for a line that already ended; that must not push
  // the deadline forward and re-gate a mic that is already open.
  it("a stop never extends an expired hold", () => {
    const expired = NOW - 5_000;
    expect(appSpeechHoldUntil(NOW, expired, { speaking: false })).toBe(expired);
  });

  it("a stop with nothing held leaves the mic open", () => {
    expect(appSpeechHoldUntil(NOW, 0, { speaking: false })).toBe(0);
  });
});

describe("deviceAudioBusy — one question, independent sources", () => {
  const NOW = 1_000_000;
  const quiet = { aiTtsBusy: false, appSpeechUntil: 0, remoteCallAudioUntil: 0 };

  it("is open when nothing on this device is making sound", () => {
    expect(deviceAudioBusy(NOW, quiet)).toBe(false);
  });

  it("holds for our own TTS", () => {
    expect(deviceAudioBusy(NOW, { ...quiet, aiTtsBusy: true })).toBe(true);
  });

  it("holds for an embedded app's voice until its deadline", () => {
    const s = { ...quiet, appSpeechUntil: NOW + 500 };
    expect(deviceAudioBusy(NOW, s)).toBe(true);
    expect(deviceAudioBusy(NOW + 501, s)).toBe(false);
  });

  it("holds for a remote party's call audio until its deadline", () => {
    // Defect 7: without this the AAC's recogniser hears the clinician through
    // the room and hands their words to the Observer as speech from someone
    // PRESENT — the clinician arriving twice, once misattributed.
    const s = { ...quiet, remoteCallAudioUntil: NOW + 500 };
    expect(deviceAudioBusy(NOW, s)).toBe(true);
    expect(deviceAudioBusy(NOW + 501, s)).toBe(false);
  });

  it("THE INVARIANT: one source going quiet never releases another's hold", () => {
    // The property that would be lost if the deadlines were ever merged into a
    // single ref — which is exactly why they are separate.
    const appDoneCallTalking = { aiTtsBusy: false, appSpeechUntil: NOW - 1, remoteCallAudioUntil: NOW + 800 };
    expect(deviceAudioBusy(NOW, appDoneCallTalking)).toBe(true);

    const callDoneAppTalking = { aiTtsBusy: false, appSpeechUntil: NOW + 800, remoteCallAudioUntil: NOW - 1 };
    expect(deviceAudioBusy(NOW, callDoneAppTalking)).toBe(true);

    // Only when EVERY source is quiet does the mic open.
    expect(deviceAudioBusy(NOW, { aiTtsBusy: false, appSpeechUntil: NOW - 1, remoteCallAudioUntil: NOW - 1 })).toBe(false);
  });

  it("our TTS overrides expired deadlines", () => {
    expect(deviceAudioBusy(NOW, { aiTtsBusy: true, appSpeechUntil: NOW - 1, remoteCallAudioUntil: NOW - 1 })).toBe(true);
  });

  it("composes with appSpeechHoldUntil for the live call-audio path", () => {
    // What CallContext actually does: re-arm on each detector poll, then let it
    // decay to the room-echo tail once the far end goes quiet.
    let until = 0;
    until = appSpeechHoldUntil(NOW, until, { speaking: true, ms: 600 });
    expect(deviceAudioBusy(NOW + 500, { ...quiet, remoteCallAudioUntil: until })).toBe(true);

    // Far end stops -> cut back to the tail, not released outright.
    until = appSpeechHoldUntil(NOW + 600, until, { speaking: false });
    expect(deviceAudioBusy(NOW + 700, { ...quiet, remoteCallAudioUntil: until })).toBe(true);
    expect(deviceAudioBusy(NOW + 1_300, { ...quiet, remoteCallAudioUntil: until })).toBe(false);
  });
});
