// server/services/dual-agent/minimal-live-relay.ts
//
// Bare-bones WebSocket relay between the AAC client and Gemini Live.
// Strips away EVERYTHING from the production LiveRelay so we can isolate
// whether duplication / repetition is caused by our middleware or by Gemini
// itself.
//
// What this DOES:
//   - Accepts WebSocket connections from the AAC client
//   - On `initialize`: connects to Gemini Live with the same model + Vertex auth
//     (NO tools, NO system prompt, NO video, NO frames, NO state machine,
//      NO silence keepalive, NO message queue, NO MALFORMED handling, etc.)
//   - Forwards `pcm_audio` from client → Gemini via sendRealtimeInput
//   - Forwards Gemini audio chunks → client as `avatar_audio` (WAV, batched 250ms)
//   - Forwards Gemini outputTranscription → client as `text`
//   - On TURN_COMPLETE: sends `complete` to client
//
// What this does NOT do (intentionally):
//   - No tool declarations (Gemini sees zero tools)
//   - No system prompt (model uses defaults)
//   - No greeting prompt (the client must initiate via audio or button)
//   - No board/state messages
//   - No frame_grid handling (no video)
//   - No state machine (idle/awaiting_turn/in_turn — none of it)
//   - No queueing of dropped messages (everything flows immediately)
//   - No partial-audio discarding on abnormal turns
//   - No echo protection
//
// The goal: a near-direct passthrough that lets us see Gemini's raw behavior
// through our existing AAC client. If duplication still happens here, the
// problem is in Gemini or in the client. If it doesn't, the problem is
// in the production LiveRelay's added behavior.
//
// Mounted on the same /ws/live path when the URL has `?test=1`.

import { WebSocket } from "ws";
import { GoogleGenAI, Modality, FunctionResponse, FunctionResponseScheduling, type Session, type LiveServerMessage, type FunctionCall } from "@google/genai";
import { logLiveSession } from "./dual-agent-logger";
import { parseBoardButtons } from "./interactive-agent";
import { T } from "../memory-schema/canonical-terms";

// Convert raw 24kHz mono int16 PCM to a WAV blob (same format as production LiveRelay)
function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

const FLUSH_INTERVAL_MS = 250;
const MODEL = process.env.MINIMAL_RELAY_MODEL || "gemini-live-2.5-flash-native-audio";

// Minimal system prompt — just enough to teach the model about rebuild_board.
const SYSTEM_PROMPT = `You are a friendly conversational AI helping a user communicate via an AAC (Augmentative and Alternative Communication) ${T.board}.

You have ONE tool available: rebuild_board.

Whenever the conversation suggests new things the user might want to say, call rebuild_board() with up to 8 ${T.button}s that fit the current discussion. Each ${T.button} is a short SENTENCE the user can press to communicate.

Talk naturally to the user while updating the ${T.board} to match the conversation.`;

// Tool description for the minimal relay's simpler button format.
const REBUILD_BOARD_BUTTONS_DESCRIPTION =
  `Comma-separated ${T.button}s in the format: label|icon|imageKey|speech. ` +
  `The label is a short word or phrase shown on the ${T.button}. ` +
  `The icon is a single emoji ${T.symbol} representing the concept. ` +
  `The imageKey is optional — leave it empty (||) when the emoji is clear enough. ` +
  `The speech is the full SENTENCE the TTS voices when the user presses the ${T.button} — write from the user's perspective. ` +
  `Example: "Play|🎮||I want to play, Music|🎵||Put on some music, Draw|✏️||I want to draw, Tired|😴||I am tired"`;

// Build a board data structure that matches what the AAC client expects.
function buildBoardFromButtons(buttons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string }>): any {
  const cols = 4;
  const rows = Math.max(2, Math.ceil(buttons.length / cols));
  const pageId = `page-${Date.now()}`;
  return {
    grid: { rows, cols },
    pages: [{
      id: pageId,
      name: "Main",
      buttons: buttons.map((b, i) => ({
        id: `btn-${Date.now()}-${i}`,
        label: b.label,
        spokenText: b.label,
        ...(b.sentence ? { sentence: b.sentence } : {}),
        row: Math.floor(i / cols),
        col: i % cols,
        action: { type: "speak" as const, text: b.label },
        style: {},
        iconRef: b.iconRef,
      })),
    }],
    currentPageId: pageId,
  };
}

export class MinimalLiveRelay {
  private ws: WebSocket;
  private client: GoogleGenAI;
  private session: Session | null = null;
  private connected = false;
  private audioChunks: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId = `minimal-${Date.now()}`;

  constructor(ws: WebSocket) {
    this.ws = ws;
    logLiveSession("MINIMAL RELAY", `new connection sessionId=${this.sessionId} wsReadyState=${ws.readyState}`);

    try {
      this.client = this.buildClient();
      logLiveSession("MINIMAL RELAY", `client built sessionId=${this.sessionId}`);
    } catch (err: any) {
      logLiveSession("MINIMAL RELAY ERROR", `buildClient threw: ${err.message || err}`);
      console.error("[MinimalLiveRelay] buildClient error:", err);
      throw err;
    }

    ws.on("message", (raw) => {
      logLiveSession("MINIMAL: WS RAW MESSAGE", `bytes=${raw.toString().length}`);
      try {
        const msg = JSON.parse(raw.toString());
        logLiveSession("MINIMAL: WS PARSED", `type=${msg.type}`);
        this.handleClientMessage(msg).catch(err => {
          logLiveSession("MINIMAL: handleClientMessage threw", err.message || String(err));
          console.error("[MinimalLiveRelay] handleClientMessage error:", err);
        });
      } catch (err: any) {
        logLiveSession("MINIMAL: parse error", err.message || String(err));
        console.error("[MinimalLiveRelay] Invalid client message:", err);
      }
    });

    ws.on("close", (code, reason) => {
      logLiveSession("MINIMAL RELAY CLOSE", `sessionId=${this.sessionId} code=${code} reason="${reason?.toString() || ""}"`);
      this.cleanup();
    });

    ws.on("error", (err) => {
      logLiveSession("MINIMAL RELAY WS ERROR", err.message || String(err));
      console.error("[MinimalLiveRelay] WebSocket error:", err);
      this.cleanup();
    });

    ws.on("ping", () => logLiveSession("MINIMAL: WS ping", ""));
    ws.on("pong", () => logLiveSession("MINIMAL: WS pong", ""));

    logLiveSession("MINIMAL RELAY", `constructor done sessionId=${this.sessionId} wsReadyState=${ws.readyState}`);
  }

  private buildClient(): GoogleGenAI {
    const useVertex = !!(process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT);
    if (useVertex) {
      const project = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
      const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
      const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
      const googleAuthOptions = credentialsJson ? { credentials: JSON.parse(credentialsJson) } : undefined;
      return new GoogleGenAI({ vertexai: true, project, location, ...(googleAuthOptions ? { googleAuthOptions } : {}) });
    }
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  }

  private send(msg: any): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      // Log a brief summary of every send (skip large data fields)
      const summary: any = { type: msg.type };
      if (msg.data && typeof msg.data === "string" && msg.data.length > 100) {
        summary.dataLen = msg.data.length;
      } else if (msg.data !== undefined) {
        summary.data = msg.data;
      }
      if (msg.sessionId) summary.sessionId = msg.sessionId;
      logLiveSession("MINIMAL: SERVER → CLIENT", JSON.stringify(summary));
      this.ws.send(JSON.stringify(msg));
    } else {
      logLiveSession("MINIMAL: SEND DROPPED", `wsReadyState=${this.ws.readyState} type=${msg.type}`);
    }
  }

  private async handleClientMessage(msg: any): Promise<void> {
    logLiveSession("MINIMAL: CLIENT → SERVER", `type=${msg.type}`);

    switch (msg.type) {
      case "initialize":
        logLiveSession("MINIMAL: handle initialize", "starting connectToGemini");
        await this.connectToGemini();
        logLiveSession("MINIMAL: handle initialize", "connectToGemini returned");
        break;

      case "pcm_audio":
        if (this.session && this.connected) {
          this.session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
          });
        } else {
          logLiveSession("MINIMAL: pcm_audio dropped", `connected=${this.connected} hasSession=${!!this.session}`);
        }
        break;

      case "user_message":
      case "button_press":
      case "board_exit":
      case "frame_grid":
      case "voice_audio":
      case "audio_clip":
      case "focus_frame":
      case "context_injection":
      case "board_state":
      case "set_paused":
      case "set_mute_state":
      case "set_response_mode":
      case "more_options":
      case "app_dismissed":
      case "page_changed":
      case "local_state":
      case "gesture_context":
      case "person_context":
        // Ignore — minimal relay doesn't process these
        logLiveSession("MINIMAL: IGNORED", `type=${msg.type}`);
        break;

      default:
        logLiveSession("MINIMAL: UNKNOWN", `type=${msg.type}`);
    }
  }

  private async connectToGemini(): Promise<void> {
    if (this.session) {
      logLiveSession("MINIMAL", "already connected — skipping");
      return;
    }

    logLiveSession("MINIMAL", `connecting to Gemini Live model=${MODEL} useVertex=${!!(process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT)}`);

    try {
      this.session = await this.client.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          // Enable transcriptions so we can show what was said
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          tools: [{
            functionDeclarations: [{
              name: "rebuild_board",
              description: `Replace the ${T.board} with up to 8 new ${T.button}s related to the current conversation. Call this whenever the topic shifts or new options become relevant.`,
              parametersJsonSchema: {
                type: "object",
                properties: {
                  buttons: { type: "string", description: REBUILD_BOARD_BUTTONS_DESCRIPTION },
                },
                required: ["buttons"],
              },
            }],
          }],
        },
        callbacks: {
          onopen: () => {
            logLiveSession("MINIMAL", "Gemini WS opened");
          },
          onmessage: (m: LiveServerMessage) => this.handleGeminiMessage(m),
          onerror: (e: any) => {
            logLiveSession("MINIMAL", `Gemini error: ${e.message || e}`);
          },
          onclose: (e: any) => {
            logLiveSession("MINIMAL", `Gemini closed: ${e.reason || ""}`);
          },
        },
      });
    } catch (err) {
      console.error("[MinimalLiveRelay] Connect failed:", err);
      this.send({ type: "error", data: "INIT_FAILED" });
    }
  }

  private handleGeminiMessage(msg: LiveServerMessage): void {
    if (msg.setupComplete) {
      logLiveSession("MINIMAL: GEMINI → setupComplete", "");
      this.connected = true;
      this.send({ type: "initialized", sessionId: this.sessionId });
      return;
    }

    if (msg.toolCall?.functionCalls) {
      this.handleToolCalls(msg.toolCall.functionCalls);
      return;
    }

    if (msg.serverContent) {
      const sc = msg.serverContent as any;

      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.text) {
            logLiveSession("MINIMAL: GEMINI → text", `"${part.text}"`);
            this.send({ type: "text", data: part.text, noAudioClear: true });
          }
          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
            logLiveSession("MINIMAL: GEMINI → audioChunk", `len=${part.inlineData.data.length}`);
            this.audioChunks.push(part.inlineData.data);
            if (!this.flushTimer) {
              this.flushTimer = setTimeout(() => this.flushAudio(), FLUSH_INTERVAL_MS);
            }
          }
        }
      }

      if (sc.outputTranscription?.text) {
        logLiveSession("MINIMAL: GEMINI → outTranscript", `"${sc.outputTranscription.text}"`);
        this.send({ type: "text", data: sc.outputTranscription.text, noAudioClear: true });
      }

      if (sc.inputTranscription?.text) {
        logLiveSession("MINIMAL: GEMINI ← inTranscript", `"${sc.inputTranscription.text}"`);
      }

      if (sc.generationComplete) {
        logLiveSession("MINIMAL: GEMINI → generationComplete", "");
      }

      if (sc.interrupted) {
        logLiveSession("MINIMAL: GEMINI → interrupted", "");
        // Cancel pending flush, drop buffered audio, tell client to stop
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        this.audioChunks = [];
        this.send({ type: "audio_interrupt" });
      }

      if (sc.turnComplete) {
        const reason = sc.turnCompleteReason || "normal";
        logLiveSession("MINIMAL: GEMINI → TURN_COMPLETE", `reason=${reason}`);
        // Flush any remaining audio and tell client the turn is done
        this.flushAudio();
        this.send({ type: "complete", data: { reason } });
      }
    }

    if (msg.usageMetadata) {
      const u = msg.usageMetadata as any;
      logLiveSession("MINIMAL: GEMINI → usage", `prompt=${u.promptTokenCount} response=${u.responseTokenCount || 0}`);
    }
  }

  private handleToolCalls(calls: FunctionCall[]): void {
    if (!this.session || !this.connected) return;

    // EXPERIMENT MODE — controlled by env var so we can quickly toggle
    // without rebuilding code. Values:
    //   "skip"      → don't send any tool response at all
    //   "silent"    → send response with SILENT scheduling
    //   "when_idle" → send response with WHEN_IDLE scheduling (default for NON_BLOCKING)
    //   "interrupt" → send response with INTERRUPT scheduling
    //   "default"   → send response with no scheduling field (SDK default)
    const mode = (process.env.MINIMAL_TOOL_RESPONSE_MODE || "silent").toLowerCase();
    logLiveSession("MINIMAL: tool response mode", mode);

    const responses: FunctionResponse[] = [];

    for (const call of calls) {
      const name = call.name || "unknown";
      const args = (call.args || {}) as Record<string, any>;
      logLiveSession(`MINIMAL: TOOL CALL ${name}`, JSON.stringify(args));

      if (name === "rebuild_board") {
        const buttonsArg = typeof args.buttons === "string" ? args.buttons : "";
        const buttons = parseBoardButtons(buttonsArg).slice(0, 8);
        if (buttons.length === 0) {
          responses.push(this.makeResponse(call.id, name, { error: "No valid buttons parsed from arguments" }, mode));
          continue;
        }

        const board = buildBoardFromButtons(buttons);
        logLiveSession("MINIMAL: SERVER → CLIENT board", `${buttons.length} buttons: ${buttons.map(b => b.label).join(", ")}`);
        this.send({ type: "board", data: board });

        responses.push(this.makeResponse(call.id, name, {
          output: "ok",
          board_state: `Main board rebuilt. ${buttons.length}/8 buttons: ${buttons.map(b => b.label).join(", ")}`,
        }, mode));
      } else {
        responses.push(this.makeResponse(call.id, name, { error: `Unknown function: ${name}` }, mode));
      }
    }

    if (mode === "skip") {
      logLiveSession("MINIMAL: tool response SKIPPED", `mode=${mode} (model will not get a response)`);
      return;
    }

    if (responses.length > 0) {
      logLiveSession("MINIMAL: CLIENT → sendToolResponse", `count=${responses.length} mode=${mode}`);
      this.session.sendToolResponse({ functionResponses: responses });
    }
  }

  private makeResponse(id: string | undefined, name: string, response: any, mode: string): FunctionResponse {
    const fr = Object.assign(new FunctionResponse(), { id, name, response });
    if (mode === "silent") (fr as any).scheduling = FunctionResponseScheduling.SILENT;
    else if (mode === "when_idle") (fr as any).scheduling = FunctionResponseScheduling.WHEN_IDLE;
    else if (mode === "interrupt") (fr as any).scheduling = FunctionResponseScheduling.INTERRUPT;
    // mode === "default" → no scheduling field
    return fr;
  }

  private flushAudio(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.audioChunks.length === 0) return;
    try {
      const chunks = this.audioChunks.splice(0);
      const pcmBuf = Buffer.concat(chunks.map(c => Buffer.from(c, "base64")));
      if (pcmBuf.length === 0) return;
      const wavBuf = pcmToWav(pcmBuf);
      logLiveSession("MINIMAL: flush", `chunks=${chunks.length} pcmBytes=${pcmBuf.length}`);
      this.send({ type: "avatar_audio", data: wavBuf.toString("base64"), format: "wav" });
    } catch (err) {
      console.error("[MinimalLiveRelay] Flush error:", err);
    }
  }

  private cleanup(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.audioChunks = [];
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
    this.connected = false;
  }
}
