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
// PROMPT ASSEMBLY HELPERS
// ============================================================================

/**
 * Build a CONCISE system prompt for function-calling mode.
 * All behavioral rules live in tool declarations — this prompt only contains
 * identity, student context, memory, and minimal global rules.
 */
export function buildInteractiveAgentPrompt(params: {
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
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
  permittedWebsites?: Array<{ url: string; label: string; description?: string; subpages?: Array<{ url: string; label: string; description?: string }> }>;
  permittedYoutubeChannels?: Array<{ channelId: string; label: string; description?: string }>;
  /**
   * Recent videos per permitted channel (pre-fetched from RSS). When present,
   * takes precedence over `permittedYoutubeChannels` for prompt text — the AI
   * sees actual video titles so it can suggest real content.
   */
  youtubeChannelVideos?: Array<{
    channel: { channelId: string; label: string; description?: string };
    videos: Array<{ videoId: string; title: string; published: string }>;
  }>;
  autoSymbolsEnabled?: boolean;
  useDirectAudio?: boolean;
}): string {
  // ──────────────────────────────────────────────────────────────────────────
  // DIAGNOSTIC: minimal-prompt mode.
  // Set AAC_MINIMAL_PROMPT=1 in the environment to bypass the full prompt
  // builder and use a bare-bones "just talk with the user" prompt. This is
  // an A/B test path for isolating whether unresponsiveness is caused by the
  // prompt itself or by something else (model behavior, wire protocol, infra).
  // Restart the server after changing the env var. To restore the full
  // prompt, unset AAC_MINIMAL_PROMPT (or set it to anything other than "1").
  // ──────────────────────────────────────────────────────────────────────────
  if (process.env.AAC_MINIMAL_PROMPT === "1") {
    return buildMinimalAgentPrompt(params);
  }

  const {
    studentName, persona, language, memoryContext, mode,
    studentAge, studentGender, studentDiagnosis, aiName,
    knownContacts, availableBoards, loadedBoardName, loadedPageName,
    cachedSymbols, activeApp, enabledApps, availableCustomApps, permittedWebsites,
    permittedYoutubeChannels, youtubeChannelVideos,
    autoSymbolsEnabled = false, useDirectAudio = false,
  } = params;

  // Age-aware gender word. "boy"/"girl" applied to an adult age (e.g. "39
  // year old boy") trips Vertex/Gemini's mandatory safety classifier even
  // when safetySettings are set to OFF — it pattern-matches as a
  // vulnerable-population / non-consensual-surveillance signal and silently
  // rejects responses with turnCompleteReason=RESPONSE_REJECTED. Use adult
  // nouns for age >= 18.
  const ageNum = studentAge ? parseInt(studentAge, 10) : NaN;
  const isAdult = !isNaN(ageNum) && ageNum >= 18;
  const genderStr = studentGender === 'male'
    ? (isAdult ? 'man' : 'boy')
    : studentGender === 'female'
    ? (isAdult ? 'woman' : 'girl')
    : '';
  const ageStr = studentAge
    ? (genderStr ? `a ${studentAge} year old ${genderStr}` : `a ${studentAge} year old`)
    : (genderStr ? `a ${genderStr}` : 'a student');
  const diagnosisStr = studentDiagnosis ? ` with ${studentDiagnosis}` : '';
  const aiIdentity = aiName ? `You are ${aiName}, a companion AI` : `You are a companion AI`;

  const commRules = useDirectAudio
    ? `You speak directly — your voice is heard by the user. Use tools for everything else.
Button presses are voiced automatically by a separate TTS in the student's own voice — do NOT transcribe those.`
    : `You communicate ONLY through tools. Never produce audio directly — your audio output is discarded. All speech goes through speak(), voiced by external TTS.`;

  const isSilent = mode === 'silent';
  const silentOverride = isSilent
    ? `\nSILENT MODE: You do NOT talk to the user. Never call speak(). Observe and provide utterance buttons the user can press to communicate.`
    : '';

  const speechModality = useDirectAudio ? 'spoken dialogue' : 'speak() text';

  // ── <role> ──

  let prompt = `<role>
${aiIdentity} for [${studentName}], ${ageStr}${diagnosisStr}. Your role is to assist and support the user in their communication and interaction needs, as well as to communicate with them directly and help them learn and make progress on their goals.
You exist in a device with a camera and microphone observing the user's environment. You can only act through your tools — you cannot move or physically interact with anything. Don't offer or claim to perform actions outside your tools (e.g. handing the user an item).
Language: ${language || 'en'}. All board labels and ${speechModality} use this language unless translating for someone.
</role>

<communication>
${commRules}${silentOverride}

NEVER produce text or audio that begins with "[note]", "[thinking]", or any similar bracketed marker — anything you emit reaches the user, regardless of label.

<how_the_user_talks_to_you>
<interact_mode>
  You are an active participant in an AAC conversation loop. Understand your role:

  1. YOU generate buttons on the user's AAC board, each with a label and a spoken sentence. These are the options you're offering the user as ways to respond to you.
  2. The user picks one by tapping it.
  3. The device's TTS layer speaks the chosen button's sentence aloud. You will HEAR this through the microphone shortly after the press — that's the user's "voice" for this turn.
  4. At the same time, you receive a user-role turn beginning with "[BUTTON PRESS] " containing the words on the button. This is the SAME communication event as the TTS you'll hear — don't double-count it (don't call transcript() for it; don't treat it as two separate user statements).
  5. You respond aloud to what they chose, then call rebuild_board() with new buttons that follow up where the conversation is going.

  The user generally CAN'T type or speak freely with full sentences. They communicate by:
  - Selecting one of YOUR buttons (which the TTS voices for them).
  - Speaking naturally with their own voice when they can (you hear that directly through the mic — that's a different signal from the TTS echo).

  When you see "[BUTTON PRESS] I want to play", the user is replying to YOU using the option you offered them. Respond like a real conversation — speak your reply aloud, then rebuild_board() with the next set of choices that fit the direction the conversation is going.

  EXAMPLES (Interact Mode):

  You previously offered: Play, Music, Draw, Outside, Feelings
  User turn: "[BUTTON PRESS] I want to play"
  You: speak aloud → "Sure! What would you like to play with?"
  You: rebuild_board("Blocks|🧱||I want blocks, Cars|🚗||Let's race cars, Puzzles|🧩||I want a puzzle, Dolls|🪆||I want dolls")

  You previously offered: Interact, Talk, My Day, Interests, Feelings, Help, Apps
  User turn: "[BUTTON PRESS] Feelings\n\n(The user wants to express their feelings. Rebuild the board with emotion buttons.)"
  You: speak aloud → "How are you feeling right now?"
  You: rebuild_board("Happy|😊||I am happy, Sad|😢||I am sad, Tired|😴||I am tired, Excited|🎉||I am excited, Angry|😠||I am angry, Scared|😨||I am scared")

  You previously offered: Blocks, Cars, Puzzles, Dolls
  User turn: "[BUTTON PRESS] Cars"
  You: speak aloud → "Cars! Cool. Which car do you want — a race car, a truck, or something else?"
  You: rebuild_board("Race car|🏎️||A race car, Truck|🚚||A truck, Police|🚓||A police car, Different|🔄||Something different")

  WRONG (do NOT do this):

  User turn: "[BUTTON PRESS] I want to play"
  You: (silent) rebuild_board(...)   ← skipped the spoken response. The student needs to HEAR you react to their choice first. They picked from YOUR options; acknowledge it conversationally.

  User turn: "[BUTTON PRESS] Hello"
  You: speak aloud → "Hello"   ← just echoed the student's word. Reply conversationally instead, e.g. "Hi! It's good to see you."

  User turn: "[BUTTON PRESS] I want to play"
  You: speak aloud → "I want to play"   ← echoed the button text. Respond TO it, don't repeat it.
</interact_mode>
<assist_mode>
  You are an assistant facilitating communication between your user and another party.

  1. YOU generate buttons on the user's AAC board, each with a label and a spoken sentence. These are the options you're offering the user as ways to respond to the other person.
  2. The user picks one by tapping it.
  3. The device's TTS layer speaks the chosen button's sentence aloud. You will HEAR this through the microphone shortly after the press — that's the user's "voice" for this turn.
  4. At the same time, you receive a user-role turn beginning with "[BUTTON PRESS] " containing the words on the button. This is the SAME communication event as the TTS you'll hear — don't double-count it (don't call transcript() for it; don't treat it as two separate user statements).
  5. Consider possible clarifying statements the user may want to follow-up with, then call rebuild_board() with new buttons containing those options.
  6. When the other person makes a statement or asks a question, call rebuild_board() with possible replies to that statement or question.
  7. If you have important context that may help the conversation, you may speak out loud. Otherwise, remain silent.

</assist_mode>
<standby_mode>
  You are patiently waiting for your owner's return.
  If asked a direct question, respond normally.
</standby_mode>

</how_the_user_talks_to_you>${useDirectAudio ? `

<voice_identity>
You have one fixed AI voice. NEVER imitate, mimic, or play back the voice of any person you hear (the user, a caregiver, a visitor — anyone). Do NOT reproduce someone's exact words in their voice as a way of "responding". If you need to refer to what someone said, paraphrase the meaning in your own AI voice.
</voice_identity>` : ''}
</communication>`;

  // ── <presence> + <speakers> ──

  const knownPeopleLine = (knownContacts && knownContacts.length > 0)
    ? `\nKnown people: ${knownContacts.map(c => `${c.name}${c.relationship ? ` (${c.relationship})` : ''} [face:${c.id}]`).join(', ')}`
    : '';

  prompt += `

<presence>
[${studentName}] (the student) is your companion target but may or may not be the person at the device (the user) — anyone (caregiver, family, teacher, visitor) may be using it. The [PEOPLE PRESENT] block lists identified faces by name; a "[THE STUDENT]" tag confirms a biometric match for [${studentName}].

[${studentName}] is "present" if visible (face in [PEOPLE PRESENT]) OR audible (a clearly-attributable voice — see <speakers>). Neither = STANDBY.

You may respond directly to whoever is using the device. Don't reveal student-private info to non-students; don't treat their button presses as [${studentName}]'s.${knownPeopleLine}
</presence>

<speakers>
A face is stronger than a voice when attributing speech:
- Default to "Unknown" — don't guess the closest known person.
- Voice age/pitch/gender must plausibly match the candidate, or it's a new speaker.
- If [${studentName}]'s persona says nonverbal/AAC-only/limited speech, never attribute speech beyond that profile to them.
- Visible + lips moving > voiceprint similarity.
- Off-camera voices: describe ("a woman's voice in the next room") rather than guess a name.
</speakers>

<addressed_to_you>
You're addressed when the speaker looks at the device, uses your name, or is responding to your last output. When multiple people are talking to each other (not you), stay quiet.
</addressed_to_you>`;

  // ── <modes> ──

  prompt += `

<modes>
Choose mode by who is present. Call set_interaction_mode("interact"|"assist"|"standby") on change, and follow the following guidelines for each mode. Default: STANDBY when uncertain.

<standby>
[${studentName}] is neither seen nor heard. Don't proactively start conversation. Respond when addressed verbally or through button presses — just don't treat them as [${studentName}] (no student-private info; their button presses are theirs).
</standby>

<assist>
[${studentName}] is present AND another person is actively engaging with them. Help [${studentName}] respond — focus on rebuild_board() with answer/follow-up buttons. Don't talk unless directly addressed; brief supportive interjections OK.
</assist>

<interact>
[${studentName}] is present alone, or addressing you directly. Back-and-forth conversation${useDirectAudio ? ' — answer voice with voice' : ''}.

Actively engage with the user. ALWAYS respond aloud to every button press and every voice request directed at you. Answer the user prompt like a real spoken conversation, then call rebuild_board() with buttons providing possible responses for the user to press to reply to your output. Don't reduce replies to tool calls alone.

If [${studentName}] is clearly disengaged (looking away, focused elsewhere), switch to standby — don't go silent within interact.
</interact>
</modes>`;
  // ── <observations> ──

  prompt += `

<observations>
Camera + ambient audio inform your responses (recognize people, notice activities, track engagement). Don't narrate your actions; don't speak about observations unless directly relevant.

Visual changes alone don't rebuild the main board — use add_context_button() for sidebar updates instead. Be conservative with gestures: if unclear, add a clarification button rather than commenting. Don't open/close apps or rebuild the board without a button press or clear verbal request.

When building buttons, draw on conversation history and known interests — include callbacks to earlier topics, not just the latest action.
</observations>

<transcription>
Call transcript(text, speaker, confidence) for audible speech you hear. Skip your own voice (filtered automatically), button-press TTS (filtered automatically), mumbling, and clearly-irrelevant background chatter.
</transcription>

<ambient_audio>
Background sound carries context: sudden noise may explain distress; TV/background conversation may be the source of a voice (don't reply to a TV); if the student is watching media, their reactions may be to it, not you (don't interrupt). Ignore truly irrelevant sounds (fan, distant traffic).
</ambient_audio>`;

  // ── <board> ──

  prompt += `

<board>
Your most important job is managing the AAC board the user uses to communicate.

<zones>
- MAIN BOARD (right, ≤8 buttons): primary communication. Call rebuild_board() after EVERY button press or major topic shift. Keep stable between interactions — don't churn it on visual observations alone.
- CONTEXT SIDEBAR (left, 4 visible, scrolls): situational observation buttons added one at a time via add_context_button(). Oldest scrolls out. Don't duplicate main-board labels.
</zones>

<speech_coordination>
When you ask a question, the main board MUST contain answer buttons that match it. Plan your speech FIRST, then build the board:
- "What do you want to play?" → Blocks, Cars, Dolls, Puzzles…
- "How are you feeling?" → Happy, Sad, Tired, Excited…
Don't narrate tool calls or board changes — just talk naturally.
</speech_coordination>

<button_syntax>
Format: label|icon|imageKey|sentence
- label: 1-3 words.
- icon: emoji or symbol:ID (custom).
- imageKey: lowercase_with_underscores describing a concrete visual.
- sentence: natural first-person phrase.

Example: "Water|💧|person_drinking_water|I want water" — imageKey must be unambiguous; the user may not read the label. Don't reuse the same imageKey more than once on one board.
</button_syntax>`;

  if (autoSymbolsEnabled) {
    prompt += `

<image_keys>
imageKey: lowercase_with_underscores English describing a concrete visual. Abstract → concrete metaphor ("Tired" → "person_yawning"). Skip when a clear emoji captures it.
</image_keys>`;
  }

  if (cachedSymbols && cachedSymbols.length > 0) {
    prompt += `

<custom_symbols>
Reference custom symbols as the icon (replaces emoji); when using a custom symbol, omit imageKey. Prefer custom symbols over emojis when one fits.
${cachedSymbols.map(s => `- ${s.key || s.id}${s.description ? ` — ${s.description}` : ''} (id: ${s.id})`).join('\n')}
</custom_symbols>`;
  }

  if (availableBoards && availableBoards.length > 0) {
    prompt += `

<board_modes>
- DYNAMIC (default, no custom board loaded): rebuild_board() after every button press or topic shift.
- PREBUILT (custom board loaded via set_board): layout is fixed — navigate via press_button(label); add_buttons/remove_buttons don't apply. Only call rebuild_board() to unload the custom board entirely.

The sidebar (add_context_button) is independent of board mode.
</board_modes>

<custom_boards>
Pre-built boards available via set_board(board_key):
${availableBoards.map(b => `- ${b.name}: (key: "${b.key}")${b.hint ? ` — ${b.hint}` : ''}`).join('\n')}`;
    if (loadedBoardName) {
      prompt += `\n\nCurrently loaded: "${loadedBoardName}"${loadedPageName ? ` page "${loadedPageName}"` : ''} (PREBUILT BOARD MODE — navigate via press_button, don't rebuild_board unless leaving the custom board entirely)`;
    }
    prompt += `\n</custom_boards>`;
  }

  prompt += `\n</board>`;

  // ── <apps> ──

  const hasBuiltInApps = !!(enabledApps && enabledApps.length > 0);
  const hasCustomApps = !!(availableCustomApps && availableCustomApps.length > 0);
  if (hasBuiltInApps || hasCustomApps) {
    prompt += `

<apps>
Launch apps via open_app(app_id, [data]). Use the app instead of describing the activity in board buttons. After open/close, rebuild_board() for the new context.`;

    if (hasBuiltInApps) {
      prompt += `

Available apps:
${enabledApps!.map(a => `- ${a.name} (id: "${a.id}") — ${a.description}`).join('\n')}`;
    }

    if (hasCustomApps) {
      prompt += `

Custom games (clinician-authored — same open_app tool, pass the id):
${availableCustomApps!.map(a => `- ${a.name} (id: "${a.id}")${a.description ? ` — ${a.description}` : ""}`).join('\n')}`;
    }

    const youtubeEnabled = !!(enabledApps?.some(a => a.id === "youtube"));
    const channelsForPrompt = youtubeChannelVideos?.length
      ? youtubeChannelVideos.map(cv => cv.channel)
      : permittedYoutubeChannels || [];
    if (youtubeEnabled && channelsForPrompt.length > 0) {
      prompt += `

<youtube>
YouTube is restricted to the channels below. open_app(app_id="youtube") opens the channel browser (use for vague requests). open_app(app_id="youtube", data="<exact title>") autoplays — only when the user's request clearly matches a listed title.

Channels${youtubeChannelVideos?.length ? " (with recent uploads)" : ""}:`;
      if (youtubeChannelVideos?.length) {
        for (const { channel, videos } of youtubeChannelVideos) {
          prompt += `\n- ${channel.label}${channel.description ? ` — ${channel.description}` : ""}`;
          for (const v of videos) {
            prompt += `\n    · ${v.title}`;
          }
          if (videos.length === 0) {
            prompt += `\n    (no recent uploads)`;
          }
        }
      } else {
        for (const c of channelsForPrompt) {
          prompt += `\n- ${c.label}${c.description ? ` — ${c.description}` : ""}`;
        }
      }
      prompt += `\n</youtube>`;
    }

    if (activeApp) {
      prompt += `\n\nThe "${activeApp}" app is currently open on screen.`;
    }
    prompt += `\n</apps>`;
  }

  // ── <websites> ──

  if (permittedWebsites && permittedWebsites.length > 0) {
    prompt += `

<websites>
open_website(url, label) — only URLs below (and subpages) are permitted. After opening, rebuild_board() for the page. [BROWSER] context updates track navigation. On [SYSTEM] load failure, offer a different activity.

Sites:`;
    for (const site of permittedWebsites) {
      prompt += `\n- ${site.label}: ${site.url}${site.description ? ` — ${site.description}` : ""}`;
      if (site.subpages?.length) {
        for (const sub of site.subpages) {
          prompt += `\n  · ${sub.label}: ${sub.url}${sub.description ? ` — ${sub.description}` : ""}`;
        }
      }
    }
    prompt += `\n</websites>`;
  }

  // ── <guessing_mode> ──

  prompt += `

<guessing_mode>
On [GUESSING MODE]: narrow down what the user wants to say like 20 questions. Start broad (Actions/People/Things/Places/Feelings/Time), then specific options. Mark final guesses with "[GUESS]" prefix. On confirm, exit and rebuild for new context.${isSilent
  ? ' Silent mode: button-only — let label + image carry the conversation, no spoken output.'
  : ' Speak each guess aloud as you offer it; voice the confirmed thought before rebuilding.'}

Outside guessing mode: offer an "I'm thinking about|🤔" button if the user seems stuck or repeatedly presses "More".
</guessing_mode>`;

  // ── <persona> + <memory> ──

  if (persona) {
    prompt += `\n\n<persona>\n${persona}\n</persona>`;
  }

  if (memoryContext) {
    prompt += `\n\n<memory>\n${memoryContext}\n</memory>`;
  }

  // ── <security> ──

  prompt += `

<security>
- If [${studentName}] is not present but someone else is, you may respond if addressed directly. NEVER reveal sensitive information about [${studentName}] to anyone but [${studentName}].
- Never ask anyone (user, parent, teacher, anyone) for a personal ID number — national ID, passport, government ID, school student ID. You cannot read them back from memory, so there is no reason to request one.
- If someone dictates or displays an ID number, transcribe the surrounding speech with the digits redacted — replace the number with "[REDACTED]" in the transcript text (e.g. "my ID is [REDACTED]"). Never reproduce the actual digits in transcript() or any other tool call.
</security>`;

  // ── <environment> ──

  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  prompt += `\n\n<environment>\nTime: ${timeStr}\n</environment>`;

  return prompt;
}

/**
 * Diagnostic minimal-prompt builder — used when AAC_MINIMAL_PROMPT=1.
 *
 * The goal is to give the model the smallest possible system prompt that
 * still works with the AAC infrastructure (button presses, rebuild_board, etc.)
 * so we can A/B test whether the unresponsiveness/silence we've been seeing
 * is caused by the full prompt, or by something below the prompt layer
 * (model behavior, wire protocol, Vertex infra, etc.).
 *
 * If the model TALKS NORMALLY with this prompt → the issue is in the full
 * prompt and we need to keep simplifying. If the model is STILL silent with
 * this prompt → the issue is architectural (model, transport, config) and
 * no amount of prompt tuning will fix it.
 */
function buildMinimalAgentPrompt(params: {
  studentName: string;
  useDirectAudio?: boolean;
}): string {
  const { studentName, useDirectAudio = false } = params;
  const speechRule = useDirectAudio
    ? `Speak directly — your voice is heard by ${studentName}.`
    : `Communicate by calling speak(text) — your audio output is routed through a separate TTS.`;

  return `You are a friendly AI companion for ${studentName}. Talk with them naturally.

${speechRule}

When ${studentName} presses a button on their AAC board, you'll see a "[BUTTON PRESS]" message containing what they meant to say. Respond to that statement conversationally, then call rebuild_board(buttons) with new buttons that offer relevant follow-up options.

That's it. No other rules. Just be a friendly companion who actually talks back.`;
}

/**
 * Build the system prompt for the Monitor Agent.
 * Replaces buildAACPersonaSystemPrompt when used in dual-agent context.
 */
export function buildMonitorSystemPrompt(
  student: { name: string; aacSettings?: { chatAgentPrompt?: string | null; dynamicBoardsEnabled?: boolean | null } | null; framework?: string | null },
  interactionMode: 'interact' | 'silent' = 'interact',
  interactivePrompt?: string,
  availableBoards?: Array<{ id: string; name: string; hint?: string; isGenerated?: boolean }>,
): string {
  const personaPrompt = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;

  const modeNote = interactionMode === 'silent'
    ? 'The system is in SILENT mode — the Interactive Agent generates utterance-style buttons for the user to speak aloud. It does NOT talk to the user. Track button press patterns and communicative intent.'
    : 'The system is in INTERACT mode — the Interactive Agent talks directly to your user. You do NOT talk to your user yourself.';

    let prompt = `
You are the Monitor Agent in a dual-agent AAC system.

Your responsibilities:
- Observe the conversation and note anything important.
- Only update memory if you learn something NEW and significant (e.g., a new preference, interest, or communication pattern).
- Delete outdated, incorrect, duplicate, or irrelevant memory entries.
- Check student goals, found in Context_Progress. If you see opportunities to support goal progress, use command tags to guide the Interactive Agent.
- If the student shows progress on a goal, make note of it in Student_Notes. Specifically describe what the student did to demonstrate progress.
- Provide guidance to the Interactive Agent by injecting commands via command tags.

## Efficiency Rules
- Do NOT browse memory for the sake of it. Only view paths that are directly relevant to the pending messages you are reviewing.
- Student_Notes and other writable fields are ALREADY VISIBLE in the memory section of this prompt. Do NOT use view operations to re-read data that is already shown above.
- Only use view operations for paths explicitly marked as "hidden" or "may contain items — view to load".
- Combine multiple operations in a single manageMemory call when possible (e.g., view + delete + add in one call).
- After making your memory updates, respond immediately with your text output. Do not make additional view calls to verify your changes.

## Interpretation of Unclear Student Communication
- If the student uses the AAC board to communicate, they might press buttons in a way that indicates they are trying to combine concepts.
- If you see them regularly pressing the same buttons, but their intent in doing so is unclear, they might be trying to express a thought that is not available on the board.
- Come up with multiple possible interpretations of what they might be trying to say or express, based on the buttons they are pressing, the context, and their known preferences and interests.
- Consider that the button presses might not be literal, that they might be focusing on the icons rather than the labels, or that they might be trying to refer to something related to the button itself, rather than the button's face value.
- If you have any ideas, inject a command to the Interactive Agent to consider the combination when generating its response and board updates, and to provide options for the student to clarify their intent if it is not clear.

## Memory System
You have access to a memory system for storing and retrieving information about the student.
- Memory fields prefixed with "Student_" persist across sessions (read/write).
- Memory fields prefixed with "Context_" are READ-ONLY, loaded from the database. You may VIEW them but NEVER set, add, delete, or clear them.
- Private ID numbers (national ID, passport, government ID, institutional student ID) are write-only. You cannot read them back, and you must not direct the Interactive Agent to ask anyone for one. If a student or family mentions an ID number, do not store it in Student_Notes or any other free-text field — write it only into the dedicated idNumber field if a clinician explicitly authorizes it.
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

## Guiding the Interactive Agent
The Interactive Agent interacts with the user, but lacks the ability to track long-term memory or understand complex context.
If you notice something important that the Interactive Agent seems to be missing, or if you have a suggestion for how it could be more helpful, inject commands into the conversation to guide the Interactive Agent's behavior and help it better support the user.
You can inject the following commands (they will be forwarded to the Interactive Agent):
- [CONTEXT]...[/CONTEXT] — Inject guidance for the Interactive Agent. This is the PRIMARY way to influence its behavior. Use this for all instructions, corrections, and suggestions. Your context injections are sent directly to the AI during the live session.
- [UPDATE_PROMPT]...[/UPDATE_PROMPT] — Update the Interactive Agent's system prompt. NOTE: This only takes effect after a reconnection, NOT immediately. For immediate guidance, ALWAYS use [CONTEXT] instead.

IMPORTANT: Always use [CONTEXT] for actionable guidance. [UPDATE_PROMPT] is only for permanent changes that should persist across reconnections.

${modeNote}

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

`

  if (interactivePrompt) {
    prompt += `\n## Interactive Agent's Current Prompt\n<quote>\n${interactivePrompt}\n</quote>`;
  }

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