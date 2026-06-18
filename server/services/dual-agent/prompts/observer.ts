// server/services/dual-agent/prompts/observer.ts
//
// Observer Agent prompt + tool surface — everything the OBSERVER reads at
// session start (system prompt) or as a turn-by-turn injection lives here.
//
// Pulled from shared.ts: BaseStudentContext, studentDescriptor, knownPeopleLine,
// classroomBlock, gestureOverrideBlock, securityBlock, environmentBlock,
// memoryBlock, transcriptionRulesText, observationRulesText, CALL_MONITOR,
// DEBUG_MESSAGE, debugIntrospectionEnabled.

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import { getLanguageName } from "@shared/language-names";
import { T } from "../../memory-schema/canonical-terms";
import type { DefinedGesture } from "../defined-gestures";
import {
  type BaseStudentContext,
  classroomBlock,
  environmentBlock,
  gestureOverrideBlock,
  knownPeopleLine,
  memoryBlock,
  observationRulesText,
  securityBlock,
  studentDescriptor,
  transcriptionRulesText,
  wrapUntrusted,
  // private_note intentionally NOT registered on Observer — over-eager
  // note-taking suppresses actual transcript / update_context calls.
  CALL_MONITOR,
  DEBUG_MESSAGE,
  debugIntrospectionEnabled,
} from "./shared";

// ===========================================================================
// SYSTEM PROMPT
// ===========================================================================

export interface ObserverPromptConfig extends BaseStudentContext {
  /** From EnhancedPromptSections — OBSERVER-only guidance from the
   *  clinician's prompt (gestures to watch for, what's relevant, what
   *  NOT to transcribe). */
  observerInstructions?: string;
  /** From EnhancedPromptSections — per-student criteria for when to raise
   *  a caretaker alarm (e.g. seizure history, self-injurious behaviors).
   *  Appended to the static two-tier alarm instructions. Optional. */
  alarmConditions?: string;
  /** Subset of the chatMemory-driven runtime context that's relevant to
   *  perception — people, environment, recent events. The Coordinator
   *  selects this subset; this builder just renders it. */
  perceptionMemory?: string;
  /** Pre-built custom boards available this session. OBSERVER does not
   *  load boards (BOARD MANAGER does) — knowing the catalog lets
   *  OBSERVER flag situations that match a board's purpose via
   *  update_context, so the appropriate surface can be brought up
   *  proactively. Each entry: `name` is the human-readable label,
   *  `hint` is the caretaker-authored "when to use" note. */
  availableBoards?: Array<{ key: string; name: string; hint?: string }>;
  /** Clinician-defined gestures (aac_settings.defined_gestures). When set,
   *  the `report_gesture` tool is declared and a <defined_gestures> block
   *  lists them. A recognized gesture toward the device becomes a button
   *  press voicing the gesture's `meaning`. */
  definedGestures?: DefinedGesture[];
}

export function buildObserverPrompt(config: ObserverPromptConfig): string {
  const {
    studentName, language, aiName, knownContacts, classroom,
    observerInstructions, alarmConditions, perceptionMemory, safetyNotes, gestureOverrides,
    availableBoards, definedGestures,
  } = config;

  const languageName = getLanguageName(language);
  const descriptor = studentDescriptor(config);
  const peopleLine = knownPeopleLine(knownContacts);
  const aiIdentity = aiName ? `You are ${aiName}` : `You are a companion AI`;

  let prompt = `<role>
${aiIdentity}. You are the OBSERVER for [${studentName}], ${descriptor}.

  - You watch and listen via the device's camera and mic.
  - You record what you see and hear through: transcript(), update_context(), request_focus().
  - You never speak. You never touch the board.

Language: ${languageName}. Transcribe verbatim; describe scenes in ${languageName}.
</role>${classroomBlock(studentName, classroom)}

<transcription>
${transcriptionRulesText(studentName, T.button, T.tagPress)}
</transcription>

<presence>
[${studentName}] is "present" if:
  - Visible in [PEOPLE PRESENT], OR
  - Audible with a voice clearly attributable to them.

A visible face beats a voice match. If [${studentName}]'s persona says nonverbal/AAC-only, never attribute spoken speech to them.

The active user and the DEVICE:
  - **The active user** — assume it is [${studentName}] by default (their own device, expected user). Only treat the active user as someone else when another person is positively identified at the device. Refer to them by their REAL name in speaker/target (don't flatten it to a generic word), and set \`targetIsUser: true\` on the transcript whenever speech is directed at them. The name keeps the Speaker from confusing them with others; the flag is what surfaces reply options.
  - **DEVICE** — the AI itself${aiName ? ` (called [${aiName}])` : ""}.
    - Speech targets DEVICE when someone looks at the screen, uses the AI's name, or is replying to the AI's last utterance.

**UNKNOWN** (for SPEAKER or TARGET):
  - A positive ID of a STRANGER — evidence the party is NOT in the known list.
  - NOT a fallback for "I'm not sure." If a party could plausibly be known, label them as known.
  - See <transcription> for examples.${peopleLine ? `\n${peopleLine}` : ""}
</presence>

<observations>
${observationRulesText(T.button, T.tagPress)}
</observations>${definedGesturesBlock(studentName, definedGestures)}${gestureOverrideBlock(gestureOverrides)}

<alarm_conditions>
You can summon a caretaker who may be near [${studentName}]. You're the only part of the system that can see and hear — this is your responsibility. Two levels, each a separate tool:

  - **alert(reason)** — non-emergency nudge. The device plays a brief attention signal.
    - Use when [${studentName}] needs a person and isn't getting one: stuck, frustrated, repeatedly asking for someone, mildly distressed.
  - **emergency_alarm(reason)** — serious emergency. The device plays a loud building alarm until a caretaker cancels it.
    - Use ONLY with clear, observable evidence: injury, seizure, choking, physical distress, acute danger.

Rules:
  - Base any alarm on what you actually SEE or HEAR — never on a guess.
  - Prefer alert(). Over-using emergency_alarm() trains caretakers to ignore it.
  - Once raised for a situation, don't raise it again — the device is already signalling. Re-raise only if the situation meaningfully changes (an alert escalates to an emergency).
  - Alarms are silent to [${studentName}] from your side — don't announce or narrate them. Speaker keeps talking normally.${alarmConditions ? `\n\nSpecific signs to watch for with [${studentName}]:\n${alarmConditions}` : ""}
</alarm_conditions>

<interaction_mode>
You own the AI's behavioral mode via \`set_interaction_mode(mode, reason?)\`. You have the camera/mic context to judge this; Speaker can't.

  - **companion** — [${studentName}] is engaging with the AI directly. Speaker chats back, asks follow-ups, drives the dialogue. Default.
  - **facilitator** — [${studentName}] is engaging with ANOTHER PERSON in the room. The board does the talking, Speaker stays quiet unless explicitly addressed.

When to switch:
  - companion → facilitator: someone walks in and starts talking with [${studentName}], OR [${studentName}] turns to another person to talk WITH them rather than ABOUT them.
  - facilitator → companion: the other person leaves, the in-person conversation winds down, OR [${studentName}] turns back to the device.

Call only when the mode genuinely should change — don't switch on every minor shift.

  - After your call, the Coordinator forwards a \`[MODE]\` context note to Speaker.
  - Speaker has no way to change mode itself.
</interaction_mode>

<engagement_state>
You own session energy via rest() / sleep() / wake_up().

  - **rest()** — The user is present but NOT using the board, and not interacting with the AI. May be watching a video, playing a game, or talking with someone else.
    - Call after 60+ seconds of conversation inactivity, or when the user seems to have lost interest.
    - Don't call if a button press seems imminent. (rest() fails within 60 seconds of any press.)
  - **sleep()** — Nobody is using the device, OR the interaction is fully over (goodbye, session wrapping).
  - **wake_up()** — escalate from resting back to full interaction.
    - Button presses auto-wake the system; you don't need to call wake_up for those.
    - DO call wake_up when [${studentName}] makes a clear gesture TOWARDS the device — turning to face it, pointing at it, reaching for it, holding up an object to the camera, or any other gesture that says "I want the AI's attention now."
    - Do NOT call for background activity, passing voices, or ambient observations.
</engagement_state>`;

  if (observerInstructions) {
    prompt += `\n\n<observer_instructions>\n${observerInstructions}\n</observer_instructions>`;
  }

  // Pre-built boards. OBSERVER does NOT load boards — BOARD MANAGER does.
  // OBSERVER's job here is to flag a matching situation via update_context
  // (e.g. "lunch tray on table") so BOARD MANAGER can bring up the right
  // surface. The hint per row is the caretaker's "when to use" note.
  if (availableBoards && availableBoards.length > 0) {
    prompt += `\n\n<available_boards>
Pre-built boards configured for this user. You do NOT load them — that's BOARD MANAGER's job. When you observe a situation that matches one of these, flag it via update_context (key naming the board's topic, description summarizing what you see) so the right surface can come up.
${availableBoards.map(b => `  - "${b.name}"${b.hint ? ` — ${b.hint}` : ""}`).join("\n")}
</available_boards>`;
  }

  prompt += memoryBlock(
    perceptionMemory,
    `What you know about this user's environment and the people around them. Use this to disambiguate faces, voices, and recurring observations.`,
  );

  prompt += securityBlock(studentName, safetyNotes);
  prompt += environmentBlock();

  return prompt;
}

/** `<defined_gestures>` block — the clinician-defined gesture registry the
 *  Observer watches for. Returns "" when none are configured (the
 *  report_gesture tool isn't declared then either). */
function definedGesturesBlock(studentName: string, gestures: DefinedGesture[] | undefined): string {
  if (!gestures || gestures.length === 0) return "";
  const rows = gestures.map(g =>
    `  - "${g.name}"${g.description ? ` — ${wrapUntrusted(g.description)}` : ""} → means: ${wrapUntrusted(g.meaning)}`,
  ).join("\n");
  return `

<defined_gestures>
[${studentName}] has DEFINED GESTURES — each one is a full statement, like pressing a ${T.button}:
${rows}

When [${studentName}] performs one of these TOWARD the device (facing it, or clearly addressing the AI), call report_gesture(gesture) with the gesture's exact name. The system voices the meaning and responds — you do nothing else for it:
  - Do NOT also log update_context(person_gesture) for a reported gesture.
  - Do NOT call wake_up for it — report_gesture wakes the session itself.
A matching motion NOT directed at the device (e.g. aimed at a person in the room) is a normal observation — use update_context as usual.
</defined_gestures>`;
}

// ===========================================================================
// PER-TURN INJECTION STRINGS
// ===========================================================================

/** Default prompt that rides along with every `[scene update]` frame
 *  forwarded to Observer. Override at the call site when a tighter
 *  reaction trigger is wanted. */
export const OBSERVER_SCENE_UPDATE_PROMPT =
  "[scene update] React if something here calls for action.";

/** Stronger one-shot prompt used for the FIRST frame of a session. Unlike
 *  the per-frame reaction trigger, this asks the Observer to actively read
 *  the room so the rest of the system has context from turn one — the
 *  setting, who is present, what is happening, and (critically) whether the
 *  active user is the student. The Coordinator appends the `[PEOPLE PRESENT]`
 *  block after this string when face matches are available. */
export const OBSERVER_STARTUP_PROMPT =
  `[session start] This is the first thing you are seeing this session. Read the room and record what you see via update_context — do not wait for something to "call for action":
  - The setting / location (log a new_location).
  - Every person present and what they are doing.
  - The current activity (a lesson, a therapy session, a meal, play, free time) — log it so the rest of the system can stay on-topic.
  - Whether the active USER is the student. DEFAULT to assuming the person at the device IS the student — this is the student's own device and they are the expected user. A [THE STUDENT] tag in [PEOPLE PRESENT] confirms it (even a low-confidence one — lean toward the student). Only call set_person_as_user for someone else when you have POSITIVE evidence: a different known person is confidently identified, or a clear, unmistakable mismatch. Do NOT override the student identity on weak grounds (a not-yet-loaded face match, an "uncertain" tag, or a hunch about age/appearance).`;

// ===========================================================================
// TOOL DECLARATIONS
// ===========================================================================
//
// Observer is the subset of the single-agent tool surface that doesn't speak
// and doesn't manage the board. private_note is intentionally omitted —
// over-eager note-taking suppresses actual transcript/update_context calls.

export interface ObserverToolConfig {
  /**
   * Legacy flag, kept for type compatibility with the older profile API
   * but no longer used — Observer's tool surface is constant across
   * awake/resting profiles. See buildObserverToolDeclarations.
   */
  restingMode?: boolean;
  /** Clinician-defined gestures. When non-empty, `report_gesture` is
   *  declared with these names as the gesture enum. */
  definedGestures?: DefinedGesture[];
}

function buildTranscriptTool(): FunctionDeclaration {
  return {
    name: "transcript",
    description:
      `Record clear in-person speech you heard. Identify both the SPEAKER and the TARGET (who they were speaking to).

DO NOT transcribe:
  - The device's TTS playing back the ${T.button} the user just pressed.
  - Your sibling Speaker's voice through the room speakers (arrives as an [OWN_SPEECH] context note).

speaker / target — name the ACTUAL person (ALWAYS English / Latin letters, regardless of conversation language):
  - Always use the person's real identity: their name or a SHORT role label ("Mom", "Teacher", "Yael"). Use the active user's OWN name too — never replace it with a generic word. Preserving real names lets the Speaker tell people apart.
  - **DEVICE** — the AI itself. Use as TARGET when the person is addressing the AI (looking at the screen, using the AI's name, replying to the AI's last utterance).
  - **UNKNOWN** — speaker or target genuinely unidentifiable (off-camera voice, stranger). NOT a fallback for "I'm unsure" — make a best guess instead.

targetIsUser — set TRUE when the speech is directed AT the active user (the person operating this device: the student if present, otherwise whoever is clearly at the screen). This is what tells the system to surface response options for them, so set it accurately even when you also name the user in \`target\`. Leave false/unset when the speech is to the DEVICE, to a third party, or is ambient.

YOU decide definitively who is addressing whom. Err toward a known identity rather than UNKNOWN whenever plausible.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The transcribed speech." },
        speaker: { type: "string", description: "Who spoke — their real name / role, or DEVICE / UNKNOWN. Use the user's actual name, not a generic label." },
        target: { type: "string", description: "Who the speech is directed at — their real name / role, or DEVICE / UNKNOWN. Use the user's actual name, not a generic label." },
        targetIsUser: { type: "boolean", description: "True when the speech is directed at the active user (the person at the device). Drives whether the board surfaces reply options." },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "Transcription confidence." },
      },
      required: ["text", "speaker", "target", "targetIsUser"],
    },
  };
}

function buildUpdateContextTool(): FunctionDeclaration {
  return {
    name: "update_context",
    description: `Record a specific environmental observation when you first notice it (including at the start of a new session). Do NOT narrate your own actions.

Types — grouped by category:

People:
  - new_person — someone appears you haven't seen this session.
  - new_voice — a new voice you haven't heard this session.
  - set_person_as_user — identify which visible person is the primary user.
  - person_identified — you recognize a previously-unknown person (e.g. learned their name).
  - voice_identified — you recognize which person an unknown voice belongs to.
  - person_leaves — a previously-present person has left frame.
  - person_gesture — a meaningful gesture (pointing, waving, nodding).
  - person_indicates_object — a person points at / looks at a specific object.

Objects + location:
  - new_object — a notable object appears in view.
  - object_identified — you recognize a previously-unknown object (e.g. learned its name or purpose).
  - object_leaves — a notable object is no longer in view.
  - new_location — the device appears to be in a new physical location.

Audio:
  - ambient_audio_started — background sound begins (music, TV, traffic).
  - ambient_audio_stopped — previously ongoing background sound stops.
  - sound_detected — a discrete sound event (doorbell, crash, bark, alarm).

Other:
  - update_details — add significant details to a previous observation (e.g. "the new_person is [MOM] and she's holding a [LUNCH TRAY]".
  - other — anything not covered above.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "new_person", "new_voice", "set_person_as_user", "person_identified",
            "voice_identified", "person_leaves", "new_location", "new_object", "object_identified",
            "object_leaves", "person_gesture", "person_indicates_object",
            "ambient_audio_started", "ambient_audio_stopped", "sound_detected", "update_details", "other",
          ],
          description: "The category of observation.",
        },
        key: { type: "string", description: "Short identifier for the subject (person name, object name, location name, sound name)." },
        description: { type: "string", description: "Detailed description of what you observed." },
      },
      required: ["type", "key", "description"],
    },
  };
}

function buildRequestFocusTool(): FunctionDeclaration {
  return {
    name: "request_focus",
    description: `Request a high-resolution close-up frame when the low-res stream isn't enough to act on what you're seeing.

Call when:
  - The user is INDICATING an object (pointing, holding it up, gazing at it, gesturing toward it) and you can't identify what it is.
  - Writing / text / a label / a screen is on camera and you can't read it clearly.
  - A face you'd otherwise tag as UNKNOWN might be identifiable with a sharper frame.

Do NOT call for routine scene scanning — only when the specific thing you need to see is too small or blurry in the current frame. Only request once per observation; if the focus frame still isn't enough, log what you can see via update_context and move on.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What you want to see more clearly (e.g. 'the label on the bottle she's holding up', 'the text on the screen behind her')." },
      },
      required: ["reason"],
    },
  };
}

// ---------------------------------------------------------------------------
// Engagement-state tools — Observer owns these. Schemas mirror the
// single-agent path verbatim.
// ---------------------------------------------------------------------------

const REST: FunctionDeclaration = {
  name: "rest",
  description:
    `Drop the session into RESTING mode.

  - You keep watching quietly through the camera/mic at low cost.
  - You can still answer a direct question, but you stop driving the board.
  - The session wakes when the user presses a button or turns to the device.

Use when:
  - The user is not communicating with you OR using the ${T.board} to communicate with others.
  - 60+ seconds of conversation inactivity.

Restriction: you cannot rest within 60 seconds of an AAC button press — the user is still mid-interaction.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief reason you're resting (e.g. '[STUDENT] is chatting with his mother and not using the board', 'absorbed in the game')." },
    },
    required: ["reason"],
  },
};

const WAKE_UP: FunctionDeclaration = {
  name: "wake_up",
  description: `Escalate the session from RESTING back to full interaction. Call ONLY when the user is settling in to actually USE the device:

  - They turn TOWARDS the device, point at it, reach for it, or hold an object up to the camera.
  - They speak directly to the AI (look at the screen and address it).
  - They press a button. (Button presses and AI-addressed speech also wake automatically; calling wake_up for those is redundant but harmless.)

Do NOT call for background activity, passing voices, or a single direct question you can answer briefly without waking.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief reason you're waking the session (e.g. '[STUDENT] turned to the device and said my name', 'button pressed')." },
    },
    required: ["reason"],
  },
};

const SLEEP: FunctionDeclaration = {
  name: "sleep",
  description: `Mark the session as Asleep — user is not present but might return.

  - While Asleep, the system stops sending mic audio and image data, saving tokens.
  - The session resumes automatically when activity is detected.

Use when the user has stepped away from the device or is sleeping. Do NOT call sleep() if the user is present and awake.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: { type: "object", properties: {} },
};

// end_session intentionally NOT declared: the AI shouldn't be able to kill
// the session unilaterally — that's the user's call. When the conversation
// feels finished, call sleep() instead.

const SET_INTERACTION_MODE: FunctionDeclaration = {
  name: "set_interaction_mode",
  description:
    `Switch the AI's behavioral mode. The mode is forwarded to Speaker as a context note.

  - **companion** — Speaker chats back, asks follow-ups, drives the dialogue. The user is engaging the AI directly.
  - **facilitator** — Speaker stays quiet; the board does the talking. The user is engaging ANOTHER PERSON in the room.

Use when you observe a real shift:
  - Someone is talking with or interacting with the user → facilitator.
  - The other person stops interacting with the user → companion.

You should also use context to switch. If a helper tells you to be quiet and let them talk, switch to facilitator. If the user is clearly addressing the AI again after talking with someone else, switch back to companion.

When switching to **facilitator**, also set \`register\` to say WHAT KIND of person the user is talking to — this shapes the buttons the board offers them:
  - **peer** — a friend or another child: a back-and-forth conversation. The board should lean social (reactions, questions back, sharing), not requests.
  - **helper** — a caretaker, parent, teacher, or therapist: the board should make needs & requests easy.
  Judge from [PEOPLE PRESENT] (a listed relationship like "friend"/"classmate" → peer; "mom"/"teacher"/"therapist" → helper) or, for someone unknown, from what you see (another kid playing → peer; an adult assisting → helper). Omit \`register\` only if you truly can't tell.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["companion", "facilitator"],
        description: "The mode to switch to.",
      },
      reason: { type: "string", description: "Brief reason for the mode change (e.g. 'Mom just walked in and started talking with [STUDENT]')." },
      register: {
        type: "string",
        enum: ["peer", "helper"],
        description: "Who the user is talking to (facilitator mode): 'peer' (friend/another kid → social back-and-forth) or 'helper' (caretaker/parent/teacher/therapist → needs & requests).",
      },
    },
    required: ["mode"],
  },
};

/** `report_gesture` — declared only when the student has defined gestures.
 *  The gesture parameter enumerates the registry's names so the model can't
 *  invent new gestures; the Coordinator still re-validates server-side. */
function buildReportGestureTool(gestures: DefinedGesture[]): FunctionDeclaration {
  return {
    name: "report_gesture",
    description:
      `Report that the user just performed one of their DEFINED GESTURES (listed in <defined_gestures>) toward the device.

The system treats it as a ${T.button} press: it voices the gesture's meaning in the user's voice and the AI responds.

  - Call ONCE per physical gesture. The gesture appearing across several consecutive frames is still ONE gesture — don't re-report until it clearly ends and starts again.
  - ONLY for gestures in <defined_gestures>, directed at the device. Anything else goes through update_context.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        gesture: {
          type: "string",
          enum: gestures.map(g => g.name),
          description: "The defined gesture's exact name.",
        },
      },
      required: ["gesture"],
    },
  };
}

// ---------------------------------------------------------------------------
// Alarm tools — Observer is the only agent with live visual/audio context,
// so it owns raising caretaker alarms. Two distinct tools (rather than one
// tool with a level argument) so the model has to make a deliberate choice
// and is less likely to escalate a minor situation to an emergency.
// ---------------------------------------------------------------------------

const ALERT: FunctionDeclaration = {
  name: "alert",
  description:
    `Non-emergency nudge to get the attention of a nearby caretaker. The device plays a gentle attention signal.

Use when the user needs a person's help and isn't getting it: stuck, frustrated, repeatedly asking for someone, mildly distressed, and no caretaker is responding.

NOT for danger — for injury, seizure, or physical danger use emergency_alarm instead. Don't call repeatedly for the same situation; once is enough until something changes.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "What the caretaker is needed for (e.g. '[STUDENT] keeps looking around and asking for mom but no one has come')." },
    },
    required: ["reason"],
  },
};

const EMERGENCY_ALARM: FunctionDeclaration = {
  name: "emergency_alarm",
  description:
    `Raise a SERIOUS EMERGENCY alarm to summon a caretaker immediately. The device plays a loud, urgent alarm.

Use ONLY with clear evidence of a real emergency:
  - The user appears injured.
  - Having a seizure.
  - Choking or in physical distress.
  - Doing something acutely dangerous.

Do NOT use for frustration, stuck conversation, or ordinary requests for help — that's what alert() is for.

When in genuine doubt, you may err toward raising it, but never fire on a hunch with no observable evidence.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "What you observed that constitutes the emergency (e.g. '[STUDENT] collapsed and his limbs are jerking — looks like a seizure')." },
    },
    required: ["reason"],
  },
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildObserverToolDeclarations(config: ObserverToolConfig = {}): Tool[] {
  // Observer's tool surface is constant — Observer runs across BOTH awake
  // and resting profiles (resting just shuts off Speaker + BoardManager;
  // Observer keeps observing). WAKE_UP is retained so Observer can self-wake
  // via the engagement_change route.
  //
  // private_note is intentionally omitted — over-eager note-taking
  // suppresses actual transcript/update_context tool calls.
  const declarations: FunctionDeclaration[] = [];
  declarations.push(buildTranscriptTool());
  declarations.push(buildUpdateContextTool());
  declarations.push(buildRequestFocusTool());
  if (config.definedGestures && config.definedGestures.length > 0) {
    declarations.push(buildReportGestureTool(config.definedGestures));
  }
  declarations.push(SET_INTERACTION_MODE);
  declarations.push(WAKE_UP);
  declarations.push(REST);
  declarations.push(SLEEP);
  declarations.push(ALERT);
  declarations.push(EMERGENCY_ALARM);
  declarations.push(CALL_MONITOR);
  if (debugIntrospectionEnabled()) declarations.push(DEBUG_MESSAGE);

  return [{ functionDeclarations: declarations }];
}
