// server/services/voice/gemini-live-tts-service.ts
// Gemini Live API TTS — persistent WebSocket session that reads arbitrary text verbatim.
// Avoids the ~2.5s HTTP connection overhead of gemini-tts-service.ts by keeping one
// Live session warm for the duration of an AAC conversation.

import { GoogleGenAI, Modality, HarmCategory, HarmBlockThreshold } from "@google/genai";
import type { Session, LiveServerMessage } from "@google/genai";

const TTS_SYSTEM_PROMPT = `You are a text-to-speech engine.
Your ONLY job is to read aloud, verbatim, the text the user sends you.

Strict rules:
- Speak exactly the text the user sends, in the language it is written in.
- Do NOT add greetings, acknowledgements, commentary, questions, or translations.
- Do NOT say "sure", "okay", "here goes", or any filler.
- Do NOT rephrase, summarize, or correct the text.
- If the text is a single word, say that single word and stop.
- If the text ends mid-sentence, say it mid-sentence and stop.
- Use natural intonation appropriate to the punctuation.

You are not a conversational assistant. You are a voice.`;

interface PendingRequest {
  text: string;
  resolve: () => void;
  reject: (err: Error) => void;
  onChunk: (wav: Buffer) => void;
}

export interface GeminiLiveTtsOptions {
  voiceName: string;      // e.g. "Puck", "Leda"
  language?: string;      // informational (for logging / reconnection parity)
  useVertexAI?: boolean;  // default: infer from env
}

/**
 * A single persistent Gemini Live session dedicated to reading arbitrary text.
 * Create one per AAC conversation, reuse for every student utterance, close
 * when the conversation ends.
 *
 * Requests are serialized — the session is turn-based, so overlapping requests
 * would corrupt one another's audio streams.
 */
export class GeminiLiveTtsSession {
  private client: GoogleGenAI;
  private session: Session | null = null;
  private resumptionHandle: string | null = null;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;

  private readonly voiceName: string;
  private readonly language: string;
  private readonly modelName = "gemini-live-2.5-flash-native-audio";

  // Serialize requests — one TTS turn at a time
  private activeRequest: PendingRequest | null = null;
  private queue: PendingRequest[] = [];

  private closedIntentionally = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static RECONNECT_INTERVAL_MS = 510_000; // ~8.5 min

  constructor(options: GeminiLiveTtsOptions) {
    this.voiceName = options.voiceName;
    this.language = options.language || "en";

    const useVertexAI = options.useVertexAI ??
      !!(process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT);

    if (useVertexAI) {
      const project = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
      const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
      const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
      const googleAuthOptions = credentialsJson
        ? { credentials: JSON.parse(credentialsJson) }
        : undefined;
      this.client = new GoogleGenAI({
        vertexai: true,
        project,
        location,
        ...(googleAuthOptions ? { googleAuthOptions } : {}),
      });
    } else {
      this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.connect().catch(err => {
      console.error("[GeminiLiveTTS] Initial connect failed:", err);
      this.readyReject(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async connect(): Promise<void> {
    try {
      this.session = await this.client.live.connect({
        model: this.modelName,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: TTS_SYSTEM_PROMPT }] },
          temperature: 0.2,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName } },
          },
          sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
          contextWindowCompression: {
            triggerTokens: "8000",
            slidingWindow: { targetTokens: "4000" },
          },
          // Safety filters off — same rationale as the main conversation
          // provider (controlled AAC vocabulary, strict prompt). `safetySettings`
          // is accepted by the runtime but missing from LiveConnectConfig's
          // type definition — cast suppresses the known error.
          ...({
            safetySettings: [
              { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.OFF },
              { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.OFF },
              { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.OFF },
              { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.OFF },
              { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.OFF },
            ],
          } as any),
        },
        callbacks: {
          onopen: () => {
            console.log(`[GeminiLiveTTS] Connected (voice=${this.voiceName}, lang=${this.language})`);
          },
          onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
          onerror: (e: ErrorEvent) => {
            const msg = e.message || "WebSocket error";
            console.error("[GeminiLiveTTS] WebSocket error:", msg);
            this.failActive(new Error(msg));
          },
          onclose: (e: CloseEvent) => {
            console.log(`[GeminiLiveTTS] Closed: code=${e.code} reason=${e.reason || ""}`);
            this.clearReconnectTimer();
            if (!this.closedIntentionally && e.code !== 1000) {
              this.failActive(new Error(`session closed: ${e.code} ${e.reason || ""}`));
              setTimeout(() => {
                if (!this.closedIntentionally) {
                  this.reconnect().catch(err => {
                    console.error("[GeminiLiveTTS] Reconnect failed:", err);
                  });
                }
              }, 1000);
            }
          },
        },
      });
      this.startReconnectTimer();
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async reconnect(): Promise<void> {
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    // Reset readiness — new session won't be ready until setupComplete
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    await this.connect();
  }

  private startReconnectTimer(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      console.log("[GeminiLiveTTS] Proactive reconnect (approaching 10-min limit)");
      this.reconnect().catch(err => {
        console.error("[GeminiLiveTTS] Proactive reconnect failed:", err);
      });
    }, GeminiLiveTtsSession.RECONNECT_INTERVAL_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleMessage(msg: LiveServerMessage): void {
    if (msg.setupComplete) {
      this.readyResolve();
      return;
    }

    if (msg.sessionResumptionUpdate?.newHandle) {
      this.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
      return;
    }

    if (msg.goAway) {
      console.log("[GeminiLiveTTS] goAway — scheduling reconnect");
      // Don't abort the in-flight request; let it finish if it can.
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnect().catch(err => console.error("[GeminiLiveTTS] goAway reconnect failed:", err));
      }, 0);
      return;
    }

    const content = msg.serverContent;
    if (!content) return;

    const active = this.activeRequest;
    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        const inline = (part as any).inlineData;
        if (inline?.data && typeof inline.mimeType === "string" && inline.mimeType.startsWith("audio/")) {
          if (active) {
            const pcm = Buffer.from(inline.data, "base64");
            active.onChunk(pcmToWav(pcm));
          }
        }
      }
    }

    if (content.turnComplete) {
      if (active) {
        active.resolve();
        this.activeRequest = null;
        this.pumpQueue();
      }
    }
  }

  private failActive(err: Error): void {
    if (this.activeRequest) {
      this.activeRequest.reject(err);
      this.activeRequest = null;
    }
    // Drain queue too — callers shouldn't hang
    for (const pending of this.queue) pending.reject(err);
    this.queue = [];
  }

  private pumpQueue(): void {
    if (this.activeRequest) return;
    const next = this.queue.shift();
    if (!next) return;
    this.activeRequest = next;
    try {
      this.session!.sendClientContent({
        turns: [{ role: "user", parts: [{ text: next.text }] }],
        turnComplete: true,
      });
    } catch (err) {
      this.failActive(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Synthesize `text` to audio via the persistent Live session.
   * Yields WAV chunks as they arrive from the model.
   */
  async *synthesizeStream(text: string): AsyncGenerator<Buffer> {
    if (this.closedIntentionally) throw new Error("TTS session is closed");
    await this.readyPromise;
    if (!this.session) throw new Error("TTS session not connected");

    const chunks: Buffer[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;

    const pending: PendingRequest = {
      text,
      onChunk: (wav) => {
        chunks.push(wav);
        if (notify) { const n = notify; notify = null; n(); }
      },
      resolve: () => {
        done = true;
        if (notify) { const n = notify; notify = null; n(); }
      },
      reject: (err) => {
        error = err;
        done = true;
        if (notify) { const n = notify; notify = null; n(); }
      },
    };

    if (this.activeRequest) {
      this.queue.push(pending);
    } else {
      this.activeRequest = pending;
      try {
        this.session.sendClientContent({
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        });
      } catch (err) {
        this.activeRequest = null;
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    while (true) {
      while (chunks.length > 0) {
        yield chunks.shift()!;
      }
      if (done) break;
      await new Promise<void>(resolve => { notify = resolve; });
    }
    if (error) throw error;
  }

  close(): void {
    this.closedIntentionally = true;
    this.clearReconnectTimer();
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    this.failActive(new Error("TTS session closed"));
    console.log("[GeminiLiveTTS] Session closed");
  }
}

/** Convert raw PCM (24kHz 16-bit LE mono) to WAV */
function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
