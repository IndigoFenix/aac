// server/scripts/test-live-toolcall-blocking.ts
//
// DOES GEMINI LIVE BLOCK GENERATION WHILE A functionResponse IS OUTSTANDING?
//
// This decides the shape of the app-open fix. Today `open_app` is answered
// `{output:"ok"}` ~1ms after the toolCall arrives (speaker-agent.ts:510),
// before the server has decided whether the app can actually open — so the
// Speaker promises "I'm opening it for you", and the refusal lands 2.7s later
// as a silent context injection nobody hears.
//
// If the API BLOCKS on a pending functionResponse, we can hold the ack until
// routeAppOpen resolves and hand the model the real verdict, so it never makes
// the promise. If it does NOT block, holding is pointless and the fix has to
// be a follow-up turn that lets the model correct itself out loud.
//
// The production logs cannot answer this: our median ack latency is 1ms across
// 354 tool calls, so a delayed ack has never been observed on the Speaker's
// native-audio config.
//
// Run with:
//   npx tsx server/scripts/test-live-toolcall-blocking.ts [delayMs] [ok|refused] [as-content|tool-response]
//
// READ THE VERDICT LINE. "BLOCKS" means no model output arrived during the
// delay window; "DOES NOT BLOCK" means the model kept generating while the
// function call was outstanding.
//
// ---------------------------------------------------------------------------
// RESULTS, 2026-08-24, gemini-live-2.5-flash-native-audio on Vertex (aac-aivota).
// A clean 2x2 over {ok, refused} x {tool-response, as-content}, 3000ms hold:
//
//   wire=tool-response  ok       -> silent for the whole hold, then SPOKE
//                                   "Opening YouTube for you!"
//   wire=tool-response  refused  -> silent for the whole hold, then SPOKE
//                                   "I can't open YouTube right now. Is there
//                                    another app you'd like to use?"
//   wire=as-content     ok       -> silent for the hold AND silent after. Never
//                                   spoke at all; session timed out at 46s.
//   wire=as-content     refused  -> same. Never spoke.
//
// TWO conclusions, and the second one is the surprise:
//
// 1. Gemini Live DOES block generation while a functionResponse is outstanding.
//    Holding the ack until routeAppOpen resolves therefore stops the Speaker
//    promising an app before the server has decided — and the refusal genuinely
//    changes what it says, rather than being ignored.
//
// 2. It only resumes for the DEDICATED sendToolResponse. Our production path
//    (sendToolResponseAsContent -> sendClientContent, turnComplete:false) leaves
//    the model waiting forever once it has closed its turn, which it does ~13ms
//    after the tool call whenever the ack is slow. So a hold added on top of the
//    CURRENT wire shape would trade a false promise for total silence.
//    Holding requires switching open_app to sendToolResponse.
//
// Why production has not hit (2) already: the ack goes out in ~1ms (median over
// 354 logged tool calls), which pre-empts the model's TURN_COMPLETE, so the turn
// never closes and generation continues. Zero dead turns across 20 Speaker tool
// calls in live-session-debug.log. The bug is latent, not active.
// ---------------------------------------------------------------------------

import { GoogleGenAI, Modality, type Session, type LiveServerMessage } from "@google/genai";

const MODEL = process.env.TEST_MODEL || "gemini-live-2.5-flash-native-audio";
const DELAY_MS = Number(process.argv[2] ?? 3000);
// "ok" mirrors today's SPEAKER_TOOL_ACK. "refused" is the verdict we would hand
// back once the ack is held until routeAppOpen resolves — the point of the
// second arm is whether the model actually CHANGES what it says, or promises
// the app anyway.
const RESPONSE_MODE = (process.argv[3] ?? "ok") as "ok" | "refused";
// How the response goes on the wire. "as-content" is what PRODUCTION actually
// does (gemini-live-provider.ts:770 — functionResponse parts wrapped in
// sendClientContent with role:"user", turnComplete:false); "tool-response" is
// the SDK's dedicated sendToolResponse. Different wire shapes, so the blocking
// behaviour has to be confirmed for the one we really ship.
const WIRE = (process.argv[4] ?? "as-content") as "as-content" | "tool-response";
const TIMEOUT_MS = 45_000;

const TOOL_RESPONSE =
  RESPONSE_MODE === "refused"
    ? {
        output: "refused",
        reason:
          "This app has nothing to show right now — the child is not at a place where it works. " +
          "Do not open it. Answer what they actually asked about instead, and do not mention the app.",
      }
    : { output: "ok" };

// Mirrors the Speaker's actual situation: a tool that opens something on the
// user's screen, and an instruction to talk while doing it.
const SYSTEM_PROMPT = [
  "You are a warm AAC companion for a child.",
  "When the child asks for an app, call open_app immediately AND say a short",
  "sentence out loud telling them you are opening it. Always do both.",
].join(" ");

const USER_TURN = "I want to watch YouTube please";

const OPEN_APP_TOOL = {
  functionDeclarations: [
    {
      name: "open_app",
      description: "Open an app on the child's screen. Call this when they ask for an app.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          app_id: { type: "string", description: "The app to open, e.g. 'youtube'" },
        },
        required: ["app_id"],
      },
    },
  ],
};

const t0 = Date.now();
const ms = () => Date.now() - t0;
function log(label: string, ...args: any[]): void {
  console.log(`[+${String(ms()).padStart(6)}ms] ${label}`, ...args);
}

async function main() {
  await import("dotenv").then((d) => d.config());

  const project = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  let client: GoogleGenAI;
  if (project) {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const googleAuthOptions = credentialsJson ? { credentials: JSON.parse(credentialsJson) } : undefined;
    log("INIT", `Vertex project=${project} location=${location}`);
    client = new GoogleGenAI({ vertexai: true, project, location, ...(googleAuthOptions ? { googleAuthOptions } : {}) });
  } else {
    log("INIT", "AI Studio key (no GCP project configured)");
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
  }

  log("CONFIG", `model=${MODEL} ackDelay=${DELAY_MS}ms response=${RESPONSE_MODE} wire=${WIRE}`);

  // The three timestamps the verdict is computed from.
  let toolCallAt = 0;
  let responseSentAt = 0;
  let firstContentAfterToolCallAt = 0;
  // Model output observed strictly inside the delay window.
  let contentDuringDelay = 0;
  let audioDuringDelay = 0;
  let transcriptDuringDelay = "";
  let transcriptAll = "";
  let sawToolCall = false;
  let turnCompletes = 0;

  let resolveDone: () => void;
  const done = new Promise<void>((res) => { resolveDone = res; });
  let session: Session | null = null;
  let timer: NodeJS.Timeout | null = null;
  let finished = false;

  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    log("FINISH", reason);

    console.log("\n" + "=".repeat(72));
    if (!sawToolCall) {
      console.log("INCONCLUSIVE — the model never called the tool.");
      console.log("Re-run; if it keeps happening the prompt needs to be more forcing.");
    } else {
      const ackDelta = responseSentAt ? responseSentAt - toolCallAt : -1;
      const contentDelta = firstContentAfterToolCallAt ? firstContentAfterToolCallAt - toolCallAt : -1;
      console.log(`toolCall received at      +${toolCallAt}ms`);
      console.log(`functionResponse sent at  +${responseSentAt}ms   (held ${ackDelta}ms)`);
      console.log(
        contentDelta >= 0
          ? `first model output at     +${firstContentAfterToolCallAt}ms   (${contentDelta}ms after toolCall)`
          : `first model output        NONE`,
      );
      console.log("");
      console.log(`output chunks during the hold: ${contentDuringDelay} (${audioDuringDelay} audio)`);
      if (transcriptDuringDelay.trim()) {
        console.log(`SPOKEN during the hold:  "${transcriptDuringDelay.trim()}"`);
      }
      console.log("");
      if (DELAY_MS <= 0) {
        console.log("VERDICT: control arm — no hold applied, nothing to conclude.");
      } else if (contentDuringDelay > 0) {
        console.log("VERDICT: DOES NOT BLOCK.");
        console.log("  The model generated output while the function call was outstanding.");
        console.log("  Holding open_app's ack will NOT stop the Speaker promising the app.");
        console.log("  The fix must be a follow-up turn so it can correct itself out loud.");
      } else {
        console.log("VERDICT: BLOCKS.");
        console.log("  No model output arrived during the hold — generation waited for the");
        console.log("  functionResponse. Holding the ack until routeAppOpen resolves will");
        console.log("  let the model see the real verdict before it speaks.");
      }
      console.log(`full transcript: "${transcriptAll.trim()}"`);
    }
    console.log("=".repeat(72) + "\n");

    if (timer) clearTimeout(timer);
    if (session) session.close();
    resolveDone();
  };

  try {
    session = await client.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        tools: [OPEN_APP_TOOL as any],
      },
      callbacks: {
        onopen: () => log("WS_OPEN"),
        onmessage: (msg: LiveServerMessage) => {
          if (msg.setupComplete) {
            log("SETUP_COMPLETE");
            setTimeout(() => {
              log("SEND user turn", `"${USER_TURN}"`);
              session!.sendClientContent({
                turns: [{ role: "user", parts: [{ text: USER_TURN }] }],
                turnComplete: true,
              });
            }, 100);
            return;
          }

          if (msg.toolCall) {
            sawToolCall = true;
            toolCallAt = ms();
            const calls = msg.toolCall.functionCalls ?? [];
            log("TOOL_CALL", JSON.stringify(calls.map((c) => ({ name: c.name, args: c.args }))));
            log("HOLDING", `not answering for ${DELAY_MS}ms — watching for model output...`);
            setTimeout(() => {
              responseSentAt = ms();
              log("SEND functionResponse", JSON.stringify(TOOL_RESPONSE) + " (after the hold)");
              if (WIRE === "tool-response") {
                session!.sendToolResponse({
                  functionResponses: calls.map((c) => ({
                    id: c.id,
                    name: c.name ?? "open_app",
                    response: TOOL_RESPONSE,
                  })),
                });
              } else {
                // Byte-for-byte what gemini-live-provider.sendToolResponseAsContent does.
                session!.sendClientContent({
                  turns: [
                    {
                      role: "user",
                      parts: calls.map((c) => ({
                        functionResponse: {
                          id: c.id,
                          name: c.name ?? "open_app",
                          response: TOOL_RESPONSE,
                        },
                      })),
                    },
                  ],
                  turnComplete: false,
                });
              }
            }, DELAY_MS);
            return;
          }

          if (msg.serverContent) {
            const sc = msg.serverContent as any;
            // Is this arriving while we are deliberately withholding the ack?
            const inHold = sawToolCall && responseSentAt === 0;
            let sawOutput = false;
            let audioHere = 0;

            if (sc.modelTurn?.parts) {
              for (const part of sc.modelTurn.parts) {
                if (part.text) {
                  sawOutput = true;
                  log(inHold ? "TEXT (DURING HOLD)" : "TEXT", `"${part.text}"`);
                }
                if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
                  sawOutput = true;
                  audioHere++;
                  if (inHold) log("AUDIO (DURING HOLD)", `chunk ${part.inlineData.data.length} b64 chars`);
                }
              }
            }
            if (sc.outputTranscription?.text) {
              sawOutput = true;
              transcriptAll += sc.outputTranscription.text;
              if (inHold) transcriptDuringDelay += sc.outputTranscription.text;
              log(inHold ? "TRANSCRIPT (DURING HOLD)" : "TRANSCRIPT", `"${sc.outputTranscription.text}"`);
            }

            if (sawOutput) {
              if (sawToolCall && firstContentAfterToolCallAt === 0) firstContentAfterToolCallAt = ms();
              if (inHold) {
                contentDuringDelay++;
                audioDuringDelay += audioHere;
              }
            }
            if (sc.generationComplete) log("GENERATION_COMPLETE" + (inHold ? " (DURING HOLD)" : ""));
            if (sc.interrupted) log("INTERRUPTED");
            if (sc.turnComplete) {
              turnCompletes++;
              log("TURN_COMPLETE" + (inHold ? " (DURING HOLD)" : ""), `#${turnCompletes}`);
              // Give the post-ack turn a chance to arrive before finishing.
              if (responseSentAt > 0) setTimeout(() => finish("turn complete after ack"), 4000);
            }
          }
        },
        onerror: (e: any) => { log("WS_ERROR", e?.message || String(e)); finish("error"); },
        onclose: (e: any) => { log("WS_CLOSE", `code=${e?.code} reason=${e?.reason || ""}`); finish("closed"); },
      },
    });

    timer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
    await done;
  } catch (err) {
    log("FATAL", (err as Error).message);
    process.exitCode = 1;
  }
}

main().then(() => process.exit(process.exitCode ?? 0));
