// B1 invariant: THE APP'S TWO MASTER CONTROLS GOVERN THE CALL TOO.
//
// The AAC header carries two small toggles. They are APP-WIDE device I/O, not
// assistant-only:
//
//     mic off       → NO audio gets in    (nothing is captured, by anything)
//     speakers off  → NO audio comes out  (nothing is played, by anything)
//
// The bug that started this work: a caretaker muted both and still heard
// themselves, because the CALL microphone kept transmitting underneath a control
// that said it was off. The masters only reached the assistant.
//
// So the fix is not a second set of call buttons — that would give a student two
// switches for one thing and two places to look when something is muted. It is
// making the masters mean what they say. This suite pins that, and pins the
// absence of the duplicates.
//
// Source-level, like call-audio-ownership: the client jest config is
// `testEnvironment: 'node'` and deliberately declines jsdom.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const AAC_CALL_CTX = "client-aac/src/contexts/CallContext.tsx";
const PHONE_APP = "client-aac/src/components/PhoneCallApp.tsx";
const CONVO_BOX = "client-aac/src/components/DualAgentConversationBox.tsx";
const MIXER = "shared/call/audio-mixer.ts";

describe("B1 — the master controls govern the call", () => {
  it("master MIC off stops the call microphone, not just the assistant's", () => {
    const src = read(AAC_CALL_CTX);
    expect(src).toContain("const masterMicOn = dual?.voiceEnabled ?? true;");
    expect(src).toContain("clientRef.current?.toggleAudio(masterMicOn)");
  });

  it("master SPEAKERS off silences the call's audio sinks", () => {
    const src = read(AAC_CALL_CTX);
    expect(src).toContain("const masterSpeakersOn = dual?.audioEnabled ?? true;");
    expect(src).toContain("setOutputMuted(!masterSpeakersOn)");
  });

  it("mirroring lives in the CALL layer — the child can read the master, not vice versa", () => {
    // DualAgentContext is the parent provider; it cannot reach into the call.
    // Putting the mirror the other way round would be a circular dependency.
    expect(read(AAC_CALL_CTX)).toContain("dual?.voiceEnabled");
    // The conversation box READS call state (it swaps the avatar slot for the
    // caller's face) — that is fine and expected. What it must never do is
    // MUTATE call audio: the masters own that, mirrored one way, in CallContext.
    const box = read(CONVO_BOX);
    expect(box).toContain("useCallOptional");        // reading: fine
    expect(box).not.toContain("call?.toggleAudio");  // mutating: not its job
    expect(box).not.toContain("call.toggleAudio");
    expect(box).not.toContain("setOutputMuted");
  });

  it("the masters keep their app-wide labels — they are not assistant controls", () => {
    const src = read(CONVO_BOX);
    expect(src).toContain("t('conversation.muteAudio')");
    expect(src).toContain("t('status.disableAudioCapture')");
    // Naming them for the assistant would be a lie now that they cover the call.
    expect(src).not.toContain("AssistantVoice");
  });

  it("there is NO duplicate per-call mic/speaker button", () => {
    // Two switches for one thing is the confusion this work started from.
    const src = read(PHONE_APP);
    expect(src).not.toContain('data-dwell="call-mic"');
    expect(src).not.toContain('data-dwell="call-their-voice"');
    expect(src).not.toContain("setOutputMuted");
    // Hang-up stays — ending a call is not a mute.
    expect(src).toContain('data-dwell="call-hangup"');
  });

  it("SAFETY: muting the mic still cannot silence the student's voice", () => {
    // The master mic control now reaches the call, which makes this law
    // load-bearing rather than theoretical: the mixer keeps the microphone and
    // the student's TTS on SEPARATE gains, so "no audio gets in" never turns
    // into "the child cannot speak". Behaviourally proven by
    // call-audio-mixer.test.ts and npm run verify:call-audio.
    const mixer = read(MIXER);
    expect(mixer).toContain("micGain.gain.value = enabled ? 1 : 0;");
    expect(mixer).toContain("micTrack.enabled = enabled;");
    // setMicEnabled must not touch the voice side at all.
    // Slice the IMPLEMENTATION, not the interface declaration that precedes it.
    const implStart = mixer.indexOf("setMicEnabled(enabled: boolean): void {");
    expect(implStart).toBeGreaterThan(-1);
    const setMic = mixer.slice(implStart, mixer.indexOf("isMicEnabled: () =>"));
    expect(setMic).toContain("micGain");
    expect(setMic).not.toContain("voiceGain");
  });
});
