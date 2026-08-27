// Unit guard for shared/call/audio-mixer.ts — the mute POLICY, in milliseconds.
//
// The end-to-end behaviour (one track really carries both sources across real
// WebRTC, and a real media sink renders it) cannot exist in node and is covered
// by `npm run verify:call-audio`, which drives this same module in Chromium.
// What lives here is the part that is pure decision-making, so it runs in CI on
// every push instead of only when someone remembers to open a browser.
//
// The law under test:
//
//     Muting the call MICROPHONE must never mute the student's VOICE.
//
// A child whose only channel is synthesized speech must not be silenceable by a
// control labelled "mic". Before this module they shared one MediaStream as two
// tracks and one `enabled` flag, so "mute" took the child's voice with it.

import { describe, it, expect, beforeAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCallAudioMixer } from "../../shared/call/audio-mixer";

// ---------------------------------------------------------------------------
// A fake Web Audio graph. Records wiring so the test can identify which gain
// belongs to which source by FOLLOWING THE CONNECTIONS rather than by relying
// on the order the module happens to create them in.
// ---------------------------------------------------------------------------

class FakeTrack {
  enabled = true;
  readyState: "live" | "ended" = "live";
  constructor(public id: string) {}
  clone(): FakeTrack { return new FakeTrack(`${this.id}-clone`); }
  stop(): void { this.readyState = "ended"; }
}

class FakeMediaStream {
  constructor(private tracks: FakeTrack[] = []) {}
  getAudioTracks(): FakeTrack[] { return this.tracks; }
  getTracks(): FakeTrack[] { return this.tracks; }
}

interface FakeGain { gain: { value: number }; connect(t: unknown): unknown; disconnect(): void }
interface FakeSource { stream: FakeMediaStream; connect(t: unknown): unknown }

function fakeContext() {
  const wires: Array<{ from: unknown; to: unknown }> = [];
  const gains: FakeGain[] = [];
  const sources: FakeSource[] = [];
  const outTrack = new FakeTrack("mixed-out");
  let closed = false;

  const ctx = {
    state: "running" as string,
    resume: async () => {},
    close: async () => { closed = true; },
    createGain(): FakeGain {
      const g: FakeGain = {
        gain: { value: 1 },
        connect(t: unknown) { wires.push({ from: g, to: t }); return t; },
        disconnect() { /* recorded implicitly by close() */ },
      };
      gains.push(g);
      return g;
    },
    createMediaStreamDestination() {
      return { stream: new FakeMediaStream([outTrack]) };
    },
    createMediaStreamSource(stream: FakeMediaStream): FakeSource {
      const s: FakeSource = {
        stream,
        connect(t: unknown) { wires.push({ from: s, to: t }); return t; },
      };
      sources.push(s);
      return s;
    },
  };

  /** The gain node fed by the source carrying `track` — found by wiring. */
  const gainFedBy = (track: FakeTrack): FakeGain | undefined => {
    const src = sources.find((s) => s.stream.getAudioTracks().some((t) => t.id === track.id));
    if (!src) return undefined;
    return wires.find((w) => w.from === src)?.to as FakeGain | undefined;
  };

  return { ctx, gains, sources, outTrack, gainFedBy, isClosed: () => closed };
}

/** Build a mixer over fake tracks and hand back the levers to inspect it. */
function setup(opts: { mic?: boolean; voice?: boolean } = { mic: true, voice: true }) {
  const micTrack = opts.mic === false ? null : new FakeTrack("mic");
  const voiceTrack = opts.voice === false ? null : new FakeTrack("voice");
  const fake = fakeContext();
  const mixer = createCallAudioMixer({
    micTrack: micTrack as unknown as MediaStreamTrack | null,
    voiceTrack: voiceTrack as unknown as MediaStreamTrack | null,
    createContext: () => fake.ctx as unknown as AudioContext,
  });
  // The voice is CLONED into the graph; the clone is what the mixer owns.
  const voiceClone = fake.sources
    .flatMap((s) => s.stream.getAudioTracks())
    .find((t) => t.id === "voice-clone");
  return { mixer, micTrack, voiceTrack, voiceClone, fake };
}

beforeAll(() => {
  (globalThis as any).MediaStream = FakeMediaStream;
});

describe("call audio mixer", () => {
  it("exposes exactly ONE outgoing track", () => {
    const { mixer } = setup();
    expect(mixer).not.toBeNull();
    // The whole point: two sources, one track. A second track would be dropped
    // by the receiver at random (see verify:call-audio).
    expect(mixer!.track).toBeDefined();
    expect((mixer!.track as unknown as FakeTrack).id).toBe("mixed-out");
  });

  it("starts with both sources open", () => {
    const { mixer, micTrack, voiceTrack, fake } = setup();
    expect(mixer!.isMicEnabled()).toBe(true);
    expect(mixer!.isVoiceEnabled()).toBe(true);
    expect(fake.gainFedBy(micTrack!)!.gain.value).toBe(1);
    expect(fake.gainFedBy(new FakeTrack("voice-clone"))?.gain.value ?? 1).toBe(1);
    expect(voiceTrack!.readyState).toBe("live");
  });

  it("LAW: muting the mic leaves the student's voice at full gain", () => {
    const { mixer, micTrack, voiceClone, fake } = setup();

    mixer!.setMicEnabled(false);

    // Mic side silenced...
    expect(fake.gainFedBy(micTrack!)!.gain.value).toBe(0);
    expect(mixer!.isMicEnabled()).toBe(false);
    // ...voice side completely untouched. This is the assertion that would have
    // caught the original bug.
    expect(fake.gainFedBy(voiceClone!)!.gain.value).toBe(1);
    expect(mixer!.isVoiceEnabled()).toBe(true);
    expect(voiceClone!.enabled).toBe(true);
    expect(voiceClone!.readyState).toBe("live");
  });

  it("mic off stops the capture itself, not just the gain", () => {
    const { mixer, micTrack } = setup();
    // A gain node alone still listens to the room. "Mic off" has to mean the
    // room is not being captured.
    mixer!.setMicEnabled(false);
    expect(micTrack!.enabled).toBe(false);
    mixer!.setMicEnabled(true);
    expect(micTrack!.enabled).toBe(true);
  });

  it("muting the voice leaves the mic alone (independent both ways)", () => {
    const { mixer, micTrack, voiceClone, fake } = setup();

    mixer!.setVoiceEnabled(false);

    expect(fake.gainFedBy(voiceClone!)!.gain.value).toBe(0);
    expect(mixer!.isVoiceEnabled()).toBe(false);
    expect(fake.gainFedBy(micTrack!)!.gain.value).toBe(1);
    expect(micTrack!.enabled).toBe(true);
    expect(mixer!.isMicEnabled()).toBe(true);
  });

  it("re-enabling the voice is instant — the clone is never stopped", () => {
    const { mixer, voiceClone, fake } = setup();
    mixer!.setVoiceEnabled(false);
    expect(voiceClone!.readyState).toBe("live"); // gain only, never a stop
    mixer!.setVoiceEnabled(true);
    expect(fake.gainFedBy(voiceClone!)!.gain.value).toBe(1);
  });

  it("clones the voice tap so close() cannot silence the local player", () => {
    const { mixer, voiceTrack, voiceClone, micTrack } = setup();
    expect(voiceClone).toBeDefined();
    expect(voiceClone).not.toBe(voiceTrack);

    mixer!.close();

    // The mixer stops only what it made. The player's tap keeps feeding the
    // student's own speakers, and the mic belongs to the caller to stop.
    expect(voiceClone!.readyState).toBe("ended");
    expect(voiceTrack!.readyState).toBe("live");
    expect(micTrack!.readyState).toBe("live");
  });

  it("ignores control calls after close()", () => {
    const { mixer, micTrack } = setup();
    mixer!.close();
    mixer!.setMicEnabled(false);
    expect(micTrack!.enabled).toBe(true); // untouched
  });

  it("works with only a voice (no microphone permission)", () => {
    const { mixer, voiceClone, fake } = setup({ mic: false, voice: true });
    expect(mixer).not.toBeNull();
    expect(mixer!.isMicEnabled()).toBe(false);
    expect(mixer!.isVoiceEnabled()).toBe(true);
    expect(fake.gainFedBy(voiceClone!)!.gain.value).toBe(1);
    // A mic mute must not throw or disturb the voice when there is no mic.
    mixer!.setMicEnabled(true);
    expect(mixer!.isMicEnabled()).toBe(false);
    expect(fake.gainFedBy(voiceClone!)!.gain.value).toBe(1);
  });

  it("works with only a microphone (the clinician side)", () => {
    const { mixer, micTrack, fake } = setup({ mic: true, voice: false });
    expect(mixer).not.toBeNull();
    expect(mixer!.isVoiceEnabled()).toBe(false);
    expect(fake.gainFedBy(micTrack!)!.gain.value).toBe(1);
    mixer!.setMicEnabled(false);
    expect(micTrack!.enabled).toBe(false);
  });

  it("a missing voice track is REPORTED, never silently mic-only", () => {
    // The AAC declaring getAppAudioTrack and then producing no track means the
    // student's presses reach nobody — the original reported symptom. Sending
    // mic-only without a word is how that stayed invisible.
    const src = readFileSync(resolve(process.cwd(), "shared/call/call-client.ts"), "utf8");
    expect(src).toContain("if (!voiceTrack && this.opts.getAppAudioTrack)");
    expect(src).toContain("button presses will NOT be heard by the other side");
    expect(src).toContain('code: "no_voice_track"');
    // ...and the tap itself resumes a suspended context, which would otherwise
    // hand over a live track that renders silence.
    const player = readFileSync(resolve(process.cwd(), "client-aac/src/hooks/useStreamingAudioPlayer.ts"), "utf8");
    expect(player).toContain('if (ctx && ctx.state === "suspended")');
    expect(player).toContain("no call tap");
  });

  it("returns null when there is nothing to mix", () => {
    const fake = fakeContext();
    expect(createCallAudioMixer({
      micTrack: null,
      voiceTrack: null,
      createContext: () => fake.ctx as unknown as AudioContext,
    })).toBeNull();
  });

  it("returns null rather than throwing when Web Audio is unavailable", () => {
    // Callers must degrade explicitly; a throw here would break the whole call.
    const mixer = createCallAudioMixer({
      micTrack: new FakeTrack("mic") as unknown as MediaStreamTrack,
      voiceTrack: null,
      createContext: () => { throw new Error("no Web Audio"); },
    });
    expect(mixer).toBeNull();
  });

  it("resumes a context that starts suspended", () => {
    // A suspended context outputs silence — the outgoing track would be dead.
    const micTrack = new FakeTrack("mic");
    const fake = fakeContext();
    fake.ctx.state = "suspended";
    let resumed = false;
    fake.ctx.resume = async () => { resumed = true; };
    createCallAudioMixer({
      micTrack: micTrack as unknown as MediaStreamTrack,
      voiceTrack: null,
      createContext: () => fake.ctx as unknown as AudioContext,
    });
    expect(resumed).toBe(true);
  });
});
