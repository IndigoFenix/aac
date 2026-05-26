// server/services/dual-agent/live-relay-v2.ts
// WebSocket relay layer v2: bridges a client WebSocket to a live provider session.
// Clean rewrite with explicit state machine replacing boolean guard flags.
// Handles tool call dispatch, TTS synthesis, contact enrollment, monitor triggering.

import type { IncomingMessage } from "http";
import { randomBytes } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { User } from "@shared/schema";
import { authenticateUpgrade } from "../realtime/ws-auth";
import { studentService } from "../studentService";
import type {
  LiveProvider,
  LiveProviderCallbacks,
  LiveProviderConfig,
  ToolCall,
  ToolResponse,
} from "./live-provider";
import { GeminiLiveProvider } from "./gemini-live-provider";
import { parseBoardButtons } from "./interactive-agent";
import { getAppDefinition, APP_REGISTRY } from "./app-registry";
import { buildDefaultHomeBoard, HOME_BOARD_KEY } from "./default-home-board";
import type {
  AACMuteState,
  AACResponseMode,
  DualAgentSessionState,
  TurnToolAccumulator,
} from "./types";
import { createEmptyAccumulator } from "./types";
import { buildToolDeclarations, type ToolDeclarationConfig } from "./tool-declarations";
import { T } from "../memory-schema/canonical-terms";
import { ttsFacade, type ResolvedVoice } from "../voice/tts-facade";
import { GeminiLiveTtsSession } from "../voice/gemini-live-tts-service";
import { searchYouTube } from "../youtube/youtube-search";
import { searchSpotify } from "../spotify/spotify-search";
import {
  findMatchingFace,
  recordContactSighting,
  type FaceMatchResult,
} from "../biometric/recognition-service";
import { logDualAgent, logLiveSession, runInSessionContext } from "./dual-agent-logger";
import { activityLogService } from "../activityLogService";
import { recordUtterance } from "../insurance/utteranceLogger";
import { dualAgentService, type SessionCache } from "./dual-agent-service";
import { buildInteractiveAgentPrompt, buildRestingAgentPrompt, AAC_DEFAULT_PERSONA_PROMPT } from "../memory-schema/aac-memory-schema";
import { boardRepository } from "../../repositories/boardRepository";
import { customAppRepository } from "../../repositories/customAppRepository";
import { validateCustomAppDefinition } from "@shared/custom-app-validator";
import type { PermittedWebsite, PermittedYoutubeVideo } from "@shared/schema";
import { isUrlPermitted, mergeBoardWebsitesIntoPermitted } from "@shared/permitted-websites";
import { fetchRecentVideosForChannels } from "../youtube/channel-search";
import { licenseService } from "../licenseService";
import { settingsRepository } from "../../repositories/settingsRepository";
import { aacSettingsRepository } from "../../repositories/aacSettingsRepository";
import { resolveImageKeys, queueSymbolGeneration } from "../symbol/auto-symbol-service";
import { getVocabularyItem } from "@shared/glyph-registry";
import { resolveEmoji, isEmoji } from "@shared/emoji-registry";
import { parseGlyph, stripBrackets } from "@shared/glyph-compositor.js";
import { validateBoardButtons, collectGlyphImageKeys } from "./board-button-validator";
import { MODEL_OPTIONS, type LLMProviderKey } from "@shared/llm-options";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Keys that are never the "real content" of a tool call — skip during fallback. */
const EXTRACT_SKIP_KEYS = new Set(["id", "status", "confidence", "speaker", "type", "name"]);

/** Extract a string argument from tool call args.
 *  Gemini's native function calling frequently uses wrong parameter names
 *  (e.g. "board_name" instead of "name", "observations" instead of "text").
 *  Falls back to the first non-ID string value in the args object. */
function extractStringArg(args: Record<string, any>, declaredName: string, fallback = ""): string {
  if (typeof args[declaredName] === "string") return args[declaredName];
  // Fall back: find the first string value that looks like actual content
  for (const [key, val] of Object.entries(args)) {
    if (EXTRACT_SKIP_KEYS.has(key)) continue;
    if (typeof val === "string" && val.length > 0) return val;
  }
  return fallback;
}

/**
 * Find a pinned video matching `query`. Tries (in order):
 *   1. Embedded 11-char videoId (handles "VIDEOID" or any URL the AI emitted)
 *   2. Exact label match (case-insensitive, trimmed)
 *   3. Substring match against label (case-insensitive)
 * Returns null when nothing fits — caller falls through to channel search.
 */
function findPinnedVideoMatch(
  query: string,
  videos: PermittedYoutubeVideo[],
): PermittedYoutubeVideo | null {
  if (!videos.length || !query) return null;
  const trimmed = query.trim();
  const idMatch = /([A-Za-z0-9_-]{11})/.exec(trimmed);
  if (idMatch) {
    const byId = videos.find(v => v.videoId === idMatch[1]);
    if (byId) return byId;
  }
  const lower = trimmed.toLowerCase();
  const byLabelExact = videos.find(v => v.label.toLowerCase().trim() === lower);
  if (byLabelExact) return byLabelExact;
  const byLabelContains = videos.find(v => v.label.toLowerCase().includes(lower));
  if (byLabelContains) return byLabelContains;
  return null;
}

/** Stringify a WebSocket message for logging. Truncates large base64 strings inline
 *  but keeps the rest of the object structure intact so we see real content. */
function stringifyMsg(msg: any): string {
  return JSON.stringify(msg, (_key, value) => {
    if (typeof value === "string" && value.length > 200) {
      return `[${value.length} chars]`;
    }
    return value;
  });
}

/** Convert tool-call button args to internal format.
 *  Accepts multiple formats the model may produce:
 *  - String (preferred):  "I want water|i_me+want+water|👤+🤲+💧|Water"  (parseBoardButtons format)
 *  - Array of strings:    join and parse via parseBoardButtons
 *  - Object array:        [{sentence, glyph, fallback, label, row_span?, col_span?}]
 *
 *  The object array also accepts legacy field names (`icon`, `image_key`)
 *  so that older Gemini tool-call shapes don't break mid-rollout. */
function toolArgsToButtons(raw: unknown): Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; glyph?: string; glyphFallback?: string; sentence?: string; buttonType?: "guess" | "category"; rowSpan?: number; colSpan?: number }> {
  // String — the expected format from native audio models.
  if (typeof raw === "string") {
    return parseBoardButtons(raw as string);
  }

  if (!Array.isArray(raw) || raw.length === 0) return [];

  // Array of strings — join into comma-separated and parse.
  if (typeof raw[0] === "string") {
    const joined = raw.map((s: any) => String(s).trim()).filter(Boolean).join(", ");
    return parseBoardButtons(joined);
  }

  // Object array — OpenAI / Gemini structured tool-call format.
  return raw.map((b: any) => {
    const label = (typeof b?.label === "string" ? b.label : String(b?.label ?? "")).trim() || "?";
    const sentence = (typeof b?.sentence === "string" ? b.sentence : "").trim() || undefined;
    const glyph = (typeof b?.glyph === "string" ? b.glyph : "").trim() || undefined;
    const glyphFallback = (typeof b?.fallback === "string" ? b.fallback : "").trim() || undefined;
    // Legacy field names — still accepted for backward compatibility.
    const legacyIcon = (typeof b?.icon === "string" ? b.icon : "").trim();
    const legacyImageKey = (typeof b?.image_key === "string" ? b.image_key : "").trim();
    const rawRowSpan = typeof b?.row_span === "number" ? b.row_span : parseInt(b?.row_span, 10);
    const rawColSpan = typeof b?.col_span === "number" ? b.col_span : parseInt(b?.col_span, 10);
    const rowSpan = rawRowSpan >= 2 ? rawRowSpan : undefined;
    const colSpan = rawColSpan >= 2 ? rawColSpan : undefined;

    // Derive iconRef / symbolPath / imageKey from the fallback (single-slot
    // emoji or `symbol:`/`face:` ref) and the glyph (single-slot snake_case
    // imageKey). This mirrors parseBoardButtons so both input shapes produce
    // the same downstream button objects.
    let iconRef = "fas fa-comment";
    let symbolPath: string | undefined;
    let imageKey: string | undefined;

    if (glyphFallback) {
      const fbSlots = glyphFallback.split('+').map((s: string) => s.trim()).filter(Boolean);
      if (fbSlots.length === 1) {
        const slotMain = stripBrackets(fbSlots[0].split('.')[0].split('(')[0]);
        if (slotMain.startsWith("face:")) {
          symbolPath = `__FACE__:${slotMain.substring(5).trim()}`;
        } else if (slotMain.startsWith("symbol:")) {
          symbolPath = `__SYMBOL__:${slotMain.substring(7).trim()}`;
        } else if (slotMain) {
          iconRef = slotMain;
        }
      }
    }
    // Legacy `icon` field — only used if the new `fallback` field didn't
    // already set an iconRef or symbolPath.
    if (iconRef === "fas fa-comment" && !symbolPath && legacyIcon) {
      const legacyIconStripped = stripBrackets(legacyIcon);
      if (legacyIconStripped.startsWith("face:")) {
        symbolPath = `__FACE__:${legacyIconStripped.substring(5).trim()}`;
      } else if (legacyIconStripped.startsWith("symbol:")) {
        symbolPath = `__SYMBOL__:${legacyIconStripped.substring(7).trim()}`;
      } else {
        iconRef = legacyIconStripped;
      }
    }

    if (glyph) {
      const glyphSlots = glyph.split('+').map((s: string) => s.trim()).filter(Boolean);
      if (glyphSlots.length === 1) {
        const slotMain: string = stripBrackets(glyphSlots[0].split('.')[0].split('(')[0]);
        const isEmojiKey = /^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(slotMain);
        if (slotMain && !isEmojiKey && !slotMain.startsWith("face:") && !slotMain.startsWith("symbol:")) {
          imageKey = slotMain;
          if (iconRef === "fas fa-comment") {
            const emojiSwap = resolveEmoji(slotMain);
            if (emojiSwap) {
              iconRef = emojiSwap;
              imageKey = undefined;
            }
          }
        }
      }
    } else if (legacyImageKey) {
      // Legacy: AI emitted `image_key` without a glyph field. Treat it as
      // a single-concept button — promote to glyph if multi-part.
      if (legacyImageKey.includes("+")) {
        const parts = legacyImageKey.split("+").map((s: string) => stripBrackets(s)).filter(Boolean);
        if (parts.length > 1) {
          // Use this as the glyph below by reassigning to glyph.
          return assemble({ label, sentence, glyph: parts.join("+"), glyphFallback, iconRef, symbolPath, imageKey: undefined, rowSpan, colSpan });
        }
      }
      const legacyKey = stripBrackets(legacyImageKey);
      imageKey = legacyKey;
      if (iconRef === "fas fa-comment") {
        const emojiSwap = resolveEmoji(legacyKey);
        if (emojiSwap) {
          iconRef = emojiSwap;
          imageKey = undefined;
        }
      }
    }

    return assemble({ label, sentence, glyph, glyphFallback, iconRef, symbolPath, imageKey, rowSpan, colSpan });
  });
}

/** Small helper to centralize the final button object shape. */
function assemble(b: {
  label: string;
  sentence?: string;
  glyph?: string;
  glyphFallback?: string;
  iconRef: string;
  symbolPath?: string;
  imageKey?: string;
  rowSpan?: number;
  colSpan?: number;
}) {
  return {
    label: b.label,
    iconRef: b.iconRef,
    symbolPath: b.symbolPath,
    imageKey: b.imageKey,
    glyph: b.glyph,
    glyphFallback: b.glyphFallback,
    sentence: b.sentence,
    rowSpan: b.rowSpan,
    colSpan: b.colSpan,
  };
}

/**
 * When the model violates the "unique imageKey per board" rule and gives two
 * buttons the same imageKey, both buttons resolve to the identical cached
 * symbol — the user sees duplicate images. Detect that case and append a
 * label-derived slug to subsequent duplicates so each routes to its own
 * symbol slot (and triggers fresh symbol generation for the duplicates).
 */
/**
 * Smart board merge — applies the user-facing rules from the "smooth
 * board fixer" spec:
 *
 *   1. Any incoming button that's an exact duplicate of an existing
 *      button (same label + glyph + glyphFallback + sentence) is treated
 *      as already-present — the existing button stays put, the duplicate
 *      is dropped. This keeps surviving buttons' IDs (and DOM nodes)
 *      stable across rebuilds.
 *
 *   2. If `prev.length + toAdd.length ≤ max`, no displacement: every
 *      existing button stays, every new one is appended.
 *
 *   3. If `prev.length + toAdd.length > max`, the overflow has to evict
 *      some `prev` buttons. Only `leftover` ones (not exact-matched by
 *      anything in `next`) are eligible to be displaced — anything the
 *      AI explicitly kept in `next` survives. For each new button, the
 *      best-scoring leftover (label / glyph / sentence overlap) is the
 *      displacement target so "Apples" at slot 3 can be smoothly swapped
 *      for "Oranges" at slot 3 rather than reshuffling the whole grid.
 *      New buttons with no good leftover match take the next free slot
 *      (or, if everything's already full, drop).
 *
 * The function mutates nothing — it returns a fresh `merged` array (in
 * slot order, with stable IDs reused where possible) plus a diagnostic
 * report so the caller can log what happened.
 */
interface MergeButton {
  id?: string;
  label: string;
  iconRef: string;
  symbolPath?: string;
  imageKey?: string;
  glyph?: string;
  glyphFallback?: string;
  sentence?: string;
  buttonType?: "guess" | "category";
  rowSpan?: number;
  colSpan?: number;
}

interface MergeReport {
  preservedIds: string[];      // prev IDs that survived untouched
  displacedIds: string[];      // prev IDs that got evicted to make room
  newIds: string[];            // freshly-minted IDs for incoming buttons
  duplicatesIgnored: number;   // incoming buttons that matched existing
}

function exactDuplicate(a: MergeButton, b: MergeButton): boolean {
  return (
    a.label.trim().toLowerCase() === b.label.trim().toLowerCase()
    && (a.glyph || "") === (b.glyph || "")
    && (a.glyphFallback || "") === (b.glyphFallback || "")
    && (a.sentence || "").trim() === (b.sentence || "").trim()
  );
}

/**
 * Score how likely `incoming` is meant to REPLACE `existing`. Higher =
 * better match. 0 means no shared signature at all (we'll still allow
 * displacement as a last resort, but ranked behind partial matches).
 */
function replacementScore(incoming: MergeButton, existing: MergeButton): number {
  let score = 0;
  if (incoming.label.trim().toLowerCase() === existing.label.trim().toLowerCase()) {
    score += 3;
  }
  if (incoming.glyph && incoming.glyph === existing.glyph) {
    score += 2;
  }
  if (
    incoming.sentence
    && existing.sentence
    && incoming.sentence.trim() === existing.sentence.trim()
  ) {
    score += 2;
  }
  if (
    incoming.glyphFallback
    && incoming.glyphFallback === existing.glyphFallback
  ) {
    score += 1;
  }
  return score;
}

function smartMergeButtons(
  prev: MergeButton[],
  incoming: MergeButton[],
  maxSlots: number,
  newId: () => string,
): { merged: MergeButton[]; report: MergeReport } {
  const report: MergeReport = {
    preservedIds: [],
    displacedIds: [],
    newIds: [],
    duplicatesIgnored: 0,
  };

  // Pass 1 — pair up exact duplicates so we know which incoming items
  // collapse into existing buttons.
  const matchedPrevIdx = new Set<number>();
  const matchedNextIdx = new Set<number>();
  for (let ni = 0; ni < incoming.length; ni++) {
    for (let pi = 0; pi < prev.length; pi++) {
      if (matchedPrevIdx.has(pi)) continue;
      if (exactDuplicate(incoming[ni], prev[pi])) {
        matchedPrevIdx.add(pi);
        matchedNextIdx.add(ni);
        report.duplicatesIgnored++;
        break;
      }
    }
  }

  const toAdd = incoming
    .map((b, i) => ({ b, i }))
    .filter(({ i }) => !matchedNextIdx.has(i))
    .map(({ b }) => b);

  // Plenty of room — nothing displaced.
  if (prev.length + toAdd.length <= maxSlots) {
    const merged: MergeButton[] = [];
    for (const p of prev) {
      merged.push(p);
      if (p.id) report.preservedIds.push(p.id!);
    }
    for (const b of toAdd) {
      const id = newId();
      merged.push({ ...b, id });
      report.newIds.push(id);
    }
    return { merged, report };
  }

  // Overflow — we need to evict (prev.length + toAdd.length - max) buttons.
  // Leftover (unmatched prev) buttons are the natural eviction pool.
  const leftoverIndices: number[] = [];
  for (let pi = 0; pi < prev.length; pi++) {
    if (!matchedPrevIdx.has(pi)) leftoverIndices.push(pi);
  }

  // Build candidate (incoming, leftover) pairs and sort by descending score.
  // Each new button gets matched to at most one leftover; each leftover gets
  // displaced at most once.
  const candidates: Array<{ addIdx: number; prevIdx: number; score: number }> = [];
  for (let ai = 0; ai < toAdd.length; ai++) {
    for (const pi of leftoverIndices) {
      candidates.push({ addIdx: ai, prevIdx: pi, score: replacementScore(toAdd[ai], prev[pi]) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  // Pair greedy: highest scores first.
  const addToPrev = new Map<number, number>();   // addIdx -> prevIdx (displacement target)
  const prevToAdd = new Map<number, number>();   // prevIdx -> addIdx (reverse lookup)
  for (const c of candidates) {
    if (addToPrev.has(c.addIdx)) continue;
    if (prevToAdd.has(c.prevIdx)) continue;
    addToPrev.set(c.addIdx, c.prevIdx);
    prevToAdd.set(c.prevIdx, c.addIdx);
  }

  // Walk prev in order, building the merged result. A displaced prev is
  // replaced in place by its assigned incoming button so the slot index
  // (and therefore grid position) stays put — that's what makes the
  // client animation fade-out/fade-in at the same cell.
  const merged: MergeButton[] = [];
  const consumedAddIndices = new Set<number>();
  for (let pi = 0; pi < prev.length; pi++) {
    const replaceWith = prevToAdd.get(pi);
    if (replaceWith !== undefined) {
      const id = newId();
      merged.push({ ...toAdd[replaceWith], id });
      consumedAddIndices.add(replaceWith);
      report.newIds.push(id);
      if (prev[pi].id) report.displacedIds.push(prev[pi].id!);
    } else {
      merged.push(prev[pi]);
      if (prev[pi].id) report.preservedIds.push(prev[pi].id!);
    }
  }

  // Any incoming buttons that weren't paired to a leftover go into the
  // remaining slack (slots beyond prev.length). If we're still over max,
  // they get dropped — the AI's lowest-priority requests fall off the
  // end first.
  for (let ai = 0; ai < toAdd.length; ai++) {
    if (consumedAddIndices.has(ai)) continue;
    if (merged.length >= maxSlots) break;
    const id = newId();
    merged.push({ ...toAdd[ai], id });
    report.newIds.push(id);
  }

  return { merged: merged.slice(0, maxSlots), report };
}

function dedupeImageKeys<T extends { label: string; imageKey?: string }>(buttons: T[]): T[] {
  const seen = new Map<string, number>();
  const collisions: string[] = [];
  for (const btn of buttons) {
    if (!btn.imageKey) continue;
    const key = btn.imageKey;
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      const slug = btn.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24) || `dup${count}`;
      btn.imageKey = `${key}_${slug}`;
      collisions.push(`${key} → ${btn.imageKey}`);
    }
    seen.set(key, count + 1);
  }
  if (collisions.length > 0) {
    logLiveSession(
      "IMAGEKEY_DEDUP",
      `Model produced duplicate imageKeys; rewriting: ${collisions.join("; ")}`,
    );
  }
  return buttons;
}

/**
 * Format a ${T.builder} state snapshot as a [${T.builder} STATE]
 * context injection. Compact and structured so the model can quickly route
 * to the suggest_construction_buttons tool.
 */
function formatConstructionStateInjection(
  state: ConstructionStateWire,
  currentBoardLabels: readonly string[] = [],
): string {
  const filled = state.glyph ? state.glyph : "(empty)";
  // Identify the "current" HEAD SYMBOL — the one a MODIFIER SUGGESTION
  // would attach to when tapped. The client uses the explicit
  // `activeSlot` selection when present, else the most-recent slot
  // (see `resolveActiveSlot` in glyph-compositor.ts). Mirror that here so
  // the AI knows which slot its modifier_candidates target.
  const parsed = state.glyph ? parseGlyph(state.glyph) : null;
  const slotCount = parsed?.slots.length ?? 0;
  const activeSlotIndex =
    state.activeSlot != null && state.activeSlot < slotCount
      ? state.activeSlot
      : slotCount > 0
        ? slotCount - 1
        : null;
  const activeSlot = activeSlotIndex != null ? parsed!.slots[activeSlotIndex] : null;
  const activeHeadDesc = activeSlot
    ? activeSlot.modifiers.length > 0
      ? `slot ${activeSlotIndex} = ${activeSlot.key} (already has modifiers: ${activeSlot.modifiers.join(", ")})`
      : `slot ${activeSlotIndex} = ${activeSlot.key}`
    : "(none — sentence is empty)";

  const lines: string[] = [
    `${T.tagBuilderState}`,
    `category: ${state.category}`,
    `mode_chip: ${state.modeChip}`,
    `sentence: ${filled}`,
    `target_slot: ${state.targetSlot ?? "next_empty"} (where head_candidates go)`,
    `active_head_symbol: ${activeHeadDesc} (where modifier_candidates attach)`,
  ];
  // Surface what was on the ${T.board} when the user opened the
  // ${T.builder}. Labels are the AI's own ${T.button} text from the
  // most recent rebuild_board / add_buttons / loaded board, so they anchor
  // the builder state to the live conversation topic and let the model
  // bias SUGGESTIONs toward the same theme.
  if (currentBoardLabels.length > 0) {
    lines.push(`current_board: [${currentBoardLabels.join(", ")}]`);
  }
  if (state.excludeKeys.length > 0) {
    lines.push(`exclude_keys: ${state.excludeKeys.join(", ")}`);
  }
  if (state.payloadTarget) {
    lines.push(
      `payload_target: slot ${state.payloadTarget.slotIndex} (${state.payloadTarget.hostKey}) — needs a ${T.symbol} of type [${state.payloadTarget.accepts.join(", ")}]; ${T.suggestion}s should come from [${state.payloadTarget.suggestCategories.join(", ")}]`
    );
  }
  lines.push("");
  if (state.requestGuessingMode) {
    lines.push(
      `The user pressed Help — enter guessing mode (see <guessing_mode>) to narrow down what ${T.symbol} they want here. When you've narrowed enough, call suggest_construction_buttons with the resolved ${T.symbol} as the single \`head_candidates\` ${T.suggestion} to populate the slot directly.`
    );
  } else if (state.payloadTarget) {
    lines.push(
      `The user placed a composable host ${T.glyph} (\`${state.payloadTarget.hostKey}\`) and the embedded blank is unfilled. Call suggest_construction_buttons with up to 4 ${T.headSymbol}s in \`head_candidates\` that could fill that blank — what they might ${state.payloadTarget.hostKey}. Use \`slot_index: ${state.payloadTarget.slotIndex}\`. Modifier suggestions don't apply to an unfilled composable blank; leave \`modifier_candidates\` empty. Skip if nothing helpful comes to mind.`
    );
  } else {
    // Two-array call. Tell the AI EXPLICITLY when each array is relevant:
    //   - head_candidates: always, unless the sentence is at max length.
    //   - modifier_candidates: only when there IS an active head SYMBOL
    //     to attach a modifier to (otherwise there's nothing to modify).
    // Without this nudge the model treats modifier_candidates as an
    // afterthought and almost always leaves it empty even when the
    // current head is a perfect modifier target (e.g. a noun that
    // could take color/size/count/possession).
    if (activeSlot) {
      lines.push(
        `Call suggest_construction_buttons with two ${T.suggestion} arrays in the SAME call:`,
        `  • \`head_candidates\` (up to 4 ${T.headSymbol}s) — what the user wants to say NEXT, after slot ${activeSlotIndex}. Goes into slot ${state.targetSlot ?? "next_empty"}.`,
        `  • \`modifier_candidates\` (up to 4 ${T.modifierSymbol}s) — properties of \`${activeSlot.key}\` worth surfacing right now: color (\`color_red\`, \`color_blue\`…), size (\`big\`, \`small\`), count (\`one\`, \`two\`, \`many\`), possession (\`my\`, \`your\`), intensity (\`very\`, \`a_little\`), or any conversation-specific qualifier. Tapping one ADDS it to slot ${activeSlotIndex} without advancing.`,
        `Fill BOTH when each makes sense — modifiers are easy to skip but often the single most useful suggestion (a red apple, a big hug, two cookies). Either array may be empty; skip the tool call entirely only if nothing fits in either.`,
      );
    } else {
      lines.push(
        `Call suggest_construction_buttons with \`head_candidates\` (up to 4 ${T.headSymbol}s) for slot ${state.targetSlot ?? "next_empty"} — what the user might want to say first. The sentence is empty, so there's no ${T.headSymbol} to attach modifiers to; leave \`modifier_candidates\` empty. Skip the tool call entirely if no head suggestion fits.`,
      );
    }
  }
  return lines.join("\n");
}

/** Convert raw PCM buffer (16-bit LE, mono) to a WAV buffer by prepending a 44-byte header */
function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);              // fmt chunk size
  header.writeUInt16LE(1, 20);               // PCM format
  header.writeUInt16LE(1, 22);               // mono
  header.writeUInt32LE(sampleRate, 24);      // sample rate
  header.writeUInt32LE(sampleRate * 2, 28);  // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32);               // block align
  header.writeUInt16LE(16, 34);              // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// ---------------------------------------------------------------------------
// Gemini voice mapping for direct audio mode
// ---------------------------------------------------------------------------

/** Map VoiceType to Gemini prebuilt voice names */
const GEMINI_VOICE_MAP: Record<string, string> = {
  man:   "Orus",
  woman: "Zephyr",
  boy:   "Puck",
  girl:  "Leda",
};

// ---------------------------------------------------------------------------
// Client ↔ Server Protocol
// ---------------------------------------------------------------------------

/** Messages from client → server */
export type ClientMessage =
  | { type: "initialize"; studentId: string; userId?: string; sessionId?: string; muteState?: AACMuteState; responseMode?: AACResponseMode; debugMode?: boolean; initialFrame?: string; timezone?: string }
  | { type: "frame_grid"; data: string; timestamps?: number[]; gestureContext?: string; triggerReason?: string }    // base64 JPEG
  | { type: "audio_clip"; data: string; mimeType?: string }        // base64 audio (ignored in live mode — Gemini hears PCM directly)
  | { type: "pcm_audio"; data: string }                            // base64 raw PCM Int16 16kHz — streamed directly to Gemini
  | { type: "user_message"; text: string }
  | { type: "voice_audio"; data: string; mimeType?: string }       // base64 webm (ignored in live mode — Gemini hears PCM directly)
  | { type: "button_press"; buttons: string[]; sentences?: Record<string, string>; board?: any }
  | { type: "board_exit"; label: string; instruction: string }  // exit button pressed on loaded board
  | { type: "gesture_context"; data: string }
  | { type: "person_context"; data: any }
  | { type: "board_state"; data: any }
  | { type: "set_mute_state"; muteState: AACMuteState }
  | { type: "set_response_mode"; mode: AACResponseMode }
  | { type: "unknown_face_descriptors"; data: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number }; cameraRole?: "user" | "environment" | "unknown"; cameraLabel?: string }> }
  | { type: "page_navigate"; pageId: string; pageName: string; buttons: string[] }
  | { type: "app_dismissed"; appId: string }
  | { type: "app_canvas"; data: string }                     // base64 PNG — app canvas (e.g. drawing)
  | { type: "focus_frame"; data: string }                    // base64 JPEG — high-res focus frame
  | { type: "set_paused"; paused: boolean }
  | { type: "local_state"; snapshot: import("@shared/aac-local-storage").AacSessionSnapshot }
  | { type: "context_injection"; text: string }           // inject context without triggering a response
  | { type: "client_sleep_state_change"; state: "hibernation" | "waking" | "awake" | "resting" | "asleep"; source: "ai" | "system" | "user" }   // engagement state machine transition (server logs for RTM service-time)
  | { type: "construction_state"; data: ConstructionStateWire }  // sentence construction board state changed — relay formats as context injection
  | { type: "glyph_press"; glyph: string };                       // student played a glyph from the sentence builder — AI must call interpret() to voice it

/** Messages from server → client */
export type ServerMessage =
  | { type: "initialized"; sessionId: string }
  | { type: "text"; data: string; noAudioClear?: boolean }
  | { type: "speak"; text: string; audio?: string }
  | { type: "interpret"; text: string; audio?: string; confidence?: string; noAudioClear?: boolean }
  | { type: "board_patch"; data: any }
  | { type: "board"; data: any }
  | { type: "transcript"; data: string; speaker?: string; confidence?: string }
  | { type: "context"; data: string }
  | { type: "emote"; data: string }
  | { type: "interaction_mode_changed"; data: { mode: string; reason?: string; source: "ai" | "user" } }
  | { type: "video_play"; data: any }
  | { type: "app_open"; data: any }
  | { type: "app_close"; data: any }
  | { type: "set_board"; data: { board: any; name: string; boardId: string } }
  | { type: "unload_board"; data: any }
  | { type: "ai_button_press"; data: { label: string; action: string; targetPageId: string; targetPageName: string; buttons: any[] } }
  | { type: "debug"; data: any }
  | { type: "error"; data: string }
  | { type: "thinking"; active: boolean }
  | { type: "avatar_audio"; data: string; format?: "mp3" | "wav" }  // base64 audio chunk (AI voice TTS — avatar mouth animates)
  | { type: "interpretation_audio"; data: string }     // base64 audio chunk (student voice TTS)
  | { type: "monitor_status"; data: any }
  | { type: "audio_interrupt" }                          // Stop client audio playback (model interrupted by user)
  | { type: "audio_clear_tag"; tag: string }             // Clear queued client audio for a specific tag (e.g. "interpret")
  | { type: "binary_choice"; data: { options: any[] } }  // Binary-choice (incl. yes/no) — trigger overlay with two AI-supplied ${T.button} options
  | { type: "ask_binary_choice"; data: { options: any[] } } // Deferred binary choice — show after TTS playback
  | { type: "reconnecting"; data: string }               // Server is reconnecting to Gemini
  | { type: "client_tts"; data: { text: string; voiceId: string; apiKey: string; language: string; voiceRole: "ai" | "student" } }
  | { type: "client_local_tts"; data: { text: string; language: string; voiceRole: "ai" | "student" } }
  | { type: "reconnected" }                              // Reconnection successful
  | { type: "session_reset"; sessionId: string }         // New session created after repeated failures
  | { type: "rate_limited"; data: string }               // Rate limited — client should NOT auto-reconnect
  | { type: "safety_blocked"; data: string }             // Safety/policy block — transient indicator
  | { type: "focus_request"; data: { reason: string } }  // AI requests a high-res focus frame
  | { type: "session_snapshot"; snapshot: import("@shared/aac-local-storage").AacSessionSnapshot; config: import("@shared/aac-local-storage").AacLocalStorageConfig }
  | { type: "symbol_update"; data: { buttonLabel: string; symbolPath: string } }  // Auto-generated symbol ready — update button
  | { type: "context_button_add"; data: any }                 // Add one button to context sidebar (scrolls oldest out)
  | { type: "context_button_remove"; data: { label: string } } // Remove a button from the context sidebar by label
  | { type: "guessing_mode"; active: boolean }              // Guessing mode entered/exited
  | { type: "people_identified"; data: IdentifiedFaceWire[] } // Server-side face matching results
  | { type: "sleep_state_change"; data: { state: "hibernation" | "waking" | "awake" | "resting" | "asleep"; source: "ai" | "system" } }  // AI-driven sleep state change
  | { type: "false_wake_report"; data: { reason: string } }   // AI flagged the recent wake from Asleep as a false alarm
  | { type: "construction_suggestions"; data: ConstructionSuggestionsWire }  // AI's response to a construction_state injection — populates the AI strip
  | { type: "construction_symbol_ready"; data: ConstructionSymbolReadyWire }  // a queued construction-key symbol finished generating — client patches the AI strip by key
  | { type: "construction_memory_chips"; data: ConstructionMemoryChipsWire }  // AI-curated dynamic chips for one tab on the construction board
  | { type: "complete"; data?: any };

/** Construction-board state forwarded to the AI as context, on every relevant change. */
export interface ConstructionStateWire {
  category: "who" | "do" | "what" | "where" | "when";
  modeChip: string;
  /** Serialized glyph string ("i_me+want+water.big#question"). */
  glyph: string;
  /** Slot index currently selected by the user, or null. */
  activeSlot: number | null;
  /** Slot index the AI should suggest for (null = next empty slot). */
  targetSlot: number | null;
  /** Keys already shown for this slot — AI should not repeat them. */
  excludeKeys: string[];
  /** When true, the user has requested help — AI should enter guessing mode. */
  requestGuessingMode?: boolean;
  /**
   * Set when the user has placed a composable host (e.g. `want`) whose
   * payload is still empty. The AI should suggest fillers for the blank
   * (typically nouns) instead of candidates for the next sentence slot.
   */
  payloadTarget?: {
    slotIndex: number;
    hostKey: string;
    accepts: string[];
    suggestCategories: Array<"who" | "do" | "what" | "where" | "when">;
  };
}

/** AI's suggestion payload — routed back to the construction board's AI strip. */
/** One SUGGESTION delivered on the wire — same shape for heads and modifiers. */
interface ConstructionCandidateWire {
  key: string;
  label?: string;
  /**
   * Resolved image URL for AI-generated keys (i.e. keys not in the glyph
   * registry). When undefined, the client renders the SUGGESTION using
   * the registry's imagePath/emoji (or a placeholder if the key is
   * unknown and a symbol generation is pending — see
   * construction_symbol_ready).
   */
  symbolPath?: string;
  /**
   * Non-generate fallback key used by the client while a `generate:` key
   * is awaiting generation (or after it fails). An emoji, canonical
   * registry key, `symbol:ID`, or `face:ID`. The server validates that
   * any SUGGESTION whose primary key is `generate:` carries a non-empty
   * fallback before reaching the wire — SUGGESTIONs without one are
   * rejected and surfaced as an error in the tool response.
   */
  fallback?: string;
}

export interface ConstructionSuggestionsWire {
  targetSlot: number;
  /** HEAD-SYMBOL SUGGESTIONs for the next GLYPH (main AI strip). */
  headCandidates: ConstructionCandidateWire[];
  /** MODIFIER-SYMBOL SUGGESTIONs for the current HEAD SYMBOL. */
  modifierCandidates: ConstructionCandidateWire[];
  /**
   * @deprecated Legacy alias for `headCandidates`. Kept on the wire so
   * older clients keep rendering heads correctly; new code reads
   * `headCandidates` directly.
   */
  candidates: ConstructionCandidateWire[];
}

/**
 * Notification that an AI-generated construction key has its symbol image
 * ready (or freshly generated). The client patches any AI-strip candidate
 * whose `key` matches `imageKey`. Independent of the per-board `symbol_update`
 * which is keyed by label and uses internal `__SYMBOL__:id` paths.
 */
export interface ConstructionSymbolReadyWire {
  imageKey: string;
  symbolPath: string;
}

/** AI's memory-driven mode chips for one category tab. */
export interface ConstructionMemoryChipsWire {
  category: "who" | "do" | "what" | "where" | "when";
  chips: Array<{ key: string; label: string }>;
}

/** Public wire format for an identified face (server → client). */
export interface IdentifiedFaceWire {
  /** Index of the face within the descriptor batch (matches client face index when available). */
  faceIndex: number;
  /** True if matched to a known person above the confidence threshold. */
  matched: boolean;
  /** Display name — known person's name, or "Unknown #N" when no match. */
  name: string;
  /** Underlying entity type when matched. */
  entityType?: "student" | "user" | "contact";
  /** Entity id (contact id, user id, or student id) when matched. */
  entityId?: string;
  /** Relationship label (e.g. "mother", "teacher") when matched. */
  relationship?: string;
  /** Match confidence in [0,1]. 0 when unmatched. */
  confidence: number;
  /** Bounding box from the client detection, if provided. */
  boundingBox?: { x: number; y: number; w: number; h: number };
  /** Which camera saw this face — "user" = facing the user (gesture-tracked), "environment" = elsewhere. */
  cameraRole?: "user" | "environment" | "unknown";
  /** Human-readable camera label (for debug). */
  cameraLabel?: string;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type RelayState =
  | "initializing"     // handleInitialize is running
  | "idle"             // ready for input
  | "awaiting_turn"    // sent a turnComplete=true, waiting for model to start responding
  | "in_turn"          // model is making tool calls (between first tool call and TURN_COMPLETE)
  | "processing_turn"  // processTurnEnd is running (TTS, persistence, etc.)
  | "closed";          // session ended

// ---------------------------------------------------------------------------
// LiveRelay — one instance per client WebSocket connection
// ---------------------------------------------------------------------------

export class LiveRelay {
  // Core state
  private state: RelayState = "initializing";
  private ws: WebSocket;
  private provider: LiveProvider | null = null;

  // Session
  private studentId: string | null = null;
  private userId: string | undefined = undefined;
  private sessionId: string | null = null;
  private sessionCache: SessionCache | null = null;
  private muteState: AACMuteState = "unmuted";
  private responseMode: AACResponseMode = "fast";
  private paused = false;
  private debugMode = false;
  /** Client-reported IANA timezone for this session; injected into AI prompts. */
  private timezone: string | undefined = undefined;
  /** Last known sleep state for this session — set whenever client or AI reports a transition. */
  private lastSleepState: "hibernation" | "waking" | "awake" | "resting" | "asleep" = "awake";

  // Voice
  private aiVoice: ResolvedVoice | null = null;
  private studentVoice: ResolvedVoice | null = null;
  private studentTtsSession: GeminiLiveTtsSession | null = null;
  private useLocalTts = false;
  private useDirectAudio = false;

  // Provider/model in use for this session — set at connect() time and read
  // by the usage tracker so credit charges attribute to the right model.
  private currentLiveProvider: LLMProviderKey | null = null;
  private currentLiveModel: string | null = null;

  // Greeting
  private initialConnectionDone = false;
  private pendingGreeting: { prompt: string; frame?: string } | null = null;
  private hasGreeted = false;
  // Whether the AI has greeted within the current "interact window". Reset
  // on wake from hibernation so the AI greets again when re-entering interact
  // mode after the device was put to sleep.
  private hasGreetedInteract = false;
  // Defer the initial set_board(home) send to the client until the model is
  // actually ready (onReady fires). Otherwise the home board buttons appear
  // before the model can handle them and clicks get dropped or queued.
  private pendingHomeBoardSend = false;

  // Turn accumulation
  private turnAccum: TurnToolAccumulator = createEmptyAccumulator();

  // Contact enrollment
  private unknownFaceDescriptors: Array<{ descriptor: number[]; boundingBox?: { x: number; y: number; w: number; h: number } }> = [];

  // Server-side face recognition — populated when the client sends face descriptors.
  // Used both to inject "[PEOPLE PRESENT]" context into the model and to render the
  // identified-people debug list on the client.
  private currentIdentifiedFaces: IdentifiedFaceWire[] = [];
  private currentIdentifiedFacesAt = 0;
  /** Per-contact rate limit for `recordContactSighting()` — keyed by contact id. */
  private lastSightingBumpAt: Map<string, number> = new Map();
  /** TTL after which the identified-faces list is considered stale and dropped. */
  private static readonly IDENTIFIED_FACES_TTL_MS = 30_000;
  /** Minimum gap between sighting bumps for the same contact. */
  private static readonly SIGHTING_BUMP_INTERVAL_MS = 60_000;

  // App canvas
  private latestAppCanvas: string | null = null;

  // Board tracking
  private lastBoardUpdateTime = 0;
  /**
   * Snapshot of the main board's buttons after the most recent emission.
   * smartMergeButtons reads this on additive calls (add_buttons, and on
   * rebuild_board's error-recovery path) so it can:
   *   - reuse IDs for buttons that survive untouched (no remount, no
   *     fade-in animation),
   *   - pick low-cost displacement targets when the AI's incoming set
   *     would overflow the grid,
   *   - and surface a fade-out + fade-in transition in the same grid
   *     cell when one button is genuinely replaced by another.
   * rebuild_board normally REPLACES the board outright (the AI's
   * intent is "show this set, nothing else"), so the merge engine is
   * only invoked when the previous rebuild_board had validation
   * errors — in that case the AI's follow-up is treated as a fix and
   * gets merged with the surviving buttons from the partial board.
   * Reset on board unload (set_board, exit-app paths) so a fresh AAC
   * session never inherits stale slot identities.
   */
  private lastEmittedMainButtons: MergeButton[] = [];
  /**
   * Set whenever the most recent rebuild_board call dropped at least
   * one button via validateBoardButtons. The very next rebuild_board
   * call sees this flag, treats itself as an error fix, and uses the
   * smart-merge path (so the AI's correction adds to / refines the
   * partial board rather than wiping it). Reset back to false the
   * moment a rebuild_board completes — whether it actually invoked the
   * merge or not.
   */
  private rebuildBoardErrorRecoveryPending = false;

  // Symbol settings
  private symbolSettings = { generateSymbols: false, useApprovedSymbols: false, useUnapprovedSymbols: false };

  // Local storage
  private localStorageConfig: import("@shared/aac-local-storage").AacLocalStorageConfig | null = null;
  private pendingLocalState: import("@shared/aac-local-storage").AacSessionSnapshot | null = null;

  // Reconnection
  private reconnectAttempts = 0;
  private consecutiveSafetyBlocks = 0;
  private static readonly MAX_RECONNECT_BEFORE_RESET = 2;

  // Sleep-state session profile. "awake" = full prompt + tools + loose
  // compression; "resting" = lightweight prompt + 4-tool subset + tight
  // compression. Switched via switchSessionProfile() on a reconnect.
  private sessionProfile: "awake" | "resting" = "awake";
  private profileSwitchPending: "awake" | "resting" | null = null;
  private useVertexForLive = false;
  private geminiVoiceName: string | undefined;
  private awakeTools: import("./live-provider").LiveProviderConfig["tools"] | null = null;
  // Compression windows per profile (triggerTokens → targetTokens). Awake is
  // lower than the old 100k/50k so long sessions stop re-billing ~100k of
  // context every turn. Resting is tight — the lightweight prompt is small so
  // there's little structural floor to protect.
  private static readonly AWAKE_COMPRESSION_TRIGGER = 30_000;
  private static readonly AWAKE_COMPRESSION_TARGET = 15_000;
  private static readonly RESTING_COMPRESSION_TRIGGER = 12_000;
  private static readonly RESTING_COMPRESSION_TARGET = 6_000;

  // Rolling session summary. Produced by the monitor every N new conversation
  // messages and injected as a [SESSION SUMMARY] context message so it
  // survives compression. summaryInFlight guards against overlapping calls.
  private summaryInFlight = false;
  private static readonly SUMMARY_EVERY_N_MESSAGES = 20;

  // Timers
  private boardReminderTimer: ReturnType<typeof setInterval> | null = null;
  private behavioralReminderTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;

  // Timer intervals
  private static readonly BOARD_REMINDER_INTERVAL_MS = 45_000;
  private static readonly BEHAVIORAL_REMINDER_INTERVAL_MS = 180_000;
  private static readonly PING_INTERVAL_MS = 30_000;
  private static readonly SNAPSHOT_INTERVAL_MS = 30_000;

  // Default home board data (virtual — not stored in DB)
  private homeBoardData: import("@shared/schema").ParsedBoardData | null = null;

  // Context sidebar buttons (server-side tracking, last 4 visible)
  private contextButtonLabels: string[] = [];

  // Guessing mode tracking
  private guessingMode = false;

  // Pre-generated student TTS (for button presses)
  private preGenTtsPromise: Promise<void> | null = null;
  private studentTtsAbortController: AbortController | null = null;

  // Pending prompt — if the model produces an empty turn after a button press
  // or user message, we retry with this prompt (proactiveAudio can swallow
  // turns when audio-triggered generation coincides with our text message).
  private pendingRetryPrompt: string | null = null;

  // Direct audio buffering — chunks accumulate and flush every 250ms as WAV
  private directAudioChunks: string[] = [];
  private directAudioFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly AUDIO_FLUSH_INTERVAL_MS = 250;
  // Track when the last audio chunk arrived — visual checks are suppressed during active speech
  private lastAudioChunkAt = 0;
  private static readonly AUDIO_COOLDOWN_MS = 3000;

  // Silence keepalive — Gemini's native audio model expects a continuous stream.
  // When the client isn't sending PCM (e.g. mic not yet started, mic muted), we
  // send silent PCM to keep the model from hallucinating spontaneous turns.
  private lastClientPcmAt = 0;
  private silenceKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly SILENCE_KEEPALIVE_MS = 100;     // ~100ms chunks
  private static readonly CLIENT_PCM_TIMEOUT_MS = 200;    // send silence if no client PCM for 200ms
  // 100ms of silent 16kHz mono Int16 PCM = 1600 samples * 2 bytes = 3200 bytes (zeroed)
  private static readonly SILENCE_PCM_BASE64 = Buffer.alloc(3200).toString("base64");

  // Pending queue for client messages received while the AI is generating.
  // Without this queue, button presses during in_turn/processing_turn states are
  // silently dropped, causing buttons to "fail" while the AI is responding.
  private pendingClientMessages: ClientMessage[] = [];

  // When true, the next model turn is a debug introspection response — the
  // model is telling us, in plain text, what it just tried to do (after a
  // MALFORMED_FUNCTION_CALL). We capture the text into debugResponseBuffer
  // and don't forward audio to the client.
  private awaitingDebugResponse = false;
  private debugResponseBuffer = "";
  // Number of times we've asked the model to retry after an abnormal turn.
  private debugRetryCount = 0;
  private static readonly DEBUG_MAX_RETRIES = 2;
  // Cooldown after RESPONSE_REJECTED exhaustion — prevents frame_grid from
  // immediately re-triggering and causing the model to repeat the same
  // rejected content in a tight loop.
  private rejectionCooldownUntil = 0;
  private static readonly REJECTION_COOLDOWN_MS = 15_000;

  // Set when we've just sent an auto-continuation prompt (because the model
  // transcribed the user but produced no audio). Cleared when the next
  // turn completes — bounds the auto-continuation to one retry per silent
  // transcript so the model can't loop on it.
  private autoContinuationPending = false;

  // Set whenever a button press is sent to the model, cleared on the next
  // handleTurnComplete. Auto-continuation uses this as a trigger condition:
  // if the model received a button press and produced no audio, we nudge it
  // once to actually speak.
  private lastTurnHadButtonPress = false;

  // Same pattern for the [GREET] system-injected user message that fires on
  // first interact-mode entry. Without this, the model frequently satisfies the
  // greet by stuffing text into rebuild_board.response with no native audio,
  // and the no-trigger AUTO_CONTINUATION path skips it.
  //
  // Subtle: we send GREET from inside handleSingleToolCall(set_interaction_mode),
  // so the very next TURN_COMPLETE is the close of that tool turn (no audio,
  // empty turnAccum), NOT the model's response to the greet. handleTurnComplete
  // therefore only consumes lastTurnHadGreet when the turn shows real content
  // (rebuildBoardIntendedSpeech / transcript / audio); a pure tool-ack turn
  // leaves the flag set so the actual response turn can trigger nudge logic.
  private lastTurnHadGreet = false;
  // Persists across auto-continuation so hasGreetedInteract finally latches
  // when audio eventually arrives (the auto-continuation turn isn't itself a
  // "greet turn" anymore but we still want to mark the greet as completed).
  private greetAudioPending = false;

  // The authenticated user driving this WebSocket. Established at upgrade time
  // by setupLiveWebSocket; trusted as the source of truth for userId. Any
  // userId in the client's `initialize` message is ignored.
  private readonly authedUser: User;

  constructor(ws: WebSocket, authedUser: User) {
    this.ws = ws;
    this.authedUser = authedUser;

    ws.on("message", (raw) => {
      const handle = () => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString());
          // Log every incoming client message — truncate only base64 audio/image strings, keep objects intact
          logLiveSession("CLIENT → SERVER", `state=${this.state} ${stringifyMsg(msg)}`);
          this.handleClientMessage(msg);
        } catch (err) {
          console.error("[LiveRelay] Invalid client message:", err);
        }
      };
      // Bind logger context to this session so DB persistence routes to the
      // right row. For the very first message (initialize) sessionId is null,
      // so DB writes start once initialize sets it (see handleClientMessage).
      if (this.sessionId) {
        runInSessionContext(this.sessionId, this.debugMode, handle);
      } else {
        handle();
      }
    });

    ws.on("close", () => {
      console.log("[LiveRelay] Client disconnected");
      this.cleanup();
    });

    ws.on("error", (err) => {
      console.error("[LiveRelay] WebSocket error:", err);
      this.cleanup();
    });

    ws.on("pong", () => {
      this.pongReceived = true;
    });

    this.startPingTimer();
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  private setState(newState: RelayState): void {
    const prev = this.state;
    logLiveSession("STATE", `${prev} -> ${newState}`);
    this.state = newState;
    // When state transitions to idle, drain any queued client messages.
    // Process them on the next tick so the current call stack unwinds first.
    if (newState === "idle" && prev !== "idle" && this.pendingClientMessages.length > 0) {
      setImmediate(() => this.drainPendingMessages());
    }
    // Apply a deferred sleep-state profile switch now that we're idle. The
    // switch reconnects the provider, so run it after the call stack unwinds.
    if (newState === "idle" && prev !== "idle"
        && this.profileSwitchPending && this.profileSwitchPending !== this.sessionProfile) {
      const target = this.profileSwitchPending;
      this.profileSwitchPending = null;
      setImmediate(() => {
        this.switchSessionProfile(target).catch(err =>
          logLiveSession("PROFILE_SWITCH_ERROR", `deferred ${target}: ${(err as Error).message}`));
      });
    }
    // Roll the session summary forward when enough new turns have landed.
    // Fire-and-forget; runs after the stack unwinds so it never blocks the
    // turn from finishing.
    if (newState === "idle" && prev !== "idle") {
      setImmediate(() => this.maybeProduceSessionSummary());
    }
  }

  private drainPendingMessages(): void {
    if (this.pendingClientMessages.length === 0) return;
    if (this.state !== "idle" && this.state !== "awaiting_turn") return;
    const next = this.pendingClientMessages.shift()!;
    logLiveSession("DRAIN queued", `type=${next.type} remaining=${this.pendingClientMessages.length}`);
    this.handleClientMessage(next);
  }

  // Client-initiated interrupt is implemented at the provider level: when the
  // relay state is non-idle, handleButtonPress / board_exit dispatches via
  // `provider.sendMessage(..., { interrupt: true })`, which routes through
  // `sendClientContent` (the documented interrupt mechanism on Live API).
  // Gemini stops the in-flight turn, sends `interrupted=true`, and our
  // existing `onInterrupted` → `handleInterrupted` cleans up state, audio
  // buffer, and tells the client to stop playback. We do NOT pre-emptively
  // mutate server state — letting the model gracefully process the interrupt
  // avoids confusing it (e.g. unloading the board while tokens are still
  // streaming).

  // -------------------------------------------------------------------------
  // Provider callbacks
  // -------------------------------------------------------------------------

  private buildProviderCallbacks(): LiveProviderCallbacks {
    return {
      onText: (text) => {
        // Stray text — log only (real output comes through tool calls)
        if (text.trim()) {
          logDualAgent("LiveRelay.strayText", { sessionId: this.sessionId, text: text.substring(0, 200) });
        }
      },

      onTurnComplete: (reason?: string) => {
        this.handleTurnComplete(reason).catch(err => {
          console.error("[LiveRelay] handleTurnComplete error:", err);
        });
      },

      onInterrupted: () => {
        this.handleInterrupted();
      },

      onToolCall: (calls) => {
        this.handleToolCalls(calls).catch(err => {
          console.error("[LiveRelay] handleToolCalls error:", err);
        });
      },

      onToolCallCancellation: (ids) => {
        console.log(`[LiveRelay] Tool call cancellation for ids: ${ids.join(", ")}`);
      },

      onAudioData: (data) => {
        // During debug introspection, let audio generate (so the model doesn't
        // get RESPONSE_REJECTED for modality violations) but don't forward it.
        if (this.awaitingDebugResponse) return;
        if (this.useDirectAudio) {
          this.directAudioChunks.push(data.data);
          this.hasGreeted = true;
          this.lastAudioChunkAt = Date.now();
          logLiveSession("GEMINI → audioChunk", `state=${this.state} chunkLength=${data.data.length} totalChunks=${this.directAudioChunks.length}`);
          // Schedule a flush — accumulate chunks for smoother playback
          if (!this.directAudioFlushTimer) {
            this.directAudioFlushTimer = setTimeout(() => {
              this.flushDirectAudio();
            }, LiveRelay.AUDIO_FLUSH_INTERVAL_MS);
          }
        }
      },

      onOutputTranscription: (text) => {
        logLiveSession("GEMINI → outputTranscription", `state=${this.state} text="${text}"`);
        // Capture into debug buffer instead of forwarding when introspecting
        if (this.awaitingDebugResponse) {
          if (text.trim()) this.debugResponseBuffer += text;
          return;
        }
        if (this.useDirectAudio && text.trim()) {
          this.turnAccum.speakText += (this.turnAccum.speakText ? " " : "") + text.trim();
          this.send({ type: "text", data: text, noAudioClear: true });
        }
      },

      onUsage: (usage) => {
        if (this.debugMode) {
          this.send({ type: "debug", data: { usage } });
        }
        // Track credits per turn. Fire-and-forget — failures are logged
        // inside the service and must not interrupt the live session.
        const state = this.sessionCache?.state;
        if (state && this.currentLiveProvider && this.currentLiveModel) {
          dualAgentService
            .trackLiveUsage(
              state.sessionId,
              state.studentId,
              state.userId,
              this.currentLiveProvider,
              this.currentLiveModel,
              usage,
            )
            .catch(err => console.error("[LiveRelay] trackLiveUsage failed:", err));
        }
      },

      onGoAway: () => {
        console.log("[LiveRelay] Provider session goAway — reconnecting");
      },

      onReady: () => {
        console.log("[LiveRelay] Provider session ready");
        this.reconnectAttempts = 0;

        // Start silence keepalive — Gemini's native audio model expects a continuous
        // input stream, and hallucinates spontaneous turns when it gets nothing.
        if (this.useDirectAudio) {
          this.startSilenceKeepalive();
        }

        if (!this.initialConnectionDone) {
          // Initial connection — now tell the client we're ready
          this.initialConnectionDone = true;
          logLiveSession("ON_READY (initial)", `Sending greeting prompt, timestamp=${Date.now()}`);
          this.send({ type: "initialized", sessionId: this.sessionCache?.state?.sessionId || "" });
          this.sendSessionSnapshot();
          // Now that the model is connected and ready, send the home board.
          // The set_board for home was deferred during handleInitialize so the
          // user wouldn't see clickable buttons before the model could handle them.
          this.flushPendingHomeBoardSend();

          if (this.pendingGreeting && this.provider) {
            this.setState("awaiting_turn");
            logLiveSession("GREETING PROMPT", this.pendingGreeting.prompt);
            const greetingPrompt = this.pendingGreeting.prompt;
            if (this.pendingGreeting.frame) {
              this.provider.sendFrameWithPrompt(this.pendingGreeting.frame, greetingPrompt);
            } else {
              this.provider.sendMessage(greetingPrompt, "user");
            }
            this.pendingGreeting = null;
            // Mark the greeting as delivered immediately. Without this, a fast
            // disconnect (e.g. Gemini 1008 in the first second) leaves
            // hasGreeted=false, and onReady's reconnect branch then re-sends
            // the "session start" framing — making the model greet/reset on
            // every recovery. Also persist the prompt to pendingMessages so
            // loadHistoryForReconnect restores it after forceNewSession.
            this.hasGreeted = true;
            if (this.sessionId) {
              dualAgentService
                .addPendingMessage(this.sessionId, {
                  role: "user",
                  content: greetingPrompt,
                  timestamp: Date.now(),
                })
                .catch(err => console.error("[LiveRelay] Failed to persist greeting prompt:", err));
            }
          } else {
            this.setState("idle");
          }
          return;
        }

        // Reconnection
        logLiveSession("ON_READY (reconnect)", `hasGreeted=${this.hasGreeted}`);
        this.send({ type: "reconnected" });
        // Flush the deferred home board send on reconnect too — handleInitialize
        // ran again and set pendingHomeBoardSend. This matches the pre-defer
        // behavior of always loading the home board on reconnect.
        this.flushPendingHomeBoardSend();

        if (!this.hasGreeted) {
          // MUTED: re-trigger initial board build. UNMUTED: stay silent and
          // wait for the next frame_grid — sending an empty-context "observe
          // and call set_interaction_mode" prompt here would reproduce the
          // MALFORMED_FUNCTION_CALL + 15s heartbeat-wait gap on every
          // reconnect (same root cause as the initial-connection skip above).
          if (this.muteState === "muted") {
            console.log("[LiveRelay] Reconnected before greeting (muted) — re-prompting board build");
            this.setState("awaiting_turn");
            this.provider!.sendMessage(
              `Generate 4-12 contextual ${T.button}s using rebuild_board().`,
              "user",
            );
          } else {
            console.log("[LiveRelay] Reconnected before greeting (unmuted) — staying idle until first frame_grid");
            this.setState("idle");
          }
        } else {
          this.injectReconnectionContext();
          this.setState("idle");
        }
      },

      onReconnecting: () => {
        if (this.provider?.lastCloseWasSafety) {
          this.handleSafetyBlock();
          this.send({ type: "reconnecting", data: "error:RECONNECTING" });
          return;
        }

        this.reconnectAttempts++;
        console.log(`[LiveRelay] Reconnecting (attempt ${this.reconnectAttempts})...`);
        this.send({ type: "reconnecting", data: "error:RECONNECTING" });

        if (this.reconnectAttempts >= LiveRelay.MAX_RECONNECT_BEFORE_RESET && this.sessionId) {
          console.log("[LiveRelay] Too many reconnect attempts — creating new session");
          this.forceNewSession().catch(err => {
            console.error("[LiveRelay] Force new session failed:", err);
          });
        }
      },

      onError: (error) => {
        console.error("[LiveRelay] Provider error:", error.message);
        if (this.provider?.lastCloseWasRateLimit || /resource.exhausted|rate.limit|quota|too many requests|overloaded/i.test(error.message)) {
          this.send({ type: "rate_limited", data: "error:RATE_LIMITED" });
        } else if (this.provider?.lastCloseWasSafety || /policy.violation|unsafe|blocked|safety/i.test(error.message)) {
          // Safety errors are handled by onReconnecting -> handleSafetyBlock
        } else {
          this.send({ type: "error", data: "error:CONNECTION_ERROR" });
        }
      },

      onClose: (code, reason) => {
        console.log(`[LiveRelay] Provider session closed: code=${code} reason=${reason}`);
        logLiveSession("CONNECTION CLOSED", `code=${code} reason=${reason || "(none)"}`);
        if (this.provider?.lastCloseWasRateLimit) {
          this.send({ type: "rate_limited", data: "error:RATE_LIMITED" });
          return;
        }
        if (this.provider?.lastCloseWasSafety) {
          return;
        }
        if (code && code !== 1000) {
          this.send({ type: "error", data: "error:CONNECTION_CLOSED" });
        }
      },

      onReconnectFailed: async () => {
        if (!this.sessionId || !this.provider) return;
        console.log("[LiveRelay] Reconnect failed — reloading history from DB");
        try {
          const excludeSafety = this.consecutiveSafetyBlocks > 0;
          const turns = await dualAgentService.loadHistoryForReconnect(this.sessionId, excludeSafety);
          if (turns.length > 0) {
            this.provider.sendConversationHistory(turns);
            console.log(`[LiveRelay] Sent ${turns.length} history turns to fresh session (excludeSafety=${excludeSafety})`);
          }
        } catch (err) {
          console.error("[LiveRelay] History reload failed:", err);
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Client message handling
  // -------------------------------------------------------------------------

  private async handleClientMessage(msg: ClientMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "initialize":
          await this.handleInitialize(msg);
          break;

        case "frame_grid": {
          if (this.paused) break;
          // PROACTIVITY EXPERIMENT (2026-04-12) — REVERTIBLE.
          //
          // The client already runs motion detection and only emits a frame_grid
          // when something visually interesting happens (the timestamps[] array
          // is a burst of frames around the event). So each frame_grid IS an
          // event the model should get a chance to react to.
          //
          // While idle, deliver the frame via sendFrameWithPrompt
          // (sendClientContent + turnComplete=true) so the model gets an actual
          // turn opportunity. The "[scene update] ... stay silent unless..."
          // prompt + proactiveAudio:true is what keeps the model from speaking
          // on every tick — it can choose to call tools (add_context_button,
          // update_context, save transcripts, etc.) and end the turn silently.
          //
          // While in_turn / processing_turn / awaiting_turn, just drop the
          // frame. The model already has visual context from earlier in the
          // turn, and the next frame_grid after we return to idle will pick up
          // any new motion.
          //
          // ⚠️ TO REVERT: replace the whole branch with the prior fire-and-
          // forget version using `this.provider!.sendFrame(msg.data, false)`
          // (and the same for latestAppCanvas). We're switching off that path
          // because (a) it never gave the model a chance to act and (b) the
          // memory note about visual responsiveness suggested sendRealtimeInput
          // .video might be slowing visual updates anyway.
          if (this.state !== "idle") {
            logLiveSession("FRAME_GRID DROPPED", `state=${this.state}`);
            break;
          }
          if (Date.now() < this.rejectionCooldownUntil) {
            logLiveSession("FRAME_GRID DROPPED", `rejection cooldown (${this.rejectionCooldownUntil - Date.now()}ms remaining)`);
            break;
          }
          this.setState("awaiting_turn");
          const extraImages = this.latestAppCanvas
            ? [{ data: this.latestAppCanvas, mimeType: "image/jpeg", label: "[app canvas]" }]
            : undefined;
          const gestureNote = msg.gestureContext
            ? `\n${msg.gestureContext}`
            : "";
          const peopleContext = this.buildPeoplePresentContext();
          const peopleNote = peopleContext ? `\n${peopleContext}` : "";
          // Sleep system: wake-from-Asleep gets a different prompt that asks
          // the AI to evaluate whether the wake was a real re-engagement or a
          // false alarm (in which case it should call report_false_wake).
          const isWakeCheck = msg.triggerReason === "wake_check";
          const prompt = isWakeCheck
            ? `[wake check] Session woken. Respond naturally if the user is engaging with you.${peopleNote}${gestureNote}`
            : `[scene update] React if something here calls for action.${peopleNote}${gestureNote}`;
          this.provider!.sendFrameWithPrompt(msg.data, prompt, extraImages);
          break;
        }

        case "pcm_audio": {
          // PCM audio ALWAYS flows — never gated by state.
          // Don't remove this, the model is designed to ignore echoes so this shouldn't be the cause of bugs.
          if (this.paused) break;
          this.lastClientPcmAt = Date.now();
          this.provider!.sendAudio(msg.data);
          break;
        }

        case "audio_clip":
          // No-op: Gemini already hears audio via continuous PCM streaming
          break;

        case "focus_frame": {
          // High-resolution single frame requested by AI for detailed analysis
          this.setState("awaiting_turn");
          this.provider!.sendFrameWithPrompt(
            msg.data,
            `[FOCUS FRAME] This is a HIGH-RESOLUTION single frame captured at your request. Analyze the image carefully for fine details, text, labels, faces, or objects you couldn't identify before. Update the board if needed.`,
          );
          console.log("[LiveRelay] Focus frame sent to Gemini");
          break;
        }

        case "user_message": {
          if (this.paused) break;
          if (this.state !== "idle" && this.state !== "awaiting_turn") {
            logLiveSession("QUEUED user_message", `state=${this.state} text="${msg.text.substring(0, 60)}"`);
            this.pendingClientMessages.push(msg);
            break;
          }
          this.setState("awaiting_turn");

          // Record user message in session state for monitor context + persist to DB
          if (this.sessionId) {
            dualAgentService.addPendingMessage(this.sessionId, {
              role: "user",
              content: msg.text,
              timestamp: Date.now(),
            }).catch(err => console.error("[LiveRelay] Failed to persist user message:", err));
          }
          // Track for retry in case proactiveAudio swallows the turn
          this.pendingRetryPrompt = msg.text;
          this.provider!.sendMessage(msg.text, "user");
          logDualAgent("LiveRelay.userMessage", {
            sessionId: this.sessionId,
            text: msg.text.substring(0, 80),
            textLength: msg.text.length,
          });
          break;
        }

        case "voice_audio":
          // No-op: Gemini already hears audio via continuous PCM streaming
          break;

        case "button_press": {
          if (this.paused) break;
          // Drop presses received before the model is ready. The client gates
          // the home board on the deferred set_board send, so this should be
          // rare — but if a press still slips through (cached board, race),
          // dropping is safer than queuing because the queued press would fire
          // immediately on init and surprise the user.
          if (this.state === "initializing" || this.state === "closed") {
            logLiveSession("BTN_DROPPED (not ready)", `state=${this.state} buttons=[${msg.buttons.join(", ")}]`);
            break;
          }
          // Out-of-turn press → flag the dispatch as an interrupt. The
          // provider will route via sendClientContent (the documented
          // interrupt path) instead of sendRealtimeInput. Don't touch
          // server-side state — let Gemini's `interrupted` signal trigger
          // the existing onInterrupted → handleInterrupted cleanup.
          const isInterrupt = this.state !== "idle";
          this.setState("awaiting_turn");
          this.handleButtonPress(msg.buttons, msg.sentences, msg.board, isInterrupt);
          break;
        }

        case "board_exit": {
          // Exit button pressed on loaded board — client sends the action directly
          if (this.paused) break;
          if (this.state === "initializing" || this.state === "closed") {
            logLiveSession("BTN_DROPPED (not ready)", `state=${this.state} label="${msg.label}"`);
            break;
          }
          // Out-of-turn exit → mark this dispatch as an interrupt (used below
          // when calling provider.sendMessage). Don't pre-emptively touch state.
          const exitIsInterrupt = this.state !== "idle";

          // Detect Home button press — server loads the home board directly
          // (no AI tool call required) to avoid the rebuild_board side-panel
          // truncation loop. The AI is informed via context injection.
          const isHomePress = msg.label === "Home" ||
            (msg.instruction && /set_board\(["']home["']\)|load.*home board/i.test(msg.instruction));

          if (isHomePress) {
            this.loadHomeBoardInternal();
            if (this.sessionId) {
              dualAgentService.addPendingMessage(this.sessionId, {
                role: "user",
                content: `${T.tagPress} Home`,
                timestamp: Date.now(),
              }).catch(console.error);
            }
            this.provider!.sendContextInjection(
              `[CONTEXT] The user pressed Home. The home ${T.board} is now loaded with its native navigation ${T.button}s. Wait for them to press one before changing the board.`
            );
            break;
          }

          this.setState("awaiting_turn");

          const exitState = this.sessionCache?.state;
          if (exitState) {
            exitState.loadedBoardId = null;
            exitState.loadedBoardData = undefined;
            exitState.currentPageId = null;
            exitState.pageHistory = [];
            exitState.aiAddedButtonLabels = [];
            exitState.boardButtonLabels = [];
            exitState.maxBoardItems = 12;
          }
          this.send({ type: "unload_board", data: {} });

          // Detect guessing mode
          if (msg.instruction.includes("[GUESSING MODE]") && !this.guessingMode) {
            this.guessingMode = true;
            this.send({ type: "guessing_mode", active: true });
            logLiveSession("GUESSING_MODE", "Entered via board exit button");
          }

          if (this.sessionId) {
            dualAgentService.addPendingMessage(this.sessionId, {
              role: "user",
              content: `${T.tagPress} ${msg.label}`,
              timestamp: Date.now(),
            }).catch(console.error);
          }

          // Home-menu button press: chat-style framing matching the
          // dynamic-button path. The press is presented as the user
          // saying the label; the board-defined intent text is appended
          // as parenthetical guidance for context.
          const exitInstruction = msg.instruction
            ? `${T.tagPress} ${msg.label}\n\n(${msg.instruction})`
            : `${T.tagPress} ${msg.label}`;
          this.lastTurnHadButtonPress = true;
          this.provider!.sendMessage(exitInstruction, "user", true, { interrupt: exitIsInterrupt });
          break;
        }

        case "gesture_context":
          this.provider!.sendContextInjection(`[GESTURE CONTEXT]\n${msg.data}`);
          break;

        case "person_context":
          this.provider!.sendContextInjection(`[PERSON IDENTIFIED]\n${JSON.stringify(msg.data)}`);
          break;

        case "board_state": {
          // Update server-side board label tracking from client-reported state
          const bsState = this.sessionCache?.state;
          if (bsState && msg.data?.pages?.[0]?.buttons) {
            const maxSlots = bsState.maxBoardItems || 12;
            bsState.boardButtonLabels = msg.data.pages[0].buttons
              .slice(0, maxSlots)
              .map((b: { label?: string }) => b.label || "")
              .filter((l: string) => l);
          }
          this.lastBoardUpdateTime = Date.now();
          // Board state is a control signal — the AI references existing
          // button labels via add_buttons / rebuild_board / press_button.
          // Wrapping it would force the model to treat its own working set
          // as untrusted, breaking those tools.
          this.provider!.sendContextInjection(`[CURRENT BOARD STATE]\n${JSON.stringify(msg.data)}`);
          break;
        }

        case "set_mute_state": {
          this.muteState = msg.muteState;
          // Rebuild the interactive system prompt for the new mode and inject
          // it as a strong override. The Live API doesn't support changing
          // systemInstruction mid-session, so we re-deliver the mode rules as
          // a high-authority context injection.
          const state = this.sessionCache?.state;
          const student = this.sessionCache?.monitorAgent?.getStudent?.();
          if (state && student) {
            const rawPersona = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
            const sections = state.enhancedSections;
            const persona = sections?.persona || rawPersona;
            const computeAge = (bd: string | null | undefined) => {
              if (!bd) return undefined;
              const age = Math.floor((Date.now() - new Date(bd).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
              return age > 0 ? String(age) : undefined;
            };
            state.interactivePrompt = buildInteractiveAgentPrompt({
              studentName: student.name,
              persona,
              language: student.primaryLanguage || undefined,
              memoryContext: state.memoryContext,
              muteState: this.muteState,
              studentAge: computeAge(student.birthDate),
              studentGender: student.gender || undefined,
              studentDiagnosis: state.cachedDiagnosis || undefined,
              aiName: student.aacSettings?.aiName || undefined,
              knownContacts: state.cachedContacts?.length ? state.cachedContacts : undefined,
              availableBoards: state.availableBoards?.length ? state.availableBoards : undefined,
              cachedSymbols: state.cachedSymbols?.length ? state.cachedSymbols : undefined,
              enabledApps: APP_REGISTRY.filter(a => state.appState.enabledApps.includes(a.id)).map(a => ({ id: a.id, name: a.name, description: a.description })),
              permittedWebsites: state.permittedWebsites.length > 0 ? state.permittedWebsites : undefined,
              permittedYoutubeChannels: state.permittedYoutubeChannels.length > 0 ? state.permittedYoutubeChannels : undefined,
              permittedYoutubeVideos: state.permittedYoutubeVideos.length > 0 ? state.permittedYoutubeVideos : undefined,
              autoSymbolsEnabled: !!(student.aacSettings?.generateSymbols || student.aacSettings?.useApprovedSymbols || student.aacSettings?.useUnapprovedSymbols),
              useDirectAudio: this.useDirectAudio,
              sessionGoals: sections?.sessionGoals,
              personaGestureOverrides: sections?.gestureOverrides,
              interactModeExamples: sections?.interactModeExamples,
              assistModeExamples: sections?.assistModeExamples,
              sentenceInterpretationExamples: sections?.sentenceInterpretationExamples,
              safetyNotes: sections?.safetyNotes,
              sessionSummary: state.sessionSummary,
            });
          }
          const override = msg.muteState === "muted"
            ? `[MUTE CHANGE] The user has MUTED you. Effective immediately and until the user unmutes by tapping the cave: do NOT call speak(). Do NOT talk to the user. Switch to producing ${T.button}s via rebuild_board() so the user can speak through them. You cannot unmute yourself.`
            : `[MUTE CHANGE] The user has UNMUTED you. You may now speak() directly with the user again. Greet them.`;
          // sendMessage (turnComplete=true) so the model actually reacts now —
          // muted: switch to utterance-button mode immediately;
          // unmuted: produce the greeting instead of stalling until the next frame.
          this.provider!.sendMessage(override, "user");
          break;
        }

        case "set_response_mode":
          this.responseMode = msg.mode;
          break;

        case "unknown_face_descriptors":
          this.unknownFaceDescriptors = msg.data;
          // Fire-and-forget: match each descriptor against the user's known
          // people (self + linked users + contacts). Results populate
          // currentIdentifiedFaces, get pushed to the client for the debug
          // display, and feed the next frame_grid context string.
          this.recognizeFaces(msg.data).catch(err => {
            logLiveSession("FACE_RECOGNITION_ERROR", (err as Error).message);
          });
          break;

        case "page_navigate":
          this.provider!.sendContextInjection(
            `[PAGE NAVIGATE] User navigated to page "${msg.pageName}". Current buttons: ${msg.buttons.join(", ")}`,
          );
          if (this.sessionCache?.state) {
            this.sessionCache.state.currentPageId = msg.pageId;
          }
          break;

        case "app_canvas":
          this.latestAppCanvas = msg.data;
          break;

        case "set_paused":
          this.paused = msg.paused;
          if (msg.paused) {
            this.provider!.sendContextInjection(
              `[SYSTEM] Session PAUSED by caretaker. The user cannot see or interact with the device. Do NOT speak, update the board, or respond to any input until resumed. Ignore all silence or lack of activity — this is expected.`,
            );
            logLiveSession("SESSION_PAUSED", `sessionId=${this.sessionId}`);
          } else {
            this.provider!.sendContextInjection(
              `[SYSTEM] Session RESUMED. The user can see and interact with the device again. Continue normally.`,
            );
            logLiveSession("SESSION_RESUMED", `sessionId=${this.sessionId}`);
          }
          break;

        case "app_dismissed": {
          this.latestAppCanvas = null;
          if (this.state !== "idle" && this.state !== "awaiting_turn") {
            logLiveSession("QUEUED app_dismissed", `state=${this.state} appId="${msg.appId}"`);
            this.pendingClientMessages.push(msg);
            break;
          }
          this.setState("awaiting_turn");
          this.provider!.sendMessage(
            `[APP CLOSED] The user closed the "${msg.appId}" app and returned to the ${T.board}. The full ${T.board} is now restored (up to 12 ${T.button}s). Comment briefly on what they were doing in the app, then use rebuild_board() to create a fresh ${T.board} of ${T.button}s for the current context.`,
            "user",
          );
          logDualAgent("LiveRelay.appDismissed", { sessionId: this.sessionId, appId: msg.appId });
          break;
        }

        case "local_state":
          this.pendingLocalState = msg.snapshot;
          break;

        case "context_injection":
          if (this.provider) {
            this.provider.sendContextInjection(msg.text);
            logDualAgent("LiveRelay.contextInjection", {
              sessionId: this.sessionId,
              text: msg.text.substring(0, 80),
            });
          }
          break;

        case "glyph_press": {
          // Student played a glyph from the sentence builder. Hand the raw
          // glyph to the AI and ask it to call interpret() with the
          // natural-language meaning — the AI is the only piece that has
          // the conversation context + student-interest awareness needed
          // to turn an approximate glyph like `i_me.my+say(food)` into
          // "I want to say something about food."
          //
          // We deliberately do NOT TTS the glyph string here. The
          // interpret() tool handler streams student TTS once the AI has
          // produced its interpretation.
          const glyphString = msg.glyph?.trim() || "";
          if (!glyphString) {
            logLiveSession("SENTENCE_COMPOSED_EMPTY", "ignoring blank glyph_press");
            break;
          }
          if (this.state === "initializing" || this.state === "closed") {
            logLiveSession("SENTENCE_COMPOSED_DROPPED", `state=${this.state} glyph="${glyphString}"`);
            break;
          }
          if (!this.provider) {
            logLiveSession("SENTENCE_COMPOSED_DROPPED", `no provider — glyph="${glyphString}"`);
            break;
          }
          // Persist the raw glyph press in the session log so the next
          // assistant response is anchored to it.
          if (this.sessionId) {
            dualAgentService.addPendingMessage(this.sessionId, {
              role: "user",
              content: `${T.tagComposed} ${glyphString}`,
              timestamp: Date.now(),
            }).catch(err => console.error("[LiveRelay] Failed to persist glyph press:", err));
          }
          const wasIdle = this.state === "idle";
          this.setState("awaiting_turn");
          const prompt = `${T.tagComposed} ${glyphString}
The user composed this SENTENCE in the ${T.builder} and pressed Play. It is YOUR job to put words in their mouth: interpret the SENTENCE (see <sentence_interpretation>) and call the \`interpret\` tool with the natural-language SENTENCE — first-person, as the user would say it. The tool voices that SENTENCE in the user's TTS voice and records it as their turn; you then respond normally (speak + rebuild_board, subject to mode rules).`;
          logLiveSession("SENTENCE_COMPOSED_IN", `glyph="${glyphString}" wasIdle=${wasIdle}`);
          this.provider.sendMessage(prompt, "user", true, { interrupt: !wasIdle });
          break;
        }

        case "construction_state": {
          // Pull current dynamic-board labels off the session state so the
          // injection carries the conversation topic the user just pivoted
          // away from — see formatConstructionStateInjection.
          const sessionState = this.sessionCache?.state;
          const boardLabels = sessionState?.boardButtonLabels ?? [];
          logLiveSession("CONSTRUCTION_STATE_IN",
            `cat=${msg.data.category} target=${msg.data.targetSlot} glyph="${msg.data.glyph}" exclude=${msg.data.excludeKeys.length} payload=${msg.data.payloadTarget?.hostKey ?? "-"} boardLabels=${boardLabels.length} hasProvider=${!!this.provider}`);
          if (this.provider) {
            const text = formatConstructionStateInjection(msg.data, boardLabels);
            // Use sendMessage (turnComplete=true) so the model actually
            // responds with a tool call. sendContextInjection uses
            // turnComplete=false, which would inject the state silently
            // and never trigger suggest_construction_buttons.
            this.provider.sendMessage(text, "user", true);
            logLiveSession("CONSTRUCTION_STATE_SENT", `text="${text.replace(/\n/g, " | ")}"`);
          } else {
            logLiveSession("CONSTRUCTION_STATE_DROPPED", "no provider — message ignored");
          }
          break;
        }

        case "client_sleep_state_change":
          this.recordSleepStateChange(msg.state, msg.source);
          // Map the client sleep-state machine onto the server session profile
          // (prompt/tools/compression). resting + asleep → lightweight resting
          // profile; awake + waking → full profile. hibernation closes the
          // session via its own path, so no profile switch here.
          if (msg.state === "resting" || msg.state === "asleep") {
            this.switchSessionProfile("resting").catch(err =>
              logLiveSession("PROFILE_SWITCH_ERROR", `resting: ${(err as Error).message}`));
          } else if (msg.state === "awake" || msg.state === "waking") {
            this.switchSessionProfile("awake").catch(err =>
              logLiveSession("PROFILE_SWITCH_ERROR", `awake: ${(err as Error).message}`));
          }
          break;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[LiveRelay] Error handling ${msg.type}:`, error.message);
      this.send({ type: "error", data: "error:UNEXPECTED_ERROR" });
    }
  }

  // -------------------------------------------------------------------------
  // Initialize
  // -------------------------------------------------------------------------

  private async handleInitialize(msg: Extract<ClientMessage, { type: "initialize" }>): Promise<void> {
    this.setState("initializing");

    // Authoritative userId comes from the upgrade-time auth check, never from
    // the client message. This closes the path where an authenticated user
    // forged a different userId to inherit another user's license tier or
    // studentId-bound state.
    this.userId = this.authedUser.id;

    // Verify the authenticated user has access to the requested student via
    // any of: direct userStudent link, family-institute membership, or
    // school/clinic admin. Refuse the session otherwise — without this check,
    // anyone authenticated who knows a student UUID could open an AAC
    // session and pull PHI through the live model and monitor.
    if (!msg.studentId) {
      this.send({ type: "error", data: "MISSING_STUDENT_ID" });
      this.ws.close(1008, "missing studentId");
      return;
    }
    const access = await studentService.verifyStudentAccess(msg.studentId, this.authedUser.id);
    if (!access.hasAccess) {
      console.warn(
        `[LiveRelay] Access denied: user=${this.authedUser.id} requested studentId=${msg.studentId}`,
      );
      this.send({ type: "error", data: "FORBIDDEN_STUDENT" });
      this.ws.close(1008, "forbidden");
      return;
    }

    this.studentId = msg.studentId;
    this.muteState = msg.muteState || "unmuted";
    this.responseMode = msg.responseMode || "fast";
    this.debugMode = msg.debugMode || false;
    this.timezone = msg.timezone;

    try {
      // 1. Read LLM config
      const aacChatConfig = await settingsRepository.getLLMConfig("aac_chat");

      // Allow env var override for local testing
      const overrideModel = process.env.OVERRIDE_AAC_LIVE_MODEL;
      if (overrideModel) {
        const overrideInfo = MODEL_OPTIONS.find(m => m.modelId === overrideModel && m.supportsLive);
        if (overrideInfo) {
          aacChatConfig.provider = overrideInfo.provider;
          aacChatConfig.model = overrideInfo.modelId;
          console.log(`[LiveRelay] OVERRIDE_AAC_LIVE_MODEL -> ${overrideInfo.provider}/${overrideInfo.modelId}`);
        } else {
          console.warn(`[LiveRelay] OVERRIDE_AAC_LIVE_MODEL="${overrideModel}" not found or not a live model — ignoring`);
        }
      }

      // Choose Vertex vs public Gemini API based on the model's catalog entry.
      // Live models with availableOnVertex === false (e.g. 3.1 Flash Live Preview)
      // only run on the public API; everything else (GA 2.5 Flash Live, etc.)
      // uses Vertex when gemini is the provider.
      const liveModelInfo =
        aacChatConfig.provider === "gemini"
          ? MODEL_OPTIONS.find(m => m.modelId === aacChatConfig.model && m.supportsLive)
          : undefined;
      const useVertexForLive =
        aacChatConfig.provider === "gemini" &&
        (liveModelInfo?.availableOnVertex ?? true);

      // 2. Initialize session (prompt, contacts, symbols, boards)
      const state = await dualAgentService.initializeSession(
        msg.studentId,
        msg.userId,
        msg.sessionId,
        this.muteState,
        this.pendingLocalState || undefined,
        this.timezone,
      );
      this.pendingLocalState = null;
      this.sessionId = state.sessionId;

      // Get session cache
      const cached = dualAgentService.getSessionCache(state.sessionId);
      if (!cached) {
        throw new Error("Session cache not found after initialization");
      }
      this.sessionCache = cached;

      // Register context injection callback
      cached.state.onContextInjection = (text: string) => {
        logLiveSession("MONITOR INJECTION", text);
        if (this.provider?.isConnected) {
          this.provider.sendContextInjection(`[Monitor Context]\n${text}`);
          logLiveSession("MONITOR INJECTION SENT", `via sendContextInjection, provider connected=${this.provider.isConnected}`);
        } else {
          logLiveSession("MONITOR INJECTION FAILED", `provider not connected`);
        }
        this.send({ type: "context", data: `[Monitor] ${text}` });
      };

      // Server-initiated termination: dualAgentService calls this when the
      // user's consent is revoked mid-session (or any future cascade
      // condition). Send a typed error so the AAC client can surface a
      // "consent required" prompt, then close the socket cleanly.
      cached.state.onTerminate = (reason: string) => {
        try {
          this.send({
            type: "error",
            data: reason === "consent_revoked" ? "error:CONSENT_REVOKED" : "error:SESSION_TERMINATED",
          });
        } catch { /* ignore — close anyway */ }
        try {
          this.ws.close(1000, `terminated:${reason}`);
        } catch { /* ignore */ }
      };

      // 3. Resolve voices
      try {
        const student = cached.monitorAgent.getStudent?.();
        if (student) {
          const voices = await (dualAgentService as any).resolveVoices(cached);
          this.aiVoice = voices?.aiVoice || null;
          this.studentVoice = voices?.studentVoice || null;
          console.log(`[LiveRelay] Voices resolved — AI: ${this.aiVoice?.geminiVoiceName || this.aiVoice?.fallbackType || "none"}, Student: ${this.studentVoice?.fallbackType || "none"} (lang: ${this.studentVoice?.language || "?"}, gemini: ${this.studentVoice?.geminiVoiceName || "none"})`);

          // Start a persistent Gemini Live session for student TTS when a
          // Gemini voice is configured and ElevenLabs won't handle it.
          // This keeps the WebSocket warm for the duration of the AAC
          // conversation, avoiding the ~2.5s HTTP connection overhead of
          // the standard Gemini TTS HTTP API.
          const sv = this.studentVoice;
          const elevenLabsWillHandle =
            !!(sv?.elevenlabsApiKey && sv?.elevenlabsVoiceId) ||
            !!(sv?.customVoice && sv.customVoice.active);
          if (sv?.geminiVoiceName && !elevenLabsWillHandle) {
            this.studentTtsSession = new GeminiLiveTtsSession({
              voiceName: sv.geminiVoiceName,
              language: sv.language,
            });
            sv.geminiLiveSession = this.studentTtsSession;
          }
        } else {
          console.warn("[LiveRelay] No student found — voices not resolved");
        }
      } catch (err) {
        console.warn("[LiveRelay] Voice resolution failed, using defaults:", err);
      }

      // 4. Determine direct audio mode
      // Always use direct audio — Gemini native audio for AI voice,
      // Gemini TTS service for student voice (streamed server-side).
      this.useDirectAudio = true;
      if (this.useDirectAudio) {
        console.log("[LiveRelay] Direct audio mode enabled — model speaks directly via native audio");
      }

      // 5. If direct audio, rebuild prompt with useDirectAudio flag
      // Fetch custom apps assigned to this user (gated by license permission).
      let availableCustomApps: Array<{ id: string; name: string; description?: string | null }> = [];
      if (this.userId && this.studentId) {
        try {
          const perms = await licenseService.getUserPermissions(this.userId);
          if (perms.customAppsEnabled) {
            const apps = await customAppRepository.getAssignedAppsForStudent(this.studentId);
            availableCustomApps = apps.map((a) => ({
              id: a.id,
              name: a.name,
              description: a.description,
            }));
          }
        } catch (err) {
          logLiveSession("CUSTOM_APPS_FETCH_FAILED", String(err));
        }
      }

      if (this.useDirectAudio && cached.monitorAgent.getStudent) {
        const student = cached.monitorAgent.getStudent();
        if (student) {
          const rawPersona = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
          const sections = state.enhancedSections;
          const persona = sections?.persona || rawPersona;
          const computeAge = (bd: string | null | undefined) => {
            if (!bd) return undefined;
            const age = Math.floor((Date.now() - new Date(bd).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
            return age > 0 ? String(age) : undefined;
          };
          state.interactivePrompt = buildInteractiveAgentPrompt({
            studentName: student.name,
            persona,
            language: student.primaryLanguage || undefined,
            memoryContext: state.memoryContext,
            muteState: this.muteState,
            studentAge: computeAge(student.birthDate),
            studentGender: student.gender || undefined,
            studentDiagnosis: state.cachedDiagnosis || undefined,
            aiName: student.aacSettings?.aiName || undefined,
            knownContacts: state.cachedContacts?.length ? state.cachedContacts : undefined,
            availableBoards: state.availableBoards?.length ? state.availableBoards : undefined,
            cachedSymbols: state.cachedSymbols?.length ? state.cachedSymbols : undefined,
            enabledApps: APP_REGISTRY.filter(a => state.appState.enabledApps.includes(a.id)).map(a => ({ id: a.id, name: a.name, description: a.description })),
            availableCustomApps,
            permittedWebsites: state.permittedWebsites.length > 0 ? state.permittedWebsites : undefined,
            permittedYoutubeChannels: state.permittedYoutubeChannels.length > 0 ? state.permittedYoutubeChannels : undefined,
            permittedYoutubeVideos: state.permittedYoutubeVideos.length > 0 ? state.permittedYoutubeVideos : undefined,
            youtubeChannelVideos: state.permittedYoutubeChannels.length > 0
              ? await fetchRecentVideosForChannels(state.permittedYoutubeChannels)
              : undefined,
            autoSymbolsEnabled: !!(student.aacSettings?.generateSymbols || student.aacSettings?.useApprovedSymbols || student.aacSettings?.useUnapprovedSymbols),
            useDirectAudio: true,
            sessionGoals: sections?.sessionGoals,
            personaGestureOverrides: sections?.gestureOverrides,
            interactModeExamples: sections?.interactModeExamples,
            assistModeExamples: sections?.assistModeExamples,
            sentenceInterpretationExamples: sections?.sentenceInterpretationExamples,
            safetyNotes: sections?.safetyNotes,
            sessionSummary: state.sessionSummary,
          });
        }
      }

      // 5b. Build the default home board (virtual — not stored in DB).
      // The home board is loaded on init and on Home button press. The AI
      // can also load it explicitly via set_board("home") — it's included
      // in availableBoards so the AI understands when it's loaded and can
      // return to it deliberately.
      const studentLang = cached.monitorAgent.getStudent?.()?.primaryLanguage || "en";
      this.homeBoardData = buildDefaultHomeBoard(studentLang);
      // Load the home board into session state, but defer the client `set_board`
      // send until onReady. This prevents the home buttons from appearing
      // (and being clickable) before the model is connected.
      this.loadHomeBoardInternal(state, /* deferClientSend */ true);
      // Add home to available boards so the AI can call set_board("home")
      if (!state.availableBoards) state.availableBoards = [];
      if (!state.availableBoards.some(b => b.key === HOME_BOARD_KEY)) {
        state.availableBoards.unshift({ key: HOME_BOARD_KEY, name: "Home", id: "__home__" } as any);
      }

      // 6. Build tools (availableCustomApps was fetched above for the prompt)
      const toolConfig: ToolDeclarationConfig = {
        enabledApps: (cached.state.appState?.enabledApps || [])
          .map(id => getAppDefinition(id))
          .filter((a): a is import("./types").AACAppDefinition => !!a),
        availableBoards: (cached.state.availableBoards || []).map(b => ({ key: b.key, name: b.name })),
        availableCustomApps,
        hasLoadedBoard: !!cached.state.loadedBoardId,
        faceRecognitionActive: (cached.state.cachedContacts?.length || 0) > 0 || this.unknownFaceDescriptors.length > 0,
        isMutedMode: this.muteState === "muted",
        maxBoardItems: cached.state.maxBoardItems || 12,
        loadedBoardName: cached.state.loadedBoardData?.name || null,
        currentEmote: cached.state.currentEmote,
        activeApp: cached.state.appState?.activeApp || null,
        useDirectAudio: this.useDirectAudio,
        permittedWebsites: cached.state.permittedWebsites || [],
        // Student's primary language steers the localized example strings
        // baked into the tool descriptions (see prompt-examples.ts). Falls
        // back to English when unset.
        language: cached.monitorAgent?.getStudent?.()?.primaryLanguage || undefined,
      };

      // Close any existing provider (for forceNewSession re-init)
      this.provider?.close();

      const callbacks = this.buildProviderCallbacks();
      const tools = buildToolDeclarations(toolConfig);
      // Cache the full awake tool set so switchSessionProfile("awake") can
      // restore it without rebuilding the whole toolConfig.
      this.awakeTools = tools;

      // 7. Build system prompt
      const echoAwareness = this.buildEchoAwareness();
      const tzSection = this.buildTimezoneSection();
      const systemPrompt = state.interactivePrompt + "\n\n" + echoAwareness + (tzSection ? "\n\n" + tzSection : "");

      // 8. Connect to Gemini
      const geminiVoice = this.aiVoice?.geminiVoiceName || GEMINI_VOICE_MAP[this.aiVoice?.fallbackType || "woman"] || "Zephyr";

      const providerConfig: LiveProviderConfig = {
        model: aacChatConfig.model,
        temperature: 0.7,
        tools,
        compressionTriggerTokens: LiveRelay.AWAKE_COMPRESSION_TRIGGER,
        compressionTargetTokens: LiveRelay.AWAKE_COMPRESSION_TARGET,
        responseModality: "AUDIO",
        proactiveAudio: true,
        voiceName: geminiVoice,
      };

      this.provider = new GeminiLiveProvider(callbacks, useVertexForLive /* useVertexAI */);
      this.currentLiveProvider = aacChatConfig.provider;
      this.currentLiveModel = aacChatConfig.model;
      // Remember the bits switchSessionProfile() needs to rebuild a connection
      // for a different sleep-state profile without re-running handleInitialize.
      this.useVertexForLive = useVertexForLive;
      this.sessionProfile = "awake";
      this.geminiVoiceName = geminiVoice;
      // Bind logger session context so provider-side events (SERVER → toolCall,
      // RAW_MSG, SERVER → modelTurn, etc.) get DB-attributed too.
      this.provider.setDebugSessionContext(state.sessionId, this.debugMode);
      await this.provider.connect(systemPrompt, providerConfig);

      // Log session start. Wrap in session context so the initialize-time
      // events (SESSION START, SYSTEM PROMPT, TOOL DECLARATIONS) make it into
      // the per-session DB log even though the outer ws.on handler started
      // with sessionId=null.
      const providerLabel = useVertexForLive ? `vertex:${aacChatConfig.model}` : `api-key:${aacChatConfig.model}`;
      runInSessionContext(state.sessionId, this.debugMode, () => {
        logLiveSession("SESSION START", [
          `Session: ${state.sessionId}`,
          `Student: ${msg.studentId}`,
          `Provider: ${providerLabel}`,
          `Model: ${providerConfig.model}`,
          `Response Modality: ${providerConfig.responseModality || "default"}`,
          `Interaction: ${this.muteState}`,
          `Response: ${this.responseMode}`,
          `DirectAudio: ${this.useDirectAudio}`,
          `Startup: ${state.enhancedSections ? "thorough" : "fast"}`,
        ].join("\n"));
        logLiveSession("SYSTEM PROMPT", systemPrompt);
        if (tools.length > 0) {
          logLiveSession("TOOL DECLARATIONS", JSON.stringify(tools, null, 2));
        }
      });


      // 9. Store greeting for onReady to send
      const isMuted = this.muteState === "muted";
      const student = cached.monitorAgent.getStudent?.();
      const personaHint = student?.aacSettings?.chatAgentPrompt?.trim()
        ? `\nThe student is ${student.name}. Use their profile (in the system prompt) to personalize the board — reflect their interests, communication level, and needs.`
        : "";
      const imageHint = msg.initialFrame ? "\nUse the camera image to observe the environment and make the ${T.button}s contextually relevant." : "";
      const boardHint = state.availableBoards && state.availableBoards.length > 0
        ? ` If a custom ${T.board} from the Available Custom Boards list is appropriate for this user, use set_board() instead of rebuild_board().`
        : "";

      this.hasGreeted = false;
      // In MUTED mode we DO need an initial prompt: the AI's job is to surface
      // utterance ${T.button}s for the user to speak through, so we kick that
      // off immediately. The prompt gives a clear action ("Generate 4-12
      // ${T.button}s"), so the model has something concrete to do even without
      // visual context.
      //
      // In UNMUTED mode we deliberately send NOTHING at session start. Empirically
      // (live-session log 2026-05-24 @11:26 around line 25984) the previous
      // "Session start. Default to STANDBY; observe and call set_interaction_mode
      // once you can identify who is present" prompt caused the model to emit a
      // MALFORMED_FUNCTION_CALL on the very first turn — there was no visual
      // input yet for it to observe, so it fumbled, and the discarded turn was
      // then followed by a ~15s idle wait for the next heartbeat frame. By
      // skipping the empty first-turn prompt entirely, the model sits silent
      // until the FIRST frame_grid arrives, which becomes its first input — no
      // malformed turn, no wakeup gap. Greeting still triggers normally on the
      // first set_interaction_mode("interact") call (see handleToolCalls).
      if (isMuted) {
        const contextScan = ``;
        const greetingPrompt = `Generate 4-12 contextual ${T.button}s via rebuild_board() using the user's profile/interests.${imageHint}${boardHint}${personaHint}${contextScan}`;
        this.pendingGreeting = { prompt: greetingPrompt };
      } else {
        this.pendingGreeting = null;
      }

      // Resolve local storage config
      const aacStudentSettings = cached.monitorAgent.getStudent?.()?.aacSettings;
      let encryptionKey = aacStudentSettings?.localStorageEncryptionKey ?? null;
      if (aacStudentSettings?.localStorageEnabled && !encryptionKey) {
        encryptionKey = randomBytes(32).toString("base64");
        aacSettingsRepository.upsert(msg.studentId, { localStorageEncryptionKey: encryptionKey }).catch(err =>
          console.error("[LiveRelay] Failed to persist encryption key:", err)
        );
      }
      this.localStorageConfig = {
        localStorageEnabled: aacStudentSettings?.localStorageEnabled ?? true,
        remoteStorageEnabled: aacStudentSettings?.remoteStorageEnabled ?? true,
        encryptionKey,
      };
      this.symbolSettings = {
        generateSymbols: aacStudentSettings?.generateSymbols ?? false,
        useApprovedSymbols: aacStudentSettings?.useApprovedSymbols ?? false,
        useUnapprovedSymbols: aacStudentSettings?.useUnapprovedSymbols ?? false,
      };
      console.log(`[LiveRelay] Symbol settings loaded:`, JSON.stringify(this.symbolSettings));

      // 10. Start timers. Run inside session context so callbacks inherit
      // als attribution for DB log persistence (setInterval propagates als).
      runInSessionContext(state.sessionId, this.debugMode, () => {
        this.startTimers();

        // 11. "initialized" is sent when the provider's onReady fires (see
        // onReady callback) so the client keeps showing the loading screen
        // until the Gemini connection is actually established.

        logDualAgent("LiveRelay.initialize", {
          sessionId: state.sessionId,
          studentId: msg.studentId,
          provider: providerLabel,
          model: providerConfig.model,
          responseModality: providerConfig.responseModality || "default",
          muteState: this.muteState,
          responseMode: this.responseMode,
          useDirectAudio: this.useDirectAudio,
        });
      });

      console.log(`[LiveRelay] Initialized session ${state.sessionId} for student ${msg.studentId} (provider: ${providerLabel}, modality: ${providerConfig.responseModality || "default"}, model: ${providerConfig.model})`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Distinguish consent-gate failures so the AAC client can surface a
      // "consent required" prompt instead of a generic init failure.
      if (error.name === "ConsentGateError" || /consent[_ ]required/i.test(error.message)) {
        console.warn("[LiveRelay] Initialize blocked by consent gate:", error.message);
        this.send({ type: "error", data: "error:CONSENT_REQUIRED" });
      } else {
        console.error("[LiveRelay] Initialize failed:", error.message);
        this.send({ type: "error", data: "error:INIT_FAILED" });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Button press handling
  // -------------------------------------------------------------------------

  private handleButtonPress(
    buttons: string[],
    sentences?: Record<string, string>,
    board?: any,
    interrupt = false,
  ): void {
    const buttonList = buttons.join(", ");
    console.log(`[LiveRelay] Interpreting buttons: ${buttonList}${interrupt ? " (interrupt)" : ""}`);

    // [MORE] — user wants more button options, NOT a spoken response
    if (buttons.length === 1 && buttons[0] === "[MORE]") {
      if (this.sessionId) {
        dualAgentService.addPendingMessage(this.sessionId, {
          role: "user",
          content: "[MORE OPTIONS REQUESTED]",
          timestamp: Date.now(),
        }).catch(err => console.error("[LiveRelay] Failed to persist [MORE]:", err));
      }
      this.provider!.sendMessage(`[MORE OPTIONS REQUESTED]
The user pressed "More" — they can't find the ${T.button} they need on the current ${T.board}. Use add_buttons() to add more relevant ${T.button}s. Do NOT respond with speech — just silently add ${T.button}s.`, "user", true, { interrupt });
      return;
    }

    // For a single button press, use the pre-generated sentence directly.
    const singleSentence = (buttons.length === 1 && sentences?.[buttons[0]]) || "";

    // Send interpretation to client for UI display
    if (singleSentence) {
      this.send({ type: "interpret", text: singleSentence, confidence: "high", noAudioClear: false });
      this.turnAccum.interpretText = singleSentence;
      this.turnAccum.interpretConfidence = "high";
    }

    // Record button press as a user message in session log
    if (this.sessionId) {
      dualAgentService.addPendingMessage(this.sessionId, {
        role: "user",
        content: `${T.tagPress} ${buttonList}`,
        timestamp: Date.now(),
      }).catch(err => console.error("[LiveRelay] Failed to persist button press:", err));
    }

    // Insurance Bridge: record the utterance for MLU/NDW aggregation. We
    // prefer the pre-generated sentence (more natural language) but fall back
    // to the raw button labels when no sentence is available.
    if (this.studentId) {
      recordUtterance({
        studentId: this.studentId,
        chatSessionId: this.sessionId,
        text: singleSentence || buttonList,
        source: "board_press",
      });
    }

    // Minimal natural framing: present the press as the user speaking.
    // No system markers, no procedural instructions — the per-turn payload
    // looks like a chat message. The system prompt's
    // <how_the_student_talks_to_you> block handles the "respond aloud +
    // rebuild_board" behavior expectation.
    const prompt = `${T.tagPress} ${singleSentence || buttonList}`;

    // Send prompt with turnComplete=true immediately. Student TTS runs in
    // parallel. With Google Cloud TTS (~300ms) and AI response time (~1s),
    // the user voice finishes before the AI starts speaking.
    //
    // Track the prompt so we can retry if proactiveAudio swallows the turn.
    this.pendingRetryPrompt = prompt;
    this.lastTurnHadButtonPress = true;
    this.provider!.sendMessage(prompt, "user", true, { interrupt });

    // Stream student voice TTS in parallel
    if (singleSentence && this.studentVoice) {
      // Cancel any in-flight student TTS from a previous press — without this,
      // overlapping streams interleave on the `interpretation_audio` channel
      // and the client plays a garbled mix. We send a tag-scoped clear so the
      // AI's avatar_audio queue is preserved.
      if (this.studentTtsAbortController) {
        this.studentTtsAbortController.abort();
        this.send({ type: "audio_clear_tag", tag: "interpret" });
      }
      const controller = new AbortController();
      this.studentTtsAbortController = controller;

      logLiveSession("STUDENT TTS START", `text="${singleSentence}" voice=${JSON.stringify({ fallbackType: this.studentVoice.fallbackType, language: this.studentVoice.language, hasGemini: !!this.studentVoice.geminiVoiceName, hasCustom: !!this.studentVoice.customVoice })}`);
      this.preGenTtsPromise = this.streamTtsWithTimeout(
        singleSentence,
        this.studentVoice,
        "interpretation_audio",
        "Student",
        15_000,
        controller.signal,
      ).then(() => {
        if (this.studentTtsAbortController === controller) this.studentTtsAbortController = null;
        logLiveSession("STUDENT TTS DONE", `text="${singleSentence}"`);
      }).catch(err => {
        if (this.studentTtsAbortController === controller) this.studentTtsAbortController = null;
        logLiveSession("STUDENT TTS ERROR", (err as Error).message);
        console.error("[LiveRelay] Student TTS error:", (err as Error).message);
      });
    } else {
      logLiveSession("STUDENT TTS SKIPPED", `singleSentence=${!!singleSentence} studentVoice=${!!this.studentVoice}`);
    }
  }

  // -------------------------------------------------------------------------
  // Tool handling
  // -------------------------------------------------------------------------

  private async handleToolCalls(calls: ToolCall[]): Promise<void> {
    const callNames = calls.map(c => c.name).join(", ");
    logLiveSession("handleToolCalls", `calls=[${callNames}] state=${this.state}`);

    // During debug introspection: check if the model called debug_message
    // (the intended way to report what it tried). If so, capture the message.
    // Any other tool calls during debug are acknowledged but not executed.
    if (this.awaitingDebugResponse) {
      for (const call of calls) {
        if (call.name === "debug_message") {
          const msg = extractStringArg(call.args, "message");
          if (msg) this.debugResponseBuffer += msg;
          logLiveSession("DEBUG: debug_message received", msg || "(empty)");
        } else {
          logLiveSession("DEBUG: non-debug tool call suppressed", `${call.name}(${JSON.stringify(call.args)})`);
          this.debugResponseBuffer += `\n[Also tried to call: ${call.name}(${JSON.stringify(call.args)})]`;
        }
      }
      this.provider?.sendToolResponseAsContent(
        calls.map(c => ({ id: c.id, name: c.name || "unknown", response: { output: "ok" } })),
      );
      return;
    }

    // If we're in processing_turn (duplicate turn), resolve the open
    // functionCall(s) with a structured "already handled" response so the
    // model's state stays consistent without triggering another generation.
    if (this.state === "processing_turn") {
      logLiveSession("DUPLICATE TURN", `Suppressed ${callNames} — state=processing_turn`);
      this.provider?.sendToolResponseAsContent(
        calls.map(c => ({ id: c.id, name: c.name || "unknown", response: { output: "already handled" } })),
      );
      return;
    }

    // Move to in_turn state — model is responding to the button press
    this.setState("in_turn");
    this.consecutiveSafetyBlocks = 0;
    this.rejectionCooldownUntil = 0;
    this.pendingRetryPrompt = null;  // model responded — no retry needed

    // ────────────────────────────────────────────────────────────────────────
    // Tool result delivery — CRITICAL TIMING
    //
    // Send tool responses IMMEDIATELY before processing (board building,
    // symbol lookup, etc.). The model waits for the functionResponse before
    // continuing to generate audio — if we process the tools first (which
    // can take 500ms+ for symbol lookups), the model times out and completes
    // its turn with zero audio output.
    //
    // Using sendToolResponse (protocol-native path) — verified 2026-05-11
    // that this is required for the upgraded model to actually generate
    // audio after tool calls. The previous sendToolResponseAsContent
    // workaround broke responsiveness on the upgraded native-audio model.
    //
    // scheduling: "SILENT" — request that this functionResponse NOT trigger
    // a new generation. Per project memory, on older model versions this was
    // silently ignored for BLOCKING tools (and all tools are BLOCKING on
    // Vertex because NON_BLOCKING is rejected), so every tool response
    // triggered a duplicate turn. Re-trying on the upgraded model in case
    // server-side behavior changed.
    if (this.provider) {
      this.provider.sendToolResponse(
        calls.map(c => ({
          id: c.id,
          name: c.name || "unknown",
          response: { output: "ok" },
          scheduling: "SILENT" as const,
        })),
      );
    }

    // Now process tools (board building, symbol lookup, etc.) — the model
    // is already continuing to generate audio in parallel.
    for (const call of calls) {
      try {
        logDualAgent("LiveRelay.toolCall", { sessionId: this.sessionId, name: call.name, args: call.args });
        logLiveSession(`TOOL CALL: ${call.name}`, JSON.stringify({ id: call.id, args: call.args }, null, 2));
        await this.handleSingleToolCall(call);
      } catch (err) {
        const errMsg = (err as Error).message;
        console.error(`[LiveRelay] Tool call "${call.name}" failed:`, errMsg);
        logLiveSession(`TOOL ERROR: ${call.name}`, errMsg);
      }
    }
  }

  /**
   * Process a single tool call and return the tool response.
   */
  private async handleSingleToolCall(call: ToolCall): Promise<ToolResponse> {
    const name = call.name || "unknown";
    const args = call.args || {};
    const isMuted = this.muteState === "muted";
    const state = this.sessionCache?.state;

    switch (name) {
      case "speak": {
        const text = extractStringArg(args, "text");
        // In direct audio mode, the model speaks via native audio — ignore hallucinated speak() calls
        if (this.useDirectAudio) {
          logLiveSession("IGNORED TOOL CALL", `speak() in direct audio mode — model speaks natively`);
          if (text) this.hasGreeted = true;
          return { id: call.id, name, response: { output: "ok — you speak directly, no need to call speak()" } };
        }
        if (!text) {
          logLiveSession("EMPTY TOOL CALL", `speak() got empty text. Raw args: ${JSON.stringify(args)}`);
        }
        if (text && !isMuted) {
          const hasPreGenTts = this.preGenTtsPromise !== null;
          this.send({ type: "text", data: text, noAudioClear: hasPreGenTts || undefined });
        }
        if (text) this.hasGreeted = true;
        this.turnAccum.speakText += (this.turnAccum.speakText ? " " : "") + text;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "interpret": {
        // Called in response to a ${T.tagComposed} turn — the AI has produced
        // a natural-language interpretation of the user's composed glyph.
        // Stream student TTS, record the sentence as the user's turn in
        // the session log, and AWAIT the TTS finish before returning so the
        // AI's subsequent speak() (typically in the same turn) is sequenced
        // after the user's voice.
        const sentence = extractStringArg(args, "sentence")?.trim() || "";
        if (!sentence) {
          logLiveSession("INTERPRET_REJECTED", "missing 'sentence' argument");
          return { id: call.id, name, response: { error: "sentence is required" } };
        }
        logLiveSession("INTERPRET", `sentence="${sentence}"`);

        // 1. Show the user's "speech" in the UI immediately.
        this.send({ type: "interpret", text: sentence, confidence: "high", noAudioClear: false });
        this.turnAccum.interpretText = sentence;
        this.turnAccum.interpretConfidence = "high";

        // 2. Record as user turn so the conversation history shows the
        // user's contribution (the prior ${T.tagComposed} line stays in
        // the log as the raw input — they bracket each other).
        if (this.sessionId) {
          dualAgentService.addPendingMessage(this.sessionId, {
            role: "user",
            content: `${T.tagPress} ${sentence}`,
            timestamp: Date.now(),
          }).catch(err => console.error("[LiveRelay] Failed to persist interpret sentence:", err));
        }
        if (this.studentId) {
          recordUtterance({
            studentId: this.studentId,
            chatSessionId: this.sessionId,
            text: sentence,
            source: "board_press",
          });
        }

        // 3. Stream student-voice TTS and AWAIT it. The follow-up speak()
        // (if any) runs in the next handler step, which the provider only
        // invokes after this promise resolves — so the user voice
        // finishes before the AI's voice begins.
        //
        // We also pin the same promise to `this.preGenTtsPromise` so
        // handleTurnComplete's `else if (fullInterpretText && studentVoice)`
        // branch is bypassed; otherwise the turn-complete handler would
        // re-synthesize the same sentence and the user would hear the
        // student voice twice. The existing `preGenTtsPromise` path is the
        // intended "student TTS already streamed in this turn" channel.
        if (this.studentVoice) {
          if (this.studentTtsAbortController) {
            this.studentTtsAbortController.abort();
            this.send({ type: "audio_clear_tag", tag: "interpret" });
          }
          const controller = new AbortController();
          this.studentTtsAbortController = controller;
          const ttsPromise = this.streamTtsWithTimeout(
            sentence,
            this.studentVoice,
            "interpretation_audio",
            "Student",
            15_000,
            controller.signal,
          );
          this.preGenTtsPromise = ttsPromise;
          try {
            await ttsPromise;
          } catch (err) {
            logLiveSession("INTERPRET_TTS_ERROR", (err as Error).message);
          } finally {
            if (this.studentTtsAbortController === controller) this.studentTtsAbortController = null;
          }
        } else {
          logLiveSession("INTERPRET_TTS_SKIPPED", "no studentVoice configured");
        }

        // 4. Re-inject the interpreted SENTENCE as a [BUTTON PRESS] user turn
        // so the model produces a reply + new ${T.board} just like any
        // clinician-curated ${T.button} press.
        //
        // WHY: Gemini Live (especially native-audio) treats a function call
        // as the natural end of its turn. Empirically (live-session log
        // 2026-05-24 @11:30 around the make(🎮)+now composition) the model
        // calls interpret() and then emits `generationComplete` with zero
        // audio — it never produces the speak + rebuild_board the system
        // prompt asks for. Re-injecting [BUTTON PRESS] gives the model a
        // fresh user turn that exactly matches the response pattern it
        // already executes correctly for clinician-curated presses.
        //
        // Timing: this runs AFTER the await on student-voice TTS above, so
        // the user's voice finishes before the model starts producing its
        // reply audio. The follow-up uses sendMessage(turnComplete=true) so
        // it triggers a fresh generation; the SILENT tool response (sent
        // earlier in handleToolCalls) doesn't.
        //
        // We also set the same `lastTurnHadButtonPress` + `pendingRetryPrompt`
        // flags the real button-press path sets — that way the existing
        // auto-continuation logic (handleTurnComplete around line 4051)
        // recognizes a silent response and re-prompts the model with a
        // "[continue] You declared you would say X but didn't speak it"
        // nudge. Without these flags, the model frequently writes own_speech
        // but produces zero audio output (log 2026-05-24 @12:37 line 45166:
        // `audioOutputTokens=0`) and we never recover.
        if (this.provider && this.provider.isConnected) {
          const followUp = `${T.tagPress} ${sentence}`;
          logLiveSession(
            "INTERPRET_FOLLOWUP_INJECTED",
            `text="${followUp.substring(0, 200)}"`,
          );
          this.lastTurnHadButtonPress = true;
          this.pendingRetryPrompt = followUp;
          this.provider.sendMessage(followUp, "user", true);
        }

        return { id: call.id, name, response: { output: "ok" } };
      }

      case "transcript": {
        const text = extractStringArg(args, "text");
        const speaker = (typeof args.speaker === "string" ? args.speaker : "Unknown");
        const confidence = args.confidence as string | undefined;
        this.send({ type: "transcript", data: text, speaker, confidence });
        this.turnAccum.transcriptText += `[${speaker}] ${text} `;
        this.turnAccum.transcriptSpeaker = speaker;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "update_context": {
        // Typed observations — build a structured world model over time.
        // These are logged/displayed but don't trigger any side effects.
        const obsType = extractStringArg(args, "type") || "other";
        const key = extractStringArg(args, "key");
        const description = extractStringArg(args, "description");
        // Backwards-compat: if the model passes the old "text" arg, use it
        const legacyText = extractStringArg(args, "text");
        const formatted = description || legacyText
          ? `[${obsType}${key ? `: ${key}` : ""}] ${description || legacyText}`
          : `[${obsType}${key ? `: ${key}` : ""}]`;
        logLiveSession("CONTEXT OBSERVATION", formatted);
        this.send({ type: "context", data: formatted });
        this.turnAccum.contextText += (this.turnAccum.contextText ? " " : "") + formatted;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "add_context_button": {
        // Add ONE button to the context sidebar. Oldest scrolls out when full.
        const ctxButtons = toolArgsToButtons(args.button);
        if (ctxButtons.length === 0) {
          return { id: call.id, name, response: { error: "No valid button provided" } };
        }
        const btn = ctxButtons[0];

        // Structural validation — same gate rebuild_board/add_buttons use.
        // Without it a malformed context button (imageKey with no fallback,
        // non-canonical modifier, or nothing displayable) would render as a
        // blank FontAwesome speech-bubble in the sidebar. Bounce it back to
        // the AI with the reason so it rebuilds, and never put it on screen.
        const ctxValidation = validateBoardButtons([btn]);
        if (ctxValidation.buttons.length === 0) {
          logLiveSession("BOARD_VALIDATION", `add_context_button rejected: ${ctxValidation.errors.join(" | ")}`);
          return { id: call.id, name, response: {
            error: `Context ${T.button} rejected — it would not render. Fix and call add_context_button() again.`,
            problems: ctxValidation.errors,
          }};
        }

        const labelLower = btn.label.toLowerCase();

        // Reject collision with main board — same label on both sidebars makes
        // sentence lookup ambiguous on the client (the press dispatches whichever
        // button was tapped, but with identical labels users can't tell them apart).
        if (state?.boardButtonLabels.some(l => l.toLowerCase() === labelLower)) {
          return { id: call.id, name, response: {
            error: `A button labeled "${btn.label}" already exists on the main board. Choose a different label for the context sidebar (e.g. add a qualifier).`,
            main_board_buttons: state.boardButtonLabels.join(", "),
          }};
        }

        // Deduplicate: if a button with the same label already exists, skip it
        const existingIdx = this.contextButtonLabels.findIndex(
          l => l.toLowerCase() === labelLower
        );
        if (existingIdx >= 0) {
          return { id: call.id, name, response: {
            output: "already exists",
            current_context_buttons: this.contextButtonLabels.join(", "),
          }};
        }

        const unresolvedKeys = await this.resolveExistingSymbols([btn]);
        this.queueMissingSymbolGeneration([btn], unresolvedKeys);
        // Per-slot generation for any imageKey-shaped pieces of the
        // button's glyph (fire-and-forget; results arrive via
        // construction_symbol_ready WS messages).
        void this.resolveAndQueueGlyphParts([btn]);

        // Track server-side and send to client
        this.contextButtonLabels.push(btn.label);
        if (this.contextButtonLabels.length > 4) {
          this.contextButtonLabels.shift(); // oldest scrolls out
        }

        this.send({ type: "context_button_add", data: {
          label: btn.label,
          iconRef: btn.iconRef,
          symbolPath: btn.symbolPath,
          imageKey: btn.imageKey,
          glyph: btn.glyph,
          sentence: btn.sentence,
          buttonType: btn.buttonType,
        }});
        logLiveSession("CONTEXT_BUTTON", `Added: ${btn.label} | Visible: [${this.contextButtonLabels.join(", ")}]`);

        return { id: call.id, name, response: {
          output: "ok",
          added: btn.label,
          current_context_buttons: this.contextButtonLabels.join(", "),
        }};
      }

      case "suggest_construction_buttons": {
        const slotIndex = Number.isInteger(args.slot_index) ? args.slot_index as number : 0;

        // Two SUGGESTION arrays — head_candidates (next-glyph HEAD SYMBOLs)
        // and modifier_candidates (MODIFIER SYMBOLs for the current head).
        // `candidates` is the deprecated single-array form, kept as an
        // alias for head_candidates so older model outputs still work.
        // Defensive parsing: the model frequently confuses this tool's
        // ARRAY-of-strings schema with the COMMA-joined-string format used
        // by rebuild_board.user_response_buttons. It then passes a single
        // entry like
        //   ["generate:word||מילה,generate:sentence||משפט,..."]
        // (4 candidates in one comma-joined string) instead of
        //   ["generate:word||מילה", "generate:sentence||משפט", ...].
        // Be lenient: when an entry contains BOTH a comma AND a pipe, split
        // it on commas to recover the intended candidates. Each segment is
        // then validated as a normal piped candidate. Confirmed in
        // live-session log 2026-05-24 @12:39 line 51460.
        const flattenCommaJoined = (arr: unknown[]): string[] => {
          const out: string[] = [];
          for (const entry of arr) {
            if (typeof entry !== "string") {
              // Pass non-strings through unchanged; parseRawArray handles
              // the JSON-object form separately.
              out.push(entry as any);
              continue;
            }
            const t = entry.trim();
            if (t.includes(",") && t.includes("|")) {
              // Comma+pipe = the model collapsed multiple candidates into
              // one string. Split on commas (but only at the top level —
              // pipes inside each segment carry speech|symbol|fallback|label).
              for (const seg of t.split(",")) {
                const segTrim = seg.trim();
                if (segTrim.length > 0) out.push(segTrim);
              }
            } else {
              out.push(t);
            }
          }
          return out;
        };

        const rawHeadFromNew = Array.isArray(args.head_candidates) ? flattenCommaJoined(args.head_candidates) : [];
        const rawHeadFromLegacy = Array.isArray(args.candidates) ? flattenCommaJoined(args.candidates) : [];
        const rawHeadCandidates: unknown[] = rawHeadFromNew.length > 0 ? rawHeadFromNew : rawHeadFromLegacy;
        const rawModifierCandidates: unknown[] = Array.isArray(args.modifier_candidates) ? flattenCommaJoined(args.modifier_candidates) : [];

        // Pipe-separated by default, matching the ${T.button} format
        // elsewhere: speech|symbol|fallback|label (speech field unused for
        // SUGGESTIONs). We tolerate every reasonable arity:
        //   4 fields → speech|symbol|fallback|label (ignore speech)
        //   3 fields → symbol|fallback|label
        //   2 fields → symbol|label
        //   1 field  → just the symbol
        // We also tolerate the JSON-object schema (`{key, label, fallback}`)
        // which Vertex sometimes emits when it does honor the schema;
        // if both forms collide (pipes inside the JSON `key`), explicit
        // JSON fields win where they're present.
        const parsePipedCandidate = (raw: string): { key: string; label?: string; fallback?: string } => {
          const t = raw.trim();
          if (!t) return { key: "" };
          if (!t.includes("|")) return { key: t };
          const parts = t.split("|").map((p) => p.trim());
          if (parts.length >= 4) {
            return {
              key: parts[1],
              fallback: parts[2] || undefined,
              label: parts[3] || undefined,
            };
          }
          if (parts.length === 3) {
            return {
              key: parts[0],
              fallback: parts[1] || undefined,
              label: parts[2] || undefined,
            };
          }
          // length === 2
          return { key: parts[0], label: parts[1] || undefined };
        };

        const parseRawArray = (
          rawArr: unknown[],
        ): Array<{ key: string; label?: string; fallback?: string }> =>
          rawArr
            .map((c) => {
              if (typeof c === "string" && c.trim().length > 0) {
                return parsePipedCandidate(c);
              }
              if (c && typeof c === "object" && typeof (c as any).key === "string" && (c as any).key.trim().length > 0) {
                const rawKey = (c as any).key.trim();
                const rawLabel = typeof (c as any).label === "string" && (c as any).label.trim().length > 0 ? (c as any).label.trim() : undefined;
                const rawFallback = typeof (c as any).fallback === "string" && (c as any).fallback.trim().length > 0 ? (c as any).fallback.trim() : undefined;
                const split = parsePipedCandidate(rawKey);
                return {
                  key: split.key,
                  label: rawLabel ?? split.label,
                  fallback: rawFallback ?? split.fallback,
                };
              }
              return null;
            })
            .filter((c): c is { key: string; label?: string; fallback?: string } =>
              c !== null && c.key.length > 0,
            )
            .slice(0, 4);

        const parsedHeadCandidates = parseRawArray(rawHeadCandidates);
        const parsedModifierCandidates = parseRawArray(rawModifierCandidates);

        // Apply the same canonical / emoji / symbol / face / generate
        // classification used for button SENTENCEs. A candidate whose key
        // reduces to a generation target (i.e. not a registry hit, not an
        // emoji, not a symbol:/face: ref) MUST carry a fallback that is
        // itself NOT a generation target — same rule the rebuild_board
        // validator applies to GLYPHs, so the AI sees one consistent
        // shape across both surfaces.
        const isGenerationTarget = (key: string): boolean => {
          if (!key) return true;
          if (isEmoji(key)) return false;
          if (key.startsWith("symbol:") || key.startsWith("face:")) return false;
          const item = getVocabularyItem(key);
          if (item?.imagePath || item?.emoji) return false;
          if (resolveEmoji(key)) return false;
          return true;
        };

        // Run validation on one parsed array; returns the cleaned candidates
        // plus a list of human-readable error strings (one per rejection).
        // The `kindLabel` string is woven into error messages so the model
        // can tell which array a rejection came from on retry.
        const validateBatch = (
          parsed: Array<{ key: string; label?: string; fallback?: string }>,
          kindLabel: string,
        ): {
          cleaned: Array<{ key: string; label: string | undefined; fallback: string | undefined }>;
          errors: string[];
        } => {
          const cleaned: Array<{ key: string; label: string | undefined; fallback: string | undefined }> = [];
          const errors: string[] = [];
          for (const raw of parsed) {
            const bareKey = stripBrackets(raw.key);
            const bareFallback = raw.fallback ? stripBrackets(raw.fallback) : undefined;

            const keyIsGen = isGenerationTarget(bareKey);
            if (keyIsGen) {
              if (!bareFallback) {
                errors.push(
                  `${kindLabel} "${raw.label || raw.key}" — key "${raw.key}" needs generation but no fallback was provided. Add an emoji, canonical key, \`symbol:ID\`, or \`face:ID\` as the candidate's \`fallback\` field.`,
                );
                continue;
              }
              if (isGenerationTarget(bareFallback)) {
                errors.push(
                  `${kindLabel} "${raw.label || raw.key}" — fallback "${raw.fallback}" is itself a generation target. Fallbacks must be an emoji, canonical key, \`symbol:ID\`, or \`face:ID\` (anything that renders immediately).`,
                );
                continue;
              }
            } else if (bareFallback && isGenerationTarget(bareFallback)) {
              errors.push(
                `${kindLabel} "${raw.label || raw.key}" — fallback "${raw.fallback}" is itself a generation target; ignored. Primary key renders fine on its own.`,
              );
              cleaned.push({ key: bareKey, label: raw.label, fallback: undefined });
              continue;
            }
            cleaned.push({ key: bareKey, label: raw.label, fallback: bareFallback });
          }
          return { cleaned, errors };
        };

        const headBatch = validateBatch(parsedHeadCandidates, "Head candidate");
        const modifierBatch = validateBatch(parsedModifierCandidates, "Modifier candidate");
        const headCandidates = headBatch.cleaned;
        const modifierCandidates = modifierBatch.cleaned;
        const constructionErrors = [...headBatch.errors, ...modifierBatch.errors];

        logLiveSession("CONSTRUCTION_SUGGEST_RAW",
          `slot=${slotIndex} rawHead=${rawHeadCandidates.length} rawMod=${rawModifierCandidates.length} validHead=${headCandidates.length} validMod=${modifierCandidates.length} dropped=${constructionErrors.length}`);
        if (constructionErrors.length > 0) {
          logLiveSession("CONSTRUCTION_SUGGEST_VALIDATION", constructionErrors.join(" | "));
        }

        if (headCandidates.length === 0 && modifierCandidates.length === 0) {
          logLiveSession("CONSTRUCTION_SUGGEST_REJECT", "no valid candidates in either array");
          const errorResponse: Record<string, unknown> = { error: "No valid candidates provided in head_candidates or modifier_candidates" };
          if (constructionErrors.length > 0) errorResponse.dropped_candidates = constructionErrors;
          return { id: call.id, name, response: errorResponse };
        }

        // Resolve symbol paths for AI-generated keys. A candidate gets a
        // symbolPath if its key has no built-in icon. Heads and modifiers
        // share the resolution pipeline — both go through the same
        // registry / emoji / generation gating.
        const enrichedHeads: Array<{ key: string; label?: string; symbolPath?: string; fallback?: string }> =
          headCandidates.map((c) => ({ ...c }));
        const enrichedModifiers: Array<{ key: string; label?: string; symbolPath?: string; fallback?: string }> =
          modifierCandidates.map((c) => ({ ...c }));

        type ResolveTarget = { arr: typeof enrichedHeads; idx: number };
        const symbolButtons: Array<{
          label: string;
          iconRef: string;
          imageKey?: string;
          symbolPath?: string;
        }> = [];
        const targetByImageKey = new Map<string, ResolveTarget>();
        const collectResolvable = (arr: typeof enrichedHeads) => {
          for (let i = 0; i < arr.length; i++) {
            const c = arr[i];
            const reg = getVocabularyItem(c.key);
            if (reg?.imagePath) continue;
            if (resolveEmoji(c.key)) continue;
            symbolButtons.push({
              label: c.label || c.key,
              iconRef: reg?.emoji || "",
              imageKey: c.key,
            });
            targetByImageKey.set(c.key, { arr, idx: i });
          }
        };
        collectResolvable(enrichedHeads);
        collectResolvable(enrichedModifiers);

        const { generateSymbols, useApprovedSymbols, useUnapprovedSymbols } = this.symbolSettings;
        if (symbolButtons.length > 0 && (generateSymbols || useApprovedSymbols || useUnapprovedSymbols)) {
          const useUnapproved = useUnapprovedSymbols;
          const unresolved = (useApprovedSymbols || useUnapprovedSymbols)
            ? await resolveImageKeys(symbolButtons, { symbolPathFormat: "api-path", useUnapproved })
            : symbolButtons.filter(b => b.imageKey).map(b => b.imageKey!);

          for (const btn of symbolButtons) {
            if (btn.imageKey && btn.symbolPath) {
              const target = targetByImageKey.get(btn.imageKey)!;
              target.arr[target.idx].symbolPath = btn.symbolPath;
            }
          }

          if (generateSymbols && unresolved.length > 0) {
            queueSymbolGeneration(unresolved, (imageKey, symbol) => {
              logLiveSession("CONSTRUCTION_SYMBOL_READY",
                `imageKey=${imageKey} symbolId=${symbol.id} wsOpen=${this.ws.readyState === 1}`);
              this.send({
                type: "construction_symbol_ready",
                data: {
                  imageKey,
                  symbolPath: `/api/custom-symbols/${symbol.id}/image`,
                },
              });
            });
          }
        }

        this.send({
          type: "construction_suggestions",
          data: {
            targetSlot: slotIndex,
            candidates: enrichedHeads,            // legacy field — heads only, for compat
            headCandidates: enrichedHeads,
            modifierCandidates: enrichedModifiers,
          },
        });
        logLiveSession("CONSTRUCTION_SUGGEST",
          `slot=${slotIndex} heads=[${enrichedHeads.map(c => c.symbolPath ? `${c.key}*` : c.key).join(", ")}] modifiers=[${enrichedModifiers.map(c => c.symbolPath ? `${c.key}*` : c.key).join(", ")}]`);
        const okResponse: Record<string, unknown> = {
          output: "ok",
          headCount: enrichedHeads.length,
          modifierCount: enrichedModifiers.length,
        };
        if (constructionErrors.length > 0) {
          okResponse.dropped_candidates = constructionErrors;
          okResponse.note = `${constructionErrors.length} candidate(s) were rejected (see dropped_candidates). The remaining ${enrichedHeads.length} head and ${enrichedModifiers.length} modifier candidate(s) are showing on the ${T.builder}. Re-call suggest_construction_buttons with corrected versions if you want the dropped concepts back.`;
        }
        return { id: call.id, name, response: okResponse };
      }

      case "set_construction_memory_chips": {
        const category = args.category;
        const validCategories = new Set(["who", "do", "what", "where", "when"]);
        if (typeof category !== "string" || !validCategories.has(category)) {
          return { id: call.id, name, response: { error: "Invalid category" } };
        }
        const rawChips = Array.isArray(args.chips) ? args.chips : [];
        const chips = rawChips
          .filter((c): c is { key: string; label: string } =>
            !!c && typeof c.key === "string" && typeof c.label === "string" &&
            c.key.trim().length > 0 && c.label.trim().length > 0
          )
          .slice(0, 3)
          .map((c) => ({ key: c.key.trim(), label: c.label.trim() }));

        this.send({
          type: "construction_memory_chips",
          data: { category: category as ConstructionMemoryChipsWire["category"], chips },
        });
        logLiveSession("CONSTRUCTION_MEMORY_CHIPS", `category=${category} chips=[${chips.map(c => c.key).join(", ")}]`);
        return { id: call.id, name, response: { output: "ok", count: chips.length } };
      }

      case "add_buttons": {
        const parsedButtons = dedupeImageKeys(toolArgsToButtons(args[T.paramUserResponseButtons] ?? args.buttons));
        const validation = validateBoardButtons(parsedButtons);
        const incomingAdd = validation.buttons;
        if (validation.errors.length > 0) {
          logLiveSession("BOARD_VALIDATION", `add_buttons dropped ${validation.errors.length} button(s): ${validation.errors.join(" | ")}`);
        }
        const maxSlots = state?.maxBoardItems || 8;

        // When a prebuilt board is loaded, redirect to rebuild_board for the side panel
        if (state?.loadedBoardId) {
          return {
            id: call.id,
            name,
            response: { error: "Cannot add ${T.button}s to a prebuilt ${T.board}. Call rebuild_board() to replace it with a dynamic ${T.board}, or use add_context_button() to add to the context sidebar." },
          };
        }

        // Same smart-merge path as rebuild_board. Previously add_buttons
        // split overflow onto the context sidebar — that meant tapping
        // "More" with a full board silently dropped the new suggestions.
        // Routing through smartMergeButtons fixes that: leftover existing
        // buttons get displaced (with fade-out / fade-in animation) so
        // every incoming button actually lands somewhere visible.
        const mergeResult = smartMergeButtons(
          this.lastEmittedMainButtons,
          incomingAdd,
          maxSlots,
          () => `btn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const buttons = mergeResult.merged;
        this.lastEmittedMainButtons = buttons;
        if (
          mergeResult.report.displacedIds.length > 0
          || mergeResult.report.duplicatesIgnored > 0
        ) {
          logLiveSession(
            "BOARD_MERGE",
            `add_buttons: kept=${mergeResult.report.preservedIds.length} added=${mergeResult.report.newIds.length} displaced=${mergeResult.report.displacedIds.length} dupes=${mergeResult.report.duplicatesIgnored}`
          );
        }
        if (state) {
          state.boardButtonLabels = buttons.map(b => b.label);
        }

        // Resolve existing symbols from DB
        const unresolvedKeys = await this.resolveExistingSymbols(buttons);
        this.queueMissingSymbolGeneration(buttons, unresolvedKeys);
        // Also resolve / queue every imageKey-shaped slot in each button's
        // glyph. Per-slot generation results stream back as
        // construction_symbol_ready WS messages and the renderer swaps
        // fallback → glyph automatically as each part lands.
        void this.resolveAndQueueGlyphParts(buttons);

        this.lastBoardUpdateTime = Date.now();

        // Evict any context-sidebar buttons that share a label with the new
        // main buttons — collision causes ambiguous sentence playback.
        const newMainLabelsLower = new Set(buttons.map(b => b.label.toLowerCase()));
        const removedFromContext: string[] = [];
        this.contextButtonLabels = this.contextButtonLabels.filter(label => {
          if (newMainLabelsLower.has(label.toLowerCase())) {
            removedFromContext.push(label);
            return false;
          }
          return true;
        });
        for (const label of removedFromContext) {
          this.send({ type: "context_button_remove", data: { label } });
        }

        // Emit the full merged board (same shape as rebuild_board) so the
        // client can run its AnimatePresence transitions over the entire
        // delta in one frame.
        this.send({ type: "board", data: this.buildBoardFromButtons(buttons) });
        this.turnAccum.boardChanged = true;
        this.turnAccum.boardAddLabels.push(
          ...mergeResult.report.newIds
            .map((id) => buttons.find(b => b.id === id)?.label)
            .filter((l): l is string => !!l)
        );

        let stateMsg = "";
        if (state) {
          const available = maxSlots - state.boardButtonLabels.length;
          stateMsg = `Board: ${state.boardButtonLabels.length}/${maxSlots} buttons (${available} available): ${state.boardButtonLabels.join(", ")}`;
          if (mergeResult.report.displacedIds.length > 0) {
            stateMsg += `. ${mergeResult.report.displacedIds.length} previous button(s) displaced to make room.`;
          }
        }

        const addResponse: Record<string, unknown> = { output: "ok", board_state: stateMsg };
        if (validation.errors.length > 0) {
          // Surface dropped-button errors so the AI can retry. The kept
          // buttons are still on the board; this is a soft warning, not a
          // hard reject.
          addResponse.dropped_buttons = validation.errors;
          addResponse.note = `${validation.errors.length} button(s) were rejected (see dropped_buttons). The remaining buttons are on the board. Call add_buttons() again with corrected versions if you want the dropped concepts back.`;
        }
        return { id: call.id, name, response: addResponse };
      }

      case "remove_buttons": {
        const labels = args.labels as string[] || [];
        const maxSlots = state?.maxBoardItems || 12;

        if (state?.loadedBoardId) {
          return {
            id: call.id,
            name,
            response: { error: "Cannot remove ${T.button}s from a prebuilt ${T.board}. Call rebuild_board() to replace it with a dynamic ${T.board}." },
          };
        }

        if (state) {
          const removeSet = new Set(labels.map(l => l.toLowerCase()));
          state.boardButtonLabels = state.boardButtonLabels.filter(l => !removeSet.has(l.toLowerCase()));
        }

        this.lastBoardUpdateTime = Date.now();
        this.send({ type: "board_patch", data: { add: [], remove: labels } });
        this.turnAccum.boardChanged = true;
        this.turnAccum.boardRemoveLabels.push(...labels);

        let stateMsg = "";
        if (state) {
          const available = maxSlots - state.boardButtonLabels.length;
          stateMsg = `Board: ${state.boardButtonLabels.length}/${maxSlots} buttons (${available} available): ${state.boardButtonLabels.join(", ") || "none"}`;
        }

        return { id: call.id, name, response: { output: "ok", board_state: stateMsg } };
      }

      case "rebuild_board": {
        // rebuild_board ALWAYS replaces the main board (max 8 buttons). If a custom
        // board is currently loaded, it's unloaded first. The side panel (context
        // sidebar) is separate and managed only by add_context_button.

        // Optional `own_speech` parameter (renamed from `response` to
        // disambiguate from "USER ${T.board}" — the board is the
        // STUDENT'S responses, this param is the AI's own statement).
        // Model's declaration of what it intends to say aloud alongside
        // this board update. NOT routed through TTS; the model still
        // produces native audio for the actual speech. Writing the
        // speech text in the tool call is meant to help the model
        // commit to producing the audio (the function-call pathway is
        // more reliable on this model than audio output alone). The
        // text is logged for the monitor agent and shows up in the UI.
        //
        // We deliberately do NOT use extractStringArg's "first string in
        // args" fallback here: that path falsely promoted the `buttons`
        // arg to "intended speech" whenever the model omitted own_speech,
        // polluting the auto-continuation kick text with the button list.
        // Strict lookup only — both the new name and the legacy `response`
        // alias for back-compat with any cached/in-flight model output.
        const rawOwnSpeech = args[T.paramOwnSpeech] ?? args.response;
        const responseText = typeof rawOwnSpeech === "string" ? rawOwnSpeech.trim() : "";
        if (responseText) {
          // Recorded as INTENDED speech, NOT actual speech. We don't add it
          // to speakText (which tracks actual audio output via
          // outputTranscription) — the auto-continuation logic uses the
          // gap between intended speech and produced audio to decide
          // whether to nudge.
          this.turnAccum.rebuildBoardIntendedSpeech = responseText;
          logLiveSession("REBUILD_BOARD own_speech param", responseText);
          // NOTE: We deliberately do NOT send the own_speech text to the
          // client here. The visible header text comes from the model's
          // actual outputTranscription as it speaks the audio. Emitting
          // it now would double-print: rebuild_board's own_speech → "X"
          // appended; then the auto-continuation nudge fires → model
          // speaks → outputTranscription chunks of "X" appended to the
          // SAME accumulator (no `complete` event resets the buffer
          // between the two turns). Net result: header shows "XX". The
          // intended-speech string is kept purely for auto-continuation
          // steering (see handleTurnComplete).
        }

        const wasPrebuiltLoaded = !!state?.loadedBoardId;
        const maxSlots = 8;
        const parsedRebuild = dedupeImageKeys(toolArgsToButtons(args[T.paramUserResponseButtons] ?? args.buttons).slice(0, maxSlots));
        const rebuildValidation = validateBoardButtons(parsedRebuild);
        const incomingRebuild = rebuildValidation.buttons;
        if (rebuildValidation.errors.length > 0) {
          logLiveSession("BOARD_VALIDATION", `rebuild_board dropped ${rebuildValidation.errors.length} button(s): ${rebuildValidation.errors.join(" | ")}`);
        }

        // Switching out of a prebuilt board clears any prior merge
        // snapshot — the previous slots belong to a different layout
        // and shouldn't influence what comes next. The error-recovery
        // flag is cleared too: any pending "fix" applies only to the
        // dynamic-board state that triggered the validation error.
        if (wasPrebuiltLoaded) {
          this.lastEmittedMainButtons = [];
          this.rebuildBoardErrorRecoveryPending = false;
        }

        // rebuild_board is normally a FULL REPLACE — the AI's intent is
        // "wipe the board and put exactly this set on it". The smart
        // merge is reserved for error recovery: when a previous
        // rebuild_board call had buttons dropped by validation, the
        // AI's follow-up is treated as a fix and merged with the
        // surviving partial board so corrected buttons rejoin the
        // already-shown ones instead of clobbering them.
        const isErrorRecovery = this.rebuildBoardErrorRecoveryPending;
        this.rebuildBoardErrorRecoveryPending = false;
        let buttons: MergeButton[];
        if (isErrorRecovery && this.lastEmittedMainButtons.length > 0) {
          const mergeResult = smartMergeButtons(
            this.lastEmittedMainButtons,
            incomingRebuild,
            maxSlots,
            () => `btn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          );
          buttons = mergeResult.merged;
          logLiveSession(
            "BOARD_MERGE",
            `rebuild_board (error recovery): kept=${mergeResult.report.preservedIds.length} added=${mergeResult.report.newIds.length} displaced=${mergeResult.report.displacedIds.length} dupes=${mergeResult.report.duplicatesIgnored}`
          );
        } else {
          // Normal path — replace wholesale. Mint fresh IDs so the
          // client treats every button as freshly-arrived (fade-in via
          // the existing motion.button animation).
          buttons = incomingRebuild.map((b, i) => ({
            ...b,
            id: `btn-${Date.now()}-${i}`,
          }));
        }
        this.lastEmittedMainButtons = buttons;

        if (state) {
          state.loadedBoardId = null;
          state.loadedBoardData = undefined;
          state.currentPageId = null;
          state.pageHistory = [];
          state.maxBoardItems = maxSlots;
          state.aiAddedButtonLabels = [];
          state.boardButtonLabels = buttons.map(b => b.label);
        }

        const unresolvedKeys = await this.resolveExistingSymbols(buttons);
        this.queueMissingSymbolGeneration(buttons, unresolvedKeys);
        // Per-slot generation for every imageKey embedded in a glyph.
        // Client renders the fallback string until each part resolves;
        // construction_symbol_ready events drive the live swap.
        void this.resolveAndQueueGlyphParts(buttons);

        // Evict any context-sidebar buttons whose label collides with the new
        // main board — same-label buttons on both sidebars cause ambiguous
        // sentence playback when the user taps "the wrong one".
        const newMainLabelsLower = new Set(buttons.map(b => b.label.toLowerCase()));
        const removedFromContext: string[] = [];
        this.contextButtonLabels = this.contextButtonLabels.filter(label => {
          if (newMainLabelsLower.has(label.toLowerCase())) {
            removedFromContext.push(label);
            return false;
          }
          return true;
        });
        for (const label of removedFromContext) {
          this.send({ type: "context_button_remove", data: { label } });
        }
        if (removedFromContext.length > 0) {
          logLiveSession("CONTEXT_BUTTON", `Evicted on rebuild (collide with main): ${removedFromContext.join(", ")}`);
        }

        this.lastBoardUpdateTime = Date.now();
        if (wasPrebuiltLoaded) {
          this.send({ type: "unload_board", data: {} });
        }
        this.send({ type: "board", data: this.buildBoardFromButtons(buttons) });


        this.turnAccum.boardChanged = true;
        this.turnAccum.boardRebuilt = true;
        this.turnAccum.boardAddLabels.push(...buttons.map(b => b.label));

        // Guessing mode: exit if no [GUESS] buttons in the rebuild
        if (this.guessingMode && !buttons.some(b => b.buttonType === "guess")) {
          this.guessingMode = false;
          this.send({ type: "guessing_mode", active: false });
          logLiveSession("GUESSING_MODE", "Exited — rebuild_board has no [GUESS] buttons");
        }

        const stateMsg = `Main board rebuilt. ${buttons.length}/${maxSlots} buttons: ${buttons.map(b => b.label).join(", ")}`;
        const rebuildResponse: Record<string, unknown> = { output: "ok", board_state: stateMsg };
        if (rebuildValidation.errors.length > 0) {
          rebuildResponse.dropped_buttons = rebuildValidation.errors;
          rebuildResponse.note = `${rebuildValidation.errors.length} ${T.button}(s) were rejected (see dropped_buttons). The ${T.board} is now showing the rest of the rebuild. Call rebuild_board() again with corrected versions of the dropped ${T.button}s — that follow-up will be MERGED with the surviving partial ${T.board} (it won't wipe it), so you only need to resend the ${T.button}s you want to fix or add back.`;
          // Arm error-recovery: the next rebuild_board call will be
          // treated as a patch, merged with the partial board above.
          this.rebuildBoardErrorRecoveryPending = true;
        }
        return { id: call.id, name, response: rebuildResponse };
      }

      case "set_board": {
        const boardKey = extractStringArg(args, "board_key").toLowerCase().replace(/ /g, "_");
        if (!state) {
          return { id: call.id, name, response: { error: "No session state" } };
        }
        const match = state.availableBoards?.find(b => b.key === boardKey);
        if (!match) {
          const availableKeys = state.availableBoards?.map(b => b.key).join(", ") || "none";
          return { id: call.id, name, response: { error: `Board "${boardKey}" not found. Available: ${availableKeys}` } };
        }

        try {
          // Virtual home board is in memory, not the DB
          let boardData: any;
          if (match.key === HOME_BOARD_KEY && this.homeBoardData) {
            boardData = this.homeBoardData;
          } else {
            const fullBoard = await boardRepository.getBoard(match.id);
            if (!fullBoard?.irData) {
              return { id: call.id, name, response: { error: "Board has no data" } };
            }
            boardData = fullBoard.irData as any;
          }
          state.loadedBoardId = match.id;
          state.loadedBoardData = boardData;
          state.permittedWebsites = mergeBoardWebsitesIntoPermitted(state.permittedWebsites, boardData);
          state.currentPageId = boardData.pages?.[0]?.id || null;
          state.pageHistory = [];
          state.maxBoardItems = (boardData.grid?.rows || 3) * (boardData.grid?.cols || 4);
          state.aiAddedButtonLabels = [];
          const nativeLabels = this.getNativePageButtonLabels(state);
          state.boardButtonLabels = [...nativeLabels];
          // The prebuilt board is the new ground truth — clear the
          // dynamic-board merge snapshot so a later switch back to a
          // dynamic board doesn't try to thread continuity through the
          // prebuilt buttons (those aren't ours to displace).
          this.lastEmittedMainButtons = [];

          this.send({ type: "set_board", data: { board: boardData, name: match.name, boardId: match.id } });
          this.turnAccum.setBoardName = match.name;
          this.turnAccum.boardChanged = true;

          logDualAgent("LiveRelay.setBoard", { sessionId: this.sessionId, boardName: match.name, boardId: match.id });

          return {
            id: call.id,
            name,
            response: {
              output: "ok",
              board_name: match.name,
              pages: boardData.pages?.length || 1,
              board_buttons: nativeLabels.join(", "),
              note: "${T.board} loaded. Its ${T.button}s are shown in the main area and cannot be modified by add_buttons/remove_buttons. To replace it with a dynamic ${T.board}, call rebuild_board(). The context sidebar (left) is separate — use add_context_button() for environment observations.",
            },
          };
        } catch (err) {
          return { id: call.id, name, response: { error: `Failed to load board: ${(err as Error).message}` } };
        }
      }

      case "press_button": {
        const label = extractStringArg(args, "label").trim();
        if (!state?.loadedBoardData) {
          return { id: call.id, name, response: { error: "No custom board loaded" } };
        }

        const currentPage = state.loadedBoardData.pages?.find((p: any) => p.id === state.currentPageId)
          || state.loadedBoardData.pages?.[0];
        if (!currentPage?.buttons) {
          return { id: call.id, name, response: { error: "Current page has no buttons" } };
        }

        const btn = currentPage.buttons.find((b: any) =>
          b.label.toLowerCase().trim() === label.toLowerCase().trim()
        );
        if (!btn?.action) {
          return { id: call.id, name, response: { error: `Button "${label}" not found or has no action` } };
        }

        const navResult = this.executeButtonNavigation(btn, state);
        this.turnAccum.pressButtonLabel = label;
        this.turnAccum.boardChanged = true;

        return { id: call.id, name, response: navResult };
      }

      case "emote": {
        const emotion = extractStringArg(args, "emotion", "neutral");
        if (state) {
          state.currentEmote = emotion as any;
        }
        this.send({ type: "emote", data: emotion });
        this.turnAccum.emote = emotion as any;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "open_app": {
        const appId = extractStringArg(args, "app_id");
        const data = args.data as string | undefined;

        // If the id matches a built-in AAC app, use the existing flow.
        const builtIn = getAppDefinition(appId);
        if (builtIn) {
          this.turnAccum.openAppData = { appId, data };

          // YouTube and Spotify need a search to resolve a specific video/track
          // before the client can render anything. We run the search in the
          // post-turn handler and send `video_play` / `app_open` (with trackId)
          // from there. For YouTube with permitted channels, an empty query is
          // valid (returns most-recent). For YouTube without channels + no API
          // key, the search will return null and we need to tell the model.
          if (appId === "youtube") {
            const channels = state?.permittedYoutubeChannels || [];
            const videos = state?.permittedYoutubeVideos || [];
            const hasChannels = channels.length > 0;
            const hasVideos = videos.length > 0;
            const hasApiKey = !!process.env.YOUTUBE_API_KEY;

            // No data + nothing configured → nothing to show. Tell the AI.
            if (!data && !hasChannels && !hasVideos) {
              return {
                id: call.id,
                name,
                response: {
                  output: "error: open_app(youtube) needs a `data` parameter (search query) when no permitted channels or pinned videos are configured. Pass e.g. 'counting songs'.",
                },
              };
            }
            // No channels/videos and no API key → search can't run at all.
            if (!hasChannels && !hasVideos && !hasApiKey) {
              return {
                id: call.id,
                name,
                response: {
                  output: "error: YouTube is unavailable — no permitted channels or pinned videos are configured and no API key is set. Tell the user this activity isn't available and suggest something else.",
                },
              };
            }
            // No data + channels/videos → open the browse UI so the user
            // picks something manually. Don't run a search, don't auto-play.
            if (!data && (hasChannels || hasVideos)) {
              this.send({
                type: "app_open",
                data: { appId: "youtube", appData: { channels, videos } },
              });
              // Clear openAppData so the post-turn handler doesn't also run a search.
              this.turnAccum.openAppData = null;
              return {
                id: call.id,
                name,
                response: {
                  output: "ok. The YouTube app is now open showing the available videos and channels. The student will pick something. Call rebuild_board() with ${T.button}s relevant to this activity. You'll receive a [YOUTUBE] context update when they pick a video.",
                },
              };
            }
            // Data + channels/videos/key → search-to-play. The post-turn handler
            // checks pinned videos first, then channel RSS, then API search.
            return {
              id: call.id,
              name,
              response: { output: "ok. Looking up a video now — the player will appear on screen in a moment. Call rebuild_board() with ${T.button}s relevant to this activity." },
            };
          }

          const needsSearch = data && appId === "spotify";
          if (!needsSearch) {
            this.send({ type: "app_open", data: { appId, data } });
          }
          return {
            id: call.id,
            name,
            response: { output: "ok. The app is now open on screen. Call rebuild_board() with contextual ${T.button}s relevant to this app activity." },
          };
        }

        // Otherwise assume it's a custom app (game) — load + ship to client.
        try {
          const app = await customAppRepository.getApp(appId);
          if (!app) {
            return { id: call.id, name, response: { output: `error: app ${appId} not found` } };
          }
          const validation = validateCustomAppDefinition(app.definition);
          if (!validation.ok) {
            return {
              id: call.id,
              name,
              response: { output: `error: custom app definition is invalid: ${validation.errors.slice(0, 2).join("; ")}` },
            };
          }
          this.send({
            type: "app_open",
            data: {
              appId: "custom_app",
              appData: { id: app.id, definition: validation.data },
            },
          });
          return {
            id: call.id,
            name,
            response: {
              output:
                "ok. The game is now on screen. The student is playing. You will receive [GAME] context updates as they play — narrate, encourage, and guide. Call rebuild_board() with contextual ${T.button}s relevant to this game.",
            },
          };
        } catch (err) {
          return { id: call.id, name, response: { output: `error: ${String(err)}` } };
        }
      }

      case "close_app": {
        this.turnAccum.closeApp = true;
        this.send({ type: "app_close", data: {} });
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "open_website": {
        const url = extractStringArg(args, "url");
        const label = (args.label as string | undefined)?.trim() || url;
        if (!url) {
          return { id: call.id, name, response: { output: "error: url is required" } };
        }

        const permitted = state?.permittedWebsites || [];
        if (!isUrlPermitted(url, permitted)) {
          return {
            id: call.id,
            name,
            response: { output: `error: the URL "${url}" is not in the permitted-websites list. Choose a URL that matches one of the permitted entries (or ask the caretaker to add it).` },
          };
        }

        this.turnAccum.openWebsiteData = { url, label };
        this.send({ type: "app_open", data: { appId: "browser", appData: { url, label } } });
        return {
          id: call.id,
          name,
          response: {
            output: `ok. The browser is now open at ${url}. Call rebuild_board() with contextual ${T.button}s relevant to the site. You will receive [BROWSER] updates as the user navigates.`,
          },
        };
      }


      case "call_monitor": {
        const reason = args.reason as string || "unspecified";
        this.turnAccum.callMonitorReason = reason;
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "binary_choice":
      case "ask_binary_choice": {
        const opt1Raw = args.option1;
        const opt2Raw = args.option2;
        if (typeof opt1Raw !== "string" || typeof opt2Raw !== "string" || !opt1Raw.trim() || !opt2Raw.trim()) {
          return { id: call.id, name, response: { error: "option1 and option2 are required (sentence|glyph|fallback|label)" } };
        }
        // Each option uses the same pipe-separated button syntax as the rest
        // of the board — reuse parseBoardButtons so glyph/fallback/imageKey
        // are resolved the same way, then take the first parsed button per
        // option (defensive against the model packing a comma inside one).
        const opt1 = parseBoardButtons(opt1Raw)[0];
        const opt2 = parseBoardButtons(opt2Raw)[0];
        if (!opt1 || !opt2) {
          return { id: call.id, name, response: { error: "could not parse option1/option2 — expected sentence|glyph|fallback|label" } };
        }
        this.send({ type: name as "binary_choice" | "ask_binary_choice", data: { options: [opt1, opt2] } });
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "request_focus": {
        const reason = args.reason as string || "";
        this.turnAccum.focusReason = reason;
        this.send({ type: "focus_request", data: { reason } });
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "set_interaction_mode": {
        const mode = args.mode as string;
        const reason = (args.reason as string) || "";
        if (mode !== "interact" && mode !== "assist" && mode !== "standby") {
          return { id: call.id, name, response: { error: "mode must be 'interact', 'assist', or 'standby'" } };
        }
        logLiveSession("MODE CHANGE (AI)", `→ ${mode} (reason: ${reason})`);
        // "assist" / "standby" are lighter states — AI stays active but less proactive.
        // Don't change muteState (that's user-controlled via cave click).
        // Instead, set the avatar emote and notify the client.
        this.send({ type: "interaction_mode_changed", data: { mode, reason, source: "ai" } });
        // First entry into interact mode in this session (or first entry after
        // waking from hibernation) — nudge the AI to greet now that presence
        // is confirmed. Skip when muted: the AI must not speak in mute mode.
        if (
          mode === "interact" &&
          !this.hasGreetedInteract &&
          this.muteState !== "muted" &&
          this.provider
        ) {
          // Voice-first phrasing — analytical checklists trigger proactivity to
          // route the greeting silently into rebuild_board.response instead of
          // emitting native audio. Make the audio command explicit and primary.
          const hour = new Date().getHours();
          const partOfDay =
            hour < 5 ? "night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "night";
          const presenceClause = reason ? ` ${reason}` : "";
          const greetingNudge = `[GREET]${presenceClause} You are now in interact mode (${partOfDay}). Greet them out loud right now using your voice — one short, warm sentence appropriate to the ${partOfDay} and what you can see of their mood. Immediately after greeting, call rebuild_board() with 3-4 follow-up ${T.button}s.`;
          logLiveSession("GREETING (interact entry)", greetingNudge);
          // sendMessage (turnComplete=true) — sendContextInjection would set
          // turnComplete=false and the nudge would just sit in the buffer until
          // the next frame_grid arrived, leaving the greeting silent.
          this.provider.sendMessage(greetingNudge, "user");
          // Mark this turn so AUTO_CONTINUATION (handleTurnComplete) can re-prompt
          // if the model produces a board with declared intent but no audio.
          this.lastTurnHadGreet = true;
          // Tracks across the whole greet+retry sequence — latches hasGreetedInteract
          // only when audio actually comes out, even if it takes an auto-continuation.
          this.greetAudioPending = true;
          // Note: hasGreetedInteract is NOT set here. We only latch it in
          // handleTurnComplete once the greet actually produces audio. Otherwise
          // a silent first attempt would lock the session out of ever greeting,
          // even if the model rapidly cycles standby ↔ interact afterwards.
        }
        return { id: call.id, name, response: { output: `mode set to ${mode}` } };
      }

      case "debug_message": {
        // Outside of debug context this is a no-op. During debug, the message
        // is captured by the handleToolCalls guard above, not here.
        logLiveSession("IGNORED TOOL CALL", `debug_message outside debug context`);
        return { id: call.id, name, response: { output: "ok" } };
      }

      case "wake_up": {
        // RESTING → awake escalation requested by the model. Tell the client
        // to resume awake data-flow (heartbeat frames, continuous audio) and
        // queue the server-side profile switch (full prompt + tools + loose
        // compression). The switch is applied on next idle by
        // handleTurnComplete's drain — switching mid-turn would drop this
        // turn's reply.
        const reason = extractStringArg(args, "reason").trim() || "unspecified";
        logLiveSession("WAKE_UP TOOL", reason);
        this.send({ type: "sleep_state_change", data: { state: "awake", source: "ai" } });
        this.recordSleepStateChange("awake", "ai");
        this.profileSwitchPending = "awake";
        return { id: call.id, name, response: { output: "waking to full interaction" } };
      }

      case "sleep": {
        logLiveSession("SLEEP TOOL", "AI requested transition to Asleep");
        this.send({ type: "sleep_state_change", data: { state: "asleep", source: "ai" } });
        this.recordSleepStateChange("asleep", "ai");
        return { id: call.id, name, response: { output: "session marked asleep" } };
      }

      case "end_session": {
        logLiveSession("END_SESSION TOOL", "AI requested transition to Hibernation");
        this.send({ type: "sleep_state_change", data: { state: "hibernation", source: "ai" } });
        this.recordSleepStateChange("hibernation", "ai");
        return { id: call.id, name, response: { output: "session ended" } };
      }

      case "report_false_wake": {
        const reason = (args.reason as string) || "unspecified";
        logLiveSession("FALSE_WAKE TOOL", `reason: ${reason}`);
        this.send({ type: "false_wake_report", data: { reason } });
        return { id: call.id, name, response: { output: "false wake noted" } };
      }

      case "stay_silent": {
        const reason = extractStringArg(args, "reason").trim();
        if (!reason) {
          return { id: call.id, name, response: { error: "reason is required" } };
        }
        logLiveSession("STAY_SILENT", reason);
        this.turnAccum.staySilentReason = reason;
        // Persist to pendingMessages so the monitor agent and any future
        // reconnection sees it as part of the conversation history. It is
        // never sent to the client, so the user never sees or hears it.
        if (this.sessionId) {
          await dualAgentService.addPendingMessage(this.sessionId, {
            role: "assistant",
            content: `[STAY_SILENT] ${reason}`,
            timestamp: Date.now(),
          });
        }
        return { id: call.id, name, response: { output: "silence acknowledged" } };
      }

      case "private_note": {
        const note = extractStringArg(args, "note").trim();
        if (!note) {
          return { id: call.id, name, response: { error: "note is required" } };
        }
        logLiveSession("PRIVATE_NOTE", note);
        // Persist to pendingMessages so the monitor agent and any future
        // reconnection sees it as part of the conversation history. It is
        // never sent to the client, so the user never sees or hears it.
        if (this.sessionId) {
          await dualAgentService.addPendingMessage(this.sessionId, {
            role: "assistant",
            content: `[PRIVATE_NOTE] ${note}`,
            timestamp: Date.now(),
          });
        }
        return { id: call.id, name, response: { output: "noted" } };
      }

      default:
        console.warn(`[LiveRelay] Unknown tool call: ${name}`);
        return { id: call.id, name, response: { error: `Unknown tool: ${name}` } };
    }
  }

  /**
   * Execute a navigation button press on a custom board.
   */
  private executeButtonNavigation(btn: any, state: DualAgentSessionState): Record<string, unknown> {
    const action = btn.action;

    if (action.type === "link" && action.toPageId) {
      const targetPage = state.loadedBoardData?.pages?.find((p: any) => p.id === action.toPageId);
      if (!targetPage) return { error: "Target page not found" };

      if (state.currentPageId) {
        state.pageHistory = [...(state.pageHistory || []), state.currentPageId];
      }
      state.currentPageId = targetPage.id;
      state.aiAddedButtonLabels = [];
      state.boardButtonLabels = this.getNativePageButtonLabels(state);

      this.send({
        type: "ai_button_press",
        data: {
          label: btn.label,
          action: "link",
          targetPageId: targetPage.id,
          targetPageName: targetPage.name || targetPage.id,
          buttons: targetPage.buttons || [],
        },
      });

      if (this.sessionId) {
        dualAgentService.addPendingMessage(this.sessionId, {
          role: "assistant",
          content: `[AI navigated to page "${targetPage.name || targetPage.id}"]`,
          timestamp: Date.now(),
        }).catch(err => console.error("[LiveRelay] Failed to persist nav message:", err));
      }

      const buttonLabels = (targetPage.buttons || []).map((b: any) => b.label).join(", ");
      return { output: "ok", page: targetPage.name || targetPage.id, buttons: buttonLabels };
    }

    if (action.type === "back") {
      const history = state.pageHistory || [];
      if (history.length === 0) return { error: "No page history to go back to" };

      const prevPageId = history[history.length - 1];
      state.pageHistory = history.slice(0, -1);
      state.currentPageId = prevPageId;
      state.aiAddedButtonLabels = [];
      state.boardButtonLabels = this.getNativePageButtonLabels(state);

      const prevPage = state.loadedBoardData?.pages?.find((p: any) => p.id === prevPageId);
      if (prevPage) {
        this.send({
          type: "ai_button_press",
          data: {
            label: btn.label,
            action: "back",
            targetPageId: prevPageId,
            targetPageName: prevPage.name || prevPageId,
            buttons: prevPage.buttons || [],
          },
        });
        const buttonLabels = (prevPage.buttons || []).map((b: any) => b.label).join(", ");
        return { output: "ok", page: prevPage.name || prevPageId, buttons: buttonLabels };
      }
      return { output: "ok" };
    }

    if (action.type === "home") {
      const homePage = state.loadedBoardData?.pages?.[0];
      if (!homePage) return { error: "No home page found" };

      state.pageHistory = [];
      state.currentPageId = homePage.id;
      state.aiAddedButtonLabels = [];
      state.boardButtonLabels = this.getNativePageButtonLabels(state);

      this.send({
        type: "ai_button_press",
        data: {
          label: btn.label,
          action: "home",
          targetPageId: homePage.id,
          targetPageName: homePage.name || homePage.id,
          buttons: homePage.buttons || [],
        },
      });
      const buttonLabels = (homePage.buttons || []).map((b: any) => b.label).join(", ");
      return { output: "ok", page: homePage.name || homePage.id, buttons: buttonLabels };
    }

    if (action.type === "exit") {
      // Unload the board and return to the dynamic board
      state.loadedBoardId = null;
      state.loadedBoardData = undefined;
      state.currentPageId = null;
      state.pageHistory = [];
      state.aiAddedButtonLabels = [];
      state.boardButtonLabels = [];
      state.maxBoardItems = 12;

      this.send({ type: "unload_board", data: {} });

      const instruction = action.text || "";

      // Detect guessing mode entry
      if (instruction.includes("[GUESSING MODE]") && !this.guessingMode) {
        this.guessingMode = true;
        this.send({ type: "guessing_mode", active: true });
        logLiveSession("GUESSING_MODE", "Entered via home board button");
      }

      const message = instruction
        ? `Board exited. The user pressed "${btn.label}". ${instruction}`
        : `${T.board} exited. The user pressed "${btn.label}". Use rebuild_board() to create a new ${T.board} or set_board() to load another.`;

      return { output: message };
    }

    return { error: `Unknown action type: ${action.type}` };
  }

  // -------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------

  private async handleTurnComplete(reason?: string): Promise<void> {
    logLiveSession("handleTurnComplete", `state=${this.state} reason=${reason || "normal"} accum=[speak=${!!this.turnAccum.speakText}, interpret=${!!this.turnAccum.interpretText}, board=${this.turnAccum.boardChanged}, directAudioChunks=${this.directAudioChunks.length}]`);

    // Snapshot the auto-continuation flag and clear it eagerly. If this turn
    // is itself the response to a continuation prompt we sent last time, the
    // snapshot blocks us from firing a second continuation; the cleared field
    // means the *next* genuinely-silent transcript can fire normally.
    const wasAutoContinuationPending = this.autoContinuationPending;
    this.autoContinuationPending = false;

    // Same snapshot-and-clear pattern for the button-press flag. If this turn
    // was a response to a button press, the snapshot is true; the flag is
    // cleared so subsequent turns (frame_grids, etc.) don't false-trigger
    // the nudge.
    const wasButtonPressTurn = this.lastTurnHadButtonPress;
    this.lastTurnHadButtonPress = false;

    // Same for the [GREET] system message we send on first interact entry —
    // but only consume the flag if this turn carries real content. The very
    // next TURN_COMPLETE after sending GREET is the close of the
    // set_interaction_mode tool turn (no audio, no rebuild_board, no transcript).
    // Treat that as transparent and let the flag carry forward to the actual
    // response turn that follows ~1s later.
    const turnHasContent =
      this.directAudioChunks.length > 0 ||
      this.turnAccum.speakText.trim().length > 0 ||
      (this.turnAccum.rebuildBoardIntendedSpeech?.trim().length ?? 0) > 0 ||
      this.turnAccum.transcriptText.trim().length > 0 ||
      !!this.turnAccum.staySilentReason;
    const wasGreetTurn = this.lastTurnHadGreet && turnHasContent;
    if (this.lastTurnHadGreet && !turnHasContent) {
      logLiveSession("GREET FLAG PRESERVED", `intermediate empty tool-ack turn — waiting for real response`);
    }
    if (turnHasContent) {
      this.lastTurnHadGreet = false;
    }

    // If we were waiting for a debug-introspection response (the model calls
    // debug_message() to tell us what it tried), capture it and retry.
    if (this.awaitingDebugResponse) {
      this.awaitingDebugResponse = false;
      const debugAnswer = this.debugResponseBuffer.trim();
      this.debugResponseBuffer = "";
      logLiveSession("DEBUG RESPONSE", debugAnswer || "(empty)");
      // Discard any audio from the debug turn — it was for us, not the user
      if (this.directAudioFlushTimer) { clearTimeout(this.directAudioFlushTimer); this.directAudioFlushTimer = null; }
      this.directAudioChunks = [];
      this.turnAccum = createEmptyAccumulator();
      this.send({ type: "audio_interrupt" });

      // Ask the model to retry, providing its own description of what it tried.
      if (this.debugRetryCount < LiveRelay.DEBUG_MAX_RETRIES && this.provider) {
        this.debugRetryCount++;
        this.setState("awaiting_turn");
        const retryPrompt = `[RETRY ${this.debugRetryCount}/${LiveRelay.DEBUG_MAX_RETRIES}] You said you were trying to: ${debugAnswer || "(no description)"}. Try again now. If you were calling a tool, double-check the function name and argument schema and call ONLY ONE function this turn. If you were speaking, rephrase simply.`;
        logLiveSession("DEBUG RETRY PROMPT", retryPrompt);
        this.provider.sendMessage(retryPrompt, "user");
        return;
      }

      // Out of retries — give up and return to idle with a cooldown so
      // frame_grid doesn't immediately re-trigger the same cycle.
      logLiveSession("DEBUG RETRY EXHAUSTED", `Gave up after ${this.debugRetryCount} retries — cooldown ${LiveRelay.REJECTION_COOLDOWN_MS}ms`);
      this.debugRetryCount = 0;
      this.rejectionCooldownUntil = Date.now() + LiveRelay.REJECTION_COOLDOWN_MS;
      this.setState("idle");
      return;
    }

    // Abnormal turn ends (RESPONSE_REJECTED, MALFORMED_FUNCTION_CALL, etc.) —
    // discard any partial audio that streamed before the rejection. Otherwise the
    // user hears half-words from rejected responses, perceived as duplication.
    const isAbnormal = reason && reason !== "STOP" && reason !== "normal";
    if (isAbnormal) {
      const hadOutput = this.directAudioChunks.length > 0 || this.turnAccum.speakText.trim().length > 0 || this.turnAccum.boardChanged;

      // RESPONSE_REJECTED with zero output = proactiveAudio decided not to
      // respond, OR safety filter rejection. We retry ONCE in case it was a
      // proactive-audio swallow; if the retry also gets rejected, the content
      // is genuinely being filtered and re-sending will get the same result.
      // Clear pendingRetryPrompt before resending so a second rejection falls
      // through to cooldown rather than looping.
      if (reason === "RESPONSE_REJECTED" && !hadOutput) {
        if (this.pendingRetryPrompt && this.provider) {
          const promptToRetry = this.pendingRetryPrompt;
          this.pendingRetryPrompt = null;  // bound retries to one
          logLiveSession("RETRY PROMPT", "RESPONSE_REJECTED after user prompt — resending once");
          this.setState("awaiting_turn");
          this.provider.sendMessage(promptToRetry, "user");
          return;
        }
        logLiveSession("PROACTIVE_SKIP", `RESPONSE_REJECTED with no output — model chose not to respond (or content filter); cooling down`);
        this.debugRetryCount = 0;
        // Cooldown so the next frame_grid / scene update doesn't immediately
        // re-trigger the same content path and burn another rejection cycle.
        this.rejectionCooldownUntil = Date.now() + LiveRelay.REJECTION_COOLDOWN_MS;
        this.setState("idle");
        return;
      }

      logLiveSession("DISCARDING TURN", `reason=${reason} chunks=${this.directAudioChunks.length}`);
      if (this.directAudioFlushTimer) { clearTimeout(this.directAudioFlushTimer); this.directAudioFlushTimer = null; }
      this.directAudioChunks = [];
      this.turnAccum = createEmptyAccumulator();
      // Tell the client to stop any audio it's currently playing from this rejected turn
      this.send({ type: "audio_interrupt" });

      // On MALFORMED_FUNCTION_CALL or RESPONSE_REJECTED (with partial output),
      // optionally ask the model to introspect via the debug_message() tool.
      // Off by default — the round-trip can self-perpetuate: the retry prompt
      // forces the model to respond when it had nothing to say, which produces
      // a filler stall ("Let me check") with no tool call, which is itself
      // rejected as MALFORMED_FUNCTION_CALL, restarting the cycle. Opt-in via
      // env (AAC_DEBUG_INTROSPECTION=1) when actively debugging rejection bugs.
      const introspectionEnabled = process.env.AAC_DEBUG_INTROSPECTION === "1";
      if (introspectionEnabled && (reason === "MALFORMED_FUNCTION_CALL" || reason === "RESPONSE_REJECTED") && this.provider) {
        this.awaitingDebugResponse = true;
        this.debugResponseBuffer = "";
        this.setState("awaiting_turn");
        const debugQuery = reason === "RESPONSE_REJECTED"
          ? `[DEBUG] Your last response was rejected by the system. Call debug_message() with a description of what you were trying to do — what you were going to say and/or which function you were going to call with what arguments.`
          : `[DEBUG] Your last function call was rejected as MALFORMED. Call debug_message() with: 1) the function name you tried to call, 2) the arguments you tried to pass.`;
        logLiveSession(`${reason} DEBUG QUERY`, debugQuery);
        this.provider.sendMessage(debugQuery, "user");
        return;
      }

      // Apply rejection cooldown so the next frame_grid / scene update doesn't
      // immediately re-trigger the same rejected content path.
      this.rejectionCooldownUntil = Date.now() + LiveRelay.REJECTION_COOLDOWN_MS;
      this.debugRetryCount = 0;
      this.setState("idle");
      return;
    }

    // Empty turn — no tool calls happened and no direct audio
    if (this.state === "awaiting_turn") {
      const hasDirectAudio = this.useDirectAudio && this.directAudioChunks.length > 0;
      if (!hasDirectAudio) {
        // If a user prompt is pending, the model was swallowed by a
        // proactive-audio empty turn. Retry the prompt — once. Clear the
        // pending prompt before resending so a second empty turn doesn't loop.
        if (this.pendingRetryPrompt && this.provider) {
          const promptToRetry = this.pendingRetryPrompt;
          this.pendingRetryPrompt = null;
          logLiveSession("RETRY PROMPT", "Empty turn after user prompt — resending once");
          this.provider.sendMessage(promptToRetry, "user");
          return;  // stay in awaiting_turn
        }
        this.setState("idle");
        return;
      }
      // Direct audio only turn (no tool calls) — still needs processTurnEnd
    }

    // Already processing (shouldn't happen, but guard)
    if (this.state === "processing_turn") {
      logLiveSession("TURN_COMPLETE SKIPPED", "already processing");
      return;
    }

    // If we're idle, we might still have activity to process: Gemini Live's
    // built-in VAD can trigger spontaneous model turns (it hears the user
    // speak and starts generating audio without us sending turnComplete=true).
    // The audio arrives while state is idle, but it IS a real turn. Only
    // return early if absolutely nothing happened.
    if (this.state === "idle") {
      const hadActivity =
        this.directAudioChunks.length > 0 ||
        this.turnAccum.speakText.trim().length > 0 ||
        this.turnAccum.transcriptText.trim().length > 0 ||
        this.turnAccum.contextText.trim().length > 0 ||
        this.turnAccum.boardChanged ||
        !!this.turnAccum.staySilentReason;
      if (!hadActivity) {
        return;
      }
      // Activity happened in idle state — fall through to processTurnEnd so
      // audio is flushed and post-turn hooks fire. Note: we skip the auto-
      // continuation block below because the spontaneous-audio path means
      // either (a) the model already responded with audio, or (b) tool calls
      // ran and we want them to be handled normally.
      logLiveSession(
        "IDLE_TURN_RECOVERY",
        `state was idle but turn had activity — escalating to processing_turn (audio=${this.directAudioChunks.length}, transcript=${!!this.turnAccum.transcriptText.trim()}, board=${this.turnAccum.boardChanged})`,
      );
      this.setState("processing_turn");
      try {
        await Promise.race([
          this.processTurnEnd(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("processTurnEnd timed out after 60s")), 60_000),
          ),
        ]);
      } catch (err) {
        console.error("[LiveRelay] processTurnEnd error (idle recovery):", (err as Error).message);
        this.send({ type: "error", data: "error:TURN_FAILED" });
      } finally {
        this.turnAccum = createEmptyAccumulator();
        this.flushDirectAudio();
        this.directAudioChunks = [];
        this.preGenTtsPromise = null;
        this.pendingRetryPrompt = null;
        this.debugRetryCount = 0;
        this.setState("idle");
      }
      return;
    }

    // Auto-continuation: when the model "should have spoken" but didn't,
    // nudge it once. Trigger conditions:
    //   (a) transcript() called for the identified student + no audio
    //   (b) button press was sent + no audio
    //   (c) [GREET] system message was sent (interact-mode entry) + no audio
    // Plus the always-on guards:
    //   - We didn't already auto-continue on the previous turn (one retry max)
    //   - muteState === "unmuted"
    //   - The model didn't explicitly call stay_silent
    const noAudioThisTurn =
      this.directAudioChunks.length === 0 &&
      this.turnAccum.speakText.trim().length === 0;

    const studentName =
      this.sessionCache?.monitorAgent.getStudent?.()?.name?.trim() || "";
    const speaker = (this.turnAccum.transcriptSpeaker || "").trim();
    const studentFirstName = studentName.split(/\s+/)[0] || "";
    const speakerIsStudent =
      !!studentFirstName &&
      speaker.toLowerCase().includes(studentFirstName.toLowerCase());

    const transcriptTrigger =
      this.turnAccum.transcriptText.trim().length > 0 && speakerIsStudent;
    const buttonPressTrigger = wasButtonPressTurn;
    const greetTrigger = wasGreetTurn;

    // Latch hasGreetedInteract once audio actually arrives during the greet
    // window (covers both the direct-success case and the post-auto-continuation
    // case). Deferred from set_interaction_mode so a silent first attempt
    // doesn't permanently disable greeting on subsequent interact entries.
    if (this.greetAudioPending && !noAudioThisTurn) {
      this.hasGreetedInteract = true;
      this.greetAudioPending = false;
    }

    if (
      !wasAutoContinuationPending &&
      this.muteState === "unmuted" &&
      // In RESTING profile the model is SUPPOSED to stay silent — it
      // transcribes background speech without replying. Don't nag it to
      // "respond" after a resting-mode transcript().
      this.sessionProfile === "awake" &&
      noAudioThisTurn &&
      !this.turnAccum.staySilentReason &&
      this.provider &&
      (transcriptTrigger || buttonPressTrigger || greetTrigger)
    ) {
      const intent = this.turnAccum.rebuildBoardIntendedSpeech;
      const reason = greetTrigger
        ? (intent
          ? `greet, model declared intent "${intent.substring(0, 80)}" but did not speak it`
          : `greet, model produced no audio`)
        : buttonPressTrigger
        ? (intent
          ? `button press, model declared intent "${intent.substring(0, 80)}" but did not speak it`
          : `button press, model produced no audio`)
        : `transcript=${JSON.stringify(this.turnAccum.transcriptText.trim())} speaker=${speaker}`;
      logLiveSession("AUTO_CONTINUATION", `${reason} — re-prompting`);

      // Prompt is tailored to the trigger. When the model declared intent via
      // rebuild_board.response (button or greet path), echoing that intent back
      // is strong steering.
      let continuePrompt: string;
      if (greetTrigger && intent) {
        continuePrompt = `[continue] You declared you would greet with "${intent}" but didn't speak it aloud. Say it now in your own voice.`;
      } else if (greetTrigger) {
        continuePrompt = `[continue] You set interact mode but didn't greet aloud. Greet the user now in your own voice — one short sentence.`;
      } else if (buttonPressTrigger && intent) {
        continuePrompt = `[continue] You declared you would say "${intent}" but didn't speak it aloud. Say it now in your own voice.`;
      } else if (buttonPressTrigger) {
        continuePrompt = `[continue] The user tapped a ${T.button} but you didn't respond aloud. Respond now in your own voice.`;
      } else {
        // transcript trigger
        continuePrompt = `[continue] You transcribed the user's speech but did not respond. Speak your reply now in your own voice. Do not repeat their words or imitate their voice.`;
      }
      // Reset turn state so the next TURN_COMPLETE sees a clean accumulator
      // and can't retrigger this branch unless the model transcribes anew.
      this.turnAccum = createEmptyAccumulator();
      if (this.directAudioFlushTimer) {
        clearTimeout(this.directAudioFlushTimer);
        this.directAudioFlushTimer = null;
      }
      this.directAudioChunks = [];
      this.autoContinuationPending = true;
      this.setState("awaiting_turn");
      this.provider.sendMessage(continuePrompt, "user");
      return;
    }

    this.setState("processing_turn");
    try {
      const turnEndPromise = this.processTurnEnd();
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("processTurnEnd timed out after 60s")), 60_000)
      );
      await Promise.race([turnEndPromise, timeoutPromise]);
    } catch (err) {
      console.error("[LiveRelay] processTurnEnd error:", (err as Error).message);
      this.send({ type: "error", data: "error:TURN_FAILED" });
    } finally {
      this.turnAccum = createEmptyAccumulator();
      // Flush any remaining buffered audio before clearing
      this.flushDirectAudio();
      this.directAudioChunks = [];
      this.preGenTtsPromise = null;
      this.pendingRetryPrompt = null;
      // Reset retry counter on successful turn — only count consecutive failures
      this.debugRetryCount = 0;
      this.setState("idle");
    }
  }

  private handleInterrupted(): void {
    // Only tell the client to stop playback if we actually sent audio during
    // THIS turn. If the model interrupts an empty turn (e.g. a frame_grid
    // tick that produced nothing), the client may still be playing audio from
    // the PREVIOUS turn — interrupting that would cut the user off mid-sentence.
    const hasSentAudio = this.directAudioChunks.length > 0 || this.turnAccum.speakText.trim().length > 0;
    if (hasSentAudio) {
      this.send({ type: "audio_interrupt" });
    }
    logLiveSession("INTERRUPTED", `hasSentAudio=${hasSentAudio} chunks=${this.directAudioChunks.length} state=${this.state}`);
    this.turnAccum = createEmptyAccumulator();
    // Cancel pending flush and discard buffered audio
    if (this.directAudioFlushTimer) { clearTimeout(this.directAudioFlushTimer); this.directAudioFlushTimer = null; }
    this.directAudioChunks = [];
    this.preGenTtsPromise = null;
    this.setState("idle");
  }

  // -------------------------------------------------------------------------
  // Post-turn processing
  // -------------------------------------------------------------------------

  private async processTurnEnd(): Promise<void> {
    const isMuted = this.muteState === "muted";
    const state = this.sessionCache?.state;
    const accum = this.turnAccum;

    const fullSpeakText = accum.speakText.trim();
    const fullInterpretText = accum.interpretText.trim();
    const fullContextText = accum.contextText.trim();
    const fullTranscriptText = accum.transcriptText.trim();
    const callMonitorReason = accum.callMonitorReason || undefined;
    const openAppData = accum.openAppData || undefined;
    const closeAppTriggered = accum.closeApp;
    const focusReason = accum.focusReason || undefined;

    const boardRebuilt = accum.boardRebuilt;
    const boardAddLabels = accum.boardAddLabels;
    const boardRemoveLabels = accum.boardRemoveLabels;
    const boardAddCount = boardAddLabels.length;
    const boardRemoveCount = boardRemoveLabels.length;
    const hasBoardChange = accum.boardChanged;

    // Debug logging
    logDualAgent("LiveRelay.turnComplete", {
      sessionId: this.sessionId,
      toolCalls: [
        fullSpeakText && "speak",
        fullInterpretText && "interpret",
        fullTranscriptText && "transcript",
        fullContextText && "context",
        hasBoardChange && "board",
        callMonitorReason && "call_monitor",
      ].filter(Boolean).join(", ") || "(none)",
      speak: fullSpeakText || "(none)",
      interpret: fullInterpretText || "(none)",
      transcript: fullTranscriptText || "(none)",
      context: fullContextText.substring(0, 200) || "(none)",
      board: hasBoardChange
        ? {
            rebuilt: boardRebuilt,
            added: boardAddCount,
            removed: boardRemoveCount,
            addLabels: boardAddLabels.join(", "),
            removeLabels: boardRemoveLabels.join(", "),
          }
        : "(no changes)",
      callMonitor: callMonitorReason || false,
      setBoard: accum.setBoardName || false,
      pressButton: accum.pressButtonLabel || false,
      openApp: openAppData?.appId || false,
      closeApp: closeAppTriggered,
    });

    // -----------------------------------------------------------------------
    // 1. Persist messages
    // -----------------------------------------------------------------------
    if (state) {
      const now = Date.now();
      state.lastInteractiveActivity = now;

      const turnMessages: import("./types").PendingMessage[] = [];

      if (fullInterpretText) {
        turnMessages.push({
          role: "assistant",
          content: `[INTERPRET] ${fullInterpretText}`,
          timestamp: now,
        });
      }

      if (fullSpeakText) {
        turnMessages.push({
          role: "assistant",
          content: fullSpeakText,
          timestamp: now + 1,
        });
      }

      if (fullContextText) {
        turnMessages.push({
          role: "assistant",
          content: `[CONTEXT] ${fullContextText}`,
          timestamp: now + 2,
        });
      }

      if (fullTranscriptText) {
        turnMessages.push({
          role: "user",
          content: `[TRANSCRIPT] ${fullTranscriptText}`,
          timestamp: now + 3,
        });
      }

      if (callMonitorReason) {
        turnMessages.push({
          role: "assistant",
          content: `[CALL_MONITOR] ${callMonitorReason}`,
          timestamp: now + 4,
        });
      }

      if (hasBoardChange) {
        const boardSuffix = boardRebuilt
          ? `Board rebuilt: ${boardAddLabels.join(", ")}`
          : [
              boardAddCount > 0 ? `Added: ${boardAddLabels.join(", ")}` : "",
              boardRemoveCount > 0 ? `Removed: ${boardRemoveLabels.join(", ")}` : "",
            ].filter(Boolean).join(". ");
        turnMessages.push({
          role: "assistant",
          content: `[SYSTEM — Board changes: ${boardSuffix}]`,
          timestamp: now + 5,
        });
      }

      if (this.sessionId && turnMessages.length > 0) {
        dualAgentService.addPendingMessages(this.sessionId, turnMessages)
          .catch(err => console.error("[LiveRelay] Failed to persist turn messages:", err));
      }
    }

    // -----------------------------------------------------------------------
    // 2. App handling (YouTube/Spotify search)
    // -----------------------------------------------------------------------
    if (openAppData) {
      if (openAppData.appId === "youtube") {
        try {
          const channels = this.sessionCache?.state?.permittedYoutubeChannels || [];
          const videos = this.sessionCache?.state?.permittedYoutubeVideos || [];
          const query = (openAppData.data || "").trim();

          // 1. Pinned-video direct hit. Prefer videoId; fall back to exact
          //    label match (case-insensitive). This is the "AI picks a curated
          //    video by id or title" path.
          const pinnedHit = query
            ? findPinnedVideoMatch(query, videos)
            : null;
          if (pinnedHit) {
            logLiveSession(
              "YOUTUBE_PINNED_HIT",
              `query="${query}" matched="${pinnedHit.label}" id=${pinnedHit.videoId}`,
            );
            this.send({
              type: "video_play",
              data: {
                videoId: pinnedHit.videoId,
                title: pinnedHit.label,
                channels: channels.length > 0 ? channels : undefined,
                videos: videos.length > 0 ? videos : undefined,
              },
            });
            return;
          }

          const results = await searchYouTube(query, channels);
          if (results) {
            logLiveSession(
              "YOUTUBE_SEARCH",
              `query="${query || "(empty)"}" result="${results.title}" id=${results.videoId}`,
            );
            this.send({
              type: "video_play",
              data: {
                videoId: results.videoId,
                title: results.title,
                // Include permitted channels + pinned videos so the player can
                // offer a "← browse" button back to the approved content list.
                channels: channels.length > 0 ? channels : undefined,
                videos: videos.length > 0 ? videos : undefined,
              },
            });
          } else if (channels.length > 0 || videos.length > 0) {
            // No title matched — fall back to browse mode instead of playing
            // something unrelated. Student can pick from the curated set.
            logLiveSession(
              "YOUTUBE_SEARCH_NO_MATCH_BROWSE",
              `query="${query}" channels=${channels.length} videos=${videos.length}`,
            );
            this.send({
              type: "app_open",
              data: { appId: "youtube", appData: { channels, videos } },
            });
            this.provider?.sendContextInjection(
              `[SYSTEM] YouTube search for "${query}" didn't match any permitted video titles. The browser is now open on screen so the user can pick something themselves.`,
            );
          } else {
            // No channels and search returned null (e.g. API key missing or
            // quota exceeded). Nothing to show.
            logLiveSession(
              "YOUTUBE_SEARCH_EMPTY",
              `query="${query || "(empty)"}" hasKey=${!!process.env.YOUTUBE_API_KEY}`,
            );
            this.provider?.sendContextInjection(
              `[SYSTEM] YouTube search returned no videos for "${query}". The player is not open. Suggest a different activity.`,
            );
          }
        } catch (err) {
          console.error("[LiveRelay] YouTube search failed:", err);
          this.provider?.sendContextInjection(
            `[SYSTEM] YouTube search failed with an error. The player is not open. Suggest a different activity.`,
          );
        }
      } else if (openAppData.appId === "spotify" && openAppData.data) {
        let appData: any = { query: openAppData.data };
        try {
          const results = await searchSpotify(openAppData.data);
          if (results) {
            appData = { trackId: results.trackId, title: results.title, artist: results.artist, albumArt: results.albumArt };
          }
        } catch (err) {
          console.error("[LiveRelay] Spotify search failed:", err);
        }
        this.send({ type: "app_open", data: { appId: "spotify", appData } });
      }
    }

    // -----------------------------------------------------------------------
    // (Contact enrollment via AAC face-learning removed. New contacts are
    //  created from the Contacts panel; physical descriptors are populated
    //  server-side by the photo-analyzer AI pipeline on image upload.)
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // 4. TTS
    // -----------------------------------------------------------------------

    // Student voice (pre-generated from button press)
    if (this.preGenTtsPromise) {
      try {
        await this.preGenTtsPromise;
      } catch (err) {
        // Error already logged in the catch handler of the original promise
      }
      this.preGenTtsPromise = null;
    } else if (fullInterpretText && this.studentVoice) {
      // Normal path: Gemini called interpret() — synthesize student voice now
      try {
        await this.streamTtsWithTimeout(
          fullInterpretText,
          this.studentVoice,
          "interpretation_audio",
          "Student",
        );
      } catch (err) {
        console.error("[LiveRelay] Student TTS error:", (err as Error).message);
      }
    }

    // AI voice: direct audio chunks were already forwarded in real time via onAudioData,
    // so no buffered send needed. For external TTS mode, synthesize now.
    if (!this.useDirectAudio && fullSpeakText && !isMuted && this.aiVoice) {
      try {
        await this.streamTtsWithTimeout(
          fullSpeakText,
          this.aiVoice,
          "avatar_audio",
          "AI",
        );
      } catch (err) {
        console.error("[LiveRelay] AI TTS error:", (err as Error).message);
      }
    }

    // -----------------------------------------------------------------------
    // 5. Focus frame
    // -----------------------------------------------------------------------
    if (focusReason) {
      this.send({ type: "focus_request", data: { reason: focusReason } });
      console.log("[LiveRelay] Focus frame requested:", focusReason);
    }

    // -----------------------------------------------------------------------
    // 6. Monitor
    // -----------------------------------------------------------------------
    if (this.sessionId) {
      try {
        await dualAgentService.triggerMonitor(
          this.sessionId,
          !!callMonitorReason,
          state?.currentBoard,
        );
      } catch (err) {
        console.error("[LiveRelay] Monitor trigger failed:", err);
        this.send({ type: "monitor_status", data: { error: (err as Error).message } });
      }
    }

    // -----------------------------------------------------------------------
    // 7. Snapshot + complete
    // -----------------------------------------------------------------------
    this.sendSessionSnapshot();
    this.send({ type: "complete", data: {} });
  }

  // -------------------------------------------------------------------------
  // TTS
  // -------------------------------------------------------------------------

  /** Check if a voice should use client-side ElevenLabs TTS */
  /**
   * Flush buffered direct audio chunks to the client as a single WAV.
   * Called on a 250ms timer to batch small PCM chunks into smooth playback.
   */
  private flushDirectAudio(): void {
    this.directAudioFlushTimer = null;
    if (this.directAudioChunks.length === 0) return;
    try {
      const chunks = this.directAudioChunks.splice(0);
      const pcmBuf = Buffer.concat(chunks.map(c => Buffer.from(c, "base64")));
      if (pcmBuf.length === 0) return;
      const wavBuf = pcmToWav(pcmBuf);
      logLiveSession("flushDirectAudio", `state=${this.state} chunks=${chunks.length} pcmBytes=${pcmBuf.length} wavBytes=${wavBuf.length}`);
      this.send({ type: "avatar_audio", data: wavBuf.toString("base64"), format: "wav" });
    } catch (err) {
      console.error("[LiveRelay] Direct audio flush error:", (err as Error).message);
    }
  }

  private isClientTts(voice: ResolvedVoice): boolean {
    return !!(voice.elevenlabsApiKey && voice.elevenlabsVoiceId);
  }

  /**
   * Stream TTS with a timeout guard. Streams audio chunks to the client
   * as they arrive from the Gemini TTS service.
   */
  private async streamTtsWithTimeout(
    text: string,
    voice: ResolvedVoice,
    msgType: "avatar_audio" | "interpretation_audio",
    label: string,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} TTS timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const streamPromise = (async () => {
        for await (const chunk of ttsFacade.synthesizeStream(text, voice, signal)) {
          if (signal?.aborted) return;
          this.send({ type: msgType, data: chunk.toString("base64") } as any);
        }
      })();
      await Promise.race([streamPromise, timeoutPromise]);
    } catch (err) {
      if (signal?.aborted) return;
      console.error(`[LiveRelay] ${label} TTS failed:`, (err as Error).message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Board / Symbol helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve existing symbols from DB (fast). Must be awaited before sending the board.
   * Mutates buttons in-place to set symbolPath for already-generated symbols.
   * Returns the list of unresolved image keys.
   */
  private async resolveExistingSymbols(
    buttons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string; sentence?: string }>,
  ): Promise<string[]> {
    const { generateSymbols, useApprovedSymbols, useUnapprovedSymbols } = this.symbolSettings;

    // If no symbol features are enabled, strip imageKeys so client doesn't show spinners
    if (!generateSymbols && !useApprovedSymbols && !useUnapprovedSymbols) {
      for (const btn of buttons) { delete btn.imageKey; }
      return [];
    }

    if (!useApprovedSymbols && !useUnapprovedSymbols) {
      return buttons.filter(b => b.imageKey && !b.symbolPath).map(b => b.imageKey!);
    }

    const unresolved = await resolveImageKeys(buttons, {
      symbolPathFormat: "internal",
      useUnapproved: useUnapprovedSymbols,
    });

    // Strip imageKey from unresolved buttons when generation is disabled
    if (!generateSymbols) {
      for (const btn of buttons) {
        if (btn.imageKey && !btn.symbolPath) delete btn.imageKey;
      }
      return [];
    }

    return unresolved;
  }

  /**
   * Queue background generation for unresolved image keys (fire-and-forget).
   * Sends symbol_update WS messages as symbols are generated.
   */
  private queueMissingSymbolGeneration(
    buttons: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string }>,
    unresolvedKeys: string[],
  ): void {
    const { generateSymbols } = this.symbolSettings;
    if (!generateSymbols || unresolvedKeys.length === 0) return;

    const keyToLabel = new Map<string, string>();
    for (const btn of buttons) {
      if (btn.imageKey && !btn.symbolPath) keyToLabel.set(btn.imageKey, btn.label);
    }

    queueSymbolGeneration(unresolvedKeys, (imageKey, symbol) => {
      const label = keyToLabel.get(imageKey) || imageKey;
      logLiveSession("SYMBOL_READY", `imageKey=${imageKey} label=${label} symbolId=${symbol.id} wsOpen=${this.ws.readyState === 1}`);
      this.send({ type: "symbol_update", data: { buttonLabel: label, symbolPath: `__SYMBOL__:${symbol.id}` } });
    });
  }

  /**
   * For every multi-slot glyph on the supplied buttons, find slot keys
   * that look like generation-eligible imageKeys (not registry-known,
   * not emoji-covered, not raw emojis), resolve any that already have
   * symbols in the DB, and queue generation for the rest. Per-key
   * resolution is broadcast as `construction_symbol_ready` events; the
   * client listens for those and re-renders the affected glyphs in
   * place (see useDisplayGlyph / canResolveGlyph). Fire-and-forget for
   * the generation queue — the buttons render with their fallback in
   * the meantime.
   */
  private async resolveAndQueueGlyphParts(
    buttons: Array<{ glyph?: string }>,
  ): Promise<void> {
    const { generateSymbols, useApprovedSymbols, useUnapprovedSymbols } = this.symbolSettings;
    if (!generateSymbols && !useApprovedSymbols && !useUnapprovedSymbols) return;

    // Aggregate every distinct glyph-part imageKey across the button set.
    const keys = new Set<string>();
    for (const btn of buttons) {
      if (btn.glyph) collectGlyphImageKeys(btn.glyph, keys);
    }
    if (keys.size === 0) return;

    logLiveSession("GLYPH_PARTS_COLLECT", `keys=${keys.size} [${Array.from(keys).join(", ")}]`);

    // Look up existing symbols. resolveImageKeys mutates a button-shaped
    // array, so synthesize one entry per key and copy the result back.
    const synthesized: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string }> =
      Array.from(keys).map(k => ({ label: k, iconRef: "", imageKey: k }));
    let unresolved: string[];
    if (useApprovedSymbols || useUnapprovedSymbols) {
      unresolved = await resolveImageKeys(synthesized, {
        symbolPathFormat: "api-path",
        useUnapproved: useUnapprovedSymbols,
      });
    } else {
      // Lookup disabled — every key falls into the generation queue
      // (subject to generateSymbols below).
      unresolved = Array.from(keys);
    }

    // Push immediate resolutions to the client.
    for (const b of synthesized) {
      if (b.imageKey && b.symbolPath) {
        logLiveSession("GLYPH_PART_CACHED", `imageKey=${b.imageKey} symbolPath=${b.symbolPath}`);
        this.send({
          type: "construction_symbol_ready",
          data: { imageKey: b.imageKey, symbolPath: b.symbolPath },
        });
      }
    }

    // Queue generation for the rest, broadcasting each as it arrives.
    if (generateSymbols && unresolved.length > 0) {
      queueSymbolGeneration(unresolved, (imageKey, symbol) => {
        logLiveSession("GLYPH_PART_READY", `imageKey=${imageKey} symbolId=${symbol.id} wsOpen=${this.ws.readyState === 1}`);
        this.send({
          type: "construction_symbol_ready",
          data: { imageKey, symbolPath: `/api/custom-symbols/${symbol.id}/image` },
        });
      });
    }
  }

  private buildBoardFromButtons(buttons: Array<{ id?: string; label: string; iconRef: string; symbolPath?: string; glyph?: string; glyphFallback?: string; sentence?: string; buttonType?: "guess" | "category"; rowSpan?: number; colSpan?: number }>): any {
    const pageId = `page-${Date.now()}`;
    const cols = 4;
    const rows = Math.max(2, Math.ceil(buttons.length / cols));

    return {
      grid: { rows, cols },
      pages: [{
        id: pageId,
        name: "Main",
        buttons: buttons.map((b, i) => ({
          // Prefer the merge engine's pre-assigned id (so React reuses the
          // existing DOM node for surviving buttons); fall back to a fresh
          // one when this is a brand-new button or a legacy code path
          // hasn't gone through smartMergeButtons.
          id: b.id ?? `btn-${Date.now()}-${i}`,
          label: b.label,
          spokenText: b.label,
          ...(b.sentence ? { sentence: b.sentence } : {}),
          ...(b.buttonType ? { buttonType: b.buttonType } : {}),
          ...(b.rowSpan && b.rowSpan > 1 ? { rowSpan: b.rowSpan } : {}),
          ...(b.colSpan && b.colSpan > 1 ? { colSpan: b.colSpan } : {}),
          row: Math.floor(i / cols),
          col: i % cols,
          action: { type: "speak" as const, text: b.label },
          style: {},
          iconRef: b.iconRef,
          symbolPath: b.symbolPath,
          ...(b.glyph ? { glyph: b.glyph } : {}),
          ...(b.glyphFallback ? { glyphFallback: b.glyphFallback } : {}),
        })),
      }],
      currentPageId: pageId,
    };
  }

  /**
   * Get the native (built-in) button labels for the current page of a loaded custom board.
   */
  private getNativePageButtonLabels(state: DualAgentSessionState): string[] {
    if (!state.loadedBoardData) return [];
    const page = state.loadedBoardData.pages?.find((p: any) => p.id === state.currentPageId)
      || state.loadedBoardData.pages?.[0];
    if (!page?.buttons) return [];
    return page.buttons.filter((b: any) => b.label).map((b: any) => b.label);
  }

  // -------------------------------------------------------------------------
  // Context injection
  // -------------------------------------------------------------------------

  /**
   * Inject session context after a reconnection so the model doesn't start over.
   */
  private injectReconnectionContext(): void {
    const state = this.sessionCache?.state;
    if (!state) return;

    const parts: string[] = [];

    // Current board state
    const maxSlots = state.maxBoardItems || 12;
    const labels = state.boardButtonLabels;
    if (state.loadedBoardId) {
      const nativeLabels = this.getNativePageButtonLabels(state);
      const blankSlots = maxSlots - nativeLabels.length;
      const available = blankSlots - state.aiAddedButtonLabels.length;
      parts.push(`Custom ${T.board} loaded — Fixed ${T.button}s (cannot remove): ${nativeLabels.join(", ")} | AI-added (can remove): ${state.aiAddedButtonLabels.join(", ") || "none"} | ${available} slots available`);
    } else if (labels.length > 0) {
      parts.push(`Current ${T.board} ${T.button}s (${labels.length}/${maxSlots}): ${labels.join(", ")}`);
    }

    parts.push(`Interaction mode: ${this.muteState}`);

    if (state.currentEmote) {
      parts.push(`Current emotion: ${state.currentEmote}`);
    }

    // Recent conversation from pending messages (last 20), filtering out safety-excluded
    const recent = (state.pendingMessages || [])
      .filter(m => !m.safetyExcluded)
      .slice(-20);
    if (recent.length > 0) {
      const summary = recent.map(m => {
        const role = m.role === "assistant" ? "AI" : "User";
        const content = m.content.length > 150 ? m.content.substring(0, 150) + "..." : m.content;
        return `  ${role}: ${content}`;
      }).join("\n");
      parts.push(`Recent conversation:\n${summary}`);
    }

    const header = this.consecutiveSafetyBlocks > 0
      ? `[SESSION RESUMED] Your connection was briefly interrupted due to a content filter. Continue the conversation naturally.`
      : `[SESSION RECONNECTED] The connection was briefly interrupted but has been restored.`;

    const contextText = [
      header,
      ...parts,
      `IMPORTANT: Continue the conversation naturally from where you left off.`,
      `Do NOT greet the user again. Do NOT use rebuild_board() — the ${T.board} is already displayed correctly on the client.`,
    ].join("\n");

    this.provider!.sendContextInjection(contextText);
    logDualAgent("LiveRelay.reconnectionContext", {
      sessionId: this.sessionId,
      boardButtons: labels.length,
      recentMessages: recent.length,
    });

    // Re-inject behavioral rules immediately after reconnection
    const behavioralReminder = this.buildBehavioralReminder();
    if (behavioralReminder) {
      this.provider!.sendContextInjection(behavioralReminder);
      logDualAgent("LiveRelay.behavioralReminder", { sessionId: this.sessionId, trigger: "reconnect" });
    }
  }

  /**
   * Build a compact model-role summary of what the model did during this turn.
   */
  private buildTurnSummary(accum: TurnToolAccumulator): string | null {
    const parts: string[] = [];
    if (accum.interpretText.trim() && !this.useDirectAudio) {
      parts.push(`interpret("${accum.interpretText.trim()}")`);
    }
    if (accum.boardRebuilt) {
      const labels = accum.boardAddLabels.join(", ");
      parts.push(`rebuild_board(${labels})`);
    } else {
      if (accum.boardAddLabels.length > 0) {
        parts.push(`add_buttons(${accum.boardAddLabels.join(", ")})`);
      }
      if (accum.boardRemoveLabels.length > 0) {
        parts.push(`remove_buttons(${accum.boardRemoveLabels.join(", ")})`);
      }
    }
    if (accum.speakText.trim()) {
      // In direct audio mode, speakText comes from outputTranscription — record it
      // so the model has a text record of what it said (native audio context alone
      // isn't enough for complex multi-turn reasoning).
      parts.push(`[I said: "${accum.speakText.trim()}"]`);
    }
    if (accum.setBoardName) {
      parts.push(`set_board("${accum.setBoardName}")`);
    }
    if (accum.pressButtonLabel) {
      parts.push(`press_button("${accum.pressButtonLabel}")`);
    }
    if (accum.openAppData) {
      parts.push(`open_app("${accum.openAppData.appId}")`);
    }
    if (accum.emote) {
      parts.push(`emote("${accum.emote}")`);
    }
    if (parts.length === 0) return null;
    return `[I just called: ${parts.join(", ")}]`;
  }

  /**
   * Build a concise behavioral reminder based on current session state.
   */
  private buildBehavioralReminder(): string | null {
    const state = this.sessionCache?.state;
    if (!state) return null;

    const isMuted = this.muteState === "muted";

    const sRef = "speak()";
    const abRef = "add_buttons()";
    const rbRef = "remove_buttons()";
    const sbRef = "set_board()";

    const parts: string[] = [
      `[BEHAVIORAL REMINDER]`,
      `On every ${T.tagPress}, RESPOND ALOUD to the user's SENTENCE and then call rebuild_board() — that is the expected flow. Separately: the ${T.button}'s speech is voiced by a TTS layer through the device speaker, which the mic will pick up. That re-heard audio is NOT new user speech — do not transcribe it. The transcription rule does NOT change the response rule: respond to the ${T.tagPress} text turn, ignore the echoed TTS audio.`,
    ];

    parts.push("Visual checks: Stay silent if nothing important changed. Only report meaningful context changes.");

    if (isMuted) {
      parts.push(`Mode: silent — You are INVISIBLE. NEVER speak. Only use ${T.board} tools.`);
    } else if (this.useDirectAudio) {
      parts.push(`Mode: standard — You speak directly with your voice. Do NOT narrate tool calls.`);
    } else {
      parts.push(`Mode: standard — AI voice active via ${sRef}.`);
    }

    if (this.useDirectAudio) {
      parts.push(`Echo: You will hear your own voice echoed back through the mic — ignore it. BUTTON PRESS speech is also echoed via TTS — ignore those too.`);
    } else {
      parts.push(`Echo: Speech you hear shortly after your own ${sRef} output is YOUR echo — ignore it completely. Do NOT transcribe or respond to it.`);
    }

    const maxSlots = state.maxBoardItems || 12;
    parts.push(`${T.board} limit: ${maxSlots} ${T.button}s max. Use ${rbRef} before ${abRef} if near the limit.`);

    if (state.availableBoards && state.availableBoards.length > 0 && !state.loadedBoardId) {
      const boardKeys = state.availableBoards.map(b => {
        const hint = b.hint ? ` (${b.hint})` : "";
        return `${b.key}${hint}`;
      }).join(", ");
      parts.push(`Custom ${T.board}s available: ${boardKeys}. Use ${sbRef} silently when the context matches a board's purpose${this.useDirectAudio ? "." : ` — do NOT announce board switches with ${sRef}.`}`);
    }

    return parts.join("\n");
  }

  /**
   * Switch the live session between sleep-state profiles (awake ↔ resting).
   *
   * Rebuilds the system prompt, tool set, and compression window for the
   * target profile and reconnects via the provider's reconnectWithConfig
   * (which preserves conversation history through session resumption).
   *
   * If a turn is in flight, the switch is deferred to the next idle
   * (handleTurnComplete drains `profileSwitchPending`) — switching mid-turn
   * would drop the model's response.
   */
  /**
   * Produce + inject a fresh rolling session summary when enough new
   * conversation messages have accumulated. Fire-and-forget: the monitor's
   * Haiku call runs async; on completion the summary is stored on state and
   * injected as a [SESSION SUMMARY] context message (recent → survives the
   * sliding window while older detail is evicted). Folded into the system
   * prompt on the next reconnect (see switchSessionProfile / prompt builders).
   *
   * Source is state.messages (the monitor-processed log), so the summary
   * trails live turns slightly — that's fine, it's a rolling digest.
   */
  private maybeProduceSessionSummary(): void {
    const state = this.sessionCache?.state;
    const monitor = this.sessionCache?.monitorAgent;
    if (!state || !monitor?.produceSessionSummary) return;
    if (this.summaryInFlight) return;

    const total = state.messages.length;
    const summarized = state.summarizedMsgCount ?? 0;
    if (total - summarized < LiveRelay.SUMMARY_EVERY_N_MESSAGES) return;

    const newMessages = state.messages.slice(summarized).map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
    const markCount = total;
    this.summaryInFlight = true;
    monitor.produceSessionSummary(state.sessionSummary, newMessages)
      .then(summary => {
        this.summaryInFlight = false;
        if (!summary || summary === state.sessionSummary) {
          // No change — still advance the marker so we don't re-summarize the
          // same batch every turn.
          state.summarizedMsgCount = markCount;
          return;
        }
        state.sessionSummary = summary;
        state.summarizedMsgCount = markCount;
        if (this.provider?.isConnected) {
          this.provider.sendContextInjection(`[SESSION SUMMARY]\n${summary}`);
        }
        logLiveSession("SESSION_SUMMARY_INJECTED", `${summary.length} chars, summarized ${markCount} msgs`);
      })
      .catch(err => {
        this.summaryInFlight = false;
        logLiveSession("SESSION_SUMMARY_ERROR", (err as Error).message);
      });
  }

  async switchSessionProfile(target: "awake" | "resting"): Promise<void> {
    if (this.sessionProfile === target && !this.profileSwitchPending) return;
    if (!this.provider?.reconnectWithConfig) {
      logLiveSession("PROFILE_SWITCH_SKIP", "provider missing reconnectWithConfig");
      return;
    }
    if (this.state !== "idle") {
      this.profileSwitchPending = target;
      logLiveSession("PROFILE_SWITCH_DEFERRED", `state=${this.state} target=${target}`);
      return;
    }
    this.profileSwitchPending = null;
    if (this.sessionProfile === target) return;

    const state = this.sessionCache?.state;
    const student = this.sessionCache?.monitorAgent?.getStudent?.();
    if (!state || !student || !this.currentLiveModel) {
      logLiveSession("PROFILE_SWITCH_SKIP", "no state/student/model");
      return;
    }

    const computeAge = (bd: string | null | undefined) => {
      if (!bd) return undefined;
      const age = Math.floor((Date.now() - new Date(bd).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      return age > 0 ? String(age) : undefined;
    };
    const rawPersona = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;
    const sections = state.enhancedSections;
    const persona = sections?.persona || rawPersona;

    let basePrompt: string;
    let tools: import("./live-provider").LiveProviderConfig["tools"];
    let triggerTokens: number;
    let targetTokens: number;

    if (target === "resting") {
      basePrompt = buildRestingAgentPrompt({
        studentName: student.name,
        persona,
        language: student.primaryLanguage || undefined,
        memoryContext: state.memoryContext,
        studentAge: computeAge(student.birthDate),
        studentGender: student.gender || undefined,
        studentDiagnosis: state.cachedDiagnosis || undefined,
        aiName: student.aacSettings?.aiName || undefined,
        knownContacts: state.cachedContacts?.length ? state.cachedContacts : undefined,
        useDirectAudio: this.useDirectAudio,
        sessionSummary: state.sessionSummary,
      });
      tools = buildToolDeclarations({
        enabledApps: [],
        availableBoards: [],
        hasLoadedBoard: false,
        faceRecognitionActive: (state.cachedContacts?.length || 0) > 0,
        useDirectAudio: this.useDirectAudio,
        language: student.primaryLanguage || undefined,
        restingMode: true,
      });
      triggerTokens = LiveRelay.RESTING_COMPRESSION_TRIGGER;
      targetTokens = LiveRelay.RESTING_COMPRESSION_TARGET;
    } else {
      // awake — reuse the current full interactive prompt + the cached full
      // tool set built at init. interactivePrompt is kept current by mute
      // changes; awakeTools rarely drifts (custom apps don't change mid-session).
      // Append the latest rolling summary inline (interactivePrompt may have
      // been built before the most recent summary was produced).
      basePrompt = state.sessionSummary
        ? `${state.interactivePrompt}\n\n<session_summary>\nWhat has happened earlier in THIS session (detailed history may have aged out of your context — this is your memory of it):\n${state.sessionSummary}\n</session_summary>`
        : state.interactivePrompt;
      tools = this.awakeTools ?? buildToolDeclarations({
        enabledApps: [],
        availableBoards: [],
        hasLoadedBoard: false,
        faceRecognitionActive: (state.cachedContacts?.length || 0) > 0,
        useDirectAudio: this.useDirectAudio,
        language: student.primaryLanguage || undefined,
      });
      triggerTokens = LiveRelay.AWAKE_COMPRESSION_TRIGGER;
      targetTokens = LiveRelay.AWAKE_COMPRESSION_TARGET;
    }

    const echoAwareness = this.buildEchoAwareness();
    const tzSection = this.buildTimezoneSection();
    const systemPrompt = basePrompt + "\n\n" + echoAwareness + (tzSection ? "\n\n" + tzSection : "");

    const providerConfig: LiveProviderConfig = {
      model: this.currentLiveModel,
      temperature: 0.7,
      tools,
      compressionTriggerTokens: triggerTokens,
      compressionTargetTokens: targetTokens,
      responseModality: "AUDIO",
      proactiveAudio: true,
      voiceName: this.geminiVoiceName,
    };

    const from = this.sessionProfile;
    this.sessionProfile = target;
    logLiveSession("PROFILE_SWITCH", `${from} → ${target} (compression trigger=${triggerTokens}/${targetTokens}, tools=${tools?.[0]?.functionDeclarations?.length ?? 0})`);
    try {
      await this.provider.reconnectWithConfig(systemPrompt, providerConfig);
    } catch (err) {
      logLiveSession("PROFILE_SWITCH_ERROR", `${from}→${target}: ${(err as Error).message}`);
      this.sessionProfile = from; // revert on failure
    }
  }

  private buildEchoAwareness(): string {
    if (this.useDirectAudio) {
      return `AUDIO ECHO AWARENESS:
The microphone picks up audio that came from your own speaker — your own voice playing back, and the user's BUTTON PRESS TTS playing back. That re-heard audio is NOT new user speech. Don't TRANSCRIBE it (no transcript() calls for it). This rule is about transcription only — it does NOT mean "don't respond". When a ${T.tagPress} text turn arrives, respond to it normally as the user's statement, even though you may hear the TTS echo right after.`;
    }

    return `AUDIO ECHO AWARENESS:
You receive continuous microphone audio. Because speak() text is voiced by external TTS through speakers near the mic, you WILL hear your own output echoed back. Recognize these echoes as YOUR OWN output — never transcribe or respond to them. Only treat audio as genuine user speech if it clearly does NOT match something you recently said.
When a ${T.button} is pressed, the user's pre-generated SENTENCE is also voiced via TTS — you will hear this echo too. Do NOT transcribe it.`;
  }

  /** Build a TZ + local-time section for the interactive agent system prompt. */
  private buildTimezoneSection(): string {
    if (!this.timezone) return "";
    const now = new Date();
    let local: string;
    try {
      local = new Intl.DateTimeFormat("en-US", {
        timeZone: this.timezone,
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(now);
    } catch {
      local = now.toISOString();
    }
    return `USER LOCAL TIME:
Time zone: ${this.timezone}
Current local time: ${local}
When creating or referencing calendar events, interpret and speak in this local time.`;
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private startTimers(): void {
    this.stopTimers();

    // Board reminder (45s)
    this.lastBoardUpdateTime = Date.now();
    this.boardReminderTimer = setInterval(() => {
      this.sendBoardStateReminder();
    }, LiveRelay.BOARD_REMINDER_INTERVAL_MS);

    // Behavioral reminder (3min)
    this.behavioralReminderTimer = setInterval(() => {
      const reminder = this.buildBehavioralReminder();
      if (reminder) {
        this.provider!.sendContextInjection(reminder);
        logDualAgent("LiveRelay.behavioralReminder", { sessionId: this.sessionId, trigger: "periodic" });
      }
    }, LiveRelay.BEHAVIORAL_REMINDER_INTERVAL_MS);

    // Client ping (30s)
    this.startPingTimer();

    // Snapshot timer (30s)
    this.snapshotTimer = setInterval(() => {
      this.sendSessionSnapshot();
    }, LiveRelay.SNAPSHOT_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.boardReminderTimer) {
      clearInterval(this.boardReminderTimer);
      this.boardReminderTimer = null;
    }
    if (this.behavioralReminderTimer) {
      clearInterval(this.behavioralReminderTimer);
      this.behavioralReminderTimer = null;
    }
    this.stopPingTimer();
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private startPingTimer(): void {
    this.stopPingTimer();
    this.pongReceived = true;
    this.pingTimer = setInterval(() => {
      if (!this.pongReceived) {
        console.warn("[LiveRelay] Client WebSocket failed health check (no pong) — terminating");
        this.ws.terminate();
        return;
      }
      this.pongReceived = false;
      try {
        this.ws.ping();
      } catch {
        // ws already closed
      }
    }, LiveRelay.PING_INTERVAL_MS);
  }

  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Send a periodic board state context injection so Gemini stays aware
   * of current buttons and available slots.
   */
  private sendBoardStateReminder(): void {
    const state = this.sessionCache?.state;
    if (!state) return;

    const timeSinceUpdate = Date.now() - this.lastBoardUpdateTime;
    if (timeSinceUpdate < LiveRelay.BOARD_REMINDER_INTERVAL_MS) {
      logLiveSession("BOARD REMINDER SKIPPED", `timeSinceUpdate=${timeSinceUpdate}ms < ${LiveRelay.BOARD_REMINDER_INTERVAL_MS}ms`);
      return;
    }
    logLiveSession("BOARD REMINDER FIRING", `timeSinceUpdate=${timeSinceUpdate}ms`);

    const maxSlots = state.maxBoardItems || 12;
    const labels = state.boardButtonLabels;

    if (state.loadedBoardId) {
      const nativeLabels = this.getNativePageButtonLabels(state);
      const blankSlots = maxSlots - nativeLabels.length;
      const available = blankSlots - state.aiAddedButtonLabels.length;
      this.provider!.sendContextInjection(
        `[BOARD STATE REMINDER] Custom board — Fixed buttons (cannot remove): ${nativeLabels.join(", ")} | AI-added (can remove, ${state.aiAddedButtonLabels.length}/${blankSlots}): ${state.aiAddedButtonLabels.join(", ") || "none"} | ${available} slots available`,
      );
    } else {
      const available = maxSlots - labels.length;
      const ctxInfo = this.contextButtonLabels.length > 0
        ? ` | Context sidebar: ${this.contextButtonLabels.join(", ")}`
        : "";
      this.provider!.sendContextInjection(
        `[BOARD STATE REMINDER] Main board (${labels.length}/${maxSlots}, ${available} slots available): ${labels.join(", ") || "none"}${ctxInfo}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  /**
   * Force a completely new session when reconnection keeps failing.
   */
  private async forceNewSession(): Promise<void> {
    if (!this.studentId || !this.sessionId) return;

    this.provider?.close();

    try {
      await this.handleInitialize({
        type: "initialize",
        studentId: this.studentId,
        userId: this.userId,
        muteState: this.muteState,
        responseMode: this.responseMode,
        debugMode: this.debugMode,
      });
      if (this.sessionId) {
        this.send({ type: "session_reset", sessionId: this.sessionId });
      }
      this.reconnectAttempts = 0;
    } catch (err) {
      console.error("[LiveRelay] Force new session failed:", err);
      this.send({ type: "error", data: "error:SESSION_RESET_FAILED" });
    }
  }

  /**
   * Handle a safety/policy block from Gemini.
   * Simplified: exclude all messages on safety block.
   */
  private handleSafetyBlock(): void {
    this.consecutiveSafetyBlocks++;

    const state = this.sessionCache?.state;
    if (state) {
      const msgs = state.pendingMessages;
      // Exclude all non-excluded messages
      for (const msg of msgs) {
        if (!msg.safetyExcluded) {
          msg.safetyExcluded = true;
        }
      }

      dualAgentService.addPendingMessage(this.sessionId!, {
        role: "system",
        content: `[SAFETY BLOCK] A response was blocked by the content safety filter (attempt ${this.consecutiveSafetyBlocks}). All messages excluded from AI context.`,
        timestamp: Date.now(),
      }).catch(err => console.error("[LiveRelay] Failed to persist safety block:", err));
    }

    this.send({ type: "safety_blocked", data: "error:SAFETY_BLOCKED" });

    logDualAgent("LiveRelay.safetyBlock", {
      sessionId: this.sessionId,
      level: this.consecutiveSafetyBlocks,
      lastCloseCode: this.provider?.lastCloseCode,
    });
  }

  // -------------------------------------------------------------------------
  // Face recognition
  // -------------------------------------------------------------------------

  /**
   * Match each incoming face descriptor against the user's known people
   * (self + linked users + contacts) via the database. Populates
   * `currentIdentifiedFaces`, pushes the list to the client for the debug
   * display, and rate-limit-bumps `recordContactSighting()` for matches.
   */
  private async recognizeFaces(
    descriptors: Array<{
      descriptor: number[];
      boundingBox?: { x: number; y: number; w: number; h: number };
      cameraRole?: "user" | "environment" | "unknown";
      cameraLabel?: string;
    }>,
  ): Promise<void> {
    if (!this.studentId) return;

    if (!descriptors.length) {
      if (this.currentIdentifiedFaces.length) {
        this.currentIdentifiedFaces = [];
        this.currentIdentifiedFacesAt = Date.now();
        this.send({ type: "people_identified", data: [] });
      }
      return;
    }

    const matches = await Promise.all(
      descriptors.map(d => findMatchingFace(d.descriptor, this.studentId!).catch(() => null as FaceMatchResult | null)),
    );

    let unknownCounter = 0;
    const wire: IdentifiedFaceWire[] = descriptors.map((d, i) => {
      const m = matches[i];
      if (m && m.matched) {
        return {
          faceIndex: i,
          matched: true,
          name: m.name,
          entityType: m.entityType,
          entityId: m.entityId,
          relationship: m.relationship,
          confidence: m.confidence,
          boundingBox: d.boundingBox,
          cameraRole: d.cameraRole,
          cameraLabel: d.cameraLabel,
        };
      }
      unknownCounter += 1;
      return {
        faceIndex: i,
        matched: false,
        name: `Unknown #${unknownCounter}`,
        confidence: 0,
        boundingBox: d.boundingBox,
        cameraRole: d.cameraRole,
        cameraLabel: d.cameraLabel,
      };
    });

    this.currentIdentifiedFaces = wire;
    this.currentIdentifiedFacesAt = Date.now();
    this.send({ type: "people_identified", data: wire });

    // Rate-limited sighting bumps for confidently-matched contacts only
    const now = Date.now();
    for (const f of wire) {
      if (!f.matched || f.entityType !== "contact" || !f.entityId) continue;
      if (f.confidence < 0.4) continue;
      const last = this.lastSightingBumpAt.get(f.entityId) ?? 0;
      if (now - last < LiveRelay.SIGHTING_BUMP_INTERVAL_MS) continue;
      this.lastSightingBumpAt.set(f.entityId, now);
      recordContactSighting(f.entityId).catch(err => {
        logLiveSession("SIGHTING_BUMP_ERROR", `${f.entityId}: ${(err as Error).message}`);
      });
    }
  }

  /**
   * Render the currently-identified faces as a compact context block for the
   * model. Returns an empty string when nothing recent is on file. The block
   * is appended to the frame_grid prompt so the model knows who is visible
   * and how confident the match is.
   */
  private buildPeoplePresentContext(): string {
    if (!this.currentIdentifiedFaces.length) return "";
    if (Date.now() - this.currentIdentifiedFacesAt > LiveRelay.IDENTIFIED_FACES_TTL_MS) return "";
    // Camera-role suffix tells the AI whether the person is in front of the
    // student (gesture-tracked) or seen on an environment camera elsewhere.
    const cameraSuffix = (role?: string): string => {
      if (role === "user") return " — in front of student";
      if (role === "environment") return " — environment camera";
      return "";
    };
    // Explicit student tag: face-match returns entityType="student" when the
    // visible face matches the bound student. Marking it inline lets the
    // prompt require positive identification — without this, the model can
    // mistake a visible non-student (parent, sibling, clinician) for the
    // student and address them as if they were the primary user.
    const lines = this.currentIdentifiedFaces.map(f => {
      const where = cameraSuffix(f.cameraRole);
      if (!f.matched) return `- ${f.name} (no database match)${where}`;
      const conf = (f.confidence * 100).toFixed(0);
      const rel = f.relationship ? `, ${f.relationship}` : "";
      const tag = f.entityType === "student" ? " [THE STUDENT]" : "";
      return `- ${f.name}${rel} — ${conf}% confidence${where}${tag}`;
    });
    const sawStudent = this.currentIdentifiedFaces.some(f => f.matched && f.entityType === "student");
    const presenceLine = sawStudent
      ? ""
      : `\n(NOTE: the user is NOT among the identified faces. The visible person, if any, is someone else — likely a caregiver, family member, or visitor.)`;
    return `[PEOPLE PRESENT]\n${lines.join("\n")}${presenceLine}`;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private send(msg: ServerMessage): void {
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        logLiveSession("SERVER → CLIENT", `state=${this.state} ${stringifyMsg(msg)}`);
        this.ws.send(JSON.stringify(msg));
      } else {
        logLiveSession("SERVER → CLIENT (WS CLOSED)", `state=${this.state} type=${msg.type}`);
      }
    } catch (err) {
      console.error("[LiveRelay] send() failed:", (err as Error).message, "msgType:", msg.type);
    }
  }

  /**
   * Record an AAC sleep state transition to the activity log.
   * Idempotent against same-state repeats. Used by the Insurance Bridge module
   * to subtract sleep windows from RTM service-time totals.
   */
  private recordSleepStateChange(
    toState: "hibernation" | "waking" | "awake" | "resting" | "asleep",
    source: "ai" | "system" | "user",
  ): void {
    if (toState === this.lastSleepState) return;
    const fromState = this.lastSleepState;
    this.lastSleepState = toState;
    // Re-arm the interact-mode greeting on any wake from hibernation, so
    // the next set_interaction_mode("interact") triggers a fresh greeting.
    if (fromState === "hibernation" && toState !== "hibernation") {
      this.hasGreetedInteract = false;
    }
    if (!this.studentId) return;
    activityLogService.log({
      userId: this.userId ?? null,
      eventType: "aac_sleep_state_change",
      subjectType1: "student",
      subjectId1: this.studentId,
      details: {
        sessionId: this.sessionId,
        fromState,
        toState,
        source,
      },
      isAiInitiated: source === "ai",
    });
  }

  /** Build and send a session_snapshot message to the client for local persistence. */
  sendSessionSnapshot(): void {
    if (!this.localStorageConfig || !this.sessionCache?.state) return;

    const state = this.sessionCache.state;
    const student = this.sessionCache.monitorAgent.getStudent?.();
    const memory = (student?.chatMemory as Record<string, any>) || {};

    const snapshot: import("@shared/aac-local-storage").AacSessionSnapshot = {
      sessionId: state.sessionId,
      studentId: state.studentId,
      userId: state.userId,
      messages: state.messages,
      pendingMessages: state.pendingMessages.map(pm => ({
        role: pm.role,
        content: pm.content,
        timestamp: pm.timestamp,
      })),
      muteState: state.muteState,
      responseMode: this.responseMode,
      currentBoard: state.currentBoard || null,
      boardButtonLabels: state.boardButtonLabels,
      aiAddedButtonLabels: state.aiAddedButtonLabels,
      loadedBoardId: state.loadedBoardId,
      currentPageId: state.currentPageId,
      monitorNotes: memory.Student_Notes || undefined,
      timestamp: Date.now(),
    };

    this.send({
      type: "session_snapshot",
      snapshot,
      config: this.localStorageConfig,
    });
  }

  /**
   * Load the home board directly (server-side, no AI tool call required).
   * Called on session init and when the user presses Home. The AI is informed
   * via context injection and can use rebuild_board() to add side panel buttons.
   *
   * @param deferClientSend  When true, only update server-side state. The
   *   `set_board` message to the client is held until `flushPendingHomeBoardSend`
   *   runs from `onReady`. Used during init so the home board buttons don't
   *   appear before the model is connected and ready to handle clicks.
   */
  private loadHomeBoardInternal(
    state?: import("./types").DualAgentSessionState,
    deferClientSend = false,
  ): void {
    const targetState = state || this.sessionCache?.state;
    if (!targetState || !this.homeBoardData) return;
    targetState.loadedBoardId = "__home__";
    targetState.loadedBoardData = this.homeBoardData as any;
    targetState.currentPageId = this.homeBoardData.pages?.[0]?.id || null;
    targetState.pageHistory = [];
    targetState.maxBoardItems = (this.homeBoardData.grid?.rows || 3) * (this.homeBoardData.grid?.cols || 4);
    targetState.aiAddedButtonLabels = [];
    const nativeLabels = this.getNativePageButtonLabels(targetState);
    targetState.boardButtonLabels = [...nativeLabels];
    if (deferClientSend) {
      this.pendingHomeBoardSend = true;
      logLiveSession("HOME_BOARD_LOADED (deferred)", `state updated; client send held until onReady — buttons: ${nativeLabels.join(", ")}`);
    } else {
      this.send({ type: "set_board", data: { board: this.homeBoardData, name: this.homeBoardData.name, boardId: "__home__" } });
      logLiveSession("HOME_BOARD_LOADED", `server-side load — buttons: ${nativeLabels.join(", ")}`);
    }
  }

  private flushPendingHomeBoardSend(): void {
    if (!this.pendingHomeBoardSend || !this.homeBoardData) return;
    this.pendingHomeBoardSend = false;
    this.send({ type: "set_board", data: { board: this.homeBoardData, name: this.homeBoardData.name, boardId: "__home__" } });
    logLiveSession("HOME_BOARD_LOADED (flushed)", "sent set_board to client now that model is ready");
  }

  private startSilenceKeepalive(): void {
    if (this.silenceKeepaliveTimer) return;
    logLiveSession("SILENCE_KEEPALIVE", `started — ${LiveRelay.SILENCE_KEEPALIVE_MS}ms intervals`);
    this.silenceKeepaliveTimer = setInterval(() => {
      // Skip if client PCM has arrived recently — real audio takes priority
      if (Date.now() - this.lastClientPcmAt < LiveRelay.CLIENT_PCM_TIMEOUT_MS) return;
      // Skip if paused or no provider
      if (this.paused || !this.provider) return;
      this.provider.sendAudio(LiveRelay.SILENCE_PCM_BASE64);
    }, LiveRelay.SILENCE_KEEPALIVE_MS);
  }

  private stopSilenceKeepalive(): void {
    if (this.silenceKeepaliveTimer) {
      clearInterval(this.silenceKeepaliveTimer);
      this.silenceKeepaliveTimer = null;
      logLiveSession("SILENCE_KEEPALIVE", "stopped");
    }
  }

  private cleanup(): void {
    this.setState("closed");
    this.stopTimers();
    this.stopSilenceKeepalive();
    this.pendingClientMessages = [];
    if (this.directAudioFlushTimer) { clearTimeout(this.directAudioFlushTimer); this.directAudioFlushTimer = null; }

    // Remove context injection callback to prevent leaks
    if (this.sessionCache?.state) {
      this.sessionCache.state.onContextInjection = undefined;
    }

    // Trigger final monitor run (fire-and-forget)
    if (this.sessionId) {
      this.handleSessionClose().catch(err => {
        console.error("[LiveRelay] Session close handler failed:", err);
      });
    }

    this.provider?.close();
    if (this.studentTtsSession) {
      this.studentTtsSession.close();
      this.studentTtsSession = null;
    }
    logDualAgent("LiveRelay.cleanup", { sessionId: this.sessionId });
  }

  /**
   * Handle session close: add a close marker and force-trigger the monitor
   * for a final summary of the session.
   */
  private async handleSessionClose(): Promise<void> {
    if (!this.sessionId) return;

    // Skip final summary when notes are disabled
    if (this.sessionCache?.state.privacyOptions?.allowNotes === false) {
      logDualAgent("LiveRelay.handleSessionClose.skipped", { sessionId: this.sessionId, reason: "allowNotes=false" });
      return;
    }

    await dualAgentService.addPendingMessage(this.sessionId, {
      role: "user",
      content: `[SESSION_CLOSED] The AAC session has ended. Perform these final tasks:
1. Summarize the session — note anything significant that happened.
2. Clean up Student_Notes: view the notes, then delete duplicate or redundant entries and consolidate related information where possible. The goal is a concise, non-repetitive set of notes.`,
      timestamp: Date.now(),
    });

    await dualAgentService.triggerMonitor(this.sessionId, true);

    // Populate the generic session summary/title/importance (used by deep-analysis
    // session search). This runs after the monitor pass so any final Student_Notes
    // updates are already persisted. Fire-and-forget — errors are logged internally.
    const sessionId = this.sessionId;
    import("../sessionSummary").then(({ generateSessionSummaryAsync }) => {
      generateSessionSummaryAsync(sessionId);
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// WebSocket Server Setup — called from routes.ts
// ---------------------------------------------------------------------------

export function setupLiveWebSocket(server: import("http").Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    // Only handle /ws/live path
    if (url.pathname !== "/ws/live") return;

    // Authenticate at the upgrade boundary. Without this check anyone on the
    // internet who guesses or harvests a student UUID can open a session and
    // exfiltrate PHI through the live model; the per-student authorization
    // check inside handleInitialize relies on having an authenticated user.
    const user = await authenticateUpgrade(req);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // ?test=1 routes to the minimal pass-through relay (no tools, no system
    // prompt, no state machine — used to isolate Gemini behavior from our
    // production middleware).
    const useMinimal = url.searchParams.get("test") === "1";

    wss.handleUpgrade(req, socket as any, head as any, async (ws) => {
      if (useMinimal) {
        console.log(`[LiveRelay] New MINIMAL WebSocket connection (test mode) user=${user.id}`);
        const { MinimalLiveRelay } = await import("./minimal-live-relay");
        new MinimalLiveRelay(ws as any);
      } else {
        console.log(`[LiveRelay] New WebSocket connection user=${user.id}`);
        new LiveRelay(ws, user);
      }
    });
  });

  console.log("[LiveRelay] WebSocket server ready on /ws/live (append ?test=1 for minimal relay)");
}
