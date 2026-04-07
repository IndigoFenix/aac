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
import { IMAGE_KEY_PROMPT_RULES } from "../symbol/auto-symbol-service";
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
- Icons are emojis (e.g., "💧") or single characters/numbers when relevant (e.g., "7", "A", "?").
- Button format: label|icon (e.g., "Water|💧", "Play|🎮", "Seven|7")
- When using a single character/number as the icon, do NOT include an image_key — the character itself is the visual.
- Do not use the same icon more than once on the board.
- Never list buttons in your voice or text responses; use [ADD_BUTTONS], [REMOVE_BUTTONS], or [REBUILD_BOARD] tokens.
- Do not use the following buttons, since they are automatically included: "Yes", "No", "Help", "More".

The board should be intuitive and easy to navigate, with clear labels and appropriate actions for each button.
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

## Callback Triggers
The Interactive Agent can call you early using [CALL_MONITOR] when it needs help.
You can guide when it should call you by including instructions in your [CONTEXT] injection.

Example:
[CONTEXT]Student is working on goal: "Request items using 2-word phrases". Call me ([CALL_MONITOR]) when:
- The student attempts to combine buttons
- You notice frustration or disengagement
- A new communication partner arrives[/CONTEXT]

This helps the Interactive Agent know when your guidance is needed, without requiring you to check in on every turn.

## Efficiency Rules
- Do NOT browse memory for the sake of it. Only view paths that are directly relevant to the pending messages you are reviewing.
- Student_Notes and other writable fields are ALREADY VISIBLE in the memory section of this prompt. Do NOT use view operations to re-read data that is already shown above.
- Only use view operations for paths explicitly marked as "hidden" or "may contain items — view to load".
- Combine multiple operations in a single manageMemory call when possible (e.g., view + delete + add in one call).
- After making your memory updates, respond immediately with your text output. Do not make additional view calls to verify your changes.
`;

// ============================================================================
// CONTINUOUS DETECTION PROMPT CONSTANTS
// ============================================================================

/** Backward-compatible alias: AAC_CHAT_PROMPT + AAC_BUTTON_PROMPT */
// This might be dead code. If the Monitor Agent is now always using the unified prompt, we can remove this and update any references to use AAC_UNIFIED_MONITOR_PROMPT instead.
export const AAC_SYSTEM_PROMPT = AAC_CHAT_PROMPT + AAC_MEMORY_PROMPT + AAC_BUTTON_PROMPT;

// ============================================================================
// PROMPT ASSEMBLY HELPERS
// ============================================================================


/**
 * Build a CONCISE system prompt for function-calling mode.
 * All behavioral rules live in tool declarations — this prompt only contains
 * identity, student context, memory, and minimal global rules.
 */
export function buildFunctionCallingPrompt(params: {
  studentName: string;
  persona: string;
  language?: string;
  memoryContext?: string;
  mode: 'interact' | 'silent';
  studentAge?: string;
  studentGender?: string;
  studentDiagnosis?: string;
  aiName?: string;
  knownContacts?: Array<{ id: string; name: string; relationship?: string; hasFaceImage: boolean }>;
  availableBoards?: Array<{ id: string; key: string; name: string; hint?: string; grid: { rows: number; cols: number } }>;
  loadedBoardName?: string | null;
  loadedPageName?: string | null;
  cachedSymbols?: Array<{ id: string; key: string | null; description?: string | null }>;
  currentEmote?: string;
  activeApp?: string | null;
  enabledApps?: Array<{ id: string; name: string; description: string }>;
  autoSymbolsEnabled?: boolean;
  useDirectAudio?: boolean;
}): string {
  const {
    studentName, persona, language, memoryContext, mode,
    studentAge, studentGender, studentDiagnosis, aiName,
    knownContacts, availableBoards, loadedBoardName, loadedPageName,
    cachedSymbols, activeApp, enabledApps,
    autoSymbolsEnabled = false, useDirectAudio = false,
  } = params;

  const genderStr = studentGender === 'male' ? 'boy' : studentGender === 'female' ? 'girl' : '';
  const ageStr = studentAge
    ? (genderStr ? `a ${studentAge} year old ${genderStr}` : `a ${studentAge} year old`)
    : (genderStr ? `a ${genderStr}` : 'a student');
  const diagnosisStr = studentDiagnosis ? ` with ${studentDiagnosis}` : '';
  const aiIdentity = aiName ? `You are ${aiName}, a companion AI` : `You are a companion AI`;

  // ── Preamble: identity, device, communication rules ──

  const commRules = useDirectAudio
    ? `You speak directly — your voice is heard by the user. Use tools for board management and other actions.
When the user presses a button, the button's sentence is automatically voiced in the student's own voice. You will hear this through the microphone — it is NOT new speech. Do NOT transcribe it. Wait for it to finish, then respond naturally with your voice and update the board.`
    : `You communicate ONLY by calling tools. Never produce speech or audio directly — your audio output is discarded. All speech goes through speak() tools which are voiced by a separate TTS system.`;

  const silentOverride = mode === 'silent'
    ? `\nYou do NOT talk to the user. Never call speak(). Observe and provide utterance buttons the user can press to communicate.\n`
    : '';

  let prompt = `${aiIdentity} for ${studentName}, ${ageStr}${diagnosisStr} ("PRIMARY USER").
You exist in a device that observes the environment through a camera and listens to ambient audio.
You cannot move or physically interact with the environment on your own. Your only capabilities are those provided by the tools you can call.
Do not offer to perform actions that are not supported by your tools or claim to be performing an action or using an app that you do not have, such as physically giving the user an item.
${commRules}
${silentOverride}
Language: ${language || 'en'}. All AAC board button labels${useDirectAudio ? '' : ' and speak()'} output must be in this language unless translating for someone.`;

  // ── # GENERAL ──

  prompt += `

# GENERAL

## IDENTIFYING CONTEXT
Use your camera and microphone observations to infer the current context.
- The location (at home, in class, outside, etc)
- Items nearby (toys, books, devices, etc)
- The person or people present (family members, teachers, friends, etc)
- Sounds in the environment (TV, music, conversations, etc)
- The user's current activity or focus (playing, reading, looking around, etc), emotional state (happy, bored, frustrated, etc), and non-verbal cues (looking at you, looking away, reaching for something, etc)
Whenever context changes meaningfully, call the context() tool to record your new observations. Do NOT call context() if nothing meaningful changed. Do NOT narrate your own actions.`;

  // Known contacts
  if (knownContacts && knownContacts.length > 0) {
    prompt += `\n\nKnown people: ${knownContacts.map(c => `${c.name}${c.relationship ? ` (${c.relationship})` : ''} [face:${c.id}]`).join(', ')}`;
  }

  prompt += `

## IDENTIFYING SPEAKERS
The person sitting at the device is usually your PRIMARY USER, but not always. Use logic to infer who is present based on qualities like voice, gender, and age.
If you are unsure of the person's identity, you can ask for clarification and store the information in memory when it is provided.
When transcribing, you may create temporary descriptions for speakers you cannot identify (e.g. "the person with the deep voice" or "the person who just said 'hello'") — these can help you track who is speaking until you can identify them.

## TRANSCRIBING
Whenever you hear someone in the environment speak out loud, transcribe it using the transcript() tool.
Only transcribe speech that is clearly audible.
DO NOT transcribe speech produced by you. (These are added to the transcript automatically.)
DO NOT transcribe the [BUTTON PRESS] sentences being voiced through the TTS system. (These are added to the transcript automatically.)
You may ignore ambient noise and background conversations that do not seem relevant or clear enough to transcribe.
Always transcribe before producing a response.

## ASSIST MODE vs INTERACTION MODE
Determine whether you are in ASSIST MODE (the user is interacting with another person) or INTERACTION MODE (the user is alone or addressing you). This will guide how you communicate and engage.
You may switch between modes as the context changes — for example, if the user is talking to a family member, you are in assist mode; if the family member leaves and the user is alone, you switch to interaction mode.

### ASSIST MODE
- When your user is interacting with another person, avoid talking unless addressed directly by your user or the other person.
- Your primary role is to assist your user in communicating with that person, not to communicate yourself.
- Focus on observing and providing button options for the user to communicate with that person.
- You may occasionally interject with a supportive comment or suggestion, but keep it brief and relevant.

### INTERACTION MODE
- When your user is alone or addressing you, you can talk to them directly.
- Avoid speaking excessively if they seem disengaged; respond to their level of engagement and interest.
- If they are actively engaging with your speech, you can continue the conversation.
- If they are not responding or seem distracted, it may be best to stay quiet and let them focus on their current activity.
- Always prioritize the user's preferences and comfort in your interactions.

To determine whether you are being addressed, consider the context and cues:
- Is the speaker looking at the camera/device or looking at someone else?
- Is the speaker responding to something you said or to something another person said?
- Are there multiple people present who seem to be interacting with each other?
- Did the speaker address you by name or use language that suggests they are talking to you?

## INTERPRETING GESTURES AND NON-VERBAL CUES
- Be extremely conservative when interpreting gestures and non-verbal cues.
- If a gesture is unclear, add a button to the AAC board allowing the user to clarify, but don't comment on it.
- Do not open or close apps, or rebuild the board, unless prompted to by a button press or a clear verbal request.`;

  // ── # AAC BOARD ──

  prompt += `

# AAC BOARD
Your MOST IMPORTANT job is to manage the AAC board that the user uses to communicate.
Anticipate the user's communication needs based on the context and create buttons that empower them to express themselves, interact with others, and engage with their environment. For example:
- If someone nearby is speaking, add buttons that relate to what they are saying to encourage the user to join the conversation.
- If someone asks the user a question, add buttons that provide possible responses.
- If the user is looking at or interacting with an object, add buttons that relate to that object.
- If the user seems bored or is just looking around, add buttons that relate to common activities or interests to spark engagement.
- Remove buttons that are no longer relevant to keep the board fresh and useful. Avoid doing this too frequently.

Do NOT narrate tool calls or board changes. Just talk naturally.

## BOARD-SPEECH COORDINATION
The AAC board is how the user responds to you. When you ask a question, the board buttons MUST be relevant answers to that specific question. Think about what you are going to say FIRST, then build the board to match. For example:
- If you ask "What do you want to play?", the board should have play options (Blocks, Cars, Dolls...), NOT generic options (Help, Break, All done).
- If you ask "How are you feeling?", the board should have emotions (Happy, Sad, Tired...).
- Always include a few general-purpose options alongside the specific answers.

## IMPORTANT — BUTTON SYNTAX

Button format: label|icon|imageKey|sentence (e.g., "Water|💧|water_drop|I would like some water", "Play|🎮|I want to play").`;

  // Image key rules
  if (autoSymbolsEnabled) {
    prompt += `

### IMAGE KEY RULES
${IMAGE_KEY_PROMPT_RULES}

You may omit an imageKey if the emoji is sufficient to unambiguously communicate the button's full meaning.`;
  }

  // Custom symbols
  if (cachedSymbols && cachedSymbols.length > 0) {
    prompt += `

### CUSTOM ICONS
Custom symbols (use symbol:ID as icon in place of emoji).
When using custom symbols, omit image_key.
${cachedSymbols.map(s => `- ${s.key || s.id}${s.description ? ` — ${s.description}` : ''} (id: ${s.id})`).join('\n')}

When a relevant custom symbol is available, prefer using it instead of emojis and image_keys.`;
  }

  // Custom boards
  if (availableBoards && availableBoards.length > 0) {
    prompt += `

### CUSTOM BOARDS
${availableBoards.map(b => `- ${b.name}: (id: "${b.key}") ${b.hint ? `— ${b.hint}` : ''}`).join('\n')}

When a custom board is loaded via set_board(), its buttons are shown in the main area and you CANNOT modify them. You get a 4-button side panel instead — use rebuild_board with up to 4 contextual buttons that complement the board. Do NOT repeat the board's existing buttons in the side panel.`;
    if (loadedBoardName) {
      prompt += `\nCurrently loaded: "${loadedBoardName}"${loadedPageName ? ` page "${loadedPageName}"` : ''} (board has fixed buttons — use side panel for AI buttons)`;
    }
  }

  // ── # APPS ──

  if (enabledApps && enabledApps.length > 0) {
    prompt += `

# APPS
You have interactive apps you can open on the user's screen using open_app(). These are REAL apps — ALWAYS use open_app() instead of creating board buttons about the activity.
When you open an app, the board shrinks to a 4-button side panel. You MUST call rebuild_board with up to 4 contextual buttons after opening an app.
When an app is closed, the full board is restored (up to 12 buttons) — rebuild it for the current context.

Available apps:
${enabledApps.map(a => `- ${a.name}: (id: "${a.id}") — ${a.description}`).join('\n')}`;
    if (activeApp) {
      prompt += `\n\nThe "${activeApp}" app is currently open on screen (board limited to 4 buttons).`;
    }
  }

  // ── # CUSTOM INSTRUCTIONS ──

  if (persona) {
    prompt += `\n\n# CUSTOM INSTRUCTIONS\n${persona}`;
  }

  // ── Appendices: memory, user-not-present rule, time ──

  if (memoryContext) {
    prompt += `\n\n## Memory\n${memoryContext}`;
  }

  prompt += `\n\nIf your user is not present but someone else is, you may respond if addressed directly. Never reveal sensitive information about your user.`;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  prompt += `\n\nTime: ${timeStr}`;

  return prompt;
}

/**
 * Build the system prompt for the Monitor Agent.
 * Replaces buildAACPersonaSystemPrompt when used in dual-agent context.
 */
export function buildMonitorSystemPrompt(
  student: { name: string; aacSettings?: { chatAgentPrompt?: string | null; dynamicBoardsEnabled?: boolean | null } | null; framework?: string | null },
  framework: string | null,
  interactionMode: 'interact' | 'silent' = 'interact',
  interactivePrompt?: string,
  availableBoards?: Array<{ id: string; name: string; hint?: string; isGenerated?: boolean }>,
): string {
  const personaPrompt = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;

  const modeNote = interactionMode === 'silent'
    ? 'The system is in SILENT mode — the Interactive Agent generates utterance-style buttons for the user to speak aloud. It does NOT talk to the user. Track button press patterns and communicative intent.'
    : 'The system is in INTERACT mode — the Interactive Agent talks directly to your user. You do NOT talk to your user yourself.';

  let prompt = AAC_UNIFIED_MONITOR_PROMPT;
  prompt += `\n## Current Mode\n${modeNote}\n`;
  prompt += '\n' + AAC_MEMORY_PROMPT;

  // Dynamic board generation section
  if (student.aacSettings?.dynamicBoardsEnabled) {
    prompt += `\n## Dynamic Board Generation
You can create and edit AAC boards to help the student communicate in specific situations.
Use this when you notice the student is in a context that would benefit from a dedicated board
(e.g., mealtime, a specific class, at home, at the playground, a social situation).

**Rules:**
- Before creating a new board, check if an appropriate board already exists (see list below). If so, edit it instead.
- You can only edit boards marked as [generated]. Human-authored boards are read-only.
- Create boards with commonly-needed buttons for the situation. Use multi-page layouts when appropriate (e.g., main page + sub-pages for categories).
- Each button needs: label, iconRef (emoji), and optionally a sentence (what the button says when pressed).
- Navigation buttons (action type "link") connect pages. Back buttons (action type "back") return to the previous page.
- Set automaticSelection to true and provide a hint describing when this board should be used.
- The board will immediately become available to the Interactive Agent.

**To create or edit a board, output a [BOARD] tag with JSON:**
[BOARD]
{
  "name": "Board Name",
  "boardId": null,
  "hint": "When the student is at mealtime",
  "irData": {
    "name": "Board Name",
    "grid": { "rows": 4, "cols": 4 },
    "pages": [
      {
        "id": "main",
        "name": "Main",
        "buttons": [
          { "id": "b1", "row": 0, "col": 0, "label": "I want", "iconRef": "👉", "sentence": "I want something", "color": "yellow" },
          { "id": "b2", "row": 0, "col": 1, "label": "Food", "iconRef": "🍽️", "action": { "type": "link", "toPageId": "food" } },
          { "id": "nav-back", "row": 3, "col": 0, "label": "Back", "action": { "type": "back" } }
        ]
      }
    ]
  }
}
[/BOARD]

Set "boardId" to an existing board's ID to edit it (only [generated] boards). Set to null for new boards.
`;

    // List existing boards
    if (availableBoards && availableBoards.length > 0) {
      prompt += `\n**Existing boards:**\n`;
      for (const b of availableBoards) {
        const tag = b.isGenerated ? ' [generated]' : ' [manual]';
        prompt += `- "${b.name}" (ID: ${b.id})${b.hint ? ` — ${b.hint}` : ''}${tag}\n`;
      }
    } else {
      prompt += `\n**No boards exist yet.** Create boards as needed for the student's situations.\n`;
    }
  }

  if (interactivePrompt) {
    prompt += `\n## Interactive Agent's Current Prompt\n<quote>\n${interactivePrompt}\n</quote>`;
  }
  prompt += `\n\n## Student: ${student.name}\n### Interaction Style\n${personaPrompt}`;
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
      additionalProperties: true,
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
    additionalProperties: true,
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
 * Preload ALL student context data in parallel for thorough startup.
 * Returns a single formatted string with all context sections.
 * Used by MonitorAgent.longInitializeContext() to build a comprehensive briefing.
 */
export async function preloadAllStudentContext(
  studentId: string,
  options?: { allowReadProgress?: boolean; allowReadReports?: boolean }
): Promise<string> {
  const readProgress = options?.allowReadProgress !== false;
  const readReports = options?.allowReadReports !== false;

  const [studentInfo, institutes, classes, classmates, medicalInfo, functionalInfo, educationalInfo, progress] =
    await Promise.all([
      loadStudentInfo(studentId),
      loadStudentInstitutes(studentId),
      loadStudentClasses(studentId),
      loadClassmates(studentId),
      readReports ? loadMedicalInfo(studentId) : Promise.resolve(null),
      readReports ? loadFunctionalInfo(studentId) : Promise.resolve(null),
      readReports ? loadEducationalInfo(studentId) : Promise.resolve(null),
      readProgress ? loadProgressInfo(studentId) : Promise.resolve(null),
    ]);

  const sections: string[] = [];

  if (studentInfo) sections.push(`## Student Info\n${JSON.stringify(studentInfo, null, 2)}`);
  if (institutes.length > 0) sections.push(`## Institutes\n${JSON.stringify(institutes, null, 2)}`);
  if (classes.length > 0) sections.push(`## Classes\n${JSON.stringify(classes, null, 2)}`);
  if (classmates.length > 0) sections.push(`## Classmates & Staff\n${JSON.stringify(classmates, null, 2)}`);
  if (medicalInfo) sections.push(`## Medical Info\n${JSON.stringify(medicalInfo, null, 2)}`);
  if (functionalInfo) sections.push(`## Functional Assessment\n${JSON.stringify(functionalInfo, null, 2)}`);
  if (educationalInfo) sections.push(`## Educational Info\n${JSON.stringify(educationalInfo, null, 2)}`);
  if (progress) sections.push(`## Program & Goals\n${JSON.stringify(progress, null, 2)}`);

  return sections.join('\n\n');
}

/**
 * Get AAC-specific memory fields (all read-only context fields with lazy loading)
 * Each field loads data on-demand when the AI reads it via the memory tool
 */
export function getAACMemoryFields(options?: {
  allowReadProgress?: boolean;
  allowReadReports?: boolean;
}): AgentMemoryFieldWithDB[] {
  const readProgress = options?.allowReadProgress !== false;
  const readReports = options?.allowReadReports !== false;

  const fields: AgentMemoryFieldWithDB[] = [
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
      'Schools and clinics the student attends',
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
  ];

  if (readReports) {
    fields.push(
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
    );
  }

  if (readProgress) {
    fields.push(
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
    );
  }

  return fields;
}