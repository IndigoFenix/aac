// server/scripts/test-gemini-live-minimal.ts
//
// Minimal Gemini Live test — strips away EVERYTHING from our normal setup
// to isolate whether duplication/repetition is inherent to Gemini or caused
// by our middleware (buffering, state machine, tool declarations, etc.).
//
// What this does:
//   1. Connects to Gemini Live with the same model + Vertex auth as production
//   2. NO tools, NO system prompt, NO video frames, NO state machine
//   3. Sends a single text message ("Hi, how are you?")
//   4. Logs every event from Gemini (text, audio chunks, turn completes)
//   5. Counts audio chunks and TURN_COMPLETEs to detect duplication
//   6. Exits after 30 seconds or when the model is done responding
//
// Run with:
//   npx tsx server/scripts/test-gemini-live-minimal.ts
//
// Look for:
//   - How many TURN_COMPLETE events does the model produce per text message?
//   - Are there spontaneous extra turns?
//   - Does the model produce overlapping/duplicated audio?

import { GoogleGenAI, Modality, type Session, type LiveServerMessage } from "@google/genai";

const MODEL = process.env.TEST_MODEL || "gemini-live-2.5-flash-native-audio";
const TEST_PROMPT = process.argv[2] || "Hi, please greet me briefly in one short sentence.";
const TIMEOUT_MS = 30_000;

function ts(): string {
  const d = new Date();
  return `${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}

function log(label: string, ...args: any[]): void {
  console.log(`[${ts()}] ${label}`, ...args);
}

async function main() {
  const useVertex = !!(process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT);
  let client: GoogleGenAI;
  if (useVertex) {
    const project = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
    const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
    log("INIT", `Vertex AI project=${project} location=${location}`);
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const googleAuthOptions = credentialsJson ? { credentials: JSON.parse(credentialsJson) } : undefined;
    client = new GoogleGenAI({ vertexai: true, project, location, ...(googleAuthOptions ? { googleAuthOptions } : {}) });
  } else {
    log("INIT", "Gemini API (apiKey)");
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  }

  log("CONFIG", `model=${MODEL} prompt="${TEST_PROMPT}"`);

  // Counters
  let audioChunks = 0;
  let audioBytes = 0;
  let turnCompleteCount = 0;
  let textChunks = 0;
  let toolCallCount = 0;
  let abnormalTurns = 0;
  let transcriptionText = "";
  const turnTimings: number[] = [];
  let lastTurnEndAt = 0;

  let resolveDone: () => void;
  const done = new Promise<void>((res) => { resolveDone = res; });
  let session: Session | null = null;
  let timer: NodeJS.Timeout | null = null;

  const finish = (reason: string) => {
    log("FINISH", reason);
    log("SUMMARY", JSON.stringify({
      audioChunks,
      audioBytes,
      audioSeconds: (audioBytes / 2 / 24000).toFixed(2), // assume 24kHz mono int16
      turnCompleteCount,
      textChunks,
      toolCallCount,
      abnormalTurns,
      transcription: transcriptionText.trim(),
      turnGapsMs: turnTimings,
    }, null, 2));
    if (timer) clearTimeout(timer);
    if (session) session.close();
    resolveDone();
  };

  try {
    session = await client.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        // Bare minimum — NO tools, NO system prompt, NO transcription, NO compression
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => log("WS_OPEN"),
        onmessage: (msg: LiveServerMessage) => {
          const keys = Object.keys(msg).filter(k => (msg as any)[k] != null);

          if (msg.setupComplete) {
            log("SETUP_COMPLETE");
            // Send a simple text message after setup
            setTimeout(() => {
              log("SEND text", TEST_PROMPT);
              session!.sendClientContent({
                turns: [{ role: "user", parts: [{ text: TEST_PROMPT }] }],
                turnComplete: true,
              });
            }, 100);
            return;
          }

          if (msg.toolCall) {
            toolCallCount++;
            log("TOOL_CALL", JSON.stringify(msg.toolCall));
            return;
          }

          if (msg.serverContent) {
            const sc = msg.serverContent as any;
            if (sc.modelTurn?.parts) {
              for (const part of sc.modelTurn.parts) {
                if (part.text) {
                  textChunks++;
                  log("TEXT", `"${part.text}"`);
                }
                if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
                  audioChunks++;
                  // Base64 length → bytes ≈ length * 0.75
                  const byteLen = Math.floor(part.inlineData.data.length * 0.75);
                  audioBytes += byteLen;
                  log("AUDIO_CHUNK", `#${audioChunks} ${byteLen} bytes (~${(byteLen / 2 / 24000 * 1000).toFixed(0)}ms)`);
                }
              }
            }
            if (sc.outputTranscription?.text) {
              transcriptionText += sc.outputTranscription.text;
              log("OUT_TRANSCRIPT", `"${sc.outputTranscription.text}"`);
            }
            if (sc.generationComplete) {
              log("GENERATION_COMPLETE");
            }
            if (sc.interrupted) {
              log("INTERRUPTED");
            }
            if (sc.turnComplete) {
              turnCompleteCount++;
              const reason = sc.turnCompleteReason || "normal";
              const now = Date.now();
              const gap = lastTurnEndAt > 0 ? now - lastTurnEndAt : 0;
              if (gap > 0) turnTimings.push(gap);
              lastTurnEndAt = now;
              if (reason !== "normal" && reason !== "STOP") {
                abnormalTurns++;
                log("TURN_COMPLETE", `#${turnCompleteCount} reason=${reason} gap=${gap}ms ABNORMAL`);
                log("RAW_FULL", JSON.stringify(msg, null, 2).substring(0, 1500));
              } else {
                log("TURN_COMPLETE", `#${turnCompleteCount} gap=${gap}ms`);
              }

              // Wait briefly for any spontaneous follow-up turns. If nothing more
              // arrives within 3s of the last turn complete, finish.
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => finish("3s of silence after last TURN_COMPLETE"), 3000);
            }
          }

          if (msg.usageMetadata) {
            const u = msg.usageMetadata as any;
            log("USAGE", `prompt=${u.promptTokenCount} response=${u.responseTokenCount || 0}`);
          }
        },
        onerror: (e: any) => {
          log("ERROR", e.message || e);
          finish(`error: ${e.message || e}`);
        },
        onclose: (e: any) => {
          log("WS_CLOSE", e.reason || "(no reason)");
        },
      },
    });

    // Hard timeout
    setTimeout(() => finish(`hard timeout (${TIMEOUT_MS}ms)`), TIMEOUT_MS);

    await done;
  } catch (err: any) {
    log("FATAL", err.message || err);
    process.exit(1);
  }
  process.exit(0);
}

main();
