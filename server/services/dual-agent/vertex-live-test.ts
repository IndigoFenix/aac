/**
 * Minimal test script for Vertex AI Gemini Live API with function calling.
 * Run with: npx tsx server/services/dual-agent/vertex-live-test.ts
 *
 * Tests two modes:
 * 1. No tools (pure audio) — does the model generate audio/text?
 * 2. With tools — does the model call functions?
 */

import * as dotenv from "dotenv";
dotenv.config();

import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";

const project = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

// Parse inline credentials
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
const googleAuthOptions = credentialsJson
  ? { credentials: JSON.parse(credentialsJson) }
  : undefined;

const client = new GoogleGenAI({
  vertexai: true,
  project,
  location,
  ...(googleAuthOptions ? { googleAuthOptions } : {}),
});

const MODEL = "gemini-live-2.5-flash-native-audio";

async function testWithoutTools() {
  console.log("\n=== TEST 1: No tools (pure audio response) ===");

  const session = await client.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: "You are a helpful assistant. Say hello." }] },
      temperature: 0.7,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks: {
      onopen: () => console.log("[NoTools] Connected"),
      onmessage: (msg: LiveServerMessage) => {
        const keys = Object.keys(msg).filter(k => (msg as any)[k] != null);
        console.log(`[NoTools] Message keys: ${keys.join(", ")}`);

        if (msg.setupComplete) {
          console.log("[NoTools] Setup complete");
        }
        if (msg.serverContent) {
          const c = msg.serverContent;
          if (c.modelTurn?.parts) {
            const types = c.modelTurn.parts.map((p: any) => {
              if (p.text) return `text("${p.text.substring(0, 80)}")`;
              if (p.inlineData) return `audio(${p.inlineData.data?.length || 0} bytes)`;
              return `other(${Object.keys(p).join(",")})`;
            });
            console.log(`[NoTools] Model parts: ${types.join(", ")}`);
          }
          if ((c as any).outputTranscription) {
            console.log(`[NoTools] Output transcription: ${JSON.stringify((c as any).outputTranscription).substring(0, 200)}`);
          }
          if (c.turnComplete) {
            console.log("[NoTools] Turn complete");
          }
        }
      },
      onerror: (e: ErrorEvent) => console.error("[NoTools] Error:", e.message),
      onclose: (e: CloseEvent) => console.log(`[NoTools] Closed: code=${e.code} reason=${e.reason}`),
    },
  });

  // Wait for setup, then send a text message
  await new Promise(r => setTimeout(r, 2000));
  console.log("[NoTools] Sending message: 'Say hello to me'");
  session.sendClientContent({
    turns: [{ role: "user", parts: [{ text: "Say hello to me" }] }],
    turnComplete: true,
  });

  // Wait for response
  await new Promise(r => setTimeout(r, 8000));
  session.close();
  console.log("[NoTools] Session closed");
}

async function testWithTools() {
  console.log("\n=== TEST 2: With ALL tools (13+) matching our full app ===");

  // All tools from our app, with SHORT descriptions (no WHEN TO USE blocks)
  const tools = [{
    functionDeclarations: [
      {
        name: "speak",
        description: "Say something to the user (AI voice). TTS system voices this.",
        parameters: { type: "object" as const, properties: { text: { type: "string" as const, description: "Text to speak." } }, required: ["text"] },
      },
      {
        name: "interpret",
        description: "Speak on behalf of the user (student voice).",
        parameters: { type: "object" as const, properties: { text: { type: "string" as const, description: "Interpreted message." }, confidence: { type: "string" as const, enum: ["high", "medium", "low"] } }, required: ["text", "confidence"] },
      },
      {
        name: "transcript",
        description: "Record speech heard from a person nearby.",
        parameters: { type: "object" as const, properties: { text: { type: "string" as const, description: "Transcribed speech." }, speaker: { type: "string" as const, description: "Who spoke." } }, required: ["text", "speaker"] },
      },
      {
        name: "context",
        description: "Record environmental observations.",
        parameters: { type: "object" as const, properties: { text: { type: "string" as const, description: "What changed." } }, required: ["text"] },
      },
      {
        name: "add_buttons",
        description: "Add buttons to the AAC board.",
        parameters: { type: "object" as const, properties: { buttons: { type: "array" as const, items: { type: "object" as const, properties: { label: { type: "string" as const }, icon: { type: "string" as const } }, required: ["label", "icon"] } } }, required: ["buttons"] },
      },
      {
        name: "remove_buttons",
        description: "Remove buttons from the AAC board by label.",
        parameters: { type: "object" as const, properties: { labels: { type: "array" as const, items: { type: "string" as const } } }, required: ["labels"] },
      },
      {
        name: "rebuild_board",
        description: "Replace the entire AAC board.",
        parameters: { type: "object" as const, properties: { buttons: { type: "array" as const, items: { type: "object" as const, properties: { label: { type: "string" as const }, icon: { type: "string" as const } }, required: ["label", "icon"] } } }, required: ["buttons"] },
      },
      {
        name: "set_board",
        description: "Switch to a pre-built custom board.",
        parameters: { type: "object" as const, properties: { board_key: { type: "string" as const } }, required: ["board_key"] },
      },
      {
        name: "emote",
        description: "Set avatar emotion.",
        parameters: { type: "object" as const, properties: { emotion: { type: "string" as const, enum: ["happy", "sad", "neutral"] } }, required: ["emotion"] },
      },
      {
        name: "call_monitor",
        description: "Alert the monitor agent.",
        parameters: { type: "object" as const, properties: { reason: { type: "string" as const } }, required: ["reason"] },
      },
      {
        name: "request_focus",
        description: "Request a high-res close-up frame.",
        parameters: { type: "object" as const, properties: { reason: { type: "string" as const } }, required: ["reason"] },
      },
    ],
  }];

  const session = await client.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: "You are an AAC assistant. Use speak() to talk and rebuild_board() to show buttons. Respond using tool calls only." }] },
      temperature: 0.7,
      tools: tools as any,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks: {
      onopen: () => console.log("[WithTools] Connected"),
      onmessage: (msg: LiveServerMessage) => {
        const keys = Object.keys(msg).filter(k => (msg as any)[k] != null);
        console.log(`[WithTools] Message keys: ${keys.join(", ")}`);

        if (msg.setupComplete) {
          console.log("[WithTools] Setup complete");
        }
        if (msg.toolCall?.functionCalls) {
          for (const fc of msg.toolCall.functionCalls) {
            console.log(`[WithTools] TOOL CALL: ${fc.name}(${JSON.stringify(fc.args).substring(0, 200)})`);
          }
          // Send tool responses
          const responses = msg.toolCall.functionCalls.map(fc => ({
            id: fc.id || "",
            name: fc.name || "",
            response: { output: "ok" },
          }));
          session.sendToolResponse({ functionResponses: responses as any });
          console.log(`[WithTools] Sent ${responses.length} tool response(s)`);
        }
        if (msg.serverContent) {
          const c = msg.serverContent;
          if (c.modelTurn?.parts) {
            const types = c.modelTurn.parts.map((p: any) => {
              if (p.text) return `text("${p.text.substring(0, 80)}")`;
              if (p.inlineData) return `audio(${p.inlineData.data?.length || 0} bytes)`;
              return `other(${Object.keys(p).join(",")})`;
            });
            console.log(`[WithTools] Model parts: ${types.join(", ")}`);
          }
          if ((c as any).outputTranscription) {
            console.log(`[WithTools] Output transcription: ${JSON.stringify((c as any).outputTranscription).substring(0, 200)}`);
          }
          if ((c as any).groundingMetadata) {
            console.log(`[WithTools] Grounding metadata: ${JSON.stringify((c as any).groundingMetadata).substring(0, 200)}`);
          }
          if (c.turnComplete) {
            console.log("[WithTools] Turn complete");
          }
        }
      },
      onerror: (e: ErrorEvent) => console.error("[WithTools] Error:", e.message),
      onclose: (e: CloseEvent) => console.log(`[WithTools] Closed: code=${e.code} reason=${e.reason}`),
    },
  });

  // Wait for setup, then send a text message
  await new Promise(r => setTimeout(r, 2000));
  console.log("[WithTools] Sending message: 'Hello! Greet me with speak() and show some activity buttons with rebuild_board().'");
  session.sendClientContent({
    turns: [{ role: "user", parts: [{ text: "Hello! Greet me with speak() and show some activity buttons with rebuild_board()." }] }],
    turnComplete: true,
  });

  // Wait for response
  await new Promise(r => setTimeout(r, 10000));
  session.close();
  console.log("[WithTools] Session closed");
}

async function main() {
  console.log(`Project: ${project}, Location: ${location}`);
  console.log(`Model: ${MODEL}`);

  try {
    await testWithoutTools();
  } catch (err) {
    console.error("Test 1 failed:", err);
  }

  await new Promise(r => setTimeout(r, 2000));

  try {
    await testWithTools();
  } catch (err) {
    console.error("Test 2 failed:", err);
  }
}

main().catch(console.error);
