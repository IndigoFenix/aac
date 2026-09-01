// server/services/dual-agent/prompts/board-manager.ts
//
// Board Manager Agent prompt + tool surface + per-trigger action hint
// builder + retry-feedback string builders + force-rebuild directive
// strings.
//
// Pulled from shared.ts: BaseStudentContext, studentDescriptor, classroomBlock,
// gestureOverrideBlock, securityBlock, environmentBlock, memoryBlock,
// knownPeopleLine, getBundledIconsBlock, buildCustomSymbolsBlock, ex,
// CALL_MONITOR.

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import type { AgentEvent } from "../agent-events";
import { clarityTag } from "../speech-text";
import { getLanguageName } from "@shared/language-names";
import { type LanguageLevel, languageLevelDirective } from "@shared/aac-language-level";
import type { PermittedWebsite } from "@shared/schema";
import { flattenPermittedWebsites } from "@shared/permitted-websites";
import { T } from "../../memory-schema/canonical-terms";
import {
  type BaseStudentContext,
  buildCustomSymbolsBlock,
  classroomBlock,
  environmentBlock,
  ex,
  getBundledIconsBlock,
  gestureOverrideBlock,
  knownPeopleLine,
  memoryBlock,
  securityBlock,
  studentDescriptor,
  genderedAddressDirective,
  wrapUntrusted,
} from "./shared";

// ===========================================================================
// SYSTEM PROMPT
// ===========================================================================

export interface BoardManagerPromptConfig extends BaseStudentContext {
  memoryContext?: string;
  muteState: "unmuted" | "muted";
  cachedSymbols?: Array<{ id: string; key: string | null; description?: string | null }>;
  // `packageName` groups boards reached through an attached package; absent for
  // the student's own boards.
  availableBoards?: Array<{ id: string; key: string; name: string; hint?: string; packageName?: string; grid: { rows: number; cols: number } }>;
  /** Normalized key of the currently loaded pre-built board, if any.
   *  Distinct from `loadedBoardName` so the prompt can present BOTH and
   *  the model never confuses the human label for the set_board argument. */
  loadedBoardKey?: string | null;
  loadedBoardName?: string | null;
  loadedPageName?: string | null;
  enabledApps?: Array<{ id: string; name: string; description: string; queryHint?: string }>;
  /** The student's family photos, when the `photos` app is enabled. The Board
   *  Manager needs the CAPTIONS, not just the app id: it is the only agent
   *  that can open an app in a live-audio session, and a photos button with
   *  no `appQuery` opens the album on the grid instead of on the person the
   *  student just asked about. */
  photoLibrary?: import("../../photos/photo-context").PhotoLibrarySummary;
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
  /** Smart-home slots the student may fire (ENABLED ones only). `description`
   *  is the author's when-to-surface hint, read like a board `hint`. Empty /
   *  omitted → no <home_context> block at all. */
  homeActions?: Array<{ id: string; label: string; description?: string }>;
  permittedWebsites?: PermittedWebsite[];
  autoSymbolsEnabled?: boolean;
  singleGlyphButtons?: boolean;
  /** How long/complex the user's button utterances should be, matched to their
   *  receptive language. Constrains `speech`/`label` length (not the GLYPH
   *  encoding). Omit / default tier emits no block. */
  languageLevel?: LanguageLevel;
  /** Experiment: when on, the header mirrors text directed at the user back as
   *  a glyph strip, fed by rebuild_board's `input_glyphs` param. Adds the
   *  param to the tool surface + a prompt block explaining it. */
  glyphInputTranslation?: boolean;
  /** From EnhancedPromptSections — Board-Manager-only guidance (e.g.
   *  "always include a 'finished' button for this student"). */
  boardManagerGuidance?: string;
  /** Builder grammar examples shared with SPEAKER — used for the
   *  sentence-builder suggestion path. */
  sentenceInterpretationExamples?: string;
  /** Three-agent: Trigger → tool-call examples scoped to this user. */
  boardManagerExamples?: string;
}

/** The BoardManager prompt split into a stable `base` plus the two mode blocks,
 *  so the coordinator can append `builderBlock` / `guessingBlock` only when those
 *  modes are active — keeping the common-turn prompt lean and the base cacheable. */
export interface BoardManagerPromptParts {
  base: string;
  builderBlock: string;
  guessingBlock: string;
}

/**
 * Cap on how many pre-built boards are listed in the prompt.
 *
 * This block is rebuilt on EVERY Board Manager call, so its length is a
 * per-turn cost, not a one-off. A student with several attached packages could
 * otherwise carry dozens of lines forever. Thirty is comfortably more than any
 * one moment needs while keeping the block bounded.
 */
export const MAX_PREBUILT_BOARDS_IN_PROMPT = 30;

/**
 * Render the `<prebuilt_boards>` listing: the student's own boards first, then
 * package boards grouped under a heading per package.
 *
 * Returns the number DROPPED as well as the lines — the caller both tells the
 * model there is more and logs it. A silent cap reads as "you have seen
 * everything" when you have not.
 */
export function renderPrebuiltBoardLines(
  boards: ReadonlyArray<{ key: string; name: string; hint?: string; packageName?: string }>,
): { lines: string[]; dropped: number } {
  const shown = boards.slice(0, MAX_PREBUILT_BOARDS_IN_PROMPT);
  const dropped = boards.length - shown.length;

  const entry = (b: { key: string; name: string; hint?: string }) =>
    `  - key: "${b.key}"  name: "${b.name}"${b.hint ? `  — ${b.hint}` : ""}`;

  const lines: string[] = [];
  for (const b of shown) if (!b.packageName) lines.push(entry(b));

  let currentPackage: string | null = null;
  for (const b of shown) {
    if (!b.packageName) continue;
    if (b.packageName !== currentPackage) {
      currentPackage = b.packageName;
      lines.push(`  From package "${currentPackage}":`);
    }
    lines.push(entry(b));
  }

  return { lines, dropped };
}

export function buildBoardManagerPrompt(config: BoardManagerPromptConfig): BoardManagerPromptParts {
  const {
    studentName, language, memoryContext, muteState: _muteState,
    knownContacts, classroom,
    cachedSymbols, availableBoards, loadedBoardKey, loadedBoardName, loadedPageName,
    enabledApps, availableCustomApps, homeActions, permittedWebsites, photoLibrary,
    autoSymbolsEnabled = false, singleGlyphButtons = false,
    glyphInputTranslation = false, languageLevel,
    gestureOverrides, safetyNotes, boardManagerGuidance,
    sentenceInterpretationExamples, boardManagerExamples,
  } = config;

  const languageName = getLanguageName(language);
  // Language-level constraint on button utterance length/complexity. Null at the
  // default tier → no block (existing students unchanged).
  const bmLangDirective = languageLevel ? languageLevelDirective(languageLevel) : null;
  const languageLevelBlock = bmLangDirective
    ? `\n\n<language_level>\n${bmLangDirective}\nThis caps the \`speech\` and \`label\` text of every ${T.button} you build — keep them this short and simple. The GLYPH encoding is unaffected (it's language-neutral).\n</language_level>`
    : "";
  const descriptor = studentDescriptor(config);
  const genderBlock = genderedAddressDirective(studentName, config.studentGender, language);
  const peopleLine = knownPeopleLine(knownContacts);

  let prompt = `<role>
You are the BOARD MANAGER for an AAC session. Your single job: produce the ${T.button}s the user picks from to communicate.

The user is [${studentName}], ${descriptor}. Language: ${languageName}.

You're invoked per event by the Coordinator (a press, transcribed speech, AI speech, builder opens). Each invocation is independent — your prompt + the invocation context is everything you know. You communicate only by calling tools.

The ${T.button}s are the USER's words — what they can say next.
  - Never put the AI's own questions or statements into them.
  - The ${T.board} holds up to 8 ${T.button}s. Provide a wide variety drawn on conversation history + known interests, not just the latest event.

**HARD RULE: Every invocation MUST end with exactly ONE tool call. NEVER return silently.** Canonical names are snake_case.

Your tools:
  - \`rebuild_board\` — replace the main ${T.board} with a fresh set of ${T.button}s.
  - \`add_board_button\` — add ONE ${T.button} to the current main board.
  - \`add_context_button\` — add ONE item to the SIDEBAR (left strip, ambient observations).
  - \`show_binary_choice\` — yes/no or either/or overlay.
  - \`set_board\` — switch to a pre-built ${T.board}.
  - \`suggest_construction_buttons\` — populate the ${T.builder} strips.
  - \`interpret\` — voice a composed SENTENCE through the user's TTS.
  - \`exit_guessing\` — end Word Finder narrowing (only available in guessing mode).
  - \`no_change\` — current surface still fits, no action needed. UNIVERSAL FALLBACK.

Choosing which tool:
  - Exactly TWO natural answers → \`show_binary_choice\`.
  - MANY answers (3+) → \`rebuild_board\` with that variety.
  - One specific new option fits, existing board still useful → \`add_board_button\`.
  - Conversation shifted (different topic/speaker/beat) → \`rebuild_board\`.
  - Ambient observation worth surfacing (object, person entering) → \`add_context_button\`.
  - Nothing else fits → \`no_change(reason)\`. NEVER while the ${T.board} is EMPTY — an empty screen leaves the user voiceless; build openers instead.
</role>${genderBlock ? `\n\n${genderBlock}` : ""}${classroomBlock(studentName, classroom)}${boardManagerGuidance ? `\n\n<board_manager_guidance>\n${boardManagerGuidance}\n</board_manager_guidance>` : ""}

<when_to_act>
The TARGET label on the incoming tagged event decides whether to build a board and what kind.

**Build FOLLOW-UPS** when the USER just acted (${T.tagPress}, ${T.tagComposed}, or their own SPEECH — \`[${studentName} to AI]\`):
  - Options that continue or clarify what they said.
  - Their SPEECH is a turn exactly like a press. When the AI's reply to it arrives in the SAME invocation, the reply is the newer beat — but anything they ASKED for is still yours to act on.
  - E.g. they pressed "I want to talk about my day" → "the morning", "something good", "something hard", "more details", plus a \`button_type: "more"\` (see <meta_buttons>).
  - Especially valuable when they're talking to a non-AI person — the buttons let them elaborate further.

**Build REPLIES** when someone ELSE just spoke to the USER (\`target = USER\`):
  - Options the user might say back.
  - Speaker may be AI ([AI to USER]), known person ([Mom to USER]), or UNKNOWN ([UNKNOWN to USER]). ALL THREE require replies.
  - E.g. "do you want lunch?" → "yes please", "no thanks", "I'm not hungry", "later", "just a drink".

**TARGET decides, SPEAKER is just attribution.**
  - \`[UNKNOWN to USER]\` is NOT ambient noise — Observer transcribed it because speech was clearly addressed to the user.
  - Treat it the same as \`[Mom to USER]\`: someone spoke to [${studentName}]; they need buttons to reply.
  - **Do NOT build** when target is a third party AND not the user:
    - \`[Mom to Dad]\` — Mom talking to Dad while [${studentName}] is in the room.
    - \`[AI to Mom]\` — the AI is responding to Mom; [${studentName}] isn't being addressed.
    - These are ambient observations unless [${studentName}] shows interest in interjecting.

**"words uncertain" / "words very uncertain" in the tag** — the speech-to-text wasn't sure it heard those words. It never returns silence, so weak audio comes back as a fluent sentence nobody said.
  - Still build reply ${T.button}s (someone probably DID speak), but keep them GENERAL — "what?", "say it again", "yes", "no", "I don't understand" — plus whatever the ongoing topic already supports.
  - Do NOT anchor the board to specifics that appear ONLY in those words. A name, place, or topic that arrives once, uncertain, and fits nothing else in <recent_events> is the likeliest thing to have been misheard — a ${T.button} naming it invites a press that CONFIRMS something that was never said.
  - EXCEPTION — a REQUEST you can act on. Uncertain words that name a surface you already carry (${availableBoards && availableBoards.length > 0 ? `a <prebuilt_boards> ${T.board}, ` : ""}an app, a website) are not a phantom: a misheard sentence rarely lands on a name that was already on your list. Honor it. An ignored ask costs the user the thing they asked for; a wrong surface costs one press to leave.

**FOLLOW-UPS and REPLIES are different boards.** Don't mix them. If you just produced one and now you're invoked for the other, the new board should answer the new beat — overlap is fine, but the FRAMING is different.

**The \`target\` field on rebuild_board:**
  - DEVICE by default (user talking to the AI). Omit it in almost every case.
  - Set to a person's name when the user is replying to someone else in the room.
  - Carries through to each press.

${availableBoards && availableBoards.length > 0 ? `**A pre-built ${T.board} that fits beats one you write.** When <prebuilt_boards> holds one for what is happening now, \`set_board(key)\` — it was made for this activity and carries vocabulary you would not invent.
  - Judge fit by the SUBJECT of the conversation, not by phrasing.
  - **ASKED FOR = LOAD IT.** The user (or anyone in the room) naming a ${T.board} — by key, by name, or by what it is for ("the building board") — is an instruction, not a topic. \`set_board\` on that turn. Do not answer an ask with a ${T.button} that offers what was already requested.
  - Otherwise open it once the topic is established — not on a single passing mention — and never when it is already loaded.
  - Stay on it while the activity continues. Leave only when the activity is over (rebuild_board unloads it).
  - A \`[CONTEXT]\` update naming a pre-built ${T.board} or its topic is the Observer flagging that the surface is due — it does not load them, you do. Act on it.

` : ""}**DO NOT rebuild on ambient observations.** A new person, a sound, a gesture, a passing object — scene context, not a new conversational turn.
  - Observation genuinely worth surfacing → \`add_context_button\` (ONE sidebar entry).
  - Otherwise → \`no_change(reason)\`. Defaulting to no_change on observations is correct.${availableBoards && availableBoards.length > 0 ? `\n  - EXCEPTION: an observation that a pre-built ${T.board}'s situation has arrived → \`set_board\`, per the rule above. That one is not ambient.` : ""}

**Other states:**
  - ${T.tagBuilderState} → \`suggest_construction_buttons\`.
  - ${T.tagComposed} → \`interpret(sentence)\`.
</when_to_act>

<presence>
[${studentName}] is your primary target. The [PEOPLE PRESENT] block lists identified faces; a "[THE STUDENT]" tag confirms a biometric match. When non-students are using the device, omit ${T.button}s that would reveal student-private information.
Identity doubt is NEVER a reason to withhold ${T.button}s — speech targeting USER gets reply options for whoever is at the device.${peopleLine ? `\n${peopleLine}` : ""}
</presence>

<conversation_register>
WHO the user is talking to changes WHAT they need to say. A \`[REGISTER]\` note tells you; with no note, offer a balanced mix.

  - \`[REGISTER] helper\` — they're talking to a caretaker, parent, teacher, or therapist. Needs and requests belong here: help, want, more, all done, "I need…", plus politeness (please, thank you, hello).
  - \`[REGISTER] peer\` — they're talking to a friend or another kid. This is a BACK-AND-FORTH conversation, NOT a request desk. Lead with social, reciprocal moves and keep needs to a minimum:
      - React to what the peer said: "cool!", "really?", "me too", "no way", "that's funny".
      - Hand the turn back / keep it going: "what about you?", "why?", "tell me more", "and then?".
      - Share something of their own: "I like that too", "guess what", "I have one".
      - Greetings & goodbyes, agreeing & disagreeing, taking turns.
      - Surface a need (water, bathroom, help) ONLY if the user clearly signals one — don't fill a social board with requests.

Bias, don't lock: a peer board may still carry one "I need a break" escape, and a helper board can still be warm.

**Mark each ${T.button}'s \`role\`.** Set \`role: "bid"\` on questions/requests that hand the turn to the other side and expect a response ("What about you?", "Why?", "Can you help me?"). Set \`role: "reply"\` (or omit) on answers, reactions, and acknowledgements that don't ("Me too", "I'm tired", "I want water"). On a conversational board (peer / facilitator), ALWAYS include at least 2–3 \`bid\` ${T.button}s — the follow-up questions the user can ask back — so they can keep the conversation going.
</conversation_register>

<glyph>
A ${T.button} is \`{ speech, glyph, label }\`:
  - \`speech\` — the first-person SENTENCE the TTS voices on press, in ${languageName} ("I want some water").
  - \`glyph\` — the VISUAL: an ARRAY of ${singleGlyphButtons ? "exactly 1 GLYPH" : "1–3 GLYPHs (rendered left→right)"}. Each GLYPH is \`{ sym | gen, mods?, fb? }\`.
  - \`label\` — short on-button text in ${languageName} (seen, not voiced).
  - \`op?\` — optional "past"/"future"/"question" OPERATOR on the whole ${T.button}. Conjugate \`speech\` to match; visual unchanged.
  - \`button_type?\` — see <meta_buttons>; other fields ignored when set.

${singleGlyphButtons ? `One GLYPH per ${T.button}.` : `Match the glyph count to meaning — a one-word answer/feeling is 1 GLYPH, a full subject+verb+object thought is up to 3. Don't pad.`}

**Choose each GLYPH's head in this STRICT preference order** (generation is a last resort):
  1. \`{sym:"symbol:ID"}\` / \`{sym:"face:ID"}\` — this user's custom SYMBOL or face. FIRST choice when one fits.
  2. \`{sym:"🍎", mods:["color_red"]}\` — emoji head + canonical MODIFIER(s) from <bundled_icons>. DEFAULT for a concrete-noun-with-a-quality.
    - "big book" → \`{sym:"📖",mods:["big"]}\`
    - "two cookies" → \`{sym:"🍪",mods:["two"]}\`
    - "my dog" → \`{sym:"🐕",mods:["my"]}\`
  3. \`{sym:"<key>"}\` — a canonical registry key from <bundled_icons> (pronouns, abstract verbs, times, deictics, and ALL modifiers).
  4. \`{sym:"🤗"}\` — a raw emoji for a concrete noun not in the registry.
  5. \`{gen:"planet_mars", fb:{sym:"🌑",mods:["color_red"]}}\` — LAST RESORT image generation, ONLY when no emoji/key captures it.
    - Self-check: if the \`fb\` would itself BE the answer (a 🦛 emoji is a hippo), drop \`gen\` and use it as \`sym\`.
    - \`fb\` must be a deliberately WEAKER approximation; never \`gen\` a quality an emoji+modifier already covers.

**MODIFIERs** come ONLY from <bundled_icons> (or are emojis). Invented modifiers ("new", "sad", "scary") render as a meaningless dot — use an emoji that encodes the quality, or carry it in \`speech\` only${singleGlyphButtons ? "" : "; never add a GLYPH just to attach an adjective"}.

Example: \`{ speech: "I want a red apple", glyph: [{sym:"i_me"},{sym:"want"},{sym:"🍎",mods:["color_red"]}], label: "Red apple" }\`
</glyph>${languageLevelBlock}

<meta_buttons>
Two META button kinds — set \`button_type\` on a rebuild_board / add_board_button entry. A press changes the SURFACE; nothing is voiced.

  - \`button_type: "wordfinder"\` — Word Finder entry. The user is reaching for a specific CONCEPT but it's impractical to guess.
    - NAME IT. Give it a \`label\` and \`glyph\` like any other ${T.button}, in the user's own terms — "I'm afraid of…", "the word I want", "somewhere else". Only a bare entry (no label) falls back to a magnifying glass, which means nothing to a user who has not been taught it. The ${T.button} is PURPLE either way — that is what tells them a press opens a search rather than says a sentence — so spend the label and the symbol on saying WHAT is being searched for.
    - SEED IT when you know where the search starts: \`seed: "suggestion:<dimension>:<value>"\`, the same keys the narrowing ${T.button}s use. \`seed: "suggestion:feelings.named:afraid"\` opens on "afraid of what?"; \`seed: "suggestion:category:things"\` opens inside things. Without a seed the search starts from "what kind of thing are you looking for?".
    - A FEELING THE USER KEEPS RETURNING TO is the clearest case for one: they have said the feeling and cannot get past it. Seed the feeling and let them say what it is ABOUT.
    - DON'T use for open-ended chitchat ("how are you?" — nothing to "find").
    - DON'T use when you already have a manageable shortlist (offer those as normal buttons).
    - DON'T include while guessing mode is active — server drops it.
  - \`button_type: "more"\` — the MORE OPTIONS button. Renders as "something else" with a RELOAD symbol, in its own colour. Label and glyph are ignored; its appearance is fixed.
    - Pressing it asks YOU for fresh alternatives on the SAME topic. Nothing is voiced.
    - INCLUDE it whenever your ${T.button}s might not cover what the user wants to say.
    - Reach for it most on a narrow ${T.board} — one topic, a short answer list, a yes/no beat.

**"Something else" means MORE OPTIONS. It NEVER means "let's change the subject."**
Users read the reload symbol as "show me the rest of the list", so a change-the-subject ${T.button} wearing it gets pressed by users who only wanted more of the same.

  - Other options on THIS topic → \`{ button_type: "more" }\` ✅
  - A DIFFERENT topic → \`{ button_type: "wordfinder" }\`, or leave it to the device's own ${T.builder} button ✅
  - A normal ${T.button} labelled "Something else" (or drawn with \`🔄\`) to move off the topic ❌
</meta_buttons>

<here_and_now>
The FIRST ${T.board} of a session carries one HERE-AND-NOW ${T.button}: it names WHERE the user is or WHAT is happening around them, read off the \`[CONTEXT]\` observations.
  - "I'm at school", "we're making cookies", "I'm in the garden".
  - A NORMAL ${T.button} — no \`button_type\`. A press voices it like any other.

**A press on it asks to talk about that place or activity.** Rebuild the ${T.board} as its VOCABULARY: the things, people and actions that belong THERE, each a ${T.sentence} the user would say about it.
  - kitchen at lunchtime → "I'm hungry", "I want the bread", "it smells good", "I don't like this", "I'm finished".
  - the garden → "look at the flowers", "I want to sit down", "it's hot out here", "I see a bird".
  - Prefer what was actually OBSERVED there over generic furniture for the category.
  - Include a \`button_type: "more"\` — a place always has more words than fit.
  - Keep one or two ${T.button}s that let them leave the topic.
</here_and_now>

<board_rules>
  - Aim for 6–8 ${T.button}s per ${T.board}. Fill it.
  - No two ${T.button}s should look the same — distinguish at a glance.
  - Never hand-author yes/no/home ${T.button}s (the device row already has them).
  - For "more options", set \`button_type: "more"\` — never a hand-made ${T.button}.
  - Decide the \`speech\` first, then build the \`glyph\` array that depicts it.
</board_rules>${glyphInputTranslation ? `

<input_glyphs>
The device shows the user a glyph translation of what was just said TO them. On EVERY \`rebuild_board\` (header strip) or \`show_binary_choice\` (above the two overlay ${T.button}s) that REPLIES to incoming speech (\`target = USER\` — an [AI to USER] line or a person speaking to the user), also set \`input_glyphs\`: an ARRAY OF SENTENCES depicting THAT incoming speech — not the reply buttons. Each SENTENCE is itself an array of GLYPHs (same shape as button \`glyph\`).
  - ONE sentence → an array with one inner array: \`[[{sym:"want"},{sym:"go"},{sym:"🌳"},{sym:"❓"}]]\` for "Do you want to go outside?".
  - SEVERAL sentences in the incoming speech → one inner array PER sentence, in order: \`[[{sym:"👋"},{sym:"hello"}],[{sym:"how"},{sym:"you"},{sym:"❓"}]]\` for "Hi! How are you?". They render left→right (header) or stacked (overlay) as distinct sentences.
  - It represents what the user HEARD, so build each sentence from the speaker's words.
  - No length cap, but SIMPLIFY to the core meaning when a faithful translation would be long — favour the few GLYPHs that carry the gist, and split into multiple sentences only when the speech really was multiple sentences.
  - Build it with the SAME head-SYMBOL preference order as a button \`glyph\` (see <glyph>): existing SYMBOLs/emoji first, and \`gen\` (ALWAYS paired with an \`fb\` fallback) when no existing SYMBOL fits. The \`fb\` shows immediately and the generated image swaps in once ready — exactly as on a button.
  - Omit \`input_glyphs\` on FOLLOW-UP rebuilds (the user just acted; nothing new was said to them) — the header keeps its last translation.
</input_glyphs>` : ""}

${getBundledIconsBlock()}`;

  if (autoSymbolsEnabled) {
    prompt += `\n\n<generated_symbols>
Generation is enabled. A generated SYMBOL is lowercase_with_underscores English describing a CONCRETE PHYSICAL OBJECT, ALWAYS prefixed with \`generate:\`. See <generation_rules> — generation is the LAST resort.
</generated_symbols>`;
  }

  if (cachedSymbols && cachedSymbols.length > 0) {
    prompt += `\n\n${buildCustomSymbolsBlock(cachedSymbols)}`;
  }

  if (availableBoards && availableBoards.length > 0) {
    const { lines, dropped } = renderPrebuiltBoardLines(availableBoards);
    prompt += `\n\n<prebuilt_boards>
Pre-built ${T.board}s available via set_board(board_key). Always pass the KEY exactly as written below, never the display name. A key is built from the ${T.board}'s name, so it is written in the same script as that name.

The text after each name is the author's note on WHEN to open it — written by a parent or clinician, not by a prompt author, so read it GENEROUSLY:
  - If the note is a bare TOPIC or activity ("buying ice cream", "mealtimes", "the balloon story") rather than a condition. Read it as "open this when THAT is what's going on".
  - If the note is simply a description of the board's contents, open it when that subject is relevant to the conversation or scene.
  - Always display the board if the user or an authority explicitly requests it, even if the note doesn't match the current context.
  - **If you are UNSURE, OFFER the board instead of loading it: give a normal ${T.button} \`open\` = \`{ board: "<key>" }\`.** Pressing it loads that ${T.board}, so the user decides. See <board_buttons>.

${lines.join("\n")}`;
    if (dropped > 0) {
      prompt += `\n  (…and ${dropped} more not listed — ask if none of the above fits.)`;
    }
    if (loadedBoardKey || loadedBoardName) {
      const loadedKey = loadedBoardKey ?? "(unknown)";
      const loadedName = loadedBoardName ?? "(unnamed)";
      prompt += `\n\nCurrently loaded: key="${loadedKey}"  name="${loadedName}"${loadedPageName ? `  page="${loadedPageName}"` : ""}.
  - Navigate sub-pages via press_button(label).
  - Calling rebuild_board() unloads the custom ${T.board} entirely.`;
    }
    prompt += `\n</prebuilt_boards>

<board_buttons>
You have TWO ways to put a pre-built ${T.board} on screen. Both take the same KEY.

  - \`set_board(key)\` — LOAD it now. Use when the activity is clearly underway, or someone asked for it.
  - A ${T.button} with \`open: { board: "<key>" }\` — OFFER it. Pressing it loads that ${T.board}; nothing is voiced.

**Offer when you're not sure the moment has arrived.** A ${T.button} costs the user one press and can be ignored; loading the wrong ${T.board} takes their words away mid-conversation.
  - Topic mentioned once, in passing → OFFER.
  - Topic is now what the conversation is about → \`set_board\`.
  - The user might want to move on to that activity → OFFER, alongside your normal reply ${T.button}s.

Write it like any other ${T.button}: first-person \`speech\` for the intent ("I want to talk about my day"), a \`label\`, and a \`glyph\` that depicts the TOPIC — or omit the glyph to use the ${T.board}'s own icon.
  - Keep it to ONE or TWO board ${T.button}s — the rest of the ${T.board} is still the user's words.
  - Never offer the ${T.board} that is already loaded.
</board_buttons>`;
  }

  const appList = [
    ...(enabledApps ?? []).map(a => `"${a.id}" (${a.name})`),
    ...(availableCustomApps ?? []).map(a => `"${a.id}" (${a.name})`),
  ];
  // Apps whose launch button must carry the thing the user named.
  const queryApps = (enabledApps ?? []).filter(a => a.queryHint);
  if (appList.length > 0) {
    // Build the example from a REAL app in this session's list so the id shown
    // is always one the model may actually use.
    const exampleApp = (enabledApps ?? [])[0] ?? (availableCustomApps ?? [])[0];
    // Photos rides the SAME app pattern as everything else — its per-student
    // detail (the captions a query is matched against) is one more data line
    // on the "photos" entry, NOT a separate block with its own rules. A lone
    // special-cased block taught the model that photos worked differently,
    // which is exactly the confusion it doesn't need. Captions are
    // caretaker-typed free text, so each is wrapped as untrusted.
    const photosLine =
      photoLibrary && photoLibrary.count > 0 && (enabledApps ?? []).some(a => a.id === "photos")
        ? photoLibrary.captions.length > 0
          ? `\n  - "photos" holds ${photoLibrary.count}: ${photoLibrary.captions.map(wrapUntrusted).join(", ")}${photoLibrary.truncated ? ", and more" : ""}. Its \`data\`/\`appQuery\` must be caption words, verbatim — non-matching words open the browse grid.`
          : `\n  - "photos" holds ${photoLibrary.count}, none captioned — open it with NO \`data\`/\`appQuery\` and let ${studentName} choose.`
        : "";
    prompt += `\n\n<apps_context>
Apps: ${appList.join(", ")}.
The DEVICE opens apps ITSELF when the user asks it for one or agrees to its offer — never build an "open it" ${T.button} for an app the DEVICE just said it is opening.
Your job is the OFFER: a launch ${T.button} the user can press to open an app on their own. Set \`open.app\`${queryApps.length > 0 ? ` and \`open.appQuery\` = the thing the user named (${queryApps.map(a => `${a.id}: ${a.queryHint}`).join("; ")}) — these apps open EMPTY without it` : ""}. The ${T.button} that agrees IS the ${T.button} that opens: \`{ label: "Yes", speech: "Yes, I want ${exampleApp.name}", open: { app: "${exampleApp.id}" } }\`. One that only speaks opens nothing.${photosLine}
  - Omit \`glyph\` to use the app's own icon. App already open → prefer add_context_button().
</apps_context>`;
  }


  if (homeActions && homeActions.length > 0) {
    const homeList = homeActions
      .map(a => `"${a.id}" (${a.label})${a.description ? ` — ${a.description}` : ""}`)
      .join("\n  - ");
    // Only explain the trailing note when a slot actually carries one.
    const homeHintLine = homeActions.some(a => a.description)
      ? `\nThe text after each name is the author's note on WHEN to offer it.\n`
      : "";
    prompt += `\n\n<home_context>
The user can control things in their HOME. Give a ${T.button} \`open\` = \`{ home: "<action id>" }\` — pressing it runs that action. Nothing is voiced and the ${T.board} stays put.
  - ${homeList}
${homeHintLine}</home_context>`;
  }

  if (permittedWebsites && permittedWebsites.length > 0) {
    const siteList = flattenPermittedWebsites(permittedWebsites)
      .map(w => `"${w.url}"${w.label ? ` (${w.label})` : ""}`)
      .join(", ");
    prompt += `\n\n<websites_context>
To open a website for the user, add a ${T.button} with \`open.website\` set to the URL — the user presses it to open the browser. Permitted: ${siteList}.
  - When a site is active, offer site-relevant ${T.button}s (e.g. "scroll down", "read this", "go back", "I want to make it").
</websites_context>`;
  }

  prompt += `\n\n<sentence_builder>
The ${T.builder} is where the user composes a SENTENCE one SYMBOL at a time. ${T.tagBuilderState} injections carry the current state:
  - Category tab (WHO / DO / WHAT / WHERE / WHEN)
  - Mode chip
  - Partially-composed SENTENCE
  - Target slot
  - \`exclude_keys\` (SYMBOLs already shown)

Respond with \`suggest_construction_buttons(slot_index, head_candidates, modifier_candidates)\`. Each SUGGESTION is exactly ONE SYMBOL — never a multi-symbol GLYPH or SENTENCE.

  - \`head_candidates\` (up to 4) — HEAD SYMBOLs for the next GLYPH slot.
  - \`modifier_candidates\` (up to 4) — MODIFIER SYMBOLs that attach to the user's current HEAD SYMBOL.

Fill BOTH arrays when each is useful. Empty either array when nothing fits. If BOTH would be empty, call \`no_change()\` instead.

**CATEGORY semantics:**
  - When \`partial_sentence\` is EMPTY OR the previous state had a different category (user just clicked a category tab):
    - The user is BROWSING that category. SUGGEST within its domain — WHO → people, WHERE → places, WHEN → times.
  - When \`partial_sentence\` has content AND the category hasn't just changed (user just placed a SYMBOL):
    - Category is no longer a constraint. SUGGEST the MOST LIKELY NEXT WORD given what's already composed.
    - E.g. after \`i_me+want\` the next slot is whatever naturally completes the thought, NOT restricted to whichever tab is highlighted.

**Lean on conversation context.** The \`<recent_events>\` list contains transcripts, button presses, AI replies, and observer context updates from the last few turns.
  - Surface SUGGESTIONs for the SPECIFIC objects, people, places, and topics just discussed — not just generic vocabulary.
  - If "Mom" walked in two turns ago, "Mom" should be a HEAD SUGGESTION in WHO.
  - If someone mentioned "pizza", "pizza" should appear in WHAT.
  - Concrete named referents beat generic categories whenever the conversation has named one. Applies across all five tabs.

**Other context hooks:**
  - \`current_board: [labels...]\` — the user came from a ${T.board} with those labels; bias SUGGESTIONs toward that topic.
  - \`payload_target\` — the user placed a composable host GLYPH whose embedded blank takes a HEAD SYMBOL. Put SUGGESTIONs in \`head_candidates\` and use \`slot_index\` matching the payload_target's slotIndex.
  - OBSERVER's "builder-candidate" context update (user is looking at / pointing at something while composing) → prioritize that as a head SUGGESTION.

Labels MUST be in ${languageName}. Each SUGGESTION is an object \`{ symbol, fallback?, label }\`; \`fallback\` is REQUIRED when \`symbol\` is a \`generate:\` key.

Optionally call \`set_construction_memory_chips(category, chips)\` to surface up to 3 memory-driven mode chips for the current tab.

<sentence_interpretation>
A ${T.tagComposed} turn means the user finished composing in the ${T.builder} and pressed Play. Call \`interpret(sentence)\` with the natural-language SENTENCE in the user's voice — first-person, as the user would say it.

interpret() is the ONLY action on a ${T.tagComposed} turn — don't also rebuild the board. After interpret() runs, the system delivers your interpreted text to Speaker as a ${T.tagPress} follow-up.

**INTERPRET CREATIVELY.** Don't read the SENTENCE back literally.
  - The user's vocabulary is limited; their meaning is often a metaphor, compound, or near-miss made from available SYMBOLs plus their interests.
  - You have the freshest context — you produced the SUGGESTIONs they composed with.

**Procedure:**
  1. Decode each GLYPH literally.
  2. Look at the COMBINATION — adjacent GLYPHs may compose into a single idea.
    - \`shoe+ball\` → "soccer ball / football"
    - \`water+horse\` → "hippopotamus"
    - \`fish+stick\` → "fish stick" or "fishing rod"
  3. Cross-reference with the user's interests + the suggestions you've been offering.
    - User loves football, emits \`talk+shoe+ball\` → "I want to talk about football" beats "shoe AND ball" overwhelmingly.
  4. Produce natural first-person language — "I want to talk about football" — not a robotic gloss.
  5. Only if the SENTENCE is genuinely incoherent after creative interpretation should you fall back to a literal reading.

Worked examples${sentenceInterpretationExamples ? " — themed on this user's known metaphor / compound patterns" : ""}:
${(sentenceInterpretationExamples ?? ex("sentence_interpretation.worked_examples", language, undefined, config.studentGender)).replace(/\$SPEAK_VERB\$/g, "voice via interpret()")}
</sentence_interpretation>
</sentence_builder>

<guessing_mode>
On [GUESSING STATE] the user is finding a word they can't reach directly. Build the word-finder ${T.board} from a mix of the shapes below, leading with whichever fits.

  - **FOLLOW SPEAKER**: your options should answer the narrowing question Speaker just asked aloud (same axis).
  - On cold entry with no Speaker turn, default to the \`offered_keys\`.

**Button shapes:**

  1. **Registry key** — when the latest [GUESSING STATE] \`offered_keys\` fit, emit a ${T.button} with ONLY \`label\` set to the key (e.g. \`{ label: "suggestion:things.kind:animal" }\`) — NO \`glyph\`, \`speech\`, or \`op\`; the system fills the picture + voiced label. NEVER invent keys.
    - ALWAYS use the full key. Even for a simple two-way question (e.g. fast or slow), emit \`{ label: "suggestion:actions.pace:fast" }\` and \`{ label: "suggestion:actions.pace:slow" }\` — do NOT re-author an offered key as a \`narrow\`/\`contrast\` button copying its value (\`{ kind:"narrow", value:"fast" }\`). That value is untranslated and routes wrong; the registry key is localized for the user.
  2. **Your own narrowing** — when no offered dimension fits, propose one. Use the SAME \`dimension\` across the batch.
    - \`{ kind:"narrow", dimension:"genre", value:"comedy", label:"Comedy", glyph:[{sym:"😂"}], speech:"funny" }\`
    - \`dimension\`+\`value\` are internal English metadata; \`label\` + \`speech\` are what the user sees and hears — ALWAYS in the user's language.
  3. **"Closer to A or B?"** — to bisect a niche concept space, ONE contrast button (2+ poles allowed).
    - \`{ kind:"contrast", dimension:"feel", poles:[{value:"cat_like", label:"like a cat", speech:"more like a cat", glyph:[{sym:"🐱"}]}, {value:"dog_like", label:"like a dog", speech:"more like a dog", glyph:[{sym:"🐶"}]}] }\`
    - The system renders one ${T.button} per pole and records the chosen pole (its \`speech\` is kept as the clue). Pole \`label\` + \`speech\` in the user's language.
  4. **Final guess** — when narrowing has converged.
    - \`{ kind:"guess", value:"Spider-Man", label:"Spider-Man", glyph:[{sym:"🕷️"}] }\` — \`label\` in the user's language.

**Helper buttons** ("More"/"No") steer the registry questions — [GUESSING STATE] says which was pressed.
  - "More" → returns rarer answers to the SAME question; surface the fresh \`offered_keys\`.
  - "No" → that question doesn't fit now; move to the one the next state suggests (it may return later).
  - Neither means you guessed wrong. If the user rejects a candidate WORD, don't repeat it — pivot to fresh guesses or a new dimension.

**Call exit_guessing** once narrowing has CONVERGED and the user confirmed the word (pressed a guess, said "yes" to "is it X?", or named it). Your next board returns to normal conversation about it.
  - Don't exit just because it feels stuck — grind another dimension or commit a guess.
  - The tool only appears WHILE guessing is active.
</guessing_mode>${gestureOverrideBlock(gestureOverrides)}`;

  prompt += `\n\n<examples>\n${boardManagerExamples ?? ex("board_manager.examples", language, false, config.studentGender)}\n</examples>`;

  prompt += memoryBlock(memoryContext, `What you know about this user — interests, recent topics, preferences. Use this to pick buttons the user is likely to want:`);

  prompt += securityBlock(studentName, safetyNotes);
  prompt += environmentBlock();

  // Split out the two MODE blocks so the coordinator can include them only when
  // that mode is active. They were assembled in-place above; extract by tag and
  // return the remainder as the stable `base` (prefix + tail). The blocks are
  // appended AFTER the base at compose time → base stays cacheable.
  const cut = (open: string, close: string): { block: string; rest: string } => {
    const a = prompt.indexOf(open);
    if (a < 0) return { block: "", rest: prompt };
    const b = prompt.indexOf(close, a);
    if (b < 0) return { block: "", rest: prompt };
    const end = b + close.length;
    return { block: prompt.slice(a, end), rest: prompt.slice(0, a) + prompt.slice(end) };
  };
  // Anchor the OPEN tag on its trailing newline so an inline cross-reference
  // (e.g. "See <guessing_mode> for details" in the role) isn't mistaken for the
  // block start. The real blocks are `<tag>\n<content>`; references are `<tag> `.
  const builder = cut("<sentence_builder>\n", "</sentence_builder>");
  prompt = builder.rest;
  const guessing = cut("<guessing_mode>\n", "</guessing_mode>");
  prompt = guessing.rest;
  const base = prompt.replace(/\n{3,}/g, "\n\n").trimEnd();

  return { base, builderBlock: builder.block, guessingBlock: guessing.block };
}

// ===========================================================================
// SESSION VIOLATION MEMORY — <recent_mistakes> block
// ===========================================================================

/** Snapshot shape produced by the Coordinator's violation memory (see
 *  BoardButtonViolation in board-button-validator.ts). */
export type ViolationMemorySnapshot = Array<{ rule: string; tokens: string[] }>;

/** One terse reminder per rule. Rules with tokens append the offending keys. */
const VIOLATION_REMINDERS: Record<string, string> = {
  imagekey_no_fallback: `These are NOT canonical keys — bare use routes to image generation. Wrap in [] AND add an instant fallback, or use an emoji:`,
  imagekey_in_fallback: `Fallbacks must render instantly — never generate:/unknown keys in a fallback. You used:`,
  non_canonical_modifier: `These are NOT modifiers — they render as a dot. Use an emoji (\`.😢\`) or a canonical modifier:`,
  duplicate_glyph: `Two ${T.button}s shared an identical glyph — vary slots or descriptors.`,
  duplicate_fallback: `Two ${T.button}s shared an identical fallback.`,
  narrow_prefix: `Malformed [NARROW:<dimension>] — needs BOTH a non-empty dimension AND value.`,
  contrast_prefix: `Malformed [CONTRAST:<dimension>] — needs a dimension and two "|"-separated poles.`,
  no_visual: `A ${T.button} had no displayable visual — always give a glyph, emoji, or symbol.`,
};

/**
 * Render the session's accumulated validator violations as a
 * `<recent_mistakes>` block for the invocation CONTEXT (user message — NOT
 * the system prompt, which must stay byte-stable for the prompt cache).
 * The Board Manager is stateless, so without this each beat repeats the
 * same rejected-button mistakes all session.
 */
export function renderViolationMemoryBlock(memory: ViolationMemorySnapshot): string {
  if (memory.length === 0) return "";
  const lines: string[] = [
    `<recent_mistakes>`,
    `${T.button}s you built earlier this session were REJECTED for these violations. Do not repeat them:`,
  ];
  for (const v of memory) {
    const reminder = VIOLATION_REMINDERS[v.rule];
    if (!reminder) continue;
    lines.push(v.tokens.length > 0
      ? `- ${reminder} ${v.tokens.map((t) => `\`${t}\``).join(", ")}`
      : `- ${reminder}`);
  }
  lines.push(`</recent_mistakes>`);
  return lines.join("\n");
}

// ===========================================================================
// PER-INVOCATION ACTION HINT BUILDER + EVENT RENDERER
// ===========================================================================

/** Single source for the no_change escape clause appended to action hints
 *  that ask for a rebuild. Was duplicated 6 times across the file. */
const NO_CHANGE_ESCAPE = ` (If the current ${T.board} already covers good options, call \`no_change("<short reason>")\` instead — don't return empty.)`;

/**
 * Per-trigger guidance for which tool the Board Manager should typically
 * reach for. Returns "" when the trigger mix doesn't suggest a clear
 * default — the model picks from the full tool list as usual.
 */
export function invocationActionHint(events: AgentEvent[]): string {
  let hasComposed = false;
  let hasUserInput = false;
  let hasAiSpoke = false;
  let hasContextUpdate = false;
  let hasInterpret = false;
  // Transcribed speech, split by WHO it was aimed at: the AI (the user's own
  // spoken turn — the Coordinator only forwards the student's) versus the user
  // (someone in the room addressing them).
  let userSpokeToAi = false;
  let spokenToUser = false;
  for (const e of events) {
    if (e.type === "transcribed") {
      const toDevice = (e.target ?? "AI") === "AI" || e.target === "DEVICE";
      if (toDevice) userSpokeToAi = true;
      else spokenToUser = true;
    }
    // A composed SENTENCE is NOT a normal user input — it must be voiced
    // via interpret(), not answered with a follow-up board. Keep it out of
    // hasUserInput so the rebuild_board hint below never wins on this turn.
    if (e.type === "sentence_composed") hasComposed = true;
    else if (e.type === "button_pressed") hasUserInput = true;
    // speech_text_finalized is the canonical "AI spoke" trigger (full
    // transcript available, audio possibly still playing). speech_end
    // is also valid as a fallback for code paths that didn't surface
    // text_finalized.
    if (e.type === "speech_text_finalized" || e.type === "speech_end") hasAiSpoke = true;
    if (e.type === "context_update") hasContextUpdate = true;
    if (e.type === "interpret_intent") hasInterpret = true;
  }

  if (hasComposed) {
    // The user finished composing in the SENTENCE BUILDER and pressed Play.
    // The ONLY action is interpret() — voice the natural-language meaning in
    // the user's own voice. Do NOT rebuild the board this turn; the system
    // re-fires a ${T.tagPress} follow-up afterwards for the reply + board.
    return `Action: interpret. The USER played a composed ${T.sentence} in the ${T.builder} — call \`interpret(sentence)\` with its natural-language meaning, first-person, in the user's own voice. This is the ONLY action this turn; do NOT rebuild the board. See <sentence_interpretation>.`;
  }
  if (hasUserInput) {
    return `Action: rebuild_board. The USER just acted — build FOLLOW-UPS that continue or clarify their statement.
  - Think "what might they want to say NEXT?" (not "how would the AI reply").
  - Include options to elaborate, switch direction, or correct themselves.${NO_CHANGE_ESCAPE}`;
  }
  if (hasInterpret) {
    return `Action: rebuild_board. The USER played a composed SENTENCE — build FOLLOW-UPS that continue or clarify the thought they just voiced.${NO_CHANGE_ESCAPE}`;
  }
  // The user SPOKE and the AI has already answered (both events ride this one
  // invocation). The AI's line is the newer beat, so the board answers that —
  // but an ASK inside the user's own words outranks a plain rebuild: it is the
  // only place a spoken request exists, and nothing else will act on it.
  if (userSpokeToAi && hasAiSpoke) {
    return `Action: rebuild_board. The USER spoke to the AI and the AI has just answered — build REPLIES to that answer.
  - The user's OWN words are in the trigger list above. If they ASKED for a surface you control, honor the ask INSTEAD: \`set_board(key)\` for a ${T.board} in <prebuilt_boards>, or a ${T.button} whose \`open\` launches the app / website.${NO_CHANGE_ESCAPE}`;
  }
  if (userSpokeToAi) {
    return `Action: rebuild_board. The USER just spoke to the AI — build FOLLOW-UPS that continue or clarify what they said.
  - If they ASKED for a surface you control, honor the ask INSTEAD: \`set_board(key)\` for a ${T.board} in <prebuilt_boards>, or a ${T.button} whose \`open\` launches the app / website.${NO_CHANGE_ESCAPE}`;
  }
  if (hasAiSpoke) {
    return `Action: rebuild_board. The AI just spoke TO the user — build REPLIES the user might say back. If the AI asked a question, the buttons are the user's plausible answers.${NO_CHANGE_ESCAPE}`;
  }
  if (spokenToUser) {
    return `Action: rebuild_board. Someone in the room spoke TO the user — build REPLIES they might say back.${NO_CHANGE_ESCAPE}`;
  }
  if (hasContextUpdate) {
    return `Action: no_change. Observations don't change what the USER wants to say next — the ${T.board} stays. If the observation is genuinely worth surfacing, use add_context_button to add ONE sidebar item.`;
  }
  return "";
}

/** Track who the AI is currently responding to, by walking events in
 *  chronological order. Pass each event in turn; the returned value
 *  becomes the target used for the NEXT \`speech_text_finalized\` render.
 *
 *  Rule: whoever most recently addressed the AI is who the AI is
 *  responding to.
 *    - \`transcribed\` with target=AI → speaker becomes the addresser.
 *    - \`button_pressed\` with target=AI / \`sentence_composed\` → USER.
 *    - Anything else → unchanged. */
export function updateAIResponseTarget(current: string, event: AgentEvent): string {
  if (event.type === "transcribed") {
    const tgt = event.target ?? "AI";
    if (tgt === "AI" || tgt === "DEVICE") {
      const sp = event.speaker;
      if (sp && sp !== "AI" && sp !== "DEVICE") return sp;
    }
  } else if (event.type === "button_pressed") {
    const tgt = event.target ?? "AI";
    if (tgt === "AI" || tgt === "DEVICE") return "USER";
  } else if (event.type === "sentence_composed") {
    return "USER";
  }
  return current;
}

/** One-line summary of an event for the BoardManager <recent_events> listing.
 *  Returns empty string for events that don't need to surface to Board Manager.
 *
 *  `aiResponseTarget` — for `speech_text_finalized` events, who the AI was
 *  responding to. The caller tracks this by walking events with
 *  `updateAIResponseTarget`. Defaults to "USER". */
export function renderEventLine(event: AgentEvent, aiResponseTarget: string = "USER"): string {
  switch (event.type) {
    case "button_pressed": {
      // A press is functionally a USER statement; render the same shape
      // as a transcript so BoardManager has one consistent mental model
      // for "who said what to whom". Default target is the device.
      // Gesture-triggered presses are marked — the user communicated
      // without touching the board.
      const tgt = event.target ?? "AI";
      const label = tgt === "DEVICE" ? "AI" : tgt;
      const viaGesture = event.via === "gesture" ? " via gesture" : "";
      return `[USER to ${label}${viaGesture}] "${event.sentence}"`;
    }
    case "sentence_composed":
      // Render with the canonical ${T.tagComposed} tag so it matches the
      // <sentence_interpretation> instructions + interpret() tool description
      // the model is keyed on. (Was "[USER (composed) to AI]", which no
      // instruction referenced — the model couldn't connect it to interpret.)
      return `${T.tagComposed} "${event.sentence}"`;
    case "mute_toggled":
      return `[MUTE TOGGLED] now ${event.state}`;
    case "builder_opened":
      return `[BUILDER OPENED]`;
    case "builder_closed":
      return `[BUILDER CLOSED]`;
    case "guessing_entered":
      return `[GUESSING ENTERED]`;
    case "guessing_exited":
      return `[GUESSING EXITED]`;
    case "transcribed": {
      // A weak speech-recogniser score rides in the tag: building a board
      // around words that were never said is how a mis-decode becomes a
      // phantom topic the user then CONFIRMS with a press.
      const clarity = clarityTag(event.asrConfidence);
      // Demoted attributions (coordinator trust gate) are ambient hearsay,
      // not a turn — don't render a "<speaker> to <target>" shape that
      // could re-promote them into something to build reply buttons for.
      if (event.attributionDemotion === "unverified_student_speech")
        return `[HEARD NEAR ${event.speaker} — speaker unverified${clarity}] "${event.text}"`;
      if (event.attributionDemotion === "impossible_speech")
        return `[HEARD NEARBY — speaker unknown${clarity}] "${event.text}"`;
      const tgt = event.target ?? "AI";
      const label = tgt === "DEVICE" ? "AI" : tgt;
      return `[${event.speaker} to ${label}${clarity}] "${event.text}"`;
    }
    case "context_update":
      return `[CONTEXT] ${event.updateType}: ${event.key} — ${event.description}${event.relevance ? ` (relevance: ${event.relevance})` : ""}`;
    case "engagement_change":
      return `[ENGAGEMENT] ${event.state}${event.reason ? ` — ${event.reason}` : ""}`;
    case "speech_text_finalized":
      // BoardManager fires on speech_text_finalized — the moment the
      // FULL transcript is available (audio may still be playing).
      // `aiResponseTarget` is the inferred addressee (last party who
      // addressed the AI). Renders as `[AI to USER]` in normal flow,
      // `[AI to Mom]` etc. when the AI was responding to a third party.
      return `[AI to ${aiResponseTarget}] "${event.transcript}"`;
    case "speech_start":
    case "speech_end":
      // Both are no-ops for BoardManager — speech_text_finalized is
      // the canonical trigger for AI-utterance rebuilds.
      return "";
    case "interpret_intent":
      return `[INTERPRET] (student voice) "${event.sentence}"`;
    case "mode_change":
      return `[MODE] ${event.mode}${event.reason ? ` — ${event.reason}` : ""}`;
    case "monitor_broadcast":
      return `[MONITOR CONTEXT] ${event.contextInjection}`;
    // BoardManager's OWN prior tool calls. Surfacing them in
    // <recent_events> gives the model a self-history — it sees the
    // CANONICAL tool name (rebuild_board, add_board_button, etc.) even
    // when its previous turn emitted a fused PascalCase variant
    // (RebuildBoardButtons), because parseToolCall rewrites the fused
    // call before this event is recorded. Net effect: the model's view
    // of its own past actions always uses the right tool name, which
    // anchors its next turn toward emitting the same correct name.
    case "board_rebuilt": {
      const labels = event.buttons.map((b: any) => `"${b.label}"`).join(", ");
      return `[YOU] rebuild_board(${event.buttons.length} buttons: ${labels})`;
    }
    case "board_button_added":
      return `[YOU] add_board_button("${event.button.label}")`;
    case "binary_choice_shown":
      return `[YOU] show_binary_choice("${event.option1.label}" / "${event.option2.label}")`;
    case "context_button_added":
      return `[YOU] add_context_button("${event.button.label}")`;
    case "board_no_change":
      return `[YOU] no_change${event.reason ? `(${event.reason})` : "()"}`;
    case "guessing_exit_requested":
      return `[YOU] exit_guessing(${event.reason})`;
    case "builder_suggested": {
      const heads = (event.headCandidates ?? []).length;
      const mods = (event.modifierCandidates ?? []).length;
      return `[YOU] suggest_construction_buttons(slot ${event.slotIndex}, ${heads} heads, ${mods} modifiers)`;
    }
    // The following don't help Board Manager decide:
    // (gesture_recognized never arrives raw — the Coordinator converts a
    // resolved gesture into a button_pressed event before fan-out.)
    case "emote_change":
    case "call_person":
    case "focus_request":
    case "audio_request":
    case "attention_change":
    case "alarm_raised":
    case "monitor_call_requested":
    case "private_note":
    case "remain_silent":
    case "thought_leak":
    // Recited context — suppressed upstream; it was never speech, so the
    // board must not be rebuilt from it.
    case "context_leak":
    case "gesture_recognized":
    // Observer's internal cost decision (live↔passive backend) — not relevant
    // to the Board Manager's view of the conversation.
    case "observation_mode_change":
      return "";
    // App / website opens — context that buttons may need to reflect
    // (an open app may want app-specific response buttons).
    case "app_open_requested": {
      const what = `${event.appId}${event.data ? ` (${event.data})` : ""}`;
      // A refused open is NOT an open. Same event, opposite fact — render the
      // refusal so the board is never built for a screen that never appeared.
      return event.blocked
        ? `[APP OPEN REFUSED] ${what} — ${event.blocked}. Nothing opened; the screen is unchanged.`
        : `[APP OPEN] ${what}`;
    }
    case "app_close_requested":
      return `[APP CLOSE]`;
    case "website_open_requested":
      return `[WEBSITE OPEN] ${event.url}${event.label ? ` (${event.label})` : ""}`;
    case "home_action_requested":
      // The user fired a smart-home action. Nothing was said and the board
      // didn't change — surface it so a follow-up can be offered.
      return `[HOME] The user triggered "${event.label}"`;
    case "board_load_requested":
      // BoardManager's own past set_board call. Render in the same
      // `[YOU] tool(args)` shape as the other own-action lines so it
      // can see what surface it just loaded. A `client` source is the USER
      // pressing a board-launch button — attribute it to them, not to you.
      return event.source === "client"
        ? `[USER] opened the pre-built ${T.board} "${event.boardKey}" (pressed a ${T.button} you offered)`
        : `[YOU] set_board("${event.boardKey}")`;
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return "";
    }
  }
}

// ===========================================================================
// ACTION-HINT STRINGS — referenced by board-manager-agent's renderInvocationContext
// ===========================================================================

/** Action hint for a force-rebuild — prepended to the palette directive
 *  supplied via HOME_INTENTS (a home press) or buildStartupBoardDirective
 *  (the session's first board).
 *
 *  SITUATION-NEUTRAL: the directive states its own occasion in its first
 *  sentence, so this wrapper must not claim one. It used to open with "The
 *  user pressed a home-board navigation button", which was a lie on every
 *  non-home directive. */
export function buildForceRebuildHint(forceRebuildDirective: string): string {
  return `Action: rebuild_board — MANDATORY. A fresh palette is required this turn.

${forceRebuildDirective}

Even if the current ${T.board}'s labels look related, REBUILD anyway. Do NOT call no_change on this turn.`;
}

/** Action hint for guessing mode when Speaker just asked a question on
 *  the prior turn. */
export const GUESSING_HINT_AFTER_AI_SPEECH =
  `Action: rebuild_board with ${T.button}s that ANSWER the AI's question in <recent_events>. Pick whichever shape fits:
  - \`suggestion:\` keys from offered_keys — when the engine's dimension matches the question.
  - Your own \`kind:"narrow"\` buttons — when Speaker steered onto a different axis.
  - \`kind:"guess"\` candidates — when Speaker is fishing for a specific word.${NO_CHANGE_ESCAPE}`;

/** Action hint for guessing mode on cold entry (no Speaker turn yet). */
export const GUESSING_HINT_COLD =
  `Action: rebuild_board using the \`suggestion:dim:value\` keys from <guessing_state> offered_keys as the ${T.button}s' \`label\` fields. No AI question to anchor to yet — the engine's default narrowing is the right starting point.${NO_CHANGE_ESCAPE}`;

/** Action hint for builder mode. */
export const BUILDER_HINT =
  `Action: suggest_construction_buttons.
  - Up to 4 head_candidates.
  - Up to 4 modifier_candidates (when a HEAD SYMBOL is placed).
  - Don't touch the main ${T.board} while the ${T.builder} is open.${NO_CHANGE_ESCAPE}`;

// ===========================================================================
// RETRY-FEEDBACK STRING BUILDERS
// ===========================================================================
//
// The Coordinator's queueBoardMgrEmptyResponseRetry / queueBoardMgrFeedback
// methods own the queue/invoke logic; just the prompt-shaped strings live
// here.

/** Builder for the "empty response" retry feedback the Coordinator queues
 *  when BM produced no tool calls (or no_changed a mandatory rebuild) on a
 *  trigger that demanded a rebuild. State-aware: home-press directive,
 *  word-finder mode, builder mode, and default. */
export function buildEmptyResponseRetryFeedback(args: {
  inGuessingMode: boolean;
  inBuilderMode: boolean;
  /** Set when a mandatory rebuild is still outstanding (a home-press topic
   *  switch, or the session's first board) — the model either returned
   *  nothing or no_changed it. Takes priority over the mode-based directives
   *  below and re-demands the fresh palette by name. Situation-neutral like
   *  `buildForceRebuildHint`: the directive names its own occasion. */
  forceRebuildDirective?: string;
}): string {
  // A mandatory rebuild is mandatory — no_change is never valid here, so the
  // retry must re-state the directive rather than the generic "no tool calls"
  // copy (the model may well have CALLED no_change).
  if (args.forceRebuildDirective) {
    return `[rebuild required]
A fresh palette was required on the previous turn and you did not produce one — the ${T.board} MUST be replaced, even if the current buttons look related. no_change is NOT valid on this turn.

${args.forceRebuildDirective}

Call \`rebuild_board(buttons=[...])\` now with a wide, varied set of ${T.button}s.`;
  }
  let directive: string;
  if (args.inGuessingMode) {
    directive = `The user is in word-finder mode. Call \`rebuild_board(buttons=[...])\` using the \`suggestion:dim:value\` keys from the latest [GUESSING STATE] as the ${T.button}s' \`label\` fields.`;
  } else if (args.inBuilderMode) {
    directive = `The user is composing in the ${T.builder}. Call \`suggest_construction_buttons(slot_index, head_candidates, modifier_candidates)\` with appropriate SYMBOLs.`;
  } else {
    directive = `The user (or someone speaking to them) just took an action — they need response options now. Call \`rebuild_board(buttons=[...])\` with a fresh set of ${T.button}s.`;
  }
  return `[empty response]
Your previous response had no tool calls.

${directive}

If the current ${T.board} genuinely still fits and no rebuild is warranted, call \`no_change("<short reason>")\` instead — empty responses are never valid.`;
}

/** Builder for the validator-error feedback the Coordinator queues when
 *  the board-button-validator rejected the model's output. */
export function buildValidatorErrorFeedback(toolName: string, errors: string[]): string {
  const header = `[${toolName} — rejected ${T.button}s]`;
  const body = errors.map(e => `  - ${e}`).join("\n");
  return `${header}\n${body}\n\nRebuild correctly:
  - Supply a \`fb\` only when a GLYPH uses \`gen\`; omit it otherwise.
  - Use only canonical modifiers from <bundled_icons>.
  - Give every ${T.button} a unique visual.${NO_CHANGE_ESCAPE}`;
}

// ===========================================================================
// TOOL DECLARATIONS
// ===========================================================================
//
// Buttons are delivered as a STRUCTURED ARRAY of objects — one object per
// button. Each carries `speech` (TTS), `glyph` (visual array), `label`
// (on-button text). See <glyph> in the system prompt for the GLYPH shape.

export interface BoardManagerToolConfig {
  /** Pre-built custom boards available to load via set_board(). */
  availableBoards: Array<{ key: string; name: string }>;
  /** Normalized key of the currently loaded board, for the set_board
   *  "do NOT re-select" note. Distinct from `loadedBoardName` so the
   *  prompt never asks the model to pass the human label to the tool. */
  loadedBoardKey?: string | null;
  /** Currently-loaded custom board name, for the set_board description. */
  loadedBoardName?: string | null;
  /** True when a custom board is currently loaded — enables press_button. */
  hasLoadedBoard: boolean;
  /** Grid slot count (default 12). */
  maxBoardItems?: number;
  /** Student's primary language code, for localized example strings inside
   *  tool descriptions. */
  language?: string;
  /** Student's grammatical gender ("male" | "female"), so the localized example
   *  utterances inside tool descriptions match the student's gender in gendered
   *  languages. Omit → masculine default. */
  studentGender?: string;
  /** When true, every button must carry a single GLYPH (modifiers OK).
   *  Drives the format hints embedded in button-shaped tool descriptions. */
  singleGlyphButtons?: boolean;
  /** Experiment: when on, rebuild_board gains an `input_glyphs` param so the
   *  AI can mirror incoming speech into the header glyph strip. */
  glyphInputTranslation?: boolean;
  /** True when the Word Finder narrowing session is currently active.
   *  Adds `exit_guessing` to the tool surface so the AI can declare
   *  convergence and return to normal conversation. */
  guessingActive?: boolean;
  /** Websites the student is permitted to visit. When non-empty, the button
   *  schema gains an `open.website` field so the BoardManager can author a
   *  button that launches the browser on that URL. Re-gated in the coordinator. */
  permittedWebsites?: PermittedWebsite[];
  /** Apps the BoardManager may author `open.app` launch-buttons for — the
   *  enabled built-in apps plus available custom games, as `{ id, name }`. */
  enabledApps?: Array<{ id: string; name: string; queryHint?: string }>;
  /** Smart-home actions the BoardManager may author `open.home` buttons for
   *  (ENABLED slots only). When empty the `open.home` sub-field stays off the
   *  schema entirely. Re-gated in the coordinator. */
  homeActions?: Array<{ id: string; label: string }>;
}

// ---------------------------------------------------------------------------
// Shared button-object schema
// ---------------------------------------------------------------------------

/** One GLYPH object in a `glyph` array — reused for button glyphs and contrast
 *  pole glyphs. A head SYMBOL (`sym`) OR a generate key (`gen`+`fb`), + mods. */
function glyphItemSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      sym: {
        type: "string",
        description: `Head SYMBOL — emoji, canonical key from <bundled_icons>, or \`symbol:ID\`/\`face:ID\`. See <glyph> for the preference order. Provide EITHER \`sym\` OR \`gen\`.`,
      },
      gen: {
        type: "string",
        description: `LAST RESORT — generate an image for a concrete object the vocabulary can't express (lowercase_snake_case, NO \`generate:\` prefix). Requires \`fb\`.`,
      },
      mods: {
        type: "array",
        items: { type: "string" },
        description: `MODIFIER keys from <bundled_icons> only (e.g. "color_red", "big", "two", "my"). NEVER invent modifiers — they render as a dot.`,
      },
      fb: {
        type: "object",
        description: `Fallback for a \`gen\` GLYPH — shown while the image generates and if it fails. Same shape as a normal GLYPH but NEVER \`gen\`.`,
        properties: {
          sym: { type: "string" },
          mods: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
}

/** Options that gate optional schema sections. Trimming the schema per
 *  invocation reduces the surface the model has to reason about and cuts
 *  down on MALFORMED_FUNCTION_CALL responses (Gemini Flash tends to fail
 *  JSON gen when the schema sprouts many alternative branches). */
interface ButtonSchemaOpts {
  includeGuessingFields?: boolean;
  includeMetaButtonField?: boolean;
  /** Compact `open` schema (binary-choice options): keeps the launch fields but
   *  does not re-enumerate the allowed targets — rebuild_board's schema and
   *  <apps_context> already list them once. */
  openBrief?: boolean;
  /** When present + non-empty, exposes an `open` field so the button LAUNCHES
   *  an app/website/pre-built board — or FIRES a smart-home action — on press
   *  instead of voicing speech. Lists constrain the AI to the permitted
   *  targets; the coordinator re-gates server-side. */
  openTargets?: {
    websites: Array<{ url: string; label: string }>;
    apps: Array<{ id: string; name: string; queryHint?: string }>;
    /** Pre-built board KEYS. Not enumerated in the description — they are
     *  already listed with their names + author hints in <prebuilt_boards>,
     *  and this schema is inlined on every button of every rebuild. */
    boards: string[];
    /** Smart-home action slots (ENABLED only). Enumerated inline like apps —
     *  the list is short and the ids are opaque slugs. */
    homeActions: Array<{ id: string; label: string }>;
  };
}

/** Build the `openTargets` for buttonObjectSchema from a tool config — flattens
 *  permitted websites (incl. subpages), the enabled-app list, the pre-built
 *  board keys, and the smart-home slots. Returns undefined when there's nothing
 *  launchable, so the `open` field stays off the schema entirely. */
function openTargetsFromConfig(config: BoardManagerToolConfig): ButtonSchemaOpts["openTargets"] | undefined {
  const websites = (config.permittedWebsites ? flattenPermittedWebsites(config.permittedWebsites) : [])
    .map(w => ({ url: w.url, label: w.label }));
  const apps = config.enabledApps ?? [];
  const boards = config.availableBoards.map(b => b.key);
  const homeActions = config.homeActions ?? [];
  if (websites.length === 0 && apps.length === 0 && boards.length === 0 && homeActions.length === 0) return undefined;
  return { websites, apps, boards, homeActions };
}

function buttonObjectSchema(opts: ButtonSchemaOpts = {}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    speech: {
      type: "string",
      description: `First-person SENTENCE the TTS voices when this ${T.button} is pressed (e.g. "I want some water", "I'm tired").${opts.includeMetaButtonField ? ` Ignored when \`button_type\` is set — a META press changes the surface and voices nothing.` : ""}`,
    },
    glyph: {
      type: "array",
      description: `Visual encoding — array of 1–3 GLYPH objects, rendered left→right. See <glyph> in the system prompt for the GLYPH shape and head-symbol preference order.${opts.includeMetaButtonField ? ` Ignored for \`button_type: "more"\`; USED for \`"wordfinder"\`, which wears the symbol you give it.` : ""}`,
      items: glyphItemSchema(),
    },
    op: {
      type: "string",
      enum: ["past", "future", "question"],
      description: `OPTIONAL sentence-level OPERATOR — conjugate \`speech\` to match; visual unchanged.`,
    },
    label: {
      type: "string",
      description: `Short text shown on the ${T.button} face, in the user's language. Not voiced.${opts.includeMetaButtonField ? ` Ignored for \`button_type: "more"\`; USED for \`"wordfinder"\` — name the search there.` : ""}`,
    },
    role: {
      type: "string",
      enum: ["reply", "bid"],
      description: `The conversational ROLE of this ${T.button}. "reply" = an answer, reaction, or acknowledgement that does NOT require the other side to respond ("Me too", "I'm tired", "I want water"). "bid" = a question or request that HANDS THE TURN to the other side and expects a response ("What about you?", "Why?", "Can you help me?"). Default "reply" if omitted. See <conversation_register>.`,
    },
    addressee: {
      type: "string",
      description: `GROUP CHAT ONLY. When this ${T.button} is aimed at ONE specific peer (replying to or asking that peer directly), set this to that peer's NAME exactly as it appears in the conversation — e.g. the speaker in a peer's transcript ("[Sara to YOU] …" → "Sara") or the name in a "[CHAT FOCUS]" note. Omit (or "ROOM") for something said to the whole group. A "bid" addressed to a specific peer hands them the turn. Ignore this field entirely outside a group chat.`,
    },
    rowSpan: {
      type: "integer",
      description: "Optional. Number of grid rows this button spans (>=2). Omit for a 1×1 button.",
    },
    colSpan: {
      type: "integer",
      description: "Optional. Number of grid columns this button spans (>=2). Omit for a 1×1 button.",
    },
  };

  if (opts.openTargets && (opts.openTargets.websites.length > 0 || opts.openTargets.apps.length > 0 || opts.openTargets.boards.length > 0 || opts.openTargets.homeActions.length > 0)) {
    const { websites, apps, boards, homeActions } = opts.openTargets;
    const appsWithQuery = apps.filter((a): a is { id: string; name: string; queryHint: string } => !!a.queryHint);
    if (opts.openBrief) {
      // Compact variant (binary-choice options): same fields, but the allowed
      // targets are NOT re-enumerated — rebuild_board's schema and
      // <apps_context> already carry the lists once.
      properties.open = {
        type: "object",
        description: `OPTIONAL. Pressing this option also OPENS the target — same permitted targets and rules as rebuild_board's \`open\`${appsWithQuery.length > 0 ? " (incl. \`appQuery\`)" : ""}.`,
        properties: {
          ...(websites.length > 0 ? { website: { type: "string" } } : {}),
          ...(apps.length > 0 ? { app: { type: "string" } } : {}),
          ...(appsWithQuery.length > 0 ? { appQuery: { type: "string" } } : {}),
          ...(boards.length > 0 ? { board: { type: "string" } } : {}),
        },
      };
    } else {
    const allowed: string[] = [];
    if (websites.length > 0) {
      allowed.push(`WEBSITES — ${websites.map(w => `"${w.url}"${w.label ? ` (${w.label})` : ""}`).join(", ")}`);
    }
    if (apps.length > 0) {
      allowed.push(`APPS — ${apps.map(a => `"${a.id}"${a.name ? ` (${a.name})` : ""}`).join(", ")}`);
    }
    if (boards.length > 0) {
      allowed.push(`PRE-BUILT ${T.board}S — the keys listed in <prebuilt_boards>`);
    }
    if (homeActions.length > 0) {
      allowed.push(`HOME ACTIONS — ${homeActions.map(a => `"${a.id}" (${a.label})`).join(", ")}`);
    }
    const oneOf = [
      ...(websites.length > 0 ? ["`website`"] : []),
      ...(apps.length > 0 ? ["`app`"] : []),
      ...(boards.length > 0 ? ["`board`"] : []),
      ...(homeActions.length > 0 ? ["`home`"] : []),
    ].join(" / ");
    properties.open = {
      type: "object",
      description: `OPTIONAL. Makes this ${T.button} OPEN something when pressed, instead of voicing \`speech\`. Set EXACTLY ONE of ${oneOf}. Still fill \`speech\`/\`label\`/\`glyph\` normally — write \`speech\` as the user's first-person intent for the action (e.g. "I want to read my book"). Only these targets are permitted: ${allowed.join("; ")}. Any other value is dropped.`,
      properties: {
        ...(websites.length > 0 ? { website: { type: "string", description: `A permitted website URL to open in the browser (one of the listed WEBSITES, or a subpage of one).` } } : {}),
        ...(apps.length > 0 ? { app: { type: "string", description: `An app id to launch (one of the listed APPS).` } } : {}),
        ...(appsWithQuery.length > 0
          ? {
              appQuery: {
                type: "string",
                description: `ONLY with \`app\`. The thing the user named, in their words — ${appsWithQuery.map(a => `"${a.id}"`).join(", ")} open EMPTY without it.`,
              },
            }
          : {}),
        ...(boards.length > 0 ? { board: { type: "string", description: `A pre-built ${T.board} KEY from <prebuilt_boards>, copied exactly (NOT the display name). Pressing loads that ${T.board} — the OFFER alternative to set_board. See <board_buttons>.` } } : {}),
        ...(homeActions.length > 0 ? { home: { type: "string", description: `A HOME ACTION id (one of the listed HOME ACTIONS). Pressing runs it in the user's home; nothing is voiced and the ${T.board} stays put. See <home_context>.` } } : {}),
      },
    };
    }
  }

  if (opts.includeGuessingFields) {
    properties.kind = {
      type: "string",
      enum: ["narrow", "contrast", "guess"],
      description: `WORD FINDER only. See <guessing_mode> for usage:
  - "narrow" — AI-proposed narrowing step. Set \`dimension\` + \`value\`. Use a SHARED \`dimension\` across the batch.
  - "contrast" — "is it closer to A or B?" choice. Set \`dimension\` + \`poles\` (2+).
  - "guess" — candidate WORD. Set \`value\` (or \`speech\`/\`label\`).
Omit \`kind\` for a normal ${T.button} and for registry \`suggestion:\` keys (those go in \`label\`).`,
    };
    properties.dimension = {
      type: "string",
      description: `For "narrow"/"contrast": a short human-readable narrowing axis ("genre", "time of day", "feel"). Internal metadata — not shown.`,
    };
    properties.value = {
      type: "string",
      description: `For "narrow"/"guess": the MACHINE-READABLE value the press records — for "narrow" short English snake_case (e.g. "in_nature"); for "guess" the candidate word. NEVER shown: the user sees \`label\`, so ALWAYS fill \`label\` (and \`speech\`) in the user's language.`,
    };
    properties.poles = {
      type: "array",
      description: `For "contrast": 2+ poles. Each is { value (machine-readable, English), label (shown — user's language), speech? (voiced + recorded clue), glyph? (visual array) }.`,
      items: {
        type: "object",
        properties: {
          value: { type: "string" },
          label: { type: "string" },
          speech: { type: "string" },
          glyph: { type: "array", items: glyphItemSchema() },
        },
      },
    };
  }

  if (opts.includeMetaButtonField) {
    // While the Word Finder is active (includeGuessingFields is set iff so),
    // the "wordfinder" entry is a no-op the coordinator drops — keep it OUT
    // of the enum entirely, not just prose-warned. With the value dangling in
    // the schema, Flash stamped button_type:"wordfinder" onto its narrowing
    // buttons; each was then canonicalized to a bare magnifier and dropped,
    // shipping near-empty word-finder boards (2026-08-19 session).
    const wordfinderAllowed = !opts.includeGuessingFields;
    properties.button_type = {
      type: "string",
      enum: wordfinderAllowed ? ["wordfinder", "more"] : ["more"],
      description: `OPTIONAL. Marks this entry as a META button — a press changes the SURFACE and voices nothing, so \`speech\` is ignored:
${wordfinderAllowed ? `  - "wordfinder" — opens Word Finder narrowing. Keeps YOUR \`label\` and \`glyph\`: name the search in the user's own words ("I'm afraid of…"). It is painted purple whatever you call it. Omit the label and it falls back to a bare magnifier.
` : ""}  - "more" — "something else" with a RELOAD symbol; asks you for fresh options on the same topic. Fixed appearance; \`label\` and \`glyph\` ignored.
See <meta_buttons> for when to use each. NEVER set this on a normal ${T.button} — it erases the ${T.button}'s own content.`,
    };
    if (wordfinderAllowed) {
      properties.seed = {
        type: "string",
        description: `OPTIONAL, and only with \`button_type: "wordfinder"\`. Where the search STARTS, as a \`suggestion:<dimension>:<value>\` key — the same keys the narrowing ${T.button}s use. E.g. "suggestion:feelings.named:afraid" opens on "afraid of what?"; "suggestion:category:things" opens inside things. Omit when you don't know; the search then begins at "what kind of thing are you looking for?".`,
      };
    }
  }

  return {
    type: "object",
    properties,
    required: ["speech", "label"],
  };
}

function rebuildBoardButtonsDescription(config: BoardManagerToolConfig): string {
  const language = config.language;
  const gender = config.studentGender;
  const singleGlyph = !!config.singleGlyphButtons;
  const exampleA = ex("tool.sbf_speech_water", language, undefined, gender);
  const exampleB = ex("tool.sbf_speech_three_glyph_banana", language, undefined, gender);
  const exampleC = singleGlyph
    ? ""
    : ` Match glyph count to meaning — 1-glyph for one-word answers (${ex("tool.sbf_speech_one_glyph_tired", language, undefined, gender)}), up to 3-glyph for full thoughts (${exampleB}). Don't pad.`;
  return `Up to 8 ${T.button}s for the ${T.board}. WIDE VARIETY. Each is \`{ speech, glyph, label }\` — \`speech\` is the voiced SENTENCE (e.g. ${exampleA}), \`glyph\` is the visual array, \`label\` is the on-button text.${exampleC}`;
}

function buildRebuildBoardTool(config: BoardManagerToolConfig): FunctionDeclaration {
  return {
    name: "rebuild_board",
    description: `Replace the ${T.board} with up to 8 fresh ${T.button}s. See <when_to_act> for when to call this.
${(config.enabledApps?.length || config.permittedWebsites?.length) ? `
When the AI just OFFERED an app, photo, or site ("want to look at a picture of an owl?"), the agreeing ${T.button} MUST carry \`open\` (+\`appQuery\` for the thing named) — a yes that only speaks opens nothing. See <apps_context>.
` : ""}
The \`target\` field declares who the user's button replies are addressed to:
  - "DEVICE" (default) — user is talking to the AI.
  - "USER" — user is talking to themselves.
  - A person's name — user is replying to someone in the room (e.g. \`target: "Teacher"\`).`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        buttons: {
          type: "array",
          description: rebuildBoardButtonsDescription(config),
          items: buttonObjectSchema({
            includeMetaButtonField: true,
            includeGuessingFields: !!config.guessingActive,
            openTargets: openTargetsFromConfig(config),
          }),
        },
        target: {
          type: "string",
          description: `Who the buttons reply to. "DEVICE" (default), "USER", or a person's name.`,
        },
        ...(config.glyphInputTranslation
          ? {
              input_glyphs: {
                type: "array",
                description: `Glyph translation of the speech you are REPLYING to (the [AI to USER] / person-to-user line that triggered this board), shown in the header so the user sees what was just said to them. ARRAY OF SENTENCES — each item is one sentence's GLYPH array (same GLYPH shape as a button \`glyph\`, incl. \`gen\`+\`fb\`). One inner array per sentence. See <input_glyphs>. Simplify to the gist. Omit on follow-ups to the user's own action.`,
                items: { type: "array", items: glyphItemSchema() },
              },
            }
          : {}),
      },
      required: ["buttons"],
    },
  };
}

function buildAddBoardButtonTool(config: BoardManagerToolConfig): FunctionDeclaration {
  const max = config.maxBoardItems || 8;
  return {
    name: "add_board_button",
    description: `Add ONE ${T.button} to the CURRENT ${T.board} without replacing it. See <role>'s "Choosing which tool" for when to use this vs rebuild_board.

Merge behavior:
  - Exact duplicate → collapsed.
  - Board at the ${max}-button cap → the new button DISPLACES the most-similar existing one (by label/glyph overlap) in place.

Do NOT call multiple times to assemble a board — use rebuild_board for that.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        button: buttonObjectSchema({
          includeMetaButtonField: true,
          includeGuessingFields: !!config.guessingActive,
          openTargets: openTargetsFromConfig(config),
        }),
        target: {
          type: "string",
          description: `Who this button's reply is addressed to. Same semantics as rebuild_board's target.`,
        },
      },
      required: ["button"],
    },
  };
}

function buildAddContextButtonTool(): FunctionDeclaration {
  return {
    name: "add_context_button",
    description: `Add ONE ${T.button} to the SIDEBAR (left strip, 4 visible slots, scrolls). This is the SIDEBAR, NOT the main board — for the main board use add_board_button.

Use when Observer has noted something new (object, person entering) the user might want to interact with. Don't duplicate ${T.board} labels.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        // Sidebar buttons don't use META kinds and don't participate in
        // word-finder narrowing — minimal schema.
        button: buttonObjectSchema(),
      },
      required: ["button"],
    },
  };
}

function buildSetBoardTool(config: BoardManagerToolConfig): FunctionDeclaration {
  // Display each option as `key="snack_time" (name: "Snack Time")` so the
  // key is the primary identifier in the same column position everywhere
  // it appears (system prompt + tool description + recent_events line).
  const boardList = config.availableBoards
    .map(b => `key="${b.key}" (name: "${b.name}")`)
    .join(", ");
  // 🚨 WHICH BOARD IS LOADED DOES NOT BELONG IN A TOOL DESCRIPTION.
  //
  // The provider's prompt cache is keyed on sha256(model + systemPrompt +
  // tools + toolConfig), so any text that varies session-to-session inside a
  // tool declaration mints a BRAND NEW CACHE, billed at the full input rate for
  // the whole ~13.5k-token prompt. Naming the loaded board here made that key
  // vary with every board and app the student opened — an unbounded number of
  // cache variants, one per distinct board NAME.
  //
  // Measured 2026-08-23: a steady turn cost ~14.2k prompt tokens of which
  // ~13.4k were cached (~800 fresh). Turns that followed a board/app change
  // cost ~27.7k — the same turn plus a whole extra prompt for the re-creation.
  // Three of those in one five-minute session.
  //
  // The fact itself is not lost: `renderInvocationContext` reports the loaded
  // board in the per-turn user message, which is uncached by nature and already
  // changes every turn. State goes in the turn; only STABLE text goes in a tool.
  return {
    name: "set_board",
    description: `Switch to a pre-built custom ${T.board}. Pass the KEY, never the display name. Available: ${boardList}. Prefer this over rebuild_board() when a custom ${T.board} fits the current activity. The ${T.board} currently loaded (if any) is named in <current_state> — do NOT re-select it.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        board_key: {
          type: "string",
          description: `Board key to load, copied exactly (NOT the human name). One of: ${config.availableBoards.map(b => `"${b.key}"`).join(", ")}.`,
        },
      },
      required: ["board_key"],
    },
  };
}

function buildPressButtonTool(): FunctionDeclaration {
  return {
    name: "press_button",
    description: `Press a navigation ${T.button} on the current custom ${T.board} to go to a sub-page. Prefer navigating sub-pages over generating new ${T.button}s from scratch.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: `Label of the navigation ${T.button} to press.` },
      },
      required: ["label"],
    },
  };
}

function buildInterpretTool(): FunctionDeclaration {
  return {
    name: "interpret",
    description: `Voice a natural-language SENTENCE through the USER's TTS voice. Call ONLY in response to a ${T.tagComposed} turn — never spontaneously, never on a regular ${T.tagPress}.

The \`sentence\` argument MUST be the FINAL natural-language sentence, first-person, as the user would say it.
  - NEVER pass the raw composed-sentence string.
  - NEVER echo individual SYMBOLs as separate items.
  - See <sentence_interpretation> for the creative-interpretation procedure.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        sentence: {
          type: "string",
          description: "The user's intended SENTENCE in their voice. First-person, natural language.",
        },
      },
      required: ["sentence"],
    },
  };
}

/** Launch targets for a binary-choice option: everything a board button may
 *  open, MINUS home actions (see the note on the schema below). */
function binaryChoiceOpenTargets(config: BoardManagerToolConfig): ButtonSchemaOpts["openTargets"] | undefined {
  const targets = openTargetsFromConfig(config);
  if (!targets) return undefined;
  const withoutHome = { ...targets, homeActions: [] };
  const empty =
    withoutHome.websites.length === 0 &&
    withoutHome.apps.length === 0 &&
    withoutHome.boards.length === 0;
  return empty ? undefined : withoutHome;
}

function buildShowBinaryChoiceTool(config: BoardManagerToolConfig): FunctionDeclaration {
  return {
    name: "show_binary_choice",
    description: `Show two large overlay ${T.button}s. Use for ANY question with exactly two natural answers — binary choice or yes/no.

  - For yes/no, use the canonical \`yes\`/\`no\` SYMBOLs in each option's \`glyph\` field — they render with animated yes/no icons and default green/red coloring.
  - A "Neither" button is added automatically.
  - For open-ended questions, use rebuild_board() instead.
  - When the question OFFERS an app/photo/site, the agreeing option MUST carry \`open\` (same rules as rebuild_board, incl. \`appQuery\`) — a yes that only speaks opens nothing.

\`target\` semantics: same as rebuild_board.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        // Launch targets on BOTH options. Without these an app offer phrased as
        // a yes/no question — which is how most of them are phrased — could
        // only ever produce a dead press: the model picks show_binary_choice
        // for "want to open X?", the student presses yes, and nothing opens.
        // Home actions are deliberately excluded: firing a smart-home slot off
        // an overlay bypasses the confirm step that flow is built around.
        option1: buttonObjectSchema({ openTargets: binaryChoiceOpenTargets(config), openBrief: true }),
        option2: buttonObjectSchema({ openTargets: binaryChoiceOpenTargets(config), openBrief: true }),
        target: {
          type: "string",
          description: `Who the choice is addressed to. "DEVICE" (default), "USER", or a person's name.`,
        },
        ...(config.glyphInputTranslation
          ? {
              input_glyphs: {
                type: "array",
                description: `Glyph translation of the speech you are REPLYING to (the [AI to USER] / person-to-user line that triggered this choice), shown ABOVE the two overlay ${T.button}s so the user sees what was just said to them. ARRAY OF SENTENCES — each item is one sentence's GLYPH array (same GLYPH shape as a button \`glyph\`, incl. \`gen\`+\`fb\`). One inner array per sentence. See <input_glyphs>. Simplify to the gist. Omit when the choice isn't a reply to incoming speech.`,
                items: { type: "array", items: glyphItemSchema() },
              },
            }
          : {}),
      },
      required: ["option1", "option2"],
    },
  };
}

// ---------------------------------------------------------------------------
// suggest_construction_buttons — SUGGESTIONs are single SYMBOLs, not full
// SENTENCEs, so the object shape is narrower (no speech).
// ---------------------------------------------------------------------------

function buildSuggestionObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: `ONE SYMBOL — emoji, canonical registry key, \`symbol:ID\`/\`face:ID\`, or \`generate:lowercase_snake_case\` (last resort, requires \`fallback\`).`,
      },
      fallback: {
        type: "string",
        description: `REQUIRED when \`symbol\` is a \`generate:\` key; OMIT otherwise. Never contains \`generate:\`.`,
      },
      label: {
        type: "string",
        description: "Short display label for this SUGGESTION (in the user's language).",
      },
    },
    required: ["symbol", "label"],
  };
}

function buildSuggestConstructionButtonsTool(): FunctionDeclaration {
  return {
    name: "suggest_construction_buttons",
    description: `Populate the ${T.builder}'s AI strips with SUGGESTIONs. Call ONLY in response to a ${T.tagBuilderState} context — never spontaneously. See <sentence_builder> for category semantics and context hooks.

Each SUGGESTION is exactly ONE SYMBOL — never a multi-symbol GLYPH or SENTENCE.

If both arrays would be empty, call \`no_change()\` instead.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        slot_index: {
          type: "integer",
          description: `Which builder position the head SUGGESTIONs target. Use the \`targetSlot\` value from the ${T.tagBuilderState} injection. Use 0 if uncertain.`,
        },
        head_candidates: {
          type: "array",
          description: "Up to 4 head SYMBOL SUGGESTIONs for the NEXT GLYPH slot.",
          items: buildSuggestionObjectSchema(),
        },
        modifier_candidates: {
          type: "array",
          description: "Up to 4 modifier SYMBOL SUGGESTIONs that attach to the user's CURRENT HEAD SYMBOL.",
          items: buildSuggestionObjectSchema(),
        },
      },
      required: ["slot_index"],
    },
  };
}

function buildSetMemoryChipsTool(): FunctionDeclaration {
  return {
    name: "set_construction_memory_chips",
    description: `Update the memory-driven mode chips on the ${T.builder} for one category tab. 0–3 chips surface the user's special interests, recent topics, or context-relevant filters. Pass an empty array to clear.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["who", "do", "what", "where", "when"],
          description: "Which tab these chips apply to.",
        },
        chips: {
          type: "array",
          description: "Up to 3 chips. Replaces any prior memory chips for this category.",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Stable snake_case key." },
              label: { type: "string", description: "Short display label (2–3 words)." },
            },
            required: ["key", "label"],
          },
        },
      },
      required: ["category", "chips"],
    },
  };
}

function buildExitGuessingTool(): FunctionDeclaration {
  return {
    name: "exit_guessing",
    description: `End the Word Finder narrowing session and return to normal conversation. See <guessing_mode> for when to call this.

Pair this call with a rebuild_board on the NEXT invocation that reflects the resolved topic — the user is going to talk ABOUT what was just found.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: `Short phrase: "user confirmed comet", "user said yes to black hole", "user changed topic".`,
        },
      },
      required: ["reason"],
    },
  };
}

const NO_CHANGE: FunctionDeclaration = {
  name: "no_change",
  description: `Current ${T.board} is still appropriate; no update needed. UNIVERSAL FALLBACK — call this whenever no other tool fits. Preferred over rebuilding identically or returning silent.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Brief reason the current surface is still appropriate.",
      },
    },
  },
};

export function buildBoardManagerToolDeclarations(config: BoardManagerToolConfig): Tool[] {
  const declarations: FunctionDeclaration[] = [];

  declarations.push(buildRebuildBoardTool(config));
  declarations.push(buildAddBoardButtonTool(config));
  declarations.push(buildAddContextButtonTool());

  if (config.availableBoards.length > 0) {
    declarations.push(buildSetBoardTool(config));
  }
  if (config.hasLoadedBoard) {
    declarations.push(buildPressButtonTool());
  }

  // open_app is NOT declared here — it moved to the live Speaker
  // (2026-08-19, Daniel): the agent that hears the consent is the agent that
  // opens the app. The BM parse case + coordinator dispatch for "open_app"
  // remain as gated tolerance for a stale model calling it anyway.
  declarations.push(buildShowBinaryChoiceTool(config));
  declarations.push(buildSuggestConstructionButtonsTool());
  declarations.push(buildSetMemoryChipsTool());
  declarations.push(buildInterpretTool());
  // Only surface exit_guessing while the Word Finder is active — outside
  // guessing mode, the tool would be a no-op and waste tool-surface area.
  if (config.guessingActive) {
    declarations.push(buildExitGuessingTool());
  }
  declarations.push(NO_CHANGE);

  // call_monitor removed (2026-08-19): the BM never had anything useful to
  // escalate — the Observer and Speaker both carry it, and every tool on this
  // surface costs schema budget on a saturated flash model.

  return [{ functionDeclarations: declarations }];
}
