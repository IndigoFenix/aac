// Per-socket streaming STT for a non-student (clinician) caller. Their mic PCM
// (LINEAR16 16kHz mono, base64) arrives over /ws/call; we feed it to a Google
// Cloud STT streaming session and call `onFinal` with each committed phrase, so
// the caller's speech can be published into the conversation room and perceived
// by the AAC students' AIs.
//
// In-region Google Cloud STT (same service as the AAC live path) keeps clinical
// audio inside the platform's GCP relationship — see google-stt-service.ts.
//
// MODEL. `latest_long`, NOT the `latest_short` this used to pass. The service's
// own guidance is that latest_short is for "turn-sized clips" — which is what
// the AAC's two callers send (a bounded speech segment each). A call is the
// opposite shape: ONE continuously open microphone for the whole session,
// minutes long, with many utterances and long silences. That is what
// latest_long is for.

import { createStreamingSession, type SttStreamSession } from "../voice/google-stt-service";
import { logLiveSession } from "../dual-agent/dual-agent-logger";

// Restart the session before Google's ~5-minute streaming cap. A long call rolls
// over to a fresh session transparently; phrases are committed via onFinal as
// they happen, so a rollover at most clips a word at the seam.
const SESSION_MAX_MS = 4 * 60 * 1000;
// A gap longer than a normal speech pause (mute, long silence) means the prior
// streaming session has likely gone idle/ended — start a fresh one on resume.
const GAP_RESET_MS = 8000;
// A feed gap longer than this is logged. Chunks arrive ~11.7/s (85ms of audio
// each), so anything past ~2s means audio was lost or badly delayed.
const STALL_WARN_MS = 2000;

export class ClinicianStt {
  private session: SttStreamSession | null = null;
  private startedAt = 0;
  private lastFeedAt = 0;
  private chunkCount = 0;

  private interimCount = 0;
  private finalCount = 0;
  // Cadence tracking. `feed` is called once per client chunk, so comparing the
  // CLIENT's own clock deltas with ours separates "the client stopped producing
  // audio" from "the audio was produced but reached us late" — the two have
  // completely different fixes and the logs could not previously tell them
  // apart. See the 2026-08-26 session: arrival collapsed from 11.7 chunks/s to
  // 1.16 and Google killed the stream with an audio timeout, with no way to
  // know which side stalled.
  private windowStartServerAt = 0;
  private windowStartClientAt = 0;

  constructor(
    private readonly languageHint: string | undefined,
    private readonly onFinal: (text: string) => void,
    private readonly sampleRate: number,
    // Live interim+final transcripts for displaying on the caller's own screen
    // (debug: shows whether the recognizer is hearing the speech).
    private readonly onTranscript?: (text: string, isFinal: boolean) => void,
  ) {}

  /** Feed a base64 LINEAR16 chunk; lazily opens / rolls over the session.
   *  `clientAt` is the sender's own timestamp for this chunk (its clock), used
   *  only for DELTAS — never compared against ours absolutely, so clock skew
   *  between the two machines is irrelevant. */
  feed(base64: string, clientAt?: number): void {
    const now = Date.now();
    const gap = this.lastFeedAt ? now - this.lastFeedAt : 0;
    if (!this.session) {
      this.open();
    } else if (gap > GAP_RESET_MS || now - this.startedAt > SESSION_MAX_MS) {
      logLiveSession("CLINICIAN_STT", `rolling over session (gap=${gap}ms, age=${now - this.startedAt}ms)`);
      this.rollover();
    }
    // A single gap this long is audible as a dropout and, repeated, is what ends
    // a Google stream with "Long duration elapsed without audio".
    if (gap > STALL_WARN_MS) {
      logLiveSession("CLINICIAN_STT", `STALL: ${gap}ms with no audio (chunk #${this.chunkCount + 1}). Expect a recogniser timeout if this repeats.`);
    }
    this.lastFeedAt = now;
    this.chunkCount++;

    if (this.windowStartServerAt === 0) {
      this.windowStartServerAt = now;
      this.windowStartClientAt = clientAt ?? 0;
    }
    // Periodic heartbeat — now reporting the ARRIVAL rate and, when the client
    // stamps its chunks, the rate the client actually PRODUCED them at.
    if (this.chunkCount % 50 === 1 && this.chunkCount > 1) {
      const serverSpan = now - this.windowStartServerAt;
      const arrivalRate = serverSpan > 0 ? (50_000 / serverSpan).toFixed(1) : "?";
      let produced = "";
      if (clientAt && this.windowStartClientAt) {
        const clientSpan = clientAt - this.windowStartClientAt;
        const produceRate = clientSpan > 0 ? (50_000 / clientSpan).toFixed(1) : "?";
        const verdict = clientSpan > 0 && serverSpan > clientSpan * 2
          ? " → CLIENT PRODUCED IT, WE RECEIVED IT LATE (transport/event-loop)"
          : clientSpan > serverSpan * 2
            ? " → arrived faster than produced (burst catch-up)"
            : " → in step";
        produced = `, produced ${produceRate}/s over ${clientSpan}ms${verdict}`;
      }
      logLiveSession(
        "CLINICIAN_STT",
        `chunk #${this.chunkCount} — arriving ${arrivalRate}/s over ${serverSpan}ms${produced}; interims=${this.interimCount} finals=${this.finalCount}, session=${this.session ? "open" : "none"}`,
      );
      this.windowStartServerAt = now;
      this.windowStartClientAt = clientAt ?? 0;
    }
    this.session!.write(base64);
  }

  private open(): void {
    this.startedAt = Date.now();
    this.interimCount = 0;
    this.finalCount = 0;
    logLiveSession("CLINICIAN_STT", `opening Google STT streaming session (lang=${this.languageHint ?? "?"}, sampleRate=${this.sampleRate})`);
    const s = createStreamingSession({
      languageHint: this.languageHint,
      sampleRateHertz: this.sampleRate,
      model: "latest_long",
      // Interim results: lets us confirm the recognizer is hearing speech even
      // before a phrase is committed (diagnostic) and tends to commit finals
      // more reliably on a continuous stream.
      onInterim: (text) => {
        if (!text.trim()) return;
        this.interimCount++;
        // Log the FIRST interim of each session — it is the proof the recogniser
        // is actually hearing this stream, and its absence is the symptom of a
        // stream that opened but went nowhere.
        if (this.interimCount === 1) {
          logLiveSession("CLINICIAN_STT", `STT interim (first this session): "${text}" — recogniser is hearing audio`);
        }
        this.onTranscript?.(text, false);
      },
      onFinal: (text) => {
        const t = text.trim();
        if (!t) return;
        this.finalCount++;
        this.onTranscript?.(t, true);
        this.onFinal(t);
      },
      // On a terminal stream error, drop the session so the next chunk reopens.
      onError: (msg) => {
        console.warn("[clinicianStt]", msg);
        logLiveSession("CLINICIAN_STT", `STT stream ERROR: ${msg}`);
        if (this.session === s) this.session = null;
      },
    });
    this.session = s;
  }

  private rollover(): void {
    const old = this.session;
    this.session = null;
    void old?.end().catch(() => { /* ignore */ });
    this.open();
  }

  /** End the session (call ended / socket closed). */
  stop(): void {
    const old = this.session;
    this.session = null;
    void old?.end().catch(() => { /* ignore */ });
  }
}
