// Per-socket streaming STT for a non-student (clinician) caller. Their mic PCM
// (LINEAR16 16kHz mono, base64) arrives over /ws/call; we feed it to a Google
// Cloud STT streaming session and call `onFinal` with each committed phrase, so
// the caller's speech can be published into the conversation room and perceived
// by the AAC students' AIs.
//
// In-region Google Cloud STT (same service as the AAC live path) keeps clinical
// audio inside the platform's GCP relationship — see google-stt-service.ts.

import { createStreamingSession, type SttStreamSession } from "../voice/google-stt-service";
import { logLiveSession } from "../dual-agent/dual-agent-logger";

// Restart the session before Google's ~5-minute streaming cap. A long call rolls
// over to a fresh session transparently; phrases are committed via onFinal as
// they happen, so a rollover at most clips a word at the seam.
const SESSION_MAX_MS = 4 * 60 * 1000;
// A gap longer than a normal speech pause (mute, long silence) means the prior
// streaming session has likely gone idle/ended — start a fresh one on resume.
const GAP_RESET_MS = 8000;

export class ClinicianStt {
  private session: SttStreamSession | null = null;
  private startedAt = 0;
  private lastFeedAt = 0;
  private chunkCount = 0;

  private interimLogged = false;

  constructor(
    private readonly languageHint: string | undefined,
    private readonly onFinal: (text: string) => void,
    private readonly sampleRate: number,
    // Live interim+final transcripts for displaying on the caller's own screen
    // (debug: shows whether the recognizer is hearing the speech).
    private readonly onTranscript?: (text: string, isFinal: boolean) => void,
  ) {}

  /** Feed a base64 LINEAR16 chunk; lazily opens / rolls over the session. */
  feed(base64: string): void {
    const now = Date.now();
    if (!this.session) {
      this.open();
    } else if (now - this.lastFeedAt > GAP_RESET_MS || now - this.startedAt > SESSION_MAX_MS) {
      this.rollover();
    }
    this.lastFeedAt = now;
    this.chunkCount++;
    // Periodic heartbeat so we can confirm audio is flowing without flooding.
    if (this.chunkCount % 50 === 1) {
      logLiveSession("CLINICIAN_STT", `feeding audio — chunk #${this.chunkCount} (~${(base64.length * 0.75) | 0} bytes), session=${this.session ? "open" : "none"}`);
    }
    this.session!.write(base64);
  }

  private open(): void {
    this.startedAt = Date.now();
    logLiveSession("CLINICIAN_STT", `opening Google STT streaming session (lang=${this.languageHint ?? "?"}, sampleRate=${this.sampleRate})`);
    const s = createStreamingSession({
      languageHint: this.languageHint,
      sampleRateHertz: this.sampleRate,
      model: "latest_short",
      // Interim results: lets us confirm the recognizer is hearing speech even
      // before a phrase is committed (diagnostic) and tends to commit finals
      // more reliably on a continuous stream.
      onInterim: (text) => {
        if (!this.interimLogged && text.trim()) {
          this.interimLogged = true;
          logLiveSession("CLINICIAN_STT", `STT interim (first): "${text}" — recognizer is hearing audio`);
        }
        if (text.trim()) this.onTranscript?.(text, false);
      },
      onFinal: (text) => {
        const t = text.trim();
        if (!t) return;
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
