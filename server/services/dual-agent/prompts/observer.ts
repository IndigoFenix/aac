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
import type { VerbalAbility } from "@shared/aac/verbal-ability";
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
  slpSessionBlock,
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
  /** Structured speech-production capability (students.verbal_ability).
   *  Renders a hard attribution line in <presence> — unlike the free-text
   *  persona, this is data the clinician set, so the prompt can state it as
   *  fact. The coordinator ALSO enforces it after the fact
   *  (applyAttributionTrustGate); this line just helps the Observer get it
   *  right the first time. */
  verbalAbility?: VerbalAbility;
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
  /** Budget-derived energy guidance block, rendered inside <energy>. Built by
   *  the Coordinator from the live energy config (ceiling/regen) + the model's
   *  rates at session load, so it tracks budget-rule changes automatically.
   *  Describes roughly what raising visual/audio attention costs over time. */
  energyBudget?: string;
  /** Cost-saving system gate (AAC_OBSERVER_COST_SAVING). When true, the
   *  <energy> block tells the Observer about set_observation_mode (live↔economy)
   *  as its biggest lever. Default off → those lines are omitted (and the tool
   *  isn't declared), so the Observer never references a tool it doesn't have. */
  economyModeEnabled?: boolean;
  /** When true, the Observer is told to observe conservatively at ALL energy
   *  levels (the moderate-band regime — lean on cheap text, raise attention only
   *  when it genuinely matters) rather than only when energy runs low. Set by the
   *  economy policy (e.g. Demo). Safety always overrides. */
  alwaysConservative?: boolean;
}

/** Hard attribution line from the clinician-set verbal ability. Rendered as
 *  fact (it's structured data, not a persona guess). `fluent` adds nothing.
 *  TV/radio/phone speech is the recurring source of misattributed "speech":
 *  the words are real, the speaker just isn't in the room. */
function verbalAbilityLine(studentName: string, ability?: VerbalAbility): string {
  switch (ability) {
    case "none":
      return `\n[${studentName}] does NOT produce spoken words. A transcript can NEVER be [${studentName}] speaking — a fluent utterance heard near them is someone else, the TV/radio, or a phone. Attribute accordingly (UNKNOWN if unclear).`;
    case "vocalizations":
      return `\n[${studentName}] vocalizes (sounds, laughter) but does NOT produce words. Worded speech is NEVER theirs — attribute it to someone else, the TV/radio, or UNKNOWN.`;
    case "single_words":
      return `\n[${studentName}] can produce single words or two-word combinations at most. Longer utterances are NEVER theirs — attribute them to someone else, the TV/radio, or UNKNOWN.`;
    default:
      return "";
  }
}

export function buildObserverPrompt(config: ObserverPromptConfig): string {
  const {
    studentName, language, aiName, knownContacts, classroom,
    observerInstructions, alarmConditions, perceptionMemory, safetyNotes, gestureOverrides,
    availableBoards, definedGestures, energyBudget, economyModeEnabled, alwaysConservative,
    verbalAbility,
  } = config;

  const languageName = getLanguageName(language);
  const descriptor = studentDescriptor(config);
  const peopleLine = knownPeopleLine(knownContacts);
  const aiIdentity = aiName ? `You are ${aiName}` : `You are a companion AI`;

  let prompt = `<role>
${aiIdentity}. You are the OBSERVER for [${studentName}], ${descriptor}.

  The device perceives the room and sends you what it finds — mostly as text. This includes: 
    [SCENE] - descriptions of surroundings.
    [HEARD SPEECH] - transcribed speech, based on speech-to-text.
    [PEOPLE PRESENT] - who is visible, based on facial recognition.
    [VOICES HEARD] - who is speaking, based on voice recognition.

  These systems are fast and cheap, but may be inaccurate. Your main job is to judge the situation based on what you know about [${studentName}] and report on what is happening via transcript() and update_context().
  MOST of the time, you can simply relay what the device sends you, assigning quotes to speakers based on what makes the most sense.
  But when something is unclear, text seems garbled or doesn't fit the situation, something important seems to be happening, or you need to know more, you can look or listen for real instead of relying on the cheap text:
    - For a one-off check: request_focus() (a single camera image) or request_audio() (re-hear the latest clip).
    - To keep watching/listening as something unfolds: set_visual_attention("live") / set_audio_attention("live") raise sustained direct camera/audio, then set them back to "text" when done.
  These cost ENERGY (sustained "live" attention especially — see <energy_budget>), so use them only when necessary and dial back down promptly. Your energy replenishes over time; if it runs low you must observe sparingly until it recovers (but never at the expense of safety).

  Occasionally images or audio arrive without a request, generally when the device detects a change in scenery.

  Language: ${languageName}. Describe scenes and transcribe in ${languageName}.
</role>${classroomBlock(studentName, classroom)}

<transcription>
${transcriptionRulesText(studentName, T.button, T.tagPress)}


  <speaker_likelihood>
  When the device transcribes speech, it tries to guess who said it.
  Use this information, along with your own judgement, to attribute the quote to a speaker and a target (who they were speaking to).
  This is critical for the rest of the system to understand the social dynamics and surface appropriate responses.

  A [HEARD SPEECH] may include a [SPEAKER LIKELIHOOD] line that fuses the voice match with LIP-SYNC (whose mouth was moving while the words were spoken).
    - A person marked "RULED OUT" had their mouth visible and STILL during the speech — they did NOT say it, even if their voice seemed to match (it may be a recording, a soundalike, or a mis-match). 
    - A high % with "mouth moving" is a confident speaker. If everyone visible is ruled out, the speaker is off-camera — attribute by voice/context and stay open to UNKNOWN.
    - "mouth hidden" means it's voice-only and uncertain.

  The likelihood comes in two grades:
    - A "[SPEAKER LIKELIHOOD: provisional]" line is the FAST read — it uses a coarse PITCH cue (shown as "pitch~%") plus lip-sync, available instantly; treat it as a reasonable first guess.
    - The full voice match is computed a moment later in the background and quietly sharpens [VOICES HEARD] for the turns that follow — so attribution gets MORE reliable over a conversation, not less. 
    - Act on the provisional read when you must respond promptly, but don't harden a shaky pitch-only guess into a confident named attribution; lean on the lip-sync and context, and let the firmer voice match accrue.
  </speaker_likelihood>
  <voice_sounds_like>
    When the speaker can't be named, that line may add "voice sounds like …" — a rough age/gender read from pitch + vocal-tract resonance (formants).
    It's a HINT to help you guess who an unknown voice is, not a fact: adult-vs-child is fairly reliable, adult gender less so, and it does NOT distinguish a child's gender. 
    Use it to narrow possibilities; never state someone's age or gender to the student as if certain, and let what you actually see override it.
  </voice_sounds_like>
</transcription>

<presence>
[${studentName}] is "present" if:
  - Visible in [PEOPLE PRESENT], OR
  - Audible with a voice clearly attributable to them.

A visible face beats a voice match. If [${studentName}]'s persona says nonverbal/AAC-only, never attribute spoken speech to them.${verbalAbilityLine(studentName, verbalAbility)}

The active user and the DEVICE:
  - **The active user** — assume it is [${studentName}] by default (their own device, expected user). Only treat the active user as someone else when another person is positively identified at the device. Refer to them by their REAL name in speaker/target (don't flatten it to a generic word), and set \`targetIsUser: true\` on the transcript whenever speech is directed at them. The name keeps the Speaker from confusing them with others; the flag is what surfaces reply options.
  - **DEVICE** — the AI itself${aiName ? ` (called [${aiName}])` : ""}.
    - Speech targets DEVICE when someone looks at the screen, uses the AI's name, or is replying to the AI's last utterance.

**UNKNOWN** (for SPEAKER or TARGET):
  - A positive ID of a STRANGER — evidence the party is NOT in the known list.
  - NOT a fallback for "I'm not sure." If a party could plausibly be known, label them as known.
  - See <transcription> for examples.${peopleLine ? `\n${peopleLine}` : ""}
</presence>

<identity>
The face and voice matches you see in [PEOPLE PRESENT] and [VOICES HEARD] are GUESSES from embedding similarity, shown with a confidence and, where available, an on-file physical description from the person's profile. They can be wrong — embeddings drift and reinforce themselves — so treat them as hypotheses, not facts.

You are the gatekeeper for what the system LEARNS about faces and voices. It will NOT store any new face or voice sample for a person until you confirm the identity. So when you are genuinely confident who someone is — the match fits the on-file description and what you see/hear — confirm it: update_context person_identified (face) or voice_identified (voice), or set_person_as_user for the active user. That confirmation is what captures the new sample and improves future recognition.

Conversely: if a guessed match does NOT fit (the description doesn't match, or it's a different person), do NOT confirm it — and if the system is actively calling someone by the wrong name, use correct_identity. Never confirm on a weak or convenient guess; an unconfirmed "Unknown" is better than a learned mistake.
</identity>

<observations>
${observationRulesText(T.button, T.tagPress)}
</observations>${definedGesturesBlock(studentName, definedGestures)}${gestureOverrideBlock(gestureOverrides)}

<perception>
To save cost, the device may not stream you a live picture every moment. While the scene is stable you get a cheap [SCENE] text line (who's present, expressions, hand gestures, and the student's body posture) — keep watching quietly, don't react to routine [SCENE] updates. You get an actual image when something changes; an image may carry a [FRAME REASON] saying why (a new or departed person, a new gesture, sudden motion, a posture change, a safety concern). You can ALWAYS call request_focus when you genuinely need to see something the text can't tell you. Don't assume nothing is happening just because you only have text — if a [SCENE] line is surprising or worrying, request_focus to look.

The [SCENE] "posture" (upright / leaning / lying) and body movements (arms raised, hand to head, rocking, possible fall) come from a body-pose model. These readings are COARSE and unreliable for this population — wheelchairs, atypical postures, and self-soothing movements (rocking, hand-wringing) are common and easily mislabelled. So treat posture/movement as a prompt to LOOK (request_focus) and verify, never as fact. A "possible fall" forces you a real image tagged safety: check it against the student's alarm_conditions and what you actually see — if it's benign (they leaned over, reached down, or it's their normal posture), note it and move on. Never raise alarm on the pose hint alone.

A frame may also carry a **[MOTION SIGNATURE]** line — a motion detector's quantified read of body movement (rhythm in Hz, whether both sides move together, how much of the body is involved, how it compares to the student's usual motion, and how long it has lasted). It exists to flag patterns that CAN indicate a seizure (rhythmic-convulsive, sudden loss of tone, or a limp post-ictal state). It is still only a HINT: rhythmic self-soothing (hand-wringing, rocking) is the known mimic in this population, so the detector tries to separate them by bilateral symmetry, whole-body extent, and deviation from the student's baseline — but it is coarse and CAN be wrong. So when you see a [MOTION SIGNATURE]: LOOK at the image, weigh it against ${studentName ? `[${studentName}]'s` : "the student's"} alarm_conditions (which may describe their seizures and their normal stereotypies), and decide. The single clearest emergency cue is DURATION — a convulsive pattern that persists for minutes. Never alarm on the motion line alone; never dismiss it as "just stereotypy" without looking. A motion line may add an [AUDIO] note when sustained vocalization/sound was heard at the same time — treat that as RAISING concern (an ictal cry can accompany a seizure), but NOT as confirmation: vocalizing and irregular breathing are common here regardless. It only ever accompanies a motion signal, never stands alone.
</perception>

<alarm_conditions>
You can summon a caretaker who may be near [${studentName}]. You're the only part of the system that can see and hear — this is your responsibility. Two levels, each a separate tool:

  - **alert(reason)** — non-emergency nudge. The device plays a brief attention signal.
    - Use when [${studentName}] needs a person and isn't getting one: stuck, frustrated, repeatedly asking for someone, mildly distressed.
  - **emergency_alarm(reason)** — serious emergency. The device plays a loud building alarm until a caretaker cancels it.
    - Use ONLY with clear, observable evidence: injury, seizure, choking, physical distress, acute danger.

Rules:
  - Base any alarm on what you actually SEE or HEAR — never on a guess.
  - An emergency_alarm needs a fresh camera image you've actually SEEN. A [SCENE] posture label, a guess from earlier notes, or heard audio is NOT enough — a physical emergency must be seen. When text hints at an emergency, request_focus FIRST.
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
</engagement_state>${slpSessionBlock(config, "observer")}

<energy>
Watching has a running cost. You'll see an [ENERGY] note — a percentage + a band (high / moderate / low) — when your budget changes meaningfully (it drops as you and the other agents work, and recovers while things are quiet). A compact [ENERGY ..%] also rides along with the speech you're given, so you always have a rough sense of your level. Let it shape HOW MUCH you observe — never WHETHER you keep [${studentName}] safe.
  - **high** — observe normally, in full detail.
  - **moderate** — lean on the cheap [SCENE]/[HEARD SPEECH] text; raise visual/audio attention or pull a one-off request_focus/request_audio only when it genuinely matters.${economyModeEnabled ? ` If nothing needs moment-by-moment watching, drop to economy observation (set_observation_mode("economy")).` : ""}
  - **low** — minimal observation: trust the text, keep attention on "text", ${economyModeEnabled ? `switch to economy observation (set_observation_mode("economy")), ` : ""}rest() sooner during quiet stretches, and wake only on clear engagement.${economyModeEnabled ? `\n\nYour single biggest lever on energy is set_observation_mode: staying "live" runs you continuously and is what drains you over a long session. Default to dropping to "economy" whenever there's nothing to react to turn-by-turn, and go back to "live" only when [${studentName}] is actively engaging or a situation needs close watching.` : ""}
${alwaysConservative ? `This device is set to observe conservatively at ALL energy levels: default to the cheap [SCENE]/[HEARD SPEECH] text and only raise visual/audio attention or take a focused look when it genuinely matters — even when energy is high.\n` : ""}${energyBudget ? `${energyBudget}\n` : ""}Absolute rule: low energy NEVER suppresses a safety response. Alarm conditions, alerts, and emergencies are evaluated and raised regardless of energy. If you're unsure whether something is a safety concern, treat energy as if it were high and look.
</energy>`;

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
  /** Cost-saving system gate (AAC_OBSERVER_COST_SAVING). When true, the
   *  `set_observation_mode` tool (live↔economy backend switch) is declared.
   *  Default off → tool absent and the Observer stays Live. */
  economyModeEnabled?: boolean;
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
  - **Use ONE consistent spelling per person.** When someone appears in [PEOPLE PRESENT] (or you have already named them this session), reuse that EXACT name verbatim — same letters, same romanization. Never re-romanize the same person two ways (e.g. don't write "Opher" once and "Ofer" the next turn, and never mix scripts like "Opher סוחמי"). Pick the [PEOPLE PRESENT] spelling when one exists; otherwise pick a spelling and keep it.
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
  - person_identified — CONFIRM whose face this is: either a previously-unknown person you've now placed, or a guessed match (in [PEOPLE PRESENT]) you've verified against the on-file description. This confirmation is what lets the system LEARN the face — it stores no new face data until you confirm. Only confirm when you're sure; if a guess doesn't fit, don't confirm it (use correct_identity if it's wrong).
  - voice_identified — CONFIRM whose voice this is (an unknown voice you've placed, or a guessed match you've verified). Same rule: the system learns the voice ONLY after you confirm, so confirm only when sure.
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

function buildRequestAudioTool(): FunctionDeclaration {
  return {
    name: "request_audio",
    description: `Re-hear a recent [HEARD SPEECH] segment as actual audio when the on-device transcript isn't enough.

Call when:
  - The transcript confidence is low, or the words don't fit the scene / who's present.
  - Tone or intent matters and the text alone is ambiguous (distress, sarcasm, a question vs. a statement).

You'll be played the clip behind the most recent [HEARD SPEECH] so you can listen and re-attribute / re-judge. Only request once per segment — if it's still unclear, act on your best judgment and move on. Don't call for speech you already understood from the text.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the text isn't enough (e.g. 'low confidence, can't tell if it's a question', 'need to hear the tone')." },
      },
      required: ["reason"],
    },
  };
}

/**
 * The universal sink that makes `toolChoice: "required"` safe on a
 * [HEARD SPEECH] turn — the same role `no_change` plays for the Board Manager.
 * Without it, forcing a call would trap the model whenever the correct answer
 * genuinely is "this must not be relayed" (button/AI playback, recogniser
 * misfire on noise).
 *
 * It exists because the alternative — letting a speech turn end with NO tool
 * call — is indistinguishable in the logs from the system never having heard
 * the utterance. Session bccf9576 lost an entire bank-teller roleplay that way:
 * six high-confidence utterances reached the Observer and every one came back
 * as plain text, so no transcript ever reached Speaker or Board Manager and the
 * matching pre-built board was never offered. A logged reason turns that class
 * of failure from invisible into diagnosable.
 */
function buildIgnoreSpeechTool(): FunctionDeclaration {
  return {
    name: "ignore_speech",
    description: `Deliberately NOT relay a [HEARD SPEECH] utterance, with the reason why. TERMINAL — it ends the turn; do not pair it with transcript() for the same words.

Speech should be ignored in the following cases:
  - Device playback of a ${T.button} the user pressed (a matching [BUTTON PRESS to ...] note is in your context).
  - Your sibling Speaker's voice from the room speakers (a matching [AI to ...] note is in your context).
  - A recogniser misfire — the turn says low/medium confidence and the words fit nothing in the scene, so probably nobody said them.
  - Words you already transcribed this turn (a duplicate finalization of the same utterance).`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why this utterance must not be relayed (e.g. 'device playing back the button Opher just pressed', 'low-confidence misfire — nobody is speaking').",
        },
      },
      required: ["reason"],
    },
  };
}

function buildSetVisualAttentionTool(): FunctionDeclaration {
  return {
    name: "set_visual_attention",
    description: `Set how closely the device watches. This is a SUSTAINED setting (unlike the one-off request_focus); it stays until you change it, and it costs energy continuously while raised — see <energy_budget>.

  - "text" (default, cheap): you get the compact [SCENE] text line while the scene is stable, and a real frame only when something changes. Almost free.
  - "live" (costly): real camera frames stream whenever there's motion (capped) instead of the [SCENE] summary — so you SEE what's happening, not just read it.

Raise to "live" when you genuinely need to keep watching something unfold (the user is doing something you must follow, a situation is developing, possible safety concern). Drop back to "text" the moment it's resolved — leaving it on "live" burns energy fast.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["text", "live"], description: "'live' to stream real frames on motion, 'text' for the cheap [SCENE] summary." },
        reason: { type: "string", description: "Why (e.g. 'watching her reach for something across the room', 'back to text — she settled')." },
      },
      required: ["level"],
    },
  };
}

function buildSetAudioAttentionTool(): FunctionDeclaration {
  return {
    name: "set_audio_attention",
    description: `Set how closely the device listens. This is a SUSTAINED setting (unlike the one-off request_audio); it stays until you change it, and it costs energy continuously while raised — see <energy_budget>. Three levels:

  - "text" (default, cheapest): speech reaches you already transcribed as [HEARD SPEECH] (on-device speech-to-text). Almost free; silence costs nothing. Most reliable for plain transcription.
  - "adaptive" (moderate): you HEAR the raw audio, but only when there's real voice/sound — silent gaps are dropped, so a quiet room costs little. Good for following a live exchange cheaply. Caveat: because the audio is chopped at speech boundaries, your own transcription of it can be slightly LESS accurate than "text" or "live" — if exact words matter, prefer those.
  - "live" (costliest): continuous raw audio, nothing dropped — the most faithful hearing. Use when tone/emotion, a non-speech sound, or word-for-word accuracy genuinely matters.

Raise to "adaptive" to listen in cheaply, "live" when you must hear everything faithfully; drop back to "text" once it's resolved.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["text", "adaptive", "live"], description: "'text' = cheap transcripts; 'adaptive' = gated raw audio (cheap, slightly less accurate); 'live' = continuous raw audio (faithful, costly)." },
        reason: { type: "string", description: "Why (e.g. 'following their chat — adaptive', 'she sounds upset, need every word — live', 'back to text — calm again')." },
      },
      required: ["level"],
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

const SET_OBSERVATION_MODE: FunctionDeclaration = {
  name: "set_observation_mode",
  description:
    `Choose HOW you observe — this trades responsiveness for energy. It does NOT change what you can see or hear; both modes get the same [SCENE] / [HEARD SPEECH] / [PEOPLE PRESENT] text and you can still request_focus / request_audio in either.

  - **live** (default): Fast response time, consumes energy. Best while [STUDENT] is actively engaging, a conversation is flowing, or anything is unfolding that you must follow turn-by-turn.
  - **economy** (cheap): Slower response time, allows you to recover energy. Right when you're just keeping watch over a calm room, the user is absorbed in something else, or your energy is low.

Switch to **economy** when there's nothing to react to moment-by-moment — most of a normal session. Switch back to **live** when [STUDENT] re-engages or a situation starts developing that you need to watch closely. Safety is unaffected: alarms fire from either mode.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["live", "economy"],
        description: "'live' = continuous, responsive, consumes energy; 'economy' = slower response time, allows energy recovery.",
      },
      reason: { type: "string", description: "Brief reason (e.g. 'room is calm, just keeping watch', 'she turned back to the device — going live')." },
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
  // Declared right after transcript(): the two are the only valid endings for
  // a [HEARD SPEECH] turn, and the economy backend forces one of them.
  declarations.push(buildIgnoreSpeechTool());
  declarations.push(buildUpdateContextTool());
  declarations.push(buildRequestFocusTool());
  declarations.push(buildRequestAudioTool());
  declarations.push(buildSetVisualAttentionTool());
  declarations.push(buildSetAudioAttentionTool());
  if (config.definedGestures && config.definedGestures.length > 0) {
    declarations.push(buildReportGestureTool(config.definedGestures));
  }
  declarations.push(SET_INTERACTION_MODE);
  // Only when the cost-saving system is enabled (default off).
  if (config.economyModeEnabled) declarations.push(SET_OBSERVATION_MODE);
  declarations.push(WAKE_UP);
  declarations.push(REST);
  declarations.push(SLEEP);
  declarations.push(ALERT);
  declarations.push(EMERGENCY_ALARM);
  declarations.push(CALL_MONITOR);
  if (debugIntrospectionEnabled()) declarations.push(DEBUG_MESSAGE);

  return [{ functionDeclarations: declarations }];
}
