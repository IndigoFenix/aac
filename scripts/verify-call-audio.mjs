// scripts/verify-call-audio.mjs
//
//   npm run verify:call-audio
//
// End-to-end guard for the call's outgoing audio. Jest cannot cover this: the
// defect it protects against lives in real WebRTC transport and real media-sink
// behaviour, neither of which exists in node. So this drives the REAL
// shared/call/audio-mixer.ts (esbuild-bundled here, never reimplemented) through
// a loopback RTCPeerConnection in Chromium and measures the far end with an FFT.
//
// THE DEFECT IT GUARDS. The AAC used to add its TTS tap to the mic's stream as a
// SECOND audio track. A media element renders one audio track of a stream and
// picks it by track *id*, which is random — so each call was a coin flip between
// hearing the student's microphone and hearing their button presses, never both.
// Measured before the fix: lower track id won 8/8, add order uncorrelated.
//
// Two oscillators stand in for the sources so they stay identifiable after opus:
//     MIC = 440 Hz     VOICE (TTS) = 1200 Hz
//
// Runs headful with --mute-audio (Web Audio needs a real output device to render
// the graph; nothing is audible) in Puppeteer's own Chromium, so it never
// touches the developer's browser. Exits non-zero on any failed check.

import { build } from "esbuild";
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIC_HZ = 440, VOICE_HZ = 1200, SILENT = -999, FLOOR = -60;

const bundled = await build({
  entryPoints: [resolve(ROOT, "shared/call/audio-mixer.ts")],
  bundle: true, format: "iife", globalName: "AudioMixer", write: false,
});
const BUNDLE = bundled.outputFiles[0].text;

const browser = await puppeteer.launch({
  headless: false,
  args: [
    "--no-sandbox", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--window-position=-2400,-2400", "--window-size=300,200",
  ],
});

let out;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("   [page error]", e.message));
  await page.setContent("<!doctype html><title>verify-call-audio</title><body></body>");
  await page.addScriptTag({ content: BUNDLE });

  out = await page.evaluate(async (MIC_HZ, VOICE_HZ, SILENT) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();

    function toneTrack(hz) {
      const osc = ctx.createOscillator(); osc.frequency.value = hz;
      const g = ctx.createGain(); g.gain.value = 0.3;
      // Slight tremolo so Chrome's pipeline doesn't mistake a steady tone for
      // stationary noise and suppress it.
      const lfo = ctx.createOscillator(); lfo.frequency.value = 4;
      const lg = ctx.createGain(); lg.gain.value = 0.1;
      lfo.connect(lg).connect(g.gain);
      const d = ctx.createMediaStreamDestination();
      osc.connect(g).connect(d); osc.start(); lfo.start();
      return d.stream.getAudioTracks()[0];
    }

    async function energy(stream, ms = 1000) {
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0;
      src.connect(an);
      const bins = new Float32Array(an.frequencyBinCount);
      const binHz = ctx.sampleRate / an.fftSize;
      const peak = { [MIC_HZ]: -Infinity, [VOICE_HZ]: -Infinity };
      const until = Date.now() + ms;
      while (Date.now() < until) {
        an.getFloatFrequencyData(bins);
        for (const f of [MIC_HZ, VOICE_HZ]) {
          const i = Math.round(f / binHz);
          const v = Math.max(bins[i - 1], bins[i], bins[i + 1]);
          if (v > peak[f]) peak[f] = v;
        }
        await sleep(30);
      }
      try { src.disconnect(); } catch {}
      return {
        mic: peak[MIC_HZ] === -Infinity ? SILENT : peak[MIC_HZ],
        voice: peak[VOICE_HZ] === -Infinity ? SILENT : peak[VOICE_HZ],
      };
    }

    const micTrack = toneTrack(MIC_HZ);
    const voiceTrack = toneTrack(VOICE_HZ);
    await sleep(300);

    // SELF-TEST: if the sources aren't distinct, every number below is noise.
    const selfMic = await energy(new MediaStream([micTrack]), 600);
    const selfVoice = await energy(new MediaStream([voiceTrack]), 600);

    const mixer = window.AudioMixer.createCallAudioMixer({ micTrack, voiceTrack });
    if (!mixer) return { fatal: "createCallAudioMixer returned null" };

    const sendStream = new MediaStream([mixer.track]);
    const res = { selfMic, selfVoice, sentTracks: sendStream.getAudioTracks().length };

    const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    const got = new Promise((r) => { pc2.ontrack = (e) => r(e.streams[0]); });
    // The same addTrack(track, stream) pattern PeerMesh uses.
    for (const t of sendStream.getTracks()) pc1.addTrack(t, sendStream);
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    const recv = await got;
    const t0 = Date.now();
    while (pc1.connectionState !== "connected" && Date.now() - t0 < 10000) await sleep(100);

    // Chromium leaves a remote audio track silent unless it is attached to a
    // media element; --mute-audio keeps it inaudible.
    const el = document.createElement("audio");
    el.autoplay = true; el.srcObject = recv; document.body.appendChild(el);
    try { await el.play(); } catch {}
    await sleep(1400);

    res.receivedTracks = recv.getAudioTracks().length;
    res.both = await energy(recv);

    mixer.setMicEnabled(false);
    await sleep(900);
    res.micMuted = await energy(recv);
    res.micTrackEnabledAfterMute = micTrack.enabled;

    mixer.setMicEnabled(true);
    mixer.setVoiceEnabled(false);
    await sleep(900);
    res.voiceMuted = await energy(recv);
    res.micTrackEnabledAfterUnmute = micTrack.enabled;

    mixer.setVoiceEnabled(true);
    mixer.close();
    res.callerVoiceTrackAfterClose = voiceTrack.readyState;

    pc1.close(); pc2.close();
    return res;
  }, MIC_HZ, VOICE_HZ, SILENT);
} finally {
  await browser.close();
}

if (out.fatal) {
  console.error(`\nFATAL: ${out.fatal}\n`);
  process.exit(1);
}

const on = (v) => v !== SILENT && v > FLOOR;
const f = (v) => (v === SILENT ? "  silent" : `${v.toFixed(1)} dB`.padStart(9));
const row = (lbl, e) =>
  `  ${lbl.padEnd(26)} mic ${f(e.mic)} ${on(e.mic) ? "ON " : "off"}   voice ${f(e.voice)} ${on(e.voice) ? "ON " : "off"}`;

console.log("\n========= verify:call-audio — shared/call/audio-mixer.ts =========\n");
console.log(row("SELF-TEST mic source:", out.selfMic));
console.log(row("SELF-TEST voice source:", out.selfVoice));
console.log("");
console.log(`  tracks sent by mixer        : ${out.sentTracks}`);
console.log(`  audio tracks at receiver    : ${out.receivedTracks}`);
console.log("");
console.log(row("both sources live:", out.both));
console.log(row("mic muted:", out.micMuted));
console.log(row("voice muted:", out.voiceMuted));
console.log("");
console.log(`  micTrack.enabled when muted : ${out.micTrackEnabledAfterMute}`);
console.log(`  caller voice track on close : ${out.callerVoiceTrackAfterClose}`);

const checks = [
  ["harness self-test: sources are distinct",
    on(out.selfMic.mic) && !on(out.selfMic.voice) && on(out.selfVoice.voice) && !on(out.selfVoice.mic)],
  ["mixer emits exactly ONE track",            out.sentTracks === 1],
  ["receiver gets exactly ONE audio track",    out.receivedTracks === 1],
  ["both sources audible on that one track",   on(out.both.mic) && on(out.both.voice)],
  ["LAW: mic mute leaves the voice audible",   !on(out.micMuted.mic) && on(out.micMuted.voice)],
  ["voice mute leaves the mic audible",        on(out.voiceMuted.mic) && !on(out.voiceMuted.voice)],
  ["mic off stops capture, not just gain",     out.micTrackEnabledAfterMute === false],
  ["unmute restores capture",                  out.micTrackEnabledAfterUnmute === true],
  ["close() spares the caller's voice track",  out.callerVoiceTrackAfterClose === "live"],
];

console.log("\n  ----------------------------------------------------------");
let pass = true;
for (const [name, ok] of checks) { if (!ok) pass = false; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`); }
console.log("  ----------------------------------------------------------");
console.log(`\n  ${pass ? "OK — outgoing call audio is correct" : "*** FAILED ***"}\n`);
process.exit(pass ? 0 : 1);
