/**
 * aac-settings-memory-schema.ts
 *
 * Memory field definitions for AAC settings, exposed through the memory system
 * so the AI can read and modify them during regular chat sessions.
 *
 * The assistant treats the live AAC not as a separate entity but as itself in a
 * different mode (setup mode here vs. AAC mode during a live session). These two
 * prompt fields are how its setup-mode self prepares its AAC-mode self.
 *
 * Fields (the two prompt fields are LISTS of strings — one rule/note per entry —
 * so the assistant ADDS entries and removes one only when superseded, rather
 * than rewriting the whole field):
 * - Context_AACPrompt: Caretaker instructions — a list of specific behaviors a
 *     caretaker has explicitly requested. Rigid; entries added/removed only on
 *     caretaker request. (DB column: chatAgentPrompt, jsonb string[].)
 * - Context_AACAutoPrompt: The assistant's scratchpad — a self-maintained list
 *     of notes its AAC-mode self needs to know about the student. New notes are
 *     added as information is learned. (DB column: autoAacPrompt, jsonb string[].)
 * - Context_AACSettings: All other AAC settings (voice, display, input, symbols, etc.)
 *
 * Both prompt fields are written ONLY during clinician interactions. In AAC mode
 * the assistant only reads them — the live moderator/agents never receive these
 * writable fields, so they cannot modify either prompt at session time.
 *
 * Persistence: Writes go directly to the aacSettings table (not chatMemory).
 * Frontend sync: Changes are extracted as contextData "aacprompt" /
 * "aacautoprompt" / "aacsettings" and the frontend invalidates student queries
 * to reload the settings panel.
 */

import { db } from "../../db";
import { eq } from "drizzle-orm";
import { aacSettings } from "@shared/schema";
import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldObjectWithDB,
  type AgentMemoryFieldArrayWithDB,
  type DBOperationContext,
} from "../chat/memory-types";
import { studentService } from "../studentService";
import { activityLogService } from "../activityLogService";
import { summarizeChanges, changeDetails } from "../activityChanges";
import type { AccessCtx } from "../sharing/visibility";
import { normalizeAacPromptList } from "./aac-memory-schema";
import { COMPETENCY_LABEL } from "@shared/social-bot/state";
import { coerceSeizureConfig, type SeizureConfig } from "@shared/aac/seizure-config";

// ============================================================================
// DB HELPERS
// ============================================================================

/**
 * Defang a clinician/AI-supplied AAC prompt before it is persisted. Applies to
 * BOTH the custom (chatAgentPrompt) and auto (autoAacPrompt) prompt fields,
 * since both are concatenated into the live AAC system prompt. We defang two
 * families of tokens and cap the length:
 *   1. Bracketed protocol markers ([CONTEXT], [BUTTON PRESS], etc.) used by the
 *      live relay's turn injections and the monitor command stream.
 *   2. XML-style section tags (<persona>, <session_goals>, <student_safety>,
 *      etc.) used by buildInteractiveAgentPrompt to wrap the persona output. A
 *      string containing a literal </persona> would close the wrapper early and
 *      let anything after it land in the live system prompt as a sibling section.
 * The 8 KB cap keeps injection bandwidth small (well above any legitimate prompt).
 */
export function sanitizePromptField(input: string): string {
  let p = input;
  const BRACKETED_FRAMING_TOKENS = [
    "[CONTEXT]", "[/CONTEXT]",
    "[UPDATE_PROMPT]", "[/UPDATE_PROMPT]",
    "[BOARD]", "[/BOARD]",
    "[ENHANCED_PROMPT]", "[/ENHANCED_PROMPT]",
    "[CALL_MONITOR]", "[INTERPRET]", "[/INTERPRET]",
    "[TRANSCRIPT]", "[PEOPLE PRESENT]",
    "[BUTTON PRESS]", "[SENTENCE PRESS]",
    "[GLYPH PRESS]", "[SENTENCE COMPOSED]",
    "[CONSTRUCTION STATE]", "[SENTENCE BUILDER STATE]",
    "[SYSTEM]", "[/SYSTEM]",
  ];
  for (const tok of BRACKETED_FRAMING_TOKENS) {
    p = p.split(tok).join(tok.replace(/\[/g, "(").replace(/\]/g, ")"));
  }
  // XML-style section tags used by buildInteractiveAgentPrompt. Matches both
  // `<name>` and `</name>` (with optional attributes/whitespace) and defangs by
  // swapping the angle brackets for parens.
  const RESERVED_XML_TAGS = [
    "persona", "session_goals", "memory", "security", "student_safety",
    "student_specific_examples", "persona_gesture_override",
    "gesture_defaults", "role", "communication", "presence", "speakers",
    "addressed_to_you", "observations", "user_intent_hints",
    "transcription", "ambient_audio", "board", "zones",
    "speech_coordination", "grammar", "button_syntax", "bundled_icons",
    "voice_identity", "environment", "mode_selection_rules",
    "interact_mode", "assist_mode", "standby_mode", "mode_behavior_rules",
    "binary_choice", "sentence_builder", "examples", "example",
    "bad_examples", "bad_example",
  ];
  const xmlTagPattern = new RegExp(
    `</?(?:${RESERVED_XML_TAGS.join("|")})\\b[^>]*>`,
    "gi",
  );
  p = p.replace(xmlTagPattern, (m) =>
    m.replace(/[<>]/g, (c) => (c === "<" ? "(" : ")")),
  );
  // Hard cap to keep injection bandwidth small; 8 KB is well above any
  // legitimate prompt.
  if (p.length > 8000) p = p.slice(0, 8000);
  return p;
}

/**
 * Sanitize a list of AAC prompt rules (the array form of the two prompt
 * fields). Coerces string | string[] to an array, defangs each entry via
 * sanitizePromptField, trims, and drops blanks. Caps the list to 50 entries
 * so a runaway writer can't bloat the live system prompt.
 */
export function sanitizePromptList(input: string | string[] | null | undefined): string[] {
  return normalizeAacPromptList(input)
    .map((rule) => sanitizePromptField(rule).trim())
    .filter((rule) => rule.length > 0)
    .slice(0, 50);
}

async function readAACSettings(ctx: DBOperationContext): Promise<Record<string, any> | null> {
  const studentId = ctx.all.studentId;
  if (!studentId) return null;

  const [settings] = await db
    .select()
    .from(aacSettings)
    .where(eq(aacSettings.studentId, studentId));

  return settings ? (settings as Record<string, any>) : null;
}

async function writeAACSettings(ctx: DBOperationContext, updates: Record<string, any>): Promise<any> {
  const studentId = ctx.all.studentId;
  if (!studentId) return updates;

  // Authorize the writer. Without this gate, an authenticated user with no
  // relationship to the student could rewrite Context_AACPrompt or any
  // chatAgentPrompt for any student UUID — a persistent prompt-injection
  // landing in that student's AAC live model. The check mirrors the
  // controller-level boundary; we re-verify here as defense-in-depth so the
  // schema is safe even if some future caller reaches it without an
  // upstream gate (e.g. a script, a fork, or a not-yet-wired feature).
  const accessCtx = ctx.all.accessCtx as AccessCtx | undefined;
  const userId = ctx.all.userId as string | undefined;
  if (accessCtx?.kind === "admin") {
    // Admin principal — allowed.
  } else if (accessCtx?.kind === "student" && accessCtx.studentId === studentId) {
    // The AAC student themselves modifying their own settings — allowed.
  } else if (accessCtx?.kind === "institute" && userId) {
    // Clinician principal — verify they actually have access to this student.
    const access = await studentService.verifyStudentAccess(studentId, userId, accessCtx.instituteId);
    if (!access.hasAccess) {
      throw new Error("Cannot write AAC settings: no access to student");
    }
  } else {
    throw new Error("Cannot write AAC settings without a resolved access context");
  }

  // Filter to only known columns — prevent writing id/studentId/timestamps
  const WRITABLE_COLUMNS = new Set([
    "aiName", "startupMode",
    "voiceType", "studentVoiceType", "geminiAiVoice", "geminiStudentVoice",
    "aiVoicePitch", "studentVoicePitch", "useLocalTts",
    "elevenlabsEnabled", "elevenlabsAiVoiceId", "elevenlabsStudentVoiceId",
    "iconTextRatio", "languageLevel", "usePcsSymbols", "singleGlyphButtons",
    "generateSymbols", "useApprovedSymbols", "useUnapprovedSymbols", "dynamicBoardsEnabled",
    "eyegazeEnabled", "eyegazeTimeout", "eyegazeProvider", "selectionMethod", "restSpace",
    "pressResponseDelay", "interruptOnNewPress",
    "signLanguage", "multiCameraMode",
    "allowReadProgress", "allowReadReports", "allowNotes", "autoAddContacts",
    "appConfig", "chatAgentPrompt", "autoAacPrompt", "seizureDetection",
  ]);

  const filtered: Record<string, any> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (WRITABLE_COLUMNS.has(k)) filtered[k] = v;
  }

  // Sanitize both prompt fields on write. Each is now a LIST of rule strings
  // (jsonb array). Both are fed into the thorough-startup enhancer (each rule
  // wrapped in a per-session nonced <<UNTRUSTED-...>> marker) and — when the
  // enhancer fails or fast-startup is selected — concatenated raw into the live
  // <persona> block. Without this gate either field is a clinician-controllable
  // prompt-injection slot. Legacy single-string writes are coerced to a
  // 1-element list. See sanitizePromptList / sanitizePromptField.
  if (filtered.chatAgentPrompt !== undefined) {
    filtered.chatAgentPrompt = sanitizePromptList(filtered.chatAgentPrompt);
  }
  if (filtered.autoAacPrompt !== undefined) {
    filtered.autoAacPrompt = sanitizePromptList(filtered.autoAacPrompt);
  }

  // seizureDetection is a JSON column holding clinician CONFIG + a machine-written
  // BASELINE. The AI only ever edits config; merge so the write preserves the
  // baseline (and coerce the config so a bad sensitivity value can't land).
  if (filtered.seizureDetection !== undefined) {
    const [row] = await db
      .select({ sd: aacSettings.seizureDetection })
      .from(aacSettings)
      .where(eq(aacSettings.studentId, studentId));
    const existing = (row?.sd as any) ?? {};
    const incoming = filtered.seizureDetection as any;
    filtered.seizureDetection = { ...existing, config: coerceSeizureConfig(incoming?.config ?? incoming) };
  }

  if (Object.keys(filtered).length === 0) return updates;

  // Snapshot before the write so the audit row can name the fields. This path
  // is the AI's only door into aac_settings — including `aiName`, which lands
  // verbatim in the live system prompts — and until now it wrote silently, so
  // an AI-set value was indistinguishable from a clinician-set one after the
  // fact. Read from the same place the write goes, so the diff matches what
  // actually happened.
  const before = await readAACSettings(ctx);

  filtered.updatedAt = new Date();

  await db
    .update(aacSettings)
    .set(filtered)
    .where(eq(aacSettings.studentId, studentId));

  const details = changeDetails(
    summarizeChanges("aac_settings", before, filtered),
    { via: "aac_settings" },
  );
  if (details) {
    activityLogService.log({
      instituteId: (ctx.all.instituteId as string | undefined) ?? null,
      userId: userId ?? null,
      eventType: "update",
      subjectType1: "student",
      subjectId1: studentId,
      isAiInitiated: true,
      details,
    });
  }

  console.log(`[aac-settings-memory] Wrote ${Object.keys(filtered).length} fields for student ${studentId}`);
  return updates;
}

// ============================================================================
// SOCIAL TRAINER CONFIG  (nested under Context_AACSettings → socialTrainer)
// ----------------------------------------------------------------------------
// The Social Trainer's per-student goals live in aacSettings.appConfig under the
// `social_trainer` key (read by AgentCoordinator.startSocialPeerSession). We
// surface them as a clean, structured sub-object rather than leaving them buried
// in the opaque appConfig JSON, so the assistant can read/edit them by name.
// Reads/writes go through the helpers below so a write MERGES into appConfig
// (never clobbering sibling app config like youtube/spotify) and skill keys are
// validated against the canonical competency list.
// ============================================================================

/** Canonical competency keys (the trainable social skills) + a human list for
 *  the field description. Sourced from the shared label map so it stays in sync
 *  as competencies are added. */
const SOCIAL_SKILL_KEYS = Object.keys(COMPETENCY_LABEL);
const SOCIAL_SKILL_SET = new Set(SOCIAL_SKILL_KEYS);
const SOCIAL_SKILL_LIST = Object.entries(COMPETENCY_LABEL)
  .map(([k, label]) => `${k} (${label})`)
  .join(", ");

export interface SocialTrainerConfig {
  targetSkills: string[];
  lockedSkills: string[];
  maxChallengeIntensity?: number;
}

/** Read the structured config out of a settings row's appConfig. Always returns
 *  a complete shape (empty arrays = "all skills" / no locks). */
export function readSocialTrainerConfig(settings: Record<string, any> | null): SocialTrainerConfig {
  const st = (settings?.appConfig && typeof settings.appConfig === "object"
    ? (settings.appConfig as any).social_trainer
    : undefined) ?? {};
  const out: SocialTrainerConfig = {
    targetSkills: Array.isArray(st.targetSkills) ? st.targetSkills.filter((s: unknown): s is string => typeof s === "string") : [],
    lockedSkills: Array.isArray(st.lockedSkills) ? st.lockedSkills.filter((s: unknown): s is string => typeof s === "string") : [],
  };
  if (typeof st.maxChallengeIntensity === "number" && Number.isFinite(st.maxChallengeIntensity)) {
    out.maxChallengeIntensity = st.maxChallengeIntensity;
  }
  return out;
}

/** Validate/clamp an incoming (possibly partial) social-trainer patch: drop
 *  unknown skill keys, clamp the ceiling to [0,1]. Pure — unit-tested. */
export function sanitizeSocialTrainerConfig(incoming: any): Partial<SocialTrainerConfig> {
  const out: Partial<SocialTrainerConfig> = {};
  if (incoming && typeof incoming === "object") {
    if (Array.isArray(incoming.targetSkills)) {
      out.targetSkills = incoming.targetSkills.filter((s: unknown): s is string => typeof s === "string" && SOCIAL_SKILL_SET.has(s));
    }
    if (Array.isArray(incoming.lockedSkills)) {
      out.lockedSkills = incoming.lockedSkills.filter((s: unknown): s is string => typeof s === "string" && SOCIAL_SKILL_SET.has(s));
    }
    if (incoming.maxChallengeIntensity != null) {
      const n = Number(incoming.maxChallengeIntensity);
      if (Number.isFinite(n)) out.maxChallengeIntensity = Math.max(0, Math.min(1, n));
    }
  }
  return out;
}

/** Merge a patch into appConfig.social_trainer, preserving sibling app config.
 *  Re-reads the row so concurrent youtube/spotify settings aren't clobbered. */
async function writeSocialTrainerConfig(ctx: DBOperationContext, incoming: any): Promise<SocialTrainerConfig> {
  const settings = await readAACSettings(ctx);
  const appConfig: Record<string, any> =
    settings?.appConfig && typeof settings.appConfig === "object" ? { ...settings.appConfig } : {};
  const current = appConfig.social_trainer && typeof appConfig.social_trainer === "object" ? appConfig.social_trainer : {};
  appConfig.social_trainer = { ...current, ...sanitizeSocialTrainerConfig(incoming) };
  await writeAACSettings(ctx, { appConfig });
  return readSocialTrainerConfig({ appConfig });
}

/** The clinician-editable seizure-detection config (NOT the machine baseline),
 *  coerced to a complete shape for display/edit by the assistant. */
export function readSeizureConfig(settings: Record<string, any> | null): SeizureConfig {
  return coerceSeizureConfig((settings?.seizureDetection as any)?.config);
}

// ============================================================================
// FIELD DEFINITIONS
// ============================================================================

/**
 * Context_AACPrompt — Caretaker instructions (DB: chatAgentPrompt). A LIST of
 * behaviors a caretaker has explicitly requested for AAC sessions, one rule per
 * entry. Rigid: ADD a new rule when a caretaker asks; DELETE one only when a
 * newer rule contradicts it or it is no longer relevant. Never replace the
 * whole list.
 */
export const AAC_PROMPT_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Context_AACPrompt",
  type: "array",
  title: "AAC Caretaker Instructions",
  description:
    "A LIST of behaviors a caretaker has explicitly asked you to follow in AAC mode, ONE rule per entry " +
    "(e.g. \"greet her by name\", \"keep sentences short\", \"don't offer food choices\"). " +
    "Rigid and human-owned. To record a new request, `add` it as a new entry — do NOT rewrite the whole list. " +
    "`delete` an entry (by its index or exact text) only when a newer request contradicts it or it is no longer relevant. " +
    "Each rule should always be in English, even if the user's primary language is not English.",
  opened: true,
  items: {
    id: "Rule",
    type: "string",
    title: "Caretaker Request",
    description: "One caretaker-requested behavior",
  },
  db: {
    read: async (ctx) => {
      const settings = await readAACSettings(ctx);
      return normalizeAacPromptList(settings?.chatAgentPrompt);
    },
    write: async (ctx, value) => {
      await writeAACSettings(ctx, { chatAgentPrompt: sanitizePromptList(value as any) });
      return sanitizePromptList(value as any);
    },
    add: async (ctx, value) => {
      const current = normalizeAacPromptList((await readAACSettings(ctx))?.chatAgentPrompt);
      const rule = sanitizePromptField(String(value ?? "")).trim();
      if (rule) current.push(rule);
      await writeAACSettings(ctx, { chatAgentPrompt: current });
      return rule;
    },
    delete: async (ctx, keyOrIndex) => {
      const current = normalizeAacPromptList((await readAACSettings(ctx))?.chatAgentPrompt);
      const next = typeof keyOrIndex === "number"
        ? current.filter((_, i) => i !== keyOrIndex)
        : current.filter((r) => r !== String(keyOrIndex));
      await writeAACSettings(ctx, { chatAgentPrompt: next });
    },
    clear: async (ctx) => {
      await writeAACSettings(ctx, { chatAgentPrompt: [] });
    },
  },
};

/**
 * Context_AACAutoPrompt — Your scratchpad (DB: autoAacPrompt). A LIST of notes,
 * one per entry, on what your AAC-mode self needs to know about this student,
 * because in AAC mode you can't read their reports mid-session. ADD a note as
 * you learn something new; DELETE a note only when a newer one supersedes it or
 * it is no longer true. Never replace the whole list.
 */
export const AAC_AUTO_PROMPT_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Context_AACAutoPrompt",
  type: "array",
  title: "AAC Scratchpad (your notes on the student)",
  description:
    "A LIST of non-sensitive, functional notes (ONE per entry) your AAC-mode self needs to communicate with and support this student — " +
    "communication level, interests, triggers, physical and cognitive abilities, people around them, current goals. Keep each note functional: " +
    "capture what you'd watch for and DO, never clinical labels. Translate medical facts into behavior — e.g. \"may have seizures; if she " +
    "suddenly goes blank, stay calm and alert a caretaker\" rather than naming a diagnosis; leave bare diagnoses, history, medications, and " +
    "test scores in the student's gated records. `add` a new note as you learn something — do NOT rewrite the whole list; `delete` a note " +
    "(by index or exact text) only when a newer one supersedes it or it is no longer true. Update freely — do not ask the user first, just do it. " +
    "Each note should always be in English, even if the user's primary language is not English.",
  opened: true,
  items: {
    id: "Note",
    type: "string",
    title: "Student Note",
    description: "One functional note about the student",
  },
  db: {
    read: async (ctx) => {
      const settings = await readAACSettings(ctx);
      return normalizeAacPromptList(settings?.autoAacPrompt);
    },
    write: async (ctx, value) => {
      await writeAACSettings(ctx, { autoAacPrompt: sanitizePromptList(value as any) });
      return sanitizePromptList(value as any);
    },
    add: async (ctx, value) => {
      const current = normalizeAacPromptList((await readAACSettings(ctx))?.autoAacPrompt);
      const note = sanitizePromptField(String(value ?? "")).trim();
      if (note) current.push(note);
      await writeAACSettings(ctx, { autoAacPrompt: current });
      return note;
    },
    delete: async (ctx, keyOrIndex) => {
      const current = normalizeAacPromptList((await readAACSettings(ctx))?.autoAacPrompt);
      const next = typeof keyOrIndex === "number"
        ? current.filter((_, i) => i !== keyOrIndex)
        : current.filter((r) => r !== String(keyOrIndex));
      await writeAACSettings(ctx, { autoAacPrompt: next });
    },
    clear: async (ctx) => {
      await writeAACSettings(ctx, { autoAacPrompt: [] });
    },
  },
};

/**
 * Context_AACSettings — All other AAC settings grouped by category.
 */
export const AAC_SETTINGS_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Context_AACSettings",
  type: "object",
  title: "AAC Settings",
  description: "Configuration for the AAC system — voice, display, input, symbols, privacy, and apps",
  opened: false,
  properties: {
    // Identity
    aiName: {
      id: "aiName",
      type: "string",
      title: "AI Name",
      description: "Custom name for the AI companion (e.g. 'Buddy', 'Sam')",
    },
    // Voice
    voiceType: {
      id: "voiceType",
      type: "string",
      title: "AI Voice Type",
      description: "Fallback AI voice: 'auto', 'man', 'woman', 'boy', 'girl'",
    },
    studentVoiceType: {
      id: "studentVoiceType",
      type: "string",
      title: "Student Voice Type",
      description: "Student TTS voice: 'man', 'woman', 'boy', 'girl'",
    },
    geminiAiVoice: {
      id: "geminiAiVoice",
      type: "string",
      title: "Gemini AI Voice",
      description: "Gemini prebuilt voice for AI (e.g. 'Zephyr', 'Kore', 'Puck')",
    },
    geminiStudentVoice: {
      id: "geminiStudentVoice",
      type: "string",
      title: "Gemini Student Voice",
      description: "Gemini prebuilt voice for student (e.g. 'Puck', 'Leda')",
    },
    aiVoicePitch: {
      id: "aiVoicePitch",
      type: "string",
      title: "AI Voice Pitch",
      description: "Pitch shift in semitones (-6 to +6, 0 = no change)",
    },
    studentVoicePitch: {
      id: "studentVoicePitch",
      type: "string",
      title: "Student Voice Pitch",
      description: "Pitch shift in semitones (-6 to +6, 0 = no change)",
    },
    useLocalTts: {
      id: "useLocalTts",
      type: "string",
      title: "Use Local TTS",
      description: "Use browser speech synthesis instead of server TTS (true/false)",
    },
    // ElevenLabs
    elevenlabsEnabled: {
      id: "elevenlabsEnabled",
      type: "string",
      title: "ElevenLabs Enabled",
      description: "Toggle ElevenLabs voice on/off (true/false)",
    },
    elevenlabsAiVoiceId: {
      id: "elevenlabsAiVoiceId",
      type: "string",
      title: "ElevenLabs AI Voice ID",
      description: "ElevenLabs voice ID for AI voice",
    },
    elevenlabsStudentVoiceId: {
      id: "elevenlabsStudentVoiceId",
      type: "string",
      title: "ElevenLabs Student Voice ID",
      description: "ElevenLabs voice ID for student voice",
    },
    // Display
    iconTextRatio: {
      id: "iconTextRatio",
      type: "string",
      title: "Icon/Text Ratio",
      description: "Icon-to-text size ratio on buttons (1-5, 1=mostly icon, 5=mostly text)",
    },
    languageLevel: {
      id: "languageLevel",
      type: "string",
      title: "Language Level",
      description:
        "How long/complex the AI's sentences are, matched to the student's receptive language (1-5): " +
        "1=single words, 2=short phrases, 3=simple sentences, 4=full sentences, 5=complex. " +
        "Applies to the companion AI and the social-trainer peer. Default 4.",
    },
    // Symbols
    usePcsSymbols: {
      id: "usePcsSymbols",
      type: "string",
      title: "Use PCS Symbols",
      description: "Prefer PCS symbols over emojis (true/false)",
    },
    singleGlyphButtons: {
      id: "singleGlyphButtons",
      type: "string",
      title: "Single-Glyph Buttons",
      description: "Constrain AI-generated buttons to a single GLYPH each (modifiers still allowed). Sentence builder and interpret() path are unaffected. (true/false)",
    },
    generateSymbols: {
      id: "generateSymbols",
      type: "string",
      title: "Generate Symbols",
      description: "Auto-generate symbol images via Gemini (true/false)",
    },
    useApprovedSymbols: {
      id: "useApprovedSymbols",
      type: "string",
      title: "Use Approved Symbols",
      description: "Show clinician-approved generated symbols on buttons (true/false)",
    },
    useUnapprovedSymbols: {
      id: "useUnapprovedSymbols",
      type: "string",
      title: "Use Unapproved Symbols",
      description: "Also show newly generated (unapproved) symbols (true/false)",
    },
    dynamicBoardsEnabled: {
      id: "dynamicBoardsEnabled",
      type: "string",
      title: "Dynamic Boards",
      description: "AI can generate/edit boards during sessions (true/false)",
    },
    // Input
    eyegazeEnabled: {
      id: "eyegazeEnabled",
      type: "string",
      title: "Eyegaze Enabled",
      description: "Enable dwell-based symbol selection (true/false)",
    },
    eyegazeTimeout: {
      id: "eyegazeTimeout",
      type: "string",
      title: "Eyegaze Timeout",
      description: "Dwell time in milliseconds (1000-10000)",
    },
    eyegazeProvider: {
      id: "eyegazeProvider",
      type: "string",
      title: "Eyegaze Provider",
      description: "'auto', 'camera', 'tobii', 'eyetech', 'lctech', 'webhid', 'mouse'",
    },
    selectionMethod: {
      id: "selectionMethod",
      type: "string",
      title: "Selection Method",
      description:
        "How a gaze selects a button: 'whole_button'; 'selection_area' (a small eye mark in the button's corner, so labels can be read without selecting); or 'intent' (decodes reading vs. choosing from how steadily the gaze rests, and where on the button)",
    },
    restSpace: {
      id: "restSpace",
      type: "string",
      title: "Rest Areas",
      description:
        "How much space is cut from board buttons' corners so the gap where four meet forms a circle the student can rest their gaze in without selecting: 'large', 'small', or 'none'",
    },
    pressResponseDelay: {
      id: "pressResponseDelay",
      type: "string",
      title: "Response Delay",
      description:
        "How long (in MILLISECONDS) to wait after a button press before the AI answers, so the student can chain buttons into one thought. 0 = answer immediately (default). A value between 250 and 15000 holds the turn: the press is still voiced at once, and further presses inside the window join it, so the AI replies once to the whole thought.",
    },
    interruptOnNewPress: {
      id: "interruptOnNewPress",
      type: "string",
      title: "New Press Interrupts",
      description:
        "When true, pressing a DIFFERENT button while the AI is answering (or while its new board is still being built) abandons that response — the reply is cut, the board build is cancelled, and the new press is voiced immediately. Pressing the SAME button again is never treated this way. Default false (true/false).",
    },
    signLanguage: {
      id: "signLanguage",
      type: "string",
      title: "Sign Language",
      description: "Sign language code to recognize ('asl', 'isr'); empty/null disables detection",
    },
    multiCameraMode: {
      id: "multiCameraMode",
      type: "string",
      title: "Multi-Camera Mode",
      description: "Enable multi-camera support (true/false)",
    },
    // Startup
    startupMode: {
      id: "startupMode",
      type: "string",
      title: "Startup Mode",
      description: "Session startup mode: 0 = quick (default; reuses cached session-plan sections when the student's data/schedule haven't changed — fastest startup), 1 = thorough (regenerates the full session plan fresh every session).",
    },
    // Privacy
    allowReadProgress: {
      id: "allowReadProgress",
      type: "string",
      title: "Allow Read Progress",
      description: "AI can access IEP/program goals (true/false)",
    },
    allowReadReports: {
      id: "allowReadReports",
      type: "string",
      title: "Allow Read Reports",
      description: "AI can access medical/educational/functional reports (true/false)",
    },
    allowNotes: {
      id: "allowNotes",
      type: "string",
      title: "Allow Notes",
      description: "AI can access and write student notes (true/false)",
    },
    // AI learning
    autoAddContacts: {
      id: "autoAddContacts",
      type: "string",
      title: "Learn New Contacts",
      description:
        "During AAC sessions the AI may create Student_Contacts entries for people it observes (true/false). " +
        "When false it can still read and update existing contacts, but new people must be added from the " +
        "Contacts panel. Contacts the AI does create are flagged for a caretaker to confirm.",
    },
    // Apps
    appConfig: {
      id: "appConfig",
      type: "string",
      title: "App Configuration",
      description: "Per-app settings as JSON (e.g. { youtube: { enabled: true } }). NOTE: the Social Trainer's goals are surfaced separately under `socialTrainer` below — edit them there, not here.",
    },
    // Social Trainer — structured, so it's editable by name instead of buried in
    // the appConfig JSON. Its own db ops persist into appConfig.social_trainer
    // (merge-safe). Three branches only: focus / off-limits / ceiling.
    socialTrainer: {
      id: "socialTrainer",
      type: "object",
      title: "Social Trainer",
      description:
        "Goals and challenge level for the Social Trainer practice peer. The AI may narrow the focus per session within these bounds; locked skills and the ceiling are always honored.",
      properties: {
        targetSkills: {
          id: "targetSkills",
          type: "array",
          title: "Focus skills",
          description:
            "Social skills to work on (the default session goals). Empty means all skills are in scope. Allowed values: " +
            SOCIAL_SKILL_LIST + ".",
          items: { id: "skill", type: "string", enum: SOCIAL_SKILL_KEYS },
        },
        lockedSkills: {
          id: "lockedSkills",
          type: "array",
          title: "Off-limits skills",
          description:
            "Skills the peer must NEVER deliberately challenge (a hard floor the in-session AI cannot override). Same allowed values as Focus skills.",
          items: { id: "skill", type: "string", enum: SOCIAL_SKILL_KEYS },
        },
        maxChallengeIntensity: {
          id: "maxChallengeIntensity",
          type: "number",
          title: "Challenge ceiling",
          description: "Cap (0–1) on how demanding challenges may get. Default 0.4. Lower is gentler.",
          minimum: 0,
          maximum: 1,
        },
      },
      db: {
        read: async (ctx) => readSocialTrainerConfig(await readAACSettings(ctx)),
        write: async (ctx, value) => writeSocialTrainerConfig(ctx, value),
      },
    },
    // Seizure detection — TECHNICAL config for the on-device motion detectors
    // (when they flag a possible seizure to the live AI). NOT clinical policy:
    // what the student's seizures look like and how to respond belongs in
    // Context_AACPrompt, not here. The learned baseline lives in the same column
    // and is machine-managed — never exposed or edited here.
    seizureDetection: {
      id: "seizureDetection",
      type: "object",
      title: "Seizure Detection",
      description:
        "Per-student tuning for the device's motion-based seizure detectors. These control WHEN the system flags a possible seizure to the AI; tune them so the student's usual movements (rocking, hand stereotypies, deliberate slumping) don't cause false warnings. Off by default — enable only for a student who needs it. Clinical guidance (their seizure signs, what to do) goes in Context_AACPrompt instead.",
      properties: {
        enabled: {
          id: "enabled",
          type: "string",
          title: "Enabled",
          description: "Master switch for seizure detection (true/false). When false, no detectors run.",
        },
        rhythmic: {
          id: "rhythmic",
          type: "string",
          title: "Convulsive (rhythmic) sensitivity",
          description:
            "Sensitivity of the rhythmic / tonic-clonic (whole-body shaking) detector: off, low, medium, or high. " +
            "Lower it (or off) for a student whose rocking or hand movements would trip it; higher catches subtler events but warns more often.",
          enum: ["off", "low", "medium", "high"],
        },
        atonic: {
          id: "atonic",
          type: "string",
          title: "Drop / loss-of-tone sensitivity",
          description:
            "Sensitivity of the atonic (sudden slump/collapse) detector: off, low, medium, or high. " +
            "Lower it for a student who often leans or slumps on purpose.",
          enum: ["off", "low", "medium", "high"],
        },
        audioCorroboration: {
          id: "audioCorroboration",
          type: "string",
          title: "Audio corroboration",
          description: "Let a concurrent vocalization/sound raise concern for a motion the detector already flagged (true/false). Never alarms on its own.",
        },
      },
    },
  },
  db: {
    read: async (ctx) => {
      const settings = await readAACSettings(ctx);
      if (!settings) return null;
      // Extract only the fields we expose (exclude id, studentId, timestamps, sensitive keys)
      const {
        id: _id, studentId: _sid, createdAt: _ca, updatedAt: _ua,
        chatAgentPrompt: _prompt, // handled by Context_AACPrompt
        autoAacPrompt: _autoPrompt, // handled by Context_AACAutoPrompt
        enabled: _en, demoMode: _dm, demoScenario: _ds, modelOverride: _mo,
        elevenlabsApiKey: _eak, // sensitive — not exposed
        customVoiceId: _cv, customStudentVoiceId: _csv, // FK refs
        localStorageEnabled: _lse, remoteStorageEnabled: _rse, localStorageEncryptionKey: _lsek,
        knownPeople: _kp, // managed by biometric system
        ...exposed
      } = settings;
      // Surface the Social Trainer config as a clean structured branch, and
      // strip its raw copy out of the exposed appConfig so there's a single
      // source of truth (the assistant edits it via `socialTrainer`, not the
      // appConfig blob). Other app config (youtube/spotify/…) stays visible.
      if (exposed.appConfig && typeof exposed.appConfig === "object") {
        const { social_trainer: _stRaw, ...restAppConfig } = exposed.appConfig as Record<string, any>;
        exposed.appConfig = restAppConfig;
      }
      exposed.socialTrainer = readSocialTrainerConfig(settings);
      // Replace the raw seizureDetection column ({config, baseline}) with just the
      // clinician-editable config — the machine baseline is never shown/edited.
      exposed.seizureDetection = readSeizureConfig(settings);
      return exposed;
    },
    write: async (ctx, value) => {
      if (value && typeof value === 'object') {
        // Persist the column-backed fields first (incl. any appConfig the AI
        // sent — which won't contain social_trainer, since read strips it)…
        await writeAACSettings(ctx, value);
        // …then merge the structured socialTrainer back into appConfig so it
        // survives and sibling app config isn't clobbered. (The normal edit
        // path goes through socialTrainer's own db.write; this covers a
        // whole-object set of Context_AACSettings.)
        if ((value as any).socialTrainer && typeof (value as any).socialTrainer === "object") {
          await writeSocialTrainerConfig(ctx, (value as any).socialTrainer);
        }
      }
      return value;
    },
  },
};

// ============================================================================
// EXPORTS
// ============================================================================

/**
 * Guidance injected into the CLINICIAN assistant's system prompt whenever a
 * student is in scope, so the assistant understands that it ALSO serves as this
 * student's AAC — the same assistant in a different mode — and how to prepare
 * for those sessions via the two AAC prompt fields.
 *
 * Key framing this establishes:
 *  - The AAC is not a separate entity; it is the same assistant running in AAC
 *    mode during live sessions. Caretakers talk about it that way ("when you're
 *    with the student, do X"), so the assistant should reason that way too.
 *  - In its current (setup) mode the assistant has no camera or microphone, so
 *    it used to reply "I can't see anything" when a caretaker said "when you see
 *    the student do X". But in AAC mode it DOES have audio + video — so it
 *    should capture the request as a note-to-self, not disclaim it.
 *  - The auto prompt is the assistant's own scratchpad: it consolidates
 *    everything its AAC-mode self will need to know about the student, since in
 *    AAC mode it can't stop to read the student's full reports.
 *  - The notes its AAC-mode self takes during sessions land in the student's
 *    Student_ fields (+ session summaries under Context_StudentSessions), so it
 *    should read those when asked how interactions have been going rather than
 *    disclaiming knowledge.
 *  - The assistant should know which of the two fields to edit, and when.
 */
export function buildAacClinicianGuidance(): string {
  return `

## Reading and Managing AAC Memory Fields

This student uses an AAC (augmentative communication) device/app, and YOU run it. Don't think of the AAC as a separate assistant — it's you, in a different mode. Right now you're in clinician mode: chatting with a caretaker and getting ready. When a session starts you switch to AAC mode and sit with the student directly. Same you, different mode — and that is the language caretakers will use ("when you're with the student…", "have the AAC do X").

From here, in clinician mode, you interact through text alone. But in AAC mode you can:
- SEE the student and their surroundings through the device camera.
- HEAR the student and the room through the microphone.
- SPEAK out loud to the student.
- Show the student a board of communication buttons, and build/adjust it on the fly.
- Raise a caretaker ALERT (a soft sound for situational issues) or an EMERGENCY ALARM (a loud, building tone) when something looks seriously wrong.

So requests like "when you notice the student getting upset…", "when she points at the window…", or "if he starts to cry, …" are things your AAC-mode self will genuinely be able to act on. NEVER reply that you can't see or hear the student — instead, set the instruction up now so your AAC-mode self knows to do it.

You prepare for AAC sessions through two notes-to-self, and EACH IS A LIST — one rule or note per entry. You can only edit them here in setup mode — in AAC mode you read them but can't change them. Crucially: these are running lists, NOT single blocks of text. To record something new, "add" it as a NEW entry; never rewrite or replace the whole list. Only "delete" an entry when a newer one contradicts it or it is no longer relevant — otherwise old rules and notes stay put.
- **Context_AACPrompt — user instructions (a list).** Each entry is one behavior a user has explicitly asked for (e.g. "greet her by name", "keep sentences short", "don't offer food choices", "if he starts crying, play calming music"). When a user tells you to do something "while you're with the student", "during AAC sessions", or "have the AAC do X", "add" it as a new entry in THIS list. If a new request contradicts an existing entry, delete the old one and add the new. These instructions take priority over your scratchpad.
- **Context_AACAutoPrompt — your scratchpad (a list).** Each entry is one non-sensitive, functional note on the student: things you'll want at hand when you're with them in AAC mode — communication level, interests, relevant physical or cognitive capabilities, behavioral facts, triggers, who's around them, current goals. In AAC mode you can't stop to read through their reports, so keep the important things here. Whenever you learn something new about the student, "add" it as a new note; delete a note only when it's superseded or no longer true.

Context_AACPrompt and Context_AACAutoPrompt should be written in English, even if the user's primary language is not English, because LLMs are more reliable at understanding instructions and notes in English.

Precedence: user instructions win over your scratchpad. If a new instruction contradicts a note in your scratchpad, update the scratchpad so the two don't fight. (Safety protocols always win over both.)

While you're in AAC mode, all visible fields are read-only except the Student_ fields (Student_Notes, plus Student_Interests, Student_CommunicationStyle, Student_Preferences, Student_People).
The observations and notes you take about the student accumulate in their Student_ fields and each session leaves a summary under Context_StudentSessions. So when a user asks how things have been going or how you've been getting along with the student, read those — that record is your own AAC-mode self's notes.
You may also update Student_ fields while in clinician mode, when appropriate.

Sensitive vs. functional — the line is not the TOPIC but the FORM. Context_AACPrompt, Context_AACAutoPrompt, and the Student_ fields are fed into the live AAC system prompt and may be spoken aloud or seen by the student or people nearby, so never write clinical labels, diagnoses, report or assessment contents, medical history, medications, or test scores into them. But DO capture the functional implication of such facts — phrased as what to watch for and what to do. Translate, don't name:
- "has epilepsy" → "may have seizures; if she suddenly stiffens or stares blankly and stops responding, stay calm, keep her safe, and alert a caretaker."
- "autism, level 2" → "prefers a predictable routine; warn her before transitions and keep choices simple."
- "quadriplegic cerebral palsy" → "limited hand control, uses eye gaze — allow extra time and don't expect pointing."
The test: if you can't express a fact as something you'd observe and act on during a conversation, it doesn't belong here — it stays in the student's gated records.

Do not ask the user for permission to update Context_AACAutoPrompt — just do it. The next time you switch to AAC mode, your updated notes will be there.
Do not ask the user to update Context_AACPrompt either, but DO be deliberate about when you update it — only when a user explicitly instructs you to change how you behave during sessions.
`;
}

/**
 * Memory fields for AAC settings.
 *
 * @param options.includePrompts When true (default), includes the writable
 *   custom + auto prompt fields. Pass false on the student-facing AAC chat
 *   path so the AAC moderator cannot modify either prompt — AAC prompts are
 *   only ever edited during clinician interactions.
 */
export function getAACSettingsMemoryFields(
  options?: { includePrompts?: boolean },
): AgentMemoryFieldWithDB[] {
  const includePrompts = options?.includePrompts ?? true;
  if (!includePrompts) {
    return [AAC_SETTINGS_FIELD];
  }
  return [AAC_PROMPT_FIELD, AAC_AUTO_PROMPT_FIELD, AAC_SETTINGS_FIELD];
}
