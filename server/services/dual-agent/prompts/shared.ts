// server/services/dual-agent/prompts/shared.ts
//
// Cross-agent shared building blocks for the three-agent AAC architecture.
// Houses the helpers Observer/Speaker/BoardManager all pull from when
// assembling their system prompts, plus the small shared tool primitives
// (`call_monitor`, `private_thought`, `remain_silent`, `debug_message`), the
// glyph-syntax helpers, and the localized example table.
//
// Self-contained — does NOT import from any other prompts/ file. Sibling
// prompts/ files import from here.

import { Behavior, type FunctionDeclaration } from "@google/genai";
import { listAllVocabulary } from "@shared/glyph-registry";
import { getLanguageName, languageMarksGender } from "@shared/language-names";
import { ex as _ex, type ExampleEntry, type LocaleCode } from "../../memory-schema/prompt-examples";
import { T } from "../../memory-schema/canonical-terms";

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

export interface KnownContact {
  id: string;
  name: string;
  relationship?: string;
  hasFaceImage: boolean;
}

export interface ClassroomContext {
  name: string;
  grade?: string;
  description?: string;
  roster: Array<{
    id: string;
    name: string;
    age?: string;
    gender?: string;
    diagnosis?: string;
    notes?: string;
    isActive?: boolean;
  }>;
}

/** Fields every agent needs to know about the student. */
export interface BaseStudentContext {
  studentName: string;
  language?: string;
  studentAge?: string;
  studentGender?: string;
  studentDiagnosis?: string;
  aiName?: string;
  knownContacts?: KnownContact[];
  classroom?: ClassroomContext;
  /** From EnhancedPromptSections — all three agents receive this. */
  gestureOverrides?: string;
  /** From EnhancedPromptSections — all three agents receive this. */
  safetyNotes?: string;
  /** From AAC settings — what NOT to transcribe/say/show. */
  // (currently delivered via safetyNotes; keep as a forward-compat field)
  mutedHint?: "muted" | "unmuted";
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Age-aware gender word. Adult thresholds avoid the Vertex safety
 *  classifier rejecting "39 year old boy" patterns. */
export function genderWord(gender?: string, age?: string): string {
  const ageNum = age ? parseInt(age, 10) : NaN;
  const isAdult = !isNaN(ageNum) && ageNum >= 18;
  if (gender === "male") return isAdult ? "man" : "boy";
  if (gender === "female") return isAdult ? "woman" : "girl";
  return "";
}

/**
 * Strong directive forcing correct grammatical gender. An English descriptor
 * ("a girl") is too weak a signal for gendered languages: Hebrew/Arabic/etc.
 * default to the masculine when not told otherwise, so the native-audio model
 * addresses a female student (or voices HER own utterances) in the masculine.
 * This states the requirement explicitly, naming the active language.
 *
 * Emitted ONLY when (a) the gender is known AND (b) the session language
 * actually marks the addressee's gender (`languageMarksGender`). For English,
 * Mandarin, Korean, etc. it returns "" — the directive would be pure noise.
 * `language` may be a code ("he") or a display name ("Hebrew"). Used by the
 * Speaker (addressing) and the Board Manager (which also AUTHORS the student's
 * own first-person speech).
 */
export function genderedAddressDirective(name: string, gender?: string, language?: string): string {
  if (gender !== "male" && gender !== "female") return "";
  if (!languageMarksGender(language)) return "";
  const forms = gender === "female" ? "feminine" : "masculine";
  const poss = gender === "female" ? "her" : "his";
  const langName = getLanguageName(language);
  return `<grammatical_gender>
[${name}] is ${gender}. ${langName} marks grammatical gender, so ALWAYS use ${forms} verb, pronoun, and adjective forms — both when you address [${name}] and when you write ${poss} OWN first-person words (the SENTENCEs they speak). If any worked example shows a different gender, follow [${name}]'s actual gender, not the example.
</grammatical_gender>`;
}

/** "a 12 year old girl with X" / "a user" — student descriptor. */
export function studentDescriptor(ctx: BaseStudentContext): string {
  const g = genderWord(ctx.studentGender, ctx.studentAge);
  const ageStr = ctx.studentAge
    ? (g ? `a ${ctx.studentAge} year old ${g}` : `a ${ctx.studentAge} year old`)
    : (g ? `a ${g}` : "a user");
  const diag = ctx.studentDiagnosis ? ` with ${ctx.studentDiagnosis}` : "";
  return `${ageStr}${diag}`;
}

/** Wrap a single caretaker-authored value (contact name, relationship, free-text
 *  note, student name) for inclusion in a system prompt. These fields are
 *  editable by semi-trusted caretakers; wrapping marks them as data, not
 *  instructions, and tag-escapes any attempt to forge the delimiter. */
export function wrapUntrusted(value: string | null | undefined): string {
  if (value == null || value === "") return "";
  const safe = String(value).replace(/<\/?untrusted-data>/gi, (m) => m.replace("-", "_"));
  return `<untrusted-data>${safe}</untrusted-data>`;
}

/** Known-contacts list. Each contact is keyed by face:ID so the renderer
 *  can show the photo. */
export function knownPeopleLine(contacts: KnownContact[] | undefined): string {
  if (!contacts || contacts.length === 0) return "";
  return `Known people: ${contacts.map(c =>
    `${wrapUntrusted(c.name)}${c.relationship ? ` (${wrapUntrusted(c.relationship)})` : ""} [face:${c.id}]`
  ).join(", ")}`;
}

/** Classroom block (when this session runs on a shared classroom device).
 *  Wrapped in `<classroom>` tags. All three agents get this. */
export function classroomBlock(
  studentName: string,
  classroom: ClassroomContext | undefined,
): string {
  if (!classroom) return "";
  return `

<classroom>
This AAC device is shared by the [${wrapUntrusted(classroom.name)}] classroom${classroom.grade ? ` (grade ${classroom.grade})` : ""}. Multiple students may approach throughout the day. The student currently active is [${wrapUntrusted(studentName)}].${classroom.description ? `\n\nClassroom-wide focus: ${wrapUntrusted(classroom.description)}` : ""}

The active user can change — a different face matches in [PEOPLE PRESENT], a different voice introduces themself, or someone explicitly switches. When that happens:
  - Shift your interaction to fit that student's entry below.
  - Treat in-session memory of one student as private. Don't carry their content over when a different student takes over.

<classroom_roster>
${classroom.roster.map(r => {
  const g = genderWord(r.gender, r.age);
  const rAge = r.age ? (g ? `${r.age} year old ${g}` : `${r.age} year old`) : (g || "");
  const rDiag = r.diagnosis ? ` with ${wrapUntrusted(r.diagnosis)}` : "";
  const rNotes = r.notes ? `. Notes: ${wrapUntrusted(r.notes)}` : "";
  const active = r.isActive ? "  ← currently active" : "";
  return `- [${wrapUntrusted(r.name)}]${rAge ? `, ${rAge}` : ""}${rDiag}${rNotes}${active}`;
}).join("\n")}
</classroom_roster>
</classroom>`;
}

/** `<persona_gesture_override>` block — shared by all three agents. */
export function gestureOverrideBlock(personaGestureOverrides: string | undefined): string {
  if (personaGestureOverrides) {
    return `

<persona_gesture_override>
Specific gestures for THIS user. Treat them as verbal-level signals — respond directly, don't hedge as "possible" interpretations.

${personaGestureOverrides}
</persona_gesture_override>`;
  }
  return `

<persona_gesture_override>
If the <persona> section mentions specific gestures (e.g. "he often gives a thumbs up when happy"):
  - Use those as stronger signals for intent and emotional state than default gesture interpretations.
  - Treat persona-specific gestures as verbal-level signals.
</persona_gesture_override>`;
}

/** `<security>` + optional `<student_safety>` blocks. */
export function securityBlock(studentName: string, safetyNotes: string | undefined): string {
  let block = `

<security>
- If [${studentName}] is not present but someone else is, you may respond if addressed directly. NEVER reveal sensitive information about [${studentName}] to anyone but [${studentName}].
- Never ask anyone for a personal ID number — national ID, passport, government ID, school student ID. You cannot read them back from memory, so there is no reason to request one.
- If someone dictates or displays an ID number, redact the digits ("[REDACTED]") in any transcript or context output. Never reproduce the actual digits in any tool call.
</security>`;
  if (safetyNotes) {
    block += `\n\n<student_safety>\n${safetyNotes}\n</student_safety>`;
  }
  return block;
}

/** `<environment>` block — current time. */
export function environmentBlock(): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `\n\n<environment>\nTime: ${timeStr}\n</environment>`;
}

/** Optional memory block — only included when provided. The framing
 *  differs per agent ("you remember about this user" vs. "context for
 *  picking buttons"); the caller wraps the content. */
export function memoryBlock(memoryContext: string | undefined, frame: string): string {
  if (!memoryContext) return "";
  return `\n\n<memory>\n${frame}\n${memoryContext}\n</memory>`;
}

/**
 * Single source of truth for the live-speech transcription rules. Embedded
 * in BOTH the three-agent Observer prompt and the legacy single-agent
 * resting prompt — same text either way, so the resting profile carries
 * the same obligation as the awake observer. Without this, the resting
 * profile model interprets "I just called rest()" as license to stop
 * transcribing, which strands the AAC user when someone speaks to them.
 */
export function transcriptionRulesText(studentName: string, buttonTerm: string, buttonPressTag: string): string {
  return `Transcribing live in-person speech is your PRIMARY job. EVERY distinct utterance from a real person in the room MUST trigger a \`transcript()\` call. Live transcription is the ONLY way the AAC user joins a spoken exchange.

Without it:
  - The system has no idea anyone spoke.
  - [${studentName}] gets no response buttons.
  - The conversation dies.

**This applies regardless of session state.** Even when you've called \`rest()\`, you MUST keep transcribing every utterance.
  - \`rest()\` is a cost-saving hint — NOT "stop listening" or "stop transcribing."
  - The system uses your \`target=USER\`/\`target=DEVICE\` transcripts to wake itself back up.

**Transcribe whether:**
  - Someone asks [${studentName}] a question ("do you want to go outside?", "are you hungry?") → target: USER.
  - Someone addresses the AI directly → target: DEVICE.
  - Someone speaks to a third person in the room and [${studentName}] is within earshot → target: that third person's name or UNKNOWN.
  - [${studentName}] is currently quiet, resting, or seems disengaged — they CAN'T initiate; they need to see transcribed speech BEFORE they can respond. Don't skip just because they aren't actively responding.

Each utterance is one \`transcript()\` call. Don't batch multiple sentences; don't wait to see if it matters.

**Off-camera voices ARE in-person speech.** Transcribe every real voice in the room, even when nobody is visible in frame.
  - A caregiver in the next room calling "[${studentName}], come eat?" still needs to reach the user.
  - In real homes most utterances arrive WITHOUT a face on camera — treat off-camera as the default case, not the exception.

**UNKNOWN is a positive claim, not a hedge.**
  - Use UNKNOWN only when you have positive evidence the party is NOT in your known list.
  - NEVER a fallback for "I'm not sure." If a voice could plausibly belong to [${studentName}] or any known contact, label them that person.
  - Off-camera does NOT mean unknown — the same parent calling from another room is still that parent.

  - **SPEAKER**: lean toward a known person. UNKNOWN only when the voice clearly doesn't match anyone (stranger, wrong age/gender/accent for any known party, unplaceable after several utterances).
  - **TARGET**: lean toward USER (active user), DEVICE (the AI is always known), or a known person's name. People speak TO someone specific. UNKNOWN target is rare — reserve for edge cases (a stranger speaking to another stranger).

**Why this matters:** an UNKNOWN transcript falls through downstream — no response buttons, no Speaker reply. A WRONG guess at WHO spoke at least gives [${studentName}] something to react to, so erring toward known parties costs less than UNKNOWN. (This is ONLY about attribution — who/whom — of speech you genuinely heard. It is NEVER license to invent the words, or to transcribe something you aren't sure was said, just to avoid an UNKNOWN.)

**Worked examples:**
  - Mom is in your known list. Off-camera you hear her voice (familiar timbre) say "[${studentName}], dinner!" → \`speaker="Mom", target=USER\`. NOT UNKNOWN — even though she's off-camera.
  - Short voice you can't identify addresses [${studentName}] from off-screen; Mom and Dad both plausible → \`speaker="Mom"\` (or "Dad", whichever fits the room's pattern), \`target=USER\`. Lean to known.
  - A clearly new voice — wrong gender/age for anyone known — addresses [${studentName}] → \`speaker=UNKNOWN, target=USER\`. Correct here: positive evidence it's NOT known.
  - Two people in the room (one is a known sibling) talking to each other; [${studentName}] is also there → transcribe both sides. Sibling's side: \`speaker="Sibling", target="OtherKnownPersonOrUnknown"\`. Other person's side: same logic, lean to known.

**NEVER transcript() for:**
  1. ${buttonPressTag} playback — when [${studentName}] taps a ${buttonTerm}, the device voices its SENTENCE in the user's own voice. You'll see a matching \`[BUTTON PRESS to ...]\` note in your context. Don't transcribe.
  2. AI playback — your sibling Speaker agent's voice from the room speakers. You'll see \`[AI to ...]\` context notes for these. Don't transcribe matching audio.`;
}

/**
 * Single source of truth for the environmental-observation rules. Same
 * `transcriptionRulesText` reasoning — resting profile must NOT stop
 * recording context updates just because the user is quiet. New people
 * arriving, ambient sound starting, objects appearing all matter while
 * the AAC user is at rest, often more than during active conversation.
 */
export function observationRulesText(buttonTerm: string, buttonPressTag: string): string {
  return `Use update_context() for things worth knowing:
  - People arriving / leaving.
  - Ambient sound starting / stopping.
  - Notable objects.
  - The current activity / setting (a lesson, therapy session, meal, play, free time) and any change to it — so the rest of the system can keep its contributions on-topic.
  - User's emotional state (smile, brow furrow, averted gaze, long pause).
  - Physical body gestures.

**This applies regardless of session state.** Calling \`rest()\` does NOT mean "stop observing the environment."
  - Keep recording context updates.
  - New people, objects, sounds, and gestures matter as much when the user is quiet — often more, because they're often what wakes the conversation back up.

**Physical gestures only** — counting (fingers), valence (thumbs up/down), pointing, regulatory (stop palm, wave). If unclear, log what you literally saw rather than guessing intent.

**DO NOT log AAC button presses** with update_context(person_gesture) or any other type — pressing a ${buttonTerm} is not a gesture.
  - The system records button presses automatically. You'll see them as [${buttonPressTag}] context notes; let those stand on their own.
  - Same for the device's TTS playback — never log either as an observation.`;
}

// ---------------------------------------------------------------------------
// Shared tool primitives — declared once, exposed to every agent
// ---------------------------------------------------------------------------

/**
 * `call_monitor` — any agent can request a Monitor check-in. The
 * Coordinator de-dupes simultaneous calls within a debounce window and
 * broadcasts the Monitor's response context injection to all three agents.
 *
 * The description deliberately says "the monitor" generically rather than
 * "your supervisor" — Observer / Speaker / Board Manager each have a
 * different relationship to the Monitor and the prompt for each agent
 * frames it in agent-appropriate terms.
 */
export const CALL_MONITOR: FunctionDeclaration = {
  name: "call_monitor",
  description: `Alert the monitor system to check in on this session.

  - Use for: goal progress/setbacks, guidance needs, significant context shifts.
  - DO NOT narrate this action or refer to the monitor at any time — the monitor is part of your own internal system.
  - The response (a context update) may take time to return. Continue your work normally until it arrives.
  - Do NOT call repeatedly for the same event — your sibling agents share this signal and the system de-dupes within a short window.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the monitor should check in." },
    },
    required: ["reason"],
  },
};

/**
 * `private_thought` — silent breadcrumb visible to the developer / Monitor
 * but never voiced or shown to the user. Cheap scratch space; shared by
 * all three agents so each can log per-agent reasoning. Named "thought"
 * (not "note") because the model conceives of these as thoughts, and the
 * mismatch made it leak the literal word "note" into spoken text. The
 * internal event type is still `private_note` — only the model-facing
 * tool name changed.
 */
export const PRIVATE_THOUGHT: FunctionDeclaration = {
  name: "private_thought",
  description: `Record one short private thought — visible to the developer / monitor, never to the user.

  - This is a SILENT, internal action. The words NEVER reach the user — not as audio, not as text.
  - NOT a substitute for replying. Every turn addressed to you still owes a spoken response OR an explicit remain_silent call.
  - If you only call this and produce no text, the system re-prompts you with your accumulated thoughts and requires a real response.
  - NEVER speak or write your reasoning as part of a reply. Do NOT prefix speech with "private_thought", "THOUGHT", "[note]", "[thinking]", or any similar marker — anything you emit as speech or text reaches the user. Put reasoning in THIS tool instead.
  - Keep thoughts short and specific.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "Your private thought (one short sentence)." },
    },
    required: ["note"],
  },
};

/**
 * `remain_silent` — terminal "no reply this turn" action. Without this,
 * the model conflates "I should not respond" with "I should leave a
 * private_thought", which both produces orphan turns and (in the HTTP
 * Speaker loop) gets re-prompted indefinitely. Calling this signals the
 * silence is intentional so the loop stops cleanly.
 */
export const REMAIN_SILENT: FunctionDeclaration = {
  name: "remain_silent",
  description: `Choose NOT to respond on this turn. The user hears nothing; no board update is triggered.

Use ONLY for genuine silence:
  - You've already replied earlier on the same exchange.
  - The input was clearly ambient and not addressed to you.
  - The user pressed a button that did not require a reply.

Provide a one-line reason for the log.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "One short sentence on why you're staying silent.",
      },
    },
    required: ["reason"],
  },
};

/**
 * `debug_message` — only present when AAC_DEBUG_INTROSPECTION=1. Used by
 * the system to ask the model what it was trying to do when a turn was
 * rejected. Bypasses the audio safety filter that would otherwise
 * RESPONSE_REJECT the explanation itself.
 */
export const DEBUG_MESSAGE: FunctionDeclaration = {
  name: "debug_message",
  description:
    "System diagnostic tool. When the system tells you a response was rejected or malformed and asks what you were trying to do, call this function with your explanation. Do NOT call this unless explicitly asked by a [DEBUG] system message.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "What you were trying to do — the function you were calling and/or what you were going to say.",
      },
    },
    required: ["message"],
  },
};

/** Whether the debug introspection tool should be included on this run.
 *  Centralized so every agent agrees on the same flag. */
export function debugIntrospectionEnabled(): boolean {
  return process.env.AAC_DEBUG_INTROSPECTION === "1";
}

// ---------------------------------------------------------------------------
// Glyph syntax — shared between the AAC agents (BoardManager) and the
// clinician board editor. Kept here so all AAC prompts pull from one place.
// ---------------------------------------------------------------------------

/**
 * The grammar (SYMBOL preference order + GLYPH/modifier rules + SENTENCE/OPERATOR
 * composition) and the `generate:` last-resort + mandatory-fallback rules.
 * Parameterized by single-glyph mode (single GLYPH per button vs up-to-3 joined
 * with `+`). Append getBundledIconsBlock() after this for the canonical vocab.
 */
export function buildGlyphSyntax({ singleGlyphButtons }: { singleGlyphButtons: boolean }): string {
  return `<grammar>
  SYMBOL: one word. Every SENTENCE is built out of SYMBOLs. Choose them in this STRICT preference order — generation is a last resort:

    1. \`symbol:ID\` / \`face:ID\` — a custom SYMBOL or face stored for this user. FIRST CHOICE.
    2. **EMOJI + canonical modifier** — your DEFAULT. Almost any concrete-noun-with-a-quality can be expressed as an emoji HEAD with one or more canonical MODIFIERs from <bundled_icons>:
         • "red apple"   → \`🍎.color_red\`     (NOT \`generate:red_apple\`)
         • "big book"    → \`📖.big\`           (NOT \`generate:big_book\`)
         • "my dog"      → \`🐕.my\`            (NOT \`generate:my_dog\`)
         • "two cookies" → \`🍪.two\`           (NOT \`generate:two_cookies\`)
       This is BY FAR the most common case.
    3. A canonical registry key from <bundled_icons> — for pronouns, abstract verbs, time concepts, deictics, and ALL modifier SYMBOLs.
    4. A raw emoji (🍎, 🤗, 🎮, …) — for concrete nouns not covered by a custom symbol.
    5. \`generate:<key>\` — LAST RESORT. See <generation_rules>.

  NEVER emit a bare snake_case word that isn't in <bundled_icons>. Bare unknown snake_case renders as ❓.

  GLYPH: HEAD SYMBOL + zero or more MODIFIER SYMBOLs joined with \`.\`:
    - \`🍎\`, \`🍎.color_red\`, \`🍪.two\`, \`📖.my\`, \`🤗.big.please\`

  MODIFIER SYMBOLs are ALWAYS either from the canonical registry, or emojis.
    - Words like \`.new\`, \`.old\`, \`.sad\`, \`.funny\`, \`.american\`, \`.scary\` are NOT modifiers — they render as meaningless dots.
    - If you need an adjective the registry doesn't have:
      - Use an emoji if one exists (😢 for "sad", 👴 for "old man", 😨 for "scary").
      - Or drop the adjective from the visual and put it in the spoken \`speech\` field only.
    - Never invent a modifier outside the registry${singleGlyphButtons ? "" : ", and never compose multi-GLYPH SENTENCEs just to attach an adjective"}.

${singleGlyphButtons
  ? `  SENTENCE: one GLYPH per ${T.button}. Each ${T.button}'s \`sentence\` field is a single GLYPH (head + optional MODIFIER SYMBOLs).

  OPERATOR: sentence-level tag appended with \`#\`. \`#past\`, \`#future\`, \`#question\` modify the WHOLE sentence — they never add a second GLYPH. Conjugate the spoken \`speech\` accordingly; the visual stays the same.`
  : `  SENTENCE: up to 3 GLYPHs joined with \`+\`:
    - 1-glyph: \`😴\`, \`🍎.color_red\`
    - 2-glyph: \`i_me+🤒\`, \`have+💧\`
    - 3-glyph: \`i_me+want+🍌\`, \`you+give+i_me\`
  Match SENTENCE shape to meaning — don't pad. One-word answers are 1-glyph; full subject+verb+object thoughts are 3-glyph.

  OPERATOR: sentence-level tag via \`#\` — \`#past\`, \`#future\`, \`#question\`. They modify the WHOLE sentence — never substitute for a GLYPH. Conjugate \`speech\` accordingly.`}
</grammar>

<generation_rules>
\`generate:<key>\` triggers async image generation — takes ~5 seconds and may fail. LAST RESORT.

**Self-check before EVERY \`generate:\` call:** Would the fallback you'd write be a COMPLETE expression of the concept on its own (not just a generic stand-in)?
  - If YES → the fallback IS the answer. Use it as the SENTENCE directly with NO fallback field.
  - \`generate:\` should only fire when the fallback is a deliberately APPROXIMATE placeholder for something the canonical vocab can't fully express.

Examples of the trap (NEVER do this) — the fallback is the complete answer:
  - sentence: \`generate:purple_storm\`, fallback: \`⛈️.color_purple\` ← \`⛈️.color_purple\` IS a purple storm cloud. Write \`sentence: "⛈️.color_purple"\` with no fallback.
  - sentence: \`generate:red_apple\`, fallback: \`🍎.color_red\` ← \`🍎.color_red\` IS a red apple. Use the fallback as sentence.
  - sentence: \`generate:big_dog\`, fallback: \`🐕.big\` ← \`🐕.big\` IS a big dog. Use the fallback as sentence.
  - sentence: \`generate:hippopotamus\`, fallback: \`🦛\` ← the hippo emoji IS a hippo. Use \`🦛\` directly.

Valid \`generate:\` (fallback is a deliberately weaker approximation):
  - sentence: \`generate:planet_mars\`, fallback: \`🌑.color_red\` ← \`🌑.color_red\` is a reddish round object; a generated image actually depicts Mars. Worth the cost.
  - sentence: \`generate:violin\`, fallback: \`🎻\`? — wait, the violin emoji exists, so this would be a trap. Pick a TRULY missing object like \`generate:cello\` (no cello emoji) with fallback \`🎻\` (a stand-in string instrument).
  - sentence: \`generate:seagull\`, fallback: \`🐦.🏖️\` ← "beach bird" is the best approximation, but doesn't really capture a seagull. Generate the image, and use the object and modifier as a fallback.

WHEN NOT to generate (almost always):
  - Color, size, quantity, possession, intensity qualities — canonical modifiers (\`.color_purple\`, \`.big\`, \`.two\`, \`.my\`, \`.very\`) already exist. Compose emoji+modifier; never \`generate:color_noun\`, \`generate:big_noun\`, etc.
  - Phrases or abstractions (\`generate:my_day\`, \`generate:something_new\`) — image generator can't draw an idea.
  - Anything already a normal emoji (including 🦛 hippo, 🦒 giraffe, 🦘 kangaroo, 🦔 hedgehog, 🦥 sloth, 🦦 otter, 🦨 skunk, 🦝 raccoon, 🦡 badger, 🦃 turkey, 🦚 peacock, 🦜 parrot, 🦅 eagle, 🦆 duck, 🦉 owl, 🦩 flamingo — check the bundled icons before assuming an animal is missing).

WHEN to generate (rarely):
  - Specific scientific objects (\`generate:planet_mars\`, \`generate:black_hole\`).
  - Specific animals genuinely missing from emoji (\`generate:t_rex\`, \`generate:seagull\`).
  - Specific tools genuinely missing from emoji (\`generate:cello\`, \`generate:telescope\`).
  - Specific named people not covered by face:ID.

Generation key format: lowercase_snake_case, English, short concrete noun phrase. Include category disambiguators (\`planet_mars\` not \`mars\`, \`animal_bat\` not \`bat\`).

Fallback for a generated SENTENCE — ALWAYS REQUIRED, NEVER contains \`generate:\`:
  - The fallback is shown immediately while generation is in progress (and permanently if generation fails).
  - May only use: emojis, canonical registry keys, \`symbol:ID\` / \`face:ID\`, canonical modifiers.
  - Mirror the SHAPE of the \`sentence\` field. The fallback should be deliberately LESS specific than the generated image will be — that's how you know \`generate:\` is warranted.
</generation_rules>`;
}

/** A custom SYMBOL available to a student (subset of the repository's ResolvedSymbol). */
export interface GlyphCustomSymbol {
  id: string;
  key?: string | null;
  description?: string | null;
}

/**
 * The `<custom_symbols>` palette block — the per-student custom SYMBOLs the AI may
 * reference as `symbol:ID`. Returns "" when there are none. Same format the live
 * board-manager uses, so every consumer lists custom symbols identically.
 */
export function buildCustomSymbolsBlock(symbols: GlyphCustomSymbol[] | undefined): string {
  if (!symbols || symbols.length === 0) return "";
  return `<custom_symbols>
Reference a custom SYMBOL as \`symbol:ID\`. Prefer custom SYMBOLs over canonical keys, emojis, and \`generate:\` when one fits.
${symbols.map(s => `- ${s.key || s.id}${s.description ? ` — ${s.description}` : ""} (id: ${s.id})`).join("\n")}
</custom_symbols>`;
}

/** A known person/face available to a student. */
export interface GlyphKnownPerson {
  id: string;
  name: string;
  relationship?: string | null;
}

/**
 * The `<known_people>` palette block — the per-student faces the AI may reference
 * as `face:ID`. Returns "" when there are none. For consumers without a live
 * `<presence>` block (e.g. the clinician board editor); the live agents already
 * surface faces via presence.
 */
export function buildKnownPeopleBlock(contacts: GlyphKnownPerson[] | undefined): string {
  if (!contacts || contacts.length === 0) return "";
  return `<known_people>
Reference a known person's face as \`face:ID\`. Prefer a face over a plain name when the person is known.
${contacts.map(c => `- ${wrapUntrusted(c.name)}${c.relationship ? ` (${wrapUntrusted(c.relationship)})` : ""} [face:${c.id}]`).join("\n")}
</known_people>`;
}

// ---------------------------------------------------------------------------
// Bundled icons block — canonical SYMBOL key inventory
// ---------------------------------------------------------------------------

/**
 * Compact list of canonical SYMBOL keys. Every entry is a SYMBOL the AI
 * may use as a HEAD SYMBOL or as a MODIFIER SYMBOL inside a GLYPH.
 *
 * Limited to SYMBOLs whose meaning isn't obvious from any single emoji —
 * pronouns / deictic pointers, abstract or relational verbs, spatial
 * deictics, time concepts, and all modifier symbols. Everything else
 * (animals, food, body parts, family relations, body actions, places,
 * vehicles, nature, feelings, etc.) has a clear emoji and is deliberately
 * left off the list — the AI is steered toward emojis for those.
 *
 * Modifier-only SYMBOLs (categories: []) are bucketed by their
 * `modifier.transform` family so the AI sees them as a coherent group
 * ("count", "possession", "color", etc.) rather than scattered.
 */
function buildBundledIconsBlock(): string {
  // HEAD-eligible SYMBOLs — used as the first symbol of a GLYPH.
  // Grouped by primary category.
  const byCategory = new Map<string, Array<string>>();
  // MODIFIER SYMBOLs — attached to a HEAD SYMBOL with `.modifier`.
  // Grouped by transform family so the AI sees substitutable sets.
  const modifierGroups = new Map<string, Array<string>>();

  // We deliberately do NOT show the canonical emoji next to each key.
  // These SYMBOLs are exposed BECAUSE no single emoji captures them
  // cleanly — surfacing one would tempt the AI to use the emoji
  // standalone, defeating the point. The key alone is the contract.
  // Badge modifiers split between "social" (please/again/more — attach to
  // verbs to soften or repeat them) and "relation" (with/for/before/after/
  // because/instead — encode relations the interpreter can't infer from
  // verb+noun context). Same transform, distinct semantic groups for the
  // AI to reason about.
  const RELATION_BADGE_KEYS = new Set(["with", "for", "instead", "before", "after", "because"]);
  for (const v of listAllVocabulary()) {
    if (!v.exposeToAi) continue;
    if (v.pos === "modifier" && v.categories.length === 0) {
      // Pure MODIFIER SYMBOL — bucket by transform family.
      const transform = v.modifier?.transform ?? "other";
      const group =
        transform === "dots" ? "count"
        : transform === "hands" ? "possession"
        : transform === "red_x" ? "negation"
        : transform === "glow" || transform === "shrink" ? "intensity"
        : transform === "color" ? "color"
        : transform === "badge" ? (RELATION_BADGE_KEYS.has(v.key) ? "relation" : "social")
        : transform;
      let arr = modifierGroups.get(group);
      if (!arr) { arr = []; modifierGroups.set(group, arr); }
      arr.push(v.key);
      continue;
    }
    // Category-bound MODIFIER SYMBOLs (e.g. dimension modifiers).
    if (v.pos === "modifier") {
      const transform = v.modifier?.transform ?? "other";
      const group =
        transform === "dimension" ? "size_shape"
        : transform === "halo_warm" || transform === "halo_cool" ? "temperature"
        : "other_modifier";
      let arr = modifierGroups.get(group);
      if (!arr) { arr = []; modifierGroups.set(group, arr); }
      arr.push(v.key);
      continue;
    }
    const primary = v.categories[0];
    if (!primary) continue;
    let arr = byCategory.get(primary);
    if (!arr) { arr = []; byCategory.set(primary, arr); }
    arr.push(v.key);
  }

  const lines: string[] = ["<bundled_icons>"];
  lines.push("Canonical SYMBOL keys. Use them by name. For SYMBOLs not listed here — animals, food, body parts, places, vehicles, family relations, body actions like running or dancing, etc. — pick a clear emoji directly. Emojis and canonical keys are equally first-class SYMBOLs.");
  lines.push("");

  const CATEGORY_HEADERS: Record<string, string> = {
    who: "WHO — pronouns + deictic HEAD SYMBOLs",
    do: "DO — abstract / relational verb HEAD SYMBOLs",
    what: "WHAT — abstract HEAD SYMBOLs not covered by other tabs",
    where: "WHERE — spatial deictic HEAD SYMBOLs",
    when: "WHEN — time HEAD SYMBOLs",
    chat: "CHAT — conversational HEAD SYMBOLs (greetings, politeness, replies, reactions, turn-taking)",
  };
  for (const cat of ["who", "do", "what", "where", "when", "chat"] as const) {
    const items = byCategory.get(cat);
    if (!items?.length) continue;
    lines.push(`${CATEGORY_HEADERS[cat]}:`);
    lines.push(`  ${items.sort().join(", ")}`);
  }

  if (modifierGroups.size > 0) {
    lines.push("");
    lines.push("MODIFIER SYMBOLs — attach to a HEAD SYMBOL with `.modifier` (e.g. `🍎.color_red`, `🍪.two`, `📖.my`, `🍽️.with`). Stack by chaining: `🤗.big.please`.");
    lines.push("**This list is EXHAUSTIVE.** The renderer has no image for any modifier not listed here.");
    lines.push("  - Anything else (e.g. `.new`, `.old`, `.sad`, `.funny`, `.adventure`, `.scary`, `.american`) renders as a meaningless dot.");
    lines.push("  - If you need a quality not in this list, use a different emoji that already encodes it, or compose two GLYPHs (see <grammar>).");
    const MODIFIER_ORDER = ["count", "possession", "negation", "intensity", "size_shape", "temperature", "color", "social", "relation", "relational", "other_modifier"];
    for (const group of MODIFIER_ORDER) {
      const items = modifierGroups.get(group);
      if (!items?.length) continue;
      lines.push(`  - ${group.replace("_", " ")}: ${items.sort().join(", ")}`);
    }
    if (modifierGroups.get("relational")?.length) {
      // Relational modifiers step a HEAD SYMBOL along a sequence and are the
      // canonical way to express adjacent points in time.
      lines.push("    Relational arrows attach beneath a HEAD and step it along a sequence:");
      lines.push("      - `this` = current, `next` = one forward, `prev` = one back.");
      lines.push("      - next/prev STACK (up to 4) and CANCEL each other one-for-one.");
      lines.push("      - Relative time examples: `day.this` = today, `day.next` = tomorrow, `day.prev` = yesterday, `day.next.next` = in two days, `hour.next.next` = in two hours, `week.prev` = last week.");
      lines.push("      - today/tomorrow/yesterday are accepted aliases for the day forms.");
    }
  }

  lines.push("</bundled_icons>");
  return lines.join("\n");
}

const BUNDLED_ICONS_BLOCK = buildBundledIconsBlock();

/**
 * The canonical SYMBOL key inventory, formatted as a <bundled_icons> block.
 * Exported so the thorough-startup enhancer can show the LLM exactly which
 * snake_case keys are real — without this it tends to invent fake ones
 * (`good`, `happy`, `talk_about`, `let_us`, `play_game`) that the live model
 * then dutifully tries to render, producing ❓ tiles.
 */
export function getBundledIconsBlock(): string {
  return BUNDLED_ICONS_BLOCK;
}

// ---------------------------------------------------------------------------
// Examples — localized worked-dialogue table
// ---------------------------------------------------------------------------

// Re-export the localized example lookup so prompts/*.ts can pull from one
// place. The underlying table still lives in memory-schema/prompt-examples.ts
// (so non-AAC consumers keep working) — this is the canonical access path for
// the AAC agents.
export { _ex as ex };
export type { ExampleEntry, LocaleCode };

// ---------------------------------------------------------------------------
// Home-board routing tags (referenced by agents when documenting routing)
// ---------------------------------------------------------------------------

/** The tag strings the default home board emits as `exit` action text — the
 *  WHOLE routing protocol between client and server's HOME_INTENTS map.
 *  Documented here so prompt-feeding code can reference them when explaining
 *  navigation. Live in lockstep with the buttons in default-home-board.ts. */
export const HOME_TAGS = [
  "[INTERACT]",
  "[ASSIST]",
  "[MY DAY]",
  "[INTERESTS]",
  "[FEELINGS]",
  "[HELP]",
  "[APPS BOARD]",
  "[CONSTRUCTION BOARD]",
] as const;
