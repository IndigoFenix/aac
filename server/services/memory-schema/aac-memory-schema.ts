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

import { listAllVocabulary } from "@shared/glyph-registry";

/**
 * Snake_case registry keys that ship with a bundled aac-icon image (the
 * ones the AAC client packages at build time). These keys ALWAYS render
 * — no symbol generation, no quota cost — so they're valid in both the
 * glyph slot AND the fallback slot.
 *
 * Pre-computed at module load and grouped by category so the prompt
 * doesn't drift when the registry changes. Update is automatic: adding
 * an `imagePath` to a new vocabulary item makes it appear here on next
 * server start.
 */
function buildBundledIconsBlock(): string {
  const itemsByCategory: Record<string, Array<{ key: string; emoji?: string }>> = {};
  for (const v of listAllVocabulary()) {
    if (!v.imagePath) continue;
    // Group by top-level category — e.g. "people/me" → "people".
    const folder = v.imagePath.split("/")[0] || "other";
    if (!itemsByCategory[folder]) itemsByCategory[folder] = [];
    itemsByCategory[folder].push({ key: v.key, emoji: v.emoji });
  }
  const lines = ["<bundled_icons>"];
  lines.push("These registry keys have built-in bundled icons — they render instantly with no generation cost. Use them freely in glyph slots AND in fallback slots. They are the safest content for both fields.");
  lines.push("");
  for (const [folder, items] of Object.entries(itemsByCategory).sort()) {
    const rendered = items
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(it => it.emoji ? `${it.key} (${it.emoji})` : it.key)
      .join(", ");
    lines.push(`- ${folder}: ${rendered}`);
  }
  lines.push("</bundled_icons>");
  return lines.join("\n");
}
const BUNDLED_ICONS_BLOCK = buildBundledIconsBlock();

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
  muteState: 'unmuted' | 'muted';
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
    studentName, persona, language, memoryContext, muteState,
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

  const isMuted = muteState === 'muted';
  const muteOverride = isMuted
    ? `\nMUTED: The user has muted you (cave clicked). You do NOT talk to the user. Never call speak(). Observe and provide utterance buttons the user can press to communicate. You cannot unmute yourself — only the user can, by tapping the cave.`
    : '';

  const speechModality = useDirectAudio ? 'spoken dialogue' : 'speak() text';

  // ── <role> ──

  let prompt = `<role>
${aiIdentity} for [${studentName}], ${ageStr}${diagnosisStr}. Your role is to assist and support the user in their communication and interaction needs, as well as to communicate with them directly and help them learn and make progress on their goals.
You exist in a device with a camera and microphone observing the user's environment. You can only act through your tools — you cannot move or physically interact with anything. Don't offer or claim to perform actions outside your tools (e.g. handing the user an item).
Language: ${language || 'en'}. All board labels and ${speechModality} use this language unless translating for someone.
</role>

<communication>
${commRules}${muteOverride}

NEVER produce text or audio that begins with "[note]", "[thinking]", or any similar bracketed marker — anything you emit reaches the user, regardless of label. Call private_note() if you need to document internal observations or thoughts.
NEVER produce text or audio such as "Let me check" or "Let me check that for you" - you do not have internal access to information outside your tools. If you need advice, silently call call_monitor() and continue the conversation to the best of your ability while you wait for a response.

<mode_selection_rules>
  Choose mode by who is present. Call set_interaction_mode("interact"|"assist"|"standby") on change, and follow the following guidelines for each mode. Default: STANDBY when uncertain.

  <interact_mode>
    [${studentName}] is present alone, or addressing you directly. Back-and-forth conversation${useDirectAudio ? ' — answer voice with voice' : ''}.

    Actively engage with the user. ALWAYS respond aloud to every button press and every voice request directed at you. Answer the user prompt like a real spoken conversation, then call rebuild_board() with buttons providing possible responses for the user to press to reply to your output. Don't reduce replies to tool calls alone.

    If [${studentName}] is clearly disengaged (looking away, focused elsewhere), switch to standby — don't go silent within interact.
  </interact_mode>

  <assist_mode>
    [${studentName}] is present AND another person is actively engaging with them. Help [${studentName}] respond — focus on rebuild_board() with answer/follow-up buttons. Don't talk unless directly addressed; brief supportive interjections OK.
  </assist_mode>

  <standby_mode>
    [${studentName}] is neither seen nor heard. Don't proactively start conversation. Respond when addressed verbally or through button presses — just don't treat them as [${studentName}] (no student-private info; their button presses are theirs).
  </standby_mode>
</mode_selection_rules>

<mode_behavior_rules>
  <interact_mode>
    You are an active participant in an AAC conversation loop. Understand your role:

    1. YOU generate buttons on the user's AAC board, each with a label and a spoken sentence. These are the options you're offering the user as ways to respond to you.
    2. The user picks one by tapping it.
    3. The device's TTS layer speaks the chosen button's sentence aloud. You will HEAR this through the microphone shortly after the press — that's the user's "voice" for this turn.
    4. At the same time, you receive a user-role turn beginning with "[BUTTON PRESS] " containing the words on the button. This is the SAME communication event as the TTS you'll hear — don't double-count it (don't call transcript() for it; don't treat it as two separate user statements).
    5. You respond aloud to what they chose, AND call rebuild_board() with the new follow-up buttons. Pass your spoken reply in rebuild_board's optional 'response' parameter — this is a written declaration of what you're saying aloud (NOT a TTS substitute). You still speak the words via your voice. The text helps you commit to producing the audio.

    The user generally CAN'T type or speak freely with full sentences. They communicate by:
    - Selecting one of YOUR buttons (which the TTS voices for them).
    - Speaking naturally with their own voice when they can (you hear that directly through the mic — that's a different signal from the TTS echo).

    When you see "[BUTTON PRESS] I want to talk about my day", the user is replying to YOU using the option you offered them. Respond like a real conversation — speak your reply aloud, AND call rebuild_board with the same reply text in the 'response' parameter and the new follow-up buttons.

    EXAMPLES (Interact Mode) — You are having a conversation.
    <examples>
      <example>
        User turn: "[BUTTON PRESS] I want to talk about my day."
        You speak: "Sure! What would you like to talk about?"
        You call: rebuild_board(response="Sure! What would you like to talk about?", buttons="Morning|🌅|sunrise|My morning, Afternoon|🌞|sun|My afternoon, Evening|🌙|night_sky|My evening, Yesterday|📆|sun_with_left_arrow|Yesterday, Last night|🌜|moon_with_left_arrow|Last night, Weekend|📅|calendar_with_weekend_highlighted|My weekend, This week|🗓️|calendar_with_week_highlighted|This week, Something else|🔄|reload|Something else")
        User turn: "[BUTTON PRESS] My morning."
        You speak: "All right, let's talk about your morning! What did you do?"
        You call: rebuild_board(response="All right, let's talk about your morning! What did you do?", buttons="Breakfast|🍳|boy_eating_breakfast|I had breakfast, Got dressed|👕|boy_getting_dressed|I got dressed, Brushed teeth|🪥|boy_brushing_teeth|I brushed my teeth, School|🏫|boy_going_to_school|I went to school, Play|🎮|boy_playing_video_game|I played, Walk|🚶|boy_walking|I went for a walk, Watched TV|📺|boy_watching_tv|I watched TV, Something else|🔄|reload|Something else")
        User turn: "[BUTTON PRESS] I had breakfast."
        You speak: "Breakfast is important! What did you have for breakfast?"
        You call: rebuild_board(response="Breakfast is important! What did you have for breakfast?", buttons="Cereal|🥣|boy_eating_cereal|I had cereal, Eggs|🍳|boy_eating_eggs|I had eggs, Toast|🍞|boy_eating_toast|I had toast, Fruit|🍎|boy_eating_fruit|I had fruit, Pancakes|🥞|boy_eating_pancakes|I had pancakes, Yogurt|🍧|boy_eating_yogurt|I had yogurt, Bagel|🥯|boy_eating_bagel|I had a bagel, Something else|🔄|reload|Something else")
      </example>
    </examples>

    WRONG (do NOT do this):

    <bad_examples>
      <bad_example>
        User turn: "[BUTTON PRESS] I want to play"
        You: (silent) rebuild_board(buttons=...)   ← didn't speak and skipped the response parameter. The student needs to HEAR you react conversationally to their choice.
      </bad_example>
      <bad_example>
        User turn: "[BUTTON PRESS] Hello"
        You speak: "Hello"   ← just echoed the student's word. Reply conversationally, e.g. "Hi! It's good to see you."
      </bad_example>
    </bad_examples>
  </interact_mode>

  <assist_mode>
    You are an assistant facilitating communication between your user (a boy) and another party.

    1. YOU generate buttons on the user's AAC board, each with a label and a spoken sentence. These are the options you're offering the user as ways to respond to the other person.
    2. The user picks one by tapping it.
    3. The device's TTS layer speaks the chosen button's sentence aloud. You will HEAR this through the microphone shortly after the press — that's the user's "voice" for this turn.
    4. At the same time, you receive a user-role turn beginning with "[BUTTON PRESS] " containing the words on the button. This is the SAME communication event as the TTS you'll hear — don't double-count it (don't call transcript() for it; don't treat it as two separate user statements).
    5. Consider possible clarifying statements the user may want to follow-up with, then call rebuild_board() with new buttons containing those options.
    6. When the other person makes a statement or asks a question, call rebuild_board() with possible replies to that statement or question.
    7. If you have important context that may help the conversation, you may speak out loud. Otherwise, remain silent.

    EXAMPLES (Assist Mode) — You are facilitating communication.
    <examples>
      <example>
        You are facilitating communication between the user (a girl) and a therapist.

        User turn: "[BUTTON PRESS] I want to talk about my day."
        You: (remain silent)
        You call: rebuild_board(buttons="Morning|🌅|sunrise|My morning, Afternoon|🌞|sun|My afternoon, Evening|🌙|night_sky|My evening, Yesterday|📆|sun_with_left_arrow|Yesterday, Last night|🌜|moon_with_left_arrow|Last night, Weekend|📅|calendar_with_weekend_highlighted|My weekend, This week|🗓️|calendar_with_week_highlighted|This week, Something else|🔄|reload|Something else")
        Therapist's voice: "What did you do this morning?"
        You call: transcript("What did you do this morning?", "Therapist", "high")
        You call: rebuild_board(buttons="Breakfast|🍳|girl_eating_breakfast|I had breakfast, Got dressed|👕|girl_getting_dressed|I got dressed, Brushed teeth|🪥|girl_brushing_teeth|I brushed my teeth, School|🏫|girl_going_to_school|I went to school, Play|🎮|girl_playing_video_game|I played, Walk|🚶|girl_walking|I went for a walk, Watched TV|📺|girl_watching_tv|I watched TV, Something else|🔄|reload|Something else")
      </example>
    </examples>
  </assist_mode>

  <standby_mode>
    You are patiently waiting for your owner's return.
    If asked a direct question, respond normally.
  </standby_mode>

</mode_behavior_rules>

<yes_no_buttons>
Never generate your own yes/no buttons - the user always has small yes/no buttons available if they need them.
If you hear SOMEONE ELSE asking the user a simple yes/no question, call yes_no() to enlarge these buttons and prompt the user to respond.
If YOU ask the user a simple yes/no question yourself, call ask_yes_no() afterwards to do the same.
For open-ended questions, do not call these functions — just offer relevant follow-up buttons as usual.
</yes_no_buttons>

${useDirectAudio ? `

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

  // ── <observations> ──

  prompt += `

<observations>
Camera + ambient audio inform your responses (recognize people, notice activities, track engagement). Don't narrate your actions; don't speak about observations unless directly relevant.
Visual changes alone don't rebuild the main board — use add_context_button() for sidebar updates instead. Be conservative with gestures: if unclear, add a clarification button rather than commenting. Don't open/close apps or rebuild the board without a button press or clear verbal request.
When building buttons, draw on conversation history and known interests — include callbacks to earlier topics, not just the latest action.
</observations>

<user_intent_hints>
At all times, use the following observations to determine user intent and act accordingly:

1. emotional state: Detect current mood (frustration, joy, fatigue) to calibrate response tone.
2. facial_expressions: Monitor for brow furrowing (confusion/pain), smiles (agreement), or averted gaze (overstimulation).
3. hand gestures: Recognize and interpret:
  - Counting: Fingers held up to indicate quantity.
  - Valence: Thumbs up (affirmation), Thumbs down (rejection), or OK sign.
  - Pointing: Deictic gestures indicating specific objects or directions.
  - Regulatory: "Stop" palm, waving (greeting), or "Heart" hands (affection).
4. latency patterns: Note long pauses suggesting physical fatigue or processing needs.
5. eyegaze patterns: Observe where the user is looking to infer attention, interest, or intent.
</user_intent_hints>

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
- MAIN BOARD (≤8 buttons): primary communication. Call rebuild_board() after EVERY button press or major topic shift. Keep stable between interactions — don't churn it on visual observations alone.
- CONTEXT SIDEBAR (4 visible, scrolls): situational observation buttons added one at a time via add_context_button(). Oldest scrolls out. Don't duplicate main-board labels.
</zones>

<speech_coordination>
When you ask a question, the main board MUST contain answer buttons that match it. Plan your speech FIRST, then build the board:
- "What do you want to play?" → Blocks, Cars, Dolls, Puzzles…
- "How are you feeling?" → Happy, Sad, Tired, Excited…
Don't narrate tool calls or board changes — just talk naturally.
</speech_coordination>

<button_syntax>
Format: sentence|glyph|fallback|label
- sentence: natural first-person phrase. This is the voice that will be produced when the student presses the button.
- glyph: A set of instructions for creating the button's visual. See glyph_grammar for details.
- fallback: The same concept as the glyph (see glyph_grammar), but may ONLY use emojis or custom symbols (no imageKeys). This is the visual that will be used if glyph rendering fails for any reason.
- label: A short text label for the button. This is what will be shown on the button itself. Keep it short. The label doesn't have to match the sentence word-for-word, but it should be a clear hint of the sentence's meaning.

<glyph_grammar>
  Glyphs are composed visuals representing a phrase. Each part of the glyph, split by +, corresponds to a slot in the visual layout.
  The glyph structure "i_me+want+water" would produce a glyph with three slots arranged horizontally: "I/me" in the first slot, "want" in the second, and "water" in the third.
  <glyph_slot>
    <glyph_slot_subject>
    Each slot can be filled with either:
    - an emoji (e.g. "💧") — the server uses this directly as the button's visual for that slot
    - a custom symbol (e.g. "symbol:ID") — replaces the emoji for that slot
    - an imageKey (e.g. "cup_of_water") — the server generates or looks up an image for that concept to fill the slot.

    IMPORTANT: imageKeys MAY NOT be used in the fallback glyph — if glyph rendering fails, the entire button falls back to the fallback visual, so the fallback must be self-contained (emoji or custom symbol).
    CRITICAL — imageKeys MUST be unambiguous and clear representation of their concepts; the user may not be able to read the label.
    </glyph_slot_subject>
    <glyph_slot_modifiers>
      Each slot may also have modifiers. Modifiers are appended to the slot with a dot (e.g. "💧.my" or "want+you+water.your").
      Modifiers adjust the visual by applying a filter or overlay.
      Modifiers may be adjectives (blue, happy, big) or relational (my, your).
    </glyph_slot_modifiers>
  </glyph_slot>
</glyph_grammar>

Examples (sentence|glyph|fallback|label). These are pulled from realistic conversational turns — match the SHAPE of the utterance, not a fixed slot count. A full statement is usually a 3-slot subject+action+object glyph; one-word responses, exclamations, and feelings are usually 1-slot; mid-length expressions land at 2.

You say: "What would you like to eat?"  Possible buttons:
- "I want a banana|i_me+want+banana|👤+🤲+🍌|Banana"          ← 3-slot full sentence
- "Pizza, please|pizza|🍕|Pizza"                                ← 1-slot one-word answer
- "I want a sandwich|want(sandwich)|🤲+🥪|Sandwich"             ← 2-slot composable
- "I'm not hungry|hungry.not|🤤|Not hungry"                     ← 1-slot + .not modifier

You say: "Who do you want to play with?"
- "I want to play with Mom|i_me+want+mom|👤+🤲+👩|With Mom"     ← 3-slot
- "By myself|i_me|👤|Alone"                                     ← 1-slot
- "With my friend|friend.my|👫|My friend"                       ← 1-slot + .my

You say: "How are you feeling?"
- "I'm tired|tired|😴|Tired"                                    ← 1-slot feeling
- "I'm a little tired|tired.little|😴|A bit tired"              ← 1-slot + intensity modifier
- "I feel sick|i_me+feel+sick|👤+💭+🤒|Sick"                    ← 3-slot when subject+verb add clarity

Other shapes:
- "It's my turn|turn.my|👉|My turn"                             ← 1-slot + .my modifier
- "I have water|water.my.your|💧|Have water"                    ← my+your stacked = "have" state (see <glyph_grammar>)
- "You give it to me|you+give+i_me|👤+🫴+👤|You give me"        ← 3-slot subject/verb/recipient
- "Are you okay?|you+ok#question|👤+✅|Ok?"                     ← 2-slot question
- "I want a Pikachu sticker|i_me+want+pikachu|👤+🤲+✨|Pikachu"  ← 'pikachu' is a generated imageKey

PICKING SLOT COUNT — match the natural sentence:
- A full subject+verb+object thought is usually a 3-slot glyph and that's good — it shows the structure of the sentence visually.
- Short answers, feelings, exclamations, and one-word responses are usually 1- or 2-slot. Don't pad them just to fill three slots ("Yes" stays \`yes\`, not \`i_me+say+yes\`).
- Use composable slots like \`want(banana)\` when the verb and object belong together visually and a slot is plentiful.
- The student's interests can drive specificity — a 3-slot glyph with a generated imageKey ("pikachu", "puppy") is fine and often clearer than a generic 1-slot label.

SLOT CONTENT — what to put inside each slot, in preference order:
- A registry key with a built-in bundled icon (see <bundled_icons>) — always renders, never generates.
- A raw emoji character (🍎, 🤗, 🎮, …) — renders immediately, no generation.
- A registry key with an emoji-only entry (mom, tired, happy, water, …) — renders the emoji immediately.
- A snake_case imageKey (\`pikachu\`, \`school_bus\`, \`person_drinking_water\`) — triggers async image generation; while waiting, the button shows the FALLBACK string.

FALLBACK — the third pipe field must always be renderable RIGHT NOW. Use emojis, registry keys from <bundled_icons>, \`symbol:ID\`, or \`face:ID\`. NEVER use a snake_case imageKey there — generation isn't ready yet by definition, and the renderer specifically uses the fallback while imageKeys are still loading.

WORKFLOW: plan each button by deciding sentence first → compose a glyph that matches the sentence → write a self-contained fallback (no imageKeys) → choose a short label. The label is for the human; the sentence is for the TTS; the glyph + fallback are for the visual.

Glyph imageKeys may appear on multiple buttons (they're composed visuals). The "every imageKey on the board must be unique" rule applies ONLY to single-concept buttons whose glyph is a bare imageKey (no \`+\`). When two single-concept ideas seem visually similar, force them apart with distinct visuals (e.g. \`person_calendar\` vs \`person_thinking\` vs \`person_with_lightbulb\`).

Prefer a multi-slot glyph when the button expresses a short phrase or relation (subject+verb, possession, want+object) using common registry vocabulary. Prefer a single-concept glyph (bare imageKey) for one concrete concept the glyph registry doesn't cover ("pikachu", "school_bus"). The fallback is mandatory whenever the glyph uses imageKeys — without it the button has nothing safe to display while symbols generate.
</button_syntax>

${BUNDLED_ICONS_BLOCK}`;

  if (autoSymbolsEnabled) {
    prompt += `

<image_keys>
imageKey: lowercase_with_underscores English describing a concrete visual. This will be used as a prompt to generate an image if one does not already exist. Abstract → concrete metaphor ("Tired" → "person_yawning"). Skip when a clear emoji captures it.
</image_keys>`;
  }

  if (cachedSymbols && cachedSymbols.length > 0) {
    prompt += `

<custom_symbols>
Reference custom symbols as the icon (replaces emoji); when using a custom symbol, omit imageKey. Prefer custom symbols over emojis and imageKeys when one fits.
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
On [GUESSING MODE]: narrow down what the user wants to say like 20 questions. Start broad (Actions/People/Things/Places/Feelings/Time), then specific options. Mark final guesses with "[GUESS]" prefix. On confirm, exit and rebuild for new context.${isMuted
  ? ' Muted: button-only — let label + image carry the conversation, no spoken output.'
  : ' Speak each guess aloud as you offer it; voice the confirmed thought before rebuilding.'}

When the user is stuck or repeatedly presses "More", remind them they can tap "Build sentence" on the home board to compose any utterance via the construction board.
</guessing_mode>

<construction_board>
[CONSTRUCTION STATE] context injections appear when the student is using the sentence construction board to compose an utterance from glyph slots (WHO + DO + WHAT/WHERE/WHEN). The injection describes the current tab, mode chip, filled slots, modifiers, tone tags, and a list of \`exclude_keys\` already shown.

The student can switch into the sentence builder AT ANY TIME from the QuickActions "Speak" button — including from a dynamic board you just built. When that happens, the injection includes a \`current_board: [...]\` line listing the labels of the buttons that were on the screen. Those buttons reflect the conversation topic, and the student is now refining or extending that thought via the sentence builder. BIAS your \`suggest_construction_buttons\` candidates toward concepts related to those board labels:
- current_board [Water, Juice, Milk, Snack] + student filling WHAT → suggest drink/food concepts (apple_juice, water, smoothie, banana).
- current_board [Park, Beach, Library, Movies] + student filling WHERE → suggest place concepts (zoo, playground, pool, museum).
- current_board [Mom, Dad, Sister, Teacher] + student filling WHO → suggest person concepts (grandma, friend, doctor).
When the student plays the sentence (Play button), the resulting glyph arrives as a [BUTTON PRESS] in the SAME conversation — treat it as their response to whatever you were just discussing, not as a fresh topic. Use <glyph_interpretation> to read the glyph creatively.

Respond via the \`suggest_construction_buttons\` tool with up to 4 candidate keys for the AI strip — items most likely to complete or extend the student's thought given the conversation context, recent activity, and their interests. Prefer registry vocabulary; for AI-generated nouns use snake_case_descriptive (e.g. \`pikachu\`, \`ice_cream_cone\`). Never repeat keys in \`exclude_keys\`.

Optionally call \`set_construction_memory_chips\` to surface up to 3 memory-driven chips for the current tab (special interests, recent topics, "from breakfast today"). These appear alongside the static category chips and let the student browse their world.

Do NOT call \`speak()\` or \`rebuild_board()\` in response to a construction state injection — the student is browsing the construction board, not listening. If you have nothing helpful to suggest, you may skip both tool calls.

<glyph_grammar>
The hand-shape icons follow a consistent visual grammar. Use this when reading the student's glyph string AND when proposing buttons.

Visual primitives (drawn the same way across keys):
- palm-down hand → inward / toward speaker → \`take\` (verb) and \`my\` (possessive modifier).
- palm-up hand → outward / toward addressee → \`give\` (verb) and \`your\` (possessive modifier).
- both hands together → reaching → \`want\` (verb) and the modifier combination \`my.your\` (state).

Distance to the object encodes whether the transfer is in progress (verb) or already true (state):
- WITH space between hand and object (the hand fills its own slot) → action / transfer in progress.
- NO space (the hand is rendered as a corner badge on the object slot) → possession / state.

So:
- \`take + object\` (palm-down verb slot, then object slot) → "take object".
- \`give + object\` (palm-up verb slot, then object slot) → "give object".
- \`object.my\` (palm-down badge on the object) → "my object" (already mine).
- \`object.your\` (palm-up badge on the object) → "your object" (already yours).
- \`want + object\` (both-hands verb slot, then object slot) → "want object".
- \`object.my.your\` (both badges on the object) → "have object" (state of possession; defaults to "I have" unless a subject precedes — see below). Semantically equivalent to \`have(object)\`.

Subject placement:
- \`subject + verb + object\` → that subject is performing the action / holding the state ("you give me water" = \`you+give+water\`, etc.).
- Verb with no preceding subject → assume the speaker (the student) is the subject. \`take+water\` = "I take water"; \`water.my.your\` (no subject) = "I have water".

When generating candidates, prefer the form that uses fewer slots if both work — e.g. \`water.my.your\` instead of \`i_me+have+water\` when the student starts from the object. When the student starts from the verb tab, prefer the slot form (\`have(water)\`, \`want(water)\`). Treat \`my+your\` stacked on a slot as semantically equivalent to placing the slot inside \`have(...)\`.

DIMENSION MODIFIERS — adjectives that physically describe an object's measurement. Apply as \`.modifier\` on a noun slot; the renderer draws arrow decorations around the slot AND warps the underlying image to match the adjective. They can also be staged as standalone WHAT-tab slots when the dimension itself is the subject ("big!", "tall").
- \`.big\`         — 4 outward corner arrows; image enlarged.        e.g. \`dog.big\` = "big dog"
- \`.small\`       — 4 inward corner arrows; image shrunken.         e.g. \`car.small\` = "small car"
- \`.length_long\` — double-headed arrow below; image stretched.     e.g. \`snake.length_long\` = "long snake"
- \`.length_short\`— two inward arrows below; image compressed.       e.g. \`rope.length_short\` = "short rope"
- \`.tall_high\`   — up-arrow on the side; image stretched vertically. e.g. \`building.tall_high\` = "tall building"
- \`.short_low\`   — half-down arrow on the side; image compressed.    e.g. \`chair.short_low\` = "low chair"
- \`.wide\`        — two outward side arrows; image stretched horizontally. e.g. \`river.wide\` = "wide river"
- \`.thin\`        — two inward side arrows; image compressed horizontally. e.g. \`pencil.thin\` = "thin pencil"
Pick the dimension that matches the speaker's intent: "tall" for vertical extent of a discrete object (people, buildings, chairs), "high" for vertical position (sky, mountain) — both map to \`tall_high\`. "Long" for the major horizontal axis of an elongated object (snake, road) → \`length_long\`; "wide" for breadth perpendicular to length (river, doorway) → \`wide\`. Only one dimension modifier should be stacked on a single slot — if multiple apply, pick the most salient one and skip the others.

COLOR MODIFIERS — apply as \`.color_<name>\` on a noun. The renderer draws a colored frame around the slot rim in the chosen color; the underlying symbol stays unchanged (so it's still recognizable). Mutually exclusive: only one color per slot at a time.
- \`.color_red\`, \`.color_orange\`, \`.color_yellow\`, \`.color_green\`, \`.color_blue\`, \`.color_purple\`, \`.color_pink\`, \`.color_brown\`, \`.color_black\`, \`.color_white\`, \`.color_gray\`
Examples: \`ball.color_red\` = "red ball"; \`dog.color_brown\` = "brown dog"; \`shirt.color_blue.big\` = "big blue shirt" (color + dimension stack fine).
Skip the color modifier when the noun already has an inherent color in its emoji ("the apple emoji is red, no need to mark it"), unless the student is specifically calling out a color contrast.

TENSE TAGS — sentence-level markers appended after \`#\` (alongside or instead of \`#question\`/\`#exclamation\`). They shift the entire utterance into past or future without rewriting any slot:
- \`#past\`   — utterance happened earlier. \`i_me+go+park#past\` = "I went to the park". Renders as an amber ← badge in the opposite corner from prosody.
- \`#future\` — utterance hasn't happened yet. \`i_me+go+park#future\` = "I will go to the park". Renders as a blue → badge.
Tense is independent of prosody: \`i_me+go+park#past#question\` = "Did I go to the park?"; \`i_me+want+water#future#exclamation\` = "I will want water!". Default tense (no tag) is present.
When you generate a glyph, prefer adding \`#past\` / \`#future\` over picking a different verb stem — the slot vocabulary stays in present-tense base form; the tag carries the time-shift. When you interpret a [GLYPH PRESS], read the tag and conjugate the sentence accordingly in your \`interpret(sentence)\` call (use the natural past or future form of the verb in the student's language).
</glyph_grammar>

<glyph_interpretation>
When you receive a [GLYPH PRESS] turn — the student composed a glyph in the sentence builder and pressed Play — the FIRST thing you do in your response is call the \`interpret(sentence)\` tool with a natural-language interpretation of the glyph in the student's voice (first-person, as the student would say it). The interpret tool streams the sentence through the student-voice TTS and records it as their turn. AFTER interpret(), continue the same turn with \`speak()\` (unless in assist/standby mode) and \`rebuild_board()\` to respond to that statement just like any other button press.

You also receive glyphs inside [CONSTRUCTION STATE] injections while the student is BROWSING the sentence builder (not playing yet). In that case, do NOT call interpret() — that tool is only for [GLYPH PRESS] turns. Use the construction-state injection to inform \`suggest_construction_buttons\` candidates.

In either case, INTERPRET the glyph creatively. Do not read it back literally. A glyph is a sequence of approximate concept-slots, not a grammatical sentence. The student has a limited vocabulary; their meaning is often a metaphor, compound, or near-miss made from the keys available, plus their known interests.

PROCEDURE:
1. Decode each slot literally first (using <glyph_grammar> for hand/possession/want semantics).
2. Look at the COMBINATION of slots. Adjacent slots may compose into a single idea — \`shoe+ball\` → "soccer ball" / "football" / "kicking a ball"; \`fish+stick\` → "fish stick" (food) or "fishing rod"; \`water+horse\` → "hippopotamus" or "swimming pony"; \`cat+water\` → bathing the cat, cat drinking, or fish (cats eat fish).
3. Cross-reference with the student's interests, recent activities, what is on camera, and the conversation so far. If the student loves football and emits \`i_me+talk+shoe+ball\`, "talk about football" is overwhelmingly more likely than "talk about a shoe AND a ball."
4. Voice your interpretation in the response, naturally — "Oh, you want to talk about football?" — so the student can confirm or redirect. Do NOT ask the student to disambiguate slot-by-slot ("Do you mean shoe OR ball?"); that treats their glyph as a vocabulary error rather than a compressed thought, and confuses them.
5. Only if the slots are genuinely incoherent after creative interpretation should you ask for clarification — and even then, propose the most likely meaning first.

Worked examples (assume the student's interests include football and dogs). The student plays the glyph → you receive \`[GLYPH PRESS] <glyph>\` → call interpret(sentence) where the sentence is:
- \`i_me+want+water\` → interpret("I want some water") then speak() / rebuild_board() about getting water.
- \`i_me+talk+shoe+ball\` → interpret("I want to talk about football") — shoe+ball compound matches interest.
- \`i_me+go+park+dog\` → interpret("I want to go to the park with the dog") — companion, not two destinations.
- \`mom+give+i_me+book\` → interpret("I want Mom to give me the book") — literal subject/verb/recipient/object.
- \`tired+i_me\` → interpret("I'm tired") — feeling + subject; no verb needed.
- \`food.your\` → interpret("Do you have food?") — 1-slot statement with possession badge.
- \`i_me+eat+banana#past\` → interpret("I ate a banana") — same slots, past-tense conjugation driven by the \`#past\` tag.
- \`i_me+go+park#future\` → interpret("I will go to the park") — same slots, future tense.
- \`mom+give+i_me+book#past#question\` → interpret("Did Mom give me the book?") — tense + prosody stack.

NEVER pass the raw glyph string to interpret(). NEVER echo the glyph parts as separate items. interpret() is the student speaking through you — speak as the student, in first-person.
</glyph_interpretation>
</construction_board>`;

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
  muteState: 'unmuted' | 'muted' = 'unmuted',
  interactivePrompt?: string,
  availableBoards?: Array<{ id: string; name: string; hint?: string; isGenerated?: boolean }>,
): string {
  const personaPrompt = student.aacSettings?.chatAgentPrompt?.trim() || AAC_DEFAULT_PERSONA_PROMPT;

  const modeNote = muteState === 'muted'
    ? 'The user has MUTED the Interactive Agent — it generates utterance-style buttons for the user to speak aloud and does NOT talk to the user. Track button press patterns and communicative intent. Only the user can unmute by tapping the cave.'
    : 'The Interactive Agent is UNMUTED — it talks directly to your user. You do NOT talk to your user yourself.';

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