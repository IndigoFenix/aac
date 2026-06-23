/**
 * audioActivityMonitor.ts
 *
 * Monitors audio energy levels to detect speech boundaries.
 * Uses Web Speech API when available for speech boundary events,
 * always runs an AudioContext energy monitor for energy levels.
 */

export interface AudioActivityState {
  isSpeaking: boolean;
  speechStartedAt: number | null;
  lastSpeechEndedAt: number | null;
  energyLevel: number;
  hasActiveAudio: boolean;
}

export type AudioActivityCallback = (state: AudioActivityState) => void;

export interface AudioActivityConfig {
  /** Energy level to count as speech (default 0.015) */
  speechThreshold: number;
  /** Energy level for silence (default 0.005) */
  silenceThreshold: number;
  /** Silence needed to end a speech segment in ms (default 1500) */
  silenceDurationMs: number;
  /** Callback on state changes */
  onStateChange?: AudioActivityCallback;
}

const DEFAULT_CONFIG: AudioActivityConfig = {
  speechThreshold: 0.015,
  silenceThreshold: 0.005,
  silenceDurationMs: 1500,
};

export interface SpeechBoundary {
  start: number; // wall-clock ms when speech started
  end: number;   // wall-clock ms when speech ended
}

export class AudioActivityMonitor {
  private config: AudioActivityConfig;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private energyTimerId: ReturnType<typeof setInterval> | null = null;
  private state: AudioActivityState;

  // Energy-based speech detection state
  private speechStartTime = 0;
  private silenceStartTime = 0;
  private consecutiveHighEnergy = 0;

  // Speech boundary tracking for ring buffer extraction
  private lastSpeechBoundary: SpeechBoundary | null = null;

  // Web Speech API (type not always available in TS, use any)
  private speechRecognition: any = null;
  private usingSpeechAPI = false;

  constructor(config?: Partial<AudioActivityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      isSpeaking: false,
      speechStartedAt: null,
      lastSpeechEndedAt: null,
      energyLevel: 0,
      hasActiveAudio: false,
    };
  }

  start(stream: MediaStream): void {
    this.stop();

    // Set up AudioContext for energy monitoring + the STT ring buffer that hangs
    // off the same context. Pin it to 16 kHz so the BROWSER resamples the mic
    // (with a proper anti-alias filter) — the ring buffer's manual
    // downsample-to-16k is then a pass-through. Capturing at 48k and crudely
    // linear-interpolating to 16k aliased the speech and badly hurt STT
    // accuracy. 16 kHz is the recognizer's native rate and ample for all the
    // speech analysis (VAD / pitch / formants) hanging off this context.
    try {
      try {
        this.audioCtx = new AudioContext({ sampleRate: 16000 });
      } catch {
        this.audioCtx = new AudioContext(); // browser rejected the rate hint
      }

      // Chrome suspends AudioContext until user interaction — resume it
      if (this.audioCtx.state === "suspended") {
        console.log("[AudioActivityMonitor] AudioContext suspended, resuming...");
        this.audioCtx.resume().then(() => {
          console.log("[AudioActivityMonitor] AudioContext resumed:", this.audioCtx?.state);
        }).catch(err => {
          console.warn("[AudioActivityMonitor] Failed to resume AudioContext:", err);
        });
      }

      this.sourceNode = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.sourceNode.connect(this.analyser);

      console.log(`[AudioActivityMonitor] Started: sampleRate=${this.audioCtx.sampleRate}, state=${this.audioCtx.state}`);

      // Sample energy at 10Hz
      this.energyTimerId = setInterval(() => this.sampleEnergy(), 100);
    } catch (err) {
      console.warn("[AudioActivityMonitor] Failed to set up AudioContext:", err);
    }

    // Try Web Speech API for speech boundaries
    this.tryStartSpeechRecognition();
  }

  stop(): void {
    if (this.energyTimerId) {
      clearInterval(this.energyTimerId);
      this.energyTimerId = null;
    }

    if (this.speechRecognition) {
      try {
        this.speechRecognition.onend = null;
        this.speechRecognition.abort();
      } catch { /* ignore */ }
      this.speechRecognition = null;
      this.usingSpeechAPI = false;
    }

    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch { /* ignore */ }
      this.sourceNode = null;
    }

    this.analyser = null;

    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch { /* ignore */ }
      this.audioCtx = null;
    }

    this.state = {
      isSpeaking: false,
      speechStartedAt: null,
      lastSpeechEndedAt: null,
      energyLevel: 0,
      hasActiveAudio: false,
    };
    this.lastSpeechBoundary = null;
  }

  getState(): AudioActivityState {
    return { ...this.state };
  }

  /** Expose the AudioContext so the ring buffer can share it. */
  getAudioContext(): AudioContext | null {
    return this.audioCtx;
  }

  /** Expose the source node so the ring buffer can connect to it. */
  getSourceNode(): MediaStreamAudioSourceNode | null {
    return this.sourceNode;
  }

  /**
   * Consume the last completed speech boundary (start/end timestamps).
   * Returns once and clears — prevents double-consumption.
   */
  consumeLastSpeechBoundary(): SpeechBoundary | null {
    const boundary = this.lastSpeechBoundary;
    this.lastSpeechBoundary = null;
    return boundary;
  }

  /** Peek at the last speech boundary without consuming it. */
  peekLastSpeechBoundary(): SpeechBoundary | null {
    return this.lastSpeechBoundary;
  }

  /** Whether Web Speech API or energy-based fallback is being used. */
  getSpeechMethod(): 'webSpeechApi' | 'energy' {
    return this.usingSpeechAPI ? 'webSpeechApi' : 'energy';
  }

  private tryStartSpeechRecognition(): void {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;

      recognition.onspeechstart = () => {
        this.usingSpeechAPI = true;
        this.silenceStartTime = 0; // Reset so energy safety net starts fresh
        this.updateState({ isSpeaking: true, speechStartedAt: Date.now(), hasActiveAudio: true });
      };

      recognition.onspeechend = () => {
        const now = Date.now();
        if (this.state.speechStartedAt) {
          this.lastSpeechBoundary = { start: this.state.speechStartedAt, end: now };
        }
        this.silenceStartTime = 0; // Reset energy safety net
        this.updateState({ isSpeaking: false, lastSpeechEndedAt: now });
      };

      // Restart on end to keep it running continuously
      recognition.onend = () => {
        if (this.speechRecognition === recognition) {
          try { recognition.start(); } catch { /* ignore */ }
        }
      };

      recognition.onerror = () => {
        // Non-fatal — fall back to energy-based detection
      };

      recognition.start();
      this.speechRecognition = recognition;
    } catch {
      // Web Speech API not available — energy-based fallback only
    }
  }

  private sampleEnergy(): void {
    if (!this.analyser) return;

    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);

    // Compute RMS energy (0-1 range)
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const normalized = data[i] / 255;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / data.length);

    const hasActiveAudio = rms > this.config.silenceThreshold;
    this.state.energyLevel = rms;
    this.state.hasActiveAudio = hasActiveAudio;

    const now = Date.now();

    if (this.usingSpeechAPI) {
      // WebSpeech is active but unreliable — use energy as a safety net.
      // If WebSpeech says "speaking" but energy is silent, force-end after timeout.
      if (this.state.isSpeaking) {
        if (rms < this.config.silenceThreshold) {
          if (this.silenceStartTime === 0) {
            this.silenceStartTime = now;
          } else if (now - this.silenceStartTime >= this.config.silenceDurationMs) {
            // WebSpeech stuck — force end speech via energy timeout
            const endTime = this.silenceStartTime; // speech actually ended when silence began
            if (this.state.speechStartedAt) {
              this.lastSpeechBoundary = { start: this.state.speechStartedAt, end: endTime };
            }
            this.updateState({ isSpeaking: false, lastSpeechEndedAt: endTime });
            this.silenceStartTime = 0;
          }
        } else {
          // Still hearing energy — reset silence counter
          this.silenceStartTime = 0;
        }
      }
      this.config.onStateChange?.(this.getState());
      return;
    }

    // Energy-based speech detection fallback (no WebSpeech)
    if (rms > this.config.speechThreshold) {
      this.consecutiveHighEnergy++;
      this.silenceStartTime = 0;

      // Require 200ms+ of high energy to count as speech start (2 samples at 10Hz)
      if (!this.state.isSpeaking && this.consecutiveHighEnergy >= 2) {
        this.speechStartTime = now;
        this.updateState({ isSpeaking: true, speechStartedAt: now, hasActiveAudio: true });
      }
    } else {
      this.consecutiveHighEnergy = 0;

      if (this.state.isSpeaking) {
        if (this.silenceStartTime === 0) {
          this.silenceStartTime = now;
        } else if (now - this.silenceStartTime >= this.config.silenceDurationMs) {
          if (this.state.speechStartedAt) {
            this.lastSpeechBoundary = { start: this.state.speechStartedAt, end: now };
          }
          this.updateState({ isSpeaking: false, lastSpeechEndedAt: now });
          this.silenceStartTime = 0;
        }
      }
    }

    this.config.onStateChange?.(this.getState());
  }

  private updateState(partial: Partial<AudioActivityState>): void {
    Object.assign(this.state, partial);
    this.config.onStateChange?.(this.getState());
  }
}
