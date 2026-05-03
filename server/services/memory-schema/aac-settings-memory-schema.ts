/**
 * aac-settings-memory-schema.ts
 *
 * Memory field definitions for AAC settings, exposed through the memory system
 * so the AI can read and modify them during regular chat sessions.
 *
 * Fields:
 * - Context_AACPrompt: The custom AAC prompt (top-level, updated when reports/goals change)
 * - Context_AACSettings: All other AAC settings (voice, display, input, symbols, etc.)
 *
 * Persistence: Writes go directly to the aacSettings table (not chatMemory).
 * Frontend sync: Changes are extracted as contextData "aacprompt" / "aacsettings"
 * and the frontend invalidates student queries to reload the settings panel.
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
    "iconTextRatio", "usePcsSymbols",
    "generateSymbols", "useApprovedSymbols", "useUnapprovedSymbols", "dynamicBoardsEnabled",
    "eyegazeEnabled", "eyegazeTimeout", "eyegazeProvider",
    "signLanguageReading", "multiCameraMode",
    "allowReadProgress", "allowReadReports", "allowNotes",
    "appConfig", "chatAgentPrompt",
  ]);

  const filtered: Record<string, any> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (WRITABLE_COLUMNS.has(k)) filtered[k] = v;
  }

  // Sanitize the chatAgentPrompt persona on write. The persona is concatenated
  // raw into the AAC live + monitor system prompts under "# CUSTOM
  // INSTRUCTIONS"; without this the field is a clinician-controllable prompt
  // injection slot. We strip the framing tokens the live + monitor pipelines
  // use as control delimiters (so a malicious persona can't fake them) and
  // cap the length. Leave the rest of the text as-is — clinicians are
  // supposed to be able to customize the AI's tone.
  if (typeof filtered.chatAgentPrompt === "string") {
    let p = filtered.chatAgentPrompt;
    const FRAMING_TOKENS = [
      "[CONTEXT]", "[/CONTEXT]",
      "[UPDATE_PROMPT]", "[/UPDATE_PROMPT]",
      "[BOARD]", "[/BOARD]",
      "[ENHANCED_PROMPT]", "[/ENHANCED_PROMPT]",
      "[CALL_MONITOR]", "[INTERPRET]", "[/INTERPRET]",
      "[TRANSCRIPT]", "[PEOPLE PRESENT]", "[BUTTON PRESS]",
      "[SYSTEM]", "[/SYSTEM]",
    ];
    for (const tok of FRAMING_TOKENS) {
      p = p.split(tok).join(tok.replace(/\[/g, "(").replace(/\]/g, ")"));
    }
    // Hard cap to keep injection bandwidth small; 8 KB is well above any
    // legitimate clinician persona.
    if (p.length > 8000) p = p.slice(0, 8000);
    filtered.chatAgentPrompt = p;
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
 * Context_AACPrompt — The custom AAC prompt, top-level for visibility.
 * Updated regularly when reports/goals change.
 */
export const AAC_PROMPT_FIELD: AgentMemoryFieldObjectWithDB = {
  id: "Context_AACPrompt",
  type: "object",
  title: "AAC Custom Prompt",
  description: "The custom prompt that guides the Interactive Agent's behavior during AAC sessions. Update this when student goals, medical info, or context changes.",
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
    signLanguageReading: {
      id: "signLanguageReading",
      type: "string",
      title: "Sign Language Reading",
      description: "Enable sign language detection (true/false)",
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

export function getAACSettingsMemoryFields(): AgentMemoryFieldWithDB[] {
  return [AAC_PROMPT_FIELD, AAC_SETTINGS_FIELD];
}
