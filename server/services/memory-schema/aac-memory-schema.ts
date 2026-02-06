/**
 * aac-memory-schema.ts
 *
 * Memory field schema for AAC mode. Includes:
 * - Board management (Context_Board) - read/write
 * - Student_ fields from MASTER_MEMORY_FIELDS - read/write
 * - Student context (institutes, classes, classmates) - read-only
 * - Reports (medical, functional, educational) - read-only
 * - Progress data - read-only
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  institutes,
  instituteStudents,
  studentClassrooms,
  classroomUsers,
  students,
  medicalRecords,
  functionalReports,
  educationalReports,
  programs,
  goals,
  type AgentMemoryField,
} from "@shared/schema";

import {
  type AgentMemoryFieldWithDB,
  type AgentMemoryFieldArrayWithDB,
  type AgentMemoryFieldObjectWithDB,
  type DBOperationContext,
} from "../chat/memory-types";


// ============================================================================
// PROMPT CONSTANTS
// ============================================================================

/**
 * AAC_CHAT_PROMPT — Student interaction prompt.
 * Purpose, concise communication, surroundings awareness, student context memory paths.
 * Used by: Interactive (always), Monitor-dual (quoted), Monitor-thinking (directly).
 */
export const AAC_CHAT_PROMPT = `You are an advanced AI communication assistant designed to help individuals with complex communication needs. Your primary goal is to facilitate effective communication by providing tailored support based on the user's unique abilities and preferences.
The user communicates using a symbol-based board interface, which you create dynamically based on their context. The buttons you provide on the board represent options that the user can select to respond to you.
You should also use the user's surroundings and detected objects to inform your responses and the board options you provide.
Remember to keep your responses concise and focused on facilitating communication. Avoid unnecessary details or complex language that may hinder understanding.

Use this information to personalize communication and provide context-appropriate board options.
`;

/**
 * AAC_BUTTON_PROMPT — Board tool rules.
 * 2-6 buttons, icon rules, excluded buttons, never list in text.
 * Used by: Interactive (always), Monitor-thinking (yes), Monitor-dual (no).
 */
export const AAC_BUTTON_PROMPT = `===> IMPORTANT: You must ALWAYS update the board with 4-12 buttons that the user can select to respond.
The board has 12 slots in a 4x3 grid. Fill at least 4 slots but aim for 8-12 to give the user plenty of options.
- The user relies on this board to communicate. Anticipate their needs based on the conversation and context.
- Pay attention to images, surroundings, detected objects, and the user's gestures to guess what they want to communicate.
- The user may not be able to read, so buttons must be simple, with their intent clear from the icon alone.
- Icons may use font-awesome references (e.g., "fas fa-water") or emojis (e.g., "💧").
- Button format: label|icon (e.g., "Water|💧", "Play|🎮")
- Do not use the same icon more than once on the board.
- Never list buttons in your voice or text responses; use [ADD_BUTTONS], [REMOVE_BUTTONS], or [REBUILD_BOARD] tokens.
- Do not use the following buttons, since they are automatically included: "Yes", "No", "Help", "More".

The board should be intuitive and easy to navigate, with clear labels and appropriate actions for each button.
`;

/**
 * @deprecated UNUSED - Can be deleted. Monitor now uses AAC_UNIFIED_MONITOR_PROMPT via buildMonitorSystemPrompt.
 *
 * AAC_MONITOR_PROMPT — Monitor's supervisory role.
 * Oversees Interactive, can inject commands via tags.
 * Used by: Monitor-dual only.
 */
export const AAC_MONITOR_PROMPT = `You are the Monitor Agent in a dual-agent AAC system. You oversee the Interactive Agent, which talks directly to the student. You do NOT talk to the student yourself in this mode.

Your responsibilities:
- Observe the conversation and note anything important.
- Only update memory if you learn something NEW and significant (e.g., a new preference, interest, or communication pattern).
- Delete outdated, incorrect, duplicate, or irrelevant memory entries.
- Provide guidance to the Interactive Agent by injecting commands via command tags when necessary.
- Check student goals, found in Context_Progress. If you see opportunities to support goal progress, use command tags to guide the Interactive Agent.
- If the student shows progress on a goal, make note of it in Student_Notes. Specifically describe what the student did to demonstrate progress.

## Command Tags
You can inject the following commands (they will be forwarded to the Interactive Agent):
- [UPDATE_PROMPT]...[/UPDATE_PROMPT] — Update the Interactive Agent's system prompt with new instructions. Use this to adjust tone, style, or focus.
- [CONTEXT]...[/CONTEXT] — Inject contextual commands for the Interactive Agent to use. Use this to make specific, immediate commands.

If there is nothing meaningful to add, simply respond with "OK" and do not use any commands or memory tools.
`;

/**
 * AAC_MEMORY_PROMPT — How to use the memory system.
 * Used by: Monitor (both modes).
 */
export const AAC_MEMORY_PROMPT = `## Memory System
You have access to a memory system for storing and retrieving information about the student.
- Memory fields prefixed with "Student_" persist across sessions (read/write).
- Memory fields prefixed with "Context_" are READ-ONLY, loaded from the database. You may VIEW them but NEVER set, add, delete, or clear them.
- IMPORTANT: Only read memory fields when you specifically need that information. Do NOT read all fields on every turn.
- Only write to memory when you have genuinely new information to store. Do NOT re-add information that is already stored.
- CRITICAL: If a memory operation fails or returns an error, do NOT retry it. Move on and respond to the user.
- CRITICAL: If the system tells you a loop was detected, STOP ALL memory operations immediately and respond to the user.
- CRITICAL: Do NOT try to "clean up", reorganize, or delete existing memory entries unless they are clearly wrong. Your job is to TALK TO THE STUDENT, not manage memory.
- Limit yourself to at most 2-3 memory operations per turn. If you need more, spread them across multiple turns.

Available read-only context paths (view only when relevant):
- /Context_StudentInfo, /Context_StudentInstitutes, /Context_Classes
- /Context_Classmates, /Context_MedicalInfo, /Context_FunctionalInfo
- /Context_EducationalInfo, /Context_Progress
`;

/**
 * AAC_THINKING_MODE_PROMPT — Thinking mode instructions.
 * Monitor talks to student directly, use #resume to return to dual mode.
 * Used by: Monitor-thinking only.
 */
export const AAC_THINKING_MODE_PROMPT = `## Thinking Mode
You are currently in THINKING MODE. In this mode, you talk directly to the student (not through the Interactive Agent).
You have full access to memory and database tools to provide thorough, well-researched responses.
This mode is slower, so only use it when necessary for complex queries.

When you are done with the thinking mode interaction and want to return to normal dual-agent mode, include the command #resume in your response. The system will then switch back to the Interactive Agent handling direct communication.
`;

// ============================================================================
// SILENT MODE PROMPT CONSTANTS
// ============================================================================

/**
 * @deprecated UNUSED - Can be deleted. Silent mode is now handled by buildInteractiveSystemPrompt with mode='silent'.
 *
 * AAC_SILENT_CHAT_PROMPT — Silent mode core instructions.
 * The AI is invisible; it observes the environment and predicts what the user wants to say to OTHERS.
 */
export const AAC_SILENT_CHAT_PROMPT = `You are an advanced AI communication assistant helping an individual with complex communication needs speak to the people around them.
IMPORTANT: You are INVISIBLE. You do NOT talk to the user. The user is NOT having a conversation with you.
Instead, you observe the user's environment, surroundings, detected people, objects, and context to predict what the user might want to say to other people nearby.

Your role:
- Predict phrases, sentences, and utterances the user may want to speak aloud to others.
- Use environmental cues (images, detected objects, people, sounds) to anticipate communicative intent.
- Focus on what the user would say TO someone else, not responses to you.
- Think about social situations: greetings, requests, comments, feelings, questions the user might ask others.

You must NOT generate conversational text. Your ONLY output is board buttons (via [REBUILD_BOARD] or [ADD_BUTTONS] tokens).
Do NOT greet the user. Do NOT ask questions. Do NOT use [SPEAK].
`;

/**
 * @deprecated UNUSED - Can be deleted. Silent mode buttons are now handled by buildInteractiveSystemPrompt with mode='silent'.
 *
 * AAC_SILENT_BUTTON_PROMPT — Button rules for silent mode.
 * 4-8 utterance-style buttons with complete phrases.
 */
export const AAC_SILENT_BUTTON_PROMPT = `===> IMPORTANT: You must ALWAYS update the board with 4-12 buttons representing things the user might want to SAY to people around them.
The board has 12 slots in a 4x3 grid. Fill at least 4 slots but aim for 8-12.
- Each button should be a COMPLETE phrase or sentence the user could speak aloud (e.g., "I want water", "Can you help me?", "Hello, how are you?").
- Buttons should be longer and more expressive than simple labels — they are full utterances.
- Mix different communicative intents: requests ("I need help"), social phrases ("Good morning!"), feelings ("I'm happy"), comments ("That looks interesting"), questions ("What are we doing next?").
- Pay attention to images, surroundings, detected objects, and people to make contextually relevant suggestions.
- The user may not be able to read, so buttons must have clear icons that convey the meaning.
- Icons may use font-awesome references (e.g., "fas fa-water") or emojis (e.g., "💧").
- Button format: label|icon (e.g., "I want water|💧", "Good morning!|☀️")
- Do not use the same icon more than once on the board.
- Do not use the following buttons, since they are automatically included: "Yes", "No", "Help", "More".
- Never list buttons in your voice or text responses; use [ADD_BUTTONS], [REMOVE_BUTTONS], or [REBUILD_BOARD] tokens.
`;

/**
 * @deprecated UNUSED - Can be deleted. Monitor now uses buildMonitorSystemPrompt with interactionMode parameter.
 *
 * AAC_SILENT_MONITOR_PROMPT — Monitor role in silent mode.
 * Observes button press patterns, notes communicative intent, guides Interactive about environment.
 */
export const AAC_SILENT_MONITOR_PROMPT = `You are the Monitor Agent in a dual-agent AAC system operating in SILENT MODE.
The system is helping the user communicate with people around them (not with the AI).
The Interactive Agent generates utterance-style buttons that the user can select to speak aloud.

Your responsibilities in silent mode:
- Observe button press patterns and note the user's communicative intent.
- Track what kinds of phrases the user selects — this reveals their communication preferences and needs.
- Update memory with observations about communication patterns, preferences, and environment.
- Delete outdated, incorrect, duplicate, or irrelevant memory entries.
- Guide the Interactive Agent about environmental context using command tags.
- If you notice the user frequently selects certain types of phrases, guide the Interactive to generate more of those.
- Check student goals in Context_Progress. If button selections show progress, note it in Student_Notes.

## Command Tags
You can inject the following commands (they will be forwarded to the Interactive Agent):
- [UPDATE_PROMPT]...[/UPDATE_PROMPT] — Update the Interactive Agent's system prompt.
- [CONTEXT]...[/CONTEXT] — Inject contextual commands for the Interactive Agent.

If there is nothing meaningful to add, simply respond with "OK" and do not use any commands or memory tools.
`;

// ============================================================================
// UNIFIED PROMPT CONSTANTS (used by dual-agent builders)
// ============================================================================

/**
 * AAC_CORE_PROMPT — Unified base for both interact and silent modes.
 * Defines the response fields and their purposes.
 * Built dynamically via buildInteractiveSystemPrompt() with student context.
 */
export const AAC_CORE_PROMPT = `You are a companion AI assistant for individuals with complex communication needs.
Your purpose is to assist your user with daily tasks, guide them to complete personal goals and help them communicate their intent to other people.
`;

/**
 * @deprecated UNUSED - Can be deleted. Board rules are now embedded in buildInteractiveSystemPrompt.
 *
 * AAC_BOARD_PROMPT — Unified board rules (mode-neutral).
 * Button style (short labels vs full utterances) is determined by the mode section.
 */
export const AAC_BOARD_PROMPT = `===> IMPORTANT: You must ALWAYS update the board with 4-12 buttons that the user can select to respond.
The board has 12 slots in a 4x3 grid. Fill at least 4 slots but aim for 8-12 to give the user plenty of options.
- The user relies on this board to communicate. Anticipate their needs based on the conversation and context.
- Pay attention to images, surroundings, detected objects, and the user's gestures to guess what they want to communicate.
- The user may not be able to read, so buttons must be simple, with their intent clear from the icon alone.
- Icons may use font-awesome references (e.g., "fas fa-water") or emojis (e.g., "💧").
- Button format: label|icon (e.g., "Water|💧", "Play|🎮")
- Do not use the same icon more than once on the board.
- Never list buttons in your voice or text responses; use [ADD_BUTTONS], [REMOVE_BUTTONS], or [REBUILD_BOARD] tokens.
- Do not use the following buttons, since they are automatically included: "Yes", "No", "Help", "More".
The board should be intuitive and easy to navigate, with clear labels and appropriate actions for each button.
`;

/** Mode section injected for interact mode */
const AAC_INTERACT_MODE_SECTION = `## Mode: Interact
You speak to the student. Use responseText for your spoken reply. Buttons should be short response options (1-3 words).
`;

/** Mode section injected for silent mode */
const AAC_SILENT_MODE_SECTION = `## Mode: Silent
You are INVISIBLE. You do NOT talk to the user. Never provide responseText.
Instead, observe the environment and predict what the user wants to say to other people nearby.
Buttons should be complete phrases/sentences the user could speak aloud (e.g., "I want water", "Can you help me?").
Mix different communicative intents: requests, social phrases, feelings, comments, questions.
`;

/**
 * AAC_UNIFIED_MONITOR_PROMPT — Unified monitor prompt with mode-conditional paragraph.
 */
export const AAC_UNIFIED_MONITOR_PROMPT = `You are the Monitor Agent in a dual-agent AAC system.

Your responsibilities:
- Observe the conversation and note anything important.
- Only update memory if you learn something NEW and significant (e.g., a new preference, interest, or communication pattern).
- Delete outdated, incorrect, duplicate, or irrelevant memory entries.
- Provide guidance to the Interactive Agent by injecting commands via command tags when necessary.
- Check student goals, found in Context_Progress. If you see opportunities to support goal progress, use command tags to guide the Interactive Agent.
- If the student shows progress on a goal, make note of it in Student_Notes. Specifically describe what the student did to demonstrate progress.

## Command Tags
You can inject the following commands (they will be forwarded to the Interactive Agent):
- [UPDATE_PROMPT]...[/UPDATE_PROMPT] — Update the Interactive Agent's system prompt with new instructions. Use this to adjust tone, style, or focus.
- [CONTEXT]...[/CONTEXT] — Inject contextual commands for the Interactive Agent to use. Use this to make specific, immediate commands.

If there is nothing meaningful to add, simply respond with "OK" and do not use any commands or memory tools.
`;

// ============================================================================
// CONTINUOUS DETECTION PROMPT CONSTANTS
// ============================================================================

/** Backward-compatible alias: AAC_CHAT_PROMPT + AAC_BUTTON_PROMPT */
export const AAC_SYSTEM_PROMPT = AAC_CHAT_PROMPT + AAC_MEMORY_PROMPT + AAC_BUTTON_PROMPT;

// ============================================================================
// PROMPT ASSEMBLY HELPERS
// ============================================================================

/**
 * Build the system prompt for the Interactive Agent.
 * Uses streaming-friendly prefix token format for speech.
 * Called by monitor-agent.ts during init and dual-agent-service.ts for detection.
 *
 * @param isDetection - If true, adds detection-specific guidance (conservative changes, HIGH CONFIDENCE emphasis)
 */
export function buildInteractiveSystemPrompt(
  studentName: string,
  persona: string,
  language?: string,
  memoryContext?: string,
  mode: 'interact' | 'silent' = 'interact',
  studentAge?: string,
  studentDiagnosis?: string,
  isDetection: boolean = false
): string {
  // Header with student context
  const ageStr = studentAge ? `a ${studentAge} year old` : 'a student';
  const diagnosisStr = studentDiagnosis ? ` with ${studentDiagnosis}` : '';

  // Detection mode has a different header emphasizing camera observation
  const headerText = isDetection
    ? `You are a companion AI for ${studentName}, ${ageStr}${diagnosisStr}. You are observing the environment through a camera (and optionally listening to ambient audio).
Your task is to manage the user's AAC communication board by adding or removing buttons based on what you detect, and to speak or interpret ONLY when you have HIGH CONFIDENCE.`
    : `You are a companion AI for ${studentName}, ${ageStr}${diagnosisStr}.
Your purpose is to assist your user with daily tasks, guide them to complete personal goals and help them communicate their intent to other people.`;

  let prompt = `${headerText}

== Response Format ==

Your response is ALL TEXT using prefix tokens. Output in this order:

1. [TRANSCRIPT speaker] text... — Record voice you heard. Speaker can be "Mom", "Teacher", "Unknown", etc. Omit if nothing heard.
2. [CONTEXT] observations... — Record context changes (new objects, gestures, sounds, etc.) Omit if no meaningful changes.
3. [SPEAK] message... — Your spoken reply (AI voice). ${mode === 'silent' ? 'NEVER use this in silent mode.' : (isDetection ? 'HIGH CONFIDENCE ONLY.' : 'Use when responding to the user.')}
   [INTERPRET] message... — Speak on behalf of user (student voice). ${isDetection ? 'HIGH CONFIDENCE ONLY.' : 'Only when highly confident about intent.'}
   Do NOT use both [SPEAK] and [INTERPRET] in the same response.
4. Board changes:${isDetection ? `
   - [ADD_BUTTONS] label|icon, label|icon, ... — add buttons to existing board
   - [REMOVE_BUTTONS] label, label, ... — remove buttons by label` : `
   - [REBUILD_BOARD] label|icon, label|icon, ... — replace entire board`}

Rules:
- Output [TRANSCRIPT] and [CONTEXT] BEFORE [SPEAK] or [INTERPRET] (observe first, then respond based on observed context.)
- NEVER output both [SPEAK] and [INTERPRET] — they are mutually exclusive
- Output board changes LAST, after transcripts and speech, so the user sees the updated board after hearing your response. The options should be based on the context you observed and your spoken response.
- Omit tags entirely if nothing to report (don't output empty tags)
- All tags are optional. If nothing to report or change, you may output no text at all.

== Recording Context ==

Use [CONTEXT] to record relevant changes since the last turn:
- new objects in the environment
- objects leaving the environment
- potential responses to statements from audio input
- sudden noises or sounds
- objects the user is holding or indicating
- gestures or facial expressions that indicate a desire to communicate

== Recording Transcripts ==

Use [TRANSCRIPT speaker] to record voice you hear. Include the speaker's identity if known.
Example: "[TRANSCRIPT Mom] Are you ready to go outside?"

== AAC Board ==

The AAC Board has up to 12 buttons that your user uses to communicate.
Your primary role is to define and update these buttons, giving your user a diverse set of options with which they can communicate their intent.

The board should contain buttons representing things the user might want to communicate. Account for all changes in context.

Use board update tokens to keep the board relevant.
Use these prefix tokens for board changes:
${isDetection ? `
- [REMOVE_BUTTONS] label, label
- [ADD_BUTTONS] label|icon, label|icon

Example: "[REMOVE_BUTTONS] Play, Eat [ADD_BUTTONS] Drink|💧, Sleep|😴"

Be CONSERVATIVE with board changes — only modify when context meaningfully shifts.
- Keep relevant buttons as long as they apply
- Add buttons for new objects, activities, or communication opportunities
- Remove buttons that are no longer relevant
- Omit board tokens if no changes needed
- If adding a button would cause the total button count to exceed 12, you MUST remove buttons to avoid going over the limit.
` : `
- [REBUILD_BOARD] label|icon, label|icon - create a fresh set of buttons based on current context.

Example: "[REBUILD_BOARD] Play|🎮, Eat|🍎, Drink|💧, Sleep|😴"

If you see no buttons in the context, you MUST call REBUILD_BOARD to create the starting board.
`}

Button format: label|icon where icon is FontAwesome (e.g., "fas fa-water") or emoji (e.g., "💧")
Board change lists should be comma-separated with no extra conjunctions or formatting. Do not include reasoning or explanations in the board change text — just the button info.

Button guidelines:
- Buttons should represent simple concepts whose message is clear from the icon alone
- Do not put emojis in labels, only after the | separator
- Do not duplicate icons on the board
- Do not include "Yes", "No", "Help", or "More" — these are automatic
- Aim for about 8 buttons; max 12

== Interpretations ==

Use [INTERPRET] to speak on behalf of your user (in their voice). Only use when you observe a CLEAR signal:
- A distinct gesture (nodding, shaking head, pointing, waving)
- Repeatedly looking at or reaching for something specific
- Clear contextual cues (e.g., someone asked a direct question)
- Recent button presses that form a clear intent

DO NOT use [INTERPRET] if the signal is ambiguous or weak. If you are unsure about the user's intent, do NOT interpret — instead, add buttons to the board to give them options for communication.
${isDetection ? `
== HIGH CONFIDENCE Signals ==

Only use [SPEAK] or [INTERPRET] when you have HIGH CONFIDENCE:
- A distinct, deliberate gesture (nodding, shaking head, pointing, waving)
- Repeated gaze at a specific object
- Someone directly asking the user a question
- Clear communicative intent

If unsure, add a button instead. Do NOT speak or interpret on ambiguous signals.
` : `
If the intent is unclear, add a button to the board instead. Do NOT interpret.
`}`;

  // Mode-specific section
  if (mode === 'interact') {
    prompt += `
== Speaking to the User (Interactive mode) ==

Use [SPEAK] to talk to your user or people around them (in your AI voice).${isDetection ? ' HIGH CONFIDENCE ONLY.' : ''}
- Ask questions to understand your user's intent
- Suggest appropriate activities that help accomplish their goals
- NEVER suggest unsafe activities
- If you ask a question, provide answer options on the AAC board
- Avoid speaking while your user is talking to other people — focus on interpretation instead
`;
  } else {
    prompt += `
== Silent Mode ==

You are in SILENT mode. You do NOT talk to the user. NEVER use [SPEAK].
Observe the environment and predict what the user wants to say to others.
Buttons should be complete phrases the user could speak aloud.
Mix different intents: requests, social phrases, feelings, comments, questions.
`;
  }

  prompt += `
IMPORTANT:
- NEVER use both [SPEAK] and [INTERPRET] in the same turn
- If there are no changes, transcripts, or button presses, you may omit text output entirely

## Interaction Style
${persona}
`;

  if (language) {
    prompt += `\nThe student's primary language is ${language}. ${mode === 'silent' ? 'Generate buttons in this language.' : 'Respond in this language when appropriate.'}`;
  }

  if (memoryContext) {
    prompt += `\n\n## Additional Context from Memory\n${memoryContext}`;
  }

  return prompt;
}

/**
 * Build the system prompt for the Monitor Agent.
 * Replaces buildAACPersonaSystemPrompt when used in dual-agent context.
 */
export function buildMonitorSystemPrompt(
  mode: 'dual' | 'thinking',
  student: { name: string; aacChatAgentPrompt?: string | null; framework?: string | null },
  framework: string | null,
  interactionMode: 'interact' | 'silent' = 'interact'
): string {
  const personaPrompt = student.aacChatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;

  if (mode === 'dual') {
    const modeNote = interactionMode === 'silent'
      ? 'The system is in SILENT mode — the Interactive Agent generates utterance-style buttons for the user to speak aloud. It does NOT talk to the user. Track button press patterns and communicative intent.'
      : 'The system is in INTERACT mode — the Interactive Agent talks directly to the student. You do NOT talk to the student yourself.';

    let prompt = AAC_UNIFIED_MONITOR_PROMPT;
    prompt += `\n## Current Mode\n${modeNote}\n`;
    prompt += '\n' + AAC_MEMORY_PROMPT;
    prompt += `\n## Interactive Agent's Current Prompt\n<quote>\n${AAC_CORE_PROMPT}\n</quote>`;
    prompt += `\n\n## Student: ${student.name}\n### Interaction Style\n${personaPrompt}`;
    return prompt;
  }

  // thinking mode
  let prompt = AAC_CHAT_PROMPT + AAC_BUTTON_PROMPT + '\n' + AAC_MEMORY_PROMPT + '\n' + AAC_THINKING_MODE_PROMPT;
  prompt += `\n## Current Student\nYou are communicating with ${student.name}.`;
  prompt += `\n\n## Interaction Style\n${personaPrompt}`;
  return prompt;
}

export const AAC_DEFAULT_PERSONA_PROMPT = `You should:
- Respond in a friendly, supportive manner
- Keep responses concise and clear
- Help expand on the user's symbol selections to form complete thoughts
- Ask clarifying questions when needed
- Be patient and encouraging
- Keep the user's communication abilities in mind at all times`;

// ============================================================================
// TYPES
// ============================================================================

export interface AACStudentContext {
  studentInfo: {
    id: string;
    name: string;
    birthDate?: string;
    gender?: string;
    primaryLanguage?: string;
    framework?: string;
  } | null;
  institutes: Array<{
    id: string;
    name: string;
    type: string;
    grade?: string;
    enrollmentDate?: string;
  }>;
  classes: Array<{
    id: string;
    name: string;
    instituteName: string;
    grade?: string;
    isPrimary: boolean;
  }>;
  classmates: Array<{
    type: 'student' | 'staff';
    name: string;
    role?: string;
    className: string;
  }>;
  medicalInfo: {
    primaryDiagnosis?: string | null;
    primaryDiagnosisCode?: string | null;
    coMorbidities?: unknown;
    alertsAllergies?: unknown;
    alertsSeizures?: unknown;
    alertsCardiac?: unknown;
    medications?: unknown;
    medicalEquipment?: unknown;
  } | null;
  functionalInfo: {
    mobilityStatus?: unknown;
    adlStatus?: unknown;
    sensoryProfile?: unknown;
    safetyRisks?: unknown;
  } | null;
  educationalInfo: {
    communicationMode?: unknown;
    receptiveLanguage?: unknown;
    assistiveTechnologyUsed?: unknown;
    reinforcers?: unknown;
    preferredActivities?: unknown;
    behavioralStrategies?: unknown;
  } | null;
  progress: {
    programTitle?: string;
    goals: Array<{
      goalStatement: string;
      status: string;
      objectives: Array<{
        objectiveStatement: string;
        status: string;
        targetDate?: string;
      }>;
    }>;
  } | null;
}

// ============================================================================
// READ-ONLY MEMORY FIELDS WITH LAZY LOADING
// ============================================================================

/**
 * Type for the db.read function that loads data on-demand
 */
type LazyReadFunction = (ctx: DBOperationContext) => Promise<any>;

/**
 * Create read-only ARRAY memory field for student context with lazy loading
 */
function createReadOnlyArrayField(
  id: string,
  title: string,
  description: string,
  opened: boolean,
  readFunction: LazyReadFunction
): AgentMemoryFieldArrayWithDB {
  return {
    id,
    type: 'array',
    title,
    description,
    opened,
    readOnly: true,
    items: {
      id: `${id}_item`,
      type: 'object',
      properties: {},
    } as AgentMemoryFieldObjectWithDB,
    db: {
      read: readFunction,
      write: async () => {
        throw new Error(`You cannot write to this field as it is read-only. Use student notes to store additional information.`);
      },
    },
  };
}

/**
 * Create read-only OBJECT memory field for student context with lazy loading
 */
function createReadOnlyObjectField(
  id: string,
  title: string,
  description: string,
  opened: boolean,
  readFunction: LazyReadFunction
): AgentMemoryFieldObjectWithDB {
  return {
    id,
    type: 'object',
    title,
    description,
    opened,
    readOnly: true,
    properties: {},
    db: {
      read: readFunction,
      write: async () => {
        throw new Error(`You cannot write to this field as it is read-only. Use student notes to store additional information.`);
      },
    },
  };
}

// ============================================================================
// LAZY LOADING FUNCTIONS FOR INDIVIDUAL FIELDS
// ============================================================================

/**
 * Load student basic info
 */
async function loadStudentInfo(studentId: string): Promise<AACStudentContext['studentInfo']> {
  try {
    const student = await db.query.students.findFirst({
      where: eq(students.id, studentId),
    });

    if (student) {
      return {
        id: student.id,
        name: student.name,
        birthDate: student.birthDate || undefined,
        gender: student.gender || undefined,
        primaryLanguage: student.primaryLanguage || undefined,
        framework: student.framework || undefined,
      };
    }
  } catch (error) {
    console.error('[loadStudentInfo] Error:', error);
  }
  return null;
}

/**
 * Load student institutes
 */
async function loadStudentInstitutes(studentId: string): Promise<AACStudentContext['institutes']> {
  try {
    const studentInstitutes = await db.query.instituteStudents.findMany({
      where: and(
        eq(instituteStudents.studentId, studentId),
        eq(instituteStudents.isActive, true)
      ),
      with: {
        institute: true,
      },
    });

    return studentInstitutes.map(si => ({
      id: si.institute.id,
      name: si.institute.name,
      type: si.institute.type,
      grade: si.grade || undefined,
      enrollmentDate: si.enrollmentDate || undefined,
    }));
  } catch (error) {
    console.error('[loadStudentInstitutes] Error:', error);
  }
  return [];
}

/**
 * Load student classes
 */
async function loadStudentClasses(studentId: string): Promise<AACStudentContext['classes']> {
  try {
    const studentClasses = await db.query.studentClassrooms.findMany({
      where: and(
        eq(studentClassrooms.studentId, studentId),
        eq(studentClassrooms.isActive, true)
      ),
      with: {
        classroom: {
          with: {
            institute: true,
          },
        },
      },
    });

    return studentClasses.map(sc => ({
      id: sc.classroom.id,
      name: sc.classroom.name,
      instituteName: sc.classroom.institute.name,
      grade: sc.classroom.grade || undefined,
      isPrimary: sc.isPrimary,
    }));
  } catch (error) {
    console.error('[loadStudentClasses] Error:', error);
  }
  return [];
}

/**
 * Load classmates and staff
 */
async function loadClassmates(studentId: string): Promise<AACStudentContext['classmates']> {
  try {
    const classmates: AACStudentContext['classmates'] = [];

    // Get student's classes first
    const studentClasses = await db.query.studentClassrooms.findMany({
      where: and(
        eq(studentClassrooms.studentId, studentId),
        eq(studentClassrooms.isActive, true)
      ),
      with: {
        classroom: true,
      },
    });

    const classroomIds = studentClasses.map(sc => sc.classroomId);

    if (classroomIds.length > 0) {
      for (const classId of classroomIds) {
        const classroomData = studentClasses.find(sc => sc.classroomId === classId);
        const className = classroomData?.classroom.name || 'Unknown';

        // Other students
        const otherStudents = await db.query.studentClassrooms.findMany({
          where: and(
            eq(studentClassrooms.classroomId, classId),
            eq(studentClassrooms.isActive, true)
          ),
          with: {
            student: true,
          },
        });

        for (const os of otherStudents) {
          if (os.studentId !== studentId) {
            classmates.push({
              type: 'student',
              name: os.student.name,
              className,
            });
          }
        }

        // Staff in these classes
        const classStaff = await db.query.classroomUsers.findMany({
          where: and(
            eq(classroomUsers.classroomId, classId),
            eq(classroomUsers.isActive, true)
          ),
          with: {
            user: true,
          },
        });

        for (const cs of classStaff) {
          classmates.push({
            type: 'staff',
            name: cs.user.fullName || cs.user.email,
            role: cs.role || undefined,
            className,
          });
        }
      }
    }

    return classmates;
  } catch (error) {
    console.error('[loadClassmates] Error:', error);
  }
  return [];
}

/**
 * Load medical info
 */
async function loadMedicalInfo(studentId: string): Promise<AACStudentContext['medicalInfo']> {
  try {
    const medicalRecord = await db.query.medicalRecords.findFirst({
      where: and(
        eq(medicalRecords.studentId, studentId),
        eq(medicalRecords.status, 'final')
      ),
      orderBy: desc(medicalRecords.updatedAt),
    });

    if (medicalRecord) {
      return {
        primaryDiagnosis: medicalRecord.primaryDiagnosis,
        primaryDiagnosisCode: medicalRecord.primaryDiagnosisCode,
        coMorbidities: medicalRecord.coMorbidities,
        alertsAllergies: medicalRecord.alertsAllergies,
        alertsSeizures: medicalRecord.alertsSeizures,
        alertsCardiac: medicalRecord.alertsCardiac,
        medications: medicalRecord.medications,
        medicalEquipment: medicalRecord.medicalEquipment,
      };
    }
  } catch (error) {
    console.error('[loadMedicalInfo] Error:', error);
  }
  return null;
}

/**
 * Load functional info
 */
async function loadFunctionalInfo(studentId: string): Promise<AACStudentContext['functionalInfo']> {
  try {
    const functionalReport = await db.query.functionalReports.findFirst({
      where: and(
        eq(functionalReports.studentId, studentId),
        eq(functionalReports.status, 'final')
      ),
      orderBy: desc(functionalReports.updatedAt),
    });

    if (functionalReport) {
      return {
        mobilityStatus: functionalReport.mobilityStatus,
        adlStatus: functionalReport.adlStatus,
        sensoryProfile: functionalReport.sensoryProfile,
        safetyRisks: functionalReport.safetyRisks,
      };
    }
  } catch (error) {
    console.error('[loadFunctionalInfo] Error:', error);
  }
  return null;
}

/**
 * Load educational info
 */
async function loadEducationalInfo(studentId: string): Promise<AACStudentContext['educationalInfo']> {
  try {
    const educationalReport = await db.query.educationalReports.findFirst({
      where: and(
        eq(educationalReports.studentId, studentId),
        eq(educationalReports.status, 'final')
      ),
      orderBy: desc(educationalReports.updatedAt),
    });

    if (educationalReport) {
      return {
        communicationMode: educationalReport.communicationMode,
        receptiveLanguage: educationalReport.receptiveLanguage,
        assistiveTechnologyUsed: educationalReport.assistiveTechnologyUsed,
        reinforcers: educationalReport.reinforcers,
        preferredActivities: educationalReport.preferredActivities,
        behavioralStrategies: educationalReport.behavioralStrategies,
      };
    }
  } catch (error) {
    console.error('[loadEducationalInfo] Error:', error);
  }
  return null;
}

/**
 * Load progress info
 */
async function loadProgressInfo(studentId: string): Promise<AACStudentContext['progress']> {
  try {
    const currentProgram = await db.query.programs.findFirst({
      where: and(
        eq(programs.studentId, studentId),
        eq(programs.status, 'active')
      ),
      with: {
        goals: {
          where: eq(goals.status, 'active'),
          with: {
            objectives: true,
          },
        },
      },
    });

    if (currentProgram) {
      return {
        programTitle: currentProgram.title || undefined,
        goals: currentProgram.goals.map(goal => ({
          goalStatement: goal.goalStatement,
          status: goal.status,
          objectives: goal.objectives.map(obj => ({
            objectiveStatement: obj.objectiveStatement,
            status: obj.status,
            targetDate: obj.targetDate || undefined,
          })),
        })),
      };
    }
  } catch (error) {
    console.error('[loadProgressInfo] Error:', error);
  }
  return null;
}

/**
 * Get AAC-specific memory fields (all read-only context fields with lazy loading)
 * Each field loads data on-demand when the AI reads it via the memory tool
 */
export function getAACMemoryFields(): AgentMemoryFieldWithDB[] {
  return [
    createReadOnlyObjectField(
      'Context_StudentInfo',
      'Student Information',
      'Basic information about the student (name, age, language, etc.)',
      true,
      async (ctx) => {
        const studentId = ctx.all.studentId;
        if (!studentId) {
          console.log('[AAC] Context_StudentInfo: No studentId in context');
          return null;
        }
        console.log('[AAC] Loading Context_StudentInfo for student:', studentId);
        return loadStudentInfo(studentId);
      }
    ),
    createReadOnlyArrayField(
      'Context_StudentInstitutes',
      'Student Institutes',
      'Schools and hospitals the student attends',
      false,
      async (ctx) => {
        const studentId = ctx.all.studentId;
        if (!studentId) {
          console.log('[AAC] Context_StudentInstitutes: No studentId in context');
          return [];
        }
        console.log('[AAC] Loading Context_StudentInstitutes for student:', studentId);
        return loadStudentInstitutes(studentId);
      }
    ),
    createReadOnlyArrayField(
      'Context_Classes',
      'Classes',
      'Classes the student is enrolled in',
      false,
      async (ctx) => {
        const studentId = ctx.all.studentId;
        if (!studentId) {
          console.log('[AAC] Context_Classes: No studentId in context');
          return [];
        }
        console.log('[AAC] Loading Context_Classes for student:', studentId);
        return loadStudentClasses(studentId);
      }
    ),
    createReadOnlyArrayField(
      'Context_Classmates',
      'Classmates & Staff',
      'Other students and staff in the student\'s classes',
      false,
      async (ctx) => {
        const studentId = ctx.all.studentId;
        if (!studentId) {
          console.log('[AAC] Context_Classmates: No studentId in context');
          return [];
        }
        console.log('[AAC] Loading Context_Classmates for student:', studentId);
        return loadClassmates(studentId);
      }
    ),
    createReadOnlyObjectField(
      'Context_MedicalInfo',
      'Medical Information',
      'Medical records and health information (read-only)',
      false,
      async (ctx) => {
        const studentId = ctx.all.studentId;
        if (!studentId) {
          console.log('[AAC] Context_MedicalInfo: No studentId in context');
          return null;
        }
        console.log('[AAC] Loading Context_MedicalInfo for student:', studentId);
        return loadMedicalInfo(studentId);
      }
    ),
    createReadOnlyObjectField(
      'Context_FunctionalInfo',
      'Functional Assessment',
      'Functional assessment reports (read-only)',
      false,
      async (ctx) => {
        const studentId = ctx.all.studentId;
        if (!studentId) {
          console.log('[AAC] Context_FunctionalInfo: No studentId in context');
          return null;
        }
        console.log('[AAC] Loading Context_FunctionalInfo for student:', studentId);
        return loadFunctionalInfo(studentId);
      }
    ),
    createReadOnlyObjectField(
      'Context_EducationalInfo',
      'Educational Information',
      'Educational reports and accommodations (read-only)',
      false,
      async (ctx) => {
        const studentId = ctx.all.studentId;
        if (!studentId) {
          console.log('[AAC] Context_EducationalInfo: No studentId in context');
          return null;
        }
        console.log('[AAC] Loading Context_EducationalInfo for student:', studentId);
        return loadEducationalInfo(studentId);
      }
    ),
    createReadOnlyObjectField(
      'Context_Progress',
      'Program & Goals',
      'Current IEP/program goals and progress (read-only)',
      true,
      async (ctx) => {
        const studentId = ctx.all.studentId;
        if (!studentId) {
          console.log('[AAC] Context_Progress: No studentId in context');
          return null;
        }
        console.log('[AAC] Loading Context_Progress for student:', studentId);
        return loadProgressInfo(studentId);
      }
    ),
  ];
}