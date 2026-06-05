/**
 * aac-settings-memory-schema.ts
 *
 * Memory field definitions for AAC settings, exposed through the memory system
 * so the AI can read and modify them during regular chat sessions.
 *
 * Fields:
 * - Context_AACPrompt: The CUSTOM AAC prompt — specific behaviors caretakers
 *     have explicitly requested. Rigid; changed only on caretaker request.
 *     (DB column: chatAgentPrompt.)
 * - Context_AACAutoPrompt: The AUTO AAC prompt — an AI-maintained digest of
 *     "what the AAC needs to know about this student". Updated whenever new
 *     information about the student is learned. (DB column: autoAacPrompt.)
 * - Context_AACSettings: All other AAC settings (voice, display, input, symbols, etc.)
 *
 * Both prompt fields are written ONLY during clinician interactions. The live
 * AAC moderator/agents never receive these writable fields, so they cannot
 * modify either prompt — they only consume the result at session startup.
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
import type { AccessCtx } from "../sharing/visibility";

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
    "iconTextRatio", "usePcsSymbols", "singleGlyphButtons",
    "generateSymbols", "useApprovedSymbols", "useUnapprovedSymbols", "dynamicBoardsEnabled",
    "eyegazeEnabled", "eyegazeTimeout", "eyegazeProvider",
    "signLanguage", "multiCameraMode",
    "allowReadProgress", "allowReadReports", "allowNotes",
    "appConfig", "chatAgentPrompt", "autoAacPrompt",
  ]);

  const filtered: Record<string, any> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (WRITABLE_COLUMNS.has(k)) filtered[k] = v;
  }

  // Sanitize both prompt fields on write. Both are fed into the thorough-startup
  // enhancer (each wrapped in a per-session nonced <<UNTRUSTED-...>> marker) and
  // — when the enhancer fails or fast-startup is selected — concatenated raw
  // into the live <persona> block. Without this gate either field is a
  // clinician-controllable prompt-injection slot. See sanitizePromptField.
  if (typeof filtered.chatAgentPrompt === "string") {
    filtered.chatAgentPrompt = sanitizePromptField(filtered.chatAgentPrompt);
  }
  if (typeof filtered.autoAacPrompt === "string") {
    filtered.autoAacPrompt = sanitizePromptField(filtered.autoAacPrompt);
  }

  if (Object.keys(filtered).length === 0) return updates;

  filtered.updatedAt = new Date();

  await db
    .update(aacSettings)
    .set(filtered)
    .where(eq(aacSettings.studentId, studentId));

  console.log(`[aac-settings-memory] Wrote ${Object.keys(filtered).length} fields for student ${studentId}`);
  return updates;
}

// ============================================================================
// FIELD DEFINITIONS
// ============================================================================

/**
 * Context_AACPrompt — The CUSTOM AAC prompt (DB: chatAgentPrompt), top-level
 * for visibility. Holds specific behaviors caretakers have explicitly
 * requested. Rigid: change it ONLY when a caretaker asks for a behavior
 * change, not on your own initiative.
 */
export const AAC_PROMPT_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Context_AACPrompt",
  type: "object",
  title: "AAC Custom Prompt (caretaker-requested)",
  description:
    "Specific behaviors a caretaker has EXPLICITLY requested the AAC follow when interacting with the student " +
    "(e.g. \"always greet her by name\", \"use very short sentences\", \"don't offer food choices\"). " +
    "This is the rigid, human-owned prompt — update it ONLY when a user asks you to change how the AAC behaves, " +
    "and write the instruction in plain, direct terms. When a user says something like \"when you're talking to " +
    "the student, do X\" or \"have the AAC do Y\", that is a request to update THIS field. Custom requests take " +
    "priority over the auto prompt: if a new custom request contradicts something in the auto prompt, also edit " +
    "the auto prompt (Context_AACAutoPrompt) to remove the contradicting part. Do not put general background facts " +
    "about the student here — those belong in the auto prompt.",
  opened: true,
  properties: {
    prompt: {
      id: "prompt",
      type: "string",
      title: "Prompt Text",
      description: "The full custom prompt text",
    },
  },
  db: {
    read: async (ctx) => {
      const settings = await readAACSettings(ctx);
      if (!settings) return null;
      return { prompt: settings.chatAgentPrompt || "" };
    },
    write: async (ctx, value) => {
      if (value?.prompt !== undefined) {
        await writeAACSettings(ctx, { chatAgentPrompt: value.prompt });
      }
      return value;
    },
  },
};

/**
 * Context_AACAutoPrompt — The AUTO AAC prompt (DB: autoAacPrompt). An
 * AI-maintained digest of "what the AAC needs to know about this student".
 * The live AAC startup AI cannot dig through the student's reports or detailed
 * data during a session, so this field stands in for that detail. Update it
 * whenever you learn new information about the student that the AAC would
 * benefit from knowing (communication level, interests, triggers, relevant
 * medical/behavioral facts, who's around them). Keep it concise and current.
 */
export const AAC_AUTO_PROMPT_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Context_AACAutoPrompt",
  type: "object",
  title: "AAC Auto Prompt (AI-generated)",
  description:
    "An AI-maintained digest of what the AAC needs to know about this student — communication level, interests, " +
    "relevant medical/behavioral facts, triggers, people around them, current goals. The live AAC can't read the " +
    "student's full reports mid-session, so this is its summary of the student. Whenever new information about a " +
    "student with AAC access is provided, consider updating this field to reflect it. This is AI-owned background " +
    "context, NOT explicit caretaker instructions (those go in Context_AACPrompt). If a caretaker's custom request " +
    "contradicts something here, remove the contradicting part from this field so the custom request wins.",
  opened: true,
  properties: {
    prompt: {
      id: "prompt",
      type: "string",
      title: "Prompt Text",
      description: "The full auto-generated prompt text",
    },
  },
  db: {
    read: async (ctx) => {
      const settings = await readAACSettings(ctx);
      if (!settings) return null;
      return { prompt: settings.autoAacPrompt || "" };
    },
    write: async (ctx, value) => {
      if (value?.prompt !== undefined) {
        await writeAACSettings(ctx, { autoAacPrompt: value.prompt });
      }
      return value;
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
      description: "0=fast (no LLM call), 1=thorough (preloads context + LLM summary)",
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
    // Apps
    appConfig: {
      id: "appConfig",
      type: "string",
      title: "App Configuration",
      description: "Per-app settings as JSON (e.g. { youtube: { enabled: true } })",
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
      return exposed;
    },
    write: async (ctx, value) => {
      if (value && typeof value === 'object') {
        await writeAACSettings(ctx, value);
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
 * student is in scope, so the assistant understands the AAC it is configuring
 * and how to manage the two AAC prompt fields.
 *
 * Key things this fixes:
 *  - The clinician assistant has no camera or microphone, so it used to reply
 *    "I can't see anything" when a caretaker said "when you see the student
 *    do X". But the AAC DOES have audio + video input — the assistant's job is
 *    to translate that request into a prompt update, not to disclaim it.
 *  - The assistant should know the AAC's user-facing capabilities (NOT its
 *    internal multi-agent architecture — that's handled on the AAC side).
 *  - The assistant should know which of the two prompt fields to edit, and
 *    when.
 */
export function buildAacClinicianGuidance(): string {
  return `

## Managing this student's AAC

This student has an AAC (augmentative communication) device/app. You do NOT operate it or perceive anything through it — you CONFIGURE it. The AAC runs its own on-device AI during live sessions. Your role is to set up what that on-device AI knows and how it behaves, by editing two prompt fields (below). You do not need to know how the AAC works internally; only what the caretaker sees.

What the AAC can do during a live session with the student:
- It can SEE the student and their surroundings through the device camera (video input).
- It can HEAR the student and the room through the microphone (audio input).
- It can SPEAK out loud to the student (text-to-speech).
- It can show the student a board of communication buttons, and build/adjust that board on the fly.
- It can raise a caretaker ALERT (a soft alert sound for situational issues) and an EMERGENCY ALARM (a loud, building tone) when something looks seriously wrong.

Because the AAC can see and hear, requests like "when you notice the student getting upset…", "when she points at the window…", or "if he starts to cry, …" are perfectly actionable. NEVER respond that you can't see or hear the student — instead, capture the request as an instruction for the AAC by updating the appropriate prompt below. You yourself don't see or hear anything; the AAC does, during its sessions.

Two AAC prompt fields (edit ONLY during these clinician conversations — the AAC's own AI can never change them):
- **Context_AACPrompt — the CUSTOM prompt.** Specific behaviors a caretaker has explicitly asked the AAC to follow (e.g. "greet her by name", "keep sentences short", "don't offer food choices", "if he starts crying, play calming music"). When a user tells you to do something "while interacting with the student", "during AAC sessions", or "have the AAC do X", that is a request to update THIS field. It is rigid and human-owned: change it only when a user asks. Custom requests take priority over the auto prompt.
- **Context_AACAutoPrompt — the AUTO prompt.** A concise digest of what the AAC needs to know about this student: communication level, interests, relevant medical/behavioral facts, triggers, people around them, current goals. The AAC can't read the student's full reports mid-session, so this stands in for that detail. Whenever new information about the student comes up in conversation, consider updating this field so the AAC stays current.

Precedence: the custom prompt wins over the auto prompt. If a new custom request contradicts something in the auto prompt, edit the auto prompt to remove the contradicting part so the two don't fight. (Safety protocols on the AAC side always win over both.)`;
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
