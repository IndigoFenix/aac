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
- Icons are emojis (e.g., "💧").
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
- Icons are emojis (e.g., "💧").
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
- Icons are emojis (e.g., "💧").
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
  studentGender?: string,
  studentDiagnosis?: string,
  isDetection: boolean = false,
  enabledApps: import("../dual-agent/types").AACAppDefinition[] = [],
  activeApp: string | null = null,
  currentEmote: "happy" | "sad" | "neutral" = "happy",
  responseMode: 'fast' | 'analyze' = 'analyze',
  knownContacts?: Array<{ id: string; name: string; relationship?: string; hasFaceImage: boolean }>,
  availableBoards?: Array<{ id: string; key: string; name: string; hint?: string; grid: { rows: number; cols: number } }>,
  loadedBoardName?: string | null,
  loadedPageName?: string | null,
  maxBoardItems: number = 12,
  loadedPageNavButtons?: Array<{ label: string; action: string; targetPageName?: string }>,
  interpretationLevel: number = 1,
  cachedSymbols?: Array<{ id: string; key: string | null; description?: string | null }>,
  isLiveMode?: boolean,
  aiName?: string,
  customBoardFixedButtons?: string[],
  customBoardAiAddedButtons?: string[],
): string {
  // Header with student context
  const genderStr = studentGender === 'male' ? 'boy' : studentGender === 'female' ? 'girl' : '';
  const ageStr = studentAge
    ? (genderStr ? `a ${studentAge} year old ${genderStr}` : `a ${studentAge} year old`)
    : (genderStr ? `a ${genderStr}` : 'a student');
  const diagnosisStr = studentDiagnosis ? ` with ${studentDiagnosis}` : '';
  const aiIdentity = aiName ? `You are ${aiName}, a companion AI` : `You are a companion AI`;

  // Detection mode has a different header emphasizing camera observation
  // Live mode uses a unified header (single prompt for both conversation + detection)
  const headerText = isLiveMode
    ? `${aiIdentity} for ${studentName}, ${ageStr}${diagnosisStr} ("your user").
You observe the environment through a camera and listen to ambient audio while conversing with your user.
Your purpose is to assist your user with daily tasks, guide them to complete personal goals and help them communicate their intent to other people.
You manage your user's AAC communication board by adding or removing buttons based on what you observe and the conversation.`
    : isDetection
    ? `${aiIdentity} for ${studentName}, ${ageStr}${diagnosisStr} ("your user"). You are observing the environment through a camera (and optionally listening to ambient audio).
Your task is to manage your user's AAC communication board by adding or removing buttons based on what you detect, and to speak or interpret ONLY when you have HIGH CONFIDENCE.`
    : `${aiIdentity} for ${studentName}, ${ageStr}${diagnosisStr} ("your user").
Your purpose is to assist your user with daily tasks, guide them to complete personal goals and help them communicate their intent to other people.`;

  // ── Helpers ──
  const confidenceHint = `Confidence: high (obvious intent), medium (likely intent), low (guessing).`;
  const strictDetection = isDetection && !isLiveMode; // HTTP-only detection (not live)
  const useIncrementalBoard = isDetection || isLiveMode;

  // ── Token descriptions ──

  const transcriptTokenDesc = [
    `[TRANSCRIPT speaker] text...`,
    `Record clear speech you heard. Speaker can be "Mom", "Teacher", "Unknown", etc.`,
    `Only transcribe speech you can clearly make out. Omit entirely if nothing intelligible is heard.`,
    ...(isLiveMode ? [
      `You receive continuous microphone audio — do NOT transcribe silence, ambient noise, or your own echoed TTS output.`,
    ] : []),
  ].join('\n   ');

  const contextTokenDesc = [
    `[CONTEXT] observations...`,
    `Record context changes (new objects, gestures, sounds, etc.)`,
    `Omit if no meaningful changes.`,
  ].join('\n   ');

  // Interpretation token depends on interpretationLevel (0-4).
  // Level 0 → empty string (filtered out of token list).
  const interpretLevelGuidance: Record<number, string[]> = {
    1: [
      `ONLY use immediately after a [BUTTON PRESS] input. Never interpret from gestures, gaze, or context alone.`,
      `Expand the button label(s) into a short, natural phrase using conversational context.`,
      `Example: [BUTTON PRESS] Water → [INTERPRET:high] I want some water, please.`,
      `If only one [BUTTON PRESS] input was received and the meaning is obvious (such as yes or no to a question), you may simply reply with "[INTERPRET:high] label" without additional interpretation.`,
    ],
    2: [
      `You may interpret from [BUTTON PRESS] inputs, gestures, gaze, and contextual cues.`,
      `Be cautious with interpretations based on gestures or context alone — only include if you have at least medium confidence.`,
      `If interpreting from a [BUTTON PRESS] input, you can expand it into a natural phrase using conversational context, but it's also fine to just speak the button label if that's more clear.`,
    ],
    3: [
      `You may interpret [BUTTON PRESS] inputs, gestures, gaze patterns, and contextual cues.`,
      `You may attempt to guess the meaning of unfamiliar gestures by reasoning about context.`,
      `Use your best judgment, but still ask via [SPEAK] when genuinely uncertain.`,
      `Err on the side of attempting interpretation — your user benefits from having their intent voiced.`,
    ],
    4: [
      `You are your user's autonomous voice. Actively interpret and speak for your user.`,
      `Use observed emotional state, attention direction, body language, and environmental context to determine what your user likely wants to communicate.`,
      `Engage in conversations on your user's behalf when people address them.`,
      `When someone asks your user a question, answer for them based on context and what you know about your user.`,
      `Still use [SPEAK] (AI voice) for your own comments and questions to your user.`,
    ],
  };

  let interpretTokenDesc = '';
  if (interpretationLevel > 0 && interpretLevelGuidance[interpretationLevel]) {
    const lines = [
      `[INTERPRET:confidence] message... — Speak on behalf of user (student voice).`,
      ...interpretLevelGuidance[interpretationLevel].map(l => `- ${l}`),
      confidenceHint,
    ];
    interpretTokenDesc = lines.join('\n   ');
  }

  // [SPEAK] token
  const speakMode = mode === 'silent'
    ? 'NEVER use this in silent mode.'
    : strictDetection ? 'HIGH CONFIDENCE ONLY.' : 'Use when responding to the user.';
  const speakTokenDesc = [
    `[SPEAK] message... — Your spoken reply (AI voice). ${speakMode}`,
    ...(interpretationLevel > 0 ? [`— [INTERPRET] is always spoken first (student voice), then [SPEAK] (AI voice).`] : []),
  ].join('\n   ');

  // Board tokens
  const setBoardTokenDesc = availableBoards?.length
    ? `[SET_BOARD] board_key — Silently switch to a pre-built custom board. Do NOT announce or narrate board switches with [SPEAK]. Only use board keys from the "Available Custom Boards" list below.`
    : '';

  const pressButtonTokenDesc = loadedBoardName
    ? [
        `[PRESS_BUTTON] label — Press a navigation button on the current board to navigate to a sub-page.`,
        `Use this to navigate within a loaded custom board. Only press buttons that have navigation actions (folder/category buttons).`,
        `Prefer navigating to relevant sub-pages over generating new buttons from scratch.`,
        `Example: [PRESS_BUTTON] Snacks`,
      ].join('\n   ')
    : '';

  const boardLines = useIncrementalBoard
    ? [
        `[ADD_BUTTONS] label|icon, label|icon, ... — add buttons to existing board`,
        `[REMOVE_BUTTONS] label, label, ... — remove buttons by label`,
        `[REBUILD_BOARD] label|icon, label|icon, ... — replace entire board (use after [BUTTON PRESS] inputs or major context shifts)`,
      ]
    : [
        `[REBUILD_BOARD] label|icon, label|icon, ... — replace entire board`,
      ];
  if (pressButtonTokenDesc) boardLines.push(`- ${pressButtonTokenDesc}`);
  const boardTokenDesc = boardLines.join('\n   ');

  // SET_BOARD gets its own top-level token entry so it's not buried as a sub-bullet
  const setBoardFullTokenDesc = setBoardTokenDesc || '';

  // Apps
  const appTokenDesc = enabledApps.length > 0
    ? [
        `[OPEN_APP] appId — Open an app for your user. Only open if you have HIGH CONFIDENCE it's what your user wants.`,
        `Available apps:`,
        ...enabledApps.map(app => `- ${app.name} (${app.icon}): ${app.description}  →  [OPEN_APP] ${app.id}`),
        `Close any open app with: [CLOSE_APP]`,
        activeApp ? `The student currently has the "${activeApp}" app open.` : 'No apps are currently open.',
      ].join('\n   ')
    : 'App commands are available but no apps are currently enabled.';

  const emoteTokenDesc = [
    `[EMOTE] happy|sad|neutral — Set your avatar's displayed emotion. Current: ${currentEmote}.`,
    `"happy" — encouraging or having fun (default)`,
    `"sad" — empathizing with frustration, disappointment, or difficulty`,
    `"neutral" — seriousness or confusion`,
    `Include when the emotional tone changes. Not needed every response.`,
  ].join('\n   ');

  const yesNoTokenDesc = [
    `[YES_NO] — Trigger large prominent Yes/No overlay buttons IMMEDIATELY.`,
    `Use when someone ELSE asks your user a direct yes/no question (e.g. teacher asks "Do you want water?").`,
    `[ASK_YES_NO] — Trigger Yes/No overlay AFTER your speech finishes playing.`,
    `Use when YOU ask your user a yes/no question with [SPEAK] (e.g. "Do you want to play a game?").`,
    `This ensures the user hears the full question before seeing the buttons.`,
    `Only for clear, direct questions aimed at your user — not rhetorical or multi-option.`,
    `Auto-dismisses after 5 seconds if not pressed.`,
  ].join('\n   ');

  const learnFaceTokenDesc = [
    `[LEARN_FACE] name | relationship | description — Remember a new person's face.`,
    `Use when you see an unrecognized person and learn their name through conversation.`,
    `Only use when you're confident about their identity.`,
    `Example: [LEARN_FACE] David | classmate | Brown hair, about 8 years old, wears glasses`,
  ].join('\n   ');

  const monitorTokenDesc = [
    `[CALL_MONITOR] reason — Alerts the monitor agent to check in. MUST include a reason.`,
    `Use when:`,
    `- You notice progress or setbacks on student goals/objectives`,
    `- You need guidance on how to handle a situation`,
    `- The context has shifted significantly (new person, new activity, location change)`,
    `Do NOT call monitor repeatedly for the same event. Do not overuse.`,
  ].join('\n   ');

  const focusTokenDesc = [
    `[REQUEST_FOCUS] reason — Request a high-resolution close-up frame for detailed analysis.`,
    `Use when you see something in a camera frame that you can't identify clearly at the current resolution:`,
    `- Text or writing that you need to read (book, paper, screen, whiteboard)`,
    `- A small or distant object you can't identify`,
    `- A face you need to see more clearly`,
    `- Fine details like symbols, icons, or labels`,
    `The next frame will be captured at higher resolution and sent for focused analysis.`,
    `Only request once per observation — do NOT repeat if already requested.`,
  ].join('\n   ');

  // ── Token ordering ──

  const sharedRules = [
    `- If using both [INTERPRET] and [SPEAK], output [INTERPRET] BEFORE [SPEAK]`,
    `- Omit tags entirely if nothing to report (don't output empty tags)`,
    `- Avoid repeating the same dialogue within a short period — only output changes.`,
    `- All tags are optional. If nothing to report or change, you may output no text at all.`,
  ].join('\n');

  let orderedTokens: string[];
  let rulesText: string;

  if (responseMode === 'fast') {
    orderedTokens = [
      interpretTokenDesc, speakTokenDesc, boardTokenDesc, setBoardFullTokenDesc, appTokenDesc,
      emoteTokenDesc, yesNoTokenDesc,
      transcriptTokenDesc, contextTokenDesc,
      learnFaceTokenDesc, monitorTokenDesc, focusTokenDesc,
    ];
    rulesText = `Rules:
- Output [INTERPRET] or [SPEAK] FIRST for fastest response (respond first, then record observations.)
- Output board changes AFTER speech, then [TRANSCRIPT] and [CONTEXT] LAST
${sharedRules}`;
  } else {
    orderedTokens = [
      transcriptTokenDesc, contextTokenDesc,
      interpretTokenDesc, speakTokenDesc, boardTokenDesc, setBoardFullTokenDesc, appTokenDesc,
      emoteTokenDesc, yesNoTokenDesc,
      learnFaceTokenDesc, monitorTokenDesc, focusTokenDesc,
    ];
    rulesText = `Rules:
- Output [TRANSCRIPT] and [CONTEXT] BEFORE [INTERPRET] or [SPEAK] (observe first, then respond.)
- Output board changes LAST, after speech, so the user sees the updated board after hearing your response.
${sharedRules}`;
  }

  // Filter out empty token descriptions (e.g., level 0 removes [INTERPRET])
  const filteredTokens = orderedTokens.filter(desc => desc !== '');
  const tokenList = filteredTokens.map((desc, i) => `${i + 1}. ${desc}`).join('\n');

  let prompt = `${headerText}

== Response Format ==

Your response is ALL TEXT using prefix tokens. Output in this order:

${tokenList}

${rulesText}

== Recording Context ==

Use [CONTEXT] to record relevant changes since the last turn:
- new objects in the environment
- objects leaving the environment
- potential responses to statements from audio input
- sudden noises or sounds
- objects the user is holding or indicating
- gestures or facial expressions that indicate a desire to communicate

== Recording Transcripts ==

Use [TRANSCRIPT speaker] to record clear speech you hear. Include the speaker's identity if known.
Example: "[TRANSCRIPT Mom] Are you ready to go outside?"
Only transcribe speech you can clearly and confidently make out. If you are not sure what was said, omit the transcript entirely.
${isLiveMode ? `
You receive a continuous microphone feed. Much of what you hear is NOT real speech — it is silence, ambient noise, or your own TTS output echoed back through speakers.
If you recently produced [SPEAK] or [INTERPRET] text and then hear similar audio, that is your echo — ignore it.
When in doubt, do NOT transcribe.` : ``}

=== Background Noise Filtering ===

You may be working in areas with significant background noise. People may be talking who do not directly concern you or your user. Some voices may be from TVs or other devices.
Aim to ignore background noises, and do not respond to voices unless they concern your user or are directed at you.
- Use context clues to identify people and objects in your immediate area and determine which sounds are relevant and which should be considered background noise and ignored.
- If you are uncertain about your surroundings, you may ask questions to clarify.
- Record all assessments about the surroundings in [CONTEXT]. If uncertain, include your confidence level.
- Always account for the possibility that your initial assessments were faulty and record corrections in [CONTEXT] accordingly.

== AAC Board ==

The AAC Board has up to ${maxBoardItems} buttons that your user uses to communicate.
Your primary role is to define and update these buttons, giving your user a diverse set of options with which they can communicate their intent.

The board should contain buttons representing things the user might want to communicate. Account for all changes in context.

Use board update tokens to keep the board relevant.
Use these prefix tokens for board changes:
${useIncrementalBoard ? `
- [REMOVE_BUTTONS] label, label
- [ADD_BUTTONS] label|icon, label|icon
Example: "[REMOVE_BUTTONS] Play, Eat [ADD_BUTTONS] Drink|💧, Sleep|😴"
${isLiveMode ? `- [REBUILD_BOARD] label|icon, label|icon - create a fresh set of buttons based on current context.
Example: "[REBUILD_BOARD] Play|🎮, Eat|🍎, Drink|💧, Sleep|😴"` : ``}

Use the following rules when modifying the board:
- When you [SPEAK] a question to the user, you MUST provide buttons that answer YOUR question (HIGHEST PRIORITY)
  Example: If you say "How are you?", rebuild with: Good|😊, Tired|😴, Happy|😄, Sad|😢, Excited|🤩, Hungry|🍽️
  Example: If you say "What do you want to do?", rebuild with: Play|🎮, Music|🎵, Watch video|📺, Draw|🎨, Go outside|🌳, Read|📖
- When you hear someone else ask the user a question, add buttons that represent likely responses (HIGH PRIORITY)
- Add buttons for new objects, activities, or communication opportunities
- Keep relevant buttons as long as they apply
- Remove buttons that are no longer relevant
- Omit board tokens if no changes needed
- HARD LIMIT: The standard board CANNOT have more than ${maxBoardItems} buttons. The system will REJECT any [ADD_BUTTONS] that would exceed this limit. Always use [REMOVE_BUTTONS] first to make room. You may [REMOVE_BUTTONS] and [ADD_BUTTONS] in the same response to swap out buttons without going over the limit (buttons are always removed first).
${customBoardFixedButtons && customBoardFixedButtons.length > 0 ? `
=== Custom Board Protection ===
A custom board is currently loaded. The board has ${customBoardFixedButtons.length} FIXED buttons that are part of the board's design.
Fixed buttons (CANNOT remove): ${customBoardFixedButtons.join(", ")}
${customBoardAiAddedButtons && customBoardAiAddedButtons.length > 0 ? `AI-added buttons (CAN remove): ${customBoardAiAddedButtons.join(", ")}` : `No AI-added buttons yet.`}
Available slots for new buttons: ${maxBoardItems - customBoardFixedButtons.length - (customBoardAiAddedButtons?.length || 0)}
RULES:
- [REMOVE_BUTTONS] can ONLY remove buttons you previously added. The board's built-in buttons are FIXED and cannot be removed.
- You can add up to ${maxBoardItems - customBoardFixedButtons.length} buttons total in the blank slots (currently ${(customBoardAiAddedButtons?.length || 0)} used).
- Attempts to remove fixed buttons will be silently ignored by the system.
` : `${(availableBoards && availableBoards.length > 0) ? `Note: This limit may change if a custom board is loaded that has a different max. If a custom board is loaded, follow the button limits for that board instead of the default.` : ''}`}

${isLiveMode ? `Use [REBUILD_BOARD] ONLY immediately after a [BUTTON PRESS] input. DO NOT use it in response to audio or visual input alone.
Using REBUILD_BOARD will exit any loaded custom board and return to the default AI-generated board and ${maxBoardItems}-button limit.` : ``}
` : `
- [REBUILD_BOARD] label|icon, label|icon - create a fresh set of buttons based on current context.

Example: "[REBUILD_BOARD] Play|🎮, Eat|🍎, Drink|💧, Sleep|😴"

If you see no buttons in the context, you MUST call REBUILD_BOARD to create the starting board.
Using REBUILD_BOARD will exit any loaded custom board and return to the default AI-generated board.
`}

Button format: label|icon where icon is an emoji (e.g., "💧") ${(cachedSymbols && cachedSymbols.length > 0) ? `or a custom symbol (symbol:ID)` : ''}.
Board change lists should be comma-separated with no extra conjunctions or formatting. Do not include reasoning or explanations in the board change text — just the button info.

Button guidelines:
- Buttons should represent simple concepts whose message is clear from the icon alone
- Do not put emojis in labels, only after the | separator
- Do not duplicate icons on the board
- Do not include "Yes", "No", "Help", or "More" — these are automatic
- Aim for about ${Math.min(8, maxBoardItems)} buttons; max ${maxBoardItems}
`;

  // Known Contacts section (only if there are contacts)
  if (knownContacts && knownContacts.length > 0) {
    prompt += `
== Known Contacts ==

These people have been identified around your user. You can create a button with their face using face:ID as the icon.

${knownContacts.map(c => {
  const parts = [c.name];
  if (c.relationship) parts.push(`(${c.relationship})`);
  parts.push(`ID: ${c.id}`);
  return `- ${parts.join(', ')}`;
}).join('\n')}

When creating a button for a contact: [ADD_BUTTONS] ${knownContacts[0].name}|face:${knownContacts[0].id}
If a contact has no name, use a short descriptive pseudonym (e.g., "Boy with glasses").
`;
  }

  // Available Custom Boards section
  if (availableBoards && availableBoards.length > 0) {
    prompt += `
== Available Custom Boards ==

IMPORTANT: Custom boards are pre-built boards with curated content. When a custom board matches the current activity or context, you SHOULD use [SET_BOARD] to load it instead of generating buttons from scratch with [REBUILD_BOARD].

Use: [SET_BOARD] board_key

${availableBoards.map(b => {
  const hint = b.hint ? ` — WHEN TO USE: ${b.hint}` : '';
  return `- ${b.key} ("${b.name}")${hint} (${b.grid.cols}x${b.grid.rows} grid)`;
}).join('\n')}

Rules:
- [SET_BOARD] should be used in place of [REBUILD_BOARD] when the context matches a board's description.
- When the context matches a board's description, use [SET_BOARD] to load it. Custom boards provide richer, more structured options than dynamically generated buttons.
- You should still use [ADD_BUTTONS] and [REMOVE_BUTTONS] to modify buttons on a loaded custom board's current page.
- Using [REBUILD_BOARD] will EXIT the custom board and return to the default AI-generated board. Only do this if the custom board is no longer relevant.
${loadedBoardName
  ? `\nCurrently loaded: "${loadedBoardName}"${loadedPageName ? ` (page "${loadedPageName}")` : ''}\nDo NOT re-select the already loaded board.${
    loadedPageNavButtons && loadedPageNavButtons.length > 0
      ? `\n\nNavigation buttons on current page (use [PRESS_BUTTON] label to navigate):\n${loadedPageNavButtons.map(b => `- "${b.label}" → ${b.targetPageName || b.action}`).join('\n')}\nPrefer pressing navigation buttons to load sub-pages rather than generating entirely new buttons.`
      : ''
  }`
  : '\nNo custom board is currently loaded.'}
`;
  }

  // Custom Symbols section (only if there are symbols)
  if (cachedSymbols && cachedSymbols.length > 0) {
    prompt += `
== Custom Symbols ==

Custom image symbols are available for buttons. Use symbol:ID as the icon instead of an emoji.
Prefer custom symbols over emojis when the symbol clearly represents the concept, especially for specific objects, people, or places that your user frequently communicates about.

${cachedSymbols.map(s => {
  const parts = [s.key || s.id];
  if (s.description) parts.push(`— ${s.description}`);
  return `- ${parts.join(' ')} (ID: ${s.id})`;
}).join('\n')}

Example: [ADD_BUTTONS] ${cachedSymbols[0].key || 'item'}|symbol:${cachedSymbols[0].id}
`;
  }

  // Interpretation section depends on interpretationLevel
  if (interpretationLevel === 0) {
    prompt += `
== Button Behavior ==

When the user presses buttons, the button text is spoken directly by the system. You will hear the spoken text as audio, but do not record the transcript of the spoken button text.
`;
  } else if (interpretationLevel === 1) {
    prompt += `
== Interpretations ==

Use [INTERPRET:confidence] ONLY right after a [BUTTON PRESS] input. This will output audio in the user's voice.
- Use conversation context to expand button labels into natural phrases.
- NEVER interpret gestures, gaze, sounds, or environmental cues alone.
- If no button was pressed, do NOT output [INTERPRET].
- Always include a confidence level: high, medium, or low.

If the intent is unclear, add a button to the board instead. Do NOT interpret.
You may use [SPEAK] to ask the user a question if you're unsure about their intent, or to suggest possible intents for the benefit of others.
`;
  } else if (interpretationLevel === 2) {
    prompt += `
== Interpretations ==

Use [INTERPRET:confidence] to speak on behalf of your user (in their voice). Only use when you observe a CLEAR signal:
- A distinct gesture (nodding, shaking head, pointing, waving)
- Repeatedly looking at or reaching for something specific
- Clear contextual cues (e.g., someone asked a direct question)
- Recent [BUTTON PRESS] inputs that form a clear intent

DO NOT use [INTERPRET] if the signal is ambiguous or weak. If you are unsure about the user's intent, do NOT interpret — instead, add buttons to the board to give them options for communication.
Always include a confidence level: high, medium, or low.
`;
    if (isDetection && !isLiveMode) {
      prompt += `
== HIGH CONFIDENCE Signals ==

Only use [SPEAK] or [INTERPRET] when you have HIGH CONFIDENCE:
- A distinct, deliberate gesture (nodding, shaking head, pointing, waving)
- Repeated gaze at a specific object
- Someone directly asking the user a question
- Clear communicative intent

If unsure, add a button instead. Do NOT speak or interpret on ambiguous signals.
`;
    } else {
      prompt += `If the intent is unclear, add a button to the board instead. Do NOT interpret.\n`;
    }
  } else if (interpretationLevel === 3) {
    prompt += `
== Interpretations ==

Use [INTERPRET:confidence] to speak on behalf of your user (in their voice).
- Interpret button presses, gestures, gaze patterns, and contextual cues.
- You may attempt to interpret unfamiliar gestures by reasoning about context.
- Prefer interpreting over silence — your user benefits from having their intent voiced even if imperfect.
- If genuinely unsure, add a button to the board instead.
- Always include a confidence level: high, medium, or low.
`;
    if (isDetection && !isLiveMode) {
      prompt += `
== MODERATE CONFIDENCE Signals ==

Use [SPEAK] or [INTERPRET] when you have at least MODERATE CONFIDENCE:
- A gesture or movement that could be communicative
- Gaze directed at a person or object
- Environmental cues suggesting your user wants something
- Someone addressing your user

Attempt interpretation when plausible. Use low confidence for uncertain guesses.
`;
    }
  } else if (interpretationLevel === 4) {
    prompt += `
== Interpretations ==

You are your user's voice. Actively speak for them using [INTERPRET:confidence].
- Interpret everything: button presses, gestures, emotional state, attention, environmental cues.
- When someone addresses your user, respond on their behalf.
- Proactively engage in conversations — if a teacher asks the class a question, answer for your user if you think you know their answer.
- Use [SPEAK] (AI voice) for your own commentary and questions TO your user.
- Always include a confidence level: high, medium, or low.
`;
  }

  // Mode-specific section
  if (mode === 'interact') {
    prompt += `
== Speaking to the User (Interactive mode) ==

Use [SPEAK] to talk to your user or people around them (in your AI voice).${isDetection ? ' HIGH CONFIDENCE ONLY.' : ''}
- Ask questions to understand your user's intent
- Suggest appropriate activities that help accomplish their goals
- NEVER suggest unsafe activities or anything inappropriate for their age
- Remember their capabilities when making suggestions — if they have difficulty with fine motor skills, provide alternatives that accommodate their abilities.
- CRITICAL: Every time you ask a question, you MUST update the board with buttons that directly answer that question. The user cannot respond if the board doesn't have relevant answers.
- Avoid speaking while your user is talking to other people — focus on interpretation instead
- When multiple people are present, you can speak to them as well, but always prioritize communicating on behalf of your primary user.
- When multiple people are present, make sure to clarify who you are addressing when speaking to others (e.g., "Hey Mom, {user name} wants to go outside")
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
IMPORTANT:${interpretationLevel > 0 ? `
- You may use both [INTERPRET] and [SPEAK] in the same turn — always output [INTERPRET] first` : ''}
- If there are no changes, transcripts, or button presses, you may omit text output entirely

== User not present ==

If your user is not present, but someone else is, you can still talk to that person if addressed directly, but always prioritize your user's well-being.
Assume that your user may be nearby even if you can't see them, and that they may want to communicate through you if they are present.
Do not reveal sensitive information about your user to others, and always prioritize your user's privacy and safety.

${aiName ? `Your name is "${aiName}". People nearby can refer to you by this name. Respond to them accordingly.` : ''}

${language ? `The student's primary language is {${language}}. All button labels generated, and all [SPEAK] and [INTERPRET] outputs should be in this language, except when directly addressing other people who speak in a different language or translating on your user's behalf. When talking to your user, always use their primary language. Always prioritize your user's primary language when in doubt.` : ''}

${persona ? `## Custom Instructions (If any of these instructions contradict earlier instructions, follow these ones)\n${persona}` : ''}

${memoryContext ? `## Additional Context from Memory\n${memoryContext}` : ''}
`;

  // Current time so the AI is always aware of the time of day
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  prompt += isLiveMode ? `\n\nTime at beginning of conversation: ${timeStr}` : `\n\nCurrent time: ${timeStr}`;

  return prompt;
}

/**
 * Build the system prompt for the Monitor Agent.
 * Replaces buildAACPersonaSystemPrompt when used in dual-agent context.
 */
export function buildMonitorSystemPrompt(
  mode: 'dual' | 'thinking',
  student: { name: string; aacSettings?: { chatAgentPrompt?: string | null } | null; framework?: string | null },
  framework: string | null,
  interactionMode: 'interact' | 'silent' = 'interact'
): string {
  const personaPrompt = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;

  if (mode === 'dual') {
    const modeNote = interactionMode === 'silent'
      ? 'The system is in SILENT mode — the Interactive Agent generates utterance-style buttons for the user to speak aloud. It does NOT talk to the user. Track button press patterns and communicative intent.'
      : 'The system is in INTERACT mode — the Interactive Agent talks directly to your user. You do NOT talk to your user yourself.';

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