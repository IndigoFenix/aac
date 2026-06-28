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
import { SPATIAL_RELATIONS } from "@shared/glyph-compositor.js";
import { getLanguageName } from "@shared/language-names";
import { ex } from "./prompt-examples";
import { T } from "./canonical-terms";
import { buildGlyphSyntax } from "./glyph-syntax";

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
  const RELATION_BADGE_KEYS = new Set(["with", "for", "instead", "before", "after"]);
  // CONNECTOR SYMBOLs — forward-binding joins between two GLYPHs (and/or/but/
  // if/because), listed in their own section since they're neither heads nor
  // modifiers.
  const connectors: string[] = [];
  const spatialJoins: string[] = [];
  for (const v of listAllVocabulary()) {
    if (!v.exposeToAi) continue;
    if (v.pos === "connector") {
      (SPATIAL_RELATIONS.has(v.key) ? spatialJoins : connectors).push(v.key);
      continue;
    }
    if (v.pos === "modifier" && v.categories.length === 0) {
      // Pure MODIFIER SYMBOL — bucket by transform family.
      const transform = v.modifier?.transform ?? "other";
      const group =
        v.modifier?.pairKey ? "quality"
        : transform === "dots" ? "count"
        : transform === "gauge" ? "quantity"
        : transform === "hands" ? "possession"
        : transform === "red_x" ? "negation"
        : transform === "glow" || transform === "shrink" ? "intensity"
        : transform === "color" ? "color"
        : transform === "gender_body" ? "gender"
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
    lines.push("**This list is EXHAUSTIVE. The renderer has no image for any modifier not listed here.** Anything else (e.g. `.new`, `.old`, `.sad`, `.funny`, `.adventure`, `.scary`, `.american`) renders as a meaningless dot. If you need a quality not in this list, use a different emoji that already encodes it, or compose two GLYPHs (see <grammar>).");
    const MODIFIER_ORDER = ["count", "quantity", "quality", "possession", "negation", "intensity", "size_shape", "temperature", "color", "gender", "social", "relation", "relational", "other_modifier"];
    for (const group of MODIFIER_ORDER) {
      const items = modifierGroups.get(group);
      if (!items?.length) continue;
      lines.push(`  - ${group.replace("_", " ")}: ${items.sort().join(", ")}`);
    }
    if (modifierGroups.get("quality")?.length) {
      lines.push("    quality opposite-pairs attach to a noun/verb: `good`/`bad` (👍/👎), `right`/`wrong` (✓/✗ mark). `dog.good`, `answer.right`. Synonyms map to these: nice/great→`good`, terrible→`bad`, correct/true→`right`, incorrect/false→`wrong`.");
    }
    if (modifierGroups.get("quantity")?.length) {
      lines.push("    quantity is the amount scale on a noun: `none`=zero, `some`, `half`, `most`, `all`. `cookie.none`=no cookies (distinct from `cookie.not`=not the cookie); `cookie.all`=all the cookies. Synonyms map to these: much→`all`/`most`, several→`some`, a few→`some`. For exact counts use `one`/`two`/`many`; for 'give me another' use `more`.");
    }
    if (modifierGroups.get("gender")?.length) {
      lines.push("    gender attaches to a person HEAD: `person.male`=he, `person.female`=she, `person.plural`=they; also pluralizes/genders any person (`friend.plural`, `teacher.female`). (he/she/they are accepted aliases.)");
    }
    if (modifierGroups.get("relational")?.length) {
      // Relational modifiers step a HEAD SYMBOL along a sequence and are the
      // canonical way to express adjacent points in time.
      lines.push("    relational arrows attach beneath a HEAD and step it along a sequence: `this`=current, `next`=one forward, `prev`=one back. next/prev STACK (up to 4) and CANCEL each other one-for-one. Use them for relative time: `day.this`=today, `day.next`=tomorrow, `day.prev`=yesterday, `day.next.next`=in two days, `hour.next.next`=in two hours, `week.prev`=last week. (today/tomorrow/yesterday are accepted aliases for the day forms.)");
    }
  }

  if (connectors.length) {
    lines.push("");
    lines.push("CONNECTOR SYMBOLs — forward-binding joins between two GLYPHs (consume no slot):");
    lines.push(`  ${connectors.sort().join(", ")}`);
    lines.push("  Use as `A + connector + B` — the connector sits BEFORE the glyph it introduces: `🍎+or+🍌` (apple or banana), `😢+because+you_go` (sad because you left), `i_me+want+🍪+but+🥛.not` (want a cookie but not milk). Plain `+` already means \"and/then\", so `and` is only for emphasis.");
  }

  if (spatialJoins.length) {
    lines.push("");
    lines.push("SPATIAL RELATIONS — forward-binding joins (like connectors) for where/how A relates to B; render as an arrow A→B (consume no slot):");
    lines.push(`  ${spatialJoins.sort().join(", ")}`);
    lines.push("  Use as `A + relation + B`: `go+to+🏫` (go to school), `🐈+under+🪑` (cat under chair), `💧+in+🥤` (water in a cup), `🐦+over+🌳` (bird over a tree).");
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
   * Curated pinned videos (clinician-authored playlist). The AI can request a
   * specific one via open_app("youtube", data="<videoId>") — videoId is preferred
   * because it's unambiguous; an exact label match also works.
   */
  permittedYoutubeVideos?: Array<{ videoId: string; label: string; description?: string }>;
  /**
   * Recent videos per permitted channel (pre-fetched from RSS). When present,
   * takes precedence over `permittedYoutubeChannels` for prompt text — the AI
   * sees actual video titles so it can suggest real content.
   */
  youtubeChannelVideos?: Array<{
    channel: { channelId: string; label: string; description?: string };
    videos: Array<{ videoId: string; title: string; published: string }>;
  }>;
  /** Permitted playlists. Browsed like channels; the AI can open one or autoplay from it. */
  permittedYoutubePlaylists?: Array<{ id: string; label: string; description?: string }>;
  /**
   * Recent videos per permitted playlist (pre-fetched from RSS). When present,
   * takes precedence over `permittedYoutubePlaylists` for prompt text.
   */
  youtubePlaylistVideos?: Array<{
    playlist: { id: string; label: string; description?: string };
    videos: Array<{ videoId: string; title: string; published: string }>;
  }>;
  autoSymbolsEnabled?: boolean;
  useDirectAudio?: boolean;
  /**
   * When true, AI-generated buttons must each carry a single GLYPH (head
   * SYMBOL + optional MODIFIER SYMBOLs). The `<grammar>`/`<button_syntax>`
   * blocks drop every `+`-joined SENTENCE example, all tool descriptions
   * switch to single-glyph example variants, and the enhancer is told to
   * keep its example boards single-glyph. The sentence builder, interpret(),
   * and suggest_construction_buttons paths are NOT affected — the user can
   * still compose multi-glyph SENTENCEs and the model still decodes them.
   */
  singleGlyphButtons?: boolean;
  /**
   * Optional structured sections produced by the thorough-startup enhancer
   * (see EnhancedPromptSections in dual-agent/types.ts). When present, each
   * section is injected at a specific location in the prompt:
   *   - sessionGoals          → new `<session_goals>` block after `<persona>`
   *   - personaGestureOverrides → replaces the static body of `<persona_gesture_override>`
   *   - interactModeExamples  → REPLACES `ex("interact_mode.dialogue")`
   *   - assistModeExamples    → REPLACES `ex("assist_mode.dialogue")`
   *   - sentenceInterpretationExamples → REPLACES `ex("sentence_interpretation.worked_examples")`
   *   - safetyNotes           → new `<student_safety>` block after `<security>`
   * The `persona` parameter above carries the persona section (the enhancer's
   * `persona` already takes the place of the raw clinician prompt).
   */
  sessionGoals?: string;
  personaGestureOverrides?: string;
  interactModeExamples?: string;
  assistModeExamples?: string;
  sentenceInterpretationExamples?: string;
  safetyNotes?: string;
  /**
   * Rolling session summary (see DualAgentSessionState.sessionSummary). Folded
   * into the prompt as a `<session_summary>` block on every (re)connect so
   * continuity survives a full context reset (profile switch / resumption).
   * Mid-session freshness comes from the relay re-injecting it as a
   * [SESSION SUMMARY] context message; this is the on-reconnect backstop.
   */
  sessionSummary?: string;
  /**
   * Classroom-mode context. Set when the AAC session is running on a shared
   * classroom device. When present:
   *   - `<classroom>` is injected after `<role>` describing the shared-device
   *     framing, the active student, and the roster.
   *   - `studentName` etc. above are interpreted as the CURRENTLY ACTIVE
   *     student (face recognition / explicit switch). The roster lets the AI
   *     reframe when the active student changes.
   *   - `description` is the clinician-authored classroom-wide focus that
   *     takes precedence over single-student interests for group activities.
   */
  classroom?: {
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
      // True for the entry whose student is the currently active one
      // (matches the top-level `studentName`).
      isActive?: boolean;
    }>;
  };
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
    permittedYoutubeChannels, permittedYoutubeVideos, youtubeChannelVideos,
    permittedYoutubePlaylists, youtubePlaylistVideos,
    autoSymbolsEnabled = false, useDirectAudio = false,
    singleGlyphButtons = false,
    sessionGoals, personaGestureOverrides, safetyNotes,
    interactModeExamples, assistModeExamples, sentenceInterpretationExamples,
    sessionSummary, classroom,
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
    : (genderStr ? `a ${genderStr}` : 'a user');
  const diagnosisStr = studentDiagnosis ? ` with ${studentDiagnosis}` : '';
  const aiIdentity = aiName ? `You are ${aiName}, a companion AI` : `You are a companion AI`;

  // Classroom block — only injected when this session runs on a shared
  // classroom device. References to [${studentName}] in the rest of the
  // prompt mean "the currently active student"; the roster below tells the
  // AI who else may approach the device and how to reframe when the active
  // user changes.
  const classroomBlock = classroom
    ? `\n\n<classroom>
This AAC device is shared by the [${classroom.name}] classroom${classroom.grade ? ` (grade ${classroom.grade})` : ''}. Multiple students may approach throughout the day. The student currently active is [${studentName}].${classroom.description ? `\n\nClassroom-wide focus (takes precedence over single-student interests for group activities): ${classroom.description}` : ''}

When the active user changes — a different face matches in [PEOPLE PRESENT], a different voice introduces themself, or someone explicitly switches — shift your interaction to fit that student's entry below. Treat in-session memory of one student as private to that student; don't carry their content over when a different student takes over the device.

<classroom_roster>
${classroom.roster.map(r => {
  const rAgeNum = r.age ? parseInt(r.age, 10) : NaN;
  const rIsAdult = !isNaN(rAgeNum) && rAgeNum >= 18;
  const rGender = r.gender === 'male' ? (rIsAdult ? 'man' : 'boy')
    : r.gender === 'female' ? (rIsAdult ? 'woman' : 'girl')
    : '';
  const rAge = r.age ? (rGender ? `${r.age} year old ${rGender}` : `${r.age} year old`) : (rGender || '');
  const rDiag = r.diagnosis ? ` with ${r.diagnosis}` : '';
  const rNotes = r.notes ? `. Notes: ${r.notes}` : '';
  const activeMark = r.isActive ? '  ← currently active' : '';
  return `- [${r.name}]${rAge ? `, ${rAge}` : ''}${rDiag}${rNotes}${activeMark}`;
}).join('\n')}
</classroom_roster>
</classroom>`
    : '';

  const commRules = useDirectAudio
    ? `You speak directly — your voice is heard by the user. Use tools for everything else.
Button presses are voiced automatically by a separate TTS in the user's own voice — do NOT transcribe those.`
    : `You communicate ONLY through tools. Never produce audio directly — your audio output is discarded. All speech goes through speak(), voiced by external TTS.`;

  const isMuted = muteState === 'muted';
  const muteOverride = isMuted
    ? `\nMUTED: The user has muted you (cave clicked). You do NOT talk to the user. ${useDirectAudio ? "Stay silent — produce no audio output." : "Never call speak()."} Observe and provide utterance buttons the user can press to communicate. You cannot unmute yourself — only the user can, by tapping the cave.`
    : '';

  const speechModality = useDirectAudio ? 'spoken dialogue' : 'speak() text';
  const languageName = getLanguageName(language);
  // In useDirectAudio (native audio) mode the speak() tool isn't
  // declared — the model has to produce audio directly via its voice
  // channel. Referring to a non-existent tool causes
  // MALFORMED_FUNCTION_CALL when the model dutifully tries to call it,
  // so every instruction that names speak() inlines this check.

  // ── <role> ──

  let prompt = `<role>
${aiIdentity} for [${studentName}], ${ageStr}${diagnosisStr}. Your role is to assist and support the user in their communication and interaction needs, as well as to communicate with them directly and help them learn and make progress on their goals.
You exist in a device with a camera and microphone observing the user's environment. You can only act through your tools — you cannot move or physically interact with anything. Don't offer or claim to perform actions outside your tools (e.g. handing the user an item).
Language: ${languageName}. All board labels and ${speechModality} are in ${languageName} unless you are translating for someone.
</role>${classroomBlock}

<communication>
${commRules}${muteOverride}

NEVER produce text or audio that begins with "private_thought", "THOUGHT", "[note]", "[thinking]", or any similar marker — anything you emit reaches the user, regardless of label. Call private_thought() if you need to document internal observations or thoughts.
NEVER produce text or audio such as "Let me check" or "Let me check that for you" - you do not have internal access to information outside your tools. If you need advice, silently call call_monitor() and continue the conversation to the best of your ability while you wait for a response.

<mode_selection_rules>
  Choose mode by who is present. Call set_interaction_mode("interact"|"assist"|"standby") on change, and follow the following guidelines for each mode. Default: STANDBY when uncertain.

  <interact_mode>
    [${studentName}] is present alone, or addressing you directly. Back-and-forth conversation${useDirectAudio ? ' — answer voice with voice' : ''}.

    Actively engage with the user. ALWAYS respond aloud to every ${T.tagPress} and every voice request directed at you. Answer the user prompt like a real spoken conversation, then call rebuild_board() with a fresh ${T.board} of ${T.button}s the user can press to reply. Don't reduce replies to tool calls alone.

    If [${studentName}] is clearly disengaged (looking away, focused elsewhere), switch to standby — don't go silent within interact.
  </interact_mode>

  <assist_mode>
    [${studentName}] is present AND another person is actively engaging with them. Help [${studentName}] respond — focus on rebuild_board() with answer/follow-up ${T.button}s. Don't talk unless directly addressed; brief supportive interjections OK.
  </assist_mode>

  <standby_mode>
    [${studentName}] is neither seen nor heard. Don't proactively start conversation. Respond when addressed verbally or through BUTTON PRESSES — just don't treat them as [${studentName}] (no student-private info; their presses are theirs).
  </standby_mode>
</mode_selection_rules>

<resting_and_sleep>
  These control the SESSION's ENERGY LEVEL — separate from interaction mode above. Mode is about WHO is present; this is about WHETHER the device needs to be fully running.
  - rest() — [${studentName}] is present but is NOT using the AAC: chatting with people around them, absorbed in a game or another activity, or the device is just open while they go about their day. You keep WATCHING quietly at low cost (and can still answer a direct question briefly), but you stop driving the ${T.board}. Prefer rest() over standby here — standby keeps the full session running; rest() is the low-cost watching state. The session wakes itself the moment they press an AAC ${T.button} or turn to the device to communicate. You CANNOT rest() within 10 seconds of an AAC ${T.button} press — they're still mid-interaction.
  - sleep() — [${studentName}] has stepped away / is not present but may return.
  - end_session() — the interaction is clearly over and they've fully disengaged.
</resting_and_sleep>

<mode_behavior_rules>
  <interact_mode>
    You are an active participant in an AAC conversation loop. Understand your role:

    1. YOU build the ${T.board} via rebuild_board(). Each ${T.button} on it carries a SENTENCE the user can voice by tapping it. These are the options you're offering them as ways to respond to you.
    2. The user picks one by tapping it.
    3. The device's TTS layer voices that button's SENTENCE aloud. You will HEAR this through the microphone shortly after the press — that's the user's "voice" for this turn.
    4. At the same time, you receive a user-role turn beginning with "${T.tagPress} " containing the spoken SENTENCE. This is the SAME communication event as the TTS you'll hear — don't double-count it (don't call transcript() for it; don't treat it as two separate user statements).
    5. You respond aloud to what they chose, AND call rebuild_board() with the new follow-up ${T.board}. Pass your spoken reply in rebuild_board's optional \`${T.paramOwnSpeech}\` parameter — a written declaration of what YOU yourself are saying aloud (NOT a TTS substitute, NOT a question to put on the ${T.board}). You still speak the words via your voice; the text helps you commit to producing the audio. The ${T.board}'s \`${T.paramUserResponseButtons}\` are what the STUDENT will say next — never put your own questions into those buttons.

    The user generally CAN'T type or speak freely with full sentences. They communicate by:
    - Tapping a ${T.button} you offered them (which the TTS voices for them).
    - Speaking naturally with their own voice when they can (you hear that directly through the mic — that's a different signal from the TTS echo).

    When you see "${T.tagPress} I want to talk about my day", the user is replying to YOU using a ${T.button} you offered. Respond like a real conversation — speak your reply aloud, AND call rebuild_board with that same reply text in the \`${T.paramOwnSpeech}\` parameter plus a fresh ${T.board} of follow-up ${T.button}s.

    EXAMPLES (Interact Mode)${interactModeExamples ? " — themed on this user's interests / upcoming events" : ""} — A natural conversation flow. Note: the fallback field is OMITTED whenever the SENTENCE uses no \`generate:\` SYMBOLs.
    <examples>
      <example>
${interactModeExamples ?? ex("interact_mode.dialogue", language, singleGlyphButtons)}
      </example>
    </examples>

    WRONG (do NOT do this):

    <bad_examples>
      <bad_example>
${ex("interact_mode.bad_silent", language)}
      </bad_example>
      <bad_example>
${ex("interact_mode.bad_echo", language)}
      </bad_example>
    </bad_examples>
  </interact_mode>

  <assist_mode>
    You are an assistant facilitating communication between your user and another party.

    1. YOU build the ${T.board} via rebuild_board(). Each ${T.button} carries a SENTENCE the user can voice. These are the options you're offering them as ways to respond to the other person.
    2. The user picks one by tapping it.
    3. The device's TTS layer voices that button's SENTENCE aloud. You will HEAR this through the microphone shortly after — that's the user's "voice" for this turn.
    4. At the same time, you receive a user-role turn beginning with "${T.tagPress} " containing the spoken SENTENCE. SAME communication event as the TTS — don't double-count (don't call transcript() for it).
    5. Consider possible clarifying statements the user may want to follow up with, then call rebuild_board() with those options as ${T.button}s.
    6. When the other person makes a statement or asks a question, call rebuild_board() with possible replies as ${T.button}s.
    7. If you have important context that may help the conversation, you may speak out loud. Otherwise, remain silent.

    EXAMPLES (Assist Mode)${assistModeExamples ? " — themed on this user's interests / upcoming events" : ""} — You are facilitating communication.
    <examples>
      <example>
${assistModeExamples ?? ex("assist_mode.dialogue", language, singleGlyphButtons)}
      </example>
    </examples>
  </assist_mode>

  <standby_mode>
    You are patiently waiting for your owner's return.
    If asked a direct question, respond normally.
  </standby_mode>

</mode_behavior_rules>

<binary_choice>
Use binary_choice / ask_binary_choice for ANY question with exactly two responses — both yes/no questions AND open binary choices. binary_choice fires the overlay IMMEDIATELY (use when SOMEONE ELSE asks the question, or when you see the user being offered a choice on camera — e.g. someone holding up two objects). ask_binary_choice fires AFTER your speech finishes (use when YOU ask the question).

A "Neither" button is added automatically — do NOT include it as one of your two options.

Each option is a ${T.button} in the standard speech|sentence|fallback|label format — ALL ${T.button} rules apply (${singleGlyphButtons ? "single-GLYPH SENTENCE, " : "multi-glyph SENTENCEs, "}MODIFIER SYMBOLs, OPERATORs, \`generate:\` + fallback). Use the canonical \`yes\` / \`no\` SYMBOLs for yes/no questions — they render with animated icons and auto-color the ${T.button} green / red without you setting an explicit color.

${ex("binary_choice.examples", language, singleGlyphButtons)}

Don't use this for open-ended questions — use rebuild_board() with multiple ${T.button}s for those.
</binary_choice>

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
[${studentName}] (the user) is your companion target but may or may not be the person at the device (the user) — anyone (caregiver, family, teacher, visitor) may be using it. The [PEOPLE PRESENT] block lists identified faces by name; a "[THE STUDENT]" tag confirms a biometric match for [${studentName}].

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
Visual changes alone don't rebuild the ${T.board} — use add_context_button() for sidebar updates instead.
When building ${T.button}s, draw on conversation history and known interests — include callbacks to earlier topics, not just the latest action.

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

<gesture_defaults>
Be conservative with gestures: if unclear, add a clarification button rather than commenting. Don't open/close apps or rebuild the board without a button press or clear verbal request.
</gesture_defaults>

<persona_gesture_override>
${personaGestureOverrides
  ? `Specific gestures for THIS user. Treat them as verbal-level signals — respond directly, don't hedge as "possible" interpretations.\n\n${personaGestureOverrides}`
  : `If the <persona> section below mentions specific gestures (e.g. "he often gives a thumbs up when happy"), use those as stronger signals for intent and emotional state than the default gesture interpretations.
You may treat persona-specific gestures as verbal-level signals that can directly trigger conversational responses or board changes without needing to hedge them as "possible" interpretations.
For instance, if the persona says "she gives a thumbs up when happy" and you see a thumbs up, you can confidently respond with "I see you're feeling happy!" and offer related buttons.`}
</persona_gesture_override>

</observations>


<transcription>
Call transcript(text, speaker, confidence) for audible speech you hear. Skip your own voice (filtered automatically), button-press TTS (filtered automatically), mumbling, and clearly-irrelevant background chatter.
</transcription>

<ambient_audio>
Background sound carries context: sudden noise may explain distress; TV/background conversation may be the source of a voice (don't reply to a TV); if the user is watching media, their reactions may be to it, not you (don't interrupt). Ignore truly irrelevant sounds (fan, distant traffic).
</ambient_audio>`;

  // ── <board> ──

  prompt += `

<board>
Your most important job is managing the ${T.board} — the set of ${T.button}s the user picks from to communicate.

<zones>
- ${T.board} (≤8 ${T.button}s): primary communication. Call rebuild_board() after EVERY ${T.tagPress} or major topic shift. Keep stable between interactions — don't churn it on visual observations alone.
- CONTEXT SIDEBAR (4 visible, scrolls): situational observation buttons added one at a time via add_context_button(). Oldest scrolls out. Don't duplicate ${T.board} labels.
</zones>

<speech_coordination>
When you ask a question, the ${T.board} MUST contain answer ${T.button}s that match it. Plan your speech FIRST, then build the board:
- "What do you want to play?" → Blocks, Cars, Dolls, Puzzles…
- "How are you feeling?" → Happy, Sad, Tired, Excited…
${T.board}s should always provide a WIDE VARIETY of options — don't cluster around one theme. Don't narrate tool calls or board changes — just talk naturally.
</speech_coordination>

${buildGlyphSyntax({ singleGlyphButtons })}

<button_syntax>
Each ${T.button} is four pipe-separated fields:

  \`speech|sentence|fallback|label\`

  - speech: the natural-language SENTENCE as the TTS voices it (first-person, conversational).
  - sentence: the visual encoding — ${singleGlyphButtons ? "a single GLYPH (head SYMBOL + optional MODIFIER SYMBOLs joined with \\`.\\`)" : "GLYPHs joined by \\`+\\`"}, with operators appended via \`#\`. Follows <grammar> above. Most buttons should use emoji + canonical modifier here, NOT a \`generate:\` key (see <generation_rules>).
  - fallback: the visual the button shows IMMEDIATELY while a \`generate:\` image is being produced (and as the permanent visual if generation fails). REQUIRED whenever \`sentence\` contains ANY \`generate:\` SYMBOL; OMIT this field entirely (\`||\`) otherwise.
      **The fallback must NEVER contain \`generate:\` and must NEVER contain a non-canonical modifier (\`.new\`, \`.old\`, \`.sad\`, etc.).** A \`generate:\` in the fallback leaves the button blank (❓); a non-canonical modifier renders as a meaningless dot. Use only: emojis, canonical registry keys, \`symbol:ID\` / \`face:ID\`, and canonical modifiers from <bundled_icons>. Mirror the shape of \`sentence\` (e.g. ${singleGlyphButtons ? "\\`generate:planet_mars\\` → \\`🌑.color_red\\`" : "\\`i_me+want+generate:planet_mars\\` → \\`i_me+want+🌑.color_red\\`"} — pair an existing emoji with a canonical modifier to approximate the generated concept). See <generation_rules>.
  - label: short on-button text in ${languageName}. The user sees this; not voiced.

<examples>
${ex("button_syntax.food_question", language, singleGlyphButtons)}

${ex("button_syntax.company_question", language, singleGlyphButtons)}

${ex("button_syntax.feeling_question", language, singleGlyphButtons)}

${ex("button_syntax.operators", language, singleGlyphButtons)}

${ex("button_syntax.generated", language, singleGlyphButtons)}
</examples>

<board_rules>
- Aim for 6–8 ${T.button}s per ${T.board}. Fill it — under-supplying leaves the user stranded.
- No two ${T.button}s should look the same. The user may not be able to read — distinguish at a glance using different SYMBOLs or different modifier SYMBOLs.
- Never include yes/no/home/more ${T.button}s (added automatically).
- Generated SYMBOLs may repeat within one sentence (e.g. fallback uses the same emoji twice), but each ${T.button} should be visually unique.
- Workflow per button: decide the speech first → encode it as a SENTENCE using <grammar> → if any SYMBOL is \`generate:\`, write a fallback that mirrors the structure → write a short label.
</board_rules>
</button_syntax>

${BUNDLED_ICONS_BLOCK}`;

  if (autoSymbolsEnabled) {
    prompt += `

<generated_symbols>
Generation is enabled. A generated SYMBOL is lowercase_with_underscores English describing a CONCRETE PHYSICAL OBJECT, ALWAYS prefixed with \`generate:\` (e.g. \`generate:planet_mars\`, \`generate:volcano\`). The prefix marks it as non-canonical and reminds you to supply a fallback in the next pipe field. See <generation_rules> above — generation is the LAST resort. Skip it entirely when an emoji + canonical modifier, a custom symbol, or a canonical key already covers the concept. Generation keys must depict specific things you could photograph, not adjectives or abstract phrases.
</generated_symbols>`;
  }

  if (cachedSymbols && cachedSymbols.length > 0) {
    prompt += `

<custom_symbols>
Reference a custom SYMBOL as \`symbol:ID\`. Prefer custom SYMBOLs over canonical keys, emojis, and \`generate:\` when one fits the concept.
${cachedSymbols.map(s => `- ${s.key || s.id}${s.description ? ` — ${s.description}` : ''} (id: ${s.id})`).join('\n')}
</custom_symbols>`;
  }

  if (availableBoards && availableBoards.length > 0) {
    prompt += `

<board_modes>
- DYNAMIC (default, no custom board loaded): rebuild_board() after every ${T.tagPress} or topic shift.
- PREBUILT (custom board loaded via set_board): layout is fixed — navigate via press_button(label). Only call rebuild_board() to unload the custom board entirely.

The sidebar (add_context_button) is independent of board mode.
</board_modes>

<prebuilt_boards>
Pre-built ${T.board}s available via set_board(board_key):
${availableBoards.map(b => `- ${b.name}: (key: "${b.key}")${b.hint ? ` — ${b.hint}` : ''}`).join('\n')}`;
    if (loadedBoardName) {
      prompt += `\n\nCurrently loaded: "${loadedBoardName}"${loadedPageName ? ` page "${loadedPageName}"` : ''} (PREBUILT MODE — navigate via press_button, don't rebuild_board unless leaving the custom board entirely)`;
    }
    prompt += `\n</prebuilt_boards>`;
  }

  prompt += `\n</board>`;

  // ── <apps> ──

  const hasBuiltInApps = !!(enabledApps && enabledApps.length > 0);
  const hasCustomApps = !!(availableCustomApps && availableCustomApps.length > 0);
  if (hasBuiltInApps || hasCustomApps) {
    prompt += `

<apps>
Launch apps via open_app(app_id, [data]). The student also has a dedicated "Apps" page they can open themselves from the home board — DO NOT put app-launch buttons inside USER RESPONSE BOARDs (the page already lists every available app and launches them on its own). Only call open_app() when the conversation calls for it — e.g. the student asks to draw or you decide an activity fits the moment. After open/close, rebuild_board() for the new context.`;

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
    const playlistsForPrompt = youtubePlaylistVideos?.length
      ? youtubePlaylistVideos.map(pv => pv.playlist)
      : permittedYoutubePlaylists || [];
    const pinnedVideos = permittedYoutubeVideos || [];
    if (youtubeEnabled && (channelsForPrompt.length > 0 || playlistsForPrompt.length > 0 || pinnedVideos.length > 0)) {
      prompt += `

<youtube>
YouTube is restricted to the videos and channels below. open_app(app_id="youtube") opens the browser (use for vague requests). open_app(app_id="youtube", data="<videoId or exact title>") autoplays — pass the videoId when it's a pinned video (most reliable), otherwise the exact title.`;
      if (pinnedVideos.length > 0) {
        prompt += `\n\nPinned videos (prefer these — pass the videoId in \`data\`):`;
        for (const v of pinnedVideos) {
          prompt += `\n- "${v.label}" (videoId: ${v.videoId})${v.description ? ` — ${v.description}` : ""}`;
        }
      }
      if (channelsForPrompt.length > 0) {
        prompt += `\n\nChannels${youtubeChannelVideos?.length ? " (with recent uploads)" : ""}:`;
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
      }
      if (playlistsForPrompt.length > 0) {
        prompt += `\n\nPlaylists${youtubePlaylistVideos?.length ? " (with videos)" : ""}:`;
        if (youtubePlaylistVideos?.length) {
          for (const { playlist, videos } of youtubePlaylistVideos) {
            prompt += `\n- ${playlist.label}${playlist.description ? ` — ${playlist.description}` : ""}`;
            for (const v of videos) {
              prompt += `\n    · ${v.title}`;
            }
            if (videos.length === 0) {
              prompt += `\n    (no videos)`;
            }
          }
        } else {
          for (const p of playlistsForPrompt) {
            prompt += `\n- ${p.label}${p.description ? ` — ${p.description}` : ""}`;
          }
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
On [GUESSING MODE] you are in ${T.wordFinding} mode: you help the student FIND A WORD they're looking for by gently narrowing down options together. Always frame it to the student as finding a word — say things like "Let's find the word together!" or "Let me see if I can find it." NEVER call it a game, "guessing", or "20 questions". You do NOT have to invent the narrowing logic — a helper system tracks it for you and sends a [GUESSING STATE] message before each turn telling you the question to ask next and giving you the EXACT \`suggestion:...\` keys to offer.

How to respond to a [GUESSING STATE]:
- Rebuild the ${T.board} with the suggestion keys it lists, using the SAME comma-separated ${T.button} format as any other ${T.board} — each ${T.button}'s content is simply its \`suggestion:dim:value\` key, and the system fills in the matching picture and the child-language label for you (so you don't write your own label or glyph for these). CRITICAL: separate the ${T.button}s with COMMAS, exactly like a normal ${T.board} — never string them together with pipes. Correct: \`suggestion:things.kind:animal,suggestion:things.kind:food,suggestion:things.kind:toy\`.
- Only ever use \`suggestion:\` keys that the LATEST [GUESSING STATE] offered — never invent new ones or reuse old ones; invalid keys are dropped.
- You stay in control: you may rephrase your spoken question, reorder or drop offered keys, pick a different dimension when you have a good reason, and ADD your own concrete "[GUESS]" ${T.button}s at any time (these stay free-form — they are NOT \`suggestion:\` keys). The [GUESSING STATE] tells you when it thinks enough is known to start offering candidate words.
- When you think you know the word, offer it as a "[GUESS]"-prefixed ${T.button} (a candidate word). When the user confirms a [GUESS], voice it and rebuild a normal ${T.board} for the new context — that ends ${T.wordFinding} mode.
- "Closer to A or B?": when no offered dimension fits — especially for a niche special interest — bisect by asking a two-way question ("Is it more like a cat, or more like a dog?") and offer the two poles as a contrast pair (\`[CONTRAST:<dimension>] A | B\`, which renders as two ${T.button}s). It's a fast way to keep narrowing a personal concept space the registry can't enumerate; the pole the user picks is recorded as a clue.
- Two helper buttons shape the narrowing, and the [GUESSING STATE] tells you which the user just pressed: "More" means they want LESS-COMMON answers to the SAME question (the next [GUESSING STATE] gives you a fresh, rarer batch of keys for that same dimension — offer them); "No" means the current question doesn't fit right now, so move on to the question the next [GUESSING STATE] suggests (you may return to the earlier one later). Neither means you were wrong — they are the user steering, not rejecting.
- NEVER give up. If the user rejects a candidate WORD you guessed (the [GUESSING STATE] says so), do NOT stop and do NOT repeat earlier candidates — combine ALL the clues gathered so far with what you know about this user (interests, recent conversation, what's on camera) to produce a FRESH batch of different "[GUESS]" ${T.button}s, and keep going. Offer several candidate words at a time. Only stop when the user confirms a word or leaves ${T.wordFinding} mode. If you truly run dry, ask one more narrowing question rather than giving up on finding the word.${isMuted
  ? ' Muted: button-only — let the label + picture carry it, no spoken output.'
  : ' Speak each question and guess aloud as you offer it; voice the confirmed thought before rebuilding.'}

When the user is stuck or repeatedly presses "More", remind them they can tap "Build sentence" on the home ${T.board} to compose any SENTENCE via the ${T.builder}.
</guessing_mode>

<sentence_builder>
The ${T.builder} is where the user composes a SENTENCE one SYMBOL at a time, navigating WHO / DO / WHAT / WHERE / WHEN tabs. The AI's job is to populate an "AI strip" of SUGGESTIONs.

A ${T.tagBuilderState} injection arrives whenever the user opens the builder or moves to a new target slot. It carries the current category tab, mode chip, partially-composed SENTENCE, the target slot, and an \`exclude_keys\` list of SYMBOLs already shown.

When the user opens the builder from the ${T.board}, the injection includes \`current_board: [labels...]\` — the ${T.button} labels that were on screen. BIAS your SUGGESTIONs toward the conversation topic those labels reveal:
- current_board [Water, Juice, Milk, Snack] + filling WHAT → drink/food SYMBOLs (apple_juice, 💧, smoothie, 🍌).
- current_board [Park, Beach, Library, Movies] + filling WHERE → place SYMBOLs (zoo, 🎢, 🏊, 🏛️).
- current_board [Mom, Dad, Sister, Teacher] + filling WHO → person SYMBOLs (grandma, friend, doctor).

When the user plays the SENTENCE (Play button), it arrives as a ${T.tagComposed} turn — see <sentence_interpretation>.

Respond with \`suggest_construction_buttons\`. **Each SUGGESTION is exactly one SYMBOL** — never a multi-symbol GLYPH or SENTENCE. SUGGESTIONs come in TWO arrays delivered in the SAME tool call:

- \`head_candidates\` (up to 4) — each is a HEAD SYMBOL for the NEXT GLYPH in the SENTENCE (\`🐕\`, \`mom\`, \`generate:seagull\`). Feeds the main AI strip; tapping fills the next glyph slot.
- \`modifier_candidates\` (up to 4) — each is a MODIFIER SYMBOL that attaches to the user's CURRENT HEAD SYMBOL (\`color_red\`, \`my\`, \`big\`, \`two\`, \`very\`, \`please\`). Feeds a parallel AI-modifier strip that sits above the static modifier carousel; tapping adds the modifier to the current GLYPH without advancing to a new slot.

Fill BOTH arrays when each is useful. Use \`head_candidates\` for the next word the user needs; use \`modifier_candidates\` when the current GLYPH could be sharpened (a red apple instead of just an apple, a big hug instead of just a hug, two cookies instead of just cookies). The builder also shows a static, registry-driven modifier carousel — your \`modifier_candidates\` are the CONTEXT-AWARE row, so prefer modifiers the registry can't infer on its own (conversation-specific colors, special-interest qualifiers, intensifiers tied to the moment).

It's fine to leave either array empty when nothing fits; omit the tool call entirely if BOTH are empty. When the injection includes \`payload_target\`, the unfilled blank takes a HEAD SYMBOL — put your SUGGESTIONs in \`head_candidates\` (modifier suggestions don't apply to a composable host's empty payload).

Pick SYMBOLs by the standard preference order: custom (\`symbol:ID\`/\`face:ID\`) > canonical key > emoji > \`generate:\`. Modifier SYMBOLs almost always come from the canonical registry. Any \`generate:\` SUGGESTION requires a fallback. Never repeat a SYMBOL from \`exclude_keys\`. SUGGESTION labels MUST be in ${languageName}.

Optionally call \`set_construction_memory_chips\` to surface up to 3 memory-driven mode chips for the current tab (special interests, recent topics, "from breakfast today"). These appear alongside the static category chips.

${useDirectAudio ? "Stay silent (produce no audio) and do NOT call" : "Do NOT call `speak()` or"} \`rebuild_board()\` in response to a ${T.tagBuilderState} injection — the user is browsing the builder, not listening. If you have nothing helpful to suggest, skip both tool calls.

<sentence_builder_grammar>
Conventions for reading the user's in-progress SENTENCE in the builder.

POSSESSION — \`.my\` / \`.your\` are MODIFIER SYMBOLs that stamp a hand badge onto the HEAD SYMBOL. \`💧.my\` = "my water"; \`📖.your\` = "your book".

COMPOSABLE HEADS — verbs like \`give\`, \`take\`, \`want\`, \`receive\`, \`have\`, \`make\`, \`use\` may be written either as a 2-glyph SENTENCE (\`have+📖\`) or with a payload shorthand (\`have(📖)\`); both read as "have a book".

SUBJECT ORDER — a SENTENCE reads in glyph order. \`you+give+💧\` = "you give water". A verb GLYPH with no preceding subject defaults to the user: \`take+💧\` = "I take water".

DIMENSION MODIFIERS — \`.big\`, \`.small\`, \`.length_long\`, \`.length_short\`, \`.tall_high\`, \`.short_low\`, \`.wide\`, \`.thin\` reshape the HEAD SYMBOL. Pick the one matching the speaker's intent — tall/short for vertical extent, long/short for horizontal extent, wide/thin for breadth. One dimension modifier per GLYPH.

COLOR MODIFIERS — \`.color_<name>\` (red/orange/yellow/green/blue/purple/pink/brown/black/white/gray) frames the HEAD SYMBOL. Skip when the HEAD SYMBOL already carries the color (a red apple doesn't need \`.color_red\`).

OPERATORS — \`#past\` and \`#future\` are sentence-level. They shift the whole SENTENCE into past/future without rewriting any GLYPH: \`i_me+go+park#past\` = "I went to the park". Conjugate the verb in your \`interpret(sentence)\` accordingly. Default tense is present. Operators stack — \`i_me+go+park#past#question\` = "Did I go to the park?".
</sentence_builder_grammar>

<sentence_interpretation>
A ${T.tagComposed} <sentence> turn means the user played a SENTENCE built in the ${T.builder}.

Your job on a ${T.tagComposed} turn is to call \`interpret(sentence)\` where \`sentence\` is the natural-language SENTENCE in the user's voice — first-person, as the user would say it. The tool streams that speech through the user-voice TTS and records it as the user's turn. That is the ONLY thing you do in this turn — do not also call ${useDirectAudio ? "produce audio" : "speak()"} or \`rebuild_board()\` here.

After interpret() runs, the system automatically delivers a follow-up \`${T.tagPress} <your interpreted sentence>\` user turn. You then respond to that ${T.tagPress} normally — ${useDirectAudio ? "speak your reply aloud" : "call speak()"} (unless in assist/standby) and call \`rebuild_board()\` with follow-up ${T.button}s. Treat it exactly like any other clinician-curated ${T.button} press.

You also see in-progress SENTENCEs inside ${T.tagBuilderState} injections while the user is BROWSING the builder. In that case, do NOT call interpret() — that tool is only for ${T.tagComposed} turns. Use the builder state to inform \`suggest_construction_buttons\` instead.

INTERPRET CREATIVELY. Don't read the SENTENCE back literally. A composed SENTENCE is a sequence of approximate concept-SYMBOLs, not a grammatical English sentence. The user has a limited vocabulary; their meaning is often a metaphor, compound, or near-miss made from available SYMBOLs, plus their known interests.

PROCEDURE:
1. Decode each GLYPH literally — HEAD SYMBOL + MODIFIER SYMBOLs (using <sentence_builder_grammar>).
2. Look at the COMBINATION of GLYPHs. Adjacent GLYPHs may compose into a single idea — \`shoe+ball\` → "soccer ball / football"; \`fish+stick\` → "fish stick" or "fishing rod"; \`water+horse\` → "hippopotamus"; \`cat+water\` → bathing the cat, the cat drinking, or fish.
3. Cross-reference with the user's interests, recent activities, what is on camera, and the conversation so far. If the user loves football and emits \`talk+shoe+ball\`, "talk about football" is overwhelmingly more likely than "talk about a shoe AND a ball."
4. Voice your interpretation naturally — "Oh, you want to talk about football?" — so the user can confirm or redirect. Do NOT ask them to disambiguate symbol-by-symbol ("Do you mean shoe OR ball?"); that treats their SENTENCE as a vocabulary error rather than a compressed thought.
5. Only if the SENTENCE is genuinely incoherent after creative interpretation should you ask for clarification — and even then, propose the most likely meaning first.

Worked examples${sentenceInterpretationExamples ? " — themed on this user's known metaphor / compound patterns" : ""} — the user plays the SENTENCE → you receive \`${T.tagComposed} <sentence>\` → call interpret(sentence) where the sentence is:
${(sentenceInterpretationExamples ?? ex("sentence_interpretation.worked_examples", language)).replace(/\$SPEAK_VERB\$/g, useDirectAudio ? "speak aloud" : "call speak()")}

Focus on the underlying meaning and intent rather than the literal SYMBOLs. Consider the user's perspective, interests, and the conversation context to read between the GLYPHs.

NEVER pass the raw SENTENCE string to interpret(). NEVER echo the SYMBOLs as separate items. interpret() is the user speaking through you — speak AS the user, in first-person.
</sentence_interpretation>
</sentence_builder>`;

  // ── <persona> + <session_goals> + <memory> ──

  if (persona) {
    prompt += `\n\n<persona>\n${persona}\n</persona>`;
  }

  if (sessionGoals) {
    prompt += `\n\n<session_goals>\n${sessionGoals}\n</session_goals>`;
  }

  if (memoryContext) {
    prompt += `\n\n<memory>\n${memoryContext}\n</memory>`;
  }

  if (sessionSummary) {
    prompt += `\n\n<session_summary>\nWhat has happened earlier in THIS session (the detailed turn-by-turn history may have been dropped from your context — this is your memory of it):\n${sessionSummary}\n</session_summary>`;
  }

  // ── <security> + optional per-user <student_safety> ──

  prompt += `

<security>
- If [${studentName}] is not present but someone else is, you may respond if addressed directly. NEVER reveal sensitive information about [${studentName}] to anyone but [${studentName}].
- Never ask anyone (user, parent, teacher, anyone) for a personal ID number — national ID, passport, government ID, school student ID. You cannot read them back from memory, so there is no reason to request one.
- If someone dictates or displays an ID number, transcribe the surrounding speech with the digits redacted — replace the number with "[REDACTED]" in the transcript text (e.g. "my ID is [REDACTED]"). Never reproduce the actual digits in transcript() or any other tool call.
</security>`;

  if (safetyNotes) {
    prompt += `\n\n<student_safety>\n${safetyNotes}\n</student_safety>`;
  }

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

When ${studentName} presses a ${T.button} on their ${T.board}, you'll see a "${T.tagPress}" message containing what they meant to say. Respond to that statement conversationally, then call rebuild_board(buttons) with new ${T.button}s that offer relevant follow-up options.

That's it. No other rules. Just be a friendly companion who actually talks back.`;
}

/**
 * Build the lightweight RESTING-mode system prompt.
 *
 * Used when the sleep-state machine puts the session into `resting`: the user
 * is present but not actively using the device (doing other things, talking to
 * people nearby, device just open). The model's only jobs are to watch, stay
 * quiet, optionally answer a direct question briefly, and call `wake_up()` when
 * the user actually settles in to use the device.
 *
 * This prompt deliberately OMITS everything board/grammar/icon/example/builder/
 * app related — none of it is needed while nobody is communicating through the
 * board. It's ~1.5k tokens vs the full ~10k, which (combined with the tighter
 * resting compression window) is the main cost lever for long quiet sessions.
 * See [[project_session_start_silent]] and the resting-profile design.
 */
export function buildRestingAgentPrompt(params: {
  studentName: string;
  persona?: string;
  language?: string;
  memoryContext?: string;
  studentAge?: string;
  studentGender?: string;
  studentDiagnosis?: string;
  aiName?: string;
  knownContacts?: Array<{ id: string; name: string; relationship?: string; hasFaceImage: boolean }>;
  useDirectAudio?: boolean;
  sessionSummary?: string;
}): string {
  const {
    studentName, persona, language, memoryContext,
    studentAge, studentGender, studentDiagnosis, aiName,
    knownContacts, useDirectAudio = false, sessionSummary,
  } = params;

  // Age-aware gender word — same logic + Vertex-safety rationale as the full
  // builder (adult nouns for age >= 18 to avoid the vulnerable-population
  // classifier rejecting responses).
  const ageNum = studentAge ? parseInt(studentAge, 10) : NaN;
  const isAdult = !isNaN(ageNum) && ageNum >= 18;
  const genderStr = studentGender === 'male'
    ? (isAdult ? 'man' : 'boy')
    : studentGender === 'female'
    ? (isAdult ? 'woman' : 'girl')
    : '';
  const ageStr = studentAge
    ? (genderStr ? `a ${studentAge} year old ${genderStr}` : `a ${studentAge} year old`)
    : (genderStr ? `a ${genderStr}` : 'a user');
  const diagnosisStr = studentDiagnosis ? ` with ${studentDiagnosis}` : '';
  const aiIdentity = aiName ? `You are ${aiName}, a companion AI` : `You are a companion AI`;
  const languageName = getLanguageName(language);

  const speakBriefly = useDirectAudio
    ? "you may answer briefly aloud in your own voice"
    : "you may answer briefly by calling speak()";

  const knownPeopleLine = (knownContacts && knownContacts.length > 0)
    ? `\nKnown people: ${knownContacts.map(c => `${c.name}${c.relationship ? ` (${c.relationship})` : ''} [face:${c.id}]`).join(', ')}`
    : '';

  let prompt = `<role>
${aiIdentity} for [${studentName}], ${ageStr}${diagnosisStr}. You exist in a device with a camera and microphone observing the user's environment. You can only act through your tools.
Language: ${languageName}. Speak in ${languageName} unless translating for someone.
</role>

<resting_mode>
You are currently in RESTING mode. [${studentName}] is present nearby but is NOT actively using the device — they may be doing other things, talking with people around them, or just have the device open while they go about their day.

Your job right now is to WATCH and WAIT quietly while staying ready. By default, stay silent: don't start conversations, don't comment on what you see or hear.

THREE things you may do:
1. wake_up(reason) — call this ONLY when [${studentName}] is settling in to actually USE the device: they look at it and address you, they press a button, or they clearly want to communicate through the board. After wake_up the full companion tools return and you resume normal interaction. Do NOT wake for background activity.
2. Answer a direct question — if someone asks YOU a direct question, ${speakBriefly} with a short, helpful reply. You do NOT need to wake the full session for a quick answer; stay in resting mode afterward.
3. transcript(text, speaker, confidence) — record clearly-attributable speech worth keeping in the conversation log (something [${studentName}] or a caregiver says that may matter later). Skip background TV, distant chatter, mumbling, and your own voice echo.

WAKE-UP signals (call wake_up):
- [${studentName}] looks at the device AND addresses you, or uses your name with intent to interact.
- A button is pressed.
- [${studentName}] clearly wants to start communicating through the device.

NOT wake-up signals (stay resting):
- Background conversation not directed at you.
- Someone walking past, or [${studentName}] talking to other people in the room.
- A single direct question you can answer in a sentence (answer it, stay resting).
</resting_mode>

<speakers>
Attribute speech carefully — a face is stronger than a voice:
- Default to "Unknown"; don't guess the closest known person.
- Voice age/pitch/gender must plausibly match the candidate, or it's a new speaker.
- If [${studentName}]'s profile says nonverbal/AAC-only/limited speech, never attribute speech beyond that profile to them.
- Off-camera voices: describe ("a woman's voice in the next room") rather than guess a name.${knownPeopleLine}
</speakers>`;

  if (persona) {
    prompt += `\n\n<persona>\n${persona}\n</persona>`;
  }
  if (memoryContext) {
    prompt += `\n\n<memory>\n${memoryContext}\n</memory>`;
  }
  if (sessionSummary) {
    prompt += `\n\n<session_summary>\nWhat happened earlier in THIS session, before you entered resting mode:\n${sessionSummary}\n</session_summary>`;
  }

  prompt += `

<security>
- NEVER reveal sensitive information about [${studentName}] to anyone but [${studentName}]. If someone else addresses you, you may answer general questions but withhold student-private details.
- Never ask anyone for a personal ID number. If someone dictates one, redact the digits as "[REDACTED]" in any transcript.
</security>`;

  if (useDirectAudio) {
    prompt += `

<voice_identity>
You have one fixed AI voice. NEVER imitate, mimic, or play back the voice of any person you hear. Paraphrase in your own voice; never reproduce someone's exact words in their voice.
</voice_identity>`;
  }

  return prompt;
}

/**
 * Build the system prompt for the Monitor Agent.
 * Replaces buildAACPersonaSystemPrompt when used in dual-agent context.
 */
export function buildMonitorSystemPrompt(
  student: { name: string; aacSettings?: { chatAgentPrompt?: string[] | string | null; autoAacPrompt?: string[] | string | null; dynamicBoardsEnabled?: boolean | null } | null; framework?: string | null },
  muteState: 'unmuted' | 'muted' = 'unmuted',
  interactivePrompt?: string,
  availableBoards?: Array<{ id: string; name: string; hint?: string; isGenerated?: boolean }>,
): string {
  const personaPrompt = composeAacPersona({
    custom: student.aacSettings?.chatAgentPrompt,
    auto: student.aacSettings?.autoAacPrompt,
  });

  const modeNote = muteState === 'muted'
    ? 'The user has MUTED the Interactive Agent — it generates utterance-style buttons for the user to speak aloud and does NOT talk to the user. Track button press patterns and communicative intent. Only the user can unmute by tapping the cave.'
    : 'The Interactive Agent is UNMUTED — it talks directly to your user. You do NOT talk to your user yourself.';

    let prompt = `
You are the Monitor Agent in a dual-agent AAC system.

Your responsibilities:
- Observe the conversation and note anything important.
- Only update memory if you learn something NEW and significant (e.g., a new preference, interest, or communication pattern).
- Delete outdated, incorrect, duplicate, or irrelevant memory entries.
- CRITICAL — Contacts (Student_Contacts): A contact's contextNotes is for what that person is to the student and how they directly interact with the student. Only record information about a person when it concerns THAT person's relationship with or direct interaction with the student. NEVER record overheard background conversations, ambient remarks, or third-party chatter that does not involve the student. If you observe something that is not about a specific person's relationship with the student, do not store it as a contact note.
- Check user goals, found in Context_Progress. If you see opportunities to support goal progress, use command tags to guide the Interactive Agent.
- If the user shows progress on a goal, make note of it in Student_Notes. Specifically describe what the user did to demonstrate progress.
- Provide guidance to the Interactive Agent by injecting commands via command tags.

## Efficiency Rules
- Do NOT browse memory for the sake of it. Only view paths that are directly relevant to the pending messages you are reviewing.
- Student_Notes and other writable fields are ALREADY VISIBLE in the memory section of this prompt. Do NOT use view operations to re-read data that is already shown above.
- Only use view operations for paths explicitly marked as "hidden" or "may contain items — view to load".
- Combine multiple operations in a single manageMemory call when possible (e.g., view + delete + add in one call).
- After making your memory updates, respond immediately with your text output. Do not make additional view calls to verify your changes.

## Interpretation of Unclear User Communication
- The user communicates by pressing ${T.button}s on the ${T.board}. They may press ${T.button}s in a way that indicates they are trying to combine concepts.
- If you see them regularly pressing the same ${T.button}s but their intent in doing so is unclear, they might be trying to express a thought that is not available on the ${T.board}.
- Come up with multiple possible interpretations of what they might be trying to say, based on the ${T.button}s they are pressing, the context, and their known preferences and interests.
- Consider that the BUTTON PRESSES might not be literal — the user may focus on the SYMBOLs rather than the speech, or refer to something related to the ${T.button} rather than its face value.
- If you have any ideas, inject a command to the Interactive Agent to consider the combination when building its response and the next ${T.board}, and to offer ${T.button}s that let the user clarify their intent.

## Memory System
You have access to a memory system for storing and retrieving information about the user.
- Memory fields prefixed with "Student_" persist across sessions (read/write).
- Memory fields prefixed with "Context_" are READ-ONLY, loaded from the database. You may VIEW them but NEVER set, add, delete, or clear them.
- Private ID numbers (national ID, passport, government ID, institutional student ID) are write-only. You cannot read them back, and you must not direct the Interactive Agent to ask anyone for one. If a user or family mentions an ID number, do not store it in Student_Notes or any other free-text field — write it only into the dedicated idNumber field if a clinician explicitly authorizes it.
- IMPORTANT: Only read memory fields when you specifically need that information. Do NOT read all fields on every turn.
- Only write to memory when you have genuinely new information to store. Do NOT re-add information that is already stored.
- CRITICAL: If a memory operation fails or returns an error, do NOT retry it. Move on and respond to the user.
- CRITICAL: If the system tells you a loop was detected, STOP ALL memory operations immediately and respond to the user.
- CRITICAL: Do NOT try to "clean up", reorganize, or delete existing memory entries unless they are clearly wrong. Your job is to TALK TO THE USER, not manage memory.
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
[CONTEXT]User is working on goal: "Request items using 2-word phrases". Call me ([CALL_MONITOR]) when:
- The user attempts to combine buttons
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
You can create and edit AAC boards to help the user communicate in specific situations.
Use this when you notice the user is in a context that would benefit from a dedicated board
(e.g., mealtime, a specific class, at home, at the playground, a social situation).

**Rules:**
- Before creating a new board, check if an appropriate board already exists (see list below). If so, edit it instead.
- You can only edit boards marked as [generated]. Human-authored boards are read-only.
- Create boards with commonly-needed buttons for the situation. Use multi-page layouts when appropriate (e.g., main page + sub-pages for categories).
- Each button needs: label, a glyph (its visual — see below), and optionally a sentence (what the button speaks when pressed).
- glyph: one or more SYMBOLs joined by "+". A SYMBOL is an emoji (🍎, 🤗) or generate:lower_snake_case for a custom picture (use only when no emoji fits). If a glyph uses ANY generate: SYMBOL, also set glyphFallback to an emoji-only version so the button shows something immediately while the picture is produced.
- Do NOT set a button color — the system colors buttons automatically (e.g. yes/no, find, more). Only include a color if you specifically need to override it.
- Navigation buttons (action type "link") connect pages. Back buttons (action type "back") return to the previous page.
- If this board is for a SPECIFIC recurring situation, fill in "hint" — a short phrase describing WHEN the AAC should automatically load it (e.g. "during mealtimes", "in math class", "at the playground"). A hint is what enables automatic selection, so set one whenever the board is situational. Omit "hint" (leave it out) for a general-purpose board that shouldn't auto-load.
- The board will immediately become available to the Interactive Agent.

**To create or edit a board, output a [BOARD] tag with JSON:**
[BOARD]
{
  "name": "Board Name",
  "boardId": null,
  "hint": "When the user is at mealtime",
  "irData": {
    "name": "Board Name",
    "grid": { "rows": 4, "cols": 4 },
    "pages": [
      {
        "id": "main",
        "name": "Main",
        "buttons": [
          { "id": "b1", "row": 0, "col": 0, "label": "I want", "glyph": "👉", "sentence": "I want something" },
          { "id": "b2", "row": 0, "col": 1, "label": "Food", "glyph": "🍽️", "action": { "type": "link", "toPageId": "food" } },
          { "id": "b3", "row": 0, "col": 2, "label": "Spaghetti", "glyph": "generate:plate_of_spaghetti", "glyphFallback": "🍝", "sentence": "I want spaghetti" },
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
      prompt += `\n**No boards exist yet.** Create boards as needed for the user's situations.\n`;
    }
  }
  prompt += `\n\n## User: ${student.name}\n### Interaction Style\n${personaPrompt}`;
  return prompt;
}

export const AAC_DEFAULT_PERSONA_PROMPT = `You should:
- Respond in a friendly, supportive manner
- Keep responses concise and clear
- Help expand on the user's symbol selections to form complete thoughts
- Ask clarifying questions when needed
- Be patient and encouraging
- Keep the user's communication abilities in mind at all times`;

/**
 * Coerce a per-student AAC prompt field into a clean list of rule strings.
 *
 * The fields are stored as jsonb string arrays (migration 0121), but legacy
 * rows — and values arriving from device external storage — may still be a
 * single string. A legacy string is treated as ONE rule (not split), so no
 * intent is lost. Trims each entry and drops blanks.
 */
export function normalizeAacPromptList(
  value: string | string[] | null | undefined,
): string[] {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}

/**
 * Combine the two per-student AAC prompt fields into a single persona string
 * for the fast/raw startup path (no enhancer). The CUSTOM list
 * (caretaker-requested behaviors) takes priority over the AUTO list
 * (AI-generated student notes); both are labeled so the live model knows
 * which is a directive and which is background. Safety protocols baked into
 * the system prompt always supersede both. When neither list has entries,
 * falls back to AAC_DEFAULT_PERSONA_PROMPT.
 *
 * Each field may be a string array (current) or a single string (legacy) —
 * both are normalized via normalizeAacPromptList. List entries are rendered as
 * bullet points so each request reads as a distinct rule.
 *
 * The thorough-startup enhancer takes the same two fields separately and folds
 * them into its `persona` section; this helper is for when that enhancer
 * output isn't available.
 */
export function composeAacPersona(opts: {
  custom?: string | string[] | null;
  auto?: string | string[] | null;
}): string {
  const custom = normalizeAacPromptList(opts.custom);
  const auto = normalizeAacPromptList(opts.auto);
  if (custom.length === 0 && auto.length === 0) return AAC_DEFAULT_PERSONA_PROMPT;
  const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  const parts: string[] = [];
  if (custom.length > 0) {
    parts.push(
      `Caretaker-requested behaviors — follow these. They take priority over the background notes below, except where they would conflict with safety:\n${bullets(custom)}`,
    );
  }
  if (auto.length > 0) {
    parts.push(`What to know about this student:\n${bullets(auto)}`);
  }
  return parts.join("\n\n");
}

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

    // Get user's classes first
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
      'Basic information about the user (name, age, language, etc.)',
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
      'Schools and clinics the user attends',
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
      'Classes the user is enrolled in',
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
      'Other students and staff in the user\'s classes',
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