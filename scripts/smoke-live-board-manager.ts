// Smoke test: prove the Live Board Manager actually connects to Vertex and
// produces board events. Run with:  npx tsx scripts/smoke-live-board-manager.ts
//
// Does a cold invoke (includes connect) and a warm invoke (reuses the session)
// so we can see the latency difference the experiment is about, and confirms
// usage is reported (so cost billing fires). Closes cleanly so the process exits.

import "dotenv/config";
import { LiveBoardManagerAgent } from "../server/services/dual-agent/live-board-manager-agent";
import { BoardManagerAgent, type BoardManagerInvocationInput } from "../server/services/dual-agent/board-manager-agent";
import type { BoardManagerToolConfig } from "../server/services/dual-agent/prompts/board-manager";
import type { AgentEvent } from "../server/services/dual-agent/agent-events";

// Defaults match the shipped config: gemini-3.1-flash-live-preview on the
// PUBLIC Gemini API (the only model that emits usable structured board args;
// it isn't on Vertex). Override via AAC_BOARD_MANAGER_MODEL / AAC_BM_SMOKE_VERTEX=1.
const LIVE_MODEL = process.env.AAC_BOARD_MANAGER_MODEL || "gemini-3.1-flash-live-preview";
const USE_VERTEX = process.env.AAC_BM_SMOKE_VERTEX === "1";

const SYSTEM_PROMPT = [
  "You are the Board Manager for an AAC communication app for a child.",
  "Every time you are invoked you MUST call exactly one tool.",
  "When the child needs options to say, call rebuild_board with 4-6 short buttons,",
  "each with a `label`, a `speech` string, and a `glyphFallback` emoji.",
  "If the current board already fits, call no_change with a short reason.",
].join("\n");

const TOOL_CONFIG: BoardManagerToolConfig = {
  availableBoards: [],
  hasLoadedBoard: false,
  loadedBoardKey: null,
  loadedBoardName: null,
  maxBoardItems: 12,
  language: "en",
  singleGlyphButtons: false,
  glyphInputTranslation: false,
};

const trigger: AgentEvent = {
  type: "speech_text_finalized",
  source: "speaker",
  timestamp: Date.now(),
  transcript: "What would you like to talk about?",
} as AgentEvent;

function makeInput(): BoardManagerInvocationInput {
  return {
    systemPrompt: SYSTEM_PROMPT,
    toolConfig: TOOL_CONFIG,
    triggeringEvents: [trigger],
    recentEvents: [],
    currentBoardLabels: [],
    currentBoardButtons: [],
    contextSidebarLabels: [],
    loadedBoardId: null,
    provider: "gemini",
    model: "gemini-2.5-flash",
  };
}

async function main() {
  let usageHits = 0;
  const agent = new LiveBoardManagerAgent({
    providerKey: "gemini",
    model: LIVE_MODEL,
    useVertex: USE_VERTEX,
    voiceName: process.env.AAC_BM_SMOKE_VOICE || "Kore",
    onUsage: (u) => {
      usageHits++;
      const d = u.details;
      console.log(`  [onUsage] prompt=${u.promptTokens} completion=${u.completionTokens}` +
        (d ? ` (text_in=${d.textInputTokens} non_text_in=${d.nonTextInputTokens} text_out=${d.textOutputTokens} audio_out=${d.audioOutputTokens})` : " (no modality details)"));
    },
  });

  console.log(`\n=== LIVE Board Manager smoke test (model=${LIVE_MODEL}, vertex=${USE_VERTEX}) ===`);

  try {
    // Cold invoke — includes the live connect.
    const t0 = Date.now();
    const r1 = await agent.invoke(makeInput());
    const coldMs = Date.now() - t0;
    console.log(`\n[COLD]  ${coldMs}ms  finish=${r1.finishReason}  events=${r1.events.map(e => e.type).join(",") || "(none)"}  rawCalls=${r1.rawToolCalls.length}`);
    const board1 = r1.events.find(e => e.type === "board_rebuilt") as any;
    if (board1) console.log(`        buttons: ${board1.buttons.map((b: any) => b.label).join(" | ")}`);

    // Warm invoke — reuses the session (the latency the experiment is testing).
    const t1 = Date.now();
    const r2 = await agent.invoke(makeInput());
    const warmMs = Date.now() - t1;
    console.log(`[WARM]  ${warmMs}ms  finish=${r2.finishReason}  events=${r2.events.map(e => e.type).join(",") || "(none)"}  rawCalls=${r2.rawToolCalls.length}`);
    const board2 = r2.events.find(e => e.type === "board_rebuilt") as any;
    if (board2) console.log(`        buttons: ${board2.buttons.map((b: any) => b.label).join(" | ")}`);

    console.log(`\nusage callbacks fired: ${usageHits} (cost billing path exercised: ${usageHits > 0 ? "YES" : "NO"})`);
    // A REAL success means the model produced tool calls (a board) and usage
    // was reported. A clean socket that immediately closes with a config error
    // surfaces as finish=CLOSED with zero raw calls — that is NOT working.
    const producedBoard = (r1.rawToolCalls.length > 0 || r2.rawToolCalls.length > 0);
    const ok = producedBoard && usageHits > 0;
    console.log(`backend connection: ${ok ? "OK ✅ (produced boards + usage)" : "FAILED ❌ (no tool calls / no usage; finish=" + r1.finishReason + ")"}`);
  } catch (err) {
    console.error("smoke test threw:", err);
  } finally {
    agent.close();
  }

  // Quick HTTP comparison so we can see the latency delta.
  try {
    const http = new BoardManagerAgent("gemini");
    const t0 = Date.now();
    const r = await http.invoke({ ...makeInput(), model: "gemini-2.5-flash" });
    console.log(`\n[HTTP]  ${Date.now() - t0}ms  finish=${r.finishReason}  events=${r.events.map(e => e.type).join(",") || "(none)"}`);
  } catch (err) {
    console.error("HTTP comparison threw:", err);
  }

  // Give any in-flight provider close a beat, then force exit (the SDK may keep
  // a socket/timer alive otherwise).
  setTimeout(() => process.exit(0), 1500);
}

main();
