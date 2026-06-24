// shared/social-world/npc-voice-player.ts
//
// A tiny self-contained voice player for NPC speech. The social-bot relay streams
// a turn's TTS as a sequence of independently-playable base64 WAV chunks (the AAC
// client's player decodes one blob per chunk and plays them in order — we mirror
// that, minus the pitch/formant pipeline that lives in the AAC client and can't be
// imported from shared). One player serves the ACTIVE conversation at a time.
//
// Also exposes a 0..1 "speaking level" from a WebAudio analyser so the procedural
// face can flap its mouth in sync. DOM-typed (Audio/AudioContext), like
// ProceduralFace — only ever imported by client React code, never the server.

function base64ToBlobUrl(base64: string, mime: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

export class NpcVoicePlayer {
  private readonly audio: HTMLAudioElement;
  private queue: string[] = []; // pending object URLs
  private current: string | null = null;
  private playing = false;
  private disposed = false;

  // Analyser graph (lazily built on first play, after a user gesture so the
  // AudioContext is allowed to start).
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId = 0;
  private bins: Uint8Array | null = null;

  /** Latest 0..1 speaking amplitude — feed to ProceduralFace `speakingLevel`. */
  level = 0;
  /** Called whenever `level` changes meaningfully (drives a React re-render). */
  onLevel: ((level: number) => void) | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", this.onEnded);
    this.audio.addEventListener("error", this.onEnded);
  }

  /** Silence (or unsilence) local output — used by the window's audio-output mute.
   *  Playback continues internally; only the speaker output is muted. */
  setMuted(muted: boolean): void {
    this.audio.muted = muted;
  }

  /** Queue one base64 WAV chunk (format from the relay's `bot_audio.format`). */
  enqueue(base64: string, format: "wav" | "mp3" | "ogg" | "webm" = "wav"): void {
    if (this.disposed) return;
    const mime = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
    this.queue.push(base64ToBlobUrl(base64, mime));
    if (!this.playing) void this.playNext();
  }

  private playNext = async (): Promise<void> => {
    if (this.disposed) return;
    const next = this.queue.shift();
    if (!next) {
      this.playing = false;
      this.setLevel(0);
      return;
    }
    this.playing = true;
    this.revokeCurrent();
    this.current = next;
    this.audio.src = next;
    this.ensureAnalyser();
    try {
      await this.ctx?.resume();
      await this.audio.play();
      this.startMeter();
    } catch {
      // Autoplay blocked or decode failed — skip to the next chunk.
      this.onEnded();
    }
  };

  private onEnded = (): void => {
    this.revokeCurrent();
    void this.playNext();
  };

  /** Stop immediately and drop anything queued (e.g. switching active NPC). */
  stop(): void {
    this.queue.forEach((u) => URL.revokeObjectURL(u));
    this.queue = [];
    try { this.audio.pause(); } catch { /* ignore */ }
    this.revokeCurrent();
    this.playing = false;
    this.stopMeter();
    this.setLevel(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.audio.removeEventListener("ended", this.onEnded);
    this.audio.removeEventListener("error", this.onEnded);
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.analyser = null;
  }

  // --- analyser / level meter ------------------------------------------------

  private ensureAnalyser(): void {
    if (this.ctx || this.disposed) return;
    try {
      const Ctx = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext });
      const AC = Ctx.AudioContext ?? Ctx.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const src = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch {
      // No analyser → mouth still opens a little via a fallback in startMeter.
      this.ctx = null;
      this.analyser = null;
    }
  }

  private startMeter(): void {
    if (this.rafId) return;
    const tick = (): void => {
      if (this.disposed || !this.playing) return;
      if (this.analyser && this.bins) {
        this.analyser.getByteTimeDomainData(this.bins);
        let sum = 0;
        for (let i = 0; i < this.bins.length; i++) {
          const v = (this.bins[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / this.bins.length);
        this.setLevel(Math.min(1, rms * 3));
      } else {
        // Analyser unavailable — a gentle idle flap so the face still looks alive.
        this.setLevel(0.4 + 0.2 * Math.sin(this.audio.currentTime * 18));
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopMeter(): void {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
  }

  private setLevel(level: number): void {
    if (Math.abs(level - this.level) < 0.02 && level !== 0) return;
    this.level = level;
    this.onLevel?.(level);
  }

  private revokeCurrent(): void {
    if (this.current) { URL.revokeObjectURL(this.current); this.current = null; }
  }
}
