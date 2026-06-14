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
import { getLanguageName } from "@shared/language-names";
import type { PermittedWebsite } from "@shared/schema";
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
  CALL_MONITOR,
} from "./shared";

// ===========================================================================
// SYSTEM PROMPT
// ===========================================================================

export interface BoardManagerPromptConfig extends BaseStudentContext {
  memoryContext?: string;
  muteState: "unmuted" | "muted";
  cachedSymbols?: Array<{ id: string; key: string | null; description?: string | null }>;
  availableBoards?: Array<{ id: string; key: string; name: string; hint?: string; grid: { rows: number; cols: number } }>;
  /** Normalized key of the currently loaded pre-built board, if any.
   *  Distinct from `loadedBoardName` so the prompt can present BOTH and
   *  the model never confuses the human label for the set_board argument. */
  loadedBoardKey?: string | null;
  loadedBoardName?: string | null;
  loadedPageName?: string | null;
  enabledApps?: Array<{ id: string; name: string; description: string }>;
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
  permittedWebsites?: PermittedWebsite[];
  autoSymbolsEnabled?: boolean;
  singleGlyphButtons?: boolean;
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

export function buildBoardManagerPrompt(config: BoardManagerPromptConfig): BoardManagerPromptParts {
  const {
    studentName, language, memoryContext, muteState: _muteState,
    knownContacts, classroom,
    cachedSymbols, availableBoards, loadedBoardKey, loadedBoardName, loadedPageName,
    enabledApps, availableCustomApps, permittedWebsites,
    autoSymbolsEnabled = false, singleGlyphButtons = false,
    glyphInputTranslation = false,
    gestureOverrides, safetyNotes, boardManagerGuidance,
    sentenceInterpretationExamples, boardManagerExamples,
  } = config;

  const languageName = getLanguageName(language);
  const descriptor = studentDescriptor(config);
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
  - \`call_monitor\` — escalate to the supervisor agent.

Choosing which tool:
  - Exactly TWO natural answers → \`show_binary_choice\`.
  - MANY answers (3+) → \`rebuild_board\` with that variety.
  - One specific new option fits, existing board still useful → \`add_board_button\`.
  - Conversation shifted (different topic/speaker/beat) → \`rebuild_board\`.
  - Ambient observation worth surfacing (object, person entering) → \`add_context_button\`.
  - Nothing else fits → \`no_change(reason)\`.
</role>${classroomBlock(studentName, classroom)}${boardManagerGuidance ? `\n\n<board_manager_guidance>\n${boardManagerGuidance}\n</board_manager_guidance>` : ""}

<when_to_act>
The TARGET label on the incoming tagged event decides whether to build a board and what kind.

**Build FOLLOW-UPS** when the USER just acted (${T.tagPress}, ${T.tagComposed}):
  - Options that continue or clarify what they said.
  - E.g. they pressed "I want to talk about my day" → "the morning", "something good", "something hard", "more details", "actually, something else".
  - Especially valuable when they're talking to a non-AI person — the buttons let them elaborate further.

**Build REPLIES** when someone ELSE just spoke to the USER (\`target = USER\`):
  - Options the user might say back.
  - Speaker may be AI ([AI to USER]), known person ([Mom to USER]), or UNKNOWN ([UNKNOWN to USER]). ALL THREE require replies.
  - E.g. "do you want lunch?" → "yes please", "no thanks", "I'm not hungry", "something else", "later".

**TARGET decides, SPEAKER is just attribution.**
  - \`[UNKNOWN to USER]\` is NOT ambient noise — Observer transcribed it because speech was clearly addressed to the user.
  - Treat it the same as \`[Mom to USER]\`: someone spoke to [${studentName}]; they need buttons to reply.
  - **Do NOT build** when target is a third party AND not the user:
    - \`[Mom to Dad]\` — Mom talking to Dad while [${studentName}] is in the room.
    - \`[AI to Mom]\` — the AI is responding to Mom; [${studentName}] isn't being addressed.
    - These are ambient observations unless [${studentName}] shows interest in interjecting.

**FOLLOW-UPS and REPLIES are different boards.** Don't mix them. If you just produced one and now you're invoked for the other, the new board should answer the new beat — overlap is fine, but the FRAMING is different.

**The \`target\` field on rebuild_board:**
  - DEVICE by default (user talking to the AI). Omit it in almost every case.
  - Set to a person's name when the user is replying to someone else in the room.
  - Carries through to each press.

**DO NOT rebuild on ambient observations.** A new person, a sound, a gesture, a passing object — scene context, not a new conversational turn.
  - Observation genuinely worth surfacing → \`add_context_button\` (ONE sidebar entry).
  - Otherwise → \`no_change(reason)\`. Defaulting to no_change on observations is correct.

**Other states:**
  - ${T.tagBuilderState} → \`suggest_construction_buttons\`.
  - ${T.tagComposed} → \`interpret(sentence)\`.
</when_to_act>

<presence>
[${studentName}] is your primary target. The [PEOPLE PRESENT] block lists identified faces; a "[THE STUDENT]" tag confirms a biometric match. When non-students are using the device, omit ${T.button}s that would reveal student-private information.${peopleLine ? `\n${peopleLine}` : ""}
</presence>

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
</glyph>

<meta_buttons>
Two META button kinds — set \`button_type\` on a rebuild_board / add_board_button entry. Speech/label are ignored; the device renders a FIXED appearance.

  - \`button_type: "wordfinder"\` — Word Finder entry. The user is reaching for a specific CONCEPT but it's impractical to guess.
    - DON'T use for open-ended chitchat ("how are you?" — nothing to "find").
    - DON'T use when you already have a manageable shortlist (offer those as normal buttons).
    - DON'T include while guessing mode is active — server drops it.
  - \`button_type: "more"\` — [MORE] button. The user might want OTHER options on the same topic.
    - Pressing asks you to refresh with fresh alternatives (no voiced utterance).
    - DON'T use as a substitute for rebuild_board when the topic should shift entirely.
</meta_buttons>

<board_rules>
  - Aim for 6–8 ${T.button}s per ${T.board}. Fill it.
  - No two ${T.button}s should look the same — distinguish at a glance.
  - Never include yes/no/home/more ${T.button}s (added automatically).
  - Decide the \`speech\` first, then build the \`glyph\` array that depicts it.
</board_rules>${glyphInputTranslation ? `

<input_glyphs>
The device shows the user a glyph translation of what was just said TO them, in the header. On EVERY \`rebuild_board\` that REPLIES to incoming speech (\`target = USER\` — an [AI to USER] line or a person speaking to the user), also set \`input_glyphs\`: an ARRAY of GLYPHs (same shape as button \`glyph\`) depicting THAT incoming sentence — not the reply buttons.
  - It represents what the user HEARD, so build it from the speaker's words (e.g. AI asked "Do you want to go outside?" → \`[{sym:"want"},{sym:"go"},{sym:"🌳"},{sym:"❓"}]\`).
  - No length cap, but SIMPLIFY to the core meaning when a faithful translation would be long — favour the few GLYPHs that carry the gist.
  - Use existing SYMBOLs/emoji only (the preference order in <glyph>). Do NOT use \`gen\` here — the header has no time to generate images.
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
    prompt += `\n\n<prebuilt_boards>
Pre-built ${T.board}s available via set_board(board_key). Always pass the KEY (the snake_case identifier), never the display name.
${availableBoards.map(b => `  - key: "${b.key}"  name: "${b.name}"${b.hint ? `  — ${b.hint}` : ""}`).join("\n")}`;
    if (loadedBoardKey || loadedBoardName) {
      const loadedKey = loadedBoardKey ?? "(unknown)";
      const loadedName = loadedBoardName ?? "(unnamed)";
      prompt += `\n\nCurrently loaded: key="${loadedKey}"  name="${loadedName}"${loadedPageName ? `  page="${loadedPageName}"` : ""}.
  - Navigate sub-pages via press_button(label).
  - Calling rebuild_board() unloads the custom ${T.board} entirely.`;
    }
    prompt += `\n</prebuilt_boards>`;
  }

  if ((enabledApps && enabledApps.length > 0) || (availableCustomApps && availableCustomApps.length > 0)) {
    prompt += `\n\n<apps_context>
Apps are launched by SPEAKER via open_app(). You provide buttons relevant to the active app (passed in the invocation context).
  - When an app is open, prefer add_context_button() over rebuilding the whole board.
</apps_context>`;
  }

  if (permittedWebsites && permittedWebsites.length > 0) {
    prompt += `\n\n<websites_context>
SPEAKER may open permitted websites via open_website(). When a site is active, populate the ${T.board} with site-relevant ${T.button}s.
  - E.g. for a recipe site: "scroll down", "read this", "go back", "look at the picture", "I want to make it".
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
${(sentenceInterpretationExamples ?? ex("sentence_interpretation.worked_examples", language)).replace(/\$SPEAK_VERB\$/g, "voice via interpret()")}
</sentence_interpretation>
</sentence_builder>

<guessing_mode>
On [GUESSING STATE] the user is finding a word they can't reach directly. Build the word-finder ${T.board} from a mix of the shapes below, leading with whichever fits.

  - **FOLLOW SPEAKER**: your options should answer the narrowing question Speaker just asked aloud (same axis).
  - On cold entry with no Speaker turn, default to the \`offered_keys\`.

**Button shapes:**

  1. **Registry key** — when the latest [GUESSING STATE] \`offered_keys\` fit, emit a ${T.button} with ONLY \`label\` set to the key (e.g. \`{ label: "suggestion:things.kind:animal" }\`) — NO \`glyph\`, \`speech\`, or \`op\`; the system fills the picture + voiced label. NEVER invent keys.
  2. **Your own narrowing** — when no offered dimension fits, propose one. Use the SAME \`dimension\` across the batch.
    - \`{ kind:"narrow", dimension:"genre", value:"Comedy", glyph:[{sym:"😂"}], speech:"funny" }\`
  3. **"Closer to A or B?"** — to bisect a niche concept space, ONE contrast button (2+ poles allowed).
    - \`{ kind:"contrast", dimension:"feel", poles:[{value:"cat-like", speech:"more like a cat", glyph:[{sym:"🐱"}]}, {value:"dog-like", speech:"more like a dog", glyph:[{sym:"🐶"}]}] }\`
    - The system renders one ${T.button} per pole and records the chosen pole (its \`speech\` is kept as the clue).
  4. **Final guess** — when narrowing has converged.
    - \`{ kind:"guess", value:"Spider-Man", glyph:[{sym:"🕷️"}] }\`

**Helper buttons** ("More"/"No") steer the registry questions — [GUESSING STATE] says which was pressed.
  - "More" → returns rarer answers to the SAME question; surface the fresh \`offered_keys\`.
  - "No" → that question doesn't fit now; move to the one the next state suggests (it may return later).
  - Neither means you guessed wrong. If the user rejects a candidate WORD, don't repeat it — pivot to fresh guesses or a new dimension.

**Call exit_guessing** once narrowing has CONVERGED and the user confirmed the word (pressed a guess, said "yes" to "is it X?", or named it). Your next board returns to normal conversation about it.
  - Don't exit just because it feels stuck — grind another dimension or commit a guess.
  - The tool only appears WHILE guessing is active.
</guessing_mode>${gestureOverrideBlock(gestureOverrides)}`;

  prompt += `\n\n<examples>\n${boardManagerExamples ?? ex("board_manager.examples", language, false)}\n</examples>`;

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
  let hasUserInput = false;
  let hasAiSpoke = false;
  let hasContextUpdate = false;
  let hasInterpret = false;
  for (const e of events) {
    if (e.type === "button_pressed" || e.type === "sentence_composed") hasUserInput = true;
    // speech_text_finalized is the canonical "AI spoke" trigger (full
    // transcript available, audio possibly still playing). speech_end
    // is also valid as a fallback for code paths that didn't surface
    // text_finalized.
    if (e.type === "speech_text_finalized" || e.type === "speech_end") hasAiSpoke = true;
    if (e.type === "context_update") hasContextUpdate = true;
    if (e.type === "interpret_intent") hasInterpret = true;
  }

  if (hasUserInput) {
    return `Action: rebuild_board. The USER just acted — build FOLLOW-UPS that continue or clarify their statement.
  - Think "what might they want to say NEXT?" (not "how would the AI reply").
  - Include options to elaborate, switch direction, or correct themselves.${NO_CHANGE_ESCAPE}`;
  }
  if (hasInterpret) {
    return `Action: rebuild_board. The USER played a composed SENTENCE — build FOLLOW-UPS that continue or clarify the thought they just voiced.${NO_CHANGE_ESCAPE}`;
  }
  if (hasAiSpoke) {
    return `Action: rebuild_board. The AI just spoke TO the user — build REPLIES the user might say back. If the AI asked a question, the buttons are the user's plausible answers.${NO_CHANGE_ESCAPE}`;
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
      return `[USER (composed) to AI] "${event.sentence}"`;
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
      const tgt = event.target ?? "AI";
      const label = tgt === "DEVICE" ? "AI" : tgt;
      return `[${event.speaker} to ${label}] "${event.text}"`;
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
    case "focus_request":
    case "alarm_raised":
    case "monitor_call_requested":
    case "private_note":
    case "remain_silent":
    case "thought_leak":
    case "gesture_recognized":
      return "";
    // App / website opens — context that buttons may need to reflect
    // (an open app may want app-specific response buttons).
    case "app_open_requested":
      return `[APP OPEN] ${event.appId}${event.data ? ` (${event.data})` : ""}`;
    case "app_close_requested":
      return `[APP CLOSE]`;
    case "website_open_requested":
      return `[WEBSITE OPEN] ${event.url}${event.label ? ` (${event.label})` : ""}`;
    case "board_load_requested":
      // BoardManager's own past set_board call. Render in the same
      // `[YOU] tool(args)` shape as the other own-action lines so it
      // can see what surface it just loaded.
      return `[YOU] set_board("${event.boardKey}")`;
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

/** Action hint for a home-press force-rebuild — prepended to the palette
 *  directive supplied via HOME_INTENTS. */
export function buildForceRebuildHint(forceRebuildDirective: string): string {
  return `Action: rebuild_board — MANDATORY. The user pressed a home-board navigation button to switch context.

${forceRebuildDirective}

Even if the current ${T.board}'s labels look related, REBUILD anyway — the user is requesting a fresh palette. Do NOT call no_change on this turn.`;
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
 *  when BM produced no tool calls on a user-input trigger that demanded a
 *  rebuild. State-aware: word-finder mode, builder mode, and default. */
export function buildEmptyResponseRetryFeedback(args: {
  inGuessingMode: boolean;
  inBuilderMode: boolean;
}): string {
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
}

function buttonObjectSchema(opts: ButtonSchemaOpts = {}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    speech: {
      type: "string",
      description: `First-person SENTENCE the TTS voices when this ${T.button} is pressed (e.g. "I want some water", "I'm tired").${opts.includeMetaButtonField ? ` Ignored when \`button_type\` is set.` : ""}`,
    },
    glyph: {
      type: "array",
      description: `Visual encoding — array of 1–3 GLYPH objects, rendered left→right. See <glyph> in the system prompt for the GLYPH shape and head-symbol preference order.${opts.includeMetaButtonField ? ` Ignored when \`button_type\` is set.` : ""}`,
      items: glyphItemSchema(),
    },
    op: {
      type: "string",
      enum: ["past", "future", "question"],
      description: `OPTIONAL sentence-level OPERATOR — conjugate \`speech\` to match; visual unchanged.`,
    },
    label: {
      type: "string",
      description: `Short text shown on the ${T.button} face, in the user's language. Not voiced.${opts.includeMetaButtonField ? ` Ignored when \`button_type\` is set.` : ""}`,
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
      description: `For "narrow"/"guess": the value/word the user picks (becomes the visible label).`,
    };
    properties.poles = {
      type: "array",
      description: `For "contrast": 2+ poles. Each is { value (shown), speech? (voiced + recorded clue), glyph? (visual array) }.`,
      items: {
        type: "object",
        properties: {
          value: { type: "string" },
          speech: { type: "string" },
          glyph: { type: "array", items: glyphItemSchema() },
        },
      },
    };
  }

  if (opts.includeMetaButtonField) {
    properties.button_type = {
      type: "string",
      enum: ["wordfinder", "more"],
      description: `OPTIONAL. See <meta_buttons> in the system prompt for usage. When set, the device renders a FIXED appearance; \`speech\` / \`label\` are ignored.`,
    };
  }

  return {
    type: "object",
    properties,
    required: ["speech", "label"],
  };
}

function rebuildBoardButtonsDescription(config: BoardManagerToolConfig): string {
  const language = config.language;
  const singleGlyph = !!config.singleGlyphButtons;
  const exampleA = ex("tool.sbf_speech_water", language);
  const exampleB = ex("tool.sbf_speech_three_glyph_banana", language);
  const exampleC = singleGlyph
    ? ""
    : ` Match glyph count to meaning — 1-glyph for one-word answers (${ex("tool.sbf_speech_one_glyph_tired", language)}), up to 3-glyph for full thoughts (${exampleB}). Don't pad.`;
  return `Up to 8 ${T.button}s for the ${T.board}. WIDE VARIETY. Each is \`{ speech, glyph, label }\` — \`speech\` is the voiced SENTENCE (e.g. ${exampleA}), \`glyph\` is the visual array, \`label\` is the on-button text.${exampleC}`;
}

function buildRebuildBoardTool(config: BoardManagerToolConfig): FunctionDeclaration {
  return {
    name: "rebuild_board",
    description: `Replace the ${T.board} with up to 8 fresh ${T.button}s. See <when_to_act> for when to call this.

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
                description: `Glyph translation of the speech you are REPLYING to (the [AI to USER] / person-to-user line that triggered this board), shown in the header so the user sees what was just said to them. Same GLYPH shape as a button \`glyph\` — see <input_glyphs>. Simplify to the gist; existing SYMBOLs/emoji only (no \`gen\`). Omit on follow-ups to the user's own action.`,
                items: glyphItemSchema(),
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
  const loadedNote = config.loadedBoardKey
    ? ` Currently loaded: key="${config.loadedBoardKey}"${config.loadedBoardName ? ` (name: "${config.loadedBoardName}")` : ""} — do NOT re-select it.`
    : "";
  return {
    name: "set_board",
    description: `Switch to a pre-built custom ${T.board}. Pass the KEY, never the display name. Available: ${boardList}.${loadedNote} Prefer this over rebuild_board() when a custom ${T.board} fits the current activity.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        board_key: {
          type: "string",
          description: `Board key to load (snake_case identifier, NOT the human name). One of: ${config.availableBoards.map(b => `"${b.key}"`).join(", ")}.`,
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

function buildShowBinaryChoiceTool(): FunctionDeclaration {
  return {
    name: "show_binary_choice",
    description: `Show two large overlay ${T.button}s. Use for ANY question with exactly two natural answers — binary choice or yes/no.

  - For yes/no, use the canonical \`yes\`/\`no\` SYMBOLs in each option's \`glyph\` field — they render with animated yes/no icons and default green/red coloring.
  - A "Neither" button is added automatically.
  - For open-ended questions, use rebuild_board() instead.

\`target\` semantics: same as rebuild_board.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        option1: buttonObjectSchema(),
        option2: buttonObjectSchema(),
        target: {
          type: "string",
          description: `Who the choice is addressed to. "DEVICE" (default), "USER", or a person's name.`,
        },
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

  declarations.push(buildShowBinaryChoiceTool());
  declarations.push(buildSuggestConstructionButtonsTool());
  declarations.push(buildSetMemoryChipsTool());
  declarations.push(buildInterpretTool());
  // Only surface exit_guessing while the Word Finder is active — outside
  // guessing mode, the tool would be a no-op and waste tool-surface area.
  if (config.guessingActive) {
    declarations.push(buildExitGuessingTool());
  }
  declarations.push(NO_CHANGE);

  // call_monitor only — private_note intentionally omitted.
  declarations.push(CALL_MONITOR);

  return [{ functionDeclarations: declarations }];
}
