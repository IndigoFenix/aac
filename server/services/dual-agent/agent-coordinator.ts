// server/services/dual-agent/agent-coordinator.ts
//
// AgentCoordinator — central broker for the three-agent AAC architecture.
// See planning-docs/aac-agent-responsibility-split.md.
//
// Owns:
//   - The client WebSocket (replaces LiveRelay-as-orchestrator for the new path)
//   - DualAgentSessionState (extended for multi-agent)
//   - Three agent handles (Observer, Speaker, Board Manager)
//   - The event bus: routing table, debounce policy, echo suppression
//   - Board Manager invocation serialization
//   - Monitor invocation + broadcast
//
// MVP scope (deferred to follow-up: profile transitions / cost tracking /
// symbol-generation queue / safety-block recovery / fancy reconnection).

import type { IncomingMessage } from "http";
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";

import { type User, type PermittedWebsite } from "@shared/schema";
import { isUrlPermitted } from "@shared/permitted-websites";
import { settingsRepository } from "../../repositories/settingsRepository";
import { boardRepository } from "../../repositories/boardRepository";
import { dualAgentService } from "./dual-agent-service";
import { ttsFacade, type ResolvedVoice } from "../voice/tts-facade";
import { voiceRecordRepository } from "../../repositories/voiceRecordRepository";

import { ObserverAgent, type ObserverOutputEvent, type ObserverCallbacks, type ObserverStartConfig } from "./observer-agent";
import { HttpObserverAgent } from "./http-observer-agent";
import type { IObserverAgent } from "./observer-interface";
import { shouldSuppressEmergency, DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS } from "./alarm-gate";
import { SpeakerAgent, type SpeakerOutputEvent } from "./speaker-agent";
import { getContactById, listCallableContacts, resolveContactPersonId } from "../call/callContacts";
import { isPersonOnline } from "../realtime/room-registry";
import { registerLiveSession, unregisterLiveSession, type LiveSessionHandle } from "./live-session-registry";
import { personRepository } from "../../repositories/personRepository";
import { resolveAddressee } from "./addressee";
import { getPeerFacePhotoDataUrl } from "./peer-photo";
import {
  joinRoom as joinConversationRoom,
  leaveRoom as leaveConversationRoom,
  publishUtterance as publishRoomUtterance,
  publishFocus as publishRoomFocus,
  type RoomUtterance,
  type RoomPresence,
  type RoomMember,
  type RoomFocus,
  type FloorState,
} from "./conversation-room";
import { HttpSpeakerAgent } from "./http-speaker-agent";
import type { ISpeakerAgent } from "./speaker-interface";
import {
  BoardManagerAgent,
  BOARD_MANAGER_DEFAULT_PROVIDER,
  BOARD_MANAGER_DEFAULT_MODEL,
  type BoardManagerOutputEvent,
  type BoardManagerInvocationInput,
} from "./board-manager-agent";
import type { IBoardManagerAgent } from "./board-manager-interface";
import { LiveBoardManagerAgent } from "./live-board-manager-agent";
import { getModelOption } from "@shared/llm-options";
import {
  buildObserverPrompt,
  buildSpeakerPrompt,
  buildBoardManagerPrompt,
  type ObserverPromptConfig,
  type SpeakerPromptConfig,
  type BoardManagerPromptConfig,
} from "./agent-prompts";
import { composeAacPersona } from "../memory-schema/aac-memory-schema";
import {
  buildEmptyResponseRetryFeedback,
  buildValidatorErrorFeedback,
} from "./prompts/board-manager";
import type { ObserverToolConfig } from "./tool-declarations-observer";
import type { SpeakerToolConfig } from "./tool-declarations-speaker";
import type { BoardManagerToolConfig } from "./tool-declarations-board-manager";
import { buildDefaultClientConfig, type ClientSeizureConfig } from "./client-config";
import { coerceSeizureConfig, resolveThresholds } from "@shared/aac/seizure-config";
import { APP_REGISTRY, getEnabledAppsFromConfig, getAppDefinition } from "./app-registry";
import type { AppConfig } from "./app-registry";
import type { AACAppDefinition } from "./types";
import { customAppRepository } from "../../repositories/customAppRepository";
import { licenseService } from "../licenseService";
import { validateCustomAppDefinition } from "@shared/custom-app-validator";
import { isGoalTreeApp, prepareGoalTreeAppOpen, goalTreeStartupSpec, goalTreeStartupNote } from "./goal-tree-app";

import type {
  AgentEvent,
  ButtonPressedEvent,
  SentenceComposedEvent,
  MuteToggledEvent,
  BuilderOpenedEvent,
  BuilderClosedEvent,
  GuessingEnteredEvent,
  GuessingExitedEvent,
  TranscribedEvent,
  ContextUpdateEvent,
  EngagementChangeEvent,
  SpeechStartEvent,
  SpeechTextFinalizedEvent,
  SpeechEndEvent,
  InterpretIntentEvent,
  ModeChangeEvent,
  EmoteChangeEvent,
  CallPersonEvent,
  AppOpenRequestedEvent,
  AppCloseRequestedEvent,
  WebsiteOpenRequestedEvent,
  BoardButtonOpen,
  BoardRebuiltEvent,
  BoardButtonAddedEvent,
  ContextButtonAddedEvent,
  BinaryChoiceShownEvent,
  BuilderSuggestedEvent,
  BoardLoadRequestedEvent,
  MonitorBroadcastEvent,
  FocusRequestEvent,
  AudioRequestEvent,
  AlarmRaisedEvent,
  GestureRecognizedEvent,
  ObservationModeChangeEvent,
  ThoughtLeakEvent,
} from "./agent-events";
import {
  parseDefinedGestures,
  resolveDefinedGesture,
  GESTURE_PRESS_COOLDOWN_MS,
  type DefinedGesture,
} from "./defined-gestures";

import type { ClientMessage, ServerMessage, IdentifiedFaceWire, IdentifiedVoiceWire, ClientCapabilities, ProcessingActivity } from "./live-relay";
import { ProcessingIndicators } from "./processing-indicators";
import { isCapabilityActive } from "./capability-gate";
import { buildHeardSpeechTurn } from "./speech-text";
import { transcribeSegments, createStreamingSession, type SttStreamSession } from "../voice/google-stt-service";
import { fuseSpeakerLikelihood, renderSpeakerLikelihood, type LipFace, type IdentifiedFaceLite, type VoiceCandidate, type SpeakerLikelihood } from "@shared/aac/speaker-fusion";
import { renderSceneForObserver, type SceneSnapshot, type IdentifiedForScene } from "@shared/aac/scene-state";
import { matchPitch, describeVoiceCharacter } from "@shared/aac/voice-pitch";

/** Rough speech duration (seconds) of a 16-bit PCM WAV, for STT billing. Reads
 *  sampleRate + channels from the header; estimates are fine (STT is cheap). */
function estimateWavSeconds(buf: Buffer): number {
  if (buf.length < 44) return 0;
  try {
    const channels = buf.readUInt16LE(22) || 1;
    const sampleRate = buf.readUInt32LE(24) || 16000;
    const bytesPerSample = (buf.readUInt16LE(34) || 16) / 8;
    const dataBytes = Math.max(0, buf.length - 44);
    const denom = sampleRate * channels * bytesPerSample;
    return denom > 0 ? dataBytes / denom : 0;
  } catch {
    return 0;
  }
}
import {
  energyCostPercent,
  minutesToEmpty,
  type EnergyConfig,
  type EnergyBand,
} from "@shared/aac/energy-meter";
import {
  initBudget,
  applyBudgetCharge,
  bindingEnergy,
  type BudgetState,
  type BudgetWindow,
} from "@shared/aac/budget-meter";
import { windowsForTier, tierByKey, type BudgetTier } from "@shared/aac/budget-tiers";
import { resolveObserverPolicy, type ObserverEconomyPolicy } from "@shared/aac/observer-policy";
import { studentRepository } from "../../repositories/studentRepository";
import { onLedgerCharge } from "../credit-ledger";
import type { ClientConfig } from "./client-config";
import { OBSERVER_SCENE_UPDATE_PROMPT, OBSERVER_STARTUP_PROMPT } from "./prompts/observer";
import { findMatchingFace, recordContactSighting, growFaceGalleryForEntity, penalizeFaceMatch, findMatchingVoice, growVoiceGalleryForEntity, penalizeVoiceMatch, getKnownPeopleForStudent, getVoicePitchProfiles, type FaceMatchResult, type VoiceMatchResult, type KnownPerson, type EntityType, type VoicePitchProfile } from "../biometric/recognition-service";
import {
  resolveStartupMode,
  resolveStudentIsActiveUser,
  buildStartupGreetingTurn,
  type StartupBehavior,
} from "./startup-mode";
import type { AACMuteState } from "./types";
import { T } from "../memory-schema/canonical-terms";
import { getLanguageName } from "@shared/language-names";
import { languageLevelFromInt, type LanguageLevel } from "@shared/aac-language-level";
import type { InterlocutorRegister } from "@shared/interlocutor-register";
import type { SocialPeerParams } from "@shared/social-bot/debug";
import { generatePersona, describePersona, buildSlpConfig, type GeneratedPersona } from "../social-bot/persona-generator";
import { COMPETENCIES, type Archetype, type Competency, type SlpConfig } from "../social-bot/personality-and-challenge";
import type { AppStartupSpec, StartupParams } from "@shared/app-startup";
import { resolveAppStartupParams, type StartupResolveContext } from "./startup-resolver";
import { pickVoice as pickSocialPeerVoice, peerVoicePitchSemitones, peerVoiceFormantSemitones } from "../social-bot/voice-pick";
import {
  buildSocialDebriefDirective,
  runSocialSkillAnalysis,
} from "../social-bot/peer-speaker-prompt";
import { SocialPeerSpeakerAgent } from "../social-bot/peer-speaker-agent";
import { LiveSocialPeerSpeakerAgent } from "../social-bot/live-peer-speaker-agent";
import { authenticateUpgrade } from "../realtime/ws-auth";
import { parseBoardButtons, parseSinglePipeButton } from "./interactive-agent";
import { resolveImageKeys, queueSymbolGeneration } from "../symbol/auto-symbol-service";
import { collectGlyphImageKeys, validateBoardButtons, type BoardButtonViolation, type BoardButtonViolationRule } from "./board-button-validator";
import { expandSuggestionKey, recoverOfferedSuggestionKey } from "./interactive-agent";
import { isValidSuggestionKey, parseSuggestionKey } from "@shared/guessing-mode/suggestion-registry";
import {
  createState as createGuessingState,
  applyPress as applyGuessingPress,
  applyCustomFact as applyGuessingCustomFact,
  rejectCurrentDimension as rejectGuessingDimension,
  expandDimension as expandGuessingDimension,
  buildStateInjection as buildGuessingInjection,
} from "@shared/guessing-mode/state";
import { seedGuessingFromConversation, parseInterestsList, computeAgeYears } from "./guessing-seeder";
import type { GuessingModeState } from "@shared/guessing-mode/types";
import { CATEGORY_DIM_ID } from "@shared/guessing-mode/dimensions";

/** Builder category → top-level guessing category. The sentence builder's
 *  active tab is what tells the engine which top-level dimension to land
 *  in when guessing is launched from the builder (instead of starting at
 *  the "what kind of thing are you looking for?" category step). */
const BUILDER_TAB_TO_GUESSING: Record<string, string> = {
  who: "people",
  do: "actions",
  what: "things",
  where: "places",
  when: "time",
};
import { logLiveSession, logDualAgent, runInSessionContext } from "./dual-agent-logger";
import {
  flowSessionStart,
  flowSystemPrompt,
  flowInput,
  flowOutput,
  flowNote,
} from "./agent-flow-logger";
import { buildDefaultHomeBoard, HOME_BOARD_KEY } from "./default-home-board";
import { smartMergeButtons, sameBoard, type MergeButton } from "./board-merge";
import { isDeviceTarget, isUserTarget, PARTY_DEVICE, PARTY_USER } from "./speech-party";
import { isRepeatPress, formatRepeatNote } from "./press-repeat-guard";
import { resolvePressRouting } from "./press-target";
import { decideIdleTransition, idleThresholdScaleForBand } from "./idle-watchdog";

// ---------------------------------------------------------------------------
// Defaults — Board Manager is hardcoded to a fast model for the MVP. Move
// to a per-agent settings row in a follow-up.
// ---------------------------------------------------------------------------

// BOARD_MANAGER_DEFAULT_PROVIDER / BOARD_MANAGER_DEFAULT_MODEL now live in
// board-manager-agent.ts (imported above) so the agent's prompt-cache
// prewarm keys on the same model string the invocations use.
// Live model used when the per-student `boardManagerLiveModel` AAC setting
// (or the AAC_BOARD_MANAGER_MODE=live env override) is on.
//
// Must be `gemini-3.1-flash-live-preview`: it's the only Live model that
// reliably emits the Board Manager's nested array-of-objects tool arguments.
// The GA `gemini-live-2.5-flash-native-audio` mangles them into degenerate
// strings (see live-board-manager-agent.ts). 3.1 is PUBLIC-API only (not on
// Vertex), so the Board Manager runs against the public Gemini API
// (GEMINI_API_KEY) even though Observer/Speaker use Vertex — see
// createBoardManager(). Override via env for tuning.
const LIVE_BOARD_MANAGER_MODEL =
  process.env.AAC_BOARD_MANAGER_MODEL || "gemini-3.1-flash-live-preview";

// ---------------------------------------------------------------------------
// Home-board navigation intents — behavior hints attached to each home
// button. The button press itself flows through the standard SENTENCE
// BUTTON pipeline (TTS-voiced label, button_pressed event, target=DEVICE).
// These hints are injected as ADDITIONAL context so each agent has the
// right framing when the press lands.
//
// Keyed by the tag prefix that appears at the start of the home button's
// `instruction` string in default-home-board.ts (e.g. "INTERACT" for
// `[INTERACT] ...`).
//
// Each entry describes:
//   - setMode:         programmatic mode set on press (or undefined when
//                      the button doesn't change the mode)
//   - topic:           short identifier used in logs
//   - speakerInteract: behavioral hint for Speaker when in interact mode
//                      ("Greet warmly", "Ask gently", etc.). Delivered as
//                      `[HINT] ...` context BEFORE the press.
//   - speakerAssist:   same, for assist mode. null = no hint (Speaker
//                      stays quiet by default).
//   - board:           topic-palette directive for BoardManager. Delivered
//                      as a synthetic context_update on recent_events.
// ---------------------------------------------------------------------------
interface HomeIntent {
  setMode?: "companion" | "facilitator";
  topic: string;
  /** Speaker hint when the session is in `companion` mode. Pure
   *  behavior — what to say / how to react. No board / palette
   *  instructions (Speaker doesn't own the board). */
  speakerCompanion: string;
  /** Speaker hint when the session is in `facilitator` mode. */
  speakerFacilitator: string | null;
  /** BoardManager-specific palette directive — gets attached as the
   *  `forceRebuildDirective` on the BM invocation, which overrides the
   *  usual "if existing board covers it, no_change" escape. Phrased as
   *  a description of WHAT buttons; the "REBUILD even if it looks
   *  covered" instruction is added by BoardManager's action-hint
   *  builder. Observer + Monitor do NOT see this. */
  boardManager: string;
  /** When true, skip the student-voice TTS for this press AND skip
   *  delivering it to Speaker as a user_turn. The button is a mode /
   *  navigation signal, not something the user is "saying" — there's
   *  nothing to voice and nothing for Speaker to reply to. Coordinator
   *  still applies the mode change, fires speaker/board hints, and
   *  triggers BoardManager. */
  silent?: boolean;
}
const HOME_INTENTS: Record<string, HomeIntent> = {
  INTERACT: {
    setMode: "companion",
    topic: "open conversation",
    speakerCompanion: "The user just opened the conversation with you. Greet them warmly and invite them to talk.",
    speakerFacilitator: "The user just opened the conversation with you. Greet them warmly and invite them to talk.",
    boardManager: "Palette: open-conversation starters — general topics the user might pick from (their interests, their day, their feelings, things they might want to ask you).",
  },
  ASSIST: {
    setMode: "facilitator",
    topic: "talking to someone else",
    speakerCompanion: "The user is now talking to someone else, not you. Stay quiet.",
    speakerFacilitator: "The user is talking to someone else. Stay quiet.",
    silent: true,
    boardManager: "The user just turned to talk to a real person nearby and is starting that conversation. Rebuild the board with a varied set of conversation openers the user can press. Spread across kinds, each a concrete phrase: a greeting ('Hi', 'Hello'), asking about the other person ('How are you?', 'What are you doing?'), sharing their own news ('I want to tell you something', 'Guess what'), suggesting doing something together, commenting on what's around them, or naming something they want. Pull concrete, personal openers from the user's known interests and recent topics in memory so they feel personal, not generic. If there is a clear ongoing conversation that gives context (who's present, what's happening, recent speech), LEAD with openers tied to it — they beat generic phrases. With NO context yet (a fresh conversation), variety matters most.",
  },
  "MY DAY": {
    topic: "my day",
    speakerCompanion: "The user wants to talk about their day. Ask an open question about what happened today.",
    speakerFacilitator: null,
    boardManager: "Palette: today's activities — morning routine, school, lunch, afternoon, evening, plus 'something good happened', 'something hard happened', 'nothing special'.",
  },
  INTERESTS: {
    topic: "interests",
    speakerCompanion: "The user wants to talk about their interests. Mention one you remember and ask them about it.",
    speakerFacilitator: null,
    boardManager: "Palette: the user's known interests / hobbies / favorite topics from memory. If memory is thin, offer broad categories the user can pick from.",
  },
  FEELINGS: {
    topic: "feelings",
    speakerCompanion: "The user wants to talk about how they feel. Ask them gently.",
    speakerFacilitator: null,
    boardManager: "Palette: emotions — happy, sad, tired, excited, angry, scared, bored, frustrated, calm. Include 'I want to talk about something else'.",
  },
  HELP: {
    topic: "help",
    speakerCompanion: "The user pressed Help. Ask what they need.",
    speakerFacilitator: "The user pressed Help while in facilitator mode. Briefly say to the person nearby: they need something.",
    boardManager: "Palette: common needs — I need help, I'm hurt, I need the bathroom, I'm hungry, I'm thirsty, I'm cold, I'm hot, please call someone.",
  },
};

const DEBOUNCE_CONTEXT_UPDATE_MS = 400;
const DEBOUNCE_MONITOR_CALL_MS = 30_000;

/** Social trainer: after a REPLY press, how long to hold before the peer takes
 *  its turn — a window for the user to chain a follow-up BID (which fires the
 *  combined turn immediately). Tunable per a student's response speed via env. */
const SOCIAL_REPLY_HOLD_MS = Number(process.env.AAC_SOCIAL_REPLY_HOLD_MS ?? 1800);
/** Facilitator: after a BID press (the user asked the human something), how long
 *  to wait for the human to answer before offering the user a fresh board. */
const FACILITATOR_BID_WAIT_MS = Number(process.env.AAC_FACILITATOR_BID_WAIT_MS ?? 4000);
/** Sampling temperature for the Board Manager on a home-press topic switch
 *  (a `forceRebuildDirective` turn). Higher than the structured-precision
 *  default (0.2) so repeated presses on a fresh conversation produce a VARIED
 *  set of conversation starters instead of the same near-deterministic board.
 *  Kept moderate to avoid the MALFORMED_FUNCTION_CALL brittleness a high temp
 *  brings to Gemini Flash structured output; env-tunable for fine-tuning. */
const HOME_PRESS_REBUILD_TEMPERATURE = Number(process.env.AAC_HOME_PRESS_REBUILD_TEMPERATURE ?? 0.6);
/** Delay after a practice session ends before a NEW "Practice friend" face is
 *  generated + sent. Until it arrives the button shows no face and does nothing
 *  (a deliberate beat between sessions). */
const PEER_PREVIEW_REGEN_MS = Number(process.env.AAC_PEER_PREVIEW_REGEN_MS ?? 3000);

/** How long the first frame waits for in-flight face recognition before
 *  building its [PEOPLE PRESENT] block. Short so a slow / absent match never
 *  stalls the startup scene description. */
const FACE_RECOGNITION_STARTUP_WAIT_MS = 500;
/** Backstop for the startup greeting: if no user identification arrives after
 *  the first frame, resolve startup anyway (greeting on a personal device with
 *  no contradicting visitor; otherwise just stop waiting). Generous so a slow
 *  / low-confidence face match still wins the race. */
const STARTUP_FALLBACK_MS = 6_000;
/** Once the user is identified AND scene context has arrived, wait this long
 *  before greeting — batches a burst of update_context calls so the greeting
 *  follows the LAST one. */
const STARTUP_GREET_AFTER_CONTEXT_MS = 400;

const RECENT_EVENTS_WINDOW = 20;
/** How many conversational events accumulate before a rolling session
 *  summary refresh is triggered. Mirrors LiveRelay's threshold. */
const SUMMARY_EVERY_N_MESSAGES = 20;

// Compression-window thresholds per profile. These are the main cost
// lever for long quiet sessions: Live bills the FULL running context on
// every turn, and non-text input (audio + image frames at $3/M tokens)
// dominates that cost. Tighter resting thresholds keep Observer's context
// at ~6–12k during quiet stretches instead of ~15–30k, ~2.5× cheaper per
// turn. Speaker is closed entirely in resting (saves the whole second
// session), so its thresholds only apply when awake.
const AWAKE_COMPRESSION_TRIGGER = 30_000;
const AWAKE_COMPRESSION_TARGET = 15_000;
const RESTING_COMPRESSION_TRIGGER = 12_000;
const RESTING_COMPRESSION_TARGET = 6_000;
// Economize-awake tier (Phase 5.1): when full-attention is OFF, bound the
// Observer's short-term memory tighter than full awake — between awake and
// resting. Live re-bills the whole window every turn, so a smaller window is a
// direct, continuous per-turn saving on top of the audio/image→text work.
// Repurposes resting's memory constraint for the awake-but-economizing state.
const AWAKE_ECONOMIZE_COMPRESSION_TRIGGER = 18_000;
const AWAKE_ECONOMIZE_COMPRESSION_TARGET = 9_000;

/** How often to batch buffered Speaker PCM chunks into a single WAV
 *  and send to the client. Mirrors LiveRelay.AUDIO_FLUSH_INTERVAL_MS. */
const AUDIO_FLUSH_INTERVAL_MS = 250;

/** Observer hallucination guard. The Observer fabricates speech transcripts
 *  when it has no audio to work with (mic off / muted / not streaming). If no
 *  client audio has been consumed within this window when a transcript arrives,
 *  the transcript is discarded (surfaced in the debug feed only). Env-tunable.
 *  NOTE: the client gates mic PCM while AI TTS plays (echo prevention), so keep
 *  this comfortably larger than a typical utterance to avoid discarding a real
 *  transcript that lands just as the AI starts talking. */
const OBSERVER_TRANSCRIPT_AUDIO_GATE_MS = Number(process.env.AAC_OBSERVER_AUDIO_GATE_MS ?? 8000);

/** An emergency_alarm must be backed by a real camera image the Observer has
 *  actually SEEN recently — not a coarse, text-only [SCENE] posture/pose label.
 *  The pose model is unreliable for this population (wheelchairs / atypical
 *  postures get misread as "lying"), and a text-only "lying" reading has fired
 *  false emergency alarms. If no real frame (a streamed frame_grid or a
 *  requested focus_frame) reached the Observer within this window when it raises
 *  an emergency, we SUPPRESS it, force a focus frame, and tell the Observer to
 *  look and only re-raise if it actually confirms the emergency. Alerts
 *  (non-emergency) are NOT gated — they're often legitimately text/conversation-
 *  based. Env-tunable. */
const EMERGENCY_ALARM_FRAME_WINDOW_MS = Number(
  process.env.AAC_EMERGENCY_ALARM_FRAME_WINDOW_MS ?? DEFAULT_EMERGENCY_ALARM_FRAME_WINDOW_MS,
);

/** Corrective injected into the native-audio Speaker after it leaks its
 *  reasoning into spoken output. Framed as a system correction: reassure
 *  the model the user did NOT hear it (so it doesn't try to "take it back"
 *  aloud), name the exact failure, and point it back to the silent tool. */
const THOUGHT_LEAK_CORRECTION =
  `[SYSTEM CORRECTION] Your last turn began by voicing your private reasoning ` +
  `(it started with "private_thought" or a similar label). That audio was caught and ` +
  `suppressed — the user did NOT hear it, so do NOT apologize for it or refer to it. ` +
  `Reminder: a private thought is SILENT. To record reasoning, call the private_thought ` +
  `FUNCTION — never speak or write it. Never prefix what you say with "private_thought" ` +
  `or any similar marker; everything you voice reaches the user. ` +
  `Continue the conversation naturally on your next turn.`;

/** Corrective injected after the Speaker prefixes its spoken reply with a
 *  leaked meta-tag ("[USER to YOU]", "[MODE …]", "[CONTEXT …]"). The tag was
 *  already stripped before it reached the user, the TTS, and the
 *  transcript — this just reminds the model the bracketed tags are INPUT
 *  markers it should never reproduce. Framed like every other meta-injection
 *  ([MODE], [CONTEXT], …) and reassures the model so it doesn't try to "take
 *  it back" aloud. */
const LEADING_TAG_CORRECTION =
  `[SYSTEM CORRECTION] Your last reply began with a bracketed tag like ` +
  `"[USER to YOU]" or "[MODE …]". Those bracketed tags are INPUT markers the ` +
  `system adds so you know who is speaking and what is happening — they are ` +
  `NOT part of what you say. That prefix was caught and removed, so the user ` +
  `did NOT see or hear it; do not apologize for it or refer to it. Going ` +
  `forward, speak in plain words with NO bracketed prefix — just your reply.`;

/** Convert a raw 16-bit-LE mono PCM buffer to a WAV buffer by prepending
 *  a 44-byte header. Mirrors LiveRelay.pcmToWav so the new path produces
 *  the same `avatar_audio` payload shape the client already decodes. */
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

/**
 * Inspect a single glyph for the canonical `yes` / `no` SYMBOL token.
 * Mirrors the client's `detectYesNoDefaultColor` so the server can decide
 * binary-choice escape semantics without round-tripping to the renderer.
 * Splits on the same set of glyph delimiters (`+ . # ( )`).
 */
function detectYesNoColor(glyph: string | undefined): "green" | "red" | undefined {
  if (!glyph) return undefined;
  const tokens = glyph.split(/[+.#()]/).map((t) => t.trim()).filter(Boolean);
  let hasYes = false;
  let hasNo = false;
  for (const t of tokens) {
    if (t === "yes") hasYes = true;
    else if (t === "no") hasNo = true;
  }
  if (hasYes && hasNo) return undefined;
  if (hasYes) return "green";
  if (hasNo) return "red";
  return undefined;
}

/**
 * Decide which escape button to render alongside a binary-choice overlay.
 * Yes/no pair (one option yes-tagged, one no-tagged) → `"maybe"` (yellow);
 * anything else → `"neither"` (red, no-symbol).
 *
 * Server-side decision so the client can ship a generic 3-button renderer
 * without baking the yes/no detection rule into its display layer.
 */
function detectBinaryChoiceEscapeKind(
  glyph1: string | undefined,
  glyph2: string | undefined,
): "maybe" | "neither" {
  const c1 = detectYesNoColor(glyph1);
  const c2 = detectYesNoColor(glyph2);
  const colors = [c1, c2];
  if (colors.includes("green") && colors.includes("red")) return "maybe";
  return "neither";
}

/**
 * Render a brief, log-friendly summary of an incoming client WS message.
 * Used only for flow-log visibility — pulls out the salient field(s) from
 * each message type so a one-line entry tells the operator what the press
 * carried. Falls back to "(no payload)" for types with no useful detail.
 */
/** Resolve a student's stored seizureDetection into the client config (resolved
 *  DSP thresholds + seed baseline). Returns undefined when the feature is off,
 *  so the client skips the detector entirely. */
function buildClientSeizureConfig(aacSettings: any): ClientSeizureConfig | undefined {
  const raw = aacSettings?.seizureDetection;
  const config = coerceSeizureConfig(raw?.config);
  if (!config.enabled) return undefined;
  return { enabled: true, thresholds: resolveThresholds(config), baseline: raw?.baseline ?? null };
}

function clientMsgSummary(msg: ClientMessage): string {
  switch (msg.type) {
    case "button_press": {
      const labels = msg.buttons?.join(", ") ?? "";
      const first = msg.buttons?.[0] ?? "";
      const sentence = (msg.sentences && first && msg.sentences[first] !== first)
        ? ` → "${msg.sentences[first]}"` : "";
      return `buttons=[${labels}]${sentence}`;
    }
    case "board_exit":
      return `label="${msg.label}" instruction="${(msg.instruction || "").slice(0, 80)}${(msg.instruction || "").length > 80 ? "…" : ""}"`;
    case "glyph_press":
      return `glyph="${msg.glyph}"`;
    case "guessing_state":
      return `(legacy) keys=[${msg.suggestionKeys?.join(", ") ?? ""}] custom=${msg.customFacts?.length ?? 0} rejected=${msg.rejectedFacts?.length ?? 0}${msg.origin ? ` origin=${msg.origin}` : ""}`;
    case "guessing_enter":
      return msg.builderContext
        ? `from=builder category=${msg.builderContext.category} slot=${msg.builderContext.targetSlot ?? "?"}`
        : "from=conversation";
    case "guessing_press":
      return `key=${msg.suggestionKey}`;
    case "guessing_reject":
      return "(no payload)";
    case "guessing_narrow":
      return `${msg.dimension}=${msg.value}${msg.sourceText ? ` ("${msg.sourceText}")` : ""}`;
    case "exit_guessing":
      return `reason="${msg.reason || ""}"`;
    case "construction_state":
      return `category=${(msg.data as any)?.category ?? "?"} partial="${(msg.data as any)?.partial ?? ""}"`;
    case "set_mute_state":
      return `mute=${msg.muteState}`;
    case "set_paused":
      return `paused=${msg.paused}`;
    case "mic_state":
      return `active=${msg.active}${msg.reason ? ` reason="${msg.reason}"` : ""}`;
    case "user_message":
      return `text="${msg.text.slice(0, 80)}${msg.text.length > 80 ? "…" : ""}"`;
    case "context_injection":
      return `text="${msg.text.slice(0, 80)}${msg.text.length > 80 ? "…" : ""}"`;
    case "initialize":
      return `student=${msg.studentId}${msg.sessionId ? ` session=${msg.sessionId}` : ""}`;
    default:
      return "(no payload)";
  }
}

/**
 * Wrap a list of board buttons into the full board IR the client expects
 * — grid + single "Main" page + per-button row/col/action/style. Mirrors
 * LiveRelay.buildBoardFromButtons so the new path's `set_board`/`board`
 * messages have the same shape the AAC client already knows how to render.
 */
function buildBoardFromButtons(
  buttons: Array<{
    label: string;
    sentence?: string;
    speech?: string;
    iconRef?: string;
    symbolPath?: string;
    imageKey?: string;
    glyph?: string;
    glyphFallback?: string;
    rowSpan?: number;
    colSpan?: number;
    role?: "reply" | "bid";
    buttonType?: "guess" | "category" | "suggestion" | "narrow" | "wordfinder" | "more";
    suggestionKey?: string;
    narrowDimension?: string;
    narrowValue?: string;
    open?: BoardButtonOpen;
  }>,
): unknown {
  const pageId = `page-${Date.now()}`;
  const cols = 4;
  const rows = Math.max(2, Math.ceil(buttons.length / cols));
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
        ...(b.role ? { role: b.role } : {}),
        ...(b.buttonType ? { buttonType: b.buttonType } : {}),
        ...(b.suggestionKey ? { suggestionKey: b.suggestionKey } : {}),
        ...(b.narrowDimension ? { narrowDimension: b.narrowDimension } : {}),
        ...(b.narrowValue ? { narrowValue: b.narrowValue } : {}),
        ...(b.rowSpan && b.rowSpan > 1 ? { rowSpan: b.rowSpan } : {}),
        ...(b.colSpan && b.colSpan > 1 ? { colSpan: b.colSpan } : {}),
        row: Math.floor(i / cols),
        col: i % cols,
        action: b.open?.website
          ? { type: "open_website" as const, url: b.open.website }
          : b.open?.app
            ? { type: "open_app" as const, appId: b.open.app }
            : { type: "speak" as const, text: b.sentence ?? b.speech ?? b.label },
        style: {},
        iconRef: b.iconRef || "fas fa-comment",
        symbolPath: b.symbolPath,
        ...(b.glyph ? { glyph: b.glyph } : {}),
        ...(b.glyphFallback ? { glyphFallback: b.glyphFallback } : {}),
      })),
    }],
    currentPageId: pageId,
  };
}

// ---------------------------------------------------------------------------
// Builder / guessing state mirrors — what Board Manager needs to know about
// the user's in-progress composition.
// ---------------------------------------------------------------------------

interface BuilderState {
  category: "who" | "do" | "what" | "where" | "when";
  modeChip?: string;
  partialSentence: string;
  targetSlot: number;
  excludeKeys: string[];
  currentBoard?: string[];
  payloadTarget?: { slotIndex: number; host: string };
}

interface GuessingNarrowingFact {
  dimension: string;
  value: string;
  sourceText?: string;
  addedAt: number;
}

interface GuessingState {
  dimension: string;
  offeredKeys: string[];
  questionHint: string;
  /** AI-proposed narrowing steps the user has confirmed (parallel track to registry). */
  customFacts: GuessingNarrowingFact[];
  /** Facts (registry or custom) the user explicitly rejected — must not be re-proposed. */
  rejectedFacts: GuessingNarrowingFact[];
}

// ---------------------------------------------------------------------------
// AgentCoordinator
// ---------------------------------------------------------------------------

type CoordinatorState = "initializing" | "ready" | "closing" | "closed";

/** Cheap acoustic fingerprint of a speech clip (fast-tier voice read). */
interface Acoustic { pitchHz: number | null; voiced: number; formantDispersion?: number | null }

/** Per-clip speech sync state (see AgentCoordinator.pendingSpeech). */
interface PendingSpeechEntry {
  text?: string;
  voice?: { embedding: number[]; quality?: number };
  lipActivity?: LipFace[];
  acoustic?: Acoustic;
  fastDone?: boolean;
  slowDone?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Human-readable Speaker context for a call that ended before connecting. */
function describeCallOutcome(outcome: string): string {
  switch (outcome) {
    case "declined":
      return `[CALL DECLINED] They declined the call.`;
    case "no_answer":
      return `[CALL UNANSWERED] There was no answer.`;
    case "unavailable":
      return `[CALL FAILED] They were not available.`;
    case "cancelled":
      return `[CALL CANCELLED] The call was cancelled before connecting.`;
    default:
      return `[CALL FAILED] The call could not be completed.`;
  }
}

export class AgentCoordinator {
  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------
  private state: CoordinatorState = "initializing";
  private readonly ws: WSWebSocket;
  private readonly authedUser: User;

  // Session identity
  private sessionId: string | null = null;
  private studentId: string | null = null;
  private userId: string | undefined;
  /** Registry handle so a clinician can reach this live session by studentId. */
  private liveHandle: LiveSessionHandle | null = null;
  private classroomId: string | null = null;

  // -------------------------------------------------------------------------
  // Agent handles
  // -------------------------------------------------------------------------
  private observer: IObserverAgent | null = null;
  /** Which Observer backend is live right now. "live" = native-audio Gemini
   *  Live (responsive, costly); "economy" = HTTP gemini-2.5-flash completions
   *  (wake-on-event, cheap). Default live; the Observer switches via
   *  set_observation_mode, and the Coordinator force-downgrades to economy at
   *  low energy. See switchObserverBackend / handleObservationModeChange. */
  private observerMode: "live" | "economy" = "live";
  /** Model id used for the economy HTTP backend (also used for its cost
   *  attribution). Set at init alongside observerModel. */
  private observerHttpModel = BOARD_MANAGER_DEFAULT_MODEL;
  /** True while the Coordinator has FORCED economy due to low energy — blocks
   *  the Observer from going back to live until energy recovers. */
  private observerForcedEconomy = false;
  /** Single-flight guard so overlapping switch requests don't race. */
  private observerSwitchInFlight = false;
  private speaker: ISpeakerAgent | null = null;
  private boardManager: IBoardManagerAgent | null = null;
  /** Selected Speaker implementation. Driven by the per-student
   *  `liveAudioSpeaker` AAC setting (default true → "live"). The
   *  AAC_SPEAKER_MODE env var, if set to "http" or "live", overrides
   *  the per-student setting for the whole deployment — useful for
   *  global dev/debug toggling without touching every student row.
   *  HTTP uses Gemini chat completion + streaming TTS; "live" uses the
   *  legacy Gemini Live path with native audio / speak() tool depending
   *  on model. Cached once per session. */
  private speakerMode: "http" | "live" = "live";

  // Per-agent runtime config (rebuilt on transitions; cached here so
  // re-routing decisions don't need to walk back to settings).
  private observerModel = "";
  private speakerModel = "";
  private useVertex = false;
  /** Cached provider key from settingsRepository — needed by createSpeakerAgent
   *  to bind onUsage outside of the original start() closure. */
  private aacChatProvider: string = "gemini";
  private useDirectAudio = true;
  private aiVoiceName: string | undefined;
  private debugMode = false;
  /** Current session profile — drives the tool set + compression on the
   *  two Live agents. Toggled by Observer's rest()/wake_up() events. */
  private sessionProfile: "awake" | "resting" = "awake";

  /** Sleep state. `sleep()` tears down BOTH Live agents (unlike resting,
   *  which keeps Observer alive) to save cost, leaving observer/speaker
   *  null. The next real user action must REBUILD them before routing —
   *  see wakeFromSleep(). Without this, presses hit a null Speaker and the
   *  AI goes permanently silent until re-initialize. */
  private asleep = false;
  /** Single-flight guard for wakeFromSleep so concurrent user actions
   *  (rapid presses, press + frame) don't trigger overlapping rebuilds. */
  private wakePromise: Promise<void> | null = null;
  /** Client message types that count as a real user action and therefore
   *  wake the session from sleep. Ambient streaming (frame_grid/pcm_audio)
   *  and control messages deliberately do NOT — only deliberate input. */
  private static readonly SLEEP_WAKING_MSG_TYPES = new Set<ClientMessage["type"]>([
    "button_press", "board_exit", "glyph_press", "construction_state",
    "guessing_state", "guessing_enter", "guessing_press", "guessing_reject",
    "guessing_narrow", "exit_guessing", "builder_open", "builder_close",
    "set_mute_state", "user_message",
  ]);

  /** Deliberate user inputs that cancel the pending startup greeting — the
   *  user started the interaction themselves, so we don't auto-greet over it. */
  private static readonly STARTUP_CANCELING_MSG_TYPES = new Set<ClientMessage["type"]>([
    "button_press", "board_exit", "glyph_press", "user_message",
  ]);

  /** True while Speaker is actively producing speech (speech_start →
   *  speech_end). Feeds the repeated-press guard's "model responding"
   *  signal so a re-press DURING a long reply is coalesced, not just one
   *  within the time window. */
  private speakerSpeaking = false;

  // ── Backend-busy processing indicators ───────────────────────────────
  /** Mirrors the Speaker / Board Manager / interpret busy state to the client
   *  via `processing` messages so the child sees the system is working on
   *  their input rather than assuming nothing happened (which invites repeat
   *  presses). Pure state machine (dedup + backstop timers) — see
   *  processing-indicators.ts. */
  private readonly processing = new ProcessingIndicators({ emit: (msg) => this.send(msg) });

  // ── Social-training session (peer persona replaces Speaker) ──────────
  /** Active server-owned social-training session. While set, `this.speaker`
   *  holds the director-driven PEER (SocialPeerSpeakerAgent — procedural
   *  personality, deterministic affect engine, no student memory) instead
   *  of the companion. ALWAYS the HTTP forced-tool path, regardless of the
   *  session's general speaker mode. Observer + BoardManager are untouched —
   *  they interact with the peer exactly as with the companion Speaker.
   *  Memory-bearing injections (Monitor context, session summaries, mode
   *  changes) are withheld from the peer while active, and only USER →
   *  DEVICE turns reach the director. */
  private socialPeer: {
    persona: GeneratedPersona;
    /** Concrete handle (this.speaker holds it as ISpeakerAgent) — used to
     *  pull the director's SessionReport at session end. Either the HTTP
     *  text→TTS peer or the decoupled live-audio peer (per-student setting). */
    agent: SocialPeerSpeakerAgent | LiveSocialPeerSpeakerAgent;
    voiceName: string;
    /** TTS voice for the peer's replies (onSpeakerSpeakText). */
    voice: ResolvedVoice;
    /** conversationLog index at session start — the slice from here to
     *  session end is the transcript fed to the social-skill analysis. */
    logStartIndex: number;
    startedAt: number;
  } | null = null;
  /** Single-flight guard for the social start/end Speaker swaps. */
  private socialPeerTransition = false;
  /** Pre-generated peer identity for the home-board "Practice friend" button.
   *  The client renders this persona's face on the button; when a session
   *  starts it is REUSED (consumed) so the session face matches the preview.
   *  Generated without the AI startup resolver (no per-home-board LLM cost);
   *  engine tuning (difficulty/scenario/skills) is still resolved at start. */
  private pendingPeerPersona: { persona: GeneratedPersona; voiceName: string; voice: ResolvedVoice } | null = null;
  /** Delayed regeneration of the preview face after a session ends. */
  private peerPreviewTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Follow-up turn composition (Phase B) ─────────────────────────────
  /** Social trainer: buffered reply sentence(s) awaiting either a chained BID
   *  (commit combined immediately) or the hold timer (commit the reply alone). */
  private socialReplyBuffer: { sentences: string[]; timer: ReturnType<typeof setTimeout> | null; lastEvent: AgentEvent | null } | null = null;
  /** Facilitator: pending "no answer from the human → offer a fresh board"
   *  timer started by a BID press; cancelled by a reply press or the human
   *  actually answering (USER-targeted speech). */
  private facilitatorBidTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of the last statement directed AT the user (a person answering)
   *  — lets the facilitator bid timer skip the fresh-board if the human replied. */
  private lastExternalToUserAt = 0;
  /** Conversational role of the previous (non-repeat) button press. A press
   *  right after a BID counts as jumping a handed-over turn (Phase C penalty). */
  private lastPressRole: "reply" | "bid" | null = null;

  // ── Repeated-press guard ──────────────────────────────────────────────
  // Some students perseverate on a button — tapping the same one many times.
  // Each tap would otherwise interrupt Speaker (sendUserTurn) and fire a
  // fresh BoardManager rebuild, thrashing turn scheduling. We coalesce
  // identical presses (re-voicing the utterance for feedback, but NOT
  // emitting a new button_pressed turn) and persist a single consolidated
  // note so the Monitor still sees the behavior. Pure decision logic lives
  // in press-repeat-guard.ts (shared with the legacy live-relay path).
  private static readonly PRESS_REPEAT_WINDOW_MS = 4_000;
  private static readonly PRESS_SIGNATURE_SEP = String.fromCharCode(1);
  private lastPressSignature: string | null = null;
  private lastPressAt = 0;
  private pressRepeatCount = 0;
  // Repeats that landed AFTER the response to the burst's first press had
  // settled (Speaker idle, no rebuild in flight, no deferred timer) — i.e. the
  // user re-pressed even though the board/AI had already responded. These are
  // genuine PERSEVERATION; repeats that land while the system is still busy are
  // just latency re-presses (the board hadn't visibly updated yet) and don't
  // count. Only a settled-repeat burst nudges the Speaker (see flushRepeatBurst).
  private pressSettledRepeatCount = 0;
  private pressBurstFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Deferred-rest mechanism. Observer's `rest()` is a REQUEST, not an
   *  immediate command — we only honor it when the user has been
   *  conversation-inactive for REST_DEBOUNCE_MS. A button press,
   *  composed sentence, USER-or-DEVICE-targeted transcript, or
   *  Speaker utterance is "conversation activity" and resets the
   *  timer + clears any pending rest. */
  private static readonly REST_DEBOUNCE_MS = 60_000;
  private lastEngagementActivityAt = Date.now();
  private pendingRestTimer: ReturnType<typeof setTimeout> | null = null;

  // Voice routing (fallback Speaker + student-interpret paths)
  private aiVoice: ResolvedVoice | null = null;
  private studentVoice: ResolvedVoice | null = null;

  // -------------------------------------------------------------------------
  // Per-session state mirrors
  // -------------------------------------------------------------------------
  private muteState: AACMuteState = "unmuted";
  /** Client-side pause (e.g. user tab backgrounded). When true, we don't
   *  forward frames/audio to Observer. */
  private paused = false;

  // -------------------------------------------------------------------------
  // Cost-saving / adaptive-fidelity gating (see planning-docs/aac-cost-saving*)
  // -------------------------------------------------------------------------
  /** Per-student master switch. When fullAttentionMode is ON, the AAC streams
   *  raw frames + audio at full fidelity and ALL cost-saving substitutions are
   *  disabled. When OFF (the default), the system may economize: text-first
   *  steady state, client STT, scene_state, energy throttling. Read from
   *  studentRow.aacSettings at init. `economize` is the inverse. */
  private fullAttentionMode = false;
  /** What offloading the connected client advertised at `initialize`. Empty
   *  ({}) for older clients — they get the raw-streaming path regardless of
   *  fullAttentionMode. */
  private clientCapabilities: ClientCapabilities = {};

  /** Phase 1b audio backlog pull: the clipId of the most recent speech_text
   *  (what the Observer would want to re-hear), and the clipId we've asked the
   *  client for and are waiting on. */
  private lastSpeechClipId: string | null = null;
  private pendingAudioPullClipId: string | null = null;

  /** Per-clip speech state, keyed by clipId. Two tiers run INDEPENDENTLY: the
   *  FAST read fires on the STT text + pitch + lip (no waiting), the SLOW read on
   *  the parallel voice embedding (background). `fastDone`/`slowDone` keep each
   *  from firing twice; the entry is reaped once both are done or on a timer. */
  private pendingSpeech = new Map<string, PendingSpeechEntry>();
  /** Reap window for a half-arrived clip (STT error, or embedding never sent) so
   *  the map can't leak. Tiers no longer block each other, so this is just GC. */
  private static readonly SPEECH_SYNC_TIMEOUT_MS = 600;
  /** Cached per-person pitch profiles for the FAST voice read; refreshed lazily. */
  private pitchProfiles: VoicePitchProfile[] | null = null;
  private pitchProfilesAt = 0;
  private static readonly PITCH_PROFILE_TTL_MS = 60_000;
  /** Known-people name phrases for STT speech adaptation, cached per session. */
  private knownNamePhrases: string[] | null = null;
  private knownNamePhrasesAt = 0;

  /** The SINGLE cost signal is the persistent money budget (`bindingEnergy` over
   *  `budgetWindows`, below) — there is no separate per-session meter. The
   *  Observer/Speaker still experience it as "energy/tiredness" (the [ENERGY]
   *  note + the <energy> prompt framing), but the number they see IS the money
   *  budget's binding-window %. `lastEnergyBand` / `lastReportedEnergyPercent`
   *  track what we last told the Observer so recovery is reported when the %
   *  climbs >=1 above the last, and drains lower it silently. */
  private lastEnergyBand: EnergyBand | null = null;
  private lastReportedEnergyPercent = 100;
  /** Periodic recompute so passive regeneration during quiet stretches (no
   *  charge to trigger it) still reaches the Observer and re-drives the throttle. */
  private energyTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly ENERGY_TICK_MS = 15_000;
  /** Wall-clock of the last worthwhile OBSERVER activity (a transcript() or a
   *  meaningful update_context) — resets the low-band sleep timer alongside real
   *  engagement, so a session where the Observer is actively transcribing an
   *  in-person exchange doesn't sleep out from under it. See maybeIdleTransition. */
  private lastObservationActivityAt = 0;

  /** Persistent multi-window budget meter — the SINGLE cost signal. Survives
   *  across sessions, bounds MONTHLY spend, and its binding (tightest) window %
   *  is both the level the AI sees (as [ENERGY]) and what drives the throttle
   *  ladder. Loaded from students.budgetMeters at init, charged via the universal
   *  ledger hook, and persisted (debounced + on close). Active whenever
   *  economizing. See planning-docs/aac-budget-tiers-spec.md. */
  private budgetTier: BudgetTier = tierByKey(undefined);
  /** Standing Observer economy constraints (default backend / live permission /
   *  always-conservative). Resolved at init from the budget tier's DEFAULTS +
   *  any explicit per-student aac_settings override — a policy layer, not the
   *  budget number. Read by the tool/prompt build, the initial + wake backend
   *  choice, and the throttle so no deep code branches on `tier === "demo"`. */
  private observerPolicy: ObserverEconomyPolicy = resolveObserverPolicy(tierByKey(undefined));
  private budgetWindows: BudgetWindow[] = [];
  private budgetState: BudgetState = {};
  private budgetDirty = false;
  private lastBudgetSaveAt = 0;
  /** True while the Speaker has been told it's tired (low band, <25%) so it acts
   *  tired and keeps replies brief. Dedups the inject/lift so we message it only
   *  on the transition; re-applied to a freshly-rebuilt Speaker (primeFreshSpeaker). */
  private budgetSpeakerTiredActive = false;
  /** Set when a drop into the low band wanted to force the economy Observer
   *  backend but the AI was mid-sentence — the switch (a full Observer rebuild)
   *  is deferred to the next idle boundary (onSpeakerSpeechEnd) so it never cuts
   *  a sentence, then lands the moment it's not busy. */
  private economySwitchPendingIdle = false;
  /** Unsubscribe from the ledger charge hook (every session charge → budget). */
  private budgetChargeUnsub: (() => void) | null = null;
  /** Last binding budget % pushed to the client's energy bar; -1 = never sent.
   *  Gates the push so we only message on an actual integer-% change. */
  private lastSentBudgetPercent = -1;
  /** Debounce floor for persisting budget state on a charge (a final flush
   *  always runs on cleanup, so an in-flight debounce can't lose the tail). */
  private static readonly BUDGET_SAVE_MIN_INTERVAL_MS = 30_000;
  /** Band floors on the budget binding %. Below SPEAKER_SLEEP the Speaker never
   *  wakes (board-only presence — economy Observer + HTTP board still run so the
   *  student can press buttons and stay monitored); at/below SHUTDOWN all STT +
   *  LLM stop entirely (nothing but the budget regenerating while idle). The
   *  low band (<25%, energyBand "low") additionally forces the Observer to its
   *  cheap HTTP backend + the budget-scaled sleep timer + a tired Speaker. */
  private static readonly BUDGET_SPEAKER_SLEEP_PERCENT = 10;
  private static readonly BUDGET_SHUTDOWN_PERCENT = 0;
  /** The meter ACCUMULATES + PERSISTS whenever economizing — harmless, and it
   *  builds the real per-student spend curve we validate tiers against before
   *  enabling the throttle fleet-wide. */
  private get budgetMeterEnabled(): boolean {
    return this.economize;
  }
  /** The THROTTLE effects (idle→sleep tightening, economy-backend force, and the
   *  [BUDGET] Observer notes) are gated behind a master flag separate from
   *  accumulation. DEFAULT ON for an economizing session — set AAC_BUDGET_METER
   *  ="false" (also accepts "0"/"off") to keep tracking/persisting the budget
   *  while disabling the throttle effects. Still requires `budgetMeterEnabled`
   *  (economize); a full-attention session never throttles on budget. */
  private get budgetThrottleEnabled(): boolean {
    if (!this.budgetMeterEnabled) return false;
    const v = process.env.AAC_BUDGET_METER?.toLowerCase();
    return !(v === "false" || v === "0" || v === "off");
  }
  /** Sustained perception attention the Observer controls (set_visual_attention /
   *  set_audio_attention). "text" = cheap text-derived input (scene_state / STT);
   *  "live" = direct camera frames / raw audio. Mapped to clientConfig
   *  sceneStateActive / sttActive. Initialized from capability at session start. */
  private visualAttention: "text" | "live" = "text";
  /** audio: "text" (STT) | "adaptive" (VAD-gated raw audio) | "live" (continuous
   *  raw audio). */
  private audioAttention: "text" | "adaptive" | "live" = "text";
  /** Credits drained per live agent since the last [HEARD SPEECH] the Observer
   *  was given, so each transcript carries a "this exchange cost −N% (speaker …)"
   *  note. Reset on each injectHeardSpeech. */
  private drainSinceTranscript = { observer: 0, speaker: 0, boardManager: 0 };

  /** The Observer's AWAKE compression window. Economize sessions use a tighter
   *  tier (Phase 5.1) to cut the per-turn re-billing of the running context.
   *  Used at initial connect, profile transitions, and wake-from-sleep. */
  private observerAwakeCompression(): { trigger: number; target: number } {
    // Low band (<25%): all agents drop to SHORT-MEMORY (the tighter resting
    // compression) to cut the per-turn context re-billing. Applies on the
    // frequent low-band rebuilds (the budget-scaled sleep timer tears agents
    // down often), so no disruptive mid-turn reconnect is needed.
    if (this.lowBandActive()) {
      return { trigger: RESTING_COMPRESSION_TRIGGER, target: RESTING_COMPRESSION_TARGET };
    }
    return this.economize
      ? { trigger: AWAKE_ECONOMIZE_COMPRESSION_TRIGGER, target: AWAKE_ECONOMIZE_COMPRESSION_TARGET }
      : { trigger: AWAKE_COMPRESSION_TRIGGER, target: AWAKE_COMPRESSION_TARGET };
  }

  /** Speaker compression tiers — SHORT-MEMORY (resting tier) in the low band,
   *  otherwise the normal awake tier. Mirrors observerAwakeCompression. */
  private speakerCompression(): { trigger: number; target: number } {
    return this.lowBandActive()
      ? { trigger: RESTING_COMPRESSION_TRIGGER, target: RESTING_COMPRESSION_TARGET }
      : { trigger: AWAKE_COMPRESSION_TRIGGER, target: AWAKE_COMPRESSION_TARGET };
  }

  /** True when the single cost signal (budget binding %) is in the low band
   *  (<25%) and the throttle is active — the trigger for short-memory mode, the
   *  tired Speaker, forced-HTTP Observer, and the budget-scaled sleep timer. */
  private lowBandActive(): boolean {
    return this.budgetThrottleEnabled
      && bindingEnergy(this.budgetState, this.budgetWindows, Date.now()).band === "low";
  }

  /** The model id the CURRENT Observer backend runs on — the native-audio
   *  Live model in "live" mode, the cheap text model in "economy" mode. Used
   *  for cost attribution so each turn bills at the backend's real rates. */
  private observerActiveModel(): string {
    return this.observerMode === "economy" ? this.observerHttpModel : this.observerModel;
  }

  /** Master gate for the Observer cost-saving behaviors added 2026-06-28:
   *  energy-scaled idle→sleep, the honest energy-budget baseline text, the
   *  hybrid live/economy backend + `set_observation_mode` tool, and the
   *  low-energy force-economy throttle + mode hints. DEFAULT ON — set
   *  AAC_OBSERVER_COST_SAVING="false" (also accepts "0"/"off") to restore the
   *  legacy behavior (always Live, legacy idle timing, original budget text, no
   *  economy tool). */
  private get economyObserverEnabled(): boolean {
    const v = process.env.AAC_OBSERVER_COST_SAVING?.toLowerCase();
    return !(v === "false" || v === "0" || v === "off");
  }

  /** True when the Observer may switch backends via set_observation_mode: the
   *  cost-saving system is on AND the policy permits Live. When false the tool +
   *  its <energy> lines are omitted and the backend is pinned to economy. */
  private get observerModeSwitchable(): boolean {
    return this.economyObserverEnabled && this.observerPolicy.allowLive;
  }

  /** True when cost-saving substitutions are allowed (full-attention OFF). */
  private get economize(): boolean {
    return !this.fullAttentionMode;
  }

  /** A capability is ACTIVE when (a) we may economize (full-attention OFF) and
   *  (b) the client advertised it. Cost saving is the default for an
   *  economizing session with an updated client. */
  private capable(cap: keyof ClientCapabilities): boolean {
    return isCapabilityActive({
      fullAttentionMode: this.fullAttentionMode,
      advertised: !!this.clientCapabilities?.[cap],
    });
  }

  /** Coordinator-owned interaction mode. Speaker emits the change via
   *  set_interaction_mode, but the source of truth lives here so it
   *  survives profile transitions (awake ↔ resting reconnect both Live
   *  agents with fresh prompts; without persistence the mode would
   *  default to whatever the new prompt's defaults imply). Re-broadcast
   *  to all three agents at the end of every wake transition. */
  private currentInteractionMode: "companion" | "facilitator" = "companion";
  /** Register of the human the user is currently talking to (peer vs helper),
   *  as last reported by the Observer. Biases the BoardManager palette. A live
   *  social-training session overrides this to "peer". `undefined` → balanced. */
  private currentInterlocutorRegister: InterlocutorRegister | undefined;

  /** Cached AI name from this session's settings, used for DEVICE
   *  identity matching in transcripts. */
  private aiName: string | undefined;
  /** Cached active-student first-name; treated as a synonym for USER in
   *  transcript speaker/target comparisons. */
  private currentStudentName: string | undefined;
  /** Cached active-student FULL name. The Observer routinely tags
   *  transcripts with the full name even though prompts use the first
   *  name, so USER-target matching must accept both. */
  private currentStudentFullName: string | undefined;

  /** Default target the BoardManager's next rebuild applies to its
   *  buttons. Updated by routeBoardRebuilt (carries through to
   *  ButtonPressedEvent.target on the next press). */
  private currentBoardTarget: string = "DEVICE";

  /** Clinician-defined gestures (aac_settings.defined_gestures), parsed at
   *  prompt build. Observer reports matches via report_gesture; the
   *  Coordinator resolves against this registry and replays the
   *  button-press flow with the gesture's meaning. */
  private definedGestures: DefinedGesture[] = [];
  /** Per-gesture timestamp of the last synthetic press — Observer sees a
   *  held gesture across many frames; the cooldown collapses re-reports. */
  private lastGesturePressAt = new Map<string, number>();

  /** Counters for periodic flow-confirmation logging. */
  private frameCount = 0;
  private pcmCount = 0;
  /** Timestamp (ms) of the last PCM audio chunk consumed from the client.
   *  Drives the Observer hallucination guard — see
   *  OBSERVER_TRANSCRIPT_AUDIO_GATE_MS. 0 means no audio yet this session. */
  private lastAudioInputAt = 0;
  /** Timestamp (ms) of the last REAL camera image delivered to the Observer
   *  (a streamed frame_grid or a requested focus_frame) — NOT a cheap text
   *  [SCENE] line. Gates emergency_alarm (see EMERGENCY_ALARM_FRAME_WINDOW_MS)
   *  so a text-only posture reading can't fire an alarm without a visual look.
   *  0 means no real frame yet this session. */
  private lastRealFrameAt = 0;

  // -------------------------------------------------------------------------
  // Face recognition (ported from the legacy LiveRelay path). Populated when
  // the client sends `unknown_face_descriptors`; feeds the `[PEOPLE PRESENT]`
  // block appended to frame prompts and the `people_identified` debug echo.
  // -------------------------------------------------------------------------
  private currentIdentifiedFaces: IdentifiedFaceWire[] = [];
  private currentIdentifiedFacesAt = 0;
  /** Per-contact rate limit for `recordContactSighting()` — keyed by contact id. */
  private lastSightingBumpAt: Map<string, number> = new Map();
  /** Last descriptor that matched each entity, with its quality. Held as a
   *  PENDING sample: gallery growth is gated behind the Observer confirming the
   *  identity (person_identified / set_person_as_user → seedFaceFromObserver), so
   *  embeddings never self-reinforce without verification. Also the target for a
   *  later misidentification correction. Keyed by `${entityType}:${entityId}`. */
  private recentMatchedDescriptors: Map<string, { descriptor: number[]; quality?: number; at: number }> = new Map();
  /** Most-recent face descriptor we could NOT confidently attribute. Held so the
   *  Observer NAMING an unknown face (person_identified) can seed a brand-new
   *  identity — the face mirror of `recentUnattributedVoice`. */
  private recentUnattributedFace: { descriptor: number[]; quality: number; at: number } | null = null;
  /** In-flight face-recognition promise. The first-frame startup path awaits
   *  this (briefly) so the startup scene description has face results. */
  private faceRecognitionInFlight: Promise<void> | null = null;
  /** TTL after which the identified-faces list is considered stale and dropped. */
  private static readonly IDENTIFIED_FACES_TTL_MS = 30_000;
  /** Minimum gap between sighting bumps for the same contact. */
  private static readonly SIGHTING_BUMP_INTERVAL_MS = 60_000;
  /** A recent matched descriptor older than this is no longer a valid correction
   *  target / pending-growth sample. */
  private static readonly RECENT_MATCH_TTL_MS = 120_000;
  /** Matches below this confidence are "borderline": the AI is asked to verify
   *  the identity against the on-file physical description rather than trust it. */
  private static readonly BORDERLINE_CONFIDENCE = 0.6;
  /** Minimum quality for a face sample to be worth stashing / growing from. */
  private static readonly FACE_SAMPLE_QUALITY_MIN = 0.4;

  // -------------------------------------------------------------------------
  // Voice recognition. Populated when the client sends `voice_descriptors`
  // (speaker embeddings computed from heard speech). Feeds a `[VOICES HEARD]`
  // block appended after `[PEOPLE PRESENT]` and the `voices_identified` debug
  // echo. Unlike faces, a voice cannot self-attribute a NEW identity — the
  // gallery bootstraps when the Observer NAMES an unknown voice
  // (update_context: voice_identified), which seeds the most-recent
  // unattributed embedding into that person's gallery.
  // -------------------------------------------------------------------------
  private currentIdentifiedVoices: IdentifiedVoiceWire[] = [];
  private currentIdentifiedVoicesAt = 0;
  /** Last voice embedding that matched each entity, with its quality. Held as a
   *  PENDING sample (growth gated behind Observer verification) and the target
   *  for a later misidentification correction. Keyed by `${entityType}:${entityId}`. */
  private recentMatchedVoiceEmbeddings: Map<string, { embedding: number[]; quality?: number; pitch?: number; dispersion?: number; at: number }> = new Map();
  /** Most-recent voice embedding we could NOT confidently attribute. Held so the
   *  Observer naming an unknown voice can seed the right person's gallery — the
   *  only way a brand-new voice identity bootstraps. Carries the clip's pitch +
   *  formant dispersion so the fast tier can use them once the person is named. */
  private recentUnattributedVoice: { embedding: number[]; quality: number; pitch?: number; dispersion?: number; at: number } | null = null;
  /** TTL after which the identified-voices list is considered stale. Longer than
   *  faces: people are intermittently silent, so a voice ID stays relevant
   *  through pauses in speech. */
  private static readonly IDENTIFIED_VOICES_TTL_MS = 60_000;
  /** Minimum quality for a voice sample to be worth stashing / growing from. */
  private static readonly VOICE_SAMPLE_QUALITY_MIN = 0.35;

  // -------------------------------------------------------------------------
  // Startup mode (CONTEXTUAL / MENU). Resolved from context at init; consumed
  // once on the first frame's scene description (see flushContextUpdates).
  // -------------------------------------------------------------------------
  private startupBehavior: StartupBehavior = "contextual";
  /** One-shot: true until the startup greeting fires, the user presses a
   *  button first, or the fallback timer resolves it. */
  private startupPending = true;
  /** Set once the Observer explicitly confirms who the active user is via
   *  set_person_as_user — a strong "the user is identified" signal. */
  private startupUserConfirmed = false;
  /** Set once the active user has been identified (arms the greeting). */
  private startupUserIdentified = false;
  /** Set once the first scene context (update_context) has been injected. */
  private startupContextReceived = false;
  /** Settle timer — fires the greeting AFTER context has landed. */
  private startupGreetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fallback timer so startup still resolves if no identification arrives. */
  private startupFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // Echo suppression is prompt-side only — Observer's <transcription>
  // section tells it to ignore device-speaker playback (button-press TTS
  // + Speaker's own voice), and we inject [OWN_SPEECH] / [BUTTON PRESS]
  // context so it knows which audio to disregard. No hard mic mute; the
  // single-agent system relied on the same prompt-side mechanism and it
  // worked reliably.

  /** Buffer for Speaker native-audio chunks. Raw PCM (base64) — flushed
   *  as a single WAV every 250ms (or on SpeechEnd). Mirrors the legacy
   *  LiveRelay's directAudioChunks/flushDirectAudio pattern. */
  private speakerAudioChunks: string[] = [];
  private speakerAudioFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the current Speaker turn is being suppressed because it
   *  leaked private reasoning into spoken output ("private_thought …").
   *  Set by onSpeakerSuppressAudio(), cleared when the turn resolves to a
   *  thought_leak event. While set, Speaker PCM chunks are dropped. */
  private suppressSpeakerAudio = false;

  /** Cancellation handle for the in-flight student-voice TTS stream.
   *  A new press / interpret aborts the previous and tells the client
   *  to clear any queued utterance audio so the SENTENCE plays once. */
  private studentTtsAbortController: AbortController | null = null;

  /** Type of the most recent user input. interpret() is only valid
   *  immediately after a sentence_composed turn; the tool description
   *  says so but native audio doesn't always honor it. We gate
   *  interpret_intent server-side so a stray call on a button press
   *  doesn't fire a second student-TTS for the same SENTENCE. Reset
   *  to "none" once consumed (after interpret runs) so a duplicate
   *  interpret on the same composed turn is also blocked. */
  private lastUserInputType: "button_pressed" | "sentence_composed" | "transcribed" | "none" = "none";

  // WebSocket keepalive. Without application-level traffic, an idle live
  // session (resting/asleep) generates nothing on the wire, so the hosting
  // proxy (Render/ALB/API-Gateway) closes the socket at its ~20-min idle
  // timeout — which recycles into a fresh empty session and burns a Monitor
  // summary each cycle. A periodic ws.ping() keeps the connection warm.
  // Mirrors legacy LiveRelay.startPingTimer.
  private static readonly PING_INTERVAL_MS = 30_000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;

  // Server-side idle watchdog. The Observer AI is supposed to call rest()/
  // sleep() when the user disengages, but it does so unreliably — so we force
  // the downward transitions purely on elapsed idle time. After IDLE_REST_MS
  // with no real engagement we drop awake→resting; after IDLE_SLEEP_MS we go
  // fully asleep (tearing down ALL Live agents — zero Gemini cost), keeping the
  // WS open so the next user action rebuilds via wakeFromSleep.
  private static readonly IDLE_REST_MS = 90_000;
  private static readonly IDLE_SLEEP_MS = 300_000;
  private static readonly IDLE_WATCHDOG_INTERVAL_MS = 15_000;
  private idleWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  // Debouncing
  private contextUpdateBuffer: ContextUpdateEvent[] = [];
  private contextUpdateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Monitor de-dup
  private pendingMonitorCalls: Array<{ reason: string; source: string }> = [];
  private monitorCallDedupTimer: ReturnType<typeof setTimeout> | null = null;

  // Board Manager invocation serialization (no two HTTP calls in flight
  // per session — chained instead).
  private boardMgrInFlight = false;
  private boardMgrPendingTriggers: AgentEvent[] = [];
  /** Triggering events of the current in-flight invocation. Captured at
   *  invocation start so retry queues (empty-response, validator
   *  feedback) can re-supply them on the retry — without this, retries
   *  fire with `(no triggers)` and the model has no concrete beat to
   *  anchor to, producing a disproportionate share of MALFORMEDs. */
  private boardMgrCurrentTriggers: AgentEvent[] = [];
  /** Triggers paired with `boardMgrPendingFeedback` — the original beat
   *  the retry is supposed to address. Set by the retry queues
   *  alongside pendingFeedback, drained by invokeBoardManager into the
   *  effective triggers of the next invocation. This is what prevents
   *  the "observation override" race: when an ambient observation
   *  arrives between a failed rebuild and its retry, the observation's
   *  invocation would otherwise consume pendingFeedback without
   *  carrying the original triggers, and the model would no_change on
   *  the observation alone — losing the rebuild the original beat
   *  demanded. With this field, the original triggers are always
   *  merged in for as long as pendingFeedback is set. */
  private boardMgrPendingRetryTriggers: AgentEvent[] = [];

  /** Session-scoped memory of validator violations, keyed by rule with the
   *  offending tokens deduped. Rendered as <recent_mistakes> in every BM
   *  invocation CONTEXT (user message — keeps the system prompt cacheable)
   *  so the stateless model stops repeating the same rejected-button
   *  mistakes over the course of the session. */
  private boardMgrViolationMemory = new Map<BoardButtonViolationRule, Set<string>>();
  /** Cap tokens remembered per rule so the block stays terse. */
  private static readonly VIOLATION_MEMORY_TOKEN_CAP = 10;
  /** Single-shot flag set by handleGuessingPress / handleGuessingNarrow /
   *  handleGuessingReject and consumed by the very next button_pressed
   *  event. A guessing-intent button press fires TWO server events —
   *  the button_press (TTS + Speaker user_turn) and the guessing_*
   *  intent (engine update → narrowing directive to Speaker). Speaker
   *  responds to both unless one is suppressed. The flag tells the
   *  button_pressed routing to send the press as a CONTEXT injection
   *  only; the narrowing directive carries the turn. Cleared on first
   *  consume so a subsequent non-narrowing press isn't accidentally
   *  silenced.
   *
   *  We can't infer "is this a narrowing press?" from button data alone
   *  because suggestion buttons render with the registry's English
   *  labelEn server-side but arrive with the localized Hebrew label
   *  from the client — a label-match lookup misses every time. */
  private suppressNextPressUserTurn = false;
  /** AbortController for the currently in-flight BoardMgr invocation.
   *  When a newer Speaker speech arrives mid-flight the in-flight result
   *  is stale by definition — abort the LLM call, skip applying any
   *  events that do come back, and let the queued invocation run with
   *  the fresh context. The Gemini SDK cancels client-side only (server
   *  still bills) but we stop blocking on a useless wait. */
  private boardMgrAbortController: AbortController | null = null;
  /**
   * Deferred press-triggered BoardManager invocation. When the user presses
   * a button addressed to DEVICE, Speaker will reply within ~2s and
   * speech_text_finalized supersedes the press for the board rebuild —
   * running FOLLOW-UPS first and REPLIES second wastes ~4s of latency
   * AND doubles MALFORMED exposure. We defer the press invocation and let
   * speech_text_finalized cancel it. If Speaker doesn't reply (mute mode,
   * MALFORMED, etc.) within DEFERRED_BM_PRESS_MS, the timer fires and BM
   * builds FOLLOW-UPS as a fallback so the user isn't stranded.
   */
  private deferredBoardMgrTrigger: AgentEvent | null = null;
  private deferredBoardMgrTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEFERRED_BM_PRESS_MS = 4_000;

  /** Validator-error feedback to fold into the NEXT BoardManager
   *  invocation's prompt. When set, the next invoke uses this as a
   *  retry context so the model can correct the rejected buttons.
   *  Cleared after delivery; bounded by `boardMgrRetryAttempt` so a
   *  pathological input can't loop forever. */
  private boardMgrPendingFeedback: string | null = null;
  private boardMgrRetryAttempt = 0;
  private static readonly BOARD_MGR_MAX_RETRIES = 1;

  // Recent events window — feeds BoardMgr invocations for continuity.
  private recentEvents: AgentEvent[] = [];

  /** One-shot palette directive consumed by the next BoardManager
   *  invocation. Set by routeHomeTopicPressInner when the user presses
   *  a home-board navigation button — forces a rebuild_board with the
   *  given palette even when the existing board's labels look similar
   *  to the topic. Cleared after use. */
  private pendingForceRebuildDirective: string | null = null;

  // State mirrors (so each BoardMgr invocation has a snapshot)
  private currentBoardLabels: string[] = [];
  /**
   * Full button objects of the current MAIN board. Tracked alongside
   * `currentBoardLabels` so `add_board_button` can run `smartMergeButtons`
   * against the real button shapes (not just labels) — preserves slot
   * positions for the client's animation and matches incoming buttons
   * against existing ones by glyph/sentence overlap, not just label.
   */
  private currentBoardButtons: MergeButton[] = [];
  /** Permitted-website allowlist + launchable app ids, mirrored from the
   *  prompt inputs so `resolveButtonOpen` can re-gate BoardManager-authored
   *  launch buttons server-side before they reach the client. */
  private permittedWebsites: PermittedWebsite[] = [];
  private launchableAppIds = new Set<string>();
  /** Max buttons on the main board. Mirrors maxBoardItems on the
   *  BoardManager tool config; kept here so add_board_button merge has
   *  a single source of truth. */
  private static readonly MAIN_BOARD_MAX = 8;
  private contextSidebarLabels: string[] = [];
  private loadedBoardId: string | null = null;
  private builderState: BuilderState | null = null;
  private guessingState: GuessingState | null = null;
  /**
   * Authoritative Word Finder engine state (from `shared/guessing-mode/`).
   * Owns the dimensions / weights / history / facts that drive narrowing.
   * The flat `guessingState` field above is a DERIVED snapshot recomputed
   * from this whenever the engine state changes (so all the downstream
   * readers — Speaker directive, BoardManager invocation, etc. — keep
   * their existing shape).
   *
   * Moved server-side 2026-06: previously the client owned the engine
   * and shipped a rendered injection per turn, which meant any logic
   * tweak required a client rebuild + redeploy. With the engine here,
   * intent messages (`guessing_enter` / `guessing_press` /
   * `guessing_reject` / `guessing_narrow`) drive all mutations.
   */
  private guessingEngineState: GuessingModeState | null = null;
  /** Where the current Word Finder session was launched from. Used so a
   *  builder-origin resolution can feed the concept back into the active
   *  slot when guessing ends. */
  private guessingOrigin: "conversation" | "builder" = "conversation";
  private guessingBuilderContext: { targetSlot: number | null; partialGlyph: string; category: string } | null = null;

  // Cached prompts + tool configs — reused by profile transitions so we
  // don't have to walk back through buildPromptInputs on every switch.
  private observerPrompt = "";
  private speakerPrompt = "";
  /** Full composed BoardManager prompt — debug/logging only. The live prompt is
   *  assembled per-invocation by composeBoardManagerPrompt from the parts below. */
  private boardManagerPrompt = "";
  /** Stable prefix+tail (always sent). */
  private boardManagerPromptBase = "";
  /** Appended only while the sentence builder is active. */
  private boardManagerBuilderBlock = "";
  /** Appended only while the Word Finder is active. */
  private boardManagerGuessingBlock = "";
  private observerToolConfigBase: ObserverToolConfig = {};
  private speakerToolConfigBase: Omit<SpeakerToolConfig, "restingMode"> = {
    useDirectAudio: true,
    isMutedMode: false,
    enabledApps: [],
  };
  private boardManagerToolConfig: BoardManagerToolConfig = {
    availableBoards: [],
    hasLoadedBoard: false,
  };

  // Symbol-generation settings (mirrors live-relay's pattern). Drives
  // whether unresolved generate:KEY symbols get queued for background
  // generation and which resolved (approved/unapproved) symbols the
  // renderer should prefer.
  private symbolSettings = {
    generateSymbols: false,
    useApprovedSymbols: false,
    useUnapprovedSymbols: false,
  };

  // Rolling session summary state. `conversationLog` is the canonical
  // record of conversational turns this session (user presses, transcripts
  // we replied to, our own utterances). It feeds Monitor's summarizer
  // every SUMMARY_EVERY_N_MESSAGES new entries. The resulting summary is
  // both injected as a [SESSION SUMMARY] context message AND folded into
  // the per-agent prompts on the next profile-switch reconnect.
  private conversationLog: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  private summarizedMsgCount = 0;
  private summaryInFlight = false;
  private currentSessionSummary: string | undefined;

  /**
   * @param ws            the live WebSocket
   * @param authedUser    authenticated user (from upgrade-time auth)
   * @param initialMessage optional `initialize` message already received by
   *                       a prior handler (e.g. LiveRelay handed off after
   *                       reading the student's three-agent flag). When
   *                       provided, processed after listener binding.
   */
  constructor(ws: WSWebSocket, authedUser: User, initialMessage?: ClientMessage) {
    this.ws = ws;
    this.authedUser = authedUser;
    this.userId = authedUser.id;

    ws.on("message", (raw) => this.handleRawMessage(raw));
    ws.on("close", (code, reason) => this.cleanup(`ws closed code=${code} reason=${reason?.toString() || ""}`));
    ws.on("error", (err) => {
      console.error("[AgentCoordinator] WS error:", err);
      this.cleanup("ws error");
    });
    ws.on("pong", () => { this.pongReceived = true; });
    this.startPingTimer();
    this.startIdleWatchdog();

    if (initialMessage) {
      // Re-deliver via the normal client-message dispatch path so we don't
      // duplicate handleInitialize logic. Errors propagate via sendError.
      this.handleClientMessage(initialMessage).catch(err => {
        console.error("[AgentCoordinator] initial message processing failed:", err);
        this.sendError(`init failed: ${(err as Error).message}`);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Public lifecycle
  // -------------------------------------------------------------------------

  cleanup(reason?: string): void {
    if (this.state === "closed") return;
    console.log(`[AgentCoordinator] cleanup: ${reason || "(no reason)"}`);
    this.state = "closing";

    // Clear timers
    this.stopPingTimer();
    this.stopIdleWatchdog();
    this.stopEnergyTimer();
    // Persist the final budget tail so the monthly cap carries across sessions.
    this.flushBudget();
    if (this.contextUpdateDebounceTimer) clearTimeout(this.contextUpdateDebounceTimer);
    if (this.monitorCallDedupTimer) clearTimeout(this.monitorCallDedupTimer);
    if (this.speakerAudioFlushTimer) clearTimeout(this.speakerAudioFlushTimer);
    if (this.pendingRestTimer) { clearTimeout(this.pendingRestTimer); this.pendingRestTimer = null; }
    if (this.deferredBoardMgrTimer) { clearTimeout(this.deferredBoardMgrTimer); this.deferredBoardMgrTimer = null; this.deferredBoardMgrTrigger = null; }
    if (this.peerPreviewTimer) { clearTimeout(this.peerPreviewTimer); this.peerPreviewTimer = null; }
    // Drop any lingering processing indicators + their backstop timers so
    // nothing sticks (the send is a no-op on a closed socket, but this also
    // cancels the timers).
    this.clearAllProcessing();
    this.clearStartupTimers();
    // Record any still-open repeat-press burst before the final Monitor pass
    // (runFinalMonitorPass below) so end-of-session perseveration isn't lost.
    this.flushRepeatBurst();
    // Cancel any in-flight student TTS so the synthesizeStream loop
    // exits promptly instead of pushing chunks at a dead WebSocket.
    if (this.studentTtsAbortController) {
      this.studentTtsAbortController.abort();
      this.studentTtsAbortController = null;
    }

    // Final Monitor flush — push a [SESSION_CLOSED] directive into
    // pendingMessages and force-trigger Monitor so it summarizes the
    // session and consolidates Student_Notes before we lose the
    // conversation. Fire-and-forget; the Monitor pipeline reads from
    // the DB so it doesn't depend on the Live agents staying open.
    // Mirrors legacy LiveRelay.handleSessionClose.
    // Keep the budget charge hook alive until the final pass finishes so the
    // session-summary HTTP charge is captured too, then unsubscribe. The
    // late charge persists via recordBudgetDrain → maybePersistBudget (the
    // debounce is bypassed once closing).
    this.runFinalMonitorPass()
      .catch(err => {
        console.error("[AgentCoordinator] Final monitor pass failed:", err);
      })
      .finally(() => {
        this.budgetChargeUnsub?.();
        this.budgetChargeUnsub = null;
      });

    // Leave any group conversation room so peers stop delivering to a dead
    // session (and get a "left" notice).
    if (this.conversationRoomId && this.conversationPersonId) {
      try { leaveConversationRoom(this.conversationRoomId, this.conversationPersonId); } catch {}
      this.conversationRoomId = null;
      this.conversationActive = false;
      this.conversationRoster.clear();
      this.floorActiveNote = "";
      this.currentFloor = null;
      this.addresseeFocus = null;
    }

    // Close agents
    try { this.observer?.close(); } catch {}
    try { this.speaker?.close(); } catch {}
    try { this.boardManager?.close?.(); } catch {}
    this.abortSttStreams();
    this.observer = null;
    this.speaker = null;
    this.boardManager = null;
    // If a social session was active, the peer Speaker was just closed
    // with the rest — drop the state without analysis (no one left to
    // debrief; the conversation is already in the Monitor's queue).
    this.socialPeer = null;

    // Drop from the live-session registry so a stale handle isn't reachable.
    if (this.studentId && this.liveHandle) {
      unregisterLiveSession(this.studentId, this.liveHandle);
      this.liveHandle = null;
    }

    // Close WS if still open
    try {
      if (this.ws.readyState === this.ws.OPEN) this.ws.close();
    } catch {}

    this.state = "closed";
  }

  /** Ask the AAC client to reload itself (clinician "reload AAC" action). */
  private requestReload(): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try { this.ws.send(JSON.stringify({ type: "reload" })); }
    catch (err) { console.error("[AgentCoordinator] reload send failed:", err); }
  }

  /**
   * On session close: queue a final directive and force-fire Monitor so
   * the session ends with a clean summary + deduped Student_Notes.
   * Mirrors legacy LiveRelay.handleSessionClose.
   *
   * Skipped when the session's privacy options disable notes — we don't
   * write any persistent observations in that mode.
   */
  private async runFinalMonitorPass(): Promise<void> {
    if (!this.sessionId) return;
    const cache = dualAgentService.getSessionCache(this.sessionId);
    if (cache?.state?.privacyOptions?.allowNotes === false) {
      flowNote("MONITOR", "Final pass skipped — allowNotes=false");
      return;
    }

    // Empty-session guard. A live session that gets recycled by the host's
    // idle timeout (or one a student opened but never used) has no
    // conversational turns AND no queued observations — running the Monitor
    // summary + generateSessionSummary on it just burns tokens to produce an
    // "(empty session)" record. Skip when nothing happened. We check
    // pendingMessages too because supervisor-only writes (recorded incidents,
    // private notes) land there WITHOUT a conversationLog entry and DO deserve
    // a final pass. The [SESSION_CLOSED] directive is added below, after this.
    const pendingCount = cache?.state?.pendingMessages?.length ?? 0;
    if (this.conversationLog.length === 0 && pendingCount === 0) {
      flowNote("MONITOR", "Final pass skipped — empty session (no turns, no pending observations).");
      return;
    }

    flowNote("MONITOR", "Session closed — queueing final directive and forcing Monitor.");
    await dualAgentService.addPendingMessage(this.sessionId, {
      role: "user",
      content: `[SESSION_CLOSED] The AAC session has ended. Perform these final tasks:
1. Summarize the session — note anything significant that happened.
2. Clean up Student_Notes: view the notes, then delete duplicate or redundant entries and consolidate related information where possible. The goal is a concise, non-repetitive set of notes.`,
      timestamp: Date.now(),
    });
    // AWAIT the drain to completion (awaitCompletion=true). Previously this
    // was fire-and-forget: triggerMonitor returned before doMonitorProcessing
    // moved pending_messages → log, so the summary below raced an empty log
    // and many sessions ended up with an empty log + a "(empty session)"
    // title (or no title at all when the host recycled before the detached
    // work finished). Awaiting guarantees the log is persisted first.
    await dualAgentService.triggerMonitor(this.sessionId, /* force */ true, undefined, /* awaitCompletion */ true);

    // Populate the generic session summary/title/importance used by
    // deep-analysis search. AWAITED and ordered AFTER the drain so it reads
    // the freshly-persisted log instead of racing it.
    const sessionId = this.sessionId;
    try {
      const { generateSessionSummary } = await import("../sessionSummary");
      await generateSessionSummary(sessionId);
    } catch (err) {
      console.warn("[AgentCoordinator] session summary generation failed:", (err as Error).message);
    }
  }

  /**
   * Periodic WebSocket-level ping so an idle live session keeps the hosting
   * proxy's connection warm (see PING_INTERVAL_MS). If a ping goes
   * unanswered for a full interval the socket is considered dead and
   * terminated — that fires cleanup, which (post empty-session guard) skips
   * the summary when nothing happened. Mirrors LiveRelay.startPingTimer.
   */
  private startPingTimer(): void {
    this.stopPingTimer();
    this.pongReceived = true;
    this.pingTimer = setInterval(() => {
      if (!this.pongReceived) {
        console.warn("[AgentCoordinator] WS failed health check (no pong) — terminating");
        this.ws.terminate();
        return;
      }
      this.pongReceived = false;
      try {
        this.ws.ping();
      } catch {
        // ws already closed
      }
    }, AgentCoordinator.PING_INTERVAL_MS);
  }

  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startIdleWatchdog(): void {
    this.stopIdleWatchdog();
    this.idleWatchdogTimer = setInterval(
      () => this.maybeIdleTransition(),
      AgentCoordinator.IDLE_WATCHDOG_INTERVAL_MS,
    );
  }

  private stopIdleWatchdog(): void {
    if (this.idleWatchdogTimer) {
      clearInterval(this.idleWatchdogTimer);
      this.idleWatchdogTimer = null;
    }
  }

  /**
   * Force the awake→resting→asleep transitions on elapsed idle time, so a
   * disengaged session stops billing a Live connection even when the Observer
   * never calls rest()/sleep() itself. "Idle" = time since the last real
   * engagement (noteEngagementActivity: a press, board change, or AI speech).
   * Ambient frames/audio don't reset it, so a quiet room sleeps even while the
   * camera keeps streaming. A mid-turn session always has recent activity (AI
   * speech stamps it), so this never cuts into an active response.
   */
  /** Multiplier applied to the idle rest/sleep thresholds for the MODERATE
   *  band (25–66%): sleep ~1.7x sooner (300s→180s) so a drawn-down session goes
   *  cold faster during quiet gaps. High = 1 (relaxed default). The LOW band
   *  (<25%) does NOT use this — it uses the budget-scaled sleep timer in
   *  maybeIdleTransition — so we clamp "low" to the moderate multiplier here.
   *  Returns 1 when the throttle is disabled (preserves legacy timing). */
  private idleThresholdScale(): number {
    if (!this.budgetThrottleEnabled) return 1;
    let band = bindingEnergy(this.budgetState, this.budgetWindows, Date.now()).band;
    // The LOW band uses the budget-scaled sleep timer (maybeIdleTransition), so
    // clamp it to the moderate multiplier here.
    if (band === "low") band = "moderate";
    // Always-conservative policy: never relax to the high-band (1x) idle timing —
    // treat a healthy budget as "moderate" so the session goes cold sooner during
    // quiet gaps regardless of how much budget is left.
    else if (band === "high" && this.observerPolicy.alwaysConservative) band = "moderate";
    return idleThresholdScaleForBand(band);
  }

  private maybeIdleTransition(): void {
    const now = Date.now();
    const idleMs = now - this.lastEngagementActivityAt;
    const band = this.budgetThrottleEnabled
      ? bindingEnergy(this.budgetState, this.budgetWindows, now).band
      : "high";

    // Low band (<25%): a budget-scaled SLEEP TIMER replaces the fixed
    // rest→sleep timing. Duration = clamp(budget% × 2, ≥ SPEAKER_SLEEP floor)
    // seconds — 50s at 25% down to ~20s at 10% and below. It's reset by real
    // engagement OR a worthwhile Observer transcript/observation
    // (lastObservationActivityAt), and on expiry the session goes STRAIGHT to
    // sleep (skipping resting). Sleep tears down the Live agents, keeps the
    // WS + board alive, and ignores ambient speech/frames — so a noisy room
    // can't keep re-waking it (only a deliberate press/tap does).
    if (band === "low") {
      if (this.state !== "ready" || this.paused || this.asleep
          || this.socialPeer || this.socialPeerTransition) return;
      const pct = bindingEnergy(this.budgetState, this.budgetWindows, now).percent;
      const sleepMs = Math.max(AgentCoordinator.BUDGET_SPEAKER_SLEEP_PERCENT, pct * 2) * 1000;
      const lastActivity = Math.max(this.lastEngagementActivityAt, this.lastObservationActivityAt);
      if (now - lastActivity >= sleepMs) {
        flowNote(
          "COORDINATOR",
          `Low-budget sleep timer (${Math.round(sleepMs / 1000)}s @ ${pct}%) expired — entering full sleep.`,
        );
        this.send({ type: "sleep_state_change", data: { state: "asleep", source: "system" } });
        this.enterSleep();
      }
      return;
    }

    // Moderate/high: the standard idle-watchdog (rest → sleep), moderate-scaled.
    // Sleeping tears down all Live agents; wake semantics are unchanged (any
    // directed speech / press rebuilds), so this never cuts into an active
    // exchange (engagement resets idleMs).
    const scale = this.idleThresholdScale();
    const decision = decideIdleTransition({
      idleMs,
      sessionProfile: this.sessionProfile,
      ready: this.state === "ready",
      paused: this.paused,
      asleep: this.asleep,
      inSocialSession: Boolean(this.socialPeer || this.socialPeerTransition),
      restAfterMs: Math.round(AgentCoordinator.IDLE_REST_MS * scale),
      sleepAfterMs: Math.round(AgentCoordinator.IDLE_SLEEP_MS * scale),
    });

    if (decision === "sleep") {
      flowNote(
        "COORDINATOR",
        `Idle watchdog: ${Math.round(idleMs / 1000)}s idle — entering full sleep (Live disconnect).`,
      );
      this.send({ type: "sleep_state_change", data: { state: "asleep", source: "system" } });
      this.enterSleep();
    } else if (decision === "rest") {
      flowNote(
        "COORDINATOR",
        `Idle watchdog: ${Math.round(idleMs / 1000)}s idle — dropping to resting.`,
      );
      void this.transitionToProfile("resting");
    }
  }

  // -------------------------------------------------------------------------
  // Raw WS message ingest
  // -------------------------------------------------------------------------

  private handleRawMessage(raw: unknown): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch (err) {
      console.warn("[AgentCoordinator] malformed WS message:", (err as Error).message);
      return;
    }
    // Wrap the message handler in a session-scoped context so every
    // flow-logger call (and any nested async work) gets its session_debug_logs
    // row attributed to this session. AsyncLocalStorage propagates through
    // awaits + EventEmitter listeners registered inside, so events from the
    // Observer/Speaker that arrive later inherit the context too.
    this.withSessionContext(() => {
      this.handleClientMessage(msg).catch(err => {
        console.error("[AgentCoordinator] handleClientMessage error:", err);
        this.sendError(`internal error: ${(err as Error).message}`);
      });
    });
  }

  /**
   * Run `fn` inside a session-scoped AsyncLocalStorage context, so the
   * shared flow-logger / live-session-logger know which session their
   * entries belong to. Sessions before initialize() ran (no sessionId
   * yet) bind with "?" so logs still get attributed somewhere stable.
   */
  private withSessionContext<T>(fn: () => T): T {
    return runInSessionContext(this.sessionId || "?", this.debugMode, fn);
  }

  private async handleClientMessage(msg: ClientMessage): Promise<void> {
    // High-signal client-message visibility — every non-streaming press /
    // navigation / state event gets surfaced in the flow log so "did the
    // press even reach the server?" can be answered by reading the log.
    // Excludes the high-volume streaming types (frame_grid, pcm_audio,
    // stt_stream_chunk) — those have their own periodic / summary counters
    // (e.g. the per-utterance "STT stream end: chunks=N" line) instead.
    if (msg.type !== "frame_grid" && msg.type !== "pcm_audio" && msg.type !== "stt_stream_chunk") {
      const summary = clientMsgSummary(msg);
      flowInput("CLIENT", msg.type, summary);
    }

    // Sleep recovery: a real user action while asleep must REBUILD the
    // torn-down Observer + Speaker before routing. Otherwise the action hits
    // a null Speaker (silent no-op) and the AI never talks again until a
    // re-initialize — see wakeFromSleep(). Ambient streaming (frames/audio)
    // and control messages don't wake; only deliberate user input does.
    if (this.asleep && AgentCoordinator.SLEEP_WAKING_MSG_TYPES.has(msg.type)) {
      flowNote("COORDINATOR", `User action "${msg.type}" arrived while asleep — rebuilding agents before routing.`);
      await this.wakeFromSleep();
    }

    // The user pressed something before the startup greeting fired — they
    // started the interaction themselves, so cancel the auto-greeting.
    if (this.startupPending && AgentCoordinator.STARTUP_CANCELING_MSG_TYPES.has(msg.type)) {
      this.cancelStartupGreeting(`user input "${msg.type}"`);
    }

    switch (msg.type) {
      case "initialize":
        await this.handleInitialize(msg);
        return;
      case "frame_grid":
        if (this.paused) return;
        // triggerReason carries the escalation reason (Phase 2: new_face,
        // left_frame, safety, …); gestureContext is the client's serialized
        // face/hand summary (previously dropped on this path).
        await this.forwardFrameToObserver(msg.data, msg.triggerReason, msg.gestureContext, msg.motionSignature);
        return;
      case "pcm_audio":
        if (this.paused) return;
        // Cost saving (Phase 1): while audio attention is "text" the client sends
        // VAD speech CLIPS (speech_audio → server Google STT) and suppresses
        // continuous PCM, so none should arrive — drop any that does, else it
        // re-bills as audio in the Gemini context. When the Observer raises audio
        // attention to "live" (set_audio_attention), the client streams raw
        // (silence-cut) PCM and we forward it to the Observer model.
        if (this.audioAttention === "text") return;
        this.observer?.sendAudio(msg.data, "audio/pcm;rate=16000");
        this.lastAudioInputAt = Date.now();
        this.pcmCount += 1;
        if (this.pcmCount === 1 || this.pcmCount % 500 === 0) {
          runInSessionContext(this.sessionId || "?", this.debugMode, () => {
            logLiveSession("CLIENT → pcm_audio", `count=${this.pcmCount}`);
          });
        }
        return;
      case "focus_frame":
        // High-resolution single frame requested by Observer via
        // request_focus. The prompt mirrors legacy's wording.
        this.observer?.sendFrame(
          msg.data,
          "[FOCUS FRAME] This is a HIGH-RESOLUTION single frame captured at your request. Analyze it carefully for fine details, text, labels, faces, or objects you couldn't identify before. Record what you see via update_context.",
        );
        this.lastRealFrameAt = Date.now();
        return;
      case "set_paused":
        this.paused = msg.paused;
        runInSessionContext(this.sessionId || "?", this.debugMode, () => {
          logLiveSession("CLIENT → set_paused", `paused=${msg.paused}`);
        });
        return;
      case "mic_state": {
        // Diagnostics only. Record mic activate/deactivate in the session log via
        // the supervisor channel: it reaches the DB history + Monitor's batch
        // queue but NOT the live agents' conversationLog — so it is never injected
        // as a live turn and can't trigger an immediate spoken reaction like
        // "I can hear you now". Purely to help identify mic problems after the fact.
        const micContent = `[MIC ${msg.active ? "ACTIVATED" : "DEACTIVATED"}]${msg.reason ? ` — ${msg.reason}` : ""}`;
        this.writeSupervisorOnly(micContent);
        return;
      }
      case "speech_method": {
        // Diagnostics only (same channel as mic_state). Records which speech-
        // boundary detector the client is running — a session where the Silero
        // VAD failed to load (and boundaries fell back to energy thresholds,
        // which merge statements in a noisy room) is otherwise invisible
        // outside the browser console.
        flowNote("COORDINATOR", `Client speech method → ${msg.method}`);
        this.writeSupervisorOnly(`[SPEECH METHOD] ${msg.method}`);
        return;
      }
      case "gps_update":
        // Periodic device-location refresh. Update the Monitor's reading and,
        // if the matched place/event changed, inject fresh location context.
        await this.handleGpsUpdate(msg.gps);
        return;
      case "unknown_face_descriptors":
        // Server-side biometric matching, scoped to this student's known
        // people. Fire-and-forget, but keep the promise so the first-frame
        // startup path can await it briefly.
        if (!this.studentId) return;
        this.faceRecognitionInFlight = this.recognizeFaces(msg.data).catch(err => {
          runInSessionContext(this.sessionId || "?", this.debugMode, () => {
            logLiveSession("FACE_RECOGNITION_ERROR", (err as Error).message);
          });
        });
        return;
      case "voice_descriptors":
        // Server-side speaker matching, scoped to this student's known people.
        // Fire-and-forget (no startup await — voice arrives mid-session, not at
        // the first frame the way faces do).
        if (!this.studentId) return;
        // Tagged with a clipId → it's the parallel voice for a speech clip; feed
        // the sync registry so attribution waits for it.
        if (msg.clipId && msg.data[0]) this.recordVoiceForClip(msg.clipId, msg.data[0]);
        this.recognizeVoices(msg.data).catch(err => {
          runInSessionContext(this.sessionId || "?", this.debugMode, () => {
            logLiveSession("VOICE_RECOGNITION_ERROR", (err as Error).message);
          });
        });
        return;
      case "speech_text":
        // Cost saving (Phase 1, Whisper path — plumbing kept): on-device
        // transcript. Only honored when STT is active for this session.
        if (!this.capable("clientStt")) return;
        this.handleSpeechText(msg);
        return;
      case "speech_audio":
        // Cost saving (Phase 1, ACTIVE path): VAD speech clip → server-side
        // Google STT → [HEARD SPEECH]. Only honored when STT is active.
        if (!this.capable("clientStt")) return;
        if (this.paused) return;
        void this.handleSpeechAudio(msg);
        return;
      case "stt_stream_start":
        // Streaming STT (Web-Speech-like): open a Cloud STT streamingRecognize
        // session for this utterance. Audio arrives as stt_stream_chunk.
        if (!this.capable("clientStt") || this.paused) return;
        this.startSttStream(msg.streamId, msg.language);
        return;
      case "stt_stream_chunk":
        this.sttStreamWrite(msg.streamId, msg.data);
        return;
      case "stt_stream_end":
        void this.endSttStream(msg.streamId, msg.acoustic, msg.lipActivity);
        return;
      case "scene_state":
        // Cost saving (Phase 2): compact text scene description in place of a
        // frame while the scene is stable. Inject as ambient [SCENE] context
        // (non-turn) so the Observer stays aware without burning a turn —
        // escalation frames are what drive its turns.
        if (!this.capable("sceneState")) return;
        if (this.paused) return;
        this.observer?.sendContextInjection(`[SCENE] ${this.renderScene(msg.scene)}`);
        return;
      case "correct_identity":
        // A recent face/voice match was wrong — penalize the embedding(s) that
        // mis-fired so the same confusion stops recurring.
        if (!this.studentId) return;
        this.correctMisidentification(msg.entityType, msg.entityId, msg.reason).catch(err => {
          runInSessionContext(this.sessionId || "?", this.debugMode, () => {
            logLiveSession("IDENTITY_CORRECTION_ERROR", (err as Error).message);
          });
        });
        return;
      case "audio_clip":
        // Phase 1b: a backlog clip the Observer asked for (request_audio). Only
        // honor it if it matches the pending pull — otherwise it's a legacy /
        // unsolicited clip and we ignore it (the audio path is text via STT).
        if (msg.clipId && msg.clipId === this.pendingAudioPullClipId) {
          this.pendingAudioPullClipId = null;
          this.observer?.sendAudioClipTurn(
            msg.data,
            msg.mimeType || "audio/wav",
            `[REQUESTED AUDIO] You asked to hear this — it's the clip behind the recent [HEARD SPEECH]. Listen, then re-attribute / re-judge and route via transcript() if it's directed speech.`,
          );
        }
        return;
      case "voice_audio":
        // Legacy non-PCM path — ignore in live mode.
        return;
      case "button_press":
        await this.handleButtonPress(msg);
        return;
      case "board_exit":
        this.handleBoardExit(msg);
        return;
      case "glyph_press":
        // The client sends `glyph_press` when the user presses Play in
        // the sentence builder — the glyph IS the composed sentence,
        // ready for BoardManager to interpret() into natural language.
        // This must emit a `sentence_composed` event (not button_pressed):
        // the interpret-intent gate in routeInterpretIntent requires
        // lastUserInputType === "sentence_composed", and a button_pressed
        // event would cause every interpret() call from BoardManager to
        // be rejected as "spurious."
        //
        // Split the glyph string on '+' to recover the individual GLYPHs;
        // the field is informational (sentence is the canonical payload).
        // Light the "interpreting" indicator so the SENTENCE BUILDER's Play
        // button shows it's working until the interpreted sentence is voiced
        // (cleared in routeInterpretIntent, or by the backstop timer).
        this.markInterpretBusy();
        this.emitClientEvent({
          type: "sentence_composed",
          source: "client",
          timestamp: Date.now(),
          glyphs: msg.glyph.split("+").map(s => s.trim()).filter(Boolean),
          sentence: msg.glyph,
        });
        return;
      case "construction_state":
        this.handleConstructionState(msg.data);
        return;
      case "guessing_state":
        // LEGACY client-owned-state path. Older client builds still send
        // this; new clients use the intent messages below. The legacy
        // path is preserved temporarily — once all clients have shipped
        // with the intent protocol it can be removed entirely. For now,
        // map it into the engine by overwriting the snapshot only (no
        // engine-state hydration — the legacy state is opaque to us).
        flowNote("COORDINATOR", "Received legacy guessing_state — treating snapshot as authoritative; new client builds should send intents instead.");
        this.handleLegacyGuessingState(msg);
        return;
      case "guessing_enter":
        this.handleGuessingEnter(msg);
        return;
      case "guessing_press":
        this.handleGuessingPress(msg);
        return;
      case "guessing_reject":
        this.handleGuessingReject();
        return;
      case "guessing_narrow":
        this.handleGuessingNarrow(msg);
        return;
      case "exit_guessing":
        // Single client-initiated exit path for the Word Finder. Replaces
        // the older [EXIT GUESSING]-tagged board_exit kludge (which also
        // emitted a spurious "Back" button_pressed event downstream).
        this.clearGuessingState(`client_exit:${msg.reason || "user_request"}`);
        return;
      case "builder_open":
        this.builderState = null; // cleared until first construction_state arrives
        this.emitClientEvent({
          type: "builder_opened",
          source: "client",
          timestamp: Date.now(),
        });
        return;
      case "builder_close":
        this.builderState = null;
        // Closing the builder also ends any in-progress word finder.
        this.clearGuessingState("builder_close");
        this.emitClientEvent({
          type: "builder_closed",
          source: "client",
          timestamp: Date.now(),
        });
        return;
      case "set_mute_state":
        this.handleMuteToggled(msg.muteState);
        return;
      case "user_message": {
        // Treat as a transcribed user statement directed at the device. This is
        // also the channel embedded games use to narrate events ("[GAME] Goal
        // done…", etc.). A game message is real engagement: note it so the rest
        // timer doesn't expire mid-activity, and wake from the resting profile
        // before routing. Without the wake, resting has already torn down the
        // Speaker, so `this.speaker?` short-circuits and the message is silently
        // dropped — the AI never responds and the text is left stranded in the
        // client UI. (The fully-asleep case is already covered by the
        // SLEEP_WAKING_MSG_TYPES wake-gate at the top of this method.)
        this.noteEngagementActivity();
        const directive = `[TRANSCRIPT] user → device: "${msg.text}"`;
        if (this.sessionProfile === "resting") {
          flowNote("COORDINATOR", "user_message arrived while resting — waking before routing.");
          void this.transitionToProfile("awake").then(() => this.speakerRespond(directive));
          return;
        }
        this.speakerRespond(directive);
        return;
      }
      case "call_active":
        // A live video call started/ended on the client. Step the AI back into
        // facilitator mode (quiet, supporting the human-to-human conversation)
        // while the call is up, and restore the prior mode when it ends.
        this.setCallMode(msg.active);
        // When a call ends without having connected, let the Speaker know the
        // outcome so it can react (acknowledge, suggest trying later, etc.).
        if (!msg.active && msg.outcome && msg.outcome !== "ended" && msg.outcome !== "connected") {
          this.speaker?.sendContextInjection(describeCallOutcome(msg.outcome));
        }
        return;
      case "conversation_room":
        // The client entered/left a group AAC chat (shape C). Join/leave the
        // shared conversation room so peer utterances flow both ways.
        void this.setConversationRoom(msg.roomId);
        return;
      case "conversation_focus":
        // The student tapped/dwelt on a peer's face (or cleared it). Focus that
        // peer as the addressee + tell the BoardManager to build phrases for them.
        this.handleConversationFocus(msg.personId);
        return;
      case "app_dismissed":
        // User closed the active app surface. For a social-training
        // session this is the user-initiated exit (cave click / back);
        // end the session and restore the companion Speaker. Other apps
        // just get a context note so Speaker knows the surface is gone.
        if (this.socialPeer && msg.appId === "social_trainer") {
          void this.endSocialPeerSession("user_exit");
          return;
        }
        this.speaker?.sendContextInjection(`[APP DISMISSED BY USER] ${msg.appId}`);
        this.observer?.sendContextInjection(`[APP DISMISSED BY USER] ${msg.appId}`);
        return;
      case "request_app_open":
        // Student pressed an app that declares startup parameters. The client
        // can't open it instantly (params shape the initial state), so it asks
        // the server to resolve them first. We reuse the SAME routeAppOpen path
        // as the AI's open_app — the only difference is source: "student".
        void this.handleStudentAppOpen(msg.appId, msg.appData);
        return;
      case "social_peer_reconfigure":
        // DEBUG-only: restart the active social peer with custom parameters
        // from the client debug dialog. Self-guards on debugMode + active session.
        void this.applyPeerReconfigure(msg.params);
        return;
      case "debug_set_budget":
        // DEBUG-only: slam the in-memory budget to a target % for testing the
        // throttle ladder without editing the DB. Self-guards on debugMode.
        this.debugSetBudgetPercent(msg.percent);
        return;
      case "social_trainer_started":
        // Client-initiated launch (apps surface / debug helper). The
        // AI-initiated path arrives via routeAppOpen("social_trainer").
        // startSocialPeerSession self-guards against double starts.
        void this.startSocialPeerSession("client_launch");
        return;
      default:
        // Many client message types (focus_frame, page_navigate, etc.) are
        // handled by the legacy path but aren't part of the MVP routing
        // here. Silently ignore so we don't crash on protocol-superset
        // messages.
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Periodic device-location refresh from the client. Updates the Monitor's
   * stored GPS reading; if the matched place/event has meaningfully changed
   * since the last report, broadcasts fresh location context to the live
   * agents. Satisfies the "re-check during monitor checks" requirement
   * (movement over time / GPS precision improvement).
   */
  private async handleGpsUpdate(gps: import("@shared/location-matching").GpsReading): Promise<void> {
    if (!this.sessionId || !gps) return;
    const monitor = dualAgentService.getSessionCache(this.sessionId)?.monitorAgent;
    if (!monitor?.setGps) return;
    monitor.setGps(gps);
    try {
      const update = await monitor.checkLocationContext?.();
      if (update) {
        this.broadcastMonitorContext(update);
        runInSessionContext(this.sessionId, this.debugMode, () => {
          logLiveSession("LOCATION_UPDATE", update);
        });
      }
    } catch (err) {
      console.warn("[AgentCoordinator] handleGpsUpdate failed:", err);
    }
  }

  private async handleInitialize(msg: Extract<ClientMessage, { type: "initialize" }>): Promise<void> {
    if (this.state !== "initializing") {
      this.sendError("already initialized");
      return;
    }

    // 1. Load / create session via the shared service. This populates the
    //    in-memory SessionCache the dual-agent-service already manages and
    //    gives us the per-agent prompts already built (the service can
    //    branch on useThreeAgentSystem in Task #9 and populate observerPrompt
    //    / speakerPrompt / boardManagerPrompt directly).
    //
    //    Startup-progress subtitles: the client shows "connecting" by default
    //    until our first progress message. We emit one before each slow phase
    //    so the waking-up indicator reflects what's actually taking time.
    //    "checkingNotes" covers loading the student record + memory; the
    //    "planningSession" stage is emitted from inside the Monitor right
    //    before its (slow) thorough-startup enhancer LLM call.
    this.send({ type: "startup_progress", stage: "checkingNotes" });
    const state = await dualAgentService.initializeSession(
      msg.studentId,
      this.authedUser.id,
      msg.sessionId,
      msg.muteState ?? "unmuted",
      undefined,
      msg.timezone,
      msg.classroomId,
      msg.gps,
      (stage) => this.send({ type: "startup_progress", stage }),
    );
    this.sessionId = state.sessionId;
    this.studentId = state.studentId;
    this.userId = state.userId;
    // Register so a clinician action (e.g. AAC reload) can reach this session.
    if (this.studentId) {
      if (this.liveHandle) unregisterLiveSession(this.studentId, this.liveHandle);
      this.liveHandle = { requestReload: () => this.requestReload() };
      registerLiveSession(this.studentId, this.liveHandle);
    }
    this.classroomId = state.classroomId ?? null;
    this.muteState = state.muteState;
    this.debugMode = !!msg.debugMode;
    // Record what offloading this client can do. Capabilities only take effect
    // when fullAttentionMode is OFF (resolved below from aacSettings) and the
    // matching per-phase env flag is set — see `capable()`.
    this.clientCapabilities = msg.capabilities ?? {};

    // Startup behavior is decided from context (no clinician toggle):
    // shared / classroom devices get MENU (board-first, AI waits); a personal
    // device gets CONTEXTUAL (the AI may greet a recognized student on the
    // first frame). Consumed once in flushContextUpdates / the fallback timer.
    this.startupBehavior = resolveStartupMode({ classroomId: this.classroomId });

    // Wire context-injection broadcast: when Monitor produces context,
    // route through our broadcast helper so all three agents see it.
    state.onContextInjection = (text) => this.broadcastMonitorContext(text);

    // Tear-down hook: dualAgentService uses this to terminate sessions
    // mid-flight (e.g. consent revoked).
    state.onTerminate = (reason) => this.cleanup(`onTerminate: ${reason}`);

    // 2. Resolve voices (used by fallback Speaker path and student-interpret
    //    path) and fetch the aac_chat LLM config. They're independent — run
    //    them concurrently rather than back-to-back.
    const [, aacChat] = await Promise.all([
      this.resolveVoices(),
      settingsRepository.getLLMConfig("aac_chat"),
    ]);

    // 3. Determine models. Default both Observer and Speaker to the
    //    `aac_chat` Live model; Board Manager uses the hardcoded fast model.
    //    Per-agent env-var overrides let us experiment with different Live
    //    variants without touching settings — e.g. point Observer at a
    //    half-cascade Live model with stronger function-calling reliability
    //    if the GA native-audio model keeps malforming its tool calls.
    this.observerModel = process.env.AAC_OBSERVER_MODEL || aacChat.model;
    // Economy-Observer backend runs a cheap text model (no native-audio
    // premium); it only emits tool calls, never audio. Defaults to the Board
    // Manager's fast model; override via AAC_OBSERVER_HTTP_MODEL.
    this.observerHttpModel = process.env.AAC_OBSERVER_HTTP_MODEL || BOARD_MANAGER_DEFAULT_MODEL;
    this.speakerModel = process.env.AAC_SPEAKER_MODEL || aacChat.model;
    this.useVertex = aacChat.provider === "gemini";
    this.aacChatProvider = aacChat.provider;
    // HTTP path needs a text-completion-capable model — the configured
    // `aac_chat` model is typically a Live variant (native-audio) which
    // 404s on generateContent. Default to the same text model the Board
    // Manager uses; override via AAC_SPEAKER_HTTP_MODEL when tuning.
    const httpSpeakerModel = process.env.AAC_SPEAKER_HTTP_MODEL || BOARD_MANAGER_DEFAULT_MODEL;
    // Speaker backend selection.
    //  - Per-student `liveAudioSpeaker` AAC setting (default true →
    //    "live"); only an explicit false → "http". A missing field
    //    follows the new default (live).
    //  - AAC_SPEAKER_MODE env var (if explicitly set to "http" or "live")
    //    OVERRIDES the per-student setting for the whole deployment —
    //    useful for global dev/debug toggling without touching student
    //    rows. Any other value falls back to the per-student setting
    //    with a warning.
    const studentRowForMode = dualAgentService.getSessionCache(this.sessionId!)?.monitorAgent.getStudent?.();
    const liveAudioStudent = (studentRowForMode?.aacSettings as any)?.liveAudioSpeaker !== false;
    const envOverrideRaw = process.env.AAC_SPEAKER_MODE?.toLowerCase();
    let effectiveSpeakerMode: "http" | "live" = liveAudioStudent ? "live" : "http";
    if (envOverrideRaw === "http" || envOverrideRaw === "live") {
      effectiveSpeakerMode = envOverrideRaw;
    } else if (envOverrideRaw) {
      console.warn(`[AgentCoordinator] Unknown AAC_SPEAKER_MODE="${envOverrideRaw}" — ignoring; using per-student setting`);
    }
    this.speakerMode = effectiveSpeakerMode;
    // Swap the Speaker model when we're on the HTTP path — the configured
    // aac_chat model is a Live variant that generateContent will 404 on.
    if (this.speakerMode === "http") {
      this.speakerModel = httpSpeakerModel;
    }
    // useDirectAudio drives runtime audio-chunk routing for the Live
    // path (native-audio model emits PCM via onAudioChunk). In HTTP mode
    // there is no live audio stream — text → server TTS → avatar_audio.
    this.useDirectAudio = this.speakerMode === "live"
      && (this.speakerModel.includes("native-audio") || this.speakerModel.includes("live"));
    this.aiVoiceName = this.aiVoice?.geminiVoiceName;
    if (this.observerModel !== aacChat.model || this.speakerModel !== aacChat.model) {
      console.log(`[AgentCoordinator] Per-agent model override: observer=${this.observerModel} speaker=${this.speakerModel}`);
    }

    // Resolve the budget tier + Observer economy policy BEFORE building prompts,
    // so the Observer's tool surface + <energy> block reflect the policy (e.g. a
    // Demo session omits the set_observation_mode tool + its lines and starts on
    // the cheap backend). The tier supplies DEFAULTS; explicit per-student
    // aac_settings fields override — the constraints are a policy layer, not the
    // budget number itself. (budgetWindows/state load later with startupBudgetPct.)
    const aacSettingsForPolicy = studentRowForMode?.aacSettings as any;
    this.budgetTier = tierByKey(aacSettingsForPolicy?.budgetTier);
    this.observerPolicy = resolveObserverPolicy(this.budgetTier, {
      observerBackend: aacSettingsForPolicy?.observerBackend,
      observerAllowLive: aacSettingsForPolicy?.observerAllowLive,
      observerAlwaysConservative: aacSettingsForPolicy?.observerAlwaysConservative,
    });

    // Ensure the home board is in availableBoards BEFORE building prompts, so
    // Board Manager always sees it in <prebuilt_boards> and set_board("home")
    // works. Initialize the array if absent (the DB-load path can leave it
    // undefined) — the old guard `if (state.availableBoards && …)` silently
    // skipped the add in that case, and it ran AFTER the prompt was built.
    if (!state.availableBoards) state.availableBoards = [];
    if (!state.availableBoards.some(b => b.key === HOME_BOARD_KEY)) {
      state.availableBoards.unshift({ key: HOME_BOARD_KEY, name: "Home", id: "__home__" } as any);
    }
    runInSessionContext(this.sessionId, this.debugMode, () => {
      logLiveSession("AVAILABLE_BOARDS", `at prompt-build: ${state.availableBoards!.length} board(s) — [${state.availableBoards!.map(b => b.key).join(", ")}]`);
    });

    // 4. Build the three prompts. Loading contacts / symbols / boards / apps +
    //    license checks is the next noticeable wait → "loadingApps" subtitle.
    this.send({ type: "startup_progress", stage: "loadingApps" });
    const promptInputs = await this.buildPromptInputs();
    const observerPrompt = buildObserverPrompt(promptInputs.observer);
    const speakerPrompt = buildSpeakerPrompt(promptInputs.speaker);
    const boardManagerParts = buildBoardManagerPrompt(promptInputs.boardManager);
    // The mode blocks (builder / guessing) are appended per-invocation only when
    // that mode is active — see composeBoardManagerPrompt. Store the parts;
    // `boardManagerPrompt` keeps the full composed string for debug/logging.
    this.boardManagerPromptBase = boardManagerParts.base;
    this.boardManagerBuilderBlock = boardManagerParts.builderBlock;
    this.boardManagerGuessingBlock = boardManagerParts.guessingBlock;
    const boardManagerPrompt = `${boardManagerParts.base}\n\n${boardManagerParts.builderBlock}\n\n${boardManagerParts.guessingBlock}`;

    state.observerPrompt = observerPrompt;
    state.speakerPrompt = speakerPrompt;
    state.boardManagerPrompt = boardManagerPrompt;
    this.observerPrompt = observerPrompt;
    this.speakerPrompt = speakerPrompt;
    this.boardManagerPrompt = boardManagerPrompt;

    // Cache symbol settings so the post-rebuild generation pass can apply
    // the right policy (generate? prefer approved/unapproved?).
    const sessionCache = dualAgentService.getSessionCache(this.sessionId!);
    const studentRow = sessionCache?.monitorAgent.getStudent?.();
    const studentRowAac = studentRow?.aacSettings;
    // Load the cost gate + the single budget signal BEFORE building the agents,
    // so STARTUP honors the current band (not just wake): <25% comes up on the
    // economy Observer + short-memory + tired Speaker, and <10% board-only (no
    // Speaker, no greeting). ≤0% all-stop is enforced on the first sleep→wake.
    this.fullAttentionMode = !!((studentRowAac as any)?.fullAttentionMode);
    // budgetTier + observerPolicy were resolved earlier (before prompt build).
    this.budgetWindows = windowsForTier(this.budgetTier);
    {
      const persistedBudget = (studentRow as any)?.budgetMeters as BudgetState | undefined;
      this.budgetState = persistedBudget && Object.keys(persistedBudget).length
        ? persistedBudget
        : initBudget(this.budgetWindows, Date.now());
    }
    const startupBudgetPct = this.budgetThrottleEnabled
      ? bindingEnergy(this.budgetState, this.budgetWindows, Date.now()).percent
      : 100;
    const startupBoardOnly = startupBudgetPct < AgentCoordinator.BUDGET_SPEAKER_SLEEP_PERCENT;
    this.symbolSettings = {
      generateSymbols: !!studentRowAac?.generateSymbols,
      useApprovedSymbols: !!studentRowAac?.useApprovedSymbols,
      useUnapprovedSymbols: !!studentRowAac?.useUnapprovedSymbols,
    };

    // 5. Build tool configs. Cache the bases so profile transitions can
    //    re-derive them with restingMode flipped.
    const observerToolConfig: ObserverToolConfig = {
      definedGestures: this.definedGestures.length > 0 ? this.definedGestures : undefined,
      // Expose set_observation_mode only when the cost-saving system is enabled
      // AND the policy permits Live — a Live-forbidden (e.g. Demo) session drops
      // the tool entirely so the Observer can't switch off the economy backend.
      economyModeEnabled: this.observerModeSwitchable,
    };
    this.observerToolConfigBase = observerToolConfig;
    // Speaker's tool config wants full AACAppDefinition objects (with
    // icon / enabledByDefault). The prompt config only carries the
    // narrowed name/description/id shape, so we walk back to the registry
    // to populate the full ones.
    const enabledAppIds = (promptInputs.speaker.enabledApps ?? []).map(a => a.id);
    const speakerToolConfigBase = {
      useDirectAudio: this.useDirectAudio,
      isMutedMode: this.muteState === "muted",
      enabledApps: APP_REGISTRY.filter(a => enabledAppIds.includes(a.id)),
      availableCustomApps: promptInputs.speaker.availableCustomApps,
      permittedWebsites: promptInputs.speaker.permittedWebsites,
    };
    this.speakerToolConfigBase = speakerToolConfigBase;
    const speakerToolConfig: SpeakerToolConfig = { ...speakerToolConfigBase };
    const bmToolConfig: BoardManagerToolConfig = {
      availableBoards: (promptInputs.boardManager.availableBoards ?? []).map(b => ({ key: b.key, name: b.name })),
      hasLoadedBoard: !!promptInputs.boardManager.loadedBoardName,
      loadedBoardKey: promptInputs.boardManager.loadedBoardKey ?? null,
      loadedBoardName: promptInputs.boardManager.loadedBoardName ?? null,
      maxBoardItems: 12,
      language: promptInputs.boardManager.language,
      studentGender: promptInputs.boardManager.studentGender,
      singleGlyphButtons: promptInputs.boardManager.singleGlyphButtons,
      glyphInputTranslation: promptInputs.boardManager.glyphInputTranslation,
      permittedWebsites: promptInputs.boardManager.permittedWebsites,
      enabledApps: [
        ...(promptInputs.boardManager.enabledApps ?? []).map(a => ({ id: a.id, name: a.name })),
        ...(promptInputs.boardManager.availableCustomApps ?? []).map(a => ({ id: a.id, name: a.name })),
      ],
    };
    this.boardManagerToolConfig = bmToolConfig;
    // Mirror the launch allowlists so resolveButtonOpen can re-gate
    // BoardManager-authored open.* buttons server-side.
    this.permittedWebsites = promptInputs.boardManager.permittedWebsites ?? [];
    this.launchableAppIds = new Set((bmToolConfig.enabledApps ?? []).map(a => a.id));

    // 6. Construct agent handles.
    // Startup backend = the economy policy (default backend + allowLive pin) with
    // the low-band floor on top (mirrors doWakeFromSleep): <25% → economy Observer
    // + short-memory (+ tired Speaker, applied post-ready); <10% → board-only, no
    // native-audio Speaker + no greeting. observerAwakeCompression/speakerCompression
    // pick up short-memory automatically via lowBandActive().
    {
      const backend = this.initialObserverBackend(startupBudgetPct);
      this.observerMode = backend.mode;
      this.observerForcedEconomy = backend.forced;
    }
    this.observer = this.createObserverAgent();
    this.speaker = startupBoardOnly ? null : this.createSpeakerAgent();
    if (startupBoardOnly) {
      flowNote("COORDINATOR", `Startup at ${startupBudgetPct}% (<10%) — board-only: economy Observer, no Speaker, no greeting.`);
    }
    // Board Manager backend selection (mirrors the Speaker live/http pattern):
    //  - Per-student `boardManagerLiveModel` AAC setting (default false → HTTP).
    //  - AAC_BOARD_MANAGER_MODE env var ("http"|"live") OVERRIDES the per-student
    //    setting deployment-wide for dev/debug. Any other value is ignored.
    const liveBoardMgrStudent = !!(studentRowAac as any)?.boardManagerLiveModel;
    const bmEnvOverrideRaw = process.env.AAC_BOARD_MANAGER_MODE?.toLowerCase();
    let boardMgrMode: "http" | "live" = liveBoardMgrStudent ? "live" : "http";
    if (bmEnvOverrideRaw === "http" || bmEnvOverrideRaw === "live") {
      boardMgrMode = bmEnvOverrideRaw;
    } else if (bmEnvOverrideRaw) {
      console.warn(`[AgentCoordinator] Unknown AAC_BOARD_MANAGER_MODE="${bmEnvOverrideRaw}" — ignoring; using per-student setting`);
    }
    this.boardManager = this.createBoardManager(boardMgrMode);
    // Open the Live session ahead of the first invoke so the first board
    // build doesn't pay connect latency (no-op on the HTTP path).
    this.boardManager.prewarm?.(this.boardManagerPromptBase, this.boardManagerToolConfig);

    // 7. Connect Observer + Speaker in parallel. If either fails, tear down.
    //    This is the final pre-ready wait (Live WS handshakes) → "wakingUp".
    this.send({ type: "startup_progress", stage: "wakingUp" });
    try {
      const agentStarts: Promise<void>[] = [];
      if (this.observer) {
        agentStarts.push(this.observer.start({
          systemPrompt: observerPrompt,
          model: this.observerActiveModel(),
          toolConfig: observerToolConfig,
          // Match the single-agent's provider config — same voice, same
          // compression thresholds. Observer doesn't emit audio to the
          // client (no audio sink), but the native-audio model expects
          // a voice configured in AUDIO modality.
          useVertex: this.useVertex,
          voiceName: this.aiVoiceName,
          compressionTriggerTokens: this.observerAwakeCompression().trigger,
          compressionTargetTokens: this.observerAwakeCompression().target,
        }));
      }
      if (this.speaker) {
        agentStarts.push(this.speaker.start({
          systemPrompt: speakerPrompt,
          model: this.speakerModel,
          toolConfig: speakerToolConfig,
          useVertex: this.useVertex,
          voiceName: this.aiVoiceName,
          useDirectAudio: this.useDirectAudio,
          compressionTriggerTokens: this.speakerCompression().trigger,
          compressionTargetTokens: this.speakerCompression().target,
        }));
      }
      await Promise.all(agentStarts);
    } catch (err) {
      const detail = (err as Error).message || String(err);
      console.error("[AgentCoordinator] agent connect failed:", err);
      // Distinguish a fatal auth/permission/config rejection (the live AI
      // backend refused us — e.g. Vertex HTTP 403) from a transient network
      // failure or connect timeout, so the client can show the right message
      // instead of sitting on "waking up" forever. Detail stays in the logs.
      const isAuthOrConfig = /\b40[13]\b|forbidden|permission|unauthor|auth\/permission|config error/i.test(detail);
      this.sendError(isAuthOrConfig ? "error:LIVE_CONNECT_FAILED" : "error:CONNECTION_ERROR");
      this.cleanup("agent connect failed");
      return;
    }

    // 7a. Bind debug logging context on the Live agents so provider-side
    //     events (RAW_MSG, SERVER → toolCall, etc.) get attributed to
    //     this session_debug_logs row.
    this.observer?.setDebugSessionContext(this.sessionId, this.debugMode);
    this.speaker?.setDebugSessionContext(this.sessionId, this.debugMode);
    // Live Board Manager attributes its provider-side logs too (no-op on HTTP).
    this.boardManager?.setDebugSessionContext?.(this.sessionId, this.debugMode, "BOARD_MGR");

    // 7c. Prime Speaker with the initial interaction mode. Without this,
    //     Speaker has no signal about which mode it's in until Observer
    //     fires set_interaction_mode mid-session — and the
    //     transitionToProfile re-broadcast only fires on wake, not at
    //     fresh start. Default mode is `companion`; the injection here
    //     keeps Speaker aligned from turn one.
    flowNote("COORDINATOR", `Initial mode = ${this.currentInteractionMode}`);
    const initialModeRendered = `[MODE] ${this.currentInteractionMode} (session start)`;
    this.speaker?.sendContextInjection(initialModeRendered);
    this.observer?.sendContextInjection(initialModeRendered);
    // Seed the Observer with the CURRENT budget level (carried over from prior
    // sessions) — the system prompt only carries drain RATES, not levels, so a
    // session that resumes already low would otherwise start blind.
    this.primeFreshObserver();

    // Tell the Speaker who it can video-call (callable contacts + online flags).
    if (this.speaker) void this.injectCallableContacts();

    // 7d. Reset the rest debounce window now that the session is actually
    //     ready. The class-field initializer set lastEngagementActivityAt
    //     at Coordinator construction time, which can be several seconds
    //     before agents finish connecting — so Observer's very first
    //     rest() call after coming online sees a depleted window and the
    //     session drops to resting almost immediately. Reset here so the
    //     user gets a fresh full 60s before the first rest is considered.
    this.noteEngagementActivity();

    // 7b. Log session start + all three agent prompts. MUST run inside
    //     runInSessionContext(this.sessionId, ...): the outer message-ingest
    //     context was bound when the `initialize` message arrived, at which
    //     point this.sessionId was still "?" and debugMode was false. The
    //     admin session-debug view reads session_debug_logs rows written by
    //     the flow logger (flowSessionStart/flowSystemPrompt → persistFlowToDb,
    //     keyed on ctx.sessionId + ctx.debugMode); without this re-wrap those
    //     rows — including the three SYSTEM_PROMPTs — get dropped or orphaned
    //     under "?" and never show for the real session. (logLiveSession is
    //     file-only, so its wrap only fixes the file tag.)
    // Cost gate + the single budget signal were loaded ABOVE, before the agents
    // were built, so startup honors the band. Here we just reset the per-session
    // trackers and start the level/throttle tick.
    this.lastReportedEnergyPercent = 100;
    this.drainSinceTranscript = { observer: 0, speaker: 0, boardManager: 0 };
    this.budgetDirty = false;
    this.lastBudgetSaveAt = Date.now();
    this.lastEnergyBand = null;
    this.budgetSpeakerTiredActive = false;
    this.startEnergyTimer();
    // Feed the budget meter from the universal ledger hook: EVERY charge for
    // this session (live agents, Monitor HTTP, TTS, in-session analysis) lands
    // in recordBudgetDrain, so the meter reflects true total spend.
    this.budgetChargeUnsub?.();
    this.budgetChargeUnsub = this.sessionId
      ? onLedgerCharge(this.sessionId, (credits) => this.recordBudgetDrain(credits))
      : null;
    this.lastSentBudgetPercent = -1;
    // Initial attention mirrors the clientConfig flags below. The Observer can
    // raise/lower these per modality at runtime via set_*_attention.
    //  - visual: cheap scene-state text when supported, else direct frames.
    //  - audio: STT text when supported; else gated raw audio ("adaptive") while
    //    economizing, or continuous ("live") in full-attention.
    this.visualAttention = this.capable("sceneState") ? "text" : "live";
    this.audioAttention = this.capable("clientStt") ? "text" : (this.economize ? "adaptive" : "live");
    runInSessionContext(this.sessionId, this.debugMode, () => {
      logLiveSession("SESSION START", [
        `Path: three-agent (AgentCoordinator)`,
        `Session: ${this.sessionId}`,
        `Student: ${this.studentId}`,
        `Observer: ${aacChat.provider}/${this.observerModel}`,
        `Speaker:  ${aacChat.provider}/${this.speakerModel} (mode=${this.speakerMode})`,
        `BoardMgr: ${BOARD_MANAGER_DEFAULT_PROVIDER}/${boardMgrMode === "live" ? LIVE_BOARD_MANAGER_MODEL : BOARD_MANAGER_DEFAULT_MODEL} (mode=${boardMgrMode})`,
        `Mute: ${this.muteState}`,
        `DirectAudio: ${this.useDirectAudio}`,
      ].join("\n"));
      logLiveSession("OBSERVER PROMPT", observerPrompt);
      logLiveSession("SPEAKER PROMPT", speakerPrompt);
      logLiveSession("BOARD MANAGER PROMPT", boardManagerPrompt);

      // High-signal flow log (separate from the verbose live-session log).
      // These ALSO persist to session_debug_logs (the admin trace), so they
      // belong inside this real-session context.
      flowSessionStart(this.sessionId!, {
        studentName: studentRow?.firstName || studentRow?.name?.split(" ")[0],
        observerModel: this.observerModel,
        speakerModel: this.speakerModel,
        boardMgrModel: boardMgrMode === "live" ? LIVE_BOARD_MANAGER_MODEL : BOARD_MANAGER_DEFAULT_MODEL,
        useDirectAudio: this.useDirectAudio,
        fullAttention: this.fullAttentionMode,
      });
      flowSystemPrompt("OBSERVER", observerPrompt);
      flowSystemPrompt("SPEAKER", speakerPrompt);
      flowSystemPrompt("BOARD_MGR", boardManagerPrompt);
    });

    // 8. Announce ready to client.
    this.state = "ready";
    this.send({
      type: "initialized",
      sessionId: this.sessionId,
      // Ship the tunable client-side constants (activity monitor cadence,
      // sleep thresholds, gesture window) from the server so they can
      // change without a client rebuild. Full-attention mode (per-student)
      // governs awake-while-streaming cost: OFF → apply the resting input
      // filter while awake (awakeDataSaver), ON → continuous streaming.
      clientConfig: buildDefaultClientConfig({
        awakeDataSaver: this.economize,
        // When active, the client transcribes speech on-device and sends
        // `speech_text` instead of streaming raw audio (Phase 1 cost saving).
        sttActive: this.capable("clientStt"),
        // When active, the client sends compact `scene_state` text in place of
        // idle frames, sending real frames only on escalation (Phase 2).
        sceneStateActive: this.capable("sceneState"),
        // Continuous (ungated) raw PCM only when audio attention starts at "live".
        pcmContinuous: this.audioAttention === "live",
        // Per-student seizure detection: resolved thresholds + seed baseline, or
        // undefined when the student has the feature off.
        seizure: buildClientSeizureConfig(studentRow?.aacSettings),
      }),
    });

    // Seed the client's energy bar with the loaded budget level right away, and
    // apply the low-band Speaker-tired floor now (not 15s later) if we came up
    // in the low band with a Speaker.
    this.maybePushBudget(Date.now());
    this.applyBudgetFloors(Date.now());

    // Deliver the apps lists to the client. The client populates its Apps
    // board ONLY from a session_snapshot (useLiveSession's session_snapshot
    // handler → setEnabledApps/setAvailableCustomApps); the legacy live-relay
    // sent this, but this 3-agent path never did — so the board was empty
    // (no default built-ins, no custom apps). See feedback_live_relay_is_legacy.
    this.sendAppsSnapshot();

    // 9. Push the default home board so the client has a surface to render
    //    before Board Manager produces anything. The legacy path does the
    //    same — without it, the user sees a blank screen until conversation
    //    starts. The home board is virtual (not in the DB); its native
    //    buttons emit board_exit messages that the AI handles as
    //    conversation kick-offs.
    const student = sessionCache?.monitorAgent.getStudent?.();
    const studentLang = student?.primaryLanguage || "en";
    const homeBoard = buildDefaultHomeBoard(studentLang, this.isSocialTrainerEnabled());
    this.loadedBoardId = "__home__";
    const homePage = (homeBoard as any).pages?.[0];
    if (homePage?.buttons) {
      const nativeButtons = homePage.buttons.filter((b: any) => typeof b?.label === "string");
      this.currentBoardLabels = nativeButtons.map((b: any) => b.label);
      this.currentBoardButtons = nativeButtons.map((b: any) => ({ ...b } as MergeButton));
    }
    this.send({
      type: "set_board",
      data: { board: homeBoard, name: (homeBoard as any).name || "Home", boardId: "__home__" },
    });
    runInSessionContext(this.sessionId, this.debugMode, () => {
      logLiveSession("HOME_BOARD_PUSHED", `lang=${studentLang} buttons=[${this.currentBoardLabels.join(", ")}]`);
    });
    // Prime the "Practice friend" face so the home button shows a peer.
    this.preparePeerPreview("home_board");

    // (Home board is ensured in availableBoards earlier, before prompt build.)
    //
    // The first Observer frame is NOT the ~10s-stale `initialFrame` from the
    // initialize message — the client captures and sends a FRESH frame the
    // instant it sees `initialized` (sendFreshStartupFrame), which arrives as
    // the first frame_grid and gets the startup prompt via forwardFrameToObserver.
  }

  // -------------------------------------------------------------------------
  // Voice resolution (mirrors dualAgentService.resolveVoices)
  // -------------------------------------------------------------------------

  private async resolveVoices(): Promise<void> {
    if (!this.studentId) return;
    // `aacSettings` lives in a SEPARATE table (`aac_settings`) and is joined
    // onto the student object by studentService as `{ ...student, aacSettings }`.
    // A raw `db.select().from(students)` does NOT include that relation, so the
    // old code read `studentRow.aacSettings === undefined` and EVERY voice field
    // (ElevenLabs key/voiceId, gemini voice, etc.) came back empty — silently
    // falling TTS back to Google. Read the cached student instead (same source
    // dual-agent-service.resolveVoices and the speaker-mode check at init use),
    // which carries the joined aacSettings.
    const studentRow = dualAgentService
      .getSessionCache(this.sessionId!)
      ?.monitorAgent.getStudent?.();
    if (!studentRow) {
      logLiveSession("VOICE RESOLUTION", "ABORTED — no cached student available");
      return;
    }
    const aac = (studentRow as any).aacSettings;
    const gender = (studentRow as any).gender as string | undefined;
    const elEnabled = aac?.elevenlabsEnabled !== false;

    const [aiCustom, studentCustom] = await Promise.all([
      aac?.customVoiceId ? voiceRecordRepository.getVoiceById(aac.customVoiceId) : Promise.resolve(undefined),
      aac?.customStudentVoiceId ? voiceRecordRepository.getVoiceById(aac.customStudentVoiceId) : Promise.resolve(undefined),
    ]);

    const studentFallback = gender === "female" ? "girl" : "boy";
    const defaultStudentGeminiVoice = gender === "female" ? "Leda" : "Puck";
    const defaultAiGeminiVoice = "Zephyr";

    this.aiVoice = {
      fallbackType: "woman",
      customVoice: aiCustom || null,
      language: (studentRow as any).primaryLanguage || "en",
      elevenlabsApiKey: elEnabled ? (aac?.elevenlabsApiKey || undefined) : undefined,
      elevenlabsVoiceId: elEnabled ? (aac?.elevenlabsAiVoiceId || undefined) : undefined,
      geminiVoiceName: aac?.geminiAiVoice || defaultAiGeminiVoice,
    };
    this.studentVoice = {
      fallbackType: studentFallback as any,
      customVoice: studentCustom || null,
      language: (studentRow as any).primaryLanguage || "en",
      elevenlabsApiKey: elEnabled ? (aac?.elevenlabsApiKey || undefined) : undefined,
      elevenlabsVoiceId: elEnabled ? (aac?.elevenlabsStudentVoiceId || undefined) : undefined,
      geminiVoiceName: aac?.geminiStudentVoice || defaultStudentGeminiVoice,
    };
  }

  // -------------------------------------------------------------------------
  // Prompt input assembly
  // -------------------------------------------------------------------------

  private async buildPromptInputs(): Promise<{
    observer: ObserverPromptConfig;
    speaker: SpeakerPromptConfig;
    boardManager: BoardManagerPromptConfig;
  }> {
    const cache = dualAgentService.getSessionCache(this.sessionId!);
    if (!cache) throw new Error("session cache missing during prompt build");
    const state = cache.state;
    const monitorAgent = cache.monitorAgent;
    const student = monitorAgent.getStudent?.();
    const studentName = student?.firstName || student?.name?.split(" ")[0] || "the user";
    const language = student?.primaryLanguage || undefined;
    const sections = state.enhancedSections;
    const aiName = student?.aacSettings?.aiName || undefined;

    // Cache for downstream speech-party comparisons (routeTranscribed, etc.)
    this.currentStudentName = studentName;
    this.currentStudentFullName = student?.name || undefined;
    this.aiName = aiName;
    // Cache the defined-gesture registry for report_gesture resolution.
    this.definedGestures = parseDefinedGestures(student?.aacSettings?.definedGestures);

    // Apps: built-ins (from the per-student appConfig, already resolved onto
    // state.appState.enabledApps by initializeSession) plus assigned custom
    // apps (license-gated). Wired here so the Speaker prompt lists them AND the
    // open_app tool declaration carries them (the coordinator reads
    // promptInputs.speaker.enabledApps / .availableCustomApps below). Also
    // cached on state.availableCustomApps for the client snapshot + open
    // resolution. Without this the 3-agent path never knew any apps existed.
    const enabledAppDefs = (state.appState?.enabledApps || [])
      .map((id) => getAppDefinition(id))
      .filter((a): a is AACAppDefinition => !!a);
    if (state.availableCustomApps === undefined && this.userId && this.studentId) {
      try {
        const perms = await licenseService.getUserPermissions(this.userId);
        if (perms.customAppsEnabled) {
          const apps = await customAppRepository.getAssignedAppsForStudent(this.studentId);
          state.availableCustomApps = apps.map((a) => ({
            id: a.id,
            name: a.name,
            imageUrl: (a as any).imageUrl ?? null,
            description: a.description,
          }));
        } else {
          state.availableCustomApps = [];
        }
      } catch (err) {
        logLiveSession("CUSTOM_APPS_FETCH_FAILED", String(err));
        state.availableCustomApps = [];
      }
    }

    const base = {
      studentName,
      language,
      studentAge: undefined as string | undefined,
      studentGender: (student as any)?.gender,
      studentDiagnosis: state.cachedDiagnosis || undefined,
      aiName,
      knownContacts: state.cachedContacts,
      classroom: undefined as any, // classroom plumbing wired in a follow-up
      gestureOverrides: sections?.gestureOverrides,
      safetyNotes: sections?.safetyNotes,
    };

    return {
      observer: {
        ...base,
        observerInstructions: sections?.observerInstructions,
        alarmConditions: sections?.alarmConditions,
        perceptionMemory: state.memoryContext,
        // Same {key, name, hint} shape as the Speaker's availableBoards.
        // Observer doesn't load boards — it flags matching situations via
        // update_context so BoardManager can bring up the right surface.
        // Exclude the Home board — it's not a situation-specific surface to
        // flag, and listing it here confused the Observer.
        availableBoards: state.availableBoards
          ?.filter(b => b.key !== HOME_BOARD_KEY)
          .map(b => ({ key: b.key, name: b.name, hint: b.hint })),
        definedGestures: this.definedGestures.length > 0 ? this.definedGestures : undefined,
        energyBudget: this.buildEnergyBudgetText(this.aacChatProvider),
        economyModeEnabled: this.observerModeSwitchable,
        alwaysConservative: this.observerPolicy.alwaysConservative,
      },
      speaker: {
        ...base,
        persona: sections?.persona || composeAacPersona({ custom: student?.aacSettings?.chatAgentPrompt, auto: student?.aacSettings?.autoAacPrompt }),
        memoryContext: state.memoryContext,
        muteState: state.muteState,
        // In HTTP mode the assistant text content IS the spoken reply —
        // there is no speak() tool. Mirror that to the prompt builder via
        // the same useDirectAudio flag the native-audio path uses so the
        // model doesn't get instructed to call a tool that isn't there.
        useDirectAudio: this.useDirectAudio || this.speakerMode === "http",
        // liveAudio is strictly the Gemini Live native-audio path — used
        // to gate mimicry guidance and pacing-aware framing that don't
        // apply when text → server TTS handles the voicing.
        liveAudio: this.useDirectAudio,
        sessionGoals: sections?.sessionGoals,
        // Sentence length/complexity matched to the student (general AAC
        // setting; default tier emits no directive). Same column the peer reads.
        languageLevel: languageLevelFromInt((student?.aacSettings as any)?.languageLevel),
        // Three-agent path uses speech-only examples; DON'T fall back to
        // the legacy interactModeExamples (those contain rebuild_board
        // calls Speaker doesn't have). When the enhancer hasn't been
        // re-run, buildSpeakerPrompt falls back to the static
        // speaker.interact_dialogue / speaker.assist_dialogue examples.
        interactModeExamples: sections?.speakerInteractExamples,
        assistModeExamples: sections?.speakerAssistExamples,
        // sentenceInterpretationExamples moved to Board Manager along
        // with the interpret() tool — Speaker no longer needs it.
        sessionSummary: state.sessionSummary,
        availableBoards: state.availableBoards?.map(b => ({ key: b.key, name: b.name, hint: b.hint })),
        // Apps the Speaker may launch via open_app. enabledApps drives both the
        // prompt's "Available apps" block and the open_app tool declaration
        // (rebuilt from these ids at coordinator line ~1422).
        enabledApps: enabledAppDefs.map(a => ({ id: a.id, name: a.name, description: a.description })),
        availableCustomApps: (state.availableCustomApps || []).map(a => ({
          id: a.id,
          name: a.name,
          description: a.description,
        })),
        permittedWebsites: state.permittedWebsites,
      },
      boardManager: {
        ...base,
        memoryContext: state.memoryContext,
        muteState: state.muteState,
        cachedSymbols: state.cachedSymbols,
        availableBoards: state.availableBoards,
        // Show BOTH key and name so the model never confuses them.
        // Look up the key by id (the loaded board's row id) — the
        // availableBoards array carries the normalized key alongside id+name.
        loadedBoardKey: state.loadedBoardData
          ? state.availableBoards?.find(b => b.id === state.loadedBoardId)?.key ?? null
          : null,
        loadedBoardName: state.loadedBoardData?.name ?? null,
        // Apps + websites the BoardManager may author launch-buttons for
        // (`open.app` / `open.website`). These drive both the prompt's
        // apps_context/websites_context blocks and the `open` field on the
        // button schema; the coordinator re-gates targets on press-through.
        enabledApps: enabledAppDefs.map(a => ({ id: a.id, name: a.name, description: a.description })),
        availableCustomApps: (state.availableCustomApps || []).map(a => ({
          id: a.id,
          name: a.name,
          description: a.description,
        })),
        permittedWebsites: state.permittedWebsites,
        autoSymbolsEnabled: !!(student?.aacSettings?.generateSymbols),
        singleGlyphButtons: !!student?.aacSettings?.singleGlyphButtons,
        glyphInputTranslation: !!student?.aacSettings?.glyphInputTranslation,
        // Button utterances match the student's receptive language level.
        languageLevel: languageLevelFromInt((student?.aacSettings as any)?.languageLevel),
        boardManagerGuidance: sections?.boardManagerGuidance,
        sentenceInterpretationExamples: sections?.sentenceInterpretationExamples,
        boardManagerExamples: sections?.boardManagerExamples,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Client → bus
  // -------------------------------------------------------------------------

  private async handleButtonPress(msg: Extract<ClientMessage, { type: "button_press" }>): Promise<void> {
    const label = msg.buttons[0] || "";
    const sentence = msg.sentences?.[label] || label;

    // 0. Stamp engagement activity IMMEDIATELY on arrival. The press is
    //    real user activity the moment it lands on the server. Without
    //    this, a pending rest timer can fire during the ~2-3s TTS
    //    streaming await below — the press is honored later, but the
    //    session has already dropped to resting in the meantime,
    //    triggering a needless wake cycle (and possible MALFORMED on
    //    the freshly-rebuilt Speaker). emitClientEvent later in this
    //    handler also calls noteEngagementActivity, but that's gated
    //    behind the await; we need the timer cancellation NOW.
    this.noteEngagementActivity();

    // 0a. "More" button — the user wants more options on the current
    //     board, NOT to say "[MORE]" aloud or to trigger a conversational
    //     beat. Skip TTS, skip Speaker user_turn, and just kick
    //     BoardManager with a "give me more options" hint. The hint
    //     rides in on recentEvents as a synthetic context_update so
    //     BoardManager's next invocation sees the intent.
    if (label === "[MORE]") {
      // In Word Finder, "More" pages the CURRENT question's long tail (rarer
      // answers to the same question) via the engine — it does NOT ask
      // BoardManager for free-form alternatives. The engine owns the narrowing
      // surface while guessing is active.
      if (this.guessingEngineState) {
        void this.wakeForGuessingIntent("guessing_more", () => {
          if (!this.guessingEngineState) return;
          expandGuessingDimension(this.guessingEngineState);
          this.refreshGuessingSnapshot(false);
        });
        flowNote("COORDINATOR", "[MORE] pressed in Word Finder — paging current dimension's long tail.");
        return;
      }
      if (this.sessionProfile === "resting") {
        flowNote("COORDINATOR", "[MORE] arrived while resting — waking before invoking BoardManager.");
        await this.transitionToProfile("awake");
      }
      const moreHint: ContextUpdateEvent = {
        type: "context_update",
        source: "observer",
        timestamp: Date.now(),
        updateType: "other",
        key: "more_options_requested",
        description: "The user pressed More — they couldn't find the right button on the current board. Call add_board_button or rebuild_board with FRESH alternative options (different angles on the same topic, related but not previously offered). Do NOT speak; this is a board-only request.",
      };
      this.recordEvent(moreHint);
      // Tell Speaker silently so it knows the press happened but does
      // not respond — this is not a conversational turn.
      this.speaker?.sendContextInjection(`[MORE] The user pressed More — they want more button options. Do NOT speak; let BoardManager refresh the surface.`);
      flowNote("COORDINATOR", `[MORE] pressed — BoardManager invoked, no TTS, no Speaker user_turn.`);
      void this.invokeBoardManager([moreHint]);
      return;
    }

    // 0b. Repeated-press guard. A perseverating student taps the same button
    //     many times; each tap would otherwise interrupt Speaker mid-reply
    //     (sendUserTurn) and fire a fresh BoardManager rebuild, thrashing
    //     turn scheduling. If this press is identical to the open burst AND
    //     Speaker is still responding (or it landed within the window), we
    //     coalesce: re-voice the utterance for feedback (the press
    //     registered) but DON'T emit a button_pressed turn. The tally is
    //     persisted once the burst settles (flushRepeatBurst).
    const now = Date.now();
    const signature = msg.buttons.join(AgentCoordinator.PRESS_SIGNATURE_SEP);
    // "Busy" = the response to the burst's first press is still in progress:
    // the Speaker is talking, a rebuild is in flight, or the deferred-rebuild
    // timer is armed. A re-press while busy is a LATENCY re-press (the board
    // hasn't visibly updated yet) — coalesce it and DON'T spin up another
    // rebuild. `boardMgrInFlight` is included specifically so re-presses during
    // a slow board regeneration don't each trigger a fresh regeneration.
    const busy = this.speakerSpeaking || this.deferredBoardMgrTimer !== null || this.boardMgrInFlight;
    const repeat = isRepeatPress({
      signature,
      lastSignature: this.lastPressSignature,
      modelResponding: busy,
      now,
      lastPressAt: this.lastPressAt,
      windowMs: AgentCoordinator.PRESS_REPEAT_WINDOW_MS,
    });
    this.lastPressAt = now;
    if (repeat) {
      this.pressRepeatCount++;
      // Settled re-press: the response had already landed (not busy) and the
      // user pressed the same thing again anyway → genuine perseveration.
      if (!busy) this.pressSettledRepeatCount++;
      flowNote("COORDINATOR", `Repeated press "${label}" (×${this.pressRepeatCount}${busy ? ", awaiting response" : ", after response settled"}) — re-voicing only; Speaker not interrupted.`);
      if (sentence) {
        flowOutput("COORDINATOR", "ws_send_utterance", sentence);
        this.send({ type: "utterance", text: sentence, confidence: "high", noAudioClear: false });
        try { await this.streamStudentTts(sentence, "button_press_repeat"); } catch { /* logged inside */ }
      }
      this.scheduleRepeatBurstFlush();
      return;
    }
    // New/different press → record any prior burst's tally, then start fresh.
    this.flushRepeatBurst();
    this.lastPressSignature = signature;
    this.pressRepeatCount = 1;
    this.pressSettledRepeatCount = 0;

    // 0c. INTERRUPT (Phase C). A fresh press means the student wants the floor —
    //     cut off whatever the AI/peer is currently saying so their own voice
    //     isn't talked over. In a social session this is a turn-taking
    //     VIOLATION only if the peer had actually started speaking, or the last
    //     press was a BID (the user handed the turn over, then jumped it). The
    //     director docks turnTaking + loses rapport on the next turn.
    const pressRole = this.pressedButtonRole(label);
    const wasAiSpeaking = this.isAiSpeaking();
    this.interruptAiSpeech();
    if (this.socialPeer && (wasAiSpeaking || this.lastPressRole === "bid")) {
      this.socialPeer.agent.noteUserInterruption();
      flowNote(
        "COORDINATOR",
        `Social turn-taking violation — interrupting press (peerSpeaking=${wasAiSpeaking}, afterBid=${this.lastPressRole === "bid"}).`,
      );
    }
    this.lastPressRole = pressRole;

    // 1. Surface the utterance to the client UI immediately (clears
    //    previous text). noAudioClear=false matches the legacy contract.
    //    NOTE: this message is for UI display only — it carries text,
    //    not audio. If the client TTSes this text locally in addition
    //    to playing the streamed utterance_audio, we'd hear the SENTENCE
    //    twice. The flow log below makes the send visible so the source
    //    of any doubling is traceable.
    if (sentence) {
      flowOutput("COORDINATOR", "ws_send_utterance", sentence);
      this.send({ type: "utterance", text: sentence, confidence: "high", noAudioClear: false });
    }

    // 2. Stream the student-voice TTS AND WAIT for it to finish before
    //    delivering the press to Speaker. Without the await, the AI's
    //    response audio sometimes lands before the student voice has
    //    finished playing on the client — the press feels skipped.
    //    The await covers server-side stream completion; the client
    //    plays the audio out a beat later, but at this point the audio
    //    chunks have arrived in order ahead of Speaker's reply.
    if (sentence) {
      try { await this.streamStudentTts(sentence, "button_press", { bid: pressRole === "bid", addressee: this.pressedButtonAddressee(label) }); } catch { /* logged inside */ }
    }

    // 3. Route the event so Observer / Speaker / Board Manager all see it.
    this.emitClientEvent({
      type: "button_pressed",
      source: "client",
      timestamp: Date.now(),
      label,
      sentence,
      role: this.pressedButtonRole(label),
      addressee: this.pressedButtonAddressee(label),
    });
  }

  /** Conversational role of the pressed button, looked up from the current
   *  board by label. Defaults to "reply" (BoardManager omits it on plain
   *  answers; only bids are marked). */
  private pressedButtonRole(label: string): "reply" | "bid" {
    const b = this.currentBoardButtons.find((x) => x.label === label) as { role?: "reply" | "bid" } | undefined;
    return b?.role === "bid" ? "bid" : "reply";
  }

  /** Group-chat addressee the BoardManager set on the pressed button (a peer
   *  name), if any — looked up from the current board by label. */
  private pressedButtonAddressee(label: string): string | undefined {
    const b = this.currentBoardButtons.find((x) => x.label === label) as { addressee?: string } | undefined;
    return b?.addressee;
  }

  /** Join composed press sentences into one natural turn (each ends with
   *  punctuation so the peer reads "Me too. What about you?"). */
  private static joinPressSentences(sentences: string[]): string {
    return sentences
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/[.!?]$/.test(s) ? s : `${s}.`))
      .join(" ")
      .trim();
  }

  /** SOCIAL TRAINER press (Phase B). A BID fires the peer's turn immediately,
   *  combining any buffered reply; a REPLY buffers, shows a follow-up board,
   *  and holds the peer's turn briefly so the user can chain a bid. */
  private handleSocialTrainerPress(event: ButtonPressedEvent): void {
    if (event.role === "bid") {
      this.commitSocialTurn(event.sentence, event);
      return;
    }
    if (!this.socialReplyBuffer) this.socialReplyBuffer = { sentences: [], timer: null, lastEvent: null };
    const buf = this.socialReplyBuffer;
    buf.sentences.push(event.sentence);
    buf.lastEvent = event;
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => this.commitSocialTurn(null, null), SOCIAL_REPLY_HOLD_MS);
    flowNote("COORDINATOR", `Social REPLY buffered ("${event.sentence}") — follow-up board now; peer turn in ${SOCIAL_REPLY_HOLD_MS}ms unless a bid chains.`);
    this.invokeBoardManager([event]);
  }

  /** Send the buffered social reply(ies) (+ an optional chained bid) to the
   *  peer as ONE combined turn, then schedule the response board. */
  private commitSocialTurn(extraSentence: string | null, extraEvent: ButtonPressedEvent | null): void {
    const buf = this.socialReplyBuffer;
    if (buf?.timer) clearTimeout(buf.timer);
    const sentences = [...(buf?.sentences ?? [])];
    if (extraSentence) sentences.push(extraSentence);
    const lastEvent = extraEvent ?? buf?.lastEvent ?? null;
    this.socialReplyBuffer = null;
    if (!this.socialPeer) return; // session ended during the hold
    const combined = AgentCoordinator.joinPressSentences(sentences);
    if (!combined) return;
    flowNote("COORDINATOR", `Social peer turn: "${combined}"`);
    this.speakerRespond(`[USER to YOU] "${combined}"`);
    this.scheduleDeferredBoardMgr(lastEvent, "social_press");
  }

  /** FACILITATOR press (Phase B). A REPLY keeps the user elaborating (follow-up
   *  board now); a BID hands the turn to the human, so wait for them to answer
   *  before offering a fresh board (cancelled by the next press or their reply). */
  private handleFacilitatorPress(event: ButtonPressedEvent): void {
    this.clearFacilitatorBidTimer();
    if (event.role === "bid") {
      const bidAt = Date.now();
      this.facilitatorBidTimer = setTimeout(() => {
        this.facilitatorBidTimer = null;
        if (this.lastExternalToUserAt > bidAt) return; // the human answered — board already handled
        flowNote("COORDINATOR", "Facilitator bid drew no response — offering a fresh board.");
        this.invokeBoardManager([event]);
      }, FACILITATOR_BID_WAIT_MS);
      flowNote("COORDINATOR", `Facilitator BID — holding ${FACILITATOR_BID_WAIT_MS}ms for the other person to answer.`);
    } else {
      this.invokeBoardManager([event]);
    }
  }

  private clearFacilitatorBidTimer(): void {
    if (this.facilitatorBidTimer) { clearTimeout(this.facilitatorBidTimer); this.facilitatorBidTimer = null; }
  }

  /** Whether the social-trainer app is enabled for this student. Drives the
   *  "Practice friend" home-board button + its persona preview. */
  private isSocialTrainerEnabled(): boolean {
    const cache = this.sessionId ? dualAgentService.getSessionCache(this.sessionId) : undefined;
    // appState.enabledApps is a string[] of app IDs (see types.ts).
    const apps = (cache?.state.appState?.enabledApps || []) as string[];
    return apps.includes("social_trainer");
  }

  /** The student's age in whole years from their birthDate, or undefined. */
  private studentAgeYears(): number | undefined {
    const student = this.sessionId
      ? dualAgentService.getSessionCache(this.sessionId)?.monitorAgent.getStudent?.()
      : undefined;
    const birthDate = (student as { birthDate?: string | Date } | undefined)?.birthDate;
    if (!birthDate) return undefined;
    const ms = Date.now() - new Date(birthDate).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
  }

  /** Semitone pitch shift for the social peer's voice so an adult Gemini voice
   *  reads as roughly the student's age. `AAC_PEER_VOICE_PITCH` overrides for
   *  tuning across voice timbres. Applied client-side to the peer's audio. */
  private peerVoicePitch(): number {
    const override = Number(process.env.AAC_PEER_VOICE_PITCH);
    if (Number.isFinite(override) && process.env.AAC_PEER_VOICE_PITCH !== undefined && process.env.AAC_PEER_VOICE_PITCH !== "") {
      return override;
    }
    return peerVoicePitchSemitones(this.studentAgeYears());
  }

  /** Semitone formant (vocal-tract) shift for the social peer — the primary
   *  "younger" cue (see voice-pick). `AAC_PEER_VOICE_FORMANT` overrides for
   *  tuning. Applied client-side via the cepstral formant shifter. */
  private peerVoiceFormant(): number {
    const override = Number(process.env.AAC_PEER_VOICE_FORMANT);
    if (Number.isFinite(override) && process.env.AAC_PEER_VOICE_FORMANT !== undefined && process.env.AAC_PEER_VOICE_FORMANT !== "") {
      return override;
    }
    return peerVoiceFormantSemitones(this.studentAgeYears());
  }

  /**
   * Observer reported a defined gesture (report_gesture tool). Resolve it
   * against the server-side registry — the configured meaning wins over
   * anything the model said — and replay the button-press flow: voice the
   * meaning in the student's voice, then route a `button_pressed` event so
   * Speaker replies and Board Manager rebuilds exactly as for a tapped
   * button. A per-gesture cooldown collapses the multi-frame re-reports a
   * held gesture produces.
   */
  private async handleGestureRecognized(event: GestureRecognizedEvent): Promise<void> {
    const match = resolveDefinedGesture(this.definedGestures, event.gesture);
    if (!match) {
      flowNote("COORDINATOR", `report_gesture "${event.gesture}" matched no defined gesture — ignored.`);
      this.observer?.sendContextInjection(
        `[GESTURE IGNORED] "${event.gesture}" is not in <defined_gestures> — only report the listed gestures.`,
      );
      return;
    }

    const now = Date.now();
    const last = this.lastGesturePressAt.get(match.name) ?? 0;
    if (now - last < GESTURE_PRESS_COOLDOWN_MS) {
      flowNote("COORDINATOR", `Gesture "${match.name}" re-reported within cooldown — ignored.`);
      return;
    }
    this.lastGesturePressAt.set(match.name, now);

    // Same sequence as handleButtonPress: stamp activity, surface the
    // utterance, voice it through the student TTS, then fan out. The
    // emitClientEvent wake gate handles a gesture arriving while resting.
    this.noteEngagementActivity();
    flowNote("COORDINATOR", `Gesture "${match.name}" recognized → voicing "${match.meaning}" as a button press.`);
    flowOutput("COORDINATOR", "ws_send_utterance", match.meaning);
    this.send({ type: "utterance", text: match.meaning, confidence: "high", noAudioClear: false });
    try { await this.streamStudentTts(match.meaning, "gesture_press"); } catch { /* logged inside */ }

    this.emitClientEvent({
      type: "button_pressed",
      source: "client",
      timestamp: Date.now(),
      label: match.name,
      sentence: match.meaning,
      via: "gesture",
      gestureName: match.name,
      // A defined gesture is by definition directed at the device — don't
      // inherit a third-party board target from the last rebuild.
      target: PARTY_DEVICE,
    });
  }

  /** (Re)arm the timer that flushes a repeated-press burst once it goes
   *  quiet (no further repeats within the window). */
  private scheduleRepeatBurstFlush(): void {
    if (this.pressBurstFlushTimer) clearTimeout(this.pressBurstFlushTimer);
    this.pressBurstFlushTimer = setTimeout(() => {
      this.pressBurstFlushTimer = null;
      this.withSessionContext(() => this.flushRepeatBurst());
    }, AgentCoordinator.PRESS_REPEAT_WINDOW_MS);
  }

  /**
   * Persist the repeat tally for the open press burst (if the same button
   * was pressed more than once) as a single supervisor-only note, then reset
   * the burst. Routed via writeSupervisorOnly so the Monitor sees the
   * perseveration WITHOUT it polluting Speaker's replayed conversation log.
   *
   * When the burst includes a SETTLED repeat (the user re-pressed after the
   * board/AI had already responded — genuine perseveration, not just latency),
   * ALSO nudge the companion Speaker live so it varies its reply / actually
   * engages the request instead of re-emitting the same canned line. The nudge
   * is companion-only: in social-practice mode the peer consumes user
   * utterances (not context injections), and while muted the AI stays silent.
   *
   * Called when a new/different press arrives, when the burst goes quiet
   * (timer), on sleep, and on cleanup.
   */
  private flushRepeatBurst(): void {
    if (this.pressBurstFlushTimer) {
      clearTimeout(this.pressBurstFlushTimer);
      this.pressBurstFlushTimer = null;
    }
    const total = this.pressRepeatCount;
    const settled = this.pressSettledRepeatCount;
    const signature = this.lastPressSignature;
    this.pressRepeatCount = 0;
    this.pressSettledRepeatCount = 0;
    this.lastPressSignature = null;
    if (total > 1 && signature) {
      const label = signature.split(AgentCoordinator.PRESS_SIGNATURE_SEP).join(", ");
      this.writeSupervisorOnly(formatRepeatNote(label, total));
      flowNote("COORDINATOR", `Repeat burst settled: "${label}" pressed ${total} times in a row (${settled} after a response).`);
      if (settled > 0 && !this.socialPeer && this.muteState !== "muted") {
        this.speaker?.sendContextInjection(
          `[USER INSISTING] The user pressed "${label}" ${total} times in a row, continuing even after you/the board already responded. They clearly want this — acknowledge their persistence and engage the request directly. Do NOT repeat your earlier reply; say something new (and if you genuinely can't act on it, explain why warmly rather than brushing it off).`,
        );
        flowNote("COORDINATOR", `Nudged Speaker about perseveration on "${label}".`);
      }
    }
  }

  /**
   * The user pressed an exit button on a loaded custom board (e.g. one of
   * the home-board navigation buttons — "Interact", "Assist", "Build
   * sentence"). The board carries an instruction string that's directed at
   * the AI (e.g. "[INTERACT] The user wants to talk to you. Rebuild the
   * board with conversation starters..."). We route it the same shape as a
   * button press: Observer context, Speaker user turn, Board Manager HTTP.
   *
   * Special-case the Home press — load the home board directly without an
   * AI roundtrip so the user always gets back to the menu instantly.
   */
  private handleBoardExit(msg: Extract<ClientMessage, { type: "board_exit" }>): void {
    // Hoist the wake-gate: ANY board-exit press while resting wakes the
    // session before downstream routing. The downstream paths
    // (routeHomeTopicPress, emitClientEvent) each have their own wake
    // checks, but they only fire on specific event shapes — a press
    // that takes the "reload home" fast-path below or the fallback
    // generic-press path would otherwise miss the wake. Doing it here
    // covers every menu-button press uniformly.
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", `Board exit "${msg.label}" arrived while resting; waking before routing.`);
      void this.transitionToProfile("awake").then(() => this.handleBoardExitInner(msg));
      return;
    }
    this.handleBoardExitInner(msg);
  }

  private handleBoardExitInner(msg: Extract<ClientMessage, { type: "board_exit" }>): void {
    // Client signals an explicit word-finder cancel via an EXIT GUESSING
    // tag on the instruction. Clear server-side guessingState before
    // routing, so BoardManager's next invocation doesn't keep producing
    // suggestion-keyed buttons.
    if (msg.instruction?.includes("[EXIT GUESSING]")) {
      this.clearGuessingState("board_exit_tag");
    }

    const isHomePress = msg.label === "Home" ||
      (msg.instruction && /set_board\(["']home["']\)|load.*home board/i.test(msg.instruction));

    if (isHomePress) {
      // Reload the home board directly. Notify the AI via context only.
      const cache = dualAgentService.getSessionCache(this.sessionId!);
      const studentLang = cache?.monitorAgent.getStudent?.()?.primaryLanguage || "en";
      const homeBoard = buildDefaultHomeBoard(studentLang, this.isSocialTrainerEnabled());
      this.loadedBoardId = "__home__";
      const homePage = (homeBoard as any).pages?.[0];
      if (homePage?.buttons) {
        const nativeButtons = homePage.buttons.filter((b: any) => typeof b?.label === "string");
        this.currentBoardLabels = nativeButtons.map((b: any) => b.label);
        this.currentBoardButtons = nativeButtons.map((b: any) => ({ ...b } as MergeButton));
      }
      this.send({
        type: "set_board",
        data: { board: homeBoard, name: (homeBoard as any).name || "Home", boardId: "__home__" },
      });
      const homeContext = `[CONTEXT] The user pressed Home. The home ${T.board} is loaded with its native navigation ${T.button}s. Wait for them to press one before changing the board.`;
      this.observer?.sendContextInjection(homeContext);
      this.speaker?.sendContextInjection(homeContext);
      // Re-send the "Practice friend" face for the freshly-loaded home board.
      this.preparePeerPreview("home_press");
      return;
    }

    // "Practice friend" (social-trainer home button) — toggles the session.
    // Idle → start (reusing the preview persona so the face matches). Active →
    // end (mid-session the button shows the peer's face with an X). The client
    // only fires this when a face is present, so we never start during the
    // post-session cooldown.
    if (msg.instruction?.includes("[PRACTICE FRIEND]")) {
      if (this.socialPeer) void this.endSocialPeerSession("user_exit");
      else void this.startSocialPeerSession("client_launch");
      return;
    }

    // Pressing a "talk" button (Interact = companion, Talk = facilitator) while
    // a practice session is running ends it immediately. The end flow restores
    // the companion conversation + debrief; the user can pick a mode again from
    // the restored home board.
    if (this.socialPeer && (msg.instruction?.includes("[INTERACT]") || msg.instruction?.includes("[ASSIST]"))) {
      flowNote("COORDINATOR", `Talk button "${msg.label}" pressed during practice — ending session.`);
      void this.endSocialPeerSession("user_switched_mode");
      return;
    }

    // Home-board navigation presses carry a tag prefix on their
    // instruction (`[INTERACT] ...`, `[FEELINGS] ...`, etc.). Each tag
    // maps to a HOME_INTENTS entry: an optional mode-set + per-agent
    // behavior hints. The press itself is routed exactly like any other
    // SENTENCE BUTTON tap (TTS-voiced label + button_pressed event); the
    // hints are injected as ADDITIONAL context so each agent has the
    // right framing when the press lands.
    const tagMatch = (msg.instruction ?? "").match(/^\[([A-Z ]+)\]/);
    const tag = tagMatch?.[1]?.trim();
    if (tag && this.routeHomeTopicPress(tag, msg.label)) return;

    // Fallback: any other exit-button press (custom boards, etc.) goes
    // through the normal button-press flow with the raw instruction.
    this.emitClientEvent({
      type: "button_pressed",
      source: "client",
      timestamp: Date.now(),
      label: msg.label,
      sentence: msg.instruction || msg.label,
    });
  }

  /**
   * Home-board navigation press: same downstream flow as a regular
   * SENTENCE BUTTON tap (TTS-voice the label, then emit a button_pressed
   * event), plus the HOME_INTENTS entry's behavior hints fed to Speaker
   * and BoardManager as context. Returns true on a recognized tag.
   */
  private routeHomeTopicPress(tag: string, label: string): boolean {
    const intent = HOME_INTENTS[tag];
    if (!intent) return false;

    // Wake the session before any per-agent routing — same reason as
    // the gate in emitClientEvent. Otherwise the press lands on resting
    // Speaker and gets swallowed.
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", `Home press ${tag} arrived while resting; waking before routing.`);
      void this.transitionToProfile("awake").then(() => this.routeHomeTopicPressInner(intent, label));
      return true;
    }
    void this.routeHomeTopicPressInner(intent, label);
    return true;
  }

  private async routeHomeTopicPressInner(intent: HomeIntent, label: string): Promise<void> {
    // Mode set: programmatically switch BEFORE routing so downstream
    // hints see the new mode. We bypass Speaker's set_interaction_mode
    // tool — this came from the user, not the AI.
    if (intent.setMode && this.currentInteractionMode !== intent.setMode) {
      this.routeModeChange({
        type: "mode_change",
        source: "observer",
        timestamp: Date.now(),
        mode: intent.setMode,
        reason: "User pressed home-board navigation.",
      });
    }
    const effectiveMode = intent.setMode ?? this.currentInteractionMode;

    // Inject behavior hints BEFORE the press lands. Per-agent split:
    //  - Speaker: behavioral hint only ("greet warmly", "ask gently",
    //    etc.). No board / palette instructions — Speaker doesn't own
    //    the board and rebuild language would confuse it.
    //  - BoardManager: palette directive stashed as a one-shot
    //    `forceRebuildDirective` consumed by the next invocation. This
    //    overrides BM's usual "no_change if existing covers" escape so
    //    the home-press always refreshes the surface even when the
    //    parent board's labels overlap the requested topic.
    //  - Observer: no special hint — just sees the press through the
    //    normal [BUTTON PRESS] context that handleSyntheticPress emits.
    //  - Monitor: no special hint — the press lands in the conversation
    //    log via appendToConversationLog (the regular `[USER to YOU]
    //    "label"` line), which is all Monitor needs to know.
    const speakerHint = effectiveMode === "companion"
      ? intent.speakerCompanion
      : intent.speakerFacilitator;
    if (speakerHint) {
      this.speaker?.sendContextInjection(`[HINT] ${speakerHint}`);
    }
    this.pendingForceRebuildDirective = intent.boardManager;

    if (intent.silent) {
      // Silent home press — the button is a navigation/mode signal, not
      // a user utterance. Skip the student-voice TTS and the
      // [BUTTON PRESS to YOU] route to Speaker entirely. The mode change,
      // speaker hint, and board hint above are the whole effect; trigger
      // BoardManager directly so the new surface arrives without
      // needing a press event to ride on. We DO note engagement
      // activity so the rest debounce resets.
      this.noteEngagementActivity();
      flowNote("COORDINATOR", `Silent home press "${label}" — no TTS, BoardManager invoked directly.`);
      void this.invokeBoardManager([]);
      return;
    }

    // Now emit the press through the normal flow: this voices the label
    // via TTS (so the room hears it the way any SENTENCE BUTTON would)
    // AND emits button_pressed, which routes through emitClientEvent ->
    // routeClientEvent like a regular tap. Target defaults to DEVICE so
    // Speaker sees `[BUTTON PRESS → YOU] "<label>"` and replies.
    await this.handleSyntheticPress(label);
  }

  /**
   * Voice a press through TTS and route it as a button_pressed event,
   * the same way handleButtonPress does for client-originated presses.
   * Used by home-board navigation so synthetic presses get the full
   * standard treatment (utterance display + student-voice TTS + the
   * standard target-aware routing).
   */
  private async handleSyntheticPress(label: string): Promise<void> {
    // Stamp engagement activity immediately — see handleButtonPress for
    // the rationale. The press is real activity the moment it lands;
    // the TTS await below mustn't let a pending rest timer slip through.
    this.noteEngagementActivity();
    if (label) {
      flowOutput("COORDINATOR", "ws_send_utterance", label);
      this.send({ type: "utterance", text: label, confidence: "high", noAudioClear: false });
      try { await this.streamStudentTts(label, "button_press"); } catch { /* logged inside */ }
    }
    this.emitClientEvent({
      type: "button_pressed",
      source: "client",
      timestamp: Date.now(),
      label,
      sentence: label,
    });
  }

  private handleMuteToggled(state: AACMuteState): void {
    this.muteState = state;
    this.emitClientEvent({
      type: "mute_toggled",
      source: "client",
      timestamp: Date.now(),
      state,
    });
  }

  private handleConstructionState(data: any): void {
    // Composing in the sentence builder is real user activity — each
    // construction_state push (glyph added, removed, slot changed)
    // counts. Without this reset, a long compose session can let a
    // pending rest timer fire mid-composition. Also wake if we're
    // currently resting so the BoardManager can produce suggestions
    // (resting profile gates BM out — see invokeBoardManager).
    this.noteEngagementActivity();
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", "construction_state arrived while resting — waking before routing.");
      void this.transitionToProfile("awake").then(() => this.applyConstructionState(data));
      return;
    }
    this.applyConstructionState(data);
  }

  /** Inner half of handleConstructionState — runs after the wake gate. */
  private applyConstructionState(data: any): void {
    this.builderState = {
      category: data.category,
      modeChip: data.modeChip,
      partialSentence: data.glyph,
      targetSlot: data.targetSlot ?? 0,
      excludeKeys: data.excludeKeys ?? [],
      currentBoard: data.currentBoard,
      payloadTarget: data.payloadTarget
        ? { slotIndex: data.payloadTarget.slotIndex, host: data.payloadTarget.hostKey }
        : undefined,
    };

    // Notify Observer so it can flag environmental objects that match the
    // category the user is filling — when something becomes the likely
    // referent, Observer emits update_context with relevance:
    // "builder-candidate", which loops back through routeContextUpdate to
    // re-invoke BoardManager with a fresh suggest_construction_buttons call.
    this.observer?.sendContextInjection(
      `[${T.tagBuilderState}] category=${data.category} target_slot=${data.targetSlot ?? "next_empty"} partial="${data.glyph || "(empty)"}". Watch the environment for objects the user might be referencing for this slot — flag them via update_context(person_indicates_object / new_object) with relevance: "builder-candidate".`,
    );

    // Drive Board Manager — the builder state change IS the trigger.
    void this.invokeBoardManager([]);
  }

  /**
   * Legacy compat shim — accepts a pre-rendered snapshot from older
   * client builds that still own their own GuessingModeState. We can't
   * recreate the engine state from the snapshot (the wire shape doesn't
   * carry weights/history), so we accept it verbatim and any subsequent
   * intent messages from the same session will trigger a fresh engine
   * on the server. This path will be removed once all clients have
   * shipped with the intent protocol.
   */
  private handleLegacyGuessingState(
    msg: Extract<ClientMessage, { type: "guessing_state" }>,
  ): void {
    this.noteEngagementActivity();
    const apply = () => {
      const wasInGuessing = this.guessingState !== null;
      this.guessingState = {
        dimension: "",
        offeredKeys: msg.suggestionKeys,
        questionHint: msg.text,
        customFacts: (msg.customFacts ?? []).map((f) => ({ ...f })),
        rejectedFacts: (msg.rejectedFacts ?? []).map((f) => ({ ...f })),
      };
      if (!wasInGuessing) {
        this.emitClientEvent({
          type: "guessing_entered",
          source: "client",
          timestamp: Date.now(),
        });
        this.send({ type: "guessing_mode", active: true });
      }
      this.broadcastGuessingStateToAgents();
      void this.invokeBoardManager([]);
    };
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", "legacy guessing_state arrived while resting — waking before broadcasting.");
      void this.transitionToProfile("awake").then(apply);
      return;
    }
    apply();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Word Finder intent handlers. The client sends INTENTS (enter / press /
  // reject / narrow / exit); the server owns the engine state and runs
  // applyPress / applyCustomFact / rejectCurrentDimension. Each handler
  // wakes-from-resting if needed, mutates the engine state, refreshes the
  // snapshot, and broadcasts.
  // ─────────────────────────────────────────────────────────────────────

  /** Run `fn` inside the wake gate + engagement-activity reset that every
   *  guessing-mode intent needs. `label` is for the flow-log on the wake
   *  message. `fn` may be async (e.g. `handleGuessingEnter` awaits the
   *  category seeder before applying it). */
  private async wakeForGuessingIntent(label: string, fn: () => void | Promise<void>): Promise<void> {
    this.noteEngagementActivity();
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", `${label} arrived while resting — waking before applying.`);
      await this.transitionToProfile("awake");
    }
    await fn();
  }

  /**
   * Begin a Word Finder session. If launched from the sentence builder, the
   * builder's active tab pre-selects the top-level category (via
   * `BUILDER_TAB_TO_GUESSING`) so the user skips the "what kind of thing
   * are you looking for?" step. The origin + builderContext are remembered
   * so a builder-origin resolution can feed back into the active slot
   * when guessing ends.
   */
  private handleGuessingEnter(
    msg: Extract<ClientMessage, { type: "guessing_enter" }>,
  ): void {
    void this.wakeForGuessingIntent("guessing_enter", async () => {
      // Seed from what we know about the student: their interests (from monitor
      // memory) personalize the first board + the AI's guesses; their age keeps
      // those guesses age-appropriate. Both are best-effort — absent data just
      // yields the generic, age-agnostic engine.
      const student = dualAgentService.getSessionCache(this.sessionId!)?.monitorAgent.getStudent?.();
      const interests = parseInterestsList((student?.chatMemory as Record<string, any> | undefined)?.Student_Interests);
      const userAge = computeAgeYears((student as any)?.birthDate);
      this.guessingEngineState = createGuessingState(interests, userAge);
      if (msg.builderContext) {
        // Builder origin: the active builder tab maps directly to a
        // top-level category, so we know the right starting point
        // without consulting an LLM. Skip the seeder entirely.
        this.guessingOrigin = "builder";
        this.guessingBuilderContext = msg.builderContext;
        const cat = BUILDER_TAB_TO_GUESSING[msg.builderContext.category];
        if (cat) applyGuessingPress(this.guessingEngineState, CATEGORY_DIM_ID, cat);
      } else {
        // Conversation origin: ask a fast LLM to classify the most
        // recent AI question into one of the 6 predefined categories,
        // a "new" freeform topic, or "unknown". On predefined we
        // pre-press the engine so the first narrowing board lands
        // inside the right category; on "new" we record the topic as
        // a custom fact (so subsequent AI [NARROW:]/[GUESS] buttons
        // have it as context); on "unknown" we leave the engine as
        // is and the user sees the generic category menu.
        this.guessingOrigin = "conversation";
        this.guessingBuilderContext = null;
        await this.applyConversationSeedToGuessingEngine();
      }
      this.refreshGuessingSnapshot(/* firstEntry */ true);
    });
  }

  /** Run the conversation classifier and apply the result to the engine.
   *  Best-effort: any failure (no recent AI question, LLM error, parse
   *  fail) leaves the engine in its initial state, which is correct —
   *  the user just sees the top-level category menu. */
  private async applyConversationSeedToGuessingEngine(): Promise<void> {
    if (!this.guessingEngineState) return;
    const lastAIQuestion = this.findLastAIQuestion();
    if (!lastAIQuestion) {
      flowNote("COORDINATOR", "guessing seeder skipped — no recent AI question to seed from.");
      return;
    }
    const seed = await seedGuessingFromConversation({
      lastAIQuestion,
      onUsage: (usage) => {
        if (!this.sessionId || !this.studentId) return;
        dualAgentService.trackHttpUsage(
          this.sessionId,
          this.studentId,
          this.userId,
          usage.provider,
          usage.model,
          usage.promptTokens,
          usage.completionTokens,
          usage.cachedTokens,
          "guessing-seeder",
        ).catch(err => console.error("[AgentCoordinator] trackHttpUsage(guessing seeder) failed:", err));
      },
    }).catch((err) => {
      flowNote("COORDINATOR", `guessing seeder errored: ${err?.message ?? err}`);
      return null;
    });
    if (!seed) {
      flowNote("COORDINATOR", "guessing seeder returned no result — using top-level menu.");
      return;
    }
    switch (seed.kind) {
      case "predefined":
        flowNote("COORDINATOR", `guessing seeded: category=${seed.category}`);
        applyGuessingPress(this.guessingEngineState, CATEGORY_DIM_ID, seed.category);
        return;
      case "new":
        flowNote("COORDINATOR", `guessing seeded: new topic="${seed.label}"`);
        applyGuessingCustomFact(this.guessingEngineState, "topic", seed.label);
        return;
      case "unknown":
        flowNote("COORDINATOR", "guessing seeded: unknown — using top-level menu.");
        return;
    }
  }

  /** Scan `recentEvents` newest-first for the most recent finalized AI
   *  utterance. Used by the guessing seeder to anchor its classification
   *  on what was just being discussed. */
  private findLastAIQuestion(): string | null {
    for (let i = this.recentEvents.length - 1; i >= 0; i--) {
      const e = this.recentEvents[i];
      if (e.type === "speech_text_finalized" && e.transcript) {
        return e.transcript;
      }
    }
    return null;
  }

  /** A suggestion-key press (e.g. `suggestion:things.kind:animal`). */
  private handleGuessingPress(
    msg: Extract<ClientMessage, { type: "guessing_press" }>,
  ): void {
    if (!this.guessingEngineState) {
      flowNote("COORDINATOR", `guessing_press "${msg.suggestionKey}" dropped — no active session.`);
      return;
    }
    const parsed = parseSuggestionKey(msg.suggestionKey);
    if (!parsed) {
      flowNote("COORDINATOR", `guessing_press dropped — unparseable key "${msg.suggestionKey}".`);
      return;
    }
    // The paired button_press will arrive within milliseconds; the
    // narrowing directive (from refreshGuessingSnapshot below) carries
    // the turn, so the press shouldn't double-fire Speaker.
    this.suppressNextPressUserTurn = true;
    void this.wakeForGuessingIntent("guessing_press", () => {
      if (!this.guessingEngineState) return;
      applyGuessingPress(this.guessingEngineState, parsed.dimension, parsed.value);
      this.refreshGuessingSnapshot(false);
    });
  }

  /** "No" — the offered options don't fit right now. DEFERS (not dismisses)
   *  the current dimension: the engine moves on to a different question and
   *  advances this one's page, so it can return later with answers the user
   *  hasn't seen. Framed positively for the next injection (`lastAction =
   *  "defer"`). Distinct from "More" (page the SAME question's long tail) and
   *  from a genuine fact-undo. Does NOT pop a previously-confirmed positive
   *  fact — that produced the "Known: X" + "Rejected: X" contradiction the
   *  engine used to ship. */
  private handleGuessingReject(): void {
    if (!this.guessingEngineState) {
      flowNote("COORDINATOR", "guessing_reject dropped — no active session.");
      return;
    }
    this.suppressNextPressUserTurn = true;
    void this.wakeForGuessingIntent("guessing_reject", () => {
      if (!this.guessingEngineState) return;
      rejectGuessingDimension(this.guessingEngineState);
      this.refreshGuessingSnapshot(false);
    });
  }

  /** AI-proposed `[NARROW:<dim>] <value>` press — records as a custom
   *  fact on the parallel track. */
  private handleGuessingNarrow(
    msg: Extract<ClientMessage, { type: "guessing_narrow" }>,
  ): void {
    if (!this.guessingEngineState) {
      flowNote("COORDINATOR", `guessing_narrow ${msg.dimension}=${msg.value} dropped — no active session.`);
      return;
    }
    this.suppressNextPressUserTurn = true;
    void this.wakeForGuessingIntent("guessing_narrow", () => {
      if (!this.guessingEngineState) return;
      applyGuessingCustomFact(this.guessingEngineState, msg.dimension, msg.value, msg.sourceText);
      this.refreshGuessingSnapshot(false);
    });
  }

  /**
   * Re-derive the flat `guessingState` snapshot from the engine state and
   * fan it out. On first entry, also emits the `guessing_entered` event
   * and tells the client to flip its `guessingMode` flag. Subsequent
   * refreshes just rebroadcast the latest snapshot to the live agents
   * and trigger a BoardManager rebuild.
   *
   * This is the ONLY path that updates `this.guessingState` —
   * everything else reads it as a derived view of `guessingEngineState`.
   */
  private refreshGuessingSnapshot(firstEntry: boolean): void {
    if (!this.guessingEngineState) return;
    const inj = buildGuessingInjection(this.guessingEngineState);
    this.guessingState = {
      dimension: "",
      offeredKeys: inj.suggestionKeys,
      questionHint: inj.text,
      customFacts: inj.customFacts.map((f) => ({ ...f })),
      rejectedFacts: inj.rejectedFacts.map((f) => ({ ...f })),
    };

    if (firstEntry) {
      // emitClientEvent("guessing_entered") schedules the deferred
      // BoardMgr (see the guessing_entered branch of emitClientEvent);
      // we don't need to invoke BM again here.
      this.emitClientEvent({
        type: "guessing_entered",
        source: "client",
        timestamp: Date.now(),
      });
      this.send({ type: "guessing_mode", active: true });
      this.broadcastGuessingStateToAgents();
      return;
    }

    // Subsequent state refresh (a press / reject / narrow). Broadcast
    // the new state to the live agents and defer BoardMgr so its
    // buttons follow whatever Speaker says next. Empty trigger is
    // fine — renderInvocationContext already labels an empty-trigger
    // invocation with `guessingState` set as "guessing_state_change"
    // in its flow-log summary.
    this.broadcastGuessingStateToAgents();
    this.scheduleDeferredBoardMgr(null, "guessing_state_change");
  }

  /** Single point of exit-guessing cleanup. Clears server state, notifies
   *  the client (so its `guessingMode` / refs clear too), tells the Live
   *  agents that the word-finder closed, and kicks BoardManager so the
   *  board returns to conversation context rather than leaving stale
   *  suggestion buttons on screen. Safe to call when not in guessing
   *  mode — no-op in that case.
   */
  private clearGuessingState(reason: string): void {
    if (!this.guessingState) return;
    flowNote("COORDINATOR", `Clearing guessing state: ${reason}`);
    const aiInitiated = reason.startsWith("ai_exit:");
    this.guessingState = null;
    this.guessingEngineState = null;
    this.guessingOrigin = "conversation";
    this.guessingBuilderContext = null;
    this.send({ type: "guessing_mode", active: false });
    // Tell Speaker the word-finder closed so it switches back to normal
    // conversation framing on its next turn. Skip raw [GUESSING] tags in
    // the directive — native-audio models echo those.
    this.speaker?.sendContextInjection(
      aiInitiated
        ? `The Word Finder is over — you ended it because narrowing converged. Continue the conversation normally about whatever was just resolved. No more narrowing questions.`
        : `The user closed the word-finder. Return to normal conversation — no more narrowing questions.`,
    );
    this.observer?.sendContextInjection(`[GUESSING] Word-finder closed.`);
    this.emitClientEvent({
      type: "guessing_exited",
      source: "client",
      timestamp: Date.now(),
    });
    // Re-trigger BoardManager with an EXPLICIT directive on what to build
    // next. An empty triggers array + a bare [GUESSING EXITED] event in
    // recent_events isn't enough — the model needs to know it's no longer
    // narrowing. Without this hint, recent-events tails of `[YOU]
    // rebuild_board(suggestion:...)` keep nudging the model toward more
    // suggestion buttons and it tends to MALFORMED instead of rebuilding
    // for normal conversation.
    const exitHint: ContextUpdateEvent = {
      type: "context_update",
      source: "observer", // synthetic — sourced from Coordinator on behalf
      timestamp: Date.now(),
      updateType: "other",
      key: "guessing_just_ended",
      description: aiInitiated
        ? `The Word Finder narrowing session just ended (you called exit_guessing: ${reason.replace(/^ai_exit:/, "")}). The user's word/concept has been identified. Rebuild the USER RESPONSE BOARD with a FRESH set of normal SENTENCE BUTTONs for talking about what was just resolved — reactions to the topic, follow-up questions, related things the user might want to say. Do NOT include suggestion:/[NARROW:]/[GUESS] buttons; those are for active narrowing only.`
        : `The Word Finder was just closed by the user (no AI-initiated exit). Rebuild the USER RESPONSE BOARD with a FRESH set of normal SENTENCE BUTTONs appropriate to the current conversation. Do NOT include suggestion:/[NARROW:]/[GUESS] buttons; those are for active narrowing only.`,
    };
    void this.invokeBoardManager([exitHint]);
  }

  /** Push the current guessingState to Speaker (as a directive user_turn)
   *  and Observer (as a context_injection). Called from applyGuessingState
   *  for every state push, and from transitionToProfile on wake when
   *  guessing is active — both Live sessions just reconnected with fresh
   *  prompts and lost the prior [GUESSING STATE] context. Speaker hears
   *  a synthesized natural-language framing (NOT the raw [GUESSING STATE]
   *  text dump) because native-audio models that see structured tags in
   *  their input often echo those tags verbatim in voiced speech.
   */
  private broadcastGuessingStateToAgents(): void {
    if (!this.guessingState) return;
    const s = this.guessingState;
    const muted = this.muteState === "muted";
    const directive = muted
      ? `[GUESSING STATE — muted, do not speak]`
      : this.buildSpeakerGuessingDirective(s);
    this.speakerRespond(directive);
    // Observer gets a brief one-liner — it doesn't need to ask, just to
    // know we're in word-finder mode so its environment scanning frames
    // detected objects as candidate referents.
    this.observer?.sendContextInjection(
      `[GUESSING] Word-finder active. The user is trying to find a specific word. Watch the environment for candidate referents.`,
    );
  }

  /** Convert the structured guessing state into a Speaker-friendly prose
   *  directive. Native-audio models echo whatever shape they see; feeding
   *  them `suggestion:dim:value`/`custom_facts: [...]`/`rejected_facts:`
   *  caused the Speaker to voice those tags. This builder yields plain
   *  English the model can act on directly. */
  private buildSpeakerGuessingDirective(s: GuessingState): string {
    const text = s.questionHint || "";
    const parts: string[] = [];

    // What to ask about (priority: registry's "Suggested next dimension",
    // falling back to a generic prompt when the registry is exhausted or
    // the AI is driving open-ended narrowing).
    const dimMatch = text.match(
      /Suggested next dimension:\s*([a-z_]+)(?:\s*—\s*([^\n]*?))?(?=\s+(?:Offer|Ready|Presses|$))/i,
    );
    const dimensionHint = dimMatch?.[2]?.trim() || dimMatch?.[1]?.trim();
    // The conversation-classifier seeder records a "new"-shaped result
    // as a custom fact with dimension="topic" (engine category stays
    // null — the topic doesn't fit any predefined branch). Surface
    // that topic to Speaker so it asks WITHIN it, instead of falling
    // through to the generic "what kind of thing?" opener.
    const seededTopic = s.customFacts.find((f) => f.dimension === "topic")?.value;
    if (dimensionHint) {
      parts.push(`Voice ONE short, warm question helping the user narrow down: ${dimensionHint}.`);
    } else if (text.includes("No more narrowing dimensions") || text.includes("Ready for guesses: yes")) {
      parts.push(`Voice ONE short, warm guess (or "is it X or Y?") about what the user is trying to say.`);
    } else if (seededTopic && text.includes("No category chosen yet")) {
      parts.push(`The user just opened the word finder. The conversation has been about ${seededTopic} — voice ONE short, warm narrowing question WITHIN that topic.`);
    } else if (text.includes("No category chosen yet")) {
      parts.push(`The user just opened the word finder. Voice ONE short, warm question: "What kind of thing are you thinking of?"`);
    } else {
      parts.push(`Voice ONE short, warm narrowing question to help the user find their word.`);
    }
    parts.push(`Don't list the options — the buttons appear on screen.`);

    // Known facts (registry-confirmed, prose form).
    const knownMatch = text.match(/^Known:\s*(.+)$/m);
    if (knownMatch) {
      parts.push(`What we know so far: ${knownMatch[1]}.`);
    }

    // Custom narrowing facts the AI already established with the user.
    if (s.customFacts.length) {
      const formatted = s.customFacts.map((f) => `${f.dimension} = ${f.value}`).join(", ");
      parts.push(`The user already confirmed: ${formatted}.`);
    }

    // Rejected facts — the user just said "no" to something. Pivot.
    if (s.rejectedFacts.length) {
      const formatted = s.rejectedFacts.map((f) => `${f.dimension} = ${f.value}`).join(", ");
      parts.push(`The user rejected: ${formatted}. Do NOT ask about those again — pivot to a different angle.`);
    } else if (text.includes("none of these")) {
      parts.push(`The user just said "none of these" to the last batch. Try a fresh angle or a [GUESS].`);
    }

    return parts.join(" ");
  }

  // Route a client-originated event to the agents per the spec table.
  private emitClientEvent(event:
    | ButtonPressedEvent
    | SentenceComposedEvent
    | MuteToggledEvent
    | BuilderOpenedEvent
    | BuilderClosedEvent
    | GuessingEnteredEvent
    | GuessingExitedEvent,
  ): void {
    this.recordEvent(event);

    // A real user action (button press, composed sentence, builder open)
    // must wake the session before routing. Otherwise Speaker, still on
    // the resting profile, receives the user_turn and stays silent until
    // Observer eventually notices and calls wake_up — sometimes 10+
    // seconds after the press, by which point the press is dead.
    const wakeRequired =
      this.sessionProfile === "resting" &&
      (event.type === "button_pressed" ||
        event.type === "sentence_composed" ||
        event.type === "builder_opened");
    if (wakeRequired) {
      flowNote("COORDINATOR", `User action ${event.type} arrived while resting; waking before routing.`);
      void this.transitionToProfile("awake").then(() => {
        this.routeClientEvent(event);
      });
      return;
    }

    this.routeClientEvent(event);
  }

  /** Inner half of emitClientEvent — the actual fan-out. Split out so
   *  the wake-up gate can defer it until the awake profile is live. */
  private routeClientEvent(event:
    | ButtonPressedEvent
    | SentenceComposedEvent
    | MuteToggledEvent
    | BuilderOpenedEvent
    | BuilderClosedEvent
    | GuessingEnteredEvent
    | GuessingExitedEvent,
  ): void {
    switch (event.type) {
      case "button_pressed": {
        this.lastUserInputType = "button_pressed";
        // User just acted — this is conversation engagement. Reset the
        // rest debounce window and cancel any pending rest request.
        this.noteEngagementActivity();
        // Target comes from the loaded board's target if the event didn't
        // carry one (synthetic home presses set their own). In facilitator mode
        // a target-less press is an aside to the person nearby — the Speaker
        // stays quiet rather than replying as if addressed. See press-target.ts.
        const { toDevice, targetLabel } = resolvePressRouting({
          eventTarget: event.target,
          boardTarget: this.currentBoardTarget,
          mode: this.currentInteractionMode,
          socialPeer: !!this.socialPeer,
          aiNames: [this.aiName],
        });

        // A button press is functionally a USER statement — the press
        // is just the mechanism. Speaker and BoardManager see it as
        // `[USER to <target>] "..."` so it slots into the same
        // "someone said something" mental model as a transcript.
        // Observer keeps the explicit `[BUTTON PRESS to <target>]`
        // marker because it's the agent that records HOW statements
        // were made.
        const pressInner = T.tagPress.replace(/^\[|\]$/g, "");
        // A gesture-triggered press keeps the same statement shape but is
        // marked so agents know HOW it was made (and Observer can tie it
        // back to its own report_gesture call).
        const observerRendered = event.via === "gesture"
          ? `[GESTURE "${event.gestureName}" voiced to ${targetLabel}] "${event.sentence}"`
          : `[${pressInner} to ${targetLabel}] "${event.sentence}"`;
        const speakerRendered = event.via === "gesture"
          ? `[USER to ${targetLabel} via gesture] "${event.sentence}"`
          : `[USER to ${targetLabel}] "${event.sentence}"`;

        this.observer?.sendContextInjection(observerRendered);
        // A guessing-mode narrowing press (suggestion: / [NARROW:] /
        // "no") ALSO fires its own guessing_* intent, which triggers
        // refreshGuessingSnapshot → broadcastGuessingStateToAgents and
        // sends Speaker the narrowing directive. Without suppression
        // Speaker responds twice: once to the press, once to the
        // directive. The intent handler sets suppressNextPressUserTurn
        // immediately on arrival; we consume it here. A 1:1 pairing of
        // guessing intent + button_press is guaranteed by the client
        // (both fire from the same handler), so single-shot is safe.
        // (Can't infer "is this a narrowing press?" from button data —
        // suggestion buttons render the English labelEn server-side
        // but the press arrives with the localized label, so a
        // label-match misses every time.)
        const suppressUserTurn = this.suppressNextPressUserTurn;
        this.suppressNextPressUserTurn = false;

        if (toDevice) {
          if (suppressUserTurn) {
            // Speaker just gets context — the narrowing directive
            // already on its way (from refreshGuessingSnapshot) is the
            // single turn-driving signal.
            this.speaker?.sendContextInjection(speakerRendered);
            flowNote(
              "COORDINATOR",
              `narrowing-press "${event.label}" → Speaker context only (directive drives turn).`,
            );
          } else if (this.socialPeer) {
            // SOCIAL TRAINER (Phase B): a BID fires the peer's turn now
            // (combining any buffered reply); a REPLY shows a follow-up board
            // and holds the peer's turn briefly so the user can chain a bid.
            this.handleSocialTrainerPress(event);
          } else {
            // COMPANION (unchanged): press addressed to the AI — Speaker
            // responds; defer the BM (Speaker's reply triggers REPLIES, with
            // the timer as a fallback).
            this.speakerRespond(speakerRendered);
            this.scheduleDeferredBoardMgr(event, "press");
          }
        } else {
          // Press addressed to someone else (or USER itself) — Speaker stays
          // quiet, no REPLIES event coming.
          this.speaker?.sendContextInjection(speakerRendered);
          if (this.currentInteractionMode === "facilitator" && !this.socialPeer) {
            // FACILITATOR (Phase B): a REPLY shows follow-ups now; a BID hands
            // the turn to the human, so wait before offering a fresh board.
            this.handleFacilitatorPress(event);
          } else {
            // Default (e.g. companion press to USER) — build FOLLOW-UPS now.
            this.invokeBoardManager([event]);
          }
        }
        this.appendToConversationLog("user", speakerRendered);
        return;
      }
      case "sentence_composed": {
        this.lastUserInputType = "sentence_composed";
        this.noteEngagementActivity();
        const rendered = `[${T.tagComposed}] "${event.sentence}"`;
        this.observer?.sendContextInjection(rendered);
        // Speaker gets this as CONTEXT, not a user_turn. The composed
        // glyph string is not what the user is "saying" — BoardManager
        // interprets it via interpret() into natural language, the
        // student TTS voices the interpretation, and then Speaker
        // receives a synthetic [BUTTON PRESS] turn with the natural
        // language to respond to. Sending Speaker the raw glyph string
        // as a user_turn here would make it respond to symbol notation
        // directly, skipping the interpretation entirely.
        this.speaker?.sendContextInjection(rendered);
        this.invokeBoardManager([event]);
        this.appendToConversationLog("user", rendered);
        return;
      }
      case "mute_toggled": {
        const rendered = `[MUTE TOGGLED] now ${event.state}`;
        this.observer?.sendContextInjection(rendered);
        // The peer persona has no mute concept — don't leak device state.
        if (!this.socialPeer) this.speaker?.sendContextInjection(rendered);
        this.invokeBoardManager([event]);
        return;
      }
      case "builder_opened":
      case "builder_closed":
      case "guessing_exited": {
        const rendered = `[${event.type.toUpperCase().replace(/_/g, " ")}]`;
        this.observer?.sendContextInjection(rendered);
        this.speaker?.sendContextInjection(rendered);
        this.invokeBoardManager([event]);
        return;
      }
      case "guessing_entered": {
        // Word Finder just opened. Notify both live agents — Speaker
        // will get a follow-up user_turn directive with the actual
        // narrowing question via broadcastGuessingStateToAgents — and
        // DEFER BoardMgr so its buttons match whatever Speaker decides
        // to ask aloud. The defer is cleared by
        // onSpeakerSpeechTextFinalized, which invokes BM with the
        // speech as context. If Speaker stays silent, the 4s timer
        // fires BM with the guessing_entered event alone.
        const rendered = `[${event.type.toUpperCase().replace(/_/g, " ")}]`;
        this.observer?.sendContextInjection(rendered);
        this.speaker?.sendContextInjection(rendered);
        this.scheduleDeferredBoardMgr(event, "guessing_entered");
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Observer → bus
  // -------------------------------------------------------------------------

  private onObserverEvent(event: ObserverOutputEvent): void {
    // Observer hallucination guard: discard speech transcripts that arrive with
    // no audio consumed recently (mic off / muted / not streaming). A fabricated
    // transcript must never reach the event bus, any agent, the caption, or the
    // board — but we DO surface it in the debug feed so the hallucination stays
    // visible while diagnosing. Gate BEFORE recordEvent so it doesn't pollute
    // recentEvents (which the Board Manager and session snapshot consume).
    if (event.type === "transcribed" && this.isTranscriptAudioStale()) {
      this.discardHallucinatedTranscript(event);
      return;
    }

    this.recordEvent(event);
    this.logEvent("OBSERVER", event);

    switch (event.type) {
      case "transcribed":
        // A worthwhile transcript resets the low-band sleep timer (the Observer
        // is actively working an in-person exchange — don't sleep out from under it).
        this.noteObservationActivity();
        this.routeTranscribed(event);
        return;
      case "context_update":
        this.noteObservationActivity();
        this.enqueueContextUpdate(event);
        return;
      case "engagement_change":
        this.routeEngagementChange(event);
        return;
      case "focus_request":
        this.routeFocusRequest(event);
        return;
      case "audio_request":
        this.routeAudioRequest(event);
        return;
      case "attention_change":
        this.setAttention(event.modality, event.level, event.reason);
        return;
      case "observation_mode_change":
        this.handleObservationModeChange(event);
        return;
      case "gesture_recognized":
        void this.handleGestureRecognized(event);
        return;
      case "mode_change":
        // Observer owns the interact/assist switch in the three-agent
        // path — it has the camera/mic context to judge whether the
        // user is conversing with the AI or with someone in the room.
        // Coordinator persists currentInteractionMode and forwards the
        // resulting [MODE] context injection to Speaker.
        this.routeModeChange(event);
        return;
      case "alarm_raised":
        this.routeAlarm(event);
        return;
      case "monitor_call_requested":
        this.requestMonitor(event.reason, "observer");
        return;
      case "private_note":
        // Already in Observer's own history via the tool-call ack.
        // Per user feedback: echo back is fine; agent retains action log.
        this.observer?.sendContextInjection(`[PRIVATE NOTE] (you noted) ${event.note}`);
        return;
    }
  }

  /** True when no client audio has been consumed within the hallucination-guard
   *  window — i.e. the Observer is effectively "hearing" nothing, so any
   *  transcript it emits is fabricated. */
  private isTranscriptAudioStale(): boolean {
    return Date.now() - this.lastAudioInputAt > OBSERVER_TRANSCRIPT_AUDIO_GATE_MS;
  }

  /** A transcript arrived without recently-consumed audio — drop it from all
   *  routing (no agent, caption, or board) and surface it in the client debug
   *  feed + admin log instead. */
  private discardHallucinatedTranscript(event: TranscribedEvent): void {
    const sinceAudio = this.lastAudioInputAt === 0 ? null : Date.now() - this.lastAudioInputAt;
    const ago = sinceAudio === null ? "no audio this session" : `${sinceAudio}ms since last audio`;
    flowNote("COORDINATOR", `Discarded Observer transcript (${ago}): [${event.speaker}] "${event.text}"`);
    this.logEvent("OBSERVER(discarded)", event);
    if (this.debugMode) {
      this.send({
        type: "debug",
        data: {
          last_transcript: {
            speaker: event.speaker,
            text: event.text,
            timestamp: Date.now(),
            discarded: true,
            reason: "no recent audio",
          },
        },
      });
    }
  }

  /**
   * Cost saving (Phase 1): handle an on-device transcript of a heard speech
   * segment. Instead of the Observer transcribing streamed audio, the client
   * did it locally; we feed the text as a turn-completing message so the
   * Observer still makes its who/whom judgment and routes via transcript() —
   * at text cost, and without audio re-billing in the context window.
   * See planning-docs/aac-cost-saving-spec.md §1.
   */
  private handleSpeechText(msg: Extract<ClientMessage, { type: "speech_text" }>): void {
    // Whisper path (on-device transcript). Kept as plumbing; the active engine
    // is server-side Google STT (handleSpeechAudio). See aac-cost-saving-spec §1.
    this.injectHeardSpeech(msg.text, msg.confidence, msg.voiceDescriptor, msg.clipId, "speech_text");
  }

  /**
   * Active STT path: the client sends a VAD-gated speech CLIP, we transcribe it
   * server-side via Google Cloud STT (accurate + low latency, no device freeze),
   * then inject it like any heard speech. Far cheaper than the Gemini-Live audio
   * re-billing it replaces. Language comes from the client (student's locale).
   */
  private async handleSpeechAudio(msg: Extract<ClientMessage, { type: "speech_audio" }>): Promise<void> {
    if (!msg.data) return;
    const buf = Buffer.from(msg.data, "base64");
    const seconds = estimateWavSeconds(buf);
    // Record EVERY clip that arrives for STT in the flow log — even when STT
    // returns nothing — so "did the audio reach the server?" is answerable.
    flowInput("CLIENT", "speech_audio", `→STT ${seconds.toFixed(1)}s ${(buf.length / 1024).toFixed(0)}KB lang=${msg.language ?? "?"}${msg.lipActivity?.length ? ` lips=${msg.lipActivity.length}` : ""}`);
    let text = "";
    try {
      // Inject session context (known names + on-screen vocab) as phrase hints so
      // STT biases toward the words actually likely here — the proper nouns and
      // AAC vocab it otherwise mis-hears without Gemini's contextual fill-in.
      const speechContexts = await this.buildSpeechContexts().catch(() => undefined);
      // Short conversational turns → the short-utterance model (more accurate +
      // lower latency than latest_long on turn-sized clips).
      const { segments } = await transcribeSegments(buf, { languageHint: msg.language, speechContexts, model: "latest_short" });
      text = segments.map(s => s.text).join(" ").replace(/\s+/g, " ").trim();
      // Bill the actual speech duration (cheap — only the clip, not wall-clock).
      if (this.sessionId && this.studentId && seconds > 0) {
        void dualAgentService.trackSttUsage(this.sessionId, this.studentId, this.userId, seconds);
      }
      flowNote("COORDINATOR", text ? `STT transcribed: "${text.slice(0, 160)}"` : `STT empty — no speech recognized in ${seconds.toFixed(1)}s clip`);
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        logLiveSession("SPEECH_AUDIO → STT", `lang=${msg.language ?? "?"} ${seconds.toFixed(1)}s → "${text.slice(0, 120)}"`);
      });
    } catch (err) {
      flowNote("COORDINATOR", `STT ERROR: ${(err as Error).message}`);
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        logLiveSession("STT_ERROR", (err as Error).message);
      });
      return;
    }
    // Two-tier attribution. FAST: the cheap pitch fingerprint rode WITH this clip
    // (msg.acoustic), so combined with lip-sync we give the Observer an instant
    // read now. SLOW: the full voice embedding arrives separately (parallel, same
    // clipId) and updates [VOICES HEARD] + learning in the BACKGROUND. Neither
    // blocks the other. With no clipId, do both inline from this message.
    if (!msg.clipId) {
      this.doFastSpeechRead(text, msg.acoustic, msg.lipActivity, undefined);
      if (msg.voiceDescriptor) await this.doSlowSpeechRead(msg.voiceDescriptor, msg.acoustic, msg.lipActivity);
      return;
    }
    this.recordSpeechText(msg.clipId, text, msg.lipActivity, msg.acoustic, msg.voiceDescriptor);
  }

  /** A clip's STT text (+ pitch + lip) arrived — fire the FAST read immediately;
   *  also run the SLOW read if its embedding is already in. The entry persists so
   *  a later embedding can still do the slow pass. */
  private recordSpeechText(
    clipId: string,
    text: string,
    lipActivity: LipFace[] | undefined,
    acoustic: Acoustic | undefined,
    inlineVoice?: { embedding: number[]; quality?: number },
  ): void {
    const e = this.pendingSpeech.get(clipId) ?? {};
    e.text = text;
    // Merge, don't clobber: the streaming path delivers lip/acoustic separately
    // (speech_meta) BEFORE the transcript, so only overwrite when provided.
    if (lipActivity !== undefined) e.lipActivity = lipActivity;
    if (acoustic !== undefined) e.acoustic = acoustic;
    if (inlineVoice) e.voice = inlineVoice;
    this.pendingSpeech.set(clipId, e);
    if (text && !e.fastDone) { e.fastDone = true; this.doFastSpeechRead(text, e.acoustic, e.lipActivity, clipId); }
    if (e.voice && !e.slowDone) { e.slowDone = true; void this.doSlowSpeechRead(e.voice, e.acoustic, e.lipActivity); }
    this.cleanupOrReap(clipId, e);
  }

  /** A clip's parallel voice embedding arrived — run the SLOW (background) read.
   *  If the text is in but the fast read somehow didn't fire, fire it. */
  private recordVoiceForClip(clipId: string, voice: { embedding: number[]; quality?: number }): void {
    const e = this.pendingSpeech.get(clipId) ?? {};
    e.voice = voice;
    this.pendingSpeech.set(clipId, e);
    if (e.text && !e.fastDone) { e.fastDone = true; this.doFastSpeechRead(e.text, e.acoustic, e.lipActivity, clipId); }
    if (!e.slowDone) { e.slowDone = true; void this.doSlowSpeechRead(voice, e.acoustic, e.lipActivity); }
    this.cleanupOrReap(clipId, e);
  }

  /** Clear the entry once both tiers fire; otherwise arm a reap timer so a
   *  half-arrived clip can't leak the map. */
  private cleanupOrReap(clipId: string, e: PendingSpeechEntry): void {
    if (e.fastDone && e.slowDone) {
      if (e.timer) clearTimeout(e.timer);
      this.pendingSpeech.delete(clipId);
      return;
    }
    if (!e.timer) {
      e.timer = setTimeout(() => this.pendingSpeech.delete(clipId), AgentCoordinator.SPEECH_SYNC_TIMEOUT_MS * 8);
    }
  }

  /** FAST tier: inject the [HEARD SPEECH] turn with an immediate, provisional
   *  [SPEAKER LIKELIHOOD] from pitch + lip-sync — no embedding required. */
  private doFastSpeechRead(
    text: string,
    acoustic: Acoustic | undefined,
    lipActivity: LipFace[] | undefined,
    clipId: string | undefined,
  ): void {
    if (!text) return;
    // Build the provisional line (pitch profiles are cached, so this is quick),
    // then inject. Always inject even if the line is empty/failed.
    void this.buildFastSpeakerLikelihood(acoustic, lipActivity)
      .catch(() => "")
      .then(line => this.injectHeardSpeech(text, 0.9, undefined, clipId, "speech_audio", line || undefined));
  }

  /** SLOW tier (background): the full voice embedding. Refresh [VOICES HEARD] +
   *  stash the pending sample (with pitch) for Observer-gated learning, and apply
   *  the lip-sync correction. Does NOT re-inject a turn — it firms up attribution
   *  for subsequent turns and accumulates confidence over time. */
  private async doSlowSpeechRead(
    voice: { embedding: number[]; quality?: number },
    acoustic: Acoustic | undefined,
    lipActivity: LipFace[] | undefined,
  ): Promise<void> {
    if (!voice?.embedding || !this.studentId) return;
    await this.recognizeVoices([{ embedding: voice.embedding, quality: voice.quality }], acoustic?.pitchHz ?? undefined, acoustic?.formantDispersion ?? undefined)
      .catch(err => runInSessionContext(this.sessionId || "?", this.debugMode, () => logLiveSession("VOICE_RECOGNITION_ERROR", (err as Error).message)));
    try {
      const fused = await this.buildSpeakerLikelihood(voice, lipActivity);
      this.applyLipConfirmedVoiceFeedback(fused.voiceMatch, fused.ranked, voice);
    } catch { /* attribution correction is non-critical */ }
  }

  /**
   * FAST [SPEAKER LIKELIHOOD]: match the heard pitch to each known person's pitch
   * profile, fuse with lip-sync, render as a PROVISIONAL line. This is the
   * pre-embedding read — cheap and immediate. Returns "" when there's nothing to
   * say (no lip evidence and no pitch candidate). See shared/aac/voice-pitch.ts.
   */
  private async buildFastSpeakerLikelihood(
    acoustic: Acoustic | undefined,
    lipActivity: LipFace[] | undefined,
  ): Promise<string> {
    if (!this.studentId) return "";
    const lipFaces = lipActivity ?? [];
    const profiles = await this.getCachedPitchProfiles();
    const voiceCandidates = matchPitch(acoustic?.pitchHz ?? null, profiles, acoustic?.formantDispersion ?? null);
    const character = describeVoiceCharacter(acoustic?.pitchHz ?? null, acoustic?.formantDispersion ?? null);
    if (!lipFaces.length && !voiceCandidates.length && !character) return "";
    const identifiedFaces: IdentifiedFaceLite[] = this.currentIdentifiedFaces
      .filter(f => f.matched && f.boundingBox)
      .map(f => ({ entityId: f.entityId, name: f.name, bbox: f.boundingBox! }));
    const ranked = fuseSpeakerLikelihood({ voiceCandidates, identifiedFaces, lipFaces });
    let line = renderSpeakerLikelihood(ranked, true);
    // Append the coarse age/gender hint ONLY when no one is confidently named —
    // it's for GUESSING an unidentified speaker, redundant for a known one.
    const confidentlyNamed = ranked.some(r =>
      r.name !== "unidentified visible speaker" && !r.ruledOut && r.likelihood >= 0.6);
    if (character && !confidentlyNamed) {
      const note = `voice sounds like ${character}`;
      line = line ? `${line} | ${note}` : `[SPEAKER LIKELIHOOD: provisional] ${note}`;
    }
    return line;
  }

  /** Per-person pitch profiles for the fast read, cached per session. */
  private async getCachedPitchProfiles(): Promise<VoicePitchProfile[]> {
    if (!this.studentId) return [];
    if (this.pitchProfiles && Date.now() - this.pitchProfilesAt < AgentCoordinator.PITCH_PROFILE_TTL_MS) {
      return this.pitchProfiles;
    }
    this.pitchProfiles = await getVoicePitchProfiles(this.studentId).catch(() => []);
    this.pitchProfilesAt = Date.now();
    return this.pitchProfiles;
  }

  /** Names of known people (+ relationships) as STT phrase hints. Proper nouns
   *  are exactly what STT mis-hears with no context, so this is the highest-value
   *  hint. Cached per session (DB read). */
  private async getKnownNamePhrases(): Promise<string[]> {
    if (!this.studentId) return [];
    if (this.knownNamePhrases && Date.now() - this.knownNamePhrasesAt < AgentCoordinator.PITCH_PROFILE_TTL_MS) {
      return this.knownNamePhrases;
    }
    const out: string[] = [];
    try {
      for (const p of await getKnownPeopleForStudent(this.studentId)) {
        if (p.name) out.push(p.name);
        if (p.relationship) out.push(p.relationship);
      }
    } catch { /* names are best-effort */ }
    this.knownNamePhrases = out;
    this.knownNamePhrasesAt = Date.now();
    return out;
  }

  /** Names of people identified RIGHT NOW (fresh face or voice match) — the
   *  people most likely to actually be spoken about/to. */
  private presentIdentifiedNames(): string[] {
    const out: string[] = [];
    const now = Date.now();
    if (now - this.currentIdentifiedFacesAt <= AgentCoordinator.IDENTIFIED_FACES_TTL_MS) {
      for (const f of this.currentIdentifiedFaces) if (f.matched && f.name) out.push(f.name);
    }
    if (now - this.currentIdentifiedVoicesAt <= AgentCoordinator.IDENTIFIED_VOICES_TTL_MS) {
      for (const v of this.currentIdentifiedVoices) if (v.matched && v.name) out.push(v.name);
    }
    return out;
  }

  /**
   * Build STT speech-adaptation hints from session context, boosted by how
   * likely each word is HERE, now. Tiers (highest first; a name only appears in
   * its highest tier):
   *   1. The active user — the student (always, identified or not) + the AI's
   *      name. These are near-certain to come up. (boost 20)
   *   2. People identified present right now (face/voice match). (boost 17)
   *   3. The rest of the known-people roster + relationships. (boost 12)
   *   4. On-screen board vocabulary. (boost 9)
   * Bounded + de-duped (across tiers) so we bias toward the relevant words.
   */
  private async buildSpeechContexts(): Promise<Array<{ phrases: string[]; boost?: number }>> {
    return this.assembleSpeechContexts(await this.getKnownNamePhrases());
  }

  /** Synchronous variant for opening a streaming session without an await (so no
   *  audio chunk races the session). Uses the CACHED known-names (empty until
   *  warmed — names then kick in from the next utterance); warms it for next time. */
  private buildSpeechContextsSync(): Array<{ phrases: string[]; boost?: number }> {
    if (!this.knownNamePhrases) void this.getKnownNamePhrases(); // warm for next time
    return this.assembleSpeechContexts(this.knownNamePhrases ?? []);
  }

  /** Assemble the boost-tiered phrase groups from a (possibly cached) roster. */
  private assembleSpeechContexts(roster: string[]): Array<{ phrases: string[]; boost?: number }> {
    const hasLetter = (s: string) => /\p{L}/u.test(s);
    const used = new Set<string>(); // lowercase dedup — keeps each name in its highest tier
    const out: Array<{ phrases: string[]; boost?: number }> = [];
    const addGroup = (vals: Iterable<string>, boost: number, max: number) => {
      const phrases: string[] = [];
      for (const raw of vals) {
        const v = raw.trim();
        if (v.length < 2 || v.length > 80 || !hasLetter(v)) continue;
        const k = v.toLowerCase();
        if (used.has(k)) continue;
        used.add(k);
        phrases.push(v);
        if (phrases.length >= max) break;
      }
      if (phrases.length) out.push({ phrases, boost });
    };

    const top: string[] = [];
    if (this.currentStudentName && this.currentStudentName !== "the user") top.push(this.currentStudentName);
    if (this.aiName) top.push(this.aiName);
    addGroup(top, 20, 8);                          // 1. active user + AI
    addGroup(this.presentIdentifiedNames(), 17, 20); // 2. people present now
    addGroup(roster, 12, 120);                     // 3. rest of known roster
    addGroup(this.currentBoardLabels, 9, 60);      // 4. on-screen vocabulary
    return out;
  }

  // -------------------------------------------------------------------------
  // Streaming STT (Web-Speech-like): one Cloud STT streamingRecognize session
  // per utterance, fed VAD-gated PCM as the person speaks. Transcript is ready
  // at speech-end and flows into the same pendingSpeech fast/slow fusion.
  // -------------------------------------------------------------------------
  private sttStreams = new Map<string, { session: SttStreamSession; bytes: number; chunks: number; firedAny: boolean; language?: string; interimSentAt: number; interimLoggedAt: number }>();
  /** Min gap between transcript_interim pushes to the client (rolling text —
   *  dropping intermediate revisions loses nothing; a final always follows). */
  private static readonly STT_INTERIM_SEND_MS = 250;
  /** Min gap between interim debug breadcrumbs — enough to prove WHEN words
   *  were available vs when they finalized (endpointer lag) without flooding. */
  private static readonly STT_INTERIM_LOG_MS = 5000;

  private startSttStream(streamId: string, language?: string): void {
    if (this.sttStreams.has(streamId)) return;
    try {
      const session = createStreamingSession({
        languageHint: language,
        model: "latest_short",
        speechContexts: this.buildSpeechContextsSync(),
        // Commit each phrase the MOMENT the recognizer finalizes it (mid-stream),
        // rather than waiting for the client's end-of-speech. Web-Speech-like.
        onFinal: (seg) => this.onSttStreamFinal(streamId, seg),
        // Live caption: rolling interims → grey client text, so words are on
        // screen ~1s after they're spoken even when the endpointer sits on the
        // final (continuous room noise starves it). No extra STT cost.
        onInterim: (text) => this.onSttStreamInterim(streamId, text),
        onError: (m) => flowNote("COORDINATOR", `STT stream error [${streamId.slice(0, 8)}]: ${m}`),
        onRotate: (why) => flowNote("COORDINATOR", `STT stream rotated [${streamId.slice(0, 8)}]: ${why}`),
      });
      this.sttStreams.set(streamId, { session, bytes: 0, chunks: 0, firedAny: false, language, interimSentAt: 0, interimLoggedAt: 0 });
      flowInput("CLIENT", "stt_stream_start", `streamId=${streamId.slice(0, 8)} lang=${language ?? "?"}`);
    } catch (err) {
      runInSessionContext(this.sessionId || "?", this.debugMode, () => logLiveSession("STT_STREAM_ERROR", `start: ${(err as Error).message}`));
    }
  }

  /** Rolling (non-final) recognizer text — throttle and surface as the live
   *  grey caption, plus a sparse debug breadcrumb for latency forensics. */
  private onSttStreamInterim(streamId: string, text: string): void {
    const s = this.sttStreams.get(streamId);
    const t = (text || "").trim();
    if (!s || !t) return;
    const now = Date.now();
    if (now - s.interimSentAt >= AgentCoordinator.STT_INTERIM_SEND_MS) {
      s.interimSentAt = now;
      // Tail-clip long rolling text — the caption shows what's being said NOW.
      this.send({ type: "transcript_interim", data: t.length > 160 ? `…${t.slice(-160)}` : t });
    }
    if (now - s.interimLoggedAt >= AgentCoordinator.STT_INTERIM_LOG_MS) {
      s.interimLoggedAt = now;
      flowNote("COORDINATOR", `STT interim [${streamId.slice(0, 8)}] → "${t.slice(-80)}"`);
    }
  }

  private sttStreamWrite(streamId: string, dataBase64: string): void {
    const s = this.sttStreams.get(streamId);
    if (!s) return;
    if (!dataBase64) return; // empty chunk — nothing to feed
    // write() is false when the chunk was dropped (failed stream throttling
    // its recovery) — don't count it toward the billed audio duration.
    if (!s.session.write(dataBase64)) return;
    s.bytes += Math.floor((dataBase64.length * 3) / 4); // approx decoded bytes
    s.chunks += 1;
  }

  /** A phrase finalized mid-stream — inject it as a [HEARD SPEECH] turn NOW.
   *  Speaker attribution rides on [VOICES HEARD] (from the parallel voice
   *  embedding) rather than waiting for an end-of-speech fusion. */
  private onSttStreamFinal(streamId: string, segment: string): void {
    const s = this.sttStreams.get(streamId);
    const text = (segment || "").trim();
    if (!text) return;
    if (s) s.firedAny = true;
    // Phrase committed — clear the grey interim caption (the client falls back
    // to the last routed yellow transcript; if this phrase is user-targeted a
    // fresh one follows once the Observer routes it).
    this.send({ type: "transcript_interim", data: "" });
    flowNote("COORDINATOR", `STT stream final [${streamId.slice(0, 8)}] → "${text.slice(0, 120)}"`);
    this.injectHeardSpeech(text, 0.9, undefined, streamId, "stt_stream");
  }

  private async endSttStream(streamId: string, acoustic?: Acoustic, lipActivity?: LipFace[]): Promise<void> {
    const s = this.sttStreams.get(streamId);
    if (!s) return;
    this.sttStreams.delete(streamId);
    let text = "";
    try { text = await s.session.end(); } catch { /* resolves empty */ }
    const seconds = s.bytes / 2 / 16000; // Int16 mono 16kHz
    if (this.sessionId && this.studentId && seconds > 0.2) {
      void dualAgentService.trackSttUsage(this.sessionId, this.studentId, this.userId, seconds);
    }
    flowNote("COORDINATOR", `STT stream end: chunks=${s.chunks} ${seconds.toFixed(1)}s fired=${s.firedAny}${text && !s.firedAny ? ` → "${text.slice(0, 120)}"` : ""}`);
    // If the recognizer never emitted a mid-stream final (short clip / it only
    // finalized at close), inject the full transcript now as the fallback.
    if (!s.firedAny && text) this.injectHeardSpeech(text, 0.9, undefined, streamId, "stt_stream");
    // Stash the lip/acoustic evidence so the parallel voice embedding
    // (voice_descriptors[streamId] → slow read) can still do the lip-confirmed
    // gallery correction. The transcript itself already fired above.
    if (lipActivity !== undefined || acoustic !== undefined) {
      const e = this.pendingSpeech.get(streamId) ?? {};
      if (lipActivity !== undefined) e.lipActivity = lipActivity;
      if (acoustic !== undefined) e.acoustic = acoustic;
      this.pendingSpeech.set(streamId, e);
      this.cleanupOrReap(streamId, e);
    }
  }

  /** Abort any open streaming-STT sessions (on sleep / session close) so a
   *  stream that never got its stt_stream_end can't leak a gRPC connection.
   *  Bill the audio already streamed first — Google charges for it regardless. */
  private abortSttStreams(): void {
    for (const s of this.sttStreams.values()) {
      const seconds = s.bytes / 2 / 16000;
      if (this.sessionId && this.studentId && seconds > 0.2) {
        void dualAgentService.trackSttUsage(this.sessionId, this.studentId, this.userId, seconds);
      }
      try { s.session.abort(); } catch { /* noop */ }
    }
    this.sttStreams.clear();
  }

  /**
   * Correlate the voice match (embedding) with lip-sync (which visible faces'
   * mouths were moving) → a ranked [SPEAKER LIKELIHOOD] line. Returns "" when
   * there's nothing to say. See shared/aac/speaker-fusion.ts.
   */
  private async buildSpeakerLikelihood(
    voiceDescriptor: { embedding: number[]; quality?: number } | undefined,
    lipActivity: LipFace[] | undefined,
  ): Promise<{ line: string; ranked: SpeakerLikelihood[]; voiceMatch: VoiceMatchResult | null }> {
    const empty = { line: "", ranked: [] as SpeakerLikelihood[], voiceMatch: null };
    if (!this.studentId) return empty;
    const lipFaces = lipActivity ?? [];
    // No visual evidence and no voice → nothing to fuse.
    if (!lipFaces.length && !voiceDescriptor) return empty;

    const voiceCandidates: VoiceCandidate[] = [];
    let voiceMatch: VoiceMatchResult | null = null;
    if (voiceDescriptor?.embedding) {
      voiceMatch = await findMatchingVoice(voiceDescriptor.embedding, this.studentId).catch(() => null);
      if (voiceMatch && voiceMatch.matched) {
        voiceCandidates.push({ entityId: voiceMatch.entityId, name: voiceMatch.name, similarity: voiceMatch.similarity ?? voiceMatch.confidence });
      }
    }

    // Identified faces we currently see (with boxes), for IoU correlation.
    const identifiedFaces: IdentifiedFaceLite[] = this.currentIdentifiedFaces
      .filter(f => f.matched && f.boundingBox)
      .map(f => ({ entityId: f.entityId, name: f.name, bbox: f.boundingBox! }));

    const ranked = fuseSpeakerLikelihood({ voiceCandidates, identifiedFaces, lipFaces });
    return { line: renderSpeakerLikelihood(ranked), ranked, voiceMatch };
  }

  /**
   * Lip-sync → voice-gallery feedback (CORRECTIVE only). Growth is gated behind
   * Observer verification, so a moving mouth no longer auto-enrolls the sample —
   * the lip verdict instead feeds the Observer via [SPEAKER LIKELIHOOD], and the
   * Observer's confirmation is what commits learning. But CONTRADICTION is still
   * acted on immediately: when the voice "matched" a person whose mouth was
   * visibly NOT moving, the gallery entry that fired is suspect, so we penalize
   * it (gradual; evicts only at the floor). Penalizing a wrong sample doesn't
   * self-reinforce — it corrects — so it stays automatic. No-op when STT is off.
   */
  private applyLipConfirmedVoiceFeedback(
    voiceMatch: VoiceMatchResult | null,
    ranked: SpeakerLikelihood[],
    voiceDescriptor: { embedding: number[]; quality?: number } | undefined,
  ): void {
    if (!voiceMatch || !voiceMatch.matched || !voiceMatch.entityId || !voiceDescriptor?.embedding) return;
    const entity = { type: voiceMatch.entityType as EntityType, id: voiceMatch.entityId };
    const verdict = ranked.find(r => r.entityId === voiceMatch!.entityId)?.mouth;
    const key = `${entity.type}:${entity.id}`;

    if (verdict === "still") {
      void penalizeVoiceMatch(entity, voiceDescriptor.embedding)
        .then(res => logLiveSession("VOICE_GALLERY_PENALIZE", `${key}: lip-contradicted — penalized ${res.penalized}${res.evicted ? " (evicted)" : ""}`))
        .catch(err => logLiveSession("VOICE_GALLERY_PENALIZE_ERROR", `${key}: ${(err as Error).message}`));
    }
    // "moving" → corroborates, but learning waits for the Observer to confirm.
    // "hidden" → no visual evidence either way. Neither grows the gallery.
  }

  /**
   * Shared tail for both STT engines: record the heard speech and feed it to the
   * Observer as a turn-completing [HEARD SPEECH] message so it attributes the
   * speaker and routes via transcript() — at text cost, no audio in the Gemini
   * context. See aac-cost-saving-spec §1.
   */
  private injectHeardSpeech(
    rawText: string | undefined,
    confidence: number | undefined,
    voiceDescriptor: { embedding: number[]; quality?: number } | undefined,
    clipId: string | undefined,
    source: string,
    extraContext?: string,
  ): void {
    const text = (rawText || "").trim();
    if (!text) return;
    this.noteEngagementActivity();
    // Heard speech counts as audio input for the Observer hallucination guard
    // (which keys on lastAudioInputAt — normally bumped by raw PCM, suppressed
    // under STT). Without this, the guard would discard the very transcripts STT
    // is meant to produce.
    this.lastAudioInputAt = Date.now();
    // Remember which clip backs this transcript so the Observer can pull it
    // (request_audio) if the text isn't enough. Clears any stale pending pull.
    this.lastSpeechClipId = clipId ?? null;
    this.pendingAudioPullClipId = null;

    // Refresh speaker attribution from this segment's voice embedding so the
    // next [VOICES HEARD] block — and the Observer's judgment — is current.
    if (voiceDescriptor && this.studentId) {
      this.recognizeVoices([voiceDescriptor]).catch(err => {
        runInSessionContext(this.sessionId || "?", this.debugMode, () => {
          logLiveSession("VOICE_RECOGNITION_ERROR", (err as Error).message);
        });
      });
    }

    const baseTurn = buildHeardSpeechTurn(text, confidence);
    if (!baseTurn) return;
    // Append the audio-visual speaker likelihood so the Observer attributes from
    // voice + lip-sync together (a visible-but-still mouth rules a person out),
    // then a compact energy status so it sees its running drain (incl. the
    // Speaker's spend, which it never observes directly) on every transcript.
    const energyNote = this.buildTranscriptEnergyNote();
    const turn = [baseTurn, extraContext, energyNote].filter(Boolean).join("\n");

    // Wake from resting on heard speech, mirroring routeTranscribed's gate —
    // otherwise the lightweight resting Observer won't act on it.
    if (this.sessionProfile === "resting") {
      flowNote("COORDINATOR", `${source} arrived while resting — waking before routing.`);
      void this.transitionToProfile("awake").then(() => this.observer?.sendUserTurn(turn));
      return;
    }
    this.observer?.sendUserTurn(turn);
  }

  private routeTranscribed(event: TranscribedEvent): void {
    const target = event.target ?? "UNKNOWN";
    const aiName = this.aiName;
    const toDevice = isDeviceTarget(target, aiName);
    // `targetIsUser` is the Observer's authoritative routing flag. When the
    // model omitted it (older / sloppy call), fall back to matching the
    // target against the student name. This is what gates the board
    // rebuild — see the toUser branch below.
    const toUser = event.targetIsUser
      ?? isUserTarget(target, this.currentStudentFullName, this.currentStudentName);

    // `<speaker> to <target>` shape, same as button presses. We KEEP the
    // real identities here — the user's actual name is preserved so the
    // Speaker never confuses them with a third party. Only the AI is
    // abstracted to "YOU" (no identity-confusion risk; the Speaker prompt
    // keys its reply decision on "[X to YOU]").
    const targetLabel = toDevice ? "YOU" : target;
    const rendered = `[${event.speaker} to ${targetLabel}] "${event.text}"`;

    // Conversation activity — transcripts directed at USER or DEVICE
    // (i.e. someone speaking with the user or the AI) reset the rest
    // debounce. Ambient / third-party transcripts don't count.
    if (toDevice || toUser) this.noteEngagementActivity();

    // Wake from resting on directed live speech. Without this, Speaker
    // stays on the resting profile and won't respond to DEVICE-targeted
    // speech, and BoardManager runs in a stale-context state when the
    // USER is being addressed. Match the button-press wake gate in
    // emitClientEvent.
    if ((toDevice || toUser) && this.sessionProfile === "resting") {
      flowNote("COORDINATOR", `Directed transcript arrived while resting; waking before routing.`);
      void this.transitionToProfile("awake").then(() => {
        this.routeTranscribedInner(event, rendered, toDevice, toUser);
      });
      return;
    }
    this.routeTranscribedInner(event, rendered, toDevice, toUser);
  }

  /** Inner half of routeTranscribed — runs after the wake gate. Split
   *  out so the wake transition can defer execution to the awake
   *  profile. */
  private routeTranscribedInner(
    event: TranscribedEvent,
    rendered: string,
    toDevice: boolean,
    toUser: boolean,
  ): void {
    // Echo back to Observer for unified action log.
    this.observer?.sendContextInjection(rendered);

    if (toDevice) {
      // During a social session the director peer models a strict
      // one-on-one conversation with the student: only USER → DEVICE
      // speech reaches it. Other speakers (named third parties, UNKNOWN)
      // are logged for the Monitor but not delivered as turns.
      if (this.socialPeer && !isUserTarget(event.speaker, this.currentStudentFullName, this.currentStudentName)) {
        flowNote("COORDINATOR", `Social session: dropped device-targeted transcript from non-user speaker "${event.speaker}".`);
        this.appendToConversationLog("system", rendered);
        return;
      }
      // Someone addressed the AI directly — deliver as a user_turn from
      // Speaker's perspective (Speaker prompt treats DEVICE-targeted
      // speech as "addressed to YOU").
      this.lastUserInputType = "transcribed";
      // Peer path: normalize the speaker label to USER — the student's
      // NAME must not reach the peer (no student knowledge), and the
      // director's turn matcher keys on the canonical [USER to YOU] shape.
      this.speakerRespond(
        this.socialPeer ? `[USER to YOU] "${event.text}"` : rendered,
      );
      this.appendToConversationLog("user", rendered);
    } else {
      // Either USER-targeted or 3rd-party / UNKNOWN. Speaker sees it as
      // context only — it doesn't respond unless directly addressed.
      this.speaker?.sendContextInjection(rendered);
      // Persist USER-targeted and ambient transcripts as observer-side
      // observations so Monitor (and the admin log) retain conversational
      // context that wasn't directly aimed at the AI. Without this, the
      // session log only captures DEVICE turns and the AI never gets
      // memory updates from real-world conversation around the student.
      this.appendToConversationLog("system", rendered);
    }

    // BoardManager rebuilds whenever the USER needs to reply — i.e. the
    // target was USER. DEVICE-targeted speech goes to Speaker; ambient
    // speech doesn't move the board.
    if (toUser) {
      // Surface the heard statement on the client caption (rendered in yellow,
      // distinct from the AI's own words) so the user can see what they're
      // being asked to respond to while the BoardManager rebuilds reply
      // options below.
      this.send({
        type: "transcript",
        data: event.text,
        speaker: event.speaker,
        confidence: event.confidence,
      });

      // An external statement aimed at the user just landed — in facilitator
      // mode this is the "someone answered the bid" signal, so cancel any
      // pending no-response board (Phase B).
      this.lastExternalToUserAt = Date.now();
      this.clearFacilitatorBidTimer();
      this.invokeBoardManager([event]);
    }
  }

  private enqueueContextUpdate(event: ContextUpdateEvent): void {
    // Identity-learning bridge: gallery growth is gated behind the Observer
    // VERIFYING who someone is. When it confirms an identity, commit the held
    // (pending) biometric sample for that person — face on person_identified,
    // voice on voice_identified, and both on set_person_as_user (the user being
    // named confirms whichever modality we have a fresh sample for). Handled
    // here (not the debounced flush) so the sample is still fresh. `key` is the
    // person's name/role per the tool.
    if (event.updateType === "voice_identified" || event.updateType === "set_person_as_user") {
      void this.seedVoiceFromObserver(event.key);
    }
    if (event.updateType === "person_identified" || event.updateType === "set_person_as_user") {
      void this.seedFaceFromObserver(event.key);
    }
    this.contextUpdateBuffer.push(event);
    if (this.contextUpdateDebounceTimer) clearTimeout(this.contextUpdateDebounceTimer);
    this.contextUpdateDebounceTimer = setTimeout(
      () => this.flushContextUpdates(),
      DEBOUNCE_CONTEXT_UPDATE_MS,
    );
  }

  private flushContextUpdates(): void {
    const batch = this.contextUpdateBuffer;
    this.contextUpdateBuffer = [];
    this.contextUpdateDebounceTimer = null;
    if (batch.length === 0) return;

    // Join into a single context injection for Speaker, and a single
    // Board Manager invocation with the whole batch as triggers.
    const lines = batch.map(e =>
      `[CONTEXT] ${e.updateType}: ${e.key} — ${e.description}${e.relevance ? ` (relevance: ${e.relevance})` : ""}`,
    );
    const joined = lines.join("\n");
    this.observer?.sendContextInjection(joined);
    this.speaker?.sendContextInjection(joined);
    // Observer's observations are session memory — persist them to the
    // conversation log so Monitor incorporates them into Notes/Interests/
    // People updates and the admin log shows the perceived context, not
    // just the spoken turns.
    this.appendToConversationLog("system", joined);

    // While startup is pending, the startup path owns the board: the greeting
    // settle timer waits for BOTH identification AND scene context, then fires
    // (and rebuilds the board with openers) — so the [SESSION START] command
    // lands AFTER the Observer's update_context. We record that context arrived
    // and (re)arm the settle timer; re-arming batches a burst of updates so the
    // greeting follows the LAST one. MENU keeps the home menu (greeting never
    // fires; the fallback clears startup). Either way, no board rebuild here —
    // it would either be redundant with the greeting's rebuild or clobber the
    // home menu.
    if (this.startupPending) {
      this.startupContextReceived = true;
      if (batch.some(e => e.updateType === "set_person_as_user")) this.startupUserConfirmed = true;
      this.maybeArmStartupGreet();
      return;
    }

    this.invokeBoardManager(batch);
  }

  /**
   * Arm the startup-greeting settle timer. The greeting requires BOTH the user
   * identified (face match of student/linked-user, or set_person_as_user) AND
   * scene context — and fires from the timer, never inline — so the
   * [SESSION START] command always lands AFTER the Observer's update_context
   * was injected to Speaker. We arm ONLY once context has arrived; re-arming on
   * each context flush batches a burst and fires just after the last one. If
   * the user is identified but context never comes, the hard fallback timer is
   * the sole backstop (it greets without context). We never consume startup on
   * a non-identifying observation.
   */
  private maybeArmStartupGreet(): void {
    if (!this.startupPending || this.state !== "ready") return;
    if (!this.activeUserIdentified()) return;
    this.startupUserIdentified = true;
    // Once we know who's here, guarantee an eventual greeting even if the
    // scene description never arrives (idempotent).
    this.armStartupFallback();
    // Greet only AFTER scene context — otherwise the greeting would precede
    // the Observer's update_context (it raced ahead via early face ID).
    if (this.startupContextReceived) {
      this.armStartupGreetTimer(STARTUP_GREET_AFTER_CONTEXT_MS);
    }
  }

  private armStartupGreetTimer(ms: number): void {
    if (this.startupGreetTimer) clearTimeout(this.startupGreetTimer);
    this.startupGreetTimer = setTimeout(() => {
      this.startupGreetTimer = null;
      this.fireStartupGreeting({});
    }, ms);
  }

  /**
   * Fire (or resolve) the one-shot startup greeting. CONTEXTUAL + active user
   * identified → Speaker greets and the board follows with openers. `force`
   * (the fallback timer) resolves startup regardless: greet on a personal
   * device with no contradicting visitor, otherwise just stop waiting. MENU /
   * social-peer sessions never greet.
   */
  private fireStartupGreeting(opts: { force?: boolean } = {}): void {
    if (!this.startupPending || this.state !== "ready") return;
    const identified = this.activeUserIdentified();
    if (!identified && !opts.force) return; // nothing to fire yet
    this.startupPending = false;
    this.clearStartupTimers();

    // No Speaker (budget board-only floor, <10%) → no voiced greeting / wake
    // behavior. Come up quietly; the board still works and the avatar reads asleep.
    if (!this.speaker) {
      flowNote("COORDINATOR", "Startup greeting suppressed — board-only (no Speaker) at low budget.");
      return;
    }

    const canGreet = this.startupBehavior === "contextual" && !this.socialPeer;
    const greet = canGreet && (identified || this.studentIsActiveUser());
    if (greet) {
      flowNote("COORDINATOR", `Startup greeting — identified=${identified} force=${!!opts.force} mode=${this.startupBehavior}`);
      // sendUserTurn (not a context injection) so the Speaker actually voices
      // a reply; the scene context was already injected before this. Board
      // follows with openers.
      this.speakerRespond(buildStartupGreetingTurn(this.currentStudentName || "the user"));
      this.invokeBoardManager([]);
    } else {
      flowNote("COORDINATOR", `Startup resolved without greeting — identified=${identified} force=${!!opts.force} mode=${this.startupBehavior}`);
    }
  }

  /** Cancel the pending startup greeting because the user acted first (pressed
   *  a button) — the interaction has already begun, so no auto-greeting. */
  private cancelStartupGreeting(reason: string): void {
    if (!this.startupPending) return;
    this.startupPending = false;
    this.clearStartupTimers();
    flowNote("COORDINATOR", `Startup greeting canceled — ${reason}`);
  }

  private clearStartupTimers(): void {
    if (this.startupGreetTimer) { clearTimeout(this.startupGreetTimer); this.startupGreetTimer = null; }
    if (this.startupFallbackTimer) { clearTimeout(this.startupFallbackTimer); this.startupFallbackTimer = null; }
  }

  /**
   * Whether the person at the device has been positively identified as a
   * primary user — a fresh face match of entityType "student" or "user", or
   * the Observer's set_person_as_user. Visitors (entityType "contact") do NOT
   * count: we don't greet a caregiver as the student.
   */
  private activeUserIdentified(): boolean {
    if (this.startupUserConfirmed) return true;
    if (!this.currentIdentifiedFaces.length) return false;
    if (Date.now() - this.currentIdentifiedFacesAt > AgentCoordinator.IDENTIFIED_FACES_TTL_MS) return false;
    return this.currentIdentifiedFaces.some(f => f.matched && (f.entityType === "student" || f.entityType === "user"));
  }

  /**
   * Whether the bound student is the person actually at the device. Prefers a
   * positive biometric match; if faces are seen but none is the student, a
   * visitor is at the device (don't greet as the student); if no recognition
   * is available, assume the student on a personal device but never on a
   * shared / classroom one.
   */
  private studentIsActiveUser(): boolean {
    const haveFreshFaces = this.currentIdentifiedFaces.length > 0
      && Date.now() - this.currentIdentifiedFacesAt <= AgentCoordinator.IDENTIFIED_FACES_TTL_MS;
    return resolveStudentIsActiveUser({
      sawStudentFace: this.sawStudentFace(),
      haveFreshFaces,
      isSharedDevice: !!this.classroomId,
    });
  }

  /**
   * Send one frame to the Observer with the right scene prompt. The first
   * frame of the session gets the stronger startup prompt and arms the startup
   * fallback; every frame carries the live [PEOPLE PRESENT] block. Used by both
   * the streaming frame_grid path and the immediate initialFrame at connect.
   */
  private async forwardFrameToObserver(data: string, triggerReason?: string, gestureContext?: string, motionSignature?: string): Promise<void> {
    // Drop frames while the Observer's Live session isn't connected yet (its
    // setupComplete can land a few hundred ms AFTER we mark the session ready).
    // Crucially we DON'T count these — otherwise the stronger startup prompt
    // would ride a frame the Observer never actually processes, and the first
    // real frame would get the plain scene-update prompt instead.
    if (!this.observer?.isConnected) {
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        logLiveSession("FRAME dropped", "observer not connected yet");
      });
      return;
    }
    // Bump first (before any await) so a concurrently-processed second frame
    // can't also be treated as the first.
    this.frameCount += 1;
    const isFirstFrame = this.frameCount === 1;
    if (isFirstFrame) {
      // Give just-sent face descriptors a moment to resolve so the first-frame
      // scene description can read [PEOPLE PRESENT].
      await this.awaitFaceRecognition(FACE_RECOGNITION_STARTUP_WAIT_MS);
      // Backstop in case no user identification ever arrives.
      this.armStartupFallback();
    }
    // The Observer scene prompt is built here (not defaulted inside
    // ObserverAgent) so we can append the live [PEOPLE PRESENT] block and use
    // the stronger startup prompt on the very first frame.
    const peopleCtx = this.buildPeoplePresentContext();
    const voicesCtx = this.buildVoicesHeardContext();
    const peopleNote = `${peopleCtx ? `\n${peopleCtx}` : ""}${voicesCtx ? `\n${voicesCtx}` : ""}`;
    const base = isFirstFrame ? OBSERVER_STARTUP_PROMPT : OBSERVER_SCENE_UPDATE_PROMPT;
    // Why this frame arrived (Phase 2 escalation reason) + the client's
    // face/hand summary. Gated on economize so full-attention sessions stay
    // byte-for-byte unchanged (they get frequent frames and never sent these);
    // economize sessions get rarer frames, so each should carry max context. A
    // safety-class escalation (a fall, someone leaving abruptly) nudges the
    // Observer to check its alarm conditions — Phase 3 safety decoupling.
    const reasonNote = this.economize ? this.buildFrameReasonNote(triggerReason) : "";
    const gestureNote = this.economize && gestureContext ? `\n${gestureContext}` : "";
    // The quantified [MOTION SIGNATURE] (seizure-signature DSP) rides with a
    // "seizure" escalation regardless of economize — it's the whole point of the
    // frame, so the Observer judges motion evidence, not just the picture.
    const motionNote = motionSignature ? `\n${motionSignature}` : "";
    // Always log a seizure-class escalation distinctly so it's visible in the
    // session log even in full-attention mode (where reasonNote is suppressed).
    if (triggerReason === "seizure" || motionSignature) {
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        logLiveSession("SEIZURE frame → observer", `economize=${this.economize} ${motionSignature ?? `reason=${triggerReason}`}`);
      });
    }
    this.observer?.sendFrame(data, `${base}${reasonNote}${motionNote}${peopleNote}${gestureNote}`);
    // A real image reached the Observer — record it so emergency_alarm can be
    // gated on having actually SEEN something recently (not a text-only [SCENE]
    // posture label). See EMERGENCY_ALARM_FRAME_WINDOW_MS / routeAlarm.
    this.lastRealFrameAt = Date.now();
    if (this.frameCount === 1 || this.frameCount % 50 === 0) {
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        logLiveSession("FRAME → observer", `count=${this.frameCount} observerConnected=${this.observer?.isConnected ?? false} startup=${this.startupBehavior}`);
      });
    }
  }

  /**
   * Turn a client escalation reason (Phase 2/3) into a short prompt note so the
   * Observer knows WHY it's seeing this frame. Safety-relevant reasons add an
   * explicit alarm-evaluation nudge — this is how a fall / abrupt exit reaches
   * the alarm path without a body-pose model (Phase 3 decoupling).
   */
  private buildFrameReasonNote(triggerReason?: string): string {
    if (!triggerReason) return "";
    if (triggerReason === "safety" || triggerReason === "left_frame") {
      return `\n[FRAME REASON] ${triggerReason} — something changed abruptly (someone left view, a fall, sudden motion). Check carefully against your alarm_conditions before anything else; if it's benign (they just turned away or stepped out), note it and move on.`;
    }
    if (triggerReason === "object_shown") {
      return `\n[FRAME REASON] object_shown — the view changed outside the person and their hands: they may be holding something up to the camera, showing you an object, or the surroundings changed. Look at what's there and respond if it's meant for you.`;
    }
    if (triggerReason === "posture_changed") {
      return `\n[FRAME REASON] posture_changed — the student's body position shifted (e.g. sat up, leaned, slid down). Body-pose readings are coarse for this population, so confirm against what you SEE before reacting; treat it as a prompt to look, not a conclusion.`;
    }
    if (triggerReason === "seizure") {
      // The detail is in the accompanying [MOTION SIGNATURE] line (the DSP's
      // quantified read). This just frames why the frame arrived.
      return `\n[FRAME REASON] seizure — the motion detector flagged a pattern that can indicate a seizure (see [MOTION SIGNATURE]). It is COARSE and self-soothing movements mimic it: look, then judge against ${this.currentStudentName ? `[${this.currentStudentName}]'s` : "the student's"} alarm_conditions. Don't alarm on the detector alone.`;
    }
    return `\n[FRAME REASON] ${triggerReason}`;
  }

  /** Await in-flight face recognition, capped at `timeoutMs`. */
  private async awaitFaceRecognition(timeoutMs: number): Promise<void> {
    const inFlight = this.faceRecognitionInFlight;
    if (!inFlight) return;
    await Promise.race([
      inFlight,
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /** Arm the one-shot backstop that resolves startup if no user identification
   *  arrives after the first frame. */
  private armStartupFallback(): void {
    if (this.startupFallbackTimer || !this.startupPending) return;
    this.startupFallbackTimer = setTimeout(() => {
      this.startupFallbackTimer = null;
      if (this.startupPending) {
        flowNote("COORDINATOR", "Startup fallback timer fired — no user identification arrived.");
        this.fireStartupGreeting({ force: true });
      }
    }, STARTUP_FALLBACK_MS);
  }

  /** A user-or-device-directed action just happened — reset the rest
   *  debounce window and cancel any pending rest. Called from
   *  routeClientEvent (button presses, composed sentences), from
   *  routeTranscribed (live transcripts targeted at USER or DEVICE),
   *  and from the Speaker speech_end handler. */
  private noteEngagementActivity(): void {
    this.lastEngagementActivityAt = Date.now();
    if (this.pendingRestTimer) {
      clearTimeout(this.pendingRestTimer);
      this.pendingRestTimer = null;
      flowNote("COORDINATOR", "Engagement activity — pending rest request cleared.");
    }
  }

  /** Stamp worthwhile OBSERVER activity (a transcript / meaningful observation).
   *  Distinct from engagement: it does NOT clear the pending rest timer or count
   *  as the user interacting, but it DOES reset the low-band budget-scaled sleep
   *  timer (maybeIdleTransition) so an actively-observed in-person exchange isn't
   *  cut short at low budget. */
  private noteObservationActivity(): void {
    this.lastObservationActivityAt = Date.now();
  }

  /** Observer asked to enter rest. If the last engagement activity was
   *  more than REST_DEBOUNCE_MS ago, transition immediately; otherwise
   *  schedule it for when the timer expires. The schedule is canceled
   *  by noteEngagementActivity if activity resumes meanwhile. */
  private requestRest(reason?: string): void {
    if (this.sessionProfile === "resting") return;
    // Resting closes the Speaker — which during a social session is the
    // peer mid-conversation. The session itself counts as engagement.
    if (this.socialPeer || this.socialPeerTransition) {
      flowNote("COORDINATOR", "Rest request ignored — social-training session active.");
      return;
    }
    const elapsed = Date.now() - this.lastEngagementActivityAt;
    if (elapsed >= AgentCoordinator.REST_DEBOUNCE_MS) {
      flowNote("COORDINATOR", `Rest request: ${elapsed}ms since last activity — resting now.${reason ? ` (${reason})` : ""}`);
      void this.transitionToProfile("resting");
      return;
    }
    const remaining = AgentCoordinator.REST_DEBOUNCE_MS - elapsed;
    if (this.pendingRestTimer) clearTimeout(this.pendingRestTimer);
    flowNote("COORDINATOR", `Rest request deferred ~${Math.round(remaining / 1000)}s (last activity ${Math.round(elapsed / 1000)}s ago).${reason ? ` (${reason})` : ""}`);
    this.pendingRestTimer = setTimeout(() => {
      this.pendingRestTimer = null;
      if (this.sessionProfile === "resting") return;
      flowNote("COORDINATOR", "Deferred rest timer expired — entering rest.");
      void this.transitionToProfile("resting");
    }, remaining);
  }

  private routeEngagementChange(event: EngagementChangeEvent): void {
    this.observer?.sendContextInjection(`[ENGAGEMENT] ${event.state}${event.reason ? ` — ${event.reason}` : ""}`);

    // Execute the actual profile transition. Fire-and-forget — failures
    // are logged inside transitionToProfile and must not block the bus.
    // sleep_state_change for resting/awake transitions is emitted by
    // transitionToProfile itself, so both Observer-initiated transitions
    // AND press-initiated wakes notify the client. sleep/end_session
    // don't go through transitionToProfile — we send their state here.
    switch (event.state) {
      case "rest":
        this.requestRest(event.reason);
        return;
      case "wake_up":
        // wake_up is immediate — note the activity and transition. The
        // transitionToProfile call sends sleep_state_change.
        this.noteEngagementActivity();
        void this.transitionToProfile("awake");
        return;
      case "sleep":
        // Cost-saving close: tear down both Live sessions, keep the WS
        // open so the client can re-wake on activity. Coordinator stays
        // ready and can rebuild agents on the next client signal.
        this.send({ type: "sleep_state_change", data: { state: "asleep", source: "ai" } });
        this.enterSleep();
        return;
      case "end_session":
        // Defensive only — the tool is no longer declared on Observer's
        // surface (we never want the AI to kill a session unilaterally;
        // sleep() handles "user is done for now"). If a stale model call
        // ever surfaces, downgrade to sleep instead of cleaning up.
        flowNote("COORDINATOR", "Ignored stale end_session call — downgrading to sleep");
        this.send({ type: "sleep_state_change", data: { state: "asleep", source: "ai" } });
        this.enterSleep();
        return;
    }
  }

  /**
   * Tear down both Live agents for a cost-saving sleep, keeping the WS open.
   * Sets `asleep` so the next real user action rebuilds them (wakeFromSleep).
   * Flushes any open repeat-press burst first so perseveration isn't lost.
   */
  private enterSleep(): void {
    // A sleep mid-social-session means the user disengaged entirely —
    // drop the session without analysis/debrief. The wake path rebuilds
    // the COMPANION Speaker from cached prompts, so just clearing the
    // state here is enough; the conversation stays in conversationLog.
    if (this.socialPeer) {
      const peerName = this.socialPeer.persona.name;
      this.socialPeer = null;
      this.send({ type: "social_session", data: { state: "ended", reason: "sleep" } });
      this.send({ type: "app_close", data: {} });
      this.appendToConversationLog("system", `[SOCIAL TRAINING ENDED] peer=${peerName} reason=sleep (user disengaged)`);
      flowNote("COORDINATOR", `Social-training session dropped on sleep (peer "${peerName}").`);
    }
    this.flushRepeatBurst();
    this.clearDeferredBoardMgr("entering sleep");
    this.speakerSpeaking = false;
    this.abortSttStreams();
    try { this.observer?.close(); } catch {}
    try { this.speaker?.close(); } catch {}
    // Close the Live Board Manager session too (no invokes while asleep); it
    // lazily reconnects on the first invoke after wake. No-op on HTTP.
    try { this.boardManager?.close?.(); } catch {}
    this.observer = null;
    this.speaker = null;
    this.asleep = true;
  }

  // -------------------------------------------------------------------------
  // Profile transitions (awake ↔ resting)
  // -------------------------------------------------------------------------

  /**
   * Profile transition (awake ↔ resting).
   *
   * Observer reconnects with the SAME prompt and tools — only its
   * compression thresholds change. The Live session resumption handle
   * preserves conversation history across the reconnect, so Observer
   * doesn't lose context (and doesn't drift into a different persona).
   * Tighter resting compression is the main cost lever during long
   * quiet stretches — Observer's billed context drops from ~15–30k to
   * ~6–12k per turn.
   *
   * Speaker is closed entirely on resting and freshly started on wake
   * (it's the expensive second Live session, and we want it gone during
   * quiet stretches — not just compressed).
   *
   * BoardManager is HTTP/stateless — no "close." Instead invokeBoardManager
   * short-circuits while resting (see its profile gate).
   */
  private async transitionToProfile(target: "awake" | "resting"): Promise<void> {
    if (this.sessionProfile === target) return;
    if (!this.observer) {
      console.warn(`[AgentCoordinator] transitionToProfile(${target}): observer missing`);
      return;
    }
    // Defensive: never rest over an active social session — the Speaker
    // slot holds the peer and tearing it down here would strand the
    // session state. requestRest already gates this; this catches any
    // pre-scheduled timer that slipped through.
    if (target === "resting" && (this.socialPeer || this.socialPeerTransition)) {
      flowNote("COORDINATOR", "transitionToProfile(resting) skipped — social-training session active.");
      return;
    }

    // Notify the client of the new state.
    this.send({
      type: "sleep_state_change",
      data: { state: target === "resting" ? "resting" : "awake", source: "ai" },
    });
    if (target === "awake" && this.pendingRestTimer) {
      clearTimeout(this.pendingRestTimer);
      this.pendingRestTimer = null;
    }

    runInSessionContext(this.sessionId!, this.debugMode, () => {
      logLiveSession("PROFILE_TRANSITION", `${this.sessionProfile} → ${target}`);
    });
    flowNote("COORDINATOR", `Profile transition: ${this.sessionProfile} → ${target}`);

    const awakeComp = this.observerAwakeCompression();
    const observerTrigger = target === "resting" ? RESTING_COMPRESSION_TRIGGER : awakeComp.trigger;
    const observerTarget = target === "resting" ? RESTING_COMPRESSION_TARGET : awakeComp.target;

    try {
      // Observer: reconnect with new compression thresholds. Same prompt,
      // same tools — session-resumption handle preserves conversation
      // history. Don't await Speaker close/start together with this — if
      // Speaker fails to come back, Observer's reconnect should still
      // complete and the session can recover.
      await this.observer.reconnectWithConfig({
        systemPrompt: this.observerPrompt,
        model: this.observerActiveModel(),
        toolConfig: this.observerToolConfigBase,
        useVertex: this.useVertex,
        compressionTriggerTokens: observerTrigger,
        compressionTargetTokens: observerTarget,
      });

      if (target === "resting") {
        // Tear down Speaker.
        try { this.speaker?.close(); } catch (err) {
          console.warn("[AgentCoordinator] Speaker close failed on transition to resting:", err);
        }
        this.speaker = null;
        // Close the Live Board Manager session too — it isn't invoked while
        // resting (invokeBoardManager gates on profile), so an open session
        // would only churn idle reconnects. It lazily reconnects on the next
        // invoke after wake. No-op on the HTTP path.
        try { this.boardManager?.close?.(); } catch { /* ignore */ }
      } else {
        // target === "awake" — bring Speaker back online, UNLESS the budget is
        // in the board-only floor (<10%): the paid Live Speaker stays down and
        // only the board answers. Already running means we're recovering from a
        // partial transition — leave it alone.
        const boardOnly = this.budgetThrottleEnabled
          && bindingEnergy(this.budgetState, this.budgetWindows, Date.now()).percent < AgentCoordinator.BUDGET_SPEAKER_SLEEP_PERCENT;
        if (boardOnly) {
          flowNote("COORDINATOR", "Wake to resting→awake at <10% — board-only, Speaker stays down.");
          try { this.speaker?.close(); } catch { /* ignore */ }
          this.speaker = null;
        } else if (!this.speaker) {
          this.speaker = this.createSpeakerAgent();
          await this.speaker.start({
            systemPrompt: this.speakerPrompt,
            model: this.speakerModel,
            toolConfig: this.speakerToolConfigBase,
            useVertex: this.useVertex,
            voiceName: this.aiVoiceName,
            useDirectAudio: this.useDirectAudio,
            compressionTriggerTokens: this.speakerCompression().trigger,
            compressionTargetTokens: this.speakerCompression().target,
          });
          this.speaker.setDebugSessionContext(this.sessionId!, this.debugMode);
        }
      }
      this.sessionProfile = target;
      runInSessionContext(this.sessionId!, this.debugMode, () => {
        logLiveSession("PROFILE_TRANSITION_DONE", `now=${target}`);
      });

      // After waking, prime the fresh Speaker with everything it needs to
      // pick up the conversation (recent dialogue, rolling summary, mode,
      // active guessing). Observer doesn't need this — its Live session was
      // preserved via reconnectWithConfig.
      if (target === "awake") {
        this.primeFreshSpeaker();
        // Re-open the Live Board Manager session (closed on the resting
        // transition) ahead of the first post-wake board build. No-op on HTTP.
        this.boardManager?.prewarm?.(this.boardManagerPromptBase, this.boardManagerToolConfig);
      }
    } catch (err) {
      console.error(`[AgentCoordinator] transitionToProfile(${target}) failed:`, err);
      runInSessionContext(this.sessionId!, this.debugMode, () => {
        logLiveSession("PROFILE_TRANSITION_ERROR", `target=${target} err=${(err as Error).message}`);
      });
    }
  }

  /**
   * Prime a freshly-(re)started Speaker with conversation context so it can
   * pick up where the torn-down one left off: rolling session summary, the
   * last N dialogue turns, the persisted interaction mode, and any active
   * guessing state. Without this the new Speaker starts with ZERO context
   * and misinterprets the next press. Shared by transitionToProfile("awake")
   * (wake from resting) and wakeFromSleep() (wake from sleep).
   */
  private primeFreshSpeaker(): void {
    if (!this.speaker) return;
    // 1. Rolling session summary (built every N turns by the Monitor) —
    //    long-tail context compressed out of the per-turn replay below.
    if (this.currentSessionSummary) {
      flowNote("COORDINATOR", `Replaying [SESSION SUMMARY] (${this.currentSessionSummary.length} chars) to fresh Speaker`);
      this.speaker.sendContextInjection(`[SESSION SUMMARY]\n${this.currentSessionSummary}`);
    }
    // 2. Last N conversation turns — capped at 20, or tightened to 6 in the
    //    low band (short-memory mode) so the rebuilt Speaker re-bills less
    //    context each turn while the budget is drawn down.
    const replayCap = this.lowBandActive() ? 6 : 20;
    const replayCount = Math.min(replayCap, this.conversationLog.length);
    if (replayCount > 0) {
      const recent = this.conversationLog.slice(-replayCount).map(t => ({
        role: t.role === "assistant" ? ("model" as const) : ("user" as const),
        text: t.content,
      }));
      flowNote("COORDINATOR", `Replaying ${recent.length} recent turns to fresh Speaker`);
      this.speaker.sendConversationHistory(recent);
    }
    // 3. Persistent state the new Speaker doesn't otherwise know.
    const rendered = `[MODE] ${this.currentInteractionMode} (restored on wake)`;
    flowNote("COORDINATOR", `Re-broadcasting mode=${this.currentInteractionMode} to fresh Speaker`);
    this.speaker.sendContextInjection(rendered);
    if (this.guessingState) {
      flowNote("COORDINATOR", "Re-broadcasting active guessing state to fresh Speaker");
      this.broadcastGuessingStateToAgents();
    }
    // 4. Re-apply the tired instruction — the flag survives Speaker teardown,
    //    so a Speaker rebuilt while still in the low band must be told it's tired.
    if (this.budgetSpeakerTiredActive) {
      this.speaker.sendContextInjection(AgentCoordinator.SPEAKER_TIRED_NOTE);
    }
  }

  /**
   * Re-inject the CURRENT budget (and, when drawn down, energy) status into a
   * freshly (re)started Observer. Without this a wake / backend-switch produces
   * an Observer that knows only the drain RATES (from its system prompt) but
   * not the current LEVELS — and a band change that crossed while it was torn
   * down (e.g. into the low band during sleep) is otherwise never re-sent, so
   * the Observer flies blind and would happily go back to live. Mirrors
   * primeFreshSpeaker. Cheap (0–2 short injections); skipped when healthy.
   */
  private primeFreshObserver(): void {
    if (!this.observer || !this.budgetMeterEnabled) return;
    const now = Date.now();
    const b = bindingEnergy(this.budgetState, this.budgetWindows, now);
    if (b.band !== "high") {
      this.observer.sendContextInjection(
        `[ENERGY] ${b.percent}% remaining — ${b.band}. ${AgentCoordinator.energyGuidance(b.band)}`,
      );
      this.lastReportedEnergyPercent = b.percent;
    }
    this.lastEnergyBand = b.band;
  }

  /**
   * Wake from a `sleep()` teardown: rebuild BOTH Live agents from cached
   * config (sleep nulls Observer too, so transitionToProfile's reconnect
   * path can't recover it) and re-prime the fresh Speaker. Single-flight via
   * `wakePromise` so concurrent user actions don't trigger overlapping
   * rebuilds. On failure, `asleep` stays true so the next action retries.
   */
  private async wakeFromSleep(): Promise<void> {
    if (!this.asleep) return;
    if (this.wakePromise) return this.wakePromise;
    this.wakePromise = this.doWakeFromSleep().finally(() => { this.wakePromise = null; });
    return this.wakePromise;
  }

  private async doWakeFromSleep(): Promise<void> {
    if (!this.asleep) return;
    if (!this.observerPrompt || !this.speakerPrompt) {
      // Never finished initial start() — nothing cached to rebuild from.
      flowNote("COORDINATOR", "wakeFromSleep skipped — agents were never initialized.");
      return;
    }
    const pct = this.budgetThrottleEnabled
      ? bindingEnergy(this.budgetState, this.budgetWindows, Date.now()).percent
      : 100;

    // <0% — ALL-STOP. The budget is truly exhausted (passive mode wasn't cheap
    // enough to hold the line). Refuse to wake ANY paid service: no Observer, no
    // Speaker, no board LLM. Tell the client to stop streaming STT/frames and
    // stay asleep. It recovers on its own as the budget regenerates while idle
    // (nothing spends while asleep). A deliberate press still voices its own TTS.
    if (pct <= AgentCoordinator.BUDGET_SHUTDOWN_PERCENT) {
      flowNote("COORDINATOR", "Budget exhausted (≤0%) — all-stop: refusing to wake any STT/LLM service.");
      this.send({ type: "client_config_update", config: { sttActive: false, sceneStateActive: false, pcmContinuous: false } });
      runInSessionContext(this.sessionId!, this.debugMode, () => {
        logLiveSession("WAKE_REFUSED", "budget exhausted (≤0%) — all-stop");
      });
      return; // stays asleep
    }

    this.send({ type: "sleep_state_change", data: { state: "awake", source: "ai" } });

    // <10% — BOARD-ONLY. Refuse the paid Live Speaker: wake a cheap economy
    // Observer (safety monitoring + transcription) and the HTTP board only. The
    // student can still press buttons (voiced in their own TTS) and get response
    // boards; the AI voice is paused until the budget recovers. See
    // BUDGET_SPEAKER_SLEEP_PERCENT.
    if (pct < AgentCoordinator.BUDGET_SPEAKER_SLEEP_PERCENT) {
      flowNote("COORDINATOR", `Budget ${pct}% (<10%) — waking board-only (economy Observer, no Speaker).`);
      this.observerMode = "economy";
      this.observerForcedEconomy = true;
      this.observer = this.createObserverAgent();
      try {
        await this.observer.start(this.buildObserverStartConfig());
      } catch (err) {
        console.error("[AgentCoordinator] board-only wake failed:", err);
        try { this.observer?.close(); } catch {}
        this.observer = null;
        return; // asleep stays true — next user action retries
      }
      this.observer.setDebugSessionContext(this.sessionId!, this.debugMode);
      this.speaker = null;
      this.sessionProfile = "awake";
      this.asleep = false;
      this.speakerSpeaking = false;
      this.noteEngagementActivity();
      this.primeFreshObserver();
      this.observer.sendContextInjection(
        `[ENERGY] Nearly out of budget — running board-only to conserve. Keep monitoring for safety; the AI voice is paused until it recovers.`,
      );
      this.boardManager?.prewarm?.(this.boardManagerPromptBase, this.boardManagerToolConfig);
      runInSessionContext(this.sessionId!, this.debugMode, () => {
        logLiveSession("WAKE_FROM_SLEEP_DONE", "board-only (<10%): economy Observer, no Speaker");
      });
      return;
    }

    flowNote("COORDINATOR", "Waking from sleep — rebuilding Observer + Speaker.");

    // A wake is fresh engagement. Come back on the economy-policy backend with
    // the low-band floor: <25% forces the cheap HTTP Observer + short-memory
    // (avoids a live→economy churn right after wake), a Live-forbidden policy
    // pins economy, otherwise the policy default backend.
    {
      const backend = this.initialObserverBackend(pct);
      this.observerMode = backend.mode;
      this.observerForcedEconomy = backend.forced;
    }
    this.observer = this.createObserverAgent();
    this.speaker = this.createSpeakerAgent();
    try {
      await Promise.all([
        this.observer.start({
          systemPrompt: this.observerPrompt,
          model: this.observerActiveModel(),
          toolConfig: this.observerToolConfigBase,
          useVertex: this.useVertex,
          voiceName: this.aiVoiceName,
          compressionTriggerTokens: this.observerAwakeCompression().trigger,
          compressionTargetTokens: this.observerAwakeCompression().target,
        }),
        this.speaker.start({
          systemPrompt: this.speakerPrompt,
          model: this.speakerModel,
          toolConfig: this.speakerToolConfigBase,
          useVertex: this.useVertex,
          voiceName: this.aiVoiceName,
          useDirectAudio: this.useDirectAudio,
          compressionTriggerTokens: this.speakerCompression().trigger,
          compressionTargetTokens: this.speakerCompression().target,
        }),
      ]);
    } catch (err) {
      console.error("[AgentCoordinator] wakeFromSleep agent connect failed:", err);
      try { this.observer?.close(); } catch {}
      try { this.speaker?.close(); } catch {}
      this.observer = null;
      this.speaker = null;
      return; // asleep stays true — next user action retries
    }
    this.observer.setDebugSessionContext(this.sessionId!, this.debugMode);
    this.speaker.setDebugSessionContext(this.sessionId!, this.debugMode);

    this.sessionProfile = "awake";
    this.asleep = false;
    this.speakerSpeaking = false;
    this.noteEngagementActivity();
    runInSessionContext(this.sessionId!, this.debugMode, () => {
      logLiveSession("WAKE_FROM_SLEEP_DONE", "Observer + Speaker rebuilt");
    });

    this.primeFreshSpeaker();
    // Re-seed the fresh Observer with the current budget/energy level — a band
    // change that crossed while asleep was never delivered to the torn-down
    // Observer, so without this it would wake blind and go back to live.
    this.primeFreshObserver();
    // Re-open the Live Board Manager session (closed on sleep) so the first
    // post-wake board build doesn't pay connect latency. No-op on HTTP.
    this.boardManager?.prewarm?.(this.boardManagerPromptBase, this.boardManagerToolConfig);
  }

  /** Resolve the Observer backend for a FRESH build at `pct` budget, honoring the
   *  economy policy (default backend + allowLive pin) and the low-band floor.
   *  Returns the mode plus whether Live is LOCKED OUT (`forced` → observerForcedEconomy).
   *  Used by initial start and wakeFromSleep. */
  private initialObserverBackend(pct: number): { mode: "live" | "economy"; forced: boolean } {
    const lowBand = this.budgetThrottleEnabled && pct < 25;
    // Locked out of Live when the budget forces it (low band) OR the policy
    // forbids Live entirely (e.g. Demo). NOT locked merely because the default
    // backend is economy — a standard-tier session may still go live on its own.
    const forced = lowBand || !this.observerPolicy.allowLive;
    const startEconomy = forced || this.observerPolicy.defaultBackend === "economy";
    return { mode: startEconomy ? "economy" : "live", forced };
  }

  /** Build a fresh Observer backend with the standard callback bundle. Picks
   *  the Live (native-audio) or Economy (HTTP gemini-2.5-flash) backend based
   *  on `this.observerMode`. Used by initial start, wakeFromSleep, AND the
   *  live↔economy switch. Cost is attributed to the backend's REAL model/
   *  provider so the cheap path bills at flash rates. The mode is captured at
   *  build time — a mode change rebuilds the agent, so it never changes under
   *  a live instance. */
  private createObserverAgent(): IObserverAgent {
    const liveProvider = this.aacChatProvider;
    const isEconomy = this.observerMode === "economy";
    const usageProvider = isEconomy ? BOARD_MANAGER_DEFAULT_PROVIDER : liveProvider;
    const usageModel = isEconomy ? this.observerHttpModel : this.observerModel;
    const callbacks: ObserverCallbacks = {
      onEvent: (e) => this.onObserverEvent(e),
      onError: (err) => console.error("[AgentCoordinator] Observer error:", err),
      onClose: () => console.log("[AgentCoordinator] Observer closed"),
      onUsage: (usage) => this.trackLiveUsage("observer", usageProvider as any, usageModel, usage),
    };
    if (isEconomy) {
      flowNote("COORDINATOR", `Observer mode=economy (HTTP ${this.observerHttpModel})`);
      return new HttpObserverAgent(BOARD_MANAGER_DEFAULT_PROVIDER, callbacks);
    }
    flowNote("COORDINATOR", `Observer mode=live (Gemini Live ${this.observerModel})`);
    return new ObserverAgent("gemini", callbacks);
  }

  /** Build the ObserverStartConfig for the CURRENT backend (active model +
   *  awake compression). Shared by the switch path. */
  private buildObserverStartConfig(): ObserverStartConfig {
    const comp = this.observerAwakeCompression();
    return {
      systemPrompt: this.observerPrompt,
      model: this.observerActiveModel(),
      toolConfig: this.observerToolConfigBase,
      useVertex: this.useVertex,
      voiceName: this.aiVoiceName,
      compressionTriggerTokens: comp.trigger,
      compressionTargetTokens: comp.target,
    };
  }

  /**
   * Switch the Observer between the Live (native-audio) and Economy (HTTP)
   * backends at runtime. Tears down the current backend, rebuilds the other,
   * and replays recent conversation history so context survives the swap
   * (mirrors primeFreshSpeaker / wakeFromSleep). No-op if already in `mode`,
   * asleep, or not ready. Single-flight via observerSwitchInFlight.
   */
  private async switchObserverBackend(mode: "live" | "economy", reason?: string): Promise<void> {
    if (!this.economyObserverEnabled) return;
    if (this.observerMode === mode) return;
    if (this.asleep || this.state !== "ready" || !this.observerPrompt) return;
    if (this.observerSwitchInFlight) return;
    this.observerSwitchInFlight = true;
    const prev = this.observerMode;
    flowNote("COORDINATOR", `Observer backend switch ${prev} → ${mode}${reason ? ` (${reason})` : ""}`);
    try {
      // Snapshot recent dialogue to replay into the fresh backend (cap 20,
      // same as primeFreshSpeaker) so the switch doesn't lose context.
      const replayCount = Math.min(20, this.conversationLog.length);
      const recent = replayCount > 0
        ? this.conversationLog.slice(-replayCount).map(t => ({
            role: t.role === "assistant" ? ("model" as const) : ("user" as const),
            text: t.content,
          }))
        : [];

      try { this.observer?.close(); } catch { /* ignore */ }
      this.observer = null;
      this.observerMode = mode;
      const next = this.createObserverAgent();
      this.observer = next;
      await next.start(this.buildObserverStartConfig());
      next.setDebugSessionContext(this.sessionId!, this.debugMode);
      if (recent.length > 0) next.sendConversationHistory(recent);
      next.sendContextInjection(
        mode === "economy"
          ? `[OBSERVATION MODE] economy — you now wake on events to conserve energy.${reason ? ` (${reason})` : ""}`
          : `[OBSERVATION MODE] live — full continuous observation.${reason ? ` (${reason})` : ""}`,
      );
      // Seed the freshly-built backend with the current budget/energy level so
      // it doesn't lose the throttle context across the swap.
      this.primeFreshObserver();
      runInSessionContext(this.sessionId!, this.debugMode, () => {
        logLiveSession("OBSERVER_MODE_SWITCH", `${prev} → ${mode}${reason ? ` (${reason})` : ""}`);
      });
    } catch (err) {
      console.error(`[AgentCoordinator] switchObserverBackend(${mode}) failed:`, err);
      // Leave whatever we have; next event will retry if needed.
    } finally {
      this.observerSwitchInFlight = false;
    }
  }

  /** Handle the Observer's own set_observation_mode request. Refuses going back
   *  to "live" while the budget is in the LOW band (<25%) — the forced-HTTP
   *  floor — so the Observer can't undo it. At ≥25% the Observer is free to
   *  choose (per the existing floors, only <25% forces the cheap backend). */
  private handleObservationModeChange(event: ObservationModeChangeEvent): void {
    if (!this.economyObserverEnabled) return;
    // Live-forbidden policy (e.g. Demo): the tool isn't even declared, but refuse
    // defensively so a stray call can never lift the economy pin.
    if (event.mode === "live" && !this.observerPolicy.allowLive) {
      flowNote("COORDINATOR", "Observer requested live but policy forbids it — staying economy.");
      return;
    }
    if (event.mode === "live" && this.budgetThrottleEnabled) {
      const b = bindingEnergy(this.budgetState, this.budgetWindows, Date.now());
      if (b.band === "low") {
        flowNote("COORDINATOR", `Observer requested live but budget ${b.percent}% (low) — staying economy.`);
        this.observer?.sendContextInjection(
          `[OBSERVATION MODE] staying economy — budget ${b.percent}% (low). You can go live once it recovers above 25%.`,
        );
        return;
      }
    }
    if (event.mode === "live") this.observerForcedEconomy = false;
    void this.switchObserverBackend(event.mode, event.reason);
  }

  /** Build a fresh SpeakerAgent with the standard callback bundle. Used
   *  by initial start AND by transitionToProfile("awake") when recreating
   *  Speaker after a resting close. Picks SpeakerAgent (Live) or
   *  HttpSpeakerAgent based on `this.speakerMode`. */
  private createSpeakerAgent(): ISpeakerAgent {
    const provider = "gemini" as const;
    const aacChatProvider = this.aacChatProvider;
    const speakerModel = this.speakerModel;
    const callbacks = {
      onEvent: (e: SpeakerOutputEvent) => this.onSpeakerEvent(e),
      onAudioChunk: (data: { mimeType: string; data: string }) => this.onSpeakerAudioChunk(data),
      onTranscriptionDelta: (text: string) => this.onSpeakerTranscriptionDelta(text),
      onSpeakText: (text: string) => this.onSpeakerSpeakText(text),
      onError: (err: Error) => console.error("[AgentCoordinator] Speaker error:", err),
      onClose: () => console.log("[AgentCoordinator] Speaker closed"),
      onUsage: (usage: any) => this.trackLiveUsage("speaker", aacChatProvider, speakerModel, usage),
    };
    if (this.speakerMode === "http") {
      flowNote("COORDINATOR", `Speaker mode=http (Gemini chat completion + streaming TTS)`);
      return new HttpSpeakerAgent(provider, callbacks);
    }
    flowNote("COORDINATOR", `Speaker mode=live (Gemini Live, useDirectAudio=${this.useDirectAudio})`);
    return new SpeakerAgent(provider, {
      onEvent: (e) => this.onSpeakerEvent(e),
      onAudioChunk: (data) => this.onSpeakerAudioChunk(data),
      onTranscriptionDelta: (text) => this.onSpeakerTranscriptionDelta(text),
      onSuppressAudio: () => this.onSpeakerSuppressAudio(),
      onSpeakText: (text) => this.onSpeakerSpeakText(text),
      onError: (err) => console.error("[AgentCoordinator] Speaker error:", err),
      onClose: () => console.log("[AgentCoordinator] Speaker closed"),
      onUsage: (usage) => this.trackLiveUsage("speaker", aacChatProvider, speakerModel, usage),
    });
  }

  /** Build the Board Manager backend — HTTP (stateless completions) or Live
   *  (warm Gemini Live session, TEXT modality + function calling). Both honor
   *  IBoardManagerAgent so the invocation path is identical. Live usage is
   *  billed via the onUsage callback at the live model's rates, attributed to
   *  the "board-manager" bucket — `invoke()` returns no `usage`, so the
   *  Coordinator's own result.usage charge is skipped (no double billing). */
  private createBoardManager(mode: "http" | "live"): IBoardManagerAgent {
    if (mode === "live") {
      // 3.1 (the only model with usable structured FC) is PUBLIC-API only.
      // Use Vertex only when the chosen model is actually published there;
      // otherwise fall to the public Gemini API (GEMINI_API_KEY), independent
      // of the Observer/Speaker Vertex setting.
      const bmModelOpt = getModelOption(BOARD_MANAGER_DEFAULT_PROVIDER, LIVE_BOARD_MANAGER_MODEL);
      const bmUseVertex = bmModelOpt
        ? (this.useVertex && bmModelOpt.availableOnVertex === true)
        : this.useVertex;
      flowNote("COORDINATOR", `Board Manager mode=live (Gemini Live, model=${LIVE_BOARD_MANAGER_MODEL}, vertex=${bmUseVertex})`);
      if (!bmUseVertex && !process.env.GEMINI_API_KEY) {
        console.warn(`[AgentCoordinator] Live Board Manager wants the public Gemini API (model ${LIVE_BOARD_MANAGER_MODEL} not on Vertex) but GEMINI_API_KEY is unset — connection will fail.`);
      }
      return new LiveBoardManagerAgent({
        providerKey: BOARD_MANAGER_DEFAULT_PROVIDER,
        model: LIVE_BOARD_MANAGER_MODEL,
        useVertex: bmUseVertex,
        // Mirror Observer: native-audio model wants a voice in AUDIO modality
        // even though the Board Manager never plays audio.
        voiceName: this.aiVoiceName,
        onUsage: (usage) =>
          this.trackLiveUsage("board-manager", BOARD_MANAGER_DEFAULT_PROVIDER, LIVE_BOARD_MANAGER_MODEL, usage),
      });
    }
    flowNote("COORDINATOR", `Board Manager mode=http (${BOARD_MANAGER_DEFAULT_PROVIDER}/${BOARD_MANAGER_DEFAULT_MODEL})`);
    return new BoardManagerAgent(BOARD_MANAGER_DEFAULT_PROVIDER);
  }

  private routeFocusRequest(event: FocusRequestEvent): void {
    this.send({ type: "focus_request", data: { reason: event.reason } });
    // Echo back so Observer doesn't request the same thing in rapid succession.
    this.observer?.sendContextInjection(`[FOCUS REQUESTED] ${event.reason}`);
  }

  /**
   * Observer asked to re-hear a recent speech segment it only got as text
   * (Phase 1b audio backlog pull). Resolve to the clip behind the most recent
   * speech_text and ask the client for it. The clip comes back as `audio_clip`
   * and is fed to the Observer as a turn (handleClientMessage). No clip on file
   * (e.g. STT off, or it scrolled out of the client ring buffer) → no-op with a
   * note so the Observer isn't left waiting.
   */
  private routeAudioRequest(event: AudioRequestEvent): void {
    if (!this.capable("clientStt") || !this.lastSpeechClipId) {
      this.observer?.sendContextInjection(`[NO AUDIO AVAILABLE] The clip for that speech is no longer on file — judge from the text you have.`);
      return;
    }
    this.pendingAudioPullClipId = this.lastSpeechClipId;
    this.send({ type: "request_audio_clip", data: { clipId: this.lastSpeechClipId } });
    // Echo so the Observer doesn't spam the request while the clip is in flight.
    this.observer?.sendContextInjection(`[AUDIO REQUESTED] ${event.reason}`);
  }

  /**
   * Observer raised a caretaker alarm. Push it straight to the client —
   * NOT through the Monitor, which is blind (text/HTTP only) and too slow
   * for something time-sensitive. The client owns the audible/visible
   * effect (short nudge for "alert"; rising tone + on-screen cancel for
   * "emergency"). We deliberately do not gate this on session profile:
   * the message reaches the device even while resting. Echo the alarm
   * back into Observer's own context so it doesn't re-fire the same alarm
   * every frame.
   */
  private routeAlarm(event: AlarmRaisedEvent): void {
    // Visual-confirmation gate for EMERGENCIES only. An emergency must rest on a
    // real camera image the Observer actually SAW recently — not a coarse
    // text-only [SCENE] posture label or an inference synthesised from earlier
    // text (unreliable for this population; a mislabelled "lying" has fired
    // false alarms). Audio does NOT count: lastAudioInputAt is bumped by the
    // cheap STT text path too, so it's fresh whenever the mic is on and would
    // defeat the gate. If no real frame reached the Observer within the window,
    // SUPPRESS: don't signal the caretaker, force a focus frame, and tell the
    // Observer to LOOK and re-raise only if it truly confirms the emergency.
    // Alerts are not gated — they're often legitimately text/conversation-based.
    if (shouldSuppressEmergency(event.level, this.lastRealFrameAt, Date.now(), EMERGENCY_ALARM_FRAME_WINDOW_MS)) {
      const sinceFrame = this.lastRealFrameAt === 0
        ? "no image this session"
        : `${Date.now() - this.lastRealFrameAt}ms since the last image`;
      flowNote("COORDINATOR", `Emergency alarm SUPPRESSED (no recent visual frame — ${sinceFrame}): ${event.reason}`);
      this.logEvent("OBSERVER(alarm-suppressed)", event);
      // Force a look so the Observer can actually confirm before it can alarm.
      this.send({ type: "focus_request", data: { reason: "confirm possible emergency" } });
      const who = this.currentStudentName ? `[${this.currentStudentName}]` : "the student";
      this.observer?.sendContextInjection(
        `[EMERGENCY ALARM SUPPRESSED] Your emergency ("${event.reason}") had no recent camera image behind it — only text (e.g. the coarse [SCENE] posture label), often wrong for ${who}. A focus frame was requested: look, then re-raise emergency_alarm ONLY if you actually SEE the emergency. If it's benign, note it and don't alarm.`,
      );
      return;
    }
    this.send({ type: "alarm", data: { level: event.level, reason: event.reason } });
    const tag = event.level === "emergency" ? "EMERGENCY ALARM RAISED" : "ALERT RAISED";
    this.observer?.sendContextInjection(`[${tag}] ${event.reason} — the device is now signalling a caretaker; do not raise it again unless the situation changes.`);
  }

  // -------------------------------------------------------------------------
  // Speaker → bus
  // -------------------------------------------------------------------------

  private onSpeakerEvent(event: SpeakerOutputEvent): void {
    this.recordEvent(event);
    this.logEvent("SPEAKER", event);

    switch (event.type) {
      case "speech_start":
        this.onSpeakerSpeechStart(event);
        return;
      case "speech_text_finalized":
        this.onSpeakerSpeechTextFinalized(event);
        return;
      case "speech_end":
        this.onSpeakerSpeechEnd(event);
        return;
      case "emote_change":
        this.routeEmoteChange(event);
        return;
      case "call_person":
        void this.routeCallPerson(event);
        return;
      case "mode_change":
        this.routeModeChange(event);
        return;
      case "app_open_requested":
        void this.routeAppOpen(event);
        return;
      case "app_close_requested":
        this.routeAppClose(event);
        return;
      case "website_open_requested":
        this.routeWebsiteOpen(event);
        return;
      case "monitor_call_requested":
        this.requestMonitor(event.reason, "speaker");
        return;
      case "private_note":
        // No echo back into Speaker / Observer / BoardManager. Echoing
        // the note into Speaker's context as text (with a
        // `[PRIVATE NOTE]` prefix) made the model imitate that pattern
        // in its own subsequent replies. The HTTP Speaker also drops
        // private_note tool calls from its long-term history; the only
        // place a note flows back to Speaker is the in-turn "thinking
        // chain" re-prompt (an orphan-note turn re-fires with the
        // accumulated notes injected once, then they're dropped).
        //
        // The note IS preserved for SUPERVISOR channels — admin log +
        // Monitor's pending queue — via writeSupervisorOnly(). We use
        // this dedicated helper (not appendToConversationLog) because
        // conversationLog is replayed verbatim to a fresh Speaker on
        // reconnect and is the source for session-summary generation;
        // notes in either of those would leak back into the agents'
        // visible context. flow log already captured the call via
        // HttpSpeakerAgent's flowTool("private_note", ...).
        this.writeSupervisorOnly(`[SPEAKER private_thought] ${event.note}`);
        // Visual "thinking" cue to the client so the user sees that
        // Speaker paused to think rather than wondering why it went
        // quiet. The client treats this as a one-shot pulse and
        // auto-dismisses the indicator after a short delay, so we
        // don't need to send a matching `active: false`.
        this.send({ type: "thinking", active: true });
        return;
      case "remain_silent":
        // Acknowledged. The event is bus-logged for visibility;
        // Coordinator takes no further action — silence is the action.
        // The turn is over, so drop the "thinking" indicator.
        this.clearSpeakerBusy();
        return;
      case "thought_leak":
        this.onSpeakerThoughtLeak(event);
        return;
    }
  }

  /** The Speaker voiced its private reasoning this turn ("private_thought …").
   *  Audio was already suppressed mid-stream by onSpeakerSuppressAudio(). Here
   *  we close out the turn WITHOUT the normal speech_end side effects — no echo
   *  back into Speaker context, no conversationLog append, no BoardManager
   *  rebuild — because feeding the leaked text back is exactly the self-
   *  reinforcing loop that makes the behavior persist. The captured reasoning
   *  is preserved on supervisor channels (same as a real private_thought), and
   *  a corrective is injected so the model stops voicing thoughts. */
  private onSpeakerThoughtLeak(event: ThoughtLeakEvent): void {
    // Lift suppression so the next turn's audio flows normally.
    this.suppressSpeakerAudio = false;
    this.speakerSpeaking = false;
    // The turn ends here (no real speech reaches the child) — drop the
    // ambient "thinking" indicator; the corrective below won't re-provoke.
    this.clearSpeakerBusy();

    // Preserve the reasoning for SUPERVISOR channels only (admin log +
    // Monitor queue) — never into agent-visible context. Mirrors the real
    // private_note handler above.
    this.writeSupervisorOnly(`[SPEAKER private_thought — leaked into speech, suppressed] ${event.note}`);

    // One-shot "thinking" pulse so the client shows the avatar paused to
    // think rather than wondering why the audio cut out.
    this.send({ type: "thinking", active: true });
    // Reset the client's text accumulator (it may hold a leaked fragment
    // sent before detection fired).
    this.send({ type: "complete", data: {} });

    // Corrective nudge. Delivered as a context injection (no response
    // provoked) — the next real user turn drives the actual reply. This is
    // the live-audio counterpart to the HTTP orphan-note re-prompt.
    this.speaker?.sendContextInjection(THOUGHT_LEAK_CORRECTION);

    flowNote("SPEAKER", `thought_leak suppressed + corrective injected: "${event.note.slice(0, 80)}"`);

    // Deliberately NOT done here (unlike speech_end): no [YOU to USER] echo,
    // no [AI to USER] Observer injection, no appendToConversationLog, no
    // invokeBoardManager. The board keeps whatever the press-time rebuild
    // produced; the model gets a clean slate on its next turn.
  }

  private onSpeakerSpeechStart(event: SpeechStartEvent): void {
    // No mic mute — Observer's prompt handles echo via the
    // <transcription> rule + the [OWN_SPEECH] / [BUTTON PRESS] context
    // we inject around AAC audio playback.

    // Speech_start fires on the FIRST audio chunk — at that point the
    // transcript is typically only partial (text and audio interleave
    // in native audio, contrary to an earlier assumption). Don't fire
    // BoardManager here; wait for speech_text_finalized which carries
    // the FULL transcript and arrives well before turnComplete.
    this.speakerSpeaking = true;
    void event;
  }

  /** Text portion of Speaker's turn finished. Audio may still be
   *  streaming, but the transcript is complete. Fire BoardManager so
   *  it can build REPLIES to what the AI just said — distinct from the
   *  press-time rebuild which builds FOLLOW-UPS to the user's own
   *  statement. Both rebuild perspectives matter, especially when the
   *  user is conversing with a non-AI person (the press is the user's
   *  turn, the speech is the other side's turn). */
  private onSpeakerSpeechTextFinalized(event: SpeechTextFinalizedEvent): void {
    this.noteEngagementActivity();
    // Speaker replied — supersede any deferred press-triggered BM
    // invocation. REPLIES (built from this event) is more current than
    // FOLLOW-UPS (built from the press) for an AI-targeted press.
    this.clearDeferredBoardMgr("speech_text_finalized supersedes press");
    // If a BM call is already running, its in-flight context is older
    // than the speech that just landed. Abort it: the queued invocation
    // we're about to fire will run with this new speech as trigger, so
    // the result of the in-flight one would only paint stale buttons.
    if (this.boardMgrInFlight && this.boardMgrAbortController) {
      flowNote("BOARD_MGR", "Aborting in-flight invocation — newer speech_text_finalized supersedes.");
      this.boardMgrAbortController.abort();
    }
    this.invokeBoardManager([event]);
  }

  private onSpeakerSpeechEnd(event: SpeechEndEvent): void {
    this.speakerSpeaking = false;
    // Speaker turn resolved — drop the ambient "thinking" indicator.
    this.clearSpeakerBusy();
    // Flush any remaining buffered PCM chunks so the tail of the
    // utterance reaches the client even when the timer hasn't fired yet.
    this.flushSpeakerAudio();
    // Signal end-of-turn to the client so its text accumulator resets
    // for the next utterance. Without this, each Speaker turn's text is
    // appended to the previous instead of replacing it. Mirrors the
    // legacy LiveRelay.processTurnEnd's `complete` send.
    this.send({ type: "complete", data: {} });

    // Speaker addressed `target` (default USER). Mirror the unified
    // `[<speaker> to <target>] "..."` shape used everywhere else.
    const target = event.target ?? PARTY_USER;
    const targetForLog = isUserTarget(target, this.currentStudentFullName, this.currentStudentName)
      ? "USER"
      : target;
    if (event.transcript) {
      // During a social session, the device voice belongs to the peer
      // persona — tag the speech with its name so the Observer, the log,
      // and the restored companion Speaker (history replay) all see WHO
      // said it. The "(virtual peer)" marker keeps the replay
      // unambiguous: those model-role turns weren't the companion's.
      const speakerLabel = this.socialPeer
        ? `${this.socialPeer.persona.name} (virtual peer)`
        : "AI";
      // Observer hears the speakers playback through the mic — tag it
      // as the device's voice so it doesn't transcribe the room playback.
      this.observer?.sendContextInjection(`[${speakerLabel} to ${targetForLog}] "${event.transcript}"`);
      // Echo back to Speaker so it remembers what it said.
      this.speaker?.sendContextInjection(`[YOU to ${targetForLog}] "${event.transcript}" (you just said this)`);
      this.appendToConversationLog(
        "assistant",
        this.socialPeer ? `[${speakerLabel}] "${event.transcript}"` : event.transcript,
      );
    }

    // Speaker leaked a bracketed input tag onto the front of its reply.
    // It was already stripped from the transcript above; nudge the model
    // (one-shot context injection) so it stops prefixing its speech. On
    // the HTTP path this buffers and rides along with the next user turn.
    if (event.strippedLeadingTag) {
      this.speaker?.sendContextInjection(LEADING_TAG_CORRECTION);
      flowNote("SPEAKER", `leading-tag leak stripped + corrective injected: "${event.strippedLeadingTag}"`);
    }

    // BoardManager rebuild already fired on speech_start (where the
    // SpeechStartEvent carries the same transcript). Do NOT fire again
    // here — it would duplicate the call with no new information and
    // produce flicker.

    // Monitor heartbeat — turn-end is the natural hook to let Monitor
    // catch up on accumulated pending messages. Non-forced; the service
    // throttle (MONITOR_THROTTLE_MS, ~2 min) drops excess calls so this
    // effectively runs every couple of turns at peak conversation, then
    // backs off to once per throttle window. Without this hook, Monitor
    // only ever fires when an agent explicitly emits monitor_call_requested,
    // which means Student_Notes / Student_Interests / Student_People are
    // never written. Mirrors legacy LiveRelay's per-turn triggerMonitor.
    // Phase 5.3: while economizing AND resting, skip the per-turn Monitor
    // heartbeat. During quiet resting stretches a Monitor run is near-pure
    // waste; pending messages just accumulate and are processed on the next
    // awake heartbeat (or the session summary) — deferred, never lost.
    // Incidents still flush immediately via explicit monitor_call_requested.
    const skipMonitorHeartbeat = this.economize && this.sessionProfile === "resting";
    if (this.sessionId && !skipMonitorHeartbeat) {
      flowNote("MONITOR", "turn-end heartbeat — triggerMonitor(force=false)");
      dualAgentService.triggerMonitor(this.sessionId, false).catch(err => {
        console.warn("[AgentCoordinator] triggerMonitor failed:", (err as Error).message);
      });
    } else if (skipMonitorHeartbeat) {
      flowNote("MONITOR", "turn-end heartbeat skipped (economize + resting)");
    }

    // Apply a low-band economy-backend switch that was deferred while the AI was
    // speaking (Issue: drop to lower-band behavior at the next idle boundary, not
    // mid-sentence). Runs LAST so the [AI to USER] echo above reaches the current
    // Observer before the swap (which then replays history to the fresh backend).
    if (this.economySwitchPendingIdle && this.economyObserverEnabled) {
      this.economySwitchPendingIdle = false;
      if (this.observerMode === "live" && !this.observerSwitchInFlight) {
        flowNote("COORDINATOR", "AI idle — applying deferred low-budget economy switch.");
        void this.switchObserverBackend("economy", "low budget — deferred switch (AI now idle)");
      }
    }
  }

  private routeEmoteChange(event: EmoteChangeEvent): void {
    this.send({ type: "emote", data: event.emote });
    this.speaker?.sendContextInjection(`[EMOTE] ${event.emote}`);
  }

  /** Speaker asked to call a contact → direct the client to dial it. Media
   *  lives on the client; the server only relays signaling afterwards. */
  private async routeCallPerson(event: CallPersonEvent): Promise<void> {
    try {
      const contact = await getContactById(event.contactId);
      if (!contact || !contact.callable || !contact.isActive) {
        // The contact vanished or is no longer callable — tell the Speaker so it
        // can explain rather than silently doing nothing.
        this.speaker?.sendContextInjection(`[CALL FAILED] That contact can no longer be called.`);
        return;
      }
      // Don't dial into the void: if the callee has no live socket on any
      // instance, the ring would just time out. Tell the Speaker up front.
      const calleePersonId = await resolveContactPersonId(contact);
      if (!calleePersonId || !isPersonOnline(calleePersonId)) {
        this.speaker?.sendContextInjection(`[CALL FAILED] ${contact.name} is not available right now.`);
        return;
      }
      this.send({ type: "call_directive", action: "start", contactId: event.contactId, contactName: contact.name });
    } catch (err) {
      console.error("[AgentCoordinator] routeCallPerson:", err);
    }
  }

  /** Inject the student's callable contacts (with live online flags) so the
   *  Speaker knows who it may call and the contactId to pass to call_person. */
  private async injectCallableContacts(): Promise<void> {
    if (!this.studentId) return;
    try {
      const contacts = await listCallableContacts(this.studentId);
      if (contacts.length === 0) return;
      const lines = contacts
        .map((c) => `- ${c.name}${c.relationship ? ` (${c.relationship})` : ""} [contactId:${c.contactId}] ${c.online ? "online" : "offline"}`)
        .join("\n");
      this.speaker?.sendContextInjection(`[CALLABLE CONTACTS]\n${lines}`);
    } catch (err) {
      console.error("[AgentCoordinator] injectCallableContacts:", err);
    }
  }

  // Facilitator "hold": a live call OR a group chat forces facilitator mode
  // (the AI supports a human/peer exchange rather than chatting itself). Either
  // source can hold it; the pre-hold mode is restored only when BOTH release.
  private modeBeforeHold: "companion" | "facilitator" | null = null;
  private callActive = false;
  private conversationActive = false;

  // Shape-C group AAC chat: the conversation room this student is currently in
  // (null = solo). When set, this student's voiced utterances are fanned out to
  // peers, and their utterances arrive via onPeerUtterance.
  private conversationRoomId: string | null = null;
  // This coordinator's own canonical identity in the conversation layer. The
  // room keys on personId (participants may be students OR non-students), so we
  // resolve studentId → persons.id once and cache it. studentId stays an
  // AAC-internal detail (own agents, board, biometric photo).
  private conversationPersonId: string | null = null;
  // Known peers in the current room (personId → display name), kept current
  // from the join roster + presence deltas so the AI knows who's in the chat.
  private conversationRoster = new Map<string, string>();
  // Last actionable floor note surfaced to the AI, to dedupe + know when to
  // announce the floor reopening.
  private floorActiveNote = "";
  // Most recent floor state (for adjacency-based addressee inference).
  private currentFloor: FloorState | null = null;
  // Peer the student is currently focused on (tapped/dwelt on their face in the
  // group-chat header) — an exact peer studentId, or null. Strongest addressee
  // signal; the client owns the highlight and clears this when it goes away.
  private addresseeFocus: string | null = null;

  /** Force facilitator mode for the duration of a live video call. */
  private setCallMode(active: boolean): void {
    this.callActive = active;
    this.updateFacilitatorHold();
  }

  /** Force facilitator mode while a call OR group chat is active; restore the
   *  pre-hold mode once both release. Idempotent — safe to call repeatedly. */
  private updateFacilitatorHold(): void {
    const hold = this.callActive || this.conversationActive;
    if (hold) {
      if (this.modeBeforeHold === null) this.modeBeforeHold = this.currentInteractionMode;
      if (this.currentInteractionMode !== "facilitator") {
        const reason = this.callActive ? "live video call" : "group chat";
        this.routeModeChange({ type: "mode_change", source: "observer", timestamp: Date.now(), mode: "facilitator", reason });
      }
    } else {
      const restore = this.modeBeforeHold ?? "companion";
      this.modeBeforeHold = null;
      if (this.currentInteractionMode !== restore) {
        this.routeModeChange({ type: "mode_change", source: "observer", timestamp: Date.now(), mode: restore, reason: "call/chat ended" });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Shape-C group AAC chat (conversation room)
  // -------------------------------------------------------------------------

  /** Display name peers see for this student (first name preferred). */
  private get conversationDisplayName(): string {
    return this.currentStudentName || this.currentStudentFullName || "Friend";
  }

  /** Resolve + cache this coordinator's personId (studentId → persons.id). */
  private async ensureConversationPersonId(): Promise<string | null> {
    if (this.conversationPersonId) return this.conversationPersonId;
    if (!this.studentId) return null;
    try {
      const person = await personRepository.getOrCreateForStudent(this.studentId);
      this.conversationPersonId = person.id;
    } catch (err) {
      console.error("[AgentCoordinator] ensureConversationPersonId:", err);
      return null;
    }
    return this.conversationPersonId;
  }

  /** Join/leave the shared conversation room for a group AAC chat. */
  private async setConversationRoom(roomId: string | null): Promise<void> {
    logLiveSession("CHAT_ROOM", `coordinator setConversationRoom(${roomId}) studentId=${this.studentId} (was ${this.conversationRoomId})`);
    if (roomId === this.conversationRoomId) return;
    const personId = await this.ensureConversationPersonId();
    logLiveSession("CHAT_ROOM", `coordinator resolved personId=${personId} for studentId=${this.studentId}; ${roomId ? "JOINING" : "leaving"} room=${roomId}`);
    // Leave the previous room first.
    if (this.conversationRoomId && personId) {
      leaveConversationRoom(this.conversationRoomId, personId);
    }
    this.conversationRoomId = roomId;
    this.conversationActive = !!roomId;
    this.conversationRoster.clear();
    this.floorActiveNote = "";
    this.currentFloor = null;
    this.addresseeFocus = null;
    if (roomId && personId) {
      joinConversationRoom(roomId, {
        personId,
        name: this.conversationDisplayName,
        onUtterance: (u) => this.onPeerUtterance(u),
        onPresence: (p) => this.onPeerPresence(p),
        onRoster: (members) => this.onPeerRoster(members),
        onFloor: (s) => this.onFloor(s),
        onPeerFocus: (f) => this.onPeerFocus(f),
      });
      flowNote("COORDINATOR", `Joined conversation room ${roomId} as "${this.conversationDisplayName}".`);
    } else {
      flowNote("COORDINATOR", "Left conversation room.");
      this.pushConversationRoster(); // empty roster → client clears the header
    }
    // Stepping into a group chat is the same conversational posture as a call:
    // the AI supports the student-to-student exchange rather than chatting
    // itself. Force facilitator while in a room (released when both call + chat
    // are clear).
    this.updateFacilitatorHold();
  }

  /** A peer student voiced something. Deliver it as if it were heard speech so
   *  it flows through all the existing mode / wake / board-rebuild logic. The
   *  utterance is already attributed (it came from a known peer session), and
   *  audio is carried by the call layer — here we only drive the AI/board. */
  private onPeerUtterance(u: RoomUtterance): void {
    // Default ROOM broadcast → every recipient may reply (toUser). A targeted
    // utterance only rebuilds the addressed peer's board; others see it as
    // ambient context. Addressee is a soft hint (see shape-C eval).
    const addressedToMe = u.addressee === "ROOM" || u.addressee === this.conversationPersonId;
    logLiveSession("CHAT_ROOM", `coordinator(studentId=${this.studentId}, personId=${this.conversationPersonId}) onPeerUtterance from="${u.fromName}" addressee=${u.addressee} addressedToMe=${addressedToMe} text="${u.text}" → routeTranscribed${addressedToMe ? " (toUser → BoardManager rebuild)" : " (ambient)"}`);
    const event: TranscribedEvent = {
      type: "transcribed",
      source: "observer",
      timestamp: u.at,
      text: u.text,
      speaker: u.fromName,
      target: addressedToMe ? (this.currentStudentName || "USER") : "ROOM",
      targetIsUser: addressedToMe,
      confidence: "high",
    };
    flowNote("COORDINATOR", `Peer utterance from "${u.fromName}" (addressee=${u.addressee}) → ${addressedToMe ? "reply board" : "ambient"}.`);
    this.routeTranscribed(event);
  }

  /** A peer joined or left the room — keep the roster current and give the AI a
   *  light awareness note. */
  private onPeerPresence(p: RoomPresence): void {
    if (p.personId === this.conversationPersonId) return;
    if (p.joined) this.conversationRoster.set(p.personId, p.name);
    else {
      this.conversationRoster.delete(p.personId);
      // The peer who left was the focused addressee → clear the focus.
      if (this.addresseeFocus === p.personId) this.addresseeFocus = null;
    }
    const note = `[CHAT] ${p.name} ${p.joined ? "joined" : "left"} the group chat.`;
    this.observer?.sendContextInjection(note);
    this.speaker?.sendContextInjection(note);
    this.pushConversationRoster();
  }

  /** On join, the peers already in the room are delivered here (possibly in
   *  several batches across instances). Merge into the roster and tell the AI
   *  who's already present so a late joiner has the social context. */
  private onPeerRoster(members: RoomMember[]): void {
    const added: string[] = [];
    for (const m of members) {
      if (m.personId === this.conversationPersonId) continue;
      if (!this.conversationRoster.has(m.personId)) added.push(m.name);
      this.conversationRoster.set(m.personId, m.name);
    }
    if (added.length === 0) return;
    const note = `[CHAT] Already in the group chat: ${added.join(", ")}.`;
    this.observer?.sendContextInjection(note);
    this.speaker?.sendContextInjection(note);
    this.pushConversationRoster();
  }

  /** Send the current peer roster (name + stored-face photo) to the client so
   *  it can render the group-chat header face row. Photos are fetched
   *  best-effort + cached; the message is sent without them first if a fetch is
   *  slow, then resent once resolved. */
  private pushConversationRoster(): void {
    const peers = Array.from(this.conversationRoster.entries()).map(([personId, name]) => ({ personId, name }));
    // Send names immediately so the header appears without waiting on S3.
    this.send({ type: "conversation_roster", peers });
    if (peers.length === 0) return;
    void Promise.all(
      peers.map(async (p) => ({ ...p, photo: (await getPeerFacePhotoDataUrl(p.personId)) ?? undefined })),
    )
      .then((withPhotos) => {
        // Only resend if we're still in the same room and at least one photo
        // resolved (avoid a redundant identical message).
        if (!this.conversationRoomId) return;
        if (withPhotos.some((p) => p.photo)) {
          this.send({ type: "conversation_roster", peers: withPhotos });
        }
      })
      .catch((err) => console.error("[AgentCoordinator] pushConversationRoster photos:", err));
  }

  /** Floor/turn changed in the group chat. Advisory only — surface a concise
   *  cue to the AI ("your turn" / "wait for X" / "X asked — you can answer") so
   *  it can facilitate. Deduped, and announces the floor reopening once when a
   *  surfaced turn clears. NEVER blocks the student from pressing. */
  private onFloor(s: FloorState): void {
    this.currentFloor = s;
    // Tell the client so the header can highlight whose turn it is.
    this.send({ type: "floor_state", holder: s.holder, awaiting: s.awaiting });
    const me = this.conversationPersonId;
    const nameOf = (id: string) => this.conversationRoster.get(id) || "someone";
    let note = "";
    if (s.holder === me) {
      note = `[FLOOR] It's your turn to speak.`;
    } else if (s.holder) {
      note = `[FLOOR] It's ${nameOf(s.holder)}'s turn — let them answer.`;
    } else if (s.awaiting && s.awaiting !== me) {
      note = `[FLOOR] ${nameOf(s.awaiting)} asked the group — you can answer.`;
    }
    // else: open floor, or we're the one awaiting our own answer → not actionable.

    if (note) {
      if (note === this.floorActiveNote) return; // unchanged
      this.floorActiveNote = note;
    } else {
      // Floor went open/neutral. Announce it once if we'd surfaced a turn.
      if (!this.floorActiveNote) return;
      this.floorActiveNote = "";
      note = `[FLOOR] The floor is open — anyone may speak.`;
    }
    this.observer?.sendContextInjection(note);
    this.speaker?.sendContextInjection(note);
  }

  /** Publish a voiced utterance to the conversation room, if in one. `bid`
   *  marks a turn-handing question so the floor expects a response;
   *  `buttonAddressee` is the peer name the BoardManager tagged on the button. */
  private publishUtteranceToRoom(text: string, bid: boolean, buttonAddressee?: string): void {
    if (!this.conversationRoomId || !this.conversationPersonId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    publishRoomUtterance({
      roomId: this.conversationRoomId,
      fromPersonId: this.conversationPersonId,
      fromName: this.conversationDisplayName,
      text: trimmed,
      addressee: this.resolveUtteranceAddressee(buttonAddressee),
      bid,
      at: Date.now(),
    });
  }

  /** Decide who an outgoing utterance is addressed to (see addressee.ts for the
   *  priority stack). Always returns a peer personId in the room, or "ROOM". */
  private resolveUtteranceAddressee(buttonAddressee?: string): string {
    return resolveAddressee({
      me: this.conversationPersonId ?? "",
      roster: this.conversationRoster,
      focus: this.addresseeFocus,
      floorAwaiting: this.currentFloor?.awaiting ?? null,
      buttonAddressee,
    });
  }

  /** The student tapped/dwelt on a peer's face (personId), or cleared it
   *  (null). Set the addressee focus and nudge the BoardManager to build
   *  phrases for that peer. */
  private handleConversationFocus(personId: string | null): void {
    if (!this.conversationRoomId) return;
    if (!personId) {
      if (this.addresseeFocus) {
        this.addresseeFocus = null;
        this.speaker?.sendContextInjection(`[CHAT FOCUS] cleared — addressing the whole group again.`);
        this.broadcastFocus(null);
      }
      return;
    }
    // Only focus an actual peer who is in this room.
    if (personId === this.conversationPersonId || !this.conversationRoster.has(personId)) return;
    if (this.addresseeFocus === personId) return;
    this.addresseeFocus = personId;
    // Tell the addressed peer they're now being spoken to (symmetric with the
    // clinician-side picker).
    this.broadcastFocus(personId);
    const name = this.conversationRoster.get(personId) || "them";
    const note = `[CHAT FOCUS] The student is focused on ${name} — build replies and questions addressed specifically to ${name} (set each ${T.button}'s addressee to "${name}").`;
    this.speaker?.sendContextInjection(note);
    // Rebuild the board tailored to the focused peer.
    const focusHint: ContextUpdateEvent = {
      type: "context_update",
      source: "observer",
      timestamp: Date.now(),
      updateType: "other",
      key: "chat_focus",
      description: `The student selected ${name} in the group chat — they likely want to say something to ${name}. Offer replies AND bids (questions) addressed to ${name}; set each ${T.button}'s addressee to "${name}".`,
    };
    this.recordEvent(focusHint);
    if (this.sessionProfile === "resting") {
      void this.transitionToProfile("awake").then(() => this.invokeBoardManager([focusHint]));
    } else {
      void this.invokeBoardManager([focusHint]);
    }
  }

  /** Broadcast this student's current addressee focus to the room, so the
   *  addressed peer (and external parties like a clinician) learn of it. */
  private broadcastFocus(targetPersonId: string | null): void {
    if (!this.conversationRoomId || !this.conversationPersonId) return;
    publishRoomFocus({
      roomId: this.conversationRoomId,
      fromPersonId: this.conversationPersonId,
      fromName: this.conversationDisplayName,
      targetPersonId,
    });
  }

  /** Someone else (a peer, or a clinician on the call) declared who they're
   *  addressing. If it's THIS student, prep the board to respond to them. */
  private onPeerFocus(f: RoomFocus): void {
    if (f.targetPersonId !== this.conversationPersonId) return; // not aimed at us
    const note = `[CHAT] ${f.fromName} is now speaking to you — offer ways to respond to ${f.fromName}.`;
    this.speaker?.sendContextInjection(note);
    const focusHint: ContextUpdateEvent = {
      type: "context_update",
      source: "observer",
      timestamp: Date.now(),
      updateType: "other",
      key: "chat_addressed",
      description: `${f.fromName} just turned to address the student directly in the group chat. Offer replies and follow-up questions aimed back at ${f.fromName}.`,
    };
    this.recordEvent(focusHint);
    if (this.sessionProfile === "resting") {
      void this.transitionToProfile("awake").then(() => this.invokeBoardManager([focusHint]));
    } else {
      void this.invokeBoardManager([focusHint]);
    }
  }

  private routeModeChange(event: ModeChangeEvent): void {
    // Persist on the Coordinator so the mode survives profile
    // transitions. transitionToProfile("awake") re-broadcasts whatever
    // value lives here after the Live agents reconnect.
    const prev = this.currentInteractionMode;
    this.currentInteractionMode = event.mode;
    // Track who the user is talking to so the BoardManager can shape its palette
    // (peer → social, helper → needs). Facilitator carries the register; going
    // back to companion (talking to the AI) clears it to a balanced default.
    this.currentInterlocutorRegister = event.mode === "facilitator" ? event.register : undefined;
    // Leaving facilitator drops any pending bid-wait board (Phase B).
    if (event.mode !== "facilitator") this.clearFacilitatorBidTimer();
    flowNote(
      "COORDINATOR",
      `Mode change: ${prev} → ${event.mode}${event.register ? ` [${event.register}]` : ""}${event.reason ? ` (${event.reason})` : ""}`,
    );
    this.send({
      type: "interaction_mode_changed",
      data: { mode: event.mode, reason: event.reason, source: "ai" },
    });
    const rendered = `[MODE] ${event.mode}${event.reason ? ` — ${event.reason}` : ""}`;
    // The peer persona has no interaction-mode concept; the persisted
    // mode is re-broadcast to the restored companion Speaker on session
    // end (via primeFreshSpeaker).
    if (!this.socialPeer) this.speaker?.sendContextInjection(rendered);
    this.observer?.sendContextInjection(rendered);
  }

  private routeInterpretIntent(event: InterpretIntentEvent): void {
    // Gate: interpret() is only valid as Speaker's response to a
    // sentence_composed turn (user played the SENTENCE BUILDER's Play
    // button). Native audio's tool-calling sometimes calls interpret()
    // on regular button presses anyway, which double-voices the user's
    // SENTENCE. Server-side drop on a wrong context.
    if (this.lastUserInputType !== "sentence_composed") {
      flowNote(
        "SPEAKER",
        `Dropped spurious interpret_intent (lastInput=${this.lastUserInputType}; expected sentence_composed). sentence="${event.sentence}"`,
      );
      // Inform Speaker that the call was rejected so it doesn't keep
      // retrying. No TTS, no re-injection of the SENTENCE.
      this.speaker?.sendContextInjection(
        `[INTERPRET REJECTED] interpret() is only valid after a [${T.tagComposed}] turn. The most recent user input was a ${this.lastUserInputType === "button_pressed" ? `[${T.tagPress}] (the device already voiced it; do NOT call interpret)` : "transcript / context update"}. Respond normally instead.`,
      );
      // Nothing will be voiced — drop the "interpreting" indicator so the
      // builder doesn't hang (the client also has its own timeout).
      this.clearInterpretBusy();
      return;
    }
    // Consume the sentence_composed context so a duplicate interpret on
    // the same turn is also blocked.
    this.lastUserInputType = "none";

    // Stream the user's interpreted sentence through student-voice TTS.
    // The interpretation resolved and the voice is starting — drop the
    // "interpreting" indicator (the client also closes the builder the
    // moment the first utterance-audio chunk plays).
    this.clearInterpretBusy();
    void this.streamStudentTts(event.sentence, "interpret_intent");
    // Inject OWN_SPEECH (tagged as student-voice) so Observer doesn't
    // transcribe the device speakers as a fresh user statement.
    this.observer?.sendContextInjection(`[OWN_SPEECH] (student voice) ${event.sentence}`);
    this.appendToConversationLog("user", `[${T.tagPress}] "${event.sentence}"`);

    if (this.socialPeer) {
      // SOCIAL TRAINER: the composed SENTENCE is the user's contribution to
      // the conversation — drive the peer's turn through the SAME bid path a
      // normal board press uses (proper turn timing + deferred follow-up
      // board). Routing it via speaker.sendUserTurn directly would bypass the
      // bid/reply buffering in handleSocialTrainerPress and desync the turn.
      this.handleSocialTrainerPress({
        type: "button_pressed",
        source: "client",
        timestamp: Date.now(),
        label: event.sentence,
        sentence: event.sentence,
        target: "DEVICE",
        role: "bid",
      });
      return;
    }

    // Echo back to Speaker.
    this.speaker?.sendContextInjection(`[INTERPRET] (you voiced for the user) ${event.sentence}`);
    // Re-deliver as a [BUTTON PRESS] so Speaker can respond on a later turn.
    this.speakerRespond(`[${T.tagPress}] "${event.sentence}"`);
    // Trigger Board Manager rebuild for the follow-up surface.
    this.invokeBoardManager([event]);
  }

  /** Build + send a session_snapshot carrying the apps lists so the client's
   *  Apps board can render them. Local-storage persistence is deferred in the
   *  3-agent path (config.localStorageEnabled=false) — the snapshot is used
   *  purely to deliver enabledApps/availableCustomApps for now; full
   *  persistence parity is a separate follow-up. */
  private sendAppsSnapshot(): void {
    const cache = dualAgentService.getSessionCache(this.sessionId!);
    const state = cache?.state;
    if (!state) return;

    const enabledAppsForClient = (state.appState?.enabledApps || [])
      .map((id) => getAppDefinition(id))
      .filter((a): a is AACAppDefinition => !!a)
      .map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.icon,
        // Apps that need the server to assemble their open payload must route a
        // student tap through the request_app_open round-trip instead of
        // launching locally:
        //  - apps with a startup spec → server resolves startup params, EXCEPT
        //    social_trainer, which is server-managed via its own
        //    social_trainer_started message (keep its flag false).
        //  - youtube → server attaches the permitted channels/playlists/videos
        //    (routeAppOpen). Without the round-trip the client launches with no
        //    payload and always shows the "unavailable" screen.
        needsStartupResolution:
          a.id === "youtube" || (!!a.startup && a.id !== "social_trainer"),
      }));

    const snapshot: import("@shared/aac-local-storage").AacSessionSnapshot = {
      sessionId: state.sessionId,
      studentId: state.studentId,
      userId: state.userId,
      messages: state.messages,
      pendingMessages: state.pendingMessages.map((pm) => ({
        role: pm.role,
        content: pm.content,
        timestamp: pm.timestamp,
      })),
      muteState: state.muteState,
      currentBoard: state.currentBoard || null,
      boardButtonLabels: state.boardButtonLabels,
      aiAddedButtonLabels: state.aiAddedButtonLabels,
      loadedBoardId: state.loadedBoardId,
      currentPageId: state.currentPageId,
      enabledApps: enabledAppsForClient.length ? enabledAppsForClient : undefined,
      availableCustomApps: state.availableCustomApps,
      // Website tiles ride the snapshot alongside the app lists so they don't
      // depend on the client's separate REST profile fetch succeeding.
      permittedWebsites: this.permittedWebsites,
      timestamp: Date.now(),
    };

    this.send({
      type: "session_snapshot",
      snapshot,
      // Persistence deferred for the 3-agent path — see method doc.
      config: { localStorageEnabled: false, remoteStorageEnabled: true, encryptionKey: null },
    });
  }

  /**
   * Assemble the resolver context from already-computed session state — the
   * SAME student material the live agents see (persona, goals, memory, summary)
   * plus recent/pending turns. No recompute, no extra DB load. The billing sink
   * is pre-bound to this session so the resolver only emits token counts.
   */
  private buildStartupResolveContext(
    spec: AppStartupSpec,
    trigger: { source: "ai" | "student"; data?: string },
  ): StartupResolveContext {
    const cache = this.sessionId ? dualAgentService.getSessionCache(this.sessionId) : undefined;
    const state = cache?.state;
    const student = cache?.monitorAgent.getStudent?.();
    const sections = state?.enhancedSections;
    const language = student?.primaryLanguage || undefined;

    const sessionId = this.sessionId ?? "";
    const studentId = this.studentId ?? "";
    const userId = this.userId;

    return {
      spec,
      trigger,
      studentDisplayName: student?.firstName || student?.name?.split(" ")[0] || undefined,
      languageName: language ? getLanguageName(language) : undefined,
      persona: sections?.persona,
      sessionGoals: sections?.sessionGoals,
      memoryContext: state?.memoryContext,
      sessionSummary: state?.sessionSummary,
      recentTurns: this.conversationLog.slice(-8).map((t) => ({ role: t.role, content: t.content })),
      pendingTurns: (state?.pendingMessages ?? []).map((m) => ({ role: m.role, content: m.content })),
      trackUsage: (prompt, completion, cached, model) => {
        void dualAgentService
          .trackHttpUsage(sessionId, studentId, userId, "gemini", model, prompt, completion, cached, "startup-resolver")
          .catch((err) => console.error("[AgentCoordinator] trackHttpUsage(startup-resolver) failed:", err));
      },
    };
  }

  /** Resolve an app's startup params (or defaults). Thin wrapper around the
   *  resolver that builds the context from session state. */
  private async resolveStartupParams(
    spec: AppStartupSpec,
    source: "ai" | "student",
    data?: string,
  ): Promise<{ params: StartupParams; resolverNote?: string }> {
    const result = await resolveAppStartupParams(this.buildStartupResolveContext(spec, { source, data }));
    return { params: result.params, resolverNote: result.resolverNote };
  }

  /**
   * Student pressed an app that declares startup params (request_app_open). The
   * client deferred to the server so params can be resolved before the app
   * renders. Wake an idle session (a press is engagement), then run the exact
   * same routeAppOpen path the AI's open_app uses — only the source differs.
   */
  private async handleStudentAppOpen(appId: string, appData?: unknown): Promise<void> {
    if (this.state !== "ready" || !this.sessionId) return;
    if (this.asleep) await this.wakeFromSleep();
    if (this.sessionProfile === "resting") await this.transitionToProfile("awake");
    this.noteEngagementActivity();
    await this.routeAppOpen({
      type: "app_open_requested",
      source: "client",
      timestamp: Date.now(),
      appId,
      data: typeof appData === "string" ? appData : undefined,
    });
  }

  private async routeAppOpen(event: AppOpenRequestedEvent): Promise<void> {
    const appId = event.appId;
    const triggerSource: "ai" | "student" = event.source === "client" ? "student" : "ai";
    if (appId === "social_trainer") {
      // Not a client-rendered app: the social trainer replaces the
      // Speaker with a peer persona server-side. The client only renders
      // the peer's face in the header (driven by the social_session
      // message sent from startSocialPeerSession). Startup params are
      // resolved INSIDE startSocialPeerSession so all entry points
      // (AI open_app, client social_trainer_started) get tuned peers.
      void this.startSocialPeerSession(triggerSource === "ai" ? "speaker_open_app" : "client_launch");
      return;
    }

    // Built-in AAC app? (drawing, music, youtube, games, …)
    const builtIn = getAppDefinition(appId);
    if (builtIn) {
      if (appId === "youtube") {
        // Browse mode needs the permitted channels/videos/playlists in the
        // payload (the client RSS-fetches each channel's recent uploads). The
        // legacy search-to-play path (data → resolved videoId) is not yet
        // ported here — when content exists we open the browse UI; otherwise
        // we tell the Speaker so it can redirect the user.
        const cache = dualAgentService.getSessionCache(this.sessionId!);
        const st = cache?.state;
        const channels = st?.permittedYoutubeChannels || [];
        const videos = st?.permittedYoutubeVideos || [];
        const playlists = st?.permittedYoutubePlaylists || [];
        if (channels.length || videos.length || playlists.length) {
          this.send({ type: "app_open", data: { appId: "youtube", appData: { channels, videos, playlists } } });
        } else if (event.data) {
          // No curated content but the AI passed a query — let the client search.
          this.send({ type: "app_open", data: { appId: "youtube", data: event.data } });
        } else {
          this.speaker?.sendContextInjection(
            `[APP OPEN FAILED] YouTube has no permitted channels, playlists, or videos configured and no search query was given — tell the user this activity isn't available right now and suggest something else.`,
          );
          return;
        }
      } else {
        // Apps with a startup definition get intelligently-chosen params
        // (e.g. space_trader's startLevel) resolved before launch. Apps
        // without one open instantly with no params, exactly as before.
        let params: StartupParams | undefined;
        let resolverNote: string | undefined;
        if (builtIn.startup) {
          const r = await this.resolveStartupParams(builtIn.startup, triggerSource, event.data);
          params = r.params;
          resolverNote = r.resolverNote;
        }
        this.send({
          type: "app_open",
          data: { appId, data: event.data, ...(params ? { appData: { params } } : {}) },
        });
        if (resolverNote) {
          this.speaker?.sendContextInjection(`[APP STARTUP] ${appId}: ${resolverNote}`);
        }
      }
      this.speaker?.sendContextInjection(`[APP OPEN] ${appId}${event.data ? ` (${event.data})` : ""}`);
      this.invokeBoardManager([event]);
      return;
    }

    // Otherwise treat it as a custom app id — resolve + validate the definition
    // and ship the renderable payload (the client renders custom apps only when
    // it receives { appId: "custom_app", appData: { id, definition } }, or the
    // dedicated goal-tree payload). Mirrors the legacy live-relay open_app path.
    try {
      const app = await customAppRepository.getApp(appId);
      if (!app) {
        this.speaker?.sendContextInjection(`[APP OPEN FAILED] app ${appId} not found — tell the user it isn't available.`);
        return;
      }
      if (isGoalTreeApp(app)) {
        const prepared = prepareGoalTreeAppOpen(app);
        if (!prepared.ok) {
          this.speaker?.sendContextInjection(`[APP OPEN FAILED] ${prepared.error}`);
          return;
        }
        this.send({ type: "app_open", data: prepared.payload });
        // Light startup tuning: resolve how the companion should frame the
        // quest for this student and fold it into the AI's context note. The
        // certified game payload is unchanged (no client plumbing).
        const { params } = await this.resolveStartupParams(goalTreeStartupSpec(), triggerSource);
        const note = goalTreeStartupNote(params);
        if (note) this.speaker?.sendContextInjection(`[GAME STARTUP]${note}`);
      } else {
        const validation = validateCustomAppDefinition(app.definition);
        if (!validation.ok) {
          this.speaker?.sendContextInjection(
            `[APP OPEN FAILED] custom app "${app.name}" definition is invalid: ${validation.errors.slice(0, 2).join("; ")}`,
          );
          return;
        }
        this.send({
          type: "app_open",
          data: { appId: "custom_app", appData: { id: app.id, definition: validation.data } },
        });
      }
      this.speaker?.sendContextInjection(`[APP OPEN] ${app.name}`);
      this.invokeBoardManager([event]);
    } catch (err) {
      logLiveSession("APP_OPEN_FAILED", `${appId}: ${String(err)}`);
      this.speaker?.sendContextInjection(`[APP OPEN FAILED] couldn't open the app — tell the user and suggest something else.`);
    }
  }

  private routeAppClose(event: AppCloseRequestedEvent): void {
    if (this.socialPeer) {
      // The peer said its goodbye and called close_app() — end the
      // session, restore the companion Speaker, and debrief.
      void this.endSocialPeerSession("peer_close_app");
      return;
    }
    this.send({ type: "app_close", data: {} });
    this.speaker?.sendContextInjection(`[APP CLOSE]`);
    this.invokeBoardManager([event]);
  }

  // -------------------------------------------------------------------------
  // Social-training session (peer persona replaces Speaker)
  // -------------------------------------------------------------------------

  /**
   * Start a social-training session: park the companion Speaker and put a
   * procedurally-generated PEER persona in the Speaker slot. Observer and
   * BoardManager keep running unchanged — presses route to the peer, its
   * speech drives board rebuilds, exactly like the companion.
   *
   * Entry points: Speaker's open_app("social_trainer") tool call, or the
   * client's social_trainer_started message (apps surface / debug).
   */
  /** Construct (not start) a social peer with the standard coordinator
   *  callbacks — shared by the normal launch and the debug reconfigure. */
  private buildPeerAgent(opts: {
    persona: GeneratedPersona;
    languageName: string;
    model: string;
    difficulty?: number;
    languageLevel?: LanguageLevel;
    slpConfig: SlpConfig;
    addresseeGender?: "male" | "female";
  }): SocialPeerSpeakerAgent {
    // Captured for the usage closure — billing must survive teardown races.
    const usageSessionId = this.sessionId ?? "";
    const usageStudentId = this.studentId ?? "";
    const usageUserId = this.userId;
    return new SocialPeerSpeakerAgent({
      persona: opts.persona,
      languageName: opts.languageName,
      model: opts.model,
      difficulty: opts.difficulty,
      languageLevel: opts.languageLevel,
      slpConfig: opts.slpConfig,
      addresseeGender: opts.addresseeGender,
      callbacks: {
        onEvent: (e) => this.onSpeakerEvent(e),
        onSpeakText: (text) => this.onSpeakerSpeakText(text),
        onState: (state) => this.send({ type: "social_peer_state", data: state }),
        onUsage: (usage) => {
          dualAgentService.trackHttpUsage(
            usageSessionId, usageStudentId, usageUserId, "gemini", opts.model,
            usage.promptTokens, usage.completionTokens, usage.cachedTokens ?? 0, "social-peer",
          ).catch(err => console.error("[AgentCoordinator] trackHttpUsage(social peer) failed:", err));
        },
        // DEBUG-only: ship the full director internals to the client each turn.
        onDebug: (snapshot) => { if (this.debugMode) this.send({ type: "social_peer_debug", data: snapshot }); },
        // The user wound the conversation down — end the session after the
        // peer's farewell finishes (restores companion + runs the debrief).
        onConversationEnd: () => this.scheduleNaturalSocialEnd(),
        onError: (err) => console.error("[AgentCoordinator] Social peer error:", err),
      },
    });
  }

  /** Construct (not start) a LIVE-AUDIO social peer: the director engine runs
   *  the HTTP analysis while a native-audio live session voices the replies.
   *  Audio/transcription/event callbacks route to the SAME coordinator handlers
   *  the companion live Speaker uses, so PCM lands as `avatar_audio`, board
   *  rebuilds fire off the peer's transcript, and barge-in works unchanged. */
  private buildLivePeerAgent(opts: {
    persona: GeneratedPersona;
    languageName: string;
    analysisModel: string;
    liveModel: string;
    voiceName: string;
    difficulty?: number;
    languageLevel?: LanguageLevel;
    slpConfig: SlpConfig;
    addresseeGender?: "male" | "female";
  }): LiveSocialPeerSpeakerAgent {
    const usageSessionId = this.sessionId ?? "";
    const usageStudentId = this.studentId ?? "";
    const usageUserId = this.userId;
    return new LiveSocialPeerSpeakerAgent({
      persona: opts.persona,
      languageName: opts.languageName,
      analysisModel: opts.analysisModel,
      liveModel: opts.liveModel,
      voiceName: opts.voiceName,
      useVertex: this.useVertex,
      difficulty: opts.difficulty,
      languageLevel: opts.languageLevel,
      slpConfig: opts.slpConfig,
      addresseeGender: opts.addresseeGender,
      compressionTriggerTokens: AWAKE_COMPRESSION_TRIGGER,
      compressionTargetTokens: AWAKE_COMPRESSION_TARGET,
      callbacks: {
        onEvent: (e) => this.onSpeakerEvent(e),
        onAudioChunk: (d) => this.onSpeakerAudioChunk(d),
        onSuppressAudio: () => this.onSpeakerSuppressAudio(),
        onState: (state) => this.send({ type: "social_peer_state", data: state }),
        // Speaking session (native audio) — billed as live usage.
        onLiveUsage: (usage) => this.trackLiveUsage("speaker", "gemini", opts.liveModel, usage),
        // Director analysis (HTTP forced-tool) — billed as HTTP usage.
        onAnalysisUsage: (usage) => {
          dualAgentService.trackHttpUsage(
            usageSessionId, usageStudentId, usageUserId, "gemini", opts.analysisModel,
            usage.promptTokens, usage.completionTokens, usage.cachedTokens ?? 0, "social-peer-analysis",
          ).catch(err => console.error("[AgentCoordinator] trackHttpUsage(live social peer) failed:", err));
        },
        onDebug: (snapshot) => { if (this.debugMode) this.send({ type: "social_peer_debug", data: snapshot }); },
        onConversationEnd: () => this.scheduleNaturalSocialEnd(),
        onError: (err) => console.error("[AgentCoordinator] Live social peer error:", err),
      },
    });
  }

  /** The director flagged the user wants to end — let the farewell play, then
   *  wind the session down (restore companion + debrief). Single-flight. */
  private naturalEndPending = false;
  private scheduleNaturalSocialEnd(): void {
    if (!this.socialPeer || this.socialPeerTransition || this.naturalEndPending) return;
    this.naturalEndPending = true;
    const farewellTts = this.aiTtsChain; // the goodbye TTS just queued
    flowNote("COORDINATOR", "Natural end requested — winding down after the farewell plays.");
    void (async () => {
      try { await farewellTts; } catch { /* farewell TTS failed — end anyway */ }
      // Grace so the last audio frame plays out on the client before the app closes.
      await new Promise((r) => setTimeout(r, 1200));
      this.naturalEndPending = false;
      void this.endSocialPeerSession("natural_end");
    })();
  }

  /** DEBUG-only: restart the active social peer with fully custom parameters
   *  from the client debug dialog. Bypasses the startup resolver entirely. */
  private async applyPeerReconfigure(params: SocialPeerParams): Promise<void> {
    if (!this.debugMode) { flowNote("COORDINATOR", "social_peer_reconfigure ignored — not in debug mode"); return; }
    if (!this.socialPeer || this.socialPeerTransition) {
      flowNote("COORDINATOR", "social_peer_reconfigure ignored — no active social session / mid-transition");
      return;
    }
    this.socialPeerTransition = true;
    try {
      const sessionCache = this.sessionId ? dualAgentService.getSessionCache(this.sessionId) : undefined;
      const student = sessionCache?.monitorAgent.getStudent?.();
      const language = student?.primaryLanguage || "en";
      const aac = student?.aacSettings as any;

      // Build a persona directly from the supplied params; keep the previous
      // appearance so the face stays stable while you tweak personality.
      const persona: GeneratedPersona = {
        name: params.name,
        gender: params.gender,
        archetype: params.archetype as Archetype,
        genome: { ...params.genome },
        identity: { interests: { ...params.interests }, stances: { ...params.stances } },
        appearance: this.socialPeer.persona.appearance,
        humorStyle: params.humorStyle as GeneratedPersona["humorStyle"],
      };

      const voiceName = pickSocialPeerVoice(persona.gender, [
        this.aiVoice?.geminiVoiceName, this.studentVoice?.geminiVoiceName,
        aac?.geminiAiVoice, aac?.geminiStudentVoice,
      ]);
      const voice: ResolvedVoice = {
        fallbackType: persona.gender === "female" ? "woman" : "man",
        customVoice: null, language, geminiVoiceName: voiceName,
      };

      try { this.speaker?.close(); } catch {}
      this.speaker = null;
      this.speakerSpeaking = false;

      const peerModel = params.model || process.env.AAC_SPEAKER_HTTP_MODEL || BOARD_MANAGER_DEFAULT_MODEL;
      const peer = this.buildPeerAgent({
        persona,
        languageName: getLanguageName(language),
        model: peerModel,
        difficulty: params.difficulty,
        languageLevel: languageLevelFromInt(params.languageLevelInt),
        slpConfig: buildSlpConfig({
          targetSkills: params.slp.goalDimensions,
          lockedSkills: params.slp.lockedDimensions,
          maxChallengeIntensity: params.slp.maxChallengeIntensity,
          challengeRatio: params.slp.challengeRatio,
        }),
      });
      await peer.start();
      this.speaker = peer;
      this.socialPeer = {
        persona, agent: peer, voiceName, voice,
        logStartIndex: this.conversationLog.length, startedAt: Date.now(),
      };

      flowNote("COORDINATOR", `Social peer reconfigured (debug) → "${persona.name}" ${describePersona(persona)}`);
      // Re-render the peer face + re-arm the openers board for a fresh start.
      this.send({
        type: "social_session",
        data: {
          state: "started", characterName: persona.name, voiceName,
          appearance: persona.appearance, expressiveness: persona.genome.expressiveness, legibility: 1,
          voicePitch: this.peerVoicePitch(),
          voiceFormant: this.peerVoiceFormant(),
        },
      });
      this.observer?.sendContextInjection(`[SOCIAL TRAINING RECONFIGURED] The practice peer is now ${persona.name}. The device voice is ${persona.name}, not the companion AI.`);
      const greetingTrigger: MonitorBroadcastEvent = {
        type: "monitor_broadcast", source: "monitor", timestamp: Date.now(),
        contextInjection: `The social-practice peer was just reset to ${persona.name}, waiting for the user to start the conversation. Rebuild the board with generic openers (greetings, simple ice-breakers, a way to introduce themselves).`,
      };
      this.recordEvent(greetingTrigger);
      void this.invokeBoardManager([greetingTrigger]);
    } catch (err) {
      console.error("[AgentCoordinator] applyPeerReconfigure failed:", err);
    } finally {
      this.socialPeerTransition = false;
    }
  }

  /** Build a peer identity (persona + gender-matched voice) from optional
   *  persona hints. Voice excludes the AAC AI + student voices so the peer is
   *  distinct. Shared by the live session and the home-board preview. */
  private makePeerIdentity(
    personaOpts: { archetype?: Archetype; gender?: "male" | "female"; interestHints?: string[] },
    language: string,
    aac: any,
  ): { persona: GeneratedPersona; voiceName: string; voice: ResolvedVoice } {
    const persona = generatePersona(personaOpts);
    const voiceName = pickSocialPeerVoice(persona.gender, [
      this.aiVoice?.geminiVoiceName,
      this.studentVoice?.geminiVoiceName,
      aac?.geminiAiVoice,
      aac?.geminiStudentVoice,
    ]);
    const voice: ResolvedVoice = {
      fallbackType: persona.gender === "female" ? "woman" : "man",
      customVoice: null,
      language,
      geminiVoiceName: voiceName,
    };
    return { persona, voiceName, voice };
  }

  /** Prepare + push the "Practice friend" preview face. Idempotent: reuses the
   *  existing pending persona (so navigating home doesn't reshuffle the face);
   *  generates a fresh one only when none is pending. No-op when the app is
   *  disabled or a session is active/transitioning. */
  private preparePeerPreview(reason: string): void {
    if (!this.isSocialTrainerEnabled()) return;
    if (this.socialPeer || this.socialPeerTransition) return;
    if (!this.pendingPeerPersona) {
      const cache = this.sessionId ? dualAgentService.getSessionCache(this.sessionId) : undefined;
      const student = cache?.monitorAgent.getStudent?.();
      const language = student?.primaryLanguage || "en";
      const aac = student?.aacSettings as any;
      this.pendingPeerPersona = this.makePeerIdentity({}, language, aac);
      flowNote("COORDINATOR", `Peer preview persona generated (${reason}) → "${this.pendingPeerPersona.persona.name}".`);
    }
    const p = this.pendingPeerPersona.persona;
    this.send({
      type: "social_peer_preview",
      data: {
        appearance: p.appearance,
        characterName: p.name,
        expressiveness: p.genome.expressiveness,
      },
    });
  }

  private async startSocialPeerSession(origin: string): Promise<void> {
    if (this.state !== "ready" || !this.sessionId) return;
    if (this.socialPeer || this.socialPeerTransition) {
      flowNote("COORDINATOR", `Social session start ignored (${origin}) — already ${this.socialPeer ? "active" : "transitioning"}.`);
      return;
    }
    this.socialPeerTransition = true;
    try {
      // Social practice is engagement — make sure both Live agents exist.
      if (this.asleep) await this.wakeFromSleep();
      if (this.sessionProfile === "resting") await this.transitionToProfile("awake");
      this.noteEngagementActivity();

      const sessionCache = dualAgentService.getSessionCache(this.sessionId);
      const student = sessionCache?.monitorAgent.getStudent?.();
      const language = student?.primaryLanguage || "en";
      const aac = student?.aacSettings as any;
      // The STUDENT's grammatical gender — so the peer addresses them with the
      // correct feminine/masculine forms in gendered languages (Hebrew, etc.).
      const sg = (student as any)?.gender;
      const studentGender: "male" | "female" | undefined =
        sg === "male" || sg === "female" ? sg : undefined;

      // Resolve startup params so the peer is tuned to THIS student and the
      // current conversation (gender, personality, shared interests, challenge
      // level, scenario). Runs for every entry point (AI open_app + client
      // launch); falls back to a random persona if resolution yields nothing.
      const startupSpec = getAppDefinition("social_trainer")?.startup;
      let peerDifficulty: number | undefined;
      let practiceScenario: string | undefined;
      let aiTargetSkills: Competency[] = [];
      let personaOpts: { archetype?: Archetype; gender?: "male" | "female"; interestHints?: string[] } = {};
      if (startupSpec) {
        const { params } = await this.resolveStartupParams(
          startupSpec,
          origin === "speaker_open_app" ? "ai" : "student",
        );
        const g = params.genderHint;
        const a = params.archetypeHint;
        personaOpts = {
          gender: g === "male" || g === "female" ? g : undefined,
          archetype: typeof a === "string" && a !== "any" ? (a as Archetype) : undefined,
          interestHints: Array.isArray(params.interestHints)
            ? (params.interestHints as unknown[]).filter((x): x is string => typeof x === "string")
            : undefined,
        };
        const diffMap: Record<string, number> = { gentle: 0.25, medium: 0.45, challenging: 0.65 };
        peerDifficulty = typeof params.difficulty === "string" ? diffMap[params.difficulty] : undefined;
        practiceScenario = typeof params.scenario === "string" ? params.scenario : undefined;
        // AI's optional session focus. Schema-validated to the competency enum,
        // but re-filter defensively.
        aiTargetSkills = Array.isArray(params.targetSkills)
          ? (params.targetSkills as unknown[]).filter(
              (x): x is Competency => typeof x === "string" && (COMPETENCIES as string[]).includes(x),
            )
          : [];
      }

      // SLP config: clinician per-app defaults (appConfig.social_trainer) supply
      // the goal set, the locked floor, and the challenge ceiling; the AI's
      // targetSkills, when present, narrow the focus on top. buildSlpConfig
      // enforces the locks regardless of what the AI picked.
      const socialCfg = ((aac?.appConfig as Record<string, any> | undefined)?.social_trainer ?? {}) as {
        targetSkills?: Competency[];
        lockedSkills?: Competency[];
        maxChallengeIntensity?: number;
      };
      const effectiveTargets = aiTargetSkills.length ? aiTargetSkills : (socialCfg.targetSkills ?? []);
      const peerSlp = buildSlpConfig({
        targetSkills: effectiveTargets,
        lockedSkills: socialCfg.lockedSkills,
        maxChallengeIntensity: socialCfg.maxChallengeIntensity,
      });

      // Reuse the home-board preview identity when present so the session face
      // matches the button the user pressed (the resolver above still tunes the
      // ENGINE — difficulty/scenario/skills — which doesn't affect the face).
      // Generate fresh only when there's no preview (e.g. a pure AI open_app).
      const identity = this.pendingPeerPersona ?? this.makePeerIdentity(personaOpts, language, aac);
      this.pendingPeerPersona = null;
      const { persona, voiceName, voice } = identity;

      // Park the companion Speaker. Its context is rebuilt from
      // conversationLog + session summary on restore (primeFreshSpeaker),
      // the same way the resting→awake transition recovers it.
      try { this.speaker?.close(); } catch {}
      this.speaker = null;
      this.speakerSpeaking = false;

      // The director's analysis (forced-tool classification) ALWAYS runs on the
      // HTTP chat-completion path. Reply AUTHORING is either:
      //   - HTTP text → server TTS (default), or
      //   - a live native-audio session (decoupled live-audio peer) when the
      //     clinician enabled it AND a live-capable aac_chat model is configured.
      const peerModel = process.env.AAC_SPEAKER_HTTP_MODEL || BOARD_MANAGER_DEFAULT_MODEL;
      // Inherit the student's general AAC language level (sentence length/
      // complexity) so the peer talks at the same register as the companion.
      const peerLanguageLevel = languageLevelFromInt(aac?.languageLevel);
      const peerLanguageName = getLanguageName(language);

      // Resolve whether to use the live-audio peer.
      const socialLiveRequested = !!((aac?.appConfig as Record<string, any> | undefined)?.social_trainer?.liveAudio);
      let liveModel = "";
      let useLivePeer = false;
      if (socialLiveRequested) {
        const aacChat = await settingsRepository.getLLMConfig("aac_chat");
        liveModel = process.env.AAC_SPEAKER_MODEL || aacChat.model;
        useLivePeer = aacChat.provider === "gemini"
          && (liveModel.includes("native-audio") || liveModel.includes("live"));
        if (!useLivePeer) {
          flowNote("COORDINATOR", `Live social peer requested but model "${liveModel}" (provider=${aacChat.provider}) isn't live-capable — using HTTP peer.`);
        }
      }

      const peer: SocialPeerSpeakerAgent | LiveSocialPeerSpeakerAgent = useLivePeer
        ? this.buildLivePeerAgent({
            persona,
            languageName: peerLanguageName,
            analysisModel: peerModel,
            liveModel,
            voiceName,
            difficulty: peerDifficulty,
            languageLevel: peerLanguageLevel,
            slpConfig: peerSlp,
            addresseeGender: studentGender,
          })
        : this.buildPeerAgent({
            persona,
            languageName: peerLanguageName,
            model: peerModel,
            difficulty: peerDifficulty,
            languageLevel: peerLanguageLevel,
            // Goal/locked dimensions + challenge ceiling (clinician defaults
            // narrowed by the AI's optional session focus).
            slpConfig: peerSlp,
            addresseeGender: studentGender,
          });
      await peer.start();
      this.speaker = peer;
      // Fresh turn-taking history for the new peer (don't carry a pre-session
      // bid into the first social press — Phase C).
      this.lastPressRole = null;
      this.socialPeer = {
        persona,
        agent: peer,
        voiceName,
        voice,
        logStartIndex: this.conversationLog.length,
        startedAt: Date.now(),
      };

      runInSessionContext(this.sessionId, this.debugMode, () => {
        logLiveSession("SOCIAL PEER START", `${origin}: path=${useLivePeer ? `live(${liveModel})` : "http"} analysis=${peerModel} voice=${voiceName} ${describePersona(persona)}`);
      });
      flowNote("COORDINATOR", `Social-training session started (${origin}) — director peer "${persona.name}" replaces Speaker (${useLivePeer ? "LIVE audio" : "HTTP text→TTS"}).`);

      // Client: open the (header-only) app surface and ship the face data.
      // The live peer speaks via native audio, so the TTS pitch/formant age
      // shaping doesn't apply — send neutral (0) shifts in that case.
      this.send({ type: "app_open", data: { appId: "social_trainer" } });
      this.send({
        type: "social_session",
        data: {
          state: "started",
          characterName: persona.name,
          voiceName,
          appearance: persona.appearance,
          expressiveness: persona.genome.expressiveness,
          legibility: 1,
          voicePitch: useLivePeer ? 0 : this.peerVoicePitch(),
          voiceFormant: useLivePeer ? 0 : this.peerVoiceFormant(),
        },
      });

      const scenarioPhrase: Record<string, string> = {
        greeting: "greeting someone new",
        making_friends: "making a new friend",
        sharing_interests: "sharing what they like",
        handling_disagreement: "handling a friendly disagreement",
        joining_a_group: "joining a group conversation",
      };
      const scenarioFocus =
        practiceScenario && scenarioPhrase[practiceScenario]
          ? ` The focus for this session is ${scenarioPhrase[practiceScenario]}.`
          : "";

      // Observer must re-attribute the device voice while the peer talks.
      this.observer?.sendContextInjection(
        `[SOCIAL TRAINING STARTED] The user is practicing conversation with a virtual peer named ${persona.name}. The device voice is now ${persona.name} (a practice character), not the companion AI.${scenarioFocus}`,
      );
      this.appendToConversationLog("system", `[SOCIAL TRAINING STARTED] peer=${persona.name}${practiceScenario ? ` scenario=${practiceScenario}` : ""}`);

      // The STUDENT opens the conversation (the director's initiation
      // competency depends on it — the engine deliberately doesn't greet
      // first). Trigger BoardManager to build a greeting board so the
      // user has openers to press. monitor_broadcast renders as
      // [MONITOR CONTEXT] in BM's event view.
      const greetingTrigger: MonitorBroadcastEvent = {
        type: "monitor_broadcast",
        source: "monitor",
        timestamp: Date.now(),
        contextInjection: `A social-practice session just started: a virtual peer named ${persona.name} is on screen, waiting for the user to start the conversation.${scenarioFocus} Rebuild the board with generic openers the user can press: greetings ("Hi", "Hello"), simple ice-breakers ("What's your name?", "How are you?"), and a way to introduce themselves. Do not include any specific person's name.`,
      };
      this.recordEvent(greetingTrigger);
      void this.invokeBoardManager([greetingTrigger]);
    } catch (err) {
      console.error("[AgentCoordinator] startSocialPeerSession failed:", err);
      this.socialPeer = null;
      this.send({ type: "social_session", data: { state: "ended", reason: "start_failed" } });
      this.send({ type: "app_close", data: {} });
      // Restore the companion Speaker so the session isn't left mute —
      // closing any half-installed peer first.
      try { this.speaker?.close(); } catch {}
      this.speaker = null;
      try {
        await this.restoreCompanionSpeaker();
      } catch (restoreErr) {
        console.error("[AgentCoordinator] companion restore after failed social start also failed:", restoreErr);
      }
    } finally {
      this.socialPeerTransition = false;
    }
  }

  /**
   * End the active social-training session: tear down the peer, run the
   * social-skill analysis over the session transcript, restore the
   * companion Speaker (with full conversation context via the log
   * replay), and hand it a debrief directive so it discusses the
   * conversation with the user.
   */
  private async endSocialPeerSession(reason: string): Promise<void> {
    const social = this.socialPeer;
    if (!social || this.socialPeerTransition) return;
    this.socialPeerTransition = true;
    this.socialPeer = null;
    this.naturalEndPending = false;
    // Drop any in-flight Phase B press buffers — they belong to the peer.
    if (this.socialReplyBuffer?.timer) clearTimeout(this.socialReplyBuffer.timer);
    this.socialReplyBuffer = null;
    const peerName = social.persona.name;
    try {
      flowNote("COORDINATOR", `Social-training session ending (${reason}) — peer "${peerName}".`);

      // Pull the director's structured report (competencies, moments,
      // final mode/rapport) before tearing the agent down.
      const report = social.agent.getReport();

      // Tear down the peer Speaker.
      this.flushSpeakerAudio();
      try { this.speaker?.close(); } catch {}
      this.speaker = null;
      this.speakerSpeaking = false;

      // Client: face comes down, app surface closes.
      this.send({ type: "social_session", data: { state: "ended", reason } });
      this.send({ type: "app_close", data: {} });

      this.appendToConversationLog("system", `[SOCIAL TRAINING ENDED] peer=${peerName} reason=${reason}`);
      this.observer?.sendContextInjection(
        `[SOCIAL TRAINING ENDED] The practice conversation with ${peerName} is over. The device voice is the companion AI again.`,
      );

      // Social-skill analysis over the session slice of the conversation
      // log. Run BEFORE restoring the Speaker so the debrief directive
      // can carry it; analysis failure degrades to a plain debrief.
      const transcriptLines = this.conversationLog
        .slice(social.logStartIndex)
        .filter(t => t.role !== "system")
        .map(t => t.content);
      let analysis: string | null = null;
      if (transcriptLines.length > 0) {
        const analysisModel = process.env.AAC_SPEAKER_HTTP_MODEL || BOARD_MANAGER_DEFAULT_MODEL;
        try {
          const result = await runSocialSkillAnalysis({
            providerKey: "gemini",
            model: analysisModel,
            characterName: peerName,
            transcript: transcriptLines,
          });
          analysis = result.analysis;
          if (result.usage && this.sessionId && this.studentId) {
            dualAgentService.trackHttpUsage(
              this.sessionId,
              this.studentId,
              this.userId,
              "gemini",
              analysisModel,
              result.usage.promptTokens,
              result.usage.completionTokens,
              result.usage.cachedTokens ?? 0,
              "social-skill-analysis",
              result.usage.cacheCreationTokens ?? 0,
            ).catch(err => console.error("[AgentCoordinator] trackHttpUsage(social analysis) failed:", err));
          }
        } catch (err) {
          console.warn("[AgentCoordinator] social-skill analysis failed:", (err as Error).message);
        }
      }
      // Persist the skill picture into session context: the restored
      // Speaker sees it via the history replay below, and Monitor folds
      // it into its notes. Director report (quantitative) + LLM read
      // (qualitative) together form "the social skill analysis".
      const reportSummary = report.turnIndex > 0
        ? `Director report: ${report.turnIndex} turns, final rapport ${report.finalRapport.toFixed(2)} (${report.finalMode}); ` +
          report.competencies
            .filter(c => c.samples >= 3)
            .map(c => `${c.competency}=${Math.round(c.value * 100)}%`)
            .join(", ")
        : null;
      if (analysis || reportSummary) {
        this.appendToConversationLog(
          "system",
          `[SOCIAL TRAINING ANALYSIS]\n${[reportSummary, analysis].filter(Boolean).join("\n")}`,
        );
      }

      // Restore the companion Speaker with the conversation (including
      // the peer session, name-tagged) replayed into its context, then
      // hand it the debrief directive.
      await this.restoreCompanionSpeaker();
      this.speakerRespond(buildSocialDebriefDirective(peerName, analysis, report));
    } catch (err) {
      console.error("[AgentCoordinator] endSocialPeerSession failed:", err);
    } finally {
      this.socialPeerTransition = false;
      // Regenerate the "Practice friend" face after a deliberate beat. Until it
      // arrives the client has no preview → the button shows nothing and does
      // nothing. (The client already cleared the old preview on session end.)
      if (this.peerPreviewTimer) clearTimeout(this.peerPreviewTimer);
      if (this.isSocialTrainerEnabled()) {
        this.peerPreviewTimer = setTimeout(() => {
          this.peerPreviewTimer = null;
          this.preparePeerPreview("post_session");
        }, PEER_PREVIEW_REGEN_MS);
      }
    }
  }

  /** Rebuild the companion Speaker from the cached prompt + tool config
   *  and prime it with conversation context. Shared by the social-session
   *  end path and the failed-start recovery path. */
  private async restoreCompanionSpeaker(): Promise<void> {
    const speaker = this.createSpeakerAgent();
    await speaker.start({
      systemPrompt: this.speakerPrompt,
      model: this.speakerModel,
      toolConfig: this.speakerToolConfigBase,
      useVertex: this.useVertex,
      voiceName: this.aiVoiceName,
      useDirectAudio: this.useDirectAudio,
      compressionTriggerTokens: AWAKE_COMPRESSION_TRIGGER,
      compressionTargetTokens: AWAKE_COMPRESSION_TARGET,
    });
    speaker.setDebugSessionContext(this.sessionId!, this.debugMode);
    this.speaker = speaker;
    this.primeFreshSpeaker();
  }

  private routeWebsiteOpen(event: WebsiteOpenRequestedEvent): void {
    // Client renders apps from `{ appId, appData }` (setActiveApp reads
    // appData.url) — nest url/label under appData to match every other app_open
    // payload. A flat `{ appId, url }` here leaves appData undefined and the
    // browser never renders.
    this.send({ type: "app_open", data: { appId: "browser", appData: { url: event.url, label: event.label } } });
    this.speaker?.sendContextInjection(`[WEBSITE OPEN] ${event.url}${event.label ? ` (${event.label})` : ""}`);
    this.invokeBoardManager([event]);
  }

  // -------------------------------------------------------------------------
  // Speaker output routing (audio + fallback text)
  // -------------------------------------------------------------------------

  private onSpeakerAudioChunk(data: { mimeType: string; data: string }): void {
    // Turn is being suppressed (leaked private reasoning) — drop the PCM
    // so the leaked speech never reaches the child.
    if (this.suppressSpeakerAudio) return;
    // Speaker emits raw PCM chunks. The client expects WAV (with a 44-byte
    // header). Buffer chunks for ~250ms, then flush as a single WAV — the
    // same pattern legacy LiveRelay uses for smoother playback.
    this.speakerAudioChunks.push(data.data);
    if (!this.speakerAudioFlushTimer) {
      this.speakerAudioFlushTimer = setTimeout(
        () => this.flushSpeakerAudio(),
        AUDIO_FLUSH_INTERVAL_MS,
      );
    }
  }

  /** Forward Gemini's outputAudioTranscription deltas to the client as
   *  `text` so the subtitle line + avatar mouth animate alongside audio. */
  private onSpeakerTranscriptionDelta(text: string): void {
    this.send({ type: "text", data: text, noAudioClear: true });
  }

  /** The Speaker detected it is voicing its private reasoning. Kill the
   *  audio for the rest of the turn: drop any PCM buffered but not yet
   *  flushed, and tell the client to stop playing whatever already went
   *  out. The captured reasoning arrives next as a thought_leak event,
   *  which clears `suppressSpeakerAudio`. */
  private onSpeakerSuppressAudio(): void {
    this.suppressSpeakerAudio = true;
    this.speakerAudioChunks = [];
    if (this.speakerAudioFlushTimer) {
      clearTimeout(this.speakerAudioFlushTimer);
      this.speakerAudioFlushTimer = null;
    }
    this.send({ type: "audio_interrupt" });
    flowNote("SPEAKER", "Audio suppressed — model voiced its private reasoning ('private_thought').");
  }

  /** Join buffered Speaker PCM chunks into a single WAV and send as one
   *  avatar_audio message. Called on the flush timer and at SpeechEnd. */
  private flushSpeakerAudio(): void {
    if (this.speakerAudioFlushTimer) {
      clearTimeout(this.speakerAudioFlushTimer);
      this.speakerAudioFlushTimer = null;
    }
    if (this.speakerAudioChunks.length === 0) return;
    try {
      const chunks = this.speakerAudioChunks.splice(0);
      const pcmBuf = Buffer.concat(chunks.map(c => Buffer.from(c, "base64")));
      if (pcmBuf.length === 0) return;
      const wavBuf = pcmToWav(pcmBuf);
      this.send({ type: "avatar_audio", data: wavBuf.toString("base64"), format: "wav" });
    } catch (err) {
      console.error("[AgentCoordinator] flushSpeakerAudio failed:", (err as Error).message);
    }
  }

  /** Credit-tracking callback shared by both TTS paths. Fires once per
   *  synth call for the provider that actually rendered the audio.
   *  Aborted streams report nothing — we don't bill for cancelled
   *  synthesis. */
  private ttsUsageCallback() {
    return (usage: { provider: import("../chat/cost-helpers").TtsProvider; characters: number }) => {
      if (!this.sessionId || !this.studentId) return;
      dualAgentService
        .trackTtsUsage(this.sessionId, this.studentId, this.userId, usage.provider, usage.characters)
        .catch(err => console.error("[AgentCoordinator] trackTtsUsage failed:", err));
    };
  }

  /** Iterate a pre-started TTS stream and emit each chunk to the client
   *  as `messageType`. Returns the chunk count. The iterator is started
   *  by the caller (with first chunk pre-requested) so the HTTP call
   *  fires immediately — important for the AI path where this method
   *  runs serialized via `aiTtsChain` while the previous sentence is
   *  still emitting. */
  private async drainTtsToClient(opts: {
    iter: AsyncIterator<Buffer>;
    firstChunk: Promise<IteratorResult<Buffer>>;
    messageType: "avatar_audio" | "utterance_audio";
    signal?: AbortSignal;
  }): Promise<number> {
    let count = 0;
    try {
      let result = await opts.firstChunk;
      while (!result.done) {
        if (opts.signal?.aborted) break;
        this.send({ type: opts.messageType, data: result.value.toString("base64") });
        count++;
        result = await opts.iter.next();
      }
    } catch (err) {
      if (!opts.signal?.aborted) {
        console.error("[AgentCoordinator] TTS emission failed:", err);
      }
    }
    return count;
  }

  /** Sequential emission queue for AI TTS audio. The HTTP Speaker path
   *  calls `onSpeakText` once per completed sentence as the LLM stream
   *  lands. Each call pre-fires the TTS HTTP request IMMEDIATELY, then
   *  queues client emission behind any in-flight prior sentence — so
   *  sentence N's TTS rendering overlaps with sentence N-1's playback
   *  and chunks land back-to-back with no audible gap. The Live
   *  `speak()` path only fires once per turn, so the chain is a no-op
   *  there. */
  private aiTtsChain: Promise<void> = Promise.resolve();
  /** Abort controller for the in-flight AI/peer TTS chain. Aborted by
   *  `interruptAiSpeech` so a button press cuts the voice off. */
  private aiTtsAbortController: AbortController | null = null;
  /** Count of queued/playing AI-TTS sentences (HTTP/peer path). Combined with
   *  `speakerSpeaking` (native-audio path) gives "is the AI talking right now". */
  private aiSpeakPending = 0;

  private onSpeakerSpeakText(text: string): void {
    // During a social session the Speaker slot holds the peer persona,
    // which speaks with its own (session-random) voice.
    const voice = this.socialPeer?.voice ?? this.aiVoice;
    if (!voice || !text.trim()) return;
    if (!this.aiTtsAbortController) this.aiTtsAbortController = new AbortController();
    const signal = this.aiTtsAbortController.signal;
    if (signal.aborted) return;
    const iter = ttsFacade.synthesizeStream(text, voice, signal, this.ttsUsageCallback())[Symbol.asyncIterator]();
    const firstChunk = iter.next();
    const prior = this.aiTtsChain;
    this.aiSpeakPending++;
    this.aiTtsChain = (async () => {
      await prior;
      try {
        if (!signal.aborted) await this.drainTtsToClient({ iter, firstChunk, messageType: "avatar_audio", signal });
      } finally {
        this.aiSpeakPending = Math.max(0, this.aiSpeakPending - 1);
      }
    })();
  }

  /** True while the AI/peer voice is rendering or playing — covers both the
   *  native-audio Speaker (`speakerSpeaking`) and the HTTP/peer TTS chain. */
  private isAiSpeaking(): boolean {
    return this.speakerSpeaking || this.aiSpeakPending > 0;
  }

  /** Cut off whatever the AI/peer is currently saying: stop client playback of
   *  the avatar voice, drop native-audio PCM buffered but not yet flushed, and
   *  abort the in-flight peer TTS chain. Triggered by a fresh button press so
   *  the student's own voice isn't talked over. */
  private interruptAiSpeech(): void {
    // Client: drop the avatar (AI/peer) audio queue. Tag-scoped so the
    // student's own utterance audio is untouched.
    this.send({ type: "audio_clear_tag", tag: "avatar" });
    // Native-audio path: discard buffered PCM not yet flushed.
    if (this.speakerAudioChunks.length > 0) this.speakerAudioChunks = [];
    if (this.speakerAudioFlushTimer) {
      clearTimeout(this.speakerAudioFlushTimer);
      this.speakerAudioFlushTimer = null;
    }
    // Peer/HTTP path: abort in-flight TTS so the server stops emitting chunks.
    if (this.aiTtsAbortController) {
      this.aiTtsAbortController.abort();
      this.aiTtsAbortController = null;
    }
  }

  private async streamStudentTts(text: string, source: string = "?", meta?: { bid?: boolean; addressee?: string }): Promise<void> {
    if (!this.studentVoice) return;
    // Cancel any in-flight TTS from a prior press / interpret AND tell
    // the client to drop queued utterance audio. Without this, a second
    // press while the first stream is still arriving produces doubled
    // playback. `audio_clear_tag` is tag-scoped — the AI's avatar_audio
    // queue is preserved.
    if (this.studentTtsAbortController) {
      this.studentTtsAbortController.abort();
      this.send({ type: "audio_clear_tag", tag: "utterance" });
    }
    const controller = new AbortController();
    this.studentTtsAbortController = controller;

    // Shape-C: the student just voiced something → broadcast it to any group
    // chat peers. Skip re-voiced repeats (a perseverating tap isn't a new turn).
    if (source !== "button_press_repeat") {
      this.publishUtteranceToRoom(text, meta?.bid ?? false, meta?.addressee);
    }

    flowOutput("COORDINATOR", "student_tts_start", `[${source}] "${text}"`);
    const iter = ttsFacade.synthesizeStream(text, this.studentVoice, controller.signal, this.ttsUsageCallback())[Symbol.asyncIterator]();
    const firstChunk = iter.next();
    try {
      const count = await this.drainTtsToClient({
        iter,
        firstChunk,
        messageType: "utterance_audio",
        signal: controller.signal,
      });
      flowOutput(
        "COORDINATOR",
        controller.signal.aborted ? "student_tts_aborted" : "student_tts_end",
        `[${source}] chunks=${count}`,
      );
    } finally {
      if (this.studentTtsAbortController === controller) {
        this.studentTtsAbortController = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Board Manager invocation
  // -------------------------------------------------------------------------

  /**
   * Schedule a deferred BoardManager invocation that holds for
   * DEFERRED_BM_PRESS_MS waiting for Speaker to speak first. If Speaker's
   * speech_text_finalized fires within the window, the deferred trigger
   * is cleared (see onSpeakerSpeechTextFinalized) and BoardMgr is fired
   * with the SPEECH as context — so the buttons it builds match what
   * Speaker just said. If Speaker stays silent (mute mode, MALFORMED,
   * Word Finder with no question), the timer fires and BM builds from
   * the deferred trigger alone.
   *
   * Used by: DEVICE-targeted presses (the original use), guessing-mode
   * entries, and guessing-mode state refreshes. The wait-for-Speaker
   * pattern is the same in all three cases.
   */
  private scheduleDeferredBoardMgr(event: AgentEvent | null, contextLabel: string): void {
    this.clearDeferredBoardMgr("superseded by newer schedule");
    this.deferredBoardMgrTrigger = event;
    // The timer is always set, even when event is null (state-change
    // refresh). The active timer is what onSpeakerSpeechTextFinalized
    // looks for to know there's something to supersede; without it,
    // Speaker's reply wouldn't drive a board rebuild and we'd lose
    // alignment between what Speaker asks and what BM offers.
    this.deferredBoardMgrTimer = setTimeout(() => {
      const trigger = this.deferredBoardMgrTrigger;
      this.deferredBoardMgrTrigger = null;
      this.deferredBoardMgrTimer = null;
      flowNote("BOARD_MGR", `Deferred ${contextLabel} timer fired — Speaker didn't reply within ${AgentCoordinator.DEFERRED_BM_PRESS_MS}ms; building from the trigger alone.`);
      void this.invokeBoardManager(trigger ? [trigger] : []);
    }, AgentCoordinator.DEFERRED_BM_PRESS_MS);
  }

  /** Cancel a scheduled deferred BM invocation. Called when something
   *  supersedes it (Speaker replies, profile transition, new press, etc.). */
  private clearDeferredBoardMgr(reason: string): void {
    if (!this.deferredBoardMgrTimer) return;
    clearTimeout(this.deferredBoardMgrTimer);
    this.deferredBoardMgrTimer = null;
    this.deferredBoardMgrTrigger = null;
    flowNote("BOARD_MGR", `Deferred press cleared: ${reason}`);
  }

  /** The register the BoardManager should shape its palette for. A live social-
   *  training session means the user is talking to a PEER — the same legitimate
   *  "a peer is present" signal a real peer contact carries (we feed only the
   *  register, never the bot's internals). Otherwise use the Observer's last
   *  read (peer/helper/unknown); `undefined` lets the board offer a balanced mix. */
  private resolveInterlocutorRegister(): InterlocutorRegister | undefined {
    if (this.socialPeer) return "peer";
    return this.currentInterlocutorRegister;
  }

  private async invokeBoardManager(triggeringEvents: AgentEvent[]): Promise<void> {
    if (!this.boardManager) return;
    // Profile gate — resting means no board mutations. Observer keeps
    // running and recording; the board stays frozen at whatever was last
    // emitted. Wake-from-rest gates (button press, directed transcript,
    // builder open, board exit) wake first and then route, so legitimate
    // user-triggered rebuilds get through; this is just a safety against
    // ambient context-update invocations rebuilding the board while
    // nobody is at the device.
    if (this.sessionProfile === "resting") {
      flowNote("BOARD_MGR", "Skipped invocation — session is resting.");
      return;
    }
    if (this.boardMgrInFlight) {
      this.boardMgrPendingTriggers.push(...triggeringEvents);
      return;
    }
    this.boardMgrInFlight = true;
    // Ambient "rebuilding the board" indicator — on past the resting /
    // in-flight guards, so a resting session never lights it up. Cleared in
    // the finally, but only when nothing is queued to re-invoke (so a
    // retry / queued-trigger chain reads as one continuous rebuild, no flicker).
    this.emitProcessing("board", true);
    // Drain any pending retry triggers (paired with pendingFeedback by
    // queueBoardMgrEmptyResponseRetry / queueBoardMgrFeedback) into the
    // effective triggers. Without this, a new event arriving between a
    // failed rebuild and its retry could consume the feedback alone and
    // the model would no_change on that event — never honoring the
    // original beat. Dedupe so a retry-trigger that's ALSO the raw
    // trigger doesn't get listed twice.
    if (this.boardMgrPendingRetryTriggers.length > 0) {
      const seen = new Set<AgentEvent>(triggeringEvents);
      const merged: AgentEvent[] = [...this.boardMgrPendingRetryTriggers];
      for (const e of triggeringEvents) {
        if (!merged.includes(e)) merged.push(e);
      }
      void seen; // (no-op — reserved for future identity-based de-dup)
      flowNote(
        "BOARD_MGR",
        `Retry context preserved: merged ${this.boardMgrPendingRetryTriggers.length} pending retry-trigger(s) with ${triggeringEvents.length} fresh.`,
      );
      triggeringEvents = merged;
      this.boardMgrPendingRetryTriggers = [];
    }
    // Remember these triggers so a retry queue can re-supply them.
    // Cleared in the finally block before re-entry so each cycle has a
    // clean slate.
    this.boardMgrCurrentTriggers = triggeringEvents.slice();
    // Fresh AbortController so onSpeakerSpeechTextFinalized can cancel
    // this call if a newer Speaker turn lands mid-flight.
    const controller = new AbortController();
    this.boardMgrAbortController = controller;
    // Pull and clear the pending validator-feedback (if any) so the
    // next invocation knows to retry. Bump the retry counter; reset on
    // a successful no-error invocation below.
    const pendingFeedback = this.boardMgrPendingFeedback;
    this.boardMgrPendingFeedback = null;
    // Single source of truth for the retry budget: a RETRY invocation
    // (pendingFeedback set) increments the consecutive-retry counter; a FRESH
    // invocation (a normal trigger) starts a new chain, so reset it here. Do
    // NOT reset the counter again later in this handler — a mid-handler reset
    // (e.g. after a clean dispatch) zeroes it before the state-triggered /
    // beat / malformed retry decision runs, so the BOARD_MGR_MAX_RETRIES cap in
    // queueBoardMgrEmptyResponseRetry always sees 0 and a deterministic
    // no_change (board already matches the state) retries forever.
    if (pendingFeedback) this.boardMgrRetryAttempt += 1;
    else this.boardMgrRetryAttempt = 0;
    try {
      // Tool config is rebuilt per invocation so `guessingActive` reflects
      // the LIVE state — the exit_guessing tool only appears while the
      // Word Finder is active, and is gone the next turn after exit.
      // hasLoadedBoard / loadedBoardName likewise track the current board
      // state so press_button surfaces only when there's a custom board.
      const dynamicToolConfig: BoardManagerToolConfig = {
        ...this.boardManagerToolConfig,
        guessingActive: this.guessingState !== null,
        hasLoadedBoard: this.loadedBoardId !== null,
        loadedBoardKey: this.loadedBoardId
          ? this.boardManagerToolConfig.loadedBoardKey ?? null
          : null,
        loadedBoardName: this.loadedBoardId
          ? this.boardManagerToolConfig.loadedBoardName ?? null
          : null,
      };
      // Compose from cached parts: base is always sent; the builder / guessing
      // blocks ride along ONLY while that mode is active (saves ~2.9k tok on a
      // normal turn). The stable base stays cacheable.
      //
      // The builder block also carries <sentence_interpretation> — the
      // procedure for interpret(). The builder closes the instant the user
      // presses Play, so builderState is usually already null by the time the
      // (deferred) sentence_composed invocation runs. Include the block on a
      // composed turn too, or the model loses the interpret() instructions and
      // falls back to rebuilding the board (the sentence is never voiced).
      const hasComposedTrigger = triggeringEvents.some(
        (e) => e.type === "sentence_composed",
      );
      // Suffix blocks ride SEPARATELY from the base so plain turns (no
      // suffix — the majority) can hit the agent's explicit prompt cache;
      // the agent inlines base+suffix itself when a suffix is present.
      const promptSuffixParts: string[] = [];
      if (this.builderState || hasComposedTrigger) promptSuffixParts.push(this.boardManagerBuilderBlock);
      if (this.guessingState) promptSuffixParts.push(this.boardManagerGuessingBlock);
      // Read the home-press directive (set by routeHomeTopicPressInner).
      // Don't clear here — if BM MALFORMEDs or no_changes the first
      // attempt and the retry chain runs, we want the directive on
      // every retry, not just the first. The directive is cleared by
      // applyBoardRebuilt once BM actually honors it (or replaced when
      // a different home press arrives).
      const forceRebuildDirective = this.pendingForceRebuildDirective;

      if (pendingFeedback) {
        promptSuffixParts.push(`<retry_feedback>\n${pendingFeedback}\n</retry_feedback>`);
      }
      const input: BoardManagerInvocationInput = {
        systemPrompt: this.boardManagerPromptBase,
        systemPromptSuffix: promptSuffixParts.length > 0 ? promptSuffixParts.join("\n\n") : undefined,
        toolConfig: dynamicToolConfig,
        triggeringEvents,
        recentEvents: [...this.recentEvents],
        currentBoardLabels: [...this.currentBoardLabels],
        currentBoardButtons: this.currentBoardButtons.map((b) => ({
          label: b.label,
          speech: b.speech ?? b.sentence,
          glyph: b.glyph,
          glyphFallback: b.glyphFallback,
          buttonType: b.buttonType,
        })),
        contextSidebarLabels: [...this.contextSidebarLabels],
        violationMemory: this.boardMgrViolationSnapshot(),
        loadedBoardId: this.loadedBoardId,
        builderState: this.builderState ?? undefined,
        guessingState: this.guessingState ?? undefined,
        provider: BOARD_MANAGER_DEFAULT_PROVIDER,
        model: BOARD_MANAGER_DEFAULT_MODEL,
        signal: controller.signal,
        forceRebuildDirective: forceRebuildDirective ?? undefined,
        interlocutorRegister: this.resolveInterlocutorRegister(),
        // Home-press topic switches want VARIETY across repeated presses —
        // especially the "I'm talking" → facilitator opener on a fresh
        // conversation, where the input barely changes press-to-press. Raise
        // the sampling temperature so the model produces a different set of
        // conversation starters each time instead of the same near-
        // deterministic board. Normal turns keep the precise 0.2 default.
        temperature: forceRebuildDirective ? HOME_PRESS_REBUILD_TEMPERATURE : undefined,
      };
      if (forceRebuildDirective) {
        flowNote(
          "COORDINATOR",
          `Home-press force-rebuild directive forwarded to BM (${forceRebuildDirective.slice(0, 60)}…)`,
        );
      }
      let result;
      try {
        result = await this.boardManager.invoke(input);
      } catch (err: any) {
        // AbortError is the only expected throw — the Gemini SDK
        // rejects with a DOMException/AbortError when abortSignal fires.
        // Treat it as a clean cancellation: queued triggers run next,
        // no events applied, no retry queued.
        if (controller.signal.aborted) {
          flowNote("BOARD_MGR", "In-flight invocation aborted — result discarded.");
          return;
        }
        throw err;
      }
      // Defensive: if abort fired between the await resolving and here
      // (unlikely but possible), drop the stale result.
      if (controller.signal.aborted) {
        flowNote("BOARD_MGR", "In-flight invocation aborted after resolution — result discarded.");
        return;
      }
      // (Retry counter is reset at invocation start — see the pendingFeedback
      // handling above. Resetting it here would defeat the retry cap.)
      // Track Board Manager HTTP usage (no modality details — text-only).
      if (result.usage) {
        this.trackLiveUsage("board-manager", BOARD_MANAGER_DEFAULT_PROVIDER, BOARD_MANAGER_DEFAULT_MODEL, {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          cachedTokens: result.usage.cachedTokens ?? 0,
          cacheCreationTokens: result.usage.cacheCreationTokens ?? 0,
        });
      }
      for (const event of result.events) {
        this.onBoardManagerEvent(event);
      }
      // Fusion-feedback retry. The model called a fused PascalCase tool
      // name (e.g. RebuildBoardButtons) instead of the canonical
      // rebuild_board. parseToolCall already rewrote the call to the
      // real tool and dispatched the event (and downgraded single-button
      // rebuilds to add_board_button so the existing board isn't
      // wiped). BoardManager is stateless — each invocation rebuilds
      // its message list from scratch with no history of prior tool
      // calls — so there's no carry-over "memory" of the fused name
      // for a retry to correct. A `<retry_feedback>` block would just
      // burn tokens for nothing: the model's next invocation can't see
      // its previous bad call either way. We log the fusion below for
      // debugging visibility but do NOT queue a retry.
      if (result.fusionFeedback && result.fusionFeedback.length > 0) {
        const summary = result.fusionFeedback
          .map(f => `${f.fusedName}→${f.toolName}`)
          .join(", ");
        flowNote("BOARD_MGR", `Fusion detected & auto-corrected (no retry — BM is stateless, no memory to inject into): ${summary}`);
      }
      // Retry policy. Two distinct failure modes, both warrant a retry:
      //
      //  (a) MALFORMED / empty response — the model produced ZERO valid
      //      tool calls (MALFORMED_FUNCTION_CALL, safety block, empty
      //      output). We have no information from this invocation
      //      regardless of trigger type. ALWAYS retry; the retry cap
      //      prevents loops if the failure is structural.
      //
      //  (b) Beat needed a rebuild but model gave up — the model
      //      emitted a real no_change(reason) for a trigger that
      //      genuinely required a board update (button press, AI
      //      reply, etc.). This is a judgment error, not a failure;
      //      we re-prompt with an explicit directive so the next turn
      //      produces buttons.
      //
      // Fusion-feedback retries are a separate path (queued elsewhere)
      // — skip the empty-response/beat retries when fusion was the
      // problem, to avoid double-retrying.
      const isMalformedOrEmpty = result.rawToolCalls.length === 0;
      const hadFusion = !!(result.fusionFeedback && result.fusionFeedback.length > 0);
      const producedRebuild = result.events.some(
        e => e.type === "board_rebuilt"
          || e.type === "board_button_added"
          || e.type === "binary_choice_shown",
      );
      const producedBuilderSuggestions = result.events.some(
        e => e.type === "builder_suggested",
      );
      const onlyNoChange = result.events.length > 0
        && result.events.every(e => e.type === "board_no_change");
      const triggerDemandsRebuild = triggeringEvents.some(
        e => e.type === "button_pressed"
          || e.type === "sentence_composed"
          || e.type === "speech_text_finalized"
          || e.type === "transcribed",
      );
      const stateTriggered = triggeringEvents.length === 0 &&
        (!!this.guessingState || !!this.builderState);
      const stateRequiresOutput = stateTriggered && !producedRebuild && !producedBuilderSuggestions && !hadFusion && onlyNoChange;
      // A REAL no_change tool call (model judged the surface fine) on
      // a trigger that genuinely required a rebuild → judgment-error
      // retry. Distinct from malformed: rawToolCalls.length > 0 here.
      // Skipped when THIS invocation was already a retry (pendingFeedback
      // set): a conscious no_change after validator feedback means the
      // model reviewed the corrected surface and declined further changes
      // — re-queueing it just burns the retry budget on churn (observed as
      // a second wasted call per beat in session 0b2a3212).
      const beatGotNoChange = triggerDemandsRebuild
        && !producedRebuild
        && !hadFusion
        && onlyNoChange
        && !isMalformedOrEmpty
        && !pendingFeedback;
      // A home-press force-rebuild directive explicitly forbids no_change
      // (buildForceRebuildHint: "Do NOT call no_change on this turn"). The
      // SILENT home presses (e.g. the "I'm talking" → facilitator button)
      // invoke BM with EMPTY triggers, so beatGotNoChange — which keys off
      // triggerDemandsRebuild — never catches a no_change here. This bites
      // hardest when the user RE-presses the same mode button: the existing
      // board already resembles the requested palette, so the model
      // no_changes it and the surface never refreshes. Treat an outstanding
      // directive + no_change as a beat that needed a rebuild and retry.
      const directiveGotNoChange = !!forceRebuildDirective
        && !producedRebuild
        && !producedBuilderSuggestions
        && !hadFusion
        && onlyNoChange
        && !isMalformedOrEmpty;

      if ((isMalformedOrEmpty && !hadFusion) || beatGotNoChange || stateRequiresOutput || directiveGotNoChange) {
        const why = isMalformedOrEmpty
          ? `malformed/empty (finish: ${result.finishReason ?? "unknown"})`
          : beatGotNoChange
            ? `no_change on a beat that needed rebuild (${triggeringEvents.map(e => e.type).join("+")})`
            : directiveGotNoChange
              ? "no_change on a mandatory home-press rebuild"
              : "state-triggered no-output";
        flowNote("BOARD_MGR", `Queueing retry — ${why}.`);
        this.queueBoardMgrEmptyResponseRetry();
      }
    } catch (err) {
      console.error("[AgentCoordinator] BoardManager invocation failed:", err);
    } finally {
      // Clear the abort handle ONLY if it still points at this
      // invocation's controller. A late stale-abort path could
      // re-assign before our finally runs; we don't want to null out
      // someone else's controller.
      if (this.boardMgrAbortController === controller) {
        this.boardMgrAbortController = null;
      }
      this.boardMgrInFlight = false;
      // Clear the current-invocation triggers — the retry sites above
      // already captured them into pendingTriggers via invokeBoardManager
      // re-entry, and a stale value here would leak into the NEXT
      // cycle's retry context.
      this.boardMgrCurrentTriggers = [];
      // Re-invoke if EITHER triggers were queued during the in-flight
      // invocation OR pending feedback is set (retry path —
      // queueBoardMgrEmptyResponseRetry / queueBoardMgrFeedback set
      // pendingFeedback and call invokeBoardManager([]) which, while
      // we're still inFlight, just pushes [] onto pendingTriggers —
      // adding nothing, since push(...[]) is a no-op). Without the
      // feedback check, the retry sets pendingFeedback but the finally
      // block sees zero queued triggers and skips re-entry — the retry
      // is orphaned. (Fusion-correction retries were removed: fused
      // calls are now auto-corrected in parseToolCall and dispatched,
      // and BoardManager is stateless so there's no memory for a retry
      // to fix — see the fusion-detection branch in the try block.)
      const hasFeedback = !!this.boardMgrPendingFeedback;
      const hasTriggers = this.boardMgrPendingTriggers.length > 0;
      if (hasFeedback || hasTriggers) {
        const queued = this.boardMgrPendingTriggers;
        this.boardMgrPendingTriggers = [];
        // Re-enter via microtask to avoid stack growth. The "rebuilding" veil
        // is now cleared on board DELIVERY (onBoardManagerEvent), not here — if
        // this re-entry produces a fresh board it re-lights on its own invoke
        // start, and a no-delivery beat (abort/error) leaves whatever the last
        // start set, so we intentionally don't touch it in this branch.
        Promise.resolve().then(() => this.invokeBoardManager(queued));
      } else {
        // Chain settled with nothing queued — make sure the veil is down even
        // if this beat produced no delivery event (abort / caught error).
        this.emitProcessing("board", false);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Board Manager → bus
  // -------------------------------------------------------------------------

  private onBoardManagerEvent(event: BoardManagerOutputEvent): void {
    this.recordEvent(event);
    this.logEvent("BOARD_MANAGER", event);

    switch (event.type) {
      case "board_rebuilt":
        this.applyBoardRebuilt(event);
        return;
      case "board_button_added":
        this.applyBoardButtonAdded(event);
        return;
      case "context_button_added":
        this.applyContextButtonAdded(event);
        return;
      case "binary_choice_shown":
        this.applyBinaryChoiceShown(event);
        return;
      case "builder_suggested":
        this.applyBuilderSuggested(event);
        return;
      case "board_no_change":
        // No-op. Logged via recentEvents only.
        return;
      case "board_load_requested":
        // BoardManager asked to load a pre-built custom board by key.
        // Fire-and-forget: the DB lookup + WS push happens async, but the
        // event-routing path must not await it (would block subsequent
        // events in the same batch).
        void this.applyBoardLoadRequested(event);
        return;
      case "guessing_exit_requested":
        // BoardManager declared narrowing has converged (user confirmed
        // a guess, conversation moved on, etc.). Run the same exit path
        // as a client-initiated cancel, but with the AI's reason for
        // audit + flow-log visibility.
        flowNote("BOARD_MGR", `exit_guessing requested: ${event.reason}`);
        this.clearGuessingState(`ai_exit:${event.reason}`);
        return;
      case "interpret_intent":
        // BoardManager produced a natural-language interpretation of a
        // composed SENTENCE — route to the existing TTS + follow-up
        // pipeline. Server-side gate still applies (drops if the last
        // user input wasn't sentence_composed).
        this.routeInterpretIntent(event);
        return;
      case "monitor_call_requested":
        this.requestMonitor(event.reason, "board-manager");
        return;
      case "private_note":
        // Board Manager is stateless — no point echoing back. Coordinator
        // records it in recentEvents for posterity.
        return;
    }
  }

  /** Re-gate a BoardManager-authored `open` launch action against the
   *  permitted-website allowlist / enabled-app set. Returns the sanitized
   *  action (website takes precedence if both are set), or undefined if the
   *  target isn't permitted — in which case the button degrades to a normal
   *  speak button rather than launching an arbitrary URL/app. */
  private resolveButtonOpen(open: BoardButtonOpen | undefined): BoardButtonOpen | undefined {
    if (!open) return undefined;
    if (open.website) {
      if (isUrlPermitted(open.website, this.permittedWebsites)) return { website: open.website };
      flowNote("COORDINATOR", `Dropped open.website "${open.website}" — not covered by the permitted-sites list.`);
      return undefined;
    }
    if (open.app) {
      if (this.launchableAppIds.has(open.app)) return { app: open.app };
      flowNote("COORDINATOR", `Dropped open.app "${open.app}" — not an enabled app.`);
      return undefined;
    }
    return undefined;
  }

  private applyBoardRebuilt(event: BoardRebuiltEvent): void {
    // Home-press directive was honored — clear it so subsequent
    // invocations fall back to the normal action-hint flow. (Clearing
    // here, not at invocation time, lets the directive survive across
    // BM retry chains so a MALFORMED first attempt still gets the
    // forced rebuild on the retry.)
    if (this.pendingForceRebuildDirective) {
      this.pendingForceRebuildDirective = null;
    }
    // Partition: suggestion buttons (whose `glyph` is a valid
    // `suggestion:dim:value` key) are trusted system-expanded content
    // — they bypass the validator (which would reject them as unknown
    // imageKeys) and are rendered via expandSuggestionKey which
    // attaches the system-provided icon + label. Non-suggestion
    // buttons go through the normal validator.
    type Btn = {
      label: string;
      glyph?: string;
      glyphFallback?: string;
      imageKey?: string;
      iconRef?: string;
      symbolPath?: string;
      [k: string]: unknown;
    };
    const suggestionExpanded: any[] = [];
    const specialButtons: Btn[] = [];     // wordfinder / more — bypass validator
    const regular: Btn[] = [];
    const offeredKeys = this.guessingState?.offeredKeys ?? [];
    for (const b of event.buttons) {
      // A registry suggestion key may arrive in `glyph` (legacy) OR `label`
      // (current — the model puts the key in `label` and often adds a
      // decorative emoji glyph). Recognize it in either field and expand via
      // the registry (system-provided icon + localized label). Without this the
      // raw `suggestion:dim:value` key renders as the button text and the press
      // routes as a normal button (not a guessing_press) — see the category-menu
      // regression where keys showed untranslated and narrowing stalled.
      const glyph = (b.glyph || "").trim();
      const labelStr = (b.label || "").trim();
      const sugKey = glyph && isValidSuggestionKey(glyph)
        ? glyph
        : (isValidSuggestionKey(labelStr) ? labelStr : null);
      if (sugKey) {
        const expanded = expandSuggestionKey(sugKey);
        if (expanded) {
          suggestionExpanded.push(expanded);
          continue;
        }
      }
      // Recover a misauthored registry suggestion while guessing: the model
      // copied a value out of an offered key into a `narrow`/`guess` button (or
      // a bare-value label) instead of emitting the key. Re-fold it so the
      // button localizes and routes as a guessing_press (see
      // recoverOfferedSuggestionKey).
      if (this.guessingState) {
        const recoveredKey = recoverOfferedSuggestionKey(
          { label: labelStr, narrowDimension: (b as any).narrowDimension, narrowValue: (b as any).narrowValue },
          offeredKeys,
        );
        if (recoveredKey) {
          const expanded = expandSuggestionKey(recoveredKey);
          if (expanded) {
            suggestionExpanded.push(expanded);
            continue;
          }
        }
      }
      const entry: Btn = {
        label: b.label,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
        imageKey: b.imageKey,
        iconRef: b.iconRef,
        symbolPath: b.symbolPath,
        sentence: b.sentence,
        speech: b.speech,
        buttonType: b.buttonType,
        narrowDimension: (b as any).narrowDimension,
        narrowValue: (b as any).narrowValue,
        rowSpan: b.rowSpan,
        colSpan: b.colSpan,
        open: this.resolveButtonOpen((b as any).open),
      };
      if (b.buttonType === "wordfinder") {
        // Drop the wordfinder entry while already guessing — the entry
        // is a no-op in that state and the gate keeps it off-screen.
        if (this.guessingState !== null) {
          flowNote("COORDINATOR", "rebuild_board: dropping wordfinder button — already in guessing mode.");
          continue;
        }
        specialButtons.push(entry);
      } else if (b.buttonType === "more") {
        specialButtons.push(entry);
      } else {
        regular.push(entry);
      }
    }

    const { buttons: kept, errors, violations } = validateBoardButtons(regular);
    this.recordBoardViolations(violations);
    if (errors.length > 0) {
      this.queueBoardMgrFeedback("rebuild_board", errors);
    }
    // When in guessing mode, tag every non-suggestion button as a
    // "guess" so the word-finder UI on the client renders it alongside
    // the system suggestion buttons. The AI's prompt asks it to prefix
    // these labels with [GUESS] but it doesn't always do so reliably —
    // applying the type server-side guarantees they reach the strip.
    if (this.guessingState) {
      for (const b of kept) {
        if (!(b as any).buttonType) (b as any).buttonType = "guess";
      }
    }
    const merged = [...kept, ...specialButtons, ...suggestionExpanded].slice(0, 8);
    if (merged.length === 0) {
      // Nothing renderable in the rebuild — leave the current surface
      // intact rather than wipe the board to empty.
      return;
    }

    // If a custom board is loaded (e.g. the home board pushed at init),
    // the client is in "custom board mode" and ignores `board` updates
    // until the custom board is unloaded.
    const hadCustomBoard = !!this.loadedBoardId;
    if (this.loadedBoardId) {
      this.send({ type: "unload_board", data: {} });
      this.loadedBoardId = null;
    }
    // Stability gate: if this rebuild yields a board identical to the one already
    // displayed (same buttons + target), skip the push. Re-sending an identical
    // board re-renders the grid on the client and RESETS any in-progress dwell —
    // churn that, for eye-gaze/dwell users, can keep a selection from ever
    // completing. Skip only when no custom board was just unloaded (that changes
    // what's shown) and the press target is unchanged (it alters press routing).
    const newTarget = event.target ?? PARTY_DEVICE;
    const boardUnchanged =
      !hadCustomBoard &&
      this.currentBoardTarget === newTarget &&
      sameBoard(this.currentBoardButtons, merged as MergeButton[]);

    this.currentBoardLabels = merged.map(b => b.label);
    this.currentBoardButtons = merged.map(b => ({ ...b } as MergeButton));
    // Remember who this board's buttons are addressed to. Always default
    // to DEVICE unless BoardManager explicitly set a different target;
    // never inherit from a prior transcript speaker. (BoardManager is
    // told to set target explicitly when the user is replying to a
    // person in the room.)
    this.currentBoardTarget = newTarget;
    if (boardUnchanged) {
      flowNote("COORDINATOR", `rebuild_board produced a board identical to the current one (${merged.length} buttons) — skipping re-render to avoid resetting dwell.`);
    } else {
      this.send({
        type: "board",
        data: buildBoardFromButtons(merged as any),
      });
      void this.applySymbolPipeline(merged as any);
    }
    // Experiment (glyphInputTranslation): mirror the translated incoming speech
    // into the header glyph strip. Only sent when BoardManager supplied
    // `input_glyphs` (replies to incoming speech) — on follow-ups it's absent
    // and the client keeps the strip's last value.
    if (event.inputGlyphs?.length) {
      this.send({ type: "input_glyphs", data: event.inputGlyphs });
      // Input glyphs can carry `generate:` parts too — feed every sentence
      // through the same symbol pipeline so the generated image swaps in over
      // its `fb`.
      void this.generateGlyphPartSymbols(event.inputGlyphs.map(g => g.glyph));
    }
  }

  /**
   * BoardManager called set_board(board_key). Look up the board in
   * `state.availableBoards`, fetch its IR data, and push set_board to
   * the client — same shape as the home-board push at init / on Home
   * press. The home board key short-circuits to the in-memory default
   * (no DB lookup). On a missing key or missing irData, queue
   * validator-feedback so BoardManager learns the surface didn't load
   * and can try a different action.
   */
  private async applyBoardLoadRequested(event: BoardLoadRequestedEvent): Promise<void> {
    const { boardKey } = event;
    const state = this.sessionId ? dualAgentService.getSessionCache(this.sessionId)?.state : undefined;
    const match = state?.availableBoards?.find(b => b.key === boardKey);
    if (!match) {
      const availableKeys = state?.availableBoards?.map(b => b.key).join(", ") || "none";
      flowNote("COORDINATOR", `set_board("${boardKey}") — board not found. Available: ${availableKeys}`);
      this.queueBoardMgrFeedback("set_board", [`Board "${boardKey}" not found. Available keys: ${availableKeys}.`]);
      return;
    }

    let boardData: any;
    if (match.key === HOME_BOARD_KEY) {
      const studentLang = dualAgentService.getSessionCache(this.sessionId!)?.monitorAgent.getStudent?.()?.primaryLanguage || "en";
      boardData = buildDefaultHomeBoard(studentLang, this.isSocialTrainerEnabled());
    } else {
      try {
        const fullBoard = await boardRepository.getBoard(match.id);
        if (!fullBoard?.irData) {
          flowNote("COORDINATOR", `set_board("${boardKey}") — board has no IR data (id=${match.id}).`);
          this.queueBoardMgrFeedback("set_board", [`Board "${boardKey}" has no stored data; pick a different board or rebuild dynamically.`]);
          return;
        }
        boardData = fullBoard.irData;
      } catch (err) {
        console.error(`[AgentCoordinator] set_board("${boardKey}") DB lookup failed:`, err);
        flowNote("COORDINATOR", `set_board("${boardKey}") DB lookup failed: ${(err as Error).message}`);
        return;
      }
    }

    // Push to client. The client renders pre-built boards via set_board
    // (separate from the dynamic `board` channel) and treats the
    // session as "in custom board mode" until unload_board fires.
    this.loadedBoardId = match.id;
    // Update the cached tool config so the NEXT BoardManager invocation's
    // set_board description reflects the switch (the "Currently loaded —
    // do NOT re-select" note + the prompt's <prebuilt_boards> loaded line).
    // Stale cached values would otherwise still point at the previous
    // board for the rest of the session.
    this.boardManagerToolConfig.loadedBoardKey = match.key;
    this.boardManagerToolConfig.loadedBoardName = match.name;
    const page = (boardData as any).pages?.[0];
    if (page?.buttons) {
      const nativeButtons = page.buttons.filter((b: any) => typeof b?.label === "string");
      this.currentBoardLabels = nativeButtons.map((b: any) => b.label);
      this.currentBoardButtons = nativeButtons.map((b: any) => ({ ...b } as MergeButton));
    }
    this.send({
      type: "set_board",
      data: { board: boardData, name: match.name, boardId: match.id },
    });
    runInSessionContext(this.sessionId || "?", this.debugMode, () => {
      logLiveSession("BOARD_LOADED", `key="${boardKey}" name="${match.name}" id=${match.id}`);
    });
    flowNote("COORDINATOR", `set_board("${boardKey}") — loaded "${match.name}".`);
    // Re-prime the "Practice friend" face when the home board is (re)loaded
    // through set_board (e.g. the AI returning the user home).
    if (match.key === HOME_BOARD_KEY) this.preparePeerPreview("set_board_home");
  }

  /**
   * Merge a single incoming button into the current main board via
   * smartMergeButtons. Preserves slot positions for the client's
   * fade-in/fade-out animation; if the board is full, the most-similar
   * (or in the worst case, oldest) existing button is displaced.
   */
  private applyBoardButtonAdded(event: BoardButtonAddedEvent): void {
    const b = event.button;
    // Special-type buttons (wordfinder, more) skip the visual-content
    // validator — they have no glyph or sentence, just a hardcoded marker
    // the client renders with its own styling.
    const isSpecial = b.buttonType === "wordfinder" || b.buttonType === "more";
    if (b.buttonType === "wordfinder" && this.guessingState !== null) {
      // Gate: don't surface a Word Finder entry when one's already active.
      flowNote(
        "COORDINATOR",
        "wordfinder button dropped — already in guessing mode.",
      );
      return;
    }
    if (!isSpecial) {
      // Run the same validator path as add_context_button — drop on
      // structural errors and queue feedback.
      const { buttons: kept, errors, violations } = validateBoardButtons([{
        label: b.label,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
        imageKey: b.imageKey,
        iconRef: b.iconRef,
        symbolPath: b.symbolPath,
      }]);
      this.recordBoardViolations(violations);
      if (errors.length > 0) {
        this.queueBoardMgrFeedback("add_board_button", errors);
      }
      if (kept.length === 0) return;
    }

    const incoming: MergeButton = {
      label: b.label,
      glyph: b.glyph,
      glyphFallback: b.glyphFallback,
      imageKey: b.imageKey,
      iconRef: b.iconRef,
      symbolPath: b.symbolPath,
      sentence: b.sentence,
      speech: b.speech,
      buttonType: b.buttonType,
      narrowDimension: (b as any).narrowDimension,
      narrowValue: (b as any).narrowValue,
      // Carry the conversational role + group-chat addressee so the press can
      // read them back (previously dropped here — role always read as "reply").
      role: (b as { role?: "reply" | "bid" }).role,
      addressee: (b as { addressee?: string }).addressee,
      open: this.resolveButtonOpen((b as { open?: BoardButtonOpen }).open),
    };

    let newIdCounter = 0;
    const newId = () => `btn-${Date.now()}-${newIdCounter++}`;
    const { merged } = smartMergeButtons(
      this.currentBoardButtons,
      [incoming],
      AgentCoordinator.MAIN_BOARD_MAX,
      newId,
    );
    if (merged.length === 0) return;

    // If a custom board is loaded, unload it before pushing the new merged
    // board — the client only renders dynamic boards otherwise.
    if (this.loadedBoardId) {
      this.send({ type: "unload_board", data: {} });
      this.loadedBoardId = null;
    }
    this.currentBoardLabels = merged.map(m => m.label);
    this.currentBoardButtons = merged.map(m => ({ ...m }));
    if (event.target !== undefined) this.currentBoardTarget = event.target;
    this.send({
      type: "board",
      data: buildBoardFromButtons(merged as any),
    });
    void this.applySymbolPipeline(merged as any);
  }

  private applyContextButtonAdded(event: ContextButtonAddedEvent): void {
    // Same validator — one-button input. Drops on any rule violation
    // and queues feedback for the next invocation.
    const b = event.button;
    const { buttons: kept, errors, violations } = validateBoardButtons([{
      label: b.label,
      glyph: b.glyph,
      glyphFallback: b.glyphFallback,
      imageKey: b.imageKey,
      iconRef: b.iconRef,
      symbolPath: b.symbolPath,
    }]);
    this.recordBoardViolations(violations);
    if (errors.length > 0) {
      this.queueBoardMgrFeedback("add_context_button", errors);
    }
    if (kept.length === 0) return;

    this.contextSidebarLabels.push(b.label);
    if (this.contextSidebarLabels.length > 4) {
      this.contextSidebarLabels.shift();
    }
    this.send({
      type: "context_button_add",
      data: {
        label: b.label,
        iconRef: b.iconRef || "fas fa-comment",
        symbolPath: b.symbolPath,
        imageKey: b.imageKey,
        glyph: b.glyph,
        glyphFallback: b.glyphFallback,
        sentence: b.sentence ?? b.speech,
        buttonType: b.buttonType,
      },
    });
    void this.applySymbolPipeline([b]);
  }

  /** Queue a corrective retry when BoardManager produced no tool calls
   *  on a user-input trigger that demanded a rebuild. Same retry-cap as
   *  the validator/fusion paths so a pathological loop can't lock the
   *  agent. */
  private queueBoardMgrEmptyResponseRetry(): void {
    if (this.boardMgrRetryAttempt >= AgentCoordinator.BOARD_MGR_MAX_RETRIES) {
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        logLiveSession("BOARD_MGR_EMPTY", `Past retry cap — dropping empty-response retry.`);
      });
      return;
    }
    // Tailor the retry instruction to the current state. The exact prompt
    // strings live in prompts/board-manager.ts so all BM-facing text is
    // co-located; this method owns the queue + invoke side.
    this.boardMgrPendingFeedback = buildEmptyResponseRetryFeedback({
      inGuessingMode: this.guessingState !== null,
      inBuilderMode: this.builderState !== null,
      // An outstanding home-press directive means the model either produced
      // nothing or no_changed a mandatory topic switch — tailor the feedback
      // to re-demand the fresh palette rather than the generic "no tool
      // calls" message (which is inaccurate when it DID call no_change).
      forceRebuildDirective: this.pendingForceRebuildDirective ?? undefined,
    });
    // Pair the original triggers with the feedback. invokeBoardManager
    // drains this into the NEXT invocation's effective triggers as long
    // as pendingFeedback is set — so a new event arriving before the
    // retry fires can't consume the feedback alone.
    this.boardMgrPendingRetryTriggers = this.boardMgrCurrentTriggers.slice();
    runInSessionContext(this.sessionId || "?", this.debugMode, () => {
      logLiveSession("BOARD_MGR_EMPTY", `Queued empty-response retry attempt ${this.boardMgrRetryAttempt + 1}/${AgentCoordinator.BOARD_MGR_MAX_RETRIES}.`);
    });
    void this.invokeBoardManager([]);
  }

  /** Fold a batch of validator violations into the session memory.
   *  Tokens dedupe via the per-rule Set; the cap keeps the rendered
   *  <recent_mistakes> block terse even in a long error-prone session. */
  private recordBoardViolations(violations: BoardButtonViolation[]): void {
    for (const v of violations) {
      let tokens = this.boardMgrViolationMemory.get(v.rule);
      if (!tokens) {
        tokens = new Set<string>();
        this.boardMgrViolationMemory.set(v.rule, tokens);
      }
      for (const t of v.tokens) {
        if (tokens.size >= AgentCoordinator.VIOLATION_MEMORY_TOKEN_CAP) break;
        tokens.add(t);
      }
    }
  }

  /** Serializable snapshot for BoardManagerInvocationInput.violationMemory. */
  private boardMgrViolationSnapshot(): Array<{ rule: string; tokens: string[] }> {
    const out: Array<{ rule: string; tokens: string[] }> = [];
    for (const [rule, tokens] of this.boardMgrViolationMemory) {
      out.push({ rule, tokens: [...tokens] });
    }
    return out;
  }

  /** Queue validator-error feedback for the next BoardManager
   *  invocation, with a retry cap so a pathological response can't
   *  loop forever. */
  private queueBoardMgrFeedback(toolName: string, errors: string[]): void {
    if (this.boardMgrRetryAttempt >= AgentCoordinator.BOARD_MGR_MAX_RETRIES) {
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        logLiveSession("BOARD_MGR_VALIDATOR", `Errors past retry cap — dropping. tool=${toolName} errors=${errors.length}`);
      });
      return;
    }
    this.boardMgrPendingFeedback = buildValidatorErrorFeedback(toolName, errors);
    // Surface the actual rule violations — session 0b2a3212 showed EVERY
    // rebuild failing validation with the errors invisible in all logs.
    flowNote("BOARD_MGR", `Validator errors (${toolName}): ${errors.join(" | ")}`);
    // Pair the original triggers with the feedback so subsequent
    // invocations always include the beat the retry is fixing, even if
    // a new event arrives before the retry actually runs.
    this.boardMgrPendingRetryTriggers = this.boardMgrCurrentTriggers.slice();
    runInSessionContext(this.sessionId || "?", this.debugMode, () => {
      logLiveSession("BOARD_MGR_VALIDATOR", `${toolName} → ${errors.length} errors, queued retry attempt ${this.boardMgrRetryAttempt + 1}/${AgentCoordinator.BOARD_MGR_MAX_RETRIES}`);
    });
    void this.invokeBoardManager([]);
  }

  private applyBinaryChoiceShown(event: BinaryChoiceShownEvent): void {
    // Decide the third "escape" button kind server-side so the client
    // doesn't need to re-derive it from glyph inspection. Mirrors the
    // client's `detectYesNoDefaultColor`: when both options together
    // form a yes/no pair (one yes-tagged, one no-tagged), the escape
    // becomes a yellow "maybe"; otherwise a red "neither of these"
    // (using the `no` symbol). Client renders by the kind only.
    const escapeKind = detectBinaryChoiceEscapeKind(event.option1?.glyph, event.option2?.glyph);
    this.send({
      type: "binary_choice",
      data: {
        options: [event.option1, event.option2],
        escapeKind,
        // Experiment (glyphInputTranslation): glyph translation of the
        // incoming speech (one entry per sentence), shown above the overlay
        // buttons. Only present when BoardManager supplied `input_glyphs`.
        ...(event.inputGlyphs?.length ? { inputGlyphs: event.inputGlyphs } : {}),
      },
    });
    // The overlay options are full SENTENCE BUTTONs and the input glyphs can
    // carry `generate:` parts — run the same symbol pipeline so their
    // generated images swap in over the fallbacks, exactly like board buttons.
    void this.applySymbolPipeline([event.option1, event.option2]);
    if (event.inputGlyphs?.length) {
      void this.generateGlyphPartSymbols(event.inputGlyphs.map(g => g.glyph));
    }
  }

  private applyBuilderSuggested(event: BuilderSuggestedEvent): void {
    // Map our typed event to the existing wire shape the AAC client expects.
    // Use parseSinglePipeButton (NOT parseBoardButtons) so a comma inside a
    // label fragment doesn't split the candidate into two empty pieces.
    const toCandidate = (raw: string) => {
      const b = parseSinglePipeButton(raw);
      if (!b) return null;
      return {
        key: b.glyph || b.sentence || b.label,
        label: b.label,
        fallback: b.glyphFallback,
      };
    };
    const heads = (event.headCandidates ?? []).map(toCandidate).filter((c): c is NonNullable<ReturnType<typeof toCandidate>> => c !== null);
    const mods = (event.modifierCandidates ?? []).map(toCandidate).filter((c): c is NonNullable<ReturnType<typeof toCandidate>> => c !== null);
    this.send({
      type: "construction_suggestions",
      data: {
        targetSlot: event.slotIndex,
        headCandidates: heads as any,
        modifierCandidates: mods as any,
        candidates: heads as any,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Monitor integration
  // -------------------------------------------------------------------------

  private requestMonitor(reason: string, source: string): void {
    flowInput("MONITOR", "call_request", `from=${source} reason="${reason}"`);
    this.pendingMonitorCalls.push({ reason, source });
    if (this.monitorCallDedupTimer) return; // already scheduled
    this.monitorCallDedupTimer = setTimeout(() => {
      this.monitorCallDedupTimer = null;
      this.flushMonitorCall();
    }, DEBOUNCE_MONITOR_CALL_MS);
  }

  private async flushMonitorCall(): Promise<void> {
    if (!this.sessionId || this.pendingMonitorCalls.length === 0) return;
    const calls = this.pendingMonitorCalls;
    this.pendingMonitorCalls = [];
    const combinedReason = calls
      .map(c => `(${c.source}) ${c.reason}`)
      .join(" | ");
    flowNote("MONITOR", `Invoking monitor — ${combinedReason}`);
    console.log(`[AgentCoordinator] Monitor call: ${combinedReason}`);
    const t0 = Date.now();
    try {
      await dualAgentService.triggerMonitor(this.sessionId, /* force */ true);
      flowNote("MONITOR", `Monitor invocation completed in ${Date.now() - t0}ms`);
      // Response is broadcast via state.onContextInjection which we wired up
      // in handleInitialize.
    } catch (err) {
      flowNote("MONITOR", `Monitor invocation failed: ${(err as Error).message}`);
      console.error("[AgentCoordinator] Monitor invocation failed:", err);
    }
  }

  private broadcastMonitorContext(text: string): void {
    const event: MonitorBroadcastEvent = {
      type: "monitor_broadcast",
      source: "monitor",
      timestamp: Date.now(),
      contextInjection: text,
    };
    this.recordEvent(event);

    flowOutput("MONITOR", "broadcast", text);
    const rendered = `[MONITOR CONTEXT] ${text}`;
    this.observer?.sendContextInjection(rendered);
    // The peer persona must not receive Monitor context — it carries
    // student memory, and the peer knows nothing about the student.
    if (!this.socialPeer) this.speaker?.sendContextInjection(rendered);
    // Board Manager picks it up on its next invocation via recentEvents.
  }

  // -------------------------------------------------------------------------
  // Session summarizing
  // -------------------------------------------------------------------------

  /** Append a conversational turn to the rolling log and check whether a
   *  new summary is due. Also pushes the turn into the session's
   *  pendingMessages queue so Monitor can process it on its next run —
   *  without this the three-agent path never feeds Monitor, and
   *  Student_Notes / Student_Interests / Student_People never update
   *  (the queue Monitor reads from stays permanently empty). Mirrors
   *  the legacy LiveRelay's addPendingMessage calls in every turn-end
   *  path. */
  private appendToConversationLog(role: "user" | "assistant" | "system", content: string): void {
    this.conversationLog.push({ role, content });
    this.maybeProduceSessionSummary();
    if (this.sessionId) {
      // Fire-and-forget — Monitor's atomic DB-pending lock handles
      // concurrency. A failure here is non-fatal; we already have the
      // turn in conversationLog for summary purposes.
      dualAgentService
        .addPendingMessage(this.sessionId, { role, content, timestamp: Date.now() })
        .catch(err => {
          console.warn("[AgentCoordinator] addPendingMessage failed:", (err as Error).message);
        });
    }
  }

  /** Write a line to the supervisor channels only — DB-persisted admin
   *  log + Monitor's pending queue — WITHOUT touching `conversationLog`
   *  (which is replayed to fresh Speakers on reconnect) and without
   *  triggering session-summary generation. Used for content that
   *  Monitor / admin should see but interactive agents must not, e.g.
   *  Speaker's private_note tool calls. */
  private writeSupervisorOnly(content: string): void {
    if (!this.sessionId) return;
    dualAgentService
      .addPendingMessage(this.sessionId, { role: "system", content, timestamp: Date.now() })
      .catch(err => {
        console.warn("[AgentCoordinator] supervisor-only addPendingMessage failed:", (err as Error).message);
      });
  }

  /** Fire a summarizer call when enough new turns have landed. Async
   *  fire-and-forget; injection happens when the LLM call resolves. */
  private maybeProduceSessionSummary(): void {
    if (!this.sessionId || this.summaryInFlight) return;
    const total = this.conversationLog.length;
    if (total - this.summarizedMsgCount < SUMMARY_EVERY_N_MESSAGES) return;

    const cache = dualAgentService.getSessionCache(this.sessionId);
    const monitor: any = cache?.monitorAgent;
    if (!monitor?.produceSessionSummary) return;

    const newMessages = this.conversationLog.slice(this.summarizedMsgCount);
    const markCount = total;
    this.summaryInFlight = true;
    flowInput("MONITOR", "summarize_request", `${newMessages.length} new msgs (total=${total})`);
    const summaryT0 = Date.now();
    monitor
      .produceSessionSummary(this.currentSessionSummary, newMessages)
      .then((result: { summary?: string; usage?: { provider: any; model: string; promptTokens: number; completionTokens: number; cachedTokens?: number; cacheCreationTokens?: number } }) => {
        this.summaryInFlight = false;
        // Bill credits regardless of whether the summary changed — the
        // LLM call still happened and tokens were consumed.
        if (result.usage && this.sessionId && this.studentId) {
          dualAgentService.trackHttpUsage(
            this.sessionId,
            this.studentId,
            this.userId,
            result.usage.provider,
            result.usage.model,
            result.usage.promptTokens,
            result.usage.completionTokens,
            result.usage.cachedTokens ?? 0,
            "monitor-summary",
            result.usage.cacheCreationTokens ?? 0,
          ).catch(err => console.error("[AgentCoordinator] trackHttpUsage(summary) failed:", err));
        }
        const summary = result.summary;
        if (!summary || summary === this.currentSessionSummary) {
          flowNote("MONITOR", `summarize: no change after ${Date.now() - summaryT0}ms`);
          // Advance the marker so we don't re-summarize the same batch.
          this.summarizedMsgCount = markCount;
          return;
        }
        this.currentSessionSummary = summary;
        this.summarizedMsgCount = markCount;
        flowOutput("MONITOR", "session_summary", `${summary.length} chars (${Date.now() - summaryT0}ms)`);
        // Mirror onto session state so reconnects / profile-switches see
        // the latest summary in their prompt rebuild.
        if (cache?.state) cache.state.sessionSummary = summary;
        // Inject so the live agents see it before their next reconnect.
        // Withheld from the peer persona — the summary is student memory;
        // the restored companion Speaker gets it via primeFreshSpeaker.
        const injection = `[SESSION SUMMARY]\n${summary}`;
        this.observer?.sendContextInjection(injection);
        if (!this.socialPeer) this.speaker?.sendContextInjection(injection);
        runInSessionContext(this.sessionId!, this.debugMode, () => {
          logLiveSession("SESSION_SUMMARY_INJECTED", `${summary.length} chars, summarized ${markCount} msgs`);
        });
      })
      .catch((err: Error) => {
        this.summaryInFlight = false;
        flowNote("MONITOR", `summarize failed: ${err.message}`);
        console.warn(`[AgentCoordinator] session summary failed:`, err.message);
      });
  }

  // -------------------------------------------------------------------------
  // Symbol-generation pipeline
  // -------------------------------------------------------------------------

  /**
   * For each generate:KEY symbol referenced in `buttons`:
   *   1. Look up existing matching custom symbols in the DB.
   *   2. Push immediate `construction_symbol_ready` messages for any
   *      that already resolved (so glyph parts render right away).
   *   3. Queue generation for the unresolved keys. Each generation
   *      callback emits a `symbol_update` (top-level button) or a
   *      `construction_symbol_ready` (in-glyph part) WS message.
   *
   * Fire-and-forget — the buttons render with their fallback in the
   * meantime; generation is async.
   */
  private async applySymbolPipeline(
    buttons: Array<{ label?: string; glyph?: string; glyphFallback?: string }>,
  ): Promise<void> {
    const { generateSymbols, useApprovedSymbols, useUnapprovedSymbols } = this.symbolSettings;
    if (!generateSymbols && !useApprovedSymbols && !useUnapprovedSymbols) return;

    // ── Top-level button imageKeys (single-slot glyphs) ──────────────────
    // Extract any bare imageKey from each button's glyph (single slot,
    // not emoji, not symbol:/face:). resolveImageKeys looks them up and
    // mutates the array; we then queue generation for unresolved ones.
    const buttonShapes: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string }> = [];
    const keyToLabel = new Map<string, string>();
    for (const b of buttons) {
      if (!b.glyph) continue;
      const slots = b.glyph.split("+").map(s => s.trim()).filter(Boolean);
      if (slots.length !== 1) continue; // multi-glyph SENTENCEs handled below
      const head = slots[0].split(".")[0].split("(")[0].replace(/^\[|\]$/g, "");
      const isEmoji = /^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(head);
      if (!head || isEmoji || head.startsWith("symbol:") || head.startsWith("face:")) continue;
      buttonShapes.push({ label: b.label || head, iconRef: "", imageKey: head });
      keyToLabel.set(head, b.label || head);
    }
    if (buttonShapes.length > 0 && (useApprovedSymbols || useUnapprovedSymbols)) {
      try {
        const unresolved = await resolveImageKeys(buttonShapes, {
          symbolPathFormat: "internal",
          useUnapproved: useUnapprovedSymbols,
        });
        if (generateSymbols && unresolved.length > 0) {
          queueSymbolGeneration(unresolved, (imageKey, symbol) => {
            const label = keyToLabel.get(imageKey) || imageKey;
            this.send({
              type: "symbol_update",
              data: { buttonLabel: label, symbolPath: `__SYMBOL__:${symbol.id}` },
            });
          }, { sessionId: this.sessionId, studentId: this.studentId, userId: this.userId });
        }
      } catch (err) {
        console.warn("[AgentCoordinator] top-level symbol resolution failed:", (err as Error).message);
      }
    }

    // ── Multi-slot glyph parts ───────────────────────────────────────────
    // Resolve/queue every in-glyph imageKey referenced across these buttons.
    await this.generateGlyphPartSymbols(buttons.map(b => b.glyph));
  }

  /**
   * Resolve + queue generation for the in-glyph `generate:` parts of any
   * glyph strings (board-button SENTENCEs OR the input-glyph translation
   * strip). Resolved keys broadcast `construction_symbol_ready` right away;
   * unresolved ones queue and broadcast the same event when they land. The
   * client's Glyph swaps from each part's `fb` fallback to the generated
   * image as the events arrive — identical to how button glyphs upgrade.
   *
   * Keyed by imageKey (not button label) so it's button-agnostic: the input
   * glyph isn't a button, it's just a glyph string. Fire-and-forget.
   */
  private async generateGlyphPartSymbols(
    glyphStrings: Array<string | undefined>,
  ): Promise<void> {
    const { generateSymbols, useApprovedSymbols, useUnapprovedSymbols } = this.symbolSettings;
    if (!generateSymbols && !useApprovedSymbols && !useUnapprovedSymbols) return;

    const partKeys = new Set<string>();
    for (const g of glyphStrings) {
      if (g) collectGlyphImageKeys(g, partKeys);
    }
    if (partKeys.size === 0) return;

    const synthesized: Array<{ label: string; iconRef: string; symbolPath?: string; imageKey?: string }> =
      Array.from(partKeys).map(k => ({ label: k, iconRef: "", imageKey: k }));

    let unresolved: string[] = Array.from(partKeys);
    if (useApprovedSymbols || useUnapprovedSymbols) {
      try {
        unresolved = await resolveImageKeys(synthesized, {
          symbolPathFormat: "api-path",
          useUnapproved: useUnapprovedSymbols,
        });
      } catch (err) {
        console.warn("[AgentCoordinator] glyph-part resolution failed:", (err as Error).message);
      }
    }

    for (const b of synthesized) {
      if (b.imageKey && b.symbolPath) {
        this.send({
          type: "construction_symbol_ready",
          data: { imageKey: b.imageKey, symbolPath: b.symbolPath },
        });
      }
    }

    if (generateSymbols && unresolved.length > 0) {
      queueSymbolGeneration(unresolved, (imageKey, symbol) => {
        this.send({
          type: "construction_symbol_ready",
          data: { imageKey, symbolPath: `/api/custom-symbols/${symbol.id}/image` },
        });
      }, { sessionId: this.sessionId, studentId: this.studentId, userId: this.userId });
    }
  }

  // -------------------------------------------------------------------------
  // Cost tracking
  // -------------------------------------------------------------------------

  /** Fire-and-forget credit charge per agent turn. Failures are logged
   *  inside dualAgentService and must not interrupt the session. */
  private trackLiveUsage(
    agent: "observer" | "speaker" | "board-manager",
    provider: string,
    model: string,
    usage: import("./live-provider").LiveUsage,
  ): void {
    if (!this.sessionId || !this.studentId) return;
    dualAgentService
      .trackLiveUsage(
        this.sessionId,
        this.studentId,
        this.userId,
        provider as any,
        model,            // real catalog model id — used for PRICING
        usage,
        `${agent}:${model}`,  // attribution label — used for the cost LOG only
      )
      // Attribute the charge by agent so the next [HEARD SPEECH] can tell the
      // Observer what the recent exchange cost (esp. the Speaker, which it never
      // "sees"). The budget itself is fed separately via the universal ledger
      // hook (recordBudgetDrain) — this only feeds the per-transcript note.
      .then(credits => {
        if (credits > 0) {
          if (agent === "speaker") this.drainSinceTranscript.speaker += credits;
          else if (agent === "board-manager") this.drainSinceTranscript.boardManager += credits;
          else this.drainSinceTranscript.observer += credits;
        }
      })
      .catch(err => console.error(`[AgentCoordinator] trackLiveUsage(${agent}) failed:`, err));
  }

  /**
   * Feed the persistent multi-window budget meter — the single cost signal. Fed
   * by the universal `onLedgerCharge` hook, so EVERY charge that hits the ledger
   * (live agents, Monitor HTTP, TTS, in-session analysis) lands here. Also the
   * point where a drain re-reports the level and re-drives the throttle (so a
   * cost spike doesn't wait for the next tick).
   */
  private recordBudgetDrain(credits: number): void {
    if (!this.budgetMeterEnabled || !(credits > 0)) return;
    const now = Date.now();
    this.budgetState = applyBudgetCharge(this.budgetState, this.budgetWindows, credits, now);
    this.budgetDirty = true;
    this.maybePersistBudget(now);
    // Re-report the level and re-drive the throttle right away — a drain can
    // cross a band between the 15s ticks, and we don't want the response
    // delayed up to a full tick. reportEnergy also applies the throttle + floors.
    this.reportEnergy(now, { fromCharge: true });
    this.maybePushBudget(now);
  }

  /**
   * DEBUG-only: force the in-memory budget so every window (and thus the binding
   * %) reads `percent`, with `asOf=now` so regen won't immediately undo it, then
   * re-report the level, re-push the bar, and re-drive the throttle. Lets the
   * debug panel exercise the whole throttle ladder (avatar eyes, bar, forced-HTTP
   * Observer, tired Speaker, sleep timer, board-only, all-stop) live — without
   * DB edits or waiting out the 30-min session cache. Gated on debugMode; no-op
   * outside an economizing session (no budget tracked). NOTE: real charges keep
   * flowing, so the forced level drifts as the session spends — set it again to
   * re-pin. It also persists on the next debounce, so a live session will
   * overwrite the DB with the forced value.
   */
  private debugSetBudgetPercent(percent: number): void {
    if (!this.debugMode) {
      flowNote("COORDINATOR", "debug_set_budget ignored — not in debug mode");
      return;
    }
    if (!this.budgetMeterEnabled || this.budgetWindows.length === 0) {
      flowNote("COORDINATOR", "debug_set_budget ignored — no budget tracked (full-attention session)");
      return;
    }
    const now = Date.now();
    const clamped = Math.max(0, Math.min(100, percent));
    const next: BudgetState = {};
    for (const w of this.budgetWindows) {
      next[w.key] = { drain: Math.max(0, w.cfg.ceiling * (1 - clamped / 100)), asOf: now };
    }
    this.budgetState = next;
    this.budgetDirty = true;
    flowNote("COORDINATOR", `debug_set_budget → all windows forced to ${clamped}%`);
    // Reset the report/push trackers so the [ENERGY] note + bar fire even if the
    // integer band didn't change.
    this.lastSentBudgetPercent = -1;
    this.lastReportedEnergyPercent = 100;
    this.reportEnergy(now, { fromCharge: true });
    this.maybePushBudget(now);
    this.maybePersistBudget(now);
  }

  /** Push the binding (tightest) window % + band to the client's energy bar,
   *  but only when the integer % changed since the last push (charges are
   *  frequent; the bar is approximate). Sent whenever economizing — it's an
   *  informational display, independent of the AAC_BUDGET_METER throttle gate.
   *  A non-economizing session never tracks a budget, so it gets no bar. */
  private maybePushBudget(now: number): void {
    if (!this.budgetMeterEnabled) return;
    const b = bindingEnergy(this.budgetState, this.budgetWindows, now);
    if (b.percent === this.lastSentBudgetPercent) return;
    this.lastSentBudgetPercent = b.percent;
    this.send({ type: "budget_update", data: { percent: b.percent, band: b.band, window: b.window } });
  }

  /** Persist budget state at most every BUDGET_SAVE_MIN_INTERVAL_MS while a
   *  session runs (a charge sets `budgetDirty`). The debounce is bypassed once
   *  closing/closed so a late teardown charge (e.g. the session-summary HTTP
   *  call) still persists. `flushBudget()` also runs on cleanup. */
  private maybePersistBudget(now: number): void {
    if (!this.budgetDirty || !this.studentId) return;
    const closing = this.state === "closing" || this.state === "closed";
    if (!closing && now - this.lastBudgetSaveAt < AgentCoordinator.BUDGET_SAVE_MIN_INTERVAL_MS) return;
    this.lastBudgetSaveAt = now;
    this.budgetDirty = false;
    void studentRepository.updateBudgetMeters(this.studentId, this.budgetState);
  }

  /** Force-persist the latest budget state (session close). Fire-and-forget;
   *  the repository swallows + logs failures so cleanup never throws. */
  private flushBudget(): void {
    if (!this.budgetDirty || !this.studentId) return;
    this.budgetDirty = false;
    this.lastBudgetSaveAt = Date.now();
    void studentRepository.updateBudgetMeters(this.studentId, this.budgetState);
  }

  /**
   * Push the single cost level (the money budget's binding-window %) to the
   * Observer as an [ENERGY] note and re-drive the throttle. The AI experiences
   * the budget as "energy/tiredness", so the note keeps that framing while the
   * number IS the budget. Reports on (a) a band change — with guidance — and
   * (b) a recovery of >=1% since the last report; a drain that doesn't cross a
   * band lowers the baseline SILENTLY, so the next recovery is measured from the
   * recent low. A note that can't be delivered (Observer torn down) isn't lost —
   * a freshly-rebuilt Observer is re-seeded via primeFreshObserver.
   */
  private reportEnergy(now: number, opts: { fromCharge: boolean }): void {
    if (!this.budgetMeterEnabled) return;
    const b = bindingEnergy(this.budgetState, this.budgetWindows, now);
    const pct = b.percent;
    const band = b.band;
    const bandChanged = band !== this.lastEnergyBand;
    const recovered = pct - this.lastReportedEnergyPercent >= 1;

    if ((bandChanged || recovered) && this.observer) {
      const guidance = bandChanged ? ` ${AgentCoordinator.energyGuidance(band)}` : "";
      this.observer.sendContextInjection(`[ENERGY] ${pct}% remaining — ${band}.${guidance}`);
      this.lastReportedEnergyPercent = pct;
      runInSessionContext(this.sessionId || "?", this.debugMode, () => {
        flowNote("COORDINATOR", `Energy ${pct}% (${band})${bandChanged ? " — band change" : " — recovery"}`);
      });
    } else if (opts.fromCharge && pct < this.lastReportedEnergyPercent) {
      this.lastReportedEnergyPercent = pct;
    }
    // Track the band even when the note wasn't delivered (Observer null) so the
    // flowNote fires once per band change; primeFreshObserver re-seeds a fresh
    // Observer with the current level regardless.
    if (bandChanged) this.lastEnergyBand = band;

    // Apply the mechanical throttle: low band (<25%) forces the cheap HTTP
    // Observer + tired Speaker; the budget-scaled sleep timer + <10%/<0% floors
    // live in maybeIdleTransition / doWakeFromSleep.
    this.applyEnergyThrottle(band);
    this.applyBudgetFloors(now);
  }

  /** Enforce the economy-backend floor. Force the cheap HTTP Observer as soon
   *  as the governing budget/energy leaves the healthy band (the Observer's
   *  native-audio Live session is the single biggest drain, so we don't wait
   *  for the low band to shed it); release once it recovers to high. Idempotent;
   *  safe to call often. */
  private applyEnergyThrottle(band: EnergyBand): void {
    if (!this.economyObserverEnabled) return;
    if (band === "low") {
      // <25%: force the cheap HTTP Observer backend regardless of its own
      // choice (the native-audio Live session is the single biggest drain).
      if (this.observerMode === "live" && !this.observerSwitchInFlight) {
        this.observerForcedEconomy = true;
        // Don't tear the Observer down mid-sentence: if the AI is speaking,
        // defer the switch to the next idle boundary (onSpeakerSpeechEnd) so it
        // lands the moment it's not busy rather than cutting the reply.
        if (this.isAiSpeaking()) {
          this.economySwitchPendingIdle = true;
          flowNote("COORDINATOR", "Low budget — economy switch deferred until the AI finishes speaking.");
        } else {
          this.economySwitchPendingIdle = false;
          void this.switchObserverBackend("economy", "low budget (<25%) — forced HTTP");
        }
      }
    } else if (this.observerForcedEconomy && this.observerPolicy.allowLive) {
      // Recovered out of the low band (≥25%) — lift the lock; the Observer may
      // go live again on its own (it gets prompted). Above 25% is unthrottled
      // on the backend, per the existing floors. A Live-forbidden policy (e.g.
      // Demo) keeps the lock: the backend stays pinned to economy forever.
      this.observerForcedEconomy = false;
      this.economySwitchPendingIdle = false;
      flowNote("COORDINATOR", "Budget recovered above 25% — economy lock lifted; Observer may go live.");
    }
  }

  /**
   * Speaker-side low-band floor: at <25% the Speaker is told it's TIRED so it
   * acts tired and keeps replies brief (the avatar's resting eyes are the
   * client half, pass 2). Dedup'd to the transition and re-applied to a rebuilt
   * Speaker (primeFreshSpeaker). Lifted when the budget recovers out of the low
   * band. The deeper floors (<10% Speaker never wakes, <0% all-stop) are enforced
   * on wake in doWakeFromSleep. No-op while asleep / not ready.
   */
  private applyBudgetFloors(now: number): void {
    if (!this.budgetThrottleEnabled || this.asleep || this.state !== "ready") return;
    const b = bindingEnergy(this.budgetState, this.budgetWindows, now);
    const wantTired = b.band === "low";
    if (wantTired && !this.budgetSpeakerTiredActive) {
      this.budgetSpeakerTiredActive = true;
      this.speaker?.sendContextInjection(AgentCoordinator.SPEAKER_TIRED_NOTE);
      flowNote("COORDINATOR", `Budget ${b.percent}% (low) — Speaker set to tired.`);
    } else if (this.budgetSpeakerTiredActive && b.band !== "low") {
      this.budgetSpeakerTiredActive = false;
      this.speaker?.sendContextInjection(`[ENERGY] You've rested and have energy again — speak normally.`);
      flowNote("COORDINATOR", "Budget recovered out of low — Speaker tired-mode lifted.");
    }
  }

  /** The tired-Speaker instruction injected at the low band. */
  private static readonly SPEAKER_TIRED_NOTE =
    `[ENERGY] You're tired — low on energy. Keep replies short and a little sleepy; reply when addressed but don't start new topics or chatter proactively until you've rested.`;

  private startEnergyTimer(): void {
    this.stopEnergyTimer();
    if (!this.budgetMeterEnabled) return;
    this.energyTimer = setInterval(
      () => {
        const now = Date.now();
        // Passive regen can cross a band during a quiet stretch with no charge
        // to trigger it — recompute the level + throttle and refresh the bar.
        this.reportEnergy(now, { fromCharge: false });
        this.maybePushBudget(now);
      },
      AgentCoordinator.ENERGY_TICK_MS,
    );
  }

  private stopEnergyTimer(): void {
    if (this.energyTimer) {
      clearInterval(this.energyTimer);
      this.energyTimer = null;
    }
  }

  /**
   * Apply an Observer attention change (set_visual_attention / set_audio_attention):
   * flip the corresponding clientConfig flag, push it to the client, and confirm
   * back to the Observer with the new drain expectation. No-op outside economize
   * (full-attention already streams everything) and when the client can't supply
   * the cheap "text" form for that modality.
   */
  private setAttention(modality: "visual" | "audio", level: "text" | "adaptive" | "live", reason?: string): void {
    if (!this.economize) return;
    const patch: Partial<ClientConfig> = {};
    if (modality === "visual") {
      if (level === "adaptive") return; // visual is binary (text/live)
      if (this.visualAttention === level) return;
      if (level === "text" && !this.capable("sceneState")) return; // can't downshift without scene-state support
      this.visualAttention = level;
      patch.sceneStateActive = level === "text";
    } else {
      if (this.audioAttention === level) return;
      if (level === "text" && !this.capable("clientStt")) return; // can't downshift to STT without on-device support
      this.audioAttention = level;
      // text = STT (no raw PCM). adaptive = VAD-gated raw PCM. live = continuous raw PCM.
      patch.sttActive = level === "text";
      patch.pcmContinuous = level === "live";
    }
    this.send({ type: "client_config_update", config: patch });
    runInSessionContext(this.sessionId || "?", this.debugMode, () => {
      flowNote("COORDINATOR", `Attention ${modality} → ${level}${reason ? ` (${reason})` : ""}`);
    });
    const costNote =
      level === "live" ? ` Continuous direct ${modality === "visual" ? "frames" : "audio"} — most faithful but drains energy fastest; drop back when done.`
      : level === "adaptive" ? ` Gated raw audio (silence dropped) — cheaper, but your transcription of it may be slightly less accurate than text/live.`
      : ` Back to cheap ${modality} text.`;
    this.observer?.sendContextInjection(`[ATTENTION] ${modality} → ${level}.${costNote}`);
  }

  /**
   * Budget-derived <energy_budget> block for the Observer prompt. Rough by
   * design — it just needs to convey the right ORDER of magnitude so the model
   * can weigh observation against its budget. Everything scales off the live
   * energy config (ceiling/regen) + the Observer model's non-text input rate, so
   * if the budget rules change (or a long/short-term budget is added later) the
   * numbers track automatically. Anchored on the historic full-live spend, split
   * roughly across modalities; the real meter does the actual accounting and the
   * Observer also learns empirically from its [ENERGY] notes.
   */
  private buildEnergyBudgetText(provider: string): string {
    if (!this.budgetMeterEnabled) return "";
    // Rates are expressed against the binding (tightest) budget window, so they
    // track the same % the [ENERGY] note shows. Rough by design.
    const cfg = this.bindingWindowCfg(Date.now());
    if (!(cfg.ceiling > 0)) return "";
    const perHour = cfg.perHour;
    const regenPctMin = Math.round((perHour / 60 / cfg.ceiling) * 1000) / 10;
    const refillHrs = perHour > 0 ? Math.round((cfg.ceiling / perHour) * 10) / 10 : 0;
    // Baseline cost of just keeping a Live observation session warm and acting
    // on routine scene/speech turns — NOT free. Empirically a native-audio Live
    // Observer drains ~1.9%/min even at "text" attention with no dials raised,
    // already well above regen. Surfacing this honestly is what lets the
    // Observer self-govern (rest sooner) instead of believing watching is free.
    const baselineUsdPerMin = Number(process.env.AAC_OBSERVER_BASELINE_USD_PER_MIN) || 0.057;
    const baselinePctMin = Math.round((baselineUsdPerMin / cfg.ceiling) * 1000) / 10;
    // Sustained full-live (both modalities) spend, credits(=USD)/min. Tunable.
    const fullLivePerMin = Number(process.env.AAC_FULL_LIVE_USD_PER_MIN) || 0.89;
    const visualPerMin = fullLivePerMin * 0.6;
    const audioLivePerMin = fullLivePerMin * 0.5;
    const audioAdaptivePerMin = audioLivePerMin * 0.4; // silence-cut → ~40% of continuous
    const pctMin = (perMin: number) => Math.round((perMin / cfg.ceiling) * 100);
    const emptyIn = (perMin: number) => {
      const m = minutesToEmpty(perMin, cfg, perHour);
      return m === null ? "stays within your regen" : `~${m} min until empty`;
    };
    // One-off pull cost from the model's non-text input rate (rough token counts).
    const opt = getModelOption(provider as any, this.observerModel);
    const nonTextRate = (opt as any)?.audioInputCostPer1M ?? opt?.inputCostPer1M ?? 3;
    const focusPct = energyCostPercent((1000 * nonTextRate) / 1_000_000, cfg);
    const audioClipPct = energyCostPercent((160 * nonTextRate) / 1_000_000, cfg);
    const pull = Math.max(focusPct, audioClipPct);
    // The honest baseline line is part of the cost-saving system (default off);
    // when disabled, keep the original "text attention is essentially free" line
    // so behavior is unchanged.
    const baselineLine = this.economyObserverEnabled
      ? `  - Just staying awake and watching (even on cheap "text" [SCENE]/[HEARD SPEECH]) costs ~${baselinePctMin}%/min — this is the FLOOR, and it already outpaces your ~${regenPctMin}%/min regen. So long awake stretches steadily drain you even when you raise no attention: rest() during quiet gaps and don't stay awake out of habit.`
      : `  - Default "text" attention (cheap [SCENE]/[HEARD SPEECH]): essentially free — stays within your regen.`;
    return `<energy_budget>
Rough costs (approximate — your [ENERGY] notes show the real level; budget regenerates ~${regenPctMin}%/min, full refill from empty ~${refillHrs}h):
${baselineLine}
  - set_audio_attention("adaptive"): ~${pctMin(audioAdaptivePerMin)}%/min (${emptyIn(audioAdaptivePerMin)}) — gated raw audio, cheaper than live.
  - set_audio_attention("live"): ~${pctMin(audioLivePerMin)}%/min (${emptyIn(audioLivePerMin)}) — continuous, most faithful.
  - set_visual_attention("live"): ~${pctMin(visualPerMin)}%/min (${emptyIn(visualPerMin)}).
  - Audio "live" + visual "live" at once: ~${pctMin(visualPerMin + audioLivePerMin)}%/min (${emptyIn(visualPerMin + audioLivePerMin)}) — expensive; reserve for real need.
  - A single request_focus / request_audio: under ${Math.max(0.1, pull)}% — one-off checks are cheap; it's SUSTAINED attention that drains you.
Other agents draw on the same budget — when the Speaker talks a lot your energy drops even while you only watch.
</energy_budget>`;
  }

  /** EnergyConfig of the current binding (tightest) budget window, for rate/%
   *  math that should track the same % the [ENERGY] note shows. Falls back to a
   *  zero-ceiling cfg when no windows are loaded (throttle disabled). */
  private bindingWindowCfg(now: number): EnergyConfig {
    const b = bindingEnergy(this.budgetState, this.budgetWindows, now);
    const w = this.budgetWindows.find(win => win.key === b.window);
    return w?.cfg ?? { ceiling: 0, perHour: 0 };
  }

  /** Compact energy status appended to each [HEARD SPEECH] turn — current level
   *  (the budget binding %) plus what the exchange since the last transcript
   *  cost as a % of that window, with the Speaker's share called out (the
   *  Observer never "sees" the Speaker spend otherwise). Resets the accumulator. */
  private buildTranscriptEnergyNote(): string {
    if (!this.budgetMeterEnabled) return "";
    const now = Date.now();
    const cfg = this.bindingWindowCfg(now);
    const pct = bindingEnergy(this.budgetState, this.budgetWindows, now).percent;
    const d = this.drainSinceTranscript;
    this.drainSinceTranscript = { observer: 0, speaker: 0, boardManager: 0 };
    const totalPct = energyCostPercent(d.observer + d.speaker + d.boardManager, cfg);
    if (totalPct < 0.1) return `[ENERGY ${pct}%]`;
    const speakerPct = energyCostPercent(d.speaker, cfg);
    const speakerNote = speakerPct >= 0.1 ? `, speaker ${speakerPct}%` : "";
    return `[ENERGY ${pct}% | since last −${totalPct}%${speakerNote}]`;
  }

  /** One-line cost-aware reminder per band (the full rationale is in the
   *  Observer's <energy> prompt block). The band is the money budget's. */
  private static energyGuidance(band: EnergyBand): string {
    switch (band) {
      case "high": return "Observe freely.";
      case "moderate": return "Favor the cheap text signals; pull a real image/audio only when it genuinely matters.";
      case "low": return "Budget nearly spent — minimal observation, lean on text, wake only on clear engagement. NEVER skip a safety concern.";
    }
  }

  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------

  private recordEvent(event: AgentEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > RECENT_EVENTS_WINDOW) {
      this.recentEvents.splice(0, this.recentEvents.length - RECENT_EVENTS_WINDOW);
    }
  }

  /** Log a routed event. Wrapped in session context so debug-mode rows
   *  land in session_debug_logs too. */
  private logEvent(agentLabel: string, event: AgentEvent): void {
    if (!this.sessionId) return;
    runInSessionContext(this.sessionId, this.debugMode, () => {
      logDualAgent(`${agentLabel} → ${event.type}`, { event });
    });
  }

  // -------------------------------------------------------------------------
  // Send-to-client helpers
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Face recognition (ported from LiveRelay). Matching itself lives in
  // server/services/biometric/recognition-service.ts and is scoped strictly
  // to this student's known people.
  // -------------------------------------------------------------------------

  /**
   * Match each incoming face descriptor against the user's known people
   * (self + linked users + contacts). Populates `currentIdentifiedFaces`,
   * echoes the list to the client for the debug display, and rate-limit-bumps
   * `recordContactSighting()` for confident contact matches.
   */
  private async recognizeFaces(
    descriptors: Array<{
      descriptor: number[];
      boundingBox?: { x: number; y: number; w: number; h: number };
      cameraRole?: "user" | "environment" | "unknown";
      cameraLabel?: string;
      quality?: number;
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
          description: m.description,
          sampleCount: m.sampleCount,
          // Below this confidence the match is ambiguous — ask the AI to verify
          // against the description instead of trusting the name outright.
          borderline: m.confidence < AgentCoordinator.BORDERLINE_CONFIDENCE,
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

    // Rate-limited sighting bumps for confidently-matched contacts only.
    const now = Date.now();
    for (const f of wire) {
      if (!f.matched || f.entityType !== "contact" || !f.entityId) continue;
      if (f.confidence < 0.4) continue;
      const last = this.lastSightingBumpAt.get(f.entityId) ?? 0;
      if (now - last < AgentCoordinator.SIGHTING_BUMP_INTERVAL_MS) continue;
      this.lastSightingBumpAt.set(f.entityId, now);
      recordContactSighting(f.entityId).catch(err => {
        logLiveSession("SIGHTING_BUMP_ERROR", `${f.entityId}: ${(err as Error).message}`);
      });
    }

    // Hold the sample behind each face WITHOUT growing the gallery — growth is
    // gated behind Observer verification (seedFaceFromObserver). Matches keep
    // their descriptor as a pending sample (also the correction target); UNKNOWN
    // faces keep the best-quality one so the Observer naming a new person can
    // seed it. Nothing is committed to the gallery until the Observer confirms.
    for (let i = 0; i < wire.length; i++) {
      const f = wire[i];
      const d = descriptors[i];
      if (!d) continue;
      if (f.matched && f.entityId && f.entityType) {
        const key = `${f.entityType}:${f.entityId}`;
        this.recentMatchedDescriptors.set(key, { descriptor: d.descriptor, quality: d.quality, at: now });
      } else if (!f.matched && typeof d.quality === "number" && d.quality >= AgentCoordinator.FACE_SAMPLE_QUALITY_MIN) {
        if (!this.recentUnattributedFace || d.quality >= this.recentUnattributedFace.quality) {
          this.recentUnattributedFace = { descriptor: d.descriptor, quality: d.quality, at: now };
        }
      }
    }

    // First identification of the active user arms the startup greeting (which
    // then waits for scene context before firing). set_person_as_user is
    // finicky, so we don't wait for it.
    this.maybeArmStartupGreet();
  }

  /**
   * Server-side speaker matching for the voice embeddings the client computes
   * from heard speech (mirror of recognizeFaces). Populates
   * `currentIdentifiedVoices`, echoes to the client debug display, refines the
   * gallery for confident matches, and — crucially — stashes the most-recent
   * UNATTRIBUTED embedding so the Observer naming an unknown voice can seed a
   * brand-new identity (a voice can't self-attribute the way a face descriptor
   * does). Absence of voice is NOT "nobody" (people fall silent), so an empty
   * batch does NOT clear the list.
   */
  private async recognizeVoices(
    descriptors: Array<{ embedding: number[]; quality?: number }>,
    pitch?: number,
    dispersion?: number,
  ): Promise<void> {
    if (!this.studentId || !descriptors.length) return;

    const matches = await Promise.all(
      descriptors.map(d => findMatchingVoice(d.embedding, this.studentId!).catch(() => null as VoiceMatchResult | null)),
    );

    const now = Date.now();
    let unknownCounter = 0;
    const wire: IdentifiedVoiceWire[] = descriptors.map((d, i) => {
      const m = matches[i];
      if (m && m.matched) {
        return {
          voiceIndex: i,
          matched: true,
          name: m.name,
          entityType: m.entityType,
          entityId: m.entityId,
          relationship: m.relationship,
          confidence: m.confidence,
          similarity: m.similarity,
          sampleCount: m.sampleCount,
          description: m.description,
          borderline: m.confidence < AgentCoordinator.BORDERLINE_CONFIDENCE,
        };
      }
      unknownCounter += 1;
      return { voiceIndex: i, matched: false, name: `Unknown voice #${unknownCounter}`, confidence: 0 };
    });

    this.currentIdentifiedVoices = wire;
    this.currentIdentifiedVoicesAt = now;
    this.send({ type: "voices_identified", data: wire });

    for (let i = 0; i < descriptors.length; i++) {
      const d = descriptors[i];
      const f = wire[i];
      if (f.matched && f.entityId && f.entityType) {
        // Remember the embedding behind the match as a PENDING sample (also the
        // correction target). Growth is gated behind Observer verification
        // (voice_identified / set_person_as_user → seedVoiceFromObserver) — we
        // never refine the gallery from an unverified match, so a voice embedding
        // can't self-reinforce a wrong identity.
        const key = `${f.entityType}:${f.entityId}`;
        this.recentMatchedVoiceEmbeddings.set(key, { embedding: d.embedding, quality: d.quality, pitch, dispersion, at: now });
      } else if (typeof d.quality === "number" && d.quality >= AgentCoordinator.VOICE_SAMPLE_QUALITY_MIN) {
        // Couldn't attribute this voice — hold the best recent sample so the
        // Observer can name it (voice_identified → seedVoiceFromObserver).
        if (!this.recentUnattributedVoice || d.quality >= this.recentUnattributedVoice.quality) {
          this.recentUnattributedVoice = { embedding: d.embedding, quality: d.quality, pitch, dispersion, at: now };
        }
      }
    }
  }

  /**
   * The Observer named a heard voice (update_context: voice_identified, or named
   * the active user). Resolve that name to a known person and seed their voice
   * gallery with the most-recent unattributed embedding. This is the bootstrap
   * bridge: an unknown voice has no way to attach itself to an identity on its
   * own, so the Observer's intuition supplies WHO it is and we capture the
   * acoustic sample. A stale or missing unattributed sample is a no-op.
   */
  private async seedVoiceFromObserver(name: string): Promise<void> {
    if (!this.studentId || !name) return;
    const fresh = (at: number) => Date.now() - at <= AgentCoordinator.RECENT_MATCH_TTL_MS;

    let people: KnownPerson[];
    try {
      people = await getKnownPeopleForStudent(this.studentId);
    } catch (err) {
      logLiveSession("VOICE_SEED_ERROR", `known-people lookup failed: ${(err as Error).message}`);
      return;
    }
    const target = this.resolvePersonByName(people, name);
    if (!target) {
      logLiveSession("VOICE_SEED", `Observer named "${name}" but no known person matched — not seeding.`);
      return;
    }

    // Prefer the embedding that matched THIS person (confirming a known voice);
    // fall back to the most-recent unattributed one (naming a new voice). Either
    // way we only commit because the Observer just verified the identity.
    const key = `${target.type}:${target.id}`;
    const matched = this.recentMatchedVoiceEmbeddings.get(key);
    let embedding: number[] | null = null;
    let quality: number | undefined;
    let pitch: number | undefined;
    let dispersion: number | undefined;
    let fromUnattributed = false;
    if (matched && fresh(matched.at) && typeof matched.quality === "number") {
      embedding = matched.embedding;
      quality = matched.quality;
      pitch = matched.pitch;
      dispersion = matched.dispersion;
    } else if (this.recentUnattributedVoice && fresh(this.recentUnattributedVoice.at)) {
      embedding = this.recentUnattributedVoice.embedding;
      quality = this.recentUnattributedVoice.quality;
      pitch = this.recentUnattributedVoice.pitch;
      dispersion = this.recentUnattributedVoice.dispersion;
      fromUnattributed = true;
    }
    if (!embedding || typeof quality !== "number") {
      logLiveSession("VOICE_SEED", `"${name}" confirmed but no fresh voice sample to commit.`);
      return;
    }

    try {
      // Commit the embedding AND its acoustic cues (pitch + dispersion) — these
      // feed the fast tier's match/age-gender read next time.
      const res = await growVoiceGalleryForEntity({ type: target.type, id: target.id }, embedding, quality, pitch, dispersion);
      if (res.added) this.pitchProfiles = null; // new acoustic sample → refresh profiles
      if (res.added && fromUnattributed) this.recentUnattributedVoice = null; // consumed
      logLiveSession("VOICE_SEED", `"${name}" → ${key}: ${res.reason} (size ${res.size})${typeof pitch === "number" ? ` pitch=${pitch}Hz` : ""}${typeof dispersion === "number" ? ` disp=${dispersion}Hz` : ""}.`);
    } catch (err) {
      logLiveSession("VOICE_SEED_ERROR", `grow failed for ${key}: ${(err as Error).message}`);
    }
  }

  /**
   * The Observer confirmed/named a FACE (update_context: person_identified, or
   * set_person_as_user). Mirror of seedVoiceFromObserver — this is the ONLY path
   * that grows the face gallery, so an embedding never self-reinforces an
   * identity the Observer hasn't verified against the on-file description.
   * Prefers the descriptor that matched the named person (confirming a known
   * face from a fresh angle); falls back to the most-recent unattributed face
   * (naming a brand-new person). A stale/missing sample is a no-op.
   */
  private async seedFaceFromObserver(name: string): Promise<void> {
    if (!this.studentId || !name) return;
    const fresh = (at: number) => Date.now() - at <= AgentCoordinator.RECENT_MATCH_TTL_MS;

    let people: KnownPerson[];
    try {
      people = await getKnownPeopleForStudent(this.studentId);
    } catch (err) {
      logLiveSession("FACE_SEED_ERROR", `known-people lookup failed: ${(err as Error).message}`);
      return;
    }
    const target = this.resolvePersonByName(people, name);
    if (!target) {
      logLiveSession("FACE_SEED", `Observer named "${name}" but no known person matched — not seeding.`);
      return;
    }

    const key = `${target.type}:${target.id}`;
    const matched = this.recentMatchedDescriptors.get(key);
    let descriptor: number[] | null = null;
    let quality: number | undefined;
    let fromUnattributed = false;
    if (matched && fresh(matched.at) && typeof matched.quality === "number") {
      descriptor = matched.descriptor;
      quality = matched.quality;
    } else if (this.recentUnattributedFace && fresh(this.recentUnattributedFace.at)) {
      descriptor = this.recentUnattributedFace.descriptor;
      quality = this.recentUnattributedFace.quality;
      fromUnattributed = true;
    }
    if (!descriptor || typeof quality !== "number") {
      logLiveSession("FACE_SEED", `"${name}" confirmed but no fresh face sample to commit.`);
      return;
    }

    try {
      const res = await growFaceGalleryForEntity({ type: target.type, id: target.id }, descriptor, quality);
      if (res.added && fromUnattributed) this.recentUnattributedFace = null; // consumed
      logLiveSession("FACE_SEED", `"${name}" → ${key}: ${res.reason} (size ${res.size}).`);
    } catch (err) {
      logLiveSession("FACE_SEED_ERROR", `grow failed for ${key}: ${(err as Error).message}`);
    }
  }

  /** Resolve an Observer-supplied person name/role ("Mom", "Yael", a real name)
   *  to a known person. Case-insensitive: exact name first, then relationship,
   *  then a contains-match. Returns null when nothing is a clear hit (we'd
   *  rather not seed than seed the wrong person). */
  private resolvePersonByName(people: KnownPerson[], name: string): KnownPerson | null {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    return (
      people.find(p => p.name.trim().toLowerCase() === n) ||
      people.find(p => (p.relationship ?? "").trim().toLowerCase() === n) ||
      people.find(p => {
        const pn = p.name.trim().toLowerCase();
        return pn.length >= 3 && (pn.includes(n) || n.includes(pn));
      }) ||
      null
    );
  }

  /**
   * Render the currently-heard voices as a compact `[VOICES HEARD]` block,
   * appended after `[PEOPLE PRESENT]`. Returns "" when nothing recent is on
   * file. A voice match is weaker evidence than a face (no `[THE STUDENT]`
   * tag here), so it's framed as a hint the Observer cross-checks against what
   * it sees and hears rather than authoritative identity.
   */
  private buildVoicesHeardContext(): string {
    if (!this.currentIdentifiedVoices.length) return "";
    if (Date.now() - this.currentIdentifiedVoicesAt > AgentCoordinator.IDENTIFIED_VOICES_TTL_MS) return "";
    const matched = this.currentIdentifiedVoices.filter(v => v.matched);
    if (!matched.length) return "";
    const lines = matched.map(v => {
      const conf = (v.confidence * 100).toFixed(0);
      const rel = v.relationship ? `, ${v.relationship}` : "";
      const samples = v.sampleCount ?? 0;
      const dataNote = samples > 0
        ? ` [${samples} voice sample${samples === 1 ? "" : "s"} on file${samples <= 1 ? " — limited data, a low score is expected" : ""}]`
        : "";
      const hedge = v.borderline ? " (UNCERTAIN — confirm by what you see/hear before using the name)" : "";
      const desc = v.borderline && v.description ? ` On file: ${v.description}.` : "";
      return `- ${v.name}${rel} — sounds like a ${conf}% voice match${hedge}${dataNote}.${desc}`;
    });
    return `[VOICES HEARD]\n${lines.join("\n")}\n(A voice match is a HINT, not proof of presence — a visible face outranks it. If a named voice doesn't fit who you can see, attribute speech by what you observe.)`;
  }

  /**
   * Apply a misidentification correction: the entity was recently matched to a
   * face that turned out NOT to be them, so penalize the stored embedding that
   * produced the bad match. Uses the descriptor remembered from the most recent
   * match (see `recentMatchedDescriptors`); a stale or missing descriptor is a
   * no-op. Also drops the entity from the current identified-faces list so the
   * AI stops acting on the wrong name immediately.
   */
  private async correctMisidentification(
    entityType: EntityType,
    entityId: string,
    reason?: string,
  ): Promise<void> {
    const key = `${entityType}:${entityId}`;
    const now = Date.now();
    const recent = this.recentMatchedDescriptors.get(key);
    const recentVoiceEarly = this.recentMatchedVoiceEmbeddings.get(key);
    const hasFace = !!recent && now - recent.at <= AgentCoordinator.RECENT_MATCH_TTL_MS;
    const hasVoice = !!recentVoiceEarly && now - recentVoiceEarly.at <= AgentCoordinator.RECENT_MATCH_TTL_MS;
    if (!hasFace && !hasVoice) {
      logLiveSession("IDENTITY_CORRECTION", `No fresh face/voice match for ${key} — nothing to penalize.`);
      return;
    }

    let faceNote = "no recent face match";
    if (hasFace) {
      const result = await penalizeFaceMatch({ type: entityType, id: entityId }, recent!.descriptor);
      this.recentMatchedDescriptors.delete(key);
      faceNote = `face: penalized ${result.penalized}${result.evicted ? " (evicted)" : ""}, gallery ${result.size}`;
    }

    // Voice can mis-fire independently of the face, so a correction penalizes
    // whichever modality(ies) recently matched this entity.
    const recentVoice = this.recentMatchedVoiceEmbeddings.get(key);
    let voiceNote = "no recent voice match";
    if (recentVoice && Date.now() - recentVoice.at <= AgentCoordinator.RECENT_MATCH_TTL_MS) {
      const vres = await penalizeVoiceMatch({ type: entityType, id: entityId }, recentVoice.embedding);
      this.recentMatchedVoiceEmbeddings.delete(key);
      voiceNote = `voice: penalized ${vres.penalized}${vres.evicted ? " (evicted)" : ""}, gallery ${vres.size}`;
    }

    // Stop acting on the corrected identity right away — drop it from BOTH lists.
    const beforeFaces = this.currentIdentifiedFaces.length;
    this.currentIdentifiedFaces = this.currentIdentifiedFaces.filter(
      f => !(f.matched && f.entityType === entityType && f.entityId === entityId),
    );
    if (this.currentIdentifiedFaces.length !== beforeFaces) {
      this.currentIdentifiedFacesAt = Date.now();
      this.send({ type: "people_identified", data: this.currentIdentifiedFaces });
    }
    const beforeVoices = this.currentIdentifiedVoices.length;
    this.currentIdentifiedVoices = this.currentIdentifiedVoices.filter(
      v => !(v.matched && v.entityType === entityType && v.entityId === entityId),
    );
    if (this.currentIdentifiedVoices.length !== beforeVoices) {
      this.currentIdentifiedVoicesAt = Date.now();
      this.send({ type: "voices_identified", data: this.currentIdentifiedVoices });
    }

    logLiveSession(
      "IDENTITY_CORRECTION",
      `${key} corrected${reason ? ` (${reason})` : ""}: ${faceNote}; ${voiceNote}.`,
    );
  }

  /**
   * Render a client `scene_state` snapshot into the `[SCENE]` text, swapping in
   * the server's authoritative identities. The tracker (MediaPipe) supplies
   * movement/expression + a bbox per person but rarely knows WHO anyone is; we
   * correlate by bbox IoU against the fresh face-api matches so "person 1"
   * becomes "Mom 88% [student]". Stale identities (past the TTL) are dropped so
   * the scene never names someone who left.
   */
  private renderScene(snap: SceneSnapshot): string {
    const fresh = this.currentIdentifiedFaces.length > 0
      && Date.now() - this.currentIdentifiedFacesAt <= AgentCoordinator.IDENTIFIED_FACES_TTL_MS;
    const identified: IdentifiedForScene[] = fresh
      ? this.currentIdentifiedFaces.map(f => ({
          name: f.name,
          confidence: f.confidence,
          matched: f.matched,
          isStudent: f.entityType === "student",
          bbox: f.boundingBox,
        }))
      : [];
    return renderSceneForObserver(snap, identified);
  }

  /**
   * Render the currently-identified faces as a compact `[PEOPLE PRESENT]`
   * block for the Observer. Returns "" when nothing recent is on file. The
   * `[THE STUDENT]` tag lets the prompt require positive identification rather
   * than mistaking a visible caregiver/sibling for the primary user.
   */
  private buildPeoplePresentContext(): string {
    if (!this.currentIdentifiedFaces.length) return "";
    if (Date.now() - this.currentIdentifiedFacesAt > AgentCoordinator.IDENTIFIED_FACES_TTL_MS) return "";
    const cameraSuffix = (role?: string): string => {
      if (role === "user") return " — in front of student";
      if (role === "environment") return " — environment camera";
      return "";
    };
    let anyBorderline = false; // a NON-student known person matched only weakly
    let confidentOther = false; // a non-student known person matched confidently
    const lines = this.currentIdentifiedFaces.map(f => {
      const where = cameraSuffix(f.cameraRole);
      if (!f.matched) return `- ${f.name} (no database match)${where}`;
      const conf = (f.confidence * 100).toFixed(0);
      const rel = f.relationship ? `, ${f.relationship}` : "";
      const isStudent = f.entityType === "student";
      // Certainty depends on how much reference data backs the match, not just
      // the score. A weak score off 0–1 samples is EXPECTED (we've barely seen
      // this face) and shouldn't be read as evidence against identity; a weak
      // score off many samples is genuinely meaningful.
      const samples = f.sampleCount ?? 0;
      const sparseData = samples <= 1;
      const dataNote = samples > 0
        ? ` [${samples} reference${samples === 1 ? "" : "s"} on file${sparseData ? " — limited data, so a low score is expected" : ""}]`
        : "";
      // Err toward the student: a student match is taken as the student even at
      // low confidence — the student is the device's default occupant, so we do
      // NOT hedge their identity. The UNCERTAIN caution exists only to stop us
      // greeting a stranger as a NAMED relative/caregiver, so it applies to
      // non-student known people — AND only when we have enough data to trust a
      // low score (with sparse data a weak match isn't real evidence either way).
      if (!isStudent && f.borderline && !sparseData) {
        anyBorderline = true;
        const desc = f.description ? ` On file: ${f.description}.` : "";
        return `- ${f.name}${rel} — ${conf}% confidence (UNCERTAIN — verify before using the name)${where}${dataNote}.${desc}`;
      }
      if (isStudent) {
        const hedge = f.confidence < AgentCoordinator.BORDERLINE_CONFIDENCE
          ? " (low-confidence match, but assume this IS the student)"
          : "";
        return `- ${f.name}${rel} — ${conf}% confidence${hedge}${where} [THE STUDENT]${dataNote}`;
      }
      if (!f.borderline) confidentOther = true;
      // Surface the on-file description on confident matches too — the Observer
      // verifies the guess against it before confirming the identity (which is
      // what lets the system learn this face). See <identity> in the prompt.
      const desc = f.description ? ` On file: ${f.description}.` : "";
      return `- ${f.name}${rel} — ${conf}% confidence${where}${dataNote}${desc}`;
    });
    const borderlineLine = anyBorderline
      ? `\n(NOTE: an UNCERTAIN match means the face only loosely resembles the named person. Compare the on-file description to what you see. If it doesn't fit, treat them as unidentified rather than greeting the wrong person.)`
      : "";
    // Identity default: assume the person at the device is the student unless
    // there is positive evidence otherwise — the student matched (handled
    // above), OR a DIFFERENT known person matched confidently. Nobody matched →
    // still default to the student, not "a stranger".
    let presenceLine = "";
    if (!this.sawStudentFace()) {
      presenceLine = confidentOther
        ? `\n(NOTE: a non-student known person is identified above and the student is not among the faces — the active user is that person, not the student.)`
        : `\n(NOTE: no face is confidently identified. DEFAULT to treating the person at the device as the student unless you have clear evidence otherwise — do not call set_person_as_user for a non-student on weak grounds.)`;
    }
    return `[PEOPLE PRESENT]\n${lines.join("\n")}${presenceLine}${borderlineLine}`;
  }

  /** True when a fresh, positively-matched student face is on file. */
  private sawStudentFace(): boolean {
    if (!this.currentIdentifiedFaces.length) return false;
    if (Date.now() - this.currentIdentifiedFacesAt > AgentCoordinator.IDENTIFIED_FACES_TTL_MS) return false;
    return this.currentIdentifiedFaces.some(f => f.matched && f.entityType === "student");
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("[AgentCoordinator] ws.send failed:", err);
    }
  }

  // ── Processing indicators ──────────────────────────────────────────
  // Thin delegators onto the ProcessingIndicators state machine, kept as
  // named methods so the many call sites read clearly.

  /** Mirror a backend-busy transition to the client (deduped). */
  private emitProcessing(activity: ProcessingActivity, active: boolean): void {
    this.processing.set(activity, active);
  }

  /** Route a turn to the Speaker that expects a spoken (or explicitly
   *  silent) reply, marking the Speaker busy until it resolves. ALL
   *  reply-provoking sendUserTurn calls go through here so the ambient
   *  "thinking" cue brackets the whole turn. (Context injections and
   *  Observer turns don't provoke a Speaker reply and are left alone.) */
  private speakerRespond(text: string): void {
    if (!this.speaker) return;  // no Speaker (resting/torn-down) — don't light the cue for a dropped turn
    this.processing.markSpeakerBusy();
    this.speaker.sendUserTurn(text);
  }

  /** Speaker turn resolved (spoke, stayed silent, or leaked a thought). */
  private clearSpeakerBusy(): void {
    this.processing.clearSpeakerBusy();
  }

  /** A composed sentence (glyph_press) is being interpreted into speech. */
  private markInterpretBusy(): void {
    this.processing.markInterpretBusy();
  }

  /** Interpretation resolved — either it voiced, or the interpret call was
   *  rejected / never came (timeout). */
  private clearInterpretBusy(): void {
    this.processing.clearInterpretBusy();
  }

  /** Clear every processing indicator (session reset / teardown / fatal
   *  error) so nothing sticks across a reconnect. */
  private clearAllProcessing(): void {
    this.processing.clearAll();
  }

  private sendError(text: string): void {
    this.send({ type: "error", data: text });
  }
}

// ---------------------------------------------------------------------------
// WebSocket setup — parallel to setupLiveWebSocket. The wiring in Task #9
// decides which entry point the client connects to (per-student flag).
// ---------------------------------------------------------------------------

export function setupCoordinatorWebSocket(server: import("http").Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    if (url.pathname !== "/ws/live-v2") return;

    const user = await authenticateUpgrade(req);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket as any, head as any, (ws) => {
      console.log(`[AgentCoordinator] New WebSocket connection user=${user.id}`);
      new AgentCoordinator(ws as any, user);
    });
  });

  console.log("[AgentCoordinator] WebSocket server ready on /ws/live-v2");
}
