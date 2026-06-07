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
 * Fields:
 * - Context_AACPrompt: Caretaker instructions — specific behaviors a caretaker
 *     has explicitly requested. Rigid; changed only on caretaker request.
 *     (DB column: chatAgentPrompt.)
 * - Context_AACAutoPrompt: The assistant's scratchpad — a self-maintained
 *     consolidation of everything its AAC-mode self needs to know about the
 *     student. Updated whenever new information about the student is learned.
 *     (DB column: autoAacPrompt.)
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
 * Context_AACPrompt — Caretaker instructions (DB: chatAgentPrompt). Behaviors a
 * caretaker has explicitly requested for AAC sessions. Rigid: change it only on
 * caretaker request.
 */
export const AAC_PROMPT_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Context_AACPrompt",
  type: "object",
  title: "AAC Caretaker Instructions",
  description:
    "Behaviors a caretaker has explicitly asked you to follow in AAC mode " +
    "(e.g. \"greet her by name\", \"keep sentences short\", \"don't offer food choices\"). " +
    "Rigid and human-owned — update only when a user asks to change how you behave during sessions. ",
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
 * Context_AACAutoPrompt — Your scratchpad (DB: autoAacPrompt). What your AAC-mode
 * self needs to know about this student, consolidated in one place because in
 * AAC mode you can't read their reports mid-session. Update it as you learn new
 * things about the student.
 */
export const AAC_AUTO_PROMPT_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Context_AACAutoPrompt",
  type: "object",
  title: "AAC Scratchpad (your notes on the student)",
  description:
    "Your scratchpad of non-sensitive, functional information your AAC-mode self needs to communicate with and support this student — " +
    "communication level, interests, triggers, physical and cognitive abilities, people around them, current goals. Keep it functional: " +
    "capture what you'd watch for and DO, never clinical labels. Translate medical facts into behavior — e.g. \"may have seizures; if she " +
    "suddenly goes blank, stay calm and alert a caretaker\" rather than naming a diagnosis; leave bare diagnoses, history, medications, and " +
    "test scores in the student's gated records. Update this freely so your AAC-mode self stays current — do not ask the user if they want you to update it, just do it.",
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

You prepare for AAC sessions through two notes-to-self. You can only edit them here in setup mode — in AAC mode you read them but can't change them:
- **Context_AACPrompt — user instructions.** Specific behaviors a user has explicitly asked for (e.g. "greet her by name", "keep sentences short", "don't offer food choices", "if he starts crying, play calming music"). When a user tells you to do something "while you're with the student", "during AAC sessions", or "have the AAC do X", they're adding to THIS note. These instructions take priority over your scratchpad.
- **Context_AACAutoPrompt — your scratchpad.** Your own running notes of non-sensitive, functional information on the student: everything you'll want at hand when you're with them in AAC mode — communication level, interests, relevant physical or cognitive capabilities, behavioral facts, triggers, who's around them, current goals. In AAC mode you can't stop to read through their reports, so consolidate anything important here. Whenever you learn something new about the student in conversation, jot it down so your AAC-mode self stays current.

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
