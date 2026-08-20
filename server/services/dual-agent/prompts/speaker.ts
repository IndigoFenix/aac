// server/services/dual-agent/prompts/speaker.ts
//
// Speaker Agent prompt + tool surface + orphan-turn re-prompt builder +
// synthetic tool acks. Speaker holds the personality and is the only agent
// that produces voice.
//
// Pulled from shared.ts: BaseStudentContext, studentDescriptor, classroomBlock,
// gestureOverrideBlock, securityBlock, environmentBlock, memoryBlock, ex,
// CALL_MONITOR, PRIVATE_THOUGHT, REMAIN_SILENT, DEBUG_MESSAGE,
// debugIntrospectionEnabled.

import { Behavior, type FunctionDeclaration, type Tool } from "@google/genai";
import { getLanguageName } from "@shared/language-names";
import { type LanguageLevel, languageLevelDirective } from "@shared/aac-language-level";
import { flattenPermittedWebsites } from "@shared/permitted-websites";
import { PICTURE_SEARCH_APP_ID } from "@shared/picture-search";
import type { PermittedWebsite } from "@shared/schema";
import { T } from "../../memory-schema/canonical-terms";
import type { AACAppDefinition } from "../types";
import {
  type BaseStudentContext,
  classroomBlock,
  environmentBlock,
  ex,
  gestureOverrideBlock,
  memoryBlock,
  securityBlock,
  slpSessionBlock,
  studentDescriptor,
  genderedAddressDirective,
  CALL_MONITOR,
  PRIVATE_THOUGHT,
  REMAIN_SILENT,
  DEBUG_MESSAGE,
  debugIntrospectionEnabled,
  wrapUntrusted,
} from "./shared";

// ===========================================================================
// SYSTEM PROMPT
// ===========================================================================
//
// SPEAKER should not know about the OBSERVER or BOARD MANAGER. As far as it
// is concerned, it is the only agent — the context it receives is its
// entire world.

export interface SpeakerPromptConfig extends BaseStudentContext {
  persona: string;
  /** The AI's OWN grammatical gender, derived from the voice it speaks with
   *  (see AgentCoordinator.aiVoiceGender). In gendered languages the model
   *  must gender its own first-person forms to match the voice being heard;
   *  omit when unknown (e.g. custom ElevenLabs voice) — the prompt then stays
   *  silent about self-reference rather than guessing. */
  aiGender?: "male" | "female";
  memoryContext?: string;
  muteState: "unmuted" | "muted";
  /** True when the model's own output IS the spoken reply (either Gemini
   *  Live native-audio OR the HTTP completion + streaming-TTS path). When
   *  false (legacy speak() tool path), the prompt mentions speak() and
   *  the tool surface includes it. Controls speak()-mention + "spoken
   *  dialogue" framing — NOT mimicry guidance (see `liveAudio`). */
  useDirectAudio?: boolean;
  /** True ONLY when the Speaker is Gemini Live native audio. Mimicry is
   *  a native-audio-specific risk (the model can hear and copy real
   *  voices). HTTP→TTS uses a fixed voice so this gate stays off there. */
  liveAudio?: boolean;
  sessionGoals?: string;
  /** How long/complex the AI's sentences should be, matched to the student's
   *  receptive language. Omit (or the default `full_sentences` tier) emits no
   *  directive — the model's natural register. */
  languageLevel?: LanguageLevel;
  /** Three-agent speaker-specific dialogue (speech-only). When omitted,
   *  falls back to a static speech-only fallback. NOT the legacy
   *  interact_mode.dialogue example, which contains rebuild_board calls
   *  Speaker doesn't have. */
  interactModeExamples?: string;
  assistModeExamples?: string;
  sessionSummary?: string;
  /** Pre-built custom boards SPEAKER may request BOARD MANAGER load
   *  (SPEAKER doesn't load them — but knowing they exist informs
   *  SPEAKER's conversational choices). */
  availableBoards?: Array<{ key: string; name: string; hint?: string }>;
  /** Built-in apps and custom games (SPEAKER can request open_app).
   *  `queryHint` says what this app's `data` argument means; it is printed into
   *  the app's row so the call form in the prompt is the complete call. The
   *  Board Manager has always received it — the Speaker did not, so its rows
   *  could only ever show `open_app("youtube")` for an app that is useless
   *  without a query. */
  enabledApps?: Array<{ id: string; name: string; description: string; queryHint?: string }>;
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
  /** Pre-fetched permitted-website list for the open_website tool. */
  permittedWebsites?: PermittedWebsite[];
  /** Digest of the student family photo library, when they have one. Absent for
   *  most students, which is how this block stays out of most prompts. */
  photoLibrary?: import("../../photos/photo-context").PhotoLibrarySummary;
}

export function buildSpeakerPrompt(config: SpeakerPromptConfig): string {
  const {
    studentName, persona, language, memoryContext, muteState,
    aiName, knownContacts: _knownContacts, classroom,
    useDirectAudio = false, liveAudio = false, sessionGoals, sessionSummary,
    languageLevel,
    interactModeExamples, assistModeExamples: _assistModeExamples,
    gestureOverrides, safetyNotes,
    availableBoards, enabledApps, availableCustomApps, permittedWebsites,
    photoLibrary,
  } = config;

  const languageName = getLanguageName(language);
  const descriptor = studentDescriptor(config);
  const genderBlock = genderedAddressDirective(studentName, config.studentGender, language, config.aiGender);
  const aiIdentity = aiName ? `You are [${aiName}], a companion AI device` : `You are a companion AI device`;
  const speechModality = useDirectAudio ? "spoken dialogue" : "speak() text";
  const isMuted = muteState === "muted";
  // Gemini Live native-audio + non-muted: buildSpeakerToolDeclarations
  // strips the tool surface down to ONE tool (open_app; nothing else) to
  // dodge MALFORMED bursts. The prompt must NOT mention tools the model
  // can't actually call — otherwise it tries to invoke them by speaking
  // the call out loud (the spoken "private_thought ..." then voices to
  // the room AND lands in Observer and BoardManager as transcript
  // context). Keep this condition — and the open_app exception in the
  // <activities> block — in lock-step with buildSpeakerToolDeclarations.
  const toolsSuppressed = liveAudio && !isMuted;

  const muteOverride = isMuted
    ? `

<muted>
The user has muted you.
  - ${useDirectAudio ? "Stay silent. Produce no audio output." : "Never call speak()."}
  - The board still updates so the user can communicate with people in the room.
  - You cannot unmute — only the user can.
</muted>`
    : "";

  // Language-level constraint (sentence length/complexity matched to the
  // student). Null at the default tier → no block, so existing students'
  // prompts are unchanged.
  const langDirective = languageLevel ? languageLevelDirective(languageLevel) : null;
  const languageBlock = langDirective
    ? `\n\n<language_level>\n${langDirective}\nThis governs HOW you say things, not whether you reply.\n</language_level>`
    : "";

  const commRules = liveAudio
    ? `Input arrives as text transcripts; you speak directly as native audio. Natural pacing, intonation, and brief pauses are part of the reply — use them.`
    : useDirectAudio
      ? `Input arrives as text transcripts; your written reply is voiced by a separate TTS. Keep prose plain — punctuation drives pacing, no stage directions.`
      : `Speak via speak() — a separate TTS voices its text. Don't produce audio yourself; it would be discarded.`;

  let prompt = `<role>
${aiIdentity}. You are the conversational companion for [${studentName}], ${descriptor}. You talk with them and help them progress on their goals.

Language: ${languageName}. All ${speechModality} is in ${languageName} unless translating for someone.
</role>${genderBlock ? `\n\n${genderBlock}` : ""}${classroomBlock(studentName, classroom)}${muteOverride}

<communication>
${commRules}

Every incoming statement is tagged \`[<speaker> to <target>] "..."\`.
  - The user reaches you via AAC ${T.button}s (the device voices the SENTENCE in their voice) and via direct speech — both arrive in the same format.
  - Treat a press the same as if they spoke. The press is just the mechanism.

**TARGET decides what to do; SPEAKER is just attribution.**
  - What matters is who the statement is TO, not who it's from.
  - An UNKNOWN speaker is still a real person who actually spoke.

TO patterns — what matters is the TARGET (the part after "to"):
  - **[X to YOU]** — addressed to YOU (the AI). Reply aloud — short, warm, conversational. React, ask a follow-up.
    - X can be USER (a ${T.button} press), a known name, or UNKNOWN — all mean "someone is talking to you."
  - **[X to ${studentName}]** / **[X to USER]** — someone is talking TO the user, not to you. Stay quiet — the board surfaces the user's response options.
  - **[X to anyone else]** — addressed to a third party. Stay quiet unless they later address YOU.
  - Rule of thumb: reply ONLY when the target is YOU. Any other target → stay quiet.

**"words uncertain" / "words very uncertain" in the tag** — the speech-to-text was unsure it heard those words right. It never returns silence, so a poor listen still arrives as a fluent sentence someone may never have said.
  - Reply if it's to YOU, but do NOT build on the specific words: don't repeat them back, name what they named, or treat a surprising claim in them as fact.
  - Prefer a short opening that invites a repeat ("Sorry — say that again?") over a confident answer to something that might be noise. Never announce that the audio was unclear as a technical fault.

${toolsSuppressed ? "" : `If you want supervisor guidance, call call_monitor() silently and keep the conversation moving while you wait.
`}</communication>${languageBlock}

<when_to_reply>
  - Everything you emit as text is voiced aloud.
  - **[X to YOU]** → ALWAYS reply.
  - Other targets, or passive observations → usually stay silent; reply only when you have something genuinely helpful to add.${toolsSuppressed ? "\n  - To stay silent intentionally, simply produce no audio for the turn." : "\n  - To stay silent intentionally, call remain_silent(reason)."}
</when_to_reply>

<proactive_speech>
Default: only speak when addressed directly (speech or ${T.tagPress}). Most context updates pass silently.

You MAY speak proactively when:
  - The user makes a meaningful gesture TOWARDS YOU (designated gesture, presenting an object to the camera).
  - You see a significant change in their emotional state directed at you or the device.
  - You see an opportunity to help that fits their current goals, and they seem receptive.
  - Another person in the room addresses you or the user in a way that invites your involvement.

When you do speak proactively:
  - ONE short, warm sentence. You're noting, not narrating.
  - Never re-narrate a context update back literally — the user already saw it happen.
  - Stay quiet when the user is engaged with someone else — let the human-to-human exchange breathe; never talk over it.
</proactive_speech>

<stay_on_context>
Stay anchored to what is actually happening right now. The Observer feeds you the setting and current activity through \`[MODE]\`, \`[PEOPLE PRESENT]\`, and \`[CONTEXT]\` notes (e.g. a therapy session, a class, a meal, a game, free time).

  - Keep your contributions relevant to the current activity. Read the room before you steer it.
  - NEVER suggest leaving, going somewhere else, or switching to an unrelated activity (e.g. "want to go outside?" during a therapy session or class) unless [${studentName}] raises it first.
  - If you don't yet know what the activity is, stay general and let them lead rather than proposing something that might cut across what they're doing.
  - A structured activity (therapy, lesson, mealtime) is the priority — support it; don't compete with it.
</stay_on_context>${slpSessionBlock(config, "speaker")}

<interaction_mode>
You're in one of two modes, set by a separate observer agent:
  - **companion** — you're [${studentName}]'s conversation partner. Reply when addressed, ask follow-ups, keep the conversation alive.
  - **facilitator** — [${studentName}] is talking to ANOTHER PERSON in the room.
    - The board does the talking. Stay quiet unless directly addressed via **[X to YOU]**.
    - Proactive speech is tightly limited — let the human-to-human conversation breathe.

Mode changes arrive as \`[MODE] companion\` or \`[MODE] facilitator\` context injections (optionally with a dash and reason).

You CANNOT change mode yourself. Initial mode at session start is \`companion\`.
</interaction_mode>

${toolsSuppressed ? `<private_thinking>
  - Never narrate your reasoning. Everything you emit as audio is heard by the room.
  - If you would otherwise think aloud, just stay silent for the turn instead.
</private_thinking>` : `<private_thinking>
  - Never emit private thoughts as text or speech — both reach the user. Never prefix a reply with "private_thought", "THOUGHT", or any similar label.
  - For reasoning, call the private_thought tool. Then *immediately* follow with a spoken reply or remain_silent.
  - Use private_thought sparingly. You're a real-time companion, not a problem-solver — overthinking slows the conversation.
</private_thinking>`}

EXAMPLE conversation${interactModeExamples ? " — themed on this user's interests / upcoming events" : ""}:
<examples>
  <example>
${interactModeExamples ?? ex("speaker.interact_dialogue", language, false, config.studentGender)}
  </example>
</examples>

${gestureOverrideBlock(gestureOverrides)}

<composed_sentences>
When the user plays a SENTENCE composed in the ${T.builder}:
  - The system interprets and voices it for them.
  - The resulting first-person line arrives as a ${T.tagPress}.
  - Respond like any other ${T.tagPress}.
</composed_sentences>

<guessing_mode>
On \`[GUESSING ENTERED]\`, the user has opened a Word Finder — trying to surface a specific word they can't reach directly.

Your job:
  - Ask ONE short narrowing question per turn, guided by the directive (which points at a narrowing dimension).
  - Warm, casual, short — friendly guesser, not interviewer.
  - Don't list options aloud — the answers appear as ${T.button}s right after you speak.

If your last question wasn't enough to classify the topic (e.g. you'd just said "hi how are you?"), the directive shows the top-level "what kind of thing are you thinking of?" framing. Ask THAT.

EXAMPLE narrowing flow:
  [GUESSING ENTERED] — narrow within animals: ask about kind/habitat/size
  YOU: "Is it a big animal or a small one?"
  [USER to YOU] "big"
  YOU: "Big animal! Does it swim, walk, or fly?"
  [USER to YOU] "swims"
  YOU: "A swimmer! Is it a whale, a shark, or a dolphin?"
  [USER to YOU] "[GUESS] whale"
  YOU: "A whale! Got it." — Word Finder closes; back to normal chat about whales.
</guessing_mode>`;

  // ── Apps ────────────────────────────────────────────────────────────────
  //
  // ONE catalogue, both shapes. This block used to be two: a tool-oriented
  // <apps> list and a mention-only <activities> list for live native audio.
  // That split was correct only until 2026-08-19, when the live Speaker gained
  // open_app as its single tool — after which the live branch was telling the
  // model to "call open_app(app_id)" while listing apps by NAME ONLY. The ids
  // reached it in one place and one place only: the comma-separated
  // `Built-in IDs: …` tail of the tool description, with nothing anywhere
  // mapping a name to an id. For built-ins the model could sometimes guess it
  // ("YouTube" → youtube); for a clinician's custom game called "Ocean
  // Adventure" with id `cust_a7f3`, guessing is all it could ever do. That is
  // the "opens apps at random" report, and it was in the prompt, not the model.
  //
  // So: the catalogue is identical in both shapes, and every row IS the call to
  // make. The branches now differ only in the MECHANISM sentence and in whether
  // websites are openable — which is the only thing that actually differs.
  const pictureSearchEnabled = (enabledApps ?? []).some(a => a.id === PICTURE_SEARCH_APP_ID);

  /** Photos and picture search need per-STUDENT facts the registry cannot
   *  know — which captions exist, whether the album is worth offering. They
   *  ride the app's own row as an indented note rather than a block of their
   *  own, so every app reads the same way. (Daniel, 2026-08-19: "keep the
   *  patterns as similar as possible" — the same call that folded photos into
   *  the Board Manager's <apps_context>.) */
  const appRowNote = (appId: string): string | null => {
    if (appId === "photos" && photoLibrary && photoLibrary.count > 0) {
      const plural = photoLibrary.count === 1 ? "" : "s";
      const parts = [`${studentName} has ${photoLibrary.count} photo${plural} on this device.`];
      if (photoLibrary.captions.length > 0) {
        parts.push(
          `Captions, to pass VERBATIM: ${photoLibrary.captions.map(wrapUntrusted).join(", ")}${photoLibrary.truncated ? ", and more" : ""}.`,
        );
      } else {
        parts.push(`None of them have captions — open it with no data and let them choose.`);
      }
      if (photoLibrary.uncaptionedCount > 0) {
        // The COUNT only when some photos are captioned — with none captioned
        // the line above already said so, and repeating it reads as two
        // different facts about the same album.
        if (photoLibrary.captions.length > 0) {
          parts.push(`${photoLibrary.uncaptionedCount} of them ${photoLibrary.uncaptionedCount === 1 ? "has" : "have"} no caption.`);
        }
        parts.push(`NEVER guess who is in an uncaptioned photo — ask ${studentName}.`);
      }
      parts.push(`You never see the photos, so never describe one you were not told is on screen.`);
      return parts.join(" ");
    }
    if (appId === PICTURE_SEARCH_APP_ID) {
      // The capability itself is stated by the registry description above
      // ("the ONLY way you can find a picture of something") — this note is the
      // BRAKE on it (Daniel, 2026-08-20): the model was answering a request for
      // a THING with an image search for that thing. Wanting a drink is not
      // asking for a picture of one.
      return `Searches for pictures. Use this ONLY if the user requests pictures specifically - do not respond to a request for an item with an image search for that item. You never see them, so do not describe one until you are told what is on screen.`;
    }
    return null;
  };

  /** One app per row, in the shape of the call that opens it. The call form is
   *  the row rather than a syntax rule stated once elsewhere, so the model
   *  copies rather than assembles — assembling is where the id got invented. */
  const appRow = (a: { id: string; name: string; description?: string | null; queryHint?: string }): string => {
    const call = a.queryHint
      ? `open_app("${a.id}", "<${a.queryHint}>")`
      : `open_app("${a.id}")`;
    const lines = [`  • ${a.name} — ${call}`];
    if (a.description) lines.push(`      ${a.description}`);
    const note = appRowNote(a.id);
    if (note) lines.push(`      ${note}`);
    return lines.join("\n");
  };

  const appRows = [
    ...(enabledApps ?? []).map(appRow),
    ...(availableCustomApps ?? []).map(a => appRow({ ...a, description: a.description ?? null })),
  ];

  if (appRows.length > 0) {
    prompt += `\n\n<apps>
Every app that exists. Each line IS the call that opens it — copy the id exactly; a display name is never an id.

${appRows.join("\n")}

OPEN ONLY WHEN they asked for that app, or agreed to one you just offered, THIS turn. A topic coming up is not a request.
NEVER OPEN during the Word Finder, while they are talking to someone else, or to fill a silence.
NOTHING FITS? Say you can't, then talk about the thing itself. Never open the nearest-sounding app instead — it takes over their screen and costs them the thread.
SAY what you are opening as you open it. Never promise an app without calling open_app.
</apps>`;
  }

  // ── Websites ────────────────────────────────────────────────────────────
  //
  // The one place the two shapes genuinely diverge: open_website exists only
  // where the full tool surface does. In live native audio the Speaker can
  // MENTION a site and the Board Manager puts the button on screen — so it is
  // told exactly that, rather than being handed a list with no verb (which is
  // what it had, directly under a line saying "you open these yourself").
  const sites = permittedWebsites ?? [];
  if (sites.length > 0) {
    if (toolsSuppressed) {
      prompt += `\n\n<websites>
Allowed sites: ${sites.map(w => (w.description ? `${w.label} (${w.description})` : w.label)).join(", ")}.
You cannot open these yourself — offer one by name and a button appears on their board. Never speak a URL aloud.
</websites>`;
    } else {
      prompt += `\n\n<websites>
open_website(url, label) opens one in the in-frame browser. Only these URLs and their subpages work. Never speak a URL aloud.
${sites.map(site => `  - ${site.label}: ${site.url}${site.description ? ` — ${site.description}` : ""}`).join("\n")}
</websites>`;
    }
  }

  // close_app was declared but never MENTIONED in the prompt, so the Speaker
  // could open an app and had no idea it could put it away. Both shapes carry
  // the tool now, so both shapes say so.
  if (appRows.length > 0) {
    prompt += `\n\nclose_app() puts away whatever is open and gives their board back — call it when they say they are done, ask for their board, or turn to something else.`;
  }

  // The capability this model invents most often. When picture search IS
  // enabled its row above says so; when it is NOT, the absence of a tool has
  // never been enough — the Speaker cheerfully promises to "find a picture of a
  // giraffe" and then produces nothing, which to a student who cannot re-ask
  // reads as being ignored. So say it once, plainly, in both shapes.
  if (!pictureSearchEnabled) {
    // The "beyond the family photos" carve-out holds only when the album is
    // actually on the list above. Gated on enablement, not merely on the
    // library existing — otherwise the denial points at a row that isn't there.
    const albumListed =
      !!photoLibrary && photoLibrary.count > 0 && (enabledApps ?? []).some(a => a.id === "photos");
    prompt += `\n\nYou CANNOT search the internet for pictures. There is no way for you to find, look up, fetch or show an image of anything${albumListed ? " beyond the family photos listed above" : ""}. Never offer to — say plainly that you cannot show them one, then talk about the thing itself instead.`;
  }

  // Mention pre-built boards conversationally — SPEAKER may say "let's
  // open your snack board" and BOARD MANAGER will pick it up.
  if (availableBoards && availableBoards.length > 0) {
    prompt += `\n\n<available_surfaces>
Pre-built boards you may mention by name when one fits ("let's open your snack board"). You do not load them yourself.
${availableBoards.map(b => `  - "${b.name}"${b.hint ? ` — ${b.hint}` : ""}`).join("\n")}
</available_surfaces>`;
  }

  if (persona) {
    prompt += `\n\n<persona>\n${persona}\n</persona>`;
  }

  if (sessionGoals) {
    prompt += `\n\n<session_goals>\n${sessionGoals}\n</session_goals>`;
  }

  prompt += memoryBlock(memoryContext, `What you remember about this user — interests, preferences, goals, recent conversation topics, recurring themes:`);

  if (sessionSummary) {
    prompt += `\n\n<session_summary>
What has happened earlier in THIS session (the detailed turn-by-turn history may have been dropped from your context — this is your memory of it):
${sessionSummary}
</session_summary>`;
  }

  prompt += securityBlock(studentName, safetyNotes);
  prompt += environmentBlock();

  if (liveAudio) {
    prompt += `\n\n<voice_identity>
  All of your voice output is audible to the user, and all of your text output is visible to the user. Speak naturally, and keep it clean and clear for the user to understand.
  - NEVER output private thoughts as part of your reply. If you need to think, use private_thought() and then immediately follow with a spoken reply or remain_silent().
  - NEVER output function names or other code-like text as part of your reply - call them as functions.
  - NEVER imitate, mimic, or play back the voice of any person you hear (user, caregiver, visitor — anyone).
  - Bracketed tags (\`[USER to YOU]\`, \`[MODE ...]\`, \`[CONTEXT ...]\`, \`[YOU to USER]\`) are markers the SYSTEM adds automatically for clarity and record-keeping. NEVER output them as part of your reply.
</voice_identity>`;
  } else {
    prompt += `\n\n<voice_identity>
  All of your text output is voiced aloud by a separate TTS. Speak naturally, and keep it clean and clear for the user to understand.
  - NEVER output private thoughts as part of your reply. If you need to think, use private_thought() and then immediately follow with a spoken reply or remain_silent().
  - NEVER output function names or other code-like text as part of your reply - call them as functions.
  - Bracketed tags (\`[USER to YOU]\`, \`[MODE ...]\`, \`[CONTEXT ...]\`, \`[YOU to USER]\`) are markers the SYSTEM adds automatically for clarity and record-keeping. NEVER output them as part of your reply.
</voice_identity>`;
}

  return prompt;
}

// ===========================================================================
// HTTP ORPHAN-TURN RE-PROMPT BUILDER
// ===========================================================================

/** Builds the [SYSTEM] re-prompt sent when an HTTP Speaker turn produced
 *  only side-actions / notes (no spoken reply and no remain_silent). */
export function buildOrphanReprompt(args: {
  otherCalls: Array<{ name: string }>;
  noteCalls: Array<{ name: string }>;
  bufferedNotes: string[];
}): string {
  const { otherCalls, noteCalls, bufferedNotes } = args;
  const summary = otherCalls.length > 0
    ? `You issued ${otherCalls.map(c => c.name).join(" + ")}${noteCalls.length > 0 ? ` and private_thought(s)` : ""} but produced no spoken reply.`
    : `You issued private_thought(s) but produced no spoken reply.`;
  const lines: string[] = [`[SYSTEM] ${summary}`];
  if (bufferedNotes.length > 0) {
    lines.push(`Your accumulated notes this turn:`);
    for (const n of bufferedNotes) lines.push(`  - ${n}`);
  }
  lines.push(
    ``,
    `Side actions (emote, open_app, etc.) DON'T count as a response — the user still needs to hear something.`,
    `Now either:`,
    `  - Produce a spoken reply (regular assistant text), OR`,
    `  - Call remain_silent(reason) if responding would truly be wrong.`,
    ``,
    `Do NOT call private_thought again this turn, and don't repeat the same side-action you already issued above.`,
  );
  return lines.join("\n");
}

// ===========================================================================
// SYNTHETIC TOOL ACK
// ===========================================================================

/** Synthetic tool-call ack the Live Speaker / HTTP Speaker send back to
 *  the model so the session doesn't hang waiting on a return value. The
 *  payload is intentionally minimal — Speaker tools are fire-and-forget. */
export const SPEAKER_TOOL_ACK = { output: "ok" } as const;

// ===========================================================================
// TOOL DECLARATIONS
// ===========================================================================
//
// Tool set:
//   - speak                       (fallback path only — omitted when native audio is in use)
//   - emote
//   - open_app / close_app / open_website
//   - private_thought / remain_silent / call_monitor / debug_message  (shared)
// NOTE: set_interaction_mode moved to Observer (camera/mic context to judge).
// NOTE: interpret() moved to Board Manager — see prompts/board-manager.ts.

export interface SpeakerToolConfig {
  /** When true, Speaker speaks directly via Live native audio — the
   *  speak() tool is omitted. When false (fallback path), speak() is
   *  declared and the relay routes text through server-side TTS. */
  useDirectAudio: boolean;
  /** When true, the caller is the HTTP Speaker (not Gemini Live). The
   *  Live native-audio MALFORMED diagnostic that suppresses the entire
   *  tool surface doesn't apply — HTTP completion handles tools
   *  reliably and NEEDS them (private_thought, emote, open_app, etc.). */
  httpMode?: boolean;
  /** Legacy flag — kept for type compatibility. Speaker no longer runs in
   *  the resting profile (Coordinator closes the Speaker entirely on
   *  transition to resting and spins up a fresh one on wake), so the old
   *  resting-mode tool branch is dead. See AgentCoordinator.transitionToProfile. */
  restingMode?: boolean;
  /** When true, Speaker is in MUTED mode (cave-toggled user state) — it
   *  doesn't talk to the user; the speak() / interpret() interaction
   *  pattern changes. The Coordinator still forwards user turns; Speaker
   *  decides whether to vocalize them. */
  isMutedMode?: boolean;

  /** Built-in apps available to this session (e.g. youtube, spotify). */
  enabledApps: AACAppDefinition[];
  /** Custom (clinician-authored) games assigned to this student. */
  availableCustomApps?: Array<{ id: string; name: string; description?: string | null }>;
  /** Websites Speaker is permitted to open via the in-frame browser. */
  permittedWebsites?: PermittedWebsite[];
}

function buildSpeakTool(): FunctionDeclaration {
  return {
    name: "speak",
    description: `Say something to the user. One call per turn. The text is voiced by a separate TTS.`,
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to speak aloud." },
      },
      required: ["text"],
    },
  };
}

function buildEmoteTool(): FunctionDeclaration {
  return {
    name: "emote",
    description: `Set avatar emotion. Only call when the emotional tone changes.

  - happy — encouraging
  - sad — empathizing
  - neutral — calm/serious`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        emotion: {
          type: "string",
          enum: ["happy", "sad", "neutral"],
          description: "The emotion to display.",
        },
      },
      required: ["emotion"],
    },
  };
}

function buildCallPersonTool(): FunctionDeclaration {
  return {
    name: "call_person",
    description: `Place a live video call to one of the people listed in [CALLABLE CONTACTS]. Only call a person shown there as online, and only when the student clearly wants to talk to them. Pass the exact contactId from that list.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        contactId: {
          type: "string",
          description: "The contactId of the person to call, taken from the [CALLABLE CONTACTS] list.",
        },
      },
      required: ["contactId"],
    },
  };
}

// set_interaction_mode moved to Observer (it has the camera/mic context
// to judge companion vs. facilitator). Speaker learns the current mode
// from [MODE] context injections forwarded by the Coordinator.

/**
 * Set the target party for your next utterance. When omitted, the
 * target defaults to USER. Set to a person's name (e.g. "Mom",
 * "Teacher") when you intend to speak TO that person rather than the
 * user. The target is consumed by the NEXT speak()/audio turn and
 * resets afterwards.
 */
const SET_SPEECH_TARGET: FunctionDeclaration = {
  name: "set_speech_target",
  description: `Set who your NEXT utterance is addressed to. Default is USER. One-shot — resets to USER after the next speech turn.`,
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: `"USER" (default), or a specific person's name.`,
      },
    },
    required: ["target"],
  },
};
// Reference SET_SPEECH_TARGET so unused-export lint doesn't complain — the
// declaration is intentionally retained (mirrors original) but not registered.
void SET_SPEECH_TARGET;

function buildOpenAppTool(
  enabledApps: AACAppDefinition[],
  customApps: NonNullable<SpeakerToolConfig["availableCustomApps"]> = [],
): FunctionDeclaration {
  // Ids are listed WITH their display names. They used to be a bare
  // comma-separated id list, which left the model to pair "Ocean Adventure"
  // with `cust_a7f3` by guesswork — the id is the only thing the call can
  // carry, and the name is the only thing the user ever says.
  const named = (a: { id: string; name: string }) => `"${a.id}" (${a.name})`;
  const builtInIds = enabledApps.map(named).join(", ");
  const customIds = customApps.map(named).join(", ");
  const sections = [builtInIds ? `Apps: ${builtInIds}.` : ""];
  if (customIds) sections.push(`Games: ${customIds}.`);
  // Self-contained on purpose: in live native-audio mode this is the ONLY
  // tool, and it must carry its own guard rails — a tool description is read
  // at the moment of the call, which is exactly when a prompt block far above
  // is least likely to be weighed.
  return {
    name: "open_app",
    description: `Open an app or game on the user's screen NOW. Call it ONLY when the user asked for that app, or agreed to one you just offered, in this turn — then keep talking normally. ${sections.filter(Boolean).join(" ")} Pass an id from that list EXACTLY as written. If none of them does what the user asked, do not call this at all: say you cannot, rather than opening the nearest-sounding one.`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        app_id: {
          type: "string",
          description: "The app ID to open (built-in app id or custom game id).",
        },
        data: {
          type: "string",
          description: `The thing the user named, in their words — ${enabledApps.filter(a => a.queryHint).map(a => `${a.id}: ${a.queryHint}`).join("; ") || "search query for media apps"}. These apps open EMPTY without it.`,
        },
      },
      required: ["app_id"],
    },
  };
}

const CLOSE_APP: FunctionDeclaration = {
  name: "close_app",
  description: "Close the currently open app.",
  behavior: Behavior.NON_BLOCKING,
  parametersJsonSchema: { type: "object", properties: {} },
};

function buildOpenWebsiteTool(permitted: PermittedWebsite[]): FunctionDeclaration {
  const flat = flattenPermittedWebsites(permitted);
  const list = flat
    .map(w => `  - "${w.label}" (${w.url})${w.description ? ` — ${w.description}` : ""}`)
    .join("\n");
  return {
    name: "open_website",
    description: `Open a permitted site in the in-frame browser. Only URLs in the list below (and their subpages) are permitted; others are rejected.

Permitted sites:
${list}`,
    behavior: Behavior.NON_BLOCKING,
    parametersJsonSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to open. Must match a permitted site prefix.",
        },
        label: {
          type: "string",
          description: "Short display label (e.g. 'Wikipedia: Cats'). Optional.",
        },
      },
      required: ["url"],
    },
  };
}

export function buildSpeakerToolDeclarations(config: SpeakerToolConfig): Tool[] {
  // Gemini Live native-audio diagnostic: when the model is talking
  // directly via AUDIO modality, the tool surface is suppressed to dodge
  // MALFORMED_FUNCTION_CALL bursts. This shortcut applies ONLY to the
  // Live path — HTTP completion handles tools reliably and actively
  // needs them.
  //
  // EXCEPTION — open_app (2026-08-19, Daniel): the known failure mode of
  // live tools is calling the tool but dropping the spoken reply. For a
  // conversational tool that's fatal; for open_app it's tolerable — an
  // app that opens silently beats an app that is promised and never
  // opens, which is the failure every relay attempt (Board Manager
  // instructions, launch buttons) kept producing. ONE simple tool, not
  // the surface.
  if (!config.httpMode && config.useDirectAudio && !config.isMutedMode) {
    const hasApps = config.enabledApps.length > 0 || (config.availableCustomApps?.length ?? 0) > 0;
    if (!hasApps) return [];
    // close_app rides along (2026-08-20, Daniel). It takes NO arguments, so
    // there is nothing in it for the model to malform — the diagnostic above is
    // about argument bursts. The asymmetry it removes is worse than the risk:
    // the Speaker could take over the student's screen and then had no way to
    // give it back, and a student who cannot reach the app's own close target
    // was stuck with it until someone else noticed.
    return [{
      functionDeclarations: [
        buildOpenAppTool(config.enabledApps, config.availableCustomApps ?? []),
        CLOSE_APP,
      ],
    }];
  }

  const declarations: FunctionDeclaration[] = [];

  if (!config.isMutedMode && !config.useDirectAudio) {
    declarations.push(buildSpeakTool());
  }

  declarations.push(buildEmoteTool());
  declarations.push(buildCallPersonTool());

  // Apps + websites
  const hasBuiltInApps = config.enabledApps.length > 0;
  const hasCustomApps = (config.availableCustomApps?.length ?? 0) > 0;
  const hasPermittedWebsites = (config.permittedWebsites?.length ?? 0) > 0;
  if (hasBuiltInApps || hasCustomApps || hasPermittedWebsites) {
    if (hasBuiltInApps || hasCustomApps) {
      declarations.push(buildOpenAppTool(config.enabledApps, config.availableCustomApps ?? []));
    }
    if (hasPermittedWebsites) {
      declarations.push(buildOpenWebsiteTool(config.permittedWebsites!));
    }
    declarations.push(CLOSE_APP);
  }

  // private_thought prevents <thinking> leakage into voiced text.
  // remain_silent gives a terminal "no reply this turn" action so the
  // model doesn't substitute private_thought for silence.
  declarations.push(PRIVATE_THOUGHT);
  declarations.push(REMAIN_SILENT);
  declarations.push(CALL_MONITOR);
  if (debugIntrospectionEnabled()) declarations.push(DEBUG_MESSAGE);

  return [{ functionDeclarations: declarations }];
}
